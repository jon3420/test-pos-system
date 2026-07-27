'use strict';
// fix18-10-hotfix30-B5-R5.2-B3 — Geo Intelligence 地圖設定 UI（後台設定中心）
//
// 這個檔案只做「UI／設定流程／Preview／Validation」，完全不重新設計、不複製
// R5.2-B2 的 Geo Map Core 邏輯：viewport 與 boundary source 一律直接呼叫
// geo-intelligence-map.js 既有的 pure function（geoResolveInitialViewport()／
// geoResolveBoundarySource()／_geoFilterFeaturesByDistrictCodes()），因為
// classic <script> 彼此共用同一個全域作用域（跟 geo-intelligence.js 呼叫
// geo-intelligence-map.js 的既有慣例一致），本檔案必須排在它之後載入。
//
// 命名空間：所有 top-level 識別字一律加 geoMapSettings 前綴（state/函式），
// 避免跟 Core 的 geoMapState／GEO_MAP_SCOPE_MODES／geoInitMap 等同名衝突。
// 本檔案「讀」Core 的常數（GEO_MAP_SCOPE_MODES／GEO_MAP_TAIWAN_FALLBACK_VIEWPORT）
// 與函式，但不宣告任何同名的 top-level const/let/function。

// ════════════════════════════════════════════════════════════════
// 一、狀態（單一 state，不建立第二套 filter state）
// ════════════════════════════════════════════════════════════════
let geoMapSettingsState = {
  initialized: false,      // Preview Leaflet 是否已建立（避免重複 init）
  loaded: false,           // 設定是否已成功從後端載入過至少一次
  loadError: null,         // 載入失敗時的錯誤訊息（不自動寫入錯誤預設值，見需求文件四）
  saving: false,
  manifest: null,          // /data/geo/taiwan/manifest.json
  districtFeaturesByCity: {}, // cityCode -> features[]（cache，避免重複 fetch 同一份 GeoJSON）
  originalStoreLocation: { lat: null, lng: null }, // 上次成功載入/儲存時的店家座標（供「重新載入」比對/還原）
  form: {
    scope_mode: 'store_location',
    default_zoom: 12,
    store_lat: null,
    store_lng: null,
    city_code: null,
    district_codes: [],
    bounds: null,
    auto_fit_bounds: true,
  },
  errors: {}, // fieldKey -> message；非空代表該欄位目前不合法
  preview: {
    instance: null,
    tileLayer: null,
    boundaryLayer: null,
    containerId: 'geo-settings-preview-map',
    boundaryCache: {}, // source URL -> geojson（避免同一份 GeoJSON 被重複 fetch）
    lastBoundarySource: null,
    firstViewportApplied: false, // loading overlay 只在第一次成功套用 viewport 後隱藏一次
  },
};

// 需求文件二：後端 GEO_MAP_DEFAULTS 的 UI 端對應值（只用於「還原系統預設」——
// 純粹的 UI 常數，不是重新實作 Core 驗證/決策邏輯，實際驗證仍以後端為準）。
const GEO_MAP_SETTINGS_UI_DEFAULTS = Object.freeze({
  scope_mode: 'store_location',
  default_zoom: 12,
  city_code: null,
  district_codes: Object.freeze([]),
  bounds: null,
  auto_fit_bounds: true,
});

// 需求文件（跟 Core 同一套 classic <script> 全域作用域慣例）：let 在瀏覽器
// 分頁間共用同一個「全域詞法環境」，但不會自動變成 window 的屬性——外部程式
// （例如 switchSettingsTab() 的 hook、smoke test）若要用 window.geoMapSettingsState
// 存取，需要像 Core 的 geoMapState 一樣明確指派一次（物件參照不變，之後都是
// 就地修改屬性，不重新指派整個變數，所以只需要指派一次）。
if (typeof window !== 'undefined') window.geoMapSettingsState = geoMapSettingsState;

// ════════════════════════════════════════════════════════════════
// 二、Debounce（Input／Slider／行政區 checkbox 改變時節流；Radio mode 切換立即）
// ════════════════════════════════════════════════════════════════
function _geoMapSettingsDebounce(fn, ms) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(null, args); }, ms);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; } fn.apply(null, args); };
  return wrapped;
}
const _geoMapSettingsDebouncedRefresh = _geoMapSettingsDebounce(() => {
  geoMapSettingsRunValidation();
  geoMapSettingsRefreshPreview();
}, 250);

// ════════════════════════════════════════════════════════════════
// 三、Tab 入口／初始化（第一次進入才 GET，重複進入不重複 fetch／不重複 init Leaflet）
// ════════════════════════════════════════════════════════════════
function geoMapSettingsInit() {
  if (!geoMapSettingsState.loaded && !geoMapSettingsState.loadError) {
    geoMapSettingsLoad();
  } else if (geoMapSettingsState.preview.instance) {
    // 需求文件七：Tab 顯示後呼叫 invalidateSize()（處理容器先前不可見造成的尺寸錯誤）。
    geoMapSettingsInvalidatePreviewSize();
  }
}

