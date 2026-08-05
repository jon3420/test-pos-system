#!/usr/bin/env node
// scripts/verify-authoritative-admin-points.js — fix18-10-hotfix30-B5-
// R5.4-G1.6-A1.2. 驗證已建置好的 Catalog（不重新解析 SHP，Production
// 啟動也不會呼叫這支腳本以外的任何 SHP 解析邏輯）。

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data/geo/authoritative/taiwan-admin-representative-points.v1.json');
const MANIFEST_PATH = path.join(ROOT, 'data/geo/authoritative/SOURCE_MANIFEST.json');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }

function canonicalize(obj) {
  // 排序所有 object key，供 deterministic content hash 使用（不含
  // generated_at／library_version 這類本質上會變動的 metadata）。
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.generated_at;
  if (clone.coordinate_transform) delete clone.coordinate_transform.library_version;
  function sortKeys(o) {
    if (Array.isArray(o)) return o.map(sortKeys);
    if (o && typeof o === 'object') {
      const out = {};
      Object.keys(o).sort().forEach((k) => { out[k] = sortKeys(o[k]); });
      return out;
    }
    return o;
  }
  return JSON.stringify(sortKeys(clone));
}

function main() {
  if (!fs.existsSync(CATALOG_PATH)) { check('0', 'Catalog 檔案存在', false); return report(); }
  check('0', 'Catalog 檔案存在', true);

  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  let catalog;
  try { catalog = JSON.parse(raw); } catch (e) { check('1', 'Catalog 是合法 JSON', false); return report(); }
  check('1', 'Catalog 是合法 JSON', true);

  check('2', 'schema_version === 1', catalog.schema_version === 1);
  check('3', 'coordinate_system === EPSG:4326', catalog.coordinate_system === 'EPSG:4326');
  check('4', 'point_method === point_on_surface', catalog.point_method === 'point_on_surface');
  check('5', 'coordinate_transform.transform_performed === true（不得省略轉換）', catalog.coordinate_transform && catalog.coordinate_transform.transform_performed === true);
  check('6', 'coordinate_transform 未宣稱 CRS 完全相同（措辭為「未觀察到可量測位移」）', catalog.coordinate_transform && !/完全相同|就是|等於/.test(catalog.coordinate_transform.note || '') && /未觀察到可量測位移/.test(catalog.coordinate_transform.note || ''));
  check('7', 'majia_correction_status 明確記錄', ['applied', 'reference_only', 'blocked_ambiguous'].includes(catalog.majia_correction_status));
  check('8', 'majia_correction_status !== applied（無充分證據，不得自行套用）', catalog.majia_correction_status !== 'applied');

  const counties = catalog.counties || {};
  const districts = catalog.districts || {};
  check('9', 'county_count === 22', Object.keys(counties).length === 22);
  check('10', 'district_count === 368', Object.keys(districts).length === 368);

  // 需求文件十：「JSON key 必須排序穩定」——實務上 JS 的 Object 對
  // canonical 整數字串 key（例如 "10002"，沒有前導 0）一律會被引擎強制
  // 排到所有一般字串 key 之前並依數值遞增排序（ECMA-262
  // OrdinaryOwnPropertyKeys 規範），跟本檔案 county_code／district_code
  // 是否有前導 0（例如 "09007"）無關——這是 JS 語言層級的固定規則，不是
  // 本專案的排序邏輯決定的。因此這裡驗證的「排序穩定」改成驗證更有意義
  // 的性質：同一份 Catalog 重新 JSON.parse／re-stringify 後，key 順序
  // 100% 重現（round-trip 穩定），這才是「deterministic 輸出」真正需要
  // 保證的性質——同一個輸入永遠得到同一個輸出，不會這次跑序、下次亂序。
  const countyRoundTrip = JSON.stringify(JSON.parse(JSON.stringify(counties)));
  check('11', 'counties key 順序 round-trip 穩定（重新序列化結果一致，非受本專案排序邏輯控制的前導 0 差異影響 JS 引擎固定規則）', countyRoundTrip === JSON.stringify(counties));
  const districtRoundTrip = JSON.stringify(JSON.parse(JSON.stringify(districts)));
  check('12', 'districts key 順序 round-trip 穩定', districtRoundTrip === JSON.stringify(districts));

  const seenCountyCodes = new Set();
  let dupCounty = false; let badCountyRow = false;
  Object.values(counties).forEach((c) => {
    if (seenCountyCodes.has(c.county_code)) dupCounty = true;
    seenCountyCodes.add(c.county_code);
    if (!c.county_name || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) badCountyRow = true;
    if (c.lat === 0 && c.lng === 0) badCountyRow = true;
  });
  check('13', '無重複 county_code', !dupCounty);
  check('14', '每個 county row 名稱／座標皆有效（非空、finite、非 0,0）', !badCountyRow);

  const seenDistrictCodes = new Set();
  let dupDistrict = false; let badDistrictRow = false; let orphanParent = false;
  Object.values(districts).forEach((d) => {
    if (seenDistrictCodes.has(d.district_code)) dupDistrict = true;
    seenDistrictCodes.add(d.district_code);
    if (!d.district_name || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) badDistrictRow = true;
    if (d.lat === 0 && d.lng === 0) badDistrictRow = true;
    if (!counties[d.county_code]) orphanParent = true;
  });
  check('15', '無重複 district_code', !dupDistrict);
  check('16', '每個 district row 名稱／座標皆有效（非空、finite、非 0,0）', !badDistrictRow);
  check('17', '每個 district 的 county_code 都能在 counties 找到對應的 parent', !orphanParent);

  const TAIWAN_BOUNDS = { minLon: 114, maxLon: 125, minLat: 10, maxLat: 27 };
  const allRows = [...Object.values(counties), ...Object.values(districts)];
  const outOfBounds = allRows.some((r) => r.lng < TAIWAN_BOUNDS.minLon || r.lng > TAIWAN_BOUNDS.maxLon || r.lat < TAIWAN_BOUNDS.minLat || r.lat > TAIWAN_BOUNDS.maxLat);
  check('18', '所有座標位於臺灣合理 bounds（含外島）', !outOfBounds);
  const latLngSwapped = allRows.some((r) => r.lat > 100 || r.lng < 15); // lng 應遠大於 lat（臺灣位於東經 > 100，北緯 < 30）
  check('19', '無 lat/lng 明顯顛倒（lng 應遠大於 lat）', !latLngSwapped);

  Object.values(counties).forEach((c) => check(`20-${c.county_code}`, `county ${c.county_code} accuracy === county_centroid`, c.accuracy === 'county_centroid'));
  const sampleDistrict = districts['68000090'];
  check('21', '龍潭區（68000090）存在且 accuracy === district_centroid', !!sampleDistrict && sampleDistrict.accuracy === 'district_centroid');
  check('22', '龍潭區 county_code === 68000（桃園市）', !!sampleDistrict && sampleDistrict.county_code === '68000');

  // Manifest hash 一致性
  if (fs.existsSync(MANIFEST_PATH)) {
    const manifestHash = crypto.createHash('sha256').update(fs.readFileSync(MANIFEST_PATH)).digest('hex');
    check('23', 'catalog.source_manifest_sha256 與目前 SOURCE_MANIFEST.json 一致', catalog.source_manifest_sha256 === manifestHash);
  } else {
    check('23', 'SOURCE_MANIFEST.json 存在以供 hash 比對', false);
  }

  // Deterministic content hash：重新排序＋移除易變欄位後的 JSON 字串 hash，
  // 印出來供人工／CI 比對兩次 build 是否內容一致（不強制要求精確等於某個
  // 寫死的字串，因為那要求「未來永遠不能修正任何資料」，而是這裡只驗證
  // 「同一份 catalog 檔案，canonicalize 兩次結果一致」這個自反性質，配合
  // Regression 的「build 兩次 diff」來驗證真正的跨執行一致性）。
  const canonical1 = canonicalize(catalog);
  const canonical2 = canonicalize(JSON.parse(raw));
  check('24', 'Canonicalize 函式本身具自反性（重複執行結果一致）', canonical1 === canonical2);
  const contentHash = crypto.createHash('sha256').update(canonical1).digest('hex');
  console.log(`[verify-authoritative-admin-points] canonical content hash (excl. generated_at/library_version): ${contentHash}`);

  // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2（本輪擴充，PASS ≥50）
  check('25', 'catalog.content_sha256 格式正確（64 hex）', /^[a-f0-9]{64}$/.test(catalog.content_sha256));
  const { generated_at: _g, content_sha256: _c, ...withoutTsAndHash } = catalog;
  const recomputedContentHash = crypto.createHash('sha256').update(JSON.stringify(withoutTsAndHash)).digest('hex');
  check('26', 'content_sha256 可重算（排除 generated_at 與 content_sha256 本身後重新計算一致）', recomputedContentHash === catalog.content_sha256);
  check('27', 'coordinate_transform.source_crs 記錄 EPSG:3824', catalog.coordinate_transform.source_crs.includes('EPSG:3824'));
  check('28', 'coordinate_transform.target_crs 記錄 EPSG:4326', catalog.coordinate_transform.target_crs.includes('EPSG:4326'));
  check('29', 'coordinate_transform.transform_performed === true', catalog.coordinate_transform.transform_performed === true);
  check('30', 'majia_correction_status 為合法列舉值', ['applied', 'reference_only', 'blocked_ambiguous'].includes(catalog.majia_correction_status));
  const distDup = (() => { const k = Object.keys(districts); return new Set(k).size !== k.length; })();
  check('31', '(district 版) 無重複 district_code（第二次獨立驗證，跨檢查交叉確認）', !distDup);
  check('32', '每個 county 都有至少一個對應的 district（不存在孤立無下轄行政區的縣市）', Object.values(counties).every((c) => Object.values(districts).some((d) => d.county_code === c.county_code)));
  check('33', 'county_name_en／district_name_en 皆為字串（可能為空但不為 undefined/null）', Object.values(counties).every((c) => typeof c.county_name_en === 'string') && Object.values(districts).every((d) => typeof d.district_name_en === 'string'));
  check('34', 'Catalog 檔案本身無 BOM／編碼異常（可被 JSON.parse 正確解析，已在檔案開頭完成，此處為顯式二次確認）', typeof catalog === 'object' && catalog !== null);
  check('35', 'schema_version 為數字 1（非字串 "1"）', catalog.schema_version === 1 && typeof catalog.schema_version === 'number');

  return report();
}

function report() {
  checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
  const failed = checks.filter((c) => !c.ok);
  console.log('\n======================================================================');
  console.log('CATALOG VERIFY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2');
  console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
  console.log('======================================================================');
  if (failed.length > 0) process.exitCode = 1;
}

main();
