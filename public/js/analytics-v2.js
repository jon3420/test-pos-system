// public/js/analytics-v2.js — fix18-10-hotfix24-UI
//
// 📊 POS Analytics V2｜營運分析中心
// 本次（Hotfix24-UI）只調整版面／捲動／寬度，不改變任何資料邏輯、不改變
// API 呼叫方式、不新增欄位。所有 render 函式的「資料來源」與 Hotfix24-A
// 完全相同，只有 HTML/CSS 結構改用 public/css/main.css 新增的
// .analytics-shell / .analytics-kpi-grid / .analytics-ranking-grid /
// .analytics-funnel-metrics / .analytics-table-wrap / .analytics-empty-state
// 等共用 class（見 main.css「fix18-10-hotfix24-UI」區塊的註解，說明了
// Funnel 捲不到底、整頁偏左兩個問題的真正原因與修法）。
//
// 頁面生命週期（依 Hotfix24-A 需求文件一，本次未變動）：
//   - loadAnalyticsV2Page() 由 showPage('analytics_v2') 呼叫，每次進入都會依
//     目前日期狀態重新抓資料；日期列／頁籤列都是重繪 innerHTML + inline
//     onclick，不是 addEventListener，不會重複綁定。
//   - 不會動到 #page-reports、#page-orders…等其他既有頁面的 DOM。

'use strict';

let av2DateState = { uiPreset: 'today', preset: 'today', start_date: '', end_date: '' };
let av2Tab = 'dashboard';
let _av2LastData = null;
// fix18-10-hotfix24-A3（需求文件十二）：渠道篩選 state，所有分頁共用同一個值，
// 切換渠道時重新呼叫同一支既有 /api/analytics/dashboard（不是第二套 API）。
let av2Channel = 'all';
const AV2_CHANNELS = [
  ['all', '全部'],
  ['pos', '店內 POS'],
  ['line_takeout', 'LINE 外帶'],
  ['line_delivery', 'LINE 外送'],
  ['shipping', '宅配'],
  ['reservation', '預訂'],
];

// ── 入口：由 showPage('analytics_v2') 呼叫 ──────────────────────────
function loadAnalyticsV2Page() {
  const container = document.getElementById('analytics-v2-container');
  if (!container) return;

  // 權限：沿用既有 reports 權限（showPage 已攔截一次，這裡是第二層保險）
  const f = window.currentFeatures || {};
  if (f.reports === false) {
    container.innerHTML = `<div class="analytics-empty-state">
      <div class="analytics-empty-icon">🔒</div>
      <h3 style="color:var(--danger)">營運分析功能尚未授權</h3>
      <p>請聯絡系統管理員升級方案。</p>
    </div>`;
    return;
  }

  try {
    const saved = JSON.parse(sessionStorage.getItem('av2DateState') || 'null');
    if (saved && saved.preset) av2DateState = Object.assign({ uiPreset: 'today', preset: 'today', start_date: '', end_date: '' }, saved);
  } catch (e) {}
  try {
    const savedCh = sessionStorage.getItem('av2Channel');
    if (savedCh && AV2_CHANNELS.some(([k]) => k === savedCh)) av2Channel = savedCh;
  } catch (e) {}

  container.innerHTML = _av2Skeleton();
  _av2RenderDateControls();
  _av2RenderChannelControls();
  _av2RenderTabs();
  av2FetchAndRender();
}

// ── Shell（fix18-10-hotfix24-UI：全寬容器，不再是偏左的固定寬度區塊）──
function _av2Skeleton() {
  return `
  <div id="av2-wrap" class="analytics-shell">
    <div class="analytics-header">
      <h2 class="analytics-title">📊 POS Analytics V2｜營運分析中心</h2>
      <div class="analytics-subtitle">資料追蹤與轉換分析</div>
      <div id="av2-date-controls" class="analytics-date-controls"></div>
      <div id="av2-date-range-label" class="analytics-date-range-label"></div>
      <div id="av2-channel-controls" class="analytics-date-controls" style="margin-top:6px"></div>
      <div id="av2-tabs" class="analytics-tabs"></div>
    </div>
    <div id="av2-body"><div style="color:var(--text-secondary);padding:20px">載入中...</div></div>
  </div>`;
}

// ── 日期篩選：今日／昨日／近7天／近30天／本月／自訂 ─────────────────
// 沿用既有 /api/analytics/dashboard 參數格式（preset + start_date/end_date +
// timezone），不建立新的日期 API、不改變既有 preset 語意（見 utils/dashboardDate.js）。
function _av2RollingRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return { start_date: fmt(start), end_date: fmt(end) };
}

function _av2RenderDateControls() {
  const el = document.getElementById('av2-date-controls');
  const labelEl = document.getElementById('av2-date-range-label');
  if (!el) return;
  // fix18-10-hotfix24-A1：新增「本週」「上月」「單日」，與「報表分析」頁使用完全相同的
  // API preset 語意（week/lastmonth/single，見 utils/dashboardDate.js resolveDateRange()），
  // 不是另外發明一套日期邏輯，確保同一天在不同頁面查詢結果一致。
  const presets = [
    ['today','今日'], ['yesterday','昨日'], ['week','本週'],
    ['last7','近7天'], ['last30','近30天'], ['month','本月'],
    ['lastmonth','上月'], ['single','單日'], ['custom','自訂'],
  ];
  const btnStyle = (active) => `padding:6px 12px;border-radius:8px;border:1px solid var(--border);font-size:.8rem;cursor:pointer;white-space:nowrap;background:${active?'var(--accent)':'transparent'};color:${active?'#111':'var(--text-secondary)'};font-weight:${active?'700':'400'}`;
  const isCustom = av2DateState.uiPreset === 'custom';
  const isSingle = av2DateState.uiPreset === 'single';
  el.innerHTML = `
    ${presets.map(([k,label]) => `<button onclick="av2SetPreset('${k}')" style="${btnStyle(av2DateState.uiPreset===k)}">${label}</button>`).join('')}
    <div id="av2-single-wrap" style="display:${isSingle?'flex':'none'};gap:4px;align-items:center">
      <input type="date" id="av2-single-date" value="${escHtml(av2DateState.start_date||twTodayStr())}"
        style="padding:5px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.8rem">
      <button onclick="av2ApplySingleDate()" style="padding:6px 14px;border-radius:8px;background:var(--success);border:none;color:#111;font-weight:700;cursor:pointer;font-size:.8rem">🔍 查詢</button>
    </div>
    <div id="av2-custom-wrap" style="display:${isCustom?'flex':'none'};gap:4px;align-items:center">
      <input type="date" id="av2-custom-start" value="${escHtml(av2DateState.start_date||'')}"
        style="padding:5px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.8rem">
      <span style="color:var(--text-secondary)">～</span>
      <input type="date" id="av2-custom-end" value="${escHtml(av2DateState.end_date||'')}"
        style="padding:5px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.8rem">
      <button onclick="av2ApplyCustomRange()" style="padding:6px 14px;border-radius:8px;background:var(--success);border:none;color:#111;font-weight:700;cursor:pointer;font-size:.8rem">🔍 查詢</button>
    </div>
    <button onclick="av2FetchAndRender()" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.8rem">🔄 重新整理</button>`;
  if (labelEl) {
    labelEl.textContent = `目前查詢區間：${av2DateState.start_date||'—'} ～ ${av2DateState.end_date||'今天'}（Asia/Taipei）`;
  }
}

// ── 渠道篩選：全部／店內 POS／LINE 外帶／LINE 外送／宅配／預訂 ─────────────
// 依需求文件十二：放在日期選擇器旁；所有 Analytics V2 分頁共用同一個 channel
// state；切換渠道時重新載入同一支既有 /api/analytics/dashboard（只多帶一個
// ?channel= 參數，不是新 API）。
function _av2RenderChannelControls() {
  const el = document.getElementById('av2-channel-controls');
  if (!el) return;
  const btnStyle = (active) => `padding:5px 11px;border-radius:8px;border:1px solid var(--border);font-size:.78rem;cursor:pointer;white-space:nowrap;background:${active?'var(--accent)':'transparent'};color:${active?'#111':'var(--text-secondary)'};font-weight:${active?'700':'400'}`;
  el.innerHTML = `<span style="font-size:.75rem;color:var(--text-secondary);margin-right:2px">渠道：</span>` +
    AV2_CHANNELS.map(([k, label]) => `<button onclick="av2SetChannel('${k}')" style="${btnStyle(av2Channel===k)}">${label}</button>`).join('');
}

function av2SetChannel(channel) {
  if (av2Channel === channel) return;
  av2Channel = channel;
  try { sessionStorage.setItem('av2Channel', av2Channel); } catch (e) {}
  _av2RenderChannelControls();
  av2FetchAndRender();
}

function av2SetPreset(uiPreset) {
  av2DateState.uiPreset = uiPreset;
  if (uiPreset === 'last7' || uiPreset === 'last30') {
    const r = _av2RollingRange(uiPreset === 'last7' ? 7 : 30);
    av2DateState.preset = 'custom';
    av2DateState.start_date = r.start_date;
    av2DateState.end_date = r.end_date;
  } else if (uiPreset === 'single') {
    if (!av2DateState.start_date) { const t = twTodayStr(); av2DateState.start_date = t; av2DateState.end_date = t; }
    av2DateState.preset = 'single';
    _av2RenderDateControls();
    return; // 等使用者選好日期按「查詢」，這裡先不打 API
  } else if (uiPreset === 'custom') {
    if (!av2DateState.start_date) { const t = twTodayStr(); av2DateState.start_date = t; av2DateState.end_date = t; }
    av2DateState.preset = 'custom';
    _av2RenderDateControls();
    return; // 等使用者選好日期按「查詢」，這裡先不打 API
  } else {
    // today / yesterday / week / month / lastmonth 直接對應既有 API preset，
    // 與「報表分析」頁 renderDashboardDateControls() 使用同一組 key
    av2DateState.preset = uiPreset;
    av2DateState.start_date = '';
    av2DateState.end_date = '';
  }
  _av2RenderDateControls();
  av2FetchAndRender();
}

function av2ApplySingleDate() {
  const d = document.getElementById('av2-single-date')?.value;
  if (!d) { showToast('請選擇日期', 'error'); return; }
  av2DateState.preset = 'single';
  av2DateState.start_date = d;
  av2DateState.end_date = d;
  _av2RenderDateControls();
  av2FetchAndRender();
}

function av2ApplyCustomRange() {
  const s = document.getElementById('av2-custom-start')?.value;
  const e = document.getElementById('av2-custom-end')?.value;
  if (!s || !e) { showToast('請選擇開始與結束日期', 'error'); return; }
  if (e < s) { showToast('結束日期不得早於開始日期', 'error'); return; }
  av2DateState.preset = 'custom';
  av2DateState.start_date = s;
  av2DateState.end_date = e;
  _av2RenderDateControls();
  av2FetchAndRender();
}

