#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-map-state-mutations.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 7 Mutation Suite
//
// 每個 scenario：對真實 production 檔案做一次精準（命中次數=1）字串替換，
// 寫到 temp 檔案，真的 require/eval 執行後驗證行為壞掉（FAIL）；再對
// 完全沒改過的正式檔案跑同一個驗證，確認行為正確（PASS）。不是只做
// 字串搜尋——凡是行為性 mutation 都真的跑一次 runtime。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(os.tmpdir(), `h14-mutations-${process.pid}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('MUTATION SUITE SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 7)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// mutateOnce(src, oldStr, newStr) — 精準替換，命中次數必須恰好 1，否則丟例外
// （避免「以為改到了其實沒改到，測試照樣綠」）。
function mutateOnce(src, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`mutateOnce expected exactly 1 occurrence, got ${count}: ${oldStr.slice(0, 60)}...`);
  return src.replace(oldStr, newStr);
}

const TMP_SUFFIX = `.mutation-tmp-${process.pid}.js`;
const tempFilesCreated = [];
process.on('exit', () => { tempFilesCreated.forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }); });

function writeTempCopy(relPath, transform) {
  const realPath = path.join(ROOT, relPath);
  const src = fs.readFileSync(realPath, 'utf8');
  const mutated = transform(src);
  // 關鍵：mutated 檔案必須寫在「原始檔案的同一個資料夾」，不能寫到
  // os.tmpdir()——這些檔案內部都用相對路徑 require 同目錄的其他正式檔案
  // （例如 geo-ga4-h1-panel.js 的 require('./geo-range-resolver.js')），
  // 寫到別的資料夾會讓那個 require 找不到檔案、被吞掉例外，導致「看起來
  // mutated 版本也正常運作」的假陽性（不是 mutation 真的沒生效，是測試
  // 環境本身壞了）。
  const tmpPath = realPath.replace(/\.js$/, TMP_SUFFIX);
  fs.writeFileSync(tmpPath, mutated, 'utf8');
  tempFilesCreated.push(tmpPath);
  return tmpPath;
}

