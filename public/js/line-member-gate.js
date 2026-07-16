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

  // fix18-10-hotfix26-G（需求文件五／十七～二十三）：從外部「加入／解除封鎖官方
  // 帳號」頁面返回時，需要自動重新查詢好友狀態；以及 ID Token 過期時最多自動
  // 重新登入一次，避免無限跳轉迴圈。都用 sessionStorage 記錄，同一瀏覽器分頁
  // 內有效，不落地到 localStorage（不需要跨分頁/長期保存）。
  const AWAITING_FRIENDSHIP_RETURN_KEY = 'line_friendship_recheck_required';
  const REAUTH_ATTEMPTED_KEY = 'line_friend_reauth_attempted';

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
        // fix18-10-hotfix26-B：改用共用 normalizeServerFriendStatus()，同時支援
        // is_friend／friend_status 兩種回應欄位，行為與 verify 呼叫端一致。
        is_friend: normalizeServerFriendStatus(data),
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

  // fix18-10-hotfix26（需求文件三）：取得目前登入者的好友狀態。每次登入／每次
  // verify 都重新呼叫一次（不只在第一次建立會員時取得），使用者今天才加入的話
  // 狀態才能被更新。API 失敗一律回傳 null（未知），絕不拋出例外阻擋登入流程，
  // 也絕不把例外直接顯示給顧客（只 console.warn）。
  async function getClientFriendFlag() {
    try {
      if (!global.liff || typeof global.liff.getFriendship !== 'function') return null;
      const friendship = await global.liff.getFriendship();
      return typeof (friendship && friendship.friendFlag) === 'boolean' ? friendship.friendFlag : null;
    } catch (e) {
      console.warn('[LINE Member] Unable to get friendship status:', e.message);
      return null;
    }
  }

  // fix18-10-hotfix26-B（需求文件三）：後端 verify 回應可能同時有 is_friend／
  // friend_status（member 物件內或頂層），這裡統一成單一入口，避免不同流程各自
  //判斷造成不一致。優先看 is_friend（true/false），查無再看 friend_status
  // 字串，都沒有才是 null（未知）。
  function normalizeServerFriendStatus(response) {
    if (!response) return null;
    if (response.is_friend === true) return true;
    if (response.is_friend === false) return false;
    if (response.friend_status === 'friend') return true;
    if (response.friend_status === 'non_friend') return false;
    if (response.member) return normalizeServerFriendStatus(response.member);
    return null;
  }

  // fix18-10-hotfix26-B（需求文件三）：後端可能回傳 require_friend 或
  // require_follow（兩個命名同義），這裡統一成單一布林值，避免不同流程各自
  //讀取不同欄位造成判斷不一致。
  function normalizeRequireFollow(response) {
    return !!(response && (response.require_follow === true || response.require_friend === true));
  }

  // fix18-10-hotfix26-B（需求文件四）：是否符合「要求加入官方帳號」規則。
  // require_follow=false → 一律放行；require_follow=true 時 true→放行、
  // false→阻擋、null/undefined（未知）→放行（不可把未知誤判為非好友）。
  function friendRequirementMet(requireFollow, isFriend) {
    if (!requireFollow) return true;
    if (isFriend === true) return true;
    if (isFriend === null || isFriend === undefined) return true;
    return false;
  }

  // fix18-10-hotfix26-G（需求文件五）：標記「等待從外部加好友頁返回」。開啟
  // lin.ee／requestFriendship 前呼叫，返回頁面（visibilitychange/pageshow/
  // focus）時據此判斷是否要自動重新查詢好友狀態。
  function markAwaitingFriendshipReturn() {
    try { sessionStorage.setItem(AWAITING_FRIENDSHIP_RETURN_KEY, '1'); } catch (e) {}
  }
  function clearAwaitingFriendshipReturn() {
    try { sessionStorage.removeItem(AWAITING_FRIENDSHIP_RETURN_KEY); } catch (e) {}
  }
  function isAwaitingFriendshipReturn() {
    try { return sessionStorage.getItem(AWAITING_FRIENDSHIP_RETURN_KEY) === '1'; } catch (e) { return false; }
  }

  // fix18-10-hotfix26-G（需求文件十九）：安全解析 JWT payload，只用來判斷是否
  // 即將過期——前端解析結果絕對不能取代後端正式驗證（後端仍會用自己的
  // verifyLineIdToken() 呼叫 LINE 官方 API），也不可信任 decode 出來的 user id。
  function decodeJwtPayloadSafely(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const json = decodeURIComponent(
        atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
      );
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  // fix18-10-hotfix26-G（需求文件十七～十九）：根因修正——先前每次都直接用
  // global.liff.getIDToken() 送出，若 LIFF session 內部快取的 ID Token 已過期
  // （例如使用者停留很久、或離開頁面去解除封鎖再回來），後端 verify 會回
  // EXPIRED_ID_TOKEN，但前端當時只顯示「暫時無法確認」，不會主動恢復，導致
  // 使用者持續卡在加入好友彈窗（見需求文件根因分析）。這裡在送出前先在前端
  // 檢查 exp，快過期／已過期就不要送出注定失敗的請求，改觸發重新登入。
  async function getFreshLineIdToken(storeId, opts) {
    const minValiditySeconds = (opts && opts.minValiditySeconds) || 60;
    if (!isLiffAvailable(storeId)) return { ok: false, code: 'LIFF_NOT_AVAILABLE', idToken: null };
    if (!global.liff.isLoggedIn()) return { ok: false, code: 'LINE_NOT_LOGGED_IN', idToken: null };
    const idToken = global.liff.getIDToken();
    if (!idToken) return { ok: false, code: 'ID_TOKEN_MISSING', idToken: null };
    const payload = decodeJwtPayloadSafely(idToken);
    // 解不出 payload／沒有 exp：不在前端擋，交給後端正式驗證判斷（前端解析
    // 失敗不代表 Token 真的有問題，避免前端誤判擋下原本有效的 Token）。
    if (!payload || !payload.exp) return { ok: true, code: 'ID_TOKEN_READY', idToken };
    const remainingSeconds = payload.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds <= minValiditySeconds) {
      return { ok: false, code: 'ID_TOKEN_EXPIRED_OR_EXPIRING', idToken: null, remainingSeconds };
    }
    return { ok: true, code: 'ID_TOKEN_READY', idToken, remainingSeconds };
  }

  // fix18-10-hotfix26-G（需求文件二十二）：ID Token 已過期／即將過期時，嘗試
  // 重新建立 LINE 登入狀態。用 sessionStorage 旗標保證同一分頁內最多自動嘗試
  // 一次，不得無限重登；購物車由既有 ORDER_CART_KEY 機制自然保留，這裡不需要
  // 額外保存購物車內容，只需標記「返回後要自動重新確認好友狀態」。
  async function recoverLineLoginSession(storeId) {
    if (!isLiffAvailable(storeId)) return { ok: false, code: 'LIFF_NOT_AVAILABLE' };
    let alreadyAttempted = false;
    try { alreadyAttempted = sessionStorage.getItem(REAUTH_ATTEMPTED_KEY) === '1'; } catch (e) {}
    if (alreadyAttempted) return { ok: false, code: 'LINE_RELOGIN_REQUIRED' };
    try { sessionStorage.setItem(REAUTH_ATTEMPTED_KEY, '1'); } catch (e) {}
    try {
      markLoginInProgress();
      markAwaitingFriendshipReturn();
      if (typeof global.liff.logout === 'function') {
        try { global.liff.logout(); } catch (e) { /* logout 失敗也繼續嘗試 login */ }
      }
      global.liff.login({ redirectUri: buildReturnUrl(storeId, { gate_stage: 'friend_recheck' }) });
      return { ok: false, code: 'REAUTH_REDIRECT_STARTED' };
    } catch (e) {
      return { ok: false, code: 'UNKNOWN_VERIFY_ERROR' };
    }
  }
  // 成功登入後（新頁面載入、handleLineMemberLoginCallback 完成）應清掉「只能
  // 嘗試一次」的旗標，讓下一次真的過期時還能再自動恢復一次。
  function clearReauthAttemptedFlag() {
    try { sessionStorage.removeItem(REAUTH_ATTEMPTED_KEY); } catch (e) {}
  }

  // 呼叫後端驗證，換得簽章過的 member_session。絕不在前端自行判斷登入是否有效。
  // fix18-10-hotfix26-G：retry_attempt 只是純診斷計數（送給後端寫進 Verify
  // Timeline，方便人工判讀「是否重複送出同一枚過期 Token」），不作為任何安全
  // 判斷依據，也不影響前端自己的重試次數限制（那個仍由 _reauthAttempted /
  // sessionStorage 旗標控制，最多自動恢復一次）。
  let _verifyRetryAttempt = 0;

  async function verifyWithBackend(storeId, extra) {
    try {
      if (!global.liff || !global.liff.isLoggedIn()) return { success: false, reason: 'not_logged_in', code: 'LINE_NOT_LOGGED_IN' };
      // fix18-10-hotfix26-G（需求文件十七～二十）：每次呼叫都重新從目前 LIFF
      // session 取得 Token（不使用頁面初始化時保存的舊值、不讀 sessionStorage
      // 快取的舊 idToken），並先在前端檢查是否已過期／即將過期。
      const tokenResult = await getFreshLineIdToken(storeId, { minValiditySeconds: 60 });
      if (!tokenResult.ok) {
        if (tokenResult.code === 'ID_TOKEN_EXPIRED_OR_EXPIRING' || tokenResult.code === 'ID_TOKEN_MISSING') {
          // Token 已經確定過期／即將過期，送出注定失敗的請求沒有意義，直接嘗試
          // 一次性自動重新登入（需求文件二十二），而不是先打一次一定會失敗的 verify。
          const recovery = await recoverLineLoginSession(storeId);
          return { success: false, reason: 'token_expired', code: tokenResult.code, recoverable: true, action: 'REAUTHENTICATE', recovery_code: recovery.code };
        }
        return { success: false, reason: 'not_logged_in', code: tokenResult.code };
      }
      const idToken = tokenResult.idToken;
      const accessToken = global.liff.getAccessToken();
      // fix18-10-hotfix26（需求文件三）：每次 verify 都重新取得好友狀態，一併送給
      // 後端當備援訊號（後端仍以自己呼叫 LINE API 的結果為主，見 routes/line-member.js）。
      const friendFlag = await getClientFriendFlag();
      const body = {
        id_token: idToken,
        access_token: accessToken,
        friend_flag: friendFlag,
        visitor_id: extra && extra.visitor_id,
        session_id: extra && extra.session_id,
        cart_id: extra && extra.cart_id,
        attribution: extra && extra.attribution,
        analytics: { gate_stage: extra && extra.gate_stage, order_mode: extra && extra.order_mode },
        // fix18-10-hotfix26-G：純診斷用途，後端不會拿它做任何安全判斷。
        retry_attempt: _verifyRetryAttempt,
      };
      const res = await fetch('/api/line-member/verify?store_id=' + encodeURIComponent(storeId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        _verifyRetryAttempt = 0;
        clearReauthAttemptedFlag();
        saveMemberSession(storeId, json);
        return json;
      }
      // fix18-10-hotfix26-G（需求文件二十一）：後端仍回傳 EXPIRED_ID_TOKEN（例如
      // 前端解析誤判、或時間差邊界情況），且尚未自動恢復過，就再嘗試一次；
      // 不得重送同一枚 Token、不得無限重試（recoverLineLoginSession 內部本身
      // 已用 sessionStorage 旗標保證最多一次）。
      if (json.code === 'EXPIRED_ID_TOKEN' && json.recoverable) {
        _verifyRetryAttempt += 1;
        const recovery = await recoverLineLoginSession(storeId);
        return { ...json, recovery_code: recovery.code };
      }
      _verifyRetryAttempt += 1;
      return json;
    } catch (e) {
      console.warn('[line-member-gate] verifyWithBackend failed:', e.message);
      return { success: false, reason: 'exception', code: 'UNKNOWN_VERIFY_ERROR' };
    }
  }

  // fix18-10-hotfix26：重新確認好友狀態＝重新呼叫一次 verify。用旗標防止連續
  // 點擊造成併發更新（需求文件二十三）。
  let _friendRecheckInFlight = false;
  async function recheckFriendship(storeId, extra) {
    if (_friendRecheckInFlight) return { success: false, reason: 'in_progress' };
    _friendRecheckInFlight = true;
    try {
      return await verifyWithBackend(storeId, { ...(extra || {}), gate_stage: (extra && extra.gate_stage) || 'friend_recheck' });
    } finally {
      _friendRecheckInFlight = false;
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

  // fix18-10-hotfix26-B（需求文件六）：優先嘗試 liff.requestFriendship()（若 SDK
  // 提供且支援），失敗／不支援／使用者取消時 fallback 到 add_friend_url。
  // 絕不清除購物車、絕不清除 sessionStorage 返回網址、絕不卡住登入中旗標——
  // 這個函式完全不觸碰那些狀態，只負責「打開加好友的畫面」。完成後仍要靠使用者
  // 按「重新確認」才會真正更新好友狀態，不假設 requestFriendship 一定成功。
  async function openFriendAddPage(config) {
    const url = config && config.add_friend_url;
    try {
      if (global.liff && typeof global.liff.requestFriendship === 'function') {
        await global.liff.requestFriendship();
        return { attempted: true, method: 'requestFriendship' };
      }
    } catch (e) {
      console.warn('[LINE Member] requestFriendship failed, using add friend URL:', e.message);
    }
    if (!url) {
      setGateStatus('尚未設定官方帳號加入網址');
      return { attempted: false, method: 'none' };
    }
    try {
      if (global.liff && typeof global.liff.isInClient === 'function' && global.liff.isInClient() && typeof global.liff.openWindow === 'function') {
        // LINE App 內建瀏覽器：用 liff.openWindow 開外部連結，避免部分機型對
        // window.open 支援不穩定。
        global.liff.openWindow({ url, external: true });
      } else {
        window.open(url, '_blank');
      }
    } catch (e) {
      try { window.open(url, '_blank'); } catch (e2) { /* 開窗失敗也不拋例外中斷流程 */ }
    }
    return { attempted: true, method: 'add_friend_url' };
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

  // fix18-10-hotfix26-B（需求文件五）：沿用同一個 Gate 容器（同一個 #lineMemberGate
  // overlay／同一個 closeMemberGate() 可以關閉），只是內容換成「請先加入官方帳號」，
  // 不是另外建立一套完全不同的 Modal。
  function showFriendRequiredGate(config, opts) {
    closeMemberGate();
    gateEl = document.createElement('div');
    gateEl.id = 'lineMemberGate';
    gateEl.style.cssText = `position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);
      display:flex;align-items:center;justify-content:center;padding:16px;`;
    const allowSkip = !!(opts && opts.allow_skip);
    gateEl.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:360px;width:100%;padding:24px;text-align:center;font-family:inherit">
        <div style="font-size:40px;line-height:1;margin-bottom:8px">📣</div>
        <h3 style="margin:0 0 8px;font-size:18px">請先加入 LINE 官方帳號</h3>
        <p style="margin:0 0 16px;color:#666;font-size:14px">加入或解除封鎖後，系統會自動重新確認好友狀態。</p>
        <div id="lmgStatus" style="font-size:13px;color:#888;margin-bottom:12px"></div>
        <button id="lmgAddFriendBtn" style="width:100%;padding:12px;border:0;border-radius:10px;background:#06C755;color:#fff;font-size:15px;font-weight:600;margin-bottom:8px;cursor:pointer">${escapeHtml(config.friend_button_text || '加入／解除封鎖官方帳號')}</button>
        <button id="lmgRecheckBtn" style="width:100%;padding:12px;border:1px solid #06C755;border-radius:10px;background:#fff;color:#06C755;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px">我已完成，重新確認</button>
        ${allowSkip ? `<button id="lmgSkipBtn" style="width:100%;padding:10px;border:0;background:transparent;color:#999;font-size:13px;cursor:pointer">${escapeHtml(config.skip_button_text || '略過')}</button>` : ''}
      </div>`;
    document.body.appendChild(gateEl);
    return gateEl;
  }

  // fix18-10-hotfix26-B（需求文件四／七／九）：require_follow 真正生效的核心
  // 流程。已經有本地 session 時也會檢查一次（避免舊 session 是在 require_follow
  // 還沒開啟時建立的）。用模組內 state（_friendGateCompletedStores）記錄「這個
  // 分頁這次已經確認過好友」，避免 recheck 成功、Gate 關閉後，同一頁面內又被
  // 其他呼叫端重新打開（需求文件九防循環）——不额外新增 sessionStorage key。
  const _friendGateCompletedStores = {};
  // fix18-10-hotfix26-G（需求文件五）：目前開啟中的「請先加入好友」Gate（若有），
  // 供 attemptAutoFriendshipResume() 在使用者從外部加好友頁返回時，直接把這個
  // 還沒 resolve 的 Promise 解開、自動關閉彈窗、繼續原本被中斷的送單流程——
  // 不需要另外引入 pendingCheckoutSubmission 回呼機制，submitOrder() 本來就是
  // await 著這個 Promise，resolve 了就會自動往下執行。
  let _activeFriendGate = null; // { storeId, config, ids, onEvent, resolve }

  function ensureFriendRequirement(storeId, config, ids, onEvent) {
    return new Promise((resolve) => {
      const session = getMemberSession(storeId);
      const requireFollow = !!(config && (config.require_friend || config.require_follow));
      const isFriend = session ? session.is_friend : null;
      if (_friendGateCompletedStores[storeId] || friendRequirementMet(requireFollow, isFriend)) {
        return resolve({ ok: true, session });
      }
      onEvent && onEvent('friend_prompt_shown');
      const gate = showFriendRequiredGate(config, { allow_skip: !!(config && config.allow_skip) });
      const addBtn = gate.querySelector('#lmgAddFriendBtn');
      const recheckBtn = gate.querySelector('#lmgRecheckBtn');
      const skipBtn = gate.querySelector('#lmgSkipBtn');
      let recheckInProgress = false;

      const wrappedResolve = (result) => {
        _activeFriendGate = null;
        resolve(result);
      };
      _activeFriendGate = { storeId, config, ids, onEvent, resolve: wrappedResolve };

      async function runRecheckAndSettle() {
        if (recheckInProgress) return;
        recheckInProgress = true;
        recheckBtn.disabled = true;
        setGateStatus('正在向 LINE 確認好友狀態…');
        let res;
        try {
          res = await recheckFriendship(storeId, ids);
        } finally {
          recheckInProgress = false;
          recheckBtn.disabled = false;
        }
        const nowFriend = normalizeServerFriendStatus(res);
        if (res && res.success && nowFriend === true) {
          _friendGateCompletedStores[storeId] = true;
          onEvent && onEvent('friend_gate_passed');
          setGateStatus('已確認加入官方帳號，正在繼續送出訂單…');
          closeMemberGate();
          wrappedResolve({ ok: true, session: getMemberSession(storeId) });
        } else if (res && res.success && nowFriend === false) {
          // B：仍非好友——不得當成放行，Gate 保持開啟
          setGateStatus('LINE 目前仍回傳尚未加入或仍在封鎖中，請完成加入後再重新確認。');
        } else if (res && (res.reason === 'token_expired' || res.code === 'ID_TOKEN_EXPIRED_OR_EXPIRING')) {
          // fix18-10-hotfix26-G：正在自動重新登入（可能導致頁面跳轉），不要顯示
          // 一般錯誤字樣嚇到使用者。
          setGateStatus('登入狀態已過期，正在為您重新登入…');
        } else {
          // C：null／API 失敗／verify 失敗——不自動放行、不無限重試，只提示可再試一次
          setGateStatus('暫時無法取得 LINE 好友狀態，請稍後再試。');
        }
      }

      recheckBtn.addEventListener('click', runRecheckAndSettle);
      addBtn.addEventListener('click', async () => {
        // fix18-10-hotfix26-G（需求文件四／五）：開啟加好友頁前先標記「等待返回」，
        // 讓使用者從 lin.ee／解除封鎖流程返回時，visibilitychange/pageshow/focus
        // 能自動重新查詢，不必一定要再按一次「重新確認」。
        markAwaitingFriendshipReturn();
        const addRes = await openFriendAddPage(config);
        // requestFriendship() resolve 不代表使用者一定已加入／解除封鎖（需求文件
        // 四第 1 點），但既然 LIFF 內建流程已經跑完一輪、使用者已經回到這個頁面
        // （沒有實際跳轉離開），直接順手自動重新確認一次，省去使用者還要再按
        // 「重新確認」的一步；若使用者其實取消了，這裡就只是查到 friendFlag=false，
        // Gate 照樣保持開啟，不會誤放行。
        if (addRes && addRes.method === 'requestFriendship') {
          await runRecheckAndSettle();
        }
      });
      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          onEvent && onEvent('line_gate_skipped');
          closeMemberGate();
          wrappedResolve({ ok: false, skipped: true });
        });
      }
    });
  }

  // fix18-10-hotfix26-G（需求文件五）：使用者從外部「加入／解除封鎖官方帳號」
  // 頁面返回時（lin.ee 分頁關閉、或切回 LINE App 內的點餐頁），自動重新查詢
  // 好友狀態，不必等使用者自己按「重新確認」。用 debounce + in-flight lock
  // 避免 visibilitychange/pageshow/focus 短時間內重複觸發造成多次併發請求。
  let _friendshipResumeTimer = null;
  let _friendshipResumeInFlight = false;
  async function attemptAutoFriendshipResume() {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    const gate = _activeFriendGate;
    if (!gate && !isAwaitingFriendshipReturn()) return;
    clearTimeout(_friendshipResumeTimer);
    _friendshipResumeTimer = setTimeout(async () => {
      if (_friendshipResumeInFlight) return;
      _friendshipResumeInFlight = true;
      try {
        const target = _activeFriendGate;
        const storeId = target ? target.storeId : (getCurrentStoreId() || null);
        if (!storeId) { clearAwaitingFriendshipReturn(); return; }
        if (target) setGateStatus('正在向 LINE 確認好友狀態…');
        const res = await recheckFriendship(storeId, target ? target.ids : {});
        const nowFriend = normalizeServerFriendStatus(res);
        if (res && res.success && nowFriend === true) {
          clearAwaitingFriendshipReturn();
          if (target) {
            _friendGateCompletedStores[storeId] = true;
            target.onEvent && target.onEvent('friend_gate_passed');
            setGateStatus('已確認加入官方帳號，正在繼續送出訂單…');
            closeMemberGate();
            target.resolve({ ok: true, session: getMemberSession(storeId) });
          }
        } else if (target && res && res.success && nowFriend === false) {
          setGateStatus('LINE 目前仍回傳尚未加入或仍在封鎖中，請完成加入後再重新確認。');
        } else if (target) {
          setGateStatus('暫時無法取得 LINE 好友狀態，請稍後再試。');
        }
        // 非 target（沒有開著的 Gate）情況下，只是安靜地把 is_friend 同步好，
        // 不用跳出任何 UI；若仍非好友／查詢失敗，保留 awaiting 旗標，下次
        // 使用者再切回來還會再檢查一次。
      } finally {
        _friendshipResumeInFlight = false;
      }
    }, 500);
  }
  document.addEventListener('visibilitychange', attemptAutoFriendshipResume);
  global.addEventListener('pageshow', attemptAutoFriendshipResume);
  global.addEventListener('focus', attemptAutoFriendshipResume);


  // callback(result) — result: {ok:true} 表示可以繼續；{ok:false, skipped:true} 表示使用者略過
  function requireMemberBeforeCheckout(storeId, config, ids, onEvent) {
    return new Promise((resolve) => {
      const existing = getMemberSession(storeId);
      if (existing) {
        // fix18-10-hotfix26-B：已登入時，仍要再檢查一次是否符合好友要求
        // （例如 session 是在店家還沒開啟「要求加入官方帳號」之前建立的，
        // 或稍後才被設為要求好友）。
        ensureFriendRequirement(storeId, config, ids, onEvent).then(resolve);
        return;
      }
      onEvent && onEvent('friend_prompt_shown');
      const gate = showMemberGate(config, { allow_skip: false });
      const loginBtn = gate.querySelector('#lmgLoginBtn');
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
          closeMemberGate();
          // fix18-10-hotfix26-B：登入成功後，改由 ensureFriendRequirement 統一
          // 判斷是否還要顯示「請先加入官方帳號」畫面（沿用同一個 Gate 容器）。
          const friendRes = await ensureFriendRequirement(storeId, config, ids, onEvent);
          resolve(friendRes);
        } else {
          setGateStatus(verifyRes.message || '登入失敗，請重試');
        }
      });
    });
  }

  function requireMemberOnEntry(storeId, config, ids, onEvent) {
    return new Promise((resolve) => {
      const existing = getMemberSession(storeId);
      if (existing) {
        // fix18-10-hotfix26-B：同上，既有 session 也要檢查好友要求。
        ensureFriendRequirement(storeId, config, ids, onEvent).then(resolve);
        return;
      }
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
          // fix18-10-hotfix26-B：登入成功後，再檢查一次是否符合好友要求。
          const friendRes = await ensureFriendRequirement(storeId, config, ids, onEvent);
          resolve(friendRes);
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
    // fix18-10-hotfix26-B 新增：LINE Friendship Gate
    getClientFriendFlag, recheckFriendship, normalizeServerFriendStatus,
    normalizeRequireFollow, friendRequirementMet, ensureFriendRequirement,
    showFriendRequiredGate,
    // fix18-10-hotfix26-D 新增：供「LINE 設定診斷中心」重用，不重複寫一套 SDK 載入邏輯
    loadLiffSdk,
    // fix18-10-hotfix26-G 新增：ID Token 過期自動恢復 × 加好友返回自動重新確認
    getFreshLineIdToken, recoverLineLoginSession, decodeJwtPayloadSafely,
    markAwaitingFriendshipReturn, clearAwaitingFriendshipReturn, isAwaitingFriendshipReturn,
  };

})(window);
