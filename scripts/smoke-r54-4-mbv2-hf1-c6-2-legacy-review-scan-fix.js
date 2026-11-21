#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-fix.js
// R54.4／MBV2-HF1-C6.2 歷史待核對紀錄掃描漏標修正 —— 新驗收（同一份腳本、同一組斷言：先跑未修改 STATE_EDGE_FIX，再跑修正版與候選版）
// 問題：repairLegacy() C 型先 LIMIT 500 再分類，合法原狀態被略過時不推進，後段應待核對紀錄永久漏標。
// 測試層級（如實標示）：
//   [FX-DB]  大量歷史資料以 SQLite fixture 建立（停機時寫入資料庫檔；正式流程無法產生舊版錯誤終態與 NULL／不合法原狀態）
//   [BOOT]   正式啟動流程整合：node server.js 啟動後由既有啟動補齊／定期補齊處理（不直接呼叫函式）
//   [API]    範本資料（通知批次、LINE Pay 付款、現金訂單）以正式 HTTP 路由建立，供前後比對
//   [RS]     一般停機重啟；[KILL] 真實 SIGKILL（測試 preload 停點），同一資料庫重啟；[FAULT] 測試 preload 注入單筆保存失敗
//   [DB]     直接讀資料庫檔核對
//   本腳本沒有函式級案例；fixture 不視為正式 API。
// 分類：N＝本輪修正（未修改基準應以「漏標／處理不完」的業務斷言失敗）；G＝保留既有行為。
// 外部呼叫：LINE、LINE Pay 由程序內替身攔截；真實 LINE／LINE Pay／Sandbox 0。
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

const ONLY = (process.env.C62L_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const OBS = {};
const ok = (cond, name, cls, detail) => assert(!!cond, `${name} [${cls}]`, detail);
async function step(name, cls, fn) { try { await fn(); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }

const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62l');
const TEMPLATE = path.join(dir, 'template.db');
let dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62l');
const CTRL = path.join(dir, 'fault.json'); fs.writeFileSync(CTRL, '{}');
const setCtrl = (o) => fs.writeFileSync(CTRL, JSON.stringify(o || {}));
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const SESS = new Map();
const S = (u) => { if (!SESS.has(u)) SESS.set(u, execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString()); return SESS.get(u); };
const PRODUCTS = Array.from({ length: 6 }, (_, i) => [801 + i, '測試品' + (801 + i), i, 'available', { quota: 200, price: 60 + i }]);

let port = 0; let srv = null;
async function start(extraEnv = {}, noLogin = false) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), '-r', path.join(LIB, 'c62r-fault.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62R_CTRL: CTRL,
    PD_SETTLE_SWEEP_MS: '1500', PD_SETTLE_SWEEP_LOG: '1', PD_LEGACY_RETRY_MS: '3000', ...extraEnv };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = { proc, log: '' };
  proc.stdout.on('data', (d) => { me.log += d; }); proc.stderr.on('data', (d) => { me.log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null || proc.signalCode) throw new Error('server exited: ' + me.log.slice(-1500)); if (i > 400) throw new Error('start timeout'); await sleep(150); }
  me.base = base;
  me.tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  me.stop = () => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000); });
  me.died = (ms) => new Promise((res) => { if (proc.exitCode != null || proc.signalCode) return res(proc.signalCode || 'exit'); const t = setTimeout(() => res(null), ms || 20000); proc.once('exit', (c, sg) => { clearTimeout(t); res(sg || 'exit'); }); });
  srv = me; return me;
}
const stop = async () => { if (srv) await srv.stop(); await sleep(300); };
const q = async (sql, params) => { for (let i = 0; ; i++) { await sleep(100 + i * 250); let db = null; try { db = await H.openDbFile(dbf); return H.q(db, sql, params); } catch (e) { if (i >= 6) throw e; } finally { try { if (db) db.close(); } catch {} } } };
const fx = async (fn) => { const db = await H.openDbFile(dbf); try { fn(db); H.saveDbFile(db, dbf); } finally { db.close(); } };
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(700); } };
// 由伺服器日誌取出每輪的歷史處理明細（PD_SETTLE_SWEEP_LOG=1；只有修正版有 cats.legacy）
const legacyRounds = (log) => log.split('\n').filter((l) => l.includes('[demand_settlement] sweep:')).map((l) => {
  const m = l.match(/round=(\d+).*?(\{.*\})\s*$/); let cats = {}; try { cats = m ? JSON.parse(m[2]) : {}; } catch {}
  return { round: m ? Number(m[1]) : null, legacy: cats.legacy || null };
});

