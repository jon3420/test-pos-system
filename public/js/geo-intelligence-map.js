// public/js/geo-intelligence-map.js — fix18-10-hotfix30-B5-R5.2-B2
// Leaflet Geo Intelligence Map
//
// Additive Only：不重寫 Dashboard/Rule Engine/Explainability/API。
// 沿用既有全域（跟 geo-intelligence.js 同一套 classic <script> 共用作用域
// 慣例，不是 ES Module，見該檔案開頭註解）：escHtml()、_geoPct()、
// _geoPeople()、geoDashboardFilters、av2Channel、dashboardDateState、
// geoOpenAreaExplorer()——全部直接重用，不建立第二套 filter state 或
// Explorer 邏輯。
'use strict';

// ════════════════════════════════════════════════════════════════
// 八、顏色分級——deterministic，集中管理，不得散落。
// ════════════════════════════════════════════════════════════════
const GEO_MAP_PALETTE = Object.freeze({
  no_data: '#9ca3af',
  scale: Object.freeze(['#eff6ff', '#bfdbfe', '#60a5fa', '#3b82f6', '#1e3a8a']),
  risk: Object.freeze({ critical: '#991b1b', high: '#ef4444', medium: '#f59e0b', low: '#10b981', none: '#9ca3af' }),
  selected_border: '#111827',
  hover_border: '#374151',
});

// ════════════════════════════════════════════════════════════════
// 二十二、商家可設定地圖聚焦範圍——SaaS 架構（fix18-10-hotfix30-B5-R5.2-B2）
// 不得把桃園寫死成全系統預設；scope_mode 決定要用哪組資料算 viewport，
// 無效時一律落到台灣全域 fallback，絕不 fallback 桃園。
// ════════════════════════════════════════════════════════════════
const GEO_MAP_SCOPE_MODES = Object.freeze(['store_location', 'districts', 'custom_bounds', 'data_bounds']);
const GEO_MAP_TAIWAN_FALLBACK_VIEWPORT = Object.freeze({ type: 'center', center: [23.7, 121.0], zoom: 7, source: 'taiwan_fallback' });

function _geoIsValidBoundsObj(b) {
  if (!b || typeof b !== 'object') return false;
  const { south, west, north, east } = b;
  return [south, west, north, east].every((v) => typeof v === 'number' && Number.isFinite(v))
    && south < north && west < east && south >= -90 && north <= 90 && west >= -180 && east <= 180;
}

// 需求文件八：單一 pure helper，決定地圖初始 viewport。優先順序完全依
// scope_mode 決定該用哪一組資料，資料無效時落到台灣全域 fallback，不得
// 混用其他模式的資料算出來的 bounds。
function geoResolveInitialViewport(options) {
  const o = options || {};
  const autoFit = o.autoFitBounds !== false;
  if (o.scopeMode === 'custom_bounds') {
    if (autoFit && _geoIsValidBoundsObj(o.customBounds)) return { type: 'bounds', bounds: o.customBounds, source: 'custom_bounds' };
    return { ...GEO_MAP_TAIWAN_FALLBACK_VIEWPORT };
  }
  if (o.scopeMode === 'districts') {
    if (autoFit && _geoIsValidBoundsObj(o.districtBounds)) return { type: 'bounds', bounds: o.districtBounds, source: 'districts' };
    return { ...GEO_MAP_TAIWAN_FALLBACK_VIEWPORT };
  }
  if (o.scopeMode === 'data_bounds') {
    if (autoFit && _geoIsValidBoundsObj(o.dataBounds)) return { type: 'bounds', bounds: o.dataBounds, source: 'data_bounds' };
    return { ...GEO_MAP_TAIWAN_FALLBACK_VIEWPORT };
  }
  if (o.scopeMode === 'store_location') {
    if (Number.isFinite(o.storeLat) && Number.isFinite(o.storeLng)) {
      return { type: 'center', center: [o.storeLat, o.storeLng], zoom: Number.isFinite(o.zoom) ? o.zoom : 12, source: 'store_location' };
    }
    return { ...GEO_MAP_TAIWAN_FALLBACK_VIEWPORT }; // 需求文件十二：店家座標缺失 → 台灣 fallback，不得 fallback 桃園
  }
  return { ...GEO_MAP_TAIWAN_FALLBACK_VIEWPORT };
}

// 需求文件七：GeoJSON 邊界來源解析——只依 settings.city_code 在 manifest 內
// 查表，查不到就不載入邊界（不自動 fallback 桃園），來源必須是站內相對路徑。
function _geoIsUnsafeSourceUrl(src) {
  if (src === null || src === undefined) return false;
  const s = String(src).trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return true; // 任何帶 scheme 的 URL
  if (s.startsWith('//')) return true; // protocol-relative
  if (s.includes('..')) return true; // path traversal
  if (!s.startsWith('/')) return true; // 必須是站內絕對相對路徑
  return false;
}
function geoResolveBoundarySource(settings, manifest) {
  const s = settings || {};
  const m = manifest || {};
  const cities = m.cities || {};
  if (!s.city_code) return null;
  const entry = cities[s.city_code];
  if (!entry || !entry.source) return null;
  const src = String(entry.source);
  if (_geoIsUnsafeSourceUrl(src)) return null;
  return src;
}
// 需求文件九：scope_mode=districts 時只 render 選取的行政區。沒有
// district_code 屬性的舊版 fixture（例如既有測試用的桃園 13 區樣本）視為
// 無法辨識、不過濾（向後相容），避免因為缺屬性就整批消失。
function _geoFilterFeaturesByDistrictCodes(features, districtCodes) {
  if (!Array.isArray(districtCodes) || !districtCodes.length) return features;
  const set = new Set(districtCodes);
  return (features || []).filter((f) => {
    const code = f && f.properties && f.properties.district_code;
    return code ? set.has(code) : true;
  });
}