function geoMapSettingsInvalidatePreviewSize() {
  const inst = geoMapSettingsState.preview.instance;
  if (inst && typeof inst.invalidateSize === 'function') {
    // 已知 Leaflet 問題：容器剛從 display:none 變成可見時，若在「同一個 tick」內立刻
    // invalidateSize()，瀏覽器可能還沒真正完成 reflow，量到的仍是舊尺寸（0 或截斷），
    // 導致 tile 計算錯誤、世界地圖水平重複或大片灰色未渲染區。標準修法是延後一個
    // tick（setTimeout 0）再量測，讓瀏覽器先完成 layout。這是 B3 Preview 自己的
    // lifecycle 邏輯，不動 Core 的 geoInitMap()。
    try { inst.invalidateSize(); } catch (e) { /* 安靜失敗 */ }
    setTimeout(() => { try { inst.invalidateSize(); } catch (e) { /* 安靜失敗 */ } }, 0);
  }
}

// ════════════════════════════════════════════════════════════════
// 四、設定載入（GET /api/settings/geo-map + manifest）
// ════════════════════════════════════════════════════════════════
async function geoMapSettingsLoad() {
  geoMapSettingsSetLoadError(null);
  try {
    // fix18-10-hotfix30-B5-R5.2-B3-hotfix1（Root Cause 修正）：/api/settings/geo-map
    // 掛在 requireStore 底下（server.js: app.use('/api/settings', requireStore, ...)），
    // 需要 Authorization Bearer JWT 或 x-store-id header 其中之一，否則 requireStore
    // 回 401 NO_STORE_TOKEN。裸 fetch() 完全不會帶這些 header，這正是先前 401 的
    // root cause。完全沿用既有 apiFetch()（app.js）——跟 saveStoreLocationSettings()
    // 等既有程式碼相同的授權流程，不自行發明第二套授權。
    const res = await apiFetch('/api/settings/geo-map');
    if (!res || !res.ok) {
      geoMapSettingsSetLoadError('設定載入失敗，請稍後重試');
      return false;
    }
    const body = await res.json();
    if (!body || !body.success || !body.data) {
      geoMapSettingsSetLoadError('設定載入失敗，請稍後重試');
      return false;
    }
    const data = body.data;
    geoMapSettingsState.form = {
      scope_mode: GEO_MAP_SCOPE_MODES.includes(data.scope_mode) ? data.scope_mode : 'store_location',
      default_zoom: Number.isFinite(Number(data.default_zoom)) ? Number(data.default_zoom) : 12,
      store_lat: (data.store_location && Number.isFinite(Number(data.store_location.lat))) ? Number(data.store_location.lat) : null,
      store_lng: (data.store_location && Number.isFinite(Number(data.store_location.lng))) ? Number(data.store_location.lng) : null,
      city_code: data.city_code || null,
      district_codes: Array.isArray(data.district_codes) ? data.district_codes.slice() : [],
      bounds: data.bounds || null,
      auto_fit_bounds: data.auto_fit_bounds !== false,
    };
    geoMapSettingsState.originalStoreLocation = { lat: geoMapSettingsState.form.store_lat, lng: geoMapSettingsState.form.store_lng };
    geoMapSettingsState.loaded = true;
    geoMapSettingsSetLoadError(null);
  } catch (e) {
    geoMapSettingsSetLoadError('設定載入失敗，請稍後重試');
    return false;
  }

  // manifest 失敗不擋設定本身可用——只影響「行政區」模式的縣市/行政區清單。
  try {
    const res2 = await fetch('/data/geo/taiwan/manifest.json');
    if (res2 && res2.ok) geoMapSettingsState.manifest = await res2.json();
  } catch (e) { geoMapSettingsState.manifest = null; }

  geoMapSettingsPopulateForm();
  geoMapSettingsRenderCityOptions();
  if (geoMapSettingsState.form.city_code) await geoMapSettingsLoadDistrictsForCity(geoMapSettingsState.form.city_code);
  geoMapSettingsUpdateVisibility();
  geoMapSettingsRunValidation();
  geoMapSettingsInitPreviewMap();
  geoMapSettingsRefreshPreview();
  return true;
}

