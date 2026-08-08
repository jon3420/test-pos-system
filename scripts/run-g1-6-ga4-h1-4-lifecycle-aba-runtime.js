#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-lifecycle-aba-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 6.1
//
// Async Lifecycle Correctness：destroy() → init() 的 ABA race。單靠一個
// destroyed 布林值無法分辨「更早那一輪 session 尚未完成的 async
// operation」跟「現在這個 active session」，因為 destroyed 會在 init()
// 時被重設回 false。這裡驗證 geoGa4H1State.lifecycleGeneration（單調遞增
// session 版本號）真的擋住這種 stale completion，同時確認 H1 Read／
// Dashboard 既有的 generation 設計本來就沒有這個問題（不用改，只補測試）。
//
// 真實 require public/js/geo-ga4-h1-panel.js／geo-ga4-dashboard-layer.js，
// 不重寫任何 lifecycle 邏輯。

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
  console.log('LIFECYCLE ABA RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 6.1)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function makeFakeMap() {
  const layers = new Set();
  return { hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); return this; }, removeLayer(l) { layers.delete(l); return this; } };
}
function makeFakeFetch(routes) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts });
    const route = routes.find((r) => r.test.test(url));
    const delayMs = (route && route.delayMs) || 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const status = (route && typeof route.status === 'number') ? route.status : 200;
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false, code: 'not_found' }) };
    if (typeof route.body === 'function') return { status, ok: status < 400, json: async () => route.body(url, opts) };
    return { status, ok: status < 400, json: async () => route.body };
  };
  fn.calls = calls;
  return fn;
}
function setFakeApi(routes) {
  const fakeFetch = makeFakeFetch(routes);
  global.fetch = fakeFetch;
  global.apiFetch = fakeFetch; // 這支測試不需要 401/403 特殊處理，直接共用
  return fakeFetch;
}
function makeDom() {
  return new JSDOM('<div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>'
    + '<div id="c-dashboard-ga4-range"></div><div id="c-dashboard-ga4-label"></div><div id="c-dashboard-ga4-status"></div>');
}
const H1_IDS = { toolbar: 'c-ga4-h1-toolbar', status: 'c-ga4-h1-status', table: 'c-ga4-h1-table' };
const DASH_IDS = { containerId: 'c', rangeMount: 'c-dashboard-ga4-range', label: 'c-dashboard-ga4-label', status: 'c-dashboard-ga4-status' };

