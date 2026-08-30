// utils/cartRecoveryConsent.js
// H1.4.10 Phase 4B — Cart Recovery Consent（同意透過 LINE 提醒）
//
// 這是 Recovery eligibility 的第一道、也是最重要的一道關卡：Recovery Job
// 存在不代表可以 Push；只有顧客主動勾選同意，且該同意是透過已驗證的
// member_session 才能取得可信 line_user_id，才有可能進入 eligibility 判斷。
//
// 四件事必須分開（見 Reality Audit）：
//   1. LINE 身分辨識（Phase 1 member_session／verifyMemberSession）
//   2. 加入官方好友（Phase 2 friend_entry／friend_checkout，只是引導）
//   3. Recovery consent（這支模組，顧客主動勾選）
//   4. 實際 Push（utils/linePush.js + eligibility engine）
//
// 這支模組完全不呼叫 LINE API、不做 eligibility 判斷，只負責
// cart_recovery_consents 這張表的 CRUD。

'use strict';

function _safe(fn, fallback) {
  try { return fn(); } catch (e) {
    console.warn('[cartRecoveryConsent] fail-open:', e.message);
    return fallback;
  }
}
function _nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * grantConsent(db, storeId, { cartId, visitorId, sessionId, lineUserId, source })
 *
 * 呼叫端必須已經用 verifyMemberSession() 驗證過 member_session，這裡的
 * lineUserId 必須是驗證結果，絕不是前端直接提供的值——這支函式本身不做
 * 驗證，信任邊界的責任在呼叫端（routes/cart-recovery.js）。
 *
 * UNIQUE(store_id, cart_id)：同一購物車只會有一筆 consent row，重複呼叫
 * upsert 即可（不會產生第二筆）。
 */
function grantConsent(db, storeId, { cartId, visitorId = '', sessionId = '', lineUserId, source = 'checkbox' }) {
  return _safe(() => {
    if (!storeId || !cartId || !lineUserId) return { success: false, reason: 'missing_required_fields' };
    const now = _nowIso();
    const existing = db.get('SELECT id FROM cart_recovery_consents WHERE store_id=? AND cart_id=?', [storeId, cartId]);
    if (existing) {
      db.run(
        `UPDATE cart_recovery_consents SET
           visitor_id=?, session_id=?, line_user_id=?, status='granted',
           consent_text_version='v1', source=?, granted_at=?, revoked_at='', updated_at=?
         WHERE id=?`,
        [visitorId, sessionId, lineUserId, source, now, now, existing.id]
      );
    } else {
      db.run(
        `INSERT INTO cart_recovery_consents
          (store_id, cart_id, visitor_id, session_id, line_user_id, status,
           consent_text_version, source, granted_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeId, cartId, visitorId, sessionId, lineUserId, 'granted', 'v1', source, now, now, now]
      );
    }
    // 需求文件七：grant 後可安全補綁同 cart 的 recovery job line_user_id，
    // 只用這裡已驗證過的 lineUserId，絕不使用其他來源。
    db.run(
      `UPDATE cart_recovery_jobs SET line_user_id=?, updated_at=? WHERE store_id=? AND cart_id=? AND (line_user_id IS NULL OR line_user_id='')`,
      [lineUserId, now, storeId, cartId]
    );
    return { success: true };
  }, { success: false, reason: 'exception' });
}

/**
 * revokeConsent(db, storeId, { cartId })
 *
 * 不刪除 row（保留 audit history），只把 status 改成 revoked。
 */
function revokeConsent(db, storeId, { cartId }) {
  return _safe(() => {
    if (!storeId || !cartId) return { success: false, reason: 'missing_required_fields' };
    const now = _nowIso();
    const existing = db.get('SELECT id FROM cart_recovery_consents WHERE store_id=? AND cart_id=?', [storeId, cartId]);
    if (!existing) {
      // 沒有 grant 過就 revoke：視為成功（結果一致，都是「沒有有效同意」），
      // 不需要報錯。
      return { success: true, reason: 'no_existing_consent' };
    }
    db.run(
      `UPDATE cart_recovery_consents SET status='revoked', revoked_at=?, updated_at=? WHERE id=?`,
      [now, now, existing.id]
    );
    return { success: true };
  }, { success: false, reason: 'exception' });
}

/**
 * getConsentStatus(db, storeId, cartId) → 'granted' | 'revoked' | 'none'
 */
function getConsentStatus(db, storeId, cartId) {
  return _safe(() => {
    if (!storeId || !cartId) return 'none';
    const row = db.get('SELECT status FROM cart_recovery_consents WHERE store_id=? AND cart_id=?', [storeId, cartId]);
    return row ? row.status : 'none';
  }, 'none');
}

function hasValidConsent(db, storeId, cartId) {
  return getConsentStatus(db, storeId, cartId) === 'granted';
}

module.exports = { grantConsent, revokeConsent, getConsentStatus, hasValidConsent };
