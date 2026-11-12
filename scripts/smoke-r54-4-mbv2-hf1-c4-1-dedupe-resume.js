#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js
// R54.4／MBV2-HF1-C4.1 —— 補貨通知防重送、匯入續送與資格驗證：真實 server.js＋暫存 SQLite＋實際背景 worker＋正式 API 路由。
//   D：匯入已受理紀錄後不得再發送（pending／held／retry_wait／unknown、匯入列本來就 claim=NULL、worker 執行途中匯入、
//      重複匯入、跨批次、手動續送、重啟、預覽匯入不改資料、顧客與後台通知狀態）
//   X：跨店匯入／同店 LIFF 或商品識別改變的舊批次不得以舊連結續送；從未嘗試者作廢後重新預覽指向目前店別；
//      已嘗試／結果不明者不能藉重新預覽繞過；設定相符時沿用原 retry key 與原訊息；商品直達不改顧客資料
//   C：商品關閉收集登記後，預覽、確認、續送、每筆送出前都擋下；本人仍可管理；重新開啟不自行發送
//   A：max_attempts 為自動重試＋手動續送的總上限（上限 1、4、多次續送、並行、重啟、超過時間窗、無忙迴圈、他人照常）
//   T：顧客畫面不宣稱「已收到」；結果不明不顯示為已受理
//   K：舊 C4 程式產生的資料（C4_BASELINE_ROOT）由本版程式接手後仍受保護
//   R：回退相容：C4 程式直接使用 C4.1 用過的資料庫（保留資料庫回退）
//   Z：真實 LINE 呼叫 0
// 所有 api.line.me 請求在測試程序內攔截並模擬（scripts/lib/c4-line-mock.js），不發送任何真實訊息。
'use strict';
const path = require('path');
const fs = require('fs');
(() => {
  if (process.env.C4_CLOCK_OFFSET_MS !== undefined) return;
  const tp = new Date(Date.now() + 8 * 3600e3);
  const mins = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  process.env.C4_CLOCK_OFFSET_MS = String(mins < 8 * 60 || mins >= 20 * 60 ? (10 * 60 + 30 - mins) * 60e3 : 0);
})();
require('./lib/c4-test-clock');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const ONLY = process.env.C41_ONLY || '';
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const CLOCK_OFF = Number(process.env.C4_CLOCK_OFFSET_MS || 0);
const NET_MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const LINE_MOCK = path.join(__dirname, 'lib', 'c4-line-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const MOCKDIR = H.tmpDir('c41-linemock');
const PUSH_FILE = path.join(MOCKDIR, 'real-line-attempts.txt');
const MOCK_CTRL = path.join(MOCKDIR, 'ctrl.json');
const MOCK_STATE = path.join(MOCKDIR, 'state.json');
const MOCK_LOG = path.join(MOCKDIR, 'calls.jsonl');
fs.writeFileSync(PUSH_FILE, ''); fs.writeFileSync(MOCK_CTRL, '{}'); fs.writeFileSync(MOCK_STATE, JSON.stringify({ accepted: {}, used: {} })); fs.writeFileSync(MOCK_LOG, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twDate = (d = 0) => new Date(Date.now() + 8 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
const TOKEN = 'test-only-channel-token-not-real-c41';
const LIFF_A = '2000000001-StoreA';
const LIFF_B = '2000000002-StoreB';
const PN = 706, P7 = 707;
let uidSeq = 0x1000;
const nextUid = () => 'U' + (uidSeq++).toString(16).padStart(32, '0');
const MS = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js'));
const session = (store, u) => MS.createMemberSession({ store_id: store, line_user_id: u });

function setCtrl(c) { fs.writeFileSync(MOCK_CTRL, JSON.stringify(c || {})); }
function mockCalls() { return fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
const callsTo = (u) => mockCalls().filter((c) => c.uid === u);
function realLineAttempts() { return fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length; }

function seedStore(db, store, opts = {}) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [store, k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1'); set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0'); set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654'); set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout'); set('shop_name', opts.shopName || '脆豬腰' + store);
  set('line_channel_token', TOKEN); set('line_member_liff_id', opts.liff || LIFF_A);
  set('restock_notify_enabled', '1'); // 測試暫存庫中開啟；交付預設仍為關閉
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const ins = (id, name, barcode) => runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
      line_quota_enabled,line_quota_daily,line_quota_sold,line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_takeout_enabled,line_delivery_enabled,product_barcode)
      VALUES (?,?,?,?,?,?,1,1,'available',0, 1,50,0, 1,50,0, 1,1,?)`, [id, store, name, '飯類', 101, 120, barcode]);
  ins(PN, '測試補貨麵', 'BC-706');
  ins(P7, '測試隔離粥', 'BC-707');
  if (store !== 'store_001') {
    runSql(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) SELECT ?, store_name, plan, active, features FROM licenses WHERE store_id='store_001'`, [store]);
  }
}
async function boot(tag, opts = {}) {
  const dir = H.tmpDir('c41-' + tag);
  const dbf = path.join(dir, 'pos.db');
  const s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db);
  for (const st of opts.stores || ['store_001']) seedStore(db, st, (opts.storeOpts || {})[st] || {});
  H.saveDbFile(db, dbf); db.close();
  const ctx = { dir, dbf, opts, store: (opts.stores || ['store_001'])[0], root: opts.root || H.ROOT };
  await start(ctx);
  return ctx;
}
function serverEnv(ctx) {
  return {
    __nodeArgs: ['-r', CLOCK, '-r', NET_MOCK, '-r', LINE_MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: PUSH_FILE, C4_LINE_MOCK_CTRL: MOCK_CTRL, C4_LINE_MOCK_STATE: MOCK_STATE, C4_LINE_MOCK_LOG: MOCK_LOG,
    RESTOCK_NOTIFY_BACKOFF_MS: '1200,1200,1200', // 時間欄位以秒為單位保存，退避需 ≥1 秒才有意義 RESTOCK_NOTIFY_SEND_INTERVAL_MS: '0', RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '700',
    ...((ctx.opts && ctx.opts.env) || {}),
  };
}
async function start(ctx) {
  if (ctx.root !== H.ROOT) {
    // 舊版程式（K 段）：以相同參數在另一個程式根目錄啟動
    const { spawn } = require('child_process');
    const port = await new Promise((r) => { const sv = require('net').createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => r(p)); }); });
    const env = { ...process.env, ...serverEnv(ctx), PORT: String(port), POS_DB_PATH: ctx.dbf, MIGRATION_TMP_DIR: path.join(ctx.dir, 'up-' + port) };
    const nodeArgs = env.__nodeArgs; delete env.__nodeArgs;
    const proc = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: ctx.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await sleep(100); }
    ctx.s = { base, proc, getLog: () => log, stop: async () => { proc.kill('SIGTERM'); await new Promise((r) => { if (proc.exitCode != null) r(); else proc.on('exit', r); }); } };
  } else {
    ctx.s = await H.startServer(ctx.dbf, serverEnv(ctx));
  }
  ctx.tok = await H.login(ctx.s.base, ctx.store, ctx.store === 'store_001' ? 'pw001' : 'pw002');
}
async function safeStop(srv) { const p = srv && srv.proc; if (p && p.exitCode == null && p.signalCode == null) await srv.stop(); }
async function restart(ctx, mutate) {
  await safeStop(ctx.s);
  if (mutate) { const db = await H.openDbFile(ctx.dbf); mutate(db); H.saveDbFile(db, ctx.dbf); db.close(); }
  await start(ctx);
}
async function rows(ctx, sql, params) { const db = await H.openDbFile(ctx.dbf); const r = H.q(db, sql, params); db.close(); return r; }
async function pub(ctx, method, p, body) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${ctx.s.base}${p}${sep}store_id=${ctx.store}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const adm = (ctx, method, p, body) => H.api(ctx.s.base, ctx.tok, method, p, body);
const reg = (ctx, u, pid, extra = {}) => pub(ctx, 'POST', '/api/product-demand/register', { member_session: session(ctx.store, u), product_id: pid, desired_qty: 1, notify_consent: true, ...extra });
const mine = async (ctx, u) => (await pub(ctx, 'POST', '/api/product-demand/mine', { member_session: session(ctx.store, u) })).json.data;
const preview = (ctx, pid, date) => adm(ctx, 'POST', '/api/product-demand-admin/restock/preview', { product_id: pid, fulfillment_mode: 'takeout', supply_date: date || twDate(1) });
const confirm = (ctx, uuid) => adm(ctx, 'POST', `/api/product-demand-admin/restock/batches/${uuid}/confirm`, {});
const resume = (ctx, uuid) => adm(ctx, 'POST', `/api/product-demand-admin/restock/batches/${uuid}/resume`, {});
const detail = async (ctx, uuid) => (await adm(ctx, 'GET', `/api/product-demand-admin/restock/batches/${uuid}`)).json.data;
async function setCollect(ctx, pid, on) { const r = await adm(ctx, 'PATCH', `/api/product-demand-admin/products/${pid}/collect`, { enabled: !!on }); if (!r.json || !r.json.success) throw new Error('collect ' + r.text); }
async function friends(ctx, uids) {
  await restart(ctx, (db) => { for (const u of uids) { db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', [ctx.store, u]); db.run('INSERT INTO line_members (store_id, line_user_id, display_name, is_friend) VALUES (?,?,?,1)', [ctx.store, u, 'm' + u.slice(-4)]); } });
}
async function waitBatch(ctx, uuid, ms = 20000) {
  const end = Date.now() + ms; let d;
  while (Date.now() < end) { d = await detail(ctx, uuid); if (d && d.status !== 'sending' && !d.running) return d; await sleep(80); }
  return d;
}
async function delRow(ctx, batch, u) { return (await rows(ctx, 'SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [batch, u]))[0]; }
// 建立一個批次：members 依序登記（決定送出順序），behaviors 決定各人模擬回應；回傳批次 uuid
async function makeBatch(ctx, pid, members, behaviors) {
  for (const u of members) { const r = await reg(ctx, u, pid); if (!r.json || !r.json.success) throw new Error('reg failed ' + r.text); }
  await friends(ctx, members);
  setCtrl({ default: '200', byUser: behaviors || {} });
  const pv = (await preview(ctx, pid)).json;
  if (!pv || !pv.data || !pv.data.batch_uuid) throw new Error('preview failed ' + JSON.stringify(pv));
  await confirm(ctx, pv.data.batch_uuid);
  await waitBatch(ctx, pv.data.batch_uuid);
  setCtrl({ default: '200' });
  return pv.data.batch_uuid;
}
// 「另一份備份」：以本店正式匯出檔為底，加入同一登記週期、不同 retry key 的已受理紀錄 A（可指定 claim）
async function backupWithAccepted(ctx, list) {
  const exp = await H.download(ctx.s.base, ctx.tok, '/api/migration/v2/export?categories=restock_notify');
  const j = JSON.parse(exp.buf.toString('utf8'));
  for (const it of list) {
    const req = (await rows(ctx, 'SELECT * FROM product_demand_requests WHERE store_id=? AND line_user_id=? AND status=? ORDER BY id DESC LIMIT 1', [ctx.store, it.uid, 'active']))[0];
    const bu = require('crypto').randomUUID();
    j.data.restock_notify_batches.push({ id: 900000 + j.data.restock_notify_batches.length, batch_uuid: bu, store_id: ctx.store, product_id: req.product_id, product_uuid: '', product_name_snapshot: req.product_name_snapshot,
      fulfillment_mode: 'takeout', supply_date: twDate(1), notice_kind: 'preorder', message_text: 'A', link_url: 'https://liff.line.me/x', message_hash: 'x', status: 'completed', preview_json: '{}', candidate_count: 1,
      created_by: 'other-env', confirmed_by: 'other-env', pause_reason: '', created_at: '2026-11-10 01:00:00', updated_at: '2026-11-10 01:00:00', confirmed_at: '2026-11-10 01:00:00', completed_at: '2026-11-10 01:00:05', import_source: '' });
    j.data.restock_notify_deliveries.push({ id: 900000 + j.data.restock_notify_deliveries.length, delivery_uuid: require('crypto').randomUUID(), batch_uuid: bu, store_id: ctx.store, product_id: req.product_id,
      request_uuid: req.request_uuid, cycle_no: req.cycle_no, consent_uuid: '', line_user_id: it.uid, retry_key: require('crypto').randomUUID(), claim: it.claim === null ? null : 1, status: 'accepted',
      exclusion_reason: '', attempt_count: 1, max_attempts: 4, first_attempt_at: '2026-11-10 01:00:01', last_attempt_at: '2026-11-10 01:00:01', next_attempt_at: null, accepted_at: '2026-11-10 01:00:02',
      last_http_status: 200, error_code: '', line_request_id: 'req-A', accepted_request_id: 'req-A', created_at: '2026-11-10 01:00:00', updated_at: '2026-11-10 01:00:02', import_source: '' });
  }
  if (j.table_counts) { j.table_counts.restock_notify_batches = j.data.restock_notify_batches.length; j.table_counts.restock_notify_deliveries = j.data.restock_notify_deliveries.length; }
  return Buffer.from(JSON.stringify(j));
}
async function importBuf(ctx, buf, opts = {}) {
  const up = await H.uploadRaw(ctx.s.base, ctx.tok, buf, { name: 'other.json' });
  if (!up.json || !up.json.upload_id) return { error: up.text };
  return H.previewAndImport(ctx.s.base, ctx.tok, up.json.upload_id, { mode: 'merge', categories: opts.categories || ['restock_notify'], ...(opts.extra || {}) });
}
async function invariants(ctx) {
  const o = await rows(ctx, 'SELECT id, status, total, payment_status FROM orders ORDER BY id');
  const p = await rows(ctx, 'SELECT id, line_quota_sold, line_preorder_sold FROM products ORDER BY id');
  return JSON.stringify({ o, p });
}

(async () => {
  const ctxs = [];
  console.log(`clock offset: ${CLOCK_OFF} ms；程式根目錄：${H.ROOT}`);
  try {
    // ═════════════════ D：匯入已受理紀錄後不得再發送 ═════════════════
    if (run('d')) {
      const M = await boot('dedupe'); ctxs.push(M);
      const inv0 = await invariants(M);
      // D1 本地 pending（前一位 401 使批次暫停）
      const b1 = nextUid(), u1 = nextUid();
      const B1 = await makeBatch(M, PN, [b1, u1], { [b1]: ['401'] });
      const s1 = await delRow(M, B1, u1);
      // D2 本地 held（本人 401）
      const u2 = nextUid();
      const B2 = await makeBatch(M, P7, [u2], { [u2]: ['401'] });
      const s2 = await delRow(M, B2, u2);
      // D3 本地 retry_wait（本人逾時，下一位 401 使批次暫停）
      const u3 = nextUid(), b3 = nextUid();
      const B3 = await makeBatch(M, PN, [u3, b3], { [u3]: ['timeout'], [b3]: ['401'] });
      const s3 = await delRow(M, B3, u3);
      // D4 本地 unknown（非語意 409）
      const u4 = nextUid();
      const B4 = await makeBatch(M, P7, [u4], { [u4]: ['409_other'] });
      const s4 = await delRow(M, B4, u4);
      // D5 本地 pending；匯入的 accepted 本來就是 claim=NULL
      const b5 = nextUid(), u5 = nextUid();
      const B5 = await makeBatch(M, PN, [b5, u5], { [b5]: ['401'] });
      assert(s1.status === 'pending' && Number(s1.claim) === 1 && s2.status === 'held' && s3.status === 'retry_wait' && s4.status === 'unknown' && (await delRow(M, B5, u5)).status === 'pending',
        'D0 前置：本地 pending／held／retry_wait／unknown 各一筆，皆持有 claim=1 與自己的 retry key', JSON.stringify([s1.status, s2.status, s3.status, s4.status, s3.attempt_count, s3.error_code, callsTo(b3).length, callsTo(u3).map((c) => c.behavior)]));
      const before = await rows(M, 'SELECT * FROM restock_notify_deliveries ORDER BY id');
      const buf = await backupWithAccepted(M, [{ uid: u1 }, { uid: u2 }, { uid: u3 }, { uid: u4 }, { uid: u5, claim: null }]);
      // D6 預覽匯入不改資料、不發送
      const callsP = mockCalls().length;
      const pvOnly = await importBuf(M, buf, { extra: { previewOnly: true } });
      const afterPv = await rows(M, 'SELECT * FROM restock_notify_deliveries ORDER BY id');
      assert(pvOnly.preview && pvOnly.preview.status === 'done' && JSON.stringify(before) === JSON.stringify(afterPv) && mockCalls().length === callsP, 'D1 預覽匯入：資料完全未變、不發送', JSON.stringify({ st: pvOnly.preview && pvOnly.preview.status }));
      const im = await importBuf(M, buf);
      const imported = await rows(M, "SELECT line_user_id, claim, status, retry_key FROM restock_notify_deliveries WHERE accepted_request_id='req-A'");
      const localKeep = await rows(M, 'SELECT retry_key FROM restock_notify_deliveries WHERE batch_uuid IN (?,?,?,?,?) ORDER BY id', [B1, B2, B3, B4, B5]);
      assert(im.import && im.import.status === 'done' && imported.length === 5 && imported.every((r) => r.status === 'accepted'),
        'D2 正式匯入：5 筆已受理證據保留（目標已有名額者 claim=NULL，但狀態仍為已受理）', JSON.stringify(imported.map((r) => [r.status, r.claim])));
      // 匯入後、續送前：顧客與後台就應辨識 claim=NULL 的已受理歷史（不能顯示為處理中或未通知）
      const preStates = [];
      for (const u of [u1, u2, u3, u4, u5]) { const m = (await mine(M, u)) || []; preStates.push((m[0] || {}).restock_notify); }
      const preAdmin = (await adm(M, 'GET', `/api/product-demand-admin/products/${PN}`)).json.data.rows.find((r) => r.status === 'active' && String(r.member || '').endsWith(u1.slice(-4)));
      assert(preStates.every((x) => x === 'accepted') && preAdmin && preAdmin.restock_notify === 'accepted', 'D2a 匯入後（續送前）顧客與後台通知狀態即辨識 claim=NULL 的已受理歷史', JSON.stringify({ preStates, admin: preAdmin && preAdmin.restock_notify }));
      const callsBefore = mockCalls().length;
      const r1 = await resume(M, B1); const r2 = await resume(M, B2); const r3 = await resume(M, B3); const r4 = await resume(M, B4); const r5 = await resume(M, B5);
      for (const b of [B1, B2, B3, B4, B5]) await waitBatch(M, b);
      const newCalls = (u) => mockCalls().slice(callsBefore).filter((c) => c.uid === u).length;
      const affected = [u1, u2, u3, u4, u5];
      const extra = affected.map(newCalls);
      assert(extra.every((n) => n === 0), 'D3 匯入已受理後手動續送：pending／held／retry_wait／unknown／匯入列本來 claim=NULL，受影響會員新增的模擬 LINE 呼叫皆為 0', JSON.stringify(extra));
      const rowsAfter = await Promise.all([[B1, u1], [B2, u2], [B3, u3], [B4, u4], [B5, u5]].map(([b, u]) => delRow(M, b, u)));
      assert(rowsAfter.every((r) => r.exclusion_reason === 'already_notified' && ['blocked'].includes(r.status) || (r.status === 'unknown' && r.exclusion_reason === 'already_notified')),
        'D4 本地衝突項目停止並標示「本週期已通知」（already_notified）', JSON.stringify(rowsAfter.map((r) => [r.status, r.exclusion_reason, r.attempt_count])));
      const keepKeys = await rows(M, 'SELECT retry_key FROM restock_notify_deliveries WHERE batch_uuid IN (?,?,?,?,?) ORDER BY id', [B1, B2, B3, B4, B5]);
      const idx = await rows(M, "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_rnd_cycle_claim','idx_rnd_retry_key','idx_rnd_uuid','idx_rnd_batch_request')");
      assert(JSON.stringify(localKeep) === JSON.stringify(keepKeys) && idx.length === 4 && (await rows(M, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries'))[0].c === before.length + 5,
        'D5 不覆寫歷史 retry key、不刪除歷史列、唯一索引保留', JSON.stringify({ idx: idx.length }));
      const myStates = [];
      for (const u of affected) { const m = (await mine(M, u)) || []; myStates.push((m[0] || {}).restock_notify); }
      const adminRows = (await adm(M, 'GET', `/api/product-demand-admin/products/${PN}`)).json;
      const adminU5 = adminRows && adminRows.data && adminRows.data.rows.find((r) => r.status === 'active' && String(r.member || '').endsWith(u5.slice(-4)));
      assert(myStates.every((s) => s === 'accepted'), 'D6 顧客「我的想買登記」辨識 claim=NULL 的已受理歷史', JSON.stringify(myStates));
      assert(!!adminU5 && adminU5.restock_notify === 'accepted', 'D7 後台登記明細辨識 claim=NULL 的已受理歷史', JSON.stringify(adminU5 && adminU5.restock_notify));
      // 跨批次：重新預覽 → 這些會員都排除為本週期已通知
      const pvx = (await preview(M, PN)).json.data;
      assert(pvx.stats.eligible_count === 0 && pvx.stats.exclusions.already_notified >= 3, 'D8 跨批次：重新預覽排除為本週期已通知，無法建立新發送', JSON.stringify(pvx.stats.exclusions));
      // 重複匯入、重啟後再續送
      const im2 = await importBuf(M, buf);
      await restart(M);
      for (const b of [B1, B2, B3, B4, B5]) { await resume(M, b); await waitBatch(M, b); }
      const extra2 = affected.map(newCalls);
      assert(im2.import && im2.import.status === 'done' && im2.import.result.stats.restock_notify_deliveries.added === 0 && extra2.every((n) => n === 0),
        'D9 重複匯入不新增、服務重啟後再續送：受影響會員仍 0 次新呼叫', JSON.stringify(extra2));
      // D10 worker 執行途中匯入（雙收件人）
      const W = await boot('dedupe-live', { env: { RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '2500' } }); ctxs.push(W);
      const w1 = nextUid(), w2 = nextUid();
      for (const u of [w1, w2]) await reg(W, u, PN);
      await friends(W, [w1, w2]);
      setCtrl({ default: '200', byUser: { [w1]: ['hang', '200'] } });
      const pvW = (await preview(W, PN)).json.data;
      await confirm(W, pvW.batch_uuid);
      for (let i = 0; i < 60 && !callsTo(w1).length; i++) await sleep(50);
      const bufW = await backupWithAccepted(W, [{ uid: w2 }]);
      const imW = await importBuf(W, bufW);
      const dW = await waitBatch(W, pvW.batch_uuid, 20000);
      const w2row = await delRow(W, pvW.batch_uuid, w2);
      assert(imW.import && imW.import.status === 'done' && callsTo(w2).length === 0 && w2row.status === 'blocked' && w2row.exclusion_reason === 'already_notified' && (await delRow(W, pvW.batch_uuid, w1)).status === 'accepted',
        'D10 雙收件人 worker 執行途中匯入第二位的已受理紀錄：第一位結束後，第二位不再被發送', JSON.stringify({ w2calls: callsTo(w2).length, w2: [w2row.status, w2row.exclusion_reason], counts: dW && dW.counts }));
      // D11 在途請求期間出現已受理證據：記錄回應但不再重試
      const v1 = nextUid();
      await reg(W, v1, P7); await friends(W, [v1]);
      setCtrl({ default: '200', byUser: { [v1]: ['hang', '200'] } });
      const pvV = (await preview(W, P7)).json.data;
      await confirm(W, pvV.batch_uuid);
      for (let i = 0; i < 60 && !callsTo(v1).length; i++) await sleep(50);
      await importBuf(W, await backupWithAccepted(W, [{ uid: v1 }]));
      await waitBatch(W, pvV.batch_uuid, 20000);
      const v1row = await delRow(W, pvV.batch_uuid, v1);
      assert(callsTo(v1).length === 1 && v1row.attempt_count === 1 && v1row.exclusion_reason === 'already_notified' && v1row.claim === 1,
        'D11 已在網路上的請求：照實記錄（逾時），但因已有受理證據不再啟動下一次重試；保留名額', JSON.stringify({ calls: callsTo(v1).length, row: [v1row.status, v1row.exclusion_reason, v1row.attempt_count, v1row.claim] }));
      const inv1 = await invariants(M);
      assert(inv0 === inv1, 'D12 登記、預覽、匯入、續送前後：訂單、付款、今日／預購已售份數不變', 'checked');
    }

    // ═════════════════ X：跨店／連結設定改變 ═════════════════
    if (run('x')) {
      const S = await boot('src', { storeOpts: { store_001: { liff: LIFF_A } } }); ctxs.push(S);
      const xa = nextUid(), xb = nextUid(), xc = nextUid(); // xa 409_other（已嘗試、結果不明）→ xb 401（暫停）→ xc 從未嘗試
      const BX = await makeBatch(S, PN, [xa, xb, xc], { [xa]: ['409_other'], [xb]: ['401'] });
      const pre = await Promise.all([xa, xb, xc].map((u) => delRow(S, BX, u)));
      assert(pre[0].status === 'unknown' && pre[1].status === 'held' && pre[2].status === 'pending' && Number(pre[2].attempt_count) === 0, 'X0 前置：來源店批次（結果不明／已嘗試暫停／從未嘗試）', JSON.stringify(pre.map((r) => r.status)));
      const exp = await H.download(S.s.base, S.tok, '/api/migration/v2/export?categories=product_demand,restock_notify');
      const T = await boot('dst', { stores: ['store_002'], storeOpts: { store_002: { liff: LIFF_B, shopName: '目標店' } } }); ctxs.push(T);
      const srcUuid = (await rows(S, 'SELECT product_uuid FROM products WHERE id=?', [PN]))[0].product_uuid;
      const dstUuid = (await rows(T, 'SELECT product_uuid FROM products WHERE id=?', [PN]))[0].product_uuid;
      const up = await H.uploadRaw(T.s.base, T.tok, exp.buf, { name: 'src.json' });
      const imT = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: ['product_demand', 'restock_notify'], allow_cross_store: true });
      assert(imT.import && imT.import.status === 'done' && srcUuid !== dstUuid, 'X1 跨店匯入完成；兩店商品數字 ID 相同（706）但穩定識別不同', JSON.stringify({ st: imT.import && imT.import.status, err: imT.import && imT.import.error || imT.previewResp && imT.previewResp.text }));
      await friends(T, [xa, xb, xc]);
      for (const u of [xa, xb, xc]) await reg(T, u, PN); // 顧客在目標店重新明確同意
      const callsX = mockCalls().length;
      const rT = await resume(T, BX);
      await waitBatch(T, BX);
      const sentX = mockCalls().slice(callsX);
      assert(sentX.length === 0 && !sentX.some((c) => c.text.includes(LIFF_A) || c.text.includes('store_001')),
        'X2 目標店續送舊批次：顧客已重新同意，仍不得發出來源店連結（0 次呼叫）', JSON.stringify({ resume: rT.json, sent: sentX.map((c) => c.text.split('\n')[4]) }));
      const post = await Promise.all([xa, xb, xc].map((u) => delRow(T, BX, u)));
      const bT = await detail(T, BX);
      assert(post[2].status === 'blocked' && post[2].exclusion_reason === 'link_mismatch' && post[2].claim == null
        && post[0].status === 'unknown' && Number(post[0].claim) === 1 && post[0].retry_key === pre[0].retry_key && Number(post[1].claim) === 1 && post[1].retry_key === pre[1].retry_key && bT && bT.message_text && bT.message_text.includes(LIFF_A),
      'X3 從未嘗試者作廢並釋放名額；已嘗試／結果不明者保留原 key、原訊息與名額（歷史保留、阻擋直接續送）', JSON.stringify(post.map((r) => [r.status, r.exclusion_reason, r.claim])));
      assert(rT.status === 409 || (rT.json && rT.json.data && /連結|link/i.test(JSON.stringify(rT.json))) || (bT && bT.pause_reason === 'link_mismatch'),
        'X4 後台顯示阻擋原因（連結／店別設定與目前不符）', JSON.stringify({ st: rT.status, j: rT.json, pr: bT && bT.pause_reason }));
      const pvT = (await preview(T, PN)).json.data;
      assert(pvT.stats.eligible_count === 1 && pvT.link_url.includes(LIFF_B) && pvT.link_url.includes('store_id=store_002') && pvT.link_url.includes(dstUuid) && !pvT.link_url.includes(srcUuid),
        'X5 從未嘗試者在目標店重新預覽：使用目標店 LIFF、店別與商品識別；已嘗試／結果不明者不能藉重新預覽繞過（只剩 1 人）', JSON.stringify({ el: pvT.stats.eligible_count, ex: pvT.stats.exclusions, link: pvT.link_url }));
      await confirm(T, pvT.batch_uuid); await waitBatch(T, pvT.batch_uuid);
      const xcCalls = callsTo(xc);
      assert(xcCalls.length === 1 && xcCalls[0].text.includes(LIFF_B) && xcCalls[0].text.includes('store_id=store_002') && xcCalls[0].text.includes('目標店') && callsTo(xa).length === 1 && callsTo(xb).length === 1,
        'X6 新批次訊息正確指向目標店；結果不明／已嘗試者沒有任何額外呼叫', JSON.stringify({ xc: xcCalls.length, xa: callsTo(xa).length, xb: callsTo(xb).length }));
      // 同店：LIFF 改變
      const ya = nextUid(), yb = nextUid();
      const BY = await makeBatch(S, P7, [ya, yb], { [ya]: ['401'] });
      await restart(S, (db) => { db.run("UPDATE settings SET value=? WHERE store_id='store_001' AND key='line_member_liff_id'", ['2000000009-NewLiff']); });
      const cY = mockCalls().length;
      await resume(S, BY); await waitBatch(S, BY);
      const ybRow = await delRow(S, BY, yb);
      assert(mockCalls().length === cY && ybRow.exclusion_reason === 'link_mismatch', 'X7 同店還原但 LIFF 已改變：舊批次不以舊連結續送', JSON.stringify([ybRow.status, ybRow.exclusion_reason, mockCalls().length - cY]));
      // 同店：商品識別改變
      const za = nextUid(), zb = nextUid();
      const BZ = await makeBatch(S, PN, [za, zb], { [za]: ['401'] });
      await restart(S, (db) => { db.run('UPDATE products SET product_uuid=? WHERE id=?', [require('crypto').randomUUID(), PN]); });
      const cZ = mockCalls().length;
      await resume(S, BZ); await waitBatch(S, BZ);
      const zbRow = await delRow(S, BZ, zb);
      assert(mockCalls().length === cZ && zbRow.exclusion_reason === 'link_mismatch', 'X8 同店商品識別已改變：舊批次不以舊連結續送', JSON.stringify([zbRow.status, zbRow.exclusion_reason]));
      // 設定相符：沿用原 retry key 與原訊息快照
      const qa = nextUid(), qb = nextUid();
      const BQ = await makeBatch(S, P7, [qa, qb], { [qa]: ['401'] });
      const qbBefore = await delRow(S, BQ, qb);
      const bq = await detail(S, BQ);
      await resume(S, BQ); await waitBatch(S, BQ);
      const qc = callsTo(qb);
      assert(qc.length === 1 && qc[0].retry_key === qbBefore.retry_key && qc[0].text === bq.message_text && (await delRow(S, BQ, qb)).status === 'accepted',
        'X9 設定相符的原流程：續送沿用原 retry key 與原訊息快照', JSON.stringify({ n: qc.length }));
      // 商品直達：目標店新連結開啟正確商品、不改顧客資料、不下單
      if (chromium) {
        const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
        try {
          const ctxB = await browser.newContext({ viewport: { width: 390, height: 860 } });
          await ctxB.addInitScript(([off, saved]) => { if (off) { const RD = Date; class D extends RD { constructor(...a) { if (a.length === 0) super(RD.now() + off); else super(...a); } static now() { return RD.now() + off; } } window.Date = D; } if (!sessionStorage.getItem('__s')) { localStorage.setItem('line_order_cart_store_002', saved); sessionStorage.setItem('__s', '1'); } },
            [CLOCK_OFF, JSON.stringify({ version: 1, store_id: 'store_002', cart_created_at: Date.now(), cart_updated_at: Date.now(), cart: { [P7]: 2 }, order_mode: 'delivery', customer: { name: '原本姓名', phone: '0912345678' }, coupon_code: '', pickup_date: twDate(1), pickup_time: '', payment_method: '', order_note: '' })]);
          const page = await ctxB.newPage(); const posts = [];
          page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/line-orders|linepay/.test(r.url())) posts.push(r.url()); });
          const q = new URL(pvT.link_url).search;
          await page.goto(`${T.s.base}/line-order.html${q}`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('.pdm-overlay.pdm-open', { timeout: 15000 }).catch(() => {});
          await sleep(500);
          const st = await page.evaluate(() => ({ name: (document.getElementById('pdmName') || {}).textContent || '', cart: JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty]))), mode: currentMode, stored: JSON.parse(localStorage.getItem('line_order_cart_store_002') || '{}') }));
          assert(/測試補貨麵/.test(st.name) && st.cart === JSON.stringify({ [P7]: 2 }) && st.mode === 'delivery' && st.stored.customer && st.stored.customer.name === '原本姓名' && st.stored.pickup_date === twDate(1) && posts.length === 0,
            'X10 目標店連結開啟正確商品，不改購物車、姓名、日期、取餐方式，不自動下單', JSON.stringify({ n: st.name, cart: st.cart, mode: st.mode, posts }));
        } finally { await browser.close(); }
      }
    }

    // ═════════════════ C：商品收集開關 ═════════════════
    if (run('c')) {
      const M = await boot('collect', { env: { RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '2000' } }); ctxs.push(M);
      const okU = nextUid();
      const BA = await makeBatch(M, P7, [okU], {});
      const acceptedBefore = await rows(M, "SELECT delivery_uuid, status, claim, retry_key FROM restock_notify_deliveries WHERE status='accepted'");
      const c1 = nextUid(), c2 = nextUid(), c3 = nextUid();
      for (const u of [c1, c2, c3]) await reg(M, u, PN);
      await friends(M, [c1, c2, c3]);
      await setCollect(M, PN, false);
      const p0 = (await preview(M, PN)).json.data;
      assert(!p0.can_send && !p0.batch_uuid && p0.stats.exclusions.collect_disabled === 3 && p0.blockers.includes('collect_disabled'), 'C1 關閉收集登記：預覽顯示明確排除原因且不可發送', JSON.stringify({ b: p0.blockers, ex: p0.stats.exclusions }));
      await setCollect(M, PN, true);
      const p1 = (await preview(M, PN)).json.data;
      await setCollect(M, PN, false);
      const cc = await confirm(M, p1.batch_uuid);
      const dC = await waitBatch(M, p1.batch_uuid);
      assert(p1.can_send && cc.json && cc.json.success && cc.json.data.queued === 0 && dC.deliveries.every((d) => d.exclusion_reason === 'collect_disabled') && [c1, c2, c3].every((u) => callsTo(u).length === 0),
        'C2 預覽後關閉收集：確認時全部擋下、0 次呼叫', JSON.stringify({ c: cc.json && cc.json.data, d: dC.deliveries.map((d) => d.exclusion_reason) }));
      // 執行中關閉
      await setCollect(M, PN, true);
      const d1 = nextUid(), d2 = nextUid();
      for (const u of [d1, d2]) await reg(M, u, P7);
      await friends(M, [d1, d2]);
      setCtrl({ default: '200', byUser: { [d1]: ['hang', '200'] } });
      const p2 = (await preview(M, P7)).json.data;
      await confirm(M, p2.batch_uuid);
      for (let i = 0; i < 60 && !callsTo(d1).length; i++) await sleep(50);
      await setCollect(M, P7, false);
      await waitBatch(M, p2.batch_uuid, 15000);
      const d2row = await delRow(M, p2.batch_uuid, d2), d1row = await delRow(M, p2.batch_uuid, d1);
      assert(callsTo(d2).length === 0 && d2row.exclusion_reason === 'collect_disabled' && callsTo(d1).length === 1 && d1row.exclusion_reason === 'collect_disabled' && Number(d1row.claim) === 1,
        'C3 批次執行中關閉收集：尚未送出的會員不再收到請求；在途者照實記錄、不再重試並保留名額', JSON.stringify({ d1: [callsTo(d1).length, d1row.status, d1row.exclusion_reason], d2: [callsTo(d2).length, d2row.status, d2row.exclusion_reason] }));
      const m1 = await mine(M, d2);
      const rv = await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session(M.store, d2), product_id: P7 });
      const cn = await pub(M, 'POST', '/api/product-demand/cancel', { member_session: session(M.store, d2), product_id: P7 });
      assert(m1.length === 1 && rv.json && rv.json.data.revoked === true && cn.json && cn.json.success, 'C4 收集關閉時本人仍可查看、撤回同意與取消登記', JSON.stringify({ m: m1.length, rv: rv.json && rv.json.data, cn: cn.json && cn.json.success }));
      const callsR = mockCalls().length;
      await setCollect(M, P7, true); await setCollect(M, PN, true);
      await sleep(1500);
      const acceptedAfter = await rows(M, "SELECT delivery_uuid, status, claim, retry_key FROM restock_notify_deliveries WHERE delivery_uuid IN (" + acceptedBefore.map(() => '?').join(',') + ')', acceptedBefore.map((r) => r.delivery_uuid));
      assert(mockCalls().length === callsR && JSON.stringify(acceptedBefore) === JSON.stringify(acceptedAfter), 'C5 重新開啟收集不會自行開始發送；已受理防重歷史不變', `calls=${mockCalls().length - callsR}`);
      void BA;
    }

    // ═════════════════ A：嘗試次數總上限 ═════════════════
    if (run('a')) {
      const A1 = await boot('max1', { env: { RESTOCK_NOTIFY_MAX_ATTEMPTS: '1' } }); ctxs.push(A1);
      const a1 = nextUid();
      const BA1 = await makeBatch(A1, PN, [a1], { [a1]: ['500', '500', '500'] });
      const r0 = await delRow(A1, BA1, a1);
      const resumes = [];
      for (let i = 0; i < 3; i++) { resumes.push(await resume(A1, BA1)); await waitBatch(A1, BA1); }
      const conc = await Promise.all([resume(A1, BA1), resume(A1, BA1), resume(A1, BA1)]);
      await waitBatch(A1, BA1);
      await restart(A1);
      await resume(A1, BA1); await waitBatch(A1, BA1);
      const r1 = await delRow(A1, BA1, a1);
      const dA1 = await detail(A1, BA1);
      assert(r0.status === 'unknown' && Number(r0.attempt_count) === 1 && Number(r1.attempt_count) === 1 && Number(r1.max_attempts) === 1 && callsTo(a1).length === 1 && r1.status === 'unknown',
        'A1 上限 1：多次續送、並行續送、重啟後續送，嘗試次數仍為 1、僅 1 次呼叫、狀態仍為結果待確認', JSON.stringify({ att: r1.attempt_count, calls: callsTo(a1).length, st: r1.status, conc: conc.map((c) => c.status) }));
      assert(dA1.deliveries[0].attempts_exhausted === true, 'A2 明細標示「已達嘗試上限」', JSON.stringify(dA1.deliveries[0]));
      const M = await boot('max4'); ctxs.push(M);
      const a4 = nextUid(), a5 = nextUid();
      const B4 = await makeBatch(M, PN, [a4, a5], { [a4]: ['500'], [a5]: ['429_quota', '200'] });
      // a4 已實際送出 1 次（5xx）；把它設成「已用完 4／4 次」的結果待確認狀態（與 C4 S17 實測的上限狀態相同），a5 為 429 額度暫停（1／4）
      await restart(M, (db) => { db.run("UPDATE restock_notify_deliveries SET status='unknown', attempt_count=4, next_attempt_at=NULL WHERE batch_uuid=? AND line_user_id=?", [B4, a4]); });
      const s4 = await delRow(M, B4, a4), s5 = await delRow(M, B4, a5);
      const a4calls0 = callsTo(a4).length;
      const t0 = Date.now();
      await resume(M, B4); await resume(M, B4);
      const d4 = await waitBatch(M, B4, 10000);
      const took = Date.now() - t0;
      const e4 = await delRow(M, B4, a4), e5 = await delRow(M, B4, a5);
      assert(s4.status === 'unknown' && Number(s4.attempt_count) === 4 && Number(e4.attempt_count) === 4 && callsTo(a4).length === a4calls0 && e4.status === 'unknown' && s5.status === 'held' && e5.status === 'accepted' && d4.status === 'completed' && took < 8000,
        'A3 上限 4：達上限者不再被續送；同批仍有剩餘次數的會員正常完成；批次不卡住', JSON.stringify({ a4: [e4.status, e4.attempt_count, callsTo(a4).length], a5: [s5.status, e5.status], took, st: d4.status }));
      // 舊資料：retry_wait 但已達上限 → 不忙迴圈、不送出
      const l1 = nextUid(), l2 = nextUid();
      const BL = await makeBatch(M, P7, [l1, l2], { [l1]: ['401'] });
      await restart(M, (db) => { db.run("UPDATE restock_notify_deliveries SET status='retry_wait', attempt_count=4, max_attempts=4, first_attempt_at=datetime('now','-1 minutes') WHERE batch_uuid=? AND line_user_id=?", [BL, l2]); });
      const t1 = Date.now();
      await resume(M, BL);
      const dL = await waitBatch(M, BL, 10000);
      const l2row = await delRow(M, BL, l2);
      assert(callsTo(l2).length === 0 && Number(l2row.attempt_count) === 4 && dL && dL.status !== 'sending' && Date.now() - t1 < 8000,
        'A4 舊資料中已達上限卻仍為待重試的項目：不送出、不增加次數、不造成忙迴圈', JSON.stringify({ st: l2row.status, att: l2row.attempt_count, b: dL && dL.status }));
      // 時間窗：次數未滿但超過 23 小時 → 不續送
      const w1 = nextUid();
      const BW = await makeBatch(M, PN, [w1], { [w1]: ['409_other'] });
      await restart(M, (db) => { db.run("UPDATE restock_notify_deliveries SET first_attempt_at=datetime('now','-25 hours') WHERE batch_uuid=?", [BW]); });
      await resume(M, BW); await waitBatch(M, BW);
      assert(callsTo(w1).length === 1, 'A5 次數未滿但超過重試時間窗：不續送（次數與時間兩項都須符合）', String(callsTo(w1).length));
    }

    // ═════════════════ T：顧客畫面文案 ═════════════════
    if (run('t')) {
      const html = fs.readFileSync(path.join(H.ROOT, 'public', 'line-order.html'), 'utf8');
      const app = fs.readFileSync(path.join(H.ROOT, 'public', 'js', 'app.js'), 'utf8');
      assert(!/已收到過補貨通知|已送達|已讀/.test(html) && html.includes('此登記的補貨通知已交由 LINE 處理，同一次登記只通知一次。'),
        'T1 顧客畫面不宣稱「已收到」，改為「已交由 LINE 處理」', String(html.includes('已收到過補貨通知')));
      const rnPart = app.slice(app.indexOf('R54.4／MBV2-HF1-C4：LINE 補貨通知'), app.indexOf('async function restockCancel'));
      assert(rnPart.length > 1000 && /LINE 已受理/.test(rnPart) && /不代表顧客已收到或已讀/.test(rnPart) && !/已送達|已收到通知|顧客已讀/.test(rnPart.replace(/不代表顧客已收到或已讀/g, '')), 'T2 後台補貨通知區維持「LINE 已受理」並說明不代表送達或已讀（不出現已送達／已讀等宣稱）', String(rnPart.length));
      const M = await boot('copy'); ctxs.push(M);
      const k1 = nextUid();
      await makeBatch(M, PN, [k1], { [k1]: ['409_other'] });
      const mk = (await mine(M, k1))[0];
      assert(mk.restock_notify !== 'accepted', 'T3 結果不明不顯示為已受理', mk.restock_notify);
      if (chromium) {
        const k2 = nextUid();
        await makeBatch(M, P7, [k2], {});
        await adm(M, 'PATCH', `/api/products/${P7}/line-settings`, { sale_status: 'paused' });
        const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
        try {
          const c = await browser.newContext({ viewport: { width: 390, height: 860 } });
          await c.addInitScript(([off, ms]) => { if (off) { const RD = Date; class D extends RD { constructor(...a) { if (a.length === 0) super(RD.now() + off); else super(...a); } static now() { return RD.now() + off; } } window.Date = D; } localStorage.setItem('line_member_session_store_001', JSON.stringify({ member_session: ms, display_name: 't', is_friend: true, expires_at: Date.now() + 3600e3 })); }, [CLOCK_OFF, session('store_001', k2)]);
          const page = await c.newPage();
          await page.goto(`${M.s.base}/line-order.html?store_id=store_001`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector(`[data-demand-pid="${P7}"]`, { timeout: 20000 });
          await page.click(`[data-demand-pid="${P7}"]`);
          await page.waitForSelector('#demandPanel', { timeout: 8000 });
          await sleep(400);
          const t = await page.evaluate(() => document.getElementById('demandPanel').innerText);
          assert(t.includes('此登記的補貨通知已交由 LINE 處理，同一次登記只通知一次。') && !/已收到/.test(t), 'T4 實際畫面：已受理的登記顯示「已交由 LINE 處理」，不宣稱已收到', t.split('\n').filter((l) => /通知/.test(l)).join(' | '));
        } finally { await browser.close(); }
      }
    }

    // ═════════════════ K：舊 C4 程式產生的資料由本版接手 ═════════════════
    if (run('k') && process.env.C4_BASELINE_ROOT) {
      const K = await boot('legacy', { root: process.env.C4_BASELINE_ROOT }); ctxs.push(K);
      const kb = nextUid(), ku = nextUid();
      const BK = await makeBatch(K, PN, [kb, ku], { [kb]: ['401'] });
      await importBuf(K, await backupWithAccepted(K, [{ uid: ku }]));
      const legacyRows = await rows(K, "SELECT status, claim FROM restock_notify_deliveries WHERE line_user_id=? ORDER BY id", [ku]);
      await safeStop(K.s);
      K.root = H.ROOT; await start(K);
      const cK = callsTo(ku).length;
      await resume(K, BK); await waitBatch(K, BK);
      const mk = (await mine(K, ku))[0];
      assert(legacyRows.some((r) => r.status === 'accepted' && r.claim == null) && legacyRows.some((r) => r.status === 'pending' && Number(r.claim) === 1) && callsTo(ku).length === cK && mk.restock_notify === 'accepted',
        'K1 舊 C4 程式寫入的資料（本地 pending 持有 claim、匯入的已受理列 claim=NULL）由本版接手後：續送 0 次呼叫、顧客狀態為已受理', JSON.stringify({ legacyRows, calls: callsTo(ku).length - cK, mine: mk.restock_notify }));
    }

    // ═════════════════ R：回退相容（C4 程式讀取 C4.1 用過的資料庫）═════════════════
    if (run('r') && process.env.C4_BASELINE_ROOT) {
      const RB = await boot('rollback'); ctxs.push(RB);
      // (1) 匯入衝突：本地 pending＋匯入已受理 → C4.1 匯入時即停止（保留名額）
      const rb1 = nextUid(), ru1 = nextUid();
      const BR1 = await makeBatch(RB, PN, [rb1, ru1], { [rb1]: ['401'] });
      await importBuf(RB, await backupWithAccepted(RB, [{ uid: ru1 }]));
      const ruRow = await delRow(RB, BR1, ru1);
      // (2) 連結不符的舊批次（LIFF 改變後續送 → 終止並保留歷史）
      const rb2 = nextUid(), ru2 = nextUid(), ru3 = nextUid();
      const BR2 = await makeBatch(RB, P7, [ru3, rb2, ru2], { [ru3]: ['409_other'], [rb2]: ['401'] });
      await restart(RB, (db) => { db.run("UPDATE settings SET value=? WHERE store_id='store_001' AND key='line_member_liff_id'", ['2000000010-Changed']); });
      const rm = await resume(RB, BR2);
      const b2 = await detail(RB, BR2);
      assert(ruRow.status === 'blocked' && ruRow.exclusion_reason === 'already_notified' && Number(ruRow.claim) === 1 && rm.status === 409 && b2.status === 'cancelled' && b2.pause_reason === 'link_mismatch',
        'R1 C4.1 狀態：匯入衝突列已停止（保留名額）；連結不符的舊批次為終止狀態並保留歷史', JSON.stringify({ ru: [ruRow.status, ruRow.exclusion_reason, ruRow.claim], b2: [b2.status, b2.pause_reason] }));
      // 回退：同一資料庫改由 C4 程式啟動
      await safeStop(RB.s);
      RB.root = process.env.C4_BASELINE_ROOT; await start(RB);
      const c0 = mockCalls().length;
      const h = await fetch(RB.s.base + '/line-order.html?store_id=store_001');
      const cap = await adm(RB, 'GET', '/api/product-demand-admin/restock/capability');
      const lst = await adm(RB, 'GET', '/api/product-demand-admin/restock/batches');
      const dt = await adm(RB, 'GET', `/api/product-demand-admin/restock/batches/${BR2}`);
      const r1 = await resume(RB, BR1); await waitBatch(RB, BR1);
      const r2 = await resume(RB, BR2); await waitBatch(RB, BR2);
      const nu = nextUid(); await reg(RB, nu, PN); await friends(RB, [nu]);
      const pvOld = (await preview(RB, PN)).json;
      const sentAfter = mockCalls().slice(c0);
      const toConflict = sentAfter.filter((c) => c.uid === ru1 || c.uid === ru2 || c.uid === ru3).length;
      const staleLink = sentAfter.filter((c) => c.text.includes(LIFF_A) && c.uid !== rb1).length;
      assert(h.status === 200 && cap.json && cap.json.success && lst.json && lst.json.success && dt.json && dt.json.success && r2.status === 409 && toConflict === 0 && staleLink === 0
        && pvOld && pvOld.success && pvOld.data.stats.eligible_count === 1,
        'R2 回退到 C4 程式並保留資料庫：可啟動、頁面與後台查詢正常；C4 不會續送終止的舊連結批次，也不會再通知已停止的衝突會員（名額仍被占用）；新登記可正常預覽',
        JSON.stringify({ h: h.status, r1: r1.status, r2: r2.status, toConflict, staleLink, eligible: pvOld && pvOld.data && pvOld.data.stats.eligible_count }));
      await safeStop(RB.s);
      RB.root = H.ROOT; await start(RB);
      const again = (await adm(RB, 'GET', '/api/product-demand-admin/restock/capability')).json;
      assert(again && again.success, 'R3 回退後再升級回 C4.1：正常啟動', JSON.stringify(again && again.success));
    }

    const sim = mockCalls().length, real = realLineAttempts();
    console.log(`\n模擬 LINE API 呼叫次數（程序內攔截、未連外）：${sim}`);
    console.log(`真實 LINE API 呼叫次數：${real}`);
    assert(real === 0, 'Z1 真實 LINE API 呼叫次數為 0', `simulated=${sim} real=${real}`);
    if (process.env.C41_STATS_FILE) fs.writeFileSync(process.env.C41_STATS_FILE, JSON.stringify({ simulated_line_calls: sim, real_line_calls: real, clock_offset_ms: CLOCK_OFF }));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    for (const c of ctxs) { try { await safeStop(c.s); } catch {} }
  }
  const { passCount, failCount, results } = H.summary();
  if (process.env.C41_RESULT_JSON) fs.writeFileSync(process.env.C41_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount ? 1 : 0);
})();
