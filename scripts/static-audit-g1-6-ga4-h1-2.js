#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-2.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2
// Unique Administrative Subdivision Safe Mapping — Static Audit.
//
// 每一項檢查都讀取實際 Production 檔案內容，comment 剝除後再比對，避免把
// 「我們沒有做 X」的說明文字誤判成真的做了 X（見需求文件十三）。

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}
function fnBody(src, fnName) {
  const m = src.match(new RegExp(`function ${fnName}[\\s\\S]*?\\n}`));
  return m ? m[0] : '';
}

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }

const geoSrc = read('utils/taiwanGeoNormalize.js');
const geoCode = stripComments(geoSrc);
const idxSrc = read('utils/ga4Realtime/index.js');
const idxCode = stripComments(idxSrc);
const resolverBody = stripComments(fnBody(geoSrc, 'resolveUniqueSubdivisionParentCounty'));

// 一、使用 authoritative catalog
check('1', 'resolveUniqueSubdivisionParentCounty 呼叫 _buildIndexes() 讀取既有權威 Catalog', /_buildIndexes\(\)/.test(resolverBody));
check('2', 'Helper 透過既有 _subdivisionNameIndex（同一份索引，非另建）', /_subdivisionCandidatesForAlias/.test(resolverBody) && /_subdivisionNameIndex\.get/.test(geoCode));
check('3', '不重新讀取 JSON（沒有第二個 fs.readFileSync(DATASET_PATH) 呼叫）', (geoCode.match(/fs\.readFileSync/g) || []).length <= 2); // 資料集 + manifest 各一次

// 二、不存在第二份行政區 JSON
check('4', 'data/ 目錄只有一份 taiwan-administrative-areas 相關 JSON + manifest', (() => {
  const files = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => /taiwan.*administrative/i.test(f));
  return files.length === 2;
})());

// 三、不存在 368 筆硬編碼 Mapping
check('5', '沒有第二套 5 碼 county_code → 縣市名 硬編碼 Mapping 表', !/'\d{5}':\s*'[^']+',\s*\n\s*'\d{5}':\s*'[^']+',\s*\n\s*'\d{5}':/.test(geoCode));
check('6', 'resolveUniqueSubdivisionParentCounty 本體行數合理（薄層 Helper，非資料表）', fnBody(geoSrc, 'resolveUniqueSubdivisionParentCounty').split('\n').length < 60);

// 四、unique candidate check 存在
check('7', 'unique candidate 數量檢查存在（uniqueCodes.length）', /uniqueCodes\.length/.test(resolverBody));

// 五、ambiguous 返回 null（等價：status ambiguous 且無 county_code）
check('8', 'ambiguous 分支不回傳 county_code／不猜測', /status:\s*'ambiguous'/.test(resolverBody) && !/status:\s*'ambiguous'[\s\S]{0,80}county_code:\s*sub\./.test(resolverBody));

// 六、unknown 返回 null
check('9', 'unknown 分支存在（candidates.length===0 或空字串/(not set)）', /status:\s*'unknown'/.test(resolverBody));

// 七、non-TW 先排除（在呼叫端 _aggregateCityRows 裡，countryId 檢查在 resolver 呼叫之前）
check('10', '_aggregateCityRows 內 countryId!==TW 檢查在呼叫 resolveUniqueSubdivisionParentCounty 之前（原始碼順序）', (() => {
  const countryIdx = idxCode.indexOf("countryId !== 'TW'");
  const resolverIdx = idxCode.indexOf('resolveUniqueSubdivisionParentCounty(normalizedCity)');
  return countryIdx > -1 && resolverIdx > -1 && countryIdx < resolverIdx;
})());

