#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js
// R54.4／MBV2-HF1-C3.3 —— 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）：
//   K：顧客點「先繼續點餐」＝明確取消本次 Recovery／Handoff 還原。延遲回應（Playwright 保留回應後再放行）
//      不得寫入購物車／localStorage、綁定 token、開啟結帳、改變付款流程或顯示還原成功；
//      包含：未改商品、只改姓名／地址／日期／取餐方式、以正式送單路由完成現金訂單後才放行、
//      有加減商品、未略過時正常還原一次、取消與回應幾乎同時。
// 還原 API 由 Playwright 攔截並保留回應（不呼叫正式付款或 LINE API）；訂單以正式 POST /api/line-orders 建立於暫存資料庫。
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
const ONLY = process.env.HF1C33_ONLY || ''; // k（預設全部）
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

// 結帳前不強制登入（gate 關閉），只設 LIFF ID：Handoff（cart_token）仍會初始化 LIFF
const LIFF_NOGATE = (db) => {
  for (const [k, v] of [['line_member_liff_id', '2000000000-c33test'], ['line_member_gate_enabled', '0'], ['line_member_gate_mode', 'disabled']]) {
    db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, v]);
  }
};
const HANDOFF_BODY = () => ({ ok: true, cart: { items: [{ product_id: PID2, qty: 5 }] },
  checkout_context: { order_type: 'takeout', customer_name: '還原姓名', customer_phone: '0911111111', delivery_address: '還原地址', pickup_date: twDate(0), payment_method: 'cash' } });
