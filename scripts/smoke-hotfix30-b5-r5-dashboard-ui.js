#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-frontend-runtime.js — fix18-10-hotfix30-B5-R5 前端 runtime smoke test
//
// 涵蓋需求文件 UI R5-1~R5-4 的資料/DOM 結構層級驗證：在 jsdom 裡真的執行
// public/js/app.js（不是另外重寫一份簡化邏輯），模擬 GET /api/analytics/dashboard
// 與 GET /api/analytics/cart-abandonment(/:cartId) 的回應，實際呼叫
// loadReportsPage() → loadDashboardV2() → renderDashboardV2() →
// loadCartAbandonment() → openCartDetailModal()，藉此在真正執行階段（不只是
// node --check 語法檢查）抓出 ReferenceError／undefined is not a function／
// DOM null access／未捕捉的 Promise rejection。
//
// 誠實揭露（MANUAL REQUIRED，本測試無法涵蓋）：手機/平板/桌面實際視覺呈現是否
// 破版、圖表在真實瀏覽器的渲染效果，仍需要真實瀏覽器或視覺回歸工具交叉確認，
// 見 scripts/smoke-hotfix30-b5-r5-cart-order-hours.js 結尾的 UI R5-1~R5-4
// MANUAL REQUIRED 項目。
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const DASHBOARD_FIXTURE = {
  success: true,
  range: { preset: 'today', start_date: '2026-07-23', end_date: '2026-07-23', timezone: 'Asia/Taipei' },
  kpi: { revenue: 1000, orders: 3, avg_order_value: 333, paid_orders: 3, unpaid_orders: 0, is_today: true, payment_stats: [], top_products: [], week_revenue: 0, week_orders: 0, month_revenue: 0, month_orders: 0 },
  funnel: [{ key: 'add_to_cart', label: '加入購物車', count: 5, event_count: 6, step_conversion_rate: null, overall_conversion_rate: 100 }],
  funnel_summary: null,
  realtime: { window: '近 5 分鐘', online: 1, browsing_product: 0, in_cart: 0, paying: 0 },
  cart: {
    add_to_cart_visitors: 5, completed_carts: 2, incomplete_carts: 3, abandonment_rate: 60,
    estimated_abandoned_amount: 450, avg_dwell_seconds: 125, abandon_time_buckets: { '30分鐘內': 1, '30分鐘~1小時': 0, '1~24小時': 1, '1~3天': 1, '3~7天': 0, '7天以上': 0 },
    current_open_summary: { open_carts: 3, open_amount: 450, over_24h: 1, line_identified: 1 },
  },
  products: [], payments: { rows: [] }, sources: [], repeat_customers: {}, incomplete: {},
  health_score: {}, recommendations: [],
  kpi_comparison: {}, health_score_v2: {}, trend_30d: {}, product_tiers: {}, forecast: {}, today_summary: {}, todo_list: {}, ai_daily_tip: null,
  ads_attribution: { sources: [], campaigns: [], revenue: {}, by_mode: {} },
  line_member_funnel: { stages: [] }, line_crm_kpi: {}, line_crm_health: {},
  analytics_v2: { insufficient_data: true, product_funnel: [], cart_abandonment: { rows: [], top_abandon_products: [] }, product_rankings: {}, source_performance: [], campaigns: {}, ads_dashboard: [], crm: {}, ai_insights: [] },
  tracking_meta: {},
  funnel_summary: null, identity_basis: null, identity_is_estimated: null,
  channel_filter: { current: 'all', available: ['all', 'pos', 'line_takeout', 'line_delivery', 'shipping', 'reservation'], labels: { all: '全部', pos: '內用／店內', line_takeout: '外帶', line_delivery: '外送', shipping: '宅配', reservation: '預訂' } },
  fulfillment_conflicts: { insufficient_data: true }, fulfillment_recommendations: [],
  order_hour_analysis: {
    basis: 'order_created_at', basis_label: '訂單成立時間', timezone: 'Asia/Taipei',
    total_orders: 3, total_revenue: 1000,
    peak_hour: { hour: 18, label: '18:00–18:59', orders: 2, revenue: 700 },
    peak_period: { label: '17:00–19:59', orders: 3, revenue: 1000 },
    rows: Array.from({ length: 24 }, (_, h) => (h === 18
      ? { hour: h, label: '18:00–18:59', orders: 2, revenue: 700, avg_order_value: 350, order_share: 66.7, revenue_share: 70 }
      : { hour: h, label: `${String(h).padStart(2,'0')}:00–${String(h).padStart(2,'0')}:59`, orders: h === 12 ? 1 : 0, revenue: h === 12 ? 300 : 0, avg_order_value: h === 12 ? 300 : 0, order_share: h === 12 ? 33.3 : 0, revenue_share: h === 12 ? 30 : 0 })),
  },
  order_period_analysis: [
    { key: 'lunch', label: '午餐 11:00–13:59', orders: 1, revenue: 300, avg_order_value: 300, order_share: 33.3, is_peak: false },
    { key: 'dinner', label: '晚餐 17:00–19:59', orders: 2, revenue: 700, avg_order_value: 350, order_share: 66.7, is_peak: true },
  ],
};

