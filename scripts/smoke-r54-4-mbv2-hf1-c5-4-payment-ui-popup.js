#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js
// R54.4／MBV2-HF1-C5.4 —— 付款狀態與明細顯示修正＋快閃 LINE Pay 付款安全與恢復：重現／驗收（同一組案例先跑未修改 C5.3，再跑 C5.4）
//   U  一般訂單付款狀態顯示（伺服器 payment_display、各畫面一致、輪詢涵蓋付款狀態、舊回應不覆蓋、不以返回網址當證據）
//   A  商品明細金額（$0 修正、0 元保留、折扣／外送費／其他差額、舊資料缺欄位）
//   P  快閃 LINE Pay（交易識別字串比對、Confirm 前 durable 保存、結果不明只唯讀核對、完整驗證、取消／逾時／改現金、名額只處理一次、重啟恢復）
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright）；[RS] SIGKILL 後以同一資料庫檔重啟；
//   [FX] 以 fixture 建立的歷史資料（明確標示）；[DB] 直接核對資料庫檔。
// 外部呼叫：LINE Pay 由 c54-linepay-mock 有狀態替身攔截並核對簽章；未知 LINE Pay 路徑立即拋錯並記錄（必須 0 行）。
//   LINE Messaging API 由 c4-line-mock／hf1c3-net-mock 攔截。這些都不是真機、正式金流或 Sandbox 驗證。
// 分類：D＝原始缺陷直接重現；N＝新功能／新介面（基準不存在）；P＝測試前提或替身問題；C＝連帶失敗；G＝主流程回歸保護
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30); // 一律以台北 10:30 執行
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const D = H.tmpDir('c54-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c54': 'test-secret-c54' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const ONLY = (process.env.C54_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const STEP_RE = process.env.C54_STEP ? new RegExp(process.env.C54_STEP) : null;
const META = {};
async function step(name, cls, fn) {
  if (STEP_RE && !STEP_RE.test(name)) return;
  META[name] = { cls };
  try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
}
function sessAt(u, offsetMs) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}
const P = [711, 712, 713, 714];
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }],
  [711, '付款測試甲', 1, 'available', { quota: 400, price: 100 }], [712, '付款測試乙', 2, 'available', { quota: 400, price: 120 }],
  [713, '付款測試丙', 3, 'available', { quota: 400, price: 80 }], [714, '付款測試丁', 4, 'available', { quota: 400, price: 60 }],
  [721, '一元測試品', 5, 'available', { quota: 400, price: 1 }], [722, '百五測試品', 6, 'available', { quota: 400, price: 150 }],
  [731, '快閃測試品', 7, 'available', { quota: 400, price: 90 }]];
