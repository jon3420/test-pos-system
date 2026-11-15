#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js
// R54.4／MBV2-HF1-C5.1 —— 七項問題（R1～R7）的重現與驗收（同一組核心案例先在未修改的 C5 執行，再在 C5.1 執行）
//
// 測試層級（每個案例在名稱前標示）：
//   [API]  正式路由＋暫存 SQLite（伺服器以 node server.js 啟動）
//   [BR]   真實 Chrome（Playwright）開啟正式頁面，對同一個暫存伺服器操作；LIFF SDK 以替身回應
//   [DB]   直接核對暫存資料庫檔案
// 外部網路：LINE Messaging API 由 c4-line-mock 在伺服器程序內攔截；LINE Pay 由 c51-linepay-mock（有狀態替身）攔截；
//   真實呼叫次數在 Z 案例核對（必須為 0）。這些都不是真機、正式金流或正式站驗證。
// 故障注入只在測試邊界：SQLite trigger（寫在暫存資料庫）、durable 寫入故障 preload、Playwright 扣住回應。
// 回應亂序測試：先讓伺服器完成操作（route.fetch），再扣住回應，完成後續操作後才放行。
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
const LP_DIR = H.tmpDir('c51-linepay');
const LP = { ctrl: path.join(LP_DIR, 'ctrl.json'), state: path.join(LP_DIR, 'state.json'), log: path.join(LP_DIR, 'calls.jsonl'), real: path.join(LP_DIR, 'real.txt') };
fs.writeFileSync(LP.ctrl, '{}'); fs.writeFileSync(LP.state, JSON.stringify({ tx: {} })); fs.writeFileSync(LP.log, ''); fs.writeFileSync(LP.real, '');
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
// C5.3 調整用：在替身中預先寫入「升級前已在金流端完成付款」的交易（測試前提，非受測程式）
const setMockTx = (tx, patch) => { const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[tx] = { ...(st.tx[tx] || {}), ...patch }; fs.writeFileSync(LP.state, JSON.stringify(st)); };
const confirmsForTx = (tx) => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const DUR_CTRL = path.join(LP_DIR, 'durable.json'); fs.writeFileSync(DUR_CTRL, '{}');
const ONLY = (process.env.C51_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const SESSION_TTL = 30 * 86400e3;
function sessAt(u, offsetMs, store = STORE) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${store}',line_user_id:'${u}',ttl_ms:${SESSION_TTL}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}
const P_A = 701, P_B = 704, P_C = 705, P_D = 706, P_E = 707;
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [702, '測試對照湯', 1, 'available', { quota: 50 }], [703, '測試隱藏品', 2, 'available', { show_on_line: 0 }],
  [704, '測試補貨麵', 3, 'available', { quota: 50, price: 120 }], [705, '測試補貨飯糰', 4, 'available', { quota: 50, price: 80 }],
  [706, '測試補貨便當', 5, 'available', { quota: 50, price: 100 }], [707, '測試補貨甜點', 6, 'available', { quota: 50, price: 60 }]];
