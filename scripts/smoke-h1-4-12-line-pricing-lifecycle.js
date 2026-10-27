#!/usr/bin/env node
// scripts/smoke-h1-4-12-line-pricing-lifecycle.js
// R44.2G：Standard LINE delivery 的真實 409 price_changed（BEGIN-boundary
// product-price race），使用真實 async 邊界（recalcDeliveryFee() 內對
// Google Routes API 的 fetch 呼叫）暫停/恢復，不新增 production-only hook。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 line pricing lifecycle (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-pricing-lifecycle-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pricing-lifecycle';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'test-fake-key';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  let server;
  try {
    // ── fixture：全天營業（已驗證 pattern）、外送距離級距、店家座標、商品 ──
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({
      mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
      wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
      fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
      sun: { open: '00:00', close: '23:59', enabled: true },
    })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
    // R44.1B-4B Phase A 稽核修正：delivery 走完全獨立的一組 settings key
    // （routes/line-orders.js getEffectiveModeSchedule() 依 mode 參數化，
    // 讀 delivery_business_hours／delivery_cutoff_time／
    // delivery_today_cutoff_time，跟 takeout_* 系列是平行、不共用的兩組
    // 設定）。上一輪只設了 takeout 那組，過了 21:00 之後真實
    // delivery cutoff（沒有被本 fixture 覆蓋）擋下了 delivery positive
    // control 與三個 price-race 案例，是真實的 fixture 缺口，不是
    // production bug。這裡用跟 takeout 完全相同、已驗證過的全天格式補上
    // delivery 那一組。
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'delivery_business_hours', ?)", [JSON.stringify({
      mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
      wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
      fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
      sun: { open: '00:00', close: '23:59', enabled: true },
    })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'delivery_cutoff_time', '')");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='delivery_today_cutoff_time'");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='delivery_today_cutoff_date'");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','store_lat','25.0330')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','store_lng','121.5654')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','delivery_max_distance_km','10')");
    // 單一級距涵蓋 0–10km，free_mode='full'、free_threshold=500：subtotal>=500 免運，否則收 50 元。
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','delivery_distance_fee_rules', ?)", [JSON.stringify([{ max_km: 10, fee: 50, free_mode: 'full', free_threshold: 500 }])]);
    const PID = 6101;
    db._db.run(`DELETE FROM products WHERE id=${PID}`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (${PID}, 'store_001', 'PricingLifecycleProduct', '主食', 100, 1)`);
    db._db.run(`UPDATE products SET show_on_line=1, sale_status='available' WHERE id=?`, [PID]);
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    const { requireStore } = require('../middleware/storeGuard'); const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), require('../routes/line-orders'));
    app.use('/api/line-shipping', requireStore, requireFeature('line_order'), require('../routes/line-shipping'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (body) => { const r = await fetch(`${base}/api/line-orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const callShip = async (body) => { const r = await fetch(`${base}/api/line-shipping`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const cancelOrder = async (id) => { const r = await fetch(`${base}/api/orders/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: JSON.stringify({ order_status: 'cancelled' }) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const voidOrder = async (id, reason) => { const r = await fetch(`${base}/api/orders/${id}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: JSON.stringify({ reason: reason || 'test', operator: 'test' }) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const orderCount = (phone) => db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [phone]).c;
    let phoneSeq = 0; const nextPhone = () => '0955320' + String(100 + (++phoneSeq));
    const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env, timeout: 15000 })).stdout.trim().split('\n').pop());

    // ══════════════════════════════════════════════════════════════
    // R44.2G-2 Reality Audit（記錄，非事後補寫）：
    //   1. bucket/snapshot：delivery 訂單走跟 same-day takeout 完全相同的
    //      isPreorderOrder 判斷（只看 pickup_date vs 今天，跟 order_type
    //      是 takeout 還是 delivery 無關），所以 delivery 同日單一樣是
    //      bucket='quota'；shipping 訂單固定 bucket='quota'（宅配沒有
    //      預購概念，已在前幾輪確認）。
    //   2. ingredient：standard（含 delivery）訂單透過
    //      product_ingredient_formulas 精確扣配方庫存；shipping 訂單完全
    //      不扣任何 ingredient（grep 已確認，前幾輪也已用真實控制案例
    //      證明）。
    //   3. coupon cancel/void 真實契約（本輪關鍵稽核）：grep 整個
    //      utils/orderStatusFlow.js 與 routes/orders.js 的 cancel／void
    //      程式碼路徑，完全沒有任何一行觸碰 coupon_redemptions 這張表。
    //      真實契約是：cancel／void 都「永久保留」coupon redemption，不
    //      釋放、不新增狀態欄位——優惠券的使用額度即使訂單後來被取消或
    //      作廢也不會歸還。這是本輪測試要驗證的既有事實，不是預期，也
    //      不是本輪要修正的目標。
    //   4. repeated/mixed transition 的真實 HTTP 契約沿用前幾輪已確認：
    //      repeat cancel 依 applyOrderStatusChange 的狀態機檢查拒絕；
    //      repeat void 因 order.status 已是 void 被 400 擋下；
    //      cancelled→void 允許（補 void metadata/log，不二次恢復資源，
    //      已在 durable-release suite 驗證過）；void→cancel 因
    //      isCancellable() 對 status='void' 判定為不可轉換而拒絕。
    // ══════════════════════════════════════════════════════════════
    function couponRedemptionCount(code) { return db.get("SELECT COUNT(*) AS c FROM coupon_redemptions WHERE store_id='store_001' AND coupon_code=?", [code]).c; }
    function makeCoupon(code, discount) {
      db._db.run("DELETE FROM coupons WHERE store_id='store_001' AND code=?", [code]);
      db._db.run("INSERT INTO coupons (store_id, code, name, discount_type, discount_value, min_amount, enabled, max_usage, max_usage_per_phone) VALUES ('store_001',?,?,'fixed',?,0,1,0,0)", [code, code, discount]);
      db._save();
    }
    function ordersnap(id) { return db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [id]); }
    function voidLogCount(id) { return db.get("SELECT COUNT(*) AS c FROM order_logs WHERE order_id=? AND action='void'", [id]).c; }

    // ── Reality Audit 記錄：recalcDeliveryFee()（routes/line-orders.js 內未匯出的私有函式）
    // 呼叫真實 fetch('https://routes.googleapis.com/...')，這是唯一可以從測試外部攔截、
    // 真正暫停/恢復的 async 邊界（不需要新增 production-only hook）。攔截此 fetch，
    // 讓回應延遲到我們決定釋放為止，即可在「第一次 pricing 已完成、尚未進入 BEGIN」的
    // 真實時間窗內修改商品價格。
    // Reality Audit 更正（第一次嘗試失敗後查出的真正原因）：
    // routes/line-orders.js 在模組載入當下就執行了
    // `const fetch = require('node-fetch')`，把這個函式參照複製進自己的
    // module-level const；app.use() 掛載路由時這行早就執行過了，之後再
    // 替換 require.cache['node-fetch'].exports 並不會改變
    // routes/line-orders.js 內那個已經綁定好的區域變數。node-fetch 內部
    // 真正發送請求時呼叫的是 Node 的 https.request()——這才是不受「哪個
    // module 何時 require」影響、每次呼叫都會重新查一次的真實邊界，用這
    // 一層攔截才攔得到。
    const https = require('https');
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const realHttpsRequest = https.request;
    function installRoutesStub(distanceMeters, opts) {
      opts = opts || {};
      let released = null; const releasedPromise = new Promise((res) => { released = res; });
      let callCount = 0;
      https.request = function (urlOrOpts, maybeOpts, maybeCb) {
        const hostname = typeof urlOrOpts === 'string' ? new URL(urlOrOpts).hostname : (urlOrOpts && urlOrOpts.hostname) || (urlOrOpts && urlOrOpts.href && new URL(urlOrOpts.href).hostname);
        if (hostname === 'routes.googleapis.com') {
          callCount++;
          const ee = new EventEmitter();
          ee.setTimeout = () => ee; ee.setHeader = () => {}; ee.end = () => {}; ee.destroy = () => {}; ee.write = () => true;
          const emitResponse = () => {
            // node-fetch 內部會對 response 呼叫 .pipe()，必須是真正的 Readable stream，不能只是 EventEmitter。
            const body = Buffer.from(JSON.stringify({ routes: [{ distanceMeters }] }));
            const res = new Readable({ read() {} });
            res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
            setImmediate(() => { ee.emit('response', res); res.push(body); res.push(null); });
          };
          if (opts.pauseUntilReleased) releasedPromise.then(emitResponse); else setImmediate(emitResponse);
          return ee;
        }
        return realHttpsRequest.apply(this, arguments);
      };
      return { release: () => released(), restore: () => { https.request = realHttpsRequest; }, callCountRef: () => callCount };
    }

    // ── 正向控制：真實 delivery order 成功 ──────────────────────
    {
      const stub = installRoutesStub(3000); // 3km
      const phone = nextPhone();
      const r = await call({ customer_name: 'PC', customer_phone: phone, order_type: 'delivery', payment_method: 'cash', delivery_lat: 25.04, delivery_lng: 121.57, delivery_address: '測試地址1號', delivery_fee_preview: 50, items: [{ product_id: PID, qty: 2 }] });
      stub.restore();
      assert(stub.callCountRef() === 1, 'PC-fee-provider-called-once fee provider（Routes API）確實被呼叫恰好一次', String(stub.callCountRef()));
      const httpOk = r.status === 200 || r.status === 201;
      assert(httpOk, 'PC-delivery-order-succeeds 真實 delivery order 建立成功', `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
      const row = httpOk ? db.get('SELECT items, subtotal, total, delivery_fee, delivery_distance_km FROM orders WHERE customer_phone=?', [phone]) : undefined;
      assert(!!row, 'PC-delivery-order-row-exists prerequisite：order row 真實存在於 DB（不只是 HTTP 回 2xx）', httpOk ? 'order row not found after 2xx' : `blocked: status=${r.status} reason=${(r.json && r.json.reason) || 'n/a'}`);
      if (!row) { summary(); return; }
      const items = JSON.parse(row.items);
      assert(items[0].name === 'PricingLifecycleProduct' && items[0].price === 100, 'PC-canonical-name-price stored items 使用 DB 權威 name/price', JSON.stringify(items));
      assert(row.subtotal === 200 && row.delivery_fee === 50 && row.total === 250 && row.delivery_distance_km === 3, 'PC-subtotal-fee-total-consistent subtotal(200)/fee(50，未達 500 免運門檻)/total(250)/distance(3km) 與 response/DB 一致', JSON.stringify(row));
      assert(r.json.data.total === 250, 'PC-response-matches-db response total 與 DB 一致', String(r.json.data.total));
    }

    // ── BEGIN 前價格變更：真實 async 邊界競態（暫停 Routes API 回應）──
    async function priceRaceCase(label, initialPrice, qty, newPrice, expectFreeCrossing) {
      db._db.run('UPDATE products SET price=? WHERE id=?', [initialPrice, PID]); db._save();
      const phone = nextPhone();
      const stub = installRoutesStub(3000, { pauseUntilReleased: true });
      const pending = call({ customer_name: label, customer_phone: phone, order_type: 'delivery', payment_method: 'cash', delivery_lat: 25.04, delivery_lng: 121.57, delivery_address: '測試地址1號', delivery_fee_preview: 50, discount_amount: 999, subtotal: 1, total: 1, delivery_fee: 1, items: [{ product_id: PID, qty, price: 1, name: 'FORGED' }] });
      // 讓 request 真正進入 recalcDeliveryFee() 並卡在我們的 fetch stub 裡（第一次 pricing 已完成 subtotal、
      // 尚未進入 BEGIN），才在這個真實等待窗內修改商品價格。
      await new Promise((r) => setTimeout(r, 50));
      db._db.run('UPDATE products SET price=? WHERE id=?', [newPrice, PID]); db._save();
      stub.release();
      const r = await pending;
      stub.restore();
      assert(r.status === 409 && r.json.reason === 'price_changed' && !/at\s+\S+\.js:\d+|SELECT|UPDATE|INSERT/i.test(JSON.stringify(r.json)), `RACE-${label}-409 真實 409 price_changed，無 SQL／stack 洩漏（client 偽造 price/subtotal/total/discount/delivery_fee 都無法避免這個拒絕）`, JSON.stringify(r).slice(0, 200));
      assert(orderCount(phone) === 0, `RACE-${label}-no-order 沒有 order 被建立`, '');
      assert(!db.get('SELECT id FROM coupon_redemptions WHERE order_number LIKE ?', [`%${phone}%`]), `RACE-${label}-no-coupon 沒有 coupon redemption`, '');
      const q = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      assert(q === 0, `RACE-${label}-counter-unchanged counter 未改變（本商品從未在此 suite 被扣過，維持 0）`, String(q));
      // 用新價格重新送出：應該重新取得 fee quote 並成功一次
      const stub2 = installRoutesStub(3000);
      const retry = await call({ customer_name: label, customer_phone: phone, order_type: 'delivery', payment_method: 'cash', delivery_lat: 25.04, delivery_lng: 121.57, delivery_address: '測試地址1號', delivery_fee_preview: expectFreeCrossing ? 0 : 50, items: [{ product_id: PID, qty }] });
      stub2.restore();
      const row = db.get('SELECT items, subtotal, delivery_fee, total FROM orders WHERE customer_phone=?', [phone]);
      assert(retry.status === 200 || retry.status === 201, `RACE-${label}-retry-succeeds 用新價格 retry 成功一次`, `status=${retry.status} ${JSON.stringify(retry.json).slice(0, 150)}`);
      assert(row && JSON.parse(row.items)[0].price === newPrice && row.subtotal === newPrice * qty, `RACE-${label}-retry-uses-new-price retry 使用最新 price，subtotal 正確`, JSON.stringify(row));
      const expectedFee = expectFreeCrossing ? 0 : 50;
      assert(row.delivery_fee === expectedFee && row.total === row.subtotal + expectedFee, `RACE-${label}-retry-fee-correct retry 的 delivery_fee(${expectedFee}) 與 total 正確反映新的免運門檻狀態`, JSON.stringify(row));
      assert(orderCount(phone) === 1, `RACE-${label}-no-ghost-order retry 成功後只有 1 張 order（沒有前一次失敗留下的幽靈 order）`, String(orderCount(phone)));
    }
    // A：漲價但未跨免運門檻（100→150，qty=2：200→300，均 < 500）
    await priceRaceCase('A-increase-no-cross', 100, 2, 150, false);
    // B：漲價且跨越免運門檻（100→300，qty=2：200→600，跨過 500）
    await priceRaceCase('B-increase-crosses-threshold', 100, 2, 300, true);
    // C：降價造成相反方向門檻變化（300→50，qty=2：從 600（免運）降到 100（收費））
    await priceRaceCase('C-decrease-reverse-threshold', 300, 2, 50, false);

    // ══════════════════════════════════════════════════════════════
    // R44.2G-2：8-row lifecycle matrix。額外 fixture：ingredient formula、
    // 不參與 counter 的對照商品（非零 baseline）、shipping 商品、coupon。
    // ══════════════════════════════════════════════════════════════
    // 修正真實 fixture 污染：本檔案前段的 price_changed race 案例
    // （R44.2G-1）在同一個 PID 上把 price 改到 300、又改到 50，且最後一案
    // 沒有復原。這裡在 8-row matrix 開始前明確重設回原始 100，並補上
    // coupon 功能旗標（前段從未啟用，L2/L4/L6/L7/L8 都需要）。
    db._db.run("UPDATE products SET price=100 WHERE id=?", [PID]);
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true, coupon: true })]);
    db._save();
    require('../middleware/featureGate').invalidateFeatureCache('store_001'); // license features 有快取，寫入後必須明確 invalidate
    const ING = 6901, OTHER_PID = 6102, SHIP_PID = 6103;
    db._db.run(`DELETE FROM ingredients WHERE id=?`, [ING]);
    db._db.run(`INSERT INTO ingredients (id, store_id, name, unit, total_stock, refrigerated_stock, frozen_stock, thawing_stock) VALUES (?, 'store_001', 'LC食材', 'g', 1000000, 1000000, 0, 0)`, [ING]);
    db._db.run(`DELETE FROM product_ingredient_formulas WHERE product_id=?`, [PID]);
    db._db.run(`INSERT INTO product_ingredient_formulas (product_id, ingredient_id, amount_per_unit) VALUES (?, ?, 3)`, [PID, ING]);
    db._db.run(`UPDATE products SET line_quota_enabled=1, line_quota_daily=100000, line_quota_sold=17, line_preorder_enabled=1, line_preorder_daily=100000, line_preorder_sold=19 WHERE id=?`, [PID]);
    db._db.run(`DELETE FROM products WHERE id=?`, [OTHER_PID]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, sale_status, line_quota_enabled, line_quota_daily, line_quota_sold) VALUES (?, 'store_001', 'LC不參與商品', '主食', 70, 1, 1, 'available', 0, 0, 23)`, [OTHER_PID]);
    db._db.run(`DELETE FROM products WHERE id=?`, [SHIP_PID]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, shipping_enabled, shipping_share_line_stock, line_quota_enabled, line_quota_daily, line_quota_sold) VALUES (?, 'store_001', 'LC宅配商品', '主食', 200, 1, 1, 1, 1, 100000, 29)`, [SHIP_PID]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_enabled','1')");
    db._save();
    function futureDate(days) { const d = new Date(Date.now() + 8 * 3600 * 1000 + days * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
    const FUTURE = futureDate(5);

    async function runLifecycleCase(caseId, opts) {
      // opts: { kind: 'takeout'|'preorder'|'delivery'|'shipping', coupon: bool, terminal: 'cancel'|'void' }
      const phone = nextPhone();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      const p0 = db.get('SELECT line_preorder_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      const other0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_PID]).v;
      const ing0 = db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING]).v;
      let couponCode = null, red0 = 0;
      if (opts.coupon) { couponCode = 'LC' + caseId; makeCoupon(couponCode, 10); red0 = couponRedemptionCount(couponCode); }
      let r, orderId;
      if (opts.kind === 'shipping') {
        const items = [{ product_id: SHIP_PID, qty: 2 }];
        const body = { recipient_name: 'LC' + caseId, phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items };
        if (couponCode) body.coupon_code = couponCode;
        r = await callShip(body);
      } else {
        const items = [{ product_id: opts.pid, qty: 2 }];
        const body = { customer_name: 'LC' + caseId, customer_phone: phone, order_type: opts.kind === 'delivery' ? 'delivery' : 'takeout', payment_method: 'cash', items };
        if (opts.kind === 'preorder') body.pickup_date = FUTURE;
        if (opts.kind === 'delivery') { body.delivery_lat = 25.04; body.delivery_lng = 121.57; body.delivery_address = '測試地址1號'; body.delivery_fee_preview = 50; }
        if (couponCode) body.coupon_code = couponCode;
        const stub = opts.kind === 'delivery' ? installRoutesStub(3000) : null;
        r = await call(body);
        if (stub) stub.restore();
      }
      assert(r.status === 200 || r.status === 201, `LC-${caseId}-prereq-create prerequisite：真實建單必須成功`, `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
      if (!(r.status === 200 || r.status === 201)) return null;
      const orderRow = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      assert(!!orderRow, `LC-${caseId}-order-row-exists prerequisite：order row 真實存在`, '');
      if (!orderRow) return null;
      orderId = orderRow.id;
      assert(orderCount(phone) === 1, `LC-${caseId}-exactly-one-order 恰好 1 張 order`, '');
      const full = db.get('SELECT items, subtotal, total, discount_amount, source, line_counter_bucket, line_counter_allocation_snapshot FROM orders WHERE id=?', [orderId]);
      const items = JSON.parse(full.items);
      const expectedPrice = opts.kind === 'shipping' ? 200 : 100;
      assert(items[0].product_id === opts.pid && items[0].price === expectedPrice && items[0].qty === 2, `LC-${caseId}-canonical-item canonical item name/price/qty 正確`, JSON.stringify(items));
      assert(full.subtotal === expectedPrice * 2, `LC-${caseId}-subtotal subtotal 正確（${expectedPrice * 2}）`, String(full.subtotal));
      if (couponCode) {
        assert(full.discount_amount === 10, `LC-${caseId}-coupon-discount coupon 折扣正確（10）`, String(full.discount_amount));
        assert(couponRedemptionCount(couponCode) === red0 + 1, `LC-${caseId}-coupon-redemption-once coupon redemption 恰好 1 筆`, '');
      }
      assert(full.line_counter_bucket === (opts.kind === 'preorder' ? 'preorder' : 'quota'), `LC-${caseId}-bucket bucket 正確（${opts.kind === 'preorder' ? 'preorder' : 'quota'}）`, full.line_counter_bucket);
      const snap = JSON.parse(full.line_counter_allocation_snapshot);
      assert(snap.allocations.length === 1 && snap.allocations[0].qty === 2 && snap.allocations[0].product_id === opts.pid, `LC-${caseId}-snapshot v1 snapshot 精確（product/qty=2）`, JSON.stringify(snap));
      const qAfter = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      const pAfter = db.get('SELECT line_preorder_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      if (opts.kind === 'preorder') assert(pAfter === p0 + 2 && qAfter === q0, `LC-${caseId}-counter-preorder preorder counter +2，quota 不變`, JSON.stringify({ q0, qAfter, p0, pAfter }));
      else assert(qAfter === q0 + 2 && pAfter === p0, `LC-${caseId}-counter-quota quota counter +2，preorder 不變`, JSON.stringify({ q0, qAfter, p0, pAfter }));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_PID]).v === other0, `LC-${caseId}-other-product-unchanged 不參與商品（非零 baseline ${other0}）完全沒有 phantom increment`, '');
      if (opts.kind === 'shipping') assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING]).v === ing0, `LC-${caseId}-ingredient-unchanged shipping 無 ingredient deduction，stock 不變`, '');
      else assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING]).v === ing0 - 6, `LC-${caseId}-ingredient-deducted ingredient 精確扣除（qty=2×3/單位=6）`, '');
      const fresh = await freshDisk(`SELECT COUNT(*) FROM orders WHERE id='${orderId}'`);
      assert(fresh[0][0] === 1, `LC-${caseId}-fresh-create fresh child process 讀到建立後狀態`, '');

      // terminal
      const termRes = opts.terminal === 'cancel' ? await cancelOrder(orderId) : await voidOrder(orderId, 'LC-' + caseId);
      assert(termRes.status === 200, `LC-${caseId}-terminal-succeeds ${opts.terminal} 成功`, `status=${termRes.status}`);
      const snapAfter = ordersnap(orderId);
      if (opts.terminal === 'void') assert(snapAfter.status === 'void' && snapAfter.order_status === 'cancelled' && !!snapAfter.void_reason && !!snapAfter.voided_at && voidLogCount(orderId) === 1, `LC-${caseId}-void-metadata void metadata 正確、恰好 1 筆 void log`, JSON.stringify(snapAfter));
      else assert(snapAfter.order_status === 'cancelled', `LC-${caseId}-cancel-status cancel 後 order_status 正確`, JSON.stringify(snapAfter));
      const qFinal = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      const pFinal = db.get('SELECT line_preorder_sold AS v FROM products WHERE id=?', [opts.pid]).v;
      if (opts.kind === 'preorder') assert(pFinal === p0 && qFinal === q0, `LC-${caseId}-counter-restored-once counter 精確恢復一次`, JSON.stringify({ p0, pFinal, q0, qFinal }));
      else assert(qFinal === q0 && pFinal === p0, `LC-${caseId}-counter-restored-once counter 精確恢復一次`, JSON.stringify({ q0, qFinal, p0, pFinal }));
      if (opts.kind === 'shipping') assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING]).v === ing0, `LC-${caseId}-ingredient-still-unchanged shipping ingredient 全程不變`, '');
      else assert(db.get('SELECT total_stock AS v FROM ingredients WHERE id=?', [ING]).v === ing0, `LC-${caseId}-ingredient-restored-once ingredient 精確恢復一次`, '');
      const snapFinal = db.get('SELECT line_counter_allocation_snapshot AS s, items AS i FROM orders WHERE id=?', [orderId]);
      assert(snapFinal.s === full.line_counter_allocation_snapshot && snapFinal.i === full.items, `LC-${caseId}-snapshot-not-rewritten snapshot／stored items 未被重寫`, '');
      if (couponCode) assert(couponRedemptionCount(couponCode) === red0 + 1, `LC-${caseId}-coupon-kept-after-terminal coupon redemption 依真實契約（永久保留、不釋放）在 ${opts.terminal} 後仍是 1 筆`, '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_PID]).v === other0, `LC-${caseId}-other-product-still-unaffected 另一筆不相關商品 ${opts.terminal} 後仍不受影響`, '');
      const freshFinal = await freshDisk(`SELECT order_status FROM orders WHERE id='${orderId}'`);
      assert(freshFinal[0][0] === 'cancelled', `LC-${caseId}-fresh-terminal fresh child process 讀到 terminal state`, '');
      return orderId;
    }

    await runLifecycleCase('L1', { kind: 'takeout', pid: PID, coupon: false, terminal: 'cancel' });
    await runLifecycleCase('L2', { kind: 'takeout', pid: PID, coupon: true, terminal: 'void' });
    await runLifecycleCase('L3', { kind: 'preorder', pid: PID, coupon: false, terminal: 'cancel' });
    await runLifecycleCase('L4', { kind: 'preorder', pid: PID, coupon: true, terminal: 'void' });
    await runLifecycleCase('L5', { kind: 'delivery', pid: PID, coupon: false, terminal: 'cancel' });
    await runLifecycleCase('L6', { kind: 'delivery', pid: PID, coupon: true, terminal: 'void' });
    await runLifecycleCase('L7', { kind: 'shipping', pid: SHIP_PID, coupon: true, terminal: 'cancel' });
    await runLifecycleCase('L8', { kind: 'shipping', pid: SHIP_PID, coupon: true, terminal: 'void' });

    // ══════════════════════════════════════════════════════════════
    // 五：authority-change-after-create
    // ══════════════════════════════════════════════════════════════
    {
      // A：standard true→false
      const phone = nextPhone();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const r = await call({ customer_name: 'AUTH-A', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      assert(r.status === 200 || r.status === 201, 'AUTH-A-prereq-create prerequisite：真實建單必須成功', `status=${r.status}`);
      const order = db.get('SELECT id, items FROM orders WHERE customer_phone=?', [phone]);
      db._db.run("UPDATE products SET name='AUTH-A改名', price=999, line_quota_enabled=0 WHERE id=?", [PID]); db._save();
      const c = await cancelOrder(order.id);
      db._db.run("UPDATE products SET name='PricingLifecycleProduct', price=100, line_quota_enabled=1 WHERE id=?", [PID]); db._save();
      assert(c.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, 'AUTH-A-cancel-restores-by-snapshot 建立後改名/改價/關閉 counter participation，cancel 仍依建立時 snapshot 精確恢復 qty=2', JSON.stringify({ status: c.status, q0, qAfter: db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v }));
      const storedItems = JSON.parse(order.items);
      assert(storedItems[0].name === 'PricingLifecycleProduct' && storedItems[0].price === 100, 'AUTH-A-items-unchanged stored order items 仍保留建立時 canonical name/price（不受事後改名改價影響）', JSON.stringify(storedItems));
    }
    {
      // B：standard false→true
      db._db.run("UPDATE products SET line_quota_enabled=0, line_quota_daily=0 WHERE id=?", [PID]); db._save();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const phone = nextPhone();
      const r = await call({ customer_name: 'AUTH-B', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      const order = db.get('SELECT id, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      assert(JSON.parse(order.s).allocations.length === 0, 'AUTH-B-empty-v1 建立時不參與 counter，snapshot 為 empty-v1', order.s);
      db._db.run("UPDATE products SET line_quota_enabled=1, line_quota_daily=100000 WHERE id=?", [PID]); db._save();
      const v = await voidOrder(order.id, 'AUTH-B');
      assert(v.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, 'AUTH-B-no-phantom-decrement 建立後把 participation 改回 true，void 不得減少 counter（依 snapshot=empty-v1，維持不變）', JSON.stringify({ q0, qAfter: db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v }));
      db._db.run("UPDATE products SET line_quota_enabled=1, line_quota_daily=100000, line_quota_sold=17 WHERE id=?", [PID]); db._save(); // 還原給後面案例
    }
    {
      // C：shipping true→false
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_PID]).v;
      const phone = nextPhone();
      const r = await callShip({ recipient_name: 'AUTH-C', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items: [{ product_id: SHIP_PID, qty: 2 }] });
      assert(r.status === 200 || r.status === 201, 'AUTH-C-prereq-create prerequisite：真實 shipping 建單必須成功', `status=${r.status}`);
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      db._db.run("UPDATE products SET shipping_price=888, name='AUTH-C改名', shipping_share_line_stock=0 WHERE id=?", [SHIP_PID]); db._save();
      const c = await cancelOrder(order.id);
      db._db.run("UPDATE products SET shipping_price=0, name='LC宅配商品', shipping_share_line_stock=1 WHERE id=?", [SHIP_PID]); db._save();
      assert(c.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_PID]).v === q0, 'AUTH-C-cancel-restores-by-snapshot shipping 建立後改價改名並關閉 share flag，terminal 仍依 snapshot 精確恢復 qty=2', '');
    }
    {
      // D：shipping false→true
      db._db.run("UPDATE products SET shipping_share_line_stock=0 WHERE id=?", [SHIP_PID]); db._save();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_PID]).v;
      const phone = nextPhone();
      const r = await callShip({ recipient_name: 'AUTH-D', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items: [{ product_id: SHIP_PID, qty: 2 }] });
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      db._db.run("UPDATE products SET shipping_share_line_stock=1 WHERE id=?", [SHIP_PID]); db._save();
      const v = await voidOrder(order.id, 'AUTH-D');
      assert(v.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SHIP_PID]).v === q0, 'AUTH-D-no-phantom-decrement shipping 建立時不參與，事後改為 true，terminal 不得產生 phantom decrement', '');
      db._db.run("UPDATE products SET shipping_share_line_stock=1, line_quota_sold=29 WHERE id=?", [SHIP_PID]); db._save();
    }

    // ══════════════════════════════════════════════════════════════
    // 六：repeated 與 mixed transition
    // ══════════════════════════════════════════════════════════════
    {
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const phone = nextPhone();
      await call({ customer_name: 'TRANS-1', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      await cancelOrder(order.id);
      const qAfterFirst = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const c2 = await cancelOrder(order.id);
      assert(c2.status !== 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === qAfterFirst, 'TRANS-1-repeat-cancel-rejected repeat cancel 被拒絕，counter 不再變化', `status=${c2.status}`);
    }
    {
      const phone = nextPhone();
      await call({ customer_name: 'TRANS-2', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      await voidOrder(order.id, 'first');
      const logAfterFirst = voidLogCount(order.id);
      const qAfterFirst = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const v2 = await voidOrder(order.id, 'second');
      assert(v2.status !== 200 && voidLogCount(order.id) === logAfterFirst && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === qAfterFirst, 'TRANS-2-repeat-void-rejected repeat void 不產生第二筆 log、不二次恢復', `status=${v2.status}`);
    }
    {
      const phone = nextPhone();
      await call({ customer_name: 'TRANS-3', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      await cancelOrder(order.id);
      const qAfterCancel = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const v = await voidOrder(order.id, 'cv');
      const qAfterVoid = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      assert(qAfterVoid === qAfterCancel, 'TRANS-3-cancelled-to-void-no-double-release cancelled→void（若被允許補 void metadata/log）不得二次恢復 counter', JSON.stringify({ status: v.status, qAfterCancel, qAfterVoid }));
    }
    {
      const phone = nextPhone();
      await call({ customer_name: 'TRANS-4', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }] });
      const order = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      await voidOrder(order.id, 'first');
      const before = { q: db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v, snap: ordersnap(order.id) };
      const c = await cancelOrder(order.id);
      assert(c.status !== 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === before.q && JSON.stringify(ordersnap(order.id)) === JSON.stringify(before.snap), 'TRANS-4-void-to-cancel-rejected void→cancel 依真實契約拒絕，raw DB 零資源變化', `status=${c.status}`);
    }

    assert(fs.readdirSync(path.dirname(process.env.POS_DB_PATH)).filter((f) => f.includes('.tmp-')).length === 0, 'FINAL-no-temp-residue 全程結束後無 durable temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
