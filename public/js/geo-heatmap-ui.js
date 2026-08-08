// public/js/geo-heatmap-ui.js — fix18-10-hotfix30-B5-R5.3-A1.1
// Geo Intelligence Heatmap Dashboard Integration Layer
//
// 這個檔案「不是」Heatmap Engine——public/js/geo-heatmap.js（Engine）本輪
// 完全沒有被修改，所有 pure helper／state／render function 都是 R5.3-A1
// 既有的原班人馬（geoHeatBuildAreas/geoHeatRenderLayer/geoHeatSelectArea/
// geoHeatScheduleUpdate/...）。本檔案唯一的職責是「接線」：
//
//   1. 在既有 Geo Dashboard 版面加一個正式存在、可切換的 Heatmap Tab
//      （需求文件三），不是 Placeholder。
//   2. 把既有 getGeoFunnel() 與（本輪新增的前端 fetch wrapper）
//      getGeoFulfillmentForHeatmap() 回應餵給 Engine 既有的
//      geoHeatBuildAreas()——沒有新增 Heatmap API，`/api/analytics/geo/*`
//      既有兩支端點就是唯一資料來源（需求文件五）。
//   3. 重用 geo-intelligence-map.js 既有的同一個 Leaflet map instance
//      （geoMapState.instance）畫 Circle/Marker，不建立第二個地圖、
//      不 Destroy Tile／Map（需求文件六）。
//   4. Channel 篩選一律讀寫既有 Dashboard 的 av2Channel（沿用既有
//      av2SetChannel()），不建立第二套篩選狀態（需求文件四、五）。
//
// 跟 geo-intelligence.js／geo-intelligence-map.js 同一套 classic <script>
// 共用作用域慣例（不是 ES Module）。若 window.L／geoMapState／
// geo-heatmap.js 尚未載入，所有函式一律安全降級（不丟例外），跟既有
// geoRenderMapBlock() 的 guard 慣例一致。
'use strict';

const GEO_HEAT_UI_TABS = Object.freeze([
  ['dashboard', '儀表板'],
  ['heatmap', 'Heatmap'],
]);
const GEO_HEAT_UI_DISPLAY_LABEL = Object.freeze({ circle: 'Circle', marker: 'Marker', ranking_only: 'Ranking Only' });
const GEO_HEAT_UI_MESSAGES = Object.freeze({
  loading: '載入中…',
  error: '目前無法載入 Heatmap 資料，請稍後重試',
  toggle_on: 'On',
  toggle_off: 'Off',
});

// ════════════════════════════════════════════════════════════════
// 一、UI 狀態（跟 Engine 的 geoHeatState 分開——這裡只管 Tab／Panel／
//    Enable Toggle，不重複 Engine 已經有的 metric/display/channel/areas）
// ════════════════════════════════════════════════════════════════
let geoHeatUiState = {
  activeTab: 'dashboard',
  enabled: true,
  containerId: null,
  mapContainerId: null,
  // fix18-10-hotfix30-B5-R5.3-A1.2（Analytics Visitor Geo Sync）：新增的
  // Layer 切換，預設 'order'——不影響任何既有行為（原本沒有這個欄位時，
  // Heatmap 分頁一律等同現在的 'order' 呈現）。'visitor' 是全新加入的
  // Visitor Layer（見 public/js/geo-visitor-layer.js），跟 Order Heatmap
  // 完全獨立的 state／資料來源，互不影響。
  layer: 'order',
  visitorRange: 'today',
  // fix18-10-hotfix30-B5-R5.4-G1.3：目前全域 Metric 若沒有對應的 Order
  // Heatmap Metric（購物車放棄／建議風險），記錄是哪一個，供 Coverage
  // Explanation 顯示明確提示；null 代表目前全域 Metric 有正常對應。
  unmappedGlobalMetric: null,
};
function _geoHeatUiExposeWindowState() {
  if (typeof window !== 'undefined') window.geoHeatUiState = geoHeatUiState;
}
_geoHeatUiExposeWindowState();
function _geoHeatUiResetStateForTest() {
  geoHeatUiState.activeTab = 'dashboard';
  geoHeatUiState.enabled = true;
  geoHeatUiState.containerId = null;
  geoHeatUiState.mapContainerId = null;
  geoHeatUiState.layer = 'order';
  geoHeatUiState.visitorRange = 'today';
  geoHeatUiState.unmappedGlobalMetric = null;
  _geoHeatUiExposeWindowState();
}

