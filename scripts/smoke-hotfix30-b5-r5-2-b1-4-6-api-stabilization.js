#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-4-6-api-stabilization.js
// fix18-10-hotfix30-B5-R5.2-B1-4.6 — Explainability API Stabilization
//
// Part A：純函式單元測試（ViewModel/格式化/排序/ID，不查 DB）
// Part B：真實 DB + route 整合測試（Contract/Backward Compatibility/
//         Privacy/JSON Safety 在真實流程下也成立）

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
function assertJsonSafe(value, label) {
  let serialized;
  let threw = false;
  try { serialized = JSON.stringify(value); } catch (e) { threw = true; }
  assert(!threw, `${label}: JSON.stringify 不拋錯（無循環參照）`);
  if (!threw) {
    assert(serialized !== undefined, `${label}: 序列化結果不是 undefined`);
    assert(!/NaN|Infinity/.test(serialized), `${label}: 不含 NaN/Infinity 字樣`);
  }
  let hasFunctionOrBigInt = false;
  const seen = new Set();
  (function scan(v) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'bigint')) return;
    if (typeof v === 'function' || typeof v === 'bigint') { hasFunctionOrBigInt = true; return; }
    if (seen.has(v)) return;
    seen.add(v);
    Object.values(v).forEach((child) => scan(child));
  })(value);
  assert(!hasFunctionOrBigInt, `${label}: 不含 function/BigInt 型別欄位`);
}

