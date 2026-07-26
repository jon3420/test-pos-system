// utils/geoRecommendationViewModel.js — fix18-10-hotfix30-B5-R5.2-B1-4.6
// Explainability API Stabilization：Dashboard-ready Recommendation ViewModel。
//
// 為什麼新增獨立檔案（需求文件十六）：utils/geoAlertRules.js 已經 1000+
// 行，專責「規則判斷 + Explainability」；這裡是純粹的「呈現層組裝」——
// 格式化字串、排序、ID 產生、ViewModel 結構包裝，跟規則判斷是完全不同的
// 關注點，混在一起會讓 geoAlertRules.js 更難維護。本檔案只讀
// utils/geoAlertRules.js 已經算好的 behavior_recommendations／
// quality_recommendations／rule_context，不重查 SQL、不重算 classification、
// 不重新產生 confidence（三之 3.2：Single source of truth）。

'use strict';

// ════════════════════════════════════════════════════════════════
// 二十、集中管理 Enum
// ════════════════════════════════════════════════════════════════
const GEO_INTENT_TYPE_VALUES = Object.freeze(['risk', 'quality', 'opportunity', 'positive']);
const GEO_SEVERITY_VALUES = Object.freeze(['high', 'medium', 'low']);
const GEO_CONFIDENCE_VALUES = Object.freeze(['low', 'medium', 'high']);
const GEO_SAMPLE_STATUS_VALUES = Object.freeze(['insufficient', 'borderline', 'sufficient', 'strong']);
const GEO_DIRECTION_VALUES = Object.freeze(['above', 'below', 'equal', 'unavailable']);

const SCHEMA_VERSION = '1.0';
const SORT_VERSION = '1.0';

// ════════════════════════════════════════════════════════════════
// 八、Badge 映射（集中管理，不得散落在 route）
// ════════════════════════════════════════════════════════════════
const GEO_BADGE_MAP = Object.freeze({
  high_traffic_high_conversion: '表現良好',
  high_traffic_low_cart: '商品吸引力',
  high_cart_low_checkout: '結帳入口',
  high_checkout_low_purchase: '付款流失',
  high_conversion_low_traffic: '成長機會',
  insufficient_sample: '資料不足',
  data_quality: '資料品質',
});

// ════════════════════════════════════════════════════════════════
// 十、Primary Metric 映射（集中管理，不由前端自行決定）
// ════════════════════════════════════════════════════════════════
const GEO_METRIC_LABELS = Object.freeze({
  visitors: '訪客人數',
  add_to_cart_visitors: '加入購物車人數',
  begin_checkout_visitors: '開始結帳人數',
  purchase_visitors: '完成購買人數',
  visit_to_cart_rate: '訪客到加購轉換率',
  cart_to_checkout_rate: '加購到結帳轉換率',
  checkout_to_purchase_rate: '結帳到購買轉換率',
  visit_to_purchase_rate: '整體成交率',
  unknown_rate: '未知區域比例',
  geo_identified_rate: 'Geo 辨識率',
});
const GEO_METRIC_UNITS = Object.freeze({
  visitors: 'people', add_to_cart_visitors: 'people', begin_checkout_visitors: 'people', purchase_visitors: 'people',
  visit_to_cart_rate: 'rate', cart_to_checkout_rate: 'rate', checkout_to_purchase_rate: 'rate', visit_to_purchase_rate: 'rate',
  unknown_rate: 'rate', geo_identified_rate: 'rate',
});
const GEO_PRIMARY_METRIC_MAP = Object.freeze({
  high_traffic_high_conversion: 'visit_to_purchase_rate',
  high_traffic_low_cart: 'visit_to_cart_rate',
  high_cart_low_checkout: 'cart_to_checkout_rate',
  high_checkout_low_purchase: 'checkout_to_purchase_rate',
  high_conversion_low_traffic: 'visit_to_purchase_rate',
  insufficient_sample: 'visitors',
  data_quality: 'unknown_rate',
});

// Recommended Action 分類（十一：category）
const GEO_ACTION_CATEGORY_MAP = Object.freeze({
  high_traffic_high_conversion: 'budget',
  high_traffic_low_cart: 'product_page',
  high_cart_low_checkout: 'checkout_flow',
  high_checkout_low_purchase: 'payment_flow',
  high_conversion_low_traffic: 'budget',
  insufficient_sample: 'data_quality',
  data_quality: 'data_quality',
});

