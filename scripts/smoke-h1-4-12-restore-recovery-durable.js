#!/usr/bin/env node
// scripts/smoke-h1-4-12-restore-recovery-durable.js
// R44.2F.2：popup restore（prepare／supersede／commit）與 recovery token 狀態轉換（bound→opened、→expired）
// 的 durable disk-failure 測試。真實 temp DB、真實 Express router、真實 HTTP；fault 直接注入 fs。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 restore/recovery durable (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-restore-durable-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-restore-durable';
  const { initDb, getDb } = require('../utils/db'); await initDb(); const db = getDb();
  let server;
  try {
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [features]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','popup_pickup_enabled','1')");
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {} // 與 popup-recovery-cart-integration 的 fixture 相同：popup canonical cart 需要這個欄位
    db._save();
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target').createResolveTargetRouter());
    app.use('/api/cart-recovery', require('../routes/cart-recovery-popup-restore').createPopupRestoreRouter());
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const dbFile = process.env.POS_DB_PATH, dbDir = path.dirname(dbFile);
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env })).stdout.trim().split('\n').pop());
    const FAULTS = {
      write: () => { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; },
      rename: () => { const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; },
    };
    const TZ_OFFSET = 8 * 3600 * 1000; const dstr = (n) => { const d = new Date(Date.now() + TZ_OFFSET + n * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
    const camp = await call('POST', '/api/popup-pickup/campaigns', { name: 'RR活動' }, T1); await call('PATCH', `/api/popup-pickup/campaigns/${camp.json.data.id}`, { status: 'published' }, T1);
    const loc = await call('POST', '/api/popup-pickup/locations', { name: 'RR地點', address: 'x', lat: 25, lng: 121 }, T1);
    const sr = await call('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'RR場次', location_id: loc.json.data.id, product_scope: 'all_takeout', pickup_date: dstr(2), pickup_start_time: '10:00', pickup_end_time: '20:00', order_open_at: `${dstr(0)}T00:00`, order_cutoff_at: `${dstr(2)}T09:00` }, T1);
    await call('PATCH', `/api/popup-pickup/sessions/${sr.json.data.id}`, { expected_revision: sr.json.data.revision, status: 'published' }, T1);
    const sess = (await call('GET', `/api/popup-pickup/sessions/${sr.json.data.id}`, undefined, T1)).json.data;
    assert(!!sess && !!sess.public_code, 'RR-fixture-session popup 場次 fixture 建立並 published', JSON.stringify(sr).slice(0, 120));

    const { createRecoveryResumeToken, resolveRecoveryTargetForVerifiedMember } = require('../utils/lineCheckoutHandoff');
    const { createMemberSession } = require('../utils/lineMemberSession');
    let uSeq = 0;
    const mkToken = (state) => { // state: 'bound' | 'opened'
      const uid = 'URR' + Date.now() + (++uSeq);
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: uid, pageType: 'popup_order', popupSessionPublicCode: sess.public_code, cartQtyItems: [{ product_id: 1, qty: 2 }] });
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: uid });
      if (state === 'opened') { const r = resolveRecoveryTargetForVerifiedMember(db, created.token, ms); if (!r.ok) throw new Error('fixture resolve failed'); }
      return { token: created.token, ms, uid };
    };
    const tokRow = (tk) => db.get('SELECT status, IFNULL(opened_at,\'\') AS opened_at, IFNULL(consumed_at,\'\') AS consumed_at FROM line_cart_handoff_tokens WHERE token=?', [tk]);
    const tokDisk = async (tk) => JSON.stringify((await freshDisk(`SELECT status, IFNULL(opened_at,''), IFNULL(consumed_at,'') FROM line_cart_handoff_tokens WHERE token='${tk}'`))[0]);
    const rcpts = (tk) => db.all("SELECT status FROM popup_restore_receipts WHERE token_id=(SELECT id FROM line_cart_handoff_tokens WHERE token=?) ORDER BY id", [tk]).map((r) => r.status);
    const rcptDisk = async (tk) => JSON.stringify((await freshDisk(`SELECT status FROM popup_restore_receipts WHERE token_id=(SELECT id FROM line_cart_handoff_tokens WHERE token='${tk}') ORDER BY id`)).map((r) => r[0]));
    const prep = (tk, ms) => call('POST', '/api/cart-recovery/prepare-popup-restore', { recovery_token: tk, member_session: ms, popup_session_public_code: sess.public_code });
    const commit = (rc, ms) => call('POST', '/api/cart-recovery/commit-popup-restore', { restore_receipt: rc, member_session: ms, popup_session_public_code: sess.public_code });
    const resolve = (tk, ms) => call('POST', '/api/cart-recovery/resolve-target', { recovery_token: tk, member_session: ms });

    // 通用檢查：fault 下的狀態＝before；hash／bytes／fresh process／residue／不被之後的 save 復活
    async function faulted(label, fault, op, snap, diskSnap) {
      const before = JSON.stringify(snap()), h0 = fileSha(), b0 = fs.readFileSync(dbFile), d0 = JSON.stringify(await diskSnap());
      const undo = FAULTS[fault](); let r; try { r = await op(); } finally { undo(); }
      assert(JSON.stringify(snap()) === before, `RR-${label}-${fault}-memory-before memory 維持 before-state`, JSON.stringify({ before, now: snap() }));
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0 && JSON.stringify(await diskSnap()) === d0, `RR-${label}-${fault}-disk-before DB 檔 SHA-256／bytes 不變、fresh process 讀回 before-state`, '');
      assert(tmpResidue().length === 0, `RR-${label}-${fault}-no-temp-residue temp 檔殘留 0`, tmpResidue().join(','));
      await call('POST', '/api/popup-pickup/locations', { name: 'unrelated-' + label + fault, address: 'x', lat: 25, lng: 121 }, T1);
      assert(JSON.stringify(snap()) === before && JSON.stringify(await diskSnap()) === d0, `RR-${label}-${fault}-not-resurrected 之後另一筆成功 save 不會復活失敗的 mutation`, '');
      return r;
    }

    // ── prepare（write／rename）
    for (const fault of ['write', 'rename']) {
      const { token, ms } = mkToken('opened');
      const r = await faulted('prepare', fault, () => prep(token, ms), () => ({ t: tokRow(token), r: rcpts(token) }), async () => [await tokDisk(token), await rcptDisk(token)]);
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj|tmp|\.db/i.test(JSON.stringify(r.json)) && rcpts(token).length === 0 && tokRow(token).status === 'opened', `RR-prepare-${fault}-safe-503 prepare 固定 503、receipt 不存在、token 仍 opened、無 path 洩漏`, `${r.status} ${JSON.stringify(r.json)}`);
      const ok = await prep(token, ms);
      assert(ok.status === 200 && rcpts(token).join() === 'prepared' && (await rcptDisk(token)) === JSON.stringify(['prepared']), `RR-prepare-${fault}-retry-once retry 成功恰好一個 prepared receipt（memory＝fresh process）`, `status=${ok.status}`);
    }
    // ── supersede：已有 prepared receipt，再 prepare 失敗 → 舊 receipt 仍 prepared、新 receipt 不存在；retry → 恰好一個 prepared＋一個 superseded
    for (const fault of ['write', 'rename']) {
      const { token, ms } = mkToken('opened');
      const first = await prep(token, ms);
      assert(first.status === 200 && rcpts(token).join() === 'prepared', `RR-supersede-${fault}-fixture 已有一個 prepared receipt`, rcpts(token).join());
      const r = await faulted('supersede', fault, () => prep(token, ms), () => ({ r: rcpts(token) }), async () => [await rcptDisk(token)]);
      assert(r.status === 503 && rcpts(token).join() === 'prepared', `RR-supersede-${fault}-old-still-prepared disk 失敗後舊 receipt 仍 prepared、新 receipt 不存在（supersede 與新 receipt 同一個 commit）`, rcpts(token).join());
      const ok = await prep(token, ms);
      assert(ok.status === 200 && rcpts(token).join() === 'superseded,prepared' && (await rcptDisk(token)) === JSON.stringify(['superseded', 'prepared']) && rcpts(token).filter((s) => s === 'prepared').length === 1, `RR-supersede-${fault}-retry-exactly-one-prepared retry 後恰好一個 prepared（舊的 superseded），memory＝fresh process`, rcpts(token).join());
    }
    // ── commit：receipt consume ＋ token consume 同一個 durable commit
    for (const fault of ['write', 'rename']) {
      const { token, ms } = mkToken('opened');
      const p = await prep(token, ms); const rc = p.json.data.restore_receipt;
      const r = await faulted('commit', fault, () => commit(rc, ms), () => ({ t: tokRow(token), r: rcpts(token) }), async () => [await tokDisk(token), await rcptDisk(token)]);
      assert(r.status === 503 && rcpts(token).join() === 'prepared' && tokRow(token).status === 'opened' && tokRow(token).consumed_at === '', `RR-commit-${fault}-safe-503-before-state commit 固定 503、receipt 仍 prepared、token 仍 opened（未 consumed）`, `${r.status} ${rcpts(token).join()} ${JSON.stringify(tokRow(token))}`);
      const ok = await commit(rc, ms);
      assert(ok.status === 200 && rcpts(token).join() === 'consumed' && tokRow(token).status === 'consumed' && (await tokDisk(token)).includes('consumed') && (await rcptDisk(token)) === JSON.stringify(['consumed']), `RR-commit-${fault}-retry-once 同一 receipt retry 成功：receipt＋token 一起 consumed（memory＝fresh process）`, `status=${ok.status}`);
      // 既有 contract（Phase 3B 規格三 idempotency）：已 consumed 的 receipt 由同一位 verified user 重試 → 安全再回一次成功，
      // 不重複 consume（不再跑 UPDATE，也不改動任何 DB 檔）。
      const hReplay = fileSha(), consumedAt = tokRow(token).consumed_at;
      const replay = await commit(rc, ms);
      assert(replay.status === 200 && replay.json.success === true && rcpts(token).join() === 'consumed' && tokRow(token).consumed_at === consumedAt && fileSha() === hReplay, `RR-commit-${fault}-replay-contract 已 consumed 的 receipt replay 維持既有 idempotent contract（200 成功、不重複 consume、consumed_at 不變、DB 檔零變動）`, `${replay.status}`);
    }
    // ── bound→opened（resolve-target）
    // 注意：resolve-target 的既有 contract 是「所有失敗一律回 byte-identical 的 200 resolve_failed」（防枚舉），
    // 本輪不改；disk 失敗同樣回該固定失敗（fail closed，不是成功），狀態維持 before。
    for (const fault of ['write', 'rename']) {
      const { token, ms } = mkToken('bound');
      assert(tokRow(token).status === 'bound', `RR-boundopened-${fault}-fixture token 為 bound`, JSON.stringify(tokRow(token)));
      const r = await faulted('bound-opened', fault, () => resolve(token, ms), () => tokRow(token), async () => [await tokDisk(token)]);
      assert(r.json.success === false && r.json.reason === 'resolve_failed' && tokRow(token).status === 'bound' && tokRow(token).opened_at === '', `RR-boundopened-${fault}-fail-closed disk 失敗不回成功；memory／disk 仍 bound、opened_at 不變`, JSON.stringify(r.json));
      const ok = await resolve(token, ms);
      assert(ok.json.success === true && tokRow(token).status === 'opened' && tokRow(token).opened_at !== '' && (await tokDisk(token)).includes('opened'), `RR-boundopened-${fault}-retry-opened-once retry 後 opened 一次（memory＝fresh process）`, JSON.stringify(ok.json));
      const openedAt = tokRow(token).opened_at;
      const again = await resolve(token, ms);
      assert(again.json.success === true && tokRow(token).opened_at === openedAt, `RR-boundopened-${fault}-same-user-idempotent 同一使用者再次 resolve 冪等（opened_at 不變）`, '');
    }
    // wrong-user：零 state change
    {
      const { token } = mkToken('bound'); const other = createMemberSession({ store_id: 'store_001', line_user_id: 'UOTHER-WRONG' });
      const b = JSON.stringify(tokRow(token)), h = fileSha();
      const r = await resolve(token, other);
      assert(r.json.success === false && JSON.stringify(tokRow(token)) === b && fileSha() === h, 'RR-boundopened-wrong-user-zero-change 錯誤使用者：拒絕、token 與 DB 檔零變動（不轉 opened、不 save）', JSON.stringify(r.json));
    }
    // ── expired transition：resolve-target 會把過期 token 持久化成 expired；disk 失敗時不得只在 memory 變 expired
    for (const fault of ['write', 'rename']) {
      const { token, ms } = mkToken('bound');
      db._db.run("UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?", [token]); db._save();
      const r = await faulted('expired', fault, () => resolve(token, ms), () => tokRow(token), async () => [await tokDisk(token)]);
      assert(r.json.success === false && tokRow(token).status === 'bound', `RR-expired-${fault}-memory-not-expired disk 失敗時 memory 沒有單方面變 expired（仍 bound）`, JSON.stringify(tokRow(token)));
      const ok = await resolve(token, ms);
      assert(ok.json.success === false && tokRow(token).status === 'expired' && (await tokDisk(token)).includes('expired'), `RR-expired-${fault}-retry-persisted retry 後 expired 已 durable（memory＝fresh process）`, JSON.stringify(tokRow(token)));
    }
    assert(tmpResidue().length === 0, 'RR-final-no-residue 全程結束無 temp 殘留', tmpResidue().join(','));
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