// ── 子頁籤：① Dashboard ② Funnel ③ Cart Abandonment ④ Products
//    ⑤ Sources / Campaigns ⑥ CRM Dashboard ⑦ AI Insights（本次未變動）──
const AV2_TABS = [
  ['dashboard', '📊 Dashboard'],
  ['funnel', '🔻 Funnel'],
  ['cart_abandonment', '🛒 Cart Abandonment'],
  ['products', '🏆 Products'],
  ['sources', '📡 Sources / Campaigns'],
  ['crm', '👥 CRM Dashboard'],
  ['ai', '🤖 AI Insights'],
  ['crm_action_center', '🎯 CRM Action Center'],
];
function _av2RenderTabs() {
  const el = document.getElementById('av2-tabs');
  if (!el) return;
  el.innerHTML = AV2_TABS.map(([k,label]) => {
    const active = av2Tab === k;
    return `<button onclick="av2SwitchTab('${k}')" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border);font-size:.85rem;cursor:pointer;background:${active?'var(--accent)':'transparent'};color:${active?'#111':'var(--text-secondary)'};font-weight:${active?'700':'400'}">${label}</button>`;
  }).join('');
}
// 頁籤切換只重畫 #av2-body，不重新整頁、不重新呼叫 API（除非目前沒有任何資料）
function av2SwitchTab(tab) {
  av2Tab = tab;
  _av2RenderTabs();
  if (_av2LastData) av2Render(_av2LastData);
  else av2FetchAndRender();
}

// ── API 串接：完全沿用既有 /api/analytics/dashboard，格式與 Hotfix24-A 完全相同 ──
async function av2FetchAndRender() {
  try { sessionStorage.setItem('av2DateState', JSON.stringify(av2DateState)); } catch (e) {}
  const body = document.getElementById('av2-body');
  if (body && !_av2LastData) body.innerHTML = '<div style="color:var(--text-secondary);padding:20px">載入中...</div>';

  const params = new URLSearchParams({ preset: av2DateState.preset, timezone: 'Asia/Taipei' });
  if (av2DateState.start_date) params.set('start_date', av2DateState.start_date);
  if (av2DateState.end_date) params.set('end_date', av2DateState.end_date);
  if (av2Channel && av2Channel !== 'all') params.set('channel', av2Channel);

  try {
    const res = await apiFetch('/api/analytics/dashboard?' + params.toString());
    if (!res || res.status === 403) { _av2Error('無法載入營運分析（功能未授權）'); return; }
    const json = await res.json();
    if (!json.success) { _av2Error(json.message || '載入失敗'); return; }
    _av2LastData = json;
    av2Render(json);
  } catch (e) {
    _av2Error(e.message);
  }
}

function _av2Error(msg) {
  const body = document.getElementById('av2-body');
  if (_av2LastData) {
    showToast('營運分析更新失敗：' + msg, 'error');
    if (body) av2Render(_av2LastData); // 保留上次成功畫面，不讓整頁白屏
    return;
  }
  if (body) body.innerHTML = `<div class="analytics-empty-state">
    <div class="analytics-empty-icon">❌</div>
    <h3 style="color:var(--danger)">載入失敗</h3>
    <p>${escHtml(msg)}</p>
    <div style="margin-top:14px"><button onclick="av2FetchAndRender()" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.8rem">🔄 重新載入</button></div>
  </div>`;
}

// 單一區塊渲染失敗不得讓整個頁面白屏：每個 render 函式都包一層
function _av2Safe(fn, fallbackTitle) {
  try { return fn(); }
  catch (e) {
    console.error('[analytics-v2] render error:', fallbackTitle, e);
    return _section('⚠️ ' + fallbackTitle, `<div style="color:var(--danger);font-size:.85rem">此區塊載入失敗，其餘區塊不受影響（${escHtml(e.message||'未知錯誤')}）</div>`);
  }
}

// ── 畫面組裝（依目前選中的子頁籤）────────────────────────────────────
function av2Render(data) {
  const body = document.getElementById('av2-body');
  if (!body) return;
  const v2 = data.analytics_v2 || {};
  let html = '';
  if (av2Tab === 'dashboard') html = _av2Safe(() => _av2RenderDashboard(data, v2), 'Dashboard');
  else if (av2Tab === 'funnel') html = _av2Safe(() => _av2RenderFunnel(v2), 'Funnel');
  else if (av2Tab === 'cart_abandonment') html = _av2Safe(() => _av2RenderCartAbandonment(v2), 'Cart Abandonment');
  else if (av2Tab === 'products') html = _av2Safe(() => _av2RenderProducts(v2), 'Products');
  else if (av2Tab === 'sources') html = _av2Safe(() => _av2RenderSourcesCampaigns(v2), 'Sources / Campaigns');
  else if (av2Tab === 'crm') html = _av2Safe(() => _av2RenderCrm(v2), 'CRM Dashboard');
  else if (av2Tab === 'ai') html = _av2Safe(() => _av2RenderAiInsights(v2), 'AI Insights');
  else if (av2Tab === 'crm_action_center') html = _av2Safe(() => _av2RenderCrmActionCenter(), 'CRM Action Center');
  body.innerHTML = html;
}

// ── 共用元件 ─────────────────────────────────────────────────────────
const AV2_SOURCE_ORDER = ['Facebook', 'Google', 'LINE', 'Instagram', 'Direct', 'Other'];
function _av2SourceRows(sources) {
  const map = {};
  (sources || []).forEach(s => { map[s.source] = s; });
  return AV2_SOURCE_ORDER.map(name => map[name] || { source: name, sessions: 0, orders: 0, revenue: 0, conversion_rate: null });
}

// 統一空狀態（依需求文件十七：全部頁籤共用同一套樣式，不再各自寫小灰字）
function _av2Empty(icon, title, desc) {
  return `<div class="analytics-empty-state">
    <div class="analytics-empty-icon">${icon}</div>
    <h3>${escHtml(title)}</h3>
    <p>${desc}</p>
  </div>`;
}

function _av2TableWrap(inner) {
  return `<div class="analytics-table-wrap">${inner}</div>`;
}

// ── ① Dashboard（總覽）─────────────────────────────────────────────
// fix18-10-hotfix24-A1（Part 8/11：Event 與 User 正式分離）：
//   商品瀏覽／加入購物車／開始結帳 顯示的是「事件次數」（event_count，不去重），
//   並在括號內附註「不重複人數」（unique_users）；總訪客維持不重複人數（本來就是
//   進站的量測基準）；完成付款／訂單數維持「筆」（訂單為單位，本來就不該用人數）。
function _av2RenderDashboard(data, v2) {
  const kpi = data.kpi || {};
  const funnel = Array.isArray(data.funnel) ? data.funnel : (data.funnel && data.funnel.stages) || [];
  const stageOf = (key) => funnel.find(f => f.key === key) || null;
  const purchaseStage = stageOf('purchase');
  const convRate = purchaseStage ? purchaseStage.overall_conversion_rate : null;

  // event_count 欄位是 Hotfix24-A1 新增的附加欄位；若拿到的是舊格式回應（不含
  // event_count），優雅退回原本的 count，不讓畫面報錯或顯示 undefined。
  const evtCount = (key) => { const s = stageOf(key); if (!s) return 0; return s.event_count !== undefined ? s.event_count : s.count; };
  const uniqUsers = (key) => { const s = stageOf(key); if (!s) return 0; return s.unique_users !== undefined ? s.unique_users : s.count; };

  const cardWithUnique = (label, eventCnt, unique, unit) => _card(
    label, eventCnt + unit, `（不重複 ${unique} 人）`
  );

  let html = '';

  // Part 7：舊資料與新資料分離 —— 查詢區間落在 Tracking 啟用之前，顯示提醒橫幅
  const tm = data.tracking_meta;
  if (tm && (tm.is_legacy_period || tm.is_mixed_period)) {
    html += `<div class="analytics-card" style="margin-bottom:16px;border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.06)">
      <div style="font-size:.78rem;color:var(--text-secondary);line-height:1.6">
        ⚠️ ${tm.is_legacy_period ? '此查詢區間完全落在' : '此查詢區間橫跨'} Analytics Tracking 正式啟用日（${escHtml(tm.tracking_start_date)}）之前 —— 
        該時段的訂單屬於 <b style="color:var(--text-primary)">Legacy Orders</b>（沒有對應的瀏覽／加購／結帳事件），
        下方「營收／訂單數」仍取自完整的 orders 歷史資料，但漏斗與轉換率只會反映 Tracking 啟用後才有的事件資料，
        兩者不可直接相除計算轉換率，避免出現失真的百分比。
      </div>
    </div>`;
  }

  html += `<div class="analytics-kpi-grid">
    ${_card('總訪客', uniqUsers('page_view') + ' 人')}
    ${cardWithUnique('商品瀏覽', evtCount('view_product'), uniqUsers('view_product'), ' 次')}
    ${cardWithUnique('加入購物車', evtCount('add_to_cart'), uniqUsers('add_to_cart'), ' 次')}
    ${cardWithUnique('開始結帳', evtCount('begin_checkout'), uniqUsers('begin_checkout'), ' 次')}
    ${_card('完成付款', (purchaseStage?purchaseStage.count:0) + ' 筆', '', '#10b981')}
    ${_card('訂單數', (kpi.orders||0) + ' 筆')}
    ${_card('營收', _nt(kpi.revenue), '', '#10b981')}
    ${_card('平均客單', _nt(kpi.avg_order_value))}
    ${_card('轉換率', _fmtPct(convRate), '', '#818cf8')}
  </div>`;

  const sourceRows = _av2SourceRows(v2.source_performance);
  const hasSourceData = sourceRows.some(s => s.sessions > 0 || s.orders > 0);
  const srcRows = sourceRows.map(s => `<tr>
    <td style="padding:6px 0">${escHtml(s.source)}</td>
    <td style="padding:6px 0;text-align:right">${s.sessions}</td>
    <td style="padding:6px 0;text-align:right">${s.orders}</td>
    <td style="padding:6px 0;text-align:right;color:var(--success)">${_nt(s.revenue)}</td>
    <td style="padding:6px 0;text-align:right">${_fmtPct(s.conversion_rate)}</td>
  </tr>`).join('');
  html += _section('📡 主要來源（Facebook / Google / LINE / Instagram / Direct / Other）',
    _av2TableWrap(`<table>
      <thead><tr style="color:var(--text-secondary);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">來源</th><th style="text-align:right;padding-bottom:8px">Sessions</th>
        <th style="text-align:right;padding-bottom:8px">Orders</th><th style="text-align:right;padding-bottom:8px">Revenue</th>
        <th style="text-align:right;padding-bottom:8px">Conversion</th></tr></thead>
      <tbody>${srcRows}</tbody></table>`) +
      (hasSourceData ? '' : '<div style="color:var(--text-secondary);font-size:.8rem;margin-top:8px">此區間尚無來源資料，以上皆顯示為 0</div>')
  );

  html += _av2RenderTrackingHealthCard();
  return html;
}

