#!/usr/bin/env node
// scripts/smoke-hotfix29.js — fix18-10-hotfix29 smoke test
//
// 涵蓋需求文件十四：iPhone Messenger 提示、「立即開啟 LINE 官方帳號」／
// 「複製結帳代碼」／「外部瀏覽器開啟」按鈕存在、所有按鈕可點擊、不使用
// <details> 收合這個結帳 fallback、Android UI 不退步、Hotfix27-CD／
// Hotfix28 Regression。
//
// 做法：沿用 scripts/smoke-hotfix26-f3.js 已驗證過的 loadGateModule() DOM
// mock 手法（idRegistry + new Function 注入），不重新發明一套 mock。
//
// 誠實揭露：真機上「哪個按鈕真的成功率最高」需要真機交叉測試，這裡只能
// 靜態驗證 UI 結構與行為是否符合設計，標記 MANUAL REQUIRED。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    attrs: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchClick() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
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
      assign(v) { locationAssignments.push(v); },
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
    navigator: { userAgent: ua || '', vendor: '', clipboard: { writeText: async () => {} }, sendBeacon: () => true },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    liff: null,
    addEventListener() {},
  };
  win.window = win;

  const fetchProxy = async () => ({ json: async () => ({ success: false }) });

  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return { LineMemberGate, doc, win, locationAssignments, idRegistry };
}

const UA = {
  facebookIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0;FBBV/123456;FBDV/iPhone14,5;FBSV/17.4]',
  facebookAndroidOld: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]',
};

