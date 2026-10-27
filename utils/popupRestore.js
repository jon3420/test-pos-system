// utils/popupRestore.js — H1.4.12 Phase 3B（Popup Recovery Cart
// Restore／Reconcile — Corrective Increment，經核准的兩階段設計）
//
// prepare → fresh reconcile → 回傳 canonical cart（token 仍 opened）
// client 成功保存 cart
// commit → receipt + recovery token 同一 transaction 原子 consumed
//
// 這裡刻意不讓「HTTP 200 已送出」等於「瀏覽器已經把 cart 存好」——那正是
// 兩階段設計要避免的單階段 consume 風險。
'use strict';
const { isDurableError } = require('./db');

const crypto = require('crypto');
const { getDb } = require('./db');
const { _nowLocal, _addMinutes, _isExpired, RECOVERY_PAGE_TYPES } = require('./lineCheckoutHandoff');

const RECEIPT_TTL_MINUTES = 5;
const POPUP_RESTORE_SNAPSHOT_MAX_ITEMS = 50;

function _sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ══════════════════════════════════════════════════════════════════════
// H1.4.12 Phase 3B（Cart Restore Final Corrective Verification）：
//
// validatePopupRestoreSnapshot(cartJsonString)
//
// 明確區分「合法快照、reconcile 後才變空」跟「快照本身就不可信」——不得把
// 這兩種情況都靜默 fail closed 成「空購物車」，否則使用者可能在不知情下
// 確認一個因為資料毀損而空掉的購物車，永久失去原始恢復資料（本輪要修正的
// 核心問題）。
//
// 這裡只做「快照本身結構是否可信」的判斷：JSON 是否能解析、外層結構、
// 每一項 product_id/qty 是否為安全正整數、聚合後是否溢位、聚合後品項數是
// 否超過上限。全部通過才輪到 reconcilePopupCartItemsAgainstFreshAuthority()
// 依 fresh authority 決定「reconcile 後还剩下什么」（那才是
// valid_empty_after_reconcile 的唯一合法來源）。
//
// 任何一項不通過，整份快照視為不可信，回傳 { ok:false, reason }，呼叫端
// 必須：不建立 receipt、不覆蓋 cart、不 commit、token 維持 opened、不得
// 顯示成「購物車為空」。
// ══════════════════════════════════════════════════════════════════════
function validatePopupRestoreSnapshot(cartJsonString) {
  let parsed;
  try { parsed = JSON.parse(cartJsonString || '{}'); } catch (e) { return { ok: false, reason: 'malformed_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_structure' };
  if (!Array.isArray(parsed.items)) return { ok: false, reason: 'invalid_structure' };
  // RC2 修正：popup_order 的原始快照不得是空陣列——一個「原本就沒放任何
  // 東西」的快照跟「fresh authority 判定全部不可用」是完全不同的兩件事
  // （見規格二）；只有後者才能得到 valid_empty_after_reconcile。原始
  // items=[] 本身就視為快照不可信，直接 invalid_snapshot，不得往下走到
  // reconcile 階段才變成看似合法的空購物車。
  if (parsed.items.length === 0) return { ok: false, reason: 'empty_snapshot' };

  const aggregated = new Map(); // product_id -> qty
  for (const it of parsed.items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, reason: 'invalid_item' };
    const productId = it.product_id;
    const qty = it.qty;
    // 嚴格型別：必須本來就是 number（不接受字串數字之類的寬鬆轉型——那種
    // 寬鬆轉型正是「看起來能救、但其實在掩蓋資料毀損」的做法）。
    if (typeof productId !== 'number' || !Number.isSafeInteger(productId) || productId <= 0) return { ok: false, reason: 'invalid_item' };
    if (typeof qty !== 'number' || !Number.isFinite(qty) || !Number.isSafeInteger(qty) || qty <= 0) return { ok: false, reason: 'invalid_item' };
    const prev = aggregated.get(productId) || 0;
    const next = prev + qty;
    if (!Number.isSafeInteger(next)) return { ok: false, reason: 'aggregate_overflow' };
    aggregated.set(productId, next);
  }
  if (aggregated.size > POPUP_RESTORE_SNAPSHOT_MAX_ITEMS) return { ok: false, reason: 'too_many_items' };

  const items = Array.from(aggregated.entries()).map(([product_id, qty]) => ({ product_id, qty }));
  return { ok: true, items };
}


