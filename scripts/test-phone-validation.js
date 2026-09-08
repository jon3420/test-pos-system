// scripts/test-phone-validation.js — H1.4.10 PHONE-VALIDATION
// PHONE-FE / PHONE-BE / PHONE-SSOT targeted tests.
// Run: node scripts/test-phone-validation.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function check(id, condition, detail) {
  if (condition) { pass++; console.log('PASS', id); }
  else { fail++; failures.push(id + (detail ? ' - ' + detail : '')); console.log('FAIL', id, detail || ''); }
}

const PhoneUtils = require(path.join(ROOT, 'public/js/phone-utils.js'));

// ────────────────────────────────────────────────────────────
// PHONE-FE (logic-level, since these are pure PhoneUtils calls
// that both frontend fields wire into identically)
// ────────────────────────────────────────────────────────────

{
  const r = PhoneUtils.normalizeTaiwanMobile('0912345678');
  check('PHONE-FE-1', r.valid && r.local === '0912345678' && r.e164 === '+886912345678');
}
{
  const r = PhoneUtils.normalizeTaiwanMobile('0912-345-678');
  check('PHONE-FE-2', r.valid && r.local === '0912345678');
}
{
  const r = PhoneUtils.normalizeTaiwanMobile('0912 345 678');
  check('PHONE-FE-3', r.valid && r.local === '0912345678');
}
{
  const r = PhoneUtils.normalizeTaiwanMobile('+886912345678');
  check('PHONE-FE-4', r.valid && r.local === '0912345678' && r.e164 === '+886912345678');
}
check('PHONE-FE-5', !PhoneUtils.normalizeTaiwanMobile('09123456789').valid);
check('PHONE-FE-6', !PhoneUtils.normalizeTaiwanMobile('091234567').valid);
check('PHONE-FE-7', !PhoneUtils.normalizeTaiwanMobile('0812345678').valid);
check('PHONE-FE-8', !PhoneUtils.normalizeTaiwanMobile('09ABC45678').valid);
check('PHONE-FE-9', !PhoneUtils.normalizeTaiwanMobile('').valid && PhoneUtils.normalizeTaiwanMobile('').reason === 'required');

// PHONE-FE-10 / 11: line-order.html / line-shipping.html load phone-utils.js
// and call window.PhoneUtils in their submit-validation logic (no local regex).
{
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const usesScript = /<script\s+src="\/js\/phone-utils\.js(?:\?v=[^"]*)?"><\/script>/.test(orderHtml);
  const usesApi = /window\.PhoneUtils\.normalizeTaiwanMobile\(phone\)/.test(orderHtml);
  const noOwnRegex = !/09\\d\{8\}/.test(orderHtml.replace(/<script\s+src="\/js\/phone-utils\.js(?:\?v=[^"]*)?"><\/script>/g, ''));
  check('PHONE-FE-10', usesScript && usesApi && noOwnRegex, `script=${usesScript} api=${usesApi} noOwnRegex=${noOwnRegex}`);
}
{
  const shipHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const usesScript = /<script\s+src="\/js\/phone-utils\.js(?:\?v=[^"]*)?"><\/script>/.test(shipHtml);
  const usesApi = /window\.PhoneUtils\.normalizeTaiwanMobile\(phone\)/.test(shipHtml);
  check('PHONE-FE-11', usesScript && usesApi, `script=${usesScript} api=${usesApi}`);
}

// PHONE-FE-12: invalid phone blocks the create-order fetch call — verified
// structurally: the "return;" guard for invalid phone appears strictly
// before the apiFetch('/api/line-orders', ...) POST call in submitOrder().
{
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const guardIdx = orderHtml.indexOf("trackCheckoutValidationFailed('invalid_phone')");
  const fetchIdx = orderHtml.indexOf("apiFetch('/api/line-orders'");
  check('PHONE-FE-12', guardIdx !== -1 && fetchIdx !== -1 && guardIdx < fetchIdx);
}
{
  const shipHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const guardIdx = shipHtml.indexOf("trackCheckoutValidationFailed('invalid_phone')");
  const fetchIdx = shipHtml.indexOf("apiPost('/api/line-shipping'");
  check('PHONE-FE-12b (shipping)', guardIdx !== -1 && fetchIdx !== -1 && guardIdx < fetchIdx);
}

// PHONE-FE-13 / 14: blur handler normalizes formatted local / +886 to local via PhoneUtils
{
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const hasBlurFn = /function phoneUtilsNormalizeField\(fieldId\)/.test(orderHtml);
  const wiredOnCPhone = /id="cPhone"[^>]*onblur="phoneUtilsNormalizeField\('cPhone'\)"/.test(orderHtml);
  check('PHONE-FE-13', hasBlurFn && wiredOnCPhone);
  // Functional check: the blur function's logic is exactly PhoneUtils.normalizeTaiwanMobile
  // followed by writing r.local back into the field — verified via direct call:
  const r1 = PhoneUtils.normalizeTaiwanMobile('0912-345-678');
  const r2 = PhoneUtils.normalizeTaiwanMobile('+886912345678');
  check('PHONE-FE-14', r1.valid && r1.local === '0912345678' && r2.valid && r2.local === '0912345678');
}
{
  const shipHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const wiredOnRPhone = /id="rPhone"[^>]*onblur="phoneUtilsNormalizeField\('rPhone'\)"/.test(shipHtml);
  check('PHONE-FE-13b (shipping)', wiredOnRPhone);
}

