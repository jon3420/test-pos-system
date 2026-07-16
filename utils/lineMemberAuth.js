// utils/lineMemberAuth.js — fix18-10-hotfix23-E｜LINE 會員入口
//
// 負責與 LINE 平台溝通的兩件事：
//   1. verifyLineIdToken()：呼叫 LINE 官方 /oauth2/v2.1/verify 驗證 ID Token
//      （驗證 aud/iss/exp，取得可信的 line_user_id，不信任前端傳入的值）
//   2. getFriendshipStatus()：呼叫 LINE Messaging API 好友關係 API，若店家
//      未設定 Channel Access Token 或呼叫失敗，一律安全 fallback 回傳
//      is_friend=null，不阻擋點餐流程。
//
// 安全原則（需求文件六／十八）：
//   - Access Token／ID Token 絕不寫入 log。
//   - Channel Secret 只在後端使用，不回傳前端。
//   - 任何呼叫失敗都不得讓呼叫端 500（呼叫端自行 try/catch，這裡只回傳
//     結構化的成功/失敗結果）。

'use strict';
const fetch = require('node-fetch');
const { maskLineUserId } = require('./lineMemberStats');

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const LINE_FRIENDSHIP_URL = 'https://api.line.me/friendship/v1/status';

// fix18-10-hotfix26-verify-deep（需求文件全篇）：LINE_MEMBER_DEBUG=1 才會輸出
// 任何深度診斷內容（console log 與 verify() 回傳值裡的 `debug` 欄位）。預設
// （未設定或非 '1'）完全不計算/不輸出，正式環境行為與過去完全相同。
function isVerifyDebugEnabled() {
  return process.env.LINE_MEMBER_DEBUG === '1';
}

// 把 node-fetch 的 Headers 轉成純物件，方便 log／回傳（LINE 回應的 header 本身
// 不含我方任何 token/secret，只是標準 HTTP header，例如 content-type/date）。
function headersToObject(headers) {
  const out = {};
  try { for (const [k, v] of headers.entries()) out[k] = v; } catch (e) { /* ignore */ }
  return out;
}

// fix18-10-hotfix26-verify-debug（需求文件十一）：把「為什麼失敗」分類成固定的
// code，純粹供診斷／debug 使用，不改變既有 ok/reason/message 的行為與既有呼叫端
// 邏輯——呼叫端本來就只看 ok/reason/message，新增的 code 是額外欄位。
//
// 可用 code 值：
//   MISSING_ID_TOKEN, MISSING_ACCESS_TOKEN, INVALID_ID_TOKEN,
//   INVALID_ID_TOKEN_AUDIENCE, EXPIRED_ID_TOKEN, INVALID_ISSUER,
//   LINE_VERIFY_API_FAILED, LINE_PROFILE_API_FAILED, CHANNEL_ID_MISMATCH,
//   STORE_CONFIG_MISSING, INVALID_STORE, NETWORK_TIMEOUT, UNKNOWN_VERIFY_ERROR
//
// 絕不在這裡輸出 token 內容、stack、secret。
function classifyVerifyApiFailure(resOk, httpStatus, data) {
  // data 為 null：LINE 回應不是合法 JSON（少見，但仍要能分類，不當機）
  if (!data) {
    return { code: httpStatus >= 500 ? 'LINE_VERIFY_API_FAILED' : 'INVALID_ID_TOKEN', message: 'LINE Token 驗證失敗' };
  }
  // LINE 官方 /oauth2/v2.1/verify 失敗時通常回傳 { error, error_description }
  const desc = String(data.error_description || data.error || '').toLowerCase();
  if (httpStatus >= 500) return { code: 'LINE_VERIFY_API_FAILED', message: 'LINE Token 驗證失敗' };
  if (/expired/.test(desc)) return { code: 'EXPIRED_ID_TOKEN', message: 'LINE Token 驗證失敗' };
  if (/aud|audience|client_id|channel/.test(desc)) return { code: 'INVALID_ID_TOKEN_AUDIENCE', message: 'LINE Token 驗證失敗' };
  return { code: 'INVALID_ID_TOKEN', message: 'LINE Token 驗證失敗' };
}
function classifyVerifyException(e) {
  // node-fetch v2 逾時會丟出 FetchError，type 為 'request-timeout'
  if (e && (e.type === 'request-timeout' || e.name === 'AbortError' || /timeout/i.test(String(e.message || '')))) {
    return { code: 'NETWORK_TIMEOUT', message: 'LINE Token 驗證發生錯誤' };
  }
  return { code: 'UNKNOWN_VERIFY_ERROR', message: 'LINE Token 驗證發生錯誤' };
}

