#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js
// R54.4／MBV2-HF1-C1 —— 真實伺服器（server.js）＋暫存資料庫＋真實 Chrome（Playwright）驗收：
//   問題一：舊購物車轉入預購後，「＋」誤用今日份數
//   問題二：今日販售／預購數量／冷藏宅配三分頁的商品販售標示與刷新
//
// 安全規則：只使用 os.tmpdir() 下的暫存資料庫與本機隨機埠；Google Routes 以
// scripts/lib/hf1c1-maps-mock.js 固定回應（其餘外部網址一律拒絕）；不連正式站、
// 不發 LINE 推播。需要 playwright（可用 NODE_PATH 指向全域安裝）與 Chrome。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert, fail } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('playwright not installed — 此測試需要真實瀏覽器，無法執行（未以其他方式代替）');
  process.exit(2);
}

const ONLY = process.env.HF1C1_ONLY || ''; // 例：p1,p2,p3,s2（預設全部；p3＝C2 商品詳情上限）
const PID = 601;                       // 古法冷拌麻油豬心
const PNAME = '古法冷拌麻油豬心';
const MOCK = path.join(__dirname, 'lib', 'hf1c1-maps-mock.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function twDate(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function seedLine(db, opts = {}) {
  const run = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => run(`INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001',?,?)`, [k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay));
  set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1');
  set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0');
  set('line_payment_cash_enabled', '1');
  set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654');
  set('delivery_max_distance_km', '7');
  set('delivery_basic_fee', '50');
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
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) run(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
        line_quota_enabled,line_quota_daily,line_quota_sold,line_quota_low_threshold,line_quota_high_threshold,
        line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_preorder_low_threshold,line_preorder_high_threshold,
        line_takeout_enabled,line_delivery_enabled,shipping_enabled,shipping_share_line_stock)
       VALUES (?,?,?,?,?,?,1,1,'available',0, 1,1,0,2,10, 1,20,0,2,10, 1,1,1,1)`,
  [PID, 'store_001', PNAME, '飯類', 101, 150]);
}

async function bootServer(dir, pageMode) {
  const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedLine(db, { pageMode }); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf, { __nodeArgs: ['-r', MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei' });
  const tok = await H.login(s.base, 'store_001', 'pw001');
  return { s, dbf, tok };
}
async function productRow(dbf) {
  const db = await H.openDbFile(dbf);
  const r = H.q1(db, `SELECT * FROM products WHERE id=?`, [PID]);
  db.close(); return r;
}
async function ordersFor(dbf) {
  const db = await H.openDbFile(dbf);
  const rows = H.q(db, `SELECT * FROM orders WHERE store_id='store_001' AND (order_number LIKE 'L%' OR source='line' OR 1=1) ORDER BY rowid`);
  db.close(); return rows.filter((o) => String(o.items || '').includes(String(PID)) || String(o.items || '').includes(PNAME));
}
async function patchProduct(ctx, body) {
  const r = await H.api(ctx.s.base, ctx.tok, 'PATCH', `/api/products/${PID}/line-settings`, body);
  if (!r.json || !r.json.success) throw new Error('patch failed ' + r.text.slice(0, 200));
  return r.json.data;
}

// ── LINE 點餐頁：開啟（可預先放入舊購物車） ─────────────────────────────
async function openLinePage(browser, ctx, { savedCart, mode = 'takeout', pickupDate, expectCard = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
  if (savedCart) {
    const payload = {
      version: 1, store_id: 'store_001', cart_created_at: Date.now() - 3600e3, cart_updated_at: Date.now() - 3600e3,
      cart: savedCart, order_mode: mode, customer: { name: '', phone: '' }, coupon_code: '',
      pickup_date: pickupDate || twDate(0), pickup_time: '', payment_method: '', order_note: '',
    };
    await context.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } },
      ['line_order_cart_store_001', JSON.stringify(payload)]);
  }
  const page = await context.newPage();
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
  if (expectCard) await page.waitForSelector(`#pc-${PID}`, { timeout: 20000 });
  await sleep(expectCard ? 700 : 1500); // restoreCart()／時段載入完成
  return { context, page, dialogs, errors, posts, events };
}
const cartQty = (page) => page.evaluate((id) => (cart[id] ? cart[id].qty : 0), PID);
async function cardPlus(page) {
  const sel = `#pc-${PID} .qty-ctrl .plus`;
  await page.waitForSelector(sel, { timeout: 5000 });
  await page.click(sel);
  await sleep(60);
}
async function cardAdd(page) {
  const sel = `#pc-${PID} .add-btn`;
  await page.waitForSelector(sel, { timeout: 5000 });
  await page.click(sel);
  await sleep(60);
}
async function openCart(page) {
  await page.evaluate(() => openCartSheet());
  await sleep(900);
}
async function cartPlus(page) { await page.click(`#cartItems .qty-ctrl .plus`); await sleep(60); }
async function cartMinus(page) { await page.click(`#cartItems .qty-ctrl .minus`); await sleep(60); }
async function submitCheckout(page, { delivery } = {}) {
  await page.evaluate(() => { if (typeof _enterCheckoutStage === 'function') _enterCheckoutStage(); });
  await sleep(300);
  await page.fill('#cName', '測試顧客');
  await page.fill('#cPhone', '0912345678');
  if (delivery) {
    await page.evaluate(async () => {
      document.getElementById('deliveryAddress').value = '台北市信義區市府路1號';
      deliveryLatLng = { lat: 25.0375, lng: 121.5637 };
      await fetchDeliveryFee();
    });
    await page.waitForFunction(() => deliveryFeeCalculated === true, null, { timeout: 10000 });
  }
  await page.evaluate(() => { const b = document.querySelector('#payBtns .pay-btn[data-code="cash"]'); if (b) b.click(); });
  await page.waitForFunction(() => { const t = document.getElementById('pTime'); return t && Array.from(t.options).some((o) => o.value && !o.disabled); }, null, { timeout: 10000 });
  const pDate = await page.$eval('#pDate', (e) => e.value);
  const resp = page.waitForResponse((r) => r.url().includes('/api/line-orders') && r.request().method() === 'POST' && !r.url().includes('/timeslots'), { timeout: 15000 }).catch(() => null);
  await page.click('#subBtn');
  const r = await resp;
  let body = null; try { body = r ? await r.json() : null; } catch {}
  await sleep(600);
  return { pDate, status: r ? r.status() : 0, body };
}

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C1 真實瀏覽器＋正式路由驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const shots = process.env.HF1C1_SHOT_DIR || H.tmpDir('hf1c1-shots');
  const ctxs = [];
  try {
    const today = twDate(0), tomorrow = twDate(1);
    if (!ONLY || ONLY.includes('p1')) {
    // ═════════════════ 問題一（combined_checkout，外帶）═════════════════
    const dirA = H.tmpDir('hf1c1-a'); const A = await bootServer(dirA, 'combined_checkout'); ctxs.push(A);

    // 原始重現：今日 1 份已被其他訂單用完（sold=1）→ 商品只能預約下個營業日；
    // 顧客 localStorage 舊購物車已有 1 份、日期停在今天。
    await patchProduct(A, { line_quota_sold: 1 });
    {
      const L = await openLinePage(browser, A, { savedCart: { [PID]: 1 }, mode: 'takeout', pickupDate: today });
      const menuP = await L.page.evaluate((id) => { const p = allProducts.find((x) => x.id == id); return { r: p.takeout_sold_out_reason, c: p.takeout_can_next_day, q: p.line_quota, pr: p.line_preorder }; }, PID);
      assert(menuP.r === 'real_sold_out' && menuP.c === true && menuP.q.remaining === 0 && menuP.pr.remaining === 20,
        'P1-0 重現前提：/api/line-menu 回報今日 real_sold_out、可預約明日、今日剩 0、預購剩 20', JSON.stringify(menuP));
      const restoredQty = await cartQty(L.page);
      const restoredDate = await L.page.$eval('#pDate', (e) => e.value);
      const memFlag = await L.page.evaluate((id) => preorderRequiredIds.has(Number(id)), PID);
      assert(restoredQty === 1 && memFlag === false, 'P1-1 舊購物車還原 1 份，且記憶體沒有 preorderRequiredIds 標記（根因情境）', `qty=${restoredQty} date=${restoredDate} flag=${memFlag}`);
      const addEvBefore = L.events.filter((e) => e.event_name === 'add_to_cart' || e.event === 'add_to_cart').length;
      await cardPlus(L.page);
      assert(await cartQty(L.page) === 2 && L.dialogs.length === 0, 'P1-2 商品卡「＋」：舊購物車 1 → 2 份，未跳出「LINE 份數不足」', `qty=${await cartQty(L.page)} dialogs=${JSON.stringify(L.dialogs)}`);
      await sleep(400);
      const addEvAfter = L.events.filter((e) => e.event_name === 'add_to_cart' || e.event === 'add_to_cart').length;
      assert(addEvAfter - addEvBefore === 1, 'P1-3 一次「＋」只送出 1 筆 add_to_cart（未重複計入）', `delta=${addEvAfter - addEvBefore}`);
      assert(!L.posts.some((u) => /\/api\/line-orders(\?|$)/.test(u)), 'P1-4 背景加購未自動成立訂單（沒有 POST /api/line-orders）', JSON.stringify(L.posts));
      for (let i = 0; i < 3; i++) await cardPlus(L.page);
      assert(await cartQty(L.page) === 5, 'P1-5 商品卡連續＋到 5 份', String(await cartQty(L.page)));
      // 重新整理：數量保存、仍使用預購額度
      await L.page.reload({ waitUntil: 'domcontentloaded' });
      await L.page.waitForSelector(`#pc-${PID}`); await sleep(800);
      assert(await cartQty(L.page) === 5, 'P1-6 重新整理後數量仍為 5 份（未遺失、未清空舊購物車）', String(await cartQty(L.page)));
      await cardPlus(L.page);
      assert(await cartQty(L.page) === 6 && L.dialogs.length === 0, 'P1-7 重新整理後「＋」仍用預購額度（5→6）', `dialogs=${JSON.stringify(L.dialogs)}`);
      // 購物車開啟：日期自動對齊下個營業日；購物車「＋」
      await openCart(L.page);
      const dateAfterOpen = await L.page.$eval('#pDate', (e) => e.value);
      assert(dateAfterOpen === tomorrow, 'P1-8 開啟購物車：取餐日期自動改為下個營業日', `${dateAfterOpen} (tomorrow=${tomorrow})`);
      await cartPlus(L.page);
      assert(await cartQty(L.page) === 7, 'P1-9 購物車「＋」6→7', String(await cartQty(L.page)));
      // 外帶↔外送切換後不退回今日額度
      await L.page.evaluate(() => selectFulfillmentMode('delivery')); await sleep(900);
      await cartPlus(L.page);
      await L.page.evaluate(() => selectFulfillmentMode('takeout')); await sleep(900);
      await cartPlus(L.page);
      assert(await cartQty(L.page) === 9 && L.dialogs.length === 0, 'P1-10 切換外送／外帶後「＋」仍用預購額度（7→9）', `qty=${await cartQty(L.page)} dialogs=${JSON.stringify(L.dialogs)}`);
      // 商品詳情：上限＝預購剩 20 − 購物車 9 = 11
      await L.page.evaluate(() => closeSheet('cartSheet')); await sleep(300);
      await L.page.evaluate((id) => openProductDetail(id), PID); await sleep(400);
      for (let i = 0; i < 15; i++) { const dis = await L.page.$eval('.pdm-plus', (b) => b.disabled).catch(() => true); if (dis) break; await L.page.click('.pdm-plus'); }
      const pdmMax = Number(await L.page.textContent('.pdm-qty-num'));
      assert(pdmMax === 11, 'P1-11 商品詳情數量上限＝預購剩餘 20 − 購物車 9 = 11（與商品卡／購物車同一規則）', String(pdmMax));
      await L.page.click('.pdm-add-btn, .pdm-add, button.pdm-cta').catch(async () => { await L.page.evaluate(() => document.querySelector('[class*="pdm"] button:last-of-type').click()); });
      await sleep(500);
      assert(await cartQty(L.page) === 20 && L.dialogs.length === 0, 'P1-12 商品詳情加入 11 份 → 購物車 20 份（=預購上限）', `qty=${await cartQty(L.page)} dialogs=${JSON.stringify(L.dialogs)}`);
      await cardPlus(L.page);
      const d21 = L.dialogs.slice(-1)[0] || '';
      assert(await cartQty(L.page) === 20 && /預購/.test(d21) && !/LINE 今日/.test(d21), 'P1-13 第 21 份被阻擋，文案指向預購額度', d21);
      await L.page.screenshot({ path: path.join(shots, 'p1-preorder-20.png') });
      // 送單：用未來日期、扣預購額度；今日額度不動
      await openCart(L.page);
      const sub = await submitCheckout(L.page);
      const prow = await productRow(A.dbf);
      const ords = await ordersFor(A.dbf);
      const last = ords[ords.length - 1] || {};
      assert(sub.status === 200 && sub.pDate === tomorrow, 'P1-14 正式送單成功，送出 pickup_date＝明天', `status=${sub.status} pDate=${sub.pDate} msg=${sub.body && sub.body.message}`);
      assert(Number(prow.line_preorder_sold) === 20 && Number(prow.line_quota_sold) === 1, 'P1-15 後端扣預購額度 20 份，今日額度維持 1（未誤扣）', `preorder_sold=${prow.line_preorder_sold} quota_sold=${prow.line_quota_sold}`);
      assert(String(last.pickup_time || '').length > 0 && ords.length === 1, 'P1-16 只成立 1 筆訂單', `orders=${ords.length} pickup=${last.pickup_time}`);
      assert(L.errors.length === 0, 'P1-17 頁面無 JavaScript 錯誤', L.errors.join(' | '));
      await L.context.close();
    }
    // 預購已滿：不能再加
    {
      const L = await openLinePage(browser, A, { savedCart: { [PID]: 1 }, pickupDate: today });
      // 已還原 1 份（預購已滿但還原只看商品存在），按＋必須阻擋
      await L.page.evaluate((id) => chgQty(id, 1), PID);
      const msg = L.dialogs.slice(-1)[0] || '';
      assert(await cartQty(L.page) === 1 && /預購已滿/.test(msg), 'P1-18 預購額度已滿時不能增加（文案：預購已滿）', msg);
      await L.page.evaluate((id) => chgQty(id, -1), PID);
      assert(await cartQty(L.page) === 0, 'P1-19 預購已滿時仍可減少／移除', String(await cartQty(L.page)));
      await L.context.close();
    }
    // 今日訂購：今日 1 份限制仍有效，送單扣今日額度
    await patchProduct(A, { line_quota_sold: 0, line_preorder_sold: 0 });
    {
      const L = await openLinePage(browser, A, {});
      await cardAdd(L.page);
      await cardPlus(L.page);
      const msg = L.dialogs.slice(-1)[0] || '';
      assert(await cartQty(L.page) === 1 && /今日/.test(msg) && /剩 1 份/.test(msg), 'P1-20 今日訂購：受今日 1 份限制（第 2 份阻擋，文案指向今日份數）', msg);
      await openCart(L.page);
      await cartPlus(L.page);
      assert(await cartQty(L.page) === 1, 'P1-21 購物車「＋」同樣受今日 1 份限制', String(await cartQty(L.page)));
      const sub = await submitCheckout(L.page);
      const prow = await productRow(A.dbf);
      assert(sub.status === 200 && sub.pDate === today && Number(prow.line_quota_sold) === 1 && Number(prow.line_preorder_sold) === 0,
        'P1-22 今日單：送出今天日期，扣今日額度 1、預購額度不動', `status=${sub.status} pDate=${sub.pDate} quota_sold=${prow.line_quota_sold} preorder_sold=${prow.line_preorder_sold}`);
      await L.context.close();
    }
    // 明確選擇未來日期（今日仍可售）：使用預購額度
    await patchProduct(A, { line_quota_sold: 0, line_preorder_sold: 0 });
    {
      const L = await openLinePage(browser, A, {});
      await cardAdd(L.page);
      await openCart(L.page);
      await L.page.evaluate(() => _enterCheckoutStage()); await sleep(300);
      await L.page.selectOption('#pDate', tomorrow); await sleep(800);
      await L.page.evaluate(() => _enterCartStage()); await sleep(300);
      await cartPlus(L.page); await cartPlus(L.page);
      assert(await cartQty(L.page) === 3 && L.dialogs.length === 0, 'P1-23 今日仍可售但明確選擇明天：使用預購額度（1→3）', `dialogs=${JSON.stringify(L.dialogs)}`);
      const sub = await submitCheckout(L.page);
      const prow = await productRow(A.dbf);
      assert(sub.status === 200 && sub.pDate === tomorrow && Number(prow.line_preorder_sold) === 3 && Number(prow.line_quota_sold) === 0,
        'P1-24 明天單：扣預購 3 份，今日額度不動', `status=${sub.status} preorder_sold=${prow.line_preorder_sold} quota_sold=${prow.line_quota_sold}`);
      await L.context.close();
    }
    // 預購不設限：不受今日 1 份限制
    await patchProduct(A, { line_quota_sold: 1, line_preorder_sold: 0, line_preorder_enabled: 0, line_preorder_daily: 0 });
    {
      const L = await openLinePage(browser, A, { savedCart: { [PID]: 1 }, pickupDate: today });
      for (let i = 0; i < 24; i++) await L.page.evaluate((id) => chgQty(id, 1), PID);
      assert(await cartQty(L.page) === 25 && L.dialogs.length === 0, 'P1-25 預購不設限：舊購物車 1 → 25 份，不受今日 1 份限制', `qty=${await cartQty(L.page)} dialogs=${JSON.stringify(L.dialogs)}`);
      await openCart(L.page);
      const sub = await submitCheckout(L.page);
      const prow = await productRow(A.dbf);
      assert(sub.status === 200 && sub.pDate === tomorrow && Number(prow.line_quota_sold) === 1, 'P1-26 預購不設限送單：明天日期，今日額度不動', `status=${sub.status} pDate=${sub.pDate} quota_sold=${prow.line_quota_sold} msg=${sub.body && sub.body.message}`);
      await L.context.close();
    }
    // 送單日期防呆：購物車有「只能預約」商品，卻被改成今天 → 不送單
    await patchProduct(A, { line_quota_sold: 1, line_preorder_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20 });
    {
      const L = await openLinePage(browser, A, { savedCart: { [PID]: 2 }, pickupDate: today });
      await openCart(L.page);
      await L.page.evaluate((d) => { const s = document.getElementById('pDate'); const o = document.createElement('option'); o.value = d; o.textContent = 'today(test)'; s.insertBefore(o, s.firstChild); s.value = d; }, today);
      const before = (await ordersFor(A.dbf)).length;
      await L.page.evaluate(() => _enterCheckoutStage()); await sleep(200);
      await L.page.fill('#cName', '測試顧客'); await L.page.fill('#cPhone', '0912345678');
      await L.page.click('#subBtn'); await sleep(1500);
      const after = (await ordersFor(A.dbf)).length;
      const dNow = await L.page.$eval('#pDate', (e) => e.value);
      const guardEv = L.events.filter((e) => JSON.stringify(e).includes('checkout_validation_failed')).map((e) => JSON.stringify(e.metadata || e).slice(0, 120));
      assert(guardEv.some((x) => x.includes('inventory_unavailable')), 'P1-27a 送單防呆由新檢查攔下（checkout_validation_failed reason=inventory_unavailable）', guardEv.join(' | '));
      assert(after === before && dNow === tomorrow, 'P1-27 送單防呆：預購商品不得以今天日期送出；未建立訂單並把日期改回下個營業日', `orders ${before}->${after} pDate=${dNow}`);
      await L.context.close();
    }
    // 暫停／長期下架：舊購物車不能增加，但可減少／移除
    for (const ss of ['paused', 'sold_out_indefinitely']) {
      await patchProduct(A, { sale_status: ss, line_quota_sold: 0 });
      const L = await openLinePage(browser, A, { savedCart: { [PID]: 2 }, pickupDate: today });
      assert(await cartQty(L.page) === 2, `P1-28-${ss} 舊購物車還原 2 份`, String(await cartQty(L.page)));
      await openCart(L.page);
      await cartPlus(L.page);
      const msg = L.dialogs.slice(-1)[0] || '';
      assert(await cartQty(L.page) === 2 && /(暫停販售|長期下架)/.test(msg), `P1-29-${ss} 購物車「＋」被阻擋`, msg);
      await L.page.evaluate((id) => chgQty(id, 1), PID);
      assert(await cartQty(L.page) === 2, `P1-30-${ss} 直接呼叫 chgQty(+1) 也不能繞過`, String(await cartQty(L.page)));
      await cartMinus(L.page);
      assert(await cartQty(L.page) === 1, `P1-31-${ss} 仍可減少（2→1）`, String(await cartQty(L.page)));
      await cartMinus(L.page);
      const stored = await L.page.evaluate(() => JSON.parse(localStorage.getItem('line_order_cart_store_001') || '{}').cart || {});
      assert(await cartQty(L.page) === 0 && !stored[PID], `P1-32-${ss} 可移除，且保存的購物車同步移除`, JSON.stringify(stored));
      await L.context.close();
    }
    await patchProduct(A, { sale_status: 'available' });
    // 商品不支援目前取餐方式（fulfillment_switcher 由另一組伺服器驗證）；combined 模式下僅外帶商品在外送模式仍可依外帶規則加入
    await A.s.stop();

    }
    if (!ONLY || ONLY.includes('p2')) {
    // ═════════════════ 問題一（fulfillment_switcher，外送＋外帶）═════════════════
    const dirB = H.tmpDir('hf1c1-b'); const B = await bootServer(dirB, 'fulfillment_switcher'); ctxs.push(B);
    await patchProduct(B, { line_quota_sold: 1 });
    {
      const L = await openLinePage(browser, B, { savedCart: { [PID]: 1 }, mode: 'delivery', pickupDate: today });
      const pm = await L.page.evaluate(() => [getLineOrderPageMode(), currentMode]);
      assert(pm[0] === 'fulfillment_switcher' && pm[1] === 'delivery', 'P2-0 頁面模式 fulfillment_switcher、取餐方式外送', JSON.stringify(pm));
      await cardPlus(L.page); await cardPlus(L.page);
      assert(await cartQty(L.page) === 3 && L.dialogs.length === 0, 'P2-1 外送＋fulfillment_switcher：舊購物車 1→3 用預購額度', `dialogs=${JSON.stringify(L.dialogs)}`);
      await openCart(L.page);
      const sub = await submitCheckout(L.page, { delivery: true });
      const prow = await productRow(B.dbf);
      assert(sub.status === 200 && sub.pDate === tomorrow && Number(prow.line_preorder_sold) === 3 && Number(prow.line_quota_sold) === 1,
        'P2-2 外送預購送單：明天日期、扣預購 3、今日不動', `status=${sub.status} pDate=${sub.pDate} preorder_sold=${prow.line_preorder_sold} msg=${sub.body && sub.body.message}`);
      await L.context.close();
    }
    {
      // 商品改為僅外帶：外送模式的舊購物車不得增加，可減少
      await patchProduct(B, { line_delivery_enabled: 0, line_preorder_sold: 0 });
      const L = await openLinePage(browser, B, { savedCart: { [PID]: 2 }, mode: 'delivery', pickupDate: today, expectCard: false });
      const before = await cartQty(L.page);
      const mode = await L.page.evaluate(() => currentMode);
      await L.page.evaluate((id) => chgQty(id, 1), PID);
      const blockedMsg = L.dialogs.concat(await L.page.evaluate(() => (document.getElementById('toast') || {}).textContent || '')).join('|');
      const afterInc = await cartQty(L.page);
      await L.page.evaluate((id) => chgQty(id, -1), PID);
      assert(mode === 'delivery' ? (afterInc === before) : true, 'P2-3 不支援目前取餐方式（外送）時，舊購物車不能增加', `mode=${mode} before=${before} after=${afterInc} msg=${blockedMsg}`);
      assert(await cartQty(L.page) === afterInc - 1, 'P2-4 不支援時仍可減少', String(await cartQty(L.page)));
      await L.context.close();
      await patchProduct(B, { line_delivery_enabled: 1 });
    }
    {
      // 外帶今日訂購仍受今日額度
      await patchProduct(B, { line_quota_sold: 0, line_preorder_sold: 0 });
      const L = await openLinePage(browser, B, { savedCart: { [PID]: 1 }, mode: 'takeout', pickupDate: today });
      await cardPlus(L.page);
      const msg = L.dialogs.slice(-1)[0] || '';
      assert(await cartQty(L.page) === 1 && /今日/.test(msg), 'P2-5 fulfillment_switcher 外帶今日單仍受今日 1 份限制', msg);
      await L.context.close();
    }
    await B.s.stop();

    }
    if (!ONLY || ONLY.includes('p3')) {
    // ═════════════════ C2：商品詳情上限與 checkCartIncrement() 一致 ═════════════════
    // 今日／預購 × 未達上限／剛好達上限／超過上限／未設限，另含剩 1 份、已達上限仍可減少。
    const dirD = H.tmpDir('hf1c2-d'); const D = await bootServer(dirD, 'combined_checkout'); ctxs.push(D);
    const detail = async (L) => {
      await L.page.evaluate(() => { try { ProductDetailModal.close(); } catch {} });
      await sleep(250);
      await L.page.evaluate((id) => openProductDetail(id), PID);
      await L.page.waitForSelector('.pdm-add-btn', { timeout: 5000 });
      await sleep(250);
      const st = await L.page.evaluate((id) => {
        const btn = document.querySelector('.pdm-add-btn');
        const inc = checkCartIncrement(id, allProducts.find((x) => x.id == id), 1);
        return { btnDisabled: !!btn.disabled, btnText: btn.textContent.trim(), badge: (document.querySelector('.pdm-badge-block') || {}).textContent || '',
          incOk: inc.ok, incBucket: inc.bucket || null, incLimit: inc.limit == null ? null : inc.limit, pDate: document.getElementById('pDate').value };
      }, PID);
      st.maxQty = null;
      if (!st.btnDisabled) {
        let n = 0;
        for (; n < 40; n++) { const dis = await L.page.$eval('.pdm-plus', (b) => b.disabled); if (dis) break; await L.page.click('.pdm-plus'); }
        st.maxQty = n >= 40 ? 'unlimited(>40)' : Number(await L.page.textContent('.pdm-qty-num'));
      }
      return st;
    };
    const cases = [
      // [標籤, bucket, 額度設定, 舊購物車份數, 期望]
      ['TODAY-UNDER',   'today',    { line_quota_enabled: 1, line_quota_daily: 3, line_quota_sold: 0 }, 1, { blocked: false, maxQty: 2 }],
      ['TODAY-ONE-LEFT','today',    { line_quota_enabled: 1, line_quota_daily: 3, line_quota_sold: 0 }, 2, { blocked: false, maxQty: 1, addOne: 3 }],
      ['TODAY-AT',      'today',    { line_quota_enabled: 1, line_quota_daily: 3, line_quota_sold: 0 }, 3, { blocked: true, label: '今日額度已達上限' }],
      ['TODAY-OVER',    'today',    { line_quota_enabled: 1, line_quota_daily: 3, line_quota_sold: 0 }, 5, { blocked: true, label: '今日額度已達上限' }],
      ['TODAY-UNLIMITED','today',   { line_quota_enabled: 0, line_quota_daily: 0, line_quota_sold: 0 }, 5, { blocked: false, maxQty: 'unlimited(>40)' }],
      ['PRE-UNDER',     'preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20, line_preorder_sold: 0 }, 5, { blocked: false, maxQty: 15 }],
      ['PRE-ONE-LEFT',  'preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20, line_preorder_sold: 0 }, 19, { blocked: false, maxQty: 1, addOne: 20 }],
      ['PRE-AT(重現)',  'preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20, line_preorder_sold: 0 }, 20, { blocked: true, label: '預購額度已達上限' }],
      ['PRE-OVER',      'preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 0, line_preorder_enabled: 1, line_preorder_daily: 20, line_preorder_sold: 0 }, 23, { blocked: true, label: '預購額度已達上限' }],
      ['PRE-UNLIMITED', 'preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 0, line_preorder_enabled: 0, line_preorder_daily: 0, line_preorder_sold: 0 }, 25, { blocked: false, maxQty: 'unlimited(>40)' }],
      // 商品已只能預約（今日售完）＋預購已達上限：同樣停用
      ['PRE-SOLDOUT-AT','preorder', { line_quota_enabled: 1, line_quota_daily: 1, line_quota_sold: 1, line_preorder_enabled: 1, line_preorder_daily: 20, line_preorder_sold: 0 }, 20, { blocked: true, label: '預購額度已達上限' }],
    ];
    for (const [tag, bucket, cfg, qty, exp] of cases) {
      await patchProduct(D, cfg);
      // 預購情境：舊購物車保存「明天」＝顧客已明確選擇未來取餐日期
      const L = await openLinePage(browser, D, { savedCart: { [PID]: qty }, pickupDate: bucket === 'preorder' ? tomorrow : today });
      const restored = await cartQty(L.page);
      const st = await detail(L);
      const okBucket = st.incBucket === bucket && (bucket === 'today' ? st.pDate === today : st.pDate === tomorrow);
      const consistent = st.btnDisabled === !st.incOk; // 詳情可否加入 ＝ checkCartIncrement(…,1).ok
      let ok = restored === qty && okBucket && consistent && st.btnDisabled === exp.blocked;
      if (exp.blocked) ok = ok && st.btnText === exp.label && st.badge === exp.label;
      else ok = ok && st.maxQty === exp.maxQty;
      if (tag === 'PRE-AT(重現)') await L.page.screenshot({ path: path.join(shots, 'c2-preorder-at-limit.png') }).catch(() => {});
      assert(ok, `C2-${tag} 詳情：購物車 ${qty} 份 → ${exp.blocked ? '停用「' + exp.label + '」' : '可加入，上限 ' + exp.maxQty}；與 checkCartIncrement 一致`, JSON.stringify({ restored, ...st }));
      if (exp.addOne != null) {
        // 剩 1 份：詳情正常加入 1 份
        await L.page.evaluate(() => { try { ProductDetailModal.close(); } catch {} }); await sleep(200);
        await L.page.evaluate((id) => openProductDetail(id), PID); await L.page.waitForSelector('.pdm-add-btn'); await sleep(200);
        await L.page.click('.pdm-add-btn'); await sleep(500);
        const after = await cartQty(L.page);
        assert(after === exp.addOne && L.dialogs.length === 0, `C2-${tag}-ADD 剩 1 份時詳情可正常加入 1 份（${qty}→${exp.addOne}）`, `qty=${after} dialogs=${JSON.stringify(L.dialogs)}`);
        const st2 = await detail(L);
        assert(st2.btnDisabled && /已達上限/.test(st2.btnText), `C2-${tag}-THEN-AT 加入後再開詳情即顯示已達上限並停用`, JSON.stringify(st2));
      }
      if (exp.blocked) {
        // 已達／超過上限：商品卡＋與詳情一致被擋；仍可減少／移除
        await L.page.evaluate(() => { try { ProductDetailModal.close(); } catch {} }); await sleep(200);
        await L.page.evaluate((id) => chgQty(id, 1), PID);
        const afterInc = await cartQty(L.page);
        await L.page.evaluate((id) => chgQty(id, -1), PID);
        const afterDec = await cartQty(L.page);
        assert(afterInc === qty && afterDec === qty - 1, `C2-${tag}-DEC 已達上限：＋被擋、仍可減少（${qty}→${afterDec}）`, `inc=${afterInc} dec=${afterDec} dialogs=${JSON.stringify(L.dialogs.slice(-1))}`);
        if (tag.startsWith('PRE-AT')) {
          const st3 = await detail(L);
          assert(!st3.btnDisabled && st3.maxQty === 1, `C2-${tag}-REOPEN 減少 1 份後再開詳情：恢復可加入，上限 1`, JSON.stringify(st3));
          await L.page.evaluate(() => { try { ProductDetailModal.close(); } catch {} }); await sleep(200);
          for (let i = 0; i < qty - 1; i++) await L.page.evaluate((id) => chgQty(id, -1), PID);
          const stored = await L.page.evaluate(() => JSON.parse(localStorage.getItem('line_order_cart_store_001') || '{}').cart || {});
          assert(await cartQty(L.page) === 0 && !stored[PID], `C2-${tag}-REMOVE 可完整移除，保存的購物車同步`, JSON.stringify(stored));
        }
      }
      assert(L.errors.length === 0, `C2-${tag}-NOERR 頁面無 JavaScript 錯誤`, L.errors.join(' | '));
      await L.context.close();
    }
    await D.s.stop();
    }
    if (!ONLY || ONLY.includes('s2')) {
    // ═════════════════ 問題二：三分頁販售標示（真實 index.html）═════════════════
    const dirC = H.tmpDir('hf1c1-c'); const C = await bootServer(dirC, 'combined_checkout'); ctxs.push(C);
    await patchProduct(C, { line_quota_daily: 50, line_quota_sold: 0, line_quota_high_threshold: 10, line_preorder_daily: 50, line_preorder_sold: 0 });
    {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      await context.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '脆豬腰' })); }, [C.tok]);
      const page = await context.newPage();
      const errors = []; const writes = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());
      page.on('request', (r) => { if (['PATCH', 'PUT', 'POST', 'DELETE'].includes(r.method()) && r.url().includes('/api/products')) writes.push(r.method() + ' ' + r.url()); });
      await page.goto(C.s.base + '/');
      await page.waitForFunction(() => typeof window.showPage === 'function' && typeof loadLineProductsPage === 'function');
      await page.evaluate(() => showPage('line_products'));
      await page.waitForSelector(`#lpm-row-${PID}`, { timeout: 15000 });
      const statusText = async (tab) => {
        await page.evaluate((t) => lpmSwitchTab(t), tab); await sleep(150);
        if (tab === 'shipping') return (await page.textContent(`#lpm-ship-row-${PID} td:nth-last-child(2)`)).trim();
        return (await page.textContent(`#lpm-row-${PID} td:nth-last-child(2)`)).trim();
      };
      const colCheck = async () => page.evaluate(() => {
        const out = {};
        const mainHead = document.querySelectorAll('#lpm-table-wrap thead th').length;
        const mainRow = document.querySelector('#lpm-tbody tr');
        const shipHead = document.querySelectorAll('#lpm-shipping-table-wrap thead th').length;
        const shipRow = document.querySelector('#lpm-shipping-tbody tr');
        const span = (tr) => tr ? Array.from(tr.children).reduce((s, td) => s + Number(td.getAttribute('colspan') || 1), 0) : -1;
        out.main = [mainHead, span(mainRow)]; out.ship = [shipHead, span(shipRow)];
        return out;
      });
      const base0 = { today: await statusText('today'), preorder: await statusText('preorder'), shipping: await statusText('shipping') };
      assert(base0.today === '供應充足' && base0.preorder === '可預購' && base0.shipping === '正常販售', 'S2-0 正常販售：今日「供應充足」、預購「可預購」、宅配「正常販售」', JSON.stringify(base0));
      const rowBefore = await productRow(C.dbf);
      // 從 LINE 商品頁（預購分頁）開啟 LINE 設定 → 改暫停販售 → 儲存 → 目前分頁立即刷新
      await page.evaluate(() => lpmSwitchTab('preorder'));
      await page.evaluate((id) => openLineSettingsModal(id), PID);
      await page.waitForFunction(() => { const n = document.getElementById('lineSettingsProductName'); return n && n.textContent && n.textContent !== '載入中…'; }, null, { timeout: 10000 });
      await sleep(300);
      await page.selectOption('#lineSaleStatus', 'paused');
      const writesBeforeSave = writes.length;
      await page.evaluate(() => saveLineSettings());
      await page.waitForFunction((id) => { const r = document.querySelector(`#lpm-row-${id}`); return r && r.textContent.includes('暫停販售'); }, PID, { timeout: 10000 }).catch(() => {});
      const afterSave = (await page.textContent(`#lpm-row-${PID} td:nth-last-child(2)`)).trim();
      assert(afterSave === '暫停販售' && writes.length - writesBeforeSave === 1, 'S2-1 預購分頁儲存 LINE 設定後立即刷新為「暫停販售」（只送出 1 次儲存）', `${afterSave} writes=${writes.slice(writesBeforeSave).join(',')}`);
      await page.screenshot({ path: path.join(shots, 's2-preorder-paused.png') });
      const paused = { today: await statusText('today'), preorder: await statusText('preorder'), shipping: await statusText('shipping') };
      assert(Object.values(paused).every((v) => v === '暫停販售'), 'S2-2 暫停販售：三分頁一致顯示「暫停販售」（剩餘份數充足也不顯示供應充足／可預購）', JSON.stringify(paused));
      await page.screenshot({ path: path.join(shots, 's2-shipping-paused.png') });
      // 長期下架（以 API 改，再在宅配分頁按「重新整理」）
      await H.api(C.s.base, C.tok, 'PATCH', `/api/products/${PID}/line-status`, { sale_status: 'sold_out_indefinitely' });
      await page.evaluate(() => lpmSwitchTab('shipping'));
      const wBefore = writes.length;
      await page.click('button[onclick="loadLineProductsPage()"]');
      await page.waitForFunction((id) => { const r = document.querySelector(`#lpm-ship-row-${id}`); return r && r.textContent.includes('長期下架'); }, PID, { timeout: 10000 }).catch(() => {});
      const shipAfterReload = (await page.textContent(`#lpm-ship-row-${PID} td:nth-last-child(2)`)).trim();
      assert(shipAfterReload === '長期下架', 'S2-3 冷藏宅配分頁按「重新整理」會更新宅配表（長期下架）', shipAfterReload);
      const indef = { today: await statusText('today'), preorder: await statusText('preorder'), shipping: await statusText('shipping') };
      assert(Object.values(indef).every((v) => v === '長期下架'), 'S2-4 長期下架：三分頁一致', JSON.stringify(indef));
      // 今日完售（sale_status=sold_out_today）保留原語意
      await H.api(C.s.base, C.tok, 'PATCH', `/api/products/${PID}/line-status`, { sale_status: 'sold_out_today' });
      await page.evaluate(() => loadLineProductsPage()); await sleep(600);
      const sot = { today: await statusText('today'), preorder: await statusText('preorder'), shipping: await statusText('shipping') };
      assert(Object.values(sot).every((v) => v === '今日完售'), 'S2-5 今日完售：三分頁顯示「今日完售」', JSON.stringify(sot));
      // 恢復正常：舊標籤不殘留
      await H.api(C.s.base, C.tok, 'PATCH', `/api/products/${PID}/line-status`, { sale_status: 'available' });
      await page.evaluate(() => loadLineProductsPage()); await sleep(600);
      const back = { today: await statusText('today'), preorder: await statusText('preorder'), shipping: await statusText('shipping') };
      assert(back.today === '供應充足' && back.preorder === '可預購' && back.shipping === '正常販售', 'S2-6 恢復正常販售：三分頁回到份數／時段狀態，舊標籤不殘留', JSON.stringify(back));
      // LINE 未上架：今日／預購分頁顯示「未上架」（原語意），暫停時優先顯示暫停
      await H.api(C.s.base, C.tok, 'PATCH', `/api/products/${PID}/line-status`, { show_on_line: 0 });
      await page.evaluate(() => loadLineProductsPage()); await sleep(600);
      const unl = { today: await statusText('today'), preorder: await statusText('preorder') };
      assert(unl.today === '未上架' && unl.preorder === '未上架', 'S2-7 LINE 未上架：保留原「未上架」語意', JSON.stringify(unl));
      await H.api(C.s.base, C.tok, 'PATCH', `/api/products/${PID}/line-status`, { show_on_line: 1 });
      // LINE 今日售完（line_sold_out）只影響今日分頁
      await patchProduct(C, { line_sold_out: 1 });
      await page.evaluate(() => loadLineProductsPage()); await sleep(600);
      const lso = { today: await statusText('today'), preorder: await statusText('preorder') };
      assert(lso.today === 'LINE今日售完' && lso.preorder === '可預購', 'S2-8 LINE 今日售完旗標只影響今日分頁', JSON.stringify(lso));
      await patchProduct(C, { line_sold_out: 0 });
      // 狀態渲染不改動資料：切換分頁／渲染期間沒有任何寫入，欄位值不變
      const wRender = writes.length;
      await page.evaluate(() => loadLineProductsPage()); await sleep(500);
      for (const t of ['today', 'preorder', 'shipping', 'today']) await statusText(t);
      const rowAfter = await productRow(C.dbf);
      const keys = ['show_on_line', 'shipping_enabled', 'shipping_share_line_stock', 'line_quota_enabled', 'line_quota_daily', 'line_quota_sold', 'line_preorder_enabled', 'line_preorder_daily', 'line_preorder_sold', 'line_takeout_enabled', 'line_delivery_enabled'];
      const diff = keys.filter((k) => String(rowBefore[k]) !== String(rowAfter[k]));
      assert(writes.length === wRender && diff.length === 0, 'S2-9 狀態渲染不寫入、不改動 LINE 上架／宅配開關／共用份數／份數', `writes=${writes.length - wRender} diff=${diff.join(',')}`);
      // 欄數一致（表頭／資料列／載入中／空資料／錯誤）
      const c1 = await colCheck();
      assert(c1.main[0] === 14 && c1.main[1] === 14 && c1.ship[0] === 12 && c1.ship[1] === 12, 'S2-10 表頭與資料列欄數一致（主表 14、宅配表 12）', JSON.stringify(c1));
      await page.evaluate(() => { document.getElementById('lpm-tbody').innerHTML = ''; });
      const loading = await page.evaluate(async () => {
        const origFetch = window.fetch; let release; const gate = new Promise((r) => { release = r; });
        window.fetch = async (...a) => { if (String(a[0]).includes('line-products/list')) await gate; return origFetch(...a); };
        const p = loadLineProductsPage();
        await new Promise((r) => setTimeout(r, 50));
        const spans = [document.querySelector('#lpm-tbody td').getAttribute('colspan'), document.querySelector('#lpm-shipping-tbody td').getAttribute('colspan')];
        release(); await p; window.fetch = origFetch; return spans;
      });
      assert(loading[0] === '14' && loading[1] === '12', 'S2-11 載入中列 colspan 與表頭一致（14／12）', JSON.stringify(loading));
      const errSpans = await page.evaluate(async () => {
        const origFetch = window.fetch;
        window.fetch = async (...a) => { if (String(a[0]).includes('line-products/list')) return new Response(JSON.stringify({ success: false, message: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); return origFetch(...a); };
        await loadLineProductsPage(); window.fetch = origFetch;
        return [document.querySelector('#lpm-tbody td').getAttribute('colspan'), document.querySelector('#lpm-shipping-tbody td').getAttribute('colspan')];
      });
      assert(errSpans[0] === '14' && errSpans[1] === '12', 'S2-12 錯誤列 colspan 一致（14／12）', JSON.stringify(errSpans));
      const emptySpans = await page.evaluate(() => { renderLpmTable([]); renderLpmShippingTable([]); return [document.querySelector('#lpm-tbody td').getAttribute('colspan'), document.querySelector('#lpm-shipping-tbody td').getAttribute('colspan')]; });
      assert(emptySpans[0] === '14' && emptySpans[1] === '12', 'S2-13 空資料列 colspan 一致（14／12）', JSON.stringify(emptySpans));
      assert(errors.length === 0, 'S2-14 後台頁面無 JavaScript 錯誤', errors.join(' | '));
      await context.close();
    }
    await C.s.stop();
    }
  } catch (e) {
    fail('未預期例外', e.stack);
  } finally {
    await browser.close();
    // 注意：H.startServer().stop() 只檢查 exitCode；以 SIGTERM 結束的程序 exitCode 為 null，
    // 對已停止的伺服器再次 stop() 會永遠等不到 'exit'，導致 Node 事件迴圈清空、以 0 靜默結束
    // 而不印出摘要。這裡只停止仍在執行的伺服器。
    for (const c of ctxs) { const pr = c.s.proc; if (pr.exitCode == null && pr.signalCode == null) { try { await c.s.stop(); } catch {} } }
  }
  const sm = H.summary();
  console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed  (screenshots: ${shots})`);
  const j = process.argv.indexOf('--json'); if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(sm, null, 2));
  process.exit(sm.failCount ? 1 : 0);
})();
