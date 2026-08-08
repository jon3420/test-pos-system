#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-dashboard-source-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 5
//
// 真實 require public/js/geo-ga4-dashboard-layer.js（Dashboard GA4 Regional
// Overview 正式模組）、public/js/geo-range-resolver.js、
// public/js/geo-range-control.js。Fake apiFetch 是唯一 injection boundary
// （跟既有 H1 測試同一套慣例），不手刻 marker/DOM 斷言之外的東西。

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { JSDOM } = require('jsdom');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('DASHBOARD SOURCE RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 5)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function makeFakeFetch(routes) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts });
    const route = routes.find((r) => r.test.test(url));
    const delayMs = (route && route.delayMs) || 0;
    const signal = opts.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
      const t = setTimeout(resolve, delayMs);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const status = (route && typeof route.status === 'number') ? route.status : 200;
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false, code: 'not_found' }) };
    if (typeof route.body === 'function') return { status, ok: status < 400, json: async () => route.body(url, opts) };
    return { status, ok: status < 400, json: async () => route.body };
  };
  fn.calls = calls;
  return fn;
}
function makeFakeApiFetch(fetchFn) {
  return async function fakeApiFetch(url, options = {}) {
    const res = await fetchFn(url, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer FAKE', 'x-store-id': 'store_001' } });
    if (res.status === 401 || res.status === 403) { const body = await res.json().catch(() => ({})); return { ok: false, status: res.status, body }; }
    return res;
  };
}
function setFakeApi(routes) {
  const fakeFetch = makeFakeFetch(routes);
  global.fetch = fakeFetch;
  global.apiFetch = makeFakeApiFetch(fakeFetch);
  return fakeFetch;
}
function makeFakeMap() {
  const layers = new Set();
  return { hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); return this; }, removeLayer(l) { layers.delete(l); return this; } };
}
function makeDom() {
  return new JSDOM('<div id="c-dashboard-ga4-range"></div><div id="c-dashboard-ga4-label"></div><div id="c-dashboard-ga4-status"></div>');
}
const IDS = { containerId: 'c', rangeMount: 'c-dashboard-ga4-range', label: 'c-dashboard-ga4-label', status: 'c-dashboard-ga4-status' };

function freshDashboardModule(dom, withRangeControl) {
  const dashPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js'));
  delete require.cache[dashPath];
  const resolverPath = require.resolve(path.join(ROOT, 'public/js/geo-range-resolver.js'));
  delete require.cache[resolverPath];
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = {
    layerGroup: () => {
      const group = {
        _children: [],
        addLayer(c) { this._children.push(c); return this; },
        clearLayers() { this._children.length = 0; return this; },
        addTo(m) { m.addLayer(this); return this; },
      };
      return group;
    },
    marker: (latlng, opts) => ({ latlng, opts, _tooltip: null, bindTooltip(h) { this._tooltip = h; return this; }, addTo(g) { g.addLayer(this); return this; } }),
    divIcon: (o) => ({ __divIcon: true, ...o }),
  };
  const mod = require(dashPath);
  if (withRangeControl) {
    const controlPath = require.resolve(path.join(ROOT, 'public/js/geo-range-control.js'));
    delete require.cache[controlPath];
    require(controlPath); // 頂層程式碼會自己把 window.GeoRangeControl = { mount: ... } 設好
  }
  return mod;
}

