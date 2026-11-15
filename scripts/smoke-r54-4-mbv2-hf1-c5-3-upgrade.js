#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-3-upgrade.js
// R54.4／MBV2-HF1-C5.3 —— 真實升級驗證：由「未修改 C5.2」建立並使用資料庫檔（非 fixture），再以 C5.3 程式啟動同一個檔案。
// 執行方式：在未修改 C5.2 樹內執行本腳本（H.ROOT＝C5.2），C53_NEW_ROOT 指向 C5.3 樹。
//   U1 C5.2 期間產生：正常已付款、待核對（已送 Confirm）、尚未 callback 的付款、C5.2 對 1152 判 failed、官方明確拒絕 1142
//   U2 C5.3 啟動（遷移）：1152 failed → 隔離待核對；1142 failed、已付款不變；未 callback 的 C5.2 付款判定為可信未送出
//   U3 C5.3 處理：待核對付款再次 callback 不送 Confirm；可信未送出者正常完成；隔離紀錄以唯讀核對恢復；1142 可重新付款
//   U4 C5.3 再重啟：遷移結果不變（可重複執行）
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
const NEW = process.env.C53_NEW_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c53-up');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const setMockTx = (tx, patch) => { const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[tx] = { ...(st.tx[tx] || {}), ...patch }; fs.writeFileSync(LP.state, JSON.stringify(st)); };
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`], { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [711, '升級付款甲', 1, 'available', { quota: 300, price: 100 }]];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-up','test-secret-up')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); f.payment_api = true; f.line_order = true; db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};
(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.3 真實升級（C5.2 資料庫 → C5.3） ══════════');
  console.log('C5.2（建立資料）：' + H.ROOT + '　C5.3：' + (NEW || '（未提供）'));
  if (!NEW) { H.fail('需要 C53_NEW_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c53-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
    C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-up': 'test-secret-up' }) };
  const C = await C45.boot('c53up', { products: PRODUCTS, seed, env }); // 由 C5.2 程式建立資料庫
  let newProc = null; let nlog = '';
  try {
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const S = (u) => sessAt(u, OFF);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const order = async (base, u) => {
      const r = await C45.pub(base, 'POST', '/api/line-orders', { customer_name: '升級', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'linepay', items: [{ product_id: 711, qty: 1 }], member_session: S(u) });
      if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data;
    };
    const request = async (base, o) => { await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: o.uuid }); return lpCalls().filter((c) => /request$/.test(c.uri)).pop(); };
    const callback = async (base, call) => { const r = await fetch(`${base}/api/linepay/confirm?${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const dbq = async (sql, p) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
    const att = async (uuid) => (await dbq('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id', [uuid]))[0];
    const pay = async (uuid) => (await dbq('SELECT payment_status FROM orders WHERE uuid=?', [uuid]))[0].payment_status;

    // ── U1：C5.2 期間 ──
    const f = {};
    f.paid = await order(C.s.base, U(1)); f.paid.call = await request(C.s.base, f.paid); await callback(C.s.base, f.paid.call);
    lpCtrl({ confirmMode: 'drop', inquiry: 'error' }); f.rev = await order(C.s.base, U(2)); f.rev.call = await request(C.s.base, f.rev); await callback(C.s.base, f.rev.call); lpCtrl({});
    f.pend = await order(C.s.base, U(3)); f.pend.call = await request(C.s.base, f.pend);
    lpCtrl({ confirm: '1152', captureThen: true }); f.dup = await order(C.s.base, U(4)); f.dup.call = await request(C.s.base, f.dup); await callback(C.s.base, f.dup.call); lpCtrl({});
    lpCtrl({ confirm: '1142' }); f.dec = await order(C.s.base, U(5)); f.dec.call = await request(C.s.base, f.dec); await callback(C.s.base, f.dec.call); lpCtrl({});
    const c52 = {}; for (const k of Object.keys(f)) { const a = await att(f[k].uuid); c52[k] = [a.status, a.result_code || '']; }
    const cols52 = (await dbq('PRAGMA table_info(linepay_payment_attempts)')).map((c) => c.name);
    assert(c52.paid[0] === 'paid' && c52.rev[0] === 'review' && c52.pend[0] === 'requested' && c52.dup[0] === 'failed' && c52.dec[0] === 'failed' && !cols52.includes('confirm_state'),
      'U1 [API] 未修改 C5.2 建立並使用資料庫：已付款、待核對、未 callback、1152 判 failed（C5.2 缺陷）、1142 failed；資料庫沒有 C5.3 欄位', JSON.stringify(c52));
    await C.s.stop();

    // ── U2：C5.3 啟動同一檔案 ──
    const port = C.s.port; const base = `http://127.0.0.1:${port}`;
    const startNew = async () => {
      nlog = '';
      newProc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: NEW, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
        HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
      newProc.stdout.on('data', (d) => { nlog += d; }); newProc.stderr.on('data', (d) => { nlog += d; });
      for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch {} await sleep(150); }
      return false;
    };
    const stopNew = async () => { const p = newProc; newProc = null; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(r, 4000); }); };
    const up = await startNew();
    const log1 = nlog;
    const s2 = {}; for (const k of Object.keys(f)) { const a = await att(f[k].uuid); s2[k] = [a.status, a.result_code || '', a.confirm_state, a.review_reason || '']; }
    assert(up && s2.dup[0] === 'review' && /c53_quarantine:failed:1152/.test(s2.dup[3]) && s2.dec[0] === 'failed' && s2.paid[0] === 'paid' && s2.pend[2] === 'never' && s2.rev[2] === 'unknown' && s2.rev[0] === 'review'
      && /已隔離 1 筆/.test(log1),
    'U2 [RS] C5.3 啟動 C5.2 資料庫（遷移）：1152 failed 隔離為待核對；1142 failed、已付款不變；未 callback 的 C5.2 付款判定為可信未送出；待核對判定為不明；啟動紀錄列出隔離筆數',
    JSON.stringify({ s2, log: (log1.match(/\[DB\] linepay_recovery[^\n]*/g) || []).slice(0, 3) }));

    // ── U3：C5.3 處理 ──
    const tok = await H.login(base, STORE, 'pw001');
    const cRev = confirmsFor(f.rev.call.tx);
    lpCtrl({ inquiry: '1150' }); const lRev = await callback(base, f.rev.call); lpCtrl({});
    const lPend = await callback(base, f.pend.call);
    const aDup = await att(f.dup.uuid);
    const cDup = confirmsFor(f.dup.call.tx);
    await H.api(base, tok, 'POST', '/api/linepay-admin/reconcile', { attempt_uuid: aDup.attempt_uuid });
    const rpDec = (await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: f.dec.uuid })).status;
    const rpRev = (await C45.pub(base, 'POST', '/api/linepay/request', { order_uuid: f.rev.uuid })).status;
    assert(confirmsFor(f.rev.call.tx) === cRev && /pending/.test(lRev) && rpRev === 409 && /success/.test(lPend) && (await pay(f.pend.uuid)) === 'paid'
      && (await pay(f.dup.uuid)) === 'paid' && confirmsFor(f.dup.call.tx) === cDup && rpDec === 200,
    'U3 [API] C5.3 處理升級資料：C5.2 留下的待核對付款再次 callback 不送 Confirm、仍阻擋重新付款；可信未送出者正常完成；隔離的 1152 以唯讀核對恢復為已付款；1142 可重新付款',
    JSON.stringify({ revConfirms: [cRev, confirmsFor(f.rev.call.tx)], rpRev, lPend: lPend.slice(0, 50), dup: await pay(f.dup.uuid), rpDec }));

    // ── U4：再重啟 ──
    const snap = async () => { const o = {}; for (const k of Object.keys(f)) { const a = await att(f[k].uuid); o[k] = [a.status, a.confirm_state, a.review_reason || '', a.quarantined_from || '']; } return o; };
    const b4 = await snap();
    await stopNew(); await startNew();
    const log2 = nlog; const af = await snap();
    assert(JSON.stringify(b4) === JSON.stringify(af) && !/已隔離/.test(log2) && !/已判定/.test(log2), 'U4 [RS] C5.3 再次重啟：遷移不再改動任何付款嘗試（可重複執行）', JSON.stringify({ same: JSON.stringify(b4) === JSON.stringify(af) }));
    await stopNew();
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
    assert(C.mf.real() === 0 && realPay === 0 && unexpected === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次、未知 LINE Pay 路徑 0 次', JSON.stringify({ line: C.mf.real(), linepay: realPay, unexpected }));
    void setMockTx;
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally { if (newProc) { try { newProc.kill('SIGKILL'); } catch {} } try { await C.s.stop(); } catch {} }
  const s = H.summary();
  if (process.env.C53_RESULT_JSON) fs.writeFileSync(process.env.C53_RESULT_JSON, JSON.stringify({ pass: s.passCount, fail: s.failCount, results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
