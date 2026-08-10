// public/js/geo-ga4-h1-panel.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// GA4 城市歷史統計、即時快照與行政區轉換地圖 — 前端面板
//
// 邊界（不得違反，見需求文件二／三）：
//   - 不建立第二張 L.map()／第二個 Tile Layer。一律重用呼叫端傳入的既有
//     window.geoMapState.instance（沿用 geo-live-layer.js／geo-ga4-realtime-
//     layer.js 同一慣例）。
//   - GA4 Aggregate Marker 用獨立的 L.layerGroup 管理，只清除自己這組，
//     絕不觸碰 POS Exact／Estimate／Order 既有的 Marker Group。
//   - 座標只使用後端回傳的行政區代表點；本檔案完全不查表、不算座標。
//   - 所有動態字串一律經過 _geoGa4H1Esc()，不得把使用者/API 文字未經
//     escape 直接塞進 innerHTML（需求文件二之 8）。
//   - Mode／Metric／日期切換一律套用 request generation guard，慢請求
//     不得覆蓋新狀態畫面（需求文件三之 5～7）。

'use strict';

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：Historical Range
// 的唯一真相來源是 resolveGeoHistoricalRange()（本輪 Stage 3 既有純函式），
// 不在這裡另外算 90d/180d/this_year/last_year（見需求文件六）。瀏覽器
// 正常執行路徑會直接吃到全域 window.resolveGeoHistoricalRange（跟
// geo-range-resolver.js 同一份 <script> 載入順序即可）；Node 測試環境
// （多數既有 H1 測試都是直接 require() 這個檔案，不是 eval 字串）在這裡
// 用 require 撈同一份正式檔案，不是複製演算法。
var _geoGa4H1ResolveRangeFn = (typeof resolveGeoHistoricalRange === 'function') ? resolveGeoHistoricalRange : null;
if (!_geoGa4H1ResolveRangeFn && typeof require === 'function') {
  try { _geoGa4H1ResolveRangeFn = require('./geo-range-resolver.js').resolveGeoHistoricalRange; } catch (e) { /* 安靜失敗，_geoGa4H1ResolveRange() 會回 range_resolver_unavailable */ }
}

const GEO_GA4_H1_MODES = [
  // 'realtime'／'historical' 是新架構下的兩個 sentinel（toolbar 唯二可選
  // 的頂層模式）。today/yesterday/7d/30d/custom 是舊版直接寫在
  // geoGa4H1State.mode 上的歷史 range 值（仍支援，供既有呼叫端／測試
  // 直接設定 state 時使用，見 _geoGa4H1SyncLegacyModeIntoRangeState()）。
  // single/90d/180d/this_year/last_year 是本輪新增的 Range Contract。
  'realtime', 'historical',
  'today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom',
];
const GEO_GA4_H1_METRICS = ['active_users', 'view_item_count', 'add_to_cart_count', 'begin_checkout_count', 'purchase_count'];

// resolveGeoHistoricalRange() 失敗 code → 中文提示（跟 geo-range-control.js
// 的 GEO_RANGE_CONTROL_ERROR_MESSAGES 是同一份 Contract 的獨立對照表，
// 這裡不 require 那個檔案——避免 Range Control 反過來被迫變成 Panel 的
// 依賴，兩者仍是各自獨立、互不強制耦合的模組）。
const GEO_GA4_H1_RANGE_ERROR_MESSAGES = {
  invalid_mode: '請選擇查詢模式',
  timezone_helper_unavailable: '時區資料暫時無法使用',
  missing_single_date: '請選擇日期',
  missing_custom_range: '請選擇日期',
  invalid_date_format: '日期格式不正確',
  start_after_end: '開始日期不可晚於結束日期',
  range_too_large: '查詢期間最多 366 天',
  range_resolver_unavailable: '查詢範圍功能暫時無法使用',
};
function _geoGa4H1RangeErrorMessage(code) { return GEO_GA4_H1_RANGE_ERROR_MESSAGES[code] || '查詢範圍設定有誤'; }

const geoGa4H1State = {
  mode: 'realtime',
  metric: 'active_users',
  customStart: null,
  customEnd: null,
  // Stage 4.1：Heatmap Historical 專屬 Range State（需求文件三）。不得與
  // 未來 dashboardGa4State.rangeState 共用同一個物件參考——這個檔案完全
  // 不知道 Dashboard 的存在，天生就不會發生共用。
  rangeState: { mode: '7d', singleDate: '', startDate: '', endDate: '' },
  generation: 0,
  markerGroup: null,
  pollTimer: null,
  currentAbort: null,
  lastGoodPayload: null,
  lastGoodRangeKey: null, // H1.4.3：lastGoodPayload 是「哪一個 range identity」的資料，見 _geoGa4H1RangeKey()／geoGa4H1Refresh() 的 stale fallback 判斷。
  destroyed: false, // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE Stage 6：見 geoGa4H1Destroy()／syncHandler 註解——Manual Sync 的 POST 沒有掛 AbortController，destroy() 無法取消它，只能靠這個旗標擋掉「late sync 完成後又 resurrect markerGroup」。
  // Stage 6.1：單靠 destroyed 布林值會有 ABA 風險——destroy() 之後如果
  // 很快又 init() 回來（同一個 panel 重新 activate），destroyed 會被
  // 重設回 false，讓「更早那一輪」尚未完成的 Manual Sync 誤以為自己還
  // 屬於現在這個 active session。lifecycleGeneration 是單調遞增的
  // session 版本號：每次 init()／destroy() 都 +1，Manual Sync 開始時
  // capture 當下版本號，完成時兩個條件都要成立才處理結果——
  // (a) destroyed===false　(b) capturedGeneration===目前版本號。
  lifecycleGeneration: 0,
  searchTerm: '',      // 需求文件二之 A：只影響 Table Rows，不影響 API/Marker 資料
  sortColumn: null,     // 目前排序欄位 key（null=維持資料原始順序）
  sortDirection: 'desc', // 'desc' | 'asc'——第一次點擊 desc，第二次 asc
  lastRenderedRows: [],  // 記住「目前這次 Refresh 拿到的原始 rows」，供 Search/Sort 重新渲染用，不得回頭改動這份陣列本身
  showZeroRows: false,
};

function _geoGa4H1Esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// _geoGa4H1PerUser(numerator, denominator) — fix18-10-hotfix30-B5-R5.4-
// G1.6-GA4-H1.3-EVENT-COMPAT（需求文件七～十）：「平均事件／人」
// = event_count / active_users，語意是「平均每個使用者觸發幾次這個事件」
// ，不是 conversion rate（conversion rate 需要「觸發過這個事件的 Unique
// Users」當分母，本輪沒有這個 Query，見需求文件二十三）。因此本函式
// 刻意不乘以 100、不回傳百分比。denominator<=0 回傳 null（畫面顯示
// '—'，不得是 Infinity／NaN／0%）。
function _geoGa4H1PerUser(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (!d) return null;
  return Math.round((n / d) * 10) / 10;
}

// _geoGa4H1Rate — 舊名稱別名。fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-
// EVENT-COMPAT 之前這裡回傳的是「×100 的百分比」（「加購率」／「購買率」，
// 已證實是誤把 event/user 平均值當成 conversion rate 顯示成 500%／400%，
// 見 R5.4-G1.6-GA4-H1.3-EVENT-COMPAT_REALITY_AUDIT.md）。本輪語意修正為
// per-user 平均值，不再乘 100；只保留這個舊名稱當 alias，避免破壞既有
// Contract Test（見 scripts/run-g1-6-ga4-h1-frontend-runtime.js #39：
// `panel._geoGa4H1Rate(5, 0) === null`），本檔案內部一律改呼叫
// _geoGa4H1PerUser()，不再有新程式碼呼叫這個舊名稱。
function _geoGa4H1Rate(numerator, denominator) {
  return _geoGa4H1PerUser(numerator, denominator);
}