const CART_LIST_FIXTURE = {
  success: true, page: 1, limit: 20, total: 2, total_pages: 1,
  current_open_summary: { open_carts: 2, open_amount: 450, over_24h: 1, line_identified: 1 },
  rows: [
    {
      cart_id: 'c_test_1', cart_id_short: 'c_test…st_1', visitor_id_short: 'v_test…st_1',
      line_uid_masked: null, display_name: null, identity_type: 'visitor',
      order_mode: 'takeout', source: 'Direct', campaign: '(No Campaign)',
      first_added_at: '2026-07-22 18:03:00', last_activity_at: '2026-07-23 09:00:00',
      age_seconds: 54000, age_label: '15 小時', last_stage: '加入購物車', status: 'abandoned',
      items: [{ product_id: 1, name: '冷拌麻油腰子', qty: 1, unit_price: 150, subtotal: 150, variant: null }],
      subtotal: 150, discount: 0, delivery_fee: 0, total: 150, estimated: false,
      checkout_attempt_count: 0, last_attempt_id_masked: null, last_checkout_stage: null, line_checkout_events_available: false,
    },
    {
      cart_id: 'c_test_2', cart_id_short: 'c_test…st_2', visitor_id_short: null,
      line_uid_masked: 'U1234****89AB', display_name: '小明', identity_type: 'line',
      order_mode: 'delivery', source: 'Facebook', campaign: 'summer_promo',
      first_added_at: '2026-07-21 10:00:00', last_activity_at: '2026-07-22 08:00:00',
      age_seconds: 90000, age_label: '1 天 1 小時', last_stage: '開始結帳', status: 'abandoned',
      items: [{ product_id: 2, name: '黑胡椒毛豆', qty: 2, unit_price: 100, subtotal: 200, variant: null }],
      subtotal: 200, discount: 0, delivery_fee: 100, total: 300, estimated: true,
      checkout_attempt_count: 0, last_attempt_id_masked: null, last_checkout_stage: null, line_checkout_events_available: false,
    },
  ],
  filters: { status: 'all', age_bucket: 'all', identity: 'all', order_mode: 'all' },
};

