// utils/authoritativeAdminPointCatalog.js — fix18-10-hotfix30-B5-R5.4-
// G1.6-A1.2 — Authoritative Administrative Representative Points Runtime
// Resolver.
//
// 讀取 scripts/build-authoritative-admin-points.js 產出的離線 Catalog
// （data/geo/authoritative/taiwan-admin-representative-points.v1.json），
// 供 Estimate Marker（district_centroid／county_centroid）查表使用。
//
// 邊界（不得違反）：
//   - 完全不解析 SHP／不做任何幾何運算——那是一次性 Build Tool 的職責。
//   - Catalog 載入失敗（檔案不存在／JSON 壞掉／schema 不支援／hash 不符）
//     時，安全降級為 unavailable：Server 仍可啟動，Exact Marker 不受
//     影響，Estimate Marker 停用，不回 500。
//   - 模糊名稱（Hsinchu／Chiayi／Taoyuan District 不帶 county_code）不得
//     猜測——輸入優先順序見 resolveAdministrativeRepresentativePoint()。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG_PATH = path.join(__dirname, '..', 'data/geo/authoritative/taiwan-admin-representative-points.v1.json');
const MANIFEST_PATH = path.join(__dirname, '..', 'data/geo/authoritative/SOURCE_MANIFEST.json');

let _cache = null; // { catalog, status } | null（尚未載入過）

function _safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function _sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; }
}

function _validateCatalogShape(catalog) {
  if (!catalog || typeof catalog !== 'object') return 'catalog_invalid';
  if (catalog.schema_version !== 1) return 'catalog_schema_unsupported';
  if (!catalog.counties || typeof catalog.counties !== 'object') return 'catalog_invalid';
  if (!catalog.districts || typeof catalog.districts !== 'object') return 'catalog_invalid';
  if (catalog.coordinate_system !== 'EPSG:4326') return 'catalog_invalid';
  // 抽樣驗證座標為有限數（不做全量幾何驗證，那是 Build Tool 的職責，這裡
  // 只防禦「檔案被手動改壞」的情況）。
  const sampleCounties = Object.values(catalog.counties).slice(0, 5);
  const sampleDistricts = Object.values(catalog.districts).slice(0, 5);
  const badCoord = [...sampleCounties, ...sampleDistricts].some((row) => !Number.isFinite(row.lat) || !Number.isFinite(row.lng));
  if (badCoord) return 'catalog_coordinate_invalid';
  return null;
}

// _loadCatalog() — 惰性載入 + cache（供同一 process 內重複呼叫，不用每次
// 都重新讀檔／重新驗證）。
function _loadCatalog() {
  if (_cache) return _cache;

  if (!fs.existsSync(CATALOG_PATH)) {
    _cache = { catalog: null, status: _buildStatus(false, null, 'catalog_missing') };
    return _cache;
  }
  const catalog = _safeReadJson(CATALOG_PATH);
  if (!catalog) {
    _cache = { catalog: null, status: _buildStatus(false, null, 'catalog_invalid') };
    return _cache;
  }
  const shapeError = _validateCatalogShape(catalog);
  if (shapeError) {
    _cache = { catalog: null, status: _buildStatus(false, catalog, shapeError) };
    return _cache;
  }

  // Manifest hash 交叉驗證（若 Manifest 存在）：確保 Catalog 宣稱的
  // source_manifest_sha256 跟目前 SOURCE_MANIFEST.json 實際內容一致，
  // 避免 Catalog 與來源記錄互相矛盾卻被當成一致使用。
  let hashError = null;
  const manifestHash = _sha256File(MANIFEST_PATH);
  if (manifestHash && catalog.source_manifest_sha256 && manifestHash !== catalog.source_manifest_sha256) {
    hashError = 'catalog_hash_mismatch';
  }
  if (hashError) {
    _cache = { catalog: null, status: _buildStatus(false, catalog, hashError) };
    return _cache;
  }

  _cache = { catalog, status: _buildStatus(true, catalog, null) };
  return _cache;
}

