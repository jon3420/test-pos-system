#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-1-auth-mutations.js — fix18-10-
// hotfix30-B5-R5.4-G1.6-GA4-H1.1-AUTH
//
// Mutation Negative A–L. 每一項都真的修改 Production Source 的「記憶體
// 副本」（從沒寫回磁碟的原始檔——原始檔案在磁碟上完全不變），寫入一個
// 暫存檔（測試結束即刪除），實際 require 執行它，證明：
//   (a) 這個 Mutation 真的命中了 Production 原始碼裡預期的那一行（byte-exact
//       比對，命中次數不對就直接 throw，不會安靜跳過）。
//   (b) 對應的 Static Audit check 或 Runtime 行為，在這個被動過手的版本上
//       真的變成 FAIL／出現預期的壞行為。
//   (c) 同一個 check／行為，對「完全沒被動過的真實原始碼」跑，仍然是
//       PASS／正常行為（避免測試本身寫成恒假或恒真）。
//
// 這裡的「PASS」＝「這個惡意 Mutation 被成功攔截／偵測到」，不是「這個
// Mutation 本身沒問題」。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PANEL_PATH = path.join(ROOT, 'public/js/geo-ga4-h1-panel.js');
const LAYER_PATH = path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js');
const APP_JS_PATH = path.join(ROOT, 'public/js/app.js');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const REAL_PANEL_SRC = fs.readFileSync(PANEL_PATH, 'utf8');
const REAL_LAYER_SRC = fs.readFileSync(LAYER_PATH, 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ── mutateOnce/mutateAll — 修改前先「數命中次數」，命中次數不符直接
// throw（不得因 replace 沒命中就默默跳過，見需求文件二）。
function mutateOnce(src, searchStr, replaceStr) {
  const count = src.split(searchStr).length - 1;
  if (count !== 1) throw new Error(`mutateOnce: expected exactly 1 occurrence, found ${count} — "${searchStr.slice(0, 70)}..."`);
  const idx = src.indexOf(searchStr);
  return src.slice(0, idx) + replaceStr + src.slice(idx + searchStr.length);
}
function mutateAll(src, searchStr, replaceStr, expectedCount) {
  const count = src.split(searchStr).length - 1;
  if (count !== expectedCount) throw new Error(`mutateAll: expected ${expectedCount} occurrences, found ${count} — "${searchStr.slice(0, 70)}..."`);
  return src.split(searchStr).join(replaceStr);
}

// ── writeTempModule/cleanup — 寫暫存檔、require、之後一定刪除（不留 Residue）。
const tempFiles = [];
function writeTempModule(mutatedSrc, baseName) {
  const p = path.join(os.tmpdir(), `${baseName}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, mutatedSrc, 'utf8');
  tempFiles.push(p);
  delete require.cache[p];
  return p;
}
function cleanupTempFiles() {
  tempFiles.forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } });
  tempFiles.length = 0;
}

// ── Real apiFetch/Token Contract 擷取（同 run-g1-6-ga4-h1-1-browser-auth-
// runtime.js 的做法，這裡重新做一次獨立擷取，讓這支檔案可以獨立執行，
// 不依賴另一支測試檔案的內部狀態）。
function extractRealAuthContractSource() {
  const src = fs.readFileSync(APP_JS_PATH, 'utf8');
  const startMarker = "const TOKEN_KEY = 'pos_store_token';";
  const fnMarker = 'function showLoginOverlay() {';
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('production app.js 找不到 TOKEN_KEY 定義');
  const fnIdx = src.indexOf(fnMarker, startIdx);
  if (fnIdx === -1) throw new Error('production app.js 找不到 showLoginOverlay 定義');
  const afterFn = src.slice(fnIdx);
  const closeIdx = afterFn.indexOf('\n}\n');
  if (closeIdx === -1) throw new Error('production app.js 找不到 showLoginOverlay 函式收尾');
  return src.slice(startIdx, fnIdx + closeIdx + 3);
}
const REAL_AUTH_SRC = extractRealAuthContractSource();

function makeDom() {
  return new JSDOM(
    '<!DOCTYPE html><html><body><div id="c-toolbar"></div><div id="c-status"></div><div id="c-table"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' },
  );
}

function makeFakeNetworkFetch(routes) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts: { ...opts, headers: { ...(opts.headers || {}) } } });
    const route = routes.find((r) => r.test.test(url));
    const status = (route && typeof route.status === 'number') ? route.status : 200;
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
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false, code: 'not_found' }) };
    const body = (typeof route.body === 'function') ? route.body(url, opts) : route.body;
    return { status, ok: status < 400, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// loadEnv(panelModulePath, routes, opts) — 真 apiFetch Contract + 指定路徑
// 的 Panel 模組（可能是真的，也可能是暫存的 mutated 版本）。
function loadEnv(panelModulePath, routes, { token = 'mock_token_qa_only', storeId = 'store_001' } = {}) {
  const dom = makeDom();
  const win = dom.window;
  if (token !== null) win.localStorage.setItem('pos_store_token', token);
  if (storeId !== null) win.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: storeId }));
  const fakeFetch = makeFakeNetworkFetch(routes);
  win.fetch = fakeFetch;
  win.eval(REAL_AUTH_SRC);

  const realApiFetch = win.apiFetch;
  const apiFetchCalls = [];
  win.apiFetch = async function spiedApiFetch(...args) {
    apiFetchCalls.push(args);
    return realApiFetch.apply(win, args);
  };

  global.window = win;
  global.document = win.document;
  global.localStorage = win.localStorage;
  // MUTATION-A 需要 bare `fetch` 在模組作用域內可解析——把它指到同一個
  // 可控的 Fake Network Fetch，而不是讓它打到 Node 18+ 內建的真實
  // globalThis.fetch（否則會嘗試對一個相對路徑發真實請求而整個爆炸，
  // 那是「測試環境的意外」，不是我們要證明的「Mutation 被攔截」）。
  global.fetch = fakeFetch;
  global.L = {
    layerGroup: () => ({ _layers: new Set(), addLayer(l) { this._layers.add(l); }, removeLayer(l) { this._layers.delete(l); }, clearLayers() { this._layers.clear(); }, addTo() { return this; }, hasLayer() { return true; }, remove() {} }),
    marker: () => ({ bindTooltip() { return this; }, addTo() { return this; } }),
    divIcon: () => ({}),
  };
  delete require.cache[panelModulePath];
  const panel = require(panelModulePath);
  return { dom, win, fakeFetch, apiFetchCalls, panel };
}

const IDS = { toolbar: 'c-toolbar', status: 'c-status', table: 'c-table' };

async function main() {
  let unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    // ══════════════════════════════════════════════════════════════
    // Mutation A — apiFetch 改回裸 fetch（geoGa4H1ApiRequest 不再透過
    // fetchFn/apiFetch，直接呼叫全域 fetch）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = '  const res = await fetchFn(url, options);';
      const MUT = '  const res = await fetch(url, options); // MUTATION-A: bypasses apiFetch entirely';
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('A0. Mutation A hits exactly one byte-exact occurrence in production source', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-a-panel');
      const { fakeFetch: mFetch, apiFetchCalls: mCalls, panel: mPanel } = loadEnv(mutPath, [{ test: /realtime/, body: { success: true, cities: [] } }]);
      await mPanel.geoGa4H1Fetch('realtime');
      const mutatedBypassesApiFetch = mCalls.length === 0 && mFetch.calls.length === 1 && !mFetch.calls[0].opts.headers.Authorization;

      const { fakeFetch: rFetch, apiFetchCalls: rCalls, panel: rPanel } = loadEnv(PANEL_PATH, [{ test: /realtime/, body: { success: true, cities: [] } }]);
      await rPanel.geoGa4H1Fetch('realtime');
      const realStillUsesApiFetch = rCalls.length === 1 && rFetch.calls.length === 1 && !!rFetch.calls[0].opts.headers.Authorization;

      check('A. "apiFetch reverted to bare fetch" mutation is detected (bypasses Authorization; caught)', mutatedBypassesApiFetch && realStillUsesApiFetch);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation B — H1 直接讀 pos_store_token（第二個 Token Reader）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "async function geoGa4H1Fetch(mode, opts = {}) {\n  const controller";
      const MUT = "async function geoGa4H1Fetch(mode, opts = {}) {\n  const _mutationSecondTokenReader = (typeof localStorage !== 'undefined') ? localStorage.getItem('pos_store_token') : null; // MUTATION-B\n  const controller";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('B0. Mutation B hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const codeMutated = stripComments(mutatedSrc);
      const codeReal = stripComments(REAL_PANEL_SRC);
      const pattern = /localStorage\.getItem\(\s*['"`]pos_store_token['"`]\s*\)/;
      const mutatedDetectsSecondReader = pattern.test(codeMutated);
      const realHasNoSecondReader = !pattern.test(codeReal);
      check('B. "H1 reads pos_store_token directly" mutation is detected by the No-Second-Token-Reader check', mutatedDetectsSecondReader && realHasNoSecondReader);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation C — Token 放入 URL（realtime 端點附加 ?token=...）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "  if (mode === 'realtime') {\n    return geoGa4H1ApiRequest('/api/analytics/ga4-geo/realtime', { method: 'GET', ...fetchOpts });\n  }";
      const MUT = "  if (mode === 'realtime') {\n    const _mutationLeakUrl = '/api/analytics/ga4-geo/realtime?token=' + ((typeof localStorage !== 'undefined' && localStorage.getItem('pos_store_token')) || ''); // MUTATION-C\n    return geoGa4H1ApiRequest(_mutationLeakUrl, { method: 'GET', ...fetchOpts });\n  }";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('C0. Mutation C hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const secretToken = 'qa_secret_C_9f8e7d6c5b4a';
      const mutPath = writeTempModule(mutatedSrc, 'mut-c-panel');
      const { fakeFetch: mFetch, panel: mPanel } = loadEnv(mutPath, [{ test: /realtime/, body: { success: true, cities: [] } }], { token: secretToken });
      await mPanel.geoGa4H1Fetch('realtime');
      const mutatedLeaksToken = mFetch.calls.some((c) => c.url.includes(secretToken));

      const { fakeFetch: rFetch, panel: rPanel } = loadEnv(PANEL_PATH, [{ test: /realtime/, body: { success: true, cities: [] } }], { token: secretToken });
      await rPanel.geoGa4H1Fetch('realtime');
      const realNeverLeaksToken = !rFetch.calls.some((c) => c.url.includes(secretToken));

      check('C. "Token placed in URL" mutation is detected (Token-never-in-URL check catches it)', mutatedLeaksToken && realNeverLeaksToken);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation D — 401 錯誤映射改成 ga4_backend_error。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "      code: res.status === 401 ? 'auth_required' : 'feature_disabled',";
      const MUT = "      code: res.status === 401 ? 'ga4_backend_error' : 'feature_disabled', // MUTATION-D";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('D0. Mutation D hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-d-panel');
      const { panel: mPanel } = loadEnv(mutPath, [{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      const mutatedResult = await mPanel.geoGa4H1Fetch('realtime');
      const mutatedMisclassifies401 = mutatedResult.code === 'ga4_backend_error';

      const { panel: rPanel } = loadEnv(PANEL_PATH, [{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      const realResult = await rPanel.geoGa4H1Fetch('realtime');
      const realClassifiesCorrectly = realResult.code === 'auth_required';

      check('D. "401 mapped to ga4_backend_error" mutation is detected (401 classification check catches it)', mutatedMisclassifies401 && realClassifiesCorrectly);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation E — 403 錯誤映射改成 auth_required。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "      code: res.status === 401 ? 'auth_required' : 'feature_disabled',";
      const MUT = "      code: res.status === 401 ? 'auth_required' : 'auth_required', // MUTATION-E";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('E0. Mutation E hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-e-panel');
      const { panel: mPanel } = loadEnv(mutPath, [{ test: /realtime/, status: 403, body: { success: false, error: 'FEATURE_DISABLED' } }]);
      const mutatedResult = await mPanel.geoGa4H1Fetch('realtime');
      const mutatedMisclassifies403 = mutatedResult.code === 'auth_required';

      const { panel: rPanel } = loadEnv(PANEL_PATH, [{ test: /realtime/, status: 403, body: { success: false, error: 'FEATURE_DISABLED' } }]);
      const realResult = await rPanel.geoGa4H1Fetch('realtime');
      const realClassifiesCorrectly = realResult.code === 'feature_disabled';

      check('E. "403 mapped to auth_required" mutation is detected (403 classification check catches it)', mutatedMisclassifies403 && realClassifiesCorrectly);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation F — Sync 無條件 Refresh（失敗也 refresh）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = 'async function _geoGa4H1HandleSyncResult(result, onChange) {\n  if (result && result.success === true) {';
      const MUT = 'async function _geoGa4H1HandleSyncResult(result, onChange) {\n  if (true) { // MUTATION-F: refreshes unconditionally, even on failure';
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('F0. Mutation F hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-f-panel');
      const { panel: mPanel } = loadEnv(mutPath, []);
      let mutatedOnChangeCalls = 0;
      await mPanel._geoGa4H1HandleSyncResult({ success: false, code: 'rate_limited' }, () => { mutatedOnChangeCalls += 1; return Promise.resolve(); });
      const mutatedRefreshesOnFailure = mutatedOnChangeCalls === 1;

      const { panel: rPanel } = loadEnv(PANEL_PATH, []);
      let realOnChangeCalls = 0;
      await rPanel._geoGa4H1HandleSyncResult({ success: false, code: 'rate_limited' }, () => { realOnChangeCalls += 1; return Promise.resolve(); });
      const realNeverRefreshesOnFailure = realOnChangeCalls === 0;

      check('F. "Sync refreshes unconditionally" mutation is detected (success-only-refresh contract catches it)', mutatedRefreshesOnFailure && realNeverRefreshesOnFailure);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation G — Sync Response 不解析（改回 fire-and-forget）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = '      if (result !== undefined) await _geoGa4H1HandleSyncResult(result, onChange);';
      const MUT = '      // MUTATION-G: fire-and-forget — response is fetched but never parsed/handled';
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('G0. Mutation G hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-g-panel');
      const { win: mWin, fakeFetch: mFetch, panel: mPanel } = loadEnv(mutPath, [
        { test: /realtime/, body: { success: true, cities: [] } },
        { test: /sync/, body: { success: true, rows_saved: 9 } },
      ]);
      const mMap = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      mPanel.geoGa4H1Init(IDS, mMap);
      await mPanel.geoGa4H1Refresh(IDS, mMap);
      const mRealtimeCallsBefore = mFetch.calls.filter((c) => c.url.includes('/realtime')).length;
      const mSyncBtn = mWin.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
      mSyncBtn.dispatchEvent(new mWin.Event('click'));
      await new Promise((r) => setTimeout(r, 30));
      const mRealtimeCallsAfter = mFetch.calls.filter((c) => c.url.includes('/realtime')).length;
      const mutatedNeverRefreshesEvenOnSuccess = mRealtimeCallsAfter === mRealtimeCallsBefore;

      const { win: rWin, fakeFetch: rFetch, panel: rPanel } = loadEnv(PANEL_PATH, [
        { test: /realtime/, body: { success: true, cities: [] } },
        { test: /sync/, body: { success: true, rows_saved: 9 } },
      ]);
      const rMap = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      rPanel.geoGa4H1Init(IDS, rMap);
      await rPanel.geoGa4H1Refresh(IDS, rMap);
      const rRealtimeCallsBefore = rFetch.calls.filter((c) => c.url.includes('/realtime')).length;
      const rSyncBtn = rWin.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
      rSyncBtn.dispatchEvent(new rWin.Event('click'));
      await new Promise((r) => setTimeout(r, 30));
      const rRealtimeCallsAfter = rFetch.calls.filter((c) => c.url.includes('/realtime')).length;
      const realRefreshesOnSuccess = rRealtimeCallsAfter === rRealtimeCallsBefore + 1;

      check('G. "Sync response never parsed (fire-and-forget)" mutation is detected (sync-response-parsing check catches it)', mutatedNeverRefreshesEvenOnSuccess && realRefreshesOnSuccess);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation H — AbortError 重新 throw（不再安靜吞掉）。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = '    if (_geoGa4H1IsAbortError(e)) return undefined;\n    throw e;';
      const MUT = '    throw e; // MUTATION-H: no longer swallows AbortError, rethrows everything';
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('H0. Mutation H hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-h-panel');
      const mPanel = require(mutPath);
      const abortErr = new Error('aborted'); abortErr.name = 'AbortError';
      let mutatedThrew = false;
      try { await mPanel.geoGa4H1SafeRunFetch(() => { throw abortErr; }); } catch (e) { mutatedThrew = true; }

      delete require.cache[PANEL_PATH];
      const rPanel = require(PANEL_PATH);
      let realThrew = false;
      try { await rPanel.geoGa4H1SafeRunFetch(() => { throw abortErr; }); } catch (e) { realThrew = true; }

      check('H. "AbortError rethrown instead of swallowed" mutation is detected (Abort-safe contract catches it)', mutatedThrew === true && realThrew === false);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation I — Listener Promise 移除安全 catch（Mode／Metric）。
    // ══════════════════════════════════════════════════════════════
    {
      // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：Stage 4.1 在
      // _geoGa4H1RenderRangeMount() 內新增了第三個合法呼叫點（GeoRangeControl
      // 的 onChange callback，一樣需要 .catch(_geoGa4H1SwallowAbort) 防護）。
      // 這個新呼叫點在原始碼裡的位置在 `const modeHandler = ...` 之前，
      // 所以不會落進下面 modeBody／metricBody 的切片範圍——原本針對
      // modeHandler／metricHandler 兩處的保護測試意圖完全不變，這裡只是
      // 把「命中次數」的期待值從 2 更新成 3（OUTDATED CONTRACT ASSERTION：
      // 舊＝剛好 2 處；新＝新增 rangeMount onChange 後變成 3 處，保護意圖
      // 「所有 onChange() 呼叫都要有安全 catch」本身沒有變）。
      const ORIG = 'Promise.resolve(onChange()).catch(_geoGa4H1SwallowAbort);';
      const MUT = 'Promise.resolve(onChange()); // MUTATION-I: no .catch(...) guard';
      const mutatedSrc = mutateAll(REAL_PANEL_SRC, ORIG, MUT, 3);
      check('I0. Mutation I hits exactly 3 byte-exact occurrences (rangeMount onChange + modeHandler + metricHandler)', mutatedSrc !== REAL_PANEL_SRC);

      const codeMutated = stripComments(mutatedSrc);
      const codeReal = stripComments(REAL_PANEL_SRC);
      const modeStart = codeMutated.indexOf('const modeHandler = (e) => {');
      const modeEnd = codeMutated.indexOf('const metricHandler');
      const metricEnd = codeMutated.indexOf('const syncHandler');
      const modeBody = codeMutated.slice(modeStart, modeEnd);
      const metricBody = codeMutated.slice(modeEnd, metricEnd);
      const mutatedMissingCatch = !modeBody.includes('.catch(') && !metricBody.includes('.catch(');

      const rModeStart = codeReal.indexOf('const modeHandler = (e) => {');
      const rModeEnd = codeReal.indexOf('const metricHandler');
      const rMetricEnd = codeReal.indexOf('const syncHandler');
      const rModeBody = codeReal.slice(rModeStart, rModeEnd);
      const rMetricBody = codeReal.slice(rModeEnd, rMetricEnd);
      const realHasCatch = rModeBody.includes('.catch(') && rMetricBody.includes('.catch(');

      check('I. "Listener promise missing .catch(...)" mutation is detected (Listener-promise-catch check catches it)', mutatedMissingCatch && realHasCatch);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation J — Legacy geo-ga4-realtime-layer.js：移除 try/catch，
    // 讓 AbortError 直接外漏成 unhandled rejection。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "  let payload;\n  try {\n    payload = await geoGa4FetchData({\n      windowMinutes: geoGa4State.windowMinutes, metric: geoGa4State.metric, refresh,\n      signal: controller ? controller.signal : undefined,\n    });\n  } catch (e) {\n    if (e && e.name === 'AbortError') return; // 被下一次呼叫取代，安靜結束，不覆蓋新狀態\n    payload = geoGa4NormalizeResponse(null);\n    payload.status = 'error';\n    payload.message = 'GA4 Realtime API 發生錯誤，請稍後再試';\n  }";
      const MUT = "  let payload;\n  // MUTATION-J: try/catch removed — AbortError now propagates unhandled\n  payload = await geoGa4FetchData({\n    windowMinutes: geoGa4State.windowMinutes, metric: geoGa4State.metric, refresh,\n    signal: controller ? controller.signal : undefined,\n  });";
      const mutatedSrc = mutateOnce(REAL_LAYER_SRC, ORIG, MUT);
      check('J0. Mutation J hits exactly one byte-exact occurrence', mutatedSrc !== REAL_LAYER_SRC);

      const before = unhandled.length;
      const mutPath = writeTempModule(mutatedSrc, 'mut-j-layer');
      const dom = makeDom();
      const win = dom.window;
      win.localStorage.setItem('pos_store_token', 'mock_token_qa_only');
      win.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001' }));
      win.fetch = makeFakeNetworkFetch([{ test: /ga4-realtime/, delayMs: 10, body: { success: true, data: { status: 'fresh', quota_status: 'ok', fetched_at: new Date().toISOString(), summary: {}, counties: [], unmapped: [], notices: [] } } }]);
      win.eval(REAL_AUTH_SRC);
      global.window = win;
      global.document = win.document;
      global.localStorage = win.localStorage;
      global.apiFetch = win.apiFetch; // geo-ga4-realtime-layer.js 只檢查裸 apiFetch，見上面 46/47 同樣的修正
      const containerId = 'c-realtime-mut-j';
      ['toolbar', 'summary', 'status', 'notices'].forEach((suffix) => {
        const el = win.document.createElement('div');
        el.id = `${containerId}-ga4-${suffix}`;
        win.document.body.appendChild(el);
      });
      delete require.cache[mutPath];
      const mLayer = require(mutPath);
      // 故意「不 await」——完全模擬真實 onclick／連續呼叫的情境：呼叫端拿到
      // Promise 後沒有接 .then/.catch，如果函式內部沒有安全處理，reject
      // 就會變成 Node 的 unhandledRejection（如果這裡改用
      // Promise.allSettled([...]) 去等它們，等於是我們自己把 rejection
      // 「接住」了，那就測不出真正的洩漏——必須讓它裸奔）。
      mLayer.geoGa4FetchAndRender(containerId); // p1：慢（要先等 status fetch）
      await new Promise((r) => setTimeout(r, 3));
      mLayer.geoGa4FetchAndRender(containerId); // p2：快，會被 p1 later 反過來 abort（或反之）
      await new Promise((r) => setTimeout(r, 40));
      const mutatedLeaksUnhandledRejection = unhandled.length > before;

      check('J. "Legacy Realtime Layer AbortError leak" mutation is detected (produces a real unhandledRejection)', mutatedLeaksUnhandledRejection, `unhandled count before=${before} after=${unhandled.length}`);
      // 需求文件：清空這裡故意產生的 unhandled 記錄，避免污染後面的計數。
      unhandled = [];
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation K — apiFetch Auth Object 直接無條件呼叫 res.json()。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "  // apiFetch 對 401／403 回傳的不是原生 Response（沒有 .json()），必須先\n  // 判斷 ok===false && status 再決定要不要呼叫 .json()（需求文件四）。\n  if (res.ok === false && (res.status === 401 || res.status === 403)) {\n    return {\n      success: false,\n      code: res.status === 401 ? 'auth_required' : 'feature_disabled',\n      http_status: res.status,\n      body: res.body || {},\n    };\n  }\n\n  if (typeof res.json !== 'function') {\n    return { success: false, code: 'invalid_response', http_status: (typeof res.status === 'number' ? res.status : null) };\n  }\n\n  let json;";
      const MUT = "  // MUTATION-K: auth-object guard removed — calls res.json() unconditionally\n  let json;";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('K0. Mutation K hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const mutPath = writeTempModule(mutatedSrc, 'mut-k-panel');
      const { panel: mPanel } = loadEnv(mutPath, [{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      let mutatedThrew = false;
      let mutatedResult;
      try { mutatedResult = await mPanel.geoGa4H1Fetch('realtime'); } catch (e) { mutatedThrew = true; }
      // apiFetch 401 回傳的物件沒有 .json，無條件呼叫會直接 TypeError：這裡
      // 允許「整段流程 throw」或「往上層被 try/catch 吞成非預期結果」兩種
      // 觀察方式都算偵測到問題，只要行為不再是正確的 auth_required 分類。
      const mutatedBroken = mutatedThrew || !mutatedResult || mutatedResult.code !== 'auth_required';

      const { panel: rPanel } = loadEnv(PANEL_PATH, [{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      const realResult = await rPanel.geoGa4H1Fetch('realtime');
      const realStillCorrect = realResult && realResult.code === 'auth_required';

      check('K. "apiFetch 401/403 object passed unconditionally to res.json()" mutation is detected (breaks 401 handling)', mutatedBroken && realStillCorrect);
    }

    // ══════════════════════════════════════════════════════════════
    // Mutation L — Raw Error 顯示至 DOM。
    // ══════════════════════════════════════════════════════════════
    {
      const ORIG = "  else if (payload.success === false) {\n    text = GA4_H1_STATUS_CODE_MAP[payload.code] || 'GA4 資料暫時無法取得，已顯示最後一次成功的快取。';\n  } else if (payload.stale) {";
      const MUT = "  else if (payload.success === false) {\n    text = payload.raw_error_stack || payload.raw_error_message || GA4_H1_STATUS_CODE_MAP[payload.code] || 'GA4 資料暫時無法取得，已顯示最後一次成功的快取。'; // MUTATION-L\n  } else if (payload.stale) {";
      const mutatedSrc = mutateOnce(REAL_PANEL_SRC, ORIG, MUT);
      check('L0. Mutation L hits exactly one byte-exact occurrence', mutatedSrc !== REAL_PANEL_SRC);

      const rawSecret = 'Error: internal /etc/passwd stack trace leak line 42';
      const mutPath = writeTempModule(mutatedSrc, 'mut-l-panel');
      const { win: mWin, panel: mPanel } = loadEnv(mutPath, []);
      mPanel.geoGa4H1RenderStatus(IDS.status, { success: false, code: 'ga4_backend_error', raw_error_stack: rawSecret });
      const mutatedLeaksRawError = mWin.document.getElementById(IDS.status).textContent.includes(rawSecret);

      const { win: rWin, panel: rPanel } = loadEnv(PANEL_PATH, []);
      rPanel.geoGa4H1RenderStatus(IDS.status, { success: false, code: 'ga4_backend_error', raw_error_stack: rawSecret });
      const realNeverLeaksRawError = !rWin.document.getElementById(IDS.status).textContent.includes(rawSecret);

      check('L. "Raw error rendered into DOM" mutation is detected (No-raw-error-output check catches it)', mutatedLeaksRawError && realNeverLeaksRawError);
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    cleanupTempFiles();
    delete require.cache[PANEL_PATH];
    delete require.cache[LAYER_PATH];
  }

  if (unhandled.length) {
    console.log(`\n[WARN] ${unhandled.length} unexpected unhandledRejection(s) outside Mutation J's own assertion window:`);
    unhandled.forEach((r, i) => console.log(`  #${i + 1}:`, r && r.stack ? r.stack.split('\n')[0] : r));
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1.1 Auth Mutation Suite: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  cleanupTempFiles();
  console.error('Mutation suite crashed:', e);
  process.exit(1);
});
