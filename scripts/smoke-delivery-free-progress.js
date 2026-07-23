// scripts/smoke-delivery-free-progress.js — C3
// Regression test for getDeliveryFreeProgressState()（外送滿額免運進度提示）。
// 直接 require() public/js/delivery-free-progress.js —— 與瀏覽器 <script src="/js/
// delivery-free-progress.js"> 載入的是同一份檔案，不是另外複製一份邏輯，避免測試與
// UI 行為漂移。
//
// C3：函式簽章改為直接吃後端 calculateDeliveryFeeWithPromotion() 算好的
// threshold/mode/rawDeliveryFee/finalDeliveryFee/reached/feeResolved，不再自己假設
// 「全店只有一個滿額門檻」。
'use strict';
const path = require('path');
const modPath = path.join(__dirname, '..', 'public', 'js', 'delivery-free-progress.js');

let mod;
try {
  mod = require(modPath);
} catch (e) {
  console.error(`[FATAL] 無法載入 ${modPath}：${e.message}`);
  process.exit(1);
}
const { getDeliveryFreeProgressState } = mod;
if (typeof getDeliveryFreeProgressState !== 'function') {
  console.error('[FATAL] public/js/delivery-free-progress.js 沒有匯出 getDeliveryFreeProgressState');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── 1. 外帶模式：一律隱藏 ─────────────────────────────
(function () {
  console.log('[1] 外帶模式');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1500, threshold: 1000, mode: 'full', isDelivery: false,
  });
  check('visible === false', s.visible === false, JSON.stringify(s));
})();

// ── 2. mode === 'none'：完全隱藏 ─────────────────────
(function () {
  console.log("[2] mode === 'none'");
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 500, threshold: 1000, mode: 'none', isDelivery: true,
  });
  check('visible === false', s.visible === false, JSON.stringify(s));
})();

// ── 3. full 未達 ──────────────────────────────────────
(function () {
  console.log('[3] full 未達');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 700, threshold: 1000, mode: 'full', isDelivery: true, reached: false, remaining: 300,
  });
  check('visible === true', s.visible === true);
  check('reached === false', s.reached === false);
  check('description 提到「享免運」或「即可免運」', /免運/.test(s.description), s.description);
})();

// ── 4. full 已達且 feeResolved：顯示已免運＋折抵金額 ──
(function () {
  console.log('[4] full 已達且 feeResolved');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, mode: 'full', isDelivery: true, reached: true,
    feeResolved: true, rawDeliveryFee: 120, finalDeliveryFee: 0,
  });
  check('reached === true', s.reached === true);
  check('headline 提到「已達免運資格」', s.headline.includes('已達免運資格'), s.headline);
  check('description 提到本次已免 NT$120', s.description.includes('120'), s.description);
})();

// ── 5. full 已達但 feeResolved=false：只能說已達門檻，不能宣告已免運 ──
(function () {
  console.log('[5] full 已達但外送費尚未算出（feeResolved=false）');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, mode: 'full', isDelivery: true, reached: true,
    feeResolved: false, rawDeliveryFee: null, finalDeliveryFee: null,
  });
  check('headline 為「已達滿額門檻」（不是已達免運資格）', s.headline.includes('已達滿額門檻'), s.headline);
  check('不得出現「免運資格」字樣', !s.headline.includes('免運資格') && !s.description.includes('免運資格'));
})();

// ── 6. fixed 未達 ─────────────────────────────────────
(function () {
  console.log('[6] fixed 未達');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 700, threshold: 1000, mode: 'fixed', isDelivery: true, reached: false, remaining: 300,
    rawDeliveryFee: 100, // 設定的折抵值，供文案顯示
  });
  check('description 提到折抵 NT$100', s.description.includes('100'), s.description);
})();

// ── 7. fixed 已達且 feeResolved：顯示折抵與仍需支付 ──
(function () {
  console.log('[7] fixed 已達且 feeResolved');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1500, threshold: 1500, mode: 'fixed', isDelivery: true, reached: true,
    feeResolved: true, rawDeliveryFee: 210, finalDeliveryFee: 110,
  });
  check('headline 提到「已達滿額外送優惠」', s.headline.includes('已達滿額外送優惠'), s.headline);
  check('description 提到本次折抵 NT$100', s.description.includes('100'), s.description);
  check('description 提到仍需支付 NT$110', s.description.includes('110'), s.description);
})();

// ── 8. 超距離：優先序最高，reached 強制 false ─────────
(function () {
  console.log('[8] 超距離');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 2000, threshold: 1000, mode: 'full', isDelivery: true,
    reached: true, feeResolved: true, isOutOfRange: true,
  });
  check('reached === false（即使金額已達標）', s.reached === false, JSON.stringify(s));
  check('headline 提到超出配送範圍', s.headline.includes('超出配送範圍'), s.headline);
  check('description 提到「滿額優惠不適用於超出配送範圍的地址」', s.description.includes('滿額優惠不適用於超出配送範圍的地址'));
})();

// ── 9. rawFee === 0：不得顯示「已折抵 NT$0」 ──────────
(function () {
  console.log('[9] rawFee 本來就是 0');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, mode: 'full', isDelivery: true, reached: true,
    feeResolved: true, rawDeliveryFee: 0, finalDeliveryFee: 0,
  });
  check('不得出現 NT$0 字樣', !s.description.includes('NT$0'), s.description);
})();

console.log(`\n[smoke-delivery-free-progress] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
