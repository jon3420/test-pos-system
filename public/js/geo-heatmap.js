// public/js/geo-heatmap.js — fix18-10-hotfix30-B5-R5.3-A1（Geo Intelligence
// Heatmap Foundation）
//
// 依 R5.3-A1_DATA_SOURCE_AUDIT.md 的結論建立：
//   - analytics_events 完全沒有 lat/lng（Visitor GPS 尚未收集）。
//   - orders.delivery_lat/delivery_lng 是唯一真實座標來源，只存在於
//     order_mode='delivery' 且顧客當時有提供座標的訂單。
//   - district centroid 資料集不存在；矩形 fixture 禁止拿來當座標。
// 因此本檔案的座標永遠來自後端 getGeoFulfillment() 用真實
// delivery_lat/delivery_lng 算出的 AVG（見 utils/geoAnalyticsQueries.js），
// 絕不在前端生出任何座標、絕不 fallback 到 store 座標或 fixture 中心點。
// 沒有座標的行政區一律 coordinate_source='unavailable'，只進 Ranking，不上地圖
// （需求文件三）。
//
// 不建立第二套 channel resolver／第二套日期篩選狀態——沿用 Dashboard 既有的
// getGeoFunnel()/getGeoFulfillment() 回傳資料與既有 Channel/Date 篩選 UI，
// 這裡只負責「把兩份既有 API 回應合併成一份 Heatmap area 清單，並畫出
// Circle/Marker + Ranking + Summary + Coverage」。

'use strict';

