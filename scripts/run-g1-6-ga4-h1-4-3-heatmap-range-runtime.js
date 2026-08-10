#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-3-heatmap-range-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full
//
// Manual QA 問題 1（Heatmap 歷史查詢切換 Range，Table 看起來沒有跟著換）
// 的 Runtime 證明。真實 jsdom + 真實 public/js/geo-ga4-h1-panel.js（不是
// 重寫一份邏輯來測試自己），Fake fetch 依 URL 的 range/start_date/end_date
// 回傳「可一眼辨識屬於哪個 range」的 fixture 資料（需求文件三十三）：
//
//   today：中壢=1，平鎮=2        yesterday：中壢=3
//   7d：中壢=7，平鎮=5，桃園=4   30d：中壢=30
//   90d：板橋=90                180d：蘆竹=180
//   this_year：龜山=200          last_year：楊梅=300
//   single：新屋=1                custom：龍潭=99
//
// 每個 range 都驗三層（需求文件三十四）：Map Marker／Table Row／Status，
// 而不是只 assert button.active（需求文件三十五）。另外驗 Race（三十六）、
// Empty Range（三十七）、Cross-Range Stale Fallback 不得洩漏（H1.4.3 Root
// Cause 修正）、Search／Sort 只作用於目前 range 的 rows（需求文件五十八）。

'use strict';

const { JSDOM } = require('jsdom');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

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
}
class FakeMap {
  constructor() { this._layerGroups = new Set(); }
  hasLayer(layer) { return this._layerGroups.has(layer); }
  addLayer(layer) { this._layerGroups.add(layer); return this; }
  removeLayer(layer) { this._layerGroups.delete(layer); return this; }
}
function makeFakeLeaflet() {
  return { layerGroup: () => new FakeLayerGroup(), marker: (ll, o) => new FakeMarker(ll, o), divIcon: (o) => ({ __divIcon: true, ...o }) };
}

function makeFakeFetch(routeFn) {
  const calls = [];
  const fn = async function fakeFetch(url, opts = {}) {
    calls.push({ url, opts });
    const route = routeFn(url);
    const delayMs = (route && route.delayMs) || 0;
    const signal = opts.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
      const t = setTimeout(resolve, delayMs);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    if (!route) return { status: 404, ok: false, json: async () => ({ success: false, code: 'not_found' }) };
    const status = typeof route.status === 'number' ? route.status : 200;
    return { status, ok: status < 400, json: async () => (typeof route.body === 'function' ? route.body(url) : route.body) };
  };
  fn.calls = calls;
  return fn;
}
function makeFakeApiFetch(fetchFn) {
  return async function fakeApiFetch(url, options = {}) {
    const res = await fetchFn(url, options);
    if (res.status === 401) return { ok: false, status: 401, body: await res.json().catch(() => ({})) };
    if (res.status === 403) return { ok: false, status: 403, body: await res.json().catch(() => ({})) };
    return res;
  };
}
function setFakeApi(routeFn) {
  const fetchFn = makeFakeFetch(routeFn);
  global.fetch = fetchFn;
  global.apiFetch = makeFakeApiFetch(fetchFn);
  return fetchFn;
}
function freshPanelModule(dom) {
  const rangeResolverPath = require.resolve('../public/js/geo-range-resolver.js');
  const rangeControlPath = require.resolve('../public/js/geo-range-control.js');
  const panelPath = require.resolve('../public/js/geo-ga4-h1-panel.js');
  delete require.cache[rangeResolverPath];
  delete require.cache[rangeControlPath];
  delete require.cache[panelPath];
  global.window = dom.window;
  global.document = dom.window.document;
  global.L = makeFakeLeaflet();
  global.showToast = () => {};
  global.resolveGeoHistoricalRange = require(rangeResolverPath).resolveGeoHistoricalRange;
  global.GeoRangeControl = require(rangeControlPath).geoRangeControlMount ? { mount: require(rangeControlPath).geoRangeControlMount } : undefined;
  dom.window.resolveGeoHistoricalRange = global.resolveGeoHistoricalRange;
  dom.window.GeoRangeControl = global.GeoRangeControl;
  dom.window.showToast = global.showToast;
  return require(panelPath);
}
function makeDom() {
  return new JSDOM('<div id="c-tb"></div><div id="c-status"></div><div id="c-table"></div>');
}