function geoMapSettingsSetLoadError(msg) {
  geoMapSettingsState.loadError = msg;
  const el = document.getElementById('geo-settings-load-error');
  if (msg) {
    // 需求文件四：API 失敗時顯示錯誤提示，不得造成頁面崩潰，不得自動寫入錯誤預設值。
    if (!el) {
      const panel = document.getElementById('stab-geo_map');
      if (panel) {
        const banner = document.createElement('p');
        banner.id = 'geo-settings-load-error';
        banner.className = 'settings-hint geo-settings-error';
        banner.setAttribute('role', 'alert');
        banner.textContent = msg;
        panel.insertBefore(banner, panel.firstChild);
      }
    } else {
      el.textContent = msg;
      el.style.display = '';
    }
    const saveBtn = document.getElementById('geo-settings-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    // 需求文件六：不得讓 loading overlay 永遠卡住顯示「地圖載入中…」——設定載入
    // 失敗時 Preview 本來就沒有資料可畫，把文字改成誠實反映「載入失敗」，而不是
    // 留著一個永遠不會消失、卻謊稱「還在載入」的訊息。
    const previewLoading = document.getElementById('geo-settings-preview-loading');
    if (previewLoading && !geoMapSettingsState.preview.firstViewportApplied) {
      previewLoading.textContent = '設定載入失敗，暫無法顯示預覽';
    }
  } else if (el) {
    el.style.display = 'none';
  }
}

// ════════════════════════════════════════════════════════════════
// 五、表單填入／模式切換／可見區塊
// ════════════════════════════════════════════════════════════════
function geoMapSettingsPopulateForm() {
  const f = geoMapSettingsState.form;
  const radio = document.getElementById('geo-scope-' + f.scope_mode);
  if (radio) radio.checked = true;
  const zoomEl = document.getElementById('geo-settings-zoom');
  if (zoomEl) zoomEl.value = String(f.default_zoom);
  const zoomValEl = document.getElementById('geo-settings-zoom-value');
  if (zoomValEl) zoomValEl.textContent = String(f.default_zoom);
  const latEl = document.getElementById('geo-settings-lat');
  if (latEl) latEl.value = f.store_lat === null ? '' : String(f.store_lat);
  const lngEl = document.getElementById('geo-settings-lng');
  if (lngEl) lngEl.value = f.store_lng === null ? '' : String(f.store_lng);
  const cityEl = document.getElementById('geo-settings-city');
  if (cityEl && f.city_code) cityEl.value = f.city_code;
  const autoFitEl = document.getElementById('geo-settings-auto-fit-bounds');
  if (autoFitEl) autoFitEl.checked = f.auto_fit_bounds !== false;
  const b = f.bounds || {};
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v === undefined || v === null) ? '' : String(v); };
  setVal('geo-settings-bounds-south', b.south);
  setVal('geo-settings-bounds-west', b.west);
  setVal('geo-settings-bounds-north', b.north);
  setVal('geo-settings-bounds-east', b.east);
}

function geoMapSettingsUpdateVisibility() {
  const mode = geoMapSettingsState.form.scope_mode;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('geo-settings-store-location-block', mode === 'store_location');
  show('geo-settings-districts-block', mode === 'districts');
  show('geo-settings-bounds-block', mode === 'custom_bounds');
  show('geo-settings-data-bounds-hint', mode === 'data_bounds');
}

function geoMapSettingsOnScopeModeChange() {
  const checked = document.querySelector('input[name="geo_map_scope_mode"]:checked');
  if (checked) geoMapSettingsState.form.scope_mode = checked.value;
  geoMapSettingsUpdateVisibility();
  // Radio mode 切換：立即套用，不 debounce（需求文件八）。
  geoMapSettingsRunValidation();
  geoMapSettingsRefreshPreview();
}

function geoMapSettingsOnZoomChange() {
  const el = document.getElementById('geo-settings-zoom');
  const val = el ? el.value : '12';
  const valEl = document.getElementById('geo-settings-zoom-value');
  if (valEl) valEl.textContent = String(val); // 顯示文字立即更新
  geoMapSettingsState.form.default_zoom = Number(val);
  _geoMapSettingsDebouncedRefresh(); // 預覽/驗證 debounce（需求文件八）
}

function geoMapSettingsOnLatLngChange() {
  const lat = document.getElementById('geo-settings-lat')?.value;
  const lng = document.getElementById('geo-settings-lng')?.value;
  geoMapSettingsState.form.store_lat = (lat === '' || lat === undefined) ? null : Number(lat);
  geoMapSettingsState.form.store_lng = (lng === '' || lng === undefined) ? null : Number(lng);
  _geoMapSettingsDebouncedRefresh();
}

function geoMapSettingsOnBoundsChange() {
  const g = (id) => document.getElementById(id)?.value;
  const south = g('geo-settings-bounds-south');
  const west = g('geo-settings-bounds-west');
  const north = g('geo-settings-bounds-north');
  const east = g('geo-settings-bounds-east');
  const anyFilled = [south, west, north, east].some((v) => v !== '' && v !== undefined);
  geoMapSettingsState.form.bounds = anyFilled
    ? { south: Number(south), west: Number(west), north: Number(north), east: Number(east) }
    : null;
  _geoMapSettingsDebouncedRefresh();
}

