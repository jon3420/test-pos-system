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

const GEO_GA4_H1_MODES = ['realtime', 'today', 'yesterday', '7d', '30d', 'custom'];
const GEO_GA4_H1_METRICS = ['active_users', 'view_item_count', 'add_to_cart_count', 'begin_checkout_count', 'purchase_count'];

const geoGa4H1State = {
  mode: 'realtime',
  metric: 'active_users',
  customStart: null,
  customEnd: null,
  generation: 0,
  markerGroup: null,
  pollTimer: null,
  currentAbort: null,
  lastGoodPayload: null,
  searchTerm: '',      // 需求文件二之 A：只影響 Table Rows，不影響 API/Marker 資料
  sortColumn: null,     // 目前排序欄位 key（null=維持資料原始順序）
  sortDirection: 'desc', // 'desc' | 'asc'——第一次點擊 desc，第二次 asc
  lastRenderedRows: [],  // 記住「目前這次 Refresh 拿到的原始 rows」，供 Search/Sort 重新渲染用，不得回頭改動這份陣列本身
  showZeroRows: false,
};

function _geoGa4H1Esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _geoGa4H1Rate(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10;
}

function _geoGa4H1ValidMode(m) { return GEO_GA4_H1_MODES.includes(m); }
function _geoGa4H1ValidMetric(m) { return GEO_GA4_H1_METRICS.includes(m); }

async function geoGa4H1Fetch(mode, opts = {}) {
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (geoGa4H1State.currentAbort) {
    try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ }
  }
  geoGa4H1State.currentAbort = controller;

  const fetchOpts = { credentials: 'include' };
  if (controller) fetchOpts.signal = controller.signal;

  if (mode === 'realtime') {
    const res = await fetch('/api/analytics/ga4-geo/realtime', fetchOpts);
    return res.json();
  }
  const params = new URLSearchParams({ range: mode });
  if (mode === 'custom') {
    params.set('start_date', opts.startDate || '');
    params.set('end_date', opts.endDate || '');
  }
  const res = await fetch(`/api/analytics/ga4-geo/history?${params.toString()}`, fetchOpts);
  return res.json();
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
  const addToCartRate = _geoGa4H1Rate(row.add_to_cart_count, activeUsers);
  const purchaseRate = _geoGa4H1Rate(row.purchase_count, activeUsers);
  const label = _geoGa4H1Esc(row.district_name || row.county_name || '未知區域');
  const lines = [
    `<b>${label}</b>`,
    'GA4 城市彙總推估 — 非單一訪客實際位置',
    `活躍使用者：${_geoGa4H1Esc(activeUsers)}`,
  ];
  if (row.new_users !== undefined) lines.push(`新使用者：${_geoGa4H1Esc(row.new_users)}`);
  if (row.sessions !== undefined) lines.push(`工作階段：${_geoGa4H1Esc(row.sessions)}`);
  if (row.view_item_count !== undefined) lines.push(`商品瀏覽：${_geoGa4H1Esc(row.view_item_count)}`);
  if (row.add_to_cart_count !== undefined) lines.push(`加入購物車：${_geoGa4H1Esc(row.add_to_cart_count)}（加購率 ${addToCartRate === null ? '—' : addToCartRate + '%'}）`);
  if (row.begin_checkout_count !== undefined) lines.push(`開始結帳：${_geoGa4H1Esc(row.begin_checkout_count)}`);
  if (row.purchase_count !== undefined) lines.push(`完成購買：${_geoGa4H1Esc(row.purchase_count)}（購買率 ${purchaseRate === null ? '—' : purchaseRate + '%'}）`);
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
  { key: 'add_to_cart_rate', label: '加購率', type: 'number' },
  { key: 'purchase_rate', label: '購買率', type: 'number' },
  { key: 'last_synced', label: '最近同步', type: 'text' },
]);

function _geoGa4H1RowLabel(r) {
  return r.normalization_status === 'unknown' ? 'Unknown'
    : r.normalization_status === 'overseas_or_other' ? 'Overseas／Other'
    : r.normalization_status === 'ambiguous' ? 'Ambiguous'
    : (r.district_name || r.county_name || 'Unknown');
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
    case 'add_to_cart_rate': return _geoGa4H1Rate(row.add_to_cart_count, activeUsers);
    case 'purchase_rate': return _geoGa4H1Rate(row.purchase_count, activeUsers);
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
  const addToCartRate = _geoGa4H1Rate(r.add_to_cart_count, activeUsers);
  const purchaseRate = _geoGa4H1Rate(r.purchase_count, activeUsers);
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
      <td>${addToCartRate === null ? '—' : _geoGa4H1Esc(addToCartRate) + '%'}</td>
      <td>${purchaseRate === null ? '—' : _geoGa4H1Esc(purchaseRate) + '%'}</td>
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
        <th>交易數</th><th>營收</th><th>加購率</th><th>購買率</th><th>最近同步</th>
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

function geoGa4H1RenderStatus(containerId, payload) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let text = '';
  if (!payload) { text = '載入中…'; }
  else if (payload.success === false) {
    const codeMap = {
      property_not_bound: '此店尚未綁定 GA4 Property，無法顯示 GA4 城市資料。',
      ga4_disabled: 'GA4 城市地圖尚未啟用。',
      sync_in_progress: '同步進行中，請稍候再試。',
    };
    text = codeMap[payload.code] || 'GA4 資料暫時無法取得，已顯示最後一次成功的快取。';
  } else if (payload.stale) {
    text = `資料可能過期（最後成功同步：${payload.last_sync_at_utc || '—'}）`;
  } else if (Array.isArray(payload.rows) && payload.rows.length === 0 && !Array.isArray(payload.cities)) {
    text = '目前沒有資料。';
  } else if (Array.isArray(payload.cities) && payload.cities.length === 0) {
    text = '目前沒有資料。';
  } else {
    text = `最後成功同步：${payload.last_sync_at_utc || '—'}`;
  }
  el.textContent = text;
}

