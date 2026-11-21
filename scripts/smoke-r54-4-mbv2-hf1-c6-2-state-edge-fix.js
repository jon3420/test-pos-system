#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-state-edge-fix.js
// R54.4／MBV2-HF1-C6.2 登記份數狀態邊界修正 —— 新驗收（同一份腳本、同一組斷言：先跑未修改 DURABLE_RECOVERY_FIX，再跑修正版與候選版）
//   缺口 A：綁定尚未補齊、訂單已履約再作廢 → 補齊後錯誤留下全部未購買需求
//   缺口 B：補齊扣減只看 status，不看實際有效期限（自然到期、status 仍 active）
//   缺口 C：作廢前履約狀態缺失（NULL／空字串／不合法）被當成已證明未履約而回復
// 測試層級標示：
//   [API] 正式路由（node server.js；顧客下單、付款、店家改狀態、作廢、登記都走正式 HTTP）
//   [DB] 直接讀資料庫檔核對份數、關聯與待辦
//   [FX-DB] 停機後以資料庫 fixture 改寫：期限、NULL／不合法履約狀態、歷史錯誤終態（無法由正式操作產生者）
//   [KILL] 真實 SIGKILL（測試 preload 在指定停點對伺服器程序送 SIGKILL，同一資料庫重啟）
//   [FAULT] 測試 preload 注入的保存失敗（交易內拋出例外）
//   [RS] 一般停機重啟；[TZ] 以 TZ=UTC 與 TZ=Asia/Taipei 啟動伺服器
//   本腳本沒有函式級或瀏覽器案例。
// 分類：N＝本輪修正（未修改基準應以份數、關聯狀態或待辦結果的業務斷言失敗）；G＝保留既有行為（基準也應通過）。
// 外部呼叫：LINE（c4-line-mock）、LINE Pay（c5-linepay-mock）程序內攔截；真實 LINE／LINE Pay／Sandbox 0。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const Seed = require('./lib/mbv2-seed');
const { H, STORE, U, sleep } = C45;
const { assert } = H;

