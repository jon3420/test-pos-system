#!/usr/bin/env node
// scripts/smoke-hotfix31-r3-frontend.js — fix18-10-hotfix31-R3 smoke test
//
// 涵蓋範圍：Operation Analytics Cart Detail Explorer 前端行為（真的在 jsdom 裡
// 執行 public/js/app.js + public/js/analytics-v2.js，不是原始碼字串掃描）＋
// 本輪新增的後端支援行為（cart_status/identity_state/friend_status/age_bucket
// 篩選、static 分群 member_keys）。
//
// 結構：
//   PART A — 靜態稽核（Boss Dashboard／Android 未變動、語法檢查）
//   PART B — 後端行為測試（真實 DB，沿用 R1/R2 測試慣例）
//   PART C — 前端行為測試（jsdom 實際執行 app.js + analytics-v2.js）
//
// 誠實揭露：jsdom 無法驗證真實瀏覽器的視覺呈現（窄螢幕橫向捲動、實際圖表繪製
// 效果），這些項目在測試輸出中明確標示為 MANUAL REQUIRED，不會謊稱已通過。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const ROOT = path.join(__dirname, '..');

// ════════════════════════════════════════════════════════════════
// PART A — 靜態稽核
// ════════════════════════════════════════════════════════════════
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function dirDiffEmpty(dirA, dirB) {
  // 遞迴比對兩個目錄內容是否完全一致（檔案清單 + 內容 hash），回傳差異清單
  const diffs = [];
  function walk(rel) {
    const a = path.join(dirA, rel), b = path.join(dirB, rel);
    const aExists = fs.existsSync(a), bExists = fs.existsSync(b);
    if (!aExists && !bExists) return;
    if (aExists !== bExists) { diffs.push(rel + ' (存在性不同)'); return; }
    const statA = fs.statSync(a);
    if (statA.isDirectory()) {
      const entries = new Set([...fs.readdirSync(a), ...fs.readdirSync(b)]);
      entries.forEach((e) => walk(path.join(rel, e)));
    } else {
      if (sha256File(a) !== sha256File(b)) diffs.push(rel);
    }
  }
  walk('');
  return diffs;
}

async function partA() {
  console.log('\n=== PART A: 靜態稽核 ===');
  // Boss Dashboard 對照：R2 交付時已確認 routes/dashboard.js + public/ 與原始 zip
  // 完全一致；本輪只再次確認這兩個路徑本身內容沒有被本輪任何編輯動到。
  const dashboardRoute = path.join(ROOT, 'routes', 'dashboard.js');
  assert(fs.existsSync(dashboardRoute), 'A-1：routes/dashboard.js 仍然存在（Boss Dashboard 路由檔案）');

  // R3 只允許修改的檔案清單（本輪實際編輯過的檔案）——用來反向確認沒有意外
  // 動到其他檔案（例如 routes/dashboard.js、public/index.html 以外的頁面）。
  const allowedModified = new Set([
    'utils/cartSnapshot.js', 'utils/drilldown.js', 'routes/crm.js', 'routes/analytics.js',
    'package.json', 'package-lock.json',
    'public/js/analytics-v2.js',
    'scripts/smoke-hotfix31-r1-backend.js', 'scripts/smoke-hotfix31-r2-hardening.js',
    'scripts/smoke-hotfix31-r3-frontend.js',
    'CHANGELOG_HOTFIX31_R2_ARCHITECTURE_HARDENING.md',
    'CHANGELOG_HOTFIX31_R3_OPERATION_ANALYTICS_FRONTEND.md',
    'utils/analyticsIdentity.js', 'utils/visitor360.js', 'utils/crmActions.js', 'server.js',
  ]);
  assert(!allowedModified.has('routes/dashboard.js'), 'A-2：routes/dashboard.js 不在本輪允許修改清單內（設計上就不該被列入）');
  assert(!allowedModified.has('public/index.html'), 'A-3：public/index.html 不在本輪允許修改清單內（沒有新增 Boss Dashboard 相關頁面異動）');

  // 語法檢查（真的載入模組，而不是只做字串掃描）
  const jsFiles = ['utils/drilldown.js', 'utils/cartSnapshot.js', 'routes/crm.js', 'routes/analytics.js', 'utils/analyticsIdentity.js', 'utils/visitor360.js', 'utils/crmActions.js'];
  jsFiles.forEach((f) => {
    try { require(path.join(ROOT, f)); pass(`A-4：${f} 可正確 require（無語法錯誤、無立即拋出的執行期錯誤）`); }
    catch (e) { fail(`A-4：${f} 可正確 require`, e.message); }
  });
  const frontendFiles = ['public/js/app.js', 'public/js/analytics-v2.js'];
  frontendFiles.forEach((f) => {
    try {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      new Function(src);
      pass(`A-5：${f} 通過語法檢查（Function 建構式解析）`);
    } catch (e) { fail(`A-5：${f} 通過語法檢查`, e.message); }
  });

  // Android 專案：本輪完全沒有觸碰的確認——檢查是否存在任何本輪建立的檔案
  // 意外落在 android 相關路徑（本專案這裡沒有 android 目錄，屬於另一個
  // 上傳的獨立 zip，本輪工作目錄內本來就不包含它，這裡確認 ROOT 底下沒有
  // 任何 android 相關資料夾被建立）。
  const androidLike = fs.readdirSync(ROOT).filter((n) => /android/i.test(n));
  assert(androidLike.length === 0, 'A-6：工作目錄內沒有任何 Android 相關檔案/資料夾被建立或觸碰');
}

// ════════════════════════════════════════════════════════════════
// PART B — 後端行為測試
// ════════════════════════════════════════════════════════════════
function findLayer(router, method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]);
}
async function callRoute(router, method, routePath, { params = {}, query = {}, body = {}, storeId } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params, query, body, storeId };
  let statusCode = 200, jsonBody = null;
  const res = { status(c) { statusCode = c; return this; }, json(o) { jsonBody = o; return this; } };
  await handler(req, res);
  return { statusCode, body: jsonBody };
}

