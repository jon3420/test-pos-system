#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js
// R54.4／MBV2-HF1-C3.2 —— 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）：
//   X：舊備份完整取代時，想買登記重新對應遇到商品 ID 互換／三款循環／最終重複有效登記
//   F：一般點餐首屏不被會員 Gate 擋住（LIFF SDK 卡住／載入失敗／驗證被拒／網路延遲），
//      Recovery／Handoff 在身分確認前不提早還原、不送單、不覆蓋本頁新購物車；Gate 晚完成不重複執行；
//      想買登記登入導回只恢復一次。
// LIFF SDK（static.line-scdn.net）由 Playwright 攔截：保持 pending、回傳失敗或回傳測試用替身。
// 安全規則同前：暫存資料庫、本機埠、LINE API 由 hf1c3-net-mock 攔截並計數。
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
const ONLY = process.env.HF1C32_ONLY || ''; // x,f（預設全部）
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
const PNAME2 = '測試對照湯';
// 元素不存在時不丟例外（讓舊版本以斷言失敗呈現，而不是中斷整段驗收）
async function clickIf(page, sel) { const el = await page.$(sel); if (!el) return false; await el.click({ timeout: 5000 }).catch(() => {}); return true; }
const STORE = 'store_001';
async function stateDump(dbf) {
  const db = await H.openDbFile(dbf);
  const out = {};
  for (const [t, ord] of [['products', 'id'], ['orders', 'rowid'], ['product_demand_requests', 'id'], ['product_demand_consents', 'id'], ['categories', 'id'], ['settings', 'key'], ['line_members', 'id'], ['coupons', 'id']]) {
    try { out[t] = H.q(db, `SELECT * FROM ${t} WHERE store_id=? ORDER BY ${ord}`, [STORE]); } catch (e) { out[t] = 'ERR ' + e.message; }
  }
  db.close();
  return JSON.stringify(out);
}
async function legacyBackup(opts) {
  const C = await bootServer(H.tmpDir('c31-src'), opts);
  const full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
  await safeStop(C.s);
  const j = JSON.parse(full.buf.toString('utf8'));
  j.selected_categories = j.selected_categories.filter((c) => c !== 'product_demand');
  for (const t of ['product_demand_requests', 'product_demand_consents']) { if (j.data) delete j.data[t]; if (j.table_counts) delete j.table_counts[t]; }
  return { buf: Buffer.from(JSON.stringify(j)), cats: j.selected_categories };
}
const UA = 'Uc31aaaaaaaaaaaaaaaaaaaaaaaaaa01', UB = 'Uc31bbbbbbbbbbbbbbbbbbbbbbbbbb02', UC = 'Uc31cccccccccccccccccccccccccc03';
async function demandTarget() {
  const T = await bootServer(H.tmpDir('c31-tgt'), { pid: 801, pid2: 802 });
  await patchProduct(T, { sale_status: 'paused' }, 801);
  const A = session(STORE, UA), B = session(STORE, UB), Cc = session(STORE, UC);
  await pub(T, 'POST', '/api/product-demand/register', { member_session: A, product_id: 801, desired_qty: 4, fulfillment_pref: 'takeout' });
  await pub(T, 'POST', '/api/product-demand/register', { member_session: B, product_id: 801, desired_qty: 2 });
  await pub(T, 'POST', '/api/product-demand/register', { member_session: Cc, product_id: 801, desired_qty: 3 });
  await pub(T, 'POST', '/api/product-demand/cancel', { member_session: Cc, product_id: 801 });
  const o = await pub(T, 'POST', '/api/line-orders', { customer_name: '既有訂單', customer_phone: '0912345678', order_type: 'takeout', pickup_date: twDate(1), pickup_time: '12:00', payment_method: 'cash', items: [{ product_id: 802, qty: 1, name: PNAME2, price: 60 }] });
  if (o.status !== 200) throw new Error('seed order failed ' + o.text.slice(0, 200));
  await restart(T, (db) => {
    const ra = H.q1(db, 'SELECT request_uuid FROM product_demand_requests WHERE line_user_id=?', [UA]);
    db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at) VALUES ('c31-g',?,801,?,?,'line','granted','restock-notify-v1',datetime('now'))`, [STORE, UA, ra.request_uuid]);
    db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at,revoked_at) VALUES ('c31-r',?,801,?,'','line','revoked','restock-notify-v1',datetime('now'),datetime('now'))`, [STORE, UB]);
  });
  return { T, A, B };
}
async function demandRowsFile(dbf) {
  const r = await dbRows(dbf, 'SELECT request_uuid,product_id,line_user_id,desired_qty,fulfillment_pref,status,expires_at,cycle_no FROM product_demand_requests WHERE store_id=? ORDER BY id', [STORE]);
  const c = await dbRows(dbf, 'SELECT consent_uuid,product_id,line_user_id,status,request_uuid FROM product_demand_consents WHERE store_id=? ORDER BY id', [STORE]);
  return { r, c };
}
async function replaceImportFormal(ctx, buf, cats) {
  const up = await H.uploadRaw(ctx.s.base, ctx.tok, buf, { name: 'legacy-full.json' });
  const MV2 = require(path.join(H.ROOT, 'utils', 'migrationV2.js'));
  const opts = { mode: 'replace', categories: cats };
  const token = MV2.optionsFingerprint(up.json.upload_id, STORE, opts);
  const im = await H.api(ctx.s.base, ctx.tok, 'POST', '/api/migration/v2/import', { upload_id: up.json.upload_id, ...opts, confirm_text: STORE, password: 'pw001', preview_token: token });
  if (im.status !== 202) return { status: 'http_' + im.status, body: im.json };
  return H.waitJob(ctx.s.base, ctx.tok, im.json.job_id);
}

