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

const GEO_VISITOR_TIME_RANGES = Object.freeze(['5m', '30m', 'today', '7d', '30d']);
const GEO_VISITOR_RANGE_LABEL = Object.freeze({
  '5m': '近 5 分鐘', '30m': '近 30 分鐘', today: '今日', '7d': '近 7 天', '30d': '近 30 天',
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
  summary: null,
  areas: [],
  recent: [],
  choroplethLayerGroup: null, // 獨立 layerGroup，跟既有 Dashboard 的 geoJsonLayer 分開，避免互相覆蓋
  requestSeq: 0,
  abortController: null,
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
  geoVisitorState.areas = [];
  geoVisitorState.recent = [];
  geoVisitorState.requestSeq += 1;
  if (geoVisitorState.choroplethLayerGroup && typeof geoVisitorState.choroplethLayerGroup.clearLayers === 'function') {
    geoVisitorState.choroplethLayerGroup.clearLayers();
  }
}

function _geoVisitorResetStateForTest() {
  geoVisitorState.containerId = null;
  geoVisitorState.range = 'today';
  geoVisitorState.summary = null;
  geoVisitorState.areas = [];
  geoVisitorState.recent = [];
  if (geoVisitorState.choroplethLayerGroup && typeof geoVisitorState.choroplethLayerGroup.clearLayers === 'function') {
    geoVisitorState.choroplethLayerGroup.clearLayers();
  }
  geoVisitorState.choroplethLayerGroup = null;
  geoVisitorState.requestSeq = 0;
  geoVisitorState.abortController = null;
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
function geoVisitorRenderRankingDom() {
  const el = _geoVisitorEl('visitor-ranking');
  if (!el) return;
  const list = (geoVisitorState.areas || []).slice().sort((a, b) => b.visitor_count - a.visitor_count);
  el.innerHTML = list.map((a) => {
    const name = a.is_unknown ? 'Unknown' : `${a.city || ''}${a.district || ''}`;
    const noCoord = a.is_unknown ? '' : `<span class="geo-visitor-approx">（行政區推定）</span>`;
    return `<li class="geo-visitor-rank-item"><span class="geo-visitor-rank-name">${_geoVisitorEsc(name)}</span>${noCoord}<span class="geo-visitor-rank-value">${_geoVisitorEsc(String(a.visitor_count))}</span></li>`;
  }).join('');
}
function geoVisitorRenderRecentDom() {
  const el = _geoVisitorEl('visitor-recent');
  if (!el) return;
  const list = geoVisitorState.recent || [];
  if (!list.length) { el.innerHTML = `<div class="geo-visitor-recent-empty">目前沒有訪客紀錄</div>`; return; }
  el.innerHTML = list.map((r) => {
    const name = r.is_unknown ? 'Unknown' : `${r.city || ''}${r.district || ''}`;
    return `<div class="geo-visitor-recent-row"><span class="geo-visitor-recent-time">${_geoVisitorEsc(r.event_time)}</span><span class="geo-visitor-recent-area">${_geoVisitorEsc(name)}</span><span class="geo-visitor-recent-event">${_geoVisitorEsc(r.event_name)}</span><span class="geo-visitor-recent-source">${_geoVisitorEsc(r.source === 'ip' ? 'Analytics Sync' : (r.source || 'Analytics Sync'))}</span></div>`;
  }).join('');
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

  let data = null;
  try {
    const res = (typeof apiFetch === 'function')
      ? await apiFetch(`/api/analytics/geo/visitor-log?range=${encodeURIComponent(range)}`, { signal: controller ? controller.signal : undefined })
      : null;
    if (res && res.ok) {
      const json = await res.json();
      if (json && json.success) data = json.data;
    }
  } catch (e) { data = null; }

  if (seq !== geoVisitorState.requestSeq) return; // 舊 request，被更新的請求蓋掉

  geoVisitorState.summary = (data && data.summary) || null;
  geoVisitorState.areas = (data && data.areas) || [];
  geoVisitorState.recent = (data && data.recent) || [];

  geoVisitorRenderSummaryDom();
  geoVisitorRenderCoverageDom();
  geoVisitorRenderRankingDom();
  geoVisitorRenderRecentDom();

  // Choropleth：重用既有 Dashboard 的同一個 map instance／featureIndex
  // （不建立第二張 Leaflet map），未載入時安全略過。
  if (typeof window !== 'undefined' && window.geoMapState && window.geoMapState.instance) {
    geoVisitorRenderChoropleth(window.geoMapState.instance, window.geoMapState.featureIndex);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_VISITOR_TIME_RANGES, GEO_VISITOR_RANGE_LABEL,
    geoVisitorIsChoroplethEligible, _setChoroplethOfficialCityCodesForTest,
    geoVisitorComputeCoverage, geoVisitorBuildTooltipContent,
    geoVisitorRenderChoropleth, geoVisitorRenderSummaryDom, geoVisitorRenderCoverageDom,
    geoVisitorRenderRankingDom, geoVisitorRenderRecentDom, geoVisitorFetchAndRender,
    geoVisitorHandleStoreSwitch,
    _geoVisitorResetStateForTest,
    get geoVisitorState() { return geoVisitorState; },
  };
}
