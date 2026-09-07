// scripts/test-phone-validation-integration.js — H1.4.10 PHONE-VALIDATION
// Real route/runtime integration test: invokes the ACTUAL exported
// routes/line-orders.js and routes/line-shipping.js POST '/' handlers
// (extracted directly from the live express.Router() stack — not
// reimplemented/mocked logic) against a real temporary sql.js-backed DB
// (utils/db.js, same module production uses), to prove:
//   - invalid phone → HTTP 400 { error: 'INVALID_PHONE' }
//   - invalid phone → 0 rows written to `orders` table (no partial writes)
//   - valid phone clears the phone gate (fails later, if at all, for an
//     unrelated reason — full order success requires store/product/
//     business-hours seeding that is out of scope for this fix)
//
// Run: node scripts/test-phone-validation-integration.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `phone-validation-test-${Date.now()}.db`);
process.env.POS_DB_PATH = TMP_DB;

let pass = 0, fail = 0;
const failures = [];
function check(id, condition, detail) {
  if (condition) { pass++; console.log('PASS', id); }
  else { fail++; failures.push(id + (detail ? ' - ' + detail : '')); console.log('FAIL', id, detail || ''); }
}

function mockRes() {
  const res = {
    _status: 200, _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function getPostRootHandler(router) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/' && l.route.methods && l.route.methods.post
  );
  if (!layer) throw new Error('POST / handler not found on router');
  // last handler function in the route's own stack is the actual route handler
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function main() {
  const { initDb, getDb } = require(path.join(__dirname, '..', 'utils', 'db.js'));
  await initDb();
  const db = getDb();

  // Minimal store row so any incidental store_id lookups don't throw.
  const STORE_ID = 'phone_test_store';
  try {
    db.run(
      `INSERT OR IGNORE INTO stores (store_id, store_name, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))`,
      [STORE_ID, 'Phone Test Store']
    );
  } catch (e) {
    // stores schema may require more columns in some baselines; ignore if it
    // already exists or partial insert fails — the phone gate itself runs
    // before any store-settings lookup, so this is best-effort only.
    console.warn('[integration] store seed warning:', e.message);
  }
  // routes/line-shipping.js gates the entire POST / on settings.shipping_enabled
  // (pre-existing feature flag, unrelated to this fix) *before* the phone
  // check — seed it so the integration test can actually reach the phone
  // gate for the shipping route, exactly like a real "shipping enabled" store.
  try {
    db.run(
      `INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)`,
      [STORE_ID, 'shipping_enabled', '1']
    );
  } catch (e) {
    console.warn('[integration] shipping_enabled seed warning:', e.message);
  }

  const lineOrdersRouter = require(path.join(__dirname, '..', 'routes', 'line-orders.js'));
  const lineShippingRouter = require(path.join(__dirname, '..', 'routes', 'line-shipping.js'));

  const ordersPostHandler = getPostRootHandler(lineOrdersRouter);
  const shippingPostHandler = getPostRootHandler(lineShippingRouter);

  function countOrders() {
    const rows = db.all('SELECT * FROM orders');
    return rows.length;
  }

  // ── PHONE-BE-8/9 (real runtime): invalid phone → 400 INVALID_PHONE, 0 orders ──
  {
    const before = countOrders();
    const req = {
      body: {
        customer_name: '測試顧客',
        customer_phone: '09123456789', // 11 digits — invalid
        order_type: 'takeout',
        pickup_date: '2099-01-01',
        pickup_time: '盡快',
        payment_method: 'cash',
        items: [{ product_id: 1, name: 'Test', qty: 1, price: 100, subtotal: 100 }],
        subtotal: 100, total: 100,
      },
      storeId: STORE_ID,
      app: { get: () => null },
    };
    const res = mockRes();
    await ordersPostHandler(req, res);
    const after = countOrders();
    check('PHONE-BE-8 (real runtime)', res._status === 400 && res._body && res._body.error === 'INVALID_PHONE',
      `status=${res._status} body=${JSON.stringify(res._body)}`);
    check('PHONE-BE-9 (real runtime, 0 orders written)', after === before, `before=${before} after=${after}`);
  }

  // ── PHONE-BE valid phone clears the gate (does not return INVALID_PHONE) ──
  {
    const req = {
      body: {
        customer_name: '測試顧客',
        customer_phone: '0912345678', // valid
        order_type: 'takeout',
        pickup_date: '2099-01-01',
        pickup_time: '盡快',
        payment_method: 'cash',
        items: [{ product_id: 1, name: 'Test', qty: 1, price: 100, subtotal: 100 }],
        subtotal: 100, total: 100,
      },
      storeId: STORE_ID,
      app: { get: () => null },
    };
    const res = mockRes();
    await ordersPostHandler(req, res);
    const rejectedForPhone = res._body && res._body.error === 'INVALID_PHONE';
    check('PHONE-BE valid-phone clears gate (real runtime)', !rejectedForPhone,
      `status=${res._status} body=${JSON.stringify(res._body)}`);
  }

  // ── PHONE-BE-4/5/6/7 (real runtime): other invalid formats also 400 INVALID_PHONE ──
  for (const [id, phone] of [
    ['PHONE-BE-4 (real runtime, 11-digit)', '09123456789'],
    ['PHONE-BE-4b (real runtime, 9-digit)', '091234567'],
    ['PHONE-BE-5 (real runtime, wrong prefix)', '0812345678'],
    ['PHONE-BE-6 (real runtime, letters)', '09ABC45678'],
  ]) {
    const req = {
      body: {
        customer_name: '測試顧客', customer_phone: phone,
        order_type: 'takeout', pickup_date: '2099-01-01', pickup_time: '盡快',
        payment_method: 'cash',
        items: [{ product_id: 1, name: 'Test', qty: 1, price: 100, subtotal: 100 }],
        subtotal: 100, total: 100,
      },
      storeId: STORE_ID, app: { get: () => null },
    };
    const res = mockRes();
    await ordersPostHandler(req, res);
    check(id, res._status === 400 && res._body && res._body.error === 'INVALID_PHONE', JSON.stringify(res._body));
  }
  {
    // empty phone hits the earlier "請填寫姓名與電話" required-field guard
    // (not the PhoneUtils format gate) — still 400, still 0 side effects.
    const req = {
      body: {
        customer_name: '測試顧客', customer_phone: '',
        order_type: 'takeout', pickup_date: '2099-01-01', pickup_time: '盡快',
        payment_method: 'cash',
        items: [{ product_id: 1, name: 'Test', qty: 1, price: 100, subtotal: 100 }],
        subtotal: 100, total: 100,
      },
      storeId: STORE_ID, app: { get: () => null },
    };
    const res = mockRes();
    await ordersPostHandler(req, res);
    check('PHONE-BE-7 (real runtime, empty)', res._status === 400, JSON.stringify(res._body));
  }

  // ── PHONE-BE valid formatted phones clear the gate (dash / space / +886) ──
  for (const [id, phone] of [
    ['PHONE-BE valid dashed clears gate', '0912-345-678'],
    ['PHONE-BE valid +886 clears gate', '+886912345678'],
  ]) {
    const req = {
      body: {
        customer_name: '測試顧客', customer_phone: phone,
        order_type: 'takeout', pickup_date: '2099-01-01', pickup_time: '盡快',
        payment_method: 'cash',
        items: [{ product_id: 1, name: 'Test', qty: 1, price: 100, subtotal: 100 }],
        subtotal: 100, total: 100,
      },
      storeId: STORE_ID, app: { get: () => null },
    };
    const res = mockRes();
    await ordersPostHandler(req, res);
    const rejectedForPhone = res._body && res._body.error === 'INVALID_PHONE';
    check(id, !rejectedForPhone, `status=${res._status} body=${JSON.stringify(res._body)}`);
  }

  // ── PHONE-BE-12/13 shipping: invalid phone → 400 INVALID_PHONE, 0 orders ──
  for (const [id, phone] of [
    ['PHONE-BE-12 (shipping, real runtime, 11-digit)', '09123456789'],
    ['PHONE-BE-12b (shipping, real runtime, letters)', '09ABC45678'],
    ['PHONE-BE-12c (shipping, real runtime, empty)', ''],
  ]) {
    const before = countOrders();
    const req = {
      body: {
        items: [{ product_id: 1, name: 'Test', qty: 1 }],
        recipient_name: '測試收件人', phone,
        postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號',
        arrival_type: 'anytime', payment_method: 'cash',
      },
      storeId: STORE_ID, app: { get: () => null },
    };
    const res = mockRes();
    shippingPostHandler(req, res); // line-shipping.js POST '/' handler is sync
    const after = countOrders();
    check(id, res._status === 400 && ((res._body && res._body.error === 'INVALID_PHONE') || (phone === '' && res._status === 400)),
      `status=${res._status} body=${JSON.stringify(res._body)}`);
    check(id + ' (0 orders written)', after === before, `before=${before} after=${after}`);
  }

  // ── PHONE-BE-11 shipping: valid +886 clears the gate ──
  {
    const req = {
      body: {
        items: [{ product_id: 1, name: 'Test', qty: 1 }],
        recipient_name: '測試收件人', phone: '+886923456789',
        postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號',
        arrival_type: 'anytime', payment_method: 'cash',
      },
      storeId: STORE_ID, app: { get: () => null },
    };
    const res = mockRes();
    shippingPostHandler(req, res);
    const rejectedForPhone = res._body && res._body.error === 'INVALID_PHONE';
    check('PHONE-BE-11 (shipping, real runtime, +886 clears gate)', !rejectedForPhone,
      `status=${res._status} body=${JSON.stringify(res._body)}`);
  }

  console.log('');
  console.log('PHONE-BE integration total:', pass + fail, 'pass:', pass, 'fail:', fail);
  if (failures.length) {
    console.log('Failures:', failures.join(', '));
    process.exitCode = 1;
  }

  try { fs.unlinkSync(TMP_DB); } catch (e) { /* best-effort cleanup */ }
}

main().catch((e) => {
  console.error('[integration] fatal error:', e);
  process.exitCode = 1;
});
