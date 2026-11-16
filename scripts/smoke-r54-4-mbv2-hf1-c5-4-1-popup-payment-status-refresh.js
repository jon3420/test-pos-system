#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-1-popup-payment-status-refresh.js
// R54.4／MBV2-HF1-C5.4.1 —— 快閃付款「重新查詢付款狀態」操作回饋：重現／驗收（同一組案例先跑未修改 C5.4，再跑 C5.4.1）
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright，實際點擊按鈕）；
//   [RT] 以 Playwright route 攔截 /popup-payment/status 做可控制的延遲、逾時、錯誤與竄改回應（其他請求照常送到伺服器）；
//   [FN] 以頁面既有函式觸發畫面切換（明確標示，不是 LINE 真機操作）。
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截（未知路徑立即拋錯並記錄，必須 0 行）；LINE Messaging API 由 c4-line-mock 攔截。
//   本腳本不是 LINE 真機、正式金流或 Sandbox 驗證。
// 分類：D＝原始缺陷直接重現；N＝新增保護（基準不存在）；G＝既有行為回歸保護
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30); // 伺服器一律以台北 10:30 執行（瀏覽器用真實時間）
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c541-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c541': 'test-secret-c541' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const ONLY = (process.env.C541_ONLY || '').split(',').filter(Boolean);
const STEP_RE = process.env.C541_STEP ? new RegExp(process.env.C541_STEP) : null;
const META = {};
async function step(name, cls, fn) {
  if (STEP_RE && !STEP_RE.test(name)) return;
  if (ONLY.length && !ONLY.includes(name)) return;
  META[name] = { cls };
  try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
}
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [731, '快閃測試品', 1, 'available', { quota: 900, price: 90 }]];
const POPUP_SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 15, allow_fallback_cash: true, expire_cancel_release: true };
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c541','test-secret-c541')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(POPUP_SETTINGS)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { coupon: true, reports: true, line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};
const tpNowHMS = () => { const d = new Date(RealDate.now() + 8 * 3600e3); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };
const hmsOf = (s) => { const m = /(\d{2}):(\d{2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; };

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4.1 快閃付款狀態重新查詢回饋 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    if (!chromium) throw new Error('需要 playwright（以 NODE_PATH 指向已安裝的 playwright）');
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
      C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
    const C = await C45.boot('c541', { products: PRODUCTS, members: 10, settings: {}, seed, env: env(OFF) }); boots.push(C);
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const dayPlus = (n) => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };

    // ── 快閃場次（兩個：第二個用於「重新進入其他場次」）──
    const camp = await adm('POST', '/api/popup-pickup/campaigns', { name: 'C541 快閃', status: 'published' });
    const loc = await adm('POST', '/api/popup-pickup/locations', { name: 'C541 地點', address: '台北市中正區測試路1號', lat: 25.04, lng: 121.51 });
    const mkSess = async (name) => {
      const s = await adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name, status: 'published', pickup_date: dayPlus(2), pickup_start_time: '17:00', pickup_end_time: '19:00',
        order_open_at: '2026-01-01T00:00', order_cutoff_at: dayPlus(1) + 'T23:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 900 });
      if (!s.json || !s.json.success) throw new Error('popup session ' + JSON.stringify(s.json).slice(0, 300));
      return s.json.data.public_code;
    };
    const SC = await mkSess('C541 場次'); const SC2 = await mkSess('C541 第二場次');
    let ph = 100;
    const pOrder = async (pay = 'linepay') => {
      const r = await fetch(`${C.s.base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c541k' + crypto.randomBytes(10).toString('hex') },
        body: JSON.stringify({ popup_session_public_code: SC, customer_name: '快閃測試', customer_phone: '0911000' + String(ph++).padStart(3, '0'), payment_method: pay, items: [{ product_id: 731, qty: 1 }] }) });
      const j = await r.json();
      if (!j.success) throw new Error('popup checkout ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
      return j.data;
    };
    const pRequest = async (o) => {
      const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) });
      await r.json();
      return lpCalls().filter((c) => /request$/.test(c.uri)).pop();
    };
    const pCb = async (call) => { const u = new URL(call.confirmUrl); await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); };
    const pCancelCb = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); };
    const pStatus = async (o) => (await (await fetch(`${C.s.base}/api/line-orders/popup-payment/status?token=${o.payment.token}`)).json()).data;
    // 各付款狀態的 fixture
    const mk = {
      pending: async () => pOrder(),
      failed: async () => { const o = await pOrder(); const call = await pRequest(o); await pCancelCb(call); return o; },
      paid: async () => { lpCtrl({}); const o = await pOrder(); const call = await pRequest(o); await pCb(call); return o; },
      review: async () => { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const o = await pOrder(); const call = await pRequest(o); await pCb(call); lpCtrl({}); return o; },
    };

    browser = await chromium.launch(C45.launchOpts());
    let CUR_R = null;
    // 開啟快閃付款返回頁（顧客實際返回網址）；R.handler 可控制 status 查詢的延遲／錯誤／竄改。
    const openPay = async (o, opts = {}) => {
      const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, hasTouch: !!opts.touch, isMobile: !!opts.touch });
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      const toks = (opts.tokens || [o]).filter(Boolean).map((x) => [x.payment.ref, x.payment.token]);
      await ctx.addInitScript((pairs) => { try { for (const [r, t] of pairs) sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, toks);
      // 測試觀測：記錄頁面 fetch 的 cache 模式（Chrome 不會把 cache:'no-store' 反映為請求標頭）
      await ctx.addInitScript(() => { const f = window.fetch; window.__c541Fetch = []; window.fetch = function (u, init) { try { window.__c541Fetch.push({ u: String(u).replace(/token=[0-9a-f]+/, 'token=***'), cache: (init && init.cache) || null, signal: !!(init && init.signal) }); } catch (e) {} return f.apply(this, arguments); }; });
      const pg = await ctx.newPage();
      const R = { reqs: [], other: [], handler: opts.initialHandler || null, pageErrors: [] };
      pg.on('pageerror', (e) => R.pageErrors.push(String(e && e.message || e)));
      pg.on('request', (rq) => { const u = rq.url(); if (/popup-payment\/(linepay-request|switch-to-cash)|popup-checkout|popup-session\//.test(u)) R.other.push({ u: u.replace(/token=[0-9a-f]+/, 'token=***'), m: rq.method(), h: rq.headers() }); });
      await pg.route('**/api/line-orders/popup-payment/status**', async (route) => {
        const u = new URL(route.request().url());
        const rec = { t: RealDate.now(), tok: u.searchParams.get('token'), h: route.request().headers(), done: false };
        R.reqs.push(rec);
        const h = R.handler;
        try { if (!h) await route.continue(); else await h(route, u.searchParams.get('token')); } catch (e) { /* 請求已被頁面中止 */ } finally { rec.done = true; }
      });
      CUR_R = R;
      await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(opts.session || SC)}&popup_pay_ref=${o.payment.ref}&popup_pay_result=${opts.result || 'pending'}`, { waitUntil: 'domcontentloaded' });
      if (opts.noWait) return { ctx, pg, R };
      await pg.waitForFunction(() => !!document.querySelector('[data-testid=popup-payment-state]'), null, { timeout: 20000 });
      await sleep(400); // 等首次回饋填入、避開 ghost-tap 保護時間
      R.handler = null;
      return { ctx, pg, R };
    };
    const ui = (pg) => pg.evaluate(() => {
      const root = document.getElementById('popupRoot'); const b = document.getElementById('popupPayRefreshBtn'); const st = document.getElementById('popupPayRefreshStatus');
      const lc = document.querySelector('[data-testid=popup-payment-last-checked]');
      return { text: root ? root.innerText : '', view: root ? root.getAttribute('data-popup-view') : null,
        btn: b ? { disabled: b.disabled, text: b.textContent.trim(), busy: b.getAttribute('aria-busy') } : null,
        status: st && !st.hidden ? st.innerText.trim() : '', statusRole: st ? [st.getAttribute('role'), st.getAttribute('aria-live')].join('/') : '',
        tone: st ? st.getAttribute('data-tone') : null, last: lc ? lc.textContent : '',
        state: (document.querySelector('[data-testid=popup-payment-state]') || {}).textContent || '',
        pay: !!document.getElementById('popupPayGoBtn'), cash: !!document.getElementById('popupPaySwitchCashBtn'),
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null, scrollY: Math.round(window.scrollY),
        session: (typeof popupSession !== 'undefined' && popupSession) ? popupSession.public_code : null, marker: !!document.querySelector('[data-c541-marker]') };
    });
    const delayH = (ms, mut) => async (route) => { const resp = await route.fetch(); let body = await resp.text(); if (mut) body = mut(body); await sleep(ms); await route.fulfill({ status: resp.status(), headers: resp.headers(), body }); };
    // 等到「最新一筆 status 請求已回應（或被中止）」且按鈕可用；不只依賴忙碌提示（未修改基準沒有忙碌提示）
    const waitIdle = async (pg, max = 20000) => { const t0 = RealDate.now(); for (;;) { const last = CUR_R && CUR_R.reqs[CUR_R.reqs.length - 1]; const u = await ui(pg); if ((!last || last.done) && u.btn && !u.btn.disabled && !/查詢中/.test(u.status)) { await sleep(250); return ui(pg); } if (RealDate.now() - t0 > max) return u; await sleep(150); } };
    const lpN = () => lpCalls().length;
    const sideReq = (R) => R.other.filter((x) => /linepay-request|switch-to-cash|popup-checkout/.test(x.u)).length;
    const click = async (pg) => { await pg.click('#popupPayRefreshBtn', { timeout: 3000 }); };
    const short = (u) => ({ state: u.state, btn: u.btn, status: u.status.slice(0, 120), last: u.last, pay: u.pay, cash: u.cash });

    // ═══════════ A：唯讀查詢（API） ═══════════
    await step('A1', 'G', async () => {
      const o = await mk.failed();
      const before = { lp: lpN(), att: await q('SELECT status, confirm_state, updated_at FROM popup_payment_attempts WHERE order_id=?', [o.id]), ord: await q('SELECT payment_method, payment_status, order_status FROM orders WHERE id=?', [o.id]) };
      const s = []; for (let i = 0; i < 5; i++) s.push(await pStatus(o));
      const after = { lp: lpN(), att: await q('SELECT status, confirm_state, updated_at FROM popup_payment_attempts WHERE order_id=?', [o.id]), ord: await q('SELECT payment_method, payment_status, order_status FROM orders WHERE id=?', [o.id]) };
      assert(before.lp === after.lp && JSON.stringify(before.att) === JSON.stringify(after.att) && JSON.stringify(before.ord) === JSON.stringify(after.ord) && after.att.length === 1 && s.every((x) => x.state === 'payment_failed' && x.ref === o.payment.ref),
        'A1 [API] 付款狀態查詢 ×5 為唯讀：不新增付款嘗試、不呼叫 LINE Pay、不改訂單／付款資料；回應帶本次付款識別', JSON.stringify({ lp: [before.lp, after.lp], att: after.att.length, st: s[0].state }));
    });

    // ═══════════ R：重新查詢付款狀態（真實 Chrome、實際點擊） ═══════════
    await step('R1', 'D', async (m) => {
      // 原始缺陷：等待付款畫面按「重新查詢付款狀態」→ 查詢確實送出，但等待期間無回饋、完成後畫面與原本完全相同
      const o = await mk.pending();
      const { ctx, pg, R } = await openPay(o);
      const before = await ui(pg); const n0 = R.reqs.length; const lp0 = lpN();
      R.handler = delayH(1500);
      await click(pg); await sleep(300);
      const mid = await ui(pg);
      const end = await waitIdle(pg); await sleep(200); const fin = await ui(pg);
      await ctx.close();
      m.evidence = { sent: R.reqs.length - n0, midBtn: mid.btn, midStatus: mid.status, sameTextAfter: fin.text === before.text };
      assert(R.reqs.length - n0 === 1 && mid.btn && mid.btn.disabled && /查詢中/.test(mid.btn.text) && /查詢中/.test(mid.status)
        && /已查詢，付款狀態未變/.test(fin.status) && /等待付款/.test(fin.status) && /最後成功查詢/.test(fin.last) && fin.btn && !fin.btn.disabled && lpN() === lp0 && sideReq(R) === 0,
        'R1 [BR][RT] 原始缺陷：查詢已送出（1 筆）；等待中立即顯示「查詢中…」並停用按鈕；完成後顯示「已查詢，付款狀態未變：等待付款」與最後成功查詢時間，按鈕恢復',
        JSON.stringify({ sent: R.reqs.length - n0, mid: short(mid), fin: short(fin), sameTextAfter: fin.text === before.text }));
    });
    await step('R2', 'D', async () => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o); const lp0 = lpN();
      R.handler = delayH(1000);
      await click(pg); await sleep(250); const mid = await ui(pg);
      await waitIdle(pg); await sleep(200); const fin = await ui(pg);
      await ctx.close();
      assert(/查詢中/.test(mid.status) && mid.btn.disabled && /付款失敗，本次付款未完成/.test(fin.state) && /已查詢，付款狀態未變/.test(fin.status) && fin.cash && !fin.pay && /最後成功查詢/.test(fin.last) && lpN() === lp0 && sideReq(R) === 0,
        'R2 [BR][RT] 取消付款後重新查詢：顯示查詢中；完成後仍為「付款失敗，本次付款未完成」，有完成回饋，仍可改用現金；不呼叫 LINE Pay', JSON.stringify({ mid: short(mid), fin: short(fin) }));
    });
    await step('R3', 'D', async () => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o);
      await pg.click('#popupPaySwitchCashBtn'); await pg.waitForFunction(() => /取貨時付款/.test((document.querySelector('[data-testid=popup-payment-state]') || {}).textContent || ''), null, { timeout: 8000 });
      await sleep(500);
      const side0 = sideReq(R); const lp0 = lpN(); const att0 = (await q('SELECT COUNT(*) AS n FROM popup_payment_attempts WHERE order_id=?', [o.id]))[0].n;
      R.handler = delayH(800);
      await click(pg); await sleep(200); const mid = await ui(pg);
      await waitIdle(pg); await sleep(200); const fin = await ui(pg);
      await ctx.close();
      const att1 = (await q('SELECT COUNT(*) AS n FROM popup_payment_attempts WHERE order_id=?', [o.id]))[0].n; const ord = (await q('SELECT payment_method FROM orders WHERE id=?', [o.id]))[0];
      assert(/查詢中/.test(mid.status) && /取貨時付款/.test(fin.state) && /付款方式：現金/.test(fin.text) && /已查詢，付款狀態未變/.test(fin.status) && !fin.pay && !fin.cash
        && sideReq(R) === side0 && lpN() === lp0 && att1 === att0 && ord.payment_method === 'cash',
        'R3 [BR][RT] 改現金後重新查詢：仍顯示「取貨時付款」、現金，有完成回饋；查詢不呼叫付款建立／改現金／結帳、不新增付款嘗試、不呼叫 LINE Pay', JSON.stringify({ mid: short(mid), fin: short(fin), side: sideReq(R) - side0, att: [att0, att1] }));
    });
    await step('R4', 'D', async () => {
      const o = await mk.paid();
      const { ctx, pg, R } = await openPay(o); const lp0 = lpN();
      R.handler = delayH(800);
      await click(pg); await sleep(200); const mid = await ui(pg);
      await waitIdle(pg); await sleep(200); const fin = await ui(pg);
      await ctx.close();
      assert(/查詢中/.test(mid.status) && /已付款/.test(fin.state) && /付款完成/.test(fin.text) && /已查詢，付款狀態未變：已付款/.test(fin.status) && !fin.pay && !fin.cash && lpN() === lp0,
        'R4 [BR][RT] 已付款後重新查詢：維持「已付款」，有完成回饋，不出現付款／改現金按鈕', JSON.stringify({ mid: short(mid), fin: short(fin) }));
    });
    await step('R5', 'D', async () => {
      const o = await mk.pending();
      const { ctx, pg, R } = await openPay(o);
      const before = await ui(pg);
      lpCtrl({}); const call = await pRequest(o); await pCb(call); // 伺服器端完成付款（顧客畫面尚未更新）
      const lp0 = lpN();
      R.handler = delayH(600);
      await click(pg); await sleep(150); const mid = await ui(pg);
      await waitIdle(pg); await sleep(200); const fin = await ui(pg);
      await ctx.close();
      assert(/等待付款/.test(before.state) && before.pay && /查詢中/.test(mid.status) && /已付款/.test(fin.state) && /付款完成/.test(fin.text) && /付款成功，訂單已成立/.test(fin.text)
        && /已查詢，付款狀態已更新：已付款/.test(fin.status) && !fin.pay && lpN() === lp0,
        'R5 [BR][RT] 狀態改變：等待付款 → 已付款；付款資訊、說明與操作按鈕一起更新（「前往 LINE Pay 付款」消失），回饋為「付款狀態已更新」', JSON.stringify({ before: short(before), fin: short(fin) }));
    });
    await step('R6', 'D', async () => {
      const o = await mk.review();
      const { ctx, pg, R } = await openPay(o);
      const okRun = async () => { await click(pg); await waitIdle(pg); await sleep(200); return ui(pg); };
      R.handler = delayH(500); const ok = await okRun();
      await sleep(400);
      R.handler = async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":"INTERNAL"}' }); const e1 = await okRun();
      await sleep(400);
      R.handler = async (route) => route.abort('failed'); const e2 = await okRun();
      await ctx.close();
      const keep = (u) => /付款結果確認中，請勿重複付款/.test(u.state) && !u.pay && !u.cash && u.text.includes(o.order_number);
      assert(keep(ok) && /已查詢，付款狀態未變/.test(ok.status) && keep(e1) && /暫時無法取得付款狀態/.test(e1.status) && keep(e2) && /網路異常/.test(e2.status) && e2.btn && !e2.btn.disabled,
        'R6 [BR][RT] 待核對：查詢成功、HTTP 500、網路錯誤後都保留「付款結果確認中，請勿重複付款」與訂單編號，不開放前往付款或改現金', JSON.stringify({ ok: short(ok), e1: short(e1), e2: short(e2) }));
    });
    await step('R7', 'D', async () => {
      const o = await mk.pending();
      const { ctx, pg, R } = await openPay(o); const n0 = R.reqs.length;
      R.handler = delayH(1500);
      await click(pg);
      await pg.evaluate(() => { const b = document.getElementById('popupPayRefreshBtn'); for (let i = 0; i < 5; i++) { try { b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 1, clientY: 1 })); } catch (e) {} } });
      try { await pg.click('#popupPayRefreshBtn', { force: true, timeout: 500 }); } catch {}
      try { await pg.dblclick('#popupPayRefreshBtn', { force: true, timeout: 500 }); } catch {}
      await sleep(200); const inflight = R.reqs.length - n0;
      await waitIdle(pg); await sleep(300); const total = R.reqs.length - n0; const fin = await ui(pg);
      await ctx.close();
      assert(inflight === 1 && total === 1 && /已查詢/.test(fin.status),
        'R7 [BR][RT] 連續點擊（一般點擊＋5 次合成點擊＋強制點擊＋雙擊）：進行中只有 1 筆查詢', JSON.stringify({ inflight, total }));
    });
    await step('R8', 'D', async () => {
      const o = await mk.paid();
      const { ctx, pg, R } = await openPay(o);
      const kinds = {
        network: async (route) => route.abort('failed'),
        http500: async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }),
        http404: async (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false,"error":"POPUP_PAYMENT_NOT_FOUND"}' }),
        badjson: async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":' }),
        appfail: async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false,"error":"X"}' }),
        nodata: async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{"ref":"x"}}' }),
      };
      const res = {};
      for (const [k, h] of Object.entries(kinds)) {
        R.handler = h; await click(pg); const u = await waitIdle(pg); await sleep(400);
        res[k] = { ok: /已付款/.test(u.state) && /付款完成/.test(u.text) && u.text.includes(o.order_number) && /重新查詢付款狀態/.test(u.status) && /(網路異常|暫時無法取得付款狀態)/.test(u.status) && u.tone === 'danger' && u.btn && !u.btn.disabled && !u.pay && !u.cash,
          state: u.state, status: u.status.slice(0, 60) };
      }
      await ctx.close();
      assert(Object.values(res).every((x) => x.ok), 'R8 [BR][RT] 網路錯誤、HTTP 500／404、無效 JSON、應用層失敗、資料格式不符：均有可理解錯誤與重試方式；保留已付款畫面與訂單編號、不畫成未付款', JSON.stringify(res));
    });
    await step('R9', 'N', async (m) => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o); const n0 = R.reqs.length;
      // 第一次：伺服器在請求當下的回應被竄改成「已付款」並延遲 16 秒才送回（若被套用就會錯畫成已付款）
      R.handler = delayH(16000, (b) => { const j = JSON.parse(b); j.data.state = 'paid'; j.data.state_label = '已付款'; return JSON.stringify(j); });
      const t0 = RealDate.now(); await click(pg);
      await sleep(6000); const at6 = await ui(pg);
      let to = null; for (;;) { const u = await ui(pg); if (u.btn && !u.btn.disabled) { to = u; break; } if (RealDate.now() - t0 > 20000) { to = u; break; } await sleep(100); }
      const unlockMs = RealDate.now() - t0;
      R.handler = null; // 第二次：正常
      await sleep(400); await click(pg); await waitIdle(pg); await sleep(200); const second = await ui(pg);
      const waitLeft = 16000 - (RealDate.now() - t0) + 1500; if (waitLeft > 0) await sleep(waitLeft);
      const late = await ui(pg);
      await ctx.close();
      m.unlockMs = unlockMs;
      assert(at6.btn && at6.btn.disabled && /查詢逾時/.test(to.status) && to.btn && !to.btn.disabled && unlockMs >= 11500 && unlockMs <= 14500 && /付款失敗/.test(to.state)
        && /已查詢/.test(second.status) && /付款失敗/.test(second.state) && /付款失敗/.test(late.state) && !/已付款/.test(late.state) && R.reqs.length - n0 === 2,
        'R9 [BR][RT] 逾時與重試：約 12 秒解除忙碌並顯示逾時提示；可再查詢；第一次晚到（且內容不同）的回應不覆蓋新結果', JSON.stringify({ unlockMs, at6: at6.btn, to: short(to), second: second.status.slice(0, 40), late: late.state }));
    });
    await step('R10', 'D', async () => {
      const A = await mk.failed(); const B = await mk.paid(); const P = await mk.paid();
      const out = {};
      { // (a) 切換訂單：A 的查詢較慢，期間改顯示 B 的付款畫面
        const { ctx, pg, R } = await openPay(A, { tokens: [A, B] });
        R.handler = async (route, tok) => { if (tok === A.payment.token) return delayH(2000)(route); return route.continue(); };
        await click(pg); await sleep(300);
        await pg.evaluate((ref) => popupHandlePaymentReturn(ref), B.payment.ref); // [FN] 頁面既有函式：顯示另一筆訂單的付款畫面
        await sleep(3000); const u = await ui(pg); await ctx.close();
        out.order = { ok: u.text.includes(B.order_number) && !u.text.includes(A.order_number) && /已付款/.test(u.state), state: u.state };
      }
      { // (b) 離開付款畫面：已付款畫面按查詢後，按「繼續點餐」回到場次頁
        const { ctx, pg, R } = await openPay(P);
        R.handler = delayH(2000);
        await click(pg); await sleep(300);
        await pg.click('.popup-order-continue-btn'); await sleep(3000); const u = await ui(pg); await ctx.close();
        out.leave = { ok: u.view !== 'payment', view: u.view };
      }
      { // (c) 切換帳號（快閃「我的訂單」的切換帳號）：查詢中切換 → 舊回應被丟棄、按鈕恢復
        const { ctx, pg, R } = await openPay(A);
        R.handler = delayH(2000);
        await click(pg); await sleep(300);
        await pg.evaluate(() => { document.querySelector('.popup-order-shell').setAttribute('data-c541-marker', '1'); popupLookupSwitchAccount(); }); // [FN] 「切換帳號」按鈕呼叫的同一函式
        await sleep(300); const mid = await ui(pg);
        await sleep(2800); const u = await ui(pg); await ctx.close();
        out.account = { ok: u.marker && !/已查詢/.test(u.status) && mid.btn && !mid.btn.disabled && u.btn && !u.btn.disabled, mid: mid.status.slice(0, 40), status: u.status.slice(0, 40), marker: u.marker };
      }
      { // (d) 重新進入其他場次：查詢中載入第二個場次
        const { ctx, pg, R } = await openPay(A);
        R.handler = delayH(2000);
        await click(pg); await sleep(300);
        await pg.evaluate((sc) => loadPopupDirectSession(sc), SC2); // [FN] 場次切換最後呼叫的載入函式
        await sleep(3000); const u = await ui(pg); await ctx.close();
        out.session = { ok: u.view === 'session' && u.session === SC2, view: u.view, session: u.session === SC2 };
      }
      assert(Object.values(out).every((x) => x.ok), 'R10 [BR][RT][FN] 切換訂單、離開付款畫面、切換帳號、重新進入其他場次後，較晚到的舊查詢回應被丟棄，不覆蓋目前畫面', JSON.stringify(out));
    });
    await step('R11', 'D', async () => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o);
      R.handler = delayH(2000); // 回應內容是「改現金之前」的伺服器狀態（付款失敗、LINE Pay）
      await click(pg); await sleep(300);
      await pg.click('#popupPaySwitchCashBtn');
      await sleep(3000); const u = await ui(pg); await ctx.close();
      const ord = (await q('SELECT payment_method FROM orders WHERE id=?', [o.id]))[0];
      assert(/取貨時付款/.test(u.state) && /付款方式：現金/.test(u.text) && !u.cash && ord.payment_method === 'cash',
        'R11 [BR][RT] 改現金競態：查詢進行中改用現金成功，較早送出的查詢回應不會把畫面還原為 LINE Pay／付款失敗', JSON.stringify({ state: u.state, cash: u.cash, pm: ord.payment_method }));
    });
    await step('R12', 'D', async () => {
      const o = await mk.paid();
      const out = {};
      { // (a) 缺付款憑證：不送查詢，說明無法查詢，保留訂單資訊
        const { ctx, pg, R } = await openPay(o); const n0 = R.reqs.length;
        await pg.evaluate((ref) => sessionStorage.removeItem('line_popup_pay_v1_' + ref), o.payment.ref);
        await click(pg); await sleep(500); const u = await ui(pg); await ctx.close();
        out.noToken = { ok: R.reqs.length === n0 && /找不到付款憑證/.test(u.status) && /無法查詢/.test(u.status) && u.text.includes(o.order_number) && /已付款/.test(u.state), sent: R.reqs.length - n0, state: u.state, status: u.status.slice(0, 50) };
      }
      { // (b) 回應付款識別不符（即使 success:true）不套用
        const { ctx, pg, R } = await openPay(o);
        R.handler = delayH(100, (b) => { const j = JSON.parse(b); j.data.ref = crypto.randomUUID(); j.data.state = 'payment_failed'; j.data.state_label = '付款失敗，本次付款未完成'; j.data.can_switch_to_cash = true; return JSON.stringify(j); });
        await click(pg); await waitIdle(pg); await sleep(200); const u = await ui(pg); await ctx.close();
        out.mismatch = { ok: /已付款/.test(u.state) && !u.cash && /不符/.test(u.status), state: u.state, status: u.status.slice(0, 40) };
      }
      assert(Object.values(out).every((x) => x.ok), 'R12 [BR][RT] 缺付款憑證時不送查詢並明確說明、保留訂單資訊；回應付款識別不符時不套用（不只看 success:true）', JSON.stringify(out));
    });
    await step('R13', 'N', async () => {
      const o = await mk.paid();
      const out = {};
      { // (a) 首次付款返回：查詢較慢時不提前宣告成功；完成後沿用原本成功流程，不顯示「已查詢」回饋
        const { ctx, pg, R } = await openPay(o, { noWait: true, result: 'paid', initialHandler: delayH(1500) });
        await sleep(700); const mid = await ui(pg);
        await pg.waitForFunction(() => !!document.querySelector('[data-testid=popup-payment-state]'), null, { timeout: 15000 }); await sleep(300);
        const u = await ui(pg); await ctx.close();
        out.initial = { ok: !/付款成功|付款完成|已查詢/.test(mid.text) && /已付款/.test(u.state) && /付款成功，訂單已成立/.test(u.text) && !/已查詢/.test(u.status) && R.reqs.length === 1, mid: mid.view, state: u.state, status: u.status.slice(0, 40) };
      }
      { // (b) 首次付款返回逾時：中性的確認中說明、可重新查詢，不開放付款／改現金
        const { ctx, pg, R } = await openPay(o, { noWait: true, result: 'paid', initialHandler: async (route) => { await sleep(16000); await route.fulfill({ status: 200, body: '{}' }); } });
        const t0 = RealDate.now(); let u = null;
        for (;;) { u = await ui(pg); if (u.state || RealDate.now() - t0 > 17000) break; await sleep(200); }
        const ms = RealDate.now() - t0; await ctx.close();
        out.timeout = { ok: /付款狀態確認中/.test(u.state) && /查詢逾時/.test(u.text) && /請勿重複付款/.test(u.text) && u.btn && !u.btn.disabled && !u.pay && !u.cash && !/付款成功|付款完成/.test(u.text) && ms < 15000, ms, state: u.state };
      }
      { // (c) 首次付款返回但此瀏覽器沒有付款憑證：不送查詢、明確說明
        const { ctx, pg, R } = await openPay(o, { tokens: [], noWait: true });
        await sleep(2500); const u = await ui(pg); await ctx.close();
        out.noToken = { ok: R.reqs.length === 0 && /找不到付款憑證/.test(u.text), sent: R.reqs.length };
      }
      assert(Object.values(out).every((x) => x.ok), 'R13 [BR][RT] 首次付款返回：等待中不提前宣告成功、完成後沿用原成功流程；逾時顯示中性確認中說明並可重查；缺憑證不送查詢', JSON.stringify(out));
    });
    await step('R14', 'N', async () => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o, { viewport: { width: 360, height: 640 }, touch: true });
      await pg.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await sleep(200);
      await pg.focus('#popupPayRefreshBtn'); const y0 = (await ui(pg)).scrollY;
      R.handler = delayH(600);
      await pg.keyboard.press('Enter'); await sleep(150); const mid = await ui(pg);
      await waitIdle(pg); await sleep(300); const fin = await ui(pg);
      const geo = await pg.evaluate(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right }; };
        const st = document.getElementById('popupPayRefreshStatus'); const state = document.querySelector('[data-testid=popup-payment-state]');
        const rows = Array.from(document.querySelectorAll('.popup-order-info-row')).map(r);
        const sr = r(st); const overlap = rows.some((x) => x && sr && !(sr.b <= x.t || sr.t >= x.b));
        const btns = Array.from(document.querySelectorAll('#popupRoot .popup-order-step-nav button')).map((b) => { const x = b.getBoundingClientRect(); return { w: Math.round(x.width), h: Math.round(x.height), r: Math.round(x.right) }; });
        const cs = st ? getComputedStyle(st) : null;
        return { status: sr, state: r(state), overlap, sw: document.documentElement.scrollWidth, iw: window.innerWidth, ih: window.innerHeight, btns, pos: cs ? cs.position : null, fs: cs ? parseFloat(cs.fontSize) : 0 };
      });
      await pg.screenshot({ path: path.join(H.tmpDir('c541-shot'), 'r14.png') }).catch(() => {});
      await ctx.close();
      const ok = /查詢中/.test(mid.status) && /已查詢/.test(fin.status) && fin.statusRole === 'status/polite' && fin.active === 'popupPayRefreshBtn' && Math.abs(fin.scrollY - y0) <= 2
        && !geo.overlap && geo.status && geo.status.t >= 0 && geo.status.b <= geo.ih && geo.sw <= geo.iw && geo.pos === 'static' && geo.fs >= 12 && geo.btns.every((b) => b.h >= 40 && b.r <= geo.iw);
      assert(ok, 'R14 [BR] 手機寬度 360×640（觸控）：鍵盤操作查詢後焦點留在查詢按鈕、捲動位置不變；狀態提示 role=status／aria-live=polite、在可視範圍內、不遮住付款資訊、無水平捲動、按鈕高度足夠',
        JSON.stringify({ y: [y0, fin.scrollY], active: fin.active, role: fin.statusRole, geo }));
    });
    await step('R15', 'N', async () => {
      const o = await mk.pending();
      const { ctx, pg, R } = await openPay(o);
      await click(pg); await waitIdle(pg);
      const log = await pg.evaluate(() => window.__c541Fetch || []); await ctx.close();
      const st = log.filter((x) => /popup-payment\/status/.test(x.u)); const others = log.filter((x) => !/popup-payment\/status/.test(x.u));
      assert(st.length >= 2 && st.every((x) => x.cache === 'no-store' && x.signal) && others.length > 0 && others.every((x) => x.cache !== 'no-store'),
        'R15 [BR] 只有付款狀態查詢（首次返回與重新查詢）使用 cache:no-store 並可中止；其他快閃 API（場次載入等）的請求設定不變', JSON.stringify({ status: st.map((x) => x.cache), others: others.map((x) => x.u.replace(/^.*\/api\//, '').slice(0, 40) + ':' + x.cache) }));
    });
    await step('R16', 'N', async () => {
      const o = await mk.failed();
      const { ctx, pg, R } = await openPay(o);
      await click(pg); await waitIdle(pg); await sleep(200); const a = await ui(pg); const tA = tpNowHMS();
      const srvUpd = (await q('SELECT updated_at FROM orders WHERE id=?', [o.id]))[0].updated_at;
      await sleep(2200);
      R.handler = async (route) => route.abort('failed'); await click(pg); await waitIdle(pg); await sleep(200); const b = await ui(pg);
      await ctx.close();
      const shown = hmsOf(a.last); const diff = shown == null ? 999 : Math.min(Math.abs(shown - tA), 86400 - Math.abs(shown - tA));
      const srvH = hmsOf(srvUpd);
      assert(/台灣時間/.test(a.last) && diff <= 3 && b.last === a.last && /網路異常/.test(b.status) && (srvH == null || Math.abs(srvH - shown) > 60),
        'R16 [BR] 最後成功查詢時間＝瀏覽器成功取得狀態的時刻（台灣時間，誤差 ≤3 秒），不是訂單更新時間；之後查詢失敗不更新此時間', JSON.stringify({ shown: a.last, diff, afterError: b.last, orderUpdatedAt: srvUpd }));
    });
    await step('R17', 'G', async () => {
      // 回歸：查詢後「前往 LINE Pay 付款」照常送出付款建立（替身付款網址為 example.invalid，依既有安全規則不導向，顯示無法前往）
      const o = await mk.pending();
      const { ctx, pg, R } = await openPay(o);
      await click(pg); await waitIdle(pg); await sleep(500);
      const u = await ui(pg); const side0 = R.other.filter((x) => /linepay-request/.test(x.u)).length;
      await pg.click('#popupPayGoBtn'); await sleep(2000);
      const side1 = R.other.filter((x) => /linepay-request/.test(x.u)).length;
      const err = await pg.evaluate(() => (document.getElementById('popupPaymentErrorRegion') || {}).textContent || '');
      const errs = R.pageErrors.slice(); await ctx.close();
      assert(/已查詢/.test(u.status) && u.pay && side0 === 0 && side1 === 1 && /目前無法前往付款/.test(err) && errs.length === 0,
        'R17 [BR] 回歸：查詢本身不送付款建立；查詢後按「前往 LINE Pay 付款」照常送出 1 筆付款建立（替身網址依既有規則不導向）；頁面無 JavaScript 錯誤', JSON.stringify({ side: [side0, side1], err, errs }));
    });

    await step('Z', 'G', async () => {
      const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
      const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
      const sigBad = lpCalls().filter((c) => c.sig_ok === false).length;
      assert(real === 0 && unexpected === 0 && sigBad === 0 && C.mf.real() === 0, 'Z 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；替身核對簽章全部正確',
        JSON.stringify({ real, unexpected, sigBad, lineReal: C.mf.real(), lpCalls: lpCalls().length }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 800));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-1-popup-payment-status-refresh', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*/) || [''])[0]] || {}).cls || null, detail: r.detail })) };
  if (process.env.C541_RESULT_JSON) fs.writeFileSync(process.env.C541_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