const ONLY = (process.env.C62S_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const OBS = {};
async function step(name, cls, fn) { try { await fn(); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }
const ok = (cond, name, cls, detail) => assert(!!cond, `${name} [${cls}]`, detail);

const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62s');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62s');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const setCtrl = (o) => fs.writeFileSync(CTRL, JSON.stringify(o || {}));
const setLp = (o) => fs.writeFileSync(LP_CTRL, JSON.stringify(o || { confirm: '0000' }));
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const PIDS = Array.from({ length: 20 }, (_, i) => 801 + i);
const PRODUCTS = PIDS.map((id, i) => [id, '測試品' + id, i, 'available', { quota: 200, price: 50 + i }]);

let port = 0; let srv = null; let curEnv = {};
async function start(extraEnv = curEnv, noLogin = false) {
  curEnv = extraEnv;
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL,
    PD_SETTLE_SWEEP_MS: '1500', ...extraEnv };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { proc, log: '' };
  proc.stdout.on('data', (d) => { me.log += d; }); proc.stderr.on('data', (d) => { me.log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null || proc.signalCode) throw new Error('server exited: ' + me.log.slice(-1500)); if (i > 250) throw new Error('start timeout'); await sleep(150); }
  me.base = base;
  me.tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  me.stop = () => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); });
  me.died = (ms) => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(proc.signalCode || 'exit'); const t = setTimeout(() => res(null), ms || 20000); proc.once('exit', (c, sg) => { clearTimeout(t); res(sg || 'exit'); }); });
  srv = me;
  return me;
}
const stop = async () => { if (srv) await srv.stop(); await sleep(300); };
const restart = async (env) => { await stop(); return start(env); };
// 伺服器寫入資料庫檔的瞬間可能讀到不完整的檔案（測試端讀取時序），短暫重試
const q = async (sql, params) => { for (let i = 0; ; i++) { await sleep(150 + i * 250); let db = null; try { db = await H.openDbFile(dbf); return H.q(db, sql, params); } catch (e) { if (i >= 6) throw e; } finally { try { if (db) db.close(); } catch {} } } };
// [FX-DB]：只在伺服器停止時改寫
const fx = async (fn) => { const db = await H.openDbFile(dbf); try { fn(db); H.saveDbFile(db, dbf); } finally { db.close(); } };
const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const reg = async (u, pid, qty) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any' }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
async function order(u, items, pay = 'cash') {
  await sleep(1100);
  const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay,
    items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u), analytics: { visitor_id: 'v_c62s', session_id: 's_c62s' } });
  if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json.data;
}
const reqOf = async (uuid) => (await q('SELECT * FROM product_demand_requests WHERE request_uuid=?', [uuid]))[0];
const linksOf = (ouuid) => q('SELECT * FROM product_demand_order_links WHERE order_uuid=? ORDER BY product_id', [ouuid]);
const linkOf = async (ouuid, pid) => (await q('SELECT * FROM product_demand_order_links WHERE order_uuid=? AND product_id=?', [ouuid, pid]))[0];
const tasksOf = (ouuid) => q('SELECT kind, product_id, state, result, prior_order_status FROM product_demand_settle_tasks WHERE order_uuid=? ORDER BY id', [ouuid]);
const orderRow = async (uuid) => (await q('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
const setStatus = async (uuid, status) => { const o = await orderRow(uuid); const r = await adm('PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status }); if (!r.json || !r.json.success) throw new Error('status ' + r.text.slice(0, 200)); return r; };
const voidO = async (uuid) => { const o = await orderRow(uuid); return adm('POST', `/api/orders/${encodeURIComponent(o.id)}/void`, { reason: '測試作廢' }); };
const lpReq = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp ' + r.text); return (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
const lpConfirm = (a) => fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
const confirmCalls = () => fs.readFileSync(LP_LOG, 'utf8').split('\n').filter((l) => l.includes('/confirm')).length;
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); } };
// 等待該訂單的待辦都不再是 pending（基準也有待辦表）；再多等一輪補齊
//   故障期間累積的重試退避可能讓定期補齊延後處理；短暫等待後仍未完成就正常重啟（啟動補齊不等待退避）
const pendingOf = async (ouuid) => (await q("SELECT COUNT(*) AS c FROM product_demand_settle_tasks WHERE order_uuid=? AND state='pending'", [ouuid]))[0].c;
const settleWait = async (ouuid, ms = 8000) => {
  if (!(await until(async () => (await pendingOf(ouuid)) === 0, ms))) { OBS.restarts_for_backoff = (OBS.restarts_for_backoff || 0) + 1; await restart(); await until(async () => (await pendingOf(ouuid)) === 0, 15000); }
  await sleep(2500);
};
const mine = async (u, ruuid) => {
  const r = await pub('POST', '/api/product-demand/mine', { member_session: S(u) });
  const find = (x) => { if (!x || typeof x !== 'object') return null; if (x.request_uuid === ruuid) return x; for (const v of Object.values(x)) { const f = find(v); if (f) return f; } return null; };
  return find(r.json && r.json.data);
};
const events = async (ouuid) => (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','submit_order')", [ouuid]))[0].c;
const notifyCounts = async () => ({ b: (await q('SELECT COUNT(*) AS c FROM restock_notify_batches'))[0].c, d: (await q('SELECT COUNT(*) AS c FROM restock_notify_deliveries'))[0].c });
const pick = (l) => l && [l.state, Number(l.applied_qty), l.note];

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 登記份數狀態邊界修正 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　時鐘位移（毫秒）：' + OFF);
  try {
    await start({}, true); await stop();
    await fx((db) => { Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62s','test-secret-c62s')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); });
    await start({});
    const N0 = await notifyCounts();

    // ═════════════ 缺口 A：延遲綁定 × 付款 × 履約 × 作廢 ═════════════
    let A2o = null, A2a = null, A2r = null;
    if (want('a')) {
      await step('A1', 'N', async () => {
        const r = await reg(U(1), 801, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(1), [[801, 3]]);
        await setStatus(o.uuid, 'completed');
        const v = await voidO(o.uuid);
        const mid = { s: Number((await reqOf(r.request_uuid)).settled_qty || 0), t: await tasksOf(o.uuid) };
        setCtrl({});
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 801); const T = await tasksOf(o.uuid); const M = await mine(U(1), r.request_uuid);
        const vt = T.find((t) => t.kind === 'void'); const bt = T.find((t) => t.kind === 'bind');
        ok(v.json && v.json.success && mid.s === 0 && Number(R.settled_qty) === 3 && R.status === 'active' && M && Number(M.settled_qty) === 3 && Number(M.to_buy_qty) === 2
          && L && L.state === 'review' && Number(L.applied_qty) === 3 && /^void_after_completed/.test(L.note) && bt && bt.state === 'done' && vt && vt.state === 'done' && /review/.test(String(vt.result)),
        'A1 [API][DB] 現金：綁定延遲 → 履約 → 作廢 → 故障解除補齊：登記 5、購買 3 → 已完成 3、尚待購買 2；關聯待核對（保留份數）；作廢待辦結果可追查為待核對', 'N',
        JSON.stringify({ mid, R: [R.status, R.settled_qty], mine: M && [M.settled_qty, M.to_buy_qty], L: pick(L), T }));
      });
      await step('A2', 'N', async () => {
        A2r = await reg(U(2), 802, 5);
        setCtrl({ bind: 'always' });
        A2o = await order(U(2), [[802, 3]], 'linepay');
        A2a = await lpReq(A2o.uuid); await lpConfirm(A2a); await sleep(500);
        const paid = (await orderRow(A2o.uuid)).payment_status;
        await setStatus(A2o.uuid, 'completed');
        await voidO(A2o.uuid);
        setCtrl({});
        await settleWait(A2o.uuid);
        const R = await reqOf(A2r.request_uuid); const L = await linkOf(A2o.uuid, 802); const M = await mine(U(2), A2r.request_uuid);
        OBS.A2 = { confirm: confirmCalls(), ev: await events(A2o.uuid) };
        ok(paid === 'paid' && Number(R.settled_qty) === 3 && M && Number(M.to_buy_qty) === 2 && L && L.state === 'review' && Number(L.applied_qty) === 3 && confirmCalls() === 1,
          'A2 [API][DB] LINE Pay：正式模擬付款成功（後端 paid）→ 履約 → 作廢 → 補齊：已完成 3、尚待購買 2、待核對；Confirm 1 次', 'N',
          JSON.stringify({ paid, R: R.settled_qty, mine: M && [M.settled_qty, M.to_buy_qty], L: pick(L), confirm: confirmCalls() }));
      });
      await step('A3', 'N', async () => {
        const r = await reg(U(3), 803, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(3), [[803, 3]], 'linepay');
        await lpReq(o.uuid); // 付款請求已建立、尚未付款
        await setStatus(o.uuid, 'completed');
        await voidO(o.uuid);
        setCtrl({});
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 803); const or = await orderRow(o.uuid);
        ok(or.payment_status !== 'paid' && Number(R.settled_qty || 0) === 0 && L && L.state === 'review' && Number(L.applied_qty) === 0 && /payment_unconfirmed/.test(String(L.note)),
          'A3 [API][DB] LINE Pay 待付款：履約欄位 completed 後作廢 → 不推定已付款、不扣減（已完成 0）；關聯待核對並註明付款未確認', 'N',
          JSON.stringify({ pay: or.payment_status, R: R.settled_qty, L: pick(L) }));
      });
      await step('A3-2', 'G', async () => {
        const r = await reg(U(4), 804, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(4), [[804, 3]], 'linepay');
        const a = await lpReq(o.uuid);
        setLp({ confirm: '9000' }); await lpConfirm(a); await sleep(500); setLp({ confirm: '0000' });
        const at = (await q('SELECT status FROM linepay_payment_attempts WHERE attempt_uuid=?', [a.attempt_uuid]))[0];
        await setStatus(o.uuid, 'completed');
        setCtrl({});
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 804); const or = await orderRow(o.uuid);
        ok(or.payment_status !== 'paid' && Number(R.settled_qty || 0) === 0 && (!L || L.state !== 'settled'),
          'A3-2 [API][DB] LINE Pay 付款結果不明（Confirm 失敗回應）且履約欄位 completed（未作廢）→ 不因履約推定已付款、不扣減', 'G',
          JSON.stringify({ attempt: at && at.status, pay: or.payment_status, R: R.settled_qty, L: pick(L) }));
      });
      await step('A4', 'G', async () => {
        const r = await reg(U(5), 805, 5);
        const o1 = await order(U(5), [[805, 1]]); // 準時綁定：已完成 1
        setCtrl({ bind: 'always' });
        const o2 = await order(U(5), [[805, 3]]); await setStatus(o2.uuid, 'cancelled'); // 未履約取消
        const o3 = await order(U(5), [[805, 2]]); await setStatus(o3.uuid, 'accepted'); await voidO(o3.uuid); // 未履約作廢
        setCtrl({});
        await settleWait(o2.uuid); await settleWait(o3.uuid);
        const R = await reqOf(r.request_uuid); const L2 = await linkOf(o2.uuid, 805); const L3 = await linkOf(o3.uuid, 805); const L1 = await linkOf(o1.uuid, 805);
        ok(Number(R.settled_qty) === 1 && L1.state === 'settled' && (!L2 || L2.state !== 'settled' && L2.state !== 'reverted') && (!L3 || L3.state !== 'settled' && L3.state !== 'reverted'),
          'A4 [API][DB] 延遲綁定 → 未履約取消／作廢：從未扣減者不扣也不回復（已完成維持 1）', 'G', JSON.stringify({ R: R.settled_qty, L1: pick(L1), L2: pick(L2), L3: pick(L3) }));
      });
      await step('A5', 'N', async () => {
        const r6 = await reg(U(6), 806, 5); const r7 = await reg(U(6), 807, 5);
        setCtrl({ bindPids: [807] });
        const o = await order(U(6), [[806, 2], [807, 3]]);
        const mid = Number((await reqOf(r6.request_uuid)).settled_qty);
        await setStatus(o.uuid, 'completed');
        await voidO(o.uuid);
        setCtrl({});
        await settleWait(o.uuid);
        const R6 = await reqOf(r6.request_uuid); const R7 = await reqOf(r7.request_uuid); const L6 = await linkOf(o.uuid, 806); const L7 = await linkOf(o.uuid, 807);
        ok(mid === 2 && Number(R6.settled_qty) === 2 && Number(R7.settled_qty) === 3 && L6.state === 'review' && Number(L6.applied_qty) === 2 && L7 && L7.state === 'review' && Number(L7.applied_qty) === 3,
          'A5 [API][DB] 多商品：已綁定商品（2）與延遲綁定商品（3）逐商品正確：已完成 2／3、皆待核對、不重複扣減', 'N', JSON.stringify({ mid, R6: R6.settled_qty, R7: R7.settled_qty, L6: pick(L6), L7: pick(L7), T: await tasksOf(o.uuid) }));
      });
      await step('A6', 'N', async () => {
        if (!A2o) throw new Error('A2 未執行');
        const c0 = confirmCalls(); const e0 = await events(A2o.uuid); const n0 = await notifyCounts();
        await lpConfirm(A2a); await sleep(500); // 重複 callback
        await restart(); await sleep(3500); await restart(); await sleep(3500); // 重啟兩次（含啟動補齊）
        const R = await reqOf(A2r.request_uuid); const L = await linkOf(A2o.uuid, 802); const n1 = await notifyCounts();
        ok(Number(R.settled_qty) === 3 && L.state === 'review' && Number(L.applied_qty) === 3 && confirmCalls() === c0 && (await events(A2o.uuid)) === e0 && n1.b === n0.b && n1.d === n0.d,
          'A6 [API][RS][DB] 重複 callback、重啟兩次與定期補齊：已完成維持 3；Confirm、購買事件與通知筆數不增加', 'N',
          JSON.stringify({ R: R.settled_qty, L: pick(L), confirm: [c0, confirmCalls()], ev: e0, n0, n1 }));
      });
    }

    // ═════════════ 缺口 B：實際有效期限 ═════════════
    if (want('b')) {
      await step('B1', 'N', async () => {
        const r = await reg(U(7), 809, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(7), [[809, 3]]);
        await stop();
        await fx((db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-120 seconds') WHERE request_uuid=?", [r.request_uuid]));
        setCtrl({});
        await start();
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 809);
        const M = await pub('POST', '/api/product-demand/mine', { member_session: S(U(7)) });
        ok(R.status === 'active' && Number(R.settled_qty || 0) === 0 && L && Number(L.applied_qty) === 0 && /expire/.test(String(L.note)) && !String(M.text).includes(r.request_uuid),
          'B1 [FX-DB][API][DB] 自然到期（expires_at 已過、status 仍 active、未重新登記）→ 補齊新增扣減 0、註明過期；資料列不被改寫或復活', 'N',
          JSON.stringify({ R: [R.status, R.settled_qty, R.expires_at], L: pick(L) }));
      });
      await step('B2', 'G', async () => {
        const r = await reg(U(8), 810, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(8), [[810, 3]]);
        await stop();
        await fx((db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-120 seconds') WHERE request_uuid=?", [r.request_uuid]));
        await start();
        const rn = await reg(U(8), 810, 4); // 重新登記 → 舊週期改為 expired、建立新週期
        setCtrl({});
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const RN = await reqOf(rn.request_uuid); const L = await linkOf(o.uuid, 810);
        ok(R.status === 'expired' && Number(R.settled_qty || 0) === 0 && RN.status === 'active' && Number(RN.settled_qty || 0) === 0 && L && L.request_uuid === r.request_uuid && Number(L.applied_qty) === 0,
          'B2 [FX-DB][API][DB] 已改為 expired 並有新週期：舊週期扣 0、新週期不受影響', 'G', JSON.stringify({ R: [R.status, R.settled_qty], RN: [RN.status, RN.settled_qty], L: pick(L) }));
      });
      await step('B2-2', 'G', async () => {
        const r = await reg(U(9), 811, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(9), [[811, 3]]);
        const c = await pub('POST', '/api/product-demand/cancel', { member_session: S(U(9)), product_id: 811 });
        const rn = await reg(U(9), 811, 2);
        setCtrl({});
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const RN = await reqOf(rn.request_uuid); const L = await linkOf(o.uuid, 811);
        ok(c.json && c.json.success && R.status === 'cancelled' && Number(R.settled_qty || 0) === 0 && RN.status === 'active' && Number(RN.settled_qty || 0) === 0 && L && Number(L.applied_qty) === 0,
          'B2-2 [API][DB] 取消後重新登記：原週期扣 0、不復活；新週期不受影響', 'G', JSON.stringify({ R: [R.status, R.settled_qty], RN: [RN.status, RN.settled_qty], L: pick(L), T: await tasksOf(o.uuid), c: c.status }));
      });
      // B3：到期邊界前後 × 主機時區
      for (const [k, tz] of [[0, 'UTC'], [1, 'Asia/Taipei']]) {
        await step('B3-' + tz, 'N', async () => {
          const ux = U(20 + k * 2), uy = U(21 + k * 2);
          const rx = await reg(ux, 812, 5); const ry = await reg(uy, 812, 5);
          setCtrl({ bind: 'always' });
          const ox = await order(ux, [[812, 3]]); const oy = await order(uy, [[812, 3]]);
          await stop();
          await fx((db) => {
            db.run("UPDATE product_demand_requests SET expires_at=datetime('now','+600 seconds') WHERE request_uuid=?", [rx.request_uuid]);
            db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-5 seconds') WHERE request_uuid=?", [ry.request_uuid]);
          });
          setCtrl({});
          await start({ TZ: tz });
          await settleWait(ox.uuid); await settleWait(oy.uuid);
          const RX = await reqOf(rx.request_uuid); const RY = await reqOf(ry.request_uuid);
          ok(Number(RX.settled_qty) === 3 && Number(RY.settled_qty || 0) === 0 && RY.status === 'active',
            `B3-${tz} [FX-DB][TZ][DB] 伺服器 TZ=${tz}：到期前（+600 秒）補齊扣 3；剛過期（−5 秒）扣 0`, 'N', JSON.stringify({ RX: [RX.status, RX.settled_qty, RX.expires_at], RY: [RY.status, RY.settled_qty, RY.expires_at] }));
        });
      }
      await restart({});
      await step('B4', 'G', async () => {
        const r = await reg(U(10), 813, 5);
        const o = await order(U(10), [[813, 3]]);
        const s0 = Number((await reqOf(r.request_uuid)).settled_qty);
        await stop();
        await fx((db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-120 seconds') WHERE request_uuid=?", [r.request_uuid]));
        await start(); await sleep(3500); await restart(); await sleep(3500);
        await setStatus(o.uuid, 'completed'); await sleep(2500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 813);
        ok(s0 === 3 && Number(R.settled_qty) === 3 && L.state === 'settled' && Number(L.applied_qty) === 3,
          'B4 [API][FX-DB][RS] 已扣減後才到期：重啟、補齊、履約都保留原已完成 3（不清除、不回復）', 'G', JSON.stringify({ s0, R: [R.status, R.settled_qty], L: pick(L) }));
      });
      await step('B5', 'N', async () => {
        const r = await reg(U(11), 814, 5);
        setCtrl({ bind: 'always' });
        const o = await order(U(11), [[814, 3]]);
        await stop();
        await fx((db) => db.run("UPDATE product_demand_requests SET expires_at='not-a-date' WHERE request_uuid=?", [r.request_uuid]));
        setCtrl({});
        await start();
        await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 814);
        ok(Number(R.settled_qty || 0) === 0 && L && L.state === 'review' && Number(L.applied_qty) === 0 && /validity/.test(String(L.note)),
          'B5 [FX-DB][DB] 期限無法解析：不扣減，關聯待核對並註明有效性不明', 'N', JSON.stringify({ R: [R.status, R.settled_qty], L: pick(L) }));
      });
    }

    // ═════════════ 缺口 C：作廢前履約狀態 ═════════════
    if (want('c')) {
      const settled3 = async (u, pid) => { const r = await reg(u, pid, 5); const o = await order(u, [[pid, 3]]); return { r, o }; };
      const cases = [['C1', 'NULL', null], ['C2', '空字串', ''], ['C3', '不合法', 'shipped_x']];
      const made = [];
      for (const [id, , val] of cases) made.push({ id, val, ...(await settled3(U(30 + made.length), 815)) });
      await stop();
      await fx((db) => { for (const m of made) db.run('UPDATE orders SET order_status=? WHERE uuid=?', [m.val, m.o.uuid]); });
      await start();
      for (const m of made) {
        const lbl = cases.find((c) => c[0] === m.id)[1];
        await step(m.id, 'N', async () => {
          const v = await voidO(m.o.uuid); await sleep(2500);
          const R = await reqOf(m.r.request_uuid); const L = await linkOf(m.o.uuid, 815); const T = await tasksOf(m.o.uuid); const vt = T.find((t) => t.kind === 'void');
          ok(v.json && v.json.success && Number(R.settled_qty) === 3 && L.state === 'review' && /void_prior_state/.test(String(L.note)) && vt && vt.state === 'done' && /review/.test(String(vt.result)),
            `${m.id} [FX-DB][API][DB] 作廢前 order_status 為${lbl} → 待核對、不自動回復（已完成維持 3）；作廢待辦結果為待核對`, 'N', JSON.stringify({ R: R.settled_qty, L: pick(L), vt }));
        });
      }
      await step('C4', 'G', async () => {
        const { r, o } = await settled3(U(40), 816); await setStatus(o.uuid, 'accepted'); await voidO(o.uuid); await sleep(2500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 816);
        ok(Number(R.settled_qty) === 0 && L.state === 'reverted', 'C4 [API][DB] 合法未履約（accepted）作廢 → 回復一次（3 → 0）', 'G', JSON.stringify({ R: R.settled_qty, L: pick(L) }));
      });
      await step('C5', 'G', async () => {
        const { r, o } = await settled3(U(41), 816); await setStatus(o.uuid, 'completed'); await voidO(o.uuid); await sleep(2500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 816);
        ok(Number(R.settled_qty) === 3 && L.state === 'review' && L.note === 'void_after_completed', 'C5 [API][DB] 合法已履約（completed）作廢 → 待核對、保留 3', 'G', JSON.stringify({ R: R.settled_qty, L: pick(L) }));
      });
      await step('C6', 'G', async () => {
        const { r, o } = await settled3(U(42), 816); await setStatus(o.uuid, 'cancelled'); await sleep(1500); const s1 = Number((await reqOf(r.request_uuid)).settled_qty);
        await voidO(o.uuid); await sleep(2500); await restart(); await sleep(3500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 816);
        ok(s1 === 0 && Number(R.settled_qty) === 0 && L.state === 'reverted', 'C6 [API][RS][DB] 取消後再作廢、重啟補齊 → 只回復一次', 'G', JSON.stringify({ s1, R: R.settled_qty, L: pick(L) }));
      });
      const c7 = await settled3(U(43), 817); const c8 = await settled3(U(44), 817);
      await stop();
      await fx((db) => {
        db.run("UPDATE orders SET status='completed', order_status='accepted' WHERE uuid=?", [c7.o.uuid]);
        db.run("UPDATE orders SET status='void', order_status='cancelled' WHERE uuid=?", [c8.o.uuid]); // 沒有作廢待辦的歷史作廢
      });
      await start();
      await step('C7', 'G', async () => {
        await voidO(c7.o.uuid); await sleep(2500);
        const R = await reqOf(c7.r.request_uuid); const L = await linkOf(c7.o.uuid, 817);
        ok(Number(R.settled_qty) === 0 && L.state === 'reverted', 'C7 [FX-DB][API][DB] status=completed、order_status=accepted → 依履約流程判為未履約、回復', 'G', JSON.stringify({ R: R.settled_qty, L: pick(L) }));
      });
      await step('C8', 'G', async () => {
        await sleep(3000);
        const R = await reqOf(c8.r.request_uuid); const L = await linkOf(c8.o.uuid, 817);
        ok(Number(R.settled_qty) === 3 && L.state === 'review', 'C8 [FX-DB][DB] 缺少作廢歷史證據（沒有作廢待辦）→ 待核對、保留 3', 'G', JSON.stringify({ R: R.settled_qty, L: pick(L) }));
      });
      await step('C9', 'N', async () => {
        const { r, o } = await settled3(U(45), 818);
        await stop(); await fx((db) => db.run('UPDATE orders SET order_status=NULL WHERE uuid=?', [o.uuid])); await start();
        setCtrl({ killAt: 'order_void' });
        voidO(o.uuid).catch(() => {});
        const sig = await srv.died(20000);
        const mid = { s: Number((await reqOf(r.request_uuid)).settled_qty), st: (await orderRow(o.uuid)).status };
        if (!sig) await stop();
        setCtrl({}); await start(); await sleep(4000); await restart(); await sleep(3500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 818);
        ok(sig === 'SIGKILL' && mid.st === 'void' && Number(R.settled_qty) === 3 && L.state === 'review',
          'C9 [FX-DB][KILL][RS] 原履約狀態 NULL、作廢交易提交後 SIGKILL → 同一資料庫重啟補齊：待核對、不回復（3）；再次重啟不變', 'N', JSON.stringify({ sig, mid, R: R.settled_qty, L: pick(L) }));
      });
    }

    // ═════════════ 歷史錯誤終態（未修改基準已產生的資料）═════════════
    if (want('h')) {
      const h1 = { r: await reg(U(50), 819, 5) }; setCtrl({ bind: 'always' }); h1.o = await order(U(50), [[819, 3]]);
      const h3 = { r: await reg(U(52), 819, 5) }; h3.o = await order(U(52), [[819, 3]], 'linepay');
      setCtrl({});
      const h2 = { r: await reg(U(51), 820, 5) }; h2.o = await order(U(51), [[820, 3]]);
      await sleep(3000);
      await stop();
      await fx((db) => {
        const mk = (h, pid, pay) => {
          db.run("UPDATE orders SET status='void', order_status='cancelled' WHERE uuid=?", [h.o.uuid]);
          db.run("UPDATE product_demand_settle_tasks SET state='done', result='linked', done_at=datetime('now') WHERE order_uuid=? AND kind='bind'", [h.o.uuid]);
          db.run('DELETE FROM product_demand_order_links WHERE order_uuid=?', [h.o.uuid]);
          db.run(`INSERT INTO product_demand_order_links (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, note, released_at)
                  VALUES (?, 'store_001', ?, '', ?, ?, ?, 3, 0, 'released', ?, 'void_after_completed', datetime('now'))`, ['fx-' + h.o.uuid, h.o.uuid, pid, h.r.request_uuid, h.uid, pay]);
          db.run(`INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, prior_record_status, state, result, done_at)
                  VALUES (?, 'store_001', ?, 'void', 0, 'completed', 'pending', 'done', 'review_void', datetime('now'))`, ['fxv-' + h.o.uuid, h.o.uuid]);
        };
        h1.uid = U(50); h3.uid = U(52); mk(h1, 819, 'cash'); mk(h3, 819, 'linepay');
        // 夾具前補齊可能已處理：還原為基準終態的份數（已完成 0）
        db.run("UPDATE product_demand_requests SET settled_qty=0, status='active', completed_at=NULL WHERE request_uuid IN (?,?)", [h1.r.request_uuid, h3.r.request_uuid]);
        // C 型：原履約狀態空字串卻被回復（reverted）
        db.run("UPDATE orders SET status='void', order_status='cancelled' WHERE uuid=?", [h2.o.uuid]);
        db.run("UPDATE product_demand_order_links SET state='reverted', note='order_cancelled', reverted_at=datetime('now') WHERE order_uuid=?", [h2.o.uuid]);
        db.run("UPDATE product_demand_requests SET settled_qty=0 WHERE request_uuid=?", [h2.r.request_uuid]);
        db.run(`INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, prior_record_status, state, result, done_at)
                VALUES (?, 'store_001', ?, 'void', 0, '', 'pending', 'done', 'cancel', datetime('now'))`, ['fxv-' + h2.o.uuid, h2.o.uuid]);
      });
      await start(); await sleep(4000);
      const snap1 = { h1: await reqOf(h1.r.request_uuid), h2: await reqOf(h2.r.request_uuid), h3: await reqOf(h3.r.request_uuid) };
      await restart(); await sleep(4000);
      await step('H1', 'N', async () => {
        const R = await reqOf(h1.r.request_uuid); const L = await linkOf(h1.o.uuid, 819);
        ok(Number(snap1.h1.settled_qty) === 3 && Number(R.settled_qty) === 3 && L.state === 'review' && Number(L.applied_qty) === 3,
          'H1 [FX-DB][RS][DB] 基準留下的「done 待辦＋released＋applied 0＋可信已履約作廢（現金）」→ 依證據補記已完成 3 並待核對；再次重啟不重複扣', 'N',
          JSON.stringify({ first: snap1.h1.settled_qty, R: R.settled_qty, L: pick(L) }));
      });
      await step('H2', 'N', async () => {
        const R = await reqOf(h2.r.request_uuid); const L = await linkOf(h2.o.uuid, 820); const vt = (await tasksOf(h2.o.uuid)).find((t) => t.kind === 'void');
        ok(Number(R.settled_qty || 0) === 0 && L.state === 'reverted' && /legacy_review/.test(String(L.note)) && /legacy_review/.test(String(vt && vt.result)),
          'H2 [FX-DB][DB] 基準以空白原履約狀態回復的作廢 → 列為待核對（關聯與待辦可查），不自動改份數', 'N', JSON.stringify({ R: R.settled_qty, L: pick(L), vt }));
      });
      await step('H3', 'G', async () => {
        const R = await reqOf(h3.r.request_uuid); const L = await linkOf(h3.o.uuid, 819);
        ok(Number(R.settled_qty || 0) === 0 && Number(L.applied_qty) === 0, 'H3 [FX-DB][DB] 同樣終態但 LINE Pay 未付款（證據不足）→ 不補扣減', 'G', JSON.stringify({ R: R.settled_qty, L: pick(L) }));
      });
    }

    // ═════════════ 交易提交前後的保存失敗與真實 SIGKILL ═════════════
    if (want('k')) {
      const prep = async (u, pid) => { const r = await reg(u, pid, 5); setCtrl({ bind: 'always' }); const o = await order(u, [[pid, 3]]); await setStatus(o.uuid, 'completed'); await voidO(o.uuid); return { r, o }; };
      await step('K1', 'N', async () => {
        const { r, o } = await prep(U(60), 801);
        setCtrl({ killBeforeSyncOrder: o.uuid });
        const sig = await srv.died(25000);
        const mid = { s: Number((await reqOf(r.request_uuid)).settled_qty || 0), L: pick(await linkOf(o.uuid, 801)), T: await tasksOf(o.uuid) };
        if (!sig) await stop();
        setCtrl({}); await start(); await settleWait(o.uuid); await restart(); await sleep(3500);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 801); const vt = (await tasksOf(o.uuid)).find((t) => t.kind === 'void');
        ok(sig === 'SIGKILL' && mid.s === 0 && Number(R.settled_qty) === 3 && L.state === 'review' && vt.state === 'done',
          'K1 [KILL][RS] 綁定交易已提交、份數同步前 SIGKILL → 重啟後補記 3 並待核對；再次重啟不變', 'N', JSON.stringify({ sig, mid, R: R.settled_qty, L: pick(L), vt }));
      });
      await step('K2', 'N', async () => {
        const { r, o } = await prep(U(61), 802);
        setCtrl({ voidSettleFail: true });
        await sleep(6000);
        const mid = { s: Number((await reqOf(r.request_uuid)).settled_qty || 0), L: pick(await linkOf(o.uuid, 802)), vt: (await tasksOf(o.uuid)).find((t) => t.kind === 'void') };
        setCtrl({}); await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 802);
        const noHalf = mid.s === 0 && (!mid.L || mid.L[0] === 'reserved') && mid.vt && mid.vt.state === 'pending';
        ok(noHalf && Number(R.settled_qty) === 3 && L.state === 'review',
          'K2 [FAULT][DB] 補記交易提交前保存失敗 → 整筆回滾（無扣減、關聯仍訂購中、作廢待辦仍待處理）；故障解除後補記 3 並待核對', 'N', JSON.stringify({ mid, R: R.settled_qty, L: pick(L) }));
      });
      await step('K3', 'N', async () => {
        const { r, o } = await prep(U(62), 803);
        setCtrl({ killInVoidSettle: true });
        const sig = await srv.died(20000);
        const mid = { s: Number((await reqOf(r.request_uuid)).settled_qty || 0), L: pick(await linkOf(o.uuid, 803)), vt: (await tasksOf(o.uuid)).find((t) => t.kind === 'void') };
        if (!sig) await stop();
        setCtrl({}); await start(); await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 803);
        ok(sig === 'SIGKILL' && mid.s === 0 && mid.vt && mid.vt.state === 'pending' && Number(R.settled_qty) === 3 && L.state === 'review',
          'K3 [KILL][RS] 補記交易提交前 SIGKILL → 磁碟上沒有半套（扣減 0、作廢待辦仍待處理）；重啟後補記 3 並待核對', 'N', JSON.stringify({ sig, mid, R: R.settled_qty, L: pick(L) }));
      });
      await step('K4', 'N', async () => {
        if (!srv || srv.proc.exitCode != null || srv.proc.signalCode) await start();
        const r = await reg(U(63), 804, 5);
        setCtrl({ bind: 'always' }); const o = await order(U(63), [[804, 3]]); await setStatus(o.uuid, 'completed');
        setCtrl({ bind: 'always', killAt: 'order_void' }); voidO(o.uuid).catch(() => {});
        const sig = await srv.died(20000);
        const mid = { st: (await orderRow(o.uuid)).status, T: await tasksOf(o.uuid) };
        if (!sig) await stop();
        setCtrl({}); await start(); await settleWait(o.uuid);
        const R = await reqOf(r.request_uuid); const L = await linkOf(o.uuid, 804);
        ok(sig === 'SIGKILL' && mid.st === 'void' && Number(R.settled_qty) === 3 && L && L.state === 'review',
          'K4 [KILL][RS] 綁定待辦未完成、已履約作廢交易提交後 SIGKILL → 重啟後補記 3 並待核對', 'N', JSON.stringify({ sig, mid, R: R.settled_qty, L: pick(L) }));
      });
    }

    await step('Z1', 'G', async () => {
      const n = await notifyCounts();
      ok(mf.real() === 0 && n.b === N0.b && n.d === N0.d, 'Z1 全程：真實 LINE 0；補齊沒有建立任何補貨通知批次或逐筆紀錄', 'G', JSON.stringify({ real: mf.real(), n }));
    });
    OBS.lp = { confirm_calls: confirmCalls(), lines: fs.readFileSync(LP_LOG, 'utf8').split('\n').filter(Boolean).length };
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log('OBS ' + JSON.stringify(OBS));
  if (process.env.C62S_RESULT) { try { fs.writeFileSync(process.env.C62S_RESULT, JSON.stringify({ root: H.ROOT, pass: s.passCount, fail: s.failCount, obs: OBS }, null, 1)); } catch {} }
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  process.exit(s.failCount ? 1 : 0);
})();