function _geoHeatUiEsc(s) {
  if (typeof escHtml === 'function') return escHtml(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════
// 二、Tab Bar（需求文件三）——正式存在、可切換，不是 Placeholder
// ════════════════════════════════════════════════════════════════
function geoHeatUiRenderTabBar(containerId) {
  const tabs = GEO_HEAT_UI_TABS.map(([key, label]) => {
    const active = geoHeatUiState.activeTab === key;
    return `<button type="button" role="tab" id="${_geoHeatUiEsc(containerId)}-tab-${_geoHeatUiEsc(key)}"
      aria-selected="${active}" tabindex="${active ? '0' : '-1'}"
      class="geo-heat-tab-btn${active ? ' is-active' : ''}"
      onclick="geoHeatUiSwitchTab('${_geoHeatUiEsc(containerId)}','${_geoHeatUiEsc(key)}')">${_geoHeatUiEsc(label)}</button>`;
  }).join('');
  return `<div class="geo-heat-tabbar" role="tablist" aria-label="Geo Intelligence 檢視切換">${tabs}</div>`;
}

function geoHeatUiSwitchTab(containerId, tab) {
  if (!GEO_HEAT_UI_TABS.some(([k]) => k === tab)) return false;
  geoHeatUiState.activeTab = tab;
  if (typeof document !== 'undefined') {
    GEO_HEAT_UI_TABS.forEach(([key]) => {
      const btn = document.getElementById(`${containerId}-tab-${key}`);
      if (btn) {
        btn.setAttribute('aria-selected', String(key === tab));
        btn.setAttribute('tabindex', key === tab ? '0' : '-1');
        btn.classList.toggle('is-active', key === tab);
      }
      const panel = document.getElementById(`${containerId}-panel-${key}`);
      if (panel) panel.hidden = key !== tab;
    });
  }
  if (tab === 'heatmap') {
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE Stage 5：進 Heatmap
    // 前，先讓 Dashboard GA4 Overlay 交出地圖（移除自己的 layerGroup、abort
    // 自己 pending 的 request），不得殘留進 Heatmap（需求文件十八）。
    if (typeof geoDashboardGa4Deactivate === 'function') {
      const map = window.geoMapState && window.geoMapState.instance;
      geoDashboardGa4Deactivate(map);
    }
    _geoHeatUiEnsureMapReuse(containerId);
    _geoHeatUiBindRankingEvents(containerId);
    geoHeatUiFetchAndRender(containerId);
    // fix18-10-hotfix30-B5-R5.3-A3：同 geoHeatUiRegisterContext() 的修正
    // ——切到 Heatmap 分頁時就主動抓一次 Geo Event Engine 資料，不等使用者
    // 手動切到 Visitor Layer 才抓，避免看起來像「Geo 全部是 0」。
    if (typeof geoVisitorFetchAndRender === 'function') {
      geoVisitorFetchAndRender(containerId, geoHeatUiState.visitorRange);
    }
    if (typeof geoInvalidateMapSize === 'function') setTimeout(() => { try { geoInvalidateMapSize(); } catch (e) {} }, 30);
  } else {
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：切回 Dashboard
    // 分頁前，先把 Heatmap 端加到共用地圖上的所有 LayerGroup／timer／
    // pending request 清掉，再重畫 choropleth（見
    // R5.4-G1.6-GA4-H1.4-MAP-STATE_REALITY_AUDIT.md 章節 H：Root Cause
    // 就是這裡過去只呼叫 _geoHeatUiRestoreChoropleth()，從沒做過
    // cleanup）。
    _geoHeatUiCleanupForDashboard(containerId);
    _geoHeatUiRestoreChoropleth();
    // Stage 5：Heatmap cleanup 完成、choropleth 恢復後，才啟動 Dashboard
    // 自己的 GA4 Overlay（讀自己的 persisted range，不會拿到 Heatmap H1
    // 剛剛用過的 markerGroup——那個已經在上面 cleanup 步驟被移除／destroy）。
    if (typeof geoDashboardGa4Activate === 'function') {
      const map = window.geoMapState && window.geoMapState.instance;
      geoDashboardGa4Activate(_geoHeatUiDashboardGa4Ids(containerId), map);
    }
    if (typeof geoInvalidateMapSize === 'function') setTimeout(() => { try { geoInvalidateMapSize(); } catch (e) {} }, 30);
  }
  return true;
}

// _geoHeatUiDashboardGa4Ids()——Dashboard GA4 Overlay 需要的 DOM id 組合，
// 命名沿用既有 `${containerId}-xxx` 慣例（跟 geoGa4H1RenderToolbar 的
// `${containerId}-ga4-h1-toolbar` 同一套風格）。實際容器由
// public/js/geo-intelligence.js 的 Dashboard Panel HTML 建立。
function _geoHeatUiDashboardGa4Ids(containerId) {
  return {
    containerId,
    rangeMount: `${containerId}-dashboard-ga4-range`,
    label: `${containerId}-dashboard-ga4-label`,
    status: `${containerId}-dashboard-ga4-status`,
  };
}

// ════════════════════════════════════════════════════════════════
// 三、Map 重用（需求文件六）——不建立第二個 Leaflet map／不 Destroy Tile
// ════════════════════════════════════════════════════════════════
function _geoHeatUiEnsureMapReuse(containerId) {
  const mapInstance = (typeof geoMapState !== 'undefined' && geoMapState) ? geoMapState.instance : null;
  if (!mapInstance || typeof geoHeatEnsureLayerGroup !== 'function') return false;
  geoHeatState.instance = mapInstance;
  geoHeatState.containerId = containerId;
  geoHeatEnsureLayerGroup(mapInstance);
  // 切到 Heatmap 時把既有 Choropleth GeoJSON layer 調淡，避免兩層視覺打架；
  // 只調樣式，不 remove()／不 destroy map／不 destroy tile。
  if (geoMapState.geoJsonLayer && typeof geoMapState.geoJsonLayer.setStyle === 'function') {
    try { geoMapState.geoJsonLayer.setStyle({ opacity: 0.12, fillOpacity: 0.05 }); } catch (e) { /* 安靜失敗，不擋 Heatmap 渲染 */ }
  }
  return true;
}
function _geoHeatUiRestoreChoropleth() {
  if (typeof geoMapState === 'undefined' || !geoMapState || !geoMapState.geoJsonLayer) return;
  if (typeof geoUpdateMapData === 'function') {
    try { geoUpdateMapData(geoMapState.rows, geoMapState.metric); } catch (e) { /* 安靜失敗 */ }
  }
}

// ════════════════════════════════════════════════════════════════
// 四、Control Bar（需求文件四）——Metric／Display／Channel／Heatmap On-Off
//    全部沿用既有 Engine state（geoHeatState）與既有 Dashboard 篩選
//    （av2Channel），不新增第二套狀態。
// ════════════════════════════════════════════════════════════════
function geoHeatUiControlBarHtml() {
  const curChannel = (typeof av2Channel !== 'undefined' && av2Channel) ? av2Channel : 'all';
  const metricBtns = GEO_HEAT_METRICS.map((m) => `<button type="button" class="geo-heat-ctl-btn" data-geo-heat-metric="${_geoHeatUiEsc(m)}"
    aria-pressed="${geoHeatState.metric === m}" onclick="geoHeatUiSetMetric('${_geoHeatUiEsc(m)}')">${_geoHeatUiEsc(GEO_HEAT_METRIC_LABEL[m])}</button>`).join('');
  const displayBtns = GEO_HEAT_DISPLAY_MODES.map((d) => `<button type="button" class="geo-heat-ctl-btn" data-geo-heat-display="${_geoHeatUiEsc(d)}"
    aria-pressed="${geoHeatState.display === d}" onclick="geoHeatUiSetDisplay('${_geoHeatUiEsc(d)}')">${_geoHeatUiEsc(GEO_HEAT_UI_DISPLAY_LABEL[d])}</button>`).join('');
  const channelBtns = GEO_HEAT_CHANNELS.map((c) => `<button type="button" class="geo-heat-ctl-btn" data-geo-heat-channel="${_geoHeatUiEsc(c)}"
    aria-pressed="${curChannel === c}" onclick="geoHeatUiSetChannel('${_geoHeatUiEsc(c)}')">${_geoHeatUiEsc(GEO_HEAT_CHANNEL_LABEL(c))}</button>`).join('');
  const on = geoHeatUiState.enabled !== false;
  return `<div class="geo-heat-controlbar">
    <div class="geo-heat-ctl-group" role="group" aria-label="Heatmap Metric"><span class="geo-heat-ctl-label">Metric</span>${metricBtns}</div>
    <div class="geo-heat-ctl-group" role="group" aria-label="Heatmap Display"><span class="geo-heat-ctl-label">Display</span>${displayBtns}</div>
    <div class="geo-heat-ctl-group" role="group" aria-label="Heatmap Channel"><span class="geo-heat-ctl-label">Channel</span>${channelBtns}</div>
    <div class="geo-heat-ctl-group geo-heat-ctl-toggle">
      <label class="geo-heat-toggle-label"><span class="geo-heat-ctl-label">Heatmap</span>
        <input type="checkbox" role="switch" aria-checked="${on}" ${on ? 'checked' : ''} onchange="geoHeatUiToggleEnabled(this.checked)">
        <span>${on ? _geoHeatUiEsc(GEO_HEAT_UI_MESSAGES.toggle_on) : _geoHeatUiEsc(GEO_HEAT_UI_MESSAGES.toggle_off)}</span>
      </label>
    </div>
  </div>`;
}
function _geoHeatUiRerenderControlBar(containerId) {
  if (typeof document === 'undefined') return;
  const panel = document.getElementById(`${containerId}-panel-heatmap`);
  const bar = panel && panel.querySelector('.geo-heat-controlbar');
  if (bar) bar.outerHTML = geoHeatUiControlBarHtml();
}

// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.3｜Geo Metric Sync & Coverage Explanation
//
// Root Cause（見 R5.4-G1.3_METRIC_SYNC_FIX.md）：上方「全域 Metric」
// （8-Tab Metric Bar，geoVisitorState.metric，見 geo-visitor-layer.js）
// 在 R5.3-A4 已經會同步驅動共用 Choropleth 地圖（geoMapState.metric，透過
// GEO_EVENT_TO_MAP_METRIC），但從來沒有同步到 Order Heatmap 分頁自己的
// 獨立 Metric 狀態（geoHeatState.metric，見 geo-heatmap.js）——兩邊各自
//維護自己的按鈕/state，互不相干。
//
// 這裡新增「唯一同步入口」，不新增第三套 Metric state：全域
// geoVisitorState.metric 依然是唯一權威來源，這裡只負責把它的變化「轉譯＋
// 套用」到 Order Heatmap 既有的 geoHeatState.metric（GEO_HEAT_METRICS 是
// GEO_EVENT_METRICS 的子集，只是 checkout/begin_checkout 命名不同）。
// ════════════════════════════════════════════════════════════════

// Mapping 集中管理（需求文件四）：唯一一份對照表，不散落多處 hardcode。
// null 代表「該全域指標沒有對應的 Order Heatmap Metric」（購物車放棄／
// 建議風險目前沒有可繪製的地理熱區維度）——遇到 null 一律保留目前
// geoHeatState.metric 原值，不得靜默改成 Orders，並顯示明確說明文字。
const GEO_EVENT_TO_HEATMAP_METRIC = Object.freeze({
  visitors: 'visitors',
  add_to_cart: 'add_to_cart',
  checkout: 'begin_checkout',
  orders: 'orders',
  revenue: 'revenue',
  conversion: 'conversion',
  cart_abandonment: null,
  recommendation_risk: null,
});
// 反向對照（Order Heatmap Metric → 全域 Metric），供下方按鈕同步回上方用。
// 因為 GEO_HEAT_METRICS 是 GEO_EVENT_TO_HEATMAP_METRIC 值域的完整子集
// （六個都有對應的全域指標），這份表可以直接由上表反轉產生，不需要另外
// 手動維護第二份、有可能兜不起來的對照表。
const GEO_HEATMAP_TO_EVENT_METRIC = Object.freeze(
  Object.keys(GEO_EVENT_TO_HEATMAP_METRIC).reduce((acc, k) => {
    const v = GEO_EVENT_TO_HEATMAP_METRIC[k];
    if (v) acc[v] = k;
    return acc;
  }, {})
);

// Reentrancy Guard：避免「上方觸發下方、下方又觸發上方」無限互相呼叫。
let _geoMetricSyncInProgress = false;

// 全域 Metric → Order Heatmap Metric（單一同步入口，需求文件三）。
// 呼叫端：geoVisitorSetMetric()（geo-visitor-layer.js）在設定完
// geoVisitorState.metric、同步完 geoMapState.metric 之後，最後呼叫這裡。
function geoHeatUiSyncMetricFromGlobal(globalMetric) {
  if (_geoMetricSyncInProgress) return false;
  _geoMetricSyncInProgress = true;
  try {
    const mapped = GEO_EVENT_TO_HEATMAP_METRIC[globalMetric];
    // 需求文件四方案二：沒有對應 Heatmap Metric 時，保留目前 geoHeatState.metric
    // 原值（不得靜默改成 Orders），只記錄「目前是哪個全域指標造成沒有對應」，
    // 供 Coverage/Empty 區塊顯示明確說明文字。
    geoHeatUiState.unmappedGlobalMetric = mapped ? null : globalMetric;
    if (mapped && GEO_HEAT_METRICS.includes(mapped) && geoHeatState.metric !== mapped) {
      geoHeatState.metric = mapped;
      if (typeof geoHeatRenderLayer === 'function') geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
      if (typeof _geoHeatRenderRankingDom === 'function') _geoHeatRenderRankingDom();
      if (typeof _geoHeatRenderSummaryDom === 'function') _geoHeatRenderSummaryDom();
      if (typeof _geoHeatRenderCoverageCardDom === 'function') _geoHeatRenderCoverageCardDom();
      if (typeof _geoHeatRenderLegendDom === 'function') _geoHeatRenderLegendDom();
    }
    if (geoHeatUiState.containerId) {
      _geoHeatUiRerenderControlBar(geoHeatUiState.containerId);
      _geoHeatUiRenderCoverageExplanation(geoHeatUiState.containerId);
    }
    return !!mapped;
  } finally {
    _geoMetricSyncInProgress = false;
  }
}

function geoHeatUiSetMetric(metric) {
  if (!GEO_HEAT_METRICS.includes(metric)) return;
  geoHeatState.metric = metric;
  geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
  _geoHeatRenderRankingDom(); _geoHeatRenderSummaryDom(); _geoHeatRenderCoverageCardDom(); _geoHeatRenderLegendDom();
  if (geoHeatUiState.containerId) {
    _geoHeatUiRerenderControlBar(geoHeatUiState.containerId);
    _geoHeatUiRenderCoverageExplanation(geoHeatUiState.containerId);
  }
  // 需求文件五：下方 Metric 若本來就有對應的全域指標，點擊時同步回上方
  // （雙向同步），不留兩套可能互相矛盾的控制。
  if (!_geoMetricSyncInProgress) {
    const globalEquivalent = GEO_HEATMAP_TO_EVENT_METRIC[metric];
    if (globalEquivalent && typeof geoVisitorSetMetric === 'function' && geoHeatUiState.containerId) {
      _geoMetricSyncInProgress = true;
      try { geoVisitorSetMetric(geoHeatUiState.containerId, globalEquivalent); } finally { _geoMetricSyncInProgress = false; }
    }
  }
}
function geoHeatUiSetDisplay(display) {
  if (!GEO_HEAT_DISPLAY_MODES.includes(display)) return;
  geoHeatState.display = display;
  geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
  if (geoHeatUiState.containerId) _geoHeatUiRerenderControlBar(geoHeatUiState.containerId);

}
function geoHeatUiSetChannel(channel) {
  if (!GEO_HEAT_CHANNELS.includes(channel)) return;
  // 需求文件四：不得新增第二套狀態——一律透過既有 av2SetChannel() 改變
  // 全站共用的 av2Channel，讓 Dashboard／Heatmap 用同一份篩選重新整理。
  if (typeof av2SetChannel === 'function') { av2SetChannel(channel); return; }
  if (typeof av2Channel !== 'undefined') av2Channel = channel; // eslint-disable-line no-undef
  if (geoHeatUiState.containerId) geoHeatUiFetchAndRender(geoHeatUiState.containerId);
}
// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.3｜Coverage Explanation（需求文件七～十二）
//
// 完全讀取既有、未修改的 geoHeatBuildSummary()/geoHeatState.areas 既有欄位
// （submitted_orders/coordinate_count/revenue/...），不重新計算統計口徑，
// 只是把「已經算好的數字」組成清楚的一句話，取代原本模糊的「資料不足」。
// ════════════════════════════════════════════════════════════════

// 依 metric 算出（total, drawn）：total 是「業務總量」，drawn 是「可歸屬地理
// 資料量」。currency metrics（revenue）用金額本身；其餘用筆數/人數。
function _geoHeatMetricTotals(areas, metric, businessTotals) {
  const list = areas || [];
  const bt = businessTotals || {};
  if (metric === 'revenue') {
    // fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件二、三）：Root Cause——
    // areas 只包含 order_mode IN ('delivery','shipping') AND
    // fulfillment_geo_source IS NOT NULL 的訂單（getGeoFulfillment() 既有
    // 查詢條件），也就是「Geo Drawable」子集合，不是全店總量。之前直接把
    // list.reduce(revenue) 當 Business Total，等於用 Geo Drawable Total
    // 冒充 Business Total，導致「有訂單但無 Geo」被誤判成「沒有訂單資料」。
    // 現在優先採用後端 additive 欄位 business_total_revenue（同一組
    // Store/Date/Channel 篩選、不受 order_mode/geo_source 限制）；只有在
    // 該欄位不是數字（例如舊 fixture 沒有這個欄位）時，才 fallback 回舊的
    // areas 加總（不得無故改變沒有這個欄位時的既有行為）。
    const total = (typeof bt.revenue === 'number') ? bt.revenue : list.reduce((s, a) => s + (Number(a.revenue) || 0), 0);
    // Geo Drawable Total 語意不變：coordinate_count>0 的 area 才視為「該區
    // 營收可歸屬」（跟 orders 用同一套 coordinate_count 語意，不新造一套）。
    const drawn = list.filter((a) => (Number(a.coordinate_count) || 0) > 0).reduce((s, a) => s + (Number(a.revenue) || 0), 0);
    return { total, drawn };
  }
  if (metric === 'orders') {
    // 同上——優先用 business_total_orders，fallback 回 areas 加總。
    const total = (typeof bt.orders === 'number') ? bt.orders : list.reduce((s, a) => s + (Number(a.submitted_orders) || 0), 0);
    const drawn = list.reduce((s, a) => s + (Number(a.coordinate_count) || 0), 0);
    return { total, drawn };
  }
  // visitors/add_to_cart/begin_checkout/conversion：目前系統性設計下沒有
  // 座標（見 R5.4-G1 架構文件），total 用該指標既有欄位加總，drawn 恆為 0
  // （誠實反映現況，不臆測）。
  const key = metric === 'begin_checkout' ? 'begin_checkout' : metric;
  const total = list.reduce((s, a) => s + (Number(a[key]) || 0), 0);
  return { total, drawn: 0 };
}

const GEO_HEAT_COVERAGE_NO_BUSINESS_DATA_TEXT = Object.freeze({
  visitors: '目前沒有符合條件的訪客事件', add_to_cart: '目前沒有符合條件的加購事件',
  begin_checkout: '目前沒有符合條件的結帳事件', orders: '目前沒有符合條件的訂單資料',
  revenue: '目前沒有符合條件的營收資料', conversion: '目前沒有符合條件的轉換資料',
});
const GEO_HEAT_COVERAGE_NO_GEO_TEXT = Object.freeze({
  visitors: (t) => `目前有 ${t} 位訪客，但尚未取得可繪製的真實座標。`,
  add_to_cart: (t) => `目前有 ${t} 位加購訪客，但尚未取得可用地理資料。`,
  begin_checkout: (t) => `目前有 ${t} 位開始結帳訪客，但尚未取得可用地理資料。`,
  orders: (t) => `今日已有 ${t} 筆訂單，但目前沒有訂單包含可用的地理資料，因此無法顯示地圖熱區。`,
  revenue: (t) => `目前已有營收 NT$${t}，但目前沒有任何營收可歸屬到地理區域。`,
  conversion: () => '目前有轉換資料，但沒有足夠地理資料計算區域轉換率。',
});

// 需求文件九：區分四種資料狀態（完全無資料／有業務資料無 Geo／部分
// Coverage／API Error）。API Error 由呼叫端（geoHeatUiFetchAndRender 既有
// 的 errorEl）另外處理，這裡只負責前三種。
function _geoHeatBuildCoverageExplanationText(metric, total, drawn) {
  const m = GEO_HEAT_METRICS.includes(metric) ? metric : 'orders';
  // fix18-10-hotfix30-B5-R5.4-G1.3.1：防禦性補強——total/drawn 理論上永遠
  // 是有限數字（後端 COUNT(*)/SUM() 的聚合結果，透過 Number() 轉型），
  // 但為了不讓格式異常的 API 回應（例如缺欄位、序列化錯誤）產生
  // "NaN%"/"Infinity%" 這種使用者看得到的髒字串，這裡在既有 clamp 之前
  // 先擋掉非有限數字，一律視為 0（等同「無業務資料/無 Geo 資料」）。
  // 不改變任何正常數字輸入（真實案例）的既有行為。
  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : 0;
  const safeDrawn = Number.isFinite(Number(drawn)) ? Number(drawn) : 0;
  const t = Math.max(0, safeTotal);
  const d = Math.max(0, Math.min(t, safeDrawn));
  if (t <= 0) return { state: 'no_business_data', text: GEO_HEAT_COVERAGE_NO_BUSINESS_DATA_TEXT[m] };
  if (d <= 0) return { state: 'no_geo_data', text: (GEO_HEAT_COVERAGE_NO_GEO_TEXT[m] || GEO_HEAT_COVERAGE_NO_GEO_TEXT.orders)(m === 'revenue' ? t.toLocaleString('en-US') : t) };
  const pct = t > 0 ? Math.round((d / t) * 1000) / 10 : 0;
  const label = GEO_HEAT_METRIC_LABEL[m] || m;
  return { state: 'partial_coverage', text: `${t} 筆${label}中有 ${d} 筆可顯示於地圖，Coverage ${pct}%` };
}

// fix18-10-hotfix30-B5-R5.4-G1.4（需求文件四：沒有 Drawable Geo 時顯示
// 誠實 Overlay，不畫假 Marker）——Root Cause：G1.2 只替 Visitor Layer 做了
// 「沒有真實座標可畫時，地圖上明確顯示原因」的覆蓋文字
// （_geoHeatUiRenderVisitorMapOverlay），Order Heatmap 這邊完全沒有對應
// 邏輯：`geoHeatRenderLayer()` 在 plottable.length===0 時只是靜靜地畫
// 一張空地圖，使用者看不出「這是真的沒有可畫的 Geo 資料」還是「還在
// loading」還是「Rendering 壞了」。這裡補上對稱的 Order Layer 版本，直接
// 沿用 geoHeatComputeDrawableState() 這個新的統一狀態機，不新建第二套
// 判斷邏輯，也不改動 G1.3.1 既有的 Coverage Explanation 文字（那是給
// Coverage 卡片用的，這裡是給「地圖本身」用的，職責不同）。
// 需求文件五之 D：Orders／Revenue 各自固定文案，數字直接取自
// geoHeatState.businessTotals（跟 G1.3.1 Coverage Explanation 同一組
// 資料來源，不重新計算，不會兩處數字對不上）。
function _geoHeatUiOrderMapOverlayMessage(drawableState, metric, businessTotals) {
  if (drawableState === 'no_business_data') return null; // 沒有業務資料時，Coverage Explanation 卡片已經講得很清楚，地圖上不必再疊一層文字
  const bt = businessTotals || {};
  if (drawableState === 'has_business_but_no_drawable_geo') {
    if (metric === 'revenue') {
      const rev = (typeof bt.revenue === 'number') ? bt.revenue : 0;
      return `目前已有營收 NT$${rev.toLocaleString('en-US')}，但目前沒有任何營收可歸屬到地理區域，因此無法顯示地圖標示。`;
    }
    const orders = (typeof bt.orders === 'number') ? bt.orders : 0;
    return `今日已有 ${orders} 筆訂單，但目前沒有訂單包含可用的地理資料，因此無法顯示地圖標示。`;
  }
  if (drawableState === 'has_drawable_district_only') {
    return '目前已知部分行政區有訂單，但尚無平均座標可畫地圖標示；請參考右側排行榜的行政區名稱。';
  }
  return null; // has_drawable_exact_only／has_mixed_drawable_geo：至少有東西可畫，不疊加文字
}
function _geoHeatUiRenderOrderMapOverlay() {
  if (typeof document === 'undefined') return;
  const mapContainerId = geoHeatUiState.mapContainerId;
  if (!mapContainerId) return;
  const mapEl = document.getElementById(mapContainerId);
  if (!mapEl) return;
  const overlayId = `${mapContainerId}-order-empty-overlay`;
  let overlay = document.getElementById(overlayId);
  if (geoHeatUiState.layer !== 'order') {
    if (overlay) overlay.remove(); // 切到 Visitor 時不得殘留 Order 的覆蓋文字
    return;
  }
  const drawableState = (typeof geoHeatComputeDrawableState === 'function')
    ? geoHeatComputeDrawableState(geoHeatState.areas, geoHeatState.businessTotals)
    : 'no_business_data';
  const message = _geoHeatUiOrderMapOverlayMessage(drawableState, geoHeatState.metric, geoHeatState.businessTotals);
  if (!message) { if (overlay) overlay.remove(); return; }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'geo-heat-visitor-map-overlay geo-heat-order-map-overlay';
    mapEl.appendChild(overlay);
  }
  overlay.textContent = message;
}

// 需求文件八：目前 Order Heatmap Metric 若沒有對應的全域指標映射
// （geoHeatUiState.unmappedGlobalMetric 非 null），額外附加一句提示，不得
// 靜默切成 Orders 卻不告知使用者。
function _geoHeatUiRenderCoverageExplanation(containerId) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(`${containerId}-coverage-explanation`);
  if (!el) return;
  const { total, drawn } = _geoHeatMetricTotals(geoHeatState.areas, geoHeatState.metric, geoHeatState.businessTotals);
  const result = _geoHeatBuildCoverageExplanationText(geoHeatState.metric, total, drawn);
  let html = `<p class="geo-heat-coverage-explanation-text" data-state="${_geoHeatUiEsc(result.state)}">${_geoHeatUiEsc(result.text)}</p>`;
  if (geoHeatUiState.unmappedGlobalMetric) {
    const label = (typeof GEO_EVENT_METRIC_LABEL !== 'undefined' && GEO_EVENT_METRIC_LABEL[geoHeatUiState.unmappedGlobalMetric]) || geoHeatUiState.unmappedGlobalMetric;
    html += `<p class="geo-heat-coverage-explanation-note">上方選擇的「${_geoHeatUiEsc(label)}」此指標目前沒有對應的地理熱區 Metric，下方維持顯示「${_geoHeatUiEsc(GEO_HEAT_METRIC_LABEL[geoHeatState.metric])}」。</p>`;
  }
  el.innerHTML = html;
  // G1.4 additive：Coverage Explanation 每次重繪，同步重繪 Order Layer 的
  // 地圖誠實 Overlay（同一批 geoHeatState.areas／businessTotals，不重新
  // Fetch，不產生額外請求）。
  _geoHeatUiRenderOrderMapOverlay();
}

