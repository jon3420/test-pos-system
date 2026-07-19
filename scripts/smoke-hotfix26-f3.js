#!/usr/bin/env node
// scripts/smoke-hotfix26-f3.js — fix18-10-hotfix26-F3 smoke test
//
// 範圍：
//   Fix-1 外帶取餐地址 UI（public/line-order.html）
//   Fix-2 iPhone 外部瀏覽器登入 UX（public/js/line-member-gate.js）
//   Fix-3 外部瀏覽器導轉時，所有 Query String 100% 保留
//
// 做法：靜態原始碼比對 + 最小 window/document mock 直接 eval 原始碼（沿用既有
// scripts/smoke-hotfix26-i.js 手法），不需要真實瀏覽器或真實 Android/iOS 裝置。
//
// 不在此腳本自動化範圍內（標示 [MANUAL REQUIRED]）：
//   - 真實 iOS 裝置上 googlechromes:// 是否真的喚起 Chrome App
//   - 真實 Messenger/Instagram App 內建瀏覽器的實際限制與畫面
//   - 真實 Android 裝置上的 Messenger→Chrome→LINE Login 完整流程

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

// ════════════════════════════════════════════════════════════════
// 最小 window/document mock（沿用 smoke-hotfix26-i.js 手法）
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    attrs: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
    // fix18-10-hotfix29-C：openOaBtn 的 aria-disabled 切換需要這三個方法
    // （其他較新的 smoke test 已經有，這個較舊、獨立的 mock 補上同一套實作）。
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    removeAttribute(k) { delete el.attrs[k]; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(html) {
      el._html = html;
      el.children = {};
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) {
        const id = m[1];
        const child = makeFakeElement(idRegistry);
        el.children[id] = child;
        idRegistry[id] = child;
      }
    },
  });
  return el;
}

function loadGateModule(initialHref, ua) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  let currentUrl = new URL(initialHref);
  const idRegistry = {};
  const locationAssignments = [];

  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const docListeners = {};
  const doc = {
    createElement: () => makeFakeElement(idRegistry),
    body,
    head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    visibilityState: 'visible',
  };

  const win = {
    location: {
      get href() { return currentUrl.toString(); },
      set href(v) { locationAssignments.push(v); },
      get search() { return currentUrl.search; },
      get origin() { return currentUrl.origin; },
      get pathname() { return currentUrl.pathname; },
    },
    history: { replaceState(state, title, url) { currentUrl = new URL(url, currentUrl.origin); } },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: (k) => { sessionStore.delete(k); },
    },
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => { localStore.set(k, String(v)); },
      removeItem: (k) => { localStore.delete(k); },
    },
    document: doc,
    navigator: { userAgent: ua || '', vendor: '', clipboard: undefined },
    URL, URLSearchParams, console,
    liff: null,
    addEventListener() {},
  };
  win.window = win;

  const fetchProxy = async () => ({ json: async () => ({ success: false }) });

  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return { LineMemberGate, doc, win, locationAssignments, idRegistry };
}

const UA = {
  facebookIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0;FBBV/123456;FBDV/iPhone14,5;FBSV/17.4]',
  facebookAndroidOld: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]',
};

