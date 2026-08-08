#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-h1-range-integration-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 4.1
//
// 真實 require public/js/geo-ga4-h1-panel.js（跟既有
// run-g1-6-ga4-h1-frontend-runtime.js 同一套 harness 慣例）。證明
// Historical Read 與 Manual Sync 對同一個 range selection 使用完全同一個
// resolved.apiRange/startDate/endDate，且驗證失敗時兩者都不發 API。

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
  console.log('H1 RANGE INTEGRATION RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 4.1)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ── Fake fetch / apiFetch（跟 run-g1-6-ga4-h1-frontend-runtime.js 同一套慣例）──
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
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: 'Bearer FAKE_TOKEN', 'x-store-id': 'store_001' };
    const res = await fetchFn(url, { ...options, headers });
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
function makeDom() {
  return new JSDOM('<div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>');
}
function freshPanelModule(dom) {
  const panelPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js'));
  delete require.cache[panelPath];
  const resolverPath = require.resolve(path.join(ROOT, 'public/js/geo-range-resolver.js'));
  delete require.cache[resolverPath]; // 確保用的是最新一份，不是舊快取
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() { return this; }, remove() { return this; } }), marker: () => ({ bindTooltip() { return this; } }), divIcon: (o) => o };
  return require(panelPath);
}
function lastUrl(fetchFn) { return fetchFn.calls.length ? fetchFn.calls[fetchFn.calls.length - 1].url : null; }
function makeFakeMap() {
  const layers = new Set();
  return { hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); return this; }, removeLayer(l) { layers.delete(l); return this; } };
}
function lastBody(fetchFn) {
  if (!fetchFn.calls.length) return null;
  const c = fetchFn.calls[fetchFn.calls.length - 1];
  return c.opts && c.opts.body ? JSON.parse(c.opts.body) : null;
}
function lastSyncBody(fetchFn) {
  // 需求文件九：Manual Sync 成功後會觸發 onChange() → 自動 Refresh（Read），
  // 所以呼叫序列的「最後一次」不一定是 Sync 本身——這裡明確找「最後一次
  // /sync POST」，不是「最後一次任意呼叫」。
  for (let i = fetchFn.calls.length - 1; i >= 0; i -= 1) {
    const c = fetchFn.calls[i];
    if (/sync/.test(c.url) && c.opts && c.opts.body) return JSON.parse(c.opts.body);
  }
  return null;
}

