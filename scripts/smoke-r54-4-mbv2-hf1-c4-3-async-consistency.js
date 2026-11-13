#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js
// R54.4／MBV2-HF1-C4.3 —— 「較早的回應覆蓋較新的操作」三項問題：真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome。
//   S：後台補貨登記設定——儲存期間的新輸入不得被儲存成功／自動更新覆蓋（有效天數、總開關、失敗、重複、正常）
//   B：後台通知批次明細——同一批次較早的成功／錯誤回應不得倒退較新的結果；切換商品／關閉／離開／隱藏／換身分後不寫入
//   M：顧客本人登記——較早的本人查詢不得在新增／修改／取消／撤回同意之後恢復舊資料；查詢或異動期間切換會員（含舊 401）
// 重疊的做法：Playwright 先讓請求「送達伺服器並取得回應」（route.fetch），再扣住回應；期間完成新的操作，最後才放行。
// 同一支測試先在未修改的 C4.2 執行（重現），再於 C4.3 執行。
// 安全：暫存資料庫、本機埠；LINE API 由 c4-line-mock（程序內攔截，不連外）＋ hf1c3-net-mock 計數；通知 worker 為實際程式。
// 模擬 LINE API、模擬 LIFF 不是 LINE 真機驗證。
'use strict';
const path = require('path');
const fs = require('fs');
(() => {
  // 與 C4 驗收相同：台北 08:00–20:00 以外時，測試程序與暫存伺服器一致位移到當日 10:30
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
try { ({ chromium } = require('playwright')); } catch { console.log('playwright not installed — 此測試需要真實瀏覽器'); process.exit(2); }

const ONLY = process.env.C43_ONLY || '';
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const STORE = 'store_001';
const PID = 701, PNAME = '測試招牌飯';     // 暫停販售：本人登記用
const PID3 = 706, PNAME3 = '測試第二暫停品';
const PN = 708, PN_NAME = '測試補貨麵';     // 通知批次用（先暫停登記、再恢復販售後預覽）
const NET_MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const LINE_MOCK = path.join(__dirname, 'lib', 'c4-line-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const MOCKDIR = H.tmpDir('c43-linemock');
const PUSH_FILE = path.join(MOCKDIR, 'real-line-attempts.txt');
const MOCK_CTRL = path.join(MOCKDIR, 'ctrl.json'), MOCK_STATE = path.join(MOCKDIR, 'state.json'), MOCK_LOG = path.join(MOCKDIR, 'calls.jsonl');
fs.writeFileSync(PUSH_FILE, ''); fs.writeFileSync(MOCK_CTRL, '{}'); fs.writeFileSync(MOCK_STATE, JSON.stringify({ accepted: {}, used: {} })); fs.writeFileSync(MOCK_LOG, '');
const realLine = () => fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
const mockCalls = () => fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twDate = (d = 0) => new Date(Date.now() + 8 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
const MS = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js'));
const session = (u) => MS.createMemberSession({ store_id: STORE, line_user_id: u });
const U = (n) => 'Uc43' + String(n).padStart(28, '0');
const UA = U(1), UB = U(2), UC = U(3), UD = U(4), UE = U(5), UF = U(6);
const TOKEN = 'test-only-channel-token-not-real-c43', LIFF = '2000000000-TestLiffC43';
const SKEY = 'line_member_session_store_001';
// 瀏覽器使用真實時間（未位移）：本機有效期限以真實時間計算
const REAL_NOW = () => Date.now() - Number(process.env.C4_CLOCK_OFFSET_MS || 0);
const sessVal = (tok) => JSON.stringify({ member_session: tok, display_name: '測試會員', is_friend: true, expires_at: REAL_NOW() + 3600e3 });

function seedAll(db) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1'); set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0'); set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654'); set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout'); set('shop_name', '脆豬腰測試店');
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
  ins(PID, PNAME, 0, 'paused'); ins(702, '測試對照湯', 1, 'available'); ins(PID3, PNAME3, 2, 'paused'); ins(PN, PN_NAME, 3, 'paused');
  for (const u of [UA, UB, UC, UD, UE, UF]) runSql('INSERT INTO line_members (store_id, line_user_id, display_name, is_friend) VALUES (?,?,?,1)', [STORE, u, '會員' + u.slice(-2)]);
}
const srvEnv = () => ({ __nodeArgs: ['-r', CLOCK, '-r', NET_MOCK, '-r', LINE_MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
  HF1C3_PUSH_COUNT_FILE: PUSH_FILE, C4_LINE_MOCK_CTRL: MOCK_CTRL, C4_LINE_MOCK_STATE: MOCK_STATE, C4_LINE_MOCK_LOG: MOCK_LOG,
  RESTOCK_NOTIFY_BACKOFF_MS: '1200,1200,1200', RESTOCK_NOTIFY_SEND_INTERVAL_MS: '5000', RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '700' });
async function boot() {
  const dir = H.tmpDir('c43'); const dbf = path.join(dir, 'pos.db');
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
// 伺服器端讀取（正式路由；資料庫為記憶體＋檔案，讀 API 即為目前伺服器狀態）
async function dbReq(C, u, pid) {
  const r = await adm(C, 'GET', `/api/product-demand-admin/products/${pid}`);
  const row = (r.json && r.json.data && r.json.data.rows || []).find((x) => x.member && u.endsWith(String(x.member).replace(/^.*?(\w{4})$/, '$1')) && x.status === 'active');
  return row || null;
}
async function mineOf(C, u) { const r = await pub(C, 'POST', '/api/product-demand/mine', { member_session: session(u) }); return (r.json && r.json.data) || []; }
async function liveCounters(C) {
  const r = await adm(C, 'GET', '/api/products/line-products/list');
  const ps = (r.json && r.json.data) || [];
  const o = await adm(C, 'GET', '/api/line-orders/online?limit=500');
  const orders = o.json && (o.json.data || o.json.orders) || [];
  return { sold: ps.map((p) => [p.id, Number(p.line_quota_sold || 0), Number(p.line_preorder_sold || 0)]), orders: Array.isArray(orders) ? orders.length : -1 };
}

// 扣住「下一個」符合條件的請求：先送達伺服器取得回應，再等待放行
function installHolder(page) {
  const H2 = { pending: [], rules: [] };
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const idx = H2.rules.findIndex((r) => r.method === req.method() && r.re.test(req.url()));
    if (idx < 0) return route.continue().catch(() => {});
    const rule = H2.rules.splice(idx, 1)[0];
    if (rule.fail) { // 不送達伺服器，直接回錯誤（儲存失敗情境）
      rule.got.resolve({ url: req.url(), body: req.postData() });
      await rule.gate; return route.fulfill({ status: rule.fail, contentType: 'application/json', body: JSON.stringify({ success: false, code: rule.fail === 401 ? 'MEMBER_SESSION_INVALID' : 'TEST_ERROR', message: '測試：伺服器錯誤' }) }).catch(() => {});
    }
    let resp; try { resp = await route.fetch(); } catch (e) { rule.got.reject(e); return; }
    const body = await resp.text();
    rule.got.resolve({ url: req.url(), status: resp.status(), body, reqBody: req.postData() });
    const how = await rule.gate;
    if (how && how.status) return route.fulfill({ status: how.status, contentType: 'application/json', body: JSON.stringify(how.body || { success: false }) }).catch(() => {});
    return route.fulfill({ response: resp, body }).catch(() => {});
  });
  return {
    hold(method, re, opts = {}) {
      let gres, gotRes, gotRej; const gate = new Promise((r) => { gres = r; });
      const got = new Promise((a, b) => { gotRes = a; gotRej = b; });
      const rule = { method, re, gate, got: { resolve: gotRes, reject: gotRej }, fail: opts.fail || 0 };
      H2.rules.push(rule);
      return { got, release: (how) => gres(how || null), cancel: () => { const i = H2.rules.indexOf(rule); if (i >= 0) H2.rules.splice(i, 1); gres(null); } };
    },
  };
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C4.3 非同步一致性（舊回應不得覆蓋新操作）驗收 ══════════');
  console.log('時鐘位移（毫秒）：' + process.env.C4_CLOCK_OFFSET_MS);
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  let C;
  try {
    C = await boot();
    const c0 = await liveCounters(C);

    // ═════════════════ S：後台設定 ═════════════════
    if (run('s') || run('b')) {
      const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await actx.addInitScript(([t]) => {
        if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); sessionStorage.setItem('__seeded', '1'); }
      }, [C.tok]);
      const ap = await actx.newPage();
      const errs = []; ap.on('pageerror', (e) => errs.push(e.message)); ap.on('dialog', (d) => d.accept());
      const HD = installHolder(ap);
      await ap.goto(C.s.base + '/');
      await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function');
      await ap.evaluate(() => showPage('line_products')); await sleep(800);
      await ap.evaluate(() => lpmSwitchTab('demand'));
      await ap.waitForSelector(`#pd-row-${PID}`, { timeout: 10000 });
      const refresh = async () => { await ap.evaluate(() => { pdAutoRefreshNow('test'); return null; }); await sleep(1500); };
      const cfgDb = async () => (await adm(C, 'GET', '/api/product-demand-admin/summary')).json.data.config;
      const ui = () => ap.evaluate(() => ({ ttl: document.getElementById('pd-set-ttl').value, en: document.getElementById('pd-set-enabled').checked }));
      const clickSave = () => ap.evaluate(() => { saveDemandSettings(); return null; });
      const typeTtl = async (v) => { await ap.fill('#pd-set-ttl', String(v)); await ap.evaluate(() => document.getElementById('pd-set-ttl').blur()); };

      if (run('s')) {
        // S1 有效天數：45 儲存中（伺服器已寫入、回應扣住）→ 改成 60 並移開焦點 → 放行 → 自動更新
        await typeTtl(45);
        let h = HD.hold('PATCH', /\/api\/product-demand-admin\/settings$/);
        await clickSave();
        const sent1 = await withTimeout(h.got, 8000, 'S1 PATCH');
        await typeTtl(60);
        h.release(); await sleep(800); await refresh(); await refresh();
        const db1 = await cfgDb(); const u1 = await ui();
        assert(JSON.parse(sent1.reqBody).ttl_days === 45 && db1.ttl_days === 45 && u1.ttl === '60', 'S1 儲存 45 天期間改為 60：資料庫 45 天、畫面保留尚未儲存的 60 天（儲存成功與自動更新都不覆蓋）', JSON.stringify({ sent: sent1.reqBody, db: db1.ttl_days, ui: u1 }));
        await sleep(10500);
        assert((await ui()).ttl === '60', 'S1-2 下一輪 10 秒自動更新仍保留 60（未儲存狀態保留）', JSON.stringify(await ui()));
        await clickSave(); await sleep(1200); await refresh();
        const db1b = await cfgDb();
        assert(db1b.ttl_days === 60 && (await ui()).ttl === '60', 'S1-3 再次儲存後資料庫才變成 60 天', JSON.stringify({ db: db1b.ttl_days, ui: await ui() }));
        // S2 總開關：儲存（開啟）期間取消勾選 → 放行 → 自動更新不改回勾選；再儲存才關閉
        h = HD.hold('PATCH', /\/api\/product-demand-admin\/settings$/);
        await clickSave(); await withTimeout(h.got, 8000, 'S2 PATCH');
        await ap.click('#pd-set-enabled'); await ap.evaluate(() => document.getElementById('pd-set-enabled').blur()); // 取消勾選（未儲存），焦點移開
        h.release(); await sleep(800); await refresh(); await refresh();
        const db2 = await cfgDb(); const u2 = await ui();
        assert(db2.enabled === true && u2.en === false, 'S2 儲存期間改動總開關：資料庫仍為開啟、畫面保留尚未儲存的「關閉」', JSON.stringify({ db: db2.enabled, ui: u2 }));
        await clickSave(); await sleep(1200); await refresh();
        const db2b = await cfgDb();
        assert(db2b.enabled === false && (await ui()).en === false, 'S2-2 再次儲存後才關閉', JSON.stringify({ db: db2b.enabled, ui: await ui() }));
        await ap.click('#pd-set-enabled'); await clickSave(); await sleep(1200); await refresh();
        // S3 儲存失敗：輸入保留、未儲存狀態保留、資料庫不變
        await typeTtl(33);
        h = HD.hold('PATCH', /\/api\/product-demand-admin\/settings$/, { fail: 500 });
        await clickSave(); await withTimeout(h.got, 8000, 'S3 PATCH'); h.release(); await sleep(800);
        await refresh(); await refresh();
        const db3 = await cfgDb(); const u3 = await ui();
        assert(db3.ttl_days === 60 && u3.ttl === '33', 'S3 儲存失敗：資料庫不變（60）、畫面保留 33，自動更新不覆蓋', JSON.stringify({ db: db3.ttl_days, ui: u3 }));
        // S4 正常儲存（沒有後續編輯）：儲存後未儲存狀態清除，之後伺服器變更會正常反映
        await clickSave(); await sleep(1200); await refresh();
        const db4 = await cfgDb();
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: 41 }); // 另一位管理者變更
        await refresh(); await refresh();
        const u4 = await ui();
        assert(db4.ttl_days === 33 && u4.ttl === '41' && u4.en === true, 'S4 正常儲存後未儲存狀態清除：之後的伺服器變更（41 天）由自動更新正常反映', JSON.stringify({ db4: db4.ttl_days, ui: u4 }));
        // S5 重複操作：連按兩次儲存（第一個回應扣住），期間無新編輯 → 兩次完成後狀態清除
        await typeTtl(52);
        h = HD.hold('PATCH', /\/api\/product-demand-admin\/settings$/);
        await clickSave(); await withTimeout(h.got, 8000, 'S5 PATCH#1');
        await clickSave(); await sleep(800);
        h.release(); await sleep(1000); await refresh();
        const db5 = await cfgDb();
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: 47 });
        await refresh(); await refresh();
        const u5 = await ui();
        assert(db5.ttl_days === 52 && u5.ttl === '47', 'S5 連按兩次儲存（第一個回應晚到）：資料庫 52；完成後不殘留未儲存狀態（之後的 47 正常反映）', JSON.stringify({ db5: db5.ttl_days, ui: u5 }));
        // S6 重複操作＋後續編輯：第一次儲存 52→55 期間改 58，第二次儲存 58 先完成，第一次回應晚到 → 資料庫 58、畫面 58、狀態已清除
        await typeTtl(55);
        h = HD.hold('PATCH', /\/api\/product-demand-admin\/settings$/);
        await clickSave(); await withTimeout(h.got, 8000, 'S6 PATCH#1');
        await typeTtl(58); await clickSave(); await sleep(1200);
        h.release(); await sleep(1000); await refresh(); await refresh();
        const db6 = await cfgDb(); const u6 = await ui();
        assert(u6.ttl === '58', 'S6 較早的儲存回應晚到：不把畫面改回 55（顯示最後一次送出的 58）', JSON.stringify({ db: db6.ttl_days, ui: u6 }));
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: 30 });
        await refresh(); await refresh();
        assert((await ui()).ttl === '30', 'S6-2 最後一次儲存完成後狀態已清除，之後的伺服器變更正常反映', JSON.stringify(await ui()));
        // S7 焦點與輪詢保護仍有效：輸入框有焦點時不覆蓋
        await ap.focus('#pd-set-ttl'); await ap.fill('#pd-set-ttl', '29');
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: 31 });
        await ap.evaluate(() => { pdAutoRefreshNow('test'); return null; }); await sleep(1500);
        const f7 = await ap.evaluate(() => ({ v: document.getElementById('pd-set-ttl').value, f: document.activeElement && document.activeElement.id }));
        assert(f7.v === '29' && f7.f === 'pd-set-ttl', 'S7 編輯中（有焦點）時自動更新不覆蓋、不搶走焦點', JSON.stringify(f7));
        await ap.evaluate(() => document.getElementById('pd-set-ttl').blur());
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: 30 });
        await ap.fill('#pd-set-ttl', '30'); await clickSave(); await sleep(1200);
      }

      // ═════════════════ B：通知批次明細 ═════════════════
      if (run('b')) {
        // 準備：兩位會員同意通知 → 恢復販售 → 預覽 → 確認（實際 worker；第二位在 5 秒間隔內維持「待發送」）
        await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
        const ra = await reg(C, UE, PN, 1, { notify_consent: true }); const rb = await reg(C, UF, PN, 1, { notify_consent: true });
        if (!(ra.json && ra.json.success && rb.json && rb.json.success)) throw new Error('B seed reg ' + ra.text.slice(0, 200) + rb.text.slice(0, 200));
        await adm(C, 'PATCH', `/api/products/${PN}/line-settings`, { sale_status: 'available' });
        const sup = twDate(0);
        const pv = await adm(C, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PN, fulfillment_mode: 'takeout', supply_date: sup });
        if (!(pv.json && pv.json.success)) throw new Error('preview ' + pv.text.slice(0, 300));
        const uuid = pv.json.data.batch_uuid || (pv.json.data.batch && pv.json.data.batch.batch_uuid);
        await ap.evaluate((id) => { openDemandDetail(id); return null; }, PN); await sleep(1500);
        const mc0 = mockCalls();
        const cf = await adm(C, 'POST', `/api/product-demand-admin/restock/batches/${uuid}/confirm`, {});
        if (!(cf.json && cf.json.success)) throw new Error('confirm ' + cf.text.slice(0, 300));
        await ap.evaluate(() => { pdAutoRefreshNow('test'); return null; });
        await ap.waitForSelector(`.rn-batch[data-batch="${uuid}"]`, { timeout: 8000 });
        const detailTxt = () => ap.evaluate((id) => { const el = document.getElementById('rn-detail-' + id); return el ? el.innerText.replace(/\s+/g, ' ') : null; }, uuid);
        const clickDetail = () => ap.evaluate((id) => { const b = document.querySelector(`.rn-batch[data-batch="${id}"] [data-act="detail"]`); if (b) b.click(); return !!b; }, uuid);
        const reDet = new RegExp(`/restock/batches/${uuid}$`);
        // B1 舊的「待發送」回應扣住 → 批次經 worker 發送完成 → 新明細先顯示「LINE 已受理」→ 放行舊回應
        let h1 = HD.hold('GET', reDet);
        await clickDetail();
        const old1 = await withTimeout(h1.got, 8000, 'B1 old detail');
        const oldHasPending = /"status":"(pending|sending)"/.test(old1.body);
        const end = Date.now() + 20000; let done = null;
        while (Date.now() < end) { const d = (await adm(C, 'GET', `/api/product-demand-admin/restock/batches/${uuid}`)).json.data; if (d.status !== 'sending' && !d.running) { done = d; break; } await sleep(300); }
        await clickDetail(); await sleep(1200);
        const newTxt = await detailTxt();
        h1.release(); await sleep(1200);
        const afterTxt = await detailTxt();
        const accepted = (t) => ((t || '').match(/LINE 已受理/g) || []).length;
        assert(oldHasPending && done && done.deliveries.every((x) => x.status === 'accepted') && accepted(newTxt) === 2, 'B1-前提 舊回應含「待發送」；worker 經程序內 LINE 攔截完成，新明細顯示 2 筆 LINE 已受理', JSON.stringify({ oldHasPending, st: done && done.deliveries.map((x) => x.status), newTxt: (newTxt || '').slice(0, 160) }));
        assert(accepted(afterTxt) === 2 && !/待發送|發送中/.test(afterTxt || ''), 'B1 較早的「待發送」回應晚到：不把明細倒退回待發送', (afterTxt || '').slice(0, 200));
        // B2 舊的錯誤回應晚到：不覆蓋較新的成功結果
        let h2 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h2.got, 8000, 'B2 old');
        await clickDetail(); await sleep(1200);
        h2.release({ status: 500, body: { success: false, message: '測試：舊請求失敗' } }); await sleep(1200);
        const t2 = await detailTxt();
        assert(accepted(t2) === 2 && !/舊請求失敗/.test(t2 || ''), 'B2 較早的錯誤回應晚到：不覆蓋較新的成功明細', (t2 || '').slice(0, 200));
        // B3 背景（自動更新）與手動查詢共用判斷：手動新回應已套用後，背景舊回應晚到不覆蓋
        let h3 = HD.hold('GET', reDet);
        await ap.evaluate((id) => { restockBatchDetail(id, true); return null; }, uuid); await withTimeout(h3.got, 8000, 'B3 quiet');
        await clickDetail(); await sleep(1200);
        h3.release({ status: 500, body: { success: false, message: '測試：背景舊請求失敗' } }); await sleep(1000);
        const t3 = await detailTxt();
        assert(accepted(t3) === 2, 'B3 背景舊查詢晚到（失敗）：不改變較新的手動結果', (t3 || '').slice(0, 160));
        // 準備另一個「舊回應」：以第一次的舊快照內容（含待發送）回放，模擬各種生命週期改變後才返回
        const replayOld = (hh) => hh.release({ status: 200, body: JSON.parse(old1.body) });
        // B4 切換商品後舊回應返回
        let h4 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h4.got, 8000, 'B4');
        await ap.evaluate((id) => { openDemandDetail(id); return null; }, PID); await sleep(1200);
        replayOld(h4); await sleep(1000);
        const b4 = await ap.evaluate(() => ({ pid: (document.getElementById('rn-panel') || {}).dataset ? document.getElementById('rn-panel').dataset.pid : null, txt: (document.getElementById('lpm-demand-detail') || {}).innerText || '' }));
        assert(b4.pid === String(PID) && !/待發送/.test(b4.txt), 'B4 切換商品後，舊批次明細回應不寫入新商品面板', JSON.stringify({ pid: b4.pid, t: b4.txt.slice(0, 120) }));
        // 回到 PN 並展開明細
        await ap.evaluate((id) => { openDemandDetail(id); return null; }, PN); await sleep(1500);
        await clickDetail(); await sleep(1200);
        // B5 關閉明細後舊回應返回
        let h5 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h5.got, 8000, 'B5');
        await ap.evaluate(() => { closeDemandDetail(); return null; }); await sleep(300);
        replayOld(h5); await sleep(1000);
        const b5 = await ap.evaluate(() => { const b = document.getElementById('lpm-demand-detail'); return { vis: b && b.style.display !== 'none', html: b ? b.innerHTML.length : 0 }; });
        assert(!b5.vis && b5.html === 0, 'B5 關閉明細後，舊回應不重新打開或寫入', JSON.stringify(b5));
        // B6 離開分頁後舊回應返回；回來時明細為最新
        await ap.evaluate((id) => { openDemandDetail(id); return null; }, PN); await sleep(1500);
        await clickDetail(); await sleep(1200);
        let h6 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h6.got, 8000, 'B6');
        await ap.evaluate(() => lpmSwitchTab('today')); await sleep(300);
        replayOld(h6); await sleep(1000);
        const t6hidden = await detailTxt();
        await ap.evaluate(() => lpmSwitchTab('demand')); await sleep(2500);
        const t6 = await detailTxt();
        assert(!/待發送/.test(t6hidden || '') && accepted(t6) === 2 && !/待發送/.test(t6 || ''), 'B6 離開分頁後舊回應返回：不寫入；回到分頁仍為最新（2 筆已受理）', JSON.stringify({ hidden: (t6hidden || '').slice(0, 80), back: (t6 || '').slice(0, 120) }));
        // B7 頁面隱藏後舊回應返回
        let h7 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h7.got, 8000, 'B7');
        await ap.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
        replayOld(h7); await sleep(1000);
        const t7 = await detailTxt();
        await ap.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
        await sleep(2500);
        const t7b = await detailTxt();
        assert(!/待發送/.test(t7 || '') && accepted(t7b) === 2, 'B7 頁面隱藏後舊回應返回：不寫入；恢復可見後為最新', JSON.stringify({ hidden: (t7 || '').slice(0, 80), back: (t7b || '').slice(0, 80) }));
        // B8 更換登入身分（同店另一個有效 token）期間舊回應返回：不寫入
        let h8 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h8.got, 8000, 'B8');
        const tok2 = await H.login(C.s.base, STORE, 'pw001');
        await ap.evaluate((t) => localStorage.setItem('pos_store_token', t), tok2 + '');
        replayOld(h8); await sleep(1000);
        const t8 = await detailTxt();
        assert(!/待發送/.test(t8 || ''), 'B8 登入身分改變後，上一個身分發出的舊回應不寫入', (t8 || '').slice(0, 120));
        await ap.evaluate((t) => localStorage.setItem('pos_store_token', t), C.tok);
        // B9 保持：取餐方式、日期、預覽、展開狀態、焦點、捲動
        await ap.evaluate(() => { pdAutoRefreshNow('test'); return null; }); await sleep(2500);
        await ap.evaluate((id) => { openDemandDetail(id); return null; }, PN); await sleep(1500);
        await ap.selectOption('#rn-mode', 'delivery').catch(() => {}); await ap.fill('#rn-date', twDate(1)).catch(() => {});
        await ap.evaluate(() => { const b = document.getElementById('rn-preview-btn'); if (b) b.click(); }); await ap.waitForSelector('#rn-preview-box', { timeout: 8000 }).catch(() => {});
        await clickDetail(); await sleep(1200);
        let h9 = HD.hold('GET', reDet);
        await clickDetail(); await withTimeout(h9.got, 8000, 'B9');
        await clickDetail(); await sleep(1000);
        await ap.focus('#rn-date').catch(() => {});
        const s0 = await ap.evaluate(() => ({ mode: document.getElementById('rn-mode').value, date: document.getElementById('rn-date').value, pv: (document.getElementById('rn-preview-box') || {}).innerHTML || '', f: document.activeElement && document.activeElement.id, y: Math.round((document.scrollingElement || document.body).scrollTop) }));
        replayOld(h9); await sleep(1200);
        const s1 = await ap.evaluate(() => ({ mode: document.getElementById('rn-mode').value, date: document.getElementById('rn-date').value, pv: (document.getElementById('rn-preview-box') || {}).innerHTML || '', f: document.activeElement && document.activeElement.id, y: Math.round((document.scrollingElement || document.body).scrollTop) }));
        const t9 = await detailTxt();
        assert(s1.mode === 'delivery' && s1.date === s0.date && s0.pv.length > 0 && s1.pv === s0.pv && s1.f === 'rn-date' && s1.y === s0.y && accepted(t9) === 2, 'B9 舊回應返回時：取餐方式、日期、預覽、展開明細、焦點、捲動保持，且明細不倒退', JSON.stringify({ s0: { ...s0, pv: s0.pv.length }, s1: { ...s1, pv: s1.pv.length } }));
        const del = (await adm(C, 'GET', `/api/product-demand-admin/restock/batches/${uuid}`)).json.data.deliveries;
        await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false }); // 回到預設關閉
        assert(mockCalls() - mc0 === 2 && del.every((x) => x.status === 'accepted' && x.attempt_count === 1), 'B10 發送規則不變：模擬 LINE 呼叫 2 次、每位 1 次嘗試、皆已受理（明細查詢不觸發發送）', JSON.stringify({ calls: mockCalls() - mc0, del: del.map((x) => [x.status, x.attempt_count]) }));
      }
      assert(errs.length === 0, 'S/B 後台頁面無 JavaScript 錯誤', errs.join(' | '));
      await actx.close();
    }

    // ═════════════════ M：顧客本人登記 ═════════════════
    if (run('m')) {
      async function openP(member) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([sk, sv]) => { if (!sessionStorage.getItem('__seeded')) { if (sv) localStorage.setItem(sk, sv); sessionStorage.setItem('__seeded', '1'); } }, [SKEY, member ? sessVal(session(member)) : '']);
        const page = await context.newPage();
        const st = { errors: [], reqs: [] }; page.on('pageerror', (e) => st.errors.push(e.message));
        page.on('request', (r) => { if (/product-demand|line-member/.test(r.url())) st.reqs.push(r.method() + ' ' + r.url().replace(C.s.base, '')); });

        const HD = installHolder(page);
        await page.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(`#dr-${PID} button.demand-btn`, { timeout: 15000 });
        await sleep(1200);
        return { context, page, st, HD };
      }
      const btnOf = (page, pid = PID) => page.evaluate((id) => { const b = document.querySelector(`#dr-${id} button.demand-btn`); return b ? b.textContent : null; }, pid);
      const sheetOpen = (page) => page.evaluate(() => !!document.getElementById('demandOverlay')?.classList.contains('show'));
      const closeSheet = (page) => page.evaluate(() => { if (typeof _closeDemandSheetQuiet === 'function') _closeDemandSheetQuiet(); return null; });
      const reMine = /\/api\/product-demand\/mine/;
      // 本人資料背景重新查詢：以頁首「📋 我的補貨登記」觸發（正式 UI 路徑），查詢回應扣住
      async function startHeldMine(L) {
        const h = L.HD.hold('POST', reMine);
        await L.page.evaluate(() => { document.getElementById('myDemandsBtn').click(); return null; });
        let got;
        try { got = await withTimeout(h.got, 8000, 'mine'); }
        catch (e) { const dbg = await L.page.evaluate(() => ({ disp: getComputedStyle(document.getElementById('myDemandsBtn')).display, idok: typeof _pdIdentityOk !== 'undefined' ? _pdIdentityOk : null, st: typeof _pdMineState !== 'undefined' ? _pdMineState : null, open: document.getElementById('demandOverlay')?.classList.contains('show'), panel: (document.getElementById('demandPanel') || {}).innerText })); console.log('DEBUG mine', JSON.stringify(dbg), JSON.stringify(L.st)); throw e; }
        return { h, got };
      }
      // M1 取消：A 有 2 份 → 開啟清單（查詢扣住，舊快照含 2 份）→ 進入管理取消（正式 API 成功）→ 放行舊查詢
      await reg(C, UA, PID, 2);
      { const L = await openP(UA);
        const { h, got } = await startHeldMine(L);
        const snapHas2 = /"desired_qty":2/.test(got.body);
        await L.page.waitForSelector('.dm-manage-btn', { timeout: 5000 });
        await L.page.click('.dm-manage-btn'); await L.page.waitForSelector('#dmCancel', { timeout: 5000 });
        await L.page.click('#dmCancel'); await sleep(1200);
        const mid = await btnOf(L.page);
        const dbRow = (await mineOf(C, UA)).find((x) => x.product_id === PID);
        h.release(); await sleep(2000);
        const after = await btnOf(L.page);
        await L.page.evaluate(() => { document.getElementById('myDemandsBtn').click(); return null; }); await sleep(1500);
        const list = await L.page.evaluate(() => document.getElementById('demandPanel').innerText);
        assert(snapHas2 && mid === '補貨登記' && !dbRow, 'M1-前提 舊快照含 2 份；取消 API 成功（資料庫無有效登記），畫面先移除', JSON.stringify({ snapHas2, mid, dbRow: !!dbRow }));
        assert(after === '補貨登記' && !/已登記/.test(after || '') && /目前沒有有效的補貨登記/.test(list), 'M1 取消後舊查詢晚到：商品卡不恢復「已登記 2 份」，清單也沒有該登記', JSON.stringify({ after, list: list.slice(0, 120) }));
        await L.context.close(); }
      // M2 新增：B 無登記 → 查詢扣住（舊快照無登記）→ 新增 3 份 → 放行
      { const L = await openP(UB);
        const { h, got } = await startHeldMine(L);
        await closeSheet(L.page);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmSubmit', { timeout: 8000 });
        await L.page.evaluate(() => { const p = document.querySelector('#dmQty, .dm-qty input'); return null; });
        await L.page.click('#dmPlus').catch(() => {}); await L.page.click('#dmPlus').catch(() => {});
        await L.page.click('#dmSubmit'); await sleep(1200);
        const mid = await btnOf(L.page);
        h.release(); await sleep(2000);
        const after = await btnOf(L.page);
        const row = (await mineOf(C, UB)).find((x) => x.product_id === PID);
        assert(!/"product_id":701/.test(got.body) && row && row.desired_qty === 3 && mid === '已登記 3 份・管理登記' && after === '已登記 3 份・管理登記', 'M2 新增後舊查詢（無登記）晚到：資料庫 3 份、商品卡維持「已登記 3 份」', JSON.stringify({ mid, after, db: row && row.desired_qty }));
        await L.context.close(); }
      // M3 修改份數：B 3 份 → 查詢扣住（舊快照 3 份）→ 改為 5 份 → 放行
      { const L = await openP(UB);
        const { h, got } = await startHeldMine(L);
        await closeSheet(L.page);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmSubmit', { timeout: 8000 });
        await L.page.click('#dmPlus'); await L.page.click('#dmPlus');
        await L.page.click('#dmSubmit'); await sleep(1200);
        const mid = await btnOf(L.page);
        h.release(); await sleep(2000);
        const after = await btnOf(L.page);
        const row = (await mineOf(C, UB)).find((x) => x.product_id === PID);
        assert(/"desired_qty":3/.test(got.body) && row && row.desired_qty === 5 && mid === '已登記 5 份・管理登記' && after === '已登記 5 份・管理登記', 'M3 修改份數後舊查詢（3 份）晚到：資料庫 5 份、商品卡維持 5 份', JSON.stringify({ mid, after, db: row && row.desired_qty }));
        await L.context.close(); }
      // M4 撤回通知同意：通知可用；C 已同意 → 查詢扣住（舊快照為已同意）→ 撤回 → 放行 → 不恢復「已訂閱」
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      await reg(C, UC, PID, 1, { notify_consent: true });
      { const L = await openP(UC);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmRevoke', { timeout: 8000 });
        const before = await L.page.evaluate(() => !!document.getElementById('dmSubscribed'));
        await closeSheet(L.page);
        const { h, got } = await startHeldMine(L);
        await closeSheet(L.page);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmRevoke', { timeout: 8000 });
        await L.page.click('#dmRevoke'); await sleep(1000);
        const mid = await L.page.evaluate(() => !!document.getElementById('dmSubscribed'));
        await closeSheet(L.page);
        h.release(); await sleep(2000);
        await L.page.click(`#dr-${PID} button.demand-btn`); await sleep(800);
        const after = await L.page.evaluate(() => ({ sub: !!document.getElementById('dmSubscribed'), revoke: !!document.getElementById('dmRevoke'), checked: (document.getElementById('dmConsent') || {}).checked }));
        const row = (await mineOf(C, UC)).find((x) => x.product_id === PID);
        assert(before && /"notify_consent":"granted"/.test(got.body) && !mid && row && row.notify_consent === 'revoked' && !after.sub && !after.revoke && after.checked === false,
          'M4 撤回通知同意後舊查詢（已同意）晚到：資料庫已撤回、畫面不恢復「已訂閱補貨通知」', JSON.stringify({ before, mid, after, db: row && row.notify_consent }));
        await L.context.close(); }
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      // M5 查詢期間切換會員，舊會員回應為 401：不得把目前會員標成登入過期、不得顯示舊會員資料
      await reg(C, UD, PID, 4);
      { const L = await openP(UD);
        const { h } = await startHeldMine(L);
        await closeSheet(L.page);
        await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(session(UB))]);
        h.release({ status: 401, body: { success: false, code: 'MEMBER_SESSION_INVALID', message: 'expired' } }); await sleep(2500);
        await L.page.evaluate(() => { window.dispatchEvent(new Event('focus')); return null; }); await sleep(1800);
        const btn = await btnOf(L.page);
        await L.page.click(`#dr-${PID} button.demand-btn`); await sleep(1000);
        const txt = await L.page.evaluate(() => document.getElementById('demandPanel').innerText);
        assert(btn === '已登記 5 份・管理登記' && !/過期|重新以 LINE 登入/.test(txt) && !/4 份/.test(txt), 'M5 查詢期間切換會員、舊會員回應 401：目前會員（5 份）正常，未被標成登入過期，不顯示舊會員 4 份', JSON.stringify({ btn, txt: txt.slice(0, 160) }));
        await L.context.close(); }
      // M6 取消期間切換會員，舊會員的取消回應為 401（伺服器未處理）：目前會員不受影響（不等焦點事件，立即檢查）
      { const L = await openP(UD);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmCancel', { timeout: 8000 });
        const h = L.HD.hold('POST', /\/api\/product-demand\/cancel/, { fail: 401 });
        await L.page.click('#dmCancel'); await withTimeout(h.got, 8000, 'M6 cancel');
        await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(session(UB))]);
        h.release(); await sleep(1500);
        await closeSheet(L.page);
        await L.page.click(`#dr-${PID} button.demand-btn`); await sleep(2000);
        const txt = await L.page.evaluate(() => document.getElementById('demandPanel').innerText);
        const btn = await btnOf(L.page);
        const dRow = (await mineOf(C, UD)).find((x) => x.product_id === PID);
        assert(!/過期|重新以 LINE 登入/.test(txt) && /已登記 5 份/.test(txt) && btn === '已登記 5 份・管理登記' && dRow && dRow.desired_qty === 4, 'M6 取消期間切換會員、舊會員取消回應 401：目前會員不被標成登入過期，顯示自己的 5 份（舊會員登記未被取消）', JSON.stringify({ btn, d: dRow && dRow.desired_qty, txt: txt.slice(0, 160) }));
        await L.context.close(); }
      // M7 異動期間切換會員，舊會員的成功回應：不寫入目前會員資料
      { const L = await openP(UD);
        await L.page.click(`#dr-${PID} button.demand-btn`); await L.page.waitForSelector('#dmSubmit', { timeout: 8000 });
        await L.page.click('#dmPlus');
        const h = L.HD.hold('POST', /\/api\/product-demand\/register/);
        await L.page.click('#dmSubmit'); await withTimeout(h.got, 8000, 'M7 register');
        await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(session(UB))]);
        h.release(); await sleep(1500);
        await closeSheet(L.page);
        await L.page.evaluate(() => { window.dispatchEvent(new Event('focus')); return null; }); await sleep(1800);
        const btn = await btnOf(L.page);
        const dRow = (await mineOf(C, UD)).find((x) => x.product_id === PID);
        assert(btn === '已登記 5 份・管理登記' && dRow && dRow.desired_qty === 5, 'M7 異動期間切換會員、舊會員異動成功回應：目前會員仍顯示自己的 5 份（舊會員資料庫已更新為 5）', JSON.stringify({ btn, d: dRow && dRow.desired_qty }));
        await L.context.close(); }
      // M8 正常查詢與管理仍可用
      { const L = await openP(UB);
        const b0 = await btnOf(L.page);
        await L.page.evaluate(() => { document.getElementById('myDemandsBtn').click(); return null; }); await sleep(1500);
        const list = await L.page.evaluate(() => document.getElementById('demandPanel').innerText);
        await L.page.click('.dm-manage-btn'); await L.page.waitForSelector('#dmSubmit', { timeout: 5000 });
        await L.page.click('#dmMinus'); await L.page.click('#dmSubmit'); await sleep(1200);
        const b1 = await btnOf(L.page);
        const row = (await mineOf(C, UB)).find((x) => x.product_id === PID);
        assert(b0 === '已登記 5 份・管理登記' && /測試招牌飯/.test(list) && b1 === '已登記 4 份・管理登記' && row.desired_qty === 4 && L.st.errors.length === 0, 'M8 正常查詢、清單與管理（改為 4 份）照常可用、無 JavaScript 錯誤', JSON.stringify({ b0, b1, db: row.desired_qty, e: L.st.errors }));
        await L.context.close(); }
    }
    const c1 = await liveCounters(C);
    assert(JSON.stringify(c0) === JSON.stringify(c1), 'Z1 全程未建立訂單、未改額度', JSON.stringify({ c0, c1 }));
    assert(realLine() === 0, 'Z2 真實 LINE API 呼叫 0 次（全部由程序內模擬攔截）', String(realLine()));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    try { if (C) await C.s.stop(); } catch {}
    try { await browser.close(); } catch {}
    const sm = H.summary();
    if (process.env.C43_RESULT_FILE) fs.writeFileSync(process.env.C43_RESULT_FILE, JSON.stringify({ ...sm, clock_offset_ms: Number(process.env.C4_CLOCK_OFFSET_MS || 0), mock_line_calls: mockCalls(), real_line_calls: realLine() }, null, 2));
    console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed（模擬 LINE 呼叫 ${mockCalls()} 次；真實 0 次需為 0：${realLine()}）`);
    process.exit(sm.failCount ? 1 : 0);
  }
})();