// 192-bit CSPRNG，跟 recovery token 的 generateFullToken() 同等強度。DB 只存
// hash，不存 raw receipt——就算 DB 洩漏，raw receipt 也無法被反推出來使用。
function _generateReceipt() {
  return crypto.randomBytes(24).toString('base64url');
}

// 用來偵測「同一份 canonical cart」是否改變（純粹除錯／稽核用途，不是
// 安全邊界本身——真正的安全邊界是 receipt hash 比對與 token 狀態機）。
function _cartDigest(items) {
  const canonical = items.map((it) => `${it.product_id}:${it.qty}`).sort().join(',');
  return _sha256Hex(canonical);
}

function _resolveTokenRowForPopupRestore(db, recoveryToken) {
  if (!recoveryToken || typeof recoveryToken !== 'string') return { ok: false, reason: 'missing_token' };
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=? AND purpose=?', [recoveryToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') db.runDurableTransaction(() => { db._db.run("UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]); }); // R44.2F.2
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  const pageType = row.recovery_page_type || '';
  if (pageType !== 'popup_order') return { ok: false, reason: 'invalid_target' };
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_target' };
  // 規格二：prepare 只在 status=opened 時允許——bootstrap/resolve-target
  // 必須已經完成過，不能跳過身分驗證階段直接 prepare。
  if (row.status !== 'opened') return { ok: false, reason: 'invalid_status' };
  return { ok: true, row };
}

// ══════════════════════════════════════════════════════════════════════
// preparePopupRestore(db, recoveryToken, memberSession, popupSessionPublicCodeClaim)
//
// 只做「算出安全、fresh reconcile 過的 canonical cart + 發一張短效
// receipt」，完全不碰 recovery token 的狀態（不轉 consumed），也不寫入
// order/allocation、不動一般購物車或 quota。
// ══════════════════════════════════════════════════════════════════════
function preparePopupRestore(db, recoveryToken, memberSession, popupSessionPublicCodeClaim) {
  const resolved = _resolveTokenRowForPopupRestore(db, recoveryToken);
  if (!resolved.ok) return resolved;
  const row = resolved.row;
  const derivedStoreId = row.store_id;

  let verifyMemberSession;
  try { ({ verifyMemberSession } = require('./lineMemberSession')); } catch (e) { return { ok: false, reason: 'exception' }; }
  if (!memberSession || typeof memberSession !== 'string') return { ok: false, reason: 'member_not_identified' };
  const verifiedLineUserId = verifyMemberSession(memberSession, derivedStoreId);
  if (!verifiedLineUserId) return { ok: false, reason: 'member_not_identified' };
  if (!row.line_user_id || row.line_user_id !== verifiedLineUserId) return { ok: false, reason: 'uid_mismatch' };

  // request 的 popup_session_public_code 是必填的一致性確認（不能覆寫
  // row binding），缺少或不符時安全拒絕，不洩漏 row 真正的值。
  if (!popupSessionPublicCodeClaim || typeof popupSessionPublicCodeClaim !== 'string' || String(popupSessionPublicCodeClaim) !== row.popup_session_public_code) {
    return { ok: false, reason: 'popup_session_mismatch' };
  }

  // 規格一：先驗證「快照本身是否可信」，通過後才輪到 fresh authority
  // reconcile——不得把這兩種完全不同的情況都籠統回一個空陣列。快照本身
  // 不可信時，直接安全拒絕整個 prepare（不建立 receipt、不動 token 狀態、
  // 呼叫端絕對不能把這個結果顯示成「購物車是空的」）。
  const snapshotResult = validatePopupRestoreSnapshot(row.cart_json);
  if (!snapshotResult.ok) return { ok: false, reason: 'invalid_snapshot', snapshotReason: snapshotResult.reason };

  let popupCheckout;
  try { popupCheckout = require('./popupCheckout'); } catch (e) { return { ok: false, reason: 'exception' }; }
  let authority;
  try { authority = popupCheckout.fetchFreshStoreAuthority(db, derivedStoreId); } catch (e) { authority = null; }
  if (!authority || !authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled) {
    return { ok: false, reason: 'not_found' };
  }
  let pp;
  try { pp = require('./popupPickup'); } catch (e) { return { ok: false, reason: 'exception' }; }
  if (!pp.isPopupPickupEnabled(db, derivedStoreId)) return { ok: false, reason: 'not_found' };

  const found = popupCheckout.findPublicSessionByCode(db, derivedStoreId, row.popup_session_public_code);
  if (!found || found.session.status === 'draft' || found.campaign.status === 'draft') {
    return { ok: false, reason: 'not_found' };
  }

  // 規格一：只有走到這裡（快照本身已經確認結構合法）之後，才是 fresh
  // authority reconcile 的職責範圍——這裡才會真正產生
  // valid_empty_after_reconcile（快照本身合法、且至少曾有一筆合法項目，
  // 只是 fresh authority 判定全部不可用）。
  const { items, removedItems } = popupCheckout.reconcilePopupCartItemsAgainstFreshAuthority(db, derivedStoreId, found.session, snapshotResult.items);
  const cartState = items.length > 0 ? 'valid_non_empty' : 'valid_empty_after_reconcile';

  // 規格二：撤銷舊 prepared receipt 與建立新 receipt 必須在同一個 raw DB
  // transaction 內完成——db.run()（高階 wrapper）每次呼叫都會各自
  // auto-save，等於兩個各自獨立落地的步驟，中間有真實的競態視窗（兩個
  // concurrent prepare 可能都通過「還沒被 supersede」的檢查、各自建立一張
  // 有效 receipt）。這裡改用 db._db.run() + BEGIN/COMMIT/ROLLBACK，跟
  // commitPopupRestore() 同一個模式，_save() 只在成功 COMMIT 之後呼叫一次。
  const now = _nowLocal();
  const rawReceipt = _generateReceipt();
  const receiptHash = _sha256Hex(rawReceipt);
  const expiresAt = _addMinutes(RECEIPT_TTL_MINUTES);
  const digest = _cartDigest(items);
  // R44.2F.1：改用 db.runDurableTransaction()——supersede＋新 receipt 同一個 durable transaction，
  // disk 寫入失敗時 memory／disk 皆維持舊 receipt 狀態，並以 DurableCommitError 往外傳（route 回 503）。
  try {
    db.runDurableTransaction(() => {
      db._db.run("UPDATE popup_restore_receipts SET status='superseded' WHERE token_id=? AND status='prepared'", [row.id]);
      db._db.run(
        `INSERT INTO popup_restore_receipts
          (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [receiptHash, derivedStoreId, row.id, verifiedLineUserId, row.popup_session_public_code, digest, 'prepared', now, expiresAt, '']
      );
    });
  } catch (e) {
    if (isDurableError(e)) throw e;
    return { ok: false, reason: 'exception' };
  }

  return {
    ok: true,
    restoreReceipt: rawReceipt,
    popupSessionPublicCode: row.popup_session_public_code,
    cartState,
    items,
    removedItems,
  };
}

// ══════════════════════════════════════════════════════════════════════
// commitPopupRestore(db, rawReceipt, memberSession, popupSessionPublicCodeClaim)
//
// 唯一會把 recovery token 轉成 consumed 的地方；receipt 與 token 在同一個
// raw DB transaction（BEGIN/COMMIT/ROLLBACK）內一起轉成 consumed，任何一步
// 失敗整筆 rollback，_save() 只在 transaction 成功 COMMIT 之後呼叫一次。
// ══════════════════════════════════════════════════════════════════════
function commitPopupRestore(db, rawReceipt, memberSession, popupSessionPublicCodeClaim) {
  if (!rawReceipt || typeof rawReceipt !== 'string') return { ok: false, reason: 'missing_receipt' };
  const receiptHash = _sha256Hex(rawReceipt);
  const receiptRow = db.get('SELECT * FROM popup_restore_receipts WHERE receipt_hash=?', [receiptHash]);
  if (!receiptRow) return { ok: false, reason: 'not_found' };

  let verifyMemberSession;
  try { ({ verifyMemberSession } = require('./lineMemberSession')); } catch (e) { return { ok: false, reason: 'exception' }; }
  if (!memberSession || typeof memberSession !== 'string') return { ok: false, reason: 'member_not_identified' };
  const verifiedLineUserId = verifyMemberSession(memberSession, receiptRow.store_id);
  if (!verifiedLineUserId || verifiedLineUserId !== receiptRow.line_user_id) return { ok: false, reason: 'uid_mismatch' };

  if (!popupSessionPublicCodeClaim || typeof popupSessionPublicCodeClaim !== 'string' || String(popupSessionPublicCodeClaim) !== receiptRow.popup_session_public_code) {
    return { ok: false, reason: 'popup_session_mismatch' };
  }

  const now = _nowLocal();

  // 規格三：Idempotency——同一張 receipt 已經成功 commit 過，且是同一位
  // verified user 重試（例如 response 遺失），安全地再回一次成功，不重複
  // consume（第二次不會再跑 UPDATE，也不會再消費 token 第二次）。
  if (receiptRow.status === 'consumed') {
    return { ok: true, alreadyConsumed: true };
  }
  if (receiptRow.status !== 'prepared') return { ok: false, reason: 'invalid_receipt_status' };
  if (_isExpired(receiptRow, now)) return { ok: false, reason: 'receipt_expired' };

  const tokenRow = db.get('SELECT * FROM line_cart_handoff_tokens WHERE id=?', [receiptRow.token_id]);
  if (!tokenRow) return { ok: false, reason: 'not_found' };
  if (tokenRow.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (tokenRow.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (tokenRow.status !== 'opened') return { ok: false, reason: 'invalid_status' };
  if (_isExpired(tokenRow, now)) return { ok: false, reason: 'expired' };

  try {
    db.runDurableTransaction(() => {
    db._db.run("UPDATE popup_restore_receipts SET status='consumed', consumed_at=? WHERE id=? AND status='prepared'", [now, receiptRow.id]);
    // RC2 修正（規格五）：每個條件 UPDATE 之後都必須確認真的剛好影響 1
    // 筆——不能只看有沒有丟例外。如果影響 0 筆（代表這期間狀態已經被別的
    // 呼叫改變，條件 WHERE 不成立）或影響超過 1 筆（理論上不該發生，但
    // 防禦性檢查），一律視為不安全，整筆 rollback、不得回成功、不得呼叫
    // _save()。
    const receiptAffected = db._db.getRowsModified ? db._db.getRowsModified() : null;
    if (receiptAffected !== 1) throw new Error('receipt UPDATE affected ' + receiptAffected + ' rows, expected exactly 1');

    db._db.run("UPDATE line_cart_handoff_tokens SET status='consumed', consumed_at=? WHERE id=? AND status='opened'", [now, tokenRow.id]);
    const tokenAffected = db._db.getRowsModified ? db._db.getRowsModified() : null;
    if (tokenAffected !== 1) throw new Error('token UPDATE affected ' + tokenAffected + ' rows, expected exactly 1');
    });
  } catch (e) {
    if (isDurableError(e)) throw e; // R44.2F.1：durable 失敗 → memory／disk 皆維持 prepared／opened，route 回 503
    return { ok: false, reason: 'exception' };
  }

  return { ok: true, alreadyConsumed: false };
}

module.exports = {
  preparePopupRestore,
  commitPopupRestore,
  validatePopupRestoreSnapshot,
  RECEIPT_TTL_MINUTES,
  POPUP_RESTORE_SNAPSHOT_MAX_ITEMS,
};
