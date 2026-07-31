// public/js/geo-visitor-layer.js — fix18-10-hotfix30-B5-R5.3-A1.2
// Analytics Visitor Geo Sync — Visitor Layer（訪客地理資料層）
//
// 這是一個全新、獨立的 Layer，不是 Order Heatmap（public/js/geo-heatmap.js）
// 的一部分，也沒有修改它——本檔案完全不 import/覆寫 geo-heatmap.js 的任何
// 常數／state／render function，只在需要沿用既有 Normalization 時「呼叫」
// 它既有匯出的 pure helper（geoHeatNormalizeValue/geoHeatGetLevel/
// geoHeatComputeStats，見下方），不重新宣告一份。
//
// 資料來源：geo_visit_log（透過新增的 GET /api/analytics/geo/visitor-log，
// 不是第二套 Analytics API，是既有 Geo Analytics API 家族內新增的一支
// Query），完全不依賴 orders 表。
//
// 座標與地圖呈現的核心決策（使用者本輪明確指示，稽核結論見下）：
//   - Visitor Geo（IP 推定）只給 city/district 名稱，從來不給 lat/lng——
//     本檔案「絕不」畫 CircleMarker、絕不建立行政區中心點、絕不用店家座標
//     或矩形 fixture 的中心點假造座標。
//   - 改用行政區 Choropleth（依 visitor_count 上色），但只有「正式合法
//     Polygon」的行政區才能上色。稽核結論：目前 repo 內唯一的 Polygon
//     資料集（public/data/geo/taiwan/taoyuan-districts.geojson）逐一驗證
//     後，13 個行政區全部是「軸對齊矩形」（4 個角點座標兩兩相同，是測試用
//     fixture，不是真實行政區邊界），因此 GEO_VISITOR_CHOROPLETH_OFFICIAL_
//     CITY_CODES 目前刻意留空——沒有任何城市符合上色資格。這不是 bug，是
//     忠實反映目前真實資料狀態；等有真正官方行政區邊界資料時，只需要把
//     對應的 city_code 加進這個常數，其餘程式碼不必修改。
//   - 沒有合法 Polygon 可上色的行政區，仍然完整保留在 Ranking／Summary／
//     Coverage／Recent Visitor Log（需求：不得因為沒有 Polygon 就從統計中
//     消失）。

'use strict';

const GEO_VISITOR_TIME_RANGES = Object.freeze(['5m', '30m', '1h', '24h', 'today', '7d', '30d', 'custom']);
const GEO_VISITOR_RANGE_LABEL = Object.freeze({
  '5m': '近 5 分鐘', '30m': '近 30 分鐘', '1h': '近 1 小時', '24h': '近 24 小時',
  today: '今日', '7d': '近 7 天', '30d': '近 30 天', custom: '自訂',
});

// fix18-10-hotfix30-B5-R5.3-A2（Geo Event Engine，需求文件十三）：8 個正式
// Dashboard Tab，全部共用同一個 geoEventState（這裡即 geoVisitorState），
// 不建立 Visitors/Cart/Checkout/Orders 四套重複狀態——只是同一份 state 的
// 一個 `metric` 欄位決定目前顯示哪一個 Tab 的 Summary/Ranking/Tooltip。
const GEO_EVENT_METRICS = Object.freeze(['visitors', 'add_to_cart', 'checkout', 'orders', 'revenue', 'conversion', 'cart_abandonment', 'recommendation_risk']);
const GEO_EVENT_METRIC_LABEL = Object.freeze({
  visitors: '訪客', add_to_cart: '加入購物車', checkout: '開始結帳', orders: '完成訂單',
  revenue: '營收', conversion: '成交率', cart_abandonment: '購物車放棄', recommendation_risk: '建議風險',
});

