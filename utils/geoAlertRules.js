// utils/geoAlertRules.js — fix18-10-hotfix30-B5-R5.1-B
// 集中解析高流量低轉換等警示門檻，env 可覆寫，非法值一律 fail-safe 退回預設值，
// 絕不因為設定錯誤讓應用啟動失敗（十六、Geo Alerts 要求）。

'use strict';

const DEFAULTS = Object.freeze({
  GEO_ALERT_MIN_VISITORS: 20,
  GEO_ALERT_LOW_CART_RATE: 0.10,
  GEO_ALERT_LOW_ORDER_RATE: 0.02,
  GEO_ALERT_UNKNOWN_RATE: 0.40,
});

function _num(raw, fallback, { min = null, max = null, isInt = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (isInt && !Number.isInteger(n)) return fallback;
  if (min !== null && n < min) return fallback;
  if (max !== null && n > max) return fallback;
  return n;
}

function getGeoAlertRules() {
  return {
    // 最低樣本數：至少 1（防止 0 或負數造成任何區域都觸發警示）
    GEO_ALERT_MIN_VISITORS: _num(process.env.GEO_ALERT_MIN_VISITORS, DEFAULTS.GEO_ALERT_MIN_VISITORS, { min: 1, isInt: true }),
    // 比例限制在 0～1
    GEO_ALERT_LOW_CART_RATE: _num(process.env.GEO_ALERT_LOW_CART_RATE, DEFAULTS.GEO_ALERT_LOW_CART_RATE, { min: 0, max: 1 }),
    GEO_ALERT_LOW_ORDER_RATE: _num(process.env.GEO_ALERT_LOW_ORDER_RATE, DEFAULTS.GEO_ALERT_LOW_ORDER_RATE, { min: 0, max: 1 }),
    GEO_ALERT_UNKNOWN_RATE: _num(process.env.GEO_ALERT_UNKNOWN_RATE, DEFAULTS.GEO_ALERT_UNKNOWN_RATE, { min: 0, max: 1 }),
  };
}

// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.2-B1-4：Geo 行為規則引擎（三、集中式規則設定）
//
// 這一整段跟上面既有的 GEO_ALERT_* 系列（traffic_waste/checkout_drop/
// delivery_cost_risk/out_of_range_demand/data_quality）刻意分開、不共用
// 同一組門檻——上面那組是 getGeoAlerts() 既有的 5 種 alert，這裡是全新的
// 「行政區意圖分類＋Recommended Actions」，兩套規則語意不同（見 CHANGELOG
// Known Difference），不得混成同一份設定物件，也不改既有 alert 的名稱/門檻。
// ════════════════════════════════════════════════════════════════
const GEO_BEHAVIOR_RULE_DEFAULTS = Object.freeze({
  // 樣本數防護（需求文件七）：任何分類前，樣本未達下列門檻一律
  // classification='insufficient_sample'，不得因為比例極端（例如 1 人買 1 次
  // = 100%）就誤判成 high_traffic_high_conversion。
  minimumVisitors: 10,
  minimumCartVisitors: 5,
  minimumCheckoutVisitors: 3,
  minimumPurchaseVisitors: 1,

  // 高/低流量用「全體行政區訪客數分布」的百分位判定，不是單一裸數字
  // （見需求文件三：不得直接寫 0.3/0.5/10 等裸數字，門檻本身可以是常數，
  // 但用在哪個分布、如何比較，一律透過 buildGeoBehaviorRuleContext() 算好
  // 的 context 決定，規則函式不重算）。
  highTrafficPercentile: 0.75,
  lowTrafficPercentile: 0.25,

  highViewRate: 0.6,
  lowViewRate: 0.25,

  highCartRate: 0.35,
  lowCartRate: 0.1,

  highCheckoutRate: 0.45,
  lowCheckoutRate: 0.2,

  highPurchaseRate: 0.4,
  lowPurchaseRate: 0.15,

  highOverallConversionRate: 0.2,
  lowOverallConversionRate: 0.05,

  // Unknown 比例過高時觸發 data_quality recommendation（需求文件八）
  lowGeoConfidenceRate: 0.5,

  // Confidence 判定（需求文件十）：樣本量相對 minimumVisitors 的倍數、
  // 偏離門檻的比例、Geo identified rate 門檻，全部集中在這裡，規則函式
  // 只讀這些值，不自己寫死倍數。
  confidenceSampleMediumMultiplier: 2, // 樣本 >= minimumVisitors * 2 → 樣本面達 medium
  confidenceSampleHighMultiplier: 4, // 樣本 >= minimumVisitors * 4 → 樣本面達 high
  confidenceDeviationMediumRatio: 1.3, // 偏離門檻 >= 門檻值 * 1.3（或 <= 門檻值 / 1.3）→ 偏離面達 medium
  confidenceDeviationHighRatio: 1.8, // 偏離門檻 >= 門檻值 * 1.8（或 <= 門檻值 / 1.8）→ 偏離面達 high
  confidenceGeoIdentifiedRateHigh: 0.7, // Geo identified rate >= 0.7 才算「高品質資料」，否則 confidence 最高只到 medium

  // fix18-10-hotfix30-B5-R5.2-B1-4.5（需求文件十：confidence score → level 映射，
  // 集中管理，不得散落）——score < scoreMediumThreshold → low；
  // scoreMediumThreshold <= score < scoreHighThreshold → medium；
  // score >= scoreHighThreshold → high。
  confidenceScoreMediumThreshold: 50,
  confidenceScoreHighThreshold: 80,
  // 三個子分數（樣本/偏離/品質）用固定 anchor 分數代表 low/medium/high 三個
  // bucket，跟既有 _computeConfidence() 的離散判斷完全對應（同輸入同輸出，
  // 不改變既有 confidence 字串結果，只是把「為什麼」量化成分數，見
  // CHANGELOG Known Design：分數本身是 anchor，不是連續內插，避免改變既有
  // 已被 regression 驗證過的 low/medium/high 判定邊界）。
  confidenceAnchorLow: 35,
  confidenceAnchorMedium: 65,
  confidenceAnchorHigh: 90,
  // consistency_score 用「同時符合幾種分類」懲罰：符合越多種，代表訊號越
  // 不單純，consistency 越低。
  confidenceConsistencyPenaltyPerConflict: 25,
  confidenceConsistencyFloor: 35,
});

function _numRule(raw, fallback, { min = null, max = null } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (min !== null && n < min) return fallback;
  if (max !== null && n > max) return fallback;
  return n;
}

// env 覆寫入口（跟上面 getGeoAlertRules() 同一個 fail-safe 原則：非法值一律
// 退回預設值，不讓應用啟動失敗）。GEO_BEHAVIOR_RULE_* 是獨立的環境變數
// namespace，不跟 GEO_ALERT_* 共用鍵名。
function getGeoBehaviorRuleThresholds() {
  const d = GEO_BEHAVIOR_RULE_DEFAULTS;
  return {
    minimumVisitors: _numRule(process.env.GEO_BEHAVIOR_RULE_MIN_VISITORS, d.minimumVisitors, { min: 1 }),
    minimumCartVisitors: _numRule(process.env.GEO_BEHAVIOR_RULE_MIN_CART_VISITORS, d.minimumCartVisitors, { min: 0 }),
    minimumCheckoutVisitors: _numRule(process.env.GEO_BEHAVIOR_RULE_MIN_CHECKOUT_VISITORS, d.minimumCheckoutVisitors, { min: 0 }),
    minimumPurchaseVisitors: _numRule(process.env.GEO_BEHAVIOR_RULE_MIN_PURCHASE_VISITORS, d.minimumPurchaseVisitors, { min: 0 }),
    highTrafficPercentile: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_TRAFFIC_PCTL, d.highTrafficPercentile, { min: 0, max: 1 }),
    lowTrafficPercentile: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_TRAFFIC_PCTL, d.lowTrafficPercentile, { min: 0, max: 1 }),
    highViewRate: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_VIEW_RATE, d.highViewRate, { min: 0, max: 1 }),
    lowViewRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_VIEW_RATE, d.lowViewRate, { min: 0, max: 1 }),
    highCartRate: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_CART_RATE, d.highCartRate, { min: 0, max: 1 }),
    lowCartRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_CART_RATE, d.lowCartRate, { min: 0, max: 1 }),
    highCheckoutRate: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_CHECKOUT_RATE, d.highCheckoutRate, { min: 0, max: 1 }),
    lowCheckoutRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_CHECKOUT_RATE, d.lowCheckoutRate, { min: 0, max: 1 }),
    highPurchaseRate: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_PURCHASE_RATE, d.highPurchaseRate, { min: 0, max: 1 }),
    lowPurchaseRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_PURCHASE_RATE, d.lowPurchaseRate, { min: 0, max: 1 }),
    highOverallConversionRate: _numRule(process.env.GEO_BEHAVIOR_RULE_HIGH_OVERALL_RATE, d.highOverallConversionRate, { min: 0, max: 1 }),
    lowOverallConversionRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_OVERALL_RATE, d.lowOverallConversionRate, { min: 0, max: 1 }),
    lowGeoConfidenceRate: _numRule(process.env.GEO_BEHAVIOR_RULE_LOW_GEO_CONFIDENCE_RATE, d.lowGeoConfidenceRate, { min: 0, max: 1 }),
    confidenceSampleMediumMultiplier: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_SAMPLE_MEDIUM_MULT, d.confidenceSampleMediumMultiplier, { min: 1 }),
    confidenceSampleHighMultiplier: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_SAMPLE_HIGH_MULT, d.confidenceSampleHighMultiplier, { min: 1 }),
    confidenceDeviationMediumRatio: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_DEV_MEDIUM_RATIO, d.confidenceDeviationMediumRatio, { min: 1 }),
    confidenceDeviationHighRatio: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_DEV_HIGH_RATIO, d.confidenceDeviationHighRatio, { min: 1 }),
    confidenceGeoIdentifiedRateHigh: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_GEO_ID_RATE_HIGH, d.confidenceGeoIdentifiedRateHigh, { min: 0, max: 1 }),
    confidenceScoreMediumThreshold: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_SCORE_MEDIUM, d.confidenceScoreMediumThreshold, { min: 0, max: 100 }),
    confidenceScoreHighThreshold: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_SCORE_HIGH, d.confidenceScoreHighThreshold, { min: 0, max: 100 }),
    confidenceAnchorLow: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_ANCHOR_LOW, d.confidenceAnchorLow, { min: 0, max: 100 }),
    confidenceAnchorMedium: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_ANCHOR_MEDIUM, d.confidenceAnchorMedium, { min: 0, max: 100 }),
    confidenceAnchorHigh: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_ANCHOR_HIGH, d.confidenceAnchorHigh, { min: 0, max: 100 }),
    confidenceConsistencyPenaltyPerConflict: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_CONSISTENCY_PENALTY, d.confidenceConsistencyPenaltyPerConflict, { min: 0, max: 100 }),
    confidenceConsistencyFloor: _numRule(process.env.GEO_BEHAVIOR_RULE_CONF_CONSISTENCY_FLOOR, d.confidenceConsistencyFloor, { min: 0, max: 100 }),
  };
}

