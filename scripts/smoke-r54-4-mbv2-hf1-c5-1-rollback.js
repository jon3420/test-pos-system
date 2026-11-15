#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-1-rollback.js
// R54.4／MBV2-HF1-C5.1 —— 回退相容驗證：保留同一個資料庫，程式退回舊版（C51_OLD_ROOT＝C5 或 C4.5 全新解壓樹），再升級回 C5.1。
//   1. C5.1 建立：有追蹤的通知批次、LINE Pay 付款請求（第一次嘗試／同一訂單第二次嘗試）、一般訂單。
//   2. 舊版程式讀取同一資料庫：啟動、讀取批次、建立新訂單、開啟含 rt 的通知連結（真實 Chrome）、完成 C5.1 建立的付款 callback。
//   3. 再以 C5.1 啟動同一資料庫：遷移可重複執行、資料完整。
// LINE／LINE Pay 全部在測試程序內攔截（真實呼叫 0）。這不是正式站或真機驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep, puuid } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const OLD = process.env.C51_OLD_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c51-rb');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt') };
fs.writeFileSync(LP.ctrl, '{}'); fs.writeFileSync(LP.state, JSON.stringify({ tx: {} })); fs.writeFileSync(LP.log, ''); fs.writeFileSync(LP.real, '');
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`], { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [702, '測試對照湯', 1, 'available', { quota: 50 }], [704, '測試補貨麵', 3, 'available', { quota: 50, price: 120 }]];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-rb','test-secret-rb')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.1 回退相容驗證 ══════════');
  console.log('C5.1：' + H.ROOT + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C51_OLD_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c51-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real };
  const C = await C45.boot('c51rb', { products: PRODUCTS, settings: { restock_notify_enabled: '1' }, seed, env });
  let oldProc = null; let browser = null;
  try {
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const S = (u) => sessAt(u, OFF);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const tomorrow = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    const pub = (base, m, p, b) => C45.pub(base, m, p, b);
    const order = async (base, u, pay) => {
      const r = await pub(base, 'POST', '/api/line-orders', { customer_name: '回退', customer_phone: '0912345678', order_type: 'takeout', pickup_date: tomorrow, pickup_time: '12:00', payment_method: pay || 'cash', items: [{ product_id: 702, qty: 1 }], member_session: S(u) });
      if (!r.json || !r.json.success) throw new Error('order ' + r.text.slice(0, 200)); return r.json.data;
    };
    // ── 1. C5.1 建立資料 ──
    for (const i of [1, 2]) await pub(C.s.base, 'POST', '/api/product-demand/register', { member_session: S(U(i)), product_id: 704, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    const pv = await H.api(C.s.base, C.tok, 'POST', '/api/product-demand-admin/restock/preview', { product_id: 704, fulfillment_mode: 'takeout', supply_date: today });
    await H.api(C.s.base, C.tok, 'POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {});
    await sleep(2500);
    const rt = new URL(pv.json.data.link_url).searchParams.get('rt');
    const o1 = await order(C.s.base, U(3), 'linepay');
    await pub(C.s.base, 'POST', '/api/linepay/request', { order_uuid: o1.uuid });
    const call1 = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
    const o2 = await order(C.s.base, U(4), 'linepay');
    await pub(C.s.base, 'POST', '/api/linepay/request', { order_uuid: o2.uuid });
    await pub(C.s.base, 'POST', '/api/linepay/request', { order_uuid: o2.uuid }); // 同一訂單第二次付款請求（orderId 加 -P2）
    const call2 = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
    const o3 = await order(C.s.base, U(5), 'cash');
    assert(call1 && call1.orderId === o1.order_number && /-P2$/.test(call2.orderId) && /-[A-Z0-9]{4}$/.test(o3.order_number),
      'RB0 C5.1 建立：通知批次（含 rt）、第一次付款請求 orderId＝訂單編號、第二次請求 orderId 加 -P2、新格式編號', JSON.stringify({ o1: o1.order_number, lp1: call1 && call1.orderId, lp2: call2 && call2.orderId }));
    await C.s.stop();

    // ── 2. 舊版程式讀取同一資料庫 ──
    const port = C.s.port;
    oldProc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: OLD, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let olog = ''; oldProc.stdout.on('data', (d) => { olog += d; }); oldProc.stderr.on('data', (d) => { olog += d; });
    const base = `http://127.0.0.1:${port}`;
    let up = false; for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(150); }
    const tokO = await H.login(base, STORE, 'pw001');
    const bl = await H.api(base, tokO, 'GET', '/api/product-demand-admin/restock/batches');
    assert(up && bl.json && bl.json.success && bl.json.data.some((b) => b.batch_uuid === pv.json.data.batch_uuid) && !/SQLITE_ERROR|migration.*fail/i.test(olog),
      'RB1 舊版程式以 C5.1 資料庫啟動、讀取通知批次（新增欄位／資料表／索引不影響）', JSON.stringify({ up, batches: bl.json && bl.json.data && bl.json.data.length }));
    const o4 = await order(base, U(6), 'cash');
    assert(o4 && /^LINE-\d{8}-\d{6}$/.test(o4.order_number), 'RB2 舊版建立新訂單：使用舊編號格式，不受新編號唯一索引影響（舊版會重新出現同秒重號風險）', o4 && o4.order_number);
    // C5.1 建立的第一次付款請求：舊版 callback 可完成（attempt 參數被忽略，orderId＝唯一訂單編號）
    const cbo = async (url, tx, oid) => { const r = await fetch(`${url.replace(/^https?:\/\/[^/]+/, base)}&transactionId=${tx}&orderId=${encodeURIComponent(oid)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const l1 = await cbo(call1.confirmUrl, call1.tx, call1.orderId);
    const l2 = await cbo(call2.confirmUrl, call2.tx, call2.orderId);
    await sleep(300);
    const db = await H.openDbFile(C.dbf); let st;
    try { st = H.q(db, 'SELECT uuid, payment_status FROM orders WHERE uuid IN (?,?)', [o1.uuid, o2.uuid]); } finally { db.close(); }
    const p1 = st.find((r) => r.uuid === o1.uuid), p2 = st.find((r) => r.uuid === o2.uuid);
    assert(/linepay=success/.test(l1) && p1.payment_status === 'paid', 'RB3 C5.1 建立的第一次付款請求，在舊版完成 callback：付款成功', JSON.stringify({ l1: l1.slice(0, 90) }));
    assert(p2.payment_status !== 'paid' && /linepay=(error|fail)/.test(l2), 'RB4 C5.1 建立的「同一訂單第二次付款請求」（orderId 加 -P2）：舊版找不到訂單、不自動判定（回退限制，需人工核對）', JSON.stringify({ l2: l2.slice(0, 120), st: p2.payment_status }));
    if (chromium) {
      browser = await chromium.launch(C45.launchOpts());
      const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } }); const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
      await pg.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
      await pg.goto(`${base}/line-order.html?store_id=${STORE}&product_ref=${puuid(704)}&src=restock&m=takeout&d=${today}&rt=${rt}`, { waitUntil: 'domcontentloaded' });
      await sleep(3000);
      const s2 = await pg.evaluate(() => ({ open: !!document.querySelector('.pdm-overlay.pdm-open') }));
      assert(s2.open && errs.length === 0, 'RB5 [BR] 舊版點餐頁開啟 C5.1 發出的通知連結（含 rt）：照常開啟商品', JSON.stringify({ s2, errs }));
      await ctx.close();
    }
    await new Promise((res) => { oldProc.once('exit', res); oldProc.kill('SIGTERM'); }); oldProc = null;

    // ── 3. 再升級回 C5.1（同一資料庫） ──
    await C.restart(env); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const log = C.s.getLog();
    const diag = await H.api(C.s.base, C.tok, 'GET', '/api/order-identity/diagnostics');
    const o5 = await order(C.s.base, U(7), 'cash');
    const db2 = await H.openDbFile(C.dbf); let cnt;
    try { cnt = H.q1(db2, 'SELECT COUNT(*) AS c FROM orders WHERE uuid IN (?,?,?,?)', [o1.uuid, o2.uuid, o3.uuid, o4.uuid]).c; } finally { db2.close(); }
    assert(!/order_identity migration:|restock_tracking migration:/.test(log) && diag.json && diag.json.success && /-[A-Z0-9]{4}$/.test(o5.order_number) && cnt === 4,
      'RB6 回退後再升級回 C5.1：遷移可重複執行、舊版期間建立的訂單保留、新訂單恢復新編號', JSON.stringify({ cnt, o5: o5.order_number, dup: diag.json && diag.json.data && diag.json.data.duplicate_groups }));
    const real = C.mf.real() + fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次', String(real));
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally {
    if (browser) { try { await browser.close(); } catch {} }
    if (oldProc) { try { oldProc.kill('SIGKILL'); } catch {} }
    try { await C.s.stop(); } catch {}
  }
  const s = H.summary();
  if (process.env.C51_RESULT_JSON) fs.writeFileSync(process.env.C51_RESULT_JSON, JSON.stringify({ old: OLD, pass: s.passCount, fail: s.failCount, results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