// Part 2：Analytics Health（緊湊版，內嵌在 Dashboard 分頁最下方）—— 呼叫既有
// GET /api/analytics/health（見 routes/analytics.js），非同步載入、失敗不影響其餘畫面。
let _av2HealthCache = null;
let _av2HealthCacheChannel = null;
function _av2RenderTrackingHealthCard() {
  const boxId = 'av2-health-box';
  if (!_av2HealthCache || _av2HealthCacheChannel !== av2Channel) {
    const q = av2Channel && av2Channel !== 'all' ? ('?channel=' + encodeURIComponent(av2Channel)) : '';
    apiFetch('/api/analytics/health' + q).then(res => res && res.json()).then(json => {
      if (json && json.success) { _av2HealthCache = json; _av2HealthCacheChannel = av2Channel; _av2RefreshHealthBox(boxId); }
    }).catch(() => {});
  }
  return `<div id="${boxId}">${_av2HealthBoxHtml(_av2HealthCache)}</div>`;
}
function _av2RefreshHealthBox(boxId) {
  const el = document.getElementById(boxId);
  if (el) el.innerHTML = _av2HealthBoxHtml(_av2HealthCache);
}
function _av2HealthBoxHtml(h) {
  if (!h) return _section('🩺 Analytics Tracking Health', '<div style="color:var(--text-secondary);font-size:.8rem">檢查中...</div>');
  const th = h.tracking_health || {};
  const fv = h.funnel_validation || {};
  const statusColor = th.warning ? 'var(--danger)' : (th.is_tracking_active === false ? 'var(--danger)' : 'var(--success)');
  const statusText = th.warning ? th.warning : (th.last_event_at ? '✅ Tracking 運作正常' : 'ℹ️ 尚未收到任何事件');
  const identityText = th.identity_basis
    ? `${escHtml(th.identity_basis_label || th.identity_basis)}${th.identity_is_estimated ? '（估算）' : ''}`
    : '—';
  const channelLabelMap = { all: '全部' };
  AV2_CHANNELS.forEach(([k, l]) => { channelLabelMap[k] = l; });
  const currentFilterText = channelLabelMap[th.current_channel_filter] || th.current_channel_filter || '全部';
  return _section('🩺 Analytics Tracking Health', `
    <div style="font-size:.85rem;color:${statusColor};font-weight:700;margin-bottom:10px">${escHtml(statusText)}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;font-size:.8rem;color:var(--text-secondary)">
      <div>最後事件時間：<b style="color:var(--text-primary)">${escHtml(th.last_event_at || '—')}</b></div>
      <div>近5分鐘事件數：<b style="color:var(--text-primary)">${th.events_last_5_min ?? 0}</b></div>
      <div>今日事件總數：<b style="color:var(--text-primary)">${th.today_event_total ?? 0}</b></div>
      <div>Funnel／訂單一致性：<b style="color:${fv.is_consistent===false?'var(--danger)':'var(--text-primary)'}">${fv.is_consistent===false ? (fv.warning||'⚠ 不一致') : '✅ 一致'}</b></div>
      <div>身份辨識：<b style="color:var(--text-primary)">${identityText}</b></div>
      <div>最近事件渠道：<b style="color:var(--text-primary)">${escHtml(th.last_event_channel_label || '—')}</b></div>
      <div>最近事件頁面：<b style="color:var(--text-primary)">${escHtml(th.last_event_page_type || '—')}</b></div>
      <div>目前渠道篩選：<b style="color:var(--text-primary)">${escHtml(currentFilterText)}</b></div>
    </div>`);
}

// ── ② Product Funnel（依需求文件九：中文化標籤，滿版一列，指標平均分布 Grid）──
// 註：這裡的 View/Add/Checkout/Purchase 沿用 Hotfix23-B 既有設計，本來就是
// 「不重複人數／購物車數」（getProductRanking 內部欄位就叫 view_people／
// cart_people），不是原始事件次數；因此標籤採用「瀏覽人數」而非「瀏覽次數」，
// 避免把人數標成次數，正好符合 Part 8/11「Event 與 User 不得混用」的精神。
function _av2RenderFunnel(v2) {
  const rows = v2.product_funnel || [];
  if (v2.insufficient_data || !rows.length) {
    return _section('🔻 商品漏斗 Product Funnel', _av2Empty('🔻', '尚無漏斗資料',
      '此區間尚無足夠的瀏覽／加入購物車／結帳／付款事件，累積更多流量後即可看到每個商品的轉換漏斗。'));
  }
  const stageBox = (labelZh, labelEn, value) => `<div style="text-align:center">
    <div style="font-size:.72rem;color:var(--text-secondary)">${labelZh}<br><span style="font-size:.62rem;opacity:.7">${labelEn}</span></div>
    <div style="font-size:1.15rem;font-weight:700">${value}</div>
  </div>`;
  const rateChip = (label, value) => `<span style="font-size:.72rem;padding:2px 8px;border-radius:99px;background:rgba(33,150,243,.12);color:var(--info);white-space:nowrap">${label} ${_fmtPct(value)}</span>`;
  const items = rows
    .slice()
    .sort((a,b) => b.view - a.view)
    .map((p, idx) => {
      const detailId = `av2-funnel-detail-${idx}`;
      return `<div class="db-v3-hover analytics-funnel-card" style="background:var(--bg-panel,#1a1a1a);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div style="font-weight:700">${escHtml(p.product_name)}${p.is_delisted ? '　<span style="font-size:.72rem;color:var(--accent)">（已下架）</span>' : ''}</div>
        <button onclick="document.getElementById('${detailId}').style.display=document.getElementById('${detailId}').style.display==='none'?'flex':'none'"
          style="font-size:.75rem;padding:3px 10px;border-radius:99px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;white-space:nowrap">展開詳細數據 ▾</button>
        <button onclick="av2ExplorerApplyProductFilter(${Number(p.product_id)||0}, '${escHtml(p.product_name).replace(/'/g,"\\'")}'); av2ExplorerApplyStageFilter('begin_checkout')"
          title="查看這個商品「開始結帳」階段的購物車明細"
          style="font-size:.75rem;padding:3px 10px;border-radius:99px;border:1px solid var(--border);background:transparent;color:#6366f1;cursor:pointer;white-space:nowrap">🔎 結帳中明細</button>
      </div>
      <div class="analytics-funnel-metrics">
        ${stageBox('瀏覽人數', 'View Users', p.view)}
        ${stageBox('加入購物車人數', 'Cart Users', p.add_to_cart)}
        ${stageBox('結帳購物車數', 'Checkout Carts', p.checkout)}
        ${stageBox('完成訂單人數', 'Orders', p.purchase)}
        <div style="text-align:center">
          <div style="font-size:.72rem;color:var(--text-secondary)">整體轉換率<br><span style="font-size:.62rem;opacity:.7">Overall Conversion</span></div>
          <div style="font-size:1.15rem;font-weight:700;color:var(--success)">${_fmtPct(p.conversion_rate)}</div>
        </div>
      </div>
      <div id="${detailId}" style="display:none;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        ${rateChip('瀏覽→加購', p.view_to_add_rate)}
        ${rateChip('加購→結帳', p.add_to_checkout_rate)}
        ${rateChip('結帳→成交', p.checkout_to_purchase_rate)}
        <span style="font-size:.72rem;padding:2px 8px;border-radius:99px;background:rgba(76,175,80,.12);color:var(--success);white-space:nowrap">營收 ${_nt(p.revenue)}</span>
      </div>
    </div>`;
    }).join('');
  return _section('🔻 商品漏斗 Product Funnel（瀏覽 → 加入購物車 → 結帳 → 成交）', items);
}

// ── ③ 購物車放棄分析（獨立頁籤）──────────────────────────────────────
// fix18-10-hotfix31-R3：KPI 卡片與 Top Abandon Products 改為可點擊的 Drill Down
// 觸發點，並在下方新增 Cart Detail Explorer（篩選列／明細表／Session 時間軸／
// 訪客360／受眾選取工具列）。KPI 數字本身的計算方式完全不變（仍是既有
// getCartAbandonmentByProduct(funnel) 的加總），Drill Down 查詢一律呼叫既有
// R2 的 GET /api/analytics/drilldown，不創造第二套「放棄」定義。
function _av2RenderCartAbandonment(v2) {
  const abandon = v2.cart_abandonment || { rows: [], top_abandon_products: [] };
  const rows = abandon.rows || [];
  if (v2.insufficient_data || !rows.length) {
    return _section('🛒 購物車放棄分析', _av2Empty('🛒', '尚無購物車事件資料',
      '此區間尚無加入購物車紀錄。當有顧客加入購物車後，這裡會顯示放棄率與估計放棄金額。'));
  }
  const totalAdd = rows.reduce((s,r) => s + r.add_to_cart, 0);
  const totalPurchase = rows.reduce((s,r) => s + r.purchase, 0);
  const totalAbandon = rows.reduce((s,r) => s + r.abandon, 0);
  const totalEstAmount = rows.reduce((s,r) => s + (r.estimated_abandoned_amount||0), 0);
  const overallRate = totalAdd > 0 ? _pct(totalAbandon, totalAdd) : '—';

  // 需求文件 D：每張 KPI 卡片可點擊，套用對應的 Drill Down 篩選；再點一次
  // 目前啟用中的 KPI 會清除該篩選（見 av2ExplorerApplyKpiFilter）。
  const kpiActive = av2ExplorerState.activeKpi;
  const kpiBtn = (kind, label, value, sub, color) => {
    const isActive = kpiActive === kind;
    return `<div onclick="av2ExplorerApplyKpiFilter('${kind}')" title="點擊查看這個數字背後的訪客/購物車明細"
      style="cursor:pointer;background:var(--bg-card,#1a1d27);border:2px solid ${isActive?'var(--accent,#6366f1)':'var(--border,#2a2d3e)'};border-radius:12px;padding:16px 20px;min-width:140px;transition:border-color .15s">
      <div style="font-size:.72rem;color:var(--text-secondary,#64748b);margin-bottom:4px">${escHtml(label)}${isActive?' 🔎':''}</div>
      <div style="font-size:1.3rem;font-weight:700;color:${color||'var(--text-primary)'}">${value}</div>
      ${sub ? `<div style="font-size:.68rem;color:var(--text-secondary,#64748b);margin-top:2px">${escHtml(sub)}</div>` : ''}
    </div>`;
  };

  let html = `<div class="analytics-kpi-grid">
    ${kpiBtn('add_to_cart', '加入購物車數', totalAdd + ' 人', '', '')}
    ${kpiBtn('purchase', '成交數', totalPurchase + ' 人', '', '#10b981')}
    ${kpiBtn('abandoned', '放棄數', totalAbandon + ' 人', '', '#f59e0b')}
    ${kpiBtn('abandon_rate', '放棄率', overallRate, '', '#ef4444')}
    ${kpiBtn('abandoned_amount', '估計放棄金額', _nt(totalEstAmount), '⚠️ 估計值，非實際購物車金額快照', '#ef4444')}
  </div>`;
  if (kpiActive) {
    html += `<div style="margin:-10px 0 16px"><button onclick="av2ExplorerClearKpiFilter()" style="font-size:.75rem;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer">✕ 清除 KPI 篩選</button></div>`;
  }

  html += `<div class="analytics-card" style="margin-bottom:20px;border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.06)">
    <div style="font-size:.75rem;color:var(--text-secondary);line-height:1.6">
      ⚠️ 統計限制：加入購物車以 cart_id 為單位（非 session／會員身分），同一顧客若中途更換裝置或清除瀏覽器資料可能被視為不同購物車；
      放棄金額為「放棄人數 × 目前商品售價」的<b style="color:var(--text-primary)">估計值</b>，非結帳當下的實際金額快照，商品改價／下架後會與實際情況有落差。
      下方「購物車明細分析」的數字為<b style="color:var(--text-primary)">另一個統計口徑</b>（即時逐筆購物車），兩者單位不同時會清楚標示（例如「N 位訪客」vs「M 個購物車」），不會混用同一個數字。
    </div>
  </div>`;

  const top = abandon.top_abandon_products || [];
  const topRows = top.map(p => `<tr onclick="av2ExplorerApplyProductFilter(${Number(p.product_id)||0}, '${escHtml(p.product_name).replace(/'/g,"\\'")}')" style="cursor:pointer" title="點擊查看這個商品相關的購物車明細">
    <td style="padding:6px 0">${escHtml(p.product_name)}</td>
    <td style="padding:6px 0;text-align:right">${p.add_to_cart}</td>
    <td style="padding:6px 0;text-align:right">${p.purchase}</td>
    <td style="padding:6px 0;text-align:right;color:#f59e0b">${p.abandon}</td>
    <td style="padding:6px 0;text-align:right;color:var(--danger)">${_fmtPct(p.abandon_rate)}</td>
    <td style="padding:6px 0;text-align:right;color:var(--danger)">${_nt(p.estimated_abandoned_amount)}<span style="font-size:.68rem;color:var(--text-secondary)">（估計值）</span></td>
  </tr>`).join('');
  html += _section('🏆 Top Abandon Products（點擊商品可篩選明細表）', topRows ? _av2TableWrap(`<table>
    <thead><tr style="color:var(--text-secondary);font-size:.75rem">
      <th style="text-align:left;padding-bottom:8px">商品</th><th style="text-align:right;padding-bottom:8px">Add</th>
      <th style="text-align:right;padding-bottom:8px">Purchase</th><th style="text-align:right;padding-bottom:8px">Abandon</th>
      <th style="text-align:right;padding-bottom:8px">Abandon Rate</th><th style="text-align:right;padding-bottom:8px">估計放棄金額</th></tr></thead>
    <tbody>${topRows}</tbody></table>`) : _av2Empty('🏆', '此區間尚無資料', '尚無足夠的放棄購物車樣本可以排行。')
  );

  // ── fix18-10-hotfix31-R3：Cart Detail Explorer（獨立於上方 funnel 統計口徑，
  //    即時查詢 GET /api/analytics/drilldown，非另一套資料）──────────────────
  html += `<div id="av2-explorer-root">${_av2ExplorerSkeleton()}</div>`;
  // 頁籤剛渲染完成後才有 DOM 可以掛載，用 setTimeout(0) 讓 innerHTML 先生效
  setTimeout(() => av2ExplorerFetch(), 0);
  return html;
}

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix31-R3｜Cart Detail Explorer（Operation Analytics 專用，
// 完全獨立於 Boss Dashboard 既有的「目前未完成購物車」表格，資料來源與畫面
// 都不共用）。以下全部呼叫既有 R2 API：
//   GET  /api/analytics/drilldown          — 明細表 + 分頁
//   GET  /api/analytics/cart-abandonment/:cartId — 單一購物車詳情 + 時間軸
//   GET  /api/analytics/visitor/:key       — 訪客 360（key 用 cart_id 即可，
//        後端 resolveCanonicalVisitor 會自動解析回正確身份，前端不需要拿到
//        任何原始 visitor_id/line_user_id）
//   POST /api/crm/segments                 — 建立分群（動態/靜態）
// ══════════════════════════════════════════════════════════════════