// ════════════════════════════════════════════════════════════════
// Section 1: Fix-2 — iOS 外部瀏覽器導引（DOM 實測，非只靜態比對）
// ════════════════════════════════════════════════════════════════
{
  const testUrl = 'https://example.com/line-order.html?store_id=store_001&mode=takeout&coupon=SAVE10&utm_source=fb&utm_medium=cpc&fbclid=abc123&gclid=xyz789&line_gate_return=checkout';
  const { LineMemberGate, doc, win, locationAssignments } = loadGateModule(testUrl, UA.facebookIOS);
  const environment = LineMemberGate.detectBrowserEnvironment();
  if (environment.isIOS && environment.isInAppBrowser) pass('iOS + Facebook WebView 偵測正確（isIOS=true, isInAppBrowser=true）');
  else fail('iOS + Facebook WebView 偵測失敗', JSON.stringify(environment));

  const guideEl = LineMemberGate.showExternalBrowserLoginGuide({ liff_id: '1234567890-abcdefgh' }, {
    storeId: 'store_001', gateStage: 'checkout', environment, onEvent: () => {},
  });

  const html = guideEl._html;
  // fix18-10-hotfix26-F8-B（需求文件三）：標題／主按鈕改為「LINE 完成結帳」／
  // 「到 LINE 完成結帳」，取代 hotfix26-F2/F3 原本的「請改用外部瀏覽器完成
  // LINE 登入」版型；Chrome／Safari 降為次要、收合在「其他登入方式」內。
  if (html.includes('LINE 完成結帳')) pass('iOS 標題／文案＝「LINE 完成結帳」（F8-B 改版）');
  else fail('iOS 標題文字不符');

  // fix18-10-hotfix27（需求文件九收尾）：文案再次調整——強調「購物車已保留，
  // 不需要重新選購」，取代 F8-B 版的「購物車內容會自動保留」。
  if (html.includes('目前使用 Facebook／Messenger 內建瀏覽器') && html.includes('請到 LINE 繼續完成結帳') && html.includes('您的購物車已保留，不需要重新選購')) {
    pass('iOS 說明文字包含內建瀏覽器提示／請到 LINE 繼續完成結帳／購物車已保留（hotfix27 改版）');
  } else fail('iOS 說明文字缺漏', html);

  if (html.includes('id="lmgGoLineCheckoutBtn"') && html.includes('到 LINE 完成結帳')) pass('iOS 版有「到 LINE 完成結帳」主按鈕（F8-B 新增）');
  else fail('iOS 版缺少「到 LINE 完成結帳」主按鈕');
  if (html.includes('id="lmgOtherLoginDetails"') && html.includes('其他登入方式')) pass('iOS 版有收合的「其他登入方式」區塊（F8-B 新增）');
  else fail('iOS 版缺少「其他登入方式」收合區塊');
  if (html.includes('id="lmgChromeBtn"') && html.includes('使用 Chrome 開啟')) pass('iOS 版「其他登入方式」內有「使用 Chrome 開啟」按鈕');
  else fail('iOS 版缺少「使用 Chrome 開啟」按鈕');
  if (html.includes('id="lmgSafariBtn"') && html.includes('如何使用 Safari 開啟')) pass('iOS 版「其他登入方式」內有「如何使用 Safari 開啟」按鈕');
  else fail('iOS 版缺少「如何使用 Safari 開啟」按鈕');
  if (html.includes('若 Chrome 仍無法完成登入，請使用 Safari')) pass('iOS 版包含「若 Chrome 仍無法完成登入，請使用 Safari」提示');
  else fail('iOS 版缺少 Chrome→Safari 銜接提示');
  // fix18-10-hotfix27-CD（需求文件十七）：「複製結帳連結」按鈕已移除，改為
  // 「複製結帳代碼」（在 Cart Code 區塊內，且永遠可用，不限 iOS）。
  if (html.includes('id="lmgCopyCartCodeBtn"') && html.includes('複製結帳代碼') && !html.includes('複製結帳連結')) {
    pass('iOS 版「複製結帳代碼」按鈕存在，舊版「複製結帳連結」已移除（hotfix27-CD）');
  } else fail('iOS 版「複製結帳代碼」按鈕缺漏或仍殘留舊版「複製結帳連結」');
  if (html.includes('id="lmgGoLineCheckoutBtn"') && /<a\s[^>]*id="lmgGoLineCheckoutBtn"/.test(html)) {
    pass('主按鈕是真正的 <a href>（hotfix27-CD 需求文件十二：保留使用者手勢）');
  } else fail('主按鈕不是 <a> 元素');
  if (html.includes('id="lmgExternalBackBtn"') && html.includes('返回購物車')) pass('iOS 版保留「返回購物車」按鈕');
  else fail('iOS 版缺少「返回購物車」按鈕');
  if (!html.includes('id="lmgOpenLineBtn"')) pass('iOS 版不再顯示「嘗試使用 LINE 開啟」主按鈕（避免宣稱官方限制下仍會成功）');
  else fail('iOS 版仍殘留舊版 LINE 開啟按鈕');

  const forbidden = ['一定成功', 'Chrome 一定成功', 'Safari 一定成功', 'LINE 一定跳轉', '一定可以'];
  const hit = forbidden.find((w) => html.includes(w));
  if (!hit) pass('iOS 版文案不含任何「一定成功／一定可以」類過度保證字樣');
  else fail('iOS 版文案含過度保證字樣', hit);

  // 點擊「使用 Chrome 開啟」→ 應該用 googlechromes:// 且保留完整 query string
  const chromeBtn = doc.getElementById('lmgChromeBtn');
  chromeBtn.dispatchClick();
  const chromeNav = locationAssignments.find((u) => u.startsWith('googlechromes://') || u.startsWith('googlechrome://'));
  if (chromeNav) {
    pass('「使用 Chrome 開啟」使用官方 googlechromes:// scheme（非自創怪異 scheme）');
    const allParamsPresent = ['store_id=store_001', 'mode=takeout', 'coupon=SAVE10', 'utm_source=fb', 'utm_medium=cpc', 'fbclid=abc123', 'gclid=xyz789']
      .every((p) => chromeNav.includes(p));
    if (allParamsPresent) pass('Fix-3：使用 Chrome 開啟時，store_id/mode/coupon/utm/fbclid/gclid 全部保留在導轉網址中');
    else fail('Fix-3：使用 Chrome 開啟時遺失部分 Query String', chromeNav);
  } else {
    fail('「使用 Chrome 開啟」未觸發預期的 googlechromes:// 導轉', JSON.stringify(locationAssignments));
  }

  // 點擊「如何使用 Safari 開啟」→ 應顯示教學文字，不應該有任何 location 導轉
  const beforeSafariNavCount = locationAssignments.length;
  const safariBtn = doc.getElementById('lmgSafariBtn');
  safariBtn.dispatchClick();
  const statusEl = doc.getElementById('lmgExternalStatus');
  if (statusEl && statusEl._html.includes('在 Safari 中開啟')) pass('「如何使用 Safari 開啟」顯示正確教學文字');
  else fail('「如何使用 Safari 開啟」文字不符', statusEl && statusEl._html);
  if (locationAssignments.length === beforeSafariNavCount) pass('「如何使用 Safari 開啟」純顯示教學，未觸發任何額外導轉');
  else fail('「如何使用 Safari 開啟」不應觸發導轉');
}

