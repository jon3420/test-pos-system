#!/usr/bin/env node
// scripts/smoke-h1-4-12-durable-cart-recovery.js
// R44.2F.3A：Cart-token durable fault matrix + bound→opened durability，
// 完全隔離的獨立 suite（自己的 temp DB、自己的 server/port、自己的商品，
// 不依賴主套件的共享 fixture 或執行順序）。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 durable cart/recovery (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-durable-cart-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-durable-cart';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  const { createCartHandoffToken, createRecoveryResumeToken, bindTokenToLineUser } = require('../utils/lineCheckoutHandoff');
  let server;
  try {
    const PID = 5001; // 本 suite 專用商品，不與其他 suite 共享
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (${PID}, 'store_001', 'DurableCartTestProduct', '主食', 100, 1)`);
    db._db.run(`UPDATE products SET show_on_line=1, sale_status='available', line_quota_enabled=1, line_quota_daily=100000 WHERE id=?`, [PID]);
    const ING = 5901;
    db._db.run(`DELETE FROM ingredients WHERE id=?`, [ING]);
    db._db.run(`INSERT INTO ingredients (id, store_id, name, unit, total_stock, refrigerated_stock, frozen_stock, thawing_stock) VALUES (?, 'store_001', 'DurableCartIngredient', 'g', 1000000, 1000000, 0, 0)`, [ING]);
    db._db.run(`DELETE FROM product_ingredient_formulas WHERE product_id=?`, [PID]);
    db._db.run(`INSERT INTO product_ingredient_formulas (product_id, ingredient_id, amount_per_unit) VALUES (?, ?, 2)`, [PID, ING]);
    // Reality Audit（R44.2F.3B Gate Repair）：這裡沿用 scripts/smoke-h1-4-12-
    // popup-public-checkout.js 已經驗證過的同一套 fixture——真正擋下今日
    // standard LINE 單的權威不是 takeout_cutoff_time，而是 utils/db.js
    // initDb() 幫 demo 店種的 takeout_business_hours 每週營業時間
    // （mon~sat close:'20:00'）。getEffectiveCutoffMins() 取
    // schedule.end（來自 bizHours）與 todayCutoff 兩者較早者。用正式
    // settings 機制（同一個 takeout_business_hours key）把每天都設成
    // 00:00–23:59，等同真實店家設定「24 小時營業」，不是繞過 authority、
    // 不是改系統時間、不是 monkeypatch production 函式。
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({
      mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true },
      wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true },
      fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true },
      sun: { open: '00:00', close: '23:59', enabled: true },
    })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    const { requireStore } = require('../middleware/storeGuard'); const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), require('../routes/line-orders'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}), body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const dbFile = process.env.POS_DB_PATH, dbDir = path.dirname(dbFile);
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env, timeout: 15000 })).stdout.trim().split('\n').pop());
    const FAULTS = {
      write: () => { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; },
      rename: () => { const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; },
    };
    const tokenRow = (t) => db.get('SELECT status, consumed_at, order_id FROM line_cart_handoff_tokens WHERE token=?', [t]);
    const orderCount = (phone) => db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [phone]).c;

    // ══════════════════════════════════════════════════════════════
    // Reality Audit（本輪的根因）：consumeCartTokenInTransaction() 只消費
    // token（見 utils/lineCheckoutHandoff.js），不會用 token 的 cart_json
    // 覆蓋 request.items——standard order 的 items 完全來自 client 這次真正
    // 送出的 body.items。上一輪的「商品「undefined」已下架」不是 token
    // 機制的問題，是共用大套件裡某個先前測試把共用商品 301 的 sale_status
    // 改壞、且沒有在同一輪次還原乾淨所致（product 隔離、獨立 suite 即可
    // 避開，不需要改 production）。
    // ══════════════════════════════════════════════════════════════

    // ── 一：Positive control（沒有任何 fault）──────────────────────
    let ctrlOrderId;
    {
      const ct = createCartHandoffToken(db, 'store_001', { cartQtyItems: [{ product_id: PID, qty: 2 }], checkoutContext: { order_type: 'takeout' }, attribution: {}, createdIp: '', createdUserAgent: '' });
      assert(ct && ct.token, 'PC-token-created production helper 建立 checkout token 成功', JSON.stringify(ct));
      const raw = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=?', [ct.token]);
      const cart = JSON.parse(raw.cart_json);
      assert(cart.items[0].product_id === PID && cart.items[0].qty === 2 && raw.store_id === 'store_001', 'PC-token-schema token 的 cart_json 裡 product_id/qty/store_id 正確', JSON.stringify(raw));
      const prod = db.get('SELECT enabled, show_on_line, sale_status FROM products WHERE id=?', [PID]);
      assert(prod.enabled === 1 && prod.show_on_line === 1 && prod.sale_status === 'available', 'PC-product-eligible 商品 enabled/show_on_line/sale_status 全部合格（line_takeout_enabled 未設定時，production code 用 ?? 1 fallback 視為啟用，不需要顯式設定這個 optional 欄位）', JSON.stringify(prod));
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]);
      const r = await call('POST', '/api/line-orders', { customer_name: 'PC', customer_phone: '0955300001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }], cart_token: ct.token }, T1);
      const httpOk = r.status === 200 || r.status === 201;
      assert(httpOk, 'PC-order-succeeds positive control：真實 Standard LINE order 建立成功', `status=${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
      // R44.2F.3B Gate Repair：hard prerequisite，不得 optional-chain 或
      // soft-skip 過去——HTTP 成功與 order row 實際存在都必須先確認，才能
      // 繼續往下讀 order.id、繼續 fault matrix。任一項不成立就輸出去敏
      // response 並讓 suite 正常結束為 FAIL（不是未預期的 undefined
      // TypeError）。
      const ctrlOrderRow = httpOk ? db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955300001']) : undefined;
      const rowExists = !!ctrlOrderRow;
      assert(rowExists, 'PC-order-row-exists prerequisite：order row 真實存在於 DB（不只是 HTTP 回 2xx）', httpOk ? 'order row not found after 2xx response' : `blocked before row check: status=${r.status} reason=${(r.json && r.json.reason) || 'n/a'}`);
      if (!httpOk || !rowExists) {
        assert(false, 'PC-prerequisite-failed-stopping positive control 前提不成立，正常結束 suite 為 FAIL，不繼續 fault matrix（避免用壞掉的 baseline 產生假陽性）', `httpOk=${httpOk} rowExists=${rowExists}`);
        summary();
        return;
      }
      assert(orderCount('0955300001') === 1, 'PC-exactly-one-order 恰好 1 張 order', String(orderCount('0955300001')));
      ctrlOrderId = ctrlOrderRow.id;
      assert(tokenRow(ct.token).status === 'consumed' && tokenRow(ct.token).order_id === ctrlOrderId, 'PC-token-consumed-once token 恰好被消費一次，order_id 正確關聯', JSON.stringify(tokenRow(ct.token)));
    }

    // ── 二：Cart-token fault matrix ─────────────────────────────
    function mkToken(qty) { return createCartHandoffToken(db, 'store_001', { cartQtyItems: [{ product_id: PID, qty }], checkoutContext: { order_type: 'takeout' }, attribution: {}, createdIp: '', createdUserAgent: '' }).token; }
    async function faultCase(label, pattern, opts, phone, qty) {
      const tok = mkToken(qty);
      const before = tokenRow(tok), q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v, h0 = fileSha(), b0 = fs.readFileSync(dbFile), diskBefore = await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${tok}'`);
      let triggerCount = 0; const origRaw = db._db.run.bind(db._db); const origRun = db.run.bind(db);
      db._db.run = function (sql, params) { if (typeof sql === 'string' && sql.includes(pattern)) { triggerCount++; if (triggerCount === (opts.nth || 1)) throw new Error('R44.2F.3A injected fault'); } return origRaw(sql, params); };
      let r; try { r = await call('POST', '/api/line-orders', { customer_name: 'F' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty }], cart_token: tok }, T1); }
      finally { delete db._db.run; db.run = origRun; }
      assert(triggerCount >= 1, `FM-${label}-seam-hit seam（${pattern}）真的被觸發`, String(triggerCount));
      assert(r.status >= 400 && !/at\s+\S+\.js:\d+|node_modules|SELECT|UPDATE|INSERT|token=/i.test(JSON.stringify(r.json)), `FM-${label}-safe-error 真實非成功 response，且無 SQL／stack／token 內容洩漏`, `${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
      assert(orderCount(phone) === 0, `FM-${label}-no-order order 不存在`, '');
      assert(JSON.stringify(tokenRow(tok)) === JSON.stringify(before), `FM-${label}-token-unchanged token 狀態／timestamps 完全不變`, JSON.stringify({ before, after: tokenRow(tok) }));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, `FM-${label}-counter-unchanged counter 不變`, '');
      if (pattern.includes('rename') || pattern.includes('write') || label.includes('disk')) {
        assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `FM-${label}-disk-unchanged DB 檔 SHA-256／bytes 不變`, '');
        assert(JSON.stringify(await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${tok}'`)) === JSON.stringify(diskBefore), `FM-${label}-fresh-process-unchanged fresh process 讀回 token 狀態不變`, '');
      }
      const other = await call('POST', '/api/line-orders', { customer_name: 'Other', customer_phone: '0955300' + Math.floor(Math.random() * 900 + 100), order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }] }, T1);
      assert((other.status === 200 || other.status === 201) && JSON.stringify(tokenRow(tok)) === JSON.stringify(before), `FM-${label}-not-resurrected 另一筆成功 save 後，失敗的 token mutation 不會被復活`, `status=${other.status}`);
      const retry = await call('POST', '/api/line-orders', { customer_name: 'Retry' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty }], cart_token: tok }, T1);
      assert((retry.status === 200 || retry.status === 201) && orderCount(phone) === 1 && tokenRow(tok).status === 'consumed', `FM-${label}-retry-once 移除 fault 後 retry 成功一次，token 恰好消費一次`, `status=${retry.status}`);
    }
    await faultCase('A-token-mutation', "UPDATE line_cart_handoff_tokens SET status='consumed'", {}, '0955300010', 1);
    await faultCase('B-counter-after-token', 'UPDATE products SET line_quota_sold', {}, '0955300011', 1);
    await faultCase('C-ingredient-after-token', 'UPDATE ingredients SET', {}, '0955300012', 1); // 本商品無 ingredient formula，此為控制案例：seam 不會命中，counter/order 仍應正確 rollback via 其他 fault path 已於 A/B 驗證；這裡改測 disk fault D 覆蓋同等風險
    async function diskFaultCase(label, faultName, phone, qty) {
      const tok = mkToken(qty);
      const before = tokenRow(tok), h0 = fileSha(), b0 = fs.readFileSync(dbFile), diskBefore = await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${tok}'`);
      const undoRename = faultName === 'write' ? (() => { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; })() : (() => { const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; })();
      let r; try { r = await call('POST', '/api/line-orders', { customer_name: 'D' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty }], cart_token: tok }, T1); } finally { undoRename(); }
      assert(r.status === 503, `FM-D-${label}-503 disk failure（${faultName}）回固定 503`, `status=${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
      assert(orderCount(phone) === 0 && JSON.stringify(tokenRow(tok)) === JSON.stringify(before) && fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `FM-D-${label}-all-before-state order／token／disk 全部維持 before-state`, '');
      assert(JSON.stringify(await freshDisk(`SELECT status FROM line_cart_handoff_tokens WHERE token='${tok}'`)) === JSON.stringify(diskBefore) && tmpResidue().length === 0, `FM-D-${label}-fresh-and-no-residue fresh process 一致、無 temp 殘留`, '');
      const retry = await call('POST', '/api/line-orders', { customer_name: 'D' + label, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty }], cart_token: tok }, T1);
      assert((retry.status === 200 || retry.status === 201) && orderCount(phone) === 1 && tokenRow(tok).status === 'consumed', `FM-D-${label}-retry-once retry 成功一次`, `status=${retry.status}`);
    }
    await diskFaultCase('write', 'write', '0955300020', 1);
    await diskFaultCase('rename', 'rename', '0955300021', 1);

    // ── E：Replay（已成功消費的 token 再送一次）──────────────────
    {
      const tok = mkToken(1);
      const first = await call('POST', '/api/line-orders', { customer_name: 'E1', customer_phone: '0955300030', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }], cart_token: tok }, T1);
      assert(first.status === 200 || first.status === 201, 'FM-E-first-succeeds 第一次成功消費 token', `status=${first.status}`);
      const afterFirst = tokenRow(tok);
      const r2 = await call('POST', '/api/line-orders', { customer_name: 'E1', customer_phone: '0955300030', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }], cart_token: tok }, T1);
      assert((r2.status === 200 || r2.status === 201) && orderCount('0955300030') === 2 && JSON.stringify(tokenRow(tok)) === JSON.stringify(afterFirst), 'FM-E-replay-no-double-consume replay：既有 contract 允許再次下單（token 已消費不阻擋訂單），但 token 本身狀態不再變動（不是消費兩次）', JSON.stringify(tokenRow(tok)));
    }

    // ══════════════════════════════════════════════════════════════
    // 六：Recovery bound→opened —— Reality Audit 更正：resolve-target.js
    // 對所有失敗情況（含內部例外／DurableCommitError）一律回 200
    // {success:false, reason:'resolve_failed'}（byte-identical、不可枚舉），
    // 不是 503。這是這個端點刻意設計的安全 contract（見 route 檔案內
    // 註解「規格四」），不是本輪要修正的目標；下面依真實 contract 驗證。
    // ══════════════════════════════════════════════════════════════
    // R44.2F.3B Gate Repair 稽核發現（第二個真實、獨立於本輪主題的
    // pre-existing bug）：本檔案原本呼叫的是 signMemberSession，但
    // utils/lineMemberSession.js 實際匯出的函式名稱是
    // createMemberSession（接受單一 { store_id, line_user_id } 物件，
    // 不是兩個位置參數）——這個名稱錯誤導致 canSignMemberSession 永遠
    // 是 false，bound→opened 整段從建立這個 isolated suite 以來從未真正
    // 執行過，每次都被下面的 soft-skip fallback 悄悄蓋掉，之前回報的
    // 「39/39 含 bound→opened」是錯的。這裡改成 hard prerequisite（缺少
    // 就整個 suite FAIL，不 no-op），並修正正確的函式名稱與呼叫方式。
    const msFn = require('../utils/lineMemberSession');
    assert(typeof msFn.createMemberSession === 'function', 'PREREQ-createMemberSession utils/lineMemberSession 必須匯出 createMemberSession（hard prerequisite，缺少即整個 suite FAIL，不 no-op；先前錯誤呼叫 signMemberSession 導致這整段測試被悄悄跳過）', Object.keys(msFn).join(','));
    if (typeof msFn.createMemberSession !== 'function') { summary(); return; }
    {
      const lineUid = 'U_R44F3A_' + Math.random().toString(36).slice(2, 8);
      const ms = msFn.createMemberSession({ store_id: 'store_001', line_user_id: lineUid });
      const rt = createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-r44f3a', lineUserId: lineUid, cartQtyItems: [{ product_id: PID, qty: 1 }], pageType: 'line_order' });
      assert(rt.ok, 'BO-token-created recovery resume token 建立成功', JSON.stringify(rt));
      const bindRow = () => db.get('SELECT status, opened_at, line_user_id FROM line_cart_handoff_tokens WHERE token=?', [rt.token]);
      assert(bindRow().status === 'bound' && bindRow().line_user_id === lineUid, 'BO-initial-bound token 初始狀態為 bound，line_user_id 正確', JSON.stringify(bindRow()));
      // disk write failure：resolve-target 回 200 resolve_failed（真實 contract），token 仍 bound
      const before = bindRow(); const undo = FAULTS.rename();
      let r; try { r = await call('POST', '/api/cart-recovery/resolve-target', { recovery_token: rt.token, member_session: ms }); } finally { undo(); }
      assert(r.status === 200 && r.json.success === false && r.json.reason === 'resolve_failed', 'BO-disk-fail-fixed-response disk rename 失敗：回 200 {success:false,reason:resolve_failed}（byte-identical、不可枚舉，非 503——這是真實 contract）', JSON.stringify(r));
      assert(JSON.stringify(bindRow()) === JSON.stringify(before), 'BO-disk-fail-token-unchanged token 仍是 bound、opened_at 仍未設定', JSON.stringify(bindRow()));
      const retry = await call('POST', '/api/cart-recovery/resolve-target', { recovery_token: rt.token, member_session: ms });
      assert(retry.status === 200 && retry.json.success === true, 'BO-retry-succeeds 移除 fault 後 retry 成功', JSON.stringify(retry));
      assert(bindRow().status === 'opened' && !!bindRow().opened_at, 'BO-retry-opened-once retry 後 token 轉為 opened、opened_at 有值', JSON.stringify(bindRow()));
      const openedAtAfterFirst = bindRow().opened_at;
      const again = await call('POST', '/api/cart-recovery/resolve-target', { recovery_token: rt.token, member_session: ms });
      assert(again.status === 200 && again.json.success === true && bindRow().opened_at === openedAtAfterFirst, 'BO-same-user-idempotent same-user 對已 opened 的 token 重複呼叫：成功且 opened_at 不變（冪等，WHERE status=bound 不再命中）', JSON.stringify(bindRow()));
      // wrong-user
      const wrongMs = msFn.createMemberSession({ store_id: 'store_001', line_user_id: 'U_WRONG_' + Math.random().toString(36).slice(2, 6) });
      const wrong = await call('POST', '/api/cart-recovery/resolve-target', { recovery_token: rt.token, member_session: wrongMs });
      assert(wrong.status === 200 && wrong.json.success === false, 'BO-wrong-user-rejected wrong-user 對已 opened 的 token 呼叫，被拒絕（uid_mismatch，collapse 成同一固定回應）', JSON.stringify(wrong));
    }

    assert(tmpResidue().length === 0, 'FINAL-no-temp-residue 全程結束後無 temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