const AV2_EXPLORER_SORT_FIELDS = [
  ['last_activity_at', '最後活動時間'],
  ['first_added_at', '加入時間'],
  ['total', '購物車金額'],
  ['age_seconds', '未活動時間'],
];
const AV2_EXPLORER_CART_STATUS = [
  ['', '全部'], ['active', '活躍中'], ['checkout', '結帳中'], ['abandoned', '可能已放棄'], ['purchased', '已完成購買'],
];
const AV2_EXPLORER_ORDER_MODE = [['', '全部'], ['takeout', '外帶'], ['delivery', '外送'], ['shipping', '宅配']];
const AV2_EXPLORER_IDENTITY = [['', '全部'], ['line', 'LINE會員'], ['visitor', '匿名訪客']];
const AV2_EXPLORER_FRIEND = [['', '全部'], ['friend', '好友'], ['not_friend', '非好友'], ['unknown', '未知']];
const AV2_EXPLORER_AGE_BUCKET = [
  ['', '全部'], ['30m', '30分鐘內'], ['30m_1h', '30分鐘~1小時'], ['1h_24h', '1~24小時'],
  ['1d_3d', '1~3天'], ['3d_7d', '3~7天'], ['7d_plus', '7天以上'],
];
const AV2_EXPLORER_EVENT = [
  ['', '全部'], ['add_to_cart', '加入購物車'], ['begin_checkout', '開始結帳'],
  ['payment_started', '開始付款'], ['purchase', '完成購買'], ['line_login_success', 'LINE登入成功'],
];
const AV2_STATUS_BADGE = {
  active:    { label: '活躍中',     color: '#10b981', tip: '活躍中：最近仍有事件' },
  checkout:  { label: '結帳中',     color: '#6366f1', tip: '結帳中：最後一筆事件屬於結帳流程' },
  abandoned: { label: '可能已放棄', color: '#f59e0b', tip: '可能已放棄：超過設定時間沒有活動' },
  purchased: { label: '已完成購買', color: '#10b981', tip: '已完成購買：已有可關聯的 purchase/order' },
};

let av2ExplorerState = {
  filters: {},        // 送往後端的篩選物件（白名單鍵值，見 utils/drilldown.js）
  page: 1,
  limit: 20,
  sort_by: undefined,
  sort_dir: undefined,
  activeKpi: null,    // 目前啟用中的 KPI 篩選（供 KPI 卡片 active 樣式判斷）
};
let _av2ExplorerLastResult = null;
let _av2ExplorerReqSeq = 0;       // 防止「篩選快速切換」時舊回應蓋掉新回應
let _av2ExplorerSelected = new Map(); // member_key → {member_key, member_type, display_name}
let _av2ExplorerProductOptions = null; // 快取商品清單（name/id），只抓一次

function _av2ExplorerSkeleton() {
  return `
    <div id="av2-explorer-filterbar"></div>
    <div id="av2-explorer-chips" style="margin:8px 0"></div>
    <div id="av2-explorer-toolbar"></div>
    <div id="av2-explorer-table">${_av2Empty('⏳', '載入中...', '正在查詢符合條件的購物車明細。')}</div>
    <div id="av2-explorer-pagination"></div>
    <div id="av2-explorer-drawer"></div>`;
}

// ── 日期區間：直接沿用頁面頂端已經套用的日期篩選（_av2LastData.range），
//    不另外做第二套日期解析邏輯，確保跟其他頁籤的統計口徑一致 ─────────────
function _av2ExplorerDateParams() {
  const range = (_av2LastData && _av2LastData.range) || {};
  if (!range.start_date || !range.end_date) return {};
  return { date_from: range.start_date + ' 00:00:00', date_to: range.end_date + ' 23:59:59' };
}

// ── KPI 卡片點擊（需求文件 D）─────────────────────────────────────────
function av2ExplorerApplyKpiFilter(kind) {
  if (av2ExplorerState.activeKpi === kind) { av2ExplorerClearKpiFilter(); return; }
  av2ExplorerState.activeKpi = kind;
  const f = {};
  av2ExplorerState.sort_by = undefined; av2ExplorerState.sort_dir = undefined;
  if (kind === 'add_to_cart') { f.event_name = 'add_to_cart'; }
  else if (kind === 'purchase') { f.cart_status = 'purchased'; }
  else if (kind === 'abandoned' || kind === 'abandon_rate') { f.cart_status = 'abandoned'; }
  else if (kind === 'abandoned_amount') { f.cart_status = 'abandoned'; av2ExplorerState.sort_by = 'total'; av2ExplorerState.sort_dir = 'desc'; }
  av2ExplorerState.filters = f;
  av2ExplorerState.page = 1;
  av2Render(_av2LastData); // 重繪整個 cart_abandonment 分頁（KPI active 樣式也要更新）
}
function av2ExplorerClearKpiFilter() {
  av2ExplorerState.activeKpi = null;
  av2ExplorerState.filters = {};
  av2ExplorerState.sort_by = undefined; av2ExplorerState.sort_dir = undefined;
  av2ExplorerState.page = 1;
  av2Render(_av2LastData);
}
// Top Abandon Products 商品列點擊 → 套用商品篩選（需求文件 K）
function av2ExplorerApplyProductFilter(productId, productName) {
  if (!productId) { showToast('這個商品沒有可篩選的 ID', 'error'); return; }
  av2ExplorerState.filters = Object.assign({}, av2ExplorerState.filters, { product_id: productId });
  av2ExplorerState._productLabel = productName;
  av2ExplorerState.page = 1;
  _av2ExplorerRenderFilterBar();
  _av2ExplorerRenderChips();
  av2ExplorerFetch();
}

