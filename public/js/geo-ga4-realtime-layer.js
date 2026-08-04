// public/js/geo-ga4-realtime-layer.js — fix18-10-hotfix30-B5-R5.4-G1.5-B1
// GA4 Realtime Visitor Geo Layer（前端，正式重寫版）
//
// 唯一 Contract 來源：R5.4-G1.5-A_API_CONTRACT.md（見
// R5.4-G1.5-B1_CONTRACT_CONFORMANCE_AUDIT.md 的實測核對）。
//
// 邊界（不得違反）：
//   1. 只從 GET /api/geo-live/ga4-realtime 讀取資料，不持有／不讀取任何
//      Google 憑證、Property ID、Stream ID（本檔案沒有任何這類變數名稱）。
//   2. 不冒充 GPS／精確位置：只用既有 window.geoMapState.featureIndex 的
//      官方行政區 GeoJSON 做「整個縣市同色」的 Polygon 著色，不建立
//      Marker／Circle／CircleMarker、不查表補 lat/lng。
//   3. summary.total_active_users_ga4 是唯一去重後總數；本檔案任何地方都
//      不對 counties[].active_users 做加總或跟系統 Visitor 數字相加。
//   4. 重用既有 Leaflet map（window.geoMapState.instance），不 new L.Map()／
//      L.tileLayer()。Polygon 繪製沿用本專案 Order Heatmap／Visitor Layer
//      既有慣例（geo-heatmap.js／geo-visitor-layer.js 的
//      geoVisitorRenderChoropleth()）：維護自己的 L.layerGroup()，每次
//      render 用 clearLayers() 清空後，對每個既有 feature 建立新的
//      L.geoJSON(feature, {style}) clone 加進 group——不直接修改
//      featureIndex 內原始 feature 物件的樣式，因此「離開 GA4 Layer」只需
//      把這個 group 從地圖上 removeLayer()（見 geo-heatmap-ui.js 的
//      _geoHeatUiApplyLayerExclusivity()），不需要另外一套
//      save/restore-style machinery，也不會有「原 GeoJSON 被永久改樣式」
//      的風險（設計決策記錄於 R5.4-G1.5-B1_FRONTEND_CHOROPLETH_REPORT.md）。

'use strict';

const GEO_GA4_WINDOWS = Object.freeze([5, 30]);
const GEO_GA4_METRICS = Object.freeze(['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase']);
const GEO_GA4_METRIC_LABEL = Object.freeze({
  visitors: '訪客', view_item: '商品瀏覽', add_to_cart: '加入購物車',
  checkout: '開始結帳', purchase: '完成購買',
});
const GEO_GA4_STATUS_LABEL = Object.freeze({
  disabled: '尚未啟用', not_configured: '尚未設定', fresh: '即時', cached: '快取',
  stale_cache: '過期快取', error: '連線錯誤', auth_error: '登入已失效',
});

// fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：GA4 Backend Connection Error 訊息
// 對照表（跟 public/js/geo-ga4-settings.js 的 GA4_SETTINGS_TEST_ERROR_MESSAGES
// 同一組錯誤碼命名，維持一致用語），只用於「已經確定不是 Authentication
// 問題」的 status==='error' 情況（見需求文件七：Authentication Error 與
// GA4 Connection Error 必須分開，不得混用同一段文字）。
const GEO_GA4_ERROR_MESSAGES = Object.freeze({
  ga4_realtime_disabled: '店家設定已保存，但伺服器尚未開啟 GA4 即時功能。',
  credential_unavailable: '伺服器尚未設定 GA4 憑證。',
  credential_invalid: 'GA4 憑證格式錯誤。',
  permission_denied: 'Service Account 沒有此 GA4 Property 的讀取權限。',
  property_not_found: '找不到此 GA4 Property。',
  stream_filter_invalid: 'Stream ID 無法套用於目前 Property。',
  quota_limited: 'GA4 API 暫時達到使用限制。',
  ga4_timeout: 'GA4 連線逾時，請稍後再試。',
  ga4_unavailable: 'Google Analytics 暫時無法連線。',
});

// Authentication 失敗（Store Token 缺失／失效）固定文案，跟 GA4 Backend
// 錯誤完全分開，不得共用同一段訊息（需求文件七、八）。
const GEO_GA4_AUTH_ERROR_MESSAGE = '店家登入狀態已失效，請重新登入後再試。';