function geoGa4H1RenderToolbar(containerId, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <select id="ga4h1-mode">
      <option value="realtime">即時 30 分鐘</option>
      <option value="today">今天</option>
      <option value="yesterday">昨天</option>
      <option value="7d">近 7 天</option>
      <option value="30d">近 30 天</option>
      <option value="custom">自訂日期</option>
    </select>
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

  const modeHandler = (e) => {
    geoGa4H1State.mode = _geoGa4H1ValidMode(e.target.value) ? e.target.value : 'realtime';
    // 需求文件二 B 之 7：Mode 切換後排序/搜尋狀態固定行為——重設回預設
    // （不同日期區間/模式的資料集不同，延續舊搜尋字串容易誤導使用者以為
    // 資料仍是同一批）。Metric 切換不會走到這個 handler，因此搜尋/排序在
    // Metric 切換時會維持不變（見下方 metricHandler，故意不重設）。
    geoGa4H1State.searchTerm = '';
    geoGa4H1State.sortColumn = null;
    geoGa4H1State.sortDirection = 'desc';
    onChange();
  };
  const metricHandler = (e) => { geoGa4H1State.metric = _geoGa4H1ValidMetric(e.target.value) ? e.target.value : 'active_users'; onChange(); };
  const syncHandler = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中…';
    try {
      const body = geoGa4H1State.mode === 'realtime'
        ? { sync_type: 'realtime' }
        : { sync_type: 'range', range: geoGa4H1State.mode, start_date: geoGa4H1State.customStart, end_date: geoGa4H1State.customEnd };
      await fetch('/api/analytics/ga4-geo/sync', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = '手動同步';
      onChange();
    }
  };

  modeEl.addEventListener('change', modeHandler);
  metricEl.addEventListener('change', metricHandler);
  syncBtn.addEventListener('click', syncHandler);

  el._ga4h1Cleanup = () => {
    modeEl.removeEventListener('change', modeHandler);
    metricEl.removeEventListener('change', metricHandler);
    syncBtn.removeEventListener('click', syncHandler);
  };
}

async function geoGa4H1Refresh(ids, mapInstance) {
  const myGeneration = ++geoGa4H1State.generation;
  geoGa4H1RenderStatus(ids.status, null);

  let payload;
  try {
    payload = await geoGa4H1Fetch(geoGa4H1State.mode, { startDate: geoGa4H1State.customStart, endDate: geoGa4H1State.customEnd });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    payload = { success: false, code: 'network_error' };
  }

  if (myGeneration !== geoGa4H1State.generation) return;

  if (payload && payload.success) {
    geoGa4H1State.lastGoodPayload = payload;
  } else if (geoGa4H1State.lastGoodPayload) {
    payload = { ...geoGa4H1State.lastGoodPayload, success: true, stale: true };
  }

  geoGa4H1RenderStatus(ids.status, payload);
  if (!payload || payload.success === false) {
    if (ids.table) geoGa4H1RenderTable(ids.table, []);
    return;
  }

  const rows = payload.cities || payload.rows || [];
  if (ids.table) geoGa4H1RenderInteractiveTable(ids.table, rows);
  if (mapInstance) geoGa4H1RenderMarkers(mapInstance, rows, geoGa4H1State.metric);
}

function geoGa4H1Init(ids, mapInstance) {
  geoGa4H1RenderToolbar(ids.toolbar, () => geoGa4H1Refresh(ids, mapInstance));
  geoGa4H1Refresh(ids, mapInstance);
}

function geoGa4H1Destroy(ids) {
  if (geoGa4H1State.pollTimer) { clearInterval(geoGa4H1State.pollTimer); geoGa4H1State.pollTimer = null; }
  if (geoGa4H1State.currentAbort) { try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ } }
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
    geoGa4H1RenderInteractiveTable, _geoGa4H1FilterRows, _geoGa4H1SortRows, _geoGa4H1RowLabel,
    _geoGa4H1Rate, _geoGa4H1MetricValue, _geoGa4H1Esc, _geoGa4H1ValidMode, _geoGa4H1ValidMetric,
    geoGa4H1Init, geoGa4H1Destroy, geoGa4H1Refresh, geoGa4H1ClearMarkers,
    geoGa4H1State,
  };
}