// _geoGa4H1FormatPerUser(value) — 顯示格式化，固定一位小數（'5.0'／'4.0'，
// 不是裸數字 '5'／'4'，也不是 null/undefined 直接顯示），null → '—'。
// 只用在畫面顯示（Table／Tooltip），Sort 仍用 _geoGa4H1PerUser() 的原始
// 數值比較，不受這裡的字串格式影響。
function _geoGa4H1FormatPerUser(value) {
  return (value === null || value === undefined) ? '—' : Number(value).toFixed(1);
}

function _geoGa4H1ValidMode(m) { return GEO_GA4_H1_MODES.includes(m); }
function _geoGa4H1ValidMetric(m) { return GEO_GA4_H1_METRICS.includes(m); }

// _geoGa4H1SyncLegacyModeIntoRangeState()——需求文件六：唯一 Range Truth。
//
// 新架構下，toolbar 上的 #ga4h1-mode 只剩兩個 sentinel 值：'realtime' 與
// 'historical'；真正的歷史查詢 preset 一律活在 geoGa4H1State.rangeState
// 裡（由 GeoRangeControl 直接就地修改）。
//
// 但既有測試／既有呼叫端有大量地方是直接
// `geoGa4H1State.mode = 'today'`／'7d'／'custom' + customStart/customEnd
// 這樣設定（繞過 UI，直接操作 state），這是本輪 Stage 1～3 都刻意保留、
// 不動的既有 Contract。這裡把這種「舊式直接寫在 .mode 上的歷史 range
// 值」透明同步進 rangeState，讓 Refresh／Sync 兩邊都只認 rangeState 這一份
// 真相，不需要修改任何既有呼叫端或測試。
function _geoGa4H1SyncLegacyModeIntoRangeState() {
  const m = geoGa4H1State.mode;
  if (m === 'realtime' || m === 'historical') return; // 新架構 sentinel，不是歷史 range 值，不覆蓋 rangeState
  geoGa4H1State.rangeState.mode = m;
  // 只有舊呼叫端／舊測試真的透過 customStart/customEnd 設定時才覆蓋
  // rangeState 的 startDate/endDate；如果呼叫端已經改用新架構直接寫
  // rangeState.startDate/endDate（GeoRangeControl 的正常用法），這裡不得
  // 拿兩個都還是 null 的舊欄位把它蓋回去。
  if (m === 'custom' && (geoGa4H1State.customStart !== null || geoGa4H1State.customEnd !== null)) {
    geoGa4H1State.rangeState.startDate = geoGa4H1State.customStart;
    geoGa4H1State.rangeState.endDate = geoGa4H1State.customEnd;
  }
}

// _geoGa4H1ResolveRange() → resolveGeoHistoricalRange() 的結果，是
// Historical Read 與 Manual Sync 唯二共同的真相來源（需求文件八）。
function _geoGa4H1ResolveRange() {
  _geoGa4H1SyncLegacyModeIntoRangeState();
  if (typeof _geoGa4H1ResolveRangeFn !== 'function') {
    return { ok: false, mode: geoGa4H1State.rangeState.mode, code: 'range_resolver_unavailable' };
  }
  return _geoGa4H1ResolveRangeFn(geoGa4H1State.rangeState.mode, geoGa4H1State.rangeState);
}

// ══════════════════════════════════════════════════════════════════
// R5.4-G1.6-GA4-H1.1-AUTH — Auth Contract + AbortError Safety
//
// 邊界（見需求文件二～四、八）：
//   - 一律透過 window.apiFetch／apiFetch()（沿用 public/js/app.js 既有
//     Contract），不得再直接裸 fetch('/api/analytics/ga4-geo/...')。
//   - 不自行重新讀取／解析 JWT，不建立第二套 Token Reader／Auth Wrapper。
//   - apiFetch 對 401／403 回傳的是 { ok:false, status, body }（不是原生
//     Response，沒有 .json()）；成功或其他狀態則可能回原生 Response。
//     geoGa4H1ApiRequest 同時支援兩種形狀，不假設 res.json 一定存在。
// ══════════════════════════════════════════════════════════════════

function _geoGa4H1IsAbortError(e) {
  return !!(e && e.name === 'AbortError');
}

// geoGa4H1SafeRunFetch(fn) — 集中的 AbortError Safety Wrapper（需求文件
// 八）。只安靜吞掉 error.name==='AbortError'；其他錯誤原樣往上拋，交給
// 呼叫端進入安全 UI Error 狀態，不得被本函式意外吃掉。回傳 undefined
// 代表這次呼叫被 abort，呼叫端必須把 undefined 視為「安靜結束」，不得
// 誤當成一個合法的空結果去渲染。
async function geoGa4H1SafeRunFetch(fn) {
  try {
    return await fn();
  } catch (e) {
    if (_geoGa4H1IsAbortError(e)) return undefined;
    throw e;
  }
}

// geoGa4H1ApiRequest(url, options) — 集中 Auth Helper。優先使用
// window.apiFetch，其次是全域 apiFetch（沿用 geo-ga4-realtime-layer.js／
// geo-ga4-settings.js 同一個判斷慣例，見需求文件三）。回傳統一過的
// Contract 物件：
//   成功／後端業務錯誤：後端原始 JSON 展開＋http_status
//   401：{ success:false, code:'auth_required',    http_status:401 }
//   403：{ success:false, code:'feature_disabled',  http_status:403 }
//   格式異常／apiFetch 不存在：{ success:false, code:'invalid_response' }
// AbortError 不在這裡吞掉——原樣往外拋，交給呼叫端的
// geoGa4H1SafeRunFetch() 統一處理（需求文件八：安靜結束，不得輸出
// Uncaught (in promise)）。
async function geoGa4H1ApiRequest(url, options = {}) {
  const winApiFetch = (typeof window !== 'undefined') ? window.apiFetch : undefined;
  const fetchFn = (typeof winApiFetch === 'function')
    ? winApiFetch
    : (typeof apiFetch === 'function' ? apiFetch : null);
  if (!fetchFn) return { success: false, code: 'invalid_response', http_status: null };

  const res = await fetchFn(url, options);
  if (!res) return { success: false, code: 'invalid_response', http_status: null };

  // apiFetch 對 401／403 回傳的不是原生 Response（沒有 .json()），必須先
  // 判斷 ok===false && status 再決定要不要呼叫 .json()（需求文件四）。
  if (res.ok === false && (res.status === 401 || res.status === 403)) {
    return {
      success: false,
      code: res.status === 401 ? 'auth_required' : 'feature_disabled',
      http_status: res.status,
      body: res.body || {},
    };
  }

  if (typeof res.json !== 'function') {
    return { success: false, code: 'invalid_response', http_status: (typeof res.status === 'number' ? res.status : null) };
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    if (_geoGa4H1IsAbortError(e)) throw e; // 交給上層 SafeRunFetch 統一吞掉
    return { success: false, code: 'invalid_response', http_status: (typeof res.status === 'number' ? res.status : null) };
  }

  const httpStatus = (typeof res.status === 'number') ? res.status : 200;
  if (json && typeof json === 'object') return { ...json, http_status: httpStatus };
  return { success: false, code: 'invalid_response', http_status: httpStatus };
}

