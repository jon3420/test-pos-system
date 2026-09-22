#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-public-checkout.js
// H1.4.12 Phase 3｜快閃取餐排程中心 — 公開入口 + 結帳權威驗證 + allocation
// 原子扣減／冪等釋放 真實測試。真實 sql.js 暫存 DB、真實 Express router、
// 真實 HTTP request/response、真實 staff JWT（建立測試 fixture 用）。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pp = require('../utils/popupPickup');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3 popup public entry + checkout (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;

  try {
    // ── 測試店家、授權、商品 ──────────────────────────────────────
    db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`,
      ['store_002', 'Store Two', 'Manager2', 'pro', 1]);
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_001', '脆豬腰', 'pro', 1, features]);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_002', 'Store Two', 'pro', 1, features]);
    // products 表的 line_takeout_enabled 欄位是 routes/products.js 呼叫期間才
    // runtime-safe 補上的（ensureProductModeColumns()，非 utils/db.js 的
    // initTables() 直接建立），這裡先確保欄位存在，避免因為測試沒有先呼叫過
    // 任何 /api/products 端點就直接寫入 products 資料而報 "no such column"。
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); db._save(); } catch (e) {}
    try { db._db.run('ALTER TABLE products ADD COLUMN line_delivery_enabled INTEGER DEFAULT 1'); db._save(); } catch (e) {}

    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_takeout_enabled) VALUES
      (301, 'store_001', '排骨飯', '主食', 120, 1, 1),
      (302, 'store_001', '珍珠奶茶', '飲料', 60, 1, 1),
      (303, 'store_001', '未開放外帶商品', '主食', 100, 1, 0),
      (401, 'store_002', 'Store2 商品', '主食', 100, 1, 1)`);
    db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES
      ('store_001', '現金', 'cash', 1, 1),
      ('store_001', '限外送', 'delivery_only', 1, 0)`);
    db._save();

    const express = require('express');
    const app = express();
    app.use(express.json());
    // 模擬真實 server.js 掛載順序：popup-public（無 requireStore，store_id
    // 由 public_code 反查）先掛，一般 line-orders（requireStore+requireFeature）
    // 後掛，兩者互不影響（Phase 3A.1 修正）。
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    const { requireStore } = require('../middleware/storeGuard');
    const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), require('../routes/line-orders'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    // H1.4.12 Phase 3A.2：/popup-order 應回 503 placeholder，不得導向一般
    // line-order.html（見 server.js 的同一段邏輯，這裡直接複製那 8 行來測試，
    // 因為 server.js 本身是啟動整個應用程式的進入點，不適合在單元測試裡
    // require 整支 server.js）。
    app.get('/popup-order', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.status(503).json({ success: false, error: 'POPUP_ORDER_UI_NOT_READY', message: '快閃取餐點餐頁面尚未上線，請稍後再試' });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
    async function call(method, urlPath, { token, body, query } = {}) {
      let url = `${base}${urlPath}`;
      if (query) url += `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const T1 = tokenFor('store_001');

    async function enablePopup(storeId, enabled) {
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'popup_pickup_enabled', ?)", [storeId, enabled ? '1' : '0']);
      db._save();
    }

    async function makeCampaign(name, status = 'published') {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
      if (status !== 'draft') await call('PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token: T1, body: { status } });
      return r.json.data;
    }
    async function makeLocation(name) {
      const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name, address: name + ' Addr', lat: 25, lng: 121 } });
      return r.json.data;
    }
    // 場次時間刻意用「現在往前 1 小時開放、往後 2 小時截止」，確保建立當下
    // 就落在 ordering_open（測試不需要額外 monkey-patch 時間）。
    // H1.4.12 Phase 3A.1 修正：不得用 process-local 的 `new Date().getDate()`
    // 等方法推算「今天的 Taipei 日期」——那些方法讀的是執行主機的系統時區
    // （被 TZ 環境變數影響），在午夜前後可能跟真正的 Asia/Taipei 日期差一天，
    // 導致測試結果隨執行時間/TZ 而不穩定。改用固定 +8 小時偏移後取
    // UTC 日期欄位，天生不受 process.env.TZ 影響。
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      const y = shifted.getUTCFullYear();
      const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
      const d = String(shifted.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    function nowWindow() {
      return {
        pickup_date: taipeiDateStr(2), // 2 天後取餐，避免任何跨午夜邊界問題
        pickup_start_time: '10:00',
        pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, // 今天 00:00（必定已過），確保測試執行當下一定落在開放期
        order_cutoff_at: `${taipeiDateStr(2)}T09:00`, // 取餐前一小時截止，遠在未來
      };
    }
    async function makeSession(campaignId, locationId, overrides = {}) {
      const w = nowWindow();
      const r = await call('POST', '/api/popup-pickup/sessions', {
        token: T1,
        body: { campaign_id: campaignId, name: 'PubSession', location_id: locationId, product_scope: 'all_takeout', ...w, ...overrides },
      });
      if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
      if (!overrides.status) await call('PATCH', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1, body: { expected_revision: r.json.data.revision, status: 'published' } });
      const fresh = await call('GET', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1 });
      return fresh.json.data;
    }

    // ══════════════════════════════════════════════════════════════
    // 一、popup_pickup_enabled=0 時，公開入口回傳 disabled，不洩漏資料
    // ══════════════════════════════════════════════════════════════
    await enablePopup('store_001', false);
    {
      const r = await call('GET', '/api/line-orders/popup-entry', { query: { store_id: 'store_001' } });
      assert(r.status === 200 && r.json.data.enabled === false && r.json.data.campaigns.length === 0, '1-disabled popup-entry 關閉時回 enabled:false、campaigns 空陣列', JSON.stringify(r.json));
    }
    {
      // 不存在的 code 本來就查不到 store，回 404 SESSION_NOT_FOUND（合理，
      // 不代表 feature flag 檢查有沒有生效——這只是 sanity check）。
      const r = await call('GET', '/api/line-orders/popup-session/anything');
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '1-disabled-nonexistent-code 不存在的 public_code 直接回 404（尚未進到 feature flag 檢查）', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 二、開啟後：永久入口、活動網址、場次網址
    // ══════════════════════════════════════════════════════════════
    await enablePopup('store_001', true);
    const camp = await makeCampaign('公開測試活動');
    const loc = await makeLocation('公開測試地點');
    const sessAllTakeout = await makeSession(camp.id, loc.id, { product_scope: 'all_takeout' });

    {
      // 現在有一個「真的存在」的場次 code 了，關閉開關後用這個真實 code 查
      // 詢，這時才真正驗證到 feature-flag 檢查本身（不是被 code 不存在擋下）。
      // Phase 3A.2 修正：response payload 必須跟「code 根本不存在」完全一樣
      // （同一組 status/error/message），不能讓呼叫端從回應內容分辨出
      // 「這個 code 其實是真的，只是功能被關掉」。
      await enablePopup('store_001', false);
      const rNonexistent = await call('GET', `/api/line-orders/popup-session/definitely-does-not-exist`);
      const rDisabledReal = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
      assert(rDisabledReal.status === 404 && rDisabledReal.json.error === 'POPUP_SESSION_NOT_FOUND', '1-disabled-real-code 關閉開關後，真實存在的 public_code 回 404 POPUP_SESSION_NOT_FOUND', JSON.stringify(rDisabledReal));
      assert(JSON.stringify(rDisabledReal.json) === JSON.stringify(rNonexistent.json) && rDisabledReal.status === rNonexistent.status, '1-disabled-real-code-indistinguishable 「功能關閉的真實 code」與「根本不存在的 code」回應內容逐位元組相同，無法從 payload 分辨', JSON.stringify({ disabled: rDisabledReal.json, nonexistent: rNonexistent.json }));
      const rCheckout = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0900000000', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rCheckout.status === 404 && rCheckout.json.error === 'POPUP_SESSION_NOT_FOUND', '1-disabled-real-code 關閉開關後，快閃結帳也一律拒絕、回應跟資源不存在無法區分（不建立佔用份數的訂單）', JSON.stringify(rCheckout));
      await enablePopup('store_001', true);
    }


    {
      const r = await call('GET', '/api/line-orders/popup-entry', { query: { store_id: 'store_001' } });
      assert(r.status === 200 && r.json.data.enabled === true, '2-entry 開啟後 enabled:true', JSON.stringify(r.json.data.enabled));
      const found = r.json.data.campaigns.find((c) => c.public_code === camp.public_code);
      assert(!!found, '2-entry 永久入口列出剛建立的已發布活動', JSON.stringify(r.json.data.campaigns.map((c) => c.public_code)));
      const sessFound = found && found.sessions.find((s) => s.public_code === sessAllTakeout.public_code);
      assert(!!sessFound && sessFound.can_order === true, '2-entry 場次在 ordering_open 時 can_order=true', JSON.stringify(sessFound));
      assert(sessFound && !('id' in sessFound), '2-entry 公開回應不含內部自增/UUID id 欄位', JSON.stringify(Object.keys(sessFound)));
    }
    {
      const r = await call('GET', `/api/line-orders/popup-campaign/${camp.public_code}`, { query: { store_id: 'store_001' } });
      assert(r.status === 200 && r.json.data.sessions.length >= 1, '2-campaign-url 活動網址正確回傳場次列表', JSON.stringify(r.json));
    }
    {
      const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`, { query: { store_id: 'store_001' } });
      assert(r.status === 200 && r.json.data.effective_state === 'ordering_open', '2-session-url 場次直達網址正確回傳狀態', JSON.stringify(r.json.data.effective_state));
    }
    {
      // 不存在的 public_code 一律 404，不得洩漏存在性
      const r = await call('GET', '/api/line-orders/popup-session/does-not-exist');
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '2-invalid-code 不存在的 public_code 回 404', JSON.stringify(r));
      // Phase 3A.1 修正：store_id 完全由 public_code 反查，query.store_id 不
      // 再有任何作用——即使夾帶「別店」的 store_id 也不會影響查到的結果
      // （因為根本不會被讀取），驗證這個 query 參數被完全忽略、回應仍正確
      // 對應到 code 真正所屬的 store_001。
      const r2 = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`, { query: { store_id: 'store_002' } });
      assert(r2.status === 200 && r2.json.data.public_code === sessAllTakeout.public_code, '2-store-id-ignored query.store_id 夾帶別店代碼完全不影響結果，store_id 由 code 本身反查（不是被「正確地擋下」，是這個參數本來就不會被讀取）', JSON.stringify(r2));
    }

    // ══════════════════════════════════════════════════════════════
    // 三、all_takeout 結帳：happy path、snapshot 正確、allocation active
    // ══════════════════════════════════════════════════════════════
    let happyOrderId;
    {
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: {
          popup_session_public_code: sessAllTakeout.public_code,
          customer_name: '王小明', customer_phone: '0912345678', payment_method: 'cash',
          items: [{ product_id: 301, qty: 2 }, { product_id: 302, qty: 1 }],
        },
      });
      assert(r.status === 201, '3-checkout-happy all_takeout 結帳成功', JSON.stringify(r));
      assert(r.json.data.total === 120 * 2 + 60, '3-checkout-happy 後端重算金額正確（前端未送金額）', JSON.stringify(r.json.data.total));
      happyOrderId = r.json.data.id;

      const orderRow = db.get('SELECT * FROM orders WHERE id=?', [happyOrderId]);
      assert(orderRow.pickup_type === 'popup' && orderRow.popup_session_id === sessAllTakeout.id, '3-checkout-happy 訂單 pickup_type=popup、popup_session_id 正確', JSON.stringify({ pickup_type: orderRow.pickup_type, popup_session_id: orderRow.popup_session_id }));
      assert(orderRow.popup_campaign_name_snapshot === camp.name && orderRow.popup_session_name_snapshot === sessAllTakeout.name, '3-checkout-happy 活動/場次名稱 snapshot 正確', JSON.stringify({ c: orderRow.popup_campaign_name_snapshot, s: orderRow.popup_session_name_snapshot }));
      assert(orderRow.pickup_place_name_snapshot === loc.name && orderRow.pickup_address_snapshot === loc.address, '3-checkout-happy 地點 snapshot 沿用既有 pickup_*_snapshot 欄位、內容正確', JSON.stringify({ place: orderRow.pickup_place_name_snapshot, addr: orderRow.pickup_address_snapshot }));

      const allocRows = db.all('SELECT product_id, qty, status FROM popup_order_allocations WHERE order_id=? ORDER BY product_id', [happyOrderId]);
      assert(allocRows.length === 2 && allocRows[0].product_id === 301 && allocRows[0].qty === 2 && allocRows[0].status === 'active', '3-checkout-happy allocation 正確寫入（product 301 x2, active）', JSON.stringify(allocRows));
      assert(allocRows[1].product_id === 302 && allocRows[1].qty === 1 && allocRows[1].status === 'active', '3-checkout-happy allocation 正確寫入（product 302 x1, active）', JSON.stringify(allocRows[1]));
    }

    // ══════════════════════════════════════════════════════════════
    // 三.5（Phase 3B 補強）：all_takeout 場次的公開商品清單 — 既知整合缺口#1
    // 修正前這個端點對 all_takeout 場次一律回 products: []，前端完全無法
    // 知道有哪些商品可買。修正後必須跟 GET /menu／checkout 用同一套資格
    // 判斷（p.enabled=1 AND p.show_on_line=1 AND is_line_takeout_orderable）。
    // ══════════════════════════════════════════════════════════════
    {
      const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
      assert(r.status === 200, '3.5-all-takeout-products GET /popup-session 成功', JSON.stringify(r));
      const products = r.json.data.products;
      // 注意：initDb() 會為 store_001 無條件 seed 一批 demo 商品（id 1~12），
      // 這些商品本身也符合 all_takeout 的資格條件，因此不能斷言陣列總長度
      // ——只斷言「本測試新增的商品」出現/不出現，避免跟既有 demo seed 資料
      // 碰撞（這也是為什麼本測試特別把自己的商品 id 選在 301/302/303/401，
      // 跟 demo seed 的 1~12 不重疊）。
      assert(Array.isArray(products) && products.length >= 2, '3.5-all-takeout-products all_takeout 場次回傳非空商品清單（至少含本測試新增的兩項）', JSON.stringify(products));
      const p301 = products.find((p) => p.product_id === 301);
      const p302 = products.find((p) => p.product_id === 302);
      assert(!!p301 && p301.name === '排骨飯' && p301.price === 120, '3.5-all-takeout-products 商品 301 名稱/價格與 products 表一致', JSON.stringify(p301));
      assert(!!p302 && p302.name === '珍珠奶茶' && p302.price === 60, '3.5-all-takeout-products 商品 302 名稱/價格與 products 表一致', JSON.stringify(p302));
      assert(!products.some((p) => p.product_id === 303), '3.5-all-takeout-products line_takeout_enabled=0 的商品 303 不出現在公開清單中', JSON.stringify(products));
      assert(p301.quota_qty === null && p301.remaining_qty === null && p301.sold_out === false, '3.5-all-takeout-products all_takeout 商品沒有逐品配額，quota_qty/remaining_qty 一律 null、sold_out=false', JSON.stringify(p301));
      // store_002 的商品不得洩漏進 store_001 的 all_takeout 清單（跨店隔離）
      assert(!products.some((p) => p.product_id === 401), '3.5-all-takeout-products 不洩漏其他店家（store_002）的商品', JSON.stringify(products));
    }
    {
      // 既有 selected scope 行為不得因為新增 all_takeout 分支而改變（回歸檢查）。
      const campSel = await makeCampaign('Selected Scope 回歸測試');
      const locSel = await makeLocation('Selected Scope 地點');
      const sessSel = await makeSession(campSel.id, locSel.id, {
        product_scope: 'selected', products: [{ product_id: 301, quota_qty: 5 }],
      });
      const r = await call('GET', `/api/line-orders/popup-session/${sessSel.public_code}`);
      assert(r.status === 200 && Array.isArray(r.json.data.products) && r.json.data.products.length === 1 && r.json.data.products[0].product_id === 301 && r.json.data.products[0].quota_qty === 5, '3.5-selected-scope-regression selected scope 仍只回傳白名單內商品、quota_qty 維持原本行為（未受 all_takeout 新分支影響）', JSON.stringify(r.json.data.products));
    }

    // ══════════════════════════════════════════════════════════════
    // 三.6（Phase 3B 補強）：場次總單量限制（max_orders/order_count）公開顯示
    // ══════════════════════════════════════════════════════════════
    {
      const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
      assert(r.json.data.max_orders === null && r.json.data.order_count === null, '3.6-max-orders-unlimited 未設定 max_orders 時，max_orders/order_count 一律回 null（不限量）', JSON.stringify({ max_orders: r.json.data.max_orders, order_count: r.json.data.order_count }));
    }
    {
      const campCap = await makeCampaign('總量上限測試活動');
      const locCap = await makeLocation('總量上限測試地點');
      const sessCap = await makeSession(campCap.id, locCap.id, { product_scope: 'all_takeout', max_orders: 2 });
      const before = await call('GET', `/api/line-orders/popup-session/${sessCap.public_code}`);
      assert(before.json.data.max_orders === 2 && before.json.data.order_count === 0, '3.6-max-orders-set 設定 max_orders=2 時正確回傳、目前 order_count=0', JSON.stringify(before.json.data));
      await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessCap.public_code, customer_name: 'Y', customer_phone: '0922222222', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      const after = await call('GET', `/api/line-orders/popup-session/${sessCap.public_code}`);
      assert(after.json.data.order_count === 1, '3.6-max-orders-increment 下單一筆後 order_count 隨真實訂單數增加（fresh 查詢，非前端快取值）', JSON.stringify(after.json.data));
    }

    // ══════════════════════════════════════════════════════════════
    // 三.6.1（Phase 3B 補強）：order_count 顯示值與 checkout 權威判定必須是
    // 「同一份 SQL」，不是分別維護、可能漂移的兩套邏輯。實作上
    // serializePublicSession() 的 order_count 與
    // validatePopupCheckoutAuthority() 的 max_orders 檢查都呼叫同一個
    // countActivePopupOrdersForSession()，這裡用行為驗證這件事：cancelled／
    // voided 訂單都不得計入，且兩邊（顯示值、checkout 是否視為已滿）對這批
    // 訂單的判定必須完全一致，不能一邊算 2 筆、另一邊算 4 筆。
    // ══════════════════════════════════════════════════════════════
    {
      const campParity = await makeCampaign('order_count parity 測試活動');
      const locParity = await makeLocation('order_count parity 測試地點');
      const sessParity = await makeSession(campParity.id, locParity.id, { product_scope: 'all_takeout', max_orders: 3 });

      async function placeOrder(phone) {
        const r = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessParity.public_code, customer_name: 'Z', customer_phone: phone, payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
        });
        if (r.status !== 201) throw new Error('placeOrder failed: ' + JSON.stringify(r));
        return r.json.data.id;
      }
      const activeOrder1 = await placeOrder('0933300001');
      const activeOrder2 = await placeOrder('0933300002');
      const toBeCancelled = await placeOrder('0933300003');
      // 已達 max_orders=3，第 4 筆理應被 409 FULL 擋下——用來確認「本次
      // countActivePopupOrdersForSession() 的計數方式」跟 checkout 權威
      // 判斷用的是同一個結果，不是顯示值算 3、checkout 卻算成別的數字。
      const rFullBeforeCancel = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessParity.public_code, customer_name: 'Z', customer_phone: '0933300004', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rFullBeforeCancel.status === 409 && rFullBeforeCancel.json.error === 'POPUP_SESSION_FULL', '3.6.1-checkout-full 三筆有效訂單已達 max_orders=3，第四筆被 409 POPUP_SESSION_FULL 擋下', JSON.stringify(rFullBeforeCancel));

      // 把其中一筆改成 cancelled、另外新增一筆 voided，驗證這兩種狀態都
      // 不計入 order_count／max_orders 判斷（跟 checkout SQL 的
      // `order_status NOT IN ('cancelled') AND (voided_at IS NULL OR
      // voided_at='')` 完全一致，不是另外發明一套排除規則）。
      db._db.run("UPDATE orders SET order_status='cancelled' WHERE id=?", [toBeCancelled]);
      db._db.run("UPDATE orders SET voided_at=datetime('now','localtime') WHERE id=?", [activeOrder2]);
      db._save();

      const afterCancel = await call('GET', `/api/line-orders/popup-session/${sessParity.public_code}`);
      assert(afterCancel.json.data.order_count === 1, '3.6.1-order-count-excludes cancelled/voided 訂單都不計入 order_count（3 筆裡只剩 activeOrder1 是真正 active）', JSON.stringify(afterCancel.json.data));

      // 顯示值算出 1 筆有效訂單，checkout 這一層現在應該視為「還有名額」，
      // 允許再下 2 筆才會真正達到 max_orders=3——驗證顯示值跟 checkout
      // 權威判斷是同一套計數，不是顯示值降回 1 但 checkout 仍然卡在滿額。
      const rAfterCancel2 = await placeOrder('0933300005');
      const rAfterCancel3 = await placeOrder('0933300006');
      const rFullAgain = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessParity.public_code, customer_name: 'Z', customer_phone: '0933300007', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rFullAgain.status === 409 && rFullAgain.json.error === 'POPUP_SESSION_FULL', '3.6.1-checkout-count-parity 取消/作廢釋放名額後，checkout 允許補滿到 max_orders=3（顯示值與權威判斷計數一致，非分別維護兩套邏輯）', JSON.stringify(rFullAgain));
      const finalDisplay = await call('GET', `/api/line-orders/popup-session/${sessParity.public_code}`);
      assert(finalDisplay.json.data.order_count === 3, '3.6.1-final-display 最終顯示值 order_count=3，與 checkout 認定的滿額狀態一致', JSON.stringify(finalDisplay.json.data));
      // 所有公開數值必須是安全整數且非負。
      assert(Number.isSafeInteger(finalDisplay.json.data.order_count) && finalDisplay.json.data.order_count >= 0, '3.6.1-safe-integer order_count 是安全非負整數', JSON.stringify(finalDisplay.json.data.order_count));
      assert(Number.isSafeInteger(finalDisplay.json.data.max_orders) && finalDisplay.json.data.max_orders >= 0, '3.6.1-safe-integer max_orders 是安全非負整數', JSON.stringify(finalDisplay.json.data.max_orders));
    }
    {
      // 不同 session／不同 store 的訂單不得混入彼此的 order_count。
      const campOther = await makeCampaign('order_count 隔離測試活動');
      const locOther = await makeLocation('order_count 隔離測試地點');
      const sessOtherA = await makeSession(campOther.id, locOther.id, { product_scope: 'all_takeout', max_orders: 5 });
      const sessOtherB = await makeSession(campOther.id, locOther.id, { product_scope: 'all_takeout', max_orders: 5 });
      await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessOtherA.public_code, customer_name: 'A', customer_phone: '0933300010', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      const rB = await call('GET', `/api/line-orders/popup-session/${sessOtherB.public_code}`);
      assert(rB.json.data.order_count === 0, '3.6.1-session-isolation session A 下單不會計入 session B 的 order_count（同一活動底下的兩個場次也完全獨立）', JSON.stringify(rB.json.data));
    }

    // ══════════════════════════════════════════════════════════════
    // 三.6.2（本回合補強）：一般 LINE 營業條件／quota 不得誤套 popup。
    // 用實際欄位、走正式 API（GET /shop、GET /menu、popup public API），
    // 不是 source grep：把一般外帶關閉、把商品 301 的一般 LINE 今日份數
    // 用盡，確認 popup 完全不受影響（direct session 仍顯示商品、popup
    // checkout 仍成功），同時確認一般通路本身確實反映「已關閉／已售完」
    // （證明兩邊真的是兩套獨立規則，不是 popup 意外沿用/破壞了一般規則）。
    // ══════════════════════════════════════════════════════════════
    {
      const takeoutEnabledSnap = snapshotSettingRow('takeout_enabled');
      const product301Snap = db.get(
        'SELECT line_quota_enabled, line_quota_daily, line_quota_sold FROM products WHERE id=301 AND store_id=?', ['store_001']
      );
      try {
        // (1) 一般外帶營業時間關閉。
        db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_enabled','0')");
        // (2) 一般 LINE 商品今日份數用盡（daily=1, sold=1 → remaining=0）。
        db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=1, line_quota_sold=1 WHERE id=301 AND store_id=?', ['store_001']);
        db._save();

        // 先確認一般通路本身真的反映「已關閉／已售完」（不是我沒設定成功
        // 而導致後面的 popup 比對沒有意義）。
        const shopClosed = await call('GET', '/api/line-orders/shop', { query: { store_id: 'store_001' } });
        assert(shopClosed.status === 200 && shopClosed.json.data.takeout_enabled === '0', '3.6.2-general-closed-precondition GET /shop 確認一般外帶 takeout_enabled 已關閉', JSON.stringify(shopClosed.json.data.takeout_enabled));
        const menuExhausted = await call('GET', '/api/line-orders/menu', { query: { store_id: 'store_001' } });
        const menuProd301 = menuExhausted.json.data.products.find((p) => p.id === 301);
        assert(!!menuProd301 && menuProd301.line_quota && menuProd301.line_quota.hasQuota === true && menuProd301.line_quota.remaining === 0, '3.6.2-general-quota-precondition GET /menu 確認商品 301 一般 LINE 今日份數已用盡（remaining=0）', JSON.stringify(menuProd301 && menuProd301.line_quota));

        // popup session 本身仍在有效訂購期間、popup 自己的 all_takeout 場次
        // 沒有任何逐商品配額限制——確認 direct popup session 仍正常顯示
        // 商品 301（不誤套一般營業時間/一般 quota）。
        const popupSessionResp = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
        assert(popupSessionResp.status === 200 && popupSessionResp.json.data.effective_state === 'ordering_open', '3.6.2-popup-unaffected-state popup session 本身仍是 ordering_open，不受一般外帶關閉影響', JSON.stringify(popupSessionResp.json.data.effective_state));
        const popupProd301 = popupSessionResp.json.data.products.find((p) => p.product_id === 301);
        assert(!!popupProd301 && popupProd301.sold_out === false, '3.6.2-popup-unaffected-product 一般 LINE 今日份數用盡，但商品 301 在 popup all_takeout 公開清單仍正常顯示、非售罄（popup 沒有逐商品配額，也不查一般 line_quota_*）', JSON.stringify(popupProd301));

        // popup checkout 仍應依 popup 自己的規則成功（不查一般 takeout_enabled
        // 或一般 line_quota_*）。
        const popupCheckoutResp = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'GeneralClosedTest', customer_phone: '0933300020', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
        });
        assert(popupCheckoutResp.status === 201, '3.6.2-popup-checkout-still-succeeds 一般外帶關閉＋一般 LINE quota 用盡時，popup checkout 仍依 popup 自己的規則成功', JSON.stringify(popupCheckoutResp));

        // 一般 LINE checkout 的既有阻擋行為不得改變：GET /shop、GET /menu 在
        // 同一組 fixture 下仍然回報「關閉／已售完」，證明本次改動完全沒有
        // 動到一般通路自己的判斷邏輯（本次只新增/修改 utils/popupCheckout.js
        // 與 popup 專用測試檔，routes/line-orders.js 本身未被觸碰）。
        const shopStillClosed = await call('GET', '/api/line-orders/shop', { query: { store_id: 'store_001' } });
        assert(shopStillClosed.json.data.takeout_enabled === '0', '3.6.2-general-still-closed-after popup 測試前後，一般外帶關閉狀態未被 popup 流程意外改變', JSON.stringify(shopStillClosed.json.data.takeout_enabled));
      } finally {
        restoreSettingRow('takeout_enabled', takeoutEnabledSnap);
        db._db.run('UPDATE products SET line_quota_enabled=?, line_quota_daily=?, line_quota_sold=? WHERE id=301 AND store_id=?', [
          product301Snap.line_quota_enabled, product301Snap.line_quota_daily, product301Snap.line_quota_sold, 'store_001',
        ]);
        db._save();
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 三.7（Phase 3B 契約補強）：all_takeout 公開商品清單必須與
    // resolveLineProductPricing() 這一份 SSOT 完全一致——不得另外複製一套
    // 定價/資格判斷。逐條驗證優先序、fallback、各種排除條件。商品 id 刻意
    // 選在 310~317（跟本檔案其餘測試、demo seed 1~12、301~303/401 均不重疊）。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, takeaway_price, line_price, line_name, enabled, show_on_line, sale_status, line_sold_out, line_takeout_enabled) VALUES
        (310, 'store_001', 'enabled=0商品', '主食', 100, 0, 0, '', 0, 1, 'available', 0, 1),
        (311, 'store_001', 'show_on_line=0商品', '主食', 100, 0, 0, '', 1, 0, 'available', 0, 1),
        (312, 'store_001', 'sold_out_today商品', '主食', 100, 0, 0, '', 1, 1, 'sold_out_today', 0, 1),
        (313, 'store_001', 'line_sold_out商品', '主食', 100, 0, 0, '', 1, 1, 'available', 1, 1),
        (314, 'store_001', 'line_price=0商品', '主食', 100, 150, 0, '', 1, 1, 'available', 0, 1),
        (315, 'store_001', 'line_price優先商品', '主食', 100, 0, 200, '', 1, 1, 'available', 0, 1),
        (316, 'store_001', '原始名稱', '主食', 90, 0, 0, '   ', 1, 1, 'available', 0, 1)`);
      db._save();
      try {
        const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
        const products = r.json.data.products;
        assert(!products.some((p) => p.product_id === 310), '3.7-eligibility enabled=0 的商品不出現在公開清單', JSON.stringify(products.filter((p) => [310].includes(p.product_id))));
        assert(!products.some((p) => p.product_id === 311), '3.7-eligibility show_on_line=0 的商品不出現在公開清單', JSON.stringify(products.filter((p) => [311].includes(p.product_id))));
        assert(!products.some((p) => p.product_id === 312), '3.7-eligibility sale_status=sold_out_today 的商品不出現在公開清單', JSON.stringify(products.filter((p) => [312].includes(p.product_id))));
        assert(!products.some((p) => p.product_id === 313), '3.7-eligibility line_sold_out=1 的商品不出現在公開清單', JSON.stringify(products.filter((p) => [313].includes(p.product_id))));
        const p314 = products.find((p) => p.product_id === 314);
        assert(!!p314 && p314.price === 150, '3.7-eligibility line_price=0 視為「未設定」，正確 fallback 到 takeaway_price（150，不是 price=100，也不是誤判成 0）', JSON.stringify(p314));
        const p315 = products.find((p) => p.product_id === 315);
        assert(!!p315 && p315.price === 200, '3.7-eligibility line_price>0 時優先於 takeaway_price/price（line_price=200 > takeaway_price=0 > price=100）', JSON.stringify(p315));
        const p316 = products.find((p) => p.product_id === 316);
        assert(!!p316 && p316.name === '原始名稱', '3.7-eligibility line_name 為純空白時視為未設定，顯示名稱 fallback 回 name', JSON.stringify(p316));

        // 3.7-price-parity：公開顯示價格與 popup checkout 實際落單金額必須一致
        // （兩者共用同一個 resolvePopupProductSSOT()，不是分別維護兩套規則）。
        const checkoutR = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Parity', customer_phone: '0933333333', payment_method: 'cash', items: [{ product_id: 315, qty: 1 }] },
        });
        assert(checkoutR.status === 201 && checkoutR.json.data.total === p315.price, '3.7-price-parity 公開顯示價格與結帳落單金額一致（line_price 優先序商品）', JSON.stringify({ displayed: p315.price, charged: checkoutR.json.data && checkoutR.json.data.total }));
      } finally {
        // 精確還原：只刪除本測試自己新增的商品（id 310~317），不影響其他
        // 測試區塊或 demo seed 資料。
        db._db.run('DELETE FROM products WHERE id IN (310,311,312,313,314,315,316)');
        db._save();
      }
    }
    {
      // 未開放外帶的商品即使存在，也不得下單
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0911111111', items: [{ product_id: 303, qty: 1 }] },
      });
      assert(r.status === 409 && r.json.error === 'POPUP_PRODUCT_NOT_AVAILABLE', '3-product-not-takeout line_takeout_enabled=0 的商品回 409', JSON.stringify(r));
    }
    {
      // 跨店商品不得用於下單
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0911111112', items: [{ product_id: 401, qty: 1 }] },
      });
      assert(r.status === 400, '3-cross-store-product store_002 的 product_id 不得用於 store_001 的快閃訂單', JSON.stringify(r));
    }
    {
      // 不允許外帶的付款方式
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0911111113', payment_method: 'delivery_only', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r.status === 400 && r.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '3-payment-not-allowed 不支援外帶的付款方式回 400', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 四、selected scope：quota 足夠成功、quota 用盡回 409、原子扣減
    // ══════════════════════════════════════════════════════════════
    const sessSelected = await makeSession(camp.id, loc.id, {
      product_scope: 'selected', products: [{ product_id: 301, quota_qty: 3 }, { product_id: 302, quota_qty: 0 }],
    });
    {
      const r1 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'A', customer_phone: '0922222221', items: [{ product_id: 301, qty: 2 }] },
      });
      assert(r1.status === 201, '4-quota 第一筆訂單（用掉 2/3）成功', JSON.stringify(r1));

      const r2 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'B', customer_phone: '0922222222', items: [{ product_id: 301, qty: 2 }] },
      });
      assert(r2.status === 409 && r2.json.error === 'POPUP_PRODUCT_SOLD_OUT', '4-quota 第二筆訂單超過剩餘份數（剩 1，要 2），回 409 SOLD_OUT', JSON.stringify(r2));

      const r3 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'C', customer_phone: '0922222223', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r3.status === 201, '4-quota 剛好用完剩餘 1 份的訂單成功', JSON.stringify(r3));

      const totalAllocated = db.get(
        "SELECT COALESCE(SUM(qty),0) as q FROM popup_order_allocations WHERE session_id=? AND product_id=301 AND status='active'",
        [sessSelected.id]
      ).q;
      assert(totalAllocated === 3, '4-quota 場次商品 301 已扣總量恰好等於 quota_qty=3（不會超賣）', String(totalAllocated));

      const r4 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'D', customer_phone: '0922222224', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r4.status === 409, '4-quota 額滿後再下單同商品回 409', JSON.stringify(r4));
    }
    {
      // quota_qty=0 代表不限量
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'E', customer_phone: '0922222225', items: [{ product_id: 302, qty: 999 }] },
      });
      assert(r.status === 201, '4-quota quota_qty=0（不限量）大量下單仍成功', JSON.stringify(r));
    }
    {
      // 場次白名單外的商品不得下單（selected scope）
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessSelected.public_code, customer_name: 'F', customer_phone: '0922222226', items: [{ product_id: 303, qty: 1 }] },
      });
      assert(r.status === 409, '4-not-in-whitelist selected scope 中不在白名單的商品回 409', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 五、場次狀態不可下單時的拒絕（不回退成一般門市取餐）
    //
    // Phase 3A.3 Corrective Audit 修正：draft session／draft parent
    // campaign 這兩種情境，checkout 之前誤把「409 POPUP_SESSION_NOT_
    // ORDERABLE + state=draft」當成正確行為——這其實是一種存在性洩漏
    // （等於告訴呼叫端「這個 code 其實是真的，只是還沒發布」）。移除舊的
    // 「409+state=draft 視為 PASS」assertion，改成跟「code 根本不存在」
    // 逐位元組相同的 404 POPUP_SESSION_NOT_FOUND；已公開後的其他非可訂
    // 狀態（paused/cancelled/archived）維持既有的明確 409 狀態契約，不受
    // 這次修正影響。
    // ══════════════════════════════════════════════════════════════
    {
      // draft session（campaign 本身是 published，只有 session 自己是
      // draft）：GET 與 checkout 都必須視為「找不到」，且回應必須跟
      // 「code 根本不存在」逐位元組相同。
      const draftSession = await makeSession(camp.id, loc.id, { status: 'draft', name: 'DraftSess' });
      const beforeOrders5a = db.get('SELECT COUNT(*) as c FROM orders').c;

      const rNonexistent = await call('GET', '/api/line-orders/popup-session/definitely-does-not-exist-5a');
      const rGet = await call('GET', `/api/line-orders/popup-session/${draftSession.public_code}`);
      assert(rGet.status === 404 && rGet.json.error === 'POPUP_SESSION_NOT_FOUND', '5-draft-session GET /popup-session：draft 場次回 404 POPUP_SESSION_NOT_FOUND（不洩漏存在性）', JSON.stringify(rGet));
      assert(JSON.stringify(rGet.json) === JSON.stringify(rNonexistent.json) && rGet.status === rNonexistent.status, '5-draft-session GET 回應與 code 不存在逐位元組相同', JSON.stringify({ draft: rGet.json, nonexistent: rNonexistent.json }));

      const rCheckout = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: draftSession.public_code, customer_name: 'X', customer_phone: '0933333331', items: [{ product_id: 301, qty: 1 }] },
      });
      const rCheckoutNonexistent = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: 'definitely-does-not-exist-5a-checkout', customer_name: 'X', customer_phone: '0933333331', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rCheckout.status === 404 && rCheckout.json.error === 'POPUP_SESSION_NOT_FOUND', '5-draft-session checkout：draft 場次回 404 POPUP_SESSION_NOT_FOUND（不再是 409+state=draft 的洩漏）', JSON.stringify(rCheckout));
      assert(JSON.stringify(rCheckout.json) === JSON.stringify(rCheckoutNonexistent.json) && rCheckout.status === rCheckoutNonexistent.status, '5-draft-session checkout 回應與 code 不存在逐位元組相同', JSON.stringify({ draft: rCheckout.json, nonexistent: rCheckoutNonexistent.json }));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders5a, '5-draft-session checkout 沒有建立任何訂單', '');
      const allocCount5a = db.get('SELECT COUNT(*) as c FROM popup_order_allocations WHERE session_id=?', [draftSession.id]).c;
      assert(allocCount5a === 0, '5-draft-session checkout 沒有建立任何 allocation', String(allocCount5a));
    }
    {
      const cancelledSession = await makeSession(camp.id, loc.id, { name: 'CancelSess' });
      await call('PATCH', `/api/popup-pickup/sessions/${cancelledSession.id}`, { token: T1, body: { expected_revision: cancelledSession.revision, status: 'cancelled' } });
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: cancelledSession.public_code, customer_name: 'X', customer_phone: '0933333332', items: [{ product_id: 301, qty: 1 }] },
      });
      // paused/cancelled/archived 是「已公開後」的非可訂狀態，維持既有明確
      // 409 state 契約（跟 draft 的「還沒公開」語意不同，不受本次修正影響）。
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_NOT_ORDERABLE' && r.json.state === 'cancelled', '5-not-orderable 已取消場次不可下單，維持既有明確 409 狀態契約', JSON.stringify(r));
    }
    {
      // draft parent campaign（session 本身是 published，但活動還沒發布）：
      // 公開 GET /popup-session／checkout 都必須視為「找不到」，不得洩漏
      // 「session 存在，只是活動還沒公開」；checkout 的回應同樣必須跟
      // 「code 根本不存在」逐位元組相同（Phase 3A.3 修正）。
      const draftParentCamp = await makeCampaign('DraftParentCampaign', 'draft');
      const sessUnderDraftCamp = await makeSession(draftParentCamp.id, loc.id, { name: 'SessUnderDraftCamp' });
      const rGet = await call('GET', `/api/line-orders/popup-session/${sessUnderDraftCamp.public_code}`);
      assert(rGet.status === 404 && rGet.json.error === 'POPUP_SESSION_NOT_FOUND', '5-draft-parent-campaign GET /popup-session：session 本身 published 但 parent campaign 是 draft，仍回 404（不洩漏存在性）', JSON.stringify(rGet));

      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const rCheckout = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessUnderDraftCamp.public_code, customer_name: 'X', customer_phone: '0933333333', items: [{ product_id: 301, qty: 1 }] },
      });
      const rCheckoutNonexistent = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: 'definitely-does-not-exist-5c-checkout', customer_name: 'X', customer_phone: '0933333333', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rCheckout.status === 404 && rCheckout.json.error === 'POPUP_SESSION_NOT_FOUND', '5-draft-parent-campaign checkout：回 404 POPUP_SESSION_NOT_FOUND（不再是 409+state=draft 的洩漏）', JSON.stringify(rCheckout));
      assert(JSON.stringify(rCheckout.json) === JSON.stringify(rCheckoutNonexistent.json) && rCheckout.status === rCheckoutNonexistent.status, '5-draft-parent-campaign checkout 回應與 code 不存在逐位元組相同', JSON.stringify({ draft: rCheckout.json, nonexistent: rCheckoutNonexistent.json }));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '5-draft-parent-campaign checkout 沒有建立訂單', '');
    }

    // ══════════════════════════════════════════════════════════════
    // 五.5（新增）：數值安全 overflow——all_takeout／selected 兩種 scope、
    // 零元商品、MAX_SAFE_INTEGER + MAX_SAFE_INTEGER 聚合溢位。
    // ══════════════════════════════════════════════════════════════
    {
      // all_takeout scope：重複商品列彙總後數量超出安全整數範圍。
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: {
          popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Overflow1', customer_phone: '0900066001',
          items: [{ product_id: 301, qty: Number.MAX_SAFE_INTEGER }, { product_id: 301, qty: Number.MAX_SAFE_INTEGER }],
        },
      });
      assert(r.status === 400, '5.5-overflow-all-takeout all_takeout scope：MAX_SAFE_INTEGER + MAX_SAFE_INTEGER 彙總溢位回 400', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '5.5-overflow-all-takeout 訂單未殘留', '');
      assert(db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs, '5.5-overflow-all-takeout allocation 未殘留', '');
    }
    {
      // selected scope：同樣的彙總溢位。
      const sessOverflowSel = await makeSession(camp.id, loc.id, { name: 'OverflowSelSess', product_scope: 'selected', products: [{ product_id: 301, quota_qty: 0 }] });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: {
          popup_session_public_code: sessOverflowSel.public_code, customer_name: 'Overflow2', customer_phone: '0900066002',
          items: [{ product_id: 301, qty: Number.MAX_SAFE_INTEGER }, { product_id: 301, qty: Number.MAX_SAFE_INTEGER }],
        },
      });
      assert(r.status === 400, '5.5-overflow-selected selected scope：MAX_SAFE_INTEGER + MAX_SAFE_INTEGER 彙總溢位回 400', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '5.5-overflow-selected 訂單未殘留', '');
    }
    {
      // 零元商品：金額是 0，但數量彙總溢位仍必須被檢查（不能因為金額 0 就跳過數量檢查）。
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES (707,'store_001','ZeroPriceProduct','主食',0,1,1,1)`);
      db._save();
      const sessZeroPrice = await makeSession(camp.id, loc.id, { name: 'ZeroPriceSess', product_scope: 'selected', products: [{ product_id: 707, quota_qty: 0 }] });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: {
          popup_session_public_code: sessZeroPrice.public_code, customer_name: 'Overflow3', customer_phone: '0900066003',
          items: [{ product_id: 707, qty: Number.MAX_SAFE_INTEGER }, { product_id: 707, qty: Number.MAX_SAFE_INTEGER }],
        },
      });
      assert(r.status === 400, '5.5-overflow-zero-price 零元商品的數量彙總溢位仍回 400（不會因為金額是 0 就跳過數量檢查）', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '5.5-overflow-zero-price 訂單未殘留', '');

      // 零元商品正常小量下單仍應成功（確認上面的拒絕是因為溢位，不是零元本身被誤判）。
      const rOk = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessZeroPrice.public_code, customer_name: 'ZeroOk', customer_phone: '0900066004', items: [{ product_id: 707, qty: 3 }] },
      });
      assert(rOk.status === 201 && rOk.json.data.total === 0, '5.5-overflow-zero-price 零元商品正常數量下單成功、total=0', JSON.stringify(rOk.json.data));
    }
    {
      // 單一 item 的 qty 本身就是 MAX_SAFE_INTEGER（未彙總前就已經在邊界），
      // price*qty 本身會超出安全範圍，應在單品檢查階段就被擋下。
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Overflow4', customer_phone: '0900066005', items: [{ product_id: 301, qty: Number.MAX_SAFE_INTEGER }] },
      });
      assert(r.status === 400, '5.5-overflow-single-line 單一品項 qty=MAX_SAFE_INTEGER（price*qty 超出安全範圍）回 400', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 六、max_orders 額滿保護
    // ══════════════════════════════════════════════════════════════
    {
      const capped = await makeSession(camp.id, loc.id, { name: 'CappedSess', max_orders: 1 });
      const r1 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: capped.public_code, customer_name: 'A', customer_phone: '0944444441', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r1.status === 201, '6-max-orders 第一筆訂單成功（上限 1）', JSON.stringify(r1));
      const r2 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: capped.public_code, customer_name: 'B', customer_phone: '0944444442', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r2.status === 409 && r2.json.error === 'POPUP_SESSION_FULL', '6-max-orders 第二筆訂單超過上限，回 409 SESSION_FULL', JSON.stringify(r2));
    }

    // ══════════════════════════════════════════════════════════════
    // 七、冪等釋放：取消／作廢訂單會釋放份數，重複操作不會扣成負數
    // ══════════════════════════════════════════════════════════════
    {
      const relSess = await makeSession(camp.id, loc.id, {
        product_scope: 'selected', name: 'ReleaseSess', products: [{ product_id: 301, quota_qty: 1 }],
      });
      const rOrder = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: relSess.public_code, customer_name: 'A', customer_phone: '0955555551', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rOrder.status === 201, '7-release 場次已滿前先成功建立 1 筆訂單（quota=1）', JSON.stringify(rOrder));
      const orderId = rOrder.json.data.id;

      const rFull = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: relSess.public_code, customer_name: 'B', customer_phone: '0955555552', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rFull.status === 409, '7-release 額滿後第二筆訂單被拒絕（測試前提成立）', JSON.stringify(rFull));

      // 透過統一狀態機取消訂單（applyOrderStatusChange，同 online-orders.js／
      // line-orders.js 共用路徑），驗證份數確實被釋放。
      const { applyOrderStatusChange } = require('../utils/orderStatusFlow');
      const orderRow = db.get('SELECT * FROM orders WHERE id=?', [orderId]);
      const cancelResult = applyOrderStatusChange(db, 'store_001', orderRow, 'cancelled');
      assert(cancelResult.ok, '7-release applyOrderStatusChange 取消訂單成功', JSON.stringify(cancelResult));

      const allocAfterCancel = db.get("SELECT status FROM popup_order_allocations WHERE order_id=?", [orderId]);
      assert(allocAfterCancel.status === 'released', '7-release 取消後 allocation 狀態變成 released', JSON.stringify(allocAfterCancel));

      // 份數釋放後，原本被擋下的訂單現在應該可以成功。
      const rRetry = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: relSess.public_code, customer_name: 'C', customer_phone: '0955555553', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rRetry.status === 201, '7-release 釋放份數後，新訂單可以成功搶到這個名額', JSON.stringify(rRetry));

      // 冪等：對同一張已取消訂單重複呼叫取消，不會產生第二次釋放、不會扣成負數。
      const orderRowAfter = db.get('SELECT * FROM orders WHERE id=?', [orderId]);
      const cancelAgain = applyOrderStatusChange(db, 'store_001', orderRowAfter, 'cancelled');
      assert(cancelAgain.ok === false, '7-release-idempotent 已取消訂單無法重複取消（isCancellable 擋下，不會產生二次副作用）', JSON.stringify(cancelAgain));

      const { releasePopupOrderAllocations } = require('../utils/popupCheckout');
      const directRelease1 = releasePopupOrderAllocations(db, 'store_001', orderId, relSess.id);
      db._save();
      assert(directRelease1 === 0, '7-release-idempotent 直接呼叫 releasePopupOrderAllocations() 對已釋放的 allocation 再次呼叫，0 rows affected（不會重複釋放）', String(directRelease1));
    }

    // ══════════════════════════════════════════════════════════════
    // 八、真正的 fault-injection：訂單 INSERT 成功、allocation INSERT 失敗
    //     時，整筆 transaction 必須 rollback（訂單也不會殘留）。
    // ══════════════════════════════════════════════════════════════
    {
      const faultSess = await makeSession(camp.id, loc.id, { name: 'FaultSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;

      const originalRun = db._db.run.bind(db._db);
      db._db.run = (...args) => {
        if (String(args[0]).includes('INSERT INTO popup_order_allocations')) {
          throw new Error('INJECTED FAILURE: allocation insert forced to fail');
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('POST', '/api/line-orders/popup-checkout', {
          query: { store_id: 'store_001' },
          body: { popup_session_public_code: faultSess.public_code, customer_name: 'X', customer_phone: '0966666661', items: [{ product_id: 301, qty: 1 }] },
        });
      } finally {
        db._db.run = originalRun;
      }
      assert(r.status === 500 && r.json.error === 'POPUP_INTERNAL_ERROR', '8-fault-injection allocation INSERT 被強制拋錯，API 回 500', JSON.stringify(r));
      const afterOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const afterAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      assert(afterOrders === beforeOrders, '8-fault-injection 訂單也被 ROLLBACK（未殘留「訂單成立但份數沒扣到」的不一致狀態）', `before=${beforeOrders} after=${afterOrders}`);
      assert(afterAllocs === beforeAllocs, '8-fault-injection allocation 筆數不變', `before=${beforeAllocs} after=${afterAllocs}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 九（新增）：selected scope 白名單內但 enabled=0 的商品必須拒絕
    // ══════════════════════════════════════════════════════════════
    {
      const sessDisabledProduct = await makeSession(camp.id, loc.id, {
        product_scope: 'selected', name: 'DisabledProductSess', products: [{ product_id: 301, quota_qty: 5, enabled: false }],
      });
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessDisabledProduct.public_code, customer_name: 'X', customer_phone: '0977777771', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r.status === 409 && r.json.error === 'POPUP_PRODUCT_NOT_IN_SESSION', '9-disabled-in-session 白名單內但 enabled=false 的商品回 409（視同不在白名單）', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 十（新增）：付款方式——停用／跨店
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES ('store_001','已停用','inactive_pm',0,1)`);
      db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES ('store_002','跨店付款','cross_store_pm',1,1)`);
      db._save();
      const r1 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0988888881', payment_method: 'inactive_pm', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r1.status === 400 && r1.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10-payment-inactive 停用的付款方式回 400', JSON.stringify(r1));
      const r2 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0988888882', payment_method: 'cross_store_pm', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r2.status === 400 && r2.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10-payment-cross-store store_002 的付款方式代碼不得用於 store_001 的快閃訂單', JSON.stringify(r2));
      const r3 = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'X', customer_phone: '0988888883', payment_method: 'not-a-real-code', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r3.status === 400, '10-payment-nonexistent 不存在的付款方式代碼回 400', JSON.stringify(r3));
    }

    // ══════════════════════════════════════════════════════════════
    // 十.5（新增）：payment_method 嚴格型別驗證——只有 omitted 才預設 cash，
    // null/空字串/純空白/數字/陣列/物件一律 400（不得被寬鬆地當成「沒送」）。
    // ══════════════════════════════════════════════════════════════
    {
      // omitted（完全不送這個 key）→ 正常走完整驗證後預設 cash，成功。
      const rOmitted = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Omit', customer_phone: '0900011122', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rOmitted.status === 201 && rOmitted.json.data !== undefined, '10.5-payment-omitted 完全省略 payment_method 時，正規化為 cash 並成功結帳', JSON.stringify(rOmitted));
      const orderRow = db.get('SELECT payment_method FROM orders WHERE id=?', [rOmitted.json.data.id]);
      assert(orderRow.payment_method === 'cash', '10.5-payment-omitted 訂單實際存的付款方式確實是 cash（不是跳過驗證的別的值）', JSON.stringify(orderRow));

      const badValues = [null, '', '   ', 123, [], {}, true, false];
      for (const bad of badValues) {
        const r = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Bad', customer_phone: '0900011123', payment_method: bad, items: [{ product_id: 301, qty: 1 }] },
        });
        assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', `10.5-payment-strict-type payment_method=${JSON.stringify(bad)}（非 omitted）一律 400`, JSON.stringify(r));
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 十.6（新增）：LINE Pay 明確拒絕（409 NOT_READY，不建立 order/allocation）
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout, gateway_code) VALUES ('store_001','LINE Pay','linepay_direct',1,1,'linepay_gateway')`);
      db._save();
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;

      // 情境 A：payment_method 代碼本身字面上就叫 linepay。
      const rCodeIsLinepay = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'LP1', customer_phone: '0900011124', payment_method: 'linepay', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rCodeIsLinepay.status === 409 && rCodeIsLinepay.json.error === 'POPUP_PAYMENT_METHOD_NOT_READY', '10.6-linepay-code-literal payment_method="linepay" 回 409 NOT_READY', JSON.stringify(rCodeIsLinepay));

      // 情境 B：代碼不叫 linepay，但 gateway_code 指向 LINE Pay。
      const rGatewayIsLinepay = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'LP2', customer_phone: '0900011125', payment_method: 'linepay_direct', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rGatewayIsLinepay.status === 409 && rGatewayIsLinepay.json.error === 'POPUP_PAYMENT_METHOD_NOT_READY', '10.6-linepay-gateway gateway_code 指向 LINE Pay 也回 409 NOT_READY', JSON.stringify(rGatewayIsLinepay));

      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '10.6-linepay-no-order 兩種 LINE Pay 情境都沒有建立任何訂單', '');
      assert(db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs, '10.6-linepay-no-allocation 兩種 LINE Pay 情境都沒有佔用任何 allocation', '');
    }

    // ══════════════════════════════════════════════════════════════
    // 十.7 ＋ 十.7.2（Phase 3A.4 修正）：settings.takeout_payment_methods／
    // legacy line_payment_* fallback，改成用真實 HTTP 呼叫 GET /shop 與
    // popup checkout 兩者，逐項比對兩邊是否真的共用同一份語意（不是各自
    // 宣稱一致，而是用同一組 fixture 狀態各打一次真實請求驗證）；同時涵蓋
    // credit_card ↔ card canonical mapping。
    //
    // 語意（`utils/linePaymentMethods.js` 的 `resolveLineChannelPaymentCodes()`，
    // GET /shop（`routes/line-orders.js` 的 `getModePaymentMethods()`）與
    // popup checkout（`utils/popupCheckout.js` 的
    // `resolveLineTakeoutAllowedPaymentCodes()`）現在都只是這一個函式的薄
    // 包裝，不是兩份各自維護、可能漂移的規則）：
    //   1. 合法「非空陣列」→ 直接使用，視為權威。
    //   2. 空陣列 []／空值／無設定／非法 JSON → fallback legacy 個別開關。
    //   3. legacy 全部關閉（或都沒設定）→ 回空陣列，GET /shop 顯示不出任何
    //      付款按鈕，popup 同樣拒絕付款——不存在「回傳 null 代表沒有限制、
    //      只驗 payment_methods 表」這條路徑。
    //
    // Phase 3A.4 修正 fixture 還原方式：不再假設任何「目前認為的 seeded
    // defaults」——測試開始前先如實查詢並保存每一個會被本區塊改動的
    // settings row（存在與否＋原始值）與 payment_methods row（transfer／
    // platform／card 三個 code），最後在唯一一個 finally 裡精確還原：
    // 原本存在的 row 還原成原始值，原本不存在的 row（例如某個 legacy key
    // 從未被設定過）直接刪除，不留下測試新增的殘留列。這樣不管這個測試
    // 檔案之後怎麼調整執行順序、或未來的 initDb() 種子資料變動，都不會因
    // 為「猜錯預設值」而讓本區塊或後面的區塊連帶壞掉。
    // ══════════════════════════════════════════════════════════════
    function snapshotSettingRow(key) {
      const row = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key=?", [key]);
      return row ? { existed: true, value: row.value } : { existed: false };
    }
    function restoreSettingRow(key, snap) {
      if (snap.existed) {
        db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', ?, ?)", [key, snap.value]);
      } else {
        db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key=?", [key]);
      }
    }
    function snapshotPaymentMethodRow(code) {
      return db.get("SELECT id, store_id, is_active, enable_for_takeout, gateway_code FROM payment_methods WHERE store_id='store_001' AND code=?", [code]);
    }
    function restorePaymentMethodRow(snap) {
      if (!snap) return; // 這個 code 原本就不存在，沒有東西需要還原
      db._db.run('UPDATE payment_methods SET store_id=?, is_active=?, enable_for_takeout=?, gateway_code=? WHERE id=?', [snap.store_id, snap.is_active, snap.enable_for_takeout, snap.gateway_code, snap.id]);
    }

    const PAYMENT_SETTING_KEYS_107 = [
      'takeout_payment_methods',
      'line_payment_cash_enabled', 'line_payment_linepay_enabled', 'line_payment_transfer_enabled',
      'line_payment_platform_enabled', 'line_payment_credit_card_enabled',
    ];
    const settingSnapshots107 = {};
    PAYMENT_SETTING_KEYS_107.forEach((k) => { settingSnapshots107[k] = snapshotSettingRow(k); });
    const transferRowSnapshot107 = snapshotPaymentMethodRow('transfer');
    const platformRowSnapshot107 = snapshotPaymentMethodRow('platform');
    const cardRowSnapshot107 = snapshotPaymentMethodRow('card');

    function restoreAllPaymentFixtures107() {
      PAYMENT_SETTING_KEYS_107.forEach((k) => restoreSettingRow(k, settingSnapshots107[k]));
      restorePaymentMethodRow(transferRowSnapshot107);
      restorePaymentMethodRow(platformRowSnapshot107);
      restorePaymentMethodRow(cardRowSnapshot107);
      db._save();
    }

    // 這兩個是「測試案例之間」用的臨時清空/設定 helper（不是最終還原）——
    // 每次呼叫後緊接著就會明確設定下一個案例需要的狀態，所以中途暫時清空
    // 不影響正確性；本區塊結束時唯一權威的還原動作是上面的
    // restoreAllPaymentFixtures107()，不依賴這兩個 helper 清空後留下的值。
    function clearAllLineLevelPaymentSettings() {
      PAYMENT_SETTING_KEYS_107.forEach((k) => db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key=?", [k]));
      db._save();
    }
    function setLegacyFlags(overrides) {
      const all = { line_payment_cash_enabled: '0', line_payment_linepay_enabled: '0', line_payment_transfer_enabled: '0', line_payment_platform_enabled: '0', line_payment_credit_card_enabled: '0', ...overrides };
      Object.entries(all).forEach(([k, v]) => db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', ?, ?)", [k, v]));
      db._save();
    }
    async function getShopPaymentMethods() {
      const r = await call('GET', '/api/line-orders/shop', { query: { store_id: 'store_001' } });
      return { status: r.status, methods: r.json && r.json.data ? r.json.data.takeout_payment_methods : undefined };
    }
    // Phase 3B 補強：popup public 的 payment_methods 欄位平行查詢 helper，
    // 跟 getShopPaymentMethods() 用同一個 session（sessAllTakeout），確保
    // 每個既有 10.7/10.7.2 情境都能同時驗證「GET /shop、popup checkout、
    // popup public GET session」三邊真的共用同一份規則，不是碰巧一致。
    async function getPublicPopupPaymentMethods() {
      const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
      return { status: r.status, methods: r.json && r.json.data ? r.json.data.payment_methods : undefined };
    }

    try {
      // 'transfer' 是 utils/db.js 既有的預設 seed 付款方式，預設 is_active=0
      // （店家要自己去後台開通）；這裡用 UPDATE（而非 INSERT OR IGNORE，那樣
      // 遇到已存在的 seed 資料會被忽略、拿不到我們要的 is_active=1）確保這
      // 個測試情境下 'transfer' 在 payment_methods 表本身是啟用狀態。
      db._db.run(`UPDATE payment_methods SET is_active=1, enable_for_takeout=1 WHERE store_id='store_001' AND code='transfer'`);
      db._save();

      // 案例 A：非空陣列 ["cash"] → GET /shop 回 ["cash"]；popup 允許
      // cash、拒絕 transfer（即使 payment_methods 表本身啟用）。
      clearAllLineLevelPaymentSettings();
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify(['cash'])]);
      db._save();
      const shopA = await getShopPaymentMethods();
      assert(shopA.status === 200 && JSON.stringify(shopA.methods) === JSON.stringify(['cash']), '10.7-A-shop-explicit-array GET /shop：takeout_payment_methods=["cash"] 時，data.takeout_payment_methods 就是 ["cash"]', JSON.stringify(shopA));
      const pubA = await getPublicPopupPaymentMethods();
      assert(pubA.status === 200 && JSON.stringify(pubA.methods) === JSON.stringify(['cash']), '10.7-A-popup-public-parity popup public GET session 的 payment_methods 跟 GET /shop 一致，都是 ["cash"]', JSON.stringify(pubA));
      const rBlockedByLineSetting = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPM1', customer_phone: '0900011126', payment_method: 'transfer', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rBlockedByLineSetting.status === 400 && rBlockedByLineSetting.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7-A-popup-restricts takeout_payment_methods=["cash"] 時，transfer 即使表本身啟用也被 LINE 設定擋下（與 GET /shop 一致）', JSON.stringify(rBlockedByLineSetting));
      const rAllowedByLineSetting = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPM2', customer_phone: '0900011127', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rAllowedByLineSetting.status === 201, '10.7-A-popup-allows takeout_payment_methods=["cash"] 時，cash 正常通過（與 GET /shop 一致）', JSON.stringify(rAllowedByLineSetting));
      clearAllLineLevelPaymentSettings();

      // 案例 B：[] + legacy 只開 cash=1 → GET /shop 回 ["cash"]（fallback
      // 到 legacy，不是「[] 代表禁止全部」）；popup cash 成功。
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify([])]);
      setLegacyFlags({ line_payment_cash_enabled: '1' });
      const shopB = await getShopPaymentMethods();
      assert(shopB.status === 200 && JSON.stringify(shopB.methods) === JSON.stringify(['cash']), '10.7-B-shop-empty-array-fallback-cash GET /shop：takeout_payment_methods=[] + legacy cash=1 時，data.takeout_payment_methods 是 ["cash"]（fallback 到 legacy，不是空陣列）', JSON.stringify(shopB));
      const pubB = await getPublicPopupPaymentMethods();
      assert(pubB.status === 200 && JSON.stringify(pubB.methods) === JSON.stringify(['cash']), '10.7-B-popup-public-parity popup public 同樣 fallback 到 legacy，payment_methods 是 ["cash"]', JSON.stringify(pubB));
      const rB = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPMB', customer_phone: '0900011200', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rB.status === 201, '10.7-B-popup-empty-array-fallback-cash takeout_payment_methods=[] + legacy cash=1 時，popup cash 結帳成功（與 GET /shop 一致，都是 fallback 到 legacy）', JSON.stringify(rB));
      clearAllLineLevelPaymentSettings();

      // 案例 C：[] + legacy 全部關閉 → GET /shop 回 []；popup cash 400。
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify([])]);
      setLegacyFlags({});
      const shopC = await getShopPaymentMethods();
      assert(shopC.status === 200 && Array.isArray(shopC.methods) && shopC.methods.length === 0, '10.7-C-shop-empty-array-legacy-all-off GET /shop：takeout_payment_methods=[] + legacy 全部 0 時，data.takeout_payment_methods 是空陣列', JSON.stringify(shopC));
      const pubC = await getPublicPopupPaymentMethods();
      assert(pubC.status === 200 && Array.isArray(pubC.methods) && pubC.methods.length === 0, '10.7-C-popup-public-parity legacy 全部關閉時，popup public payment_methods 同樣是空陣列（不允許任何付款方式）', JSON.stringify(pubC));
      const rC = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPMC', customer_phone: '0900011201', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rC.status === 400 && rC.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7-C-popup-empty-array-legacy-all-off takeout_payment_methods=[] + legacy 全部 0 時，popup cash 被拒絕（與 GET /shop 一致，都是空陣列＝不允許任何方式）', JSON.stringify(rC));
      clearAllLineLevelPaymentSettings();

      // 案例 D：完全沒有 takeout_payment_methods 這個 key（不是 []，是
      // 整個 row 都不存在）＋ legacy 只開 transfer=1 → GET /shop 回
      // ["transfer"]；popup 允許 transfer、拒絕 cash。
      setLegacyFlags({ line_payment_transfer_enabled: '1' });
      const shopD = await getShopPaymentMethods();
      assert(shopD.status === 200 && JSON.stringify(shopD.methods) === JSON.stringify(['transfer']), '10.7-D-shop-no-key-legacy-fallback GET /shop：完全沒有 takeout_payment_methods 這個 key、legacy 只開 transfer=1 時，data.takeout_payment_methods 是 ["transfer"]', JSON.stringify(shopD));
      const pubD = await getPublicPopupPaymentMethods();
      assert(pubD.status === 200 && JSON.stringify(pubD.methods) === JSON.stringify(['transfer']), '10.7-D-popup-public-parity 完全沒有 takeout_payment_methods key 時，popup public 同樣 fallback 到 legacy transfer=1，payment_methods 是 ["transfer"]', JSON.stringify(pubD));
      const rLegacyBlocksCash = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPM3', customer_phone: '0900011128', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rLegacyBlocksCash.status === 400 && rLegacyBlocksCash.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7-D-popup-legacy-fallback-blocks 完全沒有 takeout_payment_methods 這個 key 時，legacy line_payment_cash_enabled=0 使 cash 被擋下（與 GET /shop 一致）', JSON.stringify(rLegacyBlocksCash));
      const rLegacyAllowsTransfer = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPM4', customer_phone: '0900011129', payment_method: 'transfer', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rLegacyAllowsTransfer.status === 201, '10.7-D-popup-legacy-fallback-allows legacy line_payment_transfer_enabled=1 時，transfer 正常通過（與 GET /shop 一致）', JSON.stringify(rLegacyAllowsTransfer));
      clearAllLineLevelPaymentSettings();

      // 案例 E：takeout_payment_methods 是非法 JSON（例如截斷的字串）＋
      // legacy 只開 platform=1 → GET /shop 回 ["platform"]（fallback，不
      // 因為壞資料而整個炸掉或誤判成權威空清單）；popup 允許 platform、
      // 拒絕 cash。
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", ['{not-valid-json']);
      setLegacyFlags({ line_payment_platform_enabled: '1' });
      db._db.run(`UPDATE payment_methods SET is_active=1, enable_for_takeout=1 WHERE store_id='store_001' AND code='platform'`);
      db._save();
      const shopE = await getShopPaymentMethods();
      assert(shopE.status === 200 && JSON.stringify(shopE.methods) === JSON.stringify(['platform']), '10.7-E-shop-invalid-json-fallback GET /shop：takeout_payment_methods 是非法 JSON、legacy 只開 platform=1 時，data.takeout_payment_methods 是 ["platform"]（fallback，不因壞資料而炸掉）', JSON.stringify(shopE));
      const pubE = await getPublicPopupPaymentMethods();
      assert(pubE.status === 200 && JSON.stringify(pubE.methods) === JSON.stringify(['platform']), '10.7-E-popup-public-parity 非法 JSON 時，popup public 同樣不因壞資料而炸掉、正確 fallback 到 legacy platform=1', JSON.stringify(pubE));
      const rEBlockCash = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPME1', customer_phone: '0900011202', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rEBlockCash.status === 400 && rEBlockCash.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7-E-popup-invalid-json-blocks-cash 非法 JSON + legacy 只開 platform=1 時，popup cash 被擋下（與 GET /shop 一致）', JSON.stringify(rEBlockCash));
      const rEAllowPlatform = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'TPME2', customer_phone: '0900011203', payment_method: 'platform', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(rEAllowPlatform.status === 201, '10.7-E-popup-invalid-json-allows-platform 非法 JSON + legacy 只開 platform=1 時，popup platform 結帳成功（與 GET /shop 一致）', JSON.stringify(rEAllowPlatform));
      clearAllLineLevelPaymentSettings();

      // ══════════════════════════════════════════════════════════════
      // 十.7.2：credit_card ↔ card canonical mapping。
      //
      // 三層契約，不可混用：
      //   - API request／LINE settings 的 code：credit_card（canonical 對外）
      //   - payment_methods 資料表查詢用的 code：card（資料表既有 seed）
      //   - orders.payment_method 落地值：credit_card（跟對外代碼一致）
      // ══════════════════════════════════════════════════════════════
      const pmRowsCardOrCreditCard = db.all("SELECT id, code, store_id, is_active, enable_for_takeout, gateway_code FROM payment_methods WHERE code IN ('card','credit_card')");
      const creditCardTableRows = pmRowsCardOrCreditCard.filter((r) => r.code === 'credit_card');
      assert(creditCardTableRows.length === 0, '10.7.2-0-no-credit-card-in-table payment_methods 資料表本身不存在 code=credit_card 的列（canonical 對外代碼只用在 API/LINE settings/order 欄位，不會出現在這張表）', JSON.stringify(creditCardTableRows));

      const store1CardRows = pmRowsCardOrCreditCard.filter((r) => r.store_id === 'store_001' && r.code === 'card');
      assert(store1CardRows.length === 1, '10.7.2-0-seed-exists payment_methods 表對 store_001 恰好有一列既有 seed code=card（來自 initDb 啟動時的自動 backfill，不是測試臨時插入的）', JSON.stringify(pmRowsCardOrCreditCard));
      const originalCardRow = store1CardRows[0];

      function updateCardRow(fields) {
        const setSql = Object.keys(fields).map((k) => `${k}=?`).join(', ');
        const params = [...Object.keys(fields).map((k) => fields[k]), originalCardRow.id];
        db._db.run(`UPDATE payment_methods SET ${setSql} WHERE id=?`, params);
        const changes = db._db.getRowsModified();
        db._save();
        assert(changes === 1, `10.7.2-fixture UPDATE payment_methods id=${originalCardRow.id} 剛好影響 1 列（fields=${JSON.stringify(fields)}）`, String(changes));
      }
      // 只在成功回應（201）時才讀 response.data/order 欄位；失敗回應一律
      // 只斷言 status/error，不得繼續讀取不存在的欄位（避免像上一版一樣
      // 在某個案例失敗後，後面的程式碼因為存取 undefined.id 而整支腳本
      // fatal crash，讓後面所有測試都沒有機會執行）。
      async function checkoutCreditCard(customerName, phone) {
        return call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: customerName, customer_phone: phone, payment_method: 'credit_card', items: [{ product_id: 301, qty: 1 }] },
        });
      }

      // 案例 1＋5：takeout_payment_methods=["credit_card"] + payment_methods.card
      // active=1/enable_for_takeout=1/非 LINE Pay gateway → 201；訂單實際
      // 保存的 payment_method 是對外代碼 credit_card；GET /shop 同一組
      // fixture 下也回報 ["credit_card"]（真實 HTTP parity）。
      clearAllLineLevelPaymentSettings();
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: '' });
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify(['credit_card'])]);
      db._save();
      const shop1 = await call('GET', '/api/line-orders/shop', { query: { store_id: 'store_001' } });
      assert(shop1.status === 200 && JSON.stringify(shop1.json.data.takeout_payment_methods) === JSON.stringify(['credit_card']), '10.7.2-1-shop-parity GET /shop：takeout_payment_methods=["credit_card"] 時，data.takeout_payment_methods 就是 ["credit_card"]', JSON.stringify(shop1.json && shop1.json.data && shop1.json.data.takeout_payment_methods));
      const pub1 = await getPublicPopupPaymentMethods();
      assert(pub1.status === 200 && JSON.stringify(pub1.methods) === JSON.stringify(['credit_card']), '10.7.2-1-popup-public-parity popup public payment_methods 是對外 canonical 代碼 ["credit_card"]，不是資料表內部代碼 "card"', JSON.stringify(pub1));
      const r1 = await checkoutCreditCard('CC1', '0900033001');
      assert(r1.status === 201, '10.7.2-1-new-array takeout_payment_methods=["credit_card"] + payment_methods.card active/takeout=1/非linepay gateway 時，credit_card 結帳成功（與 GET /shop 一致允許）', JSON.stringify(r1));
      if (r1.status === 201 && r1.json && r1.json.data && r1.json.data.id) {
        const orderRow1 = db.get('SELECT payment_method FROM orders WHERE id=?', [r1.json.data.id]);
        assert(orderRow1.payment_method === 'credit_card', '10.7.2-1b-stored-code 訂單實際保存的 payment_method 是對外代碼 credit_card，不是資料表內部代碼 card', JSON.stringify(orderRow1));
      }

      // 案例 3：explicit list（takeout_payment_methods）未含 credit_card
      // → 400 NOT_ALLOWED，即使 payment_methods.card 表本身仍是啟用的。
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify(['cash'])]);
      db._save();
      const r3 = await checkoutCreditCard('CC3', '0900033003');
      assert(r3.status === 400 && r3.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7.2-3-explicit-list-excludes takeout_payment_methods=["cash"]（未含 credit_card）時，credit_card 被 LINE 設定擋下，即使 payment_methods.card 表本身啟用', JSON.stringify(r3));
      const pub3 = await getPublicPopupPaymentMethods();
      assert(pub3.status === 200 && !pub3.methods.includes('credit_card'), '10.7.2-3-popup-public-parity takeout_payment_methods=["cash"] 時，popup public payment_methods 不含 credit_card（跟結帳被擋下一致）', JSON.stringify(pub3));
      assert(pub3.status === 200 && !pub3.methods.includes('card'), '10.7.2-3-no-internal-code popup public payment_methods 絕不含資料表內部代碼字面值 "card"', JSON.stringify(pub3));

      // 案例 4：只開 legacy line_payment_credit_card_enabled、沒有新版
      // takeout_payment_methods 陣列 → 201。
      clearAllLineLevelPaymentSettings();
      setLegacyFlags({ line_payment_credit_card_enabled: '1' });
      const r4 = await checkoutCreditCard('CC4', '0900033004');
      assert(r4.status === 201, '10.7.2-4-legacy-flag 只開 legacy line_payment_credit_card_enabled=1（其餘 legacy 關閉、無新版陣列）時，credit_card 結帳成功', JSON.stringify(r4));
      clearAllLineLevelPaymentSettings();

      // 案例 5：payment_methods.card is_active=0 → 400 NOT_ALLOWED（LINE
      // 層級無限制，純粹被資料表本身擋下）。
      updateCardRow({ store_id: 'store_001', is_active: 0, enable_for_takeout: 1, gateway_code: '' });
      const r5 = await checkoutCreditCard('CC5', '0900033005');
      assert(r5.status === 400 && r5.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7.2-5-card-inactive payment_methods.card is_active=0 時，credit_card 被拒絕', JSON.stringify(r5));
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: '' });

      // 案例 6：payment_methods.card enable_for_takeout=0 → 400 NOT_ALLOWED。
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 0, gateway_code: '' });
      const r6 = await checkoutCreditCard('CC6', '0900033006');
      assert(r6.status === 400 && r6.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7.2-6-card-not-for-takeout payment_methods.card enable_for_takeout=0 時，credit_card 被拒絕', JSON.stringify(r6));
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: '' });

      // 案例 7：card 這一列目前屬於別的 store（暫時把既有列的 store_id
      // 改成 store_002）→ store_001 結帳時完全查不到屬於自己的 card
      // 列，400 NOT_ALLOWED（驗證 WHERE store_id=? 真的有生效，不會跨店
      // 誤用別店的付款方式設定）。
      updateCardRow({ store_id: 'store_002', is_active: 1, enable_for_takeout: 1, gateway_code: '' });
      const r7 = await checkoutCreditCard('CC7', '0900033007');
      assert(r7.status === 400 && r7.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7.2-7-card-belongs-to-other-store card 列目前屬於 store_002 時，store_001 結帳查不到自己的 card 列，credit_card 被拒絕（不會跨店誤用）', JSON.stringify(r7));
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: '' });

      // 案例 8：request 直接送出資料表內部代碼 'card'（不是 canonical
      // 對外代碼 credit_card）→ 400。目前文件沒有明確訂立 'card' 為
      // 相容 alias，所以即使 payment_methods.card 表本身啟用，也不能
      // 因為字面上剛好相同就矇混通過。
      const r8 = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'CC8', customer_phone: '0900033008', payment_method: 'card', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r8.status === 400 && r8.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '10.7.2-8-internal-code-not-external request 直接送出資料表內部代碼 "card"（不是 credit_card）一律 400，不是文件明訂的相容 alias', JSON.stringify(r8));

      // 案例 9：request code 本身字面就是 linepay → 409 NOT_READY，且不
      // 建立 order/allocation（跟既有 10.6 節重複驗證一次，確保這一組
      // fixture 狀態下同樣成立）。
      const beforeOrders9 = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs9 = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r9 = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'CC9', customer_phone: '0900033009', payment_method: 'linepay', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r9.status === 409 && r9.json.error === 'POPUP_PAYMENT_METHOD_NOT_READY', '10.7.2-9-code-is-linepay payment_method="linepay" 回 409 NOT_READY', JSON.stringify(r9));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders9 && db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs9, '10.7.2-9-code-is-linepay 沒有建立 order/allocation', '');

      // 案例 10：request code 是 credit_card，但 card 這一列的 gateway_code
      // 指向 LINE Pay → 409 NOT_READY，且不建立 order/allocation。驗證
      // canonical mapping 不會讓 gateway_code 檢查被繞過（mapping 只是
      // 換了查表用的 code 字串，其餘檢查邏輯完全不變）。
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: 'linepay_gateway' });
      const beforeOrders10 = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs10 = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r10 = await checkoutCreditCard('CC10', '0900033010');
      assert(r10.status === 409 && r10.json.error === 'POPUP_PAYMENT_METHOD_NOT_READY', '10.7.2-10-mapped-row-gateway-is-linepay card 列的 gateway_code 指向 LINE Pay 時，credit_card（映射到 card 查表）同樣被 409 NOT_READY 擋下', JSON.stringify(r10));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders10 && db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs10, '10.7.2-10-mapped-row-gateway-is-linepay 沒有建立 order/allocation', '');
      const pub10 = await getPublicPopupPaymentMethods();
      assert(pub10.status === 200 && !pub10.methods.includes('credit_card'), '10.7.2-10-popup-public-parity card 列 gateway_code 指向 LINE Pay 時，popup public payment_methods 也不含 credit_card（顯示層跟結帳層同一份排除規則，不是分開維護）', JSON.stringify(pub10));
      updateCardRow({ store_id: 'store_001', is_active: 1, enable_for_takeout: 1, gateway_code: '' });

      // ══════════════════════════════════════════════════════════════
      // 十.7.3（Phase 3B 新增）：popup public payment_methods 專屬契約——
      // 案例 1~10 主要驗證跟既有 GET /shop／checkout 的 parity，這裡補上
      // 只有「公開顯示」這一層才需要單獨驗證的三件事：
      //   (a) code 本身字面是 linepay，即使 LINE 通路層級陣列與
      //       payment_methods 表兩層都明確允許，仍不可出現在公開清單。
      //   (b) 跨店 payment_methods row 不得影響彼此的公開清單。
      //   (c) 回傳值只是純字串陣列，不含 gateway_code/id/store_id 等內部
      //       欄位（不會洩漏 gateway/內部資料）。
      // ══════════════════════════════════════════════════════════════
      {
        // (a) linepay 即使兩層都放行，仍不可公開。
        clearAllLineLevelPaymentSettings();
        db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_payment_methods', ?)", [JSON.stringify(['cash', 'linepay'])]);
        db._db.run(`UPDATE payment_methods SET is_active=1, enable_for_takeout=1, gateway_code='linepay' WHERE store_id='store_001' AND code='linepay'`);
        db._save();
        const pubLinepay = await getPublicPopupPaymentMethods();
        assert(pubLinepay.status === 200 && Array.isArray(pubLinepay.methods) && pubLinepay.methods.includes('cash') && !pubLinepay.methods.includes('linepay'), '10.7.3-a-linepay-never-public LINE 通路陣列與 payment_methods 表兩層都允許 linepay 時，popup public payment_methods 仍然完全排除 linepay（cash 正常出現）', JSON.stringify(pubLinepay));
        // 即使被手動注入，checkout 仍必須獨立拒絕（不信任 GET 回傳結果）。
        const rLinepayInject = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessAllTakeout.public_code, customer_name: 'LPInject', customer_phone: '0900033011', payment_method: 'linepay', items: [{ product_id: 301, qty: 1 }] },
        });
        assert(rLinepayInject.status === 409 && rLinepayInject.json.error === 'POPUP_PAYMENT_METHOD_NOT_READY', '10.7.3-a-checkout-still-rejects 即使手動送出 linepay（不理會公開清單排除了它），checkout 仍獨立拒絕，不信任 GET 回傳結果', JSON.stringify(rLinepayInject));
        db._db.run(`UPDATE payment_methods SET is_active=0, enable_for_takeout=1, gateway_code='linepay' WHERE store_id='store_001' AND code='linepay'`);
        db._save();
        clearAllLineLevelPaymentSettings();

        // (b) 跨店 payment_methods row 不得互相影響。
        setLegacyFlags({ line_payment_cash_enabled: '1' });
        db._db.run(`UPDATE payment_methods SET is_active=1, enable_for_takeout=1 WHERE store_id='store_001' AND code='cash'`);
        db._db.run("INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES ('store_002', '刷卡', 'card', 1, 1)");
        db._db.run(`UPDATE payment_methods SET is_active=0, enable_for_takeout=0 WHERE store_id='store_002' AND code='cash'`);
        db._save();
        const pubCrossStore = await getPublicPopupPaymentMethods();
        assert(pubCrossStore.status === 200 && pubCrossStore.methods.includes('cash'), '10.7.3-b-cross-store-isolation store_002 把自己的 cash 停用，不影響 store_001 公開清單仍含 cash（各店 payment_methods 完全獨立）', JSON.stringify(pubCrossStore));

        // (c) 回傳值只是純字串陣列，不含任何物件/內部欄位。
        assert(pubCrossStore.methods.every((c) => typeof c === 'string'), '10.7.3-c-no-internal-leak payment_methods 陣列的每個元素都只是字串代碼，不是包含 gateway_code/id/store_id 的物件', JSON.stringify(pubCrossStore.methods));
        const rawSessionResp = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`);
        const rawStr = JSON.stringify(rawSessionResp.json);
        assert(!/gateway_code|license|store_id/i.test(rawStr), '10.7.3-c-no-internal-leak 整份公開場次回應不含 gateway_code／license／store_id 等內部欄位名稱', rawStr.slice(0, 300));
      }

    } finally {
      // 唯一權威的還原動作：把本區塊一開始如實 snapshot 下來的每一個
      // settings row／payment_methods row（transfer／platform／card）精確
      // 還原——原本存在的還原成原始值，原本不存在的直接刪除，不假設任何
      // 「seeded defaults」的猜測值。
      restoreAllPaymentFixtures107();
    }

    // ══════════════════════════════════════════════════════════════
    // 十.8（新增）：LINE /menu 與 popup 公開商品／結帳 parity contract test
    //
    // 用同一組商品資料矩陣，逐值比較 GET /menu 的 effective_line_price／
    // effective_line_name 與 popup 公開頁面商品／結帳訂單 item 的 price／
    // name——因為兩邊現在都呼叫 utils/lineProductPricing.js 的同一個
    // resolveLineProductPricing()，理論上永遠一致；這個測試是「證明」而
    // 不是「假設」。
    // ══════════════════════════════════════════════════════════════
    {
      async function getMenuProduct(productId) {
        const r = await call('GET', '/api/line-orders/menu', { query: { store_id: 'store_001' } });
        return r.json.data.products.find((p) => Number(p.id) === productId);
      }

      // 先建立商品矩陣，session 建立時才驗證得到它們存在。
      // 矩陣 1：line_price=0（依規則視為「未設定」，fallback 到下一順位）。
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, takeaway_price, line_price, enabled, show_on_line, line_takeout_enabled) VALUES (701,'store_001','Parity1',' 主食',100,80,0,1,1,1)`);
      // 矩陣 2：line_price=null、takeaway_price != price（驗證真的有用到 takeaway_price，不是只 fallback 到 price）。
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, takeaway_price, line_price, enabled, show_on_line, line_takeout_enabled) VALUES (702,'store_001','Parity2','主食',100,65,NULL,1,1,1)`);
      // 矩陣 3：line_name 為純空白字串（trim 後應視為未設定，fallback 用 name）。
      db._db.run(`INSERT INTO products (id, store_id, name, line_name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES (703,'store_001','Parity3','   ','主食',90,1,1,1)`);
      // 矩陣 4：line_name 為合法非空白字串，應該被採用。
      db._db.run(`INSERT INTO products (id, store_id, name, line_name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES (704,'store_001','Parity4','正式顯示名稱','主食',70,1,1,1)`);
      db._save();

      const sessParity = await makeSession(camp.id, loc.id, {
        name: 'ParitySess', product_scope: 'selected',
        products: [
          { product_id: 701, quota_qty: 0 }, { product_id: 702, quota_qty: 0 },
          { product_id: 703, quota_qty: 0 }, { product_id: 704, quota_qty: 0 },
        ],
      });

      for (const pid of [701, 702, 703, 704]) {
        const menuProduct = await getMenuProduct(pid);
        assert(!!menuProduct, `10.8-parity GET /menu 找得到商品 id=${pid}`, '');

        const rSession = await call('GET', `/api/line-orders/popup-session/${sessParity.public_code}`);
        const popupProduct = rSession.json.data.products.find((p) => p.product_id === pid);
        assert(!!popupProduct, `10.8-parity popup 公開場次商品列表找得到 product_id=${pid}`, JSON.stringify(rSession.json.data.products));

        assert(menuProduct.effective_line_price === popupProduct.price, `10.8-parity-price product_id=${pid}：GET /menu effective_line_price(${menuProduct.effective_line_price}) 與 popup 公開顯示 price(${popupProduct.price}) 一致`, JSON.stringify({ menu: menuProduct.effective_line_price, popup: popupProduct.price }));
        assert(menuProduct.effective_line_name === popupProduct.name, `10.8-parity-name product_id=${pid}：GET /menu effective_line_name(${menuProduct.effective_line_name}) 與 popup 公開顯示 name(${popupProduct.name}) 一致`, JSON.stringify({ menu: menuProduct.effective_line_name, popup: popupProduct.name }));

        const rCheckout = await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessParity.public_code, customer_name: 'Parity', customer_phone: '0900022' + String(pid).padStart(3, '0'), items: [{ product_id: pid, qty: 1 }] },
        });
        assert(rCheckout.status === 201, `10.8-parity-checkout product_id=${pid} 結帳成功`, JSON.stringify(rCheckout));
        assert(rCheckout.json.data.items[0].price === menuProduct.effective_line_price, `10.8-parity-checkout-price product_id=${pid}：checkout order item price(${rCheckout.json.data.items[0].price}) 與 GET /menu effective_line_price 一致`, JSON.stringify({ checkout: rCheckout.json.data.items[0].price, menu: menuProduct.effective_line_price }));
        assert(rCheckout.json.data.items[0].name === menuProduct.effective_line_name, `10.8-parity-checkout-name product_id=${pid}：checkout order item name 與 GET /menu effective_line_name 一致`, JSON.stringify({ checkout: rCheckout.json.data.items[0].name, menu: menuProduct.effective_line_name }));
      }

      // 明確數值驗證（不只是「兩邊一致」，還要「兩邊都對」）：
      const p701 = await getMenuProduct(701);
      assert(p701.effective_line_price === 80, '10.8-parity-value product_id=701：line_price=0 視為未設定，fallback 到 takeaway_price=80（不是 price=100）', String(p701.effective_line_price));
      const p702 = await getMenuProduct(702);
      assert(p702.effective_line_price === 65, '10.8-parity-value product_id=702：line_price=null，正確使用 takeaway_price=65（不是誤跳過 takeaway_price 直接用 price=100）', String(p702.effective_line_price));
      const p703 = await getMenuProduct(703);
      assert(p703.effective_line_name === 'Parity3', '10.8-parity-value product_id=703：line_name 為純空白字串，trim 後視為未設定，fallback 用 name', String(p703.effective_line_name));
      const p704 = await getMenuProduct(704);
      assert(p704.effective_line_name === '正式顯示名稱', '10.8-parity-value product_id=704：line_name 為合法字串，正確採用', String(p704.effective_line_name));

      // eligibility flag 各自停用：show_on_line=0 時，popup 場次商品列表應該
      // 直接濾掉這個商品（不顯示；quota=0 scope selected 情境下等同不可購買）。
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES (705,'store_001','ParityShowOffLine','主食',50,1,0,1)`);
      db._save();
      const sessParity2 = await makeSession(camp.id, loc.id, { name: 'ParityShowOffSess', product_scope: 'selected', products: [{ product_id: 705, quota_qty: 0 }] });
      const rSession2 = await call('GET', `/api/line-orders/popup-session/${sessParity2.public_code}`);
      const found705 = rSession2.json.data.products.find((p) => p.product_id === 705);
      assert(!found705, '10.8-parity-eligibility show_on_line=0 的商品不會出現在 popup 公開場次商品列表中', JSON.stringify(rSession2.json.data.products));
      const rCheckout705 = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessParity2.public_code, customer_name: 'X', customer_phone: '0900033000', items: [{ product_id: 705, qty: 1 }] },
      });
      assert(rCheckout705.status === 409, '10.8-parity-eligibility show_on_line=0 的商品也不得結帳成功', JSON.stringify(rCheckout705));
    }

    // 十.9（新增）：明確驗證指令要求的具體矩陣
    // line_price=null、takeaway_price=110、price=100 → 三端皆為 110。
    {
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, takeaway_price, line_price, enabled, show_on_line, line_takeout_enabled) VALUES (706,'store_001','ExactMatrix','主食',100,110,NULL,1,1,1)`);
      db._save();
      const sessExact = await makeSession(camp.id, loc.id, { name: 'ExactMatrixSess', product_scope: 'selected', products: [{ product_id: 706, quota_qty: 0 }] });
      const rMenu = await call('GET', '/api/line-orders/menu', { query: { store_id: 'store_001' } });
      const menuP = rMenu.json.data.products.find((p) => Number(p.id) === 706);
      assert(menuP.effective_line_price === 110, '10.9-exact-matrix GET /menu：line_price=null/takeaway_price=110/price=100 → 110', String(menuP.effective_line_price));
      const rSession = await call('GET', `/api/line-orders/popup-session/${sessExact.public_code}`);
      const popupP = rSession.json.data.products.find((p) => p.product_id === 706);
      assert(popupP.price === 110, '10.9-exact-matrix popup 公開顯示：同一矩陣 → 110', String(popupP.price));
      const rCheckout = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: sessExact.public_code, customer_name: 'Exact', customer_phone: '0900044000', items: [{ product_id: 706, qty: 1 }] },
      });
      assert(rCheckout.status === 201 && rCheckout.json.data.items[0].price === 110 && rCheckout.json.data.subtotal === 110 && rCheckout.json.data.total === 110, '10.9-exact-matrix popup 結帳：item price/subtotal/total 皆為 110', JSON.stringify(rCheckout.json.data));
    }


    // ══════════════════════════════════════════════════════════════
    // 十一：client 偽造價格與 snapshot 欄位完全無效
    // ══════════════════════════════════════════════════════════════
    {
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: {
          popup_session_public_code: sessAllTakeout.public_code, customer_name: 'Forger', customer_phone: '0999999991',
          items: [{ product_id: 301, qty: 1, price: 1 }], // 偽造單價 1 元
          total: 1, subtotal: 1, // 偽造金額
          popup_campaign_name: '偽造活動', popup_session_name: '偽造場次',
          pickup_date: '1999-01-01', pickup_start_time: '00:00', pickup_end_time: '00:01',
          address: '偽造地址', lat: 0, lng: 0,
        },
      });
      assert(r.status === 201 && r.json.data.total === 120, '11-forged-fields 偽造 price/total/snapshot 欄位完全被忽略，金額仍是後端真實單價 120', JSON.stringify(r.json.data));
      const orderRow = db.get('SELECT * FROM orders WHERE id=?', [r.json.data.id]);
      assert(Number(orderRow.total) === 120 && orderRow.popup_session_name_snapshot === sessAllTakeout.name && orderRow.pickup_address_snapshot === loc.address,
        '11-forged-fields DB 內訂單的金額與 snapshot 全部是後端真實值，未被偽造欄位污染', JSON.stringify({ total: orderRow.total, name: orderRow.popup_session_name_snapshot, addr: orderRow.pickup_address_snapshot }));
    }

    // ══════════════════════════════════════════════════════════════
    // 十二（新增）：重複商品列先彙總再檢查（不得拆單繞過 quota）
    // ══════════════════════════════════════════════════════════════
    {
      const sessDupCheck = await makeSession(camp.id, loc.id, {
        product_scope: 'selected', name: 'DupCheckSess', products: [{ product_id: 301, quota_qty: 3 }],
      });
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: {
          popup_session_public_code: sessDupCheck.public_code, customer_name: 'Dup', customer_phone: '0911122233',
          items: [{ product_id: 301, qty: 2 }, { product_id: 301, qty: 2 }], // 拆成兩列，各 2 個，合計 4 > quota=3
        },
      });
      assert(r.status === 409 && r.json.error === 'POPUP_PRODUCT_SOLD_OUT', '12-dedupe-before-check 同一商品拆成兩列（2+2=4 > quota=3）先彙總再檢查，正確回 409（不會被繞過）', JSON.stringify(r));
      const allocCount = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE session_id=? AND product_id=301", [sessDupCheck.id]).c;
      assert(allocCount === 0, '12-dedupe-before-check 被拒絕的請求完全沒有寫入任何 allocation', String(allocCount));

      const rOk = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: sessDupCheck.public_code, customer_name: 'Dup2', customer_phone: '0911122234', items: [{ product_id: 301, qty: 1 }, { product_id: 301, qty: 2 }] },
      });
      assert(rOk.status === 201, '12-dedupe-before-check 合計剛好等於 quota（1+2=3）的拆單訂單成功', JSON.stringify(rOk));
      const allocRow = db.get("SELECT qty FROM popup_order_allocations WHERE session_id=? AND product_id=301 AND order_id=?", [sessDupCheck.id, rOk.json.data.id]);
      assert(allocRow.qty === 3, '12-dedupe-before-check allocation 正確合併成單一列，qty=3（不是兩筆各自的 1 和 2）', JSON.stringify(allocRow));
    }

    // ══════════════════════════════════════════════════════════════
    // 十三（新增）：max_orders=0 明確代表不限單
    // ══════════════════════════════════════════════════════════════
    {
      const uncappedSess = await makeSession(camp.id, loc.id, { name: 'UncappedSess', max_orders: 0 });
      for (let i = 0; i < 5; i++) {
        const r = await call('POST', '/api/line-orders/popup-checkout', {
          query: { store_id: 'store_001' },
          body: { popup_session_public_code: uncappedSess.public_code, customer_name: `U${i}`, customer_phone: `09${String(i).repeat(8)}`, items: [{ product_id: 301, qty: 1 }] },
        });
        assert(r.status === 201, `13-max-orders-zero max_orders=0 第 ${i + 1} 筆訂單仍成功（不限單）`, JSON.stringify(r));
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 十四（新增）：allocation 第一筆成功、第二筆商品強制失敗 → 兩筆都要
    //     ROLLBACK（不是只有失敗的那一筆被擋下，訂單本身也完全不留）。
    // ══════════════════════════════════════════════════════════════
    {
      const multiSess = await makeSession(camp.id, loc.id, { name: 'MultiProductFaultSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;

      const originalRun = db._db.run.bind(db._db);
      let allocInsertCount = 0;
      db._db.run = (...args) => {
        if (String(args[0]).includes('INSERT INTO popup_order_allocations')) {
          allocInsertCount += 1;
          if (allocInsertCount === 2) throw new Error('INJECTED FAILURE: second allocation insert forced to fail');
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('POST', '/api/line-orders/popup-checkout', {
          query: { store_id: 'store_001' },
          body: {
            popup_session_public_code: multiSess.public_code, customer_name: 'X', customer_phone: '0922233344',
            items: [{ product_id: 301, qty: 1 }, { product_id: 302, qty: 1 }],
          },
        });
      } finally {
        db._db.run = originalRun;
      }
      assert(r.status === 500 && r.json.error === 'POPUP_INTERNAL_ERROR', '14-multi-product-fault 第二個商品的 allocation INSERT 失敗，回 500', JSON.stringify(r));
      const afterOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const afterAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      assert(afterOrders === beforeOrders, '14-multi-product-fault 訂單完全未殘留', `before=${beforeOrders} after=${afterOrders}`);
      assert(afterAllocs === beforeAllocs, '14-multi-product-fault 第一個商品的 allocation 也一併被 ROLLBACK（不是只擋第二個）', `before=${beforeAllocs} after=${afterAllocs}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 十五（新增）：一張訂單多商品，取消時全部釋放
    // ══════════════════════════════════════════════════════════════
    {
      const multiRelSess = await makeSession(camp.id, loc.id, { name: 'MultiReleaseSess' });
      const rOrder = await call('POST', '/api/line-orders/popup-checkout', {
        query: { store_id: 'store_001' },
        body: { popup_session_public_code: multiRelSess.public_code, customer_name: 'X', customer_phone: '0933344455', items: [{ product_id: 301, qty: 2 }, { product_id: 302, qty: 3 }] },
      });
      assert(rOrder.status === 201, '15-multi-release 多商品訂單建立成功', JSON.stringify(rOrder));
      const { applyOrderStatusChange } = require('../utils/orderStatusFlow');
      const orderRow = db.get('SELECT * FROM orders WHERE id=?', [rOrder.json.data.id]);
      applyOrderStatusChange(db, 'store_001', orderRow, 'cancelled');
      const allocRows = db.all("SELECT product_id, status FROM popup_order_allocations WHERE order_id=?", [rOrder.json.data.id]);
      assert(allocRows.length === 2 && allocRows.every((a) => a.status === 'released'), '15-multi-release 取消後，兩個商品的 allocation 全部變成 released', JSON.stringify(allocRows));
    }

    // ══════════════════════════════════════════════════════════════
    // 十六（新增）：標準外帶訂單完全不受快閃邏輯影響
    // ══════════════════════════════════════════════════════════════
    {
      const normalOrderId = 'normal-order-1';
      db._db.run(
        `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [normalOrderId, normalOrderId, 'store_001', '一般外帶客', '0944455566', '[]', 'cash', 100, 100, 'takeout', 'pending', 'store', '', new Date().toISOString()]
      );
      db._save();
      const { applyOrderStatusChange } = require('../utils/orderStatusFlow');
      const normalOrderRow = db.get('SELECT * FROM orders WHERE id=?', [normalOrderId]);
      const beforeAllocCount = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const result = applyOrderStatusChange(db, 'store_001', normalOrderRow, 'cancelled');
      assert(result.ok, '16-standard-order-unaffected 標準外帶訂單取消流程正常完成（不因快閃邏輯而出錯）', JSON.stringify(result));
      const afterAllocCount = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      assert(afterAllocCount === beforeAllocCount, '16-standard-order-unaffected 標準外帶訂單取消不會產生或釋放任何 popup_order_allocations', `before=${beforeAllocCount} after=${afterAllocCount}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 十七：release SQL fault-injection——Phase 3A.2 修正後，訂單狀態變更
    // 與 allocation release 現在是同一個 raw transaction，release 失敗必須
    // 讓整個取消操作 ROLLBACK（訂單維持取消前的狀態，不是「已取消但
    // allocation 沒放出來」的不一致狀態）。
    // ══════════════════════════════════════════════════════════════
    {
      const releaseFaultSess = await makeSession(camp.id, loc.id, { name: 'ReleaseFaultSess' });
      const rOrder = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: releaseFaultSess.public_code, customer_name: 'X', customer_phone: '0955566677', items: [{ product_id: 301, qty: 1 }] },
      });
      const orderId = rOrder.json.data.id;
      const dbFilePath = process.env.POS_DB_PATH;
      const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');

      const originalRun = db._db.run.bind(db._db);
      const originalSave = db._save.bind(db);
      let saveCalledDuringInjection = false;
      db._save = (...args) => { saveCalledDuringInjection = true; return originalSave(...args); };
      db._db.run = (...args) => {
        if (String(args[0]).includes("UPDATE popup_order_allocations SET status='released'")) {
          throw new Error('INJECTED FAILURE: release update forced to fail');
        }
        return originalRun(...args);
      };
      let cancelResult;
      let threw = false;
      let thrownError = null;
      try {
        const { applyOrderStatusChange } = require('../utils/orderStatusFlow');
        const orderRow = db.get('SELECT * FROM orders WHERE id=?', [orderId]);
        cancelResult = applyOrderStatusChange(db, 'store_001', orderRow, 'cancelled');
      } catch (e) {
        threw = true;
        thrownError = e;
      } finally {
        db._db.run = originalRun;
        db._save = originalSave;
      }
      // Phase 3A.2 修正後的正確行為：release 失敗必須讓整個取消操作失敗
      // （拋出例外），不得回報「假成功」。
      assert(threw, '17-release-fault release SQL 失敗時，applyOrderStatusChange() 正確拋出例外（不回傳假成功）', JSON.stringify({ threw, cancelResult }));
      assert(thrownError && /INJECTED FAILURE/.test(thrownError.message), '17-release-fault 拋出的正是注入的那個錯誤（沒有被吞掉或包裝成別的訊息）', String(thrownError && thrownError.message));

      const orderAfter = db.get('SELECT order_status FROM orders WHERE id=?', [orderId]);
      assert(orderAfter.order_status === 'pending', '17-release-fault ROLLBACK 後訂單狀態維持取消前的原始狀態（pending），不是「已取消」', JSON.stringify(orderAfter));
      const allocAfter = db.get('SELECT status FROM popup_order_allocations WHERE order_id=?', [orderId]);
      assert(allocAfter.status === 'active', '17-release-fault ROLLBACK 後 allocation 也維持交易前的 active 狀態', JSON.stringify(allocAfter));
      assert(saveCalledDuringInjection === false, '17-release-fault _save() 在失敗路徑中完全未被呼叫', String(saveCalledDuringInjection));
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      assert(shaBefore === shaAfter, '17-release-fault 失敗前後整個 DB 檔案 SHA-256 完全相同（磁碟上的檔案完全沒被寫入過）', `before=${shaBefore} after=${shaAfter}`);

      // 修復後正常重試一次：必須同時是 cancelled 且 allocation released（同一次交易）。
      const { applyOrderStatusChange } = require('../utils/orderStatusFlow');
      const orderRowRetry = db.get('SELECT * FROM orders WHERE id=?', [orderId]);
      const retryResult = applyOrderStatusChange(db, 'store_001', orderRowRetry, 'cancelled');
      assert(retryResult.ok, '17-release-fault-retry 修復後重新取消成功', JSON.stringify(retryResult));
      const orderAfterRetry = db.get('SELECT order_status FROM orders WHERE id=?', [orderId]);
      const allocAfterRetry = db.get('SELECT status FROM popup_order_allocations WHERE order_id=?', [orderId]);
      assert(orderAfterRetry.order_status === 'cancelled' && allocAfterRetry.status === 'released', '17-release-fault-retry 修復後重試，訂單 cancelled 且 allocation released 同時成立（同一次交易內一起完成）', JSON.stringify({ orderAfterRetry, allocAfterRetry }));
    }

    // ══════════════════════════════════════════════════════════════
    // 十七.5（新增）：/void 端點同樣的原子性驗證（order_log + 狀態 + release
    // 同一交易），透過真實掛載的 routes/orders.js 用真實 HTTP 呼叫。
    // ══════════════════════════════════════════════════════════════
    {
      const voidSess = await makeSession(camp.id, loc.id, { name: 'VoidAtomicSess' });
      const rOrder = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: voidSess.public_code, customer_name: 'V', customer_phone: '0955566688', items: [{ product_id: 301, qty: 1 }] },
      });
      const orderId = rOrder.json.data.id;
      const dbFilePath = process.env.POS_DB_PATH;
      const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      const logCountBefore = db.get('SELECT COUNT(*) as c FROM order_logs WHERE order_id=?', [orderId]).c;

      const originalRun = db._db.run.bind(db._db);
      db._db.run = (...args) => {
        if (String(args[0]).includes("UPDATE popup_order_allocations SET status='released'")) {
          throw new Error('INJECTED FAILURE: void release update forced to fail');
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('POST', `/api/orders/${orderId}/void`, { query: { store_id: 'store_001' }, body: { reason: '測試', operator: 'tester' } });
      } finally {
        db._db.run = originalRun;
      }
      assert(r.status === 500, '17.5-void-atomic release SQL 失敗時，/void 端點回 500（不回傳假成功）', JSON.stringify(r));
      const orderAfter = db.get('SELECT status, order_status FROM orders WHERE id=?', [orderId]);
      assert(orderAfter.status !== 'void', '17.5-void-atomic ROLLBACK 後訂單狀態維持取消前狀態（不是 void）', JSON.stringify(orderAfter));
      const allocAfter = db.get('SELECT status FROM popup_order_allocations WHERE order_id=?', [orderId]);
      assert(allocAfter.status === 'active', '17.5-void-atomic ROLLBACK 後 allocation 維持 active', JSON.stringify(allocAfter));
      const logCountAfter = db.get('SELECT COUNT(*) as c FROM order_logs WHERE order_id=?', [orderId]).c;
      assert(logCountAfter === logCountBefore, '17.5-void-atomic ROLLBACK 後 order_log 也沒有殘留（三件事同一交易，一起失敗一起復原）', `before=${logCountBefore} after=${logCountAfter}`);
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      assert(shaBefore === shaAfter, '17.5-void-atomic 失敗前後 DB 檔案 SHA-256 完全相同', `before=${shaBefore} after=${shaAfter}`);

      const rRetry = await call('POST', `/api/orders/${orderId}/void`, { query: { store_id: 'store_001' }, body: { reason: '測試重試', operator: 'tester' } });
      assert(rRetry.status === 200, '17.5-void-atomic 修復後重試成功', JSON.stringify(rRetry));
      const orderAfterRetry = db.get('SELECT status FROM orders WHERE id=?', [orderId]);
      const allocAfterRetry = db.get('SELECT status FROM popup_order_allocations WHERE order_id=?', [orderId]);
      const logCountRetry = db.get('SELECT COUNT(*) as c FROM order_logs WHERE order_id=?', [orderId]).c;
      assert(orderAfterRetry.status === 'void' && allocAfterRetry.status === 'released' && logCountRetry === logCountBefore + 1, '17.5-void-atomic 重試成功後，狀態=void、allocation=released、order_log 新增 1 筆，三者同時成立', JSON.stringify({ orderAfterRetry, allocAfterRetry, logCountRetry }));
    }

    // ══════════════════════════════════════════════════════════════
    // 十八（新增）：public response allowlist——不得洩漏內部 ID
    // ══════════════════════════════════════════════════════════════
    {
      const r = await call('GET', `/api/line-orders/popup-session/${sessAllTakeout.public_code}`, { query: { store_id: 'store_001' } });
      const forbiddenKeys = ['id', 'store_id', 'campaign_id', 'location_id', 'revision'];
      const leaked = forbiddenKeys.filter((k) => Object.prototype.hasOwnProperty.call(r.json.data, k));
      assert(leaked.length === 0, '18-public-allowlist popup-session 回應不含任何內部 ID／revision 欄位', JSON.stringify(Object.keys(r.json.data)));
      const campaignLeaked = forbiddenKeys.filter((k) => Object.prototype.hasOwnProperty.call(r.json.data.campaign, k));
      assert(campaignLeaked.length === 0, '18-public-allowlist 內嵌的 campaign 物件同樣不含內部 ID', JSON.stringify(Object.keys(r.json.data.campaign)));
    }

    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    // 二十（新增）：transaction authority——precise pre-BEGIN injection
    //
    // 在 `db._db.run('BEGIN')` 真正執行之前攔截並注入變化，模擬「另一個
    // 完全獨立的請求」剛好在我們的請求送出後、交易真正開始前搶先改變了
    // 資料庫狀態。因為 validatePopupCheckoutAuthority() 現在整個都在
    // BEGIN 之後才被呼叫（唯一一次、fresh 讀取），這裡驗證的就是「這個
    // 架構本身」保證了 fresh read 是唯一權威，不會有任何 stale 的
    // session/campaign/items/subtotal 被沿用。
    // ══════════════════════════════════════════════════════════════
    function withPreBeginInjection(injectFn) {
      const originalRun = db._db.run.bind(db._db);
      let injected = false;
      db._db.run = (...args) => {
        if (!injected && String(args[0]).trim() === 'BEGIN') {
          injected = true;
          injectFn();
        }
        return originalRun(...args);
      };
      return () => { db._db.run = originalRun; };
    }
    async function checkoutInjected(sessionCode, body, injectFn) {
      const restore = withPreBeginInjection(injectFn);
      try {
        return await call('POST', '/api/line-orders/popup-checkout', {
          body: { popup_session_public_code: sessionCode, customer_name: 'Inj', customer_phone: '0988877766', ...body },
        });
      } finally { restore(); }
    }

    // 20.1：session → cancelled
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjCancelSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE popup_sessions SET status='cancelled' WHERE id=?", [s.id]);
        db._save();
      });
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_NOT_ORDERABLE' && r.json.state === 'cancelled', '20.1-inject-session-cancelled BEGIN 前注入場次取消，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.1-inject-session-cancelled 訂單未殘留', '');
      assert(db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs, '20.1-inject-session-cancelled allocation 未殘留', '');
    }

    // 20.2：campaign → paused
    {
      const camp2 = await makeCampaign('InjCampaignPause');
      const s = await makeSession(camp2.id, loc.id, { name: 'InjCampPauseSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE popup_campaigns SET status='paused' WHERE id=?", [camp2.id]);
        db._save();
      });
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_NOT_ORDERABLE' && r.json.state === 'paused', '20.2-inject-campaign-paused BEGIN 前注入活動暫停，交易內 fresh read 正確擋下（campaign 狀態覆蓋 session）', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.2-inject-campaign-paused 訂單未殘留', '');
    }

    // 20.3：popup_pickup_enabled → 0
    //
    // Phase 3A.3 修正：舊版把這個情境的 403 POPUP_PICKUP_DISABLED 當成
    // PASS——那個獨立的 error code 本身就是一種洩漏（等於告訴呼叫端
    // 「這個 code 其實存在，只是功能被關掉」）。移除該 assertion，改成
    // 跟「code 根本不存在」逐位元組相同的 404 POPUP_SESSION_NOT_FOUND。
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjFlagOffSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE settings SET value='0' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
        db._save();
      });
      const rNonexistent = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: 'definitely-does-not-exist-20-3', customer_name: 'Inj', customer_phone: '0988877766', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '20.3-inject-flag-off BEGIN 前注入總開關關閉，交易內 fresh read 正確擋下，回 404 POPUP_SESSION_NOT_FOUND（不再是洩漏用的 403 POPUP_PICKUP_DISABLED）', JSON.stringify(r));
      assert(JSON.stringify(r.json) === JSON.stringify(rNonexistent.json) && r.status === rNonexistent.status, '20.3-inject-flag-off 回應與 code 不存在逐位元組相同', JSON.stringify({ disabled: r.json, nonexistent: rNonexistent.json }));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.3-inject-flag-off 訂單未殘留', '');
      db._db.run("UPDATE settings SET value='1' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
    }

    // 20.4：max_orders 由 0 改為 1，同時注入第一張 active order
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjMaxOrdersSess', max_orders: 0 });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE popup_sessions SET max_orders=1 WHERE id=?", [s.id]);
        db._db.run(
          `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['inj-max-orders-1', 'inj-max-orders-1', 'store_001', 'Y', '0900000099', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', s.id, new Date().toISOString()]
        );
        db._save();
      });
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_FULL', '20.4-inject-max-orders BEGIN 前注入 max_orders=1 且已有 1 張訂單，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders + 1, '20.4-inject-max-orders 只有注入的那 1 筆訂單存在，我們的請求沒有額外建立訂單', '');
    }

    // 20.5：product.enabled/show_on_line/line_takeout_enabled 關閉
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjProductOffSess' });
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_takeout_enabled) VALUES (501,'store_001','InjProduct','主食',80,1,1)`);
      db._save();
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 501, qty: 1 }] }, () => {
        db._db.run("UPDATE products SET line_takeout_enabled=0 WHERE id=501");
        db._save();
      });
      assert(r.status === 409 && r.json.error === 'POPUP_PRODUCT_NOT_AVAILABLE', '20.5-inject-product-disabled BEGIN 前注入商品關閉外帶，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.5-inject-product-disabled 訂單未殘留', '');
    }

    // 20.6：product line_price 改價——成功時必須採用 fresh 價格
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjPriceChangeSess' });
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_takeout_enabled, line_price) VALUES (502,'store_001','InjPriceProduct','主食',80,1,1,0)`);
      db._save();
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 502, qty: 2 }] }, () => {
        db._db.run("UPDATE products SET line_price=999 WHERE id=502");
        db._save();
      });
      assert(r.status === 201, '20.6-inject-price-change BEGIN 前注入改價，訂單仍成功建立', JSON.stringify(r));
      assert(r.json.data.total === 999 * 2, '20.6-inject-price-change 訂單金額採用交易內 fresh 讀到的新價格（999），不是注入前的舊價格（80）', JSON.stringify(r.json.data));
      const orderRow = db.get('SELECT subtotal, total FROM orders WHERE id=?', [r.json.data.id]);
      assert(Number(orderRow.total) === 999 * 2, '20.6-inject-price-change DB 內訂單金額同樣是 fresh 價格', JSON.stringify(orderRow));
    }

    // 20.7：payment method 停用
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjPaymentOffSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' }, () => {
        db._db.run("UPDATE payment_methods SET is_active=0 WHERE store_id='store_001' AND code='cash'");
        db._save();
      });
      assert(r.status === 400 && r.json.error === 'POPUP_PAYMENT_METHOD_NOT_ALLOWED', '20.7-inject-payment-off BEGIN 前注入付款方式停用，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.7-inject-payment-off 訂單未殘留', '');
      db._db.run("UPDATE payment_methods SET is_active=1 WHERE store_id='store_001' AND code='cash'");
      db._save();
    }

    // 20.8：session 地點（place_name/place_id/address/lat/lng）變更——成功
    //       時 snapshot 必須採用 fresh 地點資料。
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjLocationChangeSess' });
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run(
          "UPDATE popup_sessions SET place_name=?, place_id=?, address=?, address_note=?, lat=?, lng=? WHERE id=?",
          ['注入後的新地點', 'injected-place-id', '注入後的新地址', '注入後的備註', 22.5, 120.5, s.id]
        );
        db._save();
      });
      assert(r.status === 201, '20.8-inject-location-change BEGIN 前注入地點變更，訂單仍成功建立', JSON.stringify(r));
      const orderRow = db.get('SELECT pickup_place_name_snapshot, pickup_place_id_snapshot, pickup_address_snapshot, pickup_address_note_snapshot, pickup_lat_snapshot, pickup_lng_snapshot FROM orders WHERE id=?', [r.json.data.id]);
      assert(orderRow.pickup_place_name_snapshot === '注入後的新地點' && orderRow.pickup_place_id_snapshot === 'injected-place-id' && orderRow.pickup_address_snapshot === '注入後的新地址' && Number(orderRow.pickup_lat_snapshot) === 22.5 && Number(orderRow.pickup_lng_snapshot) === 120.5,
        '20.8-inject-location-change snapshot 全部採用交易內 fresh 讀到的新地點資料，不是注入前的舊地點', JSON.stringify(orderRow));
    }

    // 20.9：selected quota 被其他 allocation 用盡
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjQuotaExhaustSess', product_scope: 'selected', products: [{ product_id: 301, quota_qty: 1 }] });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run(
          `INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)`,
          ['store_001', s.id, 'inj-quota-eater', 301, 1, 'active']
        );
        db._save();
      });
      assert(r.status === 409 && r.json.error === 'POPUP_PRODUCT_SOLD_OUT', '20.9-inject-quota-exhausted BEGIN 前注入份數被其他 allocation 用盡，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.9-inject-quota-exhausted 訂單未殘留', '');
    }

    // 20.11：BEGIN 前注入 stores.active=0——驗證 fetchFreshStoreAuthority()
    // 真的在交易內重新查，不是沿用 BEGIN 前（30 秒 featureGate cache 或任何
    // 其他管道）就已經判斷好的「店家有效」結果。
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjStoreInactiveSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE stores SET active=0 WHERE store_id='store_001'");
        db._save();
      });
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '20.11-inject-store-inactive BEGIN 前注入 stores.active=0，交易內 fresh read 正確擋下（結構化 4xx，不洩漏是哪一關失敗）', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.11-inject-store-inactive 訂單未殘留', '');
      assert(db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c === beforeAllocs, '20.11-inject-store-inactive allocation 未殘留', '');
      db._db.run("UPDATE stores SET active=1 WHERE store_id='store_001'");
      db._save();
    }

    // 20.12：BEGIN 前注入 licenses.active=0。
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjLicenseInactiveSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE licenses SET active=0 WHERE store_id='store_001'");
        db._save();
      });
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '20.12-inject-license-inactive BEGIN 前注入 licenses.active=0，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.12-inject-license-inactive 訂單未殘留', '');
      db._db.run("UPDATE licenses SET active=1 WHERE store_id='store_001'");
      db._save();
    }

    // 20.13：BEGIN 前注入 licenses.features.line_order=false。
    {
      const s = await makeSession(camp.id, loc.id, { name: 'InjLineOrderOffSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const featuresOnJson = JSON.stringify({ line_order: true, orders: true, products: true });
      const featuresOffJson = JSON.stringify({ line_order: false, orders: true, products: true });
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [featuresOffJson]);
        db._save();
      });
      assert(r.status === 404 && r.json.error === 'POPUP_SESSION_NOT_FOUND', '20.13-inject-line-order-off BEGIN 前注入 licenses.features.line_order=false，交易內 fresh read 正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.13-inject-line-order-off 訂單未殘留', '');
      db._db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [featuresOnJson]);
      db._save();
    }

    // 20.14：BEGIN 前查詢 store_001 的 license 若干次（模擬「交易外某處曾經
    // 讀過快取」），驗證即使 30 秒 featureGate cache 理論上還沒過期，
    // checkout transaction 內的判斷依然是這次 fresh 查詢的結果，不是快取。
    {
      const { getStoreLicense } = require('../middleware/featureGate');
      // 先用一般（會走快取）的 getStoreLicense() 讀一次「啟用」狀態，確保
      // 快取裡現在存的是「有效」——如果 checkout 真的偷懶用了這個快取，
      // 即使我們馬上把 DB 改成停用，快取仍會回傳「有效」，訂單就會錯誤地
      // 成功。
      getStoreLicense('store_001');
      const s = await makeSession(camp.id, loc.id, { name: 'InjCacheBypassSess' });
      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const r = await checkoutInjected(s.public_code, { items: [{ product_id: 301, qty: 1 }] }, () => {
        db._db.run("UPDATE licenses SET active=0 WHERE store_id='store_001'");
        db._save();
      });
      assert(r.status === 404, '20.14-cache-bypass 即使 30 秒 featureGate cache 理論上還沒過期（剛讀過一次），checkout transaction 仍然使用 fresh 查詢結果，正確擋下', JSON.stringify(r));
      assert(db.get('SELECT COUNT(*) as c FROM orders').c === beforeOrders, '20.14-cache-bypass 訂單未殘留', '');
      db._db.run("UPDATE licenses SET active=1 WHERE store_id='store_001'");
      db._save();
    }

    // 20.15（新增，Phase 3A.3）：雙向 cache 測試的另一個方向——先讓
    // featureGate cache 快取到「停用」的結果，接著把 DB 改回「啟用」，
    // 驗證 checkout transaction 依然是用這次 fresh DB 查詢的結果（成功），
    // 不是沿用快取裡「停用」的舊值。跟 20.14（cache=啟用、DB 改停用→拒絕）
    // 合起來，兩個方向都證明 transaction validator 真的被實際執行、不是
    // 恰好兩邊都判斷成同一個結果而看不出來是不是在用快取。
    {
      const { getStoreLicense, invalidateFeatureCache } = require('../middleware/featureGate');
      // 讓快取失效，重新開始，避免受前面測試殘留影響。
      invalidateFeatureCache('store_001');
      // 場次要用「管理 API」（POST /api/popup-pickup/sessions）建立，
      // 那條路徑本身掛了 requireFeature('line_order')，會走 featureGate
      // 的快取——這是它自己既有、合理的行為，不是我們這次要驗證的對象。
      // 必須在「污染快取成停用」之前先把場次建立好，否則連建立場次這個
      // 準備動作都會被那個快取擋下，跟我們真正要測的「公開 checkout /
      // GET 端點不受這個快取影響」是兩件不同的事。
      const s = await makeSession(camp.id, loc.id, { name: 'InjCacheDirection2Sess' });
      // makeSession() 本身透過管理 API 呼叫過 requireFeature('line_order')，
      // 那個中介層會把「當時的啟用狀態」重新快取起來——這裡再次
      // invalidateFeatureCache()，確保接下來讀到的快取是我們自己控制的
      // 「停用」，不是 makeSession() 副作用留下的「啟用」快取。
      invalidateFeatureCache('store_001');

      db._db.run("UPDATE licenses SET active=0 WHERE store_id='store_001'");
      db._save();
      // 讀一次，讓 featureGate cache 現在快取住的是「停用」。
      const cachedDisabled = getStoreLicense('store_001');
      assert(cachedDisabled.active === false, '20.15-cache-direction2-setup featureGate cache 現在快取的是「停用」', JSON.stringify(cachedDisabled));

      // 快取還沒過期的狀態下，把 DB 改回「啟用」。
      db._db.run("UPDATE licenses SET active=1 WHERE store_id='store_001'");
      db._save();

      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: s.public_code, customer_name: 'CacheDir2', customer_phone: '0988877700', items: [{ product_id: 301, qty: 1 }] },
      });
      assert(r.status === 201, '20.15-cache-direction2 即使 featureGate cache 理論上還快取著「停用」，checkout transaction 仍然依 fresh DB 查詢結果（已改回啟用）成功，不是沿用快取', JSON.stringify(r));

      // GET 公開端點（Phase 3A.3 已改用 fetchFreshStoreAuthority，不經過
      // featureGate cache）同樣必須反映 fresh DB 的「啟用」狀態，不是快取
      // 裡的「停用」。
      const rGet = await call('GET', `/api/line-orders/popup-session/${s.public_code}`);
      assert(rGet.status === 200, '20.15-cache-direction2-get GET 公開端點同樣不受 featureGate cache 影響，反映 fresh DB 的啟用狀態', JSON.stringify(rGet));
      invalidateFeatureCache('store_001');
    }


    // ══════════════════════════════════════════════════════════════
    // 20.10：固定 epoch 測試——UTC 15:00~16:00（Tokyo 已跨日、Taipei 尚未
    // 跨日）。這個測試完全不依賴 process.env.TZ 或 wall-clock「現在」，純粹
    // 用固定 epoch ms 直接呼叫 resolvePopupSessionState()，驗證台北曆法判斷
    // 不會被「Tokyo 其實已經跨到隔天」影響。
    {
      // UTC 2026-06-14T15:30:00Z：Taipei（+8）= 2026-06-14 23:30（尚未跨日）；
      // Tokyo（+9）= 2026-06-15 00:30（已經跨日）。
      const fixedEpochMs = Date.parse('2026-06-14T15:30:00.000Z');
      const r = pp.resolvePopupSessionState({
        campaignStatus: 'published', sessionStatus: 'published',
        pickupDate: '2026-06-14', pickupStartTime: '22:00', pickupEndTime: '23:59',
        orderOpenAt: '2026-06-01T00:00:00+08:00', orderCutoffAt: '2026-06-14T21:00:00+08:00',
        now: fixedEpochMs,
      });
      assert(r.state === 'pickup_active', '20.10-fixed-epoch-utc-15-16 UTC 15:30（Taipei 23:30／Tokyo 00:30 已跨日）以 Taipei 曆法判斷為 pickup_active，不受 Tokyo 已跨日影響', JSON.stringify(r));

      // 再往後推 40 分鐘（UTC 16:10）：Taipei 變成 06-15 00:10（已跨日、
      // 超過 pickup_end 23:59）→ ended；Tokyo 則是 06-15 01:10。同一組固定
      // epoch，純函式計算結果不受執行環境 TZ 影響。
      const fixedEpochMs2 = Date.parse('2026-06-14T16:10:00.000Z');
      const r2 = pp.resolvePopupSessionState({
        campaignStatus: 'published', sessionStatus: 'published',
        pickupDate: '2026-06-14', pickupStartTime: '22:00', pickupEndTime: '23:59',
        orderOpenAt: '2026-06-01T00:00:00+08:00', orderCutoffAt: '2026-06-14T21:00:00+08:00',
        now: fixedEpochMs2,
      });
      assert(r2.state === 'ended', '20.10-fixed-epoch-utc-15-16 UTC 16:10（Taipei 06-15 00:10，已超過 pickup_end 23:59）正確判斷為 ended', JSON.stringify(r2));
    }


    // ══════════════════════════════════════════════════════════════
    // 十八.5（新增）：/popup-order 必須回 503 placeholder，不得導向一般
    // line-order.html（Phase 3B 前不得讓顧客誤觸一般外帶流程）。
    // ══════════════════════════════════════════════════════════════
    {
      const r = await fetch(`${base}/popup-order`);
      const bodyText = await r.text();
      assert(r.status === 503, '18.5-popup-order-placeholder /popup-order 回 503', String(r.status));
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch (e) { /* 若不是 JSON，下面斷言會直接失敗 */ }
      assert(parsed && parsed.error === 'POPUP_ORDER_UI_NOT_READY', '18.5-popup-order-placeholder 回應是結構化 JSON（error=POPUP_ORDER_UI_NOT_READY），不是 HTML 頁面', bodyText.slice(0, 200));
      assert(!/<html/i.test(bodyText) && !/currentMode/i.test(bodyText) && !/combined_checkout/i.test(bodyText), '18.5-popup-order-no-html 回應內容不含任何 HTML 或一般點餐頁的 JS 變數名稱（沒有載入 line-order.html）', bodyText.slice(0, 200));
    }


    // ══════════════════════════════════════════════════════════════
    {
      const originalRun = db._db.run.bind(db._db);
      db._db.run = (...args) => {
        if (String(args[0]).includes('INSERT INTO orders')) throw new Error('boom at /home/claude/work/base/routes/line-orders.js SELECT * FROM orders');
        return originalRun(...args);
      };
      const leakSess = await (async () => { db._db.run = originalRun; return makeSession(camp.id, loc.id, { name: 'LeakCheckSess' }); })();
      db._db.run = (...args) => {
        if (String(args[0]).includes('INSERT INTO orders')) throw new Error('boom at /home/claude/work/base/routes/line-orders.js SELECT * FROM orders');
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('POST', '/api/line-orders/popup-checkout', {
          query: { store_id: 'store_001' },
          body: { popup_session_public_code: leakSess.public_code, customer_name: 'X', customer_phone: '0966677788', items: [{ product_id: 301, qty: 1 }] },
        });
      } finally {
        db._db.run = originalRun;
      }
      const bodyStr = JSON.stringify(r.json);
      assert(r.status === 500, '19-no-leak 強制錯誤時回 500', String(r.status));
      assert(!/\/home\/claude/.test(bodyStr) && !/SELECT|INSERT|UPDATE/i.test(bodyStr) && !/\.js:\d+/.test(bodyStr), '19-no-leak response body 不含檔案路徑、SQL 關鍵字或 stack trace 行號', bodyStr);
    }

  } finally {
    if (server) { try { server.close(); } catch (e) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}


main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); process.exitCode = 1; });