// ── 分類代碼／顯示名稱／固定優先順序（需求文件五、六）─────────────────
// 陣列順序即優先順序：越前面代表「越接近成交末端的漏損」，同一區域符合多個
// 條件時，優先順序在前的當 primary_classification，其餘進 secondary。
// 這是唯一一份順序定義，分類函式與測試都讀這裡，不得各自硬寫一份。
const GEO_BEHAVIOR_CLASSIFICATIONS = Object.freeze([
  { code: 'high_checkout_low_purchase', title: '高結帳低購買', severity: 'high', intent_type: 'risk' },
  { code: 'high_cart_low_checkout', title: '高加購低結帳', severity: 'high', intent_type: 'risk' },
  { code: 'high_traffic_low_cart', title: '高流量低加購', severity: 'medium', intent_type: 'risk' },
  { code: 'high_traffic_high_conversion', title: '高流量高成交', severity: 'low', intent_type: 'positive' },
  { code: 'high_conversion_low_traffic', title: '高轉換低流量', severity: 'low', intent_type: 'opportunity' },
]);
const GEO_BEHAVIOR_PRIORITY_ORDER = Object.freeze(GEO_BEHAVIOR_CLASSIFICATIONS.map((c) => c.code));
function _classificationMeta(code) {
  return GEO_BEHAVIOR_CLASSIFICATIONS.find((c) => c.code === code) || null;
}

function _rateSafe(n, d) {
  const num = Number(n) || 0;
  const den = Number(d) || 0;
  if (den <= 0) return 0;
  const r = num / den;
  return Number.isFinite(r) ? r : 0;
}

function _isUnknownArea(area) {
  return !area || (area.city === null || area.city === undefined) && (area.district === null || area.district === undefined);
}

// 百分位數（線性插值，n<=1 時直接回該值，不做插值）——只用於「全體行政區
// 訪客數分布」，供 buildGeoBehaviorRuleContext() 一次算好存進 context，
// 分類函式本身不重算分布，避免每個區域各自重新排序整個陣列（十二、統一
// Rule Context 原則）。
function _percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
function _median(sortedAsc) { return _percentile(sortedAsc, 0.5); }

// ════════════════════════════════════════════════════════════════
// 需求文件十二：統一 Rule Context——所有規則共用同一份橫向統計，不得各自
// 重算不同口徑。輸入是 getGeoFunnel() 的 areas 陣列（已排除 Unknown，
// Unknown 不應影響中位數/百分位，見需求文件八：Unknown 不得成為 Top1，
// 這裡進一步確保它連「拉低中位數」都不允許）。
// ════════════════════════════════════════════════════════════════
function buildGeoBehaviorRuleContext(areas, { quality = null, dateScope = null, channelScope = null } = {}) {
  const known = (areas || []).filter((a) => !_isUnknownArea(a));
  const visitorsList = known.map((a) => Number(a.visitors) || 0).sort((a, b) => a - b);
  const cartList = known.map((a) => Number(a.add_to_cart_visitors) || 0).sort((a, b) => a - b);
  const checkoutList = known.map((a) => Number(a.begin_checkout_visitors) || 0).sort((a, b) => a - b);
  const purchaseList = known.map((a) => Number(a.purchase_visitors) || 0).sort((a, b) => a - b);

  const totalVisitors = known.reduce((s, a) => s + (Number(a.visitors) || 0), 0);
  const totalPurchase = known.reduce((s, a) => s + (Number(a.purchase_visitors) || 0), 0);
  const averageConversionRate = _rateSafe(totalPurchase, totalVisitors);

  const thresholds = getGeoBehaviorRuleThresholds();
  const geoIdentifiedRate = quality ? (Number(quality.identified_rate) || 0) : null;
  const unknownRate = quality ? (Number(quality.unknown_rate) || 0) : null;

  // fix18-10-hotfix30-B5-R5.2-B1-4.5（需求文件十六）：全店「各階段轉換率」
  // 平均值——用來讓 metric_comparisons 支援「vs store average」。用同一批
  // known areas 現算平均，不另查 DB（十八：規則引擎只吃聚合結果）。分母為
  // 0（例如某店完全沒有 known area）一律回 0，不產生 NaN。
  const _avg = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0);
  const avgVisitToCartRate = _avg(known.map((a) => Number(a.visit_to_cart_rate) || 0));
  const avgCartToCheckoutRate = _avg(known.map((a) => Number(a.cart_to_checkout_rate) || 0));
  const avgCheckoutToPurchaseRate = _avg(known.map((a) => Number(a.checkout_to_purchase_rate) || 0));
  const avgVisitToPurchaseRate = _avg(known.map((a) => Number(a.visit_to_purchase_rate) || 0));

  const visitorHighThreshold = _percentile(visitorsList, thresholds.highTrafficPercentile);
  const visitorLowThreshold = _percentile(visitorsList, thresholds.lowTrafficPercentile);
  const medianVisitors = _median(visitorsList);
  const medianCartVisitors = _median(cartList);
  const medianCheckoutVisitors = _median(checkoutList);
  const medianPurchaseVisitors = _median(purchaseList);

  const context = {
    totalAreas: known.length,
    totalAreasIncludingUnknown: (areas || []).length,
    medianVisitors,
    medianCartVisitors,
    medianCheckoutVisitors,
    medianPurchaseVisitors,
    averageConversionRate,
    geoIdentifiedRate,
    unknownRate,
    dateScope,
    channelScope,
    // 百分位門檻現算一次存起來，分類函式直接讀，不重算分布
    visitorHighThreshold,
    visitorLowThreshold,
    thresholds,
    // 新增：各階段全店平均轉換率（供 metric_comparisons「vs store average」使用）
    averageVisitToCartRate: avgVisitToCartRate,
    averageCartToCheckoutRate: avgCartToCheckoutRate,
    averageCheckoutToPurchaseRate: avgCheckoutToPurchaseRate,
    averageVisitToPurchaseRate: avgVisitToPurchaseRate,
  };

  // fix18-10-hotfix30-B5-R5.2-B1-4.5（需求文件十六：Rule Context
  // Explainability）——additive 巢狀分組，完全不動上面既有的扁平欄位
  // （既有呼叫端／測試讀的是扁平欄位，這裡只是「多加一份分組好的視圖」，
  // 方便 explanation 函式與未來 Dashboard 一次性讀取，不含任何個資，只有
  // 聚合數字/門檻/範圍）。
  context.medians = {
    visitors: medianVisitors, cart_visitors: medianCartVisitors,
    checkout_visitors: medianCheckoutVisitors, purchase_visitors: medianPurchaseVisitors,
  };
  context.averages = {
    conversion_rate: averageConversionRate,
    visit_to_cart_rate: avgVisitToCartRate,
    cart_to_checkout_rate: avgCartToCheckoutRate,
    checkout_to_purchase_rate: avgCheckoutToPurchaseRate,
    visit_to_purchase_rate: avgVisitToPurchaseRate,
  };
  context.percentiles = {
    visitor_high_threshold: visitorHighThreshold,
    visitor_low_threshold: visitorLowThreshold,
    high_percentile: thresholds.highTrafficPercentile,
    low_percentile: thresholds.lowTrafficPercentile,
  };
  context.confidence_thresholds = {
    sample_medium_multiplier: thresholds.confidenceSampleMediumMultiplier,
    sample_high_multiplier: thresholds.confidenceSampleHighMultiplier,
    deviation_medium_ratio: thresholds.confidenceDeviationMediumRatio,
    deviation_high_ratio: thresholds.confidenceDeviationHighRatio,
    geo_identified_rate_high: thresholds.confidenceGeoIdentifiedRateHigh,
    score_medium_threshold: thresholds.confidenceScoreMediumThreshold,
    score_high_threshold: thresholds.confidenceScoreHighThreshold,
  };
  context.sample_thresholds = {
    minimum_visitors: thresholds.minimumVisitors,
    minimum_cart_visitors: thresholds.minimumCartVisitors,
    minimum_checkout_visitors: thresholds.minimumCheckoutVisitors,
    minimum_purchase_visitors: thresholds.minimumPurchaseVisitors,
  };
  context.geo_quality = {
    identified_rate: geoIdentifiedRate,
    unknown_rate: unknownRate,
    low_confidence_rate_threshold: thresholds.lowGeoConfidenceRate,
  };
  context.scope = { date_range: dateScope, channel: channelScope };

  return context;
}