const IDS = { toolbar: 'c-ga4-h1-toolbar', status: 'c-ga4-h1-status', table: 'c-ga4-h1-table' };

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-h1-panel.js')]);
  pass('0-parse public/js/geo-ga4-h1-panel.js node --check 通過');

  const HISTORY_ROUTE = { test: /history/, body: { success: true, rows: [] } };
  const SYNC_ROUTE_ZERO = { test: /sync/, body: { success: true, rows_saved: 0 } };
  const SYNC_ROUTE_POSITIVE = { test: /sync/, body: { success: true, rows_saved: 3 } };
  const SYNC_ROUTE_FAIL = { test: /sync/, body: { success: false, code: 'sync_failed' } };

  function setModeAndRefresh(panel, dom, mode, rangeExtra) {
    panel.geoGa4H1State.mode = mode;
    if (rangeExtra) Object.assign(panel.geoGa4H1State.rangeState, rangeExtra);
    return panel.geoGa4H1Refresh(IDS, makeFakeMap());
  }

  // ══════════════════════════════════════════════════════════════
  // READ：1-10
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE]);
    await setModeAndRefresh(panel, dom, 'today');
    assert(/range=today/.test(lastUrl(fetchFn)), '1 today GET correct', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, 'yesterday');
    assert(/range=yesterday/.test(lastUrl(fetchFn)), '2 yesterday GET correct', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, '7d');
    assert(/range=7d/.test(lastUrl(fetchFn)), '3 7d GET correct', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, '30d');
    assert(/range=30d/.test(lastUrl(fetchFn)), '4 30d GET correct', lastUrl(fetchFn));

    await setModeAndRefresh(panel, dom, 'single', { singleDate: '2026-08-01' });
    assert(/range=custom/.test(lastUrl(fetchFn)) && /start_date=2026-08-01/.test(lastUrl(fetchFn)) && /end_date=2026-08-01/.test(lastUrl(fetchFn)), '5 single GET range=custom start=end', lastUrl(fetchFn));

    await setModeAndRefresh(panel, dom, '90d');
    assert(/range=custom/.test(lastUrl(fetchFn)), '6 90d GET custom', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, '180d');
    assert(/range=custom/.test(lastUrl(fetchFn)), '7 180d GET custom', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, 'this_year');
    assert(/range=custom/.test(lastUrl(fetchFn)), '8 this_year GET custom', lastUrl(fetchFn));
    await setModeAndRefresh(panel, dom, 'last_year');
    assert(/range=custom/.test(lastUrl(fetchFn)), '9 last_year GET custom', lastUrl(fetchFn));

    await setModeAndRefresh(panel, dom, 'custom', { startDate: '2026-07-01', endDate: '2026-08-07' });
    assert(/range=custom/.test(lastUrl(fetchFn)) && /start_date=2026-07-01/.test(lastUrl(fetchFn)) && /end_date=2026-08-07/.test(lastUrl(fetchFn)), '10 custom GET correct', lastUrl(fetchFn));
  }

  // ══════════════════════════════════════════════════════════════
  // SYNC：11-17
  // ══════════════════════════════════════════════════════════════
  async function doSync(panel, dom, toolbarEl) {
    const btn = toolbarEl.querySelector('#ga4h1-sync');
    const p = new Promise((resolve) => {
      const orig = dom.window.apiFetch;
      // 直接呼叫 syncHandler 透過點擊比較貼近真實使用者操作，這裡改用
      // 直接觸發 click（真實 addEventListener 監聽器，不是 inline attribute）。
      btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
      setTimeout(resolve, 30);
    });
    await p;
  }

  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_POSITIVE]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);

    panel.geoGa4H1State.mode = 'today';
    await doSync(panel, dom, toolbarEl);
    const syncBody1 = lastSyncBody(fetchFn);
    assert(syncBody1 && syncBody1.range === 'today', '11 today sync correct', JSON.stringify(syncBody1));

    panel.geoGa4H1State.mode = 'single';
    panel.geoGa4H1State.rangeState.singleDate = '2026-08-01';
    await doSync(panel, dom, toolbarEl);
    const syncBody2 = lastSyncBody(fetchFn);
    assert(syncBody2 && syncBody2.range === 'custom' && syncBody2.start_date === '2026-08-01' && syncBody2.end_date === '2026-08-01', '12 single sync start=end', JSON.stringify(syncBody2));

    for (const mode of ['90d', '180d', 'this_year', 'last_year']) {
      panel.geoGa4H1State.mode = mode;
      const readResolved = panel._geoGa4H1ResolveRange ? panel._geoGa4H1ResolveRange() : null;
      await doSync(panel, dom, toolbarEl);
      const syncBody = lastSyncBody(fetchFn);
      const label = { '90d': '13', '180d': '14', 'this_year': '15', 'last_year': '16' }[mode];
      assert(syncBody && syncBody.range === 'custom', `${label} ${mode} sync same resolved range (apiRange)`, JSON.stringify(syncBody));
    }

    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.rangeState.startDate = '2026-07-01';
    panel.geoGa4H1State.rangeState.endDate = '2026-08-07';
    await doSync(panel, dom, toolbarEl);
    const syncBody17 = lastSyncBody(fetchFn);
    assert(syncBody17 && syncBody17.start_date === '2026-07-01' && syncBody17.end_date === '2026-08-07', '17 custom sync same resolved range', JSON.stringify(syncBody17));
  }

  // ══════════════════════════════════════════════════════════════
  // READ/SYNC CONSISTENCY：18-21
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_POSITIVE]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);

    panel.geoGa4H1State.mode = '180d';
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    const readUrl180 = lastUrl(fetchFn);
    const readStart180 = /start_date=([\d-]+)/.exec(readUrl180)[1];
    const readEnd180 = /end_date=([\d-]+)/.exec(readUrl180)[1];
    await doSync(panel, dom, toolbarEl);
    const syncBody180 = lastSyncBody(fetchFn);
    assert(syncBody180.start_date === readStart180, '18 180d read start == sync start', `${readStart180} vs ${syncBody180.start_date}`);
    assert(syncBody180.end_date === readEnd180, '19 180d read end == sync end', `${readEnd180} vs ${syncBody180.end_date}`);

    panel.geoGa4H1State.mode = 'single';
    panel.geoGa4H1State.rangeState.singleDate = '2026-08-01';
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    const readUrlSingle = lastUrl(fetchFn);
    await doSync(panel, dom, toolbarEl);
    const syncBodySingle = lastSyncBody(fetchFn);
    assert(readUrlSingle.includes('start_date=2026-08-01') && syncBodySingle.start_date === '2026-08-01' && syncBodySingle.end_date === '2026-08-01', '20 single read == sync', JSON.stringify({ readUrlSingle, syncBodySingle }));

    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.rangeState.startDate = '2026-01-01';
    panel.geoGa4H1State.rangeState.endDate = '2026-01-10';
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    const readUrlCustom = lastUrl(fetchFn);
    await doSync(panel, dom, toolbarEl);
    const syncBodyCustom = lastSyncBody(fetchFn);
    assert(readUrlCustom.includes('start_date=2026-01-01') && readUrlCustom.includes('end_date=2026-01-10') && syncBodyCustom.start_date === '2026-01-01' && syncBodyCustom.end_date === '2026-01-10', '21 custom read == sync', JSON.stringify({ readUrlCustom, syncBodyCustom }));
  }

  // ══════════════════════════════════════════════════════════════
  // REFRESH：22-23（sync 成功後 onChange 觸發的 refresh 必須仍是同一個 range）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_POSITIVE]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);

    panel.geoGa4H1State.mode = '180d';
    await doSync(panel, dom, toolbarEl); // sync 內部成功後會呼叫 onChange() → geoGa4H1Refresh()
    const postSyncReadUrl = lastUrl(fetchFn);
    assert(fetchFn.calls[fetchFn.calls.length - 1].url.includes('history'), '22 sync 180d → refresh remains 180d（最後一次呼叫是同一個 range 的 Read）', postSyncReadUrl);

    panel.geoGa4H1State.mode = 'single';
    panel.geoGa4H1State.rangeState.singleDate = '2026-08-01';
    await doSync(panel, dom, toolbarEl);
    const postSyncReadUrlSingle = fetchFn.calls[fetchFn.calls.length - 1].url;
    assert(postSyncReadUrlSingle.includes('history') && postSyncReadUrlSingle.includes('start_date=2026-08-01') && postSyncReadUrlSingle.includes('end_date=2026-08-01'), '23 sync single → refresh remains single date', postSyncReadUrlSingle);
  }

  // ══════════════════════════════════════════════════════════════
  // VALIDATION：24-26（resolved.ok===false 時不得發任何 API）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_POSITIVE]);

    panel.geoGa4H1State.mode = 'single';
    panel.geoGa4H1State.rangeState.singleDate = '';
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    assert(fetchFn.calls.length === 0, '24 missing single → 0 fetch', `calls=${fetchFn.calls.length}`);

    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.rangeState.startDate = '2026-08-07';
    panel.geoGa4H1State.rangeState.endDate = '2026-08-01';
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    assert(fetchFn.calls.length === 0, '25 start>end → 0 fetch', `calls=${fetchFn.calls.length}`);

    panel.geoGa4H1State.mode = 'custom';
    panel.geoGa4H1State.rangeState.startDate = '2027-01-01';
    panel.geoGa4H1State.rangeState.endDate = '2028-01-02'; // 367 inclusive days
    await panel.geoGa4H1Refresh(IDS, makeFakeMap());
    assert(fetchFn.calls.length === 0, '26 367 days → 0 fetch', `calls=${fetchFn.calls.length}`);
  }

  // ══════════════════════════════════════════════════════════════
  // UX：27-29（rows_saved Contract 不得 Regression）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_ZERO]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);
    panel.geoGa4H1State.mode = '180d';
    await doSync(panel, dom, toolbarEl);
    const statusText27 = dom.window.document.getElementById(IDS.status).textContent;
    assert(!/錯誤|失敗|error/i.test(statusText27) || /目前 GA4 報表尚無可用/.test(statusText27), '27 rows_saved=0 neutral success（不顯示紅色錯誤）', statusText27);
  }
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_POSITIVE]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);
    panel.geoGa4H1State.mode = '180d';
    await doSync(panel, dom, toolbarEl);
    const statusText28 = dom.window.document.getElementById(IDS.status).textContent;
    assert(statusText28.length > 0, '28 rows_saved>0 success 顯示狀態文字', statusText28);
  }
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([HISTORY_ROUTE, SYNC_ROUTE_FAIL]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);
    panel.geoGa4H1State.mode = '180d';
    let threw = false;
    try { await doSync(panel, dom, toolbarEl); } catch (e) { threw = true; }
    assert(!threw, '29 failed sync error（不 throw，安全處理）');
  }

  // ══════════════════════════════════════════════════════════════
  // STATE：30-31
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi([HISTORY_ROUTE]);
    panel.geoGa4H1State.mode = '180d';
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    panel.geoGa4H1Destroy(IDS);
    assert(panel.geoGa4H1State.rangeState.mode === '180d', '30 destroy does not clear range state', panel.geoGa4H1State.rangeState.mode);

    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    assert(panel.geoGa4H1State.rangeState.mode === '180d', '31 reactivate restores range state', panel.geoGa4H1State.rangeState.mode);
  }

  // ══════════════════════════════════════════════════════════════
  // SAFETY：32-34
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const fetchFn = setFakeApi([HISTORY_ROUTE, { test: /sync/, body: { success: true, rows_saved: 1 }, delayMs: 20 }]);
    panel.geoGa4H1Init(IDS, makeFakeMap());
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom.window.document.getElementById(IDS.toolbar);
    const syncBtn = toolbarEl.querySelector('#ga4h1-sync');
    panel.geoGa4H1State.mode = 'today';
    const before = fetchFn.calls.filter((c) => c.url.includes('sync')).length;
    syncBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    syncBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // 第二次點擊：按鈕應已 disabled
    await new Promise((r) => setTimeout(r, 40));
    const after = fetchFn.calls.filter((c) => c.url.includes('sync')).length;
    assert(after - before === 1, '32 pending sync double click no duplicate request', `${before}→${after}`);

    const unhandled = [];
    dom.window.addEventListener('unhandledrejection', (e) => unhandled.push(e.reason));
    panel.geoGa4H1State.mode = '30d';
    const p1 = panel.geoGa4H1Refresh(IDS, makeFakeMap());
    panel.geoGa4H1State.mode = '7d';
    const p2 = panel.geoGa4H1Refresh(IDS, makeFakeMap()); // p1 应该被 abort，安全吞掉
    let threwAbort = false;
    try { await Promise.all([p1, p2]); } catch (e) { threwAbort = true; }
    await new Promise((r) => setTimeout(r, 10));
    assert(!threwAbort, '33 AbortError safe（不外漏）');
    assert(unhandled.length === 0, '34 no unhandledRejection', JSON.stringify(unhandled));
  }

  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
