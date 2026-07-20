#!/usr/bin/env node
// scripts/smoke-hotfix30-direct-liff.js — fix18-10-hotfix30 smoke test
//
// 涵蓋需求文件：
//   - buildDirectLiffCheckoutUrl()／create API 回傳 direct_liff_url（正確
//     LIFF ID／store_id／mode=checkout／cart_token；缺 LIFF ID 時的降級）
//   - restoreCartToken()：pending token 首次 Direct LIFF restore 自動綁定
//     line_user_id（且不繞過已綁定其他 user／已消耗／已過期／store 不符的
//     既有拒絕邏輯）
//   - Messenger Dialog：Direct LIFF 為單一主按鈕、真實 <a href>、ready 前
//     不可點、Cart Code 收在收合的 fallback、缺 Direct LIFF 時自動展開、
//     OA／聊天室／複製代碼／外部瀏覽器 fallback 仍存在
//   - Auto Launch：優先 Direct LIFF、create failed／Dialog 關閉／stale
//     requestId 都不啟動、手動點擊仍可用
//   - Restore UX：成功後清除 cart_token／mode、same-session 不顯示假性
//     失效、不覆蓋使用者後續修改的購物車、marker 不保存完整 token、真正
//     過期才顯示失效
//   - Friendship Sync：Direct LIFF 仍會觸發 friendship check，失敗不阻止
//     restore／checkout
//   - Diagnostics：本版新增的 stage／欄位白名單與型別驗證
//
// 誠實揭露：真機 Messenger／LIFF WebView 實際導流成功率、iPhone 13 Pro／
// 17 Pro 交叉測試需要真機環境，本測試只能靜態驗證程式邏輯與 DOM 結構，
// 標記為 MANUAL REQUIRED（見 README/完成報告）。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ═══════════════ DOM mock（沿用 smoke-hotfix29-c.js 已驗證過的手法）═══════════════
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