// 需求文件九：GA4 縣市著色固定樣式（青色虛線），不使用訂單熱區的
// 綠→黃→紅強度色階，不使用訪客層的藍色系，一望即知是第三種圖層。
const GEO_GA4_POLYGON_STYLE = Object.freeze({
  color: '#0891b2', fillColor: '#06b6d4', weight: 2, opacity: 0.9, fillOpacity: 0.20, dashArray: '6,4',
});
const GEO_GA4_POLYGON_STYLE_NO_DATA = Object.freeze({
  color: '#0891b2', fillColor: '#06b6d4', weight: 1, opacity: 0.5, fillOpacity: 0.06, dashArray: '3,5',
});

const GA4_REALTIME_DISCLAIMER = 'GA4 位置由 IP 推估，僅供區域趨勢分析，非精確定位。';
const GA4_REALTIME_PRIVACY_NOTICE = 'Google Analytics 可能基於隱私保護省略部分低量資料。';

const geoGa4State = {
  active: false,
  containerId: null,
  windowMinutes: 5,
  metric: 'visitors',
  loading: false,
  requestSeq: 0,
  abortController: null,
  autoRefreshTimer: null,
  autoRefreshSeconds: 60,
  configAutoRefreshEnabled: true, // fix18-10-hotfix30-B5-R5.4-G1.5-B2：來自店家設定的開關，見 geoGa4FetchAndRender()
  lastPayload: null,
  lastFetchedAt: null,
  layerGroup: null,
  countyIndex: null, // Map<county_code, feature[]>，第一次 render 建立後快取
};
if (typeof window !== 'undefined') window.geoGa4State = geoGa4State;

function _geoGa4ResetStateForTest() {
  geoGa4State.active = false;
  geoGa4State.containerId = null;
  geoGa4State.windowMinutes = 5;
  geoGa4State.metric = 'visitors';
  geoGa4State.loading = false;
  geoGa4State.requestSeq = 0;
  if (geoGa4State.abortController && typeof geoGa4State.abortController.abort === 'function') {
    try { geoGa4State.abortController.abort(); } catch (e) { /* ignore */ }
  }
  geoGa4State.abortController = null;
  if (geoGa4State.autoRefreshTimer) { clearTimeout(geoGa4State.autoRefreshTimer); }
  geoGa4State.autoRefreshTimer = null;
  geoGa4State.autoRefreshSeconds = 60;
  geoGa4State.lastPayload = null;
  geoGa4State.lastFetchedAt = null;
  geoGa4State.layerGroup = null;
  geoGa4State.countyIndex = null;
}

function _geoGa4Esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ══════════════════════════════════════════════════════════════════
// Fetch Contract
// ══════════════════════════════════════════════════════════════════

function geoGa4BuildRequestUrl({ windowMinutes, metric, refresh }) {
  const w = GEO_GA4_WINDOWS.includes(windowMinutes) ? windowMinutes : 5;
  const m = GEO_GA4_METRICS.includes(metric) ? metric : 'visitors';
  const r = refresh ? '1' : '0';
  return `/api/geo-live/ga4-realtime?window=${w}&metric=${encodeURIComponent(m)}&refresh=${r}`;
}

// geoGa4NormalizeResponse(json) — 對後端回應做防禦性正規化，格式不符時回傳
// 安全預設值（不 throw，不讓一個 malformed response 打壞整個 UI）。
function geoGa4NormalizeResponse(json) {
  const empty = {
    ok: false,
    status: 'error', quota_status: 'unknown', fetched_at: null, cache_age_seconds: null,
    is_cached: false, is_stale: false, error_code: 'malformed_response',
    summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
    counties: [], unmapped: [], notices: [],
  };
  if (!json || json.success !== true || !json.data || typeof json.data !== 'object') {
    if (json && json.success === false) {
      return { ...empty, status: 'error', error_code: json.code || 'GA4_API_ERROR', message: json.message, retryable: !!json.retryable };
    }
    return empty;
  }
  const d = json.data;
  const summary = (d.summary && typeof d.summary === 'object') ? d.summary : empty.summary;
  return {
    ok: true,
    status: typeof d.status === 'string' ? d.status : 'error',
    quota_status: typeof d.quota_status === 'string' ? d.quota_status : 'unknown',
    fetched_at: d.fetched_at || null,
    cache_age_seconds: (typeof d.cache_age_seconds === 'number') ? d.cache_age_seconds : null,
    is_cached: !!d.is_cached,
    is_stale: !!d.is_stale,
    error_code: d.error_code || null,
    summary: {
      total_active_users_ga4: Number(summary.total_active_users_ga4) || 0,
      event_count: Number(summary.event_count) || 0,
      screen_page_views: (summary.screen_page_views === null || summary.screen_page_views === undefined) ? null : Number(summary.screen_page_views),
      mapped_counties: Number(summary.mapped_counties) || 0,
      unmapped_city_rows: Number(summary.unmapped_city_rows) || 0,
      excluded_non_tw_rows: Number(summary.excluded_non_tw_rows) || 0,
    },
    counties: Array.isArray(d.counties) ? d.counties : [],
    unmapped: Array.isArray(d.unmapped) ? d.unmapped : [],
    notices: Array.isArray(d.notices) ? d.notices : [],
  };
}

