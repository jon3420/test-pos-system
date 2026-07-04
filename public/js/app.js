// ═══════════════════════════════════════════════════
// SaaS R1 fix4 — 店家 JWT 綁定層
// ═══════════════════════════════════════════════════

// ── 讀寫 token ─────────────────────────────────────
const TOKEN_KEY = 'pos_store_token';
function getToken()           { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)          { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()         { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('pos_store_info'); }

// ── 解析 JWT payload（不驗簽，僅用於 UI 顯示）────────
function parseJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(base64));
  } catch { return null; }
}

// ── apiFetch — 統一包裝 fetch，自動帶 Authorization ─
// 所有 POS API 透過此函式呼叫，不再直接用 apiFetch('/api/...')
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  // fix18-05: 補 x-store-id header，讓 requireStore 有第二條解析路徑
  // 當 JWT 失效時仍可透過 x-store-id 識別店家
  const storeInfo = (() => {
    try { return JSON.parse(localStorage.getItem('pos_store_info') || '{}'); } catch { return {}; }
  })();
  const storeId = (window.currentStore && window.currentStore.store_id)
    || storeInfo.store_id || '';
  if (storeId && !headers['x-store-id']) headers['x-store-id'] = storeId;
  const res = await fetch(url, { ...options, headers });

  // fix16：正確的 401 / 403 處理
  //   401 → token 過期或無效 → 登出，跳回登入頁
  //   403 FEATURE_DISABLED  → 保持登入，顯示「功能未授權」提示
  //   403 LICENSE_INACTIVE  → 保持登入，顯示「授權已停用」提示
  //   403 其他              → 保持登入，顯示錯誤訊息
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (!url.includes('/store-login')) {
      const errCode = body.error || '';
      if (errCode === 'NO_STORE_TOKEN') {
        console.warn('[apiFetch] 401 NO_STORE_TOKEN — 缺少登入 token，重新登入');
      } else {
        console.warn('[apiFetch] 401 — token 過期，重新登入');
      }
      clearToken();
      showLoginOverlay();
    }
    return { ok: false, status: 401, body };
  }

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const err  = body.error || '';
    // fix16j: 403 不登出，依錯誤類型顯示對應訊息
    if (err === 'FEATURE_DISABLED') {
      const feat = body.feature ? `（${body.feature}）` : '';
      if (typeof showToast === 'function')
        showToast(`此功能未授權${feat}，請聯絡系統管理員升級方案`, 'error');
    } else if (err === 'LICENSE_INACTIVE') {
      if (typeof showToast === 'function')
        showToast('店家授權已停用，請聯絡系統管理員', 'error');
    } else if (err === 'PAYMENT_METHOD_SEED_FAILED') {
      // 付款方式初始化失敗 — 建議重新登入
      if (typeof showToast === 'function')
        showToast('店家授權異常，請重新登入', 'error');
    } else if (body.message && (body.message.includes('不存在') || body.message.includes('停用'))) {
      // store 不存在或停用
      if (typeof showToast === 'function')
        showToast('店家授權異常，請重新登入', 'error');
    } else {
      console.warn('[apiFetch] 403:', body.message || err);
      if (typeof showToast === 'function' && !url.includes('/store-login'))
        showToast(body.message || '存取被拒絕（403）', 'error');
    }
    return { ok: false, status: 403, body };
  }

  return res;
}

// ── 登入 Overlay UI ────────────────────────────────
let _loginResolve = null;

function showLoginOverlay() {
  let overlay = document.getElementById('store-login-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'store-login-overlay';
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1a1d27;border:1px solid #2a2d3e;border-radius:16px;padding:36px;width:340px;text-align:center;font-family:-apple-system,sans-serif;">
          <div style="font-size:1.4rem;font-weight:700;color:#818cf8;margin-bottom:6px;">🔐 店家登入</div>
          <div style="color:#64748b;font-size:.85rem;margin-bottom:24px;">POS SaaS R1</div>
          <div style="text-align:left;margin-bottom:12px;">
            <label style="font-size:.8rem;color:#94a3b8;display:block;margin-bottom:4px;">Store ID</label>
            <input id="login-store-id" type="text" placeholder="store_001"
              style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid #2a2d3e;background:#0f1117;color:#e2e8f0;font-size:.95rem;outline:none;box-sizing:border-box;">
          </div>
          <div style="text-align:left;margin-bottom:18px;">
            <label style="font-size:.8rem;color:#94a3b8;display:block;margin-bottom:4px;">密碼</label>
            <input id="login-password" type="password" placeholder="預設：與 Store ID 相同"
              style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid #2a2d3e;background:#0f1117;color:#e2e8f0;font-size:.95rem;outline:none;box-sizing:border-box;"
              onkeydown="if(event.key==='Enter')doStoreLogin()">
          </div>
          <button onclick="doStoreLogin()"
            style="width:100%;padding:11px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;">
            登入
          </button>
          <div id="login-err" style="color:#ef4444;font-size:.8rem;margin-top:10px;min-height:18px;"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.style.display = '';
}

function hideLoginOverlay() {
  const el = document.getElementById('store-login-overlay');
  if (el) {
    el.style.display       = 'none';
    el.style.visibility    = 'hidden';
    el.style.pointerEvents = 'none';  // fix16f: 確保不攔截點擊
    el.style.zIndex        = '-1';
  }
}

async function doStoreLogin() {
  const storeId  = (document.getElementById('login-store-id')?.value || '').trim();
  const password = document.getElementById('login-password')?.value || '';
  const errEl    = document.getElementById('login-err');
  if (errEl) errEl.textContent = '';
  if (!storeId || !password) {
    if (errEl) errEl.textContent = '請填寫 Store ID 與密碼';
    return;
  }
  try {
    const res  = await apiFetch('/api/store-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, password }),
    });
    const data = await res.json();
    if (data.success) {
      setToken(data.token);
      localStorage.setItem('pos_store_info', JSON.stringify({
        store_id:   data.store_id,
        store_name: data.store_name,
        plan:       data.plan,
      }));
      hideLoginOverlay();
      // 重新載入頁面資料
      if (typeof loadCurrentStore === 'function') await loadCurrentStore().catch(()=>{});
      if (typeof loadSettings === 'function')   await loadSettings().catch(()=>{});
      if (typeof loadCategories === 'function') await loadCategories().catch(()=>{});
      // fix16k-02: 只有 delivery 功能授權才呼叫 loadPlatforms，避免 BASIC 方案觸發 403
      if (typeof loadPlatforms === 'function' && hasFeature('delivery')) await loadPlatforms().catch(()=>{});
      if (typeof loadPaymentMethods === 'function') await loadPaymentMethods().catch(()=>{});
      if (typeof loadProducts === 'function')   await loadProducts().catch(()=>{});
      if (_loginResolve) { _loginResolve(); _loginResolve = null; }
    } else {
      if (errEl) errEl.textContent = data.message || '登入失敗';
    }
  } catch(e) {
    if (errEl) errEl.textContent = '連線失敗：' + e.message;
  }
}

// ── 頁面啟動時檢查 token ────────────────────────────
async function ensureLogin() {
  const token = getToken();
  if (!token) { showLoginOverlay(); return; }
  // fix16b: 驗證 token 用 /api/store-me，確認店家授權有效
  try {
    const res = await fetch('/api/store-me', {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
    if (res.status === 401) {
      // token 過期 → 清除並顯示登入
      clearToken();
      showLoginOverlay();
      return;
    }
    if (res.status === 200) {
      const data = await res.json().catch(() => ({}));
      if (data.success && data.data) {
        window.currentStore    = data.data;
        window.currentFeatures = data.data.features || {};
        applyFeatureGateUI();
        updateTopbarStoreInfo();
      }
    }
    // 403（FEATURE_DISABLED / LICENSE_INACTIVE）不登出，讓後續 API 處理
  } catch(e) {
    console.warn('[ensureLogin] 驗證失敗，繼續（可能 server 暫時無回應）:', e.message);
  }
}

// ── 登出 ────────────────────────────────────────────
function posLogout() {
  // fix16b: 完整清除所有 auth 相關資料
  localStorage.removeItem('pos_store_token');
  localStorage.removeItem('pos_store_info');
  sessionStorage.clear();
  window.currentStore    = null;
  window.currentFeatures = {};
  location.reload();
}

// ═══════════════════════════════════════════════════
// 以下為原始 app.js 內容（已保留完整）
// 所有 apiFetch('/api/...') 已替換為 apiFetch('/api/...')
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// fix13 — 前端 Feature Gate + 店家資訊 + LINE 點餐入口
// ═══════════════════════════════════════════════════

// 目前登入店家資訊（loadCurrentStore 後可用）
window.currentStore    = null;
window.currentFeatures = {};

/** 判斷 feature 是否啟用 */
function hasFeature(key) {
  return window.currentFeatures[key] === true;
}

/** 載入老闆儀表板（fix16b 升級）*/
function loadReportsPage() {
  const container = document.getElementById('reports-container');
  if (!container) return;

  if (!hasFeature('reports')) {
    container.innerHTML =
      '<div style="text-align:center;padding:60px 20px">' +
      '<div style="font-size:3rem;margin-bottom:16px">🔒</div>' +
      '<div style="font-size:1rem;font-weight:600;color:#ef4444;margin-bottom:8px">報表分析功能尚未授權</div>' +
      '<div style="font-size:.875rem;color:var(--text-secondary,#64748b)">請聯絡系統管理員升級方案。</div>' +
      '</div>';
    return;
  }

  container.innerHTML = _dashboardSkeleton();
  _loadDashboard();
}

function _dashboardSkeleton() {
  return `
  <div id="dashboard-wrap" style="font-family:-apple-system,sans-serif;width:100%;box-sizing:border-box">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <h2 style="margin:0;font-size:1.2rem">📊 老闆儀表板</h2>
      <input type="date" id="db-date" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border,#2a2d3e);background:var(--bg-card,#1a1d27);color:var(--text-primary,#e2e8f0);font-size:.85rem"
        onchange="_loadDashboard()">
      <button onclick="_loadDashboard()" style="padding:6px 12px;border-radius:8px;background:#6366f1;border:none;color:#fff;cursor:pointer;font-size:.85rem">🔄 重新整理</button>
    </div>
    <div id="db-body"><div style="color:var(--text-secondary,#64748b);padding:20px">載入中...</div></div>
  </div>`;
}

async function _loadDashboard() {
  const dateEl = document.getElementById('db-date');
  if (dateEl && !dateEl.value) {
    // 設定預設日期（台灣今日）
    const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    dateEl.value = n.toISOString().slice(0,10);
  }
  const date = dateEl ? dateEl.value : '';
  const body = document.getElementById('db-body');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--text-secondary,#64748b);padding:20px">載入中...</div>';

  try {
    const url = '/api/dashboard' + (date ? '?date=' + date : '');
    const res  = await apiFetch(url);
    if (!res || res.status === 403) {
      body.innerHTML = '<div style="color:#ef4444;padding:20px">❌ 無法載入報表（功能未授權）</div>';
      return;
    }
    const json = await res.json();
    if (!json.success) { body.innerHTML = '<div style="color:#ef4444;padding:20px">❌ ' + (json.message || '載入失敗') + '</div>'; return; }
    body.innerHTML = _renderDashboard(json.data, json.date);
  } catch(e) {
    body.innerHTML = '<div style="color:#ef4444;padding:20px">❌ 載入失敗：' + e.message + '</div>';
  }
}

function _nt(n) { return 'NT$' + Number(n||0).toLocaleString('zh-TW',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function _pct(a, b) { return b > 0 ? Math.round(a/b*100) + '%' : '—'; }

function _card(label, value, sub, color) {
  return `<div style="background:var(--bg-card,#1a1d27);border:1px solid var(--border,#2a2d3e);border-radius:12px;padding:16px 20px;min-width:140px">
    <div style="font-size:.75rem;color:var(--text-secondary,#64748b);margin-bottom:6px">${label}</div>
    <div style="font-size:1.5rem;font-weight:700;color:${color||'var(--text-primary,#e2e8f0)'}">${value}</div>
    ${sub ? `<div style="font-size:.75rem;color:var(--text-secondary,#64748b);margin-top:4px">${sub}</div>` : ''}
  </div>`;
}

function _section(title, html) {
  return `<div style="background:var(--bg-card,#1a1d27);border:1px solid var(--border,#2a2d3e);border-radius:12px;padding:20px;margin-bottom:20px;width:100%;box-sizing:border-box">
    <h3 style="margin:0 0 14px;font-size:.95rem;color:var(--text-primary,#e2e8f0)">${title}</h3>
    ${html}
  </div>`;
}

function _renderDashboard(d, date) {
  const f = window.currentFeatures || {};
  let html = '';

  // ── 第一區：今日總覽 ───────────────────────────────
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;width:100%">
    ${_card('今日營收', _nt(d.todayRevenue), date, '#10b981')}
    ${_card('今日訂單', d.todayOrders + ' 筆', '', '')}
    ${_card('平均客單', _nt(d.avgOrderValue), '', '')}
    ${_card('已結帳', d.paidOrders + ' 筆', '', '#818cf8')}
    ${_card('未結帳', d.unpaidOrders + ' 筆', '', d.unpaidOrders > 0 ? '#f59e0b' : '')}
  </div>`;

  // ── 第二區：週月營收 ────────────────────────────────
  html += _section('📅 週月營收分析',
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      ${_card('本週營收', _nt(d.weekRevenue), d.weekOrders + ' 筆', '#6366f1')}
      ${_card('本月營收', _nt(d.monthRevenue), d.monthOrders + ' 筆', '#8b5cf6')}
    </div>`
  );

  // ── 第三區：付款方式 ────────────────────────────────
  const pmNames = {cash:'現金',card:'刷卡',linepay:'LINE Pay',jkopay:'街口支付',transfer:'轉帳',platform:'平台付款'};
  const pmRows = (d.paymentStats||[]).map(p =>
    `<tr><td style="padding:6px 0">${pmNames[p.payment_method]||p.payment_method}</td>
      <td style="padding:6px 0;text-align:right">${p.count} 筆</td>
      <td style="padding:6px 0;text-align:right;color:#10b981">${_nt(p.revenue)}</td>
      <td style="padding:6px 0;text-align:right;color:var(--text-secondary,#64748b)">${_pct(p.revenue,d.todayRevenue)}</td></tr>`
  ).join('');
  html += _section('💳 付款方式分析',
    pmRows ? `<table style="width:100%;border-collapse:collapse;font-size:.875rem">
      <thead><tr style="color:var(--text-secondary,#64748b);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">方式</th><th style="text-align:right;padding-bottom:8px">筆數</th>
        <th style="text-align:right;padding-bottom:8px">金額</th><th style="text-align:right;padding-bottom:8px">佔比</th></tr></thead>
      <tbody>${pmRows}</tbody></table>` : '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">今日無資料</div>'
  );

  // ── 第四區：訂單來源 ────────────────────────────────
  const modeNames = {dine_in:'內用',takeout:'外帶',delivery:'外送'};
  const srcRows = (d.sourceStats||[]).map(s => {
    const modeName = modeNames[s.mode] || s.mode;
    const platLabel = s.platform ? ` (${s.platform})` : '';
    return `<tr><td style="padding:6px 0">${modeName}${platLabel}</td>
      <td style="padding:6px 0;text-align:right">${s.count} 筆</td>
      <td style="padding:6px 0;text-align:right;color:#10b981">${_nt(s.revenue)}</td></tr>`;
  }).join('');
  html += _section('📦 訂單來源分析',
    srcRows ? `<table style="width:100%;border-collapse:collapse;font-size:.875rem">
      <thead><tr style="color:var(--text-secondary,#64748b);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">來源</th>
        <th style="text-align:right;padding-bottom:8px">筆數</th>
        <th style="text-align:right;padding-bottom:8px">金額</th></tr></thead>
      <tbody>${srcRows}</tbody></table>` : '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">今日無資料</div>'
  );

  // ── 第五區：熱銷商品 TOP10（fix18-09F：支援群組統計）────────
  const _dbMode = getProductStatMode();
  // 從 topProducts（API 返回的原始商品排行）重新用群組合併
  const _rawTopMap = {};
  (d.topProducts||[]).forEach(p => {
    const dname = resolveProductDisplayName(p.name, _dbMode);
    if (!_rawTopMap[dname]) _rawTopMap[dname] = { name: dname, qty: 0, revenue: 0 };
    _rawTopMap[dname].qty     += Number(p.qty     || 0);
    _rawTopMap[dname].revenue += Number(p.revenue || 0);
  });
  const _mergedTop = Object.values(_rawTopMap).sort((a,b) => b.qty - a.qty).slice(0, 10);
  const _modeToggle = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:12px">
    <span style="font-size:12px;color:var(--text-secondary,#64748b)">統計模式：</span>
    <button onclick="setProductStatMode('group');_loadDashboard()" style="font-size:12px;padding:3px 10px;border-radius:99px;border:1px solid var(--border,#2a2d3e);background:${_dbMode==='group'?'#6366f1':'transparent'};color:${_dbMode==='group'?'#fff':'var(--text-secondary,#64748b)'};cursor:pointer">商品群組</button>
    <button onclick="setProductStatMode('raw');_loadDashboard()" style="font-size:12px;padding:3px 10px;border-radius:99px;border:1px solid var(--border,#2a2d3e);background:${_dbMode==='raw'?'#6366f1':'transparent'};color:${_dbMode==='raw'?'#fff':'var(--text-secondary,#64748b)'};cursor:pointer">原始商品</button>
  </div>`;
  const topRows = _mergedTop.map((p,i) =>
    `<tr><td style="padding:5px 0;color:${i<3?'#f59e0b':'inherit'}">${i+1}. ${escHtml(p.name)}</td>
      <td style="padding:5px 0;text-align:right">${p.qty} 份</td>
      <td style="padding:5px 0;text-align:right;color:#10b981">${_nt(p.revenue)}</td></tr>`
  ).join('');
  html += _section('🏆 熱銷商品排行 TOP10',
    _modeToggle + (topRows ? `<table style="width:100%;border-collapse:collapse;font-size:.875rem">
      <thead><tr style="color:var(--text-secondary,#64748b);font-size:.75rem">
        <th style="text-align:left;padding-bottom:8px">商品</th>
        <th style="text-align:right;padding-bottom:8px">數量</th>
        <th style="text-align:right;padding-bottom:8px">營收</th></tr></thead>
      <tbody>${topRows}</tbody></table>` : '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">今日無資料</div>')
  );

  // ── fix18-09F：商品群組排行 TOP10 ────────────────────
  // 只在群組模式且有群組時顯示
  if (_dbMode === 'group' && allProductAnalysisGroups && allProductAnalysisGroups.length) {
    const _enabledGroups = allProductAnalysisGroups.filter(g => g.enabled);
    // 從 topProducts 聚合群組統計（包含折扣）
    const _grpMap = {};
    _enabledGroups.forEach(g => {
      _grpMap[g.group_name] = { name: g.group_name, qty: 0, revenue: 0, discount: 0, actual: 0 };
    });
    // 掃原始 topProducts
    (d.topProducts||[]).forEach(p => {
      const gname = getAnalysisGroupName(p.name);
      if (gname && _grpMap[gname]) {
        _grpMap[gname].qty     += Number(p.qty     || 0);
        _grpMap[gname].revenue += Number(p.revenue || 0);
      }
    });
    // 折扣資料（從 allOrdersCache 若有）
    const _grpRowsArr = Object.values(_grpMap)
      .filter(g => g.qty > 0 || g.revenue > 0)
      .sort((a,b) => b.qty - a.qty)
      .slice(0, 10);
    if (_grpRowsArr.length) {
      const _grpRows = _grpRowsArr.map((g, i) =>
        `<tr>
          <td style="padding:6px 0;color:${i<3?'#f59e0b':'inherit'}">${i+1}. ${escHtml(g.name)}</td>
          <td style="padding:6px 0;text-align:right">${g.qty} 份</td>
          <td style="padding:6px 0;text-align:right;color:#10b981">${_nt(g.revenue)}</td>
        </tr>`
      ).join('');
      html += _section('📊 商品群組排行 TOP10',
        `<table style="width:100%;border-collapse:collapse;font-size:.875rem">
          <thead><tr style="color:var(--text-secondary,#64748b);font-size:.75rem">
            <th style="text-align:left;padding-bottom:8px">群組</th>
            <th style="text-align:right;padding-bottom:8px">銷量</th>
            <th style="text-align:right;padding-bottom:8px">營收</th>
          </tr></thead>
          <tbody>${_grpRows}</tbody>
        </table>`
      );
    }
  }

  // ── 第六區：外送平台 ────────────────────────────────
  if (f.delivery !== false) {
    const delivRows = (d.deliveryStats||[]).map(p =>
      `<tr><td style="padding:6px 0">${escHtml(p.platform)}</td>
        <td style="padding:6px 0;text-align:right">${p.count} 筆</td>
        <td style="padding:6px 0;text-align:right">${_nt(p.revenue)}</td>
        <td style="padding:6px 0;text-align:right;color:#ef4444">${_nt(p.commission)}</td>
        <td style="padding:6px 0;text-align:right;color:#10b981">${_nt(p.store_income)}</td></tr>`
    ).join('');
    html += _section('🛵 外送平台分析',
      delivRows ? `<table style="width:100%;border-collapse:collapse;font-size:.875rem">
        <thead><tr style="color:var(--text-secondary,#64748b);font-size:.75rem">
          <th style="text-align:left;padding-bottom:8px">平台</th>
          <th style="text-align:right;padding-bottom:8px">筆數</th>
          <th style="text-align:right;padding-bottom:8px">營收</th>
          <th style="text-align:right;padding-bottom:8px">抽成</th>
          <th style="text-align:right;padding-bottom:8px">實收</th></tr></thead>
        <tbody>${delivRows}</tbody></table>` : '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">今日無外送訂單</div>'
    );
  }

  // ── 第七區：時段分析 ────────────────────────────────
  const hourBars = (d.hourlyStats||[]).filter(h => h.count > 0).map(h => {
    const maxCount = Math.max(...(d.hourlyStats||[]).map(x=>x.count), 1);
    const pct = Math.round(h.count / maxCount * 100);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:.8rem">
      <span style="width:40px;color:var(--text-secondary,#64748b)">${h.label}</span>
      <div style="flex:1;background:var(--border,#2a2d3e);border-radius:4px;height:18px;position:relative">
        <div style="width:${pct}%;background:#6366f1;height:100%;border-radius:4px;transition:width .3s"></div>
      </div>
      <span style="width:30px;text-align:right">${h.count}</span>
      <span style="width:70px;text-align:right;color:#10b981">${_nt(h.revenue)}</span>
    </div>`;
  }).join('') || '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">今日無資料</div>';
  html += _section('⏰ 時段分析', hourBars);

  // ── 第八區：星期分析 ────────────────────────────────
  const wdBars = (d.weekdayStats||[]).map(w => {
    const maxRev = Math.max(...(d.weekdayStats||[]).map(x=>x.revenue), 1);
    const pct = Math.round(w.revenue / maxRev * 100);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:.8rem">
      <span style="width:32px;color:var(--text-secondary,#64748b)">${w.label}</span>
      <div style="flex:1;background:var(--border,#2a2d3e);border-radius:4px;height:18px">
        <div style="width:${pct}%;background:#8b5cf6;height:100%;border-radius:4px"></div>
      </div>
      <span style="width:30px;text-align:right">${w.count}</span>
      <span style="width:80px;text-align:right;color:#10b981">${_nt(w.revenue)}</span>
    </div>`;
  }).join('');
  html += _section('📆 星期分析（最近4週）', wdBars || '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">無資料</div>');

  // ── 第九區：LINE 點餐 ───────────────────────────────
  if (f.line_order) {
    const ls = d.lineStats || {};
    html += _section('📲 LINE 點餐分析',
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${_card('LINE 點餐訂單', (ls.orders||0) + ' 筆', '', '#06C755')}
        ${_card('LINE 點餐營收', _nt(ls.revenue), '', '#06C755')}
      </div>`
    );
  }

  // ── 第十區：庫存（預留）───────────────────────────────
  if (f.inventory) {
    html += _section('🏪 庫存分析（預留）',
      '<div style="color:var(--text-secondary,#64748b);font-size:.875rem">庫存分析功能開發中...</div>'
    );
  }

  return html;
}

/** 載入目前店家資訊 + 授權，呼叫 /api/store-me */
async function loadCurrentStore() {
  try {
    const res  = await apiFetch('/api/store-me');
    if (!res || typeof res.json !== 'function') return;
    const data = await res.json();
    if (data && data.success && data.data) {
      window.currentStore    = data.data;
      window.currentFeatures = data.data.features || {};
      applyFeatureGateUI();
      updateTopbarStoreInfo(); // fix16b: 更新右上角店家資訊
    }
  } catch(e) { console.error('[FeatureGate] loadCurrentStore:', e.message); }
}

/** fix16b: 更新右上角店家資訊列 */
function updateTopbarStoreInfo() {
  const store = window.currentStore;
  if (!store) return;
  const el = document.getElementById('topbar-store-info');
  if (el) {
    el.innerHTML =
      `<span style="font-weight:700;color:var(--text-primary,#e2e8f0)">${escHtml(store.store_name || '')}</span>` +
      `<span style="font-size:.7rem;color:var(--text-secondary,#94a3b8);margin-left:4px">${escHtml(store.store_id || '')}</span>` +
      `<span style="font-size:.7rem;background:#312e81;color:#a5b4fc;padding:1px 6px;border-radius:99px;margin-left:4px">${(store.plan||'').toUpperCase()}</span>`;
  }
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** 依授權隱藏 / 顯示 UI 元素（fix16 更新）*/
function applyFeatureGateUI() {
  const f = window.currentFeatures || {};

  // ── 主選單 ──────────────────────────────────────────────
  // 庫存
  const invNav = document.querySelector('button[data-page="inventory"]');
  if (invNav) invNav.style.display = f.inventory ? '' : 'none';

  // fix16: 報表分析（主選單）
  const reportsNav = document.getElementById('nav-btn-reports');
  if (reportsNav) reportsNav.style.display = f.reports !== false ? '' : 'none';

  // ── 設定 Tab ────────────────────────────────────────────
  // LINE 營業
  const lineBizBtn = document.getElementById('tab-btn-line_biz');
  if (lineBizBtn) lineBizBtn.style.display = f.line_order ? '' : 'none';

  // LINE 點餐入口（永遠顯示）
  const lineEntryBtn = document.getElementById('tab-btn-line_entry');
  if (lineEntryBtn) lineEntryBtn.style.display = '';

  // LINE 商品管理 nav（v1）
  initLineProductsNav();

  // fix18-05: 優惠券管理（coupon feature gate）
  const couponNavBtn = document.getElementById('nav-btn-coupons');
  if (couponNavBtn) couponNavBtn.style.display = f.coupon ? '' : 'none';

  // AI Marketing Center（Phase 1 MVP，feature gate，預設關閉）
  const aiMarketingNavBtn = document.getElementById('nav-btn-ai-marketing');
  if (aiMarketingNavBtn) aiMarketingNavBtn.style.display = f.ai_marketing ? '' : 'none';

  // 外送平台
  const platformBtn = document.querySelector('button[data-stab="platform"]');
  if (platformBtn) platformBtn.style.display = f.delivery ? '' : 'none';

  // fix16k: 付款方式 Tab 由 payment_methods feature 控制（預設 true，所有方案均開啟）
  const paymentTabBtn = document.querySelector('button[data-stab="payment"]');
  if (paymentTabBtn) paymentTabBtn.style.display = f.payment_methods !== false ? '' : 'none';

  // 金流 API Tab — payment_api gate（Pro/Premium 才可見）
  const gatewayBtn = document.getElementById('tab-btn-gateway');
  if (gatewayBtn) gatewayBtn.style.display = f.payment_api ? '' : 'none';

  // ── 訂單頁 ──────────────────────────────────────────────
  // 外送報表 Tab
  const delivTab = document.querySelector('button[data-tab="delivery"]');
  if (delivTab) delivTab.style.display = f.delivery ? '' : 'none';

  // ── 點餐頁 ──────────────────────────────────────────────
  // 外送模式按鈕
  const delivMode = document.querySelector('.mode-btn[data-mode="delivery"]');
  if (delivMode) delivMode.style.display = f.delivery ? '' : 'none';
}

// ── LINE 點餐入口 Tab 渲染 ─────────────────────────────────
function loadLineEntryPage() {
  renderLineOrderEntry();
}

function renderLineOrderEntry() {
  const container = document.getElementById('lineEntryContent');
  if (!container) return;

  const store   = window.currentStore;
  const hasLine = hasFeature('line_order');

  if (!store) {
    container.innerHTML = '<p style="color:var(--text-secondary,#64748b)">載入中...</p>';
    return;
  }

  const storeId  = store.store_id || '';
  const lineUrl  = window.location.origin + '/line-order.html?store_id=' + encodeURIComponent(storeId);
  const planName = (store.plan || 'basic').toUpperCase();

  // 店家基本資訊（永遠顯示）
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const infoHtml = `
    <div style="margin-bottom:20px;padding:16px;background:rgba(0,0,0,.2);border-radius:10px;border:1px solid rgba(255,255,255,.08)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:.875rem">
        <div>
          <div style="color:var(--text-secondary,#64748b);font-size:.75rem;margin-bottom:4px">店家名稱</div>
          <strong>${esc(store.store_name)}</strong>
        </div>
        <div>
          <div style="color:var(--text-secondary,#64748b);font-size:.75rem;margin-bottom:4px">Store ID</div>
          <code style="background:rgba(0,0,0,.3);padding:2px 8px;border-radius:4px;font-size:.8rem">${esc(storeId)}</code>
        </div>
        <div>
          <div style="color:var(--text-secondary,#64748b);font-size:.75rem;margin-bottom:4px">目前方案</div>
          <strong style="color:#818cf8">${esc(planName)}</strong>
        </div>
        <div>
          <div style="color:var(--text-secondary,#64748b);font-size:.75rem;margin-bottom:4px">LINE 點餐</div>
          <strong style="color:${hasLine?'#10b981':'#ef4444'}">${hasLine ? '✅ 已啟用' : '❌ 未啟用'}</strong>
        </div>
      </div>
    </div>`;

  if (!hasLine) {
    container.innerHTML = infoHtml + `
      <div style="text-align:center;padding:36px 20px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px">
        <div style="font-size:2.5rem;margin-bottom:12px">🔒</div>
        <div style="font-size:1rem;font-weight:600;color:#ef4444;margin-bottom:8px">LINE 點餐功能尚未啟用</div>
        <div style="font-size:.875rem;color:var(--text-secondary,#64748b)">請聯絡系統管理員升級方案以使用 LINE 點餐功能。</div>
      </div>`;
    return;
  }

  container.innerHTML = infoHtml + `
    <div style="margin-bottom:20px">
      <div style="font-size:.8rem;color:var(--text-secondary,#64748b);margin-bottom:8px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">LINE 點餐網址</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <code id="lineOrderUrlDisplay" style="flex:1;min-width:200px;padding:10px 14px;background:rgba(0,0,0,.25);border-radius:8px;font-size:.8rem;word-break:break-all;border:1px solid rgba(255,255,255,.1)">${esc(lineUrl)}</code>
        <button class="btn-secondary" onclick="copyLineOrderUrl()" style="white-space:nowrap">📋 複製網址</button>
        <button class="btn-secondary" onclick="openLineOrderUrl()" style="white-space:nowrap">🔗 開啟點餐頁</button>
        <button class="btn-secondary" onclick="downloadLineOrderQR()" style="white-space:nowrap">⬇️ 下載 QR Code</button>
      </div>
    </div>
    <div style="text-align:center">
      <div style="font-size:.8rem;color:var(--text-secondary,#64748b);margin-bottom:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">QR Code（掃描後開啟 LINE 點餐頁）</div>
      <div id="lineQrContainer" style="display:inline-block;background:#fff;padding:12px;border-radius:12px">
        <canvas id="lineQrCanvas" width="220" height="220"></canvas>
      </div>
    </div>`;

  // 產生 QR Code
  _loadAndRenderQr(lineUrl);
}

// QR Code 產生 — fix14：本地 vendor 優先，多重 API fallback
// 載入順序：1. /js/qrcode.min.js（本地 vendor，已預載）
//           2. CDN qrcodejs fallback
//           3. 若都失敗，顯示網址連結（LINE 點餐網址仍可用）

function _loadAndRenderQr(url) {
  // 本地 vendor 已在 index.html 預載，通常直接可用
  if (typeof QRCode !== 'undefined') {
    _doRenderQr(url);
    return;
  }
  // fallback：動態載入 CDN
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  s.onload  = () => _doRenderQr(url);
  s.onerror = () => _doRenderQrFallback(url);  // CDN 也失敗
  document.head.appendChild(s);
}

function _doRenderQr(url) {
  // 使用我們的 qrcode.min.js（本地 vendor 版本使用 img API 方式）
  const container = document.getElementById('lineQrContainer');
  if (!container) return;
  try {
    const size = 220;
    const tmp  = document.createElement('div');
    container.innerHTML = '';
    container.appendChild(tmp);
    new QRCode(tmp, { text: url, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
    // QRCode 可能產生 img（API 模式）或 canvas（純 JS 模式）
    // 等待渲染後，把 canvas 複製進去供下載
    setTimeout(() => {
      const srcCanvas = tmp.querySelector('canvas');
      const srcImg    = tmp.querySelector('img') || (tmp._qrImg);
      // 建立可下載的 canvas
      let dlCanvas = document.getElementById('lineQrCanvas');
      if (!dlCanvas) {
        dlCanvas = document.createElement('canvas');
        dlCanvas.id = 'lineQrCanvas';
        dlCanvas.style.display = 'none';
        container.appendChild(dlCanvas);
      }
      dlCanvas.width = size; dlCanvas.height = size;
      const ctx = dlCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      if (srcCanvas) {
        ctx.drawImage(srcCanvas, 0, 0, size, size);
      } else if (srcImg && srcImg.complete && srcImg.naturalWidth > 0) {
        ctx.drawImage(srcImg, 0, 0, size, size);
      } else if (srcImg) {
        srcImg.onload = () => ctx.drawImage(srcImg, 0, 0, size, size);
      }
    }, 300);
  } catch(e) {
    _doRenderQrFallback(url);
  }
}

// 最終 fallback：不依賴任何第三方，顯示可複製的連結
function _doRenderQrFallback(url) {
  const container = document.getElementById('lineQrContainer');
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:20px;background:#fff;border-radius:8px;max-width:260px">' +
    '<div style="font-size:2rem;margin-bottom:8px">📲</div>' +
    '<div style="font-size:.75rem;color:#333;word-break:break-all;margin-bottom:10px">' +
    '<a href="' + url + '" target="_blank" style="color:#06C755">' + url + '</a></div>' +
    '<div style="font-size:.7rem;color:#888">QR Code 產生失敗<br>請複製上方網址使用</div>' +
    '</div>';
  // 確保下載按鈕仍有 canvas（空白）
  let dlCanvas = document.getElementById('lineQrCanvas');
  if (!dlCanvas) {
    dlCanvas = document.createElement('canvas');
    dlCanvas.id = 'lineQrCanvas';
    dlCanvas.width = 220; dlCanvas.height = 220;
    dlCanvas.style.display = 'none';
    container.appendChild(dlCanvas);
  }
}

/** 複製 LINE 點餐網址 */
function copyLineOrderUrl() {
  const store = window.currentStore;
  if (!store) return;
  const url = window.location.origin + '/line-order.html?store_id=' + encodeURIComponent(store.store_id);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url)
      .then(() => { if (typeof showToast === 'function') showToast('LINE 點餐網址已複製', 'success'); })
      .catch(() => _fallbackCopy(url));
  } else { _fallbackCopy(url); }
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); if (typeof showToast==='function') showToast('已複製','success'); } catch {}
  document.body.removeChild(ta);
}

/** 開啟 LINE 點餐頁（新分頁） */
function openLineOrderUrl() {
  const store = window.currentStore;
  if (!store) return;
  const url = window.location.origin + '/line-order.html?store_id=' + encodeURIComponent(store.store_id);
  window.open(url, '_blank');
}

/** 開啟 AI Marketing Center（新分頁，V2 Workspace 架構） */
function openAIMarketingCenter() {
  const store = window.currentStore;
  if (!store) return;
  const url = window.location.origin + '/ai-marketing/?store_id=' + encodeURIComponent(store.store_id);
  window.open(url, '_blank');
}

/** 下載 QR Code PNG — fix14：支援 img 和 canvas 兩種來源 */
function downloadLineOrderQR() {
  const store = window.currentStore;
  if (!store) return;

  const filename = 'line-order-' + store.store_id + '.png';

  // 優先用 canvas
  const canvas = document.getElementById('lineQrCanvas');
  if (canvas && canvas.width > 0) {
    try {
      const link = document.createElement('a');
      link.download = filename;
      link.href = canvas.toDataURL('image/png');
      link.click();
      return;
    } catch {}
  }

  // fallback：找 img 元素（API QR 模式）
  const container = document.getElementById('lineQrContainer');
  const img = container ? container.querySelector('img') : null;
  if (img && img.src && img.complete) {
    try {
      const c = document.createElement('canvas');
      c.width = 220; c.height = 220;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 220, 220);
      ctx.drawImage(img, 0, 0, 220, 220);
      const link = document.createElement('a');
      link.download = filename;
      link.href = c.toDataURL('image/png');
      link.click();
      return;
    } catch {}
  }

  if (typeof showToast === 'function') showToast('QR Code 尚未產生，請稍後再試', 'error');
}


// ── 單位換算工具（前端版）────────────────────────────────
const UNIT_TO_G = { '斤': 600, 'kg': 1000, 'g': 1 };
function toGrams(amount, unit) { return Number(amount) * (UNIT_TO_G[unit] || 1); }
function fromGrams(grams, unit) { return Number(grams) / (UNIT_TO_G[unit] || 1); }

// ===== POS 系統 前端邏輯 =====

const API = '';  // 同域，不需要前綴

// ===== 狀態 =====
let allProducts = [];
let filteredProducts = [];
let cart = [];
let selectedPayment = 'cash';
let settings = {};
let currentOrderForPrint = null;
let allPlatforms = [];       // 外送平台列表
let currentOrderMode = 'dine_in';  // 點餐模式：dine_in | takeout | delivery
let selectedPlatform = null;       // 選中的外送平台物件
let currentOrderTab = 'all';       // 訂單分頁
let currentOrderView = 'all';     // fix18-07：追蹤目前顯示的訂單視圖 ('all'|'takeout'|'delivery')
let currentDiscountFilter = 'all'; // fix18-09B：折扣篩選 ('all'|'has_discount'|'no_discount'|category)
let _allOrdersCache = [];          // fix18-09B：目前分頁全部訂單快取（供折扣篩選使用）
let orderInfoExpanded = true;      // 訂單資訊區展開狀態
let allPaymentMethods = [];        // 付款方式快取
let allDiscountCampaigns = [];     // fix18-09C：折扣活動快取
let allDiscountCategories = [];    // fix18-09E：折扣分類快取
let allProductAnalysisGroups = []; // fix18-09F：商品分析群組快取

// fix18-09E：報表卡片顯示設定
const REPORT_CARDS_STORAGE_KEY = 'orders_report_visible_cards';
const REPORT_ALL_CARDS = ['訂單數','原價營業額','折扣總額','實收營業額','平均客單價','平台抽成','店家實收','熱賣商品','折扣支出','折扣商品排行','折扣活動排行','外送平台卡片'];
const REPORT_SLIM_CARDS = ['訂單數','實收營業額','平均客單價','折扣總額','平台抽成','店家實收'];
function getVisibleCards() {
  try {
    const saved = localStorage.getItem(REPORT_CARDS_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return [...REPORT_ALL_CARDS]; // default all visible
}
function saveVisibleCards(arr) {
  try { localStorage.setItem(REPORT_CARDS_STORAGE_KEY, JSON.stringify(arr)); } catch {}
}
function isCardVisible(label) {
  return getVisibleCards().includes(label);
}

// 訂單編輯狀態
let editOrderItems = [];
let editOrderId = null;

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  startClock();
  initDateRange();

  // fix16c-hotfix: 正確初始化順序，避免 inventory 403 中斷商品載入
  await ensureLogin();

  if (!getToken()) return; // 未登入停止

  // 1. 先取店家授權（必須先於一切 feature gate 判斷）
  await loadCurrentStore();

  // 2. 核心設定（不受 feature gate 限制）
  await loadSettings().catch(() => {});
  await loadCategories().catch(() => {});
  await loadPaymentMethods().catch(() => {});
  await loadDiscountCampaigns().catch(() => {});  // fix18-09C
  await loadDiscountCategories().catch(() => {}); // fix18-09E
  await loadProductAnalysisGroups().catch(() => {}); // fix18-09F

  // 3. 商品載入（不依賴 inventory，不受 inventory feature gate 影響）
  await loadProducts().catch(() => {});

  // 4. 非必要功能（依 feature gate，各自容錯，不可阻斷前述流程）
  if (hasFeature('delivery')) {
    await loadPlatforms().catch(() => {});
  }
});

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    // 手動格式化避免 zh-TW locale 在部分環境回傳 h24 造成 24:xx:xx
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `${h}:${m}:${s}`;
  };
  tick();
  setInterval(tick, 1000);
}

function initDateRange() {
  // fix18-04：用台北時間，避免 UTC 時差導致初始日期錯誤
  const today = twTodayStr();
  const fromEl = document.getElementById('dateFrom');
  const toEl   = document.getElementById('dateTo');
  if (fromEl) fromEl.value = today;
  if (toEl)   toEl.value   = today;
}

// ===== 頁面切換 =====
let _invRefreshInterval = null;

function showPage(name) {
  // fix18-05: coupon feature gate — 攔截未授權的 coupons 頁面切換
  if (name === 'coupons') {
    const f = window.currentFeatures || {};
    if (!f.coupon) {
      showToast('此功能未授權，請聯絡系統管理員', 'error');
      name = 'pos'; // 導回點餐頁
    }
  }

  // fix16f: 強制用 style 切換，確保只有一個 page 顯示
  // classList 操作不夠——某些 page 有獨立 CSS 規則（如 #page-reports）需 style 覆蓋

  // 1. 隱藏所有 page
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
    p.style.display      = 'none';
    p.style.visibility   = 'hidden';
    p.style.pointerEvents = 'none';
  });

  // 2. 特別確保 reports 完全隱藏（防止殘留覆蓋）
  if (name !== 'reports') {
    const rp = document.getElementById('page-reports');
    const rc = document.getElementById('reports-container');
    if (rp) { rp.style.display = 'none'; rp.style.visibility = 'hidden'; rp.style.pointerEvents = 'none'; }
    if (rc) { rc.style.display = 'none'; rc.style.visibility = 'hidden'; rc.style.pointerEvents = 'none'; }
  }

  // fix18-09D-hotfix: 離開 settings 頁時強制隱藏所有 settings-tab-panel
  // 避免折扣活動等 panel 殘留覆蓋其他頁面
  if (name !== 'settings') {
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
      p.style.display       = 'none';
      p.style.visibility    = 'hidden';
      p.style.pointerEvents = 'none';
    });
  }

  // 3. 清除所有 nav active 狀態
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  // 4. 顯示目標頁
  const target = document.getElementById('page-' + name);
  if (target) {
    target.classList.add('active');
    target.style.display       = '';       // 讓 CSS .page.active 的 display:flex 生效
    target.style.visibility    = 'visible';
    target.style.pointerEvents = 'auto';
  }
  const navBtn = document.querySelector(`[data-page="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  // 5. reports 恢復容器顯示
  if (name === 'reports') {
    const rc = document.getElementById('reports-container');
    if (rc) { rc.style.display = ''; rc.style.visibility = 'visible'; rc.style.pointerEvents = 'auto'; }
  }

  // 6. 點餐頁庫存自動刷新
  if (name === 'pos') {
    if (!_invRefreshInterval)
      _invRefreshInterval = setInterval(refreshInventoryForProducts, 10000);
    refreshInventoryForProducts();
  } else {
    if (_invRefreshInterval) { clearInterval(_invRefreshInterval); _invRefreshInterval = null; }
  }

  // 7. 各頁資料載入
  if (name === 'orders')        loadCurrentOrderTab();
  if (name === 'products')      loadProductsPage();
  if (name === 'line_products') loadLineProductsPage();
  if (name === 'line_preorders') loadLinePreorders();
  if (name === 'coupons')      loadCouponsPage();   // fix18-05
  if (name === 'settings')   { loadSettingsPage(); switchSettingsTab('basic'); }
  if (name === 'categories') loadCategoriesPage();
  if (name === 'inventory')  loadInventoryPage();
  if (name === 'reports')    loadReportsPage();
  // 舊版內嵌 AI 行銷中心（#page-ai_marketing）已於 V3 移除，
  // 入口統一改為 openAIMarketingCenter() 開啟獨立 Workspace（/ai-marketing/）。
}

/**
 * refreshInventoryForProducts — 背景刷新庫存，不清空購物車或重置分類
 * 每 10 秒由 setInterval 呼叫，也可手動觸發（結帳後）
 */
async function refreshInventoryForProducts() {
  // fix16c-hotfix: inventory=false 時不呼叫 /api/inventory，避免 403 toast
  if (!hasFeature('inventory')) return;
  try {
    const invRes  = await fetch('/api/inventory', {
      headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }
    });
    if (!invRes.ok) return;
    const invJson = await invRes.json();
    if (!invJson.success) return;

    // 建立庫存 map
    const invMap = {};
    (invJson.data || []).forEach(iv => { invMap[iv.id] = iv; });

    // 更新 allProducts 中的庫存欄位（不重建陣列，只 merge）
    let cartAdjusted = false;
    allProducts = allProducts.map(p => {
      const iv = invMap[p.id];
      if (!iv) return p;
      const updated = {
        ...p,
        available_units: iv.available_units,
        available_grams: iv.available_grams != null ? iv.available_grams : iv.current_stock_grams,
        is_low_stock:    iv.is_low_stock,
        is_out_of_stock: iv.is_out_of_stock,
        uses_ingredient: iv.uses_ingredient,
      };
      // 購物車數量超出最新庫存時警示
      if (iv.available_units !== null && cart.find(c => c.productId === p.id)) {
        const cartItem = cart.find(c => c.productId === p.id);
        if (cartItem && cartItem.qty > iv.available_units) {
          if (!cartAdjusted) {
            const newQty = Math.max(0, iv.available_units);
            showToast(`庫存已更新，${p.name} 目前最多可售 ${newQty} 份`, 'info');
            cartItem.qty = newQty;
            if (cartItem.qty <= 0) cart = cart.filter(c => c.productId !== p.id);
            cartAdjusted = true;
          }
        }
      }
      return updated;
    });

    // 同步 filteredProducts
    const activeCat = document.querySelector('.cat-btn.active')?.dataset?.cat || 'all';
    filteredProducts = activeCat === 'all' ? allProducts : allProducts.filter(p => p.category === activeCat);

    // 只重繪商品格（不動購物車、分類、付款方式）
    renderProductGrid();
  } catch { /* silent — 背景刷新失敗不打擾使用者 */ }
}

// ===== 設定頁分頁 =====
let currentSettingsTab = 'basic';

function switchSettingsTab(tab) {
  currentSettingsTab = tab;
  document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
  // fix16f: 強制用 style 確保只有一個 panel 顯示
  document.querySelectorAll('.settings-tab-panel').forEach(p => {
    p.style.display       = 'none';
    p.style.visibility    = 'hidden';
    p.style.pointerEvents = 'none';
  });
  const panel = document.getElementById('stab-' + tab);
  if (panel) {
    panel.style.display       = 'block';
    panel.style.visibility    = 'visible';
    panel.style.pointerEvents = 'auto';
  }

  // 各 Tab 的資料載入
  if (tab === 'payment')          loadPaymentMethodsPage();
  if (tab === 'gateway')          loadGatewayCards();    // fix16e: only provider-based
  if (tab === 'platform')         loadPlatformsPage();
  if (tab === 'printer')          loadPrinterSettings();
  if (tab === 'line_biz')         loadLineBizStatus();
  if (tab === 'ingredients')      loadIngredientsPage();
  if (tab === 'line_entry')       loadLineEntryPage();
  if (tab === 'android_features') loadAndroidFeaturesTab(); // v18-features
  if (tab === 'discount_campaigns') loadDiscountCampaignsTab(); // fix18-09C
  if (tab === 'delivery_fee')     loadDeliveryFeeTab();     // fix18-06
  if (tab === 'product_analysis_groups') loadProductAnalysisGroupsTab(); // fix18-09F
}

// ===== 設定 =====
async function loadSettings() {
  try {
    const res = await apiFetch('/api/settings');
    const json = await res.json();
    if (json.success) {
      settings = json.data;
      document.getElementById('shopName').textContent = settings.shop_name || '餐車 POS';
    }
  } catch {}
}

async function loadSettingsPage() {
  await loadSettings();
  const fields = ['shop_name', 'n8n_webhook_url', 'line_channel_token', 'receipt_footer'];
  fields.forEach(k => {
    const el = document.getElementById('set-' + k);
    if (el) el.value = settings[k] || '';
  });

  // fix18-08：載入平台抽成率設定
  const commKeys = ['ubereats','foodpanda','line','pos','phone','other','unknown'];
  const defaults = { ubereats: 31, foodpanda: 35 };
  commKeys.forEach(code => {
    const key = code + '_commission_rate';
    const el = document.getElementById('set-' + key);
    if (!el) return;
    const val = settings[key];
    el.value = (val !== undefined && val !== '') ? val : (defaults[code] || 0);
  });
}

async function saveSettings() {
  const body = {};
  ['shop_name', 'n8n_webhook_url', 'line_channel_token', 'receipt_footer'].forEach(k => {
    const el = document.getElementById('set-' + k);
    if (el) body[k] = el.value;
  });
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      settings = json.data;
      document.getElementById('shopName').textContent = settings.shop_name || '餐車 POS';
      showToast('設定已儲存', 'success');
    }
  } catch {
    showToast('儲存失敗', 'error');
  }
}

// ===== 商品載入（永遠從 server 取最新庫存，不使用舊快取） =====
// fix18-08：平台抽成率設定儲存
async function saveCommissionRates() {
  const commKeys = ['ubereats','foodpanda','line','pos','phone','other','unknown'];
  const body = {};
  commKeys.forEach(code => {
    const el = document.getElementById('set-' + code + '_commission_rate');
    if (el) body[code + '_commission_rate'] = el.value;
  });
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      settings = json.data;
      showToast('抽成率設定已儲存', 'success');
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

async function loadProducts() {
  try {
    // fix16c-hotfix: 商品載入不依賴 inventory，inventory=false 時只跳過庫存 map
    const prodRes = await apiFetch('/api/products?enabled=1&_t=' + Date.now());
    const prodJson = await prodRes.json();

    // 僅在 inventory 有授權時才呼叫 /api/inventory（inventory=false 跳過，避免 403 toast）
    const invMap = {};
    if (hasFeature('inventory')) {
      try {
        const invRes  = await fetch('/api/inventory', {
          headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' }
        });
        if (invRes.ok) {
          const invJson = await invRes.json();
          if (invJson.success) {
            (invJson.data || []).forEach(iv => { invMap[iv.id] = iv; });
          }
        }
      } catch {} // 庫存不可用時靜默忽略
    }

    if (prodJson.success) {
      allProducts = prodJson.data.map(p => {
        // 合併 localStorage 圖片快取（base64 大圖）
        if (!p.image) {
          const local = getLocalImage(p.id);
          if (local) p = { ...p, image: local };
        }
        // 統一從 /api/inventory 取庫存數量
        const iv = invMap[p.id];
        if (iv) {
          // inventory 已包含單位換算後的正確數值
          p = {
            ...p,
            available_units: iv.available_units,
            available_grams: iv.current_stock_grams,
            is_low_stock:    iv.is_low_stock,
            is_out_of_stock: iv.is_out_of_stock,
            uses_ingredient: iv.uses_ingredient,
          };
        } else if (p.inventory_enabled && Number(p.allocated_grams) > 0 && !p.has_formula) {
          // fallback：商品自身庫存
          const freshUnits = Math.floor(Number(p.current_stock_grams) / Number(p.allocated_grams));
          p = {
            ...p,
            available_units: freshUnits,
            is_low_stock: freshUnits > 0 && freshUnits <= Number(p.low_stock_alert || 5),
            is_out_of_stock: freshUnits <= 0,
          };
        } else {
          p = { ...p, available_units: null, is_low_stock: false, is_out_of_stock: false };
        }
        return p;
      });
      // 保持目前篩選分類不變，重新渲染
      const activeCat = document.querySelector('.cat-btn.active')?.dataset?.cat || 'all';
      filteredProducts = activeCat === 'all' ? allProducts : allProducts.filter(p => p.category === activeCat);
      renderProductGrid();
    }
  } catch {
    showToast('商品載入失敗', 'error');
  }
}

// ===== 分類載入（供 POS Tab） =====
let allCategories = [];

async function loadCategories() {
  try {
    const res = await apiFetch('/api/categories?active=1');
    const json = await res.json();
    if (json.success) {
      allCategories = json.data;
      renderCategoryTabs();
    }
  } catch {}
}

function renderCategoryTabs() {
  const tabs = document.getElementById('categoryTabs');
  if (!tabs) return;
  tabs.innerHTML = `<button class="cat-btn active" data-cat="all" onclick="filterCategory('all')">全部</button>` +
    allCategories.map(c =>
      `<button class="cat-btn" data-cat="${escHtml(c.name)}" onclick="filterCategory('${escHtml(c.name)}')">${c.icon||''} ${escHtml(c.name)}</button>`
    ).join('');
}

function filterCategory(cat) {
  document.querySelectorAll('.cat-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
  filteredProducts = cat === 'all' ? allProducts : allProducts.filter(p => p.category === cat);
  renderProductGrid();
}

// 取得商品在目前模式的有效價格（含 fallback）
function getProductPrice(product, mode) {
  mode = mode || currentOrderMode || 'dine_in';
  if (mode === 'dine_in')  return Number(product.dine_in_price)  || Number(product.price) || 0;
  if (mode === 'takeout')  return Number(product.takeaway_price) || Number(product.dine_in_price) || Number(product.price) || 0;
  if (mode === 'delivery') return Number(product.delivery_price) || Number(product.takeaway_price) || Number(product.dine_in_price) || Number(product.price) || 0;
  return Number(product.price) || 0;
}

function renderProductGrid() {
  const grid = document.getElementById('productGrid');
  if (!filteredProducts.length) {
    grid.innerHTML = '<div class="loading-card">此分類暫無商品</div>';
    return;
  }
  const catEmoji = {};
  allCategories.forEach(c => { catEmoji[c.name] = c.icon || '📌'; });

  grid.innerHTML = filteredProducts.map(p => {
    const imgSrc = p.image || getLocalImage(p.id) || '';
    const imgHtml = imgSrc
      ? `<img class="product-card-img" src="${escAttr(imgSrc)}" alt="${escAttr(p.name)}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholderHtml = `
      <div class="product-card-img-placeholder" ${imgSrc ? 'style="display:none"' : ''}>
        <span class="product-card-img-placeholder-icon">${catEmoji[p.category] || '🍽️'}</span>
        <span class="product-card-img-placeholder-cat">${p.category}</span>
      </div>`;

    // 庫存徽章 — 統一從 available_units 讀取（已由 loadProducts 從 /api/inventory 同步）
    let stockBadge = '';
    let soldOutClass = '';
    if (p.inventory_enabled && p.available_units !== null && p.available_units !== undefined) {
      const units    = p.available_units;
      const lowAlert = Number(p.low_stock_alert || 5);
      if (units <= 0) {
        soldOutClass = ' sold-out';
        stockBadge = `<div class="product-card-stock zero">🔴 售完</div>`;
      } else if (units <= lowAlert) {
        stockBadge = `<div class="product-card-stock low">🟡 剩 ${units} 份</div>`;
      } else {
        stockBadge = `<div class="product-card-stock ok">🟢 剩 ${units} 份</div>`;
      }
    }

    // 依目前模式顯示正確價格
    const modePrice = getProductPrice(p, currentOrderMode);
    const priceLabel = currentOrderMode === 'delivery' ? '<span class="delivery-price-tag">外送</span>' : '';

    return `
      <div class="product-card${soldOutClass}" id="pc-${p.id}" onclick="addToCart(${p.id})">
        <div class="product-card-img-wrap">
          ${imgHtml}
          ${placeholderHtml}
        </div>
        <div class="product-card-body">
          <div class="product-card-name">${escHtml(p.name)}</div>
          <div class="product-card-price">${priceLabel}$${modePrice}</div>
          ${stockBadge}
        </div>
      </div>`;
  }).join('');
}

// ===== 購物車 =====
function addToCart(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;

  // 即時庫存防護：已售完直接擋（使用已同步的 available_units）
  if (product.inventory_enabled && product.available_units !== null && product.available_units !== undefined) {
    const units = product.available_units;
    const alreadyInCart = cart.find(i => i.productId === productId)?.qty || 0;
    if (units <= 0) {
      showToast(`${product.name} 已售完`, 'error');
      return;
    }
    if (alreadyInCart >= units) {
      showToast(`${product.name} 庫存不足（最多 ${units} 份）`, 'error');
      return;
    }
  }

  // 動畫
  const card = document.getElementById('pc-' + productId);
  if (card) {
    card.classList.add('added');
    setTimeout(() => card.classList.remove('added'), 400);
  }

  const existing = cart.find(i => i.productId === productId);
  if (existing) {
    existing.qty++;
    existing.subtotal = existing.price * existing.qty;
  } else {
    // 使用當前模式價格（加入後不隨模式切換變動）
    const modePrice = getProductPrice(product, currentOrderMode);
    cart.push({
      productId,
      name: product.name,
      price: modePrice,
      orderMode: currentOrderMode,
      qty: 1,
      subtotal: modePrice
    });
  }
  renderCart();
}

function updateQty(productId, delta) {
  const idx = cart.findIndex(i => i.productId === productId);
  if (idx === -1) return;
  cart[idx].qty += delta;
  if (cart[idx].qty <= 0) {
    cart.splice(idx, 1);
  } else {
    cart[idx].subtotal = cart[idx].price * cart[idx].qty;
  }
  renderCart();
}

function removeFromCart(productId) {
  cart = cart.filter(i => i.productId !== productId);
  renderCart();
}

function clearCart() {
  cart = [];
  // 清空各模式欄位（容錯：元素可能不存在）
  const safeVal = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };
  safeVal('customerPhone'); safeVal('customerName'); safeVal('orderNote');
  safeVal('tableNumber'); safeVal('guestCount');
  safeVal('pickupName'); safeVal('takeoutPhone'); safeVal('pickupTime'); safeVal('notetakeout');
  safeVal('deliveryName'); safeVal('deliveryPhone'); safeVal('deliveryAddress');
  safeVal('estimatedDelivery'); safeVal('notedelivery'); safeVal('platformOrderNo');
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  selectedPlatform = null;
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  if (cart.length === 0) {
    container.innerHTML = `
      <div class="cart-empty">
        <span class="cart-empty-icon">🛒</span>
        <p>點選左側商品加入</p>
      </div>
    `;
  } else {
    container.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-name">${escHtml(item.name)}</div>
        <div class="cart-item-qty">
          <button class="qty-btn" onclick="updateQty(${item.productId}, -1)">−</button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="updateQty(${item.productId}, 1)">＋</button>
        </div>
        <div class="cart-item-price">$${item.subtotal}</div>
        <button class="cart-item-del" onclick="removeFromCart(${item.productId})">✕</button>
      </div>
    `).join('');
  }

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0);
  document.getElementById('subtotalDisplay').textContent = '$' + subtotal;
  document.getElementById('totalDisplay').textContent = '$' + subtotal;

  // 更新找零面板應收金額
  const cashDue = document.getElementById('cashDue');
  if (cashDue) cashDue.textContent = 'NT$' + subtotal;

  updateCheckoutButton();
  calcChange();
  // 外送模式：同步更新抽成計算
  if (typeof updateDeliveryCalc === 'function') updateDeliveryCalc();
}

// ===== 現金找零計算 =====
function calcChange() {
  const total = cart.reduce((s, i) => s + i.subtotal, 0);
  const receivedEl = document.getElementById('receivedAmount');
  const changeEl   = document.getElementById('changeAmount');
  const warnEl     = document.getElementById('cashWarn');
  if (!receivedEl) return;

  const received = parseFloat(receivedEl.value) || 0;
  const change = received - total;

  if (changeEl) changeEl.textContent = change >= 0 ? 'NT$' + change : 'NT$0';
  if (warnEl)   warnEl.style.display = (received > 0 && change < 0) ? 'block' : 'none';
  updateCheckoutButton();
}

function updateCheckoutButton() {
  const btn = document.getElementById('checkoutBtn');
  if (!btn) return;
  const total = cart.reduce((s, i) => s + i.subtotal, 0);
  if (cart.length === 0) { btn.disabled = true; return; }
  if (selectedPayment === 'cash') {
    const received = parseFloat(document.getElementById('receivedAmount')?.value || '0') || 0;
    btn.disabled = received < total;
  } else {
    btn.disabled = false;
  }
}

function selectPayment(method) {
  selectedPayment = method;
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === method);
  });
  const panel = document.getElementById('cashChangePanel');
  if (panel) panel.style.display = method === 'cash' ? 'block' : 'none';
  if (method !== 'cash') {
    const r = document.getElementById('receivedAmount');
    if (r) r.value = '';
    const w = document.getElementById('cashWarn');
    if (w) w.style.display = 'none';
  }
  updateCheckoutButton();
}

// ===== 動態付款方式 =====
async function loadPaymentMethods() {
  // fix16k: payment_methods feature gate
  if (!hasFeature('payment_methods')) {
    allPaymentMethods = [];
    renderPaymentMethods(); // will show feature disabled message
    return;
  }
  try {
    const res  = await apiFetch('/api/payment-methods?active=1');
    const json = await res.json();
    if (json.success) {
      allPaymentMethods = json.data;
      renderPaymentMethods();
    }
  } catch {}
}

function renderPaymentMethods() {
  const container = document.getElementById('paymentMethodsContainer');
  const warnEl    = document.getElementById('paymentWarn');
  if (!container) return;

  // 依當前模式過濾
  const modeKey = {
    dine_in:  'enable_for_dine_in',
    takeout:  'enable_for_takeout',
    delivery: 'enable_for_delivery',
  }[currentOrderMode] || 'enable_for_dine_in';

  const available = allPaymentMethods.filter(m => m.is_active && m[modeKey]);

  // fix16k: payment_methods feature gate
  if (!hasFeature('payment_methods')) {
    container.innerHTML = '';
    if (warnEl) {
      warnEl.textContent = '⚠️ 付款方式功能未啟用，請聯絡系統管理員';
      warnEl.style.display = 'block';
    }
    return;
  }
  if (!available.length) {
    container.innerHTML = '';
    if (warnEl) warnEl.style.display = 'block';
    return;
  }
  if (warnEl) warnEl.style.display = 'none';

  container.innerHTML = available.map(m =>
    `<button class="pay-btn${m.is_default && !selectedPayment ? ' active' : selectedPayment === m.code ? ' active' : ''}"
       data-method="${m.code}" onclick="selectPayment('${m.code}')">${m.icon} ${m.name}</button>`
  ).join('');

  // 若目前 selectedPayment 不在可用清單中，自動選預設
  if (!available.find(m => m.code === selectedPayment)) {
    const def = available.find(m => m.is_default) || available[0];
    if (def) selectPayment(def.code);
  }
}

// ===== 結帳 =====
async function checkout() {
  if (cart.length === 0) return;

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0);
  const isCash   = selectedPayment === 'cash';
  const receivedRaw = parseFloat(document.getElementById('receivedAmount')?.value || '0') || 0;
  const received = isCash ? receivedRaw : subtotal;
  const change   = isCash ? Math.max(0, received - subtotal) : 0;

  if (isCash && received < subtotal) {
    showToast('實收金額不足，無法結帳', 'error');
    return;
  }

  // 外送模式：必須選擇平台
  if (currentOrderMode === 'delivery' && !selectedPlatform) {
    showToast('請先選擇外送平台', 'error');
    return;
  }

  // 外送模式：平台單號必填
  if (currentOrderMode === 'delivery') {
    const pno = document.getElementById('platformOrderNo')?.value?.trim() || '';
    if (!pno) {
      showToast('請輸入外送單號', 'error');
      document.getElementById('platformOrderNo')?.focus();
      return;
    }
  }

  // 蒐集模式欄位
  let modeFields = {};
  if (currentOrderMode === 'dine_in') {
    modeFields = {
      table_number:  document.getElementById('tableNumber')?.value?.trim() || '',
      guest_count:   parseInt(document.getElementById('guestCount')?.value) || 0,
      note:          document.getElementById('notedinein')?.value?.trim() || '',
    };
  } else if (currentOrderMode === 'takeout') {
    modeFields = {
      pickup_name:  document.getElementById('pickupName')?.value?.trim() || '',
      customer_phone: document.getElementById('takeoutPhone')?.value?.trim() || '',
      pickup_time:  document.getElementById('pickupTime')?.value || '',
      note:         document.getElementById('notetakeout')?.value?.trim() || '',
    };
  } else if (currentOrderMode === 'delivery') {
    modeFields = {
      delivery_platform:  selectedPlatform?.name || '',
      platform_order_no:  document.getElementById('platformOrderNo')?.value?.trim() || '',
      customer_name:      document.getElementById('deliveryName')?.value?.trim() || '',
      customer_phone:     document.getElementById('deliveryPhone')?.value?.trim() || '',
      delivery_address:   document.getElementById('deliveryAddress')?.value?.trim() || '',
      estimated_delivery: document.getElementById('estimatedDelivery')?.value || '',
      note:               document.getElementById('notedelivery')?.value?.trim() || '',
    };
  }

  const btn = document.getElementById('checkoutBtn');
  btn.disabled = true;
  btn.textContent = '處理中...';

  const payload = {
    items: cart.map(i => ({
      productId: i.productId,
      name: i.name,
      price: i.price,
      qty: i.qty,
      subtotal: i.subtotal
    })),
    payment_method: selectedPayment,
    order_mode: currentOrderMode,
    order_status: currentOrderMode === 'delivery' ? 'preparing' : 'completed',
    received_amount: received,
    change_amount: change,
    ...modeFields,
  };

  try {
    const res = await apiFetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (json.success) {
      currentOrderForPrint = json.data;
      showReceiptModal(json.data);
      clearCart();
      const r = document.getElementById('receivedAmount');
      if (r) r.value = '';
      calcChange();
      _invProducts = [];
      loadProducts();
      // 結帳成功後立即刷新庫存（不等下一個 10 秒週期）
      refreshInventoryForProducts();
    } else {
      showToast('結帳失敗：' + (json.message || '未知錯誤'), 'error');
    }
  } catch {
    showToast('網路錯誤，請重試', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '結帳';
  }
}

// ===== 收據 Modal =====
function showReceiptModal(order) {
  const payLabel = {
    cash:'💵 現金', linepay:'💚 LINE Pay', card:'💳 刷卡',
    transfer:'🏦 轉帳', jkopay:'🟠 街口', platform:'📱 平台'
  };
  document.getElementById('receiptShopName').textContent = settings.shop_name || '餐車 POS';
  document.getElementById('receiptOrderNum').textContent = '訂單：' + order.order_number;
  document.getElementById('receiptTime').textContent = twTime(order.created_at,'datetime');
  document.getElementById('receiptPayment').textContent = payLabel[order.payment_method] || order.payment_method;
  document.getElementById('receiptTotal').textContent = 'NT$' + order.total;
  document.getElementById('receiptFooter').textContent = settings.receipt_footer || '感謝您的光臨！';

  // 模式資訊
  const modeInfo = [];
  if (order.order_mode === 'dine_in' && order.table_number) modeInfo.push(`桌號：${order.table_number}`);
  if (order.order_mode === 'takeout' && order.pickup_name)  modeInfo.push(`取餐人：${order.pickup_name}`);
  // pickup_time：LINE 訂單取餐時間（有值且非「盡快」才顯示）
  if (order.pickup_time && order.pickup_time.trim() && order.pickup_time !== '盡快')
    modeInfo.push(`⏰ 取餐時間：${order.pickup_time}`);
  else if (order.pickup_time === '盡快')
    modeInfo.push(`⏰ 取餐時間：盡快`);
  if (order.order_mode === 'delivery') {
    if (order.delivery_platform) modeInfo.push(`平台：${order.delivery_platform}`);
    if (order.delivery_address)  modeInfo.push(`地址：${order.delivery_address}`);
    if (order.platform_commission_rate > 0) {
      modeInfo.push(`抽成：${order.platform_commission_rate}%（NT$${order.platform_commission_amount}）`);
      modeInfo.push(`店家實收：NT$${order.store_actual_income}`);
    }
  }

  // 現金找零
  const isCash = order.payment_method === 'cash';
  const recvRow   = document.getElementById('receiptReceivedRow');
  const changeRow = document.getElementById('receiptChangeRow');
  if (recvRow)   recvRow.style.display   = isCash ? 'flex' : 'none';
  if (changeRow) changeRow.style.display = isCash ? 'flex' : 'none';
  if (isCash) {
    const recv = document.getElementById('receiptReceived');
    const chng = document.getElementById('receiptChange');
    if (recv) recv.textContent = 'NT$' + (order.received_amount || 0);
    if (chng) chng.textContent = 'NT$' + (order.change_amount   || 0);
  }

  const body = document.getElementById('receiptBody');
  body.innerHTML =
    (modeInfo.length ? `<div style="font-size:12px;color:var(--text-muted);padding:6px 0;border-bottom:1px dashed #333;margin-bottom:6px">${modeInfo.join('　')}</div>` : '') +
    order.items.map(i => `
      <div class="receipt-item">
        <span class="receipt-item-name">${escHtml(i.name)}</span>
        <span class="receipt-item-qty">x${i.qty}</span>
        <span class="receipt-item-price">$${i.subtotal}</span>
      </div>`).join('');

  document.getElementById('successModal').classList.add('open');

  // 顯示自動列印提示
  const msgEl = document.getElementById('printStatusMsg');
  if (msgEl) {
    const autoPrint = settings.auto_print;
    if (autoPrint) {
      msgEl.style.display = 'block';
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = '✅ 已送出自動列印';
    } else {
      msgEl.style.display = 'none';
    }
  }
}

function closeSuccess() {
  document.getElementById('successModal').classList.remove('open');
  currentOrderForPrint = null;
}

// 「完成」按鈕：只關閉 modal，列印已在建立訂單後自動執行
function completeCheckout() {
  closeSuccess();
}

function printReceipt() {
  if (!currentOrderForPrint) return;
  openPrintWindow(currentOrderForPrint);
  // 同時呼叫後端 ESC/POS 列印
  if (currentOrderForPrint.id) {
    apiFetch(`/api/orders/${currentOrderForPrint.id}/reprint`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'receipt' })
    }).then(r => r.json()).then(j => {
      if (j?.printResult?.success === false) showToast('ESC/POS: ' + (j.printResult.message || '列印失敗'), 'error');
    }).catch(() => {});
  }
}

function printOrderReceipt() {
  if (!currentOrderForPrint) return;
  openPrintWindow(currentOrderForPrint);
}

function openPrintWindow(order, printType='receipt') {
  const payLabel = { cash: '現金', linepay: 'LINE Pay', card: '刷卡', transfer: '轉帳', jkopay: '街口', platform: '平台付款' };
  const modeLabel = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
  const shopName = settings.shop_name || '餐車 POS';
  const footer = settings.receipt_footer || '感謝您的光臨！';
  const isVoid = order.status === 'void';
  const isCash = order.payment_method === 'cash';
  const mode   = modeLabel[order.order_mode] || '';

  const itemsHtml = order.items.map(i =>
    `<tr>
       <td>${escHtml(i.name)}</td>
       <td style="text-align:center">x${i.qty}</td>
       <td style="text-align:center">$${i.price||''}</td>
       <td style="text-align:right">$${i.subtotal}</td>
     </tr>`
  ).join('');

  const cashRows = isCash ? `
    <tr><td>實收</td><td colspan="3" style="text-align:right">NT$${order.received_amount || 0}</td></tr>
    <tr><td>找零</td><td colspan="3" style="text-align:right">NT$${order.change_amount || 0}</td></tr>
  ` : '';

  const voidBanner = isVoid ? `<p style="text-align:center;color:red;font-size:16px;font-weight:bold;border:2px solid red;padding:4px;margin:6px 0">【 已作廢 】</p>` : '';

  // 外送資訊區塊
  const deliveryRows = order.order_mode === 'delivery' ? `
    ${order.delivery_platform ? `<tr><td>外送平台</td><td colspan="3" style="text-align:right">${escHtml(order.delivery_platform)}</td></tr>` : ''}
    ${order.platform_order_no ? `<tr><td>平台單號</td><td colspan="3" style="text-align:right">${escHtml(order.platform_order_no)}</td></tr>` : ''}
    ${order.customer_name     ? `<tr><td>顧客</td><td colspan="3" style="text-align:right">${escHtml(order.customer_name)}</td></tr>` : ''}
    ${order.customer_phone    ? `<tr><td>電話</td><td colspan="3" style="text-align:right">${escHtml(order.customer_phone)}</td></tr>` : ''}
    ${order.delivery_address  ? `<tr><td>地址</td><td colspan="3" style="text-align:right">${escHtml(order.delivery_address)}</td></tr>` : ''}
    ${order.pickup_time       ? `<tr><td>⏰取餐時間</td><td colspan="3" style="text-align:right">${escHtml(order.pickup_time)}</td></tr>` : ''}
  ` : order.order_mode === 'dine_in' && order.table_number ? `
    <tr><td>桌號</td><td colspan="3" style="text-align:right">${escHtml(order.table_number)}</td></tr>
  ` : order.order_mode === 'takeout' ? `
    ${order.pickup_name ? `<tr><td>取餐人</td><td colspan="3" style="text-align:right">${escHtml(order.pickup_name)}</td></tr>` : ''}
    ${order.pickup_time ? `<tr><td>⏰取餐時間</td><td colspan="3" style="text-align:right">${escHtml(order.pickup_time)}</td></tr>` : ''}
  ` : '';

  const html = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${isVoid ? '[作廢]' : ''}訂單收據</title>
    <style>
      body { font-family: monospace; font-size: 13px; width: 80mm; margin: 0 auto; padding: 8px; }
      h2 { text-align: center; font-size: 18px; margin: 0 0 2px; }
      .center { text-align: center; }
      .mode { text-align: center; font-size: 12px; margin-bottom: 4px; }
      .dashed { border-top: 1px dashed #000; margin: 6px 0; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 2px 2px; font-size: 12px; }
      .total { font-size: 15px; font-weight: bold; }
      @media print { @page { margin: 0; } body { padding: 0; } }
    </style>
  </head><body>
    <h2>${shopName}</h2>
    ${mode ? `<div class="mode">【${mode}】</div>` : ''}
    ${voidBanner}
    <p class="center" style="font-size:11px">訂單：${order.order_number}</p>
    <p class="center" style="font-size:11px">${twTime(order.created_at,'datetime')}</p>
    <div class="dashed"></div>
    <table>
      <tr style="font-weight:bold;border-bottom:1px solid #000"><td>品項</td><td style="text-align:center">數量</td><td style="text-align:center">單價</td><td style="text-align:right">小計</td></tr>
      ${itemsHtml}
    </table>
    <div class="dashed"></div>
    <table>
      ${deliveryRows}
      <tr><td>付款方式</td><td colspan="3" style="text-align:right">${payLabel[order.payment_method] || order.payment_method}</td></tr>
      ${order.note ? `<tr><td>備註</td><td colspan="3" style="text-align:right">${escHtml(order.note)}</td></tr>` : ''}
    </table>
    <div class="dashed"></div>
    <table>
      <tr class="total"><td>應收</td><td colspan="3" style="text-align:right">NT$${order.total}</td></tr>
      ${cashRows}
    </table>
    ${order.order_mode === 'delivery' && Number(order.platform_commission_amount) > 0 ? `
    <div class="dashed"></div>
    <table>
      <tr><td>平台抽成(${order.platform_commission_rate}%)</td><td colspan="3" style="text-align:right">NT$${order.platform_commission_amount}</td></tr>
      <tr><td>店家實收</td><td colspan="3" style="text-align:right">NT$${order.store_actual_income}</td></tr>
    </table>` : ''}
    <div class="dashed"></div>
    <p class="center" style="font-size:12px">${footer}</p>
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 1200); }</scr` + `ipt>
  </body></html>`;

  const w = window.open('', '_blank', 'width=420,height=700');
  if (w) { w.document.write(html); w.document.close(); }
  else { showToast('無法開啟列印視窗，請允許彈出視窗', 'error'); }
}

// ===== 日期區間控制 =====
let currentDateRange = 'today';

function setDateRange(range) {
  currentDateRange = range;
  document.querySelectorAll('.shortcut-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  const customDiv = document.getElementById('customDateRange');
  if (customDiv) customDiv.style.display = range === 'custom' ? 'flex' : 'none';
  // fix18-04：用台北時間避免 UTC 時差
  const today = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'}));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  let from = fmt(today), to = fmt(today);
  if (range === 'yesterday') { const y = new Date(today); y.setDate(y.getDate()-1); from = to = fmt(y); }
  else if (range === 'week') { const mon = new Date(today); mon.setDate(today.getDate()-today.getDay()+(today.getDay()===0?-6:1)); from = fmt(mon); to = fmt(today); }
  else if (range === 'month') { from = fmt(new Date(today.getFullYear(),today.getMonth(),1)); to = fmt(today); }
  else if (range === 'lastmonth') {
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthFirst = new Date(firstOfMonth); lastMonthFirst.setMonth(lastMonthFirst.getMonth()-1);
    const lastMonthLast  = new Date(firstOfMonth); lastMonthLast.setDate(0);
    from = fmt(lastMonthFirst); to = fmt(lastMonthLast);
  }
  const fromEl = document.getElementById('dateFrom'); const toEl = document.getElementById('dateTo');
  if (fromEl && range !== 'custom') fromEl.value = from;
  if (toEl   && range !== 'custom') toEl.value   = to;
  if (range !== 'custom') loadCurrentOrderTab();
}

// ===== 訂單分頁切換 =====
function switchOrderTab(tab) {
  currentOrderTab = tab;
  // fix18-07：切換分頁時同步更新 currentOrderView
  if (tab === 'delivery') currentOrderView = 'delivery';
  else if (tab === 'pos') currentOrderView = 'takeout';
  else currentOrderView = 'all';
  document.querySelectorAll('.order-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('order-tab-all').style.display      = tab === 'delivery' ? 'none' : 'block';
  document.getElementById('order-tab-delivery').style.display = tab === 'delivery' ? 'block' : 'none';
  // fix18-09B：切換分頁時重置折扣篩選
  currentDiscountFilter = 'all';
  document.querySelectorAll('.disc-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  refreshCurrentOrderView();
}

// fix18-07：統一刷新函式，依 currentOrderView 決定呼叫哪個載入函式
function refreshCurrentOrderView() {
  switch (currentOrderView) {
    case 'delivery':
      loadDeliveryReport();
      break;
    case 'takeout':
      loadOrders('pos');
      break;
    default:
      loadOrders(null);
  }
}

function loadCurrentOrderTab() {
  refreshCurrentOrderView();
}

// fix18-09E：折扣分類動態版（從 allDiscountCategories 讀取，fallback 預設）
const DISCOUNT_CATEGORY_DISPLAY_FALLBACK = {
  none: '無折扣', marketing: '廣告行銷', product_promo: '商品活動',
  complaint: '客訴補償', loyalty: '老客優惠', staff_family: '員工親友',
  platform_promo: '平台活動', other: '其他'
};
// 動態取得分類顯示名稱（優先 DB，fallback 預設）
function getDiscountCategoryDisplay(code) {
  if (!code || code === 'none') return '無折扣';
  if (allDiscountCategories.length) {
    const found = allDiscountCategories.find(c => c.code === code);
    if (found) return found.name;
  }
  return DISCOUNT_CATEGORY_DISPLAY_FALLBACK[code] || code;
}
// 相容舊呼叫：DISCOUNT_CATEGORY_DISPLAY[cat] 改成 proxy
const DISCOUNT_CATEGORY_DISPLAY = new Proxy(DISCOUNT_CATEGORY_DISPLAY_FALLBACK, {
  get(target, key) {
    if (allDiscountCategories.length) {
      const found = allDiscountCategories.find(c => c.code === key);
      if (found) return found.name;
    }
    return target[key];
  }
});

function normalizeDiscountCategory(value) {
  if (!value || value === '' || value === 'undefined') return 'none';
  const v = String(value).trim().toLowerCase();
  if (v === 'none') return 'none';
  // fix18-09E：動態分類支援
  if (allDiscountCategories.length) {
    const found = allDiscountCategories.find(c => c.code === v);
    if (found) return found.code;
  }
  // fallback 預設 code 列表
  const defaults = ['marketing','product_promo','complaint','loyalty','staff_family','platform_promo','other'];
  return defaults.includes(v) ? v : v; // 保留原始值，讓歷史資料顯示
}
// fix18-09B：折扣篩選邏輯
function applyDiscountFilter(orders, filter) {
  if (!filter || filter === 'all') return orders;
  if (filter === 'has_discount') return orders.filter(o => Number(o.discount_amount || 0) > 0);
  if (filter === 'no_discount')  return orders.filter(o => Number(o.discount_amount || 0) <= 0);
  // 分類篩選
  return orders.filter(o => {
    if (Number(o.discount_amount || 0) <= 0) return false;
    return normalizeDiscountCategory(o.discount_category) === filter;
  });
}

// fix18-09B：設定折扣篩選並刷新列表
function setDiscountFilter(filter) {
  currentDiscountFilter = filter;
  // 更新 button active 狀態
  document.querySelectorAll('.disc-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  // 用快取重新 render（不重新請求 API）
  const filtered = applyDiscountFilter(_allOrdersCache, filter);
  if (currentOrderView === 'delivery') {
    renderDeliveryTable(filtered);
  } else {
    renderOrdersTable(filtered);
  }
}

// fix18-09B：開啟折扣明細彈窗
function openDiscountDetail() {
  const orders = (_allOrdersCache || []).filter(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return false;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return Number(o.discount_amount || 0) > 0;
  }).sort((a, b) => Number(b.discount_amount) - Number(a.discount_amount));

  const totalDisc = orders.reduce((s, o) => s + Number(o.discount_amount || 0), 0);
  document.getElementById('discDetailTitle').textContent = `共 ${orders.length} 筆，折扣總額 NT$${Math.round(totalDisc)}`;
  document.getElementById('discDetailSummary').innerHTML =
    `<span style="color:var(--text-secondary)">篩選範圍：</span> 目前分頁所有有折扣訂單（${orders.length} 筆）｜折扣合計：<span style="color:var(--danger);font-weight:700">NT$${Math.round(totalDisc)}</span>`;

  document.getElementById('discDetailBody').innerHTML = orders.length
    ? orders.map(o => {
        const disc = Number(o.discount_amount || 0);
        const cat = normalizeDiscountCategory(o.discount_category);
        const catLabel = DISCOUNT_CATEGORY_DISPLAY[cat] || '—';
        const dateStr = o.created_at ? o.created_at.slice(0, 10) : '—';
        // fix18-09C：顯示折扣活動、折扣商品
        const campaignName = o.discount_campaign_name || '—';
        // fix18-09D：多商品
        const _pnms = Array.isArray(o.discount_product_names)&&o.discount_product_names.length
          ? o.discount_product_names
          : (o.discount_product_name ? o.discount_product_name.split('、').map(s=>s.trim()).filter(Boolean) : []);
        const _isProd = (o.discount_target_type==='products'||o.discount_target_type==='product');
        const productName  = (_isProd && _pnms.length) ? _pnms.join('、') : '整張訂單';
        return `<tr>
          <td style="font-size:12px;color:#999;white-space:nowrap">${dateStr}</td>
          <td><span class="order-num" style="font-size:12px">${escHtml(o.order_number)}</span></td>
          <td style="font-size:12px;color:var(--text-secondary)">${escHtml(campaignName)}</td>
          <td style="font-size:12px;color:var(--text-secondary)">${escHtml(productName)}</td>
          <td style="font-family:monospace;color:var(--danger);font-weight:700">-NT$${disc}</td>
          <td>${cat && cat !== 'none' ? `<span class="disc-badge disc-badge-${cat}">${catLabel}</span>` : '<span style="color:var(--text-muted);font-size:12px">—</span>'}</td>
          <td style="font-size:12px;color:var(--text-secondary);max-width:120px">${escHtml(o.discount_note || '—')}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:16px">無折扣訂單</td></tr>';

  document.getElementById('discountDetailModal').classList.add('open');
}

function closeDiscountDetail() {
  document.getElementById('discountDetailModal').classList.remove('open');
}


// ===== 訂單頁 =====
// 計算統計（從前端已篩選 orders 陣列計算，確保列表與統計一致）
function calcStatsFromOrders(orders) {
  // 排除作廢
  const valid = orders.filter(o => {
    if (o.status === 'void') return false;
    if (o.order_status === 'cancelled') return false;
    // 外送訂單：只有 delivery_status=completed 才計入；cancelled 排除；preparing/delivering 仍計入（進行中）
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return true;
  });
  const order_count        = valid.length;
  const total_revenue      = valid.reduce((s, o) => s + Number(o.total || 0), 0);
  const total_discount     = valid.reduce((s, o) => s + Number(o.discount_amount || 0), 0);
  const total_original     = valid.reduce((s, o) => {
    const disc = Number(o.discount_amount || 0);
    const tot  = Number(o.total || 0);
    return s + (o.original_total ? Number(o.original_total) : tot + disc);
  }, 0);
  const avg_order          = order_count > 0 ? total_revenue / order_count : 0;
  const total_commission   = valid.reduce((s, o) => s + Number(o.platform_commission_amount || 0), 0);
  const total_store_income = valid.reduce((s, o) => s + Number(o.store_actual_income || o.total || 0), 0);

  // 熱賣商品
  const productMap = {};
  valid.forEach(o => {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    items.forEach(item => {
      if (!productMap[item.name]) productMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
      productMap[item.name].qty    += Number(item.qty || 0);
      productMap[item.name].revenue += Number(item.subtotal || 0);
    });
  });
  const top_products = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

  // fix18-09：折扣分類統計
  const discount_by_category = {};
  valid.forEach(o => {
    const disc = Number(o.discount_amount || 0);
    if (disc <= 0) return;
    const cat = normalizeDiscountCategory(o.discount_category);
    if (!discount_by_category[cat]) discount_by_category[cat] = 0;
    discount_by_category[cat] += disc;
  });

  return { order_count, total_revenue, total_discount, total_original, avg_order,
           total_commission, total_store_income, top_products, discount_by_category };
}

async function loadOrders(modeFilter) {
  const from = document.getElementById('dateFrom')?.value;
  const to   = document.getElementById('dateTo')?.value;
  // fix18-04：用台北時間 today，避免 UTC 時差導致 LINE 訂單消失
  const today = twTodayStr();
  const dateFrom = from || today, dateTo = to || today;
  try {
    const res = await apiFetch(`/api/orders?date_from=${dateFrom}&date_to=${dateTo}`);
    const json = await res.json();
    let orders = json.success ? json.data : [];

    // 依分頁過濾
    if (modeFilter === 'pos') {
      // 內用/外帶：排除外送
      orders = orders.filter(o => o.order_mode !== 'delivery');
    }
    // 全部訂單：不過濾

    // fix18-09B：儲存全部訂單快取（供折扣篩選 & 明細彈窗使用）
    _allOrdersCache = orders;

    // 從篩選後的 orders 計算統計（確保列表與統計一致）
    const stats = calcStatsFromOrders(orders);

    // fix18-09B：套用折扣篩選後再 render 列表
    const filteredOrders = applyDiscountFilter(orders, currentDiscountFilter);
    renderOrdersTable(filteredOrders);
    renderStatCards(stats, orders);
  } catch { showToast('訂單載入失敗', 'error'); }
}

async function loadDeliveryReport() {
  const from = document.getElementById('dateFrom')?.value || twTodayStr();
  const to   = document.getElementById('dateTo')?.value   || twTodayStr();
  try {
    const res  = await apiFetch(`/api/orders/delivery-report?date_from=${from}&date_to=${to}`);
    const json = await res.json();
    if (!json.success) return;

    // 從回傳的外送訂單陣列重新計算統計（確保一致）
    const delivOrders = json.data || [];
    // fix18-09B：儲存快取
    _allOrdersCache = delivOrders;
    const stats = calcStatsFromOrders(delivOrders);
    // 外送報表額外加平台分組
    renderStatCards({ ...stats, _hasDelivery: true }, delivOrders);

    const byPlat = json.by_platform || [];
    const platStats = document.getElementById('platformStats');
    if (platStats) {
      platStats.innerHTML = byPlat.length ? `<div class="platform-stat-grid">${byPlat.map(p=>
        `<div class="platform-stat-card"><h4>🛵 ${escHtml(p.platform)}</h4>
         <div class="psc-revenue">NT$${Math.round(p.revenue)}</div>
         <div class="psc-detail">訂單${p.count}筆 ｜ 抽成NT$${Math.round(p.commission)} ｜ 實收NT$${Math.round(p.store_income)}</div>
         </div>`).join('')}</div>` : '';
    }
    // fix18-09B：套用折扣篩選
    const filteredDelivOrders = applyDiscountFilter(delivOrders, currentDiscountFilter);
    renderDeliveryTable(filteredDelivOrders);
  } catch { showToast('外送報表載入失敗', 'error'); }
}

function renderStatCards(stats, allOrders) {
  const container = document.getElementById('statCards');
  if (!container) return;
  // fix18-09F：快取最近 stats 供模式切換重繪
  window._lastOrderStats = stats;
  // _hasDelivery: 明確傳入時才顯示抽成卡片（外送報表分頁）
  const showDelivery = stats._hasDelivery;
  const orders = allOrders || _allOrdersCache || [];

  // fix18-09B：折扣分類明細（含筆數）
  const discByCat = stats.discount_by_category || {};
  const discCatEntries = Object.entries(discByCat).filter(([,v]) => v > 0);

  // 計算各分類筆數
  const catCount = {};
  orders.forEach(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return;
    const disc = Number(o.discount_amount || 0);
    if (disc <= 0) return;
    const cat = normalizeDiscountCategory(o.discount_category);
    catCount[cat] = (catCount[cat] || 0) + 1;
  });
  const totalDiscOrders = Object.values(catCount).reduce((a,b) => a+b, 0);

  const discCatRows = discCatEntries.length
    ? discCatEntries.map(([cat, amt]) => {
        const cnt = catCount[cat] || 0;
        return `<div class="stat-card-clickable" onclick="setDiscountFilter('${cat}')"
          style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:5px 6px;border-radius:5px;margin-bottom:4px;background:var(--bg-base,#0f172a);border:1px solid var(--border,#334155)">
          <span style="color:var(--text-secondary,#94a3b8)">${DISCOUNT_CATEGORY_DISPLAY[cat]||cat}</span>
          <span style="text-align:right">
            <span style="color:var(--danger,#ef4444);font-weight:700;font-family:monospace">-NT$${Math.round(amt)}</span>
            <br><span style="color:var(--text-muted,#64748b);font-size:11px">${cnt}筆</span>
          </span>
        </div>`;
      }).join('')
    : '<div style="color:var(--text-muted,#64748b);font-size:12px">無折扣支出</div>';

  const totalDiscount  = Number(stats.total_discount || 0);
  const totalOriginal  = Number(stats.total_original || 0);
  const totalRevenue   = Number(stats.total_revenue || 0);

  container.innerHTML = `
    ${isCardVisible('訂單數') ? `<div class="stat-card"><div class="stat-card-label">訂單數</div><div class="stat-card-value">${stats.order_count||0}</div><div class="stat-card-sub">筆訂單</div></div>` : ''}
    ${isCardVisible('原價營業額') ? `<div class="stat-card"><div class="stat-card-label">原價營業額</div><div class="stat-card-value" style="font-size:18px">$${Math.round(totalOriginal)}</div><div class="stat-card-sub">未扣折扣</div></div>` : ''}
    ${isCardVisible('折扣總額') && totalDiscount > 0 ? `<div class="stat-card"><div class="stat-card-label">折扣總額</div><div class="stat-card-value" style="color:var(--danger)">-$${Math.round(totalDiscount)}</div><div class="stat-card-sub">已折抵</div></div>` : ''}
    ${isCardVisible('實收營業額') ? `<div class="stat-card"><div class="stat-card-label">實收營業額</div><div class="stat-card-value" style="color:var(--success)">$${Math.round(totalRevenue)}</div><div class="stat-card-sub">新台幣</div></div>` : ''}
    ${isCardVisible('平均客單價') ? `<div class="stat-card"><div class="stat-card-label">平均客單價</div><div class="stat-card-value">$${Math.round(stats.avg_order||0)}</div><div class="stat-card-sub">每筆訂單</div></div>` : ''}
    ${isCardVisible('平台抽成') && showDelivery ? `<div class="stat-card"><div class="stat-card-label">平台抽成</div><div class="stat-card-value" style="color:var(--danger)">$${Math.round(stats.total_commission||0)}</div></div>` : ''}
    ${isCardVisible('店家實收') && showDelivery ? `<div class="stat-card"><div class="stat-card-label">店家實收</div><div class="stat-card-value" style="color:var(--success)">$${Math.round(stats.total_store_income||0)}</div></div>` : ''}
    ${isCardVisible('熱賣商品') ? renderHotProductsCard(orders) : ''}
    ${isCardVisible('折扣支出') ? `<div class="stat-card" style="min-width:220px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="stat-card-label" style="margin:0">💸 折扣支出</div>
        <button onclick="openDiscountDetail()" style="font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary,#94a3b8);cursor:pointer">📄 查看明細</button>
      </div>
      <div class="stat-card-value" style="color:var(--danger);font-size:18px;margin-bottom:8px" onclick="setDiscountFilter('has_discount')" style="cursor:pointer">NT$${Math.round(totalDiscount)}<small style="font-size:12px;color:var(--text-muted);font-weight:400;margin-left:6px">${totalDiscOrders}筆</small></div>
      ${discCatRows}
    </div>` : ''}
    ${isCardVisible('折扣商品排行') ? renderDiscountTopProductsWithGroups(orders) : ''}
    ${isCardVisible('折扣活動排行') ? renderDiscountCampaignRanking(orders) : ''}`;
  // fix18-09E：外送平台卡片顯示控制
  const platEl = document.getElementById('platformStats');
  if (platEl) platEl.style.display = isCardVisible('外送平台卡片') ? '' : 'none';
}

// fix18-09C：折扣活動排行卡（TOP3 preview）
function renderDiscountCampaignRanking(orders) {
  const ranked = buildDiscountCampaignMap(orders);
  if (!ranked.length) return '';
  const preview = ranked.slice(0, 3);
  const previewRows = preview.map((c, i) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#334155)">
      <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${i+1}. ${escHtml(c.name)}</span>
      <span style="text-align:right;white-space:nowrap;margin-left:6px">
        <span style="color:var(--danger);font-family:monospace;font-weight:700">NT$${Math.round(c.total)}</span>
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px">${c.count}筆</span>
      </span>
    </div>`
  ).join('');
  return `<div class="stat-card" style="min-width:200px;max-width:260px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div class="stat-card-label" style="margin:0">🏆 折扣活動排行</div>
      <button onclick="openDiscCampaignTop10()" style="font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary,#94a3b8);cursor:pointer;white-space:nowrap">查看 TOP10</button>
    </div>
    ${previewRows}
    ${ranked.length > 3 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:6px;cursor:pointer" onclick="openDiscCampaignTop10()">還有 ${ranked.length - 3} 項 →</div>` : ''}
  </div>`;
}

// fix18-09B：折扣商品排行（TOP 10）
// fix18-09B rev：計算折扣商品排行（共用）
function buildDiscountProdMap(orders) {
  const valid = (orders || []).filter(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return false;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return Number(o.discount_amount || 0) > 0;
  });
  const prodMap = {};
  valid.forEach(o => {
    const disc = Number(o.discount_amount || 0);
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
    items.forEach(item => {
      const share = totalQty > 0 ? disc * Number(item.qty || 0) / totalQty : 0;
      if (!prodMap[item.name]) prodMap[item.name] = { name: item.name, total: 0, count: 0 };
      prodMap[item.name].total += share;
      prodMap[item.name].count += 1;
    });
  });
  return Object.values(prodMap).sort((a, b) => b.total - a.total);
}

// 統計卡只顯示 TOP3，右上角附「查看 TOP10」按鈕（fix18-09C：使用 V2 版本）
function renderDiscountTopProducts(orders) {
  const ranked = buildDiscountProdMapV2(orders);
  if (!ranked.length) return '';
  const preview = ranked.slice(0, 3);
  const previewRows = preview.map((p, i) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#334155)">
      <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${i+1}. ${escHtml(p.name)}</span>
      <span style="text-align:right;white-space:nowrap;margin-left:6px">
        <span style="color:var(--danger);font-family:monospace;font-weight:700">NT$${Math.round(p.total)}</span>
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px">${p.count}筆</span>
      </span>
    </div>`
  ).join('');
  return `<div class="stat-card" style="min-width:200px;max-width:260px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div class="stat-card-label" style="margin:0">📉 折扣商品排行</div>
      <button onclick="openDiscTop10()" style="font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary,#94a3b8);cursor:pointer;white-space:nowrap">查看 TOP10</button>
    </div>
    ${previewRows}
    ${ranked.length > 3 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:6px;cursor:pointer" onclick="openDiscTop10()">還有 ${ranked.length - 3} 項 →</div>` : ''}
  </div>`;
}

// 開啟 TOP10 Modal（fix18-09C：使用 V2；fix18-09F：支援群組）
function openDiscTop10() {
  openDiscTop10WithGroups();
}

function closeDiscTop10() {
  document.getElementById('discTop10Modal').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════
// fix18-09E：折扣分類功能
// ═══════════════════════════════════════════════════════════

// 載入折扣分類（全域快取）
async function loadDiscountCategories() {
  try {
    const res = await apiFetch('/api/discount-categories');
    const json = await res.json();
    if (json.success) {
      allDiscountCategories = json.data || [];
      renderDiscountFilterBar(); // 同步更新快速篩選列
    }
  } catch (e) {
    console.warn('[DiscountCategories] 載入失敗', e.message);
  }
}

// 設定中心：折扣分類 Tab
async function loadDiscountCategoriesSection() {
  await loadDiscountCategories();
  renderDiscountCategoryList();
}

function renderDiscountCategoryList() {
  const el = document.getElementById('discountCategoryList');
  if (!el) return;
  const cats = allDiscountCategories;
  if (!cats.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">尚無分類，點擊「＋ 新增分類」開始設定</div>';
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:2px solid var(--border,#334155)">
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">圖示</th>
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">分類名稱</th>
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">代碼</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">狀態</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">排序</th>
          <th style="text-align:right;padding:8px 10px;color:var(--text-muted)">操作</th>
        </tr>
      </thead>
      <tbody>
        ${cats.map(c => `
          <tr style="border-bottom:1px solid var(--border,#334155)">
            <td style="padding:10px;font-size:18px">${escHtml(c.icon||'⚪')}</td>
            <td style="padding:10px;font-weight:600;color:${c.enabled?'var(--text-primary,#f1f5f9)':'var(--text-muted,#64748b)'}">${escHtml(c.name)}</td>
            <td style="padding:10px;color:var(--text-muted,#64748b);font-size:11px;font-family:monospace">${escHtml(c.code)}</td>
            <td style="padding:10px;text-align:center">
              <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" ${c.enabled?'checked':''} onchange="toggleDiscountCategory(${c.id},this.checked)" style="width:14px;height:14px">
                <span style="font-size:12px;color:${c.enabled?'#10b981':'var(--text-muted)'}">${c.enabled?'啟用':'停用'}</span>
              </label>
            </td>
            <td style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px">${c.sort_order}</td>
            <td style="padding:10px;text-align:right;white-space:nowrap">
              <button onclick="openCategoryModal(${c.id})" style="padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;margin-right:6px">✏️ 編輯</button>
              <button onclick="deleteDiscountCategory(${c.id},'${escHtml(c.name)}')" style="padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid var(--danger,#ef4444);background:transparent;color:var(--danger,#ef4444);cursor:pointer">🗑 刪除</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function openCategoryModal(id) {
  const modal = document.getElementById('categoryEditModal');
  if (!modal) return;
  const titleEl = document.getElementById('categoryModalTitle');
  const idEl    = document.getElementById('categoryEditId');
  const nameEl  = document.getElementById('categoryEditName');
  const iconEl  = document.getElementById('categoryEditIcon');
  const colorEl = document.getElementById('categoryEditColor');
  const enaEl   = document.getElementById('categoryEditEnabled');
  const sortEl  = document.getElementById('categoryEditSortOrder');
  if (id) {
    const c = allDiscountCategories.find(x => x.id === id);
    if (!c) return;
    if (titleEl) titleEl.textContent = '編輯折扣分類';
    if (idEl)    idEl.value     = c.id;
    if (nameEl)  nameEl.value   = c.name;
    if (iconEl)  iconEl.value   = c.icon || '⚪';
    if (colorEl) colorEl.value  = c.color || '#94a3b8';
    if (enaEl)   enaEl.checked  = !!c.enabled;
    if (sortEl)  sortEl.value   = c.sort_order || 0;
  } else {
    if (titleEl) titleEl.textContent = '新增折扣分類';
    if (idEl)    idEl.value     = '';
    if (nameEl)  nameEl.value   = '';
    if (iconEl)  iconEl.value   = '⚪';
    if (colorEl) colorEl.value  = '#94a3b8';
    if (enaEl)   enaEl.checked  = true;
    if (sortEl)  sortEl.value   = allDiscountCategories.length;
  }
  modal.classList.add('open');
  if (nameEl) setTimeout(() => nameEl.focus(), 100);
}

function closeCategoryModal() {
  const modal = document.getElementById('categoryEditModal');
  if (modal) modal.classList.remove('open');
}

async function saveCategoryModal() {
  const id      = document.getElementById('categoryEditId')?.value;
  const name    = document.getElementById('categoryEditName')?.value?.trim();
  const icon    = document.getElementById('categoryEditIcon')?.value?.trim() || '⚪';
  const color   = document.getElementById('categoryEditColor')?.value || '#94a3b8';
  const enabled = document.getElementById('categoryEditEnabled')?.checked ?? true;
  const sort    = parseInt(document.getElementById('categoryEditSortOrder')?.value || '0', 10);
  if (!name) { showToast('請輸入分類名稱', 'error'); return; }
  try {
    const res = await apiFetch(id ? `/api/discount-categories/${id}` : '/api/discount-categories', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, color, enabled, sort_order: sort })
    });
    const json = await res.json();
    if (json.success) {
      closeCategoryModal();
      await loadDiscountCategories();
      renderDiscountCategoryList();
      showToast(id ? '✅ 已更新' : '✅ 折扣分類已新增', 'success');
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch (e) { showToast('網路錯誤', 'error'); }
}

async function toggleDiscountCategory(id, enabled) {
  try {
    await apiFetch('/api/discount-categories/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await loadDiscountCategories();
    renderDiscountCategoryList();
  } catch (e) { showToast('更新失敗', 'error'); }
}

async function deleteDiscountCategory(id, name) {
  if (!confirm(`確定要刪除「${name}」分類嗎？`)) return;
  try {
    const res = await apiFetch('/api/discount-categories/' + id, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      await loadDiscountCategories();
      renderDiscountCategoryList();
      showToast('已刪除', 'success');
    } else { showToast(json.message || '刪除失敗', 'error'); }
  } catch (e) { showToast('網路錯誤', 'error'); }
}

// fix18-09E：動態渲染快速篩選列（折扣分類按鈕）
function renderDiscountFilterBar() {
  const bar = document.getElementById('discountFilterBar');
  if (!bar) return;
  const cats = allDiscountCategories.filter(c => c.enabled);
  const current = currentDiscountFilter;
  let html = `
    <button class="disc-filter-btn ${current==='all'?'active':''}" data-filter="all" onclick="setDiscountFilter('all')">全部</button>
    <button class="disc-filter-btn ${current==='has_discount'?'active':''}" data-filter="has_discount" onclick="setDiscountFilter('has_discount')">💸 有折扣</button>
    <button class="disc-filter-btn ${current==='no_discount'?'active':''}" data-filter="no_discount" onclick="setDiscountFilter('no_discount')">無折扣</button>`;
  if (cats.length) {
    cats.forEach(c => {
      html += `<button class="disc-filter-btn ${current===c.code?'active':''}" data-filter="${escHtml(c.code)}" onclick="setDiscountFilter('${escHtml(c.code)}')">${escHtml(c.icon||'')} ${escHtml(c.name)}</button>`;
    });
  } else {
    // fallback 預設分類
    const defaults = [
      {code:'product_promo',label:'🟢 商品活動'},{code:'marketing',label:'🔵 廣告行銷'},
      {code:'complaint',label:'🟠 客訴補償'},{code:'loyalty',label:'🟣 老客優惠'},
      {code:'staff_family',label:'⚫ 員工親友'},{code:'platform_promo',label:'🟡 平台活動'},
      {code:'other',label:'⚪ 其他'}
    ];
    defaults.forEach(d => {
      html += `<button class="disc-filter-btn ${current===d.code?'active':''}" data-filter="${d.code}" onclick="setDiscountFilter('${d.code}')">${d.label}</button>`;
    });
  }
  bar.innerHTML = html;
}

// fix18-09E：動態渲染訂單修改 Modal 折扣分類下拉
function refreshEditOrderCategoryDropdown(selectedCode) {
  const sel = document.getElementById('editDiscountCategory');
  if (!sel) return;
  const cats = allDiscountCategories.length
    ? allDiscountCategories.filter(c => c.enabled)
    : Object.entries(DISCOUNT_CATEGORY_DISPLAY_FALLBACK).filter(([k]) => k !== 'none').map(([code,name]) => ({code,name}));
  sel.innerHTML = '<option value="none">無折扣</option>' +
    cats.map(c => `<option value="${escHtml(c.code)}">${escHtml(c.name)}</option>`).join('');
  if (selectedCode) sel.value = selectedCode;
}

// ═══════════════════════════════════════════════════════════
// fix18-09E：報表卡片顯示設定 Modal
// ═══════════════════════════════════════════════════════════

// fix18-09E：報表卡片顯示 Modal — 對應 HTML id="cardVisibilityModal"
function openCardVisibilityModal() {
  const modal = document.getElementById('cardVisibilityModal');
  if (!modal) return;
  const visible = getVisibleCards();
  // 動態渲染 checkboxes
  const container = document.getElementById('cardVisibilityCheckboxes');
  if (container) {
    container.innerHTML = REPORT_ALL_CARDS.map(label => `
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0;border-bottom:1px solid var(--border,#334155)">
        <input type="checkbox" class="cv-checkbox" data-card="${label}" ${visible.includes(label)?'checked':''} style="width:16px;height:16px">
        <span style="font-size:14px">${label}</span>
      </label>`).join('') +
    // fix18-09F：商品分析群組標籤
    `<div style="border-top:2px solid var(--border,#334155);margin-top:10px;padding-top:10px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">📊 訂單列表顯示</div>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0">
        <input type="checkbox" id="cvGroupLabelToggle" ${isGroupLabelEnabled()?'checked':''} style="width:16px;height:16px">
        <span style="font-size:14px">商品分析群組標籤</span>
        <span style="font-size:11px;color:var(--text-muted)">在訂單商品下方顯示 📊 群組：xxx</span>
      </label>
    </div>`;
  }
  _updateCardModeButtons(visible);
  modal.classList.add('open');
}

function closeCardVisibilityModal() {
  const modal = document.getElementById('cardVisibilityModal');
  if (modal) modal.classList.remove('open');
}

function saveCardVisibility() {
  const modal = document.getElementById('cardVisibilityModal');
  if (!modal) return;
  const checked = [];
  modal.querySelectorAll('.cv-checkbox:checked').forEach(cb => checked.push(cb.dataset.card));
  saveVisibleCards(checked);
  // fix18-09F：儲存群組標籤開關
  const glToggle = document.getElementById('cvGroupLabelToggle');
  if (glToggle) setGroupLabelEnabled(glToggle.checked);
  closeCardVisibilityModal();
  // Re-render stats
  if (_allOrdersCache.length) {
    const stats = calcStatsFromOrders(_allOrdersCache);
    renderStatCards(stats, _allOrdersCache);
  }
  showToast('✅ 顯示設定已儲存', 'success');
}

function setCardVisibilityMode(mode) {
  if (mode === 'all') {
    saveVisibleCards([...REPORT_ALL_CARDS]);
  } else if (mode === 'simple') {
    saveVisibleCards([...REPORT_SLIM_CARDS]);
  }
  // Update checkboxes in modal
  const visible = getVisibleCards();
  document.querySelectorAll('.cv-checkbox').forEach(cb => {
    cb.checked = visible.includes(cb.dataset.card);
  });
  _updateCardModeButtons(visible);
}

function _updateCardModeButtons(visible) {
  const allBtn    = document.getElementById('cvModeAll');
  const slimBtn   = document.getElementById('cvModeSimple');
  if (!allBtn || !slimBtn) return;
  const isAll  = REPORT_ALL_CARDS.every(c => visible.includes(c));
  const isSlim = REPORT_SLIM_CARDS.length === visible.length && REPORT_SLIM_CARDS.every(c => visible.includes(c));
  allBtn.style.background  = isAll  ? 'var(--accent,#3b82f6)' : '';
  allBtn.style.color       = isAll  ? '#fff' : '';
  slimBtn.style.background = isSlim ? 'var(--accent,#3b82f6)' : '';
  slimBtn.style.color      = isSlim ? '#fff' : '';
}

// alias — for code inside saveCardVisibility that calls renderOrderStats
function renderOrderStats(stats, orders) { renderStatCards(stats, orders); }
// legacy compat
function openReportCardSettings() { openCardVisibilityModal(); }
function closeReportCardSettings() { closeCardVisibilityModal(); }
function saveReportCardSettings() { saveCardVisibility(); }
function setReportCardMode(mode) { setCardVisibilityMode(mode === 'slim' ? 'simple' : mode); }

// ═══════════════════════════════════════════════════════════
// fix18-09C：折扣活動 Campaign 相關功能

// 載入折扣活動列表（全域快取，供 modal 下拉使用）
async function loadDiscountCampaigns() {
  try {
    const res = await apiFetch('/api/discount-campaigns');
    const json = await res.json();
    if (json.success) {
      allDiscountCampaigns = json.data || [];
    }
  } catch (e) {
    console.warn('[DiscountCampaigns] 載入失敗', e.message);
  }
}

// 設定中心：折扣活動 Tab（fix18-09E：同時渲染折扣分類＋折扣活動）
async function loadDiscountCampaignsTab() {
  await Promise.all([
    loadDiscountCampaigns(),
    loadDiscountCategories()
  ]);
  renderDiscountCategoryList();
  renderDiscountCampaignList();
}

function renderDiscountCampaignList() {
  const el = document.getElementById('discountCampaignList');
  if (!el) return;
  if (!allDiscountCampaigns.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">尚無折扣活動，點擊「＋ 新增活動」開始設定</div>';
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:2px solid var(--border,#334155)">
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">活動名稱</th>
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">說明</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">狀態</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">排序</th>
          <th style="text-align:right;padding:8px 10px;color:var(--text-muted)">操作</th>
        </tr>
      </thead>
      <tbody>
        ${allDiscountCampaigns.map(c => `
          <tr style="border-bottom:1px solid var(--border,#334155)">
            <td style="padding:10px;font-weight:600;color:${c.enabled?'var(--text-primary,#f1f5f9)':'var(--text-muted,#64748b)'}">${escHtml(c.name)}</td>
            <td style="padding:10px;color:var(--text-muted,#64748b);font-size:12px">${escHtml(c.description||'—')}</td>
            <td style="padding:10px;text-align:center">
              <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" ${c.enabled?'checked':''} onchange="toggleDiscountCampaign(${c.id},this.checked)" style="width:14px;height:14px">
                <span style="font-size:12px;color:${c.enabled?'#10b981':'var(--text-muted)'}">${c.enabled?'啟用':'停用'}</span>
              </label>
            </td>
            <td style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px">${c.sort_order}</td>
            <td style="padding:10px;text-align:right;white-space:nowrap">
              <button onclick="openCampaignModal(${c.id})" style="padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;margin-right:6px">✏️ 編輯</button>
              <button onclick="deleteDiscountCampaign(${c.id},'${escHtml(c.name)}')" style="padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid var(--danger,#ef4444);background:transparent;color:var(--danger,#ef4444);cursor:pointer">🗑 刪除</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// fix18-09D：Modal 新增/編輯
function openCampaignModal(id) {
  const modal = document.getElementById('campaignEditModal');
  if (!modal) return;
  const titleEl = document.getElementById('campaignModalTitle');
  const idEl    = document.getElementById('campaignEditId');
  const nameEl  = document.getElementById('campaignEditName');
  const descEl  = document.getElementById('campaignEditDesc');
  const enaEl   = document.getElementById('campaignEditEnabled');
  const sortEl  = document.getElementById('campaignEditSortOrder');
  if (id) {
    const c = allDiscountCampaigns.find(x => x.id === id);
    if (!c) return;
    if (titleEl) titleEl.textContent = '編輯折扣活動';
    if (idEl)    idEl.value     = c.id;
    if (nameEl)  nameEl.value   = c.name;
    if (descEl)  descEl.value   = c.description || '';
    if (enaEl)   enaEl.checked  = !!c.enabled;
    if (sortEl)  sortEl.value   = c.sort_order || 0;
  } else {
    if (titleEl) titleEl.textContent = '新增折扣活動';
    if (idEl)    idEl.value     = '';
    if (nameEl)  nameEl.value   = '';
    if (descEl)  descEl.value   = '';
    if (enaEl)   enaEl.checked  = true;
    if (sortEl)  sortEl.value   = allDiscountCampaigns.length;
  }
  modal.classList.add('open');
  if (nameEl) setTimeout(() => nameEl.focus(), 100);
}

function closeCampaignModal() {
  const modal = document.getElementById('campaignEditModal');
  if (modal) modal.classList.remove('open');
}

async function saveCampaignModal() {
  const id      = document.getElementById('campaignEditId')?.value;
  const name    = document.getElementById('campaignEditName')?.value?.trim();
  const desc    = document.getElementById('campaignEditDesc')?.value?.trim() || '';
  const enabled = document.getElementById('campaignEditEnabled')?.checked ?? true;
  const sort    = parseInt(document.getElementById('campaignEditSortOrder')?.value || '0', 10);
  if (!name) { showToast('請輸入活動名稱', 'error'); return; }
  try {
    const res = await apiFetch(id ? `/api/discount-campaigns/${id}` : '/api/discount-campaigns', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc, enabled, sort_order: sort })
    });
    const json = await res.json();
    if (json.success) {
      closeCampaignModal();
      await loadDiscountCampaigns();
      renderDiscountCampaignList();
      showToast(id ? '✅ 已更新' : '✅ 折扣活動已新增', 'success');
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch (e) { showToast('網路錯誤', 'error'); }
}

async function addDiscountCampaign() { openCampaignModal(); } // 相容舊呼叫

async function toggleDiscountCampaign(id, enabled) {
  try {
    await apiFetch('/api/discount-campaigns/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await loadDiscountCampaigns();
    renderDiscountCampaignList();
  } catch (e) { showToast('更新失敗', 'error'); }
}

async function editDiscountCampaign(id) { openCampaignModal(id); } // 相容舊呼叫

async function deleteDiscountCampaign(id, name) {
  if (!confirm(`確定要刪除「${name}」活動嗎？`)) return;
  try {
    const res = await apiFetch('/api/discount-campaigns/' + id, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      await loadDiscountCampaigns();
      renderDiscountCampaignList();
      showToast('已刪除', 'success');
    } else { showToast(json.message || '刪除失敗', 'error'); }
  } catch (e) { showToast('網路錯誤', 'error'); }
}

// ─── 修改訂單 Modal：折扣活動下拉刷新 ────────────────────
function refreshEditOrderCampaignDropdown(selectedId) {
  const sel = document.getElementById('editDiscountCampaign');
  if (!sel) return;
  const active = allDiscountCampaigns.filter(c => c.enabled);
  sel.innerHTML = '<option value="">— 不指定 —</option>' +
    active.map(c => `<option value="${c.id}" data-name="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join('');
  if (selectedId) sel.value = selectedId;
}

// 折扣活動變更時自動帶活動名稱
function onDiscountCampaignChange() {
  // 名稱由 saveEditOrder 時從 option text 讀取，這裡不需額外處理
}

// 折扣套用商品切換（fix18-09D：多選 checkbox）
function onDiscountTargetTypeChange() {
  const type = document.getElementById('editDiscountTargetType')?.value;
  const panel = document.getElementById('editDiscountProductPanel');
  if (!panel) return;
  if (type === 'products') {
    panel.style.display = 'block';
    refreshEditDiscountProductCheckboxes();
  } else {
    panel.style.display = 'none';
  }
}

// fix18-09D：checkbox 多選
function refreshEditDiscountProductCheckboxes(selectedNames) {
  const container = document.getElementById('editDiscountProductCheckboxes');
  if (!container) return;
  if (!editOrderItems.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px">無商品</div>';
    return;
  }
  // 去重（同名商品只顯示一次）
  const seen = new Set();
  const unique = editOrderItems.filter(i => {
    if (seen.has(i.name)) return false;
    seen.add(i.name); return true;
  });
  const selSet = new Set(selectedNames || []);
  container.innerHTML = unique.map(i => {
    const checked = selSet.has(i.name) ? 'checked' : '';
    const totalQty = editOrderItems.filter(x => x.name === i.name).reduce((s, x) => s + (x.qty||0), 0);
    return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0">
      <input type="checkbox" value="${escHtml(i.name)}" ${checked} style="width:15px;height:15px;flex-shrink:0">
      <span style="font-size:13px">${escHtml(i.name)} <span style="color:var(--text-muted);font-size:12px">×${totalQty}</span></span>
    </label>`;
  }).join('');
}

// 取得 checkbox 勾選結果
function getCheckedDiscountProducts() {
  const container = document.getElementById('editDiscountProductCheckboxes');
  if (!container) return [];
  return Array.from(container.querySelectorAll('input[type=checkbox]:checked'))
    .map(cb => cb.value).filter(Boolean);
}

// 相容舊呼叫（不再使用，保留空函式避免 ReferenceError）
function refreshEditDiscountProductDropdown(selectedId, selectedName) {
  // 已被 refreshEditDiscountProductCheckboxes 取代
}

// ─── 折扣活動排行榜 TOP10 ────────────────────────────────
function buildDiscountCampaignMap(orders) {
  const valid = (orders || []).filter(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return false;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return Number(o.discount_amount || 0) > 0;
  });
  const map = {};
  valid.forEach(o => {
    const disc = Number(o.discount_amount || 0);
    // fix18-09C：用 discount_campaign_name；舊資料無活動視為「其他」
    const name = o.discount_campaign_name || '其他';
    if (!map[name]) map[name] = { name, total: 0, count: 0 };
    map[name].total += disc;
    map[name].count += 1;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// 折扣商品 TOP10（fix18-09D 升級版：支援多商品陣列平攤）
function buildDiscountProdMapV2(orders) {
  const valid = (orders || []).filter(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return false;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return Number(o.discount_amount || 0) > 0;
  });
  const prodMap = {};
  valid.forEach(o => {
    const disc = Number(o.discount_amount || 0);
    // fix18-09D：優先使用 discount_product_names 陣列
    const targetIsProduct = (o.discount_target_type === 'products' || o.discount_target_type === 'product');
    const names = Array.isArray(o.discount_product_names) && o.discount_product_names.length
      ? o.discount_product_names
      : (o.discount_product_name
          ? o.discount_product_name.split('、').map(s => s.trim()).filter(Boolean)
          : []);
    if (targetIsProduct && names.length) {
      // 多商品：平均分攤
      const share = disc / names.length;
      names.forEach(pname => {
        if (!prodMap[pname]) prodMap[pname] = { name: pname, total: 0, count: 0 };
        prodMap[pname].total += share;
        prodMap[pname].count += 1;
      });
    } else {
      // 整張訂單：平攤到各商品項目
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
      items.forEach(item => {
        const share = totalQty > 0 ? disc * Number(item.qty || 0) / totalQty : 0;
        if (!prodMap[item.name]) prodMap[item.name] = { name: item.name, total: 0, count: 0 };
        prodMap[item.name].total += share;
        prodMap[item.name].count += 1;
      });
    }
  });
  return Object.values(prodMap).sort((a, b) => b.total - a.total);
}

function openDiscCampaignTop10() {
  const ranked = buildDiscountCampaignMap(_allOrdersCache || []);
  const top10  = ranked.slice(0, 10);
  const tbody  = document.getElementById('discCampaignTop10Body');
  if (!tbody) return;
  tbody.innerHTML = top10.length
    ? top10.map((c, i) => {
        const avg = c.count > 0 ? Math.round(c.total / c.count) : 0;
        return `<tr>
          <td style="font-size:13px;color:var(--text-muted);text-align:center">${i + 1}</td>
          <td style="font-size:13px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.name)}</td>
          <td style="text-align:right;font-family:monospace;color:var(--danger);font-weight:700">NT$${Math.round(c.total)}</td>
          <td style="text-align:right;color:var(--text-secondary)">${c.count}筆</td>
          <td style="text-align:right;font-family:monospace;color:var(--text-secondary)">NT$${avg}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:16px">無資料</td></tr>';
  document.getElementById('discCampaignTop10Modal').classList.add('open');
}

function closeDiscCampaignTop10() {
  document.getElementById('discCampaignTop10Modal').classList.remove('open');
}


function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersBody');
  if (!orders.length) { tbody.innerHTML = '<tr><td colspan="9" class="table-empty">無訂單</td></tr>'; return; }
  const payLabel = { cash:'現金', card:'刷卡', linepay:'LINE', jkopay:'街口', transfer:'轉帳', platform:'平台' };
  const statusMap = { completed:['status-completed','正常'], modified:['status-modified','已修改'], void:['status-void','已作廢'] };
  const modeLabel = { dine_in:'🍽️ 內用', takeout:'🛍️ 外帶', delivery:'🛵 外送' };
  const ostatusLabel = { pending:'待接單', accepted:'已接單', preparing:'製作中', ready:'可取餐', delivering:'配送中', completed:'已完成', cancelled:'已取消' };
  const ostatusCls   = { pending:'ostatus-pending', accepted:'ostatus-accepted', preparing:'ostatus-preparing', ready:'ostatus-ready', delivering:'ostatus-delivering', completed:'ostatus-completed', cancelled:'ostatus-cancelled' };

  tbody.innerHTML = orders.map(o => {
    const [sCls, sLabel] = statusMap[o.status] || ['status-completed','正常'];
    const isVoid = o.status === 'void';
    const modeKey = o.order_mode || 'dine_in';
    const ident = o.order_mode === 'dine_in' ? (o.table_number||'—') :
                  o.order_mode === 'takeout'  ? (o.pickup_name||o.customer_name||'—') :
                  (o.delivery_platform||o.customer_name||'—');
    // pickup_time 顯示（LINE 訂單取餐時間）
    // 預購單：pickup_time 格式 "YYYY-MM-DD HH:MM"
    let pickupTag = '';
    if ((o.source === 'line' || o.customer_line_id) && o.pickup_time && o.pickup_time !== '盡快') {
      const pt = o.pickup_time;
      const isPreorderFmt = pt.length > 10 && pt.includes('-') && pt.includes(' ');
      if (isPreorderFmt) {
        // 預購格式：顯示 📅 預購：MM-DD HH:MM
        const dispDate = pt.slice(5, 10), dispTime = pt.slice(11);
        pickupTag = `<br><span style="font-size:11px;color:#a78bfa;font-weight:600">📅 預購：${dispDate} ${dispTime}</span>`;
      } else {
        pickupTag = `<br><span style="font-size:11px;color:#06C755">⏰${pt}</span>`;
      }
    }
    // hotfix13-BUG1：LINE 外送訂單顯示外送地址／備註／距離／外送費／導航連結
    let addressTag = '';
    if (o.order_mode === 'delivery' && o.delivery_address) {
      const distTxt = Number(o.delivery_distance_km) > 0 ? ` · ${o.delivery_distance_km}km` : '';
      const feeTxt  = Number(o.delivery_fee) > 0 ? ` · 運費NT$${o.delivery_fee}` : '';
      const navLink = o.delivery_maps_url ? ` <a href="${escHtml(o.delivery_maps_url)}" target="_blank" rel="noopener" style="color:#60a5fa">🧭導航</a>` : '';
      addressTag = `<br><span style="font-size:11px;color:#94a3b8">📍${escHtml(o.delivery_address)}${distTxt}${feeTxt}${navLink}</span>`
        + (o.delivery_address_note ? `<br><span style="font-size:11px;color:#94a3b8">備註：${escHtml(o.delivery_address_note)}</span>` : '');
    }
    return `
      <tr style="${isVoid?'opacity:0.5':''}">
        <td><span class="order-num">${escHtml(o.order_number)}</span></td>
        <td><span class="mode-badge mode-${modeKey}">${modeLabel[modeKey]||modeKey}</span></td>
        <td style="font-size:12px;color:#999">${twTime(o.created_at,'time')}</td>
        <td style="font-size:13px">${escHtml(ident)}${pickupTag}${addressTag}</td>
        <td style="font-size:12px">${o.items.map(i => {
          const groupName = isGroupLabelEnabled() ? getAnalysisGroupName(i.name) : null;
          return `${i.name}×${i.qty}` + (groupName ? `<br><span style="font-size:10px;color:#818cf8;background:rgba(99,102,241,0.12);border-radius:3px;padding:0 4px">📊 ${escHtml(groupName)}</span>` : '');
        }).join('<br><span style="color:var(--border,#334155)">─</span><br>')}</td>
        <td style="font-size:12px">${payLabel[o.payment_method]||o.payment_method}${o.payment_method==='linepay'?
            (o.payment_status==='paid'&&o.payment_confirm_source==='manual'?'<br><span style="font-size:10px;background:#27AE60;color:#fff;padding:1px 5px;border-radius:4px">現場確認已收</span>':
             o.payment_status==='paid'?'<br><span style="font-size:10px;background:#27AE60;color:#fff;padding:1px 5px;border-radius:4px">已付款</span>':
             o.payment_status==='failed'?'<br><span style="font-size:10px;background:#E74C3C;color:#fff;padding:1px 5px;border-radius:4px">付款失敗</span>':
             o.payment_status==='expired'?'<br><span style="font-size:10px;background:#E74C3C;color:#fff;padding:1px 5px;border-radius:4px">付款逾時</span>':
             '<br><span style="font-size:10px;background:#2980B9;color:#fff;padding:1px 5px;border-radius:4px">待付款</span>')
          :''}</td>
        <td style="font-family:monospace;white-space:nowrap">
          ${(function(){
            const disc=Number(o.discount_amount||0);
            if(disc<=0) return '<span style="font-weight:700;color:#f5a623">NT$'+o.total+'</span>';
            const origTotal=o.original_total||Number(o.total)+disc;
            const isHighDisc = origTotal > 0 && disc/origTotal >= 0.5;
            const cat = normalizeDiscountCategory(o.discount_category);
            const catLabel = DISCOUNT_CATEGORY_DISPLAY[cat] || '';
            const catBadge = cat && cat!=='none' ? '<br><span class="disc-badge disc-badge-'+cat+'">'+(catLabel||cat)+'</span>' : '';
            const highWarn = isHighDisc ? '<br><span class="high-discount-warn">⚠ 高折扣</span>' : '';
            // fix18-09D：顯示折扣活動與多商品名稱
            const campDisp = o.discount_campaign_name ? '<div style="font-size:11px;color:#fbbf24">🎯 '+escHtml(o.discount_campaign_name)+'</div>' : '';
            const _pnames09d = Array.isArray(o.discount_product_names)&&o.discount_product_names.length ? o.discount_product_names : (o.discount_product_name?o.discount_product_name.split('、').map(s=>s.trim()).filter(Boolean):[]);
            const _isProd09d = (o.discount_target_type==='products'||o.discount_target_type==='product');
            const prodDisp = (_isProd09d&&_pnames09d.length) ? '<div style="font-size:11px;color:#a78bfa">📦 '+escHtml(_pnames09d.join('、'))+'</div>' : '';
            return '<div style="font-size:11px;color:var(--text-muted,#94a3b8)">原價 NT$'+origTotal+'</div>'
              +'<div style="font-size:12px;color:#ef4444">💸 -NT$'+disc+'</div>'
              +'<div style="font-weight:700;color:#f5a623;font-size:15px">NT$'+o.total+'</div>'
              +catBadge+campDisp+prodDisp+highWarn;
          })()}
        </td>
        <td>
          <span class="order-status ${sCls}">${sLabel}</span>
          ${o.order_status&&o.order_status!=='completed'?`<br><span class="ostatus-badge ${ostatusCls[o.order_status]||''}">${ostatusLabel[o.order_status]||o.order_status}</span>`:''}
          ${o.refund_status==='pending_refund'?'<br><span class="ostatus-badge" style="background:#f97316;color:#fff">💸 待退款</span>':''}
          ${o.refund_status==='refunded'?'<br><span class="ostatus-badge" style="background:#64748b;color:#fff">已退款</span>':''}
        </td>
        <td>
          <div class="order-actions">
            <button class="btn-icon" onclick="showOrderDetail('${o.id}')">📋</button>
            ${!isVoid?`<button class="btn-icon edit-btn" onclick="openEditOrder('${o.id}')">✏️</button>`:''}
            ${!isVoid?`<button class="btn-icon void-btn" onclick="openVoidModal('${o.id}','${escHtml(o.order_number)}','${o.total}')">🚫</button>`:''}
            <button class="btn-icon print-btn" onclick="reprintOrder('${o.id}')">🖨️</button>
            ${o.payment_method==='cash'?`<button class="btn-icon" style="background:var(--success);color:#fff" title="開錢櫃" onclick="openDrawerFromOrder('${o.id}')">💰</button>`:''}
            ${o.payment_method==='linepay'&&o.payment_status!=='paid'&&!isVoid?`<button class="btn-icon" style="background:#06C755;color:#fff;font-size:11px" title="確認收款" onclick="confirmLinePayPayment('${o.uuid||o.id}','${escHtml(o.order_number)}')">💚 確認收款</button>`:''}
            ${o.refund_status==='pending_refund'?`<button class="btn-icon" style="background:#f97316;color:#fff;font-size:11px" title="標記已退款" onclick="markOrderRefunded('${o.id}','${escHtml(o.order_number)}')">💸 標記已退款</button>`:''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// hotfix13-BUG6：LinePay 已付款訂單取消後的待退款清單，標記店家已完成退款
async function markOrderRefunded(orderId, orderNumber) {
  if (!confirm(`確認訂單 ${orderNumber} 已完成退款給顧客？`)) return;
  try {
    const res  = await apiFetch(`/api/orders/${orderId}/refund-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      showToast('已標記為已退款', 'success');
      refreshCurrentOrderView();
    } else {
      showToast(json.message || '操作失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

function renderDeliveryTable(orders) {
  const tbody = document.getElementById('deliveryOrdersBody');
  if (!orders || !orders.length) { tbody.innerHTML = '<tr><td colspan="13" class="table-empty">無外送訂單</td></tr>'; return; }
  const payLabel = { cash:'現金', card:'刷卡', linepay:'LINE', jkopay:'街口', transfer:'轉帳', platform:'平台' };
  const statusMap = { completed:['status-completed','正常'], modified:['status-modified','已修改'], void:['status-void','已作廢'] };
  // 外送狀態設定
  const dstatusLabel = { preparing:'製作中', completed:'已完成', cancelled:'已取消' };
  const dstatusCls   = { preparing:'ostatus-preparing', completed:'ostatus-completed', cancelled:'ostatus-cancelled' };

  tbody.innerHTML = orders.map(o => {
    const [sCls, sLabel] = statusMap[o.status] || ['status-completed','正常'];
    const isVoid = o.status === 'void';
    const isCancelled = o.delivery_status === 'cancelled';
    const itemsText = (o.items||[]).map(i => `${escHtml(i.name)}×${i.qty}`).join('、');
    const commText = Number(o.platform_commission_amount) > 0
      ? `NT$${o.platform_commission_amount}（${o.platform_commission_rate}%）`
      : '—';
    // 外送狀態 Dropdown（非作廢才可操作）
    const ds = o.delivery_status || 'preparing';
    const dsOptions = ['preparing','completed','cancelled'].map(v =>
      `<option value="${v}" ${ds===v?'selected':''}>${dstatusLabel[v]||v}</option>`
    ).join('');
    const dsSelect = isVoid
      ? `<span class="ostatus-badge ${dstatusCls[ds]||''}">${dstatusLabel[ds]||ds}</span>`
      : `<select class="delivery-status-select ds-${ds}" onchange="changeDeliveryStatus('${o.id}',this.value)">${dsOptions}</select>`;

    return `
      <tr style="${isVoid||isCancelled ? 'opacity:0.55' : ''}">
        <td><span class="order-num">${escHtml(o.order_number)}</span></td>
        <td style="font-size:12px;color:#999;white-space:nowrap">${twTime(o.created_at,'time')}</td>
        <td style="font-weight:600;color:#ce93d8">${escHtml(o.delivery_platform||'—')}</td>
        <td style="font-size:12px;color:var(--text-muted);font-family:monospace">${escHtml(o.platform_order_no||'—')}</td>
        <td style="font-size:13px">${escHtml(o.customer_name||o.pickup_name||'—')}</td>
        <td style="font-size:12px;max-width:160px" title="${escHtml(o.delivery_address||'')}">
          ${o.delivery_address
            ? (o.delivery_maps_url
                ? `<a href="${escHtml(o.delivery_maps_url)}" target="_blank" rel="noopener" style="color:#60a5fa">📍 ${escHtml(o.delivery_address)}</a>`
                : `📍 ${escHtml(o.delivery_address)}`)
            : '<span style="color:var(--text-muted)">—</span>'}
          ${o.delivery_address_note ? `<div style="font-size:11px;color:var(--text-muted)">備註：${escHtml(o.delivery_address_note)}</div>` : ''}
        </td>
        <td style="font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${itemsText}">${itemsText||'—'}</td>
        <td style="font-family:monospace;white-space:nowrap;${isCancelled?'opacity:0.5':''}">
          ${(function(){
            const disc=Number(o.discount_amount||0);
            if(disc<=0) return '<span style="font-weight:700;color:#f5a623">NT$'+o.total+'</span>';
            const origTotal=o.original_total||Number(o.total)+disc;
            const isHighDisc = origTotal > 0 && disc/origTotal >= 0.5;
            const cat = normalizeDiscountCategory(o.discount_category);
            const catLabel = DISCOUNT_CATEGORY_DISPLAY[cat] || '';
            const catBadge = cat && cat!=='none' ? '<br><span class="disc-badge disc-badge-'+cat+'">'+(catLabel||cat)+'</span>' : '';
            const highWarn = isHighDisc ? '<br><span class="high-discount-warn">⚠ 高折扣</span>' : '';
            // fix18-09D：顯示折扣活動與多商品名稱
            const campDisp2 = o.discount_campaign_name ? '<div style="font-size:11px;color:#fbbf24">🎯 '+escHtml(o.discount_campaign_name)+'</div>' : '';
            const _pnames09d2 = Array.isArray(o.discount_product_names)&&o.discount_product_names.length ? o.discount_product_names : (o.discount_product_name?o.discount_product_name.split('、').map(s=>s.trim()).filter(Boolean):[]);
            const _isProd09d2 = (o.discount_target_type==='products'||o.discount_target_type==='product');
            const prodDisp2 = (_isProd09d2&&_pnames09d2.length) ? '<div style="font-size:11px;color:#a78bfa">📦 '+escHtml(_pnames09d2.join('、'))+'</div>' : '';
            return '<div style="font-size:11px;color:var(--text-muted,#94a3b8)">原價 NT$'+origTotal+'</div>'
              +'<div style="font-size:12px;color:#ef4444">💸 -NT$'+disc+'</div>'
              +'<div style="font-weight:700;color:#f5a623;font-size:15px">NT$'+o.total+'</div>'
              +catBadge+campDisp2+prodDisp2+highWarn;
          })()}
        </td>
        <td style="font-family:monospace;color:${isCancelled?'var(--text-muted)':'var(--danger)'};white-space:nowrap;${isCancelled?'text-decoration:line-through':''}">${commText}</td>
        <td style="font-family:monospace;color:${isCancelled?'var(--text-muted)':'var(--success)'};white-space:nowrap;${isCancelled?'text-decoration:line-through':''}">NT$${o.store_actual_income||o.total}</td>
        <td style="font-size:12px">${payLabel[o.payment_method]||o.payment_method||'—'}</td>
        <td>${dsSelect}</td>
        <td>
          <div class="order-actions">
            <button class="btn-icon" onclick="showOrderDetail('${o.id}')">📋</button>
            ${!isVoid ? `<button class="btn-icon edit-btn" onclick="openEditOrder('${o.id}')">✏️</button>` : ''}
            ${!isVoid ? `<button class="btn-icon void-btn" onclick="openVoidModal('${o.id}','${escHtml(o.order_number)}','${o.total}')">🚫</button>` : ''}
            <button class="btn-icon print-btn" onclick="reprintOrder('${o.id}')">🖨️</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function changeDeliveryStatus(orderId, newStatus) {
  try {
    const res = await apiFetch(`/api/orders/${orderId}/delivery-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_status: newStatus })
    });
    const json = await res.json();
    if (json.success) {
      const label = { preparing:'製作中', completed:'已完成', cancelled:'已取消' }[newStatus] || newStatus;
      showToast(`狀態已更新：${label}`, 'success');
      // 更新統計（取消可能影響報表）
      loadDeliveryReport();
    } else {
      showToast(json.message || '更新失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

async function showOrderDetail(orderId) {
  try {
    const [orderRes, logsRes] = await Promise.all([
      apiFetch('/api/orders/' + orderId),
      apiFetch('/api/orders/' + orderId + '/logs')
    ]);
    const orderJson = await orderRes.json();
    const logsJson  = await logsRes.json();
    if (!orderJson.success) return;
    const o = orderJson.data;
    const logs = logsJson.success ? logsJson.data : [];
    currentOrderForPrint = o;

    const payLabel = { cash:'💵 現金', linepay:'💚 LINE Pay', card:'💳 刷卡', transfer:'🏦 轉帳' };
    const isCash = o.payment_method === 'cash';
    const isVoid = o.status === 'void';
    const statusMap = { completed:'正常', modified:'已修改', void:'已作廢' };

    const logsHtml = logs.length ? `
      <div class="order-log-section">
        <h4>📝 修改 / 作廢記錄（共 ${logs.length} 筆）</h4>
        ${logs.map(l => {
          // fix18-09：解析 after_data 的所有 diff
          let diffHtml = '';
          try {
            const afterData = typeof l.after_data === 'string' ? JSON.parse(l.after_data) : (l.after_data || {});
            const pd = afterData.platform_diff;
            if (pd) {
              if (pd.created_at_before && pd.created_at_after && pd.created_at_before !== pd.created_at_after) {
                diffHtml += `<div class="log-diff" style="color:#a78bfa">訂單日期：${escHtml(pd.created_at_before)} → ${escHtml(pd.created_at_after)}</div>`;
              }
              if (pd.discount_category_before && pd.discount_category_after && pd.discount_category_before !== pd.discount_category_after) {
                diffHtml += `<div class="log-diff" style="color:#fbbf24">折扣分類：${escHtml(pd.discount_category_before)} → ${escHtml(pd.discount_category_after)}</div>`;
              }
              if (pd.discount_note_before !== undefined && pd.discount_note_before !== pd.discount_note_after) {
                diffHtml += `<div class="log-diff" style="color:#fbbf24">折扣備註：${escHtml(pd.discount_note_before||'空白')} → ${escHtml(pd.discount_note_after||'空白')}</div>`;
              }
              // fix18-09C
              if (pd.discount_campaign_before !== undefined && pd.discount_campaign_before !== pd.discount_campaign_after) {
                diffHtml += `<div class="log-diff" style="color:#fbbf24">折扣活動：${escHtml(pd.discount_campaign_before||'無')} → ${escHtml(pd.discount_campaign_after||'無')}</div>`;
              }
              if (pd.discount_product_before !== undefined && pd.discount_product_before !== pd.discount_product_after) {
                diffHtml += `<div class="log-diff" style="color:#a78bfa">折扣商品：${escHtml(pd.discount_product_before||'無')} → ${escHtml(pd.discount_product_after||'無')}</div>`;
              }
              if (pd.platform_before && pd.platform_after && pd.platform_before !== pd.platform_after) {
                diffHtml += `<div class="log-diff" style="color:#ce93d8">平台來源：${escHtml(pd.platform_before)} → ${escHtml(pd.platform_after)}｜抽成率：${pd.commission_rate_before}% → ${pd.commission_rate_after}%</div>`;
              }
            }
          } catch {}
          const reasonDisplay = (l.reason||'—').split('｜')[0];
          return `
          <div class="log-item">
            <div class="log-item-header">
              <span class="log-action-${l.action}">${l.action === 'void' ? '🚫 作廢' : '✏️ 修改'}</span>
              <span class="log-time">${twTime(l.created_at,'datetime')}</span>
            </div>
            <div class="log-reason">原因：${escHtml(reasonDisplay)}</div>
            <div class="log-diff">
              金額：NT$${l.before_total} → NT$${l.after_total}
              ${l.amount_diff !== 0 ? `（${l.amount_diff > 0 ? '＋' : ''}${l.amount_diff}）` : ''}
              ｜付款：${l.before_payment} → ${l.after_payment}
            </div>
            ${diffHtml}
          </div>`;}).join('')}
      </div>` : '';

    document.getElementById('orderDetailBody').innerHTML = `
      <div style="padding:16px 20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <p style="font-family:monospace;color:#f5a623">訂單：${escHtml(o.order_number)}</p>
          <span class="order-status ${isVoid?'status-void':o.status==='modified'?'status-modified':'status-completed'}">${statusMap[o.status]||'正常'}</span>
        </div>
        <p style="font-size:12px;color:#999;margin-bottom:16px">${twTime(o.created_at,'datetime')}</p>
        ${isVoid ? `<div style="background:#2a0a0a;border:1px solid var(--danger);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:var(--danger)">🚫 作廢原因：${escHtml(o.void_reason||'—')}</div>` : ''}
        ${o.refund_status==='pending_refund' ? `<div style="background:#3a1f0a;border:1px solid #f97316;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:#f97316">💸 該筆為 LINE Pay 已付款訂單，取消後請至待退款清單完成退款</div>` : ''}
        ${o.refund_status==='refunded' ? `<div style="background:#1a1a2a;border:1px solid #64748b;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:#94a3b8">✅ 已完成退款${o.refunded_at?'（'+twTime(o.refunded_at,'datetime')+'）':''}</div>` : ''}
        ${o.order_mode==='delivery' && o.delivery_address ? `
        <div style="background:#0f1f2f;border:1px solid #334155;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px">
          <div>📍 外送地址：${escHtml(o.delivery_address)}</div>
          ${o.delivery_address_note ? `<div style="color:#94a3b8;font-size:12px">備註：${escHtml(o.delivery_address_note)}</div>` : ''}
          ${Number(o.delivery_distance_km)>0 ? `<div style="color:#94a3b8;font-size:12px">距離：${o.delivery_distance_km} km ｜ 外送費：NT$${o.delivery_fee||0}</div>` : ''}
          ${o.delivery_maps_url ? `<div><a href="${escHtml(o.delivery_maps_url)}" target="_blank" rel="noopener" style="color:#60a5fa">🧭 開啟導航</a></div>` : ''}
        </div>` : ''}
        <div class="receipt-body" style="margin:0;padding:0;border-bottom:1px dashed #333;padding-bottom:12px;margin-bottom:12px">
          ${o.items.map(i=>`
            <div class="receipt-item">
              <span class="receipt-item-name">${escHtml(i.name)}</span>
              <span class="receipt-item-qty">x${i.qty}</span>
              <span class="receipt-item-price">$${i.subtotal}</span>
            </div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>付款方式</span><span>${payLabel[o.payment_method]||o.payment_method}</span>
        </div>
        ${o.customer_name||o.customer_phone ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>顧客</span><span>${escHtml(o.customer_name||'')} ${escHtml(o.customer_phone||'')}</span>
        </div>` : ''}
        ${o.note ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>備註</span><span>${escHtml(o.note)}</span>
        </div>` : ''}
        <div style="border-top:1px solid #333;margin-top:12px;padding-top:12px">
          ${(function(){
            const disc=Number(o.discount_amount||0);
            const origTotal=o.original_total||Number(o.total)+disc;
            const codeRow=o.coupon_code
              ? '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;color:#999"><span>🎟️ 優惠券</span><span style="font-family:monospace">'+escHtml(o.coupon_code)+'</span></div>'
              : '';
            const discRows=disc>0
              ? codeRow
                +'<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;color:#999"><span>原價</span><span style="font-family:monospace">NT$'+origTotal+'</span></div>'
                +'<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;color:#06C755"><span>折扣</span><span style="font-family:monospace">-NT$'+disc+'</span></div>'
                +(o.discount_category&&o.discount_category!=='none'?'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;color:#fbbf24"><span>折扣分類</span><span>'+(DISCOUNT_CATEGORY_DISPLAY[o.discount_category]||o.discount_category)+'</span></div>':'')
                +(o.discount_campaign_name?'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;color:#fbbf24"><span>折扣活動</span><span>'+escHtml(o.discount_campaign_name)+'</span></div>':'')
                +(function(){
                  const _pnms2=Array.isArray(o.discount_product_names)&&o.discount_product_names.length?o.discount_product_names:(o.discount_product_name?o.discount_product_name.split('、').map(s=>s.trim()).filter(Boolean):[]);
                  const _isProd2=(o.discount_target_type==='products'||o.discount_target_type==='product');
                  return(_isProd2&&_pnms2.length)?'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;color:#a78bfa"><span>折扣商品</span><span>'+escHtml(_pnms2.join('、'))+'</span></div>':'';
                })()
                +(o.discount_note?'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;color:#94a3b8"><span>折扣備註</span><span>'+escHtml(o.discount_note)+'</span></div>':'')
              : '';
            const label=disc>0?'實收':'應收';
            return discRows+'<div style="display:flex;justify-content:space-between;font-size:20px;font-weight:900"><span>'+label+'</span><span style="color:#f5a623;font-family:monospace">NT$'+o.total+'</span></div>';
          })()}
        </div>
        ${isCash ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;padding-top:6px;color:#999">
          <span>實收</span><span style="font-family:monospace">NT$${o.received_amount||0}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;padding-top:4px;color:#4caf50">
          <span>找零</span><span style="font-family:monospace">NT$${o.change_amount||0}</span>
        </div>` : ''}
      </div>
      ${logsHtml}
    `;
    document.getElementById('orderDetailModal').classList.add('open');
  } catch(e) {
    showToast('載入失敗：' + e.message, 'error');
  }
}

function closeOrderDetail() {
  document.getElementById('orderDetailModal').classList.remove('open');
  currentOrderForPrint = null;
}

// ===== 商品管理頁 =====
async function loadProductsPage() {
  try {
    const res = await apiFetch('/api/products');
    const json = await res.json();
    if (json.success) renderProductsTable(json.data);
  } catch {
    showToast('商品載入失敗', 'error');
  }
}

function renderProductsTable(products) {
  const tbody = document.getElementById('productsBody');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">尚無商品</td></tr>';
    updateProductsSelectedCount();
    return;
  }
  const catEmoji = {};
  allCategories.forEach(c => { catEmoji[c.name] = c.icon || '📌'; });
  tbody.innerHTML = products.map(p => {
    const imgSrc = p.image || getLocalImage(p.id) || '';
    const thumbHtml = imgSrc
      ? `<img class="product-thumb" src="${escAttr(imgSrc)}" alt="${escAttr(p.name)}" onerror="this.outerHTML='<div class=\\'product-thumb-placeholder\\'>${catEmoji[p.category]||'🍽️'}</div>'">`
      : `<div class="product-thumb-placeholder">${catEmoji[p.category] || '🍽️'}</div>`;

    let invBadge = '';
    if (p.inventory_enabled) {
      if (p.has_formula) {
        invBadge = `<br><span class="order-status" style="margin-top:4px;display:inline-block;background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3)">食材控管</span>`;
      } else {
        const units = p.available_units !== null ? p.available_units : 0;
        const cls = units <= 0 ? 'status-void' : p.is_low_stock ? 'status-modified' : 'status-completed';
        invBadge = `<br><span class="order-status ${cls}" style="margin-top:4px;display:inline-block">${units <= 0 ? '售完' : `庫存${units}份`}</span>`;
      }
    }
    // LINE 狀態 badge
    const showOnLine  = p.show_on_line != null ? Number(p.show_on_line) : 1;
    const saleStatus  = p.sale_status  || 'available';
    const lineBadge   = !showOnLine
      ? '<span class="order-status status-void" style="margin-left:4px;display:inline-block;font-size:11px">LINE未上架</span>'
      : '<span class="order-status status-completed" style="margin-left:4px;display:inline-block;font-size:11px">LINE上架</span>';
    const saleBadge   = { sold_out_today:'<span class="order-status status-modified" style="margin-left:4px;display:inline-block;font-size:11px">今日完售</span>',
        paused:'<span class="order-status status-void" style="margin-left:4px;display:inline-block;font-size:11px">暫停販售</span>',
        sold_out_indefinitely:'<span class="order-status status-void" style="margin-left:4px;display:inline-block;font-size:11px">長期下架</span>' }[saleStatus] || '';
    return `
      <tr>
        <td style="text-align:center"><input type="checkbox" class="product-row-check" data-product-id="${p.id}" onchange="updateProductsSelectedCount()"></td>
        <td>${thumbHtml}</td>
        <td style="font-weight:600">${escHtml(p.name)}${invBadge}${lineBadge}${saleBadge}</td>
        <td>${catEmoji[p.category] || ''} ${p.category}</td>
        <td style="font-family:monospace;color:#f5a623;font-weight:700">$${p.price}</td>
        <td><span class="status-badge ${p.enabled ? 'status-on' : 'status-off'}">${p.enabled ? '販售中' : '已停用'}</span></td>
        <td>
          <button class="btn-icon" onclick="openProductModal(${p.id})" style="margin-right:4px">✏️ 編輯</button>
          ${hasFeature('line_order') ? `<button class="btn-icon" onclick="openLineSettingsModal(${p.id})" style="margin-right:4px;background:#06C755;color:#fff;border:none">📲 LINE設定</button>` : ''}
          <button class="btn-icon danger" onclick="deleteProduct(${p.id})">🗑️ 刪除</button>
        </td>
      </tr>`;
  }).join('');
  updateProductsSelectedCount();
}

function openProductModal(id) {
  _imageCleared = false;  // 重置清除旗標
  document.getElementById('editProductId').value = id || '';
  document.getElementById('editProductImage').value = '';
  document.getElementById('editProductImageUrl').value = '';
  document.getElementById('productModalTitle').textContent = id ? '編輯商品' : '新增商品';
  document.getElementById('editProductName').value = '';
  document.getElementById('editProductPrice').value = '';
  // 重置多模式價格
  const safeSet = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  safeSet('editDineInPrice', '');
  safeSet('editTakeawayPrice', '');
  safeSet('editDeliveryPrice', '');
  document.getElementById('editProductEnabled').checked = true;
  document.getElementById('editInventoryEnabled').checked = false;
  document.getElementById('editAllocatedGrams').value = '';
  document.getElementById('editCurrentStockGrams').value = '';
  document.getElementById('editLowStockAlert').value = '5';
  window._editProductHasFormula = false;
  setImagePreview('');
  toggleInventoryFields(false);

  // 動態分類選單
  const catSel = document.getElementById('editProductCategory');
  if (catSel) {
    catSel.innerHTML = allCategories.map(c =>
      `<option value="${escHtml(c.name)}">${c.icon||''} ${escHtml(c.name)}</option>`
    ).join('');
    if (!catSel.options.length) catSel.innerHTML = '<option value="主食">🍚 主食</option>';
  }

  if (id) {
    apiFetch('/api/products/' + id).then(r => r.json()).then(json => {
      if (json.success) {
        const p = json.data;
        document.getElementById('editProductName').value = p.name;
        if (catSel) catSel.value = p.category;
        document.getElementById('editProductPrice').value = p.price;
        // 載入多模式價格
        const safeSet = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        safeSet('editDineInPrice',   p.dine_in_price || '');
        safeSet('editTakeawayPrice', p.takeaway_price || '');
        safeSet('editDeliveryPrice', p.delivery_price || '');
        document.getElementById('editProductEnabled').checked = !!p.enabled;
        document.getElementById('editInventoryEnabled').checked = !!p.inventory_enabled;
        document.getElementById('editAllocatedGrams').value = p.allocated_grams || '';
        document.getElementById('editCurrentStockGrams').value = p.current_stock_grams || '';
        document.getElementById('editLowStockAlert').value = p.low_stock_alert || 5;
        window._editProductHasFormula = !!p.has_formula;
        toggleInventoryFields(!!p.has_formula);
        // 載入圖片：優先 server，再查 localStorage（但若已清除不重帶）
        const imgSrc = p.image || getLocalImage(p.id) || '';
        document.getElementById('editProductImage').value = imgSrc;
        if (imgSrc) {
          document.getElementById('editProductImageUrl').value = imgSrc.startsWith('data:') ? '' : imgSrc;
          setImagePreview(imgSrc);
        }
      }
    });
  }
  document.getElementById('productModal').classList.add('open');
}

function toggleInventoryFields(hasFormula) {
  const enabled = document.getElementById('editInventoryEnabled')?.checked;
  const fields  = document.getElementById('inventoryFields');
  if (!fields) return;
  fields.style.display = enabled ? 'block' : 'none';
  const isFormula = hasFormula != null ? hasFormula : (window._editProductHasFormula || false);
  const notice   = document.getElementById('formulaControlledNotice');
  const stockRow = document.getElementById('stockGramsRow');
  if (notice)   notice.style.display   = (enabled && isFormula) ? 'block' : 'none';
  if (stockRow) stockRow.style.display = (enabled && isFormula) ? 'none'  : '';
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('open');
}

async function saveProduct() {
  const id = document.getElementById('editProductId').value;
  const name = document.getElementById('editProductName').value.trim();
  const catSel = document.getElementById('editProductCategory');
  const category = catSel ? catSel.value : '主食';
  const price = document.getElementById('editProductPrice').value;
  const enabled = document.getElementById('editProductEnabled').checked ? 1 : 0;
  const image = document.getElementById('editProductImage').value || '';
  const inventory_enabled = document.getElementById('editInventoryEnabled')?.checked ? 1 : 0;
  const allocated_grams     = parseFloat(document.getElementById('editAllocatedGrams')?.value || '0') || 0;
  const _isFormulaCtrl = window._editProductHasFormula || false;
  const current_stock_grams = _isFormulaCtrl
    ? undefined
    : (parseFloat(document.getElementById('editCurrentStockGrams')?.value || '0') || 0);
  const low_stock_alert     = parseInt(document.getElementById('editLowStockAlert')?.value || '5') || 5;
  // 多模式價格（空白時後端自動 fallback 到定價）
  const dine_in_price  = parseFloat(document.getElementById('editDineInPrice')?.value || '') || null;
  const takeaway_price = parseFloat(document.getElementById('editTakeawayPrice')?.value || '') || null;
  const delivery_price = parseFloat(document.getElementById('editDeliveryPrice')?.value || '') || null;

  if (!name || !price) { showToast('名稱與價格為必填', 'error'); return; }

  // 決定送給 server 的圖片值
  let serverImage = image;
  if (_imageCleared) {
    serverImage = '';
  } else if (image.startsWith('data:')) {
    const approxKb = Math.round(image.length * 0.75 / 1024);
    if (approxKb > 300) { serverImage = ''; showToast(`圖片較大(${approxKb}KB)，已暫存於本機`, 'info'); }
  }

  const body = { name, category, price: parseFloat(price), enabled, image: serverImage,
    inventory_enabled, allocated_grams, current_stock_grams, low_stock_alert,
    dine_in_price, takeaway_price, delivery_price };
  const url = id ? '/api/products/' + id : '/api/products';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (json.success) {
      const productId = json.data?.id;

      if (_imageCleared && productId) {
        // 使用者清除圖片：清除 localStorage 快取 + 更新記憶體快取
        removeLocalImage(productId);
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = '';
        _imageCleared = false;
      } else if (image.startsWith('data:') && productId) {
        // base64 大圖：存 localStorage + 更新記憶體快取
        saveLocalImage(productId, image);
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = image;
      } else if (image && productId) {
        // URL 圖片：更新記憶體快取
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = image;
      }

      showToast(id ? '商品已更新' : '商品已新增', 'success');
      closeProductModal();
      loadProductsPage();
      loadProducts();
    } else {
      showToast(json.message || '儲存失敗', 'error');
    }
  } catch {
    showToast('網路錯誤', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('確定要刪除此商品？')) return;
  try {
    const res = await apiFetch('/api/products/' + id, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      removeLocalImage(id);  // 清除 localStorage 圖片快取
      showToast('商品已刪除', 'success');
      loadProductsPage();
      loadProducts();
    } else {
      showToast(json.message || '刪除失敗', 'error');
    }
  } catch {
    showToast('網路錯誤', 'error');
  }
}

// ===== LINE 商品設定 Modal (v16) =====

async function openLineSettingsModal(id) {
  try {
    // 載入分類選項（LINE 唯一來源）
    await loadLineCategoryOptions();

    const res = await apiFetch('/api/products/' + id);
    const json = await res.json();
    if (!json.success) { showToast('載入失敗', 'error'); return; }
    const p = json.data;

    document.getElementById('lineSettingsProductId').value = id;
    document.getElementById('lineSettingsProductName').textContent = p.name + (p.category ? ` （${p.category}）` : '');
    document.getElementById('lineShowOnLine').checked  = p.show_on_line != null ? !!Number(p.show_on_line) : true;
    document.getElementById('lineSaleStatus').value    = p.sale_status  || 'available';
    document.getElementById('lineProductName').value   = p.line_name    || '';
    document.getElementById('lineProductPrice').value  = p.line_price   || '';
    document.getElementById('lineProductDesc').value   = p.line_description || '';
    document.getElementById('lineImageUrl').value      = p.line_image_url   || '';
    document.getElementById('lineHot').checked         = !!Number(p.line_hot);
    document.getElementById('linePromo').checked       = !!Number(p.line_promo);
    document.getElementById('lineSoldOut').checked     = !!Number(p.line_sold_out);
    document.getElementById('lineAutoRestore').checked = p.auto_restore_next_day != null ? !!Number(p.auto_restore_next_day) : true;

    // ── LINE 可售份數（v1）────────────────────────────
    const qEnabled = !!Number(p.line_quota_enabled);
    // 使用新的醒目開關 API
    setQuotaEnabled(qEnabled);
    const qDaily   = Number(p.line_quota_daily   || 0);
    const qSold    = Number(p.line_quota_sold     || 0);
    const qLow     = Number(p.line_quota_low_threshold  || 2);
    const qHigh    = Number(p.line_quota_high_threshold || 10);
    const qStart   = p.line_sell_start || '';
    const qEnd     = p.line_sell_end   || '';
    const setQV = (id, v) => { const el=document.getElementById(id); if(el) el.value=v; };
    setQV('lineQuotaDaily',          qDaily);
    setQV('lineQuotaSold',           qSold);
    setQV('lineQuotaLowThreshold',   qLow);
    setQV('lineQuotaHighThreshold',  qHigh);
    setQV('lineSellStart',           qStart);
    setQV('lineSellEnd',             qEnd);
    if (qEnabled) updateLineQuotaStatusBar(qDaily, qSold, qLow, qHigh);

    // ── LINE 顯示分類（客人端）設定 ──
    // 邏輯：優先用 line_category_id；若未設定，預設帶入 category_id（第一次設定時自動帶）
    const lineCatId = Number(p.line_category_id) || 0;
    const fallbackCatId = Number(p.category_id) || 0;  // POS 內部分類 id（備援）
    const catSel = document.getElementById('lineCategory');

    // 更新說明文字：顯示目前 POS 內部分類
    const posLabelHint = document.querySelector('#lineCategory + input + span');
    if (posLabelHint) {
      const posCatName = p.category || '（未設定）';
      posLabelHint.textContent = `💡 LINE 客人看到的分類。若留空則自動沿用 POS 內部分類「${posCatName}」。POS / Android 不受此影響。`;
    }

    if (lineCatId > 0) {
      // 已明確設定 LINE 顯示分類
      catSel.value = String(lineCatId);
      document.getElementById('lineCategoryId').value = lineCatId;
    } else if (fallbackCatId > 0) {
      // 尚未設定 LINE 分類 → 預設帶入 POS 內部分類（方便老闆第一次設定）
      catSel.value = String(fallbackCatId);
      document.getElementById('lineCategoryId').value = fallbackCatId;
    } else if (p.category) {
      // 用名稱比對
      const opts = Array.from(catSel.options);
      const match = opts.find(o => o.textContent.includes(p.category));
      if (match) { catSel.value = match.value; document.getElementById('lineCategoryId').value = match.value; }
      else { catSel.value = ''; document.getElementById('lineCategoryId').value = 0; }
    } else {
      catSel.value = '';
      document.getElementById('lineCategoryId').value = 0;
    }
    catSel.onchange = function() { document.getElementById('lineCategoryId').value = this.value || 0; };

    // 圖片預覽
    const imgUrl = p.line_image_url || '';
    const previewWrap = document.getElementById('lineImgPreviewWrap');
    if (imgUrl) {
      document.getElementById('lineImgPreview').src = imgUrl;
      previewWrap.style.display = 'block';
    } else {
      previewWrap.style.display = 'none';
    }
    document.getElementById('lineImageUrl').oninput = function() {
      const url = this.value.trim();
      if (url) { document.getElementById('lineImgPreview').src = url; previewWrap.style.display = 'block'; }
      else { previewWrap.style.display = 'none'; }
    };

    document.getElementById('lineSettingsModal').classList.add('open');
  } catch(e) { showToast('載入商品資料失敗：' + e.message, 'error'); }
}

// 載入 LINE 顯示分類下拉選項（資料來源：分類管理，與 POS 內部分類共用同一張表）
async function loadLineCategoryOptions() {
  try {
    const res  = await apiFetch('/api/categories/line-options');
    const json = await res.json();
    const sel  = document.getElementById('lineCategory');
    if (!sel) return;
    const curVal = sel.value;
    sel.innerHTML = '<option value="">（使用 POS 內部分類）</option>';
    (json.data || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.icon||'📌'} ${c.name}`;
      sel.appendChild(opt);
    });
    if (curVal) sel.value = curVal;
  } catch {}
}

function closeLineSettingsModal() {
  document.getElementById('lineSettingsModal').classList.remove('open');
}

async function saveLineSettings() {
  const id          = document.getElementById('lineSettingsProductId').value;
  const show_on_line       = document.getElementById('lineShowOnLine').checked ? 1 : 0;
  const sale_status        = document.getElementById('lineSaleStatus').value;
  const line_name          = document.getElementById('lineProductName').value.trim();
  const line_price_raw     = document.getElementById('lineProductPrice').value;
  const line_price         = line_price_raw ? parseFloat(line_price_raw) : 0;
  const line_description   = document.getElementById('lineProductDesc').value.trim();
  const line_image_url     = document.getElementById('lineImageUrl').value.trim();
  const line_category_id   = Number(document.getElementById('lineCategoryId').value) || 0;
  const line_hot           = document.getElementById('lineHot').checked ? 1 : 0;
  const line_promo         = document.getElementById('linePromo').checked ? 1 : 0;
  const line_sold_out      = document.getElementById('lineSoldOut').checked ? 1 : 0;
  const auto_restore_next_day = document.getElementById('lineAutoRestore').checked ? 1 : 0;
  // LINE 可售份數欄位不在這裡宣告，直接在 body 裡讀取

  try {
    const res = await apiFetch(`/api/products/${id}/line-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        show_on_line, sale_status, line_name, line_price,
        line_description, line_image_url, line_category_id,
        line_hot, line_promo, line_sold_out, auto_restore_next_day,
        // LINE 可售份數（v1）
        line_quota_enabled:        document.getElementById('lineQuotaEnabled')?.value === '1' ? 1 : 0,
        line_quota_daily:          Number(document.getElementById('lineQuotaDaily')?.value   || 0),
        line_quota_low_threshold:  Number(document.getElementById('lineQuotaLowThreshold')?.value  || 2),
        line_quota_high_threshold: Number(document.getElementById('lineQuotaHighThreshold')?.value || 10),
        line_sell_start:           document.getElementById('lineSellStart')?.value || '',
        line_sell_end:             document.getElementById('lineSellEnd')?.value   || '',
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('LINE 設定已儲存', 'success');
      closeLineSettingsModal();
      loadProductsPage();
    } else {
      showToast(json.message || '儲存失敗', 'error');
    }
  } catch(e) { showToast('網路錯誤', 'error'); }
}



// ===== 重新列印 =====
// fix18-02：LINE Pay 現場確認收款
async function confirmLinePayPayment(orderId, orderNo) {
  if (!confirm(`確認已收到「${orderNo}」的 LINE Pay 款項？\n\n確認後 payment_status 將更新為 paid。`)) return;
  try {
    const res  = await apiFetch(`/api/online-orders/${encodeURIComponent(orderId)}/confirm-payment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.success) {
      showToast('💚 已確認收款：' + orderNo);
      if (typeof refreshCurrentOrderView === 'function') refreshCurrentOrderView(); // fix18-07：維持目前分頁
    } else {
      showToast('❌ 確認收款失敗：' + (json.error || json.message || ''), 'error');
    }
  } catch(e) {
    showToast('❌ 確認收款失敗：' + e.message, 'error');
  }
}

async function reprintOrder(orderId) {
  try {
    const res = await apiFetch('/api/orders/' + orderId);
    const json = await res.json();
    if (json.success) {
      openPrintWindow(json.data, 'receipt');
      // 非同步通知後端（預留熱感列表機接口）
      apiFetch('/api/orders/' + orderId + '/reprint', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'receipt'}) }).catch(()=>{});
    }
  } catch { showToast('列印失敗', 'error'); }
}

// ===== 作廢訂單 =====
function openVoidModal(orderId, orderNum, amount) {
  document.getElementById('voidOrderId').value = orderId;
  document.getElementById('voidOrderNum').textContent = orderNum;
  document.getElementById('voidOrderAmount').textContent = 'NT$' + amount;
  document.getElementById('voidReason').value = '';
  document.getElementById('voidOrderModal').classList.add('open');
}
function closeVoidModal() {
  document.getElementById('voidOrderModal').classList.remove('open');
}
async function confirmVoid() {
  const id = document.getElementById('voidOrderId').value;
  const reason = document.getElementById('voidReason').value;
  if (!reason) { showToast('請選擇作廢原因', 'error'); return; }
  try {
    const res = await apiFetch('/api/orders/' + id + '/void', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const json = await res.json();
    if (json.success) {
      showToast('訂單已作廢，庫存已回補', 'success');
      closeVoidModal();
      refreshCurrentOrderView(); // fix18-07：維持目前分頁
      // 作廢後後端回補庫存，立即重載點餐頁商品
      _invProducts = [];
      loadProducts();
    } else {
      showToast(json.message || '作廢失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

// ===== 訂單編輯 =====
// ===== fix18-08：平台來源標準化 =====
function normalizePlatform(v) {
  if (!v || v === 'unknown' || v === 'undefined' || v === '未知' || v === '—' || v === '-') return 'unknown';
  const s = String(v).toLowerCase().replace(/\s/g,'');
  if (['pos','pos現場'].includes(s)) return 'pos';
  if (['ubereats','ubereats','uber eats','uber'].some(k => s.includes(k.replace(/\s/g,'')))) return 'ubereats';
  if (['foodpanda','panda'].includes(s)) return 'foodpanda';
  if (['line','line點餐','line_order'].includes(s)) return 'line';
  if (['phone','電話訂購'].includes(s)) return 'phone';
  if (['other','其他'].includes(s)) return 'other';
  return 'unknown';
}

const PLATFORM_LABEL_MAP = {
  unknown:'未知', pos:'POS現場', ubereats:'Uber Eats',
  foodpanda:'foodpanda', line:'LINE點餐', phone:'電話訂購', other:'其他'
};

function platformLabel(code) {
  return PLATFORM_LABEL_MAP[normalizePlatform(code)] || '未知';
}

async function openEditOrder(orderId) {
  try {
    const res = await apiFetch('/api/orders/' + orderId);
    const json = await res.json();
    if (!json.success) { showToast('載入訂單失敗', 'error'); return; }
    const o = json.data;
    editOrderId = o.id;
    editOrderItems = o.items.map(i => ({ ...i }));

    document.getElementById('editOrderId').value = o.id;
    document.getElementById('editOrderNum').textContent = o.order_number;
    document.getElementById('editOrderPayment').value = o.payment_method;
    document.getElementById('editCustomerName').value = o.customer_name || '';
    document.getElementById('editCustomerPhone').value = o.customer_phone || '';
    document.getElementById('editOrderNote').value = o.note || '';
    document.getElementById('editOrderReason').value = '';
    document.getElementById('editReceivedAmount').value = o.payment_method === 'cash' ? (o.received_amount || '') : '';

    // fix18-08：自動帶入平台來源
    const platformEl = document.getElementById('editOrderPlatform');
    if (platformEl) {
      platformEl.value = normalizePlatform(o.delivery_platform || o.platform || '');
    }

    // fix18-09：訂單日期時間
    const createdAtEl = document.getElementById('editOrderCreatedAt');
    if (createdAtEl && o.created_at) {
      // 轉換為 datetime-local 格式 YYYY-MM-DDTHH:MM
      const dt = o.created_at.replace(' ', 'T').slice(0, 16);
      createdAtEl.value = dt;
    }

    // fix18-09：折扣分類（fix18-09E：動態分類）
    const discCatEl = document.getElementById('editDiscountCategory');
    refreshEditOrderCategoryDropdown(o.discount_category || 'none');

    // fix18-09：折扣備註
    const discNoteEl = document.getElementById('editDiscountNote');
    if (discNoteEl) discNoteEl.value = o.discount_note || '';

    // fix18-09C：折扣活動下拉
    await loadDiscountCampaigns();
    refreshEditOrderCampaignDropdown(o.discount_campaign_id || '');

    // fix18-09D：折扣套用商品（多選）
    const targetTypeEl = document.getElementById('editDiscountTargetType');
    // 向下相容：舊資料 'product' → 'products'
    const ttype = (o.discount_target_type === 'product' || o.discount_target_type === 'products') ? 'products' : 'order';
    if (targetTypeEl) targetTypeEl.value = ttype;
    const prodPanel = document.getElementById('editDiscountProductPanel');
    if (prodPanel) prodPanel.style.display = (ttype === 'products') ? 'block' : 'none';

    // 填入可選商品清單
    const sel = document.getElementById('addItemSelect');
    sel.innerHTML = '<option value="">選擇商品...</option>' +
      allProducts.map(p => `<option value="${p.id}" data-price="${p.price}" data-name="${escHtml(p.name)}">${p.name} — NT$${p.price}</option>`).join('');

    document.getElementById('addItemPanel').style.display = 'none';
    onEditPaymentChange();
    renderEditOrderItems();
    // fix18-09D：填入折扣商品 checkbox（需在 editOrderItems 設定後執行）
    if (ttype === 'products') {
      // 優先使用 discount_product_names 陣列，否則 fallback 到 discount_product_name 字串
      const initNames = Array.isArray(o.discount_product_names) && o.discount_product_names.length
        ? o.discount_product_names
        : (o.discount_product_name ? o.discount_product_name.split('、').map(s=>s.trim()).filter(Boolean) : []);
      refreshEditDiscountProductCheckboxes(initNames);
    }
    document.getElementById('editOrderModal').classList.add('open');
  } catch(e) { showToast('載入失敗：' + e.message, 'error'); }
}

function closeEditOrder() {
  document.getElementById('editOrderModal').classList.remove('open');
  editOrderId = null;
  editOrderItems = [];
}

function renderEditOrderItems() {
  const total = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  // fix18-09D：商品變動時同步刷新 checkbox（保持勾選狀態）
  const ttype09d = document.getElementById('editDiscountTargetType')?.value;
  if (ttype09d === 'products') {
    const checked09d = getCheckedDiscountProducts();
    setTimeout(() => refreshEditDiscountProductCheckboxes(checked09d), 0);
  }
  document.getElementById('editOrderItems').innerHTML = editOrderItems.length
    ? editOrderItems.map((item, idx) => `
        <div class="edit-item-row">
          <span class="edit-item-name">${escHtml(item.name)}</span>
          <span class="edit-item-price">$${item.price}</span>
          <div class="cart-item-qty" style="gap:4px">
            <button class="qty-btn" onclick="editItemQty(${idx},-1)">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="editItemQty(${idx},1)">＋</button>
          </div>
          <span class="edit-item-subtotal">$${item.price*item.qty}</span>
          <button class="cart-item-del" onclick="removeEditItem(${idx})">✕</button>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-muted)">暫無商品</div>';

  document.getElementById('editOrderNewTotal').textContent = 'NT$' + total;
  calcEditChange();
  updateEditAmountDiff(total);
}

function editItemQty(idx, delta) {
  editOrderItems[idx].qty += delta;
  if (editOrderItems[idx].qty <= 0) editOrderItems.splice(idx, 1);
  else editOrderItems[idx].subtotal = editOrderItems[idx].price * editOrderItems[idx].qty;
  renderEditOrderItems();
}

function removeEditItem(idx) {
  editOrderItems.splice(idx, 1);
  renderEditOrderItems();
}

function openAddItemToOrder() {
  document.getElementById('addItemPanel').style.display = 'block';
  document.getElementById('addItemQty').value = 1;
  document.getElementById('addItemSelect').value = '';
}

function confirmAddItem() {
  const sel = document.getElementById('addItemSelect');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) { showToast('請選擇商品', 'error'); return; }
  const qty = parseInt(document.getElementById('addItemQty').value) || 1;
  const pid = parseInt(opt.value);
  const price = parseFloat(opt.dataset.price);
  const name = opt.dataset.name;
  const existing = editOrderItems.find(i => i.productId === pid || i.name === name);
  if (existing) { existing.qty += qty; existing.subtotal = existing.price * existing.qty; }
  else editOrderItems.push({ productId: pid, name, price, qty, subtotal: price * qty });
  document.getElementById('addItemPanel').style.display = 'none';
  renderEditOrderItems();
}

function onEditPaymentChange() {
  const method = document.getElementById('editOrderPayment').value;
  const panel = document.getElementById('editCashPanel');
  if (panel) panel.style.display = method === 'cash' ? 'block' : 'none';
}

function calcEditChange() {
  const total = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  const method = document.getElementById('editOrderPayment')?.value;
  const recvEl = document.getElementById('editReceivedAmount');
  const chngEl = document.getElementById('editChangeAmount');
  const warnEl = document.getElementById('editCashWarn');
  if (!recvEl) return;
  if (method !== 'cash') {
    if (chngEl) chngEl.textContent = 'NT$0';
    if (warnEl) warnEl.style.display = 'none';
    return;
  }
  const recv = parseFloat(recvEl.value) || 0;
  const change = recv - total;
  if (chngEl) chngEl.textContent = change >= 0 ? 'NT$' + change : 'NT$0';
  if (warnEl) warnEl.style.display = (recv > 0 && change < 0) ? 'block' : 'none';
}

// 儲存當前原始金額用於計算差異
let _editOriginalTotal = 0;
async function updateEditAmountDiff(newTotal) {
  // 取出原始金額
  if (!editOrderId) return;
  if (!_editOriginalTotal) {
    const r = await apiFetch('/api/orders/' + editOrderId);
    const j = await r.json();
    if (j.success) _editOriginalTotal = j.data.total;
  }
  const diff = newTotal - _editOriginalTotal;
  const banner = document.getElementById('editAmountDiff');
  if (!banner) return;
  if (diff > 0) {
    banner.style.display = 'block';
    banner.className = 'amount-diff-banner diff-surcharge';
    banner.textContent = `需補收 NT$${diff}`;
  } else if (diff < 0) {
    banner.style.display = 'block';
    banner.className = 'amount-diff-banner diff-refund';
    banner.textContent = `需退款 NT$${Math.abs(diff)}`;
  } else {
    banner.style.display = 'none';
  }
}

async function saveEditOrder() {
  const reason = document.getElementById('editOrderReason').value;
  if (!reason) { showToast('請選擇修改原因', 'error'); return; }
  if (!editOrderItems.length) { showToast('商品不能為空', 'error'); return; }

  const payment = document.getElementById('editOrderPayment').value;
  const isCash = payment === 'cash';
  const newTotal = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  const received = isCash ? (parseFloat(document.getElementById('editReceivedAmount').value) || 0) : newTotal;

  if (isCash && received < newTotal) { showToast('實收金額不足', 'error'); return; }

  // fix18-09：取得折扣分類，若有折扣金額則必須選分類
  const discCat = document.getElementById('editDiscountCategory')?.value || 'none';
  // 計算折扣（商品小計 vs 新總金額差異，或直接取原始折扣）
  // 這裡以原始訂單 discount_amount 為基礎，讓後端重算
  const discNote = document.getElementById('editDiscountNote')?.value?.trim() || '';

  // fix18-09C：折扣活動
  const campSel = document.getElementById('editDiscountCampaign');
  const campId   = campSel?.value ? Number(campSel.value) : null;
  const campName = campSel?.value ? (campSel.options[campSel.selectedIndex]?.dataset?.name || campSel.options[campSel.selectedIndex]?.text || '') : '';

  // fix18-09D：折扣套用商品（多選 checkbox）
  const targetType = document.getElementById('editDiscountTargetType')?.value || 'order';
  const isMultiProd = (targetType === 'products');
  const checkedNames = isMultiProd ? getCheckedDiscountProducts() : [];
  // 向下相容欄位（prodId 留空；prodName 存多商品逗號串）
  const prodId    = '';
  const prodName  = checkedNames.join('、');
  // fix18-09D 新欄位（JSON 陣列）
  const prodIds   = [];  // 不存 id，只存 name
  const prodNames = checkedNames;
  // target_type 統一用 products / order
  const effectiveTargetType = isMultiProd ? 'products' : 'order';

  // fix18-09：訂單日期時間
  const createdAtEl = document.getElementById('editOrderCreatedAt');
  let createdAt = null;
  if (createdAtEl && createdAtEl.value) {
    // datetime-local 格式轉換為 "YYYY-MM-DD HH:MM:SS"
    createdAt = createdAtEl.value.replace('T', ' ') + ':00';
  }

  const payload = {
    items: editOrderItems.map(i => ({ ...i, subtotal: i.price * i.qty })),
    payment_method: payment,
    customer_name: document.getElementById('editCustomerName').value.trim(),
    customer_phone: document.getElementById('editCustomerPhone').value.trim(),
    note: document.getElementById('editOrderNote').value.trim(),
    received_amount: received,
    reason,
    // fix18-08：平台來源
    platform: document.getElementById('editOrderPlatform')?.value || 'unknown',
    // fix18-09：新增欄位
    discount_category: discCat,
    discount_note: discNote,
    ...(createdAt ? { created_at: createdAt } : {}),
    // fix18-09D：折扣活動與多商品
    discount_campaign_id:   campId,
    discount_campaign_name: campName,
    discount_target_type:   effectiveTargetType,
    discount_product_id:    prodId,
    discount_product_name:  prodName,
    discount_product_ids:   prodIds,
    discount_product_names: prodNames,
  };

  try {
    const res = await apiFetch('/api/orders/' + editOrderId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      const diff = json.diff;
      if (diff?.type === 'surcharge') showToast(`已儲存，需補收 NT$${diff.amount}`, 'success');
      else if (diff?.type === 'refund') showToast(`已儲存，需退款 NT$${diff.amount}`, 'success');
      else showToast('訂單已修改', 'success');
      // hotfix13-BUG3：LinePay 改現金付款時，後端會自動開錢櫃，這裡提示結果
      if (json.drawerResult) {
        showToast(json.drawerResult.success ? '💰 已自動開啟錢櫃' : ('開錢櫃失敗：' + json.drawerResult.message),
          json.drawerResult.success ? 'success' : 'error');
      }
      _editOriginalTotal = 0;
      closeEditOrder();
      refreshCurrentOrderView(); // fix18-07：維持目前分頁
      // 訂單修改後後端已同步庫存，重載點餐頁
      _invProducts = [];
      loadProducts();
    } else {
      showToast(json.message || '修改失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

// ===== Toast =====
/**
 * twTime(str) — 將資料庫 created_at 字串轉換為台灣時間顯示
 * 支援：
 *   "2024-01-15 05:17:57"  (localtime 已是台灣時間，直接顯示)
 *   "2024-01-15T05:17:57Z" (UTC，需 +8)
 *   "2024-01-15T05:17:57.000Z" (ISO UTC)
 */
function twTime(str, mode = 'datetime') {
  if (!str) return '';
  try {
    let d;
    // 判斷是否為 ISO UTC（含 Z 或 +00:00）
    if (/Z$|[+-]\d{2}:\d{2}$/.test(str)) {
      d = new Date(str); // 已帶時區，直接 parse
    } else {
      // 資料庫 localtime 格式 "YYYY-MM-DD HH:MM:SS" → 視為台灣時間
      // 加上 +08:00 讓 Date 正確解析
      d = new Date(str.replace(' ', 'T') + '+08:00');
    }
    if (isNaN(d.getTime())) return str; // parse 失敗就原樣回傳
    const opts = mode === 'time'
      ? { timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }
      : mode === 'date'
      ? { timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit' }
      : { timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit',
          hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false };
    return d.toLocaleString('zh-TW', opts);
  } catch { return str; }
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

// ===== 工具函式 =====
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== 圖片 localStorage 快取 =====
// 用於暫存 base64 大圖，key = pos_img_{productId}
function saveLocalImage(productId, dataUrl) {
  try {
    localStorage.setItem(`pos_img_${productId}`, dataUrl);
  } catch (e) {
    // localStorage 滿了：清掉最舊的
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pos_img_'));
      if (keys.length) { localStorage.removeItem(keys[0]); }
      localStorage.setItem(`pos_img_${productId}`, dataUrl);
    } catch {}
  }
}

function getLocalImage(productId) {
  try {
    return localStorage.getItem(`pos_img_${productId}`) || null;
  } catch { return null; }
}

function removeLocalImage(productId) {
  try { localStorage.removeItem(`pos_img_${productId}`); } catch {}
}

// ===== 圖片上傳處理 =====

// 讀取上傳的檔案，壓縮後設為預覽
function handleImageFile(event) {
  const file = event.target?.files?.[0] || event.file;
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('請選擇圖片檔案', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const original = e.target.result;
    compressImage(original, 600, 0.82, (compressed) => {
      document.getElementById('editProductImage').value = compressed;
      document.getElementById('editProductImageUrl').value = '';
      setImagePreview(compressed);
    });
    // 重置 input 讓同一檔案可再次選擇（在 onload 後，不在 change 時立即重置）
    const inp = document.getElementById('imgFileInput');
    if (inp) inp.value = '';
  };
  reader.readAsDataURL(file);
}

// 壓縮圖片到指定最大尺寸
function compressImage(dataUrl, maxSize, quality, callback) {
  const img = new Image();
  img.onload = () => {
    let w = img.width, h = img.height;
    if (w > maxSize || h > maxSize) {
      if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
      else { w = Math.round(w * maxSize / h); h = maxSize; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL('image/jpeg', quality));
  };
  img.src = dataUrl;
}

// 處理 URL 輸入
function handleImageUrl(value) {
  const url = value.trim();
  if (!url) {
    const current = document.getElementById('editProductImage').value;
    if (!current.startsWith('data:')) {
      setImagePreview('');
      document.getElementById('editProductImage').value = '';
    }
    return;
  }
  document.getElementById('editProductImage').value = url;
  setImagePreview(url);
}

// 設定 modal 內的圖片預覽
// 修正：base64 不走 onerror（data: URI 不會失敗），URL 才掛 onerror
function setImagePreview(src) {
  const preview     = document.getElementById('imgPreview');
  const placeholder = document.getElementById('imgPlaceholder');
  const actions     = document.getElementById('imgActions');
  if (!preview) return;

  // 先清除舊的 onerror，避免殘留
  preview.onerror = null;

  if (src) {
    placeholder.style.display = 'none';
    actions.style.display = 'flex';
    preview.style.display = 'block';

    if (src.startsWith('data:')) {
      // base64：直接設定，不需要 onerror
      preview.src = src;
    } else {
      // URL：掛 onerror
      preview.onerror = () => {
        preview.style.display = 'none';
        preview.onerror = null;
        placeholder.style.display = 'flex';
        actions.style.display = 'none';
        showToast('圖片網址無法載入，請確認連結', 'error');
      };
      preview.src = src;
    }
  } else {
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
    actions.style.display = 'none';
  }
}

// 清除圖片
// 記錄「使用者主動清除圖片」旗標，確保儲存時送空值到 server
let _imageCleared = false;

function clearProductImage() {
  _imageCleared = true;
  document.getElementById('editProductImage').value = '';
  document.getElementById('editProductImageUrl').value = '';
  // 同步清除 localStorage 快取（若是編輯既有商品）
  const pid = document.getElementById('editProductId').value;
  if (pid) removeLocalImage(Number(pid));
  setImagePreview('');
  showToast('圖片已移除', 'info');
}

// ===== 拖曳上傳 + click 綁定（統一由 JS 管理，避免 HTML onclick 雙觸發）=====
document.addEventListener('DOMContentLoaded', () => {
  const area  = document.getElementById('imgUploadArea');
  const input = document.getElementById('imgFileInput');
  if (!area || !input) return;

  // 單一 click 綁定：只在 area 上，不在 HTML onclick 屬性
  area.addEventListener('click', () => input.click());

  // file input change
  input.addEventListener('change', (e) => handleImageFile(e));

  // 拖曳
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleImageFile({ file });
    }
  });
});

// =============================================
// ===== 分類管理 =====
// =============================================

let allCatsAdmin = [];

async function loadCategoriesPage() {
  try {
    const res = await apiFetch('/api/categories');
    const json = await res.json();
    if (json.success) {
      allCatsAdmin = json.data;
      renderCategoriesTable(json.data);
    }
  } catch { showToast('分類載入失敗', 'error'); }
}

function renderCategoriesTable(cats) {
  const tbody = document.getElementById('categoriesBody');
  if (!cats.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">尚無分類</td></tr>';
    return;
  }
  tbody.innerHTML = cats.map(c => `
    <tr>
      <td><span class="cat-icon-big">${c.icon||'📌'}</span></td>
      <td style="font-weight:700">${escHtml(c.name)}</td>
      <td style="color:var(--text-muted)">${c.sort_order}</td>
      <td><span class="status-badge ${c.is_active?'status-on':'status-off'}">${c.is_active?'啟用':'停用'}</span></td>
      <td>
        <button class="btn-icon" style="margin-right:4px" onclick="openCatModal(${c.id})">✏️ 編輯</button>
        <button class="btn-icon" style="margin-right:4px" onclick="toggleCatActive(${c.id},${c.is_active})">${c.is_active?'⏸️ 停用':'▶️ 啟用'}</button>
        <button class="btn-icon danger" onclick="deleteCat(${c.id})">🗑️ 刪除</button>
      </td>
    </tr>`).join('');
}

function openCatModal(id) {
  document.getElementById('editCatId').value = id || '';
  document.getElementById('catModalTitle').textContent = id ? '編輯分類' : '新增分類';
  document.getElementById('editCatIcon').value = '';
  document.getElementById('editCatName').value = '';
  document.getElementById('editCatOrder').value = '0';
  document.getElementById('editCatActive').checked = true;
  if (id) {
    const cat = allCatsAdmin.find(c => c.id === id);
    if (cat) {
      document.getElementById('editCatIcon').value = cat.icon || '';
      document.getElementById('editCatName').value = cat.name;
      document.getElementById('editCatOrder').value = cat.sort_order;
      document.getElementById('editCatActive').checked = !!cat.is_active;
    }
  }
  document.getElementById('catModal').classList.add('open');
}

function closeCatModal() {
  document.getElementById('catModal').classList.remove('open');
}

async function saveCat() {
  const id   = document.getElementById('editCatId').value;
  const name = document.getElementById('editCatName').value.trim();
  const icon = document.getElementById('editCatIcon').value.trim() || '📌';
  const sort_order = parseInt(document.getElementById('editCatOrder').value) || 0;
  const is_active  = document.getElementById('editCatActive').checked ? 1 : 0;
  if (!name) { showToast('分類名稱必填', 'error'); return; }
  const url    = id ? '/api/categories/' + id : '/api/categories';
  const method = id ? 'PUT' : 'POST';
  try {
    const res  = await apiFetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify({name,icon,sort_order,is_active}) });
    const json = await res.json();
    if (json.success) {
      showToast(id ? '分類已更新' : '分類已新增', 'success');
      closeCatModal();
      loadCategoriesPage();
      loadCategories(); // 更新 POS Tab
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

async function toggleCatActive(id, currentActive) {
  try {
    const res  = await apiFetch('/api/categories/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ is_active: currentActive ? 0 : 1 }) });
    const json = await res.json();
    if (json.success) { loadCategoriesPage(); loadCategories(); showToast('已更新分類狀態', 'success'); }
  } catch { showToast('操作失敗', 'error'); }
}

async function deleteCat(id) {
  if (!confirm('確認刪除此分類？')) return;
  try {
    const res  = await apiFetch('/api/categories/' + id, { method:'DELETE' });
    const json = await res.json();
    if (json.success) { showToast('分類已刪除', 'success'); loadCategoriesPage(); loadCategories(); }
    else { showToast(json.message || '刪除失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 庫存管理 =====
// =============================================

async function loadInventoryPage() {
  try {
    const [invRes, statsRes] = await Promise.all([
      apiFetch('/api/inventory'),
      apiFetch('/api/stats/today')
    ]);
    const invJson   = await invRes.json();
    const statsJson = await statsRes.json();

    if (invJson.success) renderInventoryTable(invJson.data);
    if (statsJson.success && statsJson.data.low_stock_alerts?.length) {
      renderLowStockAlerts(statsJson.data.low_stock_alerts);
    } else {
      document.getElementById('lowStockAlerts').innerHTML = '';
    }
  } catch { showToast('庫存載入失敗', 'error'); }
}

function switchInvSubtab(tab) {
  ['product','ingredient'].forEach(t => {
    const btn = document.getElementById('invSubtab-' + t);
    const panel = document.getElementById('invPanel-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'ingredient') loadIngredientsPage();
  if (tab === 'product') loadInventoryPage();
}

function renderLowStockAlerts(items) {
  if (!items.length) { document.getElementById('lowStockAlerts').innerHTML = ''; return; }
  document.getElementById('lowStockAlerts').innerHTML = `
    <div class="low-stock-banner">
      <h4>⚠️ 低庫存警示（${items.length} 項商品）</h4>
      ${items.map(p => {
        // available_grams 優先（inventoryHelper 已換算）；fallback 到 current_stock_grams
        const grams = p.available_grams != null ? p.available_grams : p.current_stock_grams;
        const units = p.available_units;
        const src   = p.is_formula_controlled ? ' 🔗食材控管' : '';
        return `<div class="low-stock-item">
          <span>${escHtml(p.name)}${src}</span>
          <span class="inv-stock-low">剩 ${units} 份（${Number(grams||0).toFixed(0)}g）</span>
        </div>`;
      }).join('')}
    </div>`;
}

function renderInventoryTable(products) {
  const tbody = document.getElementById('inventoryBody');
  const noNote = document.getElementById('noInventoryNote');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">無庫存管理商品</td></tr>';
    if (noNote) noNote.style.display = 'block';
    return;
  }
  if (noNote) noNote.style.display = 'none';
  tbody.innerHTML = products.map(p => {
    const units = p.available_units;
    const stockCls = units <= 0 ? 'inv-stock-empty' : p.is_low_stock ? 'inv-stock-low' : 'inv-stock-ok';
    const statusText = units <= 0 ? '已售完' : p.is_low_stock ? '低庫存' : '正常';
    const statusCls  = units <= 0 ? 'status-void' : p.is_low_stock ? 'status-modified' : 'status-completed';
    const ingControlled = p.uses_ingredient;
    const sourceCell = ingControlled
      ? `<td style="font-size:11px"><span style="background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);padding:2px 7px;border-radius:4px;font-weight:600">食材控管</span><br><span style="color:var(--text-muted);font-size:11px">${escHtml(p.ingredient_name||'')}</span></td>`
      : `<td style="font-family:monospace">${p.allocated_grams}g</td>`;
    const actionCell = ingControlled
      ? `<td>
           <button class="btn-icon" style="opacity:.5;cursor:not-allowed" onclick="showToast('此商品由食材庫存控管，請至「食材庫存」進貨或完成解凍','info')">📦 補貨</button>
           <button class="btn-icon" style="opacity:.5;cursor:not-allowed" onclick="showToast('此商品由食材庫存控管，請至「食材庫存」操作','info')">🔧 調整</button>
         </td>`
      : `<td>
           <button class="btn-icon edit-btn" style="margin-right:4px" onclick="openRestockModal(${p.id})">📦 補貨</button>
           <button class="btn-icon" onclick="openAdjustModal(${p.id})">🔧 調整</button>
         </td>`;
    return `
      <tr>
        <td style="font-weight:600">${escHtml(p.name)}</td>
        ${sourceCell}
        <td style="font-family:monospace">${Number(p.current_stock_grams).toFixed(0)}g</td>
        <td class="${stockCls}">${units} 份</td>
        <td style="font-family:monospace;color:var(--text-muted)">${p.low_stock_alert} 份</td>
        <td><span class="order-status ${statusCls}">${statusText}</span></td>
        ${actionCell}
      </tr>`;
  }).join('');
}

// ── 補貨 Modal ────────────────────────────────────────────
let _invProducts = [];
async function _ensureInvProducts() {
  if (!_invProducts.length) {
    const r = await apiFetch('/api/inventory');
    const j = await r.json();
    if (j.success) _invProducts = j.data;
  }
}

async function openRestockModal(productId) {
  await _ensureInvProducts();
  const p = _invProducts.find(x => x.id === productId);
  if (!p) return;
  document.getElementById('restockProductId').value = productId;
  document.getElementById('restockProductName').textContent = p.name;
  document.getElementById('restockCurrentInfo').textContent =
    `目前庫存：${Number(p.current_stock_grams).toFixed(0)}g（可售 ${p.available_units} 份）`;
  document.getElementById('restockGrams').value = '';
  document.getElementById('restockReason').value = '補貨';
  document.getElementById('restockModal').classList.add('open');
}

function closeRestockModal() { document.getElementById('restockModal').classList.remove('open'); }

async function confirmRestock() {
  const pid  = document.getElementById('restockProductId').value;
  const grams  = parseFloat(document.getElementById('restockGrams').value);
  const reason = document.getElementById('restockReason').value || '補貨';
  if (!grams || grams <= 0) { showToast('請輸入有效補貨克數', 'error'); return; }
  try {
    const res  = await apiFetch('/api/inventory/restock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ product_id:pid, add_grams:grams, reason }) });
    const json = await res.json();
    if (json.success) {
      const units = json.data.available_units;
      showToast(`補貨成功！現在可售 ${units} 份`, 'success');
      closeRestockModal();
      _invProducts = [];
      loadInventoryPage();
      loadProducts();
    } else { showToast(json.message || '補貨失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// ── 調整 Modal ────────────────────────────────────────────
async function openAdjustModal(productId) {
  await _ensureInvProducts();
  const p = _invProducts.find(x => x.id === productId);
  if (!p) return;
  document.getElementById('adjustProductId').value = productId;
  document.getElementById('adjustProductName').textContent = p.name;
  document.getElementById('adjustCurrentInfo').textContent =
    `目前庫存：${Number(p.current_stock_grams).toFixed(0)}g（可售 ${p.available_units} 份）`;
  document.getElementById('adjustGrams').value = '';
  document.getElementById('adjustModal').classList.add('open');
}

function closeAdjustModal() { document.getElementById('adjustModal').classList.remove('open'); }

async function confirmAdjust() {
  const pid    = document.getElementById('adjustProductId').value;
  const grams  = parseFloat(document.getElementById('adjustGrams').value);
  const reason = document.getElementById('adjustReason').value || '手動調整';
  if (grams === undefined || isNaN(grams)) { showToast('請輸入調整克數', 'error'); return; }
  try {
    const res  = await apiFetch('/api/inventory/adjust', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ product_id:pid, change_grams:grams, reason }) });
    const json = await res.json();
    if (json.success) {
      showToast(`調整成功！現在可售 ${json.data.available_units} 份`, 'success');
      closeAdjustModal();
      _invProducts = [];
      loadInventoryPage();
      loadProducts();
    } else { showToast(json.message || '調整失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// ── 庫存紀錄 ──────────────────────────────────────────────
async function showInventoryLogs(productId) {
  const url = productId ? `/api/inventory/logs?product_id=${productId}&limit=100` : '/api/inventory/logs?limit=100';
  try {
    const res  = await apiFetch(url);
    const json = await res.json();
    if (!json.success) return;
    const logs = json.data;
    const actionLabel = { sale:'售出', restock:'補貨', manual_adjust:'手動調整', void_return:'作廢回補', order_modify_return:'修改回補' };
    document.getElementById('invLogsBody').innerHTML = logs.length
      ? `<table class="data-table" style="font-size:12px">
          <thead><tr><th>時間</th><th>商品</th><th>動作</th><th>變化(g)</th><th>後庫存(g)</th><th>原因</th></tr></thead>
          <tbody>
          ${logs.map(l => `
            <tr>
              <td style="font-family:monospace;white-space:nowrap">${twTime(l.created_at,'datetime')}</td>
              <td>${escHtml(l.product_name)}</td>
              <td><span class="order-status ${l.action.includes('return')||l.action==='restock'?'status-completed':l.action==='sale'?'status-modified':'status-completed'}">${actionLabel[l.action]||l.action}</span></td>
              <td style="font-family:monospace;color:${l.change_grams>=0?'#4caf50':'#e53935'}">${l.change_grams>=0?'+':''}${l.change_grams}g</td>
              <td style="font-family:monospace">${l.after_grams}g</td>
              <td style="color:var(--text-muted)">${escHtml(l.reason||'')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : '<div style="text-align:center;color:var(--text-muted);padding:40px">尚無庫存紀錄</div>';
    document.getElementById('invLogsModal').classList.add('open');
  } catch { showToast('載入失敗', 'error'); }
}

function closeInvLogs() { document.getElementById('invLogsModal').classList.remove('open'); }

// =============================================
// ===== 點餐模式切換 =====
// =============================================

async function loadPlatforms() {
  try {
    const res  = await apiFetch('/api/platforms?active=1');
    const json = await res.json();
    if (json.success) {
      allPlatforms = json.data;
      renderPlatformChips();
    }
  } catch {}
}

function renderPlatformChips() {
  const sel = document.getElementById('platformSelector');
  if (!sel) return;
  sel.innerHTML = allPlatforms.map(p =>
    `<button type="button" class="platform-chip" data-id="${p.id}" data-name="${escHtml(p.name)}" data-rate="${p.commission_rate}" onclick="selectDeliveryPlatform(this)">${escHtml(p.name)}</button>`
  ).join('');
}

function selectDeliveryPlatform(el) {
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedPlatform = { id: Number(el.dataset.id), name: el.dataset.name, commission_rate: Number(el.dataset.rate) };
  updateDeliveryCalc();
}

function switchOrderMode(mode) {
  currentOrderMode = mode;
  selectedPlatform = null;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  // 切換各模式欄位（不清空已輸入資料）
  ['dine_in','takeout','delivery'].forEach(m => {
    const el = document.getElementById('fields-' + m);
    if (el) el.style.display = m === mode ? 'flex' : 'none';
  });

  // 外送：顯示平台選擇
  const platWrap = document.getElementById('delivery-platform-wrap');
  if (platWrap) platWrap.style.display = mode === 'delivery' ? 'block' : 'none';

  // 更新標題
  const titles = { dine_in:'📝 內用點餐', takeout:'🛍️ 外帶點餐', delivery:'🛵 外送點餐' };
  const titleEl = document.getElementById('cartTitle');
  if (titleEl) titleEl.textContent = titles[mode] || '📝 點餐';

  // 重置平台選擇
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  selectedPlatform = null;

  // 若購物車已有商品，提示不自動改價
  if (cart.length > 0) {
    showToast('切換訂單模式不會更改已加入商品價格', 'info');
  }

  // 重繪商品卡（更新顯示價格）
  renderProductGrid();

  // 重新渲染付款方式（依模式不同）
  renderPaymentMethods();

  updateDeliveryCalc();
}

function updateDeliveryCalc() {
  const calcEl = document.getElementById('deliveryCalc');
  if (!calcEl) return;
  if (currentOrderMode !== 'delivery' || !selectedPlatform) { calcEl.style.display = 'none'; return; }
  const subtotal = cart.reduce((s,i) => s+i.subtotal, 0);
  const rate     = selectedPlatform.commission_rate;
  const comm     = Math.round(subtotal * rate / 100 * 100) / 100;
  const income   = subtotal - comm;
  document.getElementById('dcSubtotal').textContent   = 'NT$' + subtotal;
  document.getElementById('dcPlatformName').textContent = selectedPlatform.name;
  document.getElementById('dcRate').textContent         = rate + '%';
  document.getElementById('dcCommission').textContent  = 'NT$' + comm;
  document.getElementById('dcStoreIncome').textContent = 'NT$' + income;
  calcEl.style.display = 'block';
}

// 結帳後重繪外送計算（因為購物車清空）
const _origClearCart = clearCart;

// 覆寫 renderCart 讓外送計算同步
const _origRenderCart = renderCart;
// 注：不需要 monkey-patch，直接在 renderCart 末尾加呼叫 —— 但那函式已存在
// 改用定期檢查：在 calcChange 中呼叫
function _afterRenderCart() {
  updateDeliveryCalc();
}

// =============================================
// ===== 平台管理（設定頁） =====
// =============================================

let allPlatformsAdmin = [];

async function loadPlatformsPage() {
  const tbody = document.getElementById('platformsBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="table-empty">載入中…</td></tr>';
  try {
    const res  = await apiFetch('/api/platforms');
    const json = await res.json();
    if (json.success) {
      allPlatformsAdmin = json.data;
      if (!json.data || json.data.length === 0) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="table-empty">目前尚無資料</td></tr>';
      } else {
        renderPlatformsTable(json.data);
      }
    } else {
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="table-empty" style="color:#e53935">載入失敗：${json.message||'API 錯誤'}</td></tr>`;
    }
  } catch(e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="table-empty" style="color:#e53935">載入失敗，請檢查後端 API</td></tr>';
    showToast('平台載入失敗：' + e.message, 'error');
  }
}

function renderPlatformsTable(platforms) {
  const tbody = document.getElementById('platformsBody');
  if (!platforms.length) { tbody.innerHTML = '<tr><td colspan="4" class="table-empty">尚無平台</td></tr>'; return; }
  tbody.innerHTML = platforms.map(p => `
    <tr>
      <td style="font-weight:700">${escHtml(p.name)}</td>
      <td style="font-family:monospace;color:var(--accent)">${p.commission_rate}%</td>
      <td><span class="status-badge ${p.is_active?'status-on':'status-off'}">${p.is_active?'啟用':'停用'}</span></td>
      <td>
        <button class="btn-icon" style="margin-right:4px" onclick="openPlatformModal(${p.id})">✏️</button>
        <button class="btn-icon danger" onclick="deletePlatform(${p.id})">🗑️</button>
      </td>
    </tr>`).join('');
}

function openPlatformModal(id) {
  document.getElementById('editPlatformId').value = id || '';
  document.getElementById('platformModalTitle').textContent = id ? '編輯平台' : '新增平台';
  document.getElementById('editPlatformName').value = '';
  document.getElementById('editPlatformRate').value = '';
  document.getElementById('editPlatformActive').checked = true;
  if (id) {
    const p = allPlatformsAdmin.find(x => x.id === id);
    if (p) {
      document.getElementById('editPlatformName').value = p.name;
      document.getElementById('editPlatformRate').value = p.commission_rate;
      document.getElementById('editPlatformActive').checked = !!p.is_active;
    }
  }
  document.getElementById('platformModal').classList.add('open');
}
function closePlatformModal() { document.getElementById('platformModal').classList.remove('open'); }

async function savePlatform() {
  const id   = document.getElementById('editPlatformId').value;
  const name = document.getElementById('editPlatformName').value.trim();
  const rate = parseFloat(document.getElementById('editPlatformRate').value) || 0;
  const is_active = document.getElementById('editPlatformActive').checked ? 1 : 0;
  if (!name) { showToast('平台名稱必填', 'error'); return; }
  const url = id ? '/api/platforms/' + id : '/api/platforms';
  const method = id ? 'PUT' : 'POST';
  try {
    const res  = await apiFetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, commission_rate:rate, is_active}) });
    const json = await res.json();
    if (json.success) {
      showToast(id ? '已更新' : '已新增', 'success');
      closePlatformModal();
      loadPlatformsPage();
      loadPlatforms();  // 更新 POS 外送平台列表
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

async function deletePlatform(id) {
  if (!confirm('確認刪除此平台？')) return;
  try {
    const res  = await apiFetch('/api/platforms/' + id, { method:'DELETE' });
    const json = await res.json();
    if (json.success) { showToast('已刪除', 'success'); loadPlatformsPage(); loadPlatforms(); }
    else { showToast(json.message || '刪除失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 訂單資訊展開/隱藏 =====
// =============================================

function toggleOrderInfo() {
  orderInfoExpanded = !orderInfoExpanded;
  const fields = document.getElementById('orderInfoFields');
  const arrow  = document.getElementById('toggleArrow');
  const label  = document.getElementById('orderInfoToggleLabel');
  if (!fields) return;

  if (orderInfoExpanded) {
    fields.classList.remove('collapsed');
    fields.style.maxHeight = fields.scrollHeight + 'px';
    if (arrow) arrow.classList.remove('collapsed');
    if (label) label.textContent = '訂單資訊';
  } else {
    fields.style.maxHeight = fields.scrollHeight + 'px'; // 先設定確切高度再收合
    requestAnimationFrame(() => {
      fields.classList.add('collapsed');
      fields.style.maxHeight = '0';
    });
    if (arrow) arrow.classList.add('collapsed');
    if (label) label.textContent = '訂單資訊（隱藏中）';
  }
}

// 確保初始狀態正確
document.addEventListener('DOMContentLoaded', () => {
  const fields = document.getElementById('orderInfoFields');
  if (fields) fields.style.maxHeight = '600px'; // 初始展開
});

// =============================================
// ===== 付款方式管理頁 =====
// =============================================

async function loadPaymentMethodsPage() {
  const tbody = document.getElementById('paymentMethodsBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">載入中…</td></tr>';
  try {
    const res  = await apiFetch('/api/payment-methods');
    const json = await res.json();
    if (json.success) {
      if (!json.data || json.data.length === 0) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">目前尚無資料</td></tr>';
      } else {
        renderPaymentMethodsTable(json.data);
      }
    } else {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty" style="color:#e53935">載入失敗：${json.message||'API 錯誤'}</td></tr>`;
    }
  } catch(e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty" style="color:#e53935">載入失敗，請檢查後端 API</td></tr>';
    showToast('付款方式載入失敗：' + e.message, 'error');
  }
}

function renderPaymentMethodsTable(methods) {
  const tbody = document.getElementById('paymentMethodsBody');
  if (!methods.length) { tbody.innerHTML = '<tr><td colspan="8" class="table-empty">無資料</td></tr>'; return; }

  tbody.innerHTML = methods.map(m => `
    <tr id="pm-row-${m.id}">
      <td style="font-weight:600">${m.icon} ${escHtml(m.name)}</td>
      <td>
        <label class="pm-toggle">
          <input type="checkbox" ${m.is_active?'checked':''} onchange="updatePM(${m.id},{is_active:this.checked?1:0})">
          <span class="pm-toggle-slider"></span>
        </label>
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_dine_in?'checked':''}
          onchange="updatePM(${m.id},{enable_for_dine_in:this.checked?1:0})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_takeout?'checked':''}
          onchange="updatePM(${m.id},{enable_for_takeout:this.checked?1:0})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_delivery?'checked':''}
          onchange="updatePM(${m.id},{enable_for_delivery:this.checked?1:0})">
      </td>
      <td>
        <input type="number" value="${m.sort_order}" min="0" style="width:50px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:4px;border-radius:4px;text-align:center"
          onchange="updatePM(${m.id},{sort_order:Number(this.value)})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.is_default?'checked':''}
          onchange="updatePM(${m.id},{is_default:this.checked?1:0})">
      </td>
      <td>
        <span style="font-size:11px;color:${m.gateway_code?'var(--text-muted)':'transparent'}">${m.gateway_code||''}</span>
      </td>
    </tr>`).join('');
}

async function updatePM(id, fields) {
  try {
    const res  = await apiFetch('/api/payment-methods/' + id, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields)
    });
    const json = await res.json();
    if (json.success) {
      // 立即同步前台付款方式
      await loadPaymentMethods();
      showToast('已更新', 'success');
    } else { showToast(json.message || '更新失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 金流設定頁 (fix16e: 已完全清理舊版 id-based 函式) =====
// =============================================
//
// fix16e 清理說明：
//   移除的舊版函式（id-based，使用 /api/payment-gateways/:id）：
//     loadGatewayPage()       — 已移除
//     renderGatewayCards(data)— 已移除
//     toggleGateway(id, ...)  — 已移除
//     setGwMode(id, ...)      — 已移除
//     saveGateway(id)         — 已移除
//     testGateway(id)         — 已移除
//
//   現有函式（provider code-based，使用 /api/payment-gateways/:provider）：
//     loadGatewayCards()      — 載入 8 個 provider 卡片
//     saveGateway(code)       — PUT /api/payment-gateways/{code}
//     testGateway(code)       — POST /api/payment-gateways/{code}/test
//
//   switchSettingsTab('gateway') 只呼叫 loadGatewayCards()，見 tab switch 區塊

// =============================================
// ===== 出單機設定頁 =====
// =============================================

// 依後端狀態回傳更新 badge（用於「檢查狀態」按鈕）
function _updatePrinterBadge(data) {
  const badge = document.getElementById('printerStatusBadge');
  const msgEl = document.getElementById('printerStatusMsg');
  const enabled   = data.enabled;
  const connected = data.connected;
  const mode      = data.type || data.mode || 'network';
  if (!badge) return;
  if (!enabled) {
    badge.innerHTML = '<span class="order-status status-void">未啟用</span>';
    if (msgEl) { msgEl.textContent = '請勾選「啟用印表機」並儲存設定。'; msgEl.style.color = 'var(--text-muted)'; }
    return;
  }
  if (connected) {
    badge.innerHTML = `<span class="order-status status-completed">已連線（${mode === 'usb' ? (data.printer_name || 'USB') : (data.ip + ':' + data.port)}）</span>`;
    if (msgEl) { msgEl.textContent = data.message || '印表機正常'; msgEl.style.color = 'var(--success)'; }
  } else {
    badge.innerHTML = `<span class="order-status status-modified">啟用中，未連線</span>`;
    if (msgEl) { msgEl.textContent = data.message || '無法連線'; msgEl.style.color = 'var(--danger)'; }
  }
}

// 儲存設定後純前端更新 badge（不呼叫後端、不觸發 PowerShell / TCP）
function _updatePrinterBadgeFromConfig(cfg) {
  const badge = document.getElementById('printerStatusBadge');
  const msgEl = document.getElementById('printerStatusMsg');
  if (!badge) return;
  const enabled = cfg.printer_enabled === '1' || cfg.printer_enabled === true;
  if (!enabled) {
    badge.innerHTML = '<span class="order-status status-void">未啟用</span>';
    if (msgEl) { msgEl.textContent = '印表機已停用。'; msgEl.style.color = 'var(--text-muted)'; }
    return;
  }
  const type = cfg.printer_type || 'network';
  if (type === 'usb') {
    const name  = cfg.printer_name       || '';
    const share = cfg.printer_share_name || '';
    if (share) {
      badge.innerHTML = `<span class="order-status status-completed">已設定（\\\\127.0.0.1\\${escHtml(share)}）</span>`;
      if (msgEl) { msgEl.textContent = `共享名稱：${share}${name ? '（' + name + '）' : ''}。按「測試列印」驗證。`; msgEl.style.color = 'var(--success)'; }
    } else if (name) {
      badge.innerHTML = '<span class="order-status status-modified">啟用中，未設共享名稱</span>';
      if (msgEl) { msgEl.textContent = '請填寫「Windows 印表機共享名稱」（例如：XP80）。'; msgEl.style.color = 'var(--accent)'; }
    } else {
      badge.innerHTML = '<span class="order-status status-modified">啟用中，未設定印表機</span>';
      if (msgEl) { msgEl.textContent = '請填寫共享名稱與印表機名稱。'; msgEl.style.color = 'var(--accent)'; }
    }
  } else {
    const ip   = cfg.printer_ip   || '192.168.1.100';
    const port = cfg.printer_port || '9100';
    badge.innerHTML = `<span class="order-status status-modified">啟用中（${escHtml(ip)}:${port}）</span>`;
    if (msgEl) { msgEl.textContent = 'LAN 模式，按「檢查狀態」確認 TCP 連線。'; msgEl.style.color = 'var(--text-muted)'; }
  }
}

async function loadPrinterSettings() {
  try {
    const [settingsRes, statusRes] = await Promise.all([
      apiFetch('/api/settings'),
      apiFetch('/api/print/status')
    ]);
    const sJson = await settingsRes.json();
    const pJson = await statusRes.json();

    if (sJson.success) {
      const s = sJson.data;
      const safeCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = (val === '1' || val === true); };
      const safeVal   = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };
      safeCheck('set-printer_enabled', s.printer_enabled);
      safeCheck('set-auto_print',      s.auto_print);
      safeCheck('set-auto_drawer',     s.auto_drawer);
      safeVal('set-printer_type', s.printer_type || 'network');
      safeVal('set-printer_ip',   s.printer_ip   || '192.168.1.100');
      safeVal('set-printer_port', s.printer_port  || '9100');
      safeVal('set-printer_name',       s.printer_name       || '');
      safeVal('set-printer_share_name', s.printer_share_name || '');
    }
    onPrinterTypeChange();
    _updatePrinterBadge(pJson?.data || {});
  } catch(e) {
    console.error('[PrinterSettings] loadPrinterSettings:', e);
  }
}

async function onPrinterEnabledChange() {
  await savePrinterSettings();
}

function onPrinterTypeChange() {
  const type = document.getElementById('set-printer_type')?.value;
  const netF = document.getElementById('networkFields');
  const usbF = document.getElementById('usbFields');
  if (netF) netF.style.display = type === 'usb' ? 'none'  : 'block';
  if (usbF) usbF.style.display = type === 'usb' ? 'block' : 'none';
  // ⚠️ 不自動呼叫 refreshPrinterList()，等使用者點「重新整理」按鈕
}

function onPrinterNameSelect() {
  const sel     = document.getElementById('printerNameSelect');
  const inputEl = document.getElementById('set-printer_name');
  if (sel && inputEl && sel.value) inputEl.value = sel.value;
}

async function refreshPrinterList() {
  const sel = document.getElementById('printerNameSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">載入中...</option>';
  try {
    const res  = await apiFetch('/api/printers/list');
    const json = await res.json();
    const list = json.data || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">找不到 Windows 印表機（請確認環境）</option>';
      return;
    }
    const current = document.getElementById('set-printer_name')?.value || '';
    sel.innerHTML = '<option value="">— 請選擇印表機 —</option>' +
      list.map(name =>
        `<option value="${escHtml(name)}" ${name === current ? 'selected' : ''}>${escHtml(name)}</option>`
      ).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">載入失敗：' + escHtml(e.message) + '</option>';
  }
}

async function savePrinterSettings() {
  const getCheck = id => document.getElementById(id)?.checked ? '1' : '0';
  const getVal   = id => document.getElementById(id)?.value || '';
  const body = {
    printer_enabled: getCheck('set-printer_enabled'),
    printer_type:    getVal('set-printer_type'),
    printer_ip:      getVal('set-printer_ip'),
    printer_port:    getVal('set-printer_port'),
    printer_name:       getVal('set-printer_name'),
    printer_share_name: getVal('set-printer_share_name'),
    auto_print:      getCheck('set-auto_print'),
    auto_drawer:     getCheck('set-auto_drawer'),
  };
  try {
    const res  = await apiFetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      showToast('設定已儲存', 'success');
      // ⚠️ 只更新前端 badge，不重新呼叫後端狀態（避免觸發 PowerShell）
      _updatePrinterBadgeFromConfig(body);
    } else {
      showToast(json.message || '儲存失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}


async function testPrint() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 列印中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    const res  = await apiFetch('/api/print/test', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ ${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ API 連線失敗'; msgEl.style.color = 'var(--danger)'; }
    showToast('測試列印失敗', 'error');
  }
}

async function testKitchenPrint() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 廚房單列印中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    // 使用固定測試內容，不依賴訂單資料
    const res  = await apiFetch('/api/print/kitchen-test', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ 廚房單：${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ 失敗：' + e.message; msgEl.style.color = 'var(--danger)'; }
  }
}

async function testCashDrawer() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 開錢櫃中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    const res  = await apiFetch('/api/print/cashdrawer', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ ${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ API 連線失敗'; msgEl.style.color = 'var(--danger)'; }
    showToast('開錢櫃失敗', 'error');
  }
}

// 訂單紀錄 — 現金訂單手動開錢櫃
async function openDrawerFromOrder(orderId) {
  try {
    const res  = await apiFetch('/api/print/cashdrawer', { method: 'POST' });
    const json = await res.json();
    showToast(json.success ? '💰 錢櫃已開啟' : ('開錢櫃失敗：' + json.message), json.success ? 'success' : 'error');
  } catch(e) {
    showToast('開錢櫃失敗：' + e.message, 'error');
  }
}

async function checkPrinterStatus() {
  const badge = document.getElementById('printerStatusBadge');
  if (badge) badge.innerHTML = '<span class="order-status status-modified">檢查中...</span>';
  try {
    const res  = await apiFetch('/api/print/status');
    const json = await res.json();
    _updatePrinterBadge(json?.data || {});
    return json?.data;
  } catch(e) {
    if (badge) badge.innerHTML = '<span class="order-status status-void">API 連線失敗</span>';
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// v16 整合：LINE 營業設定 + 食材庫存管理
// ═══════════════════════════════════════════════════════════

// ── LINE 總開關 ──────────────────────────────────────────
async function loadLineBizStatus() {
  try {
    const res  = await apiFetch('/api/settings');
    const json = await res.json();
    const d    = json.data || {};
    const el   = document.getElementById('lineOrderingStatus');
    const todayStr = new Date().toISOString().slice(0,10);
    if (el) {
      const isOn  = d.line_ordering_enabled !== '0';
      const isCls = d.line_today_closed === '1' && d.line_today_closed_date === todayStr;
      el.innerHTML = isOn
        ? '<span style="color:#06C755">● 目前：營業中</span>'
        : '<span style="color:#e53935">● 目前：已關閉</span>';
      const todayEl = document.getElementById('todayClosedStatus');
      if (todayEl) todayEl.innerHTML = isCls
        ? '<span style="color:#e53935">● 今日已設定臨時休息</span>'
        : '<span style="color:#06C755">● 今日正常營業</span>';
      const pdEl = document.getElementById('pickupDeliveryStatus');
      if (pdEl) pdEl.innerHTML =
        `外帶：${d.takeout_enabled !== '0' ? '✅ 開啟' : '❌ 關閉'}　外送：${d.delivery_enabled !== '0' ? '✅ 開啟' : '❌ 關閉'}`;
      // 即時狀態小卡
      const now = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei'}));
      const nowMins = now.getHours()*60+now.getMinutes();
      const toCard = document.getElementById('takeout-live-status');
      const dlCard = document.getElementById('delivery-live-status');
      // fix18-06: 即時狀態判斷用今日臨時截止（若有且今天）
      function _effectiveCutoff(prefix, d) {
        const twN = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei'}));
        const todayS = twN.getFullYear()+'-'+String(twN.getMonth()+1).padStart(2,'0')+'-'+String(twN.getDate()).padStart(2,'0');
        const todayCT = d[prefix+'_today_cutoff_time'];
        const todayCDate = d[prefix+'_today_cutoff_date'];
        if(todayCT && todayCDate === todayS) return todayCT;
        return d[prefix+'_cutoff_time'] || '';
      }
      if(toCard){
        const enabled = d.takeout_enabled !== '0';
        const cutoff = _effectiveCutoff('takeout', d);
        const cutoffPassed = cutoff && nowMins > cutoff.split(':').reduce((h,m,i)=>i?h*60+Number(m):Number(m)*60,0)/60;
        toCard.innerHTML = !enabled ? '<span style="color:#e53935">已關閉</span>'
          : cutoffPassed ? '<span style="color:#ff6d00">截止售完</span>'
          : '<span style="color:#06C755">接單中</span>';
      }
      if(dlCard){
        const enabled = d.delivery_enabled !== '0';
        const cutoff = _effectiveCutoff('delivery', d);
        const cutoffPassed = cutoff && nowMins > cutoff.split(':').reduce((h,m,i)=>i?h*60+Number(m):Number(m)*60,0)/60;
        dlCard.innerHTML = !enabled ? '<span style="color:#e53935">已關閉</span>'
          : cutoffPassed ? '<span style="color:#ff6d00">截止售完</span>'
          : '<span style="color:#06C755">接單中</span>';
      }
      // 填入 LINE 付款方式設定
      const lpMap = {
        cash: 'line_payment_cash_enabled', linepay: 'line_payment_linepay_enabled',
        transfer: 'line_payment_transfer_enabled', platform: 'line_payment_platform_enabled',
        credit_card: 'line_payment_credit_card_enabled'
      };
      Object.entries(lpMap).forEach(([code, key]) => {
        const el = document.getElementById(`lp-${code}`);
        if (el) el.checked = d[key] === '1';
      });
    }
    // ── 外帶規則填入（v1）──────────────────────────────
    const setV = (id, val) => { const el = document.getElementById(id); if(el) el.value = val||''; };
    const setC = (id, val) => { const el = document.getElementById(id); if(el) el.checked = !!val; };
    setC('set-takeout_enabled',        d.takeout_enabled !== '0');
    setV('set-takeout_prep_minutes',   d.takeout_prep_minutes || 15);
    setC('set-takeout_allow_next_day', d.takeout_allow_next_day !== '0');
    setC('set-delivery_enabled',       d.delivery_enabled !== '0');
    setV('set-delivery_prep_minutes',  d.delivery_prep_minutes || 30);
    setC('set-delivery_allow_next_day',d.delivery_allow_next_day !== '0');
    // fix18-06: 今日臨時截止時間顯示（只顯示今天的設定，舊的忽略）
    _renderTodayCutoffStatus('takeout',   d.takeout_today_cutoff_time,   d.takeout_today_cutoff_date);
    _renderTodayCutoffStatus('delivery',  d.delivery_today_cutoff_time,  d.delivery_today_cutoff_date);
    renderModeHoursGrid('takeoutBizHoursGrid', d.takeout_business_hours);
    renderModeHoursGrid('deliveryBizHoursGrid', d.delivery_business_hours);
    // ── 整體營業時間（舊版相容）──────────────────────────
    const bhe = document.getElementById('set-line_business_hours_enabled');
    if (bhe) bhe.checked = d.line_business_hours_enabled === '1';
    renderBizHoursGrid(d.line_business_hours);
    // 填入進階預約設定
    const sdm = document.getElementById('set-same_day_preorder_minutes');
    if (sdm) sdm.value = d.same_day_preorder_minutes || 30;
    const ndh = document.getElementById('set-next_day_preorder_hours');
    if (ndh) ndh.value = d.next_day_preorder_hours || 2;
    // 固定公休日
    const cwds = (() => { try { return JSON.parse(d.line_closed_weekdays || '[]'); } catch { return []; } })();
    document.querySelectorAll('.cwd-chk').forEach(cb => { cb.checked = cwds.includes(cb.value); });
    // 指定店休日
    const cdates = (() => { try { return JSON.parse(d.line_closed_dates || '[]'); } catch { return []; } })();
    const cdText = document.getElementById('set-line_closed_dates_text');
    if (cdText) cdText.value = cdates.join('\n');
  } catch {}
  // 📅 營業行事曆 Business Calendar V2：今日狀態 + 列表
  refreshTodayBusinessStatus();
  loadBusinessCalendar();
}

async function saveAdvancedLineSettings() {
  const sdm = parseInt(document.getElementById('set-same_day_preorder_minutes')?.value || 30) || 30;
  const ndh = parseInt(document.getElementById('set-next_day_preorder_hours')?.value || 2)  || 2;
  const cwds = Array.from(document.querySelectorAll('.cwd-chk:checked')).map(cb => cb.value);
  const cdRaw = (document.getElementById('set-line_closed_dates_text')?.value || '').split('\n')
    .map(d => d.trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        same_day_preorder_minutes: String(sdm),
        next_day_preorder_hours:   String(ndh),
        line_closed_weekdays:      JSON.stringify(cwds),
        line_closed_dates:         JSON.stringify(cdRaw),
      }) });
    showToast('✅ 預約設定已儲存', 'success');
    loadLineBizStatus();
  } catch(e) { showToast('儲存失敗', 'error'); }
}

async function setLineOrdering(enable) {
  const msg = enable
    ? '確定要開啟 LINE 點餐營業嗎？\n開啟後客人可以重新透過 LINE 下單。'
    : '確定要關閉 LINE 點餐營業嗎？\n關閉後客人將無法透過 LINE 下單，但現場 POS 不受影響。';
  if (!confirm(msg)) return;
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ line_ordering_enabled: enable ? '1' : '0' }) });
    showToast(enable ? '✅ LINE 點餐已開啟' : '🔴 LINE 點餐已關閉', 'success');
    loadLineBizStatus();
  } catch(e) { showToast('操作失敗', 'error'); }
}

// ═══════════════════════════════════════════════════════════
// 📅 營業行事曆 Business Calendar V2（特殊營業日 / 休假日期覆蓋層）
// ═══════════════════════════════════════════════════════════
let _businessCalendarCache = [];

// ── 今日狀態：🟢 正常營業 / 🟡 特殊營業 / 🔴 特殊休息 / 🔴 臨時休息（今日臨時休息優先）──
async function refreshTodayBusinessStatus() {
  const el = document.getElementById('businessCalendarTodayStatus');
  if (!el) return;
  el.textContent = '載入中…';
  try {
    const [settingsRes, todayRes] = await Promise.all([
      apiFetch('/api/settings').then(r => r.json()),
      apiFetch('/api/settings/business-calendar/today').then(r => r.json()),
    ]);
    const s = settingsRes.data || {};
    const todayStr = new Date().toISOString().slice(0,10);
    const isTodayTempClosed = s.line_today_closed === '1' && s.line_today_closed_date === todayStr;
    const cal = todayRes.data || { matched: false };

    if (isTodayTempClosed) {
      // 今日臨時休息優先於營業行事曆
      el.innerHTML = '<span style="color:#e53935">🔴 今日臨時休息</span>';
      return;
    }
    if (!cal.matched) {
      el.innerHTML = '<span style="color:#06C755">🟢 今日正常營業</span>';
      return;
    }
    if (cal.mode === 'closed') {
      const reasonTxt = (cal.show_reason && cal.reason) ? `：${escapeHtml(cal.reason)}` : '';
      el.innerHTML = `<span style="color:#e53935">🔴 今日特殊休息${reasonTxt}</span>`;
    } else if (cal.mode === 'custom_hours') {
      const parts = [];
      if (cal.takeout_enabled && cal.takeout_start_time)  parts.push(`外帶 ${cal.takeout_start_time}~${cal.takeout_end_time}`);
      if (cal.delivery_enabled && cal.delivery_start_time) parts.push(`外送 ${cal.delivery_start_time}~${cal.delivery_end_time}`);
      el.innerHTML = `<span style="color:#f9a825">🟡 今日特殊營業${parts.length ? '：' + parts.join('　') : ''}</span>`;
    } else if (cal.mode === 'open_all_day') {
      el.innerHTML = '<span style="color:#06C755">🟢 今日全天營業</span>';
    } else {
      el.innerHTML = '<span style="color:#06C755">🟢 今日正常營業</span>';
    }
  } catch(e) {
    el.innerHTML = '<span style="color:#e53935">狀態載入失敗</span>';
  }
}

// ── 小工具：YYYY-MM-DD → YYYY/MM/DD ──────────────────────
function _bcFmtDate(d) { return (d || '').replaceAll('-', '/'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── 列表載入 ──────────────────────────────────────────────
async function loadBusinessCalendar() {
  const listEl = document.getElementById('businessCalendarList');
  if (!listEl) return;
  listEl.textContent = '載入中…';
  try {
    const res  = await apiFetch('/api/settings/business-calendar');
    const json = await res.json();
    _businessCalendarCache = json.data || [];
    renderBusinessCalendar(_businessCalendarCache);
  } catch(e) {
    listEl.innerHTML = '<div style="color:#e53935;font-size:13px">載入失敗</div>';
  }
}

// ── 列表渲染 ──────────────────────────────────────────────
function renderBusinessCalendar(list) {
  const listEl = document.getElementById('businessCalendarList');
  if (!listEl) return;
  if (!list || !list.length) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">尚未設定任何特殊營業日</div>';
    return;
  }
  listEl.innerHTML = list.map(item => {
    const icon = item.mode === 'closed' ? '🔴' : (item.mode === 'custom_hours' ? '🟡' : '🟢');
    const dateRange = item.start_date === item.end_date
      ? _bcFmtDate(item.start_date)
      : `${_bcFmtDate(item.start_date)}～${_bcFmtDate(item.end_date)}`;

    let modeDetail = '';
    if (item.mode === 'closed') {
      modeDetail = '全天休息';
    } else if (item.mode === 'open_all_day') {
      modeDetail = '全天營業';
    } else {
      const lines = [];
      lines.push(item.takeout_enabled
        ? `外帶 ${escapeHtml(item.takeout_start_time)}～${escapeHtml(item.takeout_end_time)}`
        : '外帶：不開放');
      lines.push(item.delivery_enabled
        ? `外送 ${escapeHtml(item.delivery_start_time)}～${escapeHtml(item.delivery_end_time)}`
        : '外送：不開放');
      modeDetail = `特殊營業<br>${lines.join('<br>')}`;
    }

    const reasonLine = item.reason
      ? `<div style="font-size:13px;color:var(--text-secondary);margin:4px 0">${escapeHtml(item.reason)}</div>`
      : '';
    const showReasonLine = item.reason
      ? `<div style="font-size:12px;color:var(--text-muted)">顯示給客人：${item.show_reason ? '是' : '否'}</div>`
      : '';

    return `
      <div style="background:var(--bg-base,#0f172a);border:1px solid var(--border,#334155);border-radius:8px;padding:12px 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:14px;font-weight:700">${icon} ${dateRange}</div>
          ${reasonLine}
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${modeDetail}</div>
          ${showReasonLine}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn-secondary" style="padding:6px 12px;font-size:12px" onclick="editBusinessCalendar(${item.id})">編輯</button>
          <button class="btn-secondary" style="padding:6px 12px;font-size:12px;color:#e53935;border-color:#e53935" onclick="deleteBusinessCalendar(${item.id})">刪除</button>
        </div>
      </div>`;
  }).join('');
}

// ── 新增/編輯視窗：開啟 ───────────────────────────────────
function openBusinessCalendarForm(id) {
  const modal = document.getElementById('businessCalendarModal');
  const title = document.getElementById('businessCalendarModalTitle');
  const errEl = document.getElementById('bc-form-error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  const item = id ? _businessCalendarCache.find(x => x.id === id) : null;

  document.getElementById('bc-id').value = item ? item.id : '';
  document.getElementById('bc-start_date').value = item ? item.start_date : '';
  document.getElementById('bc-end_date').value   = item ? item.end_date   : '';
  document.querySelectorAll('input[name="bc-mode"]').forEach(r => { r.checked = (r.value === (item ? item.mode : 'closed')); });
  document.getElementById('bc-reason').value = item ? item.reason : '';
  document.getElementById('bc-show_reason').checked = item ? !!item.show_reason : true;
  document.getElementById('bc-takeout_enabled').checked  = item ? !!item.takeout_enabled  : true;
  document.getElementById('bc-delivery_enabled').checked = item ? !!item.delivery_enabled : true;
  document.getElementById('bc-takeout_start_time').value  = item ? item.takeout_start_time  : '';
  document.getElementById('bc-takeout_end_time').value    = item ? item.takeout_end_time    : '';
  document.getElementById('bc-delivery_start_time').value = item ? item.delivery_start_time : '';
  document.getElementById('bc-delivery_end_time').value   = item ? item.delivery_end_time   : '';

  if (title) title.textContent = item ? '編輯行事曆' : '＋新增行事曆';
  onBusinessCalendarModeChange();
  if (modal) modal.classList.add('open');
}

function editBusinessCalendar(id) { openBusinessCalendarForm(id); }

function closeBusinessCalendarForm() {
  const modal = document.getElementById('businessCalendarModal');
  if (modal) modal.classList.remove('open');
}

// ── 模式切換：closed 隱藏時間欄位／custom_hours 顯示／open_all_day 停用 ──
function onBusinessCalendarModeChange() {
  const mode = document.querySelector('input[name="bc-mode"]:checked')?.value || 'closed';
  const hoursSection = document.getElementById('bc-hours-section');
  const takeoutRow = document.getElementById('bc-takeout-time-row');
  const deliveryRow = document.getElementById('bc-delivery-time-row');
  const takeoutEnabled  = document.getElementById('bc-takeout_enabled')?.checked;
  const deliveryEnabled = document.getElementById('bc-delivery_enabled')?.checked;

  if (mode === 'closed') {
    if (hoursSection) hoursSection.style.display = 'none';
    return;
  }
  // custom_hours / open_all_day 都需要顯示外帶/外送開放開關
  if (hoursSection) hoursSection.style.display = 'block';

  const isCustom = mode === 'custom_hours';
  if (takeoutRow) takeoutRow.style.display = (isCustom && takeoutEnabled) ? 'flex' : 'none';
  if (deliveryRow) deliveryRow.style.display = (isCustom && deliveryEnabled) ? 'flex' : 'none';
  // open_all_day：時間輸入停用（不需要輸入，全天視為開放）
  ['bc-takeout_start_time','bc-takeout_end_time','bc-delivery_start_time','bc-delivery_end_time'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !isCustom;
  });
}

// ── 儲存（新增/編輯共用）──────────────────────────────────
async function saveBusinessCalendar() {
  const errEl = document.getElementById('bc-form-error');
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  const id = document.getElementById('bc-id').value;
  const mode = document.querySelector('input[name="bc-mode"]:checked')?.value || 'closed';
  const startDate = document.getElementById('bc-start_date').value;
  const endDate   = document.getElementById('bc-end_date').value;

  if (!startDate || !endDate) return showErr('請填寫開始日期與結束日期');
  if (endDate < startDate) return showErr('結束日期不可早於開始日期');

  const payload = {
    start_date: startDate,
    end_date: endDate,
    mode,
    reason: document.getElementById('bc-reason').value.trim(),
    show_reason: document.getElementById('bc-show_reason').checked,
    takeout_enabled:  document.getElementById('bc-takeout_enabled').checked,
    delivery_enabled: document.getElementById('bc-delivery_enabled').checked,
    takeout_start_time: document.getElementById('bc-takeout_start_time').value,
    takeout_end_time:   document.getElementById('bc-takeout_end_time').value,
    delivery_start_time: document.getElementById('bc-delivery_start_time').value,
    delivery_end_time:   document.getElementById('bc-delivery_end_time').value,
  };

  try {
    const url = id ? `/api/settings/business-calendar/${id}` : '/api/settings/business-calendar';
    const res = await apiFetch(url, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.success) return showErr(json.message || '儲存失敗');

    showToast(id ? '✅ 行事曆已更新' : '✅ 行事曆已新增', 'success');
    closeBusinessCalendarForm();
    loadBusinessCalendar();
    refreshTodayBusinessStatus();
  } catch(e) {
    showErr('儲存失敗：' + e.message);
  }
}

// ── 刪除 ──────────────────────────────────────────────────
async function deleteBusinessCalendar(id) {
  if (!confirm('確定要刪除這筆行事曆設定嗎？')) return;
  try {
    const res  = await apiFetch(`/api/settings/business-calendar/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) return showToast(json.message || '刪除失敗', 'error');
    showToast('🗑️ 已刪除', 'success');
    loadBusinessCalendar();
    refreshTodayBusinessStatus();
  } catch(e) { showToast('刪除失敗', 'error'); }
}

async function setTodayClosed(closed) {
  const msg = closed
    ? '確定要設定今日臨時休息？\n今日 LINE 點餐將無法下單，隔日自動恢復。'
    : '確定要取消今日臨時休息？';
  if (!confirm(msg)) return;
  const todayStr = new Date().toISOString().slice(0,10);
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ line_today_closed: closed ? '1' : '0', line_today_closed_date: todayStr }) });
    showToast(closed ? '🌙 今日已設定臨時休息' : '✅ 已取消今日休息', 'success');
    loadLineBizStatus();
  } catch(e) { showToast('操作失敗', 'error'); }
}

async function setPickup(enable) {
  await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pickup_enabled: enable ? '1' : '0' }) });
  showToast(enable ? '✅ 自取已開啟' : '❌ 自取已關閉', 'success');
  loadLineBizStatus();
}

async function setDelivery(enable) {
  await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ delivery_enabled: enable ? '1' : '0' }) });
  showToast(enable ? '✅ 外送已開啟' : '❌ 外送已關閉', 'success');
  loadLineBizStatus();
}

async function saveLinePaymentSettings() {
  const lpMap = {
    cash: 'line_payment_cash_enabled', linepay: 'line_payment_linepay_enabled',
    transfer: 'line_payment_transfer_enabled', platform: 'line_payment_platform_enabled',
    credit_card: 'line_payment_credit_card_enabled'
  };
  const body = {};
  Object.entries(lpMap).forEach(([code, key]) => {
    const el = document.getElementById(`lp-${code}`);
    if (el) body[key] = el.checked ? '1' : '0';
  });
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body) });
    const enabled = Object.entries(lpMap)
      .filter(([code]) => document.getElementById(`lp-${code}`)?.checked)
      .map(([code]) => ({ cash:'現金', linepay:'LINE Pay', transfer:'轉帳', platform:'平台付款', credit_card:'信用卡' }[code]))
      .join('、');
    const st = document.getElementById('linePaymentStatus');
    if (st) st.textContent = enabled ? `✅ 已開啟：${enabled}` : '⚠️ 所有付款方式已關閉';
    showToast('✅ LINE 付款方式已儲存', 'success');
  } catch(e) { showToast('儲存失敗', 'error'); }
}

const DAY_NAMES = { mon:'週一', tue:'週二', wed:'週三', thu:'週四', fri:'週五', sat:'週六', sun:'週日' };
const DAY_KEYS  = ['mon','tue','wed','thu','fri','sat','sun'];

function renderBizHoursGrid(hoursJsonStr) {
  const grid = document.getElementById('bizHoursGrid');
  if (!grid) return;
  let hours = {};
  try { hours = JSON.parse(hoursJsonStr || '{}'); } catch {}
  grid.innerHTML = DAY_KEYS.map(d => {
    const dh = hours[d] || { open:'09:00', close:'21:00', enabled: d !== 'sun' };
    return `<div style="background:#fff;padding:10px 12px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;min-width:0">
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:700;color:#222;cursor:pointer">
        <input type="checkbox" id="bh-${d}-en" ${dh.enabled?'checked':''} onchange="saveBizHoursFromGrid()">
        <span>${DAY_NAMES[d]}</span>
      </label>
      <div style="display:flex;gap:4px;align-items:center;font-size:13px;flex-wrap:wrap">
        <input type="time" id="bh-${d}-open" value="${dh.open||'09:00'}" onchange="saveBizHoursFromGrid()" style="flex:1;min-width:80px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;color:#222;background:#fff;box-sizing:border-box">
        <span style="color:#555;flex-shrink:0">～</span>
        <input type="time" id="bh-${d}-close" value="${dh.close||'21:00'}" onchange="saveBizHoursFromGrid()" style="flex:1;min-width:80px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;color:#222;background:#fff;box-sizing:border-box">
      </div>
    </div>`;
  }).join('');
}

async function saveLineBizSettings() {
  const hours = {};
  DAY_KEYS.forEach(d => {
    const en    = document.getElementById(`bh-${d}-en`);
    const open  = document.getElementById(`bh-${d}-open`);
    const close = document.getElementById(`bh-${d}-close`);
    if (en) hours[d] = { enabled: en.checked, open: open?.value||'09:00', close: close?.value||'21:00' };
  });
  const bhe = document.getElementById('set-line_business_hours_enabled');
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        line_business_hours_enabled: bhe?.checked ? '1' : '0',
        line_business_hours: JSON.stringify(hours)
      })
    });
    showToast('✅ 營業時間已儲存', 'success');
  } catch(e) { showToast('儲存失敗', 'error'); }
}

async function saveBizHoursFromGrid() { /* 即時儲存，不需 Toast */ saveLineBizSettings().catch(()=>{}); }

// ═══════════════════════════════════════════════════════════
// LINE 接單與可售管理中心 v1 — Web 後台 JS
// ═══════════════════════════════════════════════════════════

// ── 外帶/外送每週營業時間 Grid ──────────────────────────
function renderModeHoursGrid(gridId, hoursJsonStr) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  let hours = {};
  try { hours = JSON.parse(hoursJsonStr || '{}'); } catch {}
  const mode = gridId.startsWith('takeout') ? 'takeout' : 'delivery';
  grid.innerHTML = DAY_KEYS.map(d => {
    const dh = hours[d] || { open:'11:00', close:'20:00', enabled: d !== 'sun' };
    return `<div style="background:#fff;padding:10px 12px;border-radius:8px;border:1px solid #ddd;box-sizing:border-box;min-width:0">
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:700;color:#222;cursor:pointer">
        <input type="checkbox" id="${mode}-bh-${d}-en" ${dh.enabled?'checked':''} onchange="saveModeHoursFromGrid('${mode}')">
        <span>${DAY_NAMES[d]}</span>
      </label>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <input type="time" id="${mode}-bh-${d}-open" value="${dh.open||'11:00'}" onchange="saveModeHoursFromGrid('${mode}')"
          style="width:130px;min-width:120px;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;color:#222;background:#fff;box-sizing:border-box;flex-shrink:0">
        <span style="color:#555;flex-shrink:0;font-size:13px">～</span>
        <input type="time" id="${mode}-bh-${d}-close" value="${dh.close||'20:00'}" onchange="saveModeHoursFromGrid('${mode}')"
          style="width:130px;min-width:120px;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;color:#222;background:#fff;box-sizing:border-box;flex-shrink:0">
      </div>
    </div>`;
  }).join('');
}

// ── 外帶/外送接單規則儲存 ─────────────────────────────
// ── fix18-06: 今日臨時截止時間輔助函式 ──────────────────────
function _renderTodayCutoffStatus(mode, cutoffTime, cutoffDate) {
  const statusEl = document.getElementById(mode + '-today-cutoff-status');
  const inputEl  = document.getElementById('set-' + mode + '_today_cutoff_time');
  if (!statusEl) return;

  const twNow = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'}));
  const todayStr = twNow.getFullYear() + '-'
    + String(twNow.getMonth()+1).padStart(2,'0') + '-'
    + String(twNow.getDate()).padStart(2,'0');

  const isToday = cutoffTime && cutoffDate === todayStr;

  if (inputEl) inputEl.value = isToday ? cutoffTime : '';

  if (isToday) {
    statusEl.innerHTML = '<span style="color:#e65100;font-weight:600">⏰ 今日臨時截止：' + cutoffTime
      + '</span>（儲存時可修改，或點「✕ 取消今日限制」清除）';
  } else {
    statusEl.textContent = '尚未設定今日限制（每週固定營業時間生效）';
  }
}

async function cancelTodayCutoff(mode) {
  const m = mode === 'delivery' ? 'delivery' : 'takeout';
  // 清空輸入框
  const inputEl = document.getElementById('set-' + m + '_today_cutoff_time');
  if (inputEl) inputEl.value = '';
  // 儲存清空值
  try {
    await apiFetch('/api/settings', {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        [m + '_today_cutoff_time']: '',
        [m + '_today_cutoff_date']: '',
      })
    });
    showToast('✅ 今日' + (m==='takeout'?'外帶':'外送') + '限制已取消，恢復固定營業時間', 'success');
    // 重新整理顯示
    if (typeof loadLineBizStatus === 'function') loadLineBizStatus();
  } catch(e) {
    showToast('取消失敗：' + e.message, 'error');
  }
}

async function saveTakeoutDeliveryRule(mode) {
  const m = mode === 'delivery' ? 'delivery' : 'takeout';
  const hours = {};
  DAY_KEYS.forEach(d => {
    const en    = document.getElementById(`${m}-bh-${d}-en`);
    const open  = document.getElementById(`${m}-bh-${d}-open`);
    const close = document.getElementById(`${m}-bh-${d}-close`);
    if (en) hours[d] = { enabled: en.checked, open: open?.value||'11:00', close: close?.value||'20:00' };
  });
  const enabled    = document.getElementById(`set-${m}_enabled`)?.checked ? '1' : '0';
  const cutoff     = document.getElementById(`set-${m}_cutoff_time`)?.value || '';
  const prep       = document.getElementById(`set-${m}_prep_minutes`)?.value || (m==='takeout'?'15':'30');
  const allowNext  = document.getElementById(`set-${m}_allow_next_day`)?.checked ? '1' : '0';
  // fix18-06: 讀取今日臨時截止時間
  const todayCutoffEl = document.getElementById(`set-${m}_today_cutoff_time`);
  const todayCutoffVal = todayCutoffEl ? todayCutoffEl.value.trim() : '';
  // 今天的台灣日期
  const _twToday = (() => {
    const _n = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'}));
    return `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;
  })();

  const body = {
    [`${m}_enabled`]:              enabled,
    [`${m}_prep_minutes`]:         String(prep),
    [`${m}_allow_next_day`]:       allowNext,
    [`${m}_business_hours`]:       JSON.stringify(hours),
    // fix18-06: today cutoff — 有值時寫入今天日期，無值時清空
    [`${m}_today_cutoff_time`]:    todayCutoffVal,
    [`${m}_today_cutoff_date`]:    todayCutoffVal ? _twToday : '',
  };
  // 同步舊版 pickup_enabled / delivery_enabled
  if (m === 'takeout')   body.pickup_enabled   = enabled;
  if (m === 'delivery')  body.delivery_enabled = enabled;
  try {
    await apiFetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body) });
    showToast(`✅ ${m==='takeout'?'外帶':'外送'}設定已儲存`, 'success');
    loadLineBizStatus();
  } catch(e) { showToast('儲存失敗', 'error'); }
}

async function saveModeHoursFromGrid(mode) {
  await saveTakeoutDeliveryRule(mode);
}

// ── LINE 商品設定 Modal：份數 UI ──────────────────────────
// BUG-001 FIX: 醒目開關取代 checkbox
function setQuotaEnabled(enabled) {
  const hiddenInput = document.getElementById('lineQuotaEnabled');
  if (hiddenInput) hiddenInput.value = enabled ? '1' : '0';
  const btnOn  = document.getElementById('btnQuotaEnable');
  const btnOff = document.getElementById('btnQuotaDisable');
  if (btnOn) {
    if (enabled) {
      btnOn.style.background  = '#06C755'; btnOn.style.color = '#fff'; btnOn.style.borderColor = '#06C755';
    } else {
      btnOn.style.background  = '#f5f5f5'; btnOn.style.color = '#888'; btnOn.style.borderColor = '#ddd';
    }
  }
  if (btnOff) {
    if (!enabled) {
      btnOff.style.background  = '#374151'; btnOff.style.color = '#f9fafb'; btnOff.style.borderColor = '#6b7280';
    } else {
      btnOff.style.background  = '#f5f5f5'; btnOff.style.color = '#888'; btnOff.style.borderColor = '#ddd';
    }
  }
  const fields = document.getElementById('lineQuotaFields');
  if (fields) fields.style.display = enabled ? 'block' : 'none';
}

// 相容舊呼叫
function toggleLineQuotaFields() {
  const v = document.getElementById('lineQuotaEnabled')?.value;
  setQuotaEnabled(v === '1');
}

function updateLineQuotaStatusBar(daily, sold, low, high) {
  const bar = document.getElementById('lineQuotaStatusBar');
  if (!bar) return;
  const remaining = Math.max(0, daily - sold);
  const dEl = document.getElementById('qs-daily');
  const sEl = document.getElementById('qs-sold');
  const rEl = document.getElementById('qs-remaining');
  if (dEl) dEl.textContent = daily;
  if (sEl) sEl.textContent = sold;
  if (rEl) { rEl.textContent = remaining; rEl.style.color = remaining <= 0 ? '#ff6b6b' : remaining <= low ? '#fbbf24' : '#4ade80'; }
  const badge = document.getElementById('qs-status-badge');
  if (badge) {
    if (remaining <= 0)        badge.innerHTML = '<span style="background:#7f1d1d;color:#fca5a5;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:700">今日售完</span>';
    else if (remaining <= low) badge.innerHTML = '<span style="background:#7c2d12;color:#fdba74;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:700">即將售完</span>';
    else if (remaining >= high)badge.innerHTML = '<span style="background:#14532d;color:#86efac;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:700">供應充足</span>';
    else                        badge.innerHTML = '<span style="background:#1e3a5f;color:#93c5fd;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:700">販售中</span>';
  }
  bar.style.display = 'block';
}

async function resetLineQuotaSold() {
  const id = document.getElementById('lineSettingsProductId')?.value;
  if (!id) return;
  if (!confirm('確定要重置此商品今日 LINE 已售份數為 0？')) return;
  try {
    const res = await apiFetch(`/api/products/${id}/line-settings`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ line_quota_sold: 0 })
    });
    const json = await res.json();
    if (json.success) {
      document.getElementById('lineQuotaSold').value = 0;
      const daily = Number(document.getElementById('lineQuotaDaily')?.value || 0);
      const low   = Number(document.getElementById('lineQuotaLowThreshold')?.value || 2);
      const high  = Number(document.getElementById('lineQuotaHighThreshold')?.value || 10);
      updateLineQuotaStatusBar(daily, 0, low, high);
      showToast('✅ LINE 已售份數已重置', 'success');
    }
  } catch { showToast('重置失敗', 'error'); }
}


// ═══════════════════════════════════════════════════════════
// LINE 預購管理 (FEATURE-001)
// ═══════════════════════════════════════════════════════════

let _lpAllOrders = [];  // 全部預購訂單快取
let _lpFilter = 'all';  // today | tomorrow | week | all | custom

// ── 日期工具 ──────────────────────────────────────────────
function twTodayStr() {
  const d = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Taipei'}));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function twDateAdd(base, n) {
  const d = new Date(base + 'T00:00:00+08:00'); d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── 篩選條件切換 ──────────────────────────────────────────
function lpSetFilter(type) {
  _lpFilter = type;
  document.querySelectorAll('[id^="lpf-"]').forEach(b => {
    b.style.background = ''; b.style.color = '';
  });
  const activeBtn = document.getElementById('lpf-' + type);
  if (activeBtn) { activeBtn.style.background = 'var(--accent,#3b82f6)'; activeBtn.style.color = '#fff'; }
  loadLinePreorders();
}

// ── 載入預購訂單 ──────────────────────────────────────────
async function loadLinePreorders() {
  const tbody = document.getElementById('lp-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:30px;color:var(--text-muted,#64748b)">載入中…</td></tr>';

  const today = twTodayStr();
  let dateFrom, dateTo;
  if (_lpFilter === 'today') {
    dateFrom = dateTo = today;
  } else if (_lpFilter === 'tomorrow') {
    dateFrom = dateTo = twDateAdd(today, 1);
  } else if (_lpFilter === 'week') {
    dateFrom = today; dateTo = twDateAdd(today, 7);
  } else if (_lpFilter === 'custom') {
    dateFrom = document.getElementById('lp-date-from')?.value || today;
    dateTo   = document.getElementById('lp-date-to')?.value   || today;
  } else {
    // all: 今天起往後 30 天，加上今天以前 7 天（含今日預購）
    dateFrom = twDateAdd(today, -7);
    dateTo   = twDateAdd(today, 30);
  }

  try {
    // 用 LINE 訂單 API，依建立日期抓取
    const res  = await apiFetch(`/api/orders?date_from=${dateFrom}&date_to=${dateTo}&source=line`);
    const json = await res.json();
    let orders = (json.success ? json.data : []).filter(o => o.source === 'line');

    // 判斷是否為預購單：pickup_time 包含日期（格式 YYYY-MM-DD HH:MM）或日期 > 建立日期
    orders = orders.map(o => {
      const pt = o.pickup_time || '';
      let preorderDate = null, preorderTime = pt;
      if (/^\d{4}-\d{2}-\d{2}\s/.test(pt)) {
        // 新格式：YYYY-MM-DD HH:MM
        preorderDate = pt.slice(0, 10);
        preorderTime = pt.slice(11);
      } else if (o.created_at) {
        // 舊格式：只有時間，用建立日期
        preorderDate = o.created_at.slice(0, 10);
      }
      const isPreorder = preorderDate && preorderDate > (o.created_at || '').slice(0, 10);
      return { ...o, preorderDate, preorderTime, isPreorder };
    });

    _lpAllOrders = orders;
    renderLinePreordersTable();
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:#ef4444">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

// ── 渲染預購表格 ──────────────────────────────────────────
function renderLinePreordersTable() {
  const tbody = document.getElementById('lp-tbody');
  if (!tbody) return;

  const modeFilter   = document.getElementById('lp-filter-mode')?.value   || '';
  const statusFilter = document.getElementById('lp-filter-status')?.value || '';

  let orders = _lpAllOrders;
  if (modeFilter)   orders = orders.filter(o => o.order_mode === modeFilter);
  if (statusFilter) orders = orders.filter(o => (o.order_status || o.status) === statusFilter);

  // fix18-03：排除取消 / 作廢 / 失效狀態再計算統計
  const INVALID_STATUSES = new Set([
    'cancelled', 'canceled', 'void', 'voided',
    'invalid', 'expired', 'failed', 'payment_failed'
  ]);
  const validOrders = orders.filter(o => !INVALID_STATUSES.has(o.order_status || o.status || ''));
  const pending = validOrders.filter(o => ['pending','pending_accept','accepted'].includes(o.order_status || o.status)).length;
  const revenue = validOrders.reduce((s, o) => s + Number(o.total||0), 0);
  const setStat = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setStat('lp-stat-total',   validOrders.length);
  setStat('lp-stat-pending', pending);
  setStat('lp-stat-revenue', 'NT$' + revenue.toLocaleString());
  const badge = document.getElementById('lp-count-badge');
  if (badge) badge.textContent = `共 ${orders.length} 筆`;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">此條件下無預購訂單</td></tr>';
    return;
  }

  const STATUS_CLS   = {pending:'status-new',accepted:'status-preparing',preparing:'status-preparing',ready:'status-ready',completed:'status-completed',cancelled:'status-void'};
  const STATUS_LABEL = {pending:'待接單',accepted:'已接單',preparing:'製作中',ready:'可取餐',completed:'已完成',cancelled:'已取消'};
  const MODE_LABEL   = {takeout:'🛍️ 外帶', delivery:'🛵 外送', dine_in:'🍽️ 內用'};
  const PAY_LABEL    = {cash:'現金',linepay:'LINE Pay',transfer:'轉帳',platform:'平台',credit_card:'信用卡'};
  const tdS = 'padding:8px 8px;border-bottom:1px solid var(--border,#334155);vertical-align:middle';

  // 依預購日期排序
  orders = [...orders].sort((a, b) => {
    const da = (a.preorderDate || a.created_at || '').slice(0, 10);
    const db2 = (b.preorderDate || b.created_at || '').slice(0, 10);
    return da < db2 ? -1 : da > db2 ? 1 : (a.preorderTime||'') < (b.preorderTime||'') ? -1 : 1;
  });

  tbody.innerHTML = orders.map(o => {
    const st = o.order_status || o.status || 'pending';
    const stCls   = STATUS_CLS[st]   || 'status-completed';
    const stLabel = STATUS_LABEL[st] || st;
    const items   = (typeof o.items==='string') ? JSON.parse(o.items||'[]') : (o.items||[]);
    const itemStr = items.map(i => `${i.name}×${i.qty}`).join('、');
    const phone   = String(o.customer_phone||'');
    const phoneMasked = phone.length > 4 ? phone.slice(0,3)+'****'+phone.slice(-3) : phone;
    const today = twTodayStr();
    const isToday = o.preorderDate === today;
    const preorderBadge = isToday
      ? '<span style="background:#3b82f6;color:#fff;font-size:10px;padding:2px 6px;border-radius:8px;font-weight:700">今日單</span>'
      : '<span style="background:#7c3aed;color:#fff;font-size:10px;padding:2px 6px;border-radius:8px;font-weight:700">預購單</span>';
    const dateDisplay = o.preorderDate
      ? `${o.preorderDate.slice(5)} ${o.preorderTime||''}`
      : (o.pickup_time||'—');

    return `<tr style="background:var(--bg-card,#1e293b)">
      <td style="${tdS}">
        <div style="font-size:12px;font-weight:600;color:var(--text-primary,#f1f5f9)">${escHtml(o.order_number)}</div>
        <div style="margin-top:3px">${preorderBadge}</div>
        <div style="font-size:10px;color:var(--text-muted,#64748b);margin-top:2px">建立：${(o.created_at||'').slice(5,16)}</div>
      </td>
      <td style="${tdS};text-align:center">
        <div style="font-size:13px;font-weight:700;color:${isToday?'#3b82f6':'#a78bfa'}">${dateDisplay}</div>
      </td>
      <td style="${tdS}">${escHtml(o.customer_name||'—')}</td>
      <td style="${tdS};text-align:center;font-size:12px">${escHtml(phoneMasked)}</td>
      <td style="${tdS};text-align:center">${MODE_LABEL[o.order_mode]||o.order_mode||'—'}</td>
      <td style="${tdS};max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(itemStr)}">${escHtml(itemStr||'—')}</td>
      <td style="${tdS};text-align:center;font-weight:700;color:#f5a623">$${o.total||0}</td>
      <td style="${tdS};text-align:center;font-size:11px">${PAY_LABEL[o.payment_method]||o.payment_method||'—'}</td>
      <td style="${tdS};font-size:11px;color:var(--text-muted,#64748b)">${escHtml(o.note||'')}</td>
      <td style="${tdS};text-align:center">
        <span class="order-status ${stCls}" style="font-size:11px">${stLabel}</span>
      </td>
      <td style="${tdS};text-align:center">
        <div style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
          <button style="padding:4px 8px;font-size:11px;background:var(--bg-base,#0f172a);border:1px solid var(--border,#334155);border-radius:5px;color:var(--text-secondary,#94a3b8);cursor:pointer" onclick="showOrderDetail('${o.id}')">📋 詳情</button>
          ${st==='pending'?`<button style="padding:4px 8px;font-size:11px;background:#06C755;border:none;border-radius:5px;color:#fff;cursor:pointer" onclick="lpUpdateStatus('${o.id||o.uuid}','${o.order_number}','accepted')">✅ 接單</button>`:''}
          ${['pending','accepted','preparing'].includes(st)?`<button style="padding:4px 8px;font-size:11px;background:#e53935;border:none;border-radius:5px;color:#fff;cursor:pointer" onclick="lpUpdateStatus('${o.id||o.uuid}','${o.order_number}','cancelled')">❌ 取消</button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── 快速更新預購訂單狀態 ──────────────────────────────────
async function lpUpdateStatus(id, orderNo, newStatus) {
  const label = {accepted:'接受',cancelled:'取消'}[newStatus]||newStatus;
  if (!confirm(`確定要${label}訂單 ${orderNo} 嗎？`)) return;
  try {
    const res  = await apiFetch(`/api/line-orders/online/${encodeURIComponent(orderNo)}/status`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: newStatus })
    });
    const json = await res.json();
    if (json.success) {
      showToast(`✅ 訂單狀態已更新為：${newStatus}`, 'success');
      loadLinePreorders();
    } else {
      showToast(json.message || '更新失敗', 'error');
    }
  } catch(e) { showToast('網路錯誤', 'error'); }
}

// ═══════════════════════════════════════════════════════════
// LINE 商品管理總表 (v1)
// ═══════════════════════════════════════════════════════════

let _lpmProducts = [];    // 全部商品快取
let _lpmEditing  = {};    // 正在編輯的列 { [id]: {daily,sold,low,high,start,end} }

// ── 顯示/隱藏 LINE 商品管理入口 ──────────────────────────
function initLineProductsNav() {
  const hasLine = hasFeature && hasFeature('line_order');
  const navBtn     = document.getElementById('nav-btn-line_products');
  const preNavBtn  = document.getElementById('nav-btn-line_preorders');
  const toolBtn    = document.getElementById('btnLineProductsMgr');
  if (navBtn)     navBtn.style.display     = hasLine ? '' : 'none';
  if (preNavBtn)  preNavBtn.style.display  = hasLine ? '' : 'none';
  if (toolBtn)    toolBtn.style.display    = hasLine ? '' : 'none';
}

// ── 載入 LINE 商品管理頁 ──────────────────────────────────
async function loadLineProductsPage() {
  const tbody = document.getElementById('lpm-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">載入中…</td></tr>';
  _lpmEditing = {};
  try {
    const res  = await apiFetch('/api/products/line-products/list');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '載入失敗');
    _lpmProducts = json.data || [];
    renderLpmTable(_lpmProducts);
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:40px;color:#ef4444">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

// ── Tab 切換：今日販售 / 預購管理 ──────────────────────────
let _lpmTab = 'today'; // 'today' | 'preorder'
function lpmSwitchTab(tab) {
  _lpmTab = tab;
  const todayBtn       = document.getElementById('lpm-tab-today');
  const preorderBtn    = document.getElementById('lpm-tab-preorder');
  const todayControls  = document.getElementById('lpm-today-controls');
  const preorderCtrls  = document.getElementById('lpm-preorder-controls');

  const activeStyle = 'color:var(--accent,#3b82f6);border-bottom-color:var(--accent,#3b82f6)';
  const inactiveStyle = 'color:var(--text-muted,#64748b);border-bottom-color:transparent';

  if (todayBtn)    { todayBtn.style.color    = tab==='today'    ? 'var(--accent,#3b82f6)' : 'var(--text-muted,#64748b)'; todayBtn.style.borderBottomColor    = tab==='today'    ? 'var(--accent,#3b82f6)' : 'transparent'; }
  if (preorderBtn) { preorderBtn.style.color = tab==='preorder' ? '#a78bfa'                : 'var(--text-muted,#64748b)'; preorderBtn.style.borderBottomColor = tab==='preorder' ? '#7c3aed' : 'transparent'; }

  if (todayControls)  todayControls.style.display  = tab==='today'    ? 'block' : 'none';
  if (preorderCtrls)  preorderCtrls.style.display  = tab==='preorder' ? 'block' : 'none';

  renderLpmTable(_lpmProducts);
}

// ── LINE 商品狀態計算 ──────────────────────────────────────
function calcLpmStatus(p) {
  if (!p.show_on_line) return { label:'未上架', cls:'#94a3b8', bg:'rgba(148,163,184,.12)' };
  // 商品販售時段判斷
  const now = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei'}));
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  if (_lpmTab === 'preorder') {
    // 預購管理 Tab：用 line_preorder_*
    if (!Number(p.line_preorder_enabled)) return { label:'未啟用預購管理', cls:'#94a3b8', bg:'rgba(148,163,184,.12)' };
    const remaining = Math.max(0, Number(p.line_preorder_daily||0) - Number(p.line_preorder_sold||0));
    const low  = Number(p.line_preorder_low_threshold  || 2);
    const high = Number(p.line_preorder_high_threshold || 10);
    if (remaining <= 0)    return { label:'預購已滿', cls:'#ef4444', bg:'rgba(239,68,68,.12)' };
    if (remaining <= low)  return { label:'預購快滿', cls:'#ff6d00', bg:'rgba(255,109,0,.12)' };
    if (remaining >= high) return { label:'可預購', cls:'#06C755', bg:'rgba(6,199,85,.12)' };
    return { label:`可預購(剩${remaining})`, cls:'#3b82f6', bg:'rgba(59,130,246,.12)' };
  }

  // 今日販售 Tab：原本邏輯
  if (p.line_sell_end   && hhmm >= p.line_sell_end)   return { label:'今日售完', cls:'#ef4444', bg:'rgba(239,68,68,.12)' };
  if (p.line_sell_start && hhmm <  p.line_sell_start) return { label:'尚未開賣', cls:'#ff6d00', bg:'rgba(255,109,0,.12)' };
  if (!Number(p.line_quota_enabled)) return { label:'販售中（未限額）', cls:'#06C755', bg:'rgba(6,199,85,.12)' };
  const remaining = Number(p.line_quota_remaining ?? Math.max(0, p.line_quota_daily - p.line_quota_sold));
  const low  = Number(p.line_quota_low_threshold  || 2);
  const high = Number(p.line_quota_high_threshold || 10);
  if (remaining <= 0)    return { label:'今日售完', cls:'#ef4444', bg:'rgba(239,68,68,.12)' };
  if (remaining <= low)  return { label:'即將售完', cls:'#ff6d00', bg:'rgba(255,109,0,.12)' };
  if (remaining >= high) return { label:'供應充足', cls:'#06C755', bg:'rgba(6,199,85,.12)' };
  return { label:'販售中', cls:'#3b82f6', bg:'rgba(59,130,246,.12)' };
}

// ── 渲染總表 ──────────────────────────────────────────────
function renderLpmTable(products) {
  const tbody = document.getElementById('lpm-tbody');
  if (!tbody) return;
  document.getElementById('lpm-check-all').checked = false;
  document.getElementById('lpm-selected-count').textContent = '（未選取商品）';
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">尚無商品</td></tr>';
    return;
  }
  tbody.innerHTML = products.map(p => {
    // Tab 切換：今日販售 vs 預購管理
    const isPreorderTab = _lpmTab === 'preorder';
    const qEnabled  = isPreorderTab ? (Number(p.line_preorder_enabled) || 0) : (Number(p.line_quota_enabled) || 0);
    const daily     = isPreorderTab ? (Number(p.line_preorder_daily)   || 0) : (Number(p.line_quota_daily)   || 0);
    const sold      = isPreorderTab ? (Number(p.line_preorder_sold)    || 0) : (Number(p.line_quota_sold)    || 0);
    const remaining = qEnabled ? Math.max(0, daily - sold) : '—';
    const low       = isPreorderTab
      ? Number(p.line_preorder_low_threshold  || 2)
      : Number(p.line_quota_low_threshold     || 2);
    const high      = isPreorderTab
      ? Number(p.line_preorder_high_threshold || 10)
      : Number(p.line_quota_high_threshold    || 10);
    const start     = p.line_sell_start || '';
    const end       = p.line_sell_end   || '';
    const imgSrc    = p.image || '';
    const thumbHtml = imgSrc
      ? `<img src="${escAttr(imgSrc)}" style="width:38px;height:38px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'">`
      : `<div style="width:38px;height:38px;border-radius:6px;background:var(--bg-base,#0f172a);display:flex;align-items:center;justify-content:center;font-size:18px">🍽️</div>`;
    const st = calcLpmStatus(p);
    const rowCls = 'background:var(--bg-card,#1e293b)';
    // 是否正在編輯
    const ed = _lpmEditing[p.id];
    const tdStyle = 'padding:8px 6px;border-bottom:1px solid var(--border,#334155);vertical-align:middle;text-align:center';
    return `<tr id="lpm-row-${p.id}" style="${rowCls}">
      <td style="${tdStyle}"><input type="checkbox" class="lpm-chk" data-id="${p.id}" onchange="lpmUpdateCount()"></td>
      <td style="${tdStyle}">${thumbHtml}</td>
      <td style="${tdStyle};text-align:left;padding-left:10px">
        <div style="font-weight:600;font-size:13px">${escHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--text-muted,#64748b)">${escHtml(p.category||'')}</div>
      </td>
      <td style="${tdStyle}">
        <label style="display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer">
          <input type="checkbox" ${p.show_on_line?'checked':''} onchange="lpmToggleOnline(${p.id},this.checked)">
        </label>
      </td>
      <td style="${tdStyle}">
        <label style="display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer" title="啟用後前台依份數顯示狀態">
          <input type="checkbox" ${qEnabled?'checked':''} onchange="lpmToggleQuota(${p.id},this.checked)">
          <span style="font-size:10px;color:${qEnabled?'#06C755':'#94a3b8'}">${qEnabled?'✅':'⬜'}</span>
        </label>
      </td>
      <td style="${tdStyle}">
        ${ed
          ? `<div><input type="number" id="lpm-ed-daily-${p.id}" value="${daily}" min="0" style="width:64px;padding:4px 6px;border:1px solid var(--border,#334155);border-radius:4px;font-size:13px;background:var(--bg-base,#0f172a);color:var(--text-primary,#f1f5f9);text-align:center"><div style="font-size:10px;margin-top:4px"><label style="display:flex;align-items:center;gap:2px;cursor:pointer"><input type="checkbox" id="lpm-ed-qen-${p.id}" ${qEnabled?'checked':''} style="width:12px;height:12px"><span style="font-size:10px;color:var(--text-muted,#64748b)">限額</span></label></div></div>`
          : `<div style="font-weight:600">${qEnabled?daily:'—'}</div><div style="font-size:10px;margin-top:2px;color:${qEnabled?'#06C755':'#94a3b8'}">${qEnabled?'✅ 限額':'⬜ 未限額'}</div>`}
      </td>
      <td style="${tdStyle}">
        <span style="color:#ef4444;font-weight:600">${qEnabled?sold:'—'}</span>
      </td>
      <td style="${tdStyle}">
        <span style="color:${qEnabled&&typeof remaining==='number'&&remaining<=0?'#ef4444':'inherit'};font-weight:600">${qEnabled?remaining:'—'}</span>
      </td>
      <td style="${tdStyle}">
        ${ed ? `<input type="number" id="lpm-ed-low-${p.id}" value="${low}" min="0" style="width:56px;padding:4px 6px;border:1px solid var(--border,#334155);border-radius:4px;font-size:13px;background:var(--bg-base,#0f172a);color:var(--text-primary,#f1f5f9);text-align:center">` : `<span>${low}</span>`}
      </td>
      <td style="${tdStyle}">
        ${ed ? `<input type="number" id="lpm-ed-high-${p.id}" value="${high}" min="0" style="width:56px;padding:4px 6px;border:1px solid var(--border,#334155);border-radius:4px;font-size:13px;background:var(--bg-base,#0f172a);color:var(--text-primary,#f1f5f9);text-align:center">` : `<span>${high}</span>`}
      </td>
      <td style="${tdStyle}">
        ${ed ? `<input type="time" id="lpm-ed-start-${p.id}" value="${start}" style="width:88px;padding:4px 6px;border:1px solid var(--border,#334155);border-radius:4px;font-size:12px;background:var(--bg-base,#0f172a);color:var(--text-primary,#f1f5f9)">` : `<span style="font-size:12px">${start||'不限'}</span>`}
      </td>
      <td style="${tdStyle}">
        ${ed ? `<input type="time" id="lpm-ed-end-${p.id}" value="${end}" style="width:88px;padding:4px 6px;border:1px solid var(--border,#334155);border-radius:4px;font-size:12px;background:var(--bg-base,#0f172a);color:var(--text-primary,#f1f5f9)">` : `<span style="font-size:12px">${end||'不限'}</span>`}
      </td>
      <td style="${tdStyle}">
        <span style="display:inline-block;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:700;color:${st.cls};background:${st.bg}">${st.label}</span>
      </td>
      <td style="${tdStyle}">
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">
          ${ed
            ? `<button onclick="lpmSaveRow(${p.id})" style="padding:4px 8px;background:#06C755;color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer">💾儲存</button>
               <button onclick="lpmCancelRow(${p.id})" style="padding:4px 8px;background:var(--bg-base,#0f172a);color:var(--text-secondary,#94a3b8);border:1px solid var(--border,#334155);border-radius:5px;font-size:12px;cursor:pointer">取消</button>`
            : `<button onclick="lpmEditRow(${p.id})" style="padding:4px 8px;background:var(--bg-base,#0f172a);color:var(--text-secondary,#94a3b8);border:1px solid var(--border,#334155);border-radius:5px;font-size:12px;cursor:pointer">✏️編輯</button>`
          }
          <button onclick="lpmResetSold(${p.id})" style="padding:4px 8px;background:var(--bg-base,#0f172a);color:#ff6d00;border:1px solid #ff6d00;border-radius:5px;font-size:12px;cursor:pointer" title="重置已售份數">⟳重置</button>
          <button onclick="openLineSettingsModal(${p.id})" style="padding:4px 8px;background:#06C755;color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer">⚙️LINE設定</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── 全選 / 取消全選 ──────────────────────────────────────
function lpmToggleAll(checked) {
  document.querySelectorAll('.lpm-chk').forEach(cb => { cb.checked = checked; });
  lpmUpdateCount();
}
function lpmSelectAll()   { document.getElementById('lpm-check-all').checked = true;  lpmToggleAll(true);  }
function lpmDeselectAll() { document.getElementById('lpm-check-all').checked = false; lpmToggleAll(false); }

function lpmUpdateCount() {
  const sel = document.querySelectorAll('.lpm-chk:checked').length;
  const el  = document.getElementById('lpm-selected-count');
  if (el) el.textContent = sel ? `（已選取 ${sel} 個商品）` : '（未選取商品）';
}

function lpmGetSelected() {
  return Array.from(document.querySelectorAll('.lpm-chk:checked')).map(cb => Number(cb.dataset.id));
}

// ── 行內編輯 ──────────────────────────────────────────────
function lpmEditRow(id) {
  const p = _lpmProducts.find(x => x.id === id);
  if (!p) return;
  _lpmEditing[id] = true;
  renderLpmTable(_lpmProducts);
  // 捲動到目標行
  const row = document.getElementById(`lpm-row-${id}`);
  if (row) row.scrollIntoView({ behavior:'smooth', block:'center' });
}

function lpmCancelRow(id) {
  delete _lpmEditing[id];
  renderLpmTable(_lpmProducts);
}

async function lpmSaveRow(id) {
  const daily  = Number(document.getElementById(`lpm-ed-daily-${id}`)?.value  || 0);
  const low    = Number(document.getElementById(`lpm-ed-low-${id}`)?.value    || 0);
  const high   = Number(document.getElementById(`lpm-ed-high-${id}`)?.value   || 0);
  const start  = document.getElementById(`lpm-ed-start-${id}`)?.value || '';
  const end    = document.getElementById(`lpm-ed-end-${id}`)?.value   || '';
  // 讀取「限額管理」勾選框；若份數 > 0 則強制啟用
  const qEnCb  = document.getElementById(`lpm-ed-qen-${id}`);
  const qEnabled = daily > 0 ? 1 : (qEnCb?.checked ? 1 : 0);
  const isPreorderTab = _lpmTab === 'preorder';
  try {
    const saveBody = isPreorderTab ? {
      line_preorder_enabled:        qEnabled,
      line_preorder_daily:          daily,
      line_preorder_low_threshold:  low,
      line_preorder_high_threshold: high,
    } : {
      line_quota_enabled:        qEnabled,
      line_quota_daily:          daily,
      line_quota_low_threshold:  low,
      line_quota_high_threshold: high,
      line_sell_start:           start,
      line_sell_end:             end,
    };
    const res  = await apiFetch(`/api/products/${id}/line-settings`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(saveBody)
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '儲存失敗');
    // 更新本地快取
    const idx = _lpmProducts.findIndex(x => x.id === id);
    if (idx !== -1) {
      _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
    }
    delete _lpmEditing[id];
    renderLpmTable(_lpmProducts);
    showToast(`✅ ${json.data?.name || '商品'} LINE 設定已儲存`, 'success');
  } catch(e) { showToast(e.message || '儲存失敗', 'error'); }
}

// ── 上架/下架切換 ─────────────────────────────────────────
async function lpmToggleOnline(id, checked) {
  try {
    const res  = await apiFetch(`/api/products/${id}/line-settings`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ show_on_line: checked ? 1 : 0 })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    const idx = _lpmProducts.findIndex(x => x.id === id);
    if (idx !== -1) _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
    renderLpmTable(_lpmProducts);
    showToast(checked ? '✅ 已開啟 LINE 上架' : '❌ 已關閉 LINE 上架', 'success');
  } catch(e) { showToast(e.message || '操作失敗', 'error'); }
}

// ── 份數管理開關（直接從表格 checkbox 切換）──────────────
async function lpmToggleQuota(id, checked) {
  try {
    const res  = await apiFetch(`/api/products/${id}/line-settings`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ line_quota_enabled: checked ? 1 : 0 })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    const idx = _lpmProducts.findIndex(x => x.id === id);
    if (idx !== -1) _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
    renderLpmTable(_lpmProducts);
    showToast(checked ? '📦 份數管理已啟用' : '⬜ 份數管理已停用', 'success');
  } catch(e) { showToast(e.message || '操作失敗', 'error'); }
}

// ── 重置單商品已售 ────────────────────────────────────────
async function lpmResetSold(id) {
  const p = _lpmProducts.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`確定要重置「${p.name}」的 LINE 已售份數為 0 嗎？此操作不影響主庫存。`)) return;
  try {
    const res  = await apiFetch(`/api/products/${id}/line-settings`, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ line_quota_sold: 0 })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    const idx = _lpmProducts.findIndex(x => x.id === id);
    if (idx !== -1) _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
    renderLpmTable(_lpmProducts);
    showToast(`✅ 「${p.name}」已售份數已重置`, 'success');
  } catch(e) { showToast(e.message || '重置失敗', 'error'); }
}

// ── 重置全部已售 ──────────────────────────────────────────
async function resetAllLineQuota() {
  if (!confirm('確定要重置【全部商品】的 LINE 今日已售份數為 0 嗎？此操作不影響主庫存。')) return;
  try {
    const res  = await apiFetch('/api/line-orders/quota-reset', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message);
    showToast('✅ 全部 LINE 已售份數已重置', 'success');
    loadLineProductsPage();
  } catch(e) { showToast(e.message || '重置失敗', 'error'); }
}

// ── 批量操作 ──────────────────────────────────────────────
// ── 今日販售：套用設定（主按鈕）──────────────────────────
async function lpmApplyAll() {
  const ids = lpmGetSelected();
  if (!ids.length) { showToast('請先選擇商品', 'error'); return; }

  // 讀今日販售專屬 input（id: lpm-today-*）
  const daily    = document.getElementById('lpm-today-daily')?.value?.trim();
  const low      = document.getElementById('lpm-today-low')?.value?.trim();
  const high     = document.getElementById('lpm-today-high')?.value?.trim();
  const startVal = document.getElementById('lpm-today-start')?.value || '';
  const endVal   = document.getElementById('lpm-today-end')?.value   || '';

  if (!daily && daily !== '0') { showToast('請輸入今日開放份數', 'error'); return; }

  const dailyNum = Number(daily);
  const lowNum   = low   !== '' ? Number(low)   : null;
  const highNum  = high  !== '' ? Number(high)  : null;

  if (lowNum !== null && highNum !== null && lowNum > highNum) {
    showToast('快售完門檻不可大於供應充足門檻', 'error'); return;
  }
  if (startVal && endVal && startVal >= endVal) {
    showToast('販售開始時間不可晚於販售結束時間', 'error'); return;
  }

  const confirmLines = [
    `即將套用「今日販售」LINE 商品設定：`,
    `已選商品：${ids.length} 個`,
    `今日開放份數：${dailyNum}`,
    lowNum  !== null ? `快售完門檻：${lowNum}`   : null,
    highNum !== null ? `供應充足門檻：${highNum}` : null,
    startVal || endVal ? `販售時間：${startVal||'不限'} ~ ${endVal||'不限'}` : null,
    `啟用份數管理：是`,
    `確定套用？`,
  ].filter(l => l !== null).join('\n');

  if (!confirm(confirmLines)) return;

  const body = { line_quota_enabled: 1, line_quota_daily: dailyNum };
  if (lowNum  !== null) body.line_quota_low_threshold  = lowNum;
  if (highNum !== null) body.line_quota_high_threshold = highNum;
  if (startVal !== '') body.line_sell_start = startVal;
  if (endVal   !== '') body.line_sell_end   = endVal;

  await _lpmBatchSend(ids, body, '今日販售');
}

// ── 預購數量：套用設定（主按鈕）──────────────────────────
async function lpmApplyPreorder() {
  const ids = lpmGetSelected();
  if (!ids.length) { showToast('請先選擇商品', 'error'); return; }

  // 讀預購專屬 input（id: lpm-preorder-*）—— 完全獨立於今日販售
  const daily = document.getElementById('lpm-preorder-daily')?.value?.trim();
  const low   = document.getElementById('lpm-preorder-low')?.value?.trim();
  const high  = document.getElementById('lpm-preorder-high')?.value?.trim();

  if (!daily && daily !== '0') { showToast('請輸入每日預購數量', 'error'); return; }

  const dailyNum = Number(daily);
  const lowNum   = low   !== '' ? Number(low)   : null;
  const highNum  = high  !== '' ? Number(high)  : null;

  if (lowNum !== null && highNum !== null && lowNum > highNum) {
    showToast('預購快滿門檻不可大於預購充足門檻', 'error'); return;
  }

  const confirmLines = [
    `即將套用「預購數量管理」LINE 商品設定：`,
    `已選商品：${ids.length} 個`,
    `每日預購數量：${dailyNum}`,
    lowNum  !== null ? `預購快滿門檻：${lowNum}`  : null,
    highNum !== null ? `預購充足門檻：${highNum}` : null,
    `自動啟用預購管理：是`,
    `注意：不影響今日販售份數（line_quota_daily）`,
    `確定套用？`,
  ].filter(l => l !== null).join('\n');

  if (!confirm(confirmLines)) return;

  // 只更新 line_preorder_*，完全不碰 line_quota_*
  const body = { line_preorder_enabled: 1, line_preorder_daily: dailyNum };
  if (lowNum  !== null) body.line_preorder_low_threshold  = lowNum;
  if (highNum !== null) body.line_preorder_high_threshold = highNum;

  await _lpmBatchSend(ids, body, '預購數量');
}

// ── 共用批量發送邏輯 ──────────────────────────────────────
async function _lpmBatchSend(ids, body, label) {
  let successCount = 0, failCount = 0, firstFailReason = '';
  const chunks = [];
  for (let i = 0; i < ids.length; i += 5) chunks.push(ids.slice(i, i+5));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      try {
        const res = await apiFetch(`/api/products/${id}/line-settings`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        // BUG-001 修正：apiFetch 在 401/403 時回傳純物件（無 .json()），需先判斷型態
        let json;
        if (res && typeof res.json === 'function') {
          json = await res.json();
        } else if (res && res.body) {
          json = res.body;
        } else {
          throw new Error(`HTTP error (status=${res?.status ?? 'unknown'})`);
        }
        if (json && json.success) {
          const idx = _lpmProducts.findIndex(x => x.id === id);
          if (idx !== -1) _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
          successCount++;
        } else {
          const reason = json?.message || '伺服器回傳 success:false';
          console.warn(`[lpmBatchSend] id=${id} 失敗：`, reason);
          if (!firstFailReason) firstFailReason = reason;
          failCount++;
        }
      } catch(e) {
        const reason = e?.message || String(e);
        console.error(`[lpmBatchSend] id=${id} 例外：`, reason);
        if (!firstFailReason) firstFailReason = reason;
        failCount++;
      }
    }));
  }
  renderLpmTable(_lpmProducts);
  if (!failCount) {
    showToast(`✅ 已更新 ${successCount} 個商品的 LINE ${label}設定`, 'success');
  } else if (!successCount) {
    showToast(`⚠️ 全部 ${failCount} 個失敗。原因：${firstFailReason || '未知'}`, 'error');
  } else {
    showToast(`✅ ${successCount} 個成功，⚠️ ${failCount} 個失敗（${firstFailReason}）`, 'error');
  }
}

async function lpmBatch(type) {
  const ids = lpmGetSelected();
  if (!ids.length) { showToast('請先勾選商品', 'error'); return; }

  const names = {
    daily:      '今日 LINE 開放份數',
    low:        '快售完門檻',
    high:       '供應充足門檻',
    reset_sold: 'LINE 已售份數重置為 0',
    enable:     'LINE 販售開啟',
    disable:    'LINE 販售關閉',
    sell_time:  'LINE 販售時段',
  };

  let body = {};
  let val, startVal, endVal;
  if (type === 'daily') {
    val = Number(document.getElementById('lpm-today-daily')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的開放份數（今日販售區塊）', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「今日開放份數」設定為 ${val} 嗎？`)) return;
    const alsoEnable = val > 0 && confirm(`是否同時啟用已選 ${ids.length} 個商品的 LINE 份數管理？\n確認 → 啟用份數管理\n取消 → 只改數字`);
    body = { line_quota_daily: val };
    if (alsoEnable) body.line_quota_enabled = 1;
  } else if (type === 'low') {
    val = Number(document.getElementById('lpm-today-low')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的門檻值（今日販售區塊）', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「快售完門檻」設定為 ${val} 嗎？`)) return;
    body = { line_quota_low_threshold: val, line_quota_enabled: 1 };
  } else if (type === 'high') {
    val = Number(document.getElementById('lpm-today-high')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的門檻值（今日販售區塊）', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「供應充足門檻」設定為 ${val} 嗎？`)) return;
    body = { line_quota_high_threshold: val, line_quota_enabled: 1 };
  } else if (type === 'sell_time') {
    startVal = document.getElementById('lpm-today-start')?.value || '';
    endVal   = document.getElementById('lpm-today-end')?.value   || '';
    if (!confirm(`確定要將已選 ${ids.length} 個商品的 LINE 販售時段設定為 ${startVal||'不限'}～${endVal||'不限'} 嗎？`)) return;
    body = { line_sell_start: startVal, line_sell_end: endVal };
  } else if (type === 'reset_sold') {
    if (!confirm(`確定要重置已選 ${ids.length} 個商品的 LINE 已售份數為 0 嗎？此操作不影響主庫存。`)) return;
    body = { line_quota_sold: 0 };
  } else if (type === 'enable') {
    if (!confirm(`確定要開啟已選 ${ids.length} 個商品的 LINE 販售嗎？`)) return;
    body = { show_on_line: 1 };
  } else if (type === 'disable') {
    if (!confirm(`確定要關閉已選 ${ids.length} 個商品的 LINE 販售嗎？`)) return;
    body = { show_on_line: 0 };
  } else if (type === 'quota_on') {
    if (!confirm(`確定要啟用已選 ${ids.length} 個商品的 LINE 份數管理嗎？（只更新 line_quota_enabled，不影響預購管理）`)) return;
    body = { line_quota_enabled: 1 };
  } else if (type === 'quota_off') {
    if (!confirm(`確定要停用已選 ${ids.length} 個商品的 LINE 份數管理嗎？`)) return;
    body = { line_quota_enabled: 0 };
  } else if (type === 'preorder_daily') {
    val = Number(document.getElementById('lpm-preorder-daily')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的預購份數（預購管理區塊）', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「每日預購數量」設定為 ${val} 嗎？\n（自動啟用預購管理，完全不影響今日販售份數）`)) return;
    body = { line_preorder_daily: val, line_preorder_enabled: 1 };
  } else if (type === 'preorder_low') {
    val = Number(document.getElementById('lpm-preorder-low')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的門檻值', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「預購快滿門檻」設定為 ${val} 嗎？`)) return;
    body = { line_preorder_low_threshold: val, line_preorder_enabled: 1 };
  } else if (type === 'preorder_high') {
    val = Number(document.getElementById('lpm-preorder-high')?.value);
    if (isNaN(val) || val < 0) { showToast('請輸入有效的門檻值', 'error'); return; }
    if (!confirm(`確定要將已選 ${ids.length} 個商品的「預購充足門檻」設定為 ${val} 嗎？`)) return;
    body = { line_preorder_high_threshold: val, line_preorder_enabled: 1 };
  } else if (type === 'preorder_reset') {
    if (!confirm(`確定要重置已選 ${ids.length} 個商品的 LINE 已預購數量為 0 嗎？此操作不影響主庫存。`)) return;
    body = { line_preorder_sold: 0 };
  } else if (type === 'preorder_on') {
    if (!confirm(`確定要啟用已選 ${ids.length} 個商品的 LINE 預購管理嗎？（只更新 line_preorder_enabled，不影響今日販售）`)) return;
    body = { line_preorder_enabled: 1 };
  } else if (type === 'preorder_off') {
    if (!confirm(`確定要停用已選 ${ids.length} 個商品的 LINE 預購管理嗎？`)) return;
    body = { line_preorder_enabled: 0 };
  }

  let successCount = 0, failCount = 0;
  // 批量並發執行（最多 5 個同時）
  const chunks = [];
  for (let i = 0; i < ids.length; i += 5) chunks.push(ids.slice(i, i+5));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async id => {
      try {
        const res = await apiFetch(`/api/products/${id}/line-settings`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        // BUG-001 修正：apiFetch 在 401/403 時回傳純物件（無 .json()）
        let json;
        if (res && typeof res.json === 'function') {
          json = await res.json();
        } else if (res && res.body) {
          json = res.body;
        } else {
          throw new Error(`HTTP error (status=${res?.status ?? 'unknown'})`);
        }
        if (json && json.success) {
          const idx = _lpmProducts.findIndex(x => x.id === id);
          if (idx !== -1) _lpmProducts[idx] = { ..._lpmProducts[idx], ...json.data };
          successCount++;
        } else {
          console.warn(`[lpmBatch] id=${id} 失敗：`, json?.message || 'success:false');
          failCount++;
        }
      } catch(e) {
        console.error(`[lpmBatch] id=${id} 例外：`, e?.message || e);
        failCount++;
      }
    }));
  }
  renderLpmTable(_lpmProducts);
  const msg = failCount
    ? `✅ ${successCount} 個成功，⚠️ ${failCount} 個失敗`
    : `✅ ${successCount} 個商品批量更新完成`;
  showToast(msg, failCount ? 'error' : 'success');
}

// ── 批量食材控管（開啟 / 關閉 inventory_enabled）────────────
// 供商品管理頁「全選 → 開啟食材控管 / 關閉食材控管」按鈕使用
// 只影響現場 POS / Web POS，不影響 LINE 點餐

// 取得商品管理頁已勾選的商品 id 陣列
function productsGetSelected() {
  return Array.from(document.querySelectorAll('.product-row-check:checked'))
    .map(cb => Number(cb.dataset.productId))
    .filter(Boolean);
}

// 更新選取數量顯示
function updateProductsSelectedCount() {
  const count = productsGetSelected().length;
  const el = document.getElementById('products-selected-count');
  if (el) el.textContent = count > 0 ? `（已選 ${count} 個商品）` : '（未選取商品）';
  // 同步全選 checkbox 狀態
  const all = document.querySelectorAll('.product-row-check');
  const chkAll = document.getElementById('products-check-all');
  if (chkAll && all.length > 0) chkAll.indeterminate = count > 0 && count < all.length;
  if (chkAll && all.length > 0) chkAll.checked = count === all.length;
}

function productsToggleAll(checked) {
  document.querySelectorAll('.product-row-check').forEach(cb => { cb.checked = checked; });
  updateProductsSelectedCount();
}

function productsSelectAll()   { productsToggleAll(true);  }
function productsDeselectAll() { productsToggleAll(false); }

// 批量套用食材控管細節設定（inventory_enabled=1 + allocated_grams + low_stock_alert）
async function applyInventorySettings() {
  const ids = productsGetSelected();
  if (!ids.length) { showToast('請先勾選商品', 'error'); return; }
  const gramsVal = document.getElementById('inv-allocated-grams')?.value?.trim();
  const alertVal = document.getElementById('inv-low-stock-alert')?.value?.trim();
  const grams = Number(gramsVal);
  const alertN = Number(alertVal);
  if (!gramsVal || grams <= 0) { showToast('每份分配克數必須 > 0', 'error'); return; }
  if (alertVal === '' || alertN < 0) { showToast('低庫存警戒份數必須 >= 0', 'error'); return; }
  if (!confirm(
    `即將套用食材控管設定：\n已選商品：${ids.length} 個\n每份分配克數：${grams}g\n低庫存警戒：${alertN} 份\n並啟用食材控管\n\n確定套用？`
  )) return;
  try {
    const res = await apiFetch('/api/products/batch-inventory-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, inventory_enabled: 1, allocated_grams: grams, low_stock_alert: alertN })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ 食材控管設定已套用：${data.updated} 筆更新成功`, 'success');
      loadProductsPage();
    } else {
      showToast(`❌ 套用失敗：${data.message}`, 'error');
    }
  } catch(e) {
    showToast(`❌ 套用失敗：${e.message}`, 'error');
  }
}

async function batchInventoryControl(enableFlag) {
  const ids = productsGetSelected();
  if (!ids.length) { showToast('請先勾選商品', 'error'); return; }
  const label = enableFlag ? '開啟食材控管' : '關閉食材控管';
  if (!confirm(`即將對 ${ids.length} 個商品「${label}」。\n此操作只影響現場 POS / Web POS，不影響 LINE 今日份數與預購數量。\n確定繼續？`)) return;
  try {
    const res = await apiFetch('/api/products/batch-inventory-control', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, inventory_enabled: enableFlag ? 1 : 0 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${label}：${data.updated} 筆更新成功`, 'success');
      loadProductsPage();
    } else {
      showToast(`❌ ${label} 失敗：${data.message}`, 'error');
    }
  } catch(e) {
    showToast(`❌ 批量更新失敗：${e.message}`, 'error');
  }
}

// ── 初始化 LINE 商品管理（showPage 觸發）────────────────
// ── 食材庫存管理 ──────────────────────────────────────────
let _ingredients = [];
let _ingSearchQuery = '';

async function loadIngredientsPage() {
  const el = document.getElementById('ingredientsList');
  if (!el) return;
  el.innerHTML = '<div class="ing-loading"><span>載入中…</span></div>';
  try {
    const res  = await apiFetch('/api/ingredients');
    const json = await res.json();
    _ingredients = json.data || [];
    renderIngredientsList(_ingredients);
  } catch(e) { el.innerHTML = `<div class="ing-loading" style="color:var(--danger)">載入失敗：${e.message}</div>`; }
}

function filterIngredients(query) {
  _ingSearchQuery = (query||'').trim().toLowerCase();
  renderIngredientsList(_ingredients);
}

function filterIngCat(el, cat) {
  document.querySelectorAll('.ing-cat-tag').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderIngredientsList(_ingredients);
}

function getIngStatus(ing) {
  const total = Number(ing.total_stock||0);
  const threshold = Number(ing.low_stock_threshold||0);
  if (total <= 0) return 'out';
  if (threshold > 0 && total <= threshold) return 'low';
  return 'ok';
}

function renderIngredientsList(list) {
  const el = document.getElementById('ingredientsList');
  if (!el) return;
  const q = _ingSearchQuery;
  const filtered = q ? list.filter(i =>
    i.name.toLowerCase().includes(q) || i.unit.toLowerCase().includes(q)
  ) : list;

  if (!filtered.length) {
    el.innerHTML = `<div class="ing-loading" style="flex-direction:column;gap:12px">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      <span style="color:var(--text-muted)">${q ? `找不到「${q}」相關食材` : '尚無食材，請點「新增食材」'}</span>
    </div>`;
    return;
  }

  const statusLabel = { ok:'正常', low:'低庫存', out:'缺貨' };
  const statusClass = { ok:'ing-status-ok', low:'ing-status-low', out:'ing-status-out' };

  el.innerHTML = `
    <div class="ing-table-header">
      <div class="ing-th">食材名稱</div>
      <div class="ing-th">單位</div>
      <div class="ing-th">❄️ 冷凍</div>
      <div class="ing-th">🌡️ 解凍中</div>
      <div class="ing-th">🧊 冷藏可販售</div>
      <div class="ing-th">總庫存</div>
      <div class="ing-th">狀態</div>
      <div class="ing-th">操作</div>
    </div>
    ${filtered.map((i, idx) => {
      const status = getIngStatus(i);
      return `<div class="ing-row" style="animation-delay:${idx*0.03}s">
        <div class="ing-cell" data-label="食材">
          <span class="ing-name">${escHtml(i.name)}<span class="ing-unit-badge">${escHtml(i.unit)}</span></span>
        </div>
        <div class="ing-cell" data-label="單位" style="color:var(--text-muted);font-size:12px">${escHtml(i.unit)}</div>
        <div class="ing-cell ing-stock-frozen" data-label="冷凍">${Number(i.frozen_stock).toFixed(1)}</div>
        <div class="ing-cell ing-stock-thawing" data-label="解凍中">${Number(i.thawing_stock).toFixed(1)}</div>
        <div class="ing-cell ing-stock-refrigerated" data-label="冷藏可販售">${Number(i.refrigerated_stock).toFixed(1)}</div>
        <div class="ing-cell ing-stock-total" data-label="總庫存">${Number(i.total_stock).toFixed(1)}</div>
        <div class="ing-cell" data-label="狀態"><span class="ing-status ${statusClass[status]}">${statusLabel[status]}</span></div>
        <div class="ing-cell ing-actions" data-label="操作">
          <button class="ing-act-btn ing-act-purchase" onclick="openIngActionModal(${i.id},'purchase')" title="進貨入庫">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span class="act-label">進貨</span>
          </button>
          <button class="ing-act-btn ing-act-freeze" onclick="openIngActionModal(${i.id},'freeze-to-thaw')" title="轉解凍中">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span class="act-label">轉解凍</span>
          </button>
          <button class="ing-act-btn ing-act-thaw" onclick="openIngActionModal(${i.id},'thaw-complete')" title="解凍完成">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            <span class="act-label">完成解凍</span>
          </button>
          <button class="ing-act-btn ing-act-scrap" onclick="openIngActionModal(${i.id},'scrap')" title="報廢">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            <span class="act-label">報廢</span>
          </button>
          <button class="ing-act-btn ing-act-edit" onclick="openIngredientEditModal(${i.id})" title="編輯">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span class="act-label">編輯</span>
          </button>
          <button class="ing-act-btn ing-act-delete" onclick="deleteIngredient(${i.id},'${escHtml(i.name)}')" title="刪除">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span class="act-label">刪除</span>
          </button>
        </div>
      </div>`;
    }).join('')}`;
}

function openIngredientModal() {
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-modal">
    <div class="ing-modal-header">
      <div class="ing-modal-title">新增食材</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">食材名稱 *</label>
      <input type="text" class="ing-form-input" id="_ing-name" placeholder="例：豬腰、雞腿、番茄">
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">計量單位 *</label>
      <select class="ing-form-select" id="_ing-unit">
        <option value="斤">斤（台斤）</option>
        <option value="g">g（公克）</option>
        <option value="kg">kg（公斤）</option>
        <option value="個">個</option>
        <option value="份">份</option>
        <option value="盒">盒</option>
      </select>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">低庫存警戒值</label>
      <input type="number" class="ing-form-input" id="_ing-threshold" placeholder="例：3（低於此數量時顯示黃色警示）" min="0" step="0.1">
      <div class="ing-form-hint">空白表示不設警戒值</div>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">預設解凍時間（小時）</label>
      <input type="number" class="ing-form-input" id="_ing-thaw-hours" placeholder="例：8（豬腰 8 小時）" min="0" step="0.5">
      <div class="ing-form-hint">轉解凍時自動帶入完成時間，可手動修改</div>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">初始冷凍庫存</label>
      <input type="number" class="ing-form-input" id="_ing-stock" placeholder="0" min="0" step="0.1">
      <div class="ing-form-hint">建立後自動計算冷凍、總庫存</div>
    </div>
    <div class="ing-modal-footer">
      <button class="ing-modal-cancel" onclick="this.closest('.ing-modal-overlay').remove()">取消</button>
      <button class="ing-modal-submit" onclick="submitNewIngredient(this)">建立食材</button>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.addEventListener('keydown', function esc(e) { if (e.key==='Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('#_ing-name').focus();
}

async function submitNewIngredient(btn) {
  const name = document.getElementById('_ing-name')?.value.trim();
  const unit = document.getElementById('_ing-unit')?.value;
  const threshold = parseFloat(document.getElementById('_ing-threshold')?.value) || 0;
  const thawHours = parseFloat(document.getElementById('_ing-thaw-hours')?.value) || 0;
  const stock = parseFloat(document.getElementById('_ing-stock')?.value) || 0;
  if (!name) { showToast('請輸入食材名稱', 'error'); return; }
  btn.disabled = true; btn.textContent = '建立中…';
  try {
    const res = await apiFetch('/api/ingredients', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, unit, initial_stock: stock, low_stock_threshold: threshold, default_thaw_hours: thawHours }) });
    const j = await res.json();
    if (j.success) {
      showToast(`✅ 食材「${name}」已建立`, 'success');
      btn.closest('.ing-modal-overlay').remove();
      loadIngredientsPage();
    } else { showToast(j.message||'新增失敗', 'error'); btn.disabled=false; btn.textContent='建立食材'; }
  } catch(e) { showToast('網路錯誤', 'error'); btn.disabled=false; btn.textContent='建立食材'; }
}

function openIngredientEditModal(id) {
  const ing = _ingredients.find(i=>i.id===id);
  if (!ing) return;
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-modal">
    <div class="ing-modal-header">
      <div class="ing-modal-title">編輯食材</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">食材名稱 *</label>
      <input type="text" class="ing-form-input" id="_ing-edit-name" value="${escHtml(ing.name)}">
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">計量單位</label>
      <select class="ing-form-select" id="_ing-edit-unit">
        <option value="斤" ${ing.unit==='斤'?'selected':''}>斤</option>
        <option value="g" ${ing.unit==='g'?'selected':''}>g</option>
        <option value="kg" ${ing.unit==='kg'?'selected':''}>kg</option>
        <option value="個" ${ing.unit==='個'?'selected':''}>個</option>
        <option value="份" ${ing.unit==='份'?'selected':''}>份</option>
        <option value="盒" ${ing.unit==='盒'?'selected':''}>盒</option>
      </select>
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">低庫存警戒值</label>
      <input type="number" class="ing-form-input" id="_ing-edit-threshold" value="${ing.low_stock_threshold||''}" placeholder="空白表示不設警戒" min="0" step="0.1">
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">預設解凍時間（小時）</label>
      <input type="number" class="ing-form-input" id="_ing-edit-thaw-hours" value="${ing.default_thaw_hours||''}" placeholder="例：8" min="0" step="0.5">
      <div class="ing-form-hint">轉解凍時自動帶入完成時間</div>
    </div>
    <div class="ing-modal-footer">
      <button class="ing-modal-cancel" onclick="this.closest('.ing-modal-overlay').remove()">取消</button>
      <button class="ing-modal-submit" onclick="submitEditIngredient(${id},this)">儲存變更</button>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

async function submitEditIngredient(id, btn) {
  const name = document.getElementById('_ing-edit-name')?.value.trim();
  const unit = document.getElementById('_ing-edit-unit')?.value;
  const threshold = parseFloat(document.getElementById('_ing-edit-threshold')?.value) || 0;
  const thawHours = parseFloat(document.getElementById('_ing-edit-thaw-hours')?.value) || 0;
  if (!name) { showToast('請輸入食材名稱', 'error'); return; }
  btn.disabled=true; btn.textContent='儲存中…';
  try {
    const res = await apiFetch(`/api/ingredients/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, unit, low_stock_threshold: threshold, default_thaw_hours: thawHours }) });
    const j = await res.json();
    if (j.success) { showToast('✅ 已更新', 'success'); btn.closest('.ing-modal-overlay').remove(); loadIngredientsPage(); }
    else { showToast(j.message||'更新失敗', 'error'); btn.disabled=false; btn.textContent='儲存變更'; }
  } catch(e) { showToast('網路錯誤','error'); btn.disabled=false; btn.textContent='儲存變更'; }
}

async function deleteIngredient(id, name) {
  if (!confirm(`確定刪除「${name}」？此操作無法復原。`)) return;
  try {
    const res = await apiFetch(`/api/ingredients/${id}`, { method:'DELETE' });
    const j = await res.json();
    if (j.success) { showToast(`✅ 已刪除「${name}」`, 'success'); loadIngredientsPage(); }
    else showToast(j.message||'刪除失敗', 'error');
  } catch(e) { showToast('網路錯誤','error'); }
}

function openIngActionModal(id, action) {
  const ing = _ingredients.find(i=>i.id===id);
  if (!ing) return;
  const labels = { purchase:'進貨入庫', 'freeze-to-thaw':'轉解凍中', 'thaw-complete':'完成解凍→冷藏可販售', scrap:'報廢' };
  const colors = { purchase:'#60a5fa', 'freeze-to-thaw':'#a78bfa', 'thaw-complete':'#4ade80', scrap:'#f87171' };
  const infos = [
    { label:'冷凍庫存', value:`${Number(ing.frozen_stock).toFixed(1)} ${ing.unit}` },
    { label:'解凍中', value:`${Number(ing.thawing_stock).toFixed(1)} ${ing.unit}` },
    { label:'冷藏可販售', value:`${Number(ing.refrigerated_stock).toFixed(1)} ${ing.unit}` },
  ];
  let extraFields = '';
  if (action === 'freeze-to-thaw') {
    // 自動帶入預設解凍時間
    let defaultThawVal = '';
    if (ing.default_thaw_hours && Number(ing.default_thaw_hours) > 0) {
      const now = new Date();
      now.setMinutes(now.getMinutes() + Math.round(Number(ing.default_thaw_hours) * 60));
      // format to datetime-local: YYYY-MM-DDTHH:mm
      const pad = v => String(v).padStart(2,'0');
      defaultThawVal = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    extraFields = `<div class="ing-form-group">
      <label class="ing-form-label">預計解凍完成時間</label>
      <input type="datetime-local" class="ing-form-input" id="_act-thawtime" value="${defaultThawVal}">
      ${ing.default_thaw_hours > 0 ? `<div class="ing-form-hint">已依預設 ${ing.default_thaw_hours} 小時自動帶入，可手動修改</div>` : ''}
    </div>`;
  } else if (action === 'purchase') {
    extraFields = `<div class="ing-form-group">
      <label class="ing-form-label">批號（選填）</label>
      <input type="text" class="ing-form-input" id="_act-batchno" placeholder="自動產生">
    </div>`;
  } else if (action === 'scrap') {
    extraFields = `<div class="ing-form-group">
      <label class="ing-form-label">報廢來源</label>
      <select class="ing-form-select" id="_act-from">
        <option value="refrigerated">冷藏可販售</option>
        <option value="frozen">冷凍庫存</option>
        <option value="thawing">解凍中</option>
      </select>
    </div><div class="ing-form-group">
      <label class="ing-form-label">報廢原因</label>
      <input type="text" class="ing-form-input" id="_act-reason" placeholder="例：過期、損壞">
    </div>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-action-modal">
    <div class="ing-modal-header">
      <div class="ing-modal-title" style="color:${colors[action]}">${labels[action]}｜${escHtml(ing.name)}</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div class="ing-action-info">
      ${infos.map(r=>`<div class="ing-action-info-row"><span class="ing-action-info-label">${r.label}</span><span class="ing-action-info-value">${r.value}</span></div>`).join('')}
    </div>
    <div class="ing-form-group">
      <label class="ing-form-label">數量（${ing.unit}） *</label>
      <input type="number" class="ing-form-input" id="_act-amount" placeholder="0" min="0.1" step="0.1">
    </div>
    ${extraFields}
    <div class="ing-modal-footer">
      <button class="ing-modal-cancel" onclick="this.closest('.ing-modal-overlay').remove()">取消</button>
      <button class="ing-modal-submit" style="background:${colors[action]}" onclick="submitIngAction(${id},'${action}',this)">確認執行</button>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  overlay.querySelector('#_act-amount').focus();
}

async function submitIngAction(id, action, btn) {
  const amt = parseFloat(document.getElementById('_act-amount')?.value);
  if (isNaN(amt)||amt<=0) { showToast('請輸入有效數量', 'error'); return; }
  let body = { amount: amt };
  if (action === 'purchase') {
    body.batch_no = document.getElementById('_act-batchno')?.value||'';
  } else if (action === 'freeze-to-thaw') {
    body.thaw_complete_time = document.getElementById('_act-thawtime')?.value||'';
  } else if (action === 'scrap') {
    body.from = document.getElementById('_act-from')?.value||'refrigerated';
    body.reason = document.getElementById('_act-reason')?.value||'報廢';
  }
  btn.disabled=true; btn.textContent='執行中…';
  try {
    const res = await apiFetch(`/api/ingredients/${id}/${action}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json();
    const labels = { purchase:'進貨入庫', 'freeze-to-thaw':'轉解凍中', 'thaw-complete':'完成解凍', scrap:'報廢' };
    if (j.success) { showToast(`✅ ${labels[action]}完成`, 'success'); btn.closest('.ing-modal-overlay').remove(); loadIngredientsPage(); notifyInventoryChanged(); }
    else { showToast(j.message||'操作失敗', 'error'); btn.disabled=false; btn.textContent='確認執行'; }
  } catch(e) { showToast('網路錯誤','error'); btn.disabled=false; btn.textContent='確認執行'; }
}

function openBatchPurchaseModal() {
  const ingOpts = _ingredients.map(i=>`<option value="${i.id}">${escHtml(i.name)}（${i.unit}）</option>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-modal" style="max-width:520px">
    <div class="ing-modal-header">
      <div class="ing-modal-title">批次進貨</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div id="_batch-rows" style="display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow-y:auto;margin-bottom:12px">
      <div class="_batch-row" style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:2"><label class="ing-form-label">食材</label>
          <select class="ing-form-select _batch-ing">${ingOpts}</select>
        </div>
        <div style="flex:1"><label class="ing-form-label">數量</label>
          <input type="number" class="ing-form-input _batch-amt" placeholder="0" min="0.1" step="0.1">
        </div>
        <button style="background:var(--bg-hover);border:1px solid var(--border);color:var(--danger);border-radius:6px;padding:9px 10px;cursor:pointer;font-size:16px" onclick="this.closest('._batch-row').remove()">✕</button>
      </div>
    </div>
    <button onclick="addBatchRow()" style="display:flex;align-items:center;gap:6px;background:transparent;border:1px dashed var(--border);color:var(--text-muted);border-radius:8px;padding:8px 14px;cursor:pointer;width:100%;justify-content:center;font-size:13px;transition:border-color .15s"
      onmouseover="this.style.borderColor=getComputedStyle(document.documentElement).getPropertyValue('--accent')"
      onmouseout="this.style.borderColor=getComputedStyle(document.documentElement).getPropertyValue('--border')">
      ＋ 再新增一筆
    </button>
    <div class="ing-modal-footer">
      <button class="ing-modal-cancel" onclick="this.closest('.ing-modal-overlay').remove()">取消</button>
      <button class="ing-modal-submit" onclick="submitBatchPurchase(this)">批次入庫</button>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function addBatchRow() {
  const ingOpts = _ingredients.map(i=>`<option value="${i.id}">${escHtml(i.name)}（${i.unit}）</option>`).join('');
  const row = document.createElement('div');
  row.className = '_batch-row';
  row.style.cssText = 'display:flex;gap:8px;align-items:flex-end';
  row.innerHTML = `<div style="flex:2"><label class="ing-form-label">食材</label>
    <select class="ing-form-select _batch-ing">${ingOpts}</select></div>
    <div style="flex:1"><label class="ing-form-label">數量</label>
      <input type="number" class="ing-form-input _batch-amt" placeholder="0" min="0.1" step="0.1"></div>
    <button style="background:var(--bg-hover);border:1px solid var(--border);color:var(--danger);border-radius:6px;padding:9px 10px;cursor:pointer;font-size:16px" onclick="this.closest('._batch-row').remove()">✕</button>`;
  document.getElementById('_batch-rows').appendChild(row);
}

async function submitBatchPurchase(btn) {
  const rows = document.querySelectorAll('._batch-row');
  const items = [];
  let valid = true;
  rows.forEach(r => {
    const id = r.querySelector('._batch-ing')?.value;
    const amt = parseFloat(r.querySelector('._batch-amt')?.value);
    if (!id || isNaN(amt)||amt<=0) { valid=false; return; }
    items.push({ id, amount: amt });
  });
  if (!valid || !items.length) { showToast('請填寫所有欄位', 'error'); return; }
  btn.disabled=true; btn.textContent='入庫中…';
  let ok=0, fail=0;
  for (const item of items) {
    try {
      const res = await apiFetch(`/api/ingredients/${item.id}/purchase`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ amount: item.amount }) });
      const j = await res.json();
      if (j.success) ok++; else fail++;
    } catch(e) { fail++; }
  }
  if (ok>0) showToast(`✅ 批次入庫完成（${ok} 筆）${fail?`，${fail} 筆失敗`:''}`, ok>0?'success':'error');
  else showToast('批次入庫失敗', 'error');
  btn.closest('.ing-modal-overlay').remove();
  loadIngredientsPage();
}

async function openIngredientLogsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-log-modal">
    <div class="ing-log-header">
      <div class="ing-modal-title">食材異動紀錄</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div class="ing-log-body"><div class="ing-loading">載入中…</div></div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  try {
    const res  = await apiFetch('/api/ingredients/logs/all?limit=200');
    const json = await res.json();
    const rows = (json.data||[]);
    const typeMap = {
      purchase:{ label:'進貨', cls:'log-type-purchase' },
      freeze_to_thaw:{ label:'轉解凍中', cls:'log-type-freeze' },
      thaw_complete:{ label:'完成解凍', cls:'log-type-thaw' },
      sale_deduct:{ label:'銷售扣料', cls:'log-type-sale' },
      scrap:{ label:'報廢', cls:'log-type-scrap' },
      manual_adjust:{ label:'手動調整', cls:'log-type-manual' }
    };
    overlay.querySelector('.ing-log-body').innerHTML = `<table class="ing-log-table">
      <thead><tr>
        <th>時間</th><th>食材</th><th>操作類型</th>
        <th>數量</th><th>操作者</th><th>備註</th>
      </tr></thead>
      <tbody>${rows.length ? rows.map((r,i) => {
        const t = typeMap[r.log_type]||{ label:r.log_type, cls:'log-type-manual' };
        return `<tr>
          <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${twTime(r.created_at,'datetime')}</td>
          <td style="font-weight:700;color:var(--text-primary)">${escHtml(r.ingredient_name||'—')}</td>
          <td><span class="ing-log-type ${t.cls}">${t.label}</span></td>
          <td style="text-align:right;font-weight:700;color:var(--accent);font-family:var(--font-mono)">${Number(r.amount||0).toFixed(1)}</td>
          <td style="color:var(--text-muted);font-size:12px">${escHtml(r.operator||'—')}</td>
          <td style="color:var(--text-secondary);font-size:12px">${escHtml(r.reason||r.note||'')}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">尚無異動紀錄</td></tr>'}</tbody>
    </table>`;
  } catch(e) { showToast('載入失敗','error'); }
}

async function openFormulaManagerModal() {
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-formula-modal">
    <div class="ing-log-header">
      <div class="ing-modal-title">商品扣料公式</div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="ing-btn-ghost" style="font-size:12px;padding:6px 10px" onclick="openImportModal('ingredient-formulas')">📥 匯入</button>
        <button class="ing-btn-ghost" style="font-size:12px;padding:6px 10px" onclick="exportCsv('ingredient-formulas')">📤 匯出</button>
        <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove();window._formulaModal=null">✕</button>
      </div>
    </div>
    <div style="padding:0 20px;margin-top:16px"><div class="ing-formula-add">
      <div class="ing-formula-add-title">新增扣料公式</div>
      <div class="ing-formula-fields" id="_fml-fields">載入中…</div>
    </div></div>
    <div class="ing-formula-table-wrap" style="margin-top:12px">
      <table class="ing-formula-table">
        <thead><tr><th>商品</th><th>食材</th><th>每份扣除量</th><th>操作</th></tr></thead>
        <tbody id="fml-tbody"><tr><td colspan="4" style="text-align:center;padding:30px;color:var(--text-muted)">載入中…</td></tr></tbody>
      </table>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); window._formulaModal=null; } };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  window._formulaModal = overlay;

  try {
    const [ingRes, fmRes, prodRes] = await Promise.all([
      apiFetch('/api/ingredients').then(r=>r.json()),
      apiFetch('/api/ingredients/formulas/all').then(r=>r.json()),
      apiFetch('/api/products').then(r=>r.json())
    ]);
    const ings = ingRes.data || [];
    const fms  = fmRes.data  || [];
    const prods = (prodRes.data||prodRes||[]);

    const ingOpts = ings.map(i=>`<option value="${i.id}">${escHtml(i.name)}（${i.unit}）</option>`).join('');
    const prodOpts = prods.map(p=>`<option value="${p.id}">${escHtml(p.name)}</option>`).join('');

    document.getElementById('_fml-fields').innerHTML = `
      <div class="ing-formula-field">
        <label>商品</label>
        <select id="fml-pid"><option value="">選擇商品</option>${prodOpts}</select>
      </div>
      <div class="ing-formula-field">
        <label>食材</label>
        <select id="fml-ingid"><option value="">選擇食材</option>${ingOpts}</select>
      </div>
      <div class="ing-formula-field">
        <label>每份扣除量</label>
        <input type="number" id="fml-amt" placeholder="200" step="0.1" min="0.1">
      </div>
      <div class="ing-formula-field">
        <label>單位</label>
        <div style="padding:8px 12px;background:var(--bg-card);border:1px solid var(--accent);border-radius:6px;color:var(--accent);font-size:13px;font-weight:700;min-width:40px">g</div>
      </div>
      <button class="ing-btn-primary" onclick="addFormula()" style="margin-top:auto">新增</button>`;

    document.getElementById('fml-tbody').innerHTML = fms.length ? fms.map(f=>`<tr>
      <td style="font-weight:600;color:var(--text-primary)">${escHtml(f.product_name||'—')}</td>
      <td style="color:var(--text-secondary)">${escHtml(f.ingredient_name||'—')}</td>
      <td style="text-align:center;font-weight:700;color:var(--accent);font-family:var(--font-mono)">${f.amount_per_unit} g</td>
      <td style="text-align:center">
        <button onclick="deleteFormula(${f.id},this)" style="background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);color:#f87171;cursor:pointer;padding:4px 10px;border-radius:5px;font-size:12px;font-weight:600;transition:background .12s"
          onmouseover="this.style.background='rgba(248,113,113,.25)'" onmouseout="this.style.background='rgba(248,113,113,.12)'">刪除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--text-muted)">尚無公式</td></tr>';

  } catch(e) { showToast('載入失敗','error'); }
}

async function addFormula() {
  const pid = document.getElementById('fml-pid')?.value;
  const iid = document.getElementById('fml-ingid')?.value;
  const amt = document.getElementById('fml-amt')?.value;
  if (!pid||!iid||!amt) { showToast('請填寫所有欄位', 'error'); return; }
  const res  = await apiFetch('/api/ingredients/formulas/add', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ product_id:Number(pid), ingredient_id:Number(iid), amount_per_unit:Number(amt) }) });
  const json = await res.json();
  if (json.success) {
    showToast('✅ 公式已新增', 'success');
    if (window._formulaModal) { window._formulaModal.remove(); window._formulaModal=null; openFormulaManagerModal(); }
  } else showToast(json.message||'新增失敗', 'error');
}

async function deleteFormula(id, btn) {
  if (!confirm('確定刪除此扣料公式？')) return;
  const res = await apiFetch(`/api/ingredients/formulas/${id}`, { method:'DELETE' });
  const json = await res.json();
  if (json.success) { btn.closest('tr').remove(); showToast('✅ 已刪除', 'success'); }
}


// ════════════════════════════════════════════════════════
// ===== 匯入 / 匯出功能 =====
// ════════════════════════════════════════════════════════

const IMPORT_CONFIG = {
  'products':            { title:'匯入商品',     template:'products',            fields:['商品名稱','分類','售價'] },
  'product-inventory':   { title:'匯入商品庫存', template:'product-inventory',   fields:['商品名稱','每份克數','補充庫存(g)'] },
  'ingredients':         { title:'匯入食材',     template:'ingredients',          fields:['食材名稱','單位(g/斤/kg)','冷凍庫存'] },
  'ingredient-formulas': { title:'匯入扣料公式', template:'ingredient-formulas',  fields:['商品名稱','食材名稱','每份扣除量(g)'] },
};

function downloadTemplate(type) {
  window.open(`/api/template/${type}`, '_blank');
}

function exportCsv(type) {
  // ★ 不用 window.open（不帶 token）→ 改用 apiFetch 帶 token 後 blob 下載
  downloadWithAuth(`/api/export/${type}`, `${type}_export.csv`);
}

async function downloadWithAuth(url, defaultFilename) {
  try {
    const res = await apiFetch(url, { method: 'GET' });
    if (!res.ok) {
      let msg = '匯出失敗';
      try { const err = await res.json(); msg = err.message || err.error || msg; } catch {}
      showToast('❌ ' + msg, 'error');
      return;
    }
    // 從 Content-Disposition 取檔名（若有的話）
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^";]+)"?/);
    const filename = match ? match[1] : defaultFilename;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch(e) {
    showToast('❌ 匯出失敗：' + e.message, 'error');
  }
}

function parseCsvText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  function parseLine(line) {
    const result = []; let cur = '', inQ = false;
    // remove BOM
    if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1]==='"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
      else cur += c;
    }
    result.push(cur);
    return result;
  }
  let headers = parseLine(lines[0]);
  // strip BOM from first header
  if (headers[0] && headers[0].charCodeAt(0) === 0xFEFF) headers[0] = headers[0].slice(1);
  return lines.slice(1).map(l => {
    const vals = parseLine(l);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

function openImportModal(type) {
  const cfg = IMPORT_CONFIG[type];
  if (!cfg) return;
  const overlay = document.createElement('div');
  overlay.className = 'ing-modal-overlay';
  overlay.innerHTML = `<div class="ing-modal" style="max-width:600px">
    <div class="ing-modal-header">
      <div class="ing-modal-title">${cfg.title}</div>
      <button class="ing-modal-close" onclick="this.closest('.ing-modal-overlay').remove()">✕</button>
    </div>
    <div class="ing-form-group">
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <label class="ing-btn-secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;font-size:13px;font-weight:600">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          選擇 CSV 檔案
          <input type="file" accept=".csv,.txt" style="display:none" onchange="previewImportCsv(this,'${type}')">
        </label>
        <button class="ing-btn-ghost" onclick="downloadTemplate('${type}')">📋 下載範本</button>
      </div>
      <div class="ing-form-hint">支援 CSV 格式。必填欄位：${cfg.fields.join('、')}</div>
    </div>
    <div id="_import-preview-${type}" style="display:none">
      <div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">預覽（前5筆）</div>
      <div id="_import-preview-table-${type}" style="overflow-x:auto;max-height:200px;border:1px solid var(--border);border-radius:8px"></div>
      <div id="_import-count-${type}" style="font-size:12px;color:var(--text-muted);margin-top:6px"></div>
    </div>
    <div id="_import-result-${type}" style="display:none;padding:12px;border-radius:8px;font-size:13px;margin-top:10px"></div>
    <div class="ing-modal-footer">
      <button class="ing-modal-cancel" onclick="this.closest('.ing-modal-overlay').remove()">取消</button>
      <button class="ing-modal-submit" id="_import-submit-${type}" style="display:none" onclick="submitImport('${type}',this)">開始匯入</button>
    </div>
  </div>`;
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
}

let _importData = {};

function previewImportCsv(input, type) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCsvText(e.target.result);
    _importData[type] = rows;
    const preview = rows.slice(0, 5);
    const keys = Object.keys(preview[0] || {});
    const table = `<table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr>${keys.map(k=>`<th style="padding:6px 8px;background:var(--bg-card);color:var(--accent);font-size:10px;white-space:nowrap;border-bottom:1px solid var(--border)">${escHtml(k)}</th>`).join('')}</tr></thead>
      <tbody>${preview.map(r=>`<tr>${keys.map(k=>`<td style="padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.05);color:var(--text-secondary);white-space:nowrap">${escHtml(r[k]||'')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
    const previewDiv = document.getElementById(`_import-preview-${type}`);
    document.getElementById(`_import-preview-table-${type}`).innerHTML = table;
    document.getElementById(`_import-count-${type}`).textContent = `共 ${rows.length} 筆資料`;
    previewDiv.style.display = '';
    document.getElementById(`_import-submit-${type}`).style.display = '';
    document.getElementById(`_import-result-${type}`).style.display = 'none';
  };
  reader.readAsText(file, 'UTF-8');
}

async function submitImport(type, btn) {
  const rows = _importData[type];
  if (!rows || !rows.length) { showToast('請先選擇 CSV 檔案', 'error'); return; }
  btn.disabled = true; btn.textContent = '匯入中…';
  try {
    const res  = await apiFetch(`/api/import/${type}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) });
    const resultDiv = document.getElementById(`_import-result-${type}`);

    // ── v18-r1-fix1：先檢查 HTTP 狀態，處理 403 授權擋住的情況 ──
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        errMsg = errJson.message || errMsg;
      } catch {}
      resultDiv.innerHTML = `<div style="color:#f87171">❌ 匯入失敗：${escHtml(errMsg)}</div>`;
      resultDiv.style.cssText = 'display:block;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:12px;margin-top:10px';
      showToast('匯入失敗：' + errMsg, 'error');
      btn.disabled = false; btn.textContent = '開始匯入';
      return;
    }

    const json = await res.json();
    if (json.success) {
      const parts = [];
      if (json.added)   parts.push(`新增 ${json.added} 筆`);
      if (json.updated) parts.push(`更新 ${json.updated} 筆`);
      if (json.failed)  parts.push(`失敗 ${json.failed} 筆`);
      let html = `<div style="color:var(--success);font-weight:700;margin-bottom:6px">✅ 匯入完成：${parts.join('、')}</div>`;
      if (json.errors?.length) {
        html += `<div style="color:#f87171;font-size:12px;max-height:80px;overflow-y:auto">${json.errors.map(e=>`<div>⚠️ ${escHtml(e)}</div>`).join('')}</div>`;
      }
      resultDiv.innerHTML = html;
      resultDiv.style.cssText = 'display:block;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.3);border-radius:8px;padding:12px;margin-top:10px';
      // reload relevant data（只有真的寫入成功才重新載入）
      if (type === 'products' || type === 'product-inventory') { loadInventoryPage(); if (typeof loadProductsPage === 'function') loadProductsPage(); }
      if (type === 'ingredients' || type === 'ingredient-formulas') loadIngredientsPage();
      showToast('匯入完成', 'success');
    } else {
      resultDiv.innerHTML = `<div style="color:#f87171">❌ 匯入失敗：${escHtml(json.message)}</div>`;
      resultDiv.style.cssText = 'display:block;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:12px;margin-top:10px';
      showToast('匯入失敗：' + (json.message || ''), 'error');
    }
  } catch(e) { showToast('網路錯誤：' + e.message, 'error'); }
  btn.disabled = false; btn.textContent = '開始匯入';
}

// 食材操作後通知點餐頁刷新（若目前在 POS 頁）
function notifyInventoryChanged() {
  const posPage = document.getElementById('page-pos');
  if (posPage && posPage.classList.contains('active')) {
    refreshInventoryForProducts();
  }
}


// ── v18：訂單頁自動 polling（每 10 秒，確保 WSS 失效時也能同步）──────────────
(function initOrderPolling() {
  let _pollInterval = null;
  // 原本 showPage 函數的包裝，切到訂單頁時啟動 polling
  const _origShowPage = typeof showPage === 'function' ? showPage : null;
  if (_origShowPage) {
    window._orderPollingShowPage = function(name) {
      _origShowPage(name);
      if (name === 'orders') {
        if (!_pollInterval) {
          _pollInterval = setInterval(() => {
            if (typeof refreshCurrentOrderView === 'function') {
              refreshCurrentOrderView(); // fix18-07：維持目前分頁
            }
          }, 10000); // 每 10 秒
        }
      } else {
        if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
      }
    };
    // 替換全域 showPage（只在 DOMContentLoaded 後）
    document.addEventListener('DOMContentLoaded', () => {
      window.showPage = window._orderPollingShowPage;
    });
  }
})();

// ── v18 fix6：WSS Client — 帶 token 連線，確保 store_id 綁定 ──────────────
(function initWebPosWss() {
  let _wssRetry = 0;
  function connectWss() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // ★ fix6：帶 JWT token，讓 server 綁定 store_id
    // 若尚未登入（無 token），沿用預設 store_001（向後相容）
    const token = getToken();
    const url   = proto + '//' + location.host + '/orders'
      + (token ? '?token=' + encodeURIComponent(token) : '');
    let ws;
    try { ws = new WebSocket(url); } catch(e) { return; }

    ws.onopen = () => {
      _wssRetry = 0;
      console.log('[WSS] Web POS 已連線:', url);
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      // order_status_changed → 無條件刷新訂單（不管在哪個頁面都要保持資料最新）
      if (msg.type === 'order_status_changed') {
        const updatedOrder = msg.order;
        console.log('[WSS] 收到 order_status_changed:', updatedOrder?.order_number, '→', updatedOrder?.order_status);

        // v18修正：Web POS 用 page-orders class.active 控制顯示，不是 style.display
        // 無論訂單頁是否顯示，都更新資料；若在訂單頁則立即重新渲染
        if (typeof refreshCurrentOrderView === 'function') {
          refreshCurrentOrderView(); // fix18-07：維持目前分頁
        }

        // 若目前在訂單頁，更新狀態 badge（不需等 loadOrders 完成）
        const ordersPage = document.getElementById('page-orders');
        if (ordersPage?.classList.contains('active') && typeof showToast === 'function') {
          showToast('🔄 訂單狀態更新：' + (updatedOrder?.order_number || '') + ' → ' + (updatedOrder?.order_status || ''));
        }
      }

      // new_line_order → 通知 + 刷新
      if (msg.type === 'new_line_order') {
        const o = msg.order;
        if (typeof showToast === 'function') {
          showToast('🔔 LINE 新訂單：' + (o?.order_number || '') + ' / ' + (o?.customer_name || ''));
        }
        if (typeof refreshCurrentOrderView === 'function') {
          refreshCurrentOrderView(); // fix18-07：維持目前分頁
        }
      }

      // linepay_paid → LINE Pay 付款成功通知 + 刷新（fix18-02）
      if (msg.type === 'linepay_paid') {
        const orderNo = msg.order_number || '';
        const source  = msg.confirm_source || '';
        const label   = source === 'manual' ? 'LINE Pay 現場確認已收款' : 'LINE Pay 付款成功';
        if (typeof showToast === 'function') {
          showToast('💚 ' + label + (orderNo ? '：' + orderNo : ''));
        }
        // 刷新訂單列表（無論目前在哪個頁面）
        if (typeof refreshCurrentOrderView === 'function') {
          refreshCurrentOrderView(); // fix18-07：維持目前分頁
        }
        // 刷新儀表板統計
        if (typeof loadDashboard === 'function') {
          const dash = document.getElementById('page-dashboard');
          if (dash?.classList.contains('active')) loadDashboard();
        }
      }
    };

    ws.onclose = () => {
      const delay = Math.min(1000 * Math.pow(2, _wssRetry++), 30000);
      console.log('[WSS] 斷線，', delay, 'ms 後重連');
      setTimeout(connectWss, delay);
    };

    ws.onerror = () => ws.close();
  }

  // DOMContentLoaded 後連線
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connectWss);
  } else {
    connectWss();
  }
})();

// ═══════════════════════════════════════════════════════
// fix16c-hotfix: 金流 API 設定頁（8個 provider）
// ═══════════════════════════════════════════════════════

const GATEWAY_PROVIDERS = [
  { code: 'linepay',             name: 'LINE Pay',        icon: '💚' },
  { code: 'ecpay',               name: '綠界 ECPay',      icon: '🟢' },
  { code: 'newebpay',            name: '藍新 NewebPay',   icon: '🔵' },
  { code: 'jkopay',              name: '街口支付',         icon: '🟠' },
  { code: 'pxpay',               name: '全支付',           icon: '🔴' },
  { code: 'applepay',            name: 'Apple Pay',       icon: '🍎' },
  { code: 'googlepay',           name: 'Google Pay',      icon: '🎨' },
  { code: 'creditcard_terminal', name: '信用卡刷卡機',     icon: '💳' },
];

async function loadGatewayCards() {
  const container = document.getElementById('gatewayCards');
  if (!container) return;

  if (!hasFeature('payment_api')) {
    container.innerHTML =
      '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ef4444">' +
      '🔒 金流 API 功能尚未授權，請聯絡系統管理員升級方案。</div>';
    return;
  }

  container.innerHTML = '<div style="grid-column:1/-1;color:var(--text-secondary,#64748b);padding:20px">載入中...</div>';

  let gwMap = {};
  try {
    const res  = await apiFetch('/api/payment-gateways');
    if (res && res.ok) {
      const json = await res.json();
      if (json.success) {
        (json.data || []).forEach(g => { gwMap[g.code] = g; });
      }
    }
  } catch {}

  const origin = window.location.origin;
  container.innerHTML = GATEWAY_PROVIDERS.map(p => {
    const gw = gwMap[p.code] || {};
    // fix16e: gwId 已移除，只使用 provider code
    return `
    <div class="settings-card" style="border:1px solid var(--border,#2a2d3e)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span style="font-size:1.4rem">${p.icon}</span>
        <div>
          <div style="font-weight:700;font-size:.95rem">${escHtml(p.name)}</div>
          <div style="font-size:.75rem;color:var(--text-secondary,#64748b)">${p.code}</div>
        </div>
        <label class="pm-toggle" style="margin-left:auto">
          <input type="checkbox" id="gw-enabled-${p.code}" ${gw.is_active ? 'checked' : ''}>
          <span class="pm-toggle-slider"></span>
        </label>
      </div>

      <div style="display:grid;gap:10px">
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">模式</label>
          <select id="gw-mode-${p.code}" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem">
            <option value="test"  ${(gw.mode||'test')==='test'?'selected':''}>🧪 測試模式</option>
            <option value="live"  ${(gw.mode||'')==='live'?'selected':''}>🟢 正式模式</option>
          </select>
        </div>
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">Merchant ID / Channel ID</label>
          <input id="gw-mid-${p.code}" type="text" value="${escHtml(gw.merchant_id||'')}" placeholder="輸入商店代號"
            style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">API Key${gw.api_key?'（●●●●'+gw.api_key.slice(-4)+'）':''}</label>
          <input id="gw-apikey-${p.code}" type="password" value="" placeholder="留空表示不更新"
            style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">Secret Key${gw.secret_key?'（●●●●'+gw.secret_key.slice(-4)+'）':''}</label>
          <input id="gw-secret-${p.code}" type="password" value="" placeholder="留空表示不更新"
            style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">Webhook URL</label>
          <input id="gw-webhook-${p.code}" type="text"
            value="${escHtml(gw.webhook_url || origin + '/api/' + p.code + '/webhook')}"
            style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:.78rem;color:var(--text-secondary,#64748b)">Callback URL（LINE Pay 付款成功 redirect）</label>
          <input id="gw-callback-${p.code}" type="text"
            value="${escHtml(gw.callback_url || origin + '/api/' + p.code + '/confirm')}"
            style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:var(--bg,#0f1117);color:var(--text-primary,#e2e8f0);font-size:.85rem;box-sizing:border-box">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button class="btn-primary" style="flex:1;min-width:80px;font-size:.82rem"
            onclick="saveGateway('${p.code}')">💾 儲存</button>
          <button class="btn-secondary" style="font-size:.82rem"
            onclick="testGateway('${p.code}')">🔗 測試連線</button>
        </div>
        <div id="gw-result-${p.code}" style="font-size:.78rem;color:var(--text-secondary,#64748b)"></div>
      </div>
    </div>`;
  }).join('');
}

// fix16d: saveGateway/testGateway 改用 provider code（不用 id）
// PUT /api/payment-gateways/:provider（upsert，後端 INSERT OR IGNORE）
async function saveGateway(code) {
  const g = (k) => document.getElementById('gw-' + k + '-' + code);
  const resEl = document.getElementById('gw-result-' + code);
  if (!g('enabled')) { console.warn('saveGateway: element not found for', code); return; }

  const body = {
    is_active:    g('enabled').checked ? 1 : 0,
    mode:         g('mode')?.value     || 'test',
    merchant_id:  (g('mid')?.value     || '').trim(),
    webhook_url:  (g('webhook')?.value || '').trim(),
    callback_url: (g('callback')?.value|| '').trim(),
  };
  const apiKey = g('apikey')?.value || '';
  const secret = g('secret')?.value || '';
  if (apiKey && !apiKey.startsWith('••••')) body.api_key    = apiKey;
  if (secret && !secret.startsWith('••••')) body.secret_key = secret;

  if (resEl) resEl.textContent = '儲存中...';
  try {
    // fix16d: 使用 provider code 路徑（不用 id）
    const res  = await apiFetch('/api/payment-gateways/' + code, { method: 'PUT', body: JSON.stringify(body) });
    if (!res || !res.ok) {
      if (resEl) resEl.textContent = '❌ 儲存失敗（HTTP ' + (res?.status || '?') + '）';
      return;
    }
    const json = await res.json();
    if (resEl) resEl.textContent = json.success ? '✅ 已儲存' : '❌ ' + json.message;
    if (json.success) setTimeout(() => loadGatewayCards(), 800);
  } catch(e) {
    if (resEl) resEl.textContent = '❌ ' + e.message;
  }
}

// fix16d: testGateway 改用 provider code 路徑
async function testGateway(code) {
  const resEl = document.getElementById('gw-result-' + code);
  if (resEl) resEl.innerHTML = '<span style="color:#94a3b8">測試中…</span>';
  try {
    // 對 linepay 直接呼叫真實測試 API，並傳入目前表單的 mode
    let body = {};
    if (code === 'linepay') {
      const modeEl   = document.getElementById(`gw-mode-${code}`);
      const midEl    = document.getElementById(`gw-mid-${code}`);
      const secretEl = document.getElementById(`gw-secret-${code}`);
      if (modeEl)   body.mode           = modeEl.value;
      if (midEl)    body.channel_id     = midEl.value;
      if (secretEl && secretEl.value) body.channel_secret = secretEl.value;
      // 若 secret 欄位空白，後端會從 DB 讀取
    }
    const res  = await apiFetch('/api/payment-gateways/' + code + '/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (resEl) {
      const color = json.success ? '#06C755' : '#ef4444';
      const icon  = json.success ? '✅' : '❌';
      resEl.innerHTML = `<span style="color:${color};font-weight:600">${icon} ${json.message || ''}</span>`;
      if (json.return_code && !json.success) {
        resEl.innerHTML += `<br><span style="font-size:11px;color:#94a3b8">LINE Pay returnCode: ${json.return_code} | ${json.apiBase || ''}</span>`;
      }
    }
  } catch(e) {
    if (resEl) resEl.innerHTML = `<span style="color:#ef4444">❌ ${e.message}</span>`;
  }
}

// ===== v18-features: Android 平板功能權限 =====

const ANDROID_FEATURES_DEFAULT_WEB = {
  pos: true, orders: true, reports: false, products: false,
  inventory: false, payment_methods: false, delivery_settings: false,
  line_orders: true, line_products: false, settings: true,
  sync: true, print_settings: true
};

const ANDROID_FEATURE_KEYS = [
  'pos', 'orders', 'reports', 'products', 'inventory',
  'payment_methods', 'delivery_settings', 'line_orders',
  'line_products', 'settings', 'sync', 'print_settings'
];

async function loadAndroidFeaturesTab() {
  const loadingEl = document.getElementById('android-features-loading');
  const formEl    = document.getElementById('android-features-form');
  if (!loadingEl || !formEl) return;

  loadingEl.style.display = 'block';
  formEl.style.display    = 'none';

  try {
    const res  = await apiFetch('/api/settings');
    const json = await res.json();
    if (!json.success) throw new Error('無法載入設定');

    let features = { ...ANDROID_FEATURES_DEFAULT_WEB };
    const raw = json.data && json.data.android_features;
    if (raw) {
      try { features = { ...features, ...JSON.parse(raw) }; } catch {}
    }

    ANDROID_FEATURE_KEYS.forEach(key => {
      const el = document.getElementById('af-' + key);
      if (el) el.checked = features[key] !== false;
    });

    loadingEl.style.display = 'none';
    formEl.style.display    = 'block';
  } catch (e) {
    loadingEl.textContent = '載入失敗：' + e.message;
  }
}

async function saveAndroidFeatures() {
  const statusEl = document.getElementById('android-features-status');
  const features = {};
  ANDROID_FEATURE_KEYS.forEach(key => {
    const el = document.getElementById('af-' + key);
    features[key] = el ? el.checked : true;
  });

  try {
    const res  = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ android_features: JSON.stringify(features) })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '儲存失敗');

    if (statusEl) {
      statusEl.textContent = '✅ 已儲存，平板同步後生效';
      statusEl.style.color = '#27ae60';
      statusEl.style.display = 'inline';
      setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    }
    showToast('Android 平板權限已儲存', 'success');
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.style.color = '#e53935';
      statusEl.style.display = 'inline';
    }
    showToast('儲存失敗：' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════
// fix18-06: 外送費設定 Tab
// ═══════════════════════════════════════════════════════

let _deliveryRules = [];

async function loadDeliveryFeeTab() {
  await loadSettings();
  // 填入基本欄位
  const setVal = (id, key, fallback = '') => {
    const el = document.getElementById(id);
    if (el) el.value = settings[key] ?? fallback;
  };
  const setChk = (id, key, fallback = false) => {
    const el = document.getElementById(id);
    if (el) el.checked = (settings[key] ?? (fallback ? '1' : '0')) === '1';
  };
  setVal('set-store_address',               'store_address');
  setVal('set-store_lat',                   'store_lat');
  setVal('set-store_lng',                   'store_lng');
  setVal('set-delivery_max_distance_km',    'delivery_max_distance_km',  '7');
  setVal('set-delivery_basic_fee',          'delivery_basic_fee',        '50');
  setVal('set-delivery_free_threshold',     'delivery_free_threshold',   '1000');
  setChk('set-delivery_distance_fee_enabled', 'delivery_distance_fee_enabled', true);
  setChk('set-coupon_apply_to_delivery_fee',  'coupon_apply_to_delivery_fee',  false);

  // 級距規則
  try {
    const raw = settings['delivery_distance_fee_rules'] || '';
    _deliveryRules = raw ? JSON.parse(raw) : [
      { max_km: 3, fee: 50 }, { max_km: 5, fee: 80 }, { max_km: 7, fee: 120 }
    ];
  } catch { _deliveryRules = [{ max_km: 3, fee: 50 }, { max_km: 5, fee: 80 }, { max_km: 7, fee: 120 }]; }
  renderDeliveryRules();
}

function renderDeliveryRules() {
  const cont = document.getElementById('delivery-rules-editor');
  if (!cont) return;
  cont.innerHTML = _deliveryRules.map((r, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="color:#888;font-size:13px;min-width:32px">${i + 1}.</span>
      <span style="font-size:13px;color:#555">距離 ≤</span>
      <input type="number" value="${r.max_km}" min="0.1" step="0.5"
        style="width:80px;padding:6px;border:1px solid #ddd;border-radius:6px"
        onchange="_deliveryRules[${i}].max_km=parseFloat(this.value)||0">
      <span style="font-size:13px;color:#555">km，外送費</span>
      <input type="number" value="${r.fee}" min="0" step="10"
        style="width:80px;padding:6px;border:1px solid #ddd;border-radius:6px"
        onchange="_deliveryRules[${i}].fee=parseInt(this.value)||0">
      <span style="font-size:13px;color:#555">NT$</span>
      <button onclick="_deliveryRules.splice(${i},1);renderDeliveryRules()"
        style="background:#ffebee;color:#e53935;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px">✕</button>
    </div>
  `).join('');
}

function addDeliveryRule() {
  const last = _deliveryRules[_deliveryRules.length - 1];
  _deliveryRules.push({ max_km: (last ? last.max_km + 2 : 3), fee: (last ? last.fee + 30 : 50) });
  renderDeliveryRules();
}

async function geocodeStoreAddress() {
  const addr = (document.getElementById('set-store_address')?.value || '').trim();
  const statusEl = document.getElementById('geocode-status');
  if (!addr) { if (statusEl) statusEl.textContent = '請先填寫店家地址'; return; }
  if (statusEl) statusEl.textContent = '座標取得中…';
  try {
    const res  = await apiFetch('/api/maps/geocode', { method: 'POST', body: JSON.stringify({ address: addr }) });
    const json = await res.json();
    if (json.success) {
      const latEl = document.getElementById('set-store_lat');
      const lngEl = document.getElementById('set-store_lng');
      if (latEl) latEl.value = json.lat;
      if (lngEl) lngEl.value = json.lng;
      if (statusEl) {
        statusEl.textContent = `✅ ${json.formatted_address}（${json.lat}, ${json.lng}）`;
        statusEl.style.color = '#2e7d32';
      }
    } else {
      if (statusEl) { statusEl.textContent = '❌ ' + (json.message || '無法取得座標'); statusEl.style.color = '#e53935'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#e53935'; }
  }
}

async function saveDeliveryFeeSettings() {
  // 讀取規則並排序
  _deliveryRules.sort((a, b) => a.max_km - b.max_km);
  const body = {
    store_address:                 document.getElementById('set-store_address')?.value || '',
    store_lat:                     document.getElementById('set-store_lat')?.value     || '',
    store_lng:                     document.getElementById('set-store_lng')?.value     || '',
    delivery_distance_fee_enabled: document.getElementById('set-delivery_distance_fee_enabled')?.checked ? '1' : '0',
    delivery_max_distance_km:      document.getElementById('set-delivery_max_distance_km')?.value  || '7',
    delivery_basic_fee:            document.getElementById('set-delivery_basic_fee')?.value         || '50',
    delivery_free_threshold:       document.getElementById('set-delivery_free_threshold')?.value    || '1000',
    coupon_apply_to_delivery_fee:  document.getElementById('set-coupon_apply_to_delivery_fee')?.checked ? '1' : '0',
    delivery_distance_fee_rules:   JSON.stringify(_deliveryRules),
  };
  try {
    const res  = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    const json = await res.json();
    if (json.success) {
      settings = { ...settings, ...json.data };
      showToast('✅ 外送費設定已儲存', 'success');
    } else {
      showToast('❌ 儲存失敗：' + (json.message || ''), 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  }
}

// ── fix18-05: window 全域函式匯出 ─────────────────────────────────────────
// 確保 onclick 屬性與外部 JS（coupons.js 等）可直接呼叫這些函式
// 不包在 DOMContentLoaded 內，讓函式在 HTML 解析到 onclick 時就已存在
(function exportGlobals() {
  window.showPage              = window.showPage              || showPage;
  window.escHtml               = window.escHtml               || escHtml;
  window.apiFetch              = window.apiFetch              || apiFetch;
  window.showToast             = window.showToast             || showToast;
  window.switchSettingsTab     = window.switchSettingsTab     || switchSettingsTab;
  window.hasFeature            = window.hasFeature            || hasFeature;
  window.cancelTodayCutoff     = window.cancelTodayCutoff     || cancelTodayCutoff;     // fix18-06
  // fix18-06: 外送費設定
  window.geocodeStoreAddress   = geocodeStoreAddress;
  window.addDeliveryRule       = addDeliveryRule;
  window.saveDeliveryFeeSettings = saveDeliveryFeeSettings;
  window.renderDeliveryRules   = renderDeliveryRules;
})();

// ═══════════════════════════════════════════════════════════
// fix18-09F：商品分析群組
// ═══════════════════════════════════════════════════════════

// ── 載入群組資料 ────────────────────────────────────────────
async function loadProductAnalysisGroups() {
  try {
    const res  = await apiFetch('/api/product-analysis-groups');
    const json = await res.json();
    if (json.success) {
      allProductAnalysisGroups = json.data || [];
    }
  } catch(e) {
    console.warn('[fix18-09F] loadProductAnalysisGroups error:', e.message);
  }
}

// ── 核心：商品名稱 → 群組名稱 mapping ───────────────────────
// 若商品在某個啟用群組中，回傳群組名稱；否則回傳原始商品名稱
// fix18-09F-hotfix4：比對順序 product_name → alias_name
function getAnalysisGroupName(productName) {
  if (!allProductAnalysisGroups || !allProductAnalysisGroups.length) return null;
  for (const g of allProductAnalysisGroups) {
    if (!g.enabled) continue;
    // 1. 先比對現有商品名稱（items）
    if (g.items && g.items.some(item => item.product_name === productName)) {
      return g.group_name;
    }
    // 2. 再比對歷史品名別名（aliases）
    if (g.aliases && g.aliases.some(a => a.alias_name === productName)) {
      return g.group_name;
    }
  }
  return null;
}

// 根據統計模式回傳顯示名稱（'group'模式 or 'raw'模式）
function resolveProductDisplayName(productName, mode) {
  if (mode === 'raw') return productName;
  const groupName = getAnalysisGroupName(productName);
  return groupName || productName;
}

// ── 統計模式 localStorage key ────────────────────────────────
const PRODUCT_STAT_MODE_KEY = 'product_stat_mode_09f'; // 'group' | 'raw'
function getProductStatMode() {
  try { return localStorage.getItem(PRODUCT_STAT_MODE_KEY) || 'group'; } catch { return 'group'; }
}
function setProductStatMode(m) {
  try { localStorage.setItem(PRODUCT_STAT_MODE_KEY, m); } catch {}
}

// ── 訂單列表：商品分析群組標籤顯示控制 ──────────────────────
const GROUP_LABEL_DISPLAY_KEY = 'show_group_label_09f';
function isGroupLabelEnabled() {
  try {
    const v = localStorage.getItem(GROUP_LABEL_DISPLAY_KEY);
    return v === null ? true : v === '1'; // 預設開啟
  } catch { return true; }
}
function setGroupLabelEnabled(v) {
  try { localStorage.setItem(GROUP_LABEL_DISPLAY_KEY, v ? '1' : '0'); } catch {}
}

// ── 建立統計 Map（支援群組合併）─────────────────────────────
function buildProductStatMap(orders, mode) {
  const map = {};
  (orders || []).forEach(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return;
    const items = typeof o.items === 'string' ? JSON.parse(o.items || '[]') : (o.items || []);
    items.forEach(item => {
      const displayName = resolveProductDisplayName(item.name, mode);
      if (!map[displayName]) map[displayName] = { name: displayName, qty: 0, revenue: 0 };
      map[displayName].qty     += Number(item.qty || 1);
      map[displayName].revenue += Number(item.subtotal || 0);
    });
  });
  return Object.values(map).sort((a, b) => b.qty - a.qty);
}

// ── 折扣商品排行：支援群組合併 ──────────────────────────────
function buildDiscountProdMapWithGroups(orders, mode) {
  const valid = (orders || []).filter(o => {
    if (o.status === 'void' || o.order_status === 'cancelled') return false;
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return Number(o.discount_amount || 0) > 0;
  });
  const prodMap = {};
  valid.forEach(o => {
    const disc = Number(o.discount_amount || 0);
    const targetIsProduct = (o.discount_target_type === 'products' || o.discount_target_type === 'product');
    const names = Array.isArray(o.discount_product_names) && o.discount_product_names.length
      ? o.discount_product_names
      : (o.discount_product_name
          ? o.discount_product_name.split('、').map(s => s.trim()).filter(Boolean)
          : []);
    if (targetIsProduct && names.length) {
      const share = disc / names.length;
      names.forEach(pname => {
        const dname = resolveProductDisplayName(pname, mode);
        if (!prodMap[dname]) prodMap[dname] = { name: dname, total: 0, count: 0 };
        prodMap[dname].total += share;
        prodMap[dname].count += 1;
      });
    } else {
      const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      const totalQty = items.reduce((s, i) => s + Number(i.qty || 0), 0);
      items.forEach(item => {
        const share = totalQty > 0 ? disc * Number(item.qty || 0) / totalQty : 0;
        const dname = resolveProductDisplayName(item.name, mode);
        if (!prodMap[dname]) prodMap[dname] = { name: dname, total: 0, count: 0 };
        prodMap[dname].total += share;
        prodMap[dname].count += 1;
      });
    }
  });
  return Object.values(prodMap).sort((a, b) => b.total - a.total);
}

// ── 熱賣商品：帶模式切換按鈕的渲染函式 ─────────────────────
function renderHotProductsCard(orders) {
  const mode = getProductStatMode();
  const ranked = buildProductStatMap(orders, mode).slice(0, 3);
  const modeBtn = `<div style="display:flex;gap:4px;align-items:center;margin-bottom:8px">
    <span style="font-size:11px;color:var(--text-muted)">統計：</span>
    <button onclick="setProductStatMode('group');window._rerenderStatCards&&_rerenderStatCards()" style="font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--border,#334155);background:${mode==='group'?'#6366f1':'transparent'};color:${mode==='group'?'#fff':'var(--text-secondary)'};cursor:pointer">商品群組</button>
    <button onclick="setProductStatMode('raw');window._rerenderStatCards&&_rerenderStatCards()" style="font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--border,#334155);background:${mode==='raw'?'#6366f1':'transparent'};color:${mode==='raw'?'#fff':'var(--text-secondary)'};cursor:pointer">原始商品</button>
  </div>`;
  if (!ranked.length) return '';
  const rows = ranked.map(p => `<div style="font-size:13px;line-height:1.8">${escHtml(p.name)} <small style="color:#999">×${p.qty}</small></div>`).join('');
  return `<div class="stat-card">
    <div class="stat-card-label">🏆 熱賣</div>
    ${modeBtn}
    <div class="stat-card-value" style="font-size:14px">${rows}</div>
  </div>`;
}

// ── 折扣商品排行卡（帶群組模式）────────────────────────────
function renderDiscountTopProductsWithGroups(orders) {
  const mode = getProductStatMode();
  const ranked = buildDiscountProdMapWithGroups(orders, mode);
  if (!ranked.length) return '';
  const preview = ranked.slice(0, 3);
  const modeBtn = `<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px">
    <button onclick="setProductStatMode('group');window._rerenderStatCards&&_rerenderStatCards()" style="font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--border,#334155);background:${mode==='group'?'#6366f1':'transparent'};color:${mode==='group'?'#fff':'var(--text-secondary)'};cursor:pointer">商品群組</button>
    <button onclick="setProductStatMode('raw');window._rerenderStatCards&&_rerenderStatCards()" style="font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--border,#334155);background:${mode==='raw'?'#6366f1':'transparent'};color:${mode==='raw'?'#fff':'var(--text-secondary)'};cursor:pointer">原始商品</button>
  </div>`;
  const previewRows = preview.map((p, i) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#334155)">
      <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px">${i+1}. ${escHtml(p.name)}</span>
      <span style="text-align:right;white-space:nowrap;margin-left:6px">
        <span style="color:var(--danger);font-family:monospace;font-weight:700">NT$${Math.round(p.total)}</span>
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px">${p.count}筆</span>
      </span>
    </div>`
  ).join('');
  return `<div class="stat-card" style="min-width:200px;max-width:280px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="stat-card-label" style="margin:0">📉 折扣商品排行</div>
      <button onclick="openDiscTop10WithGroups()" style="font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary,#94a3b8);cursor:pointer;white-space:nowrap">查看 TOP10</button>
    </div>
    ${modeBtn}
    ${previewRows}
    ${ranked.length > 3 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:6px;cursor:pointer" onclick="openDiscTop10WithGroups()">還有 ${ranked.length - 3} 項 →</div>` : ''}
  </div>`;
}

function openDiscTop10WithGroups() {
  const mode = getProductStatMode();
  const ranked = buildDiscountProdMapWithGroups(_allOrdersCache || [], mode);
  const top10  = ranked.slice(0, 10);
  document.getElementById('discTop10Body').innerHTML = top10.length
    ? top10.map((p, i) => {
        const avg = p.count > 0 ? Math.round(p.total / p.count) : 0;
        return `<tr>
          <td style="font-size:13px;color:var(--text-muted);text-align:center">${i + 1}</td>
          <td style="font-size:13px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</td>
          <td style="text-align:right;font-family:monospace;color:var(--danger);font-weight:700">NT$${Math.round(p.total)}</td>
          <td style="text-align:right;color:var(--text-secondary)">${p.count}筆</td>
          <td style="text-align:right;font-family:monospace;color:var(--text-secondary)">NT$${avg}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:16px">無資料</td></tr>';
  document.getElementById('discTop10Modal').classList.add('open');
}

// ── 重新渲染統計卡（供模式切換按鈕呼叫）────────────────────
window._rerenderStatCards = function() {
  if (_allOrdersCache && typeof renderStatCards === 'function') {
    // 重新觸發渲染
    const statsEl = document.getElementById('orderStats');
    if (statsEl) {
      // 讀取最近快取的 stats
      if (window._lastOrderStats) {
        renderStatCards(window._lastOrderStats, _allOrdersCache);
      }
    }
  }
};

// ── 設定中心：商品分析群組 Tab ──────────────────────────────
async function loadProductAnalysisGroupsTab() {
  await loadProductAnalysisGroups();
  renderAnalysisGroupList();
}

function renderAnalysisGroupList() {
  const el = document.getElementById('analysisGroupList');
  if (!el) return;
  if (!allProductAnalysisGroups.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">尚無群組，點擊「＋ 新增群組」開始設定</div>';
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:2px solid var(--border,#334155)">
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">群組名稱</th>
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">說明</th>
          <th style="text-align:left;padding:8px 10px;color:var(--text-muted)">成員 / 歷史別名</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">狀態</th>
          <th style="text-align:center;padding:8px 10px;color:var(--text-muted)">排序</th>
          <th style="text-align:right;padding:8px 10px;color:var(--text-muted)">操作</th>
        </tr>
      </thead>
      <tbody>
        ${allProductAnalysisGroups.map(g => {
          const itemTags = (g.items || []).map(i =>
            '<span style="display:inline-block;background:var(--bg-base,#0f172a);border:1px solid var(--border,#334155);border-radius:4px;padding:1px 6px;margin:1px;font-size:11px">' + escHtml(i.product_name) + '</span>'
          ).join('');
          const aliasTags = (g.aliases || []).map(a =>
            '<span style="display:inline-block;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:4px;padding:1px 6px;margin:1px;font-size:11px;color:#fbbf24">⏪ ' + escHtml(a.alias_name) + '</span>'
          ).join('');
          const memberHtml = (itemTags || aliasTags)
            ? itemTags + (aliasTags ? '<br>' + aliasTags : '')
            : '<span style="color:var(--text-muted)">（空群組）</span>';
          return `
          <tr style="border-bottom:1px solid var(--border,#334155)">
            <td style="padding:10px;font-weight:600;color:${g.enabled?'var(--text-primary,#f1f5f9)':'var(--text-muted,#64748b)'}">${escHtml(g.group_name)}</td>
            <td style="padding:10px;color:var(--text-muted,#64748b);font-size:12px">${escHtml(g.description||'—')}</td>
            <td style="padding:10px;font-size:12px">${memberHtml}</td>
            <td style="padding:10px;text-align:center">
              <span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;background:${g.enabled?'#10b98120':'#ef444420'};color:${g.enabled?'#10b981':'#ef4444'}">${g.enabled?'啟用':'停用'}</span>
            </td>
            <td style="padding:10px;text-align:center;color:var(--text-muted)">${g.sort_order||0}</td>
            <td style="padding:10px;text-align:right;white-space:nowrap">
              <button onclick="openAnalysisGroupModal(${g.id})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px;margin-left:4px">✏️ 編輯</button>
              <button onclick="toggleAnalysisGroup(${g.id})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px;margin-left:4px">${g.enabled?'停用':'啟用'}</button>
              <button onclick="deleteAnalysisGroup(${g.id},'${escHtml(g.group_name)}')" style="padding:4px 10px;border-radius:6px;border:1px solid #ef4444;background:transparent;color:#ef4444;cursor:pointer;font-size:12px;margin-left:4px">🗑️ 刪除</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}


// ── 商品分析群組 Modal 開啟 / 關閉 ─────────────────────────
async function openAnalysisGroupModal(id) {
  // ── 立即重設表單 ─────────────────────────────────────────
  const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v; };
  const setChk = (elId, v) => { const el = document.getElementById(elId); if (el) el.checked = !!v; };
  setVal('editAnalysisGroupId', id || '');
  setVal('editAnalysisGroupName', '');
  setVal('editAnalysisGroupDesc', '');
  setVal('editAnalysisGroupSort', '0');
  setChk('editAnalysisGroupEnabled', true);

  const titleEl = document.getElementById('analysisGroupModalTitle');
  if (titleEl) titleEl.textContent = id ? '編輯商品分析群組' : '新增商品分析群組';

  // ── 先開啟 Modal ─────────────────────────────────────────
  const modal = document.getElementById('analysisGroupModal');
  if (modal) {
    modal.classList.add('open');
    modal.style.setProperty('display',         'flex',             'important');
    modal.style.setProperty('visibility',      'visible',          'important');
    modal.style.setProperty('opacity',         '1',                'important');
    modal.style.setProperty('pointer-events',  'auto',             'important');
    modal.style.setProperty('position',        'fixed',            'important');
    modal.style.setProperty('inset',           '0',                'important');
    modal.style.setProperty('z-index',         '99999',            'important');
    modal.style.setProperty('background',      'rgba(0,0,0,0.75)', 'important');
    modal.style.setProperty('align-items',     'center',           'important');
    modal.style.setProperty('justify-content', 'center',           'important');
  }

  // ── 顯示載入中 ──────────────────────────────────────────
  const listEl = document.getElementById('analysisGroupProductList');
  if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted,#64748b);font-size:13px;padding:12px">載入商品中...</div>';

  // ── 清空別名列表 ─────────────────────────────────────────
  _renderAliasList([]);

  let selectedNames = [];

  // ── 編輯模式：載入群組資料（含 aliases）────────────────
  if (id) {
    try {
      const res  = await apiFetch('/api/product-analysis-groups/' + id);
      const json = await res.json();
      if (json.success && json.data) {
        const g = json.data;
        setVal('editAnalysisGroupName', g.group_name || '');
        setVal('editAnalysisGroupDesc', g.description || '');
        setVal('editAnalysisGroupSort', g.sort_order || 0);
        setChk('editAnalysisGroupEnabled', g.enabled);
        selectedNames = (g.items || []).map(i => i.product_name);
        // 渲染別名列表
        _renderAliasList((g.aliases || []).map(a => a.alias_name));
      }
    } catch(e) { console.warn('[AG] fetch group:', e.message); }
  }

  // ── 渲染商品勾選清單 ────────────────────────────────────
  await _renderAnalysisGroupProductCheckboxes(selectedNames);
}

function closeAnalysisGroupModal() {
  const modal = document.getElementById('analysisGroupModal');
  if (!modal) return;
  modal.classList.remove('open');
  // 清除 hotfix2 setProperty 強制值
  ['display','visibility','opacity','pointer-events','position','inset','z-index','background','align-items','justify-content'].forEach(prop => {
    modal.style.removeProperty(prop);
  });
}

async function _renderAnalysisGroupProductCheckboxes(selectedNames) {
  const listEl = document.getElementById('analysisGroupProductList');
  if (!listEl) return;
  // 使用全域 allProducts，若沒有就從 API 取
  let products = allProducts || [];
  if (!products.length) {
    try {
      const res  = await apiFetch('/api/products');
      const json = await res.json();
      products = json.success ? (json.data || []) : [];
    } catch {}
  }
  if (!products.length) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">無商品資料</div>';
    return;
  }

  // 依分類排序
  const sorted = [...products].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  listEl.innerHTML = sorted.map(p => {
    const checked = selectedNames.includes(p.name);
    return `<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer;transition:background .15s" onmouseover="this.style.background='var(--bg-card,#1a1d27)'" onmouseout="this.style.background=''"
      data-pname="${escHtml(p.name)}" class="ag-product-item">
      <input type="checkbox" value="${escHtml(p.name)}" ${checked ? 'checked' : ''} style="width:14px;height:14px;cursor:pointer" class="ag-product-cb">
      <span style="font-size:13px;flex:1">${escHtml(p.name)}</span>
      <span style="font-size:11px;color:var(--text-muted)">${escHtml(p.category||'')}</span>
    </label>`;
  }).join('');
}

function filterAnalysisGroupProducts() {
  const q = (document.getElementById('analysisGroupSearch')?.value || '').toLowerCase();
  document.querySelectorAll('#analysisGroupProductList .ag-product-item').forEach(el => {
    const name = (el.dataset.pname || '').toLowerCase();
    el.style.display = name.includes(q) ? '' : 'none';
  });
}

function selectAllAnalysisGroupProducts(checked) {
  document.querySelectorAll('#analysisGroupProductList .ag-product-cb').forEach(cb => {
    const item = cb.closest('.ag-product-item');
    if (!item || item.style.display === 'none') return;
    cb.checked = checked;
  });
}

async function saveAnalysisGroup() {
  const id   = document.getElementById('editAnalysisGroupId').value;
  const name = (document.getElementById('editAnalysisGroupName').value || '').trim();
  if (!name) { showToast('請輸入群組名稱', 'error'); return; }

  // 現有商品成員（勾選框）
  const checkedBoxes = document.querySelectorAll('#analysisGroupProductList .ag-product-cb:checked');
  const items = Array.from(checkedBoxes).map(cb => ({ product_name: cb.value }));

  // 歷史品名別名（alias 列表）
  const aliases = _getAliasListValues();

  const body = {
    group_name:  name,
    description: document.getElementById('editAnalysisGroupDesc').value || '',
    sort_order:  Number(document.getElementById('editAnalysisGroupSort').value) || 0,
    enabled:     document.getElementById('editAnalysisGroupEnabled').checked ? 1 : 0,
    items,
    aliases
  };

  try {
    const url    = id ? `/api/product-analysis-groups/${id}` : '/api/product-analysis-groups';
    const method = id ? 'PUT' : 'POST';
    const res    = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json   = await res.json();
    if (!json.success) { showToast('❌ ' + (json.message || '儲存失敗'), 'error'); return; }
    showToast(id ? '✅ 群組已更新' : '✅ 群組已建立', 'success');
    closeAnalysisGroupModal();
    await loadProductAnalysisGroups();
    renderAnalysisGroupList();
  } catch(e) { showToast('❌ ' + e.message, 'error'); }
}

async function toggleAnalysisGroup(id) {
  try {
    const res  = await apiFetch(`/api/product-analysis-groups/${id}/toggle`, { method: 'PATCH' });
    const json = await res.json();
    if (!json.success) { showToast('❌ ' + (json.message || '操作失敗'), 'error'); return; }
    showToast('✅ 狀態已更新', 'success');
    await loadProductAnalysisGroups();
    renderAnalysisGroupList();
  } catch(e) { showToast('❌ ' + e.message, 'error'); }
}

async function deleteAnalysisGroup(id, name) {
  if (!confirm(`確定要刪除群組「${name}」？此操作不可還原。`)) return;
  try {
    const res  = await apiFetch(`/api/product-analysis-groups/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) { showToast('❌ ' + (json.message || '刪除失敗'), 'error'); return; }
    showToast('✅ 群組已刪除', 'success');
    await loadProductAnalysisGroups();
    renderAnalysisGroupList();
  } catch(e) { showToast('❌ ' + e.message, 'error'); }
}

// ── fix18-09F-hotfix1：確保所有群組函式掛載到 window ─────────
// (function declarations 已 hoist，但顯式掛載更保險)
(function exportAnalysisGroupGlobals() {
  window.openAnalysisGroupModal       = openAnalysisGroupModal;
  window.closeAnalysisGroupModal      = closeAnalysisGroupModal;
  window.saveAnalysisGroup            = saveAnalysisGroup;
  window.toggleAnalysisGroup          = toggleAnalysisGroup;
  window.deleteAnalysisGroup          = deleteAnalysisGroup;
  window.filterAnalysisGroupProducts  = filterAnalysisGroupProducts;
  window.selectAllAnalysisGroupProducts = selectAllAnalysisGroupProducts;
  window.loadProductAnalysisGroupsTab = loadProductAnalysisGroupsTab;
  window.setProductStatMode           = setProductStatMode;
  window.openDiscTop10WithGroups      = openDiscTop10WithGroups;
})();

// ── fix18-09F-hotfix3：Modal 診斷工具 ───────────────────────
window.debugAnalysisGroupModal = function () {
  const m = document.getElementById('analysisGroupModal');
  console.log('Modal=', m);
  if (!m) { console.error('analysisGroupModal NOT FOUND'); return; }
  const cs = getComputedStyle(m);
  console.log('display=',       cs.display);
  console.log('visibility=',    cs.visibility);
  console.log('opacity=',       cs.opacity);
  console.log('zIndex=',        cs.zIndex);
  console.log('offsetWidth=',   m.offsetWidth);
  console.log('offsetHeight=',  m.offsetHeight);
  console.log('rect=',          m.getBoundingClientRect());
  console.log('modal-content=', m.querySelector('.modal-content'));
  console.log('modal-box=',     m.querySelector('.modal-box'));
  console.log('modal=',         m.querySelector('.modal'));
  const parent = m.parentElement;
  console.log('parentElement=', parent ? parent.tagName + (parent.id ? '#'+parent.id : '') + (parent.className ? '.'+parent.className.split(' ').join('.') : '') : null);
  if (parent) {
    const pcs = getComputedStyle(parent);
    console.log('parent display=',    pcs.display);
    console.log('parent visibility=', pcs.visibility);
  }
  console.log('html=', m.innerHTML.substring(0, 1000));
};

// ── fix18-09F-hotfix4：歷史品名別名 UI helpers ─────────────

// 渲染別名列表到 #analysisGroupAliasList
function _renderAliasList(aliases) {
  const el = document.getElementById('analysisGroupAliasList');
  if (!el) return;
  if (!aliases || !aliases.length) {
    el.innerHTML = '<div style="color:var(--text-muted,#64748b);font-size:12px;padding:4px 0">尚無別名</div>';
    return;
  }
  el.innerHTML = aliases.map((a, i) =>
    `<div style="display:flex;align-items:center;gap:6px;padding:3px 0" data-alias-idx="${i}">
      <span style="font-size:12px;flex:1;color:#fbbf24">⏪ ${escHtml(a)}</span>
      <button onclick="_removeAlias(${i})" style="background:transparent;border:1px solid #ef4444;color:#ef4444;border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer">✕</button>
    </div>`
  ).join('');
}

// 取得目前別名列表（讀 DOM）
function _getAliasListValues() {
  const el = document.getElementById('analysisGroupAliasList');
  if (!el) return [];
  const spans = el.querySelectorAll('[data-alias-idx] span');
  return Array.from(spans).map(s => s.textContent.replace(/^⏪\s*/, '').trim()).filter(Boolean);
}

// 新增別名
function addAnalysisGroupAlias() {
  const inp = document.getElementById('analysisGroupAliasInput');
  if (!inp) return;
  const val = (inp.value || '').trim();
  if (!val) { showToast('請輸入別名', 'error'); return; }
  const current = _getAliasListValues();
  if (current.includes(val)) { showToast('此別名已存在', 'error'); return; }
  _renderAliasList([...current, val]);
  inp.value = '';
  inp.focus();
}

// 移除別名（by index）
function _removeAlias(idx) {
  const current = _getAliasListValues();
  current.splice(idx, 1);
  _renderAliasList(current);
}

// 更新 window exports
window.addAnalysisGroupAlias = addAnalysisGroupAlias;
window._removeAlias           = _removeAlias;

// ═══════════════════════════════════════════════════════════════════════════
// fix18-10 — 快速搬家檔 + 訂單/LINE預購 匯出匯入
// ═══════════════════════════════════════════════════════════════════════════

// ── 共用：強制顯示 modal ─────────────────────────────────────────────────
function showModal18(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.setProperty('display',         'flex',             'important');
  el.style.setProperty('visibility',      'visible',          'important');
  el.style.setProperty('opacity',         '1',                'important');
  el.style.setProperty('pointer-events',  'auto',             'important');
  el.style.setProperty('position',        'fixed',            'important');
  el.style.setProperty('inset',           '0',                'important');
  el.style.setProperty('z-index',         '99999',            'important');
  el.style.setProperty('background',      'rgba(0,0,0,0.75)', 'important');
  el.style.setProperty('align-items',     'center',           'important');
  el.style.setProperty('justify-content', 'center',           'important');
}
function hideModal18(id) {
  const el = document.getElementById(id);
  if (el) el.style.setProperty('display', 'none', 'important');
}

// ── 共用：讀取 JSON 檔案 ─────────────────────────────────────────────────
function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => { try { resolve(JSON.parse(e.target.result)); } catch(err) { reject(new Error('JSON 解析失敗：' + err.message)); } };
    r.onerror = () => reject(new Error('檔案讀取失敗'));
    r.readAsText(file, 'utf-8');
  });
}

// ── 共用：下載 blob ──────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href    = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
//  A. 訂單匯出
// ═══════════════════════════════════════════════════════════════════════════
let _orderExportParsedDates = {};

function openOrderExportModal() {
  // 讀取目前查詢的日期範圍（若有）
  const df = document.getElementById('dateFrom');
  const dt = document.getElementById('dateTo');
  _orderExportParsedDates = { from: df ? df.value : '', to: dt ? dt.value : '' };
  showModal18('orderExportModal');
}
function closeOrderExportModal() { hideModal18('orderExportModal'); }

async function doOrderExport() {
  const format = document.getElementById('orderExportFormat').value;
  const scope  = document.getElementById('orderExportScope').value;
  let url = `/api/export/orders?format=${format}&scope=${scope}`;
  if (scope === 'filtered' && _orderExportParsedDates.from && _orderExportParsedDates.to) {
    url += `&date_from=${_orderExportParsedDates.from}&date_to=${_orderExportParsedDates.to}`;
  }
  try {
    const res = await apiFetch(url);
    if (!res.ok) { showToast('匯出失敗', 'error'); return; }
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    const m    = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1] : `orders_export.${format}`;
    downloadBlob(blob, name);
    closeOrderExportModal();
    showToast('訂單匯出成功', 'success');
  } catch(e) { showToast('匯出失敗：' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  B. 訂單匯入
// ═══════════════════════════════════════════════════════════════════════════
let _orderImportData = null;

function openOrderImportModal() {
  _orderImportData = null;
  const fi = document.getElementById('orderImportFile');
  if (fi) fi.value = '';
  document.getElementById('orderImportPreview').style.display  = 'none';
  document.getElementById('orderImportResult').style.display   = 'none';
  document.getElementById('orderImportSubmitBtn').style.display = 'none';
  showModal18('orderImportModal');
}
function closeOrderImportModal() { hideModal18('orderImportModal'); }

async function onOrderImportFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById('orderImportPreview');
  const submit  = document.getElementById('orderImportSubmitBtn');
  preview.style.display = 'none';
  submit.style.display  = 'none';
  _orderImportData = null;

  try {
    const json = await readJsonFile(file);
    // 支援兩種格式：直接 orders 陣列 或 { data: { orders, order_items, order_logs } }
    let orders = [], orderItems = [], orderLogs = [];
    if (Array.isArray(json)) {
      orders = json;
    } else if (json.data && Array.isArray(json.data.orders)) {
      orders     = json.data.orders;
      orderItems = json.data.order_items || [];
      orderLogs  = json.data.order_logs  || [];
    } else if (json.orders) {
      orders     = json.orders;
      orderItems = json.order_items || [];
      orderLogs  = json.order_logs  || [];
    } else {
      preview.style.display = 'block';
      preview.innerHTML = '<span style="color:#f87171">❌ 無法識別的 JSON 格式</span>';
      return;
    }
    _orderImportData = { orders, order_items: orderItems, order_logs: orderLogs };
    preview.style.display = 'block';
    preview.innerHTML = `<div style="color:var(--accent,#3b82f6);font-weight:700;margin-bottom:6px">📋 檔案預覽</div>
      <div>訂單：<strong>${orders.length}</strong> 筆</div>
      <div>訂單明細：<strong>${orderItems.length}</strong> 筆</div>
      <div>訂單紀錄：<strong>${orderLogs.length}</strong> 筆</div>`;
    submit.style.display = '';
  } catch(e) {
    preview.style.display = 'block';
    preview.innerHTML = `<span style="color:#f87171">❌ ${escHtml(e.message)}</span>`;
  }
}

async function doOrderImport() {
  if (!_orderImportData) return;
  const mode   = document.getElementById('orderImportMode').value;
  const btn    = document.getElementById('orderImportSubmitBtn');
  const result = document.getElementById('orderImportResult');
  btn.disabled = true; btn.textContent = '匯入中…';
  result.style.display = 'none';

  try {
    const res  = await apiFetch('/api/import/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(_orderImportData), mode })
    });
    const json = await res.json();
    result.style.display = 'block';
    if (json.success) {
      const parts = [];
      if (json.added)   parts.push(`新增 ${json.added} 筆`);
      if (json.updated) parts.push(`更新 ${json.updated} 筆`);
      if (json.skipped) parts.push(`跳過 ${json.skipped} 筆`);
      if (json.failed)  parts.push(`失敗 ${json.failed} 筆`);
      // RC-1 修正：顯示日期範圍提示，備份訂單 created_at 為舊日期，預設 today 查不到
      let dateHint = '';
      if (json.date_range && json.date_range.min && json.added > 0) {
        const dr = json.date_range;
        dateHint = `<div style="margin-top:8px;padding:8px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.3);border-radius:6px;font-size:12px;color:#93c5fd">
          ℹ️ 匯入的訂單日期範圍：${escHtml(dr.min)} ～ ${escHtml(dr.max)}<br>
          訂單紀錄頁預設只顯示今日，請切換至「自訂」日期範圍查看匯入的訂單。
        </div>`;
      }
      result.style.background = json.failed > 0 ? 'rgba(251,191,36,.1)' : 'rgba(34,197,94,.1)';
      result.style.color      = json.failed > 0 ? '#fbbf24' : '#4ade80';
      result.innerHTML = `✅ 匯入完成：${parts.join('、')}` + dateHint +
        (json.errors && json.errors.length ? `<br><small style="color:#f87171">${json.errors.slice(0,3).map(e=>escHtml(e)).join('<br>')}</small>` : '');
      showToast('訂單匯入完成', 'success');
    } else {
      result.style.background = 'rgba(239,68,68,.1)';
      result.style.color      = '#f87171';
      result.innerHTML = `❌ 匯入失敗：${escHtml(json.message || '')}`;
      showToast('匯入失敗', 'error');
    }
  } catch(e) {
    result.style.display = 'block';
    result.style.background = 'rgba(239,68,68,.1)';
    result.style.color      = '#f87171';
    result.innerHTML = `❌ ${escHtml(e.message)}`;
    showToast('匯入失敗', 'error');
  }
  btn.disabled = false; btn.textContent = '✅ 確認匯入';
}

// ═══════════════════════════════════════════════════════════════════════════
//  C. LINE預購匯出
// ═══════════════════════════════════════════════════════════════════════════
function openPreorderExportModal() {
  showModal18('preorderExportModal');
}
function closePreorderExportModal() { hideModal18('preorderExportModal'); }

async function doPreorderExport() {
  const format = document.getElementById('preorderExportFormat').value;
  const dFrom  = document.getElementById('preorderExportFrom').value;
  const dTo    = document.getElementById('preorderExportTo').value;
  let url      = `/api/export/preorders?format=${format}`;
  if (dFrom && dTo) url += `&date_from=${dFrom}&date_to=${dTo}`;

  try {
    const res = await apiFetch(url);
    if (!res.ok) { showToast('匯出失敗', 'error'); return; }
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    const m    = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1] : `preorders_export.${format}`;
    downloadBlob(blob, name);
    closePreorderExportModal();
    showToast('預購匯出成功', 'success');
  } catch(e) { showToast('匯出失敗：' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  D. LINE預購匯入
// ═══════════════════════════════════════════════════════════════════════════
let _preorderImportData = null;

function openPreorderImportModal() {
  _preorderImportData = null;
  const fi = document.getElementById('preorderImportFile');
  if (fi) fi.value = '';
  document.getElementById('preorderImportPreview').style.display  = 'none';
  document.getElementById('preorderImportResult').style.display   = 'none';
  document.getElementById('preorderImportSubmitBtn').style.display = 'none';
  showModal18('preorderImportModal');
}
function closePreorderImportModal() { hideModal18('preorderImportModal'); }

async function onPreorderImportFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById('preorderImportPreview');
  const submit  = document.getElementById('preorderImportSubmitBtn');
  preview.style.display = 'none';
  submit.style.display  = 'none';
  _preorderImportData = null;

  try {
    const json = await readJsonFile(file);
    let preorders = [];
    if (Array.isArray(json)) {
      preorders = json;
    } else if (json.data && Array.isArray(json.data.preorders)) {
      preorders = json.data.preorders;
    } else if (Array.isArray(json.preorders)) {
      preorders = json.preorders;
    } else {
      preview.style.display = 'block';
      preview.innerHTML = '<span style="color:#f87171">❌ 無法識別的 JSON 格式</span>';
      return;
    }
    _preorderImportData = { preorders };
    preview.style.display = 'block';
    preview.innerHTML = `<div style="color:var(--accent,#3b82f6);font-weight:700;margin-bottom:6px">📋 檔案預覽</div>
      <div>LINE 預購：<strong>${preorders.length}</strong> 筆</div>`;
    submit.style.display = '';
  } catch(e) {
    preview.style.display = 'block';
    preview.innerHTML = `<span style="color:#f87171">❌ ${escHtml(e.message)}</span>`;
  }
}

async function doPreorderImport() {
  if (!_preorderImportData) return;
  const mode   = document.getElementById('preorderImportMode').value;
  const btn    = document.getElementById('preorderImportSubmitBtn');
  const result = document.getElementById('preorderImportResult');
  btn.disabled = true; btn.textContent = '匯入中…';
  result.style.display = 'none';

  try {
    const res  = await apiFetch('/api/import/preorders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(_preorderImportData), mode })
    });
    const json = await res.json();
    result.style.display = 'block';
    if (json.success) {
      const parts = [];
      if (json.added)   parts.push(`新增 ${json.added} 筆`);
      if (json.updated) parts.push(`更新 ${json.updated} 筆`);
      if (json.skipped) parts.push(`跳過 ${json.skipped} 筆`);
      if (json.failed)  parts.push(`失敗 ${json.failed} 筆`);
      result.style.background = 'rgba(34,197,94,.1)';
      result.style.color      = '#4ade80';
      result.innerHTML = `✅ 匯入完成：${parts.join('、')}`;
      showToast('預購匯入完成', 'success');
    } else {
      result.style.background = 'rgba(239,68,68,.1)';
      result.style.color      = '#f87171';
      result.innerHTML = `❌ 匯入失敗：${escHtml(json.message || '')}`;
      showToast('匯入失敗', 'error');
    }
  } catch(e) {
    result.style.display = 'block';
    result.style.background = 'rgba(239,68,68,.1)';
    result.style.color      = '#f87171';
    result.innerHTML = `❌ ${escHtml(e.message)}`;
    showToast('匯入失敗', 'error');
  }
  btn.disabled = false; btn.textContent = '✅ 確認匯入';
}

// ═══════════════════════════════════════════════════════════════════════════
//  E. 快速搬家檔 — 系統設定頁
// ═══════════════════════════════════════════════════════════════════════════

// ── E-1. 匯出搬家檔 ──────────────────────────────────────────────────────
async function exportMigrationFile() {
  const statusEl = document.getElementById('migrationExportStatus');
  if (statusEl) { statusEl.style.color = 'var(--text-secondary,#94a3b8)'; statusEl.textContent = '準備匯出…'; }
  try {
    const res = await apiFetch('/api/migration/export');
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd   = res.headers.get('content-disposition') || '';
    const m    = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1] : 'pos_migration.json';
    downloadBlob(blob, name);
    if (statusEl) { statusEl.style.color = '#4ade80'; statusEl.textContent = `✅ 已下載：${name}`; }
    showToast('搬家檔匯出成功', 'success');
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = `❌ 匯出失敗：${e.message}`; }
    showToast('匯出失敗：' + e.message, 'error');
  }
}

// ── E-2. 選擇搬家檔（fix18-10-hotfix1：修正跨店保護邏輯）─────────────────
let _migrationPayload      = null;
let _migrationPreviewData  = null;
let _migrationCrossAllowed = false;   // 使用者明確勾選跨店才變 true

async function onMigrationFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _migrationPayload      = null;
  _migrationPreviewData  = null;
  _migrationCrossAllowed = false;

  const previewBox  = document.getElementById('migrationPreviewBox');
  const previewSum  = document.getElementById('migrationPreviewSummary');
  const crossWarn   = document.getElementById('migrationCrossStoreWarn');
  const modeBox     = document.getElementById('migrationModeBox');
  const previewBtn  = document.getElementById('migrationPreviewBtn');
  const importBtn   = document.getElementById('migrationImportBtn');
  const statusEl    = document.getElementById('migrationImportStatus');

  previewBox.style.display = 'none';
  modeBox.style.display    = 'none';
  if (previewBtn)  previewBtn.style.display  = 'none';
  if (importBtn)   importBtn.style.display   = 'none';
  if (statusEl)    statusEl.textContent      = '';

  try {
    const json = await readJsonFile(file);
    if (!json || json.type !== 'pos_migration_backup') {
      previewBox.style.display = 'block';
      previewSum.innerHTML     = '<span style="color:#f87171">❌ 不是有效的搬家檔（type 欄位不符）</span>';
      crossWarn.style.display  = 'none';
      return;
    }
    _migrationPayload = json;

    // 呼叫 preview API 取得筆數統計
    const res  = await apiFetch('/api/migration/import/preview', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(json)
    });
    const prev = await res.json();
    if (!prev.success) throw new Error(prev.message || 'preview 失敗');
    _migrationPreviewData = prev;

    const s = prev.summary;
    previewSum.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:13px">
        <div>商品：<strong>${s.products}</strong> 筆</div>
        <div>分類：<strong>${s.categories}</strong> 筆</div>
        <div>訂單：<strong>${s.orders}</strong> 筆</div>
        <div>LINE預購：<strong>${s.preorders}</strong> 筆</div>
        <div>食材：<strong>${s.ingredients||0}</strong> 筆</div>
        <div>商品扣料公式：<strong>${s.product_ingredient_formulas||0}</strong> 筆</div>
        <div>食材異動紀錄：<strong>${s.ingredient_logs||0}</strong> 筆</div>
        <div>庫存變動紀錄：<strong>${s.inventory_logs||0}</strong> 筆</div>
        <div>折扣分類：<strong>${s.discount_categories}</strong> 筆</div>
        <div>折扣活動：<strong>${s.discount_campaigns}</strong> 筆</div>
        <div>分析群組：<strong>${s.product_analysis_groups}</strong> 筆</div>
        <div>群組成員：<strong>${s.product_analysis_group_items}</strong> 筆</div>
        <div>歷史別名：<strong>${s.product_analysis_group_aliases}</strong> 筆</div>
        <div>設定：<strong>${s.settings}</strong> 筆</div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--text-muted,#64748b)">
        備份店家：${escHtml(prev.store_name || prev.file_store_id || '—')} ／
        版本：${escHtml(prev.version||'—')} ／
        匯出時間：${escHtml((prev.exported_at||'').slice(0,19).replace('T',' '))}
      </div>`;

    // 跨店警告：顯示勾選框，預設不允許
    if (prev.cross_store) {
      crossWarn.style.display = 'block';
      crossWarn.innerHTML = `
        <div style="margin-bottom:8px">⚠️ 備份檔屬於店家 <strong>${escHtml(prev.file_store_id)}</strong>，
        目前店家是 <strong>${escHtml(prev.current_store_id)}</strong>。</div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#fca5a5">
          <input type="checkbox" id="migrationCrossStoreCheck" onchange="onCrossStoreCheckChanged(this)">
          我確認要跨店匯入（備份資料將寫入目前店家）
        </label>`;
      _migrationCrossAllowed = false;   // 重置，等使用者勾選
      if (importBtn) importBtn.style.display = 'none';  // 跨店時先隱藏匯入鈕
    } else {
      crossWarn.style.display = 'none';
      _migrationCrossAllowed = false;   // 同店，不需要特別旗標
    }

    previewBox.style.display = 'block';
    modeBox.style.display    = 'block';
    if (previewBtn) previewBtn.style.display = '';

    // 同店才直接顯示匯入鈕；跨店需等勾選
    if (!prev.cross_store) {
      if (importBtn) importBtn.style.display = '';
    }

  } catch(e) {
    previewBox.style.display = 'block';
    previewSum.innerHTML     = `<span style="color:#f87171">❌ ${escHtml(e.message)}</span>`;
    crossWarn.style.display  = 'none';
  }
}

// 跨店勾選變更
function onCrossStoreCheckChanged(checkbox) {
  _migrationCrossAllowed = checkbox.checked;
  const importBtn = document.getElementById('migrationImportBtn');
  if (importBtn) {
    importBtn.style.display = checkbox.checked ? '' : 'none';
  }
}

// ── E-3. 預覽（scroll to）─────────────────────────────────────────────
async function previewMigrationFile() {
  const el = document.getElementById('migrationPreviewBox');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── E-4. 確認匯入入口 ─────────────────────────────────────────────────
function confirmMigrationImport() {
  if (!_migrationPayload) { showToast('請先選擇備份檔', 'error'); return; }

  // 跨店：必須勾選才能繼續
  if (_migrationPreviewData && _migrationPreviewData.cross_store && !_migrationCrossAllowed) {
    showToast('跨店匯入：請先勾選確認跨店', 'error');
    return;
  }

  const mode = document.querySelector('input[name="migrationMode"]:checked')?.value || 'skip';
  if (mode === 'purge') {
    const inp = document.getElementById('migrationPurgeConfirmInput');
    if (inp) inp.value = '';
    showModal18('migrationPurgeConfirmModal');
  } else {
    executeMigrationImport();
  }
}

// ── E-5. 關閉二次確認 Modal ───────────────────────────────────────────
function closeMigrationPurgeConfirm() { hideModal18('migrationPurgeConfirmModal'); }

// ── E-6. 實際執行匯入（fix18-10-hotfix1：正確傳 allowCrossStoreImport）──
async function executeMigrationImport() {
  const mode = document.querySelector('input[name="migrationMode"]:checked')?.value || 'skip';

  // 清空模式二次確認
  if (mode === 'purge') {
    const val = (document.getElementById('migrationPurgeConfirmInput')?.value || '').trim();
    if (val !== '確認還原') {
      showToast('請輸入「確認還原」才能繼續', 'error');
      return;
    }
    closeMigrationPurgeConfirm();
  }

  const statusEl  = document.getElementById('migrationImportStatus');
  const importBtn = document.getElementById('migrationImportBtn');
  if (statusEl)  { statusEl.style.color = 'var(--text-secondary,#94a3b8)'; statusEl.textContent = '匯入中，請勿關閉頁面…'; }
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = '匯入中…'; }

  // 跨店：只有使用者明確勾選後 _migrationCrossAllowed 才是 true
  // cross_store=true ≠ allowCrossStoreImport=true，不再混用
  const isCrossStore    = _migrationPreviewData ? _migrationPreviewData.cross_store : false;
  const allowCrossStore = isCrossStore ? _migrationCrossAllowed : false;

  try {
    const res = await apiFetch('/api/migration/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        payload:               _migrationPayload,
        mode:                  mode === 'purge' ? 'replace' : mode,
        allowCrossStoreImport: allowCrossStore
      })
    });
    const json = await res.json();

    if (json.success) {
      const r = json.results || {};
      const lines = [
        `商品：${r.products?.added||0}`,
        `分類：${r.categories?.added||0}`,
        `訂單：${r.orders?.added||0}`,
        `食材：${r.ingredients?.added||0}`,
        `扣料公式：${r.product_ingredient_formulas?.added||0}`,
        `折扣分類：${r.discount_categories?.added||0}`,
        `折扣活動：${r.discount_campaigns?.added||0}`,
        `分析群組：${r.analysis_groups?.added||0}`,
        `群組成員：${r.analysis_items?.added||0}`,
        `歷史別名：${r.analysis_aliases?.added||0}`,
        `設定：${r.settings?.added||0}`
      ].join('、') + ' 筆';
      const skipFail = r.failed > 0 ? `｜失敗 ${r.failed} 筆` : '';
      if (statusEl) {
        statusEl.style.color = r.failed > 0 ? '#fbbf24' : '#4ade80';
        statusEl.innerHTML =
          `✅ 匯入完成（模式：${mode}）${skipFail}<br>` +
          `<small style="color:var(--text-muted,#64748b)">${lines}</small>` +
          (r.errors && r.errors.length
            ? `<br><small style="color:#f87171">錯誤：${r.errors.slice(0,3).map(e=>escHtml(e)).join(' / ')}</small>`
            : '');
      }
      showToast('搬家檔匯入完成', 'success');

    } else if (json.cross_store) {
      // 後端拒絕跨店
      if (statusEl) {
        statusEl.style.color = '#f87171';
        statusEl.textContent = `❌ 跨店匯入被拒：${json.message}`;
      }
      showToast('跨店匯入被拒，請勾選確認跨店', 'error');

    } else {
      if (statusEl) {
        statusEl.style.color = '#f87171';
        statusEl.textContent = `❌ 匯入失敗：${json.message}`;
      }
      showToast('匯入失敗：' + json.message, 'error');
    }

  } catch(e) {
    if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = `❌ ${e.message}`; }
    showToast('匯入失敗：' + e.message, 'error');
  }

  if (importBtn) { importBtn.disabled = false; importBtn.textContent = '✅ 確認匯入'; }
}

// ── 全域匯出（fix18-10-hotfix1）──────────────────────────────────────
(function exportMigration18Globals() {
  const fns = {
    openOrderExportModal, closeOrderExportModal, doOrderExport,
    openOrderImportModal, closeOrderImportModal, onOrderImportFileSelected, doOrderImport,
    openPreorderExportModal, closePreorderExportModal, doPreorderExport,
    openPreorderImportModal, closePreorderImportModal, onPreorderImportFileSelected, doPreorderImport,
    exportMigrationFile, onMigrationFileSelected, previewMigrationFile,
    confirmMigrationImport, closeMigrationPurgeConfirm, executeMigrationImport,
    onCrossStoreCheckChanged
  };
  Object.assign(window, fns);
})();

// fix18-10-hotfix1 end