// ── 篩選列（需求文件 E）───────────────────────────────────────────────
function _av2ExplorerRenderFilterBar() {
  const el = document.getElementById('av2-explorer-filterbar');
  if (!el) return;
  const f = av2ExplorerState.filters;
  const sel = (opts, val, onchange) => `<select onchange="${onchange}" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.78rem">
    ${opts.map(([v,l]) => `<option value="${escHtml(v)}" ${val===v?'selected':''}>${escHtml(l)}</option>`).join('')}</select>`;

  el.innerHTML = `<div class="analytics-card" style="margin-bottom:10px">
    <div style="font-weight:700;font-size:.85rem;margin-bottom:10px">🔍 購物車明細分析｜篩選條件</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:.78rem">
      <span style="color:var(--text-secondary)">漏斗階段</span>${sel(AV2_EXPLORER_EVENT, f.event_name||'', `av2ExplorerSetFilter('event_name', this.value)`)}
      <span style="color:var(--text-secondary)">購物車狀態</span>${sel(AV2_EXPLORER_CART_STATUS, f.cart_status||'', `av2ExplorerSetFilter('cart_status', this.value)`)}
      <span style="color:var(--text-secondary)">來源</span><input type="text" value="${escHtml(f.source||'')}" placeholder="例：Facebook" oninput="av2ExplorerDebounceFilter('source', this.value)" style="width:100px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.78rem">
      <span style="color:var(--text-secondary)">Campaign</span><input type="text" value="${escHtml(f.campaign||'')}" placeholder="活動名稱" oninput="av2ExplorerDebounceFilter('campaign', this.value)" style="width:110px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.78rem">
      <span style="color:var(--text-secondary)">模式</span>${sel(AV2_EXPLORER_ORDER_MODE, f.order_mode||'', `av2ExplorerSetFilter('order_mode', this.value)`)}
      <span style="color:var(--text-secondary)">身份</span>${sel(AV2_EXPLORER_IDENTITY, f.identity_state||'', `av2ExplorerSetFilter('identity_state', this.value)`)}
      <span style="color:var(--text-secondary)">LINE好友狀態</span>${sel(AV2_EXPLORER_FRIEND, f.friend_status||'', `av2ExplorerSetFilter('friend_status', this.value)`)}
      <span style="color:var(--text-secondary)">未活動時間</span>${sel(AV2_EXPLORER_AGE_BUCKET, f.age_bucket||'', `av2ExplorerSetFilter('age_bucket', this.value)`)}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:.78rem;margin-top:8px">
      <span style="color:var(--text-secondary)">最低金額</span><input type="number" min="0" value="${f.min_amount!==undefined?f.min_amount:''}" oninput="av2ExplorerDebounceFilter('min_amount', this.value)" style="width:80px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.78rem">
      <span style="color:var(--text-secondary)">最高金額</span><input type="number" min="0" value="${f.max_amount!==undefined?f.max_amount:''}" oninput="av2ExplorerDebounceFilter('max_amount', this.value)" style="width:80px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);font-size:.78rem">
      <span style="color:var(--text-secondary)">排序方式</span>${sel(AV2_EXPLORER_SORT_FIELDS, av2ExplorerState.sort_by||'last_activity_at', `av2ExplorerSetSort(this.value, av2ExplorerState.sort_dir)`)}
      <span style="color:var(--text-secondary)">排序方向</span>${sel([['desc','由高到低'],['asc','由低到高']], av2ExplorerState.sort_dir||'desc', `av2ExplorerSetSort(av2ExplorerState.sort_by, this.value)`)}
      <button onclick="av2ExplorerFetch()" style="padding:6px 14px;border-radius:8px;background:var(--accent);border:none;color:#111;font-weight:700;cursor:pointer;font-size:.78rem">套用篩選</button>
      <button onclick="av2ExplorerClearAllFilters()" style="padding:6px 14px;border-radius:8px;background:transparent;border:1px solid var(--border);color:var(--text-secondary);cursor:pointer;font-size:.78rem">清除篩選</button>
      <button onclick="av2ExplorerFetch()" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.78rem">🔄 重新整理</button>
    </div>
  </div>`;
}
let _av2ExplorerDebounceTimer = null;
function av2ExplorerDebounceFilter(key, val) {
  clearTimeout(_av2ExplorerDebounceTimer);
  _av2ExplorerDebounceTimer = setTimeout(() => av2ExplorerSetFilter(key, val, { skipRerenderBar: true }), 450);
}
function av2ExplorerSetFilter(key, val, opts) {
  opts = opts || {};
  const f = Object.assign({}, av2ExplorerState.filters);
  if (key === 'min_amount' || key === 'max_amount') {
    // fix31-r3：金額欄位需要額外驗證——非數字或負數一律不套用、不送出請求；
    // 最低金額不得高於最高金額（反之亦然），避免送出一個保證查不到資料的
    // 錯誤篩選組合給後端。
    if (val === '' || val === null || val === undefined) {
      delete f[key];
    } else {
      const num = Number(val);
      if (!Number.isFinite(num) || num < 0) {
        if (typeof showToast === 'function') showToast('請輸入有效的金額數字', 'error');
        return;
      }
      const other = key === 'min_amount' ? f.max_amount : f.min_amount;
      if (key === 'min_amount' && other !== undefined && num > other) {
        if (typeof showToast === 'function') showToast('最低金額不得高於最高金額', 'error');
        return;
      }
      if (key === 'max_amount' && other !== undefined && num < other) {
        if (typeof showToast === 'function') showToast('最高金額不得低於最低金額', 'error');
        return;
      }
      f[key] = num;
    }
  } else if (val === '' || val === null || val === undefined) {
    delete f[key];
  } else {
    f[key] = val;
  }
  av2ExplorerState.filters = f;
  av2ExplorerState.page = 1;
  av2ExplorerState.activeKpi = null; // 手動改篩選條件視為離開 KPI 快篩狀態
  if (!opts.skipRerenderBar) _av2ExplorerRenderFilterBar();
  _av2ExplorerRenderChips();
  av2ExplorerFetch();
}
function av2ExplorerSetSort(sortBy, sortDir) {
  // 前端也做一層白名單保護：非允許值一律退回預設，即使理論上使用者無法從
  // <select> 選出非法值，仍防止未來擴充時不小心從別處帶入壞值。
  const allowed = AV2_EXPLORER_SORT_FIELDS.map(x => x[0]);
  av2ExplorerState.sort_by = allowed.includes(sortBy) ? sortBy : 'last_activity_at';
  av2ExplorerState.sort_dir = (sortDir === 'asc') ? 'asc' : 'desc';
  av2ExplorerFetch();
}
function av2ExplorerClearAllFilters() {
  av2ExplorerState.filters = {};
  av2ExplorerState.activeKpi = null;
  av2ExplorerState.sort_by = undefined;
  av2ExplorerState.sort_dir = undefined;
  av2ExplorerState.page = 1;
  _av2ExplorerRenderFilterBar();
  _av2ExplorerRenderChips();
  av2ExplorerFetch();
}

// ── 篩選 Chips（需求文件 K：所有生效中的篩選都要能單獨移除）──────────────
const AV2_FILTER_LABELS = {
  event_name: '事件', cart_status: '狀態', source: '來源', campaign: 'Campaign',
  order_mode: '模式', identity_state: '身份', friend_status: 'LINE好友', age_bucket: '未活動時間',
  product_id: '商品', min_amount: '最低金額', max_amount: '最高金額',
};
function _av2ExplorerFilterValueLabel(key, value) {
  const mapSource = {
    cart_status: AV2_EXPLORER_CART_STATUS, order_mode: AV2_EXPLORER_ORDER_MODE,
    identity_state: AV2_EXPLORER_IDENTITY, friend_status: AV2_EXPLORER_FRIEND,
    age_bucket: AV2_EXPLORER_AGE_BUCKET, event_name: AV2_EXPLORER_EVENT,
  }[key];
  if (mapSource) {
    const found = mapSource.find(([v]) => v === value);
    if (found) return found[1];
  }
  return value;
}
function _av2ExplorerRenderChips() {
  const el = document.getElementById('av2-explorer-chips');
  if (!el) return;
  const f = av2ExplorerState.filters;
  const keys = Object.keys(f);
  if (!keys.length) { el.innerHTML = ''; return; }
  const chip = (key) => {
    let valueLabel = _av2ExplorerFilterValueLabel(key, f[key]);
    if (key === 'product_id' && av2ExplorerState._productLabel) valueLabel = av2ExplorerState._productLabel;
    return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-card);border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:.75rem;margin-right:6px;margin-bottom:6px">
      ${escHtml(AV2_FILTER_LABELS[key]||key)}：${escHtml(String(valueLabel))}
      <span onclick="av2ExplorerRemoveFilter('${key}')" style="cursor:pointer;color:var(--text-secondary);font-weight:700">✕</span>
    </span>`;
  };
  el.innerHTML = keys.map(chip).join('') + `<button onclick="av2ExplorerClearAllFilters()" style="font-size:.75rem;padding:4px 10px;border-radius:20px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer">清除全部</button>`;
}
function av2ExplorerRemoveFilter(key) {
  const f = Object.assign({}, av2ExplorerState.filters);
  delete f[key];
  if (key === 'product_id') av2ExplorerState._productLabel = null;
  av2ExplorerState.filters = f;
  av2ExplorerState.page = 1;
  _av2ExplorerRenderFilterBar();
  _av2ExplorerRenderChips();
  av2ExplorerFetch();
}
// Sources/Products 等其他頁籤的互動入口（需求文件 K：點 Facebook／開始結帳／外送）
function av2ExplorerApplySourceFilter(source) { av2SwitchTab('cart_abandonment'); setTimeout(() => av2ExplorerSetFilter('source', source), 0); }
function av2ExplorerApplyStageFilter(eventName) { av2SwitchTab('cart_abandonment'); setTimeout(() => av2ExplorerSetFilter('event_name', eventName), 0); }
function av2ExplorerApplyModeFilter(mode) { av2SwitchTab('cart_abandonment'); setTimeout(() => av2ExplorerSetFilter('order_mode', mode), 0); }

// ── 抓取資料（需求文件 L：分頁／防止過期回應覆蓋、去抖動已在篩選輸入處理）──
async function av2ExplorerFetch() {
  _av2ExplorerRenderFilterBar();
  _av2ExplorerRenderChips();
  const seq = ++_av2ExplorerReqSeq;
  const tableEl = document.getElementById('av2-explorer-table');
  if (tableEl) tableEl.innerHTML = `<div style="color:var(--text-secondary);padding:20px;font-size:.85rem">載入中...</div>`;

  const params = new URLSearchParams();
  Object.assign(params, {});
  const dateParams = _av2ExplorerDateParams();
  const allParams = Object.assign({}, dateParams, av2ExplorerState.filters, {
    page: av2ExplorerState.page, limit: av2ExplorerState.limit,
  });
  if (av2ExplorerState.sort_by) allParams.sort_by = av2ExplorerState.sort_by;
  if (av2ExplorerState.sort_dir) allParams.sort_dir = av2ExplorerState.sort_dir;
  if (av2Channel && av2Channel !== 'all') {
    // 沿用頁面頂端既有的渠道篩選 → order_channel 維度（不是另一套渠道邏輯）
    const channelMap = { pos: 'pos', line_takeout: 'takeout', line_delivery: 'delivery', shipping: 'shipping', reservation: 'reservation' };
    if (channelMap[av2Channel]) allParams.order_channel = channelMap[av2Channel];
  }
  const qs = new URLSearchParams(Object.entries(allParams).filter(([,v]) => v !== undefined && v !== null && v !== '')).toString();

  try {
    const res = await apiFetch('/api/analytics/drilldown?' + qs);
    if (seq !== _av2ExplorerReqSeq) return; // 已經有更新的請求送出，這個回應過期，丟棄
    if (!res || !res.ok) { _av2ExplorerRenderError('資料載入失敗，請稍後重試。'); return; }
    const json = await res.json();
    if (seq !== _av2ExplorerReqSeq) return;
    if (!json.success) { _av2ExplorerRenderError(json.message || '資料載入失敗，請稍後重試。'); return; }
    _av2ExplorerLastResult = json;
    _av2ExplorerRenderTable(json);
    _av2ExplorerRenderPagination(json);
    _av2ExplorerRenderToolbar();
  } catch (e) {
    if (seq !== _av2ExplorerReqSeq) return;
    _av2ExplorerRenderError('資料載入失敗，請稍後重試。');
  }
}
function _av2ExplorerRenderError(msg) {
  const el = document.getElementById('av2-explorer-table');
  if (el) el.innerHTML = `<div class="analytics-empty-state">
    <div class="analytics-empty-icon">❌</div><h3 style="color:var(--danger)">資料載入失敗</h3>
    <p>${escHtml(msg)}</p>
    <div style="margin-top:10px"><button onclick="av2ExplorerFetch()" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.8rem">重試</button></div>
  </div>`;
}

// ── 明細表（需求文件 F/G）────────────────────────────────────────────
const AV2_ORDER_MODE_LABEL = { takeout: '外帶', delivery: '外送', shipping: '宅配', unknown: '—' };
function _av2ExplorerItemsSummary(items) {
  if (!items || !items.length) return '—';
  return items.map(i => `${i.name}${i.variant ? `(${i.variant})` : ''}×${i.qty}`).join('、');
}
function _av2ExplorerIdentityCell(r) {
  if (r.identity_type === 'line') {
    return `${escHtml(r.display_name || 'LINE會員')}<br><span style="font-size:10px;color:var(--text-secondary)">${escHtml(r.line_uid_masked||'')}</span>`;
  }
  return `訪客<br><span style="font-size:10px;color:var(--text-secondary);font-family:monospace">${escHtml(r.visitor_id_short||'')}</span>`;
}
function _av2ExplorerRenderTable(json) {
  const el = document.getElementById('av2-explorer-table');
  if (!el) return;
  const rows = json.rows || [];
  const warnings = json.warnings || [];
  let banner = `<div style="font-size:.72rem;color:var(--text-secondary);margin-bottom:8px">
    📅 資料更新時間：${escHtml(new Date(json.generated_at||Date.now()).toLocaleString('zh-TW'))}　·　
    共 <b style="color:var(--text-primary)">${json.total ?? 0}</b> 個購物車　·　
    <b style="color:var(--text-primary)">${json.visitor_count ?? 0}</b> 位訪客涉及此篩選條件（人／購物車為不同統計單位，人數可能少於或多於購物車數）
  </div>`;
  if (warnings.length) {
    banner += warnings.map(w => `<div style="font-size:.72rem;color:#f59e0b;margin-bottom:6px">⚠️ ${escHtml(w)}</div>`).join('');
  }
  if (!rows.length) {
    el.innerHTML = banner + _av2Empty('🛒', '沒有符合條件的資料', '目前篩選條件下沒有符合的購物車資料。');
    return;
  }
  const trs = rows.map(r => {
    const badge = AV2_STATUS_BADGE[r.status] || { label: r.status, color: 'var(--text-secondary)', tip: '' };
    const checked = _av2ExplorerSelected.has(_av2ExplorerMemberKeyOf(r)) ? 'checked' : '';
    return `<tr>
      <td style="padding:6px 8px"><input type="checkbox" ${checked} onchange="av2ExplorerToggleRow('${escHtml(r.cart_id)}', this.checked)"></td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${_av2ExplorerIdentityCell(r)}</td>
      <td style="padding:6px 8px;font-size:11px;white-space:nowrap;color:var(--text-secondary)">${r.identity_type==='line'?'LINE會員':'匿名訪客'}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis">${escHtml(r.source||'Direct')}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap;max-width:100px;overflow:hidden;text-overflow:ellipsis">${escHtml(r.campaign||'—')}</td>
      <td style="padding:6px 8px;font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(_av2ExplorerItemsSummary(r.items))}">${escHtml(_av2ExplorerItemsSummary(r.items))}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${AV2_ORDER_MODE_LABEL[r.order_mode]||'—'}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${_nt(r.total)}${r.estimated?'<span style="font-size:9px;color:#f59e0b" title="舊資料估計值，非實際快照">估</span>':''}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${escHtml(r.last_stage||'—')}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${escHtml(r.last_activity_at||'—')}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap">${escHtml(r.age_label||'—')}</td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap"><span title="${escHtml(badge.tip)}" style="background:${badge.color}22;color:${badge.color};padding:2px 8px;border-radius:12px;font-weight:600;font-size:11px">${escHtml(badge.label)}</span></td>
      <td style="padding:6px 8px;font-size:12px;white-space:nowrap"><button onclick="av2ExplorerOpenDetail('${escHtml(r.cart_id)}')" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:#6366f1;cursor:pointer">查看詳情</button></td>
    </tr>`;
  }).join('');
  el.innerHTML = banner + `<div style="overflow-x:auto"><table style="width:100%;min-width:920px;border-collapse:collapse;font-size:.8rem">
    <thead><tr style="color:var(--text-secondary);font-size:.7rem;text-align:left">
      <th style="padding:6px 8px"><input type="checkbox" onchange="av2ExplorerToggleAll(this.checked)"></th>
      <th style="padding:6px 8px">訪客／會員</th><th style="padding:6px 8px">身份狀態</th><th style="padding:6px 8px">來源</th>
      <th style="padding:6px 8px">Campaign</th><th style="padding:6px 8px">商品摘要</th><th style="padding:6px 8px">模式</th>
      <th style="padding:6px 8px">購物車金額</th><th style="padding:6px 8px">最後階段</th><th style="padding:6px 8px">最後活動時間</th>
      <th style="padding:6px 8px">未活動時間</th><th style="padding:6px 8px">目前狀態</th><th style="padding:6px 8px">操作</th>
    </tr></thead><tbody>${trs}</tbody></table></div>`;
}
function _av2ExplorerMemberKeyOf(r) { return r.cart_id; } // 用 cart_id 當前端內部選取鍵（見上方模組說明：cart_id 本身即可反查身份）

function _av2ExplorerRenderPagination(json) {
  const el = document.getElementById('av2-explorer-pagination');
  if (!el) return;
  const totalPages = json.total_pages || 1;
  const page = json.page || 1;
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin:10px 0;font-size:.78rem;color:var(--text-secondary)">
    <button ${page<=1?'disabled':''} onclick="av2ExplorerSetPage(${page-1})" style="padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:${page<=1?'var(--text-secondary)':'var(--text-primary)'};cursor:${page<=1?'default':'pointer'}">‹ 上一頁</button>
    <span>第 ${page} / ${totalPages} 頁　共 ${json.total||0} 筆</span>
    <button ${page>=totalPages?'disabled':''} onclick="av2ExplorerSetPage(${page+1})" style="padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:${page>=totalPages?'var(--text-secondary)':'var(--text-primary)'};cursor:${page>=totalPages?'default':'pointer'}">下一頁 ›</button>
    <span style="margin-left:10px">每頁：</span>
    ${[20,50,100].map(n => `<button onclick="av2ExplorerSetLimit(${n})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:${av2ExplorerState.limit===n?'var(--accent)':'transparent'};color:${av2ExplorerState.limit===n?'#111':'var(--text-secondary)'};cursor:pointer;font-weight:${av2ExplorerState.limit===n?'700':'400'}">${n}</button>`).join('')}
  </div>`;
}
function av2ExplorerSetPage(p) { if (p < 1) return; av2ExplorerState.page = p; av2ExplorerFetch(); }
function av2ExplorerSetLimit(n) { av2ExplorerState.limit = n; av2ExplorerState.page = 1; av2ExplorerFetch(); }

