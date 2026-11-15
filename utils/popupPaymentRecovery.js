// utils/popupPaymentRecovery.js — R54.4／MBV2-HF1-C5.4：快閃 LINE Pay 付款安全與恢復
//
// 快閃仍是獨立流程（不加入一般點餐 currentMode、不套用一般訂單的提交邏輯）。本模組只負責「付款結果」：
//   名額（popup_order_allocations）與快照的處理沿用 utils/popupCheckout／popupSales 既有函式與邊界。
// 共用的只有付款解析／驗證／唯讀查詢基礎：utils/linePayRecovery.safeParseLinePay（交易識別不經 Number）、
//   inquire()（官方 Retrieve payment details 完整核對）、DEFINITIVE_DECLINE_CODES（明確拒絕清單）。
//
// 付款嘗試狀態（popup_payment_attempts.status）
//   pending          尚未送出 Confirm（confirm_state='never'）；或舊版留下、可能已送出（confirm_state='unknown'）
//   confirm_pending  已 durable 保存處理階段、Confirm 已送出或可能已送出（結果尚未寫回）
//   review           結果不明（回應遺失、逾時、未知代碼、重複交易、查無資料、欄位不符、程序中斷、歷史隔離）→ 只做唯讀核對
//   paid             已確認付款（Confirm 0000 完整相符，或唯讀查詢完整相符）
//   paid_cancelled   已確認付款，但訂單已取消／作廢／履約逾時 → 保留取消、標示待退款（refund_status='pending_refund'）
//   failed           確定未付款：可信的第一次 Confirm 被官方明確拒絕，或送出 Confirm 前就確定不送（顧客取消、回呼不符）
//   aborted_cancelled 送出 Confirm 前訂單已取消／金額不符 → 不送 Confirm（顧客授權會逾時、不會請款）
//   expired          尚未送出 Confirm 即逾時（不會請款）
//   cancelled        已確定失敗後依設定改現金
//
// 處理階段（confirm_state）：'never'＝可靠紀錄證明從未送出 Confirm；'sent'＝已保存並可能已送出；'unknown'＝沒有可靠處理階段。
//   只有 never＋pending＋confirm_calls=0＋保存的交易識別與回呼完全相同（字串）時才送第一次 Confirm；
//   送出前以條件式 durable 更新（必須恰好改到 1 列）同時改為 confirm_pending／sent。保存失敗 → 外部 Confirm 0 次。
//
// 履約逾時與付款結果分開：結果不明的付款逾時時，依既有設定（expire_cancel_release）取消訂單、釋放名額，
//   但付款嘗試維持待核對、訂單 payment_status 維持 pending（不宣告未付款）；之後確認已付款 → paid_cancelled＋待退款，
//   不恢復出餐、不搶回已釋放名額。
'use strict';

const crypto = require('crypto');
const LPR = require('./linePayRecovery');

const STATE_VERSION = 4; // C5.4
const OPEN = ['confirm_pending', 'review'];
const MAX_AUTO_INQUIRIES = 20;
const DECLINE_SET = new Set(LPR.DEFINITIVE_DECLINE_CODES);
const _inflight = new Set(); // attempt_id（同一程序內合併同時的 callback／核對；持久狀態以資料庫為準）
const _storeLock = new Map();
const _attemptLast = new Map();

function rawAll(raw, sql, params) { const st = raw.prepare(sql); try { if (params) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } }
function rawGet(raw, sql, params) { return rawAll(raw, sql, params)[0] || null; }
function colNames(raw, t) { try { return rawAll(raw, `PRAGMA table_info(${t})`).map((c) => c.name); } catch { return []; } }
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const cents = (v) => Math.round(Number(v) * 100);
const validAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function payInfoTotal(payInfo) {
  if (!Array.isArray(payInfo) || !payInfo.length) return null;
  let t = 0;
  for (const p of payInfo) { if (!p || typeof p !== 'object' || !validAmount(p.amount)) return null; t += cents(p.amount); }
  return t;
}
function backoffAt(count) { return utc(Date.now() + Math.min(60 * 2 ** Math.min(count, 6), 3600) * 1000); }

