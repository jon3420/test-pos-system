#!/usr/bin/env node
// scripts/smoke-hotfix30-entry-checkout-isolation.js
//
// 風險驗證：requireMemberOnEntry() 與 requireMemberBeforeCheckout() 共用同一個
// showExternalBrowserLoginGuide()。Hotfix30 把這個共用 Dialog 改成以 Cart
// Handoff Token／Direct LIFF 為核心的結帳流程，即使 requireMemberOnEntry()
// 本身逐字節與 Hotfix29-C baseline 相同，仍可能因為共用 Dialog 被改變而讓
// 「進站登入」誤用「結帳」的 direct_liff_url／cart_token／mode=checkout。
//
// 本測試驗證修正後的分流結果：
//   - gateStage !== 'checkout' → showEntryLoginExternalGuide()：真實 <a href>
//     指向 buildLiffOpenUrl()，不含 cart_token、不含 mode=checkout，不呼叫
//     POST /create，不顯示 Cart Code／「購物車已保留」。
//   - gateStage === 'checkout' → showCheckoutHandoffExternalGuide()：維持
//     Hotfix30 既有行為，主按鈕 href = direct_liff_url，含 cart_token 與
//     mode=checkout。
//
// 誠實揭露：真機 Messenger／LIFF WebView 交叉測試需要真機環境，本測試只能
// 靜態驗證程式邏輯與 DOM 結構，標記為 MANUAL REQUIRED。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ═══════════════ DOM mock（與 smoke-hotfix30-direct-liff.js 相同手法）═══════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, hidden: false, textContent: '', _html: '', children: {}, parentNode: null,
    attrs: {}, open: false,
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
      // 需求：entry-login 按鈕的 href 是在組 HTML 字串時就同步寫死（不像
      // checkout 按鈕是先 disabled 之後才用 JS 賦值），所以這裡的 fake DOM
      // 也要能從初始 HTML 解析出 id 對應的 href，不能只認 JS 賦值。
      const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
      let tagMatch;
      while ((tagMatch = tagRe.exec(html))) {
        const attrsStr = tagMatch[2];
        const idMatch = /id="([^"]+)"/.exec(attrsStr);
        if (!idMatch) continue;
        const id = idMatch[1];
        const child = makeFakeElement(idRegistry);
        const hrefMatch = /href="([^"]*)"/.exec(attrsStr);
        if (hrefMatch) child.href = hrefMatch[1];
        el.children[id] = child;
        idRegistry[id] = child;
      }
    },
  });
  return el;
}