// 需求文件十：外帶／外送差異的靜態說明（不是逐筆真實數字，本輪沒有新增
// 任何「外帶/外送筆數」的資料來源／API；純粹是固定的教育性文字，說明
// 「為什麼外帶訂單通常沒有座標」，不臆測、不冒充精確統計數字）。
const GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION =
  '外帶訂單若未取得顧客同意提供的真實位置，通常不會有可繪製地理資料。'
  + '外送訂單需要有經緯度（delivery_lat/delivery_lng）才會納入 Order Marker／Revenue Heatmap／外送距離計算，'
  + '不會把店家地址當成顧客位置，也不會用行政區中心點或 IP 位置取代真實座標。';

// 需求文件十一：Business Opportunity 空狀態（有業務資料但 Geo Coverage=0）
function _geoHeatBuildBusinessOpportunityEmptyText(metric, total) {
  const t = Math.max(0, Number(total) || 0);
  if (t <= 0) return null; // 完全沒有業務資料時，交由既有「資料不足」流程處理，不是本輪範圍
  if (metric === 'revenue') return `目前已有營收 NT$${t.toLocaleString('en-US')}，但尚無可歸屬地理區域的資料，因此暫時無法產生區域商機建議。`;
  return `目前已有 ${t} 筆${GEO_HEAT_METRIC_LABEL[metric] || ''}資料，但尚無可歸屬地理區域的資料，因此暫時無法產生區域商機建議。`;
}
// 依然是 Rule-based（非 AI）：固定建議文字，不是模型生成。
const GEO_HEAT_RECOMMENDED_ACTION_LOW_GEO_COVERAGE = '建議先提高外送地址／定位資料覆蓋率，再進行區域分析。';