const BENCHMARK_TYPE_LABELS = Object.freeze({
  threshold: '門檻',
  minimum_threshold: '最低門檻',
  store_average: '全店平均',
  median: '中位數',
  percentile: '百分位門檻',
  previous_funnel_stage: '上一階段',
});
const SAMPLE_STATUS_LABELS = Object.freeze({
  insufficient: '樣本不足', borderline: '樣本剛達門檻', sufficient: '樣本充足', strong: '樣本非常充足',
});
const CONFIDENCE_LEVEL_LABELS = Object.freeze({ low: '信心較低', medium: '信心中等', high: '信心高' });
const DATA_QUALITY_STATUS_LABELS = Object.freeze({ good: '品質良好', fair: '品質尚可', poor: '品質偏低', unknown: '無法取得' });

// ════════════════════════════════════════════════════════════════
// 九、格式化規則（集中管理，不得出現 NaN%/Infinity%/undefined 人）
// ════════════════════════════════════════════════════════════════
function _isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function formatGeoMetricValue(value, unit) {
  if (value === null || value === undefined || !_isFiniteNum(Number(value))) {
    if (value === null || value === undefined) return '暫無資料';
  }
  const v = Number(value);
  if (!Number.isFinite(v)) return '暫無資料';
  if (unit === 'rate') return formatGeoRate(v);
  if (unit === 'people') return `${Math.round(v)} 人`;
  if (unit === 'percentage_point') return `${Math.round(Math.abs(v) * 100)} 個百分點`;
  return `${v}`;
}

function formatGeoRate(value) {
  if (value === null || value === undefined) return '暫無資料';
  const v = Number(value);
  if (!Number.isFinite(v)) return '暫無資料';
  return `${Math.round(v * 100)}%`;
}

// 差距格式化：rate → "高/低 N 個百分點"；people → "多/少 N 人"；null → 暫無資料
function formatGeoDifference(diff, unit) {
  if (diff === null || diff === undefined) return '暫無資料';
  const v = Number(diff);
  if (!Number.isFinite(v)) return '暫無資料';
  if (v === 0) return unit === 'rate' ? '與基準相同' : '與基準相同';
  const abs = Math.abs(v);
  if (unit === 'rate') return `${v > 0 ? '高' : '低'} ${Math.round(abs * 100)} 個百分點`;
  if (unit === 'people') return `${v > 0 ? '多' : '少'} ${Math.round(abs)} 人`;
  return `${v > 0 ? '+' : ''}${v}`;
}

function formatGeoAreaLabel(city, district) {
  if (district) return city ? `${city}・${district}` : district;
  if (city) return city;
  return '未知區域';
}

// ════════════════════════════════════════════════════════════════
// 六、Stable ID——同輸入同輸出，不用 Math.random()/Date.now()，不含
// visitor_id/cart_id/order_id 等個資。中文字串（縣市/行政區/來源名稱等）
// 用簡單確定性 hash 轉成安全 ASCII slug 片段，不需要額外的拼音/轉譯套件。
// ════════════════════════════════════════════════════════════════
function _djb2(str) {
  let hash = 5381;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0; // hash*33 + c，強制無符號 32-bit
  }
  return hash.toString(36);
}
function _slugPart(value) {
  if (value === null || value === undefined || value === '') return 'na';
  const s = String(value).trim();
  if (!s) return 'na';
  // 純 ASCII 英數字/常見符號才直接轉小寫 slug，其他（含中文）一律 hash，
  // 避免任何非 ASCII 原文（即使不是個資）直接出現在 ID 裡。
  if (/^[\x20-\x7e]+$/.test(s)) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'na';
  }
  return `h${_djb2(s)}`;
}
function _dateOnly(value) {
  // fix18-10-hotfix30-B5-R5.2-B1-4.6（需求文件六：Stable ID）——
  // resolveDateRange({preset:'today'}) 的 end 邊界是「呼叫當下的 now」
  // （精確到秒），不是當天 23:59:59。若直接把完整 dateRangeEnd 字串塞進
  // ID，同一個邏輯範圍（今天）在下一秒重新呼叫就會產生不同 ID，違反
  // 「同一輸入必須產生同一 ID」。這裡只取日期部分（YYYY-MM-DD），忽略
  // 時分秒，讓 ID 穩定對應「同一天」這個邏輯範圍，不受呼叫時刻影響。
  if (value === null || value === undefined) return null;
  const s = String(value);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}