// ── 範本：正式 API 建立通知批次（逐筆受理與 retry key）、LINE Pay 已付款訂單、現金訂單 ──
async function buildTemplate() {
  dbf = TEMPLATE;
  await start({}, true); await stop();
  await fx((db) => { Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
    db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62l','test-secret-c62l')");
    db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); });
  await start({});
  const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
  const adm = (m, p, b) => H.api(srv.base, srv.tok, m, p, b);
  const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const reg = async (u, pid, qty, extra = {}) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text); return r.json.data.request; };
  const order = async (u, items, pay = 'cash') => { await sleep(1100); const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay, items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u) }); if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data; };
  await reg(U(1), 802, 5); await order(U(1), [[802, 2]]);
  await reg(U(2), 803, 4); const oLp = await order(U(2), [[803, 3]], 'linepay');
  const lr = await pub('POST', '/api/linepay/request', { order_uuid: oLp.uuid }); if (!lr.json || !lr.json.success) throw new Error('lp ' + lr.text);
  const a = (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [oLp.uuid]))[0];
  await fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
  for (const i of [11, 12]) await reg(U(i), 805, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
  const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 805, fulfillment_mode: 'takeout', supply_date: today });
  if (pv.json && pv.json.success && pv.json.data.can_send) { await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {}); await sleep(2500); }
  await sleep(2000); await stop();
  // 既有啟動回填（例如舊訂單 pickup_type）先在範本上跑完一次，讓之後的前後比對只反映本輪處理
  await start({}, true); await sleep(3500); await stop();
  const t = { d: (await q('SELECT COUNT(*) AS c FROM restock_notify_deliveries'))[0].c, lp_paid: (await q("SELECT COUNT(*) AS c FROM orders WHERE payment_method='linepay' AND payment_status='paid'"))[0].c };
  OBS.template = t;
  return t;
}