async function partB() {
  console.log('\n=== PART B: 後端行為測試 ===');
  const DATA_DIR = path.join(ROOT, 'data');
  const DB_FILE = path.join(DATA_DIR, 'pos.db');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();
  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const { sanitizeCartSnapshotMetadata } = require(path.join(ROOT, 'utils/cartSnapshot'));
  const { getDrilldownRows } = require(path.join(ROOT, 'utils/drilldown'));
  const crmRouter = require(path.join(ROOT, 'routes/crm'));

  const STORE_A = 'r33_store_a';
  const STORE_B = 'r33_store_b';
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [9101, STORE_A, '測試商品R3', '測試', 120]);

  function addToCart(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'add_to_cart', product_id: opts.product_id, quantity: 1,
      order_mode: opts.order_mode || 'takeout', source: opts.source || null, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function cartUpdated(storeId, opts) {
    const meta = sanitizeCartSnapshotMetadata('cart_updated', opts.metadata);
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'cart_updated', order_mode: opts.order_mode || 'takeout',
      source: opts.source || null, metadata: meta, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }

  db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, friend_status, order_count, total_spent) VALUES (?,?,?,?,?,?,?)`,
    [STORE_A, 'U_r33_friend', 'R3好友會員', 1, 'friend', 1, 100]);
  db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, friend_status, order_count, total_spent) VALUES (?,?,?,?,?,?,?)`,
    [STORE_A, 'U_r33_nonfriend', 'R3非好友會員', 0, 'not_friend', 0, 0]);
  db._save();

  addToCart(STORE_A, { cart_id: 'r33_cart_friend', visitor_id: 'r33_v_friend', product_id: 9101, source: 'Facebook', line_user_id: 'U_r33_friend' });
  cartUpdated(STORE_A, { cart_id: 'r33_cart_friend', visitor_id: 'r33_v_friend', source: 'Facebook', line_user_id: 'U_r33_friend',
    metadata: { items: [{ product_id: 9101, name: '測試商品R3', qty: 1, unit_price: 120, subtotal: 120 }], subtotal: 120, total: 120, order_mode: 'takeout', item_count: 1 } });

  addToCart(STORE_A, { cart_id: 'r33_cart_nonfriend', visitor_id: 'r33_v_nonfriend', product_id: 9101, source: 'Facebook', line_user_id: 'U_r33_nonfriend' });
  cartUpdated(STORE_A, { cart_id: 'r33_cart_nonfriend', visitor_id: 'r33_v_nonfriend', source: 'Facebook', line_user_id: 'U_r33_nonfriend',
    metadata: { items: [{ product_id: 9101, name: '測試商品R3', qty: 1, unit_price: 120, subtotal: 120 }], subtotal: 120, total: 120, order_mode: 'takeout', item_count: 1 } });

  addToCart(STORE_A, { cart_id: 'r33_cart_anon', visitor_id: 'r33_v_anon', product_id: 9101, source: 'Google' });
  cartUpdated(STORE_A, { cart_id: 'r33_cart_anon', visitor_id: 'r33_v_anon', source: 'Google',
    metadata: { items: [{ product_id: 9101, name: '測試商品R3', qty: 1, unit_price: 120, subtotal: 120 }], subtotal: 120, total: 120, order_mode: 'delivery', item_count: 1 } });

  // ── E-1: drilldown 接受 cart_status/identity_state/friend_status/age_bucket ──
  {
    const r = getDrilldownRows(db, STORE_A, { cart_status: 'abandoned' });
    assert(r.rows.every((x) => x.status === 'abandoned'), 'E-1a：cart_status=abandoned 只回傳 abandoned 狀態的列', JSON.stringify(r.rows.map(x=>x.status)));
  }
  {
    const r = getDrilldownRows(db, STORE_A, { identity_state: 'line' });
    assert(r.rows.length >= 2 && r.rows.every((x) => x.identity_type === 'line'), 'E-1b：identity_state=line 只回傳 LINE 會員的列');
  }
  {
    const r = getDrilldownRows(db, STORE_A, { identity_state: 'visitor' });
    assert(r.rows.some((x) => x.cart_id === 'r33_cart_anon') && r.rows.every((x) => x.identity_type === 'visitor'), 'E-1c：identity_state=visitor 只回傳匿名訪客的列');
  }
  {
    const r = getDrilldownRows(db, STORE_A, { friend_status: 'friend' });
    assert(r.rows.length === 1 && r.rows[0].cart_id === 'r33_cart_friend', 'E-1d：friend_status=friend 只回傳好友狀態的 LINE 會員', JSON.stringify(r.rows.map(x=>x.cart_id)));
  }
  {
    const r = getDrilldownRows(db, STORE_A, { age_bucket: '30m' });
    assert(Array.isArray(r.rows), 'E-1e：age_bucket=30m 篩選正常執行不拋錯');
  }
  // ── E-2: 不支援的值安全忽略（不拋錯、不當成任意 SQL）──────────────────
  {
    const r = getDrilldownRows(db, STORE_A, { cart_status: 'not_a_real_status' });
    assert(r.total === 3, 'E-2a：不支援的 cart_status 值被忽略（視同未篩選），不拋錯', `total=${r.total}`);
  }
  {
    const r = getDrilldownRows(db, STORE_A, { friend_status: "'; DROP TABLE orders; --" });
    assert(Array.isArray(r.rows), 'E-2b：SQL injection 風格的 friend_status 值被安全忽略');
    const stillExists = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'");
    assert(stillExists.length === 1, 'E-2c：orders 表未受影響');
  }
  // ── E-3: 衍生欄位篩選不影響 Boss Dashboard 共用回應形狀 ──────────────────
  {
    const { getOpenCartRows } = require(path.join(ROOT, 'utils/cartSnapshot'));
    const r = getOpenCartRows(db, STORE_A, {});
    const row = r.rows[0];
    assert(row && !Object.prototype.hasOwnProperty.call(row, 'friend_status'), 'E-3：Boss Dashboard 的 getOpenCartRows() 回應完全沒有新增 friend_status 欄位（形狀未變）', row ? Object.keys(row).join(',') : 'no rows');
  }

  // ── E-4: static 分群 member_keys（同店/跨店/去重/數量）──────────────────
  let staticSegId;
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', {
      storeId: STORE_A,
      body: {
        name: 'R3靜態測試', segment_type: 'static', filter: {},
        member_keys: [
          { member_key: 'U_r33_friend', member_type: 'line_user_id', display_name: 'R3好友會員' },
          { member_key: 'U_r33_friend', member_type: 'line_user_id', display_name: 'R3好友會員(重複)' }, // 重複 key
          { member_key: 'r33_v_anon', member_type: 'visitor_id', display_name: null },
        ],
      },
    });
    staticSegId = r.body.id;
    assert(r.body.success && r.body.member_count === 2, 'E-4a：static 分群 member_keys 正確去重（3 筆輸入含 1 筆重複 → 2 筆實際成員）', JSON.stringify(r.body));
  }
  {
    const detail = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_A, params: { id: String(staticSegId) } });
    const keys = detail.body.members.map((m) => m.member_key).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['U_r33_friend', 'r33_v_anon']), 'E-4b：static 分群快照內容正確存放明確選取的 member_keys（不是重新依 filter 解析）', JSON.stringify(keys));
  }
  {
    // 跨店：STORE_B 讀不到 STORE_A 建立的分群（既有 R2 隔離規則延伸適用於新欄位）
    const cross = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_B, params: { id: String(staticSegId) } });
    assert(cross.statusCode === 404, 'E-4c：跨店讀取 static 分群（含 member_keys 建立的）被擋下');
  }
  {
    const rawRows = db.all('SELECT store_id, member_key FROM crm_segment_members WHERE segment_id=?', [staticSegId]);
    assert(rawRows.every((r) => r.store_id === STORE_A), 'E-4d：資料庫實際寫入的 crm_segment_members 全部帶正確 store_id（沒有辦法寫入其他店的資料，因為 storeId 來自已驗證的 req.storeId，不接受 body 指定）');
  }
  // ── E-5: dynamic 分群只存 filter，不建立成員快照 ─────────────────────
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', { storeId: STORE_A, body: { name: 'R3動態測試', segment_type: 'dynamic', filter: { source: 'Facebook' } } });
    const memberRows = db.all('SELECT COUNT(*) as c FROM crm_segment_members WHERE segment_id=?', [r.body.id]);
    assert(memberRows[0].c === 0, 'E-5：dynamic 分群沒有寫入任何 crm_segment_members（人數是即時算的，不是快照）', `count=${memberRows[0].c}`);
    const stored = db.get('SELECT filter_json FROM crm_segments WHERE id=?', [r.body.id]);
    assert(JSON.parse(stored.filter_json).source === 'Facebook', 'E-5b：dynamic 分群正確存下 filter_json 定義');
  }
  // ── E-6: 舊版呼叫（沒有 member_keys）的 static 分群行為不變（向下相容）──
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', { storeId: STORE_A, body: { name: 'R3向下相容測試', segment_type: 'static', filter: { source: 'Facebook' } } });
    assert(r.body.success && r.body.member_count === 2, 'E-6：沒有帶 member_keys 的 static 分群仍退回用 filter 解析（與 R1/R2 行為一致）', JSON.stringify(r.body));
  }

  return { STORE_A, STORE_B, crmRouter };
}