const GEO_MAP_METRICS = Object.freeze(['visitors', 'orders', 'revenue', 'conversion_rate', 'cart_abandonment_rate', 'risk']);
const GEO_MAP_METRIC_LABELS = Object.freeze({
  visitors: 'Visitors', orders: 'Orders', revenue: 'Revenue',
  conversion_rate: 'Conversion', cart_abandonment_rate: 'Cart Abandonment', risk: 'Recommendation Risk',
});

// ════════════════════════════════════════════════════════════════
// 集中訊息表——Loading/Empty/Error/Retry/No-Data 全部從這裡取字串，
// render function 內部不得再散落固定中文字串（每一句人類可讀文字只在這裡
// 出現一次，其他地方一律透過 geoMapStatusText()/geoBuildMapStatusHtml()
// 或本檔案下方的 formatter 取用）。
// ════════════════════════════════════════════════════════════════
const GEO_MAP_MESSAGES = Object.freeze({
  loading_leaflet: '地圖元件載入中',
  loading_boundary: '行政區邊界載入中',
  loading_default: '正在載入區域資料',
  error_default: '無法載入區域地圖',
  retry_label: '重新載入',
  no_data_label: '暫無資料',
  empty_no_data: '目前沒有符合條件的區域資料',
  empty_hint: '可調整日期或篩選條件後重試',
});
const GEO_MAP_LOADING_KINDS = Object.freeze(['loading_leaflet', 'loading_boundary', 'loading_default']);
function geoMapStatusText(kind) {
  return GEO_MAP_MESSAGES[kind] || GEO_MAP_MESSAGES.error_default;
}
function geoBuildMapStatusHtml(kind) {
  const resolvedKind = GEO_MAP_MESSAGES[kind] ? kind : 'error_default';
  const text = geoMapStatusText(resolvedKind);
  if (GEO_MAP_LOADING_KINDS.includes(resolvedKind)) {
    return `<div class="geo-map-loading" aria-busy="true" aria-live="polite">${escHtml(text)}</div>`;
  }
  return `<div class="geo-map-error" role="alert">
    <p>${escHtml(text)}</p>
    <button type="button" class="geo-map-retry-btn" onclick="geoRetryMap()">${escHtml(geoMapStatusText('retry_label'))}</button>
  </div>`;
}
function geoBuildMapEmptyHtml() {
  return `<div class="geo-map-empty">${escHtml(geoMapStatusText('empty_no_data'))}，${escHtml(geoMapStatusText('empty_hint'))}</div>`;
}

// ════════════════════════════════════════════════════════════════
// 五、行政區名稱正規化與比對——單一 matcher，不得在多個 render 函式各自實作。
// ════════════════════════════════════════════════════════════════
function geoNormalizeAreaName(name) {
  if (name === null || name === undefined) return '';
  let s = String(name);
  s = s.replace(/\u3000/g, ''); // 全形空白
  s = s.trim();
  s = s.replace(/臺/g, '台'); // 臺/台 統一
  s = s.toLowerCase();
  return s;
}
// 供「行政區」欄位模糊比對用（去掉常見行政區字尾），只在 county+district
// 完全比對失敗時當最後手段使用，不當作主要比對邏輯。
function _geoStripAreaSuffix(normalized) {
  return normalized.replace(/(區|市|鄉|鎮)$/, '');
}
function _geoAreaIndexKey(county, district) {
  return `${geoNormalizeAreaName(county)}|${geoNormalizeAreaName(district)}`;
}

// 需求文件五：比對優先順序 1. area_id 2. county+district 3. normalized district name
function geoMatchAreaToFeature(areaRow, featureIndex) {
  if (!areaRow || !featureIndex) return null;
  if (areaRow.area_id && featureIndex.byAreaId.has(areaRow.area_id)) {
    return featureIndex.byAreaId.get(areaRow.area_id);
  }
  const key = _geoAreaIndexKey(areaRow.city || areaRow.county, areaRow.district);
  if (featureIndex.byCountyDistrict.has(key)) return featureIndex.byCountyDistrict.get(key);
  // 最後手段：只用行政區名稱模糊比對（去字尾），不看縣市
  const stripped = _geoStripAreaSuffix(geoNormalizeAreaName(areaRow.district));
  if (stripped && featureIndex.byStrippedDistrict.has(stripped)) {
    return featureIndex.byStrippedDistrict.get(stripped);
  }
  return null;
}

function geoBuildAreaFeatureIndex(geojson) {
  const byAreaId = new Map();
  const byCountyDistrict = new Map();
  const byStrippedDistrict = new Map();
  const features = Array.isArray(geojson && geojson.features) ? geojson.features : [];
  features.forEach((f) => {
    const props = (f && f.properties) || {};
    if (props.area_id) byAreaId.set(props.area_id, f);
    const key = _geoAreaIndexKey(props.county, props.district);
    byCountyDistrict.set(key, f);
    const stripped = _geoStripAreaSuffix(geoNormalizeAreaName(props.district));
    if (stripped && !byStrippedDistrict.has(stripped)) byStrippedDistrict.set(stripped, f);
  });
  return { byAreaId, byCountyDistrict, byStrippedDistrict, featureCount: features.length };
}

