#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.1 —— 真實升級與回退（同一個資料庫檔在不同版本的全新解壓樹之間切換；[RS]＝實際停止／啟動服務程序）
//   P1  最新 C5.4.2（C61_C542_ROOT）建立並使用 → C6.1
//   P2  舊 C6（C61_C6_ROOT）建立並使用（含自動批次、因重啟暫停的自動批次、舊 C6「事件完成＋預覽未確認」）→ C6.1
//   P3  C6.1 → 最新 C5.4.2 → 再升級 C6.1（含回退時正在送出的自動批次）
// 每次切換都核對：需求、同意、批次、逐筆結果、retry key、商品關聯、付款資料與時間（各表共同欄位逐列相同，不遺失）。
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
const R542 = process.env.C61_C542_ROOT || '';
const R6 = process.env.C61_C6_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [910 + i, '升降商品' + i, i, 'paused', { quota: 50 }])];
const TABLES = {
  product_demand_requests: 'request_uuid', product_demand_consents: 'consent_uuid', restock_notify_batches: 'batch_uuid', restock_notify_deliveries: 'delivery_uuid',
  products: 'id', orders: 'id', restock_auto_events: 'event_uuid',
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 升級／回退（C5.4.2、舊 C6、C6.1 之間切換同一資料庫檔）══════════');
  console.log('C6.1：' + H.ROOT + '\nC5.4.2：' + (R542 || '（未提供）') + '\nC6：' + (R6 || '（未提供）'));
  if (!R542 || !R6) { H.fail('需要 C61_C542_ROOT 與 C61_C6_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
  const S = (u) => sessAt(u, OFF);
  let proc = null, tok = null, base = null, C = null, GATE = null, mfRef = null, dbf = null;
  const baseEnv = () => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c61-line-gate.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '30000', C61_LINE_GATE_DIR: GATE });
  const start = async (root) => {
    const env = baseEnv();
    const port = C.s.port; base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: root, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      MIGRATION_TMP_DIR: path.join(path.dirname(dbf), 'uploads'), HF1C3_PUSH_COUNT_FILE: mfRef.push, C4_LINE_MOCK_CTRL: mfRef.ctrl, C4_LINE_MOCK_STATE: mfRef.state, C4_LINE_MOCK_LOG: mfRef.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; }); proc.getLog = () => log; proc.root = root;
    for (let i = 0; i < 300; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { tok = await H.login(base, STORE, 'pw001'); break; } } catch {} if (proc.exitCode != null) throw new Error('exit ' + log.slice(-1500)); await sleep(100); }
    if (!tok) throw new Error('start timeout');
    // 開機恢復完成（C6.1 有明確紀錄；其他版本沒有自動恢復或以 5 秒上限等待）
    const t0 = Date.now(); while (root === H.ROOT && !/\[restock_auto\] boot recovery done/.test(log) && Date.now() - t0 < 8000) await sleep(30);
    if (root === R6) await sleep(2500); // C6 的開機恢復在啟動 2 秒後執行、沒有完成紀錄
    await idle();
  };
  const stop = async (sig = 'SIGTERM') => { const p = proc; proc = null; tok = null; if (!p || p.exitCode != null) return; p.kill(sig); await new Promise((r) => { p.once('exit', r); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000); }); };
  const adm = (m, p, b) => H.api(base, tok, m, p, b);
  const pub = (m, p, b) => C45.pub(base, m, p, b);
  const calls = (u) => mfRef.calls().filter((c) => c.uid === u);
  const q = async (sql, params) => { const db = await H.openDbFile(dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
  const reg = async (u, pid) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: 'takeout', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text.slice(0, 200)); };
  const batchesOf = async (pid) => ((await adm('GET', `/api/product-demand-admin/restock/batches?product_id=${pid}`)).json || {}).data || [];
  async function idle(ms = 15000) {
    const t0 = Date.now();
    for (;;) {
      const r = await q("SELECT (SELECT COUNT(*) FROM restock_notify_batches WHERE status='sending') AS s" + (await hasTable('restock_auto_events') ? ", (SELECT COUNT(*) FROM restock_auto_events WHERE status IN ('queued','processing')) AS e" : ', 0 AS e'));
      if (!Number(r[0].s) && !Number(r[0].e)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(50);
    }
  }
  async function hasTable(t) { return (await q("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t])).length > 0; }
  const snapshot = async () => {
    const out = {};
    for (const [t, k] of Object.entries(TABLES)) { if (!(await hasTable(t))) continue; out[t] = new Map((await q(`SELECT * FROM ${t}`)).map((r) => [String(r[k]), r])); }
    return out;
  };
  // 舊列在新快照中仍存在，且共同欄位的值相同（新版本新增的欄位不比較；狀態會正常推進的欄位另列）
  const MOVING = new Set(['updated_at', 'status', 'pause_reason', 'exclusion_reason', 'claim', 'error_code', 'next_attempt_at', 'completed_at', 'attempt_count', 'first_attempt_at', 'last_attempt_at',
    'accepted_at', 'last_http_status', 'line_request_id', 'accepted_request_id', 'taken_over_by', 'notified_at', 'sale_status', 'line_quota_sold', 'detail_json', 'reason', 'batch_uuids', 'claimed_at', 'attempts',
    'restock_auto_notify', 'restock_auto_version', 'updated_by', 'confirmed_at', 'confirmed_by']);
  const preserved = (a, b, tables) => {
    const lost = []; const changed = []; const backfilled = [];
    for (const t of tables) {
      if (!a[t]) continue;
      for (const [k, r] of a[t]) {
        const n = b[t] && b[t].get(k);
        if (!n) { lost.push(t + ':' + k); continue; }
        for (const c of Object.keys(r)) {
          if (!(c in n) || MOVING.has(c) || String(r[c]) === String(n[c])) continue;
          // 既有開機補值（各版本相同）：舊外帶訂單 pickup_type 空白 → 'store'，不是資料遺失
          if (t === 'orders' && c === 'pickup_type' && (r[c] == null || r[c] === '') && n[c] === 'store' && n.order_type !== 'delivery') { backfilled.push(`${t}:${k}`); continue; }
          changed.push(`${t}:${k}:${c}`);
        }
      }
    }
    return { lost, changed, backfilled };
  };
  // 已受理證據與 retry key 必須逐筆保留（狀態推進可以，但已受理不可變回其他狀態、key 不可改）
  const evidenceKept = (a, b) => {
    const bad = [];
    for (const [k, r] of a.restock_notify_deliveries || []) {
      const n = b.restock_notify_deliveries.get(k);
      if (!n) { bad.push('lost:' + k); continue; }
      if (String(r.retry_key) !== String(n.retry_key)) bad.push('key:' + k);
      if (r.status === 'accepted' && n.status !== 'accepted') bad.push('acc:' + k);
      if (r.status === 'unknown' && !['unknown', 'accepted'].includes(n.status)) bad.push('unk:' + k);
    }
    return bad;
  };
  const autoBatch = async (pid, users) => { // 啟用參與、登記、恢復販售，等自動批次結束
    await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: true });
    for (const u of users) await reg(u, pid);
    await adm('PATCH', `/api/products/${pid}/line-status`, { sale_status: 'available' });
    await idle(); return batchesOf(pid);
  };
  const gateFile = (n) => path.join(GATE, n);
  const waitFile = async (f, ms = 20000) => { const t0 = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  const order = async (name) => { const o = await pub('POST', '/api/line-orders', { customer_name: name, customer_phone: '0912' + String(Date.now()).slice(-6), order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'cash', items: [{ product_id: 701, qty: 1 }] }); if (!o.json || !o.json.success) throw new Error('order ' + o.text.slice(0, 200)); return o.json.data; };
  // 以「該版本自己的程式」建立空資料庫（避免舊版資料庫被新版欄位預先初始化），再放入相同種子資料
  const fresh = async (tag, root) => {
    const dir = H.tmpDir(tag); dbf = path.join(dir, 'pos.db');
    mfRef = C45.lineMockFiles(tag); GATE = H.tmpDir(tag + '-gate');
    const port = await new Promise((res) => { const sv = require('net').createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => res(p)); }); });
    C = { s: { port } };
    const p0 = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads') }, stdio: 'ignore' });
    for (let i = 0; i < 300; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) break; } catch {} await sleep(100); }
    await new Promise((r) => { p0.once('exit', r); p0.kill('SIGTERM'); });
    const db = await H.openDbFile(dbf); require('./lib/mbv2-seed').seedStore001(db); C45.seedStore(db, { products: PRODUCTS, members: 60, settings: { restock_notify_enabled: '1' } }); H.saveDbFile(db, dbf); db.close();
    fs.writeFileSync(mfRef.ctrl, JSON.stringify({ default: '200' }));
  };

  try {
    // ═══════════════ P1：C5.4.2 → C6.1 ═══════════════
    await fresh('c61u1', R542);
    await start(R542);
    for (const i of [1, 2]) await reg(U(i), 911);
    const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 911, fulfillment_mode: 'takeout', supply_date: today });
    await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {}); await idle();
    await reg(U(3), 912);
    const o1 = await order('升級前訂單');
    const snap1 = await snapshot();
    await stop();
    await start(H.ROOT);
    const cfg = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data;
    const snap1b = await snapshot();
    const p1 = preserved(snap1, snap1b, Object.keys(TABLES));
    const pcols = (await q('PRAGMA table_info(products)')).map((c) => c.name);
    const bcols = (await q('PRAGMA table_info(restock_notify_batches)')).map((c) => c.name);
    const vers = await q('SELECT COUNT(*) AS n FROM products WHERE COALESCE(restock_auto_notify,0)<>0 OR COALESCE(restock_auto_version,0)<>0');
    await adm('PATCH', '/api/products/912/line-status', { sale_status: 'available' }); await idle();
    const ev1 = (await adm('GET', '/api/product-demand-admin/restock/auto/events')).json.data;
    const ord1 = (await q('SELECT id, created_at, total, payment_method, status FROM orders WHERE id=?', [o1.uuid || o1.id]))[0];
    assert(!p1.lost.length && !p1.changed.length && !evidenceKept(snap1, snap1b).length && cfg.enabled === false && cfg.epoch === 0 && cfg.participating_products.length === 0
      && pcols.includes('restock_auto_version') && bcols.includes('auto_epoch') && bcols.includes('auto_product_version') && Number(vers[0].n) === 0 && ev1.length === 0 && calls(U(3)).length === 0 && ord1,
      'P1 [RS] 最新 C5.4.2 → C6.1（同一資料庫檔）：需求、同意、批次、逐筆結果、retry key、商品、訂單付款與時間全部保留；自動通知預設關閉、商品不參與、版本 0；恢復販售不自動發送',
      JSON.stringify({ lost: p1.lost.slice(0, 5), changed: p1.changed.slice(0, 5), en: cfg.enabled, epoch: cfg.epoch, ev: ev1.length, u3: calls(U(3)).length }));
    // 遷移可重複執行：再啟動一次，結構與資料不變
    const snapM = await snapshot(); await stop(); await start(H.ROOT); const snapM2 = await snapshot();
    const pm = preserved(snapM, snapM2, Object.keys(TABLES));
    const colsAgain = (await q('PRAGMA table_info(products)')).map((c) => c.name).filter((c) => c === 'restock_auto_version').length;
    assert(!pm.lost.length && !pm.changed.length && colsAgain === 1, 'P1b [RS] C6.1 遷移可重複執行：再次啟動後欄位只有一份、資料不變', JSON.stringify({ pm, colsAgain }));
    await stop();

    // ═══════════════ P2：舊 C6 資料 → C6.1 ═══════════════
    await fresh('c61u2', R6);
    await start(R6);
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    const okBatch = await autoBatch(913, [U(10), U(11)]); // 正常完成的自動批次
    // 舊 C6 留下「事件完成＋自動預覽未確認＋沒有 delivery」（先以正式 API 建立預覽，停機後以 fixture 補上事件關聯）
    await adm('PATCH', '/api/product-demand-admin/restock/auto/products/915', { enabled: true });
    await adm('PATCH', '/api/products/915/line-status', { sale_status: 'available' }); await idle();
    await reg(U(14), 915);
    const pv2 = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 915, fulfillment_mode: 'takeout', supply_date: today });
    const orphan = pv2.json.data.batch_uuid;
    const o2 = await order('C6 訂單');
    // 因重啟暫停的自動批次：第一位已受理但回應未返回時服務被 SIGKILL（之後不再啟動 C6，直接升級）
    await adm('PATCH', '/api/product-demand-admin/restock/auto/products/914', { enabled: true });
    for (const u of [U(12), U(13)]) await reg(u, 914);
    fs.writeFileSync(gateFile('hold_' + U(12)), '1');
    await adm('PATCH', '/api/products/914/line-status', { sale_status: 'available' });
    if (!await waitFile(gateFile('arrived_' + U(12)))) throw new Error('C6 gate not reached');
    await stop('SIGKILL');
    { const db = await H.openDbFile(dbf);
      const ep = Number(H.q(db, "SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE])[0].value);
      db.run(`INSERT INTO restock_auto_events (event_uuid, store_id, product_id, product_name, trigger_source, modes_json, status, epoch, completed_at) VALUES ('00000000-0000-4000-8000-00000000c6f1',?,915,'升降商品5','line_status',?,'completed',?,datetime('now'))`,
        [STORE, JSON.stringify([{ mode: 'takeout', date: today, notice_kind: 'restock' }]), ep]);
      db.run("UPDATE restock_notify_batches SET source='auto', auto_event_uuid='00000000-0000-4000-8000-00000000c6f1' WHERE batch_uuid=?", [orphan]);
      H.saveDbFile(db, dbf); db.close(); }
    const snap2 = await snapshot();
    const cfg6 = await q("SELECT key, value FROM settings WHERE store_id=? AND key LIKE 'restock_auto_notify%' ORDER BY key", [STORE]);
    await start(H.ROOT);
    const snap2b = await snapshot();
    const p2 = preserved(snap2, snap2b, Object.keys(TABLES));
    const cfg61 = await q("SELECT key, value FROM settings WHERE store_id=? AND key LIKE 'restock_auto_notify%' ORDER BY key", [STORE]);
    const b914 = (await batchesOf(914))[0];
    const d914 = await q('SELECT line_user_id, status, claim, retry_key, exclusion_reason FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id', [b914.batch_uuid]);
    const bOr = (await q('SELECT status, pause_reason FROM restock_notify_batches WHERE batch_uuid=?', [orphan]))[0];
    const eOr = (await q("SELECT status, reason FROM restock_auto_events WHERE event_uuid='00000000-0000-4000-8000-00000000c6f1'"))[0];
    const pv915 = await q('SELECT restock_auto_notify, restock_auto_version FROM products WHERE id IN (913,914,915) ORDER BY id');
    assert(!p2.lost.length && !p2.changed.length && !evidenceKept(snap2, snap2b).length && JSON.stringify(cfg6) === JSON.stringify(cfg61) && okBatch[0] && okBatch[0].counts.accepted === 2
      && pv915.every((p) => Number(p.restock_auto_notify) === 1 && Number(p.restock_auto_version) === 1),
      'P2 [RS] 舊 C6 → C6.1：需求、同意、批次、逐筆結果、retry key、訂單全部保留；自動開關／epoch 不變；已參與商品版本自 1 起算',
      JSON.stringify({ lost: p2.lost.slice(0, 5), changed: p2.changed.slice(0, 5), cfg: cfg61.map((r) => r.value), pv: pv915 }));
    assert(b914.status === 'paused' && b914.pause_reason === 'auto_version_unproven' && calls(U(13)).length === 0 && d914[0].status === 'unknown' && d914[1].status === 'pending' && d914[1].claim == null,
      'P2b [RS] 舊 C6 因重啟暫停的自動批次（沒有版本紀錄）：C6.1 不自動續送（暫停待確認、未送出者釋放名額）；已交給 LINE 者維持結果待確認',
      JSON.stringify({ b: [b914.status, b914.pause_reason], d: d914.map((d) => [d.status, d.claim]), u13: calls(U(13)).length }));
    assert(bOr.status === 'expired' && bOr.pause_reason === 'legacy_unverified' && eOr.status === 'needs_review' && calls(U(14)).length === 0,
      'P2c [RS] 舊 C6「事件完成＋自動預覽未確認＋無 delivery」：升級後標為待店家確認並記錄原因，不以目前版本自動發送', JSON.stringify({ bOr, eOr }));
    // 升級後新的恢復販售正常：新登記收到 1 則；已受理者不重送
    await adm('PATCH', '/api/products/913/line-status', { sale_status: 'paused' });
    await reg(U(15), 913);
    await adm('PATCH', '/api/products/913/line-status', { sale_status: 'available' }); await idle();
    const nb = (await batchesOf(913)).find((b) => b.batch_uuid !== okBatch[0].batch_uuid) || {};
    const nbv = (await q('SELECT auto_epoch, auto_product_version FROM restock_notify_batches WHERE batch_uuid=?', [nb.batch_uuid || '']))[0] || {};
    assert(calls(U(15)).length === 1 && calls(U(10)).length === 1 && calls(U(11)).length === 1 && nb.source === 'auto' && nbv.auto_epoch != null && Number(nbv.auto_product_version) === 1,
      'P2d [RS] 升級後的新恢復販售：自動批次帶有版本，新登記收到 1 則，C6 時期已受理者不重送', JSON.stringify({ u15: calls(U(15)).length, nbv }));
    // 人工接手舊 C6 暫停批次：沿用原 retry key
    const keyU13 = d914[1].retry_key;
    const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${b914.batch_uuid}/resume`, {}); await idle();
    const used = calls(U(13)).map((c) => c.retry_key);
    const k12 = [...new Set(calls(U(12)).map((c) => c.retry_key))];
    const acc12 = calls(U(12)).filter((c) => c.result === 200).length;
    assert(rs.status === 200 && used.length === 1 && used[0] === keyU13 && k12.length === 1 && k12[0] === d914[0].retry_key && acc12 === 1,
      'P2e [RS] 店家明確續送舊 C6 批次（人工接手）：未送出者以原 retry key 送出 1 則；結果不明者只以同一 retry key 重試（LINE 回 409 已受理），唯一受理仍為 1',
      JSON.stringify({ rs: rs.status, used, u12_http: calls(U(12)).map((c) => c.result), u12_keys: k12.length }));
    void o2;
    await stop();

    // ═══════════════ P3：C6.1 → C5.4.2 → C6.1 ═══════════════
    await fresh('c61u3', H.ROOT);
    await start(H.ROOT);
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    const done3 = await autoBatch(916, [U(20), U(21)]);
    // 過時批次（送出中關閉再開啟）
    await adm('PATCH', '/api/product-demand-admin/restock/auto/products/917', { enabled: true });
    for (const u of [U(22), U(23)]) await reg(u, 917);
    fs.writeFileSync(gateFile('hold_' + U(22)), '1');
    await adm('PATCH', '/api/products/917/line-status', { sale_status: 'available' });
    await waitFile(gateFile('arrived_' + U(22)));
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: false }); await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    fs.writeFileSync(gateFile('release_' + U(22)), '1'); await idle();
    // 回退當下正在送出的自動批次（第一位已受理、回應未返回時以一般停止程序切換版本）
    await adm('PATCH', '/api/product-demand-admin/restock/auto/products/918', { enabled: true });
    for (const u of [U(24), U(25)]) await reg(u, 918);
    fs.writeFileSync(gateFile('hold_' + U(24)), '1');
    await adm('PATCH', '/api/products/918/line-status', { sale_status: 'available' });
    await waitFile(gateFile('arrived_' + U(24)));
    const o3 = await order('C6.1 訂單');
    const snap3 = await snapshot();
    await stop('SIGTERM');
    const snap3k = await snapshot();
    // ── 退回 C5.4.2 ──
    await start(R542);
    const snap3r = await snapshot();
    const p3 = preserved(snap3k, snap3r, Object.keys(TABLES));
    const b918r = (await q("SELECT status, pause_reason FROM restock_notify_batches WHERE product_id=918"))[0];
    await adm('PATCH', '/api/products/916/line-status', { sale_status: 'paused' });
    await reg(U(26), 916);
    await adm('PATCH', '/api/products/916/line-status', { sale_status: 'available' }); await idle(); await sleep(1500);
    const pvR = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 916, fulfillment_mode: 'takeout', supply_date: today });
    const ordR = (await q('SELECT id FROM orders WHERE id=?', [o3.uuid || o3.id]))[0];
    assert(!p3.lost.length && !p3.changed.length && !evidenceKept(snap3k, snap3r).length && calls(U(26)).length === 0 && calls(U(23)).length === 0 && calls(U(25)).length === 0
      && pvR.json.success && pvR.json.data.stats.eligible_count === 1 && b918r.status === 'paused' && ordR,
      'P3 [RS] C6.1 → 最新 C5.4.2：可啟動並讀取同一資料庫；資料、已受理證據與 retry key 全部保留；回退版本沒有自動功能 → 恢復販售不自動發送；送出中的自動批次停在暫停（不自動續送）；手動預覽可用（已受理者排除）',
      JSON.stringify({ lost: p3.lost.slice(0, 5), changed: p3.changed.slice(0, 5), b918: b918r, u26: calls(U(26)).length, eligible: pvR.json.data && pvR.json.data.stats.eligible_count }));
    await adm('PATCH', '/api/products/916/line-status', { sale_status: 'paused' });
    const snap3r2 = await snapshot();
    await stop();
    // ── 再升級 C6.1 ──
    await start(H.ROOT);
    const snap3u = await snapshot();
    const p3u = preserved(snap3r2, snap3u, Object.keys(TABLES));
    const cfg3 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data;
    const b917 = (await q('SELECT status, pause_reason FROM restock_notify_batches WHERE product_id=917'))[0];
    const d918 = await q("SELECT line_user_id, status FROM restock_notify_deliveries WHERE product_id=918 ORDER BY id");
    await adm('PATCH', '/api/products/916/line-status', { sale_status: 'available' }); await idle();
    assert(!p3u.lost.length && !p3u.changed.length && !evidenceKept(snap3r2, snap3u).length && cfg3.enabled === true && b917.status === 'paused' && b917.pause_reason === 'auto_epoch_stale' && calls(U(23)).length === 0
      && calls(U(26)).length === 1 && calls(U(20)).length === 1 && calls(U(21)).length === 1,
      'P3b [RS] 再升級 C6.1：資料保留、自動設定保留；過時批次仍不自動續送；新的恢復販售通知新登記 1 則，已受理者不重送',
      JSON.stringify({ lost: p3u.lost.slice(0, 5), changed: p3u.changed.slice(0, 5), en: cfg3.enabled, b917, u23: calls(U(23)).length, u26: calls(U(26)).length }));
    assert(calls(U(24)).length === 1 && d918[0].status === 'unknown' && d918[1].status === 'accepted' && calls(U(25)).length === 1,
      'P3c [RS] 回退時正在送出的自動批次：回退版本只暫停不續送；重新升級後版本仍有效 → 只續送從未交給 LINE 的項目（原 key，1 則），結果不明者不重送',
      JSON.stringify({ d: d918.map((d) => d.status), u24: calls(U(24)).length, u25: calls(U(25)).length }));
    void done3; void snap3;
    assert(mfRef.real() === 0, 'Z 真實 LINE 呼叫 0 次', JSON.stringify({ real: mfRef.real() }));
  } catch (e) { assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200) + (proc && proc.getLog ? '\n' + proc.getLog().slice(-800) : '')); }
  finally { await stop(); }
  const sum = H.summary();
  if (process.env.C61_RESULT_JSON) fs.writeFileSync(process.env.C61_RESULT_JSON, JSON.stringify({ suite: 'c6-1-upgrade-rollback', pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