const UD = 'Uc32dddddddddddddddddddddddddd04';
const P3NAME = '測試第三品';
const addProd = (id, name) => (db) => db.run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,line_takeout_enabled,line_delivery_enabled) VALUES (?,?,?,'飯類',101,80,1,1,'paused',1,1)`, [id, STORE, name]);
const seq = (...fs) => (db) => fs.forEach((f) => f(db));
// 目標店：依清單登記，選擇性設為取消／過期，加上同意；回傳 server ctx
async function remapTarget(bootOpts, regs, consents) {
  const T = await bootServer(H.tmpDir('c32-tgt'), bootOpts);
  for (const pid of [...new Set(regs.map((r) => r.pid))]) await patchProduct(T, { sale_status: 'paused' }, pid);
  for (const r of regs) {
    const x = await pub(T, 'POST', '/api/product-demand/register', { member_session: session(STORE, r.u), product_id: r.pid, desired_qty: r.qty, fulfillment_pref: r.pref || 'any' });
    if (x.status !== 200) throw new Error('seed register ' + x.text.slice(0, 200));
    if (r.state === 'cancelled') await pub(T, 'POST', '/api/product-demand/cancel', { member_session: session(STORE, r.u), product_id: r.pid });
  }
  await restart(T, (db) => {
    for (const r of regs) if (r.state === 'expired') db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 hour') WHERE line_user_id=? AND product_id=? AND status='active'", [r.u, r.pid]);
    let n = 0;
    for (const c of consents || []) {
      const rq = H.q1(db, 'SELECT request_uuid FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id DESC LIMIT 1', [c.u, c.pid]);
      db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at,revoked_at) VALUES (?,?,?,?,?,'line',?,'restock-notify-v1',datetime('now'),?)`,
        ['c32-' + (n++), STORE, c.pid, c.u, rq ? rq.request_uuid : '', c.status, c.status === 'revoked' ? new Date().toISOString() : '']);
    }
  });
  return T;
}
// 依 request_uuid 核對：只有 product_id 依 map 變動，其他欄位完全相同
function checkRemapped(pre, post, map) {
  const by = Object.fromEntries(post.r.map((x) => [x.request_uuid, x]));
  const badR = pre.r.filter((x) => { const y = by[x.request_uuid]; return !y || y.product_id !== map[x.product_id] || y.line_user_id !== x.line_user_id || y.desired_qty !== x.desired_qty || y.fulfillment_pref !== x.fulfillment_pref || y.status !== x.status || y.expires_at !== x.expires_at || y.cycle_no !== x.cycle_no; });
  const cby = Object.fromEntries(post.c.map((x) => [x.consent_uuid, x]));
  const badC = pre.c.filter((x) => { const y = cby[x.consent_uuid]; return !y || y.product_id !== map[x.product_id] || y.status !== x.status || y.line_user_id !== x.line_user_id || y.request_uuid !== x.request_uuid; });
  return { ok: pre.r.length === post.r.length && pre.c.length === post.c.length && !badR.length && !badC.length, badR, badC };
}
async function expectedStats(dbf) {
  return dbRows(dbf, "SELECT product_id, COUNT(DISTINCT line_user_id) AS users, SUM(desired_qty) AS qty FROM product_demand_requests WHERE store_id=? AND status='active' AND expires_at > datetime('now') GROUP BY product_id ORDER BY product_id", [STORE]);
}
// 測試用 LIFF SDK 替身：isLoggedIn／isInClient=true，ID Token 為假值 → 後端驗證一定被拒（不呼叫真實 LINE）
const FAKE_LIFF = `window.liff={init:async()=>{},ready:Promise.resolve(),isLoggedIn:()=>true,isInClient:()=>true,
  getIDToken:()=>'fake.id.token',getAccessToken:()=>'fake-access-token',getProfile:async()=>({userId:'Ufakeprofile',displayName:'Fake'}),
  getFriendship:async()=>({friendFlag:true}),requestFriendship:async()=>({}),login:()=>{},logout:()=>{},openWindow:()=>{},
  getOS:()=>'web',getLanguage:()=>'zh-TW',getContext:()=>({}),isApiAvailable:()=>true};`;
