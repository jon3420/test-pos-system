// utils/linePayRecovery.js — R54.4／MBV2-HF1-C5.2／C5.3：LINE Pay 付款處理階段、唯讀核對、恢復與副作用補齊
//
// C5.3 追加（付款待核對防重送、完整回應驗證、重新付款阻擋）
//   A. confirm_state：'never'＝可信的持久化紀錄證明從未送出 Confirm；'sent'＝已保存並可能已送出；'unknown'＝沒有可靠處理階段
//      （舊付款 callback、歷史匯入、升級前資料、隔離紀錄）。只有 never＋status requesting/requested＋confirm_calls=0 的付款
//      才能送第一次 Confirm；送出前的 durable 保存以條件式更新（必須恰好改到 1 列）同時把它改為 sent。其他一律只做唯讀核對。
//   B. Confirm 回應分類：只有「第一次 Confirm（可信）＋官方明確拒絕代碼」才判定未扣款（failed，保存 failure_basis）；
//      重複交易（1152／1172／1198）、處理中（1145）、暫時無法處理（1179）、內部錯誤（1199／9000）、未知代碼 → 唯讀核對 → 待核對。
//   C. 已付款判定：Confirm 0000 必須有相符的 transactionId、orderId、payInfo 金額；缺任何一項 → 唯讀核對。
//      唯讀查詢必須 transactionType 恰為 'PAYMENT'、金額為合法數字、恰好一筆相符、沒有退款紀錄。交易識別一律以字串保存與比對。
//   D. 停用「查無交易＋經過時間」的人工標記未付款；沒有官方權威終態證據前，付款維持待核對、重新付款維持阻擋。
//   E. 歷史隔離：C5.2 以前寫下、仍有付款可能的 failed／aborted_cancelled 紀錄轉為待核對（遷移與資料庫觸發器，皆可重複執行）。
//
// 原則
//   1. 付款狀態（orders.payment_status、付款嘗試 status）與履約狀態（orders.order_status／status）分開處理。
//   2. 送出 Confirm 前，先以 durable 交易保存付款嘗試為 confirm_pending；保存失敗就不呼叫外部 Confirm。
//      外部 API 等待期間不持有 SQLite 寫入交易（sql.js 同步執行，交易都在 await 之外）。
//   3. 網路錯誤、timeout、回應遺失、解析失敗、本機保存失敗都不推定為未付款 → review（待核對）。
//      重複交易代碼（1172／1198）、內部錯誤（1199／9000）也不推定付款成功或失敗。
//   4. 核對一律使用官方唯讀查詢 GET /v3/payments（Retrieve payment details），逐項核對交易識別、orderId、幣別、
//      金額、交易類型；returnCode=0000 本身不等於已付款。恢復／補登流程不發起新的 Confirm、不退款。
//   5. 金流已付款後：durable 交易內重新讀取訂單——仍可履約 → 已付款並建立副作用待辦（outbox）；
//      已取消／作廢 → 記錄已付款、保留取消／作廢、標示待退款（refund_status='pending_refund'），不恢復出餐、不扣份數。
//   6. 副作用（purchase、payment_success、會員消費）以 outbox 逐項執行並核對實際保存結果；中斷後可補齊，各只一次。
//   7. 份數：LINE 訂單建立時已依快照扣除（line_counter_allocation_snapshot），付款確認不再扣（C5.1 以前會再扣一次）。
'use strict';

const crypto = require('crypto');
// 呼叫當下才取得 node-fetch（與 routes/linepay.js、linePayService 相同的依賴取得方式）。
// 本模組會在 utils/db.js 啟動遷移時先被載入；若在載入時就固定 fetch，之後才替換 node-fetch 的測試邊界會被繞過。
const fetch = (...args) => require('node-fetch')(...args);
const OI = require('./orderIdentity');
const { signLinePayPost, signLinePayGet, makePostHeaders, makeGetHeaders } = require('./linePayClient');

const AMBIGUOUS_CODES = new Set(['1145', '1152', '1172', '1179', '1198', '1199', '9000']); // 只供說明；C5.3 以「明確拒絕清單」判定，不在清單內一律待核對
// 官方結果代碼中，代表「這次 Confirm 被拒絕、沒有完成請款」的代碼（只適用於可信的第一次 Confirm）
//   1101 非 LINE Pay 會員｜1102 會員目前無法交易｜1104 商家未註冊｜1105 商家無法使用｜1106 標頭錯誤｜1110 信用卡無法使用｜
//   1124 金額資訊錯誤｜1141 帳戶狀態問題｜1142 餘額不足｜1150 沒有交易紀錄｜1153 請款金額與付款請求金額不同｜1159 沒有付款請求資訊｜
//   1169 需選擇付款方式並驗證密碼｜1170 會員帳戶餘額已變動｜1178 商家不支援此幣別｜1180 付款時間已過期｜1183／1184 金額低於下限／超過上限｜
//   2101 參數錯誤｜2102 JSON 格式錯誤
const DEFINITIVE_DECLINE_CODES = ['1101', '1102', '1104', '1105', '1106', '1110', '1124', '1141', '1142', '1150', '1153', '1159', '1169', '1170', '1178', '1180', '1183', '1184', '2101', '2102'];
const DECLINE_SET = new Set(DEFINITIVE_DECLINE_CODES);
const FIRST_CONFIRM_SOURCES_SQL = "COALESCE(%s.source,'') NOT IN ('','legacy_callback') AND COALESCE(%s.source,'') NOT LIKE 'import:%%'";
const PAID_STATES = new Set(['paid', 'paid_cancelled']);
const OPEN_STATES = ['confirm_pending', 'review'];
const MAX_AUTO_INQUIRIES = 20;
const _inflight = new Set(); // attempt_uuid（同一程序內避免 callback 與後台核對重疊；持久狀態以資料庫為準）
const _storeLock = new Map(); // store_id → { running, lastInquiryRun }
const _attemptLast = new Map(); // attempt_uuid → 最近一次指定核對時間

