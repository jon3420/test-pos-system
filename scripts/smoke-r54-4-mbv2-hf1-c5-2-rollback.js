#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-2-rollback.js
// R54.4／MBV2-HF1-C5.2 —— 有條件回退驗證：保留同一個資料庫，程式退回 C5.1（C52_OLD_ROOT＝C5.1 全新解壓樹），再升級回 C5.2。
//   1. C5.2 建立：正常已付款、已付款取消（待退款）、待核對付款、未完成的付款副作用。
//   2. 回退前清空：後台核對處理待核對、補齊副作用；確認待核對 0、副作用待辦 0（回退前置條件）。
//   3. 另留一筆「未清空」的待核對付款，記錄 C5.1 對它的實際行為（限制說明，不宣稱可安全處理）。
//   4. C5.1 讀取同一資料庫：啟動、資料完整、已付款訂單重複 callback 不再 Confirm、可建立新訂單。
//   5. 升級回 C5.2：遷移可重複執行、資料完整、未清空的那筆仍可核對恢復。
// LINE／LINE Pay 全部在測試程序內攔截（真實呼叫 0）。這不是正式站或真機驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
const OLD = process.env.C52_OLD_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c52-rb');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt') };
fs.writeFileSync(LP.ctrl, '{}'); fs.writeFileSync(LP.state, JSON.stringify({ tx: {} })); fs.writeFileSync(LP.log, ''); fs.writeFileSync(LP.real, '');
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`], { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [711, '回退付款甲', 1, 'available', { quota: 300, price: 100 }]];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-rb','test-secret-rb')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); f.payment_api = true; f.line_order = true; db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};

let RBL = null;
(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.2 有條件回退驗證 ══════════');
  console.log('C5.2：' + H.ROOT + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C52_OLD_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c51-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real,
    C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-rb': 'test-secret-rb' }) };
  const C = await C45.boot('c52rb', { products: PRODUCTS, seed, env });
  let oldProc = null;
  try {
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const S = (u) => sessAt(u, OFF);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const pub = (base, m, p, b) => C45.pub(base, m, p, b);
    const order = async (base, u) => {
      const r = await pub(base, 'POST', '/api/line-orders', { customer_name: '回退', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'linepay', items: [{ product_id: 711, qty: 1 }], member_session: S(u) });
      if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data;
    };
    const request = async (base, o) => { await pub(base, 'POST', '/api/linepay/request', { order_uuid: o.uuid }); return lpCalls().filter((c) => /request$/.test(c.uri)).pop(); };
    const callback = async (base, call) => { const r = await fetch(`${base}/api/linepay/confirm?${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const dbq = async (sql, p) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
    const ord = async (uuid) => (await dbq('SELECT order_status, payment_status, refund_status FROM orders WHERE uuid=?', [uuid]))[0];

    // ── 1. C5.2 建立資料 ──
    const oPaid = await order(C.s.base, U(1)); const cPaid = await request(C.s.base, oPaid); await callback(C.s.base, cPaid);
    const oPC = await order(C.s.base, U(2)); const cPC = await request(C.s.base, oPC);
    lpCtrl({ confirmDelayMs: 1200 }); const pp = callback(C.s.base, cPC); await sleep(500);
    await H.api(C.s.base, C.tok, 'PATCH', `/api/line-orders/online/${oPC.uuid}/status`, { status: 'cancelled' }); await pp; lpCtrl({});
    const oRev = await order(C.s.base, U(3)); const cRev = await request(C.s.base, oRev);
    lpCtrl({ confirmMode: 'drop', inquiry: 'error' }); await callback(C.s.base, cRev); lpCtrl({});
    const oSE = await order(C.s.base, U(4)); const cSE = await request(C.s.base, oSE);
    { await C.s.stop(); const db = await H.openDbFile(C.dbf); db.run(`CREATE TRIGGER rb_fail BEFORE INSERT ON analytics_events WHEN NEW.order_id='${oSE.uuid}' AND NEW.event_name='purchase' BEGIN SELECT RAISE(ABORT,'rb'); END`); H.saveDbFile(db, C.dbf); db.close(); await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001'); }
    await callback(C.s.base, cSE);
    const rv0 = await H.api(C.s.base, C.tok, 'GET', '/api/linepay-admin/review');
    const se0 = (await dbq("SELECT COUNT(*) AS c FROM payment_side_effects WHERE status='pending'"))[0].c;
    assert(rv0.status === 200 && rv0.json.data.attempts.some((a) => a.order_uuid === oRev.uuid) && se0 >= 1 && (await ord(oPC.uuid)).refund_status === 'pending_refund',
      'RB0 C5.2 建立：已付款、已付款取消（待退款）、待核對付款、未完成副作用', JSON.stringify({ review: rv0.json && rv0.json.data.attempts.length, se0 }));

    // ── 2. 回退前清空 ──
    { await C.s.stop(); const db = await H.openDbFile(C.dbf); db.run('DROP TRIGGER IF EXISTS rb_fail'); H.saveDbFile(db, C.dbf); db.close(); await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001'); }
    await sleep(4000);
    const aRev = (await dbq('SELECT attempt_uuid FROM linepay_payment_attempts WHERE order_uuid=?', [oRev.uuid]))[0];
    await H.api(C.s.base, C.tok, 'POST', '/api/linepay-admin/reconcile', { attempt_uuid: aRev.attempt_uuid });
    const rv1 = await H.api(C.s.base, C.tok, 'GET', '/api/linepay-admin/review');
    const se1 = (await dbq("SELECT COUNT(*) AS c FROM payment_side_effects WHERE status='pending'"))[0].c;
    const open1 = rv1.json.data.attempts.filter((a) => ['confirm_pending', 'review'].includes(a.status));
    assert(open1.length === 0 && se1 === 0 && (await ord(oRev.uuid)).payment_status === 'paid',
      'RB1 回退前置條件：後台核對處理待核對、副作用補齊 → 待核對（confirm_pending／review）0、副作用待辦 0（待退款屬人工事項，C5.1 也能讀取，不阻擋回退）', JSON.stringify({ open: open1.length, listed: rv1.json.data.attempts.map((a) => a.status), se1 }));

    // ── 3. 刻意留下一筆未清空的待核對（限制說明） ──
    const oLeft = await order(C.s.base, U(5)); const cLeft = await request(C.s.base, oLeft);
    lpCtrl({ confirmMode: 'drop', inquiry: 'error' }); await callback(C.s.base, cLeft); lpCtrl({});
    const before = await dbq('SELECT COUNT(*) AS c FROM orders'); const nOrders = before[0].c;
    await C.s.stop();

    // ── 4. C5.1 讀取同一資料庫 ──
    const port = C.s.port;
    oldProc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: OLD, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let olog = ''; oldProc.stdout.on('data', (d) => { olog += d; }); oldProc.stderr.on('data', (d) => { olog += d; });
    const base = `http://127.0.0.1:${port}`;
    let up = false; for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(150); }
    const n0 = confirmsFor(cPaid.tx), n1 = confirmsFor(cPC.tx);
    const l1 = await callback(base, cPaid); const l2 = await callback(base, cPC);
    const oNew = await order(base, U(6));
    await sleep(300);
    const cnt = (await dbq('SELECT COUNT(*) AS c FROM orders'))[0].c;
    const pc = await ord(oPC.uuid);
    assert(up && !/Error:/.test(olog.split('\n').filter((l) => /migration|SQLITE/.test(l)).join(' ')) && cnt === nOrders + 1 && oNew && confirmsFor(cPaid.tx) === n0 && confirmsFor(cPC.tx) === n1
      && (await ord(oPaid.uuid)).payment_status === 'paid' && pc.order_status === 'cancelled' && pc.refund_status === 'pending_refund',
    'RB2 C5.1 讀取同一資料庫：啟動、既有訂單完整、可建立新訂單；已付款／已付款取消單重複 callback 不再送 Confirm、取消不被改回', JSON.stringify({ up, cnt, nOrders, l1: l1.slice(0, 60), l2: l2.slice(0, 60), pc }));
    // 限制：未清空的待核對付款交給 C5.1 時的實際行為（記錄，不判定為可接受的處理方式）
    const nL = confirmsFor(cLeft.tx);
    const lL = await callback(base, cLeft);
    const left = await ord(oLeft.uuid);
    const leftA = (await dbq('SELECT status FROM linepay_payment_attempts WHERE order_uuid=?', [oLeft.uuid]))[0];
    console.log('  ℹ️ RB-L 限制記錄：C5.1 處理未清空的待核對付款 → Confirm 次數 ' + nL + '→' + confirmsFor(cLeft.tx) + '，返回 ' + lL.slice(0, 80) + '，訂單付款 ' + left.payment_status + '，付款嘗試 ' + leftA.status);
    RBL = ({ confirms: [nL, confirmsFor(cLeft.tx)], loc: lL.slice(0, 80), pay: left.payment_status, attempt: leftA.status });
    oldProc.kill('SIGTERM'); await new Promise((r) => { oldProc.once('exit', r); setTimeout(r, 4000); }); oldProc = null;

    // ── 5. 升級回 C5.2 ──
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    await C.s.stop(); await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001'); // 遷移重複執行
    const cnt2 = (await dbq('SELECT COUNT(*) AS c FROM orders'))[0].c;
    const aL = (await dbq('SELECT attempt_uuid, status FROM linepay_payment_attempts WHERE order_uuid=?', [oLeft.uuid]))[0];
    await H.api(C.s.base, C.tok, 'POST', '/api/linepay-admin/reconcile', { attempt_uuid: aL.attempt_uuid });
    const left2 = await ord(oLeft.uuid);
    const ev = (await dbq("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name='purchase'", [oLeft.uuid]))[0].c;
    assert(cnt2 === cnt && left2.payment_status === 'paid' && ev === 1 && (await ord(oPaid.uuid)).payment_status === 'paid' && (await ord(oPC.uuid)).refund_status === 'pending_refund',
      'RB3 升級回 C5.2：遷移可重複執行、訂單完整；回退期間留下的付款可核對恢復，購買事件只一次', JSON.stringify({ cnt2, aL: aL.status, left2, ev }));
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    assert(C.mf.real() === 0 && realPay === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次', JSON.stringify({ line: C.mf.real(), linepay: realPay }));
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally { if (oldProc) { try { oldProc.kill('SIGKILL'); } catch {} } try { await C.s.stop(); } catch {} }
  const s = H.summary();
  if (process.env.C52_RESULT_JSON) fs.writeFileSync(process.env.C52_RESULT_JSON, JSON.stringify({ pass: s.passCount, fail: s.failCount, rb_limitation: RBL, results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
