#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-response-timing.js
// R54.4／MBV2-HF1-C5.4.2 補修（PAYMENT_RESPONSE_TIMING_FIX）重現／驗收：同一支腳本、同一組斷言，先跑未修改的
// PAYMENT_GUARD_TIME_MERGE_FIX 基準，再跑補修版。
//   問題：快閃付款頁「前往 LINE Pay 付款」（popupStartLinePay）與「改用現金」（popupSwitchToCash）的回應較晚送達時，
//   會覆蓋目前畫面或較新的付款結果（只比對 json.data.ref===ref，沒有確認操作仍屬於目前畫面）。
// 測試層級：
//   [BR]   真實 Chrome（Google Chrome for Testing）。按鈕一律以 Playwright 實際點擊；瀏覽器「上一頁／下一頁」以 page.goBack／goForward。
//   [GATE] 瀏覽器攔截（page.route）只控制「回應何時送達」：請求照常送到伺服器並取得伺服器真實回應，測試決定何時放行。
//          放行模式 ok＝原樣交付伺服器回應；abort＝網路錯誤；badjson＝回應內容無法解析（僅 D10 清理流程）。
//   [API]  以正式 API 推進後端狀態（結帳、LINE Pay Request、callback、後台核對、改現金），模擬同一顧客在其他視窗／裝置的操作。
//   [FX]   直接寫入資料庫的「同單第二筆付款紀錄」（正常操作無法產生；與前一輪 A10／A12 相同 fixture，明確標示）。
//   [FN]   以頁面既有函式切換到「另一筆付款」畫面（popupHandlePaymentReturn，與付款返回網址呼叫的是同一函式）；該付款憑證以
//          sessionStorage 寫入（[SS]；正常情況由同一分頁結帳時寫入）。
//   [URL]  替身 LINE Pay 回傳的付款網址為 example.invalid（依既有安全規則不導向）。導向驗收時，瀏覽器端只把該網址換成
//          https://sandbox-web-pay.line.me/…（其餘回應內容不變），並以 context.route 攔截該網址回傳本機替身頁，瀏覽器不會連到外部。
// 分類：DE＝基準版存在的時序缺口（基準必須以行為斷言失敗）；G＝既有正確行為的回歸保護（兩版都應通過）。
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截並記錄；真實 LINE／LINE Pay 呼叫必須 0。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RealDate = Date;
const C45 = require('./lib/c45-common');
const { H, STORE, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c542rt-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCount = () => { const c = lpCalls(); return { request: c.filter((x) => /\/request$/.test(x.uri)).length, confirm: c.filter((x) => /\/confirm$/.test(x.uri)).length }; };
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const ONLY = (process.env.C542RT_ONLY || '').split(',').filter(Boolean);
const META = {}; const LOGS = {};
const EXT = []; // 頁面發出、目的地不是本機的請求（應只有被攔截的 line.me 替身頁與被擋下的外部資源）
async function step(name, cls, fn) {
  if (ONLY.length && !ONLY.some((p) => name.startsWith(p))) return;
  META[name] = { cls };
  try { await fn(); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [731, '快閃測試品', 1, 'available', { quota: 900, price: 90 }]];
const SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 60, allow_fallback_cash: true, expire_cancel_release: true };
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c542rt','test-secret-c542rt')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(SETTINGS)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};
const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
  C4_CLOCK_OFFSET_MS: String(off), TZ: 'UTC', C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
  C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-c542rt': 'test-secret-c542rt' }) });
const mask = (s) => String(s || '').replace(/token=[0-9a-f]+/g, 'token=***').replace(/"token":"[0-9a-f]+"/g, '"token":"***"').replace(/cb=[0-9a-f]+/g, 'cb=***');
const PHONE = '0966333444';
const NOTICE = '付款結果可至「📜 我的訂單」查看';
const STUB_PREFIX = 'https://sandbox-web-pay.line.me/web/payment/wait?mockTx=';

function kit(C, getSC) {
  const K = {};
  K.adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
  K.q = async (sql, p) => { await sleep(200); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
  K.order = async (o = {}) => {
    const r = await fetch(`${C.s.base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c542rt' + crypto.randomBytes(10).toString('hex') },
      body: JSON.stringify({ popup_session_public_code: o.sc || getSC(), customer_name: o.name || '時序測試', customer_phone: o.phone || PHONE, payment_method: o.pay || 'linepay', items: [{ product_id: 731, qty: 1 }] }) });
    const j = await r.json(); if (!j.success) throw new Error('checkout ' + JSON.stringify(j).slice(0, 200)); return j.data;
  };
  K.request = async (token) => {
    const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json, call: r.status === 200 ? lpCalls().filter((c) => /request$/.test(c.uri)).pop() : null };
  };
  K.cb = async (call) => { const u = new URL(call.confirmUrl); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  K.cancelCb = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  K.status = async (token) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/status?token=${token}`); return (await r.json()).data; };
  K.cash = async (token) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  K.reconcile = async (attemptId) => K.adm('POST', '/api/linepay-admin/reconcile', { popup_attempt_id: attemptId });
  K.idOf = async (orderNumber) => ((await K.q('SELECT id FROM orders WHERE order_number=?', [orderNumber]))[0] || {}).id;
  K.snap = async (orderId) => {
    const o = (await K.q('SELECT payment_method, payment_status, order_status, refund_status FROM orders WHERE id=?', [orderId]))[0];
    const a = await K.q('SELECT attempt_id, status, confirm_state, transaction_id FROM popup_payment_attempts WHERE order_id=? ORDER BY rowid', [orderId]);
    const al = await K.q('SELECT status, stock_state FROM popup_order_allocations WHERE order_id=? ORDER BY id', [orderId]);
    return { o, a, al };
  };
  // 後端狀態推進（[API] 正式流程）
  K.toReview = async (token) => { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const r = await K.request(token); await K.cb(r.call); lpCtrl({}); return r.call; };
  K.toPaid = async (token) => { lpCtrl({}); const r = await K.request(token); await K.cb(r.call); return r.call; };
  K.toFailed = async (token) => { const r = await K.request(token); await K.cancelCb(r.call); return r.call; };
  return K;
}
async function mkSession(K, name, pickupDate, cutoff) {
  const camp = await K.adm('POST', '/api/popup-pickup/campaigns', { name: name + ' 活動', status: 'published' });
  const loc = await K.adm('POST', '/api/popup-pickup/locations', { name: name + ' 地點', address: '台北市中正區測試路1號', lat: 25.04, lng: 121.51 });
  const s = await K.adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name, status: 'published', pickup_date: pickupDate, pickup_start_time: '17:00', pickup_end_time: '19:00',
    order_open_at: '2026-01-01T00:00', order_cutoff_at: cutoff, location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 900 });
  if (!s.json || !s.json.success) throw new Error('session ' + JSON.stringify(s.json).slice(0, 200));
  return s.json.data.public_code;
}
// [FX] 在同一張訂單新增一筆付款紀錄（複製第一筆，換識別與 token；rowid 較大＝較新）——與前一輪驗收相同
function fxAddAttempt(db, orderId, over) {
  const src = db.exec('SELECT * FROM popup_payment_attempts WHERE order_id=? ORDER BY rowid LIMIT 1', [orderId])[0];
  const cols = src.columns; const row = {}; cols.forEach((c, i) => { row[c] = src.values[0][i]; });
  const token = crypto.randomBytes(24).toString('hex');
  Object.assign(row, { attempt_id: crypto.randomUUID(), token_hash: crypto.createHash('sha256').update(token).digest('hex'), status: 'pending', transaction_id: '', fail_reason: '', confirm_state: 'never', confirm_calls: 0,
    failure_basis: '', review_reason: '', result_code: '', merchant_ref: '', quarantined_from: '', fulfillment_closed: 0, inquiry_count: 0, last_inquiry_at: null, last_inquiry_result: '', next_check_at: null, confirmed_at: null }, over || {});
  if ('cb_hash' in row) row.cb_hash = '';
  const use = cols.filter((c) => c in row);
  db.run(`INSERT INTO popup_payment_attempts (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`, use.map((c) => row[c]));
  return { attempt_id: row.attempt_id, token };
}

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4.2 補修：付款操作回應時序（PAYMENT_RESPONSE_TIMING_FIX）重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = []; let browser = null;
  try {
    if (!chromium) throw new Error('需要 playwright');
    // 隔離外部網路：本驗收的 Chrome 不經代理、除本機外一律無法解析主機名稱（line.me 付款頁只由 context.route 回傳本機替身頁；
    // 瀏覽器的預先連線、背景服務等也無法連到外部）
    const lo = C45.launchOpts();
    lo.args = (lo.args || []).concat(['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    browser = await chromium.launch(lo);
    LOGS.isolation = lo.args.slice(1);
    LOGS.browser = browser.version();
    const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return h * 3600e3 + m * 60e3 - cur; };
    const OFF = TP(10, 30);
    const C = await C45.boot('c542rt', { products: PRODUCTS, members: 3, settings: {}, seed, env: env(OFF) }); boots.push(C);
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const day = (n) => new Date(RealDate.now() + OFF + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    let SC1 = null; const K = kit(C, () => SC1);
    SC1 = await mkSession(K, 'C542RT 場次一', day(2), day(1) + 'T23:00');
    const SC2 = await mkSession(K, 'C542RT 場次二', day(3), day(2) + 'T23:00');
    lpCtrl({});
    // ── [FX] 改現金「確認中 409」所需的同單第二筆付款紀錄（先建立好，之後不再重啟伺服器）──
    const F = {};
    F.c1 = await K.order(); F.c1.call = (await K.request(F.c1.payment.token)).call;   // D1C：第一筆 pending（已建立 LINE Pay 付款）
    F.c6 = await K.order(); F.c6.call = (await K.request(F.c6.payment.token)).call;   // G6C
    await C.s.stop();
    const X = await (async () => { const db = await H.openDbFile(C.dbf); try {
      const failedOver = { status: 'failed', fail_reason: 'customer_cancelled', failure_basis: 'customer_cancelled_before_confirm' };
      const out = { c1: fxAddAttempt(db, F.c1.id, failedOver), c6: fxAddAttempt(db, F.c6.id, failedOver) };
      H.saveDbFile(db, C.dbf); return out; } finally { db.close(); } })();
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');

    // ══════════════════════ 瀏覽器工具 ══════════════════════
    const gate = () => { let rel; const p = new Promise((r) => { rel = r; }); return { p, release: (v) => rel(v) }; };
    const rewriteUrl = (body) => body.replace(/https:\/\/example\.invalid\/pay\?tx=(\d+)/g, (m, tx) => STUB_PREFIX + tx); // [URL]
    const open = async (opts = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      const R = { nav: [], posts: [], hold: { lp: null, cash: null }, pageErrors: [] };
      // [URL] 供應商付款頁：攔截並回傳本機替身頁，記錄導向網址（瀏覽器不會連到外部）
      await ctx.route(/^https:\/\/([a-z0-9-]+\.)*line\.me\//, (r) => { R.nav.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>LINE Pay stub</title><p id="stub">LINE Pay stub</p>' }); });
      if (opts.tokens) await ctx.addInitScript((pairs) => { try { for (const [r, t] of pairs) sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, opts.tokens);
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => R.pageErrors.push(String(e && e.message || e)));
      pg.on('request', (rq) => { try { const h = new URL(rq.url()).hostname; if (h && h !== '127.0.0.1' && h !== 'localhost') EXT.push(h); } catch {} });
      // [GATE] 付款建立／改現金：請求照常送到伺服器並取得真實回應；R.hold 有設定時由測試決定何時、以何種方式交付
      await pg.route(/\/api\/line-orders\/popup-payment\/(linepay-request|switch-to-cash)/, async (route) => {
        const kind = /linepay-request/.test(route.request().url()) ? 'lp' : 'cash';
        const rec = { kind, done: false, status: null, body: null, held: false };
        R.posts.push(rec);
        const h = R.hold[kind]; R.hold[kind] = null;
        try {
          if (h && h.pre) await h.pre.p;
          const resp = await route.fetch(); const body = await resp.text();
          rec.status = resp.status(); rec.body = body;
          if (h) { rec.held = true; h.arrived.release(rec); }
          const how = h ? await h.g.p : 'ok';
          rec.how = how;
          if (how === 'abort') await route.abort('failed');
          else if (how === 'badjson') await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":tr' });
          else await route.fulfill({ status: resp.status(), headers: resp.headers(), body: kind === 'lp' ? rewriteUrl(body) : body });
        } catch (e) { rec.err = String(e && e.message || e); } finally { rec.done = true; }
      });
      return { ctx, pg, R };
    };
    const holdNext = (R, kind, withPre) => { const h = { g: gate(), arrived: gate(), pre: withPre ? gate() : null }; R.hold[kind] = h; return h; };
    const ui = (pg) => pg.evaluate(() => {
      const root = document.getElementById('popupRoot');
      const st = document.querySelector('[data-testid=popup-payment-state]'); const est = document.querySelector('[data-testid=popup-order-establishment]');
      const b = (id) => { const x = document.getElementById(id); return x ? { disabled: x.disabled, text: x.textContent.trim() } : null; };
      const err = document.getElementById('popupPaymentErrorRegion'); const t = document.getElementById('toast');
      return { view: root ? root.getAttribute('data-popup-view') : null, url: location.href,
        session: (typeof popupSession !== 'undefined' && popupSession) ? popupSession.public_code : null,
        ref: (typeof _popupPayView !== 'undefined' && _popupPayView && _popupPayView.el && _popupPayView.el.isConnected) ? _popupPayView.ref : null,
        state: st ? st.textContent : '', est: est ? est.textContent : '', pay: b('popupPayGoBtn'), cash: b('popupPaySwitchCashBtn'), refresh: b('popupPayRefreshBtn'),
        err: err ? err.textContent : '', notice: Array.from(document.querySelectorAll('#popupRoot .popup-order-notice')).map((n) => n.textContent.trim()).filter(Boolean).join('｜').slice(0, 300),
        orderNo: ((root && root.innerText.match(/訂單編號：(\S+)/)) || [])[1] || null, toast: t ? { text: t.textContent, show: t.classList.contains('show') } : null,
        text: root ? root.innerText.replace(/\s+/g, ' ').slice(0, 240) : '' };
    });
    const until = async (pg, fn, max = 15000) => { const t0 = RealDate.now(); for (;;) { const u = await ui(pg).catch(() => null); if (u && fn(u)) return u; if (RealDate.now() - t0 > max) return u; await sleep(80); } };
    const waitSessionReady = async (pg, sc) => { await pg.waitForFunction((c) => typeof popupSession !== 'undefined' && popupSession && popupSession.public_code === c && document.getElementById('popupRoot').getAttribute('data-popup-view') === 'session' && !!document.querySelector('li[data-product-id="731"] .popup-order-qty-btn'), sc, { timeout: 20000 }); await sleep(500); };
    const waitPayScreen = async (pg) => { await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 20000 }); await sleep(450); };
    // [BR] 真實按鈕：場次頁「📅 選擇其他場次」→ 選擇另一個場次（建立瀏覽器歷史紀錄：場次二 → 場次一）
    const openViaSwitch = async (pg) => {
      await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC2)}`, { waitUntil: 'domcontentloaded' });
      await waitSessionReady(pg, SC2);
      await pg.click('[data-session-switch=open]');
      await pg.waitForSelector(`button.popup-order-session-btn[data-session-code="${SC1}"]`, { timeout: 15000 }); await sleep(400);
      await pg.click(`button.popup-order-session-btn[data-session-code="${SC1}"]`);
      await waitSessionReady(pg, SC1);
    };
    // [BR] 真實按鈕：瀏覽器結帳（選商品 → 填資料 → 選 LINE Pay → 確認 → 送出）→ 付款畫面
    const spaCheckout = async (pg) => {
      await pg.locator('li[data-product-id="731"] .popup-order-qty-btn').nth(1).click(); await sleep(350);
      await pg.click('#popupGoDetailsBtn'); await pg.waitForSelector('#popupCustomerName', { state: 'visible', timeout: 8000 }); await sleep(350);
      await pg.fill('#popupCustomerName', '時序測試'); await pg.fill('#popupCustomerPhone', PHONE);
      await pg.locator('#popupRoot [data-payment-code="linepay"]').click(); await sleep(250);
      await pg.click('#popupGoConfirmBtn'); await pg.waitForSelector('#popupCheckoutSubmitBtn', { state: 'visible', timeout: 8000 }); await sleep(350);
      await pg.click('#popupCheckoutSubmitBtn');
      await waitPayScreen(pg);
      const ref = await pg.evaluate(() => _popupPayView && _popupPayView.ref); // 觀測：本頁顯示中的付款識別
      const token = await pg.evaluate((r) => sessionStorage.getItem('line_popup_pay_v1_' + r), ref);
      const u = await ui(pg);
      return { ref, token, orderNo: u.orderNo, id: await K.idOf(u.orderNo) };
    };
    const startOnSC1 = async (pg) => { await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC1)}`, { waitUntil: 'domcontentloaded' }); await waitSessionReady(pg, SC1); };
    const openReturn = async (ref, token, sc) => { const r = await open({ tokens: [[ref, token]] }); await r.pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(sc || SC1)}&popup_pay_ref=${ref}&popup_pay_result=pending`, { waitUntil: 'domcontentloaded' }); await waitPayScreen(r.pg); return r; };
    const refreshTo = async (pg, re) => { await pg.click('#popupPayRefreshBtn'); return until(pg, (u) => re.test(u.state) && u.refresh && !u.refresh.disabled && /已查詢/.test(u.text)); };
    // [BR] 瀏覽器「上一頁」直到回到場次二（付款畫面 → 場次二場次頁；路徑上的結帳步驟紀錄不改變付款畫面）
    const backTo = async (pg, sc) => { for (let i = 0; i < 8; i++) { const u = await ui(pg); if (u.view === 'session' && u.session === sc) break; await pg.goBack({ timeout: 4000 }).catch(() => {}); await sleep(700); } return until(pg, (u) => u.view === 'session' && u.session === sc, 15000); };
    const fwdTo = async (pg, sc) => { for (let i = 0; i < 8; i++) { const u = await ui(pg); if (u.view === 'session' && u.session === sc) break; await pg.goForward({ timeout: 4000 }).catch(() => {}); await sleep(700); } return until(pg, (u) => u.view === 'session' && u.session === sc, 15000); };
    const settle = async (rec, ms = 900) => { const t0 = RealDate.now(); while (!rec.done && RealDate.now() - t0 < 10000) await sleep(50); await sleep(ms); };
    const short = (u) => u && ({ view: u.view, session: u.session === SC1 ? 'SC1' : (u.session === SC2 ? 'SC2' : u.session), ref: u.ref ? u.ref.slice(0, 8) : null, state: u.state, est: u.est, pay: u.pay, cash: u.cash, err: u.err, notice: u.notice.slice(0, 120), toast: u.toast, nav: undefined });
    const bodyOf = (rec) => { try { const j = JSON.parse(rec.body); return { http: rec.status, success: j.success, error: j.error, state: j.data && j.data.state, label: j.data && j.data.state_label, url: !!(j.data && j.data.payment_url) }; } catch { return { http: rec.status }; } };
    const posts = (R, kind) => R.posts.filter((p) => p.kind === kind).length;
    // [BR] 真實按鈕：快閃「📜 我的訂單」登入 →「切換帳號」→ 以同一支電話重新登入（切回）→ 關閉
    const lookupLogin = async (pg) => {
      await pg.waitForSelector('#popupLookupPhone', { state: 'visible', timeout: 8000 });
      await pg.fill('#popupLookupPhone', PHONE);
      await pg.click('.popup-order-lookup-submit');
      await pg.waitForFunction(() => Array.from(document.querySelectorAll('#popupLookupBody button')).some((b) => /切換帳號/.test(b.textContent)), null, { timeout: 15000 });
      await sleep(300);
    };
    const switchAccountAndBack = async (pg) => {
      await pg.click('#popupRoot [data-lookup-open=history]');
      await lookupLogin(pg);
      await pg.locator('#popupLookupBody button', { hasText: '切換帳號' }).click();
      await pg.waitForSelector('#popupLookupPhone', { state: 'visible', timeout: 8000 }); await sleep(300);
      await lookupLogin(pg); // 切回同一帳號
      await pg.click('.popup-order-lookup-close'); await sleep(400);
    };

    const lp0 = () => lpCount().request;

    // ══════════════ D1：舊 409 延遲送達，較新的查詢已顯示「已付款」 ══════════════
    await step('D1P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toReview(o.token);                                   // [API] 同一付款已在其他視窗進入 LINE Pay、結果確認中
      const before = await ui(pg);
      const h = holdNext(R, 'lp');
      const n0 = lp0();
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;                               // 伺服器已回 409（付款結果確認中），回應被延遲
      const rc = await K.reconcile(o.ref);                         // [API] 後台核對 → 已付款
      const fresh = await refreshTo(pg, /已付款/);                 // [BR] 顧客按「重新查詢付款狀態」→ 已付款
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg); const s = await K.snap(o.id);
      await ctx.close();
      LOGS.D1P = { before: short(before), stale: bodyOf(rec), reconcile: rc.status, fresh: short(fresh), after: short(after), lpReq: lp0() - n0, posts: posts(R, 'lp'), db: s.o };
      assert(bodyOf(rec).http === 409 && bodyOf(rec).state === 'payment_under_review' && /已付款/.test(fresh.state)
        && /已付款/.test(after.state) && !/確認中/.test(after.state) && after.ref === o.ref && !after.pay && !after.cash && /成立/.test(after.est)
        && lp0() - n0 === 0 && posts(R, 'lp') === 1 && s.o.payment_status === 'paid',
      'D1P [BR][GATE][API] 前往 LINE Pay：舊的 409（付款結果確認中）延遲送達前，較新的查詢已顯示「已付款」→ 畫面保留已付款與成立狀態，不退回確認中；LINE Pay Request 0 次、付款建立 POST 只有 1 次', JSON.stringify(LOGS.D1P));
    });
    await step('D1C', 'DE', async () => {
      const { ctx, pg, R } = await openReturn(X.c1.attempt_id, X.c1.token);   // [FX] 較新一筆確定失敗 → 顯示「改用現金」
      const before = await ui(pg);
      lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await K.cb(F.c1.call); lpCtrl({}); // [API] 顧客看著畫面時，同單較早一筆進入待核對
      const s0 = await K.snap(F.c1.id);
      const h = holdNext(R, 'cash');
      await pg.click('#popupPaySwitchCashBtn');
      const rec = await h.arrived.p;
      const rc = await K.reconcile(F.c1.payment.ref);
      const fresh = await refreshTo(pg, /已付款/);
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg); const s = await K.snap(F.c1.id);
      await ctx.close();
      LOGS.D1C = { before: short(before), s0: s0.a.map((a) => a.status), stale: bodyOf(rec), reconcile: rc.status, fresh: short(fresh), after: short(after), posts: posts(R, 'cash'), db: s.o };
      assert(before.cash && bodyOf(rec).http === 409 && /已付款/.test(fresh.state) && /已付款/.test(after.state) && !/確認中|取貨時/.test(after.state) && after.ref === X.c1.attempt_id && !after.cash && !after.pay
        && posts(R, 'cash') === 1 && s.o.payment_method === 'linepay' && s.o.payment_status === 'paid',
      'D1C [BR][GATE][FX][API] 改用現金：舊的 409 延遲送達前，較新的查詢已顯示「已付款」→ 畫面保留已付款，不退回確認中、不出現改現金；訂單仍為 LINE Pay 已付款', JSON.stringify(LOGS.D1C));
    });

    // ══════════════ D2：舊 409 延遲送達，顧客已離開付款頁並切換到另一場次（瀏覽器上一頁） ══════════════
    await step('D2P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      await K.toReview(o.token);
      const h = holdNext(R, 'lp');
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;
      const left = await backTo(pg, SC2);
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      await ctx.close();
      LOGS.D2P = { stale: bodyOf(rec), left: short(left), after: short(after), nav: R.nav, posts: posts(R, 'lp'), pageErrors: R.pageErrors };
      assert(bodyOf(rec).http === 409 && left.view === 'session' && left.session === SC2 && after.view === 'session' && after.session === SC2 && !after.state && R.nav.length === 0 && posts(R, 'lp') === 1
        && (!after.toast || !after.toast.text || after.toast.text.includes(NOTICE)),
      'D2P [BR][GATE][API] 前往 LINE Pay：回應延遲期間顧客按瀏覽器上一頁離開付款頁、回到場次二 → 舊 409 不把舊付款頁拉回，畫面保留場次二；不導向、不補送', JSON.stringify(LOGS.D2P));
    });
    await step('D2C', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token);                                   // [API] 付款取消（確定未付款）
      await refreshTo(pg, /失敗/);                                  // [BR] 重新查詢 → 出現「改用現金」
      const h = holdNext(R, 'cash', true);
      await pg.click('#popupPaySwitchCashBtn');
      await sleep(300);
      const other = await K.cash(o.token);                         // [API] 同一顧客在其他視窗已先改用現金 → 本頁請求會被後端拒絕（409）
      h.pre.release(); const rec = await h.arrived.p;
      const left = await backTo(pg, SC2);
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg); const s = await K.snap(o.id);
      await ctx.close();
      LOGS.D2C = { other: other.status, stale: bodyOf(rec), left: short(left), after: short(after), posts: posts(R, 'cash'), db: s.o, al: s.al };
      assert(other.status === 200 && bodyOf(rec).http === 409 && after.view === 'session' && after.session === SC2 && !after.state && posts(R, 'cash') === 1 && s.o.payment_method === 'cash'
        && s.al.length > 0 && s.al.every((a) => a.status === 'active' && a.stock_state === 'committed'),
      'D2C [BR][GATE][API] 改用現金：回應延遲期間離開付款頁、回到場次二 → 舊 409 不把舊付款頁拉回；改現金只成立一次（名額已轉為成立、無重複）', JSON.stringify(LOGS.D2C));
    });

    // ══════════════ D3：切換場次後又切回原場次（瀏覽器上一頁 → 下一頁），舊操作仍失效 ══════════════
    await step('D3P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      await K.toReview(o.token);
      const h = holdNext(R, 'lp');
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;
      await backTo(pg, SC2); const back = await fwdTo(pg, SC1);   // 切回原場次（同一個場次代碼）
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      await ctx.close();
      LOGS.D3P = { stale: bodyOf(rec), back: short(back), after: short(after), nav: R.nav, posts: posts(R, 'lp') };
      assert(bodyOf(rec).http === 409 && back.view === 'session' && back.session === SC1 && after.view === 'session' && after.session === SC1 && !after.state && R.nav.length === 0 && posts(R, 'lp') === 1,
      'D3P [BR][GATE][API] 前往 LINE Pay：切到場次二再切回原場次一後，舊 409 才送達 → 仍不接管畫面（停在場次一選購頁，不回到舊付款頁）', JSON.stringify(LOGS.D3P));
    });
    await step('D3C', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token); await refreshTo(pg, /失敗/);
      const h = holdNext(R, 'cash', true);
      await pg.click('#popupPaySwitchCashBtn'); await sleep(300);
      const other = await K.cash(o.token);
      h.pre.release(); const rec = await h.arrived.p;
      await backTo(pg, SC2); const back = await fwdTo(pg, SC1);
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      await ctx.close();
      LOGS.D3C = { other: other.status, stale: bodyOf(rec), back: short(back), after: short(after), posts: posts(R, 'cash') };
      assert(bodyOf(rec).http === 409 && back.session === SC1 && after.view === 'session' && after.session === SC1 && !after.state && posts(R, 'cash') === 1,
      'D3C [BR][GATE][API] 改用現金：切到場次二再切回場次一後，舊 409 才送達 → 仍不接管畫面', JSON.stringify(LOGS.D3C));
    });

    // ══════════════ D4：舊 409 延遲送達，畫面已顯示另一筆付款 ══════════════
    await step('D4P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toReview(o.token);
      const B = await K.order(); await K.toPaid(B.payment.token);  // 另一筆已付款訂單
      const h = holdNext(R, 'lp');
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;
      await pg.evaluate(([r, t]) => { sessionStorage.setItem('line_popup_pay_v1_' + r, t); return popupHandlePaymentReturn(r); }, [B.payment.ref, B.payment.token]); // [FN][SS]
      const shown = await until(pg, (u) => u.ref === B.payment.ref && /已付款/.test(u.state));
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      await ctx.close();
      LOGS.D4P = { stale: bodyOf(rec), shown: short(shown), after: short(after), posts: posts(R, 'lp') };
      assert(bodyOf(rec).http === 409 && after.ref === B.payment.ref && after.orderNo === B.order_number && /已付款/.test(after.state) && !after.pay && !after.cash && posts(R, 'lp') === 1,
      'D4P [BR][GATE][FN][API] 前往 LINE Pay：舊 409 延遲送達時畫面已顯示另一筆（已付款）付款 → 保留另一筆付款，不被覆蓋成舊付款的確認中', JSON.stringify(LOGS.D4P));
    });
    await step('D4C', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token); await refreshTo(pg, /失敗/);
      const B = await K.order(); await K.toPaid(B.payment.token);
      const h = holdNext(R, 'cash', true);
      await pg.click('#popupPaySwitchCashBtn'); await sleep(300);
      const other = await K.cash(o.token);
      h.pre.release(); const rec = await h.arrived.p;
      await pg.evaluate(([r, t]) => { sessionStorage.setItem('line_popup_pay_v1_' + r, t); return popupHandlePaymentReturn(r); }, [B.payment.ref, B.payment.token]); // [FN][SS]
      const shown = await until(pg, (u) => u.ref === B.payment.ref && /已付款/.test(u.state));
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      await ctx.close();
      LOGS.D4C = { other: other.status, stale: bodyOf(rec), shown: short(shown), after: short(after), posts: posts(R, 'cash') };
      assert(bodyOf(rec).http === 409 && after.ref === B.payment.ref && after.orderNo === B.order_number && /已付款/.test(after.state) && !/取貨時/.test(after.state) && posts(R, 'cash') === 1,
      'D4C [BR][GATE][FN][API] 改用現金：舊 409 延遲送達時畫面已顯示另一筆付款 → 保留另一筆付款，不被覆蓋', JSON.stringify(LOGS.D4C));
    });

    // ══════════════ D5：舊 409 延遲送達，已切換帳號（並切回同一帳號）══════════════
    await step('D5P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toReview(o.token);
      const before = await ui(pg);
      const h = holdNext(R, 'lp');
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;
      await switchAccountAndBack(pg);                              // [BR] 我的訂單 → 切換帳號 → 以同一支電話重新登入
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      // 之後仍可正常操作：再按一次（有效操作）→ 後端 409 → 依目前摘要更新、移除付款按鈕
      let again = after; // 舊回應若已接管畫面（付款按鈕已消失），就無法再按；斷言會指出畫面已被覆蓋
      if (after.pay && !after.pay.disabled) { await pg.click('#popupPayGoBtn'); again = await until(pg, (u) => /確認中/.test(u.state) && !u.pay, 8000); }
      await ctx.close();
      LOGS.D5P = { before: short(before), stale: bodyOf(rec), after: short(after), again: short(again), posts: posts(R, 'lp') };
      assert(bodyOf(rec).http === 409 && after.view === 'payment' && after.ref === o.ref && after.state === before.state && !/確認中/.test(after.state) && after.pay && !after.pay.disabled && after.pay.text === before.pay.text && !after.err
        && /確認中/.test(again.state) && !again.pay && posts(R, 'lp') === 2,
      'D5P [BR][GATE][API] 前往 LINE Pay：回應延遲期間「切換帳號」後又切回同一帳號 → 舊身份的 409 不套用（畫面維持原狀、按鈕恢復可用、無錯誤提示）；之後再按一次為有效操作，正確更新為確認中並移除付款按鈕', JSON.stringify(LOGS.D5P));
    });
    await step('D5C', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token); const before = await refreshTo(pg, /失敗/);
      const h = holdNext(R, 'cash', true);
      await pg.click('#popupPaySwitchCashBtn'); await sleep(300);
      const other = await K.cash(o.token);
      h.pre.release(); const rec = await h.arrived.p;
      await switchAccountAndBack(pg);
      h.g.release('ok'); await settle(rec);
      const after = await ui(pg);
      let again = after;
      if (after.cash && !after.cash.disabled) { await pg.click('#popupPaySwitchCashBtn'); again = await until(pg, (u) => /取貨/.test(u.state) && !u.cash, 8000); }
      const s = await K.snap(o.id);
      await ctx.close();
      LOGS.D5C = { other: other.status, before: short(before), stale: bodyOf(rec), after: short(after), again: short(again), posts: posts(R, 'cash'), al: s.al };
      assert(bodyOf(rec).http === 409 && after.view === 'payment' && after.ref === o.ref && after.state === before.state && after.cash && !after.cash.disabled && !after.err
        && /取貨/.test(again.state) && !again.cash && posts(R, 'cash') === 2 && s.al.every((a) => a.status === 'active' && a.stock_state === 'committed'),
      'D5C [BR][GATE][API] 改用現金：回應延遲期間切換帳號又切回 → 舊身份的 409 不套用、按鈕恢復可用；之後再按為有效操作，依目前摘要顯示取貨時付款', JSON.stringify(LOGS.D5C));
    });

    // ══════════════ G6：沒有離頁或較新結果 → 有效 409 照常更新目前摘要 ══════════════
    await step('G6P', 'G', async () => {
      const out = {};
      { // (a) 付款結果確認中
        const { ctx, pg, R } = await open();
        await startOnSC1(pg); const o = await spaCheckout(pg);
        await K.toReview(o.token);
        const h = holdNext(R, 'lp');
        await pg.click('#popupPayGoBtn');
        const rec = await h.arrived.p; h.g.release('ok'); await settle(rec);
        const u = await ui(pg); await ctx.close();
        out.review = { ok: bodyOf(rec).http === 409 && u.ref === o.ref && /確認中/.test(u.state) && !u.pay && !u.cash && /請勿/.test(u.notice), u: short(u) };
      }
      { // (b) 整張訂單已付款
        const { ctx, pg } = await open();
        await startOnSC1(pg); const o = await spaCheckout(pg);
        await K.toPaid(o.token);
        await pg.click('#popupPayGoBtn');
        const u = await until(pg, (x) => /已付款/.test(x.state), 8000); await ctx.close();
        out.paid = { ok: u.ref === o.ref && /已付款/.test(u.state) && /成立/.test(u.est) && !u.pay && !u.cash, u: short(u) };
      }
      LOGS.G6P = out;
      assert(out.review.ok && out.paid.ok, 'G6P [BR][API] 前往 LINE Pay：仍在原付款頁且沒有較新結果時，有效 409 依目前摘要重畫——確認中移除付款／改現金按鈕；已付款顯示已付款與成立狀態', JSON.stringify(out));
    });
    await step('G6C', 'G', async () => {
      const { ctx, pg, R } = await openReturn(X.c6.attempt_id, X.c6.token);  // [FX]
      const before = await ui(pg);
      lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await K.cb(F.c6.call); lpCtrl({}); // [API] 同單另一筆進入待核對
      const h = holdNext(R, 'cash');
      await pg.click('#popupPaySwitchCashBtn');
      const rec = await h.arrived.p; h.g.release('ok'); await settle(rec);
      const u = await ui(pg); const s = await K.snap(F.c6.id); await ctx.close();
      LOGS.G6C = { before: short(before), resp: bodyOf(rec), u: short(u), db: s.o };
      assert(before.cash && bodyOf(rec).http === 409 && /確認中/.test(u.state) && !u.cash && !u.pay && s.o.payment_method === 'linepay',
        'G6C [BR][FX][API] 改用現金：仍在原付款頁時收到有效 409（確認中）→ 依目前摘要重畫、改現金按鈕消失，訂單仍為 LINE Pay', JSON.stringify(LOGS.G6C));
    });

    // ══════════════ G7／G8：正常付款建立、正常改現金 ══════════════
    await step('G7P', 'G', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      const n0 = lp0();
      await pg.click('#popupPayGoBtn');
      await pg.waitForURL(/line\.me/, { timeout: 10000 }).catch(() => {});
      await sleep(400);
      const url = pg.url(); const n1 = lp0();
      await ctx.close();
      LOGS.G7P = { nav: R.nav.map((u) => u.replace(/mockTx=\d+/, 'mockTx=…')), url: url.replace(/mockTx=\d+/, 'mockTx=…'), lpReq: n1 - n0, posts: posts(R, 'lp') };
      assert(R.nav.length === 1 && R.nav[0].startsWith(STUB_PREFIX) && url.startsWith(STUB_PREFIX) && n1 - n0 === 1 && posts(R, 'lp') === 1,
        'G7P [BR][API][URL] 正常建立付款：LINE Pay Request 1 次，頁面導向允許的 LINE Pay 付款網址（以本機替身頁攔截）', JSON.stringify(LOGS.G7P));
    });
    await step('G8C', 'G', async () => {
      const { ctx, pg, R } = await open();
      await startOnSC1(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token); await refreshTo(pg, /失敗/);
      const s0 = await K.snap(o.id);
      await pg.click('#popupPaySwitchCashBtn');
      const u = await until(pg, (x) => /取貨/.test(x.state), 8000);
      const s = await K.snap(o.id); await ctx.close();
      LOGS.G8C = { u: short(u), al0: s0.al, al: s.al, db: s.o, posts: posts(R, 'cash') };
      assert(/取貨時/.test(u.state) && /已改為取貨時以現金付款/.test(u.notice) && !u.cash && !u.pay && s.o.payment_method === 'cash' && s.al.length === s0.al.length
        && s0.al.every((a) => a.stock_state === 'reserved') && s.al.every((a) => a.status === 'active' && a.stock_state === 'committed') && posts(R, 'cash') === 1,
        'G8C [BR][API] 正常改用現金：顯示取貨時付款；名額由保留轉為成立一次（筆數不變、不重複），改現金 POST 1 次', JSON.stringify(LOGS.G8C));
    });

    // ══════════════ D9：成功回應延遲，期間畫面已失效 ══════════════
    await step('D9P', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      const n0 = lp0();
      const h = holdNext(R, 'lp');
      await pg.click('#popupPayGoBtn');
      const rec = await h.arrived.p;
      await backTo(pg, SC2);
      h.g.release('ok'); await settle(rec, 1500);
      const after = await ui(pg).catch(() => ({ url: pg.url() }));
      await ctx.close();
      LOGS.D9P = { resp: bodyOf(rec), after: short(after), url: (after.url || '').replace(/mockTx=\d+/, 'mockTx=…'), nav: R.nav.length, lpReq: lp0() - n0, posts: posts(R, 'lp') };
      assert(bodyOf(rec).http === 200 && bodyOf(rec).url && R.nav.length === 0 && after.view === 'session' && after.session === SC2 && lp0() - n0 === 1 && posts(R, 'lp') === 1,
        'D9P [BR][GATE][API] 付款建立成功但回應延遲，期間顧客已回到場次二 → 不執行過時導向、不接管畫面（後端已建立的付款不撤銷，也不補送）', JSON.stringify(LOGS.D9P));
    });
    await step('D9C', 'DE', async () => {
      const { ctx, pg, R } = await open();
      await openViaSwitch(pg); const o = await spaCheckout(pg);
      await K.toFailed(o.token); await refreshTo(pg, /失敗/);
      const h = holdNext(R, 'cash');
      await pg.click('#popupPaySwitchCashBtn');
      const rec = await h.arrived.p;
      await backTo(pg, SC2);
      h.g.release('ok'); await settle(rec, 1200);
      const after = await ui(pg); const s = await K.snap(o.id);
      await ctx.close();
      LOGS.D9C = { resp: bodyOf(rec), after: short(after), db: s.o, al: s.al, posts: posts(R, 'cash') };
      assert(bodyOf(rec).http === 200 && after.view === 'session' && after.session === SC2 && !after.state && s.o.payment_method === 'cash' && s.al.every((a) => a.status === 'active' && a.stock_state === 'committed') && posts(R, 'cash') === 1
        && (!after.toast || !after.toast.text || after.toast.text.includes(NOTICE)),
        'D9C [BR][GATE][API] 改用現金成功但回應延遲，期間已回到場次二 → 不把付款頁拉回；後端改現金只執行一次（不補送、不重試）', JSON.stringify(LOGS.D9C));
    });

    // ══════════════ D10：網路錯誤／無效 JSON／清理流程 ══════════════
    await step('D10', 'DE', async () => {
      const out = {};
      { // (a) 舊操作網路錯誤時，較新的付款操作正在進行：舊操作不得清除新操作的忙碌狀態，也不得鎖住新付款
        const { ctx, pg, R } = await open();
        await startOnSC1(pg); const o = await spaCheckout(pg);
        const B = await K.order();                                  // 另一筆待付款訂單
        const hA = holdNext(R, 'lp');
        await pg.click('#popupPayGoBtn');
        const recA = await hA.arrived.p;
        await pg.evaluate(([r, t]) => { sessionStorage.setItem('line_popup_pay_v1_' + r, t); return popupHandlePaymentReturn(r); }, [B.payment.ref, B.payment.token]); // [FN][SS]
        await until(pg, (u) => u.ref === B.payment.ref && u.pay && !u.pay.disabled);
        await sleep(400);
        const hB = holdNext(R, 'lp');
        await pg.click('#popupPayGoBtn');                           // 新畫面（另一筆）的付款按鈕
        const recB = await Promise.race([hB.arrived.p, sleep(5000).then(() => null)]);
        const busyB = await ui(pg);
        hA.g.release('abort'); await settle(recA, 700);
        const afterA = await ui(pg);
        if (recB) { hB.g.release('ok'); await settle(recB, 400); }
        await pg.waitForURL(/line\.me/, { timeout: 8000 }).catch(() => {});
        out.busy = { ok: !!recB && busyB.pay && busyB.pay.disabled && afterA.ref === B.payment.ref && afterA.pay && afterA.pay.disabled && /正在建立/.test(afterA.pay.text) && !afterA.err
            && R.nav.length === 1 && R.nav[0].startsWith(STUB_PREFIX),
          recB: !!recB, busyB: busyB.pay, afterA: { ref: (afterA.ref || '').slice(0, 8), pay: afterA.pay, err: afterA.err }, nav: R.nav.length };
        await ctx.close();
      }
      { // (b) 舊操作回應內容無法解析：較新查詢已更新畫面 → 新畫面不被寫入錯誤、按鈕可用
        const { ctx, pg, R } = await open();
        await startOnSC1(pg); const o = await spaCheckout(pg);
        await K.toFailed(o.token); await refreshTo(pg, /失敗/);
        const h = holdNext(R, 'cash');
        await pg.click('#popupPaySwitchCashBtn');
        const rec = await h.arrived.p;                              // 後端已改現金
        const fresh = await refreshTo(pg, /取貨/);
        h.g.release('badjson'); await settle(rec);
        const u = await ui(pg); await ctx.close();
        out.badjson = { ok: /取貨/.test(u.state) && !u.err && u.refresh && !u.refresh.disabled && u.ref === o.ref && posts(R, 'cash') === 1, fresh: fresh.state, u: short(u) };
      }
      { // (c) 有效操作網路錯誤：顯示錯誤、按鈕恢復，可再操作（不自動重試）
        const { ctx, pg, R } = await open();
        await startOnSC1(pg); const o = await spaCheckout(pg);
        const h = holdNext(R, 'lp');
        await pg.click('#popupPayGoBtn');
        const rec = await h.arrived.p; h.g.release('abort'); await settle(rec);
        const u = await ui(pg); const p1 = posts(R, 'lp');
        await pg.click('#popupPayGoBtn');                           // 再按一次：照常送出（不是永久鎖住）
        await pg.waitForURL(/line\.me/, { timeout: 8000 }).catch(() => {});
        out.valid = { ok: /網路異常/.test(u.err) && u.pay && !u.pay.disabled && /前往 LINE Pay 付款/.test(u.pay.text) && p1 === 1 && posts(R, 'lp') === 2 && R.nav.length === 1, u: short(u), p1, p2: posts(R, 'lp') };
        await ctx.close();
      }
      LOGS.D10 = out;
      assert(out.busy.ok && out.badjson.ok && out.valid.ok,
        'D10 [BR][GATE][FN][API] 清理流程：舊操作的網路錯誤不清除較新操作的忙碌狀態、也不鎖住另一筆付款（新操作照常完成導向）；舊操作的無效 JSON 不寫入新畫面；有效操作的網路錯誤顯示提示並恢復按鈕、可再操作、不自動重試', JSON.stringify(out));
    });

    await step('Z', 'G', async () => {
      const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
      const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
      const lineReal = boots.reduce((n, b) => n + b.mf.real(), 0);
      const extHosts = [...new Set(EXT)].sort();
      const isolated = (LOGS.isolation || []).includes('--no-proxy-server') && (LOGS.isolation || []).some((x) => /host-resolver-rules=MAP \* ~NOTFOUND/.test(x));
      assert(real === 0 && unexpected === 0 && lineReal === 0 && isolated,
        'Z 真實 LINE／LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；Chrome 不經代理且外部主機名稱一律無法解析，line.me 付款網址只由本機替身頁回應（瀏覽器不會連到外部付款網站）',
        JSON.stringify({ real, unexpected, lineReal, counts: lpCount(), isolation: LOGS.isolation, pageRequestedHosts: extHosts }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-2-payment-response-timing', root: H.ROOT, browser: LOGS.browser || null, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*[A-Z]?/) || [''])[0]] || {}).cls || null, detail: mask(r.detail) })), logs: JSON.parse(mask(JSON.stringify(LOGS))) };
  if (process.env.C542RT_RESULT_JSON) fs.writeFileSync(process.env.C542RT_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