// geoGa4AuthErrorPayload(body) — fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：apiFetch
// 對 401／403 回傳的不是原生 fetch Response，而是 `{ ok:false, status, body }`
// （見 public/js/app.js apiFetch()）。這裡把它轉成跟 geoGa4NormalizeResponse()
// 一致的 shape，但用獨立的 status='auth_error'，不落入 GA4 Backend 的
// status='error' 分支，兩者訊息與判斷邏輯完全分開（需求文件七）。
function geoGa4AuthErrorPayload(body) {
  const b = body || {};
  return {
    ok: false,
    status: 'auth_error', quota_status: 'unknown', fetched_at: null, cache_age_seconds: null,
    is_cached: false, is_stale: false, error_code: b.error || 'AUTH_REQUIRED',
    message: GEO_GA4_AUTH_ERROR_MESSAGE,
    summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
    counties: [], unmapped: [], notices: [],
  };
}

// geoGa4FetchData() — fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：改用 apiFetch()
// （跟 public/js/geo-ga4-settings.js 完全同一套呼叫方式），不再使用無認證
// 的裸 fetch()。apiFetch() 內部負責 Authorization／x-store-id／Store
// Session／401-403 處理，這裡不建立第二套 Token 讀取邏輯（需求文件二、四）。
async function geoGa4FetchData({ windowMinutes, metric, refresh, signal }) {
  const url = geoGa4BuildRequestUrl({ windowMinutes, metric, refresh });
  const res = (typeof apiFetch === 'function')
    ? await apiFetch(url, { method: 'GET', signal })
    : null;
  if (!res) return geoGa4NormalizeResponse(null); // apiFetch 不存在（極端防禦，正常環境不會發生）
  // apiFetch 對 401／403 回傳的是 { ok:false, status, body }（不是原生
  // Response，沒有 .json()），必須先判斷 status 再決定要不要呼叫 .json()，
  // 否則會直接噴 TypeError（見需求文件五）。
  if (res.status === 401 || res.status === 403) {
    return geoGa4AuthErrorPayload(res.body);
  }
  if (typeof res.json !== 'function') return geoGa4NormalizeResponse(null);
  const json = await res.json();
  return geoGa4NormalizeResponse(json);
}