// ════════════════════════════════════════════════════════════════
// 七、Metric 數值抽取——不重算 classification/confidence，只讀既有欄位。
// ════════════════════════════════════════════════════════════════
function _geoSafeNum2(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function geoGetMetricValue(row, metric) {
  if (!row) return null;
  switch (metric) {
    case 'visitors': return _geoSafeNum2(row.visitors);
    case 'orders': return _geoSafeNum2(row.orders ?? row.order_count ?? row.purchase_visitors);
    case 'revenue': return _geoSafeNum2(row.revenue);
    case 'conversion_rate': return _geoSafeNum2(row.conversion_rate);
    case 'cart_abandonment_rate': {
      const visitors = _geoSafeNum2(row.visitors);
      const abandon = _geoSafeNum2(row.cart_abandon_visitors);
      if (visitors === null || abandon === null || visitors <= 0) return null;
      return Math.max(0, abandon / visitors);
    }
    default: return null;
  }
}
// 需求文件十六：Recommendation Risk——完全重用既有 classification/severity，
// 不在前端重新判斷任何門檻。
function geoClassifyAreaRisk(model) {
  if (!model || !model.headline) return 'none';
  const severity = model.headline.severity;
  const intent = model.intent_type;
  if (severity === 'high' && intent === 'risk') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  if (severity === 'low') return 'low';
  return 'none';
}
const GEO_RISK_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1, none: 0 });

// ════════════════════════════════════════════════════════════════
// 八、Deterministic Quantile Scale
// ════════════════════════════════════════════════════════════════
function _geoQuantile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
function geoBuildMetricScale(values, metric) {
  const finite = (values || []).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  if (!finite.length) return { metric, min: 0, p25: 0, median: 0, p75: 0, max: 0, hasData: false, breaks: [0, 0, 0, 0, 0] };
  const sorted = finite.slice().sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  const p25 = _geoQuantile(sorted, 0.25), median = _geoQuantile(sorted, 0.5), p75 = _geoQuantile(sorted, 0.75);
  // 全部數值相同（例如全部為 0 或全部相等）：所有 break 相同，樣式函式需能
  // 安全處理（見 geoGetFeatureStyle），不得因除零區間而出錯。
  return { metric, min, p25, median, p75, max, hasData: true, breaks: [min, p25, median, p75, max] };
}

// ════════════════════════════════════════════════════════════════
// 八、Feature Style（無資料一律灰色虛線，不當成 0）
// ════════════════════════════════════════════════════════════════
function geoGetFeatureStyle(value, metric, scale, opts) {
  const options = opts || {};
  if (metric === 'risk') {
    const color = GEO_MAP_PALETTE.risk[value] || GEO_MAP_PALETTE.no_data;
    return _geoApplyInteractionStyle({ fillColor: color, color: '#ffffff', weight: 1, fillOpacity: value ? 0.75 : 0.3, dashArray: value ? null : '4' }, options);
  }
  if (value === null || value === undefined || !scale || !scale.hasData) {
    return _geoApplyInteractionStyle({ fillColor: GEO_MAP_PALETTE.no_data, color: '#ffffff', weight: 1, fillOpacity: 0.25, dashArray: '4' }, options);
  }
  const breaks = scale.breaks;
  let bucket = 0;
  for (let i = 1; i < breaks.length; i += 1) {
    if (value >= breaks[i]) bucket = i;
  }
  const color = GEO_MAP_PALETTE.scale[Math.min(bucket, GEO_MAP_PALETTE.scale.length - 1)];
  return _geoApplyInteractionStyle({ fillColor: color, color: '#ffffff', weight: 1, fillOpacity: 0.7, dashArray: null }, options);
}
function _geoApplyInteractionStyle(base, options) {
  const style = { ...base };
  if (options.selected) { style.color = GEO_MAP_PALETTE.selected_border; style.weight = 3; style.fillOpacity = Math.min(1, (style.fillOpacity || 0.5) + 0.15); }
  else if (options.hovered) { style.color = GEO_MAP_PALETTE.hover_border; style.weight = 2; style.fillOpacity = Math.min(1, (style.fillOpacity || 0.5) + 0.1); }
  return style;
}

// ════════════════════════════════════════════════════════════════
// 九、Legend（跟目前 metric 同步，格式沿用既有 helper，不殘留上一個單位）
// ════════════════════════════════════════════════════════════════
function _geoFormatMetricValue(value, metric) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return geoMapStatusText('no_data_label');
  const v = Number(value);
  if (metric === 'revenue') return `NT$${Math.round(v).toLocaleString('zh-TW')}`;
  if (metric === 'conversion_rate' || metric === 'cart_abandonment_rate') return `${Math.round(v * 100)}%`;
  return `${Math.round(v)}`;
}
function geoBuildMapLegend(scale, metric) {
  if (metric === 'risk') {
    return {
      metric, title: GEO_MAP_METRIC_LABELS.risk,
      items: [
        { label: 'Critical', color: GEO_MAP_PALETTE.risk.critical },
        { label: 'High', color: GEO_MAP_PALETTE.risk.high },
        { label: 'Medium', color: GEO_MAP_PALETTE.risk.medium },
        { label: 'Low', color: GEO_MAP_PALETTE.risk.low },
        { label: geoMapStatusText('no_data_label'), color: GEO_MAP_PALETTE.no_data },
      ],
    };
  }
  if (!scale || !scale.hasData) {
    return { metric, title: GEO_MAP_METRIC_LABELS[metric] || metric, items: [{ label: geoMapStatusText('no_data_label'), color: GEO_MAP_PALETTE.no_data }] };
  }
  const breaks = scale.breaks;
  const items = [];
  for (let i = 0; i < breaks.length; i += 1) {
    const lo = breaks[i];
    const hi = i < breaks.length - 1 ? breaks[i + 1] : null;
    const label = hi === null
      ? `${_geoFormatMetricValue(lo, metric)}+`
      : `${_geoFormatMetricValue(lo, metric)}–${_geoFormatMetricValue(hi, metric)}`;
    items.push({ label, color: GEO_MAP_PALETTE.scale[Math.min(i, GEO_MAP_PALETTE.scale.length - 1)] });
  }
  items.push({ label: geoMapStatusText('no_data_label'), color: GEO_MAP_PALETTE.no_data });
  return { metric, title: GEO_MAP_METRIC_LABELS[metric] || metric, items };
}

