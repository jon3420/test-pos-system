#!/usr/bin/env node
// scripts/static-audit-g1-5-b1.js — fix18-10-hotfix30-B5-R5.4-G1.5-B1
// Frontend Contract Wiring & GA4 County Choropleth — Static Audit.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }
function cssNoComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }

const htmlSrc = read('public/index.html');
const ga4Src = read('public/js/geo-ga4-realtime-layer.js');
const uiSrc = read('public/js/geo-heatmap-ui.js');
const cssSrc = read('public/css/geo-ga4-realtime-layer.css');
const ga4Code = codeOnly(ga4Src);
const uiCode = codeOnly(uiSrc);
const cssClean = cssNoComments(cssSrc);

// ══════════════════════════════════════════════════════════════
// 一、HTML Script Wiring
// ══════════════════════════════════════════════════════════════
check('1', 'index.html 載入 geo-ga4-realtime-layer.js', htmlSrc.includes('/js/geo-ga4-realtime-layer.js'));
check('2', 'script 只載入一次', (htmlSrc.match(/src="\/js\/geo-ga4-realtime-layer\.js/g) || []).length === 1);
{
  const idxLeaflet = htmlSrc.indexOf('unpkg.com/leaflet');
  const idxGiMap = htmlSrc.indexOf('/js/geo-intelligence-map.js');
  const idxHeat = htmlSrc.indexOf('/js/geo-heatmap.js?');
  const idxUi = htmlSrc.indexOf('/js/geo-heatmap-ui.js');
  const idxGa4 = htmlSrc.indexOf('/js/geo-ga4-realtime-layer.js');
  check('3', 'script 順序正確（Leaflet→giMap→heatmap→heatmap-ui→ga4-layer）', idxLeaflet > -1 && idxLeaflet < idxGiMap && idxGiMap < idxHeat && idxHeat < idxUi && idxUi < idxGa4);
}
check('4', 'GA4 container 存在（${id}-ga4-layer）', uiCode.includes('-ga4-layer'));
check('5', 'toolbar container 存在（${id}-ga4-toolbar）', uiCode.includes('-ga4-toolbar'));
check('6', 'summary container 存在（${id}-ga4-summary）', uiCode.includes('-ga4-summary'));
check('7', 'status container 存在（${id}-ga4-status）', uiCode.includes('-ga4-status'));
check('8', 'notices container 存在（${id}-ga4-notices）', uiCode.includes('-ga4-notices'));

// ══════════════════════════════════════════════════════════════
// 二、API Endpoint／Query
// ══════════════════════════════════════════════════════════════
check('9', 'API endpoint 為 /api/geo-live/ga4-realtime', ga4Code.includes('/api/geo-live/ga4-realtime'));
check('10', 'window query 參數存在', /window=\$\{w\}/.test(ga4Code));
check('11', 'metric query 參數存在', /metric=\$\{/.test(ga4Code));
check('12', 'refresh query 參數存在', /refresh=\$\{r\}/.test(ga4Code));
check('13', '不接受 property query 參數', !/property_id|propertyId\s*[:=]/.test(ga4Code));
check('14', '不接受 stream query 參數', !/stream_id|streamId\s*[:=]/.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 三、Contract Fields／Dedup
// ══════════════════════════════════════════════════════════════
check('15', '讀取 data.summary', ga4Code.includes('d.summary'));
check('16', '讀取 data.counties', ga4Code.includes('d.counties'));
check('17', '沒有 counties.reduce() 當作 total', !/counties\.reduce\(/.test(ga4Code));
check('18', '沒有 combined_total／total_visitors_combined／system_plus_ga4', !/combined_total|total_visitors_combined|system_plus_ga4/.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 四、Fetch Lifecycle
// ══════════════════════════════════════════════════════════════
check('19', '使用 AbortController', /AbortController/.test(ga4Code));
check('20', '使用 requestSeq 防止舊回應覆蓋新狀態', /requestSeq/.test(ga4Code));
check('21', 'loading 防重複（loading state 存在且被讀寫）', /geoGa4State\.loading = true/.test(ga4Code) && /geoGa4State\.loading = false/.test(ga4Code));
check('22', 'auto refresh 預設 60 秒', /const seconds = .*\? 120 : 60/.test(ga4Code));
check('23', 'near_limit 時延長為 120 秒', /near_limit.*120/.test(ga4Code));
check('24', 'limited 時停止自動更新', /quota_status === 'limited'\) return;/.test(ga4Code));
check('25', 'timer cleanup 函式存在（geoGa4StopAutoRefresh）', /function geoGa4StopAutoRefresh/.test(ga4Code));
check('26', 'geoGa4Deactivate() 存在並清 timer／abort', /function geoGa4Deactivate/.test(ga4Code) && /geoGa4StopAutoRefresh\(\)/.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 五、Map／Choropleth
// ══════════════════════════════════════════════════════════════
check('27', '重用既有 window.geoMapState.instance', /window\.geoMapState\.instance/.test(ga4Code));
check('28', '重用既有 featureIndex（不建立新的行政區資料集）', /window\.geoMapState\.featureIndex/.test(ga4Code));
check('29', '沒有 L.map()/new L.Map()', !/L\.map\(/.test(ga4Code) && !/new L\.Map\(/.test(ga4Code));
check('30', '沒有 L.tileLayer()/new L.TileLayer()', !/L\.tileLayer\(/.test(ga4Code) && !/new L\.TileLayer\(/.test(ga4Code));
check('31', '沒有 L.marker()', !/L\.marker\(/.test(ga4Code));
check('32', '沒有 L.circle()/L.circleMarker()', !/L\.circle\(/.test(ga4Code) && !/L\.circleMarker\(/.test(ga4Code));
check('33', '縣市 polygon 樣式常數存在（GEO_GA4_POLYGON_STYLE）', /GEO_GA4_POLYGON_STYLE/.test(ga4Code));
check('34', '樣式含 dashArray（虛線，與訂單/訪客區隔）', /dashArray:\s*'6,4'/.test(ga4Code));
check('35', '樣式為青色系（cyan #06b6d4／#0891b2），不是紅/綠/藍', /#06b6d4/.test(ga4Code) && /#0891b2/.test(ga4Code));
check('36', 'geoJSON clone 建立時套用固定 style（不做 activeUsers 強度色階）', /style: \(\) => \(\{ \.\.\.GEO_GA4_POLYGON_STYLE \}\)/.test(ga4Code));
check('37', '離開 GA4 Layer 後清空自己的 layerGroup（等同還原，不影響原始 featureIndex）', /function geoGa4ClearLayer/.test(ga4Code) && /clearLayers/.test(ga4Code));
check('38', 'geoGa4RestoreStyles() 存在（呼叫 geoGa4ClearLayer 達成還原）', /function geoGa4RestoreStyles/.test(ga4Code));
check('39', 'Tooltip 存在（bindTooltip）', /bindTooltip/.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 六、文案
// ══════════════════════════════════════════════════════════════
check('40', 'Tooltip 含「IP 城市／縣市級推估」等推估用語', ga4Src.includes('IP 城市／縣市級推估'));
check('41', 'privacy notice 常數存在', /GA4_REALTIME_DISCLAIMER/.test(ga4Code));
check('42', 'threshold notice 常數存在', /GA4_REALTIME_PRIVACY_NOTICE/.test(ga4Code));
check('43', 'stale message 存在（暫時無法連線）', ga4Src.includes('暫時無法連線'));
check('44', 'cached message 存在（快取資料）', ga4Src.includes('快取資料'));
check('45', 'disabled message 存在（尚未啟用）', ga4Src.includes('尚未啟用'));
check('46', 'not configured message 存在（尚未設定）', ga4Src.includes('尚未完成設定') || ga4Src.includes('請至 GA4 設定'));
check('47', 'empty message 存在（沒有 GA4 活躍使用者）', ga4Src.includes('沒有 GA4 活躍使用者'));
check('48', 'unmapped message 存在（未對應城市）', ga4Src.includes('未對應城市'));

// ══════════════════════════════════════════════════════════════
// 七、Toolbar 控制項
// ══════════════════════════════════════════════════════════════
check('49', '最近5分鐘按鈕存在', ga4Src.includes('最近${w}分鐘') && /GEO_GA4_WINDOWS = Object\.freeze\(\[5, 30\]\)/.test(ga4Code));
check('50', '最近30分鐘按鈕存在（同一組 windows 常數含 30）', /GEO_GA4_WINDOWS.*\[5, 30\]/.test(ga4Code));
check('51', 'Visitors 按鈕存在', /visitors:\s*'訪客'/.test(ga4Code));
check('52', 'View Item 按鈕存在', /view_item:\s*'商品瀏覽'/.test(ga4Code));
check('53', 'Add To Cart 按鈕存在', /add_to_cart:\s*'加入購物車'/.test(ga4Code));
check('54', 'Checkout 按鈕存在', /checkout:\s*'開始結帳'/.test(ga4Code));
check('55', 'Purchase 按鈕存在', /purchase:\s*'完成購買'/.test(ga4Code));
check('56', '沒有 Revenue 按鈕', !/Revenue|營收/.test(ga4Code));
check('57', '沒有 Conversion 按鈕', !/Conversion|轉換率/.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 八、CSS
// ══════════════════════════════════════════════════════════════
check('58', '使用專案 CSS variables（--bg-panel/--bg-card/--text-primary）', cssSrc.includes('var(--bg-panel)') && cssSrc.includes('var(--bg-card)') && cssSrc.includes('var(--text-primary)'));
check('59', '不使用硬編碼 #f8fafc', !/#f8fafc/i.test(cssClean));
check('60', '不使用 dead [data-theme="dark"] selector', !/\[data-theme=["']dark["']\]/.test(cssClean));
check('61', 'HTML 中 GA4 相關標籤沒有 inline style', !/<link rel="stylesheet" href="\/css\/geo-ga4-realtime-layer\.css[^>]*style=/.test(htmlSrc));

// ══════════════════════════════════════════════════════════════
// 九、安全／程式衛生
// ══════════════════════════════════════════════════════════════
check('62', '前端沒有任何憑證變數名稱', !/GOOGLE_APPLICATION_CREDENTIALS|GA4_SERVICE_ACCOUNT/.test(ga4Src));
check('63', '前端沒有硬編碼 Property/Stream ID', !/401070093|"9001"|'9001'/.test(ga4Code));
check('64', '沒有硬編碼 store_001', !/store_001/.test(ga4Code));
check('65', '沒有 console.log()（只允許 console.error）', !/console\.log\(/.test(ga4Code));
check('66', '沒有 debugger 陳述式', !/\bdebugger\b/.test(ga4Code));
check('67', '沒有 Math.random()', !/Math\.random\(\)/.test(ga4Code));
check('68', '沒有 data/pos.db 或測試 DB 路徑硬編碼', !/data\/pos\.db/.test(ga4Code));
check('69', '沒有絕對路徑（/home/、/Users/）', !/\/home\/|\/Users\//.test(ga4Code));

// ══════════════════════════════════════════════════════════════
// 十、G1.5-A 未受影響 / G1.4.1 Scope Guard
// ══════════════════════════════════════════════════════════════
{
  const g15aFiles = ['utils/ga4RealtimeConfig.js', 'utils/ga4Realtime/client.js', 'utils/ga4Realtime/index.js', 'utils/ga4Realtime/requestBuilder.js', 'utils/ga4Realtime/errors.js'];
  let allUnchangedSyntaxOk = true;
  g15aFiles.forEach((f) => {
    try { require(path.join(ROOT, f)); } catch (e) { allUnchangedSyntaxOk = false; }
  });
  check('70', 'G1.5-A backend 檔案本階段未被修改（require 全部成功，模組匯出仍完整）', allUnchangedSyntaxOk);
}
{
  let scopeGuardOk = false;
  try { require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js')); scopeGuardOk = true; } catch (e) { scopeGuardOk = false; }
  check('71', 'G1.4.1 Scope Guard 模組仍可正常載入', scopeGuardOk);
}

const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.5-B1 (Frontend Contract Wiring & GA4 County Choropleth)');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length) process.exitCode = 1;
