// public/js/geo-live-layer.js — fix18-10-hotfix30-B5-R5.4-G1
// Geo Intelligence V2｜GeoLiveLayer（前端顯示層）
//
// 硬性原則（需求文件四）：
//   - 必須重用既有 Leaflet map（window.geoMapState.instance，見
//     public/js/geo-intelligence-map.js），絕不建立第二張 L.map()、第二個
//     Tile Layer，也絕不 destroy 既有 map。
//   - 一次只啟用一個「主要顯示模式」（Live Markers／Cluster／Heatmap／
//     District／Postal／Replay），避免多層 Marker/Heat 疊在一起造成誤解。
//   - Unknown ≠ Empty：Unknown 是「有訪客但沒有真實座標」，Empty 是「這個
//     篩選條件下沒有符合的事件」，兩者的空狀態文案不同。
//
// 本檔案分成兩部分：
//   1. 純函式（可在 Node 環境下 require() 單獨單元測試，不碰 window/L/DOM）。
//   2. GeoLiveLayer 物件（需要瀏覽器環境；Node 環境下這些方法是安全 no-op）。

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.GeoLiveLayer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ══════════════════════════════════════════════════════════════
  // 一、純函式：Tooltip 安全格式化（避免 undefined/null/NaN/Infinity 顯示，
  //    需求文件五「Marker Tooltip 需避免 undefined/null/NaN/Infinity」）
  // ══════════════════════════════════════════════════════════════
  function safeDisplay(value, fallback) {
    const fb = fallback === undefined ? '—' : fallback;
    if (value === undefined || value === null) return fb;
    if (typeof value === 'number' && (Number.isNaN(value) || !Number.isFinite(value))) return fb;
    const s = String(value).trim();
    if (!s || s === 'undefined' || s === 'null' || s === 'NaN') return fb;
    return s;
  }

  const DISPLAY_MODES = Object.freeze(['markers', 'cluster', 'heatmap', 'district', 'postal', 'replay']);
  function isValidDisplayMode(mode) { return DISPLAY_MODES.includes(mode); }

  const HEAT_METRICS = Object.freeze(['visitor_count', 'add_to_cart_count', 'checkout_count', 'order_count']);
  function isValidHeatMetric(metric) { return HEAT_METRICS.includes(metric); }

  // ══════════════════════════════════════════════════════════════
  // 二、純函式：Marker Tooltip 內容組裝（不含 HTML escape 以外的邏輯，
  //    escHtml 由呼叫端既有的全域函式提供，跟頁面其餘 Tooltip 共用同一套
  //    escape 邏輯，不重寫第二套）
  // ══════════════════════════════════════════════════════════════
  function buildMarkerTooltipFields(point) {
    const p = point || {};
    return {
      visitor: safeDisplay(p.visitor_key, '匿名訪客'),
      last_event: safeDisplay(p.event_name),
      last_active: safeDisplay(p.event_time),
      channel: safeDisplay(p.channel, 'Direct'),
      device: safeDisplay(p.device_type, 'Unknown'),
      coordinate_source: safeDisplay(p.coordinate_source),
      accuracy: (p.accuracy_m === undefined || p.accuracy_m === null || !Number.isFinite(Number(p.accuracy_m)))
        ? '—' : (Math.round(Number(p.accuracy_m)) + ' m'),
      geo_quality: p.accuracy_m != null && Number.isFinite(Number(p.accuracy_m))
        ? (Number(p.accuracy_m) <= 50 ? '高' : Number(p.accuracy_m) <= 500 ? '中' : '低')
        : '未知',
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 三、純函式：Cluster Tooltip / District Ranking 列格式化
  // ══════════════════════════════════════════════════════════════
  function buildClusterSummary(points) {
    const arr = Array.isArray(points) ? points : [];
    const visitors = arr.length;
    // Cluster 本身沒有漏斗欄位（Marker 資料只有 event_name 這一筆最後事件），
    // 這裡誠實地只統計「visitors」；Add to Cart/Checkout/Order 由後端
    // District/Postal 聚合 API 提供（見 buildRankingRow），不在前端用單一
    // 「最後事件」臆測整個漏斗，避免低估或高估轉換數字。
    return { visitors };
  }

  function buildRankingRow(row) {
    const r = row || {};
    return {
      label: safeDisplay(row && (row.district || row.postal_code), 'Unknown'),
      city: safeDisplay(r.city, ''),
      visitor_count: Number.isFinite(Number(r.visitor_count)) ? Number(r.visitor_count) : 0,
      add_to_cart_count: Number.isFinite(Number(r.add_to_cart_count)) ? Number(r.add_to_cart_count) : 0,
      checkout_count: Number.isFinite(Number(r.checkout_count)) ? Number(r.checkout_count) : 0,
      order_count: Number.isFinite(Number(r.order_count)) ? Number(r.order_count) : 0,
      conversion_rate_pct: Number.isFinite(Number(r.conversion_rate_pct)) ? Number(r.conversion_rate_pct) : 0,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 四、純函式：Timeline 排序 + 分頁／virtualization（需求文件十一／十五）
  // ══════════════════════════════════════════════════════════════
  function sortTimelineEvents(events) {
    const arr = Array.isArray(events) ? events.slice() : [];
    arr.sort((a, b) => String(a.event_time || '').localeCompare(String(b.event_time || '')));
    return arr;
  }

  function paginateTimeline(events, page, pageSize) {
    const arr = Array.isArray(events) ? events : [];
    const size = Math.max(1, Number(pageSize) || 50);
    const p = Math.max(1, Number(page) || 1);
    const start = (p - 1) * size;
    return {
      page: p,
      page_size: size,
      total: arr.length,
      total_pages: Math.max(1, Math.ceil(arr.length / size)),
      rows: arr.slice(start, start + size),
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 五、純函式：Replay 時間切片（需求文件十二：先 Fetch 一次，前端依時間切片，
  //    不得每一幀重新 Fetch）
  // ══════════════════════════════════════════════════════════════
  // buckets: [{ bucket_start, new_visitors, cumulative_visitors }, ...]（來自
  // GET /api/geo-live/replay，已經是後端算好的時間桶）。frameIndex 對應第幾格。
  function replayFrameAt(buckets, frameIndex) {
    const arr = Array.isArray(buckets) ? buckets : [];
    if (arr.length === 0) return { bucket_start: null, new_visitors: 0, cumulative_visitors: 0, is_last: true };
    const idx = Math.max(0, Math.min(arr.length - 1, Number(frameIndex) || 0));
    return Object.assign({ is_last: idx === arr.length - 1 }, arr[idx]);
  }

  function replaySpeedIntervalMs(speed) {
    // 1x/2x/4x 的「播放速度」對應每一格 bucket 停留多久（毫秒），純函式方便
    // 測試；800ms 是 1x 的基準格距，不是隨機值。
    const base = 800;
    const s = [1, 2, 4].includes(Number(speed)) ? Number(speed) : 1;
    return Math.round(base / s);
  }

  // ══════════════════════════════════════════════════════════════
  // 六、純函式：Realtime 輪詢節流（需求文件十四：不得低於 5 秒無限制狂刷；
  //    背景分頁降頻/暫停）
  // ══════════════════════════════════════════════════════════════
  const MIN_POLL_INTERVAL_MS = 5000;
  function resolvePollIntervalMs(requestedMs, isTabVisible) {
    const req = Number.isFinite(Number(requestedMs)) ? Number(requestedMs) : MIN_POLL_INTERVAL_MS;
    const clamped = Math.max(MIN_POLL_INTERVAL_MS, req);
    // 背景分頁：降頻為 4 倍（不是完全停止——已同意定位的訪客回報座標仍應該
    // 偶爾更新，但不需要前景那麼即時）。
    return isTabVisible ? clamped : clamped * 4;
  }

  // Stale Response Guard：純函式版本，呼叫端維護一個遞增的 requestSeq，
  // 回應抵達時比對是否仍是「最新一次」請求，不是的話直接丟棄（不更新畫面）。
  function isStaleResponse(respondingSeq, latestSeq) {
    return Number(respondingSeq) < Number(latestSeq);
  }

  // ══════════════════════════════════════════════════════════════
  // 七、純函式：四態（loading/ready/empty/error）判斷
  // ══════════════════════════════════════════════════════════════
  function resolveModuleState(input) {
    const i = input || {};
    if (i.loading) return 'loading';
    if (i.error) return 'error';
    if (!Array.isArray(i.rows) || i.rows.length === 0) return 'empty';
    return 'ready';
  }

  // ══════════════════════════════════════════════════════════════
  // 八、瀏覽器環境部分：GeoLiveLayer 物件本體
  // ══════════════════════════════════════════════════════════════
  const hasWindow = typeof window !== 'undefined';
  const hasL = typeof L !== 'undefined';

  // 內部狀態：一律用「就地清空」而不是重新指派，跟 geo-intelligence-map.js
  // 既有慣例一致，避免任何持有舊參考的呼叫端跟目前狀態不同步。
  const state = {
    map: null,               // 外部傳入的既有 Leaflet map 實例，絕不自己 new
    mode: 'markers',
    filters: { range: 'today', channel: null, device: null },
    layers: {                // 每個模式各自的 Leaflet layer，同一時間只有一個 addTo(map)
      markerCluster: null,
      heat: null,
    },
    pollTimer: null,
    requestSeq: 0,
    storeId: null,
    destroyed: false,
  };

  function _clearActiveLayers() {
    if (!state.map) return;
    if (state.layers.markerCluster && state.map.hasLayer(state.layers.markerCluster)) {
      state.map.removeLayer(state.layers.markerCluster);
    }
    if (state.layers.heat && state.map.hasLayer(state.layers.heat)) {
      state.map.removeLayer(state.layers.heat);
    }
  }

  // attachToMap：接受既有 map 實例（來自 window.geoMapState.instance），不建立
  // 新的 L.map()／Tile Layer。呼叫多次也安全（就地更新 state.map，不重建）。
  function attachToMap(mapInstance) {
    if (!mapInstance) return false;
    state.map = mapInstance;
    return true;
  }

  function setMode(mode) {
    if (!isValidDisplayMode(mode)) return false;
    if (state.mode !== mode) _clearActiveLayers();
    state.mode = mode;
    return true;
  }

  function setFilters(filters) {
    state.filters = Object.assign({}, state.filters, filters || {});
  }

  async function _fetchJson(url) {
    const mySeq = ++state.requestSeq;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    try {
      const fetchFn = (hasWindow && typeof window.apiFetch === 'function') ? window.apiFetch : fetch;
      const res = await fetchFn(url, controller ? { signal: controller.signal } : undefined);
      if (isStaleResponse(mySeq, state.requestSeq)) return null; // Stale Response Guard
      if (!res || !res.ok) return null;
      const json = await res.json();
      return json && json.success ? json.data : null;
    } catch (e) {
      return null; // AbortError／網路錯誤：安靜回 null，呼叫端顯示 error 態
    }
  }

  function _qs() {
    const f = state.filters || {};
    const params = new URLSearchParams();
    if (state.storeId) params.set('store_id', state.storeId);
    if (f.range) params.set('range', f.range);
    if (f.channel) params.set('channel', f.channel);
    if (f.device) params.set('device', f.device);
    return params.toString();
  }

  // 依目前 mode 重新拉資料並畫圖（只畫「目前啟用的那一個」Layer）。
  async function refresh() {
    if (!state.map || state.destroyed) return { state: 'error', reason: 'map_not_attached' };
    const qs = _qs();
    if (state.mode === 'markers' || state.mode === 'cluster') {
      const points = await _fetchJson('/api/geo-live/markers?' + qs);
      if (points === null) return { state: 'error' };
      _renderMarkers(points, state.mode === 'cluster');
      return { state: resolveModuleState({ rows: points }), count: points.length };
    }
    if (state.mode === 'heatmap') {
      const points = await _fetchJson('/api/geo-live/markers?' + qs);
      if (points === null) return { state: 'error' };
      _renderHeat(points);
      return { state: resolveModuleState({ rows: points }), count: points.length };
    }
    if (state.mode === 'district') {
      const rows = await _fetchJson('/api/geo-live/districts?' + qs);
      if (rows === null) return { state: 'error' };
      _clearActiveLayers();
      return { state: resolveModuleState({ rows }), rows: (rows || []).map(buildRankingRow) };
    }
    if (state.mode === 'postal') {
      const rows = await _fetchJson('/api/geo-live/postal?' + qs);
      if (rows === null) return { state: 'error' };
      _clearActiveLayers();
      return { state: resolveModuleState({ rows }), rows: (rows || []).map((r) => buildRankingRow({ district: r.postal_code, visitor_count: r.visitor_count })) };
    }
    if (state.mode === 'replay') {
      const buckets = await _fetchJson('/api/geo-live/replay?' + qs);
      if (buckets === null) return { state: 'error' };
      return { state: resolveModuleState({ rows: buckets }), buckets };
    }
    return { state: 'error', reason: 'unknown_mode' };
  }

  function _renderMarkers(points, useCluster) {
    if (!state.map || !hasL) return;
    _clearActiveLayers();
    const group = useCluster && typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup()
      : L.layerGroup();
    (points || []).forEach((p) => {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return; // 不得畫假 Marker
      const marker = L.marker([Number(p.lat), Number(p.lng)]);
      const f = buildMarkerTooltipFields(p);
      marker.bindTooltip(
        `訪客 ${f.visitor}｜${f.last_event}｜${f.channel}／${f.device}｜精確度 ${f.accuracy}（${f.geo_quality}）`
      );
      group.addLayer(marker);
    });
    group.addTo(state.map);
    state.layers.markerCluster = group;
  }

  function _renderHeat(points) {
    if (!state.map || !hasL || typeof L.heatLayer !== 'function') return;
    _clearActiveLayers();
    const metric = isValidHeatMetric(state.filters.heatMetric) ? state.filters.heatMetric : 'visitor_count';
    void metric; // Marker 資料目前只有「一人一點」，權重固定為 1；未來若聚合成
    // 「同一格多人」時可在這裡依 metric 加權，目前誠實地不假裝有除了
    // visitor_count 以外、Marker 層級就能算出的其他指標。
    const heatPoints = (points || [])
      .filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
      .map((p) => [Number(p.lat), Number(p.lng), 1]);
    state.layers.heat = L.heatLayer(heatPoints, { radius: 25 });
    state.layers.heat.addTo(state.map);
  }

  function destroy() {
    _clearActiveLayers();
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    state.destroyed = true;
    // 注意：絕不呼叫 state.map.remove()——那張地圖是既有 geo-intelligence-map.js
    // 的實例，銷毀權責不屬於 GeoLiveLayer（需求文件四）。
  }

  function init(config) {
    const c = config || {};
    state.storeId = c.storeId || null;
    if (c.map) attachToMap(c.map);
    if (c.filters) setFilters(c.filters);
  }

  return {
    // 純函式（Node/瀏覽器皆可用，供智慧測試直接呼叫）
    safeDisplay, isValidDisplayMode, isValidHeatMetric, DISPLAY_MODES, HEAT_METRICS,
    buildMarkerTooltipFields, buildClusterSummary, buildRankingRow,
    sortTimelineEvents, paginateTimeline,
    replayFrameAt, replaySpeedIntervalMs,
    MIN_POLL_INTERVAL_MS, resolvePollIntervalMs, isStaleResponse,
    resolveModuleState,
    // 瀏覽器環境物件方法
    init, attachToMap, setMode, setFilters, refresh, destroy,
    get state() { return state; },
  };
}));
