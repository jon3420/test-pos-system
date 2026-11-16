#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-1-timing-fix.js
// R54.4／MBV2-HF1-C5.4.1 補修（TIMING_FIX）—— 首次付款返回與延遲提示的時序保護：重現／驗收（同一組案例先跑未修改 C5.4.1，再跑補修版）
//   A 首次付款返回的查詢回應延遲期間，使用者在同一場次開始購物操作（真實按鈕／鍵盤）→ 舊回應不得重新取得畫面
//   B 「重新查詢付款狀態」成功提示的 30 毫秒延遲重填，不得覆蓋較新的查詢中／錯誤／取消提示（以 Playwright 假時鐘控制，不靠手速）
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright，實際點擊按鈕）；
//   [RT] 以 Playwright route 攔截 /popup-payment/status 做可控制的延遲、逾時、錯誤與竄改回應（其他請求照常送到伺服器）；
//   [FN] 以頁面既有函式觸發畫面切換（明確標示，不是 LINE 真機操作）。
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截（未知路徑立即拋錯並記錄，必須 0 行）；LINE Messaging API 由 c4-line-mock 攔截。
//   本腳本不是 LINE 真機、正式金流或 Sandbox 驗證。
// 分類：DE＝既有缺口（C5.4 起即存在，本輪補上保護）；DN＝C5.4.1 新增邏輯帶來的問題；G＝回歸保護
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
const D = H.tmpDir('c541t-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c541': 'test-secret-c541' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const ONLY = (process.env.C541T_ONLY || '').split(',').filter(Boolean);
const STEP_RE = process.env.C541T_STEP ? new RegExp(process.env.C541T_STEP) : null;
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
  console.log('══════════ R54.4／MBV2-HF1-C5.4.1 補修：首次付款返回與延遲提示的時序保護 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    if (!chromium) throw new Error('需要 playwright（以 NODE_PATH 指向已安裝的 playwright）');
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
      C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
    const C = await C45.boot('c541t', { products: PRODUCTS, members: 10, settings: {}, seed, env: env(OFF) }); boots.push(C);
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

    // ── 時序控制：gate 由測試決定何時、以何種結果放行 status 回應（伺服器真實回應在請求當下取得）──
    const gate = () => { let rel; const p = new Promise((r) => { rel = r; }); return { p, release: (v) => rel(v) }; };
    const gatedH = (g) => async (route) => {
      const resp = await route.fetch(); const body = await resp.text();
      const how = await g.p;
      if (how === 'ok') return route.fulfill({ status: resp.status(), headers: resp.headers(), body });
      if (how === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
      return route.abort('failed');
    };
    const sess = (pg) => pg.evaluate(() => {
      const root = document.getElementById('popupRoot');
      const items = (typeof popupCart !== 'undefined' && popupCart && Array.isArray(popupCart.items)) ? popupCart.items : [];
      const ov = document.getElementById('popupLookupOverlay');
      return { view: root ? root.getAttribute('data-popup-view') : null, step: root ? root.getAttribute('data-popup-step') : null,
        payScreen: !!document.querySelector('[data-testid=popup-payment-state]'), payText: ((document.querySelector('[data-testid=popup-payment-state]') || {}).textContent || ''),
        qty: items.reduce((a, x) => a + (Number(x.qty) || 0), 0), name: (document.getElementById('popupCustomerName') || {}).value ?? null,
        drawer: (typeof popupCartDrawerOpen !== 'undefined') ? !!popupCartDrawerOpen : null, overlay: !!(ov && !ov.hidden),
        session: (typeof popupSession !== 'undefined' && popupSession) ? popupSession.public_code : null,
        text: root ? root.innerText.replace(/\s+/g, ' ').slice(0, 160) : '' };
    });
    const waitSessionReady = async (pg) => { await pg.waitForSelector('li[data-product-id="731"] .popup-order-qty-btn', { timeout: 20000 }); await sleep(500); };
    const plus = async (pg) => { await pg.locator('li[data-product-id="731"] .popup-order-qty-btn').nth(1).click(); await sleep(450); };
    // 首次付款返回頁：status 回應被 gate 擋住，頁面停在場次頁
    const openReturn = async (o, g, extra = {}) => {
      const r = await openPay(o, { noWait: true, result: 'paid', initialHandler: gatedH(g), ...extra });
      await waitSessionReady(r.pg);
      return r;
    };
    const NOTICE = '付款結果可至「📜 我的訂單」查看';
    const watchToast = (pg) => pg.evaluate(() => { const t = document.getElementById('toast'); window.__c541tToast = []; new MutationObserver(() => { window.__c541tToast.push({ text: t.textContent, show: t.classList.contains('show'), at: performance.now() }); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }); });
    const toastLog = (pg) => pg.evaluate(() => { const t = document.getElementById('toast'); return { log: window.__c541tToast || [], now: { text: t.textContent, show: t.classList.contains('show'), pe: getComputedStyle(t).pointerEvents, pos: getComputedStyle(t).position } }; });
    const bgRefresh = async (pg) => { await pg.evaluate(() => { window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); }); await sleep(1800); };

    // ═══════════ A：首次付款返回 × 同場次購物操作（真實 Chrome、實際按鈕與鍵盤） ═══════════
    const PAID = await mk.paid();
    await step('A1', 'DE', async () => {
      const out = {};
      const flows = {
        qty: async (pg) => { await plus(pg); await plus(pg); },                                            // 選商品、改數量
        cart: async (pg) => { await plus(pg); await pg.click('#popupCartBarViewBtn'); await sleep(450); },  // 查看購物車
        checkout: async (pg) => { await plus(pg); await plus(pg); await pg.click('.popup-order-cartbar-next'); await sleep(600);
          await pg.focus('#popupCustomerName'); await pg.keyboard.type('王小明', { delay: 30 }); await sleep(300); },        // 切換結帳步驟＋鍵盤輸入
      };
      for (const [k, act] of Object.entries(flows)) {
        const g = gate(); const { ctx, pg, R } = await openReturn(PAID, g);
        await act(pg); const before = await sess(pg);
        g.release('ok'); await sleep(1800); const after = await sess(pg);
        const n0 = R.reqs.length; await bgRefresh(pg); const afterBg = await sess(pg); const n1 = R.reqs.length;
        await ctx.close();
        out[k] = { ok: !after.payScreen && after.view === 'session' && after.qty === before.qty && after.qty > 0 && after.step === before.step && after.name === before.name && after.drawer === before.drawer
            && !afterBg.payScreen && afterBg.view === 'session' && afterBg.qty === before.qty && n1 === n0,
          before: { step: before.step, qty: before.qty, name: before.name, drawer: before.drawer }, after: { view: after.view, payScreen: after.payScreen, step: after.step, qty: after.qty, name: after.name }, bgPay: afterBg.payScreen, bgStatusReq: n1 - n0 };
      }
      assert(Object.values(out).every((x) => x.ok), 'A1 [BR][RT] 首次付款返回查詢延遲期間，同場次選商品／改數量、查看購物車、前往結帳並以鍵盤輸入姓名：放行舊的成功回應後不顯示付款畫面，商品數量、步驟、購物車與輸入保留；之後背景更新也不重新拉回舊訂單', JSON.stringify(out));
    });
    await step('A2', 'DE', async () => {
      const out = {};
      for (const how of ['500', 'abort', 'timeout']) {
        const g = gate(); const { ctx, pg } = await openReturn(PAID, g);
        await plus(pg); await plus(pg); await pg.click('.popup-order-cartbar-next'); await sleep(600);
        const before = await sess(pg);
        if (how === 'timeout') await sleep(13000); else { g.release(how); await sleep(1800); }
        const after = await sess(pg); g.release('ok'); await sleep(300);
        await ctx.close();
        out[how] = { ok: !after.payScreen && after.view === 'session' && after.qty === before.qty && after.step === before.step && !/付款狀態確認中/.test(after.text), view: after.view, pay: after.payText, qty: [before.qty, after.qty], step: [before.step, after.step] };
      }
      assert(Object.values(out).every((x) => x.ok), 'A2 [BR][RT] 同情境但首次查詢回應為 HTTP 500、網路失敗或 12 秒逾時：不把正在進行的購物／結帳流程換成「付款狀態確認中」畫面', JSON.stringify(out));
    });
    await step('A3', 'G', async () => {
      const g = gate(); const { ctx, pg, R } = await openReturn(PAID, g);
      await watchToast(pg);
      await pg.mouse.move(200, 400); await pg.mouse.wheel(0, 600); await sleep(300); await pg.mouse.wheel(0, -400); await sleep(300); // 單純捲動
      await pg.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); }); await sleep(800); // 背景更新（非使用者事件）
      g.release('ok'); await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 8000 }).catch(() => {}); await sleep(400);
      const s = await sess(pg); const t = await pg.evaluate(() => document.getElementById('popupRoot').innerText);
      const tl = await toastLog(pg);
      await ctx.close();
      const noticeShown = tl.log.some((x) => x.text.includes(NOTICE));
      assert(s.payScreen && /已付款/.test(s.payText) && /付款成功，訂單已成立/.test(t) && R.reqs.length >= 1 && !noticeShown,
        'A3 [BR][RT] 首次付款返回、期間只有捲動與背景更新（無其他操作）：回應到達後正常顯示可信付款結果（已付款、付款成功），不顯示「我的訂單」查詢提示', JSON.stringify({ view: s.view, pay: s.payText, noticeShown }));
    });
    await step('A4', 'DE', async () => {
      const B = await mk.failed(); const out = {};
      { // (a) 重新進入其他場次（[FN] 場次載入函式）——既有保護
        const g = gate(); const { ctx, pg } = await openReturn(PAID, g);
        await pg.evaluate((sc) => loadPopupDirectSession(sc), SC2); await sleep(1500);
        g.release('ok'); await sleep(1800); const s = await sess(pg); await ctx.close();
        out.session = { ok: !s.payScreen && s.session === SC2, view: s.view };
      }
      { // (b) 開啟「📜 我的訂單」（帳號／查詢流程，實際點擊）
        const g = gate(); const { ctx, pg } = await openReturn(PAID, g);
        await pg.click('[data-lookup-open="history"]'); await sleep(600);
        g.release('ok'); await sleep(1800); const s = await sess(pg); await ctx.close();
        out.account = { ok: !s.payScreen && s.view === 'session' && s.overlay, view: s.view, overlay: s.overlay };
      }
      { // (c) 付款對象切換（[FN] 以既有函式顯示另一筆付款）——既有序號保護
        const g = gate(); const { ctx, pg, R } = await openReturn(PAID, g, { tokens: [PAID, B] });
        R.handler = async (route, tok) => (tok === PAID.payment.token ? gatedH(g)(route) : route.continue());
        await pg.evaluate((ref) => popupHandlePaymentReturn(ref), B.payment.ref); await sleep(1500);
        g.release('ok'); await sleep(1800); const s = await sess(pg); const t = await pg.evaluate(() => document.getElementById('popupRoot').innerText); await ctx.close();
        out.target = { ok: s.payScreen && /付款失敗/.test(s.payText) && t.includes(B.order_number) && !t.includes(PAID.order_number), pay: s.payText };
      }
      assert(Object.values(out).every((x) => x.ok), 'A4 [BR][RT][FN] 首次返回查詢中：重新進入其他場次、開啟我的訂單（帳號流程）、改顯示另一筆付款 → 舊回應被丟棄，不覆蓋目前畫面', JSON.stringify(out));
    });

    await step('A5', 'N', async () => {
      const out = {};
      { // (a) 丟棄舊結果後提示一次；背景更新、再次操作都不重複；不切換畫面、不攔截點擊、不表示付款成敗
        const g = gate(); const { ctx, pg } = await openReturn(PAID, g); await watchToast(pg);
        await plus(pg); g.release('ok'); await sleep(1500);
        const mid = await toastLog(pg); const s1 = await sess(pg);
        await bgRefresh(pg);
        if (!s1.payScreen) await plus(pg); // 舊結果已取得畫面（未修正版）時商品列表不存在：不再操作，交由斷言判定
        await sleep(5500);
        const end = await toastLog(pg); const s2 = await sess(pg); await ctx.close();
        const shows = end.log.filter((x) => x.show && x.text.includes(NOTICE));
        const firstShowText = (shows[0] || {}).text || '';
        out.once = { ok: mid.now.show && mid.now.text.includes(NOTICE) && mid.now.pe === 'none' && mid.now.pos === 'fixed' && !/付款成功|付款失敗|已付款|未付款/.test(firstShowText)
            && new Set(end.log.filter((x) => x.text.includes(NOTICE) && x.show).map((x) => Math.round(x.at / 1000))).size >= 1 && end.log.filter((x, i, a) => x.show && x.text.includes(NOTICE) && !(a[i - 1] && a[i - 1].show && a[i - 1].text.includes(NOTICE))).length === 1
            && s1.view === 'session' && !s1.payScreen && s2.view === 'session' && s2.qty === 2,
          text: firstShowText, pe: mid.now.pe, view: [s1.view, s2.view], showEpisodes: end.log.filter((x, i, a) => x.show && x.text.includes(NOTICE) && !(a[i - 1] && a[i - 1].show && a[i - 1].text.includes(NOTICE))).length };
      }
      { // (b) 丟棄時已有其他提示（例如錯誤）正在顯示 → 不覆蓋，等其結束後才顯示
        const g = gate(); const { ctx, pg } = await openReturn(PAID, g); await watchToast(pg);
        await pg.evaluate(() => toast('測試用：其他錯誤提示', 3000)); // 先有其他提示顯示中
        await plus(pg); // 使用者操作 → 舊查詢立即中止並丟棄
        g.release('ok'); await sleep(800); const during = await toastLog(pg);
        await sleep(3200); const after = await toastLog(pg); await ctx.close();
        out.noOverride = { ok: during.now.show && during.now.text === '測試用：其他錯誤提示' && after.now.show && after.now.text.includes(NOTICE), during: during.now.text, after: after.now.text.slice(0, 20), log: after.log.map((x) => [Math.round(x.at), x.show, x.text.slice(0, 8)]) };
      }
      assert(Object.values(out).every((x) => x.ok), 'A5 [BR][RT] 舊付款返回結果因使用者操作被丟棄時：頁面頂端提示「付款結果可至「📜 我的訂單」查看」一次（不切換畫面、不攔截點擊、不表示付款成敗、背景更新與後續操作不重複）；其他提示顯示中時不覆蓋、待其結束後才顯示', JSON.stringify(out));
    });

    // ═══════════ B：延遲提示重填 × 較新的提示（Playwright 假時鐘，順序完全由測試控制） ═══════════
    // 步驟：開付款畫面 → 安裝假時鐘 → 以滑鼠按查詢（成功、排入 30ms 重填）→ 時鐘不前進 → 以鍵盤 Enter 開始下一次查詢 → 控制其結果 → 時鐘前進 100ms
    const B_ORDER = await mk.failed();
    const openB = async (o) => {
      const r = await openPay(o || B_ORDER);
      const t0 = RealDate.now();
      await r.pg.clock.install({ time: new Date(t0) });
      await r.pg.clock.pauseAt(new Date(t0 + 1000)); // 凍結時間：計時器只在 runFor 時前進
      return r;
    };
    const until = async (pg, fn, max = 8000) => { const t0 = RealDate.now(); for (;;) { const u = await ui(pg); if (fn(u)) return u; if (RealDate.now() - t0 > max) return u; await sleep(60); } };
    const firstOk = async (pg, R) => { R.handler = null; await pg.click('#popupPayRefreshBtn'); const u = await until(pg, (x) => /已查詢/.test(x.status) && x.btn && !x.btn.disabled); await pg.focus('#popupPayRefreshBtn'); return u; };
    await step('B1', 'DN', async () => {
      const { ctx, pg, R } = await openB(); const ok1 = await firstOk(pg, R);
      const g = gate(); R.handler = gatedH(g);
      await pg.keyboard.press('Enter'); const busy = await until(pg, (x) => /查詢中/.test(x.status));
      await pg.clock.runFor(100); const after = await ui(pg);
      g.release('ok'); await sleep(300); await ctx.close();
      assert(/已查詢/.test(ok1.status) && /查詢中/.test(busy.status) && /查詢中/.test(after.status) && !/已查詢/.test(after.status) && after.btn && after.btn.disabled,
        'B1 [BR][CLK] 舊成功提示的延遲重填＋新查詢進行中（鍵盤 Enter）：「查詢中…」不被舊成功提示覆蓋', JSON.stringify({ busy: busy.status.slice(0, 30), after: after.status.slice(0, 60), btn: after.btn }));
    });
    await step('B2', 'DN', async () => {
      const { ctx, pg, R } = await openB(); await firstOk(pg, R);
      R.handler = async (route) => route.abort('failed');
      await pg.keyboard.press('Enter'); const err = await until(pg, (x) => /網路異常/.test(x.status));
      await pg.clock.runFor(100); const after = await ui(pg);
      R.handler = null; const n0 = R.reqs.length; await pg.focus('#popupPayRefreshBtn'); await pg.keyboard.press('Enter');
      const retry = await until(pg, (x) => /已查詢/.test(x.status) && x.btn && !x.btn.disabled); const n1 = R.reqs.length;
      await ctx.close();
      assert(/網路異常/.test(err.status) && /網路異常/.test(after.status) && !/已查詢/.test(after.status) && after.tone === 'danger' && after.btn && !after.btn.disabled && n1 === n0 + 1 && /已查詢/.test(retry.status),
        'B2 [BR][CLK] 舊成功提示的延遲重填＋新查詢快速網路失敗：錯誤提示持續可見（紅色），按鈕可重試且重試會送出新查詢', JSON.stringify({ after: after.status.slice(0, 40), tone: after.tone, retrySent: n1 - n0 }));
    });
    await step('B3', 'DN', async () => {
      const out = {};
      { // (a) 取消：查詢中切換帳號（[FN] 切換帳號按鈕呼叫的同一函式）
        const { ctx, pg, R } = await openB(); await firstOk(pg, R);
        const g = gate(); R.handler = gatedH(g);
        await pg.keyboard.press('Enter'); await until(pg, (x) => /查詢中/.test(x.status));
        await pg.evaluate(() => { popupLookupShell(); return popupLookupSwitchAccount(); }); await until(pg, (x) => /已切換帳號/.test(x.status));
        await pg.clock.runFor(100); const after = await ui(pg);
        g.release('ok'); await sleep(300); await ctx.close();
        out.cancel = { ok: /已切換帳號/.test(after.status) && !/已查詢，付款狀態未變/.test(after.status) && after.btn && !after.btn.disabled, status: after.status.slice(0, 40) };
      }
      { // (b) 逾時：假時鐘前進 12.1 秒
        const { ctx, pg, R } = await openB(); await firstOk(pg, R);
        const g = gate(); R.handler = gatedH(g);
        await pg.keyboard.press('Enter'); await until(pg, (x) => /查詢中/.test(x.status));
        await pg.clock.runFor(12100); const after = await until(pg, (x) => /查詢逾時/.test(x.status), 3000);
        await pg.clock.runFor(100); const after2 = await ui(pg);
        g.release('ok'); await sleep(300); await ctx.close();
        out.timeout = { ok: /查詢逾時/.test(after2.status) && !/已查詢，付款狀態未變/.test(after2.status) && after2.btn && !after2.btn.disabled, status: after2.status.slice(0, 40), first: after.status.slice(0, 20) };
      }
      assert(Object.values(out).every((x) => x.ok), 'B3 [BR][CLK][FN] 舊成功提示的延遲重填＋新查詢被取消（切換帳號）或逾時：保留最新提示，不回到舊成功文案', JSON.stringify(out));
    });
    await step('B4', 'G', async () => {
      const o = await mk.pending();
      const { ctx, pg, R } = await openB(o); await firstOk(pg, R);
      lpCtrl({}); const call = await pRequest(o); await pCb(call); // 伺服器端改為已付款
      R.handler = null; await pg.keyboard.press('Enter');
      const done = await until(pg, (x) => /已更新/.test(x.status));
      await pg.clock.runFor(100); const after = await ui(pg);
      await ctx.close();
      assert(/已查詢，付款狀態已更新：已付款/.test(after.status) && /已付款/.test(after.state) && /最後成功查詢/.test(after.last) && after.statusRole === 'status/polite' && /已更新/.test(done.status),
        'B4 [BR][CLK] 新查詢成功且狀態改變（等待付款→已付款）：時鐘前進後仍保留最新狀態、「已更新」提示與最後查詢時間', JSON.stringify({ status: after.status.slice(0, 50), state: after.state }));
    });
    await step('B5', 'G', async () => {
      // 延遲重填本身仍保留（協助朗讀）：沒有新操作時，時鐘前進後提示內容不變、live region 屬性保留（只驗證 DOM，不代表螢幕閱讀器實測）
      const { ctx, pg, R } = await openB(); const ok1 = await firstOk(pg, R);
      const refilled = await pg.evaluate(() => new Promise((res) => { const st = document.getElementById('popupPayRefreshStatus'); let n = 0; const mo = new MutationObserver(() => { n++; }); mo.observe(st, { childList: true, subtree: true }); window.__c541tRefill = () => { mo.disconnect(); return n; }; res(true); }));
      await pg.clock.runFor(100); const after = await ui(pg); const n = await pg.evaluate(() => window.__c541tRefill());
      await ctx.close();
      assert(refilled && after.status === ok1.status && after.statusRole === 'status/polite' && n > 0,
        'B5 [BR][CLK] 無後續操作時，30 毫秒延遲重填照常執行（同內容重寫一次，供朗讀）；role=status／aria-live=polite 保留', JSON.stringify({ same: after.status === ok1.status, mutations: n }));
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
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-1-timing-fix', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*/) || [''])[0]] || {}).cls || null, detail: r.detail })) };
  if (process.env.C541T_RESULT_JSON) fs.writeFileSync(process.env.C541T_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
