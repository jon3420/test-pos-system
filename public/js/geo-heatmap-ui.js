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
    _geoHeatUiRestoreChoropleth();
  }
  return true;
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

function geoHeatUiSetMetric(metric) {
  if (!GEO_HEAT_METRICS.includes(metric)) return;
  geoHeatState.metric = metric;
  geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);
  _geoHeatRenderRankingDom(); _geoHeatRenderSummaryDom(); _geoHeatRenderCoverageCardDom(); _geoHeatRenderLegendDom();
  if (geoHeatUiState.containerId) _geoHeatUiRerenderControlBar(geoHeatUiState.containerId);
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
  const layers = [['order', '訂單熱區 Order Heatmap'], ['visitor', '訪客熱區 Visitor Layer']];
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
  if (layer === 'order') {
    if (visitorGroup && map.hasLayer(visitorGroup)) map.removeLayer(visitorGroup);
    if (orderGroup && !map.hasLayer(orderGroup)) map.addLayer(orderGroup);
  } else if (layer === 'visitor') {
    if (orderGroup && map.hasLayer(orderGroup)) map.removeLayer(orderGroup);
    if (visitorGroup && !map.hasLayer(visitorGroup)) map.addLayer(visitorGroup);
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
    return `目前有 ${c.total} 位訪客，但尚未取得可繪製的真實座標\n`
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

function geoHeatUiSetLayer(containerId, layer) {
  if (layer !== 'order' && layer !== 'visitor') return false;
  geoHeatUiState.layer = layer;
  if (typeof document !== 'undefined') {
    const orderEl = document.getElementById(`${containerId}-order-layer`);
    const visitorEl = document.getElementById(`${containerId}-visitor-layer`);
    if (orderEl) orderEl.hidden = layer !== 'order';
    if (visitorEl) visitorEl.hidden = layer !== 'visitor';
  }
  // 修正 Root Cause 一：按鈕 active/aria-pressed 重新渲染整段 HTML，不再是
  // 「查到按鈕卻什麼都不做」的空 forEach。
  _geoHeatUiRerenderLayerToggle(containerId);
  // 修正 Root Cause 二：Order/Visitor 兩個既有 Leaflet layerGroup 互斥顯示
  // （只 addLayer/removeLayer，不 clearLayers/不重建）。
  _geoHeatUiApplyLayerExclusivity(layer);
  if (layer === 'visitor' && typeof geoVisitorFetchAndRender === 'function') {
    // 修正 Root Cause 三：資料抓回來、choropleth 畫完之後，再依當下真實的
    // status/coverage 決定要不要顯示「無可繪製座標」等地圖覆蓋文字。
    Promise.resolve(geoVisitorFetchAndRender(containerId, geoHeatUiState.visitorRange))
      .then(() => { _geoHeatUiApplyLayerExclusivity(geoHeatUiState.layer); _geoHeatUiRenderVisitorMapOverlay(); })
      .catch(() => { _geoHeatUiRenderVisitorMapOverlay(); });
    _geoHeatUiRenderVisitorMapOverlay(); // 先用目前已知狀態畫一次（多半是 loading），資料回來後上面再更新一次
  } else {
    _geoHeatUiRenderVisitorMapOverlay(); // layer==='order' 時，這裡負責移除殘留的 Visitor 覆蓋文字
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
      return geoHeatBuildAreas(funnelAreas, fulfillmentAreas);
    } catch (e) {
      if (e && e.name === 'AbortError') return geoHeatState.areas; // 被更新的請求取消，不視為錯誤
      if (errorEl) { errorEl.hidden = false; errorEl.textContent = GEO_HEAT_UI_MESSAGES.error; }
      return [];
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }, 250);
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
    get geoHeatUiState() { return geoHeatUiState; },
  };
}
