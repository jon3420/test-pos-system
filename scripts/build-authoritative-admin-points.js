#!/usr/bin/env node
// scripts/build-authoritative-admin-points.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.2 — Authoritative Administrative
// Representative Points Build Tool.
//
// 一次性 Build Tool（不在正式 Server 啟動時執行，不解析 SHP）。讀取內政部
// 國土測繪中心官方 Shapefile（直轄市、縣市界線 Dataset 7442／鄉鎮市區界線
// Dataset 7441），輸出：
//   data/geo/authoritative/taiwan-admin-representative-points.v1.json
//
// 用法：
//   node scripts/build-authoritative-admin-points.js
//
// 前置條件：
//   data/geo/authoritative/extracted/county/COUNTY_MOI_1140318.{shp,shx,dbf,prj}
//   data/geo/authoritative/extracted/township/TOWN_MOI_1140318.{shp,shx,dbf,prj}
//   data/geo/authoritative/extracted/township/Town_Majia_Sanhe.{shp,shx,dbf,prj}
//     （官方修正檔——瑪家鄉 10013280 的邊界修正版，見
//     data/geo/authoritative/sources/ 內的「修正清單_11403.xlsx」）
//   data/geo/authoritative/SOURCE_MANIFEST.json（記錄來源 SHA-256／CRS／
//     License，本工具會核對 archive_sha256 是否與實際檔案一致，不符就
//     直接 build 失敗）
//
// 使用的正式函式庫（不自己手寫不完整的 SHP Parser／CRS 轉換）：
//   shapefile（mbostock/shapefile）：讀取 .shp/.dbf。
//   proj4：CRS 轉換（TWD97[2020] geographic → WGS84/EPSG:4326）。
//   @turf/turf：pointOnFeature()（point-on-surface，保證落在
//     Polygon/MultiPolygon 內部，不是幾何 bounding-box center）、
//     booleanPointInPolygon()（驗證輸出點真的落在對應幾何內）。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shapefile = require('shapefile');
const proj4 = require('proj4');
const turf = require('@turf/turf');

const ROOT = path.join(__dirname, '..');
const AUTH_DIR = path.join(ROOT, 'data/geo/authoritative');
const EXTRACTED_DIR = path.join(AUTH_DIR, 'extracted');
const OUT_FILE = path.join(AUTH_DIR, 'taiwan-admin-representative-points.v1.json');
const MANIFEST_FILE = path.join(AUTH_DIR, 'SOURCE_MANIFEST.json');

// ── CRS 轉換：TWD97[2020]（GCS_TWD97[2020]，datum D_TWD_1997，
//    ellipsoid GRS_1980）→ EPSG:4326（WGS84）。已在建置時實測驗證
//    （見 R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 第 11
//    節）：GRS80 與 WGS84 橢球參數差異在扁率第六位小數，pyproj／proj4
//    對同一測試點（121.5645, 25.0330）轉換後座標差異為 0（浮點精度內）。
//    不是「看數字大小就假設一樣」，是實際跑過轉換函式庫得到的結果，且
//    這裡仍然明確執行轉換（不是跳過轉換直接複製數字）。
const TWD97_2020_PROJ4 = '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs';
const WGS84_EPSG4326 = 'EPSG:4326';

function log(msg) { console.log(`[build-authoritative-admin-points] ${msg}`); }
function fail(msg) { console.error(`[build-authoritative-admin-points] BUILD FAILED: ${msg}`); process.exit(1); }

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function requireFile(p, label) {
  if (!fs.existsSync(p)) fail(`Missing required file (${label}): ${p}`);
  return p;
}

// ── 驗證 Source Manifest 的 archive_sha256 跟實際來源檔案一致 ──
function verifyManifestHashes(manifest) {
  const sourcesDir = path.join(AUTH_DIR, 'sources');
  manifest.datasets.forEach((d) => {
    const archivePath = path.join(sourcesDir, d.archive_filename);
    requireFile(archivePath, `${d.dataset_id} archive`);
    const actualHash = sha256File(archivePath);
    if (actualHash !== d.archive_sha256) {
      fail(`Dataset ${d.dataset_id} archive SHA-256 mismatch. manifest=${d.archive_sha256} actual=${actualHash}`);
    }
    log(`Dataset ${d.dataset_id} (${d.dataset_name}) archive SHA-256 verified: ${actualHash}`);
  });
}

function toWgs84(lon, lat) {
  const [outLon, outLat] = proj4(TWD97_2020_PROJ4, WGS84_EPSG4326, [lon, lat]);
  return [outLon, outLat];
}

