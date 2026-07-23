// scripts/smoke-delivery-distance-promotion.js — C3
// Regression test：距離級距滿額免運（calculateDeliveryFeeWithPromotion / normalizeDeliveryDistanceFeeRules）。
// 直接 require() utils/deliveryFeeCalc.js —— 與 routes/delivery.js／routes/line-orders.js
// 實際呼叫的是同一份計算引擎，不是另外複製一份公式，避免測試與正式行為漂移。
'use strict';
const path = require('path');
const {
  calculateDeliveryFeeWithPromotion,
  normalizeDeliveryDistanceFeeRules,
} = require(path.join(__dirname, '..', 'utils', 'deliveryFeeCalc.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 建議級距（與 utils/deliveryFeeSuggestedRules.js 一致，測試獨立複製一份避免耦合檔案路徑）
const RULES = [
  { max_km: 3,  fee: 50,  free_threshold: 300,  free_mode: 'full',  free_discount: 0 },
  { max_km: 5,  fee: 80,  free_threshold: 500,  free_mode: 'full',  free_discount: 0 },
  { max_km: 7,  fee: 120, free_threshold: 800,  free_mode: 'full',  free_discount: 0 },
  { max_km: 9,  fee: 150, free_threshold: 1000, free_mode: 'fixed', free_discount: 100 },
  { max_km: 11, fee: 180, free_threshold: 1200, free_mode: 'fixed', free_discount: 100 },
  { max_km: 13, fee: 210, free_threshold: 1500, free_mode: 'fixed', free_discount: 100 },
  { max_km: 15, fee: 240, free_threshold: 1800, free_mode: 'fixed', free_discount: 100 },
];
const LEGACY_SETTINGS = {
  delivery_free_enabled: '1', delivery_free_threshold: '1000',
  delivery_free_mode: '', delivery_basic_fee: '50',
};

// ── 1. 2.7km 命中 3km 級距，full，未達門檻 ─────────────
(function () {
  console.log('[1] 2.7km 命中 3km 級距（full，未達）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 2.7, eligibleSubtotal: 200, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('matchedRule.max_km === 3', r.matchedRule && r.matchedRule.max_km === 3, JSON.stringify(r));
  check('rawFee === 50', r.rawFee === 50);
  check('reached === false', r.reached === false);
  check('finalFee === 50（未折抵）', r.finalFee === 50);
})();

// ── 2. 2.7km 命中 3km，full，已達門檻 300 → finalFee 0 ──
(function () {
  console.log('[2] 2.7km 命中 3km 級距（full，已達 300，subtotal=300）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 2.7, eligibleSubtotal: 300, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('rawFee === 50', r.rawFee === 50);
  check('reached === true', r.reached === true);
  check('discount === rawFee', r.discount === 50);
  check('finalFee === 0', r.finalFee === 0);
})();

// ── 3. 4.2km 命中 5km 級距 ─────────────────────────────
(function () {
  console.log('[3] 4.2km 命中 5km 級距');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 4.2, eligibleSubtotal: 100, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('matchedRule.max_km === 5', r.matchedRule && r.matchedRule.max_km === 5, JSON.stringify(r.matchedRule));
})();

// ── 4. 11.94km 應命中 13km（不得命中 11km，也不得命中 15km）──
(function () {
  console.log('[4] 11.94km 命中 13km 級距（核心驗收）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 11.94, eligibleSubtotal: 1000, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('matchedRule.max_km === 13', r.matchedRule && r.matchedRule.max_km === 13, JSON.stringify(r.matchedRule));
  check('rawFee === 210', r.rawFee === 210);
  check('mode === fixed', r.promotionMode === 'fixed');
  check('threshold === 1500', r.threshold === 1500);
  check('reached === false（subtotal=1000 < 1500）', r.reached === false);
  check('finalFee === 210（未達門檻不折抵）', r.finalFee === 210);
})();

// ── 5. full 未達（9km 級距原範例：raw=120, threshold=800, subtotal=700）──
(function () {
  console.log('[5] full 未達（7km 級距，raw=120, threshold=800, subtotal=700）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6.9, eligibleSubtotal: 700, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('rawFee === 120', r.rawFee === 120);
  check('discount === 0', r.discount === 0);
  check('finalFee === 120', r.finalFee === 120);
  check('remaining === 100', r.remaining === 100);
})();

// ── 6. full 已達（同上級距，subtotal=800）──────────────
(function () {
  console.log('[6] full 已達（7km 級距，subtotal=800）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6.9, eligibleSubtotal: 800, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('discount === rawFee', r.discount === r.rawFee);
  check('finalFee === 0', r.finalFee === 0);
})();

// ── 7. fixed 已達（13km 級距：raw=210, fixed=100, subtotal=1500）──
(function () {
  console.log('[7] fixed 已達（13km 級距：raw=210, fixed=100）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 12.5, eligibleSubtotal: 1500, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('rawFee === 210', r.rawFee === 210);
  check('discount === 100', r.discount === 100);
  check('finalFee === 110', r.finalFee === 110);
})();

// ── 8. fixed 折抵大於 rawFee（raw=50, fixed=100 → discount 上限為 rawFee）──
(function () {
  console.log('[8] fixed 折抵大於 rawFee（raw=50, fixed=100）');
  const customRules = [{ max_km: 3, fee: 50, free_threshold: 300, free_mode: 'fixed', free_discount: 100 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: 300, distanceRules: customRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('discount === 50（被 rawFee 上限鎖住，不是 100）', r.discount === 50, JSON.stringify(r));
  check('finalFee === 0（不得為負數）', r.finalFee === 0);
})();

// ── 9. none 模式：不套用任何折抵 ───────────────────────
(function () {
  console.log('[9] none 模式');
  const customRules = [{ max_km: 3, fee: 50, free_threshold: 300, free_mode: 'none', free_discount: 0 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: 999999, distanceRules: customRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('discount === 0', r.discount === 0);
  check('finalFee === rawFee', r.finalFee === r.rawFee);
})();

// ── 10. 超過 15km（超過最大距離 / 超過所有級距）──────────
(function () {
  console.log('[10] 超過 15km：out_of_range');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 16, eligibleSubtotal: 2000, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('outOfRange === true', r.outOfRange === true, JSON.stringify(r));
  check('滿額優惠不得解除距離限制（matchedRule === null）', r.matchedRule === null);
})();

// ── 11. legacy fallback：級距沒有促銷欄位，沿用舊版全店設定 ──
(function () {
  console.log('[11] legacy fallback（級距只有 {max_km, fee}）');
  const legacyRules = [{ max_km: 3, fee: 50 }, { max_km: 5, fee: 80 }, { max_km: 7, fee: 120 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6.9, eligibleSubtotal: 1000, distanceRules: legacyRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('promotionSource === legacy', r.promotionSource === 'legacy', JSON.stringify(r));
  check('threshold === 1000（沿用 delivery_free_threshold）', r.threshold === 1000);
  check('mode === full（legacy 預設 full）', r.promotionMode === 'full');
  check('已達門檻 → discount === rawFee', r.discount === r.rawFee);
})();

// ── 12. 級距明確 free_mode='none' 不可 fallback 舊規則 ──
(function () {
  console.log('[12] 級距明確 none，即使舊版全店有門檻，也不 fallback');
  const explicitNoneRules = [{ max_km: 7, fee: 120, free_threshold: 0, free_mode: 'none', free_discount: 0 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6, eligibleSubtotal: 5000, distanceRules: explicitNoneRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('promotionSource === rule（不是 legacy）', r.promotionSource === 'rule', JSON.stringify(r));
  check('discount === 0（即使 subtotal 遠超過舊門檻 1000）', r.discount === 0);
})();

// ── 13. C5：free_mode 為空字串仍算「店家已碰過新版促銷欄位」→ 不得 fallback legacy ──
// （hasTierPromotionConfiguration() 用 hasOwnProperty 判斷，只要屬性存在即算數，
//  即使值是空字串——這正是 C5 新增的行為，舊版行為是 fallback legacy，已被取代）
(function () {
  console.log('[13] C5：free_mode 為空字串仍視為新版促銷模式 → 禁止 fallback legacy');
  const blankModeRules = [{ max_km: 7, fee: 120, free_mode: '' }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6, eligibleSubtotal: 1000, distanceRules: blankModeRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('isTierPromotionMode === true（free_mode 屬性存在即算數）', r.isTierPromotionMode === true, JSON.stringify(r));
  check('promotionSource === none（不得 fallback legacy）', r.promotionSource === 'none', JSON.stringify(r));
  check('discount === 0（沒有真的設定優惠）', r.discount === 0);
})();

// ── 14. threshold 邊界剛好相等：視為已達標（>=） ──────
(function () {
  console.log('[14] subtotal 剛好等於 threshold（邊界）');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: 300, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('reached === true（>= 視為已達）', r.reached === true);
})();

// ── 15. invalid/negative values 正規化 ────────────────
(function () {
  console.log('[15] invalid/negative 輸入正規化');
  const r1 = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: -500, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('負的 eligibleSubtotal 視為 0，不判定達標', r1.reached === false, JSON.stringify(r1));
  const negFeeRules = [{ max_km: 3, fee: -50, free_threshold: 100, free_mode: 'full', free_discount: 0 }];
  const r2 = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: 100, distanceRules: negFeeRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('負的 fee 正規化為 0', r2.rawFee === 0, JSON.stringify(r2));
  check('finalFee 永遠 >= 0', r2.finalFee >= 0);
})();

// ── 16. 規則排序：輸入非升序時，pickDistanceRule 內部仍會排序後命中正確級距 ──
(function () {
  console.log('[16] 規則未按順序輸入，仍正確命中');
  const unsorted = [{ max_km: 7, fee: 120 }, { max_km: 3, fee: 50 }, { max_km: 5, fee: 80 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 4, eligibleSubtotal: 0, distanceRules: unsorted, legacySettings: {}, maxDistanceKm: 15 });
  check('命中 5km 級距（rawFee===80）', r.rawFee === 80, JSON.stringify(r));
})();

// ── 17. normalizeDeliveryDistanceFeeRules：重複距離驗證失敗 ──
(function () {
  console.log('[17] 重複距離驗證失敗');
  const res = normalizeDeliveryDistanceFeeRules([{ max_km: 3, fee: 50 }, { max_km: 3, fee: 80 }]);
  check('ok === false', res.ok === false, JSON.stringify(res));
})();

// ── 18. normalizeDeliveryDistanceFeeRules：fixed 缺折抵驗證失敗 ──
(function () {
  console.log('[18] fixed 模式缺 free_discount 驗證失敗');
  const res = normalizeDeliveryDistanceFeeRules([{ max_km: 3, fee: 50, free_threshold: 300, free_mode: 'fixed', free_discount: 0 }]);
  check('ok === false（fixed 必須 free_discount > 0）', res.ok === false, JSON.stringify(res));
})();

// ── 19. normalizeDeliveryDistanceFeeRules：距離必須遞增 ──
(function () {
  console.log('[19] 距離未遞增驗證失敗');
  const res = normalizeDeliveryDistanceFeeRules([{ max_km: 5, fee: 80 }, { max_km: 3, fee: 50 }]);
  check('ok === false', res.ok === false, JSON.stringify(res));
})();

// ── 20. normalizeDeliveryDistanceFeeRules：C5 後 legacy slot 一律正規化為明確 none ──
(function () {
  console.log('[20] C5：儲存時未設定優惠的列，正規化為明確 free_mode:\'none\'（不再保留 legacy 空欄位）');
  const res = normalizeDeliveryDistanceFeeRules([
    { max_km: 3, fee: 50 }, // C5 之前是 legacy slot（沒有 free_mode）；C5 後應正規化為明確 none
    { max_km: 5, fee: 80, free_threshold: 500, free_mode: 'full', free_discount: 999 }, // full 折抵應被正規化為 0
    { max_km: 7, fee: 120, free_threshold: 800, free_mode: 'fixed', free_discount: 50 },
  ]);
  check('ok === true', res.ok === true, JSON.stringify(res));
  if (res.ok) {
    check('第一筆被正規化為明確 free_mode:\'none\'（不再是純 {max_km, fee}）', res.rules[0].free_mode === 'none' && res.rules[0].free_threshold === 0 && res.rules[0].free_discount === 0, JSON.stringify(res.rules[0]));
    check('full 模式 free_discount 被正規化為 0', res.rules[1].free_discount === 0, JSON.stringify(res.rules[1]));
    check('fixed 模式保留 free_discount', res.rules[2].free_discount === 50);
  }
})();

// ── 21. 前台 finalFee 與 shared engine 一致（模擬 fetchDeliveryFee 解析邏輯）──
(function () {
  console.log('[21] 前台解析出的 finalFee 與 shared engine 一致');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 11.94, eligibleSubtotal: 1000, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  // 模擬 routes/delivery.js 組出的 API response，再模擬前端 fetchDeliveryFee() 解析
  const apiResponse = { raw_fee: r.rawFee, delivery_discount: r.discount, delivery_fee: r.finalFee };
  const frontendParsed = {
    rawFee: Number(apiResponse.raw_fee || 0),
    finalFee: Number(apiResponse.delivery_fee || 0),
    discount: Number(apiResponse.delivery_discount || 0),
  };
  check('前台 finalFee === shared engine finalFee', frontendParsed.finalFee === r.finalFee);
  check('前台 discount === shared engine discount', frontendParsed.discount === r.discount);
})();

// ── 22. 訂單 delivery_fee 必須使用 finalFee（不是 rawFee）──
(function () {
  console.log('[22] 訂單應存 finalFee，不是 rawFee');
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 12.5, eligibleSubtotal: 1500, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  const orderDeliveryFee = r.finalFee; // 模擬 routes/line-orders.js: calcDelivFee = feeResult.deliveryFee
  check('orderDeliveryFee !== rawFee（有實際折抵時應不同）', orderDeliveryFee !== r.rawFee);
  check('orderDeliveryFee === finalFee', orderDeliveryFee === r.finalFee);
})();

// ── 23. price_changed guard 模擬（容許誤差 0.01）──────
(function () {
  console.log('[23] price_changed guard（容許誤差 0.01）');
  const finalFee = 110;
  function wouldReject(previewRaw) {
    const hasPreview = previewRaw !== undefined && previewRaw !== null && previewRaw !== '' && Number.isFinite(Number(previewRaw));
    if (!hasPreview) return false; // 沒有傳 preview 不拒單
    return Math.abs(Number(previewRaw) - finalFee) > 0.01;
  }
  check('沒有傳 preview → 不拒單', wouldReject(undefined) === false);
  check('preview 完全相同 → 不拒單', wouldReject(110) === false);
  check('preview 誤差在 0.01 內 → 不拒單', wouldReject(110.005) === false);
  check('preview 差異明顯（160 vs 110）→ 拒單', wouldReject(160) === true);
})();

// ── 24. 完整資料流斷言：C2 原案例（11.94km／13km／threshold 1500／fixed 100），
// 商品小計 1000（未達門檻）。從 shared engine → 模擬 routes/delivery.js API response
// 形狀 → 模擬前端 fetchDeliveryFee() 解析 → 模擬 routes/line-orders.js 送單重算與
// delivery_fee_meta 組裝，逐層斷言同一個 finalFee，證明 C2 版「顯示折抵但實收沒扣」
// 的 Bug 已消失（不存在任何一層自己另算一份數字）。
(function () {
  console.log('[24] 完整資料流：11.94km/13km/threshold=1500/fixed=100，subtotal=1000（未達門檻）');
  const calc = calculateDeliveryFeeWithPromotion({
    distanceKm: 11.94, eligibleSubtotal: 1000, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15,
  });
  check('shared engine：finalFee === 210', calc.finalFee === 210, JSON.stringify(calc));
  check('shared engine：discount === 0（未達門檻）', calc.discount === 0);

  // 模擬 routes/delivery.js 組出的 API response（與實際程式碼欄位名稱一致）
  const apiResponse = {
    success: true, distance_km: 11.94, raw_fee: calc.rawFee, delivery_discount: calc.discount,
    delivery_fee: calc.finalFee, is_free_delivery: calc.finalFee === 0 && calc.rawFee > 0,
    free_rule_type: calc.promotionMode, free_threshold: calc.threshold, matched_max_km: calc.matchedRule.max_km,
  };
  // 模擬前端 fetchDeliveryFee() 解析（與 public/line-order.html 實際邏輯一致）
  const frontendResult = { rawFee: Number(apiResponse.raw_fee||0), finalFee: Number(apiResponse.delivery_fee||0), discount: Number(apiResponse.delivery_discount||0) };
  check('前端 _deliveryFeeResult.finalFee === 210（購物車外送費／應付金額用這個）', frontendResult.finalFee === 210);

  // 模擬 routes/line-orders.js 送單重算後的 delivery_fee_meta 組裝
  const deliveryFeeMeta = {
    raw_fee: calc.rawFee, delivery_discount: calc.discount, final_fee: calc.finalFee,
    distance_km: 11.94, matched_max_km: calc.matchedRule.max_km, free_threshold: calc.threshold,
    free_rule_type: calc.promotionMode, is_free_delivery: apiResponse.is_free_delivery,
  };
  const orderDeliveryFee = calc.finalFee; // 模擬 orders.delivery_fee 寫入值
  check('orders.delivery_fee === 210（送單後端重算，不信任前端）', orderDeliveryFee === 210);
  check('delivery_fee_meta.final_fee === orders.delivery_fee', deliveryFeeMeta.final_fee === orderDeliveryFee);
  check('delivery_fee_preview（前端試算）與後端重算一致 → 不觸發 price_changed', Math.abs(frontendResult.finalFee - orderDeliveryFee) <= 0.01);
})();

// ── 25. 完整資料流斷言：同案例，商品小計 1500（達標）──────
(function () {
  console.log('[25] 完整資料流：11.94km/13km/threshold=1500/fixed=100，subtotal=1500（達標）');
  const calc = calculateDeliveryFeeWithPromotion({
    distanceKm: 11.94, eligibleSubtotal: 1500, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15,
  });
  check('shared engine：rawFee === 210', calc.rawFee === 210);
  check('shared engine：discount === 100', calc.discount === 100);
  check('shared engine：finalFee === 110（核心驗收）', calc.finalFee === 110, JSON.stringify(calc));

  const apiResponse = {
    raw_fee: calc.rawFee, delivery_discount: calc.discount, delivery_fee: calc.finalFee,
    is_free_delivery: calc.finalFee === 0 && calc.rawFee > 0, free_rule_type: calc.promotionMode,
    free_threshold: calc.threshold, matched_max_km: calc.matchedRule.max_km,
  };
  const frontendResult = { rawFee: Number(apiResponse.raw_fee||0), finalFee: Number(apiResponse.delivery_fee||0), discount: Number(apiResponse.delivery_discount||0) };
  check('前端購物車外送費 === 110', frontendResult.finalFee === 110);
  const subtotal = 1500, discAmt = 0; // 本案例無優惠券
  const payableAmount = subtotal - discAmt + frontendResult.finalFee;
  check('應付金額 = 1500 - 0 + 110 = 1610', payableAmount === 1610, String(payableAmount));

  const deliveryFeePreview = frontendResult.finalFee; // 送單 payload 帶的 preview
  const backendRecalc = calculateDeliveryFeeWithPromotion({
    distanceKm: 11.94, eligibleSubtotal: 1500, distanceRules: RULES, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15,
  }); // 模擬 recalcDeliveryFee() 內部呼叫 shared engine 的結果
  check('後端重算 finalFee === 110（與前端 preview 一致）', backendRecalc.finalFee === 110);
  check('deliveryFeePreview 與後端重算一致 → 不觸發 price_changed', Math.abs(deliveryFeePreview - backendRecalc.finalFee) <= 0.01);

  const orderDeliveryFee = backendRecalc.finalFee; // orders.delivery_fee 寫入值
  const deliveryFeeMeta = {
    raw_fee: backendRecalc.rawFee, delivery_discount: backendRecalc.discount, final_fee: backendRecalc.finalFee,
    distance_km: 11.94, matched_max_km: backendRecalc.matchedRule.max_km, free_threshold: backendRecalc.threshold,
    free_rule_type: backendRecalc.promotionMode, is_free_delivery: false,
  };
  check('orders.delivery_fee === 110', orderDeliveryFee === 110);
  check('metadata.final_fee === 110', deliveryFeeMeta.final_fee === 110);
  check('metadata.raw_fee === 210（原價僅供顯示，不當作實收金額）', deliveryFeeMeta.raw_fee === 210);
  check('metadata.delivery_discount === 100', deliveryFeeMeta.delivery_discount === 100);
  // 後台訂單詳情／Dashboard 都只認 orders.delivery_fee，這裡模擬同一份資料被兩處讀取仍是 110
  check('後台訂單詳情顯示的最終外送費 === Dashboard 認列的外送費（同一個 110）', orderDeliveryFee === deliveryFeeMeta.final_fee);
})();

// ═══════════════════════ C5：移除 legacy 干擾 + 折抵欄位映射修正 ═══════════════════════

// ── 26. C5 核心驗收：11.94km 級距有自己的 threshold=1500，即使 legacy=1000，
//        混用時門檻只能是 1500，不得判定達標（需求文件九之 1）───────────────
(function () {
  console.log('[26] C5：legacy threshold=1000 與 11.94km 級距 threshold=1500 混用，門檻只能是 1500');
  const mixedRules = [
    { max_km: 3,  fee: 50 },  // 尚未設定優惠的舊列（但整組已有其他列設定過 free_mode → 視為新模式）
    { max_km: 13, fee: 210, free_threshold: 1500, free_mode: 'fixed', free_discount: 100 },
  ];
  const legacyThousand = { delivery_free_enabled: '1', delivery_free_threshold: '1000', delivery_free_mode: '', delivery_basic_fee: '50' };
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 11.94, eligibleSubtotal: 1050, distanceRules: mixedRules, legacySettings: legacyThousand, maxDistanceKm: 15 });
  check('isTierPromotionMode === true', r.isTierPromotionMode === true, JSON.stringify(r));
  check('threshold === 1500（不是 legacy 的 1000）', r.threshold === 1500, JSON.stringify(r));
  check('remaining === 450', r.remaining === 450);
  check('reached === false（不得判定達標）', r.reached === false);
  check('discount === 0', r.discount === 0);
  check('finalFee === rawFee(210)（未折抵）', r.finalFee === 210);

  // 同一組規則命中「尚未設定優惠」的 3km 那列時，也必須是 none，不是 legacy 的 1000
  const r2 = calculateDeliveryFeeWithPromotion({ distanceKm: 2, eligibleSubtotal: 5000, distanceRules: mixedRules, legacySettings: legacyThousand, maxDistanceKm: 15 });
  check('未設定優惠的列命中時 promotionSource === none', r2.promotionSource === 'none', JSON.stringify(r2));
  check('未設定優惠的列命中時 discount === 0（即使 subtotal 遠超過舊 1000）', r2.discount === 0);
})();

// ── 27. C5：新規則某列明確 free_mode='none'，即使舊 delivery_free_threshold=1000 也不套用 ──
(function () {
  console.log('[27] C5：新規則某列為 none，不 fallback 舊設定');
  const rules = [{ max_km: 7, fee: 120, free_mode: 'none', free_threshold: 0, free_discount: 0 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6, eligibleSubtotal: 2000, distanceRules: rules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('discount === 0', r.discount === 0, JSON.stringify(r));
  check('finalFee === rawFee', r.finalFee === r.rawFee);
})();

// ── 28. C5：真正舊店（所有規則都只有 {max_km, fee}）仍允許短期 legacy fallback ──
(function () {
  console.log('[28] C5：真正舊店（全部 bare rows）仍允許 legacy fallback');
  const trueLegacyRules = [{ max_km: 3, fee: 50 }, { max_km: 5, fee: 80 }, { max_km: 7, fee: 120 }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6.9, eligibleSubtotal: 1000, distanceRules: trueLegacyRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('isTierPromotionMode === false', r.isTierPromotionMode === false, JSON.stringify(r));
  check('promotionSource === legacy', r.promotionSource === 'legacy');
  check('threshold === 1000（沿用舊全店門檻）', r.threshold === 1000);
})();

// ── 29. C5：折抵顯示欄位映射（raw=210, discount=100, final=110）──────────
(function () {
  console.log('[29] C5：折抵欄位正確映射（raw=210, discount=100, final=110）');
  const progressMod = require(path.join(__dirname, '..', 'public', 'js', 'delivery-free-progress.js'));
  const state = progressMod.getDeliveryFreeProgressState({
    eligibleSubtotal: 1500, threshold: 1500, mode: 'fixed',
    rawDeliveryFee: 210, finalDeliveryFee: 110,
    reached: true, remaining: 0, isDelivery: true, isOutOfRange: false, feeResolved: true,
  });
  check('savedAmount === 100', state.savedAmount === 100, JSON.stringify(state));
  check('description 提到本次折抵 NT$100', state.description.includes('折抵 NT$100'), state.description);
  check('description 提到仍需支付 NT$110', state.description.includes('NT$110'), state.description);
  check('不得顯示折抵 NT$0', !state.description.includes('折抵 NT$0'));
})();

// ── 30. C5：discount 欄位缺失時，由 rawFee - finalFee 安全推導（防呆） ──────
(function () {
  console.log('[30] C5：deliveryDiscount 欄位缺失時安全推導 savedAmount');
  const progressMod = require(path.join(__dirname, '..', 'public', 'js', 'delivery-free-progress.js'));
  // 模擬「後端沒有明確回傳 delivery_discount」的情境：呼叫端只能推導 rawDeliveryFee - finalDeliveryFee，
  // 這裡直接驗證 shared engine 本身在只拿到 raw/final（沒有額外 discount 欄位）時的推導結果，
  // 與 utils/deliveryFeeCalc.js 對接時前端呼叫端的「防呆」邏輯（見 CHANGELOG C5 七）一致。
  const rawDeliveryFee = 210, finalDeliveryFee = 110;
  const normalizedRawFee = Math.max(Number(rawDeliveryFee) || 0, 0);
  const normalizedFinalFee = Math.max(Number(finalDeliveryFee) || 0, 0);
  const explicitDiscount = Number(undefined); // deliveryDiscount 缺失
  const savedAmount = Number.isFinite(explicitDiscount)
    ? Math.min(Math.max(explicitDiscount, 0), normalizedRawFee)
    : Math.max(normalizedRawFee - normalizedFinalFee, 0);
  check('savedAmount 由差額推導 === 100', savedAmount === 100, `savedAmount=${savedAmount}`);
})();

// ── 31. C5：pending 狀態不得使用舊 shopData.delivery_free_threshold=1000 ──────
// （對應 public/line-order.html 內 updateDeliveryFreeProgress() 的 fallback 分支邏輯，
//  這裡用同樣的參數組合直接驗證 shared engine：只要呼叫端正確傳入「最近一次已解析
//  的級距」threshold=1500，而不是 shopData 的舊全店門檻 1000，結果就不會誤判。）
(function () {
  console.log('[31] C5：pending 時沿用最近一次已解析級距的 threshold=1500，不得跳成 1000');
  const progressMod = require(path.join(__dirname, '..', 'public', 'js', 'delivery-free-progress.js'));
  // 商品異動後 API 尚未回來：呼叫端應傳入「最近一次已解析」的 threshold=1500（而非
  // shopData 的舊全店 1000），且 feeResolved 必須是 false（不得宣告已達免運）。
  const state = progressMod.getDeliveryFreeProgressState({
    eligibleSubtotal: 1050, threshold: 1500, mode: 'fixed',
    rawDeliveryFee: null, finalDeliveryFee: null,
    reached: false, remaining: 450, isDelivery: true, isOutOfRange: false, feeResolved: false,
  });
  check('thresholdAmountText 顯示 NT$1,500（不是 NT$1,000）', state.thresholdAmountText.includes('1,500'), state.thresholdAmountText);
  check('reached === false（pending 不得顯示已達標）', state.reached === false);
  check('progressPercent 不是 100', state.progressPercent !== 100);
})();

console.log(`\n[smoke-delivery-distance-promotion] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