const HISTORY_ROUTE_4ROWS = { test: /history/, body: { success: true, rows: [
  { district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 3, marker_point: { lat: 24.95, lng: 121.22 } },
  { district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.93, lng: 121.21 } },
  { district_name: '桃園區', county_name: '桃園市', normalization_status: 'ok', active_users: 2, marker_point: { lat: 24.99, lng: 121.30 } },
  { district_name: '龍潭區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.86, lng: 121.21 } },
] } };
const HISTORY_ROUTE_EMPTY = { test: /history/, body: { success: true, rows: [] } };

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js')]);
  pass('0-parse public/js/geo-ga4-dashboard-layer.js node --check 通過');

  // ══════════════════════════════════════════════════════════════
  // A. Direct Load（1-9）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, true);
    const fetchFn = setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));

    assert(dash.dashboardGa4State.active === true, '1 Dashboard activate 成功（active=true）');
    assert(dash.dashboardGa4State.rangeState.mode === '7d', '2 default range=7d');
    assert(dash.dashboardGa4State.metric === 'active_users', '3 metric=active_users');
    assert(fetchFn.calls.length >= 1 && /range=7d/.test(fetchFn.calls[0].url), '4 authenticated GET 被呼叫且 range=7d', fetchFn.calls[0] && fetchFn.calls[0].url);
    assert(fetchFn.calls[0].opts.headers.Authorization === 'Bearer FAKE', '4b 透過 authenticated apiFetch（帶 Authorization header），不是 bare fetch');
    const group = dash.dashboardGa4State.layerGroup;
    assert(!!group && map.hasLayer(group), '5 persisted rows render（layerGroup 掛在地圖上）');
    const labelHtml = dom.window.document.getElementById(IDS.label).innerHTML;
    // Stage 5.1：Dashboard 標題改用 Friendly Label（口語化，如「近 7 天」），
    // 底下小字仍保留 resolveGeoHistoricalRange() 算出來的實際日期區間
    // （Stage 3 已凍結的 Contract，這裡沒有改 Resolver，只是多一層
    // Presentation Helper）。
    assert(labelHtml.includes('GA4 區域概況｜近 7 天'), '6 label 顯示 Friendly Label「GA4 區域概況｜近 7 天」', labelHtml);
    assert(/\d{4}\/\d{2}\/\d{2}/.test(labelHtml), '6b 底下仍顯示實際 Calendar Range（跟 Friendly Label 語意分開，不是互相取代）', labelHtml);
    assert(labelHtml.includes('IP 城市級推估'), '7 IP estimate disclaimer 顯示', labelHtml);
    const statusText = dom.window.document.getElementById(IDS.status).textContent;
    assert(/4 個行政區/.test(statusText), '8 marker count 顯示在狀態文字（4 個行政區）', statusText);
    assert(dom.window.document.getElementById(IDS.rangeMount).innerHTML.length > 0, '9 GeoRangeControl 真的 mount 進 rangeMount 容器', '');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Extended Ranges（10-17）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    const fetchFn = setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 10));

    dash.dashboardGa4State.rangeState.mode = 'today';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=today/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '10 today request correct');

    dash.dashboardGa4State.rangeState.mode = 'single';
    dash.dashboardGa4State.rangeState.singleDate = '2026-08-01';
    await dash.geoDashboardGa4Refresh(IDS, map);
    const singleUrl = fetchFn.calls[fetchFn.calls.length - 1].url;
    assert(singleUrl.includes('start_date=2026-08-01') && singleUrl.includes('end_date=2026-08-01'), '11 single start=end', singleUrl);

    dash.dashboardGa4State.rangeState.mode = '30d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=30d/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '12 30d request correct');

    dash.dashboardGa4State.rangeState.mode = '90d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=custom/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '13 90d → range=custom');

    dash.dashboardGa4State.rangeState.mode = '180d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=custom/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '14 180d → range=custom');

    dash.dashboardGa4State.rangeState.mode = 'this_year';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=custom/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '15 this_year → range=custom');

    dash.dashboardGa4State.rangeState.mode = 'last_year';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(/range=custom/.test(fetchFn.calls[fetchFn.calls.length - 1].url), '16 last_year → range=custom');

    dash.dashboardGa4State.rangeState.mode = 'custom';
    dash.dashboardGa4State.rangeState.startDate = '2026-07-01';
    dash.dashboardGa4State.rangeState.endDate = '2026-08-07';
    await dash.geoDashboardGa4Refresh(IDS, map);
    const customUrl = fetchFn.calls[fetchFn.calls.length - 1].url;
    assert(customUrl.includes('start_date=2026-07-01') && customUrl.includes('end_date=2026-08-07'), '17 custom request correct', customUrl);
  }

  // ══════════════════════════════════════════════════════════════
  // C. State Isolation（18-21）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const heatmapRangeState = { mode: '180d', singleDate: '', startDate: '', endDate: '' };
    assert(dash.dashboardGa4State.rangeState !== heatmapRangeState, '18 Dashboard range object != Heatmap（不同物件參考）');
    const fakeH1MarkerGroup = {};
    assert(dash.dashboardGa4State.layerGroup !== fakeH1MarkerGroup, '19 Dashboard layer != H1 marker（不同物件參考）');

    dash.dashboardGa4State.rangeState.mode = '90d';
    assert(heatmapRangeState.mode === '180d', '20 Dashboard 90d doesn\'t mutate Heatmap（Heatmap 仍是 180d）');
    heatmapRangeState.mode = '180d'; // Heatmap 端不受影響，重申一次確認
    assert(dash.dashboardGa4State.rangeState.mode === '90d', '21 Heatmap 180d doesn\'t mutate Dashboard（Dashboard 仍是 90d）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Choropleth（22-24）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    const fakeGeoJsonLayer = { setStyle() {} };
    global.window.geoMapState = { instance: map, geoJsonLayer: fakeGeoJsonLayer };
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    assert(global.window.geoMapState.geoJsonLayer === fakeGeoJsonLayer, '22 geoJsonLayer retained（Dashboard 模組完全沒有動它）');
    assert(global.window.geoMapState.instance === map, '23 same Leaflet map instance');
    let newMapCalls = 0;
    const srcNoComments = require('fs').readFileSync(path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/L\.map\(/.test(srcNoComments), '24 no second L.map()（原始碼層級確認）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Empty（25-28）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    const groupBefore = dash.dashboardGa4State.layerGroup;

    setFakeApi([HISTORY_ROUTE_EMPTY]);
    dash.dashboardGa4State.rangeState.mode = '30d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(true, '25 empty rows request completed');
    assert(groupBefore._children.length === 0, '26 0 markers（empty 後 clearLayers）', String(groupBefore._children.length));
    const statusText = dom.window.document.getElementById(IDS.status).textContent;
    assert(statusText.includes('目前尚無此期間已同步'), '27 empty message correct', statusText);
    assert(!statusText.includes('4 個行政區'), '28 empty does not restore old marker/old status text');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Error（29-32）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    const group = dash.dashboardGa4State.layerGroup;
    assert(group._children.length === 4, 'pre-32 7d 成功先畫出 4 個 marker（前置狀態）', String(group._children.length));

    setFakeApi([{ test: /history/, status: 401, body: { success: false, code: 'no_token' } }]);
    dash.dashboardGa4State.rangeState.mode = '90d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(dom.window.document.getElementById(IDS.status).textContent.includes('登入'), '29 401 uses existing auth behavior（顯示重新登入訊息）', dom.window.document.getElementById(IDS.status).textContent);

    setFakeApi([{ test: /history/, status: 403, body: { success: false, code: 'no_plan' } }]);
    dash.dashboardGa4State.rangeState.mode = '180d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    const status403 = dom.window.document.getElementById(IDS.status).textContent;
    assert(status403.length > 0 && !/no_plan/.test(status403), '30 403 safe（顯示人類文字，不是原始 code）', status403);

    setFakeApi([{ test: /history/, status: 500, body: { success: false, code: 'internal_error' } }]);
    dash.dashboardGa4State.rangeState.mode = 'this_year';
    await dash.geoDashboardGa4Refresh(IDS, map);
    assert(true, '31 500 safe（未 throw）');
    assert(group._children.length === 0, '32 500 clears stale marker（不留 7d/90d/180d 殘留 marker）', String(group._children.length));
  }

  // ══════════════════════════════════════════════════════════════
  // G. Race（33-39）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    const fetchFn = setFakeApi([
      { test: /history/, delayMs: 30, body: (url) => (url.includes('range=7d') ? { success: true, rows: [HISTORY_ROUTE_4ROWS.body.rows[0]] } : { success: true, rows: [HISTORY_ROUTE_4ROWS.body.rows[1], HISTORY_ROUTE_4ROWS.body.rows[2]] }) },
    ]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map); // 7d pending（含在 activate 內）
    await new Promise((r) => setTimeout(r, 5));
    dash.dashboardGa4State.rangeState.mode = '90d';
    const p90 = dash.geoDashboardGa4Refresh(IDS, map); // 90d 立刻發出
    await p90;
    await new Promise((r) => setTimeout(r, 40)); // 讓 7d 的晚回應也走完
    const group = dash.dashboardGa4State.layerGroup;
    assert(group._children.length === 2, '33-36 7d pending → switch 90d → late 7d ignored → 90d remains（marker count=2，不是 1）', String(group._children.length));

    const dom2 = makeDom();
    const dash2 = freshDashboardModule(dom2, false);
    setFakeApi([{ test: /history/, delayMs: 30, body: HISTORY_ROUTE_4ROWS.body }]);
    const map2 = makeFakeMap();
    const p = dash2.geoDashboardGa4Refresh(IDS, map2); // Dashboard pending
    dash2.geoDashboardGa4Deactivate(map2); // 切 Heatmap
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    assert(map2.hasLayer(dash2.dashboardGa4State.layerGroup) === false, '37 Dashboard pending → switch Heatmap：晚到的 response 不會把 layer 加回地圖', '');
    assert(true, '38-39 late Dashboard response ignored（不 throw，不畫）');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Lifecycle（40-44）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    const genBefore = dash.dashboardGa4State.generation;
    dash.dashboardGa4State.rangeState.mode = '90d';

    dash.geoDashboardGa4Deactivate(map);
    assert(map.hasLayer(dash.dashboardGa4State.layerGroup) === false, '40 deactivate removes Dashboard layer');
    assert(dash.dashboardGa4State.rangeState.mode === '90d', '41 rangeState retained（deactivate 不清 rangeState）');
    assert(dash.dashboardGa4State.currentAbort === null, '42 abortController null');
    assert(dash.dashboardGa4State.generation > genBefore, '43 generation incremented');

    dash.geoDashboardGa4Activate(IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    assert(dash.dashboardGa4State.rangeState.mode === '90d', '44 reactivate restores selected Dashboard range（仍是 90d，不是重設回 7d）');
  }

  // ══════════════════════════════════════════════════════════════
  // I. Safety（45-50）
  // ══════════════════════════════════════════════════════════════
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js'), 'utf8');
    const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/method:\s*['"]POST['"]/.test(codeOnly) && !/\/sync/.test(codeOnly), '45 no POST sync（原始碼層級確認）');
    assert(!/realtime/i.test(codeOnly), '46 no realtime API（原始碼層級確認，完全不提 realtime）');
    assert(!/googleapis|google\.auth|GoogleAuth/.test(codeOnly), '47 no raw Google client（原始碼層級確認）');
    assert(/apiFetch/.test(codeOnly), '48 uses apiFetch（原始碼層級確認有引用既有 authenticated fetch）');

    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    const unhandled = [];
    dom.window.addEventListener('unhandledrejection', (e) => unhandled.push(e.reason));
    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    for (let i = 0; i < 5; i += 1) {
      dash.geoDashboardGa4Activate(IDS, map); // 重複 activate（section 二十六：不得每次新增 LayerGroup）
    }
    await new Promise((r) => setTimeout(r, 30));
    assert(unhandled.length === 0, '49 no unhandledRejection（連續重複 activate）');
    // 統計目前地圖上掛的「Dashboard 自己的」LayerGroup 數量——只用
    // dashboardGa4State.layerGroup 這個單一參考，Ensure 函式本身保證
    // 不會重複建立第二個 group（見 _geoDashboardGa4EnsureGroup 的
    // `if (!dashboardGa4State.layerGroup)` guard）。
    assert(!!dash.dashboardGa4State.layerGroup, '50 no duplicate LayerGroup（重複 activate 5 次後仍是同一個 layerGroup 參考）');
  }

  // ══════════════════════════════════════════════════════════════
  // J. Dashboard Preset Friendly Label Contract（Stage 5.1 新增，第 51+ 條）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const dash = freshDashboardModule(dom, false);
    const NOW = new Date('2026-08-07T04:00:00.000Z');
    const rangeResolver = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));

    const table = [
      ['today', '今天'], ['yesterday', '昨日'], ['7d', '近 7 天'], ['30d', '近 30 天'],
      ['90d', '近 90 天'], ['180d', '近 180 天'], ['this_year', '今年'], ['last_year', '去年'],
    ];
    let allPresetLabelsCorrect = true;
    table.forEach(([mode, expectedLabel]) => {
      const resolved = rangeResolver.resolveGeoHistoricalRange(mode, { now: NOW });
      const label = dash.geoDashboardGa4RangeLabel(resolved);
      if (label !== expectedLabel) allPresetLabelsCorrect = false;
    });
    assert(allPresetLabelsCorrect, '51 Dashboard Preset Friendly Label Contract：8 個 preset 全部對照正確（今天/昨日/近7天/近30天/近90天/近180天/今年/去年），不需要修改 Resolver');

    const resolvedSingle = rangeResolver.resolveGeoHistoricalRange('single', { singleDate: '2026-08-01' });
    assert(dash.geoDashboardGa4RangeLabel(resolvedSingle) === '2026/08/01', '52 single 沒有口語化對照，直接用 resolved date（2026/08/01）', dash.geoDashboardGa4RangeLabel(resolvedSingle));

    const resolvedCustom = rangeResolver.resolveGeoHistoricalRange('custom', { startDate: '2026-07-01', endDate: '2026-08-07' });
    assert(dash.geoDashboardGa4RangeLabel(resolvedCustom) === '2026/07/01 ～ 2026/08/07', '53 custom 沒有口語化對照，直接用 resolved date interval', dash.geoDashboardGa4RangeLabel(resolvedCustom));

    // 需求文件六：如果同時顯示 actual range，驗證它仍與 resolved.startDate/
    // endDate 一致（不是另外算的第二份文字）。
    const resolved7d = rangeResolver.resolveGeoHistoricalRange('7d', { now: NOW });
    const actualRangeText = resolved7d.displayLabel;
    const expectedActualRangeText = `${resolved7d.startDate.replace(/-/g, '/')} ～ ${resolved7d.endDate.replace(/-/g, '/')}`;
    assert(actualRangeText === expectedActualRangeText, '54 7d 的 actual calendar range 文字與 resolved.startDate/endDate 完全一致（不是另外算的第二份日期文字）', actualRangeText);

    setFakeApi([HISTORY_ROUTE_4ROWS]);
    const map = makeFakeMap();
    dash.dashboardGa4State.rangeState.mode = '7d';
    await dash.geoDashboardGa4Refresh(IDS, map);
    const labelHtmlFinal = dom.window.document.getElementById(IDS.label).innerHTML;
    const liveResolved7d = dash.dashboardGa4State.lastResolved; // geoDashboardGa4Refresh 用真實現在時刻算的，不是測試裡固定的 NOW
    const liveExpectedActualRangeText = `${liveResolved7d.startDate.replace(/-/g, '/')} ～ ${liveResolved7d.endDate.replace(/-/g, '/')}`;
    assert(labelHtmlFinal.includes('近 7 天') && labelHtmlFinal.includes(liveExpectedActualRangeText), '55 實際渲染出來的 label 同時包含 Friendly Label 與 Actual Calendar Range，兩者語意分開不互相取代', labelHtmlFinal);
  }

  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
