#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js
// R54.4／MBV2-HF1-C4.4 —— 較早的「異動」回應（新增／修改／取消／撤回同意）不得覆蓋較新的操作結果。
// 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）；顧客異動全部走正式路由。
// 重疊的做法：請求先送達伺服器並完成資料庫寫入、取得回應（route.fetch），再扣住回應；期間以 UI 完成後續操作，
// 最後才放行舊回應。「response 已取得、JSON body 尚未讀完」以測試內的 Response.prototype.json 閘門模擬
// （只延遲讀取 body，不修改內容）。每個案例核對商品卡、本人清單、管理表單與伺服器資料（正式 /mine 路由讀回資料庫）。
// 同一支測試先在未修改的 C4.3 執行（重現），再於 C4.4 執行。LINE API 由程序內攔截計數，真實呼叫須為 0。
'use strict';
const path = require('path');
const fs = require('fs');
(() => {
  if (process.env.C4_CLOCK_OFFSET_MS !== undefined) return;
  const tp = new Date(Date.now() + 8 * 3600e3);
  const mins = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  process.env.C4_CLOCK_OFFSET_MS = String(mins < 8 * 60 || mins >= 20 * 60 ? (10 * 60 + 30 - mins) * 60e3 : 0);
})();
require('./lib/c4-test-clock');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('playwright not installed'); process.exit(2); }

