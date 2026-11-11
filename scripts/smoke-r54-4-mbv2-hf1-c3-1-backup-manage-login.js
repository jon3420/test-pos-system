#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js
// R54.4／MBV2-HF1-C3.1 —— 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）：
//   R：舊備份（無「商品想買登記」分類）完整取代時，保留的登記／同意重新對應商品
//      （801→701、801 被另一款商品占用、商品缺失、同名無法唯一；預覽與正式匯入相同判斷；拒絕時全部不變）
//   M：既有登記的管理入口（恢復販售、關閉收集、關閉總開關、隱藏／停用後仍可查詢、取消、撤回同意）
//   L：LINE 登入導回的待恢復表單（驗證早於／晚於設定載入、延遲取得 session、驗證失敗重試、過期、取消、只恢復一次）
// 安全規則同 C3 驗收：只用暫存資料庫與本機埠；LINE API 呼叫由 hf1c3-net-mock 攔截並計數。
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
const ONLY = process.env.HF1C31_ONLY || ''; // r,m,l（預設全部）
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

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C3.1 備份商品關聯＋登記管理入口＋登入導回 驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const ctxs = [];
  const today = twDate(0);
  try {
    // ═════════════════ R：舊備份完整取代與登記的商品關聯 ═════════════════
    if (run('r')) {
      const L1 = await legacyBackup({ pid: 701, pid2: 702 });                       // 同名商品 id=701
      const L2 = await legacyBackup({ pid: 701, pid2: 801 });                       // 801 被「測試對照湯」占用
      const L3 = await legacyBackup({ pid: 701, pid2: 702, extraSeed: (db) => db.run("UPDATE products SET name='改名後商品' WHERE id=701") }); // 商品缺失
      const L4 = await legacyBackup({ pid: 701, pid2: 702, extraSeed: (db) => db.run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status) VALUES (799,'store_001',?,'飯類',101,150,1,1,'available')`, [PNAME]) }); // 同名兩筆
      for (const [tag, L, occupied] of [['R1 801→701', L1, false], ['R2 801 被另一款商品占用', L2, true]]) {
        const { T } = await demandTarget(); ctxs.push(T);
        await safeStop(T.s); const pre = await demandRowsFile(T.dbf); await restart(T);
        const pushBefore = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
        const up = await H.uploadRaw(T.s.base, T.tok, L.buf, { name: 'legacy.json' });
        const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'replace', categories: L.cats, confirm_text: STORE, password: 'pw001' });
        const pvRemap = res.preview && res.preview.result && res.preview.result.demand_remap;
        const imRemap = res.import && res.import.result && res.import.result.demand_remap;
        assert(res.preview && res.preview.status === 'done' && JSON.stringify(pvRemap) === JSON.stringify([{ from: 801, to: 701, matched_by: 'name', rows: 5 }]),
          `${tag}：預覽回報登記／同意將由商品 801 對應到 701（依名稱、5 筆）`, JSON.stringify(res.preview && (res.preview.result ? pvRemap : res.preview.error)));
        assert(res.import && res.import.status === 'done' && JSON.stringify(imRemap) === JSON.stringify(pvRemap), `${tag}：正式匯入成功，對應結果與預覽相同`, JSON.stringify(res.import && (res.import.error || imRemap)));
        await safeStop(T.s);
        const post = await demandRowsFile(T.dbf);
        const byU = (rows) => Object.fromEntries(rows.map((x) => [x.request_uuid, x]));
        const preU = byU(pre.r), postU = byU(post.r);
        const keep = pre.r.length === post.r.length && pre.r.every((x) => { const y = postU[x.request_uuid]; return y && y.product_id === 701 && y.line_user_id === x.line_user_id && y.desired_qty === x.desired_qty && y.status === x.status && y.expires_at === x.expires_at && y.fulfillment_pref === x.fulfillment_pref && y.cycle_no === x.cycle_no; });
        assert(keep, `${tag}：登記全部改指向 701，會員、份數、偏好、狀態、期限、週期不變`, JSON.stringify({ pre: pre.r, post: post.r }));
        const consOk = post.c.length === 2 && post.c.every((y) => { const x = pre.c.find((z) => z.consent_uuid === y.consent_uuid); return x && y.product_id === 701 && y.status === x.status && y.line_user_id === x.line_user_id && y.request_uuid === x.request_uuid; });
        assert(consOk, `${tag}：通知同意改指向 701，狀態（granted／revoked）、會員與登記關聯不變`, JSON.stringify(post.c));
        const prod = await dbRows(T.dbf, 'SELECT id,name FROM products WHERE store_id=? AND id IN (701,801) ORDER BY id', [STORE]);
        const expectProd = occupied ? `701:${PNAME},801:${PNAME2}` : `701:${PNAME}`;
        assert(prod.map((p) => `${p.id}:${p.name}`).join(',') === expectProd && !post.r.some((x) => x.product_id === 801), `${tag}：商品以備份為準（${expectProd}），沒有任何登記指向 801`, JSON.stringify(prod));
        await restart(T);
        const sum = (await H.api(T.s.base, T.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products;
        const s701 = sum.find((p) => p.product_id === 701) || {}; const s801 = sum.find((p) => p.product_id === 801) || { active_users: 0, total_qty: 0 };
        assert(s701.active_users === 2 && s701.total_qty === 6 && s801.active_users === 0 && s801.total_qty === 0, `${tag}：後台統計 701 有效 2 人、6 份；801 為 0`, JSON.stringify({ s701, s801 }));
        const mA = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UA) })).json.data;
        const mB = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UB) })).json.data;
        assert(mA.length === 1 && mA[0].product_id === 701 && mA[0].product_name === PNAME && mA[0].desired_qty === 4 && mA[0].notify_consent === 'granted' && mB.length === 1 && mB[0].product_id === 701 && mB[0].desired_qty === 2 && mB[0].notify_consent === 'revoked',
          `${tag}：顧客本人查詢：A 701/${PNAME}/4 份/已同意；B 701/2 份/已撤回`, JSON.stringify({ mA, mB }));
        const pushAfter = fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
        assert(pushAfter === pushBefore, `${tag}：匯入未觸發任何 LINE 推播`, String(pushAfter - pushBefore));
        await safeStop(T.s);
      }
      for (const [tag, L, reason] of [['R3 商品缺失', L3, 'missing'], ['R4 同名無法唯一', L4, 'ambiguous']]) {
        const { T } = await demandTarget(); ctxs.push(T);
        await safeStop(T.s); const before = await stateDump(T.dbf); await restart(T);
        const up = await H.uploadRaw(T.s.base, T.tok, L.buf, { name: 'legacy.json' });
        const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'replace', categories: L.cats, confirm_text: STORE, password: 'pw001' });
        const pe = (res.preview && res.preview.error) || {};
        assert(res.preview && res.preview.status === 'error' && pe.code === 'DEMAND_PRODUCT_REMAP_FAILED' && pe.demand_remap_failures && pe.demand_remap_failures[0] && pe.demand_remap_failures[0].reason === reason && pe.demand_remap_failures[0].old_product_id === 801 && !res.import,
          `${tag}：預覽即明確拒絕（DEMAND_PRODUCT_REMAP_FAILED／${reason}），無法進入匯入`, JSON.stringify(res.preview && (res.preview.error || res.preview.status)));
        assert(/無法唯一對應/.test(pe.message || '') && /資料庫未變更/.test(pe.message || ''), `${tag}：拒絕訊息說明原因與未變更`, pe.message);
        const formal = await replaceImportFormal(T, L.buf, L.cats);
        assert(formal.status === 'error' && formal.error && formal.error.code === 'DEMAND_PRODUCT_REMAP_FAILED', `${tag}：直接呼叫正式匯入（略過預覽）同樣拒絕`, JSON.stringify(formal.error || formal));
        await safeStop(T.s);
        const after = await stateDump(T.dbf);
        assert(after === before, `${tag}：拒絕後商品、訂單、登記、同意、分類、設定、會員、優惠券完全不變`, before === after ? '' : 'diff');
        await restart(T);
        const mA = (await pub(T, 'POST', '/api/product-demand/mine', { member_session: session(STORE, UA) })).json.data;
        const s801 = (await H.api(T.s.base, T.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products.find((p) => p.product_id === 801) || {};
        assert(mA.length === 1 && mA[0].product_id === 801 && mA[0].desired_qty === 4 && s801.active_users === 2 && s801.total_qty === 6, `${tag}：拒絕後顧客查詢與後台統計維持原狀（801／2 人／6 份）`, JSON.stringify({ mA, s801 }));
        await safeStop(T.s);
      }
    }

    // ═════════════════ M：既有登記的管理入口 ═════════════════
    if (run('m')) {
      const C = await bootServer(H.tmpDir('c31-m'), {}); ctxs.push(C);
      const A = session(STORE, UA), B = session(STORE, UB);
      await patchProduct(C, { sale_status: 'paused' });
      await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 2 });
      await restart(C, (db) => {
        const ra = H.q1(db, 'SELECT request_uuid FROM product_demand_requests WHERE line_user_id=?', [UA]);
        db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at) VALUES ('m-g',?,?,?,?,'line','granted','restock-notify-v1',datetime('now'))`, [STORE, PID, UA, ra.request_uuid]);
      });
      const c0 = await liveCounters(C);
      const mineA = async () => (await pub(C, 'POST', '/api/product-demand/mine', { member_session: A })).json.data;
      // M1 恢復販售
      await patchProduct(C, { sale_status: 'available', line_quota_sold: 0 });
      {
        const L = await openLinePage(browser, C, { member: A });
        await sleep(800);
        const st = await cardState(L.page);
        const hdr = await L.page.evaluate(() => (document.getElementById('myDemandsBtn') ? getComputedStyle(document.getElementById('myDemandsBtn')).display : 'missing'));
        assert(st.demand === '已登記 2 份・管理登記' && st.plusEnabled && st.incOk && hdr !== 'none' && hdr !== 'missing', 'M1-1 恢復販售：商品可購買，同時保留「已登記 2 份・管理登記」與頁首「我的想買登記」', JSON.stringify({ d: st.demand, plus: st.plusEnabled, hdr }));
        assert(st.detail.disabled === false && st.detail.demand === '已登記 2 份・管理登記', 'M1-2 恢復販售：詳情可加入，且提供管理登記入口', JSON.stringify(st.detail));
        await clickIf(L.page, `#pc-${PID} .demand-btn`); await sleep(400);
        const can = await L.page.evaluate(() => ({ submit: !!document.getElementById('dmSubmit'), qty: document.getElementById('dmQty')?.textContent }));
        await clickIf(L.page, '#dmPlus'); await clickIf(L.page, '#dmSubmit'); await sleep(900);
        const m = await mineA();
        assert(can.submit && can.qty === '2' && m[0].desired_qty === 3 && (await L.page.$eval(`#pc-${PID} .demand-btn`, (e) => e.textContent).catch(() => null)) === '已登記 3 份・管理登記', 'M1-3 恢復販售且仍開放收集：可修改份數為 3（更新原筆）', JSON.stringify({ can, m }));
        assert((await L.page.evaluate(() => Object.keys(cart).length)) === 0, 'M1-4 管理登記不加入購物車', '');
        await L.context.close();
      }
      // M2 關閉商品收集
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID}/collect`, { enabled: false });
      {
        const L = await openLinePage(browser, C, { member: A });
        await sleep(800);
        const btn = await L.page.$eval(`#pc-${PID} .demand-btn`, (e) => e.textContent).catch(() => null);
        await clickIf(L.page, `#pc-${PID} .demand-btn`); await sleep(400);
        const ui = await L.page.evaluate(() => ({ ro: !!document.getElementById('dmReadonlyNote'), submit: !!document.getElementById('dmSubmit'), cancel: !!document.getElementById('dmCancel'), revoke: !!document.getElementById('dmRevoke') }));
        const reg = await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID, desired_qty: 5 });
        assert(btn === '已登記 3 份・管理登記' && ui.ro && !ui.submit && ui.cancel && ui.revoke && reg.status === 403, 'M2-1 關閉商品收集：仍可找到並管理（唯讀＋取消＋撤回），修改份數依最新設定被拒（403）', JSON.stringify({ btn, ui, reg: reg.status }));
        await clickIf(L.page, '#dmRevoke'); await sleep(700);
        const m = await mineA();
        assert(m[0].notify_consent === 'revoked' && m[0].desired_qty === 3, 'M2-2 關閉收集後仍可撤回通知同意（登記本身保留）', JSON.stringify(m));
        await L.context.close();
      }
      // M3 關閉總開關
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: false });
      {
        const L = await openLinePage(browser, C, { member: A });
        await sleep(800);
        const btn = await L.page.$eval(`#pc-${PID} .demand-btn`, (e) => e.textContent).catch(() => null);
        const others = await L.page.$$eval('.demand-btn', (bs) => bs.length);
        await clickIf(L.page, '#myDemandsBtn'); await sleep(800);
        const list = await L.page.$$eval('#dmList .dm-list-item', (xs) => xs.map((x) => x.innerText));
        assert(btn === '已登記 3 份・管理登記' && others === 1 && list.length === 1 && list[0].includes(PNAME), 'M3 關閉總開關：其他商品不再出現新增入口，本人既有登記仍可從商品卡與頁首清單找到', JSON.stringify({ btn, others, list }));
        await L.context.close();
      }
      // M4 隱藏商品（show_on_line=0）
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: true });
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID}/collect`, { enabled: true });
      await restart(C, (db) => db.run('UPDATE products SET show_on_line=0 WHERE id=?', [PID]));
      {
        const menu = (await pub(C, 'GET', '/api/line-menu')).json.data.products.map((p) => p.id);
        const L = await openLinePage(browser, C, { member: A });
        await sleep(800);
        const inPage = await L.page.evaluate((id) => ({ card: !!document.getElementById('pc-' + id), inAll: allProducts.some((p) => p.id == id) }), PID);
        await clickIf(L.page, '#myDemandsBtn'); await sleep(800);
        const list = await L.page.$$eval('#dmList .dm-list-item', (xs) => xs.map((x) => x.innerText));
        await clickIf(L.page, `.dm-manage-btn[data-pid="${PID}"]`); await sleep(400);
        const ui = await L.page.evaluate(() => ({ name: document.getElementById('dmPname')?.textContent, ro: !!document.getElementById('dmReadonlyNote'), submit: !!document.getElementById('dmSubmit') }));
        const inPage2 = await L.page.evaluate((id) => ({ card: !!document.getElementById('pc-' + id), inAll: allProducts.some((p) => p.id == id) }), PID);
        const ord = await pub(C, 'POST', '/api/line-orders', { customer_name: 't', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today, pickup_time: '23:00', payment_method: 'cash', items: [{ product_id: PID, qty: 1, name: PNAME, price: 150 }] });
        assert(!menu.includes(PID) && !inPage.card && !inPage.inAll && !inPage2.card && !inPage2.inAll && ord.status === 400, 'M4-1 隱藏商品：不出現在公開列表與商品卡，管理後也不會重新出現；仍不可購買', JSON.stringify({ menuHas: menu.includes(PID), inPage, inPage2, ord: ord.status }));
        assert(list.length === 1 && list[0].includes(PNAME) && ui.name === PNAME && ui.ro && !ui.submit, 'M4-2 隱藏商品：頁首清單仍列出本人登記，可開啟唯讀管理', JSON.stringify({ list, ui }));
        const bCancel = await pub(C, 'POST', '/api/product-demand/cancel', { member_session: B, product_id: PID });
        const xStore = await pub(C, 'POST', '/api/product-demand/mine', { member_session: session('store_002', UA) });
        assert(bCancel.status === 404 && xStore.status === 401 && (await mineA()).length === 1, 'M4-3 其他會員不能取消、其他店別 session 不能讀取（商品卡不顯示時亦同）', `${bCancel.status}/${xStore.status}`);
        await clickIf(L.page, '#dmCancel'); await sleep(900);
        await clickIf(L.page, '#myDemandsBtn'); await sleep(800);
        const empty = await L.page.$('#dmListEmpty');
        assert((await mineA()).length === 0 && !!empty, 'M4-4 隱藏商品：本人可取消既有登記，清單變為空', '');
        await L.context.close();
      }
      // M5 停用商品（enabled=0）
      await restart(C, (db) => db.run('UPDATE products SET show_on_line=1, enabled=1 WHERE id=?', [PID]));
      await pub(C, 'POST', '/api/product-demand/register', { member_session: A, product_id: PID2, desired_qty: 6 });
      await restart(C, (db) => db.run('UPDATE products SET enabled=0 WHERE id=?', [PID2]));
      {
        const L = await openLinePage(browser, C, { member: A });
        await sleep(800);
        await clickIf(L.page, '#myDemandsBtn'); await sleep(800);
        await clickIf(L.page, `.dm-manage-btn[data-pid="${PID2}"]`); await sleep(400);
        const ro = await L.page.$('#dmReadonlyNote');
        await clickIf(L.page, '#dmCancel'); await sleep(900);
        const inAll = await L.page.evaluate((id) => allProducts.some((p) => p.id == id), PID2);
        assert(!!ro && (await mineA()).length === 0 && !inAll, 'M5 停用商品：仍可從清單取消既有登記，商品不重新出現', '');
        assert(L.errors.length === 0, 'M5-2 頁面無 JavaScript 錯誤', L.errors.join(' | '));
        await L.context.close();
      }
      const c1 = await liveCounters(C);
      assert(c1.orders === c0.orders && c1.quota_sold === c0.quota_sold && c1.preorder_sold === c0.preorder_sold, 'M6 整段管理操作：訂單、今日與預購額度不變', JSON.stringify({ c0, c1 }));
      await safeStop(C.s);
    }

    // ═════════════════ L：LINE 登入導回的待恢復表單 ═════════════════
    if (run('l')) {
      const C = await bootServer(H.tmpDir('c31-l'), {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'paused' });
      const A = session(STORE, UA);
      const SKEY = 'line_member_session_store_001', PKEY = 'pd_pending_open_store_001';
      const sessVal = (tok, exp) => JSON.stringify({ member_session: tok, display_name: '測試會員', is_friend: true, expires_at: exp || Date.now() + 3600e3 });
      async function openL({ pending = true, member = null, configDelay = 0 } = {}) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([pk, pv, sk, sv]) => {
          if (!sessionStorage.getItem('__seeded')) {
            if (pv) sessionStorage.setItem(pk, pv);
            if (sv) localStorage.setItem(sk, sv);
            sessionStorage.setItem('__seeded', '1');
          }
          window.__pdOpens = 0;
          document.addEventListener('DOMContentLoaded', () => {
            let was = false;
            new MutationObserver(() => { const ov = document.getElementById('demandOverlay'); const now = !!(ov && ov.classList.contains('show')); if (now && !was) window.__pdOpens++; was = now; })
              .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
          });
        }, [PKEY, pending ? JSON.stringify({ pid: PID, at: Date.now() }) : '', SKEY, member || '']);
        const page = await context.newPage();
        if (configDelay) await page.route('**/api/product-demand/config**', async (route) => { await sleep(configDelay); route.continue(); });
        const errors = [], posts = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/line-orders(\?|$)/.test(r.url())) posts.push(r.url()); });
        await page.goto(`${C.s.base}/line-order.html?store_id=store_001`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof allProducts !== 'undefined' && allProducts.length > 0, null, { timeout: 20000 });
        return { context, page, errors, posts };
      }
      const S = (page) => page.evaluate(([pk]) => ({
        open: !!document.getElementById('demandOverlay')?.classList.contains('show'), opens: window.__pdOpens,
        form: !!document.getElementById('dmSubmit'), login: !!document.getElementById('dmLoginBtn'), hint: document.getElementById('dmLoginHint')?.textContent || '',
        loginLabel: document.getElementById('dmLoginBtn')?.textContent || '', msg: document.getElementById('dmMsg')?.textContent || '',
        pending: !!sessionStorage.getItem(pk), cart: Object.keys(cart).length, hdr: (document.getElementById('myDemandsBtn') ? getComputedStyle(document.getElementById('myDemandsBtn')).display : 'missing'),
      }), [PKEY]);
      const c0 = await liveCounters(C);
      // L1 驗證早於設定載入（session 已在、config 延遲 2 秒）
      { const L = await openL({ member: sessVal(A), configDelay: 2000 }); await sleep(3500); const s = await S(L.page);
        assert(s.open && s.form && s.opens === 1 && !s.pending && s.cart === 0, 'L1 會員已驗證、登記設定較晚載入：恢復表單一次並消耗待恢復紀錄', JSON.stringify(s));
        await L.page.reload({ waitUntil: 'domcontentloaded' }); await L.page.waitForFunction(() => allProducts.length > 0); await sleep(2800);
        const s2 = await S(L.page);
        assert(!s2.open && s2.opens === 0, 'L1-2 重新整理後不再重複開啟（只恢復一次）', JSON.stringify(s2));
        await L.context.close(); }
      // L2 驗證晚於設定載入（載入時沒有 session，2.5 秒後才取得）
      { const L = await openL({}); await sleep(1500); const s0 = await S(L.page);
        assert(s0.open && s0.login && !s0.form && s0.pending, 'L2-1 尚未取得 session：表單以「需要登入」狀態開啟，待恢復紀錄保留', JSON.stringify(s0));
        await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(A)]);
        await sleep(2500); const s1 = await S(L.page);
        assert(s1.open && s1.form && !s1.login && s1.opens === 1 && !s1.pending && s1.cart === 0, 'L2-2 延遲取得 session 後自動轉為登記表單（同一次開啟），待恢復紀錄才消耗', JSON.stringify(s1));
        await L.context.close(); }
      // L3 驗證失敗 → 重新嘗試成功
      { const L = await openL({}); await sleep(1500);
        await L.page.evaluate(([k, v]) => {
          let n = 0;
          LineMemberGate.isLiffAvailable = () => true;
          LineMemberGate.loginWithLine = async () => ({});
          LineMemberGate.verifyWithBackend = async () => { n++; if (n === 1) return { success: false, message: '驗證失敗（測試）' }; localStorage.setItem(k, v); return { success: true }; };
        }, [SKEY, sessVal(A)]);
        await clickIf(L.page, '#dmLoginBtn'); await sleep(600); const s1 = await S(L.page);
        assert(s1.open && s1.login && /驗證失敗/.test(s1.msg) && s1.pending, 'L3-1 驗證失敗：顯示錯誤、保留待恢復紀錄並可重試', JSON.stringify(s1));
        await clickIf(L.page, '#dmLoginBtn'); await sleep(900); const s2 = await S(L.page);
        assert(s2.open && s2.form && !s2.pending && s2.opens === 1, 'L3-2 重新嘗試成功：直接顯示登記表單並消耗待恢復紀錄', JSON.stringify(s2));
        await L.context.close(); }
      // L4 session 過期：後端 401 → 顯示重新登入；本機已逾時 → 視為未登入
      { const L = await openL({ member: sessVal('forged.invalid.session') }); await sleep(2000); const s = await S(L.page);
        assert(s.open && s.login && /過期/.test(s.hint) && s.loginLabel === '重新以 LINE 登入' && s.cart === 0, 'L4-1 member_session 失效（API 401）：表單提示登入已過期並提供重新登入', JSON.stringify(s));
        await L.page.evaluate(([k, v]) => { LineMemberGate.isLiffAvailable = () => true; LineMemberGate.loginWithLine = async () => ({}); LineMemberGate.verifyWithBackend = async () => { localStorage.setItem(k, v); return { success: true }; }; }, [SKEY, sessVal(A)]);
        await clickIf(L.page, '#dmLoginBtn'); await sleep(900); const s2 = await S(L.page);
        assert(s2.form, 'L4-2 重新登入後恢復登記表單', JSON.stringify(s2));
        await L.context.close(); }
      { const L = await openL({ member: sessVal(A, Date.now() - 1000) }); await sleep(1800); const s = await S(L.page);
        assert(s.open && s.login && s.pending, 'L4-3 本機 session 已逾時：視為未登入，表單要求登入且保留待恢復紀錄', JSON.stringify(s));
        await L.context.close(); }
      // L5 使用者明確取消
      { const L = await openL({}); await sleep(1500);
        await clickIf(L.page, '#dmClose'); await sleep(300); const s = await S(L.page);
        await L.page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(A)]);
        await sleep(2200); const s1 = await S(L.page);
        await L.page.reload({ waitUntil: 'domcontentloaded' }); await L.page.waitForFunction(() => allProducts.length > 0); await sleep(2500); const s2 = await S(L.page);
        assert(!s.open && !s.pending && !s1.open && !s2.open && s2.opens === 0, 'L5 使用者關閉表單：待恢復紀錄消耗，之後取得 session 或重新整理都不再開啟', JSON.stringify({ s, s1, s2 }));
        await L.context.close(); }
      // L6 一般瀏覽者：沒有待恢復紀錄、沒有 session
      { const L = await openL({ pending: false }); await sleep(2000); const s = await S(L.page);
        assert(!s.open && s.opens === 0 && s.hdr === 'none', 'L6 一般瀏覽者：不開表單、不要求登入、不顯示「我的想買登記」', JSON.stringify(s));
        await L.context.close(); }
      // L7 已登入但沒有待恢復紀錄：頁首入口顯示，不自動開表單
      { const L = await openL({ pending: false, member: sessVal(A) }); await sleep(2000); const s = await S(L.page);
        assert(!s.open && s.hdr !== 'none' && s.hdr !== 'missing', 'L7 已登入：顯示「我的想買登記」入口，不自動開啟表單', JSON.stringify(s));
        await L.context.close(); }
      const c1 = await liveCounters(C);
      assert(c1.orders === c0.orders && c1.quota_sold === c0.quota_sold && c1.preorder_sold === c0.preorder_sold, 'L8 恢復登記流程：未建立訂單、額度不變（購物車於各情境皆為 0）', JSON.stringify({ c0, c1 }));
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
  if (process.env.HF1C31_RESULT_JSON) fs.writeFileSync(process.env.HF1C31_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
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