// geoGa4FetchStatus() — fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：從
// geoGa4FetchAndRender() 內原本直接寫死的裸 fetch('/api/geo-live/
// ga4-realtime-status') 抽出來的具名函式，一樣改用 apiFetch()。401／403
// 時安全回傳 null（讓呼叫端維持目前 configAutoRefreshEnabled 值，不阻擋
// 主要的 Data Request──真正的 Auth 錯誤會由 Data Request 那邊統一顯示，
// 這裡不重複顯示第二次相同錯誤）。
async function geoGa4FetchStatus() {
  const res = (typeof apiFetch === 'function')
    ? await apiFetch('/api/geo-live/ga4-realtime-status', { method: 'GET' })
    : null;
  if (!res) return null;
  if (res.status === 401 || res.status === 403) return null;
  if (typeof res.json !== 'function') return null;
  try {
    const json = await res.json();
    if (json && json.success === true && json.data && typeof json.data === 'object') return json.data;
  } catch (e) { /* malformed response，安全降級為 null，不拋出 */ }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// County Polygon Mapping（重用既有 featureIndex，不建立座標）
// ══════════════════════════════════════════════════════════════════

// _geoGa4BuildCountyIndex(featureIndex) → Map<county_code, feature[]>
//   只需要建立一次（同一個 featureIndex 底下 feature 不會變），第一次
//   render 後快取在 geoGa4State.countyIndex，避免每次 render 都對整張地圖
//   做全掃描（見需求文件八：「不能每次 render 都對整張地圖做無限制全掃
//   描」）。
function _geoGa4BuildCountyIndex(featureIndex) {
  const index = new Map();
  if (!featureIndex || !featureIndex.byCountyDistrict || typeof featureIndex.byCountyDistrict.values !== 'function') {
    return index;
  }
  for (const feature of featureIndex.byCountyDistrict.values()) {
    const props = (feature && feature.properties) || {};
    // county_code 優先；沒有的話退回用 county 名稱正規化過的字串當 key
    // （只是索引 key，不是座標，不影響「不假造座標」原則）。
    const key = props.county_code || props.countyCode || props.county;
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(feature);
  }
  return index;
}

function geoGa4FindLayersForCounty(countyCode, featureIndex) {
  if (!geoGa4State.countyIndex) {
    geoGa4State.countyIndex = _geoGa4BuildCountyIndex(featureIndex);
  }
  return geoGa4State.countyIndex.get(countyCode) || [];
}

// ══════════════════════════════════════════════════════════════════
// Choropleth（沿用 Order/Visitor 既有的 clearLayers()+clone 慣例）
// ══════════════════════════════════════════════════════════════════

function geoGa4BuildTooltipContent(county, windowLabel) {
  return `<div class="geo-ga4-realtime-tooltip">`
    + `<strong>${_geoGa4Esc(county.county_name)}</strong><br/>`
    + `GA4 即時活躍訪客：${_geoGa4Esc(county.active_users)}<br/>`
    + `事件數：${_geoGa4Esc(county.event_count)}<br/>`
    + `時間範圍：${_geoGa4Esc(windowLabel)}<br/>`
    + `來源：Google Analytics 即時<br/>`
    + `<span class="geo-ga4-realtime-tooltip-note">精度：IP 城市／縣市級推估，非精確位置</span>`
    + `</div>`;
}

// geoGa4RenderChoropleth(mapInstance, featureIndex, payload)
//   → { drawn, skipped }
function geoGa4RenderChoropleth(mapInstance, featureIndex, payload) {
  if (!geoGa4State.layerGroup) {
    if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
      geoGa4State.layerGroup = L.layerGroup();
      if (mapInstance && typeof geoGa4State.layerGroup.addTo === 'function') {
        geoGa4State.layerGroup.addTo(mapInstance);
      }
    }
  }
  const group = geoGa4State.layerGroup;
  if (!group || typeof group.clearLayers !== 'function') return { drawn: 0, skipped: 0 };
  group.clearLayers();

  const counties = (payload && payload.counties) || [];
  if (!featureIndex || typeof L === 'undefined' || typeof L.geoJSON !== 'function') {
    return { drawn: 0, skipped: counties.length };
  }

  const windowLabel = geoGa4State.windowMinutes === 30 ? '最近30分鐘' : '最近5分鐘';
  let drawn = 0; let skipped = 0;
  counties.forEach((county) => {
    const features = geoGa4FindLayersForCounty(county.county_code, featureIndex);
    if (!features.length) { skipped += 1; return; }
    features.forEach((feature) => {
      try {
        const layer = L.geoJSON(feature, { style: () => ({ ...GEO_GA4_POLYGON_STYLE }) });
        if (typeof layer.bindTooltip === 'function') layer.bindTooltip(geoGa4BuildTooltipContent(county, windowLabel), { sticky: true });
        group.addLayer(layer);
      } catch (e) { /* 單一 feature 失敗不影響其餘 feature 繪製 */ }
    });
    drawn += 1;
  });

  return { drawn, skipped };
}

// geoGa4ClearLayer()／geoGa4RestoreStyles()：離開 GA4 Layer 時呼叫。因為
// 本檔案從不修改 featureIndex 原始 feature 的樣式（只在自己的 layerGroup
// 裡放 clone），這裡的「restore」等同「清空自己的 group」——原始
// GeoJSON／其他圖層樣式從頭到尾都沒被動過，不需要另外記錄/還原。
function geoGa4ClearLayer() {
  if (geoGa4State.layerGroup && typeof geoGa4State.layerGroup.clearLayers === 'function') {
    geoGa4State.layerGroup.clearLayers();
  }
}
function geoGa4RestoreStyles() {
  geoGa4ClearLayer();
}

// ══════════════════════════════════════════════════════════════════
// UI：Toolbar／Summary／Status／Notices
// ══════════════════════════════════════════════════════════════════