// ══════════════════════════════════════════════════════════════════════
//  遷移（additive、idempotent；只動 confirm_state 為 NULL 的舊列）
// ══════════════════════════════════════════════════════════════════════
const ADD_COLS = [
  ['confirm_state', 'TEXT DEFAULT NULL'], ['confirm_calls', 'INTEGER NOT NULL DEFAULT 0'], ['review_reason', "TEXT NOT NULL DEFAULT ''"],
  ['failure_basis', "TEXT NOT NULL DEFAULT ''"], ['result_code', "TEXT NOT NULL DEFAULT ''"], ['inquiry_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_inquiry_at', 'TEXT DEFAULT NULL'], ['last_inquiry_result', "TEXT NOT NULL DEFAULT ''"], ['next_check_at', 'TEXT DEFAULT NULL'],
  ['fulfillment_closed', 'INTEGER NOT NULL DEFAULT 0'], ['merchant_ref', "TEXT NOT NULL DEFAULT ''"], ['confirmed_at', 'TEXT DEFAULT NULL'],
  ['quarantined_from', "TEXT NOT NULL DEFAULT ''"], ['state_version', 'INTEGER NOT NULL DEFAULT 0'],
];
// 舊版（C5.3 以前）在送出 Confirm 後、因網路錯誤或回應不符而寫下的 failed：可能已付款
const LEGACY_UNCERTAIN_FAIL = ['provider_declined', 'amount_or_id_mismatch'];
// 舊版在送出 Confirm 之前就決定的失敗：確定沒有請款
const LEGACY_PRECONFIRM_FAIL = ['customer_cancelled', 'callback_mismatch', 'provider_not_ready'];

function migrate(raw) {
  const out = { ok: false, classified: 0, quarantined: 0, legacy_expired: 0 };
  let cols = colNames(raw, 'popup_payment_attempts');
  if (!cols.length) return out;
  for (const [c, def] of ADD_COLS) if (!cols.includes(c)) raw.run(`ALTER TABLE popup_payment_attempts ADD COLUMN ${c} ${def}`);
  cols = colNames(raw, 'popup_payment_attempts');
  raw.run('CREATE INDEX IF NOT EXISTS idx_popup_pay_attempt_open ON popup_payment_attempts(store_id, status, next_check_at)');
  const legacy = rawAll(raw, 'SELECT attempt_id, status, fail_reason, transaction_id FROM popup_payment_attempts WHERE confirm_state IS NULL');
  for (const a of legacy) {
    const hasTx = String(a.transaction_id || '') !== '';
    if (a.status === 'pending') {
      // 舊版在 Confirm 前不保存任何處理階段：已有交易識別者可能已送出 Confirm（程序中斷）→ 只做唯讀核對
      raw.run("UPDATE popup_payment_attempts SET confirm_state=? WHERE attempt_id=?", [hasTx ? 'unknown' : 'never', a.attempt_id]);
    } else if (a.status === 'failed' && hasTx && LEGACY_UNCERTAIN_FAIL.includes(String(a.fail_reason || ''))) {
      raw.run(`UPDATE popup_payment_attempts SET status='review', confirm_state='unknown', quarantined_from=?, review_reason=?,
               updated_at=datetime('now','localtime') WHERE attempt_id=?`, ['failed:' + a.fail_reason, 'c54_quarantine:failed:' + a.fail_reason, a.attempt_id]);
      out.quarantined++;
    } else if (a.status === 'failed') {
      raw.run('UPDATE popup_payment_attempts SET confirm_state=?, failure_basis=? WHERE attempt_id=?',
        [hasTx ? 'unknown' : 'never', LEGACY_PRECONFIRM_FAIL.includes(String(a.fail_reason || '')) ? 'legacy_preconfirm:' + (a.fail_reason || '') : 'legacy:' + (a.fail_reason || 'unknown'), a.attempt_id]);
    } else if (a.status === 'expired' && hasTx) {
      // 舊版逾時處理可能與進行中的 Confirm 競爭：不改狀態，標示為未驗證（後台可唯讀核對）
      raw.run("UPDATE popup_payment_attempts SET confirm_state='unknown', review_reason='c54_legacy_expired_unverified' WHERE attempt_id=?", [a.attempt_id]);
      out.legacy_expired++;
    } else {
      raw.run("UPDATE popup_payment_attempts SET confirm_state=? WHERE attempt_id=?", [hasTx ? 'unknown' : 'never', a.attempt_id]);
    }
    out.classified++;
  }
  // 回退期間（舊版程式）寫下的「可能已付款的失敗」立即轉為待核對（舊版不寫 failure_basis）
  raw.run('DROP TRIGGER IF EXISTS trg_ppa_c54_quarantine_upd');
  raw.run(`CREATE TRIGGER trg_ppa_c54_quarantine_upd AFTER UPDATE OF status ON popup_payment_attempts
           WHEN NEW.status='failed' AND COALESCE(NEW.failure_basis,'')='' AND COALESCE(NEW.transaction_id,'')<>''
                AND NEW.fail_reason IN ('provider_declined','amount_or_id_mismatch')
           BEGIN
             UPDATE popup_payment_attempts SET status='review', confirm_state='unknown', quarantined_from='failed:'||NEW.fail_reason,
               review_reason='c54_quarantine:failed:'||NEW.fail_reason WHERE attempt_id=NEW.attempt_id;
           END`);
  out.ok = true;
  return out;
}

