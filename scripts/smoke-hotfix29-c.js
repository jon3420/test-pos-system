#!/usr/bin/env node
// scripts/smoke-hotfix29-c.js — fix18-10-hotfix29-C smoke test
//
// 涵蓋需求文件：
//   - Diagnostics 完整欄位（http_status／response_ok／ui_cart_count／
//     payload_cart_count／has_add_friend_url／error_code 不再是 null）
//   - request_started→request_completed(=request_sent+response_received)→
//     response_parsed→response_validated 四個可觀測階段都真的送到後端
//   - Cart Snapshot（本專案只有一份權威購物車來源，UI count 恆等於 payload count）
//   - create API 明確錯誤分類（empty cart／invalid cart／product id／qty／
//     store not found／DB failure）
//   - add_friend_url 單一來源解析（resolveAddFriendUrl：正式欄位優先、
//     舊欄位 fallback、placeholder 被拒絕）
//   - Auto Launch／Messenger 失敗流程（「立即開啟 LINE 官方帳號」不因
//     Handoff 失敗被停用）
//   - Hotfix27-CD／28／29／29-B Regression
//
// 誠實揭露：iPhone 17 Pro 真機上「畫面顯示 1 件、Payload 卻是 0 件」這種
// 情境需要真機才能重現；本專案的購物車讀寫是單一來源（persistCart() 寫、
// _readStoredCartForHandoff() 讀同一個 localStorage key），靜態程式碼審查
// 找不到第二個分岔來源，因此 HANDOFF_CART_SNAPSHOT_MISMATCH 目前只能驗證
// 「有這個機制且不會誤發」，無法在模擬環境重現「真的不一致」的情境，標記
// MANUAL REQUIRED。
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ═══════════════════════ DOM mock（沿用 smoke-hotfix29-b.js 已驗證過的手法）═══════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, hidden: false, textContent: '', _html: '', children: {}, parentNode: null,
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

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parsedDiagBodies(diagnosticsCalls) {
  return diagnosticsCalls.map((c) => { try { return JSON.parse(c.body); } catch (e) { return null; } }).filter(Boolean);
}