// fix18-10-hotfix26-F8-B（需求文件三／四）：Android／其他瀏覽器分支改用與 iOS
// 相同的「到 LINE 完成結帳」主按鈕版型，「嘗試使用 LINE 開啟」／「使用 Chrome
// 開啟」等原本的 hotfix26-F2 四顆按鈕不再是主畫面，而是收合進「其他登入方式」。
{
  const testUrl = 'https://example.com/line-order.html?store_id=store_001&mode=takeout&fbclid=abc123';
  const { LineMemberGate, doc } = loadGateModule(testUrl, UA.facebookAndroidOld);
  const environment = LineMemberGate.detectBrowserEnvironment();
  const guideEl = LineMemberGate.showExternalBrowserLoginGuide({ liff_id: '1234567890-abcdefgh' }, {
    storeId: 'store_001', gateStage: 'checkout', environment, onEvent: () => {},
  });
  const html = guideEl._html;
  if (html.includes('LINE 完成結帳') && html.includes('id="lmgGoLineCheckoutBtn"') && html.includes('到 LINE 完成結帳')
    && html.includes('id="lmgOtherLoginDetails"')
    && html.includes('id="lmgOpenLineBtn"') && html.includes('嘗試使用 LINE 開啟')
    && html.includes('id="lmgOsHintBtn"') && html.includes('使用 Chrome 開啟')
    && html.includes('id="lmgCopyCartCodeBtn"') && html.includes('id="lmgExternalBackBtn"')
    && !html.includes('id="lmgChromeBtn"') && !html.includes('id="lmgSafariBtn"')) {
    pass('Android 版採用統一版型：主按鈕「到 LINE 完成結帳」（<a>）＋「複製結帳代碼」＋收合的「嘗試使用 LINE 開啟／使用 Chrome 開啟」，未誤用 iOS 專屬的 lmgChromeBtn/lmgSafariBtn（hotfix27-CD）');
  } else {
    fail('Android 版型與預期不符', html);
  }
}
manual('真實 Android 裝置 Messenger→Chrome→LINE Login 完整流程', '需要真實 Android 裝置與 Messenger/LINE App 才能驗證');
manual('真實 iOS 裝置上 googlechromes:// 是否真的喚起 Chrome App', 'iOS 瀏覽器本身無法從 JS 偵測 URL scheme 是否成功喚起外部 App，只能靠真機肉眼確認');