const RECOVERY_BODY = { success: true, resume_type: 'checkout', cart: { items: [{ product_id: PID2, qty: 4 }] } };

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C3.3 略過還原＝明確取消 驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const ctxs = [];
  try {
    if (run('k')) {
      const C = await bootServer(H.tmpDir('c33-k'), { extraSeed: LIFF_NOGATE }); ctxs.push(C);
      await patchProduct(C, { sale_status: 'available' }, PID2);
      const SKEY = 'line_member_session_store_001', CKEY = 'line_order_cart_store_001';
      const A = session(STORE, UA);
      const sessVal = (tok) => JSON.stringify({ member_session: tok, display_name: '測試會員', is_friend: true, expires_at: Date.now() + 3600e3 });
      // kind: 'handoff' | 'recovery'
      async function openK(kind, { sdk = 'fake', member = sessVal(A) } = {}) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        const saved = JSON.stringify({ version: 1, store_id: STORE, cart_created_at: Date.now() - 600e3, cart_updated_at: Date.now() - 600e3, cart: { [PID2]: 1 },
          order_mode: 'takeout', customer: { name: '原本姓名', phone: '0912345678' }, coupon_code: '', pickup_date: twDate(0), pickup_time: '', payment_method: '', order_note: '' });
        await context.addInitScript(([sk, sv, ck, cv]) => {
          if (!sessionStorage.getItem('__seeded')) { if (sv) localStorage.setItem(sk, sv); localStorage.setItem(ck, cv); sessionStorage.setItem('__seeded', '1'); }
          window.__toasts = [];
          document.addEventListener('DOMContentLoaded', () => {
            const t = document.getElementById('toast');
            if (t) new MutationObserver(() => { if (t.textContent) window.__toasts.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true });
          });
        }, [SKEY, member || '', CKEY, saved]);
        const page = await context.newPage();
        const st = { sdkHeld: null, handoff: [], recRestore: [], recResolve: 0, handoffCalls: 0, recRestoreCalls: 0, orderPosts: 0, errors: [] };
        await page.route('https://static.line-scdn.net/**', async (route) => {
          if (sdk === 'hold') { st.sdkHeld = route; return; }
          route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF });
        });
        await page.route('**/api/line-checkout-handoff/restore**', async (route) => { st.handoffCalls++; st.handoff.push(route); });
        await page.route('**/api/cart-recovery/resolve-target**', async (route) => { st.recResolve++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { page_type: 'line_order' } }) }); });
        await page.route('**/api/cart-recovery/restore**', async (route) => { st.recRestoreCalls++; st.recRestore.push(route); });
        page.on('pageerror', (e) => st.errors.push(e.message));
        page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/line-orders(\?|$)/.test(r.url())) st.orderPosts++; });
        const q = kind === 'handoff' ? '&mode=checkout&cart_token=ct-c33-' + Math.random().toString(36).slice(2) : '&recovery_token=rt-c33-' + Math.random().toString(36).slice(2);
        await page.goto(`${C.s.base}/line-order.html?store_id=store_001${q}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('.prod-card').length > 0 && getComputedStyle(document.getElementById('content')).display !== 'none', null, { timeout: 15000 });
        st.releaseSdk = async () => { if (st.sdkHeld) { const r = st.sdkHeld; st.sdkHeld = null; await r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF }); } };
        st.release = async () => {
          const body = kind === 'handoff' ? HANDOFF_BODY() : RECOVERY_BODY;
          const list = kind === 'handoff' ? st.handoff : st.recRestore;
          while (list.length) { const r = list.shift(); await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {}); }
        };
        st.waitRequest = async () => { for (let i = 0; i < 60; i++) { if ((kind === 'handoff' ? st.handoffCalls : st.recRestoreCalls) > 0) return true; await sleep(100); } return false; };
        return { context, page, st };
      }
      const S = (page) => page.evaluate(([ck]) => {
        let stored = null; try { stored = JSON.parse(localStorage.getItem(ck) || 'null'); } catch (e) {}
        return {
          cart: JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty]))),
          storedCart: stored ? JSON.stringify(stored.cart || {}) : null, storedName: stored && stored.customer ? stored.customer.name : null,
          cartSheet: document.getElementById('cartSheet').classList.contains('show'),
          restoredToast: (window.__toasts || []).some((t) => /成功還原/.test(t)), toasts: (window.__toasts || []).slice(-3),
          bannerText: (document.getElementById('restorePendingText') || {}).textContent || '', skipBtn: !!document.getElementById('restoreSkipBtn'),
          token: typeof _activeCartHandoffToken === 'undefined' ? 'undef' : _activeCartHandoffToken,
          cancelled: _identityRestore.cancelled, committed: _identityRestore.committed,
          name: document.getElementById('cName').value, mode: currentMode, pDate: document.getElementById('pDate').value,
          addr: (document.getElementById('deliveryAddress') || {}).value || '', session: !!LineMemberGate.getMemberSession('store_001'),
          payPanel: !!document.getElementById('recoveryPaymentPanel'),
        };
      }, [CKEY]);
      const skip = async (L) => { await L.page.waitForSelector('#restoreSkipBtn', { timeout: 9000 }).catch(() => {}); await clickIf(L.page, '#restoreSkipBtn'); await sleep(200); };
      const c0 = await liveCounters(C);

      for (const kind of ['handoff', 'recovery']) {
        const tag = kind === 'handoff' ? 'Handoff' : 'Recovery';
        // K1 略過後沒有改商品：在途回應不套用
        { const L = await openK(kind); const sent = await L.st.waitRequest();
          await skip(L); const a = await S(L.page);
          await L.st.release(); await sleep(1500); const b = await S(L.page);
          assert(sent && a.bannerText === '已略過本次購物車還原，你可以繼續點餐。' && a.cancelled, `K1-1 ${tag}：還原請求在途時點「先繼續點餐」→ 顯示「已略過本次購物車還原，你可以繼續點餐。」`, JSON.stringify(a));
          assert(b.cart === `{"${PID2}":1}` && b.storedCart === `{"${PID2}":1}` && !b.cartSheet && !b.restoredToast && (b.token === null || b.token === 'undef' || !b.token) && !b.committed && b.storedName === '原本姓名' && L.st.orderPosts === 0,
            `K1-2 ${tag}：延遲回應抵達後不寫購物車／localStorage、不綁 token、不開結帳、不顯示還原成功、不送單`, JSON.stringify(b));
          assert(b.session === a.session, `K1-3 ${tag}：略過不改變會員登入狀態（不代表驗證成功）`, '');
          assert(L.st.errors.length === 0, `K1-4 ${tag}：頁面無 JavaScript 錯誤`, L.st.errors.join(' | '));
          await L.context.close(); }
        // K2 略過後只修改姓名、地址、日期或取餐方式
        { const L = await openK(kind); await L.st.waitRequest(); await skip(L);
          await L.page.evaluate(() => { openCartSheet(); });
          await sleep(800);
          await L.page.evaluate(() => _enterCheckoutStage()); await sleep(300);
          await L.page.evaluate(() => selectFulfillmentMode('delivery')); await sleep(400);
          await L.page.fill('#deliveryAddress', '本頁新地址 123 號').catch(() => {});
          const dates = await L.page.$$eval('#pDate option', (os) => os.map((o) => o.value).filter(Boolean));
          const newDate = dates.find((d) => d !== twDate(0)) || dates[0];
          await L.page.selectOption('#pDate', newDate); await L.page.dispatchEvent('#pDate', 'change'); await sleep(300);
          await L.page.fill('#cName', '本頁新姓名'); await L.page.dispatchEvent('#cName', 'input');
          const a = await S(L.page);
          await L.st.release(); await sleep(1500); const b = await S(L.page);
          assert(a.name === '本頁新姓名' && a.mode === 'delivery' && a.addr === '本頁新地址 123 號' && a.pDate === newDate && b.name === a.name && b.pDate === a.pDate && b.mode === a.mode && b.addr === a.addr && b.storedName === '本頁新姓名' && b.cart === `{"${PID2}":1}` && !b.restoredToast && b.token !== 'ct' && L.st.orderPosts === 0,
            `K2 ${tag}：略過後只改姓名／日期／取餐方式／地址，延遲回應不覆蓋任何欄位與購物車`, JSON.stringify({ a: { name: a.name, pDate: a.pDate, mode: a.mode, addr: a.addr }, b }));
          await L.context.close(); }
        // K3 略過後以正式送單路由建立一筆現金訂單，再放行延遲回應
        { const L = await openK(kind); await L.st.waitRequest(); await skip(L);
          const before = await liveCounters(C);
          await L.page.evaluate(() => { openCartSheet(); }); await sleep(900);
          await L.page.evaluate(() => _enterCheckoutStage()); await sleep(300);
          await L.page.fill('#cName', '現金顧客'); await L.page.fill('#cPhone', '0912345678');
          await L.page.evaluate(() => { const b = document.querySelector('#payBtns .pay-btn[data-code="cash"]'); if (b) b.click(); });
          await L.page.waitForFunction(() => { const t = document.getElementById('pTime'); return t && Array.from(t.options).some((o) => o.value && !o.disabled); }, null, { timeout: 10000 }).catch(() => {});
          const resp = L.page.waitForResponse((x) => /\/api\/line-orders(\?|$)/.test(x.url()) && x.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
          await clickIf(L.page, '#subBtn');
          const rr = await resp; await sleep(1200);
          const mid = await S(L.page); const midCnt = await liveCounters(C);
          await L.st.release(); await sleep(2000);
          const b = await S(L.page); const after = await liveCounters(C);
          const sucNo = await L.page.$eval('#sucNo', (e) => e.textContent).catch(() => '');
          assert(rr && rr.status() === 200 && midCnt.orders === before.orders + 1 && mid.cart === '{}', `K3-1 ${tag}：略過後以正式 POST /api/line-orders 建立 1 筆現金訂單，購物車清空`, JSON.stringify({ st: rr && rr.status(), before, midCnt, mid: mid.cart }));
          assert(after.orders === before.orders + 1 && b.cart === '{}' && (b.storedCart === null || b.storedCart === '{}') && !b.cartSheet && !b.restoredToast && !b.payPanel && /訂單編號/.test(sucNo) && L.st.orderPosts === 1,
            `K3-2 ${tag}：延遲回應抵達後：訂單仍 1 筆、購物車與儲存資料仍為空、不重新開啟結帳、不顯示還原成功、不改付款流程`, JSON.stringify({ after, b, sucNo, posts: L.st.orderPosts }));
          await L.context.close(); }
        // K4 略過後有加減商品
        { const L = await openK(kind); await L.st.waitRequest(); await skip(L);
          await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(200);
          await clickIf(L.page, `#pc-${PID2} .qty-ctrl .plus`); await sleep(200);
          await clickIf(L.page, `#pc-${PID2} .qty-ctrl .minus`); await sleep(200);
          await L.st.release(); await sleep(1500); const b = await S(L.page);
          assert(b.cart === `{"${PID2}":2}` && b.storedCart === `{"${PID2}":2}` && !b.cartSheet && !b.restoredToast, `K4 ${tag}：略過後加減商品（1→2）：延遲回應不覆蓋本頁內容`, JSON.stringify(b));
          await L.context.close(); }
        // K5 沒有略過：完整等待後正常還原一次
        { const L = await openK(kind); await L.st.waitRequest(); await sleep(300);
          const a = await S(L.page);
          await L.page.evaluate(() => addCart(0)).catch(() => {}); await sleep(200);
          await L.st.release(); await sleep(2000); const b = await S(L.page);
          const want = kind === 'handoff' ? 5 : 4;
          assert(a.cart === `{"${PID2}":1}` && b.cart === `{"${PID2}":${want}}` && b.storedCart === `{"${PID2}":${want}}` && b.cartSheet && b.committed && !b.cancelled
            && (kind === 'handoff' ? (b.restoredToast && b.token && L.st.handoffCalls === 1) : L.st.recRestoreCalls === 1) && L.st.orderPosts === 0 && !b.bannerText,
            `K5 ${tag}：未略過 → 還原期間鎖定、回應抵達後套用一次（${want} 份）並開啟購物車／結帳、未送單`, JSON.stringify({ a: a.cart, b, calls: [L.st.handoffCalls, L.st.recRestoreCalls] }));
          await L.context.close(); }
        // K6 取消與回應幾乎同時：只可能「完全不套用」或「完全套用且取消未被接受」
        for (let i = 0; i < 3; i++) {
          const L = await openK(kind); await L.st.waitRequest();
          await L.page.waitForSelector('#restoreSkipBtn', { timeout: 9000 }).catch(() => {});
          await Promise.all([L.page.evaluate(() => { document.getElementById('restoreSkipBtn')?.click(); }), L.st.release()]);
          await sleep(1800); const b = await S(L.page);
          const want = kind === 'handoff' ? 5 : 4;
          const none = b.cancelled && !b.committed && b.cart === `{"${PID2}":1}` && b.storedCart === `{"${PID2}":1}` && !b.cartSheet && !b.restoredToast;
          const full = !b.cancelled && b.committed && b.cart === `{"${PID2}":${want}}` && b.cartSheet;
          assert(none || full, `K6-${i + 1} ${tag}：同時點略過與回應抵達 → 結果一致（${none ? '已取消、完全未套用' : full ? '已開始套用、取消未被接受' : '不一致'}）`, JSON.stringify(b));
          await L.context.close();
        }
        // K7 先取消、緊接著回應抵達（同一個事件迴圈內）→ 取消後不再產生任何副作用
        { const L = await openK(kind); await L.st.waitRequest();
          await L.page.waitForSelector('#restoreSkipBtn', { timeout: 9000 }).catch(() => {});
          await L.page.evaluate(() => _skipIdentityRestore()); await L.st.release(); await sleep(1500);
          const b = await S(L.page);
          assert(b.cancelled && b.cart === `{"${PID2}":1}` && b.storedCart === `{"${PID2}":1}` && !b.cartSheet && !b.restoredToast && !b.committed, `K7 ${tag}：取消後立即抵達的回應不產生任何副作用`, JSON.stringify(b));
          await L.context.close(); }
      }
      // K8 Handoff：Gate 尚未完成就略過 → 還原請求根本不發出
      { const L = await openK('handoff', { sdk: 'hold' }); await skip(L);
        await L.st.releaseSdk(); await sleep(2000); const b = await S(L.page);
        assert(L.st.handoffCalls === 0 && b.cart === `{"${PID2}":1}` && !b.cartSheet && !b.restoredToast, 'K8 Handoff：會員 Gate 完成前略過 → 尚未發出的還原請求不再發出', JSON.stringify({ calls: L.st.handoffCalls, b }));
        await L.context.close(); }
      const c1 = await liveCounters(C);
      assert(c1.orders === c0.orders + 2, 'K9 整段只建立 K3 的 2 筆現金訂單（Handoff、Recovery 各 1）', JSON.stringify({ c0, c1 }));
      await safeStop(C.s);
      const dbOrders = await dbRows(C.dbf, "SELECT COUNT(*) c FROM orders WHERE store_id=? AND customer_name='現金顧客'", [STORE]);
      assert(Number(dbOrders[0].c) === 2, 'K10 讀資料庫：現金訂單恰為 2 筆（延遲還原未產生額外訂單）', String(dbOrders[0].c));
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
  if (process.env.HF1C33_RESULT_JSON) fs.writeFileSync(process.env.HF1C33_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
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