const CART_DETAIL_FIXTURE = {
  success: true,
  cart: {
    cart_id: 'c_test_1', cart_id_short: 'c_test…st_1', visitor_id_short: 'v_test…st_1',
    line_uid_masked: null, display_name: null, identity_type: 'visitor', other_device_cart_count: 0,
    session_count: 1, first_added_at: '2026-07-22 18:03:00', last_activity_at: '2026-07-22 18:12:00',
    source: 'Direct', campaign: '(No Campaign)', order_mode: 'takeout',
    items: [{ product_id: 1, name: '冷拌麻油腰子', qty: 1, unit_price: 150, subtotal: 150, variant: null }],
    subtotal: 150, discount: 0, delivery_fee: 0, total: 150, estimated: false, status: 'open',
    timeline: [
      { time: '18:03', created_at: '2026-07-22 18:03:00', event_name_zh: '瀏覽商品', event_name_raw: 'view_product', detail: '' },
      { time: '18:05', created_at: '2026-07-22 18:05:00', event_name_zh: '加入購物車', event_name_raw: 'add_to_cart', detail: '冷拌麻油腰子 ×1' },
      { time: '18:12', created_at: '2026-07-22 18:12:00', event_name_zh: '購物車內容更新', event_name_raw: 'cart_updated', detail: '冷拌麻油腰子×1' },
    ],
    checkout_attempt_count: 0, last_attempt_id_masked: null, last_checkout_stage: null, line_checkout_events_available: false,
  },
};