// 目前刻意留空（見上方稽核結論）。之後若有正式行政區邊界資料，在這裡加入
// 該城市的 city_code（跟 public/data/geo/taiwan/manifest.json 的 city_code
// 是同一組值，例如 'TAO'）即可讓 Choropleth 開始為該城市上色，不需要修改
// geoVisitorRenderChoropleth() 本身的邏輯。
let _GEO_VISITOR_CHOROPLETH_OFFICIAL_CITY_CODES = Object.freeze([]);
function geoVisitorIsChoroplethEligible(cityCode) {
  return _GEO_VISITOR_CHOROPLETH_OFFICIAL_CITY_CODES.includes(cityCode);
}
// 僅供測試使用：驗證「若未來真的有合法 Polygon，Choropleth 邏輯本身正確」，
// 不代表產品環境會啟用（production 進入點見上方，一律是凍結的空陣列）。
function _setChoroplethOfficialCityCodesForTest(codes) {
  _GEO_VISITOR_CHOROPLETH_OFFICIAL_CITY_CODES = Object.freeze(Array.isArray(codes) ? codes.slice() : []);
}

function _geoVisitorEsc(s) {
  if (typeof escHtml === 'function') return escHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _geoVisitorSafeNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ════════════════════════════════════════════════════════════════
// 一、State
// ════════════════════════════════════════════════════════════════
let geoVisitorState = {
  containerId: null,
  range: 'today',
  metric: 'visitors',
  summary: null,
  funnel: null,
  recommendationRisk: null,
  areas: [],
  recent: [],
  choroplethLayerGroup: null, // 獨立 layerGroup，跟既有 Dashboard 的 geoJsonLayer 分開，避免互相覆蓋
  requestSeq: 0,
  abortController: null,
  // fix18-10-hotfix30-B5-R5.3-A7（Geo KPI Single Source Integration）：
  // 'idle' | 'loading' | 'ready' | 'error'——供 geo-intelligence.js 的
  // 「Geo 訪客/加購/結帳/訂單」KPI 卡片判斷四態（loading/ready/error/empty，
  // empty 是 ready 且 funnel.visitors===0 的子情況，由呼叫端自己再細分）。
  // 這是本 state 唯一的新增欄位，不影響既有 summary/funnel/areas 等欄位
  // 的既有語意或既有 regression 對它們的讀取方式。
  status: 'idle',
};
if (typeof window !== 'undefined') window.geoVisitorState = geoVisitorState;
// 需求文件「Store Isolation：沿用既有 Store Isolation，不同店不得共用 Geo
// Visit Log」——每次 Dashboard 重新掛載（含切店時的重新整理）都應呼叫，
// 清空上一店殘留的 areas/summary/recent/選取狀態與 pending request，
// 跟 Order Heatmap Engine 的 geoHeatHandleStoreSwitch() 同一種模式。
function geoVisitorHandleStoreSwitch() {
  if (geoVisitorState.abortController && typeof geoVisitorState.abortController.abort === 'function') {
    geoVisitorState.abortController.abort();
  }
  geoVisitorState.abortController = null;
  geoVisitorState.summary = null;
  geoVisitorState.funnel = null;
  geoVisitorState.recommendationRisk = null;
  geoVisitorState.areas = [];
  geoVisitorState.recent = [];
  geoVisitorState.requestSeq += 1;
  // fix18-10-hotfix30-B5-R5.3-A7：切店必須回到 idle（不是 error/沿用上一店
  // 的 ready），否則新店還沒抓到資料的空檔會誤顯示上一店的舊 KPI 卡片
  // 狀態（需求文件九：Store Isolation 同樣適用於這個 status 欄位）。
  geoVisitorState.status = 'idle';
  if (geoVisitorState.choroplethLayerGroup && typeof geoVisitorState.choroplethLayerGroup.clearLayers === 'function') {
    geoVisitorState.choroplethLayerGroup.clearLayers();
  }
}

function _geoVisitorResetStateForTest() {
  geoVisitorState.containerId = null;
  geoVisitorState.range = 'today';
  geoVisitorState.metric = 'visitors';
  geoVisitorState.summary = null;
  geoVisitorState.funnel = null;
  geoVisitorState.recommendationRisk = null;
  geoVisitorState.areas = [];
  geoVisitorState.recent = [];
  if (geoVisitorState.choroplethLayerGroup && typeof geoVisitorState.choroplethLayerGroup.clearLayers === 'function') {
    geoVisitorState.choroplethLayerGroup.clearLayers();
  }
  geoVisitorState.choroplethLayerGroup = null;
  geoVisitorState.requestSeq = 0;
  geoVisitorState.abortController = null;
  geoVisitorState.status = 'idle';
  if (typeof window !== 'undefined') window.geoVisitorState = geoVisitorState;
}

// ════════════════════════════════════════════════════════════════
// 二、Coverage（需求：Geo Visitors 統計必須包含「有真實座標／只有行政區／
//    Unknown」，不得出現 Geo Visitors=0 但 Unknown=100% 的矛盾）
// ════════════════════════════════════════════════════════════════
function geoVisitorComputeCoverage(summary) {
  const s = summary || {};
  const total = _geoVisitorSafeNumber(s.geo_visitors);
  const known = _geoVisitorSafeNumber(s.geo_visitors_known);
  const unknown = Math.max(0, total - known);
  // 目前唯一的 Geo Resolver 從不提供座標，所以「有真實座標」這一類永遠是 0——
  // 誠實呈現，不假裝有精確定位（見需求文件「精確座標：未取得」）。
  const withCoordinate = 0;
  const knownAreaOnly = Math.max(0, known - withCoordinate);
  const coveragePct = total > 0 ? Math.round((known / total) * 1000) / 10 : 0;
  return { total, with_coordinate: withCoordinate, known_area_only: knownAreaOnly, unknown, coverage_pct: coveragePct };
}

// ════════════════════════════════════════════════════════════════
// 三、Tooltip（需求：定位層級／來源／精確座標三行必須明確標示）
// ════════════════════════════════════════════════════════════════
function geoVisitorBuildTooltipContent(area) {
  const a = area || {};
  const name = a.is_unknown ? 'Unknown' : `${a.city || ''}${a.district || ''}`.trim() || 'Unknown';
  const lines = [
    name,
    `訪客數：${_geoVisitorSafeNumber(a.visitor_count)}`,
    '定位層級：行政區推定',
    '來源：IP Geo / Analytics Sync',
    '精確座標：未取得',
  ];
  return lines.map(_geoVisitorEsc).join('<br>');
}

// ════════════════════════════════════════════════════════════════
// 四、Choropleth（需求：只有正式合法 Polygon 才可著色；沿用 R5.3-A1
//    Normalization——呼叫 geo-heatmap.js 既有匯出的 geoHeatNormalizeValue/
//    geoHeatGetLevel/geoHeatComputeStats，不重新宣告一份正規化邏輯）
// ════════════════════════════════════════════════════════════════
// mapInstance：既有 Dashboard 共用的同一個 Leaflet map instance（不建立
// 第二張地圖）。featureIndex：既有 geoMapState.featureIndex（由
// geo-intelligence-map.js 既有的 geoBuildAreaFeatureIndex() 建立，這裡只
// 讀取，不修改）。
function geoVisitorRenderChoropleth(mapInstance, featureIndex) {
  if (!geoVisitorState.choroplethLayerGroup) {
    if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
      geoVisitorState.choroplethLayerGroup = L.layerGroup();
      if (mapInstance && typeof geoVisitorState.choroplethLayerGroup.addTo === 'function') {
        geoVisitorState.choroplethLayerGroup.addTo(mapInstance);
      }
    }
  }
  const group = geoVisitorState.choroplethLayerGroup;
  if (!group || typeof group.clearLayers !== 'function') return { drawn: 0, skipped: 0 };

  group.clearLayers();
  if (!featureIndex || typeof L === 'undefined' || typeof L.geoJSON !== 'function') return { drawn: 0, skipped: (geoVisitorState.areas || []).length };

  const known = (geoVisitorState.areas || []).filter((a) => !a.is_unknown);
  const stats = (typeof geoHeatComputeStats === 'function') ? geoHeatComputeStats(known, 'visitor_count') : { min: 0, max: 0 };
  let drawn = 0; let skipped = 0;

  known.forEach((area) => {
    // 需求規則五：只有正式合法 Polygon 的行政區才可著色。city_code 目前
    // 沒有現成欄位可直接拿到，這裡用 city 名稱對照既有 manifest 慣例的
    // city_code（跟 public/data/geo/taiwan/manifest.json 的用法一致，只是
    // 反查方向不同）——若呼叫端有提供 area.city_code 就優先使用。
    const cityCode = area.city_code || (typeof window !== 'undefined' && window.geoMapState && window.geoMapState.settings ? window.geoMapState.settings.city_code : null);
    if (!geoVisitorIsChoroplethEligible(cityCode)) { skipped += 1; return; }
    const feature = (typeof geoMatchAreaToFeature === 'function') ? geoMatchAreaToFeature(area, featureIndex) : null;
    if (!feature) { skipped += 1; return; }

    const normalized = (typeof geoHeatNormalizeValue === 'function') ? geoHeatNormalizeValue(area.visitor_count, stats.min, stats.max) : 0;
    const level = (typeof geoHeatGetLevel === 'function') ? geoHeatGetLevel(normalized) : { color: '#3b82f6' };
    try {
      const layer = L.geoJSON(feature, {
        style: () => ({ fillColor: level.color, color: '#111827', weight: 1, fillOpacity: 0.35 + normalized * 0.45 }),
      });
      if (typeof layer.bindTooltip === 'function') layer.bindTooltip(geoVisitorBuildTooltipContent(area));
      group.addLayer(layer);
      drawn += 1;
    } catch (e) { skipped += 1; }
  });

  return { drawn, skipped };
}

