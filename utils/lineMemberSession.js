// utils/lineMemberSession.js — fix18-10-hotfix23-E｜LINE 會員入口
//
// 訂單建立等需要「已驗證的 line_user_id」的端點，一律要求前端傳入這裡簽發的
// member_session，不接受前端直接傳 line_user_id（需求文件五：安全 Member
// Session）。做法：短效、伺服器端 HMAC 簽章的 token，內容只有
// store_id + line_user_id + issued_at + expires_at，前端無法偽造或竄改。
//
// 沿用專案既有 JWT_SECRET（middleware/storeGuard.js 已使用同一組環境變數），
// 不新增第二套 Secret 管理機制。

'use strict';
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 小時

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// 建立短效簽章 session。回傳字串 token，格式：base64url(payload).base64url(hmac)
function createMemberSession({ store_id, line_user_id, ttl_ms }) {
  if (!store_id || !line_user_id) return null;
  const now = Date.now();
  const payload = {
    store_id: String(store_id),
    line_user_id: String(line_user_id),
    issued_at: now,
    expires_at: now + (ttl_ms || DEFAULT_TTL_MS),
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64url(payloadStr);
  const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest();
  const sigB64 = b64url(sig);
  return `${payloadB64}.${sigB64}`;
}

// 驗證 session：簽章正確、未過期、store_id 與呼叫端目前的 store_id 相符，
// 才回傳可信的 line_user_id；任何一項不符一律回傳 null（安全 fallback，
// 不得讓呼叫端因驗證例外而 500）。
function verifyMemberSession(token, expectedStoreId) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    const expectedSig = b64url(crypto.createHmac('sha256', SECRET).update(payloadB64).digest());
    // 固定長度比較，避免 timing attack
    const a = Buffer.from(sigB64);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (!payload || !payload.line_user_id || !payload.store_id) return null;
    if (Date.now() > Number(payload.expires_at || 0)) return null;
    if (String(payload.store_id) !== String(expectedStoreId)) return null;
    return payload.line_user_id;
  } catch (e) {
    return null;
  }
}

module.exports = { createMemberSession, verifyMemberSession };
