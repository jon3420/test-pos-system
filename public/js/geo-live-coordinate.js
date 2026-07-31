// public/js/geo-live-coordinate.js — fix18-10-hotfix30-B5-R5.4-G1
// Geo Intelligence V2｜Live Coordinate Acquisition（顧客頁面端）
//
// 唯一目的：在使用者「主動同意」之後，用瀏覽器原生 Geolocation API 取得真實
// 座標，回報給 POST /api/geo-live/coordinate。絕不在頁面載入時就強制彈出
// 定位請求；絕不使用 IP 推估；絕不重複騷擾已經拒絕過的使用者。
//
// 使用方式（由既有點餐頁面明確呼叫，本檔案不假設任何全域變數存在）：
//   <script src="/js/geo-live-coordinate.js"></script>
//   <script>
//     GeoLiveCoordinate.init({
//       storeId: LINE_STORE_ID,
//       getVisitorId: _getVisitorId,   // 沿用頁面既有的訪客識別（單一資料來源）
//       getSessionId: _getSessionId,
//     });
//     // 觸發時機一：使用者按下「使用目前位置」按鈕
//     useMyLocationBtn.addEventListener('click', () => GeoLiveCoordinate.requestNow('user_button'));
//     // 觸發時機二：使用者進入外送地址流程
//     GeoLiveCoordinate.requestOnDeliveryFlow(); // 內部會自行判斷是否已同意過
//   </script>
//
// 不得：頁面一載入就無提示強制要求定位（見需求文件一）。本模組的 init() 本身
// 「不會」呼叫 getCurrentPosition()，只有下面明確列出的觸發函式才會，而且
// 每一個觸發函式都會先檢查「使用者是否已經拒絕過（cooldown 內）」。

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.GeoLiveCoordinate = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ── 純函式部分（可在 Node 環境下用 require() 單獨測試，不依賴 window/navigator）──

  const CONSENT_STORAGE_KEY_PREFIX = 'geo_live_coord_consent_';
  // 使用者明確拒絕後的冷卻期：7 天內不得再次跳出我們自己的定位說明提示
  // （瀏覽器原生的權限對話框本身在使用者永久封鎖後也不會再跳出，這裡的
  // cooldown 是「我們自己 UI 上的引導提示」層級，避免同一使用者每次進站都
  // 看到「是否允許定位？」的提示卡片）。
  const DENY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
  // 已同意過的使用者，背景靜默更新的最短間隔（避免每次頁面互動都打一次
  // getCurrentPosition，需求文件十四「更新頻率需合理」）。
  const BACKGROUND_UPDATE_MIN_INTERVAL_MS = 5 * 60 * 1000;

  const GEOLOCATION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    timeout: 8000,
    maximumAge: 60000,
  });

  // PositionError.code → 我們的 coordinate_status 列舉值（純函式，方便單元測試）。
  // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  function mapGeolocationErrorToStatus(err) {
    if (!err || typeof err.code !== 'number') return 'error';
    if (err.code === 1) return 'denied';
    if (err.code === 2) return 'unavailable';
    if (err.code === 3) return 'timeout';
    return 'error';
  }

  function _now() { return Date.now(); }

  // 讀取/寫入同意狀態的 key 名稱（每家店各自獨立，避免多店同瀏覽器互相污染）。
  function _consentKey(storeId) { return CONSENT_STORAGE_KEY_PREFIX + String(storeId || ''); }

  // 純函式：判斷「現在」是否應該再次嘗試取得定位（給 requestOnDeliveryFlow /
  // 背景更新使用）。record 是先前存在 localStorage 的 { status, capturedAtMs }。
  function shouldAttemptGeolocation(record, nowMs) {
    const t = typeof nowMs === 'number' ? nowMs : _now();
    if (!record || !record.status) return true; // 從未詢問過 → 可以詢問
    if (record.status === 'granted') {
      // 已同意過：只有超過背景更新最短間隔才再抓一次（不是每次呼叫都真的定位）。
      return (t - (record.capturedAtMs || 0)) >= BACKGROUND_UPDATE_MIN_INTERVAL_MS;
    }
    if (record.status === 'denied') {
      // 明確拒絕：cooldown 內絕不再問。
      return (t - (record.capturedAtMs || 0)) >= DENY_COOLDOWN_MS;
    }
    // timeout/unavailable/unsupported/error/unknown：允許使用者「主動」再試
    // 一次（例如按下「使用目前位置」按鈕），但背景自動流程不主動重試，避免
    // 因為訊號不穩定反覆彈出。呼叫端決定是否要用 forceUserGesture=true。
    return true;
  }

  function _safeGetJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function _safeSetJson(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* Storage 不可用時安靜失敗，不影響主要點餐流程 */ }
  }

  // ── 需要 window/navigator/fetch 的部分：guard 起來，Node 環境 require() 這支
  // 檔案時不會因為缺少瀏覽器全域物件而拋例外（只是這幾個方法會是 no-op）。
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';

  let _config = null; // { storeId, getVisitorId, getSessionId }
  let _pending = false; // 同一時間只允許一個 getCurrentPosition() 在跑，避免重複觸發

  function _storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function _readConsentRecord() {
    if (!hasWindow || !_config) return null;
    const s = _storage();
    if (!s) return null;
    return _safeGetJson(s, _consentKey(_config.storeId));
  }
  function _writeConsentRecord(status, capturedAtMs) {
    if (!hasWindow || !_config) return;
    const s = _storage();
    if (!s) return;
    _safeSetJson(s, _consentKey(_config.storeId), { status, capturedAtMs: capturedAtMs || _now() });
  }

  function _postStatus(status, extra) {
    if (!_config) return;
    const body = Object.assign({
      visitor_id: _config.getVisitorId ? _config.getVisitorId() : null,
      session_id: _config.getSessionId ? _config.getSessionId() : null,
      status,
    }, extra || {});
    if (!body.visitor_id || !body.session_id) return; // 沒有訪客識別就不回報，避免髒資料
    try {
      const url = '/api/geo-live/coordinate' + (_config.storeId ? ('?store_id=' + encodeURIComponent(_config.storeId)) : '');
      const fetchFn = (hasWindow && typeof window.apiFetch === 'function') ? window.apiFetch : fetch;
      fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .catch(() => { /* fire-and-forget：定位回報失敗絕不影響點餐主流程 */ });
    } catch (e) { /* 同上 */ }
  }

  // 真正呼叫瀏覽器 Geolocation API 並回報結果。
  // triggerReason 只用於除錯/未來分析用途的 source 標記，不影響驗證邏輯。
  function _doRequestPosition() {
    if (_pending) return; // 避免同一頁面短時間內重複觸發多個定位請求
    if (!hasNavigator || !navigator.geolocation) {
      _writeConsentRecord('unsupported');
      _postStatus('unsupported');
      return;
    }
    _pending = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _pending = false;
        const lat = pos && pos.coords ? pos.coords.latitude : null;
        const lng = pos && pos.coords ? pos.coords.longitude : null;
        const accuracy = pos && pos.coords ? pos.coords.accuracy : null;
        _writeConsentRecord('granted');
        _postStatus('granted', { lat, lng, accuracy_m: accuracy, source: 'browser_geolocation' });
      },
      (err) => {
        _pending = false;
        const status = mapGeolocationErrorToStatus(err);
        _writeConsentRecord(status);
        _postStatus(status, { source: 'browser_geolocation' });
      },
      GEOLOCATION_OPTIONS
    );
  }

  // ── 對外 API ─────────────────────────────────────────────────

  function init(config) {
    _config = config || {};
  }

  // 使用者「主動」觸發（按鈕點擊等明確手勢）：不管 cooldown，一律嘗試一次
  // （使用者自己按下去要求重試，不是我們背景自動彈出，符合需求文件「使用者
  // 主動按『使用目前位置』」的觸發時機）。
  function requestNow() {
    _doRequestPosition();
  }

  // 使用者進入外送地址流程時呼叫：只有在「從未問過」或「已同意且該更新了」
  // 時才會真的呼叫瀏覽器 API；拒絕過的在 cooldown 內完全不會觸發，不會反覆
  // 彈出（需求文件三之一）。
  function requestOnDeliveryFlow() {
    const record = _readConsentRecord();
    if (shouldAttemptGeolocation(record, _now())) _doRequestPosition();
  }

  // 已有同意紀錄時才可背景更新（需求文件一之四）：明確要求「必須已同意過」，
  // 不像 requestOnDeliveryFlow 那樣連「從未問過」的情況都會觸發。
  function backgroundUpdateIfGranted() {
    const record = _readConsentRecord();
    if (record && record.status === 'granted' && shouldAttemptGeolocation(record, _now())) {
      _doRequestPosition();
    }
  }

  function getConsentRecord() { return _readConsentRecord(); }

  return {
    // 對外方法
    init, requestNow, requestOnDeliveryFlow, backgroundUpdateIfGranted, getConsentRecord,
    // 純函式（供 Node 環境 / 智慧測試直接呼叫，不需要瀏覽器環境）
    mapGeolocationErrorToStatus, shouldAttemptGeolocation,
    DENY_COOLDOWN_MS, BACKGROUND_UPDATE_MIN_INTERVAL_MS, GEOLOCATION_OPTIONS,
  };
}));