// 需求文件十二：外送最佳化空狀態
function _geoHeatBuildDeliveryOptimizationText(deliveryOrderCount, deliveryWithCoordinateCount) {
  const d = Math.max(0, Number(deliveryOrderCount) || 0);
  if (d <= 0) return '今日沒有外送訂單，因此目前無法計算平均距離、外送費與配送最佳化建議。';
  const withCoord = Math.max(0, Number(deliveryWithCoordinateCount) || 0);
  if (withCoord <= 0) return '目前有外送訂單，但缺少可用座標，無法計算配送距離。';
  return null; // 有座標可計算時，交由既有/未來的距離計算邏輯處理，不是本輪範圍
}

function geoHeatUiToggleEnabled(checked) {
  geoHeatUiState.enabled = !!checked;
  if (geoHeatUiState.containerId) {
    geoHeatUiFetchAndRender(geoHeatUiState.containerId);
    _geoHeatUiRerenderControlBar(geoHeatUiState.containerId);
  }
}

// ════════════════════════════════════════════════════════════════
// 五、Panel Skeleton（需求文件三、七、八、九、十、十一、十二、十三）
// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.2：Layer 切換列的唯一單一狀態鍵仍是既有
// geoHeatUiState.layer（不新增第二套 orderHeatmapMode/geoLiveState 之類的
// 平行狀態）。本輪要修的是：切換 layer 之後，(1) 按鈕 active/aria-pressed
// 沒有真的被重新套用（下面看到的空 forEach 就是原本的 Bug）、(2) Order
// Heatmap 與 Visitor Layer 各自的 Leaflet layerGroup 從未互斥顯示，導致
// 兩者可能同時掛在同一張地圖上、(3) Visitor Layer 沒有真實座標可畫時，
// 地圖上完全沒有任何說明文字，看起來像「Order Heatmap 沒有真的切換掉」。
function geoHeatUiLayerToggleHtml(containerId) {
  // fix18-10-hotfix30-B5-R5.4-G1.5：新增 GA4 Realtime 選項，additive——
  // 既有 order/visitor 兩個 key 與行為完全不變，只多一個第三選項。
  const layers = [['order', '訂單熱區 Order Heatmap'], ['visitor', '訪客熱區 Visitor Layer'], ['ga4', 'GA4 即時訪客（IP 城市級推估）']];
  const buttons = layers.map(([key, label]) => {
    const active = geoHeatUiState.layer === key;
    return `<button type="button" class="geo-heat-layer-btn${active ? ' is-active' : ''}" data-layer="${_geoHeatUiEsc(key)}" aria-pressed="${active}" aria-selected="${active}" onclick="geoHeatUiSetLayer('${_geoHeatUiEsc(containerId)}','${_geoHeatUiEsc(key)}')">${_geoHeatUiEsc(label)}</button>`;
  }).join('');
  return `<div id="${_geoHeatUiEsc(containerId)}-layer-toggle" class="geo-heat-layer-toggle" role="group" aria-label="Heatmap Layer 切換">${buttons}</div>`;
}