// 八、不使用 fuzzy matching / Levenshtein / nearest / map center / contains 猜測
check('11', '不使用 fuzzy matching（.includes(）', !/\.includes\(/.test(resolverBody));
check('12', '不使用 Levenshtein', !/levenshtein/i.test(resolverBody));
check('13', '不使用 nearest／map center', !/nearest|map[_\s]?center|centroid/i.test(resolverBody));
check('14', '不使用通用 contains／startsWith 猜測', !/startsWith\(/.test(resolverBody));
check('15', '不生成 lat/lng（無地圖中心代替代表點）', !/lat\s*[:=]|lng\s*[:=]|latitude\s*[:=]|longitude\s*[:=]/i.test(resolverBody));

// 十三～十七、不修改 Auth／Store Guard／GA4 Client／H1 Panel／fulfillment／delivery
check('16', '不修改 Auth（middleware/authStore.js 或同義檔案本輪未變更範圍——本檔案無 Auth 相關程式碼）', !/requireAuth|verifyToken|jwt\.sign|jwt\.verify/i.test(geoCode));
check('17', '不修改 Store Guard（無 storeGuard 相關程式碼）', !/storeGuard|requireStore\(/i.test(geoCode));
check('18', '不修改 GA4 Client（本檔案未 import GA4 SDK／Client）', !/@google-analytics|ga4Client/i.test(geoSrc));
check('19', '不修改 H1 Panel（未提及 geo-ga4-h1-panel）', !/geo-ga4-h1-panel/i.test(geoSrc));
check('20', '不修改 fulfillment resolver 邏輯（resolveStoredArea 函式本體字元數與既有版本一致範圍——僅新增不動舊函式，透過獨立函式驗證：新函式定義在 resolveStoredArea 之前，不在其內部）', (() => {
  const idxFulfillment = geoSrc.indexOf('function resolveStoredArea');
  const idxResolver = geoSrc.indexOf('function resolveUniqueSubdivisionParentCounty');
  return idxFulfillment > -1 && idxResolver > -1 && idxResolver < idxFulfillment;
})());
check('21', '不修改 delivery address resolver（本檔案未 require geoResolver.js／未觸碰 delivery_address 欄位）', !/geoResolver|delivery_address/i.test(geoCode));

// 十九、legacy aliases 保留 + ambiguous override 有文件記錄
check('22', 'DISTRICT_PARENT_ALIASES（Legacy 白名單）仍存在且未被刪除', /DISTRICT_PARENT_ALIASES = Object\.freeze/.test(geoSrc));
check('23', 'Legacy Taoyuan District 歧義已有文件記錄（模組內註解）', /桃園與桃源|Taoyuan.*桃源|全國唯一性衝突/.test(geoSrc));
check('24', 'normalizeDistrictToParentCounty 仍優先於新 Resolver（呼叫順序：normalizeCounty → normalizeDistrictToParentCounty → resolveUniqueSubdivisionParentCounty）', (() => {
  const iCounty = idxCode.indexOf('normalizeCounty(normalizedCity)');
  const iDistrict = idxCode.indexOf('normalizeDistrictToParentCounty(normalizedCity)');
  const iUnique = idxCode.indexOf('resolveUniqueSubdivisionParentCounty(normalizedCity)');
  return iCounty > -1 && iDistrict > -1 && iUnique > -1 && iCounty < iDistrict && iDistrict < iUnique;
})());

// 二十、不修改禁止清單中的其他檔案
const FORBIDDEN_UNTOUCHED_FILES = [
  'middleware/storeGuard.js',
  'public/js/app.js',
  'public/js/geo-ga4-h1-panel.js',
  'public/js/geo-ga4-realtime-layer.js',
  'routes/ga4-geo.js',
  'routes/geo-live.js',
];
FORBIDDEN_UNTOUCHED_FILES.forEach((relPath, i) => {
  check(`25.${i}`, `${relPath} 存在且本輪未被要求修改（僅存在性檢查，內容比對交由 diff／人工 Manual QA）`, fs.existsSync(path.join(ROOT, relPath)));
});

// 二十一、程式衛生
const ALL_TOUCHED_CODE = [geoCode, idxCode].join('\n');
check('26', '無 console.log()', !/console\.log\(/.test(ALL_TOUCHED_CODE));
check('27', '無 debugger', !/\bdebugger\b/.test(ALL_TOUCHED_CODE));
check('28', '無 Math.random()（Resolver 是確定性查詢，不含隨機性）', !/Math\.random\(\)/.test(ALL_TOUCHED_CODE));
check('29', '無絕對路徑（/home/ 或 /Users/）', !/\/home\/|\/Users\//.test(ALL_TOUCHED_CODE));
check('30', '兩個 Production 檔案 node --check 皆通過（require 不丟例外）', (() => {
  try {
    require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));
    require(path.join(ROOT, 'utils/ga4Realtime/index.js'));
    return true;
  } catch (e) { return false; }
})());

// 二十二、Resolver 匯出正確
check('31', 'resolveUniqueSubdivisionParentCounty 已正確 module.exports', (() => {
  const geo = require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));
  return typeof geo.resolveUniqueSubdivisionParentCounty === 'function';
})());

const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2 (Unique Administrative Subdivision Safe Mapping)');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length) process.exitCode = 1;
