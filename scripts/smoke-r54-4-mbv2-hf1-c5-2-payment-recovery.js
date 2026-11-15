#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js
// R54.4／MBV2-HF1-C5.2 —— 三類問題的重現與驗收（同一組核心案例先在未修改的 C5.1 執行，再在 C5.2 執行）
//   A 組：舊訂閱請求的登記週期保護
//   B 組：取消／作廢與付款 callback 競態
//   C 組：金流成功、本機失敗的核對與恢復（含真正關閉並重新啟動伺服器程序）
//   U 組：升級、搬家
// 測試層級：[API] 正式路由＋暫存 SQLite（node server.js）；[BR] 真實 Chrome；[DB] 直接核對暫存資料庫檔；[RS] 真的終止並重新啟動伺服器程序。
// 外部網路：LINE Messaging API 由 c4-line-mock 攔截；LINE Pay（Request、Confirm、Retrieve payment details）由 c51-linepay-mock
//   有狀態替身攔截並核對簽章。真實呼叫次數在 Z 案例核對（必須為 0）。都不是真機、正式金流或正式站驗證。
// 「新介面」標記：只有 C5.2 才有的介面（例如後台核對 API）。在 C5.1 執行時這些案例的 404 只是功能缺口，不作為原始問題已重現的證據。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep, puuid } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const D = H.tmpDir('c52-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt') };
fs.writeFileSync(LP.ctrl, '{}'); fs.writeFileSync(LP.state, JSON.stringify({ tx: {} })); fs.writeFileSync(LP.log, ''); fs.writeFileSync(LP.real, '');
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c52': 'test-secret-c52', 'test-channel-c52b': 'test-secret-c52b', 'test-channel-c52-s2': 'test-secret-c52-s2' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const inquiriesFor = (tx) => lpCalls().filter((c) => c.method === 'GET' && c.uri === '/v3/payments' && String(c.tx) === String(tx)).length;
const ONLY = (process.env.C52_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const STEP_RE = process.env.C52_STEP ? new RegExp(process.env.C52_STEP) : null;
const GAP = []; // 新介面在舊版不存在（功能缺口）
async function step(name, fn) { if (STEP_RE && !STEP_RE.test(name)) return; try { await fn(); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }
function sessAt(u, offsetMs, store = STORE) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${store}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}
const P = [711, 712, 713, 714];
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [702, '測試對照湯', 1, 'available', { quota: 50 }],
  [711, '付款測試甲', 2, 'available', { quota: 300, price: 100 }], [712, '付款測試乙', 3, 'available', { quota: 300, price: 120 }],
  [713, '付款測試丙', 4, 'available', { quota: 300, price: 80 }], [714, '付款測試丁', 5, 'available', { quota: 300, price: 60 }]];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c52','test-secret-c52')");
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_002','LINE Pay','linepay',1,'test','test-channel-c52-s2','test-secret-c52-s2')");
  for (const sid of ['store_001', 'store_002']) db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,'line_payment_linepay_enabled','1')", [sid]);
  for (const sid of ['store_001', 'store_002']) {
    const rr = db.exec(`SELECT features FROM licenses WHERE store_id='${sid}'`);
    if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { coupon: true, reports: true, line_order: true, payment_api: true }); db.run('UPDATE licenses SET features=? WHERE store_id=?', [JSON.stringify(f), sid]); }
  }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.2 訂閱週期・付款競態・付款恢復 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c51-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C51_DURABLE_CTRL: DUR,
      C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
    const C = await C45.boot('c52', { products: PRODUCTS, members: 90, settings: { restock_notify_enabled: '1', coupon_feature_enabled: '1' }, seed, env: env(OFF) }); boots.push(C);
    let curOff = OFF;
    const restart = async (off) => { curOff = off === undefined ? curOff : off; await C.restart(env(curOff)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    await restart(OFF);
    // 真的終止程序（SIGKILL，不給程式收尾），再以同一個資料庫檔重新啟動
    const killAndRestart = async () => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); await restart(); };
    const adm = (m, p, b, tok) => H.api(C.s.base, tok || C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const S = (u) => sessAt(u, curOff);
    const nowTw = () => new Date(RealDate.now() + Number(curOff) + 8 * 3600e3);
    const today = () => nowTw().toISOString().slice(0, 10);
    const dbq = async (sql, params) => { const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const q = async (sql, params) => { await sleep(150); return dbq(sql, params); };
    const qOpt = async (sql, params) => { try { return await q(sql, params); } catch (e) { if (/no such (table|column)/.test(e.message)) return null; throw e; } };
    const hasCol = (db, t, c) => { try { return db.exec(`PRAGMA table_info(${t})`)[0].values.some((r) => r[1] === c); } catch { return false; } };
    const editDb = async (fn) => { await C.s.stop(); try { const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } } finally { await restart(); } };
    let pi = 0;
    const order = async (u, o = {}) => {
      const pid = o.pid || P[pi++ % P.length];
      const body = { customer_name: o.name || '付款測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today(), pickup_time: '22:30',
        payment_method: o.pay || 'linepay', items: [{ product_id: pid, qty: o.qty || 2 }], analytics: { visitor_id: 'v_c52', session_id: 's_c52' } };
      if (u) body.member_session = S(u);
      const r = await pub('POST', '/api/line-orders', body);
      if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 200));
      return { ...r.json.data, pid };
    };
    const lpRequest = async (o) => {
      const r = await pub('POST', '/api/linepay/request', { order_uuid: o.uuid, order_number: o.order_number, redirect_url: `${C.s.base}/api/linepay/confirm?store_id=${STORE}` });
      const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
      return { r, call };
    };
    const callback = async (call) => { const r = await fetch(`${C.s.base}/api/linepay/confirm?${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const ord = async (uuid) => (await q('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
    const counters = async (pid) => { const r = (await q('SELECT line_quota_sold a, line_preorder_sold b FROM products WHERE id=?', [pid]))[0]; return `${r.a}/${r.b}`; };
    const events = async (uuid) => (await q("SELECT event_name, COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','payment_success','member_first_purchase','member_repeat_purchase') GROUP BY event_name", [uuid]))
      .reduce((m, r) => { m[r.event_name] = r.c; return m; }, {});
    const memberSpend = async (u) => (await q('SELECT total_spent, order_count FROM line_members WHERE line_user_id=?', [u]))[0];
    const links = async (uuid) => (await q('SELECT COUNT(*) AS c FROM line_member_order_links WHERE order_id=?', [uuid]))[0].c;
    const attempt = async (uuid) => { const r = await qOpt('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC', [uuid]); return r ? r[0] : null; };
    const cancel = (o, tok) => adm('PATCH', `/api/line-orders/online/${o.uuid}/status`, { status: 'cancelled' }, tok);
    const review = async () => { const r = await adm('GET', '/api/linepay-admin/review'); if (r.status === 404) GAP.push('GET /api/linepay-admin/review'); return r; };
    const reconcile = async (body) => { const r = await adm('POST', '/api/linepay-admin/reconcile', body || {}); if (r.status === 404) GAP.push('POST /api/linepay-admin/reconcile'); return r; };
    const durable = (o) => fs.writeFileSync(DUR, JSON.stringify(o || {}));
    if (chromium) browser = await chromium.launch(C45.launchOpts());

    // ════════════════════════════════ A 組：訂閱週期 ════════════════════════════════
    if (want('A')) {
      await adm('PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });
      const cfg = (await pub('GET', '/api/product-demand/config')).json;
      const ver = cfg && cfg.data && cfg.data.consent_text_version;
      const reg = (u, pid, qty, pref, extra = {}) => pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: pref, ...extra });
      const legacy = (u, pid, qty, pref) => reg(u, pid, qty, pref, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'subscribe', consent_text_version: ver });
      const sub = (u, pid, ref, extra = {}) => pub('POST', '/api/product-demand/subscribe', { member_session: S(u), product_id: pid, ...ref, consent_mode: 'register_subscribe', consent_text_version: ver, ...extra });
      const reqRow = async (u, pid) => (await q('SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id DESC LIMIT 1', [u, pid]))[0];
      const granted = async (u, pid) => (await q("SELECT COUNT(*) AS c FROM product_demand_consents WHERE line_user_id=? AND product_id=? AND status='granted'", [u, pid]))[0].c;
      const grantedFor = async (ru) => (await q("SELECT COUNT(*) AS c FROM product_demand_consents WHERE request_uuid=? AND status='granted'", [ru]))[0].c;
      const setup = async (u, pid, qty = 1, pref = 'takeout') => { await reg(u, pid, qty, pref, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'register_subscribe', consent_text_version: ver }); await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(u), product_id: pid }); };
      await step('A1', async () => {
        const u = U(61); await setup(u, 701);
        const r0 = await reqRow(u, 701); const g0 = await granted(u, 701);
        const r = await legacy(u, 701, 1, 'takeout');
        const r1 = await reqRow(u, 701);
        assert(r.status === 409 && r.json.code === 'REQUEST_CHANGED' && (await granted(u, 701)) === g0 && r1.id === r0.id && r1.desired_qty === 1 && r1.expires_at === r0.expires_at,
          'A1 [API] 舊頁面（沒有週期識別）訂閱，資料未變：409 REQUEST_CHANGED，不新增同意、不改登記', JSON.stringify({ st: r.status, code: r.json && r.json.code, g: [g0, await granted(u, 701)] }));
      });
      await step('A2', async () => {
        const u = U(62); await setup(u, 701);
        await pub('POST', '/api/product-demand/cancel', { member_session: S(u), product_id: 701 });
        await reg(u, 701, 1, 'takeout'); // 另一裝置：以完全相同份數與偏好重建
        const nw = await reqRow(u, 701);
        const r = await legacy(u, 701, 1, 'takeout');
        assert(r.status === 409 && (await grantedFor(nw.request_uuid)) === 0, 'A2 [API] 取消後以相同份數、偏好重建：舊頁面不能授權新週期', JSON.stringify({ st: r.status, g: await grantedFor(nw.request_uuid) }));
      });
      await step('A3', async () => {
        const u = U(63); await setup(u, 701);
        await pub('POST', '/api/product-demand/cancel', { member_session: S(u), product_id: 701 });
        await reg(u, 701, 3, 'delivery');
        const nw = await reqRow(u, 701);
        const r = await legacy(u, 701, 1, 'takeout');
        const r2 = await reqRow(u, 701);
        assert(r.status === 409 && (await grantedFor(nw.request_uuid)) === 0 && r2.desired_qty === 3 && r2.fulfillment_pref === 'delivery', 'A3 [API] 取消後以不同內容重建：舊頁面被拒絕，新週期內容不變', JSON.stringify({ st: r.status }));
      });
      await step('A4', async () => {
        const u = U(64), other = U(65); await setup(u, 701); await setup(other, 701);
        const old = await reqRow(u, 701);
        await pub('POST', '/api/product-demand/cancel', { member_session: S(u), product_id: 701 });
        await reg(u, 701, 1, 'takeout');
        const cur = await reqRow(u, 701);
        const a = await sub(u, 701, { request_uuid: old.request_uuid });               // 明確指定舊週期
        const b = await sub(u, 701, { request_id: old.id });
        const oth = await reqRow(other, 701);
        const c = await sub(u, 701, { request_uuid: oth.request_uuid });                // 他人週期
        const tok2 = await H.login(C.s.base, 'store_002', 'pw002'); void tok2;
        const d = await C45.pub(C.s.base, 'POST', '/api/product-demand/subscribe', { member_session: sessAt(u, curOff, 'store_002'), product_id: 701, request_uuid: cur.request_uuid, consent_mode: 'register_subscribe', consent_text_version: ver }, 'store_002'); // 他店
        await editDb((db) => { db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 day') WHERE request_uuid=?", [cur.request_uuid]); });
        const e = await sub(u, 701, { request_uuid: cur.request_uuid });                // 過期週期
        const g = await granted(u, 701) + await grantedFor(oth.request_uuid);
        assert([a.status, b.status, c.status, e.status].every((x) => x === 409) && d.status >= 400 && g === 0,
          'A4 [API] 明確指定舊週期、過期週期、他人週期、他店週期：全部拒絕，不新增同意', JSON.stringify({ st: [a.status, b.status, c.status, d.status, e.status], g }));
      });
      await step('A5', async () => {
        const u = U(66); await setup(u, 701, 2, 'delivery');
        const r0 = await reqRow(u, 701);
        const a = await sub(u, 701, { request_uuid: r0.request_uuid });
        const a2 = await sub(u, 701, { request_uuid: r0.request_uuid }); // 重送
        await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(u), product_id: 701 });
        const a3 = await sub(u, 701, { request_uuid: r0.request_uuid }); // 撤回後重新訂閱
        const r1 = await reqRow(u, 701);
        const rows = (await q('SELECT COUNT(*) AS c FROM product_demand_consents WHERE request_uuid=?', [r0.request_uuid]))[0].c;
        assert(a.json && a.json.data && a.json.data.consent_outcome === 'granted' && a2.json.data.consent_outcome === 'unchanged' && a3.json.data.consent_outcome === 'granted'
          && r1.desired_qty === 2 && r1.fulfillment_pref === 'delivery' && r1.expires_at === r0.expires_at && r1.id === r0.id && rows === 3,
        'A5 [API]〔新版〕有效週期訂閱、重送、撤回後重新訂閱：只改同意；份數、偏好、期限、週期不變', JSON.stringify({ out: [a.json && a.json.data && a.json.data.consent_outcome, a2.json && a2.json.data && a2.json.data.consent_outcome, a3.json && a3.json.data && a3.json.data.consent_outcome], rows }));
      });
      await step('A6', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const u = U(67); await setup(u, 701);
        const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); window.__C45_LIFF = { mode: 'resolve_then_redirect' }; }, ['line_member_session_store_001', JSON.stringify({ member_session: S(u), display_name: '會員', is_friend: true, expires_at: RealDate.now() + 3600e3 })]);
        const pg = await ctx.newPage(); await pg.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
        let payload = null; pg.on('request', (rq) => { if (/product-demand\/(subscribe|register)/.test(rq.url()) && rq.method() === 'POST') payload = rq.postDataJSON(); });
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
        await pg.waitForFunction(() => typeof _pdMine === 'function' && !!_pdMine(701), null, { timeout: 15000 });
        await pg.evaluate(() => { openDemandSheet(701, 'card'); return null; });
        await pg.waitForSelector('#dmSubscribe', { timeout: 8000 });
        // 另一裝置改成 5 份、外送；再在本頁訂閱
        await reg(u, 701, 5, 'delivery');
        await pg.click('#dmSubscribe'); await sleep(2500);
        const r1 = await reqRow(u, 701);
        const ui = await pg.evaluate(() => { const m = _pdMine(701); return m && { q: m.desired_qty, p: m.fulfillment_pref, c: m.notify_consent }; });
        assert(payload && payload.request_uuid === r1.request_uuid && !('desired_qty' in payload) && r1.desired_qty === 5 && r1.fulfillment_pref === 'delivery' && ui && ui.q === 5 && ui.c === 'granted',
          'A6 [BR]〔新版頁面〕訂閱帶週期識別、不帶份數；另一裝置改成 5 份外送後仍維持最新內容', JSON.stringify({ payload: payload && Object.keys(payload), db: [r1.desired_qty, r1.fulfillment_pref], ui }));
        await ctx.close();
      });
      await adm('PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'opt_in' });
    }

    // ════════════════════════════════ B 組：取消與付款競態 ════════════════════════════════
    if (want('B')) {
      await step('B1', async () => {
        lpCtrl({});
        const o = await order(U(71)); const { call } = await lpRequest(o);
        const c0 = await counters(o.pid);
        await cancel(o);
        const c1 = await counters(o.pid);
        const loc = await callback(call);
        const x = await ord(o.uuid);
        assert(confirmsFor(call.tx) === 0 && x.order_status === 'cancelled' && x.payment_status !== 'paid' && (await counters(o.pid)) === c1 && /order_cancelled/.test(loc),
          'B1 [API] 訂單已取消後才收到 callback：不呼叫 Confirm、維持取消、不改付款、不動份數', JSON.stringify({ confirms: confirmsFor(call.tx), st: [x.order_status, x.payment_status], c: [c0, c1, await counters(o.pid)], loc: loc.slice(0, 80) }));
      });
      await step('B2', async () => {
        lpCtrl({});
        const o = await order(U(72)); const { call } = await lpRequest(o);
        await editDb((db) => { db.run("UPDATE orders SET status='void' WHERE uuid=?", [o.uuid]); });
        const loc = await callback(call);
        const x = await ord(o.uuid);
        assert(confirmsFor(call.tx) === 0 && x.status === 'void' && x.payment_status !== 'paid', 'B2 [API] 訂單已作廢後才收到 callback：不呼叫 Confirm、維持作廢', JSON.stringify({ confirms: confirmsFor(call.tx), st: [x.status, x.order_status, x.payment_status], loc: loc.slice(0, 80) }));
      });
      const raceCase = async (name, label, ctrl) => step(name, async () => {
        const u = U(name === 'B3' ? 73 : 74);
        const o = await order(u); const { call } = await lpRequest(o);
        const sp0 = await memberSpend(u);
        lpCtrl(ctrl);
        const pending = callback(call);
        await sleep(600);
        const cr = await cancel(o);
        const c1 = await counters(o.pid);
        const loc = await pending; lpCtrl({});
        const x = await ord(o.uuid); const a = await attempt(o.uuid); const ev = await events(o.uuid);
        assert(cr.json && cr.json.success && x.order_status === 'cancelled' && x.kitchen_status !== 'pending' && x.payment_status === 'paid' && x.refund_status === 'pending_refund'
          && (await counters(o.pid)) === c1 && !ev.purchase && !ev.payment_success && (await links(o.uuid)) === 0 && JSON.stringify(await memberSpend(u)) === JSON.stringify(sp0) && /paid_cancelled/.test(loc),
        name + ' [API] ' + label + '：金流已付款 → 記錄已付款、保留取消、標示待退款；不恢復出餐、不重扣份數、不記購買或會員消費',
        JSON.stringify({ st: [x.order_status, x.kitchen_status, x.payment_status, x.refund_status], att: a && a.status, ev, loc: loc.slice(0, 80) }));
      });
      await raceCase('B3', 'Confirm 已送出、金流處理前取消', { confirmDelayBeforeMs: 1500 });
      await raceCase('B4', '金流已扣款、成功回應放行前取消', { confirmDelayMs: 1500 });
      await step('B5', async () => {
        // 已付款取消單：重複 callback 與後台核對 → 不再呼叫 Confirm、狀態與資源不變
        const o = await order(U(75)); const { call } = await lpRequest(o);
        lpCtrl({ confirmDelayMs: 1200 }); const p = callback(call); await sleep(500); await cancel(o); await p; lpCtrl({});
        const snap = JSON.stringify([await ord(o.uuid), await counters(o.pid), await events(o.uuid)].map((x) => (x && x.updated_at ? { ...x, updated_at: '' } : x)));
        const n0 = confirmsFor(call.tx);
        const l2 = await callback(call); const l3 = await callback(call);
        await reconcile({});
        const snap2 = JSON.stringify([await ord(o.uuid), await counters(o.pid), await events(o.uuid)].map((x) => (x && x.updated_at ? { ...x, updated_at: '' } : x)));
        assert(confirmsFor(call.tx) === n0 && snap === snap2 && /paid_cancelled/.test(l2) && /paid_cancelled/.test(l3),
          'B5 [API] 已付款取消單重複 callback／重複核對：不再呼叫 Confirm，訂單、份數、事件不變', JSON.stringify({ confirms: [n0, confirmsFor(call.tx)], same: snap === snap2, l2: l2.slice(0, 70) }));
      });
      await step('B6', async () => {
        // 正常付款：份數只在訂單建立時依快照扣一次；付款確認不再扣
        lpCtrl({});
        const u = U(76); const sp0 = await memberSpend(u);
        const pid = 713; const c0 = await counters(pid);
        const o = await order(u, { pid, qty: 2 }); const c1 = await counters(pid);
        const { call } = await lpRequest(o); const loc = await callback(call);
        const c2 = await counters(pid); const x = await ord(o.uuid); const ev = await events(o.uuid); const sp1 = await memberSpend(u);
        assert(c1 !== c0 && c2 === c1 && x.payment_status === 'paid' && x.order_status === 'pending' && ev.purchase === 1 && ev.payment_success === 1 && (await links(o.uuid)) === 1
          && Number(sp1.total_spent) === Number(sp0.total_spent) + Number(x.total) && /linepay=success/.test(loc),
        'B6 [API] 可正常履約的訂單付款成功：完成付款流程；份數不再額外扣除；purchase、payment_success、會員消費各一次', JSON.stringify({ c: [c0, c1, c2], ev, spend: [sp0.total_spent, sp1.total_spent] }));
      });
      await step('B7', async () => {
        // 消費者畫面：付款已收但訂單已取消、付款結果確認中
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } }); const pg = await ctx.newPage();
        await pg.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
        const toasts = [];
        await pg.addInitScript(() => { window.__t = []; });
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&linepay=error&msg=paid_cancelled&order=X`, { waitUntil: 'domcontentloaded' }); await sleep(2500);
        toasts.push(await pg.evaluate(() => (document.getElementById('toast') || {}).textContent || ''));
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&linepay=pending&order=LINE-X&order_ref=x`, { waitUntil: 'domcontentloaded' }); await sleep(2500);
        const pend = await pg.evaluate(() => ({ notice: (document.getElementById('lpPendingNotice') || {}).textContent || '', success: /付款成功/.test(document.body.innerText) }));
        await pg.goto(`${C.s.base}/line-shipping.html?store_id=${STORE}&linepay=pending&order=SHIP-X`, { waitUntil: 'domcontentloaded' }); await sleep(2500);
        const pendS = await pg.evaluate(() => (document.getElementById('lpPendingNotice') || {}).textContent || '');
        assert(/已取消/.test(toasts[0]) && /退款/.test(toasts[0]) && /確認中/.test(pend.notice) && /請勿重複付款/.test(pend.notice) && !pend.success && /確認中/.test(pendS),
          'B7 [BR] 消費者畫面：已付款取消單顯示「已取消、店家處理退款」；確認中顯示「請勿重複付款、可稍後查詢」，不顯示成功或失敗', JSON.stringify({ toasts, pend, pendS: pendS.slice(0, 30) }));
        await ctx.close();
      });
    }

    // ════════════════════════════════ C 組：付款恢復 ════════════════════════════════
    if (want('C')) {
      const recoverable = async (o, call) => { const x = await ord(o.uuid); const a = await attempt(o.uuid); return { x, a }; };
      await step('C1', async () => {
        lpCtrl({});
        const o = await order(U(77)); const { call } = await lpRequest(o);
        durable({ skip: 0, fail: 1 });
        const loc = await callback(call);
        const d = JSON.parse(fs.readFileSync(DUR, 'utf8')); durable({});
        const x = await ord(o.uuid);
        const loc2 = await callback(call);
        const x2 = await ord(o.uuid);
        assert(d.failed === 1 && confirmsFor(call.tx) === 1 && x.payment_status !== 'paid' && !/linepay=success/.test(loc) && /linepay=success/.test(loc2) && x2.payment_status === 'paid',
          'C1 [API] Confirm 前的 durable 保存失敗：當次外部 Confirm 0 次、不推定結果；下一次 callback 正常完成（全程 Confirm 1 次）', JSON.stringify({ failed: d.failed, confirms: confirmsFor(call.tx), loc: loc.slice(0, 70), loc2: loc2.slice(0, 50) }));
      });
      let C2o = null, C2call = null;
      await step('C2', async () => {
        lpCtrl({});
        const u = U(78); const o = await order(u); const { call } = await lpRequest(o); C2o = o; C2call = call;
        durable({ skip: 1, fail: 1 }); // 放行 Confirm 前保存，讓「金流成功後的本機提交」失敗
        const loc = await callback(call);
        const d = JSON.parse(fs.readFileSync(DUR, 'utf8')); durable({});
        const x = await ord(o.uuid); const a = await attempt(o.uuid);
        // 顧客重新整理付款返回頁（再次 callback）：不得因重複交易代碼標記失敗；以唯讀查詢核對後完成
        const loc2 = await callback(call);
        const x2 = await ord(o.uuid); const a2 = await attempt(o.uuid); const ev = await events(o.uuid);
        assert(d.failed === 1 && x.payment_status !== 'paid' && /linepay=pending/.test(loc) && a && a.status !== 'failed' && x2.payment_status === 'paid' && a2.status !== 'failed'
          && confirmsFor(call.tx) === 1 && ev.purchase === 1 && /linepay=success/.test(loc2),
        'C2 [API] 金流成功、本機 durable 保存失敗：顯示確認中；再次 callback 以唯讀查詢核對後恢復（不再送 Confirm、不標記失敗）', JSON.stringify({ x: x.payment_status, a: a && a.status, x2: x2.payment_status, a2: a2 && a2.status, confirms: confirmsFor(call.tx), loc: loc.slice(0, 60), loc2: loc2.slice(0, 60) }));
      });
      const lostCase = (name, label, mode) => step(name, async () => {
        lpCtrl({ confirmMode: mode });
        const o = await order(U(name === 'C3' ? 79 : 80)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const x = await ord(o.uuid); const a = await attempt(o.uuid); const ev = await events(o.uuid);
        assert(x.payment_status === 'paid' && a && a.status !== 'failed' && confirmsFor(call.tx) === 1 && inquiriesFor(call.tx) >= 1 && ev.purchase === 1 && /linepay=success/.test(loc),
          name + ' [API] ' + label + '：以唯讀查詢確認已付款後完成本機紀錄（Confirm 只送 1 次）', JSON.stringify({ st: x.payment_status, a: a && a.status, confirms: confirmsFor(call.tx), inq: inquiriesFor(call.tx), loc: loc.slice(0, 60) }));
      });
      await lostCase('C3', '金流成功但回應遺失', 'drop');
      await lostCase('C4', '金流成功但回應內容無法解析', 'garbage');
      await step('C5', async () => {
        // 回應遺失＋查詢失敗 → 待核對；再次 callback 時先查詢（不重送 Confirm）
        lpCtrl({ confirmMode: 'drop', inquiry: 'error' });
        const o = await order(U(81)); const { call } = await lpRequest(o);
        const loc = await callback(call);
        const x = await ord(o.uuid); const a = await attempt(o.uuid);
        const rq = await pub('POST', '/api/linepay/request', { order_uuid: o.uuid });
        lpCtrl({ reconfirm: '1172' });
        const loc2 = await callback(call); lpCtrl({});
        const x2 = await ord(o.uuid);
        assert(x.payment_status !== 'paid' && a && ['review', 'confirm_pending', 'confirming'].includes(a.status) && /linepay=pending/.test(loc) && rq.status === 409
          && x2.payment_status === 'paid' && confirmsFor(call.tx) === 1 && /linepay=success/.test(loc2),
        'C5 [API] 回應遺失且查詢失敗：保留待核對、顯示確認中、拒絕再次付款；重試 callback 先查詢再完成（不因重複交易代碼判定）', JSON.stringify({ a: a && a.status, rq: rq.status, x2: x2.payment_status, confirms: confirmsFor(call.tx), loc: loc.slice(0, 60) }));
      });
      await step('C6', async () => {
        // 查詢結果不足以判定：未完成、查詢失敗、timeout、無資料、無法解析、識別／金額／幣別不符、已退款 → 維持待核對
        const modes = ['empty', '1150', 'error', 'timeout', 'unparseable', 'amount', 'currency', 'order', 'refunded'];
        const res = [];
        for (const m of modes) {
          lpCtrl({ confirmMode: 'drop', inquiry: m });
          const o = await order(U(82)); const { call } = await lpRequest(o);
          const loc = await callback(call); lpCtrl({});
          const x = await ord(o.uuid); const a = await attempt(o.uuid);
          const rq = await pub('POST', '/api/linepay/request', { order_uuid: o.uuid });
          res.push({ m, paid: x.payment_status === 'paid', st: a && a.status, pending: /linepay=pending/.test(loc), rq: rq.status, o, call });
        }
        assert(res.every((r) => !r.paid && ['review'].includes(r.st) && r.pending && r.rq === 409), 'C6 [API] 查詢顯示未完成／失敗／timeout／無資料／無法解析／訂單識別、金額、幣別不符／已退款：一律維持待核對、不標記付款或失敗、不允許再次付款',
          JSON.stringify(res.map((r) => [r.m, r.paid, r.st, r.rq])));
        // 〔新介面〕查詢恢復正常後，後台核對（唯讀查詢）恢復本機紀錄；不送新的 Confirm
        lpCtrl({});
        const before = res.map((r) => confirmsFor(r.call.tx));
        let out = null;
        for (const r of res) { lpCtrl(r.m === 'refunded' ? { inquiry: 'refunded' } : {}); const rr = await reconcile({ attempt_uuid: (await attempt(r.o.uuid) || {}).attempt_uuid }); out = rr; await sleep(50); if (rr.status === 429) { await sleep(rr.json.retry_after_ms + 50); await reconcile({ attempt_uuid: (await attempt(r.o.uuid) || {}).attempt_uuid }); } }
        lpCtrl({});
        const after = await Promise.all(res.map(async (r) => (await ord(r.o.uuid)).payment_status));
        const refA = await attempt(res.find((r) => r.m === 'refunded').o.uuid);
        const recovered = res.filter((r, i) => r.m === 'refunded' ? after[i] !== 'paid' : after[i] === 'paid').length;
        assert(out && out.status === 200 && JSON.stringify(res.map((r) => confirmsFor(r.call.tx))) === JSON.stringify(before) && recovered === res.length && refA.status === 'review',
          'C6b [API]〔新介面〕後台核對：唯讀查詢確認已付款者恢復本機紀錄（已退款者仍待人工核對）；不送新的 Confirm', JSON.stringify({ st: out && out.status, after, ref: refA && [refA.status, refA.review_reason] }));
      });
      await step('C7', async () => {
        // 商家設定更換 → 不以新商家查詢舊交易，待人工核對
        lpCtrl({ confirmMode: 'drop', inquiry: 'error' });
        const o = await order(U(83)); const { call } = await lpRequest(o);
        await callback(call); lpCtrl({});
        await editDb((db) => { db.run("UPDATE payment_gateways SET merchant_id='test-channel-c52b', secret_key='test-secret-c52b' WHERE store_id='store_001' AND code='linepay'"); });
        const i0 = inquiriesFor(call.tx);
        const loc = await callback(call);
        const rr = await reconcile({ attempt_uuid: (await attempt(o.uuid) || {}).attempt_uuid });
        const a = await attempt(o.uuid); const x = await ord(o.uuid);
        await editDb((db) => { db.run("UPDATE payment_gateways SET merchant_id='test-channel-c52', secret_key='test-secret-c52' WHERE store_id='store_001' AND code='linepay'"); });
        assert(x.payment_status !== 'paid' && inquiriesFor(call.tx) === i0 && a && a.status === 'review' && /merchant_changed/.test(a.review_reason || '') && /linepay=pending/.test(loc),
          'C7 [API] LINE Pay 商家設定已更換：不以新商家查詢或確認舊交易，保留待人工核對', JSON.stringify({ a: a && [a.status, a.review_reason], rr: rr.status, inq: [i0, inquiriesFor(call.tx)] }));
      });
      await step('C8', async () => {
        // [RS] Confirm 送出後程序被終止（金流已扣款、回應未回）→ 重新啟動後仍找得到並可核對恢復
        lpCtrl({ confirmMode: 'hang' });
        const u = U(84); const o = await order(u); const { call } = await lpRequest(o);
        const pend = fetch(`${C.s.base}/api/linepay/confirm?${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }).catch(() => null);
        for (let i = 0; i < 50 && !confirmsFor(call.tx); i++) await sleep(100);
        await killAndRestart(); lpCtrl({}); await pend;
        const a = await attempt(o.uuid); const x = await ord(o.uuid);
        const rv = await review();
        const listed = rv.json && rv.json.data && rv.json.data.attempts.some((r) => r.order_uuid === o.uuid);
        const rr = await reconcile({ attempt_uuid: a && a.attempt_uuid });
        const x2 = await ord(o.uuid); const ev = await events(o.uuid);
        // 顧客重新整理返回頁也能完成（C5.1 也可驗證的既有入口）
        const loc = await callback(call); const x3 = await ord(o.uuid);
        assert(a && ['confirm_pending', 'confirming'].includes(a.status) && x.payment_status !== 'paid' && listed && x2.payment_status === 'paid' && ev.purchase === 1 && confirmsFor(call.tx) === 1 && x3.payment_status === 'paid' && /success/.test(loc),
          'C8 [RS] Confirm 送出後程序被終止：處理階段已保存在檔案，重新啟動後列入待核對；核對後恢復（Confirm 仍只 1 次）', JSON.stringify({ a: a && a.status, listed, rr: rr.status, x2: x2.payment_status, confirms: confirmsFor(call.tx), loc: loc.slice(0, 60) }));
      });
      await step('C9', async () => {
        // [RS] 核心付款已提交、Analytics 尚未完成時中止 → 重新啟動後自動補齊，各只一次
        lpCtrl({});
        const u = U(85); const o = await order(u); const { call } = await lpRequest(o);
        await editDb((db) => { db.run(`CREATE TRIGGER c52_fail_ev BEFORE INSERT ON analytics_events WHEN NEW.order_id='${o.uuid}' AND NEW.event_name IN ('purchase','payment_success') BEGIN SELECT RAISE(ABORT,'c52 injected'); END`); });
        const loc = await callback(call);
        const x = await ord(o.uuid); const ev0 = await events(o.uuid);
        const se0 = await qOpt("SELECT kind, status FROM payment_side_effects WHERE order_uuid=? ORDER BY kind", [o.uuid]);
        await C.s.proc.kill('SIGKILL'); await sleep(500);
        { const db = await H.openDbFile(C.dbf); try { db.run('DROP TRIGGER IF EXISTS c52_fail_ev'); H.saveDbFile(db, C.dbf); } finally { db.close(); } }
        await restart(); await sleep(4500); // 啟動後補齊
        const ev1 = await events(o.uuid);
        const se1 = await qOpt("SELECT kind, status FROM payment_side_effects WHERE order_uuid=? ORDER BY kind", [o.uuid]);
        await callback(call); await reconcile({}); await sleep(300);
        const ev2 = await events(o.uuid);
        assert(x.payment_status === 'paid' && /success/.test(loc) && !ev0.purchase && se0 && se0.some((r) => r.status === 'pending') && ev1.purchase === 1 && ev1.payment_success === 1 && se1.every((r) => r.status === 'done')
          && JSON.stringify(ev2) === JSON.stringify(ev1),
        'C9 [RS] 核心付款已提交、Analytics 寫入失敗後程序被終止：重新啟動自動補齊 purchase、payment_success 各一次；再次 callback／核對不增加', JSON.stringify({ ev0, se0, ev1, se1, ev2 }));
      });
      await step('C10', async () => {
        // 補登寫到一半再次失敗：會員消費第一次失敗（整筆回滾）→ 下一次完成，只累加一次
        lpCtrl({});
        const u = U(86); const sp0 = await memberSpend(u);
        const o = await order(u); const { call } = await lpRequest(o);
        await editDb((db) => { db.run(`CREATE TRIGGER c52_fail_mem BEFORE UPDATE OF total_spent ON line_members WHEN NEW.line_user_id='${u}' BEGIN SELECT RAISE(ABORT,'c52 injected'); END`); });
        await callback(call);
        const l0 = await links(o.uuid); const sp1 = await memberSpend(u); const ev1 = await events(o.uuid);
        await restart(); await sleep(4000); // 仍有故障：補齊再次失敗
        const l1 = await links(o.uuid);
        await editDb((db) => { db.run('DROP TRIGGER IF EXISTS c52_fail_mem'); }); await sleep(4000);
        await reconcile({}); await sleep(300);
        const l2 = await links(o.uuid); const sp2 = await memberSpend(u);
        await callback(call); await reconcile({});
        const sp3 = await memberSpend(u);
        assert(l0 === 0 && l1 === 0 && Number(sp1.total_spent) === Number(sp0.total_spent) && ev1.purchase === 1 && l2 === 1 && Number(sp2.total_spent) === Number(sp0.total_spent) + Number(o.total) && JSON.stringify(sp3) === JSON.stringify(sp2),
          'C10 [RS] 會員消費補登第一次失敗、重啟後再次失敗：不留下半套（關聯與累計同交易）；故障排除後完成且只累加一次', JSON.stringify({ links: [l0, l1, l2], spend: [sp0.total_spent, sp1.total_spent, sp2.total_spent, sp3.total_spent] }));
      });
      await step('C11', async () => {
        // 同一交易同時兩個 callback＋後台核對同時執行
        lpCtrl({ confirmDelayMs: 800 });
        const u = U(87); const sp0 = await memberSpend(u);
        const o = await order(u); const { call } = await lpRequest(o);
        const [l1, l2, rr] = await Promise.all([callback(call), callback(call), (async () => { await sleep(200); return reconcile({}); })()]);
        lpCtrl({});
        await sleep(300);
        const ev = await events(o.uuid); const sp1 = await memberSpend(u);
        assert(confirmsFor(call.tx) === 1 && ev.purchase === 1 && ev.payment_success === 1 && (await links(o.uuid)) === 1 && Number(sp1.total_spent) === Number(sp0.total_spent) + Number(o.total) && [l1, l2].every((l) => /success|pending/.test(l)),
          'C11 [API] 同時兩個 callback 與後台核對：Confirm 1 次、事件與會員消費各一次', JSON.stringify({ confirms: confirmsFor(call.tx), ev, l: [l1.slice(0, 50), l2.slice(0, 50)], rr: rr.status }));
      });
      await step('C12', async () => {
        // 同一訂單不同付款嘗試、不同訂單或店別的交易不能串接
        lpCtrl({});
        const o = await order(U(88)); const r1 = await lpRequest(o); const r2 = await lpRequest(o);
        const o2 = await order(U(89)); const r3 = await lpRequest(o2);
        const mix1 = await fetch(`${C.s.base}/api/linepay/confirm?${new URL(r2.call.confirmUrl).search.slice(1)}&transactionId=${r1.call.tx}&orderId=${encodeURIComponent(r2.call.orderId)}`, { redirect: 'manual' });
        const mix2 = await fetch(`${C.s.base}/api/linepay/confirm?${new URL(r3.call.confirmUrl).search.slice(1)}&transactionId=${r1.call.tx}&orderId=${encodeURIComponent(r1.call.orderId)}`, { redirect: 'manual' });
        const mix3 = await fetch(`${C.s.base}/api/linepay/confirm?${new URL(r1.call.confirmUrl).search.slice(1).replace('store_id=store_001', 'store_id=store_002')}&transactionId=${r1.call.tx}&orderId=${encodeURIComponent(r1.call.orderId)}`, { redirect: 'manual' });
        const x = await ord(o.uuid), x2 = await ord(o2.uuid);
        assert([r1.call.tx, r2.call.tx, r3.call.tx].every((t) => confirmsFor(t) === 0) && x.payment_status !== 'paid' && x2.payment_status !== 'paid'
          && [mix1, mix2, mix3].every((m) => /linepay=error/.test(m.headers.get('location') || '')),
        'C12 [API] 交易識別與付款嘗試、訂單、店別不符：全部拒絕，不呼叫 Confirm、不改任何訂單', JSON.stringify([mix1, mix2, mix3].map((m) => (m.headers.get('location') || '').slice(0, 70))));
      });
      await step('C13', async () => {
        // 完成後再次 callback／核對：份數、事件、會員消費、補貨轉換都不增加
        const o = C2o; const call = C2call;
        const snap = async () => JSON.stringify([await counters(o.pid), await events(o.uuid), await links(o.uuid), await memberSpend(U(78)),
          (await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [o.uuid]))[0].c, (await ord(o.uuid)).payment_status]);
        const s0 = await snap(); const n0 = confirmsFor(call.tx);
        await callback(call); await callback(call); await sleep(21000); await reconcile({}); await reconcile({ attempt_uuid: (await attempt(o.uuid) || {}).attempt_uuid });
        assert((await snap()) === s0 && confirmsFor(call.tx) === n0, 'C13 [API] 完成後再次 callback 與核對：庫存／份數、事件、會員消費、轉換數都不增加', s0);
      });
      await step('C14', async () => {
        const rv = await review();
        const txt = JSON.stringify(rv.json || {}) + JSON.stringify(lpCalls().map((c) => c.confirmUrl || ''));
        const bad = Object.values(SECRETS).some((sct) => txt.includes(sct)) || /eyJ[A-Za-z0-9_-]{10,}\./.test(txt) || /member_session/.test(txt);
        const anon = await fetch(`${C.s.base}/api/linepay-admin/review?store_id=${STORE}`);
        const anon2 = await fetch(`${C.s.base}/api/linepay-admin/reconcile?store_id=${STORE}`, { method: 'POST' });
        assert(rv.status === 200 && !bad && anon.status === 401 && anon2.status === 401, 'C14 [API]〔新介面〕待核對清單與付款網址不含密鑰、JWT 或會員憑證；未登入不能讀取或核對', JSON.stringify({ st: rv.status, bad, anon: [anon.status, anon2.status] }));
      });
      await step('C15', async () => {
        const calls = lpCalls();
        const bad = calls.filter((c) => c.sig_ok === false);
        const gets = calls.filter((c) => c.method === 'GET');
        assert(bad.length === 0 && gets.length > 0 && gets.every((c) => c.sig_ok === true), 'C15 [API] 所有 Request／Confirm／查詢的簽章經替身核對正確（GET：secret＋path＋query＋nonce）', JSON.stringify({ calls: calls.length, gets: gets.length, bad: bad.length }));
      });
    }

    // ════════════════════════════════ U 組：升級與搬家 ════════════════════════════════
    if (want('U')) {
      await step('U1', async () => {
        // C5.1 留下的付款嘗試：confirming／failed（有交易識別）不憑名稱推定未付款
        lpCtrl({});
        const o1 = await order(U(90)); const r1 = await lpRequest(o1);
        const o2 = await order(U(90)); const r2 = await lpRequest(o2);
        const o3 = await order(U(90)); const r3 = await lpRequest(o3);
        await editDb((db) => {
          if (hasCol(db, 'linepay_payment_attempts', 'state_version')) db.run('UPDATE linepay_payment_attempts SET state_version=0 WHERE order_uuid IN (?,?,?)', [o1.uuid, o2.uuid, o3.uuid]);
          db.run("UPDATE linepay_payment_attempts SET status='confirming' WHERE order_uuid=?", [o1.uuid]);
          db.run("UPDATE linepay_payment_attempts SET status='failed', result_code='1172' WHERE order_uuid=?", [o2.uuid]);
          db.run("UPDATE linepay_payment_attempts SET status='requested' WHERE order_uuid=?", [o3.uuid]);
        });
        const a1 = await attempt(o1.uuid), a2 = await attempt(o2.uuid), a3 = await attempt(o3.uuid);
        // 模擬金流其實已付款（C5.1 標記 failed 的那筆）→ 查詢核對後恢復
        const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[r2.call.tx].confirmed = true; fs.writeFileSync(LP.state, JSON.stringify(st));
        const loc = await callback(r2.call);
        const x2 = await ord(o2.uuid);
        assert(a1.status === 'review' && a2.status === 'review' && a3.status === 'requested' && x2.payment_status === 'paid' && confirmsFor(r2.call.tx) === 0 && /success/.test(loc),
          'U1 [DB][API] 升級：C5.1 的 confirming、failed（有交易識別）轉為待核對；金流其實已付款的那筆以查詢核對恢復（不送 Confirm）', JSON.stringify({ st: [a1.status, a2.status, a3.status], x2: x2.payment_status, confirms: confirmsFor(r2.call.tx) }));
        void r1; void r3;
      });
      let full = null, pend = null;
      await step('U2', async () => {
        // 同店搬移（換主機）：待核對付款與副作用待辦不遺失；匯入不呼叫 LINE Pay
        lpCtrl({ confirmMode: 'drop', inquiry: 'error' });
        const o = await order(U(91)); const { call } = await lpRequest(o); await callback(call); lpCtrl({});
        pend = { o, call };
        full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
        const calls0 = lpCalls().length;
        const T = await C45.boot('c52t', { products: PRODUCTS, seed, env: env(OFF) }); boots.push(T);
        const up = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'c52.json' });
        const cats = JSON.parse(full.buf.toString('utf8')).selected_categories;
        const im = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: cats });
        await sleep(300);
        const db = await H.openDbFile(T.dbf); let a, se;
        try { a = H.q1(db, 'SELECT status, review_reason, transaction_id FROM linepay_payment_attempts WHERE order_uuid=?', [o.uuid]); se = H.q1(db, "SELECT COUNT(*) AS c FROM payment_side_effects WHERE store_id='store_001'"); } catch (e) { a = null; } finally { db.close(); }
        assert(im.import && im.import.status === 'done' && a && a.status === 'review' && a.transaction_id === String(call.tx) && lpCalls().length === calls0,
          'U2 [API] 同店搬移：待核對付款（含完整交易識別）隨訂單匯入、維持待核對；匯入不呼叫 LINE Pay', JSON.stringify({ st: im.import && im.import.status, a, se: se && se.c, calls: lpCalls().length - calls0 }));
      });
      await step('U3', async () => {
        // 同一資料庫跨店匯入：付款資料只當歷史，不被 callback 或核對啟用
        const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
        const up = await H.uploadRaw(C.s.base, tok2, full.buf, { name: 'c52x.json' });
        const im = await H.previewAndImport(C.s.base, tok2, up.json.upload_id, { mode: 'merge', categories: ['orders'], allow_cross_store: true });
        await sleep(300);
        const rows = await qOpt("SELECT status, attempt_uuid, source FROM linepay_payment_attempts WHERE store_id='store_002'");
        const open = (rows || []).filter((r) => ['review', 'confirm_pending', 'requested'].includes(r.status));
        const c0 = lpCalls().length;
        const rr = await adm('POST', '/api/linepay-admin/reconcile', {}, tok2);
        assert(im.import && im.import.status === 'done' && rows && rows.length > 0 && open.length === 0 && rows.every((r) => r.status === 'imported_history' || ['paid', 'paid_cancelled', 'failed', 'aborted_cancelled', 'paid_duplicate'].includes(r.status)) && lpCalls().length === c0,
          'U3 [API] 同一資料庫跨店匯入：付款嘗試只當歷史（imported_history），核對不呼叫 LINE Pay、不啟用', JSON.stringify({ st: im.import && im.import.status, n: rows && rows.length, open: open.length, rr: rr.status }));
      });
    }

    const real = boots.reduce((n, b) => n + b.mf.real(), 0);
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0 && realPay === 0, 'Z 真實 LINE Messaging API 與 LINE Pay（Request／Confirm／查詢／退款）呼叫 0 次', JSON.stringify({ line: real, linepay: realPay, mock: lpCalls().length }));
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally { if (browser) { try { await browser.close(); } catch {} } for (const b of boots) { try { await b.s.stop(); } catch {} } }
  const s = H.summary();
  if (GAP.length) console.log('功能缺口（新介面在此版本不存在）：' + [...new Set(GAP)].join('、'));
  if (process.env.C52_RESULT_JSON) fs.writeFileSync(process.env.C52_RESULT_JSON, JSON.stringify({ root: H.ROOT, pass: s.passCount, fail: s.failCount, gaps: [...new Set(GAP)], results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