function _geoHeatEsc(s) {
  if (typeof escHtml === 'function') return escHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════
// 一、常數與 Metric 定義（需求文件五、六）
// ════════════════════════════════════════════════════════════════
const GEO_HEAT_METRICS = Object.freeze(['visitors', 'add_to_cart', 'begin_checkout', 'orders', 'revenue', 'conversion']);
const GEO_HEAT_METRIC_LABEL = Object.freeze({
  visitors: 'Visitors', add_to_cart: 'Add to Cart', begin_checkout: 'Checkout',
  orders: 'Orders', revenue: 'Revenue', conversion: 'Conversion',
});
// 這三個 metric 的資料來源是 Visitor 事件（geo_city/geo_district，IP 推定），
// 目前完全沒有座標——不是「這個行政區剛好沒有」，是這個 metric 這個維度上
// 全專案都沒有任何座標可用（見 Audit 第 3 節），Coverage 結構性固定為 0。
const GEO_HEAT_METRICS_WITHOUT_COORDINATES = Object.freeze(['visitors', 'add_to_cart', 'begin_checkout']);
const GEO_HEAT_DISPLAY_MODES = Object.freeze(['circle', 'marker', 'ranking_only']);
const GEO_HEAT_CHANNELS = Object.freeze(['all', 'facebook', 'google', 'line', 'direct']);

const GEO_HEAT_COORDINATE_SOURCE_LABEL = Object.freeze({
  order_centroid: '依外送訂單位置聚合',
  unavailable: '目前尚無可用座標',
});
const GEO_HEAT_CONFIDENCE_LABEL = Object.freeze({
  high: '高', medium: '中', low: '低', unavailable: '尚無資料',
});

// ════════════════════════════════════════════════════════════════
// 二、格式化（需求文件十一：不得顯示 undefined/null/NaN/Infinity）
// ════════════════════════════════════════════════════════════════
function geoHeatSafeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function geoHeatFormatValue(value, metric) {
  const v = geoHeatSafeNumber(value);
  if (metric === 'revenue') return `NT$ ${Math.round(v).toLocaleString('zh-TW')}`;
  if (metric === 'conversion') return `${(v * 100).toFixed(1)}%`;
  return String(Math.round(v));
}

// ════════════════════════════════════════════════════════════════
// 三、Normalize / Radius / Intensity（需求文件九）
// ════════════════════════════════════════════════════════════════
function geoHeatNormalizeValue(value, min, max) {
  const v = geoHeatSafeNumber(value);
  const mn = geoHeatSafeNumber(min);
  const mx = geoHeatSafeNumber(max);
  if (mx <= mn) return v > 0 ? 1 : 0; // 全部為 0，或只有單一區域／所有值相同：只有 0 或 1，不除以 0
  const n = (v - mn) / (mx - mn);
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
const GEO_HEAT_RADIUS_RANGE = Object.freeze({ min: 8, max: 36 });
// 用 sqrt 而不是原始值做 radius 正規化——面積（而非半徑）跟數值成正比是氣泡圖
// 的標準做法，可以有效壓低 outlier（例如 revenue 遠高於其他區）把整張圖蓋掉的
// 風險，不需要另外寫死特例判斷。
function geoHeatRadius(value, stats) {
  const s = stats || {};
  const v = Math.sqrt(Math.max(0, geoHeatSafeNumber(value)));
  const mn = Math.sqrt(Math.max(0, geoHeatSafeNumber(s.min)));
  const mx = Math.sqrt(Math.max(0, geoHeatSafeNumber(s.max)));
  const n = geoHeatNormalizeValue(v, mn, mx);
  const r = GEO_HEAT_RADIUS_RANGE.min + n * (GEO_HEAT_RADIUS_RANGE.max - GEO_HEAT_RADIUS_RANGE.min);
  return Number.isFinite(r) ? Math.round(r) : GEO_HEAT_RADIUS_RANGE.min;
}
function geoHeatIntensity(value, stats) {
  const s = stats || {};
  const n = geoHeatNormalizeValue(value, s.min, s.max);
  const intensity = 0.35 + n * 0.55; // 0.35–0.90，最低也看得見、最高不會整片死白
  return Math.round(intensity * 100) / 100;
}
function geoHeatComputeStats(areas, metric) {
  const values = (areas || []).map((a) => geoHeatSafeNumber(a && a[metric]));
  if (!values.length) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

// ════════════════════════════════════════════════════════════════
// 四、顏色 Scale（需求文件十）——低綠／中黃／高橘／最高紅，Dark Theme 可讀
// ════════════════════════════════════════════════════════════════
const GEO_HEAT_LEVELS = Object.freeze([
  { key: 'low', threshold: 0, color: '#22c55e', label: '低' },
  { key: 'medium', threshold: 0.34, color: '#eab308', label: '中' },
  { key: 'high', threshold: 0.67, color: '#f97316', label: '高' },
  { key: 'peak', threshold: 0.88, color: '#ef4444', label: '最高' },
]);
function geoHeatGetLevel(normalized) {
  const n = Math.max(0, Math.min(1, geoHeatSafeNumber(normalized)));
  let level = GEO_HEAT_LEVELS[0];
  for (const l of GEO_HEAT_LEVELS) { if (n >= l.threshold) level = l; }
  return level;
}
// metric 參數保留：conversion 之後如需獨立門檻，只需要在這裡加一個 metric 專用
// threshold table，呼叫端（geoHeatGetStyle/geoHeatGetLegend）不必改——「仍由
// 同一 helper 管理」（需求文件十）。目前六個 metric 共用同一組門檻。
function geoHeatGetStyle(metric, normalized, selected) {
  const level = geoHeatGetLevel(normalized);
  return {
    fillColor: level.color,
    color: selected ? '#f8fafc' : '#111827',
    weight: selected ? 3 : 1.5,
    opacity: 0.95,
    fillOpacity: 0.35 + Math.max(0, Math.min(1, geoHeatSafeNumber(normalized))) * 0.55,
  };
}
function geoHeatGetLegend(metric, stats) {
  const s = stats || {};
  return GEO_HEAT_LEVELS.map((l) => ({
    key: l.key,
    label: l.label,
    color: l.color,
    metric_label: GEO_HEAT_METRIC_LABEL[metric] || metric,
  }));
}

// ════════════════════════════════════════════════════════════════
// 五、Coverage（需求文件七、八）——兩種不同用途，不得混用
// ════════════════════════════════════════════════════════════════
// 5a. 單一行政區的 Coverage（Tooltip 用）：這個行政區的履約紀錄裡，有多少
//     比例真的帶有座標。
function geoHeatComputeAreaCoverage(area) {
  const a = area || {};
  const submitted = geoHeatSafeNumber(a.submitted_orders);
  const coordCount = geoHeatSafeNumber(a.coordinate_count);
  if (submitted <= 0) return 0;
  return Math.round((coordCount / submitted) * 10000) / 100;
}
// 5b. 全店、依 metric 分的 Coverage（Coverage Card 用）：visitors/add_to_cart/
//     begin_checkout 結構性固定 0%（這個維度完全沒有座標收集機制，不是資料
//     剛好缺，是功能還沒做——見 GEO_HEAT_METRICS_WITHOUT_COORDINATES）；
//     orders/revenue/conversion 用「全店有座標的訂單數 / 全店履約紀錄數」。
function geoHeatComputeMetricCoverage(areas, metric) {
  if (GEO_HEAT_METRICS_WITHOUT_COORDINATES.includes(metric)) return 0;
  const list = areas || [];
  const totalSubmitted = list.reduce((sum, a) => sum + geoHeatSafeNumber(a.submitted_orders), 0);
  const totalCoord = list.reduce((sum, a) => sum + geoHeatSafeNumber(a.coordinate_count), 0);
  if (totalSubmitted <= 0) return 0;
  return Math.round((totalCoord / totalSubmitted) * 10000) / 100;
}

// ════════════════════════════════════════════════════════════════
// 六、合併 getGeoFunnel()／getGeoFulfillment() 的既有回應成一份 area 清單
//    （需求文件五：不建第二套 API，只在這裡做合併）
// ════════════════════════════════════════════════════════════════
function _geoHeatAreaKey(city, district) { return `${city || ''}|${district || ''}`; }
function _geoHeatBlankArea(city, district) {
  return {
    area_id: `district:${district || city || 'unknown'}`,
    area_name: district || city || '未知區域',
    city: city || null,
    district: district || null,
    visitors: 0, add_to_cart: 0, begin_checkout: 0,
    orders: 0, revenue: 0, submitted_orders: 0, coordinate_count: 0,
    lat: null, lng: null,
    coordinate_source: 'unavailable', coordinate_confidence: 'unavailable',
  };
}
function geoHeatBuildAreas(funnelAreas, fulfillmentAreas) {
  const map = new Map();
  (funnelAreas || []).forEach((r) => {
    if (!r) return;
    const key = _geoHeatAreaKey(r.city, r.district);
    const entry = map.get(key) || _geoHeatBlankArea(r.city, r.district);
    entry.visitors = geoHeatSafeNumber(r.visitors);
    entry.add_to_cart = geoHeatSafeNumber(r.add_to_cart_visitors);
    entry.begin_checkout = geoHeatSafeNumber(r.begin_checkout_visitors);
    map.set(key, entry);
  });
  (fulfillmentAreas || []).forEach((r) => {
    if (!r) return;
    const key = _geoHeatAreaKey(r.city, r.district);
    const entry = map.get(key) || _geoHeatBlankArea(r.city, r.district);
    entry.orders = geoHeatSafeNumber(r.completed_orders);
    entry.revenue = geoHeatSafeNumber(r.revenue);
    entry.submitted_orders = geoHeatSafeNumber(r.submitted_orders);
    entry.coordinate_count = geoHeatSafeNumber(r.coordinate_count);
    // coordinate_source 只信任後端算好的值——這裡不重新判斷「有沒有座標」，
    // 避免前後端各自維護一套判斷邏輯而不一致（見需求文件四：唯一合法來源）。
    entry.coordinate_source = r.coordinate_source === 'order_centroid' ? 'order_centroid' : 'unavailable';
    entry.coordinate_confidence = r.coordinate_confidence || 'unavailable';
    entry.lat = (typeof r.lat === 'number' && Number.isFinite(r.lat)) ? r.lat : null;
    entry.lng = (typeof r.lng === 'number' && Number.isFinite(r.lng)) ? r.lng : null;
    map.set(key, entry);
  });
  return Array.from(map.values()).map((a) => {
    // conversion：visitors=0 時強制為 0，不得 Infinity/NaN（需求文件六）。
    const conversion = a.visitors > 0 ? a.orders / a.visitors : 0;
    return { ...a, conversion: Number.isFinite(conversion) ? conversion : 0 };
  });
}

// ════════════════════════════════════════════════════════════════
// 七、Ranking / Summary（需求文件九、十）
// ════════════════════════════════════════════════════════════════
function geoHeatBuildRanking(areas, metric) {
  const list = (areas || []).slice();
  const stats = geoHeatComputeStats(list, metric);
  const maxV = stats.max || 0;
  return list
    .map((a) => ({
      area_id: a.area_id,
      area_name: a.area_name,
      value: geoHeatSafeNumber(a[metric]),
      ratio: maxV > 0 ? Math.max(0, Math.min(1, geoHeatSafeNumber(a[metric]) / maxV)) : 0,
      visitors: a.visitors, orders: a.orders, conversion: a.conversion,
      has_coordinate: a.coordinate_source === 'order_centroid',
    }))
    .sort((x, y) => y.value - x.value);
}
function _geoHeatTop(areas, metric) {
  const ranked = geoHeatBuildRanking(areas, metric);
  return ranked.length ? ranked[0] : null;
}
function geoHeatBuildSummary(areas) {
  const list = areas || [];
  const withCoord = list.filter((a) => a.coordinate_source === 'order_centroid');
  return {
    top_visitors: _geoHeatTop(list, 'visitors'),
    top_orders: _geoHeatTop(list, 'orders'),
    top_revenue: _geoHeatTop(list, 'revenue'),
    top_conversion: _geoHeatTop(list, 'conversion'),
    areas_with_coordinate: withCoord.length,
    areas_without_coordinate: list.length - withCoord.length,
    coverage_by_metric: GEO_HEAT_METRICS.reduce((acc, m) => {
      acc[m] = geoHeatComputeMetricCoverage(list, m);
      return acc;
    }, {}),
  };
}

// ════════════════════════════════════════════════════════════════
// 八、Tooltip（需求文件七）——不得顯示 undefined/null/NaN/Infinity
// ════════════════════════════════════════════════════════════════
function geoHeatBuildTooltipContent(area, channelLabel) {
  const a = area || {};
  const lines = [
    a.area_name || '未知區域',
    `Visitors：${geoHeatFormatValue(a.visitors, 'visitors')}`,
    `Add to Cart：${geoHeatFormatValue(a.add_to_cart, 'add_to_cart')}`,
    `Checkout：${geoHeatFormatValue(a.begin_checkout, 'begin_checkout')}`,
    `Orders：${geoHeatFormatValue(a.orders, 'orders')}`,
    `Revenue：${geoHeatFormatValue(a.revenue, 'revenue')}`,
    `Conversion：${geoHeatFormatValue(a.conversion, 'conversion')}`,
    `Channel：${channelLabel || '全部'}`,
    `座標來源：${GEO_HEAT_COORDINATE_SOURCE_LABEL[a.coordinate_source] || GEO_HEAT_COORDINATE_SOURCE_LABEL.unavailable}`,
    `資料準確度：${GEO_HEAT_CONFIDENCE_LABEL[a.coordinate_confidence] || GEO_HEAT_CONFIDENCE_LABEL.unavailable}`,
    `Coverage：${geoHeatComputeAreaCoverage(a)}%`,
  ];
  return lines.map(_geoHeatEsc).join('<br>');
}

// ════════════════════════════════════════════════════════════════
// 九、Runtime 狀態 + Leaflet 繪製（需求文件十一～十五、十八）
// ════════════════════════════════════════════════════════════════
let geoHeatState = {
  instance: null,        // 沿用 geo-intelligence-map.js 既有的同一個 Leaflet map instance，不重建
  layerGroup: null,      // L.layerGroup，clearLayers() 更新，不 destroy/recreate（需求文件十五）
  containerId: null,
  metric: 'orders',
  display: 'circle',     // circle | marker | ranking_only
  channel: 'all',
  areas: [],
  selectedAreaId: null,
  requestSeq: 0,
  abortController: null,
  debounceTimer: null,
};
function _geoHeatExposeWindowState() {
  if (typeof window !== 'undefined') window.geoHeatState = geoHeatState;
}
_geoHeatExposeWindowState();
function _geoHeatResetStateForTest() {
  geoHeatState.instance = null;
  geoHeatState.layerGroup = null;
  geoHeatState.containerId = null;
  geoHeatState.metric = 'orders';
  geoHeatState.display = 'circle';
  geoHeatState.channel = 'all';
  geoHeatState.areas = [];
  geoHeatState.selectedAreaId = null;
  geoHeatState.requestSeq = 0;
  geoHeatState.abortController = null;
  if (geoHeatState.debounceTimer) clearTimeout(geoHeatState.debounceTimer);
  geoHeatState.debounceTimer = null;
  _geoHeatExposeWindowState();
}

// 需求文件十五：Store 切換——清 heat layer、selection、pending request，
// 沿用既有 B2/B3 Store Isolation 慣例（跟 geo-intelligence-map.js 的
// _geoResetMapStateForTest() 同一個模式：不重建 map instance，只清狀態）。
function geoHeatHandleStoreSwitch() {
  if (geoHeatState.abortController && typeof geoHeatState.abortController.abort === 'function') {
    geoHeatState.abortController.abort();
  }
  geoHeatState.abortController = null;
  geoHeatState.selectedAreaId = null;
  geoHeatState.areas = [];
  geoHeatState.requestSeq += 1;
  if (geoHeatState.layerGroup && typeof geoHeatState.layerGroup.clearLayers === 'function') {
    geoHeatState.layerGroup.clearLayers();
  }
}

function geoHeatEnsureLayerGroup(leafletMapInstance) {
  if (geoHeatState.layerGroup) return geoHeatState.layerGroup;
  if (typeof L === 'undefined' || typeof L.layerGroup !== 'function') return null;
  geoHeatState.layerGroup = L.layerGroup();
  if (leafletMapInstance && typeof geoHeatState.layerGroup.addTo === 'function') {
    geoHeatState.layerGroup.addTo(leafletMapInstance);
  }
  return geoHeatState.layerGroup;
}

// 需求文件十八：clearLayers() 更新，不重建 group／map／tile；只畫有真實座標
// 的行政區（coordinate_source === 'order_centroid'），其餘留給 Ranking。
function geoHeatRenderLayer(areas, metric, display) {
  const group = geoHeatState.layerGroup;
  if (!group || typeof group.clearLayers !== 'function') return;
  group.clearLayers();
  if (display === 'ranking_only') return;
  const plottable = (areas || []).filter((a) => a.coordinate_source === 'order_centroid' && typeof a.lat === 'number' && typeof a.lng === 'number');
  const stats = geoHeatComputeStats(plottable, metric);
  plottable.forEach((area) => {
    const value = geoHeatSafeNumber(area[metric]);
    const normalized = geoHeatNormalizeValue(value, stats.min, stats.max);
    const selected = geoHeatState.selectedAreaId === area.area_id;
    const style = geoHeatGetStyle(metric, normalized, selected);
    let marker = null;
    if (display === 'marker' && typeof L !== 'undefined' && typeof L.marker === 'function') {
      marker = L.marker([area.lat, area.lng]);
    } else if (typeof L !== 'undefined' && typeof L.circleMarker === 'function') {
      marker = L.circleMarker([area.lat, area.lng], { ...style, radius: geoHeatRadius(value, stats) });
    }
    if (!marker) return;
    if (typeof marker.bindTooltip === 'function') marker.bindTooltip(geoHeatBuildTooltipContent(area, GEO_HEAT_CHANNEL_LABEL(geoHeatState.channel)));
    if (typeof marker.on === 'function') {
      marker.on('click', () => { geoHeatState.selectedAreaId = area.area_id; geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display); _geoHeatRenderRankingDom(); });
    }
    if (typeof group.addLayer === 'function') group.addLayer(marker);
  });
}
function GEO_HEAT_CHANNEL_LABEL(channel) {
  const labels = { all: '全部', facebook: 'Facebook', google: 'Google', line: 'LINE', direct: 'Direct / Organic' };
  return labels[channel] || '全部';
}

// 需求文件十三：點 Ranking → panTo 對應熱點；無座標時顯示提示，不丟 Error。
function geoHeatSelectArea(areaId) {
  geoHeatState.selectedAreaId = geoHeatState.selectedAreaId === areaId ? null : areaId;
  const area = (geoHeatState.areas || []).find((a) => a.area_id === areaId);
  geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
  _geoHeatRenderRankingDom();
  if (!area || area.coordinate_source !== 'order_centroid') {
    return { ok: true, panned: false, message: '目前尚無可用座標' };
  }
  if (geoHeatState.instance && typeof geoHeatState.instance.panTo === 'function') {
    geoHeatState.instance.panTo([area.lat, area.lng]);
  }
  return { ok: true, panned: true };
}

// ════════════════════════════════════════════════════════════════
// 十、DOM 渲染（Ranking／Summary／Coverage／Legend，需求文件八～十、十六）
// ════════════════════════════════════════════════════════════════
function _geoHeatRenderRankingDom() {
  if (typeof document === 'undefined' || !geoHeatState.containerId) return;
  const el = document.getElementById(`${geoHeatState.containerId}-ranking`);
  if (!el) return;
  const ranking = geoHeatBuildRanking(geoHeatState.areas, geoHeatState.metric);
  el.innerHTML = ranking.map((r, i) => {
    const selected = geoHeatState.selectedAreaId === r.area_id;
    const noCoord = !r.has_coordinate ? `<span class="geo-heat-no-coord">目前尚無可用座標</span>` : '';
    return `<li role="option" tabindex="0" aria-selected="${selected ? 'true' : 'false'}" data-area-id="${_geoHeatEsc(r.area_id)}" class="geo-heat-rank-item${selected ? ' is-selected' : ''}">`
      + `<span class="geo-heat-rank-index">${i + 1}</span>`
      + `<span class="geo-heat-rank-name">${_geoHeatEsc(r.area_name)}</span>`
      + `<span class="geo-heat-rank-bar" style="width:${Math.round(r.ratio * 100)}%"></span>`
      + `<span class="geo-heat-rank-value">${_geoHeatEsc(geoHeatFormatValue(r.value, geoHeatState.metric))}</span>`
      + noCoord
      + `</li>`;
  }).join('');
}
function _geoHeatRenderSummaryDom() {
  if (typeof document === 'undefined' || !geoHeatState.containerId) return;
  const el = document.getElementById(`${geoHeatState.containerId}-summary`);
  if (!el) return;
  const s = geoHeatBuildSummary(geoHeatState.areas);
  const line = (label, top, metric) => top ? `${label}：${_geoHeatEsc(top.area_name)} ${_geoHeatEsc(geoHeatFormatValue(top.value, metric))}` : `${label}：${geoHeatStatusText('empty')}`;
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = [
    line('熱度最高', s.top_visitors, 'visitors'),
    line('最高成交', s.top_orders, 'orders'),
    line('最高營收', s.top_revenue, 'revenue'),
    line('最高轉換', s.top_conversion, 'conversion'),
    `有座標行政區數：${s.areas_with_coordinate}`,
    `無座標行政區數：${s.areas_without_coordinate}`,
  ].join('<br>');
}
function geoHeatStatusText(key) {
  const messages = { empty: '目前沒有可顯示的熱區資料' };
  return messages[key] || '';
}
function _geoHeatRenderCoverageCardDom() {
  if (typeof document === 'undefined' || !geoHeatState.containerId) return;
  const el = document.getElementById(`${geoHeatState.containerId}-coverage`);
  if (!el) return;
  const s = geoHeatBuildSummary(geoHeatState.areas);
  el.innerHTML = GEO_HEAT_METRICS.map((m) => {
    const pct = s.coverage_by_metric[m];
    const note = GEO_HEAT_METRICS_WITHOUT_COORDINATES.includes(m) ? '（尚未收集訪客座標）' : '依外送訂單位置聚合';
    return `<div class="geo-heat-coverage-item" data-metric="${_geoHeatEsc(m)}"><span class="geo-heat-coverage-label">${_geoHeatEsc(GEO_HEAT_METRIC_LABEL[m])} Coverage</span><span class="geo-heat-coverage-value">${pct}%</span><span class="geo-heat-coverage-note">${_geoHeatEsc(note)}</span></div>`;
  }).join('');
}
function _geoHeatRenderLegendDom() {
  if (typeof document === 'undefined' || !geoHeatState.containerId) return;
  const el = document.getElementById(`${geoHeatState.containerId}-heat-legend`);
  if (!el) return;
  const legend = geoHeatGetLegend(geoHeatState.metric, geoHeatComputeStats(geoHeatState.areas, geoHeatState.metric));
  el.innerHTML = legend.map((l) => `<span class="geo-heat-legend-item"><i style="background:${_geoHeatEsc(l.color)}"></i>${_geoHeatEsc(l.label)}</span>`).join('');
}

// ════════════════════════════════════════════════════════════════
// 十一、Request Guard + Debounce（需求文件十八）
// ════════════════════════════════════════════════════════════════
function geoHeatScheduleUpdate(fetchAreasFn, delayMs) {
  if (geoHeatState.debounceTimer) clearTimeout(geoHeatState.debounceTimer);
  const seq = ++geoHeatState.requestSeq;
  geoHeatState.debounceTimer = setTimeout(async () => {
    if (geoHeatState.abortController && typeof geoHeatState.abortController.abort === 'function') geoHeatState.abortController.abort();
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    geoHeatState.abortController = controller;
    let areas = [];
    try {
      areas = await fetchAreasFn(controller ? controller.signal : undefined);
    } catch (e) {
      areas = [];
    }
    if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition
    geoHeatState.areas = areas || [];
    geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
    _geoHeatRenderRankingDom();
    _geoHeatRenderSummaryDom();
    _geoHeatRenderCoverageCardDom();
    _geoHeatRenderLegendDom();
  }, typeof delayMs === 'number' ? delayMs : 250);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_HEAT_METRICS, GEO_HEAT_METRIC_LABEL, GEO_HEAT_METRICS_WITHOUT_COORDINATES,
    GEO_HEAT_DISPLAY_MODES, GEO_HEAT_CHANNELS, GEO_HEAT_RADIUS_RANGE, GEO_HEAT_LEVELS,
    GEO_HEAT_COORDINATE_SOURCE_LABEL, GEO_HEAT_CONFIDENCE_LABEL,
    geoHeatSafeNumber, geoHeatFormatValue,
    geoHeatNormalizeValue, geoHeatRadius, geoHeatIntensity, geoHeatComputeStats,
    geoHeatGetLevel, geoHeatGetStyle, geoHeatGetLegend,
    geoHeatComputeAreaCoverage, geoHeatComputeMetricCoverage,
    geoHeatBuildAreas, geoHeatBuildRanking, geoHeatBuildSummary, geoHeatBuildTooltipContent,
    geoHeatHandleStoreSwitch, geoHeatEnsureLayerGroup, geoHeatRenderLayer, geoHeatSelectArea,
    geoHeatScheduleUpdate, geoHeatStatusText, GEO_HEAT_CHANNEL_LABEL,
    _geoHeatResetStateForTest, _geoHeatRenderRankingDom, _geoHeatRenderSummaryDom,
    _geoHeatRenderCoverageCardDom, _geoHeatRenderLegendDom,
    get geoHeatState() { return geoHeatState; },
  };
}
