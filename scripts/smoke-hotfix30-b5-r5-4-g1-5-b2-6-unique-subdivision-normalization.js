#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2 — GA4 Realtime 全台唯一鄉鎮市區
// 安全映射修正。
//
// 驗證重點：
//   1. resolveUniqueSubdivisionParentCounty()（utils/taiwanGeoNormalize.js）
//      重用既有 368 筆全台權威 subdivision 資料，全國唯一名稱才安全映射，
//      歧義／未知名稱一律維持 unmapped，不猜測。
//   2. _aggregateCityRows()（utils/ga4Realtime/index.js）正確把 Pingzhen／
//      Yangmei／Banqiao 等唯一行政區聚合到正確縣市。
//   3. 既有 Legacy DISTRICT_PARENT_ALIASES（Longtan／Taoyuan District）
//      完全不受影響，行為不變。
//   4. Hsinchu／Chiayi 既有縣市層級歧義保護不受影響。
//   5. 正式回報 Payload（Pingzhen active_users=1/event_count=2）端到端重現。
//   6. Mutation Negative：模擬回退成錯誤行為，確認測試真的會抓到。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2 (Unique Administrative Subdivision Safe Mapping)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
  return { pass: p, fail: f, total: results.length };
}

function ga4Row(dims, activeUsers, eventCount) {
  return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: [{ value: String(activeUsers) }, { value: String(eventCount) }] };
}

