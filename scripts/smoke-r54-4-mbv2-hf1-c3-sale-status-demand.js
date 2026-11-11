#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js
// R54.4／MBV2-HF1-C3 —— 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）驗收：
//   S：販售狀態一致性（4 種人工狀態 × 尚未開賣／販售中／販售結束 × 外帶／外送 × 兩種頁面模式）、
//      重新整理、局部更新、最新商品資料載入、舊購物車還原、原始 can_next_day=true 注入
//   O：今日完售今日／未來訂單、暫停／長期下架任何日期阻擋、未來時段驗證、送單期間改停售的交易內重驗與回滾
//   D：想買登記 API（新增、重複、修改、取消、過期、跨會員／跨店、隱藏商品、額度與訂單不變）
//   U：想買登記畫面（文案、遮罩、事件不冒泡、手機窄版／三欄、詳情入口、通知模式文案）
//   B：MBV2 完整／選擇性備份與匯入（關聯、同意狀態、舊備份不清空、推播 0 次）
//   A：後台想買登記分頁
//
// 安全規則：只使用 os.tmpdir() 下的暫存資料庫與本機隨機埠；外部網路一律由
// scripts/lib/hf1c3-net-mock.js 攔截（LINE API 呼叫會被計數）。不連正式站、不發 LINE 推播。
// 測試商品為測試自建資料（PID/名稱只存在於暫存資料庫），正式程式碼不含任何商品硬編碼。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('playwright not installed — 此測試需要真實瀏覽器，無法執行（未以其他方式代替）');
  process.exit(2);
}
const ONLY = process.env.HF1C3_ONLY || ''; // s,o,d,u,b,a（預設全部）
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const PID = 701;               // 測試商品（暫存資料庫內）
const PNAME = '測試招牌飯';
const PID2 = 702;              // 對照商品（正常販售）
const MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const PUSH_FILE = path.join(H.tmpDir('hf1c3-push'), 'line-calls.txt');
fs.writeFileSync(PUSH_FILE, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function twNowParts(offsetMin = 0) {
  const d = new Date(Date.now() + 8 * 3600e3 + offsetMin * 60e3);
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function twDate(offsetDays = 0) { return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10); }
let ms; // lineMemberSession（與伺服器相同的預設 JWT_SECRET）
try { ms = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js')); } catch { ms = null; }
const session = (store, uid) => ms.createMemberSession({ store_id: store, line_user_id: uid });

function seedLine(db, opts = {}) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql(`INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001',?,?)`, [k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1');
  set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0');
  set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654');
  set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', opts.pageMode || 'combined_checkout');
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_quota_low_threshold: 'INTEGER DEFAULT 2', line_quota_high_threshold: 'INTEGER DEFAULT 10',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_preorder_low_threshold: 'INTEGER DEFAULT 2', line_preorder_high_threshold: 'INTEGER DEFAULT 10',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1',
    shipping_enabled: 'INTEGER DEFAULT 0', shipping_share_line_stock: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const pid = opts.pid || PID;
  runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
        line_quota_enabled,line_quota_daily,line_quota_sold,line_quota_low_threshold,line_quota_high_threshold,
        line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_preorder_low_threshold,line_preorder_high_threshold,
        line_takeout_enabled,line_delivery_enabled,shipping_enabled,shipping_share_line_stock)
       VALUES (?,?,?,?,?,?,1,1,'available',0, 1,10,0,2,10, 1,20,0,2,10, 1,1,0,1)`, [pid, 'store_001', PNAME, '飯類', 101, 150]);
  runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
        line_quota_enabled,line_preorder_enabled,line_takeout_enabled,line_delivery_enabled)
       VALUES (?,?,?,?,?,?,1,1,'available',1, 0,0,1,1)`, [opts.pid2 || PID2, 'store_001', '測試對照湯', '飯類', 101, 60]);
  // 隱藏商品（不得因登記功能重新曝光）
  runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status) VALUES (703,'store_001','測試隱藏A','飯類',101,10,0,1,'paused')`);
  runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status) VALUES (704,'store_001','測試隱藏B','飯類',101,10,1,0,'paused')`);
  runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,line_takeout_enabled,line_delivery_enabled) VALUES (705,'store_001','測試隱藏C','飯類',101,10,1,1,'paused',0,0)`);
}
async function bootServer(dir, opts = {}) {
  const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedLine(db, opts); if (opts.extraSeed) opts.extraSeed(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf, { __nodeArgs: ['-r', MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', HF1C3_PUSH_COUNT_FILE: PUSH_FILE, ...(opts.env || {}) });
  const tok = await H.login(s.base, 'store_001', 'pw001');
  return { s, dbf, tok, dir, opts };
}
// 已被 SIGTERM 結束的子程序 exitCode 為 null（signalCode 有值）；harness 的 stop() 對它會一直等 exit 事件
async function safeStop(srv) { const p = srv && srv.proc; if (p && p.exitCode == null && p.signalCode == null) await srv.stop(); }
async function restart(ctx, mutate) {
  await safeStop(ctx.s);
  if (mutate) { const db = await H.openDbFile(ctx.dbf); mutate(db); H.saveDbFile(db, ctx.dbf); db.close(); }
  ctx.s = await H.startServer(ctx.dbf, { __nodeArgs: ['-r', MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', HF1C3_PUSH_COUNT_FILE: PUSH_FILE, ...((ctx.opts && ctx.opts.env) || {}) });
  ctx.tok = await H.login(ctx.s.base, 'store_001', 'pw001');
}
async function dbRows(dbf, sql, params) { const db = await H.openDbFile(dbf); const r = H.q(db, sql, params); db.close(); return r; }
async function patchProduct(ctx, body, pid = PID) {
  const r = await H.api(ctx.s.base, ctx.tok, 'PATCH', `/api/products/${pid}/line-settings`, body);
  if (!r.json || !r.json.success) throw new Error('patch failed ' + r.text.slice(0, 200));
}
async function pub(ctx, method, p, body, store = 'store_001') {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${ctx.s.base}${p}${sep}store_id=${store}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// 伺服器記憶體中的狀態（送單／登記後）以 API 讀取：商品額度、訂單筆數
async function liveCounters(ctx) {
  const r = await H.api(ctx.s.base, ctx.tok, 'GET', '/api/products/line-products/list');
  const p = (r.json && r.json.data || []).find((x) => Number(x.id) === PID) || {};
  const o = await H.api(ctx.s.base, ctx.tok, 'GET', '/api/line-orders/online?limit=500');
  const orders = o.json && (o.json.data || o.json.orders) || [];
  return { quota_sold: Number(p.line_quota_sold || 0), preorder_sold: Number(p.line_preorder_sold || 0), orders: Array.isArray(orders) ? orders.length : -1 };
}

async function openLinePage(browser, ctx, { savedCart, mode = 'takeout', pickupDate, viewport, member, routes } = {}) {
  const context = await browser.newContext({ viewport: viewport || { width: 390, height: 860 } });
  await context.addInitScript(([k, v, mk, mv]) => {
    if (sessionStorage.getItem('__seeded')) return;
    if (v) localStorage.setItem(k, v);
    if (mv) localStorage.setItem(mk, mv);
    sessionStorage.setItem('__seeded', '1');
  }, ['line_order_cart_store_001', savedCart ? JSON.stringify({
    version: 1, store_id: 'store_001', cart_created_at: Date.now() - 3600e3, cart_updated_at: Date.now() - 3600e3,
    cart: savedCart, order_mode: mode, customer: { name: '', phone: '' }, coupon_code: '',
    pickup_date: pickupDate || twDate(0), pickup_time: '', payment_method: '', order_note: '',
  }) : '', 'line_member_session_store_001', member ? JSON.stringify({ member_session: member, display_name: '測試會員', is_friend: true, expires_at: Date.now() + 3600e3 }) : '']);
  const page = await context.newPage();
  if (routes) await routes(page);
  const dialogs = []; const errors = []; const posts = []; const events = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch {} });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const u = req.url();
    if (u.includes('/api/analytics/events')) { try { events.push(JSON.parse(req.postData() || '{}')); } catch {} return; }
    posts.push(u);
  });
  await page.goto(`${ctx.s.base}/line-order.html?store_id=store_001`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof allProducts !== 'undefined' && Array.isArray(allProducts) && allProducts.length > 0, null, { timeout: 20000 });
  await page.waitForSelector(`#pc-${PID}`, { timeout: 20000 }).catch(() => {});
  await sleep(900);
  return { context, page, dialogs, errors, posts, events };
}
const evNames = (events) => events.map((e) => e.event_name || e.event || '').filter(Boolean);

