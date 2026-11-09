#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-system-regression.js — R54.4-MBV2 系統回歸（既有功能未受影響）
//
// 涵蓋既有回歸測試較少直接覆蓋的區域：POS 收銀建單、訂單紀錄查詢、商品／分類、食材／扣料公式、
// 優惠券、Android POS 既有 API（只帶 x-store-id）、License 查詢、Sync。
// 每個呼叫輸出「狀態碼＋回應形狀」到 --out JSON，以便在原始 R54.4 與修改版各跑一次後逐項比對。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');

function shape(j) {
  if (j == null) return null;
  if (Array.isArray(j)) return ['array', j.length ? shape(j[0]) : null];
  if (typeof j === 'object') { const o = {}; for (const k of Object.keys(j).sort()) o[k] = typeof j[k] === 'object' && j[k] !== null ? (Array.isArray(j[k]) ? 'array' : 'object') : typeof j[k]; return o; }
  return typeof j;
}

(async () => {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const dir = H.tmpDir('sys'); const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf);
  const rec = [];
  const call = async (label, tok, method, p, body, headers) => {
    const r = await H.api(s.base, tok, method, p, body, headers);
    const j = r.json;
    rec.push({ label, status: r.status, success: j && j.success, shape: shape(j && (j.data !== undefined ? j.data : j)) });
    return r;
  };
  try {
    const tok = await H.login(s.base, 'store_001', 'pw001');
    const X = { 'x-store-id': 'store_001' };
    // Android POS 既有 API（只帶 x-store-id）
    await call('android GET products', null, 'GET', '/api/products', undefined, X);
    await call('android GET categories', null, 'GET', '/api/categories', undefined, X);
    const created = await call('android POST orders（POS 收銀）', null, 'POST', '/api/orders', { items: [{ id: 201, name: '脆豬腰飯', qty: 1, price: 120 }], subtotal: 120, total: 120, payment_method: 'cash', order_mode: 'dine_in', received_amount: 200 }, X);
    await call('android GET orders today', null, 'GET', '/api/orders', undefined, X);
    await call('android GET sync config', null, 'GET', '/api/sync/config', undefined, X);
    await call('android POST sync orders', null, 'POST', '/api/sync/orders', { device_id: 'dev-1', orders: [{ uuid: 'sync-uuid-1', order_number: 'SYNC-1', items: [], subtotal: 10, total: 10, payment_method: 'cash', created_at: '2026-11-09 10:00:00' }] }, X);
    await call('android POST sync orders duplicate', null, 'POST', '/api/sync/orders', { device_id: 'dev-1', orders: [{ uuid: 'sync-uuid-1', order_number: 'SYNC-1', items: [], subtotal: 10, total: 10, payment_method: 'cash' }] }, X);
    await call('license GET store', null, 'GET', '/api/license/store_001');
    // 管理端（JWT）
    await call('jwt GET orders range', tok, 'GET', '/api/orders?date_from=2026-10-01&date_to=2026-10-31');
    await call('jwt GET order by number', tok, 'GET', '/api/orders/O-1015-LINE');
    await call('jwt GET products', tok, 'GET', '/api/products');
    await call('jwt GET ingredients', tok, 'GET', '/api/ingredients');
    await call('jwt GET formulas', tok, 'GET', '/api/ingredients/formulas/all');
    await call('jwt GET ingredient logs', tok, 'GET', '/api/ingredients/logs/all');
    await call('jwt GET coupons', tok, 'GET', '/api/coupons');
    await call('jwt POST coupon validate', tok, 'POST', '/api/coupons/validate', { code: 'OCT10', subtotal: 200, customer_phone: '0912345678' });
    await call('jwt GET inventory', tok, 'GET', '/api/inventory');
    await call('jwt GET settings', tok, 'GET', '/api/settings');
    await call('jwt legacy migration export preview', tok, 'GET', '/api/migration/export/preview');
    await call('jwt legacy migration config', tok, 'GET', '/api/migration/config');
    await call('jwt legacy orders export', tok, 'GET', '/api/export/orders?format=json');
    await call('LINE public menu', null, 'GET', '/api/line-orders/menu?store_id=store_001');
    await call('health', null, 'GET', '/api/health');
    const after = await H.snapshotCounts(dbf, 'store_001', ['orders']);
    rec.push({ label: 'db orders after (8 seeded + 1 POS + 1 sync)', value: after.orders });
    rec.push({ label: 'pos order created', value: !!(created.json && created.json.success) });
  } catch (e) { rec.push({ label: 'EXCEPTION', error: e.message }); }
  finally { await s.stop(); }
  for (const r of rec) console.log(JSON.stringify(r));
  if (out) fs.writeFileSync(out, JSON.stringify(rec, null, 2));
})();