// Taiwan 合理經緯度範圍（含金門／馬祖／東沙／太平島等外島），用於防呆——
// 任何超出這個範圍的輸出點都視為 CRS／經緯度顛倒等錯誤，Build 直接失敗
// （需求文件七：不得輸出 0,0／NaN／Infinity／經緯度顛倒）。
const TAIWAN_BOUNDS = { minLon: 114, maxLon: 125, minLat: 10, maxLat: 27 };
function assertWithinTaiwanBounds(lon, lat, label) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) fail(`${label}: non-finite coordinate (lon=${lon}, lat=${lat})`);
  if (lon === 0 && lat === 0) fail(`${label}: 0,0 coordinate output — refusing (likely CRS/parse failure)`);
  if (lon < TAIWAN_BOUNDS.minLon || lon > TAIWAN_BOUNDS.maxLon || lat < TAIWAN_BOUNDS.minLat || lat > TAIWAN_BOUNDS.maxLat) {
    fail(`${label}: coordinate (${lon}, ${lat}) outside expected Taiwan bounds — refusing (possible lat/lng swap)`);
  }
}

// ── 讀取一個 .shp/.dbf，轉成 GeoJSON features（座標已轉成 WGS84） ──
//
// 重要：shapefile 這個 npm 套件（mbostock/shapefile）預設用
// windows-1252 解 DBF 文字欄位，不會自動讀取 .cpg（codepage）side-car
// 檔案——若不明確指定 encoding，中文縣市／行政區名稱會被錯誤解碼成亂碼
// （已在建置過程中實測發現這個問題，見
// R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 第 9 節）。這裡
// 改成：先讀取對應的 .cpg 檔案取得官方標示的編碼，明確傳入
// `{ encoding }`，不依賴函式庫預設值。
function readCpgEncoding(shpPath) {
  const cpgPath = shpPath.replace(/\.shp$/i, '.CPG');
  const cpgPathLower = shpPath.replace(/\.shp$/i, '.cpg');
  const actualCpgPath = fs.existsSync(cpgPath) ? cpgPath : (fs.existsSync(cpgPathLower) ? cpgPathLower : null);
  if (!actualCpgPath) fail(`Missing .cpg codepage file for ${shpPath} — refusing to guess DBF text encoding`);
  const raw = fs.readFileSync(actualCpgPath, 'utf8').trim();
  return raw;
}

async function readShapefileAsWgs84Features(shpPath) {
  const dbfPath = shpPath.replace(/\.shp$/i, '.dbf');
  requireFile(shpPath, 'shp'); requireFile(dbfPath, 'dbf');
  requireFile(shpPath.replace(/\.shp$/i, '.shx'), 'shx');
  requireFile(shpPath.replace(/\.shp$/i, '.prj'), 'prj');
  const encoding = readCpgEncoding(shpPath);
  log(`  Using DBF text encoding from .cpg: ${encoding}`);

  const source = await shapefile.open(shpPath, dbfPath, { encoding });
  const features = [];
  let result = await source.read();
  while (!result.done) {
    const feature = result.value;
    // 座標轉換：對 geometry 的每一個經緯度點套用 toWgs84()。
    feature.geometry = transformGeometryCoords(feature.geometry);
    features.push(feature);
    result = await source.read();
  }
  return features;
}

function transformGeometryCoords(geometry) {
  function walk(coords, depth) {
    if (depth === 0) {
      const [lon, lat] = coords;
      return toWgs84(lon, lat);
    }
    return coords.map((c) => walk(c, depth - 1));
  }
  const depthByType = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
  const depth = depthByType[geometry.type];
  if (depth === undefined) fail(`Unsupported geometry type: ${geometry.type}`);
  return { type: geometry.type, coordinates: walk(geometry.coordinates, depth) };
}

// ── Representative Point：point-on-surface，保證落在 Polygon/MultiPolygon
//    內部；若幾何 invalid，嘗試安全 repair（buffer(0)），若仍失敗，該
//    feature 不進 Catalog（Build 失敗，不 fallback 到 bounding-box）。
function computeRepresentativePoint(geometry, label) {
  let feature = turf.feature(geometry);
  if (!turf.booleanValid ? true : true) { /* turf 版本可能沒有 booleanValid，用 kinks/area 檢查代替 */ }
  let area;
  try { area = turf.area(feature); } catch (e) { area = 0; }
  if (!Number.isFinite(area) || area <= 0) {
    // 嘗試安全 repair：buffer(0) 是業界常見的簡易修復無效 Polygon 手法
    // （修掉 self-intersection 造成的退化環）。
    try {
      const repaired = turf.buffer(feature, 0);
      if (repaired && turf.area(repaired) > 0) {
        feature = repaired;
        log(`  ${label}: geometry repaired via buffer(0)`);
      } else {
        fail(`${label}: invalid geometry, repair failed (buffer(0) produced empty/zero-area result)`);
      }
    } catch (e) {
      fail(`${label}: invalid geometry, repair failed (${e.message})`);
    }
  }
  const point = turf.pointOnFeature(feature);
  const [lon, lat] = point.geometry.coordinates;
  assertWithinTaiwanBounds(lon, lat, label);
  const inside = turf.booleanPointInPolygon(point, feature);
  if (!inside) fail(`${label}: representative point (${lon}, ${lat}) failed point-in-polygon validation`);
  return { lon, lat };
}

