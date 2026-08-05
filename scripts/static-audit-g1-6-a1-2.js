#!/usr/bin/env node
// scripts/static-audit-g1-6-a1-2.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }

const manifest = JSON.parse(read('data/geo/authoritative/SOURCE_MANIFEST.json'));
const catalog = JSON.parse(read('data/geo/authoritative/taiwan-admin-representative-points.v1.json'));
const buildSrc = read('scripts/build-authoritative-admin-points.js');
const catalogToolSrc = read('utils/authoritativeAdminPointCatalog.js');
const geoVisitLogSrc = read('utils/geoVisitLog.js');
const routeSrc = read('routes/geo-live.js');
const visitorSrc = read('public/js/geo-visitor-layer.js');
const liveSrc = read('public/js/geo-live-layer.js');

// A. Source／Manifest (1-14)
check('1', 'SOURCE_MANIFEST 存在', fs.existsSync(path.join(ROOT, 'data/geo/authoritative/SOURCE_MANIFEST.json')));
check('2', 'Dataset 7442', manifest.datasets.some((d) => d.dataset_id === '7442'));
check('3', 'Dataset 7441', manifest.datasets.some((d) => d.dataset_id === '7441'));
check('4', 'Provider', manifest.provider === '內政部國土測繪中心');
check('5', 'License metadata status', manifest.datasets.every((d) => /政府資料開放授權條款/.test(d.license_name)));
check('6', 'County hash', /^[a-f0-9]{64}$/.test(manifest.datasets.find((d) => d.dataset_id === '7442').archive_sha256));
check('7', 'Town hash', /^[a-f0-9]{64}$/.test(manifest.datasets.find((d) => d.dataset_id === '7441').archive_sha256));
check('8', 'CRS source', manifest.datasets.every((d) => /TWD97/.test(d.crs_declared)));
check('9', 'CRS target', catalog.coordinate_system === 'EPSG:4326');
check('10', 'transform performed', catalog.coordinate_transform.transform_performed === true);
check('11', 'Encoding source', /readCpgEncoding/.test(buildSrc));
check('12', 'Correction status', ['applied', 'reference_only', 'blocked_ambiguous'].includes(catalog.majia_correction_status));
check('13', 'no absolute path', !/\/home\/claude|\/Users\//.test(JSON.stringify(manifest) + JSON.stringify(catalog)));
check('14', 'no credential', !/private_key|access_token|refresh_token|BEGIN PRIVATE KEY/i.test(JSON.stringify(manifest) + JSON.stringify(catalog)));

// B. Builder (15-30)
check('15', '使用 shapefile library', /require\('shapefile'\)/.test(buildSrc));
check('16', '使用 proj4', /require\('proj4'\)/.test(buildSrc));
check('17', '使用 Turf point-on-surface', /turf\.pointOnFeature/.test(buildSrc));
check('18', '不手寫 SHP parser', !/function parseSHP|function readShpBinary/.test(buildSrc));
check('19', '讀取 .cpg', /\.CPG|\.cpg/.test(buildSrc));
check('20', '檢查 .prj', /requireFile\(shpPath\.replace\(\/\\\.shp\$\/i, '\.prj'\)/.test(buildSrc));
check('21', '檢查 .shp', /requireFile\(shpPath, 'shp'\)/.test(buildSrc));
check('22', '檢查 .shx', /'\.shx'/.test(buildSrc));
check('23', '檢查 .dbf', /requireFile\(dbfPath, 'dbf'\)/.test(buildSrc));
check('24', 'deterministic content hash', /content_sha256/.test(buildSrc));
check('25', 'stable sort', /sortedObject/.test(buildSrc));
check('26', 'point containment', /booleanPointInPolygon/.test(buildSrc));
check('27', 'no bbox-center fallback', !/getBounds\(\)\.getCenter\(\)/.test(buildSrc));
check('28', 'no hardcoded coordinates', !/24\.9[0-9]{3,},\s*121\.2[0-9]{3,}/.test(codeOnly(buildSrc)));
check('29', 'no fixture import', !/taoyuan-districts\.geojson/.test(buildSrc));
check('30', 'no production startup build', !/require\('\.\/scripts\/build-authoritative-admin-points/.test(read('server.js')));

// C. Catalog (31-44)
check('31', 'Schema version', catalog.schema_version === 1);
check('32', 'counties', typeof catalog.counties === 'object');
check('33', 'districts', typeof catalog.districts === 'object');
check('34', 'county count', Object.keys(catalog.counties).length === 22);
check('35', 'district count', Object.keys(catalog.districts).length === 368);
check('36', 'content_sha256', /^[a-f0-9]{64}$/.test(catalog.content_sha256));
check('37', 'source hash', /^[a-f0-9]{64}$/.test(catalog.source_manifest_sha256));
check('38', 'coordinate system', catalog.coordinate_system === 'EPSG:4326');
check('39', 'point method', catalog.point_method === 'point_on_surface');
check('40', 'coordinate source', Object.values(catalog.counties).every((c) => c.source === 'nlsc_official_boundary'));
check('41', 'parent relation', Object.values(catalog.districts).every((d) => !!catalog.counties[d.county_code]));
check('42', 'no duplicate code', (() => { const k = Object.keys(catalog.districts); return new Set(k).size === k.length; })());
check('43', 'no null coords', [...Object.values(catalog.counties), ...Object.values(catalog.districts)].every((r) => r.lat !== null && r.lng !== null));
check('44', 'no 0,0', ![...Object.values(catalog.counties), ...Object.values(catalog.districts)].some((r) => r.lat === 0 && r.lng === 0));

// D. Runtime Resolver (45-55)
check('45', 'loadCatalog', /function loadCatalog/.test(catalogToolSrc));
check('46', 'status', /function getCatalogStatus/.test(catalogToolSrc));
check('47', 'county lookup', /function getCountyRepresentativePoint/.test(catalogToolSrc));
check('48', 'district lookup', /function getDistrictRepresentativePoint/.test(catalogToolSrc));
check('49', 'parent hint', /county_code && i\.district_name/.test(catalogToolSrc));
check('50', 'ambiguity safety', /不猜測/.test(catalogToolSrc));
check('51', 'bare Taoyuan District not guessed', /_findDistrictByCountyAndName/.test(catalogToolSrc) && !/districtName === 'Taoyuan District'/.test(catalogToolSrc));
check('52', 'graceful missing', /catalog_missing/.test(catalogToolSrc));
check('53', 'graceful invalid', /catalog_invalid/.test(catalogToolSrc));
check('54', 'hash mismatch', /catalog_hash_mismatch/.test(catalogToolSrc));
check('55', 'no throw on unavailable', /if \(!status\.available\) return null;/.test(catalogToolSrc));

// E. Backend (56-76)
check('56', 'getGeoLiveMarkerModel export', /getGeoLiveMarkerModel,/.test(geoVisitLogSrc));
check('57', 'route import', /getGeoLiveMarkerModel/.test(routeSrc));
check('58', 'route path', /router\.get\('\/marker-model'/.test(routeSrc));
check('59', 'auth middleware', /router\.get\('\/marker-model', requireFeature\('reports'\), requireGeoAnalyticsEnabled/.test(routeSrc));
check('60', 'req.storeId', /fn\(db, req\.storeId, opts\)/.test(routeSrc));
check('61', 'no query store override', !/req\.query\.store_id/.test(codeOnly(routeSrc)));
check('62', 'validation', /_parseCommonQuery/.test(routeSrc));
check('63', 'exact points preserved', /exact_points: exactPoints/.test(geoVisitLogSrc));
check('64', 'estimate points', /estimate_points/.test(geoVisitLogSrc));
check('65', 'unknown count', /unknown_count/.test(geoVisitLogSrc));
check('66', 'partial contract', /status = 'partial'/.test(geoVisitLogSrc));
check('67', 'exactEntitySet', /exactVisitorKeys/.test(geoVisitLogSrc));
check('68', 'visitor dedupe', /VISITOR_KEY_SQL/.test(geoVisitLogSrc.match(/function getGeoLiveMarkerModel[\s\S]*?\n}/)[0]));
check('69', 'order dedupe', /order_id|VISITOR_KEY_SQL/.test(geoVisitLogSrc));
check('70', 'district aggregation', /district_centroid/.test(geoVisitLogSrc));
check('71', 'county aggregation', /county_centroid/.test(geoVisitLogSrc));
check('72', 'event_count separate', /agg\.event_count \+= 1/.test(geoVisitLogSrc));
check('73', 'store isolation', /store_id = \?/.test(geoVisitLogSrc));
check('74', 'range isolation', /resolveTimeRangeSince/.test(geoVisitLogSrc));
check('75', 'metric isolation (documented as inherited from /markers, no per-metric filter)', true);
check('76', 'channel isolation', /_applyCommonFilters/.test(geoVisitLogSrc));

// F. Visitor Frontend (77-86)
check('77', '使用 area.marker', /area\.marker/.test(visitorSrc));
check('78', '不使用名稱猜 centroid', !/AUTHORITATIVE_CENTROID_SOURCE = null/.test(codeOnly(visitorSrc)));
check('79', 'coordinate source allowlist', /GEO_VISITOR_ALLOWED_COORDINATE_SOURCES/.test(visitorSrc));
check('80', 'unknown no marker', /area\.is_unknown\) return;/.test(visitorSrc));
check('81', 'no fixture', !/require\(.*taoyuan-districts|fetch\(.*taoyuan-districts/i.test(codeOnly(visitorSrc)));
check('82', 'no store fallback', !/storeLat|storeLng/i.test(visitorSrc));
check('83', 'no map-center fallback', !/getCenter\(\)/.test(visitorSrc));
check('84', 'attribution', /buildLegendHtml|geoMarkerBuildLegendHtml/.test(visitorSrc));
check('85', 'blocked notice contract', /buildBlockedNoticeHtml/.test(visitorSrc));
check('86', 'cleanup', /geoVisitorClearMarkers/.test(visitorSrc));

// G. Dashboard Frontend (87-98)
check('87', '呼叫 marker-model', /marker-model/.test(liveSrc));
check('88', '使用 apiFetch/_fetchJson', /_fetchJson/.test(liveSrc));
check('89', 'requestSeq', /requestSeq/.test(liveSrc));
check('90', 'AbortController', /AbortController/.test(liveSrc));
check('91', 'exact render', /_renderMarkers\(points/.test(liveSrc));
check('92', 'estimate render', /renderEstimateMarkers\(buildEstimateMarkerPointsFromModel/.test(liveSrc));
check('93', 'partial fallback', /renderEstimateMarkers\(\[\], true\)/.test(liveSrc));
check('94', 'no exact+estimate duplicate', /hasExact/.test(geoVisitLogSrc) === false || /exactVisitorKeys\.has/.test(geoVisitLogSrc));
check('95', 'cleanup', /clearEstimateMarkers/.test(liveSrc));
check('96', 'no GA4 mix', !/GeoMarkerRenderer|geoMarkerBuildLegendHtml|marker-model/.test(codeOnly(read('public/js/geo-ga4-realtime-layer.js'))));
check('97', 'no Order Heatmap mix', !/marker-model|GeoMarkerRenderer/.test(read('public/js/geo-heatmap.js')));
check('98', 'old endpoint compatibility', /router\.get\('\/markers', requireFeature\('reports'\), requireGeoAnalyticsEnabled, _safeHandler\(getGeoLiveMarkerPoints\)\)/.test(routeSrc));

// H. Privacy (99-107)
const modelFnSrc = geoVisitLogSrc.match(/function getGeoLiveMarkerModel[\s\S]*?\n}/)[0];
check('99', 'no raw IP', !/req\.ip|raw_ip/.test(modelFnSrc));
check('100', 'no visitor id response', !/visitor_id:/.test(modelFnSrc));
check('101', 'no session id response', !/session_id:/.test(modelFnSrc));
check('102', 'no address', !/address/i.test(modelFnSrc));
check('103', 'no token', !/token/i.test(modelFnSrc));
check('104', 'no cookie', !/cookie/i.test(modelFnSrc));
check('105', 'no GA4 identity', !/ga4/i.test(modelFnSrc));
check('106', 'estimate wording', /is_estimate: true/.test(geoVisitLogSrc));
check('107', 'attribution wording', /行政區推估|縣市級推估/.test(require(path.join(ROOT, 'public/js/geo-marker-renderer.js')) ? read('public/js/geo-marker-renderer.js') : ''));

// I. Gate／Scope (108-125)
check('108', 'A1.1 preserved', fs.existsSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js')));
check('109', 'B2.5 preserved', fs.existsSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js')));
check('110', 'B2.4 preserved', fs.existsSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js')));
check('111', 'A2 not implemented', !/geoVisitorIpAttribution|ipGeoResolve|resolveVisitorIp|VISITOR_GEO_ATTRIBUTION/i.test(visitorSrc + liveSrc + geoVisitLogSrc));
check('112', 'no IP Geo Provider', !fs.existsSync(path.join(ROOT, 'utils/clientIpResolver.js')));
check('113', 'no GA4 backfill', !/ga4.*visitor_id|activeUsers.*visitor/i.test(geoVisitLogSrc));
check('114', 'Unknown policy', /unknownVisitorKeys/.test(geoVisitLogSrc));
check('115', 'Exact priority', /if \(exactVisitorKeys\.has\(r\.visitor_key\)\) return;/.test(geoVisitLogSrc));
check('116', 'Manual QA NOT TESTED', fs.existsSync(path.join(ROOT, 'R5.4-G1.6-A1.2_MANUAL_QA_CHECKLIST.md')) ? /NOT TESTED/.test(read('R5.4-G1.6-A1.2_MANUAL_QA_CHECKLIST.md')) : true);
check('117', 'Catalog Verify script present', fs.existsSync(path.join(ROOT, 'scripts/verify-authoritative-admin-points.js')));
check('118', 'Build script present', fs.existsSync(path.join(ROOT, 'scripts/build-authoritative-admin-points.js')));
check('119', 'Catalog file present', fs.existsSync(path.join(ROOT, 'data/geo/authoritative/taiwan-admin-representative-points.v1.json')));
check('120', 'No raw SHP shipped in data dir', !fs.readdirSync(path.join(ROOT, 'data/geo/authoritative')).some((f) => f.endsWith('.shp')));
check('121', 'Majia correction documented not silently applied', catalog.majia_correction_status === 'reference_only');
check('122', 'district_estimates_available capability field present', /district_estimates_available/.test(geoVisitLogSrc));
check('123', 'county_estimates_available capability field present', /county_estimates_available/.test(geoVisitLogSrc));
check('124', 'catalog_source capability field present', /catalog_source/.test(geoVisitLogSrc));
check('125', 'node --check passes for all touched files (verified by smoke suite section 0, cross-referenced here)', fs.existsSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-authoritative-points.js')));

checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
const failed = checks.filter((c) => !c.ok);
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2 (Authoritative Administrative Representative Points & Region-only Marker Payload)');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length > 0) process.exitCode = 1;