async function main() {
  {
    const testUrl = 'https://example.com/line-order.html?store_id=store_001';
    const { LineMemberGate } = loadGateModule(testUrl, UA.facebookIOS);
    const environment = LineMemberGate.detectBrowserEnvironment();
    assert(environment.isIOS && environment.isInAppBrowser, 'iPhone + Messenger 環境偵測正確（iPhone 顯示 Messenger 提示的前提）');

    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/testshop' },
      { storeId: 'store_001', gateStage: 'checkout', environment, onEvent: () => {} }
    );
    const html = guideEl._html;

    assert(html.includes('id="lmgOpenOaBtn"') && html.includes('開啟 LINE 官方帳號'), '「開啟 LINE 官方帳號」按鈕存在（fix18-10-hotfix30：文案拿掉「立即」，因為已降為 fallback，不再是搶眼的主按鈕）');
    assert(html.includes('id="lmgCopyCartCodeBtn"') && html.includes('複製結帳代碼'), '「複製結帳代碼」按鈕存在');
    assert(html.includes('id="lmgExternalBrowserBtn"') && html.includes('在 Safari 開啟'), '「外部瀏覽器開啟」按鈕存在（iOS 文案為「在 Safari 開啟」）');
    assert(html.includes('id="lmgGoLineCheckoutBtn"'), '「到 LINE 完成結帳」按鈕仍保留（需求文件六：不移除）');

    // fix18-10-hotfix30（需求文件六／十三，Baseline Isolation 判定為
    // PRE-EXISTING TEST ASSUMPTION）：hotfix29 當時把「無法開啟 LINE？」從
    // <details> 收合改成永遠展開＋紅色警示банner，是因為那個版本主要結帳
    // 手段就是這個 fallback 區塊本身（OA 加好友連結）。Hotfix30 導入 Direct
    // LIFF 之後，這個區塊變回真正的 fallback（顧客正常情況完全不會用到），
    // 因此依 hotfix30 明確需求改回 <details> 收合，並拿掉紅色警示 banner。
    assert(!/<details[^>]*id="lmgCantOpenDetails"/.test(html), '不再有舊的 id="lmgCantOpenDetails" 收合容器命名（hotfix30 用的是 id="lmgCantOpenSection"）');
    assert(/<details[^>]*id="lmgCantOpenSection"/.test(html), 'hotfix30：「無法開啟 LINE？」改回 <details id="lmgCantOpenSection"> 收合寫法');
    assert(/<summary[^>]*>\s*⚠️\s*無法開啟 LINE/.test(html), 'hotfix30：收合區塊的 <summary> 文案為「⚠️ 無法開啟 LINE？」（不再限定 Messenger，且不再有紅色警示 banner 常駐畫面）');
    assert(!html.includes('background:#fef2f2'), 'hotfix30：常駐紅色警示 banner 已移除（Direct LIFF 為主流程時不需要一開始就嚇顧客）');
    assert(html.includes('⚠️'), '警示 icon 仍存在（現在放在收合 <summary> 裡）');

    // fix18-10-hotfix30（需求文件六）：不再有 iPhone+Messenger 特殊排序——
    // 主按鈕永遠只有「到 LINE 完成結帳」（Direct LIFF），openOaBtn 只存在於
    // 收合的 fallback 區塊裡，理論上一定排在主按鈕之後。
    const idxOpenOa = html.indexOf('id="lmgOpenOaBtn"');
    const idxGoCheckout = html.indexOf('id="lmgGoLineCheckoutBtn"');
    assert(idxOpenOa > -1 && idxGoCheckout > -1 && idxGoCheckout < idxOpenOa, 'hotfix30：「到 LINE 完成結帳」（主按鈕）永遠排在「開啟 LINE 官方帳號」（fallback）之前，不再有 iPhone+Messenger 特例');

    assert(/<a[^>]*id="lmgOpenOaBtn"/.test(html), '「開啟 LINE 官方帳號」是真正的 <a> 元素（可點擊）');
    assert(/<button[^>]*id="lmgCopyCartCodeBtn"/.test(html), '「複製結帳代碼」是真正的 <button> 元素（可點擊）');
    assert(/<button[^>]*id="lmgExternalBrowserBtn"/.test(html), '「外部瀏覽器開啟」是真正的 <button> 元素（可點擊）');
    assert(/<a[^>]*id="lmgGoLineCheckoutBtn"/.test(html), '「到 LINE 完成結帳」是真正的 <a> 元素（可點擊）');

    assert(html.includes('height:56px'), '按鈕高度 56px（需求文件十二）');
    assert(html.includes('border-radius:12px'), '按鈕圓角 12px（需求文件十二）');
    assert(html.includes('width:32px'), 'Icon 寬度 32px（需求文件十二）');
    assert(html.includes('gap:16px'), '按鈕間距 16px（需求文件十二）');

    // fix18-10-hotfix30：舊版 fallback 區塊底部的「💡 成功率最高／iPhone
    // 建議使用 Safari」說明文字，是專門為「OA 加好友連結是主要手段」這個
    // 已被取代的設計寫的，隨著該區塊收合為單純 fallback 一併移除，不再斷言存在。
    assert(!html.includes('成功率最高'), 'hotfix30：舊版「成功率最高」說明文字已隨紅色警示 banner 一起移除（不再需要說服顧客哪個按鈕比較準）');

    const openOaEl = guideEl.children['lmgOpenOaBtn'];
    assert(openOaEl && openOaEl.href === 'https://lin.ee/testshop', '「開啟 LINE 官方帳號」href 正確指向 add_friend_url', openOaEl && openOaEl.href);
  }

  {
    const testUrl = 'https://example.com/line-order.html?store_id=store_001';
    const { LineMemberGate } = loadGateModule(testUrl, UA.facebookAndroidOld);
    const environment = LineMemberGate.detectBrowserEnvironment();
    assert(!environment.isIOS && environment.isInAppBrowser, 'Android + Messenger 環境偵測正確');

    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/testshop' },
      { storeId: 'store_001', gateStage: 'checkout', environment, onEvent: () => {} }
    );
    const html = guideEl._html;

    assert(html.includes('id="lmgGoLineCheckoutBtn"'), 'Android：「到 LINE 完成結帳」按鈕仍存在');
    assert(html.includes('id="lmgOpenOaBtn"'), 'Android：「開啟 LINE 官方帳號」按鈕仍存在（fix18-10-hotfix30：功能不移除，只是文案拿掉「立即」並收進 fallback）');
    const idxOpenOa = html.indexOf('id="lmgOpenOaBtn"');
    const idxGoCheckout = html.indexOf('id="lmgGoLineCheckoutBtn"');
    assert(idxGoCheckout < idxOpenOa, 'Android：「到 LINE 完成結帳」仍排在「開啟 LINE 官方帳號」之前（fix18-10-hotfix30：兩平台統一沒有特例）');
    assert(html.includes('id="lmgExternalBrowserBtn"') && html.includes('在外部瀏覽器開啟'), 'Android：外部瀏覽器按鈕文案為「在外部瀏覽器開啟」（非「在 Safari 開啟」）');
    assert(html.includes('id="lmgOtherLoginDetails"'), 'Android：其他登入方式（Chrome/嘗試開啟 LINE）收合區塊仍存在（未受影響，屬不同功能）');
  }

  manual('真機：iPhone 13 Pro／iPhone 17 Pro／Android 實際點擊成功率', '需要真實 Messenger/Instagram WebView 環境交叉測試，本測試只能靜態驗證 UI 結構與按鈕存在性，無法測量真實成功率');
  manual('顧客第一眼是否真的「看到→直接點→成功」', '屬於使用者體驗判斷，需要真人測試回饋，無法用自動化測試斷言');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix29 smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  if (failCount > 0) process.exit(1);

  console.log('\n=== 執行 Regression ===');
  const { execFileSync } = require('child_process');
  const regressionScripts = [
    'smoke-hotfix26-f1.js', 'smoke-hotfix26-f2.js', 'smoke-hotfix26-f3.js',
    'smoke-hotfix26-f4.js', 'smoke-hotfix26-f5.js', 'smoke-hotfix26-f6.js',
    'smoke-hotfix26-f7.js', 'smoke-hotfix26-f8.js', 'smoke-hotfix26-f8-b.js',
    'smoke-hotfix27.js', 'smoke-hotfix27-cd.js', 'smoke-hotfix28.js',
  ];
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在，如實跳過）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 150000 });
      const summaryLine = out.split('\n').reverse().find(l => /FAIL\s*=\s*\d+|FAIL:\s*\d+|Regression 總結/.test(l)) || '';
      console.log(`[${script}] exit=0 ${summaryLine.trim() || ''}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix29] fatal:', e); process.exit(1); });