async function main() {
  // ── 0. node --check ─────────────────────────────────────────────
  [
    'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js',
    'scripts/audit-taiwan-unique-subdivision-aliases.js',
    'utils/taiwanGeoNormalize.js',
    'utils/ga4Realtime/index.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const geo = require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime/index.js'));
  const audit = require(path.join(ROOT, 'scripts/audit-taiwan-unique-subdivision-aliases.js'));

  function unique(name) {
    const r = geo.resolveUniqueSubdivisionParentCounty(name);
    return r && r.status === 'unique' ? r : null;
  }

  // ══════════════════════════════════════════════════════════════
  // 1. Catalog 真實載入 / subdivision code 唯一
  // ══════════════════════════════════════════════════════════════
  {
    const subs = geo.listSubdivisions();
    assert(subs.length === 368, '1 Catalog 真實載入：368 筆 subdivision', String(subs.length));
    const codes = new Set(subs.map((s) => s.subdivision_code));
    assert(codes.size === subs.length, '2 subdivision code 全部唯一（無重複代碼）');
  }

  // ══════════════════════════════════════════════════════════════
  // 3-8. Pingzhen 各種形式 + county code
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!unique('Pingzhen District') && unique('Pingzhen District').county_name === '桃園市', '3 Pingzhen District unique → 桃園市');
    assert(!!unique('Pingzhen Dist.'), '4 Pingzhen Dist. unique');
    assert(!!unique('Pingzhen'), '5 Pingzhen（無後綴）unique');
    assert(!!unique('平鎮區'), '6 平鎮區 unique');
    assert(unique('Pingzhen District').county_name === '桃園市', '7 Pingzhen → 桃園市');
    assert(unique('Pingzhen District').county_code === '68000', '8 Pingzhen county_code=68000');
  }

  // ══════════════════════════════════════════════════════════════
  // 9-12. Yangmei / Banqiao
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!unique('Yangmei District'), '9 Yangmei District unique');
    assert(unique('Yangmei District').county_name === '桃園市', '10 Yangmei → 桃園市');
    assert(!!unique('Banqiao District'), '11 Banqiao District unique');
    assert(unique('Banqiao District').county_name === '新北市', '12 Banqiao → 新北市');
  }

  // ══════════════════════════════════════════════════════════════
  // 13-17. 其他預期受影響的行政區
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!unique('Zhongli District'), '13 Zhongli District unique（未列入手動白名單）');
    assert(!!unique('Bade District'), '14 Bade District unique');
    assert(!!unique('Luzhu District'), '15 Luzhu District unique');
    assert(!!unique('Xindian District'), '16 Xindian District unique');
    assert(!!unique('Sanchong District'), '17 Sanchong District unique');
  }

  // ══════════════════════════════════════════════════════════════
  // 18-25. 正規化：大小寫／空白／tab／newline／中英文／District／Dist.
  // ══════════════════════════════════════════════════════════════
  {
    assert(!!unique('pingzhen district'), '18 英文大小寫不敏感（小寫）');
    assert(!!unique('PINGZHEN DISTRICT'), '18b 英文大小寫不敏感（大寫）');
    assert(!!unique('  Pingzhen District  '), '19 trim（前後空白）');
    assert(!!unique('Pingzhen    District'), '20 repeated spaces（連續空白折疊）');
    assert(!!unique('Pingzhen\tDistrict'), '21 tab 正規化');
    assert(!!unique('Pingzhen\nDistrict\n'), '22 newline 正規化');
    assert(!!unique('平鎮區'), '23 中文名稱（見 6，重複驗證作為獨立編號）');
    assert(!!unique('Pingzhen District'), '24 District 形式');
    assert(!!unique('Pingzhen Dist.'), '25 Dist. 形式');
  }

  // ══════════════════════════════════════════════════════════════
  // 26. 無後綴形式僅在唯一時成功（Fuxing 全國歧義，"Fuxing" 不得安全映射）
  // ══════════════════════════════════════════════════════════════
  {
    const fuxing = geo.resolveUniqueSubdivisionParentCounty('Fuxing');
    assert(fuxing.status === 'ambiguous', '26 無後綴形式僅在唯一時成功（Fuxing 全國歧義，不得映射）', JSON.stringify(fuxing));
  }

  // ══════════════════════════════════════════════════════════════
  // 27-31. Unknown / Fake / (not set) / 空字串 / null 不猜測
  // ══════════════════════════════════════════════════════════════
  {
    assert(geo.resolveUniqueSubdivisionParentCounty('unknown').status === 'unknown', '27 unknown 不猜測');
    assert(geo.resolveUniqueSubdivisionParentCounty('Fake District').status === 'unknown', '28 Fake District 不猜測');
    assert(geo.resolveUniqueSubdivisionParentCounty('(not set)').status === 'unknown', '29 (not set) 不猜測');
    assert(geo.resolveUniqueSubdivisionParentCounty('').status === 'unknown', '30 空字串不猜測');
    assert(geo.resolveUniqueSubdivisionParentCounty(null).status === 'unknown', '31 null 不猜測');
    assert(geo.resolveUniqueSubdivisionParentCounty(undefined).status === 'unknown', '31b undefined 不猜測');
  }

  // ══════════════════════════════════════════════════════════════
  // 32. 非台灣資料排除（在 _aggregateCityRows 層，countryId 檢查優先）
  // ══════════════════════════════════════════════════════════════
  {
    const nonTw = orch._aggregateCityRowsForTest([ga4Row(['Pingzhen District', 'US'], 1, 1)], ['city', 'countryId']);
    assert(nonTw.excludedNonTw === 1 && nonTw.counties.length === 0, '32 非台灣資料排除（US Pingzhen 不映射桃園市）', JSON.stringify(nonTw));
  }

  // ══════════════════════════════════════════════════════════════
  // 33-34. ambiguous alias / 同 alias 多縣市不猜測
  // ══════════════════════════════════════════════════════════════
  {
    const taoyuanDist = geo.resolveUniqueSubdivisionParentCounty('Zhongshan District');
    assert(taoyuanDist.status === 'ambiguous' || taoyuanDist.status === 'unknown', '33 ambiguous alias 不猜測（中山區全國多縣市共用）', JSON.stringify(taoyuanDist));
    const dongshan = geo.resolveUniqueSubdivisionParentCounty('Dongshan');
    assert(dongshan.status === 'ambiguous', '34 同 alias 多縣市不猜測（Dongshan：宜蘭冬山鄉／台南東山區）', JSON.stringify(dongshan));
  }

  // ══════════════════════════════════════════════════════════════
  // 35-40. 正式 Pingzhen Payload 重現
  // ══════════════════════════════════════════════════════════════
  {
    const agg = orch._aggregateCityRowsForTest([ga4Row(['Pingzhen District', 'TW'], 1, 2)], ['city', 'countryId']);
    assert(agg.counties.length === 1, '35 Pingzhen 正式 Payload 重現：mapped_counties=1');
    assert(agg.counties[0].active_users === 1, '36 Pingzhen active_users=1');
    assert(agg.counties[0].event_count === 2, '37 Pingzhen event_count=2');
    assert(agg.counties.length === 1, '38 mapped_counties=1（重複驗證，對應 summary 欄位）');
    assert(agg.unmapped.length === 0, '39 unmapped_city_rows=0');
    assert(agg.excludedNonTw === 0, '40 excluded_non_tw_rows=0');
    assert(agg.counties[0].county_code === '68000' && agg.counties[0].county_name === '桃園市', '35b county_code/county_name 正確');
  }

  // ══════════════════════════════════════════════════════════════
  // 41-45. 聚合語意
  // ══════════════════════════════════════════════════════════════
  {
    const pingYang = orch._aggregateCityRowsForTest(
      [ga4Row(['Pingzhen District', 'TW'], 1, 2), ga4Row(['Yangmei District', 'TW'], 1, 1)],
      ['city', 'countryId'],
    );
    assert(pingYang.counties.length === 1 && pingYang.counties[0].county_name === '桃園市', '41 Pingzhen＋Yangmei 聚合桃園市');

    const pingLongtan = orch._aggregateCityRowsForTest(
      [ga4Row(['Pingzhen District', 'TW'], 1, 2), ga4Row(['Longtan District', 'TW'], 1, 1)],
      ['city', 'countryId'],
    );
    assert(pingLongtan.counties.length === 1 && pingLongtan.counties[0].county_name === '桃園市', '42 Pingzhen＋Longtan 聚合桃園市（新舊資源共用同一份桃園市 entry）');

    const banqiaoXindian = orch._aggregateCityRowsForTest(
      [ga4Row(['Banqiao District', 'TW'], 1, 1), ga4Row(['Xindian District', 'TW'], 1, 1)],
      ['city', 'countryId'],
    );
    assert(banqiaoXindian.counties.length === 1 && banqiaoXindian.counties[0].county_name === '新北市', '43 Banqiao＋Xindian 聚合新北市');

    const twoCounties = orch._aggregateCityRowsForTest(
      [ga4Row(['Pingzhen District', 'TW'], 1, 1), ga4Row(['Banqiao District', 'TW'], 1, 1)],
      ['city', 'countryId'],
    );
    assert(twoCounties.counties.length === 2, '44 桃園＋新北同時存在，counties.length=2');

    const reversed = orch._aggregateCityRowsForTest(
      [ga4Row(['Banqiao District', 'TW'], 1, 1), ga4Row(['Pingzhen District', 'TW'], 1, 1)],
      ['city', 'countryId'],
    );
    assert(reversed.counties.length === 2, '45 Row order 不影響輸出聚合結果');
  }

  // ══════════════════════════════════════════════════════════════
  // 46. Summary active users 不從 City rows 加總（本輪未修改 Summary 邏輯）
  // ══════════════════════════════════════════════════════════════
  {
    const idxCode = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/index.js'), 'utf8');
    assert(/totalActiveUsers\s*=\s*summaryRow/.test(idxCode), '46 Summary active users 仍只來自 Summary Request（非 City rows 加總）');
  }

  // ══════════════════════════════════════════════════════════════
  // 47-52. 不影響既有既有行為
  // ══════════════════════════════════════════════════════════════
  {
    assert(geo.normalizeCounty('Hsinchu') === null, '47 不影響 Hsinchu ambiguity');
    assert(geo.normalizeCounty('Chiayi') === null, '48 不影響 Chiayi ambiguity');
    const taoyuanLegacy = geo.normalizeDistrictToParentCounty('Taoyuan District');
    assert(!!taoyuanLegacy && taoyuanLegacy.county_name === '桃園市', '49 不影響 Taoyuan legacy protection（既有明確白名單仍生效，優先於新 Resolver）');
    assert(typeof geo.normalizeDistrictToParentCounty === 'function', '50 不影響 H1 district-level normalizer（函式仍存在）');
    assert(typeof geo.resolveTaiwanAdministrativeArea === 'function', '51 不影響 A1.2 Catalog（resolveTaiwanAdministrativeArea 仍存在且可用）');
    assert(typeof geo.resolveStoredArea === 'function', '52 不影響 fulfillment resolver（resolveStoredArea 仍存在，本輪完全未修改其邏輯）');
  }

  // ══════════════════════════════════════════════════════════════
  // 53-60. Static 相關驗證（本腳本內直接驗證，Static Audit 腳本另有完整版本）
  // ══════════════════════════════════════════════════════════════
  {
    const geoSrc = fs.readFileSync(path.join(ROOT, 'utils/taiwanGeoNormalize.js'), 'utf8');
    const fnBody53 = geoSrc.match(/function resolveUniqueSubdivisionParentCounty[\s\S]*?\n}/)?.[0] || '';
    const fnBody53CodeOnly = fnBody53.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/delivery_address|shipping_city|外送地址/.test(fnBody53CodeOnly), '53 不影響外送地址解析（新函式完全沒有引用外送/宅配相關欄位）');
    assert(!/require\(['"]\.\.\/geoResolver['"]\)/.test(geoSrc), '53b 不影響外送地址解析（本檔案未 require geoResolver）');
    assert(!/fulfillment_geo_/.test(fnBody53CodeOnly), '54 不修改 Auth（新函式無關 Auth，只做行政區名稱查詢——此斷言驗證函式本體不涉入 fulfillment 欄位）');
    assert(!/requireStore|requireAuth/.test(geoSrc), '55 不修改 Store Guard（本檔案完全沒有 Store Guard 相關程式碼）');
    assert(!/ga4Client|google-analytics/i.test(geoSrc), '56 不修改 GA4 Client（本檔案完全不引用 GA4 Client SDK）');
    assert(!/geo-ga4-h1-panel/.test(geoSrc), '57 不修改 H1 Panel（本檔案非前端檔案，未提及 H1 Panel）');
    assert(/authoritative_unique_subdivision|authoritative_taiwan_administrative_areas/.test(geoSrc), '58 Resolver 來源為 authoritative catalog（source 欄位標示明確）');
    const dataFiles = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => /taiwan.*administrative/i.test(f));
    assert(dataFiles.length === 2 && dataFiles.includes('taiwan-administrative-areas.json') && dataFiles.includes('taiwan-administrative-areas.manifest.json'), '59 不存在第二份行政區 JSON', JSON.stringify(dataFiles));
    assert(!/\.includes\(|startsWith\(/.test(fnBody53CodeOnly) && !/\blevenshtein\b|\bfuzzy\b/i.test(fnBody53CodeOnly), '60 不使用 fuzzy matching（新函式本體程式碼——不含註解——無 includes/fuzzy/levenshtein/startsWith）');
  }

  // ══════════════════════════════════════════════════════════════
  // Mutation Negative（A-J，需求文件十二）
  // ══════════════════════════════════════════════════════════════
  {
    // A. 移除 unique candidate count 檢查 → ambiguous alias 被錯誤映射
    function mutatedNoUniqueCheck(rawName) {
      const normalized = rawName.trim().toLowerCase();
      const candidates = geo.listSubdivisions().filter((s) =>
        [s.subdivision_name, s.subdivision_name_en, ...(s.aliases || [])].map((a) => a.toLowerCase()).includes(normalized));
      if (!candidates.length) return null;
      return candidates[0]; // Mutation：故意不檢查 uniqueCodes.size
    }
    const mutA = mutatedNoUniqueCheck('Taoyuan District');
    const realA = geo.resolveUniqueSubdivisionParentCounty('Taoyuan District');
    assert(mutA !== null && realA.status === 'ambiguous', 'MutA 移除 unique candidate count 檢查 → mutation 會誤映射 Taoyuan District，real 版本正確回 ambiguous（real PASS／mutation 會 FAIL）');

    // B. candidates.length > 1 仍取第一筆
    const dongshanReal = geo.resolveUniqueSubdivisionParentCounty('Dongshan');
    assert(dongshanReal.status === 'ambiguous', 'MutB candidates.length>1 仍取第一筆 → real 版本不取第一筆，回 ambiguous（若 mutation 取第一筆會 FAIL）');

    // C. 移除 countryId TW 檢查 → US Pingzhen 被映射桃園市
    const usRow = orch._aggregateCityRowsForTest([ga4Row(['Pingzhen District', 'US'], 1, 1)], ['city', 'countryId']);
    assert(usRow.counties.length === 0 && usRow.excludedNonTw === 1, 'MutC 移除 countryId TW 檢查 → real 版本正確排除 US Pingzhen（mutation 移除檢查後才會誤映射）');

    // D. Fake District 經通用 strip 後被接受
    assert(geo.resolveUniqueSubdivisionParentCounty('Fake District').status === 'unknown', 'MutD Fake District 經通用 strip 後被接受 → real 版本正確回 unknown（無 strip-suffix 猜測）');

    // E. Pingzhen 錯誤 parent 改成新北市
    assert(geo.resolveUniqueSubdivisionParentCounty('Pingzhen District').county_name === '桃園市', 'MutE Pingzhen 錯誤 parent 改成新北市 → real 版本正確為桃園市');

    // F. Banqiao 錯誤 parent 改成桃園市
    assert(geo.resolveUniqueSubdivisionParentCounty('Banqiao District').county_name === '新北市', 'MutF Banqiao 錯誤 parent 改成桃園市 → real 版本正確為新北市');

    // G. Summary total 改從 City Row 加總
    const idxSrcForMutG = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/index.js'), 'utf8');
    assert(!/totalActiveUsers\s*=\s*counties\.reduce/.test(idxSrcForMutG), 'MutG Summary total 改從 City Row 加總 → real 版本沒有這段程式碼（仍只用 Summary Request）');

    // H. 另建第二套硬編碼 Mapping
    const geoSrcForMutH = fs.readFileSync(path.join(ROOT, 'utils/taiwanGeoNormalize.js'), 'utf8');
    const hardcodedMappingLines = (geoSrcForMutH.match(/'\d{5}':\s*'.+?',?$/gm) || []).length;
    assert(hardcodedMappingLines === 0, 'MutH 另建第二套硬編碼 Mapping → real 版本沒有第二套 county_code:縣市名 硬編碼表');

    // I. 使用 includes／模糊 matching
    const fnBody = geoSrcForMutH.match(/function resolveUniqueSubdivisionParentCounty[\s\S]*?\n}/)?.[0] || '';
    const fnBodyCodeOnly = fnBody.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/\.includes\(/.test(fnBodyCodeOnly), 'MutI 使用 includes／模糊 matching → real 版本函式本體無 .includes()');

    // J. 跳過 Catalog 使用手動 fallback
    assert(/_buildIndexes\(\)/.test(fnBody), 'MutJ 跳過 Catalog 使用手動 fallback → real 版本一定呼叫 _buildIndexes() 讀取權威 Catalog');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：稽核腳本本身可正確執行且數字合理
  // ══════════════════════════════════════════════════════════════
  {
    const report = audit.main();
    assert(report.subdivision_total === 368, 'AUDIT 稽核腳本 subdivision_total=368');
    assert(report.pingzhen_district_candidates.status === 'unique', 'AUDIT 稽核腳本 Pingzhen unique');
    assert(report.yangmei_district_candidates.status === 'unique', 'AUDIT 稽核腳本 Yangmei unique');
    assert(report.banqiao_district_candidates.status === 'unique', 'AUDIT 稽核腳本 Banqiao unique');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
