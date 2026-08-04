// public/js/geo-ga4-settings.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2.1
// GA4 Realtime Visitor Geo Layer — Settings UI
//
// 沿用既有 apiFetch()（app.js）／showToast()（app.js）／
// settings-tab-panel 架構，不另建第二套 Settings 系統、不使用 alert()。
//
// 邊界（不得違反）：
//   - window.geoGa4SettingsState 不得保存 credentials／private key／
//     access token／Service Account JSON／Store ID／Property path。
//     Property ID／Stream ID 只保存使用者輸入的純數字設定值。
//   - PATCH body 只能包含 6 個白名單欄位（見 geoGa4SettingsBuildPatch()），
//     絕不夾帶 store_id／credentials／private_key／access_token 等欄位。
//   - Connection Test 不送 Body（或送空物件），一律只讀伺服器已儲存的
//     該店設定，不接受前端覆寫 Property／Stream／Credential。
//   - 頁面初始化只讀本地 settings/status，不自動觸發 Google API 呼叫
//     （呼叫連線測試永遠需要使用者按下按鈕）。
//
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.1（GA4 Settings Persistence Hotfix）：
//   - Settings Form 一律只使用 Stored Settings 欄位（ga4_realtime_enabled／
//     ga4_realtime_property_id／ga4_realtime_stream_id／
//     ga4_realtime_single_property_mode／ga4_realtime_cache_seconds／
//     ga4_realtime_auto_refresh_enabled），不受伺服器全域 Feature Flag
//     或憑證狀態影響（見 routes/settings.js buildGa4RealtimeSettingsResponse()）。
//   - Runtime 狀態（global_enabled／effective_enabled／effective_configured／
//     credential_available／sdk_available／property_configured／
//     stream_configured）只用於狀態顯示，絕不回填表單欄位。
//   - GET 失敗或 malformed response 時，一律保留目前表單，不得呼叫
//     geoGa4SettingsPopulateForm(emptyDefaults) 把使用者已輸入的內容清空。

'use strict';

const GA4_SETTINGS_PATCH_KEYS = Object.freeze([
  'ga4_realtime_enabled', 'ga4_realtime_property_id', 'ga4_realtime_stream_id',
  'ga4_realtime_single_property_mode', 'ga4_realtime_cache_seconds', 'ga4_realtime_auto_refresh_enabled',
]);

const GA4_SETTINGS_TEST_ERROR_MESSAGES = Object.freeze({
  credential_unavailable: '伺服器尚未設定 GA4 憑證。',
  credential_invalid: 'GA4 憑證格式錯誤。',
  permission_denied: 'Service Account 沒有此 GA4 Property 的讀取權限。',
  403: 'Service Account 沒有此 GA4 Property 的讀取權限。',
  property_not_found: '找不到此 GA4 Property。',
  404: '找不到此 GA4 Property。',
  stream_filter_invalid: 'Stream ID 無法套用於目前 Property。',
  quota_limited: 'GA4 API 暫時達到使用限制。',
  429: 'GA4 API 暫時達到使用限制。',
  ga4_timeout: 'GA4 連線逾時，請稍後再試。',
  ga4_unavailable: 'Google Analytics 暫時無法連線。',
  ga4_realtime_disabled: 'GA4 即時推估圖層尚未啟用，請先啟用後再測試連線。',
});

window.geoGa4SettingsState = {
  loaded: false,
  loading: false,
  saving: false,
  testing: false,
  dirty: false,
  loadError: false,
  lastLoaded: null,
  lastSaved: null,
  testCooldownUntil: 0,
  cooldownTimer: null,
  serverSingleStoreModeAvailable: false,
  requestSeq: 0,
  abortController: null,
};

function _geoGa4SettingsEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _geoGa4SettingsEl(id) { return document.getElementById(id); }

// geoGa4SettingsInit() — Tab 切入時呼叫（同 geoMapSettingsInit() 慣例）：
// 只在第一次進入（或前一次讀取失敗）時才重新 GET，避免每次切 Tab 都重抓。
function geoGa4SettingsInit() {
  if (!window.geoGa4SettingsState.loaded && !window.geoGa4SettingsState.loadError) {
    geoGa4SettingsLoad();
  }
}