// fix18-10-hotfix26-verify-debug：把 aud 比對／exp 過期判斷抽成具名的純函式
// （邏輯與原本寫在 verifyLineIdToken() 內完全相同，只是抽出來方便 smoke test
// 直接驗證，不需要真的打 LINE API）。這兩個判斷都是「原始字串直接比較」，
// 如果 Channel ID 設定值前後有多餘空白字元，會導致 aud 比對失敗（見 Debug
// Report 根因分析）。
function isAudienceMatch(dataAud, channelId) {
  return String(dataAud || '') === String(channelId);
}
function isTokenExpired(exp) {
  if (!exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Number(exp) < nowSec;
}

// 驗證 LINE ID Token（LIFF 登入後前端取得的 id_token）。
// 依 LINE 官方文件：POST id_token + client_id(=Channel ID) 到 /oauth2/v2.1/verify，
// 回傳內容包含 sub（= line_user_id）、aud（= Channel ID）、exp 等欄位，皆由 LINE
// 伺服器簽發並驗證，不需要專案自行做 JWT 簽章驗證。
async function verifyLineIdToken(idToken, channelId) {
  const debugOn = isVerifyDebugEnabled();

  if (!idToken || !channelId) {
    const result = {
      ok: false, reason: 'missing_params', message: '缺少 id_token 或 channel_id',
      code: !idToken ? 'MISSING_ID_TOKEN' : 'STORE_CONFIG_MISSING',
    };
    if (debugOn) {
      result.debug = {
        request: { endpoint: LINE_VERIFY_URL, store_channel_id: channelId || null, id_token_present: !!idToken, id_token_length: idToken ? String(idToken).length : 0 },
      };
      console.log('[lineMemberAuth][VERIFY-DEBUG] missing params, no request sent:', JSON.stringify(result.debug));
    }
    return result;
  }

  // ── 一、Verify Request（需求文件二）──────────────────────────
  if (debugOn) {
    console.log('[lineMemberAuth][VERIFY-DEBUG] Verify Request', JSON.stringify({
      store_channel_id: channelId,
      client_id: channelId, // LINE API 送出的 client_id 參數，與 store_channel_id 相同來源，並列方便核對
      id_token_present: true,
      id_token_length: String(idToken).length,
      endpoint: LINE_VERIFY_URL,
    }));
  }

  const requestStartedAt = Date.now();
  try {
    const body = new URLSearchParams({ id_token: String(idToken), client_id: String(channelId) });
    const res = await fetch(LINE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeout: 8000,
    });
    const elapsedMs = Date.now() - requestStartedAt;

    // ── 二、Verify Response（需求文件三／四）──────────────────────
    // 先拿 raw text，絕不直接 res.json()——json() 失敗時原始內容會遺失，
    // 之後想知道 LINE 到底回了什麼字串就再也拿不到了。
    const rawBody = await res.text();
    let data = null;
    let jsonParsed = false;
    try { data = JSON.parse(rawBody); jsonParsed = true; } catch (e) { data = null; jsonParsed = false; }

    if (debugOn) {
      console.log('[lineMemberAuth][VERIFY-DEBUG] Verify Response', JSON.stringify({
        http_status: res.status,
        headers: headersToObject(res.headers),
        elapsed_ms: elapsedMs,
        json_parsed: jsonParsed,
        raw_body: rawBody,
      }));
    }

    if (!res.ok || !data) {
      const cls = classifyVerifyApiFailure(res.ok, res.status, data);
      const result = {
        ok: false, reason: 'verify_failed', message: 'LINE Token 驗證失敗',
        code: cls.code, http_status: res.status,
      };
      if (debugOn) {
        result.debug = buildVerifyDebugObject({
          channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs,
          code: cls.code,
        });
        console.log('[lineMemberAuth][VERIFY-DEBUG] classification', JSON.stringify({
          verify_api_status: res.status,
          verify_api_error: data && data.error || null,
          verify_api_error_description: data && data.error_description || null,
          code: cls.code,
        }));
      }
      return result;
    }

    // ── 五／六／七／八：完整分類、aud／exp／claims 比對（僅 debug 用，
    //    不影響下面實際判斷邏輯，判斷仍用原本未 trim 的 isAudienceMatch／
    //    isTokenExpired）───────────────────────────────────────────
    if (debugOn) {
      const dbg = buildVerifyDebugObject({ channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs, code: null });
      console.log('[lineMemberAuth][VERIFY-DEBUG] audience_check', JSON.stringify(dbg.audience_check));
      console.log('[lineMemberAuth][VERIFY-DEBUG] expiry_check', JSON.stringify(dbg.expiry_check));
      console.log('[lineMemberAuth][VERIFY-DEBUG] claims', JSON.stringify(dbg.claims));
    }

    // aud 必須等於店家自己的 LINE Login Channel ID（需求文件六第 2 點）
    // 注意：這裡刻意「不」改成 trim 過的比較——本輪禁止修改判斷邏輯，
    // debug 只負責證明、不負責自動修正。
    if (!isAudienceMatch(data.aud, channelId)) {
      const result = { ok: false, reason: 'aud_mismatch', message: 'Token 對應的 Channel 不符', code: 'CHANNEL_ID_MISMATCH' };
      if (debugOn) result.debug = buildVerifyDebugObject({ channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs, code: 'CHANNEL_ID_MISMATCH' });
      return result;
    }
    // exp 由 LINE 簽發，若已過期直接拒絕
    if (isTokenExpired(data.exp)) {
      const result = { ok: false, reason: 'expired', message: 'Token 已過期，請重新登入', code: 'EXPIRED_ID_TOKEN' };
      if (debugOn) result.debug = buildVerifyDebugObject({ channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs, code: 'EXPIRED_ID_TOKEN' });
      return result;
    }
    if (!data.sub) {
      const result = { ok: false, reason: 'no_sub', message: 'Token 未包含使用者識別碼', code: 'LINE_VERIFY_API_FAILED' };
      if (debugOn) result.debug = buildVerifyDebugObject({ channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs, code: 'LINE_VERIFY_API_FAILED' });
      return result;
    }
    const okResult = {
      ok: true,
      line_user_id: String(data.sub),
      display_name: data.name ? String(data.name).slice(0, 200) : '',
      picture_url: data.picture ? String(data.picture).slice(0, 500) : '',
    };
    if (debugOn) okResult.debug = buildVerifyDebugObject({ channelId, idToken, endpoint: LINE_VERIFY_URL, res, rawBody, data, jsonParsed, elapsedMs, code: null });
    return okResult;
  } catch (e) {
    console.warn('[lineMemberAuth] verifyLineIdToken error:', e.message);
    const cls = classifyVerifyException(e);
    const result = { ok: false, reason: 'exception', message: 'LINE Token 驗證發生錯誤', code: cls.code };
    if (debugOn) {
      // 需求文件九：例外細節（name/message/code/type/cause）。stack 只印到伺服器
      // console，絕不放進回傳值（回傳值理論上可能再往上一路傳到 HTTP response，
      // 放 stack 進去等於把伺服器路徑洩漏出去，即使是 debug 模式也不允許）。
      const exceptionInfo = {
        name: e && e.name, message: e && e.message, code: e && e.code || null,
        type: e && e.type || null, cause: e && e.cause ? String(e.cause) : null,
        classified_code: cls.code,
      };
      result.debug = { exception: exceptionInfo };
      console.log('[lineMemberAuth][VERIFY-DEBUG] exception', JSON.stringify(exceptionInfo));
      console.log('[lineMemberAuth][VERIFY-DEBUG] exception stack (console only, never in response):', e && e.stack);
    }
    return result;
  }
}