// ════════════════════════════════════════════════════════════════
// 十五、Map Summary（deterministic，不做 AI 敘述）
// ════════════════════════════════════════════════════════════════
function geoBuildMapSummary(rows, metric) {
  const withValues = (Array.isArray(rows) ? rows : []).map((r) => ({ row: r, value: geoGetMetricValue(r, metric) }));
  const dataRows = withValues.filter((x) => x.value !== null && Number.isFinite(x.value));
  const noDataCount = withValues.length - dataRows.length;
  if (!dataRows.length) {
    return { metric, highest: null, lowest: null, average: null, dataCount: 0, noDataCount, totalCount: withValues.length };
  }
  const sorted = dataRows.slice().sort((a, b) => b.value - a.value);
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  const average = dataRows.reduce((s, x) => s + x.value, 0) / dataRows.length;
  const labelOf = (r) => r.district || r.city || '未知區域';
  return {
    metric,
    highest: { label: labelOf(highest.row), value: highest.value },
    lowest: { label: labelOf(lowest.row), value: lowest.value },
    average,
    dataCount: dataRows.length,
    noDataCount,
    totalCount: withValues.length,
  };
}

// ════════════════════════════════════════════════════════════════
// 十三、Map 單例 State——共用單一 metric state，不建立多份互相不一致的旗標。
// ════════════════════════════════════════════════════════════════
let geoMapState = {
  instance: null,
  tileLayer: null,
  geoJsonLayer: null,
  metric: 'visitors',
  rows: [],
  featureIndex: null,
  selectedAreaId: null,
  hoveredAreaId: null,
  requestSeq: 0,
  containerId: null,
  leafletLoaded: false,
  geojsonLoaded: false,
  lastError: null,
  // fix18-10-hotfix30-B5-R5.2-B2：商家層級 Geo Map 聚焦設定——單一狀態來源
  // （需求文件十四），初始化／Retry／Tab 返回／Metric 切換／資料刷新全部
  // 讀同一份 snapshot，不建立第二套 filter state。
  settings: null,
  manifest: null,
  boundarySource: null,
  lastViewport: null,
};
// fix18-10-hotfix30-B5-R5.2-B2：跟 geo-intelligence.js 的既有慣例一致
// （_geoExposeWindowState()）——瀏覽器 classic <script> 下，頂層 let 不會
// 自動變成 window 的屬性，這裡明確曝露一次，供其他模組／測試讀取「同一個」
// 物件（不是重新賦值出一個新物件，見下方 _geoResetMapStateForTest() 改成
// 就地清空，不重新指派變數，才能維持 window.geoMapState 這個參考不失效）。
if (typeof window !== 'undefined') window.geoMapState = geoMapState;
function _geoResetMapStateForTest() {
  // 只供測試使用：確保每個測試案例互不干擾（不是 production 使用的重置點）。
  // 就地清空既有物件的屬性，不重新指派 geoMapState 這個變數本身——否則
  // window.geoMapState 會指向舊物件，跟模組內部實際用的新物件不同步。
  Object.assign(geoMapState, {
    instance: null, tileLayer: null, geoJsonLayer: null, metric: 'visitors', rows: [],
    featureIndex: null, selectedAreaId: null, hoveredAreaId: null, requestSeq: 0,
    containerId: null, leafletLoaded: false, geojsonLoaded: false, lastError: null,
    settings: null, manifest: null, boundarySource: null, lastViewport: null,
  });
}