// geoGa4SettingsNormalizeResponse(json) — 防禦性正規化，malformed 時回傳
// 安全預設值，不 throw。
//
// 欄位分兩組（fix18-10-hotfix30-B5-R5.4-G1.5-B2.1，見需求文件二/四）：
//   Stored Settings  → ga4_realtime_*（Settings Form 一律只讀這組）
//   Effective Runtime → global_enabled／effective_enabled／effective_configured／
//                        runtime_error_code／property_configured／
//                        stream_configured／credential_available／sdk_available
//                        （只用於狀態顯示，不得回填表單）
function geoGa4SettingsNormalizeResponse(json) {
  const empty = {
    ok: false,
    ga4_realtime_enabled: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '',
    ga4_realtime_single_property_mode: false, ga4_realtime_cache_seconds: 60,
    ga4_realtime_auto_refresh_enabled: true, server_single_store_mode_available: false,
    global_enabled: false, effective_enabled: false, effective_configured: false,
    runtime_error_code: null, property_configured: false, stream_configured: false,
    credential_available: false, sdk_available: false,
  };
  if (!json || json.success !== true || !json.data || typeof json.data !== 'object') return empty;
  const d = json.data;
  return {
    ok: true,
    // Stored Settings — 使用者實際儲存的值，Settings Form 一律只使用這組。
    ga4_realtime_enabled: !!d.ga4_realtime_enabled,
    ga4_realtime_property_id: d.ga4_realtime_property_id || '',
    ga4_realtime_stream_id: d.ga4_realtime_stream_id || '',
    ga4_realtime_single_property_mode: !!d.ga4_realtime_single_property_mode,
    ga4_realtime_cache_seconds: Number(d.ga4_realtime_cache_seconds) || 60,
    ga4_realtime_auto_refresh_enabled: d.ga4_realtime_auto_refresh_enabled !== false,
    server_single_store_mode_available: !!d.server_single_store_mode_available,
    // Effective Runtime Config — 只用於狀態顯示。
    global_enabled: !!d.global_enabled,
    effective_enabled: !!d.effective_enabled,
    effective_configured: !!d.effective_configured,
    runtime_error_code: d.runtime_error_code || null,
    property_configured: !!d.property_configured,
    stream_configured: !!d.stream_configured,
    credential_available: !!d.credential_available,
    sdk_available: !!d.sdk_available,
  };
}

// geoGa4SettingsLoad() — fix18-10-hotfix30-B5-R5.4-G1.5-B2.1：GET 失敗或
// malformed response 時，不得呼叫 geoGa4SettingsPopulateForm(emptyDefaults)
// 清空使用者現有輸入（需求文件六 3）。只有 normalized.ok===true 才會
// Populate 表單；失敗時只顯示「重新讀取設定失敗」，保留目前表單內容。
async function geoGa4SettingsLoad() {
  window.geoGa4SettingsState.loading = true;
  const mySeq = ++window.geoGa4SettingsState.requestSeq;
  if (window.geoGa4SettingsState.abortController) {
    try { window.geoGa4SettingsState.abortController.abort(); } catch (e) { /* ignore */ }
  }
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  window.geoGa4SettingsState.abortController = controller;

  let normalized;
  try {
    const res = await apiFetch('/api/settings/ga4-realtime', controller ? { signal: controller.signal } : {});
    const json = await res.json();
    normalized = geoGa4SettingsNormalizeResponse(json);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    normalized = geoGa4SettingsNormalizeResponse(null);
  }
  if (mySeq !== window.geoGa4SettingsState.requestSeq) return; // 被更新的呼叫取代

  window.geoGa4SettingsState.loading = false;
  window.geoGa4SettingsState.loaded = window.geoGa4SettingsState.loaded || normalized.ok;
  window.geoGa4SettingsState.loadError = !normalized.ok;

  if (normalized.ok) {
    window.geoGa4SettingsState.lastLoaded = normalized;
    window.geoGa4SettingsState.serverSingleStoreModeAvailable = normalized.server_single_store_mode_available;
    geoGa4SettingsPopulateForm(normalized);
    geoGa4SettingsRenderServerStatus(normalized);
    geoGa4SettingsRenderStatusMessage(normalized);
  } else {
    // 不清空表單、不覆蓋既有成功提示；只提示重新讀取設定失敗，允許使用者
    // 重新載入（需求文件六 3）。
    geoGa4SettingsRenderLoadError();
  }
  return normalized;
}

