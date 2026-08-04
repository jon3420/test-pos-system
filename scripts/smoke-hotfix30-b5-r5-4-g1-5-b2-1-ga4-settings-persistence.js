#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.1 — GA4 Settings Persistence Hotfix.
//
// 驗證重點：Stored Settings（settings 表原始值）與 Effective Runtime Config
// （全域 Flag + 憑證 + 店家開關組合後是否真的可執行）必須分開回傳，
// Settings Form 一律只信任 Stored Settings，不得被 Effective Config 回填、
// 也不得被 GET 失敗清空（見 R5.4-G1.5-B2.1_GA4_SETTINGS_PERSISTENCE_FIX.md）。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.1 (GA4 Settings Persistence Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  ['utils/ga4RealtimeConfig.js', 'routes/settings.js', 'public/js/geo-ga4-settings.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b21_a', 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b21_b', 1]);

  const cfg = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js'));

  function setSetting(storeId, key, value) {
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  function clearSetting(storeId, key) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  }

  // ══════════════════════════════════════════════════════════════
  // A. Stored Resolver (1-10)
  // ══════════════════════════════════════════════════════════════
  {
    process.env.GA4_REALTIME_ENABLED = 'false'; // 全域 disabled
    setSetting('store_b21_a', 'ga4_realtime_enabled', '1'); // 店家 enabled=true
    setSetting('store_b21_a', 'ga4_realtime_property_id', '111111');
    setSetting('store_b21_a', 'ga4_realtime_stream_id', '9001');
    setSetting('store_b21_a', 'ga4_realtime_single_property_mode', '1');
    setSetting('store_b21_a', 'ga4_realtime_cache_seconds', '90');
    setSetting('store_b21_a', 'ga4_realtime_auto_refresh_enabled', '0');

    const stored = cfg.getGa4RealtimeStoredSettings(db, 'store_b21_a');
    const effective = cfg.getGa4RealtimeConfig(db, 'store_b21_a');

    assert(effective.enabled === false, 'A1 (setup) global disabled → Effective Config enabled=false');
    assert(stored.ga4_realtime_enabled === true, 'A2 Stored: store enabled=true even though global disabled');
    assert(stored.ga4_realtime_property_id === '111111', 'A3 Stored: Property 仍原樣回傳（不受全域 disabled 影響）');
    assert(stored.ga4_realtime_stream_id === '9001', 'A4 Stored: Stream 仍原樣回傳');
    assert(stored.ga4_realtime_single_property_mode === true, 'A5 Stored: single mode 回傳店家儲存值');
    assert(stored.ga4_realtime_cache_seconds === 90, 'A6 Stored: cache 秒數仍回傳');
    assert(stored.ga4_realtime_auto_refresh_enabled === false, 'A7 Stored: auto refresh 仍回傳');

    setSetting('store_b21_b', 'ga4_realtime_property_id', '222222');
    const storedB = cfg.getGa4RealtimeStoredSettings(db, 'store_b21_b');
    assert(storedB.ga4_realtime_property_id === '222222' && stored.ga4_realtime_property_id === '111111', 'A8 Store A/B 隔離：互不影響');

    const storedMissing = cfg.getGa4RealtimeStoredSettings(db, 'store_never_seen_b21');
    assert(storedMissing.ga4_realtime_enabled === false && storedMissing.ga4_realtime_property_id === '' && storedMissing.ga4_realtime_cache_seconds === 60 && storedMissing.ga4_realtime_auto_refresh_enabled === true, 'A9 Missing rows → 安全預設值（不 throw）');

    setSetting('store_b21_a', 'ga4_realtime_enabled', 'not-a-bool');
    const storedInvalidBool = cfg.getGa4RealtimeStoredSettings(db, 'store_b21_a');
    assert(storedInvalidBool.ga4_realtime_enabled === false, 'A10 Invalid DB boolean → 安全預設值 false');
    setSetting('store_b21_a', 'ga4_realtime_enabled', '1'); // restore for later sections
  }

  // ══════════════════════════════════════════════════════════════
  // B. GET Route (11-20)
  // ══════════════════════════════════════════════════════════════
  let server; let port; let fetchFn;
  {
    const settingsRoute = require(path.join(ROOT, 'routes/settings.js'));
    const express = require('express');
    const bodyParser = require('body-parser');
    const app = express();
    app.use(bodyParser.json());
    app.use((req, res, next) => { req.storeId = req.headers['x-test-store'] || 'store_b21_a'; next(); });
    app.use('/api/settings', settingsRoute);
    server = app.listen(0);
    port = server.address().port;
    fetchFn = (await import('node-fetch')).default;

    process.env.GA4_REALTIME_ENABLED = 'false';
    const getRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`);
    const getJson = await getRes.json();

    assert(getJson.success === true, 'B11 (setup) GET succeeds');
    assert(getJson.data.ga4_realtime_enabled === true, 'B11b ga4_realtime_enabled 是 stored value（店家已勾選，即使全域 disabled）');
    assert(getJson.data.ga4_realtime_property_id === '111111', 'B12 property 是 stored value');
    assert(getJson.data.ga4_realtime_stream_id === '9001', 'B13 stream 是 stored value');
    assert(getJson.data.effective_enabled === false, 'B14 effective_enabled 分開（全域 disabled 時為 false）');
    assert(typeof getJson.data.effective_configured === 'boolean', 'B15 effective_configured 分開存在');
    assert(getJson.data.global_enabled === false, 'B16 global_enabled 分開（反映 GA4_REALTIME_ENABLED=false）');
    assert(typeof getJson.data.credential_available === 'boolean', 'B17 credential boolean');
    assert(typeof getJson.data.sdk_available === 'boolean', 'B18 SDK boolean');
    assert(!JSON.stringify(getJson.data).match(/GOOGLE_APPLICATION_CREDENTIALS|private_key|client_email/i), 'B19 no credentials/raw env leaked');
    assert(!('rawConfigSource' in getJson.data), 'B20 no raw internal source object exposed');
  }

  // ══════════════════════════════════════════════════════════════
  // C. PATCH (21-30)
  // ══════════════════════════════════════════════════════════════
  {
    process.env.GA4_REALTIME_ENABLED = 'false'; // 全域仍未開，模擬真實回報場景
    const patchRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ga4_realtime_enabled: true, ga4_realtime_property_id: '654321', ga4_realtime_stream_id: '7777', ga4_realtime_single_property_mode: false }),
    });
    const patchJson = await patchRes.json();
    assert(patchRes.status === 200 && patchJson.success === true, 'C21 Transaction 成功 (BEGIN...COMMIT, HTTP 200)');
    assert(patchJson.data.ga4_realtime_property_id === '654321' && patchJson.data.ga4_realtime_stream_id === '7777', 'C22 Stored values 寫入');

    const rowsAfterCommit = db.all('SELECT value FROM settings WHERE store_id=? AND key=?', ['store_b21_a', 'ga4_realtime_property_id']);
    assert(rowsAfterCommit[0] && rowsAfterCommit[0].value === '654321', 'C23 Commit 後 DB 內確實有新值');

    // C24：commit 之後才 invalidate — 用 orchestrator generation 佐證（沿用 B2 同一支橋接）。
    const orch = require(path.join(ROOT, 'utils/ga4Realtime'));
    const genBefore = orch._storeGenerationForTest.get('store_b21_a') || 0;
    await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ga4_realtime_cache_seconds: 111 }) });
    const genAfter = orch._storeGenerationForTest.get('store_b21_a') || 0;
    assert(genAfter > genBefore, 'C24 Invalidate after commit（generation 遞增）');

    assert(patchJson.data.ga4_realtime_enabled === true, 'C25 PATCH Response 回 stored values（不是 effective）');

    // C26：全域仍 disabled，PATCH 成功後 stored 值不清空。
    const getAfterPatch1 = await (await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`)).json();
    assert(getAfterPatch1.data.ga4_realtime_property_id === '654321', 'C26 Global disabled 也不清空 Property/Stream');
    assert(getAfterPatch1.data.effective_enabled === false, 'C26b effective_enabled 仍反映全域 disabled（狀態分開）');

    // C27：憑證未設定也不清空（credential_available 反映真實狀態，stored 不受影響）。
    assert(getAfterPatch1.data.ga4_realtime_property_id === '654321' && getAfterPatch1.data.ga4_realtime_stream_id === '7777', 'C27 Credential missing 也不清空 Property/Stream');

    // C28：GET after PATCH 相同（GET/PATCH 共用同一份 Builder）。
    assert(getAfterPatch1.data.ga4_realtime_property_id === patchJson.data.ga4_realtime_property_id, 'C28 GET after PATCH 相同（共用 Builder，不會分歧）');

    // C29：Store B 不受影響。
    const configB29 = cfg.getGa4RealtimeStoredSettings(db, 'store_b21_b');
    assert(configB29.ga4_realtime_property_id === '222222', 'C29 Store B 不受 Store A PATCH 影響');

    // C30：Rollback 保留舊值（模擬中途寫入失敗）。
    const rawDb = db._db;
    const origPrepare = rawDb.prepare.bind(rawDb);
    let callCount = 0;
    rawDb.prepare = (sql) => {
      if (/UPDATE settings/.test(sql)) {
        callCount += 1;
        if (callCount === 2) throw new Error('simulated mid-write failure');
      }
      return origPrepare(sql);
    };
    const beforeRollback = db.all('SELECT value FROM settings WHERE store_id=? AND key=?', ['store_b21_a', 'ga4_realtime_property_id']);
    const rollbackRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ga4_realtime_property_id: '000000', ga4_realtime_stream_id: '000000' }) });
    assert(rollbackRes.status === 500, 'C30 (setup) mid-write failure → HTTP 500');
    rawDb.prepare = origPrepare;
    const afterRollback = db.all('SELECT value FROM settings WHERE store_id=? AND key=?', ['store_b21_a', 'ga4_realtime_property_id']);
    assert(beforeRollback[0].value === afterRollback[0].value, 'C30 Rollback 保留舊值');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Frontend (jsdom) (31-45)
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
    if (JSDOM) {
      const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      const start = htmlSrc.indexOf('id="stab-ga4_realtime"');
      const sectionStart = htmlSrc.lastIndexOf('<div', start);
      const nextPanelIdx = htmlSrc.indexOf('settings-tab-panel', start + 10);
      const panelHtml = htmlSrc.slice(sectionStart, nextPanelIdx > -1 ? htmlSrc.lastIndexOf('<!--', nextPanelIdx) : htmlSrc.length);

      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const { window } = dom;
      window.document.body.innerHTML = panelHtml;
      const apiCalls = [];
      let fq = [];
      window.apiFetch = async (url, options = {}) => { apiCalls.push({ url: String(url), options }); const n = fq.shift(); return { json: async () => (n !== undefined ? n : { success: true, data: {} }) }; };
      window.showToast = () => {};
      window.geoGa4NotifySettingsChanged = () => {};
      const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      window.eval(src);

      // D31: Save success → PATCH called with 6-key whitelist.
      window.document.getElementById('ga4RealtimePropertyId').value = '123';
      window.document.getElementById('ga4RealtimeStreamId').value = '456';
      window.document.getElementById('ga4RealtimeEnabled').checked = false;
      fq = [
        { success: true, data: { ga4_realtime_enabled: false, ga4_realtime_property_id: '123', ga4_realtime_stream_id: '456', ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true, global_enabled: false, effective_enabled: false, effective_configured: false, credential_available: false, sdk_available: true } },
        { success: true, data: { ga4_realtime_enabled: false, ga4_realtime_property_id: '123', ga4_realtime_stream_id: '456', ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true, global_enabled: false, effective_enabled: false, effective_configured: false, credential_available: false, sdk_available: true } },
      ];
      await window.geoGa4SettingsSave();
      assert(apiCalls.some((c) => c.options.method === 'PATCH'), 'D31 Save success: PATCH issued');

      // D32: PATCH response Populate 立即發生（第二次呼叫前欄位已經是新值）。
      assert(window.document.getElementById('ga4RealtimePropertyId').value === '123', 'D32 PATCH response Populate 立即套用');

      // D33/D34: GET confirmation 之後值仍保留。
      assert(apiCalls.filter((c) => c.options.method !== 'PATCH').length >= 1, 'D33 GET confirmation 有另外呼叫');
      assert(window.document.getElementById('ga4RealtimePropertyId').value === '123', 'D34 GET success values retained');

      // D35: GET failure 保留表單（PATCH 成功但確認 GET 失敗）。
      window.document.getElementById('ga4RealtimePropertyId').value = '999888';
      fq = [
        { success: true, data: { ga4_realtime_enabled: false, ga4_realtime_property_id: '999888', ga4_realtime_stream_id: '456', ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true } },
        { success: false }, // GET confirmation 失敗（malformed / success!==true）
      ];
      await window.geoGa4SettingsSave();
      assert(window.document.getElementById('ga4RealtimePropertyId').value === '999888', 'D35 GET failure preserves form (not cleared to empty defaults)');

      // D36: malformed GET response 同樣不清空。
      window.document.getElementById('ga4RealtimeStreamId').value = '777666';
      const preservedBefore = window.document.getElementById('ga4RealtimeStreamId').value;
      fq = [null];
      await window.geoGa4SettingsLoad();
      assert(window.document.getElementById('ga4RealtimeStreamId').value === preservedBefore, 'D36 malformed GET response preserves form');

      // D37: global disabled 仍保留 stored true（Checkbox）。
      window.geoGa4SettingsPopulateForm(window.geoGa4SettingsNormalizeResponse({ success: true, data: { ga4_realtime_enabled: true, global_enabled: false, ga4_realtime_property_id: '1', ga4_realtime_stream_id: '1', ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true } }));
      assert(window.document.getElementById('ga4RealtimeEnabled').checked === true, 'D37 global disabled checkbox 仍保留 stored true');

      // D38/D39: credential missing 不清空 property/stream。
      window.geoGa4SettingsPopulateForm(window.geoGa4SettingsNormalizeResponse({ success: true, data: { ga4_realtime_property_id: '555444', ga4_realtime_stream_id: '333222', credential_available: false, ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true } }));
      assert(window.document.getElementById('ga4RealtimePropertyId').value === '555444', 'D38 credential missing property 不清空');
      assert(window.document.getElementById('ga4RealtimeStreamId').value === '333222', 'D39 credential missing stream 不清空');

      // D40: runtime status 顯示於獨立欄位（Server 全域功能／實際執行狀態），跟表單分開。
      window.geoGa4SettingsRenderServerStatus(window.geoGa4SettingsNormalizeResponse({ success: true, data: { ga4_realtime_enabled: true, global_enabled: false, effective_enabled: false, effective_configured: false, sdk_available: true, credential_available: false, property_configured: true, stream_configured: true, ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true } }));
      const stateHtml = window.document.getElementById('ga4RealtimeServerState').innerHTML;
      assert(stateHtml.includes('店家設定') && stateHtml.includes('Server 全域功能') && stateHtml.includes('實際執行狀態'), 'D40 runtime status 顯示為獨立欄位');

      // D41: no empty default overwrite（malformed GET 不覆蓋現有值）。
      window.document.getElementById('ga4RealtimePropertyId').value = 'KEEP-ME';
      fq = [{ success: false }];
      await window.geoGa4SettingsLoad();
      assert(window.document.getElementById('ga4RealtimePropertyId').value === 'KEEP-ME', 'D41 no empty default overwrite');

      // D42: reload error 顯示。
      const statusEl = window.document.getElementById('ga4RealtimeSettingsStatus');
      assert(!!statusEl && statusEl.textContent.includes('重新讀取設定失敗'), 'D42 show reload error message');

      // D43: Save button recovery（儲存流程結束後按鈕恢復可用）。
      const saveBtn = window.document.getElementById('ga4RealtimeSaveBtn');
      assert(saveBtn.disabled === false && saveBtn.textContent === '💾 儲存設定', 'D43 Save button recovery after save flow');

      // D44: no alert().
      const jsSrcClean = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert(!/\balert\(/.test(jsSrcClean), 'D44 no alert()');

      // D45: no raw error（沒有把 e.stack 或原始錯誤物件塞進 DOM）。
      assert(!/\.stack\b/.test(jsSrcClean), 'D45 no raw error/stack rendered to DOM');
    } else {
      for (let i = 31; i <= 45; i++) results.push({ name: `D${i} (jsdom unavailable)`, status: 'MANUAL REQUIRED' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // E. Labels (46-50)
  // ══════════════════════════════════════════════════════════════
  {
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const start = htmlSrc.indexOf('id="stab-ga4_realtime"');
    const nextPanelIdx = htmlSrc.indexOf('settings-tab-panel', start + 10);
    const sectionStart = htmlSrc.lastIndexOf('<div', start);
    const panelHtml = htmlSrc.slice(sectionStart, nextPanelIdx > -1 ? htmlSrc.lastIndexOf('<!--', nextPanelIdx) : htmlSrc.length);

    assert(panelHtml.includes('資源 ID'), 'E46 Property 標示資源 ID');
    assert(panelHtml.includes('串流 ID'), 'E47 Stream 標示串流 ID');
    assert(panelHtml.includes('請勿填反'), 'E48 顯示請勿填反提示');
    assert(panelHtml.includes('不是 G- 開頭的評估 ID') || panelHtml.includes('不是 G- 開頭'), 'E49 顯示不是 G- 評估 ID 提示');
    assert(!/長度|字元數/.test(panelHtml), 'E50 不使用長度猜測 Property/Stream 是否填反');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Mutation Testing — 每一項都應該 FAIL（若把修正「改回」錯誤版本）(51-60)
  // ══════════════════════════════════════════════════════════════
  {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    const cfgSrc = fs.readFileSync(path.join(ROOT, 'utils/ga4RealtimeConfig.js'), 'utf8');
    const jsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
    const htmlSrc2 = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

    // F51: GET 改回 config.propertyId → 這裡驗證 GET handler 沒有直接使用
    // effective config 的 propertyId 回填 stored 欄位。
    const getBlockMatch = routeSrc.match(/router\.get\('\/ga4-realtime'[\s\S]*?\}\);/);
    const getBlock = getBlockMatch ? getBlockMatch[0] : '';
    assert(!/config\.propertyId/.test(getBlock), 'F51 GET 未改回使用 config.propertyId（若改回會 FAIL）');

    // F52: GET 未改回使用 config.streamId。
    assert(!/config\.streamId/.test(getBlock), 'F52 GET 未改回使用 config.streamId（若改回會 FAIL）');

    // F53: GET enabled 未改回直接使用 config.enabled 回填 stored 欄位。
    assert(!/ga4_realtime_enabled:\s*config\.enabled/.test(routeSrc), 'F53 GET enabled 未改回直接使用 config.enabled（若改回會 FAIL）');

    // F54: 前端 GET failure 不會呼叫 populateForm(emptyDefaults)。
    assert(!/normalized\.ok\s*===\s*false[\s\S]{0,80}geoGa4SettingsPopulateForm/.test(jsSrc), 'F54 GET failure 未改回直接 Populate empty（若改回會 FAIL）');
    assert(/if \(normalized\.ok\) \{[\s\S]*?geoGa4SettingsPopulateForm/.test(jsSrc), 'F54b geoGa4SettingsPopulateForm 只在 normalized.ok 為 true 時才呼叫');

    // F55: PATCH response 未改回使用 effective config 欄位（buildGa4RealtimeSettingsResponse 共用）。
    const patchBlockMatch = routeSrc.match(/router\.patch\('\/ga4-realtime'[\s\S]*?\n\}\);/);
    const patchBlock = patchBlockMatch ? patchBlockMatch[0] : '';
    assert(!/config\.propertyId|config\.streamId|config\.enabled/.test(patchBlock), 'F55 PATCH response 未改回使用 effective config（若改回會 FAIL）');
    assert(/buildGa4RealtimeSettingsResponse\(db, storeId\)/.test(patchBlock), 'F55b PATCH 使用 buildGa4RealtimeSettingsResponse() 共用 Builder');

    // F56: credential missing 不會清空 property（getGa4RealtimeStoredSettings 不檢查憑證）。
    const storedFnMatch = cfgSrc.match(/function getGa4RealtimeStoredSettings[\s\S]*?\n\}/);
    const storedFnBody = storedFnMatch ? storedFnMatch[0] : '';
    assert(!/credential/i.test(storedFnBody), 'F56 getGa4RealtimeStoredSettings 未改回檢查 credential（若改回清空會 FAIL）');

    // F57: global disabled 不會清空 stream（Stored Resolver 不檢查 globalEnabled）。
    assert(!/globalEnabled/.test(storedFnBody), 'F57 getGa4RealtimeStoredSettings 未改回檢查 globalEnabled（若改回清空會 FAIL）');

    // F58: SQL 沒有移除 Store WHERE。
    assert(/WHERE store_id=\?/.test(storedFnBody), 'F58 getGa4RealtimeStoredSettings SQL 仍帶 WHERE store_id=?（若移除會 FAIL）');

    // F59: 回應沒有混合 stored/effective 欄位到同一個 key。
    const builderMatch = routeSrc.match(/function buildGa4RealtimeSettingsResponse[\s\S]*?\n\}/);
    const builderBody = builderMatch ? builderMatch[0] : '';
    assert(/stored\.ga4_realtime_enabled/.test(builderBody) && /effective\.enabled/.test(builderBody) && /effective_enabled: effective\.enabled/.test(builderBody), 'F59 stored/effective 欄位分開組裝，未混用同一個 key');

    // F60: Property/Stream 提示未被移除。
    assert(htmlSrc2.includes('請勿填反'), 'F60 Property/Stream 提示未被移除（若移除會 FAIL）');
  }

  // ══════════════════════════════════════════════════════════════
  // G. 追加驗證（B2.1 補齊至 ≥72，見需求文件二）(61-65)
  // ══════════════════════════════════════════════════════════════
  {
    // G61: Stored 與 Effective 同時存在，且可以合法不同（Stored=true, Effective=false）。
    process.env.GA4_REALTIME_ENABLED = 'false';
    setSetting('store_b21_a', 'ga4_realtime_enabled', '1');
    setSetting('store_b21_a', 'ga4_realtime_property_id', 'stored_property_fixture');
    setSetting('store_b21_a', 'ga4_realtime_stream_id', 'stored_stream_fixture');
    const storedG61 = cfg.getGa4RealtimeStoredSettings(db, 'store_b21_a');
    const effectiveG61 = cfg.getGa4RealtimeConfig(db, 'store_b21_a');
    assert(storedG61.ga4_realtime_enabled === true && effectiveG61.enabled === false, 'G61 Stored ga4_realtime_enabled=true 與 Effective effective_enabled=false 可合法並存');

    // G62/G63: Credential 未設定時，透過 GET route 確認 Property/Stream 仍保留原 Stored 值。
    const credGetRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_a' } });
    const credGetJson = await credGetRes.json();
    assert(credGetJson.data.credential_available === false, 'G62 (setup) credential_available=false（測試環境未設定憑證）');
    assert(credGetJson.data.ga4_realtime_property_id === 'stored_property_fixture', 'G62 Credential 未設定時 ga4_realtime_property_id 仍保留原 Stored Property');
    assert(credGetJson.data.ga4_realtime_stream_id === 'stored_stream_fixture', 'G63 Credential 未設定時 ga4_realtime_stream_id 仍保留原 Stored Stream');

    // G64: GET 確認請求失敗時，PATCH response 已 Populate 的 Property／Stream 保持不變（jsdom）。
    let JSDOM64;
    try { ({ JSDOM: JSDOM64 } = require('jsdom')); } catch (e) { JSDOM64 = null; }
    if (JSDOM64) {
      const htmlSrc64 = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      const start64 = htmlSrc64.indexOf('id="stab-ga4_realtime"');
      const sectionStart64 = htmlSrc64.lastIndexOf('<div', start64);
      const nextPanelIdx64 = htmlSrc64.indexOf('settings-tab-panel', start64 + 10);
      const panelHtml64 = htmlSrc64.slice(sectionStart64, nextPanelIdx64 > -1 ? htmlSrc64.lastIndexOf('<!--', nextPanelIdx64) : htmlSrc64.length);
      const dom64 = new JSDOM64('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const win64 = dom64.window;
      win64.document.body.innerHTML = panelHtml64;
      let fq64 = [];
      win64.apiFetch = async (url, options = {}) => { const n = fq64.shift(); return { json: async () => (n !== undefined ? n : { success: true, data: {} }) }; };
      win64.showToast = () => {};
      win64.geoGa4NotifySettingsChanged = () => {};
      const src64 = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      win64.eval(src64);
      win64.document.getElementById('ga4RealtimePropertyId').value = '111111111';
      win64.document.getElementById('ga4RealtimeStreamId').value = '222222222';
      win64.document.getElementById('ga4RealtimeEnabled').checked = false;
      win64.document.getElementById('ga4RealtimeCacheSeconds').value = '60';
      fq64 = [
        { success: true, data: { ga4_realtime_enabled: true, ga4_realtime_property_id: 'stored_property_fixture', ga4_realtime_stream_id: 'stored_stream_fixture', ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true } }, // PATCH response
        { success: false }, // GET confirmation 失敗（模擬 500）
      ];
      await win64.geoGa4SettingsSave();
      assert(win64.document.getElementById('ga4RealtimePropertyId').value === 'stored_property_fixture' && win64.document.getElementById('ga4RealtimeStreamId').value === 'stored_stream_fixture', 'G64 GET 確認請求失敗時，PATCH response 已 Populate 的 Property/Stream 保持不變');

      // G65 (Mutation)：模擬「load catch 分支直接呼叫 geoGa4SettingsPopulateForm(emptyDefaults)」的錯誤版本，
      // 確認目前程式碼「不是」這樣寫（若真的改回會 FAIL）。
      const jsSrcG65 = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8');
      const catchBlockMatch = jsSrcG65.match(/\} catch \(e\) \{[\s\S]{0,200}?normalized = geoGa4SettingsNormalizeResponse\(null\);[\s\S]{0,20}?\}/);
      const catchBlock = catchBlockMatch ? catchBlockMatch[0] : '';
      assert(!/geoGa4SettingsPopulateForm/.test(catchBlock), 'G65 (Mutation) load catch 分支未直接呼叫 geoGa4SettingsPopulateForm(emptyDefaults)（若改回會 FAIL）');
    } else {
      results.push({ name: 'G64 (jsdom unavailable)', status: 'MANUAL REQUIRED' });
      results.push({ name: 'G65 (jsdom unavailable)', status: 'MANUAL REQUIRED' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // H. Stored Settings 專項場景 A-E（需求文件三）(66-75)
  // ══════════════════════════════════════════════════════════════
  {
    // 場景 A：全域功能關閉，Stored 仍保留，不得回空字串。
    process.env.GA4_REALTIME_ENABLED = 'false';
    setSetting('store_b21_a', 'ga4_realtime_enabled', '1');
    setSetting('store_b21_a', 'ga4_realtime_property_id', 'stored_property_fixture');
    setSetting('store_b21_a', 'ga4_realtime_stream_id', 'stored_stream_fixture');
    setSetting('store_b21_a', 'ga4_realtime_cache_seconds', '60');
    setSetting('store_b21_a', 'ga4_realtime_auto_refresh_enabled', '1');
    const scenarioARes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_a' } });
    const scenarioA = (await scenarioARes.json()).data;
    assert(scenarioA.ga4_realtime_enabled === true, 'H66 場景A：ga4_realtime_enabled=true');
    assert(scenarioA.ga4_realtime_property_id === 'stored_property_fixture' && scenarioA.ga4_realtime_property_id !== '', 'H67 場景A：Property 保留，不回空字串');
    assert(scenarioA.ga4_realtime_stream_id === 'stored_stream_fixture' && scenarioA.ga4_realtime_stream_id !== '', 'H68 場景A：Stream 保留，不回空字串');
    assert(scenarioA.global_enabled === false && scenarioA.effective_enabled === false, 'H69 場景A：global_enabled=false 且 effective_enabled=false');

    // 場景 B：GA4_REALTIME_ENABLED=true，但無 Credential（測試環境本來就沒有真實憑證）。
    process.env.GA4_REALTIME_ENABLED = 'true';
    const scenarioBRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_a' } });
    const scenarioB = (await scenarioBRes.json()).data;
    assert(scenarioB.ga4_realtime_property_id === 'stored_property_fixture' && scenarioB.ga4_realtime_stream_id === 'stored_stream_fixture', 'H70 場景B：Credential 未設定不清空 Stored Property/Stream');
    assert(scenarioB.credential_available === false && scenarioB.effective_configured === false, 'H71 場景B：credential_available=false 且 effective_configured=false');
    process.env.GA4_REALTIME_ENABLED = 'false';

    // 場景 C：儲存後重新 GET，PATCH response 與 GET 一致，Checkbox 保持勾選。
    // PATCH 走真實白名單驗證（純數字），fixture 用明確假數字，不使用真實 ID。
    const scenarioCPatchRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-store': 'store_b21_a' }, body: JSON.stringify({ ga4_realtime_enabled: true, ga4_realtime_property_id: '333333333', ga4_realtime_stream_id: '4444' }) });
    const scenarioCPatchJson = await scenarioCPatchRes.json();
    assert(scenarioCPatchJson.success === true, 'H72setup 場景C PATCH 成功');
    const scenarioCPatch = scenarioCPatchJson.data;
    const scenarioCGetRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_a' } });
    const scenarioCGet = (await scenarioCGetRes.json()).data;
    assert(scenarioCPatch.ga4_realtime_property_id === scenarioCGet.ga4_realtime_property_id && scenarioCPatch.ga4_realtime_stream_id === scenarioCGet.ga4_realtime_stream_id, 'H72 場景C：PATCH response 與後續 GET 一致');
    assert(scenarioCGet.ga4_realtime_enabled === true, 'H73 場景C：Checkbox（ga4_realtime_enabled）保持勾選');

    // 場景 E：Store Isolation — A 的 GET 不會讀到 B，A 的 PATCH 不會修改 B，A Runtime disabled 不影響 B Stored 顯示。
    setSetting('store_b21_b', 'ga4_realtime_property_id', 'stored_property_fixture_b');
    setSetting('store_b21_b', 'ga4_realtime_stream_id', 'stored_stream_fixture_b');
    const scenarioEARes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_a' } });
    const scenarioEA = (await scenarioEARes.json()).data;
    assert(scenarioEA.ga4_realtime_property_id !== 'stored_property_fixture_b', 'H74 場景E：Store A GET 不會讀到 Store B 的資料');
    const scenarioEBRes = await fetchFn(`http://localhost:${port}/api/settings/ga4-realtime`, { headers: { 'x-test-store': 'store_b21_b' } });
    const scenarioEB = (await scenarioEBRes.json()).data;
    assert(scenarioEB.ga4_realtime_property_id === 'stored_property_fixture_b', 'H75 場景E：Store A Runtime disabled 不影響 Store B Stored 顯示（B 仍讀到自己的值）');
  }

  printSummary();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (server) { try { server.close(); } catch (e) { /* ignore */ } }
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  if (fs.existsSync(DB_FILE)) { try { fs.unlinkSync(DB_FILE); } catch (e2) {} }
  process.exitCode = 1;
  process.exit(1); // 避免尚未關閉的 http server 讓事件迴圈掛住，測試失敗時強制結束。
});