// ════════════════════════════════════════════════════════════════
// 十三、Map 初始化 / 銷毀 / 資料更新
// ════════════════════════════════════════════════════════════════
function _geoRowAreaId(row) {
  return row.area_id || `${row.city || ''}|${row.district || ''}`;
}
function geoInitMap(containerId, rows) {
  if (typeof document === 'undefined') return false; // DOM Safety
  const container = document.getElementById(containerId);
  if (!container) return false;
  if (typeof L === 'undefined') {
    geoMapState.containerId = containerId; // geoHandleMapError 需要先知道容器才能渲染訊息進去
    geoHandleMapError('loading_leaflet');
    return false;
  }
  geoMapState.leafletLoaded = true;
  // 重複呼叫：更新資料，不重建 map（需求文件十三）
  if (geoMapState.instance && geoMapState.containerId === containerId) {
    geoUpdateMapData(rows || geoMapState.rows, geoMapState.metric);
    return true;
  }
  if (geoMapState.instance) geoDestroyMap();
  geoMapState.containerId = containerId;
  geoMapState.instance = L.map(container);
  geoMapState.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  });
  // 需求文件十四、十九：Tile 供應商失敗時，行政區 polygon 仍必須可用，不得
  // 讓整個地圖初始化失敗——外部 tile provider 是不可信賴的外部依賴。
  try {
    geoMapState.tileLayer.addTo(geoMapState.instance);
  } catch (e) {
    // 安靜失敗：不 rethrow，讓後面的 GeoJSON polygon layer 繼續建立。
  }
  _geoBuildGeoJsonLayer();
  geoUpdateMapData(rows || [], geoMapState.metric);
  _geoApplyInitialViewport(rows || []);
  return true;
}
// fix18-10-hotfix30-B5-R5.2-B2（需求文件八）：取代舊版「一律 fitBounds 到
// 載入的 GeoJSON（=桃園）」——改用 geoResolveInitialViewport() 依商家設定
// 的 scope_mode 決定 viewport，資料無效一律落到台灣全域 fallback。
function _geoComputeDataBounds(rows) {
  if (!geoMapState.featureIndex || typeof L === 'undefined' || typeof L.geoJSON !== 'function') return null;
  const feats = [];
  (rows || []).forEach((r) => {
    const f = geoMatchAreaToFeature(r, geoMapState.featureIndex);
    if (f) feats.push(f);
  });
  if (!feats.length) return null;
  try {
    const layer = L.geoJSON({ type: 'FeatureCollection', features: feats });
    const b = layer.getBounds();
    if (!b || typeof b.getSouth !== 'function' || !b.isValid || !b.isValid()) return null;
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  } catch (e) { return null; }
}
function _geoDistrictBoundsFromFeatureIndex() {
  if (!geoMapState.geoJsonLayer || typeof geoMapState.geoJsonLayer.getBounds !== 'function') return null;
  try {
    const b = geoMapState.geoJsonLayer.getBounds();
    if (!b || typeof b.getSouth !== 'function' || !b.isValid || !b.isValid()) return null;
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  } catch (e) { return null; }
}
function _geoApplyInitialViewport(rows) {
  if (!geoMapState.instance) return false;
  const settings = geoMapState.settings || {};
  const loc = settings.store_location || {};
  const scopeMode = settings.scope_mode || 'store_location';
  // fix18-10-hotfix30-B5-R5.2-B2（正確性修正）：只計算目前 scope_mode 真正
  // 需要的那一種 bounds——data_bounds 才需要建立臨時 L.geoJSON() 圖層算
  // bounds，districts 才需要讀 boundary layer 的 bounds。其他模式不建立
  // 用不到的臨時圖層，避免每次 init/更新都多呼叫一次 L.geoJSON()（浪費效能，
  // 也讓依賴呼叫次數判斷生命週期是否正確的邏輯失真）。
  const viewport = geoResolveInitialViewport({
    scopeMode,
    autoFitBounds: settings.auto_fit_bounds !== false,
    customBounds: settings.bounds,
    districtBounds: scopeMode === 'districts' ? _geoDistrictBoundsFromFeatureIndex() : null,
    dataBounds: scopeMode === 'data_bounds' ? _geoComputeDataBounds(rows) : null,
    storeLat: Number(loc.lat), storeLng: Number(loc.lng),
    zoom: Number(settings.default_zoom) || 12,
  });
  try {
    if (viewport.type === 'bounds' && typeof L !== 'undefined' && typeof L.latLngBounds === 'function') {
      const b = L.latLngBounds([viewport.bounds.south, viewport.bounds.west], [viewport.bounds.north, viewport.bounds.east]);
      geoMapState.instance.fitBounds(b);
    } else if (viewport.type === 'center' && typeof geoMapState.instance.setView === 'function') {
      geoMapState.instance.setView(viewport.center, viewport.zoom);
    }
  } catch (e) { /* 安靜失敗，不讓地圖崩潰 */ }
  geoMapState.lastViewport = viewport;
  return true;
}
// 十、行政區互動：click/hover/keyboard 全部在這裡統一綁定，不在多個地方各自
// 重複綁 event（需求文件十）。
function _geoBuildGeoJsonLayer() {
  if (!geoMapState.featureIndex || typeof L === 'undefined' || typeof L.geoJSON !== 'function') return;
  let features = [...geoMapState.featureIndex.byCountyDistrict.values()];
  // 需求文件九：scope_mode=districts 時只 render 商家選取的行政區。
  const settings = geoMapState.settings;
  if (settings && settings.scope_mode === 'districts') {
    features = _geoFilterFeaturesByDistrictCodes(features, settings.district_codes);
  }
  const geojsonLike = { type: 'FeatureCollection', features };
  geoMapState.geoJsonLayer = L.geoJSON(geojsonLike, {
    onEachFeature: (feature, layer) => {
      const props = (feature && feature.properties) || {};
      const areaId = `${props.county || ''}|${props.district || ''}`;
      layer.__geoAreaId = areaId;
      if (typeof layer.on === 'function') {
        layer.on('click', () => geoSelectArea(areaId, { openExplorer: true, focusMap: false, scrollRanking: true, source: 'map' }));
        layer.on('mouseover', () => { geoMapState.hoveredAreaId = areaId; geoUpdateMapData(geoMapState.rows, geoMapState.metric); });
        layer.on('mouseout', () => { geoMapState.hoveredAreaId = null; geoUpdateMapData(geoMapState.rows, geoMapState.metric); });
        // 需求文件二十一：Leaflet SVG path 若無法完整 keyboard 操作，這裡讓
        // 同一個 click handler 也能被 Enter/Space 觸發（真實瀏覽器中 Leaflet
        // 會把 focus 落在 path 上，keydown 由外層 canvas 容器代理處理，見
        // geoHandleMapKeydown()）。
      }
      if (typeof layer.bindTooltip === 'function') {
        layer.bindTooltip(_geoBuildTooltipContent(areaId));
      }
    },
  });
  if (typeof geoMapState.geoJsonLayer.addTo === 'function') geoMapState.geoJsonLayer.addTo(geoMapState.instance);
}
function _geoBuildTooltipContent(areaId) {
  const row = geoMapState.rows.find((r) => _geoRowAreaId(r) === areaId);
  const label = (row && (row.district || row.city)) || areaId.split('|').filter(Boolean).pop() || '未知區域';
  if (!row) return `${escHtml(label)}：${escHtml(geoMapStatusText('no_data_label'))}`;
  const value = geoGetMetricValue(row, geoMapState.metric);
  return `${escHtml(label)}：${escHtml(_geoFormatMetricValue(value, geoMapState.metric))}`;
}
// 需求文件二十一：鍵盤可操作——外層地圖容器代理 Enter/Space，觸發跟滑鼠點擊
// 相同的 geoSelectArea()，不是第二套邏輯。
function geoHandleMapKeydown(event, areaId) {
  if (!event || !areaId) return false;
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    geoSelectArea(areaId, { openExplorer: true, focusMap: false, scrollRanking: true, source: 'keyboard' });
    return true;
  }
  return false;
}
function geoDestroyMap() {
  if (geoMapState.instance && typeof geoMapState.instance.remove === 'function') {
    geoMapState.instance.remove();
  }
  geoMapState.instance = null;
  geoMapState.tileLayer = null;
  geoMapState.geoJsonLayer = null;
  geoMapState.containerId = null;
  return true;
}
// 補上真正缺少的功能（不是測試缺口）：容器尺寸改變時（例如 Drawer 開關、
// window resize、RWD 版面切換）Leaflet 需要呼叫 invalidateSize() 才會正確
// 重新計算畫布尺寸，否則地圖會顯示錯位或空白。DOM Safety：instance 不存在
// 或沒有這個方法時安全回 false，不 throw。
function geoInvalidateMapSize() {
  if (!geoMapState.instance || typeof geoMapState.instance.invalidateSize !== 'function') return false;
  geoMapState.instance.invalidateSize();
  return true;
}
async function geoLoadBoundaryData(settings, manifest) {
  // 需求文件二十：request sequence guard——沿用 geoMapState.requestSeq
  // （state 裡本來就有這個欄位），確保較晚發出但較快完成的請求，不會被
  // 較早發出但較慢完成的請求事後覆蓋（賽跑防護）。
  const seq = (geoMapState.requestSeq += 1);
  // fix18-10-hotfix30-B5-R5.2-B2：settings/manifest 未傳入時沿用 state 裡
  // 目前已有的一份（同一份 snapshot，見需求文件十四），不是重新猜一份。
  if (settings !== undefined) geoMapState.settings = settings;
  if (manifest !== undefined) geoMapState.manifest = manifest;
  const src = geoResolveBoundarySource(geoMapState.settings, geoMapState.manifest);
  geoMapState.boundarySource = src;
  if (!src) {
    // 需求文件七：city_code 沒有對應 manifest → 不載入行政區邊界，不自動
    // fallback 桃園。地圖仍可用 store_location/data_bounds/台灣 fallback
    // 顯示，只是沒有行政區 polygon 可畫。
    if (seq !== geoMapState.requestSeq) return null;
    geoMapState.featureIndex = geoBuildAreaFeatureIndex({ type: 'FeatureCollection', features: [] });
    geoMapState.geojsonLoaded = false;
    return null;
  }
  try {
    const res = await fetch(src);
    if (seq !== geoMapState.requestSeq) return null; // 已被更新的請求取代，不覆蓋
    if (!res || !res.ok) { geoMapState.geojsonLoaded = false; return null; }
    const geojson = await res.json();
    if (seq !== geoMapState.requestSeq) return null;
    geoMapState.featureIndex = geoBuildAreaFeatureIndex(geojson);
    geoMapState.geojsonLoaded = true;
    return geojson;
  } catch (e) {
    if (seq !== geoMapState.requestSeq) return null;
    geoMapState.geojsonLoaded = false;
    return null;
  }
}
// 需求文件十三：設定 API 失敗時使用安全預設（store_location / zoom 12 /
// 台灣 fallback），不得讓設定 API 失敗造成整個地圖消失。manifest 載入失敗
// 一律視為「沒有邊界可用」，不影響地圖本身可否顯示。
const GEO_MAP_SAFE_DEFAULT_SETTINGS = Object.freeze({
  scope_mode: 'store_location', default_zoom: 12,
  store_location: Object.freeze({ lat: null, lng: null }), city_code: null,
  district_codes: Object.freeze([]), bounds: null, geojson_source: null, auto_fit_bounds: true,
});
async function geoFetchMapSettingsAndManifest() {
  let settings = { ...GEO_MAP_SAFE_DEFAULT_SETTINGS };
  try {
    const res = await fetch('/api/settings/geo-map');
    if (res && res.ok) {
      const body = await res.json();
      if (body && body.success && body.data) settings = body.data;
    }
  } catch (e) { /* 安靜退回安全預設，不讓地圖消失 */ }
  let manifest = null;
  try {
    const res2 = await fetch('/data/geo/taiwan/manifest.json');
    if (res2 && res2.ok) manifest = await res2.json();
  } catch (e) { manifest = null; }
  geoMapState.settings = settings;
  geoMapState.manifest = manifest;
  return { settings, manifest };
}
function geoUpdateMapData(rows, metric) {
  geoMapState.rows = Array.isArray(rows) ? rows : [];
  geoMapState.metric = metric || geoMapState.metric;
  if (!geoMapState.instance) return false; // DOM Safety：map 尚未初始化時安全跳過
  const values = geoMapState.rows.map((r) => geoGetMetricValue(r, geoMapState.metric));
  const scale = geoBuildMetricScale(values, geoMapState.metric);
  if (geoMapState.geoJsonLayer && typeof geoMapState.geoJsonLayer.eachLayer === 'function') {
    geoMapState.geoJsonLayer.eachLayer((layer) => {
      const areaId = layer.__geoAreaId;
      const row = geoMapState.rows.find((r) => _geoRowAreaId(r) === areaId);
      const value = row ? geoGetMetricValue(row, geoMapState.metric) : null;
      if (typeof layer.setStyle === 'function') {
        layer.setStyle(geoGetFeatureStyle(value, geoMapState.metric, scale, { selected: areaId === geoMapState.selectedAreaId, hovered: areaId === geoMapState.hoveredAreaId }));
      }
      if (typeof layer.bindTooltip === 'function') layer.bindTooltip(_geoBuildTooltipContent(areaId));
    });
  }
  _geoRenderMapLegendAndSummaryDom(scale);
  _geoRenderAreaListDom();
  return true;
}
// 需求文件二十一：Leaflet SVG path 若無法完整 keyboard 操作，提供同步的
// 可鍵盤操作行政區清單，不是只支援滑鼠。
function _geoRenderAreaListDom() {
  if (typeof document === 'undefined' || !geoMapState.containerId) return;
  const listEl = document.getElementById(`${geoMapState.containerId}-area-list`);
  if (!listEl) return;
  listEl.innerHTML = geoMapState.rows.map((r) => {
    const areaId = _geoRowAreaId(r);
    return `<li><button type="button" tabindex="0" data-geo-map-area-key="${escHtml(areaId)}"
      onclick="geoSelectArea('${escHtml(areaId)}', { openExplorer: true, focusMap: true, scrollRanking: true, source: 'keyboard-list' })"
      onkeydown="geoHandleMapKeydown(event, '${escHtml(areaId)}')">${escHtml(_geoBuildTooltipContent(areaId))}</button></li>`;
  }).join('');
}
function geoSetMapMetric(metric) {
  if (!GEO_MAP_METRICS.includes(metric)) return false;
  geoMapState.metric = metric; // 十三：所有模式共用單一 state
  geoUpdateMapData(geoMapState.rows, metric); // 只重新計算樣式與 Legend，不重建 map
  return true;
}

