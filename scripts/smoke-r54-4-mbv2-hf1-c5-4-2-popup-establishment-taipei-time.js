#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-2-popup-establishment-taipei-time.js
// R54.4／MBV2-HF1-C5.4.2 —— 快閃訂單成立判定與台北時間一致性：重現／驗收（同一組案例先跑未修改 TIMING_FIX 基準，再跑修正版）
//   E  成立判定：已保存訂購紀錄 ≠ 已完成線上付款；成立／付款／履約分開；API、顧客端、後台同一判定；查詢無新副作用
//   T  時間：快閃訂單建立與狀態更新時間以 Asia/Taipei 呈現；主機 TZ=UTC 與 TZ=Asia/Taipei 結果相同；瀏覽器時區不影響；
//      跨午夜、各更新路徑、歷史資料（已知／不明）、台北今日／最近幾天篩選、付款安全時間不變
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright，實際點擊）；
//   [CLK] 可控制時鐘（c4-test-clock：同時位移伺服器 JS Date 與 sql.js 的 now）；[FX] fixture 直接寫入的歷史資料（明確標示）；
//   [FN] 函式層（明確標示）；[DB] 直接核對資料庫檔
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截（未知路徑立即拋錯並記錄，必須 0 行）；LINE Messaging API 由 c4-line-mock 攔截。
//   本腳本不是 LINE 真機、正式金流或 Sandbox 驗證。
// 分類：DE＝既有顯示／時間缺口（基準即存在）；R＝本輪業務規則調整（新成立規則，基準沒有此輸出）；G＝回歸保護
// 判定一律依 API 回應內容或畫面文字；不以「修正版才有的函式／欄位是否存在」判定基準失敗（R 類除外，明確標示）。
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
const D = H.tmpDir('c542-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c542': 'test-secret-c542' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const ONLY = (process.env.C542_ONLY || '').split(',').filter(Boolean);
const STEP_RE = process.env.C542_STEP ? new RegExp(process.env.C542_STEP) : null;
const META = {};
const LOGS = {};
async function step(name, cls, fn) {
  if (STEP_RE && !STEP_RE.test(name)) return;
  if (ONLY.length && !ONLY.includes(name)) return;
  META[name] = { cls };
  try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); }
}
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [731, '快閃測試品', 1, 'available', { quota: 900, price: 90 }], [732, '零元測試品', 2, 'available', { quota: 900, price: 0 }]];
const POPUP_SETTINGS = (over = {}) => ({ version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: true, description: '測試轉帳帳號 000-123' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 15, allow_fallback_cash: true, expire_cancel_release: true, ...over });
const seedWith = (settings) => (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c542','test-secret-c542')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(settings)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { coupon: true, reports: true, line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};
const env = (off, tz) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
  C4_CLOCK_OFFSET_MS: String(off), TZ: tz, C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
  C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
const offAt = (iso) => Date.parse(iso) - RealDate.now();
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return h * 3600e3 + m * 60e3 - cur; };
const HAS_EST = /已成立/; // 肯定「已成立」的文字（不含「尚未成立」「未成立」）
const isEstablishedText = (s) => HAS_EST.test(String(s || ''));
const mask = (s) => String(s || '').replace(/token=[0-9a-f]+/g, 'token=***').replace(/"token":"[0-9a-f]+"/g, '"token":"***"');

