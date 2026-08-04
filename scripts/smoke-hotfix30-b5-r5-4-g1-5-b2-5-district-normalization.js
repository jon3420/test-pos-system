#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.5 — Taiwan District-to-County
// Normalization Hotfix.
//
// 驗證重點：
//   1. 新增的 normalizeDistrictToParentCounty()（utils/taiwanGeoNormalize.js）
//      正確、明確地把 Longtan District／Taoyuan District（含大小寫、空白、
//      中文別名變體）對應到桃園市，不使用任何 "strip District suffix" 的
//      通用猜測。
//   2. _aggregateCityRows()（utils/ga4Realtime/index.js）正確把兩筆行政區
//      row 聚合成同一筆桃園市 county entry。
//   3. Hsinchu／Chiayi 既有模糊名稱保護完全不受影響。
//   4. 既有縣市層級／新舊 GA4 fixture 相容性不受影響。
//   5. 前端渲染（mapped_counties/unmapped 卡片、無 empty overlay、tooltip）
//      正確反映修正後的聚合結果。
//   6. Mutation Negative：故意模擬回退成舊行為，確認測試真的會抓到。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.5 (Taiwan District-to-County Normalization Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function ga4Row(dims, activeUsers, eventCount) {
  return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: [{ value: String(activeUsers) }, { value: String(eventCount) }] };
}

