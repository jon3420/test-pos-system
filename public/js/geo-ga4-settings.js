// public/js/geo-ga4-settings.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2a
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
function geoGa4SettingsNormalizeResponse(json) {
  const empty = {
    ok: false,
    ga4_realtime_enabled: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '',
    ga4_realtime_single_property_mode: false, ga4_realtime_cache_seconds: 60,
    ga4_realtime_auto_refresh_enabled: true, server_single_store_mode_available: false,
    credential_available: false, sdk_available: false,
  };
  if (!json || json.success !== true || !json.data || typeof json.data !== 'object') return empty;
  const d = json.data;
  return {
    ok: true,
    ga4_realtime_enabled: !!d.ga4_realtime_enabled,
    ga4_realtime_property_id: d.ga4_realtime_property_id || '',
    ga4_realtime_stream_id: d.ga4_realtime_stream_id || '',
    ga4_realtime_single_property_mode: !!d.ga4_realtime_single_property_mode,
    ga4_realtime_cache_seconds: Number(d.ga4_realtime_cache_seconds) || 60,
    ga4_realtime_auto_refresh_enabled: d.ga4_realtime_auto_refresh_enabled !== false,
    server_single_store_mode_available: !!d.server_single_store_mode_available,
    credential_available: !!d.credential_available,
    sdk_available: !!d.sdk_available,
  };
}

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
  window.geoGa4SettingsState.loaded = normalized.ok;
  window.geoGa4SettingsState.loadError = !normalized.ok;
  window.geoGa4SettingsState.lastLoaded = normalized;
  window.geoGa4SettingsState.serverSingleStoreModeAvailable = normalized.server_single_store_mode_available;

  geoGa4SettingsPopulateForm(normalized);
  geoGa4SettingsRenderServerStatus(normalized);
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

function geoGa4SettingsRenderServerStatus(s) {
  const el = _geoGa4SettingsEl('ga4RealtimeServerState');
  if (!el) return;
  const rows = [
    ['SDK', s.sdk_available ? '可用' : '不可用'],
    ['Server 憑證', s.credential_available ? '已設定' : '未設定'],
    ['Property', s.ga4_realtime_property_id ? '已設定' : '未設定'],
    ['Stream', s.ga4_realtime_stream_id ? '已設定' : '未設定'],
    ['Auto Refresh', s.ga4_realtime_auto_refresh_enabled ? '已啟用' : '已停用'],
    ['Cache', `${s.ga4_realtime_cache_seconds} 秒`],
  ];
  el.innerHTML = rows.map(([label, value]) => (
    `<div class="geo-ga4-settings-field"><strong>${_geoGa4SettingsEsc(label)}：</strong>${_geoGa4SettingsEsc(value)}</div>`
  )).join('');
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

    // 成功後再 GET 一次重新確認 Server 狀態（不信任 PATCH 回應本身當作最終真相）。
    const reloaded = await geoGa4SettingsLoad();

    if (typeof geoGa4NotifySettingsChanged === 'function') {
      geoGa4NotifySettingsChanged(reloaded ? reloaded.ga4_realtime_auto_refresh_enabled : form.ga4_realtime_auto_refresh_enabled);
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
    geoGa4SettingsValidateForm, geoGa4SettingsBuildPatch, geoGa4SettingsSave,
    geoGa4SettingsTestConnection, geoGa4SettingsRenderTestResult, geoGa4SettingsUpdateCooldown,
    _geoGa4SettingsReadForm, _geoGa4SettingsClearFieldErrors, _geoGa4SettingsRenderFieldErrors,
  };
}