// ════════════════════════════════════════════════════════════════
// 需求文件四、五、六、七、八、十：單一行政區分類 + Confidence + Severity。
// area 形狀取自 getGeoFunnel() 的 areas[]（visitors/add_to_cart_visitors/
// begin_checkout_visitors/purchase_visitors/visit_to_cart_rate/
// cart_to_checkout_rate/checkout_to_purchase_rate/visit_to_purchase_rate/
// city/district），context 來自 buildGeoBehaviorRuleContext()。本函式只讀
// 聚合結果，不查 DB、不重算已經在 Phase 1.1 算好的 rate（十三）。
// ════════════════════════════════════════════════════════════════
function classifyGeoBehaviorArea(area, context) {
  if (!area) return { classification: 'unknown', primary_classification: 'unknown', secondary_classifications: [], confidence: 'low', matched_codes: [] };

  if (_isUnknownArea(area)) {
    // 需求文件八：Unknown 不得進入正常分類，不得成為 Top1，不得產生投放建議
    return { classification: 'unknown', primary_classification: 'unknown', secondary_classifications: [], confidence: 'low', matched_codes: [] };
  }

  const t = context.thresholds;
  const visitors = Number(area.visitors) || 0;
  const cartVisitors = Number(area.add_to_cart_visitors) || 0;
  const checkoutVisitors = Number(area.begin_checkout_visitors) || 0;
  const purchaseVisitors = Number(area.purchase_visitors) || 0;
  const visitToCartRate = Number(area.visit_to_cart_rate) || 0;
  const cartToCheckoutRate = Number(area.cart_to_checkout_rate) || 0;
  const checkoutToPurchaseRate = Number(area.checkout_to_purchase_rate) || 0;
  const visitToPurchaseRate = Number(area.visit_to_purchase_rate) || 0;

  // 需求文件七：樣本數防護，優先於任何比例判斷
  if (visitors < t.minimumVisitors) {
    return {
      classification: 'insufficient_sample', primary_classification: 'insufficient_sample',
      secondary_classifications: [], confidence: 'low', matched_codes: [],
    };
  }

  const isHighTraffic = visitors >= context.visitorHighThreshold;
  const isLowTraffic = visitors <= context.visitorLowThreshold;

  const matched = [];
  // 順序依 GEO_BEHAVIOR_PRIORITY_ORDER（六、優先順序），逐一檢查是否符合
  if (checkoutVisitors >= t.minimumCheckoutVisitors && checkoutToPurchaseRate < t.lowPurchaseRate) {
    matched.push('high_checkout_low_purchase');
  }
  if (cartVisitors >= t.minimumCartVisitors && cartToCheckoutRate < t.lowCheckoutRate) {
    matched.push('high_cart_low_checkout');
  }
  if (isHighTraffic && visitToCartRate < t.lowCartRate) {
    matched.push('high_traffic_low_cart');
  }
  if (isHighTraffic && visitToPurchaseRate >= t.highOverallConversionRate && purchaseVisitors >= t.minimumPurchaseVisitors) {
    matched.push('high_traffic_high_conversion');
  }
  if (isLowTraffic && visitToPurchaseRate >= t.highOverallConversionRate && purchaseVisitors >= t.minimumPurchaseVisitors) {
    matched.push('high_conversion_low_traffic');
  }

  if (!matched.length) {
    return { classification: 'normal', primary_classification: 'normal', secondary_classifications: [], confidence: 'low', matched_codes: [] };
  }

  // 固定優先順序排序（六：不得因規則順序不同而隨機變動——排序鍵完全來自
  // GEO_BEHAVIOR_PRIORITY_ORDER 的 index，同輸入永遠同輸出）
  matched.sort((a, b) => GEO_BEHAVIOR_PRIORITY_ORDER.indexOf(a) - GEO_BEHAVIOR_PRIORITY_ORDER.indexOf(b));
  const primary = matched[0];
  const secondary = matched.slice(1);

  const confidence = _computeConfidence({ primary, visitors, visitToCartRate, cartToCheckoutRate, checkoutToPurchaseRate, visitToPurchaseRate }, context);

  return {
    classification: primary,
    primary_classification: primary,
    secondary_classifications: secondary,
    confidence,
    matched_codes: matched,
  };
}

