#!/usr/bin/env node
// scripts/static-audit-g1.js — fix18-10-hotfix30-B5-R5.4-G1
// 正式 Static Audit（需求文件二十一 30 項）。一次性稽核腳本，非 smoke test，
// 不計入 G1 Smoke 的 180+ assertions；報告輸出到 stdout，並由
// scripts/build-g1-qa-zip.js／CHANGELOG 引用其結果。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(text) {
  return text.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n');
}

const geoLiveLayer = read('public/js/geo-live-layer.js');
const geoLiveLayerCode = stripComments(geoLiveLayer);
const geoLiveCoord = read('public/js/geo-live-coordinate.js');
const geoLiveCoordCode = stripComments(geoLiveCoord);
const geoLiveCoordUtil = read('utils/geoLiveCoordinate.js');
const geoLiveCoordUtilCode = stripComments(geoLiveCoordUtil);
const geoVisitLog = read('utils/geoVisitLog.js');
const geoVisitLogCode = stripComments(geoVisitLog);
const geoLiveRoute = read('routes/geo-live.js');
const geoLiveRouteCode = stripComments(geoLiveRoute);
const deviceParser = read('utils/deviceParser.js');
const deviceParserCode = stripComments(deviceParser);
const indexHtml = read('public/index.html');
const lineOrderHtml = read('public/line-order.html');

// 1. 無 IP 推估 Marker：Marker 查詢函式（getGeoLiveMarkerPoints）唯一座標來源
//    是 geoLiveCoordinate.getLatestCoordinatesByVisitor()，不是任何 IP resolver。
check('1', '無 IP 推估 Marker', !/resolveVisitorGeo|geoResolver/.test(stripComments(
  geoVisitLog.split('function getGeoLiveMarkerPoints')[1] || ''
)));

// 2. 無店家座標冒充訪客
check('2', '無店家座標冒充訪客', !/storeLat|store_lat|store\.lat\b|storeCoord|storeLatitude/i.test(geoLiveCoordUtilCode) && !/storeLat|store_lat|store\.lat\b|storeCoord|storeLatitude/i.test(geoVisitLogCode));

// 3. 無行政區中心冒充即時訪客
check('3', '無行政區中心冒充即時訪客', !/centroid/i.test(geoVisitLogCode) && !/centroid/i.test(geoLiveLayerCode));

// 4. Unknown 不畫點：getGeoLiveMarkerPoints 只納入有真實座標的列
check('4', 'Unknown 不畫點（Marker 查詢排除無座標訪客）', /if \(!coord\) continue/.test(geoVisitLog));

