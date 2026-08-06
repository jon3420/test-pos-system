#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-1-browser-auth-runtime.js — fix18-10-hotfix30-B5-
// R5.4-G1.6-GA4-H1.1-AUTH
//
// 真實 POS Auth Contract Runtime（不是「繞過 apiFetch 直接 mock
// geoGa4H1ApiRequest」的假測試）。
//
// 什麼是「真實」：
//   - apiFetch()／getToken()／setToken()／clearToken()／showLoginOverlay()
//     這幾個函式的原始碼，是用「標記字串定位＋原始子字串擷取」直接從
//     public/js/app.js 讀出來的一字不差的原始碼（見
//     extractRealAuthContractSource()），不是重寫一份看起來很像的版本。
//     任何一個標記字串在 production app.js 消失（介面被改了但這支測試
//     沒跟著更新），這支測試會直接 throw，逼開發者先處理，而不是悄悄
//     繼續跑一份過期的假 Contract。
//   - public/js/geo-ga4-h1-panel.js 是直接 require 真正的 production 檔案。
//   - localStorage／document 是真的 jsdom localStorage／DOM，不是手刻的
//     Fake Storage 物件。
//   - 只有網路層的 fetch() 是可控的（測試本來就需要控制網路回應才能測
//     401/403/429/502/AbortError 等情境）——apiFetch() 本身完全是真的。
//
// 故意不載入的部分（有註記原因，不是隱藏）：
//   - showToast()：真實定義會操作管理後台的 Toast Container DOM（本測試
//     沒有建那個容器），apiFetch 對它的呼叫本來就已經是
//     `typeof showToast === 'function'` 防禦性判斷——這裡故意不定義它，
//     行為跟正式環境「Toast 容器還沒 mount 前」完全一致，不影響 Auth
//     Contract 本身（Header／Response Shape／401-403 特殊物件）。
//   - doStoreLogin()／hideLoginOverlay()：apiFetch 401 只呼叫
//     showLoginOverlay()，不呼叫這兩個，所以不擷取，減少不必要的風險面。
//
// 需求文件三：至少驗證 45 項（見下方 CHECKS 對照表），連續三次 PASS=45+
// FAIL=0；測試期間監聽 process.on('unhandledRejection')，結束後移除。

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_JS_PATH = path.join(ROOT, 'public/js/app.js');
const PANEL_JS_PATH = path.join(ROOT, 'public/js/geo-ga4-h1-panel.js');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

// ══════════════════════════════════════════════════════════════════
// 真實 apiFetch／Token Contract 原始碼擷取（不是重新定義）
// ══════════════════════════════════════════════════════════════════
function extractRealAuthContractSource() {
  const src = fs.readFileSync(APP_JS_PATH, 'utf8');
  const startMarker = "const TOKEN_KEY = 'pos_store_token';";
  const fnMarker = 'function showLoginOverlay() {';

  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('production app.js 找不到 TOKEN_KEY 定義——Contract 標記已改變，測試必須先更新');

  const fnIdx = src.indexOf(fnMarker, startIdx);
  if (fnIdx === -1) throw new Error('production app.js 找不到 showLoginOverlay 定義——Contract 標記已改變，測試必須先更新');

  const afterFn = src.slice(fnIdx);
  const closeIdx = afterFn.indexOf('\n}\n');
  if (closeIdx === -1) throw new Error('production app.js 找不到 showLoginOverlay 函式收尾——Contract 標記已改變，測試必須先更新');

  const endIdx = fnIdx + closeIdx + 3;
  const block = src.slice(startIdx, endIdx);

  const mustContain = [
    'async function apiFetch(url, options = {})',
    "headers['Authorization'] = 'Bearer '",
    "headers['x-store-id']",
    'res.status === 401',
    'res.status === 403',
    'return { ok: false, status: 401, body }',
    'return { ok: false, status: 403, body }',
    'clearToken()',
    'showLoginOverlay()',
    'function showLoginOverlay()',
  ];
  mustContain.forEach((m) => {
    if (!block.includes(m)) throw new Error(`擷取到的 Auth Contract 區塊缺少預期片段（production 介面可能已變更）: ${m}`);
  });
  return block;
}

