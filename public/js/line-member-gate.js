// public/js/line-member-gate.js — fix18-10-hotfix25｜LINE 會員登入共用模組
// （點餐／宅配共用同一套 LINE 會員資料 × 登入後返回原入口）
//
// 共用模組，供 line-order.html 與 line-shipping.html 共同載入。
// 只負責：LIFF 初始化／登入、與後端 /api/line-member/verify 溝通、Gate UI
// 顯示/關閉、member_session 的本地儲存與讀取。不判斷金額/付款狀態/訂單是否
// 成立（那些仍由後端負責）；任何失敗都不得拋出例外阻擋點餐流程。
//
// localStorage key：line_member_session_${store_id}
// 只保存：member_session（後端簽章過的短效 token）、遮罩後的 profile、
// is_friend、expires_at、gate 狀態。絕不保存 Access Token / ID Token /
// Channel Secret / 完整 line_user_id。
//
// fix18-10-hotfix25：新增「共用登入返回機制」——
//   - 會員身分本來就已經共用（同一 liff_id / channel_id / line_members 主檔，
//     見 routes/line-member.js、utils/db.js 的 UNIQUE(store_id, line_user_id)）。
//   - LIFF 登入原本就是用 liff.login({redirectUri: 目前網址}) 導回原頁，本次
//     再加上 sessionStorage 備援（避免特定瀏覽器/LINE App 內建瀏覽器忽略
//     redirectUri 的邊界情況），並新增：回來後自動完成驗證（不需要使用者
//     再按一次登入）、一次性參數清除、登入中旗標＋逾時，避免無限跳轉/循環。