async function main() {
  const unhandledRejections = [];
  const rejectionHandler = (reason) => { unhandledRejections.push(reason && (reason.stack || reason.message || String(reason))); };
  process.on('unhandledRejection', rejectionHandler);

  const dom = new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="reports-container"></div></body></html>', {
    runScripts: 'outside-only', url: 'http://localhost/',
  });
  const { window } = dom;
  const fetchCalls = [];
  window.fetch = (url, opts) => {
    fetchCalls.push(url);
    if (String(url).includes('/api/analytics/cart-abandonment/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => CART_DETAIL_FIXTURE });
    }
    if (String(url).includes('/api/analytics/cart-abandonment')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => CART_LIST_FIXTURE });
    }
    if (String(url).includes('/api/analytics/dashboard')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => DASHBOARD_FIXTURE });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
  };
  const store = new Map();
  const sstore = new Map();
  const caughtErrors = [];
  window.addEventListener('error', (e) => { caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message); });

  try {
    dom.window.eval(src);
  } catch (e) {
    fail('app.js top-level eval', e.message);
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
  pass('app.js top-level eval (no ReferenceError while defining functions)');

  // 必須在 eval 之後才設定：app.js 自己在頂層會執行
  // `window.currentFeatures = {};` / `window.currentStore = null;`，在 eval 之前設定會被蓋掉。
  window.currentFeatures = { reports: true };
  window.currentStore = { store_id: 'smoke_store' };

  // ── 呼叫 loadReportsPage() → loadDashboardV2()（非同步）───────────
  try {
    dom.window.loadReportsPage();
  } catch (e) {
    fail('loadReportsPage() 執行', e.stack);
  }
  // loadDashboardV2 / loadCartAbandonment 都是 async fire-and-forget，等待幾輪 microtask/timer
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 50));

  if (caughtErrors.length) {
    caughtErrors.forEach((e) => fail('window onerror 事件捕捉到例外', e));
  } else {
    pass('渲染完整 Dashboard（含未完成購物車明細／訂單時段分析）過程中沒有觸發 window error 事件');
  }

  const body = dom.window.document.getElementById('db-body-v2');
  const bodyHtml = body ? body.innerHTML : '';
  function checkContains(name, needle) {
    if (bodyHtml.includes(needle)) pass(name); else fail(name, `HTML 中找不到「${needle}」`);
  }
  checkContains('渲染出「📋 未完成購物車明細」區塊', '未完成購物車明細');
  checkContains('渲染出「⏰ 訂單成立時段分析」區塊', '訂單成立時段分析');
  checkContains('渲染出「完成購買購物車」文案（不是舊的「已完成購買」）', '完成購買購物車');
  checkContains('渲染出「預估未完成商品金額」文案', '預估未完成商品金額');
  checkContains('渲染出未完成購物車 KPI「目前未完成購物車」', '目前未完成購物車');
  checkContains('渲染出「目前未完成商品金額」KPI', '目前未完成商品金額');
  checkContains('未完成購物車列表渲染出測試商品「冷拌麻油腰子」', '冷拌麻油腰子');
  checkContains('未完成購物車列表對舊資料估計列顯示「舊資料估計」標記', '舊資料估計');
  checkContains('餐飲時段摘要渲染出「晚餐」且標記尖峰', '🔥');

  const openCartsBody = dom.window.document.getElementById('db-open-carts-body');
  if (openCartsBody && !openCartsBody.innerHTML.includes('載入中')) pass('未完成購物車清單非同步載入完成（不再停留在「載入中」）');
  else fail('未完成購物車清單非同步載入完成', 'body 仍顯示「載入中」或元素不存在');

  // ── 點擊「查看詳情」開啟 Modal ──────────────────────────────
  try {
    dom.window.openCartDetailModal('c_test_1');
    await new Promise((r) => setTimeout(r, 50));
    const modal = dom.window.document.getElementById('db-cart-detail-modal');
    if (!modal) fail('openCartDetailModal() 產生 Modal', '找不到 #db-cart-detail-modal');
    else {
      pass('openCartDetailModal() 產生 Modal');
      const detailBody = dom.window.document.getElementById('db-cart-detail-body');
      const html = detailBody ? detailBody.innerHTML : '';
      if (html.includes('冷拌麻油腰子') && html.includes('事件時間軸')) pass('Modal 內容含商品清單與事件時間軸');
      else fail('Modal 內容含商品清單與事件時間軸', 'HTML 缺少預期內容');
      if (html.includes('瀏覽商品') || html.includes('加入購物車')) pass('Modal Timeline 事件名稱已轉為中文');
      else fail('Modal Timeline 事件名稱已轉為中文', '找不到中文事件名稱');
    }
    dom.window.closeCartDetailModal();
    if (!dom.window.document.getElementById('db-cart-detail-modal')) pass('closeCartDetailModal() 正確移除 Modal');
    else fail('closeCartDetailModal() 正確移除 Modal', 'Modal 仍存在於 DOM');
  } catch (e) {
    fail('openCartDetailModal() 執行流程', e.stack);
  }

  // ── 切換訂單數／營業額圖表 metric ──────────────────────────
  try {
    dom.window.setOrderHourMetric('revenue');
    const section = dom.window.document.getElementById('db-order-hours-section');
    if (section) pass('setOrderHourMetric() 切換後區塊仍存在（outerHTML 重繪未破壞結構）');
    else fail('setOrderHourMetric() 切換後區塊仍存在', '#db-order-hours-section 消失');
  } catch (e) {
    fail('setOrderHourMetric() 執行', e.stack);
  }

  // ── 篩選按鈕觸發重新載入 ──────────────────────────────────
  try {
    dom.window.setOpenCartStatus('active');
    await new Promise((r) => setTimeout(r, 30));
    pass('setOpenCartStatus() 執行未拋出例外');
  } catch (e) {
    fail('setOpenCartStatus() 執行', e.stack);
  }

  // ── 渠道切換 ────────────────────────────────────────────
  try {
    dom.window.setDashboardChannel('line_delivery');
    await new Promise((r) => setTimeout(r, 50));
    pass('setDashboardChannel() 執行未拋出例外（會觸發重新載入 Dashboard + 未完成購物車清單）');
  } catch (e) {
    fail('setDashboardChannel() 執行', e.stack);
  }

  // 給任何殘留的非同步 rejection 一點時間浮現
  await new Promise((r) => setTimeout(r, 50));
  process.removeListener('unhandledRejection', rejectionHandler);
  if (unhandledRejections.length) {
    unhandledRejections.forEach((r) => fail('無未捕捉的 Promise rejection', r));
  } else {
    pass('無未捕捉的 Promise rejection（unhandledRejection）');
  }

  console.log('\n=== fetch calls captured (' + fetchCalls.length + ') ===');
  fetchCalls.slice(0, 10).forEach((u) => console.log(' -', u));

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`[${r.status}] ${r.name}`));
  console.log(`TOTAL: ${results.length}  PASS: ${results.length - failCount}  FAIL: ${failCount}`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.stack); process.exit(1); });