// 啟動時：上次送出 Confirm 後中斷（confirm_pending）→ 待核對（不呼叫外部 API）
function bootRecover(raw) {
  if (!colNames(raw, 'popup_payment_attempts').includes('confirm_state')) return 0;
  raw.run(`UPDATE popup_payment_attempts SET status='review', review_reason=CASE WHEN review_reason='' THEN 'interrupted' ELSE review_reason||'|interrupted' END,
           next_check_at=COALESCE(next_check_at, datetime('now')), updated_at=datetime('now','localtime') WHERE status='confirm_pending'`);
  return raw.getRowsModified();
}

function ensure(db) {
  const raw = db._db;
  if (!colNames(raw, 'popup_payment_attempts').includes('state_version')) migrate(raw);
}

// ══════════════════════════════════════════════════════════════════════
//  讀寫輔助
// ══════════════════════════════════════════════════════════════════════
function getAttempt(db, attemptId) { return db.get('SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [attemptId]) || null; }
function getOrder(db, a) { return db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [a.order_id, a.store_id]) || null; }
const isCancelled = (o) => !!o && (o.order_status === 'cancelled' || o.status === 'void');
function setAttempt(db, attemptId, sets, params) {
  try {
    db.runDurableTransaction(() => db._db.run(`UPDATE popup_payment_attempts SET ${sets}, updated_at=datetime('now','localtime') WHERE attempt_id=?`, [...params, attemptId]));
    return true;
  } catch (e) { return false; }
}
function setReview(db, a, reason) {
  return setAttempt(db, a.attempt_id, "status='review', review_reason=?, next_check_at=COALESCE(next_check_at, ?)", [String(reason || '').slice(0, 120), backoffAt(Number(a.inquiry_count) || 0)]);
}
function inquiryShape(a, order) {
  return { transaction_id: String(a.transaction_id || ''), amount: Number(a.amount), currency: a.currency || 'TWD', lp_order_id: order ? String(order.order_number || '') : '', merchant_ref: a.merchant_ref || '' };
}
function recordInquiry(db, a, inq) {
  const n = (Number(a.inquiry_count) || 0) + 1;
  setAttempt(db, a.attempt_id, "inquiry_count=?, last_inquiry_at=datetime('now'), last_inquiry_result=?, next_check_at=?", [n, `${inq.result}:${inq.detail}`.slice(0, 80), backoffAt(n)]);
  a.inquiry_count = n;
}

// ══════════════════════════════════════════════════════════════════════
//  已確認付款：durable 交易內重新讀取訂單與付款嘗試
// ══════════════════════════════════════════════════════════════════════
function commitPaid(db, attemptId) {
  let outcome = 'pending';
  try {
    db.runDurableTransaction(() => {
      const raw = db._db;
      const a = rawGet(raw, 'SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [attemptId]);
      if (!a) throw new Error('attempt_missing');
      if (a.status === 'paid') { outcome = 'paid'; return; }
      if (a.status === 'paid_cancelled') { outcome = 'paid_cancelled'; return; }
      // 確定未付款／已改現金的付款嘗試不可能再被核對為已付款（呼叫端也不會對它們查詢）
      if (['failed', 'cancelled', 'aborted_cancelled'].includes(a.status)) throw new Error('attempt_not_payable:' + a.status);
      const o = rawGet(raw, 'SELECT * FROM orders WHERE id=? AND store_id=?', [a.order_id, a.store_id]);
      if (!o) throw new Error('order_missing');
      const closed = isCancelled(o) || Number(a.fulfillment_closed) === 1 || a.status === 'expired';
      if (closed) {
        // 已取消／作廢／履約逾時：記錄已付款、保留取消、標示待退款；不恢復出餐、不轉換已釋放的名額
        raw.run(`UPDATE orders SET payment_status='paid', refund_status='pending_refund', updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [a.order_id, a.store_id]);
        raw.run(`UPDATE popup_payment_attempts SET status='paid_cancelled', review_reason='paid_after_close_needs_refund', result_code='0000',
                 confirmed_at=datetime('now'), updated_at=datetime('now','localtime') WHERE attempt_id=?`, [attemptId]);
        outcome = 'paid_cancelled';
        return;
      }
      raw.run(`UPDATE orders SET payment_status='paid', updated_at=datetime('now','localtime') WHERE id=? AND store_id=? AND payment_status='pending'`, [a.order_id, a.store_id]);
      raw.run(`UPDATE popup_payment_attempts SET status='paid', review_reason='', fail_reason='', result_code='0000', confirmed_at=datetime('now'),
               updated_at=datetime('now','localtime') WHERE attempt_id=?`, [attemptId]);
      // R53：保留量 → 已成立（只轉 status='active' AND stock_state='reserved' 的列；重複呼叫 0 列）
      require('./popupSales').commitReservedForOrder(db, a.store_id, a.order_id);
      outcome = 'paid';
    });
  } catch (e) {
    return { outcome: 'pending', reason: 'local_commit_failed', error: e && e.message };
  }
  return { outcome };
}

// 確定未付款（只用於：可信的第一次 Confirm 被明確拒絕、或送出 Confirm 前就確定不送）
function commitFailed(db, a, failReason, basis, code) {
  const ppay = require('./popupPayment');
  const s = ppay.loadPopupPaymentSettings(db, a.store_id) || ppay.defaultPopupPaymentSettings();
  let changed = false;
  db.runDurableTransaction(() => {
    const raw = db._db;
    raw.run(`UPDATE popup_payment_attempts SET status='failed', fail_reason=?, failure_basis=?, result_code=?, updated_at=datetime('now','localtime')
             WHERE attempt_id=? AND status IN ('pending','confirm_pending')`, [failReason, basis, String(code || ''), a.attempt_id]);
    changed = raw.getRowsModified() === 1;
    if (changed && !s.allow_fallback_cash) {
      const { releasePopupOrderAllocations } = require('./popupCheckout');
      raw.run(`UPDATE orders SET order_status='cancelled', payment_status='failed', updated_at=datetime('now','localtime')
               WHERE id=? AND store_id=? AND payment_status='pending'`, [a.order_id, a.store_id]);
      releasePopupOrderAllocations(db, a.store_id, a.order_id, a.session_id);
    }
  });
  return changed;
}

// ══════════════════════════════════════════════════════════════════════
//  唯讀核對（不送 Confirm、不退款）
// ══════════════════════════════════════════════════════════════════════
async function verifyByInquiry(db, cfg, attemptId, reason) {
  const a = getAttempt(db, attemptId);
  if (!a) return { outcome: 'pending', reason: 'attempt_missing' };
  if (a.status === 'paid' || a.status === 'paid_cancelled') return { outcome: a.status };
  const o = getOrder(db, a);
  const inq = await LPR.inquire(db, cfg, inquiryShape(a, o));
  recordInquiry(db, a, inq);
  if (inq.result === 'paid') {
    const r = commitPaid(db, attemptId);
    if (r.outcome === 'pending') { setReview(db, a, 'local_commit_failed'); return r; }
    return r;
  }
  // 查無、空清單、timeout、網路錯誤、解析失敗、欄位不符：都不是「確定未付款」→ 維持待核對
  if (OPEN.includes(a.status) || a.status === 'pending') setReview(db, a, (reason ? reason + '|' : '') + 'inquiry_' + inq.result + ':' + inq.detail);
  return { outcome: 'pending', reason: reason || ('inquiry_' + inq.result) };
}

// ══════════════════════════════════════════════════════════════════════
//  顧客付款 callback（已由呼叫端驗證一次性 nonce、店別、場次授權）
//  回傳 result：paid｜paid_cancelled｜pending｜failed｜order_cancelled｜expired｜cancelled｜error
// ══════════════════════════════════════════════════════════════════════
async function handleConfirmCallback(db, attemptId, query) {
  ensure(db);
  if (_inflight.has(attemptId)) return { result: 'pending', reason: 'in_progress' };
  _inflight.add(attemptId);
  try {
    const ppay = require('./popupPayment');
    let a = getAttempt(db, attemptId);
    if (!a) return { result: 'error', reason: 'attempt_missing' };
    if (a.status === 'paid' || a.status === 'paid_cancelled') return { result: a.status };
    ppay.reconcileExpiredPopupPayments(db, a.store_id);
    a = getAttempt(db, attemptId);
    const { getLinePayConfig, signLinePayPost, makePostHeaders } = require('./linePayClient');
    const cfg = getLinePayConfig(db, a.store_id, true);
    // 曾送出或可能已送出 Confirm、或處理階段不明 → 只做唯讀核對（callback 不能繞過）
    if (OPEN.includes(a.status) || (a.status === 'pending' && a.confirm_state !== 'never')) {
      if (!a.transaction_id) { setReview(db, a, 'no_transaction_id'); return { result: 'pending', reason: 'no_transaction_id' }; }
      const r = await verifyByInquiry(db, cfg, attemptId, a.confirm_state === 'unknown' && !a.quarantined_from ? 'legacy_unverified' : '');
      return { result: r.outcome === 'paid' || r.outcome === 'paid_cancelled' ? r.outcome : 'pending', reason: r.reason };
    }
    if (a.status !== 'pending') return { result: a.status === 'aborted_cancelled' ? 'order_cancelled' : a.status };
    const order = getOrder(db, a);
    if (!order) return { result: 'error', reason: 'order_missing' };
    const qTx = String(query.transactionId || '');
    const storedTx = String(a.transaction_id || '');
    // 交易識別全程以字串精確比對（不使用 Number() 容錯）；沒有保存的交易識別 → 不送 Confirm（授權會逾時、不會請款）
    if (!storedTx) return { result: 'error', reason: 'no_recorded_transaction' };
    if (!/^\d{1,30}$/.test(qTx) || qTx !== storedTx || String(query.orderId || '') !== String(order.order_number)) {
      commitFailed(db, a, 'callback_mismatch', 'callback_mismatch_before_confirm', '');
      return { result: 'failed', reason: 'callback_mismatch' };
    }
    if (!cfg || !cfg.channelId || !cfg.channelSecret) {
      commitFailed(db, a, 'provider_not_ready', 'provider_not_ready_before_confirm', '');
      return { result: 'failed', reason: 'provider_not_ready' };
    }
    if (a.merchant_ref && a.merchant_ref !== cfg.channelId) { setReview(db, a, 'merchant_changed'); return { result: 'pending', reason: 'merchant_changed' }; }
    // 送出前同步重新讀取（與保存、送出之間沒有 await）
    a = getAttempt(db, attemptId);
    const o2 = getOrder(db, a);
    if (!(a.status === 'pending' && a.confirm_state === 'never' && Number(a.confirm_calls || 0) === 0)) {
      const r = await verifyByInquiry(db, cfg, attemptId, '');
      return { result: r.outcome === 'paid' || r.outcome === 'paid_cancelled' ? r.outcome : 'pending', reason: r.reason };
    }
    if (isCancelled(o2)) {
      setAttempt(db, attemptId, "status='aborted_cancelled', failure_basis='order_cancelled_before_confirm'", []);
      return { result: 'order_cancelled' };
    }
    if (Number(a.expires_at) <= Date.now()) {
      ppay.reconcileExpiredPopupPayments(db, a.store_id);
      return { result: 'expired' };
    }
    if (cents(a.amount) !== cents(o2.total) || !(Number(a.amount) > 0)) {
      setAttempt(db, attemptId, "status='aborted_cancelled', failure_basis='amount_changed_before_confirm'", []);
      return { result: 'order_cancelled', reason: 'amount_changed' };
    }
    // 送出前 durable 保存處理階段（條件式：必須恰好改到 1 列）；保存失敗或沒改到列 → 外部 Confirm 0 次
    let claimed = false;
    try {
      db.runDurableTransaction(() => {
        db._db.run(`UPDATE popup_payment_attempts SET status='confirm_pending', confirm_state='sent', confirm_calls=COALESCE(confirm_calls,0)+1,
                    merchant_ref=?, updated_at=datetime('now','localtime')
                    WHERE attempt_id=? AND status='pending' AND confirm_state='never' AND COALESCE(confirm_calls,0)=0 AND transaction_id=?`,
        [cfg.channelId, attemptId, storedTx]);
        claimed = db._db.getRowsModified() === 1;
      });
    } catch (e) {
      return { result: 'error', reason: 'stage_save_failed' };
    }
    if (!claimed) return { result: 'pending', reason: 'claim_lost' };
    // ── 外部 Confirm（交易外；sql.js 同步，等待期間不持有寫入交易）──
    const confirmBody = { amount: Number(a.amount), currency: a.currency || 'TWD' };
    const uri = `/v3/payments/${storedTx}/confirm`;
    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, confirmBody, nonce);
    let data = null, net = '';
    try {
      const fetch = require('node-fetch');
      const res = await fetch(cfg.apiBase + uri, { method: 'POST', headers: makePostHeaders(cfg.channelId, signature, nonce), body: bodyStr, timeout: 20000 });
      const text = res && typeof res.text === 'function' ? await res.text() : '';
      data = LPR.safeParseLinePay(text);
      if (!data) net = 'confirm_unparseable';
    } catch (e) { net = 'confirm_network'; }
    if (net) { setReview(db, a, net); const r = await verifyByInquiry(db, cfg, attemptId, net); return { result: r.outcome === 'paid' || r.outcome === 'paid_cancelled' ? r.outcome : 'pending', reason: net }; }
    const code = String(data.returnCode || '');
    setAttempt(db, attemptId, 'result_code=?', [code.slice(0, 10)]);
    if (code === '0000') {
      const info = data.info && typeof data.info === 'object' ? data.info : null;
      const ok = !!info && typeof info.transactionId === 'string' && info.transactionId === storedTx
        && typeof info.orderId === 'string' && info.orderId === String(order.order_number)
        && payInfoTotal(info.payInfo) === cents(a.amount);
      if (ok) {
        const r = commitPaid(db, attemptId);
        if (r.outcome === 'pending') { setReview(db, a, 'local_commit_failed'); const r2 = await verifyByInquiry(db, cfg, attemptId, 'local_commit_failed'); return { result: r2.outcome === 'paid' || r2.outcome === 'paid_cancelled' ? r2.outcome : 'pending' }; }
        return { result: r.outcome };
      }
      setReview(db, a, 'confirm_incomplete');
      const r = await verifyByInquiry(db, cfg, attemptId, 'confirm_incomplete');
      return { result: r.outcome === 'paid' || r.outcome === 'paid_cancelled' ? r.outcome : 'pending', reason: 'confirm_incomplete' };
    }
    if (DECLINE_SET.has(code)) {
      // 可信的第一次 Confirm 被官方明確拒絕 → 確定未請款；之後不會再對這筆交易送 Confirm
      commitFailed(db, a, 'declined:' + code, 'first_confirm_declined:' + code, code);
      return { result: 'failed', reason: 'declined:' + code };
    }
    // 重複交易、處理中、內部錯誤、未知代碼 → 唯讀核對；查不到也不推定未付款
    setReview(db, a, 'confirm_code_' + code);
    const r = await verifyByInquiry(db, cfg, attemptId, 'confirm_code_' + code);
    return { result: r.outcome === 'paid' || r.outcome === 'paid_cancelled' ? r.outcome : 'pending', reason: 'confirm_code_' + code };
  } finally { _inflight.delete(attemptId); }
}

// 顧客在 LINE Pay 取消：只有「從未送出 Confirm」的付款才能確定未完成
function handleCancelCallback(db, attemptId) {
  ensure(db);
  const a = getAttempt(db, attemptId);
  if (!a) return { result: 'error' };
  if (a.status === 'pending' && a.confirm_state === 'never' && Number(a.confirm_calls || 0) === 0 && !_inflight.has(attemptId)) {
    commitFailed(db, a, 'customer_cancelled', 'customer_cancelled_before_confirm', '');
    return { result: 'cancelled' };
  }
  if (OPEN.includes(a.status) || a.status === 'pending') return { result: 'pending' };
  return { result: a.status };
}

// ══════════════════════════════════════════════════════════════════════
//  履約逾時（只關閉履約；付款結果不明者不宣告未付款）
// ══════════════════════════════════════════════════════════════════════
function closeUnresolvedOnTimeout(db, storeId, now, settings) {
  const raw = db._db;
  if (!colNames(raw, 'popup_payment_attempts').includes('fulfillment_closed')) return 0;
  const t = now || Date.now();
  const rows = db.all(`SELECT * FROM popup_payment_attempts WHERE store_id=? AND fulfillment_closed=0 AND expires_at<=?
                       AND (status IN ('confirm_pending','review') OR (status='pending' AND COALESCE(confirm_state,'')<>'never'))`, [storeId, t]);
  if (!rows.length) return 0;
  let n = 0;
  db.runDurableTransaction(() => {
    for (const a of rows) {
      // 舊版留下、處理階段不明的 pending → 待核對（不判定逾時未付款）
      if (a.status === 'pending') raw.run(`UPDATE popup_payment_attempts SET status='review', review_reason='legacy_unverified_timeout', next_check_at=COALESCE(next_check_at, datetime('now'))
                                           WHERE attempt_id=? AND status='pending'`, [a.attempt_id]);
      raw.run('UPDATE popup_payment_attempts SET fulfillment_closed=1 WHERE attempt_id=? AND fulfillment_closed=0', [a.attempt_id]);
      if (raw.getRowsModified() !== 1) continue;
      n++;
      if (settings && settings.expire_cancel_release) {
        // 取消履約、釋放名額；payment_status 維持 pending（付款結果不明，不宣告未付款）
        raw.run(`UPDATE orders SET order_status='cancelled', updated_at=datetime('now','localtime') WHERE id=? AND store_id=? AND payment_status='pending'`, [a.order_id, a.store_id]);
        require('./popupCheckout').releasePopupOrderAllocations(db, a.store_id, a.order_id, a.session_id);
      }
    }
  });
  return n;
}

// ══════════════════════════════════════════════════════════════════════
//  後台：待核對清單與唯讀核對
// ══════════════════════════════════════════════════════════════════════
function listReview(db, storeId, limit = 100) {
  if (!colNames(db._db, 'popup_payment_attempts').includes('confirm_state')) return [];
  const rows = db.all(`SELECT a.attempt_id, a.order_id, a.amount, a.currency, a.status, a.review_reason, a.result_code, a.confirm_state, a.confirm_calls,
                              a.inquiry_count, a.last_inquiry_at, a.last_inquiry_result, a.quarantined_from, a.fulfillment_closed, a.created_at, a.updated_at,
                              o.order_number, o.order_status, o.status AS order_record_status, o.payment_status, o.refund_status,
                              CASE WHEN COALESCE(a.transaction_id,'')<>'' THEN 1 ELSE 0 END AS has_transaction
                       FROM popup_payment_attempts a LEFT JOIN orders o ON o.id=a.order_id AND o.store_id=a.store_id
                       WHERE a.store_id=? AND (a.status IN ('confirm_pending','review')
                             OR (a.status='paid_cancelled' AND COALESCE(o.refund_status,'')='pending_refund')
                             OR (a.status='expired' AND a.review_reason='c54_legacy_expired_unverified'))
                       ORDER BY a.created_at DESC LIMIT ?`, [storeId, Math.max(1, Math.min(500, Number(limit) || 100))]);
  return rows.map((r) => ({ ...r, channel: 'popup', blocks_repay: OPEN.includes(r.status), legacy_unverified: r.status === 'expired',
    needs_manual: Number(r.inquiry_count) >= MAX_AUTO_INQUIRIES || !!r.quarantined_from || r.status === 'expired' }));
}
async function reconcile(db, storeId, opts = {}) {
  ensure(db);
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(opts.limit) || 10)));
  const lock = _storeLock.get(storeId) || { running: false, last: 0 };
  _storeLock.set(storeId, lock);
  if (lock.running) return { busy: true };
  const now = Date.now();
  if (!opts.attempt_id && !opts.skipRate && now - lock.last < 20000) return { rate_limited: true, retry_after_ms: 20000 - (now - lock.last) };
  if (opts.attempt_id) {
    const last = _attemptLast.get(String(opts.attempt_id)) || 0;
    if (!opts.skipRate && now - last < 10000) return { rate_limited: true, retry_after_ms: 10000 - (now - last) };
    _attemptLast.set(String(opts.attempt_id), now);
  }
  lock.running = true;
  const out = { checked: 0, recovered: 0, paid_cancelled: 0, still_review: 0, skipped_in_progress: 0 };
  try {
    if (!opts.attempt_id) lock.last = now;
    const ppay = require('./popupPayment');
    ppay.reconcileExpiredPopupPayments(db, storeId);
    const { getLinePayConfig } = require('./linePayClient');
    const cfg = getLinePayConfig(db, storeId, true);
    const rows = opts.attempt_id
      ? db.all(`SELECT attempt_id FROM popup_payment_attempts WHERE store_id=? AND attempt_id=? AND COALESCE(transaction_id,'')<>''
                AND (status IN ('confirm_pending','review') OR (status='expired' AND confirm_state='unknown'))`, [storeId, String(opts.attempt_id)])
      : db.all(`SELECT attempt_id FROM popup_payment_attempts WHERE store_id=? AND status IN ('confirm_pending','review') AND COALESCE(transaction_id,'')<>''
                AND (next_check_at IS NULL OR next_check_at<=datetime('now')) AND COALESCE(inquiry_count,0) < ${MAX_AUTO_INQUIRIES}
                AND updated_at <= datetime('now','localtime','-30 seconds') ORDER BY created_at LIMIT ?`, [storeId, limit]);
    for (const r of rows) {
      if (_inflight.has(r.attempt_id)) { out.skipped_in_progress++; continue; }
      _inflight.add(r.attempt_id);
      try {
        out.checked++;
        const x = await verifyByInquiry(db, cfg, r.attempt_id, '');
        if (x.outcome === 'paid') out.recovered++;
        else if (x.outcome === 'paid_cancelled') out.paid_cancelled++;
        else out.still_review++;
      } finally { _inflight.delete(r.attempt_id); }
    }
  } finally { lock.running = false; }
  return out;
}
function isUnderReview(db, storeId, orderId) {
  if (!colNames(db._db, 'popup_payment_attempts').includes('confirm_state')) return false;
  return !!db.get("SELECT 1 AS x FROM popup_payment_attempts WHERE store_id=? AND order_id=? AND status IN ('confirm_pending','review') LIMIT 1", [storeId, String(orderId)]);
}

module.exports = {
  STATE_VERSION, OPEN, MAX_AUTO_INQUIRIES, migrate, bootRecover, ensure, commitPaid, commitFailed, verifyByInquiry,
  handleConfirmCallback, handleCancelCallback, closeUnresolvedOnTimeout, listReview, reconcile, isUnderReview, _inflight,
};