// 共用：開店、場次、下單與付款操作
function makeKit(C, SC, phoneBase) {
  let ph = 0;
  const kit = {};
  kit.adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
  kit.q = async (sql, params) => { await sleep(200); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
  kit.order = async (o = {}) => {
    const phone = o.phone || (phoneBase + String(ph++).padStart(3, '0'));
    const r = await fetch(`${C.s.base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c542k' + crypto.randomBytes(10).toString('hex') },
      body: JSON.stringify({ popup_session_public_code: SC(), customer_name: o.name || '成立測試', customer_phone: phone, payment_method: o.pay || 'linepay', items: [{ product_id: o.pid || 731, qty: o.qty || 1 }] }) });
    const j = await r.json();
    if (!j.success) throw new Error('popup checkout ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    return { ...j.data, phone };
  };
  kit.request = async (o) => {
    const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) });
    await r.json();
    return lpCalls().filter((c) => /request$/.test(c.uri)).pop();
  };
  kit.cb = async (call) => { const u = new URL(call.confirmUrl); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  kit.cancelCb = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); const r = await fetch(`${C.s.base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  kit.status = async (o) => (await (await fetch(`${C.s.base}/api/line-orders/popup-payment/status?token=${o.payment.token}`)).json()).data;
  kit.cash = async (o) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) }); return { status: r.status, json: await r.json() }; };
  kit.lookup = async (body) => { const r = await fetch(`${C.s.base}/api/line-orders/popup-orders/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_code: SC(), ...body }) }); return { status: r.status, json: await r.json() }; };
  kit.list = async (token, page = 1) => (await (await fetch(`${C.s.base}/api/line-orders/popup-orders/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, page }) })).json());
  kit.detail = async (token, no) => (await (await fetch(`${C.s.base}/api/line-orders/popup-orders/detail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, order_number: no }) })).json());
  kit.listAll = async (token) => { let out = []; for (let p = 1; p < 20; p++) { const j = await kit.list(token, p); const os = (j.data && j.data.orders) || []; out = out.concat(os); if (!j.data || !j.data.has_more) break; } return out; };
  kit.ord = async (o) => (await kit.q('SELECT * FROM orders WHERE id=?', [o.id]))[0];
  kit.att = async (o) => kit.q('SELECT * FROM popup_payment_attempts WHERE order_id=? ORDER BY created_at, rowid', [o.id]);
  kit.alloc = async (o) => kit.q('SELECT status, stock_state FROM popup_order_allocations WHERE order_id=?', [o.id]);
  kit.adminList = async (dates) => { const r = await kit.adm('GET', `/api/orders?date_from=${dates[0]}&date_to=${dates[1]}&limit=500`); return (r.json && r.json.data) || []; };
  kit.adminDetail = async (o) => { const r = await kit.adm('GET', `/api/orders/${o.id}`); return r.json && r.json.data; };
  return kit;
}
async function mkSession(kit, name, pickupDate, cutoff) {
  const camp = await kit.adm('POST', '/api/popup-pickup/campaigns', { name: name + ' 活動', status: 'published' });
  const loc = await kit.adm('POST', '/api/popup-pickup/locations', { name: name + ' 地點', address: '台北市中正區測試路1號', lat: 25.04, lng: 121.51 });
  const s = await kit.adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name, status: 'published', pickup_date: pickupDate, pickup_start_time: '17:00', pickup_end_time: '19:00',
    order_open_at: '2026-01-01T00:00', order_cutoff_at: cutoff, location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 900 });
  if (!s.json || !s.json.success) throw new Error('popup session ' + JSON.stringify(s.json).slice(0, 300));
  return s.json.data.public_code;
}
// 從 API 物件取「顯示用時間文字」：修正版提供伺服器格式化的台北時間；基準只有原始字串（前端直接截取前 16 字）
const shownTime = (o, k) => {
  const t = o && o.times && o.times[k];
  if (t && typeof t.text === 'string') return t.text + (t.known === false ? '（時區未確認）' : '');
  const raw = k === 'created' ? o && o.created_at : o && o.updated_at;
  return String(raw || '').slice(0, 16);
};
const estOf = (o) => (o && (o.establishment_label || o.order_status_label)) || '';

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4.2 快閃訂單成立判定與台北時間一致性 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    if (chromium) browser = await chromium.launch(C45.launchOpts());
    const ctxFor = async (tz) => {
      const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, timezoneId: tz, locale: 'zh-TW' });
      await ctx.route(/maps\.googleapis\.com|static\.line-scdn\.net|connect\.facebook\.net|googletagmanager/, (r) => r.fulfill({ status: 200, body: '' }));
      return ctx;
    };
    // 真實 Chrome：開啟快閃場次頁 → 頁首「📜 我的訂單」→ 輸入完整電話查詢 → 回傳列表文字
    const browserLookup = async (base, SC, tz, phone) => {
      const ctx = await ctxFor(tz); const pg = await ctx.newPage();
      const errs = []; pg.on('pageerror', (e) => errs.push(String(e && e.message || e)));
      const reqs = []; pg.on('request', (rq) => { const u = rq.url(); if (/popup-checkout|linepay-request|switch-to-cash/.test(u)) reqs.push(u); });
      await pg.goto(`${base}/popup-order?session=${encodeURIComponent(SC)}`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('[data-lookup-open="history"]', { timeout: 20000 }); await sleep(600);
      await pg.click('[data-lookup-open="history"]'); await pg.waitForSelector('#popupLookupPhone', { timeout: 8000 });
      await pg.fill('#popupLookupPhone', phone); await pg.click('.popup-order-lookup-submit');
      await pg.waitForSelector('.popup-order-lookup-card', { timeout: 10000 }); await sleep(300);
      return { ctx, pg, errs, reqs };
    };
    const cardText = (pg, no) => pg.evaluate((n) => { const li = document.querySelector(`.popup-order-lookup-card[data-order-number="${n}"]`); return li ? li.innerText : null; }, no);
    const openDetailBr = async (pg, no) => {
      await pg.evaluate((n) => { const li = document.querySelector(`.popup-order-lookup-card[data-order-number="${n}"]`); const b = li && Array.from(li.querySelectorAll('button')).find((x) => /查看詳情/.test(x.textContent)); if (b) b.click(); }, no);
      await pg.waitForFunction(() => { const b = document.getElementById('popupLookupBody'); return b && /訂單編號/.test(b.innerText); }, null, { timeout: 10000 }); await sleep(200);
      return pg.evaluate(() => document.getElementById('popupLookupBody').innerText);
    };

    // ══════════════════════════════════════════════════════════════════
    //  E：成立判定（主機 TZ=UTC；伺服器時鐘固定在台北 10:30）
    // ══════════════════════════════════════════════════════════════════
    const OFF_E = TP(10, 30);
    const CE = await C45.boot('c542e', { products: PRODUCTS, members: 5, settings: {}, seed: seedWith(POPUP_SETTINGS({ timeout_minutes: 60 })), env: env(OFF_E, 'UTC') }); boots.push(CE);
    await CE.restart(env(OFF_E, 'UTC')); CE.tok = await H.login(CE.s.base, STORE, 'pw001');
    const dayE = (n) => new Date(RealDate.now() + OFF_E + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    let SCE = null;
    const KE = makeKit(CE, () => SCE, '0922000');
    SCE = await mkSession(KE, 'C542E 場次', dayE(2), dayE(1) + 'T23:00');
    const editDbE = async (fn) => { await CE.s.stop(); try { const db = await H.openDbFile(CE.dbf); try { await fn(db); H.saveDbFile(db, CE.dbf); } finally { db.close(); } } finally { await CE.restart(env(OFF_E, 'UTC')); CE.tok = await H.login(CE.s.base, STORE, 'pw001'); } };
    const PE = '0922111222'; // E 類所有訂單同一支電話（一次查詢即可列出全部）
    const E = {};
    lpCtrl({});
    E.pending = await KE.order({ phone: PE });
    E.requested = await KE.order({ phone: PE }); await KE.request(E.requested);
    E.failed = await KE.order({ phone: PE }); { const c = await KE.request(E.failed); await KE.cancelCb(c); }
    E.cashSwitch = await KE.order({ phone: PE }); { const c = await KE.request(E.cashSwitch); await KE.cancelCb(c); }
    E.paid = await KE.order({ phone: PE }); { const c = await KE.request(E.paid); await KE.cb(c); }
    E.review = await KE.order({ phone: PE }); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const c = await KE.request(E.review); await KE.cb(c); lpCtrl({}); }
    E.storeCancel = await KE.order({ phone: PE }); await KE.adm('PATCH', `/api/orders/${E.storeCancel.id}/status`, { order_status: 'cancelled' });
    E.expired = await KE.order({ phone: PE });
    E.paidCancel = await KE.order({ phone: PE }); { const c = await KE.request(E.paidCancel); await KE.cb(c); await KE.adm('PATCH', `/api/orders/${E.paidCancel.id}/status`, { order_status: 'cancelled' }); }
    E.refunded = await KE.order({ phone: PE }); { const c = await KE.request(E.refunded); await KE.cb(c); await KE.adm('PATCH', `/api/orders/${E.refunded.id}/status`, { order_status: 'cancelled' }); await KE.adm('POST', `/api/orders/${E.refunded.id}/refund-complete`, { note: 'c542' }); }
    E.cash = await KE.order({ phone: PE, pay: 'cash' });
    E.transfer = await KE.order({ phone: PE, pay: 'transfer' });
    E.paidPreparing = await KE.order({ phone: PE }); { const c = await KE.request(E.paidPreparing); await KE.cb(c); await KE.adm('PATCH', `/api/orders/${E.paidPreparing.id}/status`, { order_status: 'accepted' }); await KE.adm('PATCH', `/api/orders/${E.paidPreparing.id}/status`, { order_status: 'preparing' }); }
    E.unpaidAccepted = await KE.order({ phone: PE }); { const c = await KE.request(E.unpaidAccepted); await KE.cancelCb(c); await KE.adm('PATCH', `/api/orders/${E.unpaidAccepted.id}/status`, { order_status: 'accepted' }); }
    E.histPaidFail = await KE.order({ phone: PE }); { const c = await KE.request(E.histPaidFail); await KE.cb(c); }
    E.histReviewFail = await KE.order({ phone: PE }); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); const c = await KE.request(E.histReviewFail); await KE.cb(c); lpCtrl({}); }
    let zero = null; try { zero = await KE.order({ phone: PE, pay: 'cash', pid: 732 }); } catch (e) { zero = { error: String(e.message).slice(0, 160) }; }
    E.zero = zero && zero.id ? zero : null;
    // [FX] 逾時、歷史付款證據（較新的一筆失敗）、舊版未啟用快閃付款設定（legacy）的現金訂單
    await editDbE((db) => {
      db.run('UPDATE popup_payment_attempts SET expires_at=? WHERE order_id=?', [Date.now() + OFF_E - 60000, E.expired.id]);
      const ins = (o, minutesLater) => {
        const src = db.exec('SELECT * FROM popup_payment_attempts WHERE order_id=? ORDER BY created_at LIMIT 1', [o.id])[0];
        const cols = src.columns; const row = src.values[0]; const obj = {}; cols.forEach((c, i) => { obj[c] = row[i]; });
        obj.attempt_id = crypto.randomUUID(); obj.token_hash = crypto.randomBytes(32).toString('hex'); obj.status = 'failed'; obj.fail_reason = 'customer_cancelled';
        obj.failure_basis = 'customer_cancelled_before_confirm'; obj.confirm_state = 'never'; obj.confirm_calls = 0; obj.transaction_id = ''; obj.result_code = ''; obj.review_reason = ''; obj.quarantined_from = '';
        obj.created_at = '2099-01-01 00:0' + minutesLater + ':00'; obj.updated_at = obj.created_at; // 必定是「最新一筆」
        db.run(`INSERT INTO popup_payment_attempts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => obj[c]));
      };
      ins(E.histPaidFail, 1); ins(E.histReviewFail, 2);
      // legacy：暫時移除快閃付款設定（舊版／未啟用快閃付款設定的店家）
      db.run("DELETE FROM settings WHERE store_id='store_001' AND key='popup_payment_settings'");
    });
    let legacy = null; try { legacy = await KE.order({ phone: PE, pay: 'cash' }); } catch (e) { legacy = { error: String(e.message).slice(0, 200) }; }
    E.legacyCash = legacy && legacy.id ? legacy : null;
    await editDbE((db) => { db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(POPUP_SETTINGS({ timeout_minutes: 60 }))]); });
    await KE.status(E.expired); // 觸發既有逾時收斂（lazy reconcile）
    // 改現金（失敗後）：只轉換一次
    const allocBeforeCash = await KE.alloc(E.cashSwitch);
    const cash1 = await KE.cash(E.cashSwitch); const allocAfter1 = await KE.alloc(E.cashSwitch);
    const cash2 = await KE.cash(E.cashSwitch); const allocAfter2 = await KE.alloc(E.cashSwitch);

    // 讀取各畫面資料
    const lkE = await KE.lookup({ phone: PE });
    const tokE = lkE.json && lkE.json.data && lkE.json.data.token;
    const listE = tokE ? await KE.listAll(tokE) : [];
    const byNo = new Map(listE.map((x) => [x.order_number, x]));
    const detE = {}; for (const [k, o] of Object.entries(E)) if (o && tokE) detE[k] = (await KE.detail(tokE, o.order_number)).data || null;
    const stE = {}; for (const [k, o] of Object.entries(E)) if (o && o.payment) stE[k] = await KE.status(o);
    const admE = await KE.adminList([dayE(-1), dayE(1)]);
    const admBy = new Map(admE.map((x) => [x.id, x]));
    const view = (k) => { const o = E[k]; if (!o) return null; const l = byNo.get(o.order_number) || {}; const d = detE[k] || {}; const s = stE[k] || null; const a = admBy.get(o.id) || {};
      return { list: { status: l.status_label, est: l.establishment_label, order: l.order_status_label, pay: l.payment_status_label, reorder: l.reorder_label, ful: l.fulfillment_label },
        detail: { status: d.status_label, est: d.establishment_label, order: d.order_status_label, pay: d.payment_status_label, ful: d.fulfillment_label },
        status: s ? { state: s.state, label: s.state_label, est: s.establishment_label, can_pay: s.can_pay, cash: s.can_switch_to_cash } : null,
        admin: a.payment_display ? { state: a.payment_display.state, est: a.payment_display.establishment_label, established: a.payment_display.established } : null,
        checkout: o.establishment_label || null };
    };
    LOGS.E_views = {}; for (const k of Object.keys(E)) LOGS.E_views[k] = view(k);
    const textsOf = (v) => v ? [v.list.status, v.list.order, v.list.est, v.detail.status, v.detail.order, v.detail.est, v.status && v.status.est, v.admin && v.admin.est, v.checkout].filter((x) => x != null) : [];
    const noEstablished = (k) => textsOf(view(k)).every((t) => !isEstablishedText(t));

    await step('E1', 'DE', async () => {
      const v = { pending: view('pending'), requested: view('requested') };
      assert(noEstablished('pending') && noEstablished('requested') && /待付款/.test(v.pending.list.pay || ''),
        'E1 [API] 有效 LINE Pay 訂單尚未完成付款（未前往付款／已建立付款未完成）：結帳回應、付款狀態、列表、詳情、後台都不顯示「已成立」', JSON.stringify(v));
    });
    await step('E1R', 'R', async () => {
      const v = view('pending'); const v2 = view('requested');
      const all = [v.checkout, v.list.est, v.detail.est, v.status && v.status.est, v.admin && v.admin.est, v2.list.est, v2.detail.est, v2.status && v2.status.est, v2.admin && v2.admin.est];
      assert(all.every((t) => /尚未成立/.test(t || '') && /待付款/.test(t || '')) && v.admin && v.admin.established === false,
        'E1R [API] 新規則：同一筆待付款訂單在結帳回應、付款狀態、列表、詳情、後台皆為「尚未成立，待付款」（後端集中判定）', JSON.stringify(all));
    });
    await step('E2', 'DE', async () => {
      const v = view('failed');
      assert(noEstablished('failed') && /付款失敗/.test(v.status.label) && v.status.cash === true,
        'E2 [API] 顧客取消／付款失敗：付款狀態、列表、詳情、後台皆不顯示「已成立」；仍可依設定改用現金', JSON.stringify(v));
    });
    await step('E2R', 'R', async () => {
      const v = view('failed');
      const all = [v.list.est, v.detail.est, v.status.est, v.admin && v.admin.est];
      assert(all.every((t) => /未成立/.test(t || '') && /付款未完成/.test(t || '')) && v.list.reorder === '重新下單',
        'E2R [API] 新規則：付款失敗＝「未成立，付款未完成」（各畫面相同）；列表操作文字為「重新下單」（不是補繳原單）', JSON.stringify({ all, reorder: v.list.reorder }));
    });
    await step('E3', 'G', async () => {
      const v = view('cashSwitch');
      const committed = (al) => al.filter((x) => x.status === 'active' && x.stock_state === 'committed').length;
      const reserved = (al) => al.filter((x) => x.status === 'active' && x.stock_state === 'reserved').length;
      const ok = cash1.status === 200 && cash2.status === 409 && reserved(allocBeforeCash) === 1 && committed(allocBeforeCash) === 0 && committed(allocAfter1) === 1 && reserved(allocAfter1) === 0
        && JSON.stringify(allocAfter1) === JSON.stringify(allocAfter2) && [v.list.status, v.detail.status].every((t) => !/失敗|未成立|待付款/.test(t || ''));
      assert(ok, 'E3 [API] 付款失敗後成功改現金：名額由保留轉成立只 1 次（重複改現金 409、名額不再變動）；列表／詳情不再顯示失敗或未成立', JSON.stringify({ c1: cash1.status, c2: cash2.status, allocBeforeCash, allocAfter1, v }));
    });
    await step('E3R', 'R', async () => {
      const v = view('cashSwitch');
      const all = [v.list.est, v.detail.est, v.status.est, v.admin && v.admin.est];
      assert(all.every((t) => /^已成立/.test(t || '') && /取貨時付款/.test(t || '')), 'E3R [API] 新規則：改現金成功後各畫面為「已成立，取貨時付款」', JSON.stringify(all));
    });
    await step('E4', 'G', async () => {
      const v = view('paid'); const p = view('paidPreparing');
      const all = [v.list.est || v.list.order, v.detail.est || v.detail.order, v.status.est || '已成立', v.admin ? (v.admin.est || '已成立') : '已成立'];
      assert(all.every((t) => /已成立/.test(t)) && /已付款/.test(v.list.pay) && /準備中/.test(p.list.status || '') && /準備中/.test(String(p.detail.ful || p.detail.order || '')),
        'E4 [API] 後端確認付款成功 → 已成立、已付款；店家接單／準備中等履約進度如實呈現（不被成立文字覆蓋）', JSON.stringify({ paid: v, preparing: p.list, preparingDetail: p.detail }));
    });
    await step('E5', 'DE', async () => {
      const v = view('review');
      const all = textsOf(v);
      assert(v.status.state === 'payment_under_review' && v.status.can_pay === false && v.status.cash === false && /確認中/.test(v.list.pay) && /請勿重複付款/.test(v.list.pay)
        && all.every((t) => !/未付款|付款失敗|付款未完成|已成立/.test(t)) && v.list.reorder !== '重新下單',
        'E5 [API] 付款結果待核對：各畫面維持「付款結果確認中，請勿重複付款」，不判未付款／未完成、不提供付款或改現金、不顯示「重新下單」', JSON.stringify(v));
    });
    await step('E6', 'G', async () => {
      const sc = view('storeCancel'), ex = view('expired'), pc = view('paidCancel'), rf = view('refunded');
      const ok = [sc.list.status, sc.detail.status].every((t) => /已取消/.test(t || '')) && /逾期/.test(ex.list.status || '') && /逾期/.test(ex.detail.status || '')
        && /待退款|退款處理中/.test(pc.list.status || '') && /待退款|退款處理中/.test(pc.list.pay || '') && /已退款/.test(rf.list.pay || '') && !/待付款/.test(rf.list.status + rf.list.pay)
        && [sc, ex, pc, rf].every((v) => textsOf(v).every((t) => !isEstablishedText(t)));
      assert(ok, 'E6 [API] 取消／退款優先順序：店家取消未付款＝已取消；付款逾期＝保留逾期原因；已付款後取消＝已付款・待退款；退款完成＝已退款（不退回待付款）；皆不顯示「已成立」',
        JSON.stringify({ sc: sc.list, ex: ex.list, pc: pc.list, rf: rf.list }));
    });
    await step('E6R', 'R', async () => {
      const ex = view('expired'), pc = view('paidCancel');
      assert(/已取消/.test(ex.list.est || '') && /逾期/.test(ex.list.est || '') && /已取消/.test(pc.list.est || '') && /已付款・待退款/.test(pc.list.est || ''),
        'E6R [API] 新規則：成立欄位＝「已取消（付款逾期）」「已取消、已付款・待退款」', JSON.stringify({ ex: ex.list.est, pc: pc.list.est }));
    });
    await step('E7', 'DE', async () => {
      const a = view('histPaidFail'), b = view('histReviewFail');
      assert(/已付款/.test(a.list.pay || '') && /已付款/.test(a.detail.pay || '') && !/付款失敗|未成立/.test(String(a.list.status) + a.detail.status) && /確認中/.test(b.list.pay || '') && /確認中/.test(b.detail.pay || '') && !/付款失敗|未付款/.test(b.list.status + b.list.pay)
        && (a.admin ? a.admin.state === 'paid' : true) && (b.admin ? b.admin.state === 'under_review' : true),
        'E7 [API][FX] 歷史付款證據：較新的一筆失敗不推翻較早的已付款或待核對（列表、詳情、後台一致）', JSON.stringify({ paidThenFail: a.list, reviewThenFail: b.list, adm: [a.admin, b.admin] }));
    });
    await step('E8', 'G', async () => {
      const c = view('cash'), t = view('transfer'), l = E.legacyCash ? view('legacyCash') : null, z = E.zero ? view('zero') : null;
      const okCash = [c.list.status, c.detail.status].every((x) => /已成立/.test(x || '')) && /取貨時付款/.test(c.list.pay);
      const okT = !/未成立|待付款/.test(t.list.status + (t.list.est || '')) && /確認/.test(t.list.pay || '');
      const okL = !l || ([l.list.status, l.detail.status].every((x) => /已成立/.test(x || '')) && /取貨時付款/.test(l.list.pay));
      const okZ = !z || ([z.list.status].every((x) => /已成立/.test(x || '')));
      assert(okCash && okT && okL && okZ && !!E.legacyCash,
        'E8 [API] 既有契約不被誤判：現金（含 0 元）＝已成立；轉帳＝待店家確認收款、不判未成立；未啟用快閃付款設定（legacy）現金＝已成立', JSON.stringify({ c: c.list, t: t.list, l: l && l.list, z: z ? z.list : zero, legacy: E.legacyCash ? 'ok' : legacy }));
    });
    await step('E9', 'R', async () => {
      const bad = [];
      for (const k of Object.keys(E)) {
        const v = view(k); if (!v) continue;
        const vals = [v.list.est, v.detail.est, v.admin && v.admin.est].concat(v.status ? [v.status.est] : []);
        if (vals.some((x) => !x) || new Set(vals).size !== 1) bad.push({ k, vals });
      }
      assert(bad.length === 0, 'E9 [API] 多畫面一致：每一筆訂單在付款狀態、列表、詳情、後台的成立判定文字完全相同（同一後端判定）', JSON.stringify(bad).slice(0, 1500));
    });
    await step('E10', 'G', async () => {
      const snap = async () => {
        const tabs = (await KE.q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('popup_lookup_sessions','sqlite_sequence')")).map((r) => r.name);
        const db = await H.openDbFile(CE.dbf);
        try {
          const counts = {}; for (const t of tabs) counts[t] = H.q(db, `SELECT COUNT(*) AS c FROM "${t}"`)[0].c;
          const rows = (sql) => crypto.createHash('sha256').update(JSON.stringify(H.q(db, sql))).digest('hex');
          return { counts, orders: rows('SELECT * FROM orders ORDER BY id'), att: rows('SELECT * FROM popup_payment_attempts ORDER BY attempt_id'), alloc: rows('SELECT * FROM popup_order_allocations ORDER BY id'),
            lp: lpCalls().length, line: CE.mf.real(), lineCalls: CE.mf.calls().length };
        } finally { db.close(); }
      };
      await sleep(400);
      const before = await snap();
      for (let i = 0; i < 3; i++) {
        await KE.list(tokE, 1); await KE.list(tokE, 2);
        for (const o of Object.values(E)) if (o) { await KE.detail(tokE, o.order_number); if (o.payment) await KE.status(o); }
        await KE.adminList([dayE(-1), dayE(1)]); for (const o of [E.failed, E.pending, E.paid]) await KE.adminDetail(o);
      }
      await sleep(600);
      const after = await snap();
      const diff = Object.keys(before.counts).filter((k) => before.counts[k] !== after.counts[k]);
      assert(diff.length === 0 && before.orders === after.orders && before.att === after.att && before.alloc === after.alloc && before.lp === after.lp && before.line === after.line && before.lineCalls === after.lineCalls,
        'E10 [API][DB] 重複查詢（付款狀態、列表、詳情、後台各 3 次）：不新增訂單／付款／名額異動／成交或通知，訂單與付款紀錄逐列不變', JSON.stringify({ diff, lp: [before.lp, after.lp], line: [before.line, after.line] }));
    });
    await step('E11', 'DE', async () => {
      if (!browser) throw new Error('需要 playwright');
      const out = {};
      for (const tz of ['Asia/Taipei', 'America/New_York']) {
        const b = await browserLookup(CE.s.base, SCE, tz, PE);
        // 列表可能分頁：逐頁載入
        for (let i = 0; i < 5; i++) { const more = await b.pg.$('.popup-order-lookup-more'); if (!more) break; await more.click(); await sleep(700); }
        const failedCard = await cardText(b.pg, E.failed.order_number);
        const pendingCard = await cardText(b.pg, E.pending.order_number);
        const paidCard = await cardText(b.pg, E.paid.order_number);
        const det = await openDetailBr(b.pg, E.failed.order_number);
        out[tz] = { failedCard, pendingCard, paidCard, det, errs: b.errs };
        await b.ctx.close();
      }
      const t = out['Asia/Taipei'];
      assert(t.failedCard && !isEstablishedText(t.failedCard) && !isEstablishedText(t.pendingCard) && /已成立|已付款/.test(t.paidCard || '') && !isEstablishedText(t.det) && /付款失敗/.test(t.det)
        && out['America/New_York'].failedCard === t.failedCard && !t.errs.length,
        'E11 [BR] 真實 Chrome「📜 我的訂單」：付款失敗、待付款的卡片與詳情不顯示「已成立」，已付款者正常；台北與紐約時區瀏覽器顯示相同', JSON.stringify(out).slice(0, 1800));
    });
    await step('E12', 'R', async () => {
      if (!browser) throw new Error('需要 playwright');
      const b = await browserLookup(CE.s.base, SCE, 'Asia/Taipei', PE);
      for (let i = 0; i < 5; i++) { const more = await b.pg.$('.popup-order-lookup-more'); if (!more) break; await more.click(); await sleep(700); }
      const card = await cardText(b.pg, E.failed.order_number);
      const det = await openDetailBr(b.pg, E.failed.order_number);
      const ordersBefore = (await KE.q('SELECT COUNT(*) AS c FROM orders'))[0].c; const attBefore = (await KE.q('SELECT COUNT(*) AS c FROM popup_payment_attempts'))[0].c; const lp0 = lpCalls().length;
      const btn = await b.pg.evaluate(() => { const bs = Array.from(document.querySelectorAll('#popupLookupBody button')); const x = bs.find((y) => /重新下單/.test(y.textContent)); if (x) { x.click(); return x.textContent; } return null; });
      await sleep(1500);
      const after = await b.pg.evaluate(() => ({ head: (document.querySelector('.popup-order-lookup-title, #popupLookupTitle') || {}).textContent || '', body: (document.getElementById('popupLookupBody') || {}).innerText || '', url: location.href }));
      const ordersAfter = (await KE.q('SELECT COUNT(*) AS c FROM orders'))[0].c; const attAfter = (await KE.q('SELECT COUNT(*) AS c FROM popup_payment_attempts'))[0].c;
      await b.ctx.close();
      assert(/未成立/.test(card) && /重新下單/.test(card) && /未成立/.test(det) && btn && ordersAfter === ordersBefore && attAfter === attBefore && lpCalls().length === lp0 && b.reqs.length === 0 && !/pay\.line\.me/.test(after.url),
        'E12 [BR] 新規則：未成立紀錄顯示「未成立」與「重新下單」；按下只帶回商品選購流程（不自動送單、不建立付款、不呼叫 LINE Pay）', JSON.stringify({ card, btn, after: { ...after, body: after.body.slice(0, 200) }, orders: [ordersBefore, ordersAfter], att: [attBefore, attAfter], reqs: b.reqs }));
    });
    await step('E13', 'R', async () => {
      if (!browser) throw new Error('需要 playwright');
      // 付款頁（顧客取消付款後返回）：付款狀態失敗，同一畫面也必須標示訂單未成立
      const ctx = await ctxFor('Asia/Taipei');
      await ctx.addInitScript(([r, t]) => { try { sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, [E.failed.payment.ref, E.failed.payment.token]);
      const pg = await ctx.newPage();
      await pg.goto(`${CE.s.base}/popup-order?session=${encodeURIComponent(SCE)}&popup_pay_ref=${E.failed.payment.ref}&popup_pay_result=cancelled`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 20000 }); await sleep(500);
      const t = await pg.evaluate(() => document.getElementById('popupRoot').innerText);
      await ctx.close();
      assert(/付款失敗/.test(t) && /未成立/.test(t) && !isEstablishedText(t) && /改用現金/.test(t), 'E13 [BR] 付款頁（取消付款返回）：付款狀態失敗，同時標示訂單「未成立，付款未完成」，仍提供改用現金', mask(t).slice(0, 600));
    });

    await step('E14', 'R', async () => {
      // [FN] 後台徽章：取出 public/js/app.js 既有的 escHtml／c54PayBadge（及修正版的成立徽章）在 vm 中執行，輸入為後台 API 實際回傳的 payment_display
      const vm = require('vm');
      const src = fs.readFileSync(path.join(H.ROOT, 'public', 'js', 'app.js'), 'utf8');
      const grab = (re) => { const m = re.exec(src); return m ? m[0] : ''; };
      const fnSrc = (name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) return ''; let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } } return ''; };
      const code = [fnSrc('escHtml'), grab(/const _C54_PAY_COLORS = \{[^}]*\};/), fnSrc('c54PayBadge'), fnSrc('c542EstBadge')].join('\n');
      const ctx = vm.createContext({}); vm.runInContext(code + '\nthis.badge = c54PayBadge;', ctx);
      const out = {};
      for (const k of ['failed', 'pending', 'paid', 'cashSwitch', 'review']) { const a = admBy.get(E[k].id); out[k] = String(ctx.badge(a) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
      assert(/訂單：未成立，付款未完成/.test(out.failed) && /訂單：尚未成立，待付款/.test(out.pending) && /訂單：已成立/.test(out.paid) && /訂單：已成立，取貨時付款/.test(out.cashSwitch) && /確認中/.test(out.review) && !/訂單：已成立/.test(out.failed + out.pending + out.review),
        'E14 [FN] 後台付款徽章（訂單列表、詳情、LINE 預購管理共用 c54PayBadge）同時顯示訂單成立狀態，與顧客端文字相同', JSON.stringify(out));
    });

    // ══════════════════════════════════════════════════════════════════
    //  T：時間（同一組操作分別在主機 TZ=UTC 與 TZ=Asia/Taipei 執行，比較結果）
    // ══════════════════════════════════════════════════════════════════
    const runTimeSuite = async (tz) => {
      const R = { tz };
      const at = (iso) => offAt(iso);
      const C = await C45.boot('c542t-' + tz.replace('/', '_'), { products: PRODUCTS, members: 5, settings: {}, seed: seedWith(POPUP_SETTINGS()), env: env(at('2026-11-16T08:07:00Z'), tz) }); boots.push(C);
      const go = async (iso) => { await C.restart(env(at(iso), tz)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
      let SC = null;
      const K = makeKit(C, () => SC, '0933000');
      await go('2026-11-16T08:07:30Z');
      SC = await mkSession(K, 'C542T 場次 ' + tz, '2026-11-20', '2026-11-19T23:00');
      const PA = '0933111222'; const PB = '0933444555';
      const O = {};
      // ── UTC 08:08（台北 16:08）建立 ──
      await go('2026-11-16T08:08:05Z');
      lpCtrl({});
      O.fail = await K.order({ phone: PA }); O.failCall = await K.request(O.fail);
      O.accept = await K.order({ phone: PA, pay: 'cash' });
      O.paid = await K.order({ phone: PA }); O.paidCall = await K.request(O.paid);
      O.cash = await K.order({ phone: PA }); O.cashCall = await K.request(O.cash);
      O.cancel = await K.order({ phone: PA });
      O.kitchen = await K.order({ phone: PA, pay: 'cash' });
      O.expire = await K.order({ phone: PA });
      R.createdDb = {}; for (const k of ['fail', 'accept', 'paid', 'cash', 'cancel', 'kitchen', 'expire']) R.createdDb[k] = (await K.ord(O[k])).created_at;
      R.expAtt = (await K.att(O.expire))[0];
      // ── UTC 08:09（台北 16:09）各更新路徑 ──
      await go('2026-11-16T08:09:05Z');
      await K.cancelCb(O.failCall);                                                           // 付款失敗（顧客取消）
      await K.adm('PATCH', `/api/orders/${O.accept.id}/status`, { order_status: 'accepted' }); // 店家接單
      await K.cb(O.paidCall);                                                                 // 付款成功
      await K.cancelCb(O.cashCall); await K.cash(O.cash);                                     // 改現金
      await K.adm('PATCH', `/api/orders/${O.cancel.id}/status`, { order_status: 'cancelled' }); // 店家取消
      await K.adm('PUT', `/api/kitchen/orders/${O.kitchen.id}/status`, { status: 'preparing' }); // 廚房（既有寫入點使用 ISO 帶 Z）
      O.deadline = await K.order({ phone: PB });                                             // 付款期限顯示用（16:09 建立，期限 16:24）
      R.updatedDb = {}; for (const k of ['fail', 'accept', 'paid', 'cash', 'cancel', 'kitchen']) R.updatedDb[k] = (await K.ord(O[k])).updated_at;
      const lk = await K.lookup({ phone: PA }); const tokA = lk.json.data.token;
      const listA = await K.listAll(tokA); const byNo = new Map(listA.map((x) => [x.order_number, x]));
      R.shown = {};
      for (const k of ['fail', 'accept', 'paid', 'cash', 'cancel', 'kitchen']) {
        const d = (await K.detail(tokA, O[k].order_number)).data;
        R.shown[k] = { listCreated: shownTime(byNo.get(O[k].order_number), 'created'), created: shownTime(d, 'created'), updated: shownTime(d, 'updated') };
      }
      // 瀏覽器（台北／紐約時區）：我的訂單與付款頁期限
      R.browser = {};
      if (browser) {
        for (const btz of ['Asia/Taipei', 'America/New_York']) {
          const b = await browserLookup(C.s.base, SC, btz, PA);
          const card = await cardText(b.pg, O.fail.order_number);
          const det = await openDetailBr(b.pg, O.fail.order_number);
          await b.ctx.close();
          const ctx = await ctxFor(btz);
          await ctx.addInitScript(([r, t]) => { try { sessionStorage.setItem('line_popup_pay_v1_' + r, t); } catch (e) {} }, [O.deadline.payment.ref, O.deadline.payment.token]);
          const pg = await ctx.newPage();
          await pg.goto(`${C.s.base}/popup-order?session=${encodeURIComponent(SC)}&popup_pay_ref=${O.deadline.payment.ref}&popup_pay_result=pending`, { waitUntil: 'domcontentloaded' });
          await pg.waitForSelector('[data-testid=popup-payment-state]', { timeout: 20000 }); await sleep(400);
          const payText = await pg.evaluate(() => document.getElementById('popupRoot').innerText);
          await ctx.close();
          R.browser[btz] = { card: (card || '').match(/建立：[^\n]*/) ? card.match(/建立：[^\n]*/)[0] : card, created: (det.match(/建立時間\s*([^\n]*)/) || [])[1] || '', updated: (det.match(/狀態更新\s*([^\n]*)/) || [])[1] || '',
            deadline: (payText.match(/請於\s*([0-9:]+)\s*前/) || [])[1] || '' };
        }
      }
      // ── 付款安全時間：期限前 15 秒仍可付款；期限後才逾時（不因主機時區偏移 8 小時）──
      R.expiresAt = Number(R.expAtt.expires_at);
      const createdEpoch = Date.parse('2026-11-16T08:08:05Z');
      R.expiresDelta = R.expiresAt - createdEpoch; // 應為 15 分鐘＋建立當下的秒差
      await go(new Date(R.expiresAt - 15000).toISOString());
      const s1 = await K.status(O.expire); R.beforeExpiry = { state: s1.state, can_pay: s1.can_pay };
      await go(new Date(R.expiresAt + 20000).toISOString());
      const s2 = await K.status(O.expire); R.afterExpiry = { state: s2.state, can_pay: s2.can_pay };
      R.expireUpdatedDb = (await K.ord(O.expire)).updated_at;
      { const lk2 = await K.lookup({ phone: PA }); const d = (await K.detail(lk2.json.data.token, O.expire.order_number)).data; R.expireShown = shownTime(d, 'updated'); }
      // ── 跨午夜：UTC 15:50（台北 11/16 23:50）與 UTC 16:05（台北 11/17 00:05）──
      await go('2026-11-16T15:50:05Z');
      O.late = await K.order({ phone: PB, pay: 'cash', name: '跨日測試' });
      await go('2026-11-16T16:05:05Z');
      O.mid = await K.order({ phone: PB, pay: 'cash', name: '跨日測試' });
      R.midDb = (await K.ord(O.mid)).created_at; R.lateDb = (await K.ord(O.late)).created_at;
      const today = await K.lookup({ phone: '555' }); // 後三碼＝台北今日
      R.today = today.json && today.json.data ? today.json.data.orders.map((x) => x.order_number) : [];
      const recent = await K.lookup({ phone: '555', customer_name: '跨日' }); // 後三碼＋姓名＝最近 3 天
      R.recent = recent.json && recent.json.data ? recent.json.data.orders.map((x) => x.order_number) : [];
      R.midShown = today.json && today.json.data && today.json.data.orders[0] ? shownTime(today.json.data.orders.find((x) => x.order_number === O.mid.order_number), 'created') : '';
      R.adminDates = { today: (await K.adminList(['2026-11-17', '2026-11-17'])).filter((x) => x.pickup_type === 'popup').map((x) => x.order_number), prev: (await K.adminList(['2026-11-16', '2026-11-16'])).filter((x) => x.pickup_type === 'popup').map((x) => x.order_number) };
      R.O = Object.fromEntries(Object.entries(O).filter(([, v]) => v && v.order_number).map(([k, v]) => [k, v.order_number]));
      await C.s.stop();
      return R;
    };
    const TU = await runTimeSuite('UTC');
    const TT = await runTimeSuite('Asia/Taipei');
    LOGS.T = { UTC: TU, Taipei: TT };
    const norm = (R) => JSON.stringify({ shown: R.shown, browser: R.browser, today: R.today.length, recent: R.recent.length, mid: R.midShown, exp: R.expireShown, before: R.beforeExpiry, after: R.afterExpiry, deltaOk: Math.abs(R.expiresDelta - 15 * 60000) < 30000 }); // 期限差值的秒數受建立時刻影響，T6 另以容許範圍核對

    await step('T1', 'G', async () => {
      const ok = (R) => Object.values(R.createdDb).every((v) => /^2026-11-16 16:08:/.test(v)) && Object.values(R.shown).every((s) => s.created === '2026-11-16 16:08' && s.listCreated === '2026-11-16 16:08');
      assert(ok(TU) && ok(TT), 'T1 [API][CLK] 建立時間：UTC 2026-11-16T08:08Z 建立 → 資料庫與列表／詳情皆為台北 2026-11-16 16:08（主機 TZ=UTC 與 Asia/Taipei 相同）',
        JSON.stringify({ UTC: [TU.createdDb, TU.shown.fail], TPE: [TT.createdDb.fail, TT.shown.fail] }));
    });
    await step('T2', 'DE', async () => {
      const ok = (R) => ['fail', 'accept', 'paid', 'cash', 'cancel', 'kitchen'].every((k) => R.shown[k].updated === '2026-11-16 16:09');
      assert(ok(TU) && ok(TT), 'T2 [API][CLK] 一分鐘後各更新路徑（付款失敗、店家接單、付款成功、改現金、店家取消、廚房狀態）：狀態更新時間皆顯示台北 16:09（主機 TZ=UTC 也相同，不再出現 08:09）',
        JSON.stringify({ UTC: TU.shown, TPE: TT.shown }));
    });
    await step('T3', 'DE', async () => {
      const ok = (R) => ['fail', 'accept', 'paid', 'cash', 'cancel', 'kitchen'].every((k) => /^2026-11-16 16:09:\d\d$/.test(R.updatedDb[k])) && /^2026-11-16 16:2\d:\d\d$/.test(R.expireUpdatedDb);
      assert(ok(TU) && ok(TT), 'T3 [DB][CLK] 資料契約：快閃訂單 updated_at 一律寫入台北時間「YYYY-MM-DD HH:MM:SS」（與 created_at 同一契約；含逾時收斂），不受主機時區影響',
        JSON.stringify({ UTC: [TU.updatedDb, TU.expireUpdatedDb], TPE: [TT.updatedDb, TT.expireUpdatedDb] }));
    });
    await step('T4', 'G', async () => {
      const ok = (R) => R.midDb.startsWith('2026-11-17 00:05') && R.lateDb.startsWith('2026-11-16 23:50') && R.midShown === '2026-11-17 00:05';
      assert(ok(TU) && ok(TT), 'T4 [API][CLK] 跨午夜：UTC 2026-11-16T16:05Z 建立 → 顯示台北 2026-11-17 00:05（日期一起轉換）；UTC 15:50Z → 台北 11/16 23:50', JSON.stringify({ UTC: [TU.midDb, TU.lateDb, TU.midShown], TPE: [TT.midDb, TT.lateDb, TT.midShown] }));
    });
    await step('T5', 'G', async () => {
      const ok = (R) => R.today.length === 1 && R.today[0] === R.O.mid && R.recent.length === 2 && R.recent.includes(R.O.late)
        && R.adminDates.today.includes(R.O.mid) && !R.adminDates.today.includes(R.O.late) && R.adminDates.prev.includes(R.O.late);
      assert(ok(TU) && ok(TT), 'T5 [API][CLK] 日期篩選：台北 11/17 00:05 查「今日」只含 00:05 那筆、不含前一天 23:50；「最近 3 天」兩筆都含；後台日期篩選依台北日曆日', JSON.stringify({ UTC: [TU.today, TU.recent, TU.adminDates], TPE: [TT.today, TT.recent, TT.adminDates] }));
    });
    await step('T6', 'G', async () => {
      const ok = (R) => Math.abs(R.expiresDelta - 15 * 60000) < 30000 && R.beforeExpiry.state === 'pending_payment' && R.beforeExpiry.can_pay === true && R.afterExpiry.state !== 'pending_payment' && R.afterExpiry.can_pay === false;
      assert(ok(TU) && ok(TT), 'T6 [API][CLK] 付款安全時間未改變：付款期限＝建立時刻＋15 分鐘（epoch 毫秒）；期限前 15 秒仍可付款、期限後 20 秒才逾時（兩種主機時區相同）',
        JSON.stringify({ UTC: [TU.expiresDelta, TU.beforeExpiry, TU.afterExpiry], TPE: [TT.expiresDelta, TT.beforeExpiry, TT.afterExpiry] }));
    });
    await step('T7', 'DE', async () => {
      if (!browser) throw new Error('需要 playwright');
      const ok = (R) => { const a = R.browser['Asia/Taipei'], b = R.browser['America/New_York']; return a && b && /16:08/.test(a.card) && a.created === '2026-11-16 16:08' && /^2026-11-16 16:09/.test(a.updated) && a.deadline === '16:24' && JSON.stringify(a) === JSON.stringify(b); };
      assert(ok(TU) && ok(TT), 'T7 [BR][CLK] 瀏覽器時區：台北與紐約時區的 Chrome 顯示同一筆資料皆為建立 16:08、更新 16:09；付款期限「請於 16:24 前」（不依裝置時區）', JSON.stringify({ UTC: TU.browser, TPE: TT.browser }));
    });
    await step('T8', 'G', async () => {
      assert(norm(TU) === norm(TT), 'T8 [API][BR] 主機時區一致：TZ=UTC 與 TZ=Asia/Taipei 的所有顯示結果逐項相同', JSON.stringify({ UTC: norm(TU), TPE: norm(TT) }).slice(0, 1600));
    });

    await step('T10', 'G', async () => {
      // [FN] 後台時間顯示：public/js/app.js 既有 twTime（無時區字串＝台北、帶 Z／offset 依其時區）在不同主機／瀏覽器時區下輸出相同
      const { execFileSync } = require('child_process');
      const src = fs.readFileSync(path.join(H.ROOT, 'public', 'js', 'app.js'), 'utf8');
      const i = src.indexOf('function twTime('); let d = 0, j = src.indexOf('{', i), end = -1;
      for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } } }
      const fn = src.slice(i, end);
      const run = (tz) => execFileSync(process.execPath, ['-e', fn + '\nprocess.stdout.write(JSON.stringify([twTime(process.argv[1],"datetime"),twTime(process.argv[2],"time"),twTime(process.argv[3],"datetime")]))', TU.createdDb.fail, TU.createdDb.accept, '2026-11-16T16:05:00Z'], { env: { ...process.env, TZ: tz } }).toString();
      const a = run('Asia/Taipei'), b = run('America/New_York'), c = run('UTC');
      assert(a === b && b === c && /16:08/.test(JSON.parse(a)[0]) && /16:08/.test(JSON.parse(a)[1]) && /2026\/11\/17\s00:05/.test(JSON.parse(a)[2]),
        'T10 [FN] 後台時間（twTime；後台只顯示建立時間）：快閃訂單建立 16:08（日期時間與時間兩種格式）、帶 Z 的跨日時間 11/17 00:05；台北／紐約／UTC 時區輸出相同', JSON.stringify({ a, b, c }));
    });

    // ── 歷史資料（[FX]：以舊版寫入方式直接寫入；不由修正版程式產生）──
    await step('T9', 'R', async () => {
      const C = await C45.boot('c542h', { products: PRODUCTS, members: 5, settings: {}, seed: seedWith(POPUP_SETTINGS()), env: env(offAt('2026-11-16T08:07:00Z'), 'UTC') }); boots.push(C);
      await C.restart(env(offAt('2026-11-16T08:07:20Z'), 'UTC')); C.tok = await H.login(C.s.base, STORE, 'pw001');
      let SC = null; const K = makeKit(C, () => SC, '0944000');
      SC = await mkSession(K, 'C542H 場次', '2026-11-20', '2026-11-19T23:00');
      await C.restart(env(offAt('2026-11-16T08:08:02Z'), 'UTC'));
      const PH = '0944111222';
      const h = {};
      for (const k of ['same', 'iso', 'unknown', 'paidUtc', 'paidTpe']) h[k] = await K.order({ phone: PH, pay: k.startsWith('paid') ? 'linepay' : 'cash' });
      for (const k of ['paidUtc', 'paidTpe']) { const c = await K.request(h[k]); await K.cb(c); }
      await C.s.stop();
      const db = await H.openDbFile(C.dbf);
      const cols = db.exec('PRAGMA table_info(orders)')[0].values.map((r) => r[1]);
      const legacyCols = cols.filter((c) => /^popup_(created|updated)_tz$/.test(c));
      const clr = legacyCols.length ? ', ' + legacyCols.map((c) => `${c}=NULL`).join(', ') : '';
      // 以舊版方式寫入（[FX]）：舊版沒有台北更新時間的觸發器與來源標記 → 先移除修正版的觸發器（重新啟動時由遷移重建）再寫入
      H.q(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='orders' AND sql LIKE '%popup%' AND sql LIKE '%updated_at%'").forEach((t) => db.run(`DROP TRIGGER IF EXISTS "${t.name}"`));
      const cr = (o) => H.q(db, 'SELECT created_at FROM orders WHERE id=?', [o.id])[0].created_at; // 修正版與基準都由結帳寫入台北建立時間（R53 契約）
      // 未曾更新：updated_at＝created_at
      db.run(`UPDATE orders SET updated_at=created_at${clr} WHERE id=?`, [h.same.id]);
      // 舊版廚房寫入點：ISO 帶 Z
      db.run(`UPDATE orders SET updated_at='2026-11-16T08:09:00.000Z'${clr} WHERE id=?`, [h.iso.id]);
      // 舊版 SQLite localtime（主機時區不明）：數值上早於建立時間，但沒有其他可信證據
      db.run(`UPDATE orders SET updated_at='2026-11-16 08:09:00'${clr} WHERE id=?`, [h.unknown.id]);
      // 已付款：同一交易內寫入的 confirmed_at（UTC，datetime('now')）與付款紀錄／訂單的 updated_at（localtime）
      db.run(`UPDATE orders SET updated_at='2026-11-16 08:09:00'${clr} WHERE id=?`, [h.paidUtc.id]);
      db.run("UPDATE popup_payment_attempts SET confirmed_at='2026-11-16 08:09:00', updated_at='2026-11-16 08:09:00' WHERE order_id=?", [h.paidUtc.id]);
      db.run(`UPDATE orders SET updated_at='2026-11-16 16:09:00'${clr} WHERE id=?`, [h.paidTpe.id]);
      db.run("UPDATE popup_payment_attempts SET confirmed_at='2026-11-16 08:09:00', updated_at='2026-11-16 16:09:00' WHERE order_id=?", [h.paidTpe.id]);
      LOGS.T9_created = { same: cr(h.same), unknown: cr(h.unknown) };
      H.saveDbFile(db, C.dbf);
      const rawBefore = H.q(db, 'SELECT id, created_at, updated_at FROM orders WHERE id IN (?,?,?,?,?) ORDER BY id', [h.same.id, h.iso.id, h.unknown.id, h.paidUtc.id, h.paidTpe.id]);
      db.close();
      await C.restart(env(offAt('2026-11-16T09:30:00Z'), 'UTC')); await C.s.stop(); // 重複啟動（遷移可重複執行）
      await C.restart(env(offAt('2026-11-16T09:30:00Z'), 'UTC')); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const lk = await K.lookup({ phone: PH }); const tok = lk.json.data.token;
      const shown = {}; for (const k of Object.keys(h)) { const d = (await K.detail(tok, h[k].order_number)).data; shown[k] = { created: shownTime(d, 'created'), updated: shownTime(d, 'updated') }; }
      await sleep(300);
      const db2 = await H.openDbFile(C.dbf);
      const rawAfter = H.q(db2, 'SELECT id, created_at, updated_at FROM orders WHERE id IN (?,?,?,?,?) ORDER BY id', [h.same.id, h.iso.id, h.unknown.id, h.paidUtc.id, h.paidTpe.id]);
      db2.close();
      await C.s.stop();
      LOGS.T9 = { shown, rawBefore, rawAfter };
      assert(/^2026-11-16 16:08$/.test(shown.same.updated) && shown.same.created === shown.same.updated && shown.iso.updated === '2026-11-16 16:09' && shown.paidUtc.updated === '2026-11-16 16:09' && shown.paidTpe.updated === '2026-11-16 16:09'
        && /2026-11-16 08:09/.test(shown.unknown.updated) && /時區未確認/.test(shown.unknown.updated) && !/16:09/.test(shown.unknown.updated)
        && JSON.stringify(rawBefore) === JSON.stringify(rawAfter),
        'T9 [API][FX] 歷史時間：與建立時間相同者沿用台北；帶 Z 者依 UTC 解析一次（16:09）；已付款且同一交易有 UTC 確認時間者可確認來源（UTC→16:09；台北→16:09）；來源不明者保留原值並標示「時區未確認」（不因早於建立時間就加 8 小時）；啟動兩次不改寫任何舊時間',
        JSON.stringify(LOGS.T9));
    });

    // ═══════════════════════ Z：外部呼叫 ═══════════════════════
    await step('Z', 'G', async () => {
      const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
      const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
      const sigBad = lpCalls().filter((c) => c.sig_ok === false).length;
      const lineReal = boots.reduce((n, b) => n + b.mf.real(), 0);
      assert(real === 0 && unexpected === 0 && sigBad === 0 && lineReal === 0, 'Z 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；替身核對簽章全部正確',
        JSON.stringify({ real, unexpected, sigBad, lineReal, lpCalls: lpCalls().length }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c5-4-2-popup-establishment-taipei-time', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*R?/) || [''])[0]] || {}).cls || null, detail: mask(r.detail) })), logs: JSON.parse(mask(JSON.stringify(LOGS))) };
  if (process.env.C542_RESULT_JSON) fs.writeFileSync(process.env.C542_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
