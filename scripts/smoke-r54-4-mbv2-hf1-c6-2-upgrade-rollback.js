#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.2 升級／回退／再升級驗收（同一個資料庫檔，真實停機與啟動）
//   C62_OLD_ROOT=<C6.1 程式根目錄（未修改基準）>：必填。
//   1. 以 C6.1 建立資料庫與歷史資料（登記、現金訂單、LINE Pay 待付款訂單）
//   2. 升級為 C6.2：遷移可重複執行；升級前的歷史訂單不被自動扣減；之後的新訂單正常連動
//   3. 回退為 C6.1：可啟動、可登記、可下單／付款／取消（期間不做份數連動，見回退限制）
//   4. 再升級為 C6.2：回退期間「已綁定訂單」的付款與取消由啟動補齊處理一次；回退期間建立的訂單不連動
//   LINE 由 c4-line-mock、LINE Pay 由 c5-linepay-mock 攔截：真實呼叫 0。
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

const OLD = process.env.C62_OLD_ROOT || '';
if (!OLD || !fs.existsSync(path.join(OLD, 'server.js'))) { console.log('需要 C62_OLD_ROOT（C6.1 程式根目錄）'); process.exit(2); }
const NEW = H.ROOT;
const OFF = process.env.C4_CLOCK_OFFSET_MS;
const LIB = path.join(__dirname, 'lib');
const dir = H.tmpDir('c62-upg');
const dbf = path.join(dir, 'pos.db');
const mf = C45.lineMockFiles('c62-upg');
const LP_CTRL = path.join(dir, 'lp.json'), LP_LOG = path.join(dir, 'lp.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const MSPATH = path.join(NEW, 'utils', 'lineMemberSession.js');
const S = (u) => execFileSync(process.execPath, ['-r', path.join(LIB, 'c4-test-clock.js'), '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF) } }).toString();
const P = { claw: 801, tofu: 806, shank: 807, lp: 808, misc: 810 };
const PRODUCTS = [[801, '測試雞爪', 0, 'available', { quota: 50, price: 100 }], [806, '測試豆干', 1, 'available', { quota: 50, price: 50 }],
  [807, '測試腱子', 2, 'available', { quota: 50, price: 150 }], [808, '測試付款品', 3, 'available', { quota: 50, price: 60 }], [810, '測試雜項', 4, 'available', { quota: 50, price: 40 }]];

let port = 0;
async function start(root, tag, noLogin) {
  if (!port) { const net = require('net'); port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
  const args = ['-r', path.join(LIB, 'c4-test-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c5-linepay-mock.js'), 'server.js'];
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads'), C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} if (proc.exitCode != null) throw new Error(tag + ' exited: ' + log.slice(-2000)); if (i > 250) throw new Error(tag + ' start timeout'); await sleep(150); }
  const tok = noLogin ? null : await H.login(base, STORE, 'pw001');
  return { proc, base, tok, tag, log: () => log, stop: () => new Promise((res) => { if (proc.exitCode != null) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}
const q = async (sql, params) => { await sleep(200); const db = await H.openDbFile(dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
const schemaHash = async () => { const db = await H.openDbFile(dbf); try { return H.sha(JSON.stringify(H.q(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"))); } finally { db.close(); } };
const cols = async (t) => (await q(`PRAGMA table_info(${t})`)).map((c) => c.name);
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 升級／回退／再升級 驗收 ══════════');
  console.log('新版：' + NEW + '\n舊版（C6.1）：' + OLD);
  let srv = null;
  const pub = (m, p, b) => C45.pub(srv.base, m, p, b);
  const reg = (u, pid, qty) => pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any' });
  const order = async (u, items, pay = 'cash') => { await sleep(1100); const r = await pub('POST', '/api/line-orders', { customer_name: '測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay, items: items.map(([pid, qty]) => ({ product_id: pid, qty })), member_session: S(u) }); if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data; };
  const req = async (u, pid, st) => (await q(`SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=?${st ? ' AND status=?' : ''} ORDER BY id DESC LIMIT 1`, st ? [u, pid, st] : [u, pid]))[0];
  const lpReq = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp ' + r.text); return (await q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
  const lpConfirm = (a) => fetch(`${srv.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
  const cancel = async (uuid) => { const o = (await q('SELECT id FROM orders WHERE uuid=?', [uuid]))[0]; return H.api(srv.base, srv.tok, 'PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status: 'cancelled' }); };
  const notif = async () => (await q('SELECT (SELECT COUNT(*) FROM restock_notify_batches) AS b, (SELECT COUNT(*) FROM restock_notify_deliveries) AS d'))[0];
  try {
    // ═══ 1. C6.1 建立資料庫與歷史資料 ═══
    srv = await start(OLD, 'old-init', true); await srv.stop();
    { const db = await H.openDbFile(dbf); Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, settings: { restock_notify_enabled: '1' } });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62u','test-secret-c62u')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')"); H.saveDbFile(db, dbf); db.close(); }
    srv = await start(OLD, 'old');
    await reg(U(1), P.claw, 5); await reg(U(2), P.tofu, 3);
    const hCash = await order(U(1), [[P.claw, 2]]);
    const hLp = await order(U(2), [[P.tofu, 3]], 'linepay');
    const hAtt = await lpReq(hLp.uuid);
    const c0 = await cols('product_demand_requests');
    assert(!c0.includes('settled_qty') && !(await q("SELECT name FROM sqlite_master WHERE name='product_demand_order_links'")).length, 'U0 [RS] C6.1 資料庫：尚無份數欄位與訂單關聯表（真正的升級前狀態）');
    const N0 = await notif();
    await srv.stop();

    // ═══ 2. 升級為 C6.2 ═══
    srv = await start(NEW, 'new-1'); await sleep(3500);
    const c1 = await cols('product_demand_requests');
    const r1 = await req(U(1), P.claw);
    const L1 = await q('SELECT COUNT(*) AS c FROM product_demand_order_links');
    assert(c1.includes('settled_qty') && c1.includes('completed_at') && Number(r1.settled_qty) === 0 && r1.status === 'active' && Number(L1[0].c) === 0,
      'U1 [RS][DB] 升級：新增欄位與關聯表；升級前的歷史現金訂單不被自動扣減（雞爪仍 5、已完成 0、無關聯）', JSON.stringify({ s: r1.settled_qty, links: L1[0].c }));
    // 付款替身只記得「同一程序」建立的付款請求：顧客在升級後重新發起付款（同一張升級前訂單）
    const res = await lpConfirm(await lpReq(hLp.uuid)); await sleep(400); void hAtt;
    const r2 = await req(U(2), P.tofu); const o2 = (await q('SELECT payment_status FROM orders WHERE uuid=?', [hLp.uuid]))[0];
    assert(/linepay=success/.test(res.headers.get('location') || '') && o2.payment_status === 'paid' && Number(r2.settled_qty) === 0 && r2.status === 'active',
      'U2 [RS] 升級前建立的 LINE Pay 訂單在升級後付款成功：付款照常，但不以新功能回溯扣減（豆干仍 3）', JSON.stringify({ pay: o2.payment_status, s: r2.settled_qty }));
    const h1 = await schemaHash();
    await srv.stop(); srv = await start(NEW, 'new-1b'); await sleep(3000);
    const h2 = await schemaHash();
    assert(h1 === h2, 'U3 [RS] 遷移可重複執行：再次啟動結構雜湊不變', h1.slice(0, 12) + ' / ' + h2.slice(0, 12));
    // 新版正常連動
    await order(U(1), [[P.claw, 1]]);
    await reg(U(3), P.shank, 2); await order(U(3), [[P.shank, 2]]);
    await reg(U(4), P.lp, 3); const nLp = await order(U(4), [[P.lp, 3]], 'linepay'); const nAtt = await lpReq(nLp.uuid);
    await reg(U(5), P.misc, 2); const nCash = await order(U(5), [[P.misc, 2]]);
    const s1 = [await req(U(1), P.claw), await req(U(3), P.shank), await req(U(5), P.misc)];
    const lk = (await q('SELECT state FROM product_demand_order_links WHERE order_uuid=?', [nLp.uuid]))[0];
    assert(Number(s1[0].settled_qty) === 1 && s1[1].status === 'completed' && s1[2].status === 'completed' && lk.state === 'reserved',
      'U4 [API] 升級後的新訂單正常連動（雞爪 1/5、腱子完成、雜項完成、LINE Pay 訂購中）', JSON.stringify(s1.map((r) => [r.status, r.settled_qty])));
    await srv.stop();

    // ═══ 3. 回退為 C6.1 ═══
    srv = await start(OLD, 'old-rollback');
    const mineOld = await pub('POST', '/api/product-demand/mine', { member_session: S(U(1)) });
    const mineOld3 = await pub('POST', '/api/product-demand/mine', { member_session: S(U(3)) });
    const sumOld = await H.api(srv.base, srv.tok, 'GET', '/api/product-demand-admin/summary');
    const regOld = await reg(U(3), P.shank, 1); // 已完成週期 → 舊版建立新週期
    const lowOld = await reg(U(1), P.claw, 1); // 舊版不檢查已購買份數（回退限制）
    await lpConfirm(await lpReq(nLp.uuid)); await sleep(400); void nAtt; // 回退期間付款（在 C6.1 重新發起並完成）
    await cancel(nCash.uuid); await sleep(300); // 回退期間取消已扣減訂單
    await reg(U(6), P.tofu, 2); const rbOrder = await order(U(6), [[P.tofu, 2]]); // 回退期間建立的訂單
    const rbState = { lp: (await q('SELECT payment_status FROM orders WHERE uuid=?', [nLp.uuid]))[0].payment_status, lkLp: (await q('SELECT state FROM product_demand_order_links WHERE order_uuid=?', [nLp.uuid]))[0].state,
      misc: await req(U(5), P.misc) };
    assert(mineOld.json && mineOld.json.success && mineOld.json.data.some((d) => d.product_id === P.claw) && mineOld3.json.data.length === 0 && sumOld.json && sumOld.json.success
      && regOld.json && regOld.json.success && lowOld.json && lowOld.json.success && rbState.lp === 'paid' && rbState.lkLp === 'reserved' && rbState.misc.status === 'completed' && Number(rbState.misc.settled_qty) === 2,
    'U5 [RS] 回退為 C6.1：可啟動、可查詢、可登記、可付款與取消；回退期間不做份數連動（已完成週期不顯示、付款與取消不更新份數）', JSON.stringify({ lp: rbState.lp, lkLp: rbState.lkLp, misc: [rbState.misc.status, rbState.misc.settled_qty], lowOld: lowOld.status }));
    await srv.stop();

    // ═══ 4. 再升級為 C6.2 ═══
    srv = await start(NEW, 'new-2'); await sleep(3800);
    const lp2 = (await q('SELECT state, applied_qty FROM product_demand_order_links WHERE order_uuid=?', [nLp.uuid]))[0];
    const rLp = await req(U(4), P.lp);
    const lc = (await q('SELECT state, note FROM product_demand_order_links WHERE order_uuid=?', [nCash.uuid]))[0];
    const rMisc = await req(U(5), P.misc);
    const rbL = await q('SELECT COUNT(*) AS c FROM product_demand_order_links WHERE order_uuid=?', [rbOrder.uuid]);
    const rClaw = (await q("SELECT status, desired_qty, settled_qty FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id DESC LIMIT 1", [U(1), P.claw]))[0];
    const shankCycles = await q('SELECT status, cycle_no, settled_qty FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id', [U(3), P.shank]);
    assert(lp2.state === 'settled' && Number(lp2.applied_qty) === 3 && rLp.status === 'completed' && lc.state === 'reverted' && /reopened/.test(lc.note) && rMisc.status === 'active' && Number(rMisc.settled_qty) === 0,
      'U6 [RS] 再升級：回退期間已綁定訂單的付款（→ 扣減 3、完成）與取消（→ 回復並恢復有效）由啟動補齊各處理一次', JSON.stringify({ lp2, rLp: [rLp.status, rLp.settled_qty], lc, rMisc: [rMisc.status, rMisc.settled_qty] }));
    assert(Number(rbL[0].c) === 0 && rClaw.status === 'completed' && Number(rClaw.desired_qty) === 1 && Number(rClaw.settled_qty) === 1
      && shankCycles.length === 2 && shankCycles[0].status === 'completed' && shankCycles[1].status === 'active' && Number(shankCycles[1].settled_qty) === 0,
    'U7 [RS] 回退限制如實呈現：回退期間建立的訂單不連動；舊版把登記改為 ≤ 已購買份數者，再升級時視為已完成；舊版建立的新週期不受影響', JSON.stringify({ rb: rbL[0].c, rClaw, shankCycles }));
    await sleep(1000); await srv.stop(); srv = await start(NEW, 'new-2b'); await sleep(3500);
    const lp3 = (await q('SELECT state, applied_qty FROM product_demand_order_links WHERE order_uuid=?', [nLp.uuid]))[0]; const rLp2 = await req(U(4), P.lp); const rMisc2 = await req(U(5), P.misc);
    const N1 = await notif();
    assert(lp3.state === 'settled' && Number(rLp2.settled_qty) === 3 && Number(rMisc2.settled_qty) === 0 && N1.b === N0.b && N1.d === N0.d && mf.real() === 0,
      'U8 [RS] 再次重啟不重複扣減或回復；升級、回退、再升級都沒有建立通知、真實 LINE 0', JSON.stringify({ lp3, N0, N1, real: mf.real() }));
  } catch (e) { assert(false, '例外', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  finally { try { if (srv) await srv.stop(); } catch {} }
  const s = H.summary();
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  process.exit(s.failCount ? 1 : 0);
})();
