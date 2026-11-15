#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-3-rollback.js
// R54.4／MBV2-HF1-C5.3 —— 回退與再升級驗證：保留同一個資料庫檔，程式退回 C5.2（C53_OLD_ROOT＝未修改 C5.2 全新解壓樹），再升級回 C5.3。
// 重點：C5.2 本身仍有 F1～F4 缺口，「可啟動」不等於安全回退。本測試記錄：
//   RB1 C5.2 可讀同一資料庫並啟動，既有訂單與付款紀錄完整
//   RB2 資料庫觸發器在 C5.2 執行期間仍有效：C5.2 對 1152 判 failed、人工標記未付款 → 立即轉回待核對，重新付款仍被阻擋
//   RB-L（限制，實測記錄）C5.2 對待核對付款仍會再次送出 Confirm（F1 缺口）
//   RB3 升級回 C5.3：遷移可重複執行；待核對付款不再送 Confirm；C5.2 期間建立的新付款可正常完成
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
const OLD = process.env.C53_OLD_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c53-rb');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
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
  console.log('══════════ R54.4／MBV2-HF1-C5.3 回退（C5.2）與再升級驗證 ══════════');
  console.log('C5.3：' + H.ROOT + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C53_OLD_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c53-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
    C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-rb': 'test-secret-rb' }) };
  const C = await C45.boot('c53rb', { products: PRODUCTS, seed, env });
  let oldProc = null;
  try {
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const S = (u) => sessAt(u, OFF);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const order = async (base, u) => {
      const r = await C45.pub(base, 'POST', '/api/line-orders', { customer_name: '回退', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'linepay', items: [{ product_id: 711, qty: 1 }], member_session: S(u) });
      if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data;
    };
    const request = async (base, o) => { const r = await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: o.uuid }); return { status: r.status, call: lpCalls().filter((c) => /request$/.test(c.uri)).pop() }; };
    const callback = async (base, call) => { const r = await fetch(`${base}/api/linepay/confirm?${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const dbq = async (sql, p) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
    const att = async (uuid) => (await dbq('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id', [uuid]))[0];
    const ord = async (uuid) => (await dbq('SELECT payment_status, order_status FROM orders WHERE uuid=?', [uuid]))[0];

    // ── C5.3 建立資料 ──
    const oPaid = await order(C.s.base, U(1)); const rPaid = await request(C.s.base, oPaid); await callback(C.s.base, rPaid.call);
    lpCtrl({ confirmMode: 'drop', inquiry: '1150' });
    const oRev = await order(C.s.base, U(2)); const rRev = await request(C.s.base, oRev); await callback(C.s.base, rRev.call); lpCtrl({});
    const oDup = await order(C.s.base, U(3)); const rDup = await request(C.s.base, oDup); // 尚未 callback（顧客付款中）
    const n0 = (await dbq('SELECT COUNT(*) AS c FROM orders'))[0].c;
    await C.s.stop();

    // ── 退回 C5.2（同一資料庫）──
    const port = C.s.port;
    const startOld = () => { oldProc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: OLD, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    oldProc.stdout.on('data', () => {}); oldProc.stderr.on('data', () => {}); };
    const stopOld = async () => { const p = oldProc; oldProc = null; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(r, 4000); }); };
    const base = `http://127.0.0.1:${port}`;
    const waitUp = async () => { for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch {} await sleep(150); } return false; };
    startOld();
    const up = await waitUp();
    let tokOld = await H.login(base, STORE, 'pw001');
    const n1 = (await dbq('SELECT COUNT(*) AS c FROM orders'))[0].c;
    assert(up && n1 === n0 && (await ord(oPaid.uuid)).payment_status === 'paid' && (await att(oRev.uuid)).status === 'review',
      'RB1 C5.2 讀取同一資料庫：啟動、既有訂單與付款紀錄完整（已付款、待核對）', JSON.stringify({ up, n0, n1 }));
    // RB2：C5.2 對 1152 判 failed → 觸發器立即轉回待核對；C5.2 人工標記未付款 → 同樣轉回待核對
    lpCtrl({ confirm: '1152', captureThen: true });
    const l1 = await callback(base, rDup.call); lpCtrl({});
    const aDup = await att(oDup.uuid);
    const rpDup = (await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: oDup.uuid })).status;
    // 讓 C5.2 的人工標記條件成立（付款建立超過 30 分鐘、最近查詢為 not_found）：停止 C5.2 → 修改檔案 → 重新啟動 C5.2
    const aRev0 = await att(oRev.uuid);
    await stopOld();
    { const db = await H.openDbFile(C.dbf); db.run("UPDATE linepay_payment_attempts SET created_at=datetime('now','-31 minutes'), last_inquiry_at=datetime('now'), last_inquiry_result='not_found:1150' WHERE attempt_uuid=?", [aRev0.attempt_uuid]); H.saveDbFile(db, C.dbf); db.close(); }
    startOld(); await waitUp(); tokOld = await H.login(base, STORE, 'pw001');
    const mu = await H.api(base, tokOld, 'POST', `/api/linepay-admin/attempts/${aRev0.attempt_uuid}/mark-unpaid`, { note: 'rollback test' });
    const aRevMu = await att(oRev.uuid);
    const rpRev = (await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: oRev.uuid })).status;
    assert(aDup.status === 'review' && /c53_quarantine/.test(aDup.review_reason) && rpDup === 409 && mu.status === 200 && aRevMu.status === 'review' && /c53_quarantine:failed:manual_unpaid/.test(aRevMu.review_reason) && rpRev === 409,
      'RB2 回退期間資料庫觸發器仍有效：C5.2 把 1152 判為 failed、C5.2 人工標記未付款（C5.2 API 回 200），都會立即轉回待核對，重新付款仍被阻擋',
      JSON.stringify({ dup: [aDup.status, aDup.review_reason], rpDup, l1: l1.slice(0, 60), markUnpaidApiOnC52: mu.status, rev: [aRevMu.status, aRevMu.review_reason], rpRev }));
    // RB-L：C5.2 的 F1 缺口（限制記錄，不判定為可接受）
    const c0 = confirmsFor(rRev.call.tx);
    lpCtrl({ inquiry: '1150' }); const lL = await callback(base, rRev.call); lpCtrl({});
    RBL = { confirms_before: c0, confirms_after: confirmsFor(rRev.call.tx), redirect: lL.slice(0, 80), attempt: (await att(oRev.uuid)).status };
    console.log('  ℹ️ RB-L 限制記錄：C5.2 對待核對付款（查詢回 1150）再次 callback → 外部 Confirm 次數 ' + c0 + '→' + RBL.confirms_after + '，付款嘗試 ' + RBL.attempt);
    // C5.2 期間建立新付款（尚未 callback）
    const oNew = await order(base, U(4)); const rNew = await request(base, oNew);
    await stopOld();

    // ── 升級回 C5.3（遷移重跑兩次）──
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    await C.s.stop(); await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const cRev = confirmsFor(rRev.call.tx);
    lpCtrl({ inquiry: '1150' }); await callback(C.s.base, rRev.call); lpCtrl({});
    const aNew = await att(oNew.uuid);
    const lNew = await callback(C.s.base, rNew.call);
    const n2 = (await dbq('SELECT COUNT(*) AS c FROM orders'))[0].c;
    assert(confirmsFor(rRev.call.tx) === cRev && (await att(oRev.uuid)).status === 'review' && aNew.confirm_state === 'never' && /success/.test(lNew) && (await ord(oNew.uuid)).payment_status === 'paid'
      && (await att(oDup.uuid)).status === 'review' && n2 === n0 + 1,
    'RB3 升級回 C5.3：遷移可重複執行；待核對付款不再送 Confirm；C5.2 期間建立的付款（可信未送出）可正常完成；隔離紀錄維持待核對',
    JSON.stringify({ confirmsRev: [cRev, confirmsFor(rRev.call.tx)], newState: aNew.confirm_state, lNew: lNew.slice(0, 60), n2 }));
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
    assert(C.mf.real() === 0 && realPay === 0 && unexpected === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次、未知 LINE Pay 路徑 0 次', JSON.stringify({ line: C.mf.real(), linepay: realPay, unexpected }));
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally { if (oldProc) { try { oldProc.kill('SIGKILL'); } catch {} } try { await C.s.stop(); } catch {} }
  const s = H.summary();
  if (process.env.C53_RESULT_JSON) fs.writeFileSync(process.env.C53_RESULT_JSON, JSON.stringify({ pass: s.passCount, fail: s.failCount, rb_limitation: RBL, results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
