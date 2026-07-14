// public/js/line-member-gate.js — fix18-10-hotfix23-E｜LINE 會員入口 × LIFF 登入
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

'use strict';
(function (global) {

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

  // 登入跳轉前，保存原始頁面所需的一切狀態（購物車由既有 ORDER_CART_KEY 機制
  // 自然保留，這裡只需額外保存「要跳轉回來的網址」與 gate 觸發階段）。
  function buildReturnUrl(storeId, extra) {
    const url = new URL(window.location.href);
    url.searchParams.set('store_id', storeId);
    if (extra && extra.gate_stage) url.searchParams.set('line_gate_return', extra.gate_stage);
    return url.toString();
  }

  const state = {}; // per-store 執行期狀態（不落地）

  async function initLineMemberGate(config) {
    const storeId = config.store_id;
    state[storeId] = { config, liffReady: false };
    if (!config.liff_id) return state[storeId];
    try {
      await loadLiffSdk();
      await global.liff.init({ liffId: config.liff_id });
      state[storeId].liffReady = true;
    } catch (e) {
      console.warn('[line-member-gate] LIFF 初始化失敗:', e.message);
      state[storeId].liffReady = false;
      state[storeId].liffError = e.message;
    }
    return state[storeId];
  }

  function isLiffAvailable(storeId) {
    return !!(state[storeId] && state[storeId].liffReady && global.liff);
  }

  async function loginWithLine(storeId, opts) {
    if (!isLiffAvailable(storeId)) throw new Error('liff_not_ready');
    if (!global.liff.isLoggedIn()) {
      global.liff.login({ redirectUri: buildReturnUrl(storeId, opts) });
      return { redirected: true };
    }
    return { redirected: false };
  }

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

  global.LineMemberGate = {
    initLineMemberGate, isLiffAvailable, loginWithLine, getLineProfile,
    getFriendshipStatus, refreshFriendStatus, openFriendAddPage,
    buildReturnUrl, saveMemberSession, getMemberSession, clearMemberSession,
    showMemberGate, closeMemberGate, verifyWithBackend,
    requireMemberBeforeCheckout, requireMemberOnEntry,
  };

})(window);
