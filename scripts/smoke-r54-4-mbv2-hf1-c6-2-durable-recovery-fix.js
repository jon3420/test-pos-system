#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js
// R54.4／MBV2-HF1-C6.2 登記份數持久化補齊與作廢回復補修 —— 新驗收（同一份腳本先跑未修改 C6.2，再跑修正版與候選版）
//   缺口 A：綁定連續失敗後沒有持久化待辦可補齊
//   缺口 B：定期補齊每次只取前 200 筆，後面的訂單可能永久漏處理
//   缺口 C：作廢已提交、份數回復尚未執行時中斷，失去原履約狀態
// 測試層級標示：[API] 正式路由（node server.js）；[BR] 真實瀏覽器（本腳本未使用）；[DB] 直接讀資料庫檔核對；
//   [FX-DB] 停機後以資料庫 fixture 種入大量資料；[KILL] 真實 SIGKILL（測試替身 preload 在指定停點對伺服器程序送 SIGKILL）；
//   [RS] 一般停機重啟；[FN] 函式級（本腳本未使用）。故障注入只在測試 preload（scripts/lib/c62r-fault.js），正式程式沒有任何觸發端點。
// 分類：N＝本輪修正（未修改基準應以業務斷言失敗）；G＝保留既有行為（基準也應通過）。
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