// ════════════════════════════════════════════════════════════════
// Section 2: Fix-1 — 取餐地址（line-order.html 純函式）
// ════════════════════════════════════════════════════════════════
const lineOrderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
function extractFn(src, name) {
  const i0 = src.indexOf(`function ${name}(`);
  if (i0 === -1) return null;
  let depth = 0, i = src.indexOf('{', i0), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(i0, end);
}
const pickupFnNames = ['resolvePickupAddressText', 'buildPickupMapsUrl', 'updatePickupAddressVisibility'];
const missingPickupFns = pickupFnNames.filter((n) => !lineOrderSrc.includes(`function ${n}(`));
if (!missingPickupFns.length) pass('resolvePickupAddressText/buildPickupMapsUrl/updatePickupAddressVisibility 皆存在');
else fail('缺少取餐地址相關函式', missingPickupFns.join(','));

if (lineOrderSrc.includes('id="pickupAddrWrap"') && lineOrderSrc.includes('id="pickupAddrText"')
  && lineOrderSrc.includes('id="pickupMapsBtn"') && lineOrderSrc.includes('id="pickupCopyBtn"')) {
  pass('取餐地址區塊 HTML（pickupAddrWrap/pickupAddrText/pickupMapsBtn/pickupCopyBtn）皆存在');
} else fail('取餐地址區塊 HTML 缺漏');

if (!/store_001/.test(extractFn(lineOrderSrc, 'resolvePickupAddressText') || '')) pass('resolvePickupAddressText() 未寫死 store_001');
else fail('resolvePickupAddressText() 疑似寫死 store_001');

function runPickup(shopDataOverride) {
  const fnSrc = pickupFnNames.map((n) => extractFn(lineOrderSrc, n)).join('\n');
  const mockDoc = {
    getElementById(id) {
      const registry = runPickup._registry;
      if (!registry[id]) {
        const classes = new Set();
        registry[id] = {
          textContent: '', disabled: false, style: {},
          classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        };
      }
      return registry[id];
    },
  };
  runPickup._registry = {};
  const sandboxSrc = `
    (function(document, shopData, currentMode, toast){
      ${fnSrc}
      updatePickupAddressVisibility();
      return {
        text: document.getElementById('pickupAddrText').textContent,
        wrapDisplay: document.getElementById('pickupAddrWrap').style.display,
        mapsUrl: buildPickupMapsUrl(),
        resolved: resolvePickupAddressText(),
        mapsBtnDisabled: document.getElementById('pickupMapsBtn').disabled,
        copyBtnDisabled: document.getElementById('pickupCopyBtn').disabled,
      };
    })
  `;
  const factory = eval(sandboxSrc); // eslint-disable-line no-eval
  return factory(mockDoc, shopDataOverride.shopData, shopDataOverride.currentMode, () => {});
}

// 案例：外帶 + store_address 有值 + 有座標
{
  const r = runPickup({ shopData: { store_address: '桃園市中壢區龍東路130號1樓', store_lat: '24.9998', store_lng: '121.2168' }, currentMode: 'takeout' });
  if (r.wrapDisplay === '') pass('外帶模式：取餐地址區塊顯示（style.display 未被設為 none）');
  else fail('外帶模式：取餐地址區塊應顯示');
  if (r.text === '桃園市中壢區龍東路130號1樓') pass('外帶模式：地址文字正確顯示 store_address');
  else fail('外帶模式：地址文字不符', r.text);
  if (r.mapsUrl === 'https://www.google.com/maps?q=24.9998,121.2168') pass('有座標時，Google Maps URL 使用 q=lat,lng 格式');
  else fail('Google Maps URL（座標版）不符', r.mapsUrl);
}

// 案例：外送模式 → 應隱藏
{
  const r = runPickup({ shopData: { store_address: '某地址' }, currentMode: 'delivery' });
  if (r.wrapDisplay === 'none') pass('外送模式：取餐地址區塊隱藏（style.display=none）');
  else fail('外送模式：取餐地址區塊應隱藏', r.wrapDisplay);
}

// 案例：無座標 → fallback 用地址搜尋 URL
{
  const r = runPickup({ shopData: { store_address: '台北市中正區忠孝東路一段1號' }, currentMode: 'takeout' });
  const expected = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('台北市中正區忠孝東路一段1號');
  if (r.mapsUrl === expected) pass('無座標時，Google Maps URL fallback 使用地址搜尋格式');
  else fail('Google Maps URL（地址搜尋版）不符', r.mapsUrl);
}