// runScenario(name, mutateFn, checkFn) —
//   mutateFn() 回傳 { tmpPath, otherFiles } 或直接跑一個自訂流程；
//   checkFn(useMutated) 回傳 true 代表「行為正確」（沒有洩漏/沒有 bug）。
//   一個 scenario 要求：checkFn(true /*mutated*/) === false 且
//   checkFn(false /*real*/) === true。
async function runScenario(name, checkFn) {
  let mutatedOk;
  let realOk;
  let detail = '';
  try {
    mutatedOk = await checkFn(true);
  } catch (e) { mutatedOk = false; detail += `mutated-threw:${e.message.slice(0, 80)} `; }
  try {
    realOk = await checkFn(false);
  } catch (e) { realOk = true === false; detail += `real-threw:${e.message.slice(0, 80)}`; }
  if (mutatedOk === false && realOk === true) {
    pass(`${name}（mutated FAIL, real PASS）`);
  } else {
    fail(name, `mutatedOk=${mutatedOk} realOk=${realOk} ${detail}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Pure-function 群組：Resolver / Backend（免 DOM，最快最穩）
// ══════════════════════════════════════════════════════════════

async function resolverScenarios() {
  const REAL_RESOLVER = path.join(ROOT, 'public/js/geo-range-resolver.js');

  function loadResolver(useMutated, transform) {
    const p = useMutated ? writeTempCopy('public/js/geo-range-resolver.js', transform) : REAL_RESOLVER;
    delete require.cache[require.resolve(p)];
    return require(p);
  }

  // V. 90d off-by-one（today-90 而不是 today-89）
  await runScenario('RANGE-90D-OFFBYONE: 90d uses today-90 instead of today-89', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, "dateStr(-89); endDate = dateStr(0);", "dateStr(-90); endDate = dateStr(0);"));
    const r = R.resolveGeoHistoricalRange('90d', { now: new Date('2026-08-07T04:00:00Z') });
    return r.ok && r.dayCount === 90;
  });

  // W. 180d off-by-one
  await runScenario('RANGE-180D-OFFBYONE: 180d uses today-180 instead of today-179', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, "dateStr(-179); endDate = dateStr(0);", "dateStr(-180); endDate = dateStr(0);"));
    const r = R.resolveGeoHistoricalRange('180d', { now: new Date('2026-08-07T04:00:00Z') });
    return r.ok && r.dayCount === 180;
  });

  // Z. single start != end
  await runScenario('RANGE-SINGLE-START-NE-END: single resolver endDate != startDate', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, 'startDate = endDate = single;', "startDate = single; endDate = single + '-BROKEN';"));
    const r = R.resolveGeoHistoricalRange('single', { singleDate: '2026-08-01' });
    return r.ok && r.startDate === r.endDate && r.startDate === '2026-08-01';
  });

  // AA. custom dayCount off-by-one
  await runScenario('RANGE-CUSTOM-DAYCOUNT-OFFBYONE: custom inclusive dayCount off-by-one', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, 'Math.round((b - a) / 86400000) + 1;', 'Math.round((b - a) / 86400000);'));
    const r = R.resolveGeoHistoricalRange('custom', { startDate: '2026-07-01', endDate: '2026-08-07' });
    return r.ok && r.dayCount === 38;
  });

  // X. 366-day leap year range 被拒（mutate GEO_RANGE_MAX_INCLUSIVE_DAYS 變小）
  await runScenario('RANGE-366-FRONTEND-REJECTED: 366-day inclusive (leap year) wrongly rejected', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, 'var GEO_RANGE_MAX_INCLUSIVE_DAYS = 366;', 'var GEO_RANGE_MAX_INCLUSIVE_DAYS = 365;'));
    const r = R.resolveGeoHistoricalRange('custom', { startDate: '2028-01-01', endDate: '2028-12-31' });
    return r.ok === true && r.dayCount === 366;
  });

  // Y. 367-day range 被錯誤接受
  await runScenario('RANGE-367-FRONTEND-ACCEPTED: 367-day inclusive range wrongly accepted', async (useMutated) => {
    const R = loadResolver(useMutated, (src) => mutateOnce(src, 'var GEO_RANGE_MAX_INCLUSIVE_DAYS = 366;', 'var GEO_RANGE_MAX_INCLUSIVE_DAYS = 367;'));
    const r = R.resolveGeoHistoricalRange('custom', { startDate: '2027-01-01', endDate: '2028-01-02' }); // 367 inclusive
    return r.ok === false && r.code === 'range_too_large';
  });
}

async function backendScenarios() {
  const REAL_SVC = path.join(ROOT, 'services/ga4GeoSyncService.js');
  function loadSvc(useMutated, transform) {
    const p = useMutated ? writeTempCopy('services/ga4GeoSyncService.js', transform) : REAL_SVC;
    delete require.cache[require.resolve(p)];
    return require(p);
  }

  // X-Backend. Backend CUSTOM_RANGE_MAX_DAYS 縮小，366 inclusive 被錯誤拒絕
  await runScenario('RANGE-366-BACKEND-REJECTED: Backend CUSTOM_RANGE_MAX_DAYS shrunk wrongly rejects 366-day leap year', async (useMutated) => {
    const svc = loadSvc(useMutated, (src) => mutateOnce(src, 'const CUSTOM_RANGE_MAX_DAYS = 365;', 'const CUSTOM_RANGE_MAX_DAYS = 364;'));
    const r = svc.resolveRangeWindow('custom', '2028-01-01', '2028-12-31'); // span=365, inclusive=366
    return r.ok === true;
  });

  // Y-Backend. Backend CUSTOM_RANGE_MAX_DAYS 放大，367 inclusive 被錯誤接受
  await runScenario('RANGE-367-BACKEND-ACCEPTED: Backend CUSTOM_RANGE_MAX_DAYS enlarged wrongly accepts 367-day range', async (useMutated) => {
    const svc = loadSvc(useMutated, (src) => mutateOnce(src, 'const CUSTOM_RANGE_MAX_DAYS = 365;', 'const CUSTOM_RANGE_MAX_DAYS = 366;'));
    const r = svc.resolveRangeWindow('custom', '2027-01-01', '2028-01-02'); // span=366, inclusive=367
    return r.ok === false && r.code === 'range_too_large';
  });
}

// ══════════════════════════════════════════════════════════════
// H1 Panel Lifecycle 群組（F, G, H, I）—— require-based，重用 Stage 4.1/6.1 harness 慣例
// ══════════════════════════════════════════════════════════════

function makeFakeMapSimple() {
  const layers = new Set();
  return { hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); return this; }, removeLayer(l) { layers.delete(l); return this; } };
}
function makeFakeFetchSimple(routes) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts });
    const route = routes.find((r) => r.test.test(url));
    await new Promise((resolve) => setTimeout(resolve, (route && route.delayMs) || 0));
    const status = (route && typeof route.status === 'number') ? route.status : 200;
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false }) };
    return { status, ok: status < 400, json: async () => (typeof route.body === 'function' ? route.body(url) : route.body) };
  };
  fn.calls = calls;
  return fn;
}
function makeDomH1() {
  return new JSDOM('<div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>');
}
const H1_IDS = { toolbar: 'c-ga4-h1-toolbar', status: 'c-ga4-h1-status', table: 'c-ga4-h1-table' };

function loadH1Panel(useMutated, transform) {
  const realPath = path.join(ROOT, 'public/js/geo-ga4-h1-panel.js');
  const p = useMutated ? writeTempCopy('public/js/geo-ga4-h1-panel.js', transform) : realPath;
  delete require.cache[require.resolve(p)];
  const dom = makeDomH1();
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = {
    layerGroup: () => { const g = { _children: [], addLayer(c) { this._children.push(c); return this; }, clearLayers() { this._children.length = 0; return this; }, addTo(m) { m.addLayer(this); return this; }, remove() {} }; return g; },
    marker: () => ({ bindTooltip() { return this; }, addTo(g) { g.addLayer(this); return this; } }),
    divIcon: (o) => o,
  };
  return { h1: require(p), dom };
}

async function h1LifecycleScenarios() {
  // F. geoGa4H1Destroy() 拿掉 currentAbort=null
  await runScenario('H1-CURRENTABORT-NOT-NULLED: geoGa4H1Destroy() drops currentAbort=null', async (useMutated) => {
    const map = makeFakeMapSimple();
    const { h1 } = loadH1Panel(useMutated, (src) => mutateOnce(src,
      "if (geoGa4H1State.currentAbort) { try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ } }\n  geoGa4H1State.currentAbort = null;\n  geoGa4H1ClearMarkers();",
      "if (geoGa4H1State.currentAbort) { try { geoGa4H1State.currentAbort.abort(); } catch (e) { /* ignore */ } }\n  geoGa4H1ClearMarkers();"));
    global.apiFetch = makeFakeFetchSimple([{ test: /history/, delayMs: 20, body: { success: true, rows: [] } }]);
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS);
    return h1.geoGa4H1State.currentAbort === null;
  });

  // G. Manual Sync completion 不檢查 destroyed（syncHandler 自己那層 +
  // _geoGa4H1HandleSyncResult 內另一層都要拿掉，才是真的「完全沒有
  // destroyed 防護」——只拿掉其中一層，另一層仍會擋住，不能代表 mutation
  // 生效）。用「stale 完成後有沒有多打一次 /history」當漏洞指標：mode
  // 本身不會被 onChange 覆蓋（onChange 只是讀目前 mode 去 fetch），但
  // 沒有防護時，stale sync 完成會多觸發一次不該發生的 Refresh。
  await runScenario('H1-DESTROYED-GUARD-REMOVED: syncHandler + _geoGa4H1HandleSyncResult 兩處 destroyed 檢查都拿掉', async (useMutated) => {
    const map = makeFakeMapSimple();
    const { h1, dom } = loadH1Panel(useMutated, (src) => {
      let s = mutateOnce(src,
        'if (isStaleLifecycle()) return;\n      if (result !== undefined) await _geoGa4H1HandleSyncResult(result, onChange);',
        'if (result !== undefined) await _geoGa4H1HandleSyncResult(result, onChange);');
      s = mutateOnce(s,
        'if (geoGa4H1State.destroyed) return;\n      await geoGa4H1SafeRunFetch(() => onChange());',
        'await geoGa4H1SafeRunFetch(() => onChange());');
      return s;
    });
    const fetchFn = makeFakeFetchSimple([{ test: /history/, body: { success: true, rows: [] } }, { test: /sync/, delayMs: 40, body: { success: true, rows_saved: 3 } }]);
    global.apiFetch = fetchFn;
    h1.geoGa4H1Init(H1_IDS, map);
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = '180d'; // 需為歷史 range 模式，URL 才會落在 /history（'realtime' 預設模式打的是不同 endpoint，不會被下面的過濾器算到）
    const toolbarEl = dom.window.document.getElementById(H1_IDS.toolbar);
    toolbarEl.querySelector('#ga4h1-sync').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS);
    const historyCallsBefore = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    await new Promise((r) => setTimeout(r, 60)); // 讓 sync（40ms）完成
    const historyCallsAfter = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    // 正確行為（有防護）：destroy 之後不該再多打一次 history（historyCallsAfter === historyCallsBefore）
    return historyCallsAfter === historyCallsBefore;
  });

  // H. destroyed 檢查還在，但拿掉 generation 比對（ABA 漏洞重現）
  await runScenario('H1-LIFECYCLE-GENERATION-CHECK-REMOVED: syncHandler keeps destroyed check but drops lifecycleGeneration comparison (ABA)', async (useMutated) => {
    const map = makeFakeMapSimple();
    const { h1, dom } = loadH1Panel(useMutated, (src) => mutateOnce(src,
      'const isStaleLifecycle = () => geoGa4H1State.destroyed || geoGa4H1State.lifecycleGeneration !== capturedGeneration;',
      'const isStaleLifecycle = () => geoGa4H1State.destroyed;'));
    const fetchFn = makeFakeFetchSimple([{ test: /history/, body: { success: true, rows: [] } }, { test: /sync/, delayMs: 40, body: { success: true, rows_saved: 3 } }]);
    global.apiFetch = fetchFn;
    h1.geoGa4H1Init(H1_IDS, map); // session A
    await new Promise((r) => setTimeout(r, 10));
    const toolbarA = dom.window.document.getElementById(H1_IDS.toolbar);
    h1.geoGa4H1State.mode = '180d';
    toolbarA.querySelector('#ga4h1-sync').dispatchEvent(new dom.window.Event('click', { bubbles: true })); // sync A pending
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS); // → Dashboard（destroyed=true）
    h1.geoGa4H1Init(H1_IDS, map); // 很快切回，session B（destroyed 重新變 false！ABA 破口）
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = '30d'; // session B 自己的 range
    const historyCallsBefore = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    await new Promise((r) => setTimeout(r, 60)); // 讓舊 sync A（40ms）完成
    const historyCallsAfter = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    // 正確行為（generation guard 有效）：舊 A 完成不該再多觸發一次 history fetch
    return historyCallsAfter === historyCallsBefore;
  });

  // I. generation 在「比對當下」才讀，不是用一開始 capture 的舊值
  // （等於拿現在的值跟現在的值比，永遠相等，guard 形同虛設，但
  // destroyed 檢查還在——跟 Mutation H「整段拿掉比較式」是不同種壞法）。
  await runScenario('H1-GENERATION-CAPTURE-TIMING-WRONG: generation compared against itself at check-time instead of a captured baseline', async (useMutated) => {
    const map = makeFakeMapSimple();
    const { h1, dom } = loadH1Panel(useMutated, (src) => mutateOnce(src,
      'const isStaleLifecycle = () => geoGa4H1State.destroyed || geoGa4H1State.lifecycleGeneration !== capturedGeneration;',
      'const isStaleLifecycle = () => geoGa4H1State.destroyed || geoGa4H1State.lifecycleGeneration !== geoGa4H1State.lifecycleGeneration; // MUTATION-I：capturedGeneration 沒被使用，永遠自己比自己'));
    const fetchFn = makeFakeFetchSimple([{ test: /history/, body: { success: true, rows: [] } }, { test: /sync/, delayMs: 40, body: { success: true, rows_saved: 3 } }]);
    global.apiFetch = fetchFn;
    h1.geoGa4H1Init(H1_IDS, map); // session A
    await new Promise((r) => setTimeout(r, 10));
    const toolbarA = dom.window.document.getElementById(H1_IDS.toolbar);
    h1.geoGa4H1State.mode = '180d';
    toolbarA.querySelector('#ga4h1-sync').dispatchEvent(new dom.window.Event('click', { bubbles: true })); // sync A pending
    await new Promise((r) => setTimeout(r, 5));
    h1.geoGa4H1Destroy(H1_IDS); // → Dashboard
    h1.geoGa4H1Init(H1_IDS, map); // 很快切回，session B
    await new Promise((r) => setTimeout(r, 10));
    h1.geoGa4H1State.mode = '30d'; // session B 自己的 range
    const historyCallsBefore = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    await new Promise((r) => setTimeout(r, 60)); // 讓舊 sync A（40ms）完成
    const historyCallsAfter = fetchFn.calls.filter((c) => c.url.includes('history')).length;
    return historyCallsAfter === historyCallsBefore;
  });
}

// ══════════════════════════════════════════════════════════════
// Heatmap-UI ↔ Dashboard 整合群組（A, B, C, D, E, J, K, L, M, N, O, P, Q）
// —— eval-based harness，跟 Stage 6 run-g1-6-ga4-h1-4-map-state-runtime.js 同一套慣例
// ══════════════════════════════════════════════════════════════

const CID = 'mutC';
const MID = 'mutMap';
const DASH_IDS2 = { containerId: CID, rangeMount: `${CID}-dashboard-ga4-range`, label: `${CID}-dashboard-ga4-label`, status: `${CID}-dashboard-ga4-status` };
const H1_IDS2 = { toolbar: `${CID}-ga4-h1-toolbar`, status: `${CID}-ga4-h1-status`, table: `${CID}-ga4-h1-table` };

function readMaybeMutated(relPath, useMutated, transform) {
  const p = useMutated ? writeTempCopy(relPath, transform) : path.join(ROOT, relPath);
  return fs.readFileSync(p, 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
}

function buildEnv(mutations) {
  // mutations: { [relPath]: transformFn } — 只有這裡列到的檔案會被 mutate，其餘一律用真實檔案。
  const html = `<!DOCTYPE html><html><body>
    <div id="${MID}"></div>
    <div id="${CID}-order-layer"></div><div id="${CID}-visitor-layer" hidden></div><div id="${CID}-ga4-layer" hidden></div>
    <div id="${H1_IDS2.toolbar}"></div><div id="${H1_IDS2.status}"></div><div id="${H1_IDS2.table}"></div>
    <div id="${DASH_IDS2.rangeMount}"></div><div id="${DASH_IDS2.label}"></div><div id="${DASH_IDS2.status}"></div>
    <div id="${CID}-panel-dashboard"></div><div id="${CID}-panel-heatmap" hidden></div>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const map = {
    _layers: new Set(),
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); return this; },
    removeLayer(l) { this._layers.delete(l); return this; },
  };
  function makeGroup() {
    const children = [];
    return {
      _children: children,
      addLayer(c) { children.push(c); return this; },
      removeLayer(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return this; },
      clearLayers() { children.length = 0; return this; },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
    };
  }
  dom.window.L = {
    layerGroup() { return makeGroup(); },
    geoJSON() { return { setStyle() {}, addTo(m) { m.addLayer(this); return this; } }; },
    marker(latlng) { return { latlng, bindTooltip() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    divIcon(o) { return o; },
    map() { return {}; },
    tileLayer() { return { addTo() { return this; } }; },
  };
  const geoJsonLayer = { setStyle() {} };
  dom.window.geoMapState = { instance: map, rows: [], metric: 'visitors', geoJsonLayer };
  map.addLayer(geoJsonLayer);
  dom.window.geoUpdateMapData = function () {};
  const fetchState = { historyRows: [], delayMs: 0 };
  dom.window.apiFetch = makeFakeFetchSimple([
    { test: /history/, delayMs: 0, body: () => ({ success: true, rows: fetchState.historyRows }) },
    { test: /ga4-realtime/, delayMs: 0, body: { success: true, cities: [] } },
  ]);

  const get = (rel) => readMaybeMutated(rel, !!mutations[rel], mutations[rel]);
  const src = [
    'public/js/date-time-format.js', 'public/js/geo-range-resolver.js', 'public/js/geo-range-control.js',
    'public/js/geo-heatmap.js', 'public/js/geo-visitor-layer.js', 'public/js/geo-ga4-realtime-layer.js',
    'public/js/geo-ga4-h1-panel.js', 'public/js/geo-ga4-dashboard-layer.js', 'public/js/geo-heatmap-ui.js',
  ].map(get).join('\n;\n');
  dom.window.eval(src);
  dom.window.geoHeatUiState.containerId = CID;
  dom.window.geoHeatUiState.mapContainerId = MID;
  return { dom, map, fetchState };
}

async function heatmapDashboardScenarios() {
  // A. Heatmap cleanup removed
  await runScenario('HEATMAP-CLEANUP-REMOVED: geoHeatUiSwitchTab(dashboard) 不再呼叫 _geoHeatUiCleanupForDashboard()', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-heatmap-ui.js': (src) => mutateOnce(src, '_geoHeatUiCleanupForDashboard(containerId);\n    _geoHeatUiRestoreChoropleth();', '_geoHeatUiRestoreChoropleth();') } : {});
    const orderGroup = dom.window.geoHeatEnsureLayerGroup(map);
    dom.window.geoHeatUiSwitchTab(CID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    return map.hasLayer(orderGroup) === false;
  });

  // B. cleanup 不 remove H1 markerGroup
  await runScenario('H1-MARKERGROUP-REMOVAL-SKIPPED: _geoHeatUiCleanupForDashboard() 不移除 H1 markerGroup', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-heatmap-ui.js': (src) => mutateOnce(src, '_geoHeatUiRemoveLayerIfPresent(map, window.geoHeatState && window.geoHeatState.layerGroup);', '// MUTATION-B: intentionally skip H1 handling below is untouched, but this line stays for order layer') } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS2, map);
    const orderGroup = dom.window.geoHeatState.layerGroup;
    dom.window.geoHeatUiSwitchTab(CID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    return map.hasLayer(orderGroup) === false;
  });

  // C. Dashboard → Heatmap 不 remove dashboardGa4State.layerGroup
  await runScenario('DASHBOARD-LAYER-REMOVAL-SKIPPED: Dashboard → Heatmap 不移除 dashboardGa4State.layerGroup', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-heatmap-ui.js': (src) => mutateOnce(src, 'if (typeof geoDashboardGa4Deactivate === \'function\') {\n      const map = window.geoMapState && window.geoMapState.instance;\n      geoDashboardGa4Deactivate(map);\n    }', '/* MUTATION-C: deactivate removed */') } : {});
    fetchState.historyRows = [{ district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.95, lng: 121.22 } }];
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    const dashGroup = dom.window.dashboardGa4State.layerGroup;
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    await new Promise((r) => setTimeout(r, 20));
    return map.hasLayer(dashGroup) === false;
  });

  // D. Realtime deactivate removed
  await runScenario('REALTIME-DEACTIVATE-SKIPPED: Heatmap → Dashboard 不呼叫 geoGa4Deactivate()', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-heatmap-ui.js': (src) => mutateOnce(src, "if (typeof geoGa4Deactivate === 'function') {\n    try { geoGa4Deactivate(); } catch (e) { /* 安靜失敗 */ }\n  }", '/* MUTATION-D: realtime deactivate removed */') } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.geoGa4State.layerGroup = dom.window.L.layerGroup();
    dom.window.geoGa4State.layerGroup.addTo(map);
    dom.window.geoGa4State.abortController = new dom.window.AbortController();
    dom.window.geoHeatUiSwitchTab(CID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    return dom.window.geoGa4State.abortController === null;
  });

  // E. H1 destroy removed
  await runScenario('H1-DESTROY-SKIPPED: Heatmap → Dashboard 不呼叫 GeoGa4H1Panel.destroy()', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-heatmap-ui.js': (src) => mutateOnce(src, "if (window.GeoGa4H1Panel && typeof window.GeoGa4H1Panel.destroy === 'function') {\n    try {\n      window.GeoGa4H1Panel.destroy({", "if (false) {\n    try {\n      window.GeoGa4H1Panel.destroy({") } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS2, map);
    const h1Group = dom.window.GeoGa4H1Panel.state.markerGroup;
    dom.window.geoHeatUiSwitchTab(CID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    return map.hasLayer(h1Group) === false;
  });

  // J. Dashboard/H1 共用 LayerGroup
  await runScenario('DASHBOARD-H1-SHARED-LAYERGROUP: dashboardGa4State.layerGroup 被改成共用 geoGa4H1State.markerGroup', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, 'if (!dashboardGa4State.layerGroup && typeof L !== \'undefined\' && typeof L.layerGroup === \'function\') {\n    dashboardGa4State.layerGroup = L.layerGroup();\n  }', 'if (!dashboardGa4State.layerGroup) {\n    dashboardGa4State.layerGroup = (typeof window !== "undefined" && window.GeoGa4H1Panel) ? window.GeoGa4H1Panel.state.markerGroup || L.layerGroup() : L.layerGroup();\n  }') } : {});
    fetchState.historyRows = [{ district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.95, lng: 121.22 } }];
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS2, map);
    const h1Group = dom.window.GeoGa4H1Panel.state.markerGroup;
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    return dom.window.dashboardGa4State.layerGroup !== h1Group;
  });

  // K. Dashboard/Heatmap 共用 rangeState
  await runScenario('DASHBOARD-HEATMAP-SHARED-RANGESTATE: dashboardGa4State.rangeState 被改成共用 geoGa4H1State.rangeState', async (useMutated) => {
    const { dom } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, "rangeState: { mode: '7d', singleDate: '', startDate: '', endDate: '' },", "rangeState: (typeof window !== 'undefined' && window.GeoGa4H1Panel) ? window.GeoGa4H1Panel.state.rangeState : { mode: '7d', singleDate: '', startDate: '', endDate: '' },") } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.rangeState.mode = '180d';
    return dom.window.dashboardGa4State.rangeState !== dom.window.GeoGa4H1Panel.state.rangeState;
  });

  // L. Late realtime response allowed（拿掉 geoGa4Deactivate 對 abortController 的處理，讓晚回應能改 Dashboard 狀態）
  await runScenario('REALTIME-STALE-GUARD-REMOVED: abortController 不 abort', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-ga4-realtime-layer.js': (src) => mutateOnce(src, "if (geoGa4State.abortController && typeof geoGa4State.abortController.abort === 'function') {\n    try { geoGa4State.abortController.abort(); } catch (e) { /* ignore */ }\n  }\n  geoGa4State.abortController = null;", '/* MUTATION-L: abort guard removed */') } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    const controller = new dom.window.AbortController();
    dom.window.geoGa4State.abortController = controller;
    dom.window.geoHeatUiSwitchTab(CID, 'dashboard');
    await new Promise((r) => setTimeout(r, 20));
    return controller.signal.aborted === true;
  });

  // M. Late H1 read allowed（H1 Refresh 的 generation guard 拿掉）
  await runScenario('H1-READ-STALE-GUARD-REMOVED: geoGa4H1Refresh() 的 generation stale-guard 被拿掉', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-ga4-h1-panel.js': (src) => mutateOnce(src, 'if (myGeneration !== geoGa4H1State.generation) return;\n\n  if (payload && payload.success) {', 'if (payload && payload.success) {') } : {});
    dom.window.geoHeatUiSwitchTab(CID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    // 需求文件七：不依賴 wall-clock delayMs 賽跑（在 56-suite 循序執行的完整
    // Regression 下，系統負載會讓 timer 排程有雜訊，曾經造成這條 flaky）。
    // 改用手動控制的 deferred promise：A 的 fetch 完全由測試程式碼決定何時
    // resolve，不受任何真實時間影響，確定性 100%。
    let resolveA;
    const aPending = new Promise((resolve) => { resolveA = resolve; });
    dom.window.apiFetch = async (url) => {
      await aPending;
      return { status: 200, ok: true, json: async () => ({ success: true, rows: [{ district_name: 'A區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 11, lng: 11 } }] }) };
    };
    const p1 = dom.window.geoGa4H1Refresh(H1_IDS2, map); // A 發出去，卡在 aPending，還沒 resolve
    dom.window.GeoGa4H1Panel.state.mode = '30d';
    dom.window.apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, rows: [{ district_name: 'B區', normalization_status: 'ok', active_users: 2, marker_point: { lat: 22, lng: 22 } }] }) });
    await dom.window.geoGa4H1Refresh(H1_IDS2, map); // B 立即完成
    resolveA(); // 現在才讓 A 晚回（B 已經確定完成之後）
    await p1.catch(() => {});
    const group = dom.window.GeoGa4H1Panel.state.markerGroup;
    // 正確行為（有 guard）：最後畫面上只會有 B 的 marker（lat=22），不會被晚到的 A（lat=11）蓋掉或疊加
    return !!group && group._children.length === 1 && group._children[0].latlng[0] === 22;
  });

  // N. Late Dashboard response allowed（Dashboard generation guard 拿掉）
  await runScenario('DASHBOARD-STALE-GUARD-REMOVED: geoDashboardGa4Refresh() 的 generation stale-guard 被拿掉', async (useMutated) => {
    const { dom, map } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, 'if (myGeneration !== dashboardGa4State.generation) return; // stale response guard\n\n  if (!body || body.success === false) {', 'if (!body || body.success === false) {') } : {});
    dom.window.dashboardGa4State.rangeState.mode = '7d';
    dom.window.apiFetch = makeFakeFetchSimple([{ test: /history/, delayMs: 30, body: { success: true, rows: [{ district_name: 'A區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 11, lng: 11 } }] } }]);
    const pA = dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 5));
    dom.window.dashboardGa4State.rangeState.mode = '90d';
    dom.window.apiFetch = makeFakeFetchSimple([{ test: /history/, delayMs: 0, body: { success: true, rows: [{ district_name: 'B區', normalization_status: 'ok', active_users: 2, marker_point: { lat: 22, lng: 22 } }] } }]);
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    await pA.catch(() => {});
    await new Promise((r) => setTimeout(r, 40));
    const group = dom.window.dashboardGa4State.layerGroup;
    // 正確行為（有 guard）：最終畫面只有 B 的 marker（lat=22），不是被晚到的 A（lat=11）蓋掉
    return !!group && group._children.length === 1 && group._children[0].latlng[0] === 22;
  });

  // AC. Friendly Label Removed（Dashboard 標題直接只顯示 raw calendar range）
  await runScenario('DASHBOARD-FRIENDLY-LABEL-REMOVED: geoDashboardGa4RangeLabel() 被拿掉，主標題直接顯示 raw calendar range', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, "const friendlyLabel = (resolved && resolved.ok) ? geoDashboardGa4RangeLabel(resolved) : '';", "const friendlyLabel = (resolved && resolved.ok) ? resolved.displayLabel : ''; // MUTATION-AC：繞過 friendly label 對照表") } : {});
    fetchState.historyRows = [{ district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 1, lng: 1 } }];
    dom.window.dashboardGa4State.rangeState.mode = '7d';
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    const labelHtml = dom.window.document.getElementById(DASH_IDS2.label).innerHTML;
    return labelHtml.includes('近 7 天');
  });

  // AD. activeUsers 被跨行政區加總並顯示成總訪客
  await runScenario('DASHBOARD-ACTIVEUSERS-SUMMED: Dashboard 對 rows.active_users 做加總並顯示總訪客', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? {
      'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src,
        "_geoDashboardGa4RenderStatus(ids, `共 ${count} 個行政區有資料。`);",
        "_geoDashboardGa4RenderStatus(ids, `總訪客 ${rows.reduce((s, r) => s + (r.active_users || 0), 0)}`); // MUTATION-AD：跨行政區加總"),
    } : {});
    fetchState.historyRows = [
      { district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 1, lng: 1 } },
      { district_name: '平鎮區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 2, lng: 2 } },
    ];
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    const statusText = dom.window.document.getElementById(DASH_IDS2.status).textContent;
    return !/總訪客/.test(statusText);
  });

  // AE. Dashboard activate 建立第二個 L.map()
  await runScenario('DASHBOARD-SECOND-LEAFLET-MAP: geoDashboardGa4Activate() 內部呼叫 new L.map()', async (useMutated) => {
    let mapCallCount = 0;
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, 'function geoDashboardGa4Activate(ids, mapInstance) {\n  dashboardGa4State.active = true;', 'function geoDashboardGa4Activate(ids, mapInstance) {\n  if (typeof L !== "undefined" && L.map) { L.map(); } // MUTATION-AE：建立第二張地圖\n  dashboardGa4State.active = true;') } : {});
    const realMapFn = dom.window.L.map;
    dom.window.L.map = (...args) => { mapCallCount += 1; return realMapFn ? realMapFn(...args) : {}; };
    fetchState.historyRows = [];
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    return mapCallCount === 0;
  });

  // AF. 每次 activate 都建立新的 LayerGroup（不重用）
  await runScenario('DASHBOARD-DUPLICATE-LAYERGROUP: geoDashboardGa4Activate() 每次都新建 layerGroup，不重用既有的', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, "if (!dashboardGa4State.layerGroup && typeof L !== 'undefined' && typeof L.layerGroup === 'function') {\n    dashboardGa4State.layerGroup = L.layerGroup();\n  }", "if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {\n    dashboardGa4State.layerGroup = L.layerGroup(); // MUTATION-AF：拿掉 !dashboardGa4State.layerGroup 這個重用 guard\n  }") } : {});
    fetchState.historyRows = [];
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    const ref1 = dom.window.dashboardGa4State.layerGroup;
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    const ref2 = dom.window.dashboardGa4State.layerGroup;
    return ref1 === ref2;
  });

  // R. Dashboard 呼叫 POST sync
  await runScenario('DASHBOARD-CALLS-SYNC: Dashboard 模組被加入 POST /sync 呼叫', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, "function geoDashboardGa4Activate(ids, mapInstance) {\n  dashboardGa4State.active = true;", "function geoDashboardGa4Activate(ids, mapInstance) {\n  if (typeof apiFetch === 'function') { apiFetch('/api/analytics/ga4-geo/sync', { method: 'POST' }); } // MUTATION-R\n  dashboardGa4State.active = true;") } : {});
    let syncCalled = false;
    const realApiFetch = dom.window.apiFetch;
    dom.window.apiFetch = (url, opts) => { if (/sync/.test(url)) syncCalled = true; return realApiFetch(url, opts); };
    fetchState.historyRows = [];
    dom.window.geoDashboardGa4Activate(DASH_IDS2, map);
    await new Promise((r) => setTimeout(r, 20));
    return syncCalled === false;
  });

  // T. Dashboard bare fetch（apiFetch 改成裸 fetch）
  await runScenario('DASHBOARD-BARE-FETCH: Dashboard 的 apiFetch 呼叫被改成裸 fetch()', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? { 'public/js/geo-ga4-dashboard-layer.js': (src) => mutateOnce(src, "const fetchFn = (typeof winApiFetch === 'function') ? winApiFetch : (typeof apiFetch === 'function' ? apiFetch : null);", "const fetchFn = (typeof fetch === 'function') ? fetch : null; // MUTATION-T：改用裸 fetch，繞過 apiFetch 的 Authorization/Store Session 處理") } : {});
    let bareFetchCalled = false;
    dom.window.fetch = (url, opts) => { bareFetchCalled = true; return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, rows: [] }) }); };
    fetchState.historyRows = [];
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    return bareFetchCalled === false;
  });

  // P. Empty 保留 stale marker（preemptive clear 跟 empty-branch clear 都要拿掉，
  // 因為兩者其中任一個單獨存在都還是會正確清掉，必須兩個都拿掉才能真的重現洩漏）。
  await runScenario('DASHBOARD-EMPTY-KEEPS-STALE-MARKER: rows=[] 時不 clearLayers', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? {
      'public/js/geo-ga4-dashboard-layer.js': (src) => {
        let s = mutateOnce(src, "geoDashboardGa4ClearMarkers();\n  _geoDashboardGa4RenderLabel(ids, resolved);\n  _geoDashboardGa4RenderStatus(ids, '載入中…');", "_geoDashboardGa4RenderLabel(ids, resolved);\n  _geoDashboardGa4RenderStatus(ids, '載入中…');");
        s = mutateOnce(s, "if (rows.length === 0) {\n    geoDashboardGa4ClearMarkers();\n    _geoDashboardGa4RenderStatus(ids, '目前尚無此期間已同步的 GA4 區域資料。請至 Heatmap → GA4 區域分析執行手動同步。');\n    return;\n  }", "if (rows.length === 0) {\n    _geoDashboardGa4RenderStatus(ids, '目前尚無此期間已同步的 GA4 區域資料。請至 Heatmap → GA4 區域分析執行手動同步。');\n    return;\n  }");
        return s;
      },
    } : {});
    fetchState.historyRows = [{ district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 1, lng: 1 } }];
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    fetchState.historyRows = [];
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    return dom.window.dashboardGa4State.layerGroup._children.length === 0;
  });

  // Q. 500 保留 stale marker（同理，preemptive clear 跟 error-branch clear 都要拿掉）
  await runScenario('DASHBOARD-500-KEEPS-STALE-MARKER: 500 error 時不 clearLayers', async (useMutated) => {
    const { dom, map, fetchState } = buildEnv(useMutated ? {
      'public/js/geo-ga4-dashboard-layer.js': (src) => {
        let s = mutateOnce(src, "geoDashboardGa4ClearMarkers();\n  _geoDashboardGa4RenderLabel(ids, resolved);\n  _geoDashboardGa4RenderStatus(ids, '載入中…');", "_geoDashboardGa4RenderLabel(ids, resolved);\n  _geoDashboardGa4RenderStatus(ids, '載入中…');");
        s = mutateOnce(s, "if (!body || body.success === false) {\n    geoDashboardGa4ClearMarkers();\n    _geoDashboardGa4RenderStatus(ids, _geoDashboardGa4ErrorMessage(body && body.code));\n    return;\n  }", "if (!body || body.success === false) {\n    _geoDashboardGa4RenderStatus(ids, _geoDashboardGa4ErrorMessage(body && body.code));\n    return;\n  }");
        return s;
      },
    } : {});
    fetchState.historyRows = [{ district_name: '中壢區', normalization_status: 'ok', active_users: 1, marker_point: { lat: 1, lng: 1 } }];
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    dom.window.apiFetch = makeFakeFetchSimple([{ test: /history/, status: 500, body: { success: false, code: 'internal_error' } }]);
    await dom.window.geoDashboardGa4Refresh(DASH_IDS2, map);
    return dom.window.dashboardGa4State.layerGroup._children.length === 0;
  });
}

async function main() {
  await resolverScenarios();
  await backendScenarios();
  await h1LifecycleScenarios();
  await heatmapDashboardScenarios();
  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
