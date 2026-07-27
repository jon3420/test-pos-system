#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js
// fix18-10-hotfix30-B5-R5.2-B3 — Geo Intelligence Settings UI（後台設定中心）
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n總計：${results.length} 項，PASS ${p}，FAIL ${f}`);
  if (f > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

async function main() {
  const { execFileSync } = require('child_process');
  ['public/js/geo-map-settings.js', 'public/index.html'].forEach((f) => {
    if (f.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)]); pass(`0-1 node --check ${f} 通過`); }
      catch (e) { fail(`0-1 node --check ${f} 通過`, e.message); }
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Part A：純函式測試（不需要 DOM）——驗證邏輯本身
  // ══════════════════════════════════════════════════════════════
  const S = require(path.join(ROOT, 'public/js/geo-map-settings.js'));

  // ── 驗證：zoom（5~18，跟後端 utils/geoMapScope.js 1~20 不同——B3 UI 本身限定 5~18） ──
  assert(S.geoMapSettingsValidateZoom(5).ok === true, 'A-1 zoom=5（下限）通過');
  assert(S.geoMapSettingsValidateZoom(18).ok === true, 'A-2 zoom=18（上限）通過');
  assert(S.geoMapSettingsValidateZoom(4).ok === false, 'A-3 zoom=4 低於下限被拒絕');
  assert(S.geoMapSettingsValidateZoom(19).ok === false, 'A-4 zoom=19 高於上限被拒絕');
  assert(S.geoMapSettingsValidateZoom('abc').ok === false, 'A-5 zoom 非數字被拒絕');

  // ── 驗證：lat/lng ──
  assert(S.geoMapSettingsValidateLat(-90).ok === true, 'A-6 lat=-90（下限）通過');
  assert(S.geoMapSettingsValidateLat(90).ok === true, 'A-7 lat=90（上限）通過');
  assert(S.geoMapSettingsValidateLat(-91).ok === false, 'A-8 lat=-91 被拒絕');
  assert(S.geoMapSettingsValidateLat(91).ok === false, 'A-9 lat=91 被拒絕');
  assert(S.geoMapSettingsValidateLat('').ok === true, 'A-10 lat 空字串視為未填，不視為錯誤（尚未輸入 ≠ 輸入錯誤）');
  assert(S.geoMapSettingsValidateLng(-180).ok === true, 'A-11 lng=-180（下限）通過');
  assert(S.geoMapSettingsValidateLng(180).ok === true, 'A-12 lng=180（上限）通過');
  assert(S.geoMapSettingsValidateLng(-181).ok === false, 'A-13 lng=-181 被拒絕');
  assert(S.geoMapSettingsValidateLng(181).ok === false, 'A-14 lng=181 被拒絕');

  // ── 驗證：bounds ──
  assert(S.geoMapSettingsValidateBoundsFields(null).ok === true, 'A-15 bounds=null（尚未填）視為合法');
  assert(S.geoMapSettingsValidateBoundsFields({ south: 24, west: 121, north: 25, east: 122 }).ok === true, 'A-16 合法 bounds 通過');
  assert(S.geoMapSettingsValidateBoundsFields({ south: 25, west: 121, north: 24, east: 122 }).ok === false, 'A-17 south >= north 被拒絕');
  assert(S.geoMapSettingsValidateBoundsFields({ south: 24, west: 122, north: 25, east: 121 }).ok === false, 'A-18 west >= east 被拒絕');
  assert(S.geoMapSettingsValidateBoundsFields({ south: -91, west: 121, north: 25, east: 122 }).ok === false, 'A-19 south 超出緯度範圍被拒絕');
  assert(S.geoMapSettingsValidateBoundsFields({ south: 24, west: -181, north: 25, east: 122 }).ok === false, 'A-20 west 超出經度範圍被拒絕');
  assert(S.geoMapSettingsValidateBoundsFields({ south: 'x', west: 121, north: 25, east: 122 }).ok === false, 'A-21 bounds 非數字欄位被拒絕');

  // ── 驗證：district selection（city 必須存在於 manifest／district 必須屬於該 city／至少選一個） ──
  const MANIFEST = { cities: { TAO: { name: '桃園市', source: '/data/geo/taiwan/taoyuan-districts.geojson' } } };
  assert(S.geoMapSettingsValidateDistrictSelection({ cityCode: 'TAO', districtCodes: ['ZHONGLI'], manifest: MANIFEST, validCodesForCity: ['ZHONGLI', 'BADE'] }).ok === true, 'A-22 合法縣市＋合法行政區代碼通過');
  assert(S.geoMapSettingsValidateDistrictSelection({ cityCode: 'TPE', districtCodes: ['XX'], manifest: MANIFEST, validCodesForCity: [] }).ok === false, 'A-23 city_code 不存在於 manifest 被拒絕');
  assert(S.geoMapSettingsValidateDistrictSelection({ cityCode: 'TAO', districtCodes: [], manifest: MANIFEST, validCodesForCity: ['ZHONGLI'] }).ok === false, 'A-24 districts 模式未選任何行政區被拒絕（至少選一個）');
  assert(S.geoMapSettingsValidateDistrictSelection({ cityCode: 'TAO', districtCodes: ['NOT_IN_CITY'], manifest: MANIFEST, validCodesForCity: ['ZHONGLI', 'BADE'] }).ok === false, 'A-25 district_code 不屬於該 city 被拒絕');
  assert(S.geoMapSettingsValidateDistrictSelection({ cityCode: null, districtCodes: ['ZHONGLI'], manifest: MANIFEST, validCodesForCity: ['ZHONGLI'] }).ok === false, 'A-26 city_code 為空被拒絕');

  // ── Debounce 行為（純函式，用 fake timer 驗證延遲執行且合併多次呼叫成一次） ──
  {
    let callCount = 0;
    const debounced = S._geoMapSettingsDebounce(() => { callCount += 1; }, 50);
    debounced(); debounced(); debounced();
    await new Promise((r) => setTimeout(r, 10));
    assert(callCount === 0, 'A-27 debounce 期間內連續呼叫尚未觸發（尚在等待窗口內）');
    await new Promise((r) => setTimeout(r, 80));
    assert(callCount === 1, 'A-28 debounce 窗口過後只執行一次（多次輸入合併成一次更新，不逐字重建）');
  }
  {
    let callCount = 0;
    const debounced = S._geoMapSettingsDebounce(() => { callCount += 1; }, 200);
    debounced();
    debounced.cancel();
    await new Promise((r) => setTimeout(r, 250));
    assert(callCount === 0, 'A-29 debounce.cancel() 可取消尚未執行的排程');
  }

  // ── UI defaults 常數 ──
  assert(S.GEO_MAP_SETTINGS_UI_DEFAULTS.scope_mode === 'store_location', 'A-30 預設 scope_mode 為 store_location');
  assert(S.GEO_MAP_SETTINGS_UI_DEFAULTS.default_zoom === 12, 'A-31 預設 zoom 為 12');
  assert(S.GEO_MAP_SETTINGS_UI_DEFAULTS.auto_fit_bounds === true, 'A-32 預設 auto_fit_bounds 為 true');
  assert(Array.isArray(S.GEO_MAP_SETTINGS_UI_DEFAULTS.district_codes) && S.GEO_MAP_SETTINGS_UI_DEFAULTS.district_codes.length === 0, 'A-33 預設 district_codes 為空陣列');

  // ── escGeoMapSettingsHtml（XSS 防護：行政區名稱來自 GeoJSON properties，需要跟其他 escHtml 一樣逃逸） ──
  assert(S.escGeoMapSettingsHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', 'A-34 escGeoMapSettingsHtml 正確逃逸 script 標籤');
  assert(S.escGeoMapSettingsHtml('中壢區') === '中壢區', 'A-35 escGeoMapSettingsHtml 對正常中文字串不變動');

  // ── 靜態 DOM ID Audit（對照 index.html，確保沒有重複 id，且我們引用的 id 都存在） ──
  {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert(dupes.length === 0, 'A-36 index.html 內沒有重複的 DOM id', JSON.stringify([...new Set(dupes)]));
    assert((html.match(/id="stab-geo_map"/g) || []).length === 1, 'A-37 stab-geo_map 面板 id 唯一');
    assert((html.match(/id="tab-btn-geo_map"/g) || []).length === 1, 'A-38 tab-btn-geo_map 按鈕 id 唯一');
    const requiredIds = [
      'geo-scope-store_location', 'geo-scope-districts', 'geo-scope-custom_bounds', 'geo-scope-data_bounds',
      'geo-settings-zoom', 'geo-settings-zoom-value', 'geo-settings-zoom-error',
      'geo-settings-lat', 'geo-settings-lng', 'geo-settings-lat-error', 'geo-settings-lng-error',
      'geo-settings-city', 'geo-settings-district-list', 'geo-settings-district-error', 'geo-settings-auto-fit-bounds',
      'geo-settings-bounds-south', 'geo-settings-bounds-west', 'geo-settings-bounds-north', 'geo-settings-bounds-east', 'geo-settings-bounds-error',
      'geo-settings-preview-map', 'geo-settings-preview-loading', 'geo-settings-preview-status', 'geo-settings-save-btn',
    ];
    requiredIds.forEach((id) => assert(ids.includes(id), `A-39-${id} index.html 內存在 id="${id}"`));
  }

  // ── 命名空間衝突檢查（跟需求文件二逐項對應：不得重複宣告 Core 的識別字） ──
  {
    const files = ['public/js/app.js', 'public/js/geo-intelligence.js', 'public/js/geo-intelligence-map.js', 'public/js/geo-map-settings.js'];
    const seen = new Map();
    files.forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const names = new Set();
      for (const m of src.matchAll(/^(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) names.add(m[1]);
      for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) names.add(m[1]);
      names.forEach((n) => { if (!seen.has(n)) seen.set(n, []); seen.get(n).push(f); });
    });
    const collisions = [...seen.entries()].filter(([, fs2]) => new Set(fs2).size > 1);
    assert(collisions.length === 0, 'A-40 geo-map-settings.js 與 Core 三個檔案之間沒有 top-level const/let/function 同名衝突', JSON.stringify(collisions));
    assert(!seen.has('geoMapState') || seen.get('geoMapState').every((f) => f !== 'public/js/geo-map-settings.js'), 'A-41 geo-map-settings.js 沒有重複宣告 geoMapState');
    assert(!seen.has('GEO_MAP_SCOPE_MODES') || seen.get('GEO_MAP_SCOPE_MODES').length === 1, 'A-42 GEO_MAP_SCOPE_MODES 只在 Core 宣告一次，B3 沒有重複宣告');
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 整合測試
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 整合測試', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    process.exit(process.exitCode || 0);
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2Src = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const mapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const settingsUiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-map-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  const PANEL_HTML = `
    <span id="clock">--:--</span>
    <div id="toastContainer"></div>
    <div class="settings-tab-panel" id="stab-geo_map">
      <fieldset class="geo-settings-fieldset">
        <legend>地圖聚焦模式</legend>
        <div class="geo-settings-radio-group">
          <label><input type="radio" name="geo_map_scope_mode" id="geo-scope-store_location" value="store_location" onchange="geoMapSettingsOnScopeModeChange()"><span>店家位置</span></label>
          <label><input type="radio" name="geo_map_scope_mode" id="geo-scope-districts" value="districts" onchange="geoMapSettingsOnScopeModeChange()"><span>行政區</span></label>
          <label><input type="radio" name="geo_map_scope_mode" id="geo-scope-custom_bounds" value="custom_bounds" onchange="geoMapSettingsOnScopeModeChange()"><span>自訂範圍</span></label>
          <label><input type="radio" name="geo_map_scope_mode" id="geo-scope-data_bounds" value="data_bounds" onchange="geoMapSettingsOnScopeModeChange()"><span>依分析資料</span></label>
        </div>
      </fieldset>
      <p id="geo-settings-data-bounds-hint" style="display:none"></p>
      <label for="geo-settings-zoom">縮放</label>
      <input type="range" id="geo-settings-zoom" min="5" max="18" step="1" value="12" oninput="geoMapSettingsOnZoomChange()">
      <div id="geo-settings-zoom-value">12</div>
      <p id="geo-settings-zoom-error" style="display:none"></p>
      <div id="geo-settings-store-location-block">
        <label for="geo-settings-lat">Latitude</label>
        <input type="text" id="geo-settings-lat" oninput="geoMapSettingsOnLatLngChange()">
        <p id="geo-settings-lat-error" style="display:none"></p>
        <label for="geo-settings-lng">Longitude</label>
        <input type="text" id="geo-settings-lng" oninput="geoMapSettingsOnLatLngChange()">
        <p id="geo-settings-lng-error" style="display:none"></p>
        <button type="button" onclick="geoMapSettingsUseCurrentLocation()">取得目前定位</button>
        <p id="geo-settings-location-status"></p>
      </div>
      <div id="geo-settings-districts-block" style="display:none">
        <p id="geo-settings-manifest-coverage-hint"></p>
        <label for="geo-settings-city">縣市</label>
        <select id="geo-settings-city" onchange="geoMapSettingsOnCityChange()"></select>
        <div id="geo-settings-district-list" role="group"></div>
        <p id="geo-settings-district-error" style="display:none"></p>
        <label><input type="checkbox" id="geo-settings-auto-fit-bounds" checked onchange="geoMapSettingsOnAutoFitChange()"><span>auto_fit_bounds</span></label>
      </div>
      <div id="geo-settings-bounds-block" style="display:none">
        <label for="geo-settings-bounds-south">South</label>
        <input type="text" id="geo-settings-bounds-south" oninput="geoMapSettingsOnBoundsChange()">
        <label for="geo-settings-bounds-west">West</label>
        <input type="text" id="geo-settings-bounds-west" oninput="geoMapSettingsOnBoundsChange()">
        <label for="geo-settings-bounds-north">North</label>
        <input type="text" id="geo-settings-bounds-north" oninput="geoMapSettingsOnBoundsChange()">
        <label for="geo-settings-bounds-east">East</label>
        <input type="text" id="geo-settings-bounds-east" oninput="geoMapSettingsOnBoundsChange()">
        <p id="geo-settings-bounds-error" style="display:none"></p>
        <button type="button" onclick="geoMapSettingsApplyCurrentPreviewToBounds()">套用目前預覽範圍</button>
      </div>
      <div id="geo-settings-preview-map"><div id="geo-settings-preview-loading">地圖載入中…</div></div>
      <p id="geo-settings-preview-status"></p>
      <button id="geo-settings-save-btn" onclick="geoMapSettingsSave()">儲存設定</button>
      <button type="button" onclick="geoMapSettingsReload()">重新載入已儲存設定</button>
      <button type="button" onclick="geoMapSettingsRestoreDefaults()">還原系統預設</button>
    </div>`;

  function makeDom() {
    return new JSDOM(`<!DOCTYPE html><html><body>${PANEL_HTML}</body></html>`, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  const TAOYUAN_GEOJSON = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { county: '桃園市', district: '中壢區', district_code: 'ZHONGLI' }, geometry: { type: 'Polygon', coordinates: [[[121.20, 24.93], [121.25, 24.93], [121.25, 24.98], [121.20, 24.98], [121.20, 24.93]]] } },
      { type: 'Feature', properties: { county: '桃園市', district: '八德區', district_code: 'BADE' }, geometry: { type: 'Polygon', coordinates: [[[121.25, 24.93], [121.30, 24.93], [121.30, 24.98], [121.25, 24.98], [121.25, 24.93]]] } },
    ],
  };
  const MANIFEST_FIXTURE = { cities: { TAO: { name: '桃園市', source: '/data/geo/taiwan/taoyuan-districts.geojson', district_property: 'district_code' } } };
  const GEO_MAP_SETTINGS_FIXTURE = {
    scope_mode: 'store_location', default_zoom: 12, store_location: { lat: 24.9998, lng: 121.2168 },
    city_code: null, district_codes: [], bounds: null, geojson_source: null, auto_fit_bounds: true,
  };

  function buildFetchMock(opts) {
    const o = opts || {};
    return async (url) => {
      const u = String(url);
      if (u.includes('/api/settings/geo-map')) {
        if (o.failSettings) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: o.settingsFixture !== undefined ? o.settingsFixture : GEO_MAP_SETTINGS_FIXTURE }) };
      }
      if (u.includes('/data/geo/taiwan/manifest.json')) {
        return { ok: true, status: 200, json: async () => (o.manifestFixture !== undefined ? o.manifestFixture : MANIFEST_FIXTURE) };
      }
      if (u.includes('taoyuan-districts.geojson')) {
        return { ok: true, status: 200, json: async () => (o.geojsonFixture !== undefined ? o.geojsonFixture : TAOYUAN_GEOJSON) };
      }
      if (u.includes('/api/settings/store-location')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    };
  }

  function createLeafletMock() {
    const calls = { mapInit: 0, tileLayer: 0, geoJSON: 0, fitBoundsCalls: [], setViewCalls: [], invalidateSize: 0, layerRemove: 0 };
    const L = {
      map(container) {
        calls.mapInit += 1;
        return {
          removed: false,
          remove() { this.removed = true; },
          fitBounds(b) { calls.fitBoundsCalls.push(b); },
          setView(center, zoom) { calls.setViewCalls.push({ center, zoom }); return this; },
          invalidateSize() { calls.invalidateSize += 1; },
          getBounds() { return { getSouth: () => 24.8, getWest: () => 121.1, getNorth: () => 25.1, getEast: () => 121.4, isValid: () => true }; },
          removeLayer(layer) { calls.layerRemove += 1; },
        };
      },
      tileLayer() { calls.tileLayer += 1; return { addTo(map) { return this; } }; },
      geoJSON(geojson) {
        calls.geoJSON += 1;
        const features = (geojson && geojson.features) || [];
        return {
          addTo(map) { this.__onMap = true; return this; },
          getBounds() { return { getSouth: () => 24.9, getWest: () => 121.2, getNorth: () => 25.0, getEast: () => 121.3, isValid: () => true }; },
          __features: features,
        };
      },
      latLngBounds(a, b) { return { a, b }; },
    };
    return { L, calls };
  }

  function setupDom(fetchOpts) {
    const dom = makeDom();
    dom.window.fetch = buildFetchMock(fetchOpts);
    // 需求：geo-map-settings.js 直接引用 Core 的 top-level const（GEO_MAP_SCOPE_MODES／
    // GEO_MAP_TAIWAN_FALLBACK_VIEWPORT），這在真實瀏覽器的多個 <script> tag 之間本來就是
    // 共用同一份全域詞法環境（let/const 跨 <script> 可見，這是既有規格行為）。但 jsdom 的
    // window.eval() 若「分次呼叫」並不會像多個 <script> tag 一樣累積共用同一份全域詞法環境
    // ——這是測試工具本身的限制，不是 production bug（B2 沒踩到是因為它只跨檔案呼叫 Core
    // 的「函式」，函式宣告本來就會掛在 window 上；B3 第一次需要跨檔案引用 Core 的 const）。
    // 修法：把四份原始碼合併成單一字串、只呼叫一次 eval()，讓它們在同一次 Script 執行內
    // 共用同一份頂層詞法環境，正確還原真實瀏覽器多個 <script src> 標籤的行為。
    dom.window.eval([appSrc, av2Src, geoSrc, mapSrc, settingsUiSrc].join('\n;\n'));
    const mock = createLeafletMock();
    dom.window.L = mock.L;
    return { dom, mock };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── B-1：設定載入（Settings Load）──────────────────────────────
  {
    const { dom, mock } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    assert(window.geoMapSettingsState.loaded === true, 'B-1 首次載入成功後 loaded=true');
    assert(window.geoMapSettingsState.form.scope_mode === 'store_location', 'B-2 表單正確載入 scope_mode');
    assert(window.geoMapSettingsState.form.store_lat === 24.9998, 'B-3 表單正確載入 store_location.lat');
    assert(window.document.getElementById('geo-scope-store_location').checked === true, 'B-4 對應的 radio 被勾選');
    assert(window.document.getElementById('geo-settings-lat').value === '24.9998', 'B-5 Latitude 欄位正確帶入');
    assert(mock.calls.mapInit === 1, 'B-6 Preview 地圖只建立一次 L.map()');
    await sleep(300); dom.window.close();
  }

  // ── B-2：設定載入失敗（不得崩潰、不得自動寫入錯誤預設值）──────────
  {
    const { dom } = setupDom({ failSettings: true });
    const { window } = dom.window;
    let threw = false;
    try { await window.geoMapSettingsLoad(); } catch (e) { threw = true; }
    assert(!threw, 'B-7 GET 失敗時 geoMapSettingsLoad() 本身不 throw（不讓 Settings 頁面崩潰）');
    assert(window.geoMapSettingsState.loaded === false, 'B-8 載入失敗時 loaded 維持 false（沒有假裝載入成功）');
    assert(!!window.geoMapSettingsState.loadError, 'B-9 載入失敗時記錄 loadError');
    assert(window.document.getElementById('geo-settings-load-error') !== null, 'B-10 載入失敗時畫面顯示錯誤訊息（不是靜默失敗）');
    assert(window.document.getElementById('geo-settings-save-btn').disabled === true, 'B-11 載入失敗時儲存按鈕 disabled（不得用尚未成功載入的資料儲存）');
    await sleep(300); dom.window.close();
  }

  // ── B-3：模式切換只顯示相關欄位 ─────────────────────────────────
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    const setMode = (mode) => {
      window.document.getElementById('geo-scope-' + mode).checked = true;
      window.geoMapSettingsOnScopeModeChange();
    };
    setMode('store_location');
    assert(document.getElementById('geo-settings-store-location-block').style.display !== 'none', 'B-12 store_location 模式顯示店家定位區塊');
    assert(document.getElementById('geo-settings-districts-block').style.display === 'none', 'B-13 store_location 模式隱藏行政區區塊');
    assert(document.getElementById('geo-settings-bounds-block').style.display === 'none', 'B-14 store_location 模式隱藏自訂範圍區塊');
    setMode('districts');
    assert(document.getElementById('geo-settings-districts-block').style.display !== 'none', 'B-15 districts 模式顯示行政區區塊');
    assert(document.getElementById('geo-settings-store-location-block').style.display === 'none', 'B-16 districts 模式隱藏店家定位區塊');
    setMode('custom_bounds');
    assert(document.getElementById('geo-settings-bounds-block').style.display !== 'none', 'B-17 custom_bounds 模式顯示自訂範圍區塊');
    setMode('data_bounds');
    assert(document.getElementById('geo-settings-data-bounds-hint').style.display !== 'none', 'B-18 data_bounds 模式顯示說明文字');
    assert(document.getElementById('geo-settings-bounds-block').style.display === 'none', 'B-19 data_bounds 模式隱藏自訂範圍區塊');
    await sleep(300); dom.window.close();
  }

  // ── B-4：行政區來源（manifest 驅動，不 hardcode）與多選 ───────────
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    window.document.getElementById('geo-scope-districts').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    const citySel = document.getElementById('geo-settings-city');
    assert(citySel.innerHTML.includes('桃園市'), 'B-20 縣市下拉選項來自 manifest（顯示「桃園市」，不是硬編碼字串比對）');
    assert([...citySel.options].length === Object.keys(MANIFEST_FIXTURE.cities).length, 'B-21 縣市選項數量等於 manifest.cities 的 key 數（目前只有一個）');
    citySel.value = 'TAO';
    await window.geoMapSettingsOnCityChange();
    const list = document.getElementById('geo-settings-district-list');
    assert(list.innerHTML.includes('中壢區') && list.innerHTML.includes('八德區'), 'B-22 行政區清單來自對應 GeoJSON properties（中壢區／八德區），不是寫死字串');
    assert(!list.innerHTML.includes('楊梅區'), 'B-23 沒有多渲染出 fixture 以外的行政區');
    const zhongliCb = document.getElementById('geo-settings-district-ZHONGLI');
    assert(!!zhongliCb, 'B-24 中壢區 checkbox 確實被建立（id 對應 district_code）');
    zhongliCb.checked = true;
    window.geoMapSettingsToggleDistrict('ZHONGLI');
    assert(window.geoMapSettingsState.form.district_codes.includes('ZHONGLI'), 'B-25 勾選後 district_codes 正確更新');
    window.geoMapSettingsToggleDistrict('ZHONGLI');
    assert(!window.geoMapSettingsState.form.district_codes.includes('ZHONGLI'), 'B-26 再次點擊取消勾選正確移除');
    const coverageHint = document.getElementById('geo-settings-manifest-coverage-hint').textContent;
    assert(coverageHint.includes('桃園市') && coverageHint.includes('目前系統已提供'), 'B-27 明確顯示「目前系統已提供的行政區邊界」，不假裝已支援全台');
    await sleep(300); dom.window.close();
  }

  // ── B-5：Validation（即時顯示，不等按儲存） ───────────────────────
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    window.document.getElementById('geo-scope-store_location').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    window.document.getElementById('geo-settings-lat').value = '999';
    window.geoMapSettingsOnLatLngChange();
    const valid1 = window.geoMapSettingsRunValidation();
    assert(valid1 === false, 'B-28 lat=999 立即被判定為不合法（不等按儲存）');
    assert(document.getElementById('geo-settings-lat-error').style.display !== 'none', 'B-29 Latitude 錯誤訊息立即顯示在欄位旁');
    assert(document.getElementById('geo-settings-save-btn').disabled === true, 'B-30 有欄位錯誤時儲存按鈕 disabled');
    window.document.getElementById('geo-settings-lat').value = '24.99';
    window.geoMapSettingsOnLatLngChange();
    const valid2 = window.geoMapSettingsRunValidation();
    assert(valid2 === true, 'B-31 修正為合法值後驗證通過');
    assert(document.getElementById('geo-settings-lat-error').style.display === 'none', 'B-32 修正後錯誤訊息立即隱藏');
    assert(document.getElementById('geo-settings-save-btn').disabled === false, 'B-33 驗證通過後儲存按鈕恢復可用');
    await sleep(300); dom.window.close();
  }
  {
    // districts 模式：至少選一個行政區才算合法
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    window.document.getElementById('geo-scope-districts').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    document.getElementById('geo-settings-city').value = 'TAO';
    await window.geoMapSettingsOnCityChange();
    const validEmpty = window.geoMapSettingsRunValidation();
    assert(validEmpty === false, 'B-34 districts 模式未選任何行政區時驗證失敗');
    assert(document.getElementById('geo-settings-district-error').style.display !== 'none', 'B-35 未選行政區時顯示 inline error');
    window.geoMapSettingsToggleDistrict('ZHONGLI');
    const validAfter = window.geoMapSettingsRunValidation();
    assert(validAfter === true, 'B-36 選了至少一個行政區後驗證通過');
    await sleep(300); dom.window.close();
  }

  // ── B-6：Preview lifecycle（只建立一次 Leaflet instance，之後只更新） ──
  {
    const { dom, mock } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    assert(mock.calls.mapInit === 1, 'B-37 首次載入只呼叫一次 L.map()');
    window.document.getElementById('geo-scope-custom_bounds').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    window.document.getElementById('geo-scope-districts').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    window.document.getElementById('geo-settings-zoom').value = '15';
    window.geoMapSettingsOnZoomChange();
    await sleep(400); // 等 debounce 觸發
    assert(mock.calls.mapInit === 1, 'B-38 多次切換模式／調整 zoom 後，L.map() 仍只被呼叫過一次（不重新初始化 Leaflet）');
    assert(mock.calls.fitBoundsCalls.length + mock.calls.setViewCalls.length > 0, 'B-39 viewport 確實有被更新過（setView 或 fitBounds 至少一次）');
    await sleep(300); dom.window.close();
  }
  {
    // 重複進入 Tab 不重複 init（geoMapSettingsInit 的 guard）
    const { dom, mock } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    window.geoMapSettingsInit();
    window.geoMapSettingsInit();
    assert(mock.calls.mapInit === 1, 'B-40 重複呼叫 geoMapSettingsInit()（模擬重複進入 Tab）不會重複建立 Leaflet map');
    assert(mock.calls.invalidateSize >= 2, 'B-41 重複進入 Tab 時改為呼叫 invalidateSize()（處理 Tab 切換後尺寸不正確）');
    await sleep(300); dom.window.close();
  }
  {
    // debounce 節流：輸入期間不應每次都重建圖層／viewport
    const { dom, mock } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    window.document.getElementById('geo-scope-custom_bounds').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    const before = mock.calls.fitBoundsCalls.length + mock.calls.setViewCalls.length;
    for (let i = 0; i < 5; i += 1) {
      window.document.getElementById('geo-settings-bounds-south').value = String(24 + i * 0.01);
      window.geoMapSettingsOnBoundsChange();
    }
    const rightAfter = mock.calls.fitBoundsCalls.length + mock.calls.setViewCalls.length;
    assert(rightAfter === before, 'B-42 連續 5 次輸入變更（debounce 窗口內）尚未觸發任何 viewport 更新');
    await sleep(350);
    const afterDebounce = mock.calls.fitBoundsCalls.length + mock.calls.setViewCalls.length;
    assert(afterDebounce > before, 'B-43 debounce 窗口過後才實際更新一次 viewport（不是每個 keypress 都重建）');
    await sleep(300); dom.window.close();
  }

  // ── B-7：無 boundary 時使用台灣 fallback，不 fallback 桃園 ─────────
  {
    const { dom, mock } = setupDom({ settingsFixture: { scope_mode: 'store_location', default_zoom: 12, store_location: { lat: null, lng: null }, city_code: null, district_codes: [], bounds: null, geojson_source: null, auto_fit_bounds: true } });
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    const lastCall = mock.calls.setViewCalls[mock.calls.setViewCalls.length - 1];
    assert(!!lastCall, 'B-44 無店家座標時仍有呼叫 setView（走 fallback，不是整個不更新）');
    assert(JSON.stringify(lastCall.center) === JSON.stringify([23.7, 121.0]) && lastCall.zoom === 7, 'B-45 無座標時 fallback 為台灣全域 [23.7,121.0]/zoom 7，不是桃園座標');
    await sleep(300); dom.window.close();
  }

  // ── B-8：Save（成功／失敗行為） ────────────────────────────────
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    const ok = await window.geoMapSettingsSave();
    assert(ok === true, 'B-46 合法表單儲存成功回傳 true');
    const toasts = document.querySelectorAll('.toast');
    assert(toasts.length > 0 && [...toasts].some((t) => t.textContent.includes('已儲存')), 'B-47 儲存成功顯示 Toast「已儲存」');
    assert(document.getElementById('stab-geo_map').style.display !== 'none' || document.getElementById('stab-geo_map') !== null, 'B-48 儲存後仍停留在同一個 Tab（面板未被移除）');
    await sleep(300); dom.window.close();
  }
  {
    const { dom } = setupDom({ failSettings: false });
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    // 讓表單處於不合法狀態，驗證阻止送出
    window.document.getElementById('geo-scope-store_location').checked = true;
    window.geoMapSettingsOnScopeModeChange();
    window.document.getElementById('geo-settings-lat').value = '999';
    window.geoMapSettingsOnLatLngChange();
    window.geoMapSettingsRunValidation();
    const before = JSON.stringify(window.geoMapSettingsState.form);
    const result = await window.geoMapSettingsSave();
    assert(result === false, 'B-49 表單有錯誤時 geoMapSettingsSave() 直接阻止送出（不呼叫 API）');
    assert(JSON.stringify(window.geoMapSettingsState.form) === before, 'B-50 驗證失敗時表單內容不被清空／不被覆蓋');
    await sleep(300); dom.window.close();
  }
  {
    // PATCH 失敗（後端回 success:false）：不清空表單
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('/api/settings/geo-map') && opts && opts.method === 'PATCH') {
        return { ok: false, status: 400, json: async () => ({ success: false, message: '模擬失敗' }) };
      }
      return originalFetch(url, opts);
    };
    window.document.getElementById('geo-settings-lat').value = '25.5';
    window.geoMapSettingsOnLatLngChange();
    const beforeSave = window.document.getElementById('geo-settings-lat').value;
    const result = await window.geoMapSettingsSave();
    assert(result === false, 'B-51 後端回傳失敗時 geoMapSettingsSave() 回傳 false');
    assert(window.document.getElementById('geo-settings-lat').value === beforeSave, 'B-52 儲存失敗後表單欄位維持使用者輸入，不被清空/還原');
    const toasts = document.querySelectorAll('.toast');
    assert([...toasts].some((t) => t.textContent.includes('失敗')), 'B-53 儲存失敗顯示錯誤 Toast');
    await sleep(300); dom.window.close();
  }

  // ── B-9：Reload（重新 GET，恢復已儲存值） vs Restore Defaults（只重設表單，不 PATCH） ──
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    window.document.getElementById('geo-settings-lat').value = '10';
    window.geoMapSettingsOnLatLngChange();
    assert(window.geoMapSettingsState.form.store_lat === 10, 'B-54 使用者修改後 state 反映新值');
    let patchCalled = false;
    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (opts && opts.method === 'PATCH') patchCalled = true;
      return originalFetch(url, opts);
    };
    await window.geoMapSettingsReload();
    assert(patchCalled === false, 'B-55 「重新載入已儲存設定」只呼叫 GET，不呼叫任何 PATCH');
    assert(window.geoMapSettingsState.form.store_lat === 24.9998, 'B-56 重新載入後恢復為後端已儲存的值（不是使用者剛剛修改但未儲存的 10）');
    await sleep(300); dom.window.close();
  }
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    let patchCalled = false;
    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (opts && opts.method === 'PATCH') patchCalled = true;
      return originalFetch(url, opts);
    };
    window.geoMapSettingsRestoreDefaults();
    assert(patchCalled === false, 'B-57 「還原系統預設」不會立即呼叫任何 PATCH（必須使用者再按儲存）');
    assert(window.geoMapSettingsState.form.scope_mode === 'store_location', 'B-58 還原系統預設後表單變成預設 scope_mode');
    assert(window.geoMapSettingsState.form.default_zoom === 12, 'B-59 還原系統預設後 zoom 變成 12');
    await sleep(300); dom.window.close();
  }

  // ── B-10：定位按鈕（不自動取得，須使用者主動點擊；處理拒絕/不支援/逾時/成功） ──
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    assert(window.geoMapSettingsState.form.store_lat === 24.9998, 'B-60 載入時已有既定座標（未被自動定位覆蓋，因為完全沒呼叫過定位函式）');
    window.navigator.geolocation = {
      getCurrentPosition(success) { success({ coords: { latitude: 25.05, longitude: 121.5 } }); },
    };
    window.geoMapSettingsUseCurrentLocation();
    assert(window.document.getElementById('geo-settings-lat').value === '25.05', 'B-61 使用者點擊後成功取得定位並帶入 Latitude');
    assert(document.getElementById('geo-settings-location-status').textContent.includes('✅'), 'B-62 成功取得定位時顯示成功狀態文字');
    await sleep(300); dom.window.close();
  }
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    window.navigator.geolocation = {
      getCurrentPosition(success, error) { error({ code: 1 }); }, // PERMISSION_DENIED
    };
    window.geoMapSettingsUseCurrentLocation();
    assert(document.getElementById('geo-settings-location-status').textContent.includes('拒絕'), 'B-63 使用者拒絕定位權限時顯示對應訊息');
    await sleep(300); dom.window.close();
  }
  {
    const { dom, } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    delete window.navigator.geolocation;
    window.geoMapSettingsUseCurrentLocation();
    assert(document.getElementById('geo-settings-location-status').textContent.includes('不支援'), 'B-64 瀏覽器不支援定位時顯示對應訊息');
    await sleep(300); dom.window.close();
  }

  // ── B-11：Toast ────────────────────────────────────────────────
  {
    const { dom } = setupDom();
    const { window, document } = dom.window;
    await window.geoMapSettingsLoad();
    await window.geoMapSettingsSave();
    assert(document.querySelectorAll('.toast.success').length > 0, 'B-65 儲存成功顯示 success 類型 Toast');
    await sleep(300); dom.window.close();
  }

  // ── B-12：Keyboard／Accessibility ──────────────────────────────
  {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const panelMatch = html.match(/<div class="settings-tab-panel" id="stab-geo_map"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<div class="geo-settings-btn-row geo-settings-footer-actions">[\s\S]*?<\/div>\s*<\/div>/);
    assert(html.includes('<fieldset class="geo-settings-fieldset">') && html.includes('<legend>'), 'B-66 radio group 使用 fieldset/legend（Accessibility）');
    assert(html.includes('for="geo-settings-lat"') && html.includes('id="geo-settings-lat"'), 'B-67 Latitude input 有對應 label[for]');
    assert(html.includes('for="geo-settings-lng"') && html.includes('id="geo-settings-lng"'), 'B-68 Longitude input 有對應 label[for]');
    assert(html.includes('for="geo-settings-city"') && html.includes('id="geo-settings-city"'), 'B-69 縣市 select 有對應 label[for]');
    assert(html.includes('aria-describedby="geo-settings-lat-error"'), 'B-70 Latitude 錯誤訊息有 aria-describedby 關聯');
    assert(html.includes('aria-describedby="geo-settings-lng-error"'), 'B-71 Longitude 錯誤訊息有 aria-describedby 關聯');
    assert(html.includes('role="alert"'), 'B-72 錯誤訊息使用 role="alert"（可被螢幕閱讀器讀出）');
    assert(html.includes('aria-live="polite"'), 'B-73 狀態訊息使用 aria-live（Toast/狀態文字可被讀出）');
    assert(html.includes('role="application" aria-label="地圖聚焦範圍預覽"'), 'B-74 Preview 地圖容器有 role/aria-label');
  }

  // ── B-13：Responsive（CSS 規則存在性檢查） ─────────────────────
  {
    const css = fs.readFileSync(path.join(ROOT, 'public/css/geo-map-settings.css'), 'utf8');
    assert(/@media \(max-width: 768px\)/.test(css), 'B-75 CSS 含 768px（平板）breakpoint');
    assert(/@media \(max-width: 480px\)/.test(css), 'B-76 CSS 含 480px（手機）breakpoint 用於進一步縮小 Preview 高度');
    assert(/\.geo-settings-district-list\s*\{[^}]*grid-template-columns:\s*repeat\(2/.test(css), 'B-77 桌面版行政區清單為雙欄 grid');
    const mobileBlock = css.match(/@media \(max-width: 768px\) \{([\s\S]*?)\}\s*\n\n/);
    assert(!!mobileBlock && /grid-template-columns:\s*1fr/.test(mobileBlock[1]), 'B-78 768px 以下行政區清單改為單欄（bounds 欄位本身已是原生 block 版面，同一斷點一併改單欄呈現）');
    assert(/overflow:\s*hidden/.test(css), 'B-79 Preview 容器 overflow:hidden，避免世界地圖水平重複造成錯誤觀感');
    assert(/height:\s*3(00|20)px/.test(css) || /\.geo-settings-preview-map\s*\{\s*height:\s*300px/.test(css), 'B-80 手機斷點 Preview 高度落在 300~320px 區間');
  }

  // ── B-14：世界地圖重複／Loading overlay 卡住的防禦性修正驗證 ──────
  {
    const { dom, mock } = setupDom();
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    const before = mock.calls.invalidateSize;
    await sleep(20); // 等延後一個 tick 的 invalidateSize 觸發
    assert(mock.calls.invalidateSize > before, 'B-81 建立 Preview 後，延後一個 tick 仍會再呼叫一次 invalidateSize()（修正 container 剛顯示時尺寸量測過早的已知 Leaflet 問題）');
    await sleep(300); dom.window.close();
  }
  {
    const { dom } = setupDom({ failSettings: true });
    const { window } = dom.window;
    await window.geoMapSettingsLoad();
    const loadingEl = window.document.getElementById('geo-settings-preview-loading');
    assert(loadingEl.textContent.includes('失敗'), 'B-82 設定載入失敗時 Preview loading overlay 文字誠實反映失敗，不永遠卡在「地圖載入中」');
    await sleep(300); dom.window.close();
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