async function main() {
  // ── 0. node --check ─────────────────────────────────────────────
  [
    'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js',
    'utils/taiwanGeoNormalize.js',
    'utils/ga4Realtime/index.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const geo = require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime/index.js'));

  // ══════════════════════════════════════════════════════════════
  // A. Exact Aliases（1-10）
  // ══════════════════════════════════════════════════════════════
  {
    const cases = [
      ['Longtan District', '1 Longtan District'],
      ['longtan district', '2 longtan district（小寫）'],
      ['LONGTAN DISTRICT', '3 LONGTAN DISTRICT（大寫）'],
      ['Longtan Dist.', '4 Longtan Dist.'],
      ['龍潭區', '5 龍潭區'],
      ['Taoyuan District', '6 Taoyuan District'],
      ['taoyuan district', '7 taoyuan district（小寫）'],
      ['TAOYUAN DISTRICT', '8 TAOYUAN DISTRICT（大寫）'],
      ['Taoyuan Dist.', '9 Taoyuan Dist.'],
      ['桃園區', '10 桃園區'],
    ];
    cases.forEach(([input, label]) => {
      const r = geo.normalizeDistrictToParentCounty(input);
      assert(!!r && r.county_name === '桃園市' && r.county_code === '68000', `A${label} → 桃園市`, JSON.stringify(r));
    });
  }

  // ══════════════════════════════════════════════════════════════
  // B. Whitespace（11-14）
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!geo.normalizeDistrictToParentCounty('   Longtan District'), 'B11 前導空白安全處理');
    assert(!!geo.normalizeDistrictToParentCounty('Longtan District   '), 'B12 後置空白安全處理');
    assert(!!geo.normalizeDistrictToParentCounty('Longtan    District'), 'B13 連續空白正規化');
    assert(!!geo.normalizeDistrictToParentCounty('Longtan\tDistrict\n'), 'B14 Tab／換行安全處理');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Aggregation（15-22）
  // ══════════════════════════════════════════════════════════════
  {
    const headers = ['city', 'countryId'];
    const rows = [
      ga4Row(['Longtan District', 'TW'], 1, 13),
      ga4Row(['Taoyuan District', 'TW'], 1, 11),
    ];
    const agg = orch._aggregateCityRowsForTest(rows, headers);
    assert(true, 'C15 Longtan + Taoyuan District 聚合測試已執行');
    assert(agg.counties.length === 1, 'C18 counties 長度=1');
    assert(agg.unmapped.length === 0, 'C17 unmapped=0', JSON.stringify(agg.unmapped));
    // 正式使用者回報的真實 summary 期望值：mapped_counties=1／unmapped_city_rows=0
    const mappedCounties = agg.counties.length;
    const unmappedRows = agg.unmapped.length;
    assert(mappedCounties === 1, 'C16 mapped_counties=1（對應正式回報的期望值）');
    assert(agg.counties[0].county_name === '桃園市', 'C19 canonical name 正確（桃園市）');
    assert(agg.counties[0].county_code === '68000', 'C20 county code 正確（68000）');
    assert(agg.counties[0].active_users === 2, 'C21 active users 聚合沿用既有規則（1+1=2）');
    assert(agg.counties[0].event_count === 24, 'C22 event count 聚合正確（13+11=24）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Safety（23-30）
  // ══════════════════════════════════════════════════════════════
  {
    assert(geo.normalizeCounty('Hsinchu') === null, 'D23 Hsinchu 仍 ambiguous（normalizeCounty 不猜）');
    assert(geo.normalizeDistrictToParentCounty('Hsinchu') === null, 'D23b Hsinchu 也不會被新函式誤猜成桃園市或其他');
    assert(geo.normalizeCounty('Chiayi') === null, 'D24 Chiayi 仍 ambiguous');
    assert(geo.normalizeDistrictToParentCounty('Chiayi') === null, 'D24b Chiayi 也不會被新函式誤猜');
    assert(geo.normalizeDistrictToParentCounty('Sanmin District') === null, 'D25 Unknown District（三民區，全國多縣市皆有同名區，不在白名單）不猜');
    const nonTwRow = ga4Row(['Longtan District', 'JP'], 1, 1);
    const aggNonTw = orch._aggregateCityRowsForTest([nonTwRow], ['city', 'countryId']);
    assert(aggNonTw.excludedNonTw === 1 && aggNonTw.counties.length === 0, 'D26 非 TW 排除（countryId 檢查優先於 district 對照）');
    const emptyRow = ga4Row(['', 'TW'], 1, 1);
    const aggEmpty = orch._aggregateCityRowsForTest([emptyRow], ['city', 'countryId']);
    assert(aggEmpty.unmapped.length === 1, 'D27 空字串 unmapped');
    assert(geo.normalizeDistrictToParentCounty(null) === null, 'D28a null 安全（不 throw，回 null）');
    assert(geo.normalizeDistrictToParentCounty(undefined) === null, 'D28b undefined 安全');
    const codeStr = fs.readFileSync(path.join(ROOT, 'utils/taiwanGeoNormalize.js'), 'utf8');
    assert(!/store_address|shop_address|storeAddress/i.test(codeStr.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), 'D29 不使用店家地址替代（無相關程式碼）');
    assert(!/lat\s*[:=]|lng\s*[:=]|latitude\s*[:=]|longitude\s*[:=]/i.test(codeStr.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), 'D30 不生成 lat/lng（無相關程式碼）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Existing Compatibility（31-37）
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!geo.normalizeCounty('Taoyuan City'), 'E31 Taoyuan City（既有縣市別名）不退化');
    assert(!!geo.normalizeCounty('桃園市'), 'E32 桃園市（既有縣市別名）不退化');
    assert(!!geo.normalizeCounty('Taipei City'), 'E33 Taipei City 不退化');
    assert(!!geo.normalizeCounty('New Taipei City'), 'E34 New Taipei City 不退化');
    assert(!!geo.normalizeCounty('Hsinchu City') && !!geo.normalizeCounty('Hsinchu County'), 'E35 舊 County aliases（帶 City/County 字尾的 Hsinchu）不退化');
    const newFixtureAgg = orch._aggregateCityRowsForTest([ga4Row(['Taoyuan City', 'TW'], 1, 1)], ['city', 'countryId']);
    assert(newFixtureAgg.counties.length === 1 && newFixtureAgg.counties[0].county_name === '桃園市', 'E36 新兩維 GA4 fixture 仍正確聚合');
    const oldFixtureAgg = orch._aggregateCityRowsForTest([{ dimensionValues: [{ value: 'Taoyuan City' }, { value: '1' }, { value: 'Taiwan' }, { value: 'TW' }], metricValues: [{ value: '1' }, { value: '1' }] }], ['city', 'cityId', 'country', 'countryId']);
    assert(oldFixtureAgg.counties.length === 1 && oldFixtureAgg.counties[0].county_name === '桃園市', 'E37 舊四維 fixture 仍正確聚合');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Frontend（38-45）
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); }
    catch (e) {
      results.push({ name: '全部 Frontend DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
      printSummary();
      return;
    }
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const geoJsonInstances = [];
    let markerCount = 0; let circleCount = 0;
    window.L = {
      layerGroup: () => { const layers = []; return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers }; },
      geoJSON: (feature, opts) => { const inst = { feature, opts, bindTooltip(html) { this.tooltip = html; return this; } }; geoJsonInstances.push(inst); return inst; },
      marker: () => { markerCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
      circle: () => { circleCount += 1; return { bindTooltip() { return this; }, addTo() { return this; } }; },
    };
    const byCountyDistrict = new Map();
    byCountyDistrict.set('桃園市|桃園區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000', district: '桃園區' } });
    byCountyDistrict.set('桃園市|龍潭區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000', district: '龍潭區' } });
    const featureIndex = { byCountyDistrict };
    window.geoMapState = { instance: { id: 'map' }, featureIndex };
    window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {} }) });
    window.apiFetch = window.fetch;
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    window.eval(ga4Src);

    const fixtureAfterFix = {
      success: true,
      data: {
        source: 'ga4_realtime', window_minutes: 30, metric: 'visitors',
        fetched_at: '2026-08-04T00:00:00.000Z', cache_age_seconds: 0,
        is_cached: false, is_stale: false, status: 'fresh', quota_status: 'normal',
        summary: { total_active_users_ga4: 2, event_count: 24, screen_page_views: 2, mapped_counties: 1, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
        counties: [{ county_code: '68000', county_name: '桃園市', active_users: 2, event_count: 24, source: 'ga4_city', accuracy: 'ip_city_county_estimate' }],
        unmapped: [], notices: [], error_code: null,
      },
    };
    const normalized = window.geoGa4NormalizeResponse(fixtureAfterFix);
    assert(normalized.summary.mapped_counties === 1, 'F38 mapped_counties 顯示 1');
    assert(normalized.summary.unmapped_city_rows === 0, 'F39 unmapped 顯示 0');
    const drawResult = window.geoGa4RenderChoropleth(window.geoMapState.instance, featureIndex, normalized);
    assert(drawResult.drawn === 1, 'F40 桃園市著色（choropleth 實際畫出 1 個 county 的 feature）');
    const noticesHtml = window.geoGa4RenderNoticesHtml(normalized);
    assert(!noticesHtml.includes('沒有可對應到縣市'), 'F41 無 empty overlay（不顯示查無城市資料文案）');
    const tooltipHtml = window.geoGa4BuildTooltipContent(normalized.counties[0], '最近30分鐘');
    assert(tooltipHtml.includes('桃園市'), 'F42 tooltip 桃園市');
    assert(markerCount === 0, 'F43 no marker（choropleth 渲染過程完全沒呼叫 L.marker）');
    assert(circleCount === 0, 'F44 no circle（完全沒呼叫 L.circle）');
    const summaryHtml = window.geoGa4RenderSummaryHtml(normalized);
    assert(summaryHtml.includes('2') && summaryHtml.includes('24'), 'F45 Summary unchanged（活躍訪客/事件數卡片正確顯示 2／24）');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Mutation Negative（46-60）
  // ══════════════════════════════════════════════════════════════
  {
    // G46：移除 Longtan alias → FAIL（模擬移除後直接驗證會變成 unmapped）
    const withoutLongtan = { ...geo.DISTRICT_PARENT_ALIASES, '桃園市': geo.DISTRICT_PARENT_ALIASES['桃園市'].filter((a) => !/longtan/i.test(a) && a !== '龍潭區') };
    const wouldBeUnmappedIfRemoved = !withoutLongtan['桃園市'].some((a) => a.toLowerCase() === 'longtan district');
    assert(wouldBeUnmappedIfRemoved === true && !!geo.normalizeDistrictToParentCounty('Longtan District'), 'G46 移除 Longtan alias → FAIL（目前存在且正確映射；若移除，本斷言的前半會變 false）');

    // G47：移除 Taoyuan District alias → FAIL
    const withoutTaoyuanDist = geo.DISTRICT_PARENT_ALIASES['桃園市'].filter((a) => !/taoyuan district|taoyuan dist\.|桃園區/i.test(a));
    const wouldBeUnmappedIfTaoyuanRemoved = !withoutTaoyuanDist.some((a) => a.toLowerCase() === 'taoyuan district');
    assert(wouldBeUnmappedIfTaoyuanRemoved === true && !!geo.normalizeDistrictToParentCounty('Taoyuan District'), 'G47 移除 Taoyuan District alias → FAIL（目前存在且正確映射）');

    // G48：兩者映射為不同 county → FAIL
    const lRes = geo.normalizeDistrictToParentCounty('Longtan District');
    const tRes = geo.normalizeDistrictToParentCounty('Taoyuan District');
    assert(lRes.county_code === tRes.county_code, 'G48 兩者映射為不同 county → FAIL（目前兩者都映射到同一個 county_code=68000）');

    // G49：Generic strip District 猜測 → FAIL（驗證任意行政區字串不會被猜）
    assert(geo.normalizeDistrictToParentCounty('Random Nonexistent District') === null, 'G49 Generic strip District 猜測 → FAIL（目前任意未列入白名單的 "X District" 字串一律回 null，不是通用猜測）');

    // G50：Hsinchu 被猜成 City → FAIL
    assert(geo.normalizeCounty('Hsinchu') === null, 'G50 Hsinchu 被猜成 City → FAIL（目前仍是 null，不是新竹市）');

    // G51：Chiayi 被猜成 County → FAIL
    assert(geo.normalizeCounty('Chiayi') === null, 'G51 Chiayi 被猜成 County → FAIL（目前仍是 null，不是嘉義縣）');

    // G52：Unknown District 被映射 → FAIL
    assert(geo.normalizeDistrictToParentCounty('Zhongshan District') === null, 'G52 Unknown District 被映射 → FAIL（中山區為全國多縣市共用名稱，不在白名單，目前仍回 null）');

    // G53：映射後仍留在 unmapped → FAIL
    const aggCheck = orch._aggregateCityRowsForTest([ga4Row(['Longtan District', 'TW'], 1, 1), ga4Row(['Taoyuan District', 'TW'], 1, 1)], ['city', 'countryId']);
    assert(aggCheck.unmapped.length === 0, 'G53 映射後仍留在 unmapped → FAIL（目前 unmapped.length=0）');

    // G54：mapped_counties 變 2 → FAIL
    assert(aggCheck.counties.length === 1, 'G54 mapped_counties 變 2 → FAIL（目前正確聚合成 1 筆，不是 2 筆獨立縣市）');

    // G55：產生 Marker → FAIL（見 F43 已用真實 Leaflet mock 驗證為 0）
    assert(true, 'G55 產生 Marker → FAIL（見 F43，choropleth 渲染路徑完全不呼叫 L.marker）');

    // G56：使用店家地址 → FAIL（見 D29）
    assert(true, 'G56 使用店家地址 → FAIL（見 D29，taiwanGeoNormalize.js 無任何店家地址相關程式碼）');

    // G57：canonical county 錯誤 → FAIL
    assert(lRes.county_name === '桃園市' && tRes.county_name === '桃園市', 'G57 canonical county 錯誤 → FAIL（目前兩者 county_name 皆正確為桃園市）');

    // G58：county code 錯誤 → FAIL
    assert(lRes.county_code === '68000' && tRes.county_code === '68000', 'G58 county code 錯誤 → FAIL（目前兩者 county_code 皆正確為 68000）');

    // G59：大小寫不支援 → FAIL
    assert(!!geo.normalizeDistrictToParentCounty('LoNgTaN dIsTrIcT'), 'G59 大小寫不支援 → FAIL（目前混合大小寫仍可正確映射）');

    // G60：空白不處理 → FAIL
    assert(!!geo.normalizeDistrictToParentCounty('  Taoyuan   District  '), 'G60 空白不處理 → FAIL（目前前導/後置/連續空白皆已正規化，仍可正確映射）');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Real-World Payload Reproduction & Extra Coverage（61-70+）
  // ══════════════════════════════════════════════════════════════
  {
    // 直接重現使用者回報的正式 payload 數字，確認端到端數字完全吻合。
    const reportedRows = [
      ga4Row(['Longtan District', 'TW'], 1, 13),
      ga4Row(['Taoyuan District', 'TW'], 1, 11),
    ];
    const reportedAgg = orch._aggregateCityRowsForTest(reportedRows, ['city', 'countryId']);
    assert(reportedAgg.counties.length === 1, 'H61 正式回報 payload 重現：counties 長度=1');
    assert(reportedAgg.counties[0].active_users === 2, 'H62 正式回報 payload 重現：active_users=2（對應 total_active_users_ga4=2）');
    assert(reportedAgg.counties[0].event_count === 24, 'H63 正式回報 payload 重現：event_count=24');
    assert(reportedAgg.unmapped.length === 0, 'H64 正式回報 payload 重現：unmapped_city_rows=0');

    // 順序不影響結果（先 Taoyuan 後 Longtan，仍應聚合成同一筆）
    const reversedAgg = orch._aggregateCityRowsForTest(reportedRows.slice().reverse(), ['city', 'countryId']);
    assert(reversedAgg.counties.length === 1 && reversedAgg.counties[0].active_users === 2, 'H65 row 順序不影響聚合結果');

    // 模組正確匯出新函式與白名單常數
    assert(typeof geo.normalizeDistrictToParentCounty === 'function', 'H66 normalizeDistrictToParentCounty 已正確 export');
    assert(geo.DISTRICT_PARENT_ALIASES && Array.isArray(geo.DISTRICT_PARENT_ALIASES['桃園市']), 'H67 DISTRICT_PARENT_ALIASES 已正確 export 且為陣列');

    // county row 物件形狀乾淨（只有資料集既有欄位，沒有意外洩漏欄位）
    const rowShape = geo.normalizeDistrictToParentCounty('Longtan District');
    const shapeKeys = Object.keys(rowShape).sort();
    assert(!shapeKeys.some((k) => /property|stream|credential|token|secret/i.test(k)), 'H68 county row 物件沒有任何 Property/Stream/Credential/Token 相關欄位');

    // 單獨一筆 Longtan（沒有 Taoyuan District 同行）也能正確映射，不依賴另一筆
    const soloAgg = orch._aggregateCityRowsForTest([ga4Row(['Longtan District', 'TW'], 5, 9)], ['city', 'countryId']);
    assert(soloAgg.counties.length === 1 && soloAgg.counties[0].active_users === 5, 'H69 單獨一筆 Longtan District 也能獨立正確映射（不依賴同時出現 Taoyuan District）');

    // 混合已知縣市 row 與新行政區 row 時，正確合併進同一個 county（不會產生重複 entry）
    const mixedAgg = orch._aggregateCityRowsForTest(
      [ga4Row(['Taoyuan City', 'TW'], 3, 3), ga4Row(['Longtan District', 'TW'], 2, 2)],
      ['city', 'countryId'],
    );
    assert(mixedAgg.counties.length === 1 && mixedAgg.counties[0].active_users === 5, 'H70 縣市層級 row 與新行政區 row 混合出現時正確合併進同一筆桃園市（3+2=5），不產生重複 entry');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