function geoMapSettingsOnAutoFitChange() {
  const el = document.getElementById('geo-settings-auto-fit-bounds');
  geoMapSettingsState.form.auto_fit_bounds = !!(el && el.checked);
  geoMapSettingsRunValidation();
  geoMapSettingsRefreshPreview();
}

// ════════════════════════════════════════════════════════════════
// 六、行政區來源（一律來自 manifest／對應 GeoJSON properties，不 hardcode 桃園 13 區）
// ════════════════════════════════════════════════════════════════
function geoMapSettingsRenderCityOptions() {
  const sel = document.getElementById('geo-settings-city');
  if (!sel) return;
  const cities = (geoMapSettingsState.manifest && geoMapSettingsState.manifest.cities) || {};
  const codes = Object.keys(cities);
  sel.innerHTML = codes.map((code) => `<option value="${escGeoMapSettingsHtml(code)}">${escGeoMapSettingsHtml(cities[code].name || code)}</option>`).join('');
  if (geoMapSettingsState.form.city_code && codes.includes(geoMapSettingsState.form.city_code)) {
    sel.value = geoMapSettingsState.form.city_code;
  } else if (codes.length) {
    // 需求文件三：目前只有部分縣市——不假裝已支援全台，UI 只列出目前 manifest 實際有的縣市。
    geoMapSettingsState.form.city_code = codes[0];
  }
  const coverageEl = document.getElementById('geo-settings-manifest-coverage-hint');
  if (coverageEl) {
    coverageEl.textContent = codes.length
      ? `目前系統已提供的行政區邊界：${codes.map((c) => cities[c].name || c).join('、')}（其餘縣市尚未提供，會持續擴充）`
      : '目前系統尚未提供任何縣市的行政區邊界資料';
  }
}

async function geoMapSettingsOnCityChange() {
  const sel = document.getElementById('geo-settings-city');
  const code = sel ? sel.value : null;
  geoMapSettingsState.form.city_code = code || null;
  geoMapSettingsState.form.district_codes = []; // 換縣市時清空已選行政區（避免帶著另一個縣市的代碼送出）
  await geoMapSettingsLoadDistrictsForCity(code);
  geoMapSettingsRunValidation();
  geoMapSettingsRefreshPreview();
}

async function geoMapSettingsLoadDistrictsForCity(cityCode) {
  if (!cityCode) { geoMapSettingsRenderDistrictCheckboxes([]); return; }
  if (geoMapSettingsState.districtFeaturesByCity[cityCode]) {
    geoMapSettingsRenderDistrictCheckboxes(geoMapSettingsState.districtFeaturesByCity[cityCode]);
    return;
  }
  const src = geoResolveBoundarySource({ city_code: cityCode }, geoMapSettingsState.manifest); // 沿用 Core 的安全查表規則
  if (!src) { geoMapSettingsRenderDistrictCheckboxes([]); return; }
  try {
    const res = await fetch(src);
    if (!res || !res.ok) { geoMapSettingsRenderDistrictCheckboxes([]); return; }
    const geojson = await res.json();
    const features = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
    geoMapSettingsState.districtFeaturesByCity[cityCode] = features;
    geoMapSettingsRenderDistrictCheckboxes(features);
  } catch (e) {
    geoMapSettingsRenderDistrictCheckboxes([]);
  }
}

function geoMapSettingsRenderDistrictCheckboxes(features) {
  const list = document.getElementById('geo-settings-district-list');
  if (!list) return;
  const selected = new Set(geoMapSettingsState.form.district_codes || []);
  list.innerHTML = (features || []).map((f) => {
    const code = f.properties && f.properties.district_code;
    const name = (f.properties && f.properties.district) || code;
    if (!code) return '';
    const checked = selected.has(code) ? 'checked' : '';
    const id = 'geo-settings-district-' + escGeoMapSettingsHtml(code);
    return `<label class="geo-settings-district-item" for="${id}">
      <input type="checkbox" id="${id}" value="${escGeoMapSettingsHtml(code)}" ${checked} onchange="geoMapSettingsToggleDistrict('${escGeoMapSettingsHtml(code)}')">
      <span>${escGeoMapSettingsHtml(name)}</span>
    </label>`;
  }).join('');
}

function geoMapSettingsToggleDistrict(code) {
  const cur = new Set(geoMapSettingsState.form.district_codes || []);
  if (cur.has(code)) cur.delete(code); else cur.add(code);
  geoMapSettingsState.form.district_codes = [...cur];
  _geoMapSettingsDebouncedRefresh(); // 需求文件八：district checkbox 改變 debounce
}

function escGeoMapSettingsHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════
// 七、驗證（Client 端與後端 utils/geoMapScope.js 規則一致，即時顯示、不等按儲存）
// ════════════════════════════════════════════════════════════════
function geoMapSettingsValidateZoom(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z) || z < 5 || z > 18) return { ok: false, message: '縮放層級必須介於 5~18' };
  return { ok: true };
}
function geoMapSettingsValidateLat(lat) {
  if (lat === null || lat === undefined || lat === '') return { ok: true };
  const n = Number(lat);
  if (!Number.isFinite(n) || n < -90 || n > 90) return { ok: false, message: 'Latitude 必須介於 -90~90' };
  return { ok: true };
}
function geoMapSettingsValidateLng(lng) {
  if (lng === null || lng === undefined || lng === '') return { ok: true };
  const n = Number(lng);
  if (!Number.isFinite(n) || n < -180 || n > 180) return { ok: false, message: 'Longitude 必須介於 -180~180' };
  return { ok: true };
}
function geoMapSettingsValidateBoundsFields(bounds) {
  if (!bounds) return { ok: true };
  const { south, west, north, east } = bounds;
  for (const [k, v] of Object.entries({ south, west, north, east })) {
    if (!Number.isFinite(Number(v))) return { ok: false, message: `${k} 必須是數字` };
  }
  if (Number(south) < -90 || Number(north) > 90) return { ok: false, message: '緯度必須介於 -90~90' };
  if (Number(west) < -180 || Number(east) > 180) return { ok: false, message: '經度必須介於 -180~180' };
  if (!(Number(south) < Number(north))) return { ok: false, message: 'south 必須小於 north' };
  if (!(Number(west) < Number(east))) return { ok: false, message: 'west 必須小於 east' };
  return { ok: true };
}
function geoMapSettingsValidateDistrictSelection(opts) {
  const o = opts || {};
  const manifest = o.manifest || {};
  const cities = manifest.cities || {};
  if (!o.cityCode || !cities[o.cityCode]) return { ok: false, message: '請選擇有效的縣市（必須存在於系統 manifest 內）' };
  const codes = Array.isArray(o.districtCodes) ? o.districtCodes : [];
  if (!codes.length) return { ok: false, message: '行政區模式請至少選擇一個行政區' };
  const validCodes = new Set((o.validCodesForCity || []).map(String));
  const invalid = codes.filter((c) => !validCodes.has(String(c)));
  if (invalid.length) return { ok: false, message: `以下行政區代碼不屬於所選縣市：${invalid.join('、')}` };
  return { ok: true };
}

function geoMapSettingsRunValidation() {
  const f = geoMapSettingsState.form;
  const errs = {};

  const zoomCheck = geoMapSettingsValidateZoom(f.default_zoom);
  if (!zoomCheck.ok) errs.zoom = zoomCheck.message;

  if (f.scope_mode === 'store_location') {
    const latCheck = geoMapSettingsValidateLat(f.store_lat);
    if (!latCheck.ok) errs.lat = latCheck.message;
    const lngCheck = geoMapSettingsValidateLng(f.store_lng);
    if (!lngCheck.ok) errs.lng = lngCheck.message;
  }

  if (f.scope_mode === 'custom_bounds') {
    const boundsCheck = geoMapSettingsValidateBoundsFields(f.bounds);
    if (!boundsCheck.ok) errs.bounds = boundsCheck.message;
  }

  if (f.scope_mode === 'districts') {
    const validCodesForCity = (geoMapSettingsState.districtFeaturesByCity[f.city_code] || [])
      .map((feat) => feat.properties && feat.properties.district_code)
      .filter(Boolean);
    const districtCheck = geoMapSettingsValidateDistrictSelection({
      cityCode: f.city_code, districtCodes: f.district_codes, manifest: geoMapSettingsState.manifest, validCodesForCity,
    });
    if (!districtCheck.ok) errs.district = districtCheck.message;
  }

  geoMapSettingsState.errors = errs;
  geoMapSettingsRenderErrors(errs);
  const valid = Object.keys(errs).length === 0;
  const saveBtn = document.getElementById('geo-settings-save-btn');
  if (saveBtn) saveBtn.disabled = !valid || !!geoMapSettingsState.loadError;
  return valid;
}

function geoMapSettingsRenderErrors(errs) {
  const map = {
    zoom: 'geo-settings-zoom-error',
    lat: 'geo-settings-lat-error',
    lng: 'geo-settings-lng-error',
    bounds: 'geo-settings-bounds-error',
    district: 'geo-settings-district-error',
  };
  Object.entries(map).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (errs[key]) { el.textContent = errs[key]; el.style.display = ''; }
    else { el.textContent = ''; el.style.display = 'none'; }
  });
}

