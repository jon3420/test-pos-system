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

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const LINE_FRIENDSHIP_URL = 'https://api.line.me/friendship/v1/status';

// 驗證 LINE ID Token（LIFF 登入後前端取得的 id_token）。
// 依 LINE 官方文件：POST id_token + client_id(=Channel ID) 到 /oauth2/v2.1/verify，
// 回傳內容包含 sub（= line_user_id）、aud（= Channel ID）、exp 等欄位，皆由 LINE
// 伺服器簽發並驗證，不需要專案自行做 JWT 簽章驗證。
async function verifyLineIdToken(idToken, channelId) {
  if (!idToken || !channelId) {
    return { ok: false, reason: 'missing_params', message: '缺少 id_token 或 channel_id' };
  }
  try {
    const body = new URLSearchParams({ id_token: String(idToken), client_id: String(channelId) });
    const res = await fetch(LINE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeout: 8000,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return { ok: false, reason: 'verify_failed', message: 'LINE Token 驗證失敗' };
    }
    // aud 必須等於店家自己的 LINE Login Channel ID（需求文件六第 2 點）
    if (String(data.aud || '') !== String(channelId)) {
      return { ok: false, reason: 'aud_mismatch', message: 'Token 對應的 Channel 不符' };
    }
    // exp 由 LINE 簽發，若已過期直接拒絕
    const nowSec = Math.floor(Date.now() / 1000);
    if (data.exp && Number(data.exp) < nowSec) {
      return { ok: false, reason: 'expired', message: 'Token 已過期，請重新登入' };
    }
    if (!data.sub) {
      return { ok: false, reason: 'no_sub', message: 'Token 未包含使用者識別碼' };
    }
    return {
      ok: true,
      line_user_id: String(data.sub),
      display_name: data.name ? String(data.name).slice(0, 200) : '',
      picture_url: data.picture ? String(data.picture).slice(0, 500) : '',
    };
  } catch (e) {
    console.warn('[lineMemberAuth] verifyLineIdToken error:', e.message);
    return { ok: false, reason: 'exception', message: 'LINE Token 驗證發生錯誤' };
  }
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

module.exports = { verifyLineIdToken, getFriendshipStatus };
