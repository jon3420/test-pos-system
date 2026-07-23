// scripts/smoke-delivery-free-progress.js
// Regression test for getDeliveryFreeProgressState()（外送滿額免運進度提示）。
// 直接 require() public/js/delivery-free-progress.js —— 與瀏覽器 <script src="/js/
// delivery-free-progress.js"> 載入的是同一份檔案，不是另外複製一份邏輯，避免測試與
// UI 行為漂移。
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
    eligibleSubtotal: 1500, threshold: 1000, enabled: true, isDelivery: false,
  });
  check('visible === false', s.visible === false, JSON.stringify(s));
})();

// ── 2. 未啟用 ────────────────────────────────────────
(function () {
  console.log('[2] 未啟用 (enabled=false)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 500, threshold: 1000, enabled: false, isDelivery: true,
  });
  check('visible === false', s.visible === false, JSON.stringify(s));
})();

// ── 3. 門檻無效 (threshold<=0) ───────────────────────
(function () {
  console.log('[3] 門檻無效 (threshold=0)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 500, threshold: 0, enabled: true, isDelivery: true,
  });
  check('visible === false', s.visible === false, JSON.stringify(s));
})();

// ── 4. 未達門檻 ──────────────────────────────────────
(function () {
  console.log('[4] 未達門檻 (650/1000)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 650, threshold: 1000, enabled: true, isDelivery: true,
    rawDeliveryFee: 80, finalDeliveryFee: 80,
  });
  check('remaining === 350', s.remaining === 350, `got ${s.remaining}`);
  check('progressPercent === 65', s.progressPercent === 65, `got ${s.progressPercent}`);
  check('reached === false', s.reached === false, JSON.stringify(s));
})();

// ── 5. 接近門檻 ──────────────────────────────────────
(function () {
  console.log('[5] 接近門檻 (930/1000)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 930, threshold: 1000, enabled: true, isDelivery: true,
  });
  check('remaining === 70', s.remaining === 70, `got ${s.remaining}`);
  check('nearThreshold === true', s.nearThreshold === true, JSON.stringify(s));
})();

// ── 6. 已達 full ─────────────────────────────────────
(function () {
  console.log('[6] 已達門檻 full (1080/1000, raw=80, final=0)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1080, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: true, rawDeliveryFee: 80, finalDeliveryFee: 0, mode: 'full',
  });
  check('reached === true', s.reached === true, JSON.stringify(s));
  check('savedAmount === 80', s.savedAmount === 80, `got ${s.savedAmount}`);
  check('progressPercent === 100', s.progressPercent === 100, `got ${s.progressPercent}`);
})();

// ── 7. 已達 distance_only（部分折抵） ─────────────────
(function () {
  console.log('[7] 已達門檻 distance_only (raw=120, final=70)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1080, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: false, rawDeliveryFee: 120, finalDeliveryFee: 70, mode: 'distance_only',
  });
  check('savedAmount === 50', s.savedAmount === 50, `got ${s.savedAmount}`);
  check('finalDeliveryFee === 70', s.finalDeliveryFee === 70, `got ${s.finalDeliveryFee}`);
  check('description mentions 仍需支付', /仍需支付/.test(s.description), s.description);
  check('headline 不含「免運」字樣（避免誤導）', !s.headline.includes('免運'), s.headline);
})();

// ── 8. 原始外送費為 0：不得出現「已折抵 NT$0」 ─────────
(function () {
  console.log('[8] 原始外送費為 0');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: false, rawDeliveryFee: 0, finalDeliveryFee: 0, mode: 'full',
  });
  check('reached === true', s.reached === true, JSON.stringify(s));
  check('savedAmount 為 null（不顯示已折抵）', s.savedAmount === null, `got ${s.savedAmount}`);
  check('不包含「已折抵 NT$0」', !/已折抵 NT\$0/.test(s.description), s.description);
})();

// ── 9. 商品金額為 0 ──────────────────────────────────
(function () {
  console.log('[9] 商品金額為 0');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 0, threshold: 1000, enabled: true, isDelivery: true,
  });
  check('remaining === threshold(1000)', s.remaining === 1000, `got ${s.remaining}`);
  check('progressPercent === 0', s.progressPercent === 0, `got ${s.progressPercent}`);
})();

// ── 10. 商品金額高於門檻：進度不得超過 100 ─────────────
(function () {
  console.log('[10] 商品金額遠高於門檻 (5000/1000)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 5000, threshold: 1000, enabled: true, isDelivery: true,
  });
  check('progressPercent === 100（不得超過）', s.progressPercent === 100, `got ${s.progressPercent}`);
  check('reached === true', s.reached === true, JSON.stringify(s));
})();

// ── 11. 超距離：優先顯示，不得回傳成功免運 headline ────
(function () {
  console.log('[11] 超距離 (isOutOfRange=true)，即使商品金額已達門檻');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1500, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: true, rawDeliveryFee: 80, finalDeliveryFee: 0, mode: 'full',
    isOutOfRange: true,
  });
  check('isOutOfRange === true', s.isOutOfRange === true, JSON.stringify(s));
  check('reached === false（不得顯示可送單狀態）', s.reached === false, JSON.stringify(s));
  check('headline 不含「已達免運」等成功文案', !/已達免運|已達滿額/.test(s.headline), s.headline);
  check('description 提及超出配送範圍', /超出配送範圍/.test(s.description), s.description);
})();

// ── 12. 費用防負數 ───────────────────────────────────
(function () {
  console.log('[12] 費用防負數 (rawFee=50, finalFee=-10)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: false, rawDeliveryFee: 50, finalDeliveryFee: -10, mode: 'distance_only',
  });
  check('finalDeliveryFee >= 0', s.finalDeliveryFee >= 0, `got ${s.finalDeliveryFee}`);
  check('savedAmount <= rawDeliveryFee(50)', s.savedAmount <= 50, `got ${s.savedAmount}`);
})();

// ── 13. 已達門檻但外送費尚未算出：不得提前宣告「已達免運資格」───
(function () {
  console.log('[13] 已達金額門檻但外送費尚未算出 (地址未確認)');
  const s = getDeliveryFreeProgressState({
    eligibleSubtotal: 1200, threshold: 1000, enabled: true, isDelivery: true,
    isFreeDelivery: null, rawDeliveryFee: null, finalDeliveryFee: null,
  });
  check('reached === true（金額已達門檻）', s.reached === true, JSON.stringify(s));
  check('headline 不含「已達免運資格」（費用尚未確認，不得提前宣告成功）', !s.headline.includes('已達免運資格'), s.headline);
  check('savedAmount 為 null（沒有實際折抵金額可顯示）', s.savedAmount === null, `got ${s.savedAmount}`);
})();

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) {
  console.error(`${fail} test(s) FAILED`);
  process.exit(1);
}
process.exit(0);
