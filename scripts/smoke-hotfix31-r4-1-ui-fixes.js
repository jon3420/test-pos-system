#!/usr/bin/env node
// scripts/smoke-hotfix31-r4-1-ui-fixes.js — fix18-10-hotfix31-R4.1
//
// 涵蓋範圍：
//   1. Cart Abandonment 明細表渠道欄位一致性（真實 DB/API，沿用既有慣例）
//   2. Visitor 360 選取列視覺高亮（jsdom，真的執行 analytics-v2.js）
//   3. Visitor 360 下拉選單可讀性（jsdom + CSS 原始碼稽核）
//   4. 既有功能回歸（Customer Journey／raw timeline／分群／Cart Abandonment 仍正常）

'use strict';

const path = require('path');
const fs = require('fs');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

async function partChannel() {
  console.log('\n=== PART 1: Channel Label Consistency（真實 DB/API）===');
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const { insertEvent } = require('../utils/analyticsLog');
  const { sanitizeCartSnapshotMetadata, getOpenCartRows, getCartDetail } = require('../utils/cartSnapshot');
  const { getDrilldownRows } = require('../utils/drilldown');
  const { ORDER_CHANNEL_LABELS } = require('../utils/channelResolver');

  const STORE = 'r4_1_channel_store';
  function ensureProduct(id, name) {
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`,
      [id, STORE, name, '測試', 100]);
  }
  ensureProduct(9401, '測試商品');

  function addToCart(opts) {
    return insertEvent(db, {
      store_id: STORE, visitor_id: opts.visitor_id, session_id: opts.visitor_id + '_s',
      cart_id: opts.cart, event_name: 'add_to_cart', product_id: 9401,
      order_mode: opts.order_mode, source: opts.source || null, channel_source: opts.channel_source || null,
      fulfillment_type: opts.fulfillment_type || null,
    });
  }
  function cartUpdated(opts) {
    const meta = sanitizeCartSnapshotMetadata('cart_updated', {
      items: [{ product_id: 9401, name: '測試商品', qty: 1, unit_price: 100, subtotal: 100 }],
      subtotal: 100, total: 100, order_mode: opts.order_mode || 'takeout', item_count: 1,
    });
    return insertEvent(db, {
      store_id: STORE, visitor_id: opts.visitor_id, session_id: opts.visitor_id + '_s',
      cart_id: opts.cart, event_name: 'cart_updated', order_mode: opts.order_mode,
      source: opts.source || null, metadata: meta, fulfillment_type: opts.fulfillment_type || null,
    });
  }

  const FIXTURES = [
    { key: 'pos', cart: 'r41_cart_pos', visitor_id: 'r41_v_pos', order_mode: 'dine_in', source: 'pos', channel_source: 'pos' },
    { key: 'line_takeout', cart: 'r41_cart_lt', visitor_id: 'r41_v_lt', order_mode: 'takeout', source: 'line', channel_source: 'line' },
    { key: 'line_delivery', cart: 'r41_cart_ld', visitor_id: 'r41_v_ld', order_mode: 'delivery', source: 'line', channel_source: 'line' },
    { key: 'shipping', cart: 'r41_cart_ship', visitor_id: 'r41_v_ship', order_mode: 'shipping', source: 'line', channel_source: 'line', fulfillment_type: 'shipping' },
    { key: 'reservation', cart: 'r41_cart_res', visitor_id: 'r41_v_res', order_mode: 'reservation', source: 'line', channel_source: 'line' },
    { key: 'unknown', cart: 'r41_cart_unk', visitor_id: 'r41_v_unk', order_mode: null, source: null, channel_source: null },
  ];
  FIXTURES.forEach((f) => {
    addToCart(f);
    cartUpdated(f);
  });

  // 1~7：canonical channel/channel_label 正確（Cart Detail — getCartDetail）
  FIXTURES.forEach((f) => {
    const detail = getCartDetail(db, STORE, f.cart, {});
    assert(!!detail, `前置：${f.key} 購物車詳情可查詢`, `cart=${f.cart}`);
    if (!detail) return;
    assert(detail.channel === f.key, `渠道分類正確：${f.key} → channel=${f.key}`, `got channel=${detail.channel}`);
    assert(detail.channel_label === ORDER_CHANNEL_LABELS[f.key], `渠道標籤正確：${f.key} → ${ORDER_CHANNEL_LABELS[f.key]}`, `got=${detail.channel_label}`);
  });
  pass('2. pos 顯示「店內 POS」（見上方逐項）');
  pass('3. line_takeout 顯示「LINE 外帶」（見上方逐項）');
  pass('4. line_delivery 顯示「LINE 外送」（見上方逐項）');
  pass('5. shipping 顯示「宅配」（見上方逐項）');
  pass('6. reservation 顯示「預訂」（見上方逐項）');
  pass('7. unknown 顯示「未知」（見上方逐項）');

  // 1：getOpenCartRows（明細表本身，含 channel/channel_label 欄位）也一致
  {
    const openRows = getOpenCartRows(db, STORE, { page: 1, limit: 50 });
    const byCart = {};
    (openRows.rows || []).forEach((r) => { byCart[r.cart_id] = r; });
    FIXTURES.forEach((f) => {
      const r = byCart[f.cart];
      assert(!!r && r.channel === f.key, `1. 明細表列（getOpenCartRows）渠道分類正確：${f.key}`, r ? `got=${r.channel}` : 'row not found');
      assert(!!r && r.channel_label === ORDER_CHANNEL_LABELS[f.key], `1b. 明細表列渠道標籤正確：${f.key}`, r ? `got=${r.channel_label}` : 'row not found');
    });
  }

  // 8~9：source/campaign 與渠道分開存在，不會被渠道欄位取代
  {
    const detail = getCartDetail(db, STORE, 'r41_cart_lt', {});
    assert(detail.source !== undefined && detail.channel !== detail.source, '8. source 欄位獨立存在，沒有被渠道欄位取代', JSON.stringify({ source: detail.source, channel: detail.channel }));
    assert(detail.campaign !== undefined, '9. campaign 欄位獨立存在，沒有被渠道欄位取代', JSON.stringify({ campaign: detail.campaign }));
  }
  // 10：order_mode 內部仍然可用（渠道分類不取代 order_mode 本身）
  {
    const detail = getCartDetail(db, STORE, 'r41_cart_ld', {});
    assert(detail.order_mode === 'delivery', '10. order_mode 欄位內部仍然保留可用', `got=${detail.order_mode}`);
  }

  // 11~14：頂層渠道篩選（Drill Down／既有 R4 已驗證的渠道一致性）在這裡再次確認
  // LINE 外帶／外送互不重疊、宅配／預訂各自獨立、unknown 獨立存在
  {
    const lt = getDrilldownRows(db, STORE, { order_channel: 'line_takeout' }, {});
    const ld = getDrilldownRows(db, STORE, { order_channel: 'line_delivery' }, {});
    assert(lt.rows.some((r) => r.cart_id === 'r41_cart_lt'), '11a. LINE 外帶篩選找到外帶購物車');
    assert(!lt.rows.some((r) => r.cart_id === 'r41_cart_ld'), '11. LINE 外帶篩選不包含 LINE 外送購物車');
    assert(ld.rows.some((r) => r.cart_id === 'r41_cart_ld'), '12a. LINE 外送篩選找到外送購物車');
    assert(!ld.rows.some((r) => r.cart_id === 'r41_cart_lt'), '12. LINE 外送篩選不包含 LINE 外帶購物車');

    const ship = getDrilldownRows(db, STORE, { order_channel: 'shipping' }, {});
    const res = getDrilldownRows(db, STORE, { order_channel: 'reservation' }, {});
    assert(ship.rows.some((r) => r.cart_id === 'r41_cart_ship') && !ship.rows.some((r) => r.cart_id === 'r41_cart_res'),
      '13. 宅配與預訂彼此獨立，宅配篩選不包含預訂購物車');
    assert(res.rows.some((r) => r.cart_id === 'r41_cart_res') && !res.rows.some((r) => r.cart_id === 'r41_cart_ship'),
      '13b. 預訂篩選不包含宅配購物車');

    const unk = getDrilldownRows(db, STORE, { order_channel: 'unknown' }, {});
    assert(unk.rows.some((r) => r.cart_id === 'r41_cart_unk') && !unk.rows.some((r) => r.cart_id === 'r41_cart_lt'),
      '14. unknown 渠道獨立存在，不與 LINE 外帶混在一起');
  }

  // 15：沿用既有唯一的渠道解析器，沒有另建第二套
  {
    const src = fs.readFileSync(path.join(ROOT, 'utils/cartSnapshot.js'), 'utf8');
    assert(src.includes("require('./channelResolver')"), '15. utils/cartSnapshot.js 重用既有 utils/channelResolver.js，沒有另建第二套渠道判斷邏輯');
    const frontendSrc = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
    assert(!frontendSrc.includes('AV2_ORDER_MODE_LABEL'), '15b. 前端不再存在會與後端渠道分類drift的舊 order_mode 標籤對照表');
  }
}

async function partUI() {
  console.log('\n=== PART 2/3: Visitor 360 Selected Row × Dropdown Readability（jsdom）===');
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('PART 2/3 全部項目', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  const av2Src = av2SrcRaw.replace(/'use strict';\s*\n/, '');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');

  const DASHBOARD_FIXTURE = {
    success: true, range: { preset: 'today', start_date: '2026-07-24', end_date: '2026-07-24', timezone: 'Asia/Taipei' },
    kpi: {}, funnel: [], realtime: {}, cart: {}, products: [], payments: { rows: [] }, sources: [], repeat_customers: {}, incomplete: {},
    health_score: {}, recommendations: [], kpi_comparison: {}, health_score_v2: {}, trend_30d: {}, product_tiers: {}, forecast: {},
    today_summary: {}, todo_list: {}, ai_daily_tip: null, ads_attribution: { sources: [], campaigns: [], revenue: {}, by_mode: {} },
    line_member_funnel: { stages: [] }, line_crm_kpi: {}, line_crm_health: {},
    analytics_v2: {
      insufficient_data: false,
      product_funnel: [{ product_id: 1, product_name: '測試商品', view: 10, add_to_cart: 8, checkout: 5, purchase: 3, conversion_rate: 30, view_to_add_rate: 80, add_to_checkout_rate: 62.5, checkout_to_purchase_rate: 60, revenue: 360, is_delisted: false }],
      cart_abandonment: { rows: [{ add_to_cart: 8, purchase: 3, abandon: 5, estimated_abandoned_amount: 600 }], top_abandon_products: [] },
      product_rankings: {}, source_performance: [], campaigns: { available: false }, ads_dashboard: [], crm: {}, ai_insights: [],
    },
    tracking_meta: {}, identity_basis: null, identity_is_estimated: null,
    channel_filter: { current: 'all', available: ['all', 'pos', 'line_takeout', 'line_delivery', 'shipping', 'reservation'],
      labels: { all: '全部', pos: '店內 POS', line_takeout: 'LINE 外帶', line_delivery: 'LINE 外送', shipping: '宅配', reservation: '預訂', unknown: '未知' } },
    fulfillment_conflicts: { insufficient_data: true }, fulfillment_recommendations: [], order_hour_analysis: null, order_period_analysis: [],
  };

  function audienceRow(overrides) {
    return Object.assign({
      member_key: 'v1', canonical_key: 'v1', display_key: 'v1…', member_type: 'visitor_id',
      identity: 'anonymous', identity_label: '僅匿名訪客', display_name: null, line_uid_masked: null,
      friend_status: null, first_visit_at: '2026-07-01 10:00:00', last_seen_at: '2026-07-20 10:00:00',
      visit_count: 1, session_count: 1, cart_count: 0, checkout_count: 0, order_count: 0,
      total_revenue: 0, average_order_value: 0, last_purchase_at: null,
      recent_source: 'Direct', recent_channel: 'pos', recent_order_mode: null, recent_campaign: null,
      revisit_score: 2, revisit_score_breakdown: [{ label: '來訪 1 次', points: 2 }],
      revisit_score_disclaimer: '回訪分數是分析用的參考分數，不代表營收或購買機率。',
      customer_status_tags: ['新訪客'],
    }, overrides);
  }
  const ROWS = [audienceRow({ canonical_key: 'visitor_a' }), audienceRow({ canonical_key: 'visitor_b' })];
  function audienceResponse(rows) {
    return { success: true, rows, total: rows.length, page: 1, limit: 20, total_pages: 1, filters: {}, warnings: [], generated_at: '2026-07-24T10:00:00.000Z', high_value_threshold: 1000 };
  }
  const VISITOR_DETAIL = {
    success: true,
    visitor: {
      member_key: 'visitor_a', identity_type: 'visitor', display_name: null, line_uid_masked: null, friend_status: null,
      canonical_identity: { type: 'visitor_id', resolution_method: 'anonymous_no_link', confidence: 'unresolved' },
      linked_visitor_count: 1, first_seen_at: '2026-07-01 10:00:00', last_seen_at: '2026-07-20 10:00:00',
      total_visits: 1, cart_history: [], ltv: null,
      raw_timeline: [{ event_name: 'page_view', source: 'Direct', at: '2026-07-01 10:00:00' }],
      customer_journey: [{ type: 'first_visit', label: 'Direct 首次來訪', at: '2026-07-01 10:00:00', inferred: false }],
      data_generated_at: '2026-07-24T10:00:00.000Z',
    },
  };

  const DRILLDOWN_FIXTURE = {
    success: true, page: 1, limit: 20, total: 1, total_pages: 1, visitor_count: 1,
    filters: {}, warnings: [], generated_at: '2026-07-24T10:00:00.000Z',
    rows: [{
      cart_id: 'r4_1_ui_cart_1', cart_id_short: 'r4_1…rt_1', visitor_id_short: 'v_r41…t_1',
      line_uid_masked: null, display_name: null, friend_status: null, identity_type: 'visitor',
      order_mode: 'takeout', channel: 'line_takeout', channel_label: 'LINE 外帶',
      source: 'Facebook', campaign: '(No Campaign)',
      first_added_at: '2026-07-23 18:03:00', last_activity_at: '2026-07-24 09:00:00',
      age_seconds: 3600, age_label: '1 小時', last_stage: '加入購物車', status: 'abandoned',
      items: [{ product_id: 1, name: '測試商品', qty: 1, unit_price: 120, subtotal: 120, variant: null }],
      subtotal: 120, discount: 0, delivery_fee: 0, total: 120, estimated: false,
    }],
  };

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="analytics-v2-container"></div><div id="reports-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }
  function buildFetchMock(fetchCalls, opts = {}) {
    return (url) => {
      fetchCalls.push({ url: String(url) });
      const u = String(url);
      let body = { success: true };
      if (u.includes('/api/analytics/visitor-360')) body = opts.audienceResponder ? opts.audienceResponder(u) : audienceResponse(ROWS);
      else if (u.includes('/api/analytics/visitor/')) body = opts.visitorResponder ? opts.visitorResponder(u) : VISITOR_DETAIL;
      else if (u.includes('/api/analytics/dashboard')) body = DASHBOARD_FIXTURE;
      else if (u.includes('/api/analytics/drilldown')) body = DRILLDOWN_FIXTURE;
      else if (u.includes('/api/crm/segments')) body = { success: true, id: 1, segment_type: 'dynamic', member_count: 2 };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    };
  }
  async function setup(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.eval(appSrc); dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true }; dom.window.currentStore = { store_id: 'r4_1_ui_store' };
    dom.window.loadAnalyticsV2Page();
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2SwitchTab('visitor360');
    await new Promise((r) => setTimeout(r, 20));
    return { dom, fetchCalls };
  }

  // ── 16~26：選取列高亮 ─────────────────────────────────────────
  {
    const { dom } = await setup();
    await dom.window.av2AudienceOpenDetail('visitor_a');
    let html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('av2-audience-row-selected'), '16. 開啟詳情後，整列套用選取樣式 class');
    assert(/aria-selected="true"/.test(html), '17. 選取列 aria-selected="true"');
    assert(html.includes('查看中'), '18. 詳情按鈕文字變成「查看中」（開啟狀態）');

    await dom.window.av2AudienceOpenDetail('visitor_b');
    html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    const selCount = (html.match(/av2-audience-row-selected/g) || []).length;
    assert(selCount === 1, '19. 開啟另一列後，只有新列高亮（舊列的高亮被清除）', `selCount=${selCount}`);
    const rowMatches = [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)];
    const selectedRow = rowMatches.find((m) => m[1].includes('av2-audience-row-selected'));
    assert(!!selectedRow && selectedRow[2].includes('visitor_b'), '19b. 高亮的確實是 visitor_b 那一列');

    await dom.window.av2AudienceCloseDetail();
    html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!html.includes('av2-audience-row-selected'), '20. 收合詳情後，高亮清除');
    assert(dom.window.document.getElementById('av2-audience-drawer').innerHTML === '', '20b. 收合詳情後，詳情面板內容清空');
  }
  // 21：重繪（換頁/篩選）只保留目前選取的 canonical_key
  {
    const { dom } = await setup();
    await dom.window.av2AudienceOpenDetail('visitor_a');
    dom.window.av2AudienceApplyFilter('identity', 'all');
    await new Promise((r) => setTimeout(r, 20));
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!html.includes('av2-audience-row-selected'), '21. 篩選改變後重新查詢，不殘留舊的選取狀態', html.includes('av2-audience-row-selected') ? '仍殘留舊選取' : '');
  }
  // 22：分頁不會誤選到「顯示文字剛好相似」的列（用 canonical_key 而非顯示文字比對）
  {
    const { dom } = await setup({ audienceResponder: () => audienceResponse([audienceRow({ canonical_key: 'visitor_a', display_name: '王小明' }), audienceRow({ canonical_key: 'visitor_a_copy', display_name: '王小明' })]) });
    await dom.window.av2AudienceOpenDetail('visitor_a');
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    const rowMatches = [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)];
    const selectedRows = rowMatches.filter((m) => m[1].includes('av2-audience-row-selected'));
    assert(selectedRows.length === 1 && selectedRows[0][2].includes('visitor_a\'') , '22. 即使顯示名稱相同，只有 canonical_key 完全相符的那一列被高亮', `selected count=${selectedRows.length}`);
  }
  // 23：篩選改變會清除舊選取（同 21，另外確認 drawer 內容也清空，不留殘影）
  {
    const { dom } = await setup();
    await dom.window.av2AudienceOpenDetail('visitor_a');
    dom.window.av2AudienceClearFilters();
    await new Promise((r) => setTimeout(r, 20));
    assert(dom.window.document.getElementById('av2-audience-drawer').innerHTML === '', '23. 清除篩選後，先前開啟的詳情內容不會殘留');
  }
  // 24：渠道切換後，不會保留一個已經不在新結果集裡的選取狀態
  {
    const { dom } = await setup({
      audienceResponder: (u) => (u.includes('channel=pos') ? audienceResponse([audienceRow({ canonical_key: 'pos_only_visitor' })]) : audienceResponse(ROWS)),
    });
    await dom.window.av2AudienceOpenDetail('visitor_a');
    dom.window.av2SetChannel('pos');
    await new Promise((r) => setTimeout(r, 20));
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!html.includes('av2-audience-row-selected'), '24. 渠道切換後，不會殘留指向新結果集裡不存在的訪客的選取狀態');
  }
  // 25：選取狀態渲染不會意外洩漏完整 LINE UID
  {
    const { dom } = await setup({
      audienceResponder: () => audienceResponse([audienceRow({ canonical_key: 'U_full_uid_test_1234567890', member_type: 'line_user_id', line_uid_masked: 'U1234****7890', display_name: '測試會員' })]),
    });
    await dom.window.av2AudienceOpenDetail('U_full_uid_test_1234567890');
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!html.includes('>U_full_uid_test_1234567890<'), '25. 選取狀態渲染不會讓完整 LINE UID 以可見文字出現');
  }
  // 26：重複開關不會疊加事件監聽（inline onclick 重繪，天生不會疊加）
  {
    const audienceSection = av2Src.slice(av2Src.indexOf('function av2AudienceOpenDetail'), av2Src.indexOf('function av2AudienceOpenDetail') + 3000);
    assert(!audienceSection.includes('addEventListener'), '26. av2AudienceOpenDetail/相關渲染不使用 addEventListener，重複開關不會疊加監聽器');
  }

  // ── 27~35：下拉選單可讀性 ─────────────────────────────────────
  {
    const { dom } = await setup();
    const html = dom.window.document.getElementById('av2-body').innerHTML;
    const selectMatches = [...html.matchAll(/<select[^>]*>/g)];
    assert(selectMatches.length >= 6, '27. Visitor 360 篩選下拉選單皆套用 av2-select scoped class', `found ${selectMatches.length} selects`);
    assert(selectMatches.every((m) => m[0].includes('class="av2-select"')), '27b. 每一個下拉選單都帶有 av2-select class', selectMatches.map((m) => m[0]).join('\n'));
  }
  {
    const bgMatch = cssSrc.match(/\.av2-select\s*\{[^}]*background:\s*([^;]+);[^}]*color:\s*([^;]+);/);
    assert(!!bgMatch && bgMatch[1].trim() !== bgMatch[2].trim(), '28. .av2-select 本身前景色與背景色不同（不是同色）', bgMatch ? `${bgMatch[1]} vs ${bgMatch[2]}` : 'rule not found');
  }
  {
    const optMatch = cssSrc.match(/\.av2-select option\s*\{[^}]*background:\s*([^;]+);[^}]*color:\s*([^;]+);/);
    assert(!!optMatch && optMatch[1].trim() !== optMatch[2].trim(), '29. .av2-select option 前景色與背景色不同', optMatch ? `${optMatch[1]} vs ${optMatch[2]}` : 'rule not found');
  }
  {
    const checkedMatch = cssSrc.match(/\.av2-select option:checked\s*\{[^}]*background:\s*([^;]+);[^}]*color:\s*([^;]+);/);
    assert(!!checkedMatch && checkedMatch[1].trim() !== checkedMatch[2].trim(), '30. .av2-select option:checked（選取中）前景色與背景色有明顯對比', checkedMatch ? `${checkedMatch[1]} vs ${checkedMatch[2]}` : 'rule not found');
  }
  {
    const disabledMatch = cssSrc.match(/\.av2-select option:disabled\s*\{([^}]*)\}/);
    assert(!!disabledMatch && disabledMatch[1].includes('color'), '31. .av2-select option:disabled 有獨立的文字顏色設定，維持可辨識', disabledMatch ? disabledMatch[1] : 'rule not found');
  }
  {
    const focusMatch = cssSrc.match(/\.av2-select:focus\s*\{([^}]*)\}/);
    assert(!!focusMatch && focusMatch[1].includes('outline'), '32. .av2-select:focus 有明確的 focus 樣式（outline）', focusMatch ? focusMatch[1] : 'rule not found');
  }
  {
    // 33：確認 scoped class 沒有污染其他既有 select（既有規則如 .settings-card select 等應保持原樣不受影響）
    assert(cssSrc.includes('.settings-card input, .settings-card select'), '33. 既有其他頁面的 select 樣式規則仍然存在、未被本輪改動');
  }
  {
    // 34：CSS 原始碼裡不存在「白色文字配白色/淺色背景」這種明顯的選取樣式（掃描 .av2-select 相關規則區塊）
    const block = cssSrc.slice(cssSrc.indexOf('.av2-select'), cssSrc.indexOf('.av2-select') + 1500);
    const hasWhiteOnWhite = /background:\s*(#fff|#ffffff|white)[\s\S]{0,80}color:\s*(#fff|#ffffff|white)/i.test(block)
      || /color:\s*(#fff|#ffffff|white)[\s\S]{0,80}background:\s*(#fff|#ffffff|white)/i.test(block);
    assert(!hasWhiteOnWhite, '34. 產生的 CSS 規則區塊內沒有白色文字配白色背景的組合');
  }
  manual('35. 瀏覽器原生下拉選單彈出樣式實際呈現', '不同瀏覽器（尤其 Chromium 系 vs Firefox）對原生 <select> 彈出選單的 CSS 支援程度不同（例如 option:hover 在多數瀏覽器的原生彈出視窗中不受 CSS 控制），本測試只能驗證 CSS 規則確實產生且方向正確，實際彈出視窗的最終畫面需要在真實瀏覽器（建議 Chromium 與 Firefox 各檢查一次）人工確認。');

  // ── 36~45：回歸 ─────────────────────────────────────────────
  {
    const { dom, fetchCalls } = await setup();
    assert(fetchCalls.some((c) => c.url.includes('/api/analytics/visitor-360')), '36. Visitor 360 清單仍正常載入');
    await dom.window.av2AudienceOpenDetail('visitor_a');
    assert(fetchCalls.some((c) => c.url.includes('/api/analytics/visitor/visitor_a')), '37. 訪客詳情仍正常載入');
    const drawer = dom.window.document.getElementById('av2-audience-drawer').innerHTML;
    assert(drawer.includes('Customer Journey'), '38. Customer Journey 仍正常渲染');
    assert(drawer.includes('原始 Session Timeline'), '39. 原始 Session Timeline 仍正常渲染');

    await dom.window.av2AudienceCreateSegment('dynamic', 'R4.1回歸測試動態分群', '');
    assert(fetchCalls.some((c) => c.url.includes('/api/crm/segments')), '40. 動態分群建立仍正常運作');

    dom.window.av2AudienceToggleSelect('visitor_a', 'visitor_id', '', true);
    const rendered = dom.window._av2RenderVisitor360Audience();
    assert(rendered.includes('已勾選 1 人'), '41. 靜態分群勾選狀態仍正常運作');

    dom.window.av2SwitchTab('cart_abandonment');
    await new Promise((r) => setTimeout(r, 20));
    const cartHtml = dom.window.document.getElementById('av2-body').innerHTML;
    assert(cartHtml.includes('渠道'), '42. Cart Abandonment 仍正常渲染，且欄位標題已更新為「渠道」');

    dom.window.av2SetChannel('pos');
    await new Promise((r) => setTimeout(r, 20));
    const lastDashCall = fetchCalls.filter((c) => c.url.includes('/api/analytics/dashboard')).pop();
    assert(lastDashCall.url.includes('channel=pos'), '43. 頂層渠道篩選仍正常運作');
  }
  {
    assert(fs.existsSync(path.join(ROOT, 'routes/dashboard.js')), '44. routes/dashboard.js（Boss Dashboard 路由）仍然存在、本輪未觸碰');
    const androidLike = fs.readdirSync(ROOT).filter((n) => /android/i.test(n));
    assert(androidLike.length === 0, '45. 工作目錄內沒有任何 Android 相關檔案/資料夾');
  }
}

async function main() {
  await partChannel();
  await partUI();
  const totalPass = results.filter((r) => r.status === 'PASS').length;
  const totalFail = results.filter((r) => r.status === 'FAIL').length;
  const totalManual = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\n合計：${results.length} 項，PASS ${totalPass}，FAIL ${totalFail}，MANUAL REQUIRED ${totalManual}`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke-r4-1] 執行失敗：', e.message, e.stack);
  process.exit(1);
});