// ── Fixture：可一眼辨識屬於哪個 range 的 rows（需求文件三十三）──
const FIXTURE_ROWS = {
  today: [row('中壢區', 1), row('平鎮區', 2)],
  yesterday: [row('中壢區', 3)],
  '7d': [row('中壢區', 7), row('平鎮區', 5), row('桃園區', 4)],
  '30d': [row('中壢區', 30)],
  '90d': [row('板橋區', 90)],
  '180d': [row('蘆竹區', 180)],
  this_year: [row('龜山區', 200)],
  last_year: [row('楊梅區', 300)],
  single: [row('新屋區', 1)],
  custom: [row('龍潭區', 99)],
};
function row(district, activeUsers) {
  return {
    district_name: district, county_name: '桃園市', normalization_status: 'ok', administrative_level: 'district',
    active_users: activeUsers, new_users: 0, sessions: activeUsers,
    marker_point: { lat: 24.9 + Math.random() * 0.01, lng: 121.2 + Math.random() * 0.01 },
    last_seen_at_utc: '2026-08-10 00:00:00',
  };
}

// _historyRouteFor(fixtureKey) — 依 URL 的 range/start_date/end_date 判斷
// 這次請求「實際 identity」對到哪一組 fixture；不是只憑 range= 這個字面值
// （single/90d/180d/this_year/last_year/custom 全部共用 apiRange='custom'，
// 必須連 start_date/end_date 一起比對才分得出彼此，這正是 Backend
// getRangeGeoStats() Exact-Match 的同一種 identity 判斷）。
function buildFixtureRoute(fixtureKey, opts = {}) {
  return {
    delayMs: opts.delayMs || 0,
    body: () => ({ success: true, rows: FIXTURE_ROWS[fixtureKey], last_sync_at_utc: '2026-08-10 08:00:00' }),
  };
}