// ════════════════════════════════════════════════════════════════
// 十一、Area Ranking 雙向同步——單一 helper，不無限互相觸發。
// ════════════════════════════════════════════════════════════════
function geoSelectArea(areaId, options) {
  const opts = options || {};
  geoMapState.selectedAreaId = areaId;
  geoUpdateMapData(geoMapState.rows, geoMapState.metric); // 重新套用 selected 樣式
  if (opts.focusMap !== false) geoFocusArea(areaId);
  if (opts.scrollRanking && typeof document !== 'undefined') {
    const rowEl = document.querySelector(`[data-geo-area-key="${areaId}"]`);
    if (rowEl && typeof rowEl.scrollIntoView === 'function') rowEl.scrollIntoView({ block: 'nearest' });
  }
  if (opts.openExplorer && typeof window !== 'undefined' && typeof window.geoOpenAreaExplorer === 'function') {
    window.geoOpenAreaExplorer(areaId); // 沿用 B1-6A 統一入口，不建第二套 Drawer
  }
  return true;
}
function geoFocusArea(areaId) {
  if (!geoMapState.instance || !geoMapState.featureIndex) return false;
  const row = geoMapState.rows.find((r) => _geoRowAreaId(r) === areaId);
  if (!row) return false;
  const feature = geoMatchAreaToFeature(row, geoMapState.featureIndex);
  if (!feature || !feature.geometry) return false;
  if (typeof geoMapState.instance.fitBounds === 'function' && typeof L !== 'undefined' && typeof L.geoJSON === 'function') {
    try {
      const tempLayer = L.geoJSON(feature);
      if (typeof tempLayer.getBounds === 'function') geoMapState.instance.fitBounds(tempLayer.getBounds());
    } catch (e) { /* 安靜失敗，不讓地圖崩潰 */ }
  }
  return true;
}