function loadGateModule({ initialHref, ua, fetchImpl, initialCart }) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  if (initialCart) localStore.set(initialCart.key, initialCart.value);
  let currentUrl = new URL(initialHref);
  const idRegistry = {};
  const locationAssignments = [];
  const diagnosticsCalls = [];
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
    if (typeof url === 'string' && url.includes('/api/line-checkout-handoff/diagnostics')) {
      diagnosticsCalls.push({ url, body: options && options.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (typeof url === 'string' && url.includes('/api/line-checkout-handoff/create')) {
      createCalls.push({ url, body: options && options.body });
      return fetchImpl(url, options);
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };

  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  win.fetch = fetchProxy; // module 內部呼叫 global.fetch()，global===window===win
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return { LineMemberGate, doc, win, locationAssignments, idRegistry, diagnosticsCalls, createCalls, sessionStore };
}

function cartFor(storeId, qtyMap) {
  return {
    key: `line_order_cart_${storeId}`,
    value: JSON.stringify({ cart: qtyMap || { 101: 1 }, order_mode: 'takeout', payment_method: 'cash' }),
  };
}

const UA_IPHONE_MESSENGER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/123456;FBDV/iPhone16,2;FBSV/18.1]';
const UA_ANDROID_MESSENGER = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function parsedDiagBodies(diagnosticsCalls) {
  return diagnosticsCalls.map((c) => { try { return JSON.parse(c.body); } catch (e) { return null; } }).filter(Boolean);
}

async function main() {
  // ═══════════════ 一：buildDirectLiffCheckoutUrl() 單元測試 ═══════════════
  {
    const { buildDirectLiffCheckoutUrl } = require('../utils/lineCheckoutHandoff');
    const url = buildDirectLiffCheckoutUrl({ liffId: '1234567890-abcdefgh', storeId: 'store_001', cartToken: 'SECRETTOKENVALUE' });
    assert(!!url, 'buildDirectLiffCheckoutUrl：三者齊全時回傳網址', url);
    assert(url && url.startsWith('https://liff.line.me/1234567890-abcdefgh'), 'buildDirectLiffCheckoutUrl：使用正確 LIFF ID', url);
    assert(url && url.includes('mode=checkout'), 'buildDirectLiffCheckoutUrl：包含 mode=checkout', url);
    assert(url && url.includes('store_id=store_001'), 'buildDirectLiffCheckoutUrl：包含正確 store_id', url);
    assert(url && url.includes('cart_token=SECRETTOKENVALUE'), 'buildDirectLiffCheckoutUrl：包含 cart_token', url);
    assert(buildDirectLiffCheckoutUrl({ liffId: '', storeId: 'store_001', cartToken: 'x' }) === null, 'buildDirectLiffCheckoutUrl：缺 liffId 回傳 null');
    assert(buildDirectLiffCheckoutUrl({ liffId: 'x', storeId: '', cartToken: 'x' }) === null, 'buildDirectLiffCheckoutUrl：缺 storeId 回傳 null');
    assert(buildDirectLiffCheckoutUrl({ liffId: 'x', storeId: 'store_001', cartToken: '' }) === null, 'buildDirectLiffCheckoutUrl：缺 cartToken 回傳 null');
  }

  // ═══════════════ 二：/create API — direct_liff_url（直接呼叫 route handler）═══════════════
  const dataDir = path.join(ROOT, 'data');
  const dbFile = path.join(dataDir, 'pos.db');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const STORE = 'smoke_30_store';
  const STORE_NO_LIFF = 'smoke_30_store_no_liff';
  db.run("INSERT INTO stores (store_id, store_name, plan, active) VALUES (?,?,?,1)", [STORE, 'Smoke Store 30', 'basic']);
  db.run("INSERT INTO stores (store_id, store_name, plan, active) VALUES (?,?,?,1)", [STORE_NO_LIFF, 'Smoke Store 30 No LIFF', 'basic']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE, 'line_official_basic_id', 'smoke30basic']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE, 'line_add_friend_url', 'https://lin.ee/smoke30']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE, 'line_member_liff_id', '2000123456-smoke30']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE_NO_LIFF, 'line_official_basic_id', 'smoke30nobasic']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE_NO_LIFF, 'line_add_friend_url', 'https://lin.ee/smoke30nb']);

  // RCA 修正（不依賴 SELECT id FROM products LIMIT 1）：recomputeCart() 依
  // WHERE id=? AND store_id=? 做多租戶隔離，是正確、既有的行為，不是 bug。
  // 舊寫法抓到的是全域第一筆商品（屬於 store_001），拿到別的測試 store 底下
  // 用，會被隔離規則正確擋掉，造成 items=[]／has_unavailable_items=true 這種
  // 「測試假象」。這裡改成幫每個測試 store 各自建立一個專屬商品，用完即丟
  // （測試結束時與整個 dbFile 一起刪除，不污染任何既有 fixture／正式資料）。
  function insertTestProduct(storeId, name) {
    db.run(
      "INSERT INTO products (store_id, name, category, price, enabled) VALUES (?,?,?,?,1)",
      [storeId, name, '主食', 88]
    );
    return db.get('SELECT id, store_id, enabled, price FROM products WHERE store_id=? ORDER BY id DESC LIMIT 1', [storeId]);
  }
  const product = insertTestProduct(STORE, 'RCA 測試商品');
  const productNoLiff = insertTestProduct(STORE_NO_LIFF, 'RCA 測試商品（無 LIFF 店）');
  assert(product && product.store_id === STORE && product.enabled === 1 && product.price > 0, '（測試前置）已為 smoke_30_store 建立專屬測試商品，enabled=1、price 為正數，不依賴全域第一筆商品', JSON.stringify(product));

  const createRouter = require('../routes/line-checkout-handoff');
  const createLayer = createRouter.stack.find((l) => l.route && l.route.path === '/create');
  const createHandler = createLayer.route.stack[0].handle;
  const restoreLayer = createRouter.stack.find((l) => l.route && l.route.path === '/restore');
  const restoreHandler = restoreLayer.route.stack[0].handle;

  function makeRes() {
    const res = { _status: 200, _json: null, status(c) { res._status = c; return res; }, json(o) { res._json = o; return res; } };
    return res;
  }

  let createdToken = null; // 從 DB 直接撈出完整 token，供 restore 測試使用（不透過任何 log／回應欄位取得）
  if (product) {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: product.id, qty: 1 }] } } }, res);
    assert(res._status === 200 && res._json.ok === true, 'create：合法商品＋已設定 LIFF ID → 200 + ok:true');
    assert(!!res._json.direct_liff_url, 'create success：回傳 direct_liff_url（不是 null）', res._json.direct_liff_url);
    assert(res._json.direct_liff_url && res._json.direct_liff_url.startsWith('https://liff.line.me/2000123456-smoke30'), 'create success：direct_liff_url 使用正確的 LIFF ID', res._json.direct_liff_url);
    assert(res._json.direct_liff_url && res._json.direct_liff_url.includes(`store_id=${STORE}`), 'create success：direct_liff_url 包含正確 store_id', res._json.direct_liff_url);
    assert(res._json.direct_liff_url && res._json.direct_liff_url.includes('mode=checkout'), 'create success：direct_liff_url 包含 mode=checkout', res._json.direct_liff_url);
    assert(res._json.direct_liff_url && /cart_token=[^&]+/.test(res._json.direct_liff_url), 'create success：direct_liff_url 包含 cart_token', res._json.direct_liff_url);
    assert(res._json.fallback_reason === null, 'create success：有 direct_liff_url 時 fallback_reason 為 null');

    const row = db.get('SELECT token FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [STORE, res._json.cart_code]);
    createdToken = row && row.token;
    assert(!!createdToken, '（測試前置）能從 DB 撈出這次建立的完整 token，供下面 restore 測試使用');
  } else {
    manual('create success 完整欄位測試（含 direct_liff_url）', '此環境的 seed 資料沒有任何商品，無法建立合法購物車項目來驗證成功路徑。');
  }

  {
    // 缺 LIFF ID：ok:true，direct_liff_url:null，fallback_reason，OA fallback 仍存在
    const res = makeRes();
    await createHandler({ storeId: STORE_NO_LIFF, ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: (productNoLiff && productNoLiff.id) || 1, qty: 1 }] } } }, res);
    if (product) {
      assert(res._status === 200 && res._json.ok === true, '缺 LIFF ID：仍是 200 + ok:true（不讓整個 Handoff 失敗）');
      assert(res._json.direct_liff_url === null, '缺 LIFF ID：direct_liff_url 為 null');
      assert(res._json.fallback_reason === 'LIFF_ID_MISSING', '缺 LIFF ID：fallback_reason 為 LIFF_ID_MISSING');
      assert(!!res._json.line_oa_message_url && res._json.line_oa_configured === true, '缺 LIFF ID：OA fallback（line_oa_message_url／line_oa_configured）仍存在');
      assert(!!res._json.add_friend_url, '缺 LIFF ID：add_friend_url fallback 仍存在');
    } else {
      manual('缺 LIFF ID 降級測試', '此環境的 seed 資料沒有任何商品，無法建立合法購物車項目。');
    }
  }

  {
    // 不記錄完整 token／URL：檢查原始碼本身沒有把 result.token 或組好的 URL 傳進任何 console.log/logFailure 呼叫
    const src = fs.readFileSync(path.join(ROOT, 'routes/line-checkout-handoff.js'), 'utf8');
    assert(!/logFailure\([^)]*directLiffUrl/.test(src) && !/console\.\w+\([^)]*directLiffUrl/.test(src), '原始碼：direct_liff_url／完整 token 沒有被傳進任何 log 呼叫');
    assert(!/logFailure\([^)]*result\.token\b/.test(src), '原始碼：result.token（完整 secret token）沒有被傳進 logFailure()');
  }

  // ═══════════════ 三：restoreCartToken — pending 自動綁定 × 既有拒絕邏輯 ═══════════════
  {
    const { restoreCartToken, createCartHandoffToken } = require('../utils/lineCheckoutHandoff');
    if (product && createdToken) {
      // 3-1：pending token 首次 Direct LIFF restore 可自動綁定 user
      const r1 = restoreCartToken(db, STORE, createdToken, 'line_user_direct_liff_1');
      assert(r1.ok === true, 'restoreCartToken：pending token 首次 restore 自動綁定成功', JSON.stringify(r1));
      const rowAfterBind = db.get('SELECT status, line_user_id FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [STORE, createdToken]);
      assert(rowAfterBind && rowAfterBind.status === 'opened' && rowAfterBind.line_user_id === 'line_user_direct_liff_1', 'restoreCartToken：綁定後狀態機正確走到 opened，line_user_id 已寫入', JSON.stringify(rowAfterBind));

      // 3-2：已綁定不同 user 時拒絕（不可因自動綁定降低授權驗證）
      const r2 = restoreCartToken(db, STORE, createdToken, 'line_user_attacker');
      assert(r2.ok === false && r2.reason === 'uid_mismatch', 'restoreCartToken：已綁定其他 user 時拒絕（uid_mismatch，自動綁定不繞過此檢查）', JSON.stringify(r2));

      // 3-3：同一個已綁定 user 可以重複 restore（例如頁面重整仍在合法登入狀態）
      const r3 = restoreCartToken(db, STORE, createdToken, 'line_user_direct_liff_1');
      assert(r3.ok === true, 'restoreCartToken：同一個已綁定 user 可重複 restore');
    } else {
      manual('restoreCartToken pending 自動綁定測試', '此環境沒有可用商品，無法建立合法 Cart Handoff Token。');
    }

    // 3-4：store 不存在的 token → not_found
    const rNotFound = restoreCartToken(db, STORE, 'this-token-does-not-exist', 'someone');
    assert(rNotFound.ok === false && rNotFound.reason === 'not_found', 'restoreCartToken：token 不存在 → not_found');

    // 3-5：store_id 不一致（token 屬於別的 store）→ 一律視為 not_found（WHERE store_id=? AND token=? 天然阻擋）
    if (product && createdToken) {
      const rStoreMismatch = restoreCartToken(db, STORE_NO_LIFF, createdToken, 'line_user_direct_liff_1');
      assert(rStoreMismatch.ok === false && rStoreMismatch.reason === 'not_found', 'restoreCartToken：store_id 不一致時拒絕（not_found，token 查詢天然按 store_id 隔離）', JSON.stringify(rStoreMismatch));
    }

    // 3-6：過期 token → expired
    if (product) {
      const created = createCartHandoffToken(db, STORE, {
        cartQtyItems: [{ product_id: product.id, qty: 1 }], checkoutContext: {}, attribution: {}, createdIp: '', createdUserAgent: '',
      });
      db.run("UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE store_id=? AND token=?", [STORE, created.token]);
      const rExpired = restoreCartToken(db, STORE, created.token, 'line_user_x');
      assert(rExpired.ok === false && rExpired.reason === 'expired', 'restoreCartToken：過期 token 拒絕（不會被 pending 自動綁定邏輯繞過）', JSON.stringify(rExpired));

      // 3-7：已消耗 token → consumed
      const created2 = createCartHandoffToken(db, STORE, {
        cartQtyItems: [{ product_id: product.id, qty: 1 }], checkoutContext: {}, attribution: {}, createdIp: '', createdUserAgent: '',
      });
      db.run("UPDATE line_cart_handoff_tokens SET status='consumed' WHERE store_id=? AND token=?", [STORE, created2.token]);
      const rConsumed = restoreCartToken(db, STORE, created2.token, 'line_user_y');
      assert(rConsumed.ok === false && rConsumed.reason === 'consumed', 'restoreCartToken：已消耗 token 拒絕（不會被 pending 自動綁定邏輯繞過）', JSON.stringify(rConsumed));
    }
  }

  // ═══════════════ 四：POST /restore route — session_invalid 與正常流程 ═══════════════
  {
    const { createMemberSession } = require('../utils/lineMemberSession');
    if (product) {
      const created = require('../utils/lineCheckoutHandoff').createCartHandoffToken(db, STORE, {
        cartQtyItems: [{ product_id: product.id, qty: 2 }], checkoutContext: { order_type: 'takeout' }, attribution: {}, createdIp: '', createdUserAgent: '',
      });
      const session = createMemberSession({ store_id: STORE, line_user_id: 'line_user_route_test' });
      const res = makeRes();
      await restoreHandler({ storeId: STORE, body: { cart_token: created.token, member_session: session } }, res);
      assert(res._json && res._json.ok === true, 'POST /restore：合法 token＋member_session → 還原成功（pending 自動綁定走完整路由）', JSON.stringify(res._json));
      assert(res._json && res._json.cart && Array.isArray(res._json.cart.items) && res._json.cart.items.length === 1, 'POST /restore：購物車正確還原（items.length === 1，商品屬於同一測試 store）', JSON.stringify(res._json));
      assert(res._json && res._json.cart && res._json.cart.subtotal === 88 * 2, 'POST /restore：subtotal 正確計算（單價 88 × qty 2）', JSON.stringify(res._json && res._json.cart));
      assert(res._json && res._json.has_unavailable_items === false, 'POST /restore：has_unavailable_items 為 false（商品確實屬於同一 store，未被隔離規則排除）', JSON.stringify(res._json));

      const resBadSession = makeRes();
      const created3 = require('../utils/lineCheckoutHandoff').createCartHandoffToken(db, STORE, {
        cartQtyItems: [{ product_id: product.id, qty: 1 }], checkoutContext: {}, attribution: {}, createdIp: '', createdUserAgent: '',
      });
      await restoreHandler({ storeId: STORE, body: { cart_token: created3.token, member_session: 'not-a-real-session' } }, resBadSession);
      assert(resBadSession._status === 401 && resBadSession._json.ok === false, 'POST /restore：偽造/格式錯誤的 member_session 一律拒絕（401，不會被當成合法登入）', JSON.stringify(resBadSession._json));
      const { verifyMemberSession } = require('../utils/lineMemberSession');
      assert(verifyMemberSession('not-a-real-session', STORE) === null, 'verifyMemberSession：偽造/格式錯誤的 session 一律回傳 null（不會被當成合法登入）');
    } else {
      manual('POST /restore route 完整流程測試', '此環境沒有可用商品，無法建立合法 Cart Handoff Token。');
    }
  }

  // ═══════════════ 五：Diagnostics 白名單 — 本版新增欄位／stage ═══════════════
  {
    const diagLayer = createRouter.stack.find((l) => l.route && l.route.path === '/diagnostics');
    const diagHandler = diagLayer.route.stack[0].handle;
    const newStages = [
      'direct_liff_url_created', 'direct_liff_auto_launch_scheduled', 'direct_liff_manual_clicked',
      'direct_liff_open_attempted', 'liff_checkout_loaded', 'cart_restore_started',
      'cart_restore_success', 'cart_restore_failed', 'cart_token_consumed', 'fallback_to_oa',
    ];
    for (const stage of newStages) {
      const res = makeRes();
      await diagHandler({
        storeId: STORE, ip: '127.0.0.1', headers: {},
        body: {
          stage, attempt: 1, has_direct_liff_url: true, launch_target: 'direct_liff',
          restore_result: 'success', restore_error_code: null, token_consumed: true, has_cart_token: true,
          device: 'iphone', browser: 'line_liff',
        },
      }, res);
      assert(res._json.ok === true, `診斷端點接受新 stage：${stage}`);
    }
    const row = db.get("SELECT metadata_json FROM analytics_events WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics' ORDER BY created_at DESC LIMIT 1", [STORE]);
    const meta = JSON.parse(row.metadata_json);
    assert(meta.stage === 'fallback_to_oa', '診斷端點：stage 正確寫入白名單值');
    assert(meta.has_direct_liff_url === true && meta.launch_target === 'direct_liff', '診斷端點：has_direct_liff_url／launch_target 正確寫入（布林值／白名單字串）');
    assert(meta.restore_result === 'success' && meta.token_consumed === true, '診斷端點：restore_result／token_consumed 正確寫入');
    assert(meta.has_cart_token === true, '診斷端點：has_cart_token 正確寫入（布林值，不是完整 token）');

    // 白名單型別驗證：不接受任意字串／完整 token
    const resBad = makeRes();
    await diagHandler({
      storeId: STORE, ip: '127.0.0.1', headers: {},
      body: {
        stage: 'direct_liff_url_created', launch_target: 'not-a-real-target',
        restore_result: 'maybe', restore_error_code: 'totally-made-up',
        has_cart_token: 'SECRETTOKENVALUE', // 故意塞完整字串，型別驗證應該擋掉（只接受布林值）
      },
    }, resBad);
    const rowBad = db.get("SELECT metadata_json FROM analytics_events WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics' ORDER BY created_at DESC LIMIT 1", [STORE]);
    const metaBad = JSON.parse(rowBad.metadata_json);
    assert(metaBad.launch_target === null, '診斷端點：launch_target 不在白名單內時一律回傳 null，不接受任意字串', String(metaBad.launch_target));
    assert(metaBad.restore_result === null, '診斷端點：restore_result 不在白名單內時一律回傳 null');
    assert(metaBad.restore_error_code === null, '診斷端點：restore_error_code 不在白名單內時一律回傳 null');
    assert(metaBad.has_cart_token === null, '診斷端點：has_cart_token 送入非布林值（例如完整字串）時一律回傳 null，不會把字串原樣寫入', String(metaBad.has_cart_token));

    const src = fs.readFileSync(path.join(ROOT, 'routes/line-checkout-handoff.js'), 'utf8');
    for (const stage of newStages) {
      assert(src.includes(`'${stage}'`), `原始碼：HANDOFF_DIAG_STAGES 白名單包含 '${stage}'`);
    }
  }

  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (e) {}

  // ═══════════════ 六：Messenger Dialog — 單一主按鈕／收合 fallback／真實 <a> ═══════════════
  {
    const storeId = 'store_dialog_direct_liff';
    const directLiffUrl = `https://liff.line.me/2000123456-smoke30?mode=checkout&store_id=${storeId}&cart_token=SECRET`;
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, cart_code: 'CART-DLIFF1', direct_liff_url: directLiffUrl, line_oa_message_url: 'https://line.me/oa', line_oa_configured: true, add_friend_url: 'https://lin.ee/testshop' }),
    });
    const { LineMemberGate, idRegistry, locationAssignments } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    const guideEl = LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-smoke30', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    const html = guideEl._html;

    assert(html.includes('id="lmgGoLineCheckoutBtn"'), 'Dialog：主按鈕元素存在');
    assert(/<a\s[^>]*id="lmgGoLineCheckoutBtn"/.test(html), 'Dialog：主按鈕是真實 <a> 元素');
    const mainBtn = idRegistry['lmgGoLineCheckoutBtn'];
    assert(mainBtn.getAttribute('aria-disabled') === 'true', 'Dialog：ready 前主按鈕 aria-disabled=true（不可點）');
    assert(mainBtn.href === '#', 'Dialog：ready 前主按鈕 href 未指向任何真實網址');

    assert(/<details[^>]*id="lmgCantOpenSection"/.test(html), 'Dialog：fallback 區塊是 <details>（預設收合，沒有 open 屬性）');
    assert(!/id="lmgCantOpenSection"[^>]*open/.test(html), 'Dialog：fallback <details> 預設沒有 open 屬性（收合狀態）');
    // Cart Code 區塊必須在 fallback 區塊內部，不在最上方主視覺
    const idxCantOpen = html.indexOf('id="lmgCantOpenSection"');
    const idxCartCode = html.indexOf('id="lmgCartCodeBlock"');
    assert(idxCartCode > idxCantOpen && idxCantOpen > -1, 'Dialog：Cart Code 區塊收在 fallback <details> 內部，不在主視覺中央');

    assert(html.includes('id="lmgOpenOaBtn"'), 'Dialog：fallback 仍包含「開啟 LINE 官方帳號」');
    assert(html.includes('id="lmgGoChatroomBtn"') && html.includes('使用聊天室完成結帳'), 'Dialog：fallback 仍包含「使用聊天室完成結帳」（舊 Cart Code 流程）');
    assert(html.includes('id="lmgCopyCartCodeBtn"') && html.includes('複製結帳代碼'), 'Dialog：fallback 仍包含「複製結帳代碼」');
    assert(html.includes('id="lmgExternalBrowserBtn"'), 'Dialog：fallback 仍包含「外部瀏覽器開啟」');

    await wait(30);
    assert(mainBtn.href === directLiffUrl, 'Dialog：ready 後主按鈕 href 指向 direct_liff_url', mainBtn.href);
    assert(mainBtn.getAttribute('aria-disabled') === undefined, 'Dialog：ready 後主按鈕不再 disabled');

    await wait(1100);
    assert(locationAssignments.includes(directLiffUrl), 'Auto Launch：Direct LIFF 有值時，自動開啟目標是 direct_liff_url（不是 OA）', JSON.stringify(locationAssignments));
    assert(!locationAssignments.includes('https://line.me/oa'), 'Auto Launch：不再優先開 OA Message URL');
  }

  // ═══════════════ 七：缺 Direct LIFF 時主按鈕退回 OA，且 fallback 自動展開 ═══════════════
  {
    const storeId = 'store_dialog_no_liff';
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, cart_code: 'CART-NOLIFF1', direct_liff_url: null, fallback_reason: 'LIFF_ID_MISSING', line_oa_message_url: 'https://line.me/oa2', line_oa_configured: true, add_friend_url: 'https://lin.ee/testshop' }),
    });
    const { LineMemberGate, idRegistry, locationAssignments } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_ANDROID_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(30);
    const mainBtn = idRegistry['lmgGoLineCheckoutBtn'];
    assert(mainBtn.href === 'https://line.me/oa2', '缺 Direct LIFF：主按鈕退回 OA Message URL（等同 hotfix29-C 行為）', mainBtn.href);
    const cantOpen = idRegistry['lmgCantOpenSection'];
    assert(cantOpen && cantOpen.open === true, '缺 Direct LIFF：fallback <details> 自動展開（open=true），不需要顧客多點一次');

    await wait(1100);
    assert(locationAssignments.includes('https://line.me/oa2'), '缺 Direct LIFF：Auto Launch 退回 OA Message URL');
  }

  // ═══════════════ 八：Auto Launch 不啟動的邊界情況 ═══════════════
  {
    // create failed → 不得啟動 Direct LIFF；但 hotfix29 既有的
    // scheduleAddFriendFallback()（兩次建立都失敗後，1000ms 後自動嘗試開啟
    // 加好友連結）是既有降級行為，不是這裡要驗證的對象，也不得斷言它不會
    // 發生（RCA 已確認：PRE-EXISTING BEHAVIOR，程式碼與 baseline 逐字相同）。
    const storeId = 'store_autolaunch_fail_30';
    const addFriendUrl = 'https://lin.ee/testshop';
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 'HANDOFF_EMPTY_CART', message: 'empty' }) });
    const { LineMemberGate, locationAssignments, diagnosticsCalls } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-smoke30', add_friend_url: addFriendUrl },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(1100);
    // 核心斷言：Direct LIFF 絕不是 launch target（create 失敗時根本沒有
    // direct_liff_url 可用，也沒有 cartCode，scheduleAutoLaunch() 本身就會
    // 直接 return，這裡驗證的是「沒有任何一次 assign 指向 liff.line.me」）。
    assert(!locationAssignments.some((u) => u.includes('liff.line.me')), 'Auto Launch：create failed 時，launch target 絕不是 Direct LIFF（liff.line.me）', JSON.stringify(locationAssignments));
    // 允許（且預期會發生）：既有的 add-friend fallback 最終指向 add_friend_url。
    assert(locationAssignments.includes(addFriendUrl), 'Auto Launch：create failed 時，允許 hotfix29 既有的 add-friend fallback 在 1000ms 後啟動並指向 add_friend_url（PRE-EXISTING BEHAVIOR，非本版驗證對象）', JSON.stringify(locationAssignments));
    const bodies = parsedDiagBodies(diagnosticsCalls);
    assert(bodies.some((b) => b.stage === 'fallback_entered'), 'Auto Launch：create failed 的 fallback_entered 診斷階段有被記錄');
  }
  {
    // Dialog 已關閉 → 不 Auto Launch
    const storeId = 'store_autolaunch_closed_30';
    const directLiffUrl = `https://liff.line.me/2000123456-smoke30?mode=checkout&store_id=${storeId}&cart_token=SECRET2`;
    let resolveDelay;
    const fetchImpl = () => new Promise((resolve) => {
      resolveDelay = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, cart_code: 'CART-CLOSED1', direct_liff_url: directLiffUrl, line_oa_message_url: 'https://line.me/oa3', line_oa_configured: true }) });
    });
    const { LineMemberGate, locationAssignments } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '2000123456-smoke30', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    LineMemberGate.closeExternalBrowserLoginGuide(); // 使用者在 create 完成前就關閉了 Dialog
    if (resolveDelay) resolveDelay();
    await wait(1100);
    assert(locationAssignments.length === 0, 'Auto Launch：Dialog 已關閉時不會呼叫 location.assign()', JSON.stringify(locationAssignments));
  }

  // ═══════════════ 九：Restore UX — 見程式碼結構驗證（避免重複造 line-order.html 的完整 DOM/LIFF mock）═══════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    assert(src.includes('function _handoffTokenShortHash'), 'line-order.html：session marker 短 hash 函式存在');
    assert(!/_handoffTokenShortHash[^{]*\{[^}]*return\s+token/.test(src), 'line-order.html：短 hash 函式本身不會原樣回傳完整 token');
    assert(src.includes('handoff_restored_'), 'line-order.html：session marker key 使用 handoff_restored_ 前綴（不是完整 token）');
    assert(src.includes('only for same-session duplicate restore suppression') || src.includes('not for authentication'), 'line-order.html：session marker 註解明確標註「不作驗證用途」');
    assert(src.includes('function _cleanHandoffUrlParams'), 'line-order.html：URL 清理已收斂成共用函式');
    assert(/_cleanHandoffUrlParams[\s\S]{0,300}searchParams\.delete\('cart_token'\)/.test(src), 'line-order.html：清理函式會移除 cart_token');
    assert(/_cleanHandoffUrlParams[\s\S]{0,300}searchParams\.delete\('mode'\)/.test(src), 'line-order.html：清理函式會移除 mode');
    assert(src.includes('alreadyRestoredThisSession'), 'line-order.html：same-session 重進會先檢查 marker，不會無條件再打 restore API');
    // 「不覆蓋使用者後續修改的購物車」：same-session 分支必須在寫入任何 cartData/localStorage 之前就 return，
    // 也就是這段程式碼順序上要先於呼叫 restore API／寫 ORDER_CART_KEY。
    const idxMarkerCheck = src.indexOf('alreadyRestoredThisSession){');
    const idxApiCall = src.indexOf("apiFetch('/api/line-checkout-handoff/restore'");
    assert(idxMarkerCheck > -1 && idxApiCall > -1 && idxMarkerCheck < idxApiCall, 'line-order.html：same-session 短路檢查發生在呼叫 restore API 之前（不會用舊 snapshot 覆蓋新購物車）');
  }

  // ═══════════════ 十：Friendship Sync 不阻擋 Restore／Checkout ═══════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    const idxEnsureFriend = src.indexOf('ensureFriendRequirement(LINE_STORE_ID');
    assert(idxEnsureFriend > -1, 'line-order.html：Direct LIFF Restore 流程仍會呼叫 ensureFriendRequirement()（好友確認）');
    const snippet = src.slice(Math.max(0, idxEnsureFriend - 40), idxEnsureFriend + 20);
    assert(/try\{[\s\S]*$/.test(snippet) || src.slice(Math.max(0, idxEnsureFriend - 10), idxEnsureFriend).includes('try'), 'line-order.html：ensureFriendRequirement() 呼叫包在 try/catch 內，失敗不拋出例外阻擋流程');
    assert(idxApiCallBeforeFriendCheck(src), 'line-order.html：restore 成功、購物車已寫回之後才做好友確認（friendship 失敗不影響購物車已還原這件事）');
  }
  function idxApiCallBeforeFriendCheck(src) {
    const idxRestoreCartCall = src.indexOf('await restoreCart();');
    const idxEnsureFriend = src.indexOf('ensureFriendRequirement(LINE_STORE_ID');
    return idxRestoreCartCall > -1 && idxEnsureFriend > -1 && idxRestoreCartCall < idxEnsureFriend;
  }

  // ═══════════════ 十一：不記錄完整 token／URL／UID（安全掃描的程式邏輯部分）═══════════════
  {
    const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
    assert(!/reportHandoffDiagnostics\([^)]*directLiffUrl\)/.test(gateSrc), 'line-member-gate.js：完整 directLiffUrl 字串沒有被直接傳進 reportHandoffDiagnostics()');
    assert(gateSrc.includes('has_direct_liff_url: !!'), 'line-member-gate.js：診斷回報一律用 !!normalized.directLiffUrl 轉布林值，不傳完整網址');
  }

  manual('真機 iPhone 13 Pro／iPhone 17 Pro Messenger 實際導流成功率', '需要真實 Messenger WebView + LINE App 環境交叉測試，本測試只能靜態驗證程式邏輯與 DOM 結構，無法測量真實導流成功率。');

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n=== hotfix30 Direct LIFF smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${failCount} MANUAL=${results.filter((r) => r.status === 'MANUAL REQUIRED').length}`);

  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error('[smoke-hotfix30-direct-liff] fatal:', e); process.exit(1); });
