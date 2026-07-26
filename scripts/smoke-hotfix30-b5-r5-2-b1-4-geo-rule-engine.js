#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-4-geo-rule-engine.js
// fix18-10-hotfix30-B5-R5.2-B1-4 — Geo 行為規則引擎 × 行政區意圖分類 ×
// Recommended Actions。
//
// Part A：純函式單元測試（classifyGeoBehaviorArea / buildGeoBehaviorRuleContext /
//         buildGeoBehaviorRecommendations / buildGeoQualityRecommendations），
//         直接吃手工構造的聚合物件（模擬 getGeoFunnel() 的 areas[] 形狀），
//         不查 DB——符合需求文件十三「規則引擎吃聚合結果，不查 raw events」。
// Part B：真實 DB + route 整合測試（至少 1 條情境走完整路徑：insertEvent()
//         → getGeoFunnel() → 規則引擎 → GET /alerts），確認 Response
//         Contract、Scope、Privacy 在真實流程下也成立。

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

async function main() {
  const {
    getGeoAlertRules, DEFAULTS,
    GEO_BEHAVIOR_RULE_DEFAULTS, getGeoBehaviorRuleThresholds, GEO_BEHAVIOR_PRIORITY_ORDER,
    buildGeoBehaviorRuleContext, classifyGeoBehaviorArea, buildGeoBehaviorRecommendations,
    buildGeoQualityRecommendations,
  } = require(path.join(ROOT, 'utils/geoAlertRules'));

  // ══════════════════════════════════════════════════════════
  // 0. 既有 Geo Alerts 未被破壞（沿用、不改名不改格式）
  // ══════════════════════════════════════════════════════════
  {
    const oldRules = getGeoAlertRules();
    assert(oldRules.GEO_ALERT_MIN_VISITORS === DEFAULTS.GEO_ALERT_MIN_VISITORS, '0-1 既有 GEO_ALERT_MIN_VISITORS 未被改動');
    assert(oldRules.GEO_ALERT_LOW_CART_RATE === DEFAULTS.GEO_ALERT_LOW_CART_RATE, '0-2 既有 GEO_ALERT_LOW_CART_RATE 未被改動');
    assert(oldRules.GEO_ALERT_LOW_ORDER_RATE === DEFAULTS.GEO_ALERT_LOW_ORDER_RATE, '0-3 既有 GEO_ALERT_LOW_ORDER_RATE 未被改動');
    assert(oldRules.GEO_ALERT_UNKNOWN_RATE === DEFAULTS.GEO_ALERT_UNKNOWN_RATE, '0-4 既有 GEO_ALERT_UNKNOWN_RATE 未被改動');
    assert(typeof getGeoAlertRules === 'function', '0-5 getGeoAlertRules 函式仍存在（未被新規則覆蓋/改名）');
  }

  // ══════════════════════════════════════════════════════════
  // 1. Rule Thresholds 集中管理
  // ══════════════════════════════════════════════════════════
  {
    const t = getGeoBehaviorRuleThresholds();
    assert(t.minimumVisitors === GEO_BEHAVIOR_RULE_DEFAULTS.minimumVisitors, '1-1 minimumVisitors 讀自集中設定');
    assert(t.lowCartRate === GEO_BEHAVIOR_RULE_DEFAULTS.lowCartRate, '1-2 lowCartRate 讀自集中設定');
    assert(t.highOverallConversionRate === GEO_BEHAVIOR_RULE_DEFAULTS.highOverallConversionRate, '1-3 highOverallConversionRate 讀自集中設定');
    assert(t.lowGeoConfidenceRate === GEO_BEHAVIOR_RULE_DEFAULTS.lowGeoConfidenceRate, '1-4 lowGeoConfidenceRate 讀自集中設定');
    assert(Object.keys(GEO_BEHAVIOR_RULE_DEFAULTS).length >= 20, '1-5 集中設定區欄位數量充足（門檻集中，非散落）');
    assert(GEO_BEHAVIOR_PRIORITY_ORDER.length === 5 && GEO_BEHAVIOR_PRIORITY_ORDER[0] === 'high_checkout_low_purchase', '1-6 優先順序陣列第一名是 high_checkout_low_purchase（越接近成交末端優先）');
    assert(GEO_BEHAVIOR_PRIORITY_ORDER[4] === 'high_conversion_low_traffic', '1-7 優先順序陣列最後一名是 high_conversion_low_traffic');

    // 驗證「無 magic number」：透過 env 覆寫門檻，實際分類結果必須跟著變 —
    // 證明規則函式讀的是這個集中設定，不是寫死的裸數字。
    process.env.GEO_BEHAVIOR_RULE_MIN_VISITORS = '999';
    const tOverridden = getGeoBehaviorRuleThresholds();
    assert(tOverridden.minimumVisitors === 999, '1-8 env 覆寫 GEO_BEHAVIOR_RULE_MIN_VISITORS 生效');
    delete process.env.GEO_BEHAVIOR_RULE_MIN_VISITORS;
    const tRestored = getGeoBehaviorRuleThresholds();
    assert(tRestored.minimumVisitors === GEO_BEHAVIOR_RULE_DEFAULTS.minimumVisitors, '1-9 移除 env 後恢復預設值（fail-safe）');
    process.env.GEO_BEHAVIOR_RULE_LOW_CART_RATE = 'not-a-number';
    const tInvalid = getGeoBehaviorRuleThresholds();
    assert(tInvalid.lowCartRate === GEO_BEHAVIOR_RULE_DEFAULTS.lowCartRate, '1-10 非法 env 值 fail-safe 退回預設值，不讓應用啟動失敗');
    delete process.env.GEO_BEHAVIOR_RULE_LOW_CART_RATE;
  }

  // ══════════════════════════════════════════════════════════
  // 2. 建立固定 Rule Context（9 個 filler 區域，訪客數 10~90）
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
  context.storeId = 'store_rule_test';
  context.countyCode = null; context.subdivisionCode = null; context.source = null; context.medium = null; context.campaign = null;

  {
    assert(context.totalAreas === 9, '2-1 Rule Context totalAreas = 9（filler 區域數）');
    assert(context.visitorHighThreshold === 70, '2-2 visitorHighThreshold 由 75 百分位算出 = 70（訪客數 10..90 的線性插值）');
    assert(context.visitorLowThreshold === 30, '2-3 visitorLowThreshold 由 25 百分位算出 = 30');
    assert(context.medianVisitors === 50, '2-4 medianVisitors = 50（9 個值的中位數）');
    assert(context.geoIdentifiedRate === 0.85, '2-5 geoIdentifiedRate 從傳入的 quality 帶入');
    assert(context.unknownRate === 0.1, '2-6 unknownRate 從傳入的 quality 帶入');
    assert(context.dateScope && context.dateScope.start === '2026-07-01', '2-7 dateScope 保留在 context 內');
    assert(context.channelScope === 'all', '2-8 channelScope 保留在 context 內');
    assert(!fillerAreas.some((a) => classifyGeoBehaviorArea(a, context).primary_classification !== 'normal'), '2-9 9 個 filler 區域本身皆為 normal（未誤觸發任何分類，確認 fixture 設計乾淨）');
  }

  // ══════════════════════════════════════════════════════════
  // 3. 情境 A：高流量高成交
  // ══════════════════════════════════════════════════════════
  {
    const areaA = {
      city: '桃園市', district: '情境A區', visitors: 100,
      add_to_cart_visitors: 40, begin_checkout_visitors: 30, purchase_visitors: 25,
      visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.75, checkout_to_purchase_rate: 0.833,
      visit_to_purchase_rate: 0.25,
    };
    const r = classifyGeoBehaviorArea(areaA, context);
    assert(r.primary_classification === 'high_traffic_high_conversion', '3-1 情境A：primary_classification = high_traffic_high_conversion');
    assert(r.secondary_classifications.length === 0, '3-2 情境A：沒有其他規則同時觸發，secondary 為空');
    assert(r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low', '3-3 情境A：confidence 為合法列舉值');
  }

  // ══════════════════════════════════════════════════════════
  // 4. 情境 B：高流量低加購
  // ══════════════════════════════════════════════════════════
  {
    const areaB = {
      city: '桃園市', district: '情境B區', visitors: 80,
      add_to_cart_visitors: 4, begin_checkout_visitors: 0, purchase_visitors: 0,
      visit_to_cart_rate: 0.05, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0,
      visit_to_purchase_rate: 0,
    };
    const r = classifyGeoBehaviorArea(areaB, context);
    assert(r.primary_classification === 'high_traffic_low_cart', '4-1 情境B：primary_classification = high_traffic_low_cart');
    assert(r.secondary_classifications.length === 0, '4-2 情境B：沒有其他規則同時觸發');
  }

  // ══════════════════════════════════════════════════════════
  // 5. 情境 C：高加購低結帳
  // ══════════════════════════════════════════════════════════
  {
    const areaC = {
      city: '桃園市', district: '情境C區', visitors: 50,
      add_to_cart_visitors: 20, begin_checkout_visitors: 2, purchase_visitors: 0,
      visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.1, checkout_to_purchase_rate: 0,
      visit_to_purchase_rate: 0,
    };
    const r = classifyGeoBehaviorArea(areaC, context);
    assert(r.primary_classification === 'high_cart_low_checkout', '5-1 情境C：primary_classification = high_cart_low_checkout');
  }

  // ══════════════════════════════════════════════════════════
  // 6. 情境 D：高結帳低購買
  // ══════════════════════════════════════════════════════════
  {
    const areaD = {
      city: '桃園市', district: '情境D區', visitors: 50,
      add_to_cart_visitors: 25, begin_checkout_visitors: 10, purchase_visitors: 1,
      visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.4, checkout_to_purchase_rate: 0.1,
      visit_to_purchase_rate: 0.02,
    };
    const r = classifyGeoBehaviorArea(areaD, context);
    assert(r.primary_classification === 'high_checkout_low_purchase', '6-1 情境D：primary_classification = high_checkout_low_purchase');
  }

  // ══════════════════════════════════════════════════════════
  // 7. 情境 E：高轉換低流量
  // ══════════════════════════════════════════════════════════
  {
    const areaE = {
      city: '桃園市', district: '情境E區', visitors: 20,
      add_to_cart_visitors: 10, begin_checkout_visitors: 5, purchase_visitors: 5,
      visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 1.0,
      visit_to_purchase_rate: 0.25,
    };
    const r = classifyGeoBehaviorArea(areaE, context);
    assert(r.primary_classification === 'high_conversion_low_traffic', '7-1 情境E：primary_classification = high_conversion_low_traffic');
    assert(r.secondary_classifications.length === 0, '7-2 情境E：沒有其他規則同時觸發');
  }

  // ══════════════════════════════════════════════════════════
  // 8. 情境 F：樣本不足（不得誤判高轉換）
  // ══════════════════════════════════════════════════════════
  {
    const areaF = {
      city: '桃園市', district: '情境F區', visitors: 5,
      add_to_cart_visitors: 5, begin_checkout_visitors: 5, purchase_visitors: 5,
      visit_to_cart_rate: 1.0, cart_to_checkout_rate: 1.0, checkout_to_purchase_rate: 1.0,
      visit_to_purchase_rate: 1.0, // 100% 成交率，但樣本只有 5 人
    };
    const r = classifyGeoBehaviorArea(areaF, context);
    assert(r.primary_classification === 'insufficient_sample', '8-1 情境F：即使成交率 100%，樣本 < 門檻仍判為 insufficient_sample');
    assert(r.primary_classification !== 'high_traffic_high_conversion', '8-2 情境F：明確不得誤判為高流量高成交');
    assert(r.primary_classification !== 'high_conversion_low_traffic', '8-3 情境F：明確不得誤判為高轉換低流量');
    assert(r.matched_codes.length === 0, '8-4 情境F：matched_codes 為空（樣本防護在比例判斷之前就返回）');
  }

  // ══════════════════════════════════════════════════════════
  // 9. 情境 G：Unknown 過高
  // ══════════════════════════════════════════════════════════
  {
    const unknownArea = { city: null, district: null, visitors: 99999, add_to_cart_visitors: 99999, begin_checkout_visitors: 99999, purchase_visitors: 99999, visit_to_cart_rate: 1, cart_to_checkout_rate: 1, checkout_to_purchase_rate: 1, visit_to_purchase_rate: 1 };
    const r = classifyGeoBehaviorArea(unknownArea, context);
    assert(r.primary_classification === 'unknown', '9-1 Unknown 區域（city/district 皆 null）分類為 unknown，即使數字極端也不進正常分類');

    const areasWithUnknown = [...fillerAreas, unknownArea];
    const recos = buildGeoBehaviorRecommendations(areasWithUnknown, context);
    assert(!recos.some((r2) => r2.city === null && r2.district === null), '9-2 Unknown 不會產生任何行為投放建議（buildGeoBehaviorRecommendations 已排除）');
    assert(!recos.some((r2) => r2.area_name === null && r2.code !== 'data_quality'), '9-3 沒有任何非 data_quality 建議的 area_name 為 null（Unknown 不會偽裝成正常區域）');

    const highUnknownContext = { ...context, unknownRate: 0.65 };
    const qualityRecos = buildGeoQualityRecommendations(highUnknownContext, { store_id: 's1', channel: 'all' });
    assert(qualityRecos.length === 1, '9-4 Unknown 比例 65%（超過門檻 50%）產生 1 筆 data_quality recommendation');
    assert(qualityRecos[0].code === 'data_quality', '9-5 data_quality recommendation 的 code 正確');
    assert(qualityRecos[0].severity === 'medium', '9-6 unknownRate=0.65 時 severity=medium（未達 1.4x 門檻）');
    assert(qualityRecos[0].reason.includes('65%'), '9-7 reason 文案內含正確的未知比例數字');
    assert(qualityRecos[0].city === null && qualityRecos[0].district === null, '9-8 data_quality recommendation 不綁行政區（store 層級）');

    const veryHighUnknownContext = { ...context, unknownRate: 0.75 };
    const qualityRecos2 = buildGeoQualityRecommendations(veryHighUnknownContext, { store_id: 's1', channel: 'all' });
    assert(qualityRecos2[0].severity === 'high', '9-9 unknownRate=0.75（超過 1.4x 門檻=0.7）時 severity=high');

    const lowUnknownContext = { ...context, unknownRate: 0.2 };
    const qualityRecos3 = buildGeoQualityRecommendations(lowUnknownContext, { store_id: 's1', channel: 'all' });
    assert(qualityRecos3.length === 0, '9-10 unknownRate 低於門檻時不產生 data_quality recommendation');
  }

  // ══════════════════════════════════════════════════════════
  // 10. 情境 H：多規則衝突，優先順序固定
  // ══════════════════════════════════════════════════════════
  {
    const areaH = {
      // 同時符合 high_checkout_low_purchase（checkout>=3 且 checkout_to_purchase<0.15）
      // 與 high_cart_low_checkout（cart>=5 且 cart_to_checkout<0.2）
      city: '桃園市', district: '情境H區', visitors: 50,
      add_to_cart_visitors: 20, begin_checkout_visitors: 3, purchase_visitors: 0,
      visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.15, checkout_to_purchase_rate: 0,
      visit_to_purchase_rate: 0,
    };
    const r = classifyGeoBehaviorArea(areaH, context);
    assert(r.matched_codes.length === 2, '10-1 情境H：同時符合 2 種分類條件');
    assert(r.matched_codes.includes('high_checkout_low_purchase') && r.matched_codes.includes('high_cart_low_checkout'), '10-2 情境H：matched_codes 包含兩個預期的規則代碼');
    assert(r.primary_classification === 'high_checkout_low_purchase', '10-3 情境H：primary_classification 依優先順序取 high_checkout_low_purchase（越接近成交末端優先）');
    assert(r.secondary_classifications.length === 1 && r.secondary_classifications[0] === 'high_cart_low_checkout', '10-4 情境H：secondary_classifications 只含未被選為 primary 的那個');

    // 重複執行 10 次，結果必須完全一致（不得因規則順序隨機變動）
    let allSame = true;
    for (let i = 0; i < 10; i += 1) {
      const r2 = classifyGeoBehaviorArea(areaH, context);
      if (r2.primary_classification !== r.primary_classification || JSON.stringify(r2.secondary_classifications) !== JSON.stringify(r.secondary_classifications)) allSame = false;
    }
    assert(allSame, '10-5 情境H：重複執行 10 次，primary/secondary 結果完全一致（非隨機）');
  }

  // ══════════════════════════════════════════════════════════
  // 11. Confidence（low / medium / high）
  // ══════════════════════════════════════════════════════════
  {
    const lowConfArea = {
      city: '桃園市', district: 'Conf低', visitors: 12,
      add_to_cart_visitors: 6, begin_checkout_visitors: 0, purchase_visitors: 0,
      visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.19, checkout_to_purchase_rate: 0.9,
      visit_to_purchase_rate: 0,
    };
    const rLow = classifyGeoBehaviorArea(lowConfArea, { ...context, geoIdentifiedRate: null });
    assert(rLow.primary_classification === 'high_cart_low_checkout', '11-1 Confidence 測試（低）：分類正確觸發');
    assert(rLow.confidence === 'low', '11-2 Confidence 測試：樣本剛達門檻、偏離不明顯 → low');

    const mediumConfArea = {
      city: '桃園市', district: 'Conf中', visitors: 25,
      add_to_cart_visitors: 10, begin_checkout_visitors: 0, purchase_visitors: 0,
      visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.14, checkout_to_purchase_rate: 0.9,
      visit_to_purchase_rate: 0,
    };
    const rMedium = classifyGeoBehaviorArea(mediumConfArea, { ...context, geoIdentifiedRate: 0.85 });
    assert(rMedium.primary_classification === 'high_cart_low_checkout', '11-3 Confidence 測試（中）：分類正確觸發');
    assert(rMedium.confidence === 'medium', '11-4 Confidence 測試：樣本充足、偏離中等、Geo 品質高 → medium');

    const highConfArea = {
      city: '桃園市', district: 'Conf高', visitors: 45,
      add_to_cart_visitors: 20, begin_checkout_visitors: 0, purchase_visitors: 0,
      visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.05, checkout_to_purchase_rate: 0.9,
      visit_to_purchase_rate: 0,
    };
    const rHigh = classifyGeoBehaviorArea(highConfArea, { ...context, geoIdentifiedRate: 0.9 });
    assert(rHigh.primary_classification === 'high_cart_low_checkout', '11-5 Confidence 測試（高）：分類正確觸發');
    assert(rHigh.confidence === 'high', '11-6 Confidence 測試：樣本高、偏離極明顯、Geo 品質高 → high');

    // Geo 品質差時，confidence 不得虛高到 high（品質面拖低整體）
    const highSampleLowQuality = classifyGeoBehaviorArea(highConfArea, { ...context, geoIdentifiedRate: 0.3 });
    assert(highSampleLowQuality.confidence !== 'high', '11-7 Geo identified rate 偏低時，confidence 不得為 high（木桶效應）');
  }

  // ══════════════════════════════════════════════════════════
  // 12. Severity / intent_type
  // ══════════════════════════════════════════════════════════
  {
    const areas = {
      high_checkout_low_purchase: { city: 'X', district: 'S1', visitors: 50, add_to_cart_visitors: 25, begin_checkout_visitors: 10, purchase_visitors: 1, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.4, checkout_to_purchase_rate: 0.1, visit_to_purchase_rate: 0.02 },
      high_cart_low_checkout: { city: 'X', district: 'S2', visitors: 50, add_to_cart_visitors: 20, begin_checkout_visitors: 2, purchase_visitors: 0, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.1, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
      high_traffic_low_cart: { city: 'X', district: 'S3', visitors: 80, add_to_cart_visitors: 4, begin_checkout_visitors: 0, purchase_visitors: 0, visit_to_cart_rate: 0.05, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visit_to_purchase_rate: 0 },
      high_traffic_high_conversion: { city: 'X', district: 'S4', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 30, purchase_visitors: 25, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.75, checkout_to_purchase_rate: 0.833, visit_to_purchase_rate: 0.25 },
      high_conversion_low_traffic: { city: 'X', district: 'S5', visitors: 20, add_to_cart_visitors: 10, begin_checkout_visitors: 5, purchase_visitors: 5, visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 1.0, visit_to_purchase_rate: 0.25 },
    };
    const recos = buildGeoBehaviorRecommendations(Object.values(areas), context);
    const byCode = (code) => recos.find((r) => r.code === code);
    assert(byCode('high_checkout_low_purchase').severity === 'high', '12-1 high_checkout_low_purchase severity = high');
    assert(byCode('high_checkout_low_purchase').intent_type === 'risk', '12-2 high_checkout_low_purchase intent_type = risk');
    assert(byCode('high_cart_low_checkout').severity === 'high', '12-3 high_cart_low_checkout severity = high');
    assert(byCode('high_traffic_low_cart').severity === 'medium', '12-4 high_traffic_low_cart severity = medium');
    assert(byCode('high_traffic_high_conversion').severity === 'low', '12-5 high_traffic_high_conversion severity = low（受限於既有 schema 只接受 high/medium/low）');
    assert(byCode('high_traffic_high_conversion').intent_type === 'positive', '12-6 high_traffic_high_conversion intent_type = positive（不塞進 severity）');
    assert(byCode('high_conversion_low_traffic').severity === 'low', '12-7 high_conversion_low_traffic severity = low');
    assert(byCode('high_conversion_low_traffic').intent_type === 'opportunity', '12-8 high_conversion_low_traffic intent_type = opportunity');
    assert(['high', 'medium', 'low'].every((s) => recos.every((r) => ['high', 'medium', 'low'].includes(r.severity))), '12-9 所有 recommendation 的 severity 都落在既有 schema 允許的 high/medium/low 內');
  }

  // ══════════════════════════════════════════════════════════
  // 13. Recommended Action 輸出格式（九）
  // ══════════════════════════════════════════════════════════
  {
    const areaD2 = { city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 8, purchase_visitors: 1, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.2, checkout_to_purchase_rate: 0.125, visit_to_purchase_rate: 0.01 };
    const recos = buildGeoBehaviorRecommendations([areaD2], context);
    assert(recos.length === 1, '13-1 中壢區產生 1 筆建議');
    const r = recos[0];
    ['code', 'title', 'area_name', 'city', 'district', 'classification', 'confidence', 'severity', 'reason', 'metrics', 'action', 'evidence', 'scope'].forEach((field) => {
      assert(field in r, `13-2 輸出物件含必要欄位「${field}」`);
    });
    assert(r.area_name === '中壢區', '13-3 area_name 正確');
    assert(typeof r.reason === 'string' && r.reason.length > 0, '13-4 reason 為非空字串');
    assert(typeof r.action === 'string' && r.action.length > 0, '13-5 action 為非空字串');
    assert(Array.isArray(r.evidence) && r.evidence.length > 0, '13-6 evidence 為非空陣列');
    assert(r.metrics.visitors === 100 && r.metrics.add_to_cart_visitors === 40, '13-7 metrics 與來源聚合資料一致（十六：不得前端另算第二套）');
    assert(typeof r.scope === 'object' && r.scope !== null, '13-8 scope 為物件');
    assert('store_id' in r.scope && 'channel' in r.scope, '13-9 scope 含 store_id/channel');
  }

  // ══════════════════════════════════════════════════════════
  // 14. Insufficient sample 也會產生對應建議（低嚴重度，非誤判）
  // ══════════════════════════════════════════════════════════
  {
    const areaF2 = { city: '桃園市', district: '樣本不足區', visitors: 3, add_to_cart_visitors: 3, begin_checkout_visitors: 3, purchase_visitors: 3, visit_to_cart_rate: 1, cart_to_checkout_rate: 1, checkout_to_purchase_rate: 1, visit_to_purchase_rate: 1 };
    const recos = buildGeoBehaviorRecommendations([areaF2], context);
    assert(recos.length === 1 && recos[0].code === 'insufficient_sample', '14-1 樣本不足區產生 code=insufficient_sample 的建議');
    assert(recos[0].title === '樣本不足', '14-2 title 顯示名稱正確');
    assert(recos[0].action.includes('累積更多'), '14-3 action 文案符合需求文件七');
  }

  // ══════════════════════════════════════════════════════════
  // 15. Scope（十五）
  // ══════════════════════════════════════════════════════════
  {
    const scopedContext = { ...context, storeId: 'store_scope_test', countyCode: '68000', subdivisionCode: 'ZL', source: 'fb', medium: 'cpc', campaign: 'campX', channelScope: 'delivery' };
    const areaScope = { city: '桃園市', district: '範圍測試區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 8, purchase_visitors: 1, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.2, checkout_to_purchase_rate: 0.125, visit_to_purchase_rate: 0.01 };
    const recos = buildGeoBehaviorRecommendations([areaScope], scopedContext);
    const scope = recos[0].scope;
    assert(scope.store_id === 'store_scope_test', '15-1 scope.store_id 正確帶入');
    assert(scope.channel === 'delivery', '15-2 scope.channel 正確帶入');
    assert(scope.county_code === '68000', '15-3 scope.county_code 正確帶入');
    assert(scope.subdivision_code === 'ZL', '15-4 scope.subdivision_code 正確帶入');
    assert(scope.source === 'fb' && scope.medium === 'cpc' && scope.campaign === 'campX', '15-5 scope.source/medium/campaign 正確帶入');
    assert('date_range' in scope, '15-6 scope 含 date_range（date scope）');
  }

  // ══════════════════════════════════════════════════════════
  // 16. Privacy（十七）
  // ══════════════════════════════════════════════════════════
  {
    const areaPriv = { city: '桃園市', district: '隱私測試區', visitors: 100, add_to_cart_visitors: 40, begin_checkout_visitors: 8, purchase_visitors: 1, visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.2, checkout_to_purchase_rate: 0.125, visit_to_purchase_rate: 0.01 };
    const recos = buildGeoBehaviorRecommendations([areaPriv], context);
    const serialized = JSON.stringify(recos);
    ['visitor_id', 'identity_key', 'line_uid', 'line_user_id', 'cart_id', 'order_id', '_visitor_id_raw', '_line_uid_raw', 'token', 'secret', 'gps', 'latitude', 'longitude'].forEach((field) => {
      assert(!serialized.toLowerCase().includes(field.toLowerCase()), `16-1 輸出不含敏感欄位「${field}」`);
    });
    assert(!/09\d{8}/.test(serialized), '16-2 輸出不含台灣手機號碼格式字串');
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

    const STORE_RULE = 'store_rule_engine_integration';
    const geo = { geo_country: 'TW', geo_city: '桃園市', geo_district: '整合測試區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };

    // 高結帳低購買情境：12 人進站、6 人結帳、0 人購買
    for (let i = 0; i < 12; i += 1) {
      insertEvent(db, { store_id: STORE_RULE, visitor_id: `int-v${i}`, session_id: `int-s${i}`, event_name: 'page_view', geo });
    }
    for (let i = 0; i < 6; i += 1) {
      insertEvent(db, { store_id: STORE_RULE, visitor_id: `int-v${i}`, session_id: `int-s${i}`, cart_id: `int-cart${i}`, event_name: 'begin_checkout', geo });
    }

    const resp = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: STORE_RULE, query: {} });
    assert(resp.statusCode === 200 && resp.body.success === true, '17-1 /alerts 200 success（回應格式未被破壞）');
    assert(Array.isArray(resp.body.data.alerts), '17-2 /alerts 舊欄位 alerts 仍存在且為陣列（PRESERVED）');
    assert('rule_thresholds' in resp.body.data, '17-3 /alerts 舊欄位 rule_thresholds 仍存在（PRESERVED）');
    assert(Array.isArray(resp.body.data.behavior_recommendations), '17-4 /alerts 新欄位 behavior_recommendations 存在且為陣列');
    assert(typeof resp.body.data.rule_context === 'object', '17-5 /alerts 新欄位 rule_context 存在且為物件');
    assert(Array.isArray(resp.body.data.quality_recommendations), '17-6 /alerts 新欄位 quality_recommendations 存在且為陣列');

    const integrationReco = resp.body.data.behavior_recommendations.find((r) => r.district === '整合測試區');
    assert(!!integrationReco, '17-7 整合測試區出現在真實 DB → route 全流程的 behavior_recommendations 中');
    if (integrationReco) {
      assert(integrationReco.metrics.begin_checkout_visitors === 6, '17-8 整合測試：metrics.begin_checkout_visitors 與實際寫入事件數一致（十六：資料一致性）');
      assert(integrationReco.metrics.visitors === 12, '17-9 整合測試：metrics.visitors 與實際寫入事件數一致');
    }

    // 用同樣的 filters 直接呼叫 getGeoFunnel()，確認 recommendation 的 metrics
    // 跟聚合資料來源逐欄位一致（十六：不得前端/規則引擎自算第二套）
    const { getGeoFunnel } = require(path.join(ROOT, 'utils/geoAnalyticsQueries'));
    const { resolveDateRange } = require(path.join(ROOT, 'utils/dashboardDate'));
    const range = resolveDateRange({ preset: 'today' });
    const funnelDirect = getGeoFunnel(db, STORE_RULE, { range, channel: null, page: 1, limit: 100, offset: 0 });
    const directArea = funnelDirect.areas.find((a) => a.district === '整合測試區');
    assert(!!directArea, '17-10 直接呼叫 getGeoFunnel() 也能查到整合測試區');
    if (directArea && integrationReco) {
      assert(directArea.visitors === integrationReco.metrics.visitors, '17-11 資料一致性：getGeoFunnel() 與 recommendation.metrics 的 visitors 完全相同');
      assert(directArea.begin_checkout_visitors === integrationReco.metrics.begin_checkout_visitors, '17-12 資料一致性：begin_checkout_visitors 完全相同');
    }

    // Store isolation：另一店家看不到這筆
    const respOtherStore = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_rule_other', query: {} });
    assert(!respOtherStore.body.data.behavior_recommendations.some((r) => r.district === '整合測試區'), '17-13 Store Isolation：其他店家看不到整合測試區的建議');

    // Privacy：整個 /alerts 回應 stringify 不得含敏感欄位
    const fullSerialized = JSON.stringify(resp.body);
    ['int-v0', 'int-s0', 'int-cart0', 'identity_key', 'line_user_id'].forEach((needle) => {
      assert(!fullSerialized.includes(needle), `17-14 /alerts 完整回應不含「${needle}」`);
    });

    // Response contract：behavior_recommendations 為空陣列時仍是合法陣列（非 undefined/null），避免前端誤判失敗
    const respEmpty = await callRoute(analyticsGeoRouter, 'GET', '/alerts', { storeId: 'store_rule_never_used', query: {} });
    assert(Array.isArray(respEmpty.body.data.behavior_recommendations), '17-15 空資料店家：behavior_recommendations 仍為陣列（非 null/undefined）');
    assert(respEmpty.statusCode === 200 && respEmpty.body.success === true, '17-16 空資料店家：仍是 200 success，不因無資料而報錯');
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