// ── 選取工具列與受眾準備（需求文件 M：本輪只做準備動作，不送任何 LINE/優惠券）──
function av2ExplorerToggleRow(cartId, checked) {
  const rows = (_av2ExplorerLastResult && _av2ExplorerLastResult.rows) || [];
  const row = rows.find(r => r.cart_id === cartId);
  if (!row) return;
  if (checked) {
    _av2ExplorerSelected.set(cartId, {
      member_key: cartId, // 前端只知道 cart_id；後端 resolveMemberKeys／resolveCanonicalVisitor 會自行解析正確身份
      member_type: row.identity_type === 'line' ? 'line_user_id' : 'visitor_id',
      display_name: row.display_name || null,
      _isAnonymous: row.identity_type !== 'line',
    });
  } else {
    _av2ExplorerSelected.delete(cartId);
  }
  _av2ExplorerRenderToolbar();
}
function av2ExplorerToggleAll(checked) {
  const rows = (_av2ExplorerLastResult && _av2ExplorerLastResult.rows) || [];
  rows.forEach(r => av2ExplorerToggleRow(r.cart_id, checked));
  if (_av2ExplorerLastResult) _av2ExplorerRenderTable(_av2ExplorerLastResult);
  _av2ExplorerRenderToolbar();
}
function av2ExplorerClearSelection() {
  _av2ExplorerSelected.clear();
  if (_av2ExplorerLastResult) _av2ExplorerRenderTable(_av2ExplorerLastResult);
  _av2ExplorerRenderToolbar();
}
function _av2ExplorerRenderToolbar() {
  const el = document.getElementById('av2-explorer-toolbar');
  if (!el) return;
  const n = _av2ExplorerSelected.size;
  const anonCount = [..._av2ExplorerSelected.values()].filter(m => m._isAnonymous).length;
  el.innerHTML = `<div class="analytics-card" style="margin:10px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
    <span style="font-size:.8rem;font-weight:700">已選取 ${n} 人${anonCount ? `（其中 ${anonCount} 位為匿名訪客，適用性依動作類型而定）` : ''}</span>
    <button onclick="av2ExplorerPreviewAudience()" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-primary);cursor:pointer;font-size:.78rem">👁️ 預覽受眾</button>
    <button onclick="av2ExplorerOpenSegmentModal('dynamic')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-primary);cursor:pointer;font-size:.78rem">建立動態分群（依目前篩選）</button>
    <button ${n?'':'disabled'} onclick="av2ExplorerOpenSegmentModal('static')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:${n?'var(--text-primary)':'var(--text-secondary)'};cursor:${n?'pointer':'not-allowed'};font-size:.78rem">建立靜態分群（僅已選取 ${n} 人）</button>
    <button onclick="av2ExplorerClearSelection()" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:.78rem">清除選取</button>
    <button id="av2-goto-crm-btn" onclick="av2ExplorerGotoCrmActionCenter()" ${(_av2ExplorerLastSegment||n)?'':'disabled'}
      title="${(_av2ExplorerLastSegment||n)?'':'請先選取受眾或建立分群'}"
      style="padding:6px 12px;border-radius:8px;background:${(_av2ExplorerLastSegment||n)?'var(--accent)':'var(--border)'};border:none;color:${(_av2ExplorerLastSegment||n)?'#111':'var(--text-secondary)'};cursor:${(_av2ExplorerLastSegment||n)?'pointer':'not-allowed'};font-size:.78rem;font-weight:700">前往 CRM Action Center →</button>
  </div>`;
}
function av2ExplorerPreviewAudience() {
  const n = _av2ExplorerSelected.size;
  const total = (_av2ExplorerLastResult && _av2ExplorerLastResult.total) || 0;
  showToast(n ? `已選取 ${n} 人作為受眾預覽` : `目前篩選條件符合 ${total} 個購物車（尚未個別選取，建立動態分群將涵蓋符合條件的全部對象）`, 'info');
}

// ── 建立分群（需求文件 M）：dynamic 送出目前篩選定義；static 送出明確選取的
//    member_keys 清單（見 routes/crm.js 的 member_keys 支援）───────────────
let _av2ExplorerLastSegment = null;
function av2ExplorerOpenSegmentModal(type) {
  const name = prompt(type === 'static' ? '請輸入靜態分群名稱（將凍結目前選取的名單）：' : '請輸入動態分群名稱（人數會隨資料變動即時更新）：', '');
  if (name === null) return; // 使用者取消
  if (!name.trim()) { showToast('請輸入分群名稱', 'error'); return; }
  const description = prompt('選填：分群描述') || '';
  av2ExplorerCreateSegment(type, name.trim(), description);
}
async function av2ExplorerCreateSegment(type, name, description) {
  const body = { name, description, segment_type: type, filter: av2ExplorerState.filters };
  if (type === 'static') {
    const members = [..._av2ExplorerSelected.values()].map(m => ({ member_key: m.member_key, member_type: m.member_type, display_name: m.display_name }));
    if (!members.length) { showToast('請先選取至少一位對象再建立靜態分群', 'error'); return; }
    body.member_keys = members;
  }
  try {
    const res = await apiFetch('/api/crm/segments', { method: 'POST', body: JSON.stringify(body) });
    const json = await res.json();
    if (!json.success) { showToast('建立分群失敗：' + (json.message || '未知錯誤'), 'error'); return; }
    _av2ExplorerLastSegment = { id: json.id, name, type, member_count: json.member_count };
    showToast(`✅ 已建立${type==='static'?'靜態':'動態'}分群「${name}」（${json.member_count} 人）`, 'success');
    _av2ExplorerRenderToolbar();
  } catch (e) {
    showToast('建立分群失敗，請稍後重試。', 'error');
  }
}
function av2ExplorerGotoCrmActionCenter() {
  av2SwitchTab('crm_action_center');
}

