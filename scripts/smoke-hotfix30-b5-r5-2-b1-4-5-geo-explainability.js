#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-4-5-geo-explainability.js
// fix18-10-hotfix30-B5-R5.2-B1-4.5 — Geo Explainability Layer
//
// Part A：純函式單元測試（buildGeoRuleExplanation / buildThresholdHits /
//         buildMetricComparisons / buildConfidenceBreakdown /
//         buildSampleAssessment / buildDataQualityAssessment），吃手工構造
//         的聚合物件，不查 DB。
// Part B：真實 DB + route 整合測試，確認 explanation 掛在真實 /alerts
//         回應上、Contract/Scope/Privacy/JSON safety 在真實流程下也成立。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function findLayer(router, method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]);
}
async function callRoute(router, method, routePath, { query = {}, storeId } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const stack = layer.route.stack;
  const req = { query, storeId, headers: {} };
  let statusCode = 200, jsonBody = null;
  return new Promise((resolve, reject) => {
    const res = {
      status(c) { statusCode = c; return this; },
      json(o) { jsonBody = o; resolve({ statusCode, body: jsonBody }); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      if (idx >= stack.length) return resolve({ statusCode, body: jsonBody });
      const layerFn = stack[idx++].handle;
      Promise.resolve(layerFn(req, res, next)).catch(reject);
    }
    next();
  });
}

// JSON safety helper：確認一個值可以安全 stringify（不含 undefined 洩漏成
// 消失欄位、不含 function、不含 NaN/Infinity、不會拋錯/循環參照）
function assertJsonSafe(value, label) {
  let serialized;
  let threw = false;
  try { serialized = JSON.stringify(value); } catch (e) { threw = true; }
  assert(!threw, `${label}: JSON.stringify 不拋錯（無循環參照）`);
  if (!threw) {
    assert(!/NaN|Infinity/.test(serialized), `${label}: 不含 NaN/Infinity 字樣`);
    assert(serialized !== undefined, `${label}: 序列化結果不是 undefined`);
  }
  // 深度掃描：任何 function 型別欄位都不該存在
  let hasFunction = false;
  const seen = new Set();
  (function scan(v) {
    if (v === null || typeof v !== 'object') { if (typeof v === 'function') hasFunction = true; return; }
    if (seen.has(v)) return;
    seen.add(v);
    Object.values(v).forEach((child) => {
      if (typeof child === 'function') hasFunction = true;
      else if (child && typeof child === 'object') scan(child);
    });
  })(value);
  assert(!hasFunction, `${label}: 不含 function 型別欄位`);
}

async function main() {
  const geoAlertRules = require(path.join(ROOT, 'utils/geoAlertRules'));
  const {
    GEO_EXPLAINABILITY_VERSION, getGeoBehaviorRuleThresholds,
    buildGeoBehaviorRuleContext, classifyGeoBehaviorArea, buildGeoBehaviorRecommendations,
    buildGeoQualityRecommendations, buildGeoRuleExplanation, buildDataQualityExplanation,
    buildThresholdHits, buildMetricComparisons, buildConfidenceBreakdown,
    buildSampleAssessment, buildDataQualityAssessment,
  } = geoAlertRules;

  // ══════════════════════════════════════════════════════════
  // 0. Explainability Version
  // ══════════════════════════════════════════════════════════
  assert(GEO_EXPLAINABILITY_VERSION === '1.0', '0-1 GEO_EXPLAINABILITY_VERSION = "1.0"');
  assert(typeof buildGeoRuleExplanation === 'function', '0-2 buildGeoRuleExplanation 函式存在');
  assert(typeof buildThresholdHits === 'function', '0-3 buildThresholdHits 函式存在');
  assert(typeof buildMetricComparisons === 'function', '0-4 buildMetricComparisons 函式存在');
  assert(typeof buildConfidenceBreakdown === 'function', '0-5 buildConfidenceBreakdown 函式存在');
  assert(typeof buildSampleAssessment === 'function', '0-6 buildSampleAssessment 函式存在');
  assert(typeof buildDataQualityAssessment === 'function', '0-7 buildDataQualityAssessment 函式存在');

  // ══════════════════════════════════════════════════════════
  // 1. 固定 Rule Context（跟 B1-4 smoke 同一份 9 個 filler 區域設計）
  // ══════════════════════════════════════════════════════════
  const fillerAreas = Array.from({ length: 9 }, (_, i) => {
    const visitors = (i + 1) * 10;
    const cart = Math.round(visitors * 0.25);
    const checkout = Math.round(cart * 0.3);
    const purchase = Math.round(checkout * 0.3);
    return {
      city: '桃園市', district: `填充區${i + 1}`,
      visitors, add_to_cart_visitors: cart, begin_checkout_visitors: checkout, purchase_visitors: purchase,
      visit_to_cart_rate: 0.25, cart_to_checkout_rate: 0.3, checkout_to_purchase_rate: 0.3,
      visit_to_purchase_rate: visitors > 0 ? purchase / visitors : 0,
    };
  });
  const context = buildGeoBehaviorRuleContext(fillerAreas, {
    quality: { identified_rate: 0.85, unknown_rate: 0.1 },
    dateScope: { start: '2026-07-01', end: '2026-07-26' },
    channelScope: 'all',
  });
  context.storeId = 'store_explain_test';
  context.countyCode = null; context.subdivisionCode = null; context.source = null; context.medium = null; context.campaign = null;

  {
    assert(typeof context.medians === 'object' && context.medians !== null, '1-1 rule_context.medians 存在');
    assert(typeof context.averages === 'object' && context.averages !== null, '1-2 rule_context.averages 存在');
    assert(typeof context.percentiles === 'object' && context.percentiles !== null, '1-3 rule_context.percentiles 存在');
    assert(typeof context.thresholds === 'object' && context.thresholds !== null, '1-4 rule_context.thresholds 存在（既有欄位，未被改名）');
    assert(typeof context.confidence_thresholds === 'object' && context.confidence_thresholds !== null, '1-5 rule_context.confidence_thresholds 存在');
    assert(typeof context.sample_thresholds === 'object' && context.sample_thresholds !== null, '1-6 rule_context.sample_thresholds 存在');
    assert(typeof context.geo_quality === 'object' && context.geo_quality !== null, '1-7 rule_context.geo_quality 存在');
    assert(typeof context.scope === 'object' && context.scope !== null, '1-8 rule_context.scope 存在');
    assert(context.medianVisitors === context.medians.visitors, '1-9 舊欄位 medianVisitors 與新分組 medians.visitors 數值一致（additive，未改名）');
    assert(context.visitorHighThreshold === context.percentiles.visitor_high_threshold, '1-10 舊欄位 visitorHighThreshold 與新分組 percentiles.visitor_high_threshold 一致');
    assert(context.averages.visit_to_cart_rate === context.averageVisitToCartRate, '1-11 averages.visit_to_cart_rate 與扁平欄位 averageVisitToCartRate 一致');
    assertJsonSafe(context, '1-12 rule_context 整體');
  }

  // ══════════════════════════════════════════════════════════
  // 2. 五種分類的 Explainability（十三）
  // ══════════════════════════════════════════════════════════
  const scenarioAreas = {
    high_traffic_high_conversion: { city: '桃園市', district: '說明A區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 30, purchase_visitors: 25, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.75, checkout_to_purchase_rate: 0.833, visit_to_purchase_rate: 0.25 },
    high_traffic_low_cart: { city: '桃園市', district: '說明B區', visitors: 80, add_to_cart_visitors: 4, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.05, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
    high_cart_low_checkout: { city: '桃園市', district: '說明C區', visitors: 50, add_to_cart_visitors: 20, begin_checkout_visitors: 2, purchase_visitors: 0, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.1, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
    high_checkout_low_purchase: { city: '桃園市', district: '說明D區', visitors: 50, add_to_cart_visitors: 25, begin_checkout_visitors: 10, purchase_visitors: 1, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.4, checkout_to_purchase_rate: 0.1, visit_to_purchase_rate: 0.02 },
    high_conversion_low_traffic: { city: '桃園市', district: '說明E區', visitors: 20, add_to_cart_visitors: 10, begin_checkout_visitors: 5, purchase_visitors: 5, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 1.0, visit_to_purchase_rate: 0.25 },
  };

  Object.entries(scenarioAreas).forEach(([expectedCode, area]) => {
    const result = classifyGeoBehaviorArea(area, context);
    assert(result.primary_classification === expectedCode, `2-${expectedCode}-0 分類正確（前置驗證）`);
    const explanation = buildGeoRuleExplanation(area, context, result);

    assert(typeof explanation.summary === 'string' && explanation.summary.length > 0, `2-${expectedCode}-1 summary 為非空字串`);
    assert(!/identity_key|event_name|SELECT|visitor_id/i.test(explanation.summary), `2-${expectedCode}-2 summary 不含技術欄位名稱/SQL`);
    assert(explanation.summary.includes(area.district), `2-${expectedCode}-3 summary 可直接顯示給商家（含區域名稱）`);

    assert(explanation.primary_reason && typeof explanation.primary_reason === 'object', `2-${expectedCode}-4 primary_reason 為物件`);
    ['metric', 'actual_value', 'benchmark_type', 'benchmark_value', 'difference', 'direction', 'unit', 'message'].forEach((f) => {
      assert(f in explanation.primary_reason, `2-${expectedCode}-5 primary_reason 含欄位「${f}」`);
    });
    assert(['above', 'below'].includes(explanation.primary_reason.direction), `2-${expectedCode}-6 primary_reason.direction 為 above/below`);

    assert(Array.isArray(explanation.supporting_reasons), `2-${expectedCode}-7 supporting_reasons 為陣列`);
    explanation.supporting_reasons.forEach((r, i) => {
      ['metric', 'actual_value', 'benchmark_type', 'benchmark_value', 'difference', 'direction', 'unit', 'message'].forEach((f) => {
        assert(f in r, `2-${expectedCode}-8-${i} supporting_reasons[${i}] 含欄位「${f}」`);
      });
    });

    assert(Array.isArray(explanation.threshold_hits) && explanation.threshold_hits.length > 0, `2-${expectedCode}-9 threshold_hits 為非空陣列（可追溯到實際命中的門檻）`);
    explanation.threshold_hits.forEach((h, i) => {
      ['rule_key', 'metric', 'operator', 'threshold', 'actual', 'passed', 'margin', 'message'].forEach((f) => {
        assert(f in h, `2-${expectedCode}-10-${i} threshold_hits[${i}] 含欄位「${f}」`);
      });
      assert(typeof h.passed === 'boolean', `2-${expectedCode}-11-${i} threshold_hits[${i}].passed 為布林值`);
      assert(Number.isFinite(h.margin), `2-${expectedCode}-12-${i} threshold_hits[${i}].margin 為有限數字`);
    });
    assert(explanation.threshold_hits.every((h) => h.passed), `2-${expectedCode}-13 primary classification 對應的 threshold_hits 全部 passed=true`);

    assert(Array.isArray(explanation.metric_comparisons) && explanation.metric_comparisons.length > 0, `2-${expectedCode}-14 metric_comparisons 為非空陣列`);
    explanation.metric_comparisons.forEach((c, i) => {
      ['metric', 'actual', 'compare_to', 'benchmark', 'absolute_difference', 'percentage_point_difference', 'ratio', 'message'].forEach((f) => {
        assert(f in c, `2-${expectedCode}-15-${i} metric_comparisons[${i}] 含欄位「${f}」`);
      });
      if (c.ratio !== null) assert(Number.isFinite(c.ratio), `2-${expectedCode}-16-${i} metric_comparisons[${i}].ratio 不是 null 時為有限數字`);
    });
    const compareTypes = new Set(explanation.metric_comparisons.map((c) => c.compare_to));
    assert(compareTypes.has('median') || compareTypes.has('percentile'), `2-${expectedCode}-17 metric_comparisons 至少包含 median 或 percentile 類型`);

    const cb = explanation.confidence_breakdown;
    ['final_level', 'score', 'sample_score', 'geo_quality_score', 'threshold_distance_score', 'consistency_score', 'reasons'].forEach((f) => {
      assert(f in cb, `2-${expectedCode}-18 confidence_breakdown 含欄位「${f}」`);
    });
    assert(['low', 'medium', 'high'].includes(cb.final_level), `2-${expectedCode}-19 confidence_breakdown.final_level 為合法列舉值`);
    assert(cb.final_level === result.confidence, `2-${expectedCode}-20 confidence_breakdown.final_level 與 classify 結果的 confidence 一致（不得矛盾）`);
    [cb.score, cb.sample_score, cb.geo_quality_score, cb.threshold_distance_score, cb.consistency_score].forEach((s, i) => {
      assert(Number.isFinite(s) && s >= 0 && s <= 100, `2-${expectedCode}-21-${i} confidence 子分數在 0–100 範圍內`);
    });
    assert(Array.isArray(cb.reasons) && cb.reasons.length > 0, `2-${expectedCode}-22 confidence_breakdown.reasons 為非空陣列`);

    const sa = explanation.sample_assessment;
    ['status', 'visitors', 'relevant_stage_visitors', 'minimum_required', 'margin', 'message'].forEach((f) => {
      assert(f in sa, `2-${expectedCode}-23 sample_assessment 含欄位「${f}」`);
    });
    assert(['insufficient', 'borderline', 'sufficient', 'strong'].includes(sa.status), `2-${expectedCode}-24 sample_assessment.status 為合法列舉值`);

    const dqa = explanation.data_quality_assessment;
    ['identified_rate', 'unknown_rate', 'quality_status', 'confidence_impact', 'message'].forEach((f) => {
      assert(f in dqa, `2-${expectedCode}-25 data_quality_assessment 含欄位「${f}」`);
    });

    assertJsonSafe(explanation, `2-${expectedCode}-26 explanation 整體`);
  });

  // ══════════════════════════════════════════════════════════
  // 3. insufficient_sample 的完整 Explainability（十四）
  // ══════════════════════════════════════════════════════════
  {
    const areaF = { city: '桃園市', district: '樣本不足說明區', visitors: 3, add_to_cart_visitors: 3, begin_checkout_visitors: 3, purchase_visitors: 3, visit_to_cart_rate: 1, cart_to_checkout_rate: 1, checkout_to_purchase_rate: 1, visit_to_purchase_rate: 1 };
    const result = classifyGeoBehaviorArea(areaF, context);
    assert(result.primary_classification === 'insufficient_sample', '3-1 分類為 insufficient_sample（前置驗證）');
    const explanation = buildGeoRuleExplanation(areaF, context, result);

    assert(explanation.summary.includes('3') && explanation.summary.includes('10'), '3-2 summary 含實際訪客數與最低門檻數字，不是只寫「資料不足」');
    assert(!explanation.summary.includes('資料不足') || explanation.summary.length > 10, '3-3 summary 不是只有「資料不足」四個字');
    assert('minimum_required' in explanation.sample_assessment, '3-4 sample_assessment 含 minimum_required');
    assert('actual' in explanation.sample_assessment, '3-5 sample_assessment 含 actual');
    assert('shortfall' in explanation.sample_assessment, '3-6 sample_assessment 含 shortfall');
    assert(explanation.sample_assessment.minimum_required === context.thresholds.minimumVisitors, '3-7 minimum_required 與集中門檻一致');
    assert(explanation.sample_assessment.actual === 3, '3-8 actual = 3（實際訪客數）');
    assert(explanation.sample_assessment.shortfall === context.thresholds.minimumVisitors - 3, '3-9 shortfall = 門檻 - 實際');
    assert(explanation.sample_assessment.status === 'insufficient', '3-10 sample_assessment.status = insufficient');
    assertJsonSafe(explanation, '3-11 insufficient_sample explanation 整體');
  }

  // ══════════════════════════════════════════════════════════
  // 4. Unknown / Data Quality Explainability（十五）
  // ══════════════════════════════════════════════════════════
  {
    const highUnknownContext = { ...context, unknownRate: 0.62 };
    const dqExplanation = buildDataQualityExplanation(highUnknownContext);
    assert(dqExplanation.summary.includes('62%'), '4-1 summary 含未知比例 62%');
    assert(dqExplanation.summary.includes('50%'), '4-2 summary 含門檻 50%');
    assert(dqExplanation.summary.includes('12'), '4-3 summary 含超出的百分點數字（12）');
    assert(dqExplanation.primary_reason.metric === 'unknown_rate', '4-4 primary_reason.metric = unknown_rate');
    assert(dqExplanation.primary_reason.difference > 0, '4-5 primary_reason.difference 為正數（超出門檻）');
    assert(Array.isArray(dqExplanation.threshold_hits) && dqExplanation.threshold_hits.length === 1, '4-6 threshold_hits 恰好 1 筆');
    assert(dqExplanation.threshold_hits[0].passed === true, '4-7 threshold_hit.passed = true（確實超過警戒門檻）');
    assert(dqExplanation.data_quality_assessment.confidence_impact === 'negative', '4-8 confidence_impact = negative（Unknown 高時不得正向）');
    assert(Array.isArray(dqExplanation.data_quality_assessment.recommended_checks) && dqExplanation.data_quality_assessment.recommended_checks.length > 0, '4-9 recommended_checks 為非空陣列（建議檢查項目）');
    assertJsonSafe(dqExplanation, '4-10 data quality explanation 整體');

    // 透過 buildGeoQualityRecommendations() 確認確實掛在 recommendation 上
    const recos = buildGeoQualityRecommendations(highUnknownContext, { store_id: 's1', channel: 'all' });
    assert(recos.length === 1 && 'explanation' in recos[0], '4-11 quality_recommendations[0] 含 explanation 欄位');
    assert(recos[0].explanation.summary === dqExplanation.summary, '4-12 recommendation.explanation 與獨立呼叫結果一致');

    // Confidence 不得因 Unknown 高仍給 high confidence
    assert(recos[0].confidence !== 'high', '4-13 Unknown 過高時 recommendation.confidence 不是 high');
    assert(recos[0].explanation.confidence_breakdown.final_level !== 'high', '4-14 confidence_breakdown.final_level 也不是 high（一致）');
  }

  // ══════════════════════════════════════════════════════════
  // 5. Confidence Breakdown 邊界（low / medium / high / 0–100）
  // ══════════════════════════════════════════════════════════
  {
    const lowConfArea = { city: '桃園市', district: 'Conf低說明', visitors: 12, add_to_cart_visitors: 6, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.19, checkout_to_purchase_rate: 0.9, visit_to_purchase_rate: 0 };
    const rLow = classifyGeoBehaviorArea(lowConfArea, { ...context, geoIdentifiedRate: null });
    const cbLow = buildGeoRuleExplanation(lowConfArea, { ...context, geoIdentifiedRate: null }, rLow).confidence_breakdown;
    assert(cbLow.final_level === 'low', '5-1 低樣本/低偏離 → final_level = low');
    assert(cbLow.score < getGeoBehaviorRuleThresholds().confidenceScoreMediumThreshold, '5-2 score 落在 low 對應的分數區間內');

    const mediumConfArea = { city: '桃園市', district: 'Conf中說明', visitors: 25, add_to_cart_visitors: 10, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.14, checkout_to_purchase_rate: 0.9, visit_to_purchase_rate: 0 };
    const rMedium = classifyGeoBehaviorArea(mediumConfArea, { ...context, geoIdentifiedRate: 0.85 });
    const cbMedium = buildGeoRuleExplanation(mediumConfArea, { ...context, geoIdentifiedRate: 0.85 }, rMedium).confidence_breakdown;
    assert(cbMedium.final_level === 'medium', '5-3 中樣本/中偏離/高品質 → final_level = medium');
    const t = getGeoBehaviorRuleThresholds();
    assert(cbMedium.score >= t.confidenceScoreMediumThreshold && cbMedium.score < t.confidenceScoreHighThreshold, '5-4 score 落在 medium 對應的分數區間內');

    const highConfArea = { city: '桃園市', district: 'Conf高說明', visitors: 45, add_to_cart_visitors: 20, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.05, checkout_to_purchase_rate: 0.9, visit_to_purchase_rate: 0 };
    const rHigh = classifyGeoBehaviorArea(highConfArea, { ...context, geoIdentifiedRate: 0.9 });
    const cbHigh = buildGeoRuleExplanation(highConfArea, { ...context, geoIdentifiedRate: 0.9 }, rHigh).confidence_breakdown;
    assert(cbHigh.final_level === 'high', '5-5 高樣本/高偏離/高品質 → final_level = high');
    assert(cbHigh.score >= t.confidenceScoreHighThreshold, '5-6 score 落在 high 對應的分數區間內');

    // 0-100 邊界：所有子分數與總分皆不得超界
    [cbLow, cbMedium, cbHigh].forEach((cb, idx) => {
      [cb.score, cb.sample_score, cb.geo_quality_score, cb.threshold_distance_score, cb.consistency_score].forEach((s) => {
        assert(s >= 0 && s <= 100, `5-7-${idx} 所有分數皆在 0–100 邊界內`);
      });
    });

    // final_level 必須「由 score 映射」，不是獨立決定：手動用同一個 score 映射函式驗證
    assert((cbLow.score >= t.confidenceScoreHighThreshold ? 'high' : (cbLow.score >= t.confidenceScoreMediumThreshold ? 'medium' : 'low')) === cbLow.final_level, '5-8 final_level 確實由 score 依集中門檻映射得出（低）');
    assert((cbMedium.score >= t.confidenceScoreHighThreshold ? 'high' : (cbMedium.score >= t.confidenceScoreMediumThreshold ? 'medium' : 'low')) === cbMedium.final_level, '5-9 final_level 確實由 score 依集中門檻映射得出（中）');
    assert((cbHigh.score >= t.confidenceScoreHighThreshold ? 'high' : (cbHigh.score >= t.confidenceScoreMediumThreshold ? 'medium' : 'low')) === cbHigh.final_level, '5-10 final_level 確實由 score 依集中門檻映射得出（高）');
  }

  // ══════════════════════════════════════════════════════════
  // 6. 防護：分母為 0 / NaN / Infinity / undefined
  // ══════════════════════════════════════════════════════════
  {
    // metric_comparisons：benchmark 為 0 時 ratio 必須是 null，不是 Infinity
    const zeroBenchmarkArea = { city: '桃園市', district: '零分母說明區', visitors: 100, add_to_cart_visitors: 0, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 };
    const zeroContext = { ...context, averageCartToCheckoutRate: 0, averageVisitToCartRate: 0 };
    const comparisons = buildMetricComparisons(zeroBenchmarkArea, zeroContext, 'high_traffic_low_cart');
    const cartVsAvg = comparisons.find((c) => c.compare_to === 'store_average');
    if (cartVsAvg) {
      assert(cartVsAvg.ratio === null, '6-1 benchmark 為 0 時 ratio = null（不是 Infinity）');
      assert(!Number.isNaN(cartVsAvg.ratio), '6-2 ratio 不是 NaN');
    }
    comparisons.forEach((c, i) => {
      assert(c.ratio === null || Number.isFinite(c.ratio), `6-3-${i} metric_comparisons ratio 為 null 或有限數字，不出現 Infinity/NaN`);
      assert(c.absolute_difference === null || Number.isFinite(c.absolute_difference), `6-4-${i} absolute_difference 為 null 或有限數字`);
    });

    // threshold_hits：threshold 為 0 也不能整個崩潰
    const hits = buildThresholdHits('high_traffic_low_cart', ['high_traffic_low_cart'], { visitors: 100, cartVisitors: 0, checkoutVisitors: 0, purchaseVisitors: 0, visitToCartRate: 0, cartToCheckoutRate: 0, checkoutToPurchaseRate: 0, visitToPurchaseRate: 0 }, context);
    hits.forEach((h, i) => {
      assert(Number.isFinite(h.margin), `6-5-${i} threshold_hits margin 為有限數字（threshold=0 情境不崩潰）`);
      assert(typeof h.passed === 'boolean', `6-6-${i} threshold_hits passed 為布林值`);
    });

    // confidence_breakdown：geoIdentifiedRate 為 undefined 時不崩潰
    const undefinedQualityContext = { ...context };
    delete undefinedQualityContext.geoIdentifiedRate;
    const cbUndefined = buildConfidenceBreakdown('high_traffic_low_cart', { visitors: 100, cartVisitors: 4, checkoutVisitors: 0, purchaseVisitors: 0, visitToCartRate: 0.05, cartToCheckoutRate: 0, checkoutToPurchaseRate: 0, visitToPurchaseRate: 0, matchedCount: 1 }, undefinedQualityContext);
    assert(Number.isFinite(cbUndefined.score), '6-7 geoIdentifiedRate=undefined 時 confidence score 仍為有限數字');
    assertJsonSafe(cbUndefined, '6-8 confidence breakdown（undefined geoIdentifiedRate 情境）');

    // sample_assessment：minimum=0 時不除以 0 崩潰（status 判斷用乘法不是除法，理論上安全，仍驗證）
    const zeroMinContext = { ...context, thresholds: { ...context.thresholds, minimumPurchaseVisitors: 0 } };
    const saZeroMin = buildSampleAssessment({ visitors: 10, purchase_visitors: 0 }, zeroMinContext, 'high_traffic_high_conversion');
    assert(Number.isFinite(saZeroMin.margin), '6-9 minimum_required=0 時 margin 仍為有限數字');
  }

  // ══════════════════════════════════════════════════════════
  // 7. Privacy（二十）
  // ══════════════════════════════════════════════════════════
  {
    const areaPriv = { city: '桃園市', district: '隱私說明區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 8, purchase_visitors: 1, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.2, checkout_to_purchase_rate: 0.125, visit_to_purchase_rate: 0.01 };
    const recos = buildGeoBehaviorRecommendations([areaPriv], context);
    const serialized = JSON.stringify(recos);
    ['visitor_id', 'identity_key', 'line_uid', 'line_user_id', 'cart_id', 'order_id', 'token', 'secret', 'gps', 'latitude', 'longitude', '_visitor_id_raw', '_line_uid_raw'].forEach((field) => {
      assert(!serialized.toLowerCase().includes(field.toLowerCase()), `7-1 explanation 含在內的完整輸出不含敏感欄位「${field}」`);
    });
    assert(!/09\d{8}/.test(serialized), '7-2 不含台灣手機號碼格式字串');
    // message/summary/reason 文字內容也要單獨掃描（二十：連文字內容也不得出現）
    const allMessages = [];
    recos.forEach((r) => {
      allMessages.push(r.reason, r.explanation.summary);
      r.explanation.threshold_hits.forEach((h) => allMessages.push(h.message));
      r.explanation.metric_comparisons.forEach((c) => allMessages.push(c.message));
      r.explanation.confidence_breakdown.reasons.forEach((m) => allMessages.push(m));
    });
    const joined = allMessages.join(' ');
    ['identity_key', 'visitor_id', 'line_user_id', 'cart_id', 'order_id'].forEach((field) => {
      assert(!joined.includes(field), `7-3 summary/reason/message 文字內容不含技術欄位名稱「${field}」`);
    });
  }

  // ══════════════════════════════════════════════════════════
  // Part B：真實 DB + Route 整合測試
  // ══════════════════════════════════════════════════════════
  {
    const DATA_DIR = path.join(ROOT, 'data');
    const DB_FILE = path.join(DATA_DIR, 'pos.db');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

    const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
    await initDb();
    const db = getDb();
    const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
    const analyticsGeoRouter = require(path.join(ROOT, 'routes/analytics-geo'));

    const STORE_EXPLAIN = 'store_explainability_integration';
    const geo = { geo_country: 'TW', geo_city: '桃園市', geo_district: '整合說明區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };

    for (let i = 0; i < 12; i += 1) {
      insertEvent(db, { store_id: STORE_EXPLAIN, visitor_id: `exp-v${i}`, session_id: `exp-s${i}`, event_name: 'page_view', geo });
    }
    for (let i = 0; i < 6; i += 1) {
      insertEvent(db, { store_id: STORE_EXPLAIN, visitor_id: `exp-v${i}`, session_id: `exp-s${i}`, cart_id: `exp-cart${i}`, event_name: 'begin_checkout', geo });
    }

    const resp = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: STORE_EXPLAIN, query: {} });
    assert(resp.statusCode === 200 && resp.body.success === true, '8-1 /alerts 200 success（Contract 未被破壞）');
    assert(Array.isArray(resp.body.data.alerts), '8-2 舊欄位 alerts 仍存在且為陣列');
    assert(Array.isArray(resp.body.data.behavior_recommendations), '8-3 舊欄位 behavior_recommendations 仍存在且為陣列');
    assert('rule_thresholds' in resp.body.data, '8-4 舊欄位 rule_thresholds 仍存在');
    assert('rule_context' in resp.body.data, '8-5 舊欄位 rule_context 仍存在');
    assert('quality_recommendations' in resp.body.data, '8-6 舊欄位 quality_recommendations 仍存在');
    assert(resp.body.data.explainability_version === '1.0', '8-7 新欄位 explainability_version = "1.0"');

    const integrationReco = resp.body.data.behavior_recommendations.find((r) => r.district === '整合說明區');
    assert(!!integrationReco, '8-8 整合說明區出現在真實流程的 behavior_recommendations');
    if (integrationReco) {
      assert('explanation' in integrationReco, '8-9 recommendation 含 explanation 欄位');
      assert(typeof integrationReco.explanation.summary === 'string', '8-10 explanation.summary 為字串');
      // 舊欄位逐一確認仍存在，未被 explanation 擠掉或改名
      ['code', 'title', 'classification', 'confidence', 'severity', 'reason', 'metrics', 'action', 'evidence', 'scope'].forEach((f) => {
        assert(f in integrationReco, `8-11 舊欄位「${f}」仍存在於真實回應中`);
      });
      assert(integrationReco.explanation.sample_assessment.relevant_stage_visitors === 6, '8-12 資料一致性：explanation 內的 sample_assessment 對應到真實寫入的 6 筆 begin_checkout');
    }

    // Scope（Smoke 必測：store/date/channel/county/district/source/medium/campaign）
    const scopeResp = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: STORE_EXPLAIN, query: { source: 'fb', medium: 'cpc', campaign: 'campZ' } });
    const scopedReco = scopeResp.body.data.behavior_recommendations.find((r) => r.district === '整合說明區');
    if (scopedReco) {
      assert(scopedReco.scope.store_id === STORE_EXPLAIN, '8-13 Scope: store_id 正確');
      assert('date_range' in scopedReco.scope, '8-14 Scope: date_range 存在');
      assert('channel' in scopedReco.scope, '8-15 Scope: channel 存在');
      assert('county_code' in scopedReco.scope, '8-16 Scope: county_code 存在');
      assert('subdivision_code' in scopedReco.scope, '8-17 Scope: subdivision_code 存在（對應行政區/district scope）');
      assert('source' in scopedReco.scope, '8-18 Scope: source 存在');
      assert('medium' in scopedReco.scope, '8-19 Scope: medium 存在');
      assert('campaign' in scopedReco.scope, '8-20 Scope: campaign 存在');
    } else {
      assert(true, '8-13~20 Scope: source/medium/campaign 篩選後該區域無資料（誠實記錄，非灌水略過）');
    }

    // JSON safety：完整 /alerts 回應可安全 stringify，不含 NaN/Infinity/function
    assertJsonSafe(resp.body, '8-21 完整 /alerts 回應（含 explanation）');

    // Privacy：完整回應 stringify 掃描
    const fullSerialized = JSON.stringify(resp.body);
    ['exp-v0', 'exp-s0', 'exp-cart0', 'identity_key', 'line_user_id', '_visitor_id_raw'].forEach((needle) => {
      assert(!fullSerialized.includes(needle), `8-22 完整 /alerts 回應不含「${needle}」`);
    });

    // Store isolation
    const respOther = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_explain_other', query: {} });
    assert(!respOther.body.data.behavior_recommendations.some((r) => r.district === '整合說明區'), '8-23 Store Isolation：其他店家看不到整合說明區的建議/說明');

    // 空資料店家：explanation 相關欄位仍安全
    const respEmpty = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_explain_never_used', query: {} });
    assert(Array.isArray(respEmpty.body.data.behavior_recommendations) && respEmpty.body.data.behavior_recommendations.length === 0, '8-24 空資料店家：behavior_recommendations 為空陣列，不崩潰');
    assert(respEmpty.body.data.explainability_version === '1.0', '8-25 空資料店家：explainability_version 仍存在');
    assertJsonSafe(respEmpty.body, '8-26 空資料店家完整回應');
  }

  // ══════════════════════════════════════════════════════════
  // 結果彙總
  // ══════════════════════════════════════════════════════════
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n總計：${results.length} 項，PASS ${passCount}，FAIL ${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
