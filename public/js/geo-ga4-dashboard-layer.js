// public/js/geo-ga4-dashboard-layer.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE
// Dashboard GA4 Regional Overview — NEW VIEW CAPABILITY（需求文件二／十七）。
//
// 邊界（不得違反）：
//   - 只 GET 現有 /api/analytics/ga4-geo/history（透過既有 apiFetch，不
//     bare fetch），永遠不 POST sync、不打 Realtime endpoint、不直接呼叫
//     Google Client（見需求文件十二／十三）。
//   - 完全獨立於 geo-ga4-h1-panel.js：不共用 markerGroup／rangeState／
//     currentAbort，Dashboard 是自己的 owner（需求文件四、五）。
//   - 不建立第二張 L.map()：重用呼叫端傳入的既有 window.geoMapState.instance
//     （跟 geo-ga4-h1-panel.js／geo-ga4-realtime-layer.js 同一慣例）。
//   - 座標只用 API 已經算好回傳的 row.marker_point／marker_accuracy，不
//     重新 geocode、不查表、不建座標庫（需求文件十九）。
//   - 所有 Historical Range 一律透過 resolveGeoHistoricalRange()，不在這裡
//     另外算 90d/180d/this_year/last_year（需求文件十一、十四）。

'use strict';

var _geoDashboardResolveRangeFn = (typeof resolveGeoHistoricalRange === 'function') ? resolveGeoHistoricalRange : null;
if (!_geoDashboardResolveRangeFn && typeof require === 'function') {
  try { _geoDashboardResolveRangeFn = require('./geo-range-resolver.js').resolveGeoHistoricalRange; } catch (e) { /* 安靜失敗 */ }
}

const DASHBOARD_GA4_ERROR_MESSAGES = Object.freeze({
  invalid_mode: '請選擇查詢模式',
  timezone_helper_unavailable: '時區資料暫時無法使用',
  missing_single_date: '請選擇日期',
  missing_custom_range: '請選擇日期',
  invalid_date_format: '日期格式不正確',
  start_after_end: '開始日期不可晚於結束日期',
  range_too_large: '查詢期間最多 366 天',
  auth_required: '登入已失效，請重新登入。',
  feature_disabled: '此方案未開放報表分析功能。',
  network_error: 'GA4 區域資料暫時無法載入。',
});
function _geoDashboardGa4ErrorMessage(code) { return DASHBOARD_GA4_ERROR_MESSAGES[code] || 'GA4 區域資料暫時無法載入。'; }

// dashboardGa4State——Dashboard 專屬（需求文件五）。rangeState／layerGroup
// 都是這裡獨立建立的新物件，跟 geoGa4H1State 完全沒有共用參考。
const dashboardGa4State = {
  layerGroup: null,
  currentAbort: null,
  generation: 0,
  active: false,
  metric: 'active_users', // 本輪固定，不提供 selector（需求文件十）
  rangeState: { mode: '7d', singleDate: '', startDate: '', endDate: '' },
  rangeControlHandle: null,
  containerId: null,
  lastResolved: null,
};
if (typeof window !== 'undefined') window.dashboardGa4State = dashboardGa4State;

function _geoDashboardGa4ResetStateForTest() {
  dashboardGa4State.layerGroup = null;
  dashboardGa4State.currentAbort = null;
  dashboardGa4State.generation = 0;
  dashboardGa4State.active = false;
  dashboardGa4State.metric = 'active_users';
  dashboardGa4State.rangeState = { mode: '7d', singleDate: '', startDate: '', endDate: '' };
  dashboardGa4State.rangeControlHandle = null;
  dashboardGa4State.containerId = null;
  dashboardGa4State.lastResolved = null;
}

// geoDashboardGa4RangeLabel(resolved)——需求文件三：純 Presentation
// Helper，只處理 UI 顯示文字，不碰 resolveGeoHistoricalRange() 本身的
// Contract（Stage 3 已凍結：對所有 mode 一律回實際日期 displayLabel，這裡
// 不回頭改）。single／custom 沒有對應的「口語化」說法，直接用 resolved
// 已經算好的日期文字；其餘 preset 用固定中文對照表。
const DASHBOARD_GA4_FRIENDLY_LABELS = Object.freeze({
  today: '今天', yesterday: '昨日', '7d': '近 7 天', '30d': '近 30 天',
  '90d': '近 90 天', '180d': '近 180 天', this_year: '今年', last_year: '去年',
});
function geoDashboardGa4RangeLabel(resolved) {
  if (!resolved || !resolved.ok) return '';
  const friendly = DASHBOARD_GA4_FRIENDLY_LABELS[resolved.mode];
  return friendly || resolved.displayLabel; // single/custom 沒有口語化對照，直接用 resolved.displayLabel
}