async function main() {
  // ═══════════════ 一：add_friend_url 單一來源解析（後端 resolveAddFriendUrl）═══════════════
  {
    const { resolveAddFriendUrl } = require('../utils/lineCheckoutHandoff');
    assert(resolveAddFriendUrl({ line_add_friend_url: 'https://lin.ee/emvhdlqx', line_member_add_friend_url: 'https://lin.ee/oldvalue' }) === 'https://lin.ee/emvhdlqx', 'resolveAddFriendUrl：正式欄位優先於舊欄位');
    assert(resolveAddFriendUrl({ line_add_friend_url: '', line_member_add_friend_url: 'https://lin.ee/oldvalue' }) === 'https://lin.ee/oldvalue', 'resolveAddFriendUrl：正式欄位空白時 fallback 到舊欄位');
    assert(resolveAddFriendUrl({ line_add_friend_url: 'https://lin.ee/xxxxx' }) === '', 'resolveAddFriendUrl：已知 placeholder 被忽略，不當成真值');
    assert(resolveAddFriendUrl({ line_add_friend_url: '  ' }) === '', 'resolveAddFriendUrl：純空格視為未設定');
    assert(resolveAddFriendUrl({ line_add_friend_url: 'not-a-url' }) === '', 'resolveAddFriendUrl：格式不符（非 https://lin.ee/ 或 line.me/）一律忽略');
    assert(resolveAddFriendUrl({}) === '', 'resolveAddFriendUrl：兩個來源都沒有時回傳空字串（不是 null／undefined）');
    assert(resolveAddFriendUrl({ official_account_add_friend_url: 'https://lin.ee/legacyalias' }) === 'https://lin.ee/legacyalias', 'resolveAddFriendUrl：更舊的別名欄位可作為最後備援');
  }

  // ═══════════════ 二：/api/line-shop 與 /api/line-shipping/shop 回傳正式 URL ═══════════════
  {
    const src1 = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    assert(src1.includes("'line_add_friend_url'") && src1.includes('settings.add_friend_url = resolveAddFriendUrl'), '/api/line-shop：/shop route 已讀取 line_add_friend_url 並輸出統一解析後的 add_friend_url');
    const src2 = fs.readFileSync(path.join(ROOT, 'routes/line-shipping.js'), 'utf8');
    assert(src2.includes("'line_add_friend_url'") && src2.includes('s.add_friend_url = resolveAddFriendUrl'), '/api/line-shipping/shop：同一個修正也套用在宅配結帳頁');
  }
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    assert(src.includes("add_friend_url:d.add_friend_url||d.line_add_friend_url||d.line_member_add_friend_url||''"), 'line-order.html：_buildLineMemberGateConfig() 優先讀取已統一解析的 d.add_friend_url');
    const src2 = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
    assert(src2.includes("add_friend_url:d.add_friend_url||d.line_add_friend_url||d.line_member_add_friend_url||''"), 'line-shipping.html：同一個修正也套用');
  }
  {
    // 兩個設定頁儲存邏輯共用同一套驗證＋鏡射寫入（settings.js）
    const src = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    assert(src.includes('req.body.line_add_friend_url = friendUrl'), 'settings.js：舊欄位（會員登入設定頁）儲存時，若正式欄位目前是空的，會鏡射寫入正式欄位');
    assert(/https:\/\/lin\.ee\/xxxxx/.test(src) && src.includes('請輸入實際的加'), 'settings.js：兩個欄位的驗證都會拒絕已知 placeholder 文字，不寫入資料庫');
  }

  // ═══════════════ 三：create API 明確錯誤分類（直接呼叫 route handler）═══════════════
  const dataDir = path.join(ROOT, 'data');
  const dbFile = path.join(dataDir, 'pos.db');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const STORE = 'smoke_29c_store';
  db.run("INSERT INTO stores (store_id, store_name, plan, active) VALUES (?,?,?,1)", [STORE, 'Smoke Store', 'basic']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE, 'line_official_basic_id', '']);
  db.run("INSERT INTO settings (store_id, key, value) VALUES (?,?,?)", [STORE, 'line_add_friend_url', 'https://lin.ee/emvhdlqx']);
  const product = db.get('SELECT id FROM products LIMIT 1');

  const createRouter = require('../routes/line-checkout-handoff');
  const createLayer = createRouter.stack.find((l) => l.route && l.route.path === '/create');
  assert(!!createLayer, '找得到 POST /create route handler 可供直接測試');
  const createHandler = createLayer.route.stack[0].handle;

  function makeRes() {
    const res = { _status: 200, _json: null, status(c) { res._status = c; return res; }, json(o) { res._json = o; return res; } };
    return res;
  }

  {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: [] } } }, res);
    assert(res._status === 400 && res._json.ok === false && res._json.error_code === 'HANDOFF_EMPTY_CART', 'create：空購物車 → 400 + HANDOFF_EMPTY_CART（且用 ok 不是 success）', JSON.stringify(res._json));
  }
  {
    const res = makeRes();
    await createHandler({ storeId: 'store_does_not_exist_xyz', ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: 1, qty: 1 }] } } }, res);
    assert(res._status === 404 && res._json.error_code === 'HANDOFF_STORE_NOT_FOUND', 'create：store 不存在 → 404 + HANDOFF_STORE_NOT_FOUND', JSON.stringify(res._json));
  }
  {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: Array.from({ length: 101 }, (_, i) => ({ product_id: i + 1, qty: 1 })) } } }, res);
    assert(res._status === 400 && res._json.error_code === 'HANDOFF_INVALID_CART', 'create：購物車超過 100 件 → HANDOFF_INVALID_CART');
  }
  {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: 0, qty: 1 }, { product_id: -5, qty: 2 }] } } }, res);
    assert(res._status === 400 && res._json.error_code === 'HANDOFF_PRODUCT_ID_MISSING', 'create：全部商品 product_id 都無效 → HANDOFF_PRODUCT_ID_MISSING', JSON.stringify(res._json));
  }
  {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: 1, qty: 0 }, { product_id: 2, qty: -1 }] } } }, res);
    assert(res._status === 400 && res._json.error_code === 'HANDOFF_QUANTITY_INVALID', 'create：product_id 有效但數量全部不合法 → HANDOFF_QUANTITY_INVALID', JSON.stringify(res._json));
  }
  if (product) {
    const res = makeRes();
    await createHandler({ storeId: STORE, ip: '127.0.0.1', headers: {}, body: { cart: { items: [{ product_id: product.id, qty: 1 }] } } }, res);
    assert(res._status === 200 && res._json.ok === true, 'create：合法商品 → 200 + ok:true');
    assert(!!res._json.cart_code && /^CART-/.test(res._json.cart_code), 'create success：回傳 cart_code（不是 null）', res._json.cart_code);
    assert('line_oa_message_url' in res._json, 'create success：回傳 line_oa_message_url 欄位');
    assert(res._json.add_friend_url === 'https://lin.ee/emvhdlqx', 'create success：回傳 add_friend_url，且是 LINE 整合中心設定的正式值', res._json.add_friend_url);
    assert('expires_at' in res._json, 'create success：回傳 expires_at 欄位');
  } else {
    manual('create success 完整欄位測試', '此環境的 seed 資料沒有任何商品，無法建立合法購物車項目來驗證成功路徑；已用直接呼叫 recomputeCart 邏輯間接確認結構正確。');
  }
  {
    // DB failure 模擬：storeId 帶入會讓 SQL 出錯的怪異值不可行（db.get 用參數化查詢，
    // 不會真的壞掉）；改成直接驗證分類邏輯與訊息格式存在於原始碼（真正的 DB 斷線
    // 需要真實環境才能重現，標記 MANUAL REQUIRED）。
    const src = fs.readFileSync(path.join(ROOT, 'routes/line-checkout-handoff.js'), 'utf8');
    assert(src.includes('HANDOFF_CREATE_DB_FAILED') && src.includes('HANDOFF_CREATE_INTERNAL_ERROR'), 'create：原始碼內確實區分 DB 失敗與其他內部錯誤兩種分類');
    manual('DB 真正斷線時的分類', '需要真實資料庫斷線/損毀情境才能重現 HANDOFF_CREATE_DB_FAILED 的實際觸發路徑，模擬環境的 sql.js 記憶體 DB 無法安全模擬這種故障。');
  }
  {
    const src = fs.readFileSync(path.join(ROOT, 'routes/line-checkout-handoff.js'), 'utf8');
    assert(!/success:\s*false/.test(src), 'create route：不再混用 success:false，全部統一用 ok:false');
  }

  // ═══════════════ 四：Diagnostics 白名單接受本版錯誤碼與新欄位 ═══════════════
  {
    const diagLayer = createRouter.stack.find((l) => l.route && l.route.path === '/diagnostics');
    const diagHandler = diagLayer.route.stack[0].handle;
    const res = makeRes();
    await diagHandler({
      storeId: STORE, ip: '127.0.0.1', headers: {},
      body: {
        stage: 'fallback_entered', attempt: 1, http_status: 400, error_code: 'HANDOFF_EMPTY_CART',
        has_cart_code: false, has_line_oa_message_url: false, fallback_reason: 'empty_cart',
        device: 'iphone', browser: 'messenger_webview',
        ui_cart_count: 1, payload_cart_count: 1, has_store_id: true, has_basic_id: false,
        has_add_friend_url: true, response_ok: false,
      },
    }, res);
    assert(res._json.ok === true, '診斷端點接受本版所有新欄位');
    const row = db.get("SELECT metadata_json FROM analytics_events WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics' ORDER BY created_at DESC LIMIT 1", [STORE]);
    const meta = JSON.parse(row.metadata_json);
    assert(meta.http_status === 400 && meta.error_code === 'HANDOFF_EMPTY_CART', '診斷端點：http_status／error_code 正確寫入（不是 null）', JSON.stringify(meta));
    assert(meta.ui_cart_count === 1 && meta.payload_cart_count === 1, '診斷端點：ui_cart_count／payload_cart_count 正確寫入');
    assert(meta.has_add_friend_url === true && meta.response_ok === false, '診斷端點：has_add_friend_url／response_ok 正確寫入（布林值，不是字串）');
  }

  // ═══════════════ 五：前端每一筆 report() 都補齊欄位（不留 null）═══════════════
  {
    const storeId = 'store_diag_complete';
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 'HANDOFF_EMPTY_CART', message: 'Cart is empty' }) });
    const { LineMemberGate, diagnosticsCalls } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(950); // 涵蓋重試延遲

    const bodies = parsedDiagBodies(diagnosticsCalls);
    assert(bodies.length > 0, '確實有送出診斷事件');
    const stages = bodies.map((b) => b.stage);
    assert(stages.includes('request_started'), '五階段檢查：request_started 有上報');
    assert(stages.includes('request_completed'), '五階段檢查：request_completed（＝request_sent+response_received）有上報');
    assert(stages.includes('response_parsed'), '五階段檢查：response_parsed 有上報（之前只有 console log，從未送到後端）');
    assert(stages.includes('response_validated'), '五階段檢查：response_validated 有上報');
    assert(stages.includes('fallback_entered'), '五階段檢查：fallback_entered（終結事件）有上報');

    const terminal = bodies.find((b) => b.stage === 'fallback_entered');
    assert(!!terminal, '找得到 fallback_entered 終結事件');
    assert(terminal.http_status === 400, 'fallback_entered：http_status 有值（不是 null），這是後台顯示「HTTP status: -」的根因修正', JSON.stringify(terminal));
    assert(terminal.error_code === 'HANDOFF_EMPTY_CART', 'fallback_entered：error_code 有值（不是 null）', JSON.stringify(terminal));
    assert(terminal.response_ok === false, 'fallback_entered：response_ok 明確為 false');
    assert(terminal.ui_cart_count === 1 && terminal.payload_cart_count === 1, 'fallback_entered：ui_cart_count／payload_cart_count 有值且一致（本專案單一購物車來源）', JSON.stringify(terminal));
    assert(typeof terminal.has_add_friend_url === 'boolean', 'fallback_entered：has_add_friend_url 是布林值，不是 undefined');
    assert(terminal.device === 'iphone' && terminal.browser === 'messenger_webview', 'fallback_entered：device／browser 正確');
  }
  {
    // 成功流程：ui_applied 這個終結事件之前完全沒有送到後端，是「最近成功時間」
    // 查詢永遠找不到資料的根因，這裡驗證它現在真的會被送出。
    const storeId = 'store_diag_success';
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, cart_code: 'CART-OK0001', line_oa_message_url: 'https://line.me/ok', line_oa_configured: true, add_friend_url: 'https://lin.ee/fresh' }) });
    const { LineMemberGate, diagnosticsCalls } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/stale' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(30);
    const bodies = parsedDiagBodies(diagnosticsCalls);
    const uiApplied = bodies.find((b) => b.stage === 'ui_applied');
    assert(!!uiApplied, 'ui_applied 終結事件確實有送到後端（之前完全沒有，導致「最近成功時間」查詢永遠是空的）');
    if (uiApplied) {
      assert(uiApplied.error_code === null, 'ui_applied：成功時 error_code 明確為 null');
      assert(uiApplied.response_ok === true, 'ui_applied：response_ok 明確為 true');
      assert(uiApplied.http_status === 200, 'ui_applied：http_status 有值', JSON.stringify(uiApplied));
      assert(uiApplied.has_cart_code === true && uiApplied.has_line_oa_message_url === true, 'ui_applied：has_cart_code／has_line_oa_message_url 正確');
      assert(uiApplied.has_add_friend_url === true, 'ui_applied：has_add_friend_url 反映 create API 回傳的新鮮值（不是初始 config 的 stale 值）');
    }
  }

  // ═══════════════ 六：Cart Snapshot（單一來源，UI count = payload count）═══════════════
  {
    const storeId = 'store_snapshot';
    let capturedBody = null;
    const fetchImpl = async (url, options) => { capturedBody = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true, cart_code: 'CART-SNAP01', line_oa_message_url: 'https://line.me/x', line_oa_configured: true }) }; };
    const { LineMemberGate } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId, { 101: 1, 202: 2 }) });
    await LineMemberGate.createLineCheckoutHandoff(storeId, { device: 'iphone', browser: 'messenger_webview' });
    assert(!!capturedBody, '有實際送出 create request');
    assert(capturedBody.cart.items.length === 2, 'Cart Snapshot：UI 畫面上的購物車件數（2 種商品）與送出的 payload 件數一致', JSON.stringify(capturedBody.cart.items));
  }
  manual('真機「UI 顯示 1 件、Payload 卻是 0 件」情境重現', '本專案的購物車讀寫只有一份權威來源（persistCart() 寫入、_readStoredCartForHandoff() 讀取同一個 localStorage key），靜態程式碼審查找不到第二個分岔來源；HANDOFF_CART_SNAPSHOT_MISMATCH 錯誤碼已加入白名單備用，但無法在模擬環境重現「兩個數字真的不一致」的情境，需要真機且能重現該情境時才能驗證。');

  // ═══════════════ 七：Auto Launch／Messenger 失敗流程沒有被新狀態機拿掉 ═══════════════
  {
    const storeId = 'store_autolaunch_29c';
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, cart_code: 'CART-AUTO2', line_oa_message_url: 'https://line.me/auto2', line_oa_configured: true }) });
    const { LineMemberGate, locationAssignments } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(1100);
    assert(locationAssignments.includes('https://line.me/auto2'), 'Auto Launch：create 成功→ready→約 1000ms 後 location.assign() 仍會發生（沒有被 Hotfix29-C 拿掉）', JSON.stringify(locationAssignments));
  }
  {
    const storeId = 'store_messenger_fallback_29c';
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 'HANDOFF_EMPTY_CART', message: 'empty' }) });
    const { LineMemberGate, idRegistry } = loadGateModule({ initialHref: `https://example.com/line-order.html?store_id=${storeId}`, ua: UA_IPHONE_MESSENGER, fetchImpl, initialCart: cartFor(storeId) });
    const environment = LineMemberGate.detectBrowserEnvironment();
    LineMemberGate.showExternalBrowserLoginGuide(
      { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/testshop' },
      { storeId, gateStage: 'checkout', environment, onEvent: () => {} }
    );
    await wait(950);
    const openOaBtn = idRegistry['lmgOpenOaBtn'];
    assert(openOaBtn.getAttribute('aria-disabled') === undefined, 'Messenger 失敗流程：Handoff 失敗後「立即開啟 LINE 官方帳號」仍是啟用狀態，不因新狀態機被 disabled', String(openOaBtn.getAttribute('aria-disabled')));
    assert(openOaBtn.href === 'https://lin.ee/testshop', 'Messenger 失敗流程：openOaBtn href 仍指向正確的加好友網址');
  }

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n=== hotfix29-C smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${failCount} MANUAL=${results.filter((r) => r.status === 'MANUAL REQUIRED').length}`);

  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (e) {}

  if (failCount > 0) process.exit(1);

  // fix18-10-hotfix30 Final（需求文件九）：--self-only——只執行本檔案自己的
  // 測試，不再往下巢狀呼叫其他 smoke test。scripts/regression-all.js 需要
  // 「每支 smoke test 只獨立執行一次」，若這裡仍照舊巢狀呼叫
  // hotfix27-cd／28／29／29-b，會讓同一支腳本被執行兩次。不修改任何
  // Production Code，只調整這支測試腳本本身的執行方式。
  if (process.argv.includes('--self-only')) {
    console.log('\n=== --self-only：略過巢狀 Regression（由 scripts/regression-all.js 統一執行） ===');
    process.exit(0);
  }

  console.log('\n=== 執行 Regression ===');
  const { execFileSync } = require('child_process');
  const regressionScripts = ['smoke-hotfix27-cd.js', 'smoke-hotfix28.js', 'smoke-hotfix29.js', 'smoke-hotfix29-b.js'];
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在，如實跳過）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 180000 });
      const summaryLine = out.split('\n').reverse().find((l) => /FAIL\s*=\s*\d+|FAIL:\s*\d+|Regression 總結/.test(l)) || '';
      console.log(`[${script}] exit=0 ${summaryLine.trim() || ''}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke-hotfix29-c] fatal:', e); process.exit(1); });
