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

  // fix18-10-hotfix26-I（Regression 修正）：本模組同時要能在真實瀏覽器與
  // Node.js（node --check／smoke test 用簡化版 window mock）執行。任何
  // document/window 專屬 API（addEventListener／clipboard／history／
  // location／sessionStorage／localStorage 等）都不可在 module top-level
  // 假設一定存在，一律先用 hasDOM／個別 typeof 檢查，找不到就安全略過，
  // 不得丟出例外中斷整支模組載入。
  const hasDOM = typeof global !== 'undefined' && typeof global.document !== 'undefined';

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

  // fix18-10-hotfix26-I（需求文件六／十一）：Facebook／Instagram 內建瀏覽器
  // 環境切換時，只允許轉傳這些「非敏感、不會被拿來偽造身分」的參數，絕不轉傳
  // Token／Session／任意來源網址。
  const SAFE_FORWARD_PARAMS = [
    'store_id', 'line_gate_return',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbclid', 'gclid', 'cart_id', 'order_type',
  ];
  // 切換到外部瀏覽器前記錄的暫存狀態（只存 store_id／gate_stage／建立時間／
  // 已經過安全驗證的 return_url，不存購物車內容本身——購物車由既有
  // ORDER_CART_KEY 機制自然保留，不需要在這裡重複保存）。
  const EXTERNAL_LOGIN_PENDING_KEY = 'line_member_external_login_pending';
  const EXTERNAL_LOGIN_PENDING_MAX_AGE_MS = 15 * 60 * 1000; // 需求文件十二：15 分鐘

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

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix26-I：Facebook／Instagram 內建瀏覽器環境修復
  // ══════════════════════════════════════════════════════════════════

  // 需求文件四：不可只判斷 FBAN，需涵蓋 Facebook 新舊版 UA／Instagram；LINE
  // App 內 LIFF（UA 含 Line/）不可誤判為 Facebook／Instagram WebView；
  // Safari／Chrome 不受影響；偵測失敗一律視為一般瀏覽器（不封鎖）。
  function detectBrowserEnvironment() {
    const ua = (global.navigator && (global.navigator.userAgent || global.navigator.vendor)) || '';
    const isFacebook = /FBAN|FBAV|FB_IAB|Facebook/i.test(ua);
    const isInstagram = /Instagram/i.test(ua);
    const isLine = /Line\//i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isInAppBrowser = !isLine && (isFacebook || isInstagram);
    return {
      ua, isFacebook, isInstagram, isLine, isIOS, isAndroid, isInAppBrowser,
      browser: isFacebook ? 'facebook' : (isInstagram ? 'instagram' : 'other'),
      os: isIOS ? 'ios' : (isAndroid ? 'android' : 'other'),
    };
  }

  // 需求文件十七：只用來標記來源／供 Analytics／顯示更精準提示，絕不單獨用來
  // 阻擋 liff.login()——是否阻擋只看 detectBrowserEnvironment().isInAppBrowser。
  function detectTrafficSource() {
    try {
      const url = new URL(global.location.href);
      const source = String(url.searchParams.get('utm_source') || '').toLowerCase();
      return {
        hasFbclid: url.searchParams.has('fbclid'),
        hasGclid: url.searchParams.has('gclid'),
        utmSource: source,
        isFacebookAds: url.searchParams.has('fbclid') || source === 'facebook' || source === 'fb' || source === 'instagram' || source === 'ig',
      };
    } catch (e) { return { hasFbclid: false, hasGclid: false, utmSource: '', isFacebookAds: false }; }
  }

  // 需求文件十九：沿用既有 onEvent 回呼架構（頁面本來就會把 _trackEvent 當
  // onEvent 傳進 requireMemberBeforeCheckout／requireMemberOnEntry），不另建
  // 第二套追蹤系統。事件本身不含任何敏感資料（Token／完整 UID／地址／電話等）。
  function trackLineEnvironmentEvent(onEvent, eventName, environment, gateStage, storeId) {
    try {
      const traffic = detectTrafficSource();
      const payload = {
        browser: (environment && environment.browser) || 'other',
        os: (environment && environment.os) || 'other',
        gate_stage: gateStage || '',
        traffic_source: traffic.isFacebookAds ? 'facebook_ads' : (traffic.hasGclid ? 'google_ads' : 'other'),
      };
      onEvent && onEvent(eventName, payload);
    } catch (e) { /* Analytics 失敗不可阻擋登入 */ }
  }

  // 需求文件七／九：只能導向 https://liff.line.me/，LIFF ID 必須來自目前商店
  // 已載入的設定（config.liff_id），不可直接把目前完整網址／redirect_uri／
  // 任意第三方 Deep Link 塞進去；只轉傳白名單參數，絕不含 Token。
  function buildLiffOpenUrl(storeId, config, opts) {
    const liffId = String((config && config.liff_id) || '').trim();
    if (!liffId) return '';
    let url;
    try { url = new URL('https://liff.line.me/' + encodeURIComponent(liffId)); }
    catch (e) { return ''; }
    url.searchParams.set('store_id', storeId);
    const gateStage = (opts && (opts.gate_stage || opts.gateStage)) || '';
    if (gateStage) url.searchParams.set('line_gate_return', gateStage);
    try {
      const current = new URL(global.location.href);
      SAFE_FORWARD_PARAMS.forEach((key) => {
        if (current.searchParams.has(key) && !url.searchParams.has(key)) {
          url.searchParams.set(key, current.searchParams.get(key));
        }
      });
    } catch (e) { /* 目前網址解析失敗不影響基本 LIFF URL */ }
    return url.toString();
  }

  // 需求文件十：Android intent 開 Chrome；若失敗回傳 false，呼叫端顯示手動教學，
  // 不自動反覆重試（見需求文件十五）。
  function openInAndroidChrome(url) {
    try {
      const parsed = new URL(url);
      const intentUrl = 'intent://' + parsed.host + parsed.pathname + parsed.search +
        '#Intent;scheme=https;package=com.android.chrome;end';
      global.location.href = intentUrl;
      return true;
    } catch (e) { return false; }
  }

  // 需求文件二十：複製點餐連結只能複製「目前頁面網址」，且先移除任何可能
  // 意外夾帶的敏感參數（id_token/access_token/token/line_uid/session）。
  function getSafeCurrentPageUrl() {
    try {
      const current = new URL(global.location.href);
      current.hash = '';
      ['id_token', 'access_token', 'token', 'line_uid', 'session'].forEach((key) => {
        current.searchParams.delete(key);
      });
      if (current.origin !== global.location.origin) return global.location.origin;
      return current.toString();
    } catch (e) { return global.location.origin; }
  }

  // 需求文件十一：切換到外部瀏覽器（LINE App／Safari／Chrome）前，保存最基本
  // 的返回資訊。不清除、不改名既有購物車 key；購物車／訂單類型／預約時間／
  // 地址／備註／優惠券等狀態本來就已經由既有機制（ORDER_CART_KEY 等）保存在
  // localStorage，這裡只需確保「回到原網址」與「知道要自動重新檢查好友」。
  function persistBeforeExternalLogin(storeId, opts) {
    saveLineMemberReturnUrl(storeId);
    markAwaitingFriendshipReturn();
    try {
      sessionStorage.setItem(EXTERNAL_LOGIN_PENDING_KEY, JSON.stringify({
        store_id: storeId,
        gate_stage: (opts && opts.gate_stage) || '',
        created_at: Date.now(),
        return_url: buildReturnUrl(storeId, opts),
      }));
    } catch (e) { /* 不阻擋顧客操作 */ }
  }

  // 需求文件十二：pending 狀態超過 15 分鐘視為過期，自動清除，避免舊 pending
  // 持續觸發提示。
  function readExternalLoginPending() {
    try {
      const raw = sessionStorage.getItem(EXTERNAL_LOGIN_PENDING_KEY);
      const value = raw ? JSON.parse(raw) : null;
      if (!value || !value.created_at || (Date.now() - Number(value.created_at)) > EXTERNAL_LOGIN_PENDING_MAX_AGE_MS) {
        sessionStorage.removeItem(EXTERNAL_LOGIN_PENDING_KEY);
        return null;
      }
      return value;
    } catch (e) {
      try { sessionStorage.removeItem(EXTERNAL_LOGIN_PENDING_KEY); } catch (e2) {}
      return null;
    }
  }
  function clearExternalLoginPending() {
    try { sessionStorage.removeItem(EXTERNAL_LOGIN_PENDING_KEY); } catch (e) {}
  }

  async function loginWithLine(storeId, opts) {
    if (!isLiffAvailable(storeId)) throw new Error('liff_not_ready');
    if (global.liff.isLoggedIn()) {
      return { redirected: false, alreadyLoggedIn: true, externalBrowserRequired: false };
    }
    // fix18-10-hotfix26-I（需求文件二／五）：Facebook／Instagram 內建瀏覽器
    // 無法沿用 LINE App 登入狀態，直接呼叫 liff.login() 會把顧客導向 LINE 網頁
    // 帳密登入頁，容易誤以為要輸入帳密而流失。這裡改成不呼叫 liff.login()，
    // 回傳 externalBrowserRequired=true，交給呼叫端顯示外部開啟引導。
    const env = detectBrowserEnvironment();
    if (env.isInAppBrowser) {
      const returnUrl = buildReturnUrl(storeId, opts);
      saveLineMemberReturnUrl(storeId);
      return { redirected: false, alreadyLoggedIn: false, externalBrowserRequired: true, environment: env, returnUrl };
    }
    markLoginInProgress();
    global.liff.login({ redirectUri: buildReturnUrl(storeId, opts) });
    return { redirected: true, alreadyLoggedIn: false, externalBrowserRequired: false };
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
    // fix18-10-hotfix26-I（回歸修正）：原本 verifyWithBackend 只檢查
    // global.liff.isLoggedIn()，不要求 isLiffAvailable(storeId) 內部的
    // state[storeId].liffReady 記帳（那個 flag 只在 initLineMemberGate() 跑過
    // 才會設定）。這裡改回只檢查 global.liff 本身是否可用，避免任何原本能正常
    // verify 的呼叫路徑（例如尚未經過完整 initLineMemberGate 流程）被誤擋。
    if (!global.liff || typeof global.liff.isLoggedIn !== 'function') {
      return { ok: false, code: 'LIFF_NOT_AVAILABLE', idToken: null };
    }
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
    if (!global.liff || typeof global.liff.login !== 'function') return { ok: false, code: 'LIFF_NOT_AVAILABLE' };
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

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix26-I（需求文件八～十六）：Facebook／Instagram 內建瀏覽器
  // 外部開啟引導。獨立於 #lineMemberGate（同一時間只會有一個這種引導，見
  // externalGuideVisible），不重用會員登入/好友 Gate 的 overlay，避免關閉時
  // 誤觸發彼此的 resolve。
  // ══════════════════════════════════════════════════════════════════
  let externalGuideEl = null;
  let externalGuideVisible = false;
  let externalLoginActionInProgress = false; // 需求文件十五：跳轉前鎖定一次操作

  function closeExternalBrowserLoginGuide() {
    if (externalGuideEl && externalGuideEl.parentNode) externalGuideEl.parentNode.removeChild(externalGuideEl);
    externalGuideEl = null;
    externalGuideVisible = false;
  }

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix26-F8-B（需求文件三～七）：Messenger →「到 LINE 完成結帳」。
  // 讀取既有 ORDER_CART_KEY（line-order.html 既有購物車 localStorage 機制，見
  // persistCart()），組成後端 /api/line-checkout-handoff/create 需要的
  // cart.items + checkout_context，不重寫購物車邏輯、不新增第二套購物車儲存。
  // 非 line-order.html 頁面（完全沒有這個 key）會安全回傳 null，呼叫端 fallback
  // 到舊有「嘗試使用 LINE 開啟」流程。
  //
  // fix18-10-hotfix29-C（需求文件三／十）：原本「解析出 0 個有效商品」時也會
  // 回傳 null，導致 createLineCheckoutHandoff() 直接在前端猜測是 empty_cart、
  // 完全不呼叫 create API——後台診斷因此永遠看不到真正的 http_status（沒有
  // 送出過請求，本來就不會有），也讓「使用者手機上明明看到購物車有商品，
  // 但 Handoff 卻回報 empty_cart」這種矛盾無法被診斷出來。現在只有「完全沒有
  // ORDER_CART_KEY 這個 key」（代表這個頁面根本沒有購物車機制）才回傳 null；
  // key 存在但商品數為 0，一律照樣送到 create API，讓後端用同一套
  // HANDOFF_EMPTY_CART 分類回應（真正的 http_status + error_code），不再由
  // 前端自己短路猜測。
  function _readStoredCartForHandoff(storeId) {
    try {
      const raw = global.localStorage.getItem('line_order_cart_' + storeId);
      if (!raw) return null; // 這個頁面完全沒有購物車機制，Handoff 不適用
      const data = JSON.parse(raw);
      if (!data || !data.cart || typeof data.cart !== 'object') return null;
      const items = Object.entries(data.cart)
        .map(([pid, qty]) => ({ product_id: Number(pid), qty: Number(qty) }))
        .filter(i => i.product_id && i.qty > 0);
      // 需求文件十：items 可能是空陣列（購物車真的是空的）——不在這裡短路，
      // 讓 create API 用一致的錯誤分類回應，前端才能拿到真正的 http_status。
      let url;
      try { url = new URL(global.location.href); } catch (e) { url = null; }
      const attribution = {
        utm_source: url ? (url.searchParams.get('utm_source') || '') : '',
        utm_medium: url ? (url.searchParams.get('utm_medium') || '') : '',
        utm_campaign: url ? (url.searchParams.get('utm_campaign') || '') : '',
        utm_content: url ? (url.searchParams.get('utm_content') || '') : '',
        fbclid: url ? (url.searchParams.get('fbclid') || '') : '',
        referrer: (global.document && global.document.referrer) || '',
        landing_url: getSafeCurrentPageUrl(),
        source_platform: detectBrowserEnvironment().browser,
      };
      return {
        cart: { items },
        checkout_context: {
          order_type: data.order_mode || '',
          pickup_date: data.pickup_date || '',
          pickup_time: data.pickup_time || '',
          delivery_address: (data.customer && data.customer.delivery_address) || '',
          delivery_note: (data.customer && data.customer.delivery_address_note) || '',
          payment_method: data.payment_method || '',
          coupon_code: data.coupon_code || '',
          customer_phone: (data.customer && data.customer.phone) || '',
        },
        attribution,
        // 需求文件三：安全前端診斷欄位（不含完整商品明細／電話／地址／token）。
        _diag: {
          cart_item_count: items.length,
          has_store_id: !!storeId,
          has_valid_product_id: items.every((i) => Number.isFinite(i.product_id) && i.product_id > 0),
          has_positive_quantity: items.every((i) => Number.isFinite(i.qty) && i.qty > 0),
        },
      };
    } catch (e) { return null; }
  }

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix29-B（需求文件三～八）：Handoff 診斷 × Response Normalize
  // × Timeout × 有限重試。目標——精確區分 iPhone 13 Pro／17 在 Messenger
  // WebView 到底卡在哪個階段失敗，不再只有籠統的「無法準備 LINE 結帳」。
  // ══════════════════════════════════════════════════════════════════

  // 需求文件五：正式環境預設關閉逐階段 verbose console log，只在明確開啟時
  // 輸出（由呼叫端依 config.line_handoff_debug 設定）。錯誤摘要本身已經過
  // 遮罩，不受這個開關限制。
  let _handoffDebugEnabled = false;
  function setHandoffDebugEnabled(v) { _handoffDebugEnabled = !!v; }

  function _handoffLog(stage, extra) {
    try {
      if (!_handoffDebugEnabled) return;
      console.info('[LINE_HANDOFF]', Object.assign({ stage }, extra || {}));
    } catch (e) { /* log 失敗不得影響流程 */ }
  }

  // 需求文件六：後端目前一律回傳 snake_case（見 routes/line-checkout-handoff.js），
  // 但前端不假設永遠如此——未來欄位命名調整、或新舊後端並存時仍要能解析，
  // 兩種命名都接受，缺欄位時明確回傳 null（不是 undefined，方便判斷）。
  function normalizeHandoffResponse(raw) {
    const r = raw || {};
    return {
      ok: r.ok === true,
      cartCode: r.cart_code || r.cartCode || null,
      // fix18-10-hotfix30（需求文件五）：Direct LIFF Checkout URL——新的主要
      // 導流網址，缺 LIFF ID 設定時後端回 null，前端 fallback 回 lineOaMessageUrl。
      directLiffUrl: r.direct_liff_url || r.directLiffUrl || null,
      lineOaMessageUrl: r.line_oa_message_url || r.lineOaMessageUrl || null,
      lineOaConfigured: !!(r.line_oa_configured !== undefined ? r.line_oa_configured : r.lineOaConfigured),
      // fix18-10-hotfix29-C（需求文件九）：add_friend_url 一併 normalize，讓
      // create API 的回應成為前端唯一的、最新鮮的 add_friend_url 來源。
      addFriendUrl: r.add_friend_url || r.addFriendUrl || null,
      expiresAt: r.expires_at || r.expiresAt || null,
      errorCode: r.error_code || r.errorCode || null,
      message: r.message || null,
    };
  }

  // 需求文件七：不讓 Messenger WebView 無限 pending。AbortController 在極舊
  // WebView 若不存在，安全退化成「不加 timeout」，不拋例外中斷流程。
  async function fetchWithTimeout(url, options, timeoutMs) {
    const ms = timeoutMs || 8000;
    if (typeof global.AbortController !== 'function') {
      return global.fetch(url, options);
    }
    const controller = new global.AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await global.fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // 需求文件八：只有這幾類錯誤可自動重試，最多重試一次（共兩次嘗試）。
  // store setting missing／Basic ID missing／invalid cart／empty cart／
  // HTTP 400／401／403 都不重試（重試也不會成功，只會拖長等待）。
  // 需求文件八：只有暫時性錯誤可重試——網路/timeout/5xx／DB 暫時失敗／內部
  // 錯誤都可能只是瞬時問題；購物車資料本身有問題（empty/invalid/缺商品ID/
  // 數量不合法）或 store 設定問題重試也不會變好，不重試。
  const HANDOFF_RETRYABLE_CODES = {
    HANDOFF_TIMEOUT: 1, HANDOFF_NETWORK: 1, HANDOFF_HTTP_5XX: 1, HANDOFF_INVALID_JSON: 1,
    HANDOFF_CREATE_DB_FAILED: 1, HANDOFF_CREATE_INTERNAL_ERROR: 1,
  };
  // 需求文件八／十一：獨立成小函式方便 smoke test 直接驗證分類規則，不用
  // 每次都跑一整輪 fetch mock。
  function shouldRetryHandoff(errorCode) { return !!HANDOFF_RETRYABLE_CODES[errorCode]; }

  // 需求文件十五：使用者可截圖回報的簡短代碼，不顯示技術堆疊。
  const HANDOFF_ERROR_DISPLAY_MAP = {
    HANDOFF_TIMEOUT: 'HOF-TIMEOUT',
    HANDOFF_NETWORK: 'HOF-NETWORK',
    HANDOFF_HTTP_4XX: 'HOF-HTTP-4XX',
    HANDOFF_HTTP_5XX: 'HOF-HTTP-5XX',
    HANDOFF_INVALID_JSON: 'HOF-INVALID-JSON',
    HANDOFF_MISSING_CART_CODE: 'HOF-MISSING-CODE',
    HANDOFF_MISSING_LINE_URL: 'HOF-MISSING-URL',
    HANDOFF_UI_APPLY_FAILED: 'HOF-UI',
    // fix18-10-hotfix29-C（需求文件五）：後端 create API 明確錯誤分類，對應
    // 顯示碼，讓顧客回報的不再只是「HOF-UNKNOWN」。
    HANDOFF_EMPTY_CART: 'HOF-EMPTY-CART',
    HANDOFF_INVALID_CART: 'HOF-INVALID-CART',
    HANDOFF_PRODUCT_ID_MISSING: 'HOF-BAD-PRODUCT',
    HANDOFF_QUANTITY_INVALID: 'HOF-BAD-QTY',
    HANDOFF_STORE_ID_MISSING: 'HOF-NO-STORE',
    HANDOFF_STORE_NOT_FOUND: 'HOF-STORE-404',
    HANDOFF_BASIC_ID_MISSING: 'HOF-NO-BASIC-ID',
    HANDOFF_ADD_FRIEND_URL_MISSING: 'HOF-NO-ADD-FRIEND',
    HANDOFF_CREATE_DB_FAILED: 'HOF-DB',
    HANDOFF_CREATE_INTERNAL_ERROR: 'HOF-INTERNAL',
    // fix18-10-hotfix30（需求文件四）：LIFF ID 未設定（不是失敗，只是無法
    // 建立 Direct LIFF URL，仍會 fallback 到 OA／Cart Code，但錯誤碼顯示需要獨立代碼）。
    HANDOFF_LIFF_ID_MISSING: 'HOF-NO-LIFF-ID',
  };
  function handoffErrorCodeToDisplay(code) { return HANDOFF_ERROR_DISPLAY_MAP[code] || 'HOF-UNKNOWN'; }

  function classifyHandoffDeviceBrowser(environment) {
    const device = environment.isIOS ? 'iphone' : (environment.isAndroid ? 'android' : 'other');
    const browser = environment.isLine ? 'line_liff'
      : (environment.isFacebook ? 'messenger_webview' : (environment.isInstagram ? 'instagram_webview' : 'other'));
    return { device, browser };
  }

  // 需求文件五：回報安全診斷摘要給後端（fire-and-forget，絕不 await、絕不
  // 因為失敗而擋住結帳主流程；payload 只放白名單欄位，見後端
  // routes/line-checkout-handoff.js 的 /diagnostics 端點）。
  function reportHandoffDiagnostics(storeId, fields) {
    try {
      if (!global.fetch) return;
      const p = global.fetch(`/api/line-checkout-handoff/diagnostics?store_id=${encodeURIComponent(storeId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields || {}),
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 診斷回報失敗不得影響結帳主流程 */ }
  }

  // 需求文件五～八：呼叫後端建立 cart token。內建 timeout／錯誤分類／有限
  // 重試／診斷回報，回傳值一律經過 normalizeHandoffResponse()，並附上
  // errorCode 讓呼叫端能顯示需求文件十五的 HOF-* 代碼。
  async function createLineCheckoutHandoff(storeId, diagCtx) {
    const ctx = diagCtx || { device: 'other', browser: 'other' };

    const payload = _readStoredCartForHandoff(storeId);
    if (!payload) {
      // 需求文件三：這個頁面完全沒有 ORDER_CART_KEY（沒有購物車機制），Handoff
      // 真的不適用，不送出任何請求——但仍回報一次診斷（帶真正的錯誤碼，不再是
      // null），避免後台完全看不到發生過什麼（fix18-10-hotfix29-C 根因修正）。
      reportHandoffDiagnostics(storeId, {
        device: ctx.device, browser: ctx.browser,
        stage: 'request_started', attempt: 1, error_code: 'HANDOFF_EMPTY_CART',
        has_cart_code: false, has_line_oa_message_url: false, fallback_reason: 'no_cart_storage_key',
        response_ok: false, ui_cart_count: 0, payload_cart_count: 0,
        has_add_friend_url: !!ctx.hasAddFriendUrl,
      });
      return { ok: false, reason: 'empty_cart', errorCode: 'HANDOFF_EMPTY_CART', httpStatus: null, uiCartCount: 0, payloadCartCount: 0 };
    }

    // 需求文件十：這個專案的購物車只有一份權威來源——line-order.html／
    // line-shipping.html 的 in-memory cart 物件在每次變動時同步 persistCart()
    // 寫入 localStorage（見 public/line-order.html persistCart()），
    // _readStoredCartForHandoff() 讀的正是同一份資料，因此「畫面顯示的購物車
    // 件數」與「送進 create API 的件數」在這個架構下永遠是同一個數字，不存在
    // 兩個分岔來源。這裡誠實回報同一個數字給 ui_cart_count／payload_cart_count
    // （不偽造一個不會發生的「不一致」），HANDOFF_CART_SNAPSHOT_MISMATCH 這個
    // 錯誤碼已加入白名單，保留給未來若真的出現第二個購物車來源時使用。
    const diagCartCount = (payload._diag && payload._diag.cart_item_count) || 0;
    // 需求文件三：只送 create API 需要的欄位，_diag 是純前端安全診斷用途，
    // 不隨 payload 送出（不送完整商品明細以外的東西，也不重複塞進 request body）。
    const requestPayload = { cart: payload.cart, checkout_context: payload.checkout_context, attribution: payload.attribution };

    const report = (fields) => reportHandoffDiagnostics(storeId, Object.assign({
      device: ctx.device, browser: ctx.browser,
      ui_cart_count: diagCartCount, payload_cart_count: diagCartCount,
      has_add_friend_url: !!ctx.hasAddFriendUrl,
    }, fields));

    let lastResult = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        _handoffLog('retry_started', { attempt });
        report({ stage: 'retry_started', attempt });
        await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 300))); // 需求文件八：500~800ms
      }
      _handoffLog('request_started', { attempt });
      report({ stage: 'request_started', attempt });

      let resp = null;
      let httpStatus = null;
      try {
        resp = await fetchWithTimeout(`/api/line-checkout-handoff/create?store_id=${encodeURIComponent(storeId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload),
        }, 8000);
        httpStatus = resp.status;
      } catch (e) {
        // 需求文件二／三：這個 catch 分支代表 fetch 真的沒有拿到任何 HTTP
        // response（timeout 被 AbortController 中止，或連線層網路錯誤）——
        // 這是「HTTP status 為 - 」唯一合理、誠實的情況（可能①②），一定要
        // 明確標記 response_ok:false，不能讓這筆記錄的其他欄位看起來像是
        // 「正常收到回應但缺欄位」（那才是可能③：reportDiagnostics 沒帶好）。
        const errorCode = (e && e.name === 'AbortError') ? 'HANDOFF_TIMEOUT' : 'HANDOFF_NETWORK';
        _handoffLog('request_completed', { attempt, error_code: errorCode });
        report({ stage: 'request_completed', attempt, error_code: errorCode, http_status: null, response_ok: false, has_cart_code: false, has_line_oa_message_url: false });
        lastResult = { ok: false, reason: errorCode === 'HANDOFF_TIMEOUT' ? 'timeout' : 'network_error', errorCode, httpStatus: null, uiCartCount: diagCartCount, payloadCartCount: diagCartCount };
        if (shouldRetryHandoff(errorCode) && attempt < 2) continue;
        break;
      }

      // 需求文件二：這裡代表 fetch 真的送出去、也真的收到 HTTP response 了
      // （排除了①②）——response_received 階段，httpStatus 從此以後在這次
      // attempt 的每一筆 report() 都會帶著，不會再變成 null／"-"。
      _handoffLog('request_completed', { attempt, http_status: httpStatus });
      report({ stage: 'request_completed', attempt, http_status: httpStatus, response_ok: resp.ok });

      // 需求文件九：不論 HTTP 狀態碼是否為 2xx，後端一律回 JSON body（含
      // error_code／message，見 routes/line-checkout-handoff.js），一律先嘗試
      // 解析，不再只憑 http status 猜錯誤碼。
      let raw = null;
      let parseFailed = false;
      try { raw = await resp.json(); } catch (e) { parseFailed = true; }

      if (parseFailed) {
        _handoffLog('response_parsed', { attempt, error_code: 'HANDOFF_INVALID_JSON' });
        report({ stage: 'response_parsed', attempt, http_status: httpStatus, response_ok: false, error_code: 'HANDOFF_INVALID_JSON', has_cart_code: false, has_line_oa_message_url: false });
        lastResult = { ok: false, reason: 'invalid_json', errorCode: 'HANDOFF_INVALID_JSON', httpStatus, uiCartCount: diagCartCount, payloadCartCount: diagCartCount };
        if (attempt < 2) continue;
        break;
      }

      const normalized = normalizeHandoffResponse(raw);
      _handoffLog('response_parsed', { attempt, has_cart_code: !!normalized.cartCode });
      // 需求文件二：response_parsed 階段本身也上報一次（之前只有 console log，
      // 從未送到後端），確保五個階段 request_started／request_completed
      // （＝request_sent+response_received）／response_parsed／response_validated
      // 在後台都能看到，不再「中間憑空消失」。
      report({ stage: 'response_parsed', attempt, http_status: httpStatus, response_ok: resp.ok, has_cart_code: !!normalized.cartCode, has_line_oa_message_url: !!normalized.lineOaMessageUrl, has_direct_liff_url: !!normalized.directLiffUrl });

      if (!resp.ok || !normalized.ok) {
        // 需求文件九：優先用後端明確給的 error_code（例如 HANDOFF_EMPTY_CART／
        // HANDOFF_INVALID_CART），只有後端真的沒給時才退回用 HTTP 狀態碼粗略
        // 分類——這是本版修正「後台永遠只看到 HOF-UNKNOWN／全部空白」的根因。
        const errorCode = normalized.errorCode || (httpStatus >= 500 ? 'HANDOFF_HTTP_5XX' : 'HANDOFF_HTTP_4XX');
        report({ stage: 'response_validated', attempt, http_status: httpStatus, response_ok: false, error_code: errorCode, has_cart_code: false, has_line_oa_message_url: false, fallback_reason: normalized.message ? 'server_message' : null });
        lastResult = { ok: false, reason: normalized.message || 'create_failed', errorCode, httpStatus, uiCartCount: diagCartCount, payloadCartCount: diagCartCount };
        if (shouldRetryHandoff(errorCode) && attempt < 2) continue;
        break;
      }
      if (!normalized.cartCode) {
        report({ stage: 'response_validated', attempt, http_status: httpStatus, response_ok: true, error_code: 'HANDOFF_MISSING_CART_CODE', has_cart_code: false, has_line_oa_message_url: !!normalized.lineOaMessageUrl });
        lastResult = { ok: false, reason: 'missing_cart_code', errorCode: 'HANDOFF_MISSING_CART_CODE', httpStatus, uiCartCount: diagCartCount, payloadCartCount: diagCartCount };
        break;
      }

      report({ stage: 'response_validated', attempt, http_status: httpStatus, response_ok: true, has_cart_code: true, has_line_oa_message_url: !!normalized.lineOaMessageUrl, has_direct_liff_url: !!normalized.directLiffUrl });
      // fix18-10-hotfix30（需求文件十二）：direct_liff_url_created——只回報
      // 「有沒有值」，不把完整網址（含 cart_token）送進診斷 log。
      report({ stage: 'direct_liff_url_created', attempt, http_status: httpStatus, response_ok: true, has_cart_code: true, has_direct_liff_url: !!normalized.directLiffUrl });
      // 需求文件九：addFriendUrl 一併帶回——這是後端用同一套 resolveAddFriendUrl()
      // 解析出來的正式值，取代前端舊有只讀 config.add_friend_url（可能來自
      // 另一個舊欄位）的做法，修正「後台明明有設定，畫面卻顯示未設定」。
      return {
        ok: true,
        cartCode: normalized.cartCode,
        directLiffUrl: normalized.directLiffUrl,
        lineOaMessageUrl: normalized.lineOaMessageUrl,
        lineOaConfigured: normalized.lineOaConfigured,
        addFriendUrl: normalized.addFriendUrl,
        httpStatus, uiCartCount: diagCartCount, payloadCartCount: diagCartCount,
      };
    }

    return lastResult || { ok: false, reason: 'create_failed', errorCode: 'HANDOFF_UNKNOWN', httpStatus: null, uiCartCount: diagCartCount, payloadCartCount: diagCartCount };
  }

  async function copyToClipboard(text) {
    try {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        await global.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    return false;
  }


  function showExternalBrowserLoginGuide(config, options) {
    const storeId = options && options.storeId;
    const gateStage = (options && options.gateStage) || '';
    const environment = (options && options.environment) || detectBrowserEnvironment();
    const onEvent = options && options.onEvent;

    // 需求文件十五：同一時間只能存在一個外部登入引導。
    if (externalGuideVisible) return externalGuideEl;
    closeExternalBrowserLoginGuide();

    trackLineEnvironmentEvent(onEvent, 'line_login_inapp_browser_detected', environment, gateStage, storeId);

    externalGuideEl = document.createElement('div');
    externalGuideEl.id = 'lineMemberExternalGuide';
    externalGuideEl.style.cssText = `position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);
      display:flex;align-items:center;justify-content:center;padding:16px;`;

    // 需求文件十：iOS／Android 用字不同，不可宣稱「已自動開啟 Safari」。
    // fix18-10-hotfix26-F2：iOS 文案改用需求文件指定字樣「如何使用 Safari 開啟」
    // （原為「如何用 Safari 開啟」，純文字對齊，行為不變）；Android 維持原字樣不動。
    const osHintLabel = environment.isIOS ? '如何使用 Safari 開啟'
      : (environment.isAndroid ? '使用 Chrome 開啟' : '如何用瀏覽器開啟');

    // fix18-10-hotfix27（需求文件九）：文案改版——強調「購物車已保留，不需要
    // 重新選購」，不再出現「商家尚未設定官方帳號…」這種曝露內部設定狀態的
    // 字樣（改成引導動作：加入官方 LINE＋貼結帳代碼）。
    // fix18-10-hotfix30（需求文件六）：iPhone＋Messenger 不再有特殊分支——
    // Direct LIFF URL 統一是唯一主按鈕，不需要再依裝置判斷排序（原
    // isIphoneMessenger 分支已隨 Hotfix29-C 的雙主按鈕設計一起移除）。

    const headingText = 'LINE 完成結帳';
    const introHtml = `目前使用 Facebook／Messenger 內建瀏覽器。<br><br>請到 LINE 繼續完成結帳。<br><br>您的購物車已保留，不需要重新選購。`;

    // 需求文件四：Chrome／Safari 收合在「其他登入方式 ▼」內，用原生 <details>
    // 實作（不需額外 JS 控制展開/收合狀態，預設收合＝沒有 open 屬性）。這個
    // 收合區塊是既有「登入方式」選項，與本次要拆掉的「無法開啟 LINE？」
    // 結帳 fallback 是不同東西，不受本次需求文件三影響。
    const otherLoginInnerHtml = environment.isIOS
      ? `<button id="lmgChromeBtn" style="width:100%;padding:12px;border:0;border-radius:10px;background:#06C755;color:#fff;font-size:15px;font-weight:600;margin-bottom:8px;cursor:pointer">使用 Chrome 開啟</button>
         <div style="font-size:12px;color:#888;text-align:center;margin-bottom:6px">若 Chrome 仍無法完成登入，請使用 Safari。</div>
         <button id="lmgSafariBtn" style="width:100%;padding:12px;border:1px solid #06C755;border-radius:10px;background:#fff;color:#06C755;font-size:14px;font-weight:600;cursor:pointer">如何使用 Safari 開啟</button>`
      : `<button id="lmgOpenLineBtn" style="width:100%;padding:12px;border:0;border-radius:10px;background:#06C755;color:#fff;font-size:15px;font-weight:600;margin-bottom:8px;cursor:pointer">嘗試使用 LINE 開啟</button>
         <button id="lmgOsHintBtn" style="width:100%;padding:12px;border:1px solid #06C755;border-radius:10px;background:#fff;color:#06C755;font-size:14px;font-weight:600;cursor:pointer">${escapeHtml(osHintLabel)}</button>`;

    // 需求文件七／十二：Icon 靠左、文字靠右，56px 高、12px 圓角、32px icon、
    // 100% 寬——所有按鈕統一用這個 helper 產生，不再各寫各的樣式。
    function iconButtonHtml(id, tag, icon, text, opts) {
      const o = opts || {};
      const bg = o.bg || '#fff';
      const color = o.color || '#111';
      const border = o.border || '1px solid #ddd';
      const fontWeight = o.fontWeight || '600';
      const extraAttrs = o.extraAttrs || '';
      return `<${tag} id="${id}" ${tag === 'a' ? 'href="#" rel="noopener noreferrer"' : ''} ${extraAttrs}
        style="display:flex;align-items:center;gap:12px;width:100%;height:56px;padding:0 18px;border-radius:12px;border:${border};background:${bg};color:${color};font-size:16px;font-weight:${fontWeight};text-decoration:none;cursor:pointer;box-sizing:border-box;text-align:left">
        <span style="font-size:28px;line-height:1;flex-shrink:0;width:32px;text-align:center">${icon}</span>
        <span style="flex:1">${text}</span>
      </${tag}>`;
    }

    // fix18-10-hotfix30（需求文件四／六）：「立即開啟 LINE 官方帳號」（加好友
    // 連結）／「使用聊天室完成結帳」（舊 oaMessage Cart Code 連結）／「複製
    // 結帳代碼」全部降為 fallback，收在「無法開啟 LINE？」收合區塊內；不再是
    // iPhone+Messenger 時搶主要視覺的按鈕（本版根因：Direct LIFF URL 是 LINE
    // 官方註冊的 universal link，成功率取代了過去用 OA 加好友連結墊檔的做法）。
    const openOaHtml = iconButtonHtml('lmgOpenOaBtn', 'a', '<span style="color:#06C755;font-weight:900">L</span>', '開啟 LINE 官方帳號', { bg: '#fff', color: '#06C755', border: '1px solid #06C755', fontWeight: '600' });
    // 需求文件七：主要按鈕必須是真實 <a href>，不可用 button+async navigation
    // （async 之後會失去使用者手勢資格）。ready 前 disabled，ready 後才寫入 href。
    const goCheckoutHtml = `<a id="lmgGoLineCheckoutBtn" href="#" rel="noopener noreferrer" aria-disabled="true"
        style="display:flex;align-items:center;gap:12px;width:100%;height:56px;padding:0 18px;border-radius:12px;border:0;background:#06C755;color:#fff;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer;box-sizing:border-box;text-align:left;opacity:.55;pointer-events:none">
        <span style="font-size:28px;line-height:1;flex-shrink:0;width:32px;text-align:center">💬</span>
        <span id="lmgGoLineCheckoutBtnText" style="flex:1">到 LINE 完成結帳</span>
      </a>`;
    // 需求文件十三：舊聊天室 Cart Code 流程（「我要結帳 CART-XXXXXX」）仍保留，
    // 只是降為 fallback——href 指向既有 lineOaMessageUrl（oaMessage 深連結）。
    const goChatroomHtml = iconButtonHtml('lmgGoChatroomBtn', 'a', '💬', '使用聊天室完成結帳', {});
    const copyCodeHtml = iconButtonHtml('lmgCopyCartCodeBtn', 'button', '📋', '複製結帳代碼', {});
    const externalBrowserLabel = environment.isIOS ? '在 Safari 開啟' : '在外部瀏覽器開啟';
    const externalBrowserHtml = iconButtonHtml('lmgExternalBrowserBtn', 'button', '🌐', externalBrowserLabel, {});

    // 需求文件六：主要按鈕永遠只有「到 LINE 完成結帳」一個，不再讓顧客在
    // 兩顆綠色按鈕之間猜該按哪一個。
    const primaryButtonsHtml = `<div style="display:flex;flex-direction:column;gap:16px;margin-bottom:14px">${goCheckoutHtml}</div>`;

    // 需求文件六／十三：Cart Code 不再放在主要視覺中央，改收進「無法開啟
    // LINE？」收合區塊——一般顧客用 Direct LIFF 全程不需要看到／輸入代碼，
    // 只有真的要走舊聊天室流程時才會看到自己的代碼。
    const cartCodeBlockHtml = `
      <div id="lmgCartCodeBlock" style="display:none;text-align:center;border:1px dashed #06C755;border-radius:10px;padding:12px;margin:12px 0;background:#f4fdf8">
        <div style="font-size:12px;color:#888;margin-bottom:4px">您的結帳代碼</div>
        <div id="lmgCartCodeText" style="font-size:20px;font-weight:700;letter-spacing:1px;color:#06C755;font-family:monospace"></div>
      </div>`;

    // 需求文件六／十三：「無法開啟 LINE？」——預設收合（<details> 沒有 open
    // 屬性），展開後才看到官方帳號／複製代碼／聊天室三個 fallback 選項。
    const fallbackSectionHtml = `
      <details id="lmgCantOpenSection" style="margin-top:6px">
        <summary style="cursor:pointer;color:#991b1b;font-weight:700;font-size:14px;padding:8px 0;list-style:none;text-align:center">⚠️ 無法開啟 LINE？</summary>
        <div style="margin-top:10px">
          <div style="text-align:center;font-size:13px;color:#666;margin-bottom:12px">請直接使用下面的方法完成結帳</div>
          ${cartCodeBlockHtml}
          <div style="display:flex;flex-direction:column;gap:16px">
            ${openOaHtml}
            ${goChatroomHtml}
            ${copyCodeHtml}
            ${externalBrowserHtml}
          </div>
        </div>
      </details>`;

    externalGuideEl.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:380px;width:100%;padding:24px;text-align:left;font-family:inherit;max-height:90vh;overflow-y:auto">
        <div style="font-size:40px;line-height:1;margin-bottom:8px;text-align:center">📲</div>
        <h3 id="lmgGuideHeading" style="margin:0 0 8px;font-size:18px;text-align:center">${escapeHtml(headingText)}</h3>
        <p id="lmgGuideIntro" style="margin:0 0 12px;color:#666;font-size:14px;line-height:1.6">${introHtml}</p>
        <div id="lmgExternalStatus" style="font-size:13px;color:#888;margin-bottom:10px;text-align:center"></div>
        <div id="lmgHandoffErrorCode" style="display:none;text-align:center;font-size:12px;color:#991b1b;margin-bottom:10px;font-family:monospace"></div>
        ${primaryButtonsHtml}
        ${fallbackSectionHtml}
        <button id="lmgRegenerateTokenBtn" style="display:none;width:100%;padding:12px;border:1px solid #06C755;border-radius:10px;background:#fff;color:#06C755;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px">🔁 重新產生結帳代碼</button>
        <button id="lmgExternalBackBtn" style="width:100%;padding:10px;border:0;background:transparent;color:#999;font-size:13px;cursor:pointer;text-align:center;margin-top:10px">返回購物車</button>
        <details id="lmgOtherLoginDetails" style="margin-top:8px">
          <summary style="cursor:pointer;color:#666;font-size:13px;padding:6px 0;list-style:none;text-align:center">其他登入方式 ▾</summary>
          <div style="margin-top:10px">${otherLoginInnerHtml}</div>
        </details>
      </div>`;
    document.body.appendChild(externalGuideEl);
    externalGuideVisible = true;
    trackLineEnvironmentEvent(onEvent, 'line_login_external_guide_shown', environment, gateStage, storeId);

    const setExternalStatus = (text, showRetry) => {
      const el = document.getElementById('lmgExternalStatus');
      if (!el) return;
      el.innerHTML = text ? String(text).replace(/</g, '&lt;') : '';
      if (showRetry) {
        el.innerHTML += ' <a href="#" id="lmgRetryOpenLine" style="color:#06C755;text-decoration:underline">再次使用 LINE 開啟</a>';
        const retryLink = document.getElementById('lmgRetryOpenLine');
        if (retryLink) {
          retryLink.addEventListener('click', (ev) => {
            ev.preventDefault();
            trackLineEnvironmentEvent(onEvent, 'line_login_external_retry_clicked', environment, gateStage, storeId);
            attemptOpenLine();
          });
        }
      }
    };

    // 需求文件九／十六：每次點擊都重新產生一個乾淨的 LIFF URL，只由使用者
    // 主動點擊觸發，不定時自動重試，不重複保存 Token（這裡完全不碰 Token）。
    async function attemptOpenLine() {
      if (externalLoginActionInProgress) return;
      externalLoginActionInProgress = true;
      try {
        const liffOpenUrl = buildLiffOpenUrl(storeId, config, { gate_stage: gateStage });
        if (!liffOpenUrl) {
          setExternalStatus('目前無法開啟 LINE，請改用瀏覽器開啟或複製連結。', false);
          return;
        }
        trackLineEnvironmentEvent(onEvent, 'line_login_open_line_clicked', environment, gateStage, storeId);
        persistBeforeExternalLogin(storeId, { gate_stage: gateStage });
        setExternalStatus('正在為您開啟 LINE…', false);
        global.location.href = liffOpenUrl;
      } finally {
        // 若真的跳轉離開頁面，這行不會有機會執行；留著是為了「LIFF URL 建置
        // 失敗」這種沒有真的跳轉的情況，讓使用者還能再按一次（需求文件十六）。
        // fix18-10-hotfix26-F2（需求文件一）：iOS 上 Messenger/Instagram WebView
        // 本來就有官方限制，重試「嘗試使用 LINE 開啟」大機率仍會失敗——與其讓使用者
        // 一直重試同一個註定失敗的動作，改直接引導改用 Safari（不提供重試連結）；
        // Android（Chrome 能正常自動登入）維持原本「再次使用 LINE 開啟」重試行為不變。
        setTimeout(() => {
          externalLoginActionInProgress = false;
          if (environment.isIOS) {
            setExternalStatus('目前瀏覽器限制，請改用 Safari 再登入。', false);
          } else {
            setExternalStatus('LINE 沒有成功開啟嗎？', true);
          }
        }, 1500);
      }
    }

    // fix18-10-hotfix26-F3（Fix-2）：iOS 版「使用 Chrome 開啟」——與 Android 版
    // openInAndroidChrome() 同樣手法（保留完整 host/path/search，即 Fix-3 要求的
    // 所有 Query String 都要保留），只是改用 iOS Chrome 官方文件記載的
    // googlechromes:// scheme（https 對應 googlechromes://，http 對應
    // googlechrome://），不是「奇怪的自創 scheme」。無法偵測是否真的喚起 Chrome
    // （iOS 瀏覽器本來就無法偵測），因此一律同時顯示「若沒有反應」的說明，
    // 不宣稱一定成功。
    function openInIOSChrome(url) {
      try {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const chromeScheme = isHttps ? 'googlechromes://' : 'googlechrome://';
        const chromeUrl = chromeScheme + parsed.host + parsed.pathname + parsed.search;
        global.location.href = chromeUrl;
        return true;
      } catch (e) { return false; }
    }

    const openLineBtn = externalGuideEl.querySelector('#lmgOpenLineBtn');
    const osHintBtn = externalGuideEl.querySelector('#lmgOsHintBtn');
    const chromeBtn = externalGuideEl.querySelector('#lmgChromeBtn');
    const safariBtn = externalGuideEl.querySelector('#lmgSafariBtn');
    const backBtn = externalGuideEl.querySelector('#lmgExternalBackBtn');
    const goLineCheckoutBtn = externalGuideEl.querySelector('#lmgGoLineCheckoutBtn');
    // fix18-10-hotfix30（需求文件十三）：舊聊天室 Cart Code fallback 按鈕。
    const goChatroomBtn = externalGuideEl.querySelector('#lmgGoChatroomBtn');
    const cartCodeBlock = externalGuideEl.querySelector('#lmgCartCodeBlock');
    const cartCodeText = externalGuideEl.querySelector('#lmgCartCodeText');
    const headingEl = externalGuideEl.querySelector('#lmgGuideHeading');
    const introEl = externalGuideEl.querySelector('#lmgGuideIntro');

    function showCartCode(code) {
      if (!cartCodeBlock || !cartCodeText || !code) return;
      cartCodeText.textContent = code;
      cartCodeBlock.style.display = 'block';
      const copyCodeBtn = externalGuideEl.querySelector('#lmgCopyCartCodeBtn');
      if (copyCodeBtn && !copyCodeBtn._wired) {
        copyCodeBtn._wired = true; // 需求文件九：只綁一次，重新產生代碼時沿用同一個 handler，不重複綁定
        copyCodeBtn.addEventListener('click', async () => {
          if (copyCodeBtn.disabled) return;
          const codeNow = currentHandoff && currentHandoff.cartCode ? currentHandoff.cartCode : code;
          const copied = await copyToClipboard(codeNow);
          setExternalStatus(copied ? `已複製結帳代碼：${escapeHtml(codeNow)}` : `請手動複製：${escapeHtml(codeNow)}`, false);
        });
      }
    }

    // 需求文件四：failed／preparing 狀態不得顯示舊／過期的 Cart Code。
    function hideCartCode() {
      if (cartCodeBlock) cartCodeBlock.style.display = 'none';
      if (cartCodeText) cartCodeText.textContent = '';
    }

    // fix18-10-hotfix30（需求文件六／九）：「無法開啟 LINE？」預設收合，但在
    // 真正需要 fallback 的情境（Direct LIFF／OA 都不可用、或已進入 failed
    // 狀態）要自動展開，不能讓顧客多點一次才看到唯一能用的操作。
    function expandCantOpenSection() {
      const section = externalGuideEl.querySelector('#lmgCantOpenSection');
      if (section) section.open = true;
    }

    // 需求文件五：接上 #lmgHandoffErrorCode——只顯示 HOF-* 短碼，不顯示技術堆疊。
    function showHandoffErrorCode(errorCode) {
      const codeEl = externalGuideEl.querySelector('#lmgHandoffErrorCode');
      if (!codeEl) return;
      if (!errorCode) {
        codeEl.hidden = true;
        codeEl.style.display = 'none';
        codeEl.textContent = '';
        return;
      }
      codeEl.hidden = false;
      codeEl.style.display = 'block';
      codeEl.textContent = `錯誤代碼：${handoffErrorCodeToDisplay(errorCode)}`;
    }

    function setCopyButtonEnabled(enabled) {
      const copyCodeBtn = externalGuideEl.querySelector('#lmgCopyCartCodeBtn');
      if (!copyCodeBtn) return;
      copyCodeBtn.disabled = !enabled;
      copyCodeBtn.style.opacity = enabled ? '' : '.55';
      copyCodeBtn.style.pointerEvents = enabled ? '' : 'none';
    }

    function disableGoLineCheckoutBtn() {
      if (!goLineCheckoutBtn) return;
      goLineCheckoutBtn.href = '#';
      goLineCheckoutBtn.setAttribute('aria-disabled', 'true');
      goLineCheckoutBtn.style.opacity = '.55';
      goLineCheckoutBtn.style.pointerEvents = 'none';
    }
    function enableGoLineCheckoutBtn(href) {
      if (!goLineCheckoutBtn) return;
      const textEl = externalGuideEl.querySelector('#lmgGoLineCheckoutBtnText');
      if (textEl) textEl.textContent = '到 LINE 完成結帳';
      goLineCheckoutBtn.href = href;
      goLineCheckoutBtn.removeAttribute('aria-disabled');
      goLineCheckoutBtn.style.opacity = '';
      goLineCheckoutBtn.style.pointerEvents = '';
    }

    // 需求文件九／十：店家尚未完成一鍵結帳設定（result.ok===true 但沒有
    // line_oa_configured）時，整個 Dialog 換一套文案／主按鈕；只有這種情境
    // 或真正的 failed 狀態才會呼叫這個函式。需求文件三：ready 狀態不得被
    // 覆蓋——一旦已經 ready，這個函式直接是 no-op。
    function switchToAddFriendFallback(cartCode) {
      if (handoffState === 'ready') return;
      if (headingEl) headingEl.textContent = '請加入官方 LINE 完成結帳';
      if (introEl) {
        introEl.innerHTML = '目前商家尚未完成 LINE 一鍵結帳設定。<br><br>請加入官方 LINE，並將下方結帳代碼貼到聊天室即可繼續完成結帳。';
      }
      if (goLineCheckoutBtn) {
        const goLineCheckoutBtnText = externalGuideEl.querySelector('#lmgGoLineCheckoutBtnText');
        if (goLineCheckoutBtnText) goLineCheckoutBtnText.textContent = '➕ 加入官方 LINE';
        const addFriendUrl = resolvedAddFriendUrl || (config && config.add_friend_url) || '';
        if (addFriendUrl) {
          goLineCheckoutBtn.href = addFriendUrl;
          goLineCheckoutBtn.removeAttribute('aria-disabled');
          goLineCheckoutBtn.style.opacity = '';
          goLineCheckoutBtn.style.pointerEvents = '';
        }
      }
      if (cartCode) showCartCode(cartCode);
      // 需求文件九：這種情境下 Cart Code／加好友按鈕都是必要操作，不能藏在
      // 收合區塊裡讓顧客要多點一次才看到。
      expandCantOpenSection();
      setExternalStatus('請加入官方 LINE，並將結帳代碼貼到聊天室即可繼續完成結帳。', false);
    }

    // fix18-10-hotfix29-C（需求文件十二）：setExternalStatus() 會把每個 '<' 都
    // escape 掉（避免任何動態／伺服器文字被誤判成 HTML），這對一般文字是對的，
    // 但也代表它不能拿來顯示我們自己寫的 <br> 換行——那樣 <br> 會變成畫面上的
    // 逐字文字（真機截圖就是這個症狀）。這個 helper 只能傳入「完全固定、不含
    // 任何動態內插」的程式碼字串（方式 A），絕不可用來顯示使用者輸入或後端
    // 回傳訊息——那些必須繼續走 setExternalStatus() 的 escaping。
    function setExternalStatusFixedHtml(fixedHtml) {
      const el = externalGuideEl.querySelector('#lmgExternalStatus');
      if (!el) return;
      el.innerHTML = fixedHtml;
    }

    // 需求文件十：Handoff 兩次建立都失敗時的官方 LINE 引導文案——沒有可用
    // Token 時不得宣稱「購物車已保留，可直接繼續結帳」。
    function showHandoffFailedGuideText() {
      setExternalStatusFixedHtml('暫時無法建立本次結帳代碼。<br><br>請先加入官方 LINE，<br>再從 LINE 圖文選單重新進入線上點餐。');
    }

    // 需求文件十三：若確認真的沒有 add_friend_url（後端 resolveAddFriendUrl()
    // 兩個來源都是空的），不得再顯示會誤導的「商家尚未設定加入好友網址」小提示
    // 而已——要整個停用「立即開啟 LINE 官方帳號」按鈕，並給更明確的說明。
    function showAddFriendUrlTrulyMissingGuide() {
      setExternalStatusFixedHtml('商家尚未完成官方 LINE 加入好友網址設定。<br><br>請聯絡商家協助完成訂購。');
    }

    // 需求文件十五：偵測「使用者是否真的離開了這個分頁」（切去 LINE），
    // 藉此判斷自動跳轉「大概有沒有成功」——無法 100% 準確，所以文案只說
    // 「未能自動開啟」，不宣稱「LINE 未安裝」（那個結論無法可靠判斷）。
    let launchLikelySucceeded = false;
    const _markLaunchLikelySucceeded = () => { launchLikelySucceeded = true; };
    document.addEventListener('visibilitychange', () => { if (document.hidden) _markLaunchLikelySucceeded(); });
    global.addEventListener('pagehide', _markLaunchLikelySucceeded);
    global.addEventListener('blur', _markLaunchLikelySucceeded);

    // 需求文件十二：Analytics 用 sendBeacon（頁面即將被原生 <a href> 導航離開時，
    // 一般 fetch 不保證送得出去，sendBeacon 是為了這種情境設計的）。同步呼叫、
    // 零 await，不會拖住原生連結的預設行為。
    function sendBeaconEvent(eventName, extra) {
      try {
        if (!global.navigator || !global.navigator.sendBeacon) { onEvent && onEvent(eventName, extra); return; }
        const payload = new Blob([JSON.stringify({ event_name: eventName, ...(extra || {}) })], { type: 'application/json' });
        global.navigator.sendBeacon(`/api/analytics/events?store_id=${encodeURIComponent(storeId)}`, payload);
      } catch (e) { /* Analytics 失敗不影響主流程 */ }
    }

    // 需求文件四／六／九／十三：「立即開啟 LINE 官方帳號」——真機測試證實這個
    // 純加好友連結（不是 oaMessage 連結）在 Messenger WebView 的成功率最高。
    // fix18-10-hotfix29-C：href 來源不再只認 config.add_friend_url（那是舊有
    // line-order.html 設定管道，可能是另一個已經沒在用的欄位）——一開始先用
    // config 裡的值頂著，但 create API 回應帶回 add_friend_url（後端
    // resolveAddFriendUrl() 解析出來的正式值）之後，會用同一個函式覆蓋成
    // 最新鮮的值，兩者共用同一個 click handler，不重複綁定。
    //
    // fix18-10-hotfix29-C Final：這個宣告必須放在下面的狀態機 IIFE 之前——
    // IIFE 會同步呼叫 prepareHandoff()，而 prepareHandoff() 在第一個 await
    // 之前就會同步讀取 resolvedAddFriendUrl，若宣告寫在 IIFE 後面，會在真實
    // 瀏覽器與 Node 測試環境兩邊都直接丟出「Cannot access before
    // initialization」的 TDZ 例外，讓整個 Dialog 初始化中斷（真機上會表現成
    // 「Messenger Dialog 完全沒有反應」）。
    const openOaBtn = externalGuideEl.querySelector('#lmgOpenOaBtn');
    let resolvedAddFriendUrl = (config && config.add_friend_url) || '';

    function applyAddFriendUrlToOpenOaBtn() {
      if (!openOaBtn) return;
      if (resolvedAddFriendUrl) {
        openOaBtn.href = resolvedAddFriendUrl;
        openOaBtn.removeAttribute('aria-disabled');
        openOaBtn.style.opacity = '';
        openOaBtn.style.pointerEvents = '';
      } else {
        openOaBtn.href = '#';
        openOaBtn.setAttribute('aria-disabled', 'true');
        openOaBtn.style.opacity = '.55';
        openOaBtn.style.pointerEvents = 'none';
      }
    }

    if (openOaBtn) {
      applyAddFriendUrlToOpenOaBtn();
      openOaBtn.addEventListener('click', (ev) => {
        if (!resolvedAddFriendUrl) {
          // 需求文件十三：真的沒有設定時整個停用（pointer-events:none 已擋大部分
          // 情況），這裡是鍵盤操作等邊界情況的最後一道防線，不誤導成「請改用複製代碼」。
          ev.preventDefault();
          showAddFriendUrlTrulyMissingGuide();
          return;
        }
        sendBeaconEvent('line_login_open_line_clicked', { trigger: 'open_oa_button' });
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // fix18-10-hotfix29-B（需求文件一～十）：Handoff 狀態機——idle／preparing／
    // ready／failed，配合 requestId 防止舊請求覆蓋新結果，是這次要修正
    // iPhone 13 Pro／17 沒有 CART Code 的核心防護。
    // ══════════════════════════════════════════════════════════════════
    let currentHandoff = null; // { cartCode, lineOaMessageUrl, lineOaConfigured, expiresAt }
    let autoLaunchAttempted = false;
    let manualClicked = false;
    let handoffState = 'idle'; // idle | preparing | ready | failed
    let handoffRequestId = 0;
    const handoffDiagCtx = classifyHandoffDeviceBrowser(environment);
    setHandoffDebugEnabled(!!(config && config.line_handoff_debug));

    function setHandoffState(nextState) { handoffState = nextState; }

    // 需求文件四：preparing——保留官方 LINE 大按鈕可見，但停用複製/到LINE按鈕，
    // 不顯示 HOF 錯誤碼，也不顯示舊 Cart Code（避免看起來像「還能用」）。
    function renderPreparingState() {
      hideCartCode();
      showHandoffErrorCode(null);
      setCopyButtonEnabled(false);
      disableGoLineCheckoutBtn();
      const regenBtn = externalGuideEl.querySelector('#lmgRegenerateTokenBtn');
      if (regenBtn) regenBtn.style.display = 'none';
      setExternalStatus('正在準備 LINE 結帳代碼…', false);
    }

    // 需求文件四：ready——啟用複製/到LINE按鈕、設定真正的 <a href>、清除錯誤碼
    // 與 failed 文案，保留 Hotfix29 既有 UI（官方 LINE 大按鈕維持原順位規則）。
    function applyHandoffToUi(result) {
      // fix18-10-hotfix29-C（需求文件九）：create API 回應是 add_friend_url
      // 最新鮮的來源，只要有給值就採用並重新套用到按鈕（同一函式，不重複綁定）。
      if (result && result.addFriendUrl) {
        resolvedAddFriendUrl = result.addFriendUrl;
        applyAddFriendUrlToOpenOaBtn();
      }
      showHandoffErrorCode(null);
      const regenBtn = externalGuideEl.querySelector('#lmgRegenerateTokenBtn');
      if (regenBtn) regenBtn.style.display = 'none';
      setCopyButtonEnabled(true);
      showCartCode(result.cartCode);
      // fix18-10-hotfix30（需求文件四／八）：主按鈕優先使用 Direct LIFF URL；
      // 只有店家沒有設定 LIFF ID（result.directLiffUrl 為 null）時才退回舊有
      // OA Message 深連結——direct_liff_url 不依賴 basic_id 設定，因此即使
      // lineOaConfigured 為 false，仍可能有 directLiffUrl 可用。
      if (goChatroomBtn) {
        if (result.lineOaConfigured && result.lineOaMessageUrl) {
          goChatroomBtn.href = result.lineOaMessageUrl;
          goChatroomBtn.removeAttribute('aria-disabled');
          goChatroomBtn.style.opacity = '';
          goChatroomBtn.style.pointerEvents = '';
        } else {
          goChatroomBtn.href = '#';
          goChatroomBtn.setAttribute('aria-disabled', 'true');
          goChatroomBtn.style.opacity = '.55';
          goChatroomBtn.style.pointerEvents = 'none';
        }
      }
      if (result.directLiffUrl) {
        enableGoLineCheckoutBtn(result.directLiffUrl);
        setExternalStatus('若沒有自動跳轉，請點下方按鈕。', false);
      } else if (result.lineOaConfigured && result.lineOaMessageUrl) {
        // 需求文件四：缺 LIFF ID 設定時的降級——主按鈕直接改指到舊有 OA
        // Message 連結（等於直接把 Direct LIFF 這版整個退回 Hotfix29-C 行為）。
        enableGoLineCheckoutBtn(result.lineOaMessageUrl);
        setExternalStatus('若沒有自動跳轉，請點下方按鈕。', false);
        // 需求文件四／六：Direct LIFF 不可用時，顧客手上唯一能用的其他選項
        // （聊天室／複製代碼／外部瀏覽器）不能藏在收合區塊裡。
        expandCantOpenSection();
      } else {
        // 需求文件九：ok:true 但店家尚未設定 Basic ID／LIFF ID——這不是失敗，
        // 是既有的「尚未完成一鍵結帳設定」情境，維持原有 fallback 文案／按鈕配置。
        switchToAddFriendFallback(result.cartCode);
      }
    }

    // 需求文件四／十五：failed——清空舊 Cart Code、停用複製/到LINE按鈕、
    // 顯示 HOF-* 錯誤碼、啟用「立即開啟 LINE 官方帳號」與「重新產生結帳代碼」。
    function applyHandoffFailureToUi(result) {
      if (result && result.addFriendUrl) {
        resolvedAddFriendUrl = result.addFriendUrl;
        applyAddFriendUrlToOpenOaBtn();
      }
      hideCartCode();
      setCopyButtonEnabled(false);
      disableGoLineCheckoutBtn();
      showHandoffErrorCode(result && result.errorCode ? result.errorCode : null);
      const regenBtn = externalGuideEl.querySelector('#lmgRegenerateTokenBtn');
      if (regenBtn) regenBtn.style.display = 'block';
      expandCantOpenSection();
      // 需求文件十三：Handoff 失敗時，若確認兩個來源都真的沒有 add_friend_url，
      // 顯示更明確的「請聯絡商家」文案，而不是誤導性的一般失敗訊息。
      if (!resolvedAddFriendUrl) {
        showAddFriendUrlTrulyMissingGuide();
      } else {
        showHandoffFailedGuideText();
      }
    }

    // 需求文件二：idle/failed → preparing → createLineCheckoutHandoff() →
    // normalize（已在 createLineCheckoutHandoff 內完成）→ requestId 檢查 →
    // ready 或 failed。這是修正 iPhone 沒有 CART Code 的核心流程。
    async function prepareHandoff() {
      const requestId = ++handoffRequestId;
      setHandoffState('preparing');
      if (externalGuideVisible) renderPreparingState();
      _handoffLog('prepare_started', { attempt: requestId });
      reportHandoffDiagnostics(storeId, Object.assign({ stage: 'prepare_started' }, handoffDiagCtx));

      // 需求文件一：has_add_friend_url 一律用目前已知最新鮮的 resolvedAddFriendUrl
      // （create API 回應會再更新它，但呼叫當下先用現有值），讓每一筆 report()
      // 都能帶著這個欄位，不再是 null。
      const result = await createLineCheckoutHandoff(storeId, Object.assign({ hasAddFriendUrl: !!resolvedAddFriendUrl }, handoffDiagCtx));

      // 需求文件三：Race Condition 防護——舊請求（例如第一次逾時很晚才回來）
      // 不得覆蓋「重新產生結帳代碼」之後的新結果。
      if (requestId !== handoffRequestId) {
        reportHandoffDiagnostics(storeId, Object.assign({ stage: 'fallback_entered', fallback_reason: 'request_id_mismatch' }, handoffDiagCtx));
        return result;
      }
      if (!externalGuideVisible) return result;

      if (result && result.ok && result.cartCode) {
        currentHandoff = result;
        setHandoffState('ready');
        _handoffLog('ui_applied', { has_cart_code: true });
        // 需求文件二：這裡之前只有 console log（_handoffLog），從未真正回報給
        // 後端——Integration Center「最近成功時間」的查詢條件是
        // stage='ui_applied' AND error_code IS NULL，缺了這筆事件，該查詢
        // 永遠找不到資料，導致成功後台也顯示不出正確狀態。
        reportHandoffDiagnostics(storeId, Object.assign({
          stage: 'ui_applied', error_code: null, fallback_reason: null,
          has_cart_code: true, has_line_oa_message_url: !!result.lineOaMessageUrl,
          response_ok: true,
          http_status: (result.httpStatus === undefined ? null : result.httpStatus),
          ui_cart_count: (result.uiCartCount === undefined ? null : result.uiCartCount),
          payload_cart_count: (result.payloadCartCount === undefined ? null : result.payloadCartCount),
          has_add_friend_url: !!(result.addFriendUrl || resolvedAddFriendUrl),
        }, handoffDiagCtx));
        applyHandoffToUi(result);
      } else {
        currentHandoff = null;
        setHandoffState('failed');
        _handoffLog('ui_applied', { error_code: result && result.errorCode });
        // 需求文件一／三：這筆 fallback_entered 診斷是 Integration Center「最近
        // 失敗時間／最近錯誤碼／最近 HTTP status」直接讀取的來源——之前這裡
        // 完全沒有帶 http_status／response_ok／ui_cart_count／payload_cart_count，
        // 即使 createLineCheckoutHandoff() 內部其實已經知道真正的 http_status，
        // 也從未傳到這裡，才會讓後台永遠顯示「HTTP status: -」。現在一律從
        // result 帶出來（result 本身在每個失敗分支都已經附上這些欄位）。
        reportHandoffDiagnostics(storeId, Object.assign({
          stage: 'fallback_entered',
          error_code: (result && result.errorCode) || null,
          fallback_reason: (result && result.reason) || 'handoff_failed',
          has_cart_code: false,
          has_line_oa_message_url: false,
          response_ok: false,
          http_status: (result && result.httpStatus !== undefined) ? result.httpStatus : null,
          ui_cart_count: (result && result.uiCartCount !== undefined) ? result.uiCartCount : null,
          payload_cart_count: (result && result.payloadCartCount !== undefined) ? result.payloadCartCount : null,
          has_add_friend_url: !!resolvedAddFriendUrl,
        }, handoffDiagCtx));
        applyHandoffFailureToUi(result);
        scheduleAddFriendFallback(requestId);
      }
      return result;
    }

    // fix18-10-hotfix30（需求文件八）：自動開啟目標改為 Direct LIFF URL；只有
    // 店家沒有設定 LIFF ID（result.directLiffUrl 為 null）時才退回舊有 OA
    // Message 連結（等同 Hotfix29-C 原行為）。同一個 store_id+cart_code 只
    // 嘗試一次（用 sessionStorage，不是記憶體變數，才能跨「Dialog 被重新
    // build」仍然有效）。只有 handoffState === 'ready' 才可能被呼叫到這裡
    // （由 prepareHandoff 保證，對應需求文件八「requestId === currentRequestId」
    // 的防護——prepareHandoff 內已經做過 requestId 檢查才會呼叫這裡）。
    function scheduleAutoLaunch(result) {
      if (handoffState !== 'ready' || !result || !result.cartCode) return;
      const launchUrl = result.directLiffUrl || result.lineOaMessageUrl;
      const launchTarget = result.directLiffUrl ? 'direct_liff' : 'oa_message';
      if (!launchUrl) return;
      if (autoLaunchAttempted || manualClicked) return;
      const autoLaunchKey = `line_checkout_auto_launch:${storeId}:${result.cartCode}`;
      let already = false;
      try { already = global.sessionStorage.getItem(autoLaunchKey) === '1'; } catch (e) {}
      if (already) {
        setExternalStatus('若沒有自動跳轉，請點下方按鈕。', false);
        return;
      }
      _handoffLog('auto_launch_scheduled', { launch_target: launchTarget });
      reportHandoffDiagnostics(storeId, Object.assign({ stage: 'direct_liff_auto_launch_scheduled', has_cart_code: true, has_direct_liff_url: !!result.directLiffUrl, launch_target: launchTarget }, handoffDiagCtx));
      setTimeout(() => {
        if (!externalGuideVisible || handoffState !== 'ready' || autoLaunchAttempted || manualClicked) return;
        autoLaunchAttempted = true;
        try { global.sessionStorage.setItem(autoLaunchKey, '1'); } catch (e) {}
        _handoffLog('auto_launch_attempted', { launch_target: launchTarget });
        reportHandoffDiagnostics(storeId, Object.assign({ stage: 'direct_liff_open_attempted', has_cart_code: true, has_direct_liff_url: !!result.directLiffUrl, launch_target: launchTarget }, handoffDiagCtx));
        sendBeaconEvent('line_checkout_handoff_opened', { cart_code_masked: result.cartCode ? result.cartCode.slice(0, 8) + '***' : '', trigger: 'auto', launch_target: launchTarget });
        persistBeforeExternalLogin(storeId, { gate_stage: gateStage });
        launchLikelySucceeded = false;
        // 需求文件六：Auto Launch 失敗（同步 assign 本身丟例外）絕不能把狀態
        // 改成 failed、不清除 Cart Code、不停用按鈕——只保留 Dialog 讓使用者
        // 自己點手動按鈕。
        try { global.location.assign(launchUrl); } catch (e) { /* 保留 Dialog 與所有手動按鈕 */ }
        // 需求文件七：1500~2000ms 後頁面仍可見 → 判斷自動開啟大概沒成功。
        // 不隱藏 Dialog、不鎖住手動連結、不清 Cart Code、不切 failed，只更新提示文字。
        setTimeout(() => {
          if (!externalGuideVisible || handoffState !== 'ready') return;
          if (!launchLikelySucceeded && !document.hidden) {
            reportHandoffDiagnostics(storeId, Object.assign({ stage: 'fallback_to_oa', has_cart_code: true, has_direct_liff_url: !!result.directLiffUrl, launch_target: launchTarget }, handoffDiagCtx));
            setExternalStatus('Messenger 未能自動開啟 LINE。<br>請點下方「無法開啟 LINE？」展開更多方式。', false);
          } else {
            setExternalStatus('若沒有自動跳轉，請點下方按鈕。', false);
          }
        }, 1800);
      }, 1000); // 需求文件八：800～1200ms，固定 1000ms
    }

    // 需求文件八：兩次建立都失敗後，自動嘗試開啟加好友連結——同一次失敗
    // request 只嘗試一次（用 requestId 當 key 的一部分，不會無限跳轉）；
    // 且執行前必須再次確認仍然是 failed，避免使用者這段時間內已經按了
    // 「重新產生結帳代碼」成功轉為 ready。
    function scheduleAddFriendFallback(requestIdAtFailure) {
      // 需求文件一：統一用 resolvedAddFriendUrl（create API 回應優先，config
      // 只是初值），不再散落多個來源各自判斷。
      const targetUrl = resolvedAddFriendUrl || (config && config.add_friend_url) || '';
      if (!targetUrl) return;
      const attemptKey = `line_add_friend_fallback:${storeId}:${requestIdAtFailure}`;
      let already = false;
      try { already = global.sessionStorage.getItem(attemptKey) === '1'; } catch (e) {}
      if (already) return;
      setTimeout(() => {
        if (!externalGuideVisible || handoffState !== 'failed' || requestIdAtFailure !== handoffRequestId) return;
        try { global.sessionStorage.setItem(attemptKey, '1'); } catch (e) {}
        _handoffLog('auto_launch_attempted', { fallback_reason: 'add_friend_fallback' });
        try { global.location.assign(targetUrl); } catch (e) { /* 保留手動大按鈕 */ }
      }, 1000);
    }

    // 需求文件二：Dialog 一開啟就背景建立 Token，不等使用者點擊。
    (async () => {
      const result = await prepareHandoff();
      if (!externalGuideVisible || handoffState !== 'ready') return;
      scheduleAutoLaunch(result);
    })();

    // 需求文件十二／十八：手動 <a> 的 click handler 完全同步、不含 await／fetch／
    // 建立 Token／延遲 timer，也不被 sessionStorage 鎖住——即使自動跳轉已經
    // 嘗試過，使用者仍然可以重複點擊這個原生連結（href 早就準備好了）。
    if (goLineCheckoutBtn) {
      goLineCheckoutBtn.addEventListener('click', (ev) => {
        if (goLineCheckoutBtn.getAttribute('aria-disabled') === 'true') { ev.preventDefault(); return; }
        manualClicked = true; // 純粹用來讓「還沒開始跑」的自動開啟 timer 提早放棄，不影響這次點擊本身
        launchLikelySucceeded = false;
        persistBeforeExternalLogin(storeId, { gate_stage: gateStage });
        // fix18-10-hotfix30（需求文件十二）：手動點擊時的 launch_target 依
        // 目前主按鈕實際指向哪個網址而定（direct_liff／oa_message／
        // add_friend_fallback），不是猜測值。
        const usedDirectLiff = !!(currentHandoff && currentHandoff.directLiffUrl);
        const isFallback = !usedDirectLiff && !(currentHandoff && currentHandoff.lineOaConfigured);
        const launchTarget = usedDirectLiff ? 'direct_liff' : (isFallback ? 'cart_code' : 'oa_message');
        reportHandoffDiagnostics(storeId, Object.assign({ stage: 'direct_liff_manual_clicked', has_cart_code: true, has_direct_liff_url: usedDirectLiff, launch_target: launchTarget }, handoffDiagCtx));
        sendBeaconEvent(isFallback ? 'line_login_open_line_clicked' : 'line_checkout_handoff_opened', {
          cart_code_masked: currentHandoff && currentHandoff.cartCode ? currentHandoff.cartCode.slice(0, 8) + '***' : '', trigger: 'manual', launch_target: launchTarget,
        });
        // 不 preventDefault，讓瀏覽器用原生方式開啟 <a href>（保留使用者手勢，
        // 這正是 iOS Messenger 能不能喚起 LINE 的關鍵）。
      });
    }

    // fix18-10-hotfix30（需求文件十三）：「使用聊天室完成結帳」——舊流程
    // fallback，純粹的原生 <a href>，不攔截 navigation，只回報診斷。
    if (goChatroomBtn) {
      goChatroomBtn.addEventListener('click', (ev) => {
        if (goChatroomBtn.getAttribute('aria-disabled') === 'true') { ev.preventDefault(); return; }
        manualClicked = true;
        reportHandoffDiagnostics(storeId, Object.assign({ stage: 'fallback_to_oa', has_cart_code: true, launch_target: 'oa_message' }, handoffDiagCtx));
        sendBeaconEvent('line_checkout_handoff_opened', {
          cart_code_masked: currentHandoff && currentHandoff.cartCode ? currentHandoff.cartCode.slice(0, 8) + '***' : '', trigger: 'manual', launch_target: 'oa_message',
        });
      });
    }

    // 需求文件九：Token 建立失敗時的「重新產生結帳代碼」。requestId 遞增在
    // prepareHandoff() 內完成，這裡只需要重置 auto-launch 旗標；不重複綁定
    // click handler（這個 addEventListener 只在 Dialog 建立時執行一次）。
    const regenerateBtn = externalGuideEl.querySelector('#lmgRegenerateTokenBtn');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', async () => {
        regenerateBtn.disabled = true;
        autoLaunchAttempted = false; // 新 Token、新 cart_code，允許重新自動嘗試一次
        manualClicked = false;
        try {
          const result = await prepareHandoff();
          if (result && result.ok && handoffState === 'ready') scheduleAutoLaunch(result);
        } finally {
          regenerateBtn.disabled = false;
        }
      });
    }

    // 需求文件十一：「在 Safari 開啟／在外部瀏覽器開啟」——複製目前網址，
    // 提示貼到外部瀏覽器（無法從 Messenger WebView 用程式強制切換瀏覽器，
    // 只能靠使用者自己貼上，這裡把「複製」這個唯一能做的動作做到最方便）。
    const externalBrowserBtn = externalGuideEl.querySelector('#lmgExternalBrowserBtn');
    if (externalBrowserBtn) {
      externalBrowserBtn.addEventListener('click', async () => {
        const url = getSafeCurrentPageUrl();
        const copied = await copyToClipboard(url);
        const tip = environment.isIOS ? '請貼到 Safari 開啟。' : '請貼到外部瀏覽器開啟。';
        setExternalStatus(copied ? `已複製目前網址。${tip}` : `請手動複製此網址：${url}`, false);
      });
    }

    // Android／其他瀏覽器（legacyButtonsHtml）才會有這兩個元素；iOS 版型
    // （iosButtonsHtml）沒有 lmgOpenLineBtn／lmgOsHintBtn，以下沿用 hotfix26-F2
    // 原本的邏輯，完全不變。
    if (openLineBtn) openLineBtn.addEventListener('click', attemptOpenLine);

    if (osHintBtn) {
      osHintBtn.addEventListener('click', () => {
        trackLineEnvironmentEvent(onEvent, 'line_login_open_browser_clicked', environment, gateStage, storeId);
        if (environment.isAndroid) {
          // 需求文件十：intent 失敗要有 fallback，不白畫面、不無限重試。
          const ok = openInAndroidChrome(getSafeCurrentPageUrl());
          if (!ok) setExternalStatus('請點右上角選單，選擇「使用外部瀏覽器開啟」。', false);
        } else if (environment.isIOS) {
          setExternalStatus('請點右上角「⋯」，選擇「在瀏覽器中開啟」，回到點餐頁後再按 LINE 登入。', false);
        } else {
          setExternalStatus('請點選瀏覽器選單，選擇「使用外部瀏覽器開啟」。', false);
        }
      });
    }

    // fix18-10-hotfix26-F3（Fix-2）：iOS 專用兩顆按鈕，只在 iosButtonsHtml 版型存在。
    if (chromeBtn) {
      chromeBtn.addEventListener('click', () => {
        trackLineEnvironmentEvent(onEvent, 'line_login_open_chrome_clicked', environment, gateStage, storeId);
        const ok = openInIOSChrome(getSafeCurrentPageUrl());
        // 不宣稱一定成功（iOS 無法偵測 googlechromes:// 是否真的喚起 App）。
        setExternalStatus(ok
          ? '建議使用 Chrome。若沒有反應，代表尚未安裝 Chrome 或您的裝置限制此功能，請改用下方 Safari 說明。'
          : '目前無法開啟 Chrome，請改用下方 Safari 說明。', false);
      });
    }
    if (safariBtn) {
      safariBtn.addEventListener('click', () => {
        trackLineEnvironmentEvent(onEvent, 'line_login_open_browser_clicked', environment, gateStage, storeId);
        setExternalStatus('請點右上角「⋯」，選擇「在 Safari 中開啟」，回到點餐頁後再按 LINE 登入。', false);
      });
    }

    backBtn.addEventListener('click', () => {
      // 需求文件二十一：返回購物車——關閉引導、不清購物車、不清 pending、
      // 不自動重新彈出會員 Gate，只有使用者再次主動送單/登入才會再顯示。
      trackLineEnvironmentEvent(onEvent, 'line_login_external_guide_closed', environment, gateStage, storeId);
      closeExternalBrowserLoginGuide();
      options && options.onClose && options.onClose();
    });

    return externalGuideEl;
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
        // fix18-10-hotfix26-I（需求文件十二／二十一）：若稍早有記錄「切到外部
        // 瀏覽器登入」的 pending 狀態，這裡視為「使用者已返回」，記錄一次
        // Analytics 事件並清除 pending（過期超過 15 分鐘的已由
        // readExternalLoginPending() 自動失效，不會殘留持續觸發）。
        const externalPending = readExternalLoginPending();
        if (externalPending) {
          trackLineEnvironmentEvent(target ? target.onEvent : null, 'line_login_external_return_detected',
            detectBrowserEnvironment(), externalPending.gate_stage, storeId);
          clearExternalLoginPending();
        }
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
  // fix18-10-hotfix26-I（回歸修正）：hotfix26-G 新增這三行監聽時，沒有防範
  // document／addEventListener 不存在的情況（例如既有 smoke test 用簡化版
  // window/document mock，或極舊瀏覽器），導致模組載入時直接拋例外。這裡
  // 改成防禦性檢查（hasDOM + 個別 typeof 檢查），行為完全不變，只是不再
  // 假設這些 API 一定存在。
  try {
    if (hasDOM && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', attemptAutoFriendshipResume);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('pageshow', attemptAutoFriendshipResume);
      global.addEventListener('focus', attemptAutoFriendshipResume);
    }
  } catch (e) { /* 非標準瀏覽器環境，安全略過，不影響其餘功能 */ }


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
        const loginOpts = { gate_stage: 'checkout' };
        const loginRes = await loginWithLine(storeId, loginOpts);
        if (loginRes.redirected) return; // 頁面即將跳轉，購物車已由既有機制保留
        // fix18-10-hotfix26-I（需求文件十三）：Facebook／Instagram 內建瀏覽器，
        // 不能直接跳轉 liff.login()；改顯示外部開啟引導，Promise 仍必須 resolve，
        // 讓送出按鈕能恢復，不可懸掛、不可先建立訂單再登入。
        if (loginRes.externalBrowserRequired) {
          persistBeforeExternalLogin(storeId, loginOpts);
          closeMemberGate();
          showExternalBrowserLoginGuide(config, {
            storeId, gateStage: 'checkout', environment: loginRes.environment, onEvent,
            onClose: () => { /* 需求文件二十一：關閉引導不重新彈出會員 Gate */ },
          });
          resolve({ ok: false, reason: 'external_browser_required', externalBrowserRequired: true });
          return;
        }
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
        const loginOpts = { gate_stage: 'entry' };
        const loginRes = await loginWithLine(storeId, loginOpts);
        if (loginRes.redirected) return;
        // fix18-10-hotfix26-I（需求文件十四）：entry 模式也要共用同一套外部
        // 瀏覽器引導，不可只修 checkout。
        if (loginRes.externalBrowserRequired) {
          persistBeforeExternalLogin(storeId, loginOpts);
          closeMemberGate();
          showExternalBrowserLoginGuide(config, {
            storeId, gateStage: 'entry', environment: loginRes.environment, onEvent,
            onClose: () => {},
          });
          resolve({ ok: false, reason: 'external_browser_required', externalBrowserRequired: true });
          return;
        }
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
    // fix18-10-hotfix26-I 新增：Facebook／Instagram 內建瀏覽器環境修復
    detectBrowserEnvironment, detectTrafficSource, buildLiffOpenUrl, openInAndroidChrome,
    getSafeCurrentPageUrl, persistBeforeExternalLogin, readExternalLoginPending,
    clearExternalLoginPending, showExternalBrowserLoginGuide, closeExternalBrowserLoginGuide,
    trackLineEnvironmentEvent,
    // fix18-10-hotfix26-F8-B 新增：Messenger →「到 LINE 完成結帳」
    createLineCheckoutHandoff, copyToClipboard,
    // fix18-10-hotfix29-B 新增（需求文件十一，僅供 Node 測試環境使用）：
    // Response Normalize／Timeout／Retry／錯誤碼顯示 helper。
    normalizeHandoffResponse, fetchWithTimeout, handoffErrorCodeToDisplay,
    classifyHandoffDeviceBrowser, setHandoffDebugEnabled, shouldRetryHandoff,
  };

})(window);