function geoGa4RenderToolbarHtml(containerId) {
  const windowBtns = GEO_GA4_WINDOWS.map((w) => {
    const active = geoGa4State.windowMinutes === w;
    return `<button type="button" class="geo-ga4-realtime-window-btn" aria-pressed="${active}" onclick="geoGa4SetWindow('${_geoGa4Esc(containerId)}',${w})">最近${w}分鐘</button>`;
  }).join('');
  const metricBtns = GEO_GA4_METRICS.map((m) => {
    const active = geoGa4State.metric === m;
    return `<button type="button" class="geo-ga4-realtime-metric-btn" aria-pressed="${active}" onclick="geoGa4SetMetric('${_geoGa4Esc(containerId)}','${m}')">${_geoGa4Esc(GEO_GA4_METRIC_LABEL[m])}</button>`;
  }).join('');
  // 需求文件六：不得顯示 Revenue／Conversion／Order 的 Circle/Marker 切換／
  // Channel Filter／Heatmap On checkbox——這裡完全不渲染這些控制項（不是
  // disabled 隱藏，是從一開始就不生成對應 DOM）。
  return `<div class="geo-ga4-realtime-toolbar">
    <div class="geo-ga4-realtime-toolbar-group" role="group" aria-label="時間範圍">${windowBtns}</div>
    <div class="geo-ga4-realtime-toolbar-group" role="group" aria-label="指標">${metricBtns}</div>
    <button type="button" class="geo-ga4-realtime-refresh-btn" onclick="geoGa4Refresh('${_geoGa4Esc(containerId)}')">重新整理</button>
  </div>`;
}

function geoGa4RenderSummaryHtml(payload) {
  if (!payload || !payload.ok) return '';
  const s = payload.summary;
  const cards = [
    ['GA4 活躍訪客', s.total_active_users_ga4],
    ['GA4 事件數', s.event_count],
  ];
  if (geoGa4State.metric === 'visitors' && s.screen_page_views !== null) cards.push(['網頁瀏覽', s.screen_page_views]);
  cards.push(['已對應縣市', s.mapped_counties]);
  cards.push(['未對應城市', s.unmapped_city_rows]);
  cards.push(['排除非台灣資料', s.excluded_non_tw_rows]);
  return cards.map(([label, value]) => (
    `<div class="geo-ga4-realtime-card"><div class="geo-ga4-realtime-card-label">${_geoGa4Esc(label)}</div><div class="geo-ga4-realtime-card-value">${_geoGa4Esc(value)}</div></div>`
  )).join('');
}

function geoGa4StatusMessage(payload) {
  if (!payload) return '';
  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：Authentication 失敗與 GA4 Backend
  // 錯誤分開判斷，不得共用同一段文字（需求文件七）。
  if (payload.status === 'auth_error') return GEO_GA4_AUTH_ERROR_MESSAGE;
  if (payload.status === 'disabled') return GEO_GA4_ERROR_MESSAGES.ga4_realtime_disabled;
  if (payload.status === 'not_configured') {
    const reasonMap = {
      missing_property: '尚未設定 Property', stream_not_configured: '尚未設定 Stream',
      invalid_property: 'Property 格式錯誤', invalid_stream: 'Stream 格式錯誤',
      SDK_UNAVAILABLE: 'Server 尚未設定憑證',
    };
    const reason = reasonMap[payload.error_code] || '尚未完成設定';
    return `${reason}。請至 GA4 設定完成 Property／Stream 設定。`;
  }
  if (payload.status === 'error') {
    return GEO_GA4_ERROR_MESSAGES[payload.error_code] || 'GA4 連線發生錯誤，請稍後再試。';
  }
  if (payload.status === 'fresh') return '剛剛更新';
  if (payload.status === 'cached') return `目前顯示 ${payload.cache_age_seconds ?? 0} 秒前的快取資料`;
  if (payload.status === 'stale_cache') return `Google Analytics 暫時無法連線，目前顯示 ${payload.cache_age_seconds ?? 0} 秒前的舊資料`;
  return GEO_GA4_STATUS_LABEL[payload.status] || '';
}

function geoGa4QuotaWarning(payload) {
  if (!payload) return '';
  if (payload.quota_status === 'near_limit') return 'GA4 API 使用量接近限制，更新頻率已降低';
  if (payload.quota_status === 'limited') return 'GA4 API 暫時受限，請稍後手動重新整理';
  return '';
}

