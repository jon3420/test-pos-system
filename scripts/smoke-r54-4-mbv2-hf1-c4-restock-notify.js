#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js
// R54.4／MBV2-HF1-C4 —— LINE 補貨通知與商品直達：真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）。
//   N：通知能力、預設關閉、設定缺漏、權限與跨店
//   C：通知同意（不勾不同意、修改份數、撤回、取消、過期、新週期、偽造 UID、跨店、功能關閉、舊版同意）
//   P：預覽（伺服器名單、排除原因、販售狀態 × 日期 × 取餐方式、額度、可用份數、訊息與連結）
//   S：發送（原子確認、連點／並行、同週期跨批次、預覽後變化、各種 LINE 回應、retry key、上限與退避）
//   R：重啟（送出後未寫回即中斷、續送沿用 retry key、超過有效期限不補送）
//   L：前台（訂閱介面、商品直達、不改購物車、ID 重新對應、Recovery 優先、後台預覽與發送）
//   B：MBV2 備份還原（完整／選擇性、重複匯入、撤回優先、未完成工作暫停、還原後不自動發送、商品重建）
//   K：C3.3 讀取 C4 升級後資料庫（回退相容）
//   Z：模擬／真實 LINE 呼叫次數
//
// 安全：只用 os.tmpdir() 暫存資料庫與本機埠。所有 api.line.me 請求由 scripts/lib/c4-line-mock.js 在程序內攔截
// 並模擬回應（完全不連外）；其餘外部網路由 scripts/lib/hf1c3-net-mock.js 拒絕並計數。不發送任何真實 LINE 訊息。
'use strict';
const path = require('path');
const fs = require('fs');
// ── 一致的測試時鐘：台北時間落在 08:00–20:00 以外時，整體位移到當日 10:30（伺服器、sql.js、瀏覽器同一位移）──
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

