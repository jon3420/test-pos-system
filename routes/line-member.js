// routes/line-member.js — fix18-10-hotfix23-E｜LINE 會員入口 × LIFF 登入 ×
// 好友狀態綁定 × LINE CRM Foundation
//
// POST /api/line-member/verify   — 前台 LIFF 登入後呼叫，後端驗證 ID Token、
//                                   查詢好友狀態、upsert line_members、寫入
//                                   CRM history、寫入對應的 analytics 事件。
// GET  /api/line-member/members         — 後台會員列表（篩選／排序／分頁）
// GET  /api/line-member/members/export  — CSV 匯出（遮罩 LINE User ID）
// GET  /api/line-member/members/:id     — 會員詳細頁（含 CRM Timeline）
//
// 安全原則（需求文件十八／二十）：
//   - Access Token／ID Token／Channel Secret 絕不寫 log、絕不回傳前端。
//   - line_user_id 一律由後端驗證後才視為可信，不接受前端指定。
//   - verify endpoint 有簡易 rate limit。
//   - 所有查詢以 store_id 隔離；LINE User ID 對外一律遮罩顯示。

'use strict';
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { verifyLineIdToken, getFriendshipStatus } = require('../utils/lineMemberAuth');
const { createMemberSession, verifyMemberSession } = require('../utils/lineMemberSession');
const {
  upsertMemberProfile, linkMemberSession, updateTouchAttribution,
  maskLineUserId, computeLifecycleStage,
} = require('../utils/lineMemberStats');
const { logServerEvent } = require('../utils/analyticsLog');
// fix18-10-hotfix23-E1：管理端 endpoint（會員列表／詳情／CSV 匯出）強制 staff JWT，
// 不再接受 x-store-id / query.store_id 作為授權依據。POST /verify 維持公開
// （顧客登入用），不套用此 middleware。
const { requireStaffJwt, JWT_SECRET } = require('../middleware/storeGuard');
// fix18-10-hotfix26-E（需求文件十）：verify_debug 三個條件缺一不可——
// LINE_MEMBER_DEBUG=1、diagnostic_only=true、且呼叫端帶有效的店家管理員
// JWT。POST /verify 本身仍是公開端點（一般顧客登入不需要、也不會帶 staff
// JWT），這裡只在「想拿到 verify_debug」這個額外資訊時才驗證 JWT，不影響
//一般登入或既有 diagnostic_only（無 debug）行為。
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sanitizeCsvCell } = require('../utils/csvSecurity');

// fix18-10-hotfix26-G（需求文件十七～二十七）：EXPIRED_ID_TOKEN 根因修正——
// 「使用者登入狀態已過期」是可恢復事件，不是系統故障，不能算成 is_friend=false，
// 也不該在 Verify Health 裡跟 CHANNEL_ID_MISMATCH 這種真正的設定錯誤混在一起。
// 這裡只新增分類資訊（recoverable／action／token 指紋），完全不改變既有
// verifyLineIdToken()／getFriendshipStatus() 的判斷邏輯或既有回應欄位。
const RECOVERABLE_VERIFY_CODES = new Set(['EXPIRED_ID_TOKEN', 'MISSING_ID_TOKEN', 'ID_TOKEN_MISSING']);
function verifyCodeRecoverable(code) { return RECOVERABLE_VERIFY_CODES.has(code); }
function verifyCodeAction(code) {
  if (code === 'EXPIRED_ID_TOKEN' || code === 'MISSING_ID_TOKEN' || code === 'ID_TOKEN_MISSING') return 'REAUTHENTICATE';
  return 'NONE';
}
// 單向雜湊，只保留前 8 碼，供 Verify Timeline 判斷「是否重送同一枚過期 Token」，
// 絕對無法還原原始 Token（需求文件二十七）。
function tokenFingerprint(token) {
  if (!token) return null;
  try { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8); }
  catch (e) { return null; }
}

// ── 簡易 in-memory rate limit（同一 store + IP）── 每 60 秒最多 20 次驗證請求
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateBucket = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBucket.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateBucket.delete(key);
  }
}, 5 * 60 * 1000).unref?.();
function checkRateLimit(storeId, ip) {
  const key = `${storeId}|${ip}`;
  const now = Date.now();
  let entry = rateBucket.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateBucket.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

function getSetting(db, storeId, key) {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : '';
}

// H1.4.10 hotfix30-B5-R5.4-FRIEND-LIVE（TASK 5）：/friend-conflict 只寫稽核
// 紀錄，但顧客頁面 lifecycle（pageshow/focus/visibilitychange burst）可能
// 短時間內重複觸發同一個 member 的同一種衝突，這裡用「同一 store+member+
// 衝突類型」的短效 in-memory 去重（與上面 rateBucket 相同慣例，皆為單一
// process 記憶體、不需要落地成資料表），短時間內只真的寫入一次，其餘直接
// 回 success（idempotent，前端不需要特殊處理重複回應）。
const CONFLICT_DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 分鐘
const conflictDedupeBucket = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of conflictDedupeBucket.entries()) {
    if (now - ts > CONFLICT_DEDUPE_WINDOW_MS) conflictDedupeBucket.delete(key);
  }
}, 10 * 60 * 1000).unref?.();
function shouldSkipConflictWrite(storeId, lineUserId, conflictType) {
  const key = `${storeId}|${lineUserId}|${conflictType}`;
  const now = Date.now();
  const last = conflictDedupeBucket.get(key);
  if (last && now - last < CONFLICT_DEDUPE_WINDOW_MS) return true;
  conflictDedupeBucket.set(key, now);
  return false;
}

// fix18-10-hotfix26-E（需求文件十）：verify_debug 三個條件之一——呼叫端必須帶
// 這個 store 的有效管理員 JWT。純唯讀檢查，不影響一般顧客 verify 流程（一般
// 顧客本來就不會、也不需要帶這個 header）。
function hasValidStaffAuth(req, storeId) {
  try {
    const auth = req.headers && req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return false;
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    return !!payload && payload.role === 'store' && String(payload.store_id) === String(storeId);
  } catch (e) {
    return false;
  }
}