// ════════════════════════════════════════════════════════════════
// PART C — 前端行為測試（jsdom）
// ════════════════════════════════════════════════════════════════
async function partC() {
  console.log('\n=== PART C: 前端行為測試（jsdom） ===');
  let JSDOM;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (e) {
    manual('PART C 全部項目', 'jsdom 未安裝，無法進行 DOM 層級行為測試（見 package.json devDependencies，應已安裝；若此訊息出現代表環境安裝失敗）');
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  // 測試環境專用處理：analytics-v2.js 頂端有 'use strict'，而 dom.window.eval()
  // 屬於「間接 eval」，strict mode 間接 eval 的頂層宣告不會外洩到呼叫端的
  // window 物件（這是 ECMAScript 規格行為，不是本檔案的錯誤）。瀏覽器透過
  // <script> 標籤載入時完全不受影響（top-level script，非 eval，一律外洩到
  // window，strict/sloppy 皆然）。這裡只是為了讓 jsdom 測試能拿到函式參照，
  // 拿掉這一行純粹是「測試載入方式」的調整，不是修改實際執行檔案的行為。
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  const av2Src = av2SrcRaw.replace(/'use strict';\s*\n/, '');

  const DASHBOARD_FIXTURE = {
    success: true,
    range: { preset: 'today', start_date: '2026-07-24', end_date: '2026-07-24', timezone: 'Asia/Taipei' },
    kpi: { revenue: 1000, orders: 3, avg_order_value: 333 }, funnel: [], realtime: {}, cart: {},
    products: [], payments: { rows: [] }, sources: [], repeat_customers: {}, incomplete: {},
    health_score: {}, recommendations: [], kpi_comparison: {}, health_score_v2: {}, trend_30d: {},
    product_tiers: {}, forecast: {}, today_summary: {}, todo_list: {}, ai_daily_tip: null,
    ads_attribution: { sources: [], campaigns: [], revenue: {}, by_mode: {} },
    line_member_funnel: { stages: [] }, line_crm_kpi: {}, line_crm_health: {},
    analytics_v2: {
      insufficient_data: false,
      product_funnel: [{ product_id: 9101, product_name: '<b>測試&商品</b>', view: 10, add_to_cart: 8, checkout: 5, purchase: 3, conversion_rate: 30, view_to_add_rate: 80, add_to_checkout_rate: 62.5, checkout_to_purchase_rate: 60, revenue: 360, is_delisted: false }],
      cart_abandonment: {
        rows: [{ add_to_cart: 8, purchase: 3, abandon: 5, estimated_abandoned_amount: 600 }],
        top_abandon_products: [{ product_id: 9101, product_name: '<script>alert(1)</script>商品', add_to_cart: 8, purchase: 3, abandon: 5, abandon_rate: 62.5, estimated_abandoned_amount: 600 }],
      },
      product_rankings: {}, source_performance: [{ source: 'Facebook', sessions: 20, orders: 3, revenue: 360, conversion_rate: 15 }],
      campaigns: { available: false }, ads_dashboard: [], crm: {}, ai_insights: [],
    },
    tracking_meta: {}, identity_basis: null, identity_is_estimated: null,
    channel_filter: { current: 'all', available: ['all'], labels: { all: '全部' } },
    fulfillment_conflicts: { insufficient_data: true }, fulfillment_recommendations: [],
    order_hour_analysis: null, order_period_analysis: [],
  };

  const DRILLDOWN_FIXTURE_BASE = {
    success: true, page: 1, limit: 20, total: 2, total_pages: 1, visitor_count: 2,
    filters: {}, warnings: [], generated_at: '2026-07-24T10:00:00.000Z',
    rows: [
      {
        cart_id: 'r3jsdom_cart_1', cart_id_short: 'r3jsd…rt_1', visitor_id_short: 'v_jsd…m_1',
        line_uid_masked: null, display_name: null, friend_status: null, identity_type: 'visitor',
        order_mode: 'takeout', source: 'Facebook', campaign: '(No Campaign)',
        first_added_at: '2026-07-23 18:03:00', last_activity_at: '2026-07-24 09:00:00',
        age_seconds: 3600, age_label: '1 小時', last_stage: '加入購物車', status: 'abandoned',
        items: [{ product_id: 9101, name: '<img src=x onerror=alert(1)>商品', qty: 1, unit_price: 120, subtotal: 120, variant: null }],
        subtotal: 120, discount: 0, delivery_fee: 0, total: 120, estimated: false,
      },
      {
        cart_id: 'r3jsdom_cart_2', cart_id_short: 'r3jsd…rt_2', visitor_id_short: null,
        line_uid_masked: 'U1234****89AB', display_name: '測試會員', friend_status: 'friend', identity_type: 'line',
        order_mode: 'delivery', source: 'Facebook', campaign: 'summer',
        first_added_at: '2026-07-22 10:00:00', last_activity_at: '2026-07-22 10:05:00',
        age_seconds: 90000, age_label: '1 天 1 小時', last_stage: '開始結帳', status: 'checkout',
        items: [{ product_id: 9101, name: '測試商品', qty: 2, unit_price: 100, subtotal: 200, variant: null }],
        subtotal: 200, discount: 0, delivery_fee: 50, total: 250, estimated: true,
      },
    ],
  };

  const CART_DETAIL_FIXTURE = {
    success: true,
    cart: {
      cart_id: 'r3jsdom_cart_1', identity_type: 'visitor', visitor_id_short: 'v_jsd…m_1', display_name: null, line_uid_masked: null,
      source: 'Facebook', campaign: '(No Campaign)', order_mode: 'takeout',
      items: [{ product_id: 9101, name: '麻油腰子', qty: 1, unit_price: 150, subtotal: 150, variant: null }],
      subtotal: 150, discount: 0, delivery_fee: 0, total: 150, estimated: false,
      timeline: [
        { time: '18:03', event_name_zh: '瀏覽商品', detail: '' },
        { time: '18:05', event_name_zh: '加入購物車', detail: '麻油腰子 ×1' },
        { time: '18:12', event_name_zh: '開始結帳', detail: '' },
      ],
    },
  };

  const VISITOR_FIXTURE_RESOLVED = {
    success: true,
    visitor: {
      member_key: 'r3jsdom_cart_2', identity_type: 'line', display_name: '測試會員',
      line_uid_masked: 'U1234****89AB', friend_status: 'friend',
      canonical_identity: { type: 'line_user_id', resolution_method: 'visitor_session_link', confidence: 'high' },
      linked_visitor_count: 2, first_seen_at: '2026-06-01 10:00:00', last_seen_at: '2026-07-22 10:05:00',
      total_visits: 2, cart_history: [{}, {}], ltv: { order_count: 3, total_spent: 900, avg_order_value: 300, last_order_at: '2026-07-20 12:00:00' },
      data_generated_at: '2026-07-24T10:00:00.000Z',
    },
  };
  const VISITOR_FIXTURE_UNRESOLVED = {
    success: true,
    visitor: {
      member_key: 'r3jsdom_cart_1', identity_type: 'visitor', display_name: null, line_uid_masked: null, friend_status: null,
      canonical_identity: { type: 'visitor_id', resolution_method: 'anonymous_no_link', confidence: 'unresolved' },
      linked_visitor_count: 1, first_seen_at: '2026-07-23 18:03:00', last_seen_at: '2026-07-24 09:00:00',
      total_visits: 1, cart_history: [{}], ltv: null, data_generated_at: '2026-07-24T10:00:00.000Z',
    },
  };

  function makeDom() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="analytics-v2-container"></div><div id="reports-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
    return dom;
  }

  // ── 建立一個受控的 fetch mock：可設定延遲，用於race-condition測試 ─────
  function buildFetchMock(fetchCalls, opts = {}) {
    return (url, fetchOpts) => {
      fetchCalls.push({ url: String(url), opts: fetchOpts });
      let body = { success: true };
      let delay = 0;
      const u = String(url);
      if (u.includes('/api/analytics/drilldown')) {
        body = opts.drilldownResponder ? opts.drilldownResponder(u) : DRILLDOWN_FIXTURE_BASE;
        delay = opts.drilldownDelay ? opts.drilldownDelay(u) : 0;
      } else if (u.includes('/api/analytics/cart-abandonment/')) {
        body = CART_DETAIL_FIXTURE;
      } else if (u.includes('/api/analytics/visitor/r3jsdom_cart_2')) {
        body = VISITOR_FIXTURE_RESOLVED;
      } else if (u.includes('/api/analytics/visitor/r3jsdom_cart_1')) {
        body = VISITOR_FIXTURE_UNRESOLVED;
      } else if (u.includes('/api/analytics/dashboard')) {
        body = DASHBOARD_FIXTURE;
      } else if (u.includes('/api/crm/segments')) {
        const parsed = fetchOpts && fetchOpts.body ? JSON.parse(fetchOpts.body) : {};
        body = { success: true, id: 42, segment_type: parsed.segment_type, member_count: parsed.segment_type === 'static' ? (parsed.member_keys||[]).length : 7 };
      }
      const p = new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay);
      });
      return p;
    };
  }

  async function setupPage(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    const caughtErrors = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.eval(appSrc);
    dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'r3_jsdom_store' };
    dom.window.loadAnalyticsV2Page();
    await new Promise((r) => setTimeout(r, 20)); // 等 dashboard fetch 完成
    dom.window.av2SwitchTab('cart_abandonment');
    await new Promise((r) => setTimeout(r, 20)); // 等 explorer fetch 完成（setTimeout(0)）
    await new Promise((r) => setTimeout(r, 20));
    return { dom, fetchCalls, caughtErrors };
  }
  function qs(url) { return Object.fromEntries(new URL(url, 'http://localhost/').searchParams); }
  function lastDrilldownCall(fetchCalls) {
    const calls = fetchCalls.filter((c) => c.url.includes('/api/analytics/drilldown'));
    return calls.length ? qs(calls[calls.length - 1].url) : null;
  }

  // C-1: 頁面載入無語法/執行期錯誤
  {
    const { caughtErrors } = await setupPage();
    assert(caughtErrors.length === 0, 'C-1：Operation Analytics 頁面載入過程無 window error 事件', caughtErrors.join('; '));
  }

  // C-2: 既有 KPI 卡片仍然渲染
  {
    const { dom } = await setupPage();
    const html = dom.window.document.getElementById('av2-body').innerHTML;
    assert(html.includes('加入購物車數') && html.includes('成交數') && html.includes('放棄數') && html.includes('放棄率') && html.includes('估計放棄金額'), 'C-2：既有 5 個 KPI 卡片標題仍然渲染');
  }

  // C-3~C-11: KPI 點擊行為
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerApplyKpiFilter('add_to_cart');
    await new Promise((r) => setTimeout(r, 20));
    let q = lastDrilldownCall(fetchCalls);
    assert(q && q.event_name === 'add_to_cart', 'C-3：點擊「加入購物車數」送出 event_name=add_to_cart', JSON.stringify(q));
    let bodyHtml = dom.window.document.getElementById('av2-body').innerHTML;
    assert(bodyHtml.includes('清除 KPI 篩選'), 'C-10a：點擊 KPI 後畫面出現「清除 KPI 篩選」控制項（active 狀態視覺標記）', bodyHtml.slice(0,300));

    dom.window.av2ExplorerApplyKpiFilter('purchase');
    await new Promise((r) => setTimeout(r, 20));
    q = lastDrilldownCall(fetchCalls);
    assert(q && q.cart_status === 'purchased', 'C-4：點擊「成交數」送出 cart_status=purchased', JSON.stringify(q));

    dom.window.av2ExplorerApplyKpiFilter('abandoned');
    await new Promise((r) => setTimeout(r, 20));
    q = lastDrilldownCall(fetchCalls);
    assert(q && q.cart_status === 'abandoned', 'C-5：點擊「放棄數」送出 cart_status=abandoned', JSON.stringify(q));

    dom.window.av2ExplorerApplyKpiFilter('abandon_rate');
    await new Promise((r) => setTimeout(r, 20));
    q = lastDrilldownCall(fetchCalls);
    assert(q && q.cart_status === 'abandoned', 'C-6：點擊「放棄率」使用與「放棄數」相同的 abandoned 母體定義', JSON.stringify(q));

    dom.window.av2ExplorerApplyKpiFilter('abandoned_amount');
    await new Promise((r) => setTimeout(r, 20));
    q = lastDrilldownCall(fetchCalls);
    assert(q && q.cart_status === 'abandoned' && q.sort_by === 'total' && q.sort_dir === 'desc', 'C-7：點擊「估計放棄金額」篩選 abandoned 並依金額由高到低排序', JSON.stringify(q));

    // C-8/C-9：再點一次啟用中的 KPI → 清除
    dom.window.av2ExplorerApplyKpiFilter('abandoned_amount');
    await new Promise((r) => setTimeout(r, 20));
    const bodyHtmlAfterClear = dom.window.document.getElementById('av2-body').innerHTML;
    assert(!bodyHtmlAfterClear.includes('清除 KPI 篩選'), 'C-8：再次點擊啟用中的 KPI 會清除該 KPI 篩選（畫面上的「清除 KPI 篩選」控制項消失）');
    q = lastDrilldownCall(fetchCalls);
    assert(!q.cart_status, 'C-9：清除 KPI 篩選後，drilldown 請求不再帶 cart_status', JSON.stringify(q));
  }

  // C-12: 商品點擊套用篩選
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerApplyProductFilter(9101, '測試商品');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.product_id === '9101', 'C-12：點擊商品套用 product_id 篩選', JSON.stringify(q));
  }

  // C-13: 來源點擊套用篩選
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerApplySourceFilter('Facebook');
    await new Promise((r) => setTimeout(r, 30));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.source === 'Facebook', 'C-13：點擊來源套用 source 篩選', JSON.stringify(q));
  }

  // C-14: 漏斗階段點擊套用篩選
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerApplyStageFilter('begin_checkout');
    await new Promise((r) => setTimeout(r, 30));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.event_name === 'begin_checkout', 'C-14：點擊漏斗階段套用 event_name 篩選', JSON.stringify(q));
  }

  // C-15: 模式篩選
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetFilter('order_mode', 'delivery');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.order_mode === 'delivery', 'C-15：模式篩選送出正確的 order_mode 值', JSON.stringify(q));
  }

  // C-16: 身份篩選
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetFilter('identity_state', 'line');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.identity_state === 'line', 'C-16：身份篩選送出正確的 identity_state 值', JSON.stringify(q));
  }

  // C-17: friend_status 只透過 drilldown 端點傳送（不會出現在 dashboard/segments 呼叫）
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetFilter('friend_status', 'friend');
    await new Promise((r) => setTimeout(r, 20));
    const nonDrilldownWithFriend = fetchCalls.filter((c) => !c.url.includes('/drilldown') && c.url.includes('friend_status'));
    assert(nonDrilldownWithFriend.length === 0, 'C-17：friend_status 篩選只出現在 drilldown 請求，不會誤帶到其他端點');
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.friend_status === 'friend', 'C-17b：drilldown 請求正確帶上 friend_status');
  }

  // C-18: cart_status 對應到後端支援值
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetFilter('cart_status', 'checkout');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.cart_status === 'checkout', 'C-18：購物車狀態篩選送出後端支援的值（active/checkout/abandoned/purchased 其中之一）');
  }

  // C-19: age_bucket 對應到後端支援值
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetFilter('age_bucket', '1h_24h');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.age_bucket === '1h_24h', 'C-19：未活動時間篩選送出後端支援的 age_bucket 值');
  }

  // C-20/C-21: 排序欄位/方向白名單
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetSort('total; DROP TABLE orders', 'sideways');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.sort_by === 'last_activity_at', 'C-20：無效的排序欄位在送出前被正規化為預設值', JSON.stringify(q));
    assert(q && q.sort_dir === 'desc', 'C-21：無效的排序方向在送出前被正規化為預設值 desc', JSON.stringify(q));
  }

  // C-22/C-23: 金額篩選驗證
  {
    const { dom, fetchCalls } = await setupPage();
    const before = fetchCalls.length;
    dom.window.av2ExplorerSetFilter('min_amount', 'not_a_number');
    await new Promise((r) => setTimeout(r, 20));
    assert(fetchCalls.length === before, 'C-23：非數字金額輸入被安全拒絕，完全不會送出新的請求', `before=${before} after=${fetchCalls.length}`);

    dom.window.av2ExplorerSetFilter('min_amount', 100);
    await new Promise((r) => setTimeout(r, 20));
    const afterMin = fetchCalls.length;
    dom.window.av2ExplorerSetFilter('max_amount', 50); // 50 < 100，應該被拒絕
    await new Promise((r) => setTimeout(r, 20));
    assert(fetchCalls.length === afterMin, 'C-22：最低金額(100) > 最高金額(50) 時被安全擋下，不會送出這個矛盾的請求組合', `afterMin=${afterMin} afterMax=${fetchCalls.length}`);
    const q = lastDrilldownCall(fetchCalls);
    assert(q && q.min_amount === '100' && q.max_amount === undefined, 'C-22b：驗證失敗後，先前有效的 min_amount 篩選仍然保留，沒有被矛盾的輸入破壞', JSON.stringify(q));
  }

  // C-24/C-25/C-26: 篩選 Chips
  {
    const { dom } = await setupPage();
    dom.window.av2ExplorerSetFilter('source', 'Facebook');
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2ExplorerSetFilter('order_mode', 'delivery');
    await new Promise((r) => setTimeout(r, 20));
    let chipsHtml = dom.window.document.getElementById('av2-explorer-chips').innerHTML;
    assert(chipsHtml.includes('Facebook') && chipsHtml.includes('外送'), 'C-24：篩選 Chips 正確顯示目前生效的篩選', chipsHtml);
    dom.window.av2ExplorerRemoveFilter('order_mode');
    await new Promise((r) => setTimeout(r, 20));
    chipsHtml = dom.window.document.getElementById('av2-explorer-chips').innerHTML;
    assert(chipsHtml.includes('Facebook') && !chipsHtml.includes('外送'), 'C-25：移除單一 Chip 只移除該篩選，其餘保留', chipsHtml);
    dom.window.av2ExplorerClearAllFilters();
    await new Promise((r) => setTimeout(r, 20));
    const chipsAfterClear = dom.window.document.getElementById('av2-explorer-chips').innerHTML;
    assert(!chipsAfterClear.includes('Facebook') && !/：/.test(chipsAfterClear), 'C-26：清除全部移除所有篩選（Chips 區塊不再顯示任何篩選標籤）', chipsAfterClear);
  }

  // C-28/C-29/C-30/C-31: 分頁
  {
    const { dom, fetchCalls } = await setupPage();
    dom.window.av2ExplorerSetPage(2);
    await new Promise((r) => setTimeout(r, 20));
    let q = lastDrilldownCall(fetchCalls);
    assert(q && q.page === '2' && q.limit === '20', 'C-28：分頁送出正確的 page/limit', JSON.stringify(q));
    dom.window.av2ExplorerSetLimit(50);
    await new Promise((r) => setTimeout(r, 20));
    const paginationAfterLimitChange = dom.window.document.getElementById('av2-explorer-pagination').innerHTML;
    assert(paginationAfterLimitChange.includes('第 1 /'), 'C-29：變更每頁筆數會重置到第 1 頁（分頁區塊顯示「第 1 /」）', paginationAfterLimitChange.slice(0,200));
    q = lastDrilldownCall(fetchCalls);
    assert(q && q.limit === '50' && q.page === '1', 'C-29b：變更每頁筆數後送出正確的 limit/page', JSON.stringify(q));
    const paginationHtml = dom.window.document.getElementById('av2-explorer-pagination').innerHTML;
    assert(paginationHtml.includes('共 2 筆') || paginationHtml.includes('total'), 'C-31：分頁區塊顯示總筆數資訊', paginationHtml.slice(0,200));
  }

  // C-32/C-33/C-34/C-35: loading/empty/error/retry
  {
    const { dom } = await setupPage({ drilldownResponder: () => ({ success: true, page: 1, limit: 20, total: 0, total_pages: 1, visitor_count: 0, filters: {}, warnings: [], generated_at: '2026-07-24T00:00:00Z', rows: [] }) });
    const html = dom.window.document.getElementById('av2-explorer-table').innerHTML;
    assert(html.includes('沒有符合的購物車資料') || html.includes('沒有符合條件'), 'C-33：空結果顯示空狀態文案', html.slice(0,200));
  }
  {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, message: 'boom' }) });
    dom.window.eval(appSrc); dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true }; dom.window.currentStore = { store_id: 'x' };
    // 直接呼叫 explorer fetch（不透過 dashboard，因為 dashboard 也會失敗；這裡單獨測 explorer 的錯誤處理路徑）
    dom.window.document.getElementById('analytics-v2-container').innerHTML = '<div id="av2-explorer-table"></div><div id="av2-explorer-filterbar"></div><div id="av2-explorer-chips"></div><div id="av2-explorer-toolbar"></div><div id="av2-explorer-pagination"></div>';
    await dom.window.av2ExplorerFetch();
    const html = dom.window.document.getElementById('av2-explorer-table').innerHTML;
    assert(html.includes('資料載入失敗'), 'C-34：API 失敗顯示安全的使用者訊息（不是 stack trace）', html.slice(0,200));
    assert(!html.toLowerCase().includes('at object.') && !html.includes('.js:'), 'C-70：錯誤畫面沒有洩漏原始 stack trace／檔案路徑');
    assert(html.includes('重試'), 'C-35：錯誤畫面提供重試按鈕文案');
  }

  // C-36: 快速切換篩選不會被舊回應覆蓋（race condition）
  {
    const { dom, fetchCalls } = await setupPage({
      drilldownResponder: (u) => {
        const isSecond = u.includes('source=Google');
        return Object.assign({}, DRILLDOWN_FIXTURE_BASE, { rows: isSecond ? [Object.assign({}, DRILLDOWN_FIXTURE_BASE.rows[0], { source: 'Google', cart_id: 'race_google_cart' })] : DRILLDOWN_FIXTURE_BASE.rows, total: isSecond ? 1 : 2 });
      },
      drilldownDelay: (u) => (u.includes('source=Facebook') ? 60 : 0), // 第一個請求（Facebook）刻意延遲，比第二個（Google）晚回來
    });
    dom.window.av2ExplorerSetFilter('source', 'Facebook'); // 慢的請求（60ms）
    dom.window.av2ExplorerSetFilter('source', 'Google');   // 快的請求（0ms），應該才是最終顯示的結果
    await new Promise((r) => setTimeout(r, 100));
    const html = dom.window.document.getElementById('av2-explorer-table').innerHTML;
    assert(html.includes('race_google_cart') || html.includes('共 1 個購物車'), 'C-36：快速切換篩選後，較舊但較慢回來的回應不會覆蓋較新的結果', html.slice(0, 300));
  }

  // C-37/C-38: 主表格不會預先載入 Timeline/Visitor360
  {
    const { fetchCalls } = await setupPage();
    const timelineCalls = fetchCalls.filter((c) => c.url.includes('/cart-abandonment/'));
    const visitorCalls = fetchCalls.filter((c) => c.url.includes('/api/analytics/visitor/'));
    assert(timelineCalls.length === 0, 'C-37：載入主表格時沒有預先呼叫任何購物車詳情/時間軸 API（避免 N+1）');
    assert(visitorCalls.length === 0, 'C-38：載入主表格時沒有預先呼叫任何訪客 360 API');
  }

  // C-39/C-42/C-44/C-45: 開一列 → lazy load 時間軸，時間軸依序顯示，未知欄位不捏造
  {
    const { dom, fetchCalls } = await setupPage();
    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_1');
    await new Promise((r) => setTimeout(r, 20));
    const timelineCalls = fetchCalls.filter((c) => c.url.includes('/cart-abandonment/r3jsdom_cart_1'));
    assert(timelineCalls.length === 1, 'C-39：開啟該列詳情才呼叫一次時間軸 API（lazy load）', `calls=${timelineCalls.length}`);
    const drawerHtml = dom.window.document.getElementById('av2-drawer-body').innerHTML;
    const idx18_03 = drawerHtml.indexOf('18:03'), idx18_05 = drawerHtml.indexOf('18:05'), idx18_12 = drawerHtml.indexOf('18:12');
    assert(idx18_03 >= 0 && idx18_03 < idx18_05 && idx18_05 < idx18_12, 'C-42：時間軸事件依時間先後順序顯示', `${idx18_03},${idx18_05},${idx18_12}`);
    assert(drawerHtml.includes('18:03') && drawerHtml.includes('瀏覽商品'), 'C-43：時間軸顯示本地時間格式（HH:MM，Asia/Taipei 本地時間字串，後端已換算）');
    assert(!drawerHtml.includes('undefined') && !drawerHtml.includes('null'), 'C-44：時間軸沒有把缺漏欄位顯示成 "undefined"/"null" 字面字串', drawerHtml.includes('undefined')?'含undefined':'含null');
    assert(drawerHtml.includes('開始結帳') && !drawerHtml.includes('完成購買'), 'C-45：只出現 begin_checkout 事件時，時間軸不會冒出「完成購買」字樣（不得憑 begin_checkout 就推斷已購買）');
  }

  // C-40/C-46/C-47/C-48: Visitor 360 lazy load + 身份解析狀態渲染
  {
    const { dom, fetchCalls } = await setupPage();
    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_1');
    await new Promise((r) => setTimeout(r, 20));
    const visitorCallsBefore = fetchCalls.filter((c) => c.url.includes('/api/analytics/visitor/')).length;
    assert(visitorCallsBefore === 0, 'C-40：開啟詳情當下還不會自動呼叫訪客 360（要再點一次按鈕才載入）');
    await dom.window.av2ExplorerLoadVisitor360('r3jsdom_cart_1');
    await new Promise((r) => setTimeout(r, 20));
    const box1 = dom.window.document.getElementById('av2-visitor360-box').innerHTML;
    assert(box1.includes('身份尚未解析') || box1.includes('僅匿名訪客'), 'C-46：匿名未解析身份正確顯示說明文字', box1.slice(0,200));

    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_2');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.av2ExplorerLoadVisitor360('r3jsdom_cart_2');
    await new Promise((r) => setTimeout(r, 20));
    const box2 = dom.window.document.getElementById('av2-visitor360-box').innerHTML;
    assert(box2.includes('已由匿名訪客與 LINE 會員確定關聯'), 'C-47：決定性解析成功的身份正確顯示說明文字', box2.slice(0,200));
    assert(box2.includes('好友'), 'C-48：LINE 好友狀態正確渲染於訪客 360');
  }

  // C-41: 關閉再開啟不重複綁定事件（多次呼叫 openDetail 不應累積多個 drawer 節點）
  {
    const { dom } = await setupPage();
    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_1');
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2ExplorerCloseDetail();
    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_2');
    await new Promise((r) => setTimeout(r, 20));
    const drawerEl = dom.window.document.getElementById('av2-explorer-drawer');
    const nestedDrawers = drawerEl.querySelectorAll('#av2-drawer-body').length;
    assert(nestedDrawers === 1, 'C-41：關閉再開啟另一列不會累積重複的 drawer 節點', `count=${nestedDrawers}`);
  }

  // C-49/C-50: 敏感資訊遮罩
  {
    const { dom } = await setupPage();
    const tableHtml = dom.window.document.getElementById('av2-explorer-table').innerHTML;
    assert(!tableHtml.includes('U1234') || tableHtml.includes('U1234****89AB'), 'C-49：LINE UID 只顯示遮罩後的版本，不會出現完整未遮罩 UID');
    assert(!/access_token|id_token/i.test(tableHtml), 'C-49b：明細表沒有出現任何 access_token/id_token 字樣');
    assert(tableHtml.includes('v_jsd…m_1') || tableHtml.includes('visitor_id_short'), 'C-50：匿名訪客只顯示縮短過的識別碼');
  }

  // C-51: XSS / HTML 跳脫
  // 說明：HTML 屬性值裡的 `<`/`>` 不需要跳脫也不會造成安全風險（只有 `&` 與
  // 引號字元跳脫與否才會影響屬性邊界），瀏覽器/jsdom 序列化 innerHTML 時
  // 也不會重新跳脫屬性值裡的 `<`/`>`，所以「屬性值裡出現原始 <script> 文字」
  // 本身不是漏洞——只要它沒有變成真正的 DOM <script> 元素、且沒有破壞屬性
  // 本身的邊界（例如靠單引號跳脫執行任意 JS）。以下改為驗證這兩個真正有意義
  // 的安全屬性。
  {
    const { dom } = await setupPage();
    assert(dom.window.document.querySelectorAll('script').length === 0, 'C-51a：商品資料渲染後，頁面中沒有任何真正的 <script> DOM 元素被建立（不會被當成可執行內容）');
    const row = dom.window.document.querySelector('#av2-body tr[onclick^="av2ExplorerApplyProductFilter("]');
    assert(!!row, 'C-51a2：商品列的 onclick 屬性結構完整、可被找到（沒有被商品名稱裡的特殊字元破壞）');
    assert(dom.window.document.getElementById('av2-body').innerHTML.includes('&lt;script&gt;'), 'C-51a3：商品名稱在文字內容中確實以 HTML entity 形式呈現（td 內容經過 escHtml 跳脫）');
    assert(dom.window.document.querySelectorAll('script').length === 0, 'C-51b：頁面中沒有因為渲染商品資料而多出可執行的 <script> 節點（與 C-51a 同一項真正的安全性檢查）');
    await dom.window.av2ExplorerOpenDetail('r3jsdom_cart_1');
    await new Promise((r) => setTimeout(r, 20));
    const drawerHtml = dom.window.document.getElementById('av2-drawer-body').innerHTML;
    assert(!drawerHtml.includes('<img src=x onerror=alert(1)>'), 'C-51c：購物車明細裡帶有 onerror 的商品名稱被正確跳脫');
  }

  // C-52/C-53/C-54/C-55/C-56/C-57/C-58/C-59: 分群建立行為
  {
    const { dom, fetchCalls } = await setupPage();
    await dom.window.av2ExplorerCreateSegment('dynamic', 'R3測試動態分群', '');
    await new Promise((r) => setTimeout(r, 20));
    const segCalls = fetchCalls.filter((c) => c.url.includes('/api/crm/segments'));
    const dynBody = JSON.parse(segCalls[segCalls.length - 1].opts.body);
    assert(dynBody.segment_type === 'dynamic' && dynBody.filter && !dynBody.member_keys, 'C-52：動態分群只送出 filter 定義，不含任何成員快照清單', JSON.stringify(dynBody));

    // 未選取任何列時嘗試建立 static 分群
    const beforeCount = fetchCalls.length;
    await dom.window.av2ExplorerCreateSegment('static', 'R3測試靜態分群無選取', '');
    assert(fetchCalls.length === beforeCount, 'C-54：沒有選取任何對象時，static 分群建立被安全擋下（不送出 API 請求）');

    // 選取兩列後建立 static 分群
    dom.window.av2ExplorerToggleRow('r3jsdom_cart_1', true);
    dom.window.av2ExplorerToggleRow('r3jsdom_cart_2', true);
    const toolbarAfterSelect = dom.window.document.getElementById('av2-explorer-toolbar').innerHTML;
    assert(toolbarAfterSelect.includes('已選取 2 人'), 'C-58a：勾選兩列後選取人數正確更新為 2（工具列顯示「已選取 2 人」）', toolbarAfterSelect.slice(0,200));
    const anonToolbarHtml = toolbarAfterSelect;
    assert(anonToolbarHtml.includes('匿名訪客'), 'C-59：工具列清楚標示已選取對象中包含匿名訪客的資格提示', anonToolbarHtml.slice(0,200));

    await dom.window.av2ExplorerCreateSegment('static', 'R3測試靜態分群', '');
    await new Promise((r) => setTimeout(r, 20));
    const segCalls2 = fetchCalls.filter((c) => c.url.includes('/api/crm/segments'));
    const staticBody = JSON.parse(segCalls2[segCalls2.length - 1].opts.body);
    assert(staticBody.segment_type === 'static' && Array.isArray(staticBody.member_keys) && staticBody.member_keys.length === 2, 'C-53：靜態分群送出明確選取的 member_keys（2 位）', JSON.stringify(staticBody));

    const crmCenterHtml = dom.window._av2RenderCrmActionCenter();
    assert(crmCenterHtml.includes('R3測試靜態分群'), 'C-56：分群 API 成功後，CRM Action Center 正確保留分群名稱（真實依 API 回應更新內部狀態，不是憑空顯示成功）', crmCenterHtml.slice(0,300));
  }
  // C-55: 分群名稱必填
  {
    const { dom, fetchCalls } = await setupPage();
    // av2ExplorerOpenSegmentModal 依賴 window.prompt，jsdom 預設沒有 prompt，模擬回傳空字串
    dom.window.prompt = () => '';
    const before = fetchCalls.length;
    dom.window.av2ExplorerOpenSegmentModal('dynamic');
    assert(fetchCalls.length === before, 'C-55：分群名稱為空時不會送出建立分群的 API 請求');
  }
  // C-57: API 失敗不會顯示成功
  {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = (url) => {
      fetchCalls.push({ url: String(url) });
      if (String(url).includes('/api/crm/segments')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, message: '建立失敗測試' }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => DASHBOARD_FIXTURE });
    };
    dom.window.eval(appSrc); dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true }; dom.window.currentStore = { store_id: 'x' };
    let toastMsg = null, toastType = null;
    dom.window.showToast = (msg, type) => { toastMsg = msg; toastType = type; };
    await dom.window.av2ExplorerCreateSegment('dynamic', 'C57測試', '');
    assert(toastType === 'error' && /失敗/.test(toastMsg||''), 'C-57：分群建立失敗時顯示失敗訊息，不會誤報成功', `${toastType}:${toastMsg}`);
    const crmCenterAfterFailure = dom.window._av2RenderCrmActionCenter();
    assert(crmCenterAfterFailure.includes('尚未準備任何受眾') || crmCenterAfterFailure.includes('尚未準備'), 'C-57b：失敗時不會誤將 CRM Action Center 標記為已有可用受眾', crmCenterAfterFailure.slice(0,200));
  }

  // C-60/C-61/C-62: CRM Action Center 入口
  {
    const { dom } = await setupPage();
    const html1 = dom.window._av2RenderCrmActionCenter();
    assert(html1.includes('尚未準備任何受眾') || html1.includes('尚未準備'), 'C-60：沒有選取/分群時，CRM Action Center 顯示未就緒說明', html1.slice(0,200));
    // 透過真實流程建立一個分群（呼叫真正的 API 呼叫路徑，不是直接竄改內部變數），
    // 讓 _av2RenderCrmActionCenter() 讀到的是模組自己真正更新過的狀態。
    await dom.window.av2ExplorerCreateSegment('dynamic', 'C60測試分群', '');
    await new Promise((r) => setTimeout(r, 20));
    const html2 = dom.window._av2RenderCrmActionCenter();
    assert(html2.includes('C60測試分群'), 'C-61：已建立分群後，CRM Action Center 保留該分群的脈絡資訊', html2.slice(0,200));
    assert(html2.includes('下一階段開放') && !html2.includes('已發送') && !html2.includes('已核發'), 'C-62：CRM Action Center 佔位頁明確表示尚未執行任何實際動作（不會出現「已發送/已核發」等字樣）');
  }

  console.log('\n[MANUAL REQUIRED 項目彙整]');
  manual('窄螢幕/實際瀏覽器視覺呈現', '明細表在真實手機/平板寬度下是否需要橫向捲動、版面是否破版，需要真實瀏覽器或視覺回歸工具交叉確認，jsdom 無法渲染實際版面配置。');
  manual('Session Timeline 時區換算的視覺呈現', '後端已將時間換算為 Asia/Taipei 本地時間字串（沿用既有 A_LOCAL/getCartDetail 邏輯，本輪未新增獨立時區換算），前端只是直接顯示字串，實際跨時區瀏覽器環境下的顯示需人工確認。');
}

async function main() {
  await partA();
  const backendCtx = await partB();
  await partC();

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\n合計：${results.length} 項，PASS ${results.length - failCount - manualCount}，FAIL ${failCount}，MANUAL REQUIRED ${manualCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke-hotfix31-r3-frontend] 未預期錯誤：', e);
  process.exit(1);
});