const ONLY = (process.env.C62R_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const META = {};
const OBS = {}; // 實測紀錄（掃描輪數、順序、停點）寫入結果檔
async function step(name, cls, fn) { META[name] = { cls }; try { await fn(); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }
const ok = (cond, name, cls, detail) => assert(cond, `${name} [${cls}]`, detail);

const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62r');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62r');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const setCtrl = (o) => fs.writeFileSync(CTRL, JSON.stringify(o || {}));
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const P = { a: 801, b: 802, c: 803, d: 804, e: 805, f: 806, g: 807, lp: 808 };
const PRODUCTS = [[801, '測試雞爪', 0, 'available', { quota: 50, price: 100 }], [802, '測試鴨翅', 1, 'available', { quota: 50, price: 80 }],
  [803, '測試豬耳', 2, 'available', { quota: 50, price: 90 }], [804, '測試豆干', 3, 'available', { quota: 50, price: 50 }],
  [805, '測試腱子', 4, 'available', { quota: 50, price: 150 }], [806, '測試滷蛋', 5, 'available', { quota: 50, price: 20 }],
  [807, '測試海帶', 6, 'available', { quota: 50, price: 30 }], [808, '測試付款品', 7, 'available', { quota: 50, price: 60 }]];

let port = 0; let srv = null; let logAll = '';
async function start(extraEnv = {}, noLogin = false) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL,
    PD_SETTLE_SWEEP_LOG: '1', ...extraEnv };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { proc, log: '' };
  proc.stdout.on('data', (d) => { me.log += d; logAll += d; }); proc.stderr.on('data', (d) => { me.log += d; logAll += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null || proc.signalCode) throw new Error('server exited: ' + me.log.slice(-1500)); if (i > 250) throw new Error('start timeout'); await sleep(150); }
  me.base = base;
  me.tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  me.stop = () => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); });
  me.died = () => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(proc.signalCode); proc.once('exit', (c, sg) => res(sg)); });
  srv = me;
  return me;
}
const restart = async (env) => { if (srv) await srv.stop(); await sleep(200); return start(env); };
const q = async (sql, params) => { await sleep(200); const db = await H.openDbFile(dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const reg = async (u, pid, qty) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any' }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
async function order(u, items, pay = 'cash', expectFail = false) {
  await sleep(1100);
  const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay,
    items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u), analytics: { visitor_id: 'v_c62r', session_id: 's_c62r' } });
  if (expectFail) return r;
  if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json.data;
}
const reqOf = async (uuid) => (await q('SELECT * FROM product_demand_requests WHERE request_uuid=?', [uuid]))[0];
const linksOf = (ouuid) => q('SELECT * FROM product_demand_order_links WHERE order_uuid=? ORDER BY product_id', [ouuid]);
const orderRow = async (uuid) => (await q('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
const setStatus = async (uuid, status) => { const o = await orderRow(uuid); return adm('PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status }); };
const lpReq = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp ' + r.text); return (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
const lpConfirm = (a) => fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
const confirmCalls = () => fs.readFileSync(LP_LOG, 'utf8').split('\n').filter((l) => l.includes('/confirm')).length;
const tableExists = async (t) => (await q("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t])).length > 0;
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(500); } };

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 登記份數持久化補齊與作廢回復補修 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　時鐘位移（毫秒）：' + OFF);
  try {
    // 建立資料庫（以受測程式建立結構）與種子
    await start({}, true); await srv.stop();
    { const db = await H.openDbFile(dbf); Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62r','test-secret-c62r')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); H.saveDbFile(db, dbf); db.close(); }
    const FAST = { PD_SETTLE_SWEEP_MS: '1500' }; // 修正版：定期補齊間隔（測試用環境變數；未修改基準忽略此設定）
    await start(FAST);

    // ═════════════ 缺口 A：綁定持久化待辦 ═════════════
    if (want('a')) {
      // A1／A2：交易內與立即補綁都失敗 → 訂單成立、沒有半套扣減；故障解除後由背景處理補齊
      let rA, oA;
      await step('A1', 'G', async () => {
        rA = await reg(U(1), P.a, 5);
        setCtrl({ bind: 'always' });
        oA = await order(U(1), [[P.a, 3]]);
        const o = await orderRow(oA.uuid); const L = await linksOf(oA.uuid); const r = await reqOf(rA.request_uuid);
        ok(o && L.length === 0 && Number(r.settled_qty || 0) === 0, 'A1 [API][DB] 交易內綁定與立即補綁都失敗：訂單照常成立、沒有半套扣減（無關聯、已完成 0）', 'G', JSON.stringify({ links: L.length, s: r.settled_qty }));
      });
      await step('A2', 'N', async () => {
        setCtrl({});
        const got = await until(async () => { const L = await linksOf(oA.uuid); return L.length === 1 && L[0].state === 'settled' ? L : null; }, 45000);
        const r = await reqOf(rA.request_uuid);
        ok(!!got && got[0].request_uuid === rA.request_uuid && Number(got[0].applied_qty) === 3 && Number(r.settled_qty) === 3 && r.status === 'active',
          'A2 [API][DB] 故障解除後，背景定期處理以原訂單與原登記週期補齊：已完成 3、尚待購買 2（不需重啟）', 'N', JSON.stringify({ links: got && got.map((l) => [l.state, l.applied_qty]), s: r.settled_qty }));
      });
      // A3：補齊後重啟兩次 → 只扣一次；購買事件不增加
      await step('A3', 'N', async () => {
        const ev0 = (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','submit_order')", [oA.uuid]))[0].c;
        await restart(FAST); await sleep(3500); await restart(FAST); await sleep(3500);
        const r = await reqOf(rA.request_uuid); const L = await linksOf(oA.uuid);
        const ev1 = (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','submit_order')", [oA.uuid]))[0].c;
        ok(Number(r.settled_qty) === 3 && L.length === 1 && Number(L[0].applied_qty) === 3 && ev0 === ev1 && ev0 === 2,
          'A3 [RS][DB] 補齊後重啟兩次：只扣一次；購買與送單事件不增加', 'N', JSON.stringify({ s: r.settled_qty, ev0, ev1 }));
      });
      // A4：重啟補齊（故障期間成立的訂單，故障解除後以重啟的啟動補齊處理）
      await step('A4', 'N', async () => {
        const r0 = await reg(U(2), P.b, 4);
        setCtrl({ bind: 'always' });
        const o = await order(U(2), [[P.b, 4]]);
        await srv.stop(); setCtrl({});
        await start({}); // 預設間隔（60 秒）：只靠啟動補齊
        const got = await until(async () => { const r = await reqOf(r0.request_uuid); return r.status === 'completed' ? r : null; }, 8000);
        const L = await linksOf(o.uuid);
        ok(!!got && Number(got.settled_qty) === 4 && L.length === 1 && L[0].state === 'settled', 'A4 [RS][DB] 故障期間成立的訂單：重啟後啟動補齊完成扣減（4/4、已完成）', 'N', JSON.stringify({ r: got && [got.status, got.settled_qty], L: L.map((l) => l.state) }));
        await restart(FAST);
      });
      // A5：多商品部分成功 → 其餘商品稍後補齊
      await step('A5', 'N', async () => {
        const rc = await reg(U(3), P.c, 2), rd = await reg(U(3), P.d, 3);
        setCtrl({ bindPids: [P.d] });
        const o = await order(U(3), [[P.c, 2], [P.d, 3]]);
        const L1 = await linksOf(o.uuid); const c1 = await reqOf(rc.request_uuid); const d1 = await reqOf(rd.request_uuid);
        setCtrl({});
        const got = await until(async () => { const r = await reqOf(rd.request_uuid); return Number(r.settled_qty) === 3 ? r : null; }, 45000);
        const L2 = await linksOf(o.uuid); const c2 = await reqOf(rc.request_uuid);
        ok(L1.length === 1 && L1[0].product_id === P.c && Number(c1.settled_qty) === 2 && Number(d1.settled_qty || 0) === 0 && !!got && L2.length === 2 && Number(c2.settled_qty) === 2,
          'A5 [API][DB] 同一訂單多商品：成功的商品立即扣減，失敗的商品保留待辦，故障解除後補齊；已完成的不重複扣', 'N', JSON.stringify({ L1: L1.map((l) => l.product_id), c1: c1.settled_qty, d1: d1.settled_qty, L2: L2.map((l) => [l.product_id, l.applied_qty]) }));
      });
      // A6：原登記取消後重新登記 → 舊待辦只作用於原週期，不扣新週期、不復活舊週期
      await step('A6', 'N', async () => {
        const r1 = await reg(U(4), P.e, 4);
        setCtrl({ bind: 'always' });
        const o = await order(U(4), [[P.e, 2]]);
        const c = await pub('POST', '/api/product-demand/cancel', { member_session: S(U(4)), product_id: P.e });
        const r2 = await reg(U(4), P.e, 5);
        setCtrl({});
        const got = await until(async () => { const L = await linksOf(o.uuid); return L.length ? L : null; }, 45000);
        const a = await reqOf(r1.request_uuid), b = await reqOf(r2.request_uuid);
        ok(c.json && c.json.success && !!got && got[0].request_uuid === r1.request_uuid && Number(got[0].applied_qty) === 0 && a.status === 'cancelled' && Number(b.settled_qty || 0) === 0 && b.status === 'active',
          'A6 [API][DB] 待辦期間登記被取消並重新登記：補齊只綁定原週期（已取消 → 不扣、不復活），新週期 0', 'N', JSON.stringify({ L: got && got.map((l) => [l.request_uuid === r1.request_uuid, l.applied_qty, l.note]), a: a.status, b: [b.status, b.settled_qty] }));
      });
      // A7：原登記過期、重新登記（新週期）→ 舊待辦不扣新週期
      await step('A7', 'N', async () => {
        const r1 = await reg(U(5), P.f, 3);
        setCtrl({ bind: 'always' });
        const o = await order(U(5), [[P.f, 1]]);
        await srv.stop();
        { const db = await H.openDbFile(dbf); db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 minute') WHERE request_uuid=?", [r1.request_uuid]); H.saveDbFile(db, dbf); db.close(); }
        await start(FAST); // 故障仍開啟
        const r2 = await reg(U(5), P.f, 6); // 舊週期轉為過期，建立新週期
        setCtrl({});
        const got = await until(async () => { const L = await linksOf(o.uuid); return L.length ? L : null; }, 45000);
        const a = await reqOf(r1.request_uuid), b = await reqOf(r2.request_uuid);
        ok(!!got && got[0].request_uuid === r1.request_uuid && Number(got[0].applied_qty) === 0 && a.status === 'expired' && Number(b.settled_qty || 0) === 0 && Number(b.cycle_no) === 2,
          'A7 [FX-DB][API] 待辦期間原週期過期並重新登記：補齊只綁定原週期（已過期 → 不扣），新週期不受影響', 'N', JSON.stringify({ L: got && got.map((l) => [l.applied_qty, l.note]), a: a.status, b: [b.cycle_no, b.settled_qty] }));
      });
      // A8：LINE Pay：綁定故障期間付款成功 → 補齊後扣減一次；Confirm 與購買事件不增加
      await step('A8', 'N', async () => {
        const r0 = await reg(U(6), P.lp, 2);
        setCtrl({ bind: 'always' });
        const o = await order(U(6), [[P.lp, 2]], 'linepay');
        const a = await lpReq(o.uuid); const res = await lpConfirm(a);
        const c0 = confirmCalls(); const pur0 = (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name='purchase'", [o.uuid]))[0].c;
        setCtrl({});
        const got = await until(async () => { const r = await reqOf(r0.request_uuid); return Number(r.settled_qty) === 2 ? r : null; }, 45000);
        await restart(FAST); await sleep(3000);
        const r = await reqOf(r0.request_uuid); const pur1 = (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name='purchase'", [o.uuid]))[0].c;
        ok(/linepay=success/.test(res.headers.get('location') || '') && !!got && Number(r.settled_qty) === 2 && confirmCalls() === c0 && pur0 === 1 && pur1 === 1,
          'A8 [API][RS] LINE Pay：綁定故障期間付款成功 → 補齊後依付款狀態扣減一次；不再送 Confirm、不重送購買事件', 'N', JSON.stringify({ s: r.settled_qty, confirms: [c0, confirmCalls()], pur: [pur0, pur1] }));
      });
      // A9：真實 SIGKILL：訂單與待辦已提交、交易後補綁前中斷 → 同一資料庫重啟補齊；再次重啟不變
      await step('A9', 'N', async () => {
        const r0 = await reg(U(7), P.g, 5);
        setCtrl({ bind: 'always', killAt: 'bindLate' });
        const died = srv.died();
        const resp = await order(U(7), [[P.g, 3]], 'cash', true).catch((e) => ({ status: 0, err: String(e) }));
        const sig = await died;
        const o = (await q('SELECT uuid FROM orders WHERE line_user_id=? ORDER BY created_at DESC LIMIT 1', [U(7)]))[0];
        setCtrl({});
        await start({});
        const got = await until(async () => { const r = await reqOf(r0.request_uuid); return Number(r.settled_qty) === 3 ? r : null; }, 8000);
        await restart({}); await sleep(3500);
        const r2 = await reqOf(r0.request_uuid); const L = o ? await linksOf(o.uuid) : [];
        OBS.A9 = { http: resp.status || 0, signal: sig, order_saved: !!o };
        ok(sig === 'SIGKILL' && !!o && !!got && Number(r2.settled_qty) === 3 && L.length === 1 && L[0].request_uuid === r0.request_uuid,
          'A9 [KILL][RS] 訂單與待辦已提交、補綁前 SIGKILL：同一資料庫重啟後補齊原訂單與原週期（3/5）；再次重啟不變', 'N', JSON.stringify({ ...OBS.A9, s: r2.settled_qty, L: L.length }));
      });
      // A10：待辦無法保存 → 訂單交易整筆回滾（不留下沒有恢復依據的成功訂單），沒有對外副作用
      await step('A10', 'N', async () => {
        const r0 = await reg(U(8), P.g, 2);
        const before = { orders: (await q('SELECT COUNT(*) AS c FROM orders'))[0].c, sold: (await q('SELECT line_preorder_sold AS s FROM products WHERE id=?', [P.g]))[0].s,
          ev: (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE event_name='submit_order'"))[0].c };
        setCtrl({ recordFail: true });
        const r = await order(U(8), [[P.g, 2]], 'cash', true);
        setCtrl({});
        const after = { orders: (await q('SELECT COUNT(*) AS c FROM orders'))[0].c, sold: (await q('SELECT line_preorder_sold AS s FROM products WHERE id=?', [P.g]))[0].s,
          ev: (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE event_name='submit_order'"))[0].c };
        const rr = await reqOf(r0.request_uuid);
        ok(r.status >= 500 && !(r.json && r.json.success) && after.orders === before.orders && after.sold === before.sold && after.ev === before.ev && Number(rr.settled_qty || 0) === 0,
          'A10 [API][DB] 待辦無法保存：訂單交易整筆回滾（HTTP ' + r.status + '），訂單數、預購份數、送單事件都不變', 'N', JSON.stringify({ status: r.status, before, after }));
      });
    }

    // ═════════════ 缺口 C：作廢中斷 ═════════════
    if (want('c')) {
      const voidOrder = async (uuid) => { const o = await orderRow(uuid); return adm('POST', `/api/orders/${encodeURIComponent(o.id)}/void`, { reason: '測試作廢' }); };
      const killVoid = async (uuid) => { setCtrl({ killAt: 'order_void' }); const died = srv.died(); const r = await voidOrder(uuid).catch((e) => ({ status: 0, err: String(e) })); const sig = await died; setCtrl({}); return { r, sig }; };
      await step('C1', 'N', async () => {
        const r0 = await reg(U(21), P.a, 5);
        const o = await order(U(21), [[P.a, 3]]);
        const s0 = (await reqOf(r0.request_uuid)).settled_qty;
        const k = await killVoid(o.uuid);
        const or = await orderRow(o.uuid);
        await start({});
        const got = await until(async () => { const L = await linksOf(o.uuid); return L.length && L[0].state !== 'settled' ? L : null; }, 8000);
        const r = await reqOf(r0.request_uuid);
        await restart({}); await sleep(3500);
        const r2 = await reqOf(r0.request_uuid); const L2 = await linksOf(o.uuid);
        OBS.C1 = { signal: k.sig, voided: or.status === 'void', link: got && got[0].state, settled_after: r2.settled_qty };
        ok(Number(s0) === 3 && k.sig === 'SIGKILL' && or.status === 'void' && !!got && got[0].state === 'reverted' && Number(r.settled_qty) === 0 && Number(r2.settled_qty) === 0 && L2[0].state === 'reverted',
          'C1 [KILL][RS] 未履約訂單：作廢交易已提交、回復前 SIGKILL → 重啟後依原關聯回復一次（3 → 0）；再次重啟不變', 'N', JSON.stringify(OBS.C1));
      });
      let oC2, rC2;
      await step('C2', 'G', async () => {
        rC2 = await reg(U(22), P.b, 5);
        oC2 = await order(U(22), [[P.b, 3]]);
        await setStatus(oC2.uuid, 'completed');
        const k = await killVoid(oC2.uuid);
        await start({}); await sleep(3500);
        const L = await linksOf(oC2.uuid); const r = await reqOf(rC2.request_uuid);
        OBS.C2 = { signal: k.sig, link: L[0] && [L[0].state, L[0].note], settled: r.settled_qty };
        ok(k.sig === 'SIGKILL' && L[0].state === 'review' && Number(r.settled_qty) === 3, 'C2 [KILL][RS] 已履約訂單：相同停點中斷 → 重啟後待核對，不自動回復需求（仍 3）', 'G', JSON.stringify(OBS.C2));
      });
      await step('C2-2', 'N', async () => {
        const L = await linksOf(oC2.uuid);
        ok(L[0].note === 'void_after_completed', 'C2-2 [DB] 已履約作廢的待核對原因來自交易中保存的原履約狀態（void_after_completed，而非「原狀態不明」）', 'N', JSON.stringify(L[0] && L[0].note));
      });
      await step('C3', 'N', async () => {
        // 紀錄狀態 orders.status='completed'（POS 意義）但履約流程 order_status 尚未完成：不得誤判為已履約
        const r0 = await reg(U(23), P.c, 4);
        const o = await order(U(23), [[P.c, 2]]);
        await setStatus(o.uuid, 'accepted');
        await srv.stop();
        { const db = await H.openDbFile(dbf); db.run("UPDATE orders SET status='completed' WHERE uuid=?", [o.uuid]); H.saveDbFile(db, dbf); db.close(); }
        await start({});
        const k = await killVoid(o.uuid);
        await start({});
        const got = await until(async () => { const L = await linksOf(o.uuid); return L.length && L[0].state !== 'settled' ? L : null; }, 8000);
        const r = await reqOf(r0.request_uuid);
        ok(k.sig === 'SIGKILL' && !!got && got[0].state === 'reverted' && Number(r.settled_qty) === 0,
          'C3 [FX-DB][KILL] 紀錄狀態為 completed、履約流程為 accepted：以 order_status 判斷未履約 → 重啟後回復（2 → 0）', 'N', JSON.stringify({ sig: k.sig, L: got && got[0].state, s: r.settled_qty }));
      });
      await step('C4', 'G', async () => {
        // 取消後再作廢、重複作廢、重複重啟：只回復一次
        const r0 = await reg(U(24), P.d, 5);
        const o = await order(U(24), [[P.d, 3]]);
        await setStatus(o.uuid, 'cancelled'); await sleep(300);
        const s1 = (await reqOf(r0.request_uuid)).settled_qty;
        const v1 = await voidOrder(o.uuid); const v2 = await voidOrder(o.uuid);
        await restart({}); await sleep(3500); await restart({}); await sleep(3500);
        const r = await reqOf(r0.request_uuid); const L = await linksOf(o.uuid);
        ok(Number(s1) === 0 && v1.json && v1.json.success && !(v2.json && v2.json.success) && Number(r.settled_qty) === 0 && r.status === 'active' && L[0].state === 'reverted',
          'C4 [API][RS] 取消（已回復）後再作廢、重複作廢、重複重啟：登記份數只回復一次，不為負', 'G', JSON.stringify({ s1, v2: v2.status, s: r.settled_qty, L: L[0].state }));
      });
      await step('C5', 'G', async () => {
        // 沒有原狀態證據的歷史作廢資料（作廢與回復都未經新流程）：保守待核對
        const r0 = await reg(U(25), P.e, 5);
        const o = await order(U(25), [[P.e, 2]]);
        await srv.stop();
        { const db = await H.openDbFile(dbf); db.run("UPDATE orders SET status='void', order_status='cancelled' WHERE uuid=?", [o.uuid]); H.saveDbFile(db, dbf); db.close(); }
        await start({}); await sleep(3500);
        const L = await linksOf(o.uuid); const r = await reqOf(r0.request_uuid);
        ok(L[0].state === 'review' && Number(r.settled_qty) === 2, 'C5 [FX-DB][RS] 沒有原狀態證據的歷史作廢：待核對、不猜測、不回復（仍 2）', 'G', JSON.stringify({ L: [L[0].state, L[0].note], s: r.settled_qty }));
      });
    }

    // ═════════════ 缺口 B：掃描公平性 ═════════════
    if (want('b')) {
      // [FX-DB] 停機後種入大量資料：store_001 451 筆、store_002 302 筆 LINE Pay 待付款訂單（各有一筆 reserved 關聯）。
      //   待核對（付款嘗試 review，必須保留訂購中）與逾期（付款請求 2 小時前建立、未送 Confirm，應解除）交錯在不同批次。
      await srv.stop();
      const plan = { store_001: { n: 451, expired: [201, 402, 451], fail: [402] }, store_002: { n: 302, expired: [301, 302], fail: [] } };
      const tag = (s, i) => `c62rb-${s}-${String(i).padStart(4, '0')}`;
      { const db = await H.openDbFile(dbf);
        db.run('BEGIN');
        for (const [sid, p] of Object.entries(plan)) {
          for (let i = 1; i <= p.n; i++) {
            const ou = tag(sid, i); const exp = p.expired.includes(i);
            db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, items, subtotal, total, payment_method, payment_status, source, line_user_id, created_at, updated_at)
                    VALUES (?,?,?,?,'takeout','pending','pending',?,60,60,'linepay','pending','line',?,datetime('now','+8 hours','-3 hours'),datetime('now','+8 hours','-3 hours'))`,
            [ou, ou, 'FX-' + ou, sid, JSON.stringify([{ product_id: P.lp, qty: 1, price: 60 }]), 'Ufx' + i]);
            db.run(`INSERT INTO linepay_payment_attempts (attempt_uuid, store_id, order_uuid, order_number, lp_order_id, transaction_id, amount, status, confirm_calls, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,60,?,?,datetime('now','-2 hours'),datetime('now','-2 hours'))`,
            ['att-' + ou, sid, ou, 'FX-' + ou, 'lp-' + ou, exp ? '' : '1' + String(i).padStart(18, '0'), exp ? 'requested' : 'review', exp ? 0 : 1]);
            db.run(`INSERT INTO product_demand_order_links (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,1,0,'reserved','linepay',datetime('now','-2 hours'),datetime('now','-2 hours'))`, ['lk-' + ou, sid, ou, 'FX-' + ou, P.lp, 'rq-' + ou, 'Ufx' + i]);
          }
        }
        db.run('COMMIT'); H.saveDbFile(db, dbf); db.close(); }
      const expiredUuids = Object.entries(plan).flatMap(([sid, p]) => p.expired.map((i) => tag(sid, i)));
      const reviewCount = async () => (await q("SELECT COUNT(*) AS c FROM product_demand_order_links WHERE order_uuid LIKE 'c62rb-%' AND state='reserved' AND order_uuid IN (SELECT order_uuid FROM linepay_payment_attempts WHERE status='review')"))[0].c;
      const stateOf = async () => { const rows = await q(`SELECT order_uuid, state, note FROM product_demand_order_links WHERE order_uuid IN (${expiredUuids.map(() => '?').join(',')})`, expiredUuids); return Object.fromEntries(rows.map((r) => [r.order_uuid, r.state])); };
      const rounds = [];
      // 每一輪＝一次真實啟動（啟動後約 2.5 秒執行一次補齊）；預設間隔 60 秒，觀察期間只有啟動那一輪
      setCtrl({ syncFailOrders: [tag('store_001', 402)] });
      for (let rd = 1; rd <= 6; rd++) {
        const killThis = rd === 2; // 第 2 輪處理中途真實 SIGKILL（第 50 次同步後）
        if (killThis) setCtrl({ syncFailOrders: [tag('store_001', 402)], killAfterSyncs: 50 });
        await start({});
        if (killThis) { const sig = await Promise.race([srv.died(), sleep(15000).then(() => 'timeout')]); if (sig === 'timeout') await srv.stop(); rounds.push({ round: rd, killed: sig }); setCtrl({ syncFailOrders: [tag('store_001', 402)] }); continue; }
        await sleep(4500);
        const st = await stateOf();
        const logLines = (srv.log.match(/\[demand_settlement\] sweep[^\n]*/g) || []).slice(-1);
        rounds.push({ round: rd, released: Object.entries(st).filter(([, s]) => s === 'released').map(([k]) => k.replace('c62rb-', '')), log: logLines[0] || '' });
        await srv.stop();
      }
      // 故障解除後再一輪：先前單筆故障的訂單也被處理（不因故障永遠卡住或被跳過）
      setCtrl({});
      for (let rd = 7; rd <= 12; rd++) {
        await start({}); await sleep(4500);
        const st = await stateOf();
        rounds.push({ round: rd, released: Object.entries(st).filter(([, s]) => s === 'released').map(([k]) => k.replace('c62rb-', '')), log: ((srv.log.match(/\[demand_settlement\] sweep[^\n]*/g) || []).slice(-1)[0] || '') });
        await srv.stop();
        if (st[tag('store_001', 402)] === 'released') break;
      }
      OBS.B = { plan, rounds };
      const final = await stateOf(); const rv = await reviewCount();
      const firstRound = (k) => { const r = rounds.find((x) => x.released && x.released.includes(k.replace('c62rb-', ''))); return r ? r.round : null; };
      const r201 = firstRound(tag('store_001', 201));
      ok(final[tag('store_001', 201)] === 'released' && r201 != null && r201 <= 3, 'B1 [FX-DB][RS] 前 200 筆待核對必須保留訂購中：第 201 筆逾期訂單在第 ' + r201 + ' 輪解除（不永遠排不到）', 'N', JSON.stringify({ r201 }));
      ok(final[tag('store_001', 451)] === 'released' && final[tag('store_002', 301)] === 'released' && final[tag('store_002', 302)] === 'released',
        'B2 [FX-DB][RS] 超過兩個批次（store_001 451 筆）與另一店別（store_002 302 筆）：後段逾期訂單在可預期輪數內全部解除', 'N', JSON.stringify({ s1_451: firstRound(tag('store_001', 451)), s2_301: firstRound(tag('store_002', 301)), s2_302: firstRound(tag('store_002', 302)) }));
      ok(final[tag('store_001', 402)] === 'released', 'B3 [FX-DB][KILL] 單筆故障不阻擋其他訂單；處理中 SIGKILL 後重啟繼續；故障解除後該筆也完成', 'N', JSON.stringify({ r402: firstRound(tag('store_001', 402)), killed: rounds.filter((r) => r.killed).map((r) => [r.round, r.killed]) }));
      ok(rv === 451 - 3 + 302 - 2, 'B4 [DB] 待核對付款的訂購中份數全部保留（' + rv + ' 筆，未被標成失敗或解除）', 'G', String(rv));
    }

    // ═════════════ 全程檢查 ═════════════
    if (!srv || srv.proc.exitCode != null || srv.proc.signalCode) await start({});
    const N = (await q('SELECT (SELECT COUNT(*) FROM restock_notify_batches) AS b, (SELECT COUNT(*) FROM restock_notify_deliveries) AS d'))[0];
    assert(N.b === 0 && N.d === 0, 'Z1 [DB] 沒有建立任何補貨通知批次或逐筆發送紀錄', JSON.stringify(N));
    assert(mf.real() === 0, 'Z2 真實 LINE 呼叫 0（LINE Pay 由替身處理：' + fs.readFileSync(LP_LOG, 'utf8').split('\n').filter(Boolean).length + ' 次，真實／Sandbox 0）', String(mf.real()));
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log('\nOBS ' + JSON.stringify(OBS));
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  if (process.env.C62R_RESULT) { try { fs.writeFileSync(process.env.C62R_RESULT, JSON.stringify({ meta: META, obs: OBS, results: s.results }, null, 1)); } catch {} }
  process.exit(s.failCount ? 1 : 0);
})();