// fix18-10-hotfix26-verify-deep：組出完整 debug 物件（request／response／
// 分類／aud 比對／exp 比對／claims），只在 verifyLineIdToken 內部於
// LINE_MEMBER_DEBUG=1 時呼叫。sub 一律用 maskLineUserId() 遮罩，不論任何情況
// 都不輸出完整 LINE User ID；id_token 本身只給 present/length，不給內容。
function buildVerifyDebugObject({ channelId, idToken, endpoint, res, rawBody, data, jsonParsed, elapsedMs, code }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const channelIdRaw = String(channelId);
  const channelIdTrimmed = channelIdRaw.trim();
  return {
    request: {
      endpoint,
      store_channel_id: channelIdRaw,
      client_id: channelIdRaw,
      id_token_present: true,
      id_token_length: String(idToken).length,
    },
    response: {
      http_status: res.status,
      headers: headersToObject(res.headers),
      raw_body: rawBody,
      json_parsed: jsonParsed,
      parsed: data,
      elapsed_ms: elapsedMs,
    },
    classification: {
      verify_api_status: res.status,
      verify_api_error: (data && data.error) || null,
      verify_api_error_description: (data && data.error_description) || null,
      code: code || null,
    },
    // 需求文件六：完整比對 aud，含 trim 前／trim 後／length，證明是否有隱藏空白，
    // 但這裡只是「證明」，match_if_trimmed 純供人工判讀，不影響實際驗證流程。
    audience_check: {
      line_aud: (data && data.aud) || null,
      db_channel_id_before_trim: channelIdRaw,
      db_channel_id_before_trim_length: channelIdRaw.length,
      db_channel_id_after_trim: channelIdTrimmed,
      db_channel_id_after_trim_length: channelIdTrimmed.length,
      match_raw: isAudienceMatch(data && data.aud, channelIdRaw),
      match_if_trimmed_proof_only: isAudienceMatch(data && data.aud, channelIdTrimmed),
    },
    expiry_check: {
      exp: (data && data.exp) || null,
      now_utc: nowSec,
      remaining_seconds: (data && data.exp) ? (Number(data.exp) - nowSec) : null,
      is_expired: isTokenExpired(data && data.exp),
    },
    claims: {
      iss: (data && data.iss) || null,
      sub_masked: (data && data.sub) ? maskLineUserId(data.sub) : null,
      aud: (data && data.aud) || null,
      nonce: (data && data.nonce) || null,
      amr: (data && data.amr) || null,
      exp: (data && data.exp) || null,
    },
  };
}

// 查詢好友狀態。優先用 LINE Login 取得的 access_token（使用者授權範圍需含
// profile；好友關係 API 只需該 access_token，不需要 Messaging API Channel
// Access Token）。若查詢失敗，安全 fallback 回傳 is_friend=null，不視為已加好友，
// 也不阻擋點餐（由呼叫端依「強制好友模式」規則決定要不要擋）。
async function getFriendshipStatus(accessToken) {
  if (!accessToken) return { ok: false, is_friend: null };
  try {
    const res = await fetch(LINE_FRIENDSHIP_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 8000,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data.friendFlag !== 'boolean') {
      return { ok: false, is_friend: null };
    }
    return { ok: true, is_friend: !!data.friendFlag };
  } catch (e) {
    console.warn('[lineMemberAuth] getFriendshipStatus error:', e.message);
    return { ok: false, is_friend: null };
  }
}

module.exports = {
  verifyLineIdToken, getFriendshipStatus,
  classifyVerifyApiFailure, classifyVerifyException, isAudienceMatch, isTokenExpired,
  isVerifyDebugEnabled, headersToObject, buildVerifyDebugObject,
};