function _buildStatus(available, catalog, errorCode) {
  return {
    available: !!available,
    schema_version: catalog ? catalog.schema_version : null,
    source: available ? 'nlsc_official_boundary' : null,
    county_count: catalog ? Object.keys(catalog.counties || {}).length : 0,
    district_count: catalog ? Object.keys(catalog.districts || {}).length : 0,
    generated_at: catalog ? catalog.generated_at : null,
    source_manifest_sha256: catalog ? catalog.source_manifest_sha256 : null,
    catalog_sha256: available ? _sha256File(CATALOG_PATH) : null,
    error_code: errorCode || null,
  };
}

// resetForTest()：供測試強制重新載入（例如切換不同 catalog fixture）。
function resetForTest() { _cache = null; }

function loadCatalog() {
  const { catalog } = _loadCatalog();
  return catalog;
}

function getCatalogStatus() {
  const { status } = _loadCatalog();
  return status;
}

function getCountyRepresentativePoint(countyCode) {
  const { catalog } = _loadCatalog();
  if (!catalog || !countyCode) return null;
  const row = catalog.counties[String(countyCode)];
  return row || null;
}

function getDistrictRepresentativePoint(districtCode) {
  const { catalog } = _loadCatalog();
  if (!catalog || !districtCode) return null;
  const row = catalog.districts[String(districtCode)];
  return row || null;
}

// _findDistrictByCountyAndName(countyCode, districtName) — 只在「已知
// county_code + 行政區中文名稱」的情況下查表，不對裸名稱做全國模糊比對
// （見需求文件十一：Hsinchu／Chiayi／Taoyuan District 沒有 county_code
// 時不得猜）。
function _findDistrictByCountyAndName(countyCode, districtName) {
  const { catalog } = _loadCatalog();
  if (!catalog || !countyCode || !districtName) return null;
  const name = String(districtName).trim();
  const match = Object.values(catalog.districts).find((d) => d.county_code === String(countyCode) && d.district_name === name);
  return match || null;
}

function _findCountyByName(countyName) {
  const { catalog } = _loadCatalog();
  if (!catalog || !countyName) return null;
  const name = String(countyName).trim();
  const match = Object.values(catalog.counties).find((c) => c.county_name === name || c.county_name_en === name);
  return match || null;
}

// resolveAdministrativeRepresentativePoint(input) → row | null
//
// input: { district_code, county_code, district_name, county_name }
//
// 輸入優先順序（需求文件十一）：
//   1. district_code（最明確，直接查表）
//   2. county_code + district_name（用 county 範圍內查中文名稱，避免
//      「Taoyuan District」這種全國跨縣市同名英文字串的歧義——因為這裡
//      一定要求先有 county_code 才查 district_name，不是拿裸英文字串
//      去查全國唯一性）
//   3. county_code（只查縣市層級代表點）
//   4. county_name（canonical 縣市中文/英文全名）
//   5. 以上都沒有 → 回 null（unknown，不得猜測）
function resolveAdministrativeRepresentativePoint(input) {
  const { status } = _loadCatalog();
  if (!status.available) return null;
  const i = input || {};

  if (i.district_code) {
    const row = getDistrictRepresentativePoint(i.district_code);
    if (row) return row;
  }
  if (i.county_code && i.district_name) {
    const row = _findDistrictByCountyAndName(i.county_code, i.district_name);
    if (row) return row;
  }
  if (i.county_code) {
    const row = getCountyRepresentativePoint(i.county_code);
    if (row) return row;
  }
  if (i.county_name) {
    const row = _findCountyByName(i.county_name);
    if (row) return row;
  }
  return null; // unknown，不猜測
}

module.exports = {
  loadCatalog,
  getCatalogStatus,
  getCountyRepresentativePoint,
  getDistrictRepresentativePoint,
  resolveAdministrativeRepresentativePoint,
  resetForTest,
};
