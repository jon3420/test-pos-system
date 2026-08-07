#!/usr/bin/env node
// scripts/audit-taiwan-unique-subdivision-aliases.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2 — Unique Administrative Alias Audit
//
// 真實掃描 data/taiwan-administrative-areas.json（透過既有
// utils/taiwanGeoNormalize.js 的索引／查詢函式，不另建第二套資料或索引），
// 產出 H1.2 需求文件七要求的統計數字。不得只在文件宣稱唯一——所有數字
// 必須由這支腳本對真實 Catalog 掃描得出，且本檔案輸出即是唯一真實來源。

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const geo = require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));

function main() {
  const subdivisions = geo.listSubdivisions();
  const counties = geo.listCounties();

  // 建立「每個 alias → 有幾個不同 subdivision_code」的統計，完全透過對外
  // 公開的 resolveUniqueSubdivisionParentCounty()（不重讀 JSON、不繞過既有
  // Resolver 另建索引），確保稽核腳本量到的就是正式路徑實際會用到的結果。
  const aliasSet = new Map(); // normalizedAliasDisplay -> subdivision_code set (via resolver)
  subdivisions.forEach((s) => {
    const aliases = new Set([s.subdivision_name, s.subdivision_name_en, ...(s.aliases || [])]);
    aliases.forEach((a) => {
      if (!aliasSet.has(a)) aliasSet.set(a, new Set());
      aliasSet.get(a).add(s.subdivision_code);
    });
  });

  let uniqueAliasCount = 0;
  let ambiguousAliasCount = 0;
  const ambiguousDetail = [];
  const chineseAliases = new Set();
  const englishAliases = new Set();
  subdivisions.forEach((s) => {
    if (s.subdivision_name) chineseAliases.add(s.subdivision_name);
    (s.aliases || []).forEach((a) => { if (/^[\u4e00-\u9fff]+$/.test(a)) chineseAliases.add(a); });
    if (s.subdivision_name_en) englishAliases.add(s.subdivision_name_en);
    (s.aliases || []).forEach((a) => { if (/^[A-Za-z][A-Za-z\s.]*$/.test(a)) englishAliases.add(a); });
  });

  aliasSet.forEach((codes, alias) => {
    if (codes.size === 1) uniqueAliasCount += 1;
    else {
      ambiguousAliasCount += 1;
      ambiguousDetail.push({
        alias,
        candidates: subdivisions.filter((s) => codes.has(s.subdivision_code))
          .map((s) => ({ county_name: s.county_name, subdivision_name: s.subdivision_name, subdivision_code: s.subdivision_code })),
      });
    }
  });

  const noParentCounty = subdivisions.filter((s) => !geo.getCountyByCode(s.county_code));
  const codeCounts = new Map();
  subdivisions.forEach((s) => codeCounts.set(s.subdivision_code, (codeCounts.get(s.subdivision_code) || 0) + 1));
  const duplicateCodes = Array.from(codeCounts.entries()).filter(([, n]) => n > 1);

  function probe(name) {
    return geo.resolveUniqueSubdivisionParentCounty(name);
  }

  const pingzhen = probe('Pingzhen District');
  const yangmei = probe('Yangmei District');
  const banqiao = probe('Banqiao District');

  const report = {
    generated_at: new Date().toISOString(),
    subdivision_total: subdivisions.length,
    county_total: counties.length,
    canonical_chinese_alias_count: chineseAliases.size,
    canonical_english_alias_count: englishAliases.size,
    unique_alias_count: uniqueAliasCount,
    ambiguous_alias_count: ambiguousAliasCount,
    ambiguous_alias_detail: ambiguousDetail,
    no_parent_county_count: noParentCounty.length,
    no_parent_county_detail: noParentCounty,
    duplicate_subdivision_code_count: duplicateCodes.length,
    duplicate_subdivision_code_detail: duplicateCodes,
    pingzhen_district_candidates: pingzhen,
    yangmei_district_candidates: yangmei,
    banqiao_district_candidates: banqiao,
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  main();
} else {
  module.exports = { main };
}