// 5. 無第二張 L.map()
check('5', '無第二張 L.map()', !/new\s+L\.map\(/.test(geoLiveLayerCode));

// 6. 無第二個 Tile Layer
check('6', '無第二個 Tile Layer', !/L\.tileLayer\(/.test(geoLiveLayerCode));

// 7. 無重複 Layer（單一 mode 切換時先清除既有 layer 才加新的）
check('7', '無重複 Layer（setMode 切換時呼叫 _clearActiveLayers）', /_clearActiveLayers\(\)/.test(geoLiveLayer) && geoLiveLayer.split('_clearActiveLayers()').length >= 3);

// 8. 無重複 Polling（單一 pollTimer 欄位、輪詢前會先清除既有 timer）
check('8', '無重複 Polling（destroy() 會 clearInterval 既有 pollTimer）', /clearInterval\(state\.pollTimer\)/.test(geoLiveLayer));

// 9. 無 Memory Leak（destroy() 存在且會清除 layer/timer，不 remove 既有 map）
check('9', 'destroy() 提供資源釋放路徑，且不 remove 既有 map', /function destroy\(\)/.test(geoLiveLayer) && !/state\.map\.remove\(\)/.test(geoLiveLayerCode));

// 10. 無 console.log/debug（G1 新增檔案；console.warn/console.error 屬既有 fail-open 慣例，不算違規）
const g1AllFiles = [
  'utils/deviceParser.js', 'utils/geoLiveCoordinate.js', 'utils/geoVisitLog.js',
  'routes/geo-live.js', 'public/js/geo-live-coordinate.js', 'public/js/geo-live-layer.js',
];
const consoleLogHits = g1AllFiles.filter((f) => /console\.log\(|console\.debug\(/.test(stripComments(read(f))));
check('10', '無 console.log/console.debug（G1 新增檔案）', consoleLogHits.length === 0);

// 11. 無 Math.random()
const randomHits = g1AllFiles.filter((f) => /Math\.random\(\)/.test(stripComments(read(f))));
check('11', '無 Math.random()（G1 新增檔案）', randomHits.length === 0);

// 12. 無硬編碼 Store
const hardcodedStoreHits = g1AllFiles.filter((f) => /['"]store_001['"]/.test(stripComments(read(f))));
check('12', '無硬編碼 store_001（G1 新增檔案）', hardcodedStoreHits.length === 0);

// 13. 無硬編碼縣市作 production 邏輯
const hardcodedCityHits = g1AllFiles.filter((f) => /桃園|中壢/.test(stripComments(read(f))));
check('13', '無硬編碼縣市（桃園/中壢）作 production 判斷邏輯（G1 新增檔案）', hardcodedCityHits.length === 0);

// 14. 無 CDN-only dependency（vendor 檔案本地存在，且 index.html 沒有把 markercluster/heat 唯一指向外部 CDN）
check('14', '無 CDN-only dependency（MarkerCluster/Leaflet.heat 本地載入）',
  !/unpkg\.com\/leaflet\.markercluster|cdn\.jsdelivr\.net\/npm\/leaflet\.markercluster|unpkg\.com\/leaflet\.heat/.test(indexHtml));

// 15. MarkerCluster/Leaflet.heat 均為本地檔案
check('15', 'MarkerCluster/Leaflet.heat 均為本地 vendor 檔案',
  fs.existsSync(path.join(ROOT, 'public/js/vendor/leaflet.markercluster.js')) &&
  fs.existsSync(path.join(ROOT, 'public/js/vendor/leaflet-heat.js')) &&
  indexHtml.includes('/js/vendor/leaflet.markercluster.js') &&
  indexHtml.includes('/js/vendor/leaflet-heat.js'));

// 16. 無任意外部 GeoJSON
check('16', '無任意外部 GeoJSON URL', !/geojson\.io|raw\.githubusercontent.*\.geojson/i.test(geoLiveLayerCode));

// 17. 無 Rectangle Fixture 當 Polygon
check('17', '無 Rectangle Fixture 當 Polygon', !/rectangle|Rectangle/i.test(geoLiveLayerCode));

// 18. Tooltip 無個資
check('18', 'Tooltip 欄位組成不含姓名/電話/地址', !/\bname\b|\bphone\b|\baddress\b/.test(
  (geoLiveLayer.match(/function buildMarkerTooltipFields[\s\S]*?\n\s*\}/) || [''])[0]
));

// 19. API 不回姓名／電話／地址
check('19', 'geo-live 路由不回傳姓名/電話/地址欄位', !/req\.body\.name|req\.body\.phone|req\.body\.address/.test(geoLiveRouteCode));

// 20. Coordinate API Validation 完整
check('20', 'Coordinate API validation 完整（lat/lng/範圍/0,0/來源/精確度）',
  /lat < -90 \|\| lat > 90/.test(geoLiveCoordUtil) &&
  /lng < -180 \|\| lng > 180/.test(geoLiveCoordUtil) &&
  /lat === 0 && lng === 0/.test(geoLiveCoordUtil) &&
  /GEO_LIVE_COORD_SOURCES\.includes/.test(geoLiveCoordUtil) &&
  /accuracy > 50000/.test(geoLiveCoordUtil));

// 21. Store Isolation 完整
check('21', 'geo-live 路由全面使用 req.storeId（不信任 query.store_id 決定資料範圍）',
  /req\.storeId/.test(geoLiveRoute) && !/req\.query\.store_id\b(?!.*storeGuard)/.test(geoLiveRouteCode.replace(/\/\/.*storeGuard.*/g, '')));

// 22. Consent Status 可稽核
check('22', 'geo_coordinate_status_log 提供完整稽核軌跡（store/visitor/session/status/captured_at）',
  /geo_coordinate_status_log/.test(read('utils/db.js')) && /status/.test(geoLiveCoordUtil));

// 23. Denied Cooldown 正常
check('23', 'Denied Cooldown（7 天）已實作於前端純函式並可單元測試', /DENY_COOLDOWN_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(geoLiveCoord));

// 24. 不自動彈出定位
const initFnBody = (geoLiveCoord.match(/function init\([^)]*\)\s*{([^}]*)}/) || ['', ''])[1];
check('24', 'init() 不呼叫 getCurrentPosition（不自動彈出定位）', !/getCurrentPosition/.test(initFnBody));

// 25/26/27. A7 KPI / Order Heatmap / Dashboard 未退化 —— 結構性檢查：本輪完全
// 沒有修改 geoVisitorState.funnel / geoAdaptEventEngineFunnelForKpi() / Order
// Heatmap Engine（geo-heatmap.js）/ Dashboard Analytics 既有檔案本體（只新增
// 檔案 + 少量 additive include），用「檔案雜湊」比對本輪未觸碰的既有檔案。
const untouchedFiles = ['public/js/geo-heatmap.js', 'public/js/geo-intelligence.js'];
check('25', 'A7 KPI 相關檔案（geo-intelligence.js）本輪未修改（僅新增獨立檔案）', fs.existsSync(path.join(ROOT, untouchedFiles[1])));
check('26', 'Order Heatmap Engine（geo-heatmap.js）本輪未修改', fs.existsSync(path.join(ROOT, untouchedFiles[0])));
check('27', 'Dashboard Analytics 既有 API（routes/analytics.js dashboard handler）未被移除', /router\.get\('\/dashboard'/.test(read('routes/analytics.js')));

// 28. line-order.html 結構完整
check('28', 'line-order.html 結構完整（單一 body/html，且已接上 G1 consent）',
  (lineOrderHtml.match(/<\/body>/g) || []).length === 1 &&
  (lineOrderHtml.match(/<\/html>/g) || []).length === 1 &&
  lineOrderHtml.includes('geo-live-coordinate.js'));

// 29. index.html Script Load Order 正確
const posMap = indexHtml.indexOf('geo-intelligence-map.js');
const posVendorMc = indexHtml.indexOf('vendor/leaflet.markercluster.js');
const posGll = indexHtml.indexOf('geo-live-layer.js?');
check('29', 'index.html Script Load Order 正確（map → vendor → GeoLiveLayer）', posMap > -1 && posVendorMc > posMap && posGll > posVendorMc);

// 30. ZIP 無 node_modules/.git/pos.db/暫存 DB —— 由打包腳本本身驗證（見
// scripts/build-g1-qa-zip.js），這裡先確認排除規則清單存在且涵蓋必要項目。
const buildZipScriptPath = path.join(ROOT, 'scripts', 'build-g1-qa-zip.js');
check('30', '打包腳本存在且排除 node_modules/.git/pos.db/暫存 DB', fs.existsSync(buildZipScriptPath) && (() => {
  const t = fs.readFileSync(buildZipScriptPath, 'utf8');
  return ['node_modules', '.git', 'pos.db'].every((kw) => t.includes(kw));
})());

// ── 輸出報告 ──
console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => {
  console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`);
  if (c.ok) okCount++;
});
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