// 結帳前會員模式：頁面載入即初始化 LIFF（/shop 未提供 auto_identify 欄位，改以 gate_enabled＋checkout 觸發），
// 但不強制進站登入，一般瀏覽可用。
const LIFF_SEED = (db) => {
  for (const [k, v] of [['line_member_liff_id', '2000000000-c32test'], ['line_member_gate_enabled', '1'], ['line_member_gate_mode', 'checkout']]) {
    db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, v]);
  }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C3.2 首屏與會員 Gate／登記重新對應 驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const ctxs = [];
  try {
    // ═════════════════ X：商品 ID 互換／循環／最終衝突 ═════════════════
    if (run('x')) {
      // X1 801↔701 互換：目標 801=招牌飯、701=對照湯；備份 701=招牌飯、801=對照湯
      {
        const L = await legacyBackup({ pid: 701, pid2: 801 });
        const regs = [
          { u: UA, pid: 801, qty: 4, pref: 'takeout' }, { u: UA, pid: 701, qty: 2, pref: 'delivery' },   // 同一會員兩款
          { u: UB, pid: 701, qty: 5 },                                                                   // 不同會員
          { u: UC, pid: 801, qty: 3, state: 'cancelled' }, { u: UC, pid: 801, qty: 1 },                  // 取消後重新登記（週期 2）
          { u: UD, pid: 701, qty: 7, state: 'expired' },                                                 // 過期（DB 仍為 active）
        ];
        const T = await remapTarget({ pid: 801, pid2: 701 }, regs, [{ u: UA, pid: 801, status: 'granted' }, { u: UB, pid: 701, status: 'revoked' }]);
        ctxs.push(T);
        await safeStop(T.s); const pre = await demandRowsFile(T.dbf); await restart(T);
        const pushBefore = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
        const up = await H.uploadRaw(T.s.base, T.tok, L.buf, { name: 'legacy.json' });
        const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'replace', categories: L.cats, confirm_text: STORE, password: 'pw001' });
        const pv = res.preview && (res.preview.result ? res.preview.result.demand_remap : res.preview.error);
        const im = res.import && (res.import.result ? res.import.result.demand_remap : res.import.error);
        const want = [{ from: 801, to: 701 }, { from: 701, to: 801 }];
        const okMap = (x) => Array.isArray(x) && want.every((w) => x.some((y) => y.from === w.from && y.to === w.to));
        assert(res.preview && res.preview.status === 'done' && okMap(pv), 'X1-1 互換：預覽成功並回報 801→701、701→801', JSON.stringify(pv));
        assert(res.import && res.import.status === 'done' && JSON.stringify(im) === JSON.stringify(pv), 'X1-2 互換：正式匯入成功，對應與預覽相同（未撞 active 唯一索引）', JSON.stringify(im));
        await safeStop(T.s);
        const post = await demandRowsFile(T.dbf);
        const chk = checkRemapped(pre, post, { 801: 701, 701: 801 });
        assert(chk.ok, 'X1-3 互換：每筆登記與同意只改商品關聯；會員、份數、偏好、週期、期限、狀態、同意關聯不變', JSON.stringify(chk));
        const dup = await dbRows(T.dbf, "SELECT product_id,line_user_id,COUNT(*) c FROM product_demand_requests WHERE store_id=? AND status='active' GROUP BY 1,2 HAVING c>1", [STORE]);
        const orphan = await dbRows(T.dbf, 'SELECT COUNT(*) c FROM product_demand_requests r WHERE store_id=? AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=r.product_id AND p.store_id=r.store_id)', [STORE]);
        const idx = await dbRows(T.dbf, "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pdr_active_unique'");
        assert(dup.length === 0 && Number(orphan[0].c) === 0 && idx.length === 1, 'X1-4 互換：無重複有效登記、無孤兒，active 唯一索引仍存在', JSON.stringify({ dup, orphan, idx }));
        const prods = await dbRows(T.dbf, 'SELECT id,name FROM products WHERE store_id=? AND id IN (701,801) ORDER BY id', [STORE]);
        assert(prods.map((p) => p.id + ':' + p.name).join(',') === `701:${PNAME},801:${PNAME2}`, 'X1-5 互換：商品以備份為準（701=招牌飯、801=對照湯）', JSON.stringify(prods));
        const exp = await expectedStats(T.dbf);
        await restart(T);
        const sum = (await H.api(T.s.base, T.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products;
        const g = (pid) => sum.find((p) => p.product_id === pid) || { active_users: 0, total_qty: 0 };
        assert(g(701).active_users === 2 && g(701).total_qty === 5 && g(801).active_users === 2 && g(801).total_qty === 7 && JSON.stringify(exp.map((e) => [e.product_id, e.users, e.qty])) === JSON.stringify([[701, 2, 5], [801, 2, 7]]),
          'X1-6 互換：後台統計招牌飯(701) 2 人 5 份、對照湯(801) 2 人 7 份（排除取消與過期，與資料庫一致）', JSON.stringify({ s701: g(701), s801: g(801), exp }));
        const mA = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UA) })).json.data;
        const mB = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UB) })).json.data;
        const mD = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UD) })).json.data;
        const fa = (pid) => mA.find((x) => x.product_id === pid) || {};
        // R54.4／MBV2-HF1-C4 調整：A 的同意為 C3 版本（restock-notify-v1）且經匯入 → 需顧客重新確認（reconfirm_required）；其餘條件不變。
        assert(mA.length === 2 && fa(701).product_name === PNAME && fa(701).desired_qty === 4 && fa(701).fulfillment_pref === 'takeout' && fa(701).notify_consent === 'reconfirm_required'
          && fa(801).product_name === PNAME2 && fa(801).desired_qty === 2 && fa(801).fulfillment_pref === 'delivery' && mB.length === 1 && mB[0].product_id === 801 && mB[0].product_name === PNAME2 && mB[0].notify_consent === 'revoked' && mD.length === 0,
          'X1-7 互換：本人查詢 A＝招牌飯 4 份(外帶,同意需重新確認)＋對照湯 2 份(外送)；B＝對照湯 5 份(已撤回)；D 過期不顯示', JSON.stringify({ mA, mB, mD }));
        assert(fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length === pushBefore, 'X1-8 互換：未觸發任何推播', '');
        await safeStop(T.s);
      }
      // X2 三款循環：目標 801=招牌飯、802=對照湯、803=第三品；備份 802=招牌飯、803=對照湯、801=第三品
      {
        const L = await legacyBackup({ pid: 802, pid2: 803, extraSeed: addProd(801, P3NAME) });
        const regs = [{ u: UA, pid: 801, qty: 1 }, { u: UA, pid: 802, qty: 2 }, { u: UA, pid: 803, qty: 3 }, { u: UB, pid: 802, qty: 9, state: 'cancelled' }, { u: UB, pid: 803, qty: 6 }];
        const T = await remapTarget({ pid: 801, pid2: 802, extraSeed: addProd(803, P3NAME) }, regs, [{ u: UA, pid: 803, status: 'granted' }]);
        ctxs.push(T);
        await safeStop(T.s); const pre = await demandRowsFile(T.dbf); await restart(T);
        const up = await H.uploadRaw(T.s.base, T.tok, L.buf, { name: 'legacy.json' });
        const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'replace', categories: L.cats, confirm_text: STORE, password: 'pw001' });
        assert(res.preview && res.preview.status === 'done' && res.import && res.import.status === 'done', 'X2-1 三款循環（801→802→803→801）：預覽與正式匯入皆成功', JSON.stringify(res.preview && (res.preview.error || res.preview.status)) + ' / ' + JSON.stringify(res.import && (res.import.error || res.import.status)));
        await safeStop(T.s);
        const post = await demandRowsFile(T.dbf);
        const chk = checkRemapped(pre, post, { 801: 802, 802: 803, 803: 801 });
        assert(chk.ok, 'X2-2 三款循環：各筆依名稱對應到新商品，其他欄位與同意關聯不變', JSON.stringify(chk));
        await restart(T);
        const mA = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UA) })).json.data;
        const nm = Object.fromEntries(mA.map((x) => [x.product_name, x.desired_qty]));
        const sum = (await H.api(T.s.base, T.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products;
        const g = (pid) => sum.find((p) => p.product_id === pid) || { active_users: 0, total_qty: 0 };
        assert(nm[PNAME] === 1 && nm[PNAME2] === 2 && nm[P3NAME] === 3 && g(802).total_qty === 1 && g(803).total_qty === 2 && g(801).active_users === 2 && g(801).total_qty === 9,
          'X2-3 三款循環：本人查詢依商品名稱份數正確；後台 802(招牌飯)=1、803(對照湯)=2、801(第三品)=2 人 9 份', JSON.stringify({ nm, s801: g(801), s802: g(802), s803: g(803) }));
        await safeStop(T.s);
      }
      // X3 最終衝突：目標 801 與 803 同名（招牌飯），同一會員對兩者都有有效登記；備份只有一款招牌飯
      {
        const L = await legacyBackup({ pid: 701, pid2: 702 });
        const T = await remapTarget({ pid: 801, pid2: 802, extraSeed: addProd(803, PNAME) }, [{ u: UA, pid: 801, qty: 2 }, { u: UA, pid: 803, qty: 3 }, { u: UB, pid: 802, qty: 1 }], []);
        ctxs.push(T);
        await safeStop(T.s); const before = await stateDump(T.dbf); await restart(T);
        const up = await H.uploadRaw(T.s.base, T.tok, L.buf, { name: 'legacy.json' });
        const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'replace', categories: L.cats, confirm_text: STORE, password: 'pw001' });
        const pe = (res.preview && res.preview.error) || {};
        const fails = pe.demand_remap_failures || [];
        assert(res.preview && res.preview.status === 'error' && pe.code === 'DEMAND_PRODUCT_REMAP_FAILED' && fails.some((f) => f.reason === 'final_conflict' && f.new_product_id === 701) && !res.import,
          'X3-1 最終衝突（兩個舊商品對應到同一新商品，同會員兩筆有效登記）：預覽明確拒絕', JSON.stringify(pe));
        const formal = await replaceImportFormal(T, L.buf, L.cats);
        assert(formal.status === 'error' && formal.error && formal.error.code === 'DEMAND_PRODUCT_REMAP_FAILED', 'X3-2 最終衝突：正式匯入（略過預覽）同樣拒絕', JSON.stringify(formal.error || formal));
        await safeStop(T.s);
        assert((await stateDump(T.dbf)) === before, 'X3-3 最終衝突：商品、訂單、登記、同意、分類、設定、會員、優惠券完全不變', '');
        await restart(T);
        const mA = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UA) })).json.data;
        assert(mA.length === 2 && mA.map((x) => x.product_id).sort().join(',') === '801,803', 'X3-4 最終衝突：拒絕後本人查詢維持原狀', JSON.stringify(mA));
        await safeStop(T.s);
      }
    }

    // ═════════════════ F：首屏、會員 Gate、Recovery／Handoff ═════════════════
    if (run('f')) {
      const C = await bootServer(H.tmpDir('c32-f'), { extraSeed: LIFF_SEED }); ctxs.push(C);
      await patchProduct(C, { sale_status: 'available' }, PID2);
      await patchProduct(C, { sale_status: 'paused' }, PID); // 想買登記用（暫停販售才可新增登記）
      const SKEY = 'line_member_session_store_001', PKEY = 'pd_pending_open_store_001';
      const sessVal = (tok) => JSON.stringify({ member_session: tok, display_name: '測試會員', is_friend: true, expires_at: Date.now() + 3600e3 });
      // sdk: 'hold'（pending，可稍後放行）| 'fail'（載入失敗）| 'fake'（測試替身）
      async function openF({ sdk = 'hold', query = '', member = null, pending = false, savedCart = null, memberApiDelay = 0, handoffMock = null } = {}) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([pk, pv, sk, sv, ck, cv]) => {
          if (!sessionStorage.getItem('__seeded')) {
            if (pv) sessionStorage.setItem(pk, pv); if (sv) localStorage.setItem(sk, sv); if (cv) localStorage.setItem(ck, cv);
            sessionStorage.setItem('__seeded', '1');
          }
          window.__pdOpens = 0;
          document.addEventListener('DOMContentLoaded', () => {
            let was = false;
            new MutationObserver(() => { const ov = document.getElementById('demandOverlay'); const now = !!(ov && ov.classList.contains('show')); if (now && !was) window.__pdOpens++; was = now; })
              .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
          });
        }, [PKEY, pending ? JSON.stringify({ pid: PID, at: Date.now() }) : '', SKEY, member || '', 'line_order_cart_store_001',
          savedCart ? JSON.stringify({ version: 1, store_id: STORE, cart_created_at: Date.now() - 60e3, cart_updated_at: Date.now() - 60e3, cart: savedCart, order_mode: 'takeout', customer: { name: '', phone: '' }, coupon_code: '', pickup_date: twDate(0), pickup_time: '', payment_method: '', order_note: '' }) : '']);
        const page = await context.newPage();
        const st = { sdkRequests: 0, held: null, errors: [], orderPosts: 0, recoveryCalls: 0, handoffCalls: 0 };
        await page.route('https://static.line-scdn.net/**', async (route) => {
          st.sdkRequests++;
          if (sdk === 'fail') return route.abort('failed');
          if (sdk === 'fake') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF });
          st.held = route; // 保持 pending
        });
        if (memberApiDelay) await page.route('**/api/line-member/**', async (route) => { await sleep(memberApiDelay); route.continue(); });
        if (handoffMock) await page.route('**/api/line-checkout-handoff/restore**', async (route) => { st.handoffCalls++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(handoffMock) }); });
        page.on('pageerror', (e) => st.errors.push(e.message));
        page.on('request', (r) => {
          if (r.method() !== 'POST') return;
          if (/\/api\/line-orders(\?|$)/.test(r.url())) st.orderPosts++;
          if (/\/api\/cart-recovery\//.test(r.url())) st.recoveryCalls++;
        });
        const t0 = Date.now();
        await page.goto(`${C.s.base}/line-order.html?store_id=store_001${query}`, { waitUntil: 'domcontentloaded' });
        let shownMs = null;
        try { await page.waitForFunction(() => { const c = document.getElementById('content'); return c && getComputedStyle(c).display !== 'none' && document.querySelectorAll('.prod-card').length > 0; }, null, { timeout: 8000 }); shownMs = Date.now() - t0; } catch {}
        st.release = async () => { if (st.held) { const r = st.held; st.held = null; await r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF }); } };
        return { context, page, st, shownMs };
      }
      const view = (page) => page.evaluate(() => ({
        content: getComputedStyle(document.getElementById('content')).display, loading: getComputedStyle(document.getElementById('loading')).display,
        cards: document.querySelectorAll('.prod-card').length, cart: JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty]))),
        banner: !!document.getElementById('restorePendingBanner'), skip: !!document.getElementById('restoreSkipBtn'), liff: typeof window.liff,
        session: !!(window.LineMemberGate && LineMemberGate.getMemberSession('store_001')),
      }));
      const c0 = await liveCounters(C);
      // F1 一般瀏覽、會員 Gate 持續 pending
      { const L = await openF({ sdk: 'hold' }); const v = await view(L.page);
        assert(L.shownMs != null && v.content !== 'none' && v.loading === 'none' && v.cards > 0 && L.st.sdkRequests === 1 && v.liff === 'undefined' && !v.banner,
          'F1-1 一般瀏覽、LIFF SDK 持續 pending：商品頁已顯示、loading 已隱藏、無還原鎖定', JSON.stringify({ shownMs: L.shownMs, v, sdk: L.st.sdkRequests }));
        await clickIf(L.page, `#pc-${PID2} .add-btn`); await sleep(300);
        assert((await view(L.page)).cart === `{"${PID2}":1}`, 'F1-2 Gate pending 時一般購物車操作可用', '');
        await L.page.evaluate(() => openCartSheet()); await sleep(800);
        assert(await L.page.evaluate(() => document.getElementById('cartSheet').classList.contains('show') || getComputedStyle(document.getElementById('cartSheet')).display !== 'none'), 'F1-3 Gate pending 時可開啟購物車', '');
        assert(L.st.errors.length === 0, 'F1-4 頁面無 JavaScript 錯誤', L.st.errors.join(' | '));
        await L.context.close(); }
      // F2 SDK 載入失敗
      { const L = await openF({ sdk: 'fail' }); await sleep(1200); const v = await view(L.page);
        await clickIf(L.page, `#pc-${PID2} .add-btn`); await sleep(300);
        assert(L.st.sdkRequests === 1 && L.shownMs != null && v.content !== 'none' && v.cards > 0 && (await view(L.page)).cart === `{"${PID2}":1}` && L.st.errors.length === 0, 'F2 LIFF SDK 載入失敗：商品頁正常顯示並可加入購物車，無例外', JSON.stringify({ shownMs: L.shownMs, v, e: L.st.errors }));
        await L.context.close(); }
      // F3 會員驗證被拒（SDK 替身＋假 ID Token，後端驗證失敗）
      { const L = await openF({ sdk: 'fake' }); await sleep(2500); const v = await view(L.page);
        await clickIf(L.page, `#pc-${PID2} .add-btn`); await sleep(300);
        assert(L.shownMs != null && v.content !== 'none' && v.liff === 'object' && !v.session && (await view(L.page)).cart === `{"${PID2}":1}` && L.st.errors.length === 0, 'F3 會員驗證被拒：未取得 session，商品頁與購物車正常', JSON.stringify({ shownMs: L.shownMs, v, e: L.st.errors }));
        await L.context.close(); }
      // F4 會員相關網路操作延遲 8 秒
      { const L = await openF({ sdk: 'fake', memberApiDelay: 8000 }); const v = await view(L.page);
        assert(L.st.sdkRequests === 1 && L.shownMs != null && L.shownMs < 6000 && v.content !== 'none' && v.cards > 0, 'F4 會員 API 延遲 8 秒：商品頁不等待即顯示', JSON.stringify({ shownMs: L.shownMs, v }));
        await L.context.close(); }
      // F5 想買登記登入導回：Gate pending 時不恢復（紀錄保留）；Gate 完成後只恢復一次；重新整理不再恢復
      { const L = await openF({ sdk: 'hold', pending: true, member: sessVal(session(STORE, UA)) });
        await sleep(1500);
        const a = await L.page.evaluate(([pk]) => ({ open: !!document.getElementById('demandOverlay')?.classList.contains('show'), pending: !!sessionStorage.getItem(pk) }), [PKEY]);
        await L.st.release(); await sleep(2500);
        const b = await L.page.evaluate(([pk]) => ({ open: !!document.getElementById('demandOverlay')?.classList.contains('show'), form: !!document.getElementById('dmSubmit'), opens: window.__pdOpens, pending: !!sessionStorage.getItem(pk), cart: Object.keys(cart).length }), [PKEY]);
        assert(!a.open && a.pending && b.open && b.form && b.opens === 1 && !b.pending && b.cart === 0, 'F5-1 登入導回：Gate 完成前不恢復（保留紀錄），完成後恢復一次登記表單、不加購物車', JSON.stringify({ a, b }));
        await L.page.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000);
        const c = await L.page.evaluate(() => ({ opens: window.__pdOpens }));
        assert(c.opens === 0, 'F5-2 重新整理後不再重複恢復', JSON.stringify(c));
        await L.context.close(); }
      // F5-3 導回時商品已不符合新增登記條件（恢復販售）：不開表單、不消耗紀錄（待有效期限結束），並提示
      { await patchProduct(C, { sale_status: 'available' }, PID);
        const L = await openF({ sdk: 'fake', pending: true, member: sessVal(session(STORE, UB)) }); await sleep(2500);
        const r = await L.page.evaluate(([pk]) => ({ opens: window.__pdOpens, pending: !!sessionStorage.getItem(pk), toast: (document.getElementById('toast') || {}).textContent || '' }), [PKEY]);
        assert(r.opens === 0 && r.pending && /未開放補貨登記/.test(r.toast) /* C4.2 文案 */, 'F5-3 導回時商品已恢復販售：不開表單、不消耗待恢復紀錄、提示顧客', JSON.stringify(r));
        await L.context.close();
        await patchProduct(C, { sale_status: 'paused' }, PID); }
      // F6 Recovery：身分未確認前鎖住購物車與送單、不呼叫還原 API；Gate 完成（驗證被拒）後解鎖，不覆蓋購物車
      { const L = await openF({ sdk: 'hold', query: '&recovery_token=rt-c32-test', savedCart: { [PID2]: 2 } });
        await sleep(1200);
        const v = await view(L.page);
        await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(300);
        await L.page.evaluate(() => submitOrder({ isTrusted: true, type: 'click' })).catch(() => {}); await sleep(500);
        const v2 = await view(L.page);
        assert(L.shownMs != null && v.content !== 'none' && v.banner && v.cart === `{"${PID2}":2}` && v2.cart === `{"${PID2}":2}` && L.st.recoveryCalls === 0 && L.st.orderPosts === 0,
          'F6-1 Recovery 身分未確認：商品頁可瀏覽、顯示還原中提示，購物車異動與送單被鎖、未呼叫還原 API', JSON.stringify({ v, v2, rec: L.st.recoveryCalls, ord: L.st.orderPosts }));
        await sleep(5500);
        const v3 = await view(L.page);
        await L.st.release(); await sleep(3000);
        const v4 = await view(L.page);
        const notice = await L.page.evaluate(() => document.body.innerText.includes('無法驗證 LINE 會員身分'));
        assert(v3.skip && !v4.banner && v4.cart === `{"${PID2}":2}` && notice && L.st.orderPosts === 0 && L.st.sdkRequests === 1, 'F6-2 Gate 晚完成（驗證被拒）：解除鎖定、顯示身分提示，購物車未被覆蓋、未送單、SDK 只載入一次', JSON.stringify({ v3, v4, notice, sdk: L.st.sdkRequests }));
        await clickIf(L.page, '#recoveryNoticeCloseBtn'); await sleep(300); // 既有身分提示為對話框，先關閉
        await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(300);
        assert((await view(L.page)).cart === `{"${PID2}":3}`, 'F6-3 關閉身分提示後購物車操作恢復（鎖已解除）', (await view(L.page)).cart);
        await L.context.close(); }
      // F7 Handoff：未略過 → Gate 完成後套用還原一次、只呼叫一次還原 API、不送單
      const handoffOk = { ok: true, cart: { items: [{ product_id: PID2, qty: 5 }] }, checkout_context: { order_type: 'takeout' } };
      { const L = await openF({ sdk: 'hold', query: '&mode=checkout&cart_token=ct-c32-a', savedCart: { [PID2]: 1 }, member: sessVal(session(STORE, UA)), handoffMock: handoffOk });
        await sleep(1000); const v = await view(L.page);
        await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(300);
        const v1 = await view(L.page);
        await L.st.release(); await sleep(3000);
        const v2 = await view(L.page);
        assert(v.banner && v1.cart === `{"${PID2}":1}` && L.st.handoffCalls === 1 && v2.cart === `{"${PID2}":5}` && !v2.banner && L.st.orderPosts === 0 && L.st.sdkRequests === 1,
          'F7 Handoff：身分確認前鎖住購物車，Gate 完成後套用還原一次（5 份）、只呼叫一次還原 API、未送單', JSON.stringify({ v, v1, v2, calls: L.st.handoffCalls, ord: L.st.orderPosts }));
        await L.context.close(); }
      // F8 Handoff：顧客明確選擇「先繼續點餐」並調整購物車 → 延遲還原不覆蓋
      { const L = await openF({ sdk: 'hold', query: '&mode=checkout&cart_token=ct-c32-b', savedCart: { [PID2]: 1 }, member: sessVal(session(STORE, UA)), handoffMock: handoffOk });
        await sleep(6800);
        const hasSkip = (await view(L.page)).skip;
        await clickIf(L.page, '#restoreSkipBtn'); await sleep(200);
        await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(300);
        const v1 = await view(L.page);
        await L.st.release(); await sleep(3000);
        const v2 = await view(L.page);
        const stored = await L.page.evaluate(() => JSON.parse(localStorage.getItem('line_order_cart_store_001') || '{}').cart || {});
        // R54.4／MBV2-HF1-C3.3：略過＝明確取消本次還原 → 尚未發出的還原請求不再發出（呼叫 0 次，C3.2 為 1 次後不覆蓋）
        assert(hasSkip && v1.cart === `{"${PID2}":2}` && v2.cart === `{"${PID2}":2}` && Number(stored[PID2]) === 2 && L.st.handoffCalls === 0 && L.st.orderPosts === 0,
          'F8 Handoff：顧客先繼續點餐並加到 2 份 → 本次還原已取消（不再呼叫還原 API）、購物車維持 2 份、未送單', JSON.stringify({ hasSkip, v1, v2, stored, calls: L.st.handoffCalls }));
        await L.context.close(); }
      const c1 = await liveCounters(C);
      assert(c1.orders === c0.orders, 'F9 整段首屏／Gate 測試：未建立任何訂單', JSON.stringify({ c0, c1 }));
      await safeStop(C.s);
    }
    const pushTotal = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
    assert(pushTotal === 0, 'Z1 整個驗收過程 LINE API／推播呼叫次數為 0', String(pushTotal));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    for (const c of ctxs) { try { await safeStop(c.s); } catch {} }
    await browser.close();
  }
  const { passCount, failCount, results } = H.summary();
  if (process.env.HF1C32_RESULT_JSON) fs.writeFileSync(process.env.HF1C32_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed`);
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