// 對照表（Root Cause 追查用，見 CHANGELOG_HOTFIX30_B5_R5_4_G1_2_LAYER_SWITCH_FIX.md）：
//   DOM id              #{containerId}-layer-toggle 內的 .geo-heat-layer-btn
//   state key           geoHeatUiState.layer（唯一正式狀態，'order'|'visitor'）
//   click handler       geoHeatUiSetLayer(containerId, layer)
//   render function      _geoHeatUiRerenderLayerToggle() / geoVisitorFetchAndRender()
//   map layer           window.geoHeatState.layerGroup（order）／
//                        window.geoVisitorState.choroplethLayerGroup（visitor）
//   active class/aria   .is-active / aria-pressed / aria-selected（由
//                        _geoHeatUiRerenderLayerToggle() 重新渲染整段 HTML 決定，
//                        不再是「切完 state 之後放著不管」）
//   API source          order: 既有 Heatmap Engine API；visitor:
//                        /api/analytics/geo/visitor-log（本輪未修改任一個 API）
// 確認結果：沒有第二套競爭 state（orderHeatmapMode/geoVisitorMode/
// geoLiveState/activeLayer 都不存在於本檔案），問題純粹是「更新 state 之後
// 忘了真的把 UI 三處（按鈕／地圖 Layer／覆蓋文字）套用新 state」，屬於
// render 沒有跟著 state 走，不是雙重狀態競爭。

function _geoHeatUiRerenderLayerToggle(containerId) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(`${containerId}-layer-toggle`);
  if (el) el.outerHTML = geoHeatUiLayerToggleHtml(containerId);
}

// 唯一負責「Order/Visitor 兩個 Leaflet layerGroup 互斥顯示」的函式。只用
// addLayer/removeLayer 切換既有 group 的顯示狀態，不 clearLayers()（資料本身
// 不受影響）、不重建 group、不重建地圖／Tile Layer。快速連點時 map.hasLayer()
// 判斷是冪等的，不會重複 addLayer 造成 duplicate layer。
function _geoHeatUiApplyLayerExclusivity(layer) {
  if (typeof window === 'undefined') return;
  const map = window.geoMapState && window.geoMapState.instance;
  if (!map || typeof map.hasLayer !== 'function') return;
  const orderGroup = window.geoHeatState && window.geoHeatState.layerGroup;
  const visitorGroup = window.geoVisitorState && window.geoVisitorState.choroplethLayerGroup;
  // fix18-10-hotfix30-B5-R5.4-G1.5：第三個互斥 group（GA4 Realtime）。沿用
  // 既有「只 addLayer/removeLayer，不 clearLayers／不重建」慣例，其餘兩個
  // 既有分支完全不動。
  const ga4Group = window.geoGa4State && window.geoGa4State.layerGroup;
  if (layer === 'order') {
    if (visitorGroup && map.hasLayer(visitorGroup)) map.removeLayer(visitorGroup);
    if (ga4Group && map.hasLayer(ga4Group)) map.removeLayer(ga4Group);
    if (orderGroup && !map.hasLayer(orderGroup)) map.addLayer(orderGroup);
  } else if (layer === 'visitor') {
    if (orderGroup && map.hasLayer(orderGroup)) map.removeLayer(orderGroup);
    if (ga4Group && map.hasLayer(ga4Group)) map.removeLayer(ga4Group);
    if (visitorGroup && !map.hasLayer(visitorGroup)) map.addLayer(visitorGroup);
  } else if (layer === 'ga4') {
    if (orderGroup && map.hasLayer(orderGroup)) map.removeLayer(orderGroup);
    if (visitorGroup && map.hasLayer(visitorGroup)) map.removeLayer(visitorGroup);
    if (ga4Group && !map.hasLayer(ga4Group)) map.addLayer(ga4Group);
  }
}

// ════════════════════════════════════════════════════════════════
// Heatmap → Dashboard 分頁切換 Cleanup（fix18-10-hotfix30-B5-R5.4-
// G1.6-GA4-H1.4-MAP-STATE 第一階段）
//
// Root Cause（見 R5.4-G1.6-GA4-H1.4-MAP-STATE_REALITY_AUDIT.md 章節
// F／G／H）：geoHeatUiSwitchTab() 切到 'dashboard' 時，過去只呼叫
// _geoHeatUiRestoreChoropleth()，從未把 Heatmap 端已經 addLayer 到共用
// geoMapState.instance 上的 4 組 LayerGroup（Order／Visitor／GA4
// Realtime／GA4 H1 Historical）移除，也從未停掉 Realtime／H1 各自的
// timer／AbortController，造成 Marker Leakage（使用者回報的紫色 GA4
// Marker 殘留）與背景 request 繼續跑。這裡集中處理，取代散落多次
// map.removeLayer(...)。
//
// 只清「這次 Heatmap session 造成的 active 狀態」（layer 本身／timer／
// pending request／覆蓋文字），刻意不動 Heatmap 使用者選的
// layer／source／range／metric state（geoHeatUiState.layer／
// geoHeatUiState.visitorRange／geoGa4State.metric／
// geoGa4State.windowMinutes／...）——下次切回 Heatmap 分頁必須原樣恢復
// （需求文件四），不是重設回預設值。
// ════════════════════════════════════════════════════════════════
function _geoHeatUiRemoveLayerIfPresent(map, group) {
  if (!map || !group) return;
  try {
    if (typeof map.hasLayer === 'function' && typeof map.removeLayer === 'function' && map.hasLayer(group)) {
      map.removeLayer(group);
    }
  } catch (e) { /* 安靜失敗，不擋 cleanup 其他步驟 */ }
}

function _geoHeatUiCleanupForDashboard(containerId) {
  if (typeof window === 'undefined') return;
  const map = window.geoMapState && window.geoMapState.instance;

  // 1. 停 GA4 Realtime 既有的 timer／AbortController（既有函式
  // geoGa4Deactivate()，不重寫；它本身只 clearLayers 群組內容、不會把
  // 群組從地圖移除，移除群組本身留給下面第 3-5 步統一處理）。
  if (typeof geoGa4Deactivate === 'function') {
    try { geoGa4Deactivate(); } catch (e) { /* 安靜失敗 */ }
  }
  // 2. Destroy GA4 H1 Historical 子面板（既有函式 GeoGa4H1Panel.destroy()：
  // 清 pollTimer／currentAbort／呼叫自己的 markerGroup.remove() 把
  // markerGroup 從地圖上移除並清空參考／DOM listener cleanup）。ids
  // 沿用 geoHeatUiSetLayer() 既有命名慣例（`${containerId}-ga4-h1-*`）。
  if (window.GeoGa4H1Panel && typeof window.GeoGa4H1Panel.destroy === 'function') {
    try {
      window.GeoGa4H1Panel.destroy({
        toolbar: `${containerId}-ga4-h1-toolbar`,
        table: `${containerId}-ga4-h1-table`,
      });
    } catch (e) { /* 安靜失敗 */ }
  }

  // 3-5. 移除剩下三組 LayerGroup 本身（Order／Visitor／GA4 Realtime；
  // GA4 H1 的 markerGroup 已經在上面 destroy() 內用 .remove() 處理過，
  // 不重複移除）。只 map.removeLayer，不 clearLayers——clearLayers 會清掉
  // 資料本身，下次切回 Heatmap 還要重新 fetch；這裡只要讓地圖上看不到，
  // 資料／群組物件本身留著（Order／Visitor 沒有等效 Deactivate()，這裡
  // 是它們僅有的 cleanup 路徑）。
  _geoHeatUiRemoveLayerIfPresent(map, window.geoHeatState && window.geoHeatState.layerGroup);
  _geoHeatUiRemoveLayerIfPresent(map, window.geoVisitorState && window.geoVisitorState.choroplethLayerGroup);
  _geoHeatUiRemoveLayerIfPresent(map, window.geoGa4State && window.geoGa4State.layerGroup);

  // 6. 清掉殘留在共用地圖容器上的 Visitor／GA4 覆蓋文字。這些是純 DOM
  // 覆蓋層（非 Leaflet Layer），掛在 mapContainerId 底下；地圖容器本身
  // 在 Dashboard／Heatmap 兩個分頁都可見（只有 Panel 被 hidden，地圖
  // 容器不在 Panel 裡面），所以切分頁不會自動清掉這些文字。
  if (typeof document !== 'undefined') {
    const mapContainerId = geoHeatUiState.mapContainerId;
    if (mapContainerId) {
      const visitorOverlay = document.getElementById(`${mapContainerId}-visitor-empty-overlay`);
      if (visitorOverlay) visitorOverlay.remove();
      const ga4Overlay = document.getElementById(`${mapContainerId}-ga4-empty-overlay`);
      if (ga4Overlay) ga4Overlay.remove();
    }
  }
}