// 需求文件十：Confidence = 樣本面 × 偏離面 × Geo 品質面，三者取最低的一個
// （木桶效應：任一面不足，整體 confidence 就不能虛高）。門檻全部讀
// context.thresholds，函式本身不寫裸數字。
//
// fix18-10-hotfix30-B5-R5.2-B1-4.5：抽出 _confidenceLevels() 共用計算，
// _computeConfidence()（既有，回傳字串，被 classifyGeoBehaviorArea() 使用）
// 與新的 buildConfidenceBreakdown()（回傳結構化分數）共用同一份判斷邏輯，
// 保證兩者對同一組輸入永遠得出一致的 low/medium/high，不會出現「breakdown
// 說 medium，但 confidence 欄位是 high」這種不一致。
function _confidenceLevels(metrics, context) {
  const t = context.thresholds;
  const { primary, visitors } = metrics;

  // 樣本面
  let sampleLevel = 'low';
  if (visitors >= t.minimumVisitors * t.confidenceSampleHighMultiplier) sampleLevel = 'high';
  else if (visitors >= t.minimumVisitors * t.confidenceSampleMediumMultiplier) sampleLevel = 'medium';

  // 偏離面：偏離對應門檻越遠，confidence 越高
  let deviationLevel = 'low';
  let deviationRatio = null; // null = 沒有對應規則（例如 primary 不在對照表內），breakdown 用來安全顯示 "—"
  const rateForCode = {
    high_checkout_low_purchase: { value: metrics.checkoutToPurchaseRate, threshold: t.lowPurchaseRate, direction: 'below' },
    high_cart_low_checkout: { value: metrics.cartToCheckoutRate, threshold: t.lowCheckoutRate, direction: 'below' },
    high_traffic_low_cart: { value: metrics.visitToCartRate, threshold: t.lowCartRate, direction: 'below' },
    high_traffic_high_conversion: { value: metrics.visitToPurchaseRate, threshold: t.highOverallConversionRate, direction: 'above' },
    high_conversion_low_traffic: { value: metrics.visitToPurchaseRate, threshold: t.highOverallConversionRate, direction: 'above' },
  }[primary];
  if (rateForCode && rateForCode.threshold > 0) {
    const ratio = rateForCode.direction === 'below'
      ? (rateForCode.value > 0 ? rateForCode.threshold / rateForCode.value : Infinity) // 值越小，門檻/值 越大 → 偏離越遠
      : (rateForCode.value / rateForCode.threshold); // 值越大，值/門檻 越大 → 偏離越遠
    if (Number.isFinite(ratio)) {
      deviationRatio = ratio;
      if (ratio >= t.confidenceDeviationHighRatio) deviationLevel = 'high';
      else if (ratio >= t.confidenceDeviationMediumRatio) deviationLevel = 'medium';
    } else {
      deviationLevel = 'high'; // 分母為 0（例如加購率剛好 0）視為極端偏離
      deviationRatio = null; // Infinity 不得輸出，breakdown 顯示時一律用 null 代表「無法計算比例，但已知為極端」
    }
  }

  // Geo 品質面：identified_rate 未知時視為 medium（不假設好也不假設壞）
  let qualityLevel = 'medium';
  if (context.geoIdentifiedRate !== null && context.geoIdentifiedRate !== undefined) {
    qualityLevel = context.geoIdentifiedRate >= t.confidenceGeoIdentifiedRateHigh ? 'high' : 'medium';
  }

  return { sampleLevel, deviationLevel, qualityLevel, deviationRatio };
}

function _computeConfidence(metrics, context) {
  const { sampleLevel, deviationLevel, qualityLevel } = _confidenceLevels(metrics, context);
  const RANK = { low: 0, medium: 1, high: 2 };
  const minRank = Math.min(RANK[sampleLevel], RANK[deviationLevel], RANK[qualityLevel]);
  return Object.keys(RANK).find((k) => RANK[k] === minRank);
}

// ════════════════════════════════════════════════════════════════
// 需求文件十：Confidence Breakdown——把上面的離散判斷量化成 0–100 分數。
// 三個子分數用固定 anchor（low/medium/high bucket 對應 anchor 分數，見
// GEO_BEHAVIOR_RULE_DEFAULTS.confidenceAnchor*），overall score 取三者
// （加上 consistency）最小值，保證跟 _computeConfidence() 的字串結果
// 100% 一致（同一份 _confidenceLevels() 來源）。consistency_score 是
// 額外的第四個面向（同時符合幾種分類，越多越不單純），不在原本三面之內，
// 但同樣納入 min() 一起決定 final_level，避免「明明有規則衝突，還說信心
// 很高」這種矛盾。
// ════════════════════════════════════════════════════════════════
function _anchorScore(level, t) {
  return { low: t.confidenceAnchorLow, medium: t.confidenceAnchorMedium, high: t.confidenceAnchorHigh }[level];
}
function _scoreToLevel(score, t) {
  if (score >= t.confidenceScoreHighThreshold) return 'high';
  if (score >= t.confidenceScoreMediumThreshold) return 'medium';
  return 'low';
}
function buildConfidenceBreakdown(primary, metrics, context) {
  const t = context.thresholds;
  const { sampleLevel, deviationLevel, qualityLevel, deviationRatio } = _confidenceLevels({ ...metrics, primary }, context);

  const sampleScore = _anchorScore(sampleLevel, t);
  const thresholdDistanceScore = _anchorScore(deviationLevel, t);
  const geoQualityScore = _anchorScore(qualityLevel, t);

  const conflictCount = Math.max(0, (metrics.matchedCount || 1) - 1);
  const consistencyScore = Math.max(t.confidenceConsistencyFloor, 100 - conflictCount * t.confidenceConsistencyPenaltyPerConflict);

  const score = Math.round(Math.min(sampleScore, thresholdDistanceScore, geoQualityScore, consistencyScore));
  const finalLevel = _scoreToLevel(score, t);

  const reasons = [];
  reasons.push(sampleLevel === 'high' ? '樣本數充足' : (sampleLevel === 'medium' ? '樣本數尚可，未達充裕水準' : '樣本數剛達最低門檻，判定較保守'));
  reasons.push(qualityLevel === 'high' ? 'Geo 辨識率良好' : 'Geo 辨識率一般或未知，判定較保守');
  if (deviationRatio !== null && Number.isFinite(deviationRatio)) {
    reasons.push(deviationLevel === 'high' ? '轉換率偏離門檻幅度明顯' : (deviationLevel === 'medium' ? '轉換率偏離門檻幅度中等' : '轉換率剛超過門檻，偏離幅度不大'));
  } else if (deviationLevel === 'high') {
    reasons.push('轉換率為極端值（例如恰好 0），偏離門檻幅度視為明顯');
  }
  if (conflictCount > 0) reasons.push(`同時符合 ${conflictCount + 1} 種分類條件，判定一致性較低`);
  else reasons.push('僅符合 1 種分類條件，判定一致性高');

  return {
    final_level: finalLevel,
    score,
    sample_score: sampleScore,
    geo_quality_score: geoQualityScore,
    threshold_distance_score: thresholdDistanceScore,
    consistency_score: consistencyScore,
    reasons,
  };
}