// ════════════════════════════════════════════════════════════════
// 十九、Error / Retry
// ════════════════════════════════════════════════════════════════
// message 參數是 GEO_MAP_MESSAGES 的 key（例如 'loading_leaflet'/
// 'loading_boundary'/'error_default'），不是原始中文字串——呼叫端不得再自己
// 拼字串，所有文案一律經 geoBuildMapStatusHtml()/geoMapStatusText() 從
// GEO_MAP_MESSAGES 這一份集中表取用。
function geoHandleMapError(kind) {
  const resolvedKind = GEO_MAP_MESSAGES[kind] ? kind : 'error_default';
  geoMapState.lastError = resolvedKind;
  if (typeof document === 'undefined') return false;
  const el = geoMapState.containerId ? document.getElementById(geoMapState.containerId) : null;
  if (!el) return false;
  el.innerHTML = geoBuildMapStatusHtml(resolvedKind);
  return true;
}
function geoRetryMap() {
  geoMapState.lastError = null;
  if (!geoMapState.containerId) return false;
  const containerId = geoMapState.containerId;
  const rows = geoMapState.rows;
  // geoHandleMapError() 會整個覆蓋容器的 innerHTML（拿掉了真正的 Leaflet DOM），
  // 所以 Retry 不能走 geoInitMap() 「已初始化過，只更新資料」的快速路徑
  // （那條路徑假設容器 DOM 沒被動過，但錯誤畫面已經把它清空重寫過了）——
  // 必須先 destroy 再重新建立一次，才能真正恢復。
  geoDestroyMap();
  return geoInitMap(containerId, rows);
}

