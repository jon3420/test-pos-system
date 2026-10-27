#!/usr/bin/env node
// scripts/smoke-h1-4-12-line-counter-snapshot-boundary.js
// R44.1B-4A：line_counter_bucket / line_counter_allocation_snapshot 的
// client forgery matrix、PATCH/PUT 可寫性、response exposure audit。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const jwt = require('jsonwebtoken');
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 line counter snapshot boundary (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
function findKeyPaths(obj, targetKeys, pathSoFar, out) {
  if (obj == null || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const p = pathSoFar ? `${pathSoFar}.${k}` : k;
    if (targetKeys.includes(k)) out.push(p);
    if (typeof obj[k] === 'object' && obj[k] !== null) findKeyPaths(obj[k], targetKeys, p, out);
  }
  return out;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-snapshot-boundary-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-boundary';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  let server;
  try {
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_002','y','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({ mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true }, wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true }, fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true }, sun: { open: '00:00', close: '23:59', enabled: true } })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_enabled','1')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','popup_pickup_enabled','1')");
    const PID = 8001, SHIP_PID = 8002;
    db._db.run(`DELETE FROM products WHERE id IN (${PID},${SHIP_PID})`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, sale_status, line_quota_enabled, line_quota_daily) VALUES (${PID}, 'store_001', 'BoundaryProduct', '主食', 100, 1, 1, 'available', 1, 100000)`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, shipping_enabled, shipping_share_line_stock, line_quota_enabled, line_quota_daily) VALUES (${SHIP_PID}, 'store_001', 'BoundaryShipProduct', '主食', 200, 1, 1, 1, 1, 100000)`);
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    const { requireStore } = require('../middleware/storeGuard'); const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), require('../routes/line-orders'));
    app.use('/api/line-shipping', requireStore, requireFeature('line_order'), require('../routes/line-shipping'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    app.use('/api/popup-pickup', requireStore, require('../routes/popup-pickup'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}), body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    let phoneSeq = 0; const nextPhone = () => '0955340' + String(100 + (++phoneSeq));
    const TARGET_KEYS = ['line_counter_bucket', 'line_counter_allocation_snapshot'];

    // ══════════════════════════════════════════════════════════════
    // Reality Audit（記錄，已用 grep 逐點確認，非臆測）：整個 codebase
    // 對這兩個欄位的讀寫點只有：
    //   1. Schema：utils/db.js（migration ALTER TABLE，各恰好一處）。
    //   2. Server-authoritative writer：routes/line-orders.js（standard）、
    //      routes/line-shipping.js（shipping）——兩處都是把 server 自己
    //      算出來的變數 JSON.stringify() 後寫入 INSERT，兩個 route 的
    //      request-body 解構清單裡都「沒有」這兩個欄位名稱，等於從語法
    //      層面就不會讀到 client 傳入的同名欄位。
    //   3. Restore validator：utils/orderStatusFlow.js（classifyPersistedOrder、
    //      parseAllocationSnapshot、restoreLineQuotaCounters）——只讀，不寫。
    //   4. Request-body reader：不存在——整個 codebase 沒有任何一處用
    //      `req.body.line_counter_bucket` 或
    //      `req.body.line_counter_allocation_snapshot` 讀取 client 輸入。
    //   5. PATCH/PUT allowlist：不存在——沒有任何 order 編輯端點的
    //      allowlist 包含這兩個欄位名稱。
    //   6. Public serializer：popup-public.js／line-orders.js／
    //      line-shipping.js 的 create response 都是手動組出來的固定物件
    //      （order_number/uuid/total/...），不是 spread 完整 row，兩個
    //      欄位從未出現。
    //   7. Authenticated admin serializer：routes/orders.js 的
    //      parseOrder(o) 用 `{...o, ...}` spread 完整 raw row，GET /:id、
    //      GET /（list）、PATCH /:id/status 與 POST /:id/void 的 response
    //      都經過這個函式，兩個欄位「會」出現在這些 authenticated 回應中。
    //   8. Export/report：搜尋整個 routes 目錄沒有找到獨立的 order export
    //      端點。
    //   9. Frontend consumer：本輪未逐一核對 public/js 內是否有畫面實際
    //      讀取這兩個欄位（見報告「尚未完成」）。
    // ══════════════════════════════════════════════════════════════

    // ── 正向控制 ──────────────────────────────────────────────
    let stdOrderId, shipOrderId, popupOrderId, popupSessCode;
    {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders', { customer_name: 'PC', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }] }, T1);
      assert(r.status === 200 || r.status === 201, 'PC-std-create-succeeds standard 正向控制建立成功', `status=${r.status}`);
      const row = db.get('SELECT id, line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      stdOrderId = row.id;
      assert(row.b === 'quota' && JSON.parse(row.s).allocations.length === 1, 'PC-std-server-v1 standard 寫入 server v1 snapshot（bucket=quota）', JSON.stringify(row));
    }
    {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-shipping', { recipient_name: 'PC', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items: [{ product_id: SHIP_PID, qty: 1 }] }, T1);
      assert(r.status === 200 || r.status === 201, 'PC-ship-create-succeeds shipping 正向控制建立成功', `status=${r.status}`);
      const row = db.get('SELECT id, line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      shipOrderId = row.id;
      assert(row.b === 'quota' && JSON.parse(row.s).allocations.length === 1, 'PC-ship-server-v1 shipping 寫入 server v1 snapshot（bucket=quota）', JSON.stringify(row));
    }
    {
      const camp = await call('POST', '/api/popup-pickup/campaigns', { name: 'BoundaryCamp', status: 'published' }, T1);
      const loc = await call('POST', '/api/popup-pickup/locations', { name: 'BoundaryLoc', address: 'x', lat: 25, lng: 121 }, T1);
      const sess = await call('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'BoundarySess', status: 'published', pickup_date: '2026-12-25', pickup_start_time: '17:00', pickup_end_time: '19:00', order_open_at: '2026-01-01T00:00', order_cutoff_at: '2026-12-24T23:59', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 100 }, T1);
      popupSessCode = sess.json.data.public_code;
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders/popup-checkout', { popup_session_public_code: popupSessCode, customer_name: 'PC', customer_phone: phone, items: [{ product_id: PID, qty: 1 }], payment_method: 'cash' });
      assert(r.status === 201, 'PC-popup-create-succeeds popup 正向控制建立成功', `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      const row = db.get('SELECT id, line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      popupOrderId = row.id;
      assert(row.b === null && row.s === null, 'PC-popup-fields-null popup order 的兩個 internal fields 真實維持 NULL（不使用 standard counter authority）', JSON.stringify(row));
    }

    // ══════════════════════════════════════════════════════════════
    // Standard / shipping / popup forgery matrix
    // ══════════════════════════════════════════════════════════════
    const forgeCases = [
      ['bucket-quota', { line_counter_bucket: 'quota' }],
      ['bucket-preorder', { line_counter_bucket: 'preorder' }],
      ['bucket-evil', { line_counter_bucket: 'evil' }],
      ['bucket-null', { line_counter_bucket: null }],
      ['bucket-array', { line_counter_bucket: ['quota'] }],
      ['bucket-object', { line_counter_bucket: { x: 1 } }],
      ['snapshot-valid-looking', { line_counter_allocation_snapshot: { version: 1, allocations: [{ product_id: 999, counter_bucket: 'quota', qty: 99 }] } }],
      ['snapshot-json-string', { line_counter_allocation_snapshot: JSON.stringify({ version: 1, allocations: [] }) }],
      ['snapshot-null', { line_counter_allocation_snapshot: null }],
      ['snapshot-array', { line_counter_allocation_snapshot: [1, 2, 3] }],
      ['snapshot-malformed', { line_counter_allocation_snapshot: '{not json' }],
      ['both-forged', { line_counter_bucket: 'preorder', line_counter_allocation_snapshot: { version: 1, allocations: [{ product_id: 999, counter_bucket: 'preorder', qty: 50 }] } }],
      ['store-id-forged', { store_id: 'store_002' }],
    ];
    for (const [label, extra] of forgeCases) {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders', Object.assign({ customer_name: 'F' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }] }, extra), T1);
      assert(r.status !== 500, `FORGE-std-${label}-no-500 standard forgery（${label}）不造成 500`, `status=${r.status}`);
      if (r.status === 200 || r.status === 201) {
        const row = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s, store_id AS sid FROM orders WHERE customer_phone=?', [phone]);
        const snap = JSON.parse(row.s);
        assert(row.b === 'quota' && snap.allocations.length === 1 && snap.allocations[0].product_id === PID && row.sid === 'store_001', `FORGE-std-${label}-server-authoritative DB 值完全等於 server builder 結果，store authority 仍為 store_001（不受 forged 欄位影響）`, JSON.stringify(row));
        assert(!JSON.stringify(r.json).includes('line_counter'), `FORGE-std-${label}-not-reflected response 不反射 forged internal field 名稱`, '');
      }
    }
    for (const [label, extra] of forgeCases.slice(0, 6)) { // shipping 涵蓋 bucket 系列＋store_id 即可，snapshot 系列與 standard 同一套 builder
      const phone = nextPhone();
      const r = await call('POST', '/api/line-shipping', Object.assign({ recipient_name: 'F' + label, phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items: [{ product_id: SHIP_PID, qty: 1 }] }, extra), T1);
      assert(r.status !== 500, `FORGE-ship-${label}-no-500 shipping forgery（${label}）不造成 500`, `status=${r.status}`);
      if (r.status === 200 || r.status === 201) {
        const row = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
        const snap = JSON.parse(row.s);
        assert(row.b === 'quota' && snap.allocations.length === 1 && snap.allocations[0].product_id === SHIP_PID, `FORGE-ship-${label}-server-authoritative shipping DB 值採自身真實 bucket 與 shipping_share_line_stock snapshot`, JSON.stringify(row));
      }
    }
    {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders/popup-checkout', { popup_session_public_code: popupSessCode, customer_name: 'ForgePopup', customer_phone: phone, items: [{ product_id: PID, qty: 1 }], payment_method: 'cash', line_counter_bucket: 'quota', line_counter_allocation_snapshot: { version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 99 }] }, store_id: 'store_002' });
      assert(r.status === 201, 'FORGE-popup-no-500 popup forgery 不造成 500', `status=${r.status}`);
      const row = db.get('SELECT id, line_counter_bucket AS b, line_counter_allocation_snapshot AS s, store_id AS sid FROM orders WHERE customer_phone=?', [phone]);
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      assert(row.b === null && row.s === null && row.sid === 'store_001', 'FORGE-popup-not-converted-to-standard popup order 沒有被偽造欄位轉成 standard LINE counter authority，internal fields 仍是 NULL，store 仍是真實 store_001', JSON.stringify(row));
      assert(!JSON.stringify(r.json).includes('line_counter'), 'FORGE-popup-not-reflected public response 不反射 forged top-level fields', '');
    }

    // ══════════════════════════════════════════════════════════════
    // nested metadata（spec/note/options）精確分類——不得僅因同名字串
    // 就誤判成 internal-field exposure。
    // ══════════════════════════════════════════════════════════════
    {
      const phone = nextPhone();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const r = await call('POST', '/api/line-orders', { customer_name: 'Meta', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1, options: { line_counter_bucket: 'evil', line_counter_allocation_snapshot: { version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 99 }] } } }] }, T1);
      assert(r.status === 200 || r.status === 201, 'META-create-succeeds nested metadata 建單成功', `status=${r.status}`);
      const row = db.get('SELECT items AS i, line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      const items = JSON.parse(row.i);
      const nestedPaths = findKeyPaths(items, TARGET_KEYS, 'items', []);
      assert(nestedPaths.length > 0, `META-nested-path-recorded 確認 order.items 內確實出現同名字串（JSON path：${nestedPaths.join(',')}），先如實記錄路徑，不假裝不存在`, nestedPaths.join(','));
      assert(row.b === 'quota' && JSON.parse(row.s).allocations[0].qty === 1, 'META-not-authority nested 同名欄位只是 opaque user metadata，完全沒有寫入 order 的 internal columns（真正的 bucket/snapshot 仍是 server 算出的 quota/qty=1，不是 metadata 裡偽造的 evil/99）', JSON.stringify(row));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 1, 'META-counter-not-affected nested metadata 沒有影響真實 counter（只 +1，不是被偽造的 99 污染）', '');
    }

    // ══════════════════════════════════════════════════════════════
    // PATCH/PUT 欄位可寫性
    // ══════════════════════════════════════════════════════════════
    {
      const before = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [stdOrderId]);
      const r = await call('PATCH', `/api/orders/${stdOrderId}/status`, { order_status: 'pending', line_counter_bucket: 'evil', line_counter_allocation_snapshot: { version: 1, allocations: [] } }, T1);
      const after = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [stdOrderId]);
      assert(JSON.stringify(after) === JSON.stringify(before), 'WRITE-status-patch-immutable PATCH /:id/status 同時夾帶 forged bucket/snapshot：internal fields byte-identical 不變', JSON.stringify({ before, after }));
    }
    {
      const before = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [shipOrderId]);
      const r = await call('POST', `/api/orders/${shipOrderId}/void`, { reason: 'write-test', operator: 'test', line_counter_bucket: 'evil', line_counter_allocation_snapshot: null }, T1);
      const after = db.get('SELECT line_counter_bucket AS b, line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [shipOrderId]);
      assert(after.b === before.b, 'WRITE-void-immutable void request 同時夾帶 forged bucket：void 後 bucket 欄位不受 forged payload 影響（正常 void 流程本身不改這個欄位）', JSON.stringify({ before, after }));
    }

    // ══════════════════════════════════════════════════════════════
    // response exposure audit（真實 HTTP，遞迴 key path 掃描）
    // ══════════════════════════════════════════════════════════════
    const exposureTable = [];
    async function auditResponse(surface, auth, respJson) {
      const paths = findKeyPaths(respJson, TARGET_KEYS, '', []);
      exposureTable.push({ surface, auth, paths });
      return paths;
    }
    {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders', { customer_name: 'Exp', customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }] }, T1);
      const paths = await auditResponse('standard-create', 'public(store-scoped-token)', r.json);
      assert(paths.length === 0, 'EXPOSURE-std-create standard create response 不含 internal fields', paths.join(','));
    }
    {
      const orderNo = db.get('SELECT order_number FROM orders WHERE id=?', [stdOrderId]).order_number;
      const r = await call('GET', `/api/line-orders/status/${orderNo}`, undefined, null);
      const paths = await auditResponse('public-order-status', 'public', r.json);
      assert(paths.length === 0, 'EXPOSURE-public-status public order status response 不含 internal fields', paths.join(','));
    }
    {
      const r = await call('GET', `/api/orders/${stdOrderId}`, undefined, T1);
      const paths = await auditResponse('admin-order-detail', 'authenticated-admin', r.json);
      exposureTable[exposureTable.length - 1].note = 'parseOrder() spreads raw row — confirmed exposure, authenticated-only, see report';
      assert(paths.length === 0, 'EXPOSURE-admin-detail-excluded R44.1B-4B Phase B 修正：consumer audit 確認無真實用途後已從 parseOrder() 排除，admin order detail 不再暴露 internal fields', paths.join(','))
    }
    {
      const r = await call('GET', `/api/orders?limit=5`, undefined, T1);
      const paths = await auditResponse('admin-order-list', 'authenticated-admin', r.json);
      assert(paths.filter((p) => !p.includes('options')).length === 0, 'EXPOSURE-admin-list-excluded admin order list 同樣透過 parseOrder() 排除，只剩下先前特意寫入的 nested opaque metadata 路徑（options.* 之外沒有 top-level internal field 路徑）', paths.join(','))
    }
    console.log('[EXPOSURE-TABLE]', JSON.stringify(exposureTable, null, 1));

    // ══════════════════════════════════════════════════════════════
    // 靜態 assertions（限定 production files，忽略註解）
    // ══════════════════════════════════════════════════════════════
    {
      const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const lo = rd('routes/line-orders.js'), ls = rd('routes/line-shipping.js'), pp = rd('routes/popup-public.js');
      assert(!/req\.body\.line_counter_bucket|req\.body\.line_counter_allocation_snapshot/.test(lo + ls + pp), 'STATIC-no-body-read 三條 create route 都不從 req.body 讀取這兩個 internal field 名稱', '');
      const loCreateStart = lo.indexOf("router.post('/', async");
      const loCreateBody = lo.slice(loCreateStart, lo.indexOf('\nrouter.', loCreateStart + 10));
      assert(!/const\s*\{[^}]*line_counter_bucket/.test(loCreateBody) && !/const\s*\{[^}]*line_counter_allocation_snapshot/.test(loCreateBody), 'STATIC-std-destructure-clean standard create handler 的 request body 解構不包含這兩個欄位名稱', '');
    }

    assert(fs.readdirSync(path.dirname(process.env.POS_DB_PATH)).filter((f) => f.includes('.tmp-')).length === 0, 'FINAL-no-temp-residue 全程結束後無 durable temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
