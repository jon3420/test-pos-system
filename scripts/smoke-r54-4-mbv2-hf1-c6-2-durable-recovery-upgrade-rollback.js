#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.2 補修：同一資料庫檔 原 C6.2 → 補修版 → 回退原 C6.2 → 再升級補修版（每一步真實停機與啟動）
//   C62R_OLD_ROOT=<未修改 C6.2 程式根目錄>：必填。
//   核對：訂單、登記、已完成／訂購中份數、付款紀錄、通知批次／逐筆紀錄與 retry key 不遺失；升級不回溯建立待辦；
//         回退期間舊版不處理新待辦（如實呈現）；再升級後只恢復有可信原始證據（待辦）的工作。
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

const OLD = process.env.C62R_OLD_ROOT || '';
if (!OLD || !fs.existsSync(path.join(OLD, 'server.js'))) { console.log('需要 C62R_OLD_ROOT（未修改 C6.2 程式根目錄）'); process.exit(2); }
const NEW = H.ROOT;
const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62r-upg');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62r-upg');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const MSPATH = path.join(NEW, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const P = { a: 801, b: 802, c: 803, d: 804, e: 805, f: 806, g: 807 };
const PRODUCTS = [[801, '測試雞爪', 0, 'available', { quota: 50 }], [802, '測試鴨翅', 1, 'available', { quota: 50 }], [803, '測試豬耳', 2, 'available', { quota: 50 }],
  [804, '測試豆干', 3, 'available', { quota: 50 }], [805, '測試通知品', 4, 'available', { quota: 50 }], [806, '測試滷蛋', 5, 'available', { quota: 50 }], [807, '測試海帶', 6, 'available', { quota: 50 }]];
let port = 0;
async function start(root, noLogin) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null) throw new Error('exited: ' + log.slice(-1500)); if (i > 250) throw new Error('start timeout'); await sleep(150); }
  const tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  return { proc, base, tok, log: () => log, stop: () => new Promise((res) => { if (proc.exitCode != null) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}
const q = async (sql, params) => { await sleep(200); const db = await H.openDbFile(dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 補修 升級／回退／再升級 驗收 ══════════');
  console.log('補修版：' + NEW + '\n原 C6.2：' + OLD);
  let srv = null;
  const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
  const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
  const reg = async (u, pid, qty, extra = {}) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
  const order = async (u, items, pay = 'cash') => { await sleep(1100); const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay, items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u) }); if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data; };
  const reqOf = async (uuid) => (await q('SELECT * FROM product_demand_requests WHERE request_uuid=?', [uuid]))[0];
  const lpReq = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp ' + r.text); return (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
  const lpConfirm = (a) => fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
  const voidOrder = async (uuid) => { const o = (await q('SELECT id FROM orders WHERE uuid=?', [uuid]))[0]; return adm('POST', `/api/orders/${encodeURIComponent(o.id)}/void`, { reason: '測試作廢' }); };
  const snap = async () => ({
    orders: (await q('SELECT uuid, payment_status, order_status, status FROM orders ORDER BY uuid')),
    attempts: (await q('SELECT attempt_uuid, status, transaction_id FROM linepay_payment_attempts ORDER BY attempt_uuid')),
    batches: (await q('SELECT batch_uuid, status, message_hash FROM restock_notify_batches ORDER BY batch_uuid')),
    deliveries: (await q('SELECT delivery_uuid, status, retry_key, claim FROM restock_notify_deliveries ORDER BY delivery_uuid')),
  });
  try {
    // ═══ 1. 原 C6.2 ═══
    srv = await start(OLD, true); await srv.stop();
    { const db = await H.openDbFile(dbf); Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62ru','test-secret-c62ru')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); H.saveDbFile(db, dbf); db.close(); }
    srv = await start(OLD);
    const ra = await reg(U(1), P.a, 5); await order(U(1), [[P.a, 2]]);
    const rb = await reg(U(2), P.b, 3); const oLp = await order(U(2), [[P.b, 3]], 'linepay');
    const rd = await reg(U(4), P.d, 4); const oVoid = await order(U(4), [[P.d, 2]]);
    // 通知紀錄（批次、逐筆受理、retry key）
    for (const i of [11, 12]) await reg(U(i), P.e, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P.e, fulfillment_mode: 'takeout', supply_date: today });
    if (pv.json && pv.json.success && pv.json.data.can_send) { await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {}); await sleep(2500); }
    const S0 = await snap();
    const lpLink0 = (await q('SELECT state FROM product_demand_order_links WHERE order_uuid=?', [oLp.uuid]))[0];
    assert(S0.deliveries.length === 2 && S0.batches.length === 1 && lpLink0.state === 'reserved' && Number((await reqOf(ra.request_uuid)).settled_qty) === 2,
      'V0 [RS] 原 C6.2：登記、現金扣減（雞爪 2/5）、LINE Pay 訂購中、通知批次 1 筆與逐筆受理 2 筆', JSON.stringify({ d: S0.deliveries.length, b: S0.batches.length, lp: lpLink0.state }));
    await srv.stop();

    // ═══ 2. 升級為補修版 ═══
    srv = await start(NEW); await sleep(3500);
    const T1 = await q("SELECT COUNT(*) AS c FROM product_demand_settle_tasks");
    const S1 = await snap();
    const hasT = (await q("SELECT name FROM sqlite_master WHERE name IN ('product_demand_settle_tasks','product_demand_sweep_cursors')")).length;
    assert(hasT === 2 && Number(T1[0].c) === 0 && JSON.stringify(S1) === JSON.stringify(S0) && Number((await reqOf(ra.request_uuid)).settled_qty) === 2,
      'V1 [RS][DB] 升級：新增待辦與游標資料表；不為升級前的訂單回溯建立待辦或重新扣減；訂單、付款、通知紀錄與 retry key 完全相同', JSON.stringify({ tasks: T1[0].c }));
    // 補修版：綁定故障期間成立的訂單 → 待辦保存；作廢（未履約）→ 交易內保存原狀態並回復
    fs.writeFileSync(CTRL, JSON.stringify({ bind: 'always' }));
    const rf = await reg(U(6), P.f, 4); const oPend = await order(U(6), [[P.f, 2]]);
    fs.writeFileSync(CTRL, '{}');
    const tp = (await q("SELECT state, request_uuid FROM product_demand_settle_tasks WHERE order_uuid=?", [oPend.uuid]))[0];
    assert(tp && tp.state === 'pending' && tp.request_uuid === rf.request_uuid, 'V2 [API][DB] 補修版：綁定故障期間成立的訂單留有待辦（原登記週期）', JSON.stringify(tp));
    const h1 = await H.openDbFile(dbf).then((db) => { const x = H.sha(JSON.stringify(H.q(db, "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))); db.close(); return x; });
    await srv.stop();

    // ═══ 3. 回退為原 C6.2（待辦處理時間之前就停機：待辦仍為 pending）═══
    srv = await start(OLD); await sleep(3500);
    const pendOld = await reqOf(rf.request_uuid); const tOld = (await q("SELECT state FROM product_demand_settle_tasks WHERE order_uuid=?", [oPend.uuid]))[0];
    const vr = await voidOrder(oVoid.uuid); await sleep(300);
    const dOld = await reqOf(rd.request_uuid);
    await lpConfirm(await lpReq(oLp.uuid)); await sleep(500);
    const bOld = await reqOf(rb.request_uuid);
    const rg = await reg(U(7), P.g, 3); const oOld = await order(U(7), [[P.g, 1]]);
    const gOld = await reqOf(rg.request_uuid);
    assert(Number(pendOld.settled_qty || 0) === 0 && tOld.state === 'pending' && vr.json && vr.json.success && Number(dOld.settled_qty) === 0 && Number(bOld.settled_qty) === 3 && Number(gOld.settled_qty) === 1,
      'V3 [RS] 回退原 C6.2：可運作（作廢回復、LINE Pay 付款扣減、新訂單照 C6.2 連動）；舊版不處理補修版的待辦（滷蛋仍 0、待辦仍 pending）', JSON.stringify({ pend: pendOld.settled_qty, task: tOld.state, d: dOld.settled_qty, b: bOld.settled_qty, g: gOld.settled_qty }));
    const S3 = await snap();
    await srv.stop();

    // ═══ 4. 再升級為補修版 ═══
    srv = await start(NEW); await sleep(3800);
    const fNew = await reqOf(rf.request_uuid); const tNew = (await q("SELECT state FROM product_demand_settle_tasks WHERE order_uuid=?", [oPend.uuid]))[0];
    const tAll = await q("SELECT COUNT(*) AS c FROM product_demand_settle_tasks");
    const S4 = await snap();
    const h2 = await H.openDbFile(dbf).then((db) => { const x = H.sha(JSON.stringify(H.q(db, "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))); db.close(); return x; });
    assert(Number(fNew.settled_qty) === 2 && tNew.state === 'done' && Number(tAll[0].c) === 1 && JSON.stringify(S4) === JSON.stringify(S3) && h1 === h2,
      'V4 [RS] 再升級：只恢復有可信原始證據的工作（滷蛋待辦 → 2/4、完成）；回退期間的訂單與作廢不另建待辦；訂單、付款、通知紀錄不變；結構相同', JSON.stringify({ f: fNew.settled_qty, task: tNew.state, tasks: tAll[0].c, schemaSame: h1 === h2 }));
    await srv.stop(); srv = await start(NEW); await sleep(3500);
    const all = await q('SELECT request_uuid, status, settled_qty FROM product_demand_requests ORDER BY id');
    const S5 = await snap();
    const exp = { [ra.request_uuid]: 2, [rb.request_uuid]: 3, [rd.request_uuid]: 0, [rf.request_uuid]: 2, [rg.request_uuid]: 1 };
    assert(Object.entries(exp).every(([k, v]) => Number((all.find((r) => r.request_uuid === k) || {}).settled_qty) === v) && JSON.stringify(S5) === JSON.stringify(S3) && S5.deliveries.every((d, i) => d.retry_key === S0.deliveries[i].retry_key) && mf.real() === 0,
      'V5 [RS] 再次重啟：各登記已完成份數不重複扣減或回復；通知逐筆紀錄與 retry key 與升級前相同；真實 LINE 0', JSON.stringify({ all: all.map((r) => [r.status, r.settled_qty]), real: mf.real() }));
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  process.exit(s.failCount ? 1 : 0);
})();