// 需求文件三／七：Visitor Layer 沒有真實座標可畫時，地圖上必須明確顯示
// 原因（而不是留一張看起來像「還在 Order Heatmap」的空白/舊畫面）。純
// DOM 覆蓋文字，不是 Leaflet Layer，不會被誤認成假 Marker。三種空狀態
// （error／empty／no_coordinate）文案不同，讀取的都是既有、未修改的
// geoVisitorState.status 與 geoVisitorComputeCoverage() 既有回傳值。
function _geoHeatUiVisitorMapOverlayMessage(status, coverage) {
  if (status === 'loading') return '訪客熱區載入中…';
  if (status === 'error') return '訪客熱區載入失敗，請重試';
  const c = coverage || { total: 0, with_coordinate: 0, known_area_only: 0 };
  if (!c.total) return '目前沒有符合條件的訪客事件';
  // 只有在「連行政區 Choropleth 都沒有東西可畫」時才顯示這段覆蓋文字——
  // 若 known_area_only > 0，choropleth 至少會畫出行政區色塊，地圖不是空的，
  // 不該被這段文字擋住（見需求文件回報情境：Known District=0 且
  // Exact Coordinate=0 才是「完全沒有東西可畫」的那個情境）。
  if (!c.with_coordinate && !c.known_area_only) {
    // fix18-10-hotfix30-B5-R5.4-G1.4：主要句子改用跟 Order Overlay 統一的
    // 「因此無法顯示地圖標示」句型（需求文件五之 D），第二行的
    // Known District/Exact Coordinate/Unknown/Coverage 診斷明細是 G1.2
    // 既有內容，保留不刪，補充說明用，不是取代主要句子。
    return `目前已有 ${c.total} 位訪客，但尚未取得可繪製到地圖上的地理資料，因此無法顯示地圖標示。\n`
      + `Known District：${c.known_area_only}｜Exact Coordinate：${c.with_coordinate}｜`
      + `Unknown：${c.unknown}｜Coverage：${c.coverage_pct}%`;
  }
  return null; // 有真實座標或至少有行政區色塊可畫時不顯示覆蓋文字，讓地圖正常呈現
}
function _geoHeatUiRenderVisitorMapOverlay() {
  if (typeof document === 'undefined') return;
  const mapContainerId = geoHeatUiState.mapContainerId;
  if (!mapContainerId) return;
  const mapEl = document.getElementById(mapContainerId);
  if (!mapEl) return;
  const overlayId = `${mapContainerId}-visitor-empty-overlay`;
  let overlay = document.getElementById(overlayId);
  if (geoHeatUiState.layer !== 'visitor') {
    if (overlay) overlay.remove(); // 切回 Order 時不得殘留 Visitor 的覆蓋文字
    return;
  }
  const status = (window.geoVisitorState && window.geoVisitorState.status) || 'loading';
  const coverage = (typeof geoVisitorComputeCoverage === 'function' && window.geoVisitorState)
    ? geoVisitorComputeCoverage(window.geoVisitorState.summary)
    : null;
  const message = _geoHeatUiVisitorMapOverlayMessage(status, coverage);
  if (!message) { if (overlay) overlay.remove(); return; }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'geo-heat-visitor-map-overlay';
    mapEl.appendChild(overlay);
  }
  overlay.textContent = message;
}

// fix18-10-hotfix30-B5-R5.4-G1.5：GA4 Layer 的地圖覆蓋文字，跟
// _geoHeatUiVisitorMapOverlayMessage 同一種角色，只是資料來源換成
// geoGa4State／geoGa4MapOverlayMessage()（定義於 geo-ga4-realtime-layer.js，
// 本檔案不重複定義文案邏輯，只負責讀取與掛載 DOM）。
function _geoHeatUiRenderGa4MapOverlay() {
  if (typeof document === 'undefined') return;
  const mapContainerId = geoHeatUiState.mapContainerId;
  if (!mapContainerId) return;
  const mapEl = document.getElementById(mapContainerId);
  if (!mapEl) return;
  const overlayId = `${mapContainerId}-ga4-empty-overlay`;
  let overlay = document.getElementById(overlayId);
  if (geoHeatUiState.layer !== 'ga4') {
    if (overlay) overlay.remove();
    return;
  }
  const message = (typeof geoGa4MapOverlayMessage === 'function') ? geoGa4MapOverlayMessage() : null;
  if (!message) { if (overlay) overlay.remove(); return; }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'geo-heat-visitor-map-overlay geo-heat-ga4-map-overlay';
    mapEl.appendChild(overlay);
  }
  overlay.textContent = message;
}

function geoHeatUiSetLayer(containerId, layer) {
  if (layer !== 'order' && layer !== 'visitor' && layer !== 'ga4') return false;
  geoHeatUiState.layer = layer;
  if (typeof document !== 'undefined') {
    const orderEl = document.getElementById(`${containerId}-order-layer`);
    const visitorEl = document.getElementById(`${containerId}-visitor-layer`);
    const ga4El = document.getElementById(`${containerId}-ga4-layer`);
    if (orderEl) orderEl.hidden = layer !== 'order';
    if (visitorEl) visitorEl.hidden = layer !== 'visitor';
    if (ga4El) ga4El.hidden = layer !== 'ga4';
  }
  // 修正 Root Cause 一：按鈕 active/aria-pressed 重新渲染整段 HTML，不再是
  // 「查到按鈕卻什麼都不做」的空 forEach。
  _geoHeatUiRerenderLayerToggle(containerId);
  // 修正 Root Cause 二：Order/Visitor/GA4 三個既有 Leaflet layerGroup 互斥顯示
  // （只 addLayer/removeLayer，不 clearLayers/不重建）。
  _geoHeatUiApplyLayerExclusivity(layer);
  if (layer === 'visitor' && typeof geoVisitorFetchAndRender === 'function') {
    // fix18-10-hotfix30-B5-R5.4-G1.5-B1：離開 GA4 Layer 時清 timer／abort 未完成
    // request（見 geo-ga4-realtime-layer.js 的 geoGa4Deactivate()）。
    if (typeof geoGa4Deactivate === 'function') geoGa4Deactivate();
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1：離開 GA4 Layer 時同樣清理 H1
    // 子面板（timer／abort／獨立 marker layerGroup），不影響上面既有的
    // geoGa4Deactivate()。
    if (window.GeoGa4H1Panel && typeof window.GeoGa4H1Panel.destroy === 'function') {
      window.GeoGa4H1Panel.destroy({ toolbar: `${containerId}-ga4-h1-toolbar` });
    }
    // 修正 Root Cause 三：資料抓回來、choropleth 畫完之後，再依當下真實的
    // status/coverage 決定要不要顯示「無可繪製座標」等地圖覆蓋文字。
    Promise.resolve(geoVisitorFetchAndRender(containerId, geoHeatUiState.visitorRange))
      .then(() => { _geoHeatUiApplyLayerExclusivity(geoHeatUiState.layer); _geoHeatUiRenderVisitorMapOverlay(); })
      .catch(() => { _geoHeatUiRenderVisitorMapOverlay(); });
    _geoHeatUiRenderVisitorMapOverlay(); // 先用目前已知狀態畫一次（多半是 loading），資料回來後上面再更新一次
    // G1.4：切到 Visitor 時，同步清掉可能殘留的 Order Layer 覆蓋文字
    // （否則使用者從「Order 無 Geo 可畫」切到 Visitor，畫面會疊著一段
    // 過期的 Order 文字），對稱於下面 else 分支清 Visitor 覆蓋文字的做法。
    _geoHeatUiRenderOrderMapOverlay();
    _geoHeatUiRenderGa4MapOverlay();
  } else if (layer === 'ga4' && typeof geoGa4FetchAndRender === 'function') {
    Promise.resolve(geoGa4FetchAndRender(containerId))
      .then(() => { _geoHeatUiApplyLayerExclusivity(geoHeatUiState.layer); _geoHeatUiRenderGa4MapOverlay(); })
      .catch(() => { _geoHeatUiRenderGa4MapOverlay(); });
    _geoHeatUiRenderGa4MapOverlay();
    _geoHeatUiRenderVisitorMapOverlay();
    _geoHeatUiRenderOrderMapOverlay();
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1：進入 GA4 Layer 時同時啟動 H1
    // 子面板（獨立 layerGroup／獨立 fetch，不影響上面既有 G1.5 Realtime
    // Choropleth 的任何邏輯）。window.geoMapState.instance 是既有唯一地圖。
    if (window.GeoGa4H1Panel && typeof window.GeoGa4H1Panel.init === 'function') {
      window.GeoGa4H1Panel.init({
        toolbar: `${containerId}-ga4-h1-toolbar`,
        status: `${containerId}-ga4-h1-status`,
        table: `${containerId}-ga4-h1-table`,
      }, window.geoMapState && window.geoMapState.instance);
    }
  } else {
    // fix18-10-hotfix30-B5-R5.4-G1.5-B1：離開 GA4 Layer（切回 order）時同樣要
    // 清 timer／abort（跟上面 visitor 分支對稱，避免只處理一半）。
    if (typeof geoGa4Deactivate === 'function') geoGa4Deactivate();
    if (window.GeoGa4H1Panel && typeof window.GeoGa4H1Panel.destroy === 'function') {
      window.GeoGa4H1Panel.destroy({ toolbar: `${containerId}-ga4-h1-toolbar` });
    }
    _geoHeatUiRenderVisitorMapOverlay(); // layer==='order' 時，這裡負責移除殘留的 Visitor 覆蓋文字
    _geoHeatUiRenderGa4MapOverlay(); // 同理移除殘留的 GA4 覆蓋文字
    _geoHeatUiRenderCoverageExplanation(containerId); // 用既有快取的 geoHeatState.areas 立即重繪，不必重新 Fetch（內含 _geoHeatUiRenderOrderMapOverlay()）
  }
  return true;
}
function geoHeatUiSetVisitorRange(containerId, range) {
  geoHeatUiState.visitorRange = range;
  if (typeof geoVisitorFetchAndRender === 'function') geoVisitorFetchAndRender(containerId, range);
  if (typeof document !== 'undefined') {
    const el = document.getElementById(`${containerId}-visitor-range-bar`);
    if (el && typeof geoVisitorRangeBarHtml === 'function') el.outerHTML = geoVisitorRangeBarHtml(containerId);
  }
}
// Visitor Layer 面板骨架：Time Range 切換 + Summary + Coverage + Ranking +
// Recent Visitor Log。資料渲染完全交給 public/js/geo-visitor-layer.js 既有
// 的 geoVisitorRender*Dom() 函式，這裡只負責容器 id 骨架（跟 Order Heatmap
// 那組 #-summary/#-coverage/#-ranking 平行但完全獨立的一組 id，不會互相
// 覆寫）。
function geoVisitorRangeBarHtml(containerId) {
  if (typeof GEO_VISITOR_TIME_RANGES === 'undefined') return '';
  const buttons = GEO_VISITOR_TIME_RANGES.map((r) => {
    const active = geoHeatUiState.visitorRange === r;
    const label = (typeof GEO_VISITOR_RANGE_LABEL !== 'undefined' && GEO_VISITOR_RANGE_LABEL[r]) || r;
    return `<button type="button" class="geo-heat-ctl-btn" aria-pressed="${active}" onclick="geoHeatUiSetVisitorRange('${_geoHeatUiEsc(containerId)}','${_geoHeatUiEsc(r)}')">${_geoHeatUiEsc(label)}</button>`;
  }).join('');
  return `<div id="${_geoHeatUiEsc(containerId)}-visitor-range-bar" class="geo-heat-controlbar" role="group" aria-label="Visitor Layer 時間範圍">${buttons}</div>`;
}
function geoHeatUiRenderVisitorLayerHtml(containerId) {
  const hidden = geoHeatUiState.layer !== 'visitor';
  return `<div id="${_geoHeatUiEsc(containerId)}-visitor-layer" ${hidden ? 'hidden' : ''}>
    ${geoVisitorRangeBarHtml(containerId)}
    <div class="geo-heat-section-title">Geo Event Summary</div>
    <div id="${_geoHeatUiEsc(containerId)}-metric-summary" class="geo-heat-summary" aria-live="polite"></div>
    <div class="geo-heat-grid">
      <div class="geo-heat-col geo-heat-summary-col">
        <div class="geo-heat-section-title">Geo Visitor Summary</div>
        <div id="${_geoHeatUiEsc(containerId)}-visitor-summary" class="geo-heat-summary" aria-live="polite"></div>
        <div class="geo-heat-section-title">Visitor Coverage</div>
        <div id="${_geoHeatUiEsc(containerId)}-visitor-coverage" class="geo-heat-coverage"></div>
      </div>
      <div class="geo-heat-col geo-heat-ranking-col">
        <div class="geo-heat-section-title">Visitor Ranking</div>
        <ul id="${_geoHeatUiEsc(containerId)}-visitor-ranking" class="geo-heat-ranking-list" aria-label="Visitor 行政區排行"></ul>
      </div>
    </div>
    <div class="geo-heat-section-title">Recent Geo Events</div>
    <div id="${_geoHeatUiEsc(containerId)}-visitor-recent" class="geo-visitor-recent-panel" aria-live="polite"></div>
  </div>`;
}