// ════════════════════════════════════════════════════════════════
// 八、Preview（只建立一次 Leaflet instance，之後只更新 viewport/layer；
//     不得每次 input change 都重新 L.map()；無 boundary 時用台灣 fallback，
//     不得 fallback 桃園——viewport/boundary 決策全部委派給 Core 的
//     geoResolveInitialViewport()/geoResolveBoundarySource()）
// ════════════════════════════════════════════════════════════════
function geoMapSettingsInitPreviewMap() {
  const p = geoMapSettingsState.preview;
  if (p.instance) { geoMapSettingsInvalidatePreviewSize(); return; } // 已初始化，不重建
  if (typeof L === 'undefined' || typeof L.map !== 'function') return; // Leaflet 尚未載入，安靜跳過
  const container = document.getElementById(p.containerId);
  if (!container) return;
  try {
    p.instance = L.map(p.containerId, { attributionControl: false });
    // noWrap:true — 防禦性設定，避免極端情況（container 異常寬／zoom 異常低）下
    // Leaflet 把世界地圖水平重複平鋪（需求文件六點名的視覺風險），在合法 zoom
    // 範圍（5~18）下沒有任何副作用，純粹是安全網。只加在 B3 自己的 Preview，不動
    // Core 既有的 geoInitMap() tileLayer 設定。
    p.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, noWrap: true }).addTo(p.instance);
    p.instance.setView(GEO_MAP_TAIWAN_FALLBACK_VIEWPORT.center, GEO_MAP_TAIWAN_FALLBACK_VIEWPORT.zoom); // 建立時先給一個合法 view，避免 Leaflet 對未 setView 的地圖操作出錯
    geoMapSettingsInvalidatePreviewSize();
  } catch (e) { /* 安靜失敗，不讓 Settings 頁面崩潰 */ }
}

async function geoMapSettingsApplyPreviewBoundary() {
  const p = geoMapSettingsState.preview;
  if (!p.instance) return;
  const f = geoMapSettingsState.form;
  const src = geoResolveBoundarySource({ city_code: f.city_code }, geoMapSettingsState.manifest);
  if (!src) {
    if (p.boundaryLayer) { try { p.instance.removeLayer(p.boundaryLayer); } catch (e) {} p.boundaryLayer = null; }
    p.lastBoundarySource = null;
    return;
  }
  let geojson = p.boundaryCache[src];
  if (!geojson) {
    try {
      const res = await fetch(src);
      if (!res || !res.ok) return;
      geojson = await res.json();
      p.boundaryCache[src] = geojson;
    } catch (e) { return; }
  }
  let features = (geojson && geojson.features) || [];
  if (f.scope_mode === 'districts') features = _geoFilterFeaturesByDistrictCodes(features, f.district_codes);
  if (p.boundaryLayer) { try { p.instance.removeLayer(p.boundaryLayer); } catch (e) {} p.boundaryLayer = null; }
  if (typeof L !== 'undefined' && typeof L.geoJSON === 'function') {
    try { p.boundaryLayer = L.geoJSON({ type: 'FeatureCollection', features }).addTo(p.instance); } catch (e) { p.boundaryLayer = null; }
  }
  p.lastBoundarySource = src;
}

function _geoMapSettingsBoundsFromLayer(layer) {
  if (!layer || typeof layer.getBounds !== 'function') return null;
  try {
    const b = layer.getBounds();
    if (!b || typeof b.getSouth !== 'function' || (typeof b.isValid === 'function' && !b.isValid())) return null;
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  } catch (e) { return null; }
}

function geoMapSettingsApplyPreviewViewport() {
  const p = geoMapSettingsState.preview;
  if (!p.instance) return;
  const f = geoMapSettingsState.form;
  const viewport = geoResolveInitialViewport({
    scopeMode: f.scope_mode,
    autoFitBounds: f.auto_fit_bounds !== false,
    customBounds: f.bounds,
    districtBounds: _geoMapSettingsBoundsFromLayer(p.boundaryLayer),
    dataBounds: null, // Settings Preview 不掛真實分析資料查詢，data_bounds 模式在這裡一律走台灣 fallback 顯示說明文字（見下方狀態文字）
    storeLat: Number(f.store_lat), storeLng: Number(f.store_lng),
    zoom: Number(f.default_zoom) || 12,
  });
  try {
    if (viewport.type === 'bounds' && typeof L !== 'undefined' && typeof L.latLngBounds === 'function') {
      p.instance.fitBounds(L.latLngBounds([viewport.bounds.south, viewport.bounds.west], [viewport.bounds.north, viewport.bounds.east]));
    } else if (viewport.type === 'center') {
      p.instance.setView(viewport.center, viewport.zoom);
    }
  } catch (e) { /* 安靜失敗 */ }
  geoMapSettingsUpdatePreviewStatusText(viewport);
  if (!p.firstViewportApplied) {
    p.firstViewportApplied = true;
    const loading = document.getElementById('geo-settings-preview-loading');
    if (loading) loading.classList.add('geo-settings-hidden'); // loading overlay 只隱藏一次，不再重新顯示
  }
}