// ════════════════════════════════════════════════════════════════
// 需求文件十九：穩定性——所有輸出必須能安全 JSON.stringify()，不得出現
// undefined/NaN/Infinity/-Infinity/function。以下工具函式集中處理數值
//安全轉換，explanation 相關函式一律透過這裡輸出數字，不直接吐原始值。
// ════════════════════════════════════════════════════════════════
function _safeNum(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}
function _round(n, digits = 4) {
  const v = _safeNum(n, 0);
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
// 分母為 0（或非有限值）一律回 null，不得回 NaN/Infinity（需求文件九）
function _safeRatio(numerator, denominator) {
  const n = _safeNum(numerator, null);
  const d = _safeNum(denominator, null);
  if (n === null || d === null || d === 0) return null;
  const r = n / d;
  return Number.isFinite(r) ? _round(r, 4) : null;
}
function _pctPoint(a, b) {
  // 百分點差（僅適用於 0~1 比例型指標），輸入非有限值一律回 null
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return null;
  return _round((Number(a) - Number(b)) * 100, 2);
}

// ════════════════════════════════════════════════════════════════
// 需求文件八：Threshold Hits——每個 matched code 對應到實際命中的門檻比較，
// margin 一律以「passed 時為正」的方向計算（'<'/'<=' → threshold-actual；
// '>'/'>=' → actual-threshold），不得只回傳規則名稱。
// ════════════════════════════════════════════════════════════════
function _thresholdHit({ rule_key, metric, operator, threshold, actual, unit = 'rate', messageWhenPassed, messageWhenFailed }) {
  const t = _safeNum(threshold, 0);
  const a = _safeNum(actual, 0);
  let passed;
  let margin;
  if (operator === '<') { passed = a < t; margin = _round(t - a); }
  else if (operator === '<=') { passed = a <= t; margin = _round(t - a); }
  else if (operator === '>') { passed = a > t; margin = _round(a - t); }
  else { passed = a >= t; margin = _round(a - t); } // 預設 '>='
  return {
    rule_key, metric, operator, threshold: _round(t), actual: _round(a), passed,
    margin,
    message: passed ? (messageWhenPassed || `${metric} 符合門檻條件`) : (messageWhenFailed || `${metric} 未達門檻條件`),
  };
}

function buildThresholdHits(primary, matchedCodes, metrics, context) {
  const t = context.thresholds;
  const hits = [];
  const pct = (r) => `${Math.round(_safeNum(r) * 100)}%`;
  const codesToExplain = [...new Set([primary, ...(matchedCodes || [])])].filter(Boolean);

  codesToExplain.forEach((code) => {
    if (code === 'high_checkout_low_purchase') {
      hits.push(_thresholdHit({
        rule_key: 'min_checkout_sample', metric: 'begin_checkout_visitors', operator: '>=',
        threshold: t.minimumCheckoutVisitors, actual: metrics.checkoutVisitors, unit: 'people',
        messageWhenPassed: `開始結帳 ${metrics.checkoutVisitors} 人，達最低樣本門檻 ${t.minimumCheckoutVisitors} 人`,
        messageWhenFailed: `開始結帳 ${metrics.checkoutVisitors} 人，未達最低樣本門檻 ${t.minimumCheckoutVisitors} 人`,
      }));
      hits.push(_thresholdHit({
        rule_key: 'low_purchase_rate', metric: 'checkout_to_purchase_rate', operator: '<',
        threshold: t.lowPurchaseRate, actual: metrics.checkoutToPurchaseRate, unit: 'rate',
        messageWhenPassed: `結帳到購買轉換率 ${pct(metrics.checkoutToPurchaseRate)}，低於低購買率門檻 ${pct(t.lowPurchaseRate)}`,
        messageWhenFailed: `結帳到購買轉換率 ${pct(metrics.checkoutToPurchaseRate)}，未低於門檻 ${pct(t.lowPurchaseRate)}`,
      }));
    } else if (code === 'high_cart_low_checkout') {
      hits.push(_thresholdHit({
        rule_key: 'min_cart_sample', metric: 'add_to_cart_visitors', operator: '>=',
        threshold: t.minimumCartVisitors, actual: metrics.cartVisitors, unit: 'people',
        messageWhenPassed: `加入購物車 ${metrics.cartVisitors} 人，達最低樣本門檻 ${t.minimumCartVisitors} 人`,
        messageWhenFailed: `加入購物車 ${metrics.cartVisitors} 人，未達最低樣本門檻 ${t.minimumCartVisitors} 人`,
      }));
      hits.push(_thresholdHit({
        rule_key: 'low_checkout_rate', metric: 'cart_to_checkout_rate', operator: '<',
        threshold: t.lowCheckoutRate, actual: metrics.cartToCheckoutRate, unit: 'rate',
        messageWhenPassed: `加購到結帳轉換率 ${pct(metrics.cartToCheckoutRate)}，低於低結帳率門檻 ${pct(t.lowCheckoutRate)}`,
        messageWhenFailed: `加購到結帳轉換率 ${pct(metrics.cartToCheckoutRate)}，未低於門檻 ${pct(t.lowCheckoutRate)}`,
      }));
    } else if (code === 'high_traffic_low_cart') {
      hits.push(_thresholdHit({
        rule_key: 'high_traffic', metric: 'visitors', operator: '>=',
        threshold: context.visitorHighThreshold, actual: metrics.visitors, unit: 'people',
        messageWhenPassed: `訪客 ${metrics.visitors} 人，達高流量門檻（第 ${Math.round(t.highTrafficPercentile * 100)} 百分位 ${_round(context.visitorHighThreshold, 1)} 人）`,
        messageWhenFailed: `訪客 ${metrics.visitors} 人，未達高流量門檻 ${_round(context.visitorHighThreshold, 1)} 人`,
      }));
      hits.push(_thresholdHit({
        rule_key: 'low_cart_rate', metric: 'visit_to_cart_rate', operator: '<',
        threshold: t.lowCartRate, actual: metrics.visitToCartRate, unit: 'rate',
        messageWhenPassed: `訪客到加購轉換率 ${pct(metrics.visitToCartRate)}，低於低加購率門檻 ${pct(t.lowCartRate)}`,
        messageWhenFailed: `訪客到加購轉換率 ${pct(metrics.visitToCartRate)}，未低於門檻 ${pct(t.lowCartRate)}`,
      }));
    } else if (code === 'high_traffic_high_conversion') {
      hits.push(_thresholdHit({
        rule_key: 'high_traffic', metric: 'visitors', operator: '>=',
        threshold: context.visitorHighThreshold, actual: metrics.visitors, unit: 'people',
        messageWhenPassed: `訪客 ${metrics.visitors} 人，達高流量門檻 ${_round(context.visitorHighThreshold, 1)} 人`,
        messageWhenFailed: `訪客 ${metrics.visitors} 人，未達高流量門檻 ${_round(context.visitorHighThreshold, 1)} 人`,
      }));
      hits.push(_thresholdHit({
        rule_key: 'high_overall_conversion', metric: 'visit_to_purchase_rate', operator: '>=',
        threshold: t.highOverallConversionRate, actual: metrics.visitToPurchaseRate, unit: 'rate',
        messageWhenPassed: `整體成交率 ${pct(metrics.visitToPurchaseRate)}，高於高成交率門檻 ${pct(t.highOverallConversionRate)}`,
        messageWhenFailed: `整體成交率 ${pct(metrics.visitToPurchaseRate)}，未達門檻 ${pct(t.highOverallConversionRate)}`,
      }));
    } else if (code === 'high_conversion_low_traffic') {
      hits.push(_thresholdHit({
        rule_key: 'low_traffic', metric: 'visitors', operator: '<=',
        threshold: context.visitorLowThreshold, actual: metrics.visitors, unit: 'people',
        messageWhenPassed: `訪客僅 ${metrics.visitors} 人，低於低流量門檻 ${_round(context.visitorLowThreshold, 1)} 人`,
        messageWhenFailed: `訪客 ${metrics.visitors} 人，並未低於低流量門檻 ${_round(context.visitorLowThreshold, 1)} 人`,
      }));
      hits.push(_thresholdHit({
        rule_key: 'high_overall_conversion', metric: 'visit_to_purchase_rate', operator: '>=',
        threshold: t.highOverallConversionRate, actual: metrics.visitToPurchaseRate, unit: 'rate',
        messageWhenPassed: `整體成交率 ${pct(metrics.visitToPurchaseRate)}，高於高成交率門檻 ${pct(t.highOverallConversionRate)}`,
        messageWhenFailed: `整體成交率 ${pct(metrics.visitToPurchaseRate)}，未達門檻 ${pct(t.highOverallConversionRate)}`,
      }));
    } else if (code === 'insufficient_sample') {
      hits.push(_thresholdHit({
        rule_key: 'minimum_visitors', metric: 'visitors', operator: '>=',
        threshold: t.minimumVisitors, actual: metrics.visitors, unit: 'people',
        messageWhenPassed: `訪客 ${metrics.visitors} 人，達最低判定門檻 ${t.minimumVisitors} 人`,
        messageWhenFailed: `訪客僅 ${metrics.visitors} 人，未達最低判定門檻 ${t.minimumVisitors} 人`,
      }));
    }
  });
  return hits;
}

// ════════════════════════════════════════════════════════════════
// 需求文件九：Metric Comparisons——支援 vs threshold／vs store average／
// vs median／vs percentile／vs previous funnel stage。分母為 0 一律
// ratio=null，不得出現 NaN/Infinity。
// ════════════════════════════════════════════════════════════════
function _comparison({ metric, actual, compare_to, benchmark, unit = 'rate', message }) {
  const a = _safeNum(actual, 0);
  const b = (benchmark === null || benchmark === undefined) ? null : _safeNum(benchmark, null);
  const absoluteDifference = b === null ? null : _round(a - b);
  const percentagePointDifference = (unit === 'rate' && b !== null) ? _pctPoint(a, b) : null;
  const ratio = _safeRatio(a, b);
  return {
    metric, actual: _round(a), compare_to, benchmark: b === null ? null : _round(b),
    absolute_difference: absoluteDifference,
    percentage_point_difference: percentagePointDifference,
    ratio,
    message: message || (b === null ? `${metric} 目前沒有可比較的基準值` : ''),
  };
}

function buildMetricComparisons(area, context, primary) {
  const visitors = _safeNum(area.visitors);
  const cartVisitors = _safeNum(area.add_to_cart_visitors);
  const checkoutVisitors = _safeNum(area.begin_checkout_visitors);
  const visitToCartRate = _safeNum(area.visit_to_cart_rate);
  const cartToCheckoutRate = _safeNum(area.cart_to_checkout_rate);
  const checkoutToPurchaseRate = _safeNum(area.checkout_to_purchase_rate);
  const visitToPurchaseRate = _safeNum(area.visit_to_purchase_rate);
  const pct = (r) => `${Math.round(_safeNum(r) * 100)}%`;

  const comparisons = [];

  // vs median（人數型指標）
  comparisons.push(_comparison({
    metric: 'visitors', actual: visitors, compare_to: 'median', benchmark: context.medianVisitors, unit: 'people',
    message: `訪客 ${visitors} 人，全體行政區中位數為 ${_round(context.medianVisitors, 1)} 人`,
  }));

  // vs percentile（訪客數高流量門檻）
  comparisons.push(_comparison({
    metric: 'visitors', actual: visitors, compare_to: 'percentile', benchmark: context.visitorHighThreshold, unit: 'people',
    message: `訪客 ${visitors} 人，高流量門檻（第 ${Math.round(context.thresholds.highTrafficPercentile * 100)} 百分位）為 ${_round(context.visitorHighThreshold, 1)} 人`,
  }));

  // vs previous funnel stage（加購人數 相對於 上一階段訪客人數，即
  // visit_to_cart_rate 的「階段對照」表達方式）
  comparisons.push(_comparison({
    metric: 'add_to_cart_visitors', actual: cartVisitors, compare_to: 'previous_funnel_stage', benchmark: visitors, unit: 'people',
    message: `加入購物車 ${cartVisitors} 人，相對於上一階段訪客 ${visitors} 人`,
  }));
  comparisons.push(_comparison({
    metric: 'begin_checkout_visitors', actual: checkoutVisitors, compare_to: 'previous_funnel_stage', benchmark: cartVisitors, unit: 'people',
    message: `開始結帳 ${checkoutVisitors} 人，相對於上一階段加購 ${cartVisitors} 人`,
  }));

  // vs store average（依 primary classification 挑出最相關的那個轉換率）
  const rateVsAverage = {
    high_checkout_low_purchase: { metric: 'checkout_to_purchase_rate', actual: checkoutToPurchaseRate, avg: context.averageCheckoutToPurchaseRate },
    high_cart_low_checkout: { metric: 'cart_to_checkout_rate', actual: cartToCheckoutRate, avg: context.averageCartToCheckoutRate },
    high_traffic_low_cart: { metric: 'visit_to_cart_rate', actual: visitToCartRate, avg: context.averageVisitToCartRate },
    high_traffic_high_conversion: { metric: 'visit_to_purchase_rate', actual: visitToPurchaseRate, avg: context.averageVisitToPurchaseRate },
    high_conversion_low_traffic: { metric: 'visit_to_purchase_rate', actual: visitToPurchaseRate, avg: context.averageVisitToPurchaseRate },
  }[primary];
  if (rateVsAverage) {
    comparisons.push(_comparison({
      metric: rateVsAverage.metric, actual: rateVsAverage.actual, compare_to: 'store_average', benchmark: rateVsAverage.avg, unit: 'rate',
      message: `${rateVsAverage.metric} 為 ${pct(rateVsAverage.actual)}，全店平均為 ${pct(rateVsAverage.avg)}`,
    }));
    // vs threshold（跟 store average 對照同一個指標，但基準換成規則門檻本身）
    const thresholdMap = {
      high_checkout_low_purchase: context.thresholds.lowPurchaseRate,
      high_cart_low_checkout: context.thresholds.lowCheckoutRate,
      high_traffic_low_cart: context.thresholds.lowCartRate,
      high_traffic_high_conversion: context.thresholds.highOverallConversionRate,
      high_conversion_low_traffic: context.thresholds.highOverallConversionRate,
    }[primary];
    comparisons.push(_comparison({
      metric: rateVsAverage.metric, actual: rateVsAverage.actual, compare_to: 'threshold', benchmark: thresholdMap, unit: 'rate',
      message: `${rateVsAverage.metric} 為 ${pct(rateVsAverage.actual)}，門檻為 ${pct(thresholdMap)}`,
    }));
  }

  return comparisons;
}

// ════════════════════════════════════════════════════════════════
// 需求文件十一：Sample Assessment
// ════════════════════════════════════════════════════════════════
function buildSampleAssessment(area, context, primary) {
  const t = context.thresholds;
  const visitors = _safeNum(area.visitors);

  // 依分類挑出「跟這個判斷最相關」的樣本階段（十一：relevant_stage_visitors）
  const stageMap = {
    high_checkout_low_purchase: { key: 'begin_checkout_visitors', minimum: t.minimumCheckoutVisitors },
    high_cart_low_checkout: { key: 'add_to_cart_visitors', minimum: t.minimumCartVisitors },
    high_traffic_low_cart: { key: 'visitors', minimum: t.minimumVisitors },
    high_traffic_high_conversion: { key: 'purchase_visitors', minimum: t.minimumPurchaseVisitors },
    high_conversion_low_traffic: { key: 'purchase_visitors', minimum: t.minimumPurchaseVisitors },
    insufficient_sample: { key: 'visitors', minimum: t.minimumVisitors },
  }[primary] || { key: 'visitors', minimum: t.minimumVisitors };

  const relevantStageVisitors = _safeNum(area[stageMap.key]);
  const minimumRequired = _safeNum(stageMap.minimum);
  const margin = _round(relevantStageVisitors - minimumRequired);

  let status = 'insufficient';
  if (relevantStageVisitors >= minimumRequired * t.confidenceSampleHighMultiplier) status = 'strong';
  else if (relevantStageVisitors >= minimumRequired * t.confidenceSampleMediumMultiplier) status = 'sufficient';
  else if (relevantStageVisitors >= minimumRequired) status = 'borderline';

  const STATUS_LABEL = { insufficient: '樣本不足', borderline: '樣本剛達門檻', sufficient: '樣本充足', strong: '樣本非常充足' };
  const message = `樣本數 ${relevantStageVisitors}，最低門檻 ${minimumRequired}，屬${STATUS_LABEL[status]}`;

  return {
    status, visitors, relevant_stage_visitors: relevantStageVisitors,
    minimum_required: minimumRequired, margin, message,
  };
}

// ════════════════════════════════════════════════════════════════
// 需求文件十二：Data Quality Assessment
// ════════════════════════════════════════════════════════════════
function buildDataQualityAssessment(context) {
  const t = context.thresholds;
  const identifiedRate = context.geoIdentifiedRate === null || context.geoIdentifiedRate === undefined ? null : _round(context.geoIdentifiedRate);
  const unknownRate = context.unknownRate === null || context.unknownRate === undefined ? null : _round(context.unknownRate);

  let qualityStatus = 'unknown';
  let confidenceImpact = 'neutral';
  let message = 'Geo 資料品質資訊目前無法取得。';

  if (unknownRate !== null) {
    if (unknownRate >= t.lowGeoConfidenceRate) {
      qualityStatus = 'poor';
      confidenceImpact = 'negative';
      message = `Geo 辨識率${identifiedRate !== null ? ` ${Math.round(identifiedRate * 100)}%` : ''}，未知比例 ${Math.round(unknownRate * 100)}%，資料品質偏低，對判定信心有負面影響。`;
    } else if (identifiedRate !== null && identifiedRate >= t.confidenceGeoIdentifiedRateHigh) {
      qualityStatus = 'good';
      confidenceImpact = 'positive';
      message = `Geo 辨識率 ${Math.round(identifiedRate * 100)}%，資料品質良好，對判定信心影響正向。`;
    } else {
      qualityStatus = 'fair';
      confidenceImpact = 'neutral';
      message = `Geo 辨識率${identifiedRate !== null ? ` ${Math.round(identifiedRate * 100)}%` : ''}，資料品質尚可，對判定信心影響中性。`;
    }
  }

  return {
    identified_rate: identifiedRate, unknown_rate: unknownRate,
    quality_status: qualityStatus, confidence_impact: confidenceImpact, message,
  };
}

// ════════════════════════════════════════════════════════════════
// 需求文件四：頂層組裝——每筆 behavior recommendation 附加的 explanation。
// 只讀 area（聚合資料）與 context（規則設定＋橫向統計），不查 DB，不含
// 任何個資（十七、十八）。
// ════════════════════════════════════════════════════════════════
function buildGeoRuleExplanation(area, context, result) {
  const primary = result.primary_classification;
  const metrics = {
    visitors: _safeNum(area.visitors),
    cartVisitors: _safeNum(area.add_to_cart_visitors),
    checkoutVisitors: _safeNum(area.begin_checkout_visitors),
    purchaseVisitors: _safeNum(area.purchase_visitors),
    visitToCartRate: _safeNum(area.visit_to_cart_rate),
    cartToCheckoutRate: _safeNum(area.cart_to_checkout_rate),
    checkoutToPurchaseRate: _safeNum(area.checkout_to_purchase_rate),
    visitToPurchaseRate: _safeNum(area.visit_to_purchase_rate),
    matchedCount: (result.matched_codes && result.matched_codes.length) || 1,
  };

  const areaName = area.district || area.city || '此區域';
  const pct = (r) => `${Math.round(_safeNum(r) * 100)}%`;

  const SUMMARY_BUILDERS = {
    high_checkout_low_purchase: () => `${areaName}開始結帳人數${metrics.checkoutVisitors}人，但結帳到購買轉換率僅 ${pct(metrics.checkoutToPurchaseRate)}，明顯低於門檻 ${pct(context.thresholds.lowPurchaseRate)}，因此判定為高結帳低購買。`,
    high_cart_low_checkout: () => `${areaName}加入購物車人數${metrics.cartVisitors}人，但開始結帳比例僅 ${pct(metrics.cartToCheckoutRate)}，明顯低於門檻 ${pct(context.thresholds.lowCheckoutRate)}，因此判定為高加購低結帳。`,
    high_traffic_low_cart: () => `${areaName}訪客數${metrics.visitors}人（高於全店高流量門檻），但加入購物車比例僅 ${pct(metrics.visitToCartRate)}，低於門檻 ${pct(context.thresholds.lowCartRate)}，因此判定為高流量低加購。`,
    high_traffic_high_conversion: () => `${areaName}訪客數${metrics.visitors}人（高於全店高流量門檻），整體成交率達 ${pct(metrics.visitToPurchaseRate)}，高於門檻 ${pct(context.thresholds.highOverallConversionRate)}，因此判定為高流量高成交。`,
    high_conversion_low_traffic: () => `${areaName}訪客僅${metrics.visitors}人（低於全店低流量門檻），但整體成交率達 ${pct(metrics.visitToPurchaseRate)}，高於門檻 ${pct(context.thresholds.highOverallConversionRate)}，因此判定為高轉換低流量。`,
    insufficient_sample: () => `${areaName}目前只有 ${metrics.visitors} 位訪客，低於最低判定門檻 ${context.thresholds.minimumVisitors} 位，因此不產生營運判斷。`,
    normal: () => `${areaName}目前各項指標皆落在正常區間，未觸發任何特殊分類。`,
    unknown: () => `此區域無法辨識行政區，不納入正常分類統計。`,
  };
  const summary = (SUMMARY_BUILDERS[primary] || SUMMARY_BUILDERS.normal)();

  const threshold_hits = buildThresholdHits(primary, result.matched_codes, metrics, context);
  const primary_reason_hit = threshold_hits[threshold_hits.length - 1] || null; // 最後一個通常是該分類的核心比例條件
  const primary_reason = primary_reason_hit ? {
    metric: primary_reason_hit.metric,
    actual_value: primary_reason_hit.actual,
    benchmark_type: 'threshold',
    benchmark_value: primary_reason_hit.threshold,
    difference: _round(primary_reason_hit.actual - primary_reason_hit.threshold),
    direction: primary_reason_hit.actual < primary_reason_hit.threshold ? 'below' : 'above',
    unit: primary_reason_hit.unit || 'rate',
    message: primary_reason_hit.message,
  } : {
    metric: 'visitors', actual_value: metrics.visitors, benchmark_type: 'threshold',
    benchmark_value: context.thresholds.minimumVisitors,
    difference: _round(metrics.visitors - context.thresholds.minimumVisitors),
    direction: metrics.visitors < context.thresholds.minimumVisitors ? 'below' : 'above',
    unit: 'people', message: summary,
  };

  const supporting_reasons = threshold_hits.slice(0, -1).map((hit) => ({
    metric: hit.metric, actual_value: hit.actual, benchmark_type: 'minimum_threshold',
    benchmark_value: hit.threshold, difference: _round(hit.actual - hit.threshold),
    direction: hit.actual >= hit.threshold ? 'above' : 'below', unit: hit.unit || 'people', message: hit.message,
  }));

  const metric_comparisons = (primary === 'unknown') ? [] : buildMetricComparisons(area, context, primary === 'insufficient_sample' || primary === 'normal' ? 'high_traffic_low_cart' : primary).filter(() => primary !== 'insufficient_sample' && primary !== 'normal');
  // insufficient_sample／normal 沒有明確的「主要規則」可對照 store average/threshold，
  // metric_comparisons 保留「vs median／vs percentile／vs previous funnel stage」
  // 這三個不依賴 primary 的比較，不做強行湊數。
  const genericComparisons = (primary === 'insufficient_sample' || primary === 'normal')
    ? buildMetricComparisons(area, context, 'high_cart_low_checkout').slice(0, 4)
    : metric_comparisons;

  const confidence_breakdown = (primary === 'unknown')
    ? { final_level: 'low', score: 0, sample_score: 0, geo_quality_score: 0, threshold_distance_score: 0, consistency_score: 0, reasons: ['Unknown 區域不進行信心評估'] }
    : buildConfidenceBreakdown(primary, metrics, context);

  const sample_assessment = buildSampleAssessment(area, context, primary);
  const data_quality_assessment = buildDataQualityAssessment(context);

  // 需求文件十四：insufficient_sample 額外要求 minimum_required/actual/shortfall
  if (primary === 'insufficient_sample') {
    sample_assessment.minimum_required = context.thresholds.minimumVisitors;
    sample_assessment.actual = metrics.visitors;
    sample_assessment.shortfall = Math.max(0, context.thresholds.minimumVisitors - metrics.visitors);
  }

  return {
    summary,
    primary_reason,
    supporting_reasons,
    threshold_hits,
    metric_comparisons: genericComparisons,
    confidence_breakdown,
    sample_assessment,
    data_quality_assessment,
  };
}

// 需求文件十五：Unknown／Data Quality 專用 explanation（store 層級，不綁區域）
function buildDataQualityExplanation(context) {
  const t = context.thresholds;
  const unknownRate = _safeNum(context.unknownRate, 0);
  const excess = _round(Math.max(0, unknownRate - t.lowGeoConfidenceRate));
  const summary = `未知區域比例為 ${Math.round(unknownRate * 100)}%，高於警戒門檻 ${Math.round(t.lowGeoConfidenceRate * 100)}%，超出 ${Math.round(excess * 100)} 個百分點。`;
  return {
    summary,
    primary_reason: {
      metric: 'unknown_rate', actual_value: _round(unknownRate), benchmark_type: 'threshold',
      benchmark_value: t.lowGeoConfidenceRate, difference: excess, direction: 'above', unit: 'rate', message: summary,
    },
    supporting_reasons: [],
    threshold_hits: [_thresholdHit({
      rule_key: 'low_geo_confidence_rate', metric: 'unknown_rate', operator: '>=',
      threshold: t.lowGeoConfidenceRate, actual: unknownRate, unit: 'rate',
      messageWhenPassed: summary, messageWhenFailed: '未知比例未超過警戒門檻',
    })],
    metric_comparisons: [_comparison({
      metric: 'unknown_rate', actual: unknownRate, compare_to: 'threshold', benchmark: t.lowGeoConfidenceRate, unit: 'rate',
      message: summary,
    })],
    confidence_breakdown: { final_level: 'medium', score: 50, sample_score: 50, geo_quality_score: 20, threshold_distance_score: 50, consistency_score: 100, reasons: ['Unknown 比例過高，資料品質判定信心受限'] },
    sample_assessment: { status: 'sufficient', visitors: null, relevant_stage_visitors: null, minimum_required: null, margin: null, message: '本項為店家層級資料品質判定，不綁單一行政區樣本' },
    data_quality_assessment: {
      ...buildDataQualityAssessment(context),
      excess,
      recommended_checks: ['Visitor IP Geo', 'GPS', '地址解析', 'geo_context 寫入流程'],
    },
  };
}
function _buildEvidence(code, area) {
  const v = Number(area.visitors) || 0;
  const cart = Number(area.add_to_cart_visitors) || 0;
  const checkout = Number(area.begin_checkout_visitors) || 0;
  const purchase = Number(area.purchase_visitors) || 0;
  const pct = (r) => `${Math.round((Number(r) || 0) * 100)}%`;
  switch (code) {
    case 'high_checkout_low_purchase':
      return [`開始結帳 ${checkout} 人`, `完成購買 ${purchase} 人`, `結帳到購買轉換率 ${pct(area.checkout_to_purchase_rate)}`];
    case 'high_cart_low_checkout':
      return [`加入購物車 ${cart} 人`, `開始結帳 ${checkout} 人`, `加購到結帳轉換率 ${pct(area.cart_to_checkout_rate)}`];
    case 'high_traffic_low_cart':
      return [`訪客 ${v} 人`, `加入購物車 ${cart} 人`, `訪客到加購轉換率 ${pct(area.visit_to_cart_rate)}`];
    case 'high_traffic_high_conversion':
      return [`訪客 ${v} 人`, `完成購買 ${purchase} 人`, `整體成交率 ${pct(area.visit_to_purchase_rate)}`];
    case 'high_conversion_low_traffic':
      return [`訪客僅 ${v} 人`, `完成購買 ${purchase} 人`, `整體成交率 ${pct(area.visit_to_purchase_rate)}`];
    default:
      return [];
  }
}
const GEO_BEHAVIOR_REASON = Object.freeze({
  high_checkout_low_purchase: '開始結帳人數高，但結帳到完成購買的比例偏低',
  high_cart_low_checkout: '加入購物車人數高，但加購到開始結帳的比例偏低',
  high_traffic_low_cart: '訪客數高，但加入購物車比例偏低',
  high_traffic_high_conversion: '訪客數高，且整體成交率也高',
  high_conversion_low_traffic: '整體成交率高，但訪客數偏低',
});
const GEO_BEHAVIOR_ACTION = Object.freeze({
  high_checkout_low_purchase: '檢查付款流程、外送費、最低金額、可用付款方式與登入阻力',
  high_cart_low_checkout: '檢查前往結帳入口、LINE Login、加入好友轉址與購物車操作流程',
  high_traffic_low_cart: '檢查商品頁、價格、主圖、商品說明與廣告素材是否一致',
  high_traffic_high_conversion: '目前該區域流量與成交表現都佳，建議維持投放，並測試小幅增加預算',
  high_conversion_low_traffic: '該區域成交效率佳但流量不足，可測試增加廣告曝光或擴大相似受眾',
  insufficient_sample: '目前資料量不足，建議累積更多訪客與訂單後再判斷',
  data_quality: '檢查 Visitor IP Geo、GPS、地址解析與 geo_context 寫入流程',
});

function _buildRecommendation(code, area, result, scope, context) {
  const meta = _classificationMeta(code);
  return {
    code,
    title: (meta && meta.title) || '樣本不足',
    area_name: area.district || area.city || null,
    city: area.city || null,
    district: area.district || null,
    classification: code,
    confidence: result.confidence,
    severity: (meta && meta.severity) || 'low',
    intent_type: (meta && meta.intent_type) || 'quality',
    reason: GEO_BEHAVIOR_REASON[code] || '目前資料量不足，暫不宜下判斷',
    metrics: {
      visitors: Number(area.visitors) || 0,
      add_to_cart_visitors: Number(area.add_to_cart_visitors) || 0,
      begin_checkout_visitors: Number(area.begin_checkout_visitors) || 0,
      purchase_visitors: Number(area.purchase_visitors) || 0,
      visit_to_cart_rate: Number(area.visit_to_cart_rate) || 0,
      cart_to_checkout_rate: Number(area.cart_to_checkout_rate) || 0,
      checkout_to_purchase_rate: Number(area.checkout_to_purchase_rate) || 0,
      visit_to_purchase_rate: Number(area.visit_to_purchase_rate) || 0,
    },
    action: GEO_BEHAVIOR_ACTION[code] || '',
    evidence: _buildEvidence(code, area),
    scope,
    // 需求文件六：非前端主要顯示欄位，但 Drawer 可用；只在 primary 本身的
    // 建議物件上附上，不重複產生第二筆建議。
    secondary_classifications: result.secondary_classifications || [],
    // fix18-10-hotfix30-B5-R5.2-B1-4.5（需求文件四）：additive 新增，不影響
    // 上面任何既有欄位。
    explanation: buildGeoRuleExplanation(area, context, result),
  };
}

// 需求文件四：批次版本，輸入行政區聚合陣列＋context，輸出 Recommended
// Actions（不含 Unknown、不含 insufficient_sample 以外的低樣本區域廣告
// 投放建議——見需求文件八）。
function buildGeoBehaviorRecommendations(areas, context) {
  const scope = {
    store_id: context.storeId || null,
    channel: context.channelScope || 'all',
    date_range: context.dateScope || null,
    county_code: context.countyCode || null,
    subdivision_code: context.subdivisionCode || null,
    source: context.source || null,
    medium: context.medium || null,
    campaign: context.campaign || null,
  };

  const recommendations = [];
  (areas || []).forEach((area) => {
    if (_isUnknownArea(area)) return; // 需求文件八：Unknown 不產生投放建議
    const result = classifyGeoBehaviorArea(area, context);
    if (result.primary_classification === 'unknown' || result.primary_classification === 'normal') return;
    recommendations.push(_buildRecommendation(result.primary_classification, area, result, scope, context));
  });

  // 穩定排序：severity(high>medium>low) → confidence(high>medium>low) →
  // area_name 字母序，不使用亂數，同輸入永遠同輸出（需求文件六）
  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  const CONF_RANK = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => {
    if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (CONF_RANK[a.confidence] !== CONF_RANK[b.confidence]) return CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    const an = a.area_name || '', bn = b.area_name || '';
    return an < bn ? -1 : (an > bn ? 1 : 0);
  });
  return recommendations;
}