async function geoGa4H1Fetch(mode, opts = {}) {
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (geoGa4H1State.currentAbort) {
    try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ }
  }
  geoGa4H1State.currentAbort = controller;

  const fetchOpts = {};
  if (controller) fetchOpts.signal = controller.signal;

  if (mode === 'realtime') {
    return geoGa4H1ApiRequest('/api/analytics/ga4-geo/realtime', { method: 'GET', ...fetchOpts });
  }
  const params = new URLSearchParams({ range: mode });
  if (mode === 'custom') {
    params.set('start_date', opts.startDate || '');
    params.set('end_date', opts.endDate || '');
  }
  return geoGa4H1ApiRequest(`/api/analytics/ga4-geo/history?${params.toString()}`, { method: 'GET', ...fetchOpts });
}

function _geoGa4H1EnsureGroup(mapInstance) {
  if (!geoGa4H1State.markerGroup && typeof L !== 'undefined') {
    geoGa4H1State.markerGroup = L.layerGroup();
  }
  if (geoGa4H1State.markerGroup && mapInstance && !mapInstance.hasLayer(geoGa4H1State.markerGroup)) {
    geoGa4H1State.markerGroup.addTo(mapInstance);
  }
  return geoGa4H1State.markerGroup;
}

function geoGa4H1ClearMarkers() {
  if (geoGa4H1State.markerGroup) geoGa4H1State.markerGroup.clearLayers();
}

function _geoGa4H1MetricValue(row, metric) {
  if (metric === 'active_users') return row.active_users ?? row.current_active_users ?? 0;
  return row[metric] ?? 0;
}

function _geoGa4H1Icon(radius) {
  if (typeof L === 'undefined') return null;
  const size = Math.max(14, Math.min(48, radius * 2));
  return L.divIcon({
    className: 'ga4-h1-aggregate-marker-icon',
    html: `<div class="ga4-h1-diamond" style="width:${size}px;height:${size}px;"></div>`,
    iconSize: [size, size],
  });
}

function geoGa4H1BuildTooltip(row) {
  const activeUsers = row.active_users ?? row.current_active_users ?? 0;
  const addToCartPerUser = _geoGa4H1PerUser(row.add_to_cart_count, activeUsers);
  const purchasePerUser = _geoGa4H1PerUser(row.purchase_count, activeUsers);
  const label = _geoGa4H1Esc(row.district_name || row.county_name || '未知區域');
  const lines = [
    `<b>${label}</b>`,
    'GA4 城市彙總推估 — 非單一訪客實際位置',
    `活躍使用者：${_geoGa4H1Esc(activeUsers)}`,
  ];
  if (row.new_users !== undefined) lines.push(`新使用者：${_geoGa4H1Esc(row.new_users)}`);
  if (row.sessions !== undefined) lines.push(`工作階段：${_geoGa4H1Esc(row.sessions)}`);
  if (row.view_item_count !== undefined) lines.push(`商品瀏覽：${_geoGa4H1Esc(row.view_item_count)}`);
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件十一）：
  // 加購事件／人、購買事件／人各自獨立一行，不再用「（加購率 500%）」這種
  // 括號附註格式，也不得出現 % 符號。
  if (row.add_to_cart_count !== undefined) {
    lines.push(`加入購物車：${_geoGa4H1Esc(row.add_to_cart_count)}`);
    lines.push(`加購事件／人：${_geoGa4H1Esc(_geoGa4H1FormatPerUser(addToCartPerUser))}`);
  }
  if (row.begin_checkout_count !== undefined) lines.push(`開始結帳：${_geoGa4H1Esc(row.begin_checkout_count)}`);
  if (row.purchase_count !== undefined) {
    lines.push(`完成購買：${_geoGa4H1Esc(row.purchase_count)}`);
    lines.push(`購買事件／人：${_geoGa4H1Esc(_geoGa4H1FormatPerUser(purchasePerUser))}`);
  }
  if (row.transaction_count !== undefined) lines.push(`交易數：${_geoGa4H1Esc(row.transaction_count)}`);
  if (row.purchase_revenue !== undefined) lines.push(`營收：${_geoGa4H1Esc(row.purchase_revenue)}`);
  lines.push(`最近同步：${_geoGa4H1Esc(row.last_seen_at_utc || row.synced_at_utc || '—')}`);
  return lines.join('<br/>');
}

function geoGa4H1RenderMarkers(mapInstance, rows, metric) {
  if (!mapInstance || typeof L === 'undefined') return;
  const group = _geoGa4H1EnsureGroup(mapInstance);
  if (!group) return;
  geoGa4H1ClearMarkers();

  const values = rows.map((r) => _geoGa4H1MetricValue(r, metric)).filter((v) => Number.isFinite(v) && v > 0);
  const maxV = Math.max(1, ...values);

  rows.forEach((row) => {
    if (row.normalization_status !== 'ok') return;
    const point = row.marker_point;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    const value = _geoGa4H1MetricValue(row, metric);
    const radius = 8 + Math.round((Math.sqrt(Math.max(0, value)) / Math.sqrt(maxV)) * 14);
    const marker = L.marker([point.lat, point.lng], { icon: _geoGa4H1Icon(radius) });
    marker.bindTooltip(geoGa4H1BuildTooltip(row), { sticky: true });
    marker.addTo(group);
  });
}

// ── Search / Sort（需求文件二 A／B）── 純函式，不碰 DOM/Fetch/Marker。
const GA4_H1_SORT_COLUMNS = Object.freeze([
  { key: 'district', label: '行政區', type: 'text' },
  { key: 'active_users', label: '活躍使用者', type: 'number' },
  { key: 'new_users', label: '新使用者', type: 'number' },
  { key: 'sessions', label: '工作階段', type: 'number' },
  { key: 'view_item_count', label: '商品瀏覽', type: 'number' },
  { key: 'add_to_cart_count', label: '加入購物車', type: 'number' },
  { key: 'begin_checkout_count', label: '開始結帳', type: 'number' },
  { key: 'purchase_count', label: '完成購買', type: 'number' },
  { key: 'transaction_count', label: '交易數', type: 'number' },
  { key: 'purchase_revenue', label: '營收', type: 'number' },
  { key: 'add_to_cart_per_user', label: '加購事件／人', type: 'number' },
  { key: 'purchase_per_user', label: '購買事件／人', type: 'number' },
  { key: 'last_synced', label: '最近同步', type: 'text' },
]);

// H1.4.3（需求文件二十七～三十）：normalize.js 的 raw_location_key 是
// country+region+city 組合，「不同 raw identity 都被 normalize 成同一個
// display bucket（Unknown／Overseas／Other）」時，每個 raw identity 仍各自
// 是一筆獨立 persisted row（沒有被 sync 階段合併，因為它們的 raw_location_key
// 本來就不同——見 services/ga4GeoSyncService.js 的 merged Map）。過去這裡
// 全部顯示成同一句「Overseas／Other」，畫面上看起來像是「兩筆完全相同的
// 重複資料」，但底層其實是兩個不同國家/地區/城市的 raw row（真正的 GA4
// Dimension 身分不同，不是 duplicate、也不能盲目 sum activeUsers 合併成一筆
// ——需求文件二十九）。因此這裡改成附加原始 country/region/city context，
// 讓使用者看得出「這是兩筆不同來源、只是都無法解析成台灣行政區」，而不是
// 誤以為系統壞掉重複寫入。沒有任何 raw context 可用時（極舊資料／欄位
// 缺失）才維持原始純文字，不強行加上空括號。
function _geoGa4H1RawContextSuffix(r) {
  const parts = [r.country_raw, r.region_raw, r.city_raw]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  return parts.length ? ('（' + parts.join(' / ') + '）') : '';
}
function _geoGa4H1RowLabel(r) {
  if (r.normalization_status === 'unknown') return 'Unknown' + _geoGa4H1RawContextSuffix(r);
  if (r.normalization_status === 'overseas_or_other') return 'Overseas／Other' + _geoGa4H1RawContextSuffix(r);
  if (r.normalization_status === 'ambiguous') return 'Ambiguous' + _geoGa4H1RawContextSuffix(r);
  return r.district_name || r.county_name || 'Unknown';
}