// 商品卡／詳情／實際加購三者的狀態（C2 與 C3 皆可執行；不依賴 C3 新函式）
async function cardState(page, pid = PID) {
  return page.evaluate((id) => {
    const p = allProducts.find((x) => x.id == id); const card = document.getElementById('pc-' + id);
    if (!card || !p) return { present: false };
    const status = (card.querySelector('.status-row') || {}).innerText || '';
    const plusEnabled = !!card.querySelector('.add-btn') || !!Array.from(card.querySelectorAll('.qty-ctrl .plus')).find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const inc = checkCartIncrement(id, p, 1);
    let detail = null;
    try {
      openProductDetail(id);
      const b = document.querySelector('.pdm-add-btn'); const d = document.querySelector('.pdm-demand-btn');
      detail = { disabled: b ? b.disabled : null, text: b ? b.textContent : '', demand: d ? d.textContent : null };
      ProductDetailModal.close();
    } catch (e) { detail = { err: e.message }; }
    const demandBtn = card.querySelector('.demand-btn');
    return { present: true, status, plusEnabled, incOk: !!inc.ok, incBucket: inc.bucket || null, incMsg: inc.message || '', detail,
      demand: demandBtn ? demandBtn.textContent : null, qty: (cart[id] ? cart[id].qty : 0),
      raw: { tn: p.takeout_can_next_day, dn: p.delivery_can_next_day, tr: p.takeout_sold_out_reason, dr: p.delivery_sold_out_reason, ss: p.sale_status } };
  }, pid);
}
const LABEL = { available: null, sold_out_today: '今日完售', paused: '暫停販售', sold_out_indefinitely: '長期下架' };
function checkManualExpect(name, st, ss) {
  const consistent = st.plusEnabled === st.incOk && st.detail && st.detail.disabled === !st.incOk;
  assert(consistent, `${name} 商品卡＋／詳情加入／實際加購三者一致`, JSON.stringify({ plus: st.plusEnabled, inc: st.incOk, detail: st.detail && st.detail.disabled, status: st.status, raw: st.raw }));
  if (ss === 'paused' || ss === 'sold_out_indefinitely') {
    assert(st.status.includes(LABEL[ss]) && !/可預購|可預約/.test(st.status) && !st.plusEnabled && !st.incOk && st.detail.disabled === true,
      `${name} ${LABEL[ss]}：標示正確、無「可預購／可預約」、無可用＋、詳情停用、實際不可加購`, JSON.stringify({ status: st.status, plus: st.plusEnabled, inc: st.incMsg, detail: st.detail }));
  } else if (ss === 'sold_out_today') {
    assert(st.status.includes('今日完售') && /可預購/.test(st.status) && st.plusEnabled && st.incOk && st.incBucket === 'preorder' && st.detail.disabled === false,
      `${name} 今日完售：標示今日完售＋可預購，＋與詳情可用且使用預購額度`, JSON.stringify({ status: st.status, plus: st.plusEnabled, inc: [st.incOk, st.incBucket, st.incMsg], detail: st.detail }));
  }
}

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C3 販售狀態一致性＋想買登記 驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const shots = process.env.HF1C3_SHOT_DIR || H.tmpDir('hf1c3-shots');
  const ctxs = [];
  const now = twNowParts();
  const today = twDate(0), tomorrow = twDate(1);
  try {
    // ═════════════════ S：販售狀態一致性 ═════════════════
    if (run('s')) {
      const phases = [];
      const ns = twNowParts(90); if (ns.date === now.date) phases.push({ k: 'not_started', body: { line_sell_start: ns.hhmm, line_sell_end: '' } });
      else console.log('  ⚠️ 尚未開賣情境略過：現在時間 +90 分鐘跨日（' + now.hhmm + '）');
      phases.push({ k: 'selling', body: { line_sell_start: '', line_sell_end: '' } });
      const ed = twNowParts(-1); if (ed.date === now.date) phases.push({ k: 'ended', body: { line_sell_start: '', line_sell_end: ed.hhmm } });
      else console.log('  ⚠️ 販售結束情境略過：現在時間 −1 分鐘跨日（' + now.hhmm + '）');
      for (const pageMode of ['combined_checkout', 'fulfillment_switcher']) {
        const dir = H.tmpDir('hf1c3-s'); const C = await bootServer(dir, { pageMode }); ctxs.push(C);
        for (const ph of phases) {
          for (const ss of ['available', 'sold_out_today', 'paused', 'sold_out_indefinitely']) {
            await patchProduct(C, { ...ph.body, sale_status: ss, line_quota_sold: 0 });
            // 後端：人工停售的原始次日旗標必須為 false；今日完售可預約
            const menu = await pub(C, 'GET', '/api/line-menu');
            const mp = (menu.json && menu.json.data.products || []).find((x) => x.id === PID) || {};
            if (ss === 'paused' || ss === 'sold_out_indefinitely') {
              assert(mp.takeout_can_next_day === false && mp.delivery_can_next_day === false, `S-API ${pageMode}/${ph.k}/${ss} /api/line-menu 停售商品 can_next_day=false`, JSON.stringify({ t: mp.takeout_can_next_day, d: mp.delivery_can_next_day, r: mp.takeout_sold_out_reason }));
            } else if (ss === 'sold_out_today') {
              assert(mp.takeout_can_next_day === true && mp.delivery_can_next_day === true, `S-API ${pageMode}/${ph.k}/${ss} /api/line-menu 今日完售可預約未來日期`, JSON.stringify({ t: mp.takeout_can_next_day, d: mp.delivery_can_next_day }));
            }
            for (const mode of ['takeout', 'delivery']) {
              const L = await openLinePage(browser, C, {});
              await L.page.evaluate((m) => { selectFulfillmentMode(m); }, mode); await sleep(700);
              const st = await cardState(L.page);
              const name = `S ${pageMode}/${ph.k}/${mode}/${ss}`;
              assert(st.present, `${name} 商品卡存在`, '');
              if (st.present) checkManualExpect(name, st, ss);
              if (ss !== 'available' && st.present) {
                const wantDemand = ss !== 'sold_out_today';
                assert(wantDemand ? st.demand === '我想買' : st.demand === null, `${name} 想買登記入口${wantDemand ? '顯示' : '不顯示（今日完售仍可預購）'}`, String(st.demand));
              }
              assert(L.errors.length === 0, `${name} 頁面無 JavaScript 錯誤`, L.errors.join(' | '));
              await L.context.close();
            }
          }
        }
        await patchProduct(C, { line_sell_start: '', line_sell_end: '', sale_status: 'available' });
        await safeStop(C.s);
      }

      // 重新整理／局部更新／最新商品資料載入／舊購物車還原（長期下架＋時段結束＋原始 can_next_day 注入）
      const dir = H.tmpDir('hf1c3-s2'); const C = await bootServer(dir, { pageMode: 'combined_checkout' }); ctxs.push(C);
      const ed2 = twNowParts(-1);
      const endedBody = ed2.date === now.date ? { line_sell_end: ed2.hhmm } : { line_quota_sold: 10 }; // 跨日時改用「今日份數用完」製造原始次日旗標
      for (const ss of ['sold_out_indefinitely', 'paused']) {
        await patchProduct(C, { ...endedBody, sale_status: ss });
        const L = await openLinePage(browser, C, { savedCart: { [PID]: 2 }, pickupDate: today });
        let st = await cardState(L.page);
        assert(st.qty === 2 && !st.plusEnabled && !st.incOk && !/可預購/.test(st.status), `S2-1-${ss} 舊購物車還原 2 份：無可用＋、無可預購`, JSON.stringify(st));
        // 前端不信任原始次日旗標：直接把 can_next_day 改成 true 後重繪
        await L.page.evaluate((id) => { const p = allProducts.find((x) => x.id == id); p.takeout_can_next_day = true; p.delivery_can_next_day = true; p.takeout_sold_out_reason = p.takeout_sold_out_reason || 'product_time_ended'; p.delivery_sold_out_reason = p.delivery_sold_out_reason || 'product_time_ended'; renderMenu(); }, PID);
        st = await cardState(L.page);
        checkManualExpect(`S2-2-${ss} 原始 can_next_day=true＋時段結束（注入）`, st, ss);
        const minusBefore = st.qty;
        await L.page.evaluate((id) => chgQty(id, -1), PID); // 局部更新
        st = await cardState(L.page);
        assert(st.qty === minusBefore - 1 && !st.plusEnabled, `S2-3-${ss} 局部更新（減少）後仍無可用＋`, JSON.stringify({ qty: st.qty, plus: st.plusEnabled }));
        await L.page.evaluate((id) => chgQty(id, 1), PID);
        assert((await cardState(L.page)).qty === minusBefore - 1, `S2-4-${ss} 增加被阻擋（只能減少／移除）`, L.dialogs.slice(-1)[0] || '');
        // 最新商品資料載入（購物車同步）後局部更新
        await L.page.evaluate(async () => { await refreshCartProductsFromLatestMenu(); });
        await L.page.evaluate((id) => updateProductCard(id), PID);
        st = await cardState(L.page);
        assert(!st.plusEnabled && !st.incOk, `S2-5-${ss} 載入最新商品資料後局部更新：仍一致不可加購`, JSON.stringify(st));
        await L.page.reload({ waitUntil: 'domcontentloaded' }); await L.page.waitForSelector(`#pc-${PID}`); await sleep(900);
        st = await cardState(L.page);
        assert(!st.plusEnabled && !st.incOk && !/可預購/.test(st.status) && st.status.includes(LABEL[ss]), `S2-6-${ss} 重新整理後仍一致`, JSON.stringify(st));
        await L.page.evaluate((id) => chgQty(id, -1), PID);
        const stored = await L.page.evaluate(() => JSON.parse(localStorage.getItem('line_order_cart_store_001') || '{}').cart || {});
        assert((await cardState(L.page)).qty === 0 && !stored[PID], `S2-7-${ss} 可移除，保存的購物車同步移除`, JSON.stringify(stored));
        assert(L.errors.length === 0, `S2-8-${ss} 頁面無 JavaScript 錯誤`, L.errors.join(' | '));
        await L.context.close();
      }
      // 開著頁面時商品被改為長期下架：最新商品資料載入後，購物車＋與商品卡局部更新一致
      await patchProduct(C, { sale_status: 'available', line_sell_end: '', line_quota_sold: 0 });
      {
        const L = await openLinePage(browser, C, {});
        await L.page.click(`#pc-${PID} .add-btn`); await sleep(300);
        await patchProduct(C, { sale_status: 'sold_out_indefinitely' });
        await L.page.evaluate(() => openCartSheet()); await sleep(1200); // 開購物車 → 同步最新商品資料
        await L.page.click('#cartItems .qty-ctrl .plus'); await sleep(200);
        await L.page.evaluate(() => closeSheet('cartSheet')); await sleep(300);
        await L.page.evaluate((id) => updateProductCard(id), PID);
        const st = await cardState(L.page);
        assert(st.qty === 1 && !st.plusEnabled && !st.incOk && /長期下架/.test(L.dialogs.slice(-1)[0] || ''), 'S3-1 頁面開啟中改為長期下架：同步後購物車＋被擋、商品卡無可用＋', JSON.stringify({ qty: st.qty, plus: st.plusEnabled, d: L.dialogs }));
        await L.context.close();
      }
      // 今日完售（瀏覽器）：加入後自動導向下個營業日；改成今天送出被既有日期防呆攔下；正常送出扣預購
      await patchProduct(C, { sale_status: 'sold_out_today', line_quota_sold: 0, line_preorder_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20 });
      {
        const L = await openLinePage(browser, C, {});
        await L.page.click(`#pc-${PID} .add-btn`); await sleep(300);
        await L.page.evaluate(() => openCartSheet()); await sleep(1200);
        const d1 = await L.page.$eval('#pDate', (e) => e.value);
        assert(d1 === tomorrow && (await cardState(L.page)).qty === 1, 'S4-1 今日完售加入購物車：取餐日期自動改為下個營業日', d1);
        await L.page.evaluate((d) => { const s = document.getElementById('pDate'); const o = document.createElement('option'); o.value = d; o.textContent = 'today(test)'; s.insertBefore(o, s.firstChild); s.value = d; }, today);
        await L.page.evaluate(() => _enterCheckoutStage()); await sleep(200);
        await L.page.fill('#cName', '測試顧客'); await L.page.fill('#cPhone', '0912345678');
        await L.page.evaluate(() => { const b = document.querySelector('#payBtns .pay-btn[data-code="cash"]'); if (b) b.click(); });
        await sleep(300);
        const before = await liveCounters(C);
        await L.page.click('#subBtn'); await sleep(1500);
        const mid = await liveCounters(C);
        const d2 = await L.page.$eval('#pDate', (e) => e.value);
        assert(mid.orders === before.orders && d2 === tomorrow, 'S4-2 改成今天送出：既有日期防呆攔下，未建立訂單並導回下個營業日', `orders ${before.orders}->${mid.orders} pDate=${d2}`);
        await L.page.waitForFunction(() => { const t = document.getElementById('pTime'); return t && Array.from(t.options).some((o) => o.value && !o.disabled); }, null, { timeout: 10000 });
        const resp = L.page.waitForResponse((x) => /\/api\/line-orders(\?|$)/.test(x.url()) && x.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
        await L.page.click('#subBtn');
        const rr = await resp; await sleep(800);
        const after = await liveCounters(C);
        assert(rr && rr.status() === 200 && after.orders === before.orders + 1 && after.preorder_sold === before.preorder_sold + 1 && after.quota_sold === before.quota_sold,
          'S4-3 確認明天送出：成功，扣預購 1、今日額度不變', JSON.stringify({ st: rr && rr.status(), before, after }));
        assert(L.errors.length === 0, 'S4-4 頁面無 JavaScript 錯誤', L.errors.join(' | '));
        await L.context.close();
      }
      await safeStop(C.s);
    }

    // ═════════════════ O：訂單（今日完售未來預購／停售阻擋／交易內重驗） ═════════════════
    if (run('o')) {
      const dir = H.tmpDir('hf1c3-o'); const C = await bootServer(dir, {}); ctxs.push(C);
      const order = (o) => pub(C, 'POST', '/api/line-orders', {
        customer_name: '測試顧客', customer_phone: '0912345678', order_type: o.type || 'takeout',
        pickup_date: o.date, pickup_time: o.time || '12:00', payment_method: 'cash',
        items: [{ product_id: PID, qty: o.qty || 1, name: PNAME, price: 150 }],
        ...(o.type === 'delivery' ? { delivery_address: '台北市信義區市府路1號', delivery_lat: 25.0375, delivery_lng: 121.5637 } : {}),
      });
      await patchProduct(C, { sale_status: 'sold_out_today' });
      let before = await liveCounters(C);
      let r = await order({ date: today });
      let after = await liveCounters(C);
      assert(r.status === 400 && after.orders === before.orders && after.quota_sold === before.quota_sold, 'O1 今日完售：今日訂單被擋，未建立訂單、未扣今日額度', `status=${r.status} msg=${r.json && r.json.message} reason=${r.json && r.json.reason}`);
      before = after;
      r = await order({ date: tomorrow, qty: 3 });
      after = await liveCounters(C);
      assert(r.status === 200 && after.orders === before.orders + 1, 'O2 今日完售：合法未來日期訂單成功（1 筆）', `status=${r.status} msg=${r.json && r.json.message}`);
      assert(after.preorder_sold === before.preorder_sold + 3 && after.quota_sold === before.quota_sold, 'O3 今日完售未來訂單扣預購額度 3、今日額度不變（伺服器即時值）', JSON.stringify({ before, after }));
      await safeStop(C.s); // 讀資料庫確認
      const prow = (await dbRows(C.dbf, 'SELECT sale_status,line_quota_sold,line_preorder_sold FROM products WHERE id=?', [PID]))[0];
      const ordRow = (await dbRows(C.dbf, "SELECT pickup_time,line_counter_bucket FROM orders WHERE store_id='store_001' AND items LIKE ? ORDER BY rowid DESC LIMIT 1", ['%' + PID + '%']))[0] || {};
      assert(Number(prow.line_preorder_sold) === 3 && Number(prow.line_quota_sold) === 0 && prow.sale_status === 'sold_out_today' && ordRow.line_counter_bucket === 'preorder' && String(ordRow.pickup_time).startsWith(tomorrow),
        'O4 讀資料庫：預購已售 3、今日已售 0、商品仍為今日完售（未改寫 sale_status）、訂單為預購且日期為明天', JSON.stringify({ prow, ordRow }));
      await restart(C);
      r = await order({ date: tomorrow, time: '23:59' });
      assert(r.status === 403 && r.json && r.json.reason === 'pickup_time_outside_hours', 'O5 未來訂單取餐時間超出該日營業時段 → 拒絕', `status=${r.status} reason=${r.json && r.json.reason}`);
      for (const ss of ['paused', 'sold_out_indefinitely']) {
        await patchProduct(C, { sale_status: ss });
        before = await liveCounters(C);
        const a = await order({ date: today }); const b = await order({ date: tomorrow });
        after = await liveCounters(C);
        assert(a.status === 400 && b.status === 400 && after.orders === before.orders && after.preorder_sold === before.preorder_sold && after.quota_sold === before.quota_sold,
          `O6-${ss} 今日與未來日期都被擋，訂單與額度不變`, `${a.status}/${b.status} ${b.json && b.json.message}`);
      }
      // 交易內重驗：送單期間（外送距離查詢中）商品被改成暫停／長期下架 → 整筆回滾
      await safeStop(C.s);
      C.opts.env = { HF1C3_ROUTES_DELAY_MS: '1500' };
      await restart(C);
      for (const ss of ['paused', 'sold_out_indefinitely']) {
        await patchProduct(C, { sale_status: 'sold_out_today' });
        before = await liveCounters(C);
        const p = order({ type: 'delivery', date: tomorrow, qty: 2 });
        await sleep(500);
        await patchProduct(C, { sale_status: ss });
        r = await p;
        after = await liveCounters(C);
        assert(r.status === 400 && r.json && r.json.reason === 'product_not_available' && after.orders === before.orders && after.preorder_sold === before.preorder_sold && after.quota_sold === before.quota_sold,
          `O7-${ss} 送單期間改為停售：交易內重驗阻擋，訂單與額度完整回滾`, `status=${r.status} reason=${r.json && r.json.reason} ${JSON.stringify({ before, after })}`);
      }
      // 對照：同一流程不改狀態 → 成功（證明時間窗確實落在 BEGIN 前驗證之後）
      await patchProduct(C, { sale_status: 'sold_out_today' });
      before = await liveCounters(C);
      r = await order({ type: 'delivery', date: tomorrow, qty: 1 });
      after = await liveCounters(C);
      assert(r.status === 200 && after.preorder_sold === before.preorder_sold + 1, 'O8 對照：外送未來訂單（今日完售）不改狀態時成功並扣預購 1', `status=${r.status} ${r.json && r.json.message}`);
      // 未啟用預購份數管理：不得當成禁止預購（沿用既有未限額規則）
      await patchProduct(C, { sale_status: 'sold_out_today', line_preorder_enabled: 0 });
      before = await liveCounters(C);
      const rToday = await order({ date: today });
      r = await order({ date: tomorrow, qty: 30 });
      after = await liveCounters(C);
      // 既有規則：預購已售欄位在 line_preorder_daily>0 時仍記帳（不作為上限）；今日額度不得被扣
      assert(rToday.status === 400 && r.status === 200 && after.orders === before.orders + 1 && after.quota_sold === before.quota_sold,
        'O9 今日完售＋未啟用預購份數管理：今日仍擋；未來 30 份（超過原預購每日 20）不限額成功，今日額度不變', `${rToday.status}/${r.status} ${JSON.stringify({ before, after })}`);
      await patchProduct(C, { line_preorder_enabled: 1 });
      await safeStop(C.s);
    }

    // ═════════════════ D：想買登記 API ═════════════════
    if (run('d')) {
      const dir = H.tmpDir('hf1c3-d'); const C = await bootServer(dir, {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'paused' });
      const A = session('store_001', 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
      const B = session('store_001', 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbb02');
      const X2 = session('store_002', 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
      const counters0 = await liveCounters(C);
      const summary = async () => { const r = await H.api(C.s.base, C.tok, 'GET', '/api/product-demand-admin/summary'); return (r.json.data.products || []).find((p) => p.product_id === PID) || {}; };
      let r = await pub(C, 'GET', '/api/product-demand/config');
      assert(r.json && r.json.data.enabled === true && r.json.data.notify_available === false && r.json.data.max_qty === 99, 'D1 config：開放登記、通知不可用（後端判定）、上限 99', JSON.stringify(r.json && r.json.data));
      r = await pub(C, 'POST', '/api/product-demand/register', { product_id: PID, desired_qty: 2 });
      assert(r.status === 401, 'D2 未登入（無 member_session）不可登記', String(r.status));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: 'forged.sig', product_id: PID, desired_qty: 2 });
      assert(r.status === 401, 'D3 偽造 member_session 不可登記', String(r.status));
      const reqs = await Promise.all(Array.from({ length: 5 }, () => pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 2, line_user_id: 'Uevil' })));
      const outcomes = reqs.map((x) => x.json && x.json.data && x.json.data.outcome);
      let s1 = await summary();
      assert(reqs.every((x) => x.status === 200) && outcomes.filter((o) => o === 'created').length === 1 && s1.active_users === 1 && s1.total_qty === 2,
        'D4 同時重複送出 5 次：只建立 1 筆，人數 1、總份數 2（不累加）', JSON.stringify({ outcomes, s1 }));
      r = await pub(C, 'POST', '/api/product-demand/mine', { member_session: A });
      assert(r.json && r.json.data.length === 1 && r.json.data[0].desired_qty === 2 && r.json.data[0].fulfillment_pref === 'any', 'D5 本人查詢：1 筆、2 份、取餐偏好預設「都可以」', JSON.stringify(r.json && r.json.data));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 5, fulfillment_pref: 'takeout' });
      s1 = await summary();
      assert(r.json && r.json.data.outcome === 'updated' && s1.active_users === 1 && s1.total_qty === 5, 'D6 修改為 5 份：更新原筆，總份數 5（不是 7）', JSON.stringify({ o: r.json && r.json.data.outcome, s1 }));
      const bad = [];
      for (const q of [0, 100, 1.5, '3a', -1, null]) { const x = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: q }); bad.push(`${JSON.stringify(q)}:${x.status}`); }
      assert(bad.every((b) => b.endsWith(':400')), 'D7 份數非 1～99 正整數一律 400', bad.join(' '));
      await patchProduct(C, { line_delivery_enabled: 0 });
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 1, fulfillment_pref: 'delivery' });
      const r2 = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 1, fulfillment_pref: 'any' });
      assert(r.status === 400 && r2.status === 400, 'D8 取餐偏好只能選商品支援的方式（僅外帶商品不可選外送／都可以）', `${r.status}/${r2.status}`);
      await patchProduct(C, { line_delivery_enabled: 1 });
      const hidden = [];
      for (const hp of [703, 704, 705, 999999]) { const x = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: hp, desired_qty: 1 }); hidden.push(`${hp}:${x.status}`); }
      assert(hidden.every((h) => h.endsWith(':404')), 'D9 enabled=0／show_on_line=0／外帶外送皆停用／不存在的商品不可登記', hidden.join(' '));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: B, product_id: PID, desired_qty: 3, fulfillment_pref: 'delivery' });
      s1 = await summary();
      assert(r.status === 200 && s1.active_users === 2 && s1.total_qty === 8, 'D10 第二位會員登記 3 份：人數 2、總份數 8', JSON.stringify(s1));
      const aMine = (await pub(C, 'POST', '/api/product-demand/mine', { member_session: A })).json.data;
      const bMine = (await pub(C, 'POST', '/api/product-demand/mine', { member_session: B })).json.data;
      r = await pub(C, 'POST', '/api/product-demand/cancel', { member_session: B, request_id: aMine[0].request_id });
      assert(aMine.length === 1 && bMine.length === 1 && aMine[0].request_id !== bMine[0].request_id && r.status === 404, 'D11 會員只看得到自己的登記；不可取消他人的登記', `${aMine.length}/${bMine.length} cancelOther=${r.status}`);
      r = await pub(C, 'POST', '/api/product-demand/mine', { member_session: X2 });
      const r3 = await pub(C, 'POST', '/api/product-demand/mine', { member_session: X2 }, 'store_002');
      const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
      const s2 = await H.api(C.s.base, tok2, 'GET', '/api/product-demand-admin/summary');
      const leak = JSON.stringify(s2.json || {}).includes(PNAME);
      const cross = await H.api(C.s.base, tok2, 'GET', `/api/product-demand-admin/products/${PID}`);
      // store_002 未授權 LINE 點餐（featureGate 403）或授權但無資料（200 空）皆屬隔離；重點是 session 不可跨店、資料不外洩
      assert(r.status === 401 && (r3.status === 403 || (r3.status === 200 && r3.json.data.length === 0)) && !leak && (cross.status === 403 || cross.status === 404),
        'D12 跨店：store_002 的 session 不可用於 store_001；store_002 讀不到 store_001 商品與登記', `${r.status}/${r3.status} leak=${leak} cross=${cross.status}`);
      const adm1 = await H.api(C.s.base, C.tok, 'GET', `/api/product-demand-admin/products/${PID}?store_id=store_002`, undefined, { 'x-store-id': 'store_002' });
      assert(adm1.status === 200 && adm1.json.data.rows.length === 2, 'D13 後台 store_id 只信任 JWT（query／header 帶其他店無效）', String(adm1.status));
      const evil = await dbRowsLive(C, "SELECT COUNT(*) AS c FROM product_demand_requests WHERE line_user_id='Uevil'");
      assert(evil === 0, 'D14 body 夾帶 line_user_id 被忽略（身分只來自 member_session）', String(evil));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 5, fulfillment_pref: 'takeout', notify_consent: true });
      const consents = await dbRowsLive(C, 'SELECT COUNT(*) AS c FROM product_demand_consents');
      assert(r.json && r.json.data.consent_outcome === 'notify_unavailable' && consents === 0 && r.json.data.request.notify_consent === 'none', 'D15 通知未接通時送出同意 → 不建立同意紀錄、回報通知不可用', JSON.stringify(r.json && r.json.data));
      r = await pub(C, 'POST', '/api/product-demand/cancel', { member_session: A, product_id: PID });
      s1 = await summary();
      assert(r.status === 200 && s1.active_users === 1 && s1.total_qty === 3, 'D16 取消後統計排除：人數 1、總份數 3', JSON.stringify(s1));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 1 });
      const aRows = await dbRowsLiveAll(C, "SELECT status,cycle_no FROM product_demand_requests WHERE line_user_id='Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01' ORDER BY id");
      assert(r.json.data.outcome === 'created' && aRows.length === 2 && aRows[0].status === 'cancelled' && aRows[1].status === 'active' && aRows[1].cycle_no === 2, 'D17 取消後再次登記：開新週期（cycle 2），舊筆保留為已取消', JSON.stringify(aRows));
      // 過期：停機改 expires_at 為過去 → 重啟
      await restart(C, (db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 minute') WHERE line_user_id='Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbb02'"));
      s1 = await summary();
      const bAfter = (await pub(C, 'POST', '/api/product-demand/mine', { member_session: B })).json.data;
      const det = (await H.api(C.s.base, C.tok, 'GET', `/api/product-demand-admin/products/${PID}`)).json.data;
      assert(s1.active_users === 1 && s1.total_qty === 1 && bAfter.length === 0 && det.rows.some((x) => x.status === 'expired'), 'D18 過期登記：統計排除、本人查詢不顯示、後台明細標示已過期', JSON.stringify({ s1, bAfter: bAfter.length }));
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: B, product_id: PID, desired_qty: 4 });
      const bRows = await dbRowsLiveAll(C, "SELECT status,cycle_no FROM product_demand_requests WHERE line_user_id='Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbb02' ORDER BY id");
      assert(r.json.data.outcome === 'created' && bRows.length === 2 && bRows[0].status === 'expired' && bRows[1].cycle_no === 2, 'D19 過期後重新登記：舊筆轉為 expired、新週期 1 筆', JSON.stringify(bRows));
      // 商品關閉收集／功能關閉
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID}/collect`, { enabled: false });
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 1 });
      const menuP = (await pub(C, 'GET', '/api/line-menu')).json.data.products.find((x) => x.id === PID);
      assert(r.status === 403 && menuP && Number(menuP.demand_collect_enabled) === 0, 'D20 店家關閉該商品需求收集 → 登記 403，/menu 回報 demand_collect_enabled=0', `${r.status}`);
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID}/collect`, { enabled: true });
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: false });
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 1 });
      const cfgOff = (await pub(C, 'GET', '/api/product-demand/config')).json.data;
      assert(r.status === 403 && cfgOff.enabled === false, 'D21 功能開關關閉 → config.enabled=false、登記 403', `${r.status}`);
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: true });
      // 長期下架＋公開顯示 → 允許登記；今日完售／正常亦允許（後端不以商品狀態阻擋，入口顯示由前台規則決定）
      await patchProduct(C, { sale_status: 'sold_out_indefinitely' });
      r = await pub(C, 'POST', '/api/product-demand/register', { member_session: B, product_id: PID, desired_qty: 6 });
      assert(r.status === 200 && r.json.data.outcome === 'updated', 'D22 長期下架且公開顯示：允許登記（更新原筆）', String(r.status));
      const counters1 = await liveCounters(C);
      assert(counters1.orders === counters0.orders && counters1.quota_sold === counters0.quota_sold && counters1.preorder_sold === counters0.preorder_sold,
        'D23 登記／修改／取消前後：訂單筆數、今日已售、預購已售皆不變', JSON.stringify({ counters0, counters1 }));
      await safeStop(C.s);
      const orderRows = await dbRows(C.dbf, "SELECT COUNT(*) AS c FROM orders WHERE store_id='store_001' AND items LIKE ?", ['%' + PID + '%']);
      assert(Number(orderRows[0].c) === 0, 'D24 讀資料庫：未建立任何含測試商品的訂單', String(orderRows[0].c));
    }

    // ═════════════════ U：想買登記畫面 ═════════════════
    if (run('u')) {
      const dir = H.tmpDir('hf1c3-u'); const C = await bootServer(dir, {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'paused' });
      const A = session('store_001', 'Uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu01');
      // 未登入：表單提供 LINE 登入，不建立任何資料
      {
        const L = await openLinePage(browser, C, {});
        const btnTxt = await L.page.textContent(`#pc-${PID} .demand-btn`).catch(() => null);
        assert(btnTxt === '我想買', 'U1 暫停販售商品卡顯示「我想買」', String(btnTxt));
        await L.page.click(`#pc-${PID} .demand-btn`); await sleep(400);
        const vis = await L.page.evaluate(() => ({ ov: document.getElementById('demandOverlay')?.classList.contains('show'), pdm: ProductDetailModal.isOpen(), login: !!document.getElementById('dmLoginBtn'), title: document.getElementById('dmTitle')?.textContent }));
        assert(vis.ov && !vis.pdm && vis.login && vis.title === '這款商品，你想買幾份？', 'U2 未登入點擊：開啟登記表單（未開商品詳情），要求 LINE 登入', JSON.stringify(vis));
        await L.context.close();
      }
      for (const vp of [{ w: 390, h: 860, cols: 2, tag: 'mobile' }, { w: 1280, h: 900, cols: 3, tag: 'desktop3col' }]) {
        const L = await openLinePage(browser, C, { member: A, viewport: { width: vp.w, height: vp.h } });
        await sleep(600);
        const geo = await L.page.evaluate((id) => {
          const card = document.getElementById('pc-' + id); const b = card.querySelector('.demand-btn');
          b.scrollIntoView({ block: 'center' });
          const cr = card.getBoundingClientRect(); const br = b.getBoundingClientRect();
          const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
          const cols = getComputedStyle(document.querySelector('#menuArea .grid')).gridTemplateColumns.split(' ').length;
          return { inside: br.left >= cr.left - 0.5 && br.right <= cr.right + 0.5 && br.bottom <= cr.bottom + 0.5 && br.top >= cr.top, hitIsBtn: hit === b, cols, h: br.height, w: br.width };
        }, PID);
        assert(geo.cols === vp.cols && geo.inside && geo.hitIsBtn && geo.h >= 28, `U3-${vp.tag} ${vp.cols} 欄商品卡：按鈕在卡片內、未被遮罩擋住（可點中心）`, JSON.stringify(geo));
        await L.page.screenshot({ path: path.join(shots, `u3-${vp.tag}.png`) });
        await L.context.close();
      }
      {
        const L = await openLinePage(browser, C, { member: A });
        const evBefore = L.events.length; const postBefore = L.posts.length;
        await L.page.click(`#pc-${PID} .demand-btn`); await sleep(500);
        const ui = await L.page.evaluate(() => ({
          pdm: ProductDetailModal.isOpen(), title: document.getElementById('dmTitle')?.textContent,
          desc: Array.from(document.querySelectorAll('#demandPanel .dm-desc')).map((e) => e.textContent),
          submit: document.getElementById('dmSubmit')?.textContent, disc: document.getElementById('dmDisclaimer')?.textContent,
          consent: !!document.getElementById('dmConsent'), prefs: Array.from(document.querySelectorAll('input[name=dmPref]')).map((i) => i.value),
          cart: Object.keys(cart).length, text: document.getElementById('demandPanel').innerText,
        }));
        assert(!ui.pdm && ui.title === '這款商品，你想買幾份？' && ui.desc[0] === '留下想買的數量，讓我們安排備貨。目前僅提供想買登記，尚不會發送補貨通知。' && ui.submit === '送出登記' && ui.disc === '登記不代表訂單成立，也不保留商品，實際供應以訂購時為準。' && !ui.consent,
          'U4 登記模式文案正確（標題／說明／送出／免責），無通知同意選項', JSON.stringify(ui));
        assert(!/補貨通知我|立即|已排程|已發送|通知已啟用/.test(ui.text) && JSON.stringify(ui.prefs) === '["takeout","delivery","any"]', 'U5 未出現通知承諾或「立即」字樣；取餐偏好僅列商品支援方式', JSON.stringify(ui.prefs));
        await L.page.click('#dmPlus'); await sleep(100);
        // 快速雙擊送出
        await L.page.evaluate(() => { const b = document.getElementById('dmSubmit'); b.click(); b.click(); });
        await sleep(1200);
        const toastTxt = await L.page.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
        const cardBtn = await L.page.textContent(`#pc-${PID} .demand-btn`);
        assert(/已收到你的想買登記，謝謝！/.test(toastTxt) && cardBtn === '已登記 2 份・管理登記', 'U6 送出成功：提示文案正確，商品卡改為「已登記 2 份・管理登記」', `${toastTxt} | ${cardBtn}`);
        const rows = await dbRowsLiveAll(C, 'SELECT desired_qty,status FROM product_demand_requests');
        assert(rows.length === 1 && rows[0].desired_qty === 2, 'U7 快速雙擊送出只產生 1 筆登記', JSON.stringify(rows));
        await sleep(600);
        const names = evNames(L.events.slice(evBefore));
        const posts = L.posts.slice(postBefore);
        assert(!names.some((n) => /add_to_cart|view_item|purchase|submit_order|checkout/.test(n)) && !posts.some((u) => /\/api\/line-orders(\?|$)/.test(u)) && (await L.page.evaluate(() => Object.keys(cart).length)) === 0,
          'U8 登記點擊不觸發加購／商品詳情／購買事件，不送單、不加入購物車', JSON.stringify({ names, posts }));
        await L.page.reload({ waitUntil: 'domcontentloaded' }); await L.page.waitForSelector(`#pc-${PID}`); await sleep(1200);
        const afterReload = await L.page.textContent(`#pc-${PID} .demand-btn`);
        assert(afterReload === '已登記 2 份・管理登記', 'U9 重新整理後仍顯示「已登記 2 份・管理登記」', afterReload);
        // 詳情入口
        await L.page.evaluate((id) => openProductDetail(id), PID); await sleep(300);
        const det = await L.page.evaluate(() => ({ add: document.querySelector('.pdm-add-btn')?.disabled, label: document.querySelector('.pdm-add-btn')?.textContent, demand: document.querySelector('.pdm-demand-btn')?.textContent }));
        assert(det.add === true && det.label === '暫停販售' && det.demand === '已登記 2 份・管理登記', 'U10 商品詳情：加入停用（暫停販售），提供登記管理入口', JSON.stringify(det));
        await L.page.click('.pdm-demand-btn'); await sleep(400);
        const mgr = await L.page.evaluate(() => ({ pdm: ProductDetailModal.isOpen(), ov: document.getElementById('demandOverlay').classList.contains('show'), qty: document.getElementById('dmQty')?.textContent, cancel: !!document.getElementById('dmCancel') }));
        assert(!mgr.pdm && mgr.ov && mgr.qty === '2' && mgr.cancel, 'U11 從詳情進入管理：關閉詳情、表單帶入 2 份並可取消', JSON.stringify(mgr));
        await L.page.click('#dmCancel'); await sleep(900);
        const afterCancel = await L.page.textContent(`#pc-${PID} .demand-btn`);
        const rows2 = await dbRowsLiveAll(C, 'SELECT status FROM product_demand_requests');
        assert(afterCancel === '我想買' && rows2[0].status === 'cancelled', 'U12 取消登記：商品卡回到「我想買」，資料標示已取消', `${afterCancel} ${JSON.stringify(rows2)}`);
        assert(L.errors.length === 0, 'U13 頁面無 JavaScript 錯誤', L.errors.join(' | '));
        await L.context.close();
      }
      // 通知模式文案（後端回報 notify_available=true 時；以攔截 config 回應模擬，未送出）
      {
        const L = await openLinePage(browser, C, { member: A, routes: async (page) => {
          await page.route('**/api/product-demand/config**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { enabled: true, max_qty: 99, ttl_days: 30, notify_available: true } }) }));
        } });
        await sleep(400);
        const btn = await L.page.textContent(`#pc-${PID} .demand-btn`);
        await L.page.click(`#pc-${PID} .demand-btn`); await sleep(400);
        const ui = await L.page.evaluate(() => ({ title: document.getElementById('dmTitle')?.textContent, desc: document.querySelector('#demandPanel .dm-desc')?.textContent, consentChecked: document.getElementById('dmConsent')?.checked, consentText: document.querySelector('.dm-consent span')?.textContent, submit: document.getElementById('dmSubmit')?.textContent, disc: document.getElementById('dmDisclaimer')?.textContent }));
        assert(btn === '🔔 補貨通知我' && ui.title === '想買幾份？開放訂購時通知你' && ui.desc === '登記後，商品開放訂購時將透過 LINE 通知你一次。補貨時間尚未確定。' && ui.consentChecked === false && ui.consentText === '我同意透過 LINE 接收本次商品的補貨通知。' && ui.submit === '確認登記' && ui.disc === '登記不代表訂單成立，也不保留商品，實際供應以訂購時為準。',
          'U14 通知模式（僅在後端回報可用時）：按鈕／標題／說明／同意（預設不勾）／確認登記／免責文案', JSON.stringify({ btn, ui }));
        await L.context.close();
      }
      // 入口規則：今日完售可預購 → 不顯示；預購已滿 → 顯示；正常販售有份數 → 不顯示；正常販售今日份數用完且預購已滿 → 顯示
      const cases = [
        { name: '今日完售＋預購未滿', body: { sale_status: 'sold_out_today', line_preorder_daily: 20, line_preorder_sold: 0 }, want: false },
        { name: '今日完售＋預購已滿', body: { sale_status: 'sold_out_today', line_preorder_sold: 20 }, want: true },
        { name: '正常販售＋有份數', body: { sale_status: 'available', line_quota_sold: 0, line_preorder_sold: 0 }, want: false },
        { name: '正常販售＋今日用完＋預購已滿', body: { sale_status: 'available', line_quota_sold: 10, line_preorder_sold: 20 }, want: true },
      ];
      for (const cs of cases) {
        await patchProduct(C, cs.body);
        if (cs.body.line_preorder_sold != null) await restart(C, (db) => db.run('UPDATE products SET line_preorder_sold=? WHERE id=?', [cs.body.line_preorder_sold, PID]));
        const L = await openLinePage(browser, C, {});
        const has = await L.page.$(`#pc-${PID} .demand-btn`);
        const st = await cardState(L.page);
        assert(!!has === cs.want && st.plusEnabled === st.incOk, `U15 ${cs.name}：登記入口${cs.want ? '顯示' : '不顯示'}，加購判斷一致`, JSON.stringify({ has: !!has, status: st.status, plus: st.plusEnabled, inc: st.incOk }));
        const hiddenShown = await L.page.evaluate(() => [703, 704, 705].filter((id) => document.getElementById('pc-' + id)));
        assert(hiddenShown.length === 0, `U16 ${cs.name}：隱藏商品（enabled=0／show_on_line=0／外帶外送皆停用）不出現`, JSON.stringify(hiddenShown));
        await L.context.close();
      }
      await safeStop(C.s);
    }

    // ═════════════════ B：MBV2 備份／匯入 ═════════════════
    if (run('b')) {
      const dir = H.tmpDir('hf1c3-b'); const C = await bootServer(dir, {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'paused' });
      const A = session('store_001', 'Ubackupaaaaaaaaaaaaaaaaaaaaaaa01'); const B2 = session('store_001', 'Ubackupbbbbbbbbbbbbbbbbbbbbbbb02');
      await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 2, fulfillment_pref: 'takeout' });
      await pub(C, 'POST', '/api/product-demand/register', { member_session: B2, product_id: PID, desired_qty: 7 });
      await pub(C, 'POST', '/api/product-demand/cancel', { member_session: B2, product_id: PID });
      await pub(C, 'POST', '/api/product-demand/register', { member_session: B2, product_id: PID, desired_qty: 4 });
      // 通知同意（本輪無法經 API 建立；直接寫入以驗證備份保存同意狀態）
      await restart(C, (db) => {
        const r = H.q1(db, "SELECT request_uuid FROM product_demand_requests WHERE line_user_id='Ubackupaaaaaaaaaaaaaaaaaaaaaaa01'");
        db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at)
                VALUES ('c-granted-1','store_001',?,?,?,'line','granted','restock-notify-v1',datetime('now'))`, [PID, 'Ubackupaaaaaaaaaaaaaaaaaaaaaaa01', r.request_uuid]);
        db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at,revoked_at)
                VALUES ('c-revoked-1','store_001',?,?,'','line','revoked','restock-notify-v1',datetime('now'),datetime('now'))`, [PID, 'Ubackupbbbbbbbbbbbbbbbbbbbbbbb02']);
      });
      const cfg = await H.api(C.s.base, C.tok, 'GET', '/api/migration/v2/config');
      const cats = (cfg.json && (cfg.json.categories || (cfg.json.data && cfg.json.data.categories)) || []).map((c) => c.key);
      assert(cats.includes('product_demand'), 'B1 MBV2 分類包含「商品想買登記」', JSON.stringify(cats));
      const full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
      const fj = JSON.parse(full.buf.toString('utf8'));
      assert(fj.backup_type === 'full' && fj.selected_categories.includes('product_demand') && fj.data.product_demand_requests.length === 3 && fj.data.product_demand_consents.length === 2,
        'B2 完整備份包含 3 筆登記（含已取消）與 2 筆通知同意', JSON.stringify({ c: fj.table_counts && { r: fj.table_counts.product_demand_requests, k: fj.table_counts.product_demand_consents } }));
      const part = await H.download(C.s.base, C.tok, '/api/migration/v2/export?categories=product_demand');
      const pj = JSON.parse(part.buf.toString('utf8'));
      assert(pj.backup_type === 'partial' && Object.keys(pj.data).filter((k) => Array.isArray(pj.data[k])).sort().join(',') === 'product_demand_consents,product_demand_requests' && pj.ref_maps && pj.ref_maps.products && pj.ref_maps.products[PID],
        'B3 選擇性備份只含想買登記兩張表，並附商品對照表', Object.keys(pj.data).join(','));
      await safeStop(C.s);
      // 目標：同店別、商品 ID 不同（名稱相同）→ 匯入需重新對應商品
      const dir2 = H.tmpDir('hf1c3-b2'); const T = await bootServer(dir2, { pid: 801, pid2: 802 }); ctxs.push(T);
      const pushBefore = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
      const up = await H.uploadRaw(T.s.base, T.tok, part.buf, { name: 'demand.json' });
      const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: ['product_demand'] });
      const st = res.import && res.import.result && res.import.result.stats;
      assert(res.import && res.import.status === 'done' && st.product_demand_requests.added === 3 && st.product_demand_consents.added === 2, 'B4 選擇性匯入：新增 3 筆登記、2 筆同意', JSON.stringify(res.import && res.import.result && res.import.result.totals || res));
      await safeStop(T.s);
      const tr = await dbRows(T.dbf, 'SELECT product_id,line_user_id,desired_qty,status,fulfillment_pref,store_id FROM product_demand_requests ORDER BY id');
      const tc = await dbRows(T.dbf, 'SELECT product_id,line_user_id,status,request_uuid FROM product_demand_consents ORDER BY id');
      assert(tr.every((x) => x.product_id === 801 && x.store_id === 'store_001') && tr.map((x) => x.status).join(',') === 'active,cancelled,active' && tr[0].fulfillment_pref === 'takeout' && tr[0].line_user_id === 'Ubackupaaaaaaaaaaaaaaaaaaaaaaa01',
        'B5 匯入後商品關聯改對應目標店商品（701→801）、會員與店別、狀態與偏好正確', JSON.stringify(tr));
      assert(tc.map((x) => x.status).join(',') === 'granted,revoked' && tc.every((x) => x.product_id === 801), 'B6 通知同意狀態保留（granted／revoked）且商品關聯正確', JSON.stringify(tc));
      await restart(T);
      const tsum = (await H.api(T.s.base, T.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products.find((p) => p.product_id === 801);
      assert(tsum.active_users === 2 && tsum.total_qty === 6, 'B7 匯入後後台統計：有效 2 人、6 份（排除已取消）', JSON.stringify(tsum));
      // 再匯入一次：不重複
      const up2 = await H.uploadRaw(T.s.base, T.tok, part.buf, { name: 'demand.json' });
      const res2 = await H.previewAndImport(T.s.base, T.tok, up2.json.upload_id, { mode: 'merge', categories: ['product_demand'] });
      const st2 = res2.import.result.stats;
      assert(st2.product_demand_requests.added === 0 && st2.product_demand_consents.added === 0, 'B8 重複匯入同一份備份不重複新增', JSON.stringify(res2.import.result.totals));
      // 舊格式完整備份（沒有想買登記分類）以「完整取代」匯入：不得清空現有登記
      const legacy = JSON.parse(full.buf.toString('utf8'));
      legacy.selected_categories = legacy.selected_categories.filter((c) => c !== 'product_demand');
      delete legacy.data.product_demand_requests; delete legacy.data.product_demand_consents;
      if (legacy.table_counts) { delete legacy.table_counts.product_demand_requests; delete legacy.table_counts.product_demand_consents; }
      const up3 = await H.uploadRaw(T.s.base, T.tok, Buffer.from(JSON.stringify(legacy)), { name: 'legacy-full.json' });
      const res3 = await H.previewAndImport(T.s.base, T.tok, up3.json.upload_id, { mode: 'replace', categories: legacy.selected_categories, confirm_text: 'store_001', password: 'pw001' });
      const ok3 = res3.import && res3.import.status === 'done';
      await safeStop(T.s);
      const keep = await dbRows(T.dbf, 'SELECT COUNT(*) AS c FROM product_demand_requests');
      const keepC = await dbRows(T.dbf, 'SELECT COUNT(*) AS c FROM product_demand_consents');
      assert(ok3 && Number(keep[0].c) === 3 && Number(keepC[0].c) === 2, 'B9 沒有想買登記分類的舊備份「完整取代」：現有登記與同意未被清空', JSON.stringify({ ok3, err: res3.import ? res3.import.error : res3, keep: keep[0].c, keepC: keepC[0].c }));
      // 含此分類的完整備份「完整取代」→ 以備份為準（不重複）
      await restart(T);
      const up4 = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'full.json' });
      const res4 = await H.previewAndImport(T.s.base, T.tok, up4.json.upload_id, { mode: 'replace', categories: fj.selected_categories, confirm_text: 'store_001', password: 'pw001' });
      await safeStop(T.s);
      const rep = await dbRows(T.dbf, 'SELECT product_id,status FROM product_demand_requests ORDER BY id');
      const repC = await dbRows(T.dbf, 'SELECT status FROM product_demand_consents ORDER BY id');
      const prodName = await dbRows(T.dbf, 'SELECT id FROM products WHERE store_id=? AND name=?', ['store_001', PNAME]);
      assert(res4.import && res4.import.status === 'done' && rep.length === 3 && rep.every((x) => x.product_id === prodName[0].id) && repC.map((x) => x.status).join(',') === 'granted,revoked',
        'B10 含想買登記的完整備份「完整取代」：登記與同意等於備份內容、商品關聯一致', JSON.stringify({ st: res4.import && res4.import.status, err: res4.import && res4.import.error, rep, repC, pid: prodName }));
      const pushAfter = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
      assert(pushAfter - pushBefore === 0, 'B11 備份／匯入過程 LINE 推播呼叫次數為 0', String(pushAfter - pushBefore));
    }

    // ═════════════════ A：後台想買登記分頁 ═════════════════
    if (run('a')) {
      const dir = H.tmpDir('hf1c3-a'); const C = await bootServer(dir, {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'sold_out_indefinitely' });
      await pub(C, 'POST', '/api/product-demand/register', { member_session: session('store_001', 'Uadminaaaaaaaaaaaaaaaaaaaaaaa01'), product_id: PID, desired_qty: 3 });
      await pub(C, 'POST', '/api/product-demand/register', { member_session: session('store_001', 'Uadminbbbbbbbbbbbbbbbbbbbbbbb02'), product_id: PID, desired_qty: 5 });
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      await ctx.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); }, [C.tok]);
      const page = await ctx.newPage(); const errs = [];
      page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => d.accept());
      await page.goto(C.s.base + '/');
      await page.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function');
      await page.evaluate(() => { showPage('line_products'); });
      await sleep(800);
      await page.evaluate(() => lpmSwitchTab('demand'));
      await page.waitForSelector(`#pd-row-${PID}`, { timeout: 10000 }).catch(() => {});
      const row = await page.evaluate((id) => { const r = document.getElementById('pd-row-' + id); return r ? { status: r.querySelector('.pd-status').textContent, users: r.querySelector('.pd-users').textContent, qty: r.querySelector('.pd-qty').textContent, collect: r.querySelector('.pd-collect').checked } : null; }, PID);
      const vis = await page.evaluate(() => ({ main: getComputedStyle(document.getElementById('lpm-table-wrap')).display, ship: getComputedStyle(document.getElementById('lpm-shipping-table-wrap')).display, demand: getComputedStyle(document.getElementById('lpm-demand-wrap')).display, notify: document.getElementById('pd-notify-state').textContent }));
      assert(row && row.status === '長期下架' && row.users === '2' && row.qty === '8' && row.collect === true && vis.main === 'none' && vis.ship === 'none' && vis.demand === 'block',
        'A1 後台想買登記分頁：商品狀態、有效登記人數 2、期望總份數 8、收集開關', JSON.stringify({ row, vis }));
      assert(/尚未啟用/.test(vis.notify), 'A2 後台明示 LINE 補貨通知尚未啟用', vis.notify);
      await page.evaluate((id) => openDemandDetail(id), PID); await sleep(800);
      const det = await page.evaluate(() => Array.from(document.querySelectorAll('#pd-detail-table tbody tr')).map((tr) => tr.innerText));
      assert(det.length === 2 && det.every((t) => /有效/.test(t)) && !det.join('').includes('Uadminaaaaaaaaaaaaaaaaaaaaaaa01'), 'A3 明細 2 筆，會員識別碼遮罩', JSON.stringify(det));
      await page.screenshot({ path: path.join(shots, 'a-admin-demand.png') });
      await page.evaluate(() => lpmSwitchTab('today')); await sleep(600);
      const back = await page.evaluate(() => ({ main: getComputedStyle(document.getElementById('lpm-table-wrap')).display, demand: getComputedStyle(document.getElementById('lpm-demand-wrap')).display }));
      assert(back.main === 'block' && back.demand === 'none', 'A4 切回今日販售分頁：主表顯示、想買登記隱藏', JSON.stringify(back));
      assert(errs.length === 0, 'A5 後台頁面無 JavaScript 錯誤', errs.join(' | '));
      await ctx.close();
      await safeStop(C.s);
    }
    const pushTotal = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
    assert(pushTotal === 0, 'Z1 整個驗收過程 LINE API／推播呼叫次數為 0', String(pushTotal));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    // 已被 SIGTERM 結束的子程序 exitCode 為 null（signalCode 有值），不可再等待 exit 事件
    for (const c of ctxs) { try { await safeStop(c.s); } catch {} }
    await browser.close();
  }
  const { passCount, failCount, results } = H.summary();
  if (process.env.HF1C3_RESULT_JSON) fs.writeFileSync(process.env.HF1C3_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed  (screenshots: ${shots})`);
  process.exit(failCount ? 1 : 0);
})();

// 伺服器運作中的即時查詢：以 admin API 無法直接取得的表，改為停機讀檔會干擾流程，
// 這裡透過 sql 檔的即時快照不可行（sql.js 記憶體），因此用 export 端點讀取。
async function dbRowsLiveAll(ctx, sql) {
  const r = await H.download(ctx.s.base, ctx.tok, '/api/migration/v2/export?categories=product_demand');
  const j = JSON.parse(r.buf.toString('utf8'));
  const SQL = await require(path.join(H.ROOT, 'node_modules', 'sql.js'))();
  const db = new SQL.Database();
  db.run(`CREATE TABLE product_demand_requests (${Object.keys((j.data.product_demand_requests[0]) || { id: 1, status: '', desired_qty: 0, cycle_no: 0, line_user_id: '' }).map((c) => c + ' ').join(',')})`);
  db.run(`CREATE TABLE product_demand_consents (${Object.keys((j.data.product_demand_consents[0]) || { id: 1, status: '' }).join(',')})`);
  for (const t of ['product_demand_requests', 'product_demand_consents']) {
    for (const row of j.data[t]) { const ks = Object.keys(row); db.run(`INSERT INTO ${t} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ks.map((k) => row[k])); }
  }
  const out = H.q(db, sql); db.close(); return out;
}
async function dbRowsLive(ctx, sql) { const r = await dbRowsLiveAll(ctx, sql); return Number(r[0] && r[0].c); }