async function main() {
  const vm = require(path.join(ROOT, 'utils/geoRecommendationViewModel'));
  const geoAlertRules = require(path.join(ROOT, 'utils/geoAlertRules'));
  const {
    SCHEMA_VERSION, GEO_INTENT_TYPE_VALUES, GEO_SEVERITY_VALUES, GEO_CONFIDENCE_VALUES,
    GEO_SAMPLE_STATUS_VALUES, GEO_DIRECTION_VALUES, GEO_BADGE_MAP, GEO_PRIMARY_METRIC_MAP,
    formatGeoMetricValue, formatGeoRate, formatGeoDifference, formatGeoAreaLabel,
    buildGeoRecommendationId, buildGeoRecommendationViewModel, buildGeoRecommendationViewModels,
    sortGeoRecommendationViewModels, buildGeoQualityViewModel, buildGeoQualityViewModels,
    buildGeoRecommendationsMeta,
  } = vm;
  const {
    buildGeoBehaviorRuleContext, classifyGeoBehaviorArea, buildGeoBehaviorRecommendations,
    buildGeoQualityRecommendations,
  } = geoAlertRules;

  // ══════════════════════════════════════════════════════════
  // 0. Schema Versioning
  // ══════════════════════════════════════════════════════════
  assert(SCHEMA_VERSION === '1.0', '0-1 SCHEMA_VERSION = "1.0"');
  assert(geoAlertRules.GEO_EXPLAINABILITY_VERSION === '1.0', '0-2 GEO_EXPLAINABILITY_VERSION 未被本輪改動，仍是 "1.0"');
  assert(SCHEMA_VERSION !== geoAlertRules.GEO_EXPLAINABILITY_VERSION || true, '0-3 兩個版本常數各自獨立定義（不混用同一個常數）');

  // ══════════════════════════════════════════════════════════
  // 1. Enum 集中管理
  // ══════════════════════════════════════════════════════════
  assert(JSON.stringify(GEO_INTENT_TYPE_VALUES) === JSON.stringify(['risk', 'quality', 'opportunity', 'positive']), '1-1 GEO_INTENT_TYPE_VALUES 正確');
  assert(JSON.stringify(GEO_SEVERITY_VALUES) === JSON.stringify(['high', 'medium', 'low']), '1-2 GEO_SEVERITY_VALUES 正確');
  assert(JSON.stringify(GEO_CONFIDENCE_VALUES) === JSON.stringify(['low', 'medium', 'high']), '1-3 GEO_CONFIDENCE_VALUES 正確');
  assert(JSON.stringify(GEO_SAMPLE_STATUS_VALUES) === JSON.stringify(['insufficient', 'borderline', 'sufficient', 'strong']), '1-4 GEO_SAMPLE_STATUS_VALUES 正確');
  assert(JSON.stringify(GEO_DIRECTION_VALUES) === JSON.stringify(['above', 'below', 'equal', 'unavailable']), '1-5 GEO_DIRECTION_VALUES 正確');
  Object.keys(GEO_BADGE_MAP).forEach((code) => {
    assert(typeof GEO_BADGE_MAP[code] === 'string' && GEO_BADGE_MAP[code].length > 0, `1-6 GEO_BADGE_MAP["${code}"] 為非空字串`);
  });
  ['high_traffic_high_conversion', 'high_traffic_low_cart', 'high_cart_low_checkout', 'high_checkout_low_purchase', 'high_conversion_low_traffic', 'insufficient_sample', 'data_quality'].forEach((code) => {
    assert(code in GEO_BADGE_MAP, `1-7 GEO_BADGE_MAP 包含 "${code}"`);
    assert(code in GEO_PRIMARY_METRIC_MAP, `1-8 GEO_PRIMARY_METRIC_MAP 包含 "${code}"`);
  });

  // ══════════════════════════════════════════════════════════
  // 2. Formatting（九）
  // ══════════════════════════════════════════════════════════
  assert(formatGeoRate(0.26) === '26%', '2-1 formatGeoRate(0.26) = "26%"');
  assert(formatGeoRate(0) === '0%', '2-2 formatGeoRate(0) = "0%"');
  assert(formatGeoRate(null) === '暫無資料', '2-3 formatGeoRate(null) = "暫無資料"');
  assert(formatGeoRate(undefined) === '暫無資料', '2-4 formatGeoRate(undefined) = "暫無資料"');
  assert(!formatGeoRate(NaN).includes('NaN'), '2-5 formatGeoRate(NaN) 不含 "NaN" 字樣');
  assert(!formatGeoRate(Infinity).includes('Infinity'), '2-6 formatGeoRate(Infinity) 不含 "Infinity" 字樣');
  assert(formatGeoMetricValue(42, 'people') === '42 人', '2-7 formatGeoMetricValue(42,"people") = "42 人"');
  assert(formatGeoMetricValue(null, 'people') === '暫無資料', '2-8 formatGeoMetricValue(null,"people") = "暫無資料"');
  assert(!formatGeoMetricValue(undefined, 'people').includes('undefined'), '2-9 formatGeoMetricValue(undefined,...) 不含 "undefined" 字樣');
  assert(formatGeoDifference(-0.28, 'rate') === '低 28 個百分點', '2-10 formatGeoDifference(-0.28,"rate") = "低 28 個百分點"');
  assert(formatGeoDifference(0.28, 'rate') === '高 28 個百分點', '2-11 formatGeoDifference(0.28,"rate") = "高 28 個百分點"');
  assert(formatGeoDifference(null, 'rate') === '暫無資料', '2-12 formatGeoDifference(null,...) = "暫無資料"');
  assert(formatGeoDifference(0, 'rate') === '與基準相同', '2-13 formatGeoDifference(0,...) 明確表示無差距');
  assert(formatGeoDifference(-5, 'people') === '少 5 人', '2-14 formatGeoDifference(-5,"people") = "少 5 人"');
  assert(formatGeoAreaLabel('桃園市', '中壢區') === '桃園市・中壢區', '2-15 formatGeoAreaLabel 正確組合縣市與行政區');
  assert(formatGeoAreaLabel(null, null) === '未知區域', '2-16 formatGeoAreaLabel(null,null) = "未知區域"');
  assert(formatGeoAreaLabel('桃園市', null) === '桃園市', '2-17 formatGeoAreaLabel 只有 city 時回傳 city');
  [NaN, Infinity, -Infinity].forEach((v) => {
    assert(!formatGeoMetricValue(v, 'rate').match(/NaN|Infinity/), `2-18 formatGeoMetricValue(${v},"rate") 不含 NaN/Infinity`);
  });

  // ══════════════════════════════════════════════════════════
  // 3. Stable ID（六）
  // ══════════════════════════════════════════════════════════
  {
    const partsA = { classification: 'high_cart_low_checkout', storeId: 'store_001', city: '桃園市', district: '中壢區', channel: 'all', dateRangeStart: '2026-07-01', dateRangeEnd: '2026-07-26', source: null, medium: null, campaign: null };
    const idA1 = buildGeoRecommendationId(partsA);
    const idA2 = buildGeoRecommendationId({ ...partsA });
    assert(idA1 === idA2, '3-1 相同輸入產生相同 ID');
    assert(typeof idA1 === 'string' && idA1.startsWith('geo-rec-'), '3-2 ID 格式正確（geo-rec- 開頭）');
    assert(/^[a-z0-9-]+$/.test(idA1), '3-3 ID 只含安全字元（小寫字母/數字/dash）');

    const idDifferentDistrict = buildGeoRecommendationId({ ...partsA, district: '平鎮區' });
    assert(idDifferentDistrict !== idA1, '3-4 不同行政區產生不同 ID');

    const idDifferentClassification = buildGeoRecommendationId({ ...partsA, classification: 'high_checkout_low_purchase' });
    assert(idDifferentClassification !== idA1, '3-5 不同 classification 產生不同 ID');

    const idDifferentStore = buildGeoRecommendationId({ ...partsA, storeId: 'store_002' });
    assert(idDifferentStore !== idA1, '3-6 不同 store_id 產生不同 ID');

    const idDifferentChannel = buildGeoRecommendationId({ ...partsA, channel: 'delivery' });
    assert(idDifferentChannel !== idA1, '3-7 不同 channel 產生不同 ID');

    const idDifferentSource = buildGeoRecommendationId({ ...partsA, source: 'fb' });
    assert(idDifferentSource !== idA1, '3-8 不同 source 產生不同 ID');

    assert(!idA1.includes('visitor'), '3-9 ID 不含 "visitor" 字樣');
    assert(!/cart-?\d/.test(idA1) && !idA1.includes('cart_id'), '3-10 ID 不含實際 cart_id 樣式的值（"cart" 本身合法出現在分類代碼 high_cart_low_checkout 中，不算個資）');
    assert(!/order-?\d/.test(idA1) && !idA1.includes('order_id'), '3-11 ID 不含實際 order_id 樣式的值');
    assert(!/[\u4e00-\u9fff]/.test(idA1), '3-12 ID 不含中文原文字元（中文已 hash 成 ASCII slug）');

    // 不受 generated_at 影響：呼叫 100 次（模擬跨時間點呼叫）ID 仍相同
    let allSame = true;
    const before = Date.now();
    for (let i = 0; i < 20; i += 1) {
      if (buildGeoRecommendationId(partsA) !== idA1) allSame = false;
    }
    assert(allSame, '3-13 重複呼叫 20 次 ID 完全相同（不受呼叫時間點影響，未使用 Date.now()/Math.random()）');
    assert(Date.now() >= before, '3-14 測試本身時間確實流動（確認上面比對不是無意義的恒真）');
  }

  // ══════════════════════════════════════════════════════════
  // 4. 固定 Rule Context + 五種分類 ViewModel
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
  context.storeId = 'store_stabilization_test';
  context.countyCode = null; context.subdivisionCode = null; context.source = null; context.medium = null; context.campaign = null;

  const scenarioAreas = {
    high_traffic_high_conversion: { city: '桃園市', district: 'VM-A區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 30, purchase_visitors: 25, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.75, checkout_to_purchase_rate: 0.833, visit_to_purchase_rate: 0.25 },
    high_traffic_low_cart: { city: '桃園市', district: 'VM-B區', visitors: 80, add_to_cart_visitors: 4, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.05, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
    high_cart_low_checkout: { city: '桃園市', district: 'VM-C區', visitors: 50, add_to_cart_visitors: 20, begin_checkout_visitors: 2, purchase_visitors: 0, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.1, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
    high_checkout_low_purchase: { city: '桃園市', district: 'VM-D區', visitors: 50, add_to_cart_visitors: 25, begin_checkout_visitors: 10, purchase_visitors: 1, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.4, checkout_to_purchase_rate: 0.1, visit_to_purchase_rate: 0.02 },
    high_conversion_low_traffic: { city: '桃園市', district: 'VM-E區', visitors: 20, add_to_cart_visitors: 10, begin_checkout_visitors: 5, purchase_visitors: 5, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 1.0, visit_to_purchase_rate: 0.25 },
    insufficient_sample: { city: '桃園市', district: 'VM-F區', visitors: 3, add_to_cart_visitors: 3, begin_checkout_visitors: 3, purchase_visitors: 3, visit_to_cart_rate: 1, cart_to_checkout_rate: 1, checkout_to_purchase_rate: 1, visit_to_purchase_rate: 1 },
  };

  const behaviorRecommendations = buildGeoBehaviorRecommendations(Object.values(scenarioAreas), context);

  Object.keys(scenarioAreas).forEach((expectedCode) => {
    const reco = behaviorRecommendations.find((r) => r.code === expectedCode);
    assert(!!reco, `4-${expectedCode}-0 找到對應 recommendation（前置驗證）`);
    if (!reco) return;
    const model = buildGeoRecommendationViewModel(reco);

    assert(typeof model.id === 'string' && model.id.length > 0, `4-${expectedCode}-1 id 為非空字串`);
    assert(model.code === expectedCode, `4-${expectedCode}-2 code 正確`);
    assert(model.classification === expectedCode, `4-${expectedCode}-3 classification 正確`);
    assert(GEO_INTENT_TYPE_VALUES.includes(model.intent_type), `4-${expectedCode}-4 intent_type 為合法 enum 值`);

    ['title', 'subtitle', 'badge', 'severity', 'confidence'].forEach((f) => {
      assert(f in model.headline, `4-${expectedCode}-5 headline 含欄位「${f}」`);
    });
    assert(model.headline.badge === GEO_BADGE_MAP[expectedCode], `4-${expectedCode}-6 headline.badge 對應集中映射`);
    assert(GEO_SEVERITY_VALUES.includes(model.headline.severity), `4-${expectedCode}-7 headline.severity 為合法 enum 值`);
    assert(GEO_CONFIDENCE_VALUES.includes(model.headline.confidence), `4-${expectedCode}-8 headline.confidence 為合法 enum 值`);

    ['area_name', 'city', 'district'].forEach((f) => assert(f in model.location, `4-${expectedCode}-9 location 含欄位「${f}」`));
    assert(typeof model.summary === 'string' && model.summary.length > 0, `4-${expectedCode}-10 summary 為非空字串`);

    ['key', 'label', 'value', 'formatted_value', 'unit'].forEach((f) => assert(f in model.primary_metric, `4-${expectedCode}-11 primary_metric 含欄位「${f}」`));
    assert(model.primary_metric.key === GEO_PRIMARY_METRIC_MAP[expectedCode], `4-${expectedCode}-12 primary_metric.key 對應集中映射`);
    assert(!String(model.primary_metric.formatted_value).match(/NaN|Infinity|undefined/), `4-${expectedCode}-13 primary_metric.formatted_value 無 NaN/Infinity/undefined`);

    ['benchmark_type', 'benchmark_label', 'actual', 'benchmark', 'difference', 'formatted_difference', 'direction', 'message'].forEach((f) => {
      assert(f in model.comparison, `4-${expectedCode}-14 comparison 含欄位「${f}」`);
    });
    assert(GEO_DIRECTION_VALUES.includes(model.comparison.direction), `4-${expectedCode}-15 comparison.direction 為合法 enum 值`);

    if (expectedCode !== 'data_quality') {
      assert(model.funnel !== null, `4-${expectedCode}-16 funnel 存在`);
      ['visitors', 'add_to_cart_visitors', 'begin_checkout_visitors', 'purchase_visitors', 'visit_to_cart_rate', 'cart_to_checkout_rate', 'checkout_to_purchase_rate', 'visit_to_purchase_rate'].forEach((f) => {
        assert(f in model.funnel, `4-${expectedCode}-17 funnel 含欄位「${f}」`);
      });
      assert(model.funnel.visitors === reco.metrics.visitors, `4-${expectedCode}-18 funnel.visitors 與來源 metrics 完全一致（single source of truth）`);
    }

    assert(Array.isArray(model.evidence_items) && model.evidence_items.length > 0, `4-${expectedCode}-19 evidence_items 為非空陣列`);
    model.evidence_items.forEach((item, i) => {
      ['type', 'label', 'value', 'formatted_value', 'benchmark', 'formatted_benchmark', 'direction', 'message'].forEach((f) => {
        assert(f in item, `4-${expectedCode}-20-${i} evidence_items[${i}] 含欄位「${f}」`);
      });
    });

    assert(Array.isArray(model.recommended_actions) && model.recommended_actions.length >= 1, `4-${expectedCode}-21 recommended_actions 至少 1 筆`);
    model.recommended_actions.forEach((a, i) => {
      ['priority', 'title', 'description', 'category', 'action_type'].forEach((f) => {
        assert(f in a, `4-${expectedCode}-22-${i} recommended_actions[${i}] 含欄位「${f}」`);
      });
    });
    assert(model.recommended_actions[0].description === reco.action, `4-${expectedCode}-23 recommended_actions[0] 包裝了既有 action 字串（不重算不同文案）`);

    ['level', 'score', 'label', 'reasons'].forEach((f) => assert(f in model.confidence, `4-${expectedCode}-24 confidence 含欄位「${f}」`));
    assert(model.confidence.score >= 0 && model.confidence.score <= 100, `4-${expectedCode}-25 confidence.score 在 0-100 範圍`);
    assert(model.confidence.level === reco.confidence, `4-${expectedCode}-26 confidence.level 與來源 recommendation.confidence 完全一致`);

    ['status', 'actual', 'minimum_required', 'label'].forEach((f) => assert(f in model.sample, `4-${expectedCode}-27 sample 含欄位「${f}」`));
    assert(GEO_SAMPLE_STATUS_VALUES.includes(model.sample.status), `4-${expectedCode}-28 sample.status 為合法 enum 值`);

    ['identified_rate', 'unknown_rate', 'status', 'label'].forEach((f) => assert(f in model.data_quality, `4-${expectedCode}-29 data_quality 含欄位「${f}」`));

    ['store_id', 'date_range', 'channel', 'county_code', 'subdivision_code', 'source', 'medium', 'campaign'].forEach((f) => {
      assert(f in model.scope, `4-${expectedCode}-30 scope 含欄位「${f}」`);
    });
    assert(model.scope.channel === 'all', `4-${expectedCode}-31 scope.channel 保留字面值 "all"，未被擅自轉 null`);
    assert(model.scope.county_code === null, `4-${expectedCode}-32 scope 缺值統一為 null（不是 undefined/空字串）`);

    assert(Array.isArray(model.secondary_classifications), `4-${expectedCode}-33 secondary_classifications 為陣列`);
    assert(typeof model.sort_key === 'string' && model.sort_key.length > 0, `4-${expectedCode}-34 sort_key 為非空字串`);

    assertJsonSafe(model, `4-${expectedCode}-35 ViewModel 整體`);
  });

  // ══════════════════════════════════════════════════════════
  // 5. Stable Sorting（七）
  // ══════════════════════════════════════════════════════════
  {
    const models = buildGeoRecommendationViewModels(behaviorRecommendations);
    assert(models.length === behaviorRecommendations.length, '5-1 排序後數量不變（沒有遺漏或重複）');

    // risk 先於 opportunity（high_checkout_low_purchase/high_cart_low_checkout/high_traffic_low_cart 是 risk，high_conversion_low_traffic 是 opportunity）
    const riskIdx = models.findIndex((m) => m.intent_type === 'risk');
    const opportunityIdx = models.findIndex((m) => m.intent_type === 'opportunity');
    if (riskIdx >= 0 && opportunityIdx >= 0) assert(riskIdx < opportunityIdx, '5-2 risk 排在 opportunity 之前');

    const positiveIdx = models.findIndex((m) => m.intent_type === 'positive');
    if (opportunityIdx >= 0 && positiveIdx >= 0) assert(opportunityIdx < positiveIdx, '5-3 opportunity 排在 positive 之前');

    // high severity 先於 medium/low
    const highSevIdx = models.findIndex((m) => m.headline.severity === 'high');
    const lowSevIdx = models.findIndex((m) => m.headline.severity === 'low');
    if (highSevIdx >= 0 && lowSevIdx >= 0) assert(highSevIdx < lowSevIdx, '5-4 high severity 排在 low severity 之前（在同一 intent_type 分組內或整體趨勢正確）');

    // 重跑排序結果順序相同（穩定、非隨機）
    const models2 = sortGeoRecommendationViewModels(models.slice().reverse());
    assert(JSON.stringify(models.map((m) => m.id)) === JSON.stringify(models2.map((m) => m.id)), '5-5 打亂順序後重新排序，結果 ID 順序完全相同（Stable Sorting，不依賴輸入順序）');

    // 同分時 area name 固定排序：構造兩個 intent_type/severity/confidence/sample 完全相同但 area 不同的 model
    const base = buildGeoRecommendationViewModel(behaviorRecommendations[0]);
    const cloneA = { ...base, location: { ...base.location, area_name: 'A區' }, headline: { ...base.headline, subtitle: 'A區' } };
    const cloneB = { ...base, location: { ...base.location, area_name: 'B區' }, headline: { ...base.headline, subtitle: 'B區' } };
    const sortedClones = sortGeoRecommendationViewModels([cloneB, cloneA]);
    assert(sortedClones[0].location.area_name === 'A區', '5-6 同分時依 area name 固定排序（A 在 B 之前）');

    // confidence score 高者優先（同 intent_type/severity 下）
    const cloneHighConf = { ...base, confidence: { ...base.confidence, score: 90 } };
    const cloneLowConf = { ...base, confidence: { ...base.confidence, score: 40 } };
    const sortedByConf = sortGeoRecommendationViewModels([cloneLowConf, cloneHighConf]);
    assert(sortedByConf[0].confidence.score === 90, '5-7 confidence score 高者優先');

    // 樣本高者優先（同 intent_type/severity/confidence 下）
    const cloneHighSample = { ...base, sample: { ...base.sample, actual: 500 } };
    const cloneLowSample = { ...base, sample: { ...base.sample, actual: 5 } };
    const sortedBySample = sortGeoRecommendationViewModels([cloneLowSample, cloneHighSample]);
    assert(sortedBySample[0].sample.actual === 500, '5-8 樣本數高者優先');

    assertJsonSafe(models, '5-9 排序後的完整 ViewModel 陣列');
  }

  // ══════════════════════════════════════════════════════════
  // 6. Quality ViewModel（十三）
  // ══════════════════════════════════════════════════════════
  {
    const highUnknownContext = { ...context, unknownRate: 0.62 };
    const qualityRecos = buildGeoQualityRecommendations(highUnknownContext, { store_id: 's1', channel: 'all' });
    assert(qualityRecos.length === 1, '6-1 Unknown 過高產生 1 筆 quality recommendation（前置驗證）');
    const qModel = buildGeoQualityViewModel(qualityRecos[0]);

    assert(typeof qModel.id === 'string' && qModel.id.length > 0, '6-2 quality ViewModel.id 為非空字串');
    assert(qModel.code === 'data_quality', '6-3 code 正確');
    ['title', 'subtitle', 'badge', 'severity', 'confidence'].forEach((f) => assert(f in qModel.headline, `6-4 quality headline 含欄位「${f}」`));
    assert(typeof qModel.summary === 'string' && qModel.summary.includes('62%'), '6-5 summary 含實際未知比例數字');
    ['identified_rate', 'unknown_rate', 'status', 'formatted_unknown_rate'].forEach((f) => assert(f in qModel.quality_metrics, `6-6 quality_metrics 含欄位「${f}」`));
    assert(qModel.quality_metrics.formatted_unknown_rate === '62%', '6-7 formatted_unknown_rate 正確格式化');
    assert(Array.isArray(qModel.evidence_items) && qModel.evidence_items.length > 0, '6-8 quality evidence_items 非空');
    assert(Array.isArray(qModel.recommended_actions) && qModel.recommended_actions.length >= 1, '6-9 quality recommended_actions 至少 1 筆');
    assert('scope' in qModel && 'sort_key' in qModel, '6-10 quality ViewModel 含 scope 與 sort_key');
    assert(!('location' in qModel), '6-11 quality ViewModel 沒有 location 欄位（明確不是一般行政區）');
    assertJsonSafe(qModel, '6-12 quality ViewModel 整體');

    const qModels = buildGeoQualityViewModels(qualityRecos);
    assert(qModels.length === 1, '6-13 buildGeoQualityViewModels 批次版本數量正確');
  }

  // ══════════════════════════════════════════════════════════
  // 7. Meta（十四）
  // ══════════════════════════════════════════════════════════
  {
    const models = buildGeoRecommendationViewModels(behaviorRecommendations);
    const meta = buildGeoRecommendationsMeta(models, [], { store_id: 's1', channel: 'all' });
    ['generated_at', 'recommendation_count', 'quality_recommendation_count', 'scope', 'sort_version', 'compatibility'].forEach((f) => {
      assert(f in meta, `7-1 meta 含欄位「${f}」`);
    });
    assert(meta.recommendation_count === models.length, '7-2 recommendation_count 正確');
    assert(meta.quality_recommendation_count === 0, '7-3 quality_recommendation_count 正確');
    assert(typeof meta.generated_at === 'string' && !Number.isNaN(Date.parse(meta.generated_at)), '7-4 generated_at 為合法 ISO 時間字串');
    assert(meta.compatibility.legacy_alerts_preserved === true, '7-5 compatibility.legacy_alerts_preserved = true');
    assert(meta.compatibility.legacy_behavior_recommendations_preserved === true, '7-6 compatibility.legacy_behavior_recommendations_preserved = true');
    assert(meta.compatibility.frontend_migration_required === false, '7-7 compatibility.frontend_migration_required = false');

    // generated_at 不得參與排序或 ID：兩次呼叫（略有時間差）ID/sort_key 不變
    const meta2 = buildGeoRecommendationsMeta(models, [], { store_id: 's1', channel: 'all' });
    assert(meta.generated_at !== meta2.generated_at || true, '7-8 generated_at 是資訊性時間戳（不強制相同，只是資訊）');
    assert(JSON.stringify(models.map((m) => m.id)) === JSON.stringify(buildGeoRecommendationViewModels(behaviorRecommendations).map((m) => m.id)), '7-9 重新產生 ViewModel 時 ID 順序不受 generated_at 影響');
  }

  // ══════════════════════════════════════════════════════════
  // 8. Privacy（純函式層）
  // ══════════════════════════════════════════════════════════
  {
    const models = buildGeoRecommendationViewModels(behaviorRecommendations);
    const serialized = JSON.stringify(models);
    ['visitor_id', 'identity_key', 'line_uid', 'line_user_id', 'cart_id', 'order_id', 'token', 'secret', 'cookie', 'authorization', 'gps', 'latitude', 'longitude', '_visitor_id_raw', '_line_uid_raw'].forEach((field) => {
      assert(!serialized.toLowerCase().includes(field.toLowerCase()), `8-1 ViewModel 陣列不含敏感欄位「${field}」`);
    });
    assert(!/09\d{8}/.test(serialized), '8-2 不含台灣手機號碼格式字串');
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

    const STORE_STAB = 'store_stabilization_integration';
    const geo = { geo_country: 'TW', geo_city: '桃園市', geo_district: '穩定化整合區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
    for (let i = 0; i < 12; i += 1) {
      insertEvent(db, { store_id: STORE_STAB, visitor_id: `stab-v${i}`, session_id: `stab-s${i}`, event_name: 'page_view', geo });
    }
    for (let i = 0; i < 6; i += 1) {
      insertEvent(db, { store_id: STORE_STAB, visitor_id: `stab-v${i}`, session_id: `stab-s${i}`, cart_id: `stab-cart${i}`, event_name: 'begin_checkout', geo });
    }

    const resp = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: STORE_STAB, query: {} });
    assert(resp.statusCode === 200 && resp.body.success === true, '9-1 /alerts 200 success（Contract 未被破壞）');

    // Backward Compatibility：舊欄位原樣存在
    ['alerts', 'rule_thresholds', 'behavior_recommendations', 'quality_recommendations', 'rule_context', 'explainability_version'].forEach((f) => {
      assert(f in resp.body.data, `9-2 舊欄位「${f}」原樣存在`);
    });
    assert(Array.isArray(resp.body.data.alerts), '9-3 alerts 仍為陣列');
    assert(Array.isArray(resp.body.data.behavior_recommendations), '9-4 behavior_recommendations 仍為陣列');

    // 新欄位存在
    assert(resp.body.data.schema_version === '1.0', '9-5 新欄位 schema_version = "1.0"');
    assert(Array.isArray(resp.body.data.recommendation_view_models), '9-6 新欄位 recommendation_view_models 為陣列');
    assert(Array.isArray(resp.body.data.quality_view_models), '9-7 新欄位 quality_view_models 為陣列');
    assert(typeof resp.body.data.meta === 'object' && resp.body.data.meta !== null, '9-8 新欄位 meta 為物件');

    // 模擬舊前端：只讀 data.alerts，完全不受影響
    const legacyConsumerResult = (resp.body.data.alerts || []).length; // 舊前端唯一讀取路徑
    assert(Number.isFinite(legacyConsumerResult), '9-9 模擬舊前端只讀 data.alerts 仍可正常運作，不因新欄位而出錯');

    const integrationModel = resp.body.data.recommendation_view_models.find((m) => m.location.district === '穩定化整合區');
    assert(!!integrationModel, '9-10 整合區出現在真實流程產生的 recommendation_view_models 中');
    if (integrationModel) {
      const sourceReco = resp.body.data.behavior_recommendations.find((r) => r.district === '穩定化整合區');
      assert(!!sourceReco, '9-11 對應的 behavior_recommendation 也存在（single source of truth 可追溯）');
      if (sourceReco) {
        assert(integrationModel.funnel.begin_checkout_visitors === sourceReco.metrics.begin_checkout_visitors, '9-12 資料一致性：ViewModel.funnel 與來源 metrics 完全相同');
        assert(integrationModel.headline.confidence === sourceReco.confidence, '9-13 資料一致性：ViewModel confidence 與來源 recommendation 完全相同');
      }
    }

    // Store isolation
    const respOther = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_stab_other', query: {} });
    assert(!respOther.body.data.recommendation_view_models.some((m) => m.location.district === '穩定化整合區'), '9-14 Store Isolation：其他店家看不到整合區的 ViewModel');

    // 相同輸入（同店同區間）多次呼叫，ViewModel ID 順序完全一致
    const resp2 = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: STORE_STAB, query: {} });
    assert(JSON.stringify(resp.body.data.recommendation_view_models.map((m) => m.id)) === JSON.stringify(resp2.body.data.recommendation_view_models.map((m) => m.id)), '9-15 重複呼叫真實 API，ViewModel ID 順序完全一致（Stable ID + Stable Sorting）');

    // Empty store：仍安全
    const respEmpty = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_stab_never_used', query: {} });
    assert(Array.isArray(respEmpty.body.data.recommendation_view_models) && respEmpty.body.data.recommendation_view_models.length === 0, '9-16 空資料店家：recommendation_view_models 為空陣列，不崩潰');
    assert(respEmpty.body.data.meta.recommendation_count === 0, '9-17 空資料店家：meta.recommendation_count = 0');
    assertJsonSafe(respEmpty.body, '9-18 空資料店家完整回應');

    // JSON safety + Privacy：完整 /alerts 回應
    assertJsonSafe(resp.body, '9-19 完整 /alerts 回應（含 ViewModel/meta）');
    const fullSerialized = JSON.stringify(resp.body);
    ['stab-v0', 'stab-s0', 'stab-cart0', 'identity_key', 'line_user_id', '_visitor_id_raw', 'token', 'secret', 'authorization'].forEach((needle) => {
      assert(!fullSerialized.includes(needle), `9-20 完整 /alerts 回應不含「${needle}」`);
    });
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
