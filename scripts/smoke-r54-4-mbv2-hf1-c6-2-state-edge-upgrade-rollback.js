#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-state-edge-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.2 登記份數狀態邊界修正：同一資料庫檔
//   DURABLE_RECOVERY_FIX → 本輪修正版 → 回退 DURABLE_RECOVERY_FIX → 再升級（每一步真實停機與啟動）
//   C62S_OLD_ROOT=<未修改 DURABLE_RECOVERY_FIX 程式根目錄>：必填。
//   核對：份數、待辦、游標、訂單、付款、通知批次／逐筆紀錄與 retry key；升級只依可信證據處理基準已產生的錯誤終態；
//         回退期間舊版的缺口會再出現（如實呈現），再升級後依證據補處理。
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

const OLD = process.env.C62S_OLD_ROOT || '';
if (!OLD || !fs.existsSync(path.join(OLD, 'server.js'))) { console.log('需要 C62S_OLD_ROOT（未修改 DURABLE_RECOVERY_FIX 程式根目錄）'); process.exit(2); }
const NEW = H.ROOT;
const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62s-upg');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62s-upg');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const setCtrl = (o) => fs.writeFileSync(CTRL, JSON.stringify(o || {}));
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const MSPATH = path.join(NEW, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const PRODUCTS = Array.from({ length: 10 }, (_, i) => [801 + i, '測試品' + (801 + i), i, 'available', { quota: 200, price: 60 + i }]);
let port = 0;
// 兩版都需要的測試 preload：c62r-fault.js 取自補修版樹（舊版樹沒有本輪新增的停點時不受影響）
async function start(root, noLogin) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL, PD_SETTLE_SWEEP_MS: '1500' };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null) throw new Error('exited: ' + log.slice(-1500)); if (i > 250) throw new Error('start timeout'); await sleep(150); }
  const tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  return { proc, base, tok, log: () => log, stop: () => new Promise((res) => { if (proc.exitCode != null) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}
const q = async (sql, params) => { for (let i = 0; ; i++) { await sleep(150 + i * 250); let db = null; try { db = await H.openDbFile(dbf); return H.q(db, sql, params); } catch (e) { if (i >= 6) throw e; } finally { try { if (db) db.close(); } catch {} } } };
const fx = async (fn) => { const db = await H.openDbFile(dbf); try { fn(db); H.saveDbFile(db, dbf); } finally { db.close(); } };
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const schemaHash = async () => { const db = await H.openDbFile(dbf); try { return H.sha(JSON.stringify(H.q(db, "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))); } finally { db.close(); } };

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 狀態邊界修正 升級／回退／再升級 驗收 ══════════');
  console.log('本輪修正版：' + NEW + '\nDURABLE_RECOVERY_FIX：' + OLD);
  let srv = null;
  const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
  const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
  const reg = async (u, pid, qty, extra = {}) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
  const order = async (u, items, pay = 'cash') => { await sleep(1100); const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay, items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u) }); if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data; };
  const reqOf = async (uuid) => (await q('SELECT * FROM product_demand_requests WHERE request_uuid=?', [uuid]))[0];
  const linkOf = async (ouuid) => (await q('SELECT * FROM product_demand_order_links WHERE order_uuid=?', [ouuid]))[0];
  const orderRow = async (uuid) => (await q('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
  const setStatus = async (uuid, status) => { const o = await orderRow(uuid); return adm('PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status }); };
  const voidO = async (uuid) => { const o = await orderRow(uuid); return adm('POST', `/api/orders/${encodeURIComponent(o.id)}/void`, { reason: '測試作廢' }); };
  const lpReq = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp ' + r.text); return (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
  const lpConfirm = (a) => fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
  const pendingAll = async () => (await q("SELECT COUNT(*) AS c FROM product_demand_settle_tasks WHERE state='pending'"))[0].c;
  // 延遲綁定 → 履約 → 作廢 → 故障解除（舊版會留下 A 型錯誤終態）
  const lateBoundVoid = async (u, pid) => {
    const r = await reg(u, pid, 5); setCtrl({ bind: 'always' }); const o = await order(u, [[pid, 3]]);
    await setStatus(o.uuid, 'completed'); await voidO(o.uuid); setCtrl({});
    return { r, o };
  };
  const snap = async () => ({
    orders: await q('SELECT uuid, payment_status, order_status, status FROM orders ORDER BY uuid'),
    attempts: await q('SELECT attempt_uuid, status, transaction_id FROM linepay_payment_attempts ORDER BY attempt_uuid'),
    batches: await q('SELECT batch_uuid, status, message_hash FROM restock_notify_batches ORDER BY batch_uuid'),
    deliveries: await q('SELECT delivery_uuid, status, retry_key, claim FROM restock_notify_deliveries ORDER BY delivery_uuid'),
  });
  try {
    // ═══ 1. DURABLE_RECOVERY_FIX ═══
    srv = await start(OLD, true); await srv.stop();
    await fx((db) => { Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62su','test-secret-c62su')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); });
    srv = await start(OLD);
    const ra = await reg(U(1), 801, 5); await order(U(1), [[801, 2]]);                                   // 正常現金扣減 2/5
    const rb = await reg(U(2), 802, 4); const oLp = await order(U(2), [[802, 3]], 'linepay');
    await lpConfirm(await lpReq(oLp.uuid)); await sleep(800);                                            // LINE Pay 付款扣減 3/4
    for (const i of [11, 12]) await reg(U(i), 805, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 805, fulfillment_mode: 'takeout', supply_date: today });
    if (pv.json && pv.json.success && pv.json.data.can_send) { await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {}); await sleep(2500); }
    const legA = await lateBoundVoid(U(3), 803);                                                         // A 型錯誤終態
    const rc = await reg(U(4), 804, 5); const oC = await order(U(4), [[804, 3]]);                        // C 型：NULL 原狀態被回復
    await srv.stop(); await fx((db) => db.run('UPDATE orders SET order_status=NULL WHERE uuid=?', [oC.uuid])); srv = await start(OLD);
    await voidO(oC.uuid);
    await sleep(3000);
    if (await pendingAll()) { await srv.stop(); srv = await start(OLD); await sleep(4000); }
    const A0 = { s: Number((await reqOf(legA.r.request_uuid)).settled_qty || 0), L: await linkOf(legA.o.uuid) };
    const C0 = { s: Number((await reqOf(rc.request_uuid)).settled_qty || 0), L: await linkOf(oC.uuid) };
    const S0 = await snap();
    const cur0 = await q('SELECT name, last_id FROM product_demand_sweep_cursors ORDER BY name');
    assert(A0.s === 0 && A0.L && A0.L.state === 'released' && A0.L.note === 'void_after_completed' && C0.s === 0 && C0.L.state === 'reverted' && S0.deliveries.length === 2 && Number((await reqOf(rb.request_uuid)).settled_qty) === 3,
      'V0 [API][DB] DURABLE_RECOVERY_FIX 產生的基準狀態：A 型（延遲綁定＋已履約作廢 → released、已完成 0）、C 型（原狀態 NULL → 回復）；正常扣減、LINE Pay 付款、通知批次與逐筆紀錄',
      JSON.stringify({ A0: [A0.s, A0.L && A0.L.state, A0.L && A0.L.note], C0: [C0.s, C0.L.state], d: S0.deliveries.length }));
    await srv.stop();
    const h0 = await schemaHash();

    // ═══ 2. 升級為本輪修正版 ═══
    srv = await start(NEW); await sleep(4500);
    const A1 = { s: Number((await reqOf(legA.r.request_uuid)).settled_qty), L: await linkOf(legA.o.uuid) };
    const C1 = { s: Number((await reqOf(rc.request_uuid)).settled_qty || 0), L: await linkOf(oC.uuid) };
    const S1 = await snap();
    const cur1 = await q('SELECT name, last_id FROM product_demand_sweep_cursors ORDER BY name');
    assert(A1.s === 3 && A1.L.state === 'review' && Number(A1.L.applied_qty) === 3 && /legacy_repaired/.test(A1.L.note)
      && C1.s === 0 && C1.L.state === 'reverted' && /legacy_review/.test(C1.L.note)
      && JSON.stringify(S1) === JSON.stringify(S0) && h0 === (await schemaHash()) && Number((await reqOf(ra.request_uuid)).settled_qty) === 2 && Number((await reqOf(rb.request_uuid)).settled_qty) === 3,
    'V1 [RS][DB] 升級：A 型依可信證據補記已完成 3 並待核對；C 型標記待核對、不改份數；其他份數、訂單、付款、通知紀錄與 retry key 完全相同；不新增結構',
    JSON.stringify({ A1: [A1.s, A1.L.state, A1.L.note], C1: [C1.s, C1.L.state, C1.L.note], cur0: cur0.length, cur1: cur1.length }));
    const h1 = await schemaHash();
    // 補修版：同樣的交錯直接得到正確結果
    const nA = await lateBoundVoid(U(5), 806);
    await sleep(3000); if (await pendingAll()) { await srv.stop(); srv = await start(NEW); await sleep(4000); }
    const nL = await linkOf(nA.o.uuid);
    assert(Number((await reqOf(nA.r.request_uuid)).settled_qty) === 3 && nL.state === 'review', 'V2 [API][DB] 修正版：延遲綁定＋已履約作廢直接得到已完成 3、待核對', JSON.stringify({ L: [nL.state, nL.applied_qty, nL.note] }));
    await srv.stop();

    // ═══ 3. 回退為 DURABLE_RECOVERY_FIX ═══
    srv = await start(OLD); await sleep(4000);
    const keepA = Number((await reqOf(legA.r.request_uuid)).settled_qty); const keepN = Number((await reqOf(nA.r.request_uuid)).settled_qty);
    const rbA = await lateBoundVoid(U(6), 807);                                                          // 回退期間：缺口 A 重新出現
    const re = await reg(U(7), 808, 5); setCtrl({ bind: 'always' }); const oE = await order(U(7), [[808, 3]]); // 回退期間：自然到期缺口重新出現
    await srv.stop(); await fx((db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-60 seconds') WHERE request_uuid=?", [re.request_uuid]));
    setCtrl({}); srv = await start(OLD); await sleep(4000);
    if (await pendingAll()) { await srv.stop(); srv = await start(OLD); await sleep(4000); }
    const rbL = await linkOf(rbA.o.uuid); const eS = Number((await reqOf(re.request_uuid)).settled_qty || 0);
    assert(keepA === 3 && keepN === 3 && Number((await reqOf(rbA.r.request_uuid)).settled_qty || 0) === 0 && rbL && rbL.state === 'released' && eS === 3,
      'V3 [RS][API][DB] 回退 DURABLE_RECOVERY_FIX：已修正的份數保留（3、3）；回退期間缺口重新出現（如實呈現）：延遲綁定＋已履約作廢 → 0、自然到期仍扣 3',
      JSON.stringify({ keepA, keepN, rb: [rbL && rbL.state, rbL && rbL.note], eS }));
    const S3 = await snap();
    await srv.stop();

    // ═══ 4. 再升級 ═══
    srv = await start(NEW); await sleep(4500);
    const rbL2 = await linkOf(rbA.o.uuid); const eS2 = Number((await reqOf(re.request_uuid)).settled_qty);
    const S4 = await snap(); const h2 = await schemaHash();
    assert(Number((await reqOf(rbA.r.request_uuid)).settled_qty) === 3 && rbL2.state === 'review' && /legacy_repaired/.test(rbL2.note) && eS2 === 3 && JSON.stringify(S4) === JSON.stringify(S3) && h1 === h2,
      'V4 [RS][DB] 再升級：回退期間的 A 型依證據補記 3；回退期間已扣減的到期份數保留（不清除、不回復）；訂單、付款、通知紀錄不變；結構相同',
      JSON.stringify({ rb: [rbL2.state, rbL2.note], eS2, same: JSON.stringify(S4) === JSON.stringify(S3), schema: h1 === h2 }));
    await srv.stop(); srv = await start(NEW); await sleep(4000);
    const all = await q('SELECT request_uuid, settled_qty FROM product_demand_requests ORDER BY id');
    const exp = { [ra.request_uuid]: 2, [rb.request_uuid]: 3, [legA.r.request_uuid]: 3, [rc.request_uuid]: 0, [nA.r.request_uuid]: 3, [rbA.r.request_uuid]: 3, [re.request_uuid]: 3 };
    const S5 = await snap();
    const pend = await q("SELECT COUNT(*) AS c FROM product_demand_settle_tasks WHERE state='pending'");
    assert(Object.entries(exp).every(([k, v]) => Number((all.find((r) => r.request_uuid === k) || {}).settled_qty || 0) === v) && JSON.stringify(S5) === JSON.stringify(S3)
      && S5.deliveries.every((d, i) => d.retry_key === S0.deliveries[i].retry_key) && Number(pend[0].c) === 0 && mf.real() === 0,
    'V5 [RS][DB] 再次重啟：各登記份數不重複扣減或回復；無待處理待辦；retry key 與最初相同；真實 LINE 0',
    JSON.stringify({ all: all.map((r) => r.settled_qty), pending: pend[0].c, real: mf.real() }));
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  process.exit(s.failCount ? 1 : 0);
})();