function geoGa4SettingsPopulateForm(s) {
  const enabledEl = _geoGa4SettingsEl('ga4RealtimeEnabled');
  const autoRefreshEl = _geoGa4SettingsEl('ga4RealtimeAutoRefresh');
  const propertyEl = _geoGa4SettingsEl('ga4RealtimePropertyId');
  const streamEl = _geoGa4SettingsEl('ga4RealtimeStreamId');
  const singleModeEl = _geoGa4SettingsEl('ga4RealtimeSinglePropertyMode');
  const cacheEl = _geoGa4SettingsEl('ga4RealtimeCacheSeconds');
  const singleModeHintEl = _geoGa4SettingsEl('ga4RealtimeSinglePropertyModeHint');

  // 一律只使用 Stored Settings 欄位（ga4_realtime_*），不得使用
  // effective_enabled／effective_configured 等 Runtime 欄位回填表單。
  if (enabledEl) enabledEl.checked = !!s.ga4_realtime_enabled;
  if (autoRefreshEl) autoRefreshEl.checked = !!s.ga4_realtime_auto_refresh_enabled;
  if (propertyEl) propertyEl.value = s.ga4_realtime_property_id || '';
  if (streamEl) streamEl.value = s.ga4_realtime_stream_id || '';
  if (cacheEl) cacheEl.value = s.ga4_realtime_cache_seconds || 60;

  if (singleModeEl) {
    singleModeEl.checked = !!s.ga4_realtime_single_property_mode;
    singleModeEl.disabled = !s.server_single_store_mode_available;
  }
  if (singleModeHintEl) {
    singleModeHintEl.textContent = s.server_single_store_mode_available ? '' : '目前部署未開放共用 Property 模式。';
  }
}

// geoGa4SettingsRenderServerStatus(s) — Runtime 狀態顯示，跟 Settings Form
// 完全分開（需求文件六 2）：
//   店家設定 → ga4_realtime_enabled（Stored）
//   Server 全域功能 → global_enabled
//   實際執行狀態 → effective_enabled && effective_configured
//   SDK／Server Credential／Property／Stream → 各自獨立顯示
function geoGa4SettingsRenderServerStatus(s) {
  const el = _geoGa4SettingsEl('ga4RealtimeServerState');
  if (!el) return;
  const runtimeUsable = !!s.effective_enabled && !!s.effective_configured;
  const rows = [
    ['店家設定', s.ga4_realtime_enabled ? '已啟用' : '未啟用'],
    ['Server 全域功能', s.global_enabled ? '已啟用' : '未啟用'],
    ['實際執行狀態', runtimeUsable ? '可用' : '不可用'],
    ['SDK', s.sdk_available ? '可用' : '不可用'],
    ['Server 憑證', s.credential_available ? '已設定' : '未設定'],
    ['Property', s.property_configured ? '已設定' : '未設定'],
    ['Stream', s.stream_configured ? '已設定' : '未設定'],
    ['Auto Refresh', s.ga4_realtime_auto_refresh_enabled ? '已啟用' : '已停用'],
    ['Cache', `${s.ga4_realtime_cache_seconds} 秒`],
  ];
  el.innerHTML = rows.map(([label, value]) => (
    `<div class="geo-ga4-settings-field"><strong>${_geoGa4SettingsEsc(label)}：</strong>${_geoGa4SettingsEsc(value)}</div>`
  )).join('');
}