function _geoDashboardGa4Esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// _geoDashboardGa4ResolveRange() — 需求文件十一：唯一 Range Truth，跟
// geo-ga4-h1-panel.js 的 _geoGa4H1ResolveRange() 是同一個底層純函式
// （resolveGeoHistoricalRange），但各自用自己的 rangeState，不是同一個呼叫。
function _geoDashboardGa4ResolveRange() {
  if (typeof _geoDashboardResolveRangeFn !== 'function') {
    return { ok: false, mode: dashboardGa4State.rangeState.mode, code: 'timezone_helper_unavailable' };
  }
  return _geoDashboardResolveRangeFn(dashboardGa4State.rangeState.mode, dashboardGa4State.rangeState);
}

function _geoDashboardGa4EnsureGroup(mapInstance) {
  if (!dashboardGa4State.layerGroup && typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    dashboardGa4State.layerGroup = L.layerGroup();
  }
  const group = dashboardGa4State.layerGroup;
  if (group && mapInstance && typeof mapInstance.hasLayer === 'function' && !mapInstance.hasLayer(group) && typeof group.addTo === 'function') {
    group.addTo(mapInstance);
  }
  return group;
}

function geoDashboardGa4ClearMarkers() {
  if (dashboardGa4State.layerGroup && typeof dashboardGa4State.layerGroup.clearLayers === 'function') {
    dashboardGa4State.layerGroup.clearLayers();
  }
}

// _geoDashboardGa4Icon/_geoDashboardGa4BuildTooltip——只用 API 已經算好的
// row.marker_point／marker_accuracy／district_name／county_name／
// active_users 等欄位畫圖，不重新查表、不重新 geocode（需求文件十九）。
// 跟 geo-ga4-h1-panel.js 的 _geoGa4H1Icon 視覺語意一致（GA4 紫色），但這是
// Dashboard 自己的獨立實作，不 import／不共用那個檔案的函式或狀態。
function _geoDashboardGa4Icon() {
  if (typeof L === 'undefined' || typeof L.divIcon !== 'function') return undefined;
  return L.divIcon({
    className: 'geo-dashboard-ga4-marker',
    html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:#a855f7;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15)"></span>',
    iconSize: [14, 14],
  });
}
function _geoDashboardGa4BuildTooltip(row, displayLabel) {
  const district = row.district_name || row.county_name || '未知行政區';
  const activeUsers = (typeof row.active_users === 'number') ? row.active_users : 0;
  return `<div class="geo-dashboard-ga4-tooltip">`
    + `<div>行政區：${_geoDashboardGa4Esc(district)}</div>`
    + `<div>活躍使用者：${_geoDashboardGa4Esc(String(activeUsers))}</div>`
    + `<div>資料期間：${_geoDashboardGa4Esc(displayLabel || '')}</div>`
    + `<div>資料來源：GA4 IP 城市級推估</div>`
    + `</div>`;
}

// geoDashboardGa4RenderMarkers()——需求文件二十九：不 sum district
// activeUsers；每一筆 row 各自畫一個 marker，不產生任何「總訪客」數字。
function geoDashboardGa4RenderMarkers(mapInstance, rows, displayLabel) {
  const group = _geoDashboardGa4EnsureGroup(mapInstance);
  if (!group) return 0;
  geoDashboardGa4ClearMarkers();
  let count = 0;
  (rows || []).forEach((row) => {
    if (row.normalization_status !== 'ok') return;
    const point = row.marker_point;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    if (typeof L === 'undefined' || typeof L.marker !== 'function') return;
    const marker = L.marker([point.lat, point.lng], { icon: _geoDashboardGa4Icon() });
    if (typeof marker.bindTooltip === 'function') marker.bindTooltip(_geoDashboardGa4BuildTooltip(row, displayLabel), { sticky: true });
    marker.addTo(group);
    count += 1;
  });
  return count;
}

