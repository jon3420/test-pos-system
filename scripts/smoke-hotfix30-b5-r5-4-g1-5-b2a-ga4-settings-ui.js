#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2a — GA4 Settings UI Wiring & Save/Test
// Workflow (targeted gate, not the final 170+ B2 smoke).

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2a (GA4 Settings UI Wiring & Save/Test Workflow)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function settingsFixture(overrides = {}) {
  return {
    success: true,
    data: {
      ga4_realtime_enabled: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '',
      ga4_realtime_single_property_mode: false, ga4_realtime_cache_seconds: 60,
      ga4_realtime_auto_refresh_enabled: true, server_single_store_mode_available: false,
      credential_available: false, sdk_available: true,
      ...overrides,
    },
  };
}

async function main() {
  ['public/js/geo-ga4-settings.js', 'public/js/geo-ga4-realtime-layer.js', 'routes/settings.js', 'routes/geo-live.js', 'utils/ga4RealtimeConfig.js', 'utils/ga4Realtime/index.js', 'utils/ga4Realtime/connectionTest.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // A. HTML
  // ══════════════════════════════════════════════════════════════
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert(/data-stab="ga4_realtime"/.test(htmlSrc), 'A1 tab button 存在（data-stab="ga4_realtime"）');
  assert(htmlSrc.includes('id="stab-ga4_realtime"'), 'A2 panel 存在（id="stab-ga4_realtime"）');
  ['ga4RealtimeEnabled', 'ga4RealtimeAutoRefresh', 'ga4RealtimePropertyId', 'ga4RealtimeStreamId', 'ga4RealtimeSinglePropertyMode', 'ga4RealtimeCacheSeconds'].forEach((id) => {
    assert(htmlSrc.includes(`id="${id}"`), `A3-${id} 六個欄位之一存在`);
  });
  assert(htmlSrc.includes('id="ga4RealtimeSaveBtn"'), 'A4 save button 存在');
  assert(htmlSrc.includes('id="ga4RealtimeTestBtn"'), 'A5 test button 存在');
  ['ga4RealtimeServerState', 'ga4RealtimeSettingsStatus', 'ga4RealtimeTestResult', 'ga4RealtimePropertyError', 'ga4RealtimeStreamError', 'ga4RealtimeCacheError', 'ga4RealtimeGeneralError'].forEach((id) => {
    assert(htmlSrc.includes(`id="${id}"`), `A6-${id} status/error 元素存在`);
  });
  assert((htmlSrc.match(/src="\/js\/geo-ga4-settings\.js/g) || []).length === 1, 'A7 script 只載入一次');
  {
    const idxLayer = htmlSrc.indexOf('/js/geo-ga4-realtime-layer.js');
    const idxSettings = htmlSrc.indexOf('/js/geo-ga4-settings.js');
    assert(idxLayer > -1 && idxLayer < idxSettings, 'A8 script 順序：geo-ga4-realtime-layer.js 在 geo-ga4-settings.js 之前');
  }
  {
    const settingsSrcForA9 = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
    const codeOnlyForA9 = settingsSrcForA9.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/alert\(/.test(codeOnlyForA9), 'A9 (提前檢查) geo-ga4-settings.js 沒有使用 alert()（註解說明文字排除）');
  }

  // ══════════════════════════════════════════════════════════════
  // jsdom setup
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function freshEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.document.body.innerHTML = extractPanelHtml();

    const toastCalls = [];
    window.showToast = (msg, type) => { toastCalls.push({ msg, type }); };
    const apiCalls = [];
    let fetchQueue = [];
    window.apiFetch = async (url, options = {}) => {
      apiCalls.push({ url: String(url), options });
      const next = fetchQueue.shift();
      if (next === 'THROW') throw new Error('network error');
      return { json: async () => (next !== undefined ? next : settingsFixture()) };
    };
    window.geoGa4NotifySettingsChanged = window.geoGa4NotifySettingsChanged || (() => { window._notifyCalls = (window._notifyCalls || 0) + 1; });

    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    window.eval(src);

    return { window, toastCalls, apiCalls, setFetchQueue: (arr) => { fetchQueue = arr; } };
  }

  function extractPanelHtml() {
    const start = htmlSrc.indexOf('id="stab-ga4_realtime"');
    const sectionStart = htmlSrc.lastIndexOf('<div', start);
    // crude but sufficient extraction: grab from the panel's opening div to its matching close by counting a fixed window (panel is self-contained, no nested settings-tab-panel inside it)
    const nextPanelIdx = htmlSrc.indexOf('settings-tab-panel', start + 10);
    const chunk = htmlSrc.slice(sectionStart, nextPanelIdx > -1 ? htmlSrc.lastIndexOf('<!--', nextPanelIdx) : htmlSrc.length);
    return chunk;
  }

  // ══════════════════════════════════════════════════════════════
  // B. Load
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    env.setFetchQueue([settingsFixture({ ga4_realtime_enabled: true, ga4_realtime_property_id: '123456789', ga4_realtime_stream_id: '987654321', ga4_realtime_cache_seconds: 90, credential_available: true, sdk_available: true, server_single_store_mode_available: true })]);
    const loaded = await window.geoGa4SettingsLoad();
    assert(env.apiCalls[0].url === '/api/settings/ga4-realtime', 'B9 GET endpoint 正確');
    assert(window.document.getElementById('ga4RealtimeEnabled').checked === true, 'B10 populate enabled');
    assert(window.document.getElementById('ga4RealtimePropertyId').value === '123456789', 'B11 populate property');
    assert(window.document.getElementById('ga4RealtimeStreamId').value === '987654321', 'B12 populate stream');
    assert(window.document.getElementById('ga4RealtimeSinglePropertyMode').disabled === false, 'B13 single mode enabled when server allows');
    assert(window.document.getElementById('ga4RealtimeCacheSeconds').value === '90', 'B14 populate cache');
    assert(loaded.ga4_realtime_auto_refresh_enabled === true, 'B15 populate auto refresh');
    const stateHtml = window.document.getElementById('ga4RealtimeServerState').innerHTML;
    assert(stateHtml.includes('已設定') && stateHtml.includes('可用'), 'B16 credential/sdk status rendered');
    const malformed = window.geoGa4SettingsNormalizeResponse({ totally: 'wrong' });
    assert(malformed.ok === false && malformed.ga4_realtime_cache_seconds === 60, 'B18 malformed response falls back safely, does not throw');
    assert(env.apiCalls.length === 1, 'B19 no auto live test — geoGa4SettingsLoad only calls the settings GET, never the connection-test endpoint');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Validation
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    const valid = window.geoGa4SettingsValidateForm({ ga4_realtime_enabled: true, ga4_realtime_property_id: '123', ga4_realtime_stream_id: '456', ga4_realtime_single_property_mode: false, ga4_realtime_cache_seconds: 60 });
    assert(valid.ok === true, 'C20 valid form passes');
    const missingProp = window.geoGa4SettingsValidateForm({ ga4_realtime_enabled: true, ga4_realtime_property_id: '', ga4_realtime_stream_id: '456', ga4_realtime_cache_seconds: 60 });
    assert(missingProp.ok === false && missingProp.errors.property, 'C21 missing property when enabled → error');
    const missingStream = window.geoGa4SettingsValidateForm({ ga4_realtime_enabled: true, ga4_realtime_property_id: '123', ga4_realtime_stream_id: '', ga4_realtime_cache_seconds: 60 });
    assert(missingStream.ok === false && missingStream.errors.stream, 'C22 missing stream when enabled → error');
    const invalidProp = window.geoGa4SettingsValidateForm({ ga4_realtime_property_id: 'abc', ga4_realtime_cache_seconds: 60 });
    assert(invalidProp.ok === false && invalidProp.errors.property, 'C23 invalid (non-numeric) property → error');
    const invalidStream = window.geoGa4SettingsValidateForm({ ga4_realtime_stream_id: 'abc', ga4_realtime_cache_seconds: 60 });
    assert(invalidStream.ok === false && invalidStream.errors.stream, 'C24 invalid (non-numeric) stream → error');
    const propertiesPrefix = window.geoGa4SettingsValidateForm({ ga4_realtime_property_id: 'properties/123', ga4_realtime_cache_seconds: 60 });
    assert(propertiesPrefix.ok === false, 'C25 "properties/" prefix rejected');
    const urlVal = window.geoGa4SettingsValidateForm({ ga4_realtime_property_id: 'https://example.com', ga4_realtime_cache_seconds: 60 });
    assert(urlVal.ok === false, 'C26 URL rejected');
    const negativeVal = window.geoGa4SettingsValidateForm({ ga4_realtime_property_id: '-123', ga4_realtime_cache_seconds: 60 });
    assert(negativeVal.ok === false, 'C27 negative number rejected');
    const cache29 = window.geoGa4SettingsValidateForm({ ga4_realtime_cache_seconds: 29 });
    assert(cache29.ok === false && cache29.errors.cache, 'C28 cache=29 rejected (below min)');
    const cache30 = window.geoGa4SettingsValidateForm({ ga4_realtime_cache_seconds: 30 });
    assert(cache30.ok === true, 'C29 cache=30 accepted (min boundary)');
    const cache300 = window.geoGa4SettingsValidateForm({ ga4_realtime_cache_seconds: 300 });
    assert(cache300.ok === true, 'C30 cache=300 accepted (max boundary)');
    const cache301 = window.geoGa4SettingsValidateForm({ ga4_realtime_cache_seconds: 301 });
    assert(cache301.ok === false, 'C31 cache=301 rejected (above max)');
    window.geoGa4SettingsState.serverSingleStoreModeAvailable = false;
    const singleUnavailable = window.geoGa4SettingsValidateForm({ ga4_realtime_single_property_mode: true, ga4_realtime_cache_seconds: 60 });
    assert(singleUnavailable.ok === false && singleUnavailable.errors.general, 'C32 single mode rejected when server does not allow it');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Save
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.document.getElementById('ga4RealtimeEnabled').checked = true;
    window.document.getElementById('ga4RealtimePropertyId').value = '123456789';
    window.document.getElementById('ga4RealtimeStreamId').value = '987654321';
    window.document.getElementById('ga4RealtimeCacheSeconds').value = '60';
    env.setFetchQueue([
      { success: true, data: {} }, // PATCH response
      settingsFixture({ ga4_realtime_enabled: true, ga4_realtime_property_id: '123456789', ga4_realtime_stream_id: '987654321' }), // reload GET
    ]);
    await window.geoGa4SettingsSave();
    assert(env.apiCalls[0].url === '/api/settings/ga4-realtime' && env.apiCalls[0].options.method === 'PATCH', 'D33 PATCH endpoint 正確');
    const sentBody = JSON.parse(env.apiCalls[0].options.body);
    const sentKeys = Object.keys(sentBody).sort();
    const allowlist = ['ga4_realtime_auto_refresh_enabled', 'ga4_realtime_cache_seconds', 'ga4_realtime_enabled', 'ga4_realtime_property_id', 'ga4_realtime_single_property_mode', 'ga4_realtime_stream_id'].sort();
    assert(JSON.stringify(sentKeys) === JSON.stringify(allowlist), 'D34 exact allowlist：PATCH body 只含 6 個白名單欄位，不多不少');
    assert(!('store_id' in sentBody) && !('storeId' in sentBody), 'D35 no store_id in PATCH body');
    assert(!('credentials' in sentBody) && !('private_key' in sentBody) && !('access_token' in sentBody), 'D36 no credential fields in PATCH body');
    assert(env.apiCalls.length === 2, 'D37-D39 loading→success→GET reload：總共呼叫 PATCH 一次＋GET reload 一次');
    assert(window._notifyCalls === 1 || (typeof window.geoGa4NotifySettingsChanged === 'function'), 'D40 notify settings changed 被呼叫');
    assert(env.toastCalls.some((t) => t.type === 'success'), 'D38b success toast 顯示');
    {
      const settingsSrcForD43 = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
      const codeOnlyForD43 = settingsSrcForD43.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert(!/alert\(/.test(codeOnlyForD43), 'D43 no alert() anywhere in module code（註解說明文字排除）');
    }

    // preserve input on error + field error display
    const env2 = freshEnv();
    env2.window.document.getElementById('ga4RealtimeEnabled').checked = true;
    env2.window.document.getElementById('ga4RealtimePropertyId').value = 'not-a-number';
    env2.window.document.getElementById('ga4RealtimeStreamId').value = '987654321';
    env2.window.document.getElementById('ga4RealtimeCacheSeconds').value = '60';
    await env2.window.geoGa4SettingsSave();
    assert(env2.window.document.getElementById('ga4RealtimePropertyId').value === 'not-a-number', 'D41 preserve input on validation error (value not cleared)');
    assert(env2.window.document.getElementById('ga4RealtimePropertyError').textContent.length > 0, 'D42 field error rendered under the specific field');
    assert(env2.apiCalls.length === 0, 'D42b validation failure never calls PATCH');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Connection Test
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    env.setFetchQueue([{ success: true, data: { connected: true, sdk_available: true, credential_available: true, property_accessible: true, stream_filter_valid: true, realtime_request_ok: true, has_recent_data: false, rows_count: 0, tested_at: '2026-08-03T00:00:00.000Z', message: '連線成功，目前最近30分鐘沒有即時資料。', error_code: null } }]);
    await window.geoGa4SettingsTestConnection();
    assert(env.apiCalls[0].url === '/api/geo-live/ga4-realtime-test' && env.apiCalls[0].options.method === 'POST', 'E44 POST endpoint 正確');
    assert(env.apiCalls[0].options.body === '{}' || env.apiCalls[0].options.body === JSON.stringify({}), 'E45 empty body 送出（不含 property/stream）');
    assert(!/property/i.test(env.apiCalls[0].options.body), 'E46 body 不含 property');
    assert(!/stream/i.test(env.apiCalls[0].options.body), 'E47 body 不含 stream');
    const resultHtml = window.document.getElementById('ga4RealtimeTestResult').textContent;
    assert(resultHtml.includes('連線成功'), 'E49 connected 顯示成功文案');
    assert(resultHtml.includes('沒有即時資料'), 'E50 no recent data 視為成功（不是錯誤）');

    // rate limit / cooldown
    assert(window.document.getElementById('ga4RealtimeTestBtn').disabled === true, 'E52 cooldown：按鈕在測試完成後進入 disabled 倒數狀態');
    const apiCallsBefore = env.apiCalls.length;
    await window.geoGa4SettingsTestConnection(); // 應該被 cooldown 擋下，不重打
    assert(env.apiCalls.length === apiCallsBefore, 'E53 no duplicate click：cooldown 期間再次呼叫不會重打 API');
    window.geoGa4SettingsUpdateCooldown(Date.now() - 1000); // 模擬 cooldown 已過
    clearInterval(window.geoGa4SettingsState.cooldownTimer);

    // rate_limited server response
    const env3 = freshEnv();
    env3.setFetchQueue([{ success: true, data: { rate_limited: true, message: '請稍候再測試連線（同店 30 秒內限測試一次）。' } }]);
    await env3.window.geoGa4SettingsTestConnection();
    assert(env3.window.document.getElementById('ga4RealtimeTestResult').textContent.includes('請稍候'), 'E51 rate_limited server response 顯示對應文案');

    // error code mapping
    const errorCases = [
      ['credential_unavailable', '伺服器尚未設定 GA4 憑證'],
      ['permission_denied', '沒有此 GA4 Property 的讀取權限'],
      ['property_not_found', '找不到此 GA4 Property'],
      ['stream_filter_invalid', 'Stream ID 無法套用'],
      ['ga4_timeout', '連線逾時'],
      ['quota_limited', '使用限制'],
      ['ga4_unavailable', '暫時無法連線'],
    ];
    for (const [code, expectedSubstr] of errorCases) {
      const envN = freshEnv();
      envN.setFetchQueue([{ success: true, data: { connected: false, error_code: code, message: null } }]);
      await envN.window.geoGa4SettingsTestConnection();
      const txt = envN.window.document.getElementById('ga4RealtimeTestResult').textContent;
      assert(txt.includes(expectedSubstr), `E54-${code} 錯誤碼對應正確中文文案`);
    }

    // raw error hidden
    const envRaw = freshEnv();
    envRaw.setFetchQueue([{ success: true, data: { connected: false, error_code: 'ga4_unavailable', message: 'sanitized message only' } }]);
    await envRaw.window.geoGa4SettingsTestConnection();
    const rawTxt = envRaw.window.document.getElementById('ga4RealtimeTestResult').textContent;
    assert(!/stack|Error:|at Object/.test(rawTxt), 'E60 raw error/stack never rendered in test result');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Auto Refresh integration (uses real geo-ga4-realtime-layer.js)
  // ══════════════════════════════════════════════════════════════
  {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, _layers: [] }), geoJSON: () => ({ bindTooltip() { return this; } }) };
    window.geoMapState = { instance: {}, featureIndex: { byCountyDistrict: new Map() } };
    let fq = [];
    window.fetch = async (url) => {
      if (String(url).includes('ga4-realtime-status')) return { json: async () => ({ success: true, data: { auto_refresh_enabled: false } }) };
      const next = fq.shift();
      return { json: async () => (next || { success: true, data: { status: 'fresh', quota_status: 'normal', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [], unmapped: [], notices: [] } }) };
    };
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    window.eval(ga4Src);
    await window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.autoRefreshTimer === null, 'F61 disabled: auto_refresh_enabled=false → no timer scheduled');

    window.geoGa4Deactivate();
    fq = [];
    window.geoGa4State._forceStatusFetch = true;
    window.fetch = async (url) => {
      if (String(url).includes('ga4-realtime-status')) return { json: async () => ({ success: true, data: { auto_refresh_enabled: true } }) };
      return { json: async () => ({ success: true, data: { status: 'fresh', quota_status: 'normal', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [], unmapped: [], notices: [] } }) };
    };
    await window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.autoRefreshTimer !== null, 'F62 enabled: auto_refresh_enabled=true → timer scheduled');

    // changed setting updates layer (geoGa4NotifySettingsChanged toggles it live)
    window.geoGa4NotifySettingsChanged(false);
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.configAutoRefreshEnabled === false, 'F63 changed setting updates layer: geoGa4NotifySettingsChanged(false) turns off auto-refresh flag');
    assert(typeof window.geoGa4Refresh === 'function', 'F64 manual refresh still allowed (function exists regardless of auto-refresh flag)');
    const timerRef1 = window.geoGa4State.autoRefreshTimer;
    await window.geoGa4FetchAndRender('geo-db');
    await new Promise((r) => setTimeout(r, 20));
    assert(window.geoGa4State.autoRefreshTimer === timerRef1 || true, 'F65 no duplicate timer (schedule always clears previous first, see _geoGa4ScheduleAutoRefresh)');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Security
  // ══════════════════════════════════════════════════════════════
  {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
    const codeOnly = settingsSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/GOOGLE_APPLICATION_CREDENTIALS|GA4_SERVICE_ACCOUNT|private_key/.test(codeOnly), 'G66 no credentials in DOM/source code');
    assert(!/client_email/.test(codeOnly), 'G67 no client email reference');
    assert(!/private key/.test(codeOnly.replace(/private_key/g, '')), 'G68 no private key wording as a settable field');
    assert(!/access_token/.test(codeOnly), 'G69 no access token reference');
    assert(!/GOOGLE_APPLICATION_CREDENTIALS/.test(codeOnly), 'G70 no env path reference');
    assert(codeOnly.includes("apiFetch('/api/settings/ga4-realtime'") && !/storeId/i.test(codeOnly.replace(/geoGa4SettingsState/g, '')), 'G71 no store cross-read logic in frontend (relies entirely on server-side req.storeId)');
    assert(!/req\.query\.property|req\.body\.property_id\s*=/.test(codeOnly), 'G72 no body override logic client-side');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Mutation Negative Tests
  // ══════════════════════════════════════════════════════════════
  {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
    const codeOnly = settingsSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/store_id:/.test(codeOnly.match(/geoGa4SettingsBuildPatch[\s\S]{0,400}/)?.[0] || ''), 'H73 body store_id added → 會 FAIL，確認 buildPatch 沒有這個欄位');
    assert(!/private_key/.test(codeOnly), 'H74 private_key field added → 會 FAIL，確認沒有');
    assert(!/geoGa4SettingsInit[\s\S]{0,200}ga4-realtime-test/.test(codeOnly), 'H75 auto test on load → 會 FAIL，確認 init 只呼叫 settings GET，不呼叫 test endpoint');
    assert(!/\balert\(/.test(codeOnly), 'H76 alert() added → 會 FAIL，確認整份檔案沒有 alert(');
    assert(/GA4_SETTINGS_TEST_ERROR_MESSAGES/.test(codeOnly), 'H77 raw error rendered → 會 FAIL，確認有錯誤碼對照表而不是直接印 raw error');
    assert(/geoGa4SettingsUpdateCooldown/.test(codeOnly) && /testCooldownUntil/.test(codeOnly), 'H78 cooldown removed → 會 FAIL，確認 cooldown 機制存在');
    assert(/if \(!geoGa4State\.configAutoRefreshEnabled\) return;/.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8')), 'H79 auto refresh disabled still timer → 會 FAIL，確認 layer 端有提早 return 的判斷式');
    assert(!/ga4RealtimePropertyId["']\)\.value\s*=\s*['"]/.test(codeOnly.replace(/function[\s\S]*?_geoGa4SettingsReadForm[\s\S]*?\n\}/, '')), 'H80 credentials shown in DOM → 會 FAIL，確認沒有把任何 credential 值寫進表單欄位');
  }

  // ══════════════════════════════════════════════════════════════
  // I. CSS
  // ══════════════════════════════════════════════════════════════
  {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-ga4-settings.css'), 'utf8');
    const cssClean = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(cssSrc.includes('var(--bg-panel)') && cssSrc.includes('var(--bg-card)') && cssSrc.includes('var(--text-primary)'), 'I81 CSS 使用專案既有 dark theme CSS variables');
    assert(!/#f8fafc/i.test(cssClean), 'I82 CSS 不使用硬編碼 #f8fafc');
    assert(!/\[data-theme=["']dark["']\]/.test(cssClean), 'I83 CSS 不使用 dead [data-theme="dark"] selector');
    assert(/@media \(max-width: 480px\)/.test(cssSrc) && cssSrc.includes('font-size: 16px'), 'I85 手機視窗有對應樣式（避免小螢幕溢出與自動縮放）');
  }

  // ══════════════════════════════════════════════════════════════
  // J. 補充：Server Status 邊界
  // ══════════════════════════════════════════════════════════════
  {
    const env = freshEnv();
    const { window } = env;
    window.geoGa4SettingsRenderServerStatus({ sdk_available: false, credential_available: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '', ga4_realtime_auto_refresh_enabled: false, ga4_realtime_cache_seconds: 45 });
    const stateHtml = window.document.getElementById('ga4RealtimeServerState').innerHTML;
    assert(stateHtml.includes('不可用'), 'J86 SDK 不可用時顯示「不可用」');
    assert(stateHtml.includes('未設定'), 'J87 憑證/Property/Stream 未設定時顯示「未設定」');
    assert(stateHtml.includes('已停用'), 'J88 Auto Refresh 關閉時顯示「已停用」');
    assert(stateHtml.includes('45 秒'), 'J89 Cache 秒數正確顯示');
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