const STORE = 'store_001';
const PID = 701, PID3 = 706;
const NET_MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const LINE_MOCK = path.join(__dirname, 'lib', 'c4-line-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const MOCKDIR = H.tmpDir('c44-linemock');
const PUSH_FILE = path.join(MOCKDIR, 'real-line-attempts.txt');
const MOCK_CTRL = path.join(MOCKDIR, 'ctrl.json'), MOCK_STATE = path.join(MOCKDIR, 'state.json'), MOCK_LOG = path.join(MOCKDIR, 'calls.jsonl');
fs.writeFileSync(PUSH_FILE, ''); fs.writeFileSync(MOCK_CTRL, '{}'); fs.writeFileSync(MOCK_STATE, JSON.stringify({ accepted: {}, used: {} })); fs.writeFileSync(MOCK_LOG, '');
const realLine = () => fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
const mockCalls = () => fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MS = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js'));
const session = (u) => MS.createMemberSession({ store_id: STORE, line_user_id: u });
const U = (n) => 'Uc44' + String(n).padStart(28, '0');
const SKEY = 'line_member_session_store_001';
const REAL_NOW = () => Date.now() - Number(process.env.C4_CLOCK_OFFSET_MS || 0);
const sessVal = (u) => JSON.stringify({ member_session: session(u), display_name: '測試會員', is_friend: true, expires_at: REAL_NOW() + 3600e3 });
const TOKEN = 'test-only-channel-token-not-real-c44', LIFF = '2000000000-TestLiffC44';

function seedAll(db) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1'); set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0'); set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654'); set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout');
  set('line_channel_token', TOKEN); set('line_member_liff_id', LIFF);
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_quota_low_threshold: 'INTEGER DEFAULT 2', line_quota_high_threshold: 'INTEGER DEFAULT 10',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_preorder_low_threshold: 'INTEGER DEFAULT 2', line_preorder_high_threshold: 'INTEGER DEFAULT 10',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1', shipping_enabled: 'INTEGER DEFAULT 0', shipping_share_line_stock: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const ins = (id, name, sort, status) => runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
      line_quota_enabled,line_quota_daily,line_quota_sold,line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_takeout_enabled,line_delivery_enabled)
      VALUES (?,?,?,?,?,?,1,1,?,?, 1,10,0, 1,20,0, 1,1)`, [id, STORE, name, '飯類', 101, 150, status, sort]);
  ins(PID, '測試招牌飯', 0, 'paused'); ins(702, '測試對照湯', 1, 'available'); ins(PID3, '測試第二暫停品', 2, 'paused');
  for (let i = 1; i <= 30; i++) runSql('INSERT INTO line_members (store_id, line_user_id, display_name, is_friend) VALUES (?,?,?,1)', [STORE, U(i), '會員' + i]);
}
const srvEnv = () => ({ __nodeArgs: ['-r', CLOCK, '-r', NET_MOCK, '-r', LINE_MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
  HF1C3_PUSH_COUNT_FILE: PUSH_FILE, C4_LINE_MOCK_CTRL: MOCK_CTRL, C4_LINE_MOCK_STATE: MOCK_STATE, C4_LINE_MOCK_LOG: MOCK_LOG });
async function boot() {
  const dir = H.tmpDir('c44'); const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedAll(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf, srvEnv());
  return { s, dbf, tok: await H.login(s.base, STORE, 'pw001') };
}
async function pub(C, method, p, body) {
  const r = await fetch(`${C.s.base}${p}${p.includes('?') ? '&' : '?'}store_id=${STORE}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const reg = (C, u, pid, qty, extra = {}) => pub(C, 'POST', '/api/product-demand/register', { member_session: session(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra });
const adm = (C, m, p, b) => H.api(C.s.base, C.tok, m, p, b);
// 伺服器端最終狀態（正式 /mine 路由，回傳有效登記）
async function srv(C, u, pid = PID) { const r = await pub(C, 'POST', '/api/product-demand/mine', { member_session: session(u) }); const row = ((r.json && r.json.data) || []).find((x) => x.product_id === pid); return row ? { qty: row.desired_qty, consent: row.notify_consent } : null; }
async function liveCounters(C) {
  const r = await adm(C, 'GET', '/api/products/line-products/list');
  const ps = (r.json && r.json.data) || [];
  const o = await adm(C, 'GET', '/api/line-orders/online?limit=500');
  const orders = o.json && (o.json.data || o.json.orders) || [];
  return { sold: ps.map((p) => [p.id, Number(p.line_quota_sold || 0), Number(p.line_preorder_sold || 0)]), orders: Array.isArray(orders) ? orders.length : -1 };
}
function installHolder(page) {
  const rules = [];
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const idx = rules.findIndex((r) => r.method === req.method() && r.re.test(req.url()));
    if (idx < 0) return route.continue().catch(() => {});
    const rule = rules.splice(idx, 1)[0];
    if (rule.fail) { // 不送達伺服器（伺服器未處理），稍後回錯誤
      rule.got.resolve({ url: req.url(), reqBody: req.postData() });
      await rule.gate;
      if (rule.fail === 'abort') return route.abort('failed').catch(() => {});
      return route.fulfill({ status: rule.fail, contentType: 'application/json', body: JSON.stringify({ success: false, code: rule.fail === 401 ? 'MEMBER_SESSION_INVALID' : 'TEST_ERROR', message: '測試：伺服器錯誤' + rule.fail }) }).catch(() => {});
    }
    let resp; try { resp = await route.fetch(); } catch (e) { rule.got.reject(e); return; }
    const body = await resp.text();
    rule.got.resolve({ url: req.url(), status: resp.status(), body, reqBody: req.postData() });
    const how = await rule.gate;
    if (how === 'abort') return route.abort('failed').catch(() => {});
    if (how && how.status) return route.fulfill({ status: how.status, contentType: 'application/json', body: JSON.stringify(how.body || { success: false }) }).catch(() => {});
    return route.fulfill({ response: resp, body }).catch(() => {});
  });
  return {
    hold(method, re, opts = {}) {
      let gres, gotRes, gotRej; const gate = new Promise((r) => { gres = r; });
      const got = new Promise((a, b) => { gotRes = a; gotRej = b; });
      const rule = { method, re, gate, got: { resolve: gotRes, reject: gotRej }, fail: opts.fail || 0 };
      rules.push(rule);
      return { got, release: (how) => gres(how || null) };
    },
  };
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);
const reReg = /\/api\/product-demand\/register/, reCancel = /\/api\/product-demand\/cancel/, reRevoke = /\/api\/product-demand\/consent\/revoke/;

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C4.4 異動回應一致性（較早的異動回應不得覆蓋較新的操作）驗收 ══════════');
  console.log('時鐘位移（毫秒）：' + process.env.C4_CLOCK_OFFSET_MS);
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  let C;
  try {
    C = await boot();
    const c0 = await liveCounters(C);
    const OPEN = [];
    async function openP(u) {
      const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
      OPEN.push(context);
      await context.addInitScript(([sk, sv]) => {
        if (!sessionStorage.getItem('__seeded')) { if (sv) localStorage.setItem(sk, sv); sessionStorage.setItem('__seeded', '1'); }
        // 測試用：延遲讀取 response body（不改內容），模擬「response 已取得、JSON 尚未讀完」
        const orig = Response.prototype.json;
        Response.prototype.json = async function () {
          const g = window.__jsonGate;
          if (g && g.re.test(this.url)) { window.__jsonGate = null; window.__jsonHit = true; await g.p; }
          return orig.call(this);
        };
        window.__toasts = [];
        document.addEventListener('DOMContentLoaded', () => {
          const t = document.getElementById('toast');
          if (t) new MutationObserver(() => { const s = t.textContent.trim(); if (s) window.__toasts.push(s); }).observe(t, { childList: true, characterData: true, subtree: true });
        });
      }, [SKEY, u ? sessVal(u) : '']);
      const page = await context.newPage();
      const st = { errors: [] }; page.on('pageerror', (e) => st.errors.push(e.message));
      const HD = installHolder(page);
      await page.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`#dr-${PID} button.demand-btn`, { timeout: 15000 });
      await sleep(1200);
      return { context, page, st, HD };
    }
    const btn = (page, pid = PID) => page.evaluate((id) => { const b = document.querySelector(`#dr-${id} button.demand-btn`); return b ? b.textContent : null; }, pid);
    const openForm = async (page, pid = PID) => { await page.click(`#dr-${pid} button.demand-btn`); await page.waitForSelector('#demandOverlay.show', { timeout: 8000 }); await sleep(300); };
    const closeForm = (page) => page.evaluate(() => { closeDemandSheet(); return null; });
    const form = (page) => page.evaluate(() => {
      const ov = document.getElementById('demandOverlay');
      const open = !!(ov && ov.classList.contains('show'));
      const st = typeof _demandSheetState !== 'undefined' && _demandSheetState ? { pid: _demandSheetState.productId, view: _demandSheetState.view, qty: _demandSheetState.qty } : null;
      return { open, st, title: (document.getElementById('dmTitle') || {}).textContent || '', msg: (document.getElementById('dmMsg') || {}).textContent || '',
        submit: (document.getElementById('dmSubmit') || {}).textContent || null, cancel: !!document.getElementById('dmCancel'), sub: !!document.getElementById('dmSubscribed'),
        revoke: !!document.getElementById('dmRevoke'), consentChecked: (document.getElementById('dmConsent') || {}).checked, text: open ? document.getElementById('demandPanel').innerText.replace(/\s+/g, ' ') : '' };
    });
    // 本人清單（頁首「📋 我的補貨登記」）
    const listOf = async (page) => { await page.evaluate(() => { document.getElementById('myDemandsBtn').click(); return null; }); await sleep(1500); const t = await page.evaluate(() => document.getElementById('demandPanel').innerText.replace(/\s+/g, ' ')); await closeForm(page); return t; };
    // 每個案例獨立：例外記為失敗並繼續下一個案例（關閉該案例的瀏覽器分頁）
    async function scen(name, fn) {
      if (process.env.C44_ONLY && !process.env.C44_ONLY.split(',').includes(name)) return;
      try { await fn(); }
      catch (e) { H.fail(`${name} 案例中斷：${e && e.message ? e.message.split('\n')[0] : e}`, ''); }
      for (const c of OPEN.splice(0)) { try { await c.close(); } catch {} }
    }
    const setNotify = (on) => adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: !!on });

    // ── X1 修改成 3 份（回應扣住）→ 關閉 → 重新開啟 → 取消成功 → 放行舊回應
    await scen('X1', async () => { let L;
    const u = U(1); await reg(C, u, PID, 2);
      L = await openP(u);
      await openForm(L.page); await L.page.click('#dmPlus');
      const h = L.HD.hold('POST', reReg); await L.page.click('#dmSubmit'); const g = await withTimeout(h.got, 8000, 'X1 reg');
      await closeForm(L.page); await openForm(L.page);
      await L.page.click('#dmCancel'); await sleep(1200);
      const mid = await btn(L.page);
      h.release(); await sleep(1800);
      const card = await btn(L.page); const s = await srv(C, u); const list = await listOf(L.page);
      await openForm(L.page); const f = await form(L.page); await closeForm(L.page);
      assert(JSON.parse(g.body).data.request.desired_qty === 3 && mid === '補貨登記', 'X1-前提 伺服器先完成「3 份」並扣住回應；取消成功後畫面已移除', JSON.stringify({ mid }));
      assert(s === null && card === '補貨登記' && /目前沒有有效的補貨登記/.test(list) && !f.cancel && f.submit === '送出補貨登記', 'X1 修改 3 份的成功回應晚於取消成功：資料庫無有效登記；商品卡、清單、表單維持已取消', JSON.stringify({ s, card, list: list.slice(0, 80), f: { cancel: f.cancel, submit: f.submit } }));
      assert(L.st.errors.length === 0, 'X1-E 無 JavaScript 錯誤', L.st.errors.join('|'));
      await L.context.close(); });
    // ── X2 修改成 3 份（扣住）→ 修改成 5 份成功 → 放行
    await scen('X2', async () => { let L;
    const u = U(2); await reg(C, u, PID, 2);
      L = await openP(u);
      await openForm(L.page); await L.page.click('#dmPlus');
      const h = L.HD.hold('POST', reReg); await L.page.click('#dmSubmit'); await withTimeout(h.got, 8000, 'X2 reg');
      await closeForm(L.page); await openForm(L.page);
      await L.page.click('#dmPlus'); await L.page.click('#dmPlus'); await L.page.click('#dmPlus'); await L.page.click('#dmSubmit'); await sleep(1200);
      h.release(); await sleep(1800);
      const card = await btn(L.page); const s = await srv(C, u); const list = await listOf(L.page);
      await openForm(L.page); const f = await form(L.page); await closeForm(L.page);
      assert(s && s.qty === 5 && card === '已登記 5 份・管理登記' && /5 份/.test(list) && !/3 份/.test(list) && f.st && f.st.qty === 5, 'X2 修改 3 份的成功回應晚於修改 5 份成功：資料庫、商品卡、清單、表單都是 5 份', JSON.stringify({ s, card, list: list.slice(0, 80), qty: f.st && f.st.qty }));
      await L.context.close(); });
    // ── 通知可用（測試資料庫設定；不發送）
    await setNotify(true);
    // ── X3 已同意者送出修改（舊成功回應含「已同意」，扣住）→ 撤回同意成功 → 放行
    await scen('X3', async () => { let L;
    const u = U(3); await reg(C, u, PID, 2, { notify_consent: true });
      L = await openP(u);
      await openForm(L.page); const f0 = await form(L.page); await L.page.click('#dmPlus');
      const h = L.HD.hold('POST', reReg); await L.page.click('#dmSubmit'); const g = await withTimeout(h.got, 8000, 'X3 reg');
      await closeForm(L.page); await openForm(L.page);
      await L.page.click('#dmRevoke'); await sleep(1200);
      h.release(); await sleep(1800);
      const s = await srv(C, u);
      await closeForm(L.page); await openForm(L.page); const f = await form(L.page); await closeForm(L.page);
      const card = await btn(L.page);
      assert(f0.sub && /"notify_consent":"granted"/.test(g.body), 'X3-前提 舊登記為已同意；扣住的舊成功回應含已同意', '');
      assert(s && s.consent === 'revoked' && s.qty === 3 && !f.sub && f.consentChecked === false && card === '已登記 3 份・管理登記', 'X3 舊登記成功回應晚於撤回同意：資料庫與畫面都維持已撤回（不顯示已訂閱、勾選未勾）', JSON.stringify({ s, f: { sub: f.sub, chk: f.consentChecked }, card }));
      await L.context.close(); });
    // ── X4 已同意者取消（成功回應扣住）→ 重新開啟（本機仍顯示舊登記）→ 送出（伺服器建立新週期）→ 放行舊取消
    await scen('X4', async () => { let L;
    const u = U(4); await reg(C, u, PID, 2, { notify_consent: true });
      L = await openP(u);
      await openForm(L.page);
      const h = L.HD.hold('POST', reCancel); await L.page.click('#dmCancel'); await withTimeout(h.got, 8000, 'X4 cancel');
      const sMid = await srv(C, u);
      await closeForm(L.page); await openForm(L.page);
      await L.page.click('#dmPlus'); await L.page.click('#dmSubmit'); await sleep(1200);
      h.release(); await sleep(1800);
      const card = await btn(L.page); const s = await srv(C, u); const list = await listOf(L.page);
      await openForm(L.page); const f = await form(L.page); await closeForm(L.page);
      assert(sMid === null, 'X4-前提 取消已先在伺服器完成（無有效登記）', JSON.stringify(sMid));
      assert(s && s.qty === 3 && s.consent !== 'granted' && card === '已登記 3 份・管理登記' && /3 份/.test(list) && !f.sub && f.consentChecked === false,
        'X4 舊取消成功回應晚於重新登記（新週期）：新登記不被移除；通知同意不沿用舊週期（未勾、不顯示已訂閱）', JSON.stringify({ s, card, list: list.slice(0, 80), f: { sub: f.sub, chk: f.consentChecked } }));
      await L.context.close(); });
    await setNotify(false);
    // ── X5 舊操作 401（伺服器未處理）晚到：不覆蓋新結果、不把目前會員標成過期；新表單不被關閉或改寫
    await scen('X5', async () => { let L;
    const u = U(5); await reg(C, u, PID, 2);
      L = await openP(u);
      await openForm(L.page); await L.page.click('#dmPlus');
      const h = L.HD.hold('POST', reReg, { fail: 401 }); await L.page.click('#dmSubmit'); await withTimeout(h.got, 8000, 'X5 reg');
      await closeForm(L.page); await openForm(L.page);
      await L.page.click('#dmPlus'); await L.page.click('#dmPlus'); await L.page.click('#dmSubmit'); await sleep(1200);
      await openForm(L.page); const before = await form(L.page);
      h.release(); await sleep(1500);
      const f = await form(L.page); const card = await btn(L.page); const s = await srv(C, u);
      assert(s && s.qty === 4 && card === '已登記 4 份・管理登記' && f.open && before.open && !/過期|重新以 LINE 登入|伺服器錯誤/.test(f.text) && f.st && f.st.qty === 4,
        'X5 舊操作 401 晚到：資料庫與商品卡維持 4 份；之後開啟的表單仍開著、未被改成登入過期或錯誤', JSON.stringify({ s, card, f: { open: f.open, msg: f.msg, text: f.text.slice(0, 80) } }));
      await closeForm(L.page);
      await L.context.close(); });
    await scen('X5', async () => { let L;
    const u = U(5);
      L = await openP(u); // 新頁面（避免前一段狀態影響）
      // 舊操作網路錯誤晚到
      await openForm(L.page); await L.page.click('#dmMinus');
      const h2 = L.HD.hold('POST', reReg, { fail: 'abort' }); await L.page.click('#dmSubmit'); await withTimeout(h2.got, 8000, 'X5b reg');
      await closeForm(L.page); await openForm(L.page);
      h2.release(); await sleep(1500);
      const f2 = await form(L.page); const s2 = await srv(C, u);
      assert(f2.open && !/網路不穩/.test(f2.msg) && s2.qty === 4 && (await btn(L.page)) === '已登記 4 份・管理登記', 'X5-2 舊操作網路錯誤晚到：新開啟的表單不顯示舊錯誤、不被關閉；狀態依伺服器（4 份）', JSON.stringify({ f2: { open: f2.open, msg: f2.msg }, s2 }));
      await closeForm(L.page);
      await L.context.close(); });
    // ── X6 response 已取得、JSON body 尚未讀完時切換會員：取消（A）→ 切到 B 並開啟 B 的表單 → 放行
    await scen('X6', async () => { let L;
    const ua = U(6), ub = U(7); await reg(C, ua, PID, 2); await reg(C, ub, PID, 5);
      L = await openP(ua);
      await openForm(L.page);
      await L.page.evaluate(() => { window.__jsonHit = false; window.__jsonGate = { re: /\/api\/product-demand\/cancel/, p: new Promise((r) => { window.__jsonRelease = r; }) }; });
      await L.page.click('#dmCancel');
      const hit = await withTimeout((async () => { for (;;) { if (await L.page.evaluate(() => window.__jsonHit)) return true; await sleep(100); } })(), 8000, 'X6 json');
      await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(ub)]);
      await closeForm(L.page); await openForm(L.page); await sleep(1500);
      const before = await form(L.page);
      const toasts0 = await L.page.evaluate(() => window.__toasts.length);
      await L.page.evaluate(() => { window.__jsonRelease(); return null; }); await sleep(1500);
      const f = await form(L.page); const card = await btn(L.page);
      const toasts = await L.page.evaluate((n) => window.__toasts.slice(n), toasts0);
      const sa = await srv(C, ua), sb = await srv(C, ub);
      assert(hit && sa === null && sb && sb.qty === 5, 'X6-前提 A 的取消已在伺服器完成（body 尚未讀完）；B 有 5 份', JSON.stringify({ sa, sb }));
      assert(before.open && f.open && f.st && f.st.qty === 5 && !/已取消補貨登記/.test(toasts.join('|')) && card === '已登記 5 份・管理登記' && !/過期/.test(f.text),
        'X6 JSON 讀取期間切換會員：A 的取消回應不關閉 B 的表單、不對 B 顯示「已取消」、B 仍為 5 份', JSON.stringify({ before: before.open, f: { open: f.open, qty: f.st && f.st.qty }, toasts, card }));
      // 撤回同意版本
      await setNotify(true);
      await closeForm(L.page);
      await reg(C, ua, PID, 1, { notify_consent: true }); await reg(C, ub, PID, 5, { notify_consent: true });
      await L.context.close();
      L = await openP(ua); // 通知設定改變後重新開頁（公開設定於載入時讀取）
      await openForm(L.page);
      await L.page.evaluate(() => { window.__jsonHit = false; window.__jsonGate = { re: /\/api\/product-demand\/consent\/revoke/, p: new Promise((r) => { window.__jsonRelease = r; }) }; });
      await L.page.click('#dmRevoke');
      await withTimeout((async () => { for (;;) { if (await L.page.evaluate(() => window.__jsonHit)) return true; await sleep(100); } })(), 8000, 'X6b json');
      await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(ub)]);
      await closeForm(L.page); await openForm(L.page); await sleep(1500);
      const b2 = await form(L.page);
      await L.page.evaluate(() => { window.__jsonRelease(); return null; }); await sleep(1500);
      const f2 = await form(L.page);
      const sa2 = await srv(C, ua), sb2 = await srv(C, ub);
      assert(sa2.consent === 'revoked' && sb2.consent === 'granted' && b2.open && f2.open && f2.sub && !/已取消補貨通知/.test(f2.msg),
        'X6-2 撤回同意的 JSON 讀取期間切換會員：A 已撤回、B 的表單仍顯示 B 的「已訂閱」，不出現 A 的撤回提示', JSON.stringify({ sa2, sb2, b2: { open: b2.open, st: b2.st, text: b2.text.slice(0, 120) }, f2: { open: f2.open, sub: f2.sub, msg: f2.msg } }));
      await closeForm(L.page);
      await setNotify(false);
      await L.context.close(); });
    // ── X7 先前修改已成功，後續取消失敗（伺服器未處理）：依伺服器狀態顯示，保留正確錯誤提示
    await scen('X7', async () => { let L;
    const u = U(8); await reg(C, u, PID, 2);
      L = await openP(u);
      await openForm(L.page); await L.page.click('#dmPlus'); await L.page.click('#dmSubmit'); await sleep(1200);
      await openForm(L.page);
      const h = L.HD.hold('POST', reCancel, { fail: 500 }); await L.page.click('#dmCancel'); await withTimeout(h.got, 8000, 'X7 cancel');
      h.release(); await sleep(1800);
      const f = await form(L.page); const card = await btn(L.page); const s = await srv(C, u); const toasts = await L.page.evaluate(() => window.__toasts);
      await closeForm(L.page); const list = await listOf(L.page);
      assert(s && s.qty === 3 && f.open && /伺服器錯誤500/.test(f.msg) && f.cancel && card === '已登記 3 份・管理登記' && /3 份/.test(list) && !toasts.some((t) => /已取消補貨登記/.test(t)),
        'X7 先前修改成功、後續取消失敗：表單保留錯誤提示；商品卡、清單、資料庫都是 3 份，不誤報取消成功', JSON.stringify({ s, f: { open: f.open, msg: f.msg }, card, list: list.slice(0, 60), toasts }));
      await L.context.close(); });
    // ── X8 操作途中關閉並開啟其他商品表單：舊回應（成功／錯誤）不關閉、不改寫新表單；舊商品結果仍正確
    await scen('X8', async () => { let L;
    const u = U(9); await reg(C, u, PID, 2);
      L = await openP(u);
      await openForm(L.page, PID); await L.page.click('#dmPlus');
      const h = L.HD.hold('POST', reReg); await L.page.click('#dmSubmit'); await withTimeout(h.got, 8000, 'X8 reg');
      await closeForm(L.page); await openForm(L.page, PID3);
      h.release(); await sleep(1500);
      const f = await form(L.page); const c1 = await btn(L.page, PID); const s1 = await srv(C, u, PID);
      assert(f.open && f.st && String(f.st.pid) === String(PID3) && f.msg === '' && c1 === '已登記 3 份・管理登記' && s1.qty === 3, 'X8 舊成功回應：另一商品的新表單仍開著且未被改寫；原商品結果（3 份）正常套用', JSON.stringify({ f: { open: f.open, pid: f.st && f.st.pid, msg: f.msg }, c1, s1 }));
      await closeForm(L.page);
      await openForm(L.page, PID); await L.page.click('#dmPlus');
      const h2 = L.HD.hold('POST', reReg, { fail: 500 }); await L.page.click('#dmSubmit'); await withTimeout(h2.got, 8000, 'X8b reg');
      await closeForm(L.page); await openForm(L.page, PID3);
      h2.release(); await sleep(1500);
      const f2 = await form(L.page);
      assert(f2.open && String(f2.st && f2.st.pid) === String(PID3) && !/伺服器錯誤/.test(f2.msg) && (await srv(C, u, PID)).qty === 3, 'X8-2 舊錯誤回應：另一商品的新表單不顯示舊錯誤、不被關閉', JSON.stringify({ f2: { open: f2.open, pid: f2.st && f2.st.pid, msg: f2.msg } }));
      // 不同商品的正常操作：在 PID3 表單送出，兩個商品結果都保留
      await L.page.click('#dmSubmit'); await sleep(1500);
      const c3 = await btn(L.page, PID3); const s3 = await srv(C, u, PID3);
      assert(c3 === '已登記 1 份・管理登記' && s3.qty === 1 && (await btn(L.page, PID)) === '已登記 3 份・管理登記', 'X8-3 不同商品的操作互不影響：兩個商品結果都保留', JSON.stringify({ c3, s3 }));
      await L.context.close(); });
    // ── X9 沒有重疊：新增、修改、取消、撤回同意照常可用
    await setNotify(true);
    await scen('X9', async () => { let L;
    const u = U(10);
      L = await openP(u);
      await openForm(L.page); await L.page.click('#dmConsent'); await L.page.click('#dmSubmit'); await sleep(1200);
      const a = { card: await btn(L.page), s: await srv(C, u) };
      await openForm(L.page); await L.page.click('#dmPlus'); await L.page.click('#dmSubmit'); await sleep(1200);
      const b = { card: await btn(L.page), s: await srv(C, u) };
      await openForm(L.page); await L.page.click('#dmRevoke'); await sleep(1000);
      const c = { f: await form(L.page), s: await srv(C, u) };
      await L.page.click('#dmCancel'); await sleep(1200);
      const d = { card: await btn(L.page), s: await srv(C, u), list: await listOf(L.page) };
      assert(a.card === '已登記 1 份・管理登記' && a.s.consent === 'granted' && b.card === '已登記 2 份・管理登記' && b.s.qty === 2 && c.s.consent === 'revoked' && !c.f.sub && /補貨登記仍保留/.test(c.f.msg)
        && d.card === '🔔 補貨通知我' && d.s === null && /目前沒有有效的補貨登記/.test(d.list) && L.st.errors.length === 0,
        'X9 沒有重疊：新增（含同意）、修改、撤回同意、取消照常可用，畫面與資料庫一致', JSON.stringify({ a, b, c: { s: c.s, msg: c.f.msg }, d: { card: d.card, s: d.s } }));
      await L.context.close(); });
    await setNotify(false);
    const c1 = await liveCounters(C);
    assert(JSON.stringify(c0) === JSON.stringify(c1), 'Z1 全程未建立訂單、未改額度', JSON.stringify({ c0, c1 }));
    assert(mockCalls() === 0 && realLine() === 0, 'Z2 LINE API 呼叫 0 次（模擬與真實皆為 0；登記與撤回不觸發發送）', JSON.stringify({ mock: mockCalls(), real: realLine() }));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    try { if (C) await C.s.stop(); } catch {}
    try { await browser.close(); } catch {}
    const sm = H.summary();
    if (process.env.C44_RESULT_FILE) fs.writeFileSync(process.env.C44_RESULT_FILE, JSON.stringify({ ...sm, clock_offset_ms: Number(process.env.C4_CLOCK_OFFSET_MS || 0), mock_line_calls: mockCalls(), real_line_calls: realLine() }, null, 2));
    console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed（真實 LINE 呼叫 ${realLine()} 次）`);
    process.exit(sm.failCount ? 1 : 0);
  }
})();