const linepaySeed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c51','test-secret-c51')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT INTO coupons (store_id,code,name,discount_type,discount_value,min_amount,enabled) VALUES ('store_001','C51OFF','測試折扣','fixed',10,0,1)");
  const r = db.exec("SELECT features FROM licenses WHERE store_id IN ('store_001','store_002')");
  for (const sid of ['store_001', 'store_002']) {
    const rr = db.exec(`SELECT features FROM licenses WHERE store_id='${sid}'`);
    if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); f.coupon = true; f.reports = true; f.line_order = true; db.run('UPDATE licenses SET features=? WHERE store_id=?', [JSON.stringify(f), sid]); }
  }
  void r;
};
// 每個案例獨立：例外 → 該案例 FAIL，繼續後續案例（基準版缺少新 API 時也能完整跑完）
const STEP_RE = process.env.C51_STEP ? new RegExp(process.env.C51_STEP) : null;
async function step(name, fn) { if (STEP_RE && !STEP_RE.test(name)) return; try { await fn(); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.1 一致性與訂單識別 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  const stopAll = async () => { for (const b of boots) { try { if (b.s.proc.exitCode == null && b.s.proc.signalCode == null) await b.s.stop(); } catch {} } };
  let browser = null;
  try {
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off, extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c51-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C51_DURABLE_CTRL: DUR_CTRL, ...extra });
    const C = await C45.boot('c51', { products: PRODUCTS, members: 80, settings: { restock_notify_enabled: '1', coupon_feature_enabled: '1' }, seed: linepaySeed, env: env(OFF) }); boots.push(C);
    let curOff = OFF;
    const restart = async (off) => { curOff = off; await C.restart(env(off)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    await restart(OFF);
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b, store) => C45.pub(C.s.base, m, p, b, store);
    const S = (u) => sessAt(u, curOff);
    const nowTw = () => new Date(RealDate.now() + Number(curOff) + 8 * 3600e3);
    const today = () => nowTw().toISOString().slice(0, 10);
    const tomorrow = () => new Date(nowTw().getTime() + 86400e3).toISOString().slice(0, 10);
    const dbq = async (sql, params) => { const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const q = async (sql, params) => { await sleep(150); return dbq(sql, params); };
    // 只有 C5.1 才有的資料表：基準版查詢時回傳空結果（讓案例以斷言失敗呈現，而不是例外）
    const qOpt = async (sql, params) => { try { return await q(sql, params); } catch (e) { if (/no such (table|column)/.test(e.message)) return []; throw e; } };
    // 停機修改暫存資料庫（測試邊界），再以同一時鐘重新啟動
    const editDb = async (fn, off) => {
      await C.s.stop();
      try { const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } }
      finally { await restart(off === undefined ? curOff : off); }
    };
    // 基準版（C5）沒有 C5.1 新欄位：只在欄位存在時執行（讓同一組案例可在兩個版本執行）
    const hasCol = (db, t, c) => { try { return db.exec(`PRAGMA table_info(${t})`)[0].values.some((r) => r[1] === c); } catch { return false; } };
    const register = (u, pid, qty = 1, pref = 'any', extra = {}) => pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: pref, ...extra });
    const regNotify = async (u, pid) => { const r = await register(u, pid, 1, 'any', { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' }); if (!r.json || !r.json.success) throw new Error('register ' + r.text); return r; };
    const mine = async (u, pid) => { const r = await pub('POST', '/api/product-demand/mine', { member_session: S(u), product_id: pid }); return ((r.json && r.json.data) || []).find((x) => Number(x.product_id) === pid) || null; };
    async function sendBatch(pid, mode, date) {
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: pid, fulfillment_mode: mode, supply_date: date });
      if (!pv.json.success || !pv.json.data.can_send) throw new Error('preview ' + pv.text.slice(0, 300));
      const cf = await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {});
      if (!cf.json.success) throw new Error('confirm ' + cf.text);
      for (let i = 0; i < 80; i++) { const d = await adm('GET', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}`); if (['completed', 'paused'].includes(d.json.data.status)) return { pv: pv.json.data, detail: d.json.data }; await sleep(150); }
      throw new Error('batch did not finish');
    }
    const rtOf = (link) => new URL(link).searchParams.get('rt');
    const open = (rt, pid, key, u, extra = {}) => pub('POST', '/api/product-demand/track/open', { rt, product_id: pid, open_key: key, visitor_id: 'v_' + key, session_id: 's_' + key, ...(u ? { member_session: S(u) } : {}), ...extra });
    const addCart = (rt, pid, key, ek, sess) => pub('POST', '/api/analytics/events', { visitor_id: 'v_' + key, session_id: 's_' + key, event_name: 'add_to_cart', product_id: pid, quantity: 1,
      metadata: { restock: { rt, open_key: key, event_key: ek } }, ...(sess ? { member_session: sess } : {}) });
    async function order(u, items, o = {}) {
      const body = { customer_name: o.name || '測試顧客', customer_phone: o.phone || '0912345678', order_type: o.mode || 'takeout', pickup_date: tomorrow(), pickup_time: '12:00',
        payment_method: o.pay || 'cash', items: items.map(([pid, qty]) => ({ product_id: pid, qty })), analytics: { visitor_id: 'v_order', session_id: 's_order' } };
      if (u) body.member_session = o.session || S(u);
      if (o.coupon) body.coupon_code = o.coupon;
      const r = await pub('POST', '/api/line-orders', body);
      if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 300));
      return r.json.data;
    }
    const summary = async (qs = '') => (await adm('GET', '/api/analytics/restock-notify/summary' + (qs ? '?' + qs : ''))).json.data;
    const K = (s) => ('k' + s + 'xxxxxxxx').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    if (chromium) browser = await chromium.launch(C45.launchOpts());
    const fakeLiff = (pg) => pg.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
    const memberCtx = async (u, opts = {}) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
      const sess = u ? JSON.stringify({ member_session: S(u), display_name: '會員', is_friend: true, expires_at: RealDate.now() + 3600e3 }) : null;
      await ctx.addInitScript(([k, v, mode]) => { if (!sessionStorage.getItem('__s')) { if (v) localStorage.setItem(k, v); sessionStorage.setItem('__s', '1'); } window.__C45_LIFF = { mode: mode || 'resolve_then_redirect' }; }, ['line_member_session_store_001', sess, opts.liffMode || '']);
      return ctx;
    };
    const setMember = (pg, u) => pg.evaluate(([k, v]) => { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); return null; }, ['line_member_session_store_001', u ? JSON.stringify({ member_session: S(u), display_name: '會員', is_friend: true, expires_at: RealDate.now() + 3600e3 }) : null]);

    // ════════════════════════════════════════════════════════════════════════════════
    //  R1 只訂閱通知不能覆蓋登記內容
    // ════════════════════════════════════════════════════════════════════════════════
    if (want('R1')) {
      await adm('PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });
      const cfg = (await pub('GET', '/api/product-demand/config')).json;
      const ver = cfg && cfg.data && cfg.data.consent_text_version || 'restock-notify-c45-register-v1';
      const consentRows = async (u, pid) => (await q("SELECT COUNT(*) AS c FROM product_demand_consents WHERE line_user_id=? AND product_id=? AND status='granted'", [u, pid]))[0].c;
      const req = async (u, pid) => (await q('SELECT id, desired_qty, fulfillment_pref, status, expires_at, request_uuid FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id DESC LIMIT 1', [u, pid]))[0];
      const sub = (u, pid, rid, extra = {}) => pub('POST', '/api/product-demand/subscribe', { member_session: S(u), product_id: pid, request_id: rid, consent_mode: 'register_subscribe', consent_text_version: ver, ...extra });
      // 既有登記（未訂閱）：1 份、外帶自取
      const setup = async (u, pid) => {
        await register(u, pid, 1, 'takeout', { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'register_subscribe', consent_text_version: ver });
        await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(u), product_id: pid });
      };
      await step('R1-1', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const u = U(41); await setup(u, P_A);
        const ctx = await memberCtx(u); const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); await fakeLiff(pg);
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
        await pg.waitForFunction(() => typeof _pdMine === 'function' && !!_pdMine(701), null, { timeout: 15000 });
        await pg.evaluate(() => { openDemandSheet(701, 'card'); return null; });
        await pg.waitForSelector('#dmSubscribe', { timeout: 8000 });
        // B 裝置：同一登記改成 5 份、外送
        const rB = await register(u, P_A, 5, 'delivery');
        await pg.click('#dmSubscribe');
        await sleep(2500);
        const db = await req(u, P_A);
        const ui = await pg.evaluate(() => { const m = _pdMine(701); return m ? { qty: m.desired_qty, pref: m.fulfillment_pref, consent: m.notify_consent } : null; });
        await pg.evaluate(() => { openMyDemandsSheet(); return null; }); await sleep(1200);
        const listText = await pg.evaluate(() => (document.getElementById('dmList') || {}).textContent || '');
        assert(rB.json && rB.json.data.outcome === 'updated' && db.desired_qty === 5 && db.fulfillment_pref === 'delivery' && (await consentRows(u, P_A)) === 1
          && ui && ui.qty === 5 && ui.pref === 'delivery' && ui.consent === 'granted' && /5 份・外送/.test(listText) && errs.length === 0,
        'R1-1 [BR] A 裝置載入「1 份、外帶」→ B 裝置改「5 份、外送」→ A 按「訂閱補貨通知」：資料庫維持 5 份外送、只新增同意；畫面顯示 5 份外送',
        JSON.stringify({ db: [db.desired_qty, db.fulfillment_pref], ui, list: listText.slice(0, 60), errs }));
        // R1-8 回應途中換會員：伺服器先完成，再扣住回應；換成另一位會員後才放行
        const u2 = U(42); await setup(u2, P_A); await setup(u, P_B);
        await pg.evaluate(() => { closeDemandSheet(); return null; });
        await pg.evaluate(async () => { await _pdReloadMine(); return null; });
        await pg.evaluate(() => { openDemandSheet(704, 'card'); return null; });
        await pg.waitForSelector('#dmSubscribe', { timeout: 8000 });
        let held = null; let resp = null;
        await pg.route('**/api/product-demand/subscribe**', async (route) => { resp = await route.fetch(); held = route; });
        await pg.route('**/api/product-demand/register**', async (route) => { resp = await route.fetch(); held = route; });
        await pg.evaluate(() => { window.__toasts = []; const ot = window.toast; window.toast = function (m) { window.__toasts.push(String(m)); return ot.apply(this, arguments); }; return null; });
        await pg.click('#dmSubscribe');
        for (let i = 0; i < 50 && !held; i++) await sleep(100);
        await setMember(pg, u2);
        await pg.evaluate(async () => { try { await _pdReloadMine(); } catch (e) {} return null; }); await sleep(600);
        if (held) await held.fulfill({ response: resp });
        await sleep(1500);
        const after = await pg.evaluate(() => ({ open: !!document.getElementById('demandOverlay')?.classList.contains('show'), sheetPid: _demandSheetState && _demandSheetState.productId,
          mine704: _pdMine(704) ? _pdMine(704).desired_qty : null, toast: (window.__toasts || []).join('|') }));
        const r704 = await req(u, P_B);
        assert(!after.open && after.mine704 === null && !/已訂閱補貨通知/.test(after.toast) && r704.desired_qty === 1 && (await consentRows(u, P_B)) === 1,
          'R1-8 [BR] 訂閱回應途中換會員：舊會員回應不寫入新會員畫面、不提示成功；伺服器只新增舊會員同意、登記不變', JSON.stringify({ after, db: r704.desired_qty }));
        await pg.unroute('**/api/product-demand/subscribe**'); await pg.unroute('**/api/product-demand/register**');
        // R1-9 回應途中關閉表單、開啟其他商品表單
        await setMember(pg, u2); await pg.evaluate(async () => { await _pdReloadMine(); return null; });
        await setup(u2, P_C);
        await pg.evaluate(async () => { await _pdReloadMine(); openDemandSheet(705, 'card'); return null; });
        await pg.waitForSelector('#dmSubscribe', { timeout: 8000 });
        held = null;
        await pg.route('**/api/product-demand/subscribe**', async (route) => { resp = await route.fetch(); held = route; });
        await pg.route('**/api/product-demand/register**', async (route) => { resp = await route.fetch(); held = route; });
        await pg.click('#dmSubscribe');
        for (let i = 0; i < 50 && !held; i++) await sleep(100);
        await pg.evaluate(() => { closeDemandSheet(); openDemandSheet(701, 'card'); return null; }); await sleep(400);
        if (held) await held.fulfill({ response: resp });
        await sleep(1500);
        const a2 = await pg.evaluate(() => ({ open: !!document.getElementById('demandOverlay')?.classList.contains('show'), pid: _demandSheetState && String(_demandSheetState.productId), msg: (document.getElementById('dmMsg') || {}).textContent || '', c705: _pdMine(705) && _pdMine(705).notify_consent }));
        const r705 = await req(u2, P_C);
        assert(a2.open && a2.pid === '701' && !a2.msg && r705.desired_qty === 1 && r705.fulfillment_pref === 'takeout',
          'R1-9 [BR] 回應途中關閉再開其他商品表單：不關閉、不改寫新表單；登記內容不變', JSON.stringify({ a2, db: [r705.desired_qty, r705.fulfillment_pref] }));
        await ctx.close();
      });
      await step('R1-2', async () => {
        const u = U(43); await setup(u, P_A);
        const r0 = await req(u, P_A);
        await pub('POST', '/api/product-demand/cancel', { member_session: S(u), product_id: P_A });
        const c0 = await consentRows(u, P_A);
        const r = await sub(u, P_A, r0.id);
        const leg = await register(u, P_A, 1, 'takeout', { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'subscribe', consent_text_version: ver });
        const act = await q("SELECT COUNT(*) AS c FROM product_demand_requests WHERE line_user_id=? AND product_id=? AND status='active'", [u, P_A]);
        assert(r.status === 409 && r.json.code === 'REQUEST_CHANGED' && leg.status === 409 && act[0].c === 0 && (await consentRows(u, P_A)) === c0,
          'R1-2 [API] 登記已取消：新版與舊版訂閱都被拒絕，不復活登記、不新增同意', JSON.stringify({ st: r.status, code: r.json && r.json.code, leg: leg.status, act: act[0].c }));
      });
      await step('R1-3', async () => {
        const u = U(44); await setup(u, P_A);
        const old = await req(u, P_A);
        await pub('POST', '/api/product-demand/cancel', { member_session: S(u), product_id: P_A });
        await register(u, P_A, 2, 'delivery'); // 新週期（未訂閱）
        const nw = await req(u, P_A);
        const r = await sub(u, P_A, old.id);
        const nw2 = await req(u, P_A);
        const g = await q("SELECT COUNT(*) AS c FROM product_demand_consents WHERE request_uuid=? AND status='granted'", [nw.request_uuid]);
        assert(r.status === 409 && nw.id !== old.id && g[0].c === 0 && nw2.desired_qty === 2 && nw2.fulfillment_pref === 'delivery',
          'R1-3 [API] 取消後重建（新週期）：舊表單的訂閱不能授權新週期、不改新週期內容', JSON.stringify({ st: r.status, g: g[0].c }));
      });
      await step('R1-4', async () => {
        const u = U(45); await setup(u, P_A);
        const r0 = await req(u, P_A);
        await editDb((db) => { db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 day') WHERE id=?", [r0.id]); });
        const r = await sub(u, P_A, r0.id);
        const r1 = await req(u, P_A);
        assert(r.status === 409 && r1.status === 'active' && r1.desired_qty === 1 && (await consentRows(u, P_A)) === 0,
          'R1-4 [API] 登記已過期：訂閱被拒絕，不延長有效期限、不新增同意', JSON.stringify({ st: r.status, exp: r1.expires_at === r0.expires_at }));
      });
      await step('R1-5', async () => {
        const u = U(46); await setup(u, P_A); await register(u, P_A, 3, 'delivery');
        const r0 = await req(u, P_A);
        const a = await sub(u, P_A, r0.id); // 撤回後重新訂閱
        const b = await sub(u, P_A, r0.id); // 重複提交
        const c = await sub(u, P_A, r0.id);
        const r1 = await req(u, P_A);
        const rows = await q('SELECT COUNT(*) AS c FROM product_demand_consents WHERE request_uuid=?', [r0.request_uuid]);
        assert(a.json && a.json.data.consent_outcome === 'granted' && b.json.data.consent_outcome === 'unchanged' && c.json.data.consent_outcome === 'unchanged'
          && r1.desired_qty === 3 && r1.fulfillment_pref === 'delivery' && r1.expires_at === r0.expires_at && (await consentRows(u, P_A)) === 1 && rows[0].c === 2,
        'R1-5 [API] 撤回後重新訂閱成功；重複提交不產生重複同意；份數、偏好、期限不變', JSON.stringify({ out: [a.json && a.json.data.consent_outcome, b.json && b.json.data.consent_outcome], rows: rows[0].c }));
      });
      await step('R1-6', async () => {
        const u = U(47); await setup(u, P_A); await register(u, P_A, 5, 'delivery');
        // 舊版前端：consent_action='subscribe' 帶著快取的 1 份外帶
        const stale = await register(u, P_A, 1, 'takeout', { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'subscribe', consent_text_version: ver });
        const r1 = await req(u, P_A);
        // C5.2 調整：舊版前端即使份數、偏好與伺服器一致，也沒有可驗證的登記週期識別 → 一律 409（A 類要求，不再接受「一致即授權」）；
        // 授權改由 /subscribe 帶目前登記週期識別。
        const same = await register(u, P_A, 5, 'delivery', { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'subscribe', consent_text_version: ver });
        const ok = await C45.pub(C.s.base, 'POST', '/api/product-demand/subscribe', { member_session: S(u), product_id: P_A, request_uuid: r1.request_uuid, consent_mode: 'register_subscribe', consent_text_version: ver });
        const r2 = await req(u, P_A);
        assert(stale.status === 409 && same.status === 409 && r1.desired_qty === 5 && r1.fulfillment_pref === 'delivery' && ok.json && ok.json.data.consent_outcome === 'granted' && r2.desired_qty === 5 && r2.fulfillment_pref === 'delivery',
          'R1-6 [API] 舊版前端 consent_action=subscribe：不論表單快取是否一致都 409 不寫入；帶登記週期識別的訂閱只授權、不改份數', JSON.stringify({ stale: stale.status, same: same.status, db: [r1.desired_qty, r1.fulfillment_pref], ok: ok.json && ok.json.data.consent_outcome }));
      });
      await step('R1-7', async () => {
        const u = U(48); await setup(u, P_A);
        const r0 = await req(u, P_A);
        const r = await sub(u, P_A, r0.id, { consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
        const other = await pub('POST', '/api/product-demand/subscribe', { member_session: S(U(49)), product_id: P_A, request_id: r0.id, consent_mode: 'register_subscribe', consent_text_version: ver });
        assert(r.status === 409 && r.json.code === 'CONSENT_MODE_CHANGED' && other.status === 409 && (await consentRows(u, P_A)) === 0,
          'R1-7 [API] 保留訂閱方式與文案版本檢查；他人不能以 request_id 訂閱別人的登記', JSON.stringify({ st: r.status, code: r.json && r.json.code, other: other.status }));
      });
      await adm('PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'opt_in' });
    }

    // ════════════════════════════════════════════════════════════════════════════════
    //  R2 加購歸因不能沿用前位會員　／　R3 真正再次點擊須更新最後有效點擊
    // ════════════════════════════════════════════════════════════════════════════════
    let BT = null;
    if (want('R2') || want('R3')) {
      for (let i = 51; i <= 58; i++) await regNotify(U(i), P_D);
      BT = await sendBatch(P_D, 'takeout', today());
    }
    if (want('R2')) {
      const rt = rtOf(BT.pv.link_url);
      const A = U(51), B = U(52);
      const key = K('r2a');
      await open(rt, P_D, key, A);
      const addRow = async (ek) => (await q('SELECT line_user_id, recipient FROM restock_notify_cart_adds WHERE event_key=?', [ek]))[0] || null;
      await step('R2-1', async () => {
        await addCart(rt, P_D, key, K('r2e1'), S(A));
        const r = await addRow(K('r2e1'));
        assert(r && r.line_user_id === A && r.recipient === 1, 'R2-1 [API] 有效會員 A 加購：歸因 A', JSON.stringify(r));
      });
      await step('R2-2', async () => {
        await addCart(rt, P_D, key, K('r2e2'), null);
        const r = await addRow(K('r2e2'));
        assert(r && r.line_user_id === '' && r.recipient === null, 'R2-2 [API] 沒有有效會員（匿名）：只保留匿名事件，不沿用點擊者 A', JSON.stringify(r));
      });
      await step('R2-3', async () => {
        const expired = sessAt(A, String(Number(curOff) - 40 * 86400e3));
        const forged = S(A).slice(0, -6) + 'AAAAAA';
        await addCart(rt, P_D, key, K('r2e3'), expired); await addCart(rt, P_D, key, K('r2e4'), forged);
        const r3 = await addRow(K('r2e3')), r4 = await addRow(K('r2e4'));
        assert(r3 && r4 && r3.line_user_id === '' && r4.line_user_id === '', 'R2-3 [API] 過期／偽造 session：視為匿名，不沿用點擊者', JSON.stringify({ r3, r4 }));
      });
      await step('R2-4', async () => {
        await addCart(rt, P_D, key, K('r2e5'), S(B));
        const r = await addRow(K('r2e5'));
        const click = (await q('SELECT line_user_id FROM restock_notify_clicks WHERE open_key=?', [key]))[0];
        const s = (await summary(`batch_uuid=${BT.pv.batch_uuid}`)).batches[0];
        assert(r && r.line_user_id === B && r.recipient === 0 && click.line_user_id === A && s.add_people === 1,
          'R2-4 [API] 本次會員 B 與點擊綁定的 A 不同：以 B 記錄但不計入漏斗、不改綁點擊、不合併', JSON.stringify({ r, click, add_people: s.add_people }));
      });
      await step('R2-5', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const A2 = U(53), B2 = U(54);
        const inner = `?store_id=${STORE}&product_ref=${puuid(P_D)}&src=restock&m=takeout&d=${today()}&rt=${rt}`;
        const ctx = await memberCtx(A2); const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); await fakeLiff(pg);
        await pg.goto(`${C.s.base}/line-order.html${inner}`, { waitUntil: 'domcontentloaded' }); await sleep(4000);
        const ck = await q('SELECT open_key, line_user_id FROM restock_notify_clicks WHERE batch_uuid=? AND line_user_id=?', [BT.pv.batch_uuid, A2]);
        // A 切 B：加購不得帶 A 的追蹤狀態
        await setMember(pg, B2);
        await pg.evaluate(() => { addCart(706); return null; }); await sleep(1500);
        const addsB = await q('SELECT line_user_id FROM restock_notify_cart_adds WHERE batch_uuid=? AND click_uuid IN (SELECT click_uuid FROM restock_notify_clicks WHERE line_user_id=?)', [BT.pv.batch_uuid, A2]);
        // A 登出
        await setMember(pg, null);
        await pg.evaluate(() => { addCart(706); return null; }); await sleep(1500);
        const addsAll = await q('SELECT line_user_id FROM restock_notify_cart_adds WHERE batch_uuid=? AND click_uuid IN (SELECT click_uuid FROM restock_notify_clicks WHERE line_user_id=?)', [BT.pv.batch_uuid, A2]);
        const cart = await pg.evaluate(() => Object.values(cart).reduce((s, x) => s + x.qty, 0));
        const histA = await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE line_user_id=?', [A2]);
        assert(ck.length === 1 && addsB.length === 0 && addsAll.length === 0 && cart === 2 && histA[0].c === 1 && errs.length === 0,
          'R2-5 [BR] A 開啟後切換為 B、再登出：加購照常（購物車 2 件）但不帶 A 的追蹤；A 的歷史點擊保留', JSON.stringify({ clicks: ck.length, addsB, addsAll, cart, errs }));
        await ctx.close();
      });
      await step('R2-6', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const A3 = U(55), B3 = U(56);
        // 匿名開啟 → 背景辨識為 A：補認同一次開啟的請求延後回應；期間換成 B
        const ctx = await memberCtx(null); const pg = await ctx.newPage(); await fakeLiff(pg);
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&product_ref=${puuid(P_D)}&src=restock&m=takeout&d=${today()}&rt=${rt}`, { waitUntil: 'domcontentloaded' }); await sleep(3500);
        let held = null; let resp = null;
        await pg.route('**/api/product-demand/track/open**', async (route) => { resp = await route.fetch(); held = route; });
        await setMember(pg, A3); await pg.evaluate(() => { _restockReidentify(); return null; });
        for (let i = 0; i < 40 && !held; i++) await sleep(100);
        await setMember(pg, B3);
        if (held) await held.fulfill({ response: resp });
        await sleep(800);
        const st = await pg.evaluate(() => _restockAttr ? { owner: !!_restockAttr.owner, member: !!_restockAttr.member } : null);
        await pg.evaluate(() => { addCart(706); return null; }); await sleep(1500);
        const k = await pg.evaluate(() => { try { const a = JSON.parse(sessionStorage.getItem('restock_attr_store_001') || 'null'); return a && a.open_key; } catch (e) { return null; } });
        const clickRow = (await q('SELECT line_user_id FROM restock_notify_clicks WHERE batch_uuid=? AND session_id LIKE ? ORDER BY id DESC LIMIT 1', [BT.pv.batch_uuid, '%']))[0];
        const addsB = await q('SELECT COUNT(*) AS c FROM restock_notify_cart_adds WHERE batch_uuid=? AND line_user_id=?', [BT.pv.batch_uuid, B3]);
        assert(addsB[0].c === 0 && !(st && st.member), 'R2-6 [BR] 舊 A 的補認回應晚於切換為 B：不把 A 標記為目前會員；B 的加購不沿用 A 的開啟', JSON.stringify({ st, addsB: addsB[0].c, k: !!k, clickRow }));
        await pg.unroute('**/api/product-demand/track/open**');
        await ctx.close();
      });
      await step('R2-7', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        const ctx = await memberCtx(U(57)); const pg = await ctx.newPage(); await fakeLiff(pg);
        await pg.route('**/api/product-demand/track/open**', (route) => route.abort());
        await pg.route('**/api/analytics/events**', (route) => route.abort());
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&product_ref=${puuid(P_D)}&src=restock&m=takeout&d=${today()}&rt=${rt}`, { waitUntil: 'domcontentloaded' }); await sleep(3500);
        await pg.evaluate(() => { addCart(706); addCart(702); return null; }); await sleep(800);
        const cnt = await pg.evaluate(() => Object.values(cart).reduce((s, x) => s + x.qty, 0));
        assert(cnt === 2, 'R2-7 [BR] 追蹤與事件請求失敗：一般加購照常', String(cnt));
        await ctx.close();
      });
    }
    if (want('R3')) {
      const rt = rtOf(BT.pv.link_url);
      const clicksOf = async (u) => q('SELECT open_key, created_at, line_user_id FROM restock_notify_clicks WHERE batch_uuid=? AND line_user_id=? ORDER BY id', [BT.pv.batch_uuid, u]);
      const u = U(58);
      const inner = `?store_id=${STORE}&product_ref=${puuid(P_D)}&src=restock&m=takeout&d=${today()}&rt=${rt}`;
      const primary = `${C.s.base}/line-order.html?store_id=${STORE}&liff.state=${encodeURIComponent(inner)}`;
      let ctx = null, pg = null;
      await step('R3-1', async () => {
        if (!browser) throw new Error('需要瀏覽器');
        ctx = await memberCtx(u); pg = await ctx.newPage(); await fakeLiff(pg);
        if (process.env.C51_DEBUG) { pg.on('console', (m) => console.log('  [page]', m.text().slice(0, 200))); pg.on('request', (r) => { if (/track\/open|product-ref/.test(r.url())) console.log('  [req]', r.url().slice(0, 120)); }); pg.on('pageerror', (e) => console.log('  [err]', e.message)); }
        await pg.goto(primary, { waitUntil: 'domcontentloaded' }); await sleep(4500);
        if (process.env.C51_DEBUG) console.log('  [state]', JSON.stringify(await pg.evaluate(() => ({ link: _restockLink, nav: _restockNavKind, attr: _restockAttr, ms: !!_currentMemberSession() }))));
        const c = await clicksOf(u);
        const liff = await pg.evaluate(() => JSON.parse(sessionStorage.getItem('__c45liff') || '{}'));
        assert(c.length === 1 && liff.primary_init === 1, 'R3-1 [BR] 首次開啟（LIFF 一次→二次必要導向）：只形成 1 次有效開啟', JSON.stringify({ n: c.length, liff }));
      });
      await step('R3-2', async () => {
        await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
        await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
        assert((await clicksOf(u)).length === 1, 'R3-2 [BR] 重新整理兩次：點擊不增加', '');
      });
      await step('R3-3', async () => {
        // 同一分頁、短時間內再次點選通知連結（新的一次開啟）
        await pg.goto(primary, { waitUntil: 'domcontentloaded' }); await sleep(4500);
        const c = await clicksOf(u);
        const opened = await pg.evaluate(() => !!document.querySelector('.pdm-overlay.pdm-open'));
        assert(c.length === 2 && c[0].open_key !== c[1].open_key && opened, 'R3-3 [BR] 同一分頁短時間再次點擊通知連結：建立新的開啟識別、另計一次點擊、商品照常開啟', JSON.stringify({ n: c.length, opened }));
      });
      await step('R3-4', async () => {
        // 8 日後（伺服器時間）在同一分頁再次點擊：建立新點擊（伺服器時間），之後下單可歸因
        const off8 = String(Number(OFF) + 8 * 86400e3);
        await restart(off8);
        await setMember(pg, u);
        await pg.goto(primary, { waitUntil: 'domcontentloaded' }); await sleep(4500);
        const c = await clicksOf(u);
        const o = await order(u, [[P_D, 1]]);
        const at = await q('SELECT batch_uuid, clicked_at FROM restock_notify_order_attributions WHERE order_uuid=? AND product_id=?', [o.uuid, P_D]);
        const old = c[0] && c[0].created_at;
        assert(c.length === 3 && c[2].created_at > old && at.length === 1 && at[0].clicked_at === c[2].created_at,
          'R3-4 [BR] 首次點擊 8 日後在同一分頁再次點擊：新點擊使用伺服器目前時間，舊點擊保留；之後下單歸因到新點擊', JSON.stringify({ n: c.length, at, first: old, last: c[2] && c[2].created_at }));
      });
      await step('R3-5', async () => {
        // 7×24 小時邊界（以上一案例的新點擊為準）：+7d-2m 內、+7d+2m 外
        const c = await clicksOf(u); const last = Date.parse(c[c.length - 1].created_at.replace(' ', 'T') + 'Z');
        const nowSrv = RealDate.now() + Number(curOff);
        const inOff = String(Number(curOff) + (last + 7 * 86400e3 - 120e3 - nowSrv));
        await restart(inOff); const oIn = await order(u, [[P_D, 1]]);
        const outOff = String(Number(curOff) + 240e3);
        await restart(outOff); const oOut = await order(u, [[P_D, 1]]);
        const aIn = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oIn.uuid]);
        const aOut = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oOut.uuid]);
        assert(aIn[0].c === 1 && aOut[0].c === 0, 'R3-5 [API] 新點擊後的 7×24 小時邊界：差 2 分鐘內歸因、超過 2 分鐘不歸因（伺服器時間）', JSON.stringify({ in: aIn[0].c, out: aOut[0].c }));
        await restart(OFF);
      });
      await step('R3-6', async () => {
        // 不同通知批次、相同商品／日期／方式：第二批次的連結不被第一批次擋住
        await regNotify(u, P_D).catch(() => {});
        await editDb((db) => { db.run("UPDATE product_demand_requests SET status='cancelled' WHERE line_user_id=? AND product_id=? AND status='active'", [u, P_D]); });
        await regNotify(u, P_D);
        const BT2 = await sendBatch(P_D, 'takeout', today());
        const rt2 = rtOf(BT2.pv.link_url);
        await setMember(pg, u);
        const inner2 = inner.replace(`rt=${rt}`, `rt=${rt2}`);
        await pg.goto(`${C.s.base}/line-order.html?store_id=${STORE}&liff.state=${encodeURIComponent(inner2)}`, { waitUntil: 'domcontentloaded' }); await sleep(4500);
        const c2 = await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE batch_uuid=? AND line_user_id=?', [BT2.pv.batch_uuid, u]);
        const opened = await pg.evaluate(() => !!document.querySelector('.pdm-overlay.pdm-open'));
        assert(rt2 !== rt && c2[0].c === 1 && opened, 'R3-6 [BR] 不同批次的相同商品（同日期、同方式）：第二批次照常開啟並記錄點擊', JSON.stringify({ c2: c2[0].c, opened }));
      });
      await step('R3-7', async () => {
        // 會員辨識稍後完成：只補認同一次開啟，不新增點擊
        const v = U(57);
        const c2 = await memberCtx(null); const p2 = await c2.newPage(); await fakeLiff(p2);
        await p2.goto(`${C.s.base}/line-order.html${inner}`, { waitUntil: 'domcontentloaded' }); await sleep(3500);
        const before = (await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE batch_uuid=?', [BT.pv.batch_uuid]))[0].c;
        await setMember(p2, v); await p2.evaluate(() => { _restockReidentify(); return null; }); await sleep(1500);
        const after = (await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE batch_uuid=?', [BT.pv.batch_uuid]))[0].c;
        const mine2 = await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE batch_uuid=? AND line_user_id=?', [BT.pv.batch_uuid, v]);
        assert(after === before && mine2[0].c === 1, 'R3-7 [BR] 匿名開啟後才完成會員辨識：補認同一次開啟，不新增點擊', JSON.stringify({ before, after, v: mine2[0].c }));
        await c2.close();
      });
      if (ctx) await ctx.close();
    }

    // ════════════════════════════════════════════════════════════════════════════════
    //  R4 歸因部分失敗後必須能補完整
    // ════════════════════════════════════════════════════════════════════════════════
    if (want('R4')) {
      const u = U(61), u2 = U(62), u3 = U(63);
      for (const x of [u, u2, u3]) { await regNotify(x, P_B); await regNotify(x, P_C); }
      const B1 = await sendBatch(P_B, 'takeout', today());
      const B2 = await sendBatch(P_C, 'takeout', today());
      for (const x of [u, u2, u3]) { await open(rtOf(B1.pv.link_url), P_B, K('r4b' + x.slice(-4)), x); await open(rtOf(B2.pv.link_url), P_C, K('r4c' + x.slice(-4)), x); }
      const attrs = async (ou) => q('SELECT product_id, batch_uuid, attr_uuid, order_created_at FROM restock_notify_order_attributions WHERE order_uuid=? ORDER BY product_id', [ou]);
      const reconcile = async () => (await adm('POST', '/api/analytics/restock-notify/reconcile', { days: 30 })).json.data;
      let o1 = null;
      await step('R4-1', async () => {
        // 第二商品寫入失敗（測試邊界：暫存資料庫的 trigger）
        await editDb((db) => { db.run(`CREATE TRIGGER c51_fail_second BEFORE INSERT ON restock_notify_order_attributions WHEN NEW.product_id=${P_C} BEGIN SELECT RAISE(ABORT,'c51 injected'); END`); });
        o1 = await order(u, [[P_B, 1], [P_C, 2]]);
        const a = await attrs(o1.uuid);
        const ord = await q('SELECT order_status FROM orders WHERE uuid=?', [o1.uuid]);
        assert(ord.length === 1 && a.length === 0, 'R4-1 [API] 同張訂單兩個通知商品、第二商品寫入失敗：訂單照常成立，歸因整筆不寫（不留半套）', JSON.stringify({ attrs: a.map((x) => x.product_id) }));
      });
      await step('R4-2', async () => {
        await editDb((db) => { db.run('DROP TRIGGER IF EXISTS c51_fail_second'); });
        const r = await reconcile();
        const a = await attrs(o1.uuid);
        assert(a.length === 2 && a[0].batch_uuid === B1.pv.batch_uuid && a[1].batch_uuid === B2.pv.batch_uuid && r && r.failed === 0,
          'R4-2 [API] 故障排除後補登：兩個商品都補齊，且分屬不同批次', JSON.stringify({ r, a: a.map((x) => [x.product_id, x.batch_uuid.slice(0, 8)]) }));
      });
      let o2 = null;
      await step('R4-3', async () => {
        // C5 既有半套資料：只保留第一商品的歸因（模擬 C5 部分失敗）
        o2 = await order(u2, [[P_B, 1], [P_C, 1]]);
        await editDb((db) => { db.run('DELETE FROM restock_notify_order_attributions WHERE order_uuid=? AND product_id=?', [o2.uuid, P_C]); });
        const keep = (await attrs(o2.uuid))[0];
        const r = await reconcile();
        const a = await attrs(o2.uuid);
        assert(a.length === 2 && a[0].attr_uuid === keep.attr_uuid && a[1].product_id === P_C && r.completed_orders >= 1,
          'R4-3 [API] 修補 C5 既有半套資料：補上缺少商品，保留既有正確快照（attr_uuid 不變）', JSON.stringify({ r, kept: a[0] && a[0].attr_uuid === keep.attr_uuid }));
      });
      await step('R4-4', async () => {
        const n0 = (await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions'))[0].c;
        const r1 = await reconcile(); const r2 = await reconcile();
        const [x1, x2] = await Promise.all([reconcile(), reconcile()]);
        const n1 = (await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions'))[0].c;
        assert(n1 === n0 && r1.attributed === 0 && r2.attributed === 0 && x1.attributed === 0 && x2.attributed === 0 && typeof r1.scanned === 'number' && typeof r1.skipped === 'number' && typeof r1.failed === 'number',
          'R4-4 [API] 重跑兩次與併發補登：不重複計算；回報掃描、補齊、略過、失敗數量', JSON.stringify({ r1, n0, n1 }));
      });
      await step('R4-5', async () => {
        const o3 = await order(U(64), [[P_B, 1]]); // 沒有有效點擊
        await reconcile();
        assert((await attrs(o3.uuid)).length === 0, 'R4-5 [API] 沒有有效點擊的訂單：補登不產生歸因', '');
      });
      await step('R4-6', async () => {
        // 交易保存失敗（durable 寫入故障）：訂單成立，歸因不寫；之後補登完成
        fs.writeFileSync(DUR_CTRL, JSON.stringify({ skip: 1, fail: 1 }));
        const o4 = await order(u3, [[P_B, 1], [P_C, 1]]);
        const ctl = JSON.parse(fs.readFileSync(DUR_CTRL, 'utf8'));
        fs.writeFileSync(DUR_CTRL, '{}');
        const a0 = await attrs(o4.uuid);
        const ord = await q('SELECT COUNT(*) AS c FROM orders WHERE uuid=?', [o4.uuid]);
        await reconcile();
        const a1 = await attrs(o4.uuid);
        assert(ctl.failed === 1 && ord[0].c === 1 && a0.length === 0 && a1.length === 2 && a1.every((x) => x.order_created_at === a1[0].order_created_at),
          'R4-6 [API] 歸因交易保存失敗：訂單不受影響、歸因全部不寫；補登以訂單建立時間補齊', JSON.stringify({ failed: ctl.failed, a0: a0.length, a1: a1.length }));
      });
      await step('R4-7', async () => {
        // 補登時間晚於視窗：仍以實際保存的訂單建立時間計算
        const o5 = await order(u, [[P_B, 1]]);
        await editDb((db) => { db.run('DELETE FROM restock_notify_order_attributions WHERE order_uuid=?', [o5.uuid]); });
        await restart(String(Number(OFF) + 10 * 86400e3));
        await reconcile();
        const a = await attrs(o5.uuid);
        const ord = await q('SELECT created_at FROM orders WHERE uuid=?', [o5.uuid]);
        await restart(OFF);
        assert(a.length === 1, 'R4-7 [API] 10 日後補登：以訂單建立時間計算 7 日視窗（不用補登時間）', JSON.stringify({ a: a.length, created: ord[0] && ord[0].created_at }));
      });
    }

    // ════════════════════════════════════════════════════════════════════════════════
    //  R5 報表總計不能只統計最新 200 批次
    // ════════════════════════════════════════════════════════════════════════════════
    if (want('R5')) {
      // 測試邊界：直接在暫存資料庫建立 201 個已確認、有追蹤的批次（另一組商品，與上方案例分開）
      const N = 201;
      const seedP = 801, seedOld = 899; // 最舊批次使用獨有商品，檢驗商品篩選選項
      const exp = { acc: 0, click: 0, add: 0, deal: 0, orders: new Set(), amount: 0 };
      await editDb((db) => {
        db.run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order) VALUES (${seedP},'store_001','報表商品甲','飯類',101,100,1,1,'available',50)`);
        db.run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order) VALUES (${seedOld},'store_001','報表最舊商品','飯類',101,90,1,1,'available',51)`);
        const base = Date.parse('2026-09-01T02:00:00Z');
        for (let i = 0; i < N; i++) {
          const oldest = i === 0;
          const pid = oldest ? seedOld : seedP;
          const bu = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
          const conf = new Date(base + i * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
          db.run(`INSERT INTO restock_notify_batches (batch_uuid, store_id, product_id, product_name_snapshot, fulfillment_mode, supply_date, notice_kind, status, confirmed_at, tracking_id, message_text, message_hash, link_url, created_at)
                  VALUES (?,?,?,?,?,?,'restock',?,?,?,?,?,?,?)`, [bu, STORE, pid, oldest ? '報表最舊商品' : '報表商品甲', 'takeout', '2026-09-02', 'completed', conf, 'T' + String(i).padStart(19, '0'), 'm', 'h', 'https://x', conf]);
          const users = oldest ? ['Uold1', 'Uold2', 'Uold3'] : ['Ur' + i];
          users.forEach((uu, j) => {
            db.run(`INSERT INTO restock_notify_deliveries (delivery_uuid, store_id, batch_uuid, product_id, request_uuid, line_user_id, status, accepted_at, retry_key, created_at) VALUES (?,?,?,?,?,?,'accepted',?,?,?)`,
              [`d-${i}-${j}`, STORE, bu, pid, `rq-${i}-${j}`, uu, conf, `rk-${i}-${j}`, conf]);
            exp.acc++;
          });
          // 最舊批次：2 人點擊、1 人加購、1 人成交（兩個商品的同一張訂單，跨商品去重）
          const clickers = oldest ? ['Uold1', 'Uold2'] : (i % 2 ? ['Ur' + i] : []);
          clickers.forEach((uu, j) => {
            db.run(`INSERT INTO restock_notify_clicks (click_uuid, store_id, batch_uuid, product_id, open_key, line_user_id, recipient, created_at) VALUES (?,?,?,?,?,?,1,?)`,
              [`c-${i}-${j}`, STORE, bu, pid, `ok-${i}-${j}`, uu, conf]); exp.click++;
          });
          if (oldest || i % 4 === 1) {
            const uu = oldest ? 'Uold1' : 'Ur' + i;
            db.run(`INSERT INTO restock_notify_cart_adds (add_uuid, store_id, batch_uuid, product_id, click_uuid, event_key, line_user_id, recipient, quantity, created_at) VALUES (?,?,?,?,?,?,?,1,1,?)`,
              [`a-${i}`, STORE, bu, pid, `c-${i}-0`, `ek-${i}`, uu, conf]); exp.add++;
            const ou = oldest ? '00000000-0000-4000-a000-000000000000' : `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`;
            if (!exp.orders.has(ou)) {
              db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, status, order_status, payment_method, payment_status, source, line_user_id, created_at)
                      VALUES (?,?,?,?,?,?,?,'completed','pending','cash','pending','line',?,?)`, [ou, ou, 'RPT-' + i, STORE, '[]', 100, 100, uu, conf]);
              db.run(`INSERT INTO analytics_events (store_id, visitor_id, session_id, event_name, order_id, created_at) VALUES (?,?,?,?,?,?)`, [STORE, 'v', 's', 'purchase', ou, conf]);
            }
            exp.orders.add(ou);
            db.run(`INSERT INTO restock_notify_order_attributions (attr_uuid, store_id, order_uuid, order_number, product_id, batch_uuid, click_uuid, line_user_id, clicked_at, order_created_at, quantity, item_gross, discount_alloc, item_net, rule_version)
                    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,0,?,'c5')`, [`at-${i}`, STORE, ou, 'RPT-' + i, pid, bu, `c-${i}-0`, uu, conf, conf, 90, 90]);
            exp.deal++; exp.amount += 90;
          }
        }
        // 跨商品：最舊批次的訂單同時歸因到第 2 個批次的另一商品明細（同一張訂單只算一張）
        db.run(`INSERT INTO restock_notify_clicks (click_uuid, store_id, batch_uuid, product_id, open_key, line_user_id, recipient, created_at) VALUES ('c-x',?,?,?,?,?,1,'2026-09-01 03:00:00')`,
          [STORE, '00000000-0000-4000-9000-000000000001', seedP, 'ok-x', 'Uold1']);
        db.run(`INSERT INTO restock_notify_deliveries (delivery_uuid, store_id, batch_uuid, product_id, request_uuid, line_user_id, status, accepted_at, retry_key, created_at) VALUES ('d-x',?,?,?,'rq-x','Uold1','accepted','2026-09-01 03:00:00','rk-x','2026-09-01 03:00:00')`,
          [STORE, '00000000-0000-4000-9000-000000000001', seedP]);
        db.run(`INSERT INTO restock_notify_order_attributions (attr_uuid, store_id, order_uuid, order_number, product_id, batch_uuid, click_uuid, line_user_id, clicked_at, order_created_at, quantity, item_gross, discount_alloc, item_net, rule_version)
                VALUES ('at-x',?,?,?,?,?,'c-x','Uold1','2026-09-01 03:00:00','2026-09-01 03:00:00',1,50,0,50,'c5')`, [STORE, '00000000-0000-4000-a000-000000000000', 'RPT-0', seedP, '00000000-0000-4000-9000-000000000001']);
        exp.acc++; exp.click++; exp.amount += 50;
      });
      const qs = 'from=2026-08-01&to=2026-09-30';
      let full = null;
      await step('R5-1', async () => {
        full = await summary(qs + '&page_size=50');
        const t = full.totals;
        assert(t.batches === N && t.accepted_people === exp.acc && t.click_count === exp.click && t.orders === exp.orders.size && t.amount === exp.amount && t.deal_orders === exp.orders.size,
          'R5-1 [API] 201 個批次：總計包含排在最後的最舊批次（受理、點擊、成交、金額完整），跨商品同一訂單只算一張',
          JSON.stringify({ got: [t.batches, t.accepted_people, t.click_count, t.orders, t.amount], exp: [N, exp.acc, exp.click, exp.orders.size, exp.amount] }));
      });
      await step('R5-2', async () => {
        const pages = [];
        for (let p = 1; p <= 5; p++) pages.push(await summary(qs + `&page_size=50&page=${p}`));
        const p200 = await summary(qs + '&page_size=200&page=2');
        const same = pages.concat([p200]).every((x) => JSON.stringify(x.totals) === JSON.stringify(full.totals));
        const ids = new Set(pages.flatMap((x) => x.batches.map((b) => b.batch_uuid)));
        const last = pages[4].batches.find((b) => b.product_id === seedOld);
        assert(same && ids.size === N && pages[0].page.total_batches === N && pages[0].page.total_pages === 5 && last && last.click_people === 2 && last.deal_people === 1,
          'R5-2 [API] 分頁（50／200 每頁）切換：總計不變；所有批次都能在明細中取得；回傳總筆數與頁數', JSON.stringify({ same, ids: ids.size, page: pages[0].page, last: last && [last.click_people, last.deal_people] }));
      });
      await step('R5-3', async () => {
        const opt = (full.product_options || []).map((o) => o.product_id);
        const fOld = await summary(qs + `&product_id=${seedOld}`);
        const fMode = await summary(qs + '&mode=delivery');
        assert(opt.includes(seedOld) && fOld.totals.batches === 1 && fOld.batches.length === 1 && fOld.totals.click_people === 2 && fMode.totals.batches === 0 && fMode.totals.ctr === null,
          'R5-3 [API] 商品篩選選項包含較早批次的商品；篩選後總計與明細使用同一條件；無資料比率為「—」', JSON.stringify({ opt: opt.length, fOld: fOld.totals.batches }));
      });
      await step('R5-4', async () => {
        // 未建立追蹤的舊批次：照常計入已受理，其餘不併入
        await editDb((db) => { db.run("UPDATE restock_notify_batches SET tracking_id='' WHERE batch_uuid='00000000-0000-4000-9000-000000000200'"); });
        const s = await summary(qs + '&page_size=50');
        const row = s.batches.find((b) => b.batch_uuid === '00000000-0000-4000-9000-000000000200');
        assert(s.totals.untracked_batches === 1 && s.totals.accepted_people === exp.acc && row && row.tracked === false && row.click_people === null,
          'R5-4 [API] 舊批次「未建立追蹤」語意與比率分母口徑維持', JSON.stringify({ u: s.totals.untracked_batches, row: row && row.note }));
      });
    }

    // ════════════════════════════════════════════════════════════════════════════════
    //  R6 報表的店別、登入與頁面生命週期保護（真實瀏覽器）
    // ════════════════════════════════════════════════════════════════════════════════
    if (want('R6') && browser) {
      const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
      const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await actx.addInitScript(([t]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); sessionStorage.setItem('__seeded', '1'); } }, [C.tok]);
      const ap = await actx.newPage(); const aerr = []; const cons = []; ap.on('pageerror', (e) => aerr.push(e.message)); ap.on('console', (m) => cons.push(m.text())); ap.on('dialog', (d) => d.accept());
      await ap.goto(C.s.base + '/');
      await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.av2OpenRestockBatch === 'function', null, { timeout: 20000 });
      const asStore = (t, sid) => ap.evaluate(([tt, s]) => { localStorage.setItem('pos_store_token', tt); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: s, store_name: s })); if (window.currentStore) window.currentStore = { ...window.currentStore, store_id: s }; return null; }, [t, sid]);
      const RS_FROM = '2026-08-01', RS_TO = today();
      const openTab = async () => {
        await ap.evaluate(([f, t]) => { showPage('analytics_v2'); _av2RsDefaults(); _av2Rs.f.from = f; _av2Rs.f.to = t; av2SwitchTab('restock'); return null; }, [RS_FROM, RS_TO]);
        await ap.waitForSelector('#av2-rs-k-accepted', { timeout: 15000 }); await sleep(500);
      };
      const mark = () => ap.evaluate(() => { window.__c51mark = _av2Rs.data; window.__c51err = _av2Rs.error; return null; });
      const written = () => ap.evaluate(() => ({ data: _av2Rs.data != null && _av2Rs.data !== window.__c51mark, err: !!_av2Rs.error && _av2Rs.error !== window.__c51err }));
      const kpi = () => ap.evaluate(() => ({ acc: (document.getElementById('av2-rs-k-accepted') || {}).textContent || null, err: (document.getElementById('av2-rs-error') || {}).textContent || '', body: (document.getElementById('av2-rs-body') || {}).textContent || '' }));
      const s1 = (await summary(`from=${RS_FROM}&to=${RS_TO}`)).totals; // store_001（與畫面相同的篩選）
      const s1txt = String(s1.tracked_accepted_people);
      // 扣住下一個 summary 回應（伺服器先完成，再扣住）；mode：'ok'｜'error'｜'403'
      const holdNext = async (mode) => {
        const h = { route: null, resp: null };
        await ap.route('**/api/analytics/restock-notify/summary**', async (route) => {
          if (h.route) return route.continue();
          h.resp = await route.fetch(); h.route = route;
        });
        h.release = async () => {
          for (let i = 0; i < 50 && !h.route; i++) await sleep(100);
          if (!h.route) return;
          if (mode === 'error') await h.route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: '模擬錯誤' }) });
          else if (mode === '403') await h.route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'FORBIDDEN', message: 'x' }) });
          else await h.route.fulfill({ response: h.resp });
          await sleep(800); await ap.unroute('**/api/analytics/restock-notify/summary**');
        };
        return h;
      };
      await step('R6-1', async () => {
        await openTab();
        const k0 = await kpi();
        const h = await holdNext('ok');
        await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(300);
        await mark();
        await asStore(tok2, 'store_002');
        await h.release();
        const k1 = await kpi();
        const w = await written();
        const st = await ap.evaluate(() => ({ owner: _av2Rs.dataOwner ? _av2Rs.dataOwner.split('|')[0] : null, hasData: !!_av2Rs.data, w: null }));
        st.w = w;
        assert(Number(s1txt) > 0 && k0.acc === s1txt && !w.data && st.owner !== 'store_001' && k1.acc !== s1txt, 'R6-1 [BR] 延後成功：A 店回應在切換至 B 店後才到達 → 不寫入資料、不顯示 A 店數字',
          JSON.stringify({ k0: k0.acc, k1: k1.acc, st }));
      });
      await step('R6-2', async () => {
        // 回到 A 店重新載入，再測延後錯誤
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        const h = await holdNext('error');
        await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(300);
        await mark();
        await asStore(tok2, 'store_002');
        await h.release();
        const w = await written();
        const st = await ap.evaluate(() => ({ err: _av2Rs.error, owner: _av2Rs.dataOwner ? _av2Rs.dataOwner.split('|')[0] : null, has: !!_av2Rs.data }));
        assert(!w.err && !st.err && !st.has, 'R6-2 [BR] 延後錯誤：切店後才到達的 A 店錯誤不寫入（不顯示、不保留 A 店結果）', JSON.stringify(st));
      });
      await step('R6-3', async () => {
        // 延後讀完回應內容（JSON 解析）：在頁面內包裝 fetch（測試邊界）
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        await ap.evaluate(() => {
          window.__c51Gate = null; const of = window.fetch; window.__c51OrigFetch = of;
          window.fetch = async function (u, o) {
            const r = await of.apply(this, arguments);
            if (String(u).includes('/restock-notify/summary') && !window.__c51Used) {
              window.__c51Used = true; const txt = await r.clone().text();
              return { ok: r.ok, status: r.status, headers: r.headers, json: () => new Promise((res) => { window.__c51Gate = () => res(JSON.parse(txt)); }) };
            }
            return r;
          };
          av2RsApply(); return null;
        });
        for (let i = 0; i < 50; i++) { if (await ap.evaluate(() => !!window.__c51Gate)) break; await sleep(100); }
        await mark();
        await asStore(tok2, 'store_002');
        await ap.evaluate(() => { if (window.__c51Gate) window.__c51Gate(); window.fetch = window.__c51OrigFetch; window.__c51Used = false; return null; }); await sleep(800);
        const w = await written();
        const st = await ap.evaluate(() => ({ owner: _av2Rs.dataOwner ? _av2Rs.dataOwner.split('|')[0] : null, has: !!_av2Rs.data }));
        st.w = w;
        assert(!w.data && !st.has, 'R6-3 [BR] 延後 JSON 解析：讀完回應內容時已切店 → 丟棄', JSON.stringify(st));
      });
      await step('R6-4', async () => {
        // 同店換登入身分（另一個 JWT）
        await sleep(1100); const tok1b = await H.login(C.s.base, STORE, 'pw001'); // 另一個登入身分（不同 JWT）
        if (tok1b === C.tok) throw new Error('tok1b 與目前 JWT 相同');
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        const h = await holdNext('ok');
        await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(300);
        await mark();
        await asStore(tok1b, 'store_001');
        await h.release();
        const w = await written();
        const st = { w };
        assert(!w.data, 'R6-4 [BR] 換登入身分：前一個身分的回應不寫入目前身分的快取', JSON.stringify(st));
      });
      await step('R6-5', async () => {
        // 登出（clearToken）期間的回應
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        const h = await holdNext('ok');
        await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(300);
        await ap.evaluate(() => { clearToken(); return null; });
        await h.release();
        const st = await ap.evaluate(() => ({ has: !!_av2Rs.data, body: (document.getElementById('av2-rs-body') || {}).textContent || '' }));
        assert(!st.has, 'R6-5 [BR] 登出：清除報表快取，延後回應不寫入', JSON.stringify({ has: st.has }));
      });
      await step('R6-6', async () => {
        // 權限失效 403：清除不應再顯示的資料
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        const before = await ap.evaluate(() => !!_av2Rs.data);
        const h = await holdNext('403');
        await ap.evaluate(() => { av2RsApply(); return null; });
        await h.release();
        const st = await ap.evaluate(() => ({ has: !!_av2Rs.data, acc: (document.getElementById('av2-rs-k-accepted') || {}).textContent || null }));
        assert(before && !st.has && st.acc === null, 'R6-6 [BR] 權限失效（403）：清除報表資料，不再顯示數字', JSON.stringify({ before, st }));
      });
      await step('R6-7', async () => {
        // 離開分頁再進入：舊請求不寫入；重新進入重新查詢
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        const h = await holdNext('ok');
        await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(300);
        await mark();
        await ap.evaluate(() => { showPage('pos'); return null; });
        await h.release();
        const w = await written();
        const mid = { w };
        await openTab(); await sleep(800);
        const k = await kpi();
        assert(!w.data && k.acc === s1txt, 'R6-7 [BR] 離開頁面期間的回應不寫入；重新進入重新查詢並顯示目前店別數字', JSON.stringify({ mid, k: k.acc }));
      });
      await step('R6-8', async () => {
        // 原店（A）有快取；切到 B 店後查詢失敗 → 不顯示 A 店的上次結果
        await asStore(C.tok, 'store_001'); await ap.evaluate(() => { av2RsApply(); return null; }); await sleep(1500);
        await asStore(tok2, 'store_002');
        const h = await holdNext('error');
        await ap.evaluate(() => { av2RsApply(); return null; });
        await h.release();
        const k = await kpi();
        assert(k.acc !== s1txt && !/顯示上次結果/.test(k.body), 'R6-8 [BR] 原店快取遇到新店查詢失敗：不以「上次結果」顯示前一店資料', JSON.stringify({ acc: k.acc, body: k.body.slice(0, 80) }));
      });
      await step('R6-9', async () => {
        const leak = cons.filter((t) => t.includes(C.tok) || t.includes(tok2) || /member_session/.test(t));
        assert(leak.length === 0 && aerr.length === 0, 'R6-9 [BR] 診斷紀錄不含 JWT／會員 session；後台無 JavaScript 錯誤', JSON.stringify({ leak: leak.map((x) => x.slice(0, 120).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<JWT>')), aerr }));
      });
      await actx.close();
    }

    // ════════════════════════════════════════════════════════════════════════════════
    //  R7 訂單唯一識別、LINE Pay 與搬家對應
    // ════════════════════════════════════════════════════════════════════════════════
    if (want('R7')) {
      // ── A. 新訂單：固定時鐘（同一毫秒）連續與並行建立 ──
      await step('R7-A', async () => {
        const freeze = RealDate.now() + Number(OFF); // 台北 10:30 附近的固定一毫秒
        const F = await C45.boot('c51f', { products: PRODUCTS, settings: { coupon_feature_enabled: '1' }, seed: linepaySeed,
          env: { __nodeArgs: ['-r', path.join(LIB, 'c51-frozen-clock.js'), '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c51-linepay-mock.js')],
            C51_FREEZE_MS: String(freeze), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real } });
        boots.push(F);
        const tdy = new Date(freeze + 8 * 3600e3).toISOString().slice(0, 10);
        const mk = (i) => ({ customer_name: '同秒' + i, customer_phone: '09' + String(10000000 + i), order_type: 'takeout', pickup_date: tdy, pickup_time: '15:00', payment_method: 'cash', items: [{ product_id: 702, qty: 1 }] });
        const seqR = []; for (let i = 0; i < 20; i++) seqR.push(await C45.pub(F.s.base, 'POST', '/api/line-orders', mk(i)));
        const parR = await Promise.all(Array.from({ length: 20 }, (_, i) => C45.pub(F.s.base, 'POST', '/api/line-orders', mk(100 + i))));
        const posR = await Promise.all(Array.from({ length: 5 }, () => H.api(F.s.base, F.tok, 'POST', '/api/orders', { items: [{ id: 702, name: '測試對照湯', price: 150, qty: 1 }], payment_method: 'cash', received_amount: 150, subtotal: 150, total: 150, order_mode: 'dine_in' })));
        await sleep(300);
        const db = await H.openDbFile(F.dbf);
        let rows; try { rows = H.q(db, "SELECT * FROM orders WHERE store_id='store_001' AND created_at IS NOT NULL ORDER BY rowid"); } finally { db.close(); }
        const line = rows.filter((r) => r.source === 'line' && /^LINE-/.test(r.order_number));
        const nums = line.map((r) => r.order_number);
        const okAll = seqR.concat(parR).every((r) => r.json && r.json.success);
        if (!okAll) console.log('R7-A fail sample', JSON.stringify(seqR.concat(parR).filter((r) => !(r.json && r.json.success)).slice(0, 2).map((r) => [r.status, r.text.slice(0, 200)])));
        const pos = rows.filter((r) => r.source !== 'line' && !/^S2-|^\d{4}-/.test(r.order_number) && r.order_number && posR.some((x) => x.json && x.json.data && x.json.data.order_number === r.order_number));
        const posNums = posR.map((x) => x.json && x.json.data && x.json.data.order_number);
        const sameSecond = new Set(nums.map((n) => n.replace(/-[A-Z0-9]{4}$/, ''))).size === 1;
        assert(okAll && line.length === 40 && new Set(nums).size === 40 && line.every((r) => Number(r.order_no_v) === 2) && sameSecond && new Set(posNums).size === 5 && posNums.every(Boolean),
          'R7-A [API] 固定時鐘（同一毫秒）連續 20 張＋並行 20 張 LINE 訂單、並行 5 張店內 POS 訂單：顯示編號全部不同、同一秒、新編號受唯一索引保護',
          JSON.stringify({ ok: okAll, n: line.length, distinct: new Set(nums).size, sample: nums.slice(0, 3), posDistinct: new Set(posNums).size, pos: pos.length, fails: seqR.concat(parR).filter((r) => !(r.json && r.json.success)).length }));
        // 持久化唯一約束：直接嘗試寫入相同的新格式編號 → 資料庫拒絕
        await F.s.stop();
        const db2 = await H.openDbFile(F.dbf); let blocked = false;
        try { const v2 = line.find((r) => Number(r.order_no_v) === 2); db2.run("INSERT INTO orders (id,uuid,order_number,store_id,items,subtotal,total,order_no_v) VALUES ('dup-x','dup-x',?,'store_001','[]',1,1,2)", [v2 ? v2.order_number : (line[0] && line[0].order_number)]); } catch (e) { blocked = /UNIQUE/.test(e.message); } finally { db2.close(); }
        let ship = [];
        const shp = path.join(H.ROOT, 'utils', 'orderIdentity.js');
        if (fs.existsSync(shp)) { const sh = require(shp); const db3 = await H.openDbFile(F.dbf); try { const fixed = new Date(freeze); ship = Array.from({ length: 30 }, () => sh.allocateOrderNumber(db3, 'store_001', 'SHIP-', fixed)); } finally { db3.close(); } }
        assert(blocked && new Set(ship).size === 30, 'R7-A2 [DB] 新編號的持久化唯一索引拒絕重複；宅配（SHIP-）共用同一產生器，同一秒 30 組不重複', JSON.stringify({ blocked, ship: ship.slice(0, 2) }));
      });

      // ── B. LINE Pay ──
      // 建立兩張真實 LINE Pay 訂單，再在暫存資料庫把它們改成「歷史同號」（模擬 C4.4／C5 同秒產生的舊單）
      const mkPair = async (tag, o = {}) => {
        const a = await order(U(71), [[702, 1]], { pay: 'linepay', name: tag + 'A', phone: '0911000001' });
        const b = await order(o.memberB || U(72), [[704, 2]], { pay: 'linepay', name: tag + 'B', phone: '0922000002' });
        const N = `LINE-20261101-120000${tag}`;
        await editDb((db) => {
          if (hasCol(db, 'orders', 'order_no_v')) db.run('UPDATE orders SET order_no_v=NULL WHERE uuid IN (?,?)', [a.uuid, b.uuid]); // 先取消新格式標記，才能改成歷史同號
          db.run('UPDATE orders SET order_number=? WHERE uuid IN (?,?)', [N, a.uuid, b.uuid]);
          if (o.txA !== undefined) db.run('UPDATE orders SET linepay_transaction_id=? WHERE uuid=?', [o.txA, a.uuid]);
          if (o.txB !== undefined) db.run('UPDATE orders SET linepay_transaction_id=? WHERE uuid=?', [o.txB, b.uuid]);
          if (o.otherStore) db.run("INSERT INTO orders (id,uuid,order_number,store_id,items,subtotal,total,payment_method,payment_status,source) VALUES (?,?,?,'store_002','[]',999,999,'linepay','pending','line')", ['s2-' + tag, 's2-' + tag, N]);
        });
        return { a, b, N };
      };
      const ordRow = async (uuid) => (await q('SELECT uuid, payment_status, total, line_user_id, linepay_transaction_id FROM orders WHERE uuid=?', [uuid]))[0];
      const quota = async () => (await q("SELECT id, line_quota_sold, line_preorder_sold FROM products WHERE store_id='store_001' AND id IN (702,704) ORDER BY id")).map((r) => r.line_quota_sold + '/' + r.line_preorder_sold).join(',');
      const cb = async (qs) => { const r = await fetch(`${C.s.base}/api/linepay/confirm?${qs}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
      const confirmCalls = () => lpCalls().filter((c) => /\/confirm$/.test(c.uri)).length;
      const purchases = async (uuid) => (await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','payment_success')", [uuid]))[0].c;
      const links = async (uuid) => (await q('SELECT COUNT(*) AS c FROM line_member_order_links WHERE order_id=?', [uuid]))[0].c;
      await step('R7-B1', async () => {
        // C5.3 調整：升級前的付款（沒有付款嘗試紀錄）沒有可靠處理階段，C5.3 不補送 Confirm，只以唯讀查詢核對。
        // 前提改為「金流端已在升級前完成 B 的付款」，斷言 B 以查詢恢復、外部 Confirm 0 次，且仍不串到 A。
        lpCtrl({});
        const P = await mkPair('B1', { txA: '2026110100000000011', txB: '2026110100000000012' });
        setMockTx('2026110100000000012', { confirmed: true, orderId: P.N, amount: Number((await ordRow(P.b.uuid)).total), currency: 'TWD' });
        const q0 = await quota();
        const loc = await cb(`store_id=${STORE}&transactionId=2026110100000000012&orderId=${encodeURIComponent(P.N)}`);
        const A = await ordRow(P.a.uuid), B = await ordRow(P.b.uuid);
        const q1 = await quota();
        // C5.2 必要調整：LINE 訂單建立時已依快照扣份數，付款確認不再扣（C5.1 斷言 q1 !== q0 反映的是重複扣除）
        assert(B.payment_status === 'paid' && A.payment_status !== 'paid' && /linepay=success/.test(loc) && q1 === q0 && (await purchases(P.b.uuid)) === 2 && (await purchases(P.a.uuid)) === 0 && confirmsForTx('2026110100000000012') === 0,
          'R7-B1 [API] 歷史同號兩張訂單、升級前付款（伺服器已保存交易識別）：B 的 callback 只確認 B，不串到 A', JSON.stringify({ A: A.payment_status, B: B.payment_status, loc: loc.slice(0, 80) }));
      });
      await step('R7-B2', async () => {
        lpCtrl({ allowUnknown: true });
        const P = await mkPair('B2', { txA: '', txB: '' });
        const c0 = confirmCalls();
        const loc = await cb(`store_id=${STORE}&transactionId=2026110100000000099&orderId=${encodeURIComponent(P.N)}`);
        const A = await ordRow(P.a.uuid), B = await ordRow(P.b.uuid);
        assert(A.payment_status !== 'paid' && B.payment_status !== 'paid' && confirmCalls() === c0 && /order_ambiguous/.test(loc),
          'R7-B2 [API] 歷史同號且沒有可靠交易對應：拒絕自動判定（不呼叫 LINE Pay、兩張都不變）並提示需核對', JSON.stringify({ A: A.payment_status, B: B.payment_status, loc: loc.slice(0, 120) }));
      });
      let P3 = null, tx3 = null, url3 = null;
      await step('R7-B3', async () => {
        lpCtrl({});
        P3 = await mkPair('B3', { otherStore: true });
        // 前端照舊送出 order_number（同號）與 redirect_url；伺服器必須以訂單唯一識別建立付款
        const r = await pub('POST', '/api/linepay/request', { order_uuid: P3.b.uuid, order_number: P3.N, total: 1, items: [{ name: 'x', qty: 1, price: 1 }], customer_name: 'B',
          redirect_url: `${C.s.base}/api/linepay/confirm?store_id=${STORE}`, cancel_url: `${C.s.base}/line-order.html?store_id=${STORE}&linepay=cancel` });
        const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
        tx3 = call && call.tx; url3 = call && call.confirmUrl;
        const B0 = await ordRow(P3.b.uuid);
        const loc = await cb(`${new URL(url3).search.slice(1)}&transactionId=${tx3}&orderId=${encodeURIComponent(call.orderId)}`);
        const A = await ordRow(P3.a.uuid), B = await ordRow(P3.b.uuid);
        const s2 = (await q("SELECT payment_status FROM orders WHERE uuid='s2-B3'"))[0];
        const att = await qOpt('SELECT transaction_id, status, order_uuid FROM linepay_payment_attempts WHERE order_uuid=?', [P3.b.uuid]);
        assert(r.json && r.json.success && call.amount === B0.total && B.payment_status === 'paid' && A.payment_status !== 'paid' && s2.payment_status === 'pending'
          && att.length === 1 && att[0].transaction_id === String(tx3) && ['confirmed', 'paid'].includes(att[0].status) /* C5.2 狀態名稱 confirmed→paid */ && /linepay=success/.test(loc) && loc.includes(P3.b.uuid),
        'R7-B3 [API] 新付款請求：金額與付款對象由伺服器依訂單 uuid 建立（不信任前端 order_number／total）；callback 以付款嘗試唯一定位 B（不同金額、會員、店別的同號單不受影響）；19 位交易識別完整保存',
        JSON.stringify({ amt: [call && call.amount, B0.total], A: A.payment_status, B: B.payment_status, s2: s2 && s2.payment_status, att, loc: loc.slice(0, 100) }));
      });
      await step('R7-B4', async () => {
        // 重複 callback（模擬供應商對重複確認也回成功）：不重複扣份數、purchase、會員消費或歸因
        lpCtrl({ reconfirm: '0000' });
        const q0 = await quota(); const p0 = await purchases(P3.b.uuid); const l0 = await links(P3.b.uuid); const c0 = confirmCalls();
        const qs = `${new URL(url3).search.slice(1)}&transactionId=${tx3}&orderId=${encodeURIComponent(lpCalls().filter((c) => c.tx === tx3)[0].orderId)}`;
        const locs = await Promise.all([cb(qs), cb(qs)]);
        const loc3 = await cb(qs);
        const q1 = await quota();
        assert(q1 === q0 && (await purchases(P3.b.uuid)) === p0 && (await links(P3.b.uuid)) === l0 && confirmCalls() === c0 && locs.concat([loc3]).every((l) => /linepay=success/.test(l)),
          'R7-B4 [API] 重複 callback（含同時兩個）：不再呼叫確認、不重複扣份數、purchase、會員消費', JSON.stringify({ q: [q0, q1], calls: confirmCalls() - c0 }));
        lpCtrl({});
      });
      await step('R7-B5', async () => {
        const P = await mkPair('B5');
        await pub('POST', '/api/linepay/request', { order_uuid: P.a.uuid, order_number: P.N });
        const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
        const c0 = confirmCalls();
        const wrong = String(BigInt(call.tx) + 1n);
        const loc = await cb(`${new URL(call.confirmUrl).search.slice(1)}&transactionId=${wrong}&orderId=${encodeURIComponent(call.orderId)}`);
        const loc2 = await cb(`${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(P.N + 'X')}`);
        const A = await ordRow(P.a.uuid), B = await ordRow(P.b.uuid);
        assert(A.payment_status !== 'paid' && B.payment_status !== 'paid' && confirmCalls() === c0 && /linepay=error/.test(loc) && /linepay=error/.test(loc2),
          'R7-B5 [API] 交易識別或 orderId 與付款嘗試不符：拒絕，不呼叫確認、不改訂單', JSON.stringify({ loc: loc.slice(0, 90), calls: confirmCalls() - c0 }));
      });
      await step('R7-B6', async () => {
        // 付款失敗、返回取消照常；訂單維持未付款
        const P = await mkPair('B6');
        await pub('POST', '/api/linepay/request', { order_uuid: P.b.uuid });
        const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
        lpCtrl({ confirm: '1150' });
        const loc = await cb(`${new URL(call.confirmUrl).search.slice(1)}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`);
        lpCtrl({});
        const cancel = await fetch(`${C.s.base}/api/linepay/cancel?store_id=${STORE}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' });
        const B = await ordRow(P.b.uuid);
        const att = (await qOpt('SELECT status, result_code FROM linepay_payment_attempts WHERE order_uuid=?', [P.b.uuid]))[0];
        // 同一訂單再次付款（前一次未完成）：新的付款嘗試、不同 orderId
        await pub('POST', '/api/linepay/request', { order_uuid: P.b.uuid });
        const call2 = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
        const loc2 = await cb(`${new URL(call2.confirmUrl).search.slice(1)}&transactionId=${call2.tx}&orderId=${encodeURIComponent(call2.orderId)}`);
        const B2 = await ordRow(P.b.uuid);
        assert(/linepay=fail/.test(loc) && B.payment_status !== 'paid' && att && att.status === 'failed' && /linepay=cancel/.test(cancel.headers.get('location') || '')
          && call2.orderId !== call.orderId && B2.payment_status === 'paid' && /linepay=success/.test(loc2),
        'R7-B6 [API] 付款失敗／取消返回維持原行為；再次付款建立新的付款嘗試（不同 orderId）後成功', JSON.stringify({ loc: loc.slice(0, 80), att, ids: [call.orderId, call2.orderId] }));
      });
      await step('R7-B7', async () => {
        // 舊付款返回頁：以 order_ref 精確取單；只用同號編號查詢不猜
        const byRef = await pub('POST', '/api/line-orders/query', { order_number: P3.N, order_ref: P3.b.uuid });
        const byNo = await pub('POST', '/api/line-orders/query', { order_number: P3.N });
        const o = byRef.json && byRef.json.orders && byRef.json.orders[0];
        assert(o && o.total === (await ordRow(P3.b.uuid)).total && byNo.status === 409,
          'R7-B7 [API] 付款返回頁以訂單唯一識別取單（顯示 B 的金額）；只用重號編號查詢回 409，不回傳另一張', JSON.stringify({ total: o && o.total, byNo: byNo.status }));
      });
      await step('R7-B8', async () => {
        // 升級前已建立、編號唯一的付款請求（沒有付款嘗試、交易識別已保存）：相容路徑可完成
        // C5.3 調整：前提改為金流端已在升級前完成付款；相容路徑以唯讀查詢恢復，不補送 Confirm
        lpCtrl({});
        const o = await order(U(73), [[702, 1]], { pay: 'linepay' });
        await editDb((db) => { db.run('UPDATE orders SET linepay_transaction_id=? WHERE uuid=?', ['2026110100000000555', o.uuid]); });
        setMockTx('2026110100000000555', { confirmed: true, orderId: o.order_number, amount: Number((await ordRow(o.uuid)).total), currency: 'TWD' });
        const loc = await cb(`store_id=${STORE}&transactionId=2026110100000000555&orderId=${encodeURIComponent(o.order_number)}`);
        const r = await ordRow(o.uuid);
        lpCtrl({});
        assert(r.payment_status === 'paid' && /linepay=success/.test(loc) && confirmsForTx('2026110100000000555') === 0, 'R7-B8 [API] 升級前已建立的付款請求（唯一編號＋已保存交易識別）：相容路徑照常完成（C5.3：以唯讀查詢恢復、不補送 Confirm）', JSON.stringify({ st: r.payment_status, confirms: confirmsForTx('2026110100000000555') }));
      });

      // ── C. 快速搬家 ──
      let PM = null;
      await step('R7-C1', async () => {
        // 來源：同號不同 uuid 的兩張訂單（含優惠券使用、會員訂單關聯、Analytics、操作紀錄、補貨歸因）
        await regNotify(U(74), P_E); await regNotify(U(75), P_E);
        const BE = await sendBatch(P_E, 'takeout', today());
        await open(rtOf(BE.pv.link_url), P_E, K('r7ma'), U(74)); await open(rtOf(BE.pv.link_url), P_E, K('r7mb'), U(75));
        const a = await order(U(74), [[P_E, 1]], { coupon: 'C51OFF', name: '搬家A' });
        const b = await order(U(75), [[P_E, 2]], { coupon: 'C51OFF', name: '搬家B' });
        const N = 'LINE-20261102-090000';
        await editDb((db) => {
          if (hasCol(db, 'orders', 'order_no_v')) db.run('UPDATE orders SET order_no_v=NULL WHERE uuid IN (?,?)', [a.uuid, b.uuid]); // 先取消新格式標記，才能改成歷史同號
          db.run('UPDATE orders SET order_number=? WHERE uuid IN (?,?)', [N, a.uuid, b.uuid]);
          db.run('UPDATE coupon_redemptions SET order_number=? WHERE order_id IN (?,?)', [N, a.uuid, b.uuid]);
          for (const o of [a, b]) db.run("INSERT INTO order_logs (store_id,order_id,order_number,action,reason,operator,before_total,after_total,created_at) VALUES ('store_001',?,?,'modify','c51','staff',1,2,'2026-11-02 09:00:00')", [o.uuid, N]);
        });
        PM = { a, b, N };
        const src = await q('SELECT COUNT(*) AS c FROM orders WHERE order_number=?', [N]);
        assert(src[0].c === 2, 'R7-C1 [DB] 來源資料：同號不同 uuid 兩張訂單與子資料', JSON.stringify({ n: src[0].c }));
      });
      const childCounts = async (dbf, store, uuids) => {
        const db = await H.openDbFile(dbf);
        try {
          return uuids.map((u0) => {
            const hasO = H.q(db, 'PRAGMA table_info(orders)').some((c) => c.name === 'import_origin_uuid');
            const o = hasO ? H.q1(db, 'SELECT id, uuid, total, line_user_id FROM orders WHERE store_id=? AND (uuid=? OR import_origin_uuid=?)', [store, u0, u0])
              : H.q1(db, 'SELECT id, uuid, total, line_user_id FROM orders WHERE store_id=? AND uuid=?', [store, u0]);
            if (!o) return null;
            const id = o.id;
            return { id, total: o.total, member: o.line_user_id, cr: H.q1(db, 'SELECT COUNT(*) AS c FROM coupon_redemptions WHERE store_id=? AND order_id=?', [store, id]).c,
              logs: H.q1(db, 'SELECT COUNT(*) AS c FROM order_logs WHERE store_id=? AND order_id=?', [store, id]).c,
              links: H.q1(db, 'SELECT COUNT(*) AS c FROM line_member_order_links WHERE store_id=? AND order_id=?', [store, id]).c,
              ev: H.q1(db, "SELECT COUNT(*) AS c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='purchase'", [store, id]).c,
              attr: H.q1(db, 'SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE store_id=? AND order_uuid=?', [store, id]).c };
          });
        } finally { db.close(); }
      };
      let full = null, part = null;
      await step('R7-C2', async () => {
        full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
        part = await H.download(C.s.base, C.tok, '/api/migration/v2/export?categories=orders,member_history,analytics,discounts');
        const T = await C45.boot('c51t', { products: PRODUCTS, settings: { restock_notify_enabled: '1' } }); boots.push(T);
        const up = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'c51full.json' });
        const im = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: JSON.parse(full.buf.toString('utf8')).selected_categories });
        await sleep(300);
        const c1 = await childCounts(T.dbf, STORE, [PM.a.uuid, PM.b.uuid]);
        const up2 = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'c51full2.json' });
        const im2 = await H.previewAndImport(T.s.base, T.tok, up2.json.upload_id, { mode: 'merge', categories: JSON.parse(full.buf.toString('utf8')).selected_categories });
        await sleep(300);
        const c2 = await childCounts(T.dbf, STORE, [PM.a.uuid, PM.b.uuid]);
        const n2 = await (async () => { const db = await H.openDbFile(T.dbf); try { return H.q1(db, 'SELECT COUNT(*) AS c FROM orders WHERE order_number=?', [PM.N]).c; } finally { db.close(); } })();
        const ok = (c) => c && c.every((x) => x && x.cr === 1 && x.logs === 1 && x.links === 1 && x.ev === 1 && x.attr === 1);
        assert(im.import && im.import.status === 'done' && ok(c1) && c1[0].total !== c1[1].total && JSON.stringify(c1) === JSON.stringify(c2) && n2 === 2 && im2.import && im2.import.status === 'done',
          'R7-C2 [API] 完整搬家到新環境：同號不同 uuid 的兩張都存在，優惠券使用、操作紀錄、會員關聯、Analytics、補貨歸因各自跟隨正確訂單；重複匯入維持冪等',
          JSON.stringify({ st: im.import && im.import.status, c1, n2 }));
        // 選擇性備份（訂單＋會員紀錄＋Analytics＋折扣）匯入另一個新環境
        const T2 = await C45.boot('c51t2', { products: PRODUCTS, settings: {} }); boots.push(T2);
        const up3 = await H.uploadRaw(T2.s.base, T2.tok, part.buf, { name: 'c51part.json' });
        const im3 = await H.previewAndImport(T2.s.base, T2.tok, up3.json.upload_id, { mode: 'merge', categories: JSON.parse(part.buf.toString('utf8')).selected_categories });
        await sleep(300);
        const c3 = await childCounts(T2.dbf, STORE, [PM.a.uuid, PM.b.uuid]);
        assert(im3.import && im3.import.status === 'done' && c3.every((x) => x && x.cr === 1 && x.logs === 1 && x.links === 1 && x.ev === 1),
          'R7-C3 [API] 選擇性搬家（訂單、會員紀錄、Analytics、折扣）：兩張都存在且子資料關聯正確', JSON.stringify({ st: im3.import && im3.import.status, c3 }));
      });
      await step('R7-C4', async () => {
        // 同一資料庫跨店匯入（目標已有相同 id → 換新 id）：子資料跟隨新識別；重複匯入冪等
        const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
        const up = await H.uploadRaw(C.s.base, tok2, part.buf, { name: 'c51cross.json' });
        const im = await H.previewAndImport(C.s.base, tok2, up.json.upload_id, { mode: 'merge', categories: ['orders', 'member_history', 'analytics'], allow_cross_store: true });
        await sleep(300);
        const c1 = await childCounts(C.dbf, 'store_002', [PM.a.uuid, PM.b.uuid]);
        const up2 = await H.uploadRaw(C.s.base, tok2, part.buf, { name: 'c51cross2.json' });
        const im2 = await H.previewAndImport(C.s.base, tok2, up2.json.upload_id, { mode: 'merge', categories: ['orders', 'member_history', 'analytics'], allow_cross_store: true });
        await sleep(300);
        const c2 = await childCounts(C.dbf, 'store_002', [PM.a.uuid, PM.b.uuid]);
        const orig = await childCounts(C.dbf, STORE, [PM.a.uuid, PM.b.uuid]);
        const s2n = (await q("SELECT COUNT(*) AS c FROM orders WHERE store_id='store_002' AND order_number=?", [PM.N]))[0].c;
        const idsChanged = c1.every((x, i) => x && x.id !== [PM.a.uuid, PM.b.uuid][i]);
        assert(im.import && im.import.status === 'done' && s2n === 2 && idsChanged && c1.every((x) => x.logs === 1 && x.links === 1 && x.ev === 1) && JSON.stringify(c1) === JSON.stringify(c2)
          && orig.every((x) => x && x.logs === 1 && x.ev === 1),
        'R7-C4 [API] 同一資料庫跨店匯入（ID 改變）：兩張都存在、子資料跟隨新識別、原店不受影響；重複匯入冪等', JSON.stringify({ st: im.import && im.import.status, s2n, c1, idsChanged }));
      });
      await step('R7-C5', async () => {
        // 跨店匯入的 LINE Pay 交易屬於歷史資料：callback 不得自動啟用
        lpCtrl({ allowUnknown: true });
        const row = (await q("SELECT uuid, order_number FROM orders WHERE store_id='store_002' AND order_number=? LIMIT 1", [PM.N]))[0];
        await editDb((db) => {
          db.run("UPDATE orders SET payment_status='pending', payment_method='linepay', linepay_transaction_id='2026110100000000777' WHERE store_id='store_002' AND uuid=?", [row.uuid]);
          db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_002','LINE Pay','linepay',1,'test','test-channel-c51b','test-secret-c51b')");
        });
        const c0 = confirmCalls();
        const loc = await cb(`store_id=store_002&transactionId=2026110100000000777&orderId=${encodeURIComponent(row.uuid)}`);
        const r = (await q("SELECT payment_status FROM orders WHERE store_id='store_002' AND uuid=?", [row.uuid]))[0];
        lpCtrl({});
        assert(r.payment_status !== 'paid' && confirmCalls() === c0 && /linepay=error/.test(loc), 'R7-C5 [API] 跨店匯入訂單的來源付款交易：callback 不自動啟用（不呼叫確認、不改狀態）', JSON.stringify({ st: r.payment_status, loc: loc.slice(0, 90) }));
      });
      await step('R7-C6', async () => {
        // 舊備份缺少 uuid 與 id：同號多張 → 列為衝突，不以編號推定
        const j = JSON.parse(part.buf.toString('utf8'));
        j.data.orders = j.data.orders.map((o) => { if (o.order_number === PM.N) { const x = { ...o }; delete x.uuid; delete x.id; return x; } return o; });
        const T3 = await C45.boot('c51t3', { products: PRODUCTS, settings: {} }); boots.push(T3);
        const up = await H.uploadRaw(T3.s.base, T3.tok, Buffer.from(JSON.stringify(j)), { name: 'c51old.json' });
        const im = await H.previewAndImport(T3.s.base, T3.tok, up.json.upload_id, { mode: 'merge', categories: ['orders'] });
        const st = im.import && im.import.result && im.import.result.stats && im.import.result.stats.orders;
        const n = await (async () => { const db = await H.openDbFile(T3.dbf); try { return H.q1(db, 'SELECT COUNT(*) AS c FROM orders WHERE order_number=?', [PM.N]).c; } finally { db.close(); } })();
        assert(st && st.conflict === 2 && n === 0, 'R7-C6 [API] 舊備份缺少訂單識別、同號多張：列為衝突（2 筆），不推定、不合併', JSON.stringify({ st: st && { added: st.added, conflict: st.conflict, dup: st.duplicate_in_file }, n }));
      });

      // ── D. 歷史資料 ──
      await step('R7-D1', async () => {
        const groups = (await q("SELECT COUNT(*) AS c FROM (SELECT order_number FROM orders WHERE store_id='store_001' GROUP BY order_number HAVING COUNT(*)>1)"))[0].c;
        await restart(curOff); // 有歷史重號時重新啟動（執行遷移）
        const h = await fetch(C.s.base + '/api/health');
        const diag = await adm('GET', '/api/order-identity/diagnostics');
        const log = C.s.getLog();
        const g = diag.json && diag.json.data;
        const keep = await q("SELECT COUNT(*) AS c FROM orders WHERE store_id='store_001' AND order_number IN (?,?)", [PM.N, 'LINE-20261101-120000B1']);
        assert(h.ok && g && g.duplicate_groups === groups && groups >= 6 && keep[0].c === 4 && !/order_identity migration:/.test(log),
          'R7-D1 [API] 有歷史重號時啟動遷移不失敗；不刪除、不合併、不重新編號；診斷 API 列出重號群組', JSON.stringify({ groups, diag: g && g.duplicate_groups, idx: g && g.indexes }));
      });
    }

    // ═══ Z 外部呼叫 ═══
    const real = boots.reduce((n, b) => n + b.mf.real(), 0);
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0 && realPay === 0, 'Z 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次（全部在測試程序內攔截）', JSON.stringify({ line: real, linepay: realPay, lpMock: lpCalls().length }));
  } catch (e) {
    console.error(e); H.fail('測試例外', e.stack || e.message);
  } finally { if (browser) { try { await browser.close(); } catch {} } await stopAll(); }
  const s = H.summary();
  if (process.env.C51_RESULT_JSON) fs.writeFileSync(process.env.C51_RESULT_JSON, JSON.stringify({ root: H.ROOT, pass: s.passCount, fail: s.failCount, results: s.results }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