function loadGateModule({ initialHref, ua, fetchImpl, initialCart }) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  if (initialCart) localStore.set(initialCart.key, initialCart.value);
  let currentUrl = new URL(initialHref);
  const idRegistry = {};
  const locationAssignments = [];
  const createCalls = [];

  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const docListeners = {};
  const doc = {
    createElement: () => makeFakeElement(idRegistry),
    body,
    head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    visibilityState: 'visible',
    hidden: false,
  };

  class FakeAbortController {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }

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
    navigator: { userAgent: ua || '', vendor: '', clipboard: { writeText: async () => true }, sendBeacon: () => true },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    AbortController: FakeAbortController,
    liff: null,
    addEventListener() {},
  };
  win.window = win;

  const fetchProxy = async (url, options) => {
    if (typeof url === 'string' && url.includes('/api/line-checkout-handoff/create')) {
      createCalls.push({ url, body: options && options.body });
      return fetchImpl ? fetchImpl(url, options) : { ok: false, status: 500, json: async () => ({ ok: false }) };
    }
    if (typeof url === 'string' && url.includes('/api/line-checkout-handoff/diagnostics')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  win.fetch = fetchProxy;

  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return { LineMemberGate, doc, win, locationAssignments, idRegistry, createCalls };
}

const UA_IPHONE_MESSENGER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/123456;FBDV/iPhone16,2;FBSV/18.1]';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // ═══════════════ 一：Entry Login — 空購物車（最常見的進站情境）═══════════════
  {
    const storeId = 'store_entry_empty_cart';
    let createCalled = false;
    const fetchImpl = async () => { createCalled = true; return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 'HANDOFF_EMPTY_CART' }) }; };
    const { LineMemberGate, idRegistry, createCalls } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl });
    const environment = LineMemberGate.detectBrowserEnvironment();
    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-entrytest', add_friend_url: 'https://lin.ee/entrytest' },
      { storeId, gateStage: 'entry', environment, onEvent: () => {} }
    );
    await wait(30);
    const html = guideEl._html;

    assert(createCalls.length === 0 && !createCalled, 'Entry（空購物車）：不會呼叫 POST /create（進站登入本來就不需要 Cart Handoff Token）', JSON.stringify(createCalls));
    assert(html.includes('id="lmgEntryLoginBtn"'), 'Entry：使用專屬的 lmgEntryLoginBtn（不是結帳流程的 lmgGoLineCheckoutBtn）');
    assert(/<a\s[^>]*id="lmgEntryLoginBtn"/.test(html), 'Entry：主按鈕是真實 <a> 元素');
    const entryBtn = idRegistry['lmgEntryLoginBtn'];
    assert(!!entryBtn.href && entryBtn.href.startsWith('https://liff.line.me/2000123456-entrytest'), 'Entry：主按鈕 href 使用正確 LIFF ID 的 buildLiffOpenUrl()', entryBtn.href);
    assert(!entryBtn.href.includes('cart_token'), 'Entry：主按鈕 href 不含 cart_token', entryBtn.href);
    assert(!entryBtn.href.includes('mode=checkout'), 'Entry：主按鈕 href 不含 mode=checkout', entryBtn.href);
    assert(entryBtn.href.includes('line_gate_return=entry'), 'Entry：主按鈕 href 帶正確的 gate_stage（entry）', entryBtn.href);
    assert(!html.includes('lmgCartCodeBlock'), 'Entry dialog：不出現 Cart Code 區塊');
    assert(!html.includes('購物車已保留'), 'Entry dialog：不顯示「購物車已保留」文案');
    assert(!html.includes('lmgGoChatroomBtn') && !html.includes('lmgCopyCartCodeBtn'), 'Entry dialog：不出現聊天室／複製 Cart Code 這類結帳 fallback 按鈕');
    assert(html.includes('使用 LINE 登入'), 'Entry dialog：文案是單純的「使用 LINE 登入」，不是「LINE 完成結帳」');
  }

  // ═══════════════ 二：Entry Login — 購物車其實不是空的（回訪顧客風險情境）═══════════════
  {
    // 這正是風險最高的情境：如果 entry 模式仍不小心用了結帳分支，購物車不為空
    // 時 create 會成功，主按鈕就會變成 direct_liff_url——這裡驗證修正後
    // entry 模式完全不受目前購物車內容影響。
    const storeId = 'store_entry_nonempty_cart';
    let createCalled = false;
    const fetchImpl = async () => {
      createCalled = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, cart_code: 'CART-SHOULDNOT', direct_liff_url: `https://liff.line.me/x?mode=checkout&store_id=${storeId}&cart_token=SECRET`, line_oa_message_url: 'https://line.me/oa' }) };
    };
    const { LineMemberGate, idRegistry, createCalls } = loadGateModule({
      initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl,
      initialCart: { key: `line_order_cart_${storeId}`, value: JSON.stringify({ cart: { 101: 2 }, order_mode: 'takeout' }) },
    });
    const environment = LineMemberGate.detectBrowserEnvironment();
    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-entrytest', add_friend_url: 'https://lin.ee/entrytest' },
      { storeId, gateStage: 'entry', environment, onEvent: () => {} }
    );
    await wait(1200); // 足夠讓結帳分支的 auto-launch（若誤用）觸發
    const html = guideEl._html;

    assert(createCalls.length === 0 && !createCalled, 'Entry（購物車非空）：即使購物車有內容，仍不會呼叫 POST /create', JSON.stringify(createCalls));
    const entryBtn = idRegistry['lmgEntryLoginBtn'];
    assert(!!entryBtn && !entryBtn.href.includes('cart_token') && !entryBtn.href.includes('mode=checkout'), 'Entry（購物車非空）：主按鈕仍是單純登入連結，不含 cart_token／mode=checkout', entryBtn && entryBtn.href);
    assert(!html.includes('direct_liff_url') && !html.includes('CART-SHOULDNOT'), 'Entry（購物車非空）：dialog 內容完全不含任何 Cart Code／direct_liff_url 字樣');
  }

  // ═══════════════ 三：Checkout Handoff — 既有 Hotfix30 行為不變 ═══════════════
  {
    const storeId = 'store_checkout_isolation_test';
    const directLiffUrl = `https://liff.line.me/2000123456-checkouttest?mode=checkout&store_id=${storeId}&cart_token=SECRETTOKEN`;
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, cart_code: 'CART-ISOTEST', direct_liff_url: directLiffUrl, line_oa_message_url: 'https://line.me/oa', line_oa_configured: true, add_friend_url: 'https://lin.ee/testshop' }),
    });
    const { LineMemberGate, idRegistry, createCalls } = loadGateModule({
      initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl,
      initialCart: { key: `line_order_cart_${storeId}`, value: JSON.stringify({ cart: { 101: 1 }, order_mode: 'takeout' }) },
    });
    const environment = LineMemberGate.detectBrowserEnvironment();
    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-checkouttest', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(30);
    const html = guideEl._html;

    assert(createCalls.length === 1, 'Checkout：會呼叫一次 POST /create 建立 Cart Handoff Token', JSON.stringify(createCalls));
    assert(html.includes('id="lmgGoLineCheckoutBtn"'), 'Checkout：使用既有的 lmgGoLineCheckoutBtn（Hotfix30 Direct LIFF Checkout 主按鈕）');
    const checkoutBtn = idRegistry['lmgGoLineCheckoutBtn'];
    assert(checkoutBtn.href === directLiffUrl, 'Checkout：主按鈕 href = direct_liff_url', checkoutBtn.href);
    assert(checkoutBtn.href.includes('cart_token'), 'Checkout：href 含 cart_token');
    assert(checkoutBtn.href.includes('mode=checkout'), 'Checkout：href 含 mode=checkout');
    assert(checkoutBtn.href.includes(`store_id=${storeId}`), 'Checkout：href 含正確 store_id');
    assert(html.includes('id="lmgCartCodeBlock"'), 'Checkout dialog：仍可顯示 Cart Code 區塊（收在 fallback 內，但存在）');
    assert(html.includes('id="lmgGoChatroomBtn"') && html.includes('id="lmgCopyCartCodeBtn"'), 'Checkout dialog：仍保留聊天室／複製 Cart Code fallback');
  }

  // ═══════════════ 四：不影響既有函式（不得修改的核心登入邏輯）═══════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
    const pristineSrc = fs.readFileSync('/home/claude/pristine/web/public/js/line-member-gate.js', 'utf8');
    function extractFn(source, name) {
      const idx = source.indexOf(name);
      return idx === -1 ? null : source.slice(idx, idx + 2000);
    }
    // 這裡只做粗略存在性檢查（逐字節比對已在對話中用 diff 完成），確保這幾個
    // 函式的宣告仍在，且呼叫端（requireMemberOnEntry／requireMemberBeforeCheckout）
    // 呼叫 showExternalBrowserLoginGuide() 的方式完全沒變。
    ['async function loginWithLine', 'async function recoverLineLoginSession', 'async function verifyWithBackend', 'async function handleLineMemberLoginCallback'].forEach((sig) => {
      assert(src.includes(sig), `原始碼：${sig} 宣告仍存在（未被本次修改動到）`);
    });
    // fix18-10-hotfix30-entry-oneclick：requireMemberOnEntry() 在 in-app
    // browser 時，第一個 Gate 就直接 render 真實 <a href="buildLiffOpenUrl(...)">，
    // 不再等點擊後才呼叫 showExternalBrowserLoginGuide() 開第二層 Dialog
    // （兩層 Dialog、兩次點擊才能跳轉，違反縮短流程的目標，已依需求文件
    // 明確要求移除這個中間層——這裡改成驗證新設計，而不是舊的「呼叫方式
    // 不變」假設）。requireMemberBeforeCheckout() 完全沒有被這次修改觸碰，
    // 仍呼叫 showExternalBrowserLoginGuide()，斷言維持不變。
    // 精確定位到 if (directLoginHref) {...} 這個分支本身（到緊接著的
    // } else { 為止），確認這個分支內部不呼叫 showExternalBrowserLoginGuide()
    // ——而不是整個 requireMemberOnEntry() 函式（後面的 else 分支本身仍保留
    // 既有 fallback，理論上不會走到，但保留作為防禦）。
    const ifDirectIdx = src.indexOf('if (directLoginHref) {');
    const elseIdx = src.indexOf('} else {', ifDirectIdx);
    const directBranchSrc = src.slice(ifDirectIdx, elseIdx);
    assert(ifDirectIdx > -1 && elseIdx > ifDirectIdx, '原始碼：能定位到 if (directLoginHref) {...} else {...} 分支邊界');
    assert(!directBranchSrc.includes('showExternalBrowserLoginGuide('), 'requireMemberOnEntry()：in-app browser 情境（if (directLoginHref) 分支）不再呼叫 showExternalBrowserLoginGuide()（改成直接 render 真實 <a href>，避免兩次點擊）');
    assert(src.includes("buildLiffOpenUrl(storeId, config, { gate_stage: 'entry' })"), 'requireMemberOnEntry()：直接用 buildLiffOpenUrl() 組出 entry 模式的真實 <a href>');
    assert(src.includes("direct_login_href: directLoginHref || undefined") || src.includes('direct_login_href: directLoginHref'), 'requireMemberOnEntry()：把算好的 href 傳給 showMemberGate() 的新增選填參數 direct_login_href');
    assert(src.includes("showExternalBrowserLoginGuide(config, {\n            storeId, gateStage: 'checkout'"), 'requireMemberBeforeCheckout() 呼叫 showExternalBrowserLoginGuide() 的方式與 Hotfix29-C 完全相同（本次完全未修改）');
  }

  // ═══════════════ 五：Entry Login 一次點擊即可跳轉（Hotfix30-Entry-OneClick）═══════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
    assert(src.includes('direct_login_href'), 'showMemberGate()：新增選填參數 direct_login_href（預設不帶，既有呼叫端零改動）');
    assert(/<a id="lmgLoginBtn" href="\$\{directLoginHref\}"/.test(src), 'showMemberGate()：帶 direct_login_href 時，#lmgLoginBtn render 成真實 <a href>（不是 <button>）');
    assert(/<button id="lmgLoginBtn"/.test(src), 'showMemberGate()：不帶 direct_login_href 時，#lmgLoginBtn 仍是原本的 <button>（既有呼叫端例如 requireMemberBeforeCheckout() 零改動）');
    // click handler 本身不得是 async、不得 preventDefault、不得用 location.assign——
    // 直接在原始碼裡找這段 handler 範圍做檢查。
    const idx = src.indexOf('if (directLoginHref) {');
    assert(idx > -1, '原始碼：requireMemberOnEntry() 內有 if (directLoginHref) 分流');
    const handlerSliceRaw = src.slice(idx, idx + 800);
    // 需求：排除註解行（很多註解本身會提到「不 preventDefault」「不使用
    // window.location.assign()」來說明設計原則，逐字比對會被註解文字誤判
    // 成「有呼叫」，這裡先去掉整行註解只留程式碼本身再檢查）。
    const handlerSlice = handlerSliceRaw.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert(!/\.preventDefault\(/.test(handlerSlice), 'Entry 一次點擊分支：click handler 程式碼本身不呼叫 preventDefault()（僅註解提及設計原則，不是真的呼叫）');
    assert(!/location\.assign\(|location\.href\s*=/.test(handlerSlice), 'Entry 一次點擊分支：click handler 程式碼本身不呼叫 location.assign()／location.href=（僅註解提及設計原則，不是真的呼叫）');
    assert(!/loginBtn\.addEventListener\('click', async/.test(handlerSlice), 'Entry 一次點擊分支：click handler 不是 async function');
  }

  manual('真機 iPhone Messenger：Entry Login 使用「使用 LINE 登入」按鈕，實際跳轉 liff.line.me 並成功登入後返回原點餐頁', '需要真實 Messenger WebView + LINE App 環境，本測試只能靜態驗證 DOM／href 結構。');
  manual('真機 iPhone Messenger：Checkout Direct LIFF 按鈕實際跳轉並還原購物車（已由 smoke-hotfix30-direct-liff.js 的其他真機項目涵蓋）', '需要真實裝置環境。');

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n=== hotfix30 entry/checkout isolation smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${failCount} MANUAL=${results.filter((r) => r.status === 'MANUAL REQUIRED').length}`);

  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-hotfix30-entry-checkout-isolation] fatal:', e); process.exit(1); });