function buildGeoRecommendationId(parts) {
  const {
    classification, storeId, city, district, channel,
    dateRangeStart, dateRangeEnd, source, medium, campaign,
  } = parts || {};
  const segments = [
    'geo-rec',
    _slugPart(classification),
    _slugPart(storeId),
    _slugPart(city),
    _slugPart(district),
    _slugPart(channel),
    _slugPart(_dateOnly(dateRangeStart)),
    _slugPart(_dateOnly(dateRangeEnd)),
    _slugPart(source),
    _slugPart(medium),
    _slugPart(campaign),
  ];
  return segments.join('-');
}

// ════════════════════════════════════════════════════════════════
// 十五、Scope 正規化——缺值一律 null，不混用 undefined/空字串；channel="all"
// 是既有 API 的固定語意，明確保留，不擅自轉 null。
// ════════════════════════════════════════════════════════════════
function _normalizeScope(rawScope) {
  const s = rawScope || {};
  const norm = (v) => (v === undefined || v === '' ? null : v);
  return {
    store_id: norm(s.store_id),
    date_range: s.date_range || null,
    channel: s.channel === undefined || s.channel === '' ? null : s.channel, // 保留 "all"，只有真的缺值才轉 null
    county_code: norm(s.county_code),
    subdivision_code: norm(s.subdivision_code),
    source: norm(s.source),
    medium: norm(s.medium),
    campaign: norm(s.campaign),
  };
}

// ════════════════════════════════════════════════════════════════
// 十二、Evidence Items——整合既有 evidence[] 與
// explanation.primary_reason/supporting_reasons，保留結構化數值，不重算、
// 不與 explanation 矛盾（直接複用同一份資料，不重新計算任何數字）。
// ════════════════════════════════════════════════════════════════
function _reasonToEvidenceItem(reason, type) {
  const unit = reason.unit === 'people' ? 'people' : (reason.unit === 'rate' ? 'rate' : reason.unit);
  return {
    type,
    label: GEO_METRIC_LABELS[reason.metric] || reason.metric,
    value: reason.actual_value,
    formatted_value: formatGeoMetricValue(reason.actual_value, unit),
    benchmark: reason.benchmark_value,
    formatted_benchmark: formatGeoMetricValue(reason.benchmark_value, unit),
    direction: ['above', 'below'].includes(reason.direction) ? reason.direction : 'unavailable',
    message: reason.message,
  };
}
function buildGeoEvidenceItems(recommendation) {
  const explanation = recommendation.explanation || {};
  const items = [];
  if (explanation.primary_reason) items.push(_reasonToEvidenceItem(explanation.primary_reason, 'primary_reason'));
  (explanation.supporting_reasons || []).forEach((r) => items.push(_reasonToEvidenceItem(r, 'supporting_reason')));
  // 既有 evidence[] 純文字，額外附上（不重算數字，只作為既有文案的向下相容呈現）
  (recommendation.evidence || []).forEach((text) => {
    items.push({
      type: 'evidence_text', label: null, value: null, formatted_value: text,
      benchmark: null, formatted_benchmark: null, direction: 'unavailable', message: text,
    });
  });
  return items;
}

// ════════════════════════════════════════════════════════════════
// 十一、Recommended Actions——至少把既有 action 包裝成第一筆，不新增真的
// 會執行的動作（發券/推播/改價/調整廣告一律不做，只做建議資料結構）。
// ════════════════════════════════════════════════════════════════
function buildGeoRecommendedActions(recommendation) {
  const category = GEO_ACTION_CATEGORY_MAP[recommendation.code] || 'general';
  const actions = [];
  if (recommendation.action) {
    actions.push({
      priority: 1,
      title: GEO_BADGE_MAP[recommendation.code] || recommendation.title,
      description: recommendation.action,
      category,
      action_type: 'review',
    });
  }
  return actions;
}

// ════════════════════════════════════════════════════════════════
// 五、Comparison——直接複用 explanation.primary_reason（single source of
// truth，不重算）。
// ════════════════════════════════════════════════════════════════
function _buildComparison(recommendation) {
  const pr = (recommendation.explanation && recommendation.explanation.primary_reason) || null;
  if (!pr) {
    return {
      benchmark_type: null, benchmark_label: null, actual: null, benchmark: null,
      difference: null, formatted_difference: '暫無資料', direction: 'unavailable', message: '暫無可比較的基準值',
    };
  }
  const unit = pr.unit === 'people' ? 'people' : 'rate';
  return {
    benchmark_type: pr.benchmark_type,
    benchmark_label: BENCHMARK_TYPE_LABELS[pr.benchmark_type] || pr.benchmark_type,
    actual: pr.actual_value,
    benchmark: pr.benchmark_value,
    difference: pr.difference,
    formatted_difference: formatGeoDifference(pr.difference, unit),
    direction: ['above', 'below'].includes(pr.direction) ? pr.direction : 'unavailable',
    message: pr.message,
  };
}