// _geoDashboardGa4ApiRequest()——跟 geo-ga4-h1-panel.js 的
// geoGa4H1ApiRequest() 是同一個 apiFetch Auth Contract（401→auth_required／
// 403→feature_disabled／非 JSON→invalid_response），這裡獨立實作一份小
// helper，不 import 那個檔案（需求文件四：兩個模組各自獨立，不互相耦合）。
async function _geoDashboardGa4ApiRequest(url, options = {}, signal) {
  const winApiFetch = (typeof window !== 'undefined') ? window.apiFetch : undefined;
  const fetchFn = (typeof winApiFetch === 'function') ? winApiFetch : (typeof apiFetch === 'function' ? apiFetch : null);
  if (!fetchFn) return { success: false, code: 'invalid_response' };

  const res = await fetchFn(url, { ...options, signal });
  if (!res) return { success: false, code: 'invalid_response' };

  if (res.ok === false && (res.status === 401 || res.status === 403)) {
    return { success: false, code: res.status === 401 ? 'auth_required' : 'feature_disabled' };
  }
  if (typeof res.json !== 'function') return { success: false, code: 'invalid_response' };

  const json = await res.json(); // AbortError 在這裡拋出時交給呼叫端 catch
  if (json && typeof json === 'object') return json;
  return { success: false, code: 'invalid_response' };
}

function _geoDashboardGa4Fetch(resolved, signal) {
  const params = new URLSearchParams({ range: resolved.apiRange });
  if (resolved.apiRange === 'custom') {
    params.set('start_date', resolved.startDate);
    params.set('end_date', resolved.endDate);
  }
  const url = `/api/analytics/ga4-geo/history?${params.toString()}`;
  // 需求文件十二：一律用既有 authenticated apiFetch，不 bare fetch
  // （H1.1 曾經因為 bare fetch 造成 Production 401，不得重犯）。
  return _geoDashboardGa4ApiRequest(url, { method: 'GET' }, signal);
}

function _geoDashboardGa4RenderLabel(ids, resolved) {
  if (typeof document === 'undefined' || !ids || !ids.label) return;
  const labelEl = document.getElementById(ids.label);
  if (!labelEl) return;
  const friendlyLabel = (resolved && resolved.ok) ? geoDashboardGa4RangeLabel(resolved) : '';
  const actualRange = (resolved && resolved.ok) ? resolved.displayLabel : '';
  // 需求文件五：Friendly Label（主標題）與 Actual Calendar Range（副標下方
  // 小字）語意分開——single/custom 兩者剛好相同（friendly===actualRange
  // 這兩種 mode 沒有口語化說法），這裡仍然只顯示一次，不重複兩行相同文字。
  const showActualRangeSeparately = friendlyLabel !== actualRange;
  labelEl.innerHTML = `<div>GA4 區域概況｜${_geoDashboardGa4Esc(friendlyLabel)}</div>`
    + `<div style="font-size:.72rem;color:var(--text-secondary,#64748b)">IP 城市級推估・非個別訪客精確位置</div>`
    + (showActualRangeSeparately ? `<div style="font-size:.7rem;color:var(--text-secondary,#64748b)">${_geoDashboardGa4Esc(actualRange)}</div>` : '');
}
function _geoDashboardGa4RenderStatus(ids, text) {
  if (typeof document === 'undefined' || !ids || !ids.status) return;
  const statusEl = document.getElementById(ids.status);
  if (statusEl) statusEl.textContent = text || '';
}

// geoDashboardGa4Refresh()——Read-only（需求文件二十二～二十四）：
//   - resolved.ok===false → 不發 API，顯示驗證錯誤。
//   - 每次開始新 request 前先 clear 舊 marker（需求文件二十三：不得讓
//     「標題已經是 90 天」但 marker 還是 7 天的資料）。
//   - AbortController + generation 雙層防護（需求文件二十五）。
async function geoDashboardGa4Refresh(ids, mapInstance) {
  const myGeneration = ++dashboardGa4State.generation;
  const resolved = _geoDashboardGa4ResolveRange();
  dashboardGa4State.lastResolved = resolved;

  if (!resolved.ok) {
    if (myGeneration !== dashboardGa4State.generation) return;
    geoDashboardGa4ClearMarkers();
    _geoDashboardGa4RenderLabel(ids, null);
    _geoDashboardGa4RenderStatus(ids, _geoDashboardGa4ErrorMessage(resolved.code));
    return;
  }

  // 開始新 request 前先清掉舊 marker——不得讓畫面在「新標題」與「舊
  // marker」之間出現不一致（需求文件二十三）。
  geoDashboardGa4ClearMarkers();
  _geoDashboardGa4RenderLabel(ids, resolved);
  _geoDashboardGa4RenderStatus(ids, '載入中…');

  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (dashboardGa4State.currentAbort) {
    try { dashboardGa4State.currentAbort.abort(); } catch (e) { /* ignore */ }
  }
  dashboardGa4State.currentAbort = controller;

  let body;
  try {
    body = await _geoDashboardGa4Fetch(resolved, controller ? controller.signal : undefined);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 被下一次呼叫取代，安靜結束
    body = { success: false, code: 'network_error' };
  }
  if (myGeneration !== dashboardGa4State.generation) return; // stale response guard

  if (!body || body.success === false) {
    geoDashboardGa4ClearMarkers();
    _geoDashboardGa4RenderStatus(ids, _geoDashboardGa4ErrorMessage(body && body.code));
    return;
  }

  const rows = body.rows || body.cities || [];
  if (rows.length === 0) {
    geoDashboardGa4ClearMarkers();
    _geoDashboardGa4RenderStatus(ids, '目前尚無此期間已同步的 GA4 區域資料。請至 Heatmap → GA4 區域分析執行手動同步。');
    return;
  }

  const count = geoDashboardGa4RenderMarkers(mapInstance, rows, resolved.displayLabel);
  _geoDashboardGa4RenderStatus(ids, `共 ${count} 個行政區有資料。`);
}