async function main() {
  const IDS = { toolbar: 'c-tb', status: 'c-status', table: 'c-table' };

  // ══════════════════════════════════════════════════════════════
  // Part A — 10 種 Range 逐一驗三層（Map／Table／Status）
  // ══════════════════════════════════════════════════════════════
  for (const mode of ['today', 'yesterday', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'single', 'custom']) {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    const requestedUrls = [];
    setFakeApi((url) => {
      requestedUrls.push(url);
      if (/\/history/.test(url)) return buildFixtureRoute(mode);
      return { body: { success: true, cities: [] } };
    });
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    panel.geoGa4H1State.rangeState = mode === 'single'
      ? { mode: 'single', singleDate: '2026-08-05', startDate: '', endDate: '' }
      : mode === 'custom'
        ? { mode: 'custom', singleDate: '', startDate: '2026-07-01', endDate: '2026-07-10' }
        : { mode, singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map);

    const expectedRows = FIXTURE_ROWS[mode];
    const tableText = dom.window.document.getElementById(IDS.table).textContent;
    const allDistrictsInTable = expectedRows.every((r) => tableText.includes(r.district_name));
    assert(allDistrictsInTable, `A-${mode}-1. Table 顯示這個 range 專屬的行政區（不是別的 range 的資料）`, tableText);

    const markerCount = map._layerGroups.size ? Array.from(map._layerGroups)[0]._layers.size : 0;
    assert(markerCount === expectedRows.length, `A-${mode}-2. Map Marker 數量與這個 range 的 fixture rows 數一致`, `got ${markerCount} want ${expectedRows.length}`);

    const statusText = dom.window.document.getElementById(IDS.status).textContent;
    assert(!statusText.includes('過期') && !statusText.includes('暫時無法'), `A-${mode}-3. Status 顯示正常成功狀態（不是 stale/error 文案）`, statusText);

    // 需求文件三十五：不能只驗 button/state，這裡連 API 實際打出去的
    // identity（URL 上的 range/start_date/end_date）也一併驗。
    const historyUrl = requestedUrls.find((u) => /\/history/.test(u));
    assert(!!historyUrl, `A-${mode}-4. 確實對 /history 發出真正的 API request（不是只切 UI state 沒有 reload）`);
    if (mode === '7d' || mode === '30d' || mode === 'today' || mode === 'yesterday') {
      assert(historyUrl.includes(`range=${mode}`), `A-${mode}-5. 既有 preset 維持原 apiRange 值`, historyUrl);
    } else {
      assert(historyUrl.includes('range=custom') && historyUrl.includes('start_date=') && historyUrl.includes('end_date='), `A-${mode}-5. 新 preset 走 apiRange=custom + 實際 start/end`, historyUrl);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Part B — Race：7d slow, 30d fast，最終畫面必須是 30d，7d 不得覆蓋
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi((url) => {
      if (/range=7d/.test(url)) return buildFixtureRoute('7d', { delayMs: 60 });
      if (/range=30d/.test(url)) return buildFixtureRoute('30d', { delayMs: 5 });
      return { body: { success: true, cities: [] } };
    });
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    panel.geoGa4H1State.rangeState = { mode: '7d', singleDate: '', startDate: '', endDate: '' };
    const slow7d = panel.geoGa4H1Refresh(IDS, map); // 不 await：故意讓它在飛行中
    await new Promise((r) => setTimeout(r, 5));
    panel.geoGa4H1State.rangeState = { mode: '30d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map);
    await slow7d.catch(() => {}); // 等 7d 那個慢請求真正落地（若有殘留副作用會在這裡發生）

    const tableText = dom.window.document.getElementById(IDS.table).textContent;
    const zhongliMatch = tableText.match(/中壢區\s*([\d.]+)/);
    assert(!!zhongliMatch && zhongliMatch[1] === '30', 'B1. Table 最終停留在 30d（中壢活躍使用者=30），慢的 7d（=7）沒有覆蓋回去', tableText);
    const markerCount = Array.from(map._layerGroups)[0]._layers.size;
    assert(markerCount === FIXTURE_ROWS['30d'].length, 'B2. Map Marker 數量也停留在 30d', String(markerCount));
  }

  // ══════════════════════════════════════════════════════════════
  // Part C — Empty Range：90d 沒有 persisted result → 全部清空，不得保留舊 7d
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi((url) => {
      if (/range=7d/.test(url)) return buildFixtureRoute('7d');
      if (/range=custom/.test(url)) return { body: { success: true, rows: [] } }; // 90d 尚無資料
      return { body: { success: true, cities: [] } };
    });
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    panel.geoGa4H1State.rangeState = { mode: '7d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map);
    assert(dom.window.document.getElementById(IDS.table).textContent.includes('中壢區'), 'C1. 7d 先正確顯示資料（作為對照）');

    panel.geoGa4H1State.rangeState = { mode: '90d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map);
    const tableText = dom.window.document.getElementById(IDS.table).textContent;
    assert(!tableText.includes('中壢區') && tableText.includes('目前沒有資料'), 'C2. 90d 沒有資料時 Table 顯示空狀態，不是殘留 7d 的中壢區', tableText);
    const markerCount = Array.from(map._layerGroups)[0]._layers.size;
    assert(markerCount === 0, 'C3. 90d 沒有資料時 Map Marker 清空為 0（不是殘留 7d 的 marker）', String(markerCount));
  }

  // ══════════════════════════════════════════════════════════════
  // Part D — H1.4.3 修正核心：網路錯誤時的 stale fallback 只能重播「同一個
  // range identity」上一次成功的資料，不得把別的 range 的舊資料誤當這個
  // range 的合法快取繼續顯示（見 public/js/geo-ga4-h1-panel.js
  // _geoGa4H1FetchRangeKey()／geoGa4H1Refresh()）。
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    let failNext30d = false;
    setFakeApi((url) => {
      if (/range=7d/.test(url)) return buildFixtureRoute('7d');
      if (/range=30d/.test(url)) {
        if (failNext30d) return { status: 500, ok: false, body: { success: false, code: 'ga4_backend_error' } };
        return buildFixtureRoute('30d');
      }
      return { body: { success: true, cities: [] } };
    });
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    panel.geoGa4H1State.rangeState = { mode: '7d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map); // lastGoodPayload 現在是 7d 的資料

    failNext30d = true;
    panel.geoGa4H1State.rangeState = { mode: '30d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map); // 30d 這次請求失敗，且 lastGoodPayload 是 7d（不同 identity）
    const tableTextAfterFail = dom.window.document.getElementById(IDS.table).textContent;
    assert(!tableTextAfterFail.includes('中壢區'), 'D1. 30d 請求失敗時，不得把 7d 的中壢區資料誤當 30d 的合法快取繼續顯示', tableTextAfterFail);
    const statusAfterFail = dom.window.document.getElementById(IDS.status).textContent;
    assert(!statusAfterFail.includes('中壢') , 'D2. Status 也不得暗示 30d 有資料', statusAfterFail);

    // Sanity：同一個 range 重複請求失敗時，"同 identity" 的 stale fallback 仍應正常運作。
    failNext30d = false;
    await panel.geoGa4H1Refresh(IDS, map); // 30d 成功一次，寫入 lastGoodPayload=30d
    failNext30d = true;
    await panel.geoGa4H1Refresh(IDS, map); // 再次對「同一個 30d」失敗 → 應該 fallback 回上一次 30d 的資料（stale）
    const tableTextSameRangeStale = dom.window.document.getElementById(IDS.table).textContent;
    const zhongliStaleMatch = tableTextSameRangeStale.match(/中壢區\s*([\d.]+)/);
    assert(!!zhongliStaleMatch && zhongliStaleMatch[1] === '30', 'D3. 同一個 range 重試失敗時，仍可 fallback 回「同 identity」的上一次成功資料（不是整個關掉 stale 機制）', tableTextSameRangeStale);
  }

  // ══════════════════════════════════════════════════════════════
  // Part E — Search／Ranking 只作用於目前這個 range 已經拿到的 rows
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    setFakeApi((url) => (/range=7d/.test(url) ? buildFixtureRoute('7d') : { body: { success: true, cities: [] } }));
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    panel.geoGa4H1State.rangeState = { mode: '7d', singleDate: '', startDate: '', endDate: '' };
    await panel.geoGa4H1Refresh(IDS, map);
    const filtered = panel._geoGa4H1FilterRows(panel.geoGa4H1State.lastRenderedRows, '中壢');
    assert(filtered.length === 1 && filtered[0].district_name === '中壢區', 'E1. 搜尋只在目前 7d 已拿到的 rows 裡篩選（不會搜出其他 range 的行政區）', JSON.stringify(filtered));
  }

  // ══════════════════════════════════════════════════════════════
  // Part F — Overseas／Other 重複列必須可區分（附加 raw context），不是
  // 無法解釋的兩筆完全相同資料。
  // ══════════════════════════════════════════════════════════════
  {
    const panel = require('../public/js/geo-ga4-h1-panel.js');
    const rowJP = { normalization_status: 'overseas_or_other', country_raw: 'Japan', region_raw: 'Tokyo', city_raw: 'Shibuya' };
    const rowUS = { normalization_status: 'overseas_or_other', country_raw: 'United States', region_raw: 'California', city_raw: 'Los Angeles' };
    const labelJP = panel._geoGa4H1RowLabel(rowJP);
    const labelUS = panel._geoGa4H1RowLabel(rowUS);
    assert(labelJP !== labelUS, 'F1. 兩筆不同 raw identity 的 Overseas/Other row，顯示 label 不再完全相同', `${labelJP} vs ${labelUS}`);
    assert(labelJP.includes('Overseas') && labelJP.includes('Japan'), 'F2. Overseas/Other label 附帶原始 country/region/city context', labelJP);
    const rowNoContext = { normalization_status: 'overseas_or_other' };
    assert(panel._geoGa4H1RowLabel(rowNoContext) === 'Overseas／Other', 'F3. 沒有任何 raw context 時，維持原始純文字（不強行加空括號）', panel._geoGa4H1RowLabel(rowNoContext));
  }

  // ══════════════════════════════════════════════════════════════
  // Part G — Range Key Collision Guard：90d／180d／this_year／last_year／
  // custom 全部走 apiRange='custom' transport，range key 不能只用
  // mode==='custom' 當 identity，否則彼此會誤判成「同一個 range」而互相
  // stale-fallback（需求文件七、八、三十一、三十二）。這裡故意讓 90d 成功、
  // 180d 失敗，兩者 start/end 完全不同，驗證不會把 90d 的資料誤當 180d
  // 的合法快取。
  // ══════════════════════════════════════════════════════════════
  {
    const dom = makeDom();
    const panel = freshPanelModule(dom);
    let failNext180d = false;
    setFakeApi((url) => {
      // 90d／180d／custom 全部用 range=custom 傳輸，只能靠 start_date/end_date 分辨。
      if (/start_date=2026-05-13/.test(url)) return buildFixtureRoute('90d'); // today(2026-08-10) - 89 days
      if (/start_date=2026-02-11/.test(url)) {
        if (failNext180d) return { status: 500, ok: false, body: { success: false, code: 'ga4_backend_error' } };
        return buildFixtureRoute('180d');
      }
      return { body: { success: true, cities: [] } };
    });
    const map = new FakeMap();
    panel.geoGa4H1State.mode = 'historical';
    // 90d／180d 都不帶自訂日期，直接用 preset resolve（今天固定用真實系統時間，
    // 這裡改用 custom 明確指定日期，確保測項在任何執行日都穩定，不受
    // 「今天」浮動影響——直接用兩個確定不同的 custom 區段模擬「都走 custom
    // transport 但 identity 不同」的情境，等效於 90d vs 180d 的碰撞風險）。
    panel.geoGa4H1State.rangeState = { mode: 'custom', singleDate: '', startDate: '2026-05-13', endDate: '2026-08-10' };
    await panel.geoGa4H1Refresh(IDS, map);
    assert(dom.window.document.getElementById(IDS.table).textContent.includes('板橋區'), 'G1. 第一個 custom-transport range（90d 等效區段）先正確顯示自己的資料');

    failNext180d = true;
    panel.geoGa4H1State.rangeState = { mode: 'custom', singleDate: '', startDate: '2026-02-11', endDate: '2026-08-10' };
    await panel.geoGa4H1Refresh(IDS, map);
    const tableTextAfterCollisionFail = dom.window.document.getElementById(IDS.table).textContent;
    assert(!tableTextAfterCollisionFail.includes('板橋區'), 'G2. 第二個 custom-transport range（不同 start_date）請求失敗時，不得誤用第一個 range 的 lastGoodPayload（range key 不能只認 mode===\'custom\'）', tableTextAfterCollisionFail);
  }

  console.log('\n======================================================================');
  console.log('H1.4.3 HEATMAP RANGE RUNTIME SUMMARY');
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