function rawAll(raw, sql, params) { const st = raw.prepare(sql); try { if (params) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } }
function rawGet(raw, sql, params) { return rawAll(raw, sql, params)[0] || null; }
function colNames(raw, t) { try { return rawAll(raw, `PRAGMA table_info(${t})`).map((c) => c.name); } catch { return []; } }
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
// C5.3：交易識別（19 位，超過 JS 安全整數）在解析前先轉為字串，全程不經 Number
function safeParseLinePay(text) {
  const t = String(text || '');
  try { return JSON.parse(t.replace(/("(?:transactionId|refundTransactionId|originalTransactionId)"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g, '$1"$2"')); } catch { return null; }
}
async function readResponse(res) {
  if (res && typeof res.text === 'function') { const text = await res.text(); return { text, data: safeParseLinePay(text) }; }
  const data = res && typeof res.json === 'function' ? await res.json() : null; // 沒有 text() 的回應物件：已失去原始文字
  return { text: data ? JSON.stringify(data) : '', data };
}
const validAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const cents = (v) => Math.round(Number(v) * 100);
// 付款資訊金額合計：每筆都必須是合法數字（缺值、null、字串、NaN 一律不合法）
function payInfoTotal(payInfo) {
  if (!Array.isArray(payInfo) || !payInfo.length) return null;
  let t = 0;
  for (const p of payInfo) { if (!p || typeof p !== 'object' || !validAmount(p.amount)) return null; t += cents(p.amount); }
  return t;
}

// ══════════════════════════════════════════════════════════════════════
//  遷移（additive、idempotent）
// ══════════════════════════════════════════════════════════════════════
function migrate(raw) {
  const cols = colNames(raw, 'linepay_payment_attempts');
  if (!cols.length) return { ok: false };
  const add = (c, ddl) => { if (!cols.includes(c)) raw.run(`ALTER TABLE linepay_payment_attempts ADD COLUMN ${ddl}`); };
  add('state_version', 'state_version INTEGER DEFAULT 0');
  add('confirm_calls', 'confirm_calls INTEGER DEFAULT 0');
  add('review_reason', "review_reason TEXT DEFAULT ''");
  add('last_error', "last_error TEXT DEFAULT ''");
  add('inquiry_count', 'inquiry_count INTEGER DEFAULT 0');
  add('last_inquiry_at', 'last_inquiry_at TEXT DEFAULT NULL');
  add('last_inquiry_result', "last_inquiry_result TEXT DEFAULT ''");
  add('next_check_at', 'next_check_at TEXT DEFAULT NULL');
  add('merchant_ref', "merchant_ref TEXT DEFAULT ''");
  add('source', "source TEXT DEFAULT ''");
  add('origin_store', "origin_store TEXT DEFAULT ''");
  add('query_order_id', "query_order_id TEXT DEFAULT ''"); // 升級前的付款：送給 LINE Pay 的 orderId（lp_order_id 因唯一索引加了尾碼時）
  add('confirm_state', 'confirm_state TEXT DEFAULT NULL');   // C5.3：never｜sent｜unknown（NULL＝C5.3 以前寫入、尚未判定）
  add('failure_basis', "failure_basis TEXT DEFAULT ''");     // C5.3：判定未付款（failed）的依據；空白＝沒有可靠依據
  add('quarantined_from', "quarantined_from TEXT DEFAULT ''"); // C5.3：歷史隔離前的狀態（例如 failed:1152）
  raw.run('CREATE INDEX IF NOT EXISTS idx_lpa_open ON linepay_payment_attempts(status, next_check_at)');
  raw.run(`CREATE TABLE IF NOT EXISTS payment_side_effects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL,
    order_uuid   TEXT NOT NULL,
    attempt_uuid TEXT DEFAULT '',
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    tries        INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    done_at      TEXT DEFAULT NULL
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pse_order_kind ON payment_side_effects(store_id, order_uuid, kind)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_pse_pending ON payment_side_effects(status, store_id)');
  // 回退保護：資料庫中的觸發器在任何版本執行時都會生效。若回退到 C5.1 期間有付款嘗試被舊版寫成
  // confirming／confirmed／confirmed_duplicate（C5.2 從不寫這些狀態），就把它標回「升級前格式」（state_version=0），
  // 再次升級到 C5.2 時依下方規則重新判定（例如舊版標成 failed 的已付款交易會轉為待核對，而不是一直停在失敗）。
  raw.run(`CREATE TRIGGER IF NOT EXISTS trg_lpa_legacy_writer AFTER UPDATE OF status ON linepay_payment_attempts
           WHEN NEW.status IN ('confirming','confirmed','confirmed_duplicate') AND COALESCE(NEW.state_version,0)<>0
           BEGIN UPDATE linepay_payment_attempts SET state_version=0 WHERE id=NEW.id; END`);
  // C5.3：沒有可靠依據的 failed（例如 C5.2 對 1152／未知代碼、舊付款 callback、人工標記未付款）與送過 Confirm 的取消中止，
  // 一律轉為待核對（不論由哪個版本寫入、插入或更新）。官方明確拒絕且為可信第一次 Confirm 者、未送出 Confirm 者、已付款者不受影響。
  const qWhen = (n) => `(${n}.status='failed' AND COALESCE(${n}.transaction_id,'')<>'' AND COALESCE(${n}.failure_basis,'')='' AND COALESCE(${n}.origin_store,'')=''
      AND COALESCE(${n}.result_code,'')<>'amount_changed'
      AND NOT (COALESCE(${n}.result_code,'') IN (${DEFINITIVE_DECLINE_CODES.map((c) => `'${c}'`).join(',')}) AND COALESCE(${n}.confirm_calls,0)=1 AND ${FIRST_CONFIRM_SOURCES_SQL.replace(/%s/g, n).replace(/%%/g, '%')}))
    OR (${n}.status='aborted_cancelled' AND COALESCE(${n}.confirm_calls,0)>0 AND COALESCE(${n}.failure_basis,'')='' AND COALESCE(${n}.origin_store,'')='')`;
  const qSet = (n) => `status='review', review_reason='c53_quarantine:'||${n}.status||':'||COALESCE(${n}.result_code,''), quarantined_from=${n}.status||':'||COALESCE(${n}.result_code,''),
      confirm_state='unknown', next_check_at=NULL, updated_at=datetime('now')`;
  raw.run('DROP TRIGGER IF EXISTS trg_lpa_c53_quarantine_upd');
  raw.run('DROP TRIGGER IF EXISTS trg_lpa_c53_quarantine_ins');
  raw.run(`CREATE TRIGGER trg_lpa_c53_quarantine_upd AFTER UPDATE OF status ON linepay_payment_attempts WHEN ${qWhen('NEW')}
           BEGIN UPDATE linepay_payment_attempts SET ${qSet('NEW')} WHERE id=NEW.id; END`);
  raw.run(`CREATE TRIGGER trg_lpa_c53_quarantine_ins AFTER INSERT ON linepay_payment_attempts WHEN ${qWhen('NEW')}
           BEGIN UPDATE linepay_payment_attempts SET ${qSet('NEW')} WHERE id=NEW.id; END`);
  // C5.3：「從未送出 Confirm」只在付款嘗試仍為 requesting／requested 且 confirm_calls=0 時成立；任何版本（含回退後的舊版）
  // 送出 Confirm 或改變狀態，都會自動撤銷這個證明（改為 unknown），之後只能唯讀核對。
  raw.run('DROP TRIGGER IF EXISTS trg_lpa_c53_never_guard');
  raw.run(`CREATE TRIGGER trg_lpa_c53_never_guard AFTER UPDATE ON linepay_payment_attempts
           WHEN NEW.confirm_state='never' AND (COALESCE(NEW.confirm_calls,0)>0 OR NEW.status NOT IN ('requesting','requested'))
           BEGIN UPDATE linepay_payment_attempts SET confirm_state='unknown' WHERE id=NEW.id; END`);
  // C5.1 留下的付款嘗試：不憑狀態名稱推定未付款
  //   confirmed → paid；confirmed_duplicate → paid_duplicate；confirming（結果不明）→ review；
  //   failed 且有交易識別（C5.1 對重複交易代碼、網路錯誤也標 failed）→ review（可用唯讀查詢核對）
  const legacy = rawAll(raw, 'SELECT id, status, transaction_id FROM linepay_payment_attempts WHERE COALESCE(state_version,0)=0');
  for (const r of legacy) {
    let st = r.status, reason = '';
    if (r.status === 'confirmed') st = 'paid';
    else if (r.status === 'confirmed_duplicate') { st = 'paid_duplicate'; reason = 'double_payment_needs_refund'; }
    else if (r.status === 'confirming') { st = 'review'; reason = 'upgrade_confirming_unknown'; }
    else if (r.status === 'failed' && r.transaction_id) { st = 'review'; reason = 'upgrade_failed_unverified'; }
    raw.run('UPDATE linepay_payment_attempts SET status=?, review_reason=CASE WHEN ?<>\'\' THEN ? ELSE review_reason END, state_version=2, confirm_state=\'unknown\' WHERE id=?', [st, reason, reason, r.id]);
  }
  // C5.3：C5.3 以前寫入的付款嘗試（confirm_state 為 NULL）判定處理階段
  //   C5.2 建立（state_version=2、來源為正式付款請求）且仍為 requesting／requested、confirm_calls=0 → never
  //   （C5.2 送出 Confirm 前一定先 durable 保存 confirm_pending 並累加 confirm_calls；回退到 C5.1 時另有觸發器把 state_version 改回 0）
  //   其他（舊付款 callback、C5.1 以前、匯入、任何已進入確認流程者）→ unknown
  const pre = rawAll(raw, 'SELECT id FROM linepay_payment_attempts WHERE confirm_state IS NULL');
  raw.run(`UPDATE linepay_payment_attempts SET confirm_state = CASE
             WHEN COALESCE(state_version,0)=2 AND status IN ('requesting','requested') AND COALESCE(confirm_calls,0)=0
                  AND ${FIRST_CONFIRM_SOURCES_SQL.replace(/%s\./g, '').replace(/%%/g, '%')} THEN 'never' ELSE 'unknown' END
           WHERE confirm_state IS NULL`);
  // 既有紀錄套用隔離規則（觸發器只處理之後的寫入；這裡處理已存在者；重複執行不會再改動已隔離或正常的紀錄）
  const qRows = rawAll(raw, `SELECT id FROM linepay_payment_attempts t WHERE ${qWhen('t')}`);
  for (const r of qRows) {
    raw.run(`UPDATE linepay_payment_attempts SET status='review', review_reason='c53_quarantine:'||status||':'||COALESCE(result_code,''),
               quarantined_from=status||':'||COALESCE(result_code,''), confirm_state='unknown', next_check_at=NULL, updated_at=datetime('now') WHERE id=?`, [r.id]);
  }
  raw.run("UPDATE linepay_payment_attempts SET state_version=3 WHERE COALESCE(state_version,0)=2");
  return { ok: true, upgraded: legacy.length, classified: pre.length, quarantined: qRows.length };
}

// ══════════════════════════════════════════════════════════════════════
//  讀寫輔助
// ══════════════════════════════════════════════════════════════════════
function getAttempt(db, storeId, attemptUuid) { return db.get('SELECT * FROM linepay_payment_attempts WHERE store_id=? AND attempt_uuid=?', [storeId, attemptUuid]) || null; }
function getOrder(db, storeId, orderUuid) { return db.get('SELECT * FROM orders WHERE store_id=? AND uuid=?', [storeId, orderUuid]) || null; }
const isCancelled = (o) => !!o && (o.order_status === 'cancelled' || o.status === 'void');
function backoffAt(count) { return utc(Date.now() + Math.min(60 * 2 ** Math.min(count, 6), 3600) * 1000); }
// 狀態更新：盡量 durable；失敗時不拋出（呼叫端依「資料庫中仍為 confirm_pending／review」可再次找到）
function setAttempt(db, storeId, attemptUuid, sets, params, durable = true) {
  const sql = `UPDATE linepay_payment_attempts SET ${sets}, updated_at=datetime('now') WHERE store_id=? AND attempt_uuid=?`;
  try {
    if (durable) db.runDurableTransaction(() => db._db.run(sql, [...params, storeId, attemptUuid]));
    else db.run(sql, [...params, storeId, attemptUuid]);
    return true;
  } catch (e) { return false; }
}
function setReview(db, storeId, a, reason, err) {
  return setAttempt(db, storeId, a.attempt_uuid, "status='review', review_reason=?, last_error=?, next_check_at=COALESCE(next_check_at, ?)",
    [String(reason || ''), String(err || '').slice(0, 200), backoffAt(Number(a.inquiry_count) || 0)]);
}

// ══════════════════════════════════════════════════════════════════════
//  官方唯讀查詢（Retrieve payment details：GET /v3/payments?transactionId=&orderId=）
//  簽章：Base64(HMAC-SHA256(ChannelSecret, ChannelSecret + path + queryString(不含 ?) + nonce))
//  已付款的判定必須全部成立：
//    returnCode='0000'；info 中「恰好一筆」transactionId（原始文字擷取，19 位不經 Number）＝付款嘗試保存值；
//    orderId＝付款嘗試送出的 orderId；transactionType='PAYMENT'；currency＝付款嘗試幣別；
//    payInfo 金額合計＝付款嘗試金額；沒有退款紀錄（有退款 → 需人工核對）
// ══════════════════════════════════════════════════════════════════════
async function inquire(db, cfg, a) {
  if (!cfg || !cfg.channelId || !cfg.channelSecret) return { result: 'error', detail: 'config_missing' };
  if (a.merchant_ref && a.merchant_ref !== cfg.channelId) return { result: 'mismatch', detail: 'merchant_changed' };
  if (!a.transaction_id || !OI.TX_RE.test(String(a.transaction_id))) return { result: 'error', detail: 'no_transaction_id' };
  if (!validAmount(Number(a.amount)) || !(Number(a.amount) > 0)) return { result: 'error', detail: 'attempt_amount_invalid' };
  const uri = '/v3/payments';
  const lpOid = String(a.query_order_id || a.lp_order_id || '');
  if (!lpOid) return { result: 'error', detail: 'no_order_id' };
  const qs = `transactionId=${encodeURIComponent(String(a.transaction_id))}&orderId=${encodeURIComponent(lpOid)}`;
  const nonce = crypto.randomUUID();
  const { signature } = signLinePayGet(cfg.channelSecret, uri, qs, nonce);
  let data = null;
  try {
    const res = await fetch(`${cfg.apiBase}${uri}?${qs}`, { method: 'GET', headers: makeGetHeaders(cfg.channelId, signature, nonce), timeout: 20000 });
    ({ data } = await readResponse(res));
  } catch (e) { return { result: 'error', detail: 'inquiry_network' }; }
  if (!data || typeof data !== 'object') return { result: 'error', detail: 'inquiry_unparseable' };
  if (data.returnCode === '1150') return { result: 'not_found', detail: '1150' };
  if (data.returnCode !== '0000') return { result: 'error', detail: 'inquiry_code_' + String(data.returnCode || '') };
  if (!Array.isArray(data.info)) return { result: 'error', detail: 'info_missing' };
  if (!data.info.length) return { result: 'not_found', detail: 'empty' };
  const tx = String(a.transaction_id);
  const hits = data.info.filter((it) => it && typeof it === 'object' && String(it.transactionId) === tx);
  if (!hits.length) return { result: 'not_found', detail: 'transaction_not_listed' };
  if (hits.length !== 1) return { result: 'mismatch', detail: 'multiple_records' };
  const it = hits[0];
  if (typeof it.orderId !== 'string' || it.orderId !== lpOid) return { result: 'mismatch', detail: 'order_id_mismatch' };
  if (typeof it.transactionType !== 'string' || it.transactionType !== 'PAYMENT') return { result: 'mismatch', detail: 'transaction_type_' + (it.transactionType === undefined ? 'missing' : String(it.transactionType || 'empty')).slice(0, 20) };
  if (typeof it.currency !== 'string' || it.currency !== String(a.currency || 'TWD')) return { result: 'mismatch', detail: 'currency_mismatch' };
  const total = payInfoTotal(it.payInfo);
  if (total == null) return { result: 'mismatch', detail: 'pay_info_invalid' };
  if (total !== cents(a.amount)) return { result: 'mismatch', detail: 'amount_mismatch' };
  if (it.refundList !== undefined && it.refundList !== null && (!Array.isArray(it.refundList) || it.refundList.length)) return { result: 'mismatch', detail: 'refunded' };
  return { result: 'paid', detail: 'verified' };
}
function recordInquiry(db, storeId, a, inq) {
  const n = (Number(a.inquiry_count) || 0) + 1;
  setAttempt(db, storeId, a.attempt_uuid, "inquiry_count=?, last_inquiry_at=datetime('now'), last_inquiry_result=?, next_check_at=?",
    [n, `${inq.result}:${inq.detail}`.slice(0, 80), backoffAt(n)]);
  a.inquiry_count = n;
}

// ══════════════════════════════════════════════════════════════════════
//  核心提交（durable）：金流已付款 → 依「目前」訂單狀態完成本機紀錄
// ══════════════════════════════════════════════════════════════════════
function commitPaid(db, storeId, attemptUuid, tx) {
  let outcome = 'pending';
  let orderUuid = null;
  const hasTxCol = OI.hasLpTxCol(db);
  try {
    db.runDurableTransaction(() => {
      const raw = db._db;
      const a = rawGet(raw, 'SELECT * FROM linepay_payment_attempts WHERE store_id=? AND attempt_uuid=?', [storeId, attemptUuid]);
      if (!a) throw new Error('attempt_missing');
      orderUuid = a.order_uuid;
      if (PAID_STATES.has(a.status)) { outcome = a.status === 'paid' ? 'success' : 'paid_cancelled'; return; }
      if (a.status === 'paid_duplicate') { outcome = 'already_paid'; return; }
      const o = rawGet(raw, 'SELECT * FROM orders WHERE store_id=? AND uuid=?', [storeId, a.order_uuid]);
      if (!o) throw new Error('order_missing');
      const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
      const markTx = () => {
        if (hasTxCol) raw.run('UPDATE orders SET linepay_transaction_id=? WHERE store_id=? AND uuid=?', [String(tx), storeId, a.order_uuid]);
        else raw.run('UPDATE orders SET sync_status=? WHERE store_id=? AND uuid=?', [`linepay_paid:${tx}`, storeId, a.order_uuid]);
      };
      if (o.payment_status === 'paid' && String(o.linepay_transaction_id || '') !== String(tx)) {
        // 同一訂單已由另一筆交易付款：如實記錄（重複付款，需退款核對），不改訂單
        raw.run("UPDATE linepay_payment_attempts SET status='paid_duplicate', review_reason='double_payment_needs_refund', updated_at=datetime('now') WHERE id=?", [a.id]);
        outcome = 'already_paid'; return;
      }
      if (isCancelled(o)) {
        // 已取消／作廢：記錄已付款、保留履約狀態、標示待退款；不恢復出餐、不扣份數、不建立正常完成的副作用
        raw.run(`UPDATE orders SET payment_status='paid', refund_status='pending_refund', updated_at=? WHERE store_id=? AND uuid=?`, [now, storeId, a.order_uuid]);
        markTx();
        raw.run("UPDATE linepay_payment_attempts SET status='paid_cancelled', review_reason='paid_after_cancel_needs_refund', confirmed_at=datetime('now'), result_code='0000', updated_at=datetime('now') WHERE id=?", [a.id]);
        outcome = 'paid_cancelled'; return;
      }
      raw.run(`UPDATE orders SET payment_status='paid', status='pending', order_status='pending', kitchen_status='pending', updated_at=?
               WHERE store_id=? AND uuid=? AND COALESCE(payment_status,'')<>'paid'`, [now, storeId, a.order_uuid]);
      markTx();
      raw.run("UPDATE linepay_payment_attempts SET status='paid', review_reason='', confirmed_at=datetime('now'), result_code='0000', updated_at=datetime('now') WHERE id=?", [a.id]);
      const kinds = ['purchase', 'payment_success'];
      if (o.line_user_id) kinds.push('member_purchase');
      // R54.4／MBV2-HF1-C6.2：補貨登記份數連動（訂購中 → 已扣減）以 outbox 執行；更新失敗可補齊，不會再次送出 Confirm
      if (o.line_user_id) kinds.push('demand_settle');
      for (const k of kinds) {
        raw.run('INSERT OR IGNORE INTO payment_side_effects (store_id, order_uuid, attempt_uuid, kind) VALUES (?,?,?,?)', [storeId, a.order_uuid, a.attempt_uuid, k]);
      }
      outcome = 'success';
    });
  } catch (e) {
    return { outcome: 'pending', reason: 'local_commit_failed', error: e && e.message, orderUuid };
  }
  return { outcome, orderUuid };
}

// ══════════════════════════════════════════════════════════════════════
//  副作用（outbox）：逐項執行並核對實際保存結果
// ══════════════════════════════════════════════════════════════════════
function runSideEffects(db, storeId, orderUuid) {
  const rows = db.all("SELECT * FROM payment_side_effects WHERE store_id=? AND order_uuid=? AND status='pending' ORDER BY id", [storeId, orderUuid]);
  if (!rows.length) return { done: 0, pending: 0 };
  const order = getOrder(db, storeId, orderUuid);
  const { logServerEvent, getOrderTrackingContext } = require('./analyticsLog');
  let done = 0, pending = 0;
  const mark = (r, ok, err) => {
    if (ok) db.run("UPDATE payment_side_effects SET status='done', done_at=datetime('now'), updated_at=datetime('now'), tries=tries+1, last_error='' WHERE id=?", [r.id]);
    else db.run("UPDATE payment_side_effects SET tries=tries+1, last_error=?, updated_at=datetime('now') WHERE id=?", [String(err || '').slice(0, 200), r.id]);
  };
  for (const r of rows) {
    try {
      if (!order) { mark(r, false, 'order_missing'); pending++; continue; }
      if (r.kind === 'demand_settle') {
        // R54.4／MBV2-HF1-C6.2：依訂單「目前」後端狀態同步登記份數（已付款 → 扣減；已取消 → 解除訂購中）。可重複執行、只套用一次。
        const DS = require('./demandSettlement');
        DS.syncOrder(db, storeId, order.uuid, {});
        const left = db.get(`SELECT COUNT(*) AS c FROM ${DS.LINK_TABLE} WHERE store_id=? AND order_uuid=? AND state='reserved' AND COALESCE(import_source,'')=''`, [storeId, order.uuid]);
        const ok = !(left && Number(left.c) > 0) || (!isCancelled(order) && order.payment_status !== 'paid');
        mark(r, ok, ok ? '' : 'not_saved'); ok ? done++ : pending++;
        continue;
      }
      if (isCancelled(order) || order.payment_status !== 'paid') {
        // 已取消／作廢（或尚未付款）不視為正常完成，不補寫購買與會員消費
        db.run("UPDATE payment_side_effects SET status='skipped', last_error='order_not_payable_completion', updated_at=datetime('now') WHERE id=?", [r.id]);
        continue;
      }
      const ctx = getOrderTrackingContext(db, storeId, order.uuid) || {};
      const base = {
        store_id: storeId, visitor_id: ctx.visitor_id || `unknown_${order.uuid}`, session_id: ctx.session_id || `unknown_${order.uuid}`,
        cart_id: ctx.cart_id || null, order_id: order.uuid, order_mode: ctx.order_mode || order.order_mode || null,
        source: ctx.source || null, medium: ctx.medium || null, campaign: ctx.campaign || null, referrer: ctx.referrer || null,
        landing_page: ctx.landing_page || null, fbclid: ctx.fbclid || null, gclid: ctx.gclid || null,
        line_user_id: order.line_user_id || null, channel_source: 'line', fulfillment_type: order.fulfillment_type || null, order_source: order.order_source || null,
      };
      const evExists = (name) => !!db.get('SELECT 1 AS x FROM analytics_events WHERE store_id=? AND order_id=? AND event_name=? LIMIT 1', [storeId, order.uuid, name]);
      if (r.kind === 'purchase') {
        if (!evExists('purchase')) logServerEvent(db, { ...base, event_name: 'purchase', metadata: ctx.metadata_json || null });
        const ok = evExists('purchase'); mark(r, ok, ok ? '' : 'not_saved'); ok ? done++ : pending++;
      } else if (r.kind === 'payment_success') {
        if (!evExists('payment_success')) {
          logServerEvent(db, { ...base, event_name: 'payment_success', metadata: { order_number: order.order_number || null, payment_provider: 'linepay', payment_method: 'linepay', currency: 'TWD', value: Number(order.total || 0) } });
        }
        const ok = evExists('payment_success'); mark(r, ok, ok ? '' : 'not_saved'); ok ? done++ : pending++;
      } else if (r.kind === 'member_purchase') {
        if (!order.line_user_id) { mark(r, true); done++; continue; }
        const linkExists = () => !!db.get('SELECT 1 AS x FROM line_member_order_links WHERE store_id=? AND order_id=? LIMIT 1', [storeId, order.uuid]);
        if (!linkExists()) {
          // 會員消費：訂單關聯、累計消費、歷史紀錄在同一個 durable 交易（既有 recordMemberPurchase 會在關聯寫入後才更新累計，
          // 中途失敗會留下「已關聯但未累計」且無法重試；這裡改為原子寫入，失敗整筆回滾、下次可重試）
          const ev = memberPurchaseAtomic(db, storeId, order.line_user_id, order.uuid, Number(order.total || 0));
          if (ev) {
            logServerEvent(db, { store_id: storeId, visitor_id: `member_${order.line_user_id}`, session_id: `member_${order.line_user_id}`, order_id: order.uuid,
              event_name: ev === 'first_purchase' ? 'member_first_purchase' : 'member_repeat_purchase', order_mode: order.order_mode || null,
              line_user_id: order.line_user_id, channel_source: 'line', fulfillment_type: order.fulfillment_type || null, order_source: order.order_source || null });
          }
        }
        const ok = linkExists(); mark(r, ok, ok ? '' : 'not_saved'); ok ? done++ : pending++;
      } else { mark(r, true); done++; }
    } catch (e) { try { mark(r, false, e && e.message); } catch {} pending++; }
  }
  return { done, pending };
}

function memberPurchaseAtomic(db, storeId, lineUserId, orderUuid, amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return false;
  let ev = false;
  db.runDurableTransaction(() => {
    const raw = db._db;
    if (rawGet(raw, 'SELECT 1 AS x FROM line_member_order_links WHERE store_id=? AND order_id=?', [storeId, orderUuid])) return;
    raw.run('INSERT INTO line_member_order_links (store_id, line_user_id, order_id) VALUES (?,?,?)', [storeId, lineUserId, String(orderUuid).slice(0, 100)]);
    const m = rawGet(raw, 'SELECT first_purchase_at FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!m) return;
    const isFirst = !m.first_purchase_at;
    raw.run(`UPDATE line_members SET order_count = order_count + 1, total_spent = total_spent + ?, lifetime_value = lifetime_value + ?,
               first_purchase_at = CASE WHEN first_purchase_at IS NULL OR first_purchase_at='' THEN datetime('now','localtime') ELSE first_purchase_at END,
               last_purchase_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
             WHERE store_id=? AND line_user_id=?`, [amt, amt, storeId, lineUserId]);
    ev = isFirst ? 'first_purchase' : 'repeat_purchase';
    raw.run(`INSERT INTO line_member_history (store_id, line_user_id, event_name, old_value, new_value, metadata_json) VALUES (?,?,?,?,?,?)`,
      [storeId, lineUserId, ev, '', String(amt), JSON.stringify({ order_id: orderUuid })]);
  });
  return ev;
}

// ══════════════════════════════════════════════════════════════════════
//  付款處理（callback 與後台核對共用）
//    只有「可信紀錄證明從未送出 Confirm」的付款嘗試，且為顧客付款 callback（allowConfirm=true）才會送出第一次 Confirm。
//    其他情況（曾送出或可能已送出、舊付款、匯入、隔離、處理階段不明）一律只做唯讀核對；allowConfirm 不能繞過這個保護。
//  回傳 outcome：success｜paid_cancelled｜order_cancelled｜pending｜failed｜already_paid｜amount_changed
// ══════════════════════════════════════════════════════════════════════
function confirmNeverSent(a) {
  return !!a && a.confirm_state === 'never' && ['requesting', 'requested'].includes(String(a.status)) && Number(a.confirm_calls || 0) === 0;
}
async function settle(db, cfg, storeId, attemptUuid, opts = {}) {
  const tx = String(opts.tx || '');
  const allowConfirm = !!opts.allowConfirm;
  if (_inflight.has(attemptUuid)) return { outcome: 'pending', reason: 'in_progress' };
  _inflight.add(attemptUuid);
  try {
    let a = getAttempt(db, storeId, attemptUuid);
    if (!a) return { outcome: 'pending', reason: 'attempt_missing' };
    let o = getOrder(db, storeId, a.order_uuid);
    if (!o) return { outcome: 'pending', reason: 'order_missing' };
    const txId = tx || String(a.transaction_id || '');
    if (a.status === 'paid') { runSideEffects(db, storeId, o.uuid); return { outcome: 'success', order: o }; }
    if (a.status === 'paid_cancelled') return { outcome: 'paid_cancelled', order: o };
    if (a.status === 'paid_duplicate') return { outcome: 'already_paid', order: o };
    if (a.status === 'aborted_cancelled') return { outcome: 'order_cancelled', order: o };
    if (a.status === 'imported_history') return { outcome: 'pending', reason: 'imported_history', order: o };
    if (a.status === 'failed') return { outcome: 'failed', code: a.result_code || '', order: o };
    if (a.transaction_id && txId !== String(a.transaction_id)) return { outcome: 'pending', reason: 'transaction_mismatch', order: o };
    // 已由這筆交易付款（例如核心已提交、付款嘗試狀態未及更新）
    if (o.payment_status === 'paid' && String(o.linepay_transaction_id || '') === txId && txId) {
      const r = commitPaid(db, storeId, a.attempt_uuid, txId);
      if (r.outcome === 'success') runSideEffects(db, storeId, o.uuid);
      return { ...r, order: getOrder(db, storeId, o.uuid) };
    }
    if (a.merchant_ref && cfg && cfg.channelId !== a.merchant_ref) { setReview(db, storeId, a, 'merchant_changed'); return { outcome: 'pending', reason: 'merchant_changed', order: o }; }
    const verifyByInquiry = async (reason) => {
      const a2 = getAttempt(db, storeId, attemptUuid) || a;
      const inq = await inquire(db, cfg, a2);
      recordInquiry(db, storeId, a2, inq);
      if (inq.result === 'paid') {
        const r = commitPaid(db, storeId, a2.attempt_uuid, a2.transaction_id);
        if (r.outcome === 'pending') { setReview(db, storeId, a2, 'local_commit_failed', r.error); return { ...r, order: getOrder(db, storeId, a2.order_uuid) }; }
        if (r.outcome === 'success') runSideEffects(db, storeId, a2.order_uuid);
        return { ...r, order: getOrder(db, storeId, a2.order_uuid) };
      }
      // 查無、空清單、timeout、網路錯誤、解析失敗、欄位不符：都不是「確定未付款」→ 維持待核對（重新付款維持阻擋）
      setReview(db, storeId, a2, (reason ? reason + '|' : '') + 'inquiry_' + inq.result + ':' + inq.detail);
      return { outcome: 'pending', reason: reason || 'inquiry_' + inq.result, order: getOrder(db, storeId, a2.order_uuid) };
    };
    // 不能證明從未送出 Confirm（含舊付款 callback、歷史匯入、隔離、待核對、已保存處理階段）→ 只做唯讀核對
    if (!confirmNeverSent(a)) {
      if (!a.transaction_id) { setReview(db, storeId, a, 'no_transaction_id'); return { outcome: 'pending', reason: 'no_transaction_id', order: o }; }
      return verifyByInquiry(a.confirm_state === 'unknown' && a.source === 'legacy_callback' ? 'legacy_unverified' : '');
    }
    if (!allowConfirm) return { outcome: 'pending', reason: 'confirm_not_allowed', order: o };
    // B1：送出 Confirm 前重新讀取目前訂單與付款嘗試（同步，與保存、送出之間沒有 await）
    a = getAttempt(db, storeId, attemptUuid); o = getOrder(db, storeId, a.order_uuid);
    if (!confirmNeverSent(a)) return verifyByInquiry('');
    if (o.payment_status === 'paid') {
      return { outcome: String(o.linepay_transaction_id || '') === txId ? 'success' : 'already_paid', order: o };
    }
    if (isCancelled(o)) {
      setAttempt(db, storeId, a.attempt_uuid, "status='aborted_cancelled', review_reason='order_cancelled_before_confirm', failure_basis='cancelled_before_confirm'", []);
      return { outcome: 'order_cancelled', order: o };
    }
    if (!txId || !OI.TX_RE.test(txId)) return { outcome: 'pending', reason: 'transaction_missing', order: o };
    if (cents(a.amount) !== cents(o.total || 0) || !(Number(a.amount) > 0)) {
      setAttempt(db, storeId, a.attempt_uuid, "status='failed', result_code='amount_changed', failure_basis='amount_changed_before_confirm'", []);
      return { outcome: 'amount_changed', order: o };
    }
    // C1／F1：送出前先 durable 保存處理階段（條件式：必須仍是「從未送出」的那一列）；失敗或沒有改到列 → 不呼叫外部 Confirm
    let claimed = false;
    try {
      db.runDurableTransaction(() => {
        db._db.run(`UPDATE linepay_payment_attempts SET status='confirm_pending', confirm_state='sent', confirm_calls=COALESCE(confirm_calls,0)+1,
                    transaction_id=CASE WHEN COALESCE(transaction_id,'')='' THEN ? ELSE transaction_id END, next_check_at=?, updated_at=datetime('now')
                    WHERE store_id=? AND attempt_uuid=? AND confirm_state='never' AND status IN ('requesting','requested') AND COALESCE(confirm_calls,0)=0`,
        [txId, backoffAt(0), storeId, a.attempt_uuid]);
        claimed = db._db.getRowsModified() === 1;
        if (!claimed) throw new Error('confirm_claim_lost');
      });
    } catch (e) {
      if (!claimed) {
        const cur = getAttempt(db, storeId, attemptUuid);
        // 另一個處理已取得（例如另一個程序）：只做唯讀核對；保存本身失敗：維持原狀（從未送出），本次不送 Confirm
        if (cur && !confirmNeverSent(cur)) return verifyByInquiry('');
        return { outcome: 'pending', reason: 'pre_confirm_save_failed', order: o };
      }
      return { outcome: 'pending', reason: 'pre_confirm_save_failed', order: o };
    }
    a = getAttempt(db, storeId, attemptUuid);
    // 外部 Confirm（等待期間不持有交易）
    const uri = `/v3/payments/${txId}/confirm`;
    const body = { amount: Number(a.amount), currency: a.currency || 'TWD' };
    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, body, nonce);
    let data = null, netErr = null;
    try {
      const res = await fetch(cfg.apiBase + uri, { method: 'POST', headers: makePostHeaders(cfg.channelId, signature, nonce), body: bodyStr, timeout: 40000 });
      ({ data } = await readResponse(res));
    } catch (e) { netErr = e; }
    if (netErr || !data || typeof data !== 'object') return verifyByInquiry(netErr ? 'confirm_no_response' : 'confirm_unparseable');
    const code = String(data.returnCode == null ? '' : data.returnCode);
    if (code === '0000') {
      // 依官方 Confirm 回應結構核對：info.transactionId、info.orderId、info.payInfo[].amount；缺任何一項或不符 → 唯讀核對
      const info = data.info && typeof data.info === 'object' && !Array.isArray(data.info) ? data.info : null;
      const total = info ? payInfoTotal(info.payInfo) : null;
      const complete = !!info && info.transactionId != null && typeof info.orderId === 'string' && total != null;
      const ok = complete && String(info.transactionId) === txId && info.orderId === String(a.query_order_id || a.lp_order_id) && total === cents(a.amount);
      if (!ok) return verifyByInquiry(complete ? 'confirm_response_mismatch' : 'confirm_response_incomplete');
      const r = commitPaid(db, storeId, a.attempt_uuid, txId);
      if (r.outcome === 'pending') { setReview(db, storeId, a, 'local_commit_failed', r.error); return { ...r, order: getOrder(db, storeId, a.order_uuid) }; }
      if (r.outcome === 'success') runSideEffects(db, storeId, a.order_uuid);
      return { ...r, order: getOrder(db, storeId, a.order_uuid) };
    }
    if (DECLINE_SET.has(code)) {
      // 可信的第一次 Confirm 被官方明確拒絕：這筆交易沒有完成請款，之後也不會再對它送 Confirm → 判定未付款
      setAttempt(db, storeId, a.attempt_uuid, "status='failed', result_code=?, last_error='', failure_basis=?", [code, 'first_confirm_declined:' + code]);
      return { outcome: 'failed', code, order: o };
    }
    // 重複交易、處理中、暫時無法處理、內部錯誤、未知代碼：不足以判斷交易終態 → 唯讀核對
    return verifyByInquiry('confirm_code_' + code);
  } finally { _inflight.delete(attemptUuid); }
}

// 升級前（沒有付款嘗試）的付款 callback：建立對應的付款嘗試後走同一流程
function ensureLegacyAttempt(db, storeId, order, lpOrderId, tx, cfg) {
  const ex = db.get('SELECT * FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=? AND transaction_id=?', [storeId, order.uuid, String(tx)]);
  if (ex) return ex;
  const au = crypto.randomUUID();
  let lpid = String(lpOrderId);
  if (db.get('SELECT 1 AS x FROM linepay_payment_attempts WHERE store_id=? AND lp_order_id=?', [storeId, lpid])) lpid = `${lpid}#legacy-${au.slice(0, 8)}`;
  // merchant_ref 留空：升級前的付款請求不知道當時的商家設定（核對時以目前設定查詢，查不到即保留待核對）
  db.run(`INSERT INTO linepay_payment_attempts (attempt_uuid, store_id, order_uuid, order_number, lp_order_id, query_order_id, transaction_id, amount, currency, channel, status, state_version, merchant_ref, source)
          VALUES (?,?,?,?,?,?,?,?,'TWD','line_order','requested',3,'','legacy_callback')`,
  [au, storeId, order.uuid, String(order.order_number || ''), lpid, String(lpOrderId), String(tx), Number(order.total || 0)]);
  // C5.3：升級前的付款沒有可靠處理階段（本機第一次記錄 ≠ 金流端第一次 Confirm）→ unknown，只能唯讀核對
  db.run("UPDATE linepay_payment_attempts SET confirm_state='unknown' WHERE store_id=? AND attempt_uuid=?", [storeId, au]);
  void cfg;
  return getAttempt(db, storeId, au);
}

// ══════════════════════════════════════════════════════════════════════
//  後台核對／啟動補齊
// ══════════════════════════════════════════════════════════════════════
async function reconcile(db, getCfg, storeId, opts = {}) {
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(opts.limit) || 10)));
  const lock = _storeLock.get(storeId) || { running: false, lastInquiryRun: 0 };
  _storeLock.set(storeId, lock);
  if (lock.running) return { busy: true };
  const now = Date.now();
  const doInquiry = !!opts.inquire;
  // 頻率限制：整店批次核對 20 秒一次；指定單筆核對同一筆 10 秒一次
  if (doInquiry && !opts.attempt_uuid && now - lock.lastInquiryRun < 20000) return { rate_limited: true, retry_after_ms: 20000 - (now - lock.lastInquiryRun) };
  if (doInquiry && opts.attempt_uuid) {
    const last = _attemptLast.get(String(opts.attempt_uuid)) || 0;
    if (now - last < 10000) return { rate_limited: true, retry_after_ms: 10000 - (now - last) };
    _attemptLast.set(String(opts.attempt_uuid), now);
    if (_attemptLast.size > 5000) _attemptLast.clear();
  }
  lock.running = true;
  const out = { checked: 0, recovered: 0, paid_cancelled: 0, still_review: 0, side_effects_done: 0, side_effects_pending: 0, skipped_in_progress: 0 };
  try {
    if (doInquiry) {
      if (!opts.attempt_uuid) lock.lastInquiryRun = now;
      const cfg = getCfg(storeId);
      const force = opts.attempt_uuid ? ' AND attempt_uuid=?' : " AND (next_check_at IS NULL OR next_check_at<=datetime('now')) AND COALESCE(inquiry_count,0) < " + MAX_AUTO_INQUIRIES;
      const params = opts.attempt_uuid ? [storeId, String(opts.attempt_uuid), limit] : [storeId, limit];
      // 未指定付款嘗試時，只處理 30 秒以上未更新者（避免與進行中的 callback 重疊）；指定時由店家明確發起
      const age = opts.attempt_uuid ? '' : " AND updated_at <= datetime('now','-30 seconds')";
      const rows = db.all(`SELECT attempt_uuid FROM linepay_payment_attempts WHERE store_id=? AND status IN ('confirm_pending','review')${age}${force} ORDER BY id LIMIT ?`, params);
      for (const r of rows) {
        if (_inflight.has(r.attempt_uuid)) { out.skipped_in_progress++; continue; }
        out.checked++;
        const res = await settle(db, cfg, storeId, r.attempt_uuid, { allowConfirm: false });
        // R54.4／MBV2-HF1-C6.2：補貨登記份數同步（fail-open、可重複）
        try { const a2 = getAttempt(db, storeId, r.attempt_uuid); if (a2) require('./demandSettlement').safeSync(db, storeId, a2.order_uuid, {}, 'linepay_reconcile'); } catch {}
        if (res.outcome === 'success') out.recovered++;
        else if (res.outcome === 'paid_cancelled') out.paid_cancelled++;
        else out.still_review++;
      }
    }
    const se = db.all("SELECT DISTINCT order_uuid FROM payment_side_effects WHERE store_id=? AND status='pending' LIMIT ?", [storeId, limit]);
    for (const r of se) { const x = runSideEffects(db, storeId, r.order_uuid); out.side_effects_done += x.done; out.side_effects_pending += x.pending; }
  } finally { lock.running = false; }
  return out;
}
// 啟動後與定期：只補齊本機副作用（不呼叫外部 API）
function sweepSideEffects(db, limit = 50) {
  const stores = db.all("SELECT DISTINCT store_id FROM payment_side_effects WHERE status='pending' LIMIT 20");
  let done = 0, pending = 0;
  for (const s of stores) {
    const se = db.all("SELECT DISTINCT order_uuid FROM payment_side_effects WHERE store_id=? AND status='pending' LIMIT ?", [s.store_id, limit]);
    for (const r of se) { const x = runSideEffects(db, s.store_id, r.order_uuid); done += x.done; pending += x.pending; }
  }
  return { done, pending };
}
function listReview(db, storeId, limit = 100) {
  const attempts = db.all(`SELECT a.attempt_uuid, a.order_uuid, a.order_number, a.lp_order_id, a.amount, a.currency, a.status, a.review_reason, a.result_code,
                                  a.confirm_calls, a.inquiry_count, a.last_inquiry_at, a.last_inquiry_result, a.next_check_at, a.created_at, a.updated_at,
                                  a.source, a.confirm_state, a.quarantined_from, o.payment_status, o.order_status, o.status AS order_record_status, o.refund_status,
                                  CASE WHEN COALESCE(a.transaction_id,'')<>'' THEN 1 ELSE 0 END AS has_transaction
                           FROM linepay_payment_attempts a LEFT JOIN orders o ON o.store_id=a.store_id AND o.uuid=a.order_uuid
                           WHERE a.store_id=? AND (a.status IN ('confirm_pending','review','paid_duplicate','imported_history') OR a.status='paid_cancelled' AND COALESCE(o.refund_status,'')='pending_refund')
                           ORDER BY a.id DESC LIMIT ?`, [storeId, Math.max(1, Math.min(500, Number(limit) || 100))]);
  const se = db.all("SELECT order_uuid, kind, tries, last_error, updated_at FROM payment_side_effects WHERE store_id=? AND status='pending' ORDER BY id LIMIT 200", [storeId]);
  return { attempts: attempts.map((r) => ({ ...r, blocks_repay: ['confirm_pending', 'review', 'paid_duplicate'].includes(r.status),
    needs_manual: Number(r.inquiry_count) >= MAX_AUTO_INQUIRIES || r.status === 'paid_duplicate' || r.status === 'imported_history' || !!r.quarantined_from })), side_effects_pending: se };
}
// C5.3：停用「查無交易＋經過時間（＋人工備註）」即可標記未付款的能力。
// 查無交易、等待時間、人工備註或管理者確認，都不能單獨證明原交易已終止；目前沒有採用可證明終態的官方唯讀介面，
// 因此一律拒絕（舊版前端呼叫既有 API 也一樣），付款維持待核對、重新付款維持阻擋。
const NO_TERMINAL_EVIDENCE_MESSAGE = '目前無法確認付款結果，請勿重新付款。查無交易、等待時間或人工備註都不足以證明原交易已終止，付款維持待核對。';
function markUnpaid(db, storeId, attemptUuid, note) {
  void note;
  const a = getAttempt(db, storeId, attemptUuid);
  if (!a) return { ok: false, code: 404, error: 'NOT_FOUND', message: '找不到付款嘗試' };
  return { ok: false, code: 409, error: 'TERMINAL_EVIDENCE_REQUIRED', message: NO_TERMINAL_EVIDENCE_MESSAGE };
}
function isUnderReview(db, storeId, orderUuid) {
  return !!db.get("SELECT 1 AS x FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=? AND status IN ('confirm_pending','review','paid_duplicate') LIMIT 1", [storeId, orderUuid]);
}

module.exports = {
  AMBIGUOUS_CODES, DEFINITIVE_DECLINE_CODES, NO_TERMINAL_EVIDENCE_MESSAGE, MAX_AUTO_INQUIRIES, migrate, inquire, commitPaid, runSideEffects, settle, ensureLegacyAttempt,
  safeParseLinePay, confirmNeverSent,
  reconcile, sweepSideEffects, listReview, markUnpaid, isUnderReview, _inflight,
};
