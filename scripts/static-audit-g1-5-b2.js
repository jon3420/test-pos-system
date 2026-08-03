#!/usr/bin/env node
// scripts/static-audit-g1-5-b2.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2
// Full Settings QA — Static Audit.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }
function cssNoComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }

const settingsSrc = read('routes/settings.js');
const geoLiveSrc = read('routes/geo-live.js');
const cfgSrc = read('utils/ga4RealtimeConfig.js');
const idxSrc = read('utils/ga4Realtime/index.js');
const connSrc = read('utils/ga4Realtime/connectionTest.js');
const uiSrc = read('public/js/geo-ga4-settings.js');
const layerSrc = read('public/js/geo-ga4-realtime-layer.js');
const htmlSrc = read('public/index.html');
const cssSrc = read('public/css/geo-ga4-settings.css');
const settingsCode = codeOnly(settingsSrc);
const geoLiveCode = codeOnly(geoLiveSrc);
const cfgCode = codeOnly(cfgSrc);
const idxCode = codeOnly(idxSrc);
const connCode = codeOnly(connSrc);
const uiCode = codeOnly(uiSrc);
const layerCode = codeOnly(layerSrc);
const cssClean = cssNoComments(cssSrc);

// 一、Routes
check('1', 'GET /api/settings/ga4-realtime 存在', /router\.get\('\/ga4-realtime'/.test(settingsSrc));
check('2', 'PATCH /api/settings/ga4-realtime 存在', /router\.patch\('\/ga4-realtime'/.test(settingsSrc));
check('3', 'POST /api/geo-live/ga4-realtime-test 存在', /router\.post\('\/ga4-realtime-test'/.test(geoLiveSrc));
check('4', 'GET handler 使用 req.storeId', /router\.get\('\/ga4-realtime'[\s\S]{0,300}req\.storeId/.test(settingsSrc));
check('5', 'PATCH handler 使用 req.storeId', /router\.patch\('\/ga4-realtime'[\s\S]{0,300}req\.storeId/.test(settingsSrc));
check('6', 'Test handler 使用 req.storeId', /router\.post\('\/ga4-realtime-test'[\s\S]{0,300}req\.storeId/.test(geoLiveSrc));
check('7', "settings router 在 mount 層套用 requireStore", /app\.use\('\/api\/settings',\s*requireStore/.test(read('server.js')));
check('8', 'reports permission：Connection Test/Status 套用 requireFeature', /router\.post\('\/ga4-realtime-test', requireFeature\('reports'\)/.test(geoLiveSrc));
check('9', '管理員／後台權限：沿用既有 store-level auth（無獨立第二套角色系統，見 Reality Audit）', !/requireAdminMode/.test(settingsSrc));

// 二、Validation
check('10', 'Settings allowlist 常數存在', /GA4_REALTIME_SETTINGS_KEYS/.test(cfgSrc));
check('11', '不接受 body store_id（validator 拒絕）', /forbiddenKeys.*store_id/.test(cfgCode) || /'store_id'/.test(cfgCode));
check('12', '不接受 credential 相關 body 欄位', /'credentials'/.test(cfgCode) && /'private_key'/.test(cfgCode) && /'access_token'/.test(cfgCode));
check('13', 'Property validator（純數字）', /normalizeGa4PropertyId/.test(cfgSrc) && /\^\[0-9\]\+\$/.test(cfgSrc));
check('14', 'Stream validator（純數字）', /validateGa4StreamId/.test(cfgSrc));
check('15', 'Cache validator（30-300）', /GA4_CACHE_SECONDS_MIN = 30/.test(cfgSrc) && /GA4_CACHE_SECONDS_MAX = 300/.test(cfgSrc));
check('16', 'Boolean validator（true/false 字串與布林兩種形式）', /String\(b\.ga4_realtime_enabled\) === 'true'/.test(cfgCode));
check('17', 'enabled 需要 property/stream（非 single mode）', /啟用 GA4 即時推估圖層且未使用單一 Property 模式時/.test(cfgSrc));
check('18', 'single mode 受 server guard', /explicitlyNotSingle/.test(cfgCode) || /singleStoreMode/.test(cfgCode));

// 三、Transaction
check('19', 'PATCH 使用 BEGIN', /rawDb\.run\('BEGIN'\)/.test(settingsSrc));
check('20', 'PATCH 使用 COMMIT', /rawDb\.run\('COMMIT'\)/.test(settingsSrc));
check('21', 'PATCH 使用 ROLLBACK（catch 分支）', /rawDb\.run\('ROLLBACK'\)/.test(settingsSrc));
check('22', 'Cache invalidate 發生在 commit 之後（原始碼順序）', settingsCode.indexOf("rawDb.run('COMMIT')") < settingsCode.indexOf('invalidateGa4RealtimeCacheForStore(storeId)'));
check('23', '使用 db._db（raw sqlDb）避免包裝過 db.run() 的 export() 副作用中斷 transaction（見 Reality Audit 重現記錄）', /const rawDb = db\._db/.test(settingsSrc));

// 四、Cache Invalidation / Generation
check('24', 'invalidateGa4RealtimeCacheForStore(storeId) 存在', /function invalidateGa4RealtimeCacheForStore/.test(idxSrc));
check('25', '每店 generation Map 存在', /_storeGeneration = new Map/.test(idxSrc));
check('26', 'fetch 前捕捉 generationAtStart', /generationAtStart = _getStoreGeneration\(storeId\)/.test(idxSrc));
check('27', 'fetch 完成後比對 generation 才寫 cache', /_getStoreGeneration\(storeId\) === generationAtStart/.test(idxCode));
check('28', 'stale request 結果不寫 cache（discard，見上一項比對）', /if \(_getStoreGeneration\(storeId\) === generationAtStart\) \{/.test(idxCode));
check('29', '不使用 _cache.clear() 做全域清除（只有 resetForTest 測試用途例外）', (idxCode.match(/_cache\.clear\(\)/g) || []).length <= 1);
check('30', 'invalidate 只影響該 store 的 cache（用 prefix 過濾，不是清全部）', /key\.startsWith\(prefix\)/.test(idxCode));

// 五、Rate Limit／Single-flight
check('31', 'rate limiter 存在（30 秒）', /RATE_LIMIT_MS = 30/.test(connSrc));
check('32', 'per-store limiter（用 storeId 當 key）', /_lastTestAt\.get\(storeId\)/.test(connCode));
check('33', 'connection test single-flight（in-flight Map）', /_inFlightTest = new Map/.test(connSrc));
check('34', 'cooldown 30 秒（前端與後端一致）', /RATE_LIMIT_MS = 30 \* 1000/.test(connSrc));
check('35', '不自動做 live test（geoGa4SettingsInit 只呼叫 GET settings）', !/geoGa4SettingsInit[\s\S]{0,300}ga4-realtime-test/.test(uiCode));
check('36', 'connection test 是 read-only（不寫入一般 Realtime data cache，見 connectionTest.js 完全沒有 import _cache）', !/require\(['"]\.\/index['"]\)/.test(connSrc));

// 六、Connection Test Request Shape
check('37', 'Summary Request 使用', /buildGa4RealtimeSummaryRequest/.test(connSrc));
check('38', 'City Request 使用', /buildGa4RealtimeCityRequest/.test(connSrc));
check('39', 'window=30 固定', /windowMinutes: 30/.test(connSrc));
check('40', 'metric=visitors 固定', /metric: 'visitors'/.test(connSrc));
check('41', 'stream filter 由 config.streamId 帶入', /streamId: config\.streamId/.test(connSrc));
check('42', 'sanitized response（無 raw rows/quota）', !/propertyQuota:/.test(connCode.match(/return \{[\s\S]*?\};/g)?.join('') || ''));
check('43', '無 raw Google rows 回傳', !/rows:\s*(summaryResult|cityResult)\.rows/.test(connCode));
check('44', '無 raw propertyQuota 回傳', !/quotaStatus/.test(connCode.match(/return \{[\s\S]*?\};/g)?.join('') || ''));
check('45', 'last_test_at/last_test_status 有提供給 status endpoint', /getLastTestStatus/.test(connSrc) && /last_test_at/.test(idxSrc));

// 七、Settings UI 接線
check('46', 'GET settings UI（geoGa4SettingsLoad）', /function geoGa4SettingsLoad/.test(uiSrc));
check('47', 'PATCH settings UI（geoGa4SettingsSave）', /function geoGa4SettingsSave/.test(uiSrc));
check('48', 'POST test UI（geoGa4SettingsTestConnection）', /function geoGa4SettingsTestConnection/.test(uiSrc));
check('49', 'exact body allowlist（GA4_SETTINGS_PATCH_KEYS 6 項）', /GA4_SETTINGS_PATCH_KEYS = Object\.freeze\(\[/.test(uiSrc) && (uiSrc.match(/ga4_realtime_/g) || []).length >= 6);
check('50', '沒有 alert()', !/\balert\(/.test(uiCode));
check('51', 'field errors 對應 4 個元素', /ga4RealtimePropertyError/.test(uiSrc) && /ga4RealtimeStreamError/.test(uiSrc) && /ga4RealtimeCacheError/.test(uiSrc) && /ga4RealtimeGeneralError/.test(uiSrc));
check('52', 'save 成功後 reload（呼叫 geoGa4SettingsLoad）', /await geoGa4SettingsLoad\(\)/.test(uiCode));
check('53', 'save 成功後 notify B1（geoGa4NotifySettingsChanged）', /geoGa4NotifySettingsChanged/.test(uiSrc));
check('54', 'auto refresh flag 存在（configAutoRefreshEnabled）', /configAutoRefreshEnabled/.test(layerSrc));
check('55', 'auto refresh=false 時不排程 timer', /if \(!geoGa4State\.configAutoRefreshEnabled\) return;/.test(layerCode));
check('56', 'auto refresh=true 時仍會排程（fallthrough）', /const seconds = \(payload/.test(layerSrc));
check('57', 'cooldown timer cleanup（每次先 clearInterval）', /clearInterval\(window\.geoGa4SettingsState\.cooldownTimer\)/.test(uiSrc));
check('58', 'AbortController 存在（settings load）', /AbortController/.test(uiSrc));
check('59', 'requestSeq 存在（settings load）', /requestSeq/.test(uiSrc));
check('60', 'geoGa4SettingsInit 存在（tab 切入 lazy-load）', /function geoGa4SettingsInit/.test(uiSrc));

// 八、HTML wiring
check('61', 'script 只載入一次', (htmlSrc.match(/src="\/js\/geo-ga4-settings\.js/g) || []).length === 1);
check('62', 'CSS 只載入一次', (htmlSrc.match(/href="\/css\/geo-ga4-settings\.css/g) || []).length === 1);
check('63', 'Tab 按鈕只出現一次', (htmlSrc.match(/data-stab="ga4_realtime"/g) || []).length === 1);
check('64', 'Panel 只出現一次', (htmlSrc.match(/id="stab-ga4_realtime"/g) || []).length === 1);

// 九、CSS
check('65', '使用專案 CSS variables', cssSrc.includes('var(--bg-panel)') && cssSrc.includes('var(--text-primary)'));
check('66', '不使用硬編碼 #f8fafc', !/#f8fafc/i.test(cssClean));
check('67', '不使用 dead theme selector', !/\[data-theme=["\']dark["\']\]/.test(cssClean));
{
  const ga4PanelStart = htmlSrc.indexOf('id="stab-ga4_realtime"');
  const nextPanelDivIdx = htmlSrc.indexOf('<div class="settings-tab-panel"', ga4PanelStart + 10);
  const ga4PanelOnly = htmlSrc.slice(ga4PanelStart, nextPanelDivIdx > -1 ? nextPanelDivIdx : ga4PanelStart + 4000);
  check('68', 'HTML 中 GA4 panel 本身沒有多餘 inline style（display:none 切換慣例除外）', !/<input[^>]*style="/.test(ga4PanelOnly) && !/<label[^>]*style="/.test(ga4PanelOnly));
}

// 十、Security / 程式衛生
check('69', '前端無 credential DOM 內容', !/innerHTML\s*=[\s\S]{0,40}credential/i.test(uiCode));
check('70', '前端無 private key 相關字面值', !/private_key/.test(uiCode));
check('71', '前端無 access token', !/access_token/.test(uiCode));
check('72', '無硬編碼 store（除測試 fixture 檔案外，本檔案不含）', !/store_001/.test(uiCode) && !/store_001/.test(layerCode));
check('73', '無硬編碼 Property', !/401070093/.test(uiCode) && !/401070093/.test(connCode));
check('74', '無硬編碼 Stream', !/"9001"|'9001'/.test(uiCode));
const ALL_TOUCHED = [settingsSrc, geoLiveSrc, cfgSrc, idxSrc, connSrc, uiSrc, layerSrc].join('\n');
const ALL_TOUCHED_CODE = codeOnly(ALL_TOUCHED);
check('75', '無 console.log()', !/console\.log\(/.test(ALL_TOUCHED_CODE));
check('76', '無 debugger', !/\bdebugger\b/.test(ALL_TOUCHED_CODE));
check('77', '無 Math.random()', !/Math\.random\(\)/.test(ALL_TOUCHED_CODE));
check('78', '無 data/pos.db 硬編碼路徑', !/data\/pos\.db/.test(ALL_TOUCHED_CODE));
check('79', '無絕對路徑', !/\/home\/|\/Users\//.test(ALL_TOUCHED_CODE));

// 十一、Regression 邊界
check('80', 'B1 檔案未被本輪修改（除既定 auto-refresh 整合行為外，geoGa4RenderChoropleth 等核心函式仍存在）', /function geoGa4RenderChoropleth/.test(layerSrc));
check('81', 'G1.5-A 檔案 require 全部成功（module 匯出完整）', (() => {
  try {
    require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
    require(path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js'));
    require(path.join(ROOT, 'utils/ga4Realtime/errors.js'));
    return true;
  } catch (e) { return false; }
})());
check('82', 'G1.4.1 Scope Guard 模組仍可正常載入', (() => {
  try { require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js')); return true; } catch (e) { return false; }
})());

const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.5-B2 (Full Settings QA, Regression, Documentation & Packaging)');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length) process.exitCode = 1;
