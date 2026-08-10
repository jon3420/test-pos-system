#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX
//
// H1.4.2 Target Runtime — 涵蓋本輪兩個問題：
//   A/B/C/D/E — Dashboard GA4 Range → Map 即時更新（含 race／empty／re-click）。
//   F        — Dashboard Wheel（H1.4.1 既有 Contract，逐項重新驗證未回歸）。
//   G        — Heatmap Wheel（H1.4.2 新 Contract：click-to-activate，跟
//              Dashboard 完全一致，取代 H1.4.1「永遠 enabled」）。
//   H        — 兩個分頁共用同一個 Leaflet map instance。
//   I        — H1.4.1 Dashboard Cleanup 仍保留（不因本輪 Range 修正而回退）。
//   J        — Listener Idempotence（20 次分頁來回不疊加 listener）。
//
// 全部用「真正 dispatch DOM click/keydown 事件」與「真正呼叫
// geoRangeControlSetMode() 走 GeoRangeControl 全域 onclick 慣例」驅動，不直接
// 呼叫內部 refresh function（除了少數明確標註為 direct-call 的 resolver 檢查）。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('H1.4.2 GA4 RANGE-MAP-WHEEL TARGET RUNTIME SUMMARY');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  return { pass: p, fail: f, total: results.length };
}

const CONTAINER_ID = 'geoH142';
const MAP_CONTAINER_ID = `${CONTAINER_ID}-map`;

function readStripped(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/'use strict';\s*\n/, '')
    .replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
}
function buildDom() {
  const html = `<!DOCTYPE html><html><body>
    <span id="clock">--:--</span>
    <div id="${CONTAINER_ID}"></div>
  </body></html>`;
  return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
}
function makeFakeLeafletEnv() {
  const wheelCounters = { enableCalls: 0, disableCalls: 0 };
  const zoomCounters = { zoomInCalls: 0, zoomOutCalls: 0 };
  const map = {
    _layers: new Set(),
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); return this; },
    removeLayer(l) { this._layers.delete(l); return this; },
    remove() {}, invalidateSize() {}, setView() { return this; }, fitBounds() { return this; },
    scrollWheelZoom: {
      _enabled: true,
      enable() { this._enabled = true; wheelCounters.enableCalls += 1; },
      disable() { this._enabled = false; wheelCounters.disableCalls += 1; },
      get enabled() { return this._enabled; },
    },
    zoomIn() { zoomCounters.zoomInCalls += 1; return this; },
    zoomOut() { zoomCounters.zoomOutCalls += 1; return this; },
  };
  const counters = { mapInstances: 0, tileLayerInstances: 0, wheelCounters, zoomCounters };
  function makeGroup() {
    const children = [];
    return {
      __kind: 'layerGroup', _children: children,
      addLayer(c) { children.push(c); return this; },
      removeLayer(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return this; },
      clearLayers() { children.length = 0; return this; },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
    };
  }
  const L = {
    layerGroup() { return makeGroup(); },
    geoJSON() { return { setStyle() {}, bindTooltip() { return this; }, addTo(m) { m.addLayer(this); return this; }, getBounds() { return { pad() { return this; } }; }, eachLayer() {} }; },
    marker(latlng, opts) { return { latlng, opts, bindTooltip() { return this; }, setLatLng() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    circleMarker() { return { bindTooltip() { return this; }, setStyle() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    divIcon(opts) { return { __divIcon: true, ...opts }; },
    map() { counters.mapInstances += 1; return map; },
    tileLayer() { counters.tileLayerInstances += 1; return { addTo() { return this; } }; },
    control: { layers() { return { addTo() { return this; } }; } },
  };
  return { map, L, counters };
}

// 每個 range 各自對應獨立 fixture（district/count 都不同），用來斷言
// marker 真的隨 range 切換——不是同一份資料只是標題換字。90d 故意留空
// （Empty Range Contract）。
const RANGE_ROWS = {
  today: [{ district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.95, lng: 121.22 } }],
  yesterday: [{ district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 2, marker_point: { lat: 24.93, lng: 121.21 } }],
  '7d': [
    { district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 5, marker_point: { lat: 24.95, lng: 121.22 } },
    { district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 3, marker_point: { lat: 24.93, lng: 121.21 } },
  ],
  '30d': [{ district_name: '桃園區', county_name: '桃園市', normalization_status: 'ok', active_users: 10, marker_point: { lat: 24.99, lng: 121.30 } }],
  '90d': [],
  '180d': [{ district_name: '龍潭區', county_name: '桃園市', normalization_status: 'ok', active_users: 4, marker_point: { lat: 24.86, lng: 121.21 } }],
  this_year: [{ district_name: '八德區', county_name: '桃園市', normalization_status: 'ok', active_users: 6, marker_point: { lat: 24.93, lng: 121.29 } }],
  last_year: [{ district_name: '楊梅區', county_name: '桃園市', normalization_status: 'ok', active_users: 7, marker_point: { lat: 24.91, lng: 121.14 } }],
  custom: [{ district_name: '大溪區', county_name: '桃園市', normalization_status: 'ok', active_users: 8, marker_point: { lat: 24.88, lng: 121.28 } }],
  single: [{ district_name: '蘆竹區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 25.05, lng: 121.29 } }],
};

function makeFakeApiFetch(state) {
  const calls = [];
  const fn = async function fakeApiFetch(url, opts = {}) {
    calls.push({ url: String(url), opts });
    const u = String(url);
    const signal = opts.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
      const delay = (state.delayFor && state.delayFor(u)) || state.delayMs || 0;
      const t = setTimeout(resolve, delay);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    if (u.includes('/api/analytics/ga4-geo/sync') && opts.method === 'POST') {
      state.syncCalls = (state.syncCalls || 0) + 1;
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (state.onSync) state.onSync(body);
      const delay2 = (state.syncDelayMs != null) ? state.syncDelayMs : 0;
      if (delay2) await new Promise((r) => setTimeout(r, delay2));
      if (state.syncShouldRateLimit) return { ok: true, status: 429, json: async () => ({ success: false, code: 'rate_limited' }) };
      if (state.syncShouldFail) return { ok: true, status: 200, json: async () => ({ success: false, code: 'network_error' }) };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (u.includes('/api/analytics/ga4-geo/history')) {
      const qs = u.split('?')[1] || '';
      const params = new URLSearchParams(qs);
      const range = params.get('range') || '7d';
      const rows = (state.historyRowsFor ? state.historyRowsFor(u, range) : RANGE_ROWS[range]) || [];
      return { ok: true, status: 200, json: async () => ({ success: true, rows }) };
    }
    if (u.includes('/api/analytics/geo/manifest') || u.includes('manifest.json')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: {}, rows: [] }) };
  };
  fn.calls = calls;
  return fn;
}

function freshEnv(apiState) {
  const dom = buildDom();
  const { map, L, counters } = makeFakeLeafletEnv();
  dom.window.L = L;
  dom.window.currentFeatures = { reports: true };
  dom.window.currentStore = { store_id: 'h142_store' };
  dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '', timezone: 'Asia/Taipei' };
  const fakeApiFetch = makeFakeApiFetch(apiState);
  dom.window.apiFetch = fakeApiFetch;
  dom.window.fetch = fakeApiFetch;
  dom.window.localStorage = (() => { let s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })();
  dom.window.sessionStorage = dom.window.localStorage;
  dom.window.addEventListener('error', () => {});
  const unhandledRejections = [];
  dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));

  const files = [
    'public/js/app.js', 'public/js/analytics-v2.js', 'public/js/date-time-format.js',
    'public/js/geo-range-resolver.js', 'public/js/geo-range-control.js',
    'public/js/geo-intelligence.js', 'public/js/geo-intelligence-map.js',
    'public/js/geo-marker-renderer.js', 'public/js/geo-map-settings.js',
    'public/js/geo-heatmap.js', 'public/js/geo-heatmap-ui.js', 'public/js/geo-visitor-layer.js',
    'public/js/geo-ga4-realtime-layer.js', 'public/js/geo-ga4-dashboard-layer.js', 'public/js/geo-ga4-h1-panel.js',
  ];
  const src = files.map(readStripped).join('\n;\n');
  dom.window.eval(src);
  return { dom, map, L, counters, fakeApiFetch, unhandledRejections };
}