// _geoGa4H1FilterRows(rows, term) — 需求文件二 A：trim／case-insensitive／
// 支援中英文；比對 county_name／district_name／顯示名稱／Raw City。空字串
// 一律回全部資料（==「恢復全部資料」）。純函式，不修改傳入的 rows 陣列
// 本身或其中任何 row 物件（回傳全新陣列）。
function _geoGa4H1FilterRows(rows, term) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  if (!t) return (rows || []).slice();
  return (rows || []).filter((r) => {
    const candidates = [r.county_name, r.district_name, r.city_raw, r.region_raw, r.country_raw, _geoGa4H1RowLabel(r)];
    return candidates.some((c) => c !== null && c !== undefined && String(c).toLowerCase().includes(t));
  });
}

function _geoGa4H1SortValue(row, key) {
  const activeUsers = row.active_users ?? row.current_active_users ?? 0;
  switch (key) {
    case 'district': return _geoGa4H1RowLabel(row);
    case 'active_users': return activeUsers;
    case 'new_users': return row.new_users;
    case 'sessions': return row.sessions;
    case 'view_item_count': return row.view_item_count;
    case 'add_to_cart_count': return row.add_to_cart_count;
    case 'begin_checkout_count': return row.begin_checkout_count;
    case 'purchase_count': return row.purchase_count;
    case 'transaction_count': return row.transaction_count;
    case 'purchase_revenue': return row.purchase_revenue;
    case 'add_to_cart_per_user': return _geoGa4H1PerUser(row.add_to_cart_count, activeUsers);
    case 'purchase_per_user': return _geoGa4H1PerUser(row.purchase_count, activeUsers);
    case 'last_synced': return row.last_seen_at_utc || row.synced_at_utc || null;
    default: return null;
  }
}

// _geoGa4H1IsMissingSortValue — null／undefined／'—'／NaN 一律視為缺值，
// 排序時穩定放在最後（不論目前是 desc 或 asc，見需求文件二 B 之 4）。
function _geoGa4H1IsMissingSortValue(v) {
  if (v === null || v === undefined || v === '—' || v === '') return true;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  return false;
}

// _geoGa4H1SortRows(rows, column, direction) — 純函式，不修改傳入陣列或其中
// 任何 row 物件（回傳全新陣列；原始 cached rows 不受影響，見需求文件二 B
// 之 5）。column 為 null 時維持原始（已篩選過的）順序。
function _geoGa4H1SortRows(rows, column, direction) {
  const list = (rows || []).slice();
  if (!column) return list;
  const colDef = GA4_H1_SORT_COLUMNS.find((c) => c.key === column);
  const isText = !colDef || colDef.type === 'text';
  const dirMul = direction === 'asc' ? 1 : -1;
  const withIndex = list.map((r, i) => ({ r, i, v: _geoGa4H1SortValue(r, column) }));
  withIndex.sort((a, b) => {
    const aMissing = _geoGa4H1IsMissingSortValue(a.v);
    const bMissing = _geoGa4H1IsMissingSortValue(b.v);
    if (aMissing && bMissing) return a.i - b.i;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (isText) {
      const cmp = String(a.v).localeCompare(String(b.v), 'zh-Hant');
      return cmp !== 0 ? cmp * dirMul : a.i - b.i;
    }
    const cmp = Number(a.v) - Number(b.v);
    return cmp !== 0 ? cmp * dirMul : a.i - b.i;
  });
  return withIndex.map((x) => x.r);
}

function _geoGa4H1BuildRowHtml(r) {
  const activeUsers = r.active_users ?? r.current_active_users ?? 0;
  const addToCartPerUser = _geoGa4H1PerUser(r.add_to_cart_count, activeUsers);
  const purchasePerUser = _geoGa4H1PerUser(r.purchase_count, activeUsers);
  const label = _geoGa4H1RowLabel(r);
  return `<tr>
      <td>${_geoGa4H1Esc(label)}</td>
      <td>${_geoGa4H1Esc(activeUsers)}</td>
      <td>${_geoGa4H1Esc(r.new_users ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.sessions ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.view_item_count ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.add_to_cart_count ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.begin_checkout_count ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.purchase_count ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.transaction_count ?? '—')}</td>
      <td>${_geoGa4H1Esc(r.purchase_revenue ?? '—')}</td>
      <td>${_geoGa4H1Esc(_geoGa4H1FormatPerUser(addToCartPerUser))}</td>
      <td>${_geoGa4H1Esc(_geoGa4H1FormatPerUser(purchasePerUser))}</td>
      <td>${_geoGa4H1Esc(r.last_seen_at_utc || r.synced_at_utc || '—')}</td>
    </tr>`;
}

function geoGa4H1RenderTable(containerId, rows, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const showZero = !!opts.showZeroRows;
  const filtered = (rows || []).filter((r) => showZero
    || (r.active_users || r.current_active_users || 0) > 0
    || r.normalization_status !== 'ok');

  const rowsHtml = filtered.map((r) => _geoGa4H1BuildRowHtml(r)).join('');

  el.innerHTML = `
    <table class="ga4-h1-table">
      <thead><tr>
        <th>行政區</th><th>活躍使用者</th><th>新使用者</th><th>工作階段</th>
        <th>商品瀏覽</th><th>加入購物車</th><th>開始結帳</th><th>完成購買</th>
        <th>交易數</th><th>營收</th><th>加購事件／人</th><th>購買事件／人</th><th>最近同步</th>
      </tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="13">目前沒有資料</td></tr>'}</tbody>
    </table>
    <p class="ga4-h1-disclaimer">此資料為 GA4 城市彙總，並非個別訪客實際位置。城市活躍使用者加總可能與全站總數不同（隱私門檻／使用者跨城市／Not Set／GA4 彙總語意），不代表系統錯誤。</p>
  `;
}

// ── Interactive table：加上搜尋欄位與可點擊排序表頭（需求文件二 A／B）。
// 搜尋／排序一律只作用於「這次 Refresh 已經拿到的 rows」（純前端記憶體
// 操作），絕不重打 GA4 API、絕不寫 DB、絕不動 Marker（Marker 已經在
// geoGa4H1Refresh() 內單獨用未篩選的 rows 畫過一次，搜尋/排序完全不重畫
// Marker，見需求文件二 A 之 3）。
function _geoGa4H1RerenderTbody(containerId) {
  const tbody = document.getElementById(`${containerId}-tbody`);
  if (!tbody) return;
  const zeroFiltered = geoGa4H1State.lastRenderedRows.filter((r) => geoGa4H1State.showZeroRows
    || (r.active_users || r.current_active_users || 0) > 0
    || r.normalization_status !== 'ok');
  const searched = _geoGa4H1FilterRows(zeroFiltered, geoGa4H1State.searchTerm);
  const sorted = _geoGa4H1SortRows(searched, geoGa4H1State.sortColumn, geoGa4H1State.sortDirection);
  if (!sorted.length) {
    // 需求文件二 A 之 4：搜尋無結果要顯示專屬文案，不得跟一般 API Empty
    // Error 共用同一句「目前沒有資料」。
    const msg = String(geoGa4H1State.searchTerm || '').trim() ? '沒有符合的行政區資料' : '目前沒有資料';
    tbody.innerHTML = `<tr><td colspan="13">${_geoGa4H1Esc(msg)}</td></tr>`;
    return;
  }
  tbody.innerHTML = sorted.map((r) => _geoGa4H1BuildRowHtml(r)).join('');
}