'use strict';
(function (global) {

  // ── sessionStorage keys（共用登入返回機制，需求文件二）────────────
  const RETURN_URL_KEY = 'line_member_return_url';
  const RETURN_STORE_KEY = 'line_member_return_store_id';
  const LOGIN_IN_PROGRESS_KEY = 'line_member_login_in_progress';
  const LOGIN_ATTEMPTED_KEY_PREFIX = 'line_member_login_attempted_';
  const LOGIN_IN_PROGRESS_TIMEOUT_MS = 2 * 60 * 1000; // hotfix25 修訂：2 分鐘逾時，避免卡死

  // 允許自動返回的系統內頁（需求文件三）。可依實際專案頁面擴充。
  const ALLOWED_RETURN_PATHS = new Set([
    '/line-order.html',
    '/line-shipping.html',
    '/member.html',
    '/coupons.html',
  ]);

  // 登入完成返回後應移除的一次性／測試／LINE Login callback 參數，避免重複
  // 觸發登入或無限循環（需求文件四／十三）。不動 store_id、商品 id、優惠券
  // code、取餐方式等既有購物流程參數。
  const TRANSIENT_RETURN_PARAMS = [
    'member_gate_test', 'line_login', 'login_required',
    'login_callback', 'code', 'state', 'liff.state',
  ];

  function getCurrentStoreId() {
    try {
      return new URLSearchParams(window.location.search).get('store_id') || '';
    } catch (e) { return ''; }
  }

  function loadLiffSdk() {
    return new Promise((resolve, reject) => {
      if (global.liff) return resolve(global.liff);
      const s = document.createElement('script');
      s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
      s.onload = () => resolve(global.liff);
      s.onerror = () => reject(new Error('LIFF SDK 載入失敗'));
      document.head.appendChild(s);
    });
  }

  function sessionKey(storeId) { return 'line_member_session_' + storeId; }

  function getMemberSession(storeId) {
    try {
      const raw = localStorage.getItem(sessionKey(storeId));
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.member_session || !data.expires_at) return null;
      if (Date.now() > Number(data.expires_at)) { clearMemberSession(storeId); return null; }
      return data;
    } catch (e) { return null; }
  }

  function saveMemberSession(storeId, data) {
    try {
      localStorage.setItem(sessionKey(storeId), JSON.stringify({
        member_session: data.member_session,
        display_name: data.member ? data.member.display_name : '',
        picture_url: data.member ? data.member.picture_url : '',
        line_user_id_masked: data.member ? data.member.line_user_id_masked : '',
        is_friend: data.member ? data.member.is_friend : null,
        is_blocked: data.member ? data.member.is_blocked : false,
        // member_session 內部已含 expires_at，這裡另外存一份給前端快速判斷（24hr）
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      }));
    } catch (e) { /* storage 失敗不影響流程 */ }
  }

  function clearMemberSession(storeId) {
    try { localStorage.removeItem(sessionKey(storeId)); } catch (e) {}
  }

  // fix18-10-hotfix23-E1：執行時再次驗證 return URL（需求文件十）。
  // 這裡一律以「目前頁面 origin」為準組成網址，本來就是同源、安全的來源，
  // 這個檢查是防禦性的第二道保險——避免未來若改成直接採用店家設定值時，
  // 忘記再驗證一次而直接把未經允許的網址交給 LINE Login 導頁。
  function isSafeReturnUrl(urlString) {
    try {
      const u = new URL(urlString, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.username || u.password) return false;
      // 只信任目前頁面所在的 origin，不接受任何跨網域網址
      return u.origin === window.location.origin;
    } catch (e) { return false; }
  }

  // fix18-10-hotfix25: path-allowlist return url validator for sessionStorage
  // based fallback return mechanism. Also requires store_id to match.
  function validateSafeInternalReturnUrl(rawUrl, storeId) {
    if (!rawUrl) return false;
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      if (parsed.origin !== window.location.origin) return false;
      if (parsed.username || parsed.password) return false;
      if (!ALLOWED_RETURN_PATHS.has(parsed.pathname)) return false;
      const urlStoreId = parsed.searchParams.get('store_id');
      if (storeId && urlStoreId && urlStoreId !== storeId) return false;
      return true;
    } catch (e) { return false; }
  }

  function saveLineMemberReturnUrl(storeId) {
    try {
      sessionStorage.setItem(RETURN_URL_KEY, window.location.href);
      sessionStorage.setItem(RETURN_STORE_KEY, storeId || getCurrentStoreId());
    } catch (e) { /* sessionStorage unavailable should not block login */ }
  }

  function getSavedLineMemberReturnUrl() {
    try { return sessionStorage.getItem(RETURN_URL_KEY) || ''; } catch (e) { return ''; }
  }

  function clearSavedLineMemberReturnUrl() {
    try {
      sessionStorage.removeItem(RETURN_URL_KEY);
      sessionStorage.removeItem(RETURN_STORE_KEY);
    } catch (e) {}
  }

  // Remove one-time/test params after returning from login so the page does
  // not immediately re-trigger login or loop.
  function stripTransientReturnParams() {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      TRANSIENT_RETURN_PARAMS.forEach((p) => {
        if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true; }
      });
      if (changed && global.history && global.history.replaceState) {
        global.history.replaceState(null, '', url.toString());
      }
    } catch (e) {}
  }

  // Login-in-progress flag with timeout, to avoid infinite redirect loops.
  function markLoginInProgress() {
    try { sessionStorage.setItem(LOGIN_IN_PROGRESS_KEY, String(Date.now())); } catch (e) {}
  }
  function clearLoginInProgress() {
    try { sessionStorage.removeItem(LOGIN_IN_PROGRESS_KEY); } catch (e) {}
  }
  function isLoginInProgress() {
    try {
      const raw = sessionStorage.getItem(LOGIN_IN_PROGRESS_KEY);
      if (!raw) return false;
      const startedAt = Number(raw);
      if (!startedAt || Date.now() - startedAt > LOGIN_IN_PROGRESS_TIMEOUT_MS) {
        clearLoginInProgress();
        return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // 登入跳轉前，保存原始頁面所需的一切狀態（購物車由既有 ORDER_CART_KEY 機制
  // 自然保留，這裡只需額外保存「要跳轉回來的網址」與 gate 觸發階段）。
  function buildReturnUrl(storeId, extra) {
    const url = new URL(window.location.href);
    url.searchParams.set('store_id', storeId);
    if (extra && extra.gate_stage) url.searchParams.set('line_gate_return', extra.gate_stage);
    const candidate = url.toString();
    saveLineMemberReturnUrl(storeId); // hotfix25 sessionStorage fallback
    if (isSafeReturnUrl(candidate)) return candidate;
    // fallback：目前頁面 origin + pathname + store_id（不得使用未經驗證的網址）
    console.warn('[line-member-gate] return url 驗證失敗，改用安全 fallback');
    return window.location.origin + window.location.pathname + '?store_id=' + encodeURIComponent(storeId);
  }

  const state = {}; // per-store 執行期狀態（不落地）

  async function initLineMemberGate(config, ids, onEvent) {
    const storeId = config.store_id;
    state[storeId] = { config, liffReady: false };
    if (!config.liff_id) return state[storeId];
    try {
      await loadLiffSdk();
      await global.liff.init({ liffId: config.liff_id });
      state[storeId].liffReady = true;
      try {
        state[storeId].loginCallbackResult = await handleLineMemberLoginCallback(storeId, ids, onEvent);
      } catch (e) { /* never let callback handling block the page */ }
    } catch (e) {
      console.warn('[line-member-gate] LIFF 初始化失敗:', e.message);
      state[storeId].liffReady = false;
      state[storeId].liffError = e.message;
      // fix18-10-hotfix25 (section 6): LIFF init failing mid-return-from-login
      // must not leave a stale in-progress flag around.
      clearLoginInProgress();
    }
    return state[storeId];
  }

  function isLiffAvailable(storeId) {
    return !!(state[storeId] && state[storeId].liffReady && global.liff);
  }

  async function loginWithLine(storeId, opts) {
    if (!isLiffAvailable(storeId)) throw new Error('liff_not_ready');
    if (!global.liff.isLoggedIn()) {
      markLoginInProgress();
      global.liff.login({ redirectUri: buildReturnUrl(storeId, opts) });
      return { redirected: true };
    }
    return { redirected: false };
  }

  // alias, spec section 9 naming
  function startLineMemberLogin(storeId, opts) { return loginWithLine(storeId, opts); }

  async function getLineProfile() {
    if (!global.liff || !global.liff.isLoggedIn()) return null;
    try { return await global.liff.getProfile(); } catch (e) { return null; }
  }

  // 呼叫後端驗證，換得簽章過的 member_session。絕不在前端自行判斷登入是否有效。
  async function verifyWithBackend(storeId, extra) {
    try {
      if (!global.liff || !global.liff.isLoggedIn()) return { success: false, reason: 'not_logged_in' };
      const idToken = global.liff.getIDToken();
      const accessToken = global.liff.getAccessToken();
      if (!idToken) return { success: false, reason: 'no_id_token' };
      const body = {
        id_token: idToken,
        access_token: accessToken,
        visitor_id: extra && extra.visitor_id,
        session_id: extra && extra.session_id,
        cart_id: extra && extra.cart_id,
        attribution: extra && extra.attribution,
        analytics: { gate_stage: extra && extra.gate_stage, order_mode: extra && extra.order_mode },
      };
      const res = await fetch('/api/line-member/verify?store_id=' + encodeURIComponent(storeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) saveMemberSession(storeId, json);
      return json;
    } catch (e) {
      console.warn('[line-member-gate] verifyWithBackend failed:', e.message);
      return { success: false, reason: 'exception' };
    }
  }

  // fix18-10-hotfix25 (spec section 2 / 13): called right after LIFF init.
  // If LIFF already reports logged-in (i.e. we just came back from the LINE
  // login redirect) but there is no local member_session yet, finish the
  // verification automatically instead of waiting for another button click.
  // Guarded by a login-in-progress flag + a per-store "already attempted"
  // flag so a verify failure never causes a retry loop or repeated LIFF
  // redirects. Always resolves (never throws) so it can't block ordering.
  async function handleLineMemberLoginCallback(storeId, ids, onEvent) {
    try {
      const attemptedKey = LOGIN_ATTEMPTED_KEY_PREFIX + storeId;
      const existing = getMemberSession(storeId);
      if (existing) {
        clearLoginInProgress();
        clearSavedLineMemberReturnUrl();
        try { sessionStorage.removeItem(attemptedKey); } catch (e) {}
        stripTransientReturnParams();
        return { ok: true, session: existing, autoVerified: false };
      }

      if (!isLiffAvailable(storeId) || !global.liff.isLoggedIn()) {
        // fix18-10-hotfix25 (section 2/6): if a login was in progress but we
        // come back not logged in (user cancelled, or LIFF init failed),
        // the attempt is over — clear the in-progress flag and saved return
        // url so we don't hold stale state that could suppress or confuse a
        // later legitimate login attempt.
        const wasInProgress = isLoginInProgress();
        clearLoginInProgress();
        if (wasInProgress) {
          clearSavedLineMemberReturnUrl();
          onEvent && onEvent('line_login_cancelled');
        }
        return { ok: false, autoVerified: false };
      }

      let alreadyAttempted = false;
      try { alreadyAttempted = sessionStorage.getItem(attemptedKey) === '1'; } catch (e) {}
      // Not "logging in" right now (no flag) and we already tried once this
      // browser session without success — do not keep retrying silently;
      // let the normal gate UI (button click) take over instead.
      if (!isLoginInProgress() && alreadyAttempted) {
        return { ok: false, autoVerified: false };
      }

      try { sessionStorage.setItem(attemptedKey, '1'); } catch (e) {}
      onEvent && onEvent('line_login_start');
      const verifyRes = await verifyWithBackend(storeId, { ...ids, gate_stage: 'callback' });
      clearLoginInProgress();
      stripTransientReturnParams();
      clearSavedLineMemberReturnUrl();
      if (verifyRes.success) {
        try { sessionStorage.removeItem(attemptedKey); } catch (e) {}
        onEvent && onEvent('line_login_success');
        return { ok: true, session: getMemberSession(storeId), autoVerified: true };
      }
      onEvent && onEvent('line_login_failed');
      return { ok: false, reason: verifyRes.reason, autoVerified: true };
    } catch (e) {
      clearLoginInProgress();
      return { ok: false, reason: 'exception', autoVerified: false };
    }
  }

  function getFriendshipStatus(storeId) {
    const s = getMemberSession(storeId);
    return s ? s.is_friend : null;
  }

  async function refreshFriendStatus(storeId, extra) {
    // 重新查詢好友狀態＝重新走一次 verify（後端會重查好友狀態並更新 history）。
    return verifyWithBackend(storeId, extra);
  }

  function openFriendAddPage(config) {
    const url = config && config.add_friend_url;
    if (!url) return;
    window.open(url, '_blank');
  }

  // ── Gate UI（輕量 fullscreen/modal，不依賴任何 CSS 框架）─────────────
  let gateEl = null;
  function showMemberGate(config, opts) {
    closeMemberGate();
    const mode = (opts && opts.mode) || 'modal'; // 'modal' | 'fullscreen'
    gateEl = document.createElement('div');
    gateEl.id = 'lineMemberGate';
    gateEl.style.cssText = `position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);
      display:flex;align-items:center;justify-content:center;padding:16px;`;
    const allowSkip = !!(opts && opts.allow_skip);
    gateEl.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:360px;width:100%;padding:24px;text-align:center;font-family:inherit">
        <div style="font-size:40px;line-height:1;margin-bottom:8px">💬</div>
        <h3 style="margin:0 0 8px;font-size:18px">${escapeHtml(config.title || 'LINE 會員登入')}</h3>
        <p style="margin:0 0 16px;color:#666;font-size:14px">${escapeHtml(config.description || '登入 LINE 會員即可享有專屬服務')}</p>
        <div id="lmgStatus" style="font-size:13px;color:#888;margin-bottom:12px"></div>
        <button id="lmgLoginBtn" style="width:100%;padding:12px;border:0;border-radius:10px;background:#06C755;color:#fff;font-size:15px;font-weight:600;margin-bottom:8px;cursor:pointer">${escapeHtml(config.login_button_text || '使用 LINE 登入')}</button>
        <button id="lmgFriendBtn" style="width:100%;padding:12px;border:1px solid #06C755;border-radius:10px;background:#fff;color:#06C755;font-size:15px;font-weight:600;margin-bottom:8px;cursor:pointer;display:none">${escapeHtml(config.friend_button_text || '加入官方帳號')}</button>
        ${allowSkip ? `<button id="lmgSkipBtn" style="width:100%;padding:10px;border:0;background:transparent;color:#999;font-size:13px;cursor:pointer">${escapeHtml(config.skip_button_text || '略過')}</button>` : ''}
      </div>`;
    document.body.appendChild(gateEl);
    return gateEl;
  }
  function closeMemberGate() {
    if (gateEl && gateEl.parentNode) gateEl.parentNode.removeChild(gateEl);
    gateEl = null;
  }
  function setGateStatus(text) {
    const el = document.getElementById('lmgStatus');
    if (el) el.textContent = text || '';
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── 高階 API：checkout / entry 兩種模式共用的驗證流程 ─────────────────
  // callback(result) — result: {ok:true} 表示可以繼續；{ok:false, skipped:true} 表示使用者略過
  function requireMemberBeforeCheckout(storeId, config, ids, onEvent) {
    return new Promise((resolve) => {
      const existing = getMemberSession(storeId);
      if (existing && (!config.require_friend || existing.is_friend === true)) {
        return resolve({ ok: true, session: existing });
      }
      onEvent && onEvent('friend_prompt_shown');
      const gate = showMemberGate(config, { allow_skip: false });
      const loginBtn = gate.querySelector('#lmgLoginBtn');
      const friendBtn = gate.querySelector('#lmgFriendBtn');
      loginBtn.addEventListener('click', async () => {
        setGateStatus('登入中…');
        onEvent && onEvent('line_login_start');
        if (!isLiffAvailable(storeId)) {
          setGateStatus('LIFF 尚未就緒，請稍後再試或改用加好友連結');
          return;
        }
        const loginRes = await loginWithLine(storeId, { gate_stage: 'checkout' });
        if (loginRes.redirected) return; // 頁面即將跳轉，購物車已由既有機制保留
        const verifyRes = await verifyWithBackend(storeId, { ...ids, gate_stage: 'checkout' });
        if (verifyRes.success) {
          if (config.require_friend && verifyRes.member.is_friend !== true) {
            friendBtn.style.display = 'block';
            setGateStatus('請先加入官方帳號才能繼續下單');
          } else {
            closeMemberGate();
            resolve({ ok: true, session: getMemberSession(storeId) });
          }
        } else {
          setGateStatus(verifyRes.message || '登入失敗，請重試');
        }
      });
      friendBtn.addEventListener('click', () => openFriendAddPage(config));
    });
  }

  function requireMemberOnEntry(storeId, config, ids, onEvent) {
    return new Promise((resolve) => {
      const existing = getMemberSession(storeId);
      if (existing) return resolve({ ok: true, session: existing });
      onEvent && onEvent('line_gate_view');
      const gate = showMemberGate(config, { allow_skip: !!config.allow_skip });
      const loginBtn = gate.querySelector('#lmgLoginBtn');
      const skipBtn = gate.querySelector('#lmgSkipBtn');
      loginBtn.addEventListener('click', async () => {
        setGateStatus('登入中…');
        onEvent && onEvent('line_login_start');
        if (!isLiffAvailable(storeId)) {
          setGateStatus('LIFF 尚未就緒，請稍後再試');
          return;
        }
        const loginRes = await loginWithLine(storeId, { gate_stage: 'entry' });
        if (loginRes.redirected) return;
        const verifyRes = await verifyWithBackend(storeId, { ...ids, gate_stage: 'entry' });
        if (verifyRes.success) {
          closeMemberGate();
          onEvent && onEvent('friend_gate_passed');
          resolve({ ok: true, session: getMemberSession(storeId) });
        } else {
          setGateStatus(verifyRes.message || '登入失敗，請重試');
        }
      });
      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          onEvent && onEvent('line_gate_skipped');
          closeMemberGate();
          resolve({ ok: false, skipped: true });
        });
      }
    });
  }

  // fix18-10-hotfix25: render a small "logged in / not logged in" status
  // line into any container element. Safe no-op if el is missing. Used by
  // both line-order.html and line-shipping.html (spec sections 7/8) so the
  // two entry pages show a consistent, shared member status.
  function renderLineMemberStatus(el, storeId, config) {
    if (!el) return;
    try {
      const enabled = !!(config && config.gate_enabled);
      if (!enabled) {
        el.textContent = 'LINE 會員登入：未啟用';
        el.style.color = '';
        return;
      }
      const session = getMemberSession(storeId);
      if (session) {
        const name = session.display_name ? `（${session.display_name}）` : '';
        el.textContent = `LINE 會員登入：已登入${name}`;
        el.style.color = '#06C755';
      } else {
        el.textContent = 'LINE 會員登入：已啟用（尚未登入）';
        el.style.color = '';
      }
    } catch (e) { /* status display is best-effort only */ }
  }

  global.LineMemberGate = {
    // 既有 API（維持相容，勿刪除／勿變更行為）
    initLineMemberGate, isLiffAvailable, loginWithLine, getLineProfile,
    getFriendshipStatus, refreshFriendStatus, openFriendAddPage,
    buildReturnUrl, saveMemberSession, getMemberSession, clearMemberSession,
    showMemberGate, closeMemberGate, verifyWithBackend,
    requireMemberBeforeCheckout, requireMemberOnEntry,
    // fix18-10-hotfix25 新增（需求文件九命名的公開 API）
    getCurrentStoreId, saveLineMemberReturnUrl, getSavedLineMemberReturnUrl,
    clearSavedLineMemberReturnUrl, validateSafeInternalReturnUrl,
    startLineMemberLogin, handleLineMemberLoginCallback,
    getLineMemberSession: getMemberSession, renderLineMemberStatus,
  };

})(window);