// ════════════════════════════════════════════════════════════════
// 十、Primary Metric——集中映射，不由前端決定
// ════════════════════════════════════════════════════════════════
function _buildPrimaryMetric(recommendation) {
  const key = GEO_PRIMARY_METRIC_MAP[recommendation.code] || 'visitors';
  const value = (recommendation.metrics && recommendation.metrics[key] !== undefined) ? recommendation.metrics[key] : null;
  const unit = GEO_METRIC_UNITS[key] || 'rate';
  return {
    key, label: GEO_METRIC_LABELS[key] || key, value,
    formatted_value: formatGeoMetricValue(value, unit), unit,
  };
}

// ════════════════════════════════════════════════════════════════
// 五、頂層：buildGeoRecommendationViewModel()——只讀既有
// behavior_recommendation（已含 explanation），不重查 SQL、不重算 classification/
// confidence（三之 3.2）。
// ════════════════════════════════════════════════════════════════
function buildGeoRecommendationViewModel(recommendation, opts = {}) {
  const explanation = recommendation.explanation || {};
  const scope = _normalizeScope(recommendation.scope);
  const confidenceBreakdown = explanation.confidence_breakdown || {};
  const sampleAssessment = explanation.sample_assessment || {};
  const dataQualityAssessment = explanation.data_quality_assessment || {};

  const id = buildGeoRecommendationId({
    classification: recommendation.classification,
    storeId: scope.store_id,
    city: recommendation.city,
    district: recommendation.district,
    channel: scope.channel,
    dateRangeStart: scope.date_range && scope.date_range.start,
    dateRangeEnd: scope.date_range && scope.date_range.end,
    source: scope.source,
    medium: scope.medium,
    campaign: scope.campaign,
  });

  const areaLabel = formatGeoAreaLabel(recommendation.city, recommendation.district);
  const confidenceScore = _isFiniteNum(confidenceBreakdown.score) ? confidenceBreakdown.score : 0;
  const sampleActual = _isFiniteNum(sampleAssessment.relevant_stage_visitors) ? sampleAssessment.relevant_stage_visitors : (_isFiniteNum(sampleAssessment.visitors) ? sampleAssessment.visitors : 0);

  const INTENT_RANK = { risk: 0, quality: 1, opportunity: 2, positive: 3 };
  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  const intentRank = INTENT_RANK[recommendation.intent_type] !== undefined ? INTENT_RANK[recommendation.intent_type] : 9;
  const sevRank = SEV_RANK[recommendation.severity] !== undefined ? SEV_RANK[recommendation.severity] : 9;
  // sort_key：可讀、可除錯的複合鍵（十四：不得參與排序的東西——generated_at——
  // 刻意不放進來；confidence/sample 用補零反向編碼，讓「數字越大排越前」用
  // 字串遞增排序也能得到一致順序，方便除錯或簡易前端直接照字串排序）。
  const sort_key = [
    String(intentRank),
    String(sevRank),
    String(100 - Math.round(confidenceScore)).padStart(3, '0'),
    String(Math.max(0, 99999 - Math.round(sampleActual))).padStart(6, '0'),
    areaLabel,
  ].join('|');

  return {
    id,
    code: recommendation.code,
    classification: recommendation.classification,
    intent_type: recommendation.intent_type,

    headline: {
      title: recommendation.title,
      subtitle: areaLabel,
      badge: GEO_BADGE_MAP[recommendation.code] || null,
      severity: recommendation.severity,
      confidence: recommendation.confidence,
    },

    location: {
      area_name: recommendation.area_name,
      city: recommendation.city,
      district: recommendation.district,
    },

    summary: explanation.summary || recommendation.reason,

    primary_metric: _buildPrimaryMetric(recommendation),

    comparison: _buildComparison(recommendation),

    funnel: recommendation.metrics ? {
      visitors: _isFiniteNum(recommendation.metrics.visitors) ? recommendation.metrics.visitors : 0,
      add_to_cart_visitors: _isFiniteNum(recommendation.metrics.add_to_cart_visitors) ? recommendation.metrics.add_to_cart_visitors : 0,
      begin_checkout_visitors: _isFiniteNum(recommendation.metrics.begin_checkout_visitors) ? recommendation.metrics.begin_checkout_visitors : 0,
      purchase_visitors: _isFiniteNum(recommendation.metrics.purchase_visitors) ? recommendation.metrics.purchase_visitors : 0,
      visit_to_cart_rate: _isFiniteNum(recommendation.metrics.visit_to_cart_rate) ? recommendation.metrics.visit_to_cart_rate : 0,
      cart_to_checkout_rate: _isFiniteNum(recommendation.metrics.cart_to_checkout_rate) ? recommendation.metrics.cart_to_checkout_rate : 0,
      checkout_to_purchase_rate: _isFiniteNum(recommendation.metrics.checkout_to_purchase_rate) ? recommendation.metrics.checkout_to_purchase_rate : 0,
      visit_to_purchase_rate: _isFiniteNum(recommendation.metrics.visit_to_purchase_rate) ? recommendation.metrics.visit_to_purchase_rate : 0,
    } : null,

    evidence_items: buildGeoEvidenceItems(recommendation),
    recommended_actions: buildGeoRecommendedActions(recommendation),

    confidence: {
      level: recommendation.confidence,
      score: confidenceScore,
      label: CONFIDENCE_LEVEL_LABELS[recommendation.confidence] || null,
      reasons: confidenceBreakdown.reasons || [],
    },

    sample: {
      status: sampleAssessment.status || null,
      actual: sampleActual,
      minimum_required: _isFiniteNum(sampleAssessment.minimum_required) ? sampleAssessment.minimum_required : null,
      label: SAMPLE_STATUS_LABELS[sampleAssessment.status] || null,
    },

    data_quality: {
      identified_rate: dataQualityAssessment.identified_rate === undefined ? null : dataQualityAssessment.identified_rate,
      unknown_rate: dataQualityAssessment.unknown_rate === undefined ? null : dataQualityAssessment.unknown_rate,
      status: dataQualityAssessment.quality_status || null,
      label: DATA_QUALITY_STATUS_LABELS[dataQualityAssessment.quality_status] || null,
    },

    scope,
    secondary_classifications: recommendation.secondary_classifications || [],
    sort_key,
  };
}