// ════════════════════════════════════════════════════════════════
// 五、DOM 渲染（Summary／Coverage／Ranking／Recent Visitor Log）
// ════════════════════════════════════════════════════════════════
function _geoVisitorEl(suffix) {
  if (typeof document === 'undefined' || !geoVisitorState.containerId) return null;
  return document.getElementById(`${geoVisitorState.containerId}-${suffix}`);
}
function geoVisitorRenderSummaryDom() {
  const el = _geoVisitorEl('visitor-summary');
  if (!el) return;
  const s = geoVisitorState.summary || {};
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = [
    `Geo Visitor：${_geoVisitorSafeNumber(s.geo_visitors)}`,
    `Geo AddToCart：${_geoVisitorSafeNumber(s.geo_add_to_cart)}`,
    `Geo Checkout：${_geoVisitorSafeNumber(s.geo_checkout)}`,
    `Geo Orders：${_geoVisitorSafeNumber(s.geo_orders)}`,
    `Unknown：${_geoVisitorSafeNumber(s.geo_visitors_unknown)}（${_geoVisitorSafeNumber(s.unknown_rate)}%）`,
  ].map(_geoVisitorEsc).join('<br>');
}
function geoVisitorRenderCoverageDom() {
  const el = _geoVisitorEl('visitor-coverage');
  if (!el) return;
  const c = geoVisitorComputeCoverage(geoVisitorState.summary);
  el.innerHTML = [
    `Geo Visitor：${c.total}`,
    `Known：${c.total - c.unknown}`,
    `Unknown：${c.unknown}`,
    `Coverage：${c.coverage_pct}%`,
  ].map(_geoVisitorEsc).join('<br>');
}
function _geoVisitorRankingSortKey(area, metric) {
  if (metric === 'add_to_cart') return area.add_to_cart_count || 0;
  if (metric === 'checkout') return area.checkout_count || 0;
  if (metric === 'orders') return area.order_count || 0;
  return area.visitor_count || 0; // visitors/revenue/conversion/cart_abandonment/recommendation_risk：目前沒有各自獨立的行政區級 SQL（需求文件六：不得為每個 Tab 建一套 SQL），沿用 Visitors 排序，見 R5.3-A2_DATA_DECISION.md
}
function _geoVisitorRankingValue(area, metric) { return _geoVisitorRankingSortKey(area, metric); }
function geoVisitorRenderRankingDom() {
  const el = _geoVisitorEl('visitor-ranking');
  if (!el) return;
  const metric = geoVisitorState.metric;
  const list = (geoVisitorState.areas || []).slice().sort((a, b) => _geoVisitorRankingSortKey(b, metric) - _geoVisitorRankingSortKey(a, metric));
  el.innerHTML = list.map((a) => {
    const name = a.is_unknown ? 'Unknown' : `${a.city || ''}${a.district || ''}`;
    const noCoord = a.is_unknown ? '' : `<span class="geo-visitor-approx">（行政區推定）</span>`;
    return `<li class="geo-visitor-rank-item"><span class="geo-visitor-rank-name">${_geoVisitorEsc(name)}</span>${noCoord}<span class="geo-visitor-rank-value">${_geoVisitorEsc(String(_geoVisitorRankingValue(a, metric)))}</span></li>`;
  }).join('');
}
function geoVisitorRenderRecentDom() {
  const el = _geoVisitorEl('visitor-recent');
  if (!el) return;
  const list = geoVisitorState.recent || [];
  if (!list.length) { el.innerHTML = `<div class="geo-visitor-recent-empty">目前沒有訪客紀錄</div>`; return; }
  el.innerHTML = list.map((r) => {
    const name = r.is_unknown ? 'Unknown' : `${r.city || ''}${r.district || ''}`;
    const level = r.is_unknown ? 'Unknown' : '行政區推定';
    const mask = _geoVisitorEsc(r.visitor_mask || 'vis_***');
    return `<div class="geo-visitor-recent-row"><span class="geo-visitor-recent-time">${_geoVisitorEsc(r.event_time)}</span><span class="geo-visitor-recent-mask">${mask}</span><span class="geo-visitor-recent-event">${_geoVisitorEsc(r.event_name)}</span><span class="geo-visitor-recent-area">${_geoVisitorEsc(name)}</span><span class="geo-visitor-recent-level">${_geoVisitorEsc(level)}</span><span class="geo-visitor-recent-source">${_geoVisitorEsc(r.source === 'ip' ? 'Analytics Sync' : (r.source || 'Analytics Sync'))}</span></div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════
// 五-B、Geo Event Engine Metric Tabs（需求文件十三～十九）——8 個正式
//      Tab，全部共用 geoVisitorState.funnel（同一次 API 回應算好的完整
//      漏斗），切換 Tab 不重新打 API，只切換要顯示哪一段資料。
// ════════════════════════════════════════════════════════════════
function geoVisitorMetricBarHtml(containerId) {
  const buttons = GEO_EVENT_METRICS.map((m) => {
    const active = geoVisitorState.metric === m;
    return `<button type="button" class="geo-heat-ctl-btn" aria-pressed="${active}" onclick="geoVisitorSetMetric('${_geoVisitorEsc(containerId)}','${_geoVisitorEsc(m)}')">${_geoVisitorEsc(GEO_EVENT_METRIC_LABEL[m])}</button>`;
  }).join('');
  return `<div id="${_geoVisitorEsc(containerId)}-metric-bar" class="geo-heat-controlbar" role="group" aria-label="Geo Event 指標切換">${buttons}</div>`;
}
// fix18-10-hotfix30-B5-R5.3-A4（Metric Switcher 整合）：新舊 Metric 名稱
// 對照表，供呼叫既有的 geoSetMapMetric()（geo-intelligence-map.js，未修改
// 其函式邏輯本身）使用，讓同一次切換同時驅動共用地圖的 Choropleth／
// Legend／Summary／Tooltip，不重寫既有著色邏輯。add_to_cart／checkout
// 兩個新指標在舊系統沒有對應維度，暫時 fallback 顯示 Visitors 分布（不
// 影響本檔案自己的 Summary/Ranking 數字，只影響共用地圖的著色維度）。
const GEO_EVENT_TO_MAP_METRIC = Object.freeze({
  visitors: 'visitors', add_to_cart: 'visitors', checkout: 'visitors',
  orders: 'orders', revenue: 'revenue', conversion: 'conversion_rate',
  cart_abandonment: 'cart_abandonment_rate', recommendation_risk: 'risk',
});
function geoVisitorSetMetric(containerId, metric) {
  if (!GEO_EVENT_METRICS.includes(metric)) return false;
  geoVisitorState.metric = metric;
  if (typeof document !== 'undefined') {
    const el = document.getElementById(`${containerId}-metric-bar`);
    if (el) el.outerHTML = geoVisitorMetricBarHtml(containerId);
  }
  geoVisitorRenderMetricSummaryDom();
  geoVisitorRenderRankingDom(); // Ranking 排序依 metric 改變（訪客/加購/結帳/訂單各自排序）
  // 需求文件六：切換任一 Metric 必須同步更新 Map Overlay／Legend／Summary／
  // Tooltip——呼叫既有的 geoSetMapMetric()（共用地圖既有函式，未重寫），
  // 不再由已移除的舊獨立按鈕驅動。
  if (typeof geoSetMapMetric === 'function') {
    geoSetMapMetric(GEO_EVENT_TO_MAP_METRIC[metric] || 'visitors');
  }
  return true;
}

// 需求文件二十五：Empty State 依情況區分，不得全部只顯示「暫無資料」。
function _geoVisitorEmptyStateReason(funnel) {
  const f = funnel || {};
  if (!f || (f.visitors || 0) === 0) return '目前沒有任何事件';
  if ((f.unknown_visitors || 0) === (f.visitors || 0)) return '有事件，但目前全部訪客地理位置皆為 Unknown';
  return null; // 有資料，不是空狀態
}

function geoVisitorRenderMetricSummaryDom() {
  const el = _geoVisitorEl('metric-summary');
  if (!el) return;
  const f = geoVisitorState.funnel;
  el.setAttribute('aria-live', 'polite');
  if (!f) { el.innerHTML = `<div class="geo-visitor-recent-empty">目前沒有任何事件</div>`; return; }

  const metric = geoVisitorState.metric;
  const esc = _geoVisitorEsc;
  let html = '';
  if (metric === 'visitors') {
    html = [
      `Geo Visitors：${f.visitors}`,
      `Known District：${f.known_district_visitors}`,
      `Exact Coordinate：0`, // 誠實標示：本輪 IP Geo 從不提供精確座標
      `Unknown：${f.unknown_visitors}`,
      `Coverage：${f.visitors > 0 ? Math.round((f.known_district_visitors / f.visitors) * 1000) / 10 : 0}%`,
    ].join('<br>');
  } else if (metric === 'add_to_cart') {
    html = [
      `Add To Cart Visitors：${f.add_to_cart_visitors}`,
      `Cart Rate（Visitor→Cart）：${f.visitor_to_cart_rate}%`,
      `Known District：${f.known_district_visitors}`,
      `Unknown：${f.unknown_visitors}`,
    ].join('<br>');
  } else if (metric === 'checkout') {
    html = [
      `Checkout Visitors：${f.begin_checkout_visitors}`,
      `Cart to Checkout Rate：${f.cart_to_checkout_rate}%`,
      `Checkout Abandonment：${f.checkout_abandonment_visitors}`,
      `Coverage：${f.visitors > 0 ? Math.round((f.known_district_visitors / f.visitors) * 1000) / 10 : 0}%`,
    ].join('<br>');
  } else if (metric === 'orders') {
    const ordersLine = (f.purchase_orders === null) ? '尚無可用訂單識別資料' : String(f.purchase_orders);
    html = [
      `Purchase Visitors：${f.purchase_visitors}`,
      `Purchase Orders：${esc(ordersLine)}`,
      `Visitor to Purchase Rate：${f.visitor_to_purchase_rate}%`,
    ].join('<br>');
  } else if (metric === 'revenue') {
    if (f.revenue === null) {
      html = `目前沒有可用營收事件資料`;
    } else {
      html = [
        `Revenue：NT$ ${Math.round(f.revenue).toLocaleString('zh-TW')}`,
        `資料來源：Order Data（不是 Analytics 原生營收，本專案 Analytics 事件目前沒有金額欄位）`,
      ].join('<br>');
    }
  } else if (metric === 'conversion') {
    html = [
      `Conversion（Purchase / Visitors）：${f.visitor_to_purchase_rate}%`,
      `Cart Conversion（Purchase / Add To Cart）：${f.cart_conversion_rate}%`,
      `Checkout Conversion（Purchase / Checkout）：${f.checkout_conversion_rate}%`,
    ].join('<br>');
  } else if (metric === 'cart_abandonment') {
    html = [
      `Cart Abandonment Visitors：${f.cart_abandonment_visitors}`,
      `（Add To Cart 訪客中，尚未 Purchase 的人數，集合差集計算）`,
      `Checkout Abandonment Visitors：${f.checkout_abandonment_visitors}`,
    ].join('<br>');
  } else if (metric === 'recommendation_risk') {
    const r = geoVisitorState.recommendationRisk;
    if (!r || !r.sufficient_data) {
      html = `<div class="geo-visitor-risk-basis">${esc((r && r.basis) || '規則式計算，非 AI')}</div><div>${esc((r && r.message) || 'Insufficient Data')}</div>`;
    } else {
      const signalLabels = {
        high_visitor_low_conversion: '高訪客低成交', high_cart_low_checkout: '高加購低結帳',
        high_checkout_low_purchase: '高結帳低購買', high_unknown: '高 Unknown',
        low_coverage: '低 Coverage', delivery_distance_too_high: '外送距離過高',
      };
      const activeSignals = Object.entries(r.signals || {}).filter(([, v]) => v).map(([k]) => signalLabels[k] || k);
      html = `<div class="geo-visitor-risk-basis">${esc(r.basis)}</div>` + (activeSignals.length ? activeSignals.map(esc).join('<br>') : '目前沒有觸發任何風險訊號');
    }
  }
  el.innerHTML = html;
}

// ════════════════════════════════════════════════════════════════
// 六、Fetch（呼叫本輪新增的唯一端點 GET /api/analytics/geo/visitor-log；
//    不是第二套 Analytics API）＋ Request Guard（沿用 Order Heatmap Engine
//    同一種「舊 request 不蓋掉新 request」防護寫法，但是獨立的 state，不
//    共用 Order Heatmap 的 requestSeq）
// ════════════════════════════════════════════════════════════════
async function geoVisitorFetchAndRender(containerId, range) {
  if (!GEO_VISITOR_TIME_RANGES.includes(range)) range = 'today';
  geoVisitorState.containerId = containerId;
  geoVisitorState.range = range;
  const seq = ++geoVisitorState.requestSeq;
  if (geoVisitorState.abortController && typeof geoVisitorState.abortController.abort === 'function') {
    geoVisitorState.abortController.abort();
  }
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  geoVisitorState.abortController = controller;
  // fix18-10-hotfix30-B5-R5.3-A7：一開始就標記 loading——即使這次是「重新
  // 整理」而非初次載入，仍先進入 loading，讓消費端（KPI 卡片）自行決定要
  // 不要在等待期間沿用上一次成功的數字（目前實作：沿用，避免閃爍；見
  // geo-intelligence.js 的 geoKpiSourceStatus() 只把「從未成功過」的
  // loading 顯示成骨架，重新整理中的 loading 不強制蓋掉畫面）。
  geoVisitorState.status = 'loading';

  let data = null;
  let requestFailed = false;
  try {
    const res = (typeof apiFetch === 'function')
      ? await apiFetch(`/api/analytics/geo/visitor-log?range=${encodeURIComponent(range)}`, { signal: controller ? controller.signal : undefined })
      : null;
    if (res && res.ok) {
      const json = await res.json();
      if (json && json.success) data = json.data;
      else requestFailed = true;
    } else {
      requestFailed = true;
    }
  } catch (e) {
    data = null;
    // AbortError 是被更新的請求正常取消，不算失敗；下面 seq 檢查會讓這次
    // 直接 return，不會誤把「被取消」顯示成「錯誤」。
    if (!(e && e.name === 'AbortError')) requestFailed = true;
  }

  if (seq !== geoVisitorState.requestSeq) return; // 舊 request，被更新的請求蓋掉

  // 既有行為（B1.2 起）：失敗時 summary/funnel/areas/recent 一律安全降級
  // 為 null/[]，不得殘留上一次成功的舊資料（本檔案既有 Panel／Ranking／
  // Recent Log 都依賴這個「失敗=空狀態」慣例，見既有 regression B8-1）。
  geoVisitorState.summary = (data && data.summary) || null;
  geoVisitorState.funnel = (data && data.funnel) || null;
  geoVisitorState.recommendationRisk = (data && data.recommendation_risk) || null;
  geoVisitorState.areas = (data && data.areas) || [];
  geoVisitorState.recent = (data && data.recent) || [];
  // fix18-10-hotfix30-B5-R5.3-A7（需求文件九、情境E）：另外新增的
  // status 欄位——失敗時標記 'error'，不得偷偷 fallback 成舊資料、也不得
  // 假裝是 0。geo-intelligence.js 的 KPI 卡片 adapter 一律先檢查
  // status==='error' 才決定要不要顯示明確錯誤（優先於 funnel 是否為
  // null），所以這裡 funnel 被清成 null 不影響 KPI 卡片正確顯示錯誤狀態。
  geoVisitorState.status = (requestFailed || !data) ? 'error' : 'ready';

  geoVisitorRenderSummaryDom();
  geoVisitorRenderCoverageDom();
  geoVisitorRenderRankingDom();
  geoVisitorRenderRecentDom();
  geoVisitorRenderMetricSummaryDom();

  // Choropleth：重用既有 Dashboard 的同一個 map instance／featureIndex
  // （不建立第二張 Leaflet map），未載入時安全略過。
  if (typeof window !== 'undefined' && window.geoMapState && window.geoMapState.instance) {
    geoVisitorRenderChoropleth(window.geoMapState.instance, window.geoMapState.featureIndex);
  }

  // fix18-10-hotfix30-B5-R5.3-A7（需求文件八：同步更新，不需要手動切
  // Heatmap Tab）：通知 geo-intelligence.js 的「Geo 訪客/加購/結帳/訂單」
  // KPI 卡片重新渲染。typeof 保護，跟本檔案其餘呼叫 geoSetMapMetric() 的
  // soft-coupling 慣例一致，未載入 geo-intelligence.js 時安全略過。
  if (typeof geoIntelligenceOnEventEngineUpdate === 'function') {
    geoIntelligenceOnEventEngineUpdate();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_VISITOR_TIME_RANGES, GEO_VISITOR_RANGE_LABEL,
    GEO_EVENT_METRICS, GEO_EVENT_METRIC_LABEL, GEO_EVENT_TO_MAP_METRIC,
    geoVisitorIsChoroplethEligible, _setChoroplethOfficialCityCodesForTest,
    geoVisitorComputeCoverage, geoVisitorBuildTooltipContent,
    geoVisitorRenderChoropleth, geoVisitorRenderSummaryDom, geoVisitorRenderCoverageDom,
    geoVisitorRenderRankingDom, geoVisitorRenderRecentDom, geoVisitorFetchAndRender,
    geoVisitorHandleStoreSwitch, geoVisitorMetricBarHtml, geoVisitorSetMetric,
    geoVisitorRenderMetricSummaryDom, _geoVisitorEmptyStateReason,
    _geoVisitorResetStateForTest,
    get geoVisitorState() { return geoVisitorState; },
  };
}