// fix18-10-hotfix26（需求文件四）：前端 liff.getFriendship() 結果的正規化。
// 只接受真正的 boolean，其他一律視為 null（未知），不接受 "true"/"false"/1/0
// 這類字串或數字，避免型別混淆造成誤判。
function normalizeFriendFlag(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

// fix18-10-hotfix26-A：is_friend (1/0/null) → 'friend' / 'non_friend' / 'unknown' 字串，
// 供前端／CSV／診斷中心共用同一套字彙，不必各自重複判斷。
function friendStatusLabel(isFriend) {
  if (isFriend === 1 || isFriend === true) return 'friend';
  if (isFriend === 0 || isFriend === false) return 'non_friend';
  return 'unknown';
}

// fix18-10-hotfix26-F1（需求文件九／十一）：把前端送來的 gate_stage 對應成
// 規格指定的 friend_source 詞彙。這裡只是命名對應，不影響任何既有判斷邏輯——
// 'friend_recheck' 就是使用者按下「我已加入，重新確認」或從加好友頁自動返回
// 觸發的重新確認，對應規格的 checkout_recheck；'callback' 是 LIFF 登入導回頁
// 自動完成的驗證，對應 login_verify；其餘（entry/checkout 首次驗證等）視為
// 一般的 liff_friendship 結果來源。
function friendSourceFromGateStage(gateStage) {
  if (gateStage === 'friend_recheck') return 'checkout_recheck';
  if (gateStage === 'callback') return 'login_verify';
  if (gateStage === 'manual_recheck') return 'manual_recheck';
  return 'liff_friendship';
}

// fix18-10-hotfix26-A（需求文件十五／A6）：是否符合「要求加入官方帳號」設定。
// requireFriend=false → true（沒有要求，一律符合）
// requireFriend=true  → is_friend=1 為 true／is_friend=0 為 false／is_friend=NULL 為 null（無法確認，不可誤判）
function meetsRequirement(requireFriend, isFriend) {
  if (!requireFriend) return true;
  if (isFriend === 1 || isFriend === true) return true;
  if (isFriend === 0 || isFriend === false) return false;
  return null;
}

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/verify
// ══════════════════════════════════════════════════════════════════
router.post('/verify', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!checkRateLimit(storeId, ip)) {
      // 不得因驗證頻率限制中斷點餐（需求文件六第 9 點／十八）：回傳結構化錯誤，
      // 前端 fallback 為「請稍後再試」，不擋既有瀏覽/加購行為。
      return res.status(429).json({ success: false, reason: 'rate_limited', code: 'RATE_LIMITED', message: '請求過於頻繁，請稍後再試' });
    }

    // fix18-10-hotfix26（需求文件三／四）：friend_flag 為前端 liff.getFriendship()
    // 當次登入取得的結果；diagnostic_only 為後台「LINE 設定診斷中心」用的安全測試
    // 模式（驗證 token／連線是否正常，但不得建立或更新任何會員資料）。
    const { id_token, access_token, friend_flag, diagnostic_only } = req.body || {};
    const isDiagnosticOnly = diagnostic_only === true;

    // fix18-10-hotfix26-verify-debug（需求文件一）：安全 Debug log，只記錄
    // present/length，絕不輸出 token 內容本身。預設關閉，需設定環境變數
    // LINE_MEMBER_DEBUG=1 才會輸出，避免正式環境 log 被灌爆。
    if (process.env.LINE_MEMBER_DEBUG === '1') {
      console.log('[line-member][verify-debug]', JSON.stringify({
        store_id: storeId,
        id_token: { present: !!id_token, length: id_token ? String(id_token).length : 0 },
        access_token: { present: !!access_token, length: access_token ? String(access_token).length : 0 },
        friend_flag: typeof friend_flag === 'boolean' ? friend_flag : null,
        diagnostic_only: isDiagnosticOnly,
        source: (req.body && req.body.analytics && req.body.analytics.source) || (req.body && req.body.attribution && req.body.attribution.source) || null,
      }));
    }

    if (!id_token || typeof id_token !== 'string') {
      return res.status(400).json({ success: false, reason: 'missing_id_token', code: 'MISSING_ID_TOKEN', message: '缺少 id_token' });
    }

    const channelId = getSetting(db, storeId, 'line_member_login_channel_id');
    if (!channelId) {
      return res.status(400).json({ success: false, reason: 'not_configured', code: 'STORE_CONFIG_MISSING', message: '此店家尚未設定 LINE Login Channel' });
    }

    // ── 驗證 ID Token（不信任前端傳入的 line_user_id）───────────
    // fix18-10-hotfix26-E：在路由層量測耗時（完全在 verifyLineIdToken() 外部
    // 計時，不改動該函式本身、不改動它的回傳值或判斷邏輯），供 LINE Verify
    // Health Dashboard 的「Verify Timeline」與健康度統計使用。
    const verifyStartedAt = Date.now();
    const verifyResult = await verifyLineIdToken(id_token, channelId);
    const verifyElapsedMs = Date.now() - verifyStartedAt;
    // 供 analytics 事件關聯用；相容兩種輸入格式：{analytics:{...}} 或頂層
    // visitor_id/session_id/cart_id/attribution（見需求文件四）。
    const bodyAp = (req.body && req.body.analytics && typeof req.body.analytics === 'object') ? req.body.analytics : {};
    const bodyAttr = (req.body && req.body.attribution && typeof req.body.attribution === 'object') ? req.body.attribution : {};
    const ap = {
      visitor_id: req.body.visitor_id || bodyAp.visitor_id,
      session_id: req.body.session_id || bodyAp.session_id,
      cart_id: req.body.cart_id || bodyAp.cart_id,
      gate_stage: bodyAp.gate_stage,
      source: bodyAp.source || bodyAttr.source,
      medium: bodyAp.medium || bodyAttr.medium,
      campaign: bodyAp.campaign || bodyAttr.campaign,
      first_touch: bodyAp.first_touch || bodyAttr.first_touch,
      order_mode: bodyAp.order_mode,
    };
    const evtBase = {
      store_id: storeId,
      visitor_id: ap.visitor_id || `unknown_verify_${Date.now()}`,
      session_id: ap.session_id || `unknown_verify_${Date.now()}`,
      cart_id: ap.cart_id || null,
      order_mode: ap.order_mode || null,
      source: ap.source || null, medium: ap.medium || null, campaign: ap.campaign || null,
      metadata: null,
    };

    if (!verifyResult.ok) {
      // fix18-10-hotfix26-G：token_fingerprint／retry_attempt 純供診斷（Verify
      // Timeline／健康度）使用，retry_attempt 是前端自己回報的重試次數計數，
      // 不作為任何安全判斷依據（不可信任前端數字），只用來人工判讀是否疑似
      // 前端重複送出同一枚過期 Token。
      const clientRetryAttempt = Number.isFinite(Number(req.body && req.body.retry_attempt))
        ? Math.max(0, Math.min(50, Number(req.body.retry_attempt))) : 0;
      logServerEvent(db, { ...evtBase, event_name: 'line_login_failed',
        metadata: {
          reason: verifyResult.reason, code: verifyResult.code || null, gate_stage: ap.gate_stage || null,
          // fix18-10-hotfix26-E：http_status 在 aud_mismatch/expired/no_sub 這幾種
          // 失敗原因裡，LINE 官方 API 本身其實是回 200（是我方驗證邏輯判定失敗），
          // 只有 verify_failed 這個 reason 才是 LINE API 本身回非 2xx／無法解析，
          // 這裡如實反映，不誤導 Health Dashboard 的 HTTP Status 統計。
          http_status: verifyResult.http_status || 200,
          elapsed_ms: verifyElapsedMs,
          // fix18-10-hotfix26-E（需求文件十一）：標記這筆是不是後台診斷中心自己
          // 觸發的測試呼叫，讓 Verify Health 統計可以排除管理者自己的測試，只反映
          // 真實顧客的登入健康狀態；Verify Timeline 仍會顯示這個欄位供人工判讀。
          diagnostic_only: isDiagnosticOnly,
          // fix18-10-hotfix26-G（需求文件二十六／二十七）：可恢復事件分類 + Token 指紋
          recoverable: verifyCodeRecoverable(verifyResult.code),
          action: verifyCodeAction(verifyResult.code),
          token_fingerprint: tokenFingerprint(id_token),
          retry_attempt: clientRetryAttempt,
          client_event: ap.gate_stage || null,
        } });
      // H1.4.10 section F：被動辨識（gate_stage=liff_auto_identify）失敗時，
      // 額外記錄專用事件供 Dashboard／回歸測試判讀，metadata 只含允許欄位，
      // 完全不影響上面既有的 line_login_failed 事件與既有回應內容。
      if (ap.gate_stage === 'liff_auto_identify') {
        const liffFailReasonMap = { EXPIRED_ID_TOKEN: 'id_token_expired', MISSING_ID_TOKEN: 'id_token_missing', ID_TOKEN_MISSING: 'id_token_missing' };
        logServerEvent(db, { ...evtBase, event_name: 'line_liff_auto_identify_failed',
          metadata: { page_type: ap.order_mode || null, reason_code: liffFailReasonMap[verifyResult.code] || 'verify_failed', is_in_client: true, is_logged_in: true } });
      }
      // 不得因 LINE API 錯誤回 500 破壞點餐（需求文件六）
      const failurePayload = {
        success: false, reason: verifyResult.reason, message: verifyResult.message,
        code: verifyResult.code || 'UNKNOWN_VERIFY_ERROR',
        // fix18-10-hotfix26-G（需求文件二十五）：前端需要明確的 recoverable／action
        // 才能判斷是否可以自動恢復（例如自動重新登入），而不是收到一個籠統的
        // verify_failed 卻不知道能不能自救。絕不因此把此次事件寫成 is_friend=false、
        // 清除會員綁定、或建立新會員（上面 upsertMemberProfile 完全沒有被呼叫到）。
        recoverable: verifyCodeRecoverable(verifyResult.code),
        action: verifyCodeAction(verifyResult.code),
      };
      // fix18-10-hotfix26-E（需求文件十）：verify_debug 三個條件缺一不可——
      // diagnostic_only=true、伺服器 LINE_MEMBER_DEBUG=1（verifyResult.debug
      // 才會存在）、且呼叫端帶這個 store 的有效管理員 JWT，三者都成立才附加。
      if (isDiagnosticOnly && verifyResult.debug && hasValidStaffAuth(req, storeId)) {
        failurePayload.diagnostic_only = true;
        failurePayload.verify_debug = verifyResult.debug;
      } else if (isDiagnosticOnly) {
        failurePayload.diagnostic_only = true;
      }
      return res.status(200).json(failurePayload);
    }

    const lineUserId = verifyResult.line_user_id;

    // ── 診斷模式（需求文件十八第 5 點）：只驗證 Token／連線是否正常，───────
    // 絕不建立會員、絕不寫入 CRM Timeline、絕不更新消費資料。
    if (isDiagnosticOnly) {
      let diagFriendResult = { ok: false, is_friend: null };
      if (access_token) diagFriendResult = await getFriendshipStatus(access_token);
      const clientFlag = normalizeFriendFlag(friend_flag);
      const diagIsFriend = diagFriendResult.ok ? diagFriendResult.is_friend : (clientFlag === null ? null : clientFlag === 1);
      const diagPayload = {
        success: true,
        diagnostic_only: true,
        is_friend: diagIsFriend,
        display_name: verifyResult.display_name,
        message: '診斷模式：Token 驗證成功，未建立或更新會員資料',
      };
      // 同上：三個條件缺一不可才附加 verify_debug。
      if (verifyResult.debug && hasValidStaffAuth(req, storeId)) diagPayload.verify_debug = verifyResult.debug;
      return res.json(diagPayload);
    }

    // fix18-10-hotfix24-A3：Identity Resolver（需求文件四）—— 一旦 ID Token 驗證通過，
    // 後續所有這個請求裡的事件（friend_status_checked／line_login_success／
    // member_login／friend_added 等）都應該用這個已驗證過的 line_user_id 當身份依據，
    // 而不是退回估算用的 session_id。
    evtBase.line_user_id = lineUserId;

    // ── 好友狀態（安全 fallback：查不到就是 null，不阻擋流程）─────
    // fix18-10-hotfix26（需求文件三／四／六）：優先信任後端自己用 access_token
    // 呼叫 LINE 好友關係 API 得到的結果（friendResult.ok）；只有在後端這次查不到
    // 時，才退而使用前端 liff.getFriendship() 送來的 friend_flag 當備援訊號——
    // 但 friend_flag 仍只是「前端 SDK 回報的結果」，不可單獨當成唯一信任來源，
    // 這裡只在後端驗證失敗時才採用，且一律經過 normalizeFriendFlag() 正規化。
    let friendResult = { ok: false, is_friend: null };
    if (access_token) {
      friendResult = await getFriendshipStatus(access_token);
    }
    const clientFriendFlag = normalizeFriendFlag(friend_flag);
    const finalIsFriend = friendResult.ok
      ? friendResult.is_friend
      : (clientFriendFlag === null ? null : clientFriendFlag === 1);

    logServerEvent(db, { ...evtBase, event_name: 'friend_status_checked',
      metadata: { is_friend: finalIsFriend, gate_stage: ap.gate_stage || null } });

    // ── upsert 會員資料 + 好友狀態轉換規則 ───────────────────────
    // fix18-10-hotfix26-F1（需求文件五／七／十六）：所有來源都經同一組
    // upsertMemberProfile() 參數（source／checked_at）走同一套規則，不再各自
    // 判斷；checked_at 用「這次請求真正發生的時間」，讓時間競爭保護生效。
    const friendCheckedAt = new Date().toISOString();
    const friendSource = friendSourceFromGateStage(ap.gate_stage);
    const upsertResult = upsertMemberProfile(db, storeId, {
      line_user_id: lineUserId,
      display_name: verifyResult.display_name,
      picture_url: verifyResult.picture_url,
      is_friend: finalIsFriend,
      is_login: true,
    }, { source: friendSource, checked_at: friendCheckedAt });

    // ── 串接匿名 Analytics 識別（Customer Journey）──────────────
    linkMemberSession(db, storeId, lineUserId, {
      visitor_id: ap.visitor_id, session_id: ap.session_id, cart_id: ap.cart_id,
    });
    // ── 首次來源／最後來源 ───────────────────────────────────────
    if (ap.first_touch || ap.source) {
      updateTouchAttribution(db, storeId, lineUserId, {
        source: (ap.first_touch && ap.first_touch.source) || ap.source,
        campaign: (ap.first_touch && ap.first_touch.campaign) || ap.campaign,
      });
    }

    logServerEvent(db, { ...evtBase, event_name: 'line_login_success',
      metadata: { is_friend: finalIsFriend, gate_stage: ap.gate_stage || null, http_status: 200, elapsed_ms: verifyElapsedMs, diagnostic_only: false } });
    logServerEvent(db, { ...evtBase, event_name: 'member_login', metadata: { gate_stage: ap.gate_stage || null } });
    // H1.4.10 section F：被動辨識成功時額外記錄專用事件（真實性已由後端驗證
    // 完成，見上方 verifyLineIdToken()），不影響既有 line_login_success／
    // member_login 事件與既有回應內容，純 additive。
    if (ap.gate_stage === 'liff_auto_identify') {
      logServerEvent(db, { ...evtBase, event_name: 'line_liff_auto_identify_success',
        metadata: { page_type: ap.order_mode || null, is_in_client: true, is_logged_in: true } });
    }

    if (upsertResult && upsertResult.friendEvent) {
      logServerEvent(db, { ...evtBase, event_name: upsertResult.friendEvent, metadata: {} });
    }

    const freshRow = db.get('SELECT is_blocked, last_friend_check, friend_source FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]) || {};
    // fix18-10-hotfix26（需求文件八）：是否「要求加入官方帳號」由店家設定決定，
    // 沿用既有 line_member_require_friend 設定 key（規格文件裡的 require_follow
    // 只是範例命名，實際專案已有這個設定，不重複建立第二個）。回傳給前端，
    // 讓 line-member-gate.js 的 checkout／entry 兩種模式都能一致判斷是否放行。
    const requireFriend = getSetting(db, storeId, 'line_member_require_friend') === '1';
    const lastFriendCheckAt = freshRow.last_friend_check || '';

    res.json({
      success: true,
      // fix18-10-hotfix23-E：前端下單流程改帶這個簽章過的短效 session，不再直接
      // 使用/保存原始 line_user_id（見 utils/lineMemberSession.js）。
      member_session: createMemberSession({ store_id: storeId, line_user_id: lineUserId }),
      require_friend: requireFriend,
      // fix18-10-hotfix26-A：以下三個是 require_follow / friend_status /
      // last_friend_check_at 的相容別名，讓回應同時符合專案既有命名
      // （require_friend／last_friend_check）與需求文件範例命名。
      require_follow: requireFriend,
      is_friend: finalIsFriend,
      friend_status: friendStatusLabel(finalIsFriend),
      last_friend_check_at: lastFriendCheckAt,
      meets_requirement: meetsRequirement(requireFriend, finalIsFriend),
      member: {
        line_user_id_masked: maskLineUserId(lineUserId),
        display_name: verifyResult.display_name,
        picture_url: verifyResult.picture_url,
        is_friend: finalIsFriend,
        friend_status: friendStatusLabel(finalIsFriend),
        is_blocked: !!freshRow.is_blocked,
        last_friend_check: lastFriendCheckAt,
        last_friend_check_at: lastFriendCheckAt,
      },
      // fix18-10-hotfix26-F1（需求文件十七）：向下相容新增欄位，不移除既有欄位。
      friendship: {
        is_friend: finalIsFriend,
        status: friendStatusLabel(finalIsFriend),
        source: freshRow.friend_source || friendSource,
        checked_at: friendCheckedAt,
        changed: !!(upsertResult && upsertResult.friendEvent),
      },
    });
  } catch (e) {
    console.error('[line-member] POST /verify error:', e.message);
    // 不得讓例外破壞點餐流程，回傳結構化失敗，前端安全 fallback
    res.status(200).json({ success: false, reason: 'exception', code: 'UNKNOWN_VERIFY_ERROR', message: '驗證發生錯誤，請稍後再試' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/link-context — H1.4.10 section I
//
// LIFF 被動辨識成功後，購物車 cart_id 可能還沒建立（顧客第一次 add_to_cart
// 才會建立），因此需要一支獨立、可重複呼叫的「補綁定」端點，把已驗證的
// LINE 會員與目前 visitor_id/session_id/cart_id 對齊。
//
// 安全原則（需求文件九）：
//   - 絕不接受前端直接傳入的 raw line_user_id；一律透過 member_session
//     （verifyMemberSession，內部同時檢查簽章與 store_id 是否相符，天生
//     防止跨店綁定）換得可信 line_user_id。
//   - idempotent：linkMemberSession() 內部本來就是依
//     (store_id, line_user_id, visitor_id) unique 做 upsert，重複呼叫只會
//     更新 session_id/cart_id，不會建立重複資料列。
//   - 不得因每次 cart_updated 都被瘋狂呼叫：這裡只做輕量 rate limit，前端
//     呼叫時機的節流（signature 去重）由呼叫端（line-member-gate.js /
//     line-order.html／line-shipping.html）負責。
// ══════════════════════════════════════════════════════════════════
router.post('/link-context', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!checkRateLimit(storeId, `link-context|${ip}`)) {
      return res.status(429).json({ success: false, reason: 'rate_limited', code: 'RATE_LIMITED' });
    }

    const { member_session, visitor_id, session_id, cart_id } = req.body || {};
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_member_session' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      // 簽章錯誤／過期／店家不符：一律安全 fallback，不得 500，不得暴露原因細節。
      return res.status(200).json({ success: false, reason: 'invalid_session' });
    }
    const visitorId = typeof visitor_id === 'string' ? visitor_id.slice(0, 200) : '';
    if (!visitorId) {
      return res.status(200).json({ success: false, reason: 'missing_visitor_id' });
    }
    const linked = linkMemberSession(db, storeId, lineUserId, {
      visitor_id: visitorId,
      session_id: typeof session_id === 'string' ? session_id.slice(0, 200) : '',
      cart_id: typeof cart_id === 'string' ? cart_id.slice(0, 200) : '',
    });
    res.json({ success: !!linked });
  } catch (e) {
    console.error('[line-member] POST /link-context error:', e.message);
    // 不得讓例外破壞下單流程（需求文件九）
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/friend-state — H1.4.10 hotfix30-B5-R5.4-FRIEND-LIVE
// （TASK 2：Backend authoritative refresh）
//
// 根因（見本輪需求文件 CASE 1～3）：friend_entry／friend_checkout 這類「免
// 登入」模式的前端只讀本地 member_session 快取（saveMemberSession() 寫入的
// is_friend），這份快取只在真的跑過一次完整 /verify（登入／被動辨識／手動
// 重新確認）後才會建立，且之後不會自己更新——即使 LINE Follow/Unfollow
// Webhook 已經把後端 line_members.is_friend 改成最新值，本地快取仍是舊的。
//
// 這支端點只做一件事：拿既有（已簽章過、已驗證身份）的 member_session，
// 直接重新查一次 line_members 目前的 is_friend/friend_status，回傳給前端
// 更新本地快取——完全不呼叫 LINE 官方 API、不建立/更新任何會員資料、不寫
// CRM Timeline、不呼叫 upsertMemberProfile()/applyFriendEvent()、也不呼叫
// logServerEvent()（見 TASK 3：不得新增 GA4/Meta 事件）。純唯讀。
//
// 安全性：不接受前端直接傳入的 line_user_id，一律透過 verifyMemberSession()
// 換得可信身份（與 /link-context 相同原則），且此 token 早已是真正登入／
// 被動辨識流程核發，不是新的信任來源，不新增第二套 member database。
router.post('/friend-state', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(storeId, `friend-state|${ip}`)) {
      return res.status(429).json({ success: false, reason: 'rate_limited', code: 'RATE_LIMITED' });
    }
    const { member_session } = req.body || {};
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_member_session' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      // 簽章錯誤／過期／店家不符：安全 fallback，不得 500、不得暴露原因細節
      // （與 /link-context 相同慣例）。
      return res.status(200).json({ success: false, reason: 'invalid_session' });
    }
    const row = db.get(
      'SELECT is_friend, friend_status, last_friend_check, last_friend_check_at, friend_source FROM line_members WHERE store_id=? AND line_user_id=?',
      [storeId, lineUserId]
    );
    const requireFriend = getSetting(db, storeId, 'line_member_require_friend') === '1';
    const isFriend = row ? (row.is_friend === 1 ? true : row.is_friend === 0 ? false : null) : null;
    // 內部診斷用途（TASK 3：只用來標示這是「重新取得 Backend member state」
    // 這條路徑，不是分析事件，也不會出現在任何 GA4/Meta 回報裡）。
    if (process.env.LINE_MEMBER_DEBUG === '1') {
      console.log('[line-member][friend-state]', JSON.stringify({ store_id: storeId, reason: 'friend_status_refresh', is_friend: isFriend }));
    }
    res.json({
      success: true,
      is_friend: isFriend,
      friend_status: friendStatusLabel(isFriend),
      require_friend: requireFriend,
      require_follow: requireFriend,
      meets_requirement: meetsRequirement(requireFriend, isFriend),
      last_friend_check_at: (row && (row.last_friend_check_at || row.last_friend_check)) || '',
    });
  } catch (e) {
    console.error('[line-member] POST /friend-state error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/friend-conflict — H1.4.10 hotfix30-B5-R5.4-FRIEND-LIVE
// （TASK 5／FRIEND-LIVE-5：backend friend=false 但前端 liff.getFriendship()
// 這次回報 true 時的稽核紀錄）
//
// 不改變 is_friend/friend_status（那是安全判斷用的欄位，只能由 Follow／
// Unfollow Webhook 或後端自己呼叫 LINE API 驗證後才能變更），只寫一筆
// append-only 的 line_friend_events／line_member_history 紀錄，供人工／
// 後續 reverify 排查用。同樣不呼叫 logServerEvent()（不得新增 GA4/Meta 事件）。
router.post('/friend-conflict', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(storeId, `friend-conflict|${ip}`)) {
      return res.status(429).json({ success: false, reason: 'rate_limited', code: 'RATE_LIMITED' });
    }
    const { member_session, client_signal } = req.body || {};
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_member_session' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      return res.status(200).json({ success: false, reason: 'invalid_session' });
    }
    const conflictType = 'backend_false_client_true';
    if (shouldSkipConflictWrite(storeId, lineUserId, conflictType)) {
      return res.json({ success: true, data: { logged: false, deduped: true } });
    }
    const { applyFriendEvent } = require('../utils/lineFriendSync');
    const result = applyFriendEvent(db, storeId, lineUserId, {
      eventType: 'friendship_conflict_detected',
      source: 'client_liff_reconcile',
      metadata: { client_signal: (typeof client_signal === 'string' ? client_signal.slice(0, 100) : '') },
    });
    res.json({ success: true, data: { logged: true, applied: result.applied } });
  } catch (e) {
    console.error('[line-member] POST /friend-conflict error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/authoritative-friend-sync — H1.4.10
// HISTORICAL-FRIEND-FIRST-TOUCH：backfill 早於 POS 會員系統就已加入官方帳號、
// 但從未進過 LIFF 的歷史好友。Best-effort、opportunistic，絕不阻擋下單。
//
// 安全原則：
//   - 前端只送 LIFF user access token（request 結束即丟棄，不落地）。
//   - line_user_id／friend 狀態一律由後端親自向 LINE Platform 驗證後才可信，
//     不接受前端聲稱的 friend=true 或 line_user_id。
//   - Access Token 絕不寫入 log／DB／response／CRM Timeline。
//   - store 隔離依 req.storeId（來自 requireStore middleware 的驗證結果），
//     request body 的 store_id（如果有）僅作路由提示，不被信任。
//
// 與既有 Follow/Unfollow Webhook／applyFriendEvent() 的關係：
//   本 endpoint 只是 applyFriendEvent() 的另一個「事件來源」（source=
//   'historical_friend_first_touch'），沿用同一份好友狀態 SSOT，不新建
//   平行的 line_members 寫入邏輯。刻意不使用 utils/lineMemberStats.js 的
//   upsertMemberProfile()——audit 發現該函式在建立新會員且 is_friend=1 時，
//   會把 friend_since 設成「這次登入的當下時間」，對正常首次登入是合理的，
//   但對「早就加了好友、只是現在才第一次進 LIFF」的歷史好友來說，會偽造出
//   一個錯誤的「剛加入好友」時間。applyFriendEvent() 對
//   friendship_verify_true 這類事件則刻意不觸碰 friend_since（只有
//   follow/refollow 事件類型才會），符合需求文件「不得偽造歷史加入時間」。
router.post('/authoritative-friend-sync', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(storeId, `friend-sync|${ip}`)) {
      return res.status(429).json({ success: false, friend_verified: false, reason: 'RATE_LIMITED' });
    }

    const { userAccessToken } = req.body || {};
    if (!userAccessToken || typeof userAccessToken !== 'string') {
      return res.status(400).json({ success: false, friend_verified: false, reason: 'TOKEN_MISSING' });
    }

    const channelId = getSetting(db, storeId, 'line_member_login_channel_id');
    if (!channelId) {
      return res.status(400).json({ success: false, friend_verified: false, reason: 'STORE_CONFIG_MISSING' });
    }

    // ── Step 1：驗證 access token（client_id／scope，絕不信任前端自報）──
    const { verifyLineAccessToken, getLineProfile, getFriendshipStatus } = require('../utils/lineMemberAuth');
    const tokenCheck = await verifyLineAccessToken(userAccessToken, channelId);
    if (!tokenCheck.ok) {
      // 安全 fallback：一律 400 + 通用 reason，不回傳 LINE 原始回應內容，
      // 不得因此更新任何 DB 資料。
      return res.status(400).json({ success: false, friend_verified: false, reason: 'TOKEN_INVALID' });
    }

    // ── Step 2：取得 authoritative LINE userId（backend 自己向 LINE Platform 要，
    //    不是前端 liff.getProfile() 回報的值）──────────────────────────
    const profile = await getLineProfile(userAccessToken);
    if (!profile.ok) {
      return res.status(200).json({ success: false, friend_verified: false, reason: 'LINE_API_UNAVAILABLE' });
    }
    const lineUserId = profile.userId;

    // ── 已經 friend=true：不重複打 LINE Friendship API，省 quota ─────
    const existing = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    const existingIsFriend = existing ? (existing.is_friend === 1 ? true : existing.is_friend === 0 ? false : null) : null;
    if (existingIsFriend === true) {
      return res.json({ success: true, friend_verified: true, source: 'backend_current' });
    }

    // ── Step 3：向 LINE Friendship API 驗證（同一顆已驗證過的 access token）──
    const friendResult = await getFriendshipStatus(userAccessToken);
    if (!friendResult.ok) {
      // Timeout／5xx／invalid：fail-open，不建立 historical friend，不阻擋下單。
      return res.status(200).json({ success: false, friend_verified: false, reason: 'LINE_API_UNAVAILABLE' });
    }

    const { applyFriendEvent } = require('../utils/lineFriendSync');

    if (friendResult.is_friend === true) {
      // 建立／補齊 member（applyFriendEvent 本身處理「不存在就建立最小 row」、
      // 「row 存在但 unknown 就更新，不重建」兩種情況，且不偽造 friend_since）。
      let applied;
      try {
        applied = applyFriendEvent(db, storeId, lineUserId, {
          eventType: 'friendship_verify_true',
          source: 'historical_friend_first_touch',
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          metadata: { trigger: 'historical_first_touch' },
        });
      } catch (raceErr) {
        // 併發競態：另一個同時進來的請求已經先建立了這筆 row（UNIQUE
        // constraint），視為冪等成功，不視為錯誤。
        applied = { applied: true, raced: true };
      }
      return res.json({ success: true, friend_verified: true, source: 'line_platform_verified' });
    }

    // friendFlag === false：保守處理，不自動創造「已封鎖」事件。
    if (!existing) {
      // POS 本來就沒有這個人的資料，且確認不是好友 → 不建立任何 row。
      return res.json({ success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    }
    if (existingIsFriend === null) {
      // 既有 row 但好友狀態 unknown → 只更新 last_friend_check，不寫任何
      // 好友狀態轉換事件（不經過 applyFriendEvent，避免誤觸發狀態變更語意）。
      const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.run('UPDATE line_members SET last_friend_check=?, last_friend_check_at=? WHERE store_id=? AND line_user_id=?',
        [nowStr, nowStr, storeId, lineUserId]);
      return res.json({ success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    }
    // existingIsFriend === false 或衝突（DB 之前是 true，這裡不會走到此分支，
    // 因為上面 existingIsFriend===true 已經 early-return）：都不是真正的
    // conflict（DB 本來就不是 true），保守只記稽核、不改狀態。
    applyFriendEvent(db, storeId, lineUserId, {
      eventType: 'friendship_conflict_detected',
      source: 'historical_friend_first_touch',
      metadata: { trigger: 'historical_first_touch' },
    });
    return res.json({ success: true, friend_verified: false, reason: 'FRIENDSHIP_CONFLICT' });
  } catch (e) {
    console.error('[line-member] POST /authoritative-friend-sync error:', e.message);
    // Fail-open：任何未預期例外都不得讓下單流程受影響。
    res.status(200).json({ success: false, friend_verified: false, reason: 'LINE_API_UNAVAILABLE' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members — 後台會員列表
// ══════════════════════════════════════════════════════════════════
router.get('/members', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { filter, sort, q, limit = 50, offset = 0, friend_status, crm_status } = req.query;

    const where = ['store_id=?'];
    const params = [storeId];
    // fix18-10-hotfix26-F8（需求文件十九）：預設列表不出現已封存會員，
    // 需明確傳 crm_status=archived 或 all 才會看到（向下相容：舊資料 crm_status
    // 欄位預設值就是 'active'，既有會員不受影響）。
    if (crm_status === 'archived') where.push("crm_status='archived'");
    else if (crm_status !== 'all') where.push("COALESCE(crm_status,'active')='active'");
    if (q && String(q).trim()) {
      where.push('display_name LIKE ?');
      params.push('%' + String(q).trim().slice(0, 100) + '%');
    }
    // fix18-10-hotfix26（需求文件十三）：好友狀態三態篩選，與既有 filter／q／sort／
    // 分頁／store_id 隔離可同時使用（獨立於既有 filter 的 friend/not_friend，
    // 保留舊參數相容，不刪除既有行為）。
    switch (friend_status) {
      case 'friend': where.push('is_friend=1'); break;
      case 'non_friend': where.push('is_friend=0'); break;
      case 'unknown': where.push('is_friend IS NULL'); break;
      case 'all': default: break;
    }
    switch (filter) {
      case 'friend': where.push('is_friend=1'); break;
      case 'not_friend': where.push('(is_friend=0 OR is_friend IS NULL)'); break;
      case 'blocked': where.push('is_blocked=1'); break;
      case 'unblocked': where.push("is_blocked=0 AND friend_since!=''"); break;
      case 'logged_in_no_purchase': where.push("first_purchase_at=''"); break;
      case 'first_buyer': where.push("first_purchase_at!='' AND order_count<=1"); break;
      case 'repeat_buyer': where.push('order_count>1'); break;
      case 'inactive_30d': where.push("last_order_at!='' AND julianday('now','localtime')-julianday(last_order_at) >= 30"); break;
      case 'inactive_90d': where.push("last_order_at!='' AND julianday('now','localtime')-julianday(last_order_at) >= 90"); break;
      case 'high_ltv': where.push('lifetime_value >= (SELECT COALESCE(AVG(lifetime_value),0) FROM line_members WHERE store_id=?)'); params.push(storeId); break;
      default: break;
    }

    let orderBy = 'last_seen_at DESC';
    switch (sort) {
      case 'last_order': orderBy = 'last_order_at DESC'; break;
      case 'total_spent': orderBy = 'total_spent DESC'; break;
      case 'order_count': orderBy = 'order_count DESC'; break;
      case 'ltv': orderBy = 'lifetime_value DESC'; break;
      case 'last_login': default: orderBy = 'last_seen_at DESC'; break;
    }

    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    const rows = db.all(
      `SELECT * FROM line_members WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );
    const totalRow = db.get(`SELECT COUNT(*) c FROM line_members WHERE ${where.join(' AND ')}`, params) || {};

    const data = rows.map(r => {
      const lifecycle = computeLifecycleStage(r);
      return {
        line_user_id_masked: maskLineUserId(r.line_user_id),
        line_user_id_ref: r.id, // 內部參照用（詳情頁用 id，不外洩真實 LINE User ID）
        display_name: r.display_name,
        picture_url: r.picture_url,
        is_friend: r.is_friend,
        friend_status: friendStatusLabel(r.is_friend),
        is_blocked: r.is_blocked,
        friend_since: r.friend_since,
        last_login_at: r.last_login_at,
        last_friend_check: r.last_friend_check,
        last_friend_check_at: r.last_friend_check,
        friend_source: r.friend_source || '',
        first_touch_source: r.first_touch_source,
        last_touch_source: r.last_touch_source,
        first_order_at: r.first_order_at,
        last_order_at: r.last_order_at,
        order_count: r.order_count,
        total_spent: r.total_spent,
        lifetime_value: r.lifetime_value,
        lifecycle_stage: lifecycle.stage,
        inactive: lifecycle.inactive,
      };
    });

    res.json({ success: true, data, total: Number(totalRow.c || 0), limit: lim, offset: off });
  } catch (e) {
    console.error('[line-member] GET /members error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members/export — CSV 匯出（遮罩 LINE User ID，不含 Token）
// ══════════════════════════════════════════════════════════════════
router.get('/members/export', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all('SELECT * FROM line_members WHERE store_id=? ORDER BY last_seen_at DESC', [storeId]);
    const header = ['顯示名稱','LINE User ID(遮罩)','是否好友','是否封鎖','加入好友日期','最後登入','首次來源','最後來源','首次購買','最後購買','訂單數','累積消費','LTV'];
    // fix18-10-hotfix23-E1：每個欄位都經過 sanitizeCsvCell()，防止 CSV Formula Injection。
    const csvRows = [header.map(sanitizeCsvCell).join(',')];
    rows.forEach(r => {
      const cells = [
        r.display_name || '', maskLineUserId(r.line_user_id),
        r.is_friend === 1 ? '是' : (r.is_friend === 0 ? '否' : '未知'),
        r.is_blocked ? '是' : '否',
        r.friend_since || '', r.last_login_at || '',
        r.first_touch_source || '', r.last_touch_source || '',
        r.first_order_at || '', r.last_order_at || '',
        r.order_count || 0, r.total_spent || 0, r.lifetime_value || 0,
      ].map(sanitizeCsvCell);
      csvRows.push(cells.join(','));
    });
    const csv = '\uFEFF' + csvRows.join('\n'); // BOM 讓 Excel 正確辨識 UTF-8
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="line-members-${dateStr}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[line-member] GET /members/export error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members/:id — 會員詳細頁（:id 為 line_members.id，不是 LINE User ID）
// ══════════════════════════════════════════════════════════════════
router.get('/members/:id', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const row = db.get('SELECT * FROM line_members WHERE store_id=? AND id=?', [storeId, req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: '找不到會員' });

    const history = db.all(
      `SELECT event_name, old_value, new_value, metadata_json, created_at
       FROM line_member_history WHERE store_id=? AND line_user_id=? ORDER BY created_at DESC LIMIT 100`,
      [storeId, row.line_user_id]
    );
    const lifecycle = computeLifecycleStage(row);
    const avgOrderValue = row.order_count > 0 ? round(row.total_spent / row.order_count) : 0;

    // fix18-10-hotfix26（需求文件十五／A6）：官方帳號要求 × 是否符合要求。
    // 未知一律不能顯示成「符合」或「不符合」，只能顯示「無法確認」（null）。
    // 統一用 module-level meetsRequirement() 回傳 true/false/null，與 verify
    // API 回應格式一致，不再用局部字串 'yes'/'no'/'unknown'（避免前端要處理
    // 兩套不同的值域）。
    const requireFriend = getSetting(db, storeId, 'line_member_require_friend') === '1';
    const meetsReq = meetsRequirement(requireFriend, row.is_friend);

    res.json({
      success: true,
      data: {
        line_user_id_masked: maskLineUserId(row.line_user_id),
        display_name: row.display_name, picture_url: row.picture_url,
        is_friend: row.is_friend, friend_status: friendStatusLabel(row.is_friend), is_blocked: row.is_blocked,
        friend_since: row.friend_since, last_login_at: row.last_login_at,
        last_friend_check: row.last_friend_check, last_friend_check_at: row.last_friend_check,
        friend_source: row.friend_source || '', friend_status_changed_at: row.friend_status_changed_at || '',
        require_friend: requireFriend, require_follow: requireFriend, meets_requirement: meetsReq,
        first_touch_source: row.first_touch_source, first_touch_campaign: row.first_touch_campaign,
        last_touch_source: row.last_touch_source, last_touch_campaign: row.last_touch_campaign,
        first_product_id: row.first_product_id, first_cart_at: row.first_cart_at,
        first_purchase_at: row.first_purchase_at, last_purchase_at: row.last_purchase_at,
        order_count: row.order_count, total_spent: row.total_spent, lifetime_value: row.lifetime_value,
        avg_order_value: avgOrderValue,
        lifecycle_stage: lifecycle.stage, inactive: lifecycle.inactive,
        timeline: history,
        // fix18-10-hotfix26-F8（需求文件十七）：好友事件摘要欄位
        friend_status_f8: row.friend_status || 'unknown',
        first_follow_at: row.first_follow_at || '',
        last_follow_at: row.last_follow_at || '',
        last_unfollow_at: row.last_unfollow_at || '',
        last_refollow_at: row.last_refollow_at || '',
        refollow_count: row.refollow_count || 0,
        last_friend_source: row.last_friend_source || '',
        last_friend_check_at: row.last_friend_check_at || '',
        // fix18-10-hotfix26-F8（需求文件十九）：封存狀態
        crm_status: row.crm_status || 'active',
        archived_at: row.archived_at || '',
        archived_reason: row.archived_reason || '',
        member_source: row.member_source || 'line_login',
        phone: row.phone || '', email: row.email || '', note: row.note || '', tags: row.tags || '',
      },
    });
  } catch (e) {
    console.error('[line-member] GET /members/:id error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── fix18-10-hotfix26-F8（需求文件十八）：手動重新確認好友狀態 ──────────────
// LINE Messaging API 沒有「查詢任意 userId 好友關係」的公開 API；官方建議做法
// 是呼叫 GET /v2/bot/profile/{userId}：200 代表目前是好友，403/404 代表非好友
// 或已封鎖。這裡沿用 utils/lineFriendSync.js 的統一寫入邏輯，來源標記為
// manual_verify，時間戳仍走「較新優先」規則，不會覆蓋更新的 webhook 事件。
router.post('/members/:id/reverify', requireStaffJwt, async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const row = db.get('SELECT id, line_user_id FROM line_members WHERE store_id=? AND id=?', [storeId, req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: '找不到會員' });
    if (!row.line_user_id) return res.status(400).json({ success: false, message: '此會員尚未綁定 LINE，無法驗證好友狀態' });

    const channelToken = getSetting(db, storeId, 'line_channel_token', '');
    if (!channelToken) return res.status(400).json({ success: false, message: '尚未設定 LINE Channel Access Token' });

    let isFriend = null;
    try {
      const resp = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(row.line_user_id)}`, {
        headers: { Authorization: `Bearer ${channelToken}` },
      });
      if (resp.status === 200) isFriend = true;
      else if (resp.status === 403 || resp.status === 404) isFriend = false;
      // 其他狀態碼（如 429/5xx）視為暫時無法確認，不寫入事件、不誤判
    } catch (e) {
      console.warn('[line-member] reverify profile fetch failed:', e.message);
    }

    if (isFriend === null) {
      return res.status(502).json({ success: false, message: '暫時無法向 LINE 確認好友狀態，請稍後再試' });
    }

    const { applyFriendEvent } = require('../utils/lineFriendSync');
    const result = applyFriendEvent(db, storeId, row.line_user_id, {
      eventType: isFriend ? 'manual_verify_true' : 'manual_verify_false',
      source: 'manual_verify',
    });
    res.json({ success: true, data: { is_friend: isFriend, applied: result.applied } });
  } catch (e) {
    console.error('[line-member] reverify error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── fix18-10-hotfix26-F8（需求文件十九）：封存會員（取代直接刪除）───────────
router.post('/members/:id/archive', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const row = db.get('SELECT id, line_user_id, crm_status FROM line_members WHERE store_id=? AND id=?', [storeId, req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: '找不到會員' });
    if (row.crm_status === 'archived') return res.json({ success: true, data: { already_archived: true } });

    const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 500) : '';
    const operator = (req.staff && req.staff.username) || (req.staff && req.staff.id) || 'admin';
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.run(
      `UPDATE line_members SET crm_status='archived', archived_at=?, archived_reason=?, archived_by=? WHERE store_id=? AND id=?`,
      [now, reason, String(operator), storeId, req.params.id]
    );
    // 不刪訂單、Analytics、優惠券紀錄、好友事件、UID（需求文件十九）——這裡完全不動其他表。
    db.run(
      `INSERT INTO line_member_history (store_id, line_user_id, event_name, old_value, new_value, metadata_json)
       VALUES (?,?,?,?,?,?)`,
      [storeId, row.line_user_id, 'member_archived', 'active', 'archived', JSON.stringify({ reason, operator })]
    );
    res.json({ success: true, data: { crm_status: 'archived', archived_at: now } });
  } catch (e) {
    console.error('[line-member] archive error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── fix18-10-hotfix26-F8（需求文件二十）：恢復會員 ─────────────────────────
router.post('/members/:id/restore', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const row = db.get('SELECT id, line_user_id, crm_status FROM line_members WHERE store_id=? AND id=?', [storeId, req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: '找不到會員' });
    if (row.crm_status !== 'archived') return res.json({ success: true, data: { already_active: true } });

    db.run(
      `UPDATE line_members SET crm_status='active', archived_at='', archived_reason='', archived_by='' WHERE store_id=? AND id=?`,
      [storeId, req.params.id]
    );
    db.run(
      `INSERT INTO line_member_history (store_id, line_user_id, event_name, old_value, new_value, metadata_json)
       VALUES (?,?,?,?,?,?)`,
      [storeId, row.line_user_id, 'member_restored', 'archived', 'active', '{}']
    );
    res.json({ success: true, data: { crm_status: 'active' } });
  } catch (e) {
    console.error('[line-member] restore error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

module.exports = router;
// fix18-10-hotfix26-A：把純函式掛在 router 物件上，只供 scripts/smoke-hotfix26-a.js
// 做單元測試用，不影響 app.use(require('./routes/line-member')) 的既有掛載方式
// （express Router 本身是 function，可以安全附加額外屬性）。
router._test = { normalizeFriendFlag, friendStatusLabel, meetsRequirement, verifyCodeRecoverable, verifyCodeAction, tokenFingerprint };
