#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.2 歷史待核對紀錄掃描漏標修正：同一資料庫檔
//   STATE_EDGE_FIX → 本輪修正版 → 回退 STATE_EDGE_FIX → 再升級（每一步真實停機與啟動）
//   C62L_OLD_ROOT=<未修改 STATE_EDGE_FIX 程式根目錄>：必填。
//   核對：已完成標記不被回退版本移除、再升級不重複標記；份數、待辦、訂單、付款、通知紀錄與 retry key 保留；沒有結構變更。
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

const OLD = process.env.C62L_OLD_ROOT || '';
if (!OLD || !fs.existsSync(path.join(OLD, 'server.js'))) { console.log('需要 C62L_OLD_ROOT（未修改 STATE_EDGE_FIX 程式根目錄）'); process.exit(2); }
const NEW = H.ROOT;
const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62l-upg');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62l-upg');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const MSPATH = path.join(NEW, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const PRODUCTS = Array.from({ length: 6 }, (_, i) => [801 + i, '測試品' + (801 + i), i, 'available', { quota: 200, price: 60 + i }]);
let port = 0;
async function start(root, noLogin) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL, PD_SETTLE_SWEEP_MS: '1500' };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null) throw new Error('exited: ' + log.slice(-1500)); if (i > 400) throw new Error('start timeout'); await sleep(150); }
  const tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  return { proc, base, tok, stop: () => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000); }) };
}
const q = async (sql, params) => { for (let i = 0; ; i++) { await sleep(100 + i * 250); let db = null; try { db = await H.openDbFile(dbf); return H.q(db, sql, params); } catch (e) { if (i >= 6) throw e; } finally { try { if (db) db.close(); } catch {} } } };
const fx = async (fn) => { const db = await H.openDbFile(dbf); try { fn(db); H.saveDbFile(db, dbf); } finally { db.close(); } };
const schemaHash = async () => { const db = await H.openDbFile(dbf); try { return H.sha(JSON.stringify(H.q(db, "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))); } finally { db.close(); } };
const lastId = (db, t) => { const st = db.prepare(`SELECT MAX(id) AS m FROM ${t}`); st.step(); const v = st.getAsObject().m; st.free(); return Number(v); };
let seq = 0;
function addC(db, prior) {
  seq++; const ou = `fxu-o-${seq}`; const ru = `fxu-r-${seq}`;
  db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total, status, uuid, order_status, payment_status) VALUES (?,?,'store_001','[]','cash',100,100,'void',?,'cancelled','pending')", [`fxu-id-${seq}`, `FXU${seq}`, ou]);
  db.run("INSERT INTO product_demand_requests (request_uuid, store_id, product_id, line_user_id, desired_qty, fulfillment_pref, status, cycle_no, settled_qty, expires_at) VALUES (?,'store_001',801,?,5,'any','active',1,0,datetime('now','+20 days'))", [ru, `Ufxu${seq}`]);
  db.run(`INSERT INTO product_demand_order_links (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, note, reverted_at)
          VALUES (?,'store_001',?,?,801,?,?,2,2,'reverted','cash','order_cancelled',datetime('now'))`, [`fxu-l-${seq}`, ou, `FXU${seq}`, ru, `Ufxu${seq}`]);
  const lid = lastId(db, 'product_demand_order_links');
  db.run("INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, prior_record_status, state, result, done_at) VALUES (?,'store_001',?,'void',0,?,'pending','done','cancel',datetime('now'))", [`fxu-v-${seq}`, ou, prior]);
  return lid;
}

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 歷史待核對掃描漏標修正 升級／回退／再升級 驗收 ══════════');
  console.log('本輪修正版：' + NEW + '\nSTATE_EDGE_FIX：' + OLD);
  let srv = null;
  try {
    srv = await start(OLD, true); await srv.stop();
    await fx((db) => { Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62lu','test-secret-c62lu')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); });
    srv = await start(OLD);
    const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
    const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
    const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const reg = async (u, pid, qty, extra = {}) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
    const order = async (u, items, pay = 'cash') => { await sleep(1100); const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay, items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u) }); if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data; };
    const ra = await reg(U(1), 802, 5); await order(U(1), [[802, 2]]);
    const rb = await reg(U(2), 803, 4); const oLp = await order(U(2), [[803, 3]], 'linepay');
    await pub('POST', '/api/linepay/request', { order_uuid: oLp.uuid });
    const a = (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [oLp.uuid]))[0];
    await fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
    for (const i of [11, 12]) await reg(U(i), 805, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 805, fulfillment_mode: 'takeout', supply_date: today });
    if (pv.json && pv.json.success && pv.json.data.can_send) { await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {}); await sleep(2500); }
    await sleep(1500); await srv.stop();
    // 舊版無法處理的歷史資料：600 筆合法原狀態之後 2 筆原狀態未知
    let t1, t2;
    await fx((db) => { for (let i = 0; i < 600; i++) addC(db, 'accepted'); t1 = addC(db, null); t2 = addC(db, 'oops'); });
    const marks = async () => (await q(`SELECT id, note FROM product_demand_order_links WHERE id IN (${t1},${t2}) ORDER BY id`)).map((r) => r.note);
    const snap = async () => ({
      req: H.sha(JSON.stringify(await q('SELECT request_uuid, status, settled_qty, expires_at, cycle_no FROM product_demand_requests ORDER BY id'))),
      links: H.sha(JSON.stringify(await q('SELECT id, state, applied_qty, order_qty, request_uuid FROM product_demand_order_links ORDER BY id'))),
      tasks: H.sha(JSON.stringify(await q('SELECT id, kind, state, prior_order_status, attempts FROM product_demand_settle_tasks ORDER BY id'))),
      orders: H.sha(JSON.stringify(await q('SELECT * FROM orders ORDER BY id'))),
      attempts: H.sha(JSON.stringify(await q('SELECT * FROM linepay_payment_attempts ORDER BY id'))),
      batches: H.sha(JSON.stringify(await q('SELECT * FROM restock_notify_batches ORDER BY id'))),
      deliveries: JSON.stringify(await q('SELECT delivery_uuid, status, retry_key FROM restock_notify_deliveries ORDER BY delivery_uuid')),
    });
    srv = await start(OLD, true); await sleep(4500); await srv.stop();
    const S0 = await snap(); const M0 = await marks(); const h0 = await schemaHash();
    const nd = JSON.parse(S0.deliveries).length;
    assert(M0.every((n) => n === 'order_cancelled') && nd === 2 && Number((await q('SELECT settled_qty FROM product_demand_requests WHERE request_uuid=?', [rb.request_uuid]))[0].settled_qty) === 3,
      'U0 [API][FX-DB][BOOT] STATE_EDGE_FIX：600 筆合法紀錄之後的 2 筆未知原狀態沒有被標記（重現）；通知批次逐筆 2 筆、LINE Pay 付款扣減 3', JSON.stringify({ M0, nd }));

    srv = await start(NEW, true); await sleep(4500); await srv.stop();
    const S1 = await snap(); const M1 = await marks(); const h1 = await schemaHash();
    assert(M1[0] === 'order_cancelled:legacy_review:void_prior_state_missing' && M1[1] === 'order_cancelled:legacy_review:void_prior_state_invalid'
      && ['req', 'links', 'tasks', 'orders', 'attempts', 'batches', 'deliveries'].every((k) => S1[k] === S0[k]) && h1 === h0,
    'U1 [BOOT][DB] 升級：2 筆依原因標記；份數、關聯 state／applied_qty、待辦（result 以外）、訂單、付款、通知與 retry key 不變；沒有結構變更', JSON.stringify({ M1, same: ['req', 'links', 'tasks', 'orders', 'attempts', 'batches', 'deliveries'].filter((k) => S1[k] !== S0[k]), schema: h1 === h0 }));
    const R1 = await q(`SELECT result FROM product_demand_settle_tasks WHERE order_uuid IN (SELECT order_uuid FROM product_demand_order_links WHERE id IN (${t1},${t2})) ORDER BY id`);

    srv = await start(OLD); await sleep(4500);
    const ra2 = await reg(U(3), 804, 3); await order(U(3), [[804, 1]]); // 回退版本照常運作
    await srv.stop();
    // 既有啟動回填（新訂單 pickup_type）在回退版本先跑一次，之後的比較只反映本輪處理
    srv = await start(OLD, true); await sleep(3500); await srv.stop();
    const S2 = await snap(); const M2 = await marks();
    const R2 = await q(`SELECT result FROM product_demand_settle_tasks WHERE order_uuid IN (SELECT order_uuid FROM product_demand_order_links WHERE id IN (${t1},${t2})) ORDER BY id`);
    assert(JSON.stringify(M2) === JSON.stringify(M1) && JSON.stringify(R2) === JSON.stringify(R1) && Number((await q('SELECT settled_qty FROM product_demand_requests WHERE request_uuid=?', [ra2.request_uuid]))[0].settled_qty) === 1,
      'U2 [BOOT][API][DB] 回退 STATE_EDGE_FIX：已完成標記（關聯 note、待辦 result）不被移除或改寫；回退版本照常下單扣減', JSON.stringify({ M2, R2 }));

    srv = await start(NEW, true); await sleep(4500); await srv.stop();
    srv = await start(NEW, true); await sleep(4000); await srv.stop();
    const S3 = await snap(); const M3 = await marks(); const h3 = await schemaHash();
    const dup = Number((await q("SELECT COUNT(*) AS c FROM product_demand_order_links WHERE note LIKE '%legacy_review%legacy_review%'"))[0].c);
    const keep = ['req', 'links', 'tasks', 'orders', 'attempts', 'batches', 'deliveries'].filter((k) => S3[k] !== S2[k]);
    assert(JSON.stringify(M3) === JSON.stringify(M1) && dup === 0 && keep.length === 0 && h3 === h0 && JSON.parse(S3.deliveries).every((d, i) => d.retry_key === JSON.parse(S0.deliveries)[i].retry_key) && mf.real() === 0,
      'U3 [BOOT][RS][DB] 再升級並重啟：不重複標記；份數、待辦、訂單、付款、通知與 retry key 與回退後相同；結構與最初相同；真實 LINE 0', JSON.stringify({ M3, dup, changed: keep, real: mf.real() }));
    void ra;
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  // 以管線執行時，等結果行寫出後才結束程序（避免 process.exit 截斷輸出）
  process.stdout.write(`\n結果：${s.passCount} 通過、${s.failCount} 失敗\n`, () => process.exit(s.failCount ? 1 : 0));
})();
