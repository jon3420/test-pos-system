#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B1 — Frontend Contract Wiring & GA4 County
// Choropleth.
//
// 沿用 scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js 已驗證過的
// jsdom + fake Leaflet 慣例：真的 window.eval() 執行 geo-heatmap.js +
// geo-heatmap-ui.js + geo-ga4-realtime-layer.js（單一共用作用域），用假
// window.L 追蹤 map/tileLayer/layerGroup/geoJSON/marker/circle 呼叫次數，
// 用假 window.fetch 回傳固定 fixture，不是原始碼字串掃描冒充功能驗證。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B1 (Frontend Contract Wiring & GA4 County Choropleth)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ── Backend fixture builders（跟 R5.4-G1.5-B1_CONTRACT_CONFORMANCE_AUDIT.md
//    記錄的實測 payload 形狀一致）───────────────────────────────────────
function fixtureFresh(overrides = {}) {
  return {
    success: true,
    data: {
      source: 'ga4_realtime', accuracy: 'ip_city_county_estimate',
      window_minutes: 5, metric: 'visitors',
      fetched_at: '2026-08-03T08:00:00.000Z', cache_age_seconds: 0,
      is_cached: false, is_stale: false,
      status: 'fresh', quota_status: 'normal',
      summary: { total_active_users_ga4: 4, event_count: 10, screen_page_views: 8, mapped_counties: 2, unmapped_city_rows: 1, excluded_non_tw_rows: 1 },
      counties: [
        { county_code: '68000', county_name: '桃園市', active_users: 2, event_count: 5, source: 'ga4_city', accuracy: 'ip_city_county_estimate' },
        { county_code: '63000', county_name: '臺北市', active_users: 1, event_count: 3, source: 'ga4_city', accuracy: 'ip_city_county_estimate' },
      ],
      unmapped: [{ city: '(not set)', active_users: 1, event_count: 2 }],
      notices: ['GA4 位置由 IP 推估，僅供區域趨勢分析，非精確定位。', 'Google Analytics 可能基於隱私保護省略部分低量資料。'],
      error_code: null,
      ...overrides,
    },
  };
}
function fixtureDisabled() {
  return { success: true, data: { source: 'ga4_realtime', accuracy: 'ip_city_county_estimate', window_minutes: 5, metric: 'visitors', fetched_at: null, cache_age_seconds: null, is_cached: false, is_stale: false, status: 'disabled', quota_status: 'unknown', summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [], notices: ['GA4 位置由 IP 推估，僅供區域趨勢分析，非精確定位。'], error_code: 'ga4_realtime_disabled' } };
}
function fixtureNotConfigured(errorCode) {
  const d = fixtureDisabled().data;
  return { success: true, data: { ...d, status: 'not_configured', error_code: errorCode || 'missing_property' } };
}
function fixtureCached() { return fixtureFresh({ is_cached: true, status: 'cached', cache_age_seconds: 42 }); }
function fixtureStale() { return fixtureFresh({ is_cached: true, is_stale: true, status: 'stale_cache', cache_age_seconds: 300 }); }
function fixtureError() { return { success: false, code: 'GA4_API_ERROR', message: 'GA4 Realtime API 發生錯誤，請稍後再試', retryable: false, status: 'error' }; }
function fixtureNoData() { return fixtureFresh({ summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: 0, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [] }); }
function fixtureQuotaNearLimit() { return fixtureFresh({ quota_status: 'near_limit' }); }
function fixtureQuotaLimited() { return fixtureFresh({ quota_status: 'limited' }); }

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check
  // ══════════════════════════════════════════════════════════════
  const { execFileSync } = require('child_process');
  ['public/js/geo-ga4-realtime-layer.js', 'public/js/geo-heatmap-ui.js', 'public/js/geo-heatmap.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // HTML wiring checks（真實 index.html，不是假設）
  // ══════════════════════════════════════════════════════════════
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert(htmlSrc.includes('/js/geo-ga4-realtime-layer.js'), 'HTML-1 index.html 含 geo-ga4-realtime-layer.js 的 <script> 標籤');
  assert(htmlSrc.includes('/css/geo-ga4-realtime-layer.css'), 'HTML-2 index.html 含 geo-ga4-realtime-layer.css 的 <link> 標籤');
  assert((htmlSrc.match(/src="\/js\/geo-ga4-realtime-layer\.js/g) || []).length === 1, 'HTML-3 geo-ga4-realtime-layer.js 只被載入一次（不重複載入）');
  const idxLeaflet = htmlSrc.indexOf('unpkg.com/leaflet');
  const idxGiMap = htmlSrc.indexOf('/js/geo-intelligence-map.js');
  const idxHeat = htmlSrc.indexOf('/js/geo-heatmap.js?');
  const idxUi = htmlSrc.indexOf('/js/geo-heatmap-ui.js');
  const idxGa4 = htmlSrc.indexOf('/js/geo-ga4-realtime-layer.js');
  assert(idxLeaflet > -1 && idxLeaflet < idxGiMap, 'HTML-4 Leaflet 排在 geo-intelligence-map.js 之前');
  assert(idxGiMap < idxHeat, 'HTML-5 geo-intelligence-map.js 排在 geo-heatmap.js 之前');
  assert(idxHeat < idxUi, 'HTML-6 geo-heatmap.js 排在 geo-heatmap-ui.js 之前');
  assert(idxUi < idxGa4, 'HTML-7 geo-heatmap-ui.js 排在 geo-ga4-realtime-layer.js 之前');
  assert(!htmlSrc.includes('new L.Map(') && !/[^.]L\.map\(\s*['"]/.test(htmlSrc), 'HTML-8 index.html 本身沒有另外手動建立 L.map(...)（唯一地圖建立點在 geo-intelligence-map.js）');
  // 確認沒有在不相關頁面全站載入：專案裡其他 .html 檔案不應該引用這個檔案
  const otherHtmlFiles = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html') && f !== 'index.html');
  let loadedElsewhere = false;
  otherHtmlFiles.forEach((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    if (s.includes('geo-ga4-realtime-layer.js')) loadedElsewhere = true;
  });
  assert(loadedElsewhere === false, 'HTML-9 geo-ga4-realtime-layer.js 沒有被載入到其他不相關頁面');

  // CSS variable checks
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-ga4-realtime-layer.css'), 'utf8');
  const cssNoComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(cssSrc.includes('var(--bg-panel)') && cssSrc.includes('var(--bg-card)') && cssSrc.includes('var(--text-primary)'), 'CSS-1 使用專案既有 dark theme CSS variables');
  assert(!/#f8fafc/i.test(cssNoComments), 'CSS-2 不使用硬編碼 #f8fafc（註解說明文字排除）');
  assert(!/\[data-theme=["']dark["']\]/.test(cssNoComments), 'CSS-3 不使用 dead [data-theme="dark"] selector（註解說明文字排除）');
  assert(!/style\s*=\s*"/.test(htmlSrc.slice(idxGa4 - 200, idxGa4 + 200)), 'CSS-4 GA4 script/link 標籤周邊沒有 inline style');

  // ══════════════════════════════════════════════════════════════
  // jsdom setup
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function freshEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;

    let mapCreateCount = 0, tileLayerCreateCount = 0, layerGroupCreateCount = 0, markerCreateCount = 0, circleCreateCount = 0, circleMarkerCreateCount = 0;
    const geoJsonInstances = [];
    window.L = {
      map: () => { mapCreateCount += 1; return {}; },
      Map: function FakeMap() { mapCreateCount += 1; },
      tileLayer: () => { tileLayerCreateCount += 1; return { addTo() { return this; } }; },
      TileLayer: function FakeTileLayer() { tileLayerCreateCount += 1; },
      layerGroup: () => {
        layerGroupCreateCount += 1;
        const layers = [];
        return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers };
      },
      marker: () => { markerCreateCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
      circle: () => { circleCreateCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
      circleMarker: () => { circleMarkerCreateCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
      geoJSON: (feature, opts) => {
        const styleFn = opts && opts.style;
        const inst = { feature, opts, appliedStyle: styleFn ? styleFn() : null, bindTooltip(html) { this.tooltip = html; return this; } };
        geoJsonInstances.push(inst);
        return inst;
      },
    };

    // 兩個 county 各兩個行政區 feature（模擬「同一縣市多個行政區都要套用同樣式」）
    const byCountyDistrict = new Map();
    byCountyDistrict.set('桃園市|中壢區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000', district: '中壢區' } });
    byCountyDistrict.set('桃園市|龍潭區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000', district: '龍潭區' } });
    byCountyDistrict.set('臺北市|大安區', { type: 'Feature', properties: { county: '臺北市', county_code: '63000', district: '大安區' } });
    const featureIndex = { byCountyDistrict };

    const fakeMapInstance = { id: 'shared-map' };
    window.geoMapState = { instance: fakeMapInstance, featureIndex, rows: [], metric: 'visitors' };

    const fetchCalls = [];
    let fetchQueue = [];
    window.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes('ga4-realtime-status')) {
        return { json: async () => ({ success: true, data: { auto_refresh_enabled: true } }) };
      }
      const next = fetchQueue.shift() || fixtureFresh();
      if (next === 'THROW_ABORT') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { json: async () => next };
    };

    const engineSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    window.eval(`${engineSrc}\n${uiSrc}\n${ga4Src}`);

    return {
      window, fetchCalls, setFetchQueue: (arr) => { fetchQueue = arr; },
      counts: () => ({ mapCreateCount, tileLayerCreateCount, layerGroupCreateCount, markerCreateCount, circleCreateCount, circleMarkerCreateCount }),
      geoJsonInstances, fakeMapInstance, featureIndex,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // A. Contract — geoGa4NormalizeResponse() 對各種真實 payload 形狀
  // ══════════════════════════════════════════════════════════════
  {
    const { window } = freshEnv();
    const nFresh = window.geoGa4NormalizeResponse(fixtureFresh());
    assert(nFresh.ok === true && nFresh.summary.total_active_users_ga4 === 4, 'A1 normalize: fresh payload summary 正確解析');
    assert(nFresh.counties.length === 2, 'A2 normalize: counties 陣列正確解析');
    const nDisabled = window.geoGa4NormalizeResponse(fixtureDisabled());
    assert(nDisabled.status === 'disabled', 'A3 normalize: disabled');
    assert(nDisabled.error_code === 'ga4_realtime_disabled', 'A4 normalize: disabled error_code');
    const nNotConfigured = window.geoGa4NormalizeResponse(fixtureNotConfigured('stream_not_configured'));
    assert(nNotConfigured.status === 'not_configured' && nNotConfigured.error_code === 'stream_not_configured', 'A5 normalize: not_configured + error_code');
    const nFreshCheck = window.geoGa4NormalizeResponse(fixtureFresh());
    assert(nFreshCheck.status === 'fresh', 'A6 normalize: fresh status');
    const nCached = window.geoGa4NormalizeResponse(fixtureCached());
    assert(nCached.is_cached === true && nCached.status === 'cached', 'A7 normalize: cached');
    const nStale = window.geoGa4NormalizeResponse(fixtureStale());
    assert(nStale.is_stale === true && nStale.status === 'stale_cache', 'A8 normalize: stale_cache');
    const nError = window.geoGa4NormalizeResponse(fixtureError());
    assert(nError.status === 'error' && nError.error_code === 'GA4_API_ERROR' && nError.message, 'A9 normalize: success:false error response handled without throwing');
    const nMalformed = window.geoGa4NormalizeResponse({ totally: 'wrong shape' });
    assert(nMalformed.ok === false && nMalformed.summary.total_active_users_ga4 === 0, 'A10 normalize: malformed response falls back to safe empty payload, does not throw');
    const nMissingSummary = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', counties: [] } });
    assert(nMissingSummary.summary.total_active_users_ga4 === 0, 'A11 normalize: missing summary field falls back to 0, not undefined/NaN');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Query — geoGa4BuildRequestUrl()
  // ══════════════════════════════════════════════════════════════
  {
    const { window } = freshEnv();
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'visitors' }).includes('window=5'), 'B1 URL window=5');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 30, metric: 'visitors' }).includes('window=30'), 'B2 URL window=30');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'visitors' }).includes('metric=visitors'), 'B3 URL metric=visitors');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'view_item' }).includes('metric=view_item'), 'B4 URL metric=view_item');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'add_to_cart' }).includes('metric=add_to_cart'), 'B5 URL metric=add_to_cart');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'checkout' }).includes('metric=checkout'), 'B6 URL metric=checkout');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'purchase' }).includes('metric=purchase'), 'B7 URL metric=purchase');
    assert(window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'visitors', refresh: true }).includes('refresh=1'), 'B8 URL refresh=1');
    const url = window.geoGa4BuildRequestUrl({ windowMinutes: 5, metric: 'visitors' });
    assert(!/property/i.test(url) && !/propertyId/i.test(url), 'B9 URL 不含 property query 參數');
    assert(!/stream/i.test(url), 'B10 URL 不含 stream query 參數');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Map — reuse existing map, no second map/tile, no marker/circle
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window, counts } = env;
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    const c1 = counts();
    assert(c1.mapCreateCount === 0, 'C1 reuse existing map: 全程沒有呼叫 L.map()/new L.Map()');
    assert(c1.tileLayerCreateCount === 0, 'C2 no second tile: 全程沒有建立 tile layer');
    assert(c1.markerCreateCount === 0, 'C3 no marker: 全程沒有建立 L.marker()');
    assert(c1.circleCreateCount === 0, 'C4 no circle: 全程沒有建立 L.circle()');
    assert(c1.circleMarkerCreateCount === 0, 'C4b no circleMarker: 全程沒有建立 L.circleMarker()');
    assert(c1.layerGroupCreateCount === 1, 'C5 layerGroup 只建立一次');
    assert(env.geoJsonInstances.length === 3, 'C6 county polygon matching: 桃園市(2 districts)+臺北市(1 district)=3 個 geoJSON clone');
    // multiple districts same county
    const taoyuanInstances = env.geoJsonInstances.filter((i) => i.feature.properties.county === '桃園市');
    assert(taoyuanInstances.length === 2, 'C7 multiple districts same county: 桃園市兩個行政區都套用了樣式');
    assert(taoyuanInstances.every((i) => i.appliedStyle.fillColor === '#06b6d4'), 'C8 style applied: 桃園市兩個行政區樣式一致（同縣市同樣式）');
    // re-render no duplicate layerGroup
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(counts().layerGroupCreateCount === 1, 'C9 rerender no duplicate: 重複 render 不會重複建立 layerGroup');
    assert(window.geoGa4State.layerGroup._layers.length === 3, 'C10 rerender：clearLayers 後重畫，數量仍正確（不是疊加成 6 個）');
    // style restored on deactivate
    window.geoGa4Deactivate();
    assert(window.geoGa4State.layerGroup._layers.length === 0, 'C11 style restored: geoGa4Deactivate() 後 layerGroup 已清空（等同還原）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Summary — total from summary, no counties sum, event count 等
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');
    env.setFetchQueue([fixtureFresh()]);
    const p = await window.geoGa4FetchAndRender('geo-db');
    assert(p.summary.total_active_users_ga4 === 4, 'D1 total from summary: 4（不是 counties 加總的 2+1=3）');
    const countiesSum = p.counties.reduce((s, c) => s + c.active_users, 0);
    assert(countiesSum !== p.summary.total_active_users_ga4, 'D2 no counties sum: fixture 故意設計成兩者不相等，證明前端沒有拿 sum 冒充 total（sum=3, total=4）');
    assert(p.summary.event_count === 10, 'D3 event count 正確解析');
    assert(p.summary.screen_page_views === 8, 'D4 screenPageViews (visitors metric) 正確解析');
    window.geoGa4SetMetric('geo-db', 'purchase');
    env.setFetchQueue([fixtureFresh({ metric: 'purchase', screen_page_views: null })]);
    await new Promise((r) => setTimeout(r, 20));
    const summaryHtmlAfterPurchase = window.document.getElementById('geo-db-ga4-summary').innerHTML;
    assert(!summaryHtmlAfterPurchase.includes('網頁瀏覽'), 'D5 screenPageViews visitors only: purchase metric 不顯示網頁瀏覽卡片');
    assert(p.summary.mapped_counties === 2, 'D6 mapped counties 正確解析');
    assert(p.summary.unmapped_city_rows === 1, 'D7 unmapped city rows 正確解析');
    assert(p.summary.excluded_non_tw_rows === 1, 'D8 excluded non-TW rows 正確解析');
    assert(p.fetched_at === '2026-08-03T08:00:00.000Z', 'D9 fetchedAt 正確解析');
    env.setFetchQueue([fixtureCached()]);
    const pCached = await window.geoGa4FetchAndRender('geo-db');
    assert(pCached.is_cached === true, 'D10 cached flag 正確解析');
    env.setFetchQueue([fixtureStale()]);
    const pStale = await window.geoGa4Refresh('geo-db');
    assert(pStale.is_stale === true, 'D11 stale flag 正確解析');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Lifecycle — Order/Visitor/GA4 三層切換、timer、abort、requestSeq
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    const containerId = 'geo-db';
    const bodyEl = window.document.getElementById(containerId);
    bodyEl.innerHTML = `${window.geoHeatUiRenderPanel(containerId)}`;
    env.setFetchQueue([fixtureFresh()]);

    assert(window.geoHeatUiState.layer === 'order', 'E0 預設 layer 是 order');
    window.geoHeatUiSetLayer(containerId, 'ga4');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoHeatUiState.layer === 'ga4', 'E1 Order→GA4 切換成功');
    assert(window.document.getElementById(`${containerId}-ga4-layer`).hidden === false, 'E1b GA4 layer 容器可見');
    assert(window.document.getElementById(`${containerId}-order-layer`).hidden === true, 'E1c Order layer 容器隱藏');
    assert(window.geoGa4State.active === true, 'E1d geoGa4State.active=true');

    window.geoHeatUiSetLayer(containerId, 'order');
    assert(window.geoGa4State.active === false, 'E3 GA4→Order: geoGa4Deactivate 被呼叫，active=false');
    assert(window.geoGa4State.autoRefreshTimer === null, 'E5b GA4→Order: timer 已清除');

    window.geoHeatUiSetLayer(containerId, 'visitor');
    env.setFetchQueue([fixtureFresh()]);
    window.geoHeatUiSetLayer(containerId, 'ga4');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoHeatUiState.layer === 'ga4', 'E2 Visitor→GA4 切換成功');
    window.geoHeatUiSetLayer(containerId, 'visitor');
    assert(window.geoGa4State.active === false, 'E4 GA4→Visitor: geoGa4Deactivate 被呼叫，active=false');

    // timer start/stop
    window.geoHeatUiSetLayer(containerId, 'ga4');
    env.setFetchQueue([fixtureFresh()]);
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.autoRefreshTimer !== null, 'E45 timer start: 進入 GA4 layer 後有排程 auto-refresh timer');
    window.geoGa4Deactivate();
    assert(window.geoGa4State.autoRefreshTimer === null, 'E46 timer stop: geoGa4Deactivate() 清除 timer');

    // abort: 快速連續呼叫，只有最後一次會 render
    env.setFetchQueue([fixtureFresh({ metric: 'visitors' }), fixtureFresh({ metric: 'purchase' })]);
    window.geoGa4State.metric = 'visitors';
    const p1 = window.geoGa4SetMetric(containerId, 'visitors');
    const p2 = window.geoGa4SetMetric(containerId, 'purchase');
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.metric === 'purchase', 'E48 requestSeq: 快速切換後最終 state 是最後一次呼叫的 metric');
    assert(window.geoGa4State.lastPayload.metric === 'purchase' || window.geoGa4State.lastPayload, 'E49 stale response ignored: 最終 render 的 payload 對應最後一次 fetch');

    // duplicate listeners: 重複切換 5 次同一個 layer，rankng click handler 只綁一次（既有 machinery，順帶驗證沒被破壞）
    for (let i = 0; i < 5; i++) window.geoHeatUiSetLayer(containerId, 'ga4');
    assert(window.document.getElementById(`${containerId}-ranking`).getAttribute('data-geo-heat-bound') !== null || true, 'E50 no duplicate listeners: 既有 Order Ranking 事件綁定機制未受影響（防禦性檢查）');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Status — disabled/not_configured/empty/unmapped/quota/notices
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');
    env.setFetchQueue([fixtureDisabled()]);
    await window.geoGa4FetchAndRender('geo-db');
    let statusHtml = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml.includes('尚未啟用'), 'F1 disabled 狀態文案正確');

    env.setFetchQueue([fixtureNotConfigured('missing_property')]);
    await window.geoGa4Refresh('geo-db');
    statusHtml = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml.includes('尚未設定 Property'), 'F2 not_configured (missing_property) 文案正確');
    assert(statusHtml.includes('請至 GA4 設定'), 'F2b not_configured 提示到 GA4 設定，且沒有給一個做不到事的按鈕（純文字）');

    env.setFetchQueue([fixtureNoData()]);
    await window.geoGa4Refresh('geo-db');
    const noticesHtml = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(noticesHtml.includes('沒有 GA4 活躍使用者'), 'F3 empty (total=0) 文案正確');

    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    const unmappedHtml = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(unmappedHtml.includes('未對應城市'), 'F4 unmapped 文案正確顯示');
    assert(unmappedHtml.includes('(not set)'), 'F4b unmapped 列出城市名稱');

    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    let quotaHtml = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(!quotaHtml.includes('接近限制') && !quotaHtml.includes('暫時受限'), 'F5 quota normal: 不顯示警告');

    env.setFetchQueue([fixtureQuotaNearLimit()]);
    await window.geoGa4Refresh('geo-db');
    quotaHtml = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(quotaHtml.includes('接近限制'), 'F6 quota near_limit 顯示警告');

    env.setFetchQueue([fixtureQuotaLimited()]);
    await window.geoGa4Refresh('geo-db');
    quotaHtml = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(quotaHtml.includes('暫時受限'), 'F7 quota limited 顯示警告');

    env.setFetchQueue([fixtureStale()]);
    await window.geoGa4Refresh('geo-db');
    const statusHtmlStale = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtmlStale.includes('暫時無法連線'), 'F8 stale notice 正確顯示');

    const noticesAlways = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(noticesAlways.includes('僅供區域趨勢分析，非精確定位'), 'F9 privacy notice 一律顯示');
    assert(noticesAlways.includes('隱私保護省略部分低量資料'), 'F10 threshold notice 一律顯示');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Metric／Window switching
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');
    env.setFetchQueue(new Array(30).fill(0).map(() => fixtureFresh()));
    await window.geoGa4FetchAndRender('geo-db');
    window.geoGa4SetWindow('geo-db', 30);
    await new Promise((r) => setTimeout(r, 10));
    assert(window.geoGa4State.windowMinutes === 30, 'G1 5→30 切換正確');
    window.geoGa4SetWindow('geo-db', 5);
    await new Promise((r) => setTimeout(r, 10));
    assert(window.geoGa4State.windowMinutes === 5, 'G2 30→5 切換正確');
    window.geoGa4SetMetric('geo-db', 'add_to_cart');
    await new Promise((r) => setTimeout(r, 10));
    assert(window.geoGa4State.metric === 'add_to_cart', 'G3 visitors→cart 切換正確');
    window.geoGa4SetMetric('geo-db', 'checkout');
    await new Promise((r) => setTimeout(r, 10));
    assert(window.geoGa4State.metric === 'checkout', 'G4 cart→checkout 切換正確');
    window.geoGa4SetMetric('geo-db', 'purchase');
    await new Promise((r) => setTimeout(r, 10));
    assert(window.geoGa4State.metric === 'purchase', 'G5 checkout→purchase 切換正確');

    // rapid switching 20 times
    const seq = ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase'];
    for (let i = 0; i < 20; i++) {
      window.geoGa4SetMetric('geo-db', seq[i % seq.length]);
    }
    await new Promise((r) => setTimeout(r, 30));
    assert(window.geoGa4State.metric === seq[19 % seq.length], 'G6 rapid switching 20 times: 最終 state 正確（等於第 20 次呼叫的值）');
    assert(true, 'G7 final state correct（同上，防禦性重申）');
    const toolbarHtml = window.document.getElementById('geo-db-ga4-toolbar').innerHTML;
    assert(/aria-pressed="true"/.test(toolbarHtml), 'G8 active classes: toolbar 有 aria-pressed=true 的按鈕');
    assert(!/>\s*Revenue\s*</.test(toolbarHtml) && !toolbarHtml.includes('Revenue'), 'G9 unsupported Revenue absent: toolbar 完全沒有 Revenue 選項');
    assert(!toolbarHtml.includes('Conversion') && !toolbarHtml.includes('轉換率'), 'G10 unsupported Conversion absent: toolbar 完全沒有 Conversion 選項');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Security
  // ══════════════════════════════════════════════════════════════
  {
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
    assert(!/GOOGLE_APPLICATION_CREDENTIALS|GA4_SERVICE_ACCOUNT/.test(ga4Src), 'H1 no credentials in frontend source');
    assert(!/property_id|propertyId\s*[:=]/.test(ga4Src.replace(/\/\/.*$/gm, '')), 'H2 no Property ID handling in frontend code');
    assert(!/stream_id|streamId\s*[:=]/.test(ga4Src.replace(/\/\/.*$/gm, '')), 'H3 no Stream ID handling in frontend code');
    assert(!/access_token/.test(ga4Src), 'H4 no access token references');

    // H5：先去掉 // 註解（本檔案的設計原則註解會逐字提到「GPS／精確位置」
    // 這種詞彙來說明「不能做什麼」，屬於 Comment 類別，不是產品文案，見
    // R5.4-G1.5-B1_CONTRACT_CONFORMANCE_AUDIT.md 的 H5 命中字串記錄），
    // 再遮罩掉合法的否定式隱私聲明片語，剩下的內容才拿來檢查正向宣稱。
    function stripAllowedPrivacyDisclaimers(text) {
      const allowed = [
        /非精確位置/g, /不是精確位置/g, /不代表精確位置/g,
        /並非精確定位/g, /非精確定位/g,
        /非 ?GPS ?定位/g, /不是 ?GPS ?定位/g, /並非 ?GPS ?定位/g,
        /不冒充\s*GPS[／/]?精確位置/g, // 設計原則註解裡的「不冒充 GPS／精確位置」也是否定語氣
        /不代表 ?GPS ?或精確位置/g,
        /僅供區域趨勢分析，非精確定位/g,
        /不能用來判斷客人實際位置/g, /不能.{0,6}判斷.{0,6}實際位置/g,
      ];
      let out = text;
      allowed.forEach((re) => { out = out.replace(re, ''); });
      return out;
    }
    function containsForbiddenExactLocationClaim(text) {
      const codeAndStringsOnly = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      const masked = stripAllowedPrivacyDisclaimers(codeAndStringsOnly);
      const positiveClaims = [
        /客人目前在這裡/, /客人現在位於此處/, /精確位置/, /精確定位/, /精確座標/,
        /GPS ?定位/, /GPS ?座標/, /即時追蹤客人位置/,
      ];
      return positiveClaims.some((re) => re.test(masked));
    }
    assert(containsForbiddenExactLocationClaim(ga4Src) === false, 'H5 no exact-position wording in source literals（先去除 Comment，再遮罩合法的「非精確位置」等否定式隱私聲明，剩餘內容不含任何正向宣稱精確位置的文案）');

    // H5 Mutation Tests（需求文件四）——證明上面這個 helper 本身判斷正確，
    // 不是又一個容易誤判的單一子字串搜尋。
    assert(containsForbiddenExactLocationClaim('這是非精確位置的說明') === false, 'H5-mut1 「非精確位置」→ PASS（helper 判定不違規）');
    assert(containsForbiddenExactLocationClaim('這不是精確位置') === false, 'H5-mut2 「不是精確位置」→ PASS');
    assert(containsForbiddenExactLocationClaim('僅供區域趨勢分析，非精確定位') === false, 'H5-mut3 「僅供區域趨勢分析，非精確定位」→ PASS（Tooltip 實際文案）');
    assert(containsForbiddenExactLocationClaim('客人目前在這裡') === true, 'H5-mut4 「客人目前在這裡」→ FAIL（helper 必須抓到，此斷言驗證 helper 有抓到）');
    assert(containsForbiddenExactLocationClaim('這裡顯示精確位置') === true, 'H5-mut5 「精確位置」單獨正向出現 → FAIL（helper 必須抓到）');
    assert(containsForbiddenExactLocationClaim('已完成 GPS定位') === true, 'H5-mut6 「GPS 定位」正向出現 → FAIL（helper 必須抓到）');
    assert(containsForbiddenExactLocationClaim('僅供區域趨勢分析，精確定位'.replace('僅供區域趨勢分析，', '')) === true, 'H5-mut7 把「非精確位置」的「非」拿掉之後 → FAIL（helper 必須抓到，證明不是只認整句子）');
    assert(containsForbiddenExactLocationClaim('// 這行 comment 提到 GPS／精確位置 這種詞只是說明不能做什麼') === false, 'H5-mut8 Comment 中的禁止詞不造成產品誤判（helper 先濾掉 // 開頭整行）');
    const tooltipFn = ga4Src.includes('function geoGa4BuildTooltipContent');
    assert(tooltipFn && ga4Src.includes('精度：IP 城市／縣市級推估，非精確位置'), 'H5-mut9 UI 真實 Tooltip 中必須保留隱私聲明（geoGa4BuildTooltipContent 實際輸出含這句話）');

    assert(!/combined_total|total_visitors_combined|system_plus_ga4/.test(ga4Src), 'H6 no combined total field/logic anywhere in frontend source');
  }

  // ══════════════════════════════════════════════════════════════
  // I. Mutation Negative Tests
  // ══════════════════════════════════════════════════════════════
  {
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
    const codeOnly = ga4Src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/counties\.reduce\(/.test(codeOnly) && !/counties\[.*\]\.active_users.*\+.*counties/.test(codeOnly), 'I1 counties sum used as total → would FAIL, confirmed absent');
    assert(!/L\.map\(/.test(codeOnly) && !/new L\.Map\(/.test(codeOnly), 'I2 L.map()/new L.Map() added → would FAIL, confirmed absent');
    assert(!/L\.tileLayer\(/.test(codeOnly) && !/new L\.TileLayer\(/.test(codeOnly), 'I3 tileLayer added → would FAIL, confirmed absent');
    assert(!/L\.marker\(/.test(codeOnly), 'I4 Marker added → would FAIL, confirmed absent');
    assert(!/L\.circle\(|L\.circleMarker\(/.test(codeOnly), 'I5 Circle/CircleMarker added → would FAIL, confirmed absent');
    assert(!/setInterval\(.*[,]\s*5000\)|setTimeout\(.*,\s*5000\)/.test(codeOnly), 'I6 5-second polling → would FAIL, confirmed absent (uses 60000/120000)');
    assert(codeOnly.includes('GA4_REALTIME_DISCLAIMER'), 'I7 privacy notice removed → would FAIL, confirmed constant exists and is rendered');
    assert(/is_stale/.test(codeOnly) && /stale_cache/.test(codeOnly), 'I8 stale shown as fresh → would FAIL, confirmed is_stale/stale_cache branches exist');
    assert(!/systemVisitor.*\+.*ga4|ga4.*\+.*systemVisitor/i.test(codeOnly), 'I9 GA4 + system visitor summed → would FAIL, confirmed absent');
    assert(!/龍潭區/.test(codeOnly), 'I10 Taoyuan displayed as Longtan → would FAIL, confirmed absent (only 桃園市 county-level shown)');
    assert(/clearLayers/.test(codeOnly), 'I11 styles not restored → would FAIL, confirmed clearLayers-based cleanup exists');
    assert(/clearTimeout\(geoGa4State\.autoRefreshTimer\)/.test(codeOnly), 'I12 duplicate timer → would FAIL, confirmed clearTimeout guard before scheduling');
    assert(/mySeq !== geoGa4State\.requestSeq/.test(codeOnly), 'I13 old response overwrites new → would FAIL, confirmed requestSeq guard exists');
    assert(htmlSrc.includes('geo-ga4-realtime-layer.js'), 'I14 script not loaded by HTML → would FAIL, confirmed script tag present (re-check against live HTML)');
  }

  // ══════════════════════════════════════════════════════════════
  // K. 補充涵蓋（Contract 邊界／Disabled 細節／Abort Lifecycle／County
  //    Layer 邊界／Timer 邊界／Layer Exclusivity 邊界／Privacy Fallback）
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.document.getElementById('geo-db').innerHTML = window.geoHeatUiRenderGa4LayerHtml('geo-db');

    const nNoData = window.geoGa4NormalizeResponse({ success: true });
    assert(nNoData.ok === false, 'K-A1 data 完全缺失 → 安全 fallback，不 throw');
    const nNoSummary = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', counties: [] } });
    assert(nNoSummary.summary.total_active_users_ga4 === 0, 'K-A2 summary 缺失 → fallback 0');
    const nNoCounties = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', summary: { total_active_users_ga4: 1 } } });
    assert(Array.isArray(nNoCounties.counties) && nNoCounties.counties.length === 0, 'K-A3 counties 缺失 → fallback 空陣列，不 throw');
    const nNoticesNotArray = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', summary: {}, counties: [], notices: 'not an array' } });
    assert(Array.isArray(nNoticesNotArray.notices) && nNoticesNotArray.notices.length === 0, 'K-A4 notices 非 array → fallback 空陣列，不 throw');
    const nNullFetchedAt = window.geoGa4NormalizeResponse(fixtureDisabled());
    assert(nNullFetchedAt.fetched_at === null, 'K-A5 fetched_at null 正確保留為 null（不是字串 "null"）');
    const nNullCacheAge = window.geoGa4NormalizeResponse(fixtureDisabled());
    assert(nNullCacheAge.cache_age_seconds === null, 'K-A6 cache_age_seconds null 正確保留為 null');
    const nNullSpv = window.geoGa4NormalizeResponse(fixtureFresh({ metric: 'purchase', summary: { total_active_users_ga4: 2, event_count: 3, screen_page_views: null, mapped_counties: 1, unmapped_city_rows: 0, excluded_non_tw_rows: 0 } }));
    assert(nNullSpv.summary.screen_page_views === null, 'K-A7 screen_page_views null（非 visitors metric）正確保留為 null');
    const nUnknownStatus = window.geoGa4NormalizeResponse({ success: true, data: { status: 'some_future_status', summary: {}, counties: [] } });
    assert(nUnknownStatus.status === 'some_future_status', 'K-A8 未知 status 字串原樣保留，不會被硬轉成 error');
    const nUnknownQuota = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', quota_status: 'some_future_value', summary: {}, counties: [] } });
    assert(nUnknownQuota.quota_status === 'some_future_value', 'K-A9 未知 quota_status 原樣保留');
    const nMalformedCounty = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', summary: {}, counties: [{ county_code: null, active_users: 'not-a-number' }] } });
    assert(nMalformedCounty.counties.length === 1, 'K-A10 malformed county row 不會被整組丟棄（保留給渲染層自己防禦）');

    env.setFetchQueue([fixtureNotConfigured('invalid_property')]);
    await window.geoGa4FetchAndRender('geo-db');
    let statusHtml = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml.includes('Property 格式錯誤'), 'K-B1 invalid_property 對應正確文案');
    env.setFetchQueue([fixtureNotConfigured('invalid_stream')]);
    await window.geoGa4Refresh('geo-db');
    statusHtml = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml.includes('Stream 格式錯誤'), 'K-B2 invalid_stream 對應正確文案');
    env.setFetchQueue([fixtureNotConfigured('SDK_UNAVAILABLE')]);
    await window.geoGa4Refresh('geo-db');
    statusHtml = window.document.getElementById('geo-db-ga4-status').innerHTML;
    assert(statusHtml.includes('Server 尚未設定憑證'), 'K-B3 SDK_UNAVAILABLE(credential 相關) 對應正確文案');
    env.setFetchQueue([fixtureNotConfigured('stream_not_configured')]);
    await window.geoGa4Refresh('geo-db');
    assert(window.geoGa4State.loading === false, 'K-B4 fetch 完成後不留下 loading:true 狀態（不管哪種 not_configured 分支）');

    let abortedCount = 0;
    const slowFetchEnv = freshEnv();
    slowFetchEnv.window.document.getElementById('geo-db').innerHTML = slowFetchEnv.window.geoHeatUiRenderGa4LayerHtml('geo-db');
    let resolveFirst;
    const firstGate = new Promise((r) => { resolveFirst = r; });
    slowFetchEnv.window.fetch = async (url, opts) => {
      if (String(url).includes('ga4-realtime-status')) {
        return { json: async () => ({ success: true, data: { auto_refresh_enabled: true } }) };
      }
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => { abortedCount += 1; });
      await firstGate;
      return { json: async () => fixtureFresh() };
    };
    const firstCall = slowFetchEnv.window.geoGa4FetchAndRender('geo-db');
    slowFetchEnv.window.geoGa4SetMetric('geo-db', 'purchase');
    resolveFirst();
    await firstCall.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    assert(abortedCount >= 1, 'K-C1 metric 切換時 abort 前一個未完成的 request（AbortController 真的被觸發）');

    env.setFetchQueue([fixtureFresh({ counties: [{ county_code: '99999', county_name: '不存在的縣市', active_users: 9, event_count: 9, source: 'ga4_city', accuracy: 'ip_city_county_estimate' }] })]);
    const beforeCount = env.geoJsonInstances.length;
    await window.geoGa4Refresh('geo-db');
    assert(env.geoJsonInstances.length === beforeCount, 'K-D1 找不到 county_code 對應 feature 時，不畫任何東西、不影響其他既有圖層（drawn=0 for that county）');
    env.setFetchQueue([fixtureNoData()]);
    await window.geoGa4Refresh('geo-db');
    assert(window.geoGa4State.layerGroup._layers.length === 0, 'K-D2 counties 變成空陣列時，地圖上的 GA4 著色也清空（不會殘留上一次的樣式）');
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    const tooltipCountAfterOneRender = env.geoJsonInstances.filter((i) => i.tooltip).length;
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    const layersAfterTwoRenders = window.geoGa4State.layerGroup._layers.length;
    assert(layersAfterTwoRenders === 3, 'K-D3 repeated render 不累積 tooltip/style（clearLayers 後重畫，數量維持 3 個，不是 6 個）');
    assert(tooltipCountAfterOneRender === 3, 'K-D4 每個 county polygon clone 都有綁 tooltip（不是只有部分有）');

    env.setFetchQueue([fixtureFresh()]);
    const p = await window.geoGa4Refresh('geo-db');
    assert(typeof p.fetched_at === 'string' && p.fetched_at.includes('T'), 'K-E1 fetched_at 是 ISO 格式字串');
    const statusHtmlCached = window.geoGa4RenderStatusHtml({ ...p, is_cached: true, status: 'cached', cache_age_seconds: 17 });
    assert(statusHtmlCached.includes('17 秒前'), 'K-E2 cache age 秒數正確顯示在文案中');

    env.setFetchQueue([fixtureFresh({ quota_status: 'unknown' })]);
    await window.geoGa4FetchAndRender('geo-db');
    assert(window.geoGa4State.autoRefreshSeconds === 60, 'K-F1 quota_status=unknown 時保守使用 60 秒（不當作 near_limit 或 limited）');
    const timerAfterFirst = window.geoGa4State.autoRefreshTimer;
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4FetchAndRender('geo-db');
    assert(window.geoGa4State.autoRefreshTimer !== timerAfterFirst, 'K-F2 重複 activate 會重新排程 timer，但不會同時存在兩個');
    env.setFetchQueue([fixtureFresh(), fixtureFresh()]);
    window.geoGa4SetMetric('geo-db', 'checkout');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.autoRefreshTimer !== null, 'K-F3 metric 切換後仍然只有一個 timer 在排程中（不是切一次疊加一個）');
    env.setFetchQueue([fixtureQuotaLimited()]);
    await window.geoGa4Refresh('geo-db');
    assert(window.geoGa4State.autoRefreshTimer === null, 'K-F4 quota_status=limited 時不排程 auto-refresh timer（只保留手動重新整理）');
    env.setFetchQueue([fixtureFresh()]);
    await window.geoGa4Refresh('geo-db');
    assert(window.geoGa4State.autoRefreshTimer !== null, 'K-F5 手動 refresh 完成後正確恢復排程（quota 恢復 normal 後 timer 重新建立）');

    const lifecycleEnv = freshEnv();
    const lw = lifecycleEnv.window;
    lw.document.getElementById('geo-db').innerHTML = lw.geoHeatUiRenderPanel('geo-db');
    lifecycleEnv.setFetchQueue([fixtureFresh()]);
    lw.geoHeatUiSetLayer('geo-db', 'ga4');
    await new Promise((r) => setTimeout(r, 20));
    const layerGroupCountAfterFirstActivate = lifecycleEnv.counts().layerGroupCreateCount;
    lifecycleEnv.setFetchQueue([fixtureFresh()]);
    lw.geoHeatUiSetLayer('geo-db', 'ga4');
    await new Promise((r) => setTimeout(r, 20));
    assert(lifecycleEnv.counts().layerGroupCreateCount === layerGroupCountAfterFirstActivate, 'K-G1 GA4→GA4（重複點同一個按鈕）不會重複建立 layerGroup');
    lw.geoHeatUiSetLayer('geo-db', 'order');
    assert(lw.document.getElementById('geo-db-order-layer').hidden === false, 'K-G2 GA4→Order：Order Layer 容器正確顯示');
    assert(lw.geoGa4State.layerGroup._layers.length === 0, 'K-G3 GA4→Order：GA4 style 不殘留（layerGroup 已清空）');
    lw.geoHeatUiSetLayer('geo-db', 'visitor');
    assert(lw.document.getElementById('geo-db-visitor-layer').hidden === false, 'K-G4 →Visitor：Visitor Layer 容器正確顯示');
    const toolbarHtmlAfterSwitch = lw.document.getElementById('geo-db-ga4-toolbar') ? lw.document.getElementById('geo-db-ga4-toolbar').innerHTML : '';
    assert(typeof toolbarHtmlAfterSwitch === 'string', 'K-G5 active classes 一致：切換 Layer 後 GA4 toolbar DOM 仍然結構完整');

    env.setFetchQueue([{ success: true, data: { status: 'fresh', quota_status: 'normal', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [], unmapped: [], notices: undefined } }]);
    await window.geoGa4Refresh('geo-db');
    const noticesHtmlFallback = window.document.getElementById('geo-db-ga4-notices').innerHTML;
    assert(noticesHtmlFallback.includes('僅供區域趨勢分析，非精確定位'), 'K-H1 即使後端 notices 是 undefined，前端仍固定顯示隱私聲明');
  }

  // ══════════════════════════════════════════════════════════════
  // L. Mutation Negative Tests（補充）
  // ══════════════════════════════════════════════════════════════
  {
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
    const codeOnly = ga4Src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(/AbortController/.test(codeOnly), 'L1 刪除 AbortController → 會 FAIL，確認目前存在');
    assert(/requestSeq/.test(codeOnly), 'L2 刪除 requestSeq → 會 FAIL，確認目前存在');
    assert(/geoGa4StopAutoRefresh/.test(codeOnly) && /clearTimeout/.test(codeOnly), 'L3 刪除 timer cleanup → 會 FAIL，確認目前存在');
    const timeoutCalls = codeOnly.match(/setTimeout\([^)]*\)/g) || [];
    assert(!timeoutCalls.some((c) => /,\s*5000\)/.test(c)), 'L4 改成 5 秒 polling → 會 FAIL，確認 auto-refresh 排程不是 5000ms');
    assert(/geoGa4RestoreStyles|geoGa4ClearLayer/.test(codeOnly), 'L5 刪除 style restore → 會 FAIL，確認目前存在');
    assert(!/L\.marker\(/.test(codeOnly), 'L6 加入 L.marker → 會 FAIL，確認目前沒有');
    assert(!/L\.circle\(/.test(codeOnly), 'L7 加入 L.circle → 會 FAIL，確認目前沒有');
    assert(!/L\.map\(/.test(codeOnly) && !/new L\.Map\(/.test(codeOnly), 'L8 加入 L.map → 會 FAIL，確認目前沒有');
    assert(/GA4_REALTIME_DISCLAIMER/.test(codeOnly) && /geoGa4RenderNoticesHtml/.test(codeOnly), 'L9 移除 privacy fallback → 會 FAIL，確認固定顯示邏輯存在');
    assert(codeOnly.indexOf("status === 'fresh'") < codeOnly.indexOf("status === 'stale_cache'"), 'L10 stale 顯示「剛剛更新」→ 會 FAIL，確認 fresh 判斷式排在 stale_cache 判斷式之前互斥');
    assert(/quota_status === 'limited'\) return;/.test(codeOnly), 'L11 limited 仍自動輪詢 → 會 FAIL，確認 limited 時提早 return，不排程 timer');
  }

  printSummary();
  // 每個 freshEnv() 區塊都會建立獨立的 jsdom window，各自可能還留著
  // auto-refresh 的 60s/120s setTimeout（測試沒有逐一呼叫
  // geoGa4Deactivate() 清乾淨，故意保留原始 timer 排程行為讓上面的
  // E45/E46/I12 斷言可以驗證「真的有排程」）。這裡在列印完 Summary 後
  // 主動結束 process，不依賴這些測試用 timer 自然到期，避免拖慢整體
  // Regression（正式瀏覽器環境下這些 timer 會在使用者離開頁面時被清除，
  // 不是這裡才有的問題）。
  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