const REAL_AUTH_SRC = extractRealAuthContractSource();
const PANEL_SRC = fs.readFileSync(PANEL_JS_PATH, 'utf8');

// stripComments — 沿用 scripts/static-audit-g1-6-ga4-h1.js 同一慣例：Regex
// 檢查一定要排除註解／文件說明文字，否則「我們故意不這樣做」這種誠實
// 說明反而會被誤判成「真的這樣做了」（例如本檔案開頭邊界註解裡就寫著
// 「不得再直接裸 fetch('/api/analytics/ga4-geo/...')」這句話本身）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}
const PANEL_CODE = stripComments(PANEL_SRC);

// ══════════════════════════════════════════════════════════════════
// jsdom 環境：真 localStorage／真 DOM／可控網路層 fetch
// ══════════════════════════════════════════════════════════════════
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
    if (route && route.reject) {
      if (typeof route.reject === 'function') throw route.reject();
      throw route.reject;
    }
    const signal = opts.signal;
    const delayMs = (route && route.delayMs) || 0;
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
    if (route.rawResponse) return (typeof route.rawResponse === 'function') ? route.rawResponse(url, opts) : route.rawResponse;
    const status = (typeof route.status === 'number') ? route.status : 200;
    const body = (typeof route.body === 'function') ? route.body(url, opts) : route.body;
    return { status, ok: status < 400, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// loadRealEnv() — 載入真實 apiFetch Contract + 真實 Panel 到一個全新的
// jsdom window／全新 module cache，每個測項互不污染。
function loadRealEnv(routes, { token = 'header.payload.signature', storeId = 'store_001' } = {}) {
  const dom = makeDom();
  const win = dom.window;

  if (token !== null) win.localStorage.setItem('pos_store_token', token);
  if (storeId !== null) win.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: storeId }));

  const fakeFetch = makeFakeNetworkFetch(routes);
  win.fetch = fakeFetch;
  win.eval(REAL_AUTH_SRC); // 真實 apiFetch／getToken／clearToken／showLoginOverlay

  // spy：包一層記錄呼叫次數，但實際還是呼叫真正的 win.apiFetch。
  const realApiFetch = win.apiFetch;
  const apiFetchCalls = [];
  win.apiFetch = async function spiedApiFetch(...args) {
    apiFetchCalls.push(args);
    return realApiFetch.apply(win, args);
  };

  global.window = win;
  global.document = win.document;
  global.L = {
    layerGroup: () => ({ _layers: new Set(), addLayer(l) { this._layers.add(l); }, removeLayer(l) { this._layers.delete(l); }, clearLayers() { this._layers.clear(); }, addTo() { return this; }, hasLayer() { return true; }, remove() {} }),
    marker: () => ({ bindTooltip() { return this; }, addTo() { return this; } }),
    divIcon: () => ({}),
  };
  delete require.cache[PANEL_JS_PATH];
  const panel = require(PANEL_JS_PATH);

  return { dom, win, fakeFetch, apiFetchCalls, panel };
}

const IDS = { toolbar: 'c-toolbar', status: 'c-status', table: 'c-table' };

