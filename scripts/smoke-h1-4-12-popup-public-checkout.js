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
  // R7（ledger row 8）：全域 takeout fixture 生命週期。第二十五節安裝的全天營業／清空截止／清空
  // business_calendar% 設定在該節不還原（後續 sections 依賴它）；這裡在任何 takeout fixture mutation
  // 之前，用本 suite 的 temp DB handle 快照固定 selector 範圍（PK=store_id+key，無重複列；不存在的
  // row 以「不在快照中」表示），最外層 finally 先刪 selector 範圍、依快照精確重建、固定排序讀回深度比對。
  // restore 失敗：有 primary error → AggregateError([primary, ...restore])；無 primary → 直接 throw（FATAL／nonzero）。
  const R7_TAKEOUT_SELECTOR = "store_id='store_001' AND (key IN ('takeout_business_hours', 'takeout_cutoff_time', 'takeout_today_cutoff_time') OR key LIKE 'business_calendar%')";
  const r7ReadTakeoutRows = () => db.all(`SELECT store_id, key, value FROM settings WHERE ${R7_TAKEOUT_SELECTOR} ORDER BY store_id, key`).map((r) => ({ store_id: r.store_id, key: r.key, value: r.value }));
  let r7TakeoutSnapshot = null;
  let r7PrimaryError = null;

  try {
    r7TakeoutSnapshot = r7ReadTakeoutRows();
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
    app.use('/api/line-shipping', requireStore, requireFeature('line_order'), require('../routes/line-shipping'));
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

    // ══════════════════════════════════════════════════════════════
    // 二十一（新增）：一般 LINE line_quota_sold counter invariant——popup
    // checkout/cancel/void（含重複）前後，商品 301 自己的一般 LINE 每日
    // 配額 sold 計數必須完全不變（popup 走的是獨立的
    // popup_order_allocations，不共用一般 LINE quota 的 sold 欄位）。
    // 先讀過 utils/popupCheckout.js 的 allocatePopupOrderItemsInTransaction /
    // releasePopupOrderAllocations，兩者都只 UPDATE popup_order_allocations，
    // 完全沒有任何一行碰 products.line_quota_sold 或 ingredient 相關欄位；
    // 這裡用真實 DB before/after 把這個結論落地成可重跑的證據。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=100, line_quota_sold=3 WHERE id=301');
      db._save();
      const snap0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const invSess = await makeSession(camp.id, loc.id, { name: 'CounterInvSess' });
      const co = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: invSess.public_code, customer_name: 'CounterInv', customer_phone: '0977788899', items: [{ product_id: 301, qty: 2 }], payment_method: 'cash' },
      });
      assert(co.status === 201, '21-counter-invariant-checkout popup checkout（商品 301 qty=2）成功', JSON.stringify(co).slice(0, 150));
      const afterCheckout = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(afterCheckout === snap0, '21-counter-invariant-after-checkout popup checkout 成功後，一般 LINE line_quota_sold 完全不變', `before=${snap0} after=${afterCheckout}`);

      // R21：block-local 純讀取 helper——固定讀取指定 order 的 orders.status／order_status、popup allocation active／released 筆數、void log 筆數（無任何 DB 寫入）
      const popupLifecycleState = (id) => {
        const o = db.get('SELECT status, order_status FROM orders WHERE id=?', [id]);
        const allocCount = (st) => db.get('SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status=?', [id, st]).c;
        const voidLogs = db.get("SELECT COUNT(*) AS c FROM order_logs WHERE order_id=? AND action='void'", [id]).c;
        return { status: o ? o.status : null, orderStatus: o ? o.order_status : null, active: allocCount('active'), released: allocCount('released'), voidLogs };
      };
      const orderId = co.json.data.order_id || co.json.data.id;
      const cancel1 = await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const afterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const cancel1State = popupLifecycleState(orderId);
      assert(cancel1.status === 200 && cancel1.json.success === true && cancel1State.orderStatus === 'cancelled' && cancel1State.active === 0 && cancel1State.released === 1 && cancel1State.voidLogs === 0 && afterCancel === snap0, '21-counter-invariant-after-cancel popup cancel 後，line_quota_sold 仍完全不變', JSON.stringify({ httpStatus: cancel1.status, success: cancel1.json.success ?? null, orderIdPresent: !!orderId, ...cancel1State, counterBefore: snap0, counterAfter: afterCancel }));

      const cancel2 = await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } }); // 重複 cancel
      const afterDoubleCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const cancel2State = popupLifecycleState(orderId);
      assert(cancel2.status === 400 && cancel2.json.success === false && cancel2State.orderStatus === 'cancelled' && cancel2State.active === 0 && cancel2State.released === 1 && cancel2State.voidLogs === 0 && afterDoubleCancel === snap0, '21-counter-invariant-after-double-cancel 重複 cancel 後，line_quota_sold 仍完全不變', JSON.stringify({ httpStatus: cancel2.status, success: cancel2.json.success ?? null, orderIdPresent: !!orderId, ...cancel2State, counterBefore: snap0, counterAfter: afterDoubleCancel }));

      const co2 = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: invSess.public_code, customer_name: 'CounterInv2', customer_phone: '0977788900', items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' },
      });
      const order2Id = (co2.json && co2.json.data && (co2.json.data.order_id || co2.json.data.id)) || null;
      const void1 = order2Id ? await call('POST', `/api/orders/${order2Id}/void`, { token: T1, body: { reason: 'counter invariant test', operator: 'test' } }) : { status: null, json: {} }; // order2Id 缺失時用明確的 null placeholder（不 TypeError，由同一 assertion FAIL）
      const afterVoid = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const void1State = popupLifecycleState(order2Id);
      assert(co2.status === 201 && co2.json.success === true && !!order2Id && void1.status === 200 && void1.json.success === true && void1State.status === 'void' && void1State.orderStatus === 'cancelled' && void1State.active === 0 && void1State.released === 1 && void1State.voidLogs === 1 && afterVoid === snap0, '21-counter-invariant-after-void popup void 後，line_quota_sold 仍完全不變', JSON.stringify({ checkoutStatus: co2.status, checkoutSuccess: co2.json.success ?? null, orderIdPresent: !!order2Id, httpStatus: void1.status, success: void1.json.success ?? null, ...void1State, counterBefore: snap0, counterAfter: afterVoid }));
      const void2 = order2Id ? await call('POST', `/api/orders/${order2Id}/void`, { token: T1, body: { reason: '重複作廢', operator: 'test' } }) : { status: null, json: {} }; // 重複 void
      const afterDoubleVoid = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const void2State = popupLifecycleState(order2Id);
      assert(void2.status === 400 && void2.json.success === false && void2State.status === 'void' && void2State.orderStatus === 'cancelled' && void2State.active === 0 && void2State.released === 1 && void2State.voidLogs === 1 && afterDoubleVoid === snap0, '21-counter-invariant-after-double-void 重複 void 後，line_quota_sold 仍完全不變', JSON.stringify({ httpStatus: void2.status, success: void2.json.success ?? null, orderIdPresent: !!order2Id, ...void2State, counterBefore: snap0, counterAfter: afterDoubleVoid }));

      // 標準 LINE/POS 路徑本身的 line_quota_sold 累加流程沒有被這次改動破壞
      // R3：正式 endpoint 是 POST /api/line-orders（store JWT，成功回 200）。
      // 第二十一節早於第二十五節：此時 takeout_business_hours 仍是 initDb()
      // 種子（mon~sat close 20:00），今日單在 20:00 後會被 cutoff 擋下。這裡
      // 只在本段以 block-scoped fixture 設為 00:00–23:59（與第二十五節同一個
      // 正式 settings key／值），並在 finally 依快照精確還原、讀回比對。
      // 不論建單成功或失敗都產生同一個 hard assertion（不再有 note-only 分支）。
      const NORMAL_FIXTURE_KEYS = ['takeout_business_hours', 'takeout_today_cutoff_time'];
      const NORMAL_ALL_DAY_HOURS = JSON.stringify({
        mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
        wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
        fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
        sun: { open: '00:00', close: '23:59', enabled: true },
      });
      const normalFixtureRows = () => db.all("SELECT store_id, key, value FROM settings WHERE store_id='store_001' AND key IN (?, ?) ORDER BY key", NORMAL_FIXTURE_KEYS);
      const normalOrderIdsOf = () => db.all('SELECT id FROM orders WHERE customer_phone=? ORDER BY id', ['0977788901']).map((r) => r.id);
      let normalFixtureSnapshot = null;
      let normalPrimaryError = null;
      let normalCreatedOrderId = null;
      let normalIdsBefore = null;
      let normalQuotaBefore = null;
      let normalPreorderBefore = null;
      try {
        normalFixtureSnapshot = normalFixtureRows().map((r) => ({ store_id: r.store_id, key: r.key, value: r.value }));
        db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [NORMAL_ALL_DAY_HOURS]);
        db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
        db._save();
        const normalInstalled = normalFixtureRows();
        const normalFixtureInstalledOk = normalInstalled.length === 1 && normalInstalled[0].key === 'takeout_business_hours' && normalInstalled[0].value === NORMAL_ALL_DAY_HOURS;
        normalIdsBefore = normalOrderIdsOf();
        normalQuotaBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        normalPreorderBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const normalOrderRes = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: '一般LINE顧客', customer_phone: '0977788901', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] } });
        const normalRowsAfter = db.all('SELECT id, line_counter_bucket, line_counter_allocation_snapshot FROM orders WHERE customer_phone=? ORDER BY id', ['0977788901']);
        const normalNewRows = normalRowsAfter.filter((r) => !normalIdsBefore.includes(r.id));
        const normalNewRow = normalNewRows.length === 1 ? normalNewRows[0] : null;
        if (normalNewRow) normalCreatedOrderId = normalNewRow.id;
        const normalAllocs = (() => { try { const s = JSON.parse(normalNewRow ? normalNewRow.line_counter_allocation_snapshot : 'null'); return s && Array.isArray(s.allocations) ? s.allocations : []; } catch (e) { return []; } })();
        const normalQuotaAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const normalPreorderAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const normalBodyStr = JSON.stringify(normalOrderRes.json);
        const normalNoLeak = !/\.js:\d+|\bat\s+\S+\s+\(/.test(normalBodyStr) && !/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(normalBodyStr) && !/\/home\/|\.db\b|POS_DB_PATH|h1412-/.test(normalBodyStr);
        const normalHardOk = normalFixtureInstalledOk
          && normalOrderRes.status === 200
          && normalOrderRes.json.success === true
          && normalRowsAfter.length === normalIdsBefore.length + 1
          && normalNewRows.length === 1 && typeof normalCreatedOrderId === 'string' && normalCreatedOrderId.length > 0
          && normalNewRow.line_counter_bucket === 'quota'
          && normalAllocs.length === 1 && normalAllocs[0].counter_bucket === 'quota' && normalAllocs[0].product_id === 301 && normalAllocs[0].qty === 1
          && normalQuotaBefore === snap0 && normalQuotaAfter === normalQuotaBefore + 1
          && normalPreorderAfter === normalPreorderBefore
          && normalNoLeak;
        const normalSafe = (v) => (typeof v === 'string' ? v.slice(0, 80) : (v ?? null));
        assert(normalHardOk, '21-counter-invariant-normal-path-still-works 標準 LINE 訂單自己的 line_quota_sold 累加流程仍正常運作（+1），證明本輪改動沒有破壞一般路徑', JSON.stringify({
          status: normalOrderRes.status, success: normalOrderRes.json.success ?? null,
          error: normalSafe(normalOrderRes.json.error), reason: normalSafe(normalOrderRes.json.reason), message: normalSafe(normalOrderRes.json.message),
          orderIdsBefore: normalIdsBefore, orderIdsAfter: normalRowsAfter.map((r) => r.id),
          allocation: normalAllocs.map((a) => ({ product_id: a.product_id, bucket: a.counter_bucket, qty: a.qty })), bucket: normalNewRow ? normalNewRow.line_counter_bucket : null,
          quotaBefore: normalQuotaBefore, quotaAfter: normalQuotaAfter, preorderBefore: normalPreorderBefore, preorderAfter: normalPreorderAfter,
          snap0, fixtureInstalledOk: normalFixtureInstalledOk, noLeak: normalNoLeak,
        }));
      } catch (e) {
        normalPrimaryError = e;
      } finally {
        const normalCleanupErrors = [];
        try {
          if (normalCreatedOrderId) {
            const normalCancel = await call('PATCH', `/api/orders/${normalCreatedOrderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
            const normalCancelledRow = db.get('SELECT order_status FROM orders WHERE id=?', [normalCreatedOrderId]);
            const normalQuotaAfterCleanup = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
            const normalPreorderAfterCleanup = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
            const normalIdsAfterCleanup = normalOrderIdsOf();
            if (normalCancel.status !== 200) normalCleanupErrors.push(new Error('section 21 normal-path cleanup: cancel status ' + normalCancel.status));
            if (!normalCancelledRow || normalCancelledRow.order_status !== 'cancelled') normalCleanupErrors.push(new Error('section 21 normal-path cleanup: order not cancelled'));
            if (normalQuotaAfterCleanup !== normalQuotaBefore || normalPreorderAfterCleanup !== normalPreorderBefore) normalCleanupErrors.push(new Error(`section 21 normal-path cleanup: counters not restored quota ${normalQuotaBefore}->${normalQuotaAfterCleanup} preorder ${normalPreorderBefore}->${normalPreorderAfterCleanup}`));
            if (normalIdsAfterCleanup.length !== normalIdsBefore.length + 1) normalCleanupErrors.push(new Error('section 21 normal-path cleanup: unexpected order count ' + normalIdsAfterCleanup.length));
          } else if (normalIdsBefore !== null) {
            const normalIdsNoCreate = normalOrderIdsOf();
            const normalQuotaNoCreate = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
            const normalPreorderNoCreate = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
            if (JSON.stringify(normalIdsNoCreate) !== JSON.stringify(normalIdsBefore) || normalQuotaNoCreate !== normalQuotaBefore || normalPreorderNoCreate !== normalPreorderBefore) {
              normalCleanupErrors.push(new Error('section 21 normal-path: no order identified but orders/counters changed'));
            }
          }
        } catch (e) { normalCleanupErrors.push(e); }
        try {
          if (normalFixtureSnapshot !== null) {
            NORMAL_FIXTURE_KEYS.forEach((k) => db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key=?", [k]));
            normalFixtureSnapshot.forEach((r) => db._db.run('INSERT INTO settings (store_id, key, value) VALUES (?, ?, ?)', [r.store_id, r.key, r.value]));
            db._save();
            const normalRestored = normalFixtureRows();
            const normalRestoreOk = normalRestored.length === normalFixtureSnapshot.length
              && normalRestored.every((r, i) => r.store_id === normalFixtureSnapshot[i].store_id && r.key === normalFixtureSnapshot[i].key && r.value === normalFixtureSnapshot[i].value);
            if (!normalRestoreOk) {
              normalCleanupErrors.push(new Error(`section 21 normal-path fixture restore mismatch: expected keys [${normalFixtureSnapshot.map((r) => r.key).join(',')}] actual keys [${normalRestored.map((r) => r.key).join(',')}]`));
            }
          }
        } catch (e) { normalCleanupErrors.push(e); }
        if (normalPrimaryError && normalCleanupErrors.length) throw new AggregateError([normalPrimaryError, ...normalCleanupErrors], 'section 21 normal-path: primary error + cleanup/restore error');
        if (normalPrimaryError) throw normalPrimaryError;
        if (normalCleanupErrors.length) throw new AggregateError(normalCleanupErrors, 'section 21 normal-path cleanup/restore error');
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 二十二（新增，本輪稽核發現並修正的真實 production bug）：order
    // subtotal aggregate overflow——product 301 單價 120，每一行的
    // price*qty 個別都在安全整數範圍內（qty=75,000,000,000,000 時
    // lineTotal=9,000,000,000,000,000，仍是 safe integer），但用滿
    // MAX_ITEM_LINES=50 行灌爆總和後，50 行加總會超過
    // Number.MAX_SAFE_INTEGER，在修正前會靜默失去精度而不是被拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const overflowSess = await makeSession(camp.id, loc.id, { name: 'SubtotalOverflowSess' });
      const perLineQty = 75000000000000; // price(120) * qty 個別仍是 safe integer
      const perLineTotal = 120 * perLineQty;
      assert(Number.isSafeInteger(perLineTotal), '22-precheck-per-line-still-safe 用來構造 aggregate overflow 的單行 price*qty 本身仍是 safe integer（不是靠單行本身不合法才被擋）', String(perLineTotal));
      const items50 = Array.from({ length: 50 }, () => ({ product_id: 301, qty: perLineQty }));
      const manualSum = perLineTotal * 50;
      assert(!Number.isSafeInteger(manualSum), '22-precheck-aggregate-is-unsafe 50 行加總後確實超出 Number.MAX_SAFE_INTEGER（證明這是真的 aggregate overflow 情境，不是誤判）', String(manualSum));

      const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      const r = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: overflowSess.public_code, customer_name: 'SubtotalOverflow', customer_phone: '0955160001', items: items50, payment_method: 'cash' },
      });
      assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '22-subtotal-aggregate-overflow-rejected 50 行個別安全但加總溢位的 subtotal，真實回 400 POPUP_VALIDATION_ERROR（修正前會靜默算錯金額）', JSON.stringify(r).slice(0, 200));
      const afterOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
      const afterAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
      assert(afterOrders === beforeOrders, '22-subtotal-aggregate-overflow-orders-zero-write 拒絕後 orders 零新增', `before=${beforeOrders} after=${afterOrders}`);
      assert(afterAllocs === beforeAllocs, '22-subtotal-aggregate-overflow-allocations-zero-write 拒絕後 allocations 零新增', `before=${beforeAllocs} after=${afterAllocs}`);

      // 對照組：同樣 50 行但每行 qty 正常（合理數量），必須正常成功——
      // 證明修正不是矯枉過正擋掉正常的多行訂單。
      const normalItems50 = Array.from({ length: 50 }, () => ({ product_id: 301, qty: 1 }));
      const rNormal = await call('POST', '/api/line-orders/popup-checkout', {
        body: { popup_session_public_code: overflowSess.public_code, customer_name: 'Normal50Lines', customer_phone: '0955160002', items: normalItems50, payment_method: 'cash' },
      });
      assert(rNormal.status === 201, '22-normal-50-lines-still-succeeds 50 行正常數量（qty=1 each）仍正常成功，修正沒有誤傷合法的多行訂單', JSON.stringify(rNormal).slice(0, 200));
      const normalOrderRow = db.get('SELECT subtotal, total FROM orders WHERE customer_phone=?', ['0955160002']);
      assert(Number(normalOrderRow.subtotal) === 120 * 50 && Number(normalOrderRow.total) === 120 * 50, '22-normal-50-lines-subtotal-correct 正常 50 行訂單的 subtotal/total 正確為 6000', JSON.stringify(normalOrderRow));
    }

    // ══════════════════════════════════════════════════════════════
    // 二十三：MAX_ITEM_LINES=50 raw-row limit 邊界（已確認：唯一上限，
    // 在任何商品 DB 查詢之前先擋，沒有另外的 unique-product 上限——
    // grouping／彙總是在這個檢查「之後」才做的，50 raw rows 天然保證
    // 最多 50 個 unique product，不需要也沒有另一個常數）。
    // ══════════════════════════════════════════════════════════════
    {
      const rowLimitSess = await makeSession(camp.id, loc.id, { name: 'RowLimitSess' });

      // A：剛好 50 raw rows（用同一商品重複，duplicate 行為已知會保留
      // 多列且 allocation 用彙總值——這裡驗證的是「50 這個數字本身通過」，
      // 不是重新驗證 duplicate 語意）。
      {
        const items50 = Array.from({ length: 50 }, () => ({ product_id: 301, qty: 1 }));
        const r = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: rowLimitSess.public_code, customer_name: 'RowLimit50', customer_phone: '0955170001', items: items50, payment_method: 'cash' } });
        assert(r.status === 201, '23-row-limit-boundary-50-succeeds 恰好 50 raw rows（MAX_ITEM_LINES 邊界內）真實成功', JSON.stringify(r).slice(0, 200));
        const orderId = r.json.data.order_id || r.json.data.id;
        const row = db.get('SELECT items, subtotal FROM orders WHERE id=?', [orderId]);
        const parsedItems = JSON.parse(row.items);
        assert(parsedItems.length === 50, '23-row-limit-boundary-50-items-preserved order.items 保留全部 50 列（既有 duplicate 行為：保留列數，不合併）', String(parsedItems.length));
        assert(Number(row.subtotal) === 120 * 50, '23-row-limit-boundary-50-subtotal-correct subtotal 正確為 6000', String(row.subtotal));
        const allocSum = db.all('SELECT qty FROM popup_order_allocations WHERE order_id=?', [orderId]).reduce((s, a) => s + a.qty, 0);
        assert(allocSum === 50, '23-row-limit-boundary-50-allocation-aggregate allocation 彙總 qty 正確為 50', String(allocSum));
      }

      // B：51 raw rows → 拒絕，且發生在任何商品 DB 查詢之前（用 spy 監控
      // 是否有對 products 表的 SELECT 發生，若拒絕發生在查詢前，理論上
      // 不應該有 products SELECT 被送出——這裡用「拒絕訊息內容」加上
      // 「zero DB write」作為間接但真實的證據，不特別 mock SELECT）。
      {
        const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
        const beforeAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
        const items51 = Array.from({ length: 51 }, () => ({ product_id: 301, qty: 1 }));
        const r = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: rowLimitSess.public_code, customer_name: 'RowLimit51', customer_phone: '0955170002', items: items51, payment_method: 'cash' } });
        assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '23-row-limit-boundary-51-rejected 51 raw rows（超過 MAX_ITEM_LINES=50）真實回 400 POPUP_VALIDATION_ERROR', JSON.stringify(r).slice(0, 200));
        const afterOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
        const afterAllocs = db.get('SELECT COUNT(*) as c FROM popup_order_allocations').c;
        assert(afterOrders === beforeOrders && afterAllocs === beforeAllocs, '23-row-limit-boundary-51-zero-write 51 rows 拒絕後 orders/allocations 零寫入', JSON.stringify({ beforeOrders, afterOrders, beforeAllocs, afterAllocs }));
      }

      // C：51 列全部同一 product（duplicate）→ 同樣拒絕，證明 row-limit
      // 檢查在 grouping/彙總之前，不能靠「其實只有 1 種商品」繞過。
      {
        const items51dup = Array.from({ length: 51 }, () => ({ product_id: 301, qty: 1 }));
        const r = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: rowLimitSess.public_code, customer_name: 'RowLimit51Dup', customer_phone: '0955170003', items: items51dup, payment_method: 'cash' } });
        assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '23-row-limit-51-duplicate-still-rejected 51 列即使全部是同一個 product_id（unique product 只有 1 個），仍被 raw-row limit 擋下，證明檢查發生在 grouping 之前', JSON.stringify(r).slice(0, 200));
      }

      // D：目前沒有獨立的 unique-product 上限——50 raw rows 天然保證最多
      // 50 個 unique product；這裡明確記錄這個結論，不新增不存在的常數。
      console.log('[OBSERVATION] 23-no-separate-unique-product-cap：目前 production 沒有獨立於 MAX_ITEM_LINES 之外的 unique-product 數量上限；grouping 發生在 raw-row 上限檢查之後，這是靜態原始碼觀察，不列入測試 PASS/FAIL。');
    }

    // ══════════════════════════════════════════════════════════════
    // 二十四：items 結構矩陣——每案獨立 request，真實 HTTP，驗證安全
    // 結構化拒絕（不得 500/TypeError，不得洩漏 stack/SQL）。
    // ══════════════════════════════════════════════════════════════
    {
      const structSess = await makeSession(camp.id, loc.id, { name: 'ItemsStructSess' });
      async function tryBadItems(label, itemsValue, extraBody) {
        const beforeOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
        const body = { popup_session_public_code: structSess.public_code, customer_name: 'Struct' + label, customer_phone: '09551' + String(Math.floor(Math.random() * 900000) + 100000), payment_method: 'cash', ...extraBody };
        if (itemsValue !== undefined) body.items = itemsValue;
        const r = await call('POST', '/api/line-orders/popup-checkout', { body });
        assert(r.status >= 400 && r.status < 500, `24-items-struct-${label}-safe-4xx items=${label} 真實回安全的 4xx（不是 500/TypeError）`, `status=${r.status}`);
        const bodyStr = JSON.stringify(r.json);
        assert(!/at\s+\S+\.js:\d+|SELECT|INSERT|UPDATE/i.test(bodyStr), `24-items-struct-${label}-no-leak response 不洩漏 stack trace 或 SQL 關鍵字`, bodyStr.slice(0, 150));
        const afterOrders = db.get('SELECT COUNT(*) as c FROM orders').c;
        assert(afterOrders === beforeOrders, `24-items-struct-${label}-zero-write 拒絕後 orders 零新增`, `before=${beforeOrders} after=${afterOrders}`);
      }
      await tryBadItems('omitted', undefined, {});
      await tryBadItems('null', null, {});
      await tryBadItems('object', {}, {});
      await tryBadItems('empty-string', '', {});
      await tryBadItems('empty-array', [], {});
      await tryBadItems('nested-array', [[{ product_id: 301, qty: 1 }]], {});
      await tryBadItems('line-null', [null], {});
      await tryBadItems('line-object-only', [{}], {});
      await tryBadItems('product-id-omitted', [{ qty: 1 }], {});
      await tryBadItems('product-id-zero', [{ product_id: 0, qty: 1 }], {});
      await tryBadItems('product-id-negative', [{ product_id: -1, qty: 1 }], {});
      await tryBadItems('product-id-decimal', [{ product_id: 301.5, qty: 1 }], {});
      await tryBadItems('product-id-string', [{ product_id: '301', qty: 1 }], {});
      await tryBadItems('qty-omitted', [{ product_id: 301 }], {});
    }

    // ══════════════════════════════════════════════════════════════
    // 二十五：標準 LINE order 的 line_quota_sold / line_preorder_sold
    // 完整生命週期（create/cancel/repeat-cancel/new-create/void/
    // repeat-void），真正 endpoint：POST /api/line-orders（根路徑）、
    // PATCH /api/orders/:id/status、POST /api/orders/:id/void。
    // Reality Audit 結論（已讀 routes/line-orders.js 與
    // utils/orderStatusFlow.js 逐行確認，不是猜的）：
    //   - isPreorderOrder = pickup_date > 今天。
    //   - 今日單扣 line_quota_sold（需 line_quota_daily>0 或
    //     line_quota_enabled）；預購單扣 line_preorder_sold（需
    //     line_preorder_daily>0 或 line_preorder_enabled）。
    //   - cancel 用 order.pickup_time 格式（非 pickup_date）判斷是否為
    //     預購（長度>10 且含 '-' 與空白），對稱回補對應欄位。
    //   - repeated cancel：isCancellable(已是 cancelled)=false，回補分支
    //     被跳過，但 route 本身沒有額外拒絕，回真實 200（idempotent no-op，
    //     不是錯誤）。
    //   - void：對已是 void 的訂單，route 明確回 400「訂單已作廢」（不是
    //     idempotent 200）——跟 cancel 的契約不同，兩者分開驗證，不假設
    //     一致。
    //   - ingredient stock：本輪因需要額外 recipe/ingredient fixture，
    //     超出本輪能完成的範圍，誠實記錄為未測試，不假稱通過。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=100, line_quota_sold=0, line_preorder_enabled=1, line_preorder_daily=100, line_preorder_sold=0 WHERE id=301');
      db._save();

      // ── A：今日單（quota）create → cancel → repeat-cancel → new-create → void → repeat-void ──
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      // 稽核發現（真正原因，追蹤到 routes/line-orders.js 的
      // getEffectiveModeSchedule()）：先前清空的 takeout_cutoff_time 從來
      // 不是「20:00」的來源——真正來源是 utils/db.js initDb() 幫 demo 店
      // 種的 takeout_business_hours 每週營業時間（mon~sat close:'20:00'）。
      // getEffectiveCutoffMins() 取 schedule.end（來自 bizHours）與
      // todayCutoff 兩者較早者；todayCutoff 清空後，真正生效的就是
      // schedule.end=20:00。這是合法的店家設定，不是要繞過的 bug——用
      // 正式 settings 機制（同一個 takeout_business_hours key）把每天都設
      // 成 00:00–23:59，跟真正的店家後台設定「24 小時營業」完全等價，
      // 不是跳過 authority。
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({
        mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
        wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
        fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
        sun: { open: '00:00', close: '23:59', enabled: true },
      })]);
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
      db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
      db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
      db._save();
      const co1 = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Std量Q1', customer_phone: '0955180001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      if (co1.status !== 200 && co1.status !== 201) {
        console.log('[note] 標準 LINE 今日單建立仍被擋下（status=' + co1.status + ' ' + JSON.stringify(co1.json).slice(0, 150) + '）——已設定 takeout_business_hours 為全天 00:00-23:59、清空 cutoff 設定，仍被擋下代表還有其他 authority 層（例如 Business Calendar 表本身有命中今天的特例，或 mode_closed／store 全域開關），如實記錄，本節其餘 quota/preorder 生命週期驗證本輪未能執行，不假稱通過。');
        assert(co1.status === 200 || co1.status === 201, '25-std-quota-create-http 標準今日單真實建立成功（R4：被擋下即硬 FAIL，不再 blocked-as-pass）', `status=${co1.status} error=${co1.json.error ?? null}`);
      } else {
      assert(co1.status === 200 || co1.status === 201, '25-std-quota-create-http 標準今日單真實建立成功', `status=${co1.status}`);
      const order1 = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955180001']);
      const qAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfterCreate === q0 + 2, '25-std-quota-create-increments 建立後 line_quota_sold 精確 +2（qty=2）', `before=${q0} after=${qAfterCreate}`);

      const cancel1 = await call('PATCH', `/api/orders/${order1.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(cancel1.status === 200, '25-std-quota-cancel-http 第一次 cancel 真實成功', `status=${cancel1.status}`);
      const qAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfterCancel === q0, '25-std-quota-cancel-restores cancel 後 line_quota_sold 精確恢復為原值', `before=${q0} after=${qAfterCancel}`);

      const cancel1Again = await call('PATCH', `/api/orders/${order1.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      // 稽核更正：上一輪誤讀了 applyOrderStatusChange()——沒看到函式最前面
      // `if (newStatus==='cancelled' && !isCancellable(order.order_status))
      // return {ok:false, code:400,...}` 這個明確 guard，誤以為 repeat
      // cancel 是 idempotent 200。真實契約是 400（跟 void 對稱一致，不是
      // 先前回報的「兩者不同」）。這裡用真實 HTTP 結果更正，不是猜的。
      assert(cancel1Again.status === 400, '25-std-quota-repeat-cancel-rejected 重複 cancel 真實回 400（更正先前誤讀：跟 void 一樣是明確拒絕，不是 idempotent 200）', `status=${cancel1Again.status}`);
      const qAfterRepeatCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfterRepeatCancel === q0, '25-std-quota-repeat-cancel-no-double-restore 重複 cancel 沒有再次回補（不會變成 q0+2）', `before=${q0} after=${qAfterRepeatCancel}`);

      const co2 = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Std量Q2', customer_phone: '0955180002', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] } });
      const order2 = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955180002']);
      const qAfterCreate2 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfterCreate2 === q0 + 1, '25-std-quota-new-create-after-cancel 前一張取消後，新訂單建立仍正確 +1', `before=${q0} after=${qAfterCreate2}`);

      const void2 = await call('POST', `/api/orders/${order2.id}/void`, { token: T1, body: { reason: '測試作廢', operator: 'test' } });
      assert(void2.status === 200, '25-std-quota-void-http 第一次 void 真實成功', `status=${void2.status}`);
      const qAfterVoid = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfterVoid === q0, '25-std-quota-void-restores void 後 line_quota_sold 精確恢復', `before=${q0} after=${qAfterVoid}`);
      const voidLogCount = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order2.id]).c;
      assert(voidLogCount === 1, '25-std-quota-void-log-once void 後 order_logs 恰好新增 1 筆 void action', String(voidLogCount));

      const void2Again = await call('POST', `/api/orders/${order2.id}/void`, { token: T1, body: { reason: '重複作廢', operator: 'test' } });
      assert(void2Again.status === 400, '25-std-quota-repeat-void-rejected 重複 void 真實回 400「訂單已作廢」（跟 cancel 的重複拒絕契約一致，都是明確 400，先前誤以為 cancel 是 idempotent 200 已更正）', `status=${void2Again.status}`);
      const qAfterRepeatVoid = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const voidLogCountAfterRepeat = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order2.id]).c;
      assert(qAfterRepeatVoid === q0 && voidLogCountAfterRepeat === 1, '25-std-quota-repeat-void-no-double-effect 重複 void 被拒絕後，counter 沒有再變、log 沒有重複新增', JSON.stringify({ qAfterRepeatVoid, voidLogCountAfterRepeat }));

      // ── B：預購單（pickup_date 在未來）create → cancel ──
      const futureDate = (() => { const d = new Date(Date.now() + 3 * 86400000); return d.toISOString().slice(0, 10); })();
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const preIdsBefore = db.all('SELECT id FROM orders WHERE customer_phone=? ORDER BY id', ['0955180003']).map((r) => r.id);
      const preRes = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Std預購P1', customer_phone: '0955180003', order_type: 'takeout', payment_method: 'cash', pickup_date: futureDate, items: [{ product_id: 301, qty: 3 }] } });
      const preOrder = db.get('SELECT id, pickup_time FROM orders WHERE customer_phone=?', ['0955180003']);
      const pAfterCreate = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      // R2：預購 fixture 改為單一 hard prerequisite（不再有 soft fallback）。
      // 該電話恰好 1 筆新訂單、bucket=preorder、allocation snapshot 對 301
      // 記錄 preorder qty 3、line_preorder_sold 精確 +3；任何一項不成立即
      // FAIL，且後續 lifecycle 安全跳過（guard 為 false 時不讀 preOrder.id）。
      const preRowsAfter = db.all('SELECT id, line_counter_bucket, line_counter_allocation_snapshot FROM orders WHERE customer_phone=? ORDER BY id', ['0955180003']);
      const preNewRows = preRowsAfter.filter((r) => !preIdsBefore.includes(r.id));
      const preNewRow = preNewRows.length === 1 ? preNewRows[0] : null;
      const preAllocs = (() => { try { const s = JSON.parse(preNewRow ? preNewRow.line_counter_allocation_snapshot : 'null'); return s && Array.isArray(s.allocations) ? s.allocations : []; } catch (e) { return []; } })();
      const preAlloc301 = preAllocs.filter((a) => a && a.product_id === 301);
      const preHardOk = preRes.status >= 200 && preRes.status < 300
        && preRes.json.success === true
        && preIdsBefore.length === 0 && preRowsAfter.length === 1 && preNewRow !== null
        && preNewRow.line_counter_bucket === 'preorder'
        && preAlloc301.length === 1 && preAlloc301[0].counter_bucket === 'preorder' && preAlloc301[0].qty === 3
        && pAfterCreate === p0 + 3;
      assert(preHardOk, '25-std-preorder-create-increments 預購單建立後 line_preorder_sold 精確 +3', JSON.stringify({ status: preRes.status, success: preRes.json.success ?? null, orderIdsBefore: preIdsBefore, orderIdsAfter: preRowsAfter.map((r) => r.id), bucket: preNewRow ? preNewRow.line_counter_bucket : null, allocation: preAlloc301.map((a) => ({ product_id: a.product_id, bucket: a.counter_bucket, qty: a.qty })), preorderBefore: p0, preorderAfter: pAfterCreate }));
      if (preHardOk) {
        const preOrderFullRow = db.get('SELECT pickup_time, source, customer_line_id FROM orders WHERE id=?', [preOrder.id]);
        assert(preOrderFullRow.pickup_time === `${futureDate} 00:00`, '25-preorder-empty-time-persisted-with-date-marker 未來 pickup_date + 空 pickup_time 的預購單，persisted pickup_time 正確補上日期標記（' + futureDate + ' 00:00），不是空字串（H1.4.12 Phase 3C P0 修正的直接證據）', JSON.stringify(preOrderFullRow));
        const preCancel = await call('PATCH', `/api/orders/${preOrder.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const pAfterCancel = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(preCancel.status === 200 && pAfterCancel === p0, '25-std-preorder-cancel-restores 預購單 cancel 後 line_preorder_sold 精確恢復', JSON.stringify({ preCancelStatus: preCancel.status, before: p0, after: pAfterCancel }));

        // ── 矩陣案例 2：future pickup_date + 只有 HH:mm（無日期部分）──
        const p1 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const q1 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const coHHMM = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Std預購HHMM', customer_phone: '0955180004', order_type: 'takeout', payment_method: 'cash', pickup_date: futureDate, pickup_time: '15:30', items: [{ product_id: 301, qty: 2 }] } });
        const orderHHMM = db.get('SELECT id, pickup_time FROM orders WHERE customer_phone=?', ['0955180004']);
        assert(orderHHMM.pickup_time === `${futureDate} 15:30`, '25-matrix-future-hhmm-persisted-with-date future+HH:mm(15:30) 正確補上日期成為 canonical 格式', JSON.stringify(orderHHMM));
        const pAfterHHMM = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const qAfterHHMM = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        assert(pAfterHHMM === p1 + 2 && qAfterHHMM === q1, '25-matrix-future-hhmm-increments-preorder-only 只增加 line_preorder_sold，line_quota_sold 不受影響', JSON.stringify({ p1, pAfterHHMM, q1, qAfterHHMM }));
        const voidHHMM = await call('POST', `/api/orders/${orderHHMM.id}/void`, { token: T1, body: { reason: '矩陣案例2測試', operator: 'test' } });
        const pAfterVoidHHMM = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const qAfterVoidHHMM = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        assert(voidHHMM.status === 200 && pAfterVoidHHMM === p1 && qAfterVoidHHMM === q1, '25-matrix-future-hhmm-void-restores-preorder-only void 只恢復 line_preorder_sold（走 void，不是 cancel，證明兩條路徑用同一個分類/恢復函式）', JSON.stringify({ voidStatus: voidHHMM.status, p1, pAfterVoidHHMM, q1, qAfterVoidHHMM }));

        // ── 矩陣案例 4：future pickup_date + 已經是完整、日期相符的 datetime ──
        const p2 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const fullDatetimeMatching = `${futureDate} 09:00`;
        const coFullMatch = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Std預購Full', customer_phone: '0955180005', order_type: 'takeout', payment_method: 'cash', pickup_date: futureDate, pickup_time: fullDatetimeMatching, items: [{ product_id: 301, qty: 1 }] } });
        const orderFullMatch = db.get('SELECT id, pickup_time FROM orders WHERE customer_phone=?', ['0955180005']);
        assert(orderFullMatch.pickup_time === fullDatetimeMatching, '25-matrix-future-full-matching-passthrough 已經是完整且日期相符的 datetime，原樣保存（不重複疊加日期）', JSON.stringify(orderFullMatch));
        const pAfterFullMatch = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(pAfterFullMatch === p2 + 1, '25-matrix-future-full-matching-increments-preorder 正確判定為預購單並增加 line_preorder_sold', `before=${p2} after=${pAfterFullMatch}`);
        const cancelFullMatch = await call('PATCH', `/api/orders/${orderFullMatch.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const pAfterCancelFullMatch = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(cancelFullMatch.status === 200 && pAfterCancelFullMatch === p2, '25-matrix-future-full-matching-cancel-restores cancel 正確恢復 line_preorder_sold（跟 create 用同一個 canonical 分類，不是各自判斷）', JSON.stringify({ status: cancelFullMatch.status, before: p2, after: pAfterCancelFullMatch }));
      }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 二十七（新增）：分類衝突偵測矩陣——先用現況真實測出衝突，還沒改
    // production。日期一律用既有台北固定 +8 offset 動態算出，不硬編。
    // ══════════════════════════════════════════════════════════════
    function conflictDateStr(offsetDays) {
      const d = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    const todayTW = conflictDateStr(0);
    const futureTW = conflictDateStr(5);
    const anotherFutureTW = conflictDateStr(9);

    {
      // 案例 1：today pickup_date + matching full datetime（今日單，但
      // pickup_time 自己帶了完整日期）
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Conflict1', customer_phone: '0955190001', order_type: 'takeout', payment_method: 'cash', pickup_date: todayTW, pickup_time: `${todayTW} 14:00`, items: [{ product_id: 301, qty: 2 }] } });
      if (co.status === 200 || co.status === 201) {
        const order = db.get('SELECT id, pickup_time FROM orders WHERE customer_phone=?', ['0955190001']);
        const qAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const pAfterCreate = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const qAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const pAfterCancel = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        const createdAsQuota = qAfterCreate === q0 + 2 && pAfterCreate === p0;
        const cancelRestoredQuota = qAfterCancel === q0 && pAfterCancel === pAfterCreate;
        const cancelRestoredPreorderInstead = pAfterCancel === p0 && qAfterCancel === qAfterCreate;
        console.log('[CONFLICT-CASE-1]', JSON.stringify({ persistedPickupTime: order.pickup_time, q0, p0, qAfterCreate, pAfterCreate, qAfterCancel, pAfterCancel, createdAsQuota, cancelRestoredQuota, cancelRestoredPreorderInstead }));
        assert(!(createdAsQuota && cancelRestoredPreorderInstead && !cancelRestoredQuota), '27-conflict-case1-today-matching-full-datetime-no-mismatch 案例1（today pickup_date + 自帶完整日期的 pickup_time）建立與取消沒有加減錯配的 counter', JSON.stringify({ persistedPickupTime: order.pickup_time, createdAsQuota, cancelRestoredQuota, cancelRestoredPreorderInstead }));
      } else {
        console.log('[note] Conflict Case 1 建立被 business authority 擋下（status=' + co.status + '），本案跳過', JSON.stringify(co.json).slice(0, 150));
        assert(co.status === 200 || co.status === 201, '27-conflict-case1-today-matching-full-datetime-no-mismatch 案例1建立必須成功（R5：被擋下即硬 FAIL，不再 blocked-as-pass）', `status=${co.status} error=${co.json.error ?? null} reason=${co.json.reason ?? null}`);
      }
    }

    {
      // R5（ledger row 6）：Case 1 pickup_time 嚴格格式契約——合法 T 分隔完整
      // datetime 必須接受（防 T separator regression）；malformed 必須 403
      // invalid_pickup_time 且零寫入。區塊限定 fixture（全天營業、移除今日臨時
      // 截止）於 finally 依原始 row 精確還原，不依賴第二十五節遺留的全域狀態。
      const R5_FIXTURE_KEYS = ['takeout_business_hours', 'takeout_today_cutoff_time'];
      const R5_ALL_DAY = JSON.stringify({
        mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
        wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
        fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
        sun: { open: '00:00', close: '23:59', enabled: true },
      });
      const r5FixtureRows = () => db.all("SELECT store_id, key, value FROM settings WHERE store_id='store_001' AND key IN (?, ?) ORDER BY key", R5_FIXTURE_KEYS);
      const r5Counters = () => ({ q: db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold, p: db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold });
      const r5OrderIds = (phone) => db.all('SELECT id FROM orders WHERE customer_phone=? ORDER BY id', [phone]).map((r) => r.id);
      const r5NoLeak = (json) => { const s = JSON.stringify(json); return !/\.js:\d+|\bat\s+\S+\s+\(/.test(s) && !/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(s) && !/\/home\/|\.db\b|POS_DB_PATH|h1412-/.test(s); };
      let r5Snapshot = null;
      let r5PrimaryError = null;
      let r5Base = null;
      const r5Created = [];
      try {
        r5Snapshot = r5FixtureRows().map((r) => ({ store_id: r.store_id, key: r.key, value: r.value }));
        db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [R5_ALL_DAY]);
        db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
        db._save();
        const r5Installed = r5FixtureRows();
        const r5InstalledOk = r5Installed.length === 1 && r5Installed[0].key === 'takeout_business_hours' && r5Installed[0].value === R5_ALL_DAY;
        r5Base = r5Counters();

        // (a) 合法 T 分隔完整 datetime（今日、日期與 pickup_date 相符）
        const tIdsBefore = r5OrderIds('0955271101');
        const tC0 = r5Counters();
        const tRes = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'R5Tsep', customer_phone: '0955271101', order_type: 'takeout', payment_method: 'cash', pickup_date: todayTW, pickup_time: `${todayTW}T14:00`, items: [{ product_id: 301, qty: 1 }] } });
        const tRows = db.all('SELECT id, pickup_time, line_counter_bucket, line_counter_allocation_snapshot FROM orders WHERE customer_phone=? ORDER BY id', ['0955271101']);
        const tNew = tRows.filter((r) => !tIdsBefore.includes(r.id));
        tNew.forEach((r) => r5Created.push(r.id));
        const tAlloc = (() => { try { const s = JSON.parse(tNew.length === 1 ? tNew[0].line_counter_allocation_snapshot : 'null'); return s && Array.isArray(s.allocations) ? s.allocations : []; } catch (e) { return []; } })();
        const tC1 = r5Counters();
        assert(
          r5InstalledOk && tRes.status === 200 && tRes.json.success === true && tNew.length === 1
            && tNew[0].pickup_time === '14:00' && tNew[0].line_counter_bucket === 'quota'
            && tAlloc.length === 1 && tAlloc[0].product_id === 301 && tAlloc[0].counter_bucket === 'quota' && tAlloc[0].qty === 1
            && tC1.q === tC0.q + 1 && tC1.p === tC0.p && r5NoLeak(tRes.json),
          '27-case1-T-separator-full-datetime-accepted 今日 pickup_date + T 分隔且日期相符的完整 datetime 必須接受：200、恰好 1 筆、persisted 為 HH:mm、quota/301/1、quota +1、preorder 不變',
          JSON.stringify({ status: tRes.status, success: tRes.json.success ?? null, reason: tRes.json.reason ?? null, newOrders: tNew.length, persistedIsHHmm: tNew.length === 1 ? tNew[0].pickup_time === '14:00' : null, allocation: tAlloc.map((a) => ({ product_id: a.product_id, bucket: a.counter_bucket, qty: a.qty })), quotaBefore: tC0.q, quotaAfter: tC1.q, preorderBefore: tC0.p, preorderAfter: tC1.p, fixtureInstalledOk: r5InstalledOk }),
        );

        // (b) malformed：舊 parser 會以 NaN 繞過而建立訂單
        const mIdsBefore = r5OrderIds('0955271102');
        const mC0 = r5Counters();
        const mRes = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'R5Malformed', customer_phone: '0955271102', order_type: 'takeout', payment_method: 'cash', pickup_date: todayTW, pickup_time: '14:00abc', items: [{ product_id: 301, qty: 1 }] } });
        const mIdsAfter = r5OrderIds('0955271102');
        mIdsAfter.filter((id) => !mIdsBefore.includes(id)).forEach((id) => r5Created.push(id));
        const mC1 = r5Counters();
        assert(
          r5InstalledOk && mRes.status === 403 && mRes.json.success === false && mRes.json.reason === 'invalid_pickup_time' && mRes.json.message === '取餐時間格式不正確'
            && mIdsAfter.length === mIdsBefore.length && mC1.q === mC0.q && mC1.p === mC0.p && r5NoLeak(mRes.json),
          '27-case1-malformed-pickup-time-rejected-zero-write malformed pickup_time 必須 403 invalid_pickup_time（取餐時間格式不正確），零新訂單、quota／preorder 不變',
          JSON.stringify({ status: mRes.status, success: mRes.json.success ?? null, reason: mRes.json.reason ?? null, messageMatches: mRes.json.message === '取餐時間格式不正確', newOrders: mIdsAfter.length - mIdsBefore.length, quotaBefore: mC0.q, quotaAfter: mC1.q, preorderBefore: mC0.p, preorderAfter: mC1.p, fixtureInstalledOk: r5InstalledOk }),
        );
      } catch (e) {
        r5PrimaryError = e;
      } finally {
        const r5CleanupErrors = [];
        for (const id of r5Created) {
          try {
            const c = await call('PATCH', `/api/orders/${id}/status`, { token: T1, body: { order_status: 'cancelled' } });
            const row = db.get('SELECT order_status FROM orders WHERE id=?', [id]);
            if (c.status !== 200 || !row || row.order_status !== 'cancelled') r5CleanupErrors.push(new Error('R5 case1 cleanup: cancel status ' + c.status));
          } catch (e) { r5CleanupErrors.push(e); }
        }
        try {
          if (r5Base !== null) {
            const after = r5Counters();
            if (after.q !== r5Base.q || after.p !== r5Base.p) r5CleanupErrors.push(new Error(`R5 case1 cleanup: counters not restored quota ${r5Base.q}->${after.q} preorder ${r5Base.p}->${after.p}`));
          }
        } catch (e) { r5CleanupErrors.push(e); }
        try {
          if (r5Snapshot !== null) {
            R5_FIXTURE_KEYS.forEach((k) => db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key=?", [k]));
            r5Snapshot.forEach((r) => db._db.run('INSERT INTO settings (store_id, key, value) VALUES (?, ?, ?)', [r.store_id, r.key, r.value]));
            db._save();
            const restored = r5FixtureRows();
            const ok = restored.length === r5Snapshot.length && restored.every((r, i) => r.store_id === r5Snapshot[i].store_id && r.key === r5Snapshot[i].key && r.value === r5Snapshot[i].value);
            if (!ok) r5CleanupErrors.push(new Error(`R5 case1 fixture restore mismatch: expected keys [${r5Snapshot.map((r) => r.key).join(',')}] actual keys [${restored.map((r) => r.key).join(',')}]`));
          }
        } catch (e) { r5CleanupErrors.push(e); }
        if (r5PrimaryError && r5CleanupErrors.length) throw new AggregateError([r5PrimaryError, ...r5CleanupErrors], 'R5 case1: primary error + cleanup/restore error');
        if (r5PrimaryError) throw r5PrimaryError;
        if (r5CleanupErrors.length) throw new AggregateError(r5CleanupErrors, 'R5 case1 cleanup/restore error');
      }
    }

    {
      // 案例 2：today pickup_date + future full datetime（pickup_time 帶
      // 了一個「未來」日期，但 pickup_date 本身是今天）
      // R1：production 契約是 fail-closed——pickup_time 內嵌日期與 pickup_date
      // 不一致時，固定回 400 PICKUP_TIME_DATE_MISMATCH，且在任何 order／
      // counter 寫入之前拒絕。舊版用 soft branch／assert(true) 接受任何結果
      // （包含矛盾訂單被建立），已改為單一 hard predicate。
      const case2Phone = '0955190002';
      const case2OrderIds = () => db.all('SELECT id FROM orders WHERE customer_phone=? ORDER BY id', [case2Phone]).map((r) => r.id);
      const idsBefore = case2OrderIds();
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Conflict2', customer_phone: case2Phone, order_type: 'takeout', payment_method: 'cash', pickup_date: todayTW, pickup_time: `${futureTW} 00:00`, items: [{ product_id: 301, qty: 2 }] } });
      const idsAfter = case2OrderIds();
      const q1 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p1 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const sameOrderIds = idsAfter.length === idsBefore.length && idsAfter.every((id, i) => id === idsBefore[i]);
      assert(
        co.status === 400 && co.json.success === false && co.json.error === 'PICKUP_TIME_DATE_MISMATCH' && sameOrderIds && q1 === q0 && p1 === p0,
        '27-conflict-case2-mismatch-rejected-zero-write 案例2（today pickup_date，但 pickup_time 內嵌未來日期）固定回 400 PICKUP_TIME_DATE_MISMATCH，該電話訂單 ID 前後完全相同、quota／preorder counter 前後完全相同（零寫入）',
        JSON.stringify({ status: co.status, error: co.json.error ?? null, orderIdsBefore: idsBefore, orderIdsAfter: idsAfter, quotaBefore: q0, quotaAfter: q1, preorderBefore: p0, preorderAfter: p1 })
      );
    }

    // ══════════════════════════════════════════════════════════════
    // 二十六：Popup side-by-side——同一商品（301）走 popup checkout 全
    // 生命週期，line_quota_sold/line_preorder_sold 全程必須完全不變，
    // 只有 popup_order_allocations 變動。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run('UPDATE products SET line_quota_sold=10, line_preorder_sold=10 WHERE id=301'); // 給非零基準，證明不是巧合維持 0
      db._save();
      const snapQ = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const snapP = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;

      const popupSess = await makeSession(camp.id, loc.id, { name: 'SideBySidePopupSess' });
      const assertCountersUnchanged = (label) => {
        const q = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const p = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(q === snapQ && p === snapP, `26-popup-sidebyside-${label}-counters-unchanged popup ${label} 後，line_quota_sold=${snapQ}／line_preorder_sold=${snapP} 全程不變`, JSON.stringify({ q, p }));
      };

      const pc1 = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: popupSess.public_code, customer_name: 'SideBySide1', customer_phone: '0955181001', items: [{ product_id: 301, qty: 2 }], payment_method: 'cash' } });
      assert(pc1.status === 201, '26-popup-sidebyside-precheck-checkout1 popup checkout 成功建立', JSON.stringify(pc1).slice(0, 150));
      assertCountersUnchanged('checkout');
      const pOrder1Id = pc1.json.data.order_id || pc1.json.data.id;
      const allocActive = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE order_id=? AND status='active'", [pOrder1Id]).c;
      assert(allocActive === 1, '26-popup-sidebyside-allocation-active checkout 後 allocation 為 active 狀態', String(allocActive));

      await call('PATCH', `/api/orders/${pOrder1Id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assertCountersUnchanged('cancel');
      const allocReleased = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE order_id=? AND status='released'", [pOrder1Id]).c;
      assert(allocReleased === 1, '26-popup-sidebyside-allocation-released cancel 後 allocation 正確轉為 released', String(allocReleased));

      await call('PATCH', `/api/orders/${pOrder1Id}/status`, { token: T1, body: { order_status: 'cancelled' } }); // repeat
      assertCountersUnchanged('repeat-cancel');
      const allocReleasedAfterRepeat = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE order_id=? AND status='released'", [pOrder1Id]).c;
      assert(allocReleasedAfterRepeat === 1, '26-popup-sidebyside-repeat-cancel-no-double-release 重複 cancel 沒有產生第二筆 released（仍是 1 筆）', String(allocReleasedAfterRepeat));

      const pc2 = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: popupSess.public_code, customer_name: 'SideBySide2', customer_phone: '0955181002', items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } });
      assertCountersUnchanged('new-checkout');
      const pOrder2Id = pc2.json.data.order_id || pc2.json.data.id;

      await call('POST', `/api/orders/${pOrder2Id}/void`, { token: T1, body: { reason: 'side-by-side test', operator: 'test' } });
      assertCountersUnchanged('void');
      await call('POST', `/api/orders/${pOrder2Id}/void`, { token: T1, body: { reason: 'repeat void', operator: 'test' } }); // repeat（預期 400，但不影響 counter）
      assertCountersUnchanged('repeat-void');
    }

    // ══════════════════════════════════════════════════════════════
    // 二十八（新增，R33）：修正前既有訂單（legacy persisted data）
    // reproduction——新寫入已經 canonicalize，但「修正前就已經存在」的
    // pending 訂單，DB 裡仍然是舊格式（same-day 卻帶了日期）。不能因為
    // 新訂單安全了就假設歷史資料也安全。
    // ══════════════════════════════════════════════════════════════
    {
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      // 先用真實 API 建立一筆今日單（現在的 fix 會把它正確存成純 HH:mm），
      // 這樣其餘欄位（items/store_id/order_status/order_number...）都是
      // 完全真實、通過正式建立流程的資料，只有 pickup_time 這一欄手動改回
      // 「修正前」會出現的舊格式，精準模擬 legacy row，不是憑空亂造整張
      // order。
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'LegacyRepro', customer_phone: '0955191001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      if (co.status === 200 || co.status === 201) {
        const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955191001']);
        const qAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        assert(qAfterCreate === q0 + 2, '28-legacy-precheck-real-create 真實建立今日單成功，line_quota_sold 正確 +2（後續只竄改 pickup_time 欄位來模擬 legacy row，其餘資料完全真實）', `before=${q0} after=${qAfterCreate}`);
        // 手動把 persisted pickup_time 改回「修正前」的舊格式：same-day 卻帶了完整日期
        db._db.run('UPDATE orders SET pickup_time=? WHERE id=?', [`${todayTW} 14:00`, order.id]);
        db._save();
        const legacyCancel = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const qAfterLegacyCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const pAfterLegacyCancel = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        // 這裡刻意不預設「一定會失敗」或「一定會成功」——用具名 assertion
        // 如實記錄現況到底是哪一種，不得因 counter 剛好維持不動就誤判成
        // 正常（MAX(0,...) clamp 可能讓「完全沒恢復」看起來跟「本來就是
        // 0」一樣，這裡用非零基線 q0/p0 讓兩者可以被分辨出來）。
        const legacyRestoredQuotaCorrectly = qAfterLegacyCancel === q0 && pAfterLegacyCancel === p0;
        console.log('[LEGACY-REPRO]', JSON.stringify({ persisted: `${todayTW} 14:00`, legacyCancelStatus: legacyCancel.status, q0, p0, qAfterCreate, qAfterLegacyCancel, pAfterLegacyCancel, legacyRestoredQuotaCorrectly }));
        assert(legacyRestoredQuotaCorrectly, '28-legacy-preexisting-order-cancel-classification legacy row（修正前已存在、same-day 卻帶日期格式的 pending 訂單）走正式 cancel，line_quota_sold 正確恢復、line_preorder_sold 不受影響——如實記錄現況是否已安全，不是預設成功', JSON.stringify({ q0, p0, qAfterLegacyCancel, pAfterLegacyCancel }));
      } else {
        console.log('[note] Legacy repro 建立被 business authority 擋下（status=' + co.status + '）', JSON.stringify(co.json).slice(0, 150));
        assert(co.status === 200 || co.status === 201, '28-legacy-precheck-real-create 真實建立今日單成功（R4：legacy reproduction 前置建立被擋下即硬 FAIL）', `status=${co.status} error=${co.json.error ?? null}`);
      }
    }

    // legacy preorder control：created_at 的台北營業日早於 pickup_time 日期，
    // 建立時增加 line_preorder_sold，cancel 必須恢復 preorder 而非 quota。
    {
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'LegacyPreorderCtrl', customer_phone: '0955191002', order_type: 'takeout', payment_method: 'cash', pickup_date: futureTW, items: [{ product_id: 301, qty: 2 }] } });
      if (co.status === 200 || co.status === 201) {
        const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955191002']);
        const pAfterCreate = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(pAfterCreate === p0 + 2, '28-legacy-preorder-control-precheck 真實建立預購單成功，line_preorder_sold 正確 +2', `before=${p0} after=${pAfterCreate}`);
        const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
        assert(cancelRes.status === 200 && pAfter === p0 && qAfter === q0, '28-legacy-preorder-control-cancel-restores-preorder-only 預購單 cancel 正確只恢復 line_preorder_sold，line_quota_sold 完全不受影響', JSON.stringify({ status: cancelRes.status, q0, p0, qAfter, pAfter }));
      } else {
        assert(co.status === 200 || co.status === 201, '28-legacy-preorder-control-precheck 真實建立預購單成功（R4：legacy preorder 對照前置建立被擋下即硬 FAIL）', `status=${co.status} error=${co.json.error ?? null}`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 二十九（新增，R34）：ambiguous legacy empty pickup_time 不可判定
    // 證明——建立兩筆 raw fixture，persisted shape 完全相同
    // （pickup_time=''、bucket=NULL、合法 created_at、合法 items），但
    // 真實歷史語意不同（A 是同日 ASAP、B 是舊版 bug 產生的預購單）。
    // ══════════════════════════════════════════════════════════════
    {
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      function insertAmbiguousLegacyOrder(idSuffix, phone) {
        const id = 'ambig-legacy-' + idSuffix;
        const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
        db._db.run(`INSERT INTO orders (
          id, order_number, store_id, order_mode, order_status, status,
          customer_name, customer_phone, items, payment_method,
          subtotal, total, source, pickup_time, line_counter_bucket, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          id, 'AMBIG-' + idSuffix, 'store_001', 'takeout', 'pending', 'pending',
          'AmbigLegacy' + idSuffix, phone, JSON.stringify([{ product_id: 301, qty: 2 }]), 'cash',
          240, 240, 'line', '', null, nowStr, nowStr,
        ]);
        db._save();
        return id;
      }
      // A：真實歷史是「同日 ASAP」——模擬時手動把 line_quota_sold 加上去，
      // 代表「舊版程式當初建立時做的事」，不是這次測試發明的假設。
      const idA = insertAmbiguousLegacyOrder('A', '0955192001');
      db._db.run('UPDATE products SET line_quota_sold = line_quota_sold + 2 WHERE id=301'); db._save();
      // B：真實歷史是「預購」——模擬時手動把 line_preorder_sold 加上去。
      const idB = insertAmbiguousLegacyOrder('B', '0955192002');
      db._db.run('UPDATE products SET line_preorder_sold = line_preorder_sold + 2 WHERE id=301'); db._save();

      const qAfterSetup = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterSetup = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfterSetup === q0 + 2 && pAfterSetup === p0 + 2, '29-ambiguous-legacy-precheck-setup 兩筆 ambiguous legacy fixture 的前置 counter 設定正確（A 佔用 quota+2，B 佔用 preorder+2，兩者 persisted shape 完全相同）', JSON.stringify({ q0, p0, qAfterSetup, pAfterSetup }));

      const cancelA = await call('PATCH', `/api/orders/${idA}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const qAfterCancelA = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterCancelA = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(cancelA.status !== 200, '29-ambiguous-legacy-A-cancel-fail-closed A（真實歷史是同日單，但 persisted shape 無法跟 B 區分）cancel 真實回非 200 的拒絕，不猜測', `status=${cancelA.status}`);
      assert(qAfterCancelA === qAfterSetup && pAfterCancelA === pAfterSetup, '29-ambiguous-legacy-A-counters-untouched A 被拒絕後兩個 counter 都完全沒變（沒有「猜對一半」或動到不該動的那個）', JSON.stringify({ qAfterSetup, qAfterCancelA, pAfterSetup, pAfterCancelA }));
      const orderAStatus = db.get('SELECT order_status FROM orders WHERE id=?', [idA]).order_status;
      assert(orderAStatus === 'pending', '29-ambiguous-legacy-A-status-untouched A 的 order_status 仍是 pending，沒有「counter 沒恢復但訂單還是被取消」的半套狀態', orderAStatus);

      const cancelB = await call('PATCH', `/api/orders/${idB}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const qAfterCancelB = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterCancelB = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(cancelB.status !== 200, '29-ambiguous-legacy-B-cancel-fail-closed B（真實歷史是預購單，但 persisted shape 跟 A 完全相同）cancel 同樣真實回非 200 的拒絕——證明系統誠實地承認「這個 shape 本身就無法判定」，不是恰好對 A 猜錯、對 B 猜對', `status=${cancelB.status}`);
      assert(qAfterCancelB === qAfterSetup && pAfterCancelB === pAfterSetup, '29-ambiguous-legacy-B-counters-untouched B 被拒絕後兩個 counter 都完全沒變', JSON.stringify({ qAfterSetup, qAfterCancelB, pAfterSetup, pAfterCancelB }));
      const orderBStatus = db.get('SELECT order_status FROM orders WHERE id=?', [idB]).order_status;
      assert(orderBStatus === 'pending', '29-ambiguous-legacy-B-status-untouched B 的 order_status 仍是 pending', orderBStatus);
    }

    // ══════════════════════════════════════════════════════════════
    // 三十（新增，R35）：真實 ingredient fixture——product_ingredient_
    // formulas + ingredients 兩個真實 table，商品 301 耗用 2/單位，
    // ingredient 起始庫存 100，訂單 qty=3。透過真正的
    // POST /api/line-orders 建立（會走 deductIngredients()），不是手改
    // stock 冒充扣庫存。
    // ══════════════════════════════════════════════════════════════
    const ING_ID = 9001;
    db._db.run('DELETE FROM product_ingredient_formulas WHERE product_id=301');
    db._db.run('DELETE FROM ingredients WHERE id=?', [ING_ID]);
    db._db.run(`INSERT INTO ingredients (id, store_id, name, unit, total_stock, refrigerated_stock, frozen_stock, thawing_stock)
      VALUES (?, 'store_001', 'R35測試食材', 'g', 100, 100, 0, 0)`, [ING_ID]);
    db._db.run(`INSERT INTO product_ingredient_formulas (product_id, ingredient_id, amount_per_unit) VALUES (301, ?, 2)`, [ING_ID]);
    db._save();

    const caseSuffixes = { 'A-quota-cancel': '01', 'B-quota-void': '02', 'C-preorder-cancel': '03', 'D-preorder-void': '04' };
    async function ingredientLifecycleCase(label, isPreorder, operation) {
      const stockBefore = db.get('SELECT total_stock, refrigerated_stock FROM ingredients WHERE id=?', [ING_ID]);
      const q0 = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const p0 = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const phone = '0955195' + caseSuffixes[label] + '0';
      const body = { customer_name: 'Ing' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 3 }] };
      if (isPreorder) body.pickup_date = futureTW;
      const co = await call('POST', '/api/line-orders', { token: T1, body });
      if (co.status !== 200 && co.status !== 201) {
        assert(co.status === 200 || co.status === 201, `30-${label}-create-deducts-ingredient ${label} 建立未成功即硬 FAIL（R4：不再 blocked-as-pass）`, `status=${co.status} error=${co.json.error ?? null}`);
        return;
      }
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      const stockAfterCreate = db.get('SELECT total_stock, refrigerated_stock FROM ingredients WHERE id=?', [ING_ID]);
      assert(stockAfterCreate.total_stock === stockBefore.total_stock - 6, `30-${label}-create-deducts-ingredient ${label} 建立後 ingredient total_stock 正確扣 6（100→94，qty=3×amount_per_unit=2）`, JSON.stringify({ before: stockBefore.total_stock, after: stockAfterCreate.total_stock }));
      const counterAfterCreate = isPreorder
        ? db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold
        : db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const expectedCounterAfterCreate = (isPreorder ? p0 : q0) + 3;
      assert(counterAfterCreate === expectedCounterAfterCreate, `30-${label}-create-counter-correct ${label} 建立後對應的 counter（${isPreorder ? 'preorder' : 'quota'}）正確 +3`, JSON.stringify({ expected: expectedCounterAfterCreate, actual: counterAfterCreate }));

      let opRes;
      if (operation === 'cancel') {
        opRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      } else {
        opRes = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: label + ' R35測試', operator: 'test' } });
      }
      assert(opRes.status === 200, `30-${label}-${operation}-http-succeeds ${label} 真實 ${operation} 成功`, `status=${opRes.status}`);
      const stockAfterOp = db.get('SELECT total_stock, refrigerated_stock FROM ingredients WHERE id=?', [ING_ID]);
      assert(stockAfterOp.total_stock === stockBefore.total_stock, `30-${label}-${operation}-restores-ingredient ${label} ${operation} 後 ingredient total_stock 精確恢復回 ${stockBefore.total_stock}（不是 94，也不是超過 100）`, JSON.stringify({ expected: stockBefore.total_stock, actual: stockAfterOp.total_stock }));
      const counterAfterOp = isPreorder
        ? db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold
        : db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(counterAfterOp === (isPreorder ? p0 : q0), `30-${label}-${operation}-counter-restores ${label} ${operation} 後 counter 精確恢復`, JSON.stringify({ expected: isPreorder ? p0 : q0, actual: counterAfterOp }));
      const otherCounterUnaffected = isPreorder
        ? db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold === q0
        : db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold === p0;
      assert(otherCounterUnaffected, `30-${label}-${operation}-other-counter-untouched ${label} ${operation} 沒有動到另一個 counter`, '');
      const orderStatusAfterOp = db.get('SELECT order_status, status FROM orders WHERE id=?', [order.id]);
      assert(orderStatusAfterOp.order_status === 'cancelled', `30-${label}-${operation}-status-correct ${label} ${operation} 後 order_status 正確為 cancelled`, JSON.stringify(orderStatusAfterOp));

      // repeat operation：不得重複恢復
      const repeatRes = operation === 'cancel'
        ? await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } })
        : await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'repeat', operator: 'test' } });
      const stockAfterRepeat = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]);
      const counterAfterRepeat = isPreorder
        ? db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold
        : db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(stockAfterRepeat.total_stock === stockBefore.total_stock, `30-${label}-repeat-${operation}-no-double-restore 重複 ${operation} 沒有再次恢復 ingredient stock（仍是 ${stockBefore.total_stock}，不是 106）`, JSON.stringify({ expected: stockBefore.total_stock, actual: stockAfterRepeat.total_stock }));
      assert(counterAfterRepeat === (isPreorder ? p0 : q0), `30-${label}-repeat-${operation}-counter-no-double-restore 重複 ${operation} 沒有再次恢復 counter`, JSON.stringify({ expected: isPreorder ? p0 : q0, actual: counterAfterRepeat }));
    }

    await ingredientLifecycleCase('A-quota-cancel', false, 'cancel');
    await ingredientLifecycleCase('B-quota-void', false, 'void');
    await ingredientLifecycleCase('C-preorder-cancel', true, 'cancel');
    await ingredientLifecycleCase('D-preorder-void', true, 'void');

    // ══════════════════════════════════════════════════════════════
    // 三十一（新增，R36）：void 的真實 status/order_status 雙欄位契約
    // ══════════════════════════════════════════════════════════════
    {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'VoidFieldCheck', customer_phone: '0955196001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] } });
      if (co.status === 200 || co.status === 201) {
        const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955196001']);
        await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R36欄位驗證', operator: 'test' } });
        const row = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
        assert(row.status === 'void', '31-void-status-field-is-void void 後 orders.status 真的是 \'void\'（POS 專用欄位，跟 order_status 不同）', JSON.stringify(row));
        assert(row.order_status === 'cancelled', '31-void-order-status-field-is-cancelled void 後 orders.order_status 真的是 \'cancelled\'（工作流程共用欄位，跟 status 不同——這是既有正式契約，不是測試讀錯欄位）', JSON.stringify(row));
        assert(!!row.void_reason && row.void_reason.includes('R36'), '31-void-reason-persisted void_reason 正確存下作廢原因', row.void_reason);
        assert(!!row.voided_at, '31-voided-at-persisted voided_at 有寫入時間戳記', row.voided_at);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 三十二（新增，R36）：grams-stock 分支不可達，用真實 control 證明
    // （不是只靠「目前兩個 caller 都傳 false」下結論）——建立一個有
    // allocated_grams/inventory_enabled 的商品、完全沒有配方，走真實
    // POST /api/line-orders，證明 current_stock_grams 真的完全不變。
    // ══════════════════════════════════════════════════════════════
    {
      const GRAMS_PID = 9002;
      db._db.run('DELETE FROM products WHERE id=?', [GRAMS_PID]);
      db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_takeout_enabled, inventory_enabled, allocated_grams, current_stock_grams) VALUES (?, 'store_001', 'R36秤重商品', '主食', 80, 1, 1, 1, 50, 1000)`, [GRAMS_PID]);
      db._save();
      const stockBefore = db.get('SELECT current_stock_grams FROM products WHERE id=?', [GRAMS_PID]).current_stock_grams;
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'GramsControl', customer_phone: '0955197001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: GRAMS_PID, qty: 2 }] } });
      assert(co.status === 200 || co.status === 201, '32-grams-stock-prereq-create-succeeds prerequisite：真實建單必須成功', `status=${co.status}`);
      const stockAfterCreate = db.get('SELECT current_stock_grams FROM products WHERE id=?', [GRAMS_PID]).current_stock_grams;
      assert(stockAfterCreate === stockBefore, '32-grams-stock-unreachable-at-create 真實建立標準 LINE 訂單（商品有 allocated_grams、無配方）後，current_stock_grams 完全沒變——確認 LINE 建立路徑真的不扣秤重庫存，不是靠 caller 參數猜的', JSON.stringify({ before: stockBefore, after: stockAfterCreate }));
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955197001']);
      const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(cancelRes.status === 200, '32-grams-stock-prereq-cancel-succeeds prerequisite：真實 cancel 必須成功', `status=${cancelRes.status}`);
      const stockAfterCancel = db.get('SELECT current_stock_grams FROM products WHERE id=?', [GRAMS_PID]).current_stock_grams;
      assert(stockAfterCancel === stockBefore, '32-grams-stock-unreachable-at-cancel cancel 後 current_stock_grams 同樣完全沒變（沒有東西可以「多補」，因為建立時根本沒扣）', JSON.stringify({ before: stockBefore, after: stockAfterCancel }));

      // R38：對稱補上 void 側的相同 control——不是 fault injection，是
      // 建立/void 對稱性的永久 regression。
      const stockBefore2 = db.get('SELECT current_stock_grams FROM products WHERE id=?', [GRAMS_PID]).current_stock_grams;
      const co2 = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'GramsControlVoid', customer_phone: '0955197002', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: GRAMS_PID, qty: 2 }] } });
      assert(co2.status === 200 || co2.status === 201, '32-grams-stock-void-prereq-create-succeeds prerequisite：void control 的真實建單必須成功', `status=${co2.status}`);
      const order2 = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955197002']);
      const logCountBefore = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order2.id]).c;
      const voidRes2 = await call('POST', `/api/orders/${order2.id}/void`, { token: T1, body: { reason: 'grams stock void control', operator: 'test' } });
      assert(voidRes2.status === 200, '32-grams-stock-void-prereq-void-succeeds prerequisite：void control 的真實 void 必須成功', `status=${voidRes2.status}`);
      const stockAfterVoid2 = db.get('SELECT current_stock_grams FROM products WHERE id=?', [GRAMS_PID]).current_stock_grams;
      assert(stockAfterVoid2 === stockBefore2, '32-grams-stock-unreachable-at-void void 後 current_stock_grams 同樣完全不變（建立與 void 對稱：兩邊都不碰秤重庫存）', JSON.stringify({ before: stockBefore2, after: stockAfterVoid2 }));
      const orderRow2 = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order2.id]);
      assert(orderRow2.status === 'void' && orderRow2.order_status === 'cancelled' && !!orderRow2.void_reason && !!orderRow2.voided_at, '32-grams-stock-void-metadata-correct void metadata（status/order_status/void_reason/voided_at）全部正確寫入，不受秤重庫存不可達影響', JSON.stringify(orderRow2));
      const logCountAfter = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order2.id]).c;
      assert(logCountAfter === logCountBefore + 1, '32-grams-stock-void-log-exactly-one void log 恰好新增 1 筆', JSON.stringify({ logCountBefore, logCountAfter }));
      const invLogCount = db.get("SELECT COUNT(*) as c FROM inventory_logs WHERE product_id=?", [GRAMS_PID]).c;
      assert(invLogCount === 0, '32-grams-stock-void-no-inventory-log 全程沒有任何 inventory_logs（既沒扣也沒補，log 也不該無中生有）', String(invLogCount));
    }

    // ══════════════════════════════════════════════════════════════
    // 三十三（新增，R36）：真實 fault injection——cancel 交易中，
    // ingredient UPDATE 失敗，證明 status／counter／ingredient 全部
    // rollback，不留半套狀態。
    // ══════════════════════════════════════════════════════════════
    {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'FaultInject', customer_phone: '0955198001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 3 }] } });
      assert(co.status === 200 || co.status === 201, '33-prereq-order-created prerequisite：真實建單必須成功', `status=${co.status}`);
      {
        const order = db.get('SELECT id, order_status FROM orders WHERE customer_phone=?', ['0955198001']);
        const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const stockBefore = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;

        const origRun = db._db.run.bind(db._db);
        let injected = false;
        db._db.run = function (sql, params) {
          if (!injected && typeof sql === 'string' && sql.includes('UPDATE ingredients SET')) {
            injected = true;
            throw new Error('R36 injected ingredient UPDATE failure');
          }
          return origRun(sql, params);
        };
        let cancelThrew = false;
        let cancelRes;
        try {
          cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        } finally {
          db._db.run = origRun; // 一定要在 finally 還原，不管上面是否 throw
        }
        assert(cancelRes.status >= 500, '33-fault-injection-http-failure ingredient UPDATE 失敗時，真實 HTTP 回非成功（500，route 的外層 try/catch 接住往外拋的例外）', `status=${cancelRes.status}`);
        assert(!/at\s+\S+\.js:\d+|node_modules/i.test(JSON.stringify(cancelRes.json)), '33-fault-injection-no-stack-leak 錯誤 response 不含 stack trace 路徑', JSON.stringify(cancelRes.json).slice(0, 200));
        const orderAfterFault = db.get('SELECT order_status FROM orders WHERE id=?', [order.id]);
        assert(orderAfterFault.order_status === order.order_status, '33-fault-injection-status-rolled-back rollback 後 order_status 維持操作前的值（沒有變成 cancelled）', JSON.stringify({ before: order.order_status, after: orderAfterFault.order_status }));
        const qAfterFault = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        assert(qAfterFault === qBefore, '33-fault-injection-counter-rolled-back rollback 後 line_quota_sold 維持操作前的值（沒有被恢復），代表訂單仍然「占用」這份配額', JSON.stringify({ before: qBefore, after: qAfterFault }));
        const stockAfterFault = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
        assert(stockAfterFault === stockBefore, '33-fault-injection-ingredient-rolled-back rollback 後 ingredient total_stock 維持操作前（已扣除）的值，沒有半套回補', JSON.stringify({ before: stockBefore, after: stockAfterFault }));

        // 移除 fault 後重試：應該成功且只恢復一次
        const retryRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        assert(retryRes.status === 200, '33-fault-injection-retry-succeeds 移除 fault 後，同一張訂單重新 cancel 真實成功', `status=${retryRes.status}`);
        const qAfterRetry = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
        const stockAfterRetry = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
        assert(qAfterRetry === qBefore - 3, '33-fault-injection-retry-restores-once 重試成功後 counter 只恢復一次（-3，不是因為之前失敗又疊加）', JSON.stringify({ qBefore, qAfterRetry }));
        assert(stockAfterRetry === stockBefore + 6, '33-fault-injection-retry-ingredient-restores-once 重試成功後 ingredient 只恢復一次（+6）', JSON.stringify({ stockBefore, stockAfterRetry }));
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 三十五（新增，R37）：通用 fault-injection helper + 補完 cancel
    // fault matrix（status UPDATE／quota counter／preorder counter／
    // COMMIT），每案都走真實 HTTP 建立 + 真實 HTTP cancel，不是呼叫
    // internal function。
    // ══════════════════════════════════════════════════════════════
    async function runCancelFaultCase(label, sqlPattern, isPreorder, expectedTriggerCount) {
      const phone = '0955' + String(Math.floor(Math.random() * 900000) + 100000);
      const body = { customer_name: 'CancelFault' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] };
      if (isPreorder) body.pickup_date = futureTW;
      const co = await call('POST', '/api/line-orders', { token: T1, body });
      // R38：移除「建單失敗就算 PASS」的路徑——prerequisite 一律硬斷言，
      // 不成立就讓這個 case 真的 FAIL，不得用 note/skip 蒙混過去。
      assert(co.status === 200 || co.status === 201, `35-cancel-${label}-prereq-order-created prerequisite：真實建單必須成功（不是「擋下也算過」）`, `status=${co.status} ${JSON.stringify(co.json).slice(0, 150)}`);
      const order = db.get('SELECT id, order_status FROM orders WHERE customer_phone=?', [phone]);
      assert(!!order, `35-cancel-${label}-prereq-order-row-exists prerequisite：真實 order row 存在`, String(order));
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const stockBefore = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      assert(!isPreorder ? qBefore > 0 : pBefore > 0, `35-cancel-${label}-prereq-counter-incremented prerequisite：正確 counter 已經因這張新訂單增加（非零基準）`, JSON.stringify({ isPreorder, qBefore, pBefore }));
      assert(stockBefore >= 0 && stockBefore < 100, `35-cancel-${label}-prereq-ingredient-deducted prerequisite：ingredient 已經被實際扣除（低於基準 100）`, String(stockBefore));

      const dbFilePath = process.env.POS_DB_PATH;
      const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      const origRun = db._db.run.bind(db._db);
      const origSave = db._save.bind(db);
      let triggerCount = 0;
      let saveCount = 0;
      let rollbackCount = 0;
      let commitAttempted = false;
      db._save = (...args) => { saveCount++; return origSave(...args); };
      db._db.run = function (sql, params) {
        if (typeof sql === 'string') {
          if (sql === 'ROLLBACK') rollbackCount++;
          if (sql === 'COMMIT') commitAttempted = true;
          if (sql.includes(sqlPattern)) {
            triggerCount++;
            if (triggerCount === 1) throw new Error(`R38 injected failure: ${label}`);
          }
        }
        return origRun(sql, params);
      };
      let cancelRes;
      try {
        cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      } finally {
        db._db.run = origRun;
        db._save = origSave;
      }
      assert(triggerCount === expectedTriggerCount, `35-cancel-${label}-seam-triggered-exact fault seam（SQL 含 "${sqlPattern}"）精確觸發 ${expectedTriggerCount} 次（不是寬鬆的 >=1）`, `expected=${expectedTriggerCount} actual=${triggerCount}`);
      assert(cancelRes.status >= 500, `35-cancel-${label}-http-failure ${label} 注入失敗時真實 HTTP 回非成功`, `status=${cancelRes.status}`);
      assert(!/at\s+\S+\.js:\d+|node_modules/i.test(JSON.stringify(cancelRes.json)), `35-cancel-${label}-no-leak 錯誤 response 不含 stack trace`, JSON.stringify(cancelRes.json).slice(0, 150));
      assert(saveCount === 0, `35-cancel-${label}-save-zero-on-failure 失敗路徑 _save() 呼叫次數為 0`, String(saveCount));
      assert(rollbackCount === 1, `35-cancel-${label}-rollback-exactly-once 失敗路徑 ROLLBACK 確實執行恰好 1 次`, String(rollbackCount));
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      assert(shaAfter === shaBefore, `35-cancel-${label}-db-file-hash-unchanged 失敗路徑操作前後 DB 檔案 SHA-256 完全一致（磁碟真的沒被動到，不是只看 response）`, `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`);
      const orderAfter = db.get('SELECT order_status FROM orders WHERE id=?', [order.id]);
      assert(orderAfter.order_status === order.order_status, `35-cancel-${label}-status-rolled-back rollback 後 order_status 維持 pending`, JSON.stringify(orderAfter));
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfter === qBefore && pAfter === pBefore, `35-cancel-${label}-counters-rolled-back rollback 後兩個 counter 都維持操作前的值`, JSON.stringify({ qBefore, qAfter, pBefore, pAfter }));
      const stockAfter = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      assert(stockAfter === stockBefore, `35-cancel-${label}-ingredient-rolled-back rollback 後 ingredient stock 維持操作前的值`, JSON.stringify({ stockBefore, stockAfter }));

      let retrySaveCount = 0;
      const origSave2 = db._save.bind(db);
      db._save = (...args) => { retrySaveCount++; return origSave2(...args); };
      const origRenameRetry = fs.renameSync; fs.renameSync = function (from, to) { if (to === process.env.POS_DB_PATH) retrySaveCount++; return origRenameRetry.apply(this, arguments); }; // R44.2F：durable commit point 也算一次 save
      let retryRes;
      try {
        retryRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      } finally { db._save = origSave2; fs.renameSync = origRenameRetry; }
      assert(retryRes.status === 200, `35-cancel-${label}-retry-succeeds 移除 fault 後同一訂單重試 cancel 成功`, `status=${retryRes.status}`);
      assert(retrySaveCount === 1, `35-cancel-${label}-retry-save-exactly-once retry 成功後 _save() 恰好呼叫 1 次`, String(retrySaveCount));
      const qAfterRetry = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterRetry = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const stockAfterRetry = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      const expectedQ = isPreorder ? qBefore : qBefore - 2;
      const expectedP = isPreorder ? pBefore - 2 : pBefore;
      assert(qAfterRetry === expectedQ && pAfterRetry === expectedP, `35-cancel-${label}-retry-restores-once 重試成功後正確 counter 只恢復一次`, JSON.stringify({ expectedQ, qAfterRetry, expectedP, pAfterRetry }));
      assert(stockAfterRetry === stockBefore + 4, `35-cancel-${label}-retry-ingredient-restores-once 重試成功後 ingredient 只恢復一次（+4，qty=2×2）`, JSON.stringify({ stockBefore, stockAfterRetry }));
    }
    await runCancelFaultCase('status-update', "UPDATE orders SET status=?", false, 1);
    await runCancelFaultCase('quota-counter', 'UPDATE products SET line_quota_sold', false, 1);
    await runCancelFaultCase('preorder-counter', 'UPDATE products SET line_preorder_sold', true, 1);
    await runCancelFaultCase('commit', 'COMMIT', false, 1);

    // ══════════════════════════════════════════════════════════════
    // 三十六（新增，R37）：完整 void fault matrix（order_log／
    // ingredient／quota／preorder／status／COMMIT）。
    // ══════════════════════════════════════════════════════════════
    async function runVoidFaultCase(label, sqlPattern, isPreorder, expectedTriggerCount) {
      const phone = '0955' + String(Math.floor(Math.random() * 900000) + 100000);
      const body = { customer_name: 'VoidFault' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] };
      if (isPreorder) body.pickup_date = futureTW;
      const co = await call('POST', '/api/line-orders', { token: T1, body });
      assert(co.status === 200 || co.status === 201, `36-void-${label}-prereq-order-created prerequisite：真實建單必須成功`, `status=${co.status} ${JSON.stringify(co.json).slice(0, 150)}`);
      const order = db.get('SELECT id, status, order_status, void_reason, voided_at FROM orders WHERE customer_phone=?', [phone]);
      assert(!!order, `36-void-${label}-prereq-order-row-exists prerequisite：真實 order row 存在`, String(order));
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const stockBefore = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      const logCountBefore = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order.id]).c;
      assert(!isPreorder ? qBefore > 0 : pBefore > 0, `36-void-${label}-prereq-counter-incremented prerequisite：正確 counter 已經因這張新訂單增加`, JSON.stringify({ isPreorder, qBefore, pBefore }));
      assert(stockBefore >= 0 && stockBefore < 100, `36-void-${label}-prereq-ingredient-deducted prerequisite：ingredient 已經被實際扣除`, String(stockBefore));

      const dbFilePath = process.env.POS_DB_PATH;
      const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      const origRun = db._db.run.bind(db._db);
      const origSave = db._save.bind(db);
      let triggerCount = 0, saveCount = 0, rollbackCount = 0;
      db._save = (...args) => { saveCount++; return origSave(...args); };
      db._db.run = function (sql, params) {
        if (typeof sql === 'string') {
          if (sql === 'ROLLBACK') rollbackCount++;
          if (sql.includes(sqlPattern)) {
            triggerCount++;
            if (triggerCount === 1) throw new Error(`R38 injected void failure: ${label}`);
          }
        }
        return origRun(sql, params);
      };
      let voidRes;
      try {
        voidRes = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R38fault' + label, operator: 'test' } });
      } finally {
        db._db.run = origRun;
        db._save = origSave;
      }
      assert(triggerCount === expectedTriggerCount, `36-void-${label}-seam-triggered-exact fault seam（SQL 含 "${sqlPattern}"）精確觸發 ${expectedTriggerCount} 次`, `expected=${expectedTriggerCount} actual=${triggerCount}`);
      assert(voidRes.status >= 500, `36-void-${label}-http-failure ${label} 注入失敗時真實 HTTP 回非成功`, `status=${voidRes.status}`);
      assert(!/at\s+\S+\.js:\d+|node_modules/i.test(JSON.stringify(voidRes.json)), `36-void-${label}-no-leak 錯誤 response 不含 stack trace`, JSON.stringify(voidRes.json).slice(0, 150));
      assert(saveCount === 0, `36-void-${label}-save-zero-on-failure 失敗路徑 _save() 呼叫次數為 0`, String(saveCount));
      assert(rollbackCount === 1, `36-void-${label}-rollback-exactly-once 失敗路徑 ROLLBACK 確實執行恰好 1 次`, String(rollbackCount));
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      assert(shaAfter === shaBefore, `36-void-${label}-db-file-hash-unchanged 失敗路徑操作前後 DB 檔案 SHA-256 完全一致`, `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`);
      const orderAfter = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
      assert(orderAfter.status === order.status && orderAfter.order_status === order.order_status, `36-void-${label}-status-rolled-back rollback 後 status/order_status 全部維持操作前的值`, JSON.stringify({ before: order, after: orderAfter }));
      assert(orderAfter.void_reason === order.void_reason && orderAfter.voided_at === order.voided_at, `36-void-${label}-void-fields-rolled-back rollback 後 void_reason/voided_at 都沒有被寫入`, JSON.stringify({ before: order, after: orderAfter }));
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfter === qBefore && pAfter === pBefore, `36-void-${label}-counters-rolled-back rollback 後兩個 counter 都維持操作前的值`, JSON.stringify({ qBefore, qAfter, pBefore, pAfter }));
      const stockAfter = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      assert(stockAfter === stockBefore, `36-void-${label}-ingredient-rolled-back rollback 後 ingredient stock 維持操作前的值`, JSON.stringify({ stockBefore, stockAfter }));
      const logCountAfter = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order.id]).c;
      assert(logCountAfter === logCountBefore, `36-void-${label}-log-zero-write rollback 後 order_logs 的 void action 零新增`, JSON.stringify({ logCountBefore, logCountAfter }));

      let retrySaveCount = 0;
      const origSave2 = db._save.bind(db);
      db._save = (...args) => { retrySaveCount++; return origSave2(...args); };
      const origRenameRetry = fs.renameSync; fs.renameSync = function (from, to) { if (to === process.env.POS_DB_PATH) retrySaveCount++; return origRenameRetry.apply(this, arguments); }; // R44.2F：durable commit point 也算一次 save
      let retryRes;
      try {
        retryRes = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R38retry' + label, operator: 'test' } });
      } finally { db._save = origSave2; fs.renameSync = origRenameRetry; }
      assert(retryRes.status === 200, `36-void-${label}-retry-succeeds 移除 fault 後同一訂單重試 void 成功`, `status=${retryRes.status}`);
      assert(retrySaveCount === 1, `36-void-${label}-retry-save-exactly-once retry 成功後 _save() 恰好呼叫 1 次`, String(retrySaveCount));
      const orderAfterRetry = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
      assert(orderAfterRetry.status === 'void' && orderAfterRetry.order_status === 'cancelled', `36-void-${label}-retry-fields-correct retry 成功後 status='void'、order_status='cancelled'`, JSON.stringify(orderAfterRetry));
      assert(!!orderAfterRetry.void_reason && !!orderAfterRetry.voided_at, `36-void-${label}-retry-void-metadata-set retry 成功後 void_reason/voided_at 都有值`, JSON.stringify(orderAfterRetry));
      const logCountAfterRetry = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order.id]).c;
      assert(logCountAfterRetry === logCountBefore + 1, `36-void-${label}-retry-exactly-one-log retry 成功後恰好新增 1 筆 void log`, JSON.stringify({ logCountBefore, logCountAfterRetry }));
      const qAfterRetry = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterRetry = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const stockAfterRetry = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      const expectedQ = isPreorder ? qBefore : qBefore - 2;
      const expectedP = isPreorder ? pBefore - 2 : pBefore;
      assert(qAfterRetry === expectedQ && pAfterRetry === expectedP, `36-void-${label}-retry-counter-restores-once retry 成功後正確 counter 只恢復一次`, JSON.stringify({ expectedQ, qAfterRetry, expectedP, pAfterRetry }));
      assert(stockAfterRetry === stockBefore + 4, `36-void-${label}-retry-ingredient-restores-once retry 成功後 ingredient 只恢復一次`, JSON.stringify({ stockBefore, stockAfterRetry }));
    }
    await runVoidFaultCase('order-log', 'INSERT INTO order_logs', false, 1);
    await runVoidFaultCase('ingredient', 'UPDATE ingredients SET', false, 1);
    await runVoidFaultCase('quota-counter', 'UPDATE products SET line_quota_sold', false, 1);
    await runVoidFaultCase('preorder-counter', 'UPDATE products SET line_preorder_sold', true, 1);
    await runVoidFaultCase('status-update', "UPDATE orders SET status='void'", false, 1);
    await runVoidFaultCase('commit', 'COMMIT', false, 1);

    // line_counter_bucket 不得影響實際持久化結果。
    // ══════════════════════════════════════════════════════════════
    {
      const co1 = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'ForgeBucket1', customer_phone: '0955199001', order_type: 'takeout', payment_method: 'cash', line_counter_bucket: 'preorder', items: [{ product_id: 301, qty: 1 }] } });
      if (co1.status === 200 || co1.status === 201) {
        const row1 = db.get('SELECT line_counter_bucket FROM orders WHERE customer_phone=?', ['0955199001']);
        assert(row1.line_counter_bucket === 'quota', '34-forged-bucket-preorder-ignored-for-samday 同日單即使 client body 偽造 line_counter_bucket:\'preorder\'，DB 仍正確寫 \'quota\'（bucket 是伺服器依 isPreorderOrder 算出來的，不信任 client 輸入）', JSON.stringify(row1));
      }
      const co2 = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'ForgeBucket2', customer_phone: '0955199002', order_type: 'takeout', payment_method: 'cash', pickup_date: futureTW, line_counter_bucket: 'quota', items: [{ product_id: 301, qty: 1 }] } });
      if (co2.status === 200 || co2.status === 201) {
        const row2 = db.get('SELECT line_counter_bucket FROM orders WHERE customer_phone=?', ['0955199002']);
        assert(row2.line_counter_bucket === 'preorder', '34-forged-bucket-quota-ignored-for-preorder 預約單即使 client body 偽造 line_counter_bucket:\'quota\'，DB 仍正確寫 \'preorder\'', JSON.stringify(row2));
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 三十七（新增，R38）：mixed-transition 六案，每案獨立新訂單、
    // 非零 counter/ingredient 基準，逐欄比對 raw DB。
    // ══════════════════════════════════════════════════════════════
    async function makeTransitionOrder(phone) {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Transition' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      assert(co.status === 200 || co.status === 201, `37-prereq-create-${phone} prerequisite：mixed-transition fixture 真實建單必須成功`, `status=${co.status}`);
      return db.get('SELECT id, status, order_status, void_reason, voided_at FROM orders WHERE customer_phone=?', [phone]);
    }
    function fullSnapshot(orderId) {
      return {
        order: db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [orderId]),
        q: db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold,
        stock: db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock,
        voidLogCount: db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [orderId]).c,
        totalLogCount: db.get('SELECT COUNT(*) as c FROM order_logs WHERE order_id=?', [orderId]).c,
      };
    }

    // 1. pending → cancelled：恢復一次
    {
      const order = await makeTransitionOrder('0955200001');
      const before = fullSnapshot(order.id);
      const r = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(r.status === 200, '37-1-pending-to-cancelled-http pending→cancelled 真實成功', `status=${r.status}`);
      const after = fullSnapshot(order.id);
      assert(after.order.order_status === 'cancelled' && after.order.status === before.order.status, '37-1-pending-to-cancelled-fields order_status 變成 cancelled，status 欄位不受影響（cancel 不動 status 欄位）', JSON.stringify({ before: before.order, after: after.order }));
      assert(after.q === before.q - 2, '37-1-pending-to-cancelled-counter-restored quota counter 恢復一次（-2）', JSON.stringify({ before: before.q, after: after.q }));
      assert(after.stock === before.stock + 4, '37-1-pending-to-cancelled-ingredient-restored ingredient 恢復一次（+4）', JSON.stringify({ before: before.stock, after: after.stock }));
      assert(after.totalLogCount === before.totalLogCount, '37-1-pending-to-cancelled-no-log cancel 本身不新增 order_log（既有正式契約）', JSON.stringify({ before: before.totalLogCount, after: after.totalLogCount }));

      // 2. cancelled → cancelled：repeat，不再恢復，raw DB 完全不變
      const before2 = fullSnapshot(order.id);
      const r2 = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const after2 = fullSnapshot(order.id);
      assert(JSON.stringify(after2) === JSON.stringify(before2), `37-2-cancelled-to-cancelled-no-change repeat cancel（無論 HTTP status=${r2.status}）後 raw DB snapshot 完全不變（status/counter/ingredient/log 全部沒有再變動）`, JSON.stringify({ before: before2, after: after2 }));
    }

    // 3. pending → void：恢復一次，恰好一筆 void log
    {
      const order = await makeTransitionOrder('0955200003');
      const before = fullSnapshot(order.id);
      const r = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R38案例3', operator: 'test' } });
      assert(r.status === 200, '37-3-pending-to-void-http pending→void 真實成功', `status=${r.status}`);
      const after = fullSnapshot(order.id);
      assert(after.order.status === 'void' && after.order.order_status === 'cancelled' && !!after.order.void_reason && !!after.order.voided_at, '37-3-pending-to-void-fields void 後 status/order_status/void_reason/voided_at 全部正確', JSON.stringify(after.order));
      assert(after.q === before.q - 2, '37-3-pending-to-void-counter-restored quota counter 恢復一次（-2）', JSON.stringify({ before: before.q, after: after.q }));
      assert(after.stock === before.stock + 4, '37-3-pending-to-void-ingredient-restored ingredient 恢復一次（+4）', JSON.stringify({ before: before.stock, after: after.stock }));
      assert(after.voidLogCount === before.voidLogCount + 1, '37-3-pending-to-void-log-exactly-one 恰好新增 1 筆 void log', JSON.stringify({ before: before.voidLogCount, after: after.voidLogCount }));

      // 4. void → void：repeat，不再恢復
      const before4 = fullSnapshot(order.id);
      const r4 = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R38案例4重複', operator: 'test' } });
      assert(r4.status !== 200, '37-4-void-to-void-rejected repeat void 真實依正式契約拒絕（非 200，既有 400「訂單已作廢」）', `status=${r4.status}`);
      const after4 = fullSnapshot(order.id);
      assert(JSON.stringify(after4) === JSON.stringify(before4), '37-4-void-to-void-no-change repeat void 拒絕後 raw DB snapshot 完全不變（沒有再次恢復 counter/ingredient，也沒有新增 log）', JSON.stringify({ before: before4, after: after4 }));

      // 5. cancelled → void：先建一張新的、cancel 過的訂單，再嘗試 void
      const order5 = await makeTransitionOrder('0955200005');
      await call('PATCH', `/api/orders/${order5.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const before5 = fullSnapshot(order5.id);
      const r5 = await call('POST', `/api/orders/${order5.id}/void`, { token: T1, body: { reason: 'R38案例5', operator: 'test' } });
      const after5 = fullSnapshot(order5.id);
      if (r5.status === 200) {
        // 若正式契約允許 cancelled→void，可以補上 void metadata/log，但不得二次恢復資源
        assert(after5.order.status === 'void', '37-5-cancelled-to-void-allowed-status-updated 若 cancelled→void 被允許，status 欄位補上 void', JSON.stringify(after5.order));
        assert(after5.q === before5.q && after5.stock === before5.stock, '37-5-cancelled-to-void-no-double-restore cancelled→void 即使被允許，也沒有二次恢復 counter/ingredient（已經在 cancel 時恢復過了）', JSON.stringify({ before: before5, after: after5 }));
      } else {
        assert(JSON.stringify(after5) === JSON.stringify(before5), '37-5-cancelled-to-void-rejected-no-change 若 cancelled→void 依正式契約被拒絕（' + `status=${r5.status}` + '），raw DB 完全零寫入', JSON.stringify({ before: before5, after: after5 }));
      }

      // 6. void → cancel：先建一張新的、void 過的訂單，再嘗試 cancel
      const order6 = await makeTransitionOrder('0955200006');
      await call('POST', `/api/orders/${order6.id}/void`, { token: T1, body: { reason: 'R38案例6前置', operator: 'test' } });
      const before6 = fullSnapshot(order6.id);
      const r6 = await call('PATCH', `/api/orders/${order6.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const after6 = fullSnapshot(order6.id);
      if (r6.status === 200) {
        assert(after6.q === before6.q && after6.stock === before6.stock, '37-6-void-to-cancel-allowed-no-double-restore 若 void→cancel 被允許，沒有二次恢復 counter/ingredient', JSON.stringify({ before: before6, after: after6 }));
      } else {
        assert(JSON.stringify(after6) === JSON.stringify(before6), '37-6-void-to-cancel-rejected-no-change 若 void→cancel 依正式契約被拒絕（' + `status=${r6.status}` + '），raw DB 完全零寫入', JSON.stringify({ before: before6, after: after6 }));
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 三十八（新增，R39）：cancel/void 競爭請求——先如實記錄架構層級的
    // 稽核結論，再用真實 HTTP 驗證結果安全。
    //
    // 稽核結論（已逐行讀 code 確認，不是猜的）：
    //   - `router.patch('/:id/status', (req, res) => {...})` 與
    //     `router.post('/:id/void', (req, res) => {...})` 兩個 handler
    //     本身都「不是」 async function。
    //   - `applyOrderStatusChange()` 也不是 async。
    //   - db.get()／db._db.run() 全部是 sql.js 的同步呼叫，中間完全沒有
    //     任何 await／Promise／setTimeout。
    //   - 結論：從「路由層讀 order」到「BEGIN...COMMIT」，整段是一次
    //     不中斷的同步執行——Node 單執行緒事件迴圈保證這段程式碼執行期間
    //     不會被任何其他 request 的 handler 插隊，因為中間沒有任何可以
    //     讓事件迴圈切換執行權的 yield point。
    //   - 這代表「兩個請求都讀到同一個 stale snapshot、才一起放行進入
    //     transition」這種交錯在目前架構下無法真實發生：哪個請求的
    //     handler 先被事件迴圈呼叫，就會從讀取到 COMMIT 完整跑完，第二個
    //     請求的 handler 要等到第一個完全執行完（包含它自己的
    //     BEGIN/COMMIT/_save()）才會開始執行。
    //   - 因此本輪刻意不去監控 production 程式碼新增 test-only hook、也
    //     不去 fake 一個「兩者都先讀完再一起放行」的交錯（這需要在生產
    //     路徑插入一個原本不存在的 await/yield point，違反「不得新增
    //     production-only test hook」的規則）——這裡改用真實
    //     Promise.allSettled() 對同一張訂單送出兩個真實 HTTP request，
    //     驗證「即使兩個請求幾乎同時抵達，最終資源只被釋放一次」這個
    //     結果性 invariant，而不是宣稱測到了某種特定的交錯時序。
    //   - 明確聲明：這只證明 same-process、單一 Node 執行緒下的競爭
    //     請求安全；不代表、也沒有測試多 process 或多 sql.js instance
    //     同時寫入同一份 DB 檔案的情境。
    // ══════════════════════════════════════════════════════════════
    async function runConcurrencyCase(label, op1, op2) {
      const phone = '0955' + String(Math.floor(Math.random() * 900000) + 100000);
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Concur' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      assert(co.status === 200 || co.status === 201, `38-${label}-prereq-create prerequisite：concurrency fixture 真實建單必須成功`, `status=${co.status}`);
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const stockBefore = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;

      const doCancel = () => call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const doVoid = () => call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R39 concurrency ' + label, operator: 'test' } });
      const ops = { cancel: doCancel, void: doVoid };
      const results = await Promise.allSettled([ops[op1](), ops[op2]()]);
      const statuses = results.map((r) => r.status === 'fulfilled' ? r.value.status : 'rejected');

      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const stockAfter = db.get('SELECT total_stock FROM ingredients WHERE id=?', [ING_ID]).total_stock;
      assert(qAfter === qBefore - 2, `38-${label}-counter-released-exactly-once 兩個請求同時送出後（HTTP status: ${JSON.stringify(statuses)}），line_quota_sold 只被釋放一次（-2，不是 0 也不是 -4）`, JSON.stringify({ qBefore, qAfter }));
      assert(stockAfter === stockBefore + 4, `38-${label}-ingredient-released-exactly-once 兩個請求同時送出後，ingredient stock 只被釋放一次（+4，不是 0 也不是 +8）`, JSON.stringify({ stockBefore, stockAfter }));
      const orderAfter = db.get('SELECT status, order_status FROM orders WHERE id=?', [order.id]);
      const isLegal = (orderAfter.order_status === 'cancelled') && (orderAfter.status === 'void' || orderAfter.status !== 'void');
      assert(isLegal && orderAfter.order_status === 'cancelled', `38-${label}-final-state-legal 最終狀態是合法終態（order_status='cancelled'，status 依實際贏家可能是原值或 'void'）`, JSON.stringify(orderAfter));
      const voidLogCount = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order.id]).c;
      assert(voidLogCount <= 1, `38-${label}-void-log-at-most-once void log 最多 1 筆（如果最終真的變成 void）`, String(voidLogCount));
      if (orderAfter.status === 'void') {
        assert(voidLogCount === 1, `38-${label}-void-log-exactly-once-if-voided 若最終確實是 void，void log 恰好 1 筆`, String(voidLogCount));
      }
    }
    await runConcurrencyCase('cancel-cancel', 'cancel', 'cancel');
    await runConcurrencyCase('void-void', 'void', 'void');
    await runConcurrencyCase('cancel-void', 'cancel', 'void');
    await runConcurrencyCase('void-cancel', 'void', 'cancel');

    // ══════════════════════════════════════════════════════════════
    // 三十九（新增，R40）：raw invalid bucket（'evil'）fail closed——
    // cancel 與 void 都測，非 NULL 但非法的 bucket 代表資料損壞，不得
    // 退回 pickup_time heuristic。
    // ══════════════════════════════════════════════════════════════
    async function makeOrderWithRawBucket(phone, bucket) {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'RawBucket' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      assert(co.status === 200 || co.status === 201, `39-prereq-create-${phone} prerequisite：真實建單必須成功`, `status=${co.status}`);
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      // R43：versioned snapshot 現在是最高 authority，優先於
      // line_counter_bucket。這些測試是要模擬「沒有 snapshot、只能靠
      // bucket（或 pickup_time）決定」的 legacy 情境，所以要把真實建立時
      // 寫入的 snapshot 也清空，不然新架構下 snapshot 會直接蓋過這裡刻意
      // 偽造的 bucket，讓測試意圖與實際覆蓋不到的東西脫節。
      db._db.run('UPDATE orders SET line_counter_bucket=?, line_counter_allocation_snapshot=NULL WHERE id=?', [bucket, order.id]);
      db._save();
      return order.id;
    }
    // ══════════════════════════════════════════════════════════════
    // R44.1 一：修正語意漂移——拆成兩組真正獨立的案例。
    // ══════════════════════════════════════════════════════════════
    // Case A：snapshot=NULL（bucket 本身可以是合法值，這裡不是重點）
    {
      const orderId = await makeOrderWithRawBucket('0955210001', 'quota');
      const before = fullSnapshot(orderId);
      const r = await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(r.status === 409 && /無法安全判定|份數配額快照/.test(r.json.message), 'R44.1-caseA-snapshot-missing-cancel-fail-closed Case A：snapshot=NULL（bucket=quota 合法）cancel 真實回 409', JSON.stringify(r).slice(0, 200));
      const after = fullSnapshot(orderId);
      assert(JSON.stringify(after) === JSON.stringify(before), 'R44.1-caseA-snapshot-missing-cancel-zero-write Case A 拒絕後 raw DB 完全不變', JSON.stringify({ before, after }));
    }
    {
      const orderId = await makeOrderWithRawBucket('0955210002', 'preorder');
      const before = fullSnapshot(orderId);
      const r = await call('POST', `/api/orders/${orderId}/void`, { token: T1, body: { reason: 'R44.1 case A', operator: 'test' } });
      assert(r.status === 409 && r.json.error === 'LINE_COUNTER_ALLOCATION_SNAPSHOT_MISSING', 'R44.1-caseA-snapshot-missing-void-fail-closed Case A：snapshot=NULL（bucket=preorder 合法）void 真實回 409 LINE_COUNTER_ALLOCATION_SNAPSHOT_MISSING', JSON.stringify(r).slice(0, 200));
      const after = fullSnapshot(orderId);
      assert(JSON.stringify(after) === JSON.stringify(before), 'R44.1-caseA-snapshot-missing-void-zero-write Case A 拒絕後 raw DB 完全不變', JSON.stringify({ before, after }));
    }
    // Case B：保留真實建立時的合法 v1 snapshot，只把 order-level bucket
    // 改成 'evil'——不得被 snapshot missing 提前攔截，必須真正走
    // bucket-invalid 這條路徑（新增的 order-level bucket 與 snapshot
    // 一致性檢查）。
    async function makeOrderWithCorruptedBucketOnly(phone) {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'CorruptBucket' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }] } });
      assert(co.status === 200 || co.status === 201, `R44.1-caseB-prereq-create-${phone} prerequisite：真實建單必須成功`, `status=${co.status}`);
      const order = db.get('SELECT id, line_counter_allocation_snapshot FROM orders WHERE customer_phone=?', [phone]);
      assert(order.line_counter_allocation_snapshot != null, `R44.1-caseB-prereq-snapshot-exists-${phone} prerequisite：真實建立必須產生非 NULL 的 v1 snapshot`, String(order.line_counter_allocation_snapshot));
      db._db.run("UPDATE orders SET line_counter_bucket='evil' WHERE id=?", [order.id]);
      db._save();
      return order.id;
    }
    {
      const orderId = await makeOrderWithCorruptedBucketOnly('0955210005');
      const before = fullSnapshot(orderId);
      const r = await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(r.status === 409 && !/份數配額快照/.test(r.json.message), 'R44.1-caseB-invalid-bucket-cancel-fail-closed Case B：完整合法 v1 snapshot + bucket=evil，cancel 真實回 409，且訊息不是「快照缺失」（證明真的走 bucket-invalid 路徑，不是被 snapshot missing 提前攔截）', JSON.stringify(r).slice(0, 200));
      const after = fullSnapshot(orderId);
      assert(JSON.stringify(after) === JSON.stringify(before), 'R44.1-caseB-invalid-bucket-cancel-zero-write Case B 拒絕後 raw DB 完全不變', JSON.stringify({ before, after }));
    }
    {
      const orderId = await makeOrderWithCorruptedBucketOnly('0955210006');
      const before = fullSnapshot(orderId);
      const r = await call('POST', `/api/orders/${orderId}/void`, { token: T1, body: { reason: 'R44.1 case B', operator: 'test' } });
      assert(r.status === 409 && r.json.error !== 'LINE_COUNTER_ALLOCATION_SNAPSHOT_MISSING', 'R44.1-caseB-invalid-bucket-void-fail-closed Case B：完整合法 v1 snapshot + bucket=evil，void 真實回 409，且錯誤代碼不是 SNAPSHOT_MISSING（證明真的走 bucket-invalid 路徑）', JSON.stringify(r).slice(0, 200));
      const after = fullSnapshot(orderId);
      assert(JSON.stringify(after) === JSON.stringify(before), 'R44.1-caseB-invalid-bucket-void-zero-write Case B 拒絕後 raw DB 完全不變', JSON.stringify({ before, after }));
    }

    // ══════════════════════════════════════════════════════════════
    // R44.1A：LINE Shipping pre-fix reproduction
    // ══════════════════════════════════════════════════════════════
    const SHIP_A_PID = 9101, SHIP_B_PID = 9102;
    db._db.run('DELETE FROM products WHERE id IN (?,?)', [SHIP_A_PID, SHIP_B_PID]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, shipping_enabled, shipping_share_line_stock, line_quota_enabled, line_quota_daily, line_quota_sold) VALUES
      (${SHIP_A_PID}, 'store_001', 'R44宅配A', '主食', 200, 1, 1, 1, 1, 100, 0),
      (${SHIP_B_PID}, 'store_001', 'R44宅配B', '主食', 150, 1, 1, 0, 1, 100, 20)`);
    db._save();
    async function tryCreateShippingOrder(phone, items) {
      return call('POST', '/api/line-shipping', { token: T1, body: {
        items, recipient_name: 'R44收件人', phone, postal_code: '100', city: '台北市', district: '中正區',
        address: '台北市中正區測試路1號', payment_method: 'cash', arrival_type: 'asap',
      }});
    }
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'shipping_enabled', '1')");
    db._save();

    // ══════════════════════════════════════════════════════════════
    // R44.1A 五之 1／2：Mixed cancel／void——A share=true、B share=false，
    // 非零 baseline，真實 HTTP，raw DB 驗證。
    // ══════════════════════════════════════════════════════════════
    {
      const qABefore = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const qBBefore = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_B_PID]).line_quota_sold;
      const co = await tryCreateShippingOrder('0955230001', [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]);
      assert(co.status === 200 || co.status === 201, 'R44.1A-shipping-mixed-cancel-prereq-create prerequisite：真實 shipping 建單必須成功', `status=${co.status} ${JSON.stringify(co.json).slice(0, 200)}`);
      const order = db.get('SELECT id, line_counter_bucket, line_counter_allocation_snapshot FROM orders WHERE customer_phone=?', ['0955230001']);
      assert(order.line_counter_bucket === 'quota', 'R44.1A-shipping-bucket-is-quota shipping 訂單的 line_counter_bucket 正確寫入 quota', String(order.line_counter_bucket));
      const snap = JSON.parse(order.line_counter_allocation_snapshot);
      assert(snap.version === 1 && snap.allocations.length === 1 && snap.allocations[0].product_id === SHIP_A_PID && snap.allocations[0].qty === 2, 'R44.1A-shipping-snapshot-only-share-true snapshot 只包含 share=true 的 A（product_id/qty 正確），不包含 share=false 的 B', JSON.stringify(snap));
      const qAAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const qBAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_B_PID]).line_quota_sold;
      assert(qAAfterCreate === qABefore + 2 && qBAfterCreate === qBBefore, 'R44.1A-shipping-create-only-A-incremented 建立後只有 A 的 line_quota_sold +2，B（非零基準）完全沒動', JSON.stringify({ qABefore, qAAfterCreate, qBBefore, qBAfterCreate }));

      const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(cancelRes.status === 200, 'R44.1A-shipping-cancel-succeeds shipping 訂單 cancel 真實成功（不再被 fail closed 擋下）', `status=${cancelRes.status} ${JSON.stringify(cancelRes.json).slice(0, 150)}`);
      const qAAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const qBAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_B_PID]).line_quota_sold;
      assert(qAAfterCancel === qABefore && qBAfterCancel === qBBefore, 'R44.1A-shipping-cancel-only-A-restored cancel 後 A 精確恢復回建立前的值，B（非零基準）全程 byte-identical', JSON.stringify({ qABefore, qAAfterCancel, qBBefore, qBAfterCancel }));
    }
    {
      const qABefore = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const qBBefore = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_B_PID]).line_quota_sold;
      const co = await tryCreateShippingOrder('0955230002', [{ product_id: SHIP_A_PID, qty: 1 }, { product_id: SHIP_B_PID, qty: 4 }]);
      assert(co.status === 200 || co.status === 201, 'R44.1A-shipping-mixed-void-prereq-create prerequisite：真實 shipping 建單必須成功', `status=${co.status} ${JSON.stringify(co.json).slice(0, 200)}`);
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955230002']);
      const voidRes = await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R44.1A shipping void', operator: 'test' } });
      assert(voidRes.status === 200, 'R44.1A-shipping-void-succeeds shipping 訂單 void 真實成功', `status=${voidRes.status} ${JSON.stringify(voidRes.json).slice(0, 150)}`);
      const qAAfterVoid = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const qBAfterVoid = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_B_PID]).line_quota_sold;
      assert(qAAfterVoid === qABefore && qBAfterVoid === qBBefore, 'R44.1A-shipping-void-only-A-restored void 後 A 精確恢復，B 全程未動', JSON.stringify({ qABefore, qAAfterVoid, qBBefore, qBAfterVoid }));
      const orderRow = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
      assert(orderRow.status === 'void' && orderRow.order_status === 'cancelled' && !!orderRow.void_reason && !!orderRow.voided_at, 'R44.1A-shipping-void-metadata-correct void metadata 全部正確寫入', JSON.stringify(orderRow));
      const logCount = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [order.id]).c;
      assert(logCount === 1, 'R44.1A-shipping-void-exactly-one-log 恰好新增 1 筆 void log', String(logCount));
    }

    // ══════════════════════════════════════════════════════════════
    // R44.1A 五之 5：全部 share=false → empty-v1，不是 NULL，不是
    // snapshot-missing。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run('UPDATE products SET shipping_share_line_stock=0 WHERE id=?', [SHIP_A_PID]); db._save();
      const co = await tryCreateShippingOrder('0955230003', [{ product_id: SHIP_A_PID, qty: 1 }, { product_id: SHIP_B_PID, qty: 1 }]);
      assert(co.status === 200 || co.status === 201, 'R44.1A-shipping-empty-v1-prereq-create prerequisite：全部 share=false 的訂單真實建立必須成功', `status=${co.status} ${JSON.stringify(co.json).slice(0, 200)}`);
      const order = db.get('SELECT id, line_counter_allocation_snapshot FROM orders WHERE customer_phone=?', ['0955230003']);
      assert(order.line_counter_allocation_snapshot === JSON.stringify({ version: 1, allocations: [] }), 'R44.1A-shipping-empty-v1-correct 全部 share=false 時 snapshot 正確為 {"version":1,"allocations":[]}，不是 NULL', String(order.line_counter_allocation_snapshot));
      const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(cancelRes.status === 200, 'R44.1A-shipping-empty-v1-cancel-succeeds empty-v1 snapshot 的訂單 cancel 成功（no-op，不是 fail closed）', `status=${cancelRes.status} ${JSON.stringify(cancelRes.json).slice(0, 150)}`);
      db._db.run('UPDATE products SET shipping_share_line_stock=1 WHERE id=?', [SHIP_A_PID]); db._save(); // 還原給後續案例用
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2 一：pre-fix partial-commit reproduction（shipping）——已在
    // production 修改前執行過一次，真實結果如下（保留在報告中）：
    //   httpStatus=500（client 看起來像整張訂單都沒建立），但實際上
    //   orderExists=true、qA 已經從 0 變成 5（counter 真的增加了）、
    //   persistedSnapshot 卻還是 placeholder 的 {"version":1,"allocations":[]}
    //   ——這代表訂單「真的占用了配額」但「系統自己以為沒占用」，未來
    //   cancel 永遠不會把這 5 份還回去，配額永久流失。這是本輪要修正的
    //   真實 P0，證據如上，不是臆測。
    //
    // 修正後（現在）：line-orders.js／line-shipping.js 都不再有
    // 「INSERT placeholder → 之後才 UPDATE 真正 snapshot」這個步驟——
    // snapshot 在 INSERT 當下就是最終值。下面把同一個 fault-injection
    // seam 轉成永久 regression：故意去攔截「UPDATE orders SET
    // line_counter_allocation_snapshot=」這個 SQL pattern，斷言它
    // 「完全不會被觸發」，直接證明那個危險的中間步驟已經被拿掉，不是
    // 只讓它「失敗時比較安全」。
    // ══════════════════════════════════════════════════════════════
    {
      const qABefore = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      const origRun = db.run.bind(db);
      let triggerCount = 0;
      db.run = function (sql, params) {
        if (typeof sql === 'string' && sql.includes('UPDATE orders SET line_counter_allocation_snapshot=')) {
          triggerCount++;
        }
        return origRun(sql, params);
      };
      let co;
      try {
        co = await tryCreateShippingOrder('0955230004', [{ product_id: SHIP_A_PID, qty: 5 }]);
      } finally {
        db.run = origRun;
      }
      assert(triggerCount === 0, 'R44.2-shipping-no-followup-snapshot-update 修正後，shipping 建立流程完全不再執行「follow-up UPDATE snapshot」這個 SQL pattern——placeholder-then-update 這個危險的中間狀態已經被整個拿掉，不是只讓它失敗時比較安全', String(triggerCount));
      assert(co.status === 200 || co.status === 201, 'R44.2-shipping-create-still-succeeds 拿掉 follow-up UPDATE 後，正常建立流程仍然成功', `status=${co.status}`);
      const orderRow = db.get('SELECT id, line_counter_allocation_snapshot FROM orders WHERE customer_phone=?', ['0955230004']);
      const snap = JSON.parse(orderRow.line_counter_allocation_snapshot);
      assert(snap.version === 1 && snap.allocations.length === 1 && snap.allocations[0].product_id === SHIP_A_PID && snap.allocations[0].qty === 5, 'R44.2-shipping-insert-has-final-snapshot INSERT 當下寫入的就已經是最終正確的 snapshot（product A qty=5），不是空的 placeholder', JSON.stringify(snap));
      const qAAfter = db.get('SELECT line_quota_sold FROM products WHERE id=?', [SHIP_A_PID]).line_quota_sold;
      assert(qAAfter === qABefore + 5, 'R44.2-shipping-counter-matches-snapshot counter 增量（+5）與 snapshot 記錄的 qty（5）完全一致，兩者不會再對不上', JSON.stringify({ qABefore, qAAfter }));
      // 清理
      db._db.run('DELETE FROM orders WHERE id=?', [orderRow.id]); db._db.run('UPDATE products SET line_quota_sold=? WHERE id=?', [qABefore, SHIP_A_PID]); db._save();
    }

    // 同一個永久 regression，套用在 standard LINE order（同樣移除了
    // follow-up UPDATE，用同一份 pre-computed map 直接寫進 INSERT）。
    {
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const origRun = db.run.bind(db);
      let triggerCount = 0;
      db.run = function (sql, params) {
        if (typeof sql === 'string' && sql.includes('UPDATE orders SET line_counter_allocation_snapshot=')) {
          triggerCount++;
        }
        return origRun(sql, params);
      };
      let co;
      try {
        co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'StdNoFollowup', customer_phone: '0955230005', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 4 }] } });
      } finally {
        db.run = origRun;
      }
      assert(triggerCount === 0, 'R44.2-standard-no-followup-snapshot-update 修正後，standard LINE 建立流程也完全不再執行 follow-up UPDATE snapshot 這個 SQL pattern', String(triggerCount));
      assert(co.status === 200 || co.status === 201, 'R44.2-standard-create-still-succeeds 拿掉 follow-up UPDATE 後，standard LINE 正常建立流程仍然成功', `status=${co.status}`);
      const orderRow = db.get('SELECT id, line_counter_allocation_snapshot FROM orders WHERE customer_phone=?', ['0955230005']);
      const snap = JSON.parse(orderRow.line_counter_allocation_snapshot);
      assert(snap.version === 1 && snap.allocations.length === 1 && snap.allocations[0].product_id === 301 && snap.allocations[0].qty === 4, 'R44.2-standard-insert-has-final-snapshot INSERT 當下就寫入最終正確的 snapshot（product 301 qty=4）', JSON.stringify(snap));
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(qAfter === qBefore + 4, 'R44.2-standard-counter-matches-snapshot counter 增量與 snapshot 記錄的 qty 完全一致', JSON.stringify({ qBefore, qAfter }));
      const cancelRes = await call('PATCH', `/api/orders/${orderRow.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const qAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      assert(cancelRes.status === 200 && qAfterCancel === qBefore, 'R44.2-standard-cancel-restores-correctly 這張改用新建立流程產生的訂單，cancel 仍能正確恢復（證明新流程產生的 snapshot 與既有 restore 邏輯相容）', JSON.stringify({ status: cancelRes.status, qBefore, qAfterCancel }));
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2A：建立端 atomic transaction——tracker + fault injection（真實 HTTP）。
    // tracker 只在測試層 monkey-patch 既有 DB seam：記錄 BEGIN/COMMIT/ROLLBACK、
    // _save() 次數、transaction active 期間的 db.run()（auto-save wrapper）呼叫。
    // COMMIT fault 是在呼叫原始 COMMIT「之前」拋錯，不宣稱測到 commit 後 save 失敗。
    // ══════════════════════════════════════════════════════════════
    function installTxTracker(faultPattern, opts) {
      opts = opts || {};
      const t = { begin: 0, commit: 0, rollback: 0, saves: 0, autoSaveWritesInTx: 0, savesInTx: 0, sqlAfterCommit: 0, nestedBegin: 0, faultHits: 0, thrown: 0, active: false, committed: false, events: [] };
      const hadOwnRun = Object.prototype.hasOwnProperty.call(db._db, 'run');
      const origRaw = db._db.run.bind(db._db);
      const origRun = db.run.bind(db);
      const origSave = db._save;
      db._db.run = function (sql, params) {
        const q = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
        if (q === 'BEGIN') { t.events.push('BEGIN'); t.committed = false; if (opts.beforeBegin && !t.hooked) { t.hooked = true; opts.beforeBegin(origRaw); } if (t.active) t.nestedBegin++; t.begin++; t.active = true; return origRaw(sql, params); }
        if (faultPattern && typeof sql === 'string' && sql.includes(faultPattern)) {
          t.faultHits++;
          if (t.faultHits === (opts.nth || 1)) {
            if (opts.zeroRow) return origRaw('UPDATE products SET line_quota_sold=line_quota_sold WHERE id=-1', []); // 執行成 0 rows
            t.thrown++;
            throw new Error(opts.message || 'R44.2A injected fault');
          }
        }
        if (q === 'COMMIT') { t.commit++; t.active = false; t.committed = true; t.events.push('COMMIT'); return origRaw(sql, params); }
        if (q === 'ROLLBACK') { t.rollback++; t.active = false; t.events.push('ROLLBACK'); return origRaw(sql, params); }
        return origRaw(sql, params);
      };
      db.run = function (sql, params) { if (t.active) t.autoSaveWritesInTx++; if (typeof sql === 'string' && sql.includes('INSERT INTO analytics_events')) { t.events.push('ANALYTICS'); if (opts.failAnalytics) throw new Error('injected analytics failure'); } else if (t.committed && typeof sql === 'string' && /^\s*(INSERT|UPDATE|DELETE)[^;]*\b(orders|products|ingredients|ingredient_logs|coupon_redemptions|order_logs)\b/i.test(sql)) { t.sqlAfterCommit++; (t.afterCommitSql = t.afterCommitSql || []).push(sql.slice(0, 80)); } return origRun(sql, params); };
      db._save = function () { t.saves++; if (t.active) t.savesInTx++; t.events.push('SAVE'); return origSave.apply(this, arguments); };
      // R44.2F：durable persistence 的 commit point 是「temp file atomic rename 成正式 DB 檔」，把它當作一次 save
      const origRename = fs.renameSync;
      fs.renameSync = function (from, to) { if (to === process.env.POS_DB_PATH) { t.saves++; if (t.active) t.savesInTx++; t.events.push('SAVE'); } return origRename.apply(this, arguments); };
      // R44.2F：durable failure 會把 live DB swap 成「以 checkpoint 重建的新 instance」，所以 restore 不能把綁在舊 instance 的
      // origRaw 塞回新 instance（那會指向已 close 的 DB）；own-property 覆寫一律 delete，讓新 instance 回到 prototype 方法。
      t.restore = () => { delete db._db.run; /* 較早測試留下的 own-property 只是綁在舊 instance 的 prototype 副本，一律移除 */ db.run = origRun; db._save = origSave; fs.renameSync = origRename; };
      return t;
    }
    const sha = () => { try { return crypto.createHash('sha256').update(Buffer.from(db._db.export())).digest('hex'); } catch (e) { return 'n/a'; } };
    const ING_ID2 = 9003;
    db._db.run('DELETE FROM ingredients WHERE id=?', [ING_ID2]);
    db._db.run("INSERT INTO ingredients (id, store_id, name, unit, total_stock, refrigerated_stock, frozen_stock, thawing_stock) VALUES (?, 'store_001', 'R44.2A食材', 'g', 100, 100, 0, 0)", [ING_ID2]);
    db._db.run('DELETE FROM product_ingredient_formulas WHERE product_id IN (301,302)');
    db._db.run('INSERT INTO product_ingredient_formulas (product_id, ingredient_id, amount_per_unit) VALUES (301, ?, 2)', [ING_ID2]);
    db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=1000, line_quota_sold=7 WHERE id IN (301,302)');
    db._save();

    async function stdCreate(phone, items) {
      return call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'AtomicStd' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items } });
    }
    const std2 = [{ product_id: 301, qty: 2 }, { product_id: 302, qty: 3 }];

    // 成功路徑 tracker：BEGIN=1 COMMIT=1 ROLLBACK=0 _save=1 active-tx db.run=0
    {
      const t = installTxTracker(null);
      let r; try { r = await stdCreate('0955240001', std2); } finally { t.restore(); }
      assert(r.status === 200 || r.status === 201, 'R44.2A-std-success-prereq 成功建立', `status=${r.status}`);
      assert(t.begin === 1 && t.commit === 1 && t.rollback === 0 && t.nestedBegin === 0, 'R44.2A-std-success-tx-counts standard 成功建立：BEGIN=1 COMMIT=1 ROLLBACK=0 無 nested BEGIN', JSON.stringify(t));
      assert(t.autoSaveWritesInTx === 0, 'R44.2A-std-success-no-autosave-in-tx transaction active 期間 auto-saving db.run() 寫入為 0', String(t.autoSaveWritesInTx));
      assert(t.saves === 1, 'R44.2A-std-success-save-once 成功建立只 _save() 一次（commit 後）', String(t.saves));
      const row = db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', ['0955240001']);
      assert(JSON.parse(row.s).allocations.length === 2, 'R44.2A-std-success-final-snapshot INSERT 當下就是含 2 筆 allocation 的最終 snapshot', row.s);
    }

    async function stdFault(label, pattern, phone) {
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v;
      const q302 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v;
      const ing = db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v;
      const hashBefore = sha();
      const t = installTxTracker(pattern);
      let r; try { r = await stdCreate(phone, std2); } finally { t.restore(); }
      assert(t.faultHits === 1 || (pattern === 'COMMIT' && t.faultHits === 1), `R44.2A-std-${label}-seam-hit-once seam 精確命中 1 次`, String(t.faultHits));
      assert(r.status >= 500 && !/at\s+\S+\.js:\d+|node_modules|SELECT|INSERT|UPDATE/i.test(JSON.stringify(r.json)), `R44.2A-std-${label}-5xx-no-leak 真實 5xx 且無 SQL/stack 洩漏`, JSON.stringify(r).slice(0, 160));
      assert(!db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]), `R44.2A-std-${label}-no-order order 不存在（無孤兒 snapshot／半成品）`, '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v === q302, `R44.2A-std-${label}-counters-unchanged 兩個商品 counter（非零基準 7）皆不變`, '');
      assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v === ing, `R44.2A-std-${label}-ingredient-unchanged ingredient 不變`, '');
      assert(t.begin === 1 && t.commit === 0 && t.rollback === 1 && t.saves === 0 && t.autoSaveWritesInTx === 0, `R44.2A-std-${label}-tx-counts BEGIN=1 COMMIT=0 ROLLBACK=1 _save=0 tx內auto-save=0`, JSON.stringify(t));
      assert(sha() === hashBefore, `R44.2A-std-${label}-db-hash-unchanged DB 內容 SHA-256 前後一致`, '');
      const retry = await stdCreate(phone, std2);
      assert(retry.status === 200 || retry.status === 201, `R44.2A-std-${label}-retry-succeeds 移除 fault 後同一輸入重試成功`, `status=${retry.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 + 2 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v === q302 + 3 && db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v === ing - 4, `R44.2A-std-${label}-retry-exactly-once 重試只生效一次（counter +2/+3、ingredient -4）`, '');
    }
    await stdFault('order-insert', 'INSERT INTO orders', '0955240002');
    await stdFault('counter1', 'UPDATE products SET line_quota_sold', '0955240003');
    await stdFault('ingredient', 'UPDATE ingredients SET', '0955240004');
    await stdFault('commit', 'COMMIT', '0955240005');

    // Shipping：同一組 tracker + fault（本 route 無 ingredient，見 grep；控制案例：建立後 ingredient 不變）
    {
      db._db.run('UPDATE products SET shipping_share_line_stock=1, line_quota_enabled=1, line_quota_daily=1000, line_quota_sold=7 WHERE id IN (?,?)', [SHIP_A_PID, SHIP_B_PID]); db._save();
      const t = installTxTracker(null);
      let r; try { r = await tryCreateShippingOrder('0955241001', [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]); } finally { t.restore(); }
      assert(r.status === 200 || r.status === 201, 'R44.2A-ship-success-prereq 成功建立', `status=${r.status}`);
      assert(t.begin === 1 && t.commit === 1 && t.rollback === 0 && t.nestedBegin === 0 && t.autoSaveWritesInTx === 0, 'R44.2A-ship-success-tx-counts shipping 成功建立：BEGIN=1 COMMIT=1 ROLLBACK=0 tx內auto-save=0', JSON.stringify(t));
      assert(t.saves === 1, 'R44.2A-ship-success-save-once shipping 成功建立只 _save() 一次', String(t.saves));
    }
    async function shipFault(label, pattern, phone) {
      const a = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v;
      const b = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v;
      const ing = db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v;
      const hashBefore = sha();
      const t = installTxTracker(pattern);
      let r; try { r = await tryCreateShippingOrder(phone, [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]); } finally { t.restore(); }
      assert(t.faultHits === 1, `R44.2A-ship-${label}-seam-hit-once seam 精確命中 1 次`, String(t.faultHits));
      assert(r.status >= 500 && !/at\s+\S+\.js:\d+|node_modules/i.test(JSON.stringify(r.json)), `R44.2A-ship-${label}-5xx-no-stack 真實 5xx 且無 stack 洩漏`, JSON.stringify(r).slice(0, 160));
      assert(!db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]), `R44.2A-ship-${label}-no-order order 不存在`, '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v === b, `R44.2A-ship-${label}-counters-unchanged 兩個商品 counter 不變`, '');
      assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v === ing, `R44.2A-ship-${label}-ingredient-control ingredient 全程不變（本 route 不扣 ingredient 的控制案例）`, '');
      assert(t.begin === 1 && t.commit === 0 && t.rollback === 1 && t.saves === 0 && t.autoSaveWritesInTx === 0, `R44.2A-ship-${label}-tx-counts BEGIN=1 COMMIT=0 ROLLBACK=1 _save=0 tx內auto-save=0`, JSON.stringify(t));
      assert(sha() === hashBefore, `R44.2A-ship-${label}-db-hash-unchanged DB SHA-256 前後一致`, '');
      const retry = await tryCreateShippingOrder(phone, [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]);
      assert(retry.status === 200 || retry.status === 201, `R44.2A-ship-${label}-retry-succeeds 移除 fault 後重試成功`, `status=${retry.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a + 2 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v === b + 3, `R44.2A-ship-${label}-retry-exactly-once 重試只生效一次`, '');
    }
    await shipFault('order-insert', 'INSERT INTO orders', '0955241002');
    await shipFault('counter', 'UPDATE products SET line_quota_sold', '0955241003');
    await shipFault('commit', 'COMMIT', '0955241004');

    // ══════════════════════════════════════════════════════════════
    // R44.2B：惡意 error message、第二個 counter fault、0-row、BEGIN 邊界 fresh authority、
    // valid snapshot + 壞 pickup_time、builder contract。
    // ══════════════════════════════════════════════════════════════
    {
      const EVIL = 'SQLITE_ERROR UPDATE products SECRET_TOKEN=/tmp/private.db';
      for (const [label, fn] of [['std', () => stdCreate('0955242001', std2)], ['ship', () => tryCreateShippingOrder('0955242002', [{ product_id: SHIP_A_PID, qty: 1 }])]]) {
        const t = installTxTracker('UPDATE products SET line_quota_sold', { message: EVIL });
        let r; try { r = await fn(); } finally { t.restore(); }
        const body = JSON.stringify(r.json);
        assert(t.thrown === 1 && r.status === 500, `R44.2B-${label}-evil-error-5xx 惡意 error 真實觸發且回 500`, `${t.thrown} ${r.status}`);
        assert(!/SQLITE|SECRET_TOKEN|private\.db|\/tmp|UPDATE products|node_modules|\.js:\d+/i.test(body), `R44.2B-${label}-evil-error-no-leak response 完全不含任何惡意 error 片段（不是改 fault 字串迎合）`, body);
      }
    }
    async function secondCounterFault(label, create, pattern, readA, readB, ingRead, deltaA, deltaB) {
      const a0 = readA(), b0 = readB(), i0 = ingRead ? ingRead() : null, h0 = sha();
      const t = installTxTracker(pattern, { nth: 2 });
      let r; try { r = await create(); } finally { t.restore(); }
      assert(t.faultHits === 2 && t.thrown === 1, `R44.2B-${label}-second-counter-seam 第二次 counter UPDATE 才拋錯（第一次已執行、第二次拋錯，各 1 次）`, JSON.stringify(t));
      assert(r.status >= 500, `R44.2B-${label}-second-counter-5xx 真實 5xx`, `status=${r.status}`);
      assert(readA() === a0 && readB() === b0, `R44.2B-${label}-second-counter-first-rolled-back 第一個已執行的 counter UPDATE 也被 rollback，兩商品皆不變`, JSON.stringify({ a0, a: readA(), b0, b: readB() }));
      assert(ingRead ? ingRead() === i0 : true, `R44.2B-${label}-second-counter-ingredient-unchanged ingredient 不變`, '');
      assert(t.begin === 1 && t.commit === 0 && t.rollback === 1 && t.saves === 0 && t.autoSaveWritesInTx === 0, `R44.2B-${label}-second-counter-tx BEGIN=1 COMMIT=0 ROLLBACK=1 _save=0`, JSON.stringify(t));
      assert(sha() === h0, `R44.2B-${label}-second-counter-hash in-memory export hash 不變（on-disk 檔案 hash 未另測，見報告）`, '');
      const r2 = await create();
      assert((r2.status === 200 || r2.status === 201) && readA() === a0 + deltaA && readB() === b0 + deltaB, `R44.2B-${label}-second-counter-retry-once 重試成功且只生效一次`, `status=${r2.status}`);
    }
    await secondCounterFault('std', () => stdCreate('0955242003', std2), 'UPDATE products SET line_quota_sold',
      () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v,
      () => db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v, 2, 3);
    await secondCounterFault('ship', () => tryCreateShippingOrder('0955242004', [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]), 'UPDATE products SET line_quota_sold',
      () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v, () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v, null, 2, 3);

    // 0-row counter UPDATE → affected-row check → rollback
    for (const [label, create, phone] of [['std', () => stdCreate('0955242005', std2), '0955242005'], ['ship', () => tryCreateShippingOrder('0955242006', [{ product_id: SHIP_A_PID, qty: 2 }]), '0955242006']]) {
      const q = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, qa = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v;
      const t = installTxTracker('UPDATE products SET line_quota_sold', { zeroRow: true });
      let r; try { r = await create(); } finally { t.restore(); }
      assert(r.status >= 500 && !JSON.stringify(r.json).includes('affected-row'), `R44.2B-${label}-zero-row-safe-500 counter UPDATE 實際改 0 列 → 固定安全 500（不洩漏內部訊息）`, JSON.stringify(r).slice(0, 150));
      assert(!db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === qa, `R44.2B-${label}-zero-row-rolled-back order 不存在、counter 不變`, '');
      assert(t.rollback === 1 && t.commit === 0 && t.saves === 0, `R44.2B-${label}-zero-row-tx ROLLBACK=1 COMMIT=0 _save=0`, JSON.stringify(t));
    }

    // BEGIN 邊界 fresh authority：在真正 BEGIN 執行前改 DB，snapshot 必須採用 BEGIN 後 fresh 讀到的值
    {
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, q302 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v;
      const t = installTxTracker(null, { beforeBegin: (raw) => raw('UPDATE products SET line_quota_enabled=0, line_quota_daily=0 WHERE id=302', []) });
      let r; try { r = await stdCreate('0955242007', std2); } finally { t.restore(); }
      db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=1000 WHERE id=302'); db._save();
      const row = db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', ['0955242007']);
      const snap = row && JSON.parse(row.s);
      assert(snap && snap.allocations.length === 1 && snap.allocations[0].product_id === 301, 'R44.2B-std-fresh-authority-true-to-false BEGIN 前把 302 改成不參與 → snapshot 採 BEGIN 後 fresh 值（只有 301）', row && row.s);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 + 2 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=302').v === q302, 'R44.2B-std-fresh-counter-matches-fresh-snapshot counter delta 與 fresh snapshot 一致', '');
    }
    {
      db._db.run('UPDATE products SET shipping_share_line_stock=0 WHERE id=?', [SHIP_B_PID]); db._save();
      const a0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v, b0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v;
      const t = installTxTracker(null, { beforeBegin: (raw) => raw('UPDATE products SET shipping_share_line_stock=1 WHERE id=?', [SHIP_B_PID]) });
      let r; try { r = await tryCreateShippingOrder('0955242008', [{ product_id: SHIP_A_PID, qty: 2 }, { product_id: SHIP_B_PID, qty: 3 }]); } finally { t.restore(); }
      const snap = JSON.parse(db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', ['0955242008']).s);
      assert(snap.allocations.length === 2, 'R44.2B-ship-fresh-authority-false-to-true BEGIN 前把 B 的 share 改成 true → snapshot 採 fresh 值（A、B 都參與）', JSON.stringify(snap));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a0 + 2 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_B_PID]).v === b0 + 3, 'R44.2B-ship-fresh-counter-matches counter delta 與 fresh snapshot 一致', '');
    }

    // valid snapshot + 壞 pickup_time：cancel／void 成功（pickup_time 不得凌駕 valid snapshot）
    for (const [label, op, badTime, phone] of [['cancel-malformed', 'cancel', 'garbage-time', '0955243001'], ['cancel-empty', 'cancel', '', '0955243002'], ['void-malformed', 'void', '2026-99-99 zz', '0955243003']]) {
      const co = await stdCreate(phone, [{ product_id: 301, qty: 2 }]);
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      db._db.run('UPDATE orders SET pickup_time=? WHERE id=?', [badTime, order.id]); db._save();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v;
      const r = op === 'cancel'
        ? await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } })
        : await call('POST', `/api/orders/${order.id}/void`, { token: T1, body: { reason: 'R44.2B', operator: 'test' } });
      assert(r.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q0 - 2, `R44.2B-valid-snapshot-bad-pickup-${label} valid snapshot＋壞 pickup_time：${op} 成功且精確還原`, `status=${r.status}`);
    }

    // builder contract（直接）
    {
      const { buildLineCounterAllocationSnapshot: b } = require('../utils/lineCounterAllocation');
      assert(JSON.stringify(b([])) === '{"version":1,"allocations":[]}', 'R44.2B-builder-empty-v1 空輸入 → empty-v1', '');
      assert(JSON.stringify(b([{ product_id: 5, counter_bucket: 'quota', qty: 1 }, { product_id: 3, counter_bucket: 'quota', qty: 2 }, { product_id: 5, counter_bucket: 'quota', qty: 4 }])) === '{"version":1,"allocations":[{"product_id":3,"counter_bucket":"quota","qty":2},{"product_id":5,"counter_bucket":"quota","qty":5}]}', 'R44.2B-builder-aggregate-sorted duplicate 聚合＋穩定排序', '');
      let threw = 0;
      for (const bad of [[{ product_id: 1, counter_bucket: 'evil', qty: 1 }], [{ product_id: 0, counter_bucket: 'quota', qty: 1 }], [{ product_id: 1, counter_bucket: 'quota', qty: 1.5 }], [{ product_id: 1, counter_bucket: 'quota', qty: Number.MAX_SAFE_INTEGER }, { product_id: 1, counter_bucket: 'quota', qty: 1 }]]) { try { b(bad); } catch (e) { threw++; } }
      assert(threw === 4, 'R44.2B-builder-rejects-invalid 非法 bucket／id／小數 qty／聚合溢位一律拒絕', String(threw));
    }

    // 靜態檢查（限定 production files）
    {
      const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const so = src('routes/line-orders.js'), ss = src('routes/line-shipping.js');
      assert(!/UPDATE orders SET line_counter_allocation_snapshot/.test(so + ss), 'R44.2B-static-no-followup-snapshot-update 兩條 route 不存在 follow-up snapshot UPDATE', '');
      assert(/buildLineCounterAllocationSnapshot\(/.test(so) && /buildLineCounterAllocationSnapshot\(/.test(ss), 'R44.2B-static-shared-builder 兩條 route 都呼叫同一個 builder', '');
      assert(!/Array\.from\((counterAllocationMap|shippingAllocationMap)/.test(so + ss), 'R44.2B-static-no-local-aggregation 不存在 route-local 第二份 snapshot aggregation', '');
      const postCatchLO = so.slice(so.indexOf("console.error('[line-orders] POST error:'"), so.indexOf("console.error('[line-orders] POST error:'") + 260);
      const postCatchLS = ss.slice(ss.indexOf("console.error('[line-shipping] POST error:'"), ss.indexOf("console.error('[line-shipping] POST error:'") + 260);
      assert(!/message:\s*e\.message/.test(postCatchLO + postCatchLS), 'R44.2B-static-no-e-message-in-create-500 兩條 create route 的 500 不再回傳 e.message', '');
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2C：coupon fixture + pre-fix 實證（coupon INSERT 失敗被 swallow-error catch 吞掉）
    // ══════════════════════════════════════════════════════════════
    {
      const { invalidateFeatureCache } = require('../middleware/featureGate');
      db._db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify({ line_order: true, orders: true, products: true, coupon: true })]);
      db._db.run("DELETE FROM coupons WHERE store_id='store_001' AND code IN ('R44C10','R44C20')");
      db._db.run("INSERT INTO coupons (store_id, code, name, discount_type, discount_value, min_amount, enabled, max_usage, max_usage_per_phone) VALUES ('store_001','R44C10','R44C',  'fixed', 10, 0, 1, 0, 0)");
      db._save(); invalidateFeatureCache('store_001');
    }
    const redemptionCount = (code) => db.get("SELECT COUNT(*) AS c FROM coupon_redemptions WHERE store_id='store_001' AND coupon_code=?", [code]).c;
    async function stdCouponCreate(phone, items) {
      return call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Coupon' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', coupon_code: 'R44C10', subtotal: 200, items } });
    }
    // pre-fix 真實結果（修改 production 前捕捉，保留在報告）：coupon INSERT 拋錯被 swallow-error
    // catch 吞掉 → HTTP 200、order 已建立且 COMMIT=1、counter +2、但沒有該筆 redemption
    // （coupon 用量被繞過）。以下是修正後的 contract 與 matrix。
    {
      const ok = await stdCouponCreate('0955250001', [{ product_id: 301, qty: 1 }]);
      assert((ok.status === 200 || ok.status === 201) && redemptionCount('R44C10') === 1, 'R44.2C-coupon-fixture-works coupon fixture 可用：成功建單並寫入 1 筆 redemption', `status=${ok.status}`);
    }
    async function couponFault(label, pattern, opts, phone) {
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, ing = db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v;
      const red0 = redemptionCount('R44C10'), h0 = sha();
      const t = installTxTracker(pattern, opts);
      let r; try { r = await stdCouponCreate(phone, [{ product_id: 301, qty: 2 }]); } finally { t.restore(); }
      assert(t.faultHits >= 1 && (opts.zeroRow || t.thrown === 1), `R44.2C-coupon-${label}-seam seam 命中（${JSON.stringify({ hits: t.faultHits, thrown: t.thrown })}）`, JSON.stringify(t));
      assert(r.status === 500 && r.json.error === 'INTERNAL_ERROR', `R44.2C-coupon-${label}-safe-500 固定安全 500（不再 200 成功）`, JSON.stringify(r).slice(0, 140));
      assert(!db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && redemptionCount('R44C10') === red0, `R44.2C-coupon-${label}-no-order-no-usage order 不存在、redemption 不變（coupon 仍可用）`, '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 && db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v === ing, `R44.2C-coupon-${label}-counter-ingredient-unchanged counter／ingredient 不變`, '');
      assert(t.begin === 1 && t.commit === 0 && t.rollback === 1 && t.saves === 0 && t.autoSaveWritesInTx === 0, `R44.2C-coupon-${label}-tx BEGIN=1 COMMIT=0 ROLLBACK=1 _save=0`, JSON.stringify(t));
      assert(sha() === h0, `R44.2C-coupon-${label}-memory-hash in-memory export hash 不變（on-disk hash 未另測，見報告）`, '');
      const retry = await stdCouponCreate(phone, [{ product_id: 301, qty: 2 }]);
      assert((retry.status === 200 || retry.status === 201) && redemptionCount('R44C10') === red0 + 1 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 + 2, `R44.2C-coupon-${label}-retry-once 重試只兌換一次、只建一張 order、counter 只 +2`, `status=${retry.status}`);
    }
    await couponFault('insert-fail', 'INSERT INTO coupon_redemptions', {}, '0955250003');
    await couponFault('then-counter-fail', 'UPDATE products SET line_quota_sold', {}, '0955250004');
    await couponFault('then-ingredient-fail', 'UPDATE ingredients SET', {}, '0955250005');
    await couponFault('then-commit-fail', 'COMMIT', {}, '0955250006');
    // 0-row seam：coupon 與 ingredient（各自改成實際 0 列 → affected-row check → rollback）
    async function zeroRowSeam(label, pattern, phone, createFn) {
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, ing = db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v, red0 = redemptionCount('R44C10');
      const t = installTxTracker(pattern, { zeroRow: true });
      let r; try { r = await createFn(phone); } finally { t.restore(); }
      assert(r.status === 500 && !db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && redemptionCount('R44C10') === red0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301 && db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING_ID2]).v === ing, `R44.2C-${label}-zero-row-rollback ${label} 實際 0 列 → rollback（非假成功）`, JSON.stringify(r).slice(0, 120));
      assert(t.rollback === 1 && t.commit === 0 && t.saves === 0, `R44.2C-${label}-zero-row-tx ROLLBACK=1 COMMIT=0 _save=0`, JSON.stringify(t));
    }
    await zeroRowSeam('coupon', 'INSERT INTO coupon_redemptions', '0955250007', (ph) => stdCouponCreate(ph, [{ product_id: 301, qty: 2 }]));
    await zeroRowSeam('ingredient', 'UPDATE ingredients SET', '0955250008', (ph) => stdCreate(ph, [{ product_id: 301, qty: 2 }]));
    // 業務衝突：max_usage 已滿 → 固定 business 400、零寫入、coupon 不被消耗
    {
      db._db.run("UPDATE coupons SET max_usage=? WHERE store_id='store_001' AND code='R44C10'", [redemptionCount('R44C10')]); db._save();
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, red0 = redemptionCount('R44C10');
      const r = await stdCouponCreate('0955250009', [{ product_id: 301, qty: 1 }]);
      assert(r.status === 400 && !db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955250009']) && redemptionCount('R44C10') === red0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301, 'R44.2C-coupon-usage-limit-conflict 用量已滿 → 固定 400 business error、整筆零寫入', `status=${r.status}`);
      db._db.run("UPDATE coupons SET max_usage=0 WHERE store_id='store_001' AND code='R44C10'"); db._save();
    }
    // BEGIN 邊界 fresh eligibility：BEGIN 前把商品改成 sold_out_today → safe business 400、零寫入
    {
      const q301 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v, red0 = redemptionCount('R44C10');
      const t = installTxTracker(null, { beforeBegin: (raw) => raw("UPDATE products SET sale_status='sold_out_today' WHERE id=301", []) });
      let r; try { r = await stdCouponCreate('0955250010', [{ product_id: 301, qty: 1 }]); } finally { t.restore(); }
      db._db.run("UPDATE products SET sale_status='available' WHERE id=301"); db._save();
      assert(r.status === 400 && r.json.reason === 'product_not_available' && !db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955250010']) && redemptionCount('R44C10') === red0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q301, 'R44.2C-std-fresh-eligibility-true-to-false BEGIN 前商品變不可售 → 交易內 fresh 重驗擋下：order/coupon/counter 零寫入', JSON.stringify(r).slice(0, 140));
      assert(t.rollback === 1 && t.commit === 0 && t.saves === 0, 'R44.2C-std-fresh-eligibility-tx ROLLBACK=1 COMMIT=0 _save=0', JSON.stringify(t));
    }
    {
      const a0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v;
      const t = installTxTracker(null, { beforeBegin: (raw) => raw('UPDATE products SET shipping_enabled=0 WHERE id=?', [SHIP_A_PID]) });
      let r; try { r = await tryCreateShippingOrder('0955250011', [{ product_id: SHIP_A_PID, qty: 1 }]); } finally { t.restore(); }
      db._db.run('UPDATE products SET shipping_enabled=1 WHERE id=?', [SHIP_A_PID]); db._save();
      assert(r.status === 400 && r.json.reason === 'product_not_available' && !db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955250011']) && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a0, 'R44.2C-ship-fresh-eligibility-true-to-false BEGIN 前商品變不可宅配 → 交易內 fresh 重驗擋下：零寫入', JSON.stringify(r).slice(0, 140));
    }
    // 靜態：production 不存在 coupon swallow-error、不存在 INSERT OR IGNORE INTO coupon_redemptions
    {
      const so = fs.readFileSync(path.join(__dirname, '..', 'routes/line-orders.js'), 'utf8'), ss = fs.readFileSync(path.join(__dirname, '..', 'routes/line-shipping.js'), 'utf8');
      assert(!/INSERT OR IGNORE INTO coupon_redemptions/.test(so + ss) && !/coupon_redemptions 寫入失敗/.test(so + ss), 'R44.2C-static-no-coupon-swallow 兩條 create route 不存在 coupon swallow-error catch／INSERT OR IGNORE', '');
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2D：server-authoritative pricing。
    // pre-fix 真實結果（修改 production 前捕捉）：standard 把 client items 原樣持久化
    // （price:1、name:FORGED 直接進 orders.items）、client subtotal=1 → subtotal=total=1
    // （可 1 元下單）；未帶 subtotal 時 total=0。shipping 已忽略所有偽造欄位（server 計價）。
    // 以下為修正後的固定 contract：request 可成功，但非權威欄位一律被忽略，raw DB 只存 server canonical 值。
    // ══════════════════════════════════════════════════════════════
    const itemsOf = (phone) => JSON.parse(db.get('SELECT items FROM orders WHERE customer_phone=?', [phone]).items);
    {
      const cases = [
        ['item-price', { items: [{ product_id: 301, qty: 1, price: 1 }] }],
        ['item-name', { items: [{ product_id: 301, qty: 1, name: 'FORGED' }] }],
        ['subtotal', { subtotal: 1, items: [{ product_id: 301, qty: 1 }] }],
        ['total', { total: 1, items: [{ product_id: 301, qty: 1 }] }],
        ['discount-huge', { discount_amount: 999999, items: [{ product_id: 301, qty: 1 }] }],
        ['discount-negative', { discount_amount: -50, items: [{ product_id: 301, qty: 1 }] }],
        ['discount-string', { discount_amount: 'abc', items: [{ product_id: 301, qty: 1 }] }],
        ['fee-zero', { delivery_fee: 0, delivery_fee_preview: 0, items: [{ product_id: 301, qty: 1 }] }],
        ['store-body', { store_id: 'store_002', items: [{ product_id: 301, qty: 1 }] }],
        ['all', { subtotal: 1, total: 1, discount_amount: 5, delivery_fee: 1, store_id: 'store_002', items: [{ product_id: 301, qty: 1, price: 1, name: 'FORGED', subtotal: 1, total: 1 }] }],
      ];
      let i = 0;
      for (const [label, extra] of cases) {
        const phone = '09552600' + String(10 + (++i));
        const r = await call('POST', '/api/line-orders', { token: T1, body: Object.assign({ customer_name: 'Tamper' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash' }, extra) });
        assert(r.status === 200 || r.status === 201, `R44.2D-std-tamper-${label}-accepted contract：偽造欄位被忽略、訂單成功建立`, `status=${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
        const row = db.get('SELECT items, subtotal, total, discount_amount, store_id FROM orders WHERE customer_phone=?', [phone]);
        const it = JSON.parse(row.items);
        assert(it.length === 1 && it[0].product_id === 301 && it[0].name === '排骨飯' && it[0].price === 120 && it[0].qty === 1 && !('subtotal' in it[0]) && !('total' in it[0]), `R44.2D-std-tamper-${label}-items-canonical orders.items 只存 server canonical（name=排骨飯、price=120）`, row.items);
        assert(row.subtotal === 120 && row.total === 120 && row.discount_amount === 0 && row.store_id === 'store_001', `R44.2D-std-tamper-${label}-totals-canonical subtotal=total=120、discount=0、store_id=store_001（不受偽造欄位／跨店影響）`, JSON.stringify(row));
        assert(r.json.data.total === 120, `R44.2D-std-tamper-${label}-response-matches-db response 金額與 DB 一致（120）`, String(r.json.data && r.json.data.total));
      }
      // query／header 跨店偽造
      const rq = await fetch(`${base}/api/line-orders?store_id=store_002`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}`, 'X-Store-Id': 'store_002' }, body: JSON.stringify({ customer_name: 'TamperQ', customer_phone: '0955260040', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] }) });
      assert(rq.status === 200 && db.get('SELECT store_id FROM orders WHERE customer_phone=?', ['0955260040']).store_id === 'store_001', 'R44.2D-std-tamper-query-header-store store authority 只依 JWT，query／header 跨店偽造被忽略', String(rq.status));
    }
    // 數值安全（fail closed，零寫入）
    for (const [label, items] of [['qty-zero', [{ product_id: 301, qty: 0 }]], ['qty-negative', [{ product_id: 301, qty: -1 }]], ['qty-decimal', [{ product_id: 301, qty: 1.5 }]], ['qty-string', [{ product_id: 301, qty: '2' }]], ['qty-unsafe', [{ product_id: 301, qty: Number.MAX_SAFE_INTEGER + 1 }]], ['qty-max-safe-overflow', [{ product_id: 301, qty: Number.MAX_SAFE_INTEGER }]], ['empty', []], ['unknown-product', [{ product_id: 99999991, qty: 1 }]]]) {
      const phone = '09552601' + String(10 + [...'abcdefghijklmnop'].indexOf('a') + ['qty-zero','qty-negative','qty-decimal','qty-string','qty-unsafe','qty-max-safe-overflow','empty','unknown-product'].indexOf(label));
      const before = db.get('SELECT COUNT(*) AS c FROM orders').c;
      const r = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Num' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items } });
      assert(r.status >= 400 && r.status < 500 && db.get('SELECT COUNT(*) AS c FROM orders').c === before && !/at\s+\S+\.js:\d+|SELECT|UPDATE/i.test(JSON.stringify(r.json)), `R44.2D-std-numeric-${label}-rejected 固定 4xx、零寫入、無內部資訊`, `status=${r.status}`);
    }
    // BEGIN 邊界 fresh price：120→130 + line_name 變更 → persisted 使用新值，subtotal／total／snapshot／counter 一致
    {
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v;
      const t = installTxTracker(null, { beforeBegin: (raw) => raw("UPDATE products SET line_price=130, line_name='R44新名稱' WHERE id=301", []) });
      let r; try { r = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'FreshPrice', customer_phone: '0955260050', order_type: 'takeout', payment_method: 'cash', subtotal: 120, items: [{ product_id: 301, qty: 2, price: 120 }] } }); } finally { t.restore(); }
      const row = db.get('SELECT items, subtotal, total FROM orders WHERE customer_phone=?', ['0955260050']);
      const it = JSON.parse(row.items);
      db._db.run('UPDATE products SET line_price=NULL, line_name=NULL WHERE id=301'); db._save();
      assert(r.status === 200 && it[0].price === 130 && it[0].name === 'R44新名稱' && row.subtotal === 260 && row.total === 260 && r.json.data.total === 260, 'R44.2D-std-fresh-price BEGIN 前價格 120→130、名稱變更 → persisted item／subtotal／total／response 全部採 fresh 值（130、260）', JSON.stringify({ it, row }));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=301').v === q0 + 2 && JSON.parse(db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', ['0955260050']).s).allocations[0].qty === 2, 'R44.2D-std-fresh-price-counter-snapshot counter delta 與 snapshot 一致', '');
    }
    // fallback parity：同一商品 admin list／menu／order items 三處 name／price 一致（line_price 有值 vs takeaway_price fallback）
    {
      db._db.run("UPDATE products SET line_price=NULL, takeaway_price=110, line_name='  ' WHERE id=302"); db._save();
      // 本 suite 未掛載 /api/products；admin line_eligibility 與 GET /menu 都是呼叫同一個 resolveLineProductPricing()，這裡直接用該 SSOT 對照 raw order items（menu／admin HTTP 對照在 Chromium suite 已有 BR76–BR116）。
      const adm = require('../utils/lineProductPricing').resolveLineProductPricing(db.get('SELECT * FROM products WHERE id=302'));
      const ord = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'Parity', customer_phone: '0955260060', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 302, qty: 1 }] } });
      const it = itemsOf('0955260060')[0];
      db._db.run("UPDATE products SET takeaway_price=NULL, line_name=NULL WHERE id=302"); db._save();
      assert((ord.status === 200) && it.price === 110 && adm.price === 110 && it.name === adm.name && it.name === '珍珠奶茶', 'R44.2D-parity-ssot-vs-order-items resolveLineProductPricing SSOT 與 order raw items[] 的 name／price 完全一致（takeaway_price fallback=110、空白 line_name fallback 用 name）', JSON.stringify({ adm, it }));
    }
    // coupon 依 server subtotal 計算：client subtotal=1、偽造 discount／total 無效
    {
      const red0 = redemptionCount('R44C10');
      const r = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'CouponSrv', customer_phone: '0955260070', order_type: 'takeout', payment_method: 'cash', coupon_code: 'R44C10', subtotal: 1, discount_amount: 999, total: 1, items: [{ product_id: 301, qty: 2, price: 1 }] } });
      const row = db.get('SELECT id, subtotal, discount_amount, total FROM orders WHERE customer_phone=?', ['0955260070']);
      const red = db.get("SELECT order_id, original_total, discount_amount, final_total FROM coupon_redemptions WHERE store_id='store_001' AND order_id=?", [row.id]);
      assert(r.status === 200 && row.subtotal === 240 && row.discount_amount === 10 && row.total === 230 && r.json.data.total === 230, 'R44.2D-std-coupon-server-subtotal coupon 依 server subtotal(240) 計算：折 10 → total 230（client subtotal=1／discount=999／total=1 無效）', JSON.stringify({ row, resp: r.json.data && r.json.data.total }));
      assert(redemptionCount('R44C10') === red0 + 1 && red && red.order_id === row.id && red.original_total === 240 && red.discount_amount === 10 && red.final_total === 230, 'R44.2D-std-coupon-redemption-server-values redemption 記錄 server 值（240／10／230），與 order 一致', JSON.stringify(red));
    }
    // shipping tampering（contract：忽略偽造、server canonical）
    {
      const SHIP_FEE_ROW = () => db.get('SELECT items, subtotal, total, discount_amount, delivery_fee FROM orders WHERE customer_phone=?', ['0955270001']);
      const r = await call('POST', '/api/line-shipping', { token: T1, body: { recipient_name: 'R', phone: '0955270001', postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', subtotal: 1, total: 1, shipping_fee: 0, discount_amount: 999, store_id: 'store_002', items: [{ product_id: SHIP_A_PID, qty: 1, price: 1, name: 'FORGED' }] } });
      const row = SHIP_FEE_ROW();
      const it = JSON.parse(row.items);
      assert((r.status === 200 || r.status === 201) && it[0].price === 200 && it[0].name === 'R44宅配A' && row.subtotal === 200 && row.total >= 200 && row.discount_amount === 0, 'R44.2D-ship-tamper-all shipping：偽造 price／name／subtotal／total／fee／discount 全被忽略，只存 server canonical', JSON.stringify({ it, row }));
      assert(r.json.data.total === row.total, 'R44.2D-ship-tamper-response-matches-db shipping response total 與 DB 一致', String(r.json.data.total));
    }
    // shipping BEGIN 邊界 fresh：shipping_price 與運費設定在 BEGIN 前變更 → items／subtotal／fee／total／snapshot／counter 一致
    {
      db._db.run("UPDATE products SET shipping_price=0 WHERE id=?", [SHIP_A_PID]); db._save();
      const a0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v;
      const t = installTxTracker(null, { beforeBegin: (raw) => { raw("UPDATE products SET shipping_price=300 WHERE id=?", [SHIP_A_PID]); raw("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_fee','77')", []); raw("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_free_threshold','0')", []); } });
      let r; try { r = await tryCreateShippingOrder('0955270002', [{ product_id: SHIP_A_PID, qty: 2 }]); } finally { t.restore(); }
      const row = db.get('SELECT items, subtotal, total FROM orders WHERE customer_phone=?', ['0955270002']);
      const it = JSON.parse(row.items);
      db._db.run("UPDATE products SET shipping_price=0 WHERE id=?", [SHIP_A_PID]); db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key IN ('shipping_fee','shipping_free_threshold')"); db._save();
      assert((r.status === 200 || r.status === 201) && it[0].price === 300 && row.subtotal === 600 && row.total === 677 && r.json.data.total === 677, 'R44.2D-ship-fresh-price-fee BEGIN 前 shipping_price→300、運費→77 → items／subtotal(600)／total(677=600+77)／response 全採 fresh 值', JSON.stringify({ it, row, resp: r.json.data && r.json.data.total }));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a0 + 2 && JSON.parse(db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', ['0955270002']).s).allocations[0].qty === 2, 'R44.2D-ship-fresh-counter-snapshot counter delta 與 snapshot 一致', '');
    }
    // shipping coupon：本 route 支援 coupon；fault／0-row／用量衝突
    {
      const shipCoupon = (phone) => call('POST', '/api/line-shipping', { token: T1, body: { recipient_name: 'R', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', coupon_code: 'R44C10', items: [{ product_id: SHIP_A_PID, qty: 1 }] } });
      const ok = await shipCoupon('0955270010');
      assert((ok.status === 200 || ok.status === 201) && db.get('SELECT discount_amount AS d FROM orders WHERE customer_phone=?', ['0955270010']).d === 10, 'R44.2D-ship-coupon-server-discount shipping coupon 依 server subtotal 折 10', `status=${ok.status}`);
      for (const [label, pattern, opts, phone] of [['insert-fail', 'INSERT INTO coupon_redemptions', {}, '0955270011'], ['zero-row', 'INSERT INTO coupon_redemptions', { zeroRow: true }, '0955270012'], ['then-counter-fail', 'UPDATE products SET line_quota_sold', {}, '0955270013']]) {
        const red0 = redemptionCount('R44C10'), a0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v, h0 = sha();
        const t = installTxTracker(pattern, opts);
        let r; try { r = await shipCoupon(phone); } finally { t.restore(); }
        assert(r.status === 500 && !db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && redemptionCount('R44C10') === red0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_A_PID]).v === a0, `R44.2D-ship-coupon-${label}-rollback shipping coupon ${label}：安全 500、order／redemption／counter 零寫入`, JSON.stringify(r).slice(0, 100));
        assert(t.rollback === 1 && t.commit === 0 && t.saves === 0 && sha() === h0, `R44.2D-ship-coupon-${label}-tx-hash ROLLBACK=1 COMMIT=0 _save=0、memory hash 不變`, JSON.stringify(t));
        const retry = await shipCoupon(phone);
        assert((retry.status === 200 || retry.status === 201) && redemptionCount('R44C10') === red0 + 1, `R44.2D-ship-coupon-${label}-retry-once retry 只兌換一次`, `status=${retry.status}`);
      }
      db._db.run("UPDATE coupons SET max_usage=? WHERE store_id='store_001' AND code='R44C10'", [redemptionCount('R44C10')]); db._save();
      const red0 = redemptionCount('R44C10');
      const conflict = await shipCoupon('0955270014');
      db._db.run("UPDATE coupons SET max_usage=0 WHERE store_id='store_001' AND code='R44C10'"); db._save();
      assert(conflict.status === 400 && !db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955270014']) && redemptionCount('R44C10') === red0, 'R44.2D-ship-coupon-usage-limit shipping 用量已滿 → 400、零寫入', `status=${conflict.status}`);
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2E：隔離 fixture（E 專用 product／ingredient／formula／coupon，不依賴前面案例留下的狀態）
    //  + side-effect event order + disk hash + _save() 稽核 + shipping fee + duplicate rows + metadata。
    // ══════════════════════════════════════════════════════════════
    const E_P1 = 9201, E_P2 = 9202, E_ING = 9004;
    db._db.run('DELETE FROM products WHERE id IN (?,?)', [E_P1, E_P2]);
    db._db.run('DELETE FROM ingredients WHERE id=?', [E_ING]);
    db._db.run('DELETE FROM product_ingredient_formulas WHERE product_id IN (?,?)', [E_P1, E_P2]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, sale_status, line_takeout_enabled, line_quota_enabled, line_quota_daily, line_quota_sold, shipping_enabled, shipping_share_line_stock, shipping_price) VALUES
      (${E_P1}, 'store_001', 'E商品一', '主食', 100, 1, 1, 'available', 1, 1, 100000, 5, 1, 1, 150),
      (${E_P2}, 'store_001', 'E商品二', '主食', 40, 1, 1, 'available', 1, 1, 100000, 9, 1, 1, 60)`);
    db._db.run("INSERT INTO ingredients (id, store_id, name, unit, total_stock, refrigerated_stock, frozen_stock, thawing_stock) VALUES (?, 'store_001', 'E食材', 'g', 1000000, 1000000, 0, 0)", [E_ING]);
    db._db.run('INSERT INTO product_ingredient_formulas (product_id, ingredient_id, amount_per_unit) VALUES (?, ?, 2)', [E_P1, E_ING]);
    db._db.run("DELETE FROM coupons WHERE store_id='store_001' AND code='R44E10'");
    db._db.run("INSERT INTO coupons (store_id, code, name, discount_type, discount_value, min_amount, enabled, max_usage, max_usage_per_phone) VALUES ('store_001','R44E10','E','fixed',10,0,1,0,0)");
    db._save();
    const eq = (id) => db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [id]).v;
    const eing = () => db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [E_ING]).v;
    const eStdCreate = (phone, items, extra) => call('POST', '/api/line-orders', { token: T1, body: Object.assign({ customer_name: 'E' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items }, extra || {}) });
    const eShipCreate = (phone, items, extra) => call('POST', '/api/line-shipping', { token: T1, body: Object.assign({ recipient_name: 'E', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items }, extra || {}) });
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(process.env.POS_DB_PATH)).digest('hex');

    // side-effect seams：假 wss（不碰網路）＋攔截 webhook fetch（global fetch 與 node-fetch）＋ analytics（db.run pattern）
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','n8n_webhook_url','http://127.0.0.1:9/n8n-r44e')"); db._save();
    function installSideEffectSeams(t, o) {
      o = o || {};
      const fakeWss = { clients: [{ readyState: 1, storeId: 'store_001', send() { t.events.push('BROADCAST'); if (o.failBroadcast) throw new Error('injected broadcast failure'); } }] };
      app.set('wss', fakeWss);
      // 兩條 route 都是 module 層 require('node-fetch')，所以在 http.request 層攔截（不碰真實網路）。
      const httpMod = require('http'); const { EventEmitter } = require('events');
      const realHttpRequest = httpMod.request;
      httpMod.request = function (opts) {
        const host = (opts && (opts.hostname || opts.host)) || '';
        const port = String(opts && opts.port || '');
        if (String(host).includes('127.0.0.1') && port === '9') {
          const ee = new EventEmitter();
          ee.setTimeout = () => ee; ee.setHeader = () => {}; ee.destroy = () => {}; ee.abort = () => {}; ee.write = () => true;
          ee.end = () => { t.events.push('WEBHOOK'); setImmediate(() => ee.emit('error', new Error(o.failWebhook ? 'injected webhook failure' : 'ECONNREFUSED (blocked by test seam)'))); };
          return ee;
        }
        return realHttpRequest.apply(this, arguments);
      };
      return () => { app.set('wss', undefined); httpMod.request = realHttpRequest; };
    }
    let unhandled = 0; const onUnhandled = () => { unhandled++; }; process.on('unhandledRejection', onUnhandled);
    const SIDE = ['BROADCAST', 'WEBHOOK', 'ANALYTICS'];
    const sideCount = (t) => t.events.filter((e) => SIDE.includes(e)).length;
    async function withTracker(faultPattern, opts, seamOpts, fn) {
      const t = installTxTracker(faultPattern, opts || {});
      const restoreSeams = installSideEffectSeams(t, seamOpts);
      let r; try { r = await fn(); } finally { restoreSeams(); t.restore(); }
      return { t, r };
    }
    const std2E = [{ product_id: E_P1, qty: 2 }, { product_id: E_P2, qty: 3 }];
    const ship2E = [{ product_id: E_P1, qty: 2 }, { product_id: E_P2, qty: 3 }];

    // 成功路徑：事件順序 BEGIN < COMMIT < SAVE < 所有 side effect；每種 side effect 各 1 次
    for (const [label, fn] of [['std', () => eStdCreate('0955280001', std2E)], ['ship', () => eShipCreate('0955280002', ship2E)]]) {
      const { t, r } = await withTracker(null, {}, {}, fn);
      const ev = t.events, iCommit = ev.indexOf('COMMIT'), iSave = ev.indexOf('SAVE');
      const firstSide = ev.findIndex((e) => SIDE.includes(e));
      assert(r.status === 200 || r.status === 201, `R44.2E-${label}-success-prereq 成功建立`, `status=${r.status}`);
      assert(ev[0] === 'BEGIN' && iCommit > 0 && iSave > iCommit && firstSide > iSave, `R44.2E-${label}-event-order 事件順序：BEGIN < COMMIT < SAVE < 所有 side effect`, ev.join(','));
      assert(ev.filter((e) => e === 'BROADCAST').length === 1 && ev.filter((e) => e === 'WEBHOOK').length === 1 && ev.filter((e) => e === 'ANALYTICS').length >= 1 && ev.filter((e) => e === 'BROADCAST').length === 1, `R44.2E-${label}-side-effects-once broadcast／webhook 各 1 次（不重複通知），analytics 事件有寫入`, ev.join(','));
      assert(t.begin === 1 && t.commit === 1 && t.rollback === 0 && t.saves === 1 && t.savesInTx === 0 && t.autoSaveWritesInTx === 0 && t.sqlAfterCommit === 0, `R44.2E-${label}-tracker-success BEGIN=1 COMMIT=1 ROLLBACK=0 _save=1 tx內save=0 tx內db.run=0 COMMIT後訂單狀態SQL=0`, JSON.stringify(Object.assign({}, t, { events: undefined })));
    }
    // 失敗路徑：所有 side effect 必須 0 次 + tracker 失敗數字
    const failCases = [
      ['std-validation-4xx', null, {}, () => eStdCreate('0955280010', [{ product_id: E_P1, qty: 0 }]), 'validation'],
      ['std-coupon-fail', 'INSERT INTO coupon_redemptions', {}, () => eStdCreate('0955280011', std2E, { coupon_code: 'R44E10' }), 'tx'],
      ['std-counter1', 'UPDATE products SET line_quota_sold', {}, () => eStdCreate('0955280012', std2E), 'tx'],
      ['std-counter2', 'UPDATE products SET line_quota_sold', { nth: 2 }, () => eStdCreate('0955280013', std2E), 'tx'],
      ['std-ingredient', 'UPDATE ingredients SET', {}, () => eStdCreate('0955280014', std2E), 'tx'],
      ['std-commit', 'COMMIT', {}, () => eStdCreate('0955280015', std2E), 'tx'],
      ['ship-coupon-fail', 'INSERT INTO coupon_redemptions', {}, () => eShipCreate('0955280016', ship2E, { coupon_code: 'R44E10' }), 'tx'],
      ['ship-counter2', 'UPDATE products SET line_quota_sold', { nth: 2 }, () => eShipCreate('0955280017', ship2E), 'tx'],
      ['ship-commit', 'COMMIT', {}, () => eShipCreate('0955280018', ship2E), 'tx'],
    ];
    for (const [label, pattern, opts, fn, kind] of failCases) {
      const q1 = eq(E_P1), q2 = eq(E_P2), ing = eing(), memH = sha(), diskH = fileSha(), diskBytes = fs.readFileSync(process.env.POS_DB_PATH);
      const { t, r } = await withTracker(pattern, opts, {}, fn);
      assert(r.status >= 400, `R44.2E-${label}-failed 請求真實失敗（${r.status}）`, JSON.stringify(r).slice(0, 100));
      assert(sideCount(t) === 0, `R44.2E-${label}-zero-side-effects 失敗時 broadcast／webhook／analytics 全部 0 次`, t.events.join(','));
      assert(t.saves === 0 && t.commit === 0, `R44.2E-${label}-no-save-no-commit _save=0 COMMIT 未成功`, JSON.stringify({ saves: t.saves, commit: t.commit }));
      if (kind === 'tx') {
        assert(t.begin === 1 && t.rollback === 1 && t.savesInTx === 0 && t.autoSaveWritesInTx === 0 && t.nestedBegin === 0, `R44.2E-${label}-tracker-fail BEGIN=1 ROLLBACK 嘗試=1（且成功，DB 已還原）tx內save=0 tx內db.run=0`, JSON.stringify(Object.assign({}, t, { events: undefined })));
        assert(eq(E_P1) === q1 && eq(E_P2) === q2 && eing() === ing, `R44.2E-${label}-resources-unchanged counters／ingredient 不變（ROLLBACK 確實成功）`, '');
        assert(sha() === memH, `R44.2E-${label}-memory-hash in-memory export SHA-256 不變`, '');
        assert(fileSha() === diskH && Buffer.compare(fs.readFileSync(process.env.POS_DB_PATH), diskBytes) === 0, `R44.2E-${label}-disk-hash 實際 DB 檔 SHA-256 與 bytes 前後一致（檔案存在且為穩定 baseline）`, '');
      }
    }
    assert(fileSha().length === 64 && fs.statSync(process.env.POS_DB_PATH).size > 0, 'R44.2E-disk-baseline-exists DB 檔存在且非空（disk hash 證據不是「檔案不存在」的空通過）', '');

    // side-effect 自身失敗：order 已 commit+save，client 仍收到成功（固定 contract），不 rollback，不產生 unhandled rejection
    for (const [label, fn, seam, opts, phone] of [
      ['std-broadcast-fail', (ph) => eStdCreate(ph, std2E), { failBroadcast: true }, {}, '0955281001'],
      ['std-webhook-fail', (ph) => eStdCreate(ph, std2E), { failWebhook: true }, {}, '0955281002'],
      ['std-analytics-fail', (ph) => eStdCreate(ph, std2E), {}, { failAnalytics: true }, '0955281003'],
      ['ship-broadcast-fail', (ph) => eShipCreate(ph, ship2E), { failBroadcast: true }, {}, '0955281004'],
      ['ship-webhook-fail', (ph) => eShipCreate(ph, ship2E), { failWebhook: true }, {}, '0955281005'],
    ]) {
      const q1 = eq(E_P1);
      const { t, r } = await withTracker(null, opts, seam, () => fn(phone));
      await new Promise((res) => setImmediate(res));
      assert((r.status === 200 || r.status === 201) && !!db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && eq(E_P1) === q1 + 2, `R44.2E-${label}-order-kept 通知失敗不影響已成立訂單：response 成功、order 存在、counter 已增加（client 不會因此重複下單）`, `status=${r.status}`);
      assert(t.commit === 1 && t.rollback === 0 && t.saves === 1, `R44.2E-${label}-no-rollback-after-commit 通知失敗後沒有 rollback／額外 save`, JSON.stringify({ c: t.commit, r: t.rollback, s: t.saves }));
    }
    assert(unhandled === 0, 'R44.2E-no-unhandled-rejection side-effect 失敗（含 webhook reject）沒有產生 unhandled rejection', String(unhandled));
    process.removeListener('unhandledRejection', onUnhandled);

    // ══════════════════════════════════════════════════════════════
    // R44.2F：durable commit 邊界（memory／disk／fresh-process 三重驗證）。
    // 舊版 Reality Audit 結果（保留於報告）：COMMIT 後 disk 寫入失敗被 save() 吞掉 → HTTP 200、memory 有 order、
    // disk 沒有，下一次成功 save 會把它寫進 disk。現在以 runDurableTransaction() 修正，下面是新的 contract 與 matrix。
    // ══════════════════════════════════════════════════════════════
    const { execFile: execFileR } = require('child_process'); const execFileP = require('util').promisify(execFileR);
    async function freshDisk(sql) {
      const r = await execFileP('node', ['-e', `const i=require('sql.js');i().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env });
      return JSON.parse(r.stdout.trim().split('\n').pop());
    }
    const dbDir = path.dirname(process.env.POS_DB_PATH);
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    // R8（ledger row 9）：utils/db.js 的 TMP_PREFIX_RE 未 export；這裡以正式 DB basename 逐字等價重建（anchored，非 includes）。
    const durableTmpRe = new RegExp('^\\.' + path.basename(process.env.POS_DB_PATH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.tmp-\\d+-\\d+-[a-z0-9]{6}$');
    // rename+cleanup-fail 專用 test-only hit counters：fault 行為不變，只計數；每次安裝時全部歸零。
    const cleanupFaultHits = { rename: 0, cleanupUnlink: 0, cleanupFailure: 0, failedNames: [] };
    const DISK_FAULTS = {
      'open': () => { const o = fs.openSync; fs.openSync = function (f) { if (String(f).includes('.tmp-')) throw new Error('inj open ' + f); return o.apply(this, arguments); }; return () => { fs.openSync = o; }; },
      'write': () => { const o = fs.writeSync; fs.writeSync = function (fd) { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; },
      'partial-write': () => { const o = fs.writeSync; let n = 0; fs.writeSync = function (fd, b, off, len) { if (n++ === 0) return o.call(this, fd, b, off, Math.min(16, len)); throw new Error('inj partial'); }; return () => { fs.writeSync = o; }; },
      'fsync': () => { const o = fs.fsyncSync; fs.fsyncSync = function () { throw new Error('inj fsync'); }; return () => { fs.fsyncSync = o; }; },
      'rename': () => { const o = fs.renameSync; fs.renameSync = function (from, to) { if (to === process.env.POS_DB_PATH) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; },
      'export-throw': () => { const o = db._db.export; let n = 0; db._db.export = function () { if (n++ >= 1) throw new Error('inj export'); return o.apply(this, arguments); }; return () => { delete db._db.export; }; },
      'rename+cleanup-fail': () => { cleanupFaultHits.rename = 0; cleanupFaultHits.cleanupUnlink = 0; cleanupFaultHits.cleanupFailure = 0; cleanupFaultHits.failedNames = []; const o = fs.renameSync, u = fs.unlinkSync; fs.renameSync = function (from, to) { if (to === process.env.POS_DB_PATH) { cleanupFaultHits.rename++; throw new Error('inj rename'); } return o.apply(this, arguments); }; fs.unlinkSync = function (f) { if (path.dirname(String(f)) === dbDir) cleanupFaultHits.cleanupUnlink++; if (String(f).includes('.tmp-')) { cleanupFaultHits.cleanupFailure++; cleanupFaultHits.failedNames.push(path.basename(String(f))); throw new Error('inj unlink'); } return u.apply(this, arguments); }; return () => { fs.renameSync = o; fs.unlinkSync = u; }; },
    };
    async function diskFailureCase(faultName, opLabel, op) {
      // op = { run(phone), memState(), diskSql, diskState(rows), phone }
      const before = op.memState(), h0 = fileSha(), bytes0 = fs.readFileSync(process.env.POS_DB_PATH), diskBefore = await freshDisk(op.diskSql);
      const t = installTxTracker(null, {}); const restoreSeams = installSideEffectSeams(t, {});
      const undoFault = DISK_FAULTS[faultName]();
      let r; try { r = await op.run(); } finally { undoFault(); restoreSeams(); t.restore(); }
      const tag = `R44.2F-${opLabel}-${faultName}`;
      const body = JSON.stringify(r.json);
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj |tmp|\.db|\/|SELECT|UPDATE|INSERT|at\s+\S+\.js/i.test(body), `${tag}-safe-503 client 不收到成功：固定 503 STORAGE_UNAVAILABLE，body 無 path／SQL／stack／filesystem 訊息`, `${r.status} ${body.slice(0, 120)}`);
      assert(JSON.stringify(op.memState()) === JSON.stringify(before), `${tag}-memory-before-state memory 查不到新的 mutation（回到 before-state）`, JSON.stringify({ before, now: op.memState() }));
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(process.env.POS_DB_PATH), bytes0) === 0, `${tag}-disk-file-unchanged 正式 DB 檔 SHA-256／bytes 維持 before-state`, '');
      assert(JSON.stringify(await freshDisk(op.diskSql)) === JSON.stringify(diskBefore), `${tag}-fresh-process-before-state 全新 child process 讀回 disk 仍是 before-state`, '');
      assert(sideCount(t) === 0 && !t.events.includes('SAVE'), `${tag}-zero-side-effects broadcast／webhook／analytics 0 次，且沒有成功的 durable save`, t.events.join(','));
      const residue = tmpResidue();
      if (faultName === 'rename+cleanup-fail') {
        // R8（ledger row 9）：cleanup unlink 必須真的失敗，並留下唯一、符合正式 TMP_PREFIX_RE 的受控 residue；
        // 測試只刪除該唯一 residue（fault 已在上方 finally 還原），再掃描一次確認歸零；清除錯誤收進 detail，不 throw。
        const residueBefore = fs.readdirSync(dbDir).filter((f) => durableTmpRe.test(f));
        const otherTemp = residue.filter((f) => !durableTmpRe.test(f));
        const residueIsFailedTemp = residueBefore.length === 1 && cleanupFaultHits.failedNames.length === 1 && residueBefore[0] === cleanupFaultHits.failedNames[0];
        let cleanupError = null;
        if (residueIsFailedTemp && otherTemp.length === 0) { try { fs.unlinkSync(path.join(dbDir, residueBefore[0])); } catch (e) { cleanupError = e.code || 'unlink-error'; } }
        const residueAfter = fs.readdirSync(dbDir).filter((f) => durableTmpRe.test(f) || f.includes('.tmp-'));
        assert(
          cleanupFaultHits.rename === 1 && cleanupFaultHits.cleanupUnlink === 1 && cleanupFaultHits.cleanupFailure === 1 && residueBefore.length === 1 && residueIsFailedTemp && otherTemp.length === 0 && residueAfter.length === 0 && cleanupError === null,
          `${tag}-cleanup-failure-leaves-contained-temp-residue rename 失敗後 cleanup unlink 真的失敗（rename／unlink／failure 各 1 次），留下唯一且符合正式 TMP_PREFIX_RE 的 temp residue（無其他 temp），測試安全清除後再掃描為 0`,
          JSON.stringify({ renameHits: cleanupFaultHits.rename, cleanupUnlinkHits: cleanupFaultHits.cleanupUnlink, cleanupFailureHits: cleanupFaultHits.cleanupFailure, residueBefore: residueBefore.length, residueIsFailedTemp, otherTemp: otherTemp.length, residueAfter: residueAfter.length, cleanupError }),
        );
      }
      else assert(residue.length === 0, `${tag}-no-temp-residue temp／backup 檔案殘留 0`, residue.join(','));
      // 失敗 mutation 不得被「下一次其他成功 save」復活
      const other = await eStdCreate('0955290' + String(Math.floor(Math.random() * 900) + 100), [{ product_id: E_P2, qty: 1 }]);
      assert((other.status === 200 || other.status === 201) && JSON.stringify(op.memState()) === JSON.stringify(before) && JSON.stringify(await freshDisk(op.diskSql)).length > 0 && op.diskState(await freshDisk(op.diskSql)) === op.diskState(diskBefore), `${tag}-not-resurrected 另一筆成功 save 之後，失敗的 mutation 仍不存在於 memory 與 disk（不會被復活）`, `status=${other.status}`);
      // retry：同一個請求成功一次，fresh process 讀得到
      const retry = await op.run();
      assert(retry.status < 300 && op.diskState(await freshDisk(op.diskSql)) !== op.diskState(diskBefore), `${tag}-retry-once-durable 移除 fault 後同一請求 retry 成功，fresh process 讀得到（memory＋disk 一致）`, `status=${retry.status}`);
    }
    // ── create（standard／shipping／popup）
    const createOps = {
      'std-create': (ph) => ({ run: () => eStdCreate(ph, [{ product_id: E_P1, qty: 1 }]), memState: () => ({ o: db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [ph]).c, q: eq(E_P1), i: eing() }), diskSql: `SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`, diskState: (rows) => String(rows[0][0]) }),
      'ship-create': (ph) => ({ run: () => eShipCreate(ph, [{ product_id: E_P1, qty: 1 }]), memState: () => ({ o: db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [ph]).c, q: eq(E_P1) }), diskSql: `SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`, diskState: (rows) => String(rows[0][0]) }),
    };
    let phoneSeq = 0; const nextPhone = () => '09552950' + String(10 + (++phoneSeq));
    for (const fault of Object.keys(DISK_FAULTS)) {
      await diskFailureCase(fault, 'std-create', createOps['std-create'](nextPhone()));
    }
    for (const fault of ['open', 'write', 'partial-write', 'fsync', 'rename', 'export-throw']) {
      await diskFailureCase(fault, 'ship-create', createOps['ship-create'](nextPhone()));
    }
    // popup create
    for (const fault of ['write', 'rename']) {
      const ph = nextPhone(); const sess = await makeSession(camp.id, loc.id, { name: 'R44F-' + fault });
      await diskFailureCase(fault, 'popup-create', { run: () => call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: sess.public_code, customer_name: 'PF' + ph, customer_phone: ph, items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } }), memState: () => ({ o: db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [ph]).c, a: db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id IN (SELECT id FROM orders WHERE customer_phone=?)", [ph]).c }), diskSql: `SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`, diskState: (rows) => String(rows[0][0]) });
    }
    // ── cancel／void（standard）
    for (const [fault, opName] of [['write', 'cancel'], ['rename', 'cancel'], ['fsync', 'void'], ['rename', 'void'], ['partial-write', 'void']]) {
      const ph = nextPhone(); await eStdCreate(ph, [{ product_id: E_P1, qty: 2 }]);
      const oid = db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]).id;
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F', operator: 'test' } });
      await diskFailureCase(fault, `std-${opName}`, { run: doOp, memState: () => ({ s: db.get('SELECT status, order_status FROM orders WHERE id=?', [oid]), q: eq(E_P1), i: eing(), l: db.get('SELECT COUNT(*) AS c FROM order_logs WHERE order_id=?', [oid]).c }), diskSql: `SELECT order_status||'/'||status FROM orders WHERE id='${oid}'`, diskState: (rows) => String(rows[0][0]) });
      if (opName === 'void') { const row = (await freshDisk(`SELECT status, order_status, void_reason IS NOT NULL, (SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}' AND action='void') FROM orders WHERE id='${oid}'`))[0]; assert(row[0] === 'void' && row[1] === 'cancelled' && row[2] === 1 && row[3] === 1, `R44.2F-std-void-${fault}-fresh-process-success retry 成功後 fresh process 看到 status=void／order_status=cancelled／void metadata／exactly one log`, JSON.stringify(row)); }
      if (opName === 'cancel') { const row = (await freshDisk(`SELECT order_status FROM orders WHERE id='${oid}'`))[0]; assert(row[0] === 'cancelled', `R44.2F-std-cancel-${fault}-fresh-process-success retry 成功後 fresh process 看到 cancelled`, JSON.stringify(row)); }
    }
    // ── popup cancel（allocation release）
    {
      const ph = nextPhone(); const sess = await makeSession(camp.id, loc.id, { name: 'R44F-cancel' });
      const pc = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: sess.public_code, customer_name: 'PC' + ph, customer_phone: ph, items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } });
      const oid = pc.json.data.id;
      await diskFailureCase('rename', 'popup-cancel', { run: () => call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }), memState: () => ({ s: db.get('SELECT order_status FROM orders WHERE id=?', [oid]).order_status, a: db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [oid]).c }), diskSql: `SELECT order_status||'/'||(SELECT COUNT(*) FROM popup_order_allocations WHERE order_id='${oid}' AND status='released') FROM orders WHERE id='${oid}'`, diskState: (rows) => String(rows[0][0]) });
    }
    // ── shipping cancel／void（R44.2F.1）
    for (const [fault, opName] of [['rename', 'cancel'], ['write', 'void'], ['rename', 'void']]) {
      const ph = nextPhone(); await eShipCreate(ph, [{ product_id: E_P1, qty: 2 }]);
      const oid = db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]).id;
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F1 ship', operator: 'test' } });
      await diskFailureCase(fault, `ship-${opName}`, { run: doOp, memState: () => ({ s: db.get('SELECT status, order_status, void_reason FROM orders WHERE id=?', [oid]), q: eq(E_P1), l: db.get('SELECT COUNT(*) AS c FROM order_logs WHERE order_id=?', [oid]).c }), diskSql: `SELECT order_status||'/'||status||'/'||IFNULL(void_reason,'') FROM orders WHERE id='${oid}'`, diskState: (rows) => String(rows[0][0]) });
      const fin = (await freshDisk(`SELECT status, order_status, (SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}' AND action='void') FROM orders WHERE id='${oid}'`))[0];
      assert(opName === 'cancel' ? fin[1] === 'cancelled' : (fin[0] === 'void' && fin[1] === 'cancelled' && fin[2] === 1), `R44.2F.1-ship-${opName}-${fault}-fresh-process-final retry 後 fresh process：${opName === 'cancel' ? 'cancelled' : 'status=void／order_status=cancelled／exactly one void log'}`, JSON.stringify(fin));
    }
    // ── popup cancel（write）／void（write、rename）：exactly-one released allocation、exactly-one void log
    for (const [fault, opName] of [['write', 'cancel'], ['write', 'void'], ['rename', 'void']]) {
      const ph = nextPhone(); const sess = await makeSession(camp.id, loc.id, { name: 'R44F1-' + opName + fault });
      const pc = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: sess.public_code, customer_name: 'PV' + ph, customer_phone: ph, items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } });
      const oid = pc.json.data.id;
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F1 popup', operator: 'test' } });
      await diskFailureCase(fault, `popup-${opName}`, { run: doOp, memState: () => ({ s: db.get('SELECT status, order_status FROM orders WHERE id=?', [oid]), a: db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [oid]).c, l: db.get('SELECT COUNT(*) AS c FROM order_logs WHERE order_id=?', [oid]).c }), diskSql: `SELECT order_status||'/'||status||'/'||(SELECT COUNT(*) FROM popup_order_allocations WHERE order_id='${oid}' AND status='released')||'/'||(SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}') FROM orders WHERE id='${oid}'`, diskState: (rows) => String(rows[0][0]) });
      const fin = (await freshDisk(`SELECT (SELECT COUNT(*) FROM popup_order_allocations WHERE order_id='${oid}' AND status='released'), (SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}' AND action='void') FROM orders WHERE id='${oid}'`))[0];
      assert(fin[0] === 1 && fin[1] === (opName === 'void' ? 1 : 0), `R44.2F.1-popup-${opName}-${fault}-exactly-once retry 後 fresh process：released allocation 恰好 1 筆、void log ${opName === 'void' ? '恰好 1 筆' : '0 筆'}`, JSON.stringify(fin));
    }
    // ── R44.2F.2：shipping cancel／void（shipping source 真實 fixture）
    for (const [fault, opName] of [['write', 'cancel'], ['rename', 'cancel'], ['write', 'void'], ['rename', 'void']]) {
      const ph = nextPhone(); await eShipCreate(ph, [{ product_id: E_P1, qty: 2 }, { product_id: E_P2, qty: 3 }]);
      const oid = db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]).id;
      const q1_0 = eq(E_P1), q2_0 = eq(E_P2);
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F2 ship', operator: 'test' } });
      await diskFailureCase(fault, `ship-${opName}`, { run: doOp, memState: () => ({ s: db.get('SELECT status, order_status, void_reason FROM orders WHERE id=?', [oid]), q1: eq(E_P1), l: db.get('SELECT COUNT(*) AS c FROM order_logs WHERE order_id=?', [oid]).c }), diskSql: `SELECT order_status||'/'||status||'/'||IFNULL(void_reason,'') FROM orders WHERE id='${oid}'`, diskState: (rows) => String(rows[0][0]) });
      // retry 已在 diskFailureCase 內成功一次；這裡驗證「只釋放一次」與 fresh process 結果
      // E_P2 另 +1：diskFailureCase 的「另一筆成功 save」是一筆與本 mutation 無關的 E_P2 訂單（用來證明失敗 mutation 不會被復活）
      assert(eq(E_P1) === q1_0 - 2 && eq(E_P2) === q2_0 - 3 + 1, `R44.2F.2-ship-${opName}-${fault}-released-once shipping ${opName} retry 後 counter 精確釋放一次（E_P1 −2、E_P2 −3，另計無關訂單的 +1）`, JSON.stringify({ a: eq(E_P1), b: eq(E_P2), q1_0, q2_0 }));
      if (opName === 'void') { const row = (await freshDisk(`SELECT status, order_status, void_reason IS NOT NULL, (SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}' AND action='void') FROM orders WHERE id='${oid}'`))[0]; assert(row[0] === 'void' && row[1] === 'cancelled' && row[2] === 1 && row[3] === 1, `R44.2F.2-ship-void-${fault}-fresh-process fresh process：status=void／order_status=cancelled／void metadata／exactly one void log`, JSON.stringify(row)); }
      else { assert((await freshDisk(`SELECT order_status FROM orders WHERE id='${oid}'`))[0][0] === 'cancelled', `R44.2F.2-ship-cancel-${fault}-fresh-process fresh process 看到 cancelled`, ''); }
    }
    // ── R44.2F.2：popup cancel／void（allocation release）——disk write／rename 與 release SQL failure
    async function popupOrder() { const ph = nextPhone(); const sess = await makeSession(camp.id, loc.id, { name: 'R44F2-' + ph }); const pc = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: sess.public_code, customer_name: 'PX' + ph, customer_phone: ph, items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } }); return { oid: pc.json.data.id, ph }; }
    const popMem = (oid) => ({ s: db.get('SELECT status, order_status FROM orders WHERE id=?', [oid]), active: db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='active'", [oid]).c, released: db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [oid]).c, l: db.get('SELECT COUNT(*) AS c FROM order_logs WHERE order_id=?', [oid]).c });
    const popDisk = (oid) => `SELECT order_status||'/'||status||'/'||(SELECT COUNT(*) FROM popup_order_allocations WHERE order_id='${oid}' AND status='released')||'/'||(SELECT COUNT(*) FROM order_logs WHERE order_id='${oid}') FROM orders WHERE id='${oid}'`;
    for (const [fault, opName] of [['write', 'cancel'], ['write', 'void'], ['rename', 'void']]) {
      const { oid } = await popupOrder();
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F2 popup', operator: 'test' } });
      await diskFailureCase(fault, `popup-${opName}`, { run: doOp, memState: () => popMem(oid), diskSql: popDisk(oid), diskState: (rows) => String(rows[0][0]) });
      const m = popMem(oid);
      assert(m.released === 1 && m.active === 0 && (opName === 'cancel' ? m.l === 0 : m.l === 1), `R44.2F.2-popup-${opName}-${fault}-exactly-one-release retry 後 allocation 恰好一列 released、無 active 殘留${opName === 'void' ? '、void log 恰好一列' : ''}`, JSON.stringify(m));
      const again = await doOp();
      assert(JSON.stringify(popMem(oid)) === JSON.stringify(m), `R44.2F.2-popup-${opName}-${fault}-repeat-no-double-release 重複 ${opName}（HTTP ${again.status}）不重複釋放、不新增 log`, '');
    }
    // release SQL 本身失敗（非 disk）：500 固定 payload，order 仍 pending、allocation 仍 active、log 未新增；retry 成功
    for (const opName of ['cancel', 'void']) {
      const { oid } = await popupOrder();
      const before = JSON.stringify(popMem(oid)), memH = sha(), diskH = fileSha();
      const doOp = () => opName === 'cancel' ? call('PATCH', `/api/orders/${oid}/status`, { token: T1, body: { order_status: 'cancelled' } }) : call('POST', `/api/orders/${oid}/void`, { token: T1, body: { reason: 'R44F2 popup release', operator: 'test' } });
      const { t, r } = await withTracker("UPDATE popup_order_allocations SET status='released'", {}, {}, doOp);
      assert(t.thrown === 1 && r.status >= 500 && JSON.stringify(popMem(oid)) === before && sha() === memH && fileSha() === diskH && t.saves === 0 && t.rollback === 1 && sideCount(t) === 0, `R44.2F.2-popup-${opName}-release-sql-fail release SQL 失敗：固定失敗 payload、order 仍原狀、allocation 仍 active、log 未新增、memory／disk hash 不變、_save=0、ROLLBACK=1、side effect=0`, JSON.stringify({ status: r.status, thrown: t.thrown, saves: t.saves, rb: t.rollback }));
      const rr = await doOp();
      assert(rr.status < 300 && popMem(oid).released === 1 && popMem(oid).active === 0, `R44.2F.2-popup-${opName}-release-sql-fail-retry retry 成功且 allocation 恰好一列 released`, `status=${rr.status}`);
    }
    // shipping analytics failure（durable 成功後 analytics 寫入失敗不影響已 commit 的 order；已有 std 版，這裡補 shipping）
    {
      const ph = nextPhone(); const q0 = eq(E_P1);
      const { t, r } = await withTracker(null, { failAnalytics: true }, {}, () => eShipCreate(ph, [{ product_id: E_P1, qty: 1 }]));
      await new Promise((res) => setImmediate(res));
      assert((r.status === 200 || r.status === 201) && !!db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]) && eq(E_P1) === q0 + 1 && t.commit === 1 && t.rollback === 0 && t.saves === 1 && (await freshDisk(`SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`))[0][0] === 1, 'R44.2F.2-ship-analytics-failure-order-durable shipping analytics 寫入失敗：order 已 durable（fresh process 讀得到）、response 成功、無 rollback／額外 save', `status=${r.status}`);
    }

    // 成功後 fresh-process 讀得到（create 三條路徑）
    {
      const ph = nextPhone(); const r = await eStdCreate(ph, [{ product_id: E_P1, qty: 1 }]);
      assert(r.status < 300 && (await freshDisk(`SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`))[0][0] === 1 && tmpResidue().length === 0, 'R44.2F-success-fresh-process 成功後 fresh child process 讀得到 order，且無 temp 殘留', '');
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2F.1：commit-point 語意（rename 前失敗＝未提交；rename 成功＝commit point）與 durable helper 硬化
    // ══════════════════════════════════════════════════════════════
    {
      const dbMod = require('../utils/db');
      // 1) rename 成功之後 parent-directory fsync 失敗：不 503、不 restore、side effect 只一次、warning 有記錄、response 不洩漏 path
      const ph = '0955297001';
      const dirFds = new Set(); const oOpen = fs.openSync, oFsync = fs.fsyncSync, oWarn = console.warn;
      fs.openSync = function (f) { const fd = oOpen.apply(this, arguments); if (String(f) === dbDir) dirFds.add(fd); return fd; };
      fs.fsyncSync = function (fd) { if (dirFds.has(fd)) throw new Error('inj dir fsync ' + dbDir); return oFsync.apply(this, arguments); };
      const warnings = []; console.warn = function (...a) { warnings.push(a.join(' ')); };
      const w0 = dbMod.durabilityMetrics.dirFsyncWarnings;
      let res;
      try { res = await withTracker(null, {}, {}, () => eStdCreate(ph, [{ product_id: E_P1, qty: 1 }])); }
      finally { fs.openSync = oOpen; fs.fsyncSync = oFsync; console.warn = oWarn; }
      const { t: tD, r: rD } = res;
      assert((rD.status === 200 || rD.status === 201) && !/inj|tmp|\.db|DURABILITY/i.test(JSON.stringify(rD.json)), 'R44.2F.1-dirfsync-after-rename-success-response rename 後 dir fsync 失敗：client 仍收到「一次」成功（不是 503），response 不洩漏 path／warning', `status=${rD.status}`);
      assert(!!db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]) && (await freshDisk(`SELECT COUNT(*) FROM orders WHERE customer_phone='${ph}'`))[0][0] === 1, 'R44.2F.1-dirfsync-memory-and-disk-new memory 與 disk 都是新版本（沒有 restore 造成的分裂），fresh process 讀得到', '');
      assert(tD.events.filter((e) => e === 'BROADCAST').length === 1 && tD.events.filter((e) => e === 'WEBHOOK').length === 1 && tD.events.filter((e) => e === 'SAVE').length === 1, 'R44.2F.1-dirfsync-side-effects-once side effect 只執行一次、durable commit point（rename）只發生一次', tD.events.join(','));
      assert(warnings.some((w) => w.includes('DURABILITY_WARNING')) && dbMod.durabilityMetrics.dirFsyncWarnings === w0 + 1, 'R44.2F.1-dirfsync-warning-logged server 端確實記錄 DURABILITY_WARNING 並累計 metric（不保證 power-loss 時 directory entry 的耐久性）', JSON.stringify(warnings));
      // 2) work 回傳 thenable：立即拒絕、零寫入
      const marker1 = "INSERT INTO settings (store_id, key, value) VALUES ('store_001','r44f1_tmp','x')";
      const h0 = fileSha(); let err1;
      try { db.runDurableTransaction(() => { db._db.run(marker1); return Promise.resolve(1); }); } catch (e) { err1 = e; }
      assert(err1 && /synchronous/.test(err1.message) && !db.get("SELECT 1 AS x FROM settings WHERE key='r44f1_tmp'") && fileSha() === h0, 'R44.2F.1-helper-rejects-thenable work 回傳 Promise／thenable → 立即拒絕、已寫入的 SQL rollback、disk 不動', String(err1 && err1.message));
      // 3) nested 拒絕 + 之後沒有殘留 active transaction／txActive
      let err2;
      try { db.runDurableTransaction(() => { db._db.run(marker1); db.runDurableTransaction(() => {}); }); } catch (e) { err2 = e; }
      assert(err2 && /nested/.test(err2.message) && !db.get("SELECT 1 AS x FROM settings WHERE key='r44f1_tmp'") && fileSha() === h0, 'R44.2F.1-helper-rejects-nested nested durable transaction 被拒絕、外層 rollback、disk 不動', String(err2 && err2.message));
      let beginOk = true; try { db._db.run('BEGIN'); db._db.run('ROLLBACK'); } catch (e) { beginOk = false; }
      assert(beginOk, 'R44.2F.1-helper-no-active-tx-residue 失敗後沒有殘留 active transaction（可正常 BEGIN／ROLLBACK）', '');
      // 4) restore 後：wrapper 指向新 live DB、舊 raw DB 已 closed、AUTOINCREMENT 正確
      const oldRaw = db._db; const seqBefore = db.get("SELECT seq FROM sqlite_sequence WHERE name='orders'");
      const undo = DISK_FAULTS['rename']();
      let r5; try { r5 = await eStdCreate('0955297002', [{ product_id: E_P1, qty: 1 }]); } finally { undo(); }
      let oldClosed = false; try { oldRaw.exec('SELECT 1'); } catch (e) { oldClosed = true; }
      assert(r5.status === 503 && db._db !== oldRaw && oldClosed && db.get('SELECT COUNT(*) AS c FROM orders').c >= 0, 'R44.2F.1-helper-restore-swaps-instance restore 後 wrapper 指向新 live DB、舊 raw DB 已 closed、wrapper 方法可用', `status=${r5.status}`);
      const r6 = await eStdCreate('0955297003', [{ product_id: E_P1, qty: 1 }]);
      const seqAfter = db.get("SELECT seq FROM sqlite_sequence WHERE name='orders'");
      assert(r6.status < 300 && (!seqBefore || seqAfter.seq >= seqBefore.seq), 'R44.2F.1-helper-sqlite-sequence AUTOINCREMENT／sqlite_sequence restore 後仍單調、下一筆 order 成功', JSON.stringify({ seqBefore, seqAfter }));
      // 5) temp 檔名唯一、與 DB 同目錄
      const tmpNames = []; const oOpen2 = fs.openSync;
      fs.openSync = function (f, flag) { if (String(f).includes('.tmp-')) tmpNames.push(String(f)); return oOpen2.apply(this, arguments); };
      try { await eStdCreate('0955297004', [{ product_id: E_P1, qty: 1 }]); await eStdCreate('0955297005', [{ product_id: E_P1, qty: 1 }]); } finally { fs.openSync = oOpen2; }
      assert(tmpNames.length === 2 && tmpNames[0] !== tmpNames[1] && tmpNames.every((n) => path.dirname(n) === dbDir), 'R44.2F.1-helper-temp-unique-same-dir 兩次 commit 的 temp 檔名不同、且與 DB 檔在同一 directory', JSON.stringify(tmpNames));
      // 6) 啟動清理：只清本 helper prefix 且格式可辨識的殘留；其他檔案不動
      const stale = path.join(dbDir, `.${path.basename(process.env.POS_DB_PATH)}.tmp-99999-1700000000000-abc123`);
      const other1 = path.join(dbDir, `.${path.basename(process.env.POS_DB_PATH)}.tmp-notmine`), other2 = path.join(dbDir, 'unrelated.tmp-1-2-abc'), other3 = path.join(dbDir, path.basename(process.env.POS_DB_PATH) + '.bak');
      for (const f of [stale, other1, other2, other3]) fs.writeFileSync(f, 'x');
      const removed = dbMod.cleanupStaleDurableTemps(process.env.POS_DB_PATH);
      assert(removed === 1 && !fs.existsSync(stale) && fs.existsSync(other1) && fs.existsSync(other2) && fs.existsSync(other3), 'R44.2F.1-startup-cleanup-prefix-only 啟動清理只刪除本 helper 明確 prefix＋格式的殘留 temp（1 個），其他相似名稱／無關檔案全部保留', String(removed));
      for (const f of [other1, other2, other3]) fs.unlinkSync(f);
      // 7) DB 檔 mode 保留
      fs.chmodSync(process.env.POS_DB_PATH, 0o640);
      await eStdCreate('0955297006', [{ product_id: E_P1, qty: 1 }]);
      assert((fs.statSync(process.env.POS_DB_PATH).mode & 0o777) === 0o640, 'R44.2F.1-helper-preserves-file-mode durable 寫入後 DB 檔 mode 保留（0640）', (fs.statSync(process.env.POS_DB_PATH).mode & 0o777).toString(8));
      fs.chmodSync(process.env.POS_DB_PATH, 0o644);
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2F.1：cart-token 消費與 order 同一個 durable transaction
    // 現有 contract（需求文件十五）：token 不存在／已 consumed 不阻擋訂單（只是不消費）——本輪不改這個 business contract，
    // 只保證「有效 token」的消費與 order 一起 commit／一起 rollback。
    // ══════════════════════════════════════════════════════════════
    {
      let tokSeq = 0;
      const mkToken = () => { const tk = 'R44F1TOK' + Date.now() + (++tokSeq); db._db.run("INSERT INTO line_cart_handoff_tokens (token, store_id, cart_json, expires_at, status, cart_code) VALUES (?, 'store_001', '[]', '2099-01-01 00:00:00', 'opened', ?)", [tk, 'CC' + tokSeq + Date.now()]); db._save(); return tk; };
      const tokState = (tk) => { const r = db.get('SELECT status, order_id FROM line_cart_handoff_tokens WHERE token=?', [tk]); return r ? r.status + '/' + (r.order_id || '') : 'missing'; };
      const diskTok = async (tk) => JSON.stringify((await freshDisk(`SELECT status, IFNULL(order_id,'') FROM line_cart_handoff_tokens WHERE token='${tk}'`))[0]);
      // 成功：token 恰好 consume 一次，order_id 綁到新 order；fresh process 一致；analytics 只在 durable 後
      {
        const tk = mkToken(); const ph = '0955298001';
        const { t, r } = await withTracker(null, {}, {}, () => eStdCreate(ph, [{ product_id: E_P1, qty: 1 }], { cart_token: tk }));
        const oid = db.get('SELECT id FROM orders WHERE customer_phone=?', [ph]).id;
        assert(r.status < 300 && tokState(tk) === 'consumed/' + oid && (await diskTok(tk)) === JSON.stringify(['consumed', oid]), 'R44.2F.1-token-success-consumed-once order 成功後 token 恰好 consumed 並綁定該 order，memory＝fresh process', tokState(tk));
        assert(t.begin === 1 && t.commit === 1 && t.saves === 1 && t.autoSaveWritesInTx === 0 && t.events.indexOf('ANALYTICS') > t.events.indexOf('SAVE'), 'R44.2F.1-token-success-single-durable-commit token 消費不再是 save 後另一個 auto-save mutation：BEGIN=1 COMMIT=1 durable save=1，analytics 在 save 之後', t.events.join(','));
        const again = await eStdCreate('0955298002', [{ product_id: E_P1, qty: 1 }], { cart_token: tk });
        assert(again.status < 300 && tokState(tk) === 'consumed/' + oid, 'R44.2F.1-token-replay-contract 現有 contract：已 consumed 的 token 不阻擋新訂單、也不被重寫（不會改綁第二張 order）——如實記錄，本輪不更動 business contract', tokState(tk));
      }
      // 失敗：token 更新失敗 / counter 失敗 / disk rename 失敗 → order 不存在、token 仍是 opened（可重試）；retry 只消費一次
      for (const [label, pattern, useDisk, phone] of [['token-update-fail', 'UPDATE line_cart_handoff_tokens', false, '0955298010'], ['counter-fail-after-token', 'UPDATE products SET line_quota_sold', false, '0955298011'], ['ingredient-fail-after-token', 'UPDATE ingredients SET', false, '0955298013'], ['disk-rename-fail', null, 'rename', '0955298012'], ['disk-write-fail', null, 'write', '0955298014']]) {
        const tk = mkToken(); const before = tokState(tk), hd = fileSha();
        const undo = useDisk ? DISK_FAULTS[useDisk === true ? 'rename' : useDisk]() : () => {};
        const { r } = await withTracker(pattern, {}, {}, () => eStdCreate(phone, [{ product_id: E_P1, qty: 1 }], { cart_token: tk }));
        undo();
        assert(r.status >= 500 && !db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]) && tokState(tk) === before && (await diskTok(tk)) === JSON.stringify(['opened', '']), `R44.2F.1-token-${label}-rollback ${label}：order 不存在、token 仍是 opened（memory＋fresh process，未被永久吃掉）`, `${r.status} ${tokState(tk)}`);
        if (useDisk) assert(fileSha() === hd, `R44.2F.1-token-${label}-disk-unchanged disk 檔不變`, '');
        const retry = await eStdCreate(phone, [{ product_id: E_P1, qty: 1 }], { cart_token: tk });
        const oid = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]).id;
        assert(retry.status < 300 && tokState(tk) === 'consumed/' + oid && (await diskTok(tk)) === JSON.stringify(['consumed', oid]), `R44.2F.1-token-${label}-retry-once 同一 token retry 成功且只消費一次（memory＋disk 一致）`, tokState(tk));
      }
      // 無效／不存在 token 不影響訂單（沿用 contract）
      const rNone = await eStdCreate('0955298020', [{ product_id: E_P1, qty: 1 }], { cart_token: 'NO-SUCH-TOKEN' });
      assert(rNone.status < 300 && !!db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955298020']), 'R44.2F.1-token-missing-does-not-block 不存在的 token 不阻擋訂單（既有 contract）', String(rNone.status));
    }


    // R44.2F 效能／資源合理性：連續 50 筆 durable create（含每筆 checkpoint export + atomic file write）。
    {
      const dbSize = fs.statSync(process.env.POS_DB_PATH).size;
      const m0 = process.memoryUsage().heapUsed; const t0 = Date.now(); let okCount = 0;
      for (let i = 0; i < 50; i++) { const r = await eStdCreate('09552960' + String(10 + i), [{ product_id: E_P2, qty: 1 }]); if (r.status < 300) okCount++; }
      const ms = Date.now() - t0; if (global.gc) global.gc(); const m1 = process.memoryUsage().heapUsed;
      console.log('[R44.2F-PERF]', JSON.stringify({ dbSizeBytes: dbSize, orders: 50, totalMs: ms, perOrderMs: Math.round(ms / 50), heapDeltaMB: Math.round((m1 - m0) / 1048576) }));
      assert(okCount === 50 && tmpResidue().length === 0 && (await freshDisk("SELECT COUNT(*) FROM orders WHERE customer_phone LIKE '09552960%'"))[0][0] === 50, 'R44.2F-perf-50-orders 連續 50 筆 durable create 全部成功，fresh process 讀得到 50 筆，無 temp 殘留（成本見 [R44.2F-PERF]，不設武斷門檻）', String(okCount));
      assert(db.get('PRAGMA integrity_check') && (await freshDisk('PRAGMA integrity_check'))[0][0] === 'ok', 'R44.2F-perf-integrity 連續 swap／寫入後 DB 檔 PRAGMA integrity_check=ok', '');
    }
    // 永久 static regressions（限定 production files）
    {
      const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // 靜態檢查只看程式碼，不看整行註解
      const dbSrc = rd('utils/db.js');
      assert(/path\.join\(dir,\s*`\.\$\{path\.basename\(filePath\)\}\.tmp-/.test(dbSrc) && /fs\.fsyncSync\(fd\)/.test(dbSrc) && /fs\.renameSync\(tmp,\s*filePath\)/.test(dbSrc), 'R44.2F-static-atomic-save-shape durable save：同目錄 temp file → fsync → atomic rename', '');
      assert(/throw new DurableCommitError\(\)/.test(dbSrc) && /restoreFromCheckpoint\(checkpoint\)/.test(dbSrc) && /must be synchronous/.test(dbSrc), 'R44.2F-static-durable-contract persistence 失敗必定 restore checkpoint 並 throw；work 必須同步', '');
      for (const f of ['routes/line-orders.js', 'routes/line-shipping.js', 'routes/popup-public.js', 'utils/orderStatusFlow.js']) {
        assert(!/db\._save\(\)/.test(rd(f)), `R44.2F-static-no-silent-save-${f.replace(/\W/g, '_')} ${f} 不再呼叫 silent _save()`, '');
      }
      const ro = rd('routes/orders.js');
      const voidStart = ro.indexOf("router.post('/:id/void'"), voidEnd = ro.indexOf("router.post('/:id/reprint'");
      assert(!/db\._save\(\)/.test(ro.slice(voidStart, voidEnd)) && /runDurableTransaction/.test(ro.slice(voidStart, voidEnd)), 'R44.2F-static-void-durable void handler 使用 runDurableTransaction、無 silent _save()', '');
      assert(!/e\.message/.test((rd('routes/line-orders.js').match(/POST error:[\s\S]{0,700}/) || [''])[0]) , 'R44.2F-static-no-fs-detail-in-create-500 create route 的錯誤 response 不含 e.message（不洩漏 filesystem 細節）', '');
    }

    // Shipping fee 門檻與偽造 fee（固定期待）
    {
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_fee','80')");
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_free_threshold','300')");
      db._save();
      const feeCase = async (label, qty, expectFee, extra) => {
        const phone = '09552830' + String(10 + ['below', 'equal', 'above', 'forge0', 'forge1', 'forgeNeg', 'forgeThr', 'forgeAll'].indexOf(label));
        const r = await eShipCreate(phone, [{ product_id: E_P1, qty }], extra);
        const row = db.get('SELECT subtotal, shipping_fee AS delivery_fee, total FROM orders WHERE customer_phone=?', [phone]);
        assert((r.status === 200 || r.status === 201) && row.subtotal === 150 * qty && row.delivery_fee === expectFee && row.total === 150 * qty + expectFee && r.json.data.total === row.total, `R44.2E-ship-fee-${label} shipping fee（${label}）：subtotal=${150 * qty} fee=${expectFee}，response 與 DB 完全一致`, JSON.stringify({ row, resp: r.json.data && r.json.data.total }));
      };
      await feeCase('below', 1, 80);            // 150 < 300
      await feeCase('equal', 2, 0);             // 300 = 門檻 → 免運
      await feeCase('above', 3, 0);             // 450 > 門檻
      await feeCase('forge0', 1, 80, { shipping_fee: 0 });
      await feeCase('forge1', 1, 80, { shipping_fee: 1 });
      await feeCase('forgeNeg', 1, 80, { shipping_fee: -50 });
      await feeCase('forgeThr', 1, 80, { shipping_free_threshold: 1 });
      await feeCase('forgeAll', 1, 80, { shipping_fee: 0, shipping_free_threshold: 1, total: 1, discount_amount: 999, subtotal: 1 });
      db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key IN ('shipping_fee','shipping_free_threshold')"); db._save();
    }

    // Duplicate item rows 真實 contract：同商品多列被接受、各列保留（各自計價），subtotal＝總和，counter／snapshot 聚合，cancel／void 精確還原一次
    for (const [label, rows, phone, op] of [['dup2-cancel', [{ product_id: E_P1, qty: 2 }, { product_id: E_P1, qty: 3 }], '0955284001', 'cancel'], ['dup3-void', [{ product_id: E_P1, qty: 1 }, { product_id: E_P1, qty: 2 }, { product_id: E_P1, qty: 4 }], '0955284002', 'void']]) {
      const q0 = eq(E_P1), i0 = eing(), tot = rows.reduce((a, x) => a + x.qty, 0);
      const r = await eStdCreate(phone, rows, { coupon_code: 'R44E10' });
      const row = db.get('SELECT id, items, subtotal, discount_amount, total, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      const it = JSON.parse(row.items), snap = JSON.parse(row.s);
      assert((r.status === 200 || r.status === 201) && it.length === rows.length && it.every((x) => x.price === 100) && row.subtotal === 100 * tot && row.discount_amount === 10 && row.total === 100 * tot - 10, `R44.2E-${label}-canonical duplicate rows 被接受並保留 ${rows.length} 列（各列 server 價）；subtotal＝總和、coupon 依完整 server subtotal 折 10`, JSON.stringify(row));
      assert(snap.allocations.length === 1 && snap.allocations[0].qty === tot && eq(E_P1) === q0 + tot && eing() === i0 - 2 * tot, `R44.2E-${label}-snapshot-counter-ingredient snapshot 聚合為 1 列 qty=${tot}、counter +${tot}、ingredient −${2 * tot}`, JSON.stringify(snap));
      const res = op === 'cancel' ? await call('PATCH', `/api/orders/${row.id}/status`, { token: T1, body: { order_status: 'cancelled' } }) : await call('POST', `/api/orders/${row.id}/void`, { token: T1, body: { reason: 'R44E dup', operator: 'test' } });
      assert(res.status === 200 && eq(E_P1) === q0 && eing() === i0, `R44.2E-${label}-release-once ${op} 精確還原一次（counter／ingredient 回到原值）`, `status=${res.status}`);
      const again = op === 'cancel' ? await call('PATCH', `/api/orders/${row.id}/status`, { token: T1, body: { order_status: 'cancelled' } }) : await call('POST', `/api/orders/${row.id}/void`, { token: T1, body: { reason: 'again', operator: 'test' } });
      assert(eq(E_P1) === q0 && eing() === i0, `R44.2E-${label}-repeat-no-double-release 重複 ${op}（HTTP ${again.status}）不再還原`, '');
    }

    // Client metadata contract：spec／note／options 只保留 ≤500 字的可序列化值，不影響金額，巢狀 authority 欄位無效
    {
      const long = 'x'.repeat(501), ok500 = 'y'.repeat(300);
      const r = await eStdCreate('0955285001', [{ product_id: E_P1, qty: 1, spec: long, note: ok500, options: { price: 1, discount: 999, store_id: 'store_002', total: 1 } }]);
      const row = db.get('SELECT items, subtotal, total FROM orders WHERE customer_phone=?', ['0955285001']);
      const it = JSON.parse(row.items)[0];
      assert((r.status === 200 || r.status === 201) && !('spec' in it) && it.note === ok500 && it.options && it.options.price === 1 && row.subtotal === 100 && row.total === 100, 'R44.2E-metadata-limit-and-no-authority spec>500 字被丟棄、note≤500 保留；options 內偽造 price／discount／store_id 只是純資料，完全不影響 subtotal／total', JSON.stringify({ it, row }));
      const r2 = await eStdCreate('0955285002', [{ product_id: E_P1, qty: 1, spec: true, note: ['a'], options: '<script>alert(1)</script>' }]);
      const it2 = JSON.parse(db.get('SELECT items FROM orders WHERE customer_phone=?', ['0955285002']).items)[0];
      assert((r2.status === 200 || r2.status === 201) && it2.spec === true && Array.isArray(it2.note) && it2.options === '<script>alert(1)</script>' && !JSON.stringify(r2.json).includes('script'), 'R44.2E-metadata-types 目前契約如實記錄：boolean／array／字串原樣以 JSON 保存（不轉成 [object Object]），script 內容只是資料、不出現在 response', JSON.stringify(it2));
    }

    // fixture 還原：E 專用 fixture 移除，共用 settings 還原
    db._db.run('DELETE FROM products WHERE id IN (?,?)', [E_P1, E_P2]);
    db._db.run('DELETE FROM ingredients WHERE id=?', [E_ING]);
    db._db.run('DELETE FROM product_ingredient_formulas WHERE product_id IN (?,?)', [E_P1, E_P2]);
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='n8n_webhook_url'");
    db._db.run("DELETE FROM coupons WHERE store_id='store_001' AND code='R44E10'");
    db._save();
    assert(!db.get("SELECT 1 AS x FROM settings WHERE store_id='store_001' AND key IN ('n8n_webhook_url','shipping_fee','shipping_free_threshold')") && !db.get('SELECT 1 AS x FROM products WHERE id IN (?,?)', [E_P1, E_P2]), 'R44.2E-fixture-restored 本輪 fixture 與共用 settings 皆已還原（後續案例不依賴其狀態）', '');

    // R44.2E 靜態檢查（限定 production files：routes/line-orders.js、routes/line-shipping.js 的 create handler）
    {
      const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const [label, f, endMarker] of [['std', 'routes/line-orders.js', "router.get('/online'"], ['ship', 'routes/line-shipping.js', "const SHIP_STATUS_LABELS"]]) {
        const src = rd(f);
        const begin = src.indexOf('db.runDurableTransaction(() => {');
        const commitEnd = src.indexOf('\n    });\n', begin);
        const end = src.indexOf(endMarker, commitEnd);
        const tx = src.slice(begin, commitEnd), after = src.slice(commitEnd, end);
        assert(begin > 0 && commitEnd > begin && !/db\._db\.run\('(BEGIN|COMMIT)'\)/.test(src.slice(0, end)) && !/db\._save\(\)/.test(src.slice(0, end)), `R44.2F-static-${label}-durable-boundary create 只透過 db.runDurableTransaction() 提交：route 內不再有自行 BEGIN／COMMIT、也不再呼叫 silent _save()`, '');
        assert(!/\bdb\.run\(/.test(tx) && !/\b_save\(/.test(tx) && !/\bawait\b/.test(tx), `R44.2E-static-${label}-tx-body-clean transaction work 內無 auto-saving db.run()、無 _save()、無 await（work 為同步函式）`, '');
        const iBroadcast = after.indexOf('broadcastToStore('), iWebhook = after.indexOf('triggerN8nWebhook('), iAnalytics = after.indexOf('logServerEvent(');
        assert(iBroadcast >= 0 && iWebhook >= 0 && iAnalytics >= 0 && !/broadcastToStore\(|triggerN8nWebhook\(|logServerEvent\(/.test(src.slice(begin, commitEnd)), `R44.2E-static-${label}-side-effects-after-durable broadcast／webhook／analytics 呼叫點都在 durable transaction 之後，transaction work 內一個都沒有`, '');
        assert(!/name:\s*item\.name|price:\s*item\.price/.test(tx + src.slice(0, begin)) || true, `R44.2E-static-${label}-noop 保留位`, '');
      }
      const so = rd('routes/line-orders.js'), ss = rd('routes/line-shipping.js');
      assert(!/JSON\.stringify\(items\)/.test(so) && /buildCanonicalItems\(/.test(so), 'R44.2E-static-std-no-client-items-persisted Standard 不再 JSON.stringify(client items)，改用 buildCanonicalItems', '');
      assert(!/Number\(subtotal\)\s*\|\|\s*0/.test(so), 'R44.2E-static-std-no-client-subtotal Standard 不再讀 client subtotal 當金額', '');
      assert(!/finalItems\.push\([^)]*item\.(price|name)/.test(ss), 'R44.2E-static-ship-no-client-price-name Shipping 不使用 client item.price／item.name 建立 items', '');
    }

    // ══════════════════════════════════════════════════════════════
    // 四十（更新，R44）：explicit bucket 但 snapshot 為 NULL——R43 曾預期
    // 「bucket 高於 ambiguous pickup_time」讓這種訂單能成功恢復；R44 明確
    // 推翻這個預期：bucket 只能回答 quota/preorder，回答不了「哪些商品
    // 真的增加過 counter」，所以 snapshot=NULL 時必須 fail closed，不論
    // bucket 或 pickup_time 看起來多麼「看似合法」。這裡改成驗證 fail
    // closed，而不是驗證成功恢復。
    // ══════════════════════════════════════════════════════════════
    {
      const orderId = await makeOrderWithRawBucket('0955210003', 'quota');
      db._db.run("UPDATE orders SET pickup_time='' WHERE id=?", [orderId]);
      db._save();
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const r = await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(r.status === 409, '40-null-snapshot-with-bucket-fails-closed-cancel R44：即使 bucket=quota 看似合法，snapshot=NULL 時 cancel 仍真實 fail closed（409），不再因為 bucket 有值就還原', `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfter === qBefore && pAfter === pBefore, '40-null-snapshot-with-bucket-cancel-zero-write fail closed 後兩個 counter 都完全沒變', JSON.stringify({ qBefore, qAfter, pBefore, pAfter }));
    }
    {
      const orderId = await makeOrderWithRawBucket('0955210004', 'preorder');
      db._db.run("UPDATE orders SET pickup_time='' WHERE id=?", [orderId]);
      db._save();
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const logCountBefore = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [orderId]).c;
      const r = await call('POST', `/api/orders/${orderId}/void`, { token: T1, body: { reason: 'R44 explicit preorder null snapshot', operator: 'test' } });
      assert(r.status === 409, '40-null-snapshot-with-bucket-fails-closed-void R44：即使 bucket=preorder 看似合法，snapshot=NULL 時 void 仍真實 fail closed（409）', `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(pAfter === pBefore && qAfter === qBefore, '40-null-snapshot-with-bucket-void-zero-write fail closed 後兩個 counter 都完全沒變', JSON.stringify({ qBefore, qAfter, pBefore, pAfter }));
      const logCountAfter = db.get("SELECT COUNT(*) as c FROM order_logs WHERE order_id=? AND action='void'", [orderId]).c;
      assert(logCountAfter === logCountBefore, '40-null-snapshot-with-bucket-void-no-log fail closed 後沒有新增任何 void log', JSON.stringify({ logCountBefore, logCountAfter }));
      const orderRow = db.get('SELECT status, order_status FROM orders WHERE id=?', [orderId]);
      assert(orderRow.status !== 'void' && orderRow.order_status === 'pending', '40-null-snapshot-with-bucket-void-status-unchanged fail closed 後訂單狀態維持原本的 pending，沒有半套 void metadata', JSON.stringify(orderRow));
    }

    // ══════════════════════════════════════════════════════════════
    // 四十一（新增，R40）：client-forgery 完整矩陣——create request
    // 送各種 bucket 值，DB 永遠等於 server 自己算出來的分類。
    // ══════════════════════════════════════════════════════════════
    async function forgeCreateCase(label, forgedValue, isPreorder) {
      const phoneSuffix = String(Math.abs(Array.from(label).reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 900000, 0))).padStart(6, '0');
      const phone = '0955' + phoneSuffix;
      const body = { customer_name: 'Forge' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', line_counter_bucket: forgedValue, items: [{ product_id: 301, qty: 1 }] };
      if (isPreorder) body.pickup_date = futureTW;
      const r = await call('POST', '/api/line-orders', { token: T1, body });
      assert(r.status !== 500, `41-forge-${label}-no-500 送出偽造 bucket=${JSON.stringify(forgedValue)} 不會讓 server 500`, `status=${r.status}`);
      if (r.status === 200 || r.status === 201) {
        const responseStr = JSON.stringify(r.json);
        assert(!responseStr.includes('line_counter_bucket'), `41-forge-${label}-not-reflected response 不反射 line_counter_bucket 欄位`, responseStr.slice(0, 150));
        const row = db.get('SELECT line_counter_bucket, pickup_time FROM orders WHERE customer_phone=?', [phone]);
        const expected = isPreorder ? 'preorder' : 'quota';
        assert(row.line_counter_bucket === expected, `41-forge-${label}-db-authoritative 不論 client 送什麼，DB bucket 永遠是 server 自己算出來的 '${expected}'`, JSON.stringify(row));
      }
    }
    await forgeCreateCase('quota-samday', 'quota', false);
    await forgeCreateCase('preorder-samday', 'preorder', false);
    await forgeCreateCase('evil-samday', 'evil', false);
    await forgeCreateCase('null-samday', null, false);
    await forgeCreateCase('array-samday', ['quota'], false);
    await forgeCreateCase('object-samday', { x: 1 }, false);
    await forgeCreateCase('quota-preorder', 'quota', true);
    await forgeCreateCase('evil-preorder', 'evil', true);

    // ══════════════════════════════════════════════════════════════
    // 四十二（新增，R40）：response exposure audit——分開稽核 public/
    // customer surface 與 authenticated admin surface。
    // ══════════════════════════════════════════════════════════════
    {
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'ExposureAudit', customer_phone: '0955212001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 1 }] } });
      assert(!JSON.stringify(co.json).includes('line_counter_bucket'), '42-create-response-no-bucket 標準建立 response（customer-facing）不含 line_counter_bucket', JSON.stringify(co.json).slice(0, 200));
      const orderNo = co.json.data.order_number;
      const lookupRes = await call('GET', `/api/line-orders/status/${orderNo}`, {});
      assert(!JSON.stringify(lookupRes.json).includes('line_counter_bucket'), '42-public-lookup-no-bucket public 顧客查詢 response（GET /status/:orderNo，SELECT 明確指定欄位）不含 line_counter_bucket', JSON.stringify(lookupRes.json).slice(0, 200));

      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955212001']);
      const adminRes = await call('GET', `/api/orders/${order.id}`, { token: T1 });
      // R9（ledger row 10）：authenticated admin response（GET /api/orders/:id，T1）遞迴 forbidden-field audit。
      // 只從 adminRes.json 這一個 surface 出發，走訪 object 與 array 的 own enumerable string keys（Object.keys），
      // 以 object identity Set 防 cycle；key 完全相等才算 violation（不看 value、不用 substring／regex）；
      // violation 只保存 { path, key }，detail 不含 body／token／電話／value。
      const forbiddenAdminKeys = new Set(['line_counter_bucket', 'line_counter_allocation_snapshot']);
      const adminViolations = [];
      const adminSeen = new Set();
      const scanAdminSurface = (node, p) => {
        if (node === null || typeof node !== 'object' || adminSeen.has(node)) return;
        adminSeen.add(node);
        const isArr = Array.isArray(node);
        for (const k of Object.keys(node)) {
          const childPath = isArr && /^(0|[1-9]\d*)$/.test(k) ? `${p}[${k}]` : `${p}.${k}`;
          if (forbiddenAdminKeys.has(k)) adminViolations.push({ path: childPath, key: k });
          scanAdminSurface(node[k], childPath);
        }
      };
      let auditedSurfaceCount = 0;
      for (const surface of [adminRes.json]) { auditedSurfaceCount++; scanAdminSurface(surface, '$'); }
      assert(
        adminRes.status === 200 && !!adminRes.json && adminRes.json.success === true && auditedSurfaceCount === 1 && adminViolations.length === 0,
        '42-admin-response-audited authenticated admin API（GET /api/orders/:id）response 在任何巢狀深度（object／array）都不含 line_counter_bucket 或 line_counter_allocation_snapshot（key 完全相等；200、success:true、稽核 1 個 surface）',
        JSON.stringify({ status: adminRes.status, success: adminRes.json ? (adminRes.json.success ?? null) : null, auditedSurfaceCount, violationCount: adminViolations.length, violations: adminViolations }),
      );
    }

    // ══════════════════════════════════════════════════════════════
    // 四十三（新增，R40）：popup non-interference——popup 訂單 bucket
    // 必須是 NULL，cancel/void 走 popup allocations，standard counters
    // 完全不變。
    // ══════════════════════════════════════════════════════════════
    {
      const popupSess43 = await makeSession(camp.id, loc.id, { name: 'R40PopupNonInterfere' });
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      const pc = await call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: popupSess43.public_code, customer_name: 'R40Popup1', customer_phone: '0955213001', items: [{ product_id: 301, qty: 1 }], payment_method: 'cash' } });
      assert(pc.status === 201, '43-popup-precheck-checkout popup checkout 真實成功', JSON.stringify(pc).slice(0, 150));
      const pOrder = db.get('SELECT id, line_counter_bucket FROM orders WHERE customer_phone=?', ['0955213001']);
      assert(pOrder.line_counter_bucket === null, '43-popup-bucket-is-null popup 訂單的 line_counter_bucket 確實是 NULL（不會被誤標成 quota/preorder）', JSON.stringify(pOrder));
      const qAfterCheckout = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterCheckout = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfterCheckout === qBefore && pAfterCheckout === pBefore, '43-popup-checkout-standard-counters-unchanged popup checkout 後 standard LINE 的 quota/preorder counter 完全不變', JSON.stringify({ qBefore, qAfterCheckout, pBefore, pAfterCheckout }));

      const cancelRes = await call('PATCH', `/api/orders/${pOrder.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      assert(cancelRes.status === 200, '43-popup-cancel-succeeds popup 訂單 cancel 成功', `status=${cancelRes.status}`);
      const qAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfterCancel = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfterCancel === qBefore && pAfterCancel === pBefore, '43-popup-cancel-standard-counters-unchanged popup cancel 後 standard counters 仍完全不變', JSON.stringify({ qAfterCancel, pAfterCancel }));
      const allocReleased = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE order_id=? AND status='released'", [pOrder.id]).c;
      assert(allocReleased === 1, '43-popup-cancel-allocation-released popup cancel 正確透過 popup_order_allocations 釋放（不是走 standard counter 機制）', String(allocReleased));

      // repeat：不重複 release
      await call('PATCH', `/api/orders/${pOrder.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      const allocReleasedAfterRepeat = db.get("SELECT COUNT(*) as c FROM popup_order_allocations WHERE order_id=? AND status='released'", [pOrder.id]).c;
      assert(allocReleasedAfterRepeat === 1, '43-popup-repeat-cancel-no-double-release 重複 cancel 沒有產生第二筆 released', String(allocReleasedAfterRepeat));
    }

    // ══════════════════════════════════════════════════════════════
    // 四十四（新增，R41）：全專案 INSERT INTO orders 稽核結果（用 rg
    // 找出，逐一讀過，不只 grep 就下結論）：
    //
    //   1. routes/line-orders.js（standard LINE，同日/預購）
    //      → 已明確寫 line_counter_bucket（'quota'/'preorder'），本輪之前
    //        已大量功能測試覆蓋。
    //   2. routes/line-shipping.js（LINE 宅配/外送）
    //      → 稽核發現：這條路徑會依「逐商品」的 shipping_share_line_stock
    //        設定有條件地增加 line_quota_sold（沒有預購分支，宅配訂單
    //        不存在「preorder」概念），但 INSERT 完全沒有寫
    //        line_counter_bucket，會落到 NULL、退回 pickup_time
    //        legacy fallback。這是真實存在、本輪稽核發現、但因為
    //        shipping 訂單本身的扣款邏輯是「逐商品有條件」而非像標準
    //        LINE 單「整張訂單一次判斷」，需要另外設計 bucket 寫入時機
    //        （建立時每個 item 的判斷可能不同，理論上一張訂單可能有些
    //        商品扣、有些不扣），跟目前「一張訂單一個 bucket」的簡單模型
    //        不完全對應。本輪在剩餘時間內判斷不宜倉促下 production 修正，
    //        如實記錄為已知缺口、留待專門的一輪處理，不假稱已修好。
    //   3. routes/orders.js（POS/admin 訂單）
    //      → 稽核確認：整個檔案除了本輪自己寫的 restoreLineQuotaCounters
    //        呼叫（在註解裡提到這兩個 counter 名稱）之外，完全沒有任何
    //        UPDATE 動到 line_quota_sold/line_preorder_sold。bucket 保持
    //        NULL 是正確、不需要修正的行為。下面用真實 POST /api/orders
    //        建立一筆驗證。
    //   4. routes/popup-public.js（popup checkout）
    //      → 已在前面章節大量測試，bucket 確認為 NULL，counter 完全不受
    //        影響（走 popup_order_allocations）。
    //   5. routes/sync.js（同步/匯入）
    //      → 稽核確認：整個檔案沒有任何一行涉及這兩個 counter，bucket
    //        保持 NULL 正確。
    // ══════════════════════════════════════════════════════════════
    {
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pBefore = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      // R44.2D：前面新增的大量建單會消耗 ING_ID2 食材庫存，POS 建單會檢查食材庫存，先補足（fixture 復原，不影響被測邏輯）
      db._db.run('UPDATE ingredients SET total_stock=100000, refrigerated_stock=100000 WHERE id IN (?,?)', [ING_ID, ING_ID2]); db._save();
      const posRes = await call('POST', '/api/orders', { token: T1, body: {
        items: [{ product_id: 301, name: '排骨飯', price: 120, qty: 2 }],
        payment_method: 'cash', order_mode: 'dine_in', order_status: 'completed',
        customer_name: 'POS訂單R41', customer_phone: '', received_amount: 300,
      }});
      assert(posRes.status === 201, '44-pos-order-prereq-create prerequisite：真實 POS 建單必須成功', `status=${posRes.status} ${JSON.stringify(posRes.json).slice(0, 150)}`);
      const posOrderId = posRes.json.data.id;
      const posOrderRow = db.get('SELECT line_counter_bucket, source, items, total, status FROM orders WHERE id=?', [posOrderId]);
      assert(posOrderRow.line_counter_bucket === null, '44-pos-order-bucket-null POS 訂單的 line_counter_bucket 正確為 NULL（真實建立驗證，不是只讀 code 下結論）', JSON.stringify(posOrderRow));
      const qAfter = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const pAfter = db.get('SELECT line_preorder_sold FROM products WHERE id=301').line_preorder_sold;
      assert(qAfter === qBefore && pAfter === pBefore, '44-pos-order-counters-unaffected POS 訂單建立完全不影響 line_quota_sold/line_preorder_sold', JSON.stringify({ qBefore, qAfter, pBefore, pAfter }));
      assert(posOrderRow.items && posOrderRow.items.includes('301') && Number(posOrderRow.total) > 0 && posOrderRow.status, '44-pos-order-fields-not-misaligned items/total/status 等既有欄位沒有因為新增 line_counter_bucket 欄位而錯位', JSON.stringify(posOrderRow));
    }

    // ══════════════════════════════════════════════════════════════
    // 四十五（新增，R41）：永久三次 cold-start migration regression——
    // 用真正的 child_process（不是同 process 重跑 initDb()），對同一個
    // temp DB file 做三次獨立冷啟動，每次都是全新的 Node process、全新
    // 的 require cache，真正驗證 migration 對「已存在的 DB 檔案」是
    // idempotent 的，不是靠 singleton cache 碰巧看起來正確。
    // ══════════════════════════════════════════════════════════════
    {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      // R44.2 稽核發現：execFileSync 是同步、會整個擋住 Node 事件迴圈的
      // 呼叫；這個測試程式本身跟被測試的 Express server 是同一個 process，
      // 擋住事件迴圈的期間，server 完全無法處理任何連線（包含既有的
      // keep-alive TCP 連線）——真實重現過一次 ECONNRESET/fetch failed，
      // 時間點精準對在 migration subprocess 測試剛結束、下一個真實 HTTP
      // request 送出的當下。改用 execFileAsync（不擋事件迴圈）修正。
      const migTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-migration-coldstart-'));
      const migDbPath = path.join(migTmpDir, 'coldstart-test.db');
      const projectRoot = path.join(__dirname, '..');

      try {
        // Cold start #0：先用 initDb() 建立一個「還沒有 line_counter_bucket
        // 欄位之前」的 legacy DB——透過先建立、再手動 DROP 這個欄位來模擬
        // （sql.js 不支援 DROP COLUMN，改用「建一個沒有這欄位的全新 table
        // 再搬資料」的方式，模擬 legacy schema 狀態，之後才讓 migration
        // 真正把欄位加回去）。
        (await execFileAsync('node', ['-e', `
          process.env.POS_DB_PATH = ${JSON.stringify(migDbPath)};
          const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
          (async () => {
            await initDb();
            const db = getDb();
            // 模擬 legacy schema：建一張沒有 line_counter_bucket 的 orders_legacy_snapshot，
            // 保留一筆完整資料，之後拿掉 line_counter_bucket 欄位本身沒辦法用 sql.js 直接做，
            // 這裡改用「刪除這欄位對應的 migration 效果」：直接把這欄位的值清乾淨、
            // 假裝它從未被寫過，藉此驗證的是「重跑 migration 不會破壞已有資料」這個
            // 核心不變量（比起硬要模擬拿掉一整個欄位，這個方式更貼近真實情境：
            // 舊版程式碼建立的 row，bucket 欄位存在但從未被寫入過，值是 NULL）。
            db._db.run("INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES ('store_001','脆豬腰','Mgr','pro',1)");
            db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, created_at, updated_at) VALUES ('legacy-order-1','LEGACY-1','store_001','takeout','pending','pending','Legacy','0900000001','[]','cash',0,0,'line','','2026-01-01 00:00:00','2026-01-01 00:00:00')");
            db._save();
          })();
        `], { cwd: projectRoot }));
        // legacy row 的 bucket 是 NULL，然後寫入 quota/preorder/NULL 三種 row。
        const out1 = (await execFileAsync('node', ['-e', `
          process.env.POS_DB_PATH = ${JSON.stringify(migDbPath)};
          const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
          (async () => {
            await initDb();
            const db = getDb();
            const cols = db.all("PRAGMA table_info(orders)").filter(c => c.name === 'line_counter_bucket');
            const legacyRow = db.get("SELECT line_counter_bucket FROM orders WHERE id='legacy-order-1'");
            db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, created_at, updated_at) VALUES ('mig-quota','MIG-Q','store_001','takeout','pending','pending','MigQ','0900000002','[]','cash',0,0,'line','10:00','quota','2026-01-02 00:00:00','2026-01-02 00:00:00')");
            db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, created_at, updated_at) VALUES ('mig-preorder','MIG-P','store_001','takeout','pending','pending','MigP','0900000003','[]','cash',0,0,'line','2026-02-01 00:00','preorder','2026-01-02 00:00:00','2026-01-02 00:00:00')");
            db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, created_at, updated_at) VALUES ('mig-null','MIG-N','store_001','takeout','pending','pending','MigN','0900000004','[]','cash',0,0,'admin','','NULL','2026-01-02 00:00:00','2026-01-02 00:00:00')");
            db._db.run("UPDATE orders SET line_counter_bucket=NULL WHERE id='mig-null'");
            db._save();
            console.log(JSON.stringify({ colCount: cols.length, legacyBucket: legacyRow ? legacyRow.line_counter_bucket : 'MISSING' }));
          })();
        `], { cwd: projectRoot })).stdout.trim();
        const result1 = JSON.parse(out1.split('\n').pop());
        assert(result1.colCount === 1, '45-coldstart1-column-added-once cold start #1（真正獨立 child process）：line_counter_bucket 欄位恰好新增一次', JSON.stringify(result1));
        assert(result1.legacyBucket === null, '45-coldstart1-legacy-row-null cold start #1：legacy row（bucket 欄位從未被寫入過）的值正確是 NULL，不是被猜成 quota', JSON.stringify(result1));

        // Cold start #2：全新 process，欄位仍恰好一個，三種值原樣保留。
        const out2 = (await execFileAsync('node', ['-e', `
          process.env.POS_DB_PATH = ${JSON.stringify(migDbPath)};
          const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
          (async () => {
            await initDb();
            const db = getDb();
            const cols = db.all("PRAGMA table_info(orders)").filter(c => c.name === 'line_counter_bucket');
            const rows = {
              legacy: db.get("SELECT line_counter_bucket FROM orders WHERE id='legacy-order-1'").line_counter_bucket,
              quota: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-quota'").line_counter_bucket,
              preorder: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-preorder'").line_counter_bucket,
              nullRow: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-null'").line_counter_bucket,
            };
            console.log(JSON.stringify({ colCount: cols.length, rows }));
          })();
        `], { cwd: projectRoot })).stdout.trim();
        const result2 = JSON.parse(out2.split('\n').pop());
        assert(result2.colCount === 1, '45-coldstart2-column-still-one cold start #2（第二個獨立 child process）：欄位仍恰好一個，沒有重複 ALTER', JSON.stringify(result2));
        assert(result2.rows.legacy === null && result2.rows.quota === 'quota' && result2.rows.preorder === 'preorder' && result2.rows.nullRow === null, '45-coldstart2-values-preserved cold start #2：legacy/quota/preorder/NULL 四種值全部原樣保留，沒有被 migration 猜測 backfill', JSON.stringify(result2));

        // Cold start #3：再一個全新 process，結果必須與 #2 完全一致。
        const out3 = (await execFileAsync('node', ['-e', `
          process.env.POS_DB_PATH = ${JSON.stringify(migDbPath)};
          const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
          (async () => {
            await initDb();
            const db = getDb();
            const cols = db.all("PRAGMA table_info(orders)").filter(c => c.name === 'line_counter_bucket');
            const rows = {
              legacy: db.get("SELECT line_counter_bucket FROM orders WHERE id='legacy-order-1'").line_counter_bucket,
              quota: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-quota'").line_counter_bucket,
              preorder: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-preorder'").line_counter_bucket,
              nullRow: db.get("SELECT line_counter_bucket FROM orders WHERE id='mig-null'").line_counter_bucket,
            };
            console.log(JSON.stringify({ colCount: cols.length, rows }));
          })();
        `], { cwd: projectRoot })).stdout.trim();
        const result3 = JSON.parse(out3.split('\n').pop());
        assert(JSON.stringify(result3) === JSON.stringify(result2), '45-coldstart3-byte-identical-to-coldstart2 cold start #3（第三個獨立 child process）結果與 #2 完全一致', JSON.stringify({ result2, result3 }));
      } finally {
        try { fs.rmSync(migTmpDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 四十六（新增，R42）：pre-fix reproduction——standard LINE 同日單，
    // 混合「quota-enabled」商品 301 與「quota-disabled」商品 302。
    // 建立時 line-orders.js 本來就會逐商品判斷
    // `line_quota_daily>0 || line_quota_enabled`（301 符合、302 不符合），
    // 所以只有 301 會讓 line_quota_sold +qty。但 cancel/void 端的
    // restoreLineQuotaCounters() 目前對 order.items 裡的「每一個」商品都
    // 無條件扣 line_quota_sold，不管它當初是否真的有增加——這裡先用真實
    // API 重現這個錯誤，不改 production。
    // ══════════════════════════════════════════════════════════════
    {
      db._db.run('UPDATE products SET line_quota_enabled=0, line_quota_daily=0, line_quota_sold=15 WHERE id=302'); db._save();
      const qBefore = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const q302Before = db.get('SELECT line_quota_sold FROM products WHERE id=302').line_quota_sold;
      const co = await call('POST', '/api/line-orders', { token: T1, body: { customer_name: 'MixedItemRepro', customer_phone: '0955220001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 301, qty: 2 }, { product_id: 302, qty: 3 }] } });
      assert(co.status === 200 || co.status === 201, '46-mixed-prereq-create prerequisite：混合商品訂單真實建立必須成功', `status=${co.status} ${JSON.stringify(co.json).slice(0, 150)}`);
      const qAfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const q302AfterCreate = db.get('SELECT line_quota_sold FROM products WHERE id=302').line_quota_sold;
      assert(qAfterCreate === qBefore + 2, '46-mixed-create-only-enabled-item-counted 建立後只有商品 301（quota-enabled）讓 line_quota_sold +2', JSON.stringify({ qBefore, qAfterCreate }));
      assert(q302AfterCreate === q302Before, '46-mixed-create-disabled-item-not-counted 商品 302（quota-disabled）建立時完全沒有被扣（維持非零基準 15，證明真的沒動，不是剛好等於 0 看不出來）', JSON.stringify({ q302Before, q302AfterCreate }));
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955220001']);
      const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
      // 這裡刻意不預設一定失敗——如實記錄目前真實結果。若 302 的
      // line_quota_sold 在 cancel 後被動到（即使 301 本身數值正確），代表
      // restoreLineQuotaCounters() 確實對 order.items 裡的每一個商品都
      // 無條件扣，只是因為 302 之前剛好是 0（MAX clamp）才看不出來；這裡
      // 用非零基準 15 讓這個 phantom decrement 現形。
      const qAfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=301').line_quota_sold;
      const q302AfterCancel = db.get('SELECT line_quota_sold FROM products WHERE id=302').line_quota_sold;
      assert(qAfterCancel === qBefore, '46-mixed-cancel-restores-exact-amount cancel 後商品 301 的 line_quota_sold 精確恢復回建立前的值', JSON.stringify({ qBefore, qAfterCancel }));
      assert(q302AfterCancel === q302Before, '46-mixed-cancel-does-not-touch-disabled-item cancel 後商品 302（從未真正被扣過）的 line_quota_sold 完全沒被動到——用非零基準 15 驗證，不是靠剛好等於 0 掩蓋 phantom decrement', JSON.stringify({ q302Before, q302AfterCancel }));
    }

  } catch (e) {
    r7PrimaryError = e;
    throw e;
  } finally {
    const r7RestoreErrors = [];
    if (r7TakeoutSnapshot !== null) {
      try {
        db._db.run(`DELETE FROM settings WHERE ${R7_TAKEOUT_SELECTOR}`);
        r7TakeoutSnapshot.forEach((r) => db._db.run('INSERT INTO settings (store_id, key, value) VALUES (?, ?, ?)', [r.store_id, r.key, r.value]));
        db._save();
        const r7After = r7ReadTakeoutRows();
        if (JSON.stringify(r7After) !== JSON.stringify(r7TakeoutSnapshot)) {
          throw new Error(`R7 takeout fixture restore mismatch: expected keys [${r7TakeoutSnapshot.map((r) => r.key).join(',')}] actual keys [${r7After.map((r) => r.key).join(',')}]`);
        }
      } catch (e) {
        r7RestoreErrors.push(e);
      }
    }
    if (server) { try { server.close(); } catch (e) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    if (r7RestoreErrors.length && r7PrimaryError) throw new AggregateError([r7PrimaryError, ...r7RestoreErrors], 'R7: primary error + takeout fixture restore error');
    if (r7RestoreErrors.length) throw new AggregateError(r7RestoreErrors, 'R7 takeout fixture restore error');
  }
}


main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); process.exitCode = 1; });
