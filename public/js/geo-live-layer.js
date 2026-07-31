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
    // fix18-10-hotfix30-B5-R5.4-G1.1（Visual Polish）
    autoFitDone: false,     // 只在「第一次」有資料時自動 fitBounds，之後切換 Filter 不再強制跳
    theme: 'light',         // 'light' | 'dark'，決定 Heatmap 漸層色階（見 buildHeatOptions）
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
    saveLastDisplayMode(mode); // 記住最後使用模式（LocalStorage，需求文件十四）
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
      _autoFitIfNeeded(points);
      return { state: resolveModuleState({ rows: points }), count: points.length };
    }
    if (state.mode === 'heatmap') {
      const points = await _fetchJson('/api/geo-live/markers?' + qs);
      if (points === null) return { state: 'error' };
      _renderHeat(points);
      _autoFitIfNeeded(points);
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

  // Auto Fit Bounds（需求文件四）：只在第一次有資料時自動縮放；之後切換
  // Filter 即使資料改變也不再強制跳視角（state.autoFitDone 只會被設成 true 一次）。
  function _autoFitIfNeeded(points) {
    const valid = (points || []).filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    if (!shouldAutoFitBounds(valid.length > 0, state.autoFitDone)) return;
    if (!state.map || typeof state.map.fitBounds !== 'function' || !hasL) return;
    try {
      const bounds = L.latLngBounds(valid.map((p) => [Number(p.lat), Number(p.lng)]));
      state.map.fitBounds(bounds, { maxZoom: 15 });
      state.autoFitDone = true;
    } catch (e) { /* fitBounds 失敗不影響資料本身顯示 */ }
  }

  function _renderMarkers(points, useCluster) {
    if (!state.map || !hasL) return;
    _clearActiveLayers();
    const group = useCluster && typeof L.markerClusterGroup === 'function'
      ? L.markerClusterGroup()
      : L.layerGroup();
    (points || []).forEach((p) => {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return; // 不得畫假 Marker
      const stage = resolveMarkerStage(p.event_name);
      const marker = L.marker([Number(p.lat), Number(p.lng)], {
        // Marker Fade In 動畫（200~300ms，見 ANIMATION_DURATION_MS）由 CSS
        // class 負責（.geo-live-marker-fade-in），Leaflet icon className 掛
        // 上去即可，不使用 JS setTimeout 手動漸層以免動畫過度複雜。
        icon: L.divIcon({
          className: `geo-live-marker-fade-in geo-live-marker-stage-${stage}`,
          html: `<span style="background:${markerColorForStage(stage)}"></span>`,
          iconSize: [16, 16],
        }),
      });
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
    const valid = (points || []).filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    const heatPoints = valid.map((p) => [Number(p.lat), Number(p.lng), 1]);
    // 需求文件一：即使只有 1~3 筆資料也要肉眼可辨——buildHeatOptions() 依筆數
    // 放大 radius/blur/minOpacity，不是固定一組永遠偏淡的設定。
    const opts = buildHeatOptions(valid.length, state.theme);
    state.layers.heat = L.heatLayer(heatPoints, opts);
    state.layers.heat.addTo(state.map);
  }

  // ══════════════════════════════════════════════════════════════
  // 九、R5.4-G1.1 Visual Polish — 純函式（Heatmap/Circle/Marker/Auto Fit/
  //    Summary/Ranking/Coverage/Business Opportunity/Recommended Actions/
  //    區域優惠建議/外送最佳化/LocalStorage/動畫/無障礙）
  //
  // 本輪不新增後端 API／不修改 DB／不重新設計已驗證的資料流；Summary／
  // Ranking／外送最佳化涉及的欄位（revenue／distance）目前 G1 既有 API
  // 沒有提供，這裡一律誠實地在缺資料時回傳 available:false／null，不臆測
  // 假數字（見 R5.4-G1.1_VISUAL_POLISH.md「已知限制」）。
  // ══════════════════════════════════════════════════════════════

  // ── Heatmap：即使只有 1~3 筆資料也要肉眼可辨（半徑/模糊/透明度隨筆數放大）──
  const HEAT_GRADIENT_LIGHT = Object.freeze({ 0.2: '#22c55e', 0.4: '#eab308', 0.6: '#f97316', 0.8: '#ef4444', 1.0: '#7f1d1d' });
  // Dark Theme：純紅在深色背景對比不足，改用較亮的紅／橘做最高強度色階。
  const HEAT_GRADIENT_DARK = Object.freeze({ 0.2: '#4ade80', 0.4: '#fde047', 0.6: '#fb923c', 0.8: '#ff5252', 1.0: '#ff8a80' });
  function buildHeatOptions(pointCount, theme) {
    const n = Number(pointCount) || 0;
    const gradient = theme === 'dark' ? HEAT_GRADIENT_DARK : HEAT_GRADIENT_LIGHT;
    if (n <= 3) return { radius: 45, blur: 35, maxZoom: 17, minOpacity: 0.6, gradient };
    if (n <= 10) return { radius: 35, blur: 25, maxZoom: 17, minOpacity: 0.5, gradient };
    return { radius: 25, blur: 20, maxZoom: 17, minOpacity: 0.35, gradient };
  }
  const HEAT_LEGEND_STOPS = Object.freeze([
    { emoji: '🟢', label: '低' }, { emoji: '🟡', label: '中' },
    { emoji: '🟠', label: '高' }, { emoji: '🔴', label: '最高' },
  ]);

  // ── Circle Mode：依 Metric 決定顏色，半徑依數值比例縮放（不得固定大小）──
  const METRIC_COLORS = Object.freeze({ visitors: '#3b82f6', orders: '#f97316', revenue: '#eab308', conversion: '#a855f7' });
  const CIRCLE_MIN_RADIUS_PX = 6;
  const CIRCLE_MAX_RADIUS_PX = 24;
  function buildCircleStyle(metric, value, minValue, maxValue) {
    const color = METRIC_COLORS[metric] || METRIC_COLORS.visitors;
    const v = Number(value) || 0;
    const lo = Number(minValue) || 0;
    const hi = Number(maxValue) || 0;
    let ratio = 0;
    if (hi > lo) ratio = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    else if (hi === lo && hi > 0) ratio = 1; // 只有一筆資料時，唯一值本身就是「最大值」，仍給予可辨識大小
    const radius = Math.round(CIRCLE_MIN_RADIUS_PX + ratio * (CIRCLE_MAX_RADIUS_PX - CIRCLE_MIN_RADIUS_PX));
    return { color, radius };
  }

  // ── Marker Mode：依事件階段決定 Icon 顏色 ──
  const MARKER_STAGE_COLORS = Object.freeze({ visitor: '#3b82f6', checkout: '#f97316', order: '#22c55e', revenue: '#eab308' });
  function resolveMarkerStage(eventName) {
    const e = String(eventName || '');
    if (e === 'purchase') return 'order';
    if (e === 'begin_checkout') return 'checkout';
    return 'visitor'; // page_view/view_product/add_to_cart/未知事件一律視為訪客階段
  }
  function markerColorForStage(stage) { return MARKER_STAGE_COLORS[stage] || MARKER_STAGE_COLORS.visitor; }

  // ── Auto Fit Bounds：只在「第一次」有資料時自動 fitBounds，之後切換 Filter
  //    不得強制再跳一次視角（需求文件四）──
  function shouldAutoFitBounds(hasData, alreadyDone) { return !!hasData && !alreadyDone; }

  // ── Summary Card：最高訪客/成交/營收區域、平均距離、平均轉換率、GPS/Unknown 覆蓋率 ──
  function buildSummaryCard(input) {
    const rows = Array.isArray(input && input.districtRows) ? input.districtRows : [];
    const pool = (input && input.unknownPool) || {};
    const topBy = (key) => rows.reduce((best, r) => (!best || Number(r[key]) > Number(best[key]) ? r : best), null);
    const topVisitors = topBy('visitor_count');
    const topOrders = topBy('order_count');
    // revenue 目前 G1 既有 API 沒有提供（見檔案開頭決策記錄），誠實回傳 null，
    // 不得用 orders 數量或其他欄位換算出一個看似合理的假營收數字。
    const hasRevenueField = rows.some((r) => r.revenue !== undefined && r.revenue !== null);
    const topRevenue = hasRevenueField ? topBy('revenue') : null;
    const hasDistanceField = rows.some((r) => r.avg_distance_km !== undefined && r.avg_distance_km !== null);
    const avgDistance = hasDistanceField
      ? Math.round((rows.reduce((s, r) => s + (Number(r.avg_distance_km) || 0), 0) / rows.length) * 10) / 10
      : null;
    const totalVisitors = rows.reduce((s, r) => s + (Number(r.visitor_count) || 0), 0);
    const totalOrders = rows.reduce((s, r) => s + (Number(r.order_count) || 0), 0);
    const avgConversionPct = totalVisitors > 0 ? Math.round((totalOrders / totalVisitors) * 1000) / 10 : 0;
    return {
      top_visitors: topVisitors ? { label: topVisitors.district, value: topVisitors.visitor_count } : null,
      top_orders: topOrders && topOrders.order_count > 0 ? { label: topOrders.district, value: topOrders.order_count } : null,
      top_revenue: topRevenue ? { label: topRevenue.district, value: topRevenue.revenue } : null,
      revenue_available: hasRevenueField,
      avg_distance_km: avgDistance,
      distance_available: hasDistanceField,
      avg_conversion_rate_pct: avgConversionPct,
      gps_coverage_pct: Number.isFinite(Number(pool.mappable_rate_pct)) ? Number(pool.mappable_rate_pct) : 0,
      unknown_pct: pool.total > 0 ? Math.round((Number(pool.unknown || 0) / Number(pool.total)) * 1000) / 10 : 0,
    };
  }

  // ── Ranking：排名 + 區域 + 訪客/加購/結帳/訂單/營收/成交率，依目前 Metric 排序 ──
  const RANKING_METRICS = Object.freeze(['visitor_count', 'add_to_cart_count', 'checkout_count', 'order_count', 'revenue', 'conversion_rate_pct']);
  function buildRankingTable(rows, metric) {
    const arr = (Array.isArray(rows) ? rows : []).map(buildRankingRow);
    const key = RANKING_METRICS.includes(metric) ? metric : 'visitor_count';
    const sorted = arr.slice().sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0));
    return sorted.map((row, i) => Object.assign({ rank: i + 1 }, row));
  }
  // 點擊 Ranking 列：有座標就 Pan To，沒有就顯示「目前無地圖座標」
  function resolveRankingClickAction(row) {
    if (row && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))) {
      return { action: 'panTo', lat: Number(row.lat), lng: Number(row.lng) };
    }
    return { action: 'no_coordinate', message: '目前無地圖座標' };
  }

  // ── Coverage Panel：加上 Progress Bar 用的百分比（0-100，clamp）──
  function buildCoveragePanel(unknownPool) {
    const p = unknownPool || {};
    const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    return {
      known_pct: clamp(p.coverage_pct),
      gps_pct: clamp(p.mappable_rate_pct),
      unknown_pct: p.total > 0 ? clamp((Number(p.unknown || 0) / Number(p.total)) * 100) : 0,
    };
  }

  // ── Business Opportunity（Rule-based，非 AI）──
  function buildBusinessOpportunities(districtRows) {
    const rows = Array.isArray(districtRows) ? districtRows : [];
    const opportunities = [];
    const avgVisitors = rows.length ? rows.reduce((s, r) => s + (Number(r.visitor_count) || 0), 0) / rows.length : 0;
    rows.forEach((r) => {
      const conv = Number(r.conversion_rate_pct) || 0;
      const orders = Number(r.order_count) || 0;
      const visitors = Number(r.visitor_count) || 0;
      if (conv > 80 && orders >= 1) {
        opportunities.push({ type: 'high_conversion', district: r.district, message: `建議增加「${r.district}」的 Facebook 廣告曝光（成交率 ${conv}%，訂單 ${orders} 筆）` });
      }
      if (visitors > avgVisitors && avgVisitors > 0 && conv < 5) {
        opportunities.push({ type: 'high_traffic_low_conversion', district: r.district, message: `「${r.district}」訪客多但轉換率偏低（${conv}%），建議檢查價格、優惠券與結帳流程` });
      }
    });
    return opportunities;
  }

  // ── Recommended Actions：依 Geo Summary 輸出前三個建議 ──
  function buildRecommendedActions(districtRows, coverage) {
    const actions = [];
    const rows = Array.isArray(districtRows) ? districtRows : [];
    const topConv = rows.slice().sort((a, b) => (Number(b.conversion_rate_pct) || 0) - (Number(a.conversion_rate_pct) || 0))[0];
    if (topConv && Number(topConv.conversion_rate_pct) > 0) {
      actions.push(`「${topConv.district}」成交率最高（${topConv.conversion_rate_pct}%），建議增加曝光`);
    }
    const cov = coverage || {};
    if (Number.isFinite(Number(cov.gps_pct)) && Number(cov.gps_pct) < 50) {
      actions.push(`定位同意率偏低（${cov.gps_pct}%），建議優化定位授權引導流程`);
    }
    const highTrafficLowCheckout = rows.filter((r) => Number(r.visitor_count) > 0 && Number(r.checkout_count) === 0);
    if (highTrafficLowCheckout.length > 0) {
      actions.push(`${highTrafficLowCheckout.length} 個區域有訪客但無結帳，建議改善結帳流程`);
    }
    return actions.slice(0, 3);
  }

  // ── 區域優惠建議（純建議，不修改優惠系統）：依排名給予不同建議類型 ──
  const REGION_DISCOUNT_SUGGESTIONS_BY_RANK = Object.freeze(['95 折', '免外送費', '滿額送好禮']);
  function buildRegionDiscountSuggestions(rankedRows) {
    const rows = Array.isArray(rankedRows) ? rankedRows : [];
    return rows.slice(0, REGION_DISCOUNT_SUGGESTIONS_BY_RANK.length).map((r, i) => ({
      district: r.district || r.label, suggestion: REGION_DISCOUNT_SUGGESTIONS_BY_RANK[i],
    }));
  }

  // ── 外送最佳化：只有真的有 distance 欄位才輸出數字，否則誠實回傳 available:false ──
  const DELIVERY_DISTANCE_ALERT_KM = 5;
  function buildDeliveryOptimization(rows) {
    const arr = Array.isArray(rows) ? rows.filter((r) => Number.isFinite(Number(r.distance_km))) : [];
    if (arr.length === 0) return { available: false };
    const distances = arr.map((r) => Number(r.distance_km));
    const fees = arr.filter((r) => Number.isFinite(Number(r.delivery_fee))).map((r) => Number(r.delivery_fee));
    const avg = (list) => Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10;
    const avgDistance = avg(distances);
    return {
      available: true,
      avg_distance_km: avgDistance,
      max_distance_km: Math.max(...distances),
      min_distance_km: Math.min(...distances),
      avg_delivery_fee: fees.length ? avg(fees) : null,
      suggest_fee_review: avgDistance > DELIVERY_DISTANCE_ALERT_KM,
    };
  }

  // ── Display Mode 記憶（LocalStorage，Segmented Control 用）──
  const LAST_DISPLAY_MODE_STORAGE_KEY = 'geo_live_layer_last_mode';
  function getLastDisplayMode(storage) {
    try {
      const s = storage || (hasWindow ? window.localStorage : null);
      if (!s) return null;
      const v = s.getItem(LAST_DISPLAY_MODE_STORAGE_KEY);
      return isValidDisplayMode(v) ? v : null;
    } catch (e) { return null; }
  }
  function saveLastDisplayMode(mode, storage) {
    try {
      if (!isValidDisplayMode(mode)) return false;
      const s = storage || (hasWindow ? window.localStorage : null);
      if (!s) return false;
      s.setItem(LAST_DISPLAY_MODE_STORAGE_KEY, mode);
      return true;
    } catch (e) { return false; }
  }

  // ── 動畫（Marker Fade In / Circle Zoom / Heat Fade）：200~300ms，不得過度 ──
  const ANIMATION_DURATION_MS = 250;
  function isAcceptableAnimationDuration(ms) { return Number(ms) >= 200 && Number(ms) <= 300; }

  // ── Accessibility：Legend/Tooltip/Button/Switch 共用的 aria-label 文案 ──
  const ARIA_LABELS = Object.freeze({
    modeSwitcher: '地圖顯示模式切換',
    heatToggle: '切換熱區圖顯示',
    legend: '地圖圖例說明',
    rankingRow: '點擊查看區域位置',
  });

  // ══════════════════════════════════════════════════════════════

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
    if (c.theme === 'dark' || c.theme === 'light') state.theme = c.theme;
    // 需求文件十四：記住最後使用模式。若呼叫端明確指定 mode 則優先採用；
    // 否則嘗試從 LocalStorage 還原上次使用的顯示模式，都沒有才維持預設 'markers'。
    if (c.mode && isValidDisplayMode(c.mode)) {
      state.mode = c.mode;
    } else {
      const remembered = getLastDisplayMode();
      if (remembered) state.mode = remembered;
    }
  }

  return {
    // 純函式（Node/瀏覽器皆可用，供智慧測試直接呼叫）
    safeDisplay, isValidDisplayMode, isValidHeatMetric, DISPLAY_MODES, HEAT_METRICS,
    buildMarkerTooltipFields, buildClusterSummary, buildRankingRow,
    sortTimelineEvents, paginateTimeline,
    replayFrameAt, replaySpeedIntervalMs,
    MIN_POLL_INTERVAL_MS, resolvePollIntervalMs, isStaleResponse,
    resolveModuleState,
    // fix18-10-hotfix30-B5-R5.4-G1.1（Visual Polish）
    buildHeatOptions, HEAT_GRADIENT_LIGHT, HEAT_GRADIENT_DARK, HEAT_LEGEND_STOPS,
    METRIC_COLORS, CIRCLE_MIN_RADIUS_PX, CIRCLE_MAX_RADIUS_PX, buildCircleStyle,
    MARKER_STAGE_COLORS, resolveMarkerStage, markerColorForStage,
    shouldAutoFitBounds,
    buildSummaryCard,
    RANKING_METRICS, buildRankingTable, resolveRankingClickAction,
    buildCoveragePanel,
    buildBusinessOpportunities, buildRecommendedActions,
    REGION_DISCOUNT_SUGGESTIONS_BY_RANK, buildRegionDiscountSuggestions,
    DELIVERY_DISTANCE_ALERT_KM, buildDeliveryOptimization,
    LAST_DISPLAY_MODE_STORAGE_KEY, getLastDisplayMode, saveLastDisplayMode,
    ANIMATION_DURATION_MS, isAcceptableAnimationDuration,
    ARIA_LABELS,
    // 瀏覽器環境物件方法
    init, attachToMap, setMode, setFilters, refresh, destroy,
    get state() { return state; },
  };
}));