// fix18-10-hotfix30-B5-R5.3-A4（Metric Switcher 整合，需求：只能保留一套
// 主切換器）：這是「正式主切換器」，跟共用地圖同一層級渲染（不在任何
// Tab 的隱藏 panel 裡面），Dashboard／Heatmap 兩個分頁都看得到、都可以
// 點擊，點擊後透過 geoVisitorSetMetric() 同時驅動地圖著色（見
// geo-visitor-layer.js 的 GEO_EVENT_TO_MAP_METRIC 對照表）與 Heatmap 分頁
// 內的 Geo Event Summary／Ranking。
function geoHeatUiRenderSharedMetricBar(containerId) {
  return (typeof geoVisitorMetricBarHtml === 'function') ? geoVisitorMetricBarHtml(containerId) : '';
}

function geoHeatUiRenderPanel(containerId) {
  const hidden = geoHeatUiState.activeTab !== 'heatmap';
  const orderLayerHidden = geoHeatUiState.layer !== 'order';
  return `<div id="${_geoHeatUiEsc(containerId)}-panel-heatmap" class="geo-heat-root" role="tabpanel" aria-label="Heatmap" ${hidden ? 'hidden' : ''}>
    ${geoHeatUiLayerToggleHtml(containerId)}
    <div id="${_geoHeatUiEsc(containerId)}-order-layer" ${orderLayerHidden ? 'hidden' : ''}>
    ${geoHeatUiControlBarHtml()}
    <div id="${_geoHeatUiEsc(containerId)}-heat-loading" class="geo-heat-loading" role="status" hidden>${_geoHeatUiEsc(GEO_HEAT_UI_MESSAGES.loading)}</div>
    <div id="${_geoHeatUiEsc(containerId)}-heat-error" class="geo-heat-error" role="alert" hidden></div>
    <div id="${_geoHeatUiEsc(containerId)}-heat-legend" class="geo-heat-legend" aria-live="polite"></div>
    <div id="${_geoHeatUiEsc(containerId)}-coverage-explanation" class="geo-heat-coverage-explanation" aria-live="polite"></div>
    <div class="geo-heat-grid">
      <div class="geo-heat-col geo-heat-summary-col">
        <div class="geo-heat-section-title">Summary</div>
        <div id="${_geoHeatUiEsc(containerId)}-summary" class="geo-heat-summary" aria-live="polite"></div>
        <div class="geo-heat-section-title">Coverage</div>
        <div id="${_geoHeatUiEsc(containerId)}-coverage" class="geo-heat-coverage"></div>
      </div>
      <div class="geo-heat-col geo-heat-ranking-col">
        <div class="geo-heat-section-title">Ranking</div>
        <ul id="${_geoHeatUiEsc(containerId)}-ranking" class="geo-heat-ranking-list" role="listbox" aria-label="Heatmap 行政區排行"></ul>
      </div>
    </div>
    </div>
    ${geoHeatUiRenderVisitorLayerHtml(containerId)}
    ${geoHeatUiRenderGa4LayerHtml(containerId)}
  </div>`;
}

// fix18-10-hotfix30-B5-R5.4-G1.5-B1：GA4 Layer 容器骨架（跟 Order/Visitor
// 那組 id 同一層級、完全獨立的一組 id，不會互相覆寫）。實際 Toolbar／
// Summary／Choropleth 的內容渲染完全交給 geo-ga4-realtime-layer.js 的
// geoGa4FetchAndRender()，這裡只負責容器 id 骨架，跟 Visitor Layer 的
// geoHeatUiRenderVisitorLayerHtml() 是同一種切法。
function geoHeatUiRenderGa4LayerHtml(containerId) {
  const hidden = geoHeatUiState.layer !== 'ga4';
  return `<div id="${_geoHeatUiEsc(containerId)}-ga4-layer" ${hidden ? 'hidden' : ''}>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-toolbar"></div>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-summary" class="geo-ga4-realtime-summary" aria-live="polite"></div>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-status" class="geo-ga4-realtime-status" aria-live="polite"></div>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-notices"></div>
    <!-- fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1：GA4 城市歷史統計/即時快照子面板。
         獨立 id 骨架，跟上面既有 G1.5 Realtime Toolbar/Summary/Status/Notices
         完全不共用元素，只共用同一個 hidden 顯示/隱藏狀態（父層 div 決定）。
         實際渲染交給 public/js/geo-ga4-h1-panel.js 的 GeoGa4H1Panel.init()。 -->
    <hr class="ga4-h1-divider" />
    <div id="${_geoHeatUiEsc(containerId)}-ga4-h1-toolbar" class="ga4-h1-toolbar"></div>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-h1-status" class="ga4-h1-status" aria-live="polite"></div>
    <div id="${_geoHeatUiEsc(containerId)}-ga4-h1-table"></div>
  </div>`;
}

// 需求文件九：Engine 的 _geoHeatRenderRankingDom() 只負責畫 <li data-area-id>，
// 不綁 click／keydown（Engine 不碰 DOM 事件委派）——這裡用 event delegation
// 補上點擊/鍵盤操作，呼叫既有 Engine 的 geoHeatSelectArea()，不重寫選取邏輯。
function _geoHeatUiBindRankingEvents(containerId) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(`${containerId}-ranking`);
  if (!el || el.getAttribute('data-geo-heat-bound') === '1') return;
  el.setAttribute('data-geo-heat-bound', '1');
  const handleSelect = (target) => {
    const li = target && target.closest ? target.closest('[data-area-id]') : null;
    if (!li) return;
    geoHeatSelectArea(li.getAttribute('data-area-id'));
  };
  el.addEventListener('click', (e) => handleSelect(e.target));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleSelect(e.target);
  });
}

