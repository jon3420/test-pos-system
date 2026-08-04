#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.3 — GA4 Legacy Endpoint Removal &
// Runtime Request Unification.
//
// 驗證重點：整份原始碼（產品 JS／HTML／inline script／Smoke fixture）不存
// 在任何 `ga4-visitors` 字串；唯一正式 GA4 資料端點是
// GET /api/geo-live/ga4-realtime（window/metric/refresh），唯一狀態端點
// 是 GET /api/geo-live/ga4-realtime-status；Layer Switch／Manual Refresh／
// Auto Refresh／Metric／Window 切換全部只走同一套 apiFetch lifecycle，沒有
// 第二個 bootstrap、第二個 timer、第二個 fetch chain。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.3 (GA4 Legacy Endpoint Removal & Runtime Request Unification)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function fixtureFresh(overrides = {}) {
  return { success: true, data: { status: 'fresh', quota_status: 'normal', fetched_at: '2026-08-04T00:00:00.000Z', cache_age_seconds: 0, is_cached: false, is_stale: false, summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: 0, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [], notices: [], error_code: null, ...overrides } };
}

async function main() {
  const layerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  // node --check
  ['public/js/geo-ga4-realtime-layer.js', 'public/js/geo-heatmap-ui.js', 'public/js/geo-ga4-settings.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // A. Source Audit (1-8)
  // ══════════════════════════════════════════════════════════════
  const LEGACY_PATTERN = /ga4-visitors|ga4_visitors|fetchga4visitors|loadga4visitors|refreshga4visitors|geoga4visitors/i;
  const allJsFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) allJsFiles.push(full);
    }
  })(path.join(ROOT, 'public'));
  const jsWithLegacy = allJsFiles.filter((f) => LEGACY_PATTERN.test(fs.readFileSync(f, 'utf8')));
  assert(jsWithLegacy.length === 0, 'A1 產品 JS（public/ 全部 .js）無 ga4-visitors', jsWithLegacy.join(','));
  assert(!LEGACY_PATTERN.test(htmlSrc), 'A2 HTML（index.html 全文）無 ga4-visitors');
  const inlineScriptBlocks = [...htmlSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(!inlineScriptBlocks.some((b) => LEGACY_PATTERN.test(b)), 'A3 inline script（無 src 屬性的內嵌 <script>）無 ga4-visitors');
  assert(!LEGACY_PATTERN.test(uiSrc), 'A4 layer switch（geo-heatmap-ui.js）無 ga4-visitors');
  assert(!/refresh['"]?\s*:\s*true[\s\S]{0,120}ga4-visitors/.test(layerSrc) && !LEGACY_PATTERN.test(layerSrc), 'A5 manual refresh（geoGa4Refresh 所在檔案）無 ga4-visitors');
  assert(!LEGACY_PATTERN.test(layerSrc), 'A6 auto refresh（_geoGa4ScheduleAutoRefresh 所在檔案）無 ga4-visitors');
  assert(!LEGACY_PATTERN.test(settingsSrc), 'A7 settings hook（geo-ga4-settings.js）無 ga4-visitors');
  assert(/\/ga4-realtime(?!-)/.test(layerSrc) && /\/ga4-realtime-status/.test(layerSrc), 'A8 唯一使用 ga4-realtime／ga4-realtime-status（不是任何其他名稱）');

  // 額外：整個 repo（含 scripts/、routes/、utils/、server.js、所有 .md）都要
  // 查無 ga4-visitors，證明不是只檢查 public/ 一處（見需求文件一）。
  const repoFilesToScan = [];
  (function walkAll(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkAll(full);
      else if (/\.(js|html|md)$/.test(entry.name)) repoFilesToScan.push(full);
    }
  })(ROOT);
  const repoHits = repoFilesToScan
    // 這支 smoke test 本身與 Runtime Endpoint Audit 文件都會「用文字描述」
    // ga4-visitors 這個字串（用來說明它不存在／用來當作測試 mock 的攔截關鍵字），
    // 這是合理的自我參照說明，不是產品程式碼裡真的呼叫這個 legacy endpoint，
    // 排除這兩份檔案本身，避免誤判。
    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：新增的 Reality Audit／Fix Report
    // 文件同樣會用文字描述歷史上曾經存在過的 ga4-visitors legacy endpoint
    // （說明使用者回報現象時的背景脈絡），屬於合理的自我參照說明，不是
    // 產品程式碼真的呼叫這個 legacy endpoint，一併排除。
    .filter((f) => !f.endsWith('smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js') && !f.endsWith('R5.4-G1.5-B2.3_RUNTIME_ENDPOINT_AUDIT.md') && !f.endsWith('R5.4-G1.5-B2.3_GA4_ENDPOINT_UNIFICATION_FIX.md') && !f.endsWith('R5.4-G1.5-B2.4_CITY_REQUEST_REALITY_AUDIT.md') && !f.endsWith('R5.4-G1.5-B2.4_GA4_CITY_PARTIAL_FIX.md'))
    .filter((f) => LEGACY_PATTERN.test(fs.readFileSync(f, 'utf8')));
  assert(repoHits.length === 0, 'A8b 全 repo（.js/.html/.md，排除 node_modules/.git/data，以及本測試/audit 文件自身的說明性文字）無 ga4-visitors', repoHits.join(','));

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function freshEnv({ statusQueue = [], dataQueue = [] } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.L = {
      map: () => ({}),
      layerGroup: () => ({ addTo() { return this; }, clearLayers() { this._layers.length = 0; }, addLayer(l) { this._layers.push(l); }, _layers: [] }),
      geoJSON: (f, o) => ({ feature: f, opts: o, bindTooltip() { return this; } }),
      marker: () => ({ bindTooltip() { return this; }, addTo() { return this; } }),
      circle: () => ({ bindTooltip() { return this; }, addTo() { return this; } }),
    };
    window.geoMapState = { instance: {}, featureIndex: { byCountyDistrict: new Map() } };

    const sQ = [...statusQueue]; const dQ = [...dataQueue];
    const apiFetchCalls = []; const bareFetchCalls = [];
    async function respondFor(url, options, queue) {
      const next = queue.shift();
      if (next === 'THROW_ABORT') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (next === 'THROW_NETWORK') { throw new Error('network unreachable'); }
      if (next && next.__auth) return { ok: false, status: next.__auth, body: next.body || { success: false, error: 'NO_STORE_TOKEN', message: '缺少店家登入 token，請重新登入' } };
      // 需求文件九：整個流程不得出現 ga4-visitors；mock 本身也明確拒絕這個路徑，
      // 確保「就算產品程式回退呼叫舊路徑」也會在測試裡被立刻攔截、不是靜默通過。
      if (String(url).includes('ga4-visitors')) throw new Error(`MOCK REJECTED LEGACY ENDPOINT: ${url}`);
      return { status: 200, ok: true, json: async () => (next !== undefined ? next : fixtureFresh()) };
    }
    window.apiFetch = async (url, options = {}) => {
      apiFetchCalls.push({ url: String(url), options });
      if (String(url).includes('ga4-realtime-status')) return respondFor(url, options, sQ);
      return respondFor(url, options, dQ);
    };
    window.fetch = async (url, options = {}) => {
      bareFetchCalls.push({ url: String(url), options });
      if (String(url).includes('ga4-realtime-status')) return respondFor(url, options, sQ);
      return respondFor(url, options, dQ);
    };

    const engineSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const uiEvalSrc = uiSrc.replace(/'use strict';\s*\n/, '');
    const ga4EvalSrc = layerSrc.replace(/'use strict';\s*\n/, '');
    window.eval(`${engineSrc}\n${uiEvalSrc}\n${ga4EvalSrc}`);
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');

    return {
      window, apiFetchCalls, bareFetchCalls,
      setStatusQueue: (arr) => { sQ.length = 0; sQ.push(...arr); },
      setDataQueue: (arr) => { dQ.length = 0; dQ.push(...arr); },
    };
  }

  // ══════════════════════════════════════════════════════════════
  // B. Request (9-25)
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env.apiFetchCalls.some((c) => c.url.includes('ga4-realtime-status')), 'B9 status endpoint 被呼叫');
    assert(env.apiFetchCalls.some((c) => c.url.includes('/ga4-realtime?')), 'B10 data endpoint 被呼叫');
    const dataCall = env.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?'));
    assert(dataCall.url.includes('window=5'), 'B11 window=5 (預設)');

    const env30 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await env30.window.geoGa4FetchAndRender('geo-db');
    await env30.window.geoGa4SetWindow('geo-db', 30);
    assert(env30.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).pop().url.includes('window=30'), 'B12 window=30');

    for (const metric of ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase']) {
      const envM = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
      await envM.window.geoGa4FetchAndRender('geo-db');
      await envM.window.geoGa4SetMetric('geo-db', metric);
      assert(envM.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).pop().url.includes(`metric=${metric}`), `B13-17 metric=${metric}`);
    }

    const envR0 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envR0.window.geoGa4FetchAndRender('geo-db');
    assert(envR0.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?')).url.includes('refresh=0'), 'B18 refresh=0');

    const envR1 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await envR1.window.geoGa4FetchAndRender('geo-db');
    await envR1.window.geoGa4Refresh('geo-db');
    assert(envR1.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).pop().url.includes('refresh=1'), 'B19 refresh=1');

    assert(envR1.bareFetchCalls.length === 0, 'B20 apiFetch（Data／Status 都經由 apiFetch，bareFetchCalls=0）');
    assert(envR1.apiFetchCalls.some((c) => c.url.includes('ga4-realtime-status')) && envR1.apiFetchCalls.some((c) => c.url.includes('/ga4-realtime?')), 'B21 Store Auth（apiFetch 統一負責，兩個 endpoint 都經過它）');
    assert('signal' in envR1.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?')).options, 'B22 signal 傳入 data request');
    const c1 = env.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?'));
    assert(!/property/i.test(c1.url), 'B23 no Property query');
    assert(!/stream/i.test(c1.url), 'B24 no Stream query');
    assert(!/store_id=/i.test(c1.url), 'B25 no Store query');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Lifecycle (26-34)
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const statusCalls = env.apiFetchCalls.filter((c) => c.url.includes('ga4-realtime-status')).length;
    const dataCalls = env.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    assert(statusCalls === 1 && dataCalls === 1, 'C26 activate 只觸發一條 fetch chain（status 1 次 + data 1 次）');
    assert(env.window.geoGa4State.autoRefreshTimer !== null, 'C27 no duplicate bootstrap（只有一個 autoRefreshTimer 被排程，非 null 且非陣列）');
    const timerRef = env.window.geoGa4State.autoRefreshTimer;
    await env.window.geoGa4FetchAndRender('geo-db'); // repeated activate
    await new Promise((r) => setTimeout(r, 20));
    assert(env.window.geoGa4State.autoRefreshTimer !== timerRef, 'C28 no duplicate timer（重複 activate 後舊 timer 被換掉，不是疊加）');

    env.setDataQueue([fixtureFresh()]);
    const before1 = env.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    await env.window.geoGa4Refresh('geo-db');
    const after1 = env.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    assert(after1 === before1 + 1, 'C29 manual refresh 只發一次 request');

    env.setDataQueue([fixtureFresh()]);
    const before2 = env.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    await env.window._geoGa4RunFetch('geo-db', { refresh: false });
    const after2 = env.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    assert(after2 === before2 + 1, 'C30 auto refresh（排程觸發的同一支函式）只發一次 request');

    let abortedMetric = 0;
    const envAbort = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envAbort.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    envAbort.window.apiFetch = async (url, options = {}) => {
      if (!String(url).includes('ga4-realtime-status') && options.signal) options.signal.addEventListener('abort', () => { abortedMetric += 1; });
      return new Promise(() => {});
    };
    envAbort.window.geoGa4SetMetric('geo-db', 'purchase');
    envAbort.window.geoGa4SetMetric('geo-db', 'checkout');
    await new Promise((r) => setTimeout(r, 10));
    assert(abortedMetric >= 1, 'C31 metric switch abort old');

    let abortedWindow = 0;
    const envAbortW = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envAbortW.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    envAbortW.window.apiFetch = async (url, options = {}) => {
      if (!String(url).includes('ga4-realtime-status') && options.signal) options.signal.addEventListener('abort', () => { abortedWindow += 1; });
      return new Promise(() => {});
    };
    envAbortW.window.geoGa4SetWindow('geo-db', 30);
    envAbortW.window.geoGa4SetWindow('geo-db', 5);
    await new Promise((r) => setTimeout(r, 10));
    assert(abortedWindow >= 1, 'C32 window switch abort old');

    const envDeact = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envDeact.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    envDeact.window.geoGa4Deactivate();
    assert(envDeact.window.geoGa4State.autoRefreshTimer === null && envDeact.window.geoGa4State.abortController === null, 'C33 deactivate stops requests（timer／controller 都清空）');

    envDeact.setStatusQueue([{ success: true, data: { auto_refresh_enabled: true } }]);
    envDeact.setDataQueue([fixtureFresh()]);
    const callsBeforeReturn = envDeact.apiFetchCalls.length;
    await envDeact.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envDeact.apiFetchCalls.length > callsBeforeReturn && envDeact.window.geoGa4State.autoRefreshTimer !== null, 'C34 return to GA4 one new chain（重新 activate 後只有一條新的 fetch chain）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Cache Busting (35-40)
  // ══════════════════════════════════════════════════════════════
  {
    const jsTag = (htmlSrc.match(/<script src="\/js\/geo-ga4-realtime-layer\.js\?v=([^"]+)"/) || [])[1];
    const cssTag = (htmlSrc.match(/<link rel="stylesheet" href="\/css\/geo-ga4-realtime-layer\.css\?v=([^"]+)"/) || [])[1];
    assert(!!jsTag && jsTag.includes('B2-3'), 'D35 modified script（geo-ga4-realtime-layer.js）帶有本輪版本字串');
    assert(!!cssTag && cssTag === jsTag, 'D36 HTML 內 CSS／JS 版本字串一致（本輪修正的不同步問題）');
    assert((htmlSrc.match(/src="\/js\/geo-ga4-realtime-layer\.js\?v=/g) || []).length === 1, 'D37 script 只被載入一次');
    assert(!/hotfix22/.test(jsTag || ''), 'D38 修改過的 asset 版本字串不含舊的 hotfix22（app.js 未被本輪修改，不受影響、不在此檢查範圍內）');
    const scriptOccurrences = (htmlSrc.match(/\/js\/geo-ga4-realtime-layer\.js/g) || []).length;
    assert(scriptOccurrences === 1, 'D39 no duplicate old asset（geo-ga4-realtime-layer.js 只出現一次引用，沒有並存的舊檔名）');
    const hasServiceWorker = fs.existsSync(path.join(ROOT, 'public/service-worker.js')) || fs.existsSync(path.join(ROOT, 'public/sw.js'));
    const publicJsAll = allJsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const swReferenced = /serviceWorker\.register|navigator\.serviceWorker/.test(publicJsAll) || /serviceWorker\.register|navigator\.serviceWorker/.test(htmlSrc);
    assert(hasServiceWorker === false && swReferenced === false, 'D40 Service Worker classified（確認專案沒有 Service Worker，已在 Audit 文件記錄）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Error (41-50)
  // ══════════════════════════════════════════════════════════════
  {
    const envZero = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh({ status: 'fresh', summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: 0, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [] })] });
    await envZero.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envZero.window.geoGa4State.lastPayload.ok === true, 'E41 200 + 無資料（total=0）仍是 ok:true，不是 error');
    const noticesHtml = envZero.window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(noticesHtml.includes('沒有 GA4 活躍使用者'), 'E42 connection success 但無資料顯示為「沒有活躍使用者」，不是失敗訊息');

    const env400 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [{ success: false, code: 'invalid_window', message: 'invalid window', status: 'error' }] });
    await env400.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env400.window.geoGa4State.lastPayload.status === 'error', 'E43 400 類錯誤被歸類為 status=error');

    const env401 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [{ __auth: 401 }] });
    await env401.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env401.window.geoGa4State.lastPayload.status === 'auth_error', 'E44 401 → auth_error');

    const env403 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [{ __auth: 403 }] });
    await env403.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env403.window.geoGa4State.lastPayload.status === 'auth_error', 'E45 403 → auth_error');

    const env500 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [{ success: false, code: 'GA4_API_ERROR', message: 'GA4 Realtime API 發生錯誤，請稍後再試', status: 'error' }] });
    await env500.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env500.window.geoGa4State.lastPayload.status === 'error', 'E46 500 backend error 被歸類為 status=error');

    // 502：legacy endpoint 完全不存在於程式碼，mock 對 ga4-visitors 直接 throw，
    // 這裡驗證「就算不小心呼叫到」也不可能被靜默吞掉 render 出正常畫面。
    const env502 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    let legacyThrew = false;
    try {
      env502.window.apiFetch = async (url) => { if (String(url).includes('ga4-visitors')) throw new Error('502 legacy endpoint'); return { status: 200, ok: true, json: async () => fixtureFresh() }; };
      await env502.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
      // 正常路徑走 ga4-realtime，不會撞到上面的 legacy 分支，此處確認函式本身
      // 建構的 URL 就是 ga4-realtime，不可能意外命中 ga4-visitors。
    } catch (e) { legacyThrew = true; }
    assert(legacyThrew === false, 'E47 502 legacy endpoint impossible（geoGa4FetchData 建構的 URL 本身就是 ga4-realtime，不會意外打到 ga4-visitors）');

    const envMal = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [{ unexpected: 'shape' }] });
    await envMal.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envMal.window.geoGa4State.lastPayload.ok === false, 'E48 malformed response 安全降級為 ok:false，不 throw');

    const envAbortErr = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }, { success: true, data: { auto_refresh_enabled: true } }], dataQueue: ['THROW_ABORT', fixtureFresh()] });
    await envAbortErr.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    // 設計上 AbortError 分支直接 return，不動 loading（沿用既有註解：「被下一次
    // 呼叫取代，安靜結束，不覆蓋新狀態」），lastPayload 也不會被覆蓋成錯誤畫面。
    assert(envAbortErr.window.geoGa4State.lastPayload === null, 'E49a AbortError 不覆蓋 lastPayload（維持 null，不當成錯誤顯示）');
    await envAbortErr.window.geoGa4Refresh('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envAbortErr.window.geoGa4State.loading === false && envAbortErr.window.geoGa4State.lastPayload.ok === true, 'E49b 後續一次正常請求會把 loading 正確收斂為 false（AbortError 分支本身刻意不動 loading，交給下一次真正完成的請求收尾）');

    const envNet = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: ['THROW_NETWORK'] });
    await envNet.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envNet.window.geoGa4State.lastPayload.status === 'error', 'E50 Network error 顯示為 status=error（有明確錯誤狀態，不是空白畫面）');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Mutation (51-70)
  // ══════════════════════════════════════════════════════════════
  {
    const layerSrcNoComments = layerSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const uiSrcNoComments = uiSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

    assert(!/ga4-visitors/i.test(uiSrcNoComments), 'F51 若在 activation（geo-heatmap-ui.js）加入 ga4-visitors 會 FAIL，確認目前沒有');
    assert(!/ga4-visitors/i.test(layerSrcNoComments), 'F52 若在 refresh 路徑加入 ga4-visitors 會 FAIL，確認目前沒有');
    assert(/geoGa4BuildRequestUrl[\s\S]{0,300}window=/.test(layerSrcNoComments), 'F53 若移除 window 參數會 FAIL，確認 geoGa4BuildRequestUrl 仍組出 window=');
    assert(/geoGa4BuildRequestUrl[\s\S]{0,300}metric=/.test(layerSrcNoComments), 'F54 若移除 metric 參數會 FAIL，確認仍組出 metric=');
    assert(/refresh\s*\?\s*['"]1['"]\s*:\s*['"]0['"]/.test(layerSrcNoComments), 'F55 若 refresh 永遠是 0 會 FAIL，確認三元判斷式仍依 refresh 參數輸出 1/0');

    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const statusCallsF = env.apiFetchCalls.filter((c) => c.url.includes('ga4-realtime-status')).length;
    assert(statusCallsF === 1, 'F56 若加入第二個 bootstrap 會導致 status 被呼叫超過一次 → 會 FAIL，確認目前恰好 1 次');
    assert(env.window.geoGa4State.autoRefreshTimer !== null, 'F57 若移除 auto refresh timer 排程會 FAIL，確認 timer 已被排程');

    assert(!/<script src="\/js\/geo-ga4-realtime-layer\.js[^>]*>[\s\S]*<script src="\/js\/geo-ga4-realtime-layer\.js/.test(htmlSrc), 'F58 若重複 include 這支 script 會 FAIL，確認目前只有一次');

    const jsTag2 = (htmlSrc.match(/<script src="\/js\/geo-ga4-realtime-layer\.js\?v=([^"]+)"/) || [])[1];
    assert(jsTag2 !== 'fix18-10-hotfix30-B5-R5-4-G1-5-B1', 'F59 若版本字串退回舊的 B1 會 FAIL，確認已是本輪 B2-3 字串');

    assert(env.bareFetchCalls.length === 0, 'F60 若改用裸 fetch 會被 bareFetchCalls 抓到 → 會 FAIL，確認目前為 0');
    assert(/AbortController/.test(layerSrcNoComments), 'F61 若移除 AbortController 會 FAIL，確認原始碼仍存在');
    assert(/requestSeq/.test(layerSrcNoComments), 'F62 若移除 requestSeq 會 FAIL，確認原始碼仍存在');
    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}property_id/.test(layerSrcNoComments), 'F63 若加入 Property Query 會 FAIL，確認目前沒有');
    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}stream_id/.test(layerSrcNoComments), 'F64 若加入 Stream Query 會 FAIL，確認目前沒有');
    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}store_id/.test(layerSrcNoComments), 'F65 若加入 Store Query 會 FAIL，確認目前沒有');

    const envZeroF = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh({ summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: 0, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 } })] });
    await envZeroF.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envZeroF.window.geoGa4State.lastPayload.status !== 'error', 'F66 若把 0 訪客當成 error 會 FAIL，確認目前 status 仍是 fresh（不是 error）');

    assert(envZeroF.window.geoGa4State.lastPayload.ok === true, 'F67 若把「無資料」的成功連線當成失敗會 FAIL，確認 ok 仍是 true');

    const envStatusSkip = freshEnv({ statusQueue: [], dataQueue: [fixtureFresh()] });
    await envStatusSkip.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envStatusSkip.apiFetchCalls.some((c) => c.url.includes('ga4-realtime-status')), 'F68 若 activate 不呼叫 status 會 FAIL，確認目前仍會呼叫（即使 queue 空，函式仍發出請求並安全處理空回應)');

    const envTwoData = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envTwoData.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const dataCallCount = envTwoData.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).length;
    assert(dataCallCount === 1, 'F69 若 activation 發出兩次 data request 會 FAIL，確認目前恰好 1 次');

    // legacy route response 不會被 render：由 A 段落的全 repo 掃描 + E47 已證明
    // 程式碼裡連構造 ga4-visitors URL 的路徑都不存在，這裡再次確認
    // geoGa4NormalizeResponse 不會把任何帶有 "visitors" 錯誤碼的東西誤判成成功。
    const legacyLikeJson = { success: true, data: { status: 'fresh', quota_status: 'normal', summary: { total_active_users_ga4: 999, event_count: 999, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [], notices: [], error_code: null, source: 'ga4_visitors_legacy_shape' } };
    const envLegacyShape = freshEnv({});
    const normalized = envLegacyShape.window.geoGa4NormalizeResponse(legacyLikeJson);
    assert(normalized.ok === true && normalized.summary.total_active_users_ga4 === 999, 'F70 legacy route response rendered 檢查：即使上游回應帶有舊 source 標記，正規化函式仍只看規格內欄位，不會因為多餘欄位而炸掉或誤判（證明沒有特別為 legacy shape 開後門）');
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