function geoMapSettingsUpdatePreviewStatusText(viewport) {
  const el = document.getElementById('geo-settings-preview-status');
  if (!el) return;
  const labels = { store_location: '店家位置', districts: '行政區', custom_bounds: '自訂範圍', data_bounds: '依分析資料', taiwan_fallback: '台灣全域（fallback）' };
  const sourceLabel = labels[viewport.source] || viewport.source;
  el.textContent = viewport.type === 'bounds'
    ? `目前預覽範圍來源：${sourceLabel}`
    : `目前預覽中心：${viewport.center[0].toFixed(4)}, ${viewport.center[1].toFixed(4)}（縮放 ${viewport.zoom}）— 來源：${sourceLabel}`;
}

async function geoMapSettingsRefreshPreview() {
  if (!geoMapSettingsState.preview.instance) geoMapSettingsInitPreviewMap();
  await geoMapSettingsApplyPreviewBoundary();
  geoMapSettingsApplyPreviewViewport();
}

function geoMapSettingsApplyCurrentPreviewToBounds() {
  const p = geoMapSettingsState.preview;
  if (!p.instance || typeof p.instance.getBounds !== 'function') return;
  try {
    const b = p.instance.getBounds();
    const south = b.getSouth(), west = b.getWest(), north = b.getNorth(), east = b.getEast();
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(6); };
    setVal('geo-settings-bounds-south', south);
    setVal('geo-settings-bounds-west', west);
    setVal('geo-settings-bounds-north', north);
    setVal('geo-settings-bounds-east', east);
    geoMapSettingsState.form.bounds = { south, west, north, east };
    _geoMapSettingsDebouncedRefresh.cancel();
    geoMapSettingsRunValidation();
    geoMapSettingsRefreshPreview(); // 「套用目前預覽範圍」是明確的按鈕動作，立即套用，不 debounce
  } catch (e) { /* 安靜失敗 */ }
}

// ════════════════════════════════════════════════════════════════
// 九、定位（reuse 既有 _geolocateFriendly()，不重新寫 geolocation 邏輯；
//     不自動取得定位，必須使用者主動點擊）
// ════════════════════════════════════════════════════════════════
function geoMapSettingsUseCurrentLocation() {
  const statusEl = document.getElementById('geo-settings-location-status');
  if (statusEl) { statusEl.textContent = '定位中…'; statusEl.style.color = ''; }
  if (typeof _geolocateFriendly !== 'function') {
    if (statusEl) { statusEl.textContent = '❌ 定位功能目前無法使用'; statusEl.style.color = '#e53935'; }
    return;
  }
  _geolocateFriendly(
    (lat, lng) => {
      const latEl = document.getElementById('geo-settings-lat');
      const lngEl = document.getElementById('geo-settings-lng');
      if (latEl) latEl.value = lat;
      if (lngEl) lngEl.value = lng;
      geoMapSettingsState.form.store_lat = lat;
      geoMapSettingsState.form.store_lng = lng;
      geoMapSettingsRunValidation();
      geoMapSettingsRefreshPreview();
      if (statusEl) { statusEl.textContent = `✅ 已取得目前位置（${lat}, ${lng}），請按下方「儲存設定」`; statusEl.style.color = '#2e7d32'; }
    },
    (msg) => { if (statusEl) { statusEl.textContent = '❌ ' + msg; statusEl.style.color = '#e53935'; } }
  );
}