// ── fixture 產生器 ──
let seq = 0;
function addOrder(db, { store = 'store_001', uuid, status = 'void', orderStatus = 'cancelled', pay = 'cash', payStatus = 'pending' }) {
  seq++;
  const id = `fx-id-${seq}`; const ou = uuid || `fx-o-${seq}`;
  db.run('INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total, status, uuid, order_status, payment_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, `FX${seq}`, store, '[]', pay, 100, 100, status, ou, orderStatus, payStatus]);
  return ou;
}
function addReq(db, store, settled = 0) {
  seq++; const ru = `fx-r-${seq}`;
  db.run("INSERT INTO product_demand_requests (request_uuid, store_id, product_id, line_user_id, desired_qty, fulfillment_pref, status, cycle_no, settled_qty, expires_at) VALUES (?,?,?,?,5,'any','active',1,?,datetime('now','+20 days'))",
    [ru, store, 801, `Ufx${seq}`, settled]);
  return ru;
}
function lastId(db, table) { const st = db.prepare(`SELECT MAX(id) AS m FROM ${table}`); st.step(); const v = st.getAsObject().m; st.free(); return Number(v); }
// C 型：舊版以作廢回復的關聯（reverted）＋最新作廢待辦保存的原狀態
function addC(db, { store = 'store_001', prior = 'accepted', importSrc = '', orderStatus = 'void', marked = false, uuid = null }) {
  const ou = addOrder(db, { store, uuid, status: orderStatus });
  const ru = addReq(db, store, 0);
  seq++;
  db.run(`INSERT INTO product_demand_order_links (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, note, import_source, reverted_at)
          VALUES (?,?,?,?,801,?,?,2,2,'reverted','cash',?,?,datetime('now'))`,
  [`fx-l-${seq}`, store, ou, `FX${seq}`, ru, `Ufx${seq}`, marked ? 'order_cancelled:legacy_review:void_prior_state_missing' : 'order_cancelled', importSrc]);
  const lid = lastId(db, 'product_demand_order_links');
  db.run(`INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, prior_record_status, state, result, done_at)
          VALUES (?,?,?,'void',0,?,'pending','done',?,datetime('now'))`, [`fx-v-${seq}`, store, ou, prior, marked ? 'legacy_review:void_prior_state_missing' : 'cancel']);
  const vid = lastId(db, 'product_demand_settle_tasks');
  return { lid, vid, ou, ru, store };
}
// A 型：舊版延遲綁定＋已履約作廢留下的 released（evidence 控制證據）
function addA(db, { store = 'store_001', pay = 'cash', payStatus = 'pending', importSrc = '', bindTask = true }) {
  const ou = addOrder(db, { store, pay, payStatus });
  const ru = addReq(db, store, 0);
  seq++;
  db.run(`INSERT INTO product_demand_order_links (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, note, import_source, released_at)
          VALUES (?,?,?,?,801,?,?,3,0,'released',?,'void_after_completed',?,datetime('now'))`, [`fx-l-${seq}`, store, ou, `FX${seq}`, ru, `Ufx${seq}`, pay, importSrc]);
  const lid = lastId(db, 'product_demand_order_links');
  if (bindTask) db.run(`INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, line_user_id, request_uuid, cycle_no, order_qty, payment_method, state, result, done_at)
          VALUES (?,?,?,'bind',801,?,?,1,3,?,'done','linked',datetime('now'))`, [`fx-b-${seq}`, store, ou, `Ufx${seq}`, ru, pay]);
  db.run(`INSERT INTO product_demand_settle_tasks (task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, prior_record_status, state, result, done_at)
          VALUES (?,?,?,'void',0,'completed','pending','done','review_void',datetime('now'))`, [`fx-v-${seq}`, store, ou]);
  return { lid, ou, ru, store };
}

// ── 前後比對 ──
async function snap() {
  const db = await H.openDbFile(dbf);
  try {
    const all = (sql) => H.q(db, sql);
    return {
      req: new Map(all('SELECT request_uuid, store_id, product_id, line_user_id, status, cycle_no, settled_qty, desired_qty, expires_at, completed_at FROM product_demand_requests').map((r) => [r.request_uuid, JSON.stringify(r)])),
      links: new Map(all('SELECT id, link_uuid, store_id, order_uuid, product_id, request_uuid, state, applied_qty, order_qty, import_source, note FROM product_demand_order_links').map((r) => [r.id, r])),
      tasks: new Map(all('SELECT id, task_uuid, store_id, order_uuid, kind, product_id, prior_order_status, state, attempts, result FROM product_demand_settle_tasks').map((r) => [r.id, r])),
      orders: H.sha(JSON.stringify(all('SELECT * FROM orders ORDER BY id'))),
      ordersRows: new Map(all('SELECT * FROM orders').map((r) => [r.id, r])),
      attempts: H.sha(JSON.stringify(all('SELECT * FROM linepay_payment_attempts ORDER BY id'))),
      batches: H.sha(JSON.stringify(all('SELECT * FROM restock_notify_batches ORDER BY id'))),
      deliveries: all('SELECT delivery_uuid, status, retry_key FROM restock_notify_deliveries ORDER BY delivery_uuid'),
    };
  } finally { db.close(); }
}
// expC：Map(lid -> {vid, reason})；expA：Map(lid -> {state, applied, settled, ru})
function compare(b, a, expC, expA = new Map()) {
  const bad = [];
  const expReq = new Map([...expA.values()].map((x) => [x.ru, x.settled]));
  for (const [k, v] of b.req) { const av = a.req.get(k); if (expReq.has(k)) { const o = JSON.parse(av); if (Number(o.settled_qty) !== expReq.get(k)) bad.push('req_settled:' + k); } else if (av !== v) bad.push('req:' + k); }
  const expVid = new Map([...expC.values()].map((x) => [x.vid, x.reason]));
  for (const [id, l] of b.links) {
    const x = a.links.get(id); if (!x) { bad.push('link_missing:' + id); continue; }
    const fixed = ['link_uuid', 'store_id', 'order_uuid', 'product_id', 'request_uuid', 'order_qty', 'import_source'];
    for (const f of fixed) if (String(x[f]) !== String(l[f])) bad.push(`link_${f}:${id}`);
    if (expA.has(id)) { const e = expA.get(id); if (x.state !== e.state || Number(x.applied_qty) !== e.applied) bad.push('linkA:' + id); continue; }
    if (x.state !== l.state || Number(x.applied_qty) !== Number(l.applied_qty)) bad.push('link_state:' + id);
    if (expC.has(id)) { if (x.note !== `${l.note}:legacy_review:${expC.get(id).reason}`) bad.push('link_note:' + id + '=' + x.note); }
    else if (x.note !== l.note) bad.push('link_note_changed:' + id);
  }
  for (const [id, t] of b.tasks) {
    const x = a.tasks.get(id); if (!x) { bad.push('task_missing:' + id); continue; }
    for (const f of ['task_uuid', 'store_id', 'order_uuid', 'kind', 'product_id', 'prior_order_status', 'state', 'attempts']) if (String(x[f]) !== String(t[f])) bad.push(`task_${f}:${id}`);
    if (expVid.has(id)) { if (x.result !== `legacy_review:${expVid.get(id)}`) bad.push('task_result:' + id + '=' + x.result); }
    else if (x.result !== t.result) bad.push('task_result_changed:' + id);
  }
  for (const f of ['orders', 'attempts', 'batches']) if (a[f] !== b[f]) {
    if (f === 'orders') { for (const [id, r] of b.ordersRows) { const x = a.ordersRows.get(id); const cols = Object.keys(r).filter((c) => !x || String(x[c]) !== String(r[c])); if (cols.length) { bad.push(`orders:${id}:${cols.join('|')}:${cols.map((c) => r[c] + '>' + (x && x[c])).join('|')}`); break; } } }
    else bad.push(f);
  }
  if (JSON.stringify(a.deliveries) !== JSON.stringify(b.deliveries)) bad.push('deliveries');
  return bad;
}
const markedCount = async (ids) => { if (!ids.length) return 0; const r = await q(`SELECT COUNT(*) AS c FROM product_demand_order_links WHERE id IN (${ids.join(',')}) AND note LIKE '%legacy_review%'`); return Number(r[0].c); };
const dupMarks = async () => Number((await q("SELECT COUNT(*) AS c FROM product_demand_order_links WHERE note LIKE '%legacy_review%legacy_review%'"))[0].c);
async function freshScenario(name, build) {
  dbf = path.join(dir, `${name}.db`);
  fs.copyFileSync(TEMPLATE, dbf);
  let out; await fx((db) => { out = build(db); });
  return out;
}

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 歷史待核對紀錄掃描漏標修正 驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  try {
    const T = await buildTemplate();
    ok(T.d === 2 && T.lp_paid === 1, 'T0 [API] 範本：通知批次逐筆受理 2 筆（含 retry key）、LINE Pay 已付款訂單 1 筆，供前後比對', 'G', JSON.stringify(T));

    // ═══ 1：500 筆正常＋第 501 筆應待核對；重複執行與重啟（案例 1、6；正式啟動流程）═══
    if (want('s1')) {
      const fxd = await freshScenario('s1', (db) => {
        const normal = []; for (let i = 0; i < 500; i++) normal.push(addC(db, { prior: 'accepted' }));
        const t = addC(db, { prior: null });
        return { normal, t };
      });
      const B = await snap();
      const res = [];
      for (let k = 1; k <= 3; k++) {
        await start({}, true);
        await until(async () => (await markedCount([fxd.t.lid])) === 1, 12000);
        await sleep(4500); // 確保每次啟動的啟動補齊（2.5 秒）與至少一輪定期補齊都已執行
        res.push({ boot: k, marked: await markedCount([fxd.t.lid]), rounds: legacyRounds(srv.log).filter((r) => r.legacy).map((r) => [r.round, r.legacy.batches, r.legacy.c, r.legacy.skipped, r.legacy.done]), sweep_rounds: legacyRounds(srv.log).length });
        await stop();
      }
      OBS.s1 = res;
      const A = await snap();
      const bad = compare(B, A, new Map([[fxd.t.lid, { vid: fxd.t.vid, reason: 'void_prior_state_missing' }]]));
      await step('L1', 'N', async () => ok(res[0].marked === 1, 'L1 [FX-DB][BOOT] 前 500 筆為合法未履約作廢（accepted）、第 501 筆原狀態 NULL → 第一次正式啟動即標記 legacy_review:void_prior_state_missing', 'N', JSON.stringify(res[0])));
      await step('L1-2', 'N', async () => ok(res.every((r) => r.marked === 1 && r.sweep_rounds >= 2) && bad.length === 0 && (await dupMarks()) === 0,
        'L1-2 [FX-DB][BOOT][RS][DB] 連續三次啟動：只標記一次、不重複追加；500 筆正常紀錄、份數、關聯 state／applied_qty、登記週期、訂單、付款、通知與 retry key 皆不變', 'N',
        JSON.stringify({ boots: res.map((r) => r.marked), bad: bad.slice(0, 8), badN: bad.length })));
    }

    // ═══ 2：超過兩批正常資料後段混入 NULL／空字串／空白／不合法；正規化一致（案例 2）═══
    if (want('s2')) {
      const fxd = await freshScenario('s2', (db) => {
        const priors = ['accepted', 'pending', 'preparing', 'ready', 'delivering', 'cancelled', ' accepted ', '\taccepted\n', '　accepted', 'completed '];
        const normal = []; for (let i = 0; i < 1100; i++) normal.push(addC(db, { prior: priors[i % priors.length] }));
        const tgt = [
          { ...addC(db, { prior: null }), reason: 'void_prior_state_missing' },
          { ...addC(db, { prior: '' }), reason: 'void_prior_state_missing' },
          { ...addC(db, { prior: '   ' }), reason: 'void_prior_state_missing' },
          { ...addC(db, { prior: '　' }), reason: 'void_prior_state_missing' },
          { ...addC(db, { prior: 'Completed' }), reason: 'void_prior_state_invalid' },
          { ...addC(db, { prior: 'shipped_x' }), reason: 'void_prior_state_invalid' },
        ];
        for (let i = 0; i < 50; i++) normal.push(addC(db, { prior: 'ready' }));
        return { normal, tgt };
      });
      const B = await snap();
      await start({}, true);
      await until(async () => (await markedCount(fxd.tgt.map((t) => t.lid))) === fxd.tgt.length, 15000); await sleep(2000);
      const n = await markedCount(fxd.tgt.map((t) => t.lid)); const rounds = legacyRounds(srv.log).filter((r) => r.legacy).map((r) => [r.round, r.legacy.batches, r.legacy.c, r.legacy.skipped, r.legacy.done]);
      await stop();
      const A = await snap();
      const bad = compare(B, A, new Map(fxd.tgt.map((t) => [t.lid, { vid: t.vid, reason: t.reason }])));
      OBS.s2 = { n, rounds };
      await step('L2', 'N', async () => ok(n === 6 && bad.length === 0,
        'L2 [FX-DB][BOOT][DB] 1,100 筆正常（含前後空白、Tab、全形空白等正規化後合法值）之後混入 NULL、空字串、空白、全形空白、大小寫不符、不合法值 → 6 筆依 classifyVoidPrior 原因正確標記；1,150 筆正常紀錄不變', 'N',
        JSON.stringify({ n, rounds, bad: bad.slice(0, 8), badN: bad.length })));
    }

    // ═══ 3：應標記者本身超過一批（2,300 筆、兩店交錯）：同一次執行內分輪自動續行到完成；完成後不再掃描（案例 3、7）═══
    if (want('s3')) {
      const fxd = await freshScenario('s3', (db) => {
        const tgt = []; const pri = [null, '', 'bogus'];
        for (let i = 0; i < 2300; i++) tgt.push({ ...addC(db, { store: i % 3 === 0 ? 'store_002' : 'store_001', prior: pri[i % 3] }), reason: i % 3 === 2 ? 'void_prior_state_invalid' : 'void_prior_state_missing' });
        return { tgt };
      });
      const B = await snap();
      const t0 = Date.now();
      await start({}, true);
      const done = await until(async () => (await markedCount(fxd.tgt.map((t) => t.lid))) === 2300, 60000);
      const sec = Math.round((Date.now() - t0) / 1000);
      await sleep(6000); // 再觀察數輪：完成後不再出現歷史處理
      const rounds = legacyRounds(srv.log);
      const lr = rounds.filter((r) => r.legacy).map((r) => [r.round, r.legacy.batches, r.legacy.c, r.legacy.done]);
      const after = rounds.filter((r) => !r.legacy && r.round > Math.max(0, ...rounds.filter((x) => x.legacy).map((x) => x.round))).length;
      const n = await markedCount(fxd.tgt.map((t) => t.lid));
      await stop();
      const A = await snap();
      const bad = compare(B, A, new Map(fxd.tgt.map((t) => [t.lid, { vid: t.vid, reason: t.reason }])));
      OBS.s3 = { n, sec, legacy_rounds: lr, rounds_after_done_without_scan: after };
      await step('L3', 'N', async () => ok(done && n === 2300 && bad.length === 0 && (await dupMarks()) === 0,
        'L3 [FX-DB][BOOT][DB] 應標記者 2,300 筆（超過 4 批）、store_001／store_002 交錯：同一次啟動中依批次上限分輪自動續行到全部完成；每筆只更新其店別、訂單、關聯與作廢待辦', 'N',
        JSON.stringify({ n, sec, lr, bad: bad.slice(0, 6), badN: bad.length })));
      await step('L3-2', 'N', async () => ok(lr.length >= 2 && lr.every((x) => x[1] <= 4) && lr[lr.length - 1][3] === true && after >= 2,
        'L3-2 [BOOT] 有界工作量：每輪最多 4 批 × 500 筆；最後一輪標示完成，之後的補齊輪次不再執行歷史掃描', 'N', JSON.stringify({ lr, after })));
    }

    // ═══ 3b：處理途中真實 SIGKILL（第 2 批交易提交前），同一資料庫重啟續行 ═══
    if (want('s3k')) {
      const fxd = await freshScenario('s3k', (db) => {
        const tgt = []; for (let i = 0; i < 1500; i++) tgt.push({ ...addC(db, { prior: i % 2 ? '' : null }), reason: 'void_prior_state_missing' });
        return { tgt };
      });
      const B = await snap();
      setCtrl({ killAfterLegacyMarks: 700 });
      await start({}, true);
      const sig = await srv.died(40000);
      if (!sig) await stop();
      const mid = await markedCount(fxd.tgt.map((t) => t.lid));
      setCtrl({});
      await start({}, true);
      await until(async () => (await markedCount(fxd.tgt.map((t) => t.lid))) === 1500, 40000); await sleep(1500);
      const n = await markedCount(fxd.tgt.map((t) => t.lid));
      await stop();
      const A = await snap();
      const bad = compare(B, A, new Map(fxd.tgt.map((t) => [t.lid, { vid: t.vid, reason: t.reason }])));
      OBS.s3k = { sig, mid, n };
      await step('L3K', 'N', async () => ok(sig === 'SIGKILL' && mid === 500 && n === 1500 && bad.length === 0 && (await dupMarks()) === 0,
        'L3K [FX-DB][KILL][BOOT] 第 2 批處理到第 700 筆時 SIGKILL：磁碟上只有已提交的第 1 批 500 筆（沒有半批）；同一資料庫重啟後續行至 1,500 筆、不重複標記', 'N',
        JSON.stringify({ sig, mid, n, badN: bad.length })));
    }

    // ═══ 4：混合穿插（正常、已標記、匯入、未作廢訂單、跨店同 UUID、應標記）＋ A 型歷史修復回歸（案例 4、7、8）═══
    if (want('s4')) {
      const fxd = await freshScenario('s4', (db) => {
        const exp = []; const expA = [];
        for (let i = 0; i < 600; i++) {
          if (i % 40 === 10) addC(db, { prior: null, marked: true });                 // 已標記
          if (i % 40 === 20) addC(db, { prior: '', importSrc: 'mbv2:fx' });          // 匯入資料
          if (i % 40 === 30) addC(db, { prior: null, orderStatus: 'completed' });    // 訂單未作廢
          addC(db, { prior: i % 2 ? 'accepted' : 'cancelled' });                     // 正常
        }
        exp.push({ ...addC(db, { prior: null }), reason: 'void_prior_state_missing' });
        const same = addC(db, { store: 'store_001', prior: 'accepted' });             // 跨店同訂單 UUID：store_001 正常
        exp.push({ ...addC(db, { store: 'store_002', prior: 'weird', uuid: same.ou }), reason: 'void_prior_state_invalid' }); // store_002 應標記
        for (let i = 0; i < 30; i++) addC(db, { prior: 'ready' });
        exp.push({ ...addC(db, { store: 'store_002', prior: '' }), reason: 'void_prior_state_missing' });
        expA.push({ ...addA(db, { pay: 'cash' }), state: 'review', applied: 3, settled: 3 });                       // 可信購買證據 → 補記一次
        expA.push({ ...addA(db, { pay: 'linepay', payStatus: 'pending' }), state: 'review', applied: 0, settled: 0 }); // 證據不足 → 待核對不扣
        const aImp = addA(db, { pay: 'cash', importSrc: 'mbv2:fx' });                // 匯入 → 不處理
        const aNoBind = addA(db, { pay: 'cash', bindTask: false });                  // 缺綁定待辦證據 → 不處理
        return { exp, expA, aImp, aNoBind, same };
      });
      const B = await snap();
      const res = [];
      for (let k = 1; k <= 2; k++) {
        await start({}, true);
        await until(async () => (await markedCount(fxd.exp.map((t) => t.lid))) === fxd.exp.length, 12000); await sleep(4500);
        res.push(await markedCount(fxd.exp.map((t) => t.lid)));
        await stop();
      }
      const A = await snap();
      const bad = compare(B, A, new Map(fxd.exp.map((t) => [t.lid, { vid: t.vid, reason: t.reason }])), new Map(fxd.expA.map((x) => [x.lid, x])));
      const aRows = await q(`SELECT id, state, applied_qty, note FROM product_demand_order_links WHERE id IN (${fxd.expA.map((x) => x.lid).concat([fxd.aImp.lid, fxd.aNoBind.lid]).join(',')}) ORDER BY id`);
      const aReq = await q(`SELECT request_uuid, settled_qty FROM product_demand_requests WHERE request_uuid IN ('${[...fxd.expA.map((x) => x.ru), fxd.aImp.ru, fxd.aNoBind.ru].join("','")}')`);
      OBS.s4 = { res, aRows, aReq };
      await step('L4', 'N', async () => ok(res[0] === 3 && res[1] === 3 && bad.filter((b) => !b.startsWith('linkA') && !b.startsWith('req_settled')).length === 0 && (await dupMarks()) === 0,
        'L4 [FX-DB][BOOT][RS][DB] 正常、已標記、匯入、未作廢訂單與應標記紀錄穿插：只有 3 筆應標記者變動（含跨店同訂單 UUID 只更新 store_002 的關聯與待辦）；重啟不重複', 'N',
        JSON.stringify({ res, bad: bad.slice(0, 8), badN: bad.length })));
      await step('L4-A', 'G', async () => {
        const byId = new Map(aRows.map((r) => [r.id, r])); const rq = new Map(aReq.map((r) => [r.request_uuid, Number(r.settled_qty || 0)]));
        const okA = fxd.expA.every((x) => byId.get(x.lid).state === x.state && Number(byId.get(x.lid).applied_qty) === x.applied && rq.get(x.ru) === x.settled)
          && byId.get(fxd.aImp.lid).state === 'released' && rq.get(fxd.aImp.ru) === 0 && byId.get(fxd.aNoBind.lid).state === 'released' && rq.get(fxd.aNoBind.ru) === 0;
        ok(okA && bad.filter((b) => b.startsWith('linkA') || b.startsWith('req_settled')).length === 0,
          'L4-A [FX-DB][BOOT][RS] A 型歷史修復：可信購買證據（現金）只補記一次 3；LINE Pay 未付款只轉待核對不扣；匯入資料與缺綁定待辦證據者不處理；兩次啟動不重複', 'G', JSON.stringify({ aRows, aReq }));
      });
    }

    // ═══ 5：單筆保存失敗不阻擋其他紀錄；故障解除後（不重啟）由重試補齊（案例 5）═══
    if (want('s5')) {
      const fxd = await freshScenario('s5', (db) => {
        const normal = []; for (let i = 0; i < 600; i++) normal.push(addC(db, { prior: 'accepted' }));
        const tgt = [0, 1, 2].map((i) => ({ ...addC(db, { prior: i === 1 ? 'zzz' : null }), reason: i === 1 ? 'void_prior_state_invalid' : 'void_prior_state_missing' }));
        return { tgt };
      });
      const B = await snap();
      setCtrl({ legacyFailLinkIds: [fxd.tgt[1].lid] });
      await start({}, true);
      await until(async () => (await markedCount([fxd.tgt[0].lid, fxd.tgt[2].lid])) === 2, 12000); await sleep(1500);
      const mid = { others: await markedCount([fxd.tgt[0].lid, fxd.tgt[2].lid]), failed: await markedCount([fxd.tgt[1].lid]) };
      setCtrl({});
      const rec = await until(async () => (await markedCount([fxd.tgt[1].lid])) === 1, 15000);
      const fin = await markedCount(fxd.tgt.map((t) => t.lid));
      const lr = legacyRounds(srv.log).filter((r) => r.legacy).map((r) => [r.round, r.legacy.c, r.legacy.failed, r.legacy.done]);
      await stop();
      const A = await snap();
      const bad = compare(B, A, new Map(fxd.tgt.map((t) => [t.lid, { vid: t.vid, reason: t.reason }])));
      OBS.s5 = { mid, fin, lr };
      await step('L5', 'N', async () => ok(mid.others === 2 && mid.failed === 0 && rec && fin === 3 && bad.length === 0,
        'L5 [FX-DB][FAULT][BOOT] 600 筆正常之後 3 筆應標記、其中 1 筆標記失敗：其餘 2 筆照常標記；故障解除後不需重啟，由重試補齊第 3 筆', 'N', JSON.stringify({ mid, fin, lr, badN: bad.length })));
    }

    await step('Z1', 'G', async () => ok(mf.real() === 0, 'Z1 全程：真實 LINE 0（LINE Pay 由程序內替身處理）', 'G', JSON.stringify({ real: mf.real() })));
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log('OBS ' + JSON.stringify(OBS));
  if (process.env.C62L_RESULT) { try { fs.writeFileSync(process.env.C62L_RESULT, JSON.stringify({ root: H.ROOT, pass: s.passCount, fail: s.failCount, obs: OBS }, null, 1)); } catch {} }
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  process.exit(s.failCount ? 1 : 0);
})();
