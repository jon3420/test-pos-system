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

  let html = `<div class="analytics-kpi-grid">
    ${_card('加入購物車數', totalAdd + ' 人')}
    ${_card('成交數', totalPurchase + ' 人', '', '#10b981')}
    ${_card('放棄數', totalAbandon + ' 人', '', '#f59e0b')}
    ${_card('放棄率', overallRate, '', '#ef4444')}
    ${_card('估計放棄金額', _nt(totalEstAmount), '⚠️ 估計值，非實際購物車金額快照', '#ef4444')}
  </div>`;

  html += `<div class="analytics-card" style="margin-bottom:20px;border-color:rgba(245,166,35,.35);background:rgba(245,166,35,.06)">
    <div style="font-size:.75rem;color:var(--text-secondary);line-height:1.6">
      ⚠️ 統計限制：加入購物車以 cart_id 為單位（非 session／會員身分），同一顧客若中途更換裝置或清除瀏覽器資料可能被視為不同購物車；
      放棄金額為「放棄人數 × 目前商品售價」的<b style="color:var(--text-primary)">估計值</b>，非結帳當下的實際金額快照，商品改價／下架後會與實際情況有落差。
    </div>
  </div>`;

  const top = abandon.top_abandon_products || [];
  const topRows = top.map(p => `<tr>
    <td style="padding:6px 0">${escHtml(p.product_name)}</td>
    <td style="padding:6px 0;text-align:right">${p.add_to_cart}</td>
    <td style="padding:6px 0;text-align:right">${p.purchase}</td>
    <td style="padding:6px 0;text-align:right;color:#f59e0b">${p.abandon}</td>
    <td style="padding:6px 0;text-align:right;color:var(--danger)">${_fmtPct(p.abandon_rate)}</td>
    <td style="padding:6px 0;text-align:right;color:var(--danger)">${_nt(p.estimated_abandoned_amount)}<span style="font-size:.68rem;color:var(--text-secondary)">（估計值）</span></td>
  </tr>`).join('');
  html += _section('🏆 Top Abandon Products', topRows ? _av2TableWrap(`<table>
    <thead><tr style="color:var(--text-secondary);font-size:.75rem">
      <th style="text-align:left;padding-bottom:8px">商品</th><th style="text-align:right;padding-bottom:8px">Add</th>
      <th style="text-align:right;padding-bottom:8px">Purchase</th><th style="text-align:right;padding-bottom:8px">Abandon</th>
      <th style="text-align:right;padding-bottom:8px">Abandon Rate</th><th style="text-align:right;padding-bottom:8px">估計放棄金額</th></tr></thead>
    <tbody>${topRows}</tbody></table>`) : _av2Empty('🏆', '此區間尚無資料', '尚無足夠的放棄購物車樣本可以排行。')
  );
  return html;
}

// ── ④ 熱門商品多維排行（依需求文件十一：桌機三欄兩排）──────────────────
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
  const rows = sourceRows.map(s => `<tr>
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