function _geoGa4H1UpdateSortIndicators(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.querySelectorAll('th[data-sort-key]').forEach((th) => {
    const key = th.getAttribute('data-sort-key');
    const colDef = GA4_H1_SORT_COLUMNS.find((c) => c.key === key);
    const marker = geoGa4H1State.sortColumn === key ? (geoGa4H1State.sortDirection === 'desc' ? ' ▼' : ' ▲') : '';
    th.textContent = (colDef ? colDef.label : '') + marker; // textContent，不用 innerHTML（需求文件二 A 之 5／B）
  });
}

// geoGa4H1RenderInteractiveTable(containerId, rows) — 對外主要進入點
// （geoGa4H1Refresh() 呼叫這個，不是舊的 geoGa4H1RenderTable()）。第一次
// 呼叫建立完整骨架＋掛 listener；之後只重繪 <tbody>，讓搜尋輸入框本身
// （含使用者游標/焦點）不被整段 innerHTML 重建打斷。
function geoGa4H1RenderInteractiveTable(containerId, rows) {
  const el = document.getElementById(containerId);
  if (!el) return;
  geoGa4H1State.lastRenderedRows = rows || [];

  const searchInputId = `${containerId}-search-input`;
  let searchInput = document.getElementById(searchInputId);

  if (!searchInput) {
    el.innerHTML = `
      <div class="ga4-h1-table-toolbar">
        <input type="text" id="${searchInputId}" class="ga4-h1-search-input" placeholder="搜尋行政區…" />
      </div>
      <table class="ga4-h1-table">
        <thead><tr>${GA4_H1_SORT_COLUMNS.map((c) => `<th data-sort-key="${c.key}">${_geoGa4H1Esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody id="${containerId}-tbody"></tbody>
      </table>
      <p class="ga4-h1-disclaimer">此資料為 GA4 城市彙總，並非個別訪客實際位置。城市活躍使用者加總可能與全站總數不同（隱私門檻／使用者跨城市／Not Set／GA4 彙總語意），不代表系統錯誤。</p>
    `;
    searchInput = document.getElementById(searchInputId);

    // 需求文件二 A 之 5：搜尋輸入一律用安全 DOM API（.value 讀取），不把使用者
    // 輸入字串直接塞進 innerHTML。
    const searchHandler = () => {
      geoGa4H1State.searchTerm = searchInput.value;
      _geoGa4H1RerenderTbody(containerId); // 只重繪 tbody，不呼叫 fetch，不動 Marker
    };
    searchInput.addEventListener('input', searchHandler);
    el._ga4h1SearchCleanup = () => searchInput.removeEventListener('input', searchHandler);

    const theadRow = el.querySelector('thead tr');
    const headerHandler = (e) => {
      const th = e.target.closest && e.target.closest('th[data-sort-key]');
      if (!th) return;
      const key = th.getAttribute('data-sort-key');
      if (geoGa4H1State.sortColumn === key) {
        geoGa4H1State.sortDirection = geoGa4H1State.sortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        geoGa4H1State.sortColumn = key;
        geoGa4H1State.sortDirection = 'desc'; // 需求文件二 B 之 1：第一次點擊 descending
      }
      _geoGa4H1RerenderTbody(containerId);
      _geoGa4H1UpdateSortIndicators(containerId);
    };
    theadRow.addEventListener('click', headerHandler);
    el._ga4h1HeaderCleanup = () => theadRow.removeEventListener('click', headerHandler);
  } else {
    searchInput.value = geoGa4H1State.searchTerm;
  }

  _geoGa4H1RerenderTbody(containerId);
  _geoGa4H1UpdateSortIndicators(containerId);
}

// GA4_H1_STATUS_CODE_MAP — 需求文件七：H1 UI 錯誤分類，一律依 code 顯示
// 對應人話訊息，不得把所有狀況統一顯示成「GA4 資料暫時無法取得」。
const GA4_H1_STATUS_CODE_MAP = Object.freeze({
  // Auth（geoGa4H1ApiRequest 統一轉換出的 code，見需求文件四）
  auth_required: '登入已失效，請重新登入。',
  feature_disabled: '此方案未開放報表分析功能。',
  // GA4 Backend／Property／Credential
  property_not_bound: '此店尚未綁定 GA4 Property。',
  credential_unavailable: 'Server 尚未設定 GA4 憑證。',
  SDK_UNAVAILABLE: 'Server 尚未設定 GA4 憑證。',
  sdk_unavailable: 'Server 尚未設定 GA4 憑證。',
  permission_denied: 'GA4 Service Account 沒有此 Property 的讀取權限。',
  invalid_argument: 'GA4 查詢格式或 Property 設定不相容。',
  rate_limited: '操作過於頻繁，請稍候再試。',
  network_error: '網路連線失敗。',
  ga4_backend_error: 'GA4 連線發生錯誤，請稍後再試。',
  ga4_request_failed: 'GA4 連線發生錯誤，請稍後再試。',
  ga4_realtime_disabled: 'GA4 城市地圖尚未啟用。',
  ga4_disabled: 'GA4 城市地圖尚未啟用。',
  sync_in_progress: '同步進行中，請稍候再試。',
  invalid_response: 'GA4 資料回應格式異常，請稍後再試。',
  unexpected_error: 'GA4 資料暫時無法取得，請稍後再試。',
});

// H1.4.3（需求文件六十三／Manual QA 問題 1）：Dashboard 的
// _geoDashboardGa4RenderLabel() 一直都有把 resolved.displayLabel（實際
// 日期區間，例如「2026/08/04 ～ 2026/08/10」）顯示在畫面上；Heatmap H1
// 這邊過去完全沒有對應的顯示位置——使用者在 Heatmap 點了「近7天」之後，
// 畫面上找不到任何地方寫著「現在看到的是哪一段實際日期」，只能靠猜。這正是
// Manual QA 誤把 8/3～8/9 的 Heatmap 資料拿去跟 8/4～8/10 的 Dashboard 資料
// 互相比較、誤判成「資料不一致」的根源之一（見
// H1.4.3_GA4_HEATMAP_RANGE_DATA_CONSISTENCY_REALITY_AUDIT.md 章節五）。這裡
// 補上同樣語意的 rangeLabel（第三個參數，可選——既有呼叫端／既有測試不傳
// 這個參數時行為完全不變，不破壞既有 Contract）。
function geoGa4H1RenderStatus(containerId, payload, rangeLabel) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let text = '';
  if (!payload) { text = '載入中…'; }
  else if (payload.success === false) {
    text = GA4_H1_STATUS_CODE_MAP[payload.code] || 'GA4 資料暫時無法取得，已顯示最後一次成功的快取。';
  } else if (payload.stale) {
    text = `資料可能過期（最後成功同步：${payload.last_sync_at_utc || '—'}）`;
  } else if (Array.isArray(payload.rows) && payload.rows.length === 0 && !Array.isArray(payload.cities)) {
    text = '目前沒有資料。';
  } else if (Array.isArray(payload.cities) && payload.cities.length === 0) {
    text = '目前沒有資料。';
  } else {
    text = `最後成功同步：${payload.last_sync_at_utc || '—'}`;
  }
  if (rangeLabel) text = `查詢期間：${rangeLabel}｜${text}`;
  el.textContent = text;
}

// GA4_H1_SYNC_ERROR_MESSAGES — 需求文件五：手動同步失敗分類文案。
const GA4_H1_SYNC_ERROR_MESSAGES = Object.freeze({
  invalid_range: '同步時間範圍不正確，請重新選擇。',
  invalid_sync_type: '同步類型不正確。',
  invalid_date_format: '日期格式不正確，請重新選擇日期。',
  auth_required: '登入已失效，請重新登入。',
  feature_disabled: '此方案未開放報表分析功能。',
  rate_limited: '操作過於頻繁，請稍候再試。',
  ga4_backend_error: 'GA4 連線發生錯誤，請稍後再試。',
  ga4_request_failed: 'GA4 連線發生錯誤，請稍後再試。',
  unexpected_error: '同步發生未預期錯誤，請稍後再試。',
  invalid_response: '同步回應格式異常，請稍後再試。',
});

// _geoGa4H1HandleSyncResult(result, onChange) — 需求文件五：手動同步必須
// 解析 Sync Response，不能再 fire-and-forget。
//   成功：顯示同步成功／rows_saved，再 Refresh Read API（onChange）。
//   失敗：顯示安全錯誤碼對應文案，不清空舊 Cache，不把按鈕誤顯示成
//         成功，也不立刻無條件再打一次讀取造成錯誤連鎖（不呼叫
//         onChange()）。
async function _geoGa4H1HandleSyncResult(result, onChange) {
  if (result && result.success === true) {
    const rowsSaved = (typeof result.rows_saved === 'number') ? result.rows_saved : null;
    if (typeof showToast === 'function') {
      // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件五、
      // 六）：rows_saved===0 是合法的空結果（例如 Today 剛開始，GA4
      // 標準報表資料尚未產生／隱私門檻省略低量資料），不是錯誤，不得顯示
      // 紅色 Error，也不得用含糊的「已更新 0 筆資料」措辭讓人誤以為同步
      // 本身失敗。rows_saved>0 維持既有措辭；success 但沒有 rows_saved
      // 欄位（例如 realtime 同步）維持既有的「同步成功」。
      if (rowsSaved === 0) {
        showToast('同步成功，目前 GA4 報表尚無可用的區域資料。即時資料與標準報表的處理時間不同，稍後再同步即可。', 'success');
      } else if (rowsSaved !== null) {
        showToast(`同步成功，已更新 ${rowsSaved} 筆資料`, 'success');
      } else {
        showToast('同步成功', 'success');
      }
    }
    if (typeof onChange === 'function') {
      // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE Stage 6：見
      // geoGa4H1Destroy() 註解——Manual Sync 沒有 AbortController 可以
      // 取消，若使用者在 Sync 進行中切走（geoGa4H1Destroy() 已執行），
      // 這裡不得再呼叫 onChange()（那會重新建立 markerGroup 並
      // addLayer 回共用地圖，即使目前畫面已經不在 Heatmap 分頁）。
      if (geoGa4H1State.destroyed) return;
      await geoGa4H1SafeRunFetch(() => onChange());
    }
    return;
  }
  const code = (result && result.code) || 'unexpected_error';
  const msg = GA4_H1_SYNC_ERROR_MESSAGES[code] || '同步失敗，請稍後再試。';
  if (typeof showToast === 'function') showToast(msg, 'error');
}

function geoGa4H1RenderToolbar(containerId, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const rangeMountId = `${containerId}-h1-range-mount`;
  el.innerHTML = `
    <select id="ga4h1-mode">
      <option value="realtime">即時 30 分鐘</option>
      <option value="historical">歷史查詢</option>
    </select>
    <div id="${rangeMountId}" class="ga4-h1-range-mount"></div>
    <select id="ga4h1-metric">
      <option value="active_users">活躍使用者</option>
      <option value="view_item_count">商品瀏覽</option>
      <option value="add_to_cart_count">加入購物車</option>
      <option value="begin_checkout_count">開始結帳</option>
      <option value="purchase_count">完成購買</option>
    </select>
    <button id="ga4h1-sync" type="button">手動同步</button>
    <span class="ga4-h1-fixed-disclaimer">此資料為 GA4 城市彙總，並非個別訪客實際位置。</span>
  `;
  const modeEl = el.querySelector('#ga4h1-mode');
  const metricEl = el.querySelector('#ga4h1-metric');
  const syncBtn = el.querySelector('#ga4h1-sync');

  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：#ga4h1-mode 現在只
  // 是「即時／歷史」兩個 sentinel（需求文件四：Realtime Window 跟
  // Historical Calendar Range 不再混成同一套 control）。歷史查詢的 10 個
  // preset（today/yesterday/single/7d/30d/90d/180d/this_year/last_year/
  // custom）全部交給 GeoRangeControl，mount 在 rangeMountId 這個獨立容器
  // 裡，綁定 geoGa4H1State.rangeState（Heatmap Historical 專屬 state，
  // 需求文件三）。若使用者直接（或既有測試）把 geoGa4H1State.mode 設成
  // 一個歷史 range 字面值而不是 'historical'，仍視為「已經在歷史查詢」
  // ——見 _geoGa4H1IsHistoricalDisplayMode()，這裡只影響「要不要顯示
  // range mount」這個 UI 判斷，不影響 Refresh/Sync 的真相來源。
  function _geoGa4H1IsHistoricalDisplayMode() {
    return geoGa4H1State.mode !== 'realtime';
  }

  let _geoGa4H1RangeControlHandle = null;
  function _geoGa4H1RenderRangeMount() {
    if (typeof document === 'undefined') return;
    const mountEl = document.getElementById(rangeMountId);
    if (!mountEl) return;
    if (!_geoGa4H1IsHistoricalDisplayMode()) {
      mountEl.innerHTML = '';
      mountEl.hidden = true;
      if (_geoGa4H1RangeControlHandle && typeof _geoGa4H1RangeControlHandle.destroy === 'function') _geoGa4H1RangeControlHandle.destroy();
      _geoGa4H1RangeControlHandle = null;
      return;
    }
    mountEl.hidden = false;
    _geoGa4H1SyncLegacyModeIntoRangeState();
    if (typeof GeoRangeControl !== 'undefined' && GeoRangeControl && typeof GeoRangeControl.mount === 'function') {
      _geoGa4H1RangeControlHandle = GeoRangeControl.mount(rangeMountId, {
        state: geoGa4H1State.rangeState,
        onChange: () => { Promise.resolve(onChange()).catch(_geoGa4H1SwallowAbort); },
      });
    }
  }

  // _geoGa4H1SwallowAbort — 需求文件八之 3／4：Timer／事件監聽器呼叫出去
  // 的 Promise 必須有安全 catch，不得讓 AbortError（或任何其他錯誤）變成
  // 瀏覽器 Console 的 Uncaught (in promise)。這裡 addEventListener 的
  // callback 拿到的是 geoGa4H1Refresh() 回傳的 Promise——雖然
  // geoGa4H1Refresh() 內部已經會吞掉 AbortError，這裡仍加一層防禦，避免
  // 未來任何修改不小心讓錯誤外漏。
  function _geoGa4H1SwallowAbort(e) {
    if (_geoGa4H1IsAbortError(e)) return; // 安靜結束，被下一次呼叫取代
    console.error('[GA4-H1]', e); // eslint-disable-line no-console
  }

  const modeHandler = (e) => {
    const v = e.target.value;
    geoGa4H1State.mode = (v === 'realtime' || v === 'historical') ? v : 'realtime';
    // 需求文件二 B 之 7：Mode 切換後排序/搜尋狀態固定行為——重設回預設
    // （不同日期區間/模式的資料集不同，延續舊搜尋字串容易誤導使用者以為
    // 資料仍是同一批）。Metric 切換不會走到這個 handler，因此搜尋/排序在
    // Metric 切換時會維持不變（見下方 metricHandler，故意不重設）。
    geoGa4H1State.searchTerm = '';
    geoGa4H1State.sortColumn = null;
    geoGa4H1State.sortDirection = 'desc';
    _geoGa4H1RenderRangeMount();
    Promise.resolve(onChange()).catch(_geoGa4H1SwallowAbort);
  };
  const metricHandler = (e) => {
    geoGa4H1State.metric = _geoGa4H1ValidMetric(e.target.value) ? e.target.value : 'active_users';
    Promise.resolve(onChange()).catch(_geoGa4H1SwallowAbort);
  };
  const syncHandler = async () => {
    // 需求文件十二：現有 disabled/loading 就是既有 single-flight 防護，
    // 沿用，不新增 scheduler。
    if (syncBtn.disabled) return;
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中…';
    // Stage 6.1 ABA Guard：capture 這次 Sync 開始當下的 session 版本號。
    // Manual Sync 的 POST 沒有 AbortController，destroy() 取消不了它——
    // 如果期間發生過 destroy()（甚至又 init() 開了新 session），
    // lifecycleGeneration 一定已經前進，藉此判斷「這個結果還屬不屬於
    // 現在這個 active session」，不能只看 destroyed 這個布林值（會有
    // destroy→init 的 ABA：舊 sync 完成時看到 destroyed 又變回 false，
    // 誤以為自己還算數）。
    const capturedGeneration = geoGa4H1State.lifecycleGeneration;
    const isStaleLifecycle = () => geoGa4H1State.destroyed || geoGa4H1State.lifecycleGeneration !== capturedGeneration;
    try {
      let body;
      if (geoGa4H1State.mode === 'realtime') {
        body = { sync_type: 'realtime' };
      } else {
        // 需求文件八／十一：Manual Sync 跟 Historical Read 用完全同一個
        // resolved range；resolved.ok===false 時（validation 失敗）不得
        // 發任何 API，只顯示錯誤文字。
        const resolved = _geoGa4H1ResolveRange();
        if (!resolved.ok) {
          if (typeof showToast === 'function') showToast(_geoGa4H1RangeErrorMessage(resolved.code), 'error');
          syncBtn.disabled = false;
          syncBtn.textContent = '手動同步';
          return;
        }
        body = { sync_type: 'range', range: resolved.apiRange, start_date: resolved.startDate, end_date: resolved.endDate };
      }
      const result = await geoGa4H1SafeRunFetch(() => geoGa4H1ApiRequest('/api/analytics/ga4-geo/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      // Stage 6.1：Server 端已經正常完成同步、DB 也正常更新——這裡不否定
      // Server-side 的結果，只是這個「已經是舊 session」的瀏覽器端不再把
      // 它套進任何 UI（不 render、不改 status、不觸發 refresh），因為現在
      // 畫面已經是另一個 session 了。
      if (isStaleLifecycle()) return;
      if (result !== undefined) await _geoGa4H1HandleSyncResult(result, onChange);
    } catch (e) {
      if (isStaleLifecycle()) return;
      _geoGa4H1SwallowAbort(e);
      if (!_geoGa4H1IsAbortError(e) && typeof showToast === 'function') showToast('同步發生未預期錯誤，請稍後再試', 'error');
    } finally {
      if (!isStaleLifecycle()) {
        syncBtn.disabled = false;
        syncBtn.textContent = '手動同步';
      }
    }
  };

  modeEl.addEventListener('change', modeHandler);
  metricEl.addEventListener('change', metricHandler);
  syncBtn.addEventListener('click', syncHandler);
  _geoGa4H1RenderRangeMount(); // 需求文件十三：reactivate 時，若 mode 已經是歷史查詢，立刻恢復 rangeState 對應的 UI（不重設回 realtime）。

  el._ga4h1Cleanup = () => {
    modeEl.removeEventListener('change', modeHandler);
    metricEl.removeEventListener('change', metricHandler);
    syncBtn.removeEventListener('click', syncHandler);
    if (_geoGa4H1RangeControlHandle && typeof _geoGa4H1RangeControlHandle.destroy === 'function') _geoGa4H1RangeControlHandle.destroy();
  };
}

// _geoGa4H1FetchRangeKey(mode, opts) — H1.4.3（需求文件三十六、三十七、
// 五十七）：Historical Empty/Failed Range 的 stale fallback 只能拿「同一個
// range identity 上一次成功的資料」重播一次（例如同一個 90d 正在自動
// 輪詢，這次剛好網路抖動），絕不能把「使用者已經切到 90d，但上一次成功的
// 其實是 7d 的資料」誤當成 90d 的合法快取繼續顯示——那正是 Manual QA
// 回報的「Table 看起來還是舊資料，沒有跟著 Range 切換」的其中一種真實
// 觸發路徑（見 H1.4.3_GA4_HEATMAP_RANGE_DATA_CONSISTENCY_REALITY_AUDIT.md
// 章節五 之 D）。fetchMode==='realtime' 時 opts 為空物件，key 只用 mode
// 本身即可（Realtime 沒有 startDate/endDate 概念）。
function _geoGa4H1FetchRangeKey(mode, opts) {
  if (mode === 'realtime') return 'realtime';
  return `${mode}|${(opts && opts.startDate) || ''}|${(opts && opts.endDate) || ''}`;
}

async function geoGa4H1Refresh(ids, mapInstance) {
  const myGeneration = ++geoGa4H1State.generation;
  geoGa4H1RenderStatus(ids.status, null);

  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：realtime 完全不變
  // （需求文件四）；非 realtime 一律先過 _geoGa4H1ResolveRange()（跟
  // Manual Sync 同一個函式），resolved.ok===false 時不得發 API（需求文件
  // 十一），直接顯示錯誤訊息並結束，不留舊 payload/舊 marker 在畫面上
  // 誤導使用者。
  let fetchMode = 'realtime';
  let fetchOpts = {};
  let resolvedRangeLabel = null; // H1.4.3：只有 Historical 才有實際日期區間可顯示，Realtime 維持 null（不顯示查詢期間字樣）。
  if (geoGa4H1State.mode !== 'realtime') {
    const resolved = _geoGa4H1ResolveRange();
    if (!resolved.ok) {
      if (myGeneration !== geoGa4H1State.generation) return;
      geoGa4H1RenderStatus(ids.status, { success: false, code: resolved.code, message: _geoGa4H1RangeErrorMessage(resolved.code) });
      if (ids.table) geoGa4H1RenderTable(ids.table, []);
      return;
    }
    fetchMode = resolved.apiRange;
    fetchOpts = { startDate: resolved.startDate, endDate: resolved.endDate };
    resolvedRangeLabel = resolved.displayLabel;
  }

  let payload;
  try {
    payload = await geoGa4H1SafeRunFetch(() => geoGa4H1Fetch(fetchMode, fetchOpts));
  } catch (e) {
    payload = { success: false, code: 'network_error' };
  }
  // undefined === 被 AbortError 安靜結束（被下一次呼叫取代），不得覆蓋新狀態。
  if (payload === undefined) return;

  if (myGeneration !== geoGa4H1State.generation) return;

  const currentRangeKey = _geoGa4H1FetchRangeKey(fetchMode, fetchOpts);
  if (payload && payload.success) {
    geoGa4H1State.lastGoodPayload = payload;
    geoGa4H1State.lastGoodRangeKey = currentRangeKey;
  } else if (geoGa4H1State.lastGoodPayload && geoGa4H1State.lastGoodRangeKey === currentRangeKey) {
    // 只有「上一次成功的資料剛好也是現在這個 range identity」才能當 stale
    // fallback 重播；否則就是別的 range 的資料，繼續往下走空/錯誤狀態
    // （不得把它偽裝成這個 range 的合法快取——需求文件三十七、五十七）。
    payload = { ...geoGa4H1State.lastGoodPayload, success: true, stale: true };
  } else if (payload && payload.success === false) {
    // 需求文件三十七：現在這個 range 沒有可用的「同 identity」快取可以
    // fallback，一律顯示空 Table／錯誤狀態，不得殘留任何其他 range 的
    // 舊資料在畫面上誤導使用者。
    payload = { success: false, code: (payload && payload.code) || 'unexpected_error' };
  }

  geoGa4H1RenderStatus(ids.status, payload, resolvedRangeLabel);
  if (!payload || payload.success === false) {
    if (ids.table) geoGa4H1RenderTable(ids.table, []);
    return;
  }

  const rows = payload.cities || payload.rows || [];
  if (ids.table) geoGa4H1RenderInteractiveTable(ids.table, rows);
  if (mapInstance) geoGa4H1RenderMarkers(mapInstance, rows, geoGa4H1State.metric);
}

function geoGa4H1Init(ids, mapInstance) {
  geoGa4H1State.destroyed = false; // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE Stage 6：重新 activate 時解除上次 destroy() 設下的旗標
  geoGa4H1State.lifecycleGeneration += 1; // Stage 6.1：開啟新的 active session 版本號
  geoGa4H1RenderToolbar(ids.toolbar, () => geoGa4H1Refresh(ids, mapInstance));
  // 需求文件八：這裡是 fire-and-forget（呼叫端不 await），Promise 必須有
  // 安全 catch，不得讓 AbortError 或其他錯誤變成 Uncaught (in promise)。
  geoGa4H1Refresh(ids, mapInstance).catch((e) => {
    if (_geoGa4H1IsAbortError(e)) return;
    console.error('[GA4-H1] init refresh failed', e); // eslint-disable-line no-console
  });
}

function geoGa4H1Destroy(ids) {
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE Stage 6：Manual Sync
  // 的 POST /sync 沒有掛 AbortController（跟 Historical Read 用的
  // currentAbort 是不同的請求，abort currentAbort 完全取消不了它——見
  // _geoGa4H1HandleSyncResult()／syncHandler()），所以切走時若剛好有一次
  // Sync 還在飛，它會在背景繼續跑完，完成後呼叫 onChange() 觸發
  // geoGa4H1Refresh()，_geoGa4H1EnsureGroup() 看到 markerGroup 已經是
  // null 就會建一個新的並 addLayer 回共用地圖——不管目前畫面在哪個分頁。
  // 這面旗標就是擋這個：destroy() 之後任何 late 完成的 sync 一律不觸發
  // onChange()（見 syncHandler 內的檢查），reactivate（geoGa4H1Init）時
  // 才重新打開。
  geoGa4H1State.destroyed = true;
  geoGa4H1State.lifecycleGeneration += 1; // Stage 6.1：讓這個 session 之前 capture 的任何 generation 立刻作廢
  if (geoGa4H1State.pollTimer) { clearInterval(geoGa4H1State.pollTimer); geoGa4H1State.pollTimer = null; }
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：abort 之後也要把
  // 參考歸零（跟 geo-ga4-realtime-layer.js 的 geoGa4Deactivate() 對
  // abortController 的既有慣例一致），否則 destroy() 後 currentAbort
  // 仍指向一個已經 abort 過的舊 controller，下次讀到會誤以為還有進行中
  // 的 request。
  if (geoGa4H1State.currentAbort) { try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ } }
  geoGa4H1State.currentAbort = null;
  geoGa4H1ClearMarkers();
  if (geoGa4H1State.markerGroup) {
    try { geoGa4H1State.markerGroup.remove(); } catch (e) { /* ignore */ }
    geoGa4H1State.markerGroup = null;
  }
  const toolbarEl = ids && ids.toolbar ? document.getElementById(ids.toolbar) : null;
  if (toolbarEl && typeof toolbarEl._ga4h1Cleanup === 'function') toolbarEl._ga4h1Cleanup();
  // 需求文件三之 18／19：destroy 後搜尋／排序表頭的 listener 一併移除。
  const tableEl = ids && ids.table ? document.getElementById(ids.table) : null;
  if (tableEl) {
    if (typeof tableEl._ga4h1SearchCleanup === 'function') { tableEl._ga4h1SearchCleanup(); tableEl._ga4h1SearchCleanup = null; }
    if (typeof tableEl._ga4h1HeaderCleanup === 'function') { tableEl._ga4h1HeaderCleanup(); tableEl._ga4h1HeaderCleanup = null; }
  }
}

if (typeof window !== 'undefined') {
  window.GeoGa4H1Panel = {
    init: geoGa4H1Init, destroy: geoGa4H1Destroy, refresh: geoGa4H1Refresh,
    state: geoGa4H1State,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    geoGa4H1BuildTooltip, geoGa4H1RenderTable, geoGa4H1RenderStatus, geoGa4H1RenderToolbar,
    geoGa4H1RenderMarkers, geoGa4H1Fetch,
    geoGa4H1RenderInteractiveTable, _geoGa4H1FilterRows, _geoGa4H1SortRows, _geoGa4H1RowLabel, _geoGa4H1RawContextSuffix, _geoGa4H1FetchRangeKey,
    _geoGa4H1Rate, _geoGa4H1PerUser, _geoGa4H1FormatPerUser, _geoGa4H1MetricValue, _geoGa4H1Esc, _geoGa4H1ValidMode, _geoGa4H1ValidMetric,
    geoGa4H1Init, geoGa4H1Destroy, geoGa4H1Refresh, geoGa4H1ClearMarkers,
    geoGa4H1State,
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE（Stage 4.1：H1
    // Historical Range Integration，唯一 Range Truth）
    GEO_GA4_H1_RANGE_ERROR_MESSAGES, _geoGa4H1RangeErrorMessage,
    _geoGa4H1SyncLegacyModeIntoRangeState, _geoGa4H1ResolveRange,
    // R5.4-G1.6-GA4-H1.1-AUTH：Auth Contract + AbortError Safety（供
    // scripts/run-g1-6-ga4-h1-1-browser-auth-runtime.js／static audit 使用）。
    geoGa4H1ApiRequest, geoGa4H1SafeRunFetch, _geoGa4H1IsAbortError,
    _geoGa4H1HandleSyncResult, GA4_H1_STATUS_CODE_MAP, GA4_H1_SYNC_ERROR_MESSAGES,
  };
}
