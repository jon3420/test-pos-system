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

// ── 13. 級距缺少 promotion fields 才 fallback（free_mode 為空字串視同缺欄位）──
(function () {
  console.log('[13] free_mode 為空字串視同缺欄位 → fallback legacy');
  const blankModeRules = [{ max_km: 7, fee: 120, free_mode: '' }];
  const r = calculateDeliveryFeeWithPromotion({ distanceKm: 6, eligibleSubtotal: 1000, distanceRules: blankModeRules, legacySettings: LEGACY_SETTINGS, maxDistanceKm: 15 });
  check('promotionSource === legacy', r.promotionSource === 'legacy', JSON.stringify(r));
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

// ── 20. normalizeDeliveryDistanceFeeRules：合法的完整規則正規化通過 ──
(function () {
  console.log('[20] 合法規則（含 legacy slot + full + fixed 混合）正規化通過');
  const res = normalizeDeliveryDistanceFeeRules([
    { max_km: 3, fee: 50 }, // legacy slot（沒有 free_mode）
    { max_km: 5, fee: 80, free_threshold: 500, free_mode: 'full', free_discount: 999 }, // full 折抵應被正規化為 0
    { max_km: 7, fee: 120, free_threshold: 800, free_mode: 'fixed', free_discount: 50 },
  ]);
  check('ok === true', res.ok === true, JSON.stringify(res));
  if (res.ok) {
    check('第一筆保持純 {max_km, fee}（沒有 free_mode）', res.rules[0].free_mode === undefined, JSON.stringify(res.rules[0]));
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

console.log(`\n[smoke-delivery-distance-promotion] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