// ════════════════════════════════════════════════════════════════
// 七、Stable Sorting——固定順序，不依賴資料庫未指定順序，重跑結果必須相同。
// intent_type(risk>quality>opportunity>positive) → severity(high>medium>low)
// → confidence score(高到低) → sample size(高到低) → area name(localeCompare)
// ════════════════════════════════════════════════════════════════
function sortGeoRecommendationViewModels(viewModels) {
  const INTENT_RANK = { risk: 0, quality: 1, opportunity: 2, positive: 3 };
  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  return (viewModels || []).slice().sort((a, b) => {
    const ia = INTENT_RANK[a.intent_type] !== undefined ? INTENT_RANK[a.intent_type] : 9;
    const ib = INTENT_RANK[b.intent_type] !== undefined ? INTENT_RANK[b.intent_type] : 9;
    if (ia !== ib) return ia - ib;
    const sa = SEV_RANK[a.headline.severity] !== undefined ? SEV_RANK[a.headline.severity] : 9;
    const sb = SEV_RANK[b.headline.severity] !== undefined ? SEV_RANK[b.headline.severity] : 9;
    if (sa !== sb) return sa - sb;
    const ca = _isFiniteNum(a.confidence.score) ? a.confidence.score : 0;
    const cb = _isFiniteNum(b.confidence.score) ? b.confidence.score : 0;
    if (ca !== cb) return cb - ca; // 高到低
    const sampleA = _isFiniteNum(a.sample.actual) ? a.sample.actual : 0;
    const sampleB = _isFiniteNum(b.sample.actual) ? b.sample.actual : 0;
    if (sampleA !== sampleB) return sampleB - sampleA; // 高到低
    const nameA = a.location.area_name || a.headline.subtitle || '';
    const nameB = b.location.area_name || b.headline.subtitle || '';
    return nameA.localeCompare(nameB, 'zh-Hant');
  });
}

function buildGeoRecommendationViewModels(recommendations) {
  const models = (recommendations || []).map((r) => buildGeoRecommendationViewModel(r));
  return sortGeoRecommendationViewModels(models);
}