// geoGa4SettingsRenderStatusMessage(s) — fix18-10-hotfix30-B5-R5.4-G1.5-B2.1
// 需求文件七：依 Stored/Runtime 狀態組合顯示對應文案，Property／Stream
// 已儲存不因 Credential 未設定而顯示未設定。
function geoGa4SettingsRenderStatusMessage(s) {
  const el = _geoGa4SettingsEl('ga4RealtimeSettingsStatus');
  if (!el) return;
  let msg = '';
  if (s.ga4_realtime_enabled && !s.global_enabled) {
    msg = '店家設定已保存，但伺服器尚未開啟 GA4 即時功能。';
  } else if (s.global_enabled && !s.credential_available) {
    msg = 'GA4 設定已保存，但伺服器憑證尚未設定。';
  } else if (s.effective_enabled && s.effective_configured) {
    msg = 'GA4 即時功能已就緒。';
  }
  el.textContent = msg;
  el.classList.remove('geo-ga4-settings-load-error');
}

// geoGa4SettingsRenderLoadError() — GET 失敗或 malformed 時顯示，不清空
// 表單、不影響先前的儲存成功提示邏輯（需求文件六 3）。
function geoGa4SettingsRenderLoadError() {
  const el = _geoGa4SettingsEl('ga4RealtimeSettingsStatus');
  if (!el) return;
  el.textContent = '重新讀取設定失敗，請稍後重新載入。';
  el.classList.add('geo-ga4-settings-load-error');
}

// ══════════════════════════════════════════════════════════════════
// Validation（前端只是 UX，Server validation 仍是權威）
// ══════════════════════════════════════════════════════════════════

function _geoGa4SettingsIsPureDigits(v) { return /^[0-9]+$/.test(String(v)); }

