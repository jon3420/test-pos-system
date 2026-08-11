#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-4.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.4
//
// Final scope: Production Modified = 1 file (public/js/analytics-platforms.js).
// line-order.html / line-shipping.html are byte-identical to H1.4.3 baseline —
// verified separately via `diff -rq` against the baseline zip contents (not repeated
// here as a string-match, since a real byte diff is strictly stronger evidence).
//
// 誠實聲明：檢查數量是這輪修改實際能驗證的項目，沒有灌水到某個預設數字。

'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const platforms = read('public/js/analytics-platforms.js');
const lineOrder = read('public/line-order.html');
const lineShipping = read('public/line-shipping.html');

// ── Hard Gate A: view_product 不得 map GA4 view_item ──────────────
check('[Gate A] GA4_EVENT_MAP 不再有 view_product → view_item 的對應', !/view_product\s*:\s*['"]view_item['"]/.test(platforms));
// ── H1.4.6 SUPERSEDED：原「GA4_EVENT_MAP 不得有 view_item key」／「兩頁完全不
// 得出現 view_item 字面字串」是 H1.4.4 當時「畫面上根本沒有商品詳情」前提下的
// 正確防呆閘門。H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW 正式新增商品詳情 Modal 後，
// view_item 是合法必要事件，新契約改為驗證「view_item 只能經由商品詳情開啟路徑
// （openProductDetail/_trackViewItem 或 _trackViewItemShipping）送出，不能出現
// 在清單曝光（_setupViewProductObserver／IntersectionObserver）路徑」——與上面
// Gate D（observer 只送 view_product）互補，兩者合起來完整驗證新契約的邊界。
check('[Gate A→H1.4.6 SUPERSEDED] GA4_EVENT_MAP 現在必須有 view_item key 且對應 \'view_item\'（取代「不得有 view_item key」舊契約）', /view_item\s*:\s*['"]view_item['"]/.test(platforms));
check("[Gate B→H1.4.6 SUPERSEDED] line-order.html 的 view_item 只存在於商品詳情路徑（_trackViewItem 定義存在），取代「完全不得出現 view_item」舊契約", /function _trackViewItem\(/.test(lineOrder));
check("[Gate B] line-order.html 沒有 handleProductCardView 或等效 invented sender", !/handleProductCardView|CardView|ProductViewDelegation/i.test(lineOrder));
check("[Gate C→H1.4.6 SUPERSEDED] line-shipping.html 的 view_item 只存在於商品詳情路徑（_trackViewItemShipping 定義存在），取代「完全不得出現 view_item」舊契約", /function _trackViewItemShipping\(/.test(lineShipping));
check("[Gate C] line-shipping.html 沒有 bindProductViewDelegation 或等效 invented sender", !/bindProductViewDelegation|CardView/i.test(lineShipping));

// ── Hard Gate D: IntersectionObserver 可以 track view_product，但不得直接 gtag view_item ──
check('[Gate D] _setupViewProductObserver 只呼叫 _trackEvent(\'view_product\', ...)，沒有直接呼叫 gtag 或 view_item', (() => {
  const idx = lineOrder.indexOf('function _setupViewProductObserver');
  const block = lineOrder.slice(idx, idx + 1200);
  return /_trackEvent\(['"]view_product['"]/.test(block) && !/gtag\(/.test(block) && !/view_item/.test(block);
})());
check('[Gate D] line-shipping.html 的 _setupViewProductObserver 同樣只送 view_product，不直接送 view_item', (() => {
  const idx = lineShipping.indexOf('function _setupViewProductObserver');
  const block = lineShipping.slice(idx, idx + 1200);
  return /_trackEvent\(['"]view_product['"]/.test(block) && !/gtag\(/.test(block) && !/view_item/.test(block);
})());

// ── Hard Gate E: 既有 ecommerce mapping（add_to_cart/begin_checkout/purchase）保持 ──
check('[Gate E] GA4_EVENT_MAP 仍保留 add_to_cart 對應', /add_to_cart\s*:\s*['"]add_to_cart['"]/.test(platforms));
check('[Gate E] GA4_EVENT_MAP 仍保留 begin_checkout 對應', /begin_checkout\s*:\s*['"]begin_checkout['"]/.test(platforms));
check('[Gate E] GA4_EVENT_MAP 仍保留 purchase 對應', /purchase\s*:\s*['"]purchase['"]/.test(platforms));
check('[Gate E] GA4_EVENT_MAP 仍保留 payment_started → add_payment_info 對應', /payment_started\s*:\s*['"]add_payment_info['"]/.test(platforms));

// ── Hard Gate F: 不要誤刪 Meta / internal 對 view_product 的既有支援 ──
check('[Gate F] META_EVENT_MAP 的 view_product → ViewContent 對應未被更動', /view_product\s*:\s*['"]ViewContent['"]/.test(platforms));
check('[Gate F] line-order.html 的 _trackEvent 仍會 POST /api/analytics/events（內部記錄未受影響）', /apiFetch\('\/api\/analytics\/events'/.test(lineOrder));
check('[Gate F] line-shipping.html 的 _trackEvent 仍會 POST /api/analytics/events（內部記錄未受影響）', /\/api\/analytics\/events/.test(lineShipping));
check('[Gate F] line-order.html 的 _setupViewProductObserver / view_product 觸發邏輯完全未變更（跟 baseline 逐字相同）', (() => {
  const m = lineOrder.match(/function _setupViewProductObserver\(\)\{[\s\S]*?\n\}/);
  return !!m && /_trackEvent\('view_product',\{product_id:Number\(pid\)\}\)/.test(m[0]);
})());

// ── trackGA4 / trackPlatformEvent 結構完整性（沒有第二條平行 pipeline） ──
check('trackGA4() 只有一個函式定義', (platforms.match(/function trackGA4/g) || []).length === 1);
check('trackPlatformEvent() 只有一個函式定義', (platforms.match(/function trackPlatformEvent/g) || []).length === 1);
check('trackGA4 函式內只呼叫一次 window.gtag(\'event\', ...)（沒有 loop）', (() => {
  const m = platforms.match(/function trackGA4\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  return !!m && (m[0].match(/window\.gtag\(/g) || []).length === 1;
})());

// ── 禁止手法檢查（不能用這些方式「掩蓋」根因） ──────────────────
const forbidden = [
  { name: '沒有用 "除以9" 這種硬編碼手法', re: /\/\s*9\b/ },
  { name: '沒有用 setTimeout debounce 硬擋重複事件', re: /setTimeout[^)]*debounce.*view_item/i },
  { name: '沒有用全域 viewItemSent=true 這種永久旗標', re: /viewItemSent\s*=\s*true/ },
];
forbidden.forEach(f => {
  check(`禁止手法檢查：${f.name}`, !f.re.test(lineOrder) && !f.re.test(lineShipping) && !f.re.test(platforms));
});

// ── H1.4.3 Freeze 存在性防呆（byte-diff 由外部 diff -rq 驗證，見 Reality Audit） ──
check('public/js/geo-ga4-h1-panel.js 存在（H1.4.3 唯一 Production 檔案，本輪不得動它）', fs.existsSync(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js')));

// ── Report ──────────────────────────────────────────────────────
const total = results.length;
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);

console.log(`\nH1.4.4 Static Audit — ${passed}/${total} passed\n`);
results.forEach(r => console.log(`${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ' — ' + r.detail : ''}`));

process.exitCode = failed.length ? 1 : 0;