const ONLY = process.env.C4_ONLY || '';
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const CLOCK_OFF = Number(process.env.C4_CLOCK_OFFSET_MS || 0);
const NET_MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const LINE_MOCK = path.join(__dirname, 'lib', 'c4-line-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const MOCKDIR = H.tmpDir('c4-linemock');
const PUSH_FILE = path.join(MOCKDIR, 'real-line-attempts.txt'); // hf1c3：任何漏網、未被模擬攔截的 LINE 請求
const MOCK_CTRL = path.join(MOCKDIR, 'ctrl.json');
const MOCK_STATE = path.join(MOCKDIR, 'state.json');
const MOCK_LOG = path.join(MOCKDIR, 'calls.jsonl');
fs.writeFileSync(PUSH_FILE, ''); fs.writeFileSync(MOCK_CTRL, '{}'); fs.writeFileSync(MOCK_STATE, JSON.stringify({ accepted: {}, used: {} })); fs.writeFileSync(MOCK_LOG, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twDate = (d = 0) => new Date(Date.now() + 8 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
const STORE_NAME = '脆豬腰測試店';
const LIFF = '2000000000-TestLiffC4';
const TOKEN = 'test-only-channel-token-not-real-c4';
const PID = 701, PID2 = 702, PN = 706; // PN：補貨通知主要測試商品
const PN_NAME = '測試補貨麵';
const uid = (n) => 'U' + n.toString(16).padStart(32, '0');
let MS; try { MS = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js')); } catch { MS = null; }
const session = (store, u) => MS.createMemberSession({ store_id: store, line_user_id: u });

function setCtrl(c) { fs.writeFileSync(MOCK_CTRL, JSON.stringify(c || {})); }
function mockCalls() { return fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
function realLineAttempts() { return fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length; }

function seedAll(db, opts = {}) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v, store = 'store_001') => runSql('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [store, k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1'); set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0'); set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654'); set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout'); set('shop_name', STORE_NAME);
  if (opts.token !== false) set('line_channel_token', TOKEN);
  if (opts.liff !== false) set('line_member_liff_id', LIFF);
  set('product_demand_notify_enabled', '1'); // C3 舊鍵：C4 不得因此自動啟用
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_quota_low_threshold: 'INTEGER DEFAULT 2', line_quota_high_threshold: 'INTEGER DEFAULT 10',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_preorder_low_threshold: 'INTEGER DEFAULT 2', line_preorder_high_threshold: 'INTEGER DEFAULT 10',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1', shipping_enabled: 'INTEGER DEFAULT 0', shipping_share_line_stock: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const ins = (id, name, price, sort, q, qd, p, pd, barcode) => runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
      line_quota_enabled,line_quota_daily,line_quota_sold,line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_takeout_enabled,line_delivery_enabled,product_barcode)
      VALUES (?,?,?,?,?,?,1,1,'available',?, ?,?,0, ?,?,0, 1,1,?)`, [id, 'store_001', name, '飯類', 101, price, sort, q, qd, p, pd, barcode || null]);
  ins(PID, '測試招牌飯', 150, 0, 1, 10, 1, 20);
  ins(PID2, '測試對照湯', 60, 1, 0, 0, 0, 0);
  ins(PN, PN_NAME, 120, 2, 1, 10, 1, 5, 'BC-706');
  ins(707, '測試隔離粥', 90, 3, 0, 0, 0, 0);
  if (opts.extraSeed) opts.extraSeed(db, runSql);
}
async function boot(tag, opts = {}) {
  const dir = H.tmpDir('c4-' + tag);
  const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedAll(db, opts); H.saveDbFile(db, dbf); db.close();
  const ctx = { dir, dbf, opts };
  await start(ctx);
  return ctx;
}
function serverEnv(ctx) {
  return {
    __nodeArgs: ['-r', CLOCK, '-r', NET_MOCK, '-r', LINE_MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
    HF1C3_PUSH_COUNT_FILE: PUSH_FILE, C4_LINE_MOCK_CTRL: MOCK_CTRL, C4_LINE_MOCK_STATE: MOCK_STATE, C4_LINE_MOCK_LOG: MOCK_LOG,
    RESTOCK_NOTIFY_BACKOFF_MS: '60,90,120', RESTOCK_NOTIFY_SEND_INTERVAL_MS: '0', RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '700',
    ...((ctx.opts && ctx.opts.env) || {}),
  };
}
async function start(ctx) {
  ctx.s = await H.startServer(ctx.dbf, serverEnv(ctx));
  ctx.tok = await H.login(ctx.s.base, 'store_001', 'pw001');
}
async function safeStop(srv) { const p = srv && srv.proc; if (p && p.exitCode == null && p.signalCode == null) await srv.stop(); }
async function restart(ctx, mutate) {
  await safeStop(ctx.s);
  if (mutate) { const db = await H.openDbFile(ctx.dbf); mutate(db); H.saveDbFile(db, ctx.dbf); db.close(); }
  await start(ctx);
}
async function rows(ctx, sql, params) { const db = await H.openDbFile(ctx.dbf); const r = H.q(db, sql, params); db.close(); return r; }
async function pub(ctx, method, p, body, store = 'store_001') {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${ctx.s.base}${p}${sep}store_id=${store}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const adm = (ctx, method, p, body, tok) => H.api(ctx.s.base, tok === undefined ? ctx.tok : tok, method, p, body);
const reg = (ctx, u, pid, qty, extra = {}) => pub(ctx, 'POST', '/api/product-demand/register', { member_session: session('store_001', u), product_id: pid, desired_qty: qty, ...extra });
async function patchProduct(ctx, pid, body) {
  const r = await adm(ctx, 'PATCH', `/api/products/${pid}/line-settings`, body);
  if (!r.json || !r.json.success) throw new Error('patch failed ' + r.text.slice(0, 200));
}
const preview = (ctx, pid, mode, date) => adm(ctx, 'POST', '/api/product-demand-admin/restock/preview', { product_id: pid, fulfillment_mode: mode, supply_date: date });
const confirm = (ctx, uuid, tok) => adm(ctx, 'POST', `/api/product-demand-admin/restock/batches/${uuid}/confirm`, {}, tok);
const resume = (ctx, uuid) => adm(ctx, 'POST', `/api/product-demand-admin/restock/batches/${uuid}/resume`, {});
const detail = (ctx, uuid) => adm(ctx, 'GET', `/api/product-demand-admin/restock/batches/${uuid}`);
async function waitBatch(ctx, uuid, ms = 20000) {
  const end = Date.now() + ms;
  let d;
  while (Date.now() < end) {
    d = (await detail(ctx, uuid)).json;
    if (d && d.data && d.data.status !== 'sending' && !d.data.running) return d.data;
    await sleep(80);
  }
  return d && d.data;
}
// 訂單、付款、今日額度與預購額度快照（登記／預覽／通知前後逐筆核對）
async function invariants(ctx) {
  const o = await rows(ctx, "SELECT id, status, total, payment_status, payment_method FROM orders WHERE store_id='store_001' ORDER BY id");
  const p = await rows(ctx, "SELECT id, line_quota_sold, line_preorder_sold, line_quota_daily, line_preorder_daily FROM products WHERE store_id='store_001' ORDER BY id");
  return JSON.stringify({ o, p });
}
async function setFriend(ctx, entries) {
  // entries: [[uid, is_friend(1/0/null), display]]
  await restart(ctx, (db) => {
    for (const [u, f, name] of entries) {
      db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', u]);
      if (f !== 'none') db.run('INSERT INTO line_members (store_id, line_user_id, display_name, is_friend) VALUES (?,?,?,?)', ['store_001', u, name || '', f]);
    }
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const shots = H.tmpDir('c4-shots');
  const ctxs = [];
  console.log(`clock offset: ${CLOCK_OFF} ms（台北時間 ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}）`);
  try {
    const M = await boot('main'); ctxs.push(M);
    const T0 = twDate(0), T1 = twDate(1);

    // ═════════════════ N：通知能力與預設關閉 ═════════════════
    if (run('n')) {
      const cap = (await adm(M, 'GET', '/api/product-demand-admin/restock/capability')).json.data;
      assert(cap.code_implemented === true && cap.send_enabled === false && cap.notify_available === false && cap.config_complete === true && cap.token_verified === false,
        'N1 安裝／升級後通知發送預設關閉（即使 C3 舊鍵 product_demand_notify_enabled=1、權杖與 LIFF 齊全）；權杖只標示已設定、未驗證', JSON.stringify(cap));
      const pc = (await pub(M, 'GET', '/api/product-demand/config')).json.data;
      assert(pc.notify_available === false && pc.consent_text === '', 'N2 顧客端 config：通知不可用（後端判定），不提供同意文案', JSON.stringify(pc));
      const r401 = await adm(M, 'GET', '/api/product-demand-admin/restock/capability', undefined, null);
      const r401b = await adm(M, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PN, fulfillment_mode: 'takeout', supply_date: T0 }, null);
      const fake = await adm(M, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PN, fulfillment_mode: 'takeout', supply_date: T0 }, 'not.a.jwt');
      assert(r401.status === 401 && r401b.status === 401 && fake.status === 401, 'N3 未授權後台請求（無 JWT／偽造 JWT）一律 401', `${r401.status},${r401b.status},${fake.status}`);
      const tok2 = await H.login(M.s.base, 'store_002', 'pw002');
      const x = await adm(M, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PN, fulfillment_mode: 'takeout', supply_date: T0 }, tok2);
      const xs = await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true }, tok2);
      const capAfter = (await adm(M, 'GET', '/api/product-demand-admin/restock/capability')).json.data;
      const xb = await adm(M, 'GET', '/api/product-demand-admin/restock/batches', undefined, tok2);
      assert([403, 404].includes(x.status) && [403, 404].includes(xs.status) && !(xb.json && xb.json.success && xb.json.data.length) && capAfter.send_enabled === false,
        'N4 跨店：store_002 的後台權杖不能預覽 store_001 商品、看不到其批次；其開關不影響 store_001（store_id 只信任 JWT）', JSON.stringify({ x: x.status, xs: xs.status, xb: xb.status, cap: capAfter.send_enabled }));
      const en = (await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true })).json.data;
      const pc2 = (await pub(M, 'GET', '/api/product-demand/config')).json.data;
      assert(en.notify_available === true && pc2.notify_available === true && pc2.consent_text === '商品恢復供應或開放預購時，透過 LINE 通知我。', 'N5 店家開啟且設定完整 → 通知可用，顧客端取得同意文案', JSON.stringify(pc2));
      // 設定缺漏（另一台：沒有權杖、沒有 LIFF）
      const Q = await boot('nocfg', { token: false, liff: false }); ctxs.push(Q);
      await adm(Q, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      const qc = (await adm(Q, 'GET', '/api/product-demand-admin/restock/capability')).json.data;
      const qp = (await pub(Q, 'GET', '/api/product-demand/config')).json.data;
      assert(qc.send_enabled === true && qc.notify_available === false && qc.missing.join(',') === 'line_channel_token,line_member_liff_id' && qp.notify_available === false,
        'N6 已開啟但缺少權杖與 LIFF：通知不可用並列出缺漏', JSON.stringify(qc));
      const qreg = await reg(Q, uid(901), PN, 1, { notify_consent: true });
      const qrows = await rows(Q, 'SELECT COUNT(*) AS c FROM product_demand_consents');
      assert(qreg.json.success && qreg.json.data.consent_outcome === 'notify_unavailable' && Number(qrows[0].c) === 0, 'N7 通知不可用時送出同意 → 只登記想買、不建立同意紀錄', JSON.stringify(qreg.json.data));
      await safeStop(Q.s);
    }

    // ═════════════════ C：通知同意 ═════════════════
    if (run('c')) {
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      const inv0 = await invariants(M);
      const U = uid(11);
      const a1 = await reg(M, U, PID2, 2);
      const c0 = await rows(M, 'SELECT COUNT(*) AS c FROM product_demand_consents WHERE line_user_id=?', [U]);
      assert(a1.json.success && a1.json.data.request.notify_consent === 'none' && Number(c0[0].c) === 0, 'C1 新會員不勾選只登記：無同意紀錄', JSON.stringify(a1.json.data.request));
      const a1f = await reg(M, U, PID2, 2, { notify_consent: false });
      assert(a1f.json.data.request.notify_consent === 'none', 'C2 送出 notify_consent=false 不建立同意', a1f.json.data.request.notify_consent);
      const a2 = await reg(M, U, PID2, 2, { notify_consent: true });
      const c1 = await rows(M, 'SELECT * FROM product_demand_consents WHERE line_user_id=?', [U]);
      const r1 = await rows(M, 'SELECT * FROM product_demand_requests WHERE line_user_id=? AND status=?', [U, 'active']);
      assert(a2.json.data.consent_outcome === 'granted' && c1.length === 1 && c1[0].status === 'granted' && c1[0].consent_text_version === 'restock-notify-c4-v1'
        && c1[0].request_uuid === r1[0].request_uuid && c1[0].store_id === 'store_001' && c1[0].product_id === PID2 && c1[0].granted_at && c1[0].consent_source === 'customer_checkbox'
        && c1[0].consent_text === '商品恢復供應或開放預購時，透過 LINE 通知我。' && Number(c1[0].reconfirm_required) === 0,
      'C3 明確勾選才同意：記錄會員、店別、商品、登記週期、時間、文案版本與完整文案', JSON.stringify(c1[0]));
      const a3 = await reg(M, U, PID2, 5, { notify_consent: true });
      const a4 = await reg(M, U, PID2, 3);
      const c2 = await rows(M, 'SELECT COUNT(*) AS c FROM product_demand_consents WHERE line_user_id=?', [U]);
      assert(a3.json.data.outcome === 'updated' && a3.json.data.consent_outcome === 'unchanged' && a4.json.data.request.notify_consent === 'granted' && Number(c2[0].c) === 1,
        'C4 修改份數（帶或不帶勾選）不產生新同意、不改變既有同意', JSON.stringify({ a3: a3.json.data.consent_outcome, n: c2[0].c }));
      const rv = await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', U), product_id: PID2 });
      const mine = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', U) })).json.data;
      assert(rv.json.data.revoked === true && mine.length === 1 && mine[0].notify_consent === 'revoked' && mine[0].status === 'active', 'C5 只取消通知、保留想買登記', JSON.stringify(mine));
      const a5 = await reg(M, U, PID2, 3, { notify_consent: true });
      const c3 = await rows(M, 'SELECT status FROM product_demand_consents WHERE line_user_id=? ORDER BY id', [U]);
      assert(a5.json.data.consent_outcome === 'granted' && c3.map((x) => x.status).join(',') === 'revoked,granted', 'C6 撤回後重新明確同意 → 新增一筆同意（保留撤回歷史）', JSON.stringify(c3));
      const cn = await pub(M, 'POST', '/api/product-demand/cancel', { member_session: session('store_001', U), product_id: PID2 });
      const c4 = await rows(M, 'SELECT status FROM product_demand_consents WHERE line_user_id=? ORDER BY id', [U]);
      assert(cn.json.success && c4.every((x) => x.status === 'revoked'), 'C7 取消整筆登記 → 同時停止通知資格（同意撤回）', JSON.stringify(c4));
      const a6 = await reg(M, U, PID2, 1);
      const r2 = await rows(M, "SELECT cycle_no FROM product_demand_requests WHERE line_user_id=? AND status='active'", [U]);
      assert(a6.json.data.outcome === 'created' && a6.json.data.request.notify_consent === 'none' && Number(r2[0].cycle_no) === 2, 'C8 取消後的新週期需重新同意，不沿用上一週期授權', JSON.stringify({ n: a6.json.data.request.notify_consent, cyc: r2[0].cycle_no }));
      // 過期：週期 2 先同意，再把有效期限改到過去（同一測試時鐘），重新登記 → 週期 3、同意為 none、舊同意標示 expired
      await reg(M, U, PID2, 1, { notify_consent: true });
      await restart(M, (db) => { db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 minutes') WHERE line_user_id=? AND status='active'", [U]); });
      const mineExp = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', U) })).json.data;
      const a7 = await reg(M, U, PID2, 1);
      const c5 = await rows(M, 'SELECT status FROM product_demand_consents WHERE line_user_id=? ORDER BY id', [U]);
      assert(mineExp.length === 0 && a7.json.data.outcome === 'created' && a7.json.data.request.notify_consent === 'none' && c5[c5.length - 1].status === 'expired',
        'C9 過期後新週期需重新同意；上一週期同意標示為週期結束', JSON.stringify({ c5, n: a7.json.data.request.notify_consent }));
      // 偽造 UID、跨店
      const V = uid(12), W = uid(13);
      const f1 = await pub(M, 'POST', '/api/product-demand/register', { member_session: session('store_001', V), line_user_id: W, store_id: 'store_002', product_id: PID2, desired_qty: 1, notify_consent: true });
      const fr = await rows(M, 'SELECT line_user_id, store_id FROM product_demand_requests WHERE line_user_id IN (?,?)', [V, W]);
      assert(f1.json.success && fr.length === 1 && fr[0].line_user_id === V && fr[0].store_id === 'store_001', 'C10 偽造 line_user_id／store_id 一律忽略，身分只取自 member_session', JSON.stringify(fr));
      const x1 = await pub(M, 'POST', '/api/product-demand/register', { member_session: session('store_002', W), product_id: PID2, desired_qty: 1, notify_consent: true });
      const x2 = await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_002', V), product_id: PID2 });
      const vState = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', V) })).json.data[0].notify_consent;
      assert(x1.status === 401 && x2.status === 401 && vState === 'granted', 'C11 他店 member_session 不能登記或撤回本店同意（401），本店同意不受影響', `${x1.status},${x2.status},${vState}`);
      const noSess = await pub(M, 'POST', '/api/product-demand/register', { line_user_id: V, product_id: PID2, desired_qty: 1, notify_consent: true });
      assert(noSess.status === 401, 'C12 沒有 member_session 的請求不接受（不相信前端 UID）', String(noSess.status));
      // 功能關閉：仍可撤回／取消；送同意不建立
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const off1 = await reg(M, W, PID2, 1, { notify_consent: true });
      const offRev = await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', V), product_id: PID2 });
      const offMine = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', V) })).json.data[0];
      assert(off1.json.data.consent_outcome === 'notify_unavailable' && off1.json.data.request.notify_consent === 'none' && offRev.json.data.revoked === true && offMine.notify_consent === 'revoked',
        'C13 功能關閉：新同意不建立；本人仍可撤回同意', JSON.stringify({ o: off1.json.data.consent_outcome, m: offMine.notify_consent }));
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      // 收集開關關閉或商品隱藏：本人仍能撤回、取消
      await reg(M, V, PID2, 1, { notify_consent: true });
      await adm(M, 'PATCH', `/api/product-demand-admin/products/${PID2}/collect`, { enabled: false });
      await patchProduct(M, PID2, { show_on_line: 0 });
      const hidRev = await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', V), product_id: PID2 });
      const hidCancel = await pub(M, 'POST', '/api/product-demand/cancel', { member_session: session('store_001', V), product_id: PID2 });
      assert(hidRev.json.data.revoked === true && hidCancel.json.success, 'C14 商品隱藏、收集關閉時本人仍能撤回同意與取消登記', JSON.stringify({ r: hidRev.json.data, c: hidCancel.json.success }));
      await patchProduct(M, PID2, { show_on_line: 1 });
      await adm(M, 'PATCH', `/api/product-demand-admin/products/${PID2}/collect`, { enabled: true });
      // 既有（C3）未同意登記、舊版文案的 granted → 需重新確認
      const L1 = uid(14), L2 = uid(15);
      await restart(M, (db) => {
        const ru1 = 'aaaaaaaa-0000-4000-8000-000000000001', ru2 = 'aaaaaaaa-0000-4000-8000-000000000002';
        db.run(`INSERT INTO product_demand_requests (request_uuid,store_id,product_id,product_name_snapshot,line_user_id,desired_qty,fulfillment_pref,status,cycle_no,expires_at)
                VALUES (?,?,?,?,?,2,'any','active',1,datetime('now','+10 days'))`, [ru1, 'store_001', PID, '測試招牌飯', L1]);
        db.run(`INSERT INTO product_demand_requests (request_uuid,store_id,product_id,product_name_snapshot,line_user_id,desired_qty,fulfillment_pref,status,cycle_no,expires_at)
                VALUES (?,?,?,?,?,2,'any','active',1,datetime('now','+10 days'))`, [ru2, 'store_001', PID, '測試招牌飯', L2]);
        db.run(`INSERT INTO product_demand_consents (consent_uuid,store_id,product_id,line_user_id,request_uuid,channel,status,consent_text_version,granted_at)
                VALUES ('bbbbbbbb-0000-4000-8000-000000000002','store_001',?,?,?,'line','granted','restock-notify-v1',datetime('now'))`, [PID, L2, ru2]);
      });
      const m1 = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', L1) })).json.data[0];
      const m2 = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', L2) })).json.data[0];
      assert(m1.notify_consent === 'none' && m2.notify_consent === 'reconfirm_required', 'C15 舊版「我想買」登記不會自動變成通知訂閱；舊版文案的同意需重新確認', JSON.stringify({ m1: m1.notify_consent, m2: m2.notify_consent }));
      const inv1 = await invariants(M);
      assert(inv0 === inv1, 'C16 登記、同意、撤回、取消前後：訂單、付款、今日額度、預購額度完全未變', inv0 === inv1 ? 'same' : `${inv0}\n${inv1}`);
    }

    // ═════════════════ P：預覽 ═════════════════
    const PU = { A: uid(0xa1), B: uid(0xb2), C: uid(0xc3), D: uid(0xd4), E: uid(0xe5), F: uid(0xf6), G: uid(0x17), Hx: uid(0x18), I: uid(0x19) };
    if (run('p') || run('s') || run('r') || run('l')) {
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      // A 好友同意 any 2 份；B 好友同意 delivery；C 非好友；D 好友狀態不明；E 好友未同意；F 好友已撤回；G 已取消；H 已過期；I 無會員資料
      await reg(M, PU.A, PN, 2, { notify_consent: true, fulfillment_pref: 'any' });
      await reg(M, PU.B, PN, 1, { notify_consent: true, fulfillment_pref: 'delivery' });
      await reg(M, PU.C, PN, 1, { notify_consent: true });
      await reg(M, PU.D, PN, 1, { notify_consent: true });
      await reg(M, PU.E, PN, 4);
      await reg(M, PU.F, PN, 1, { notify_consent: true });
      await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', PU.F), product_id: PN });
      await reg(M, PU.G, PN, 1, { notify_consent: true });
      await pub(M, 'POST', '/api/product-demand/cancel', { member_session: session('store_001', PU.G), product_id: PN });
      await reg(M, PU.Hx, PN, 1, { notify_consent: true });
      await reg(M, PU.I, PN, 3, { notify_consent: true });
      await setFriend(M, [[PU.A, 1, '甲'], [PU.B, 1, '乙'], [PU.C, 0, '丙'], [PU.D, null, '丁'], [PU.E, 1, '戊'], [PU.F, 1, '己'], [PU.G, 1, '庚'], [PU.Hx, 1, '辛']]);
      await restart(M, (db) => { db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 minutes') WHERE line_user_id=? AND status='active'", [PU.Hx]); });
    }
    if (run('p')) {
      const inv0 = await invariants(M);
      const calls0 = mockCalls().length;
      const pv = (await preview(M, PN, 'takeout', T0)).json.data;
      const ex = pv.stats.exclusions;
      assert(pv.can_send === true && pv.batch_uuid && pv.stats.eligible_count === 1 && pv.stats.active_users === 7 && pv.stats.total_qty === 13 && pv.stats.consented_users === 5,
        'P1 正常販售今日外帶：有效 7 人／期望 13 份、已同意 5 人、符合資格 1 人（伺服器計算）', JSON.stringify(pv.stats));
      assert(ex.pref_mismatch === 1 && ex.not_friend === 1 && ex.friend_unknown === 1 && ex.no_consent === 1 && ex.consent_revoked === 1 && ex.cancelled === 1 && ex.expired === 1 && ex.member_not_found === 1 && ex.already_notified === 0,
        'P2 排除原因逐項正確：偏好不符、非好友、好友不明、未同意、已撤回、已取消、已過期、會員不存在', JSON.stringify(ex));
      assert(pv.notice_kind === 'restock' && /^【脆豬腰測試店】你登記的商品已恢復供應\n商品：測試補貨麵\n供應日期：/.test(pv.message_text) && pv.message_text.includes('取餐方式：外帶自取')
        && pv.message_text.includes('數量有限，實際供應以系統為準；本通知不代表訂單成立，也不保留商品。') && pv.message_text.includes(pv.link_url),
      'P3 訊息含店名、商品、日期、取餐方式、直達連結與免責說明（恢復供應）', pv.message_text);
      const lu = new URL(pv.link_url);
      const prodUuid = (await rows(M, 'SELECT product_uuid FROM products WHERE id=?', [PN]))[0].product_uuid;
      assert(lu.host === 'liff.line.me' && lu.pathname === '/' + LIFF && lu.searchParams.get('product_ref') === prodUuid && lu.searchParams.get('store_id') === 'store_001'
        && !/member_session|U[0-9a-f]{32}|line_user_id/.test(pv.link_url), 'P4 直達連結沿用店別 LIFF 設定、使用商品穩定識別，不含會員憑證或 LINE UID', pv.link_url);
      const pvD = (await preview(M, PN, 'delivery', T0)).json.data;
      assert(pvD.stats.eligible_count === 2 && pvD.message_text.includes('取餐方式：外送'), 'P5 外送：偏好 delivery 的會員也符合（2 人）', JSON.stringify(pvD.stats.exclusions));
      await patchProduct(M, PN, { sale_status: 'paused' });
      const pPause = (await preview(M, PN, 'takeout', T1)).json.data;
      await patchProduct(M, PN, { sale_status: 'sold_out_indefinitely' });
      const pDisc = (await preview(M, PN, 'takeout', T1)).json.data;
      assert(!pPause.can_send && pPause.blockers.includes('product_not_orderable') && pPause.orderability.reason === 'product_paused' && !pPause.batch_uuid
        && !pDisc.can_send && pDisc.orderability.reason === 'product_discontinued', 'P6 暫停販售／長期下架：任何日期都不可發出可訂購通知', JSON.stringify([pPause.orderability, pDisc.orderability]));
      await patchProduct(M, PN, { sale_status: 'sold_out_today' });
      const pTodaySO = (await preview(M, PN, 'takeout', T0)).json.data;
      const pFut = (await preview(M, PN, 'takeout', T1)).json.data;
      assert(!pTodaySO.can_send && pTodaySO.orderability.reason === 'sold_out_today' && pFut.can_send && pFut.notice_kind === 'preorder'
        && /你登記的商品已開放預購/.test(pFut.message_text) && pFut.message_text.includes('預購日期：'), 'P7 今日完售：今日不可通知；合法未來預購可通知，訊息明示「開放預購」', pFut.message_text.split('\n')[0]);
      await patchProduct(M, PN, { sale_status: 'available', line_quota_sold: 10 });
      const pQ0 = (await preview(M, PN, 'takeout', T0)).json.data;
      await patchProduct(M, PN, { line_quota_sold: 0, line_preorder_sold: 5 });
      const pP0 = (await preview(M, PN, 'takeout', T1)).json.data;
      await patchProduct(M, PN, { line_preorder_sold: 0 });
      assert(!pQ0.can_send && pQ0.orderability.reason === 'real_sold_out' && !pP0.can_send && pP0.orderability.reason === 'preorder_full', 'P8 今日額度為零／預購額度為零：不可通知', JSON.stringify([pQ0.orderability.reason, pP0.orderability.reason]));
      const pPast = await preview(M, PN, 'takeout', twDate(-1));
      const pFar = (await preview(M, PN, 'takeout', twDate(40))).json.data;
      const pBad = await preview(M, PN, 'takeout', '2026-02-30x');
      const pMode = await adm(M, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PN, fulfillment_mode: 'popup', supply_date: T0 });
      assert(pPast.json.data.orderability.reason === 'date_in_past' && !pPast.json.data.can_send && pFar.orderability.reason === 'preorder_limit_exceeded' && pBad.status === 400 && pMode.status === 400,
        'P9 日期無效（過去、超過可預訂天數、格式錯誤）與非外帶外送方式：不可通知', JSON.stringify([pPast.json.data.orderability.reason, pFar.orderability.reason, pBad.status, pMode.status]));
      await patchProduct(M, PN, { line_takeout_enabled: 0 });
      const pNoTk = (await preview(M, PN, 'takeout', T0)).json.data;
      await patchProduct(M, PN, { line_takeout_enabled: 1, show_on_line: 0 });
      const pHid = (await preview(M, PN, 'takeout', T0)).json.data;
      await patchProduct(M, PN, { show_on_line: 1 });
      assert(pNoTk.orderability.reason === 'product_mode_not_supported' && !pNoTk.can_send && pHid.orderability.reason === 'product_not_on_line' && !pHid.can_send, 'P10 商品不支援該取餐方式／LINE 未上架：不可通知', JSON.stringify([pNoTk.orderability.reason, pHid.orderability.reason]));
      await patchProduct(M, PN, { line_quota_daily: 3 });
      const pLess = (await preview(M, PN, 'takeout', T0)).json.data;
      await patchProduct(M, PN, { line_quota_daily: 10 });
      assert(pLess.stats.available_qty === 3 && pLess.stats.available_less_than_desired === true && pLess.stats.total_qty === 13, 'P11 可用份數（3）少於期望總份數（13）時如實標示', JSON.stringify(pLess.stats));
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const pOff = (await preview(M, PN, 'takeout', T0)).json.data;
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      assert(!pOff.can_send && pOff.blockers.includes('send_disabled') && pOff.stats.exclusions.config_incomplete === 1, 'P12 通知關閉時可預覽但不可發送', JSON.stringify(pOff.blockers));
      const dels = await rows(M, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries');
      const inv1 = await invariants(M);
      assert(Number(dels[0].c) === 0 && mockCalls().length === calls0, 'P13 預覽與修改庫存／商品狀態不建立任何發送、不呼叫 LINE', `dels=${dels[0].c} calls=${mockCalls().length - calls0}`);
      assert(inv0.replace(/"line_quota_daily":\d+/g, '') === inv1.replace(/"line_quota_daily":\d+/g, ''), 'P14 預覽前後：訂單、付款、已售今日／預購份數未變', 'checked');
    }

    // ═════════════════ S：發送 ═════════════════
    let firstBatch = null;
    if (run('s')) {
      fs.writeFileSync(MOCK_LOG, ''); setCtrl({ default: '200' });
      const inv0 = await invariants(M);
      const pv = (await preview(M, PN, 'takeout', T0)).json.data;
      // 並行確認（模擬連點與兩位管理員）
      const tokB = await H.login(M.s.base, 'store_001', 'pw001');
      const conc = await Promise.all([confirm(M, pv.batch_uuid), confirm(M, pv.batch_uuid), confirm(M, pv.batch_uuid, tokB), confirm(M, pv.batch_uuid, tokB), confirm(M, pv.batch_uuid)]);
      const effective = conc.filter((r) => r.json && r.json.success && r.json.data.already === false);
      const b = await waitBatch(M, pv.batch_uuid);
      firstBatch = pv.batch_uuid;
      const calls = mockCalls();
      assert(effective.length === 1 && conc.every((r) => r.json.success) && b.status === 'completed' && b.counts.accepted === 1 && calls.length === 1,
        'S1 連點／兩位管理員同時確認：只生效一次、只呼叫 LINE 一次', JSON.stringify({ eff: effective.length, st: b.status, counts: b.counts, calls: calls.length }));
      const d = b.deliveries.find((x) => x.status === 'accepted');
      const dbd = (await rows(M, "SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND status='accepted'", [pv.batch_uuid]))[0];
      assert(calls[0].retry_key && calls[0].retry_key === dbd.retry_key && calls[0].auth_present && d.line_request_id && dbd.accepted_at && Number(dbd.attempt_count) === 1 && dbd.first_attempt_at,
        'S2 第一次請求就帶固定 X-Line-Retry-Key；保存 LINE request ID、首次嘗試時間；狀態為「LINE 已受理」', JSON.stringify({ k: calls[0].retry_key, rid: d.line_request_id }));
      const req = (await rows(M, 'SELECT status, notified_at FROM product_demand_requests WHERE line_user_id=? AND product_id=?', [PU.A, PN]))[0];
      const mineA = (await pub(M, 'POST', '/api/product-demand/mine', { member_session: session('store_001', PU.A) })).json.data.find((x) => x.product_id === PN);
      assert(req.status === 'active' && req.notified_at && mineA && mineA.restock_notify === 'accepted' && mineA.status === 'active', 'S3 通知後登記仍為有效（唯一限制不釋放），本人仍可管理並看到已通知', JSON.stringify({ req, mine: mineA && mineA.restock_notify }));
      // 同週期：再預覽 → 已通知；修改份數、撤回後重新同意都不重置
      await reg(M, PU.A, PN, 6);
      await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', PU.A), product_id: PN });
      await reg(M, PU.A, PN, 6, { notify_consent: true });
      const pv2 = (await preview(M, PN, 'takeout', T0)).json.data;
      assert(pv2.stats.exclusions.already_notified === 1 && pv2.stats.eligible_count === 0 && !pv2.can_send, 'S4 同一週期跨批次防重：修改份數、撤回後重新同意都不會再通知', JSON.stringify(pv2.stats.exclusions));
      const reconf = await confirm(M, pv.batch_uuid);
      assert(reconf.json.data.already === true && mockCalls().length === 1, 'S5 重送相同確認請求：不建立新發送', JSON.stringify(reconf.json.data));
      // 資料庫唯一限制（直接嘗試插入第二筆占用名額 → 被拒）
      let uniqOk = false;
      { const db = await H.openDbFile(M.dbf); try { db.run(`INSERT INTO restock_notify_deliveries (delivery_uuid,batch_uuid,store_id,product_id,request_uuid,line_user_id,retry_key,claim,status) VALUES ('x-1','x-b','store_001',?,?,?, 'cccccccc-0000-4000-8000-000000000001',1,'pending')`, [PN, dbd.request_uuid, PU.A]); } catch (e) { uniqOk = /UNIQUE/i.test(e.message); } db.close(); }
      assert(uniqOk, 'S6 防重依資料庫唯一限制：同店同週期無法存在第二筆占用名額的紀錄', String(uniqOk));

      // 預覽後變化：B（外送）預覽 → 撤回同意；新會員；商品停售
      const N1 = uid(0x21);
      await reg(M, N1, PN, 1, { notify_consent: true, fulfillment_pref: 'delivery' });
      await setFriend(M, [[N1, 1, '新甲']]);
      const pvD = (await preview(M, PN, 'delivery', T0)).json.data; // 候選：B、N1
      const N2 = uid(0x22);
      await reg(M, N2, PN, 1, { notify_consent: true });
      await setFriend(M, [[N2, 1, '新乙']]);
      await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', PU.B), product_id: PN });
      const cD = await confirm(M, pvD.batch_uuid);
      const bD = await waitBatch(M, pvD.batch_uuid);
      const toN2 = mockCalls().filter((c) => c.uid === N2).length;
      assert(cD.json.data.queued === 1 && bD.counts.accepted === 1 && bD.counts.excluded === 1 && bD.deliveries.find((x) => x.status === 'excluded').exclusion_reason === 'consent_revoked' && toN2 === 0 && bD.deliveries.length === 2,
        'S7 預覽後撤回同意 → 確認時排除；預覽後新登記的會員不會加入原批次', JSON.stringify({ q: cD.json.data, counts: bD.counts }));
      // 預覽後停售 → 確認：全部排除，不呼叫
      const N3 = uid(0x23);
      await reg(M, N3, PN, 1, { notify_consent: true }); await setFriend(M, [[N3, 1, '新丙']]);
      const pvS = (await preview(M, PN, 'takeout', T1)).json.data;
      const callsS = mockCalls().length;
      await patchProduct(M, PN, { sale_status: 'paused' });
      const cS = await confirm(M, pvS.batch_uuid);
      const bS = await waitBatch(M, pvS.batch_uuid);
      await patchProduct(M, PN, { sale_status: 'available' });
      assert(cS.json.data.queued === 0 && bS.counts.excluded >= 1 && bS.deliveries.every((x) => x.exclusion_reason === 'product_not_orderable') && mockCalls().length === callsS && bS.status === 'completed',
        'S8 預覽後商品停售 → 確認時全部擋下，不呼叫 LINE', JSON.stringify(bS.counts));
      // 預覽後額度用完
      const pvQ = (await preview(M, PN, 'takeout', T0)).json.data;
      await patchProduct(M, PN, { line_quota_sold: 10 });
      const cQ = await confirm(M, pvQ.batch_uuid);
      await waitBatch(M, pvQ.batch_uuid);
      await patchProduct(M, PN, { line_quota_sold: 0 });
      assert(cQ.json.data.queued === 0 && mockCalls().length === callsS, 'S9 預覽後今日額度耗盡 → 擋下', JSON.stringify(cQ.json.data));
      // 預覽後關閉功能
      const pvO = (await preview(M, PN, 'takeout', T0)).json.data;
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const cO = await confirm(M, pvO.batch_uuid);
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      assert(cO.status === 409 && cO.json.code === 'NOTIFY_UNAVAILABLE' && mockCalls().length === callsS, 'S10 預覽後關閉通知 → 確認被拒（409），不呼叫 LINE', JSON.stringify(cO.json));
      // 發送中途變化：第二位收件人送出前撤回 → 被擋（第一位正常）
      const X1 = uid(0x31), X2 = uid(0x32);
      await reg(M, X1, PID, 1, { notify_consent: true }); await reg(M, X2, PID, 1, { notify_consent: true });
      await setFriend(M, [[X1, 1, 'X1'], [X2, 1, 'X2']]);
      setCtrl({ default: '200', byUser: { [X1]: ['hang', '200'] } }); // X1 第一次掛住直到逾時（700ms），期間撤回 X2
      const pvM = (await preview(M, PID, 'takeout', T1)).json.data;
      await confirm(M, pvM.batch_uuid);
      await sleep(250);
      await pub(M, 'POST', '/api/product-demand/consent/revoke', { member_session: session('store_001', X2), product_id: PID });
      const bM = await waitBatch(M, pvM.batch_uuid);
      const x2d = bM.deliveries.find((x) => x.status === 'blocked');
      const x1row = (await rows(M, 'SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [pvM.batch_uuid, X1]))[0];
      const x1calls = mockCalls().filter((c) => c.uid === X1);
      assert(x2d && x2d.exclusion_reason === 'consent_revoked' && mockCalls().filter((c) => c.uid === X2).length === 0 && x2d.attempt_count === 0,
        'S11 發送途中撤回：尚未送出的項目在送出前被擋下（0 次呼叫）', JSON.stringify(bM.counts));
      assert(x1row.status === 'accepted' && x1calls.length === 2 && x1calls[0].retry_key === x1calls[1].retry_key && x1calls[0].body_hash === x1calls[1].body_hash && x1calls[0].result === 'hang',
        'S12 真實逾時（AbortController 700ms）→ 不視為未送出，以同一 retry key、同一內容重試後受理', JSON.stringify(x1calls.map((c) => c.result)));
      const blockedClaim = (await rows(M, "SELECT claim FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?", [pvM.batch_uuid, X2]))[0];
      assert(blockedClaim.claim == null, 'S13 從未交給 LINE 的擋下項目釋放週期名額（重新同意後可在新批次通知）', JSON.stringify(blockedClaim));
      // 各種 LINE 回應
      const R = { ok: uid(0x41), lost: uid(0x42), to3: uid(0x43), e5: uid(0x44), bad: uid(0x45), c409: uid(0x46), rate: uid(0x47) };
      for (const u of Object.values(R)) await reg(M, u, 707, 1, { notify_consent: true });
      await setFriend(M, Object.entries(R).map(([k, u]) => [u, 1, k]));
      setCtrl({ default: '200', byUser: { [R.lost]: ['accepted_lost', '200'], [R.to3]: ['timeout', '500', '200'], [R.e5]: ['500', '500', '500', '500', '500'], [R.bad]: ['400'], [R.c409]: ['409_other'], [R.rate]: ['429_rate', '200'] } });
      const before = mockCalls().length;
      const pvR = (await preview(M, 707, 'takeout', T1)).json.data;
      await confirm(M, pvR.batch_uuid);
      const bR = await waitBatch(M, pvR.batch_uuid, 30000);
      const byU = async (u) => (await rows(M, 'SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [pvR.batch_uuid, u]))[0];
      const cl = (u) => mockCalls().slice(before).filter((c) => c.uid === u);
      const dOk = await byU(R.ok), dLost = await byU(R.lost), dTo = await byU(R.to3), dE5 = await byU(R.e5), dBad = await byU(R.bad), d409 = await byU(R.c409), dRate = await byU(R.rate);
      assert(dOk.status === 'accepted' && cl(R.ok).length === 1, 'S14 HTTP 200 → LINE 已受理（不是「已收到」）', dOk.status);
      assert(dLost.status === 'accepted' && dLost.error_code === 'retry_key_already_accepted' && dLost.accepted_request_id && cl(R.lost).length === 2 && cl(R.lost)[0].retry_key === cl(R.lost)[1].retry_key && cl(R.lost)[1].result === 409,
        'S15 LINE 已受理但回應遺失 → 重試沿用同一 retry key，取得官方 409（已受理），記為已受理、不換新 key', JSON.stringify({ st: dLost.status, calls: cl(R.lost).map((c) => c.result) }));
      assert(dTo.status === 'accepted' && Number(dTo.attempt_count) === 3 && new Set(cl(R.to3).map((c) => c.retry_key)).size === 1, 'S16 逾時、5xx 後以同一 key 退避重試，第 3 次受理', JSON.stringify(cl(R.to3).map((c) => c.result)));
      assert(dE5.status === 'unknown' && Number(dE5.attempt_count) === 4 && cl(R.e5).length === 4 && new Set(cl(R.e5).map((c) => c.retry_key)).size === 1, 'S17 5xx 達嘗試上限（4）→ 結果待確認，不無限重試、不換 key', JSON.stringify({ st: dE5.status, n: cl(R.e5).length }));
      assert(dBad.status === 'failed' && dBad.error_code === 'bad_request' && cl(R.bad).length === 1, 'S18 驗證錯誤（400）→ 失敗、不重試', dBad.status);
      assert(d409.status === 'unknown' && d409.error_code === 'conflict_unclassified' && cl(R.c409).length === 1, 'S19 非 retry-key 語意的 409 → 結果待確認，不建立新 key 重送', d409.error_code);
      assert(dRate.status === 'accepted' && cl(R.rate).length === 2 && cl(R.rate)[0].retry_key === cl(R.rate)[1].retry_key, 'S20 429 速率限制 → 退避後以同一 key 重試', JSON.stringify(cl(R.rate).map((c) => c.result)));
      assert(bR.counts.accepted === 4 && bR.status === 'completed', 'S21 單人失敗不影響其他收件人的結果', JSON.stringify(bR.counts));
      const safeErr = (await rows(M, 'SELECT error_code, line_request_id FROM restock_notify_deliveries')).every((x) => /^[a-z_]*$/.test(x.error_code || '') && /^[A-Za-z0-9-]*$/.test(x.line_request_id || ''));
      const logText = M.s.getLog();
      assert(safeErr && !logText.includes(TOKEN) && !(await rows(M, "SELECT COUNT(*) AS c FROM restock_notify_batches WHERE message_text LIKE ?", ['%' + TOKEN + '%']))[0].c,
        'S22 只保存安全錯誤代碼與 request ID；權杖不出現在伺服器紀錄或資料庫訊息', String(safeErr));
      // 權杖錯誤／額度：整批暫停，其餘待發送保留
      const Q1 = uid(0x51), Q2 = uid(0x52), Q3 = uid(0x53);
      for (const u of [Q1, Q2, Q3]) await reg(M, u, PID2, 1, { notify_consent: true });
      await setFriend(M, [[Q1, 1, 'Q1'], [Q2, 1, 'Q2'], [Q3, 1, 'Q3']]);
      setCtrl({ default: '401' });
      const pvA = (await preview(M, PID2, 'takeout', T1)).json.data;
      await confirm(M, pvA.batch_uuid);
      const bA = await waitBatch(M, pvA.batch_uuid);
      assert(bA.status === 'paused' && bA.pause_reason === 'auth_error' && bA.counts.held === 1 && bA.counts.pending === 2 && mockCalls().slice(before).filter((c) => [Q1, Q2, Q3].includes(c.uid)).length === 1,
        'S23 權杖錯誤（401）→ 不重試、整批暫停，其餘收件人保留待發送', JSON.stringify(bA.counts));
      setCtrl({ default: '429_quota' });
      const rA = await resume(M, pvA.batch_uuid);
      const bA2 = await waitBatch(M, pvA.batch_uuid);
      assert(rA.json.success && bA2.status === 'paused' && bA2.pause_reason === 'monthly_limit' && bA2.counts.held === 1 && bA2.counts.pending === 2, 'S24 當月額度用完（429）→ 整批暫停待店家處理，不無限重試', JSON.stringify(bA2.counts));
      setCtrl({ default: '200' });
      const heldKey = (await rows(M, "SELECT retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND status='held'", [pvA.batch_uuid]))[0].retry_key;
      await resume(M, pvA.batch_uuid);
      const bA3 = await waitBatch(M, pvA.batch_uuid);
      const keysUsed = mockCalls().filter((c) => c.retry_key === heldKey).length;
      assert(bA3.status === 'completed' && bA3.counts.accepted === 3 && keysUsed === 3, 'S25 店家續送沿用原逐筆紀錄與 retry key 完成發送', JSON.stringify({ c: bA3.counts, keysUsed }));
      const inv1 = await invariants(M);
      assert(inv0.replace(/"line_quota_(sold|daily)":\d+|"line_preorder_sold":\d+/g, '') === inv1.replace(/"line_quota_(sold|daily)":\d+|"line_preorder_sold":\d+/g, '') && JSON.stringify((await rows(M, 'SELECT line_quota_sold, line_preorder_sold FROM products WHERE id IN (701,702,706,707) ORDER BY id'))) === '[{"line_quota_sold":0,"line_preorder_sold":0},{"line_quota_sold":0,"line_preorder_sold":0},{"line_quota_sold":0,"line_preorder_sold":0},{"line_quota_sold":0,"line_preorder_sold":0}]',
        'S26 通知全流程前後：訂單、付款未變；今日／預購已售份數仍為 0（通知不扣份數）', 'checked');
    }

    // ═════════════════ R：重啟 ═════════════════
    if (run('r')) {
      const Y = uid(0x61);
      await reg(M, Y, PID, 2, { notify_consent: true }); await setFriend(M, [[Y, 1, 'Y']]);
      setCtrl({ default: '200', byUser: { [Y]: ['accepted_hang'] } });
      M.opts.env = { RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '20000' }; await restart(M);
      const pvY = (await preview(M, PID, 'takeout', T0)).json.data;
      await confirm(M, pvY.batch_uuid);
      let st = null;
      for (let i = 0; i < 60; i++) { st = (await rows(M, 'SELECT status FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [pvY.batch_uuid, Y]))[0]; if (st && st.status === 'sending' && mockCalls().some((c) => c.uid === Y)) break; await sleep(100); }
      M.s.proc.kill('SIGKILL'); await sleep(300);
      assert(st && st.status === 'sending', 'R1 送出後、寫回結果前中斷：資料庫已先保存「發送中」與 retry key', JSON.stringify(st));
      const callsBefore = mockCalls().length;
      M.opts.env = {}; await start(M);
      await sleep(1500);
      const afterBoot = (await rows(M, 'SELECT status, error_code, retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [pvY.batch_uuid, Y]))[0];
      const bY = (await detail(M, pvY.batch_uuid)).json.data;
      assert(afterBoot.status === 'unknown' && afterBoot.error_code === 'interrupted' && bY.status === 'paused' && bY.pause_reason === 'server_restart' && mockCalls().length === callsBefore,
        'R2 重啟後：該筆改為「結果待確認」、批次暫停；啟動服務不會自動發送；重新整理後仍可查詢', JSON.stringify({ afterBoot, b: bY.status }));
      setCtrl({ default: '200' });
      await resume(M, pvY.batch_uuid);
      const bY2 = await waitBatch(M, pvY.batch_uuid);
      const yc = mockCalls().filter((c) => c.uid === Y);
      const yRow = (await rows(M, 'SELECT status, error_code FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [pvY.batch_uuid, Y]))[0];
      assert(bY2.status === 'completed' && yRow.status === 'accepted' && yRow.error_code === 'retry_key_already_accepted' && yc.length === 2 && yc[0].retry_key === yc[1].retry_key && yc[1].result === 409,
        'R3 店家明確續送：沿用同一 retry key，LINE 回 409（已受理）→ 記為已受理，不重複通知', JSON.stringify(yc.map((c) => c.result)));
      // 超過 retry key 有效期限的結果不明項目
      const Z1 = uid(0x62);
      await reg(M, Z1, PID, 1, { notify_consent: true }); await setFriend(M, [[Z1, 1, 'Z1']]);
      setCtrl({ default: '200', byUser: { [Z1]: ['500', '500', '500', '500'] } });
      const pvZ = (await preview(M, PID, 'takeout', T0)).json.data;
      await confirm(M, pvZ.batch_uuid); await waitBatch(M, pvZ.batch_uuid);
      await restart(M, (db) => { db.run("UPDATE restock_notify_deliveries SET first_attempt_at=datetime('now','-25 hours') WHERE batch_uuid=?", [pvZ.batch_uuid]); });
      const zc0 = mockCalls().filter((c) => c.uid === Z1).length;
      setCtrl({ default: '200' });
      const rz = await resume(M, pvZ.batch_uuid);
      await sleep(400);
      const zRow = (await rows(M, 'SELECT status, error_code FROM restock_notify_deliveries WHERE batch_uuid=?', [pvZ.batch_uuid]))[0];
      const zDet = (await detail(M, pvZ.batch_uuid)).json.data.deliveries[0];
      assert(zRow.status === 'unknown' && zRow.error_code === 'retry_window_expired' && zDet.retry_window_expired && mockCalls().filter((c) => c.uid === Z1).length === zc0 && rz.json.data.resumed === 0,
        'R4 超過 retry key 有效期限（24 小時）的結果不明項目：不換新 key、不自動補送', JSON.stringify({ zRow, rz: rz.json.data }));
      // 預覽逾時
      const W1 = uid(0x63);
      await reg(M, W1, PID, 1, { notify_consent: true }); await setFriend(M, [[W1, 1, 'W1']]);
      const pvW = (await preview(M, PID, 'takeout', T0)).json.data;
      await restart(M, (db) => { db.run("UPDATE restock_notify_batches SET preview_expires_at=datetime('now','-1 minutes') WHERE batch_uuid=?", [pvW.batch_uuid]); });
      const cW = await confirm(M, pvW.batch_uuid);
      assert(cW.status === 409 && cW.json.code === 'PREVIEW_EXPIRED' && mockCalls().filter((c) => c.uid === W1).length === 0, 'R5 預覽逾時（30 分鐘）後不可直接確認發送', JSON.stringify(cW.json));
    }

    // ═════════════════ L：前台與後台畫面 ═════════════════
    if (run('l')) {
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      setCtrl({ default: '200' });
      const pageCtx = async (opts = {}) => {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([off]) => { if (off) { const RD = Date; class D extends RD { constructor(...a) { if (a.length === 0) super(RD.now() + off); else super(...a); } static now() { return RD.now() + off; } } window.Date = D; } }, [CLOCK_OFF]);
        await context.addInitScript(([k, v, mk, mv]) => {
          if (sessionStorage.getItem('__seeded')) return;
          if (v) localStorage.setItem(k, v);
          if (mv) localStorage.setItem(mk, mv);
          sessionStorage.setItem('__seeded', '1');
        }, ['line_order_cart_store_001', opts.savedCart ? JSON.stringify({ version: 1, store_id: 'store_001', cart_created_at: Date.now() - 3600e3, cart_updated_at: Date.now() - 3600e3, cart: opts.savedCart, order_mode: opts.mode || 'delivery', customer: { name: '原本姓名', phone: '0912345678' }, coupon_code: '', pickup_date: opts.pickupDate || T1, pickup_time: '', payment_method: '', order_note: '' }) : '',
          'line_member_session_store_001', opts.member ? JSON.stringify({ member_session: opts.member, display_name: '測試會員', is_friend: true, expires_at: Date.now() + 3600e3 }) : '']);
        const page = await context.newPage();
        if (opts.routes) await opts.routes(page);
        const errors = [], posts = [], events = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('dialog', async (d) => { try { await d.dismiss(); } catch {} });
        page.on('request', (req) => { if (req.method() !== 'POST') return; const u = req.url(); if (u.includes('/api/analytics/events')) { try { events.push(JSON.parse(req.postData() || '{}')); } catch {} return; } posts.push(u); });
        return { context, page, errors, posts, events };
      };
      const ref = (await rows(M, 'SELECT product_uuid FROM products WHERE id=?', [PN]))[0].product_uuid;
      // L1 商品直達：開啟正確商品、不改購物車／姓名／日期／取餐方式、不送單
      const saved = { [PID2]: 2 };
      const P1 = await pageCtx({ savedCart: saved, mode: 'delivery', pickupDate: T1 });
      const t0 = Date.now();
      await P1.page.goto(`${M.s.base}/line-order.html?store_id=store_001&product_ref=${ref}&src=restock&m=takeout&d=${T0}`, { waitUntil: 'domcontentloaded' });
      await P1.page.waitForFunction(() => document.getElementById('content') && getComputedStyle(document.getElementById('content')).display === 'block', null, { timeout: 20000 });
      const shownMs = Date.now() - t0;
      await P1.page.waitForSelector('.pdm-overlay', { state: 'attached', timeout: 10000 }).catch(() => {});
      await sleep(600);
      const s1 = await P1.page.evaluate(() => ({
        url: location.search, modalName: (document.getElementById('pdmName') || {}).textContent || '', modalOpen: !!document.querySelector('.pdm-overlay.pdm-open'),
        cart: JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty]))), mode: currentMode, stored: localStorage.getItem('line_order_cart_store_001'), notice: (document.getElementById('restockNoticeText') || {}).textContent || '',
      }));
      const storedObj = JSON.parse(s1.stored || '{}');
      assert(/測試補貨麵/.test(s1.modalName) && s1.modalOpen && !/product_ref|src=restock/.test(s1.url), 'L1 點連結開啟正確店別與指定商品（最新商品資料），網址參數已移除', JSON.stringify({ n: s1.modalName, url: s1.url }));
      assert(s1.cart === JSON.stringify({ [PID2]: 2 }) && s1.mode === 'delivery' && storedObj.customer && storedObj.customer.name === '原本姓名' && storedObj.pickup_date === T1 && storedObj.order_mode === 'delivery'
        && !P1.posts.some((u) => /\/api\/line-orders|linepay/.test(u)) && !P1.events.some((e) => /add_to_cart|purchase|submit_order/.test(JSON.stringify(e))),
      'L2 不自動加入購物車／送單／付款，不覆蓋既有購物車、姓名、日期與取餐方式', JSON.stringify({ cart: s1.cart, mode: s1.mode, posts: P1.posts }));
      assert(/通知對應/.test(s1.notice) && P1.errors.length === 0 && shownMs < 8000, 'L3 顯示通知對應日期／方式提示（不改選擇）；首屏正常、無 JavaScript 錯誤', JSON.stringify({ notice: s1.notice, shownMs, e: P1.errors }));
      await P1.page.screenshot({ path: path.join(shots, 'l1-deeplink.png') });
      await P1.context.close();
      // L4 找不到／隱藏／停售
      const P2 = await pageCtx();
      await P2.page.goto(`${M.s.base}/line-order.html?store_id=store_001&product_ref=00000000-0000-4000-8000-00000000abcd&src=restock`, { waitUntil: 'domcontentloaded' });
      await P2.page.waitForSelector('#restockNoticeText', { timeout: 15000 }).catch(() => {});
      const n2 = await P2.page.evaluate(() => ({ t: (document.getElementById('restockNoticeText') || {}).textContent || '', modal: !!document.querySelector('.pdm-overlay.pdm-open') }));
      await P2.context.close();
      await patchProduct(M, PN, { show_on_line: 0 });
      const P3 = await pageCtx();
      await P3.page.goto(`${M.s.base}/line-order.html?store_id=store_001&product_ref=${ref}`, { waitUntil: 'domcontentloaded' });
      await P3.page.waitForSelector('#restockNoticeText', { timeout: 15000 }).catch(() => {});
      const n3 = await P3.page.evaluate(() => (document.getElementById('restockNoticeText') || {}).textContent || '');
      await P3.context.close();
      await patchProduct(M, PN, { show_on_line: 1, sale_status: 'paused' });
      const P4 = await pageCtx();
      await P4.page.goto(`${M.s.base}/line-order.html?store_id=store_001&product_ref=${ref}`, { waitUntil: 'domcontentloaded' });
      await P4.page.waitForSelector('#restockNoticeText', { timeout: 15000 }).catch(() => {});
      await sleep(500);
      const n4 = await P4.page.evaluate(() => ({ t: (document.getElementById('restockNoticeText') || {}).textContent || '', cart: Object.keys(cart).length }));
      await P4.context.close();
      await patchProduct(M, PN, { sale_status: 'available' });
      assert(/未在 LINE 點餐頁提供/.test(n2.t) && !n2.modal && /未在 LINE 點餐頁提供/.test(n3) && /暫停販售/.test(n4.t) && n4.cart === 0, 'L4 商品不存在、隱藏、停售：正確提示，不加入購物車', JSON.stringify({ n2: n2.t, n3, n4 }));
      // L5 ID 重新對應：PN 的數字 ID 被另一款商品占用，穩定識別仍導向正確商品
      await restart(M, (db) => {
        db.run('UPDATE products SET id=? WHERE id=? AND store_id=?', [956, PN, 'store_001']);
        db.run(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,line_takeout_enabled,line_delivery_enabled) VALUES (?,?,?,?,?,?,1,1,'available',9,1,1)`, [PN, 'store_001', '占用舊ID的另一款', '飯類', 101, 10]);
      });
      const P5 = await pageCtx();
      await P5.page.goto(`${M.s.base}/line-order.html?store_id=store_001&product_ref=${ref}`, { waitUntil: 'domcontentloaded' });
      await P5.page.waitForSelector('.pdm-overlay', { state: 'attached', timeout: 15000 }).catch(() => {});
      await sleep(600);
      const n5 = await P5.page.evaluate(() => (document.getElementById('pdmName') || {}).textContent || '');
      await P5.context.close();
      const apiRef = (await pub(M, 'GET', `/api/product-demand/product-ref?ref=${ref}`)).json.data;
      await restart(M, (db) => { db.run('DELETE FROM products WHERE id=? AND store_id=?', [PN, 'store_001']); db.run('UPDATE products SET id=? WHERE id=? AND store_id=?', [PN, 956, 'store_001']); });
      assert(/測試補貨麵/.test(n5) && apiRef.found && apiRef.product_id === 956, 'L5 備份還原後數字 ID 被另一款商品占用：穩定識別仍開啟正確商品', JSON.stringify({ n5, apiRef }));
      // L6 Recovery／Handoff 優先：同時帶還原 token 時不開啟商品直達，首屏不卡住
      const P6 = await pageCtx();
      await P6.page.goto(`${M.s.base}/line-order.html?store_id=store_001&recovery_token=dummy-token-for-test&product_ref=${ref}`, { waitUntil: 'domcontentloaded' });
      await P6.page.waitForFunction(() => getComputedStyle(document.getElementById('content')).display === 'block', null, { timeout: 15000 });
      await sleep(1200);
      const n6 = await P6.page.evaluate(() => ({ modal: !!document.querySelector('.pdm-overlay.pdm-open'), notice: !!document.getElementById('restockNotice') }));
      await P6.context.close();
      assert(!n6.modal && !n6.notice, 'L6 Recovery 還原連結優先：不同時開啟商品直達，首屏正常', JSON.stringify(n6));
      // L7 訂閱介面
      const SUB = uid(0x71);
      await patchProduct(M, PN, { sale_status: 'paused' });
      const P7 = await pageCtx({ member: session('store_001', SUB) });
      await P7.page.goto(`${M.s.base}/line-order.html?store_id=store_001`, { waitUntil: 'domcontentloaded' });
      await P7.page.waitForSelector(`[data-demand-pid="${PN}"]`, { timeout: 20000 });
      const btn = await P7.page.$eval(`[data-demand-pid="${PN}"]`, (b) => b.textContent);
      await P7.page.click(`[data-demand-pid="${PN}"]`);
      await P7.page.waitForSelector('#dmConsent', { timeout: 8000 });
      const ui1 = await P7.page.evaluate(() => ({ checked: document.getElementById('dmConsent').checked, ctext: document.querySelector('.dm-consent span').textContent, submit: document.getElementById('dmSubmit').textContent, text: document.getElementById('demandPanel').innerText }));
      await P7.page.check('#dmConsent');
      const submit2 = await P7.page.$eval('#dmSubmit', (b) => b.textContent);
      assert(btn === '🔔 補貨通知我' && ui1.checked === false && ui1.ctext === '商品恢復供應或開放預購時，透過 LINE 通知我。' && ui1.submit === '送出想買登記' && submit2 === '登記並訂閱通知'
        && /不代表訂單成立/.test(ui1.text) && !/補貨立即通知我|登記補貨需求/.test(ui1.text), 'L7 通知可用：入口「🔔 補貨通知我」、勾選預設未勾選、按鈕依勾選切換文案、保留不保留商品說明', JSON.stringify({ btn, ui1, submit2 }));
      await P7.page.click('#dmSubmit');
      await sleep(1200);
      const c7 = await rows(M, "SELECT status FROM product_demand_consents WHERE line_user_id=?", [SUB]);
      await P7.page.click(`[data-demand-pid="${PN}"]`);
      await P7.page.waitForSelector('#dmSubscribed', { timeout: 8000 }).catch(() => {});
      const ui2 = await P7.page.evaluate(() => ({ sub: (document.getElementById('dmSubscribed') || {}).textContent || '', hasBox: !!document.getElementById('dmConsent'), revoke: (document.getElementById('dmRevoke') || {}).textContent || '' }));
      await P7.page.click('#dmRevoke'); await sleep(800);
      const c7b = await rows(M, "SELECT status FROM product_demand_consents WHERE line_user_id=?", [SUB]);
      const r7b = await rows(M, "SELECT status FROM product_demand_requests WHERE line_user_id=?", [SUB]);
      assert(c7.length === 1 && c7[0].status === 'granted' && /已訂閱補貨通知/.test(ui2.sub) && !ui2.hasBox && /取消補貨通知/.test(ui2.revoke) && c7b[0].status === 'revoked' && r7b[0].status === 'active' && P7.errors.length === 0,
        'L8 明確勾選後送出 → 已同意；再開啟顯示目前訂閱狀態，可只取消通知並保留想買登記', JSON.stringify({ c7, ui2, c7b, r7b }));
      await P7.page.screenshot({ path: path.join(shots, 'l7-subscribe.png') });
      await P7.context.close();
      // L9 通知不可用：維持「我想買」與不會發送通知的說明
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const P9 = await pageCtx({ member: session('store_001', uid(0x72)) });
      await P9.page.goto(`${M.s.base}/line-order.html?store_id=store_001`, { waitUntil: 'domcontentloaded' });
      await P9.page.waitForSelector(`[data-demand-pid="${PN}"]`, { timeout: 20000 });
      const b9 = await P9.page.$eval(`[data-demand-pid="${PN}"]`, (b) => b.textContent);
      await P9.page.click(`[data-demand-pid="${PN}"]`); await sleep(500);
      const u9 = await P9.page.evaluate(() => ({ box: !!document.getElementById('dmConsent'), text: document.getElementById('demandPanel').innerText, submit: document.getElementById('dmSubmit').textContent }));
      await P9.context.close();
      await adm(M, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      await patchProduct(M, PN, { sale_status: 'available' });
      assert(b9 === '我想買' && !u9.box && /尚不會發送補貨通知/.test(u9.text) && u9.submit === '送出登記', 'L9 通知未開啟：入口維持「我想買」並說明不會發送通知（後端回傳能力）', JSON.stringify({ b9, u9: u9.submit }));
      // L10 後台：預覽 → 確認發送 → 批次進度（重新整理後仍可查）
      const AD = uid(0x73);
      await reg(M, AD, PID2, 1, { notify_consent: true }); await setFriend(M, [[AD, 1, '後台測試']]);
      const actx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      await actx.addInitScript(([t, off]) => { if (off) { const RD = Date; class D extends RD { constructor(...a) { if (a.length === 0) super(RD.now() + off); else super(...a); } static now() { return RD.now() + off; } } window.Date = D; } localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); }, [M.tok, CLOCK_OFF]);
      const ap = await actx.newPage(); const aerr = [];
      ap.on('pageerror', (e) => aerr.push(e.message)); ap.on('dialog', (d) => d.accept());
      await ap.goto(M.s.base + '/');
      await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function');
      await ap.evaluate(() => showPage('line_products')); await sleep(800);
      await ap.evaluate(() => lpmSwitchTab('demand')); await sleep(800);
      const capTxt = await ap.evaluate(() => ({ cap: document.getElementById('pd-restock-cap').textContent, chk: document.getElementById('pd-set-notify').checked }));
      await ap.evaluate((id) => openDemandDetail(id), PID2);
      await ap.waitForSelector('#rn-preview-btn', { timeout: 8000 });
      await ap.selectOption('#rn-mode', 'takeout'); await ap.fill('#rn-date', T1);
      await ap.click('#rn-preview-btn');
      await ap.waitForSelector('#rn-preview-box', { timeout: 8000 });
      const apv = await ap.evaluate(() => ({ eligible: document.getElementById('rn-eligible').textContent, msg: document.getElementById('rn-msg').textContent, excl: document.getElementById('rn-excl').textContent, btn: !!document.getElementById('rn-confirm-btn') }));
      const callsA = mockCalls().length;
      const nBatches = await ap.evaluate(() => document.querySelectorAll('.rn-batch').length);
      await ap.click('#rn-confirm-btn');
      await ap.waitForFunction((n) => document.querySelectorAll('.rn-batch').length === n + 1 && /已完成/.test((document.querySelector('.rn-batch .rn-status') || {}).textContent || ''), nBatches, { timeout: 15000 }).catch(() => {});
      const abatch = await ap.evaluate(() => ({ st: (document.querySelector('.rn-batch .rn-status') || {}).textContent, counts: (document.querySelector('.rn-batch .rn-counts') || {}).textContent }));
      await ap.reload(); await ap.waitForFunction(() => typeof window.showPage === 'function');
      await ap.evaluate(() => showPage('line_products')); await sleep(600); await ap.evaluate(() => lpmSwitchTab('demand')); await sleep(600);
      await ap.evaluate((id) => openDemandDetail(id), PID2); await ap.waitForSelector('.rn-batch', { timeout: 8000 }).catch(() => {});
      const after = await ap.evaluate(() => (document.querySelector('.rn-batch .rn-counts') || {}).textContent || '');
      await ap.screenshot({ path: path.join(shots, 'l10-admin-restock.png') });
      await actx.close();
      assert(/已開啟/.test(capTxt.cap) && /未驗證/.test(capTxt.cap) && capTxt.chk && apv.eligible === '1' && /測試對照湯/.test(apv.msg) && apv.btn, 'L10 後台：顯示通知能力（權杖未驗證）、伺服器預覽名單與完整訊息', JSON.stringify({ capTxt, apv }));
      assert(/已完成/.test(abatch.st) && /LINE 已受理 1/.test(abatch.counts) && /LINE 已受理 1/.test(after) && mockCalls().length - callsA === 1 && aerr.length === 0, 'L11 後台按「確認發送」才發送；頁面重新整理後仍能查到批次進度', JSON.stringify({ abatch, after, aerr }));
    }

    // ═════════════════ B：MBV2 備份與還原 ═════════════════
    if (run('b')) {
      const callsB0 = mockCalls().length;
      // 準備：一筆未完成（held）批次、一筆撤回中的同意
      const HB1 = uid(0x81), HB2 = uid(0x82);
      await reg(M, HB1, 707, 1, { notify_consent: true }); await reg(M, HB2, 707, 1, { notify_consent: true });
      await setFriend(M, [[HB1, 1, 'HB1'], [HB2, 1, 'HB2']]);
      setCtrl({ default: '401' });
      const pvH = (await preview(M, 707, 'takeout', T1)).json.data;
      await confirm(M, pvH.batch_uuid); await waitBatch(M, pvH.batch_uuid);
      setCtrl({ default: '200' });
      const callsAfterSetup = mockCalls().length;
      const cfg = await adm(M, 'GET', '/api/migration/v2/config');
      const cats = ((cfg.json && (cfg.json.categories || (cfg.json.data && cfg.json.data.categories))) || []).map((c) => c.key);
      const epv = await adm(M, 'GET', '/api/migration/v2/export/preview');
      const epvCats = (epv.json && (epv.json.categories || (epv.json.data && epv.json.data.categories))) || [];
      const rnCat = epvCats.find((c) => c.key === 'restock_notify') || {};
      const pdCat = epvCats.find((c) => c.key === 'product_demand') || {};
      const bd = rnCat.breakdown || {};
      assert(cats.includes('restock_notify') && bd.kind === 'restock_notify_history' && bd.accepted_records > 0 && bd.execution_states && bd.execution_states.held === 1 && bd.execution_states.pending === 1 && pdCat.breakdown && pdCat.breakdown.kind === 'demand_consent_history',
        'B1 MBV2 新增「補貨通知紀錄」分類；預覽分開顯示需求與同意歷史、批次及已受理紀錄、執行狀態', JSON.stringify({ bd, pd: pdCat.breakdown }));
      const full = await H.download(M.s.base, M.tok, '/api/migration/v2/export?mode=full');
      const fj = JSON.parse(full.buf.toString('utf8'));
      const part = await H.download(M.s.base, M.tok, '/api/migration/v2/export?categories=product_demand,restock_notify');
      const pj = JSON.parse(part.buf.toString('utf8'));
      const srcAccepted = fj.data.restock_notify_deliveries.filter((d) => d.status === 'accepted').length;
      assert(fj.backup_type === 'full' && fj.data.restock_notify_batches.length > 0 && srcAccepted > 0 && pj.backup_type === 'partial'
        && Object.keys(pj.data).filter((k) => Array.isArray(pj.data[k])).sort().join(',') === 'product_demand_consents,product_demand_requests,restock_notify_batches,restock_notify_deliveries',
        'B2 完整與選擇性備份涵蓋通知歷史', JSON.stringify({ b: fj.data.restock_notify_batches.length, acc: srcAccepted }));
      // 目標：新環境（不同商品 ID）
      const T = await boot('btarget', { extraSeed: (db) => { db.run("UPDATE products SET id=id+100 WHERE store_id='store_001' AND id IN (701,702,706,707)"); } }); ctxs.push(T);
      await adm(T, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      const callsT0 = mockCalls().length;
      const up = await H.uploadRaw(T.s.base, T.tok, part.buf, { name: 'rn.json' });
      const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: ['product_demand', 'restock_notify'] });
      const pst = res.preview && (res.preview.result || res.preview).stats;
      const ist = res.import && res.import.result && res.import.result.stats;
      assert(res.import && res.import.status === 'done' && ist.restock_notify_deliveries.added === fj.data.restock_notify_deliveries.length && pst && pst.restock_notify_deliveries && pst.restock_notify_deliveries.added === ist.restock_notify_deliveries.added,
        'B3 選擇性匯入：預覽與正式匯入結果一致，通知紀錄全部匯入', JSON.stringify({ p: pst && pst.restock_notify_deliveries && pst.restock_notify_deliveries.added, i: ist && ist.restock_notify_deliveries.added }));
      const tb = await rows(T, "SELECT status, pause_reason, product_id FROM restock_notify_batches WHERE batch_uuid=?", [pvH.batch_uuid]);
      const td = await rows(T, "SELECT status, claim FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id", [pvH.batch_uuid]);
      const tAcc = await rows(T, "SELECT d.product_id, p.name FROM restock_notify_deliveries d LEFT JOIN products p ON p.id=d.product_id WHERE d.status='accepted'");
      const tCons = await rows(T, "SELECT COUNT(*) AS c FROM product_demand_consents WHERE status='granted' AND reconfirm_required=0");
      assert(tb[0].status === 'paused' && tb[0].pause_reason === 'imported' && td.every((x) => ['held', 'unknown'].includes(x.status)) && tb[0].product_id === 807,
        'B4 匯入的未完成工作一律暫停（批次 paused／逐筆 held），商品關聯正確對應（707→807）', JSON.stringify({ tb, td }));
      assert(tAcc.length === srcAccepted && tAcc.every((x) => x.name) && Number(tCons[0].c) === 0, 'B5 已受理紀錄保留並指向同名商品；匯入的同意全部需顧客重新確認', JSON.stringify({ n: tAcc.length, c: tCons[0].c }));
      await sleep(800);
      assert(mockCalls().length === callsT0, 'B6 匯入與還原後不自動發送', String(mockCalls().length - callsT0));
      await restart(T); await sleep(800);
      assert(mockCalls().length === callsT0, 'B7 匯入後重新啟動服務也不發送', String(mockCalls().length - callsT0));
      // 已通知的週期在新環境不會再被通知（即使顧客重新同意）
      const pvT = (await preview(T, 806, 'takeout', T0)).json.data;
      await reg(T, PU.A, 806, 6, { notify_consent: true });
      const pvT2 = (await preview(T, 806, 'takeout', T0)).json.data;
      assert(pvT.stats.eligible_count === 0 && pvT2.stats.exclusions.already_notified >= 1 && pvT2.stats.eligible_count === 0, 'B8 匯入後已受理與防重歷史保留：顧客在新環境重新同意也不再通知同一週期', JSON.stringify(pvT2.stats.exclusions));
      // 未完成工作續送：同意需重新確認 → 發送前擋下，不呼叫
      const rT = await resume(T, pvH.batch_uuid);
      const bT = await waitBatch(T, pvH.batch_uuid);
      // R54.4／MBV2-HF1-C4.1 調整：目標環境的商品穩定識別與來源不同（另一個資料庫各自產生），舊批次的訊息連結不屬於目前環境 →
      // C4.1 先以連結檢查擋下（409 BATCH_CONTEXT_MISMATCH）：從未嘗試的 HB2 作廢並釋放名額，曾嘗試的 HB1 原樣保留（結果待確認、保留名額與 key）。
      // 原本要驗證的「不發送」不變；同意需重新確認的排除仍由 B8 驗證。
      const hb = await rows(T, 'SELECT line_user_id, status, exclusion_reason, claim, attempt_count FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id', [pvH.batch_uuid]);
      assert(rT.status === 409 && rT.json.code === 'BATCH_CONTEXT_MISMATCH' && hb.find((x) => Number(x.attempt_count) === 0).status === 'blocked' && hb.find((x) => Number(x.attempt_count) === 0).exclusion_reason === 'link_mismatch'
        && hb.find((x) => Number(x.attempt_count) === 0).claim == null && hb.find((x) => Number(x.attempt_count) > 0).status === 'unknown' && Number(hb.find((x) => Number(x.attempt_count) > 0).claim) === 1 && mockCalls().length === callsT0,
        'B9 匯入的未完成工作（來自另一環境、連結不屬於目前環境）經店家續送 → 拒絕續送：未嘗試者作廢、已嘗試者保留，不發送', JSON.stringify({ st: rT.status, hb, counts: bT && bT.counts }));
      // 重複匯入
      const up2 = await H.uploadRaw(T.s.base, T.tok, part.buf, { name: 'rn.json' });
      const res2 = await H.previewAndImport(T.s.base, T.tok, up2.json.upload_id, { mode: 'merge', categories: ['product_demand', 'restock_notify'] });
      const st2 = res2.import.result.stats;
      const cnt2 = await rows(T, 'SELECT (SELECT COUNT(*) FROM restock_notify_deliveries) AS d, (SELECT COUNT(*) FROM restock_notify_batches) AS b');
      assert(st2.restock_notify_deliveries.added === 0 && st2.restock_notify_batches.added === 0 && Number(cnt2[0].d) === fj.data.restock_notify_deliveries.length && mockCalls().length === callsT0,
        'B10 重複匯入不重複新增、不再通知', JSON.stringify(res2.import.result.totals));
      // 撤回優先：來源（M）中 F 已撤回；舊備份有 granted → 目標仍為已撤回
      const fNow = await rows(T, "SELECT status FROM product_demand_consents WHERE line_user_id=? ORDER BY id", [PU.F]);
      const oldBackup = JSON.parse(part.buf.toString('utf8'));
      for (const c of oldBackup.data.product_demand_consents) if (c.line_user_id === PU.F) { c.status = 'granted'; c.revoked_at = ''; }
      const up3 = await H.uploadRaw(T.s.base, T.tok, Buffer.from(JSON.stringify(oldBackup)), { name: 'old.json' });
      const res3 = await H.previewAndImport(T.s.base, T.tok, up3.json.upload_id, { mode: 'merge', categories: ['product_demand', 'restock_notify'] });
      const fAfter = await rows(T, "SELECT status FROM product_demand_consents WHERE line_user_id=? ORDER BY id", [PU.F]);
      const pvF = (await preview(T, 806, 'takeout', T0)).json.data;
      assert(res3.import.status === 'done' && JSON.stringify(fNow) === JSON.stringify(fAfter) && fAfter.every((x) => x.status === 'revoked') && pvF.stats.eligible_count === 0,
        'B11 舊備份不能把目前已撤回的同意重新變成可發送授權', JSON.stringify({ fNow, fAfter }));
      // 舊格式（C3）備份：沒有通知分類 → 不清除、保守阻擋
      const legacy = JSON.parse(full.buf.toString('utf8'));
      legacy.selected_categories = legacy.selected_categories.filter((c) => c !== 'restock_notify');
      delete legacy.data.restock_notify_batches; delete legacy.data.restock_notify_deliveries;
      if (legacy.table_counts) { delete legacy.table_counts.restock_notify_batches; delete legacy.table_counts.restock_notify_deliveries; }
      for (const p of legacy.data.products || []) delete p.product_uuid;
      const before4 = await rows(T, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries');
      const up4 = await H.uploadRaw(T.s.base, T.tok, Buffer.from(JSON.stringify(legacy)), { name: 'legacy.json' });
      const accNames4 = await rows(T, "SELECT d.delivery_uuid, p.name FROM restock_notify_deliveries d LEFT JOIN products p ON p.id=d.product_id AND p.store_id=d.store_id WHERE d.status='accepted' ORDER BY d.id");
      const res4 = await H.previewAndImport(T.s.base, T.tok, up4.json.upload_id, { mode: 'replace', categories: legacy.selected_categories, confirm_text: 'store_001', password: 'pw001' });
      const after4 = await rows(T, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries');
      const accNames4b = await rows(T, "SELECT d.delivery_uuid, p.name FROM restock_notify_deliveries d LEFT JOIN products p ON p.id=d.product_id AND p.store_id=d.store_id WHERE d.status='accepted' ORDER BY d.id");
      assert(res4.import && res4.import.status === 'done' && Number(before4[0].c) === Number(after4[0].c) && JSON.stringify(accNames4) === JSON.stringify(accNames4b) && accNames4b.every((x) => x.name) && mockCalls().length === callsT0,
        'B12 沒有通知分類的舊（C3 格式）完整備份「完整取代」：現有通知紀錄不被清除，已受理紀錄重新對應到同一款商品，不發送', JSON.stringify({ st: res4.import && res4.import.status, err: res4.import && res4.import.error, b: before4[0].c, a: after4[0].c }));
      await safeStop(T.s);
      // 完整取代（來源 M）：商品 ID 互換的完整備份 → 補貨通知紀錄不清除，關聯依名稱／條碼重新對應
      const swap = JSON.parse(full.buf.toString('utf8'));
      const pA = swap.data.products.find((p) => p.id === PID), pB = swap.data.products.find((p) => p.id === 707);
      pA.id = 707; pB.id = PID;
      if (swap.ref_maps && swap.ref_maps.products) { const ra = swap.ref_maps.products[PID], rb = swap.ref_maps.products[707]; swap.ref_maps.products[PID] = rb; swap.ref_maps.products[707] = ra; }
      for (const t of ['product_demand_requests', 'product_demand_consents', 'restock_notify_batches', 'restock_notify_deliveries']) for (const r of swap.data[t]) { if (r.product_id === PID) r.product_id = 707; else if (r.product_id === 707) r.product_id = PID; }
      const mBefore = await rows(M, "SELECT d.delivery_uuid, p.name FROM restock_notify_deliveries d JOIN products p ON p.id=d.product_id AND p.store_id=d.store_id ORDER BY d.id");
      const nDelBefore = (await rows(M, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries'))[0].c;
      const upR = await H.uploadRaw(M.s.base, M.tok, Buffer.from(JSON.stringify(swap)), { name: 'swap-full.json' });
      const resR = await H.previewAndImport(M.s.base, M.tok, upR.json.upload_id, { mode: 'replace', categories: swap.selected_categories, confirm_text: 'store_001', password: 'pw001' });
      const mAfter = await rows(M, "SELECT d.delivery_uuid, p.name FROM restock_notify_deliveries d JOIN products p ON p.id=d.product_id AND p.store_id=d.store_id ORDER BY d.id");
      const nDelAfter = (await rows(M, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries'))[0].c;
      const pidNow = (await rows(M, "SELECT id FROM products WHERE store_id='store_001' AND name='測試招牌飯'"))[0].id;
      assert(resR.import && resR.import.status === 'done' && pidNow === 707 && Number(nDelAfter) === Number(nDelBefore) && JSON.stringify(mBefore) === JSON.stringify(mAfter),
        'B13 完整取代（商品 ID 互換）：通知紀錄不被清除，已受理紀錄仍指向同一款商品（不被改指向另一款）', JSON.stringify({ st: resR.import && resR.import.status, err: resR.import && resR.import.error, pidNow, nDelBefore, nDelAfter }));
      await sleep(500);
      assert(mockCalls().length === callsAfterSetup && callsAfterSetup - callsB0 === 1, 'B14 備份、匯入、完整取代全程沒有任何新的 LINE 呼叫（只有準備階段的 1 次 401 模擬）', `setup=${callsAfterSetup - callsB0} after=${mockCalls().length - callsAfterSetup}`);
    }

    // ═════════════════ K：C3.3 程式讀取 C4 升級後資料庫（回退相容）═════════════════
    if (run('k') && process.env.C4_BASELINE_ROOT) {
      await safeStop(M.s);
      const BASE = process.env.C4_BASELINE_ROOT;
      const port = await new Promise((r) => { const sv = require('net').createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => r(p)); }); });
      const { spawn } = require('child_process');
      const proc = spawn(process.execPath, ['-r', CLOCK, '-r', NET_MOCK, 'server.js'], { cwd: BASE, env: { ...process.env, PORT: String(port), POS_DB_PATH: M.dbf, HF1C3_PUSH_COUNT_FILE: PUSH_FILE, TZ: 'Asia/Taipei', MIGRATION_TMP_DIR: path.join(M.dir, 'up3') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 150; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await sleep(150); }
      const tok = await H.login(base, 'store_001', 'pw001');
      const menu = await fetch(base + '/api/line-menu?store_id=store_001').then((r) => r.json());
      const cfgOld = await fetch(base + '/api/product-demand/config?store_id=store_001').then((r) => r.json());
      const regOld = await fetch(base + '/api/product-demand/register?store_id=store_001', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: session('store_001', uid(0x91)), product_id: PID2, desired_qty: 1, notify_consent: true }) }).then((r) => r.json());
      const sumOld = await H.api(base, tok, 'GET', '/api/product-demand-admin/summary');
      const html = await fetch(base + '/line-order.html?store_id=store_001');
      const ord = await fetch(base + '/api/line-orders?store_id=store_001', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_name: '回退測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: T1, pickup_time: '12:00', payment_method: 'cash', items: [{ product_id: PID2, qty: 1, name: '測試對照湯', price: 60 }] }) }).then((r) => r.json());
      proc.kill('SIGTERM'); await sleep(800);
      const keepRn = await rows(M, 'SELECT COUNT(*) AS c FROM restock_notify_deliveries');
      assert(menu.success && cfgOld.success && cfgOld.data.notify_available === false && regOld.success && sumOld.json && sumOld.json.success && html.status === 200 && ord.success && Number(keepRn[0].c) > 0 && !/SQLITE_ERROR|no such column/i.test(log),
        'K1 C3.3 程式可直接讀取 C4 升級後的資料庫：首頁、商品、想買登記、後台統計、正式送單正常；C4 新增資料表保留', JSON.stringify({ menu: menu.success, notify: cfgOld.data && cfgOld.data.notify_available, reg: regOld.success, ord: ord.success || ord.message, rn: keepRn[0].c }));
      const c4full = await (async () => { await start(M); const d = await H.download(M.s.base, M.tok, '/api/migration/v2/export?mode=full'); await safeStop(M.s); return d.buf; })();
      const proc2 = spawn(process.execPath, ['-r', CLOCK, '-r', NET_MOCK, 'server.js'], { cwd: BASE, env: { ...process.env, PORT: String(port), POS_DB_PATH: M.dbf, HF1C3_PUSH_COUNT_FILE: PUSH_FILE, TZ: 'Asia/Taipei', MIGRATION_TMP_DIR: path.join(M.dir, 'up4') }, stdio: 'ignore' });
      for (let i = 0; i < 150; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await sleep(150); }
      const tok3 = await H.login(base, 'store_001', 'pw001');
      const upOld = await H.uploadRaw(base, tok3, c4full, { name: 'c4-full.json' });
      const pOld = upOld.json && upOld.json.upload_id ? await H.previewAndImport(base, tok3, upOld.json.upload_id, { mode: 'merge', categories: ['products'] }) : { rejectedAtUpload: upOld.json || upOld.status };
      proc2.kill('SIGTERM'); await sleep(800);
      assert(!(pOld.import && pOld.import.status === 'done'), 'K2 已知限制：C3.3 無法匯入 C4 產生的完整備份（含新分類），會明確拒絕而不是部分匯入',
        JSON.stringify(pOld.rejectedAtUpload || (pOld.preview && (pOld.preview.error || pOld.preview.status)) || (pOld.previewResp && pOld.previewResp.json) || '').slice(0, 300));
      await start(M);
    }

    // ═════════════════ Z ═════════════════
    const sim = mockCalls().length;
    const real = realLineAttempts();
    console.log(`\n模擬 LINE API 呼叫次數（程序內攔截、未連外）：${sim}`);
    console.log(`真實 LINE API 呼叫次數：${real}`);
    assert(real === 0, 'Z1 真實 LINE API 呼叫次數為 0（所有 api.line.me 請求皆由測試程序內模擬回應）', `simulated=${sim} real=${real}`);
    if (process.env.C4_STATS_FILE) fs.writeFileSync(process.env.C4_STATS_FILE, JSON.stringify({ simulated_line_calls: sim, real_line_calls: real, clock_offset_ms: CLOCK_OFF }));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    for (const c of ctxs) { try { await safeStop(c.s); } catch {} }
    await browser.close();
  }
  const { passCount, failCount, results } = H.summary();
  if (process.env.C4_RESULT_JSON) fs.writeFileSync(process.env.C4_RESULT_JSON, JSON.stringify({ passCount, failCount, results }, null, 1));
  console.log(`\nRESULT: ${passCount} passed, ${failCount} failed  (screenshots: ${shots})`);
  process.exit(failCount ? 1 : 0);
})();