function geoGa4RenderStatusHtml(payload) {
  if (!payload) return '';
  const msg = geoGa4StatusMessage(payload);
  const cls = payload.is_stale ? ' geo-ga4-realtime-stale' : '';
  return `<div class="geo-ga4-realtime-status${cls}" data-state="${_geoGa4Esc(payload.status)}">${_geoGa4Esc(msg)}</div>`;
}

function geoGa4RenderNoticesHtml(payload) {
  const parts = [`<div class="geo-ga4-realtime-notice">${_geoGa4Esc(GA4_REALTIME_DISCLAIMER)}</div>`];
  parts.push(`<div class="geo-ga4-realtime-notice">${_geoGa4Esc(GA4_REALTIME_PRIVACY_NOTICE)}</div>`);
  if (payload && Array.isArray(payload.notices)) {
    payload.notices.forEach((n) => {
      if (n === GA4_REALTIME_DISCLAIMER || n === GA4_REALTIME_PRIVACY_NOTICE) return; // 避免後端也回同一句造成重複
      parts.push(`<div class="geo-ga4-realtime-notice">${_geoGa4Esc(n)}</div>`);
    });
  }
  const quotaMsg = geoGa4QuotaWarning(payload);
  if (quotaMsg) parts.push(`<div class="geo-ga4-realtime-warning">${_geoGa4Esc(quotaMsg)}</div>`);

  if (payload && payload.ok) {
    if (payload.summary.total_active_users_ga4 === 0) {
      parts.push(`<div class="geo-ga4-realtime-empty">最近${geoGa4State.windowMinutes}分鐘沒有 GA4 活躍使用者。</div>`);
    } else if (!payload.counties.length) {
      parts.push('<div class="geo-ga4-realtime-empty">目前有 GA4 活躍資料，但 Google 未提供可安全對應到台灣縣市的城市資料。</div>');
    }
    if (payload.unmapped && payload.unmapped.length) {
      const shown = payload.unmapped.slice(0, 5).map((u) => `${_geoGa4Esc(u.city)}（${_geoGa4Esc(u.event_count)}）`).join('、');
      const more = payload.unmapped.length > 5 ? `，另有 ${payload.unmapped.length - 5} 筆` : '';
      parts.push(`<div class="geo-ga4-realtime-notice">未對應城市：${shown}${more}</div>`);
    }
  }
  if (payload && (payload.status === 'error' || payload.status === 'auth_error')) {
    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：不直接印後端原始 payload.message
    // （避免任何來源的原始錯誤字串未經分類就外洩到畫面上），一律透過
    // geoGa4StatusMessage() 的錯誤碼對照表決定顯示文字。
    parts.push(`<div class="geo-ga4-realtime-error">${_geoGa4Esc(geoGa4StatusMessage(payload))}</div>`);
  }
  return parts.join('');
}

function _geoGa4RenderDom(containerId, payload) {
  if (typeof document === 'undefined') return;
  const toolbarEl = document.getElementById(`${containerId}-ga4-toolbar`);
  if (toolbarEl) toolbarEl.innerHTML = geoGa4RenderToolbarHtml(containerId);
  const summaryEl = document.getElementById(`${containerId}-ga4-summary`);
  if (summaryEl) summaryEl.innerHTML = geoGa4RenderSummaryHtml(payload);
  const statusEl = document.getElementById(`${containerId}-ga4-status`);
  if (statusEl) statusEl.innerHTML = geoGa4RenderStatusHtml(payload);
  const noticesEl = document.getElementById(`${containerId}-ga4-notices`);
  if (noticesEl) noticesEl.innerHTML = geoGa4RenderNoticesHtml(payload);
}

// ══════════════════════════════════════════════════════════════════
// Fetch orchestration：AbortController + requestSeq（避免舊回應覆蓋新狀態）
// ══════════════════════════════════════════════════════════════════