// 需求文件八：Unknown 比例過高時的 data_quality recommendation（store 層級，
// 不綁行政區）。跟既有 getGeoAlerts() 的 data_quality alert 概念相近但輸出
// schema 不同（這裡走新規格的 Recommended Action 格式），兩者並存、不合併，
// 避免改動既有 alert 的既有格式。
function buildGeoQualityRecommendations(context, scope) {
  if (context.unknownRate === null || context.unknownRate === undefined) return [];
  if (context.unknownRate < context.thresholds.lowGeoConfidenceRate) return [];
  return [{
    code: 'data_quality',
    title: 'Geo 資料可信度偏低',
    area_name: null,
    city: null,
    district: null,
    classification: 'data_quality',
    confidence: 'medium',
    severity: context.unknownRate >= context.thresholds.lowGeoConfidenceRate * 1.4 ? 'high' : 'medium',
    intent_type: 'quality',
    reason: `未知區域比例 ${Math.round(context.unknownRate * 100)}%，Geo 資料可信度偏低`,
    metrics: { unknown_rate: context.unknownRate, geo_identified_rate: context.geoIdentifiedRate },
    action: GEO_BEHAVIOR_ACTION.data_quality,
    evidence: [`未知區域比例 ${Math.round(context.unknownRate * 100)}%`],
    scope,
    secondary_classifications: [],
    // fix18-10-hotfix30-B5-R5.2-B1-4.5（需求文件十五）：additive 新增
    explanation: buildDataQualityExplanation(context),
  }];
}

const GEO_EXPLAINABILITY_VERSION = '1.0';

module.exports = {
  getGeoAlertRules,
  DEFAULTS,
  GEO_BEHAVIOR_RULE_DEFAULTS,
  getGeoBehaviorRuleThresholds,
  GEO_BEHAVIOR_CLASSIFICATIONS,
  GEO_BEHAVIOR_PRIORITY_ORDER,
  buildGeoBehaviorRuleContext,
  classifyGeoBehaviorArea,
  buildGeoBehaviorRecommendations,
  buildGeoQualityRecommendations,
  // fix18-10-hotfix30-B5-R5.2-B1-4.5：Explainability Layer
  GEO_EXPLAINABILITY_VERSION,
  buildGeoRuleExplanation,
  buildDataQualityExplanation,
  buildThresholdHits,
  buildMetricComparisons,
  buildConfidenceBreakdown,
  buildSampleAssessment,
  buildDataQualityAssessment,
};