// ════════════════════════════════════════════════════════════════
// 六、Dashboard 地圖區塊 render（HTML skeleton）
// ════════════════════════════════════════════════════════════════
function geoRenderMapBlock(containerId) {
  const metricButtons = GEO_MAP_METRICS.map((m) => `<button type="button" class="geo-map-metric-btn" data-geo-map-metric="${escHtml(m)}" aria-pressed="${m === geoMapState.metric}" onclick="geoSetMapMetric('${escHtml(m)}')">${escHtml(GEO_MAP_METRIC_LABELS[m])}</button>`).join('');
  return `<div class="geo-map-root">
    <div class="geo-map-header">
      <div class="geo-map-title">🗺️ Geo Intelligence Map</div>
      <div class="geo-map-subtitle">依行政區檢視營運表現，點擊可開啟區域分析</div>
    </div>
    <div class="geo-map-metrics" role="group" aria-label="地圖指標切換">${metricButtons}</div>
    <div id="${escHtml(containerId)}" class="geo-map-canvas" role="application" aria-label="Geo Intelligence 行政區地圖">${geoBuildMapStatusHtml('loading_default')}</div>
    <div id="${escHtml(containerId)}-legend" class="geo-map-legend" aria-live="polite"></div>
    <div id="${escHtml(containerId)}-summary" class="geo-map-summary" aria-live="polite"></div>
    <ul id="${escHtml(containerId)}-area-list" class="geo-map-area-list" aria-label="行政區清單（鍵盤可操作備援）"></ul>
  </div>`;
}
function _geoRenderMapLegendAndSummaryDom(scale) {
  if (typeof document === 'undefined' || !geoMapState.containerId) return;
  const legendEl = document.getElementById(`${geoMapState.containerId}-legend`);
  const summaryEl = document.getElementById(`${geoMapState.containerId}-summary`);
  if (legendEl) {
    const legend = geoBuildMapLegend(scale, geoMapState.metric);
    legendEl.innerHTML = `<div class="geo-map-legend-title">${escHtml(legend.title)}</div>
      ${legend.items.map((it) => `<span class="geo-map-legend-item"><span class="geo-map-legend-swatch" style="background:${escHtml(it.color)}"></span>${escHtml(it.label)}</span>`).join('')}`;
  }
  if (summaryEl) {
    const summary = geoBuildMapSummary(geoMapState.rows, geoMapState.metric);
    if (!summary.highest) {
      summaryEl.innerHTML = `<div class="geo-map-summary-empty">${escHtml(geoMapStatusText('empty_no_data'))}</div>`;
    } else {
      summaryEl.innerHTML = `<div>最高：${escHtml(summary.highest.label)} ${escHtml(_geoFormatMetricValue(summary.highest.value, geoMapState.metric))}</div>
        <div>最低：${escHtml(summary.lowest.label)} ${escHtml(_geoFormatMetricValue(summary.lowest.value, geoMapState.metric))}</div>
        <div>平均：${escHtml(_geoFormatMetricValue(summary.average, geoMapState.metric))}</div>
        <div>有資料：${escHtml(String(summary.dataCount))} 區・${escHtml(geoMapStatusText('no_data_label'))}：${escHtml(String(summary.noDataCount))} 區</div>`;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_MAP_PALETTE, GEO_MAP_METRICS, GEO_MAP_METRIC_LABELS, GEO_RISK_RANK,
    geoNormalizeAreaName, geoMatchAreaToFeature, geoBuildAreaFeatureIndex,
    geoGetMetricValue, geoClassifyAreaRisk, geoBuildMetricScale, geoGetFeatureStyle,
    geoBuildMapLegend, geoBuildMapSummary, _geoFormatMetricValue,
    geoInitMap, geoDestroyMap, geoInvalidateMapSize, geoLoadBoundaryData, geoUpdateMapData, geoSetMapMetric,
    geoSelectArea, geoFocusArea, geoHandleMapError, geoRetryMap, geoRenderMapBlock,
    geoHandleMapKeydown, _geoBuildTooltipContent, _geoBuildGeoJsonLayer,
    GEO_MAP_MESSAGES, geoMapStatusText, geoBuildMapStatusHtml, geoBuildMapEmptyHtml,
    _geoResetMapStateForTest,
    // fix18-10-hotfix30-B5-R5.2-B2
    GEO_MAP_SCOPE_MODES, GEO_MAP_TAIWAN_FALLBACK_VIEWPORT, GEO_MAP_SAFE_DEFAULT_SETTINGS,
    geoResolveInitialViewport, geoResolveBoundarySource, geoFetchMapSettingsAndManifest,
    _geoFilterFeaturesByDistrictCodes, _geoIsUnsafeSourceUrl, _geoIsValidBoundsObj,
    _geoComputeDataBounds, _geoDistrictBoundsFromFeatureIndex, _geoApplyInitialViewport,
    get geoMapState() { return geoMapState; },
  };
}