function geoGa4SettingsValidateForm(form) {
  const errors = {};
  const enabled = !!form.ga4_realtime_enabled;
  const singleMode = !!form.ga4_realtime_single_property_mode;
  const property = String(form.ga4_realtime_property_id || '').trim();
  const stream = String(form.ga4_realtime_stream_id || '').trim();

  if (property !== '' && !_geoGa4SettingsIsPureDigits(property)) {
    errors.property = 'Property ID 必須是純數字（不含 properties/ 前綴、URL、空格或符號）。';
  }
  if (stream !== '' && !_geoGa4SettingsIsPureDigits(stream)) {
    errors.stream = 'Stream ID 必須是純數字。';
  }
  if (enabled && !singleMode) {
    if (property === '' && !errors.property) errors.property = '啟用 GA4 且未使用共用 Property 模式時，Property ID 為必填。';
    if (stream === '' && !errors.stream) errors.stream = '啟用 GA4 且未使用共用 Property 模式時，Stream ID 為必填。';
  }
  const cache = Number(form.ga4_realtime_cache_seconds);
  if (!Number.isFinite(cache) || cache < 30 || cache > 300) {
    errors.cache = 'Cache 秒數必須介於 30～300 秒之間。';
  }
  if (singleMode && !window.geoGa4SettingsState.serverSingleStoreModeAvailable) {
    errors.general = '目前部署未開放共用 Property 模式，無法啟用此選項。';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

function _geoGa4SettingsReadForm() {
  return {
    ga4_realtime_enabled: !!(_geoGa4SettingsEl('ga4RealtimeEnabled') || {}).checked,
    ga4_realtime_property_id: (_geoGa4SettingsEl('ga4RealtimePropertyId') || {}).value || '',
    ga4_realtime_stream_id: (_geoGa4SettingsEl('ga4RealtimeStreamId') || {}).value || '',
    ga4_realtime_single_property_mode: !!(_geoGa4SettingsEl('ga4RealtimeSinglePropertyMode') || {}).checked,
    ga4_realtime_cache_seconds: Number((_geoGa4SettingsEl('ga4RealtimeCacheSeconds') || {}).value) || 60,
    ga4_realtime_auto_refresh_enabled: !!(_geoGa4SettingsEl('ga4RealtimeAutoRefresh') || {}).checked,
  };
}

function _geoGa4SettingsClearFieldErrors() {
  ['ga4RealtimePropertyError', 'ga4RealtimeStreamError', 'ga4RealtimeCacheError', 'ga4RealtimeGeneralError'].forEach((id) => {
    const el = _geoGa4SettingsEl(id);
    if (el) el.textContent = '';
  });
}

function _geoGa4SettingsRenderFieldErrors(errors) {
  const map = { property: 'ga4RealtimePropertyError', stream: 'ga4RealtimeStreamError', cache: 'ga4RealtimeCacheError', general: 'ga4RealtimeGeneralError' };
  Object.entries(map).forEach(([key, id]) => {
    const el = _geoGa4SettingsEl(id);
    if (el) el.textContent = errors[key] || '';
  });
}

// geoGa4SettingsBuildPatch(form) — 只回傳 6 個白名單欄位，絕不夾帶
// store_id／credentials／private_key／access_token 等欄位。
function geoGa4SettingsBuildPatch(form) {
  const patch = {};
  GA4_SETTINGS_PATCH_KEYS.forEach((k) => { if (form[k] !== undefined) patch[k] = form[k]; });
  return patch;
}

async function geoGa4SettingsSave() {
  const form = _geoGa4SettingsReadForm();
  _geoGa4SettingsClearFieldErrors();

  const validation = geoGa4SettingsValidateForm(form);
  if (!validation.ok) {
    _geoGa4SettingsRenderFieldErrors(validation.errors);
    if (typeof showToast === 'function') showToast('❌ 請先修正欄位錯誤再儲存', 'error');
    return;
  }

  const btn = _geoGa4SettingsEl('ga4RealtimeSaveBtn');
  window.geoGa4SettingsState.saving = true;
  if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }

  try {
    const patch = geoGa4SettingsBuildPatch(form);
    const res = await apiFetch('/api/settings/ga4-realtime', { method: 'PATCH', body: JSON.stringify(patch) });
    const json = await res.json();
    if (!json || json.success !== true) {
      _geoGa4SettingsRenderFieldErrors({ general: (json && json.message) || '設定儲存失敗，請稍後再試。' });
      if (typeof showToast === 'function') showToast('❌ 儲存失敗：' + ((json && json.message) || ''), 'error');
      return;
    }
    if (typeof showToast === 'function') showToast('✅ 設定已儲存', 'success');
    window.geoGa4SettingsState.lastSaved = Date.now();

    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.1：先用 PATCH response 立即
    // Populate（避免使用者短暫看到舊值），再執行 GET 作確認（需求文件六 4）。
    // 若 GET 確認失敗，geoGa4SettingsLoad() 本身不會清空欄位，PATCH 已寫入
    // 的值會繼續保留在表單上。
    const patchNormalized = geoGa4SettingsNormalizeResponse(json);
    if (patchNormalized.ok) {
      window.geoGa4SettingsState.loaded = true;
      window.geoGa4SettingsState.loadError = false;
      window.geoGa4SettingsState.lastLoaded = patchNormalized;
      window.geoGa4SettingsState.serverSingleStoreModeAvailable = patchNormalized.server_single_store_mode_available;
      geoGa4SettingsPopulateForm(patchNormalized);
      geoGa4SettingsRenderServerStatus(patchNormalized);
      geoGa4SettingsRenderStatusMessage(patchNormalized);
    }

    const reloaded = await geoGa4SettingsLoad();

    if (typeof geoGa4NotifySettingsChanged === 'function') {
      const effectiveNotify = (reloaded && reloaded.ok) ? reloaded : patchNormalized;
      geoGa4NotifySettingsChanged(effectiveNotify.ok ? effectiveNotify.ga4_realtime_auto_refresh_enabled : form.ga4_realtime_auto_refresh_enabled);
    }
  } catch (e) {
    _geoGa4SettingsRenderFieldErrors({ general: '設定儲存時發生未預期錯誤，請稍後再試。' });
    if (typeof showToast === 'function') showToast('❌ ' + e.message, 'error');
  } finally {
    window.geoGa4SettingsState.saving = false;
    if (btn) { btn.disabled = false; btn.textContent = '💾 儲存設定'; }
  }
}

// ══════════════════════════════════════════════════════════════════
// Connection Test
// ══════════════════════════════════════════════════════════════════

function geoGa4SettingsRenderTestResult(result) {
  const el = _geoGa4SettingsEl('ga4RealtimeTestResult');
  if (!el) return;
  if (!result) { el.textContent = ''; return; }
  if (result.rate_limited) {
    el.textContent = result.message || '請稍候再測試連線。';
    return;
  }
  if (!result.connected) {
    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：Summary 成功、只有 City Request
    // 失敗（error_stage==='city'）時，後端已給出專屬文案（「GA4 基本連線
    // 成功，但城市區域資料請求失敗。」），優先顯示這個，不要被一般
    // error_code 對照表覆蓋成「完全連不上」的訊息（見需求文件二）。
    if (result.error_stage === 'city') {
      el.textContent = result.message || 'GA4 基本連線成功，但城市區域資料請求失敗。';
      return;
    }
    const code = result.error_code;
    el.textContent = GA4_SETTINGS_TEST_ERROR_MESSAGES[code] || result.message || 'GA4 連線測試失敗。';
    return;
  }
  el.textContent = result.message || (result.has_recent_data ? '連線成功，最近 30 分鐘有即時資料。' : '連線成功，目前最近30分鐘沒有即時資料。');
}

function geoGa4SettingsUpdateCooldown(untilTs) {
  window.geoGa4SettingsState.testCooldownUntil = untilTs;
  const btn = _geoGa4SettingsEl('ga4RealtimeTestBtn');
  if (window.geoGa4SettingsState.cooldownTimer) {
    clearInterval(window.geoGa4SettingsState.cooldownTimer);
    window.geoGa4SettingsState.cooldownTimer = null;
  }
  const tick = () => {
    const remaining = Math.ceil((window.geoGa4SettingsState.testCooldownUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      if (btn) { btn.disabled = false; btn.textContent = '🔌 測試連線'; }
      if (window.geoGa4SettingsState.cooldownTimer) { clearInterval(window.geoGa4SettingsState.cooldownTimer); window.geoGa4SettingsState.cooldownTimer = null; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = `請稍候 ${remaining} 秒…`; }
  };
  tick();
  window.geoGa4SettingsState.cooldownTimer = setInterval(tick, 1000);
}

async function geoGa4SettingsTestConnection() {
  if (window.geoGa4SettingsState.testing) return; // 防止重複點擊建立多個併發測試
  if (Date.now() < window.geoGa4SettingsState.testCooldownUntil) return; // cooldown 中，不重複呼叫 API

  const btn = _geoGa4SettingsEl('ga4RealtimeTestBtn');
  window.geoGa4SettingsState.testing = true;
  if (btn) { btn.disabled = true; btn.textContent = '測試中…'; }
  const resultEl = _geoGa4SettingsEl('ga4RealtimeTestResult');
  if (resultEl) resultEl.textContent = '測試中…';

  try {
    const res = await apiFetch('/api/geo-live/ga4-realtime-test', { method: 'POST', body: JSON.stringify({}) });
    const json = await res.json();
    const result = (json && json.success) ? json.data : { connected: false, message: '連線測試失敗，請稍後再試。' };
    geoGa4SettingsRenderTestResult(result);
    const cooldownSeconds = (typeof result.retry_after_seconds === 'number' && result.retry_after_seconds >= 0) ? result.retry_after_seconds : 30;
    geoGa4SettingsUpdateCooldown(Date.now() + cooldownSeconds * 1000);
  } catch (e) {
    geoGa4SettingsRenderTestResult({ connected: false, message: '連線測試發生未預期錯誤，請稍後再試。' });
    geoGa4SettingsUpdateCooldown(Date.now() + 30 * 1000);
  } finally {
    window.geoGa4SettingsState.testing = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GA4_SETTINGS_PATCH_KEYS, GA4_SETTINGS_TEST_ERROR_MESSAGES,
    geoGa4SettingsInit, geoGa4SettingsNormalizeResponse, geoGa4SettingsLoad,
    geoGa4SettingsPopulateForm, geoGa4SettingsRenderServerStatus,
    geoGa4SettingsRenderStatusMessage, geoGa4SettingsRenderLoadError,
    geoGa4SettingsValidateForm, geoGa4SettingsBuildPatch, geoGa4SettingsSave,
    geoGa4SettingsTestConnection, geoGa4SettingsRenderTestResult, geoGa4SettingsUpdateCooldown,
    _geoGa4SettingsReadForm, _geoGa4SettingsClearFieldErrors, _geoGa4SettingsRenderFieldErrors,
  };
}