// ════════════════════════════════════════════════════════════════
// 六、Fetch + Render（需求文件五）——只呼叫既有兩支 API，合併餵給
//    Engine 既有的 geoHeatBuildAreas()／geoHeatScheduleUpdate()。
// ════════════════════════════════════════════════════════════════
async function geoHeatUiFetchAndRender(containerId) {
  if (typeof document === 'undefined') return;
  const loadingEl = document.getElementById(`${containerId}-heat-loading`);
  const errorEl = document.getElementById(`${containerId}-heat-error`);
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }

  if (geoHeatUiState.enabled === false) {
    // 需求文件四：Heatmap Off——不畫地圖點，Ranking/Summary/Coverage 仍要
    // 有內容（顯示目前沒有可顯示的熱區資料／保留既有 Ranking），不留白畫面。
    if (loadingEl) loadingEl.hidden = true;
    geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, 'ranking_only');
    _geoHeatRenderRankingDom(); _geoHeatRenderSummaryDom(); _geoHeatRenderCoverageCardDom(); _geoHeatRenderLegendDom();
    _geoHeatUiRenderCoverageExplanation(containerId);
    return;
  }

  if (loadingEl) loadingEl.hidden = false;
  geoHeatState.containerId = containerId;
  const curChannel = (typeof av2Channel !== 'undefined' && av2Channel) ? av2Channel : 'all';
  geoHeatState.channel = curChannel;

  const ds = (typeof dashboardDateState !== 'undefined' && dashboardDateState) || {};
  const params = { limit: 200 };
  if (ds.start_date) params.date_from = ds.start_date;
  if (ds.end_date) params.date_to = ds.end_date;
  if (typeof geoDashboardFilters !== 'undefined' && geoDashboardFilters) {
    if (geoDashboardFilters.county_code) params.county_code = geoDashboardFilters.county_code;
    if (geoDashboardFilters.subdivision_code) params.subdivision_code = geoDashboardFilters.subdivision_code;
  }
  if (curChannel && curChannel !== 'all') params.channel = curChannel;

  geoHeatScheduleUpdate(async (signal) => {
    try {
      const [funnelRes, fulfillmentRes] = await Promise.all([
        (typeof getGeoFunnel === 'function') ? getGeoFunnel(params, signal) : Promise.resolve(null),
        (typeof getGeoFulfillmentForHeatmap === 'function') ? getGeoFulfillmentForHeatmap(params, signal) : Promise.resolve(null),
      ]);
      const funnelJson = (funnelRes && funnelRes.ok) ? await funnelRes.json() : null;
      const fulfillmentJson = (fulfillmentRes && fulfillmentRes.ok) ? await fulfillmentRes.json() : null;
      if (!funnelJson || !funnelJson.success || !fulfillmentJson || !fulfillmentJson.success) {
        if (errorEl) { errorEl.hidden = false; errorEl.textContent = GEO_HEAT_UI_MESSAGES.error; }
        return [];
      }
      const funnelAreas = (funnelJson.data && funnelJson.data.areas) || [];
      const fulfillmentAreas = (fulfillmentJson.data && fulfillmentJson.data.areas) || [];
      const areas = geoHeatBuildAreas(funnelAreas, fulfillmentAreas);
      // fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件三、四）：業務總量是
      // additive 欄位，只有 API 明確回傳「數字」時才採用；缺欄位（例如舊
      // fixture／API 尚未部署）一律是 null，交由 _geoHeatMetricTotals()
      // fallback 回舊行為，不臆測。
      const fd = fulfillmentJson.data || {};
      const businessTotals = {
        orders: (typeof fd.business_total_orders === 'number') ? fd.business_total_orders : null,
        revenue: (typeof fd.business_total_revenue === 'number') ? fd.business_total_revenue : null,
      };
      return { areas, businessTotals };
    } catch (e) {
      if (e && e.name === 'AbortError') return geoHeatState.areas; // 被更新的請求取消，不視為錯誤
      if (errorEl) { errorEl.hidden = false; errorEl.textContent = GEO_HEAT_UI_MESSAGES.error; }
      return [];
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }, 250);
  // fix18-10-hotfix30-B5-R5.4-G1.3：geoHeatScheduleUpdate()（Engine，未修改）
  // 內部本身有 250ms debounce，資料回來後會呼叫既有的 Ranking/Summary/
  // Coverage/Legend render；這裡在稍晚一點（+10ms 緩衝）重新產生 Coverage
  // Explanation 文字，只讀取 Engine 已經算好的 geoHeatState.areas，不修改
  // Engine 任何邏輯或呼叫時機。
  if (typeof setTimeout === 'function') {
    setTimeout(() => { try { _geoHeatUiRenderCoverageExplanation(containerId); } catch (e) { /* 安靜失敗，不擋主要渲染 */ } }, 260);
  }
}

// ════════════════════════════════════════════════════════════════
// 七、Dashboard render 完成後的接線點（由 geo-intelligence.js 呼叫，
//    guard 過 typeof，未載入本檔案時安全略過，跟既有 geoRenderMapBlock
//    的呼叫慣例一致）
// ════════════════════════════════════════════════════════════════
function geoHeatUiRegisterContext(containerId, mapContainerId) {
  geoHeatUiState.containerId = containerId;
  geoHeatUiState.mapContainerId = mapContainerId;
  // 需求文件十七：Store Isolation——每次重新掛載（切店/重新整理都會重跑
  // 這個函式）一律先清空 Engine 既有的 Heat Layer／Selection／pending
  // request，再視目前分頁決定要不要立即抓新資料，不沿用上一店的殘留狀態。
  if (typeof geoHeatHandleStoreSwitch === 'function') geoHeatHandleStoreSwitch();
  // fix18-10-hotfix30-B5-R5.3-A1.2：Visitor Layer 是獨立 state，切店時也要
  // 一併清空，避免殘留上一店的 geo_visit_log 資料（需求文件 Store Isolation）。
  if (typeof geoVisitorHandleStoreSwitch === 'function') geoVisitorHandleStoreSwitch();
  // fix18-10-hotfix30-B5-R5.3-A4（需求文件七）：Geo Event Engine 的統一
  // Metric 切換器現在跟共用地圖同一層級，Dashboard／Heatmap 兩個分頁都看
  // 得到，所以不論目前在哪個分頁，頁面掛載就要主動抓一次資料（預設
  // Metric 為「訪客」），不需要使用者先手動切到 Heatmap 分頁或 Visitor
  // Layer 才看得到資料。
  if (typeof geoVisitorFetchAndRender === 'function') {
    Promise.resolve(geoVisitorFetchAndRender(containerId, geoHeatUiState.visitorRange))
      .then(() => { _geoHeatUiApplyLayerExclusivity(geoHeatUiState.layer); _geoHeatUiRenderVisitorMapOverlay(); })
      .catch(() => { _geoHeatUiRenderVisitorMapOverlay(); });
  }
  // 需求文件六：切店/重新掛載時，若殘留上一店的 Visitor 覆蓋文字，先移除
  // （新店資料回來前的空檔一律顯示「載入中」而不是上一店的舊訊息）。
  _geoHeatUiRenderVisitorMapOverlay();
  if (geoHeatUiState.activeTab === 'heatmap') {
    _geoHeatUiEnsureMapReuse(containerId);
    _geoHeatUiBindRankingEvents(containerId);
    geoHeatUiFetchAndRender(containerId);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_HEAT_UI_TABS, GEO_HEAT_UI_DISPLAY_LABEL, GEO_HEAT_UI_MESSAGES,
    geoHeatUiRenderTabBar, geoHeatUiSwitchTab,
    geoHeatUiControlBarHtml, geoHeatUiRenderPanel,
    geoHeatUiSetMetric, geoHeatUiSetDisplay, geoHeatUiSetChannel, geoHeatUiToggleEnabled,
    geoHeatUiFetchAndRender, geoHeatUiRegisterContext,
    // fix18-10-hotfix30-B5-R5.3-A1.2
    geoHeatUiLayerToggleHtml, geoHeatUiSetLayer, geoHeatUiSetVisitorRange,
    geoHeatUiRenderVisitorLayerHtml, geoVisitorRangeBarHtml, geoHeatUiRenderSharedMetricBar,
    _geoHeatUiEnsureMapReuse, _geoHeatUiRestoreChoropleth, _geoHeatUiBindRankingEvents,
    _geoHeatUiRerenderControlBar, _geoHeatUiResetStateForTest,
    // fix18-10-hotfix30-B5-R5.4-G1.2（Layer Switch Bug Fix）
    _geoHeatUiRerenderLayerToggle, _geoHeatUiApplyLayerExclusivity,
    _geoHeatUiVisitorMapOverlayMessage, _geoHeatUiRenderVisitorMapOverlay,
    // fix18-10-hotfix30-B5-R5.4-G1.3（Metric Sync & Coverage Explanation）
    GEO_EVENT_TO_HEATMAP_METRIC, GEO_HEATMAP_TO_EVENT_METRIC,
    geoHeatUiSyncMetricFromGlobal,
    _geoHeatMetricTotals, _geoHeatBuildCoverageExplanationText, _geoHeatUiRenderCoverageExplanation,
    GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION,
    _geoHeatBuildBusinessOpportunityEmptyText, GEO_HEAT_RECOMMENDED_ACTION_LOW_GEO_COVERAGE,
    _geoHeatBuildDeliveryOptimizationText,
    // fix18-10-hotfix30-B5-R5.4-G1.4（Map Label Rendering & Honest Drawable-State Fix）
    _geoHeatUiOrderMapOverlayMessage, _geoHeatUiRenderOrderMapOverlay,
    // fix18-10-hotfix30-B5-R5.4-G1.5（GA4 Realtime Visitor Geo Layer）
    _geoHeatUiRenderGa4MapOverlay,
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE（Heatmap→Dashboard
    // Layer Lifecycle Cleanup，第一階段）
    _geoHeatUiCleanupForDashboard, _geoHeatUiRemoveLayerIfPresent,
    _geoHeatUiDashboardGa4Ids,
    get geoHeatUiState() { return geoHeatUiState; },
  };
}