// 案例：store_address 未設定 → fallback pickup_address
{
  const r = runPickup({ shopData: { store_address: '', pickup_address: '備用取餐地址：後門進' }, currentMode: 'takeout' });
  if (r.resolved === '備用取餐地址：後門進') pass('store_address 未設定時，正確 fallback 使用 pickup_address');
  else fail('pickup_address fallback 失敗', r.resolved);
}

// 案例：兩者皆無 → 顯示提示文字，不留空白
{
  const r = runPickup({ shopData: {}, currentMode: 'takeout' });
  if (r.text === '請洽店家確認取餐地點') pass('無任何地址設定時，顯示「請洽店家確認取餐地點」（不留空白）');
  else fail('無地址 fallback 文字不符', r.text);
  if (r.mapsBtnDisabled === true && r.copyBtnDisabled === true) pass('無地址時，Google Maps／複製地址按鈕正確停用');
  else fail('無地址時按鈕停用狀態不符', JSON.stringify(r));
}

manual('取餐地址區塊在真實瀏覽器的視覺呈現與複製 Toast 顯示效果', '需要真實瀏覽器渲染環境驗證');

// ════════════════════════════════════════════════════════════════
// Section 3: 呼叫點檢查 — updatePickupAddressVisibility() 與
// updateDeliveryAddressVisibility() 掛在同一批呼叫點
// ════════════════════════════════════════════════════════════════
const deliveryCallCount = (lineOrderSrc.match(/updateDeliveryAddressVisibility\(\);/g) || []).length;
const pickupCallCount = (lineOrderSrc.match(/updatePickupAddressVisibility\(\);/g) || []).length;
if (deliveryCallCount > 0 && deliveryCallCount === pickupCallCount) {
  pass(`updatePickupAddressVisibility() 與 updateDeliveryAddressVisibility() 呼叫點數量一致（各 ${deliveryCallCount} 處）`);
} else {
  fail('updatePickupAddressVisibility() 呼叫點數量與 updateDeliveryAddressVisibility() 不一致', `delivery=${deliveryCallCount}, pickup=${pickupCallCount}`);
}

// ════════════════════════════════════════════════════════════════
// Section 4: 後端設定白名單／GET /shop 新增欄位（additive 檢查）
// ════════════════════════════════════════════════════════════════
const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
if (/'pickup_address'/.test(settingsSrc)) pass('routes/settings.js 已將 pickup_address 加入允許修改的設定白名單');
else fail('routes/settings.js 缺少 pickup_address 白名單');

const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
if (/'store_address', 'store_lat', 'store_lng', 'pickup_address'/.test(lineOrdersSrc)) {
  pass('GET /shop 回應已新增 store_address/store_lat/store_lng/pickup_address 欄位');
} else {
  fail('GET /shop 回應缺少取餐地址相關欄位');
}

// ════════════════════════════════════════════════════════════════
// Section 5: Regression 靜態確認 — 不影響既有子系統（byte-diff 由外部腳本負責，
// 這裡只確認本次修改的兩個檔案未動到既有無關函式簽章）
// ════════════════════════════════════════════════════════════════
const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
if (gateSrc.includes('function openInAndroidChrome(url)') && gateSrc.includes("scheme=https;package=com.android.chrome")) {
  pass('openInAndroidChrome()（Android 既有流程）維持不變');
} else fail('openInAndroidChrome() 疑似被改動');
if (gateSrc.includes('function buildLiffOpenUrl(storeId, config, opts)')) pass('buildLiffOpenUrl()（LIFF 登入核心）簽章維持不變');
else fail('buildLiffOpenUrl() 簽章被改動');
if (!/line:\/\//.test(gateSrc)) pass('未新增 line:// 或任何非官方 Deep Link scheme');
else fail('發現非官方 line:// scheme');

// ════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════
const failCount = results.filter((r) => r.status === 'FAIL').length;
console.log('\n=== SUMMARY ===');
results.forEach((r) => console.log(`${r.status}: ${r.name}`));
console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}, MANUAL: ${results.filter((r) => r.status === 'MANUAL REQUIRED').length}`);
process.exit(failCount > 0 ? 1 : 0);