// geoDashboardGa4Activate(ids, mapInstance)——需求文件十五、十六、四十：
//   - Idempotent：重複呼叫不會新增第二個 LayerGroup／第二套 handler。
//   - Range Control mount 用 dashboardGa4State.rangeState（物件參考，不是
//     DOM），DOM 被上層 innerHTML 重建也不會丟資料，只要 ids.rangeMount
//     這個容器 id 還在就能重新 mount。
function geoDashboardGa4Activate(ids, mapInstance) {
  dashboardGa4State.active = true;
  dashboardGa4State.containerId = ids && ids.containerId;
  _geoDashboardGa4EnsureGroup(mapInstance);

  if (typeof document !== 'undefined' && ids && ids.rangeMount && document.getElementById(ids.rangeMount)) {
    if (dashboardGa4State.rangeControlHandle && typeof dashboardGa4State.rangeControlHandle.destroy === 'function') {
      dashboardGa4State.rangeControlHandle.destroy();
    }
    if (typeof window !== 'undefined' && window.GeoRangeControl && typeof window.GeoRangeControl.mount === 'function') {
      dashboardGa4State.rangeControlHandle = window.GeoRangeControl.mount(ids.rangeMount, {
        state: dashboardGa4State.rangeState,
        onChange: () => { geoDashboardGa4Refresh(ids, mapInstance).catch((e) => { if (!e || e.name !== 'AbortError') console.error('[Dashboard-GA4]', e); }); }, // eslint-disable-line no-console
      });
    }
  }

  geoDashboardGa4Refresh(ids, mapInstance).catch((e) => {
    if (e && e.name === 'AbortError') return;
    console.error('[Dashboard-GA4] activate refresh failed', e); // eslint-disable-line no-console
  });
}

// geoDashboardGa4Deactivate(mapInstance)——需求文件十六：不清 rangeState，
// 只清 active layer／pending request／generation（讓晚到的 response 被
// stale guard 擋掉）。
function geoDashboardGa4Deactivate(mapInstance) {
  dashboardGa4State.active = false;
  dashboardGa4State.generation += 1;
  if (dashboardGa4State.currentAbort) {
    try { dashboardGa4State.currentAbort.abort(); } catch (e) { /* ignore */ }
  }
  dashboardGa4State.currentAbort = null;
  if (mapInstance && dashboardGa4State.layerGroup && typeof mapInstance.hasLayer === 'function' && mapInstance.hasLayer(dashboardGa4State.layerGroup) && typeof mapInstance.removeLayer === 'function') {
    mapInstance.removeLayer(dashboardGa4State.layerGroup);
  }
}

if (typeof window !== 'undefined') {
  window.geoDashboardGa4Activate = geoDashboardGa4Activate;
  window.geoDashboardGa4Deactivate = geoDashboardGa4Deactivate;
  window.geoDashboardGa4Refresh = geoDashboardGa4Refresh;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dashboardGa4State, DASHBOARD_GA4_ERROR_MESSAGES, _geoDashboardGa4ErrorMessage,
    DASHBOARD_GA4_FRIENDLY_LABELS, geoDashboardGa4RangeLabel,
    _geoDashboardGa4ResolveRange, _geoDashboardGa4EnsureGroup, geoDashboardGa4ClearMarkers,
    _geoDashboardGa4Icon, _geoDashboardGa4BuildTooltip, geoDashboardGa4RenderMarkers,
    _geoDashboardGa4Fetch, _geoDashboardGa4RenderLabel, _geoDashboardGa4RenderStatus,
    geoDashboardGa4Refresh, geoDashboardGa4Activate, geoDashboardGa4Deactivate,
    _geoDashboardGa4ResetStateForTest,
  };
}