async function _geoGa4RunFetch(containerId, { refresh = false } = {}) {
  if (geoGa4State.abortController && typeof geoGa4State.abortController.abort === 'function') {
    geoGa4State.abortController.abort();
  }
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  geoGa4State.abortController = controller;
  const mySeq = ++geoGa4State.requestSeq;
  geoGa4State.loading = true;

  let payload;
  try {
    payload = await geoGa4FetchData({
      windowMinutes: geoGa4State.windowMinutes, metric: geoGa4State.metric, refresh,
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 被下一次呼叫取代，安靜結束，不覆蓋新狀態
    payload = geoGa4NormalizeResponse(null);
    payload.status = 'error';
    payload.message = 'GA4 Realtime API 發生錯誤，請稍後再試';
  }

  // requestSeq 防止舊回應覆蓋新狀態：若此次 fetch 開始後又有更新的請求
  // 發出（例如快速切換 metric/window），只有最後一次的結果會被 render。
  if (mySeq !== geoGa4State.requestSeq) return;

  geoGa4State.loading = false;
  geoGa4State.lastPayload = payload;
  geoGa4State.lastFetchedAt = Date.now();
  _geoGa4RenderDom(containerId, payload);
  if (typeof window !== 'undefined' && window.geoMapState && window.geoMapState.instance) {
    geoGa4RenderChoropleth(window.geoMapState.instance, window.geoMapState.featureIndex, payload);
  }
  _geoGa4ScheduleAutoRefresh(containerId, payload);
  return payload;
}

// ══════════════════════════════════════════════════════════════════
// Auto Refresh（60s 預設；near_limit→120s；limited→停止自動更新）
// ══════════════════════════════════════════════════════════════════

function geoGa4StopAutoRefresh() {
  if (geoGa4State.autoRefreshTimer) {
    clearTimeout(geoGa4State.autoRefreshTimer);
    geoGa4State.autoRefreshTimer = null;
  }
}

function _geoGa4ScheduleAutoRefresh(containerId, payload) {
  geoGa4StopAutoRefresh();
  if (!geoGa4State.active) return;
  // fix18-10-hotfix30-B5-R5.4-G1.5-B2：店家設定關閉 Auto Refresh 時，不管
  // quota 狀態如何都不排程（手動 Refresh 仍可用，見需求文件十二）。
  if (!geoGa4State.configAutoRefreshEnabled) return;
  if (payload && payload.quota_status === 'limited') return; // 只保留手動重新整理
  const seconds = (payload && payload.quota_status === 'near_limit') ? 120 : 60;
  geoGa4State.autoRefreshSeconds = seconds;
  geoGa4State.autoRefreshTimer = setTimeout(() => {
    if (!geoGa4State.active) return;
    _geoGa4RunFetch(containerId, { refresh: false });
  }, seconds * 1000);
}

// geoGa4NotifySettingsChanged(newAutoRefreshEnabled) — fix18-10-hotfix30-B5-
// R5.4-G1.5-B2：Settings UI 儲存成功後呼叫。清掉舊 Polygon／舊 Summary／
// 舊 cache 顯示（不得殘留舊 Property 的資料，見需求文件十二），並在目前
// 正在 GA4 Layer 時強制重新 fetch。
function geoGa4NotifySettingsChanged(newAutoRefreshEnabled) {
  if (typeof newAutoRefreshEnabled === 'boolean') geoGa4State.configAutoRefreshEnabled = newAutoRefreshEnabled;
  geoGa4State.lastPayload = null;
  geoGa4State.countyIndex = null;
  geoGa4ClearLayer();
  if (geoGa4State.active && geoGa4State.containerId) {
    return _geoGa4RunFetch(geoGa4State.containerId, { refresh: true });
  }
}

// ══════════════════════════════════════════════════════════════════
// Public entry points（geo-heatmap-ui.js 呼叫）
// ══════════════════════════════════════════════════════════════════

// geoGa4FetchAndRender(containerId) — 切到 GA4 Layer 時呼叫。
async function geoGa4FetchAndRender(containerId) {
  const reactivating = geoGa4State.active && geoGa4State.containerId === containerId;
  geoGa4State.active = true;
  geoGa4State.containerId = containerId;
  _geoGa4RenderDom(containerId, geoGa4State.lastPayload); // 先用（可能存在的）舊資料立即畫一次
  // fix18-10-hotfix30-B5-R5.4-G1.5-B2：每次 activate 讀一次店家的
  // auto_refresh_enabled 設定（不是每次 fetch 都讀，避免多打一次 API），
  // 見需求文件十二：不得只寫死 60 秒而忽略店家開關。讀取失敗時保守維持
  // 目前值，不假設為 true 或 false。
  if (!reactivating) {
    try {
      // fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：改用具名的 geoGa4FetchStatus()
      // （內部使用 apiFetch()，不再是無認證的裸 fetch()）。
      const statusData = await geoGa4FetchStatus();
      if (statusData && typeof statusData.auto_refresh_enabled === 'boolean') {
        geoGa4State.configAutoRefreshEnabled = statusData.auto_refresh_enabled;
      }
    } catch (e) { /* 讀取失敗不阻擋主要資料 fetch，維持目前值 */ }
  }
  // 若已有資料且還在合理新鮮度內，先顯示舊資料，實際是否重新 fetch 交給
  // 下面統一呼叫（後端自己的 cache TTL 會決定是否真的打 Google API）。
  if (!reactivating || !geoGa4State.lastPayload) {
    return _geoGa4RunFetch(containerId, { refresh: false });
  }
  return _geoGa4RunFetch(containerId, { refresh: false });
}

function geoGa4Refresh(containerId) {
  return _geoGa4RunFetch(containerId || geoGa4State.containerId, { refresh: true });
}

function geoGa4SetWindow(containerId, windowMinutes) {
  const w = Number(windowMinutes);
  if (!GEO_GA4_WINDOWS.includes(w)) return;
  geoGa4State.windowMinutes = w;
  return _geoGa4RunFetch(containerId || geoGa4State.containerId, { refresh: false });
}

function geoGa4SetMetric(containerId, metric) {
  if (!GEO_GA4_METRICS.includes(metric)) return;
  geoGa4State.metric = metric;
  return _geoGa4RunFetch(containerId || geoGa4State.containerId, { refresh: false });
}

// geoGa4Deactivate() — 離開 GA4 Layer 時呼叫（geo-heatmap-ui.js）。
function geoGa4Deactivate() {
  geoGa4State.active = false;
  geoGa4StopAutoRefresh();
  if (geoGa4State.abortController && typeof geoGa4State.abortController.abort === 'function') {
    try { geoGa4State.abortController.abort(); } catch (e) { /* ignore */ }
  }
  geoGa4State.abortController = null;
  geoGa4RestoreStyles();
}

// 地圖上的空狀態／未啟用/未設定文案——沿用既有 geo-heatmap-ui.js 覆蓋文字
// 機制（_geoHeatUiRenderGa4MapOverlay() 呼叫這個函式取得文案）。
function geoGa4MapOverlayMessage() {
  const p = geoGa4State.lastPayload;
  if (geoGa4State.loading && !p) return 'GA4 即時圖層載入中…';
  if (!p) return null;
  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.2：Authentication 失敗要顯示明確的
  // 重新登入提示，不得顯示模糊的「載入失敗」，也不得跟 GA4 Backend 錯誤
  // 共用文字（需求文件七、八）。
  if (p.status === 'auth_error') return GEO_GA4_AUTH_ERROR_MESSAGE;
  if (p.status === 'error') return GEO_GA4_ERROR_MESSAGES[p.error_code] || 'GA4 即時圖層載入失敗，請重試';
  if (!p.ok) return 'GA4 即時圖層載入失敗，請重試';
  if (p.status === 'disabled') return GEO_GA4_ERROR_MESSAGES.ga4_realtime_disabled;
  if (p.status === 'not_configured') return 'GA4 Realtime 尚未設定 Property／憑證';
  if (!p.counties || !p.counties.length) return '目前沒有可對應到縣市的 GA4 即時資料';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_GA4_WINDOWS, GEO_GA4_METRICS, GEO_GA4_METRIC_LABEL, GEO_GA4_POLYGON_STYLE, GEO_GA4_POLYGON_STYLE_NO_DATA,
    GA4_REALTIME_DISCLAIMER, GA4_REALTIME_PRIVACY_NOTICE,
    geoGa4State,
    geoGa4BuildRequestUrl, geoGa4NormalizeResponse, geoGa4FetchData, geoGa4FetchStatus, geoGa4AuthErrorPayload,
    GEO_GA4_ERROR_MESSAGES, GEO_GA4_AUTH_ERROR_MESSAGE,
    geoGa4FindLayersForCounty, geoGa4RenderChoropleth, geoGa4BuildTooltipContent,
    geoGa4ClearLayer, geoGa4RestoreStyles,
    geoGa4RenderToolbarHtml, geoGa4RenderSummaryHtml, geoGa4RenderStatusHtml, geoGa4RenderNoticesHtml,
    geoGa4StatusMessage, geoGa4QuotaWarning,
    geoGa4FetchAndRender, geoGa4Refresh, geoGa4SetWindow, geoGa4SetMetric, geoGa4Deactivate,
    geoGa4StopAutoRefresh, geoGa4MapOverlayMessage, geoGa4NotifySettingsChanged,
    _geoGa4BuildCountyIndex, _geoGa4RunFetch, _geoGa4RenderDom, _geoGa4ScheduleAutoRefresh,
    _geoGa4ResetStateForTest,
  };
}