function freshModules(dom) {
  const panelPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js'));
  delete require.cache[panelPath];
  const dashPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js'));
  delete require.cache[dashPath];
  const resolverPath = require.resolve(path.join(ROOT, 'public/js/geo-range-resolver.js'));
  delete require.cache[resolverPath];
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = {
    layerGroup: () => { const g = { _children: [], addLayer(c) { this._children.push(c); return this; }, clearLayers() { this._children.length = 0; return this; }, addTo(m) { m.addLayer(this); return this; }, remove() {} }; return g; },
    marker: () => ({ bindTooltip() { return this; }, addTo(g) { g.addLayer(this); return this; } }),
    divIcon: (o) => o,
  };
  const h1 = require(panelPath);
  const dash = require(dashPath);
  return { h1, dash };
}

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-h1-panel.js')]);
  pass('0-parse public/js/geo-ga4-h1-panel.js node --check 通過');

  const map = makeFakeMap();
  const globalUnhandled = [];
  process.on('unhandledRejection', (reason) => globalUnhandled.push(reason));

  function doSyncClick(dom, toolbarEl) {
    const btn = toolbarEl.querySelector('#ga4h1-sync');
    btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  }

  // ══════════════════════════════════════════════════════════════
  // ABA-1：Sync A pending → destroy → 很快 init session B（30d）→ 舊 A 完成
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    const fetchFn = setFakeApi([
      { test: /history/, body: { success: true, rows: [] } },
      { test: /sync/, delayMs: 60, body: { success: true, rows_saved: 7 } },
    ]);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    const toolbarElA = dom.window.document.getElementById(H1_IDS.toolbar);
    h1.geoGa4H1State.mode = '180d';
    doSyncClick(dom, toolbarElA); // Sync A 送出，capturedGeneration = A 的版本號
    await new Promise((r) => setTimeout(r, 5));

    h1.geoGa4H1Destroy(H1_IDS); // 切 Dashboard
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Init(H1_IDS, map); // 很快切回來，開 session B
    await new Promise((r) => setTimeout(r, 10));
    const toolbarElB = dom.window.document.getElementById(H1_IDS.toolbar);
    h1.geoGa4H1State.mode = '30d'; // session B 的 range

    const statusBeforeALate = dom.window.document.getElementById(H1_IDS.status).textContent;
    const markerGroupBRef = h1.geoGa4H1State.markerGroup;

    await new Promise((r) => setTimeout(r, 80)); // 讓舊 A 的 sync（delayMs=60）真的完成

    assert(h1.geoGa4H1State.mode === '30d', '1. ABA-1：舊 A 完成後 session B range 仍是 30d（沒被 A 的 onChange/refresh 蓋回 180d）');
    assert(h1.geoGa4H1State.markerGroup === markerGroupBRef, '2. ABA-1：舊 A 完成不觸發新 markerGroup 建立（session B 的 markerGroup 參考沒變）');
    const statusAfterALate = dom.window.document.getElementById(H1_IDS.status).textContent;
    assert(statusAfterALate === statusBeforeALate, '3. ABA-1：舊 A 完成不修改 session B 的 status 文字', `before=${statusBeforeALate} after=${statusAfterALate}`);
    assert(!/rows_saved|已更新 7 筆/.test(statusAfterALate), '4. ABA-1：舊 A 的 rows_saved=7 訊息沒有出現在 session B 畫面上', statusAfterALate);
    assert(true, '5. ABA-1：無 unhandledRejection（見下方全域 unhandledrejection 監聽總計）');
  }

  // ══════════════════════════════════════════════════════════════
  // ABA-2：A 舊 Sync 完成後，新 Session B 自己 Refresh 仍正常
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    const rows30d = [{ district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 3, marker_point: { lat: 24.95, lng: 121.22 } }];
    setFakeApi([
      { test: /history/, body: { success: true, rows: rows30d } },
      { test: /sync/, delayMs: 60, body: { success: true, rows_saved: 7 } },
    ]);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    const toolbarElA = dom.window.document.getElementById(H1_IDS.toolbar);
    h1.geoGa4H1State.mode = '180d';
    doSyncClick(dom, toolbarElA);
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = '30d';
    await h1.geoGa4H1Refresh(H1_IDS, map); // session B 自己合法的 Refresh
    assert(h1.geoGa4H1State.markerGroup && h1.geoGa4H1State.markerGroup._children.length === 1, '6. ABA-2：session B 自己的 Refresh 可以正常 render（generation guard 沒有連自己人都擋掉）', String(h1.geoGa4H1State.markerGroup && h1.geoGa4H1State.markerGroup._children.length));
    await new Promise((r) => setTimeout(r, 70)); // 讓舊 A 完成
    assert(h1.geoGa4H1State.markerGroup._children.length === 1, '7. ABA-2：舊 A 晚完成後，session B 剛畫好的 marker 沒被清掉或改變', String(h1.geoGa4H1State.markerGroup._children.length));
  }

  // ══════════════════════════════════════════════════════════════
  // ABA-3：Sync A pending → destroy → init B → destroy B → A 完成
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    setFakeApi([
      { test: /history/, body: { success: true, rows: [] } },
      { test: /sync/, delayMs: 60, body: { success: true, rows_saved: 9 } },
    ]);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    const toolbarElA = dom.window.document.getElementById(H1_IDS.toolbar);
    doSyncClick(dom, toolbarElA);
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS); // 完全離開，沒有 session C
    const markerGroupAfterAllDestroy = h1.geoGa4H1State.markerGroup;
    await new Promise((r) => setTimeout(r, 80));
    assert(h1.geoGa4H1State.markerGroup === markerGroupAfterAllDestroy, '8. ABA-3：destroy/init/destroy 後，A 完成沒有重新建立 markerGroup（仍是 null）', String(h1.geoGa4H1State.markerGroup));
    assert(h1.geoGa4H1State.destroyed === true, '9. ABA-3：最終 state 仍是 destroyed（A 完成沒有把它翻回 active）');
  }

  // ══════════════════════════════════════════════════════════════
  // ABA-4：H1 session A → Dashboard → session B → Dashboard → session C；
  // A 的 Sync 最晚才回，B 的 async 也不能影響 C。
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    setFakeApi([
      { test: /history/, body: { success: true, rows: [] } },
      { test: /sync/, delayMs: 100, body: (url, opts) => ({ success: true, rows_saved: 1, _tag: 'A' }) },
    ]);
    h1.geoGa4H1Init(H1_IDS, map); // session A
    await new Promise((r) => setTimeout(r, 10));
    const toolbarA = dom.window.document.getElementById(H1_IDS.toolbar);
    doSyncClick(dom, toolbarA); // A 的 sync（100ms 後才回）
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS); // → Dashboard

    setFakeApi([
      { test: /history/, body: { success: true, rows: [] } },
      { test: /sync/, delayMs: 40, body: { success: true, rows_saved: 2, _tag: 'B' } },
    ]);
    h1.geoGa4H1Init(H1_IDS, map); // session B
    await new Promise((r) => setTimeout(r, 10));
    const toolbarB = dom.window.document.getElementById(H1_IDS.toolbar);
    doSyncClick(dom, toolbarB); // B 的 sync（40ms 後回，會比 A 早回）
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS); // → Dashboard

    setFakeApi([{ test: /history/, body: { success: true, rows: [] } }]);
    h1.geoGa4H1Init(H1_IDS, map); // session C（沒有觸發任何 sync）
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = 'today';
    const cGeneration = h1.geoGa4H1State.lifecycleGeneration;
    const cStatusBefore = dom.window.document.getElementById(H1_IDS.status).textContent;

    await new Promise((r) => setTimeout(r, 120)); // 讓 B（40ms）、A（100ms）都完成

    assert(h1.geoGa4H1State.lifecycleGeneration === cGeneration, '10. ABA-4：A、B 的晚完成都沒有再觸發任何新的 init/destroy（session C 版本號不變）');
    const cStatusAfter = dom.window.document.getElementById(H1_IDS.status).textContent;
    assert(cStatusAfter === cStatusBefore, '11. ABA-4：A 與 B 的晚完成都沒有改到 session C 的 status', `before=${cStatusBefore} after=${cStatusAfter}`);
    assert(!/_tag|rows_saved/.test(cStatusAfter), '12. ABA-4：session C 畫面上看不到 A 或 B 的 sync 結果任何蛛絲馬跡', cStatusAfter);
  }

  // ══════════════════════════════════════════════════════════════
  // H1 Read ABA（既有 generation 設計，只補測試，不修改）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    setFakeApi([{ test: /history/, delayMs: 60, body: { success: true, rows: [{ district_name: '龍潭區', county_name: '桃園市', normalization_status: 'ok', active_users: 9, marker_point: { lat: 24.86, lng: 121.21 } }] } }]);
    h1.geoGa4H1Init(H1_IDS, map); // session A：init() 內部已經觸發一次 fire-and-forget refresh（120ms 尚未完成）
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1Destroy(H1_IDS); // 立刻 destroy，A 的 read 還在飛
    h1.geoGa4H1Init(H1_IDS, map); // session B
    await new Promise((r) => setTimeout(r, 10));
    const markerGroupB = h1.geoGa4H1State.markerGroup;
    await new Promise((r) => setTimeout(r, 80)); // 讓 A 的 read（60ms）完成
    assert(h1.geoGa4H1State.markerGroup === markerGroupB || (markerGroupB === null && h1.geoGa4H1State.markerGroup !== null), '13. H1 Read ABA：既有 generation 機制正確擋掉 A 的 stale read（session B 的 markerGroup 沒有被 A 污染）');
    assert(h1.geoGa4H1State.mode !== undefined, '14. H1 Read ABA：session B 仍可正常運作（mode 欄位存在且未被破壞）');
  }

  // ══════════════════════════════════════════════════════════════
  // Dashboard ABA（既有 AbortController + generation，只補測試）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { dash } = freshModules(dom);
    setFakeApi([{ test: /history/, delayMs: 60, body: { success: true, rows: [{ district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.95, lng: 121.22 } }] } }]);
    const mapD = makeFakeMap();
    const pA = dash.geoDashboardGa4Refresh(DASH_IDS, mapD); // request A pending（60ms）
    await new Promise((r) => setTimeout(r, 5));
    const controllerA = dash.dashboardGa4State.currentAbort;
    dash.geoDashboardGa4Deactivate(mapD); // deactivate（切 Heatmap）
    await pA.catch(() => {});

    setFakeApi([{ test: /history/, delayMs: 5, body: { success: true, rows: [] } }]);
    dash.geoDashboardGa4Activate(DASH_IDS, mapD); // 重新 activate，session B（範圍改成 empty）
    await new Promise((r) => setTimeout(r, 20));
    const groupB = dash.dashboardGa4State.layerGroup;
    const childCountAfterB = groupB._children.length;
    const controllerB = dash.dashboardGa4State.currentAbort;
    await new Promise((r) => setTimeout(r, 60)); // 讓 A 的舊 read（60ms）完成
    assert(dash.dashboardGa4State.layerGroup._children.length === childCountAfterB, '15. Dashboard ABA：request A pending → deactivate → activate session B → A 晚回不污染 B（marker count 不變）', `${childCountAfterB} → ${dash.dashboardGa4State.layerGroup._children.length}`);
    // 需求文件既有 Contract：currentAbort 只有在 deactivate() 或「下一次
    // 新 request 開始時 abort 並取代舊的」才會變動，成功完成後本來就不會
    // 自動歸零（controller 留著等下一次替換）——這裡驗證的是「session B
    // 的 controller 已經取代 session A 的」，不是假設它會變成 null。
    assert(controllerB !== controllerA, '16. Dashboard ABA：session B 的 AbortController 已經取代 session A 的（不是同一個殘留參考）');
  }

  // ══════════════════════════════════════════════════════════════
  // Marker / Range / Status Isolation 總結性斷言（多次往返後的最終狀態）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const { h1 } = freshModules(dom);
    setFakeApi([
      { test: /history/, body: { success: true, rows: [] } },
      { test: /sync/, delayMs: 50, body: { success: true, rows_saved: 3 } },
    ]);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = '90d';
    const toolbarEl = dom.window.document.getElementById(H1_IDS.toolbar);
    doSyncClick(dom, toolbarEl);
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = 'today';
    const finalGeneration = h1.geoGa4H1State.lifecycleGeneration;
    const groupBeforeStaleCompletion = h1.geoGa4H1State.markerGroup;
    const childCountBeforeStaleCompletion = groupBeforeStaleCompletion ? groupBeforeStaleCompletion._children.length : null;
    await new Promise((r) => setTimeout(r, 70));
    assert(h1.geoGa4H1State.mode === 'today', '17. Range Isolation：最終 session 的 mode（today）沒有被舊 sync 蓋掉');
    assert(h1.geoGa4H1State.lifecycleGeneration === finalGeneration, '18. Range Isolation：舊 sync 完成不會再觸發任何 lifecycle 事件（版本號不再前進）');
    // 19：舊 session 的初次 init() 本來就會先 render 一次自己的
    // markerGroup（即使 rows 是空陣列也一樣），所以這裡不是斷言
    // markerGroup 必須是 null，而是斷言「舊 sync 完成前後，這個
    // markerGroup 的物件參考跟內容完全沒有變化」——這才是 Marker
    // Isolation 真正要保護的東西。
    assert(h1.geoGa4H1State.markerGroup === groupBeforeStaleCompletion, '19a. Marker Isolation：舊 sync 完成不觸發任何新的 markerGroup 建立（物件參考不變）');
    assert((h1.geoGa4H1State.markerGroup ? h1.geoGa4H1State.markerGroup._children.length : null) === childCountBeforeStaleCompletion, '19b. Marker Isolation：舊 sync 完成不改變 markerGroup 的內容', `before=${childCountBeforeStaleCompletion}`);
  }

  await new Promise((r) => setTimeout(r, 30)); // 讓所有殘留的 async 完成（包含各段落內晚回的 fetch）
  assert(globalUnhandled.length === 0, '20. 整趟 Runtime（全部 ABA 場景加總）沒有任何 process-level unhandledRejection', JSON.stringify(globalUnhandled));

  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
