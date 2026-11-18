#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge.js
// R54.4／MBV2-HF1-C5.4.2 補修（PAYMENT_GUARD_TIME_MERGE_FIX）重現／驗收：同一組斷言先跑未修改 C5.4.2，再跑補修版。
//   A 付款防護：同店同單「全部」付款紀錄決定付款狀態與操作許可（付款摘要、建立付款、Confirm、改現金、到期整理）。
//   B 時間標記合併：MBV2 匯入時「時間值 ↔ 來源標記」成對處理（created_at↔popup_created_tz、updated_at↔popup_updated_tz）。
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome；[FX] 直接寫入資料庫的歷史／多筆付款 fixture
//   （正常操作無法在同一張訂單產生多筆付款紀錄，明確標示；其餘狀態一律由正式流程產生）；[DB] 資料庫欄位核對；[CLK] 可控時鐘。
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截並記錄 Request／Confirm／Inquiry 次數；真實呼叫必須 0。
// 分類：DE＝C5.4.2 既有缺口；G＝既有正確行為的回歸保護。判定一律依 API 回應、資料庫欄位或畫面文字。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RealDate = Date;
const C45 = require('./lib/c45-common');
const { H, STORE, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c542g-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCount = () => { const c = lpCalls(); return { request: c.filter((x) => /\/request$/.test(x.uri)).length, confirm: c.filter((x) => /\/confirm$/.test(x.uri)).length, inquiry: c.filter((x) => x.uri === '/v3/payments' && x.method === 'GET').length }; };
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const ONLY = (process.env.C542G_ONLY || '').split(',').filter(Boolean);
const META = {}; const LOGS = {};
async function step(name, cls, fn) {
  if (ONLY.length && !ONLY.some((p) => name.startsWith(p))) return;
  META[name] = { cls };
  try { await fn(); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [731, '快閃測試品', 1, 'available', { quota: 900, price: 90 }]];
const SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 60, allow_fallback_cash: true, expire_cancel_release: true };
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c542g','test-secret-c542g')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(SETTINGS)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};
const env = (off, tz) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
  C4_CLOCK_OFFSET_MS: String(off), TZ: tz, C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
  C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-c542g': 'test-secret-c542g' }) });
const offAt = (iso) => Date.parse(iso) - RealDate.now();
const mask = (s) => String(s || '').replace(/token=[0-9a-f]+/g, 'token=***').replace(/"token":"[0-9a-f]+"/g, '"token":"***"').replace(/cb=[0-9a-f]+/g, 'cb=***');

function kit(C, getSC) {
  const K = {};
  K.adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
  K.q = async (sql, p) => { await sleep(200); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
  K.order = async (o = {}) => {
    const r = await fetch(`${C.s.base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c542g' + crypto.randomBytes(10).toString('hex') },
      body: JSON.stringify({ popup_session_public_code: getSC(), customer_name: o.name || '防護測試', customer_phone: o.phone || '0966111222', payment_method: o.pay || 'linepay', items: [{ product_id: 731, qty: 1 }] }) });
    const j = await r.json(); if (!j.success) throw new Error('checkout ' + JSON.stringify(j).slice(0, 200)); return j.data;
  };
  K.request = async (token) => {
    const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json, call: r.status === 200 ? lpCalls().filter((c) => /request$/.test(c.uri)).pop() : null };
  };
  K.cb = async (call) => { const u = new URL(call.confirmUrl); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  K.cancelCb = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  K.status = async (token) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/status?token=${token}`); return (await r.json()).data; };
  K.cash = async (token) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  K.reconcile = async (attemptId) => K.adm('POST', '/api/linepay-admin/reconcile', { popup_attempt_id: attemptId });
  K.snap = async (orderId) => {
    const o = (await K.q('SELECT payment_method, payment_status, order_status, refund_status FROM orders WHERE id=?', [orderId]))[0];
    const a = await K.q('SELECT attempt_id, status, confirm_state, confirm_calls, transaction_id FROM popup_payment_attempts WHERE order_id=? ORDER BY rowid', [orderId]);
    const al = await K.q('SELECT status, stock_state FROM popup_order_allocations WHERE order_id=? ORDER BY id', [orderId]);
    return { o, a, al };
  };
  return K;
}
async function mkSession(K, name, pickupDate, cutoff) {
  const camp = await K.adm('POST', '/api/popup-pickup/campaigns', { name: name + ' 活動', status: 'published' });
  const loc = await K.adm('POST', '/api/popup-pickup/locations', { name: name + ' 地點', address: '台北市中正區測試路1號', lat: 25.04, lng: 121.51 });
  const s = await K.adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name, status: 'published', pickup_date: pickupDate, pickup_start_time: '17:00', pickup_end_time: '19:00',
    order_open_at: '2026-01-01T00:00', order_cutoff_at: cutoff, location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 900 });
  if (!s.json || !s.json.success) throw new Error('session ' + JSON.stringify(s.json).slice(0, 200));
  return s.json.data.public_code;
}
// [FX] 在同一張訂單新增一筆付款紀錄（複製該單第一筆，換識別與 token；rowid 較大＝較新）
function fxAddAttempt(db, orderId, over) {
  const src = db.exec('SELECT * FROM popup_payment_attempts WHERE order_id=? ORDER BY rowid LIMIT 1', [orderId])[0];
  const cols = src.columns; const row = {}; cols.forEach((c, i) => { row[c] = src.values[0][i]; });
  const token = crypto.randomBytes(24).toString('hex');
  Object.assign(row, { attempt_id: crypto.randomUUID(), token_hash: crypto.createHash('sha256').update(token).digest('hex'), status: 'pending', transaction_id: '', fail_reason: '', confirm_state: 'never', confirm_calls: 0,
    failure_basis: '', review_reason: '', result_code: '', merchant_ref: '', quarantined_from: '', fulfillment_closed: 0, inquiry_count: 0, last_inquiry_at: null, last_inquiry_result: '', next_check_at: null, confirmed_at: null }, over || {});
  if ('cb_hash' in row) row.cb_hash = ''; // 尚未發出 callback nonce（NOT NULL 欄位，空字串＝無）
  const use = cols.filter((c) => c in row);
  db.run(`INSERT INTO popup_payment_attempts (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`, use.map((c) => row[c]));
  return { attempt_id: row.attempt_id, token };
}
const dropOrderTimeTriggers = (db) => {
  const r = db.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name='orders' OR tbl_name='popup_payment_attempts') AND sql LIKE '%popup_updated_tz%'");
  (r[0] ? r[0].values : []).forEach((v) => db.run(`DROP TRIGGER IF EXISTS "${v[0]}"`));
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4.2 補修：整單付款防護＋時間標記合併 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = []; let browser = null;
  try {
    if (chromium) browser = await chromium.launch(C45.launchOpts());
    // ══════════════════════ A：付款防護（主機 TZ=UTC；台北 10:30；付款期限 60 分鐘）══════════════════════
    const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return h * 3600e3 + m * 60e3 - cur; };
    let OFF = TP(10, 30);
    const C = await C45.boot('c542ga', { products: PRODUCTS, members: 3, settings: {}, seed, env: env(OFF, 'UTC') }); boots.push(C);
    await C.restart(env(OFF, 'UTC')); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const day = (n) => new Date(RealDate.now() + OFF + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    let SC = null; const K = kit(C, () => SC);
    SC = await mkSession(K, 'C542G 場次', day(2), day(1) + 'T23:00');
    const editDb = async (fn) => { await C.s.stop(); try { const db = await H.openDbFile(C.dbf); try { const out = await fn(db); H.saveDbFile(db, C.dbf); return out; } finally { db.close(); } } finally { await C.restart(env(OFF, 'UTC')); C.tok = await H.login(C.s.base, STORE, 'pw001'); } };
    lpCtrl({});
    const F = {};
    // ── 由正式流程建立各訂單的「第一筆」付款狀態 ──
    F.rv = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.rv.payment.token); await K.cb(r.call); lpCtrl({}); }          // 第一筆＝review（正式流程）
    F.cp = await K.order(); { const r = await K.request(F.cp.payment.token); F.cp.call = r.call; }                                                               // 之後以 [FX] 設為 confirm_pending
    F.ps = await K.order(); { const r = await K.request(F.ps.payment.token); F.ps.call = r.call; }                                                               // [FX] pending/sent
    F.pu = await K.order(); { const r = await K.request(F.pu.payment.token); F.pu.call = r.call; }                                                               // [FX] pending/unknown
    F.rvNew = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.rvNew.payment.token); await K.cb(r.call); lpCtrl({}); } // review＋較新 pending/never
    F.cbo = await K.order();                                                                                                                                     // 舊付款連結／callback
    F.paid = await K.order(); { const r = await K.request(F.paid.payment.token); await K.cb(r.call); }                                                           // 第一筆＝已付款（正式流程）
    F.paidNew = await K.order(); { const r = await K.request(F.paidNew.payment.token); await K.cb(r.call); }                                                     // 已付款＋較新 pending/never
    F.race = await K.order(); { const r = await K.request(F.race.payment.token); F.race.call = r.call; }                                                         // 看到可改現金後另一筆變成待核對
    F.single = await K.order(); { const r = await K.request(F.single.payment.token); await K.cancelCb(r.call); }                                                 // 正常單一失敗
    F.normal = await K.order();                                                                                                                                  // 正常付款＋重複 callback
    F.rvOk = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.rvOk.payment.token); await K.cb(r.call); lpCtrl({}); }   // 待核對 → 核對成功
    F.rvCancel = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.rvCancel.payment.token); await K.cb(r.call); lpCtrl({}); } // 待核對 → 店家取消 → 晚到成功
    F.paidExp = await K.order(); { const r = await K.request(F.paidExp.payment.token); await K.cb(r.call); }                                                     // 已付款＋較新失敗 → 到期
    F.br = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.br.payment.token); await K.cb(r.call); lpCtrl({}); }      // 瀏覽器付款頁（review＋較新失敗）
    F.brRace = await K.order(); { const r = await K.request(F.brRace.payment.token); F.brRace.call = r.call; }                                                 // 瀏覽器：看到改現金後另一筆變成待核對
    F.rvExp = await K.order(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(F.rvExp.payment.token); await K.cb(r.call); lpCtrl({}); }  // review＋較新失敗 → 到期
    // ── [FX] 同單第二筆付款紀錄（及少數第一筆處理階段）──
    const X = await editDb((db) => {
      const out = {};
      const failedOver = { status: 'failed', fail_reason: 'customer_cancelled', failure_basis: 'customer_cancelled_before_confirm' };
      out.rv = fxAddAttempt(db, F.rv.id, failedOver);
      db.run("UPDATE popup_payment_attempts SET status='confirm_pending', confirm_state='sent', confirm_calls=1 WHERE attempt_id=?", [F.cp.payment.ref]); out.cp = fxAddAttempt(db, F.cp.id, failedOver);
      db.run("UPDATE popup_payment_attempts SET confirm_state='sent' WHERE attempt_id=?", [F.ps.payment.ref]); out.ps = fxAddAttempt(db, F.ps.id, failedOver);
      db.run("UPDATE popup_payment_attempts SET confirm_state='unknown' WHERE attempt_id=?", [F.pu.payment.ref]); out.pu = fxAddAttempt(db, F.pu.id, failedOver);
      out.rvNew = fxAddAttempt(db, F.rvNew.id, { transaction_id: '' });
      out.cbo = fxAddAttempt(db, F.cbo.id, {});
      out.paid = fxAddAttempt(db, F.paid.id, failedOver);
      out.paidNew = fxAddAttempt(db, F.paidNew.id, {});
      out.race = fxAddAttempt(db, F.race.id, failedOver);
      out.paidExp = fxAddAttempt(db, F.paidExp.id, failedOver);
      out.rvExp = fxAddAttempt(db, F.rvExp.id, failedOver);
      out.br = fxAddAttempt(db, F.br.id, failedOver);
      out.brRace = fxAddAttempt(db, F.brRace.id, failedOver);
      return out;
    });
    const ill = async (label, K2, fn) => { const before = lpCount(); const r = await fn(); await sleep(200); const after = lpCount(); return { r, lp: { before, after, same: JSON.stringify(before) === JSON.stringify(after) } }; };
    const blockCase = async (key) => {
      const before = await K.snap(F[key].id);
      const st = await K.status(X[key].token);
      const cash = await ill(key, K, () => K.cash(X[key].token));
      const after = await K.snap(F[key].id);
      return { st: { state: st.state, label: st.state_label, est: st.establishment_label, can_pay: st.can_pay, cash: st.can_switch_to_cash, under: st.under_review }, cash: cash.r.status, lpSame: cash.lp.same, unchanged: JSON.stringify(before) === JSON.stringify(after), before, after };
    };
    const blockedOk = (v) => v.st.state === 'payment_under_review' && v.st.label === v.st.est && v.st.under === true && v.st.can_pay === false && v.st.cash === false && v.cash === 409 && v.unchanged && v.lpSame
      && v.after.o.payment_method === 'linepay';
    await step('A1', 'DE', async () => {
      const v = await blockCase('rv'); LOGS.A1 = v;
      assert(blockedOk(v), 'A1 [API][FX] 較早 review（正式流程）＋較新確定失敗：付款摘要與成立判定一致為「付款結果確認中」、不提供付款或改現金；有效 token 直接 POST 改現金被後端拒絕（409），訂單付款方式／付款紀錄／名額不變、LINE Pay 呼叫 0',
        JSON.stringify({ st: v.st, cash: v.cash, unchanged: v.unchanged, lp: v.lpSame, after: v.after }));
    });
    await step('A2', 'DE', async () => {
      const out = {}; for (const k of ['cp', 'ps', 'pu']) out[k] = await blockCase(k);
      LOGS.A2 = out;
      assert(Object.values(out).every(blockedOk), 'A2 [API][FX] 較早 confirm_pending、pending/sent、pending/unknown＋較新確定失敗：同樣維持確認中、拒絕改現金、資料不變',
        JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { st: v.st, cash: v.cash, unchanged: v.unchanged, lp: v.lpSame }]))));
    });
    await step('A3', 'DE', async () => {
      const before = await K.snap(F.rvNew.id); const st = await K.status(X.rvNew.token);
      const req = await ill('A3', K, () => K.request(X.rvNew.token));
      const after = await K.snap(F.rvNew.id);
      LOGS.A3 = { st, req: req.r.status, lp: req.lp };
      assert(st.state === 'payment_under_review' && st.can_pay === false && req.r.status === 409 && req.lp.same && JSON.stringify(after.a.map((a) => [a.status, a.confirm_state, a.transaction_id])) === JSON.stringify(before.a.map((a) => [a.status, a.confirm_state, a.transaction_id])),
        'A3 [API][FX] 較早待核對＋較新 pending/never：付款摘要不提供付款；直接呼叫建立付款入口被拒絕（409），LINE Pay Request 0 次、付款紀錄不變',
        JSON.stringify({ state: st.state, can_pay: st.can_pay, req: req.r.status, err: req.r.json && req.r.json.error, lp: req.lp }));
    });
    await step('A4', 'DE', async () => {
      // 舊付款連結／callback：較新一筆（[FX]）先依正式流程建立付款（當時沒有其他紀錄待核對），之後較早一筆經正式流程進入待核對，再回到較新一筆的 callback
      const r2 = await K.request(X.cbo.token);
      const r1 = await K.request(F.cbo.payment.token); lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await K.cb(r1.call); lpCtrl({});
      const a1 = (await K.q('SELECT status FROM popup_payment_attempts WHERE attempt_id=?', [F.cbo.payment.ref]))[0];
      const c0 = lpCount();
      const loc = r2.call ? await K.cb(r2.call) : '';
      await sleep(200);
      const c1 = lpCount();
      const s = await K.snap(F.cbo.id); const st = await K.status(X.cbo.token);
      LOGS.A4 = { r2: r2.status, a1, loc: mask(loc), c0, c1, s, state: st.state };
      assert(r2.status === 200 && a1.status === 'review' && c1.confirm === c0.confirm && s.o.payment_status === 'pending' && !s.a.some((x) => x.status === 'paid') && st.state === 'payment_under_review' && st.can_pay === false,
        'A4 [API][FX] 舊付款連結的 callback：同單較早一筆已進入待核對後，較新一筆回到 callback 不送出 Confirm（Confirm 0 次）、不入帳、不建立新付款；整單維持確認中',
        JSON.stringify(LOGS.A4));
    });
    await step('A5', 'DE', async () => {
      const st = await K.status(X.paid.token);
      const cash = await ill('A5', K, () => K.cash(X.paid.token));
      const st2 = await K.status(X.paidNew.token);
      const req = await ill('A5b', K, () => K.request(X.paidNew.token));
      const s = await K.snap(F.paidNew.id); const s1 = await K.snap(F.paid.id);
      LOGS.A5 = { st: [st.state, st.can_pay, st.can_switch_to_cash], cash: cash.r.status, st2: [st2.state, st2.can_pay], req: req.r.status, lp: [cash.lp, req.lp], s, s1 };
      assert(st.state === 'paid' && st.can_pay === false && st.can_switch_to_cash === false && cash.r.status === 409 && st2.state === 'paid' && st2.can_pay === false && req.r.status === 409 && cash.lp.same && req.lp.same
        && s.o.payment_status === 'paid' && s1.o.payment_method === 'linepay' && s.al.every((x) => x.stock_state === 'committed' && x.status === 'active'),
        'A5 [API][FX] 較早已付款＋較新失敗／較新 pending：付款摘要為已付款、不提供付款或改現金；改現金與建立付款皆被拒絕、LINE Pay 呼叫 0、名額維持已成立', JSON.stringify(LOGS.A5));
    });
    await step('A6', 'DE', async () => {
      const st0 = await K.status(X.race.token);            // 顧客看到的畫面：此時較早一筆仍可付款（從未送出 Confirm），本筆確定失敗 → 可改現金
      lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await K.cb(F.race.call); lpCtrl({}); // 點擊前，較早一筆經正式流程進入待核對
      const before = await K.snap(F.race.id);
      const cash = await ill('A6', K, () => K.cash(X.race.token));
      const after = await K.snap(F.race.id);
      LOGS.A6 = { seen: st0.can_switch_to_cash, cash: cash.r.status, before, after, lp: cash.lp };
      assert(st0.can_switch_to_cash === true && before.a[0].status === 'review' && cash.r.status === 409 && JSON.stringify(before) === JSON.stringify(after) && after.o.payment_method === 'linepay',
        'A6 [API][FX] 顧客看到可改現金後、點擊前同單另一筆變成待核對：後端重新驗證並拒絕（不使用舊畫面結果放行），資料不變', JSON.stringify(LOGS.A6));
    });
    await step('A7', 'G', async () => {
      const a0 = await K.snap(F.single.id); const st = await K.status(F.single.payment.token);
      const c1 = await K.cash(F.single.payment.token); const a1 = await K.snap(F.single.id);
      const c2 = await K.cash(F.single.payment.token); const a2 = await K.snap(F.single.id);
      LOGS.A7 = { st: [st.state, st.can_switch_to_cash], c: [c1.status, c2.status], al: [a0.al, a1.al, a2.al] };
      assert(st.state === 'payment_failed' && st.can_switch_to_cash === true && c1.status === 200 && c2.status === 409 && a0.al.every((x) => x.stock_state === 'reserved') && a1.al.every((x) => x.stock_state === 'committed' && x.status === 'active')
        && JSON.stringify(a1.al) === JSON.stringify(a2.al) && a1.o.payment_method === 'cash',
        'A7 [API] 正常單一確定失敗：可改現金、第一次成功；重複操作 409，名額只由 reserved 轉 committed 一次', JSON.stringify(LOGS.A7));
    });
    await step('A8', 'G', async () => {
      const c0 = lpCount(); const r = await K.request(F.normal.payment.token); const l1 = await K.cb(r.call); const c1 = lpCount(); const l2 = await K.cb(r.call); const c2 = lpCount();
      const s = await K.snap(F.normal.id);
      LOGS.A8 = { c: [c0, c1, c2], l: [mask(l1), mask(l2)], s };
      assert(r.status === 200 && c1.confirm - c0.confirm === 1 && c2.confirm === c1.confirm && s.o.payment_status === 'paid' && s.a[0].status === 'paid' && s.al.every((x) => x.stock_state === 'committed'),
        'A8 [API] 正常首次付款完成（Confirm 1 次）；重複 callback 不重送 Confirm', JSON.stringify(LOGS.A8));
    });
    await step('A9', 'G', async () => {
      const r = await K.reconcile(F.rvOk.payment.ref); const s = await K.snap(F.rvOk.id);
      await K.adm('PATCH', `/api/orders/${F.rvCancel.id}/status`, { order_status: 'cancelled' });
      const sc = await K.snap(F.rvCancel.id);
      const r2 = await K.reconcile(F.rvCancel.payment.ref); const s2 = await K.snap(F.rvCancel.id);
      LOGS.A9 = { r: r.status, s, sc, r2: r2.status, s2 };
      assert(r.status === 200 && s.o.payment_status === 'paid' && s.a[0].status === 'paid' && s.al.every((x) => x.stock_state === 'committed' && x.status === 'active')
        && sc.al.every((x) => x.status === 'released') && s2.o.order_status === 'cancelled' && s2.o.refund_status === 'pending_refund' && s2.a[0].status === 'paid_cancelled' && s2.al.every((x) => x.status === 'released'),
        'A9 [API] 待核對後續查證成功 → 入帳、名額轉成立；取消（名額已釋放）後才確認付款成功 → 保留取消、進入待退款，不恢復名額或履約', JSON.stringify(LOGS.A9));
    });
    await step('A10', 'DE', async () => {
      if (!browser) throw new Error('需要 playwright');
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      await ctx.addInitScript(([r, t]) => { try { sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, [X.br.attempt_id, X.br.token]);
      const pg = await ctx.newPage();
      await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC)}&popup_pay_ref=${X.br.attempt_id}&popup_pay_result=cancelled`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 20000 }); await sleep(600);
      const t = await pg.evaluate(() => document.getElementById('popupRoot').innerText);
      const btns = await pg.evaluate(() => Array.from(document.querySelectorAll('#popupRoot button')).map((b) => b.textContent.trim()));
      await ctx.close();
      LOGS.A10 = { text: mask(t).slice(0, 500), btns };
      assert(/付款狀態：付款結果確認中/.test(t) && /請勿重複付款/.test(t) && !btns.some((b) => /改用現金|LINE Pay 付款|前往付款/.test(b)),
        'A10 [BR][FX] 付款頁（以較新一筆的付款憑證返回）：付款狀態顯示「付款結果確認中，請勿重複付款」，沒有改用現金或付款按鈕', JSON.stringify(LOGS.A10));
    });
    await step('A12', 'DE', async () => {
      if (!browser) throw new Error('需要 playwright');
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      await ctx.addInitScript(([r, t]) => { try { sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, [X.brRace.attempt_id, X.brRace.token]);
      const pg = await ctx.newPage();
      await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC)}&popup_pay_ref=${X.brRace.attempt_id}&popup_pay_result=cancelled`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 20000 }); await sleep(600);
      const seen = await pg.evaluate(() => Array.from(document.querySelectorAll('#popupRoot button')).map((b) => b.textContent.trim()));
      // 顧客看著畫面時，同單較早一筆經正式流程進入待核對
      lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await K.cb(F.brRace.call); lpCtrl({});
      const before = await K.snap(F.brRace.id);
      await pg.evaluate(() => { const b = Array.from(document.querySelectorAll('#popupRoot button')).find((x) => /改用現金/.test(x.textContent)); if (b) b.click(); });
      await sleep(1500);
      const t = await pg.evaluate(() => document.getElementById('popupRoot').innerText);
      const btns = await pg.evaluate(() => Array.from(document.querySelectorAll('#popupRoot button')).map((b) => b.textContent.trim()));
      await ctx.close();
      const after = await K.snap(F.brRace.id);
      LOGS.A12 = { seen, btns, text: mask(t).slice(0, 400), before: before.o, after: after.o };
      assert(seen.some((b) => /改用現金/.test(b)) && JSON.stringify(before) === JSON.stringify(after) && after.o.payment_method === 'linepay' && /付款結果確認中/.test(t) && !btns.some((b) => /改用現金/.test(b)),
        'A12 [BR][FX] 真實 Chrome：顧客看到「改用現金」後，同單另一筆變成待核對，再按下按鈕 → 後端拒絕，畫面改為「付款結果確認中」且改現金按鈕消失；訂單仍為 LINE Pay、資料不變', JSON.stringify(LOGS.A12));
    });
    await step('A11', 'DE', async () => {
      // 到期整理：較新一筆確定失敗到期（[CLK] 推進到付款期限之後），不得讓已付款訂單的名額被釋放；有待核對時不得宣告未付款
      const exp = Number((await K.q('SELECT expires_at FROM popup_payment_attempts WHERE attempt_id=?', [X.paidExp.attempt_id]))[0].expires_at);
      OFF = exp + 60000 - RealDate.now();
      await C.restart(env(OFF, 'UTC')); C.tok = await H.login(C.s.base, STORE, 'pw001');
      await K.status(X.paidExp.token); await K.status(X.rvExp.token);
      const a = await K.snap(F.paidExp.id); const b = await K.snap(F.rvExp.id);
      LOGS.A11 = { paidExp: a, rvExp: b };
      assert(a.o.payment_status === 'paid' && a.o.order_status !== 'cancelled' && a.al.every((x) => x.status === 'active' && x.stock_state === 'committed')
        && b.o.payment_status === 'pending' && b.a.some((x) => x.status === 'review'),
        'A11 [API][FX][CLK] 到期整理：已付款＋較新失敗到期 → 訂單維持已付款、名額不被釋放；待核對＋較新失敗到期 → 付款狀態維持 pending（不宣告未付款，待核對結果決定）', JSON.stringify(LOGS.A11));
    });
    await C.s.stop();

    // ══════════════════════ B：時間標記合併（MBV2 正式匯出 → 上傳 → 預覽 → 匯入）══════════════════════
    const runMerge = async (tz) => {
      const R = { tz };
      const B = await C45.boot('c542gb-' + tz.replace('/', '_'), { products: PRODUCTS, members: 3, settings: {}, seed, env: env(offAt('2026-11-16T08:07:30Z'), tz) }); boots.push(B);
      const go = async (iso) => { await B.restart(env(offAt(iso), tz)); B.tok = await H.login(B.s.base, STORE, 'pw001'); };
      await go('2026-11-16T08:07:40Z');
      let SCB = null; const KB = kit(B, () => SCB);
      SCB = await mkSession(KB, 'C542GB 場次 ' + tz, '2026-11-20', '2026-11-19T23:00');
      await go('2026-11-16T08:08:05Z');
      const PB = '0977111222'; const O = {};
      for (const k of ['b1', 'b3', 'b4', 'b9', 'b10src']) O[k] = await KB.order({ phone: PB, pay: 'cash' });
      O.b2 = await KB.order({ phone: PB }); { const r = await KB.request(O.b2.payment.token); await KB.cb(r.call); }
      // 正式匯出（訂單類別）
      const ex = await H.download(B.s.base, B.tok, '/api/migration/v2/export?categories=orders');
      const P = JSON.parse(ex.buf.toString('utf8'));
      const row = (o) => P.data.orders.find((x) => x.id === o.id);
      // ── [FX] 本地：舊版寫入（主機時區不明）的時間、沒有來源標記 ──
      await B.s.stop();
      { const db = await H.openDbFile(B.dbf); dropOrderTimeTriggers(db);
        db.run("UPDATE orders SET updated_at='2026-11-16 08:09:00', popup_updated_tz=NULL WHERE id=?", [O.b1.id]);
        db.run("UPDATE orders SET updated_at='2026-11-16 08:09:00', popup_updated_tz=NULL WHERE id=?", [O.b2.id]);
        db.run("UPDATE popup_payment_attempts SET confirmed_at='2026-11-16 08:09:00', updated_at='2026-11-16 08:09:00' WHERE order_id=?", [O.b2.id]); // 本地可信 UTC 付款證據
        db.run("UPDATE orders SET created_at='2026-11-16 08:08:00', updated_at='2026-11-16 08:08:00', popup_created_tz=NULL, popup_updated_tz=NULL WHERE id=?", [O.b3.id]);
        db.run("UPDATE popup_order_allocations SET created_at='2026-11-16 08:08:00' WHERE order_id=?", [O.b3.id]); // 名額時間與建立時間相同 → 無法確認主機時區
        db.run("UPDATE orders SET updated_at='2026-11-16 16:20:00', popup_updated_tz='Asia/Taipei' WHERE id=?", [O.b4.id]); // 本地已有可信台北配對
        db.run("UPDATE orders SET created_at='2026-11-16 08:08:00', popup_created_tz=NULL WHERE id=?", [O.b9.id]);
        db.run('DELETE FROM orders WHERE id=?', [O.b10src.id]); db.run('DELETE FROM popup_order_allocations WHERE order_id=?', [O.b10src.id]);
        H.saveDbFile(db, B.dbf); db.close(); }
      await go('2026-11-16T08:30:00Z');
      // ── 來源備份（同一份正式匯出，修改為來源端的時間與標記）──
      const src = JSON.parse(JSON.stringify(P));
      const set = (o, v) => Object.assign(src.data.orders.find((x) => x.id === o.id), v);
      set(O.b1, { updated_at: '2026-11-16 16:10:00', popup_updated_tz: 'Asia/Taipei' });
      set(O.b2, { updated_at: '2026-11-16 16:10:00', popup_updated_tz: 'Asia/Taipei' });
      set(O.b3, { created_at: '2026-11-16 08:08:00', popup_created_tz: 'Asia/Taipei', updated_at: '2026-11-16 08:08:00', popup_updated_tz: 'Asia/Taipei' });
      set(O.b4, { updated_at: '2026-11-16 16:10:00', popup_updated_tz: null });
      set(O.b9, { created_at: '2026-11-16 16:08:30', popup_created_tz: 'Asia/Taipei' }); // 來源衝突（建立時間不同）
      const mk = (base, v) => { const x = { ...row(base), ...v }; return x; };
      const nid = () => crypto.randomUUID();
      const n5 = nid(), n6 = nid(), n7 = nid(), n8 = nid();
      src.data.orders.push(
        mk(O.b10src, { id: n5, uuid: n5, order_number: 'POPUP-C542GB-N5-' + tz.length, created_at: '2026-11-16 16:05:00', updated_at: '2026-11-16 16:06:00', popup_created_tz: 'Asia/Taipei', popup_updated_tz: 'Asia/Taipei' }),
        mk(O.b10src, { id: n6, uuid: n6, order_number: 'POPUP-C542GB-N6-' + tz.length, created_at: '2026-11-16 08:05:00', updated_at: '2026-11-16 08:06:00', popup_created_tz: null, popup_updated_tz: null }),
        mk(O.b10src, { id: n7, uuid: n7, order_number: 'POPUP-C542GB-N7-' + tz.length, created_at: '2026-11-16T16:04:00Z', updated_at: '2026-11-16T16:05:00Z', popup_created_tz: null, popup_updated_tz: null }),
        mk(O.b10src, { id: n8, uuid: n8, order_number: 'POPUP-C542GB-N8-' + tz.length, created_at: '2026-11-17T00:05:00+08:00', updated_at: '2026-11-17T00:06:00+08:00', popup_created_tz: null, popup_updated_tz: null }),
      );
      src.data.orders = src.data.orders.filter((x) => x.id !== O.b10src.id);
      if (src.table_counts) src.table_counts.orders = src.data.orders.length; // [FX] 來源備份：檔頭筆數與內容一致（正式匯出格式）
      const ids = [O.b1.id, O.b2.id, O.b3.id, O.b4.id, O.b9.id, n5, n6, n7, n8];
      const dbRows = async () => KB.q(`SELECT id, created_at, updated_at, popup_created_tz, popup_updated_tz FROM orders WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
      const hashAll = async () => crypto.createHash('sha256').update(JSON.stringify(await KB.q('SELECT * FROM orders ORDER BY id'))).digest('hex');
      const upload = async (obj, name) => { const r = await H.uploadRaw(B.s.base, B.tok, Buffer.from(JSON.stringify(obj)), { name }); if (!r.json || !r.json.upload_id) throw new Error('upload ' + r.status + ' ' + String(r.text || r.error).slice(0, 300)); return r.json.upload_id; };
      // 預覽（不寫入）→ 回滾
      const h0 = await hashAll();
      const up = await upload(src, 'c542gb-1.json');
      const pv = await H.previewAndImport(B.s.base, B.tok, up, { mode: 'merge', categories: ['orders'], previewOnly: true });
      const h1 = await hashAll();
      R.preview = { status: pv.preview && pv.preview.status, unchanged: h0 === h1 };
      // 匯入失敗（durable 保存失敗）→ 整批回滾
      { const upF = await upload(src, 'c542gb-fail.json');
        const pv2 = await H.api(B.s.base, B.tok, 'POST', '/api/migration/v2/preview', { upload_id: upF, mode: 'merge', categories: ['orders'] });
        if (pv2.status !== 202) throw new Error('preview(fail-path) ' + pv2.status + ' ' + JSON.stringify(pv2.json).slice(0, 200));
        const pj = await H.waitJob(B.s.base, B.tok, pv2.json.job_id, 60000);
        fs.writeFileSync(DUR, JSON.stringify({ skip: 0, fail: 1 }));
        const im = await H.api(B.s.base, B.tok, 'POST', '/api/migration/v2/import', { upload_id: upF, mode: 'merge', categories: ['orders'], preview_token: pj.result.preview_token });
        const ij = im.status === 202 ? await H.waitJob(B.s.base, B.tok, im.json.job_id, 60000) : null;
        fs.writeFileSync(DUR, '{}');
        const h2 = await hashAll();
        R.failRollback = { job: ij && ij.status, unchanged: h2 === h0 };
      }
      // 正式匯入（merge）
      const up3 = await upload(src, 'c542gb-2.json');
      const im = await H.previewAndImport(B.s.base, B.tok, up3, { mode: 'merge', categories: ['orders'] });
      const st = im.import && im.import.result && im.import.result.stats && im.import.result.stats.orders;
      R.import = { job: im.import && im.import.status, status: im.import && im.import.result && im.import.result.status, added: st && st.added, updated: st && st.updated, conflict: st && st.conflict, verify: im.import && im.import.result && im.import.result.verify_ok };
      R.after = await dbRows();
      const h3 = await hashAll();
      // 重複匯入（merge）→ 不變；skip 模式 → 不變
      const im2 = await H.previewAndImport(B.s.base, B.tok, await upload(src, 'c542gb-3.json'), { mode: 'merge', categories: ['orders'] });
      const h4 = await hashAll();
      const im3 = await H.previewAndImport(B.s.base, B.tok, await upload(src, 'c542gb-4.json'), { mode: 'skip', categories: ['orders'] });
      const h5 = await hashAll();
      R.repeat = { merge: im2.import && im2.import.status, mergeSame: h3 === h4, skip: im3.import && im3.import.status, skipSame: h4 === h5 };
      // API 顯示
      const lk = await (await fetch(`${B.s.base}/api/line-orders/popup-orders/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_code: SCB, phone: PB }) })).json();
      const tok = lk.data.token; const shown = {};
      const name = { [O.b1.id]: 'b1', [O.b2.id]: 'b2', [O.b3.id]: 'b3', [O.b4.id]: 'b4', [O.b9.id]: 'b9', [n5]: 'n5', [n6]: 'n6', [n7]: 'n7', [n8]: 'n8' };
      for (const r of R.after) {
        const no = (await KB.q('SELECT order_number FROM orders WHERE id=?', [r.id]))[0].order_number;
        const d = (await (await fetch(`${B.s.base}/api/line-orders/popup-orders/detail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, order_number: no }) })).json()).data;
        shown[name[r.id]] = { c: d.times.created.text + (d.times.created.known ? '' : '?'), u: d.times.updated.text + (d.times.updated.known ? '' : '?') };
      }
      R.shown = shown;
      R.db = Object.fromEntries(R.after.map((r) => [name[r.id], [r.created_at, r.popup_created_tz, r.updated_at, r.popup_updated_tz]]));
      R.SC = SCB; R.PB = PB; R.base = B.s.base; R.b1no = (await KB.q('SELECT order_number FROM orders WHERE id=?', [O.b1.id]))[0].order_number;
      R.stop = () => B.s.stop();
      return R;
    };
    const BU = await runMerge('UTC');
    // [BR] 顧客畫面：b1（來源不明）詳情顯示「時區未確認」
    if (browser) {
      try {
        const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: 'America/New_York', locale: 'zh-TW' });
        await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
        const pg = await ctx.newPage();
        await pg.goto(`${BU.base}/popup-order?session=${encodeURIComponent(BU.SC)}`, { waitUntil: 'domcontentloaded' });
        await pg.waitForSelector('[data-lookup-open="history"]', { timeout: 20000 }); await sleep(500);
        await pg.click('[data-lookup-open="history"]'); await pg.waitForSelector('#popupLookupPhone');
        await pg.fill('#popupLookupPhone', BU.PB); await pg.click('.popup-order-lookup-submit');
        await pg.waitForSelector('.popup-order-lookup-card', { timeout: 10000 }); await sleep(300);
        for (let i = 0; i < 3; i++) { const more = await pg.$('.popup-order-lookup-more'); if (!more) break; await more.click(); await sleep(600); }
        await pg.evaluate((n) => { const li = document.querySelector(`.popup-order-lookup-card[data-order-number="${n}"]`); const b = li && Array.from(li.querySelectorAll('button')).find((x) => /查看詳情/.test(x.textContent)); if (b) b.click(); }, BU.b1no);
        await pg.waitForFunction(() => /訂單編號/.test((document.getElementById('popupLookupBody') || {}).innerText || ''), null, { timeout: 10000 });
        const t = await pg.evaluate(() => document.getElementById('popupLookupBody').innerText);
        BU.browser = (t.match(/狀態更新\s*([^\n]*)/) || [])[1] || '';
        await ctx.close();
      } catch (e) { BU.browser = 'ERR ' + e.message; }
    }
    await BU.stop();
    const BT = await runMerge('Asia/Taipei'); await BT.stop();
    LOGS.B = { UTC: { ...BU, stop: undefined }, Taipei: { ...BT, stop: undefined } };
    const both = (fn) => fn(BU) && fn(BT);
    await step('B1', 'DE', async () => {
      const ok = (R) => R.db.b1[3] == null && R.db.b1[2] === '2026-11-16 08:09:00' && R.shown.b1.u === '2026-11-16 08:09?';
      assert(both(ok) && /08:09（時區未確認）/.test(BU.browser || ''),
        'B1 [API][DB][BR] 精確重現：本地 08:09／NULL、來源 16:10／Asia/Taipei 合併 → 保留本地 08:09 且標記維持 NULL（不被標成已確認台北）；API 與顧客詳情顯示「08:09（時區未確認）」（UTC 與台北主機相同）',
        JSON.stringify({ UTC: [BU.db.b1, BU.shown.b1, BU.browser], TPE: [BT.db.b1, BT.shown.b1] }));
    });
    await step('B2', 'DE', async () => {
      const ok = (R) => R.db.b2[3] == null && R.db.b2[2] === '2026-11-16 08:09:00' && R.shown.b2.u === '2026-11-16 16:09';
      assert(both(ok), 'B2 [API][DB][FX] 本地有可信 UTC 付款證據（同交易 confirmed_at）：合併後標記仍為 NULL，依證據正確顯示台北 16:09', JSON.stringify({ UTC: [BU.db.b2, BU.shown.b2], TPE: [BT.db.b2, BT.shown.b2] }));
    });
    await step('B3', 'DE', async () => {
      const ok = (R) => R.db.b3[1] == null && R.db.b3[3] == null && R.shown.b3.c === '2026-11-16 08:08?';
      assert(both(ok), 'B3 [API][DB][FX] 建立時間配對：無時區字串相同（08:08）不推定同一絕對時刻 → 本地 popup_created_tz／popup_updated_tz 不被補入，顯示「時區未確認」', JSON.stringify({ UTC: [BU.db.b3, BU.shown.b3], TPE: [BT.db.b3, BT.shown.b3] }));
    });
    await step('B4', 'G', async () => {
      const ok = (R) => JSON.stringify(R.db.b4.slice(2)) === JSON.stringify(['2026-11-16 16:20:00', 'Asia/Taipei']) && R.shown.b4.u === '2026-11-16 16:20';
      assert(both(ok), 'B4 [API][DB] 本地已有可信台北配對、來源時間不同且缺少標記（舊備份）：保留本地正確配對 16:20／Asia/Taipei，不降級', JSON.stringify({ UTC: [BU.db.b4, BU.shown.b4], TPE: [BT.db.b4, BT.shown.b4] }));
    });
    await step('B5', 'G', async () => {
      const ok = (R) => JSON.stringify(R.db.n5) === JSON.stringify(['2026-11-16 16:05:00', 'Asia/Taipei', '2026-11-16 16:06:00', 'Asia/Taipei']) && R.shown.n5.c === '2026-11-16 16:05' && R.shown.n5.u === '2026-11-16 16:06'
        && R.db.n6[1] == null && R.db.n6[3] == null && /\?$/.test(R.shown.n6.u);
      assert(both(ok), 'B5 [API][DB] 新增整列：時間與可信來源標記成對保留（16:05／Asia/Taipei）；舊備份缺標記的新增列維持 NULL、顯示時區未確認（不被升級為台北）', JSON.stringify({ UTC: [BU.db.n5, BU.shown.n5, BU.db.n6, BU.shown.n6], TPE: [BT.db.n5, BT.db.n6] }));
    });
    await step('B6', 'G', async () => {
      const ok = (R) => R.shown.n7.c === '2026-11-17 00:04' && R.shown.n7.u === '2026-11-17 00:05' && R.shown.n8.c === '2026-11-17 00:05' && R.shown.n8.u === '2026-11-17 00:06';
      assert(both(ok), 'B6 [API] 明確 Z／+08:00 的跨午夜時間：依實際時區解析一次（UTC 16:05Z → 11/17 00:05；+08:00 → 原值），不重複加八小時（兩種主機時區相同）', JSON.stringify({ UTC: [BU.shown.n7, BU.shown.n8], TPE: [BT.shown.n7, BT.shown.n8] }));
    });
    await step('B7', 'G', async () => {
      const ok = (R) => R.preview.status === 'done' && R.preview.unchanged && R.failRollback.job === 'error' && R.failRollback.unchanged && R.import.job === 'done' && R.import.verify === true && R.import.added === 4 && R.import.conflict >= 1
        && R.repeat.merge === 'done' && R.repeat.mergeSame && R.repeat.skip === 'done' && R.repeat.skipSame;
      assert(both(ok), 'B7 [API][DB] 預覽後回滾不寫入；保存失敗整批回滾；正式匯入完成且筆數核對通過；重複匯入（merge）與 skip 模式資料逐列不變',
        JSON.stringify({ UTC: [BU.preview, BU.failRollback, BU.import, BU.repeat], TPE: [BT.preview, BT.failRollback, BT.import, BT.repeat] }));
    });
    await step('B8', 'G', async () => {
      const ok = (R) => R.db.b9[0] === '2026-11-16 08:08:00' && R.db.b9[1] == null;
      assert(both(ok), 'B8 [API][DB] 來源衝突（建立時間不同）：整列不動，不產生半套標記異動', JSON.stringify({ UTC: BU.db.b9, TPE: BT.db.b9 }));
    });
    await step('B9', 'G', async () => {
      const srt = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
      const norm = (R) => JSON.stringify({ markers: srt(Object.fromEntries(Object.entries(R.db).map(([k, v]) => [k, [v[1], v[3]]]))), shown: srt(R.shown) }); // 建立時刻的秒數由結帳產生，兩台伺服器不同，不納入比較
      assert(norm(BU) === norm(BT), 'B9 [API][DB] 主機 TZ=UTC 與 Asia/Taipei：合併後資料庫欄位與顯示逐項相同', JSON.stringify({ UTC: norm(BU).slice(0, 600), TPE: norm(BT).slice(0, 600) }));
    });
    await step('Z', 'G', async () => {
      const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
      const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
      const lineReal = boots.reduce((n, b) => n + b.mf.real(), 0);
      assert(real === 0 && unexpected === 0 && lineReal === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次', JSON.stringify({ real, unexpected, lineReal, counts: lpCount() }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*/) || [''])[0]] || {}).cls || null, detail: mask(r.detail) })), logs: JSON.parse(mask(JSON.stringify(LOGS))) };
  if (process.env.C542G_RESULT_JSON) fs.writeFileSync(process.env.C542G_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
