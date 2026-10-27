#!/usr/bin/env node
// scripts/smoke-h1-4-12-durable-popup-restore.js
// R44.2F.3A-2：popup restore prepare/supersede/commit + recovery expiry
// durable fault matrix。獨立 temp DB、獨立 server/port、真實 production
// route + helper（POST /api/cart-recovery/prepare-popup-restore、
// POST /api/cart-recovery/commit-popup-restore、resolve-target）。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 durable popup restore (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-durable-restore-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  const lch = require('../utils/lineCheckoutHandoff');
  const { createRecoveryResumeToken } = lch;
  let msMod; try { msMod = require('../utils/lineMemberSession'); } catch (e) { msMod = null; }
  assert(typeof (msMod && msMod.createMemberSession) === 'function', 'PREREQ-createMemberSession utils/lineMemberSession 必須匯出 createMemberSession（hard prerequisite，缺少即整個 suite FAIL，不 no-op）', msMod ? Object.keys(msMod).join(',') : 'module load failed');
  if (typeof (msMod && msMod.createMemberSession) !== 'function') { summary(); process.exit(1); }
  assert(typeof createRecoveryResumeToken === 'function', 'PREREQ-createRecoveryResumeToken utils/lineCheckoutHandoff 必須匯出 createRecoveryResumeToken', '');
  const { preparePopupRestore, commitPopupRestore } = require('../utils/popupRestore');
  assert(typeof preparePopupRestore === 'function' && typeof commitPopupRestore === 'function', 'PREREQ-popupRestore-helpers preparePopupRestore／commitPopupRestore 都必須是 function', '');
  let server;
  try {
    // ── fixture：store license、popup_pickup_enabled、非 draft 的 campaign/session ──
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','popup_pickup_enabled','1')");
    const campId = 'camp-restore-1', sessCode = 'RSTORE01';
    db._db.run("INSERT INTO popup_campaigns (id, store_id, public_code, name, status) VALUES (?, 'store_001', 'CAMPR1', 'RestoreCamp', 'published')", [campId]);
    db._db.run("INSERT INTO popup_sessions (id, store_id, campaign_id, public_code, name, status, pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at, product_scope, max_orders, revision) VALUES ('sess-restore-1', 'store_001', ?, ?, 'RestoreSess', 'published', '2026-12-25', '17:00', '19:00', '2026-01-01T00:00', '2026-12-24T23:59', 'all_takeout', 100, 1)", [campId, sessCode]);
    db._db.run("INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (6001, 'store_001', 'RestoreTestProduct', '主食', 80, 1)");
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
    app.use('/api/cart-recovery', require('../routes/cart-recovery-popup-restore').createPopupRestoreRouter());
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const dbFile = process.env.POS_DB_PATH, dbDir = path.dirname(dbFile);
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env, timeout: 15000 })).stdout.trim().split('\n').pop());
    const withFault = (kind) => {
      if (kind === 'write') { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; }
      const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; };
    };
    let uidCounter = 0;
    async function makeOpenedToken() {
      const lineUid = 'U_restore_' + (++uidCounter) + '_' + Math.random().toString(36).slice(2, 6);
      const ms = msMod.createMemberSession({ store_id: 'store_001', line_user_id: lineUid });
      const rt = createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-restore', lineUserId: lineUid, cartQtyItems: [{ product_id: 6001, qty: 2 }], pageType: 'popup_order', popupSessionPublicCode: sessCode });
      if (!rt.ok) throw new Error('createRecoveryResumeToken failed: ' + JSON.stringify(rt));
      const r = await call('/api/cart-recovery/resolve-target', { recovery_token: rt.token, member_session: ms });
      if (!(r.status === 200 && r.json.success)) throw new Error('resolve-target failed to reach opened: ' + JSON.stringify(r));
      return { token: rt.token, ms, lineUid };
    }
    const tokenRow = (t) => db.get('SELECT status, opened_at, consumed_at FROM line_cart_handoff_tokens WHERE token=?', [t]);
    const receiptRow = (hash) => db.get('SELECT status, issued_at, consumed_at, token_id FROM popup_restore_receipts WHERE receipt_hash=?', [hash]);
    const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
    const receiptCountForToken = (tokenStr) => {
      const trow = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [tokenStr]);
      return db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c;
    };
    const activePreparedCountForToken = (tokenStr) => {
      const trow = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [trow ? trow.id : null]);
      return 0; // placeholder unused
    };

    // ══════════════════════════════════════════════════════════════
    // Reality Audit（記錄於此，非事後補寫）：
    //   1. before→after： bound → opened（resolve-target）→ prepare 建立
    //      prepared receipt（token 仍 opened，未變動）→ commit 讓 receipt
    //      與 token 在同一交易一起轉 consumed。
    //   2. 同一 durable commit：prepare 內「舊 receipt→superseded」與
    //      「新 receipt→prepared」同一交易；commit 內「receipt→consumed」
    //      與「token→consumed」同一交易（都用 db.runDurableTransaction()）。
    //   3. 折疊成固定回應：prepare 除了 invalid_snapshot（結構性 400）之外，
    //      所有其他業務失敗（not_found／expired／consumed／uid_mismatch／
    //      invalid_status／popup_session_mismatch...）一律 401
    //      {success:false,reason:'prepare_failed'}；commit 全部業務失敗
    //      折疊成 401 {reason:'commit_failed'}。disk 失敗兩者都是獨立的
    //      503 {error:'STORAGE_UNAVAILABLE'}，不與業務失敗混在一起。
    //   4. side effect：這兩個 route 目前完全沒有 broadcast／webhook／
    //      analytics／通知呼叫（已讀完整個 route 檔案與 helper 檔案確認），
    //      沒有「durable success 之後才發生」的東西需要驗證。
    //   5. expiry：_resolveTokenRowForPopupRestore() 在 prepare 入口用
    //      _isExpired() 判斷；若過期且目前狀態不是 'expired'，會呼叫
    //      db.runDurableTransaction() 把它「持久化」轉成 status='expired'
    //      （不是單純查詢判斷，是 lazy persisted transition，在 prepare
    //      被呼叫的當下才觸發，不是背景 job）。
    // ══════════════════════════════════════════════════════════════

    // ── A. Prepare 正向控制 ──────────────────────────────────────
    let firstReceipt, firstToken;
    {
      const { token, ms } = await makeOpenedToken();
      firstToken = token;
      const before = tokenRow(token);
      const r = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      assert(r.status === 200 && r.json.success === true && typeof r.json.data.restore_receipt === 'string', 'A-prepare-succeeds 真實 prepare-popup-restore 成功、回傳 restore_receipt', JSON.stringify(r).slice(0, 200));
      firstReceipt = r.json.data.restore_receipt;
      const rr = receiptRow(sha256(firstReceipt));
      assert(rr && rr.status === 'prepared', 'A-receipt-prepared receipt 真實狀態為 prepared', JSON.stringify(rr));
      assert(JSON.stringify(tokenRow(token)) === JSON.stringify(before), 'A-token-unchanged-by-prepare prepare 完全不改動 token 狀態（仍 opened，未變動）', JSON.stringify({ before, after: tokenRow(token) }));
      const fresh = await freshDisk(`SELECT status FROM popup_restore_receipts WHERE receipt_hash='${sha256(firstReceipt)}'`);
      assert(fresh[0] && fresh[0][0] === 'prepared', 'A-fresh-process fresh child process 讀到 prepared receipt', JSON.stringify(fresh));
      // 重複呼叫 prepare（同一個 opened token）：真實契約 = 視為 supersede（下一區塊驗證），這裡先記錄第一次呼叫的行為已如上。
    }

    // ── B. Supersede（對同一個 opened token 再次 prepare）──────────
    {
      const beforeFirst = receiptRow(sha256(firstReceipt));
      assert(beforeFirst.status === 'prepared', 'B-prereq-old-still-prepared prerequisite：舊 receipt 目前仍是 prepared', JSON.stringify(beforeFirst));
      const { ms } = { ms: msMod.createMemberSession({ store_id: 'store_001', line_user_id: db.get('SELECT line_user_id FROM line_cart_handoff_tokens WHERE token=?', [firstToken]).line_user_id }) };
      const r2 = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: firstToken, member_session: ms, popup_session_public_code: sessCode });
      assert(r2.status === 200 && r2.json.success === true, 'B-second-prepare-succeeds 對同一 opened token 再次 prepare 成功（真實 supersede 觸發）', JSON.stringify(r2).slice(0, 150));
      const secondReceipt = r2.json.data.restore_receipt;
      assert(receiptRow(sha256(firstReceipt)).status === 'superseded', 'B-old-superseded 舊 receipt 真實轉為 superseded', JSON.stringify(receiptRow(sha256(firstReceipt))));
      assert(receiptRow(sha256(secondReceipt)).status === 'prepared', 'B-new-prepared 新 receipt 為 prepared', JSON.stringify(receiptRow(sha256(secondReceipt))));
      const trow = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [firstToken]);
      const activeCount = db.get("SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=? AND status='prepared'", [trow.id]).c;
      assert(activeCount === 1, 'B-exactly-one-active-prepared 同一 token 下恰好 1 筆 active prepared receipt（契約：最多 1 筆）', String(activeCount));
      firstReceipt = secondReceipt; // 後續 commit 測試用這張目前有效的 receipt
    }

    // ── C. Commit 正向控制 + idempotent replay ───────────────────
    {
      const trow = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=?', [firstToken]);
      const ms = msMod.createMemberSession({ store_id: 'store_001', line_user_id: trow.line_user_id });
      const r = await call('/api/cart-recovery/commit-popup-restore', { restore_receipt: firstReceipt, member_session: ms, popup_session_public_code: sessCode });
      assert(r.status === 200 && r.json.success === true && r.json.data.consumed === true, 'C-commit-succeeds 真實 commit-popup-restore 成功', JSON.stringify(r).slice(0, 150));
      assert(receiptRow(sha256(firstReceipt)).status === 'consumed' && tokenRow(firstToken).status === 'consumed', 'C-receipt-and-token-consumed receipt 與 token 都真實轉為 consumed（同一交易）', JSON.stringify({ r: receiptRow(sha256(firstReceipt)), t: tokenRow(firstToken) }));
      const fresh = await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${firstToken}'`);
      assert(fresh[0][0] === 'consumed', 'C-fresh-process fresh child process 讀到 token=consumed', JSON.stringify(fresh));
      // idempotent replay
      const r2 = await call('/api/cart-recovery/commit-popup-restore', { restore_receipt: firstReceipt, member_session: ms, popup_session_public_code: sessCode });
      assert(r2.status === 200 && r2.json.success === true && r2.json.data.consumed === true, 'C-replay-idempotent 同一張已 consumed 的 receipt 重複 commit：真實冪等契約（安全回成功，不重複消費）', JSON.stringify(r2).slice(0, 150));
    }

    // ══════════════════════════════════════════════════════════════
    // 四：durable fault matrix（prepare／supersede／commit，各 write+rename）
    // ══════════════════════════════════════════════════════════════
    async function faultPrepare(label, faultKind) {
      const { token, ms } = await makeOpenedToken();
      const before = tokenRow(token), h0 = fileSha(), b0 = fs.readFileSync(dbFile);
      const trow = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [token]);
      const receiptCountBefore = db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c;
      const diskBefore = await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${token}'`);
      const undo = withFault(faultKind);
      let r; try { r = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode }); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj|tmp|\.db|SELECT|UPDATE|INSERT|at\s+\S+\.js/i.test(JSON.stringify(r.json)), `D-prepare-${label}-503 固定 503 STORAGE_UNAVAILABLE，無 SQL／path／stack 洩漏`, JSON.stringify(r).slice(0, 150));
      assert(db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c === receiptCountBefore, `D-prepare-${label}-no-new-receipt 沒有新 receipt 被建立`, '');
      assert(JSON.stringify(tokenRow(token)) === JSON.stringify(before), `D-prepare-${label}-token-unchanged token 維持 before-state（仍 opened）`, JSON.stringify({ before, after: tokenRow(token) }));
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `D-prepare-${label}-disk-unchanged DB 檔 SHA-256／bytes 不變`, '');
      assert(JSON.stringify(await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${token}'`)) === JSON.stringify(diskBefore), `D-prepare-${label}-fresh-unchanged fresh process 讀回 before-state`, '');
      assert(tmpResidue().length === 0, `D-prepare-${label}-no-residue 無 temp 殘留`, '');
      const retry = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      assert(retry.status === 200 && retry.json.success === true, `D-prepare-${label}-retry-once 移除 fault 後 retry 成功`, JSON.stringify(retry).slice(0, 120));
      assert(db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c === receiptCountBefore + 1, `D-prepare-${label}-retry-exactly-one-receipt retry 後恰好新增 1 筆 receipt（沒有重複）`, '');
    }
    await faultPrepare('write', 'write');
    await faultPrepare('rename', 'rename');

    async function faultSupersede(label, faultKind) {
      const { token, ms } = await makeOpenedToken();
      const ok1 = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      const oldReceiptHash = sha256(ok1.json.data.restore_receipt);
      const trow = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [token]);
      const receiptCountBefore = db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c;
      const oldBefore = receiptRow(oldReceiptHash), h0 = fileSha(), b0 = fs.readFileSync(dbFile);
      const undo = withFault(faultKind);
      let r; try { r = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode }); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE', `D-supersede-${label}-503 supersede（第二次 prepare）disk 失敗回 503`, JSON.stringify(r).slice(0, 120));
      assert(receiptRow(oldReceiptHash).status === 'prepared', `D-supersede-${label}-old-still-prepared 舊 receipt 仍是 prepared（沒有被 superseded）`, JSON.stringify(receiptRow(oldReceiptHash)));
      assert(db.get('SELECT COUNT(*) AS c FROM popup_restore_receipts WHERE token_id=?', [trow.id]).c === receiptCountBefore, `D-supersede-${label}-no-new-receipt 新 receipt 沒有被建立——不會出現「舊已 superseded、新未建立」的半套狀態`, '');
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `D-supersede-${label}-disk-unchanged DB 檔不變`, '');
      const retry = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      assert(retry.status === 200 && receiptRow(oldReceiptHash).status === 'superseded' && receiptRow(sha256(retry.json.data.restore_receipt)).status === 'prepared', `D-supersede-${label}-retry-once retry 成功後：舊 superseded、新 prepared`, '');
    }
    await faultSupersede('write', 'write');
    await faultSupersede('rename', 'rename');

    async function faultCommit(label, faultKind) {
      const { token, ms } = await makeOpenedToken();
      const pr = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      const receiptHash = sha256(pr.json.data.restore_receipt);
      const rBefore = receiptRow(receiptHash), tBefore = tokenRow(token), h0 = fileSha(), b0 = fs.readFileSync(dbFile);
      const undo = withFault(faultKind);
      let r; try { r = await call('/api/cart-recovery/commit-popup-restore', { restore_receipt: pr.json.data.restore_receipt, member_session: ms, popup_session_public_code: sessCode }); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE', `D-commit-${label}-503 commit disk 失敗回 503`, JSON.stringify(r).slice(0, 120));
      assert(JSON.stringify(receiptRow(receiptHash)) === JSON.stringify(rBefore) && JSON.stringify(tokenRow(token)) === JSON.stringify(tBefore), `D-commit-${label}-both-unchanged receipt 與 token 都維持 before-state（沒有半完成）`, JSON.stringify({ r: receiptRow(receiptHash), t: tokenRow(token) }));
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `D-commit-${label}-disk-unchanged DB 檔不變`, '');
      assert(tmpResidue().length === 0, `D-commit-${label}-no-residue 無 temp 殘留`, '');
      const retry = await call('/api/cart-recovery/commit-popup-restore', { restore_receipt: pr.json.data.restore_receipt, member_session: ms, popup_session_public_code: sessCode });
      assert(retry.status === 200 && retry.json.success === true, `D-commit-${label}-retry-once retry 成功一次`, JSON.stringify(retry).slice(0, 120));
      assert(receiptRow(receiptHash).status === 'consumed' && tokenRow(token).status === 'consumed', `D-commit-${label}-final-consumed retry 後 receipt／token 都是 consumed，只完成一次`, '');
    }
    await faultCommit('write', 'write');
    await faultCommit('rename', 'rename');

    // ── Expiry：lazy persisted transition，經真實 prepare 入口觸發 ──
    {
      const { token, ms } = await makeOpenedToken();
      // 尚未過期：prepare 應該正常工作（不會被誤判過期）
      const beforeExpiry = tokenRow(token);
      assert(beforeExpiry.status === 'opened', 'E-not-yet-expired 到期前 token 仍是 opened（未被提前轉換）', JSON.stringify(beforeExpiry));
      // 手動把 expires_at 設成過去，模擬「已到期但尚未被任何請求觸發持久化」的真實中間狀態
      db._db.run("UPDATE line_cart_handoff_tokens SET expires_at=datetime('now','localtime','-1 day') WHERE token=?", [token]); db._save();
      const h0 = fileSha(); const undo = withFault('rename');
      let r; try { r = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode }); } finally { undo(); }
      // _resolveTokenRowForPopupRestore 的 expired-transition 用的也是 runDurableTransaction；disk 失敗時應該一樣 503、狀態不得半更新（不能停在「查詢認定過期但沒寫入」跟「已寫入 expired」中間的任何不一致，只能是 opened 或 expired 兩者之一，且要跟 disk 一致）。
      assert(r.status === 503, 'E-expiry-disk-fail-503 expiry transition 的 disk 失敗同樣回 503（未讓 client 誤以為過期判定已完成）', JSON.stringify(r).slice(0, 120));
      const afterFaultMem = tokenRow(token);
      const afterFaultDisk = (await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${token}'`))[0][0];
      assert(afterFaultMem.status === afterFaultDisk, 'E-expiry-disk-fail-consistent disk 失敗後 memory 與 disk 狀態彼此一致（不是「memory 已轉 expired 但 disk 沒轉」的分裂狀態）', JSON.stringify({ mem: afterFaultMem.status, disk: afterFaultDisk }));
      assert(fileSha() === h0, 'E-expiry-disk-fail-hash-unchanged disk 失敗後 DB 檔 hash 不變', '');
      const retry = await call('/api/cart-recovery/prepare-popup-restore', { recovery_token: token, member_session: ms, popup_session_public_code: sessCode });
      assert(retry.status === 401 && retry.json.reason === 'prepare_failed', 'E-expiry-retry-rejected 移除 fault 後 retry：token 真的過期，prepare 被拒絕（折疊成固定 prepare_failed，不洩漏是因為過期）', JSON.stringify(retry));
      assert(tokenRow(token).status === 'expired', 'E-expiry-persisted-once retry 後 token 真的被持久化轉成 expired（該次請求成功寫入）', JSON.stringify(tokenRow(token)));
    }

    assert(tmpResidue().length === 0, 'FINAL-no-temp-residue 全程結束後無 temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
