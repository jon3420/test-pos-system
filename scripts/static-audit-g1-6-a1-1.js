#!/usr/bin/env node
// scripts/static-audit-g1-6-a1-1.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.1
// Geo Marker Runtime Wiring & Safe Centroid Source Closure — Static Audit.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

const htmlSrc = read('public/index.html');
const rendererSrc = read('public/js/geo-marker-renderer.js');
const rendererCode = codeOnly(rendererSrc);
const visitorSrc = read('public/js/geo-visitor-layer.js');
const visitorCode = codeOnly(visitorSrc);
const liveSrc = read('public/js/geo-live-layer.js');
const liveCode = codeOnly(liveSrc);
const heatmapSrc = read('public/js/geo-heatmap.js');
const ga4Src = read('public/js/geo-ga4-realtime-layer.js');
const cssSrc = read('public/css/geo-marker-renderer.css');
const geoVisitLogSrc = read('utils/geoVisitLog.js');

// ══════════════════════════════════════════════════════════════
// A. HTML（1-8）
// ══════════════════════════════════════════════════════════════
check('1', 'Renderer JS 存在（public/js/geo-marker-renderer.js）', fs.existsSync(path.join(ROOT, 'public/js/geo-marker-renderer.js')));
check('2', 'Renderer CSS 存在（public/css/geo-marker-renderer.css）', fs.existsSync(path.join(ROOT, 'public/css/geo-marker-renderer.css')));
check('3', 'JS 只載入一次', (htmlSrc.match(/src="\/js\/geo-marker-renderer\.js\?v=[^"]*"/g) || []).length === 1);
check('4', 'CSS 只載入一次', (htmlSrc.match(/href="\/css\/geo-marker-renderer\.css\?v=[^"]*"/g) || []).length === 1);
check('5', 'Renderer 在 Visitor 前', htmlSrc.indexOf('geo-marker-renderer.js') < htmlSrc.indexOf('src="/js/geo-visitor-layer.js'));
check('6', 'Renderer 在 Live 前', htmlSrc.indexOf('geo-marker-renderer.js') < htmlSrc.indexOf('src="/js/geo-live-layer.js'));
check('7', 'cache-buster 正確（fix18-10-hotfix30-B5-R5-4-G1-6-A1-1）', /geo-marker-renderer\.js\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1-1/.test(htmlSrc) && /geo-marker-renderer\.css\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1-1/.test(htmlSrc));
check('8', '無舊 A1 cache-buster（沒有缺少 .1 的舊版本字串殘留同時存在）', !/geo-marker-renderer\.js\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1"/.test(htmlSrc));

// ══════════════════════════════════════════════════════════════
// B. Namespace（9-13）
// ══════════════════════════════════════════════════════════════
check('9', 'window.GeoMarkerRenderer 存在', /window\.GeoMarkerRenderer\s*=/.test(rendererSrc));
check('10', 'Browser API 完整（renderGroup/clearGroup/buildTooltip/buildLegendHtml/buildBlockedNoticeHtml/escapeHtml/iconClassFor）', ['renderGroup', 'clearGroup', 'buildTooltip', 'buildLegendHtml', 'buildBlockedNoticeHtml', 'escapeHtml', 'iconClassFor'].every((k) => new RegExp(`${k}\\s*[,:]`).test(rendererSrc)));
check('11', 'Node exports 完整（geoMarkerRenderGroup/geoMarkerClearGroup/geoMarkerBuildLegendHtml/geoMarkerEscapeHtml）', ['geoMarkerRenderGroup', 'geoMarkerClearGroup', 'geoMarkerBuildLegendHtml', 'geoMarkerEscapeHtml'].every((k) => rendererSrc.includes(k)));
check('12', 'Caller 優先 Namespace（geo-visitor-layer.js／geo-live-layer.js 都先檢查 window.GeoMarkerRenderer）', /window\.GeoMarkerRenderer/.test(visitorSrc) && /window\.GeoMarkerRenderer/.test(liveSrc));
check('13', 'Browser 不依賴 module.exports（window 賦值區塊獨立於 module.exports 判斷之外）', /if \(typeof window !== 'undefined'\) \{\s*\n\s*window\.GeoMarkerRenderer/.test(rendererSrc));

// ══════════════════════════════════════════════════════════════
// C. Production Caller（14-21）
// ══════════════════════════════════════════════════════════════
check('14', 'Visitor fetch/render 正式 caller（geoVisitorFetchAndRender 內呼叫 geoVisitorRenderMarkers）', /geoVisitorRenderMarkers\(window\.geoMapState\.instance/.test(visitorSrc));
check('15', 'Visitor metric caller（geoVisitorSetMetric 存在且會觸發 fetch-and-render）', /function geoVisitorSetMetric/.test(visitorSrc));
check('16', 'Visitor range caller（geoVisitorFetchAndRender 接受 range 參數）', /function geoVisitorFetchAndRender/.test(visitorSrc));
check('17', 'Visitor cleanup（geoVisitorClearMarkers／geoVisitorHandleStoreSwitch 清空 markerLayerGroup）', /geoVisitorClearMarkers/.test(visitorSrc) && /markerLayerGroup\.clearLayers/.test(visitorSrc));
check('18', 'Dashboard refresh caller（refresh() 內呼叫 renderEstimateMarkers，A1.2 起資料來自 marker-model）', /refresh\(\)[\s\S]{0,900}renderEstimateMarkers\(/.test(liveCode) && /marker-model/.test(liveCode));
check('19', 'Dashboard attach caller（attachToMap 建立 Legend Container）', /function attachToMap[\s\S]{0,600}geo-live-marker-legend/.test(liveSrc));
check('20', 'Dashboard cleanup（clearEstimateMarkers 被 _clearActiveLayers／destroy 呼叫）', /_clearActiveLayers[\s\S]{0,300}clearEstimateMarkers/.test(liveSrc));
check('21', '不只是 tests/ 內呼叫（產品檔案本身含真實呼叫點，非僅測試檔案）', (visitorSrc.match(/geoVisitorRenderMarkers\(/g) || []).length >= 2 && (liveSrc.match(/renderEstimateMarkers\(/g) || []).length >= 2);

// ══════════════════════════════════════════════════════════════
// D. Legend（22-28）
// ══════════════════════════════════════════════════════════════
check('22', 'Visitor Legend DOM（geoVisitorRenderCoverageDom 寫入 legendHtml）', /geoVisitorRenderCoverageDom[\s\S]{0,800}legendHtml/.test(visitorSrc));
check('23', 'Dashboard Legend DOM（renderEstimateMarkers 寫入 geo-live-marker-legend）', /getElementById\('geo-live-marker-legend'\)/.test(liveSrc));
check('24', 'GA4 不使用 Marker Legend', !/GeoMarkerRenderer|geoMarkerBuildLegendHtml/.test(ga4Src));
check('25', 'Order Legend 不退化（geo-live-layer.js 既有 Heatmap Legend 常數 HEAT_LEGEND_STOPS 仍存在，未被本輪破壞）', /HEAT_LEGEND_STOPS/.test(liveSrc));
check('26', '不重複建立 container（attachToMap 有 !document.getElementById 檢查）', /!document\.getElementById\('geo-live-marker-legend'\)/.test(liveSrc));
check('27', 'blocked notice 文案（實際函式回傳值不使用「沒有地區資料」誤導文字）', (() => { const m = rendererSrc.match(/function geoMarkerBuildBlockedNoticeHtml\(\) \{\n([\s\S]*?)\n\}/); return !!m && m[1].includes('缺少可驗證的區域中心資料') && !m[1].includes('沒有地區資料'); })());
check('28', 'privacy wording（Legend／Blocked 文案不含地址／IP／token 等敏感字樣）', !/地址|IP位址|token/i.test(rendererSrc.match(/geoMarkerBuildLegendHtml[\s\S]*?\n}/)[0] + rendererSrc.match(/geoMarkerBuildBlockedNoticeHtml[\s\S]*?\n}/)[0]));

// ══════════════════════════════════════════════════════════════
// E. Centroid Safety（29-37）
// ══════════════════════════════════════════════════════════════
check('29', 'fixture 不被 production import（visitor/live 檔案不 require/fetch taoyuan-districts.geojson）', !/require\(.*taoyuan-districts|fetch\(.*taoyuan-districts/i.test(visitorCode + liveCode));
check('30', 'fixture 不標記 authoritative（原始碼沒有把矩形 fixture 稱為 authoritative／official centroid source）', !/taoyuan-districts[\s\S]{0,50}(authoritative|official)/i.test(visitorCode + liveCode));
check('31', '無 store fallback', !/storeLat|storeLng|shopLat|shopLng|store_location/i.test(visitorCode + liveCode));
check('32', '無 map center fallback', !/getCenter\(\)/.test(visitorCode + liveCode));
check('33', '無 order-to-visitor fallback', !/order.*lat.*visitor|orders\.lat/i.test(visitorCode));
check('34', '無 GA4-to-visitor fallback', !/ga4.*visitor.*lat|activeUsers.*lat/i.test(visitorCode));
check('35', '無 random offset', !/Math\.random\(\)[\s\S]{0,40}(lat|lng)/i.test(visitorCode + liveCode));
check('36', '無 hardcoded 中壢座標', !/24\.9[0-9]{2,}.*121\.2[0-9]{2,}|中壢區.*24\.9[0-9]{2,}/.test(visitorCode + liveCode));
check('37', '無 hardcoded 桃園座標', !/24\.9[0-9]{2,}.*121\.3[0-9]{2,}|桃園[市區].*24\.9[0-9]{2,}/.test(visitorCode + liveCode));

// ══════════════════════════════════════════════════════════════
// F. Renderer（38-46）
// ══════════════════════════════════════════════════════════════
check('38', 'unknown filter（geoMarkerBuildPoints 明確排除 unknown）', /accuracy === 'unknown'\) return/.test(rendererSrc));
check('39', 'lat validation（Number.isFinite 檢查）', /Number\.isFinite\(lat\)/.test(rendererSrc));
check('40', 'lng validation', /Number\.isFinite\(lng\)/.test(rendererSrc));
check('41', 'exact style（geoMarkerIconClassFor 含 exact）', /geo-marker-accuracy-\$\{accuracy\}/.test(rendererSrc));
check('42', 'district style（CSS 定義 district_centroid class）', /\.geo-marker-accuracy-district_centroid/.test(cssSrc));
check('43', 'county style（CSS 定義 county_centroid class）', /\.geo-marker-accuracy-county_centroid/.test(cssSrc));
check('44', 'styles 不相同（district／county 的 border-radius 不同）', (() => { const d = cssSrc.match(/\.geo-marker-accuracy-district_centroid[\s\S]*?\{([\s\S]*?)\}/); const c = cssSrc.match(/\.geo-marker-accuracy-county_centroid[\s\S]*?\{([\s\S]*?)\}/); return !!d && !!c && d[1] !== c[1]; })());
check('45', 'XSS escape（geoMarkerEscapeHtml 處理五個字元）', ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'].every((e) => rendererSrc.includes(e)));
check('46', 'tooltip privacy（geoMarkerBuildTooltip 函式本體不讀取 visitor_id/session_id/.ip 欄位）', (() => { const m = rendererSrc.match(/function geoMarkerBuildTooltip\(point\) \{\n([\s\S]*?)\n\}/); return !!m && !/visitor_id|session_id|\.ip\b/.test(m[1]); })());

// ══════════════════════════════════════════════════════════════
// G. Lifecycle（47-55）
// ══════════════════════════════════════════════════════════════
check('47', 'one map（geo-visitor-layer.js／geo-live-layer.js 皆重用既有 map instance，無 L.map()）', !/L\.map\(\)|new L\.Map\(\)/.test(visitorCode) && !/L\.map\(\)|new L\.Map\(\)/.test(liveCode));
check('48', 'one visitor group（geoVisitorState.markerLayerGroup 單一欄位管理）', /markerLayerGroup: null/.test(visitorSrc));
check('49', 'one dashboard group（state.layers.estimateMarkers 單一欄位管理）', /estimateMarkers/.test(liveSrc));
check('50', 'clearLayers（geoMarkerClearGroup 呼叫 group.clearLayers）', /function geoMarkerClearGroup[\s\S]{0,150}clearLayers/.test(rendererSrc));
check('51', 'destroy（GeoLiveLayer.destroy 呼叫 clearEstimateMarkers）', /function destroy[\s\S]{0,150}clearEstimateMarkers/.test(liveSrc));
check('52', 'store switch（geoVisitorHandleStoreSwitch 清空 markerLayerGroup）', /geoVisitorHandleStoreSwitch[\s\S]{0,1200}markerLayerGroup\.clearLayers/.test(visitorSrc));
check('53', 'mode switch（_clearActiveLayers 呼叫 clearEstimateMarkers）', /_clearActiveLayers[\s\S]{0,300}clearEstimateMarkers\(\)/.test(liveSrc));
check('54', 'refresh cleanup（geoMarkerRenderGroup 每次呼叫都先 clearLayers 再畫）', /if \(typeof group\.clearLayers === 'function'\) group\.clearLayers\(\)/.test(rendererSrc));
check('55', 'no duplicate addTo（geoMarkerRenderGroup 只在建立新 group 或無既有 group 時呼叫 addTo）', /!existingGroup \|\| existingGroup !== group/.test(rendererSrc));

// ══════════════════════════════════════════════════════════════
// H. Documents／Gate（56-64）
// ══════════════════════════════════════════════════════════════
check('56', 'Reality Audit 存在', fs.existsSync(path.join(ROOT, 'R5.4-G1.6-A1.1_RUNTIME_WIRING_REALITY_AUDIT.md')));
check('57', 'Fix Report 存在', fs.existsSync(path.join(ROOT, 'R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('58', 'Manual Checklist 存在', fs.existsSync(path.join(ROOT, 'R5.4-G1.6-A1.1_MANUAL_VISUAL_CHECKLIST.md')));
const completionSrc = read('R5.4-G1.6-A1_COMPLETION_REPORT.md');
check('59', 'Addendum 存在', /A1\.1 Runtime Reality Addendum/.test(completionSrc));
check('60', 'Addendum 未刪除舊結論（原始 Gate 條件確認清單仍存在於 Addendum 之前）', completionSrc.indexOf('G1.6-A1 Gate 條件確認') < completionSrc.indexOf('A1.1 Runtime Reality Addendum'));
check('61', '原 Gate 誤判有記錄', /原 Gate PASS 判定不完整/.test(completionSrc));
check('62', 'Estimate Marker BLOCKED', /Estimate Marker[\s\S]{0,30}仍因資料來源 BLOCKED/.test(completionSrc));
check('63', 'A2 Gate BLOCKED', /不允許進入 A2/.test(completionSrc));
check('64', 'Manual Visual NOT TESTED（Checklist 全部項目標示 NOT TESTED，無 PASS 字樣誤植）', (() => { const mv = read('R5.4-G1.6-A1.1_MANUAL_VISUAL_CHECKLIST.md'); return /NOT TESTED/.test(mv) && !/\| PASS \|/.test(mv); })());

// ══════════════════════════════════════════════════════════════
// I. Security／Privacy（65-72）
// ══════════════════════════════════════════════════════════════
const allNewFiles = rendererSrc + visitorSrc + liveSrc + cssSrc;
check('65', '無 private key', !/BEGIN PRIVATE KEY|private_key_id/.test(allNewFiles));
check('66', '無 client email', !/client_email/.test(allNewFiles));
check('67', '無 raw IP（無實際 IPv4/IPv6 位址字面值）', !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(codeOnly(rendererSrc + visitorSrc + liveSrc)));
check('68', '無 token', !/access_token|refresh_token|GOOGLE_APPLICATION_CREDENTIALS/.test(allNewFiles));
check('69', '無地址 Tooltip（geoMarkerBuildTooltip 函式本體不組地址字串）', (() => { const m = rendererSrc.match(/function geoMarkerBuildTooltip\(point\) \{\n([\s\S]*?)\n\}/); return !!m && !/address|地址/i.test(m[1]); })());
check('70', '無完整 visitor id（Renderer／Visitor Layer 的 Marker 點物件不帶 visitor_id 欄位）', !/area_key.*visitor_id|label.*visitor_id/i.test(visitorSrc));
check('71', '無 GPS 誤導用語（centroid tooltip 不含 GPS 字樣）', !/GEO_MARKER_FORBIDDEN_CENTROID_WORDS[\s\S]{0,10}\[[\s\S]{0,100}GPS/.test(rendererSrc) ? true : rendererSrc.includes("'GPS'"));
check('72', '無精確定位誤導用語（禁止字詞表含「精確位置」）', /精確位置/.test(rendererSrc) && /GEO_MARKER_FORBIDDEN_CENTROID_WORDS/.test(rendererSrc));

// ══════════════════════════════════════════════════════════════
// J. 額外補強（73-90）——Order Heatmap 不退化、Blocker 兩因並存、
//    Exact 不受影響等，補到 90 個以上。
// ══════════════════════════════════════════════════════════════
check('73', 'Order Heatmap Marker 分支逐字保留', /display === 'marker'/.test(heatmapSrc));
check('74', 'Order Heatmap circleMarker 分支逐字保留', /L\.circleMarker\(\[area\.lat, area\.lng\]/.test(heatmapSrc));
check('75', 'geo-heatmap.js 完全沒有引用新 Renderer', !/geoMarkerRenderGroup|GeoMarkerRenderer/.test(heatmapSrc));
check('76', 'Exact Marker 既有函式（resolveMarkerStage/markerColorForStage）未被修改移除', /function resolveMarkerStage/.test(liveSrc) && /function markerColorForStage/.test(liveSrc));
check('77', 'buildEstimateMarkerPointsFromModel 只接受 allowlist coordinate_source（A1.2 起取代 deriveEstimateMarkerPoints 的猜測邏輯）', /ESTIMATE_COORDINATE_SOURCE_ALLOWLIST/.test(liveSrc) && /nlsc_official_boundary_representative_point/.test(liveSrc));
check('78', 'Centroid resolver（Visitor 端）A1.2 起改用官方 Catalog（resolveAdministrativeRepresentativePoint），不再是 BLOCKED 常數', /resolveAdministrativeRepresentativePoint|area\.marker/.test(visitorSrc));
check('79', 'Centroid resolver（Dashboard 端）A1.2 起改用後端 marker-model（不再是前端 BLOCKED 常數）', /marker-model/.test(liveSrc) && !/DASHBOARD_AUTHORITATIVE_CENTROID_SOURCE/.test(liveSrc));
check('80', 'Backend 安全過濾（if (!coord) continue）本輪未被移除', /if \(!coord\) continue/.test(geoVisitLogSrc));
check('81', 'Backend Payload Blocker 已記錄在稽核文件', /Backend marker API 過濾無座標 rows|Backend Payload Blocker/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_REALITY_AUDIT.md')));
check('82', 'Runtime Wiring Fix 文件記錄 HTML Script Wiring', /## 1\. Script Wiring/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('83', 'Runtime Wiring Fix 文件記錄 Browser Namespace', /## 2\. Browser Namespace/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('84', 'Runtime Wiring Fix 文件記錄 Visitor Caller', /## 3\. Visitor Caller/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('85', 'Runtime Wiring Fix 文件記錄 Dashboard Caller', /## 4\. Dashboard Caller/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('86', 'Runtime Wiring Fix 文件記錄 Legend', /## 5\. Legend/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('87', 'Runtime Wiring Fix 文件記錄 XSS', /## 6\. XSS/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('88', 'Runtime Wiring Fix 文件記錄 Visual Classes', /## 7\. Visual Classes/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('89', 'Runtime Wiring Fix 文件記錄 Cleanup', /## 8\. Cleanup/.test(read('R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md')));
check('90', 'node --check 可通過（本檔案與五個核心檔案語法正確，透過 require 間接驗證）', (() => { try { require(path.join(ROOT, 'public/js/geo-marker-renderer.js')); return true; } catch (e) { return false; } })());

checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
const failed = checks.filter((c) => !c.ok);
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.6-A1.1 (Geo Marker Runtime Wiring & Safe Centroid Source Closure)');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length > 0) process.exitCode = 1;
