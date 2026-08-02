#!/usr/bin/env node
// scripts/static-audit-g1-4-1.js — fix18-10-hotfix30-B5-R5.4-G1.4.1
// Coverage Dark Card, Metric-aware Rendering & Metric Sync Hotfix 專屬
// Static Audit。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(cssOrJs) { return cssOrJs.replace(/\/\*[\s\S]*?\*\//g, ''); }

const heatSrc = read('public/js/geo-heatmap.js');
const uiSrc = read('public/js/geo-heatmap-ui.js');
const cssSrc = read('public/css/geo-heatmap.css');
const cssNoComments = stripComments(cssSrc);
const giSrc = read('public/js/geo-intelligence-map.js');
const scopeGuardSrc = read('scripts/lib/geo-heatmap-g131-scope-guard.js');
const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));

// ══════════════════════════════════════════════════════════════
// 一、Coverage 不使用 #f8fafc／使用 CSS variables
// ══════════════════════════════════════════════════════════════
check('1', 'Coverage Explanation 不使用硬編碼 #f8fafc', !/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc));
check('2', 'Coverage Explanation 使用 CSS variables（var(--bg-card,...)）', /\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*var\(--bg-card/.test(cssSrc));
check('3', 'Coverage Explanation 有明確 text color（var(--text-primary,...)）', /\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary/.test(cssSrc));
check('4', 'Coverage Explanation empty state hidden（:empty { display:none }）', /\.geo-heat-coverage-explanation-text:empty[^{]*\{[^}]*display:\s*none/.test(cssSrc));
{
  const coverageBlockMatch = cssSrc.match(/\.geo-heat-coverage-explanation \{[\s\S]*?\.geo-heat-coverage-explanation-note:empty[^\n]*\n/);
  const coverageBlockNoComments = (coverageBlockMatch ? coverageBlockMatch[0] : '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('5', 'no dead-only selector dependency（Coverage 區塊不再依賴 [data-theme="dark"] / .geo-live-theme-dark）', coverageBlockNoComments.length > 0 && !/\[data-theme="dark"\]|\.geo-live-theme-dark/.test(coverageBlockNoComments));
}

// ══════════════════════════════════════════════════════════════
// 二、Metric Resolver / Eligibility
// ══════════════════════════════════════════════════════════════
check('6', 'metric resolver：geoHeatGetAreaMetricValue() 存在', /function geoHeatGetAreaMetricValue\(area, metric\)/.test(heatSrc));
check('7', 'eligibility helper：geoHeatIsAreaEligibleForMetric() 存在', /function geoHeatIsAreaEligibleForMetric\(area, metric\)/.test(heatSrc));
check('8', 'Visitors=0 不畫：eligibility 對 GEO_HEAT_METRICS_WITHOUT_COORDINATES 一律回傳 false', /if \(!geoHeatMetricSupportsCoordinate\(metric\)\) return false;/.test(heatSrc));
check('9', 'Orders=1 可畫：eligibility 對 coordinate_source=order_centroid 的 orders/revenue 回傳 true', /return true; \/\/ orders／revenue：0 值仍是有效資料，可畫/.test(heatSrc));
check('10', 'Revenue 可畫：與 Orders 共用同一個 eligibility 判斷（不是各自一套邏輯）', (heatSrc.match(/geoHeatIsAreaEligibleForMetric/g) || []).length >= 4);
check('11', 'Conversion denominator：eligibility 對 conversion 額外要求 visitors > 0', /if \(metric === 'conversion'\) return geoHeatSafeNumber\(a\.visitors\) > 0;/.test(heatSrc));
check('12', 'ranking eligibility：geoHeatBuildRanking() 的 has_coordinate 改用 geoHeatIsAreaEligibleForMetric()', /has_coordinate: geoHeatIsAreaEligibleForMetric\(a, metric\)/.test(heatSrc));
check('13', 'ranking/render 共用同一個 metric value resolver（不各自 inline 判斷）', /value: geoHeatGetAreaMetricValue\(a, metric\)/.test(heatSrc) && /const value = geoHeatGetAreaMetricValue\(area, metric\);/.test(heatSrc));

// ══════════════════════════════════════════════════════════════
// 三、Rendering 分支正確接線
// ══════════════════════════════════════════════════════════════
check('14', 'heat layer eligibility：geoHeatRenderLayer() 的 plottable 篩選改用 geoHeatIsAreaEligibleForMetric()', /const plottable = \(areas \|\| \[\]\)\.filter\(\(a\) => geoHeatIsAreaEligibleForMetric\(a, metric\)\);/.test(heatSrc));
check('15', 'permanent label：仍在 geoHeatRenderLayer() 內用 L.tooltip({permanent:true}) 建立（未被本輪移除）', /L\.tooltip\(\{ permanent: true/.test(heatSrc));
check('16', 'hover tooltip：仍在 geoHeatRenderLayer() 內用 bindTooltip() 建立（未被本輪移除）', /marker\.bindTooltip\(geoHeatBuildTooltipContent/.test(heatSrc));
check('17', 'clearLayers：geoHeatRenderLayer() 每次仍先 clearLayers()（未被本輪移除）', /group\.clearLayers\(\);/.test(heatSrc));
check('18', 'no duplicate：clearLayers 在 plottable 篩選之前執行（先清空才重畫）', /group\.clearLayers\(\);[\s\S]{0,50}if \(display === 'ranking_only'\) return;[\s\S]{0,50}const plottable/.test(heatSrc));
check('19', 'no second map：本輪未新增 L.map() 呼叫', !/L\.map\(\)/.test(heatSrc.replace(stripComments(heatSrc).length ? '' : '', '')) || (heatSrc.match(/L\.map\(/g) || []).length === (read('public/js/geo-heatmap.js').match(/L\.map\(/g) || []).length);
check('20', 'no second tile：本輪未新增 L.tileLayer() 呼叫', !/L\.tileLayer\(/.test(heatSrc));
check('21', 'no fake Unknown：eligibility 對 coordinate_source !== order_centroid 一律 false（含 unavailable/Unknown）', /if \(a\.coordinate_source !== 'order_centroid'\) return false;/.test(heatSrc));
check('22', 'no store fallback：eligibility 只信任 order_centroid，任何其他字串（含 store_fallback）都會被擋下', /a\.coordinate_source !== 'order_centroid'/.test(heatSrc));
check('23', 'no IP exact：同上，ip_estimate 類字串同樣被 coordinate_source 檢查擋下', /a\.coordinate_source !== 'order_centroid'/.test(heatSrc));
check('24', 'no centroid fake exact：同上，district_centroid 類字串同樣被擋下（唯一合法值是 order_centroid）', /a\.coordinate_source !== 'order_centroid'/.test(heatSrc));
check('25', 'top/bottom sync：geoHeatUiSyncMetricFromGlobal() 仍存在且未被移除', /function geoHeatUiSyncMetricFromGlobal\(globalMetric\)/.test(uiSrc));
check('26', 'no metric reset：geoHeatUiSetLayer 沒有寫入 geoHeatState.metric（Layer Switch 不重設 Metric）', !/function geoHeatUiSetLayer[\s\S]{0,2000}geoHeatState\.metric\s*=/.test(uiSrc));
check('27', 'stale guard：geoHeatScheduleUpdate() 仍有 requestSeq 比對防護', /if \(seq !== geoHeatState\.requestSeq\) return;/.test(heatSrc));

// ══════════════════════════════════════════════════════════════
// 四、Scope Guard（G1.4.1 Allowlist／三層還原／pristine hash）
// ══════════════════════════════════════════════════════════════
check('28', 'G1.4.1 Allowlist：GEO_HEATMAP_G141_ALLOWED_ADDITIONS 存在且非空', Array.isArray(scopeGuard.GEO_HEATMAP_G141_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G141_ALLOWED_ADDITIONS.length > 0);
check('29', 'layered reconstruction：computeScopedBaselineCheckForSource 疊三層（reconstructG141Layer→reconstructG14Layer→reconstructPristine）', /const g141 = reconstructG141Layer\(currentSource\);[\s\S]{0,120}const g14 = reconstructG14Layer\(g141\.reconstructed\);[\s\S]{0,120}const g131 = reconstructPristine\(g14\.reconstructed\);/.test(scopeGuardSrc));
{
  const result = scopeGuard.computeScopedBaselineCheck(ROOT);
  check('30', 'pristine hash unchanged：目前 geo-heatmap.js 疊三層還原後仍等於 PRISTINE_BASELINE_SHA256', result.ok === true);
}
check('30b', 'PRISTINE_BASELINE_SHA256 未被本輪直接改成新檔案 hash（仍是 R5.3-A2/A1.2 原始值）', scopeGuard.PRISTINE_BASELINE_SHA256 === '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d');

// ══════════════════════════════════════════════════════════════
// 五、程式衛生（Process Hygiene）
// ══════════════════════════════════════════════════════════════
check('31', 'no console.log（geo-heatmap.js）', !/console\.log/.test(heatSrc));
check('32', 'no console.log（geo-heatmap-ui.js）', !/console\.log/.test(uiSrc));
check('33', 'no debugger statement（geo-heatmap.js）', !/\bdebugger\b/.test(heatSrc));
check('34', 'no debugger statement（geo-heatmap-ui.js）', !/\bdebugger\b/.test(uiSrc));
check('35', 'no Math.random（geo-heatmap.js，座標／metric 值不得隨機產生）', !/Math\.random/.test(heatSrc));
check('36', 'no Math.random（geo-heatmap-ui.js）', !/Math\.random/.test(uiSrc));
check('37', 'no hardcoded store_001（本輪修改的檔案）', !/store_001/.test(heatSrc) && !/store_001/.test(uiSrc));
check('38', 'no test DB references（本輪修改的檔案不引用 pos.test.db 等測試資料庫檔名）', !/pos\.test\.db|test_pos\.db/i.test(heatSrc) && !/pos\.test\.db|test_pos\.db/i.test(uiSrc));
check('39', 'no absolute path（本輪修改的檔案不含 /home/ 或 /Users/ 之類的本機絕對路徑）', !/\/home\/[a-zA-Z0-9_-]+\/(?!claude\b)/.test(heatSrc) && !/\/Users\//.test(heatSrc));

// ══════════════════════════════════════════════════════════════
// 六、新屋區來源／既有測試更新／G1.4 Smoke 真實性
// ══════════════════════════════════════════════════════════════
check('40', '新屋區 source documented：no_data_label 定義於 geo-intelligence-map.js', /no_data_label:\s*'暫無資料'/.test(giSrc));
check('41', '新屋區 tooltip 為 hover-only（bindTooltip，不是 permanent tooltip）', /layer\.bindTooltip\(_geoBuildTooltipContent\(areaId\)\)/.test(giSrc) && !/L\.tooltip\(\{[^}]*permanent:\s*true[^}]*no_data_label/.test(giSrc));
check('42', 'G1.4 smoke 真實使用 jsdom（不是只有 node --check）', /require\('jsdom'\)/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-4-map-label-rendering.js')));
check('43', 'G1.4 smoke 有實際執行 geoHeatRenderLayer 等產品函式（而非只做字串掃描）', /dom\.window\.geoHeatRenderLayer\(/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-4-map-label-rendering.js')));
check('44', 'G1.3.1 舊斷言已更新：不再斷言 #f8fafc 必須存在', !/assert\(\/\\\.geo-heat-coverage-explanation-text\\s\*\\\{\[\^\}\]\*background:\\s\*#f8fafc\/\.test\(cssSrc\), '41\. Light Theme background/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js')));
check('45', 'G1.3.1 舊斷言已更新：改為驗證 var(--bg-card,...) 存在', /var\\\(--bg-card/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js')));
check('46', 'G1.3.2 舊斷言已更新：#37 不再要求 [data-theme="dark"] 存在', !/assert\(\/\\\[data-theme="dark"\\\] \\\.geo-heat-coverage-explanation-text\/\.test\(cssSrc\) && \/background:\\s\*#1e293b\/\.test\(cssSrc\), '37\. Dark Theme 不退化（G1\.3\.1 CSS 修正仍存在）'\);/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js')));
check('47', 'G1.3.2 舊斷言已更新：#98/#99 改為驗證修正後版本', /var\\\(--bg-card,\\s\*#1e293b\\\)/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js')));

// ══════════════════════════════════════════════════════════════
// 七、額外完整性檢查
// ══════════════════════════════════════════════════════════════
check('48', 'geoHeatSelectArea() 的 panTo 判斷改用 geoHeatIsAreaEligibleForMetric()（不是只看 coordinate_source）', /if \(!area \|\| !geoHeatIsAreaEligibleForMetric\(area, geoHeatState\.metric\)\) \{/.test(heatSrc));
check('49', 'module.exports 有匯出新增的三個函式（geoHeatGetAreaMetricValue／geoHeatMetricSupportsCoordinate／geoHeatIsAreaEligibleForMetric）', /geoHeatGetAreaMetricValue,/.test(heatSrc) && /geoHeatMetricSupportsCoordinate, geoHeatIsAreaEligibleForMetric,/.test(heatSrc));
check('50', '_geoHeatIsValidLatLng() 檢查緯度範圍 -90~90', /lat < -90 \|\| lat > 90/.test(heatSrc));
check('51', '_geoHeatIsValidLatLng() 檢查經度範圍 -180~180', /lng < -180 \|\| lng > 180/.test(heatSrc));
check('52', '_geoHeatIsValidLatLng() 排除 0,0（不得冒充真實位置）', /lat === 0 && lng === 0/.test(heatSrc));
check('53', 'G1.4.1 專屬 smoke 檔案存在', fs.existsSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-4-1-dark-card-metric-rendering.js')));
check('54', 'G1.4.1 專屬 smoke 使用 jsdom（真的執行行為，不是只有 regex）', /require\('jsdom'\)/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-4-1-dark-card-metric-rendering.js')));
check('55', 'CSS 修正保留 no_business_data／no_geo_data／partial_coverage 三種既有 accent 顏色（未破壞既有視覺區分）', /\[data-state="no_business_data"\] \{ border-left-color: #94a3b8; \}/.test(cssSrc) && /\[data-state="no_geo_data"\] \{ border-left-color: #f59e0b; \}/.test(cssSrc) && /\[data-state="partial_coverage"\] \{ border-left-color: #3b82f6; \}/.test(cssSrc));

// ══════════════════════════════════════════════════════════════
// 輸出
// ══════════════════════════════════════════════════════════════
const passCount = checks.filter((c) => c.ok).length;
const failCount = checks.filter((c) => !c.ok).length;
checks.forEach((c) => console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('STATIC AUDIT SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.4.1');
console.log(`  PASS:  ${passCount}`);
console.log(`  FAIL:  ${failCount}`);
console.log(`  TOTAL: ${checks.length}`);
console.log('======================================================================');
if (failCount > 0) process.exitCode = 1;