const POPUP_SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 15, allow_fallback_cash: true, expire_cancel_release: true };
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c54','test-secret-c54')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(POPUP_SETTINGS)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { coupon: true, reports: true, line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4 付款狀態顯示・商品明細金額・快閃 LINE Pay 付款安全 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
      C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
    const C = await C45.boot('c54', { products: PRODUCTS, members: 60, settings: {}, seed, env: env(OFF) }); boots.push(C);
    const restart = async () => { await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    await restart();
    const killAndRestart = async () => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); await restart(); };
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const today = () => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const dayPlus = (n) => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const editDb = async (fn) => { await C.s.stop(); try { const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } } finally { await restart(); } };
    const durable = (o) => fs.writeFileSync(DUR, JSON.stringify(o || {}));
    let pi = 0;
    const order = async (u, o = {}) => {
      const pid = o.pid || P[pi++ % P.length];
      const body = { customer_name: o.name || '付款測試', customer_phone: o.phone || '0912345678', order_type: 'takeout', pickup_date: today(), pickup_time: '22:30',
        payment_method: o.pay || 'linepay', items: [{ product_id: pid, qty: o.qty || 1 }], analytics: { visitor_id: 'v_c54', session_id: 's_c54' }, member_session: sessAt(u, OFF) };
      const r = await pub('POST', '/api/line-orders', body);
      if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 200));
      return { ...r.json.data, pid };
    };
    const lpRequest = async (o) => {
      const r = await pub('POST', '/api/linepay/request', { order_uuid: o.uuid });
      const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
      return { r, call };
    };
    const callback = async (call) => {
      const sp = new URL(call.confirmUrl).searchParams;
      const r = await fetch(`${C.s.base}/api/linepay/confirm?${sp.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' });
      return r.headers.get('location') || '';
    };
    const queryOrder = async (o) => { const r = await pub('POST', '/api/line-orders/query', { order_number: o.order_number, order_ref: o.uuid }); return r.json && r.json.orders ? r.json.orders[0] : null; };
    const pd = (x) => (x && x.payment_display) || null;
    if (chromium) browser = await chromium.launch(C45.launchOpts());
    const lineCtx = async (extra) => {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
      await ctx.addInitScript((x) => { window.__C54_POLL_MS = 400; try { if (x) for (const [k, v] of Object.entries(x)) localStorage.setItem(k, v); } catch (e) {} }, extra || null);
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      return ctx;
    };
    const openDetail = async (pg, o) => {
      await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => typeof openOrderDetail === 'function', null, { timeout: 15000 });
      await pg.evaluate(async (ref) => { const r = await apiFetch('/api/line-orders/query', { method: 'POST', body: JSON.stringify(ref) }).then((x) => x.json()); openOrderDetail(r.orders[0]); }, { order_number: o.order_number, order_ref: o.uuid });
      await pg.waitForFunction(() => { const el = document.getElementById('detailBody'); return el && el.innerText.length > 20; }, null, { timeout: 8000 });
      return pg.evaluate(() => ({ text: document.getElementById('detailBody').innerText, html: document.getElementById('detailBody').innerHTML, rebuy: /再次購買/.test(document.getElementById('detailBody').querySelector('button.sub-btn') ? document.getElementById('detailBody').innerText : '') && !!Array.from(document.querySelectorAll('#detailBody button')).find((b) => /再次購買/.test(b.textContent)) }));
    };

    // ── 共用 fixture：各種付款狀態的一般 LINE 訂單 ──
    lpCtrl({});
    const FX = {};
    FX.cash = await order(U(1), { pay: 'cash' });
    FX.awaiting = await order(U(2)); await lpRequest(FX.awaiting);
    FX.paid = await order(U(3)); { const { call } = await lpRequest(FX.paid); await callback(call); }
    FX.failed = await order(U(4)); { const { call } = await lpRequest(FX.failed); lpCtrl({ confirm: '1142' }); await callback(call); lpCtrl({}); }
    FX.review = await order(U(5)); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const { call } = await lpRequest(FX.review); await callback(call); lpCtrl({}); FX.reviewCall = call; }
    FX.refund = await order(U(6)); { const { call } = await lpRequest(FX.refund); await callback(call); await adm('PATCH', `/api/orders/${FX.refund.uuid}/status`, { order_status: 'cancelled' }); }
    FX.refunded = await order(U(7)); { const { call } = await lpRequest(FX.refunded); await callback(call); await adm('PATCH', `/api/orders/${FX.refunded.uuid}/status`, { order_status: 'cancelled' }); await adm('POST', `/api/orders/${FX.refunded.uuid}/refund-complete`, { note: 't' }); }
    FX.multi = await order(U(8)); { const { call } = await lpRequest(FX.multi); lpCtrl({ confirm: '1142' }); await callback(call); lpCtrl({}); const { call: c2 } = await lpRequest(FX.multi); await callback(c2); }

    // ═══════════════════════ U：一般訂單付款狀態顯示 ═══════════════════════
    if (want('U')) {
      await step('U1', 'N', async () => {
        const want1 = { cash: 'pay_at_pickup', awaiting: 'awaiting_payment', paid: 'paid', failed: 'failed', review: 'under_review', refund: 'paid_refund_pending', refunded: 'refunded', multi: 'paid' };
        const got = {};
        for (const k of Object.keys(want1)) { const x = await queryOrder(FX[k]); got[k] = pd(x) ? pd(x).state : null; }
        const hist = await pub('POST', '/api/line-orders/history', { phone: '0912345678' });
        const st = await pub('GET', `/api/line-orders/status/${encodeURIComponent(FX.review.order_number)}?ref=${FX.review.uuid}`);
        const hRev = hist.json && hist.json.orders ? hist.json.orders.find((o) => o.order_number === FX.review.order_number) : null;
        assert(Object.keys(want1).every((k) => got[k] === want1[k]) && pd(hRev) && pd(hRev).state === 'under_review' && st.json && st.json.data && pd(st.json.data) && pd(st.json.data).state === 'under_review',
          'U1 [API] 查詢訂單／我的訂單／狀態輪詢都回傳伺服器付款顯示狀態：現金=取餐時付款、未付款=等待付款、已付款、確定失敗、待核對、已付款取消=待退款、已退款、多次嘗試（先拒絕後成功）=已付款', JSON.stringify(got));
      });
      await step('U2', 'D', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await lineCtx(); const pg = await ctx.newPage();
        const f = await openDetail(pg, FX.failed); const c = await openDetail(pg, FX.cash); const r = await openDetail(pg, FX.refund);
        await ctx.close();
        assert(/訂單狀態[\s\S]*待確認/.test(f.text) && /付款狀態[\s\S]*付款失敗，本次付款未完成/.test(f.text) && /付款狀態[\s\S]*取餐時付款/.test(c.text) && /已付款・待退款/.test(r.text) && !/付款成功/.test(f.text),
          'U2 [BR] 訂單詳情：訂單狀態（待確認）與付款狀態分開顯示；確定失敗顯示「付款失敗，本次付款未完成」、現金顯示「取餐時付款」、已付款取消顯示「已付款・待退款」', JSON.stringify({ f: f.text.slice(0, 160), c: c.text.slice(0, 80) }));
      });
      await step('U3', 'D', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await lineCtx({ line_customer_phone: '0912345678' }); const pg = await ctx.newPage();
        const d = await openDetail(pg, FX.review);
        await pg.evaluate(() => openMyOrders());
        await pg.waitForFunction(() => document.querySelectorAll('#myOrdersBody .order-card').length > 0, null, { timeout: 8000 });
        const card = await pg.evaluate((no) => { const c = Array.from(document.querySelectorAll('#myOrdersBody .order-card')).find((x) => x.innerText.includes(no)); return c ? { text: c.innerText, rebuy: !!c.querySelector('.btn-reorder') } : null; }, FX.review.order_number);
        await ctx.close();
        assert(/付款結果確認中，請勿重複付款/.test(d.text) && !d.rebuy && card && /付款結果確認中/.test(card.text) && !card.rebuy,
          'U3 [BR] 待核對訂單：詳情與我的訂單卡片都顯示「付款結果確認中，請勿重複付款」，不提供「再次購買／再購」', JSON.stringify({ detailRebuy: d.rebuy, card }));
      });
      await step('U4', 'D', async () => {
        // [BR] 只改付款狀態（履約狀態不變）時，輪詢會更新畫面：待核對 → 後台唯讀核對確認已付款
        if (!browser) throw new Error('需要瀏覽器');
        lpCtrl({ confirmMode: 'drop', inquiry: 'error' });
        const o = await order(U(9)); const { call } = await lpRequest(o); await callback(call); lpCtrl({});
        const before = await queryOrder(o);
        const ctx = await lineCtx(); const pg = await ctx.newPage();
        await openDetail(pg, o);
        const t0 = await pg.evaluate(() => document.getElementById('detailBody').innerText);
        const a = (await q('SELECT attempt_uuid FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [o.uuid]))[0];
        const rc = await adm('POST', '/api/linepay-admin/reconcile', { attempt_uuid: a.attempt_uuid });
        let t1 = '';
        for (let i = 0; i < 20; i++) { await sleep(300); t1 = await pg.evaluate(() => document.getElementById('detailBody').innerText); if (/已付款/.test(t1)) break; }
        const after = await queryOrder(o);
        await ctx.close();
        assert(before.status === after.status && /付款結果確認中/.test(t0) && /付款狀態[\s\S]*已付款/.test(t1) && !/付款結果確認中/.test(t1) && rc.status === 200,
          'U4 [BR] 只改付款狀態、不改履約狀態（皆為待確認）時，詳情畫面經輪詢由「付款結果確認中」更新為「已付款」', JSON.stringify({ st: [before.status, after.status], t1: t1.slice(0, 120), rc: rc.status }));
      });
      await step('U5', 'D', async () => {
        // [BR] 返回網址 linepay=success 不是付款證據：伺服器仍待核對時，不顯示付款成功、不清空購物車
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await lineCtx({ line_cart_store_001: JSON.stringify({ x: 1 }) }); const pg = await ctx.newPage();
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&linepay=success&order=${encodeURIComponent(FX.review.order_number)}&order_ref=${FX.review.uuid}`, { waitUntil: 'domcontentloaded' });
        await sleep(2500);
        const ui = await pg.evaluate(() => ({ text: (document.getElementById('sucDetail') || {}).innerText || '', keys: Object.keys(localStorage) }));
        const ui2 = await (async () => {
          await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&linepay=success&order=${encodeURIComponent(FX.paid.order_number)}&order_ref=${FX.paid.uuid}`, { waitUntil: 'domcontentloaded' });
          await sleep(2500); return pg.evaluate(() => ((document.getElementById('sucDetail') || {}).innerText || ''));
        })();
        await ctx.close();
        assert(!/付款成功/.test(ui.text) && /付款結果確認中/.test(ui.text) && /付款成功/.test(ui2),
          'U5 [BR] 返回網址帶 linepay=success、但伺服器為待核對：顯示「付款結果確認中」不顯示付款成功；伺服器已付款者才顯示付款成功', JSON.stringify({ review: ui.text.slice(0, 80), paid: ui2.slice(0, 60) }));
      });
      await step('U6', 'D', async () => {
        // [BR] 切換帳號：較慢的舊查詢回應不得覆蓋新帳號的訂單清單
        if (!browser) throw new Error('需要瀏覽器');
        const other = await order(U(10), { pay: 'cash', phone: '0922333444', name: '另一位' });
        const ctx = await lineCtx(); const pg = await ctx.newPage();
        await pg.route('**/api/line-orders/history**', async (route) => {
          const body = route.request().postData() || '';
          if (body.includes('0912345678')) await sleep(1800);
          route.continue();
        });
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
        await pg.waitForFunction(() => typeof loadMyOrders === 'function', null, { timeout: 15000 });
        await pg.evaluate(() => { openSheet('myOrdersSheet'); loadMyOrders('0912345678'); });
        await sleep(200);
        await pg.evaluate(() => { clearMyOrdersLogin(); loadMyOrders('0922333444'); });
        await sleep(2800);
        const t = await pg.evaluate(() => document.getElementById('myOrdersBody').innerText);
        await ctx.close();
        assert(t.includes(other.order_number) && !t.includes(FX.cash.order_number),
          'U6 [BR] 我的訂單切換帳號：先送出但較慢回來的舊帳號查詢，不會覆蓋新帳號的訂單與付款資料', JSON.stringify({ has_new: t.includes(other.order_number), has_old: t.includes(FX.cash.order_number) }));
      });
      await step('U7', 'N', async () => {
        // [API][FX] 同一訂單多次付款嘗試：較早一筆待核對、最新一筆確定失敗 → 仍顯示待核對（不被最新失敗蓋過）
        const o = await order(U(11)); lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const { call } = await lpRequest(o); await callback(call); lpCtrl({});
        await editDb((db) => {
          db.run(`INSERT INTO linepay_payment_attempts (attempt_uuid, store_id, order_uuid, order_number, lp_order_id, amount, currency, status, result_code, failure_basis, confirm_state, created_at, updated_at, source)
                  VALUES (?,?,?,?,?,?,?,'failed','1142','first_confirm_declined:1142','sent',datetime('now'),datetime('now'),'request')`, [crypto.randomUUID(), STORE, o.uuid, o.order_number, o.order_number + '-R9', 100, 'TWD']);
        });
        const x = await queryOrder(o);
        assert(pd(x) && pd(x).state === 'under_review' && pd(x).blocks_repay === true, 'U7 [API][FX] 多次付款嘗試：較早待核對＋最新確定失敗 → 仍為「付款結果確認中」、阻擋重新付款', JSON.stringify(pd(x)));
      });
      await step('U8', 'D', async () => {
        // [API][FX] 宅配：待核對付款的宅配訂單，查詢顯示「付款結果確認中」（不是「待付款」）；[BR] 返回成功網址不顯示付款成功、不清空購物車
        const no = 'SHIP-C54-' + crypto.randomBytes(3).toString('hex').toUpperCase(); const uuid = crypto.randomUUID();
        await editDb((db) => {
          db.run(`INSERT INTO orders (id, uuid, order_number, store_id, source, order_mode, fulfillment_type, order_status, status, payment_method, payment_status, total, subtotal, shipping_fee, items, customer_name, customer_phone, shipping_phone, shipping_recipient_name, created_at)
                  VALUES (?,?,?,?, 'line','shipping','shipping','pending','pending','linepay','pending', 380, 300, 80, ?, '宅配測試','0933111222','0933111222','宅配測試', datetime('now','localtime'))`,
          [uuid, uuid, no, STORE, JSON.stringify([{ product_id: 722, name: '百五測試品', price: 150, qty: 2 }])]);
          db.run(`INSERT INTO linepay_payment_attempts (attempt_uuid, store_id, order_uuid, order_number, lp_order_id, amount, currency, status, review_reason, confirm_state, transaction_id, created_at, updated_at, source)
                  VALUES (?,?,?,?,?,380,'TWD','review','confirm_no_response','sent','9000000000000000001',datetime('now'),datetime('now'),'request')`, [crypto.randomUUID(), STORE, uuid, no, no]);
        });
        const r = await pub('GET', `/api/line-shipping/order/${encodeURIComponent(no)}?ref=${uuid}`);
        let br = { text: '', cart: true };
        if (browser) {
          const ctx = await lineCtx(); const pg = await ctx.newPage();
          await pg.goto(`${C.s.base}/line-shipping.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
          const cartKey = await pg.evaluate(() => { try { return (typeof SHIP_CART_KEY !== 'undefined' && SHIP_CART_KEY) || null; } catch (e) { return null; } });
          await pg.evaluate((k) => { if (k) localStorage.setItem(k, JSON.stringify({ items: [{ id: 722, qty: 1 }] })); }, cartKey);
          await pg.goto(`${C.s.base}/line-shipping.html?store_id=${STORE}&linepay=success&order=${encodeURIComponent(no)}&order_ref=${uuid}`, { waitUntil: 'domcontentloaded' });
          await sleep(2500);
          br = await pg.evaluate((k) => ({ text: (document.getElementById('sucDetail') || {}).innerText || '', cart: k ? !!localStorage.getItem(k) : null }), cartKey);
          await ctx.close();
        }
        const d = r.json && r.json.data;
        assert(d && /付款結果確認中/.test(d.payment_status_label || '') && !/付款成功/.test(br.text) && br.cart === true,
          'U8 [API][FX][BR] 宅配：待核對付款顯示「付款結果確認中」；返回成功網址時不顯示付款成功、不清空購物車', JSON.stringify({ label: d && d.payment_status_label, br }));
      });
      await step('U9', 'D', async () => {
        // [BR] 後台訂單列表：待核對的 LINE Pay 訂單顯示「付款結果確認中」，不只顯示付款方式或「待付款」
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        await ctx.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); }, [C.tok]);
        const pg = await ctx.newPage(); pg.on('dialog', (dl) => dl.dismiss());
        await pg.goto(C.s.base + '/');
        await pg.waitForFunction(() => typeof renderOrdersTable === 'function', null, { timeout: 15000 });
        const ui = await pg.evaluate(async (nos) => {
          const j = await apiFetch(`/api/orders?date_from=2000-01-01&date_to=2100-01-01`).then((r) => r.json());
          renderOrdersTable(j.data);
          const row = (no) => { const tr = Array.from(document.querySelectorAll('#ordersBody tr')).find((x) => x.innerText.includes(no)); return tr ? tr.innerText : ''; };
          return { review: row(nos[0]), failed: row(nos[1]), paid: row(nos[2]) };
        }, [FX.review.order_number, FX.failed.order_number, FX.paid.order_number]);
        await ctx.close();
        assert(/付款結果確認中/.test(ui.review) && /付款失敗/.test(ui.failed) && /已付款/.test(ui.paid),
          'U9 [BR] 後台訂單列表：待核對顯示「付款結果確認中」、確定失敗顯示「付款失敗」、已付款顯示「已付款」', JSON.stringify({ review: ui.review.replace(/\s+/g, ' ').slice(0, 120) }));
      });
    }

    // ═══════════════════════ A：商品明細金額 ═══════════════════════
    if (want('A')) {
      const a1 = await order(U(12), { pid: 721, pay: 'cash' });
      const a2 = await order(U(13), { pid: 722, qty: 2, pay: 'cash' });
      await step('A1', 'D', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await lineCtx(); const pg = await ctx.newPage();
        const d1 = await openDetail(pg, a1); const d2 = await openDetail(pg, a2);
        await ctx.close();
        const line = (t, name) => (t.split('\n').find((l) => l.includes(name)) || '') + '|' + (t.split('\n')[t.split('\n').findIndex((l) => l.includes(name)) + 1] || '');
        assert(/\$1\b/.test(line(d1.text, '一元測試品')) && /\$300\b/.test(line(d2.text, '百五測試品')) && /合計金額[\s\S]*\$1\b/.test(d1.text) && /合計金額[\s\S]*\$300\b/.test(d2.text),
          'A1 [BR] 一般訂單詳情商品明細：1 元商品顯示 $1、150 元×2 顯示 $300（不再是 $0），與合計一致', JSON.stringify({ l1: line(d1.text, '一元測試品'), l2: line(d2.text, '百五測試品') }));
      });
      await step('A2', 'D', async () => {
        // [API][FX] 舊資料與折扣／外送費：0 元保留、缺金額顯示資料不足、合法歷史行小計沿用、折扣與外送費列出、不改寫歷史資料
        const mk = (items, extra) => ({ uuid: crypto.randomUUID(), no: 'LINE-C54A-' + crypto.randomBytes(3).toString('hex').toUpperCase(), items, ...extra });
        const fx = {
          zero: mk([{ product_id: 1, name: '贈品', price: 0, qty: 1 }], { total: 0 }),
          disc: mk([{ product_id: 2, name: '折扣品', price: 150, qty: 2 }], { total: 250, discount_amount: 50 }),
          deliv: mk([{ product_id: 3, name: '外送品', price: 100, qty: 1 }], { total: 160, delivery_fee: 60, mode: 'delivery' }),
          legacy: mk([{ product_id: 4, name: '舊資料品', qty: 1 }], { total: 120 }),
          stored: mk([{ product_id: 5, name: '舊行小計品', price: 100, qty: 2, subtotal: 180 }], { total: 180 }),
        };
        await editDb((db) => {
          for (const x of Object.values(fx)) {
            db.run(`INSERT INTO orders (id, uuid, order_number, store_id, source, order_mode, order_status, status, payment_method, payment_status, total, subtotal, discount_amount, delivery_fee, items, customer_name, customer_phone, created_at)
                    VALUES (?,?,?,?, 'line',?, 'pending','pending','cash','pending', ?, ?, ?, ?, ?, '舊資料','0955000111', datetime('now','localtime'))`,
            [x.uuid, x.uuid, x.no, STORE, x.mode || 'takeout', x.total, x.total, x.discount_amount || 0, x.delivery_fee || 0, JSON.stringify(x.items)]);
          }
        });
        const before = await q('SELECT uuid, total, items, discount_amount, delivery_fee FROM orders WHERE customer_phone=?', ['0955000111']);
        const out = {};
        for (const [k, x] of Object.entries(fx)) out[k] = await queryOrder({ order_number: x.no, uuid: x.uuid });
        let br = { zero: '', legacy: '', disc: '' };
        if (browser) {
          const ctx = await lineCtx(); const pg = await ctx.newPage();
          br.zero = (await openDetail(pg, { order_number: fx.zero.no, uuid: fx.zero.uuid })).text;
          br.legacy = (await openDetail(pg, { order_number: fx.legacy.no, uuid: fx.legacy.uuid })).text;
          br.disc = (await openDetail(pg, { order_number: fx.disc.no, uuid: fx.disc.uuid })).text;
          await ctx.close();
        }
        const after = await q('SELECT uuid, total, items, discount_amount, delivery_fee FROM orders WHERE customer_phone=?', ['0955000111']);
        const li = (k) => out[k] && out[k].items && out[k].items[0];
        const bd = (k) => out[k] && out[k].amount_breakdown;
        assert(li('zero') && li('zero').line_subtotal === 0 && li('disc').line_subtotal === 300 && bd('disc').discount_amount === 50 && bd('disc').other_adjustment === 0
          && bd('deliv').delivery_fee === 60 && bd('deliv').other_adjustment === 0 && li('legacy').line_subtotal === null && bd('legacy').items_incomplete === true
          && li('stored').line_subtotal === 180 && JSON.stringify(before) === JSON.stringify(after)
          && /贈品[\s\S]*\$0/.test(br.zero) && /金額資料不足/.test(br.legacy) && !/舊資料品[^\n]*\n?\s*\$0/.test(br.legacy) && /優惠折扣[\s\S]*-\$50/.test(br.disc) && /\$300/.test(br.disc),
          'A2 [API][FX][BR] 0 元商品顯示 $0；折扣列 -$50、外送費 $60 清楚列出且差額為 0；舊資料缺金額顯示「金額資料不足」（不捏造 $0）；合法歷史行小計沿用；查詢不改寫訂單', JSON.stringify({ zero: li('zero'), legacy: li('legacy'), disc: bd('disc'), deliv: bd('deliv'), brLegacy: br.legacy.slice(0, 200) }));
      });
    }

    // ═══════════════════════ P：快閃 LINE Pay 付款安全與恢復 ═══════════════════════
    if (want('P')) {
      const camp = await adm('POST', '/api/popup-pickup/campaigns', { name: 'C54 快閃', status: 'published' });
      const loc = await adm('POST', '/api/popup-pickup/locations', { name: 'C54 地點', address: '台北市中正區測試路1號', lat: 25.04, lng: 121.51 });
      const sess = await adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'C54 場次', status: 'published', pickup_date: dayPlus(2), pickup_start_time: '17:00', pickup_end_time: '19:00',
        order_open_at: '2026-01-01T00:00', order_cutoff_at: dayPlus(1) + 'T23:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 500 });
      if (!sess.json || !sess.json.success) throw new Error('popup session ' + JSON.stringify(sess.json).slice(0, 300));
      const SC = sess.json.data.public_code;
      let ph = 100;
      const pOrder = async (pay = 'linepay', qty = 1) => {
        const r = await fetch(`${C.s.base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c54k' + crypto.randomBytes(10).toString('hex') },
          body: JSON.stringify({ popup_session_public_code: SC, customer_name: '快閃測試', customer_phone: '0911000' + String(ph++).padStart(3, '0'), payment_method: pay, items: [{ product_id: 731, qty }] }) });
        const j = await r.json();
        if (!j.success) throw new Error('popup checkout ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
        return j.data;
      };
      const pRequest = async (o) => {
        const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) });
        const j = await r.json();
        const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
        return { status: r.status, j, call };
      };
      const pCb = async (call, over = {}) => {
        const u = new URL(call.confirmUrl);
        const tx = over.tx != null ? over.tx : call.tx;
        const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}&transactionId=${tx}&orderId=${encodeURIComponent(over.orderId || call.orderId)}`, { redirect: 'manual' });
        return { status: r.status, loc: r.headers.get('location') || '' };
      };
      const pCancelCb = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
      const pStatus = async (o) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/status?token=${o.payment.token}`); return (await r.json()).data; };
      const pCash = async (o) => (await fetch(`${C.s.base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) })).status;
      const pAtt = async (o) => (await q('SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [o.payment.ref]))[0];
      const pOrd = async (o) => (await q('SELECT * FROM orders WHERE id=?', [o.id]))[0];
      const pAlloc = async (o) => q('SELECT status, stock_state FROM popup_order_allocations WHERE order_id=?', [o.id]);
      const pPaidStates = (a) => a && ['paid', 'paid_cancelled'].includes(a.status);

      await step('P1', 'G', async () => {
        lpCtrl({});
        const o = await pOrder(); const { call } = await pRequest(o);
        const r1 = await pCb(call); const r2 = await pCb(call); const r3 = await pCb(call);
        const a = await pAtt(o); const x = await pOrd(o); const al = await pAlloc(o);
        assert(/popup_pay_result=paid/.test(r1.loc) && /paid/.test(r3.loc) && confirmsFor(call.tx) === 1 && a.status === 'paid' && x.payment_status === 'paid'
          && al.length === 1 && al[0].status === 'active' && al[0].stock_state === 'committed',
          'P1 [API] 快閃正常付款：Confirm 1 次、已付款、名額由保留轉已成立一次；重複 callback ×2 不再 Confirm、不重複轉換', JSON.stringify({ confirms: confirmsFor(call.tx), a: a.status, al }));
      });
      await step('P2', 'G', async () => {
        lpCtrl({});
        const o = await pOrder(); const { call } = await pRequest(o);
        const loc = await pCancelCb(call); const a = await pAtt(o); const cash = await pCash(o); const x = await pOrd(o);
        assert(/cancelled/.test(loc) && a.status === 'failed' && confirmsFor(call.tx) === 0 && cash === 200 && x.payment_method === 'cash',
          'P2 [API] 付款前顧客在 LINE Pay 取消：確定未付款（Confirm 0 次）；店家允許時可改現金', JSON.stringify({ a: a.status, cash, pm: x.payment_method }));
      });
      await step('P3', 'D', async () => {
        lpCtrl({});
        const o = await pOrder(); const { call } = await pRequest(o);
        const c = await adm('PATCH', `/api/orders/${o.id}/status`, { order_status: 'cancelled' });
        const r = await pCb(call); const a = await pAtt(o); const x = await pOrd(o); const al = await pAlloc(o);
        assert(c.status === 200 && confirmsFor(call.tx) === 0 && !pPaidStates(a) && x.order_status === 'cancelled' && x.payment_status !== 'paid' && al.every((z) => z.status === 'released'),
          'P3 [API] 付款前店家已取消訂單：顧客之後完成授權回到 callback → 不送 Confirm（不請款）、維持取消、名額維持釋放', JSON.stringify({ confirms: confirmsFor(call.tx), a: a.status, ps: x.payment_status, loc: r.loc.slice(-40) }));
      });
      await step('P4', 'D', async () => {
        lpCtrl({ confirmDelayMs: 1800 });
        const o = await pOrder(); const { call } = await pRequest(o);
        const cbP = pCb(call);
        await sleep(500);
        const c = await adm('PATCH', `/api/orders/${o.id}/status`, { order_status: 'cancelled' });
        const r = await cbP; lpCtrl({});
        const a = await pAtt(o); const x = await pOrd(o); const al = await pAlloc(o);
        assert(confirmsFor(call.tx) === 1 && a.status === 'paid_cancelled' && x.order_status === 'cancelled' && x.payment_status === 'paid' && x.refund_status === 'pending_refund' && al.every((z) => z.status === 'released'),
          'P4 [API] 付款中（Confirm 進行中）店家取消訂單：付款成功後保留取消、標待退款，不恢復出餐、不搶回已釋放名額', JSON.stringify({ c: c.status, a: a.status, o: [x.order_status, x.payment_status, x.refund_status], al, loc: r.loc.slice(-30) }));
      });
      let p5 = null;
      await step('P5', 'D', async (m) => {
        // 回應遺失（金流已扣款）、唯讀查詢回 1150：不推定未付款；再次 callback 不再 Confirm；不能改現金／重新付款
        lpCtrl({ confirmMode: 'drop', inquiry: '1150' });
        const o = await pOrder(); const { call } = await pRequest(o);
        const r1 = await pCb(call); lpCtrl({ inquiry: '1150' }); const r2 = await pCb(call);
        const a = await pAtt(o); const s = await pStatus(o); const cash = await pCash(o); const re = await pRequest(o);
        const x = await pOrd(o);
        m.confirms = confirmsFor(call.tx);
        p5 = { o, call };
        assert(confirmsFor(call.tx) === 1 && a.status === 'review' && x.payment_status === 'pending' && x.order_status !== 'cancelled' && s.state === 'payment_under_review' && s.can_pay === false && s.can_switch_to_cash === false && cash === 409 && re.status === 409,
          'P5 [API] 快閃 Confirm 回應遺失＋查詢 1150：維持待核對（不判失敗、不取消）；再次 callback 外部 Confirm 仍 1 次；改現金與重新付款都被拒絕（409）', JSON.stringify({ confirms: confirmsFor(call.tx), a: a.status, s: s && s.state, cash, re: re.status, loc: [r1.loc.slice(-25), r2.loc.slice(-25)] }));
      });
      await step('P6', 'D', async () => {
        // 19 位交易識別：Confirm 0000 回傳的交易識別只差最後一位（JS Number 下相等），且唯讀查詢失敗 → 不得標示已付款
        lpCtrl({ confirmBody: 'txNear', inquiry: 'error' });
        const o = await pOrder(); const { call } = await pRequest(o);
        await pCb(call); lpCtrl({});
        const a = await pAtt(o); const x = await pOrd(o);
        const nearEq = Number(call.tx) === Number(call.tx.slice(0, -1) + String((Number(call.tx.slice(-1)) + 1) % 10));
        assert(String(call.tx).length === 19 && nearEq && a.status === 'review' && x.payment_status !== 'paid' && String(a.transaction_id) === String(call.tx),
          'P6 [API] 19 位交易識別：回應識別與保存值只差最後一位（Number 比對會相等）→ 字串比對不符、唯讀查詢失敗 → 待核對、不標已付款；保存值完整', JSON.stringify({ tx: call.tx, stored: a.transaction_id, a: a.status, nearEq }));
      });
      await step('P7', 'D', async () => {
        // Confirm 只回 0000（缺 info）：先唯讀核對，查詢完整相符才完成付款；未知代碼 1999＋查無 → 待核對
        lpCtrl({ confirmBody: 'only0000' });
        const o = await pOrder(); const { call } = await pRequest(o); await pCb(call); lpCtrl({});
        const a = await pAtt(o);
        lpCtrl({ confirm: '1999', inquiry: 'empty' });
        const o2 = await pOrder(); const { call: c2 } = await pRequest(o2); await pCb(c2); lpCtrl({});
        const a2 = await pAtt(o2); const cash2 = await pCash(o2);
        assert(a.status === 'paid' && confirmsFor(call.tx) === 1 && a2.status === 'review' && confirmsFor(c2.tx) === 1 && cash2 === 409,
          'P7 [API] Confirm 只回 0000：經唯讀查詢完整核對後才完成付款；未知代碼 1999＋查無資料：待核對、不能改現金', JSON.stringify({ a: a.status, a2: a2.status, cash2 }));
      });
      await step('P8', 'D', async () => {
        // 並行 callback ×3（Confirm 回應延遲）：外部 Confirm 只 1 次
        lpCtrl({ confirmDelayMs: 900 });
        const o = await pOrder(); const { call } = await pRequest(o);
        await Promise.all([pCb(call), pCb(call), pCb(call)]); lpCtrl({});
        await sleep(300);
        const a = await pAtt(o); const al = await pAlloc(o);
        assert(confirmsFor(call.tx) === 1 && a.status === 'paid' && al.length === 1 && al[0].stock_state === 'committed',
          'P8 [API] 並行 callback ×3：外部 Confirm 只 1 次、已付款、名額只轉換一次', JSON.stringify({ confirms: confirmsFor(call.tx), a: a.status }));
      });
      await step('P9', 'D', async () => {
        // Confirm 前 durable 保存失敗：外部 Confirm 0 次；下一次 callback 正常送出第一次並完成（全程 1 次）
        lpCtrl({});
        const o = await pOrder(); const { call } = await pRequest(o);
        durable({ fail: 1 }); const r1 = await pCb(call); const c1 = confirmsFor(call.tx); durable({});
        const r2 = await pCb(call); const a = await pAtt(o);
        assert(c1 === 0 && confirmsFor(call.tx) === 1 && a.status === 'paid',
          'P9 [API] 快閃 Confirm 前保存失敗：當次外部 Confirm 0 次；下一次 callback 送出第一次並完成付款（全程 1 次）', JSON.stringify({ c1, confirms: confirmsFor(call.tx), a: a.status, loc: [r1.loc.slice(-20), r2.loc.slice(-20)] }));
      });
      await step('P10', 'D', async () => {
        // 履約逾時與付款結果分開：Confirm 進行中逾時 → 依設定取消並釋放名額，但不宣告未付款；之後確認已付款 → 待退款、不搶回名額
        lpCtrl({});
        const o = await pOrder(); const { call } = await pRequest(o);
        await editDb((db) => { db.run('UPDATE popup_payment_attempts SET expires_at=? WHERE attempt_id=?', [Date.now() + 6000, o.payment.ref] /* 伺服器時鐘（c4-test-clock 偏移後） */); });
        const tCb = Date.now();
        lpCtrl({ confirmDelayMs: 8000 });
        const cbP = pCb(call);
        await sleep(Math.max(500, 7000 - (Date.now() - tCb)));
        const mid = await pStatus(o); const midAtt = await pAtt(o); const midOrd = await pOrd(o);
        await cbP; lpCtrl({});
        const a = await pAtt(o); const x = await pOrd(o); const al = await pAlloc(o);
        assert(confirmsFor(call.tx) === 1 && midOrd.order_status === 'cancelled' && midOrd.payment_status === 'pending' && !['expired', 'failed'].includes(midAtt.status)
          && a.status === 'paid_cancelled' && x.order_status === 'cancelled' && x.payment_status === 'paid' && x.refund_status === 'pending_refund' && al.every((z) => z.status === 'released'),
          'P10 [API] Confirm 進行中履約逾時：依設定取消、釋放名額但不判定未付款；付款成功晚到 → 已付款・待退款、維持取消、名額不搶回', JSON.stringify({ mid: [midAtt.status, midOrd.order_status, midOrd.payment_status, mid && mid.state], end: [a.status, x.order_status, x.payment_status, x.refund_status], al }));
      });
      await step('P11', 'D', async () => {
        // [RS] Confirm 送出後程序被 SIGKILL：重啟後列為待核對；callback 只做唯讀查詢（外部 Confirm 仍 1 次）並完成付款
        lpCtrl({ confirmMode: 'hang' });
        const o = await pOrder(); const { call } = await pRequest(o);
        pCb(call).catch(() => {});
        for (let i = 0; i < 40 && confirmsFor(call.tx) < 1; i++) await sleep(100);
        await killAndRestart(); lpCtrl({});
        const a0 = await pAtt(o);
        const r = await pCb(call); const a = await pAtt(o);
        const rv = await adm('GET', '/api/linepay-admin/review');
        assert(confirmsFor(call.tx) === 1 && a0.status === 'review' && a.status === 'paid' && rv.status === 200,
          'P11 [API][RS] Confirm 送出後程序中斷：重啟後為待核對；callback 只唯讀查詢、外部 Confirm 仍 1 次、完成付款', JSON.stringify({ confirms: confirmsFor(call.tx), a0: a0 && a0.status, a: a.status, loc: r.loc.slice(-25) }));
      });
      await step('P12', 'N', async () => {
        // [API] 後台待核對面板資料含快閃；唯讀核對（查無）不再 Confirm、仍待核對；金流端確認已付款後完成
        if (!p5) throw new Error('需要 P5');
        lpCtrl({ inquiry: '1150' });
        const rv = await adm('GET', '/api/linepay-admin/review');
        const listed = rv.json && rv.json.data && Array.isArray(rv.json.data.popup_attempts) && rv.json.data.popup_attempts.some((x) => x.attempt_id === p5.o.payment.ref);
        const r1 = await adm('POST', '/api/linepay-admin/reconcile', { popup_attempt_id: p5.o.payment.ref });
        const a1 = await pAtt(p5.o);
        lpCtrl({}); await sleep(10200);
        const r2 = await adm('POST', '/api/linepay-admin/reconcile', { popup_attempt_id: p5.o.payment.ref });
        const a2 = await pAtt(p5.o); const al = await pAlloc(p5.o);
        assert(listed && r1.status === 200 && a1.status === 'review' && r2.status === 200 && a2.status === 'paid' && confirmsFor(p5.call.tx) === 1 && al[0].stock_state === 'committed',
          'P12 [API] 後台待核對含快閃付款；唯讀核對查無 → 仍待核對；金流已付款 → 完成付款（全程外部 Confirm 1 次、名額轉換一次）', JSON.stringify({ listed, a1: a1.status, a2: a2.status, r: [r1.status, r2.status] }));
      });
      await step('P13', 'G', async () => {
        // 確定拒絕（1142）：未付款，依設定允許改現金；callback 簽章錯誤 → 400、Confirm 0
        lpCtrl({ confirm: '1142' });
        const o = await pOrder(); const { call } = await pRequest(o); await pCb(call); lpCtrl({});
        const a = await pAtt(o); const cash = await pCash(o);
        const o2 = await pOrder(); const { call: c2 } = await pRequest(o2);
        const bad = await fetch(new URL(c2.confirmUrl).toString().replace(/cb=[0-9a-f]+/, 'cb=' + 'a'.repeat(64)) + `&transactionId=${c2.tx}&orderId=${c2.orderId}`, { redirect: 'manual' });
        assert(a.status === 'failed' && cash === 200 && bad.status === 400 && confirmsFor(c2.tx) === 0,
          'P13 [API] 第一次 Confirm 被明確拒絕（1142）：確定未付款、可依設定改現金；callback 驗證失敗 400、不送 Confirm', JSON.stringify({ a: a.status, cash, bad: bad.status }));
      });
      await step('P14', 'N', async () => {
        // [FX][RS] 升級前（C5.3）留下的快閃付款紀錄：可能已付款的失敗 → 隔離待核對（不能改現金）；送出 Confirm 前的失敗 → 不變；有交易識別的 pending → 只唯讀核對
        lpCtrl({});
        const oa = await pOrder(); const { call: ca } = await pRequest(oa);
        const ob = await pOrder(); await pRequest(ob);
        const oc = await pOrder(); const { call: cc } = await pRequest(oc);
        await editDb((db) => {
          const cols = db.exec('PRAGMA table_info(popup_payment_attempts)')[0].values.map((r) => r[1]);
          const reset = cols.includes('confirm_state') ? ", confirm_state=NULL, failure_basis='', state_version=0" : '';
          db.run(`UPDATE popup_payment_attempts SET status='failed', fail_reason='provider_declined'${reset} WHERE attempt_id=?`, [oa.payment.ref]);
          db.run(`UPDATE popup_payment_attempts SET status='failed', fail_reason='customer_cancelled'${reset} WHERE attempt_id=?`, [ob.payment.ref]);
          if (cols.includes('confirm_state')) db.run(`UPDATE popup_payment_attempts SET confirm_state=NULL, state_version=0 WHERE attempt_id=?`, [oc.payment.ref]);
        });
        const a = await pAtt(oa); const b = await pAtt(ob);
        const cashA = await pCash(oa); const cashB = await pCash(ob);
        // 金流端已扣款（替身狀態）、舊版 pending 有交易識別 → callback 不再 Confirm，唯讀核對完成
        const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[cc.tx].confirmed = true; fs.writeFileSync(LP.state, JSON.stringify(st));
        const r = await pCb(cc); const c = await pAtt(oc);
        await restart(); const a2 = await pAtt(oa);
        assert(a.status === 'review' && cashA === 409 && b.status === 'failed' && cashB === 200 && confirmsFor(cc.tx) === 0 && c.status === 'paid' && a2.status === 'review',
          'P14 [API][FX][RS] 升級前快閃紀錄：provider_declined 失敗 → 隔離待核對、不能改現金；顧客取消 → 維持失敗可改現金；有交易識別的 pending → 不送 Confirm、唯讀核對完成；重啟結果不變', JSON.stringify({ a: a.status, cashA, b: b.status, cashB, c: c.status, confirms: confirmsFor(cc.tx), loc: r.loc.slice(-25), ca: !!ca }));
      });
      await step('P15', 'D', async () => {
        // [BR] 快閃付款畫面：待核對時顯示「付款結果確認中」，不提供「前往 LINE Pay 付款」或「改用現金」
        if (!browser || !p5) throw new Error('需要瀏覽器與 P5');
        const o = await pOrder(); lpCtrl({ confirmMode: 'drop', inquiry: 'error' }); const { call } = await pRequest(o); await pCb(call); lpCtrl({});
        const ctx = await lineCtx(); const pg = await ctx.newPage();
        await ctx.addInitScript(([ref, tok]) => { try { sessionStorage.setItem('line_popup_pay_v1_' + ref, tok); } catch (e) {} }, [o.payment.ref, o.payment.token]);
        await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC)}&popup_pay_ref=${o.payment.ref}&popup_pay_result=pending`, { waitUntil: 'domcontentloaded' });
        let ui = { text: '', pay: false, cash: false };
        for (let i = 0; i < 30; i++) {
          await sleep(300);
          ui = await pg.evaluate(() => ({ text: document.body.innerText, pay: !!document.getElementById('popupPayGoBtn'), cash: !!document.getElementById('popupPaySwitchCashBtn') }));
          if (/付款狀態：/.test(ui.text)) break;
        }
        await ctx.close();
        assert(/付款結果確認中/.test(ui.text) && !ui.pay && !ui.cash && !/付款完成/.test(ui.text),
          'P15 [BR] 快閃付款畫面（回應遺失、查詢失敗）：顯示「付款結果確認中」，不提供前往付款或改現金，不顯示付款完成', JSON.stringify({ pay: ui.pay, cash: ui.cash, text: (ui.text.match(/付款狀態：[^\n]*/) || [''])[0] }));
      });
    }

    // ═══════════════════════ Z：外部呼叫 ═══════════════════════
    await step('Z', 'G', async () => {
      const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
      const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
      const sigBad = lpCalls().filter((c) => c.sig_ok === false).length;
      const lineReal = C.mf.real();
      assert(real === 0 && unexpected === 0 && sigBad === 0 && lineReal === 0, 'Z 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；替身核對簽章全部正確',
        JSON.stringify({ real, unexpected, sigBad, lineReal, lpCalls: lpCalls().length }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 800));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-payment-ui-popup', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*(?:-\d+)?/) || [''])[0]] || {}).cls || null, detail: r.detail })) };
  if (process.env.C54_RESULT_JSON) fs.writeFileSync(process.env.C54_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