async function main() {
  log('Loading Source Manifest...');
  requireFile(MANIFEST_FILE, 'SOURCE_MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  verifyManifestHashes(manifest);

  const countyShp = path.join(EXTRACTED_DIR, 'county/COUNTY_MOI_1140318.shp');
  const townShp = path.join(EXTRACTED_DIR, 'township/TOWN_MOI_1140318.shp');
  const townMajiaShp = path.join(EXTRACTED_DIR, 'township/Town_Majia_Sanhe.shp');

  log('Reading county shapefile (Dataset 7442)...');
  const countyFeatures = await readShapefileAsWgs84Features(countyShp);
  log(`  ${countyFeatures.length} county features read.`);

  log('Reading township shapefile (Dataset 7441)...');
  const townFeatures = await readShapefileAsWgs84Features(townShp);
  log(`  ${townFeatures.length} township features read.`);

  log('Reading official correction file Town_Majia_Sanhe (見 修正清單_11403.xlsx)...');
  const townMajiaFeatures = await readShapefileAsWgs84Features(townMajiaShp);
  log(`  ${townMajiaFeatures.length} correction feature(s) read.`);

  // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2（需求文件三）：實際讀取
  // 修正清單_11403.xlsx 內容後確認——這份清單記錄的是「新竹縣尖石鄉／
  // 苗栗縣泰安鄉／臺中市和平區」的縣市界＋村里界釐整，以及「臺南市善化區」
  // 的村里界釐整，完全沒有提到瑪家鄉或三和。也就是說，隨附的官方修正清單
  // 不支援、也沒有解釋 Town_Majia_Sanhe.shp 這個補充檔案跟主檔案
  // TOWNCODE=10013280（瑪家鄉）的關係或套用方式。
  //
  // 已用 Shapely 分析兩份幾何的關係（見
  // R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 第 3 節）：
  // intersects=true，intersection 面積 ≈ 主檔面積的 99.9999%，但
  // symmetric_difference 面積 ≈ 主檔面積的 8.6%——兩者明顯不是同一個
  // Polygon，但隨附文件沒有任何文字說明這 8.6% 差異該如何處理
  // （replacement／union／difference+union／reference only 皆無根據）。
  //
  // 依需求文件三的明確指示：修正清單無法明確支持套用方式時，不得自行
  // 合併。因此本 Build Tool 刻意「不」用 Town_Majia_Sanhe 覆蓋主檔案的
  // 瑪家鄉幾何——Catalog 完全只用主檔案 TOWN_MOI_1140318.shp 計算
  // Representative Point，Town_Majia_Sanhe 讀入僅供記錄／未來核對用，
  // 不影響任何輸出。
  const MAJIA_CORRECTION_STATUS = 'reference_only'; // 'applied' | 'reference_only' | 'blocked_ambiguous'
  log(`  Majia/Sanhe correction file status: ${MAJIA_CORRECTION_STATUS} (未套用，見上方註記；主檔案瑪家鄉幾何原樣使用)`);

  const mergedTownFeatures = townFeatures; // 刻意不合併修正檔（見上方說明）

  // ── Counties ──
  const seenCountyCodes = new Set();
  const counties = {};
  countyFeatures.forEach((f) => {
    const p = f.properties;
    const code = String(p.COUNTYCODE || '').trim();
    const name = String(p.COUNTYNAME || '').trim();
    if (!code) fail(`County feature missing COUNTYCODE (name=${name})`);
    if (!name) fail(`County feature missing COUNTYNAME (code=${code})`);
    if (seenCountyCodes.has(code)) fail(`Duplicate COUNTYCODE: ${code}`);
    seenCountyCodes.add(code);
    const { lon, lat } = computeRepresentativePoint(f.geometry, `county ${code} ${name}`);
    counties[code] = {
      county_code: code,
      county_name: name,
      county_name_en: String(p.COUNTYENG || '').trim(),
      lat, lng: lon,
      source: 'nlsc_official_boundary',
      accuracy: 'county_centroid',
      point_method: 'point_on_surface',
    };
  });

  // ── Districts (townships) ──
  const seenTownCodes = new Set();
  const districts = {};
  mergedTownFeatures.forEach((f) => {
    const p = f.properties;
    const code = String(p.TOWNCODE || '').trim();
    const name = String(p.TOWNNAME || '').trim();
    const countyCode = String(p.COUNTYCODE || '').trim();
    if (!code) fail(`Township feature missing TOWNCODE (name=${name})`);
    if (!name) fail(`Township feature missing TOWNNAME (code=${code})`);
    if (!countyCode) fail(`Township feature missing COUNTYCODE (code=${code})`);
    if (seenTownCodes.has(code)) fail(`Duplicate TOWNCODE: ${code}`);
    seenTownCodes.add(code);
    if (!counties[countyCode]) fail(`Township ${code} (${name}) references non-existent parent county_code ${countyCode}`);
    const { lon, lat } = computeRepresentativePoint(f.geometry, `district ${code} ${name}`);
    districts[code] = {
      district_code: code,
      district_name: name,
      district_name_en: String(p.TOWNENG || '').trim(),
      county_code: countyCode,
      county_name: String(p.COUNTYNAME || '').trim(),
      lat, lng: lon,
      source: 'nlsc_official_boundary',
      accuracy: 'district_centroid',
      point_method: 'point_on_surface',
    };
  });

  // ── Deterministic 輸出：key 排序穩定 ──
  //
  // 注意（實測發現，記錄供未來維護者參考）：ECMAScript 規格規定物件的
  // 「整數樣式 key」（不含前導零的非負整數字串，例如 "68000"）一律強制
  // 用數值遞增順序列舉，不受插入順序或這裡呼叫 .sort() 影響；只有「非
  // 整數樣式 key」（例如帶前導零的 "09007"／"09020"，金門縣／連江縣）
  // 才會照這裡指定的順序排在後面。這裡的 .sort() 對非整數樣式 key 仍然
  // 有效、也仍然重要（保證那些 key 之間彼此順序穩定），但整體輸出不是
  // 單純字母排序——這不影響 Determinism（同一份輸入每次 build 出來的
  // 順序仍然完全一致，見 scripts/verify-authoritative-admin-points.js／
  // R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 的實測記錄）。
  function sortedObject(obj) {
    const out = {};
    Object.keys(obj).sort().forEach((k) => { out[k] = obj[k]; });
    return out;
  }

  const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(MANIFEST_FILE)).digest('hex');
  const catalog = {
    schema_version: 1,
    source_manifest_sha256: manifestSha256,
    generated_at: new Date().toISOString(),
    coordinate_system: 'EPSG:4326',
    coordinate_transform: {
      source_crs: 'EPSG:3824 (GCS_TWD97[2020], datum D_TWD_1997, ellipsoid GRS_1980)',
      target_crs: 'EPSG:4326 (WGS84)',
      library: 'proj4',
      library_version: require('proj4/package.json').version,
      transform_performed: true,
      note: '依目前使用的 CRS 定義與轉換函式庫，抽樣轉換結果未觀察到可量測位移（詳見 R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 第 11 節）；轉換仍確實執行，不是省略。',
    },
    point_method: 'point_on_surface',
    majia_correction_status: MAJIA_CORRECTION_STATUS,
    counties: sortedObject(counties),
    districts: sortedObject(districts),
  };
  // content_sha256：對「不含 generated_at 建置時間戳」的核心內容算 hash，
  // 供 Determinism 驗證（scripts/verify-authoritative-admin-points.js）
  // 使用——同一組官方來源、同一份程式碼，無論何時執行 Build，這個值必須
  // 完全相同（已實測驗證：兩次獨立執行 Build，本欄位輸出逐字相同，見
  // R5.4-G1.6-A1.2_AUTHORITATIVE_SOURCE_REALITY_AUDIT.md 第 5 節）。
  const { generated_at: _omit, ...catalogWithoutTimestamp } = catalog;
  catalog.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(catalogWithoutTimestamp)).digest('hex');

  const json = JSON.stringify(catalog, null, 2);
  fs.writeFileSync(OUT_FILE, json + '\n');
  const catalogSha256 = crypto.createHash('sha256').update(fs.readFileSync(OUT_FILE)).digest('hex');
  log(`Catalog written: ${OUT_FILE}`);
  log(`  counties: ${Object.keys(counties).length}`);
  log(`  districts: ${Object.keys(districts).length}`);
  log(`  catalog SHA-256: ${catalogSha256}`);
  log('Build complete.');
}

main().catch((e) => { console.error(e); fail(e.message); });