// ── 詳情 Drawer（需求文件 H/I/J）：Lazy load —— 只有點開詳情時才呼叫
//    購物車詳情/時間軸與訪客360，主表格本身不會多打任何一支 API ─────────
async function av2ExplorerOpenDetail(cartId) {
  const el = document.getElementById('av2-explorer-drawer');
  if (!el) return;
  el.innerHTML = `<div class="analytics-card" style="margin-top:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-weight:700">🔍 購物車詳情</div>
      <button onclick="av2ExplorerCloseDetail()" style="background:transparent;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.1rem">✕</button>
    </div>
    <div id="av2-drawer-body" style="color:var(--text-secondary);font-size:.85rem">載入中...</div>
  </div>`;
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const res = await apiFetch('/api/analytics/cart-abandonment/' + encodeURIComponent(cartId));
    const json = await res.json();
    const body = document.getElementById('av2-drawer-body');
    if (!json.success) { if (body) body.innerHTML = `<div style="color:var(--danger)">資料載入失敗，請稍後重試。</div>`; return; }
    if (body) body.innerHTML = _av2ExplorerDrawerHtml(json.cart, cartId);
  } catch (e) {
    const body = document.getElementById('av2-drawer-body');
    if (body) body.innerHTML = `<div style="color:var(--danger)">資料載入失敗，請稍後重試。</div>`;
  }
}
function av2ExplorerCloseDetail() {
  const el = document.getElementById('av2-explorer-drawer');
  if (el) el.innerHTML = '';
}
function _av2ExplorerDrawerHtml(c, cartId) {
  const who = c.identity_type === 'line'
    ? `${escHtml(c.display_name || 'LINE 會員')}（${escHtml(c.line_uid_masked || '')}）`
    : `訪客 ${escHtml(c.visitor_id_short || '')}`;
  const itemsHtml = (c.items||[]).length ? (c.items||[]).map(i => `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed var(--border)">
    <span>${escHtml(i.name)}${i.variant?` <span style="color:var(--text-secondary)">(${escHtml(i.variant)})</span>`:''} × ${i.qty}</span>
    <span>${i.unit_price!==undefined?_nt(i.unit_price)+' / 件　':''}${_nt(i.subtotal)}</span>
  </div>`).join('') : `<div style="color:var(--text-secondary)">（無商品明細可顯示）</div>`;
  const timelineHtml = (c.timeline||[]).length ? (c.timeline||[]).map(t => `<div style="display:flex;gap:8px;padding:3px 0;font-size:.8rem">
    <span style="color:var(--text-secondary);width:44px;flex-shrink:0">${escHtml(t.time||'')}</span>
    <span>${escHtml(t.event_name_zh||'')}${t.detail?`：${escHtml(t.detail)}`:''}</span>
  </div>`).join('') : `<div style="color:var(--text-secondary);font-size:.85rem">目前沒有可顯示的事件時間軸。</div>`;

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div>
        <div style="font-weight:700;margin-bottom:6px">🛒 購物車內容</div>
        <div style="font-size:.82rem;color:var(--text-secondary);margin-bottom:6px">${who}　·　模式：${AV2_ORDER_MODE_LABEL[c.order_mode]||'—'}${c.estimated?'　·　<span style="color:#f59e0b">⚠️ 舊資料估計值，非實際快照</span>':''}</div>
        ${itemsHtml}
        <div style="margin-top:8px;font-size:.85rem;display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;justify-content:space-between"><span>小計</span><span>${_nt(c.subtotal)}</span></div>
          ${c.discount ? `<div style="display:flex;justify-content:space-between;color:#10b981"><span>折扣/優惠券</span><span>-${_nt(c.discount)}</span></div>` : ''}
          ${c.delivery_fee ? `<div style="display:flex;justify-content:space-between"><span>外送費</span><span>${_nt(c.delivery_fee)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;font-weight:700;border-top:1px solid var(--border);padding-top:4px;margin-top:2px"><span>總計</span><span>${_nt(c.total)}</span></div>
        </div>
      </div>
      <div>
        <div style="font-weight:700;margin-bottom:6px">🕒 Session 行為時間軸</div>
        ${timelineHtml}
      </div>
    </div>
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
      <div id="av2-visitor360-box">
        <button onclick="av2ExplorerLoadVisitor360('${escHtml(cartId)}')" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.8rem">👤 載入訪客 360</button>
      </div>
    </div>`;
}

// 訪客 360：只在使用者主動點擊時才呼叫（需求文件 L：Lazy load，不隨主表格自動打）
async function av2ExplorerLoadVisitor360(cartId) {
  const box = document.getElementById('av2-visitor360-box');
  if (box) box.innerHTML = `<div style="color:var(--text-secondary);font-size:.85rem">載入中...</div>`;
  try {
    const res = await apiFetch('/api/analytics/visitor/' + encodeURIComponent(cartId));
    const json = await res.json();
    if (!json.success) {
      if (box) box.innerHTML = `<div style="color:var(--text-secondary);font-size:.85rem">此紀錄目前仍為匿名訪客，尚未與LINE會員建立可靠關聯。</div>`;
      return;
    }
    if (box) box.innerHTML = _av2Visitor360Html(json.visitor);
  } catch (e) {
    if (box) box.innerHTML = `<div style="color:var(--danger);font-size:.85rem">資料載入失敗，請稍後重試。</div>`;
  }
}
function _av2IdentityExplanation(v) {
  const ci = v.canonical_identity || {};
  if (ci.type === 'line_user_id') {
    if (ci.resolution_method === 'visitor_session_link') return '已由匿名訪客與 LINE 會員確定關聯';
    if ((v.linked_visitor_count||0) > 1) return '多個識別來源已合併為同一位 LINE 會員';
    return '直接對應 LINE 會員';
  }
  if (ci.confidence === 'unresolved') return '身份尚未解析（僅匿名訪客，無可靠關聯資料）';
  return '僅匿名訪客';
}
function _av2Visitor360Html(v) {
  const ltv = v.ltv;
  return `
    <div style="font-weight:700;margin-bottom:6px">👤 訪客 360</div>
    <div style="font-size:.78rem;color:#6366f1;margin-bottom:8px">🔎 ${escHtml(_av2IdentityExplanation(v))}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;font-size:.8rem;color:var(--text-secondary)">
      <div>身份：<b style="color:var(--text-primary)">${v.identity_type==='line'?'LINE會員':'匿名訪客'}</b></div>
      ${v.display_name ? `<div>名稱：<b style="color:var(--text-primary)">${escHtml(v.display_name)}</b></div>` : ''}
      ${v.line_uid_masked ? `<div>LINE UID：<b style="color:var(--text-primary)">${escHtml(v.line_uid_masked)}</b></div>` : ''}
      ${v.friend_status ? `<div>好友狀態：<b style="color:var(--text-primary)">${escHtml({friend:'好友',not_friend:'非好友',unknown:'未知'}[v.friend_status]||v.friend_status)}</b></div>` : ''}
      <div>首次來訪：<b style="color:var(--text-primary)">${escHtml(v.first_seen_at||'—')}</b></div>
      <div>最近來訪：<b style="color:var(--text-primary)">${escHtml(v.last_seen_at||'—')}</b></div>
      <div>來訪次數：<b style="color:var(--text-primary)">${v.total_visits ?? 0}</b></div>
      <div>購物車數：<b style="color:var(--text-primary)">${(v.cart_history||[]).length}</b></div>
      <div>訂單數：<b style="color:var(--text-primary)">${ltv?ltv.order_count:0}</b></div>
      <div>累積消費：<b style="color:var(--text-primary)">${ltv?_nt(ltv.total_spent):'—'}</b></div>
      <div>平均客單：<b style="color:var(--text-primary)">${ltv?_nt(ltv.avg_order_value):'—'}</b></div>
      <div>最近購買：<b style="color:var(--text-primary)">${ltv&&ltv.last_order_at?escHtml(ltv.last_order_at):'—'}</b></div>
    </div>
    <div style="font-size:.7rem;color:var(--text-secondary);margin-top:8px">資料更新時間：${escHtml(new Date(v.data_generated_at||Date.now()).toLocaleString('zh-TW'))}</div>`;
}

// ── CRM Action Center 入口（需求文件 N：本輪只做安全的進入點，不執行任何動作）──
function _av2RenderCrmActionCenter() {
  const seg = _av2ExplorerLastSegment;
  const n = _av2ExplorerSelected.size;
  if (!seg && !n) {
    return _section('🎯 CRM Action Center', _av2Empty('🎯', '尚未準備任何受眾',
      '請先回到「Cart Abandonment」頁籤，篩選並選取對象或建立分群，才能進入 CRM Action Center。'));
  }
  const context = seg
    ? `分群「${escHtml(seg.name)}」（${seg.type==='static'?'靜態快照':'動態'}，${seg.member_count} 人）`
    : `目前選取的 ${n} 位對象（尚未建立為分群）`;
  return _section('🎯 CRM Action Center', `
    <div class="analytics-card">
      <div style="font-size:.85rem;margin-bottom:10px">已保留受眾範圍：<b style="color:var(--text-primary)">${context}</b></div>
      <div style="font-size:.8rem;color:var(--text-secondary);line-height:1.7">
        執行動作（發送優惠券、LINE 推播、建立再行銷名單等）將於下一階段開放。<br>
        本階段僅提供受眾準備與交接，尚未串接任何實際發送管道，不會送出任何 LINE 訊息或核發優惠券。
      </div>
    </div>`);
}
function _av2RenderProducts(v2) {
  const rankings = v2.product_rankings || {};
  if (v2.insufficient_data) {
    return _section('🏆 熱門商品分析', _av2Empty('🏆', '尚無商品排行資料',
      '此區間尚無足夠的轉換事件資料，累積更多瀏覽與訂單後即可看到多維排行。'));
  }
  const threshold = rankings.min_sample_threshold || 5;
  const excluded = rankings.excluded_low_sample_count || 0;

  let html = '';
  if (excluded > 0) {
    html += `<div class="analytics-card" style="margin-bottom:16px;border-color:rgba(33,150,243,.3);background:rgba(33,150,243,.06)">
      <div style="font-size:.75rem;color:var(--text-secondary);line-height:1.6">
        ℹ️ 有 ${excluded} 項商品因瀏覽樣本數低於 ${threshold} 次（例如只有 1 次瀏覽就成交），為避免誤判為「最佳／最差轉換商品」，
        未列入 Top Conversion／Lowest Conversion 排行（其餘不受樣本代表性影響的排行不受此限制）。
      </div>
    </div>`;
  }

  const rankCard = (title, list, valueKey, fmt) => {
    const body = (!list || !list.length)
      ? `<div style="font-size:.85rem;color:var(--text-secondary);padding:8px 0">此區間無資料</div>`
      : list.map(p => `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:.85rem;border-bottom:1px solid var(--border)">
          <span>${p.rank}. ${escHtml(p.product_name)}　<span style="font-size:.7rem;color:var(--text-secondary)">(樣本 ${p.sample_size})</span></span>
          <span style="color:var(--success);white-space:nowrap;margin-left:8px">${fmt(p[valueKey])}</span></div>`).join('');
    return `<div class="analytics-card">
      <div style="font-weight:700;margin-bottom:8px;font-size:.9rem">${title}</div>
      ${body}
    </div>`;
  };
  html += _section('🏆 熱門商品分析（多維排行，每項皆標示排名／樣本數）', `
    <div class="analytics-ranking-grid">
      ${rankCard('Top Sales', rankings.top_sales, 'purchase_qty', v => v + ' 份')}
      ${rankCard('Top Revenue', rankings.top_revenue, 'revenue', v => _nt(v))}
      ${rankCard('Top Conversion', rankings.top_conversion, 'conversion_rate', v => _fmtPct(v))}
      ${rankCard('Highest Cart', rankings.highest_cart, 'add_to_cart', v => v + ' 人')}
      ${rankCard('Lowest Conversion', rankings.lowest_conversion, 'conversion_rate', v => _fmtPct(v))}
      ${rankCard('Highest Abandon', rankings.highest_abandon, 'abandon_rate', v => _fmtPct(v))}
    </div>`
  );
  return html;
}

// ── ⑤ Sources / Campaigns（依需求文件十二：第一排兩欄，第二排廣告 Dashboard 滿版）──
function _av2RenderSourcesCampaigns(v2) {
  const sourceRows = _av2SourceRows(v2.source_performance);
  const rows = sourceRows.map(s => `<tr onclick="av2ExplorerApplySourceFilter('${escHtml(s.source).replace(/'/g,"\\'")}')" style="cursor:pointer" title="點擊查看此來源的購物車明細">
    <td style="padding:6px 0">${escHtml(s.source)}</td>
    <td style="padding:6px 0;text-align:right">${s.sessions}</td>
    <td style="padding:6px 0;text-align:right">${s.orders}</td>
    <td style="padding:6px 0;text-align:right;color:var(--success)">${_nt(s.revenue)}</td>
    <td style="padding:6px 0;text-align:right">${_fmtPct(s.conversion_rate)}</td>
  </tr>`).join('');
  const sourceCard = `<div class="analytics-card">
    <div style="font-weight:700;margin-bottom:10px;font-size:.9rem">📡 來源分析 Source Performance</div>
    ${_av2TableWrap(`<table>
      <thead><tr style="color:var(--text-secondary);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">來源</th><th style="text-align:right;padding-bottom:8px">Sessions</th>
        <th style="text-align:right;padding-bottom:8px">Orders</th><th style="text-align:right;padding-bottom:8px">Revenue</th>
        <th style="text-align:right;padding-bottom:8px">Conversion</th></tr></thead>
      <tbody>${rows}</tbody></table>`)}
  </div>`;

  const c = v2.campaigns || { available: false, message: '尚未取得 Campaign 資料', rows: [] };
  let campaignCard;
  if (!c.available) {
    campaignCard = `<div class="analytics-card">
      <div style="font-weight:700;margin-bottom:10px;font-size:.9rem">🎯 Campaign 分析</div>
      ${_av2Empty('🎯', '尚未取得 Campaign 資料', '此區間的流量沒有帶 utm_campaign 參數，累積有標記活動的流量後即可看到成效。')}
    </div>`;
  } else {
    const cRows = (c.rows || []).map(r => `<tr>
      <td style="padding:6px 0">${escHtml(r.campaign)}</td>
      <td style="padding:6px 0;text-align:right">${r.visitors}</td>
      <td style="padding:6px 0;text-align:right">${r.orders}</td>
      <td style="padding:6px 0;text-align:right;color:var(--success)">${_nt(r.revenue)}</td>
      <td style="padding:6px 0;text-align:right">${_fmtPct(r.conversion_rate)}</td>
    </tr>`).join('');
    campaignCard = `<div class="analytics-card">
      <div style="font-weight:700;margin-bottom:10px;font-size:.9rem">🎯 Campaign 分析</div>
      ${_av2TableWrap(`<table>
        <thead><tr style="color:var(--text-secondary);font-size:.75rem">
          <th style="text-align:left;padding-bottom:8px">Campaign</th><th style="text-align:right;padding-bottom:8px">Visitors</th>
          <th style="text-align:right;padding-bottom:8px">Orders</th><th style="text-align:right;padding-bottom:8px">Revenue</th>
          <th style="text-align:right;padding-bottom:8px">Conversion</th></tr></thead>
        <tbody>${cRows}</tbody></table>`)}
    </div>`;
  }

  let html = _section('📡 來源與 Campaign', `<div class="analytics-two-col">${sourceCard}${campaignCard}</div>`);

  // 廣告 Dashboard（依需求文件九：Cost/ROAS/CPA/CAC 一律誠實顯示「尚未取得／尚未計算」）
  const ads = v2.ads_dashboard || [];
  const adRows = ads.map(a => `<tr>
    <td style="padding:6px 0">${escHtml(a.source)}</td>
    <td style="padding:6px 0;text-align:right">${a.sessions}</td>
    <td style="padding:6px 0;text-align:right">${a.orders}</td>
    <td style="padding:6px 0;text-align:right;color:var(--success)">${_nt(a.revenue)}</td>
    <td style="padding:6px 0;text-align:right;color:var(--text-secondary)">尚未取得</td>
    <td style="padding:6px 0;text-align:right;color:var(--text-secondary)">尚未計算</td>
    <td style="padding:6px 0;text-align:right;color:var(--text-secondary)">尚未計算</td>
    <td style="padding:6px 0;text-align:right;color:var(--text-secondary)">尚未計算</td>
  </tr>`).join('');
  html += _section('📢 廣告 Dashboard（Meta Ads／Google Ads API 尚未串接，Cost/ROAS/CPA/CAC 誠實顯示，絕不假造）',
    `<div style="font-size:.75rem;color:var(--text-secondary);margin-bottom:10px">
      Meta Ads API：<b style="color:var(--danger)">尚未串接</b>　｜　Google Ads API：<b style="color:var(--danger)">尚未串接</b>
    </div>` +
    _av2TableWrap(`<table style="min-width:640px">
      <thead><tr style="color:var(--text-secondary);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">來源</th><th style="text-align:right;padding-bottom:8px">Sessions</th>
        <th style="text-align:right;padding-bottom:8px">Orders</th><th style="text-align:right;padding-bottom:8px">Revenue</th>
        <th style="text-align:right;padding-bottom:8px">廣告花費</th><th style="text-align:right;padding-bottom:8px">ROAS</th>
        <th style="text-align:right;padding-bottom:8px">CPA</th><th style="text-align:right;padding-bottom:8px">CAC</th></tr></thead>
      <tbody>${adRows}</tbody></table>`)
  );
  return html;
}

// ── ⑥ CRM Dashboard（沿用 line_members / getLineCrmKpi 邏輯，無資料時滿版空狀態）──
function _av2RenderCrm(v2) {
  const crm = v2.crm || { insufficient_data: true };
  if (crm.insufficient_data) {
    return _section('👥 CRM Dashboard', _av2Empty('👥', '尚無 LINE 會員資料',
      '目前尚未取得可分析的 LINE 會員紀錄。當會員透過 LINE 登入並完成訂單後，此區將顯示：<br>會員數、回購率、平均客單、30／90 天未回購、VIP 與最近購買。'));
  }
  let html = `<div class="analytics-kpi-grid">
    ${_card('會員總數', crm.total_members + ' 人')}
    ${_card('新會員', crm.new_members + ' 人', '', '#10b981')}
    ${_card('有消費會員', crm.paying_members + ' 人')}
    ${_card('回購會員', crm.repeat_members + ' 人')}
    ${_card('回購率', _fmtPct(crm.repeat_rate))}
    ${_card('平均客單', _nt(crm.avg_order_value))}
    ${_card('30天未回購', crm.inactive_30d + ' 人', '', crm.inactive_30d > 0 ? '#f59e0b' : '')}
    ${_card('90天未回購', crm.inactive_90d + ' 人', '', crm.inactive_90d > 0 ? '#ef4444' : '')}
    ${_card('VIP 會員', crm.vip_members + ' 人', '', '#818cf8')}
    ${_card('一般會員', crm.regular_members + ' 人')}
  </div>`;
  const rows = (crm.recent_purchases || []).map(m => `<tr>
    <td style="padding:6px 0">${escHtml(m.display_name || '（未命名）')}</td>
    <td style="padding:6px 0;text-align:right">${escHtml(m.last_order_at || '—')}</td>
    <td style="padding:6px 0;text-align:right;color:var(--success)">${_nt(m.total_spent)}</td>
  </tr>`).join('');
  html += _section('🕒 最近購買', rows ? _av2TableWrap(`<table>
    <thead><tr style="color:var(--text-secondary);font-size:.75rem">
      <th style="text-align:left;padding-bottom:8px">會員</th><th style="text-align:right;padding-bottom:8px">最近購買時間</th>
      <th style="text-align:right;padding-bottom:8px">累計消費</th></tr></thead>
    <tbody>${rows}</tbody></table>`) : _av2Empty('🕒', '尚無購買紀錄', '會員完成第一筆訂單後會出現在這裡。')
  );
  return html;
}

// ── ⑦ AI Insights（Rule Engine，無資料時滿版「經營建議中心」空狀態）────
function _av2RenderAiInsights(v2) {
  const insights = v2.ai_insights || [];
  const banner = `<div class="analytics-card" style="margin-bottom:16px;border-color:rgba(33,150,243,.3);background:rgba(33,150,243,.06)">
    <div style="font-size:.78rem;color:var(--text-secondary)">ℹ️ 目前為規則式分析（Rule Engine），尚未串接外部 AI API。</div>
  </div>`;

  const insufficient = insights.find(i => i.type === 'insufficient_data');
  if (insufficient || !insights.length) {
    return banner + _section('🤖 AI Insights', _av2Empty('🤖', '目前沒有特別需要注意的項目',
      '累積更多瀏覽、加購、結帳、訂單與會員資料後，系統將提供：<br>漏斗異常・商品轉換異常・來源品質異常・放棄購物車警告・CRM 回購提醒'));
  }
  const severityLabel = { high: '🔴 高', medium: '🟡 中', positive: '🟢 表現優異', info: 'ℹ️ 提示' };
  const severityColor = { high: 'var(--danger)', medium: '#f59e0b', positive: 'var(--success)', info: 'var(--info)' };
  const cards = insights.map(i => `<div class="db-v3-hover analytics-card" style="border-left:3px solid ${severityColor[i.severity]||'var(--info)'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
      <div style="font-weight:700;font-size:.9rem">${escHtml(i.problem || '')}</div>
      <span style="font-size:.72rem;color:${severityColor[i.severity]||'var(--info)'};white-space:nowrap">${severityLabel[i.severity]||i.severity}</span>
    </div>
    <div style="font-size:.8rem;color:var(--text-secondary);margin:6px 0">判斷依據：${escHtml(i.evidence || '')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${(i.actions||[]).map(s => `<span style="font-size:.75rem;padding:3px 10px;border-radius:99px;background:rgba(33,150,243,.15);color:var(--info)">💡 ${escHtml(s)}</span>`).join('')}
    </div>
  </div>`).join('');
  return banner + _section('🤖 AI Insights（規則式，非 GPT）', `<div class="analytics-ranking-grid analytics-ranking-grid--two-col">${cards}</div>`);
}