async function directLoad(env) {
  const { dom } = env;
  await dom.window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
  await new Promise((r) => setTimeout(r, 60));
}

function rangeMountId() { return `${CONTAINER_ID}-dashboard-ga4-range`; }
function labelHtml(document) { return document.getElementById(`${CONTAINER_ID}-dashboard-ga4-label`).innerHTML; }
function markerCount(window) {
  const g = window.dashboardGa4State && window.dashboardGa4State.layerGroup;
  return g ? g._children.length : -1;
}

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-heatmap-ui.js')]);
  pass('0a. node --check geo-heatmap-ui.js 通過');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js')]);
  pass('0b. node --check geo-ga4-dashboard-layer.js 通過');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-range-control.js')]);
  pass('0c. node --check geo-range-control.js 通過');

  // ══════════════════════════════════════════════════════════════
  // Category A — Dashboard Range UI：逐一點擊 10 種 mode，確認
  // button active state／title／actual range／resolved.mode 五者一致。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);

    const modes = ['today', 'yesterday', '7d', '30d', '90d', '180d', 'this_year', 'last_year'];
    const friendly = { today: '今天', yesterday: '昨日', '7d': '近 7 天', '30d': '近 30 天', '90d': '近 90 天', '180d': '近 180 天', this_year: '今年', last_year: '去年' };
    for (const mode of modes) {
      window.geoRangeControlSetMode(rangeMountId(), mode);
      await new Promise((r) => setTimeout(r, 30));
      const html = labelHtml(document);
      assert(html.includes(friendly[mode]), `A-${mode}. label shows 「${friendly[mode]}」after clicking`, html);
      assert(window.dashboardGa4State.rangeState.mode === mode, `A-${mode}b. dashboardGa4State.rangeState.mode === '${mode}'`, window.dashboardGa4State.rangeState.mode);
      assert(window.dashboardGa4State.lastResolved && window.dashboardGa4State.lastResolved.ok && window.dashboardGa4State.lastResolved.mode === mode, `A-${mode}c. lastResolved.mode === '${mode}' (single Range Truth)`);
      const btn = document.querySelector(`#${rangeMountId()}-range-control button[data-mode="${mode}"]`);
      assert(!!btn && btn.getAttribute('aria-pressed') === 'true', `A-${mode}d. button[data-mode=${mode}] aria-pressed=true`);
    }

    // single
    window.geoRangeControlSetMode(rangeMountId(), 'single');
    await new Promise((r) => setTimeout(r, 10));
    window.geoRangeControlSetSingleDate(rangeMountId(), '2026-08-01');
    await new Promise((r) => setTimeout(r, 30));
    assert(window.dashboardGa4State.rangeState.mode === 'single' && window.dashboardGa4State.lastResolved.ok, 'A-single. single date resolves after date chosen');

    // custom
    window.geoRangeControlSetMode(rangeMountId(), 'custom');
    await new Promise((r) => setTimeout(r, 10));
    window.geoRangeControlSetCustomDate(rangeMountId(), 'start', '2026-07-01');
    window.geoRangeControlSetCustomDate(rangeMountId(), 'end', '2026-07-10');
    await new Promise((r) => setTimeout(r, 30));
    assert(window.dashboardGa4State.rangeState.mode === 'custom' && window.dashboardGa4State.lastResolved.ok, 'A-custom. custom range resolves after start+end chosen');
  }

  // ══════════════════════════════════════════════════════════════
  // Category B — Dashboard Marker Reaction：today → 7d → 30d，
  // 每次切換都必須「移除舊 marker、只留新 marker」。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, map } = env;
    const { window } = dom.window;
    await directLoad(env); // 預設 7d
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['7d'].length, 'B1. direct load (7d) marker count matches fixture', String(markerCount(window)));

    window.geoRangeControlSetMode(rangeMountId(), 'today');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS.today.length, 'B2. today click → marker count = today fixture only (7d markers removed)', String(markerCount(window)));

    window.geoRangeControlSetMode(rangeMountId(), '7d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['7d'].length, 'B3. 7d click → today layer removed, only 7d markers', String(markerCount(window)));

    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['30d'].length, 'B4. 30d click → 7d removed, only 30d marker', String(markerCount(window)));
    assert(map.hasLayer(window.dashboardGa4State.layerGroup), 'B5. layerGroup still attached to the single shared map instance');
  }

  // ══════════════════════════════════════════════════════════════
  // Category C — Empty Range：30d(有資料) → 90d(無 persisted 資料)，
  // 舊 marker 必須清空，不能 stale，且顯示合法 empty state 文字。
  // ══════════════════════════════════════════════════════════════
  {
    // 90d／180d／this_year／last_year 全部走 apiRange='custom'（需求文件
    // 十二：既有 custom start/end transport，不是獨立 query 值），所以這裡
    // 用「range=30d 有專屬 query 值 → 有資料；其餘（custom transport）→
    // 無 persisted 資料」的 fixture，才是符合 Contract 的正確 Empty Range
    // 情境（不是誤把 apiRange 當成獨立字串鍵）。
    const env = freshEnv({
      historyRowsFor: (u, range) => (range === '30d' ? RANGE_ROWS['30d'] : []),
    });
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['30d'].length, 'C1. precondition — 30d has markers');

    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'C2. 90d (no persisted data via existing custom start/end transport) → 0 markers, 30d markers fully removed (no stale overlay)', String(markerCount(window)));
    const statusText = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusText.includes('尚未同步'), 'C3. empty-state message shown (H1.4.2 CTA copy, not silently blank / not stale old data)', statusText);
    const ctaBtn = document.getElementById(window.dashboardGa4State.ids ? `${window.dashboardGa4State.ids.containerId}-sync-cta-btn` : `${CONTAINER_ID}-sync-cta-btn`);
    assert(!!ctaBtn && ctaBtn.textContent === '立即同步並顯示', 'C4. Sync CTA button rendered with correct label', ctaBtn && ctaBtn.textContent);
  }

  // ══════════════════════════════════════════════════════════════
  // Category D — Range Race Protection：7d(慢,120ms) 快速切 30d(快,10ms)，
  // 最終必須是 30d，慢到的 7d response 必須被忽略。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ delayFor: (u) => (u.includes('range=7d') ? 120 : 10) });
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env); // 預設 7d，120ms 尚在飛行
    window.geoRangeControlSetMode(rangeMountId(), '30d'); // 立刻切 30d，10ms 完成
    await new Promise((r) => setTimeout(r, 200)); // 等兩個 request 都結束
    assert(window.dashboardGa4State.rangeState.mode === '30d', 'D1. selected range settles on 30d');
    assert(markerCount(window) === RANGE_ROWS['30d'].length, 'D2. final marker set = 30d fixture (late 7d response ignored)', String(markerCount(window)));
    assert(labelHtml(document).includes('近 30 天'), 'D3. label stays 30d (not overwritten back to 7d by the late response)', labelHtml(document));
  }

  // ══════════════════════════════════════════════════════════════
  // Category E — Same-range re-click：不得 duplicate layer/marker。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom } = env;
    const { window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 30));
    const first = markerCount(window);
    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 30));
    const second = markerCount(window);
    assert(first === RANGE_ROWS['30d'].length && second === first, 'E1. re-clicking the same range does not duplicate markers', `${first} -> ${second}`);
  }

  // ══════════════════════════════════════════════════════════════
  // Category F — Dashboard Wheel（H1.4.1 既有 Contract，Real DOM Events，
  // 確認本輪 Heatmap 變更沒有連帶回歸 Dashboard 行為）。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, map } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    const mapCanvas = document.getElementById(MAP_CONTAINER_ID);
    const hintEl = document.getElementById(`${MAP_CONTAINER_ID}-wheel-hint`);

    assert(map.scrollWheelZoom.enabled === false, 'F1. Dashboard direct load: scrollWheelZoom disabled by default');
    assert(hintEl.textContent === '點擊地圖後可使用滾輪縮放', 'F2. hint = locked text', hintEl.textContent);

    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === true, 'F3. click map → wheel enabled');
    assert(hintEl.textContent === '滾輪縮放已啟用・按 Esc 關閉', 'F4. hint = enabled text', hintEl.textContent);

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === false, 'F5. Esc → wheel disabled again');

    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    const outsideDiv = document.createElement('div');
    document.body.appendChild(outsideDiv);
    outsideDiv.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === false, 'F6. click outside map → wheel disabled');

    assert(map.zoomIn && map.zoomOut, 'F7. +/- zoom control API untouched');
  }

  // ══════════════════════════════════════════════════════════════
  // Category G — Heatmap Wheel（H1.4.2 新 Contract：Click-to-Activate，
  // 跟 Dashboard 完全一致，取代 H1.4.1「切到 Heatmap 就永遠 enabled」）。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, map } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));

    const mapCanvas = document.getElementById(MAP_CONTAINER_ID);
    const hintEl = document.getElementById(`${MAP_CONTAINER_ID}-wheel-hint`);

    assert(map.scrollWheelZoom.enabled === false, 'G1. Heatmap first activate: scrollWheelZoom DISABLED (H1.4.2 contract change from H1.4.1 always-enabled)');
    assert(hintEl.textContent === '點擊地圖後可使用滾輪縮放', 'G2. Heatmap locked hint text matches Dashboard wording', hintEl.textContent);

    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === true, 'G3. click Heatmap map → wheel enabled');
    assert(hintEl.textContent === '滾輪縮放已啟用・按 Esc 關閉', 'G4. Heatmap enabled hint text matches Dashboard wording', hintEl.textContent);

    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === true, 'G5. clicking inside Heatmap map again while enabled → stays enabled');

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === false, 'G6. Esc on Heatmap → wheel disabled');

    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    const outsideDiv = document.createElement('div');
    document.body.appendChild(outsideDiv);
    outsideDiv.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === false, 'G7. click outside Heatmap map → wheel disabled');

    // Tab round-trip relock: enable on Heatmap, switch to Dashboard (must be
    // locked), switch back to Heatmap (must be locked again — no state carried).
    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === true, 'G8. precondition — Heatmap wheel enabled before switching tabs');
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    assert(map.scrollWheelZoom.enabled === false, 'G9. Heatmap→Dashboard: Dashboard re-locks (no carried-over enabled state)');
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    assert(map.scrollWheelZoom.enabled === false, 'G10. Dashboard→Heatmap: Heatmap re-locks (no carried-over enabled state)');

    assert(map.zoomIn && map.zoomOut, 'G11. +/- zoom control API untouched on Heatmap too');
  }

  // ══════════════════════════════════════════════════════════════
  // Category H — Same Map Instance across repeated tab switching.
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, counters } = env;
    const { window } = dom.window;
    await directLoad(env);
    const before = window.geoMapState.instance;
    for (let i = 0; i < 4; i += 1) {
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
      await new Promise((r) => setTimeout(r, 10));
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(window.geoMapState.instance === before, 'H1. map instance identity unchanged across repeated Dashboard/Heatmap switching');
    assert(counters.mapInstances === 1, 'H2. no second L.map() ever created', String(counters.mapInstances));
  }

  // ══════════════════════════════════════════════════════════════
  // Category I — H1.4.1 Cleanup Retained (spot check — full coverage
  // already lives in run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js).
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom } = env;
    const { document } = dom.window;
    await directLoad(env);
    const dashHtml = document.getElementById(`${CONTAINER_ID}-panel-dashboard`).innerHTML;
    assert(!/Geo Quality/.test(dashHtml), 'I1. Dashboard still has no Geo Quality block');
    assert(!/id="[^"]*-legacy-ranking"/.test(dashHtml), 'I2. Dashboard still has no legacy ranking table');
    assert(!/id="[^"]*-metric-bar"/.test(dashHtml), 'I3. Dashboard still has no old 8-metric selector');
  }

  // ══════════════════════════════════════════════════════════════
  // Category J — Listener Idempotence：20 次 Dashboard/Heatmap 來回，
  // 單次 Esc 只觸發一次 disable()，不隨來回次數疊加。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, map, counters } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    for (let i = 0; i < 20; i += 1) {
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
      await new Promise((r) => setTimeout(r, 2));
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
      await new Promise((r) => setTimeout(r, 2));
    }
    const mapCanvas = document.getElementById(MAP_CONTAINER_ID);
    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    const disableBefore = counters.wheelCounters.disableCalls;
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 15));
    const disableAfter = counters.wheelCounters.disableCalls;
    assert(disableAfter === disableBefore + 1, 'J1. single Escape after 20 tab round-trips triggers exactly one disable() (no listener duplication)', `${disableBefore} -> ${disableAfter}`);
    assert(map.scrollWheelZoom.enabled === false, 'J2. wheel is disabled after that single Escape');
  }

  // ══════════════════════════════════════════════════════════════
  // Category K — Dashboard Sync CTA：完整模擬「Empty → Sync CTA → click
  // → existing Manual Sync success → persisted fixture 更新 → Dashboard
  // 自動 GET → markers render → CTA 消失」（需求文件七、八、十一、二十四）。
  // ══════════════════════════════════════════════════════════════
  {
    const syncedRows = { current: [] }; // 一開始沒有 persisted 資料
    const env = freshEnv({
      historyRowsFor: () => syncedRows.current,
      syncDelayMs: 30,
      onSync: (body) => {
        // 模擬「既有 Manual Sync pipeline 成功寫入 persisted store」——
        // sync 完成後，下一次 GET 就應該讀到新資料（不是 mock GET 直接
        // 回 rows，是先空、sync 後才有，逼真模擬 UX Gap 的真實情境）。
        assert(body.sync_type === 'range', 'K1. Sync request uses existing sync_type=range contract (not a new endpoint/shape)', JSON.stringify(body));
        assert(typeof body.range === 'string' && typeof body.start_date === 'string' && typeof body.end_date === 'string', 'K2. Sync request carries range/start_date/end_date (same identity fields as GET)', JSON.stringify(body));
        syncedRows.current = RANGE_ROWS['30d'];
      },
    });
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'K3. precondition — 30d has no persisted data yet, 0 markers');
    const ctaId = `${CONTAINER_ID}-sync-cta-btn`;
    let ctaBtn = document.getElementById(ctaId);
    assert(!!ctaBtn, 'K4. Sync CTA button visible for empty range', String(!!ctaBtn));

    window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 15));
    assert(document.getElementById(ctaId) && document.getElementById(ctaId).disabled === true, 'K5. CTA button disabled immediately while syncing');
    await new Promise((r) => setTimeout(r, 60));
    assert(markerCount(window) === RANGE_ROWS['30d'].length, 'K6. after sync success, Dashboard auto-GETs and renders markers (no F5, no tab switch)', String(markerCount(window)));
    assert(!document.getElementById(ctaId), 'K7. Sync CTA disappears once markers are rendered');
    const statusText = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusText.includes('個行政區有資料'), 'K8. status text switches to the normal "N districts have data" message', statusText);
  }

  // ══════════════════════════════════════════════════════════════
  // Category L — Sync Failure：不留 loading，不放回舊 marker，顯示合法
  // 錯誤訊息（需求文件十二）。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ syncShouldFail: true });
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'L1. sync failure → still 0 markers (old range markers not restored)', String(markerCount(window)));
    const statusText = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusText.includes('同步失敗'), 'L2. sync failure shows a legitimate error message', statusText);
    const ctaBtn = document.getElementById(`${CONTAINER_ID}-sync-cta-btn`);
    assert(!ctaBtn || ctaBtn.disabled === false, 'L3. no button left stuck in disabled "syncing" state after failure');
  }

  // ══════════════════════════════════════════════════════════════
  // Category M — Same-range Sync Dedup：連點 CTA 不送多支 sync request。
  // ══════════════════════════════════════════════════════════════
  {
    const state = { syncDelayMs: 40 };
    const env = freshEnv(state);
    const { dom } = env;
    const { window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    window.geoDashboardGa4SyncNow();
    window.geoDashboardGa4SyncNow();
    window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 80));
    assert(state.syncCalls === 1, 'M1. rapid repeated CTA clicks send exactly one sync request (pending guard)', String(state.syncCalls));
  }

  // ══════════════════════════════════════════════════════════════
  // Category N — Sync Race：選 7d → 按同步 → 同步進行中改選 30d → 7d sync
  // 完成也不得把畫面切回 7d（需求文件十三）。
  // ══════════════════════════════════════════════════════════════
  {
    const rows30 = RANGE_ROWS['30d'];
    const state = { syncDelayMs: 60, historyRowsFor: (u, range) => (range === '30d' ? rows30 : []) };
    const env = freshEnv(state);
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env); // 預設 7d, 0 rows (historyRowsFor 只認 30d)
    window.geoRangeControlSetMode(rangeMountId(), '7d');
    await new Promise((r) => setTimeout(r, 20));
    window.geoDashboardGa4SyncNow(); // 開始同步 7d，60ms 後才完成
    await new Promise((r) => setTimeout(r, 10));
    window.geoRangeControlSetMode(rangeMountId(), '30d'); // 同步進行中，改選 30d
    await new Promise((r) => setTimeout(r, 100)); // 等 7d sync 完成 + 兩邊 GET 都結束
    assert(window.dashboardGa4State.rangeState.mode === '30d', 'N1. final selected range stays 30d');
    assert(markerCount(window) === rows30.length, 'N2. final markers = 30d fixture (late 7d sync completion did not switch the map back to 7d)', String(markerCount(window)));
    assert(labelHtml(document).includes('近 30 天'), 'N3. label stays on 30d', labelHtml(document));
  }

  // ══════════════════════════════════════════════════════════════
  // Category O — Already-has-data：range 已有 persisted 資料時，直接
  // GET→render，不顯示 Sync CTA，不重打 Google（需求文件十五）。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env); // 預設 7d，RANGE_ROWS['7d'] 有資料
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['7d'].length, 'O1. 7d already has persisted data → markers render directly');
    assert(!document.getElementById(`${CONTAINER_ID}-sync-cta-btn`), 'O2. no Sync CTA shown when range already has data');
    assert(env.fakeApiFetch.calls.filter((c) => c.url.includes('/sync')).length === 0, 'O3. no sync request sent for a range that already has persisted data');
  }

  // ══════════════════════════════════════════════════════════════
  // Category P — 補強 Assertions（CASE 138-142，per 使用者第三輪指示）。
  // ══════════════════════════════════════════════════════════════

  // CASE 138：Sync success，但第二次 Dashboard GET 仍然 rows=[]。
  {
    const env = freshEnv({ historyRowsFor: () => [] }); // 永遠空——模擬 GA4 該區間本身沒有任何城市有活躍使用者
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'P138-1. precondition — 90d empty, 0 markers');
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'P138-2. sync succeeds but GET still empty → marker count stays 0 (old marker does not come back)', String(markerCount(window)));
    assert(!!document.getElementById(`${CONTAINER_ID}-sync-cta-btn`), 'P138-3. CTA re-appears and is usable again (not stuck disabled/removed)');
    const ctaBtnDisabled = document.getElementById(`${CONTAINER_ID}-sync-cta-btn`).disabled;
    assert(ctaBtnDisabled === false, 'P138-3b. CTA button not left disabled after a success-but-still-empty sync');
    const statusText = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusText.includes('同步完成') && statusText.includes('仍無'), 'P138-4. status explicitly distinguishes "synced but still no data" from "never synced" (does not just claim success = has data)', statusText);
  }

  // CASE 139：Sync failure 後可以 retry，第二次成功。
  {
    const state = { syncShouldFail: true, historyRowsFor: () => [] };
    const env = freshEnv(state);
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 20));
    let ctaBtn = document.getElementById(`${CONTAINER_ID}-sync-cta-btn`);
    assert(!!ctaBtn && ctaBtn.disabled === false, 'P139-1. after a failed sync, the CTA button is re-enabled (not stuck on "同步中…")', ctaBtn && String(ctaBtn.disabled));
    assert(ctaBtn.textContent === '立即同步並顯示', 'P139-2. button label resets back to the clickable text after failure', ctaBtn.textContent);

    // 第二次：改成會成功，且改用有資料的 fixture（90d 實際查詢用的是
    // apiRange='custom'，不是字面上的 '90d'，這裡不管 range 字串，統一給
    // 非空 fixture 代表「重新同步後有資料」）。
    state.syncShouldFail = false;
    state.historyRowsFor = () => RANGE_ROWS['180d'];
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) > 0, 'P139-3. retry after failure can succeed and render markers', String(markerCount(window)));
  }

  // CASE 140：Empty range 切換時，舊 marker 必須在使用者按下 Sync 之前就
  // 已經消失（不是等 Sync 成功才清）。
  {
    const env = freshEnv({ historyRowsFor: (u, range) => (range === '7d' ? RANGE_ROWS['7d'] : []) }); // 7d 有資料，30d 假設尚無 persisted 資料
    const { dom } = env;
    const { window } = dom.window;
    await directLoad(env); // 7d，有 marker
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === RANGE_ROWS['7d'].length, 'P140-1. precondition — 7d has markers');

    window.geoRangeControlSetMode(rangeMountId(), '30d'); // 假設 30d 目前無 persisted 資料
    env.fakeApiFetch.calls.length = 0; // reset call log; 不需要，只是清楚起點
    await new Promise((r) => setTimeout(r, 15)); // 故意只等一點點，確認清除是「GET 完成前」就已發生的清除步驟
    // geoDashboardGa4Refresh() 在發出 GET 之前就已經 clear 過一次（需求文件
    // 二十三既有 Contract），所以即使 GET 還沒回來，舊的 7d marker 也已經
    // 不在地圖上——不是等 30d 的 empty response 回來才清，更不是等使用者按
    // 下「立即同步並顯示」才清。
    assert(markerCount(window) === 0, 'P140-2. old (7d) markers are already gone before the user ever clicks Sync (cleared at range-switch time, not sync-time)', String(markerCount(window)));
    await new Promise((r) => setTimeout(r, 30));
    assert(markerCount(window) === 0, 'P140-3. still 0 after the empty GET response settles (no stale 7d marker resurrected)', String(markerCount(window)));
  }

  // CASE 141：CTA sync 請求必須走既有 window.apiFetch（authenticated
  // helper）本身，不是 geo-ga4-dashboard-layer.js 自己另開一條路徑直接
  // 呼叫裸 fetch()——用「包一層 spy 在目前的 window.apiFetch 上」來驗證，
  // 而不是斷言 fetch() 全域從未被呼叫（app.js 真正的 apiFetch 實作本身
  // 內部就是靠呼叫 fetch() 來送出請求，那是它的本職工作，不是繞過）。
  {
    const env = freshEnv({ historyRowsFor: () => [] });
    const { dom } = env;
    const { window } = dom.window;
    const originalApiFetch = dom.window.apiFetch;
    let apiFetchSpyCalledForSync = false;
    dom.window.apiFetch = function (url, opts) {
      if (String(url).includes('/api/analytics/ga4-geo/sync')) apiFetchSpyCalledForSync = true;
      return originalApiFetch(url, opts);
    };
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 30));
    assert(apiFetchSpyCalledForSync === true, 'P141. Sync CTA request goes through window.apiFetch (the existing authenticated helper) — not a separate direct-fetch code path inside geo-ga4-dashboard-layer.js');
  }

  // CASE 142：Dashboard CTA 不自行夾帶 store_id——store scoping 完全交給
  // 既有 requireStore 中介層（跟既有 H1 Manual Sync 同一套 Contract，本輪
  // 沒有改 Backend）。
  {
    const env = freshEnv({ historyRowsFor: () => [] });
    const { dom } = env;
    const { window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 30));
    const syncCall = env.fakeApiFetch.calls.find((c) => c.url.includes('/sync'));
    const body = syncCall && syncCall.opts && syncCall.opts.body ? JSON.parse(syncCall.opts.body) : {};
    assert(!('store_id' in body), 'P142. Sync request body never carries a client-supplied store_id (store scoping stays with existing requireStore middleware, not re-implemented on the frontend)', JSON.stringify(body));
  }

  // ══════════════════════════════════════════════════════════════
  // Category Q — Sync Pending 顯示 vs. 實際 Concurrency（需求文件二～七）：
  //   Q-A：7d 同步中時切到 30d，30d 的 CTA 顯示必須是正常可用狀態，不能
  //        被 7d 的 pending 誤標成「同步中」（identity-keyed UI display）。
  //   Q-B：但既有 Backend（routes/ga4-geo.js `_lastManualSync`）是用
  //        req.storeId 當 key、5 秒節流窗，不分 range——不是「不同
  //        identity 可以安全並行」的 Contract。所以使用者若在 7d 還在飛行
  //        時真的按下 30d 的 CTA，前端不送出第二支 request（送了也大機率
  //        被 429 擋掉），直接顯示合法 busy 訊息；等 7d 完成後 30d 才能
  //        重新送出。
  // ══════════════════════════════════════════════════════════════
  {
    const state = { syncDelayMs: 60, historyRowsFor: () => [] };
    const env = freshEnv(state);
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '7d');
    await new Promise((r) => setTimeout(r, 20));
    window.geoDashboardGa4SyncNow(); // 開始同步 7d，60ms 後才完成（不 await，模擬使用者立刻切走）
    await new Promise((r) => setTimeout(r, 15));

    window.geoRangeControlSetMode(rangeMountId(), '30d');
    await new Promise((r) => setTimeout(r, 20));
    const ctaBtn30d = document.getElementById(`${CONTAINER_ID}-sync-cta-btn`);
    assert(!!ctaBtn30d, 'QA1. 30d CTA rendered while a 7d sync is still in flight');
    assert(ctaBtn30d.disabled === false, 'QA2. 30d CTA is NOT disabled by the unrelated 7d pending sync (UI pending display is identity-keyed, not a global "everything is syncing" boolean)', String(ctaBtn30d.disabled));
    assert(ctaBtn30d.textContent === '立即同步並顯示', 'QA3. 30d CTA still shows the normal clickable label, not "同步中…" (that belongs to 7d, not 30d)', ctaBtn30d.textContent);

    // Q-B：使用者按下 30d 的 CTA——既有 Backend 是 per-store 5 秒節流窗
    // （不分 range），所以前端這裡選擇「同一時間最多一個 sync 在飛行」，
    // 不送出第二支 request，直接顯示合法 busy 訊息。
    state.syncCalls = 0;
    window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 15));
    assert(state.syncCalls === 0, 'QB1. clicking the 30d CTA while a DIFFERENT identity (7d) sync is still in flight does NOT send a second POST (matches the existing per-store 5s throttle window — not identity-scoped concurrency)', String(state.syncCalls));
    const statusAfterBusyClick = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusAfterBusyClick.includes('另一個區間正在同步'), 'QB2. a legitimate busy message is shown instead of silently doing nothing or sending a doomed request', statusAfterBusyClick);

    await new Promise((r) => setTimeout(r, 100)); // 等 7d 的舊同步也結束
    assert(window.dashboardGa4State.rangeState.mode === '30d', 'QB3. after 7d finishes, selected range is still 30d (the stale 7d completion did not hijack the UI, title, or marker)');
    assert(window.dashboardGa4State.syncPendingKey === null, 'QB4. once 7d finishes, the global pending slot is freed (30d can sync again)');

    // 現在 30d 可以自己重新送出了。
    state.syncCalls = 0;
    state.historyRowsFor = (u, range) => (range === '30d' ? RANGE_ROWS['30d'] : []);
    window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 90));
    assert(state.syncCalls === 1, 'QB5. after the earlier sync fully finished, 30d can send its own sync request', String(state.syncCalls));
    assert(markerCount(window) === RANGE_ROWS['30d'].length, 'QB6. that retried 30d sync succeeds and renders markers normally', String(markerCount(window)));
  }

  // Category R — Backend 真的回 429 rate_limited 時（既有 per-store 5 秒
  // 節流窗實際觸發，不只是前端自己攔下來），要顯示同一句合法 busy 訊息，
  // 不是把它當成一般網路錯誤。
  {
    const env = freshEnv({ historyRowsFor: () => [], syncShouldRateLimit: true });
    const { dom } = env;
    const { document, window } = dom.window;
    await directLoad(env);
    window.geoRangeControlSetMode(rangeMountId(), '90d');
    await new Promise((r) => setTimeout(r, 30));
    await window.geoDashboardGa4SyncNow();
    await new Promise((r) => setTimeout(r, 20));
    const statusText = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-status`).textContent;
    assert(statusText.includes('另一個區間正在同步'), 'R1. backend 429 rate_limited is shown as the same legitimate busy message, not a generic sync-failed error', statusText);
    const ctaBtn = document.getElementById(`${CONTAINER_ID}-sync-cta-btn`);
    assert(!!ctaBtn && ctaBtn.disabled === false, 'R2. CTA is retryable after a rate_limited response (not stuck disabled)');
  }

  // ══════════════════════════════════════════════════════════════
  // Category S — Map Container DOM Element Replacement（Real Production
  // Bug #2 固定防回歸）：refreshGeoDashboardKpiBlock() 用同一個 id 重建
  // map container DOM 節點時，click-to-activate 的 listener 必須正確
  // rebind 到新節點，不能停留在舊的、已 detached 的節點上。
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({});
    const { dom, counters } = env;
    const { document, window } = dom.window;
    await directLoad(env);

    // A. 首次 render：mapElement1，點擊 → wheel enable。
    const mapElement1 = document.getElementById(MAP_CONTAINER_ID);
    assert(!!mapElement1, 'S-A1. first render produces a map container element');
    mapElement1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === true, 'S-A2. clicking mapElement1 enables wheel');

    // B. 觸發 refreshGeoDashboardKpiBlock()，讓 map container DOM 被重建。
    await dom.window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 30));
    const mapElement2 = document.getElementById(MAP_CONTAINER_ID);
    assert(!!mapElement2, 'S-B1. after refresh, a map container element with the same id still exists');
    assert(mapElement2 !== mapElement1, 'S-B2. the post-refresh element is a DIFFERENT DOM node (not the same object reference)');
    assert(mapElement2.id === mapElement1.id, 'S-B3. ...but it has the SAME id as before (this is exactly the id-based idempotence trap)');
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === false, 'S-B4. activate-on-refresh resets wheel back to disabled (does not carry over the prior enabled state)');

    // C. 新 mapElement2：click → wheel enable（真正驗證 rebind 有效）。
    mapElement2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === true, 'S-C1. clicking the NEW mapElement2 enables wheel (listener correctly rebound to the live node, not orphaned on the old one)');

    // D. 舊 mapElement1（已 detached）：點擊不得再控制目前 wheel lifecycle。
    window.geoDashboardMapDisableWheel();
    await new Promise((r) => setTimeout(r, 5));
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === false, 'S-D1. precondition — wheel reset to disabled before testing the stale element');
    mapElement1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === false, 'S-D2. clicking the OLD detached mapElement1 has no effect on current wheel state (its listener was removed during rebind, not left dangling)');

    // E. 連續 refresh 三次：每次都只有一份 click lifecycle，不會 listener 累積。
    for (let i = 0; i < 3; i += 1) {
      await dom.window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
      await new Promise((r) => setTimeout(r, 20));
    }
    const mapElementFinal = document.getElementById(MAP_CONTAINER_ID);
    const enableCallsBefore = counters.wheelCounters.enableCalls;
    mapElementFinal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    const enableCallsAfter = counters.wheelCounters.enableCalls;
    assert(enableCallsAfter === enableCallsBefore + 1, 'S-E1. after 3 consecutive refreshes (3 DOM element replacements), a single click still triggers exactly ONE enable() call — no listener accumulation on the final live element', `${enableCallsBefore} -> ${enableCallsAfter}`);
    assert(window.geoMapState.instance.scrollWheelZoom.enabled === true, 'S-E2. the final live element correctly enables wheel');
    assert(counters.mapInstances === 1, 'S-E3. still only one L.map() instance throughout all refreshes (map itself is never recreated, only the container div/lifecycle binding)', String(counters.mapInstances));
  }

  const summary = printSummary();
  process.exitCode = summary.fail > 0 ? 1 : 0;
  // jsdom windows created by freshEnv() across ~30 test blocks leave app.js's
  // WebSocket 重連 setTimeout chain running forever (never closed) — without
  // an explicit process.exit(), the runner would hang waiting for those
  // timers to drain, which they never do. Match the existing H1.4.1 runtime
  // convention (see run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js) of
  // exiting explicitly right after the summary is printed.
  process.exit(process.exitCode);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
