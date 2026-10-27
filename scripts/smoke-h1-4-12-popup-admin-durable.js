#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-admin-durable.js
// R44.2F.1：Popup 管理端／settings 的 durable mutation 代表性 disk-failure 測試。
// 真實 temp DB、真實 Express router、真實 HTTP、真實 JWT；fault 直接注入 fs（temp open/write/rename）。
// 每案驗證：固定 503、memory before-state、DB 檔 SHA-256/bytes 不變、fresh child process before-state、
// 無 temp 殘留、之後另一筆成功 save 不會復活失敗 mutation、retry 只生效一次。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 popup admin/settings durable (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-admin-durable-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-durable';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  let server;
  try {
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (101,'store_001','排骨飯','主食',120,1),(102,'store_001','珍珠奶茶','飲料',60,1)");
    db._save();
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/settings', require('../middleware/storeGuard').requireStore, require('../routes/settings'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const dbFile = process.env.POS_DB_PATH, dbDir = path.dirname(dbFile);
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env })).stdout.trim().split('\n').pop());
    const FAULTS = {
      write: () => { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; },
      rename: () => { const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; },
    };

    // fixtures（成功路徑本身也走 durable）
    const dbg = (l, r) => { if (r.status >= 300) console.log('[fixture-debug]', l, r.status, JSON.stringify(r.json).slice(0, 200)); return r; };
    const camp0 = 1; void camp0;
    const camp = dbg('campaign', await call('POST', '/api/popup-pickup/campaigns', { name: 'AdminDurable', status: 'published' }));
    const loc = dbg('location', await call('POST', '/api/popup-pickup/locations', { name: '地點A', address: '測試路1號', lat: 24.99, lng: 121.3 }));
    const sessBody = (name) => ({ campaign_id: camp.json.data.id, name, pickup_date: '2026-12-18', pickup_start_time: '17:30', pickup_end_time: '19:00', order_open_at: '2026-12-01T09:00', order_cutoff_at: '2026-12-17T21:00', location_id: loc.json.data.id, product_scope: 'selected', products: [{ product_id: 101, quota_qty: 10 }], max_orders: 50 });
    const sess = dbg('session', await call('POST', '/api/popup-pickup/sessions', sessBody('場次一')));
    assert(camp.status === 201 && loc.status === 201 && sess.status === 201, 'AD-fixture-created 管理端 fixture（campaign／location／session）透過 durable 路徑建立成功', `${camp.status}/${loc.status}/${sess.status}`);
    const fresh0 = (await freshDisk("SELECT COUNT(*) FROM popup_campaigns"))[0][0];
    assert(fresh0 === 1, 'AD-fixture-on-disk fixture 已 durable 寫入 disk（fresh process 讀得到）', String(fresh0));

    async function faultCase(label, fault, op, memSql, diskSql) {
      const memBefore = JSON.stringify(db.all(memSql)), h0 = fileSha(), b0 = fs.readFileSync(dbFile), diskBefore = JSON.stringify(await freshDisk(diskSql));
      const undo = FAULTS[fault](); let r; try { r = await op(); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj|tmp|\.db|\/tmp|SELECT|UPDATE|INSERT|at\s+\S+\.js/i.test(JSON.stringify(r.json)), `AD-${label}-${fault}-safe-503 固定 503 STORAGE_UNAVAILABLE，body 無 path／SQL／stack`, `${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
      assert(JSON.stringify(db.all(memSql)) === memBefore, `AD-${label}-${fault}-memory-before memory 維持 before-state`, '');
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0 && JSON.stringify(await freshDisk(diskSql)) === diskBefore, `AD-${label}-${fault}-disk-before DB 檔 SHA-256／bytes 不變，fresh process 讀回 before-state`, '');
      assert(tmpResidue().length === 0, `AD-${label}-${fault}-no-temp-residue temp 檔殘留 0`, tmpResidue().join(','));
      const other = await call('POST', '/api/popup-pickup/locations', { name: 'unrelated' + label + fault, address: 'x', lat: 25, lng: 121 });
      assert(other.status === 201 && JSON.stringify(db.all(memSql)) === memBefore && JSON.stringify(await freshDisk(diskSql)) === diskBefore, `AD-${label}-${fault}-not-resurrected 之後另一筆成功 save 不會復活失敗 mutation（memory／disk 皆維持 before-state）`, `status=${other.status}`);
      const retry = await op();
      assert(retry.status < 300 && JSON.stringify(await freshDisk(diskSql)) !== diskBefore && JSON.stringify(db.all(memSql)) !== memBefore, `AD-${label}-${fault}-retry-once retry 成功，memory 與 fresh process 一致地變成新狀態`, `status=${retry.status}`);
    }
    let n = 0;
    // 1) campaign create
    for (const fault of ['rename', 'write']) {
      const nm = 'C-' + (++n);
      await faultCase('campaign-create', fault, () => call('POST', '/api/popup-pickup/campaigns', { name: nm }), `SELECT COUNT(*) AS c FROM popup_campaigns WHERE name='${nm}'`, `SELECT COUNT(*) FROM popup_campaigns WHERE name='${nm}'`);
    }
    // 2) session update with revision（fault 不得推進 revision；retry 用同一個 expected_revision 成功一次）
    {
      const sid = sess.json.data.id; const rev = () => db.get('SELECT revision FROM popup_sessions WHERE id=?', [sid]).revision;
      const rev0 = rev(); const nm = 'S-renamed-' + (++n);
      await faultCase('session-update-revision', 'rename', () => call('PATCH', `/api/popup-pickup/sessions/${sid}`, { expected_revision: rev0, name: nm }), `SELECT name, revision FROM popup_sessions WHERE id='${sid}'`, `SELECT name, revision FROM popup_sessions WHERE id='${sid}'`);
      assert(rev() === rev0 + 1, 'AD-session-update-revision-advanced-once retry 只讓 revision 前進 1 次（失敗嘗試沒有偷偷 +1）', `${rev0} → ${rev()}`);
    }
    // 3) batch create（全有或全無）
    {
      const cnt = () => db.get("SELECT COUNT(*) AS c FROM popup_sessions WHERE name LIKE 'BATCH-%'").c;
      const one = (name, d) => ({ name, pickup_date: d, pickup_start_time: '17:30', pickup_end_time: '19:00', order_open_at: '2026-12-01T09:00', order_cutoff_at: '2026-12-17T21:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 20 });
      const body = { campaign_id: camp.json.data.id, sessions: [one('BATCH-1', '2026-12-20'), one('BATCH-2', '2026-12-21')] };
      const probe = await (async () => { const undo = FAULTS.rename(); try { return await call('POST', '/api/popup-pickup/sessions/batch', body); } finally { undo(); } })();
      assert(probe.status === 503 && cnt() === 0 && tmpResidue().length === 0, 'AD-batch-create-rename-all-or-nothing batch create 在 disk 失敗時 503，且 0 筆場次留在 memory（全有或全無）', `${probe.status} count=${cnt()} ${JSON.stringify(probe.json).slice(0, 100)}`);
      assert((await freshDisk("SELECT COUNT(*) FROM popup_sessions WHERE name LIKE 'BATCH-%'"))[0][0] === 0, 'AD-batch-create-rename-fresh-process fresh process 也看不到任何 batch 場次', '');
    }
    // 4) location soft-delete
    {
      const l2 = await call('POST', '/api/popup-pickup/locations', { name: '待刪除地點', address: 'z', lat: 25.1, lng: 121.1 });
      const lid = l2.json.data.id;
      await faultCase('location-soft-delete', 'rename', () => call('DELETE', `/api/popup-pickup/locations/${lid}`), `SELECT active FROM popup_locations WHERE id='${lid}'`, `SELECT active FROM popup_locations WHERE id='${lid}'`);
    }
    // 5) settings PUT popup_pickup_enabled
    {
      const val = () => (db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'") || {}).value || null;
      const v0 = val(); const want = v0 === '1' ? false : true;
      await faultCase('settings-popup-enabled', 'rename', () => call('PUT', '/api/settings', { popup_pickup_enabled: want }), "SELECT key, value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'", "SELECT key, value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      assert(val() === (want ? '1' : '0') || val() === String(want), 'AD-settings-value-after-retry retry 後 popup_pickup_enabled 為新值', String(val()));
    }
    assert(tmpResidue().length === 0, 'AD-final-no-residue 全程結束後無 temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