// ════════════════════════════════════════════════════════════════
// 十、儲存／重新載入／還原系統預設
// ════════════════════════════════════════════════════════════════
async function geoMapSettingsSave() {
  const valid = geoMapSettingsRunValidation();
  if (!valid) {
    if (typeof showToast === 'function') showToast('❌ 請先修正欄位錯誤再儲存', 'error');
    return false;
  }
  const f = geoMapSettingsState.form;
  geoMapSettingsState.saving = true;
  try {
    const patchBody = {
      geo_map_scope_mode: f.scope_mode,
      geo_map_default_zoom: f.default_zoom,
      geo_map_city_code: f.city_code || '',
      geo_map_district_codes: f.district_codes || [],
      geo_map_bounds: f.bounds || null,
      geo_map_auto_fit_bounds: f.auto_fit_bounds ? '1' : '0',
    };
    // fix18-10-hotfix30-B5-R5.2-B3-hotfix1（Root Cause 修正）：改用既有 apiFetch()，
    // 理由同上（GET 那處的註解）——完全沿用 saveStoreLocationSettings() 的既有授權
    // 流程，不自行發明第二套。apiFetch() 內部已經會設定 Content-Type header，不需
    // 再手動指定一次。
    const res = await apiFetch('/api/settings/geo-map', {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      if (typeof showToast === 'function') showToast('❌ 儲存失敗：' + (json.message || ''), 'error');
      return false; // 需求文件十：失敗不清空表單，不覆蓋使用者輸入
    }

    // store_location 座標若有效且改變過，透過既有 PATCH /api/settings/store-location 儲存
    // （沿用既有 API，不在 Geo Map Core 或 geo-map 白名單內另外處理 store_lat/store_lng）。
    if (Number.isFinite(f.store_lat) && Number.isFinite(f.store_lng)
      && (f.store_lat !== geoMapSettingsState.originalStoreLocation.lat || f.store_lng !== geoMapSettingsState.originalStoreLocation.lng)) {
      try {
        await apiFetch('/api/settings/store-location', {
          method: 'PATCH',
          body: JSON.stringify({ store_lat: f.store_lat, store_lng: f.store_lng }),
        });
        geoMapSettingsState.originalStoreLocation = { lat: f.store_lat, lng: f.store_lng };
      } catch (e) { /* 店家座標另存失敗不影響 geo-map 本身已儲存成功 */ }
    }

    if (typeof showToast === 'function') showToast('✅ Geo 地圖設定已儲存', 'success');
    geoMapSettingsRefreshPreview(); // Preview 維持目前設定（需求文件十）
    return true;
  } catch (e) {
    if (typeof showToast === 'function') showToast('❌ ' + e.message, 'error');
    return false;
  } finally {
    geoMapSettingsState.saving = false;
  }
}

// 「重新載入已儲存設定」：重新 GET，恢復已儲存值（不是重新整理整頁）。
async function geoMapSettingsReload() {
  await geoMapSettingsLoad();
  if (typeof showToast === 'function' && !geoMapSettingsState.loadError) showToast('已重新載入已儲存設定', 'info');
}

// 「還原系統預設」：只重設表單為預設值，不立即 PATCH——必須使用者再按「儲存設定」。
function geoMapSettingsRestoreDefaults() {
  geoMapSettingsState.form.scope_mode = GEO_MAP_SETTINGS_UI_DEFAULTS.scope_mode;
  geoMapSettingsState.form.default_zoom = GEO_MAP_SETTINGS_UI_DEFAULTS.default_zoom;
  geoMapSettingsState.form.city_code = GEO_MAP_SETTINGS_UI_DEFAULTS.city_code;
  geoMapSettingsState.form.district_codes = GEO_MAP_SETTINGS_UI_DEFAULTS.district_codes.slice();
  geoMapSettingsState.form.bounds = GEO_MAP_SETTINGS_UI_DEFAULTS.bounds;
  geoMapSettingsState.form.auto_fit_bounds = GEO_MAP_SETTINGS_UI_DEFAULTS.auto_fit_bounds;
  // store_lat/store_lng 是既有店家座標，不屬於 geo_map 預設值範圍，還原系統預設不動它。
  geoMapSettingsPopulateForm();
  geoMapSettingsRenderDistrictCheckboxes(geoMapSettingsState.districtFeaturesByCity[geoMapSettingsState.form.city_code] || []);
  geoMapSettingsUpdateVisibility();
  geoMapSettingsRunValidation();
  geoMapSettingsRefreshPreview();
  if (typeof showToast === 'function') showToast('已還原為系統預設，尚未儲存——請按「儲存設定」才會生效', 'info');
}

// ════════════════════════════════════════════════════════════════
// 供 smoke test／Node 環境使用（沿用 Core 既有慣例）
// ════════════════════════════════════════════════════════════════
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    geoMapSettingsInit, geoMapSettingsLoad, geoMapSettingsSetLoadError,
    geoMapSettingsPopulateForm, geoMapSettingsUpdateVisibility,
    geoMapSettingsOnScopeModeChange, geoMapSettingsOnZoomChange, geoMapSettingsOnLatLngChange,
    geoMapSettingsOnBoundsChange, geoMapSettingsOnAutoFitChange,
    geoMapSettingsRenderCityOptions, geoMapSettingsOnCityChange, geoMapSettingsLoadDistrictsForCity,
    geoMapSettingsRenderDistrictCheckboxes, geoMapSettingsToggleDistrict,
    geoMapSettingsValidateZoom, geoMapSettingsValidateLat, geoMapSettingsValidateLng,
    geoMapSettingsValidateBoundsFields, geoMapSettingsValidateDistrictSelection,
    geoMapSettingsRunValidation, geoMapSettingsRenderErrors,
    geoMapSettingsInitPreviewMap, geoMapSettingsApplyPreviewBoundary, geoMapSettingsApplyPreviewViewport,
    geoMapSettingsRefreshPreview, geoMapSettingsApplyCurrentPreviewToBounds, geoMapSettingsInvalidatePreviewSize,
    geoMapSettingsUseCurrentLocation, geoMapSettingsSave, geoMapSettingsReload, geoMapSettingsRestoreDefaults,
    GEO_MAP_SETTINGS_UI_DEFAULTS, escGeoMapSettingsHtml,
    _geoMapSettingsDebounce,
    get geoMapSettingsState() { return geoMapSettingsState; },
  };
}
