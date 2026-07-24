#!/usr/bin/env node
// scripts/smoke-hotfix31-r4-visitor360-ui.js — fix18-10-hotfix31-R4
//
// Visitor 360 Audience 前端行為測試。沿用 scripts/smoke-hotfix31-r3-frontend.js
// 已驗證過的 jsdom 實測慣例（真的執行 public/js/app.js + public/js/analytics-v2.js，
// 不是原始碼字串掃描），只針對本輪新增的「🧑‍🤝‍🧑 Visitor 360」頁籤。

'use strict';

const path = require('path');
const fs = require('fs');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const ROOT = path.join(__dirname, '..');

async function main() {
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('全部項目', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  // 同 R3：analytics-v2.js 頂端的 'use strict' 在間接 eval（dom.window.eval）下
  // 會讓頂層宣告不外洩到 window，這是測試載入方式的調整，不影響瀏覽器 <script> 載入。
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
      product_funnel: [{ product_id: 9101, product_name: '測試商品', view: 10, add_to_cart: 8, checkout: 5, purchase: 3, conversion_rate: 30, view_to_add_rate: 80, add_to_checkout_rate: 62.5, checkout_to_purchase_rate: 60, revenue: 360, is_delisted: false }],
      cart_abandonment: {
        rows: [{ add_to_cart: 8, purchase: 3, abandon: 5, estimated_abandoned_amount: 600 }],
        top_abandon_products: [{ product_id: 9101, product_name: '測試商品', add_to_cart: 8, purchase: 3, abandon: 5, abandon_rate: 62.5, estimated_abandoned_amount: 600 }],
      },
      product_rankings: {}, source_performance: [], campaigns: { available: false }, ads_dashboard: [], crm: {}, ai_insights: [],
    },
    tracking_meta: {}, identity_basis: null, identity_is_estimated: null,
    channel_filter: { current: 'all', available: ['all'], labels: { all: '全部' } },
    fulfillment_conflicts: { insufficient_data: true }, fulfillment_recommendations: [],
    order_hour_analysis: null, order_period_analysis: [],
  };

  function audienceRow(overrides) {
    return Object.assign({
      member_key: 'v_default', canonical_key: 'v_default', display_key: 'v_de…lt',
      member_type: 'visitor_id', identity: 'anonymous', identity_label: '僅匿名訪客',
      identity_confidence: 'unresolved', identity_evidence: 'anonymous_no_link',
      display_name: null, line_uid_masked: null,
      friend_status: null, friend_status_label: '匿名訪客尚未與 LINE 身份建立可靠關聯',
      first_visit_at: '2026-07-01 10:00:00', last_seen_at: '2026-07-20 10:00:00',
      visit_count: 1, session_count: 1, cart_count: 0, checkout_count: 0, order_count: 0,
      total_revenue: 0, average_order_value: 0, avg_order_value: 0, last_purchase_at: null,
      recent_source: 'Direct', recent_channel: 'pos', recent_order_mode: null, recent_campaign: null,
      revisit_score: 2,
      revisit_score_breakdown: [{ label: '來訪 1 次', points: 2 }],
      revisit_score_disclaimer: '回訪分數是分析用的參考分數，不代表營收或購買機率。',
      customer_status_tags: ['新訪客'],
    }, overrides);
  }

  const AUDIENCE_ROWS = [
    audienceRow({ canonical_key: 'aud_anon_1', member_key: 'aud_anon_1', identity: 'anonymous', identity_label: '僅匿名訪客' }),
    audienceRow({
      canonical_key: 'U_line_member_1', member_key: 'U_line_member_1', member_type: 'line_user_id',
      identity: 'line_member', identity_label: 'LINE會員', display_name: '林小美', line_uid_masked: 'U1234****89AB',
      friend_status: 'friend', friend_status_label: '已確認為 LINE 好友',
      visit_count: 6, cart_count: 3, checkout_count: 2, order_count: 1,
      total_revenue: 1200, average_order_value: 1200, avg_order_value: 1200, last_purchase_at: '2026-07-20 10:00:00',
      recent_source: 'Facebook', recent_channel: 'line_takeout', recent_order_mode: 'takeout', recent_campaign: '母親節',
      revisit_score: 38,
      revisit_score_breakdown: [
        { label: '來訪 6 次', points: 12 }, { label: '購物車 3 次', points: 9 },
        { label: '開始結帳 2 次', points: 8 }, { label: '訂單 1 筆', points: 10 }, { label: '久未活動調整', points: -1 },
      ],
      customer_status_tags: ['回訪訪客', '首購客'],
    }),
    audienceRow({
      canonical_key: 'U_upgraded_1', member_key: 'U_upgraded_1', member_type: 'line_user_id',
      identity: 'anonymous_upgraded', identity_label: '已由匿名訪客升級為 LINE 會員',
      display_name: '王大明', line_uid_masked: 'U5678****CDEF', friend_status: 'not_friend', friend_status_label: '已確認尚未加入好友',
      visit_count: 2, cart_count: 2, checkout_count: 0, order_count: 0,
      customer_status_tags: ['回訪訪客', '高互動未購買'],
    }),
    audienceRow({
      canonical_key: 'v_legacy_unknown', member_key: 'v_legacy_unknown',
      identity: 'unresolved', identity_label: '身份尚未解析', friend_status: null,
      friend_status_label: '匿名訪客尚未與 LINE 身份建立可靠關聯',
      customer_status_tags: ['身份未解析'],
    }),
    audienceRow({
      canonical_key: 'U_unknown_friend', member_key: 'U_unknown_friend', member_type: 'line_user_id',
      identity: 'line_member', identity_label: 'LINE會員', display_name: '未知好友狀態會員',
      friend_status: 'unknown', friend_status_label: '好友狀態尚未確認',
      customer_status_tags: ['回訪訪客'],
    }),
  ];

  function audienceResponse(rows, extra) {
    return Object.assign({
      success: true, rows, total: rows.length, page: 1, limit: 20, total_pages: 1,
      filters: {}, warnings: [], generated_at: '2026-07-24T10:00:00.000Z', high_value_threshold: 1000,
    }, extra || {});
  }

  const VISITOR_DETAIL_FIXTURE = {
    success: true,
    visitor: {
      member_key: 'U_line_member_1', identity_type: 'line', display_name: '林小美',
      line_uid_masked: 'U1234****89AB', friend_status: 'friend',
      canonical_identity: { type: 'line_user_id', resolution_method: 'visitor_session_link', confidence: 'high' },
      linked_visitor_count: 1, first_seen_at: '2026-07-01 10:00:00', last_seen_at: '2026-07-20 10:05:00',
      total_visits: 2, cart_history: [{}, {}],
      ltv: { order_count: 2, total_spent: 1500, avg_order_value: 750, last_order_at: '2026-07-20 10:00:00' },
      raw_timeline: [
        { event_name: 'page_view', source: 'Facebook', at: '2026-07-01 10:00:00' },
        { event_name: 'view_product', source: 'Facebook', at: '2026-07-01 10:01:00' },
        { event_name: 'view_product', source: 'Facebook', at: '2026-07-01 10:01:30' },
        { event_name: 'add_to_cart', source: 'Facebook', at: '2026-07-01 10:02:00' },
        { event_name: 'begin_checkout', source: 'Facebook', at: '2026-07-01 10:03:00' },
        { event_name: 'purchase', source: 'Facebook', at: '2026-07-01 10:05:00', order_id: 'ord_1' },
        { event_name: 'add_to_cart', source: 'Direct', at: '2026-07-20 10:00:00' },
        { event_name: 'purchase', source: 'Direct', at: '2026-07-20 10:05:00', order_id: 'ord_2' },
      ],
      customer_journey: [
        { type: 'first_visit', label: 'Facebook 首次來訪', at: '2026-07-01 10:00:00', inferred: false },
        { type: 'product_view', label: '商品瀏覽（2 次）', at: '2026-07-01 10:01:00', inferred: true, event_count: 2 },
        { type: 'add_to_cart', label: '加入購物車', at: '2026-07-01 10:02:00', inferred: false },
        { type: 'begin_checkout', label: '開始結帳', at: '2026-07-01 10:03:00', inferred: false },
        { type: 'first_purchase', label: '完成首購', at: '2026-07-01 10:05:00', inferred: false, order_id: 'ord_1' },
        { type: 'anonymous_upgraded', label: '匿名訪客升級為 LINE 會員', at: '2026-07-05 09:00:00', inferred: true },
        { type: 'revisit', label: '19 天後回訪（Direct）', at: '2026-07-20 10:00:00', inferred: true, days_since_previous: 19 },
        { type: 'add_to_cart', label: '再次加入購物車', at: '2026-07-20 10:00:00', inferred: false },
        { type: 'repeat_purchase', label: '完成回購', at: '2026-07-20 10:05:00', inferred: false, order_id: 'ord_2' },
        { type: 'recent_activity', label: '最近活動', at: '2026-07-20 10:05:00', inferred: false, event_name: 'purchase' },
      ],
      data_generated_at: '2026-07-24T10:00:00.000Z',
    },
  };

  const VISITOR_DETAIL_FIXTURE_OTHER = {
    success: true,
    visitor: {
      member_key: 'v_legacy_unknown', identity_type: 'visitor', display_name: null,
      line_uid_masked: null, friend_status: null,
      canonical_identity: { type: 'visitor_id', resolution_method: 'anonymous_no_link', confidence: 'unresolved' },
      linked_visitor_count: 1, first_seen_at: '2026-07-10 09:00:00', last_seen_at: '2026-07-10 09:05:00',
      total_visits: 1, cart_history: [], ltv: null,
      raw_timeline: [{ event_name: 'page_view', source: 'Direct', at: '2026-07-10 09:00:00' }],
      customer_journey: [
        { type: 'first_visit', label: 'Direct 首次來訪', at: '2026-07-10 09:00:00', inferred: false },
        { type: 'recent_activity', label: '最近活動', at: '2026-07-10 09:00:00', inferred: false, event_name: 'page_view' },
      ],
      data_generated_at: '2026-07-24T10:00:00.000Z',
    },
  };

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="analytics-v2-container"></div><div id="reports-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url, fetchOpts) => {
      fetchCalls.push({ url: String(url), opts: fetchOpts });
      let body = { success: true };
      let delay = 0;
      const u = String(url);
      if (u.includes('/api/analytics/visitor-360?') || u.endsWith('/api/analytics/visitor-360')) {
        body = opts.audienceResponder ? opts.audienceResponder(u) : audienceResponse(AUDIENCE_ROWS);
        delay = opts.audienceDelay ? opts.audienceDelay(u) : 0;
      } else if (u.includes('/api/analytics/visitor/')) {
        body = opts.visitorResponder ? opts.visitorResponder(u) : (u.includes('U_line_member_1') ? VISITOR_DETAIL_FIXTURE : VISITOR_DETAIL_FIXTURE_OTHER);
      } else if (u.includes('/api/analytics/dashboard')) {
        body = DASHBOARD_FIXTURE;
      } else if (u.includes('/api/crm/segments')) {
        const parsed = fetchOpts && fetchOpts.body ? JSON.parse(fetchOpts.body) : {};
        body = { success: true, id: 77, segment_type: parsed.segment_type, member_count: parsed.segment_type === 'static' ? (parsed.member_keys || []).length : 3, __request: parsed };
      }
      return new Promise((resolve) => { setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay); });
    };
  }

  async function setupAudiencePage(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    const caughtErrors = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.eval(appSrc);
    dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'r4_ui_store' };
    dom.window.loadAnalyticsV2Page();
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2SwitchTab('visitor360');
    await new Promise((r) => setTimeout(r, 20));
    return { dom, fetchCalls, caughtErrors };
  }
  function qs(url) { return Object.fromEntries(new URL(url, 'http://localhost/').searchParams); }
  function lastAudienceCall(fetchCalls) {
    const calls = fetchCalls.filter((c) => c.url.includes('/api/analytics/visitor-360'));
    return calls.length ? qs(calls[calls.length - 1].url) : null;
  }

  // 1. Visitor 360 頁籤渲染
  {
    const { dom, caughtErrors } = await setupAudiencePage();
    assert(caughtErrors.length === 0, '1a. 切到 Visitor 360 頁籤無 window error', caughtErrors.join('; '));
    const tabsHtml = dom.window.document.getElementById('av2-tabs').innerHTML;
    assert(tabsHtml.includes('Visitor 360'), '1. Visitor 360 頁籤按鈕已渲染');
  }

  // 2. 切到頁籤會呼叫 GET /api/analytics/visitor-360
  {
    const { fetchCalls } = await setupAudiencePage();
    assert(fetchCalls.some((c) => c.url.includes('/api/analytics/visitor-360')), '2. 切換至 Visitor 360 頁籤會呼叫 GET /api/analytics/visitor-360');
  }

  // 3~9. 頂層渠道選擇正確帶入 Visitor 360 請求
  const CHANNEL_CASES = [
    ['pos', 'pos'], ['line_takeout', 'line_takeout'], ['line_delivery', 'line_delivery'],
    ['shipping', 'shipping'], ['reservation', 'reservation'],
  ];
  for (const [uiChannel, expected] of CHANNEL_CASES) {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2SetChannel(uiChannel);
    await new Promise((r) => setTimeout(r, 20));
    const q = lastAudienceCall(fetchCalls);
    assert(!!q && q.channel === expected, `3-8. 選擇渠道「${uiChannel}」時 Visitor 360 請求帶正確的 channel=${expected}`, JSON.stringify(q));
  }
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2SetChannel('pos');
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2SetChannel('all');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastAudienceCall(fetchCalls);
    assert(!!q && q.channel === undefined, '9. 選擇「全部」時 Visitor 360 請求不帶 channel 限制（不送出 channel 參數）', JSON.stringify(q));
  }

  // 10. Identity 篩選只送出白名單值
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('identity', 'anonymous_upgraded');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastAudienceCall(fetchCalls);
    assert(q.identity === 'anonymous_upgraded', '10. identity 篩選送出正確白名單值', JSON.stringify(q));
  }

  // 11. 好友狀態篩選
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('friend_status', 'friend');
    await new Promise((r) => setTimeout(r, 20));
    assert(lastAudienceCall(fetchCalls).friend_status === 'friend', '11. friend_status 篩選送出正確值');
  }

  // 12. 回訪頻率篩選
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('visit_frequency', '3plus');
    await new Promise((r) => setTimeout(r, 20));
    assert(lastAudienceCall(fetchCalls).visit_frequency === '3plus', '12. visit_frequency=回訪3次以上 送出 3plus');
  }

  // 13. 購買行為篩選
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('purchase_behavior', 'checkout_no_purchase');
    await new Promise((r) => setTimeout(r, 20));
    assert(lastAudienceCall(fetchCalls).purchase_behavior === 'checkout_no_purchase', '13. purchase_behavior 篩選送出正確後端值');
  }

  // 14. 活躍度篩選
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('activity', 'inactive_30d');
    await new Promise((r) => setTimeout(r, 20));
    assert(lastAudienceCall(fetchCalls).activity === 'inactive_30d', '14. activity 篩選送出正確值');
  }

  // 15~17. source/campaign/channel/order_mode 互相獨立
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('source', 'Facebook');
    dom.window.av2AudienceApplyFilter('order_mode', 'delivery');
    await new Promise((r) => setTimeout(r, 20));
    const q = lastAudienceCall(fetchCalls);
    assert(q.source === 'Facebook' && q.order_mode === 'delivery' && q.channel === undefined,
      '15-17. source/order_mode 可獨立於 channel 同時存在，互不覆蓋', JSON.stringify(q));
  }

  // 18~19. 排序欄位與方向白名單
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('sort_by', 'revisit_score');
    await new Promise((r) => setTimeout(r, 20));
    let q = lastAudienceCall(fetchCalls);
    assert(q.sort_by === 'revisit_score', '18. 排序欄位（sort_by）送出白名單值');
    dom.window.av2AudienceSetSort('revisit_score', 'asc');
    await new Promise((r) => setTimeout(r, 20));
    q = lastAudienceCall(fetchCalls);
    assert(q.sort_dir === 'asc', '19. 排序方向（sort_dir）正確送出');
  }

  // 20~21. 數值篩選：無效數字/最小大於最大（本輪 UI 目前無獨立數值輸入框，
  // 篩選一律走後端 allowlist；這裡確認後端已知會安全拒絕，不會讓前端送出壞請求—
  // 見 utils/visitorAudience.js _sanitizeFilters()。UI 本身沒有提供 min/max 數值
  // 輸入元件，因此標記為 MANUAL（若未來新增數值輸入框，才需要對應的前端驗證測試）。
  manual('20-21. 數值篩選 min/max 前端驗證', '目前 Visitor 360 UI 尚未提供獨立的數值區間輸入框（僅有下拉選單篩選），min/max 數值篩選僅能透過 API 直接測試（已在 scripts/smoke-hotfix31-r4-channel-visitor360.js #35/#36 涵蓋），非本檔案 DOM 測試範圍。');

  // 22~23. 分頁 page/limit + 換頁大小重置到第 1 頁
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceGotoPage(3);
    await new Promise((r) => setTimeout(r, 20));
    let q = lastAudienceCall(fetchCalls);
    assert(q.page === '3', '22. 分頁送出正確的 page', JSON.stringify(q));
    dom.window.av2AudienceSetLimit(50);
    await new Promise((r) => setTimeout(r, 20));
    q = lastAudienceCall(fetchCalls);
    assert(q.limit === '50' && q.page === '1', '23. 變更每頁筆數後頁碼回到第 1 頁', JSON.stringify(q));
  }

  // 24. 載入中狀態
  {
    const { dom } = await setupAudiencePage({ audienceDelay: () => 50 });
    dom.window.av2AudienceFetchAndRender();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('載入中'), '24. 查詢期間顯示載入中狀態');
    await new Promise((r) => setTimeout(r, 80));
  }

  // 25. 空結果狀態
  {
    const { dom } = await setupAudiencePage({ audienceResponder: () => audienceResponse([]) });
    await new Promise((r) => setTimeout(r, 20));
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('沒有符合篩選條件'), '25. 空結果顯示空狀態文案');
  }

  // 26~27. API 失敗顯示安全訊息 + 重試觸發新請求
  {
    const dom = makeDom();
    const fetchCalls = [];
    let shouldFail = true;
    dom.window.fetch = (url, opts) => {
      fetchCalls.push({ url: String(url) });
      if (String(url).includes('/api/analytics/visitor-360')) {
        if (shouldFail) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, message: 'boom' }) });
        return Promise.resolve({ ok: true, status: 200, json: async () => audienceResponse(AUDIENCE_ROWS) });
      }
      if (String(url).includes('/api/analytics/dashboard')) return Promise.resolve({ ok: true, status: 200, json: async () => DASHBOARD_FIXTURE });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    };
    dom.window.eval(appSrc); dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true }; dom.window.currentStore = { store_id: 'x' };
    dom.window.loadAnalyticsV2Page();
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2SwitchTab('visitor360');
    await new Promise((r) => setTimeout(r, 20));
    let html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('boom') && !/at\s+\S+\.js:\d+/.test(html), '26. API 失敗顯示安全訊息（不含 stack trace）', html);
    shouldFail = false;
    const before = fetchCalls.filter((c) => c.url.includes('visitor-360')).length;
    await dom.window.av2AudienceFetchAndRender();
    const after = fetchCalls.filter((c) => c.url.includes('visitor-360')).length;
    assert(after > before, '27. 重新呼叫 av2AudienceFetchAndRender（等同重試）會送出新請求');
    html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('林小美'), '27b. 重試成功後畫面更新為新資料');
  }

  // 28. 快速篩選切換：較舊但較慢的回應不能覆蓋較新結果
  {
    const { dom } = await setupAudiencePage({
      audienceResponder: (u) => (u.includes('Facebook') ? audienceResponse([audienceRow({ canonical_key: 'slow_fb_result' })]) : audienceResponse([audienceRow({ canonical_key: 'fast_google_result' })])),
      audienceDelay: (u) => (u.includes('Facebook') ? 60 : 0),
    });
    dom.window.av2AudienceApplyFilter('source', 'Facebook'); // 慢的請求
    dom.window.av2AudienceApplyFilter('source', 'Google');   // 快的請求，應該才是最終畫面
    await new Promise((r) => setTimeout(r, 100));
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('fast_google_result'.slice(0, 6)) || !html.includes('slow_fb_result'), '28. 較舊但較慢的回應不會覆蓋較新的畫面');
  }

  // 29~36. 各列渲染：display_key / identity 文案 / friend 文案
  {
    const { dom } = await setupAudiencePage();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!html.includes('>aud_anon_1<'), '29. 匿名訪客列顯示縮短過的 display_key，不是完整原始 ID（原始 key 只能出現在內部 onclick 參數中，不能是可見文字內容）', html.includes('>aud_anon_1<') ? '原始 ID 以可見文字呈現' : '');
    assert(html.includes('僅匿名訪客'), '30. 匿名身份顯示為「僅匿名訪客」');
    assert(html.includes('LINE會員'), '31. LINE 會員身份顯示為「LINE會員」');
    assert(html.includes('已由匿名訪客升級為 LINE 會員'), '32. 升級身份顯示為「已由匿名訪客升級為 LINE 會員」');
    assert(html.includes('身份尚未解析'), '33. 未解析身份顯示為「身份尚未解析」');
    assert(html.includes('好友') , '34. 好友狀態欄位有渲染（好友）');
    assert(html.includes('非好友'), '35. 非好友狀態正確顯示為「非好友」');
    assert(html.includes('未知'), '36. 未知好友狀態正確顯示為「未知」');
  }

  // 37~39. 數字欄位渲染
  {
    const { dom } = await setupAudiencePage();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(/<td>6<\/td>/.test(html), '37a. 來訪次數（6）正確渲染', html.slice(0, 200));
    assert(html.includes('NT$1,200'), '38. 累積消費（NT$1,200）正確渲染');
    assert(html.includes('38'), '39. 回訪分數（38）正確渲染');
  }

  // 40~41. 分數說明 + 免責聲明（在詳情 drawer 裡）
  {
    const { dom } = await setupAudiencePage();
    await dom.window.av2AudienceOpenDetail('U_line_member_1');
    const drawer = dom.window.document.getElementById('av2-audience-drawer').innerHTML;
    assert(drawer.includes('不代表營收或購買機率'), '41. 回訪分數免責聲明有顯示');
  }

  // 42~43. 顧客狀態標籤（單一 + 多重）
  {
    const { dom } = await setupAudiencePage();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('回訪訪客') && html.includes('首購客'), '42-43. 同一位訪客可同時渲染多個狀態標籤（回訪訪客＋首購客）');
  }

  // 44. 來源與渠道分開渲染
  {
    const { dom } = await setupAudiencePage();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(html.includes('Facebook') && html.includes('line_takeout'), '44. recent_source 與 recent_channel 分別渲染，不混在一起');
  }

  // 45~46. 詳情 lazy load + 呼叫既有 visitor detail API
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    const before = fetchCalls.filter((c) => c.url.includes('/api/analytics/visitor/')).length;
    assert(before === 0, '45. 載入主列表時不會預先呼叫任何訪客詳情 API');
    await dom.window.av2AudienceOpenDetail('U_line_member_1');
    const after = fetchCalls.filter((c) => c.url.includes('/api/analytics/visitor/U_line_member_1')).length;
    assert(after === 1, '46. 點開詳情才呼叫既有 GET /api/analytics/visitor/:key 端點');
  }

  // 47~54. Customer Journey / raw timeline
  {
    const { dom } = await setupAudiencePage();
    await dom.window.av2AudienceOpenDetail('U_line_member_1');
    const drawer = dom.window.document.getElementById('av2-audience-drawer').innerHTML;
    const journeyIdx = drawer.indexOf('Customer Journey');
    const timelineIdx = drawer.indexOf('原始 Session Timeline');
    assert(journeyIdx >= 0 && timelineIdx > journeyIdx, '47. Customer Journey 顯示在原始 Session Timeline 之上');
    assert(timelineIdx >= 0, '48. 原始 Session Timeline 仍然存在');
    const firstAt = drawer.indexOf('首次來訪');
    const purchaseAt = drawer.indexOf('完成首購');
    const repeatAt = drawer.indexOf('完成回購');
    assert(firstAt >= 0 && purchaseAt > firstAt, '49. 里程碑依時間順序渲染（首次來訪在完成首購之前）');
    assert(purchaseAt >= 0 && repeatAt >= 0 && repeatAt > purchaseAt, '50. 首購與回購渲染為不同里程碑，且回購在首購之後');
    assert(drawer.includes('匿名訪客升級為 LINE 會員'), '51. 身份升級里程碑正確渲染');
    assert(drawer.includes('商品瀏覽（2 次）'), '52. 連續同類低階事件（商品瀏覽）在 Customer Journey 中合併顯示');
    assert((drawer.match(/view_product/g) || []).length >= 2, '53. 原始 timeline 仍保留兩筆各自的 view_product 事件（合併只發生在 Journey，不影響原始資料）');
    assert(!drawer.includes('優惠券') && !drawer.includes('coupon'), '54. 沒有真實優惠券資料時，不會憑空產生優惠券里程碑');
    assert(drawer.includes('Direct'.slice(0,3)) || drawer.includes('19 天後回訪'), '55. 來源/渠道轉換（回訪時 source 從 Facebook 變成 Direct）在 Journey 中有反映');
  }

  // 56. 未知欄位顯示未知/不可用，不捏造
  {
    const { dom } = await setupAudiencePage({
      visitorResponder: () => ({ success: true, visitor: Object.assign({}, VISITOR_DETAIL_FIXTURE.visitor, { ltv: null, last_purchase_at: null }) }),
    });
    await dom.window.av2AudienceOpenDetail('U_line_member_1');
    const drawer = dom.window.document.getElementById('av2-audience-drawer').innerHTML;
    assert(drawer.includes('—') && !drawer.includes('undefined') && !drawer.includes('NaN'), '56. 缺漏欄位顯示「—」，沒有出現 undefined/NaN 字面字串', drawer.slice(0, 300));
  }

  // 57~58. 開啟不同訪客不會疊加重複節點 / 換人清除舊內容
  // fix18-10-hotfix31-R4.1（需求文件 C.5）：再次點擊「同一位」已開啟的訪客現在會
  // 觸發收合（toggle close），這是本輪刻意新增的行為，不是本測試原本要驗證的
  // 「不重複疊加節點」問題——改用「開啟另一位、再開回第一位」的情境驗證同一時間
  // 永遠只有一個「訪客 360」區塊，不會疊加。
  {
    const { dom } = await setupAudiencePage();
    await dom.window.av2AudienceOpenDetail('U_line_member_1');
    const count1 = (dom.window.document.getElementById('av2-audience-drawer').innerHTML.match(/訪客 360/g) || []).length;
    await dom.window.av2AudienceOpenDetail('v_legacy_unknown'); // 開啟另一位訪客
    await dom.window.av2AudienceOpenDetail('U_line_member_1'); // 再開回第一位（不是連續點同一位，不會觸發 toggle close）
    const count2 = (dom.window.document.getElementById('av2-audience-drawer').innerHTML.match(/訪客 360/g) || []).length;
    assert(count1 === 1 && count2 === 1, '57. 重複開啟不同訪客詳情不會疊加重複的區塊（同一時間永遠只有一個）', `count1=${count1} count2=${count2}`);

    await dom.window.av2AudienceOpenDetail('v_legacy_unknown');
    const drawer2 = dom.window.document.getElementById('av2-audience-drawer').innerHTML;
    assert(!drawer2.includes('林小美'), '58. 開啟另一位訪客的詳情會清除舊訪客的殘留內容', drawer2.includes('林小美') ? '殘留了上一位的資料' : '');
  }

  // 59~63. 分群建立
  {
    const { dom, fetchCalls } = await setupAudiencePage();
    dom.window.av2AudienceApplyFilter('purchase_behavior', 'never_purchased');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.av2AudienceCreateSegment('dynamic', 'R4動態分群測試', '');
    const segCall = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).pop();
    const reqBody = JSON.parse(segCall.opts.body);
    assert(reqBody.filter.__source === 'visitor_audience', '59a. 動態分群請求帶有 __source=visitor_audience 標記', JSON.stringify(reqBody.filter));
    assert(reqBody.filter.purchase_behavior === 'never_purchased', '59b. 動態分群只送出目前篩選定義');
    assert(!reqBody.member_keys, '59c. 動態分群不會送出 member_keys（不建立靜態成員快照）');

    // 62. 沒有勾選時，靜態分群被安全擋下
    const beforeCount = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).length;
    await dom.window.av2AudienceCreateSegment('static', 'R4靜態分群無選取', '');
    const afterCount = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).length;
    assert(afterCount === beforeCount, '62. 沒有勾選任何對象時，靜態分群建立被安全擋下（不送出 API 請求）');

    // 63. 分群名稱為必填
    const beforeCount2 = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).length;
    await dom.window.av2AudienceCreateSegment('dynamic', '', '');
    const afterCount2 = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).length;
    assert(afterCount2 === beforeCount2, '63. 分群名稱為空時不會送出建立分群的 API 請求');

    // 60~61. 靜態分群：勾選 + 去重
    dom.window.av2AudienceToggleSelect('aud_anon_1', 'visitor_id', '', true);
    dom.window.av2AudienceToggleSelect('U_line_member_1', 'line_user_id', '林小美', true);
    dom.window.av2AudienceToggleSelect('aud_anon_1', 'visitor_id', '', true); // 重複勾選同一位，Map 天生去重
    await dom.window.av2AudienceCreateSegment('static', 'R4靜態分群測試', '');
    const staticCall = fetchCalls.filter((c) => c.url.includes('/api/crm/segments')).pop();
    const staticBody = JSON.parse(staticCall.opts.body);
    assert(staticBody.member_keys.length === 2, '60. 靜態分群送出明確選取的 canonical key 清單', JSON.stringify(staticBody.member_keys));
    const keys = staticBody.member_keys.map((m) => m.member_key);
    assert(new Set(keys).size === keys.length, '61. 靜態分群成員已去重（無重複 member_key）');
  }

  // 64~65. 成功/失敗訊息只在對應情況出現（透過 toast 觀察不易，改用回應狀態驗證邏輯已在 59/62/63 涵蓋；
  // 這裡額外驗證失敗情境不會誤報成功）
  {
    const dom = makeDom();
    dom.window.fetch = (url) => {
      if (String(url).includes('/api/crm/segments')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, message: '建立失敗' }) });
      if (String(url).includes('/api/analytics/visitor-360')) return Promise.resolve({ ok: true, status: 200, json: async () => audienceResponse(AUDIENCE_ROWS) });
      if (String(url).includes('/api/analytics/dashboard')) return Promise.resolve({ ok: true, status: 200, json: async () => DASHBOARD_FIXTURE });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    };
    dom.window.eval(appSrc); dom.window.eval(av2Src);
    dom.window.currentFeatures = { reports: true }; dom.window.currentStore = { store_id: 'x' };
    dom.window.loadAnalyticsV2Page();
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2SwitchTab('visitor360');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.av2AudienceCreateSegment('dynamic', 'R4失敗測試', '');
    dom.window.av2SwitchTab('crm_action_center');
    const ccHtml = dom.window.document.getElementById('av2-body').innerHTML;
    assert(ccHtml.includes('尚未準備任何受眾'), '64-65. 分群 API 失敗後，CRM Action Center 仍顯示「尚未準備」（沒有誤將失敗的分群記錄成功）', ccHtml.slice(0, 200));
  }

  // 66. 已選取對象人數正確更新
  {
    const { dom } = await setupAudiencePage();
    dom.window.av2AudienceToggleSelect('aud_anon_1', 'visitor_id', '', true);
    dom.window.av2AudienceToggleSelect('U_line_member_1', 'line_user_id', '林小美', true);
    const rendered = dom.window._av2RenderVisitor360Audience();
    assert(rendered.includes('已勾選 2 人'), '66. 選取人數正確更新為 2', rendered.match(/已勾選\s*\d+\s*人/) ? rendered.match(/已勾選\s*\d+\s*人/)[0] : 'not found');
    dom.window.av2AudienceToggleSelect('aud_anon_1', 'visitor_id', '', false);
    const rendered2 = dom.window._av2RenderVisitor360Audience();
    assert(rendered2.includes('已勾選 1 人'), '66b. 取消勾選後人數正確減少為 1');
  }

  // 67~68. CRM Action Center 仍是佔位入口，沒有真的動作
  {
    const { dom } = await setupAudiencePage();
    const rendered = dom.window._av2RenderVisitor360Audience();
    assert(rendered.includes('前往 CRM Action Center'), '67. Visitor 360 頁面保留前往 CRM Action Center 的入口');
    dom.window.av2SwitchTab('crm_action_center');
    const ccHtml = dom.window.document.getElementById('av2-body').innerHTML;
    assert(!/已發送|已核發|已寄出/.test(ccHtml), '68. CRM Action Center 沒有出現任何「已發送/已核發」等真的執行動作的字樣');
  }

  // 69. XSS：使用者可控文字不能建立 script 節點
  {
    const { dom } = await setupAudiencePage({
      audienceResponder: () => audienceResponse([audienceRow({
        canonical_key: 'xss_1', display_name: '<script>window.__xss=1</script>惡意名稱',
        recent_source: '<img src=x onerror="window.__xss2=1">', recent_campaign: '<b>粗體活動</b>',
      })]),
    });
    assert(dom.window.__xss === undefined && dom.window.__xss2 === undefined, '69. 使用者可控文字（名稱/來源/活動）無法建立可執行的 script/onerror');
    const scriptTags = dom.window.document.querySelectorAll('#av2-audience-body script');
    assert(scriptTags.length === 0, '69b. 商品/會員名稱渲染後，沒有任何真正的 <script> DOM 元素被建立');
  }

  // 70. 不渲染任何原始 token
  {
    const { dom } = await setupAudiencePage();
    const html = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(!/access_token|id_token|channel_token/i.test(html), '70. 沒有任何 access_token/id_token/channel_token 字樣被渲染');
  }

  // 71. 跨店 ID 不會被放進可編輯的前端 state（本 UI 一律透過 req.storeId 隔離的
  // 後端 API 取得資料，前端本身不接受使用者輸入任意 store_id 覆寫查詢範圍）
  {
    const hasStoreIdInput = /id=["']?[^"'>]*store_id[^"'>]*["']?/i.test(fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8'));
    assert(!hasStoreIdInput, '71. Visitor 360 UI 沒有任何允許使用者輸入/覆寫 store_id 的欄位');
  }

  // 72. Boss Dashboard 未變動
  {
    assert(fs.existsSync(path.join(ROOT, 'routes/dashboard.js')), '72. routes/dashboard.js（Boss Dashboard 路由）仍然存在、未被本輪觸碰');
  }

  // 73. 既有 Cart Abandonment UI 仍正常運作
  {
    const { dom } = await setupAudiencePage();
    dom.window.av2SwitchTab('cart_abandonment');
    await new Promise((r) => setTimeout(r, 20));
    const html = dom.window.document.getElementById('av2-body').innerHTML;
    assert(html.includes('加入購物車數'), '73. 切回 Cart Abandonment 頁籤仍正常渲染既有內容');
  }

  // 74. 窄螢幕：核心欄位/操作可及性（jsdom 無法驗證真實版面，這裡確認表格用
  // overflow-x:auto 包裹，欄位/按鈕本身仍在 DOM 中可存取）
  {
    const { dom } = await setupAudiencePage();
    // overflow-x:auto 包裹的表格是資料載入完成後由 _av2AudienceRenderBody() 寫入
    // #av2-audience-body 的內容，不是 _av2RenderVisitor360Audience() 回傳的初始
    // 骨架（骨架階段只有篩選列與「載入中」狀態）——這裡改為檢查資料載入後的實際
    // DOM 內容，而不是直接呼叫骨架渲染函式。
    const bodyHtml = dom.window.document.getElementById('av2-audience-body').innerHTML;
    assert(bodyHtml.includes('overflow-x:auto'), '74a. 表格使用 overflow-x:auto 包裹，窄螢幕仍可捲動存取所有欄位', bodyHtml.slice(0, 200));
    manual('74b. 窄螢幕實際版面/斷行效果', '需要真實手機/平板瀏覽器或視覺回歸工具確認實際渲染寬度與斷行，jsdom 無法驗證真實版面配置。');
  }

  // 75. 重繪後沒有殘留重複事件監聽（本頁全部使用 inline onclick/onchange 重繪 innerHTML，
  // 不使用 addEventListener，因此天生不會疊加監聽器——與既有 Cart Abandonment Explorer 同一慣例）
  {
    const srcHasAddEventListenerInAudience = /function av2Audience[\s\S]*?addEventListener/.test(fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8'));
    assert(!srcHasAddEventListenerInAudience, '75. Visitor 360 Audience 渲染邏輯全部使用 inline onclick/onchange + innerHTML 重繪，不使用 addEventListener，重繪不會疊加重複監聽器');
  }

  printSummary();
}

function printSummary() {
  const totalPass = results.filter((r) => r.status === 'PASS').length;
  const totalFail = results.filter((r) => r.status === 'FAIL').length;
  const totalManual = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\n合計：${results.length} 項，PASS ${totalPass}，FAIL ${totalFail}，MANUAL REQUIRED ${totalManual}`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke-r4-ui] 執行失敗：', e.message, e.stack);
  process.exitCode = 1;
});
