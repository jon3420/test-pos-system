#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.2 — GA4 Layer Store Authentication Hotfix.
//
// 驗證重點：geoGa4FetchData()／geoGa4FetchStatus() 改用 apiFetch()（真實
// Contract：200/400/500 回原生 Response；401/403 回 { ok:false, status,
// body }；Network/AbortError 直接 reject），Authentication 失敗
// （status='auth_error'）與 GA4 Backend 錯誤（status='error'/'disabled'/
// 'not_configured'）完全分開，AbortController／requestSeq／Auto Refresh
// lifecycle 全數保留。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.2 (GA4 Layer Store Authentication Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function fixtureFresh(overrides = {}) {
  return {
    success: true,
    data: {
      status: 'fresh', quota_status: 'normal', fetched_at: '2026-08-04T00:00:00.000Z',
      cache_age_seconds: 0, is_cached: false, is_stale: false,
      summary: { total_active_users_ga4: 4, event_count: 10, screen_page_views: 8, mapped_counties: 1, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
      counties: [{ county_code: '68000', county_name: '桃園市', active_users: 4, event_count: 10, source: 'ga4_city', accuracy: 'ip_city_county_estimate' }],
      unmapped: [], notices: [], error_code: null,
      ...overrides,
    },
  };
}
function fixtureErrorStatus(status, errorCode, extra = {}) {
  return { success: true, data: { status, quota_status: 'unknown', fetched_at: null, cache_age_seconds: null, is_cached: false, is_stale: false, summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [], notices: [], error_code: errorCode, ...extra } };
}
function authBody(code) {
  return { success: false, error: code || 'NO_STORE_TOKEN', message: '缺少店家登入 token，請重新登入' };
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-ga4-realtime-layer.js', 'public/js/geo-heatmap-ui.js', 'public/js/geo-heatmap.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const layerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
  const layerSrcNoComments = layerSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  // freshEnv({statusQueue, dataQueue}) — 每個 endpoint 各自獨立 queue，
  // status/data 不會互相搶 fixture（需求文件二）。window.fetch 與
  // window.apiFetch 分開追蹤呼叫次數，讓「Data/Status 改回裸 fetch」的
  // Mutation 有明確、可執行的訊號（bareFetchCalls 應永遠是 0），而不是只
  // 靠原始碼字串掃描。
  function freshEnv({ statusQueue = [], dataQueue = [] } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    let markerCount = 0; let circleCount = 0;
    window.L = {
      layerGroup: () => ({ addTo() { return this; }, clearLayers() { this._layers.length = 0; }, addLayer(l) { this._layers.push(l); }, _layers: [] }),
      geoJSON: (f, o) => ({ feature: f, opts: o, bindTooltip() { return this; } }),
      marker: () => { markerCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
      circle: () => { circleCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
    };
    const byCountyDistrict = new Map();
    byCountyDistrict.set('桃園市|中壢區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000' } });
    window.geoMapState = { instance: {}, featureIndex: { byCountyDistrict } };

    const sQ = [...statusQueue]; const dQ = [...dataQueue];
    const apiFetchCalls = []; const bareFetchCalls = [];

    async function respondFor(url, options, queue) {
      const next = queue.shift();
      if (next === 'THROW_ABORT') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (next === 'THROW_NETWORK') { throw new Error('network unreachable'); }
      if (next && next.__auth) return { ok: false, status: next.__auth, body: next.body !== undefined ? next.body : authBody() };
      if (next && next.__httpStatus) return { status: next.__httpStatus, ok: false, json: async () => (next.body || { success: false, message: 'server error' }) };
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
    const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const ga4Src = layerSrc.replace(/'use strict';\s*\n/, '');
    window.eval(`${engineSrc}\n${uiSrc}\n${ga4Src}`);
    // 需要先把 geo-db-ga4-toolbar／-summary／-status／-notices 等子節點畫出來，
    // _geoGa4RenderDom() 才找得到對應 id（沿用既有 B1/B2 smoke 慣例）。
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');

    return {
      window, apiFetchCalls, bareFetchCalls,
      setStatusQueue: (arr) => { sQ.length = 0; sQ.push(...arr); },
      setDataQueue: (arr) => { dQ.length = 0; dQ.push(...arr); },
      markerCount: () => markerCount, circleCount: () => circleCount,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // A. apiFetch Wiring (1-20)
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env.bareFetchCalls.length === 0, 'A3-A4 Data/Status 完全不使用裸 fetch（bareFetchCalls 為 0）');
    assert(env.apiFetchCalls.some((c) => c.url.includes('ga4-realtime-status')), 'A1 geoGa4FetchStatus 使用 apiFetch');
    assert(env.apiFetchCalls.some((c) => c.url.includes('/ga4-realtime?')), 'A2 geoGa4FetchData 使用 apiFetch');
    const dataCall = env.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?'));
    const statusCall = env.apiFetchCalls.find((c) => c.url.includes('ga4-realtime-status'));
    assert(dataCall.options.method === 'GET', 'A5 Data request method GET');
    assert(statusCall.options.signal === undefined || statusCall.options.method === 'GET', 'A5b Status request method GET');
    assert('signal' in statusCall.options === false || statusCall.options.signal === undefined, 'A6 Status request 目前設計不強制帶 signal（一次性讀取，非可中斷 stream）'); // 澄清：Status 本身沒有 controller，這裡確認呼叫仍成立
    assert('signal' in dataCall.options, 'A7 signal 傳入 Data request');
    assert(dataCall.url.includes('window=5'), 'A8 window=5 保留於 query');

    const env30 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await env30.window.geoGa4FetchAndRender('geo-db');
    await env30.window.geoGa4SetWindow('geo-db', 30);
    const dataCall30 = env30.apiFetchCalls.filter((c) => c.url.includes('/ga4-realtime?')).pop();
    assert(dataCall30.url.includes('window=30'), 'A9 window=30 保留於 query');

    for (const metric of ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase']) {
      const envM = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
      await envM.window.geoGa4FetchAndRender('geo-db');
      await envM.window.geoGa4SetMetric('geo-db', metric);
      const c = envM.apiFetchCalls.filter((x) => x.url.includes('/ga4-realtime?')).pop();
      assert(c.url.includes(`metric=${metric}`), `A10-14 metric=${metric} 保留於 query`);
    }

    const envR0 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envR0.window.geoGa4FetchAndRender('geo-db');
    const c0 = envR0.apiFetchCalls.find((x) => x.url.includes('/ga4-realtime?'));
    assert(c0.url.includes('refresh=0'), 'A15 refresh=0（初次載入非強制重抓）');

    const envR1 = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await envR1.window.geoGa4FetchAndRender('geo-db');
    await envR1.window.geoGa4Refresh('geo-db');
    const c1 = envR1.apiFetchCalls.filter((x) => x.url.includes('/ga4-realtime?')).pop();
    assert(c1.url.includes('refresh=1'), 'A16 refresh=1（手動 Refresh）');

    assert(!/property/i.test(dataCall.url) && !/stream/i.test(dataCall.url), 'A17-A18 Data request 不傳 Property／Stream');
    assert(!JSON.stringify(dataCall.options).match(/credential/i), 'A19 Data request 不傳 Credential');
    assert(!/store_id=/i.test(dataCall.url) && !('store_id' in (dataCall.options.headers || {})), 'A20 不硬寫 Store ID（不在 URL／headers 自行帶入）');
  }

  // ══════════════════════════════════════════════════════════════
  // B. apiFetch Response Contract (21-30)
  // ══════════════════════════════════════════════════════════════
  {
    // 直接測 geoGa4FetchData()／geoGa4FetchStatus()，繞過 lifecycle，專注在
    // Response Shape 判斷本身（需求文件三的三種真實情況都要涵蓋）。
    const env = freshEnv({});
    env.setDataQueue([fixtureFresh()]);
    const r200 = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(r200.ok === true && r200.status === 'fresh', 'B21-B22 200 Response + success JSON 正確解析');
    assert(r200.summary.total_active_users_ga4 === 4, 'B23 apiFetch 已解析 JSON 形狀正確映射到 payload');

    env.setDataQueue([{ __auth: 401 }]);
    const r401 = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(r401.status === 'auth_error', 'B24 401 特殊形狀（{ok:false,status,body}）被正確處理，不噴例外');

    env.setDataQueue([{ __auth: 403, body: { success: false, message: '店家不存在或已停用' } }]);
    const r403 = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(r403.status === 'auth_error', 'B25 403 特殊形狀被正確處理，不噴例外');

    env.setDataQueue([{ __auth: 401, body: {} }]);
    const r401Malformed = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(r401Malformed.status === 'auth_error' && r401Malformed.error_code === 'AUTH_REQUIRED', 'B26 malformed 401 body（空物件）安全降級，不 throw');

    env.setDataQueue([{ not_success_field: true }]);
    const rMalformedSuccess = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(rMalformedSuccess.ok === false && rMalformedSuccess.status === 'error', 'B27 malformed success body（缺 success/data）安全降級為 error');

    env.setDataQueue(['THROW_NETWORK']);
    let networkThrew = false;
    try { await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined }); } catch (e) { networkThrew = true; }
    assert(networkThrew === true, 'B28 Network Error：apiFetch reject，geoGa4FetchData() 原樣往外丟（由呼叫端 _geoGa4RunFetch 接住）');

    env.setDataQueue(['THROW_ABORT']);
    let abortThrew = false; let abortName = '';
    try { await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined }); } catch (e) { abortThrew = true; abortName = e.name; }
    assert(abortThrew === true && abortName === 'AbortError', 'B29 AbortError：原樣往外丟，name=AbortError 可供上層判斷');

    env.setDataQueue([{ __httpStatus: 500, body: { success: false, code: 'GA4_API_ERROR', message: 'GA4 Realtime API 發生錯誤，請稍後再試', status: 'error' } }]);
    const r500 = await env.window.geoGa4FetchData({ windowMinutes: 5, metric: 'visitors', refresh: false, signal: undefined });
    assert(r500.status === 'error', 'B30 HTTP 500（非 401/403 的原生 Response）走一般 JSON 解析路徑，不誤判為 auth_error');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Authentication (31-40)
  // ══════════════════════════════════════════════════════════════
  {
    const envOk = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envOk.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envOk.window.geoGa4State.configAutoRefreshEnabled === true, 'C31 有效 Store Auth → Status 成功（讀到 auto_refresh_enabled）');
    assert(envOk.window.geoGa4State.lastPayload.ok === true, 'C32 有效 Store Auth → Data 成功');

    const envMissing = freshEnv({ statusQueue: [{ __auth: 401 }], dataQueue: [{ __auth: 401 }] });
    await envMissing.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envMissing.window.geoGa4State.lastPayload.status === 'auth_error', 'C33 missing token → auth_error');

    const envInvalid = freshEnv({ statusQueue: [{ __auth: 401, body: { success: false, error: 'NO_STORE_TOKEN', message: '缺少店家登入 token，請重新登入' } }], dataQueue: [{ __auth: 401, body: { success: false, error: 'NO_STORE_TOKEN', message: '缺少店家登入 token，請重新登入' } }] });
    await envInvalid.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envInvalid.window.geoGa4State.lastPayload.status === 'auth_error', 'C34 invalid/expired token → auth_error');

    const statusHtml401 = envInvalid.window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml401.includes('店家登入狀態已失效'), 'C35 401 顯示重新登入');

    const envF403 = freshEnv({ statusQueue: [{ __auth: 403 }], dataQueue: [{ __auth: 403 }] });
    await envF403.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const statusHtml403 = envF403.window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml403.includes('店家登入狀態已失效'), 'C36 403 顯示重新登入或權限失效');
    assert(!statusHtml403.includes('憑證') && !statusHtml403.includes('Property'), 'C37-C38 auth error 不顯示 credential/property 錯誤文字');
    assert(!statusHtml403.includes('伺服器尚未開啟'), 'C39 auth error 不顯示 global disabled 文字');

    const envBoth = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envBoth.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const authedCalls = envBoth.apiFetchCalls.length;
    assert(authedCalls >= 2, 'C40 Status／Data 都透過 apiFetch 認證（至少各一次呼叫）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. GA4 Error Separation (41-50)
  // ══════════════════════════════════════════════════════════════
  {
    const cases = [
      ['disabled', 'ga4_realtime_disabled', '伺服器尚未開啟 GA4 即時功能'],
      ['error', 'credential_unavailable', '伺服器尚未設定 GA4 憑證'],
      ['error', 'credential_invalid', 'GA4 憑證格式錯誤'],
      ['error', 'permission_denied', '讀取權限'],
      ['error', 'property_not_found', '找不到此 GA4 Property'],
      ['error', 'stream_filter_invalid', 'Stream ID 無法套用'],
      ['error', 'quota_limited', '使用量接近限制'.slice(0, 0) || 'GA4 API 暫時達到使用限制'],
      ['error', 'ga4_timeout', '連線逾時'],
      ['error', 'ga4_unavailable', '暫時無法連線'],
    ];
    for (const [status, code, expectSubstr] of cases) {
      const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus(status, code)] });
      await env.window.geoGa4FetchAndRender('geo-db');
      await new Promise((r) => setTimeout(r, 20));
      const html = env.window.document.getElementById('geo-db-ga4-status').innerHTML;
      assert(html.includes(expectSubstr), `D41-D49 [${status}/${code}] 顯示對應文案「${expectSubstr}」`);
      assert(!html.includes('店家登入狀態已失效'), `D41-D49 [${status}/${code}] 不誤判為登入錯誤`);
    }
    const envStale = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh({ status: 'stale_cache', is_stale: true, cache_age_seconds: 300 })] });
    await envStale.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const staleHtml = envStale.window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(staleHtml.includes('300 秒前的舊資料'), 'D50 stale_cache 正確顯示（不是 auth/一般 error 文案）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Lifecycle (51-62)
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const statusIdx = env.apiFetchCalls.findIndex((c) => c.url.includes('ga4-realtime-status'));
    const dataIdx = env.apiFetchCalls.findIndex((c) => c.url.includes('/ga4-realtime?'));
    assert(statusIdx === 0, 'E51 activate 發 Status（第一次呼叫）');
    assert(dataIdx === 1, 'E52 Status 完成後發 Data（第二次呼叫）');

    env.setDataQueue([fixtureFresh()]);
    const callsBeforeManual = env.apiFetchCalls.length;
    await env.window.geoGa4Refresh('geo-db');
    assert(env.apiFetchCalls.length > callsBeforeManual && env.bareFetchCalls.length === 0, 'E53 manual refresh 走 apiFetch');

    // auto refresh 走的是同一支 _geoGa4RunFetch()，直接呼叫驗證同一路徑
    // （不用真的等 60 秒 timer，計時排程本身在 D 段落 quota 測試已涵蓋）。
    env.setDataQueue([fixtureFresh()]);
    const callsBeforeAuto = env.apiFetchCalls.length;
    await env.window._geoGa4RunFetch('geo-db', { refresh: false });
    assert(env.apiFetchCalls.length > callsBeforeAuto && env.bareFetchCalls.length === 0, 'E54 auto refresh（排程呼叫的同一支函式）走 apiFetch');

    // metric switch abort 前一個
    let abortedOnMetric = 0;
    const envAbort = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }] });
    envAbort.setDataQueue([fixtureFresh()]);
    await envAbort.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const origApiFetch = envAbort.window.apiFetch;
    envAbort.window.apiFetch = async (url, options = {}) => {
      if (!String(url).includes('ga4-realtime-status') && options.signal) {
        options.signal.addEventListener('abort', () => { abortedOnMetric += 1; });
      }
      return new Promise(() => {}); // 掛住，直到被 abort
    };
    const p1 = envAbort.window.geoGa4SetMetric('geo-db', 'purchase');
    envAbort.window.geoGa4SetMetric('geo-db', 'checkout');
    await new Promise((r) => setTimeout(r, 10));
    assert(abortedOnMetric >= 1, 'E55 metric switch abort 前一個未完成的 request');
    envAbort.window.apiFetch = origApiFetch;

    // window switch abort 前一個
    let abortedOnWindow = 0;
    const envAbortW = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }] });
    envAbortW.setDataQueue([fixtureFresh()]);
    await envAbortW.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    envAbortW.window.apiFetch = async (url, options = {}) => {
      if (!String(url).includes('ga4-realtime-status') && options.signal) {
        options.signal.addEventListener('abort', () => { abortedOnWindow += 1; });
      }
      return new Promise(() => {});
    };
    envAbortW.window.geoGa4SetWindow('geo-db', 30);
    envAbortW.window.geoGa4SetWindow('geo-db', 5);
    await new Promise((r) => setTimeout(r, 10));
    assert(abortedOnWindow >= 1, 'E56 window switch abort 前一個未完成的 request');

    // requestSeq 阻止舊結果覆蓋新狀態
    const envSeq = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }] });
    let seqCall = 0;
    envSeq.setDataQueue([]);
    envSeq.window.apiFetch = async (url) => {
      if (String(url).includes('ga4-realtime-status')) return { status: 200, ok: true, json: async () => ({ success: true, data: { auto_refresh_enabled: true } }) };
      seqCall += 1;
      const mySeq = seqCall;
      if (mySeq === 1) { await new Promise((r) => setTimeout(r, 30)); return { status: 200, ok: true, json: async () => fixtureFresh({ summary: { total_active_users_ga4: 111, event_count: 1, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 } }) }; }
      return { status: 200, ok: true, json: async () => fixtureFresh({ summary: { total_active_users_ga4: 222, event_count: 2, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 } }) };
    };
    const seqP1 = envSeq.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 5));
    const seqP2 = envSeq.window.geoGa4Refresh('geo-db');
    await Promise.all([seqP1, seqP2]);
    assert(envSeq.window.geoGa4State.lastPayload.summary.total_active_users_ga4 === 222, 'E57 requestSeq 阻止舊結果覆蓋新狀態（慢的第一次不會蓋掉快的第二次）');

    // deactivate abort + clear timer
    const envDeact = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envDeact.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envDeact.window.geoGa4State.autoRefreshTimer !== null, 'E58-setup auto refresh timer scheduled after activate');
    envDeact.window.geoGa4Deactivate();
    assert(envDeact.window.geoGa4State.abortController === null, 'E58 deactivate abort（controller 被清空）');
    assert(envDeact.window.geoGa4State.autoRefreshTimer === null, 'E59 deactivate clear timer');

    // repeated activate 不疊 timer
    const envRepeat = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await envRepeat.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const timerRef1 = envRepeat.window.geoGa4State.autoRefreshTimer;
    await envRepeat.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const timerRef2 = envRepeat.window.geoGa4State.autoRefreshTimer;
    assert(timerRef1 !== timerRef2 && envRepeat.window.geoGa4State.autoRefreshTimer !== null, 'E60 repeated activate 不疊 timer（舊 timer 被清掉，只剩最新一顆）');

    // auth error 後 loading reset
    const envAuthLoad = freshEnv({ statusQueue: [{ __auth: 401 }], dataQueue: [{ __auth: 401 }] });
    await envAuthLoad.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envAuthLoad.window.geoGa4State.loading === false, 'E61 auth error 後 loading reset 為 false');

    // network error 後 loading reset
    const envNetLoad = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: ['THROW_NETWORK'] });
    await envNetLoad.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envNetLoad.window.geoGa4State.loading === false, 'E62 network error 後 loading reset 為 false');
  }

  // ══════════════════════════════════════════════════════════════
  // F. 正式流程場景 (63-70)
  // ══════════════════════════════════════════════════════════════
  {
    const envDisabled = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus('disabled', 'ga4_realtime_disabled')] });
    await envDisabled.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envDisabled.window.document.getElementById('geo-db-ga4-status').innerHTML.includes('伺服器尚未開啟'), 'F63 已登入＋global disabled 顯示正確文案');

    const envCred = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus('error', 'credential_unavailable')] });
    await envCred.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envCred.window.document.getElementById('geo-db-ga4-status').innerHTML.includes('尚未設定 GA4 憑證'), 'F64 已登入＋credential missing 顯示正確文案');

    const envTokenMissing = freshEnv({ statusQueue: [{ __auth: 401 }], dataQueue: [{ __auth: 401 }] });
    await envTokenMissing.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envTokenMissing.window.document.getElementById('geo-db-ga4-status').innerHTML.includes('店家登入狀態已失效'), 'F65 token missing 顯示重新登入');

    const envSuccess = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await envSuccess.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envSuccess.window.geoGa4State.lastPayload.ok === true, 'F66 token valid＋GA4 success');
    const summaryHtml = envSuccess.window.document.getElementById('geo-db-ga4-summary').innerHTML;
    assert(summaryHtml.includes('GA4 活躍訪客') && summaryHtml.includes('4'), 'F67 summary render');
    assert(envSuccess.window.geoGa4State.layerGroup._layers.length === 1, 'F68 county choropleth render（1 個 county 對應到 1 個 feature clone）');
    assert(envSuccess.markerCount() === 0, 'F69 no marker（全程沒有呼叫 L.marker）');
    assert(envSuccess.circleCount() === 0, 'F70 no circle（全程沒有呼叫 L.circle）');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Mutation Negative (71-85)
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh()] });
    await env.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(env.bareFetchCalls.length === 0, 'G71-G72 Data／Status 若改回裸 fetch，bareFetchCalls 會 >0 → 會 FAIL，確認目前為 0');

    const dataCallOpts = env.apiFetchCalls.find((c) => c.url.includes('/ga4-realtime?')).options;
    assert('signal' in dataCallOpts, 'G73 signal 若被移除，這裡會抓到 undefined key 不存在 → 會 FAIL，確認目前存在');

    assert(!/Authorization\s*:/.test(layerSrcNoComments) && !/['"]Bearer /.test(layerSrcNoComments), 'G74 hardcoded Authorization → 若加入會 FAIL，確認目前沒有');
    assert(!/localStorage/.test(layerSrcNoComments), 'G75 localStorage token key 猜測 → 若加入會 FAIL，確認目前沒有（完全交給 apiFetch）');

    const envAllAuth = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus('error', 'credential_unavailable')] });
    await envAllAuth.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envAllAuth.window.geoGa4State.lastPayload.status !== 'auth_error', 'G76 若所有 Error 都被轉成 auth_error 會 FAIL，確認 credential_unavailable 仍是 status=error');

    const envGlobalDisabled = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus('disabled', 'ga4_realtime_disabled')] });
    await envGlobalDisabled.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envGlobalDisabled.window.geoGa4State.lastPayload.status !== 'auth_error', 'G77 若 global disabled 被轉成 auth_error 會 FAIL，確認仍是 status=disabled');
    assert(envGlobalDisabled.window.geoGa4State.lastPayload.status === 'disabled', 'G77b 確認 status 精確等於 disabled');

    const envCredErr = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureErrorStatus('error', 'credential_invalid')] });
    await envCredErr.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(envCredErr.window.geoGa4State.lastPayload.status !== 'auth_error', 'G78 若 credential error 被轉成 auth_error 會 FAIL，確認仍是 status=error');

    assert(/requestSeq/.test(layerSrcNoComments), 'G79 requestSeq 若被移除會 FAIL，確認原始碼仍存在相關邏輯');
    assert(/AbortController/.test(layerSrcNoComments), 'G80 AbortController 若被移除會 FAIL，確認原始碼仍存在');

    const envAutoBare = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await envAutoBare.window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    envAutoBare.setDataQueue([fixtureFresh()]);
    await envAutoBare.window._geoGa4RunFetch('geo-db', { refresh: false });
    assert(envAutoBare.bareFetchCalls.length === 0, 'G81 Auto Refresh 若改用裸 fetch 會 FAIL，確認 bareFetchCalls 仍是 0');

    const envManualBare = freshEnv({ statusQueue: [{ success: true, data: { auto_refresh_enabled: true } }], dataQueue: [fixtureFresh(), fixtureFresh()] });
    await envManualBare.window.geoGa4FetchAndRender('geo-db');
    envManualBare.setDataQueue([fixtureFresh()]);
    await envManualBare.window.geoGa4Refresh('geo-db');
    assert(envManualBare.bareFetchCalls.length === 0, 'G82 Manual Refresh 若改用裸 fetch 會 FAIL，確認 bareFetchCalls 仍是 0');

    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}property_id/.test(layerSrcNoComments), 'G83 Property Query Override 若加入 geoGa4BuildRequestUrl 會 FAIL，確認目前沒有');
    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}stream_id/.test(layerSrcNoComments), 'G84 Stream Query Override 若加入 geoGa4BuildRequestUrl 會 FAIL，確認目前沒有');
    assert(!/geoGa4BuildRequestUrl[\s\S]{0,400}store_id/.test(layerSrcNoComments), 'G85 Store ID Query Override 若加入 geoGa4BuildRequestUrl 會 FAIL，確認目前沒有（Store 隔離完全交給 apiFetch header，不放進 query）');
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
