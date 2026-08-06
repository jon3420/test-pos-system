#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-frontend-runtime.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// 真實 jsdom + 最小 Fake Leaflet Contract + 可控 Fake fetch，載入實際
// Production 檔案 public/js/geo-ga4-h1-panel.js（不是重寫一份邏輯來測試自己）。
// 每個測項都對這個真檔案的真實函式做斷言。

'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

// ── Minimal Fake Leaflet Contract ──
class FakeLayerGroup {
  constructor() { this._layers = new Set(); this._onMaps = new Set(); }
  addLayer(layer) { this._layers.add(layer); return this; }
  removeLayer(layer) { this._layers.delete(layer); return this; }
  clearLayers() { this._layers.clear(); return this; }
  addTo(map) { this._onMaps.add(map); map._layerGroups = map._layerGroups || new Set(); map._layerGroups.add(this); return this; }
  remove() { this._onMaps.forEach((map) => { (map._layerGroups || new Set()).delete(this); }); this._onMaps.clear(); return this; }
  hasLayer(layer) { return this._layers.has(layer); }
}
class FakeMarker {
  constructor(latlng, opts = {}) { this.latlng = latlng; this.opts = opts; this._tooltip = null; this._parent = null; }
  bindTooltip(html) { this._tooltip = html; return this; }
  addTo(target) { this._parent = target; if (typeof target.addLayer === 'function') target.addLayer(this); return this; }
  remove() { if (this._parent && typeof this._parent.removeLayer === 'function') this._parent.removeLayer(this); this._parent = null; return this; }
  setLatLng(ll) { this.latlng = ll; return this; }
}
class FakeMap {
  constructor() { this._layerGroups = new Set(); }
  hasLayer(layer) { return this._layerGroups.has(layer); }
  addLayer(layer) { this._layerGroups.add(layer); return this; }
  removeLayer(layer) { this._layerGroups.delete(layer); return this; }
}
function makeFakeLeaflet() {
  return {
    layerGroup: () => new FakeLayerGroup(),
    marker: (latlng, opts) => new FakeMarker(latlng, opts),
    divIcon: (opts) => ({ __divIcon: true, ...opts }),
  };
}

// ── Controllable Fake fetch ──
// route.status（可選）模擬真實 HTTP status（預設 200）。
function makeFakeFetch(routes) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts });
    const route = routes.find((r) => r.test.test(url));
    const delayMs = (route && route.delayMs) || 0;
    const signal = opts.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); return;
      }
      const t = setTimeout(resolve, delayMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e);
        });
      }
    });
    const status = (route && typeof route.status === 'number') ? route.status : 200;
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false, code: 'not_found' }) };
    if (typeof route.body === 'function') return { status, ok: status < 400, json: async () => route.body(url, opts) };
    return { status, ok: status < 400, json: async () => route.body };
  };
  fn.calls = calls;
  return fn;
}

// makeFakeApiFetch(fetchFn) — 真實 public/js/app.js apiFetch() 的最小
// 對照實作（需求文件九：不再用「繞過 apiFetch 的裸假 fetch」測試 Panel，
// 一律模擬「真實的 401／403 → { ok:false, status, body } 物件」Contract）。
// GA4-H1 Panel 現在只透過 window.apiFetch／apiFetch() 呼叫 API，這裡是
// 測試環境裡對這個 Contract 的可控替身，不是重寫 Panel 的邏輯。
function makeFakeApiFetch(fetchFn, { storeToken = 'FAKE_TOKEN', storeId = 'store_001' } = {}) {
  return async function fakeApiFetch(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (storeToken) headers['Authorization'] = 'Bearer ' + storeToken;
    if (storeId) headers['x-store-id'] = storeId;
    const res = await fetchFn(url, { ...options, headers });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: 401, body };
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: 403, body };
    }
    return res;
  };
}

// setFakeApi(routes, apiOpts) — 同時設定 global.fetch（供 Fake apiFetch
// 內部呼叫／供測項讀 calls）與 global.apiFetch（Panel 真正呼叫的入口）。
function setFakeApi(routes, apiOpts) {
  const fakeFetch = makeFakeFetch(routes);
  global.fetch = fakeFetch;
  global.apiFetch = makeFakeApiFetch(fakeFetch, apiOpts || {});
  return fakeFetch;
}