// ════════════════════════════════════════════════════════════════
// 十三、Quality ViewModel——Unknown 過高時可直接給 Dashboard 使用，明確不當
// 成一般行政區（location 固定為 null，跟一般 recommendation viewmodel 的
// location 有實際 city/district 明確不同）。
// ════════════════════════════════════════════════════════════════
function buildGeoQualityViewModel(qualityRecommendation) {
  const explanation = qualityRecommendation.explanation || {};
  const scope = _normalizeScope(qualityRecommendation.scope);
  const confidenceBreakdown = explanation.confidence_breakdown || {};
  const dataQualityAssessment = explanation.data_quality_assessment || {};

  const id = buildGeoRecommendationId({
    classification: qualityRecommendation.classification,
    storeId: scope.store_id,
    city: 'store-level', // 明確不是行政區，避免跟一般區域 ID 混淆或碰撞
    district: null,
    channel: scope.channel,
    dateRangeStart: scope.date_range && scope.date_range.start,
    dateRangeEnd: scope.date_range && scope.date_range.end,
    source: scope.source,
    medium: scope.medium,
    campaign: scope.campaign,
  });

  const confidenceScore = _isFiniteNum(confidenceBreakdown.score) ? confidenceBreakdown.score : 0;
  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  const sevRank = SEV_RANK[qualityRecommendation.severity] !== undefined ? SEV_RANK[qualityRecommendation.severity] : 9;
  const sort_key = ['quality', String(sevRank), String(100 - Math.round(confidenceScore)).padStart(3, '0')].join('|');

  return {
    id,
    code: qualityRecommendation.code,
    headline: {
      title: qualityRecommendation.title,
      subtitle: '全店資料品質',
      badge: GEO_BADGE_MAP[qualityRecommendation.code] || null,
      severity: qualityRecommendation.severity,
      confidence: qualityRecommendation.confidence,
    },
    summary: explanation.summary || qualityRecommendation.reason,
    quality_metrics: {
      identified_rate: dataQualityAssessment.identified_rate === undefined ? null : dataQualityAssessment.identified_rate,
      unknown_rate: dataQualityAssessment.unknown_rate === undefined ? null : dataQualityAssessment.unknown_rate,
      status: dataQualityAssessment.quality_status || null,
      formatted_unknown_rate: formatGeoRate(dataQualityAssessment.unknown_rate),
    },
    evidence_items: buildGeoEvidenceItems(qualityRecommendation),
    recommended_actions: buildGeoRecommendedActions(qualityRecommendation),
    confidence: {
      level: qualityRecommendation.confidence,
      score: confidenceScore,
      label: CONFIDENCE_LEVEL_LABELS[qualityRecommendation.confidence] || null,
      reasons: confidenceBreakdown.reasons || [],
    },
    scope,
    sort_key,
  };
}
function buildGeoQualityViewModels(qualityRecommendations) {
  return (qualityRecommendations || []).map((r) => buildGeoQualityViewModel(r));
}

// ════════════════════════════════════════════════════════════════
// 十四、Meta——generated_at 只是資訊性時間戳，不得參與 ID 或排序（上面
// buildGeoRecommendationId()/sortGeoRecommendationViewModels() 皆未讀取
// generated_at，此處僅在回傳物件內單獨附上）。
// ════════════════════════════════════════════════════════════════
function buildGeoRecommendationsMeta(recommendationViewModels, qualityViewModels, scope) {
  return {
    generated_at: new Date().toISOString(),
    recommendation_count: (recommendationViewModels || []).length,
    quality_recommendation_count: (qualityViewModels || []).length,
    scope: _normalizeScope(scope),
    sort_version: SORT_VERSION,
    compatibility: {
      legacy_alerts_preserved: true,
      legacy_behavior_recommendations_preserved: true,
      frontend_migration_required: false,
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  SORT_VERSION,
  GEO_INTENT_TYPE_VALUES,
  GEO_SEVERITY_VALUES,
  GEO_CONFIDENCE_VALUES,
  GEO_SAMPLE_STATUS_VALUES,
  GEO_DIRECTION_VALUES,
  GEO_BADGE_MAP,
  GEO_PRIMARY_METRIC_MAP,
  GEO_METRIC_LABELS,
  GEO_METRIC_UNITS,
  GEO_ACTION_CATEGORY_MAP,
  formatGeoMetricValue,
  formatGeoRate,
  formatGeoDifference,
  formatGeoAreaLabel,
  buildGeoRecommendationId,
  buildGeoEvidenceItems,
  buildGeoRecommendedActions,
  buildGeoRecommendationViewModel,
  buildGeoRecommendationViewModels,
  sortGeoRecommendationViewModels,
  buildGeoQualityViewModel,
  buildGeoQualityViewModels,
  buildGeoRecommendationsMeta,
};