// ────────────────────────────────────────────────────────────
// PHONE-BE (route-source-level: verify authoritative validation is wired
// correctly and ordered before side effects — full HTTP-server integration
// is not spun up here since the app requires a live DB/store context; this
// exercises the actual PhoneUtils calls the routes make plus structural
// ordering checks against the real route source).
// ────────────────────────────────────────────────────────────

const ordersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
const shippingSrc = fs.readFileSync(path.join(ROOT, 'routes/line-shipping.js'), 'utf8');

check('PHONE-BE-1', PhoneUtils.normalizeTaiwanMobile('0912345678').valid);
{
  const r = PhoneUtils.normalizeTaiwanMobile('+886912345678');
  check('PHONE-BE-2', r.valid && r.local === '0912345678');
}
{
  const r = PhoneUtils.normalizeTaiwanMobile('0912-345-678');
  check('PHONE-BE-3', r.valid && r.local === '0912345678');
}
check('PHONE-BE-4', !PhoneUtils.normalizeTaiwanMobile('09123456789').valid);
check('PHONE-BE-5', !PhoneUtils.normalizeTaiwanMobile('0812345678').valid);
check('PHONE-BE-6', !PhoneUtils.normalizeTaiwanMobile('09ABC45678').valid);
check('PHONE-BE-7', !PhoneUtils.normalizeTaiwanMobile('').valid);

// PHONE-BE-8/9: invalid phone → 400 INVALID_PHONE happens before any order
// insert / payment-related code in routes/line-orders.js source order.
{
  const phoneCheckIdx = ordersSrc.indexOf("error: 'INVALID_PHONE'");
  const insertIdx = ordersSrc.indexOf('INSERT INTO orders');
  const paymentGateIdx = ordersSrc.indexOf("PAYMENT_SETTINGS[payment_method]");
  check('PHONE-BE-8', phoneCheckIdx !== -1 && insertIdx !== -1 && phoneCheckIdx < insertIdx);
  check('PHONE-BE-9', phoneCheckIdx !== -1 && paymentGateIdx !== -1 && phoneCheckIdx < paymentGateIdx);
}

check('PHONE-BE-10', PhoneUtils.normalizeTaiwanMobile('0912345678').valid);
{
  const r = PhoneUtils.normalizeTaiwanMobile('+886923456789');
  check('PHONE-BE-11', r.valid && r.local === '0923456789');
}
check('PHONE-BE-12', !PhoneUtils.normalizeTaiwanMobile('09123456789').valid);

// PHONE-BE-13: shipping invalid phone → 400 before shipping order insert
{
  const phoneCheckIdx = shippingSrc.indexOf("error: 'INVALID_PHONE'");
  const insertIdx = shippingSrc.indexOf('INSERT INTO orders');
  check('PHONE-BE-13', phoneCheckIdx !== -1 && insertIdx !== -1 && phoneCheckIdx < insertIdx);
}

// PHONE-BE-14: old existing DB rows untouched — verified structurally: no
// UPDATE/migration statement targeting customer_phone/shipping_phone exists
// anywhere in the two route files (only fresh INSERT for new submissions).
{
  const noUpdatePhoneOrders = !/UPDATE\s+orders[\s\S]{0,200}customer_phone\s*=/.test(ordersSrc);
  const noUpdatePhoneShipping = !/UPDATE\s+orders[\s\S]{0,200}shipping_phone\s*=/.test(shippingSrc);
  check('PHONE-BE-14', noUpdatePhoneOrders && noUpdatePhoneShipping);
}

// ────────────────────────────────────────────────────────────
// PHONE-SSOT
// ────────────────────────────────────────────────────────────

{
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shipHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const usesInOrders = /require\(['"]\.\.\/public\/js\/phone-utils['"]\)/.test(ordersSrc);
  const usesInShipping = /require\(['"]\.\.\/public\/js\/phone-utils['"]\)/.test(shippingSrc);
  const usesInOrderHtml = /<script\s+src="\/js\/phone-utils\.js(?:\?v=[^"]*)?"><\/script>/.test(orderHtml);
  const usesInShipHtml = /<script\s+src="\/js\/phone-utils\.js(?:\?v=[^"]*)?"><\/script>/.test(shipHtml);
  check('PHONE-SSOT-1', usesInOrders && usesInShipping && usesInOrderHtml && usesInShipHtml,
    `orders=${usesInOrders} shipping=${usesInShipping} orderHtml=${usesInOrderHtml} shipHtml=${usesInShipHtml}`);
}
{
  // No second Taiwan-mobile regex (09\d{8} or equivalent) outside the SSOT file
  // in any of the four call sites.
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shipHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const pattern = /09\\d\{8\}|\^09\d\{8\}\$/;
  const clean = !pattern.test(orderHtml) && !pattern.test(shipHtml) &&
    !pattern.test(ordersSrc) && !pattern.test(shippingSrc);
  check('PHONE-SSOT-2', clean);
}

console.log('');
console.log('PHONE-FE/BE/SSOT total:', pass + fail, 'pass:', pass, 'fail:', fail);
if (failures.length) {
  console.log('Failures:', failures.join(', '));
  process.exitCode = 1;
}