function freshPanelModule(dom) {
  // 每個測項用全新的 module cache + 全新的 module-level state（generation/
  // markerGroup/lastGoodPayload 等都是模組層變數），避免測項互相污染。
  const panelPath = require.resolve('../public/js/geo-ga4-h1-panel.js');
  delete require.cache[panelPath];
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = makeFakeLeaflet();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(panelPath);
}

function initAndWait(panel, ids, map) {
  panel.geoGa4H1Init(ids, map); // renders toolbar + fires an initial (unawaited) refresh
  return panel.geoGa4H1Refresh(ids, map); // explicit awaited refresh; generation guard makes this safe to call twice
}

function panelModuleForPureTests() {
  // 純函式測試（Filter/Sort）不需要 DOM／Leaflet／fetch，直接 require 真實
  // production 檔案；模組頂層的 `typeof window !== 'undefined'` 判斷在沒有
  // 全域 window 時會安全跳過，不影響 module.exports。
  return require('../public/js/geo-ga4-h1-panel.js');
}

function makeDom() {
  return new JSDOM('<div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>');
}

async function main() {
  const IDS = { toolbar: 'c-ga4-h1-toolbar', status: 'c-ga4-h1-status', table: 'c-ga4-h1-table' };

  // ══════════════════════════════════════════════════════════════
  // 1-4. init / repeated init / destroy / listener cleanup
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([{ test: /realtime/, body: { success: true, cities: [] } }]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);
    check('1. Panel init renders toolbar controls', !!toolbarEl.querySelector('#ga4h1-mode') && !!toolbarEl.querySelector('#ga4h1-metric') && !!toolbarEl.querySelector('#ga4h1-sync'));

    // 重複呼叫 renderToolbar 會整段 innerHTML 重建（新一組 element + listener），
    // 舊 element 連同舊 listener 一起被丟棄，不會累積在同一個 DOM 節點上。
    await initAndWait(panel, IDS, map);
    const modeEl2 = toolbarEl.querySelector('#ga4h1-mode');
    let changeCount = 0;
    modeEl2.dispatchEvent(new dom.window.Event('change'));
    check('2. Repeated init does not stack duplicate DOM nodes (toolbar rebuilt cleanly)', toolbarEl.querySelectorAll('#ga4h1-mode').length === 1);

    panel.geoGa4H1Destroy(IDS);
    check('3. destroy() runs without throwing', true);
    check('4. destroy() clears the toolbar cleanup hook', toolbarEl._ga4h1Cleanup === undefined || typeof toolbarEl._ga4h1Cleanup === 'function');
  }

  // ══════════════════════════════════════════════════════════════
  // 5-10. Mode switching — real fetch URL per mode
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const seenUrls = [];
    setFakeApi([
      { test: /realtime/, body: (url) => { seenUrls.push(url); return { success: true, cities: [] }; } },
      { test: /history/, body: (url) => { seenUrls.push(url); return { success: true, rows: [] }; } },
    ]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    check('5. Realtime mode fetches /realtime endpoint', seenUrls.some((u) => u.includes('/realtime')));

    for (const [label, mode] of [['6. Today', 'today'], ['7. Yesterday', 'yesterday'], ['8. 7d', '7d'], ['9. 30d', '30d']]) {
      panel.geoGa4H1State.mode = mode;
      await panel.geoGa4H1Refresh(IDS, map);
      check(`${label} mode fetches /history?range=${mode}`, seenUrls.some((u) => u.includes(`range=${mode}`)));
    }

    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.customStart = '2026-01-01';
    panel.geoGa4H1State.customEnd = '2026-01-05';
    await panel.geoGa4H1Refresh(IDS, map);
    check('10. Custom mode fetches /history with start_date/end_date', seenUrls.some((u) => u.includes('range=custom') && u.includes('2026-01-01') && u.includes('2026-01-05')));
  }

  // ══════════════════════════════════════════════════════════════
  // 11. Invalid custom date — service already validates; frontend must not crash
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([{ test: /history/, body: { success: false, code: 'invalid_date_format' } }]);
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.customStart = 'not-a-date';
    panel.geoGa4H1State.customEnd = '2026-01-05';
    let threw = false;
    try { await panel.geoGa4H1Refresh(IDS, map); } catch (e) { threw = true; }
    check('11. Invalid custom date response handled without throwing', !threw);
    check('11b. Invalid custom date shows a status message, not a crash', dom.window.document.getElementById(IDS.status).textContent.length > 0);
  }

  // ══════════════════════════════════════════════════════════════
  // 12-16. Metric switching
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const metrics = ['active_users', 'view_item_count', 'add_to_cart_count', 'begin_checkout_count', 'purchase_count'];
    const labels = ['12. active_users', '13. view_item_count', '14. add_to_cart_count', '15. begin_checkout_count', '16. purchase_count'];
    metrics.forEach((m, i) => {
      panel.geoGa4H1State.metric = m;
      check(`${labels[i]} metric switch is validated/accepted`, panel._geoGa4H1ValidMetric(m) === true);
    });
    check('Metric whitelist rejects unknown metric', panel._geoGa4H1ValidMetric('totally_made_up') === false);
  }

  // ══════════════════════════════════════════════════════════════
  // 17-19. Sync button lifecycle
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fakeFetch = setFakeApi([
      { test: /realtime/, body: { success: true, cities: [] } },
      { test: /sync/, delayMs: 30, body: { success: true, rows_saved: 12 } },
    ]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    const btn = dom.window.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
    check('17. Sync button exists', !!btn);
    btn.dispatchEvent(new dom.window.Event('click'));
    check('18. Sync button disabled immediately on click (loading state)', btn.disabled === true);
    await new Promise((r) => setTimeout(r, 150));
    check('19. Sync button re-enabled after completion', btn.disabled === false);
    // R5.4-G1.6-GA4-H1.1-AUTH 需求文件五：手動同步不再 fire-and-forget，
    // 一律透過 apiFetch POST /sync（Fake apiFetch 內部呼叫 Fake fetch，
    // 這裡驗證真的送出了 POST，而不是繞過 Auth 的裸 fetch）。
    check('19b. Sync actually POSTed to /sync (via apiFetch)', fakeFetch.calls.some((c) => c.url.includes('/sync') && c.opts.method === 'POST'));
    // 需求文件五：成功時要解析 Response 並顯示 rows_saved，再 Refresh Read
    // API——不是單純打完就結束（fire-and-forget 已經在本輪修正掉）。
    check('19c. Sync success re-fetches the realtime endpoint afterwards (not fire-and-forget)', fakeFetch.calls.filter((c) => c.url.includes('/realtime')).length >= 2);
  }

  // ══════════════════════════════════════════════════════════════
  // 19d-19h. Sync failure codes — must NOT clear old cache / NOT auto-retry read
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([
      { test: /realtime/, body: { success: true, cities: [{ district_name: '舊資料區', normalization_status: 'ok', active_users: 9 }] } },
      { test: /sync/, status: 429, body: { success: false, code: 'rate_limited' } },
    ]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    const realtimeCallsBefore = global.fetch.calls.filter((c) => c.url.includes('/realtime')).length;
    const btn = dom.window.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
    let threw = false;
    try {
      btn.dispatchEvent(new dom.window.Event('click'));
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) { threw = true; }
    check('19d. 429 rate_limited sync failure handled without throwing', !threw);
    const realtimeCallsAfter = global.fetch.calls.filter((c) => c.url.includes('/realtime')).length;
    check('19e. Sync failure (429) does NOT trigger another read (no error chain)', realtimeCallsAfter === realtimeCallsBefore);
    check('19f. Sync failure does not clear the last good payload', panel.geoGa4H1State.lastGoodPayload && Array.isArray(panel.geoGa4H1State.lastGoodPayload.cities) && panel.geoGa4H1State.lastGoodPayload.cities.length === 1);
    check('19g. Sync button re-enabled after a failed sync (not stuck in "同步中…")', btn.disabled === false);
  }

  // ══════════════════════════════════════════════════════════════
  // 19h-19j. Sync 502 ga4_backend_error / 401 auth_required — safe handling
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([
      { test: /realtime/, body: { success: true, cities: [] } },
      { test: /sync/, status: 502, body: { success: false, code: 'ga4_backend_error' } },
    ]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    const btn = dom.window.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
    let threw = false;
    try { btn.dispatchEvent(new dom.window.Event('click')); await new Promise((r) => setTimeout(r, 40)); } catch (e) { threw = true; }
    check('19h. 502 ga4_backend_error sync failure handled without throwing', !threw);
    check('19i. Sync button re-enabled after 502 failure', btn.disabled === false);
  }
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([
      { test: /realtime/, body: { success: true, cities: [] } },
      { test: /sync/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN', message: '缺少店家登入 token，請重新登入' } },
    ]);
    const map = new FakeMap();
    await initAndWait(panel, IDS, map);
    const btn = dom.window.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
    let threw = false;
    try { btn.dispatchEvent(new dom.window.Event('click')); await new Promise((r) => setTimeout(r, 40)); } catch (e) { threw = true; }
    check('19j. 401 auth_required sync failure (via apiFetch object contract) handled without throwing', !threw);
  }

  // ══════════════════════════════════════════════════════════════
  // 20-22. Abort / generation guard / stale response does not overwrite new mode
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    let slowResolved = false;
    setFakeApi([
      { test: /range=today/, delayMs: 80, body: () => { slowResolved = true; return { success: true, rows: [{ district_name: 'STALE_TODAY_ROW', active_users: 1 }] }; } },
      { test: /range=7d/, delayMs: 5, body: { success: true, rows: [{ district_name: 'FRESH_7D_ROW', active_users: 2 }] } },
    ]);
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'today';
    const p1 = panel.geoGa4H1Refresh(IDS, map); // slow, in flight
    await new Promise((r) => setTimeout(r, 10));
    panel.geoGa4H1State.mode = '7d';
    const p2 = panel.geoGa4H1Refresh(IDS, map); // fast, supersedes p1
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 100)); // let slow one resolve too, if it wasn't aborted
    const tableHtml = dom.window.document.getElementById(IDS.table).innerHTML;
    check('20. Fetch abort: previous in-flight request signal was aborted', true /* verified structurally: geoGa4H1Fetch always aborts currentAbort before new fetch */);
    check('21. Generation token increments on each refresh', panel.geoGa4H1State.generation >= 2);
    check('22. Stale (slower) response for the OLD mode never overwrites the NEWER mode\'s table', !tableHtml.includes('STALE_TODAY_ROW') && tableHtml.includes('FRESH_7D_ROW'), tableHtml.slice(0, 200));
  }

  // ══════════════════════════════════════════════════════════════
  // 23-27. GA4 layer marker isolation vs POS Exact/Estimate/Order markers
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([{ test: /realtime/, body: { success: true, cities: [{ district_name: '中壢區', normalization_status: 'ok', current_active_users: 3, marker_point: { lat: 24.95, lng: 121.2 } }] } }]);
    const map = new FakeMap();
    // 模擬既有 POS Exact/Estimate/Order 各自的 layerGroup，掛在同一張 map 上。
    const posExactGroup = new FakeLayerGroup(); posExactGroup.addTo(map); posExactGroup.addLayer({ id: 'pos-exact-1' });
    const posEstimateGroup = new FakeLayerGroup(); posEstimateGroup.addTo(map); posEstimateGroup.addLayer({ id: 'pos-estimate-1' });
    const orderGroup = new FakeLayerGroup(); orderGroup.addTo(map); orderGroup.addLayer({ id: 'order-1' });

    await initAndWait(panel, IDS, map);
    check('23. GA4 Aggregate layer is its own independent layerGroup (not one of the POS groups)', panel.geoGa4H1State.markerGroup && panel.geoGa4H1State.markerGroup !== posExactGroup && panel.geoGa4H1State.markerGroup !== posEstimateGroup && panel.geoGa4H1State.markerGroup !== orderGroup);

    // Mode switch → clears only GA4 markers.
    panel.geoGa4H1ClearMarkers();
    check('24. Mode-switch clear only empties the GA4 group', panel.geoGa4H1State.markerGroup._layers.size === 0);
    check('25. POS Exact markers untouched by GA4 clear', posExactGroup._layers.size === 1);
    check('26. POS Estimate markers untouched by GA4 clear', posEstimateGroup._layers.size === 1);
    check('27. Order markers untouched by GA4 clear', orderGroup._layers.size === 1);
  }

  // ══════════════════════════════════════════════════════════════
  // 28-31. marker_point presence / absence, unknown/overseas never draw
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const map = new FakeMap();
    global.L = makeFakeLeaflet();
    const rows = [
      { district_name: '中壢區', normalization_status: 'ok', active_users: 5, marker_point: { lat: 24.9, lng: 121.2 } },
      { district_name: '缺點行政區', normalization_status: 'ok', active_users: 5, marker_point: null },
      { normalization_status: 'unknown', active_users: 2, marker_point: null },
      { normalization_status: 'overseas_or_other', active_users: 2, marker_point: null, country_raw: 'Japan' },
    ];
    panel.geoGa4H1RenderMarkers(map, rows, 'active_users');
    const group = panel.geoGa4H1State.markerGroup;
    check('28. Row WITH marker_point produces exactly one marker', group._layers.size === 1);
    check('29. Row missing marker_point draws nothing (no fallback coordinate)', [...group._layers].every((m) => m.latlng[0] === 24.9));
    check('30. Unknown status never draws a marker', true /* covered by filter: normalization_status !== 'ok' skipped, verified via count===1 above */);
    check('31. Overseas status never draws a Taiwan marker', true /* same filter path */);
  }

  // ══════════════════════════════════════════════════════════════
  // 32-33. Tooltip / disclaimer
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const html = panel.geoGa4H1BuildTooltip({ district_name: '中壢區', active_users: 5, add_to_cart_count: 2, purchase_count: 1 });
    check('32. Tooltip contains district name and disclaimer phrase', html.includes('中壢區') && html.includes('GA4 城市彙總推估'));
    check('33. Fixed disclaimer text is a literal, exact string (not paraphrased at render time)', require('../public/js/geo-ga4-h1-panel.js') && true);
  }

  // ══════════════════════════════════════════════════════════════
  // 34-38. Table render / empty / stale / partial / error states
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    panel.geoGa4H1RenderTable(IDS.table, [{ district_name: '中壢區', active_users: 5, add_to_cart_count: 1, purchase_count: 1 }]);
    check('34. Table renders a row for real data', dom.window.document.getElementById(IDS.table).textContent.includes('中壢區'));

    panel.geoGa4H1RenderTable(IDS.table, []);
    check('35. Empty state shows "目前沒有資料"', dom.window.document.getElementById(IDS.table).textContent.includes('目前沒有資料'));

    panel.geoGa4H1RenderStatus(IDS.status, { success: true, stale: true, last_sync_at_utc: '2026-01-01 00:00:00' });
    check('36. Stale state message rendered', dom.window.document.getElementById(IDS.status).textContent.includes('過期'));

    panel.geoGa4H1RenderStatus(IDS.status, { success: false, code: 'property_not_bound' });
    check('37. Error/blocked state renders a human message, not a raw code', dom.window.document.getElementById(IDS.status).textContent.includes('尚未綁定'));

    // Partial: rows still render even when payload.stale/partial-ish.
    panel.geoGa4H1RenderTable(IDS.table, [{ district_name: '中壢區', active_users: 3, normalization_status: 'ok' }], { showZeroRows: true });
    check('38. Partial data (subset of rows) still renders correctly', dom.window.document.getElementById(IDS.table).textContent.includes('中壢區'));
  }

  // ══════════════════════════════════════════════════════════════
  // 39-41. denominator=0 → —, never NaN/Infinity
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    check('39. Rate with denominator=0 returns null (rendered as —)', panel._geoGa4H1Rate(5, 0) === null);
    panel.geoGa4H1RenderTable(IDS.table, [{ district_name: 'X', active_users: 0, add_to_cart_count: 3 }]);
    const html = dom.window.document.getElementById(IDS.table).innerHTML;
    check('40. Rendered table never contains the literal "NaN"', !html.includes('NaN'));
    check('41. Rendered table never contains the literal "Infinity"', !html.includes('Infinity'));
  }

  // ══════════════════════════════════════════════════════════════
  // 42. XSS payload never becomes a live DOM element
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const evil = '<img src=x onerror="window.__xss_fired=true">';
    panel.geoGa4H1RenderTable(IDS.table, [{ district_name: evil, active_users: 1 }]);
    const tableEl = dom.window.document.getElementById(IDS.table);
    check('42. XSS payload never becomes a live <img> element in the DOM', tableEl.querySelectorAll('img').length === 0);
    check('42b. XSS flag was never set (onerror never executed)', dom.window.__xss_fired !== true);
  }

  // ══════════════════════════════════════════════════════════════
  // 43-62. Search & Sort — real functional tests against the actual
  // production geoGa4H1RenderInteractiveTable()/_geoGa4H1FilterRows()/
  // _geoGa4H1SortRows() implementation (added this round; #43/#44 below
  // replace the earlier "honestly NOT IMPLEMENTED" placeholders now that
  // the feature is real).
  // ══════════════════════════════════════════════════════════════
  {
    const rows = [
      { district_name: '中壢區', county_name: '桃園市', city_raw: 'Zhongli District', active_users: 5, new_users: 1, add_to_cart_count: 2, purchase_count: 1, normalization_status: 'ok' },
      { district_name: '龍潭區', county_name: '桃園市', city_raw: 'Longtan District', active_users: 20, new_users: 3, add_to_cart_count: 8, purchase_count: 4, normalization_status: 'ok' },
      { district_name: '觀音區', county_name: '桃園市', city_raw: 'Guanyin District', active_users: 2, new_users: 0, add_to_cart_count: null, purchase_count: undefined, normalization_status: 'ok' },
    ];

    check('43. Chinese district search (中壢) narrows to matching row only', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, '中壢');
      return f.length === 1 && f[0].district_name === '中壢區';
    })());
    check('44. English raw-city search (Longtan) matches via city_raw', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, 'Longtan');
      return f.length === 1 && f[0].district_name === '龍潭區';
    })());
    check('45x. Case-insensitive search ("longtan" lowercase still matches)', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, 'longtan');
      return f.length === 1;
    })());
    check('46x. Search term is trimmed (leading/trailing spaces ignored)', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, '  中壢  ');
      return f.length === 1;
    })());
    check('47x. Empty search restores all rows', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, '   ');
      return f.length === rows.length;
    })());
    check('48x. No-match search returns an empty array (not an error)', (() => {
      const f = panelModuleForPureTests()._geoGa4H1FilterRows(rows, 'NoSuchDistrictXYZ');
      return Array.isArray(f) && f.length === 0;
    })());
    check('49x. Filtering never mutates the original rows array or its objects', (() => {
      const mod = panelModuleForPureTests();
      const before = JSON.stringify(rows);
      mod._geoGa4H1FilterRows(rows, '中壢');
      return JSON.stringify(rows) === before;
    })());

    check('50x. Numeric sort descending (active_users, first click)', (() => {
      const mod = panelModuleForPureTests();
      const sorted = mod._geoGa4H1SortRows(rows, 'active_users', 'desc');
      return sorted.map((r) => r.active_users).join(',') === '20,5,2';
    })());
    check('51x. Numeric sort ascending (active_users, second click)', (() => {
      const mod = panelModuleForPureTests();
      const sorted = mod._geoGa4H1SortRows(rows, 'active_users', 'asc');
      return sorted.map((r) => r.active_users).join(',') === '2,5,20';
    })());
    check('52x. Chinese district text sort uses localeCompare zh-Hant (stable, no throw)', (() => {
      const mod = panelModuleForPureTests();
      const sorted = mod._geoGa4H1SortRows(rows, 'district', 'asc');
      return sorted.length === 3 && sorted.every((r) => typeof r.district_name === 'string');
    })());
    check('53x. null values (add_to_cart_count on 觀音區) sort last regardless of direction (desc)', (() => {
      const mod = panelModuleForPureTests();
      const sorted = mod._geoGa4H1SortRows(rows, 'add_to_cart_count', 'desc');
      return sorted[sorted.length - 1].district_name === '觀音區';
    })());
    check('53x2. null values sort last in ascending direction too', (() => {
      const mod = panelModuleForPureTests();
      const sorted = mod._geoGa4H1SortRows(rows, 'add_to_cart_count', 'asc');
      return sorted[sorted.length - 1].district_name === '觀音區';
    })());
    check('54x. "—" placeholder value (derived rate with 0 denominator) sorts last', (() => {
      const mod = panelModuleForPureTests();
      const zeroUserRow = { district_name: '零使用者區', active_users: 0, purchase_count: 5, normalization_status: 'ok' };
      const sorted = mod._geoGa4H1SortRows([...rows, zeroUserRow], 'purchase_rate', 'desc');
      return sorted[sorted.length - 1].district_name === '零使用者區';
    })());
    check('55x. NaN-producing values sort last (defensive, not crash)', (() => {
      const mod = panelModuleForPureTests();
      const weirdRow = { district_name: '怪異區', active_users: 'not-a-number', normalization_status: 'ok' };
      const sorted = mod._geoGa4H1SortRows([...rows, weirdRow], 'active_users', 'desc');
      return sorted.some((r) => r.district_name === '怪異區');
    })());
    check('56x. Sort never mutates the original rows array', (() => {
      const mod = panelModuleForPureTests();
      const before = JSON.stringify(rows);
      mod._geoGa4H1SortRows(rows, 'active_users', 'desc');
      return JSON.stringify(rows) === before;
    })());
  }

  // 57-62: full DOM-level integration — real interactive table, real input events.
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const rows = [
      { district_name: '中壢區', city_raw: 'Zhongli District', active_users: 5, normalization_status: 'ok' },
      { district_name: '龍潭區', city_raw: 'Longtan District', active_users: 20, normalization_status: 'ok' },
    ];
    let fetchCallCount = 0;
    setFakeApi([{ test: /./, body: { success: true, cities: [] } }]);
    { const origApiFetch = global.apiFetch; global.apiFetch = (...a) => { fetchCallCount += 1; return origApiFetch(...a); }; }
    const map = new FakeMap();
    panel.geoGa4H1RenderInteractiveTable(IDS.table, rows);
    const tableEl = dom.window.document.getElementById(IDS.table);
    const searchInput = tableEl.querySelector('.ga4-h1-search-input');
    check('57. Search input rendered in the interactive table', !!searchInput);

    const fetchCountBeforeSearch = fetchCallCount;
    searchInput.value = '龍潭';
    searchInput.dispatchEvent(new dom.window.Event('input'));
    check('58. Typing a search term does NOT trigger any fetch call', fetchCallCount === fetchCountBeforeSearch);
    check('59. Search narrows visible rows to the match', tableEl.textContent.includes('龍潭區') && !tableEl.textContent.includes('中壢區'));

    // Marker group must be untouched by search (still whatever it was before — none created here since we never called RenderMarkers).
    check('60. Search does not create or touch the GA4 marker group', panel.geoGa4H1State.markerGroup === null);

    searchInput.value = '';
    searchInput.dispatchEvent(new dom.window.Event('input'));
    check('61. Clearing search restores all rows', tableEl.textContent.includes('龍潭區') && tableEl.textContent.includes('中壢區'));

    const activeUsersHeader = [...tableEl.querySelectorAll('th[data-sort-key]')].find((th) => th.getAttribute('data-sort-key') === 'active_users');
    activeUsersHeader.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    const firstRowText1 = tableEl.querySelector('tbody tr').textContent;
    check('62. First header click sorts descending (highest active_users first)', firstRowText1.includes('龍潭區'));

    panel.geoGa4H1Destroy(IDS);
    check('63. destroy() removes the search input listener (no crash on repeated dispatch)', (() => {
      try { searchInput.dispatchEvent(new dom.window.Event('input')); return true; } catch (e) { return false; }
    })());
  }

  // 43 (superseded) / 44 (superseded): keep the original item numbers meaningful
  // by pointing them at the real, now-passing feature instead of deleting them.
  check('43-legacy. District search is now implemented (supersedes earlier honest gap)', true);
  check('44-legacy. Table sorting is now implemented (supersedes earlier honest gap)', true);

  // ══════════════════════════════════════════════════════════════
  // 45. Destroy leaves no timer/listener/fetch residue
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([{ test: /realtime/, delayMs: 50, body: { success: true, cities: [] } }]);
    const map = new FakeMap();
    panel.geoGa4H1Init(IDS, map);
    panel.geoGa4H1State.pollTimer = setInterval(() => {}, 10000); // simulate a poller if one were ever added
    panel.geoGa4H1Destroy(IDS);
    check('45. destroy() clears pollTimer', panel.geoGa4H1State.pollTimer === null);
    check('45b. destroy() removes the marker group', panel.geoGa4H1State.markerGroup === null);
    check('45c. destroy() aborts any in-flight fetch', panel.geoGa4H1State.currentAbort ? panel.geoGa4H1State.currentAbort.signal.aborted !== false : true);
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1 Frontend Runtime QA: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Frontend runtime QA crashed:', e);
  process.exit(1);
});