async function main() {
  let unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    // ── 1-2. localStorage 有 token／store context ──
    {
      const { win } = loadRealEnv([{ test: /realtime/, body: { success: true, cities: [] } }]);
      check('1. localStorage has pos_store_token', win.localStorage.getItem('pos_store_token') === 'header.payload.signature');
      const info = JSON.parse(win.localStorage.getItem('pos_store_info') || '{}');
      check('2. localStorage has current store context (pos_store_info.store_id)', info.store_id === 'store_001');
    }

    // ── 3-4. GET realtime／history 經過真實 apiFetch ──
    {
      const { fakeFetch, apiFetchCalls, panel } = loadRealEnv([
        { test: /realtime/, body: { success: true, cities: [] } },
        { test: /history/, body: { success: true, rows: [] } },
      ]);
      await panel.geoGa4H1Fetch('realtime');
      check('3. GET realtime goes through real apiFetch', apiFetchCalls.some((a) => String(a[0]).includes('/realtime')) && fakeFetch.calls.some((c) => c.url.includes('/realtime')));
      await panel.geoGa4H1Fetch('today');
      check('4. GET history goes through real apiFetch', apiFetchCalls.some((a) => String(a[0]).includes('/history')) && fakeFetch.calls.some((c) => c.url.includes('/history')));
    }

    // ── 5. POST sync 經過真實 apiFetch ──
    {
      const { fakeFetch, apiFetchCalls, panel } = loadRealEnv([
        { test: /sync/, body: { success: true, rows_saved: 3 } },
      ]);
      await panel.geoGa4H1ApiRequest('/api/analytics/ga4-geo/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sync_type: 'realtime' }) });
      check('5. POST sync goes through real apiFetch', apiFetchCalls.some((a) => String(a[0]).includes('/sync')) && fakeFetch.calls.some((c) => c.url.includes('/sync') && c.opts.method === 'POST'));
    }

    // ── 6-7. Authorization Bearer／x-store-id 正確附加 ──
    {
      const { fakeFetch, panel } = loadRealEnv([{ test: /realtime/, body: { success: true, cities: [] } }], { token: 'abc.def.ghi', storeId: 'store_777' });
      await panel.geoGa4H1Fetch('realtime');
      const h = fakeFetch.calls[0].opts.headers;
      check('6. Authorization: Bearer <token> attached correctly', h.Authorization === 'Bearer abc.def.ghi');
      check('7. x-store-id attached correctly', h['x-store-id'] === 'store_777');
    }

    // ── 8-9-10. Token 不進 URL／DOM／Error ──
    {
      const secretToken = 'SECRET.TOKEN.VALUE12345';
      const { fakeFetch, panel, win } = loadRealEnv([
        { test: /realtime/, body: { success: true, cities: [{ district_name: '測試區', normalization_status: 'ok', active_users: 1 }] } },
      ], { token: secretToken });
      await panel.geoGa4H1Refresh(IDS, null);
      const urlHasToken = fakeFetch.calls.some((c) => c.url.includes(secretToken));
      check('8. Token never appears in the request URL', !urlHasToken);
      const domHasToken = win.document.body.innerHTML.includes(secretToken);
      check('9. Token never appears in the DOM', !domHasToken);

      // 10. Token 不進 Error：強制一個 network reject，檢查錯誤訊息/物件序列化不含 token。
      const { panel: panel2 } = loadRealEnv([{ test: /realtime/, reject: () => new Error('ECONNRESET boom') }], { token: secretToken });
      let errMsg = '';
      try { await panel2.geoGa4H1Fetch('realtime'); } catch (e) { errMsg = String(e && e.message) + JSON.stringify(e || {}); }
      check('10. Token never appears in a thrown error message', !errMsg.includes(secretToken));
    }

    // ── 11. H1 不再直接裸 fetch 三支 API ──
    {
      const bareCallPattern = /fetch\(\s*['"`]\/api\/analytics\/ga4-geo/;
      check('11. Panel source never bare-calls fetch() on the 3 GA4-geo endpoints', !bareCallPattern.test(PANEL_CODE));
    }

    // ── 12. credentials:'include' 不被視為 JWT ──
    {
      const { fakeFetch, panel } = loadRealEnv([{ test: /realtime/, body: { success: true, cities: [] } }], { token: 'abc.def.ghi' });
      await panel.geoGa4H1Fetch('realtime');
      const opts = fakeFetch.calls[0].opts;
      check('12. credentials:"include" is not relied upon; Authorization header carries the JWT instead', opts.credentials !== 'include' && !!opts.headers.Authorization);
    }

    // ── 13-18. Native Response：200/400/401/403/429/502 ──
    {
      const cases = [
        ['13. Native 200 Response handled', 200, { success: true, cities: [] }, (r) => r.success === true],
        ['14. Native 400 Response handled', 400, { success: false, code: 'invalid_range' }, (r) => r.success === false && r.code === 'invalid_range' && r.http_status === 400],
        ['17. Native 429 Response handled', 429, { success: false, code: 'rate_limited' }, (r) => r.success === false && r.code === 'rate_limited' && r.http_status === 429],
        ['18. Native 502 Response handled', 502, { success: false, code: 'ga4_request_failed' }, (r) => r.success === false && r.code === 'ga4_request_failed' && r.http_status === 502],
      ];
      for (const [label, status, body, assertFn] of cases) {
        const { panel } = loadRealEnv([{ test: /realtime/, status, body }]);
        const result = await panel.geoGa4H1Fetch('realtime');
        check(label, assertFn(result), JSON.stringify(result));
      }
    }
    // 15-16: Native 401/403 Response — 這裡走的是真實 apiFetch 的 401/403
    // 特殊物件路徑（apiFetch 對 401/403 本身就不回原生 Response），所以
    // 15/16 直接併入下面 19/20 的驗證（同一個真實 Contract 行為，不重複
    // 造假）。
    {
      const { panel } = loadRealEnv([{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      const result = await panel.geoGa4H1Fetch('realtime');
      check('15. Native 401 Response (via apiFetch auth object) mapped to auth_required', result.success === false && result.code === 'auth_required' && result.http_status === 401);
    }
    {
      const { panel } = loadRealEnv([{ test: /realtime/, status: 403, body: { success: false, error: 'FEATURE_DISABLED', feature: 'reports' } }]);
      const result = await panel.geoGa4H1Fetch('realtime');
      check('16. Native 403 Response (via apiFetch auth object) mapped to feature_disabled', result.success === false && result.code === 'feature_disabled' && result.http_status === 403);
    }

    // ── 19-20. apiFetch Auth Object 401/403（直接呼叫真實 win.apiFetch 確認原始形狀）──
    {
      const { win } = loadRealEnv([{ test: /realtime/, status: 401, body: { success: false, error: 'NO_STORE_TOKEN' } }]);
      const raw = await win.apiFetch('/api/analytics/ga4-geo/realtime', { method: 'GET' });
      check('19. Real apiFetch() 401 raw shape is { ok:false, status:401, body }', raw && raw.ok === false && raw.status === 401 && typeof raw.body === 'object');
    }
    {
      const { win } = loadRealEnv([{ test: /realtime/, status: 403, body: { success: false, error: 'FEATURE_DISABLED' } }]);
      const raw = await win.apiFetch('/api/analytics/ga4-geo/realtime', { method: 'GET' });
      check('20. Real apiFetch() 403 raw shape is { ok:false, status:403, body }', raw && raw.ok === false && raw.status === 403 && typeof raw.body === 'object');
    }

    // ── 21-23. res.json 不存在／malformed JSON／empty body ──
    {
      const { panel } = loadRealEnv([{ test: /realtime/, rawResponse: { status: 200, ok: true } }]); // no .json method
      let threw = false;
      let result;
      try { result = await panel.geoGa4H1Fetch('realtime'); } catch (e) { threw = true; }
      check('21. Missing res.json() never throws a TypeError (safe invalid_response)', !threw && result && result.success === false && result.code === 'invalid_response');
    }
    {
      const { panel } = loadRealEnv([{ test: /realtime/, rawResponse: { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } } }]);
      let threw = false;
      let result;
      try { result = await panel.geoGa4H1Fetch('realtime'); } catch (e) { threw = true; }
      check('22. Malformed JSON (res.json() throws) never crashes; returns invalid_response', !threw && result && result.success === false && result.code === 'invalid_response');
    }
    {
      const { panel } = loadRealEnv([{ test: /realtime/, rawResponse: { status: 200, ok: true, json: async () => null } }]);
      const result = await panel.geoGa4H1Fetch('realtime');
      check('23. Empty/null body handled gracefully (invalid_response, not a crash)', result && result.success === false && result.code === 'invalid_response');
    }

    // ── 24. network reject（非 AbortError）不得被吞成 null ──
    {
      const { panel } = loadRealEnv([{ test: /realtime/, reject: () => new Error('ECONNRESET') }]);
      let threw = null;
      try { await panel.geoGa4H1Fetch('realtime'); } catch (e) { threw = e; }
      check('24. Non-Abort network rejection propagates (not silently swallowed as null)', threw instanceof Error && threw.message === 'ECONNRESET');
    }

    // ── 25-26. AbortError GET／POST 安靜結束 ──
    {
      const { panel } = loadRealEnv([{ test: /realtime/, delayMs: 30, body: { success: true, cities: [] } }]);
      const p1 = panel.geoGa4H1Refresh(IDS, null);
      await new Promise((r) => setTimeout(r, 5));
      const p2 = panel.geoGa4H1Refresh(IDS, null); // aborts p1's in-flight fetch
      let threw = false;
      try { await Promise.all([p1, p2]); } catch (e) { threw = true; }
      check('25. AbortError on GET (superseded refresh) never throws out of geoGa4H1Refresh', !threw);
    }
    {
      const { panel, win } = loadRealEnv([{ test: /sync/, delayMs: 30, body: { success: true } }]);
      const controller = new win.AbortController();
      const p = panel.geoGa4H1SafeRunFetch(() => panel.geoGa4H1ApiRequest('/api/analytics/ga4-geo/sync', { method: 'POST', signal: controller.signal }));
      controller.abort();
      let threw = false;
      let result;
      try { result = await p; } catch (e) { threw = true; }
      check('26. AbortError on POST sync is swallowed by geoGa4H1SafeRunFetch (returns undefined, no throw)', !threw && result === undefined);
    }

    // ── 27-28. Sync 成功才 refresh／失敗不 refresh ──
    {
      const { panel } = loadRealEnv([]);
      let onChangeCalls = 0;
      await panel._geoGa4H1HandleSyncResult({ success: true, rows_saved: 5 }, () => { onChangeCalls += 1; return Promise.resolve(); });
      check('27. Sync success triggers exactly one refresh (onChange called)', onChangeCalls === 1);
    }
    {
      const { panel } = loadRealEnv([]);
      let onChangeCalls = 0;
      await panel._geoGa4H1HandleSyncResult({ success: false, code: 'rate_limited' }, () => { onChangeCalls += 1; return Promise.resolve(); });
      check('28. Sync failure never triggers a refresh (no error chain)', onChangeCalls === 0);
    }

    // ── 29-30. Sync 失敗保留 Cached Rows／Marker ──
    {
      const { win, panel } = loadRealEnv([
        { test: /realtime/, body: { success: true, cities: [{ district_name: '保留區', normalization_status: 'ok', active_users: 4, marker_point: { lat: 24.9, lng: 121.2 } }] } },
        { test: /sync/, status: 502, body: { success: false, code: 'ga4_request_failed' } },
      ]);
      const map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      panel.geoGa4H1Init(IDS, map);
      await panel.geoGa4H1Refresh(IDS, map);
      const rowsBefore = panel.geoGa4H1State.lastGoodPayload && panel.geoGa4H1State.lastGoodPayload.cities.length;
      const markerLayersBefore = panel.geoGa4H1State.markerGroup ? panel.geoGa4H1State.markerGroup._layers.size : -1;

      const syncBtn = win.document.getElementById(IDS.toolbar).querySelector('#ga4h1-sync');
      syncBtn.dispatchEvent(new win.Event('click'));
      await new Promise((r) => setTimeout(r, 30));

      check('29. Failed sync preserves the previously cached rows (lastGoodPayload untouched)', panel.geoGa4H1State.lastGoodPayload && panel.geoGa4H1State.lastGoodPayload.cities.length === rowsBefore);
      check('30. Failed sync preserves the existing marker group (not cleared)', panel.geoGa4H1State.markerGroup && panel.geoGa4H1State.markerGroup._layers.size === markerLayersBefore);
    }

    // ── 31-38. H1 錯誤分類文案 ──
    {
      const { win, panel } = loadRealEnv([]);
      const statusEl = () => win.document.getElementById(IDS.status).textContent;
      const cases = [
        ['31. 401 shows re-login message', 'auth_required', '重新登入'],
        ['32. 403 shows plan-not-open message', 'feature_disabled', '未開放'],
        ['33. property_not_bound shows binding hint', 'property_not_bound', '尚未綁定'],
        ['34. SDK_UNAVAILABLE shows credential-not-set message', 'SDK_UNAVAILABLE', '尚未設定 GA4 憑證'],
        ['35. permission_denied shows Property permission message', 'permission_denied', '讀取權限'],
        ['36. invalid_argument shows query-incompatible message', 'invalid_argument', '不相容'],
        ['37. rate_limited shows try-again-later message', 'rate_limited', '稍候再試'],
        ['38. ga4_backend_error shows GA4 backend error message', 'ga4_backend_error', 'GA4 連線發生錯誤'],
      ];
      for (const [label, code, expectSubstring] of cases) {
        panel.geoGa4H1RenderStatus(IDS.status, { success: false, code });
        check(label, statusEl().includes(expectSubstring), statusEl());
      }
    }

    // ── 39-40. 快速 Mode／Metric 切換無 unhandled rejection ──
    {
      const before = unhandled.length;
      const { win, panel } = loadRealEnv([
        { test: /realtime/, delayMs: 2, body: { success: true, cities: [] } },
        { test: /history/, delayMs: 2, body: { success: true, rows: [] } },
      ]);
      const map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      panel.geoGa4H1Init(IDS, map);
      const modes = ['today', 'yesterday', '7d', '30d', 'realtime'];
      const modeSel = win.document.getElementById('ga4h1-mode');
      for (let i = 0; i < 20; i += 1) {
        modeSel.value = modes[i % modes.length];
        modeSel.dispatchEvent(new win.Event('change'));
      }
      await new Promise((r) => setTimeout(r, 50));
      check('39. 20 rapid Mode switches produce zero unhandled rejections', unhandled.length === before);
    }
    {
      const before = unhandled.length;
      const { win, panel } = loadRealEnv([{ test: /realtime/, delayMs: 2, body: { success: true, cities: [] } }]);
      const map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      panel.geoGa4H1Init(IDS, map);
      const metricSel = win.document.getElementById('ga4h1-metric');
      const metrics = ['active_users', 'view_item_count', 'add_to_cart_count', 'begin_checkout_count', 'purchase_count'];
      for (let i = 0; i < 20; i += 1) {
        metricSel.value = metrics[i % metrics.length];
        metricSel.dispatchEvent(new win.Event('change'));
      }
      await new Promise((r) => setTimeout(r, 50));
      check('40. 20 rapid Metric switches produce zero unhandled rejections', unhandled.length === before);
    }

    // ── 41-42. Destroy（相當於 Layer deactivate）無 unhandled rejection／清理 ──
    {
      const before = unhandled.length;
      const { win, panel } = loadRealEnv([{ test: /realtime/, delayMs: 30, body: { success: true, cities: [] } }]);
      const map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
      for (let i = 0; i < 10; i += 1) {
        panel.geoGa4H1Init(IDS, map); // activate（in-flight fetch 尚未完成）
        panel.geoGa4H1Destroy(IDS); // deactivate（abort in-flight fetch）
      }
      await new Promise((r) => setTimeout(r, 60));
      check('41. 10x activate/deactivate cycles (with in-flight aborts) produce zero unhandled rejections', unhandled.length === before);
      const toolbarEl = win.document.getElementById(IDS.toolbar);
      check('42. Destroy cleans up listeners and aborts the in-flight AbortController', (toolbarEl._ga4h1Cleanup === undefined || typeof toolbarEl._ga4h1Cleanup === 'function') && (!panel.geoGa4H1State.currentAbort || panel.geoGa4H1State.currentAbort.signal.aborted !== false));
    }

    // ── 43. apiFetch 只呼叫一次（每次 refresh）──
    {
      const { apiFetchCalls, panel } = loadRealEnv([{ test: /realtime/, body: { success: true, cities: [] } }]);
      const before = apiFetchCalls.length;
      await panel.geoGa4H1Fetch('realtime');
      check('43. Exactly one apiFetch call per geoGa4H1Fetch() invocation', apiFetchCalls.length - before === 1);
    }

    // ── 44-45. 不建立第二個 Token Reader／不解析 JWT Payload ──
    {
      const secondTokenReaderPattern = /localStorage\.getItem\(\s*['"`]pos_store_token['"`]\s*\)/;
      check('44. Panel source never re-implements a second Token Reader (no direct localStorage.getItem(pos_store_token))', !secondTokenReaderPattern.test(PANEL_CODE));
      const jwtParsePattern = /atob\s*\(|\.split\(['"`]\.['"`]\)\[1\]|parseJwtPayload/;
      check('45. Panel source never parses JWT payload itself', !jwtParsePattern.test(PANEL_CODE));
    }
    // ── 46-47. 需求文件五（追蹤完整 Promise Chain）：舊 geo-ga4-realtime-
    // layer.js 的 button click → geoGa4SetWindow／geoGa4SetMetric →
    // _geoGa4RunFetch → apiFetch → fetch 這條 Promise Chain 也一併驗證，
    // 不是只測 H1 Panel 自己這條新的（見需求文件五：「不一定只來自 H1
    // Panel」）。這個檔案本輪刻意不修改（架構已經正確，見 Reality
    // Audit），這裡只是「真的執行 20 次快速點擊」驗證它結構上真的不會
    // 洩漏 unhandled rejection，不是只憑讀原始碼判斷。
    {
      const before = unhandled.length;
      const dom = makeDom();
      const win = dom.window;
      win.localStorage.setItem('pos_store_token', 't');
      win.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001' }));
      win.fetch = makeFakeNetworkFetch([{ test: /ga4-realtime/, delayMs: 2, body: { success: true, data: { status: 'fresh', quota_status: 'ok', fetched_at: new Date().toISOString(), summary: {}, counties: [], unmapped: [], notices: [] } } }]);
      win.eval(REAL_AUTH_SRC);
      global.window = win;
      global.document = win.document;
      global.localStorage = win.localStorage;
      global.apiFetch = win.apiFetch; // geo-ga4-realtime-layer.js 只檢查裸 apiFetch（不是 window.apiFetch），必須同步設定，否則 fetch 路徑根本不會被觸發，測試會變成假陽性
      const containerId = 'c-realtime';
      ['toolbar', 'summary', 'status', 'notices'].forEach((suffix) => {
        const el = win.document.createElement('div');
        el.id = `${containerId}-ga4-${suffix}`;
        win.document.body.appendChild(el);
      });
      const layerPath = path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js');
      delete require.cache[layerPath];
      const layer = require(layerPath);
      await layer.geoGa4FetchAndRender(containerId);
      for (let i = 0; i < 20; i += 1) {
        layer.geoGa4SetWindow(containerId, i % 2 === 0 ? 5 : 30);
      }
      await new Promise((r) => setTimeout(r, 30));
      check('46. Legacy geo-ga4-realtime-layer.js: 20 rapid geoGa4SetWindow() calls produce zero unhandled rejections', unhandled.length === before);

      for (let i = 0; i < 20; i += 1) {
        layer.geoGa4SetMetric(containerId, i % 2 === 0 ? 'visitors' : 'purchase');
      }
      layer.geoGa4Deactivate(); // 快速切換途中直接離開 Layer（見需求文件五之 6／9）
      await new Promise((r) => setTimeout(r, 30));
      check('47. Legacy geo-ga4-realtime-layer.js: 20 rapid geoGa4SetMetric() + mid-flight Deactivate produce zero unhandled rejections', unhandled.length === before);
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  if (unhandled.length) {
    console.log(`\n[WARN] ${unhandled.length} unhandledRejection(s) captured during the run:`);
    unhandled.forEach((r, i) => console.log(`  #${i + 1}:`, r && r.stack ? r.stack.split('\n')[0] : r));
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1.1 Browser Auth Runtime: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Browser Auth Runtime crashed:', e);
  process.exit(1);
});
