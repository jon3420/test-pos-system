// ============================================================
// shared.js — AI Marketing Center 共用元件庫
// 提供：API 呼叫、格式化工具、Toast、Drawer、Stat Card 等，
// 避免每個 page.js 重複實作。不呼叫任何新端點，API 路徑與
// Phase 1 / Phase 1.5 完全相同（/api/ai-marketing/*）。
// ============================================================
window.AIMC = window.AIMC || { pages: {} };

(function () {
  const params = new URLSearchParams(location.search);
  AIMC.storeId = params.get('store_id') || '';
  AIMC.API_BASE = '/api/ai-marketing';

  // ── API 呼叫（沿用既有 requireStore：query.store_id 相容模式）──
  // Part 3：新增可選的 signal 參數，供 Phase 2 直接啟用 AbortController 取消機制。
  // 沒有傳入 signal 時（本次所有頁面都還是沒有傳），行為與過去完全相同、零改變。
  AIMC.api = async function (path, { method = 'GET', body, signal } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = AIMC.API_BASE + path + sep + 'store_id=' + encodeURIComponent(AIMC.storeId);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      ...(signal ? { signal } : {}),
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error || ('HTTP ' + res.status));
    }
    return data;
  };

  // ── Hotfix16：POS API 呼叫（同源直連 /api/products，不經過 AIMC 代理）──
  // AIMC 服務本身沒有 POS 商品資料庫的直接存取權，「選擇 POS 商品」下拉、
  // 「所有 POS 商品都要出現在 Health Card」都需要直接讀 POS 既有的
  // GET /api/products（沿用既有 requireStore，接受 query.store_id，不新增任何 POS API，
  // 也絕對不會寫入/修改 POS 商品資料——這裡只有 GET）。
  AIMC.posApi = async function (path, { method = 'GET' } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = path + sep + 'store_id=' + encodeURIComponent(AIMC.storeId);
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' } });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || data.success === false) {
      throw new Error(data.message || ('HTTP ' + res.status));
    }
    return data;
  };

  // 統一把 POS products 表欄位映射成 AIMC 慣用命名（id → external_product_id 字串化），
  // 不修改 POS 回傳的原始物件，只是包一層方便前端使用。
  AIMC.normalizePosProduct = function (p) {
    return {
      external_product_id: String(p.id),
      product_name: p.name,
      category_name: p.category || '',
      price: Number(p.dine_in_price || p.price || 0),
      product_image_url: p.image || p.line_image_url || '',
      active: !!p.enabled,
      _raw: p,
    };
  };

  AIMC.loadPosProducts = async function () {
    const { data } = await AIMC.posApi('/api/products');
    const list = (data || []).map(AIMC.normalizePosProduct);
    AIMC.store.posProducts = list;
    return list;
  };

  // ── 格式化工具 ──
  AIMC.esc = (s) => (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  AIMC.fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '');
  AIMC.isToday = (t) => {
    if (!t) return false;
    const d = new Date(t), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };

  const PLATFORM_LABELS = {
    fb: 'Facebook', ig: 'Instagram', threads: 'Threads', tiktok: 'TikTok',
    line: 'LINE OA', google_business: 'Google 商家', youtube_shorts: 'YouTube Shorts',
  };
  AIMC.platformLabel = (p) => PLATFORM_LABELS[p] || p;
  AIMC.PLATFORM_LABELS = PLATFORM_LABELS;

  // ── Toast ──
  AIMC.toast = function (msg, isError) {
    let t = document.getElementById('aimc-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'aimc-toast';
      t.className = 'aimc-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'aimc-toast show' + (isError ? ' error' : '');
    clearTimeout(AIMC._toastTimer);
    AIMC._toastTimer = setTimeout(() => { t.className = 'aimc-toast'; }, 2600);
  };

  // ── 小型 UI builder（回傳 HTML 字串，各頁共用）──
  AIMC.statCard = (icon, value, label, variant) =>
    `<div class="stat-card ${variant || ''}"><div class="stat-icon">${icon}</div><div class="stat-value">${AIMC.esc(value)}</div><div class="stat-label">${AIMC.esc(label)}</div></div>`;

  AIMC.badge = (text, cls) => `<span class="badge ${cls || ''}">${AIMC.esc(text)}</span>`;

  AIMC.progressBar = (pct) => `<div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>`;

  AIMC.miniBar = (pct) => `<span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct}%"></span></span>${pct}%`;

  AIMC.emptyState = (icon, text) => `<div class="empty"><span class="big-icon">${icon}</span>${AIMC.esc(text)}</div>`;

  AIMC.loadingHtml = (text) => `<div class="empty">${AIMC.esc(text || '載入中...')}</div>`;

  // ── Drawer（右側滑出面板，用於 Knowledge 編輯等）──
  function ensureDrawer() {
    let d = document.getElementById('aimc-drawer');
    if (!d) {
      d = document.createElement('div');
      d.id = 'aimc-drawer';
      d.className = 'aimc-drawer-overlay';
      d.innerHTML = `<div class="aimc-drawer">
          <div class="aimc-drawer-head">
            <div class="aimc-drawer-title"></div>
            <button class="aimc-drawer-close" type="button">✕</button>
          </div>
          <div class="aimc-drawer-body"></div>
        </div>`;
      document.body.appendChild(d);
      d.addEventListener('click', (e) => { if (e.target === d) AIMC.closeDrawer(); });
      d.querySelector('.aimc-drawer-close').addEventListener('click', () => AIMC.closeDrawer());
    }
    return d;
  }
  AIMC.openDrawer = function (titleHtml, bodyHtml) {
    const d = ensureDrawer();
    d.querySelector('.aimc-drawer-title').innerHTML = titleHtml;
    d.querySelector('.aimc-drawer-body').innerHTML = bodyHtml;
    d.classList.add('open');
    return d.querySelector('.aimc-drawer-body');
  };
  AIMC.closeDrawer = function () {
    const d = document.getElementById('aimc-drawer');
    if (d) d.classList.remove('open');
  };

  // ── 商品知識完成度計算（跨頁共用：Dashboard / Knowledge 都會用到）──
  AIMC.COMPLETENESS_FIELDS = ['intro', 'features', 'story', 'ingredient_intro', 'technique', 'storage_method',
    'faq', 'myths', 'pairing', 'nutrition', 'brand_philosophy', 'keywords', 'hashtags', 'seo_description'];

  AIMC.calcCompleteness = function (detail) {
    if (!detail) return 0;
    let filled = 0;
    AIMC.COMPLETENESS_FIELDS.forEach((f) => {
      const v = detail[f];
      if (Array.isArray(v)) { if (v.length) filled++; }
      else if (v && String(v).trim()) filled++;
    });
    return Math.round((filled / AIMC.COMPLETENESS_FIELDS.length) * 100);
  };

  // ── 跨頁共用資料快取（各頁 load() 時可視需要重新 fetch 覆蓋）──
  AIMC.store = {
    knowledge: [],
    topics: [],
    prompts: [],
    history: [],
    reviewCounts: { generated: 0, approved: 0, rejected: 0 },
    knowledgeDetail: {},
    posProducts: [], // Hotfix16：全部 POS 商品（含尚未建立知識的），供一鍵初始化 / Health Card 全商品顯示使用
    topicsByProduct: {}, // Hotfix17：external_product_id -> topics[]，主題頁「商品獨立歸類」的權威快取
  };

  AIMC.loadCoreData = async function () {
    const [k, t, p, h] = await Promise.all([
      AIMC.api('/knowledge'), AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
    ]);
    AIMC.store.knowledge = k.data || [];
    AIMC.store.topics = t.data || [];
    AIMC.store.prompts = p.data || [];
    AIMC.store.history = h.data || [];
    return AIMC.store;
  };

  AIMC.loadKnowledgeDetails = async function () {
    const details = await Promise.all(
      AIMC.store.knowledge.map((row) => AIMC.api('/knowledge/' + row.id).then((r) => r.data).catch(() => null))
    );
    AIMC.store.knowledgeDetail = {};
    AIMC.store.knowledge.forEach((row, i) => { AIMC.store.knowledgeDetail[row.id] = details[i]; });
    return AIMC.store.knowledgeDetail;
  };

  AIMC.loadReviewCounts = async function () {
    const [g, a, r] = await Promise.all([
      AIMC.api('/review?status=generated'), AIMC.api('/review?status=approved'), AIMC.api('/review?status=rejected'),
    ]);
    AIMC.store.reviewCounts = {
      generated: (g.data || []).length,
      approved: (a.data || []).length,
      rejected: (r.data || []).length,
    };
    return { g: g.data || [], a: a.data || [], r: r.data || [] };
  };

  AIMC.buildDerivedMaps = function () {
    const topicsByProduct = {};
    AIMC.store.topics.forEach((t) => { (topicsByProduct[t.external_product_id] ||= []).push(t); });
    const promptsByTopic = {};
    AIMC.store.prompts.forEach((p) => { const key = p.topic_id || '__general__'; (promptsByTopic[key] ||= []).push(p); });
    const historyByTopic = {};
    AIMC.store.history.forEach((h) => { const key = h.topic_id || '__none__'; (historyByTopic[key] ||= []).push(h); });
    return { topicsByProduct, promptsByTopic, historyByTopic };
  };

  // ── V3：商品洞察（Dashboard AI 任務/建議、Knowledge 健康卡共用）──
  // 純粹用 AIMC.store 現有資料（knowledge / topics / prompts / history）做前端規則推導，
  // 不呼叫任何新端點，也不做任何伺服器端計算。
  AIMC.computeProductInsights = function () {
    const s = AIMC.store;
    const { topicsByProduct, promptsByTopic, historyByTopic } = AIMC.buildDerivedMaps();
    return s.knowledge.map((row) => {
      const detail = s.knowledgeDetail[row.id] || {};
      const pct = AIMC.calcCompleteness(detail);
      const topics = topicsByProduct[row.external_product_id] || [];
      const topicIds = topics.map((t) => t.id);
      const relatedPrompts = topicIds.flatMap((tid) => promptsByTopic[tid] || []);
      const genList = topicIds.flatMap((tid) => historyByTopic[tid] || []);
      const pendingCount = genList.filter((h) => h.status === 'generated').length;
      const approvedCount = genList.filter((h) => h.status === 'approved').length;
      const platforms = [...new Set(relatedPrompts.map((p) => p.platform))];
      const missing = [];
      if (!detail.faq || !String(detail.faq).trim()) missing.push('FAQ');
      if (!detail.myths || !String(detail.myths).trim()) missing.push('迷思');
      if (!detail.seo_description || !String(detail.seo_description).trim()) missing.push('SEO');
      const sensitiveCount = topics.filter((t) => t.claim_sensitive).length;
      return {
        row, detail, pct, topics, promptCount: relatedPrompts.length,
        genCount: genList.length, pendingCount, approvedCount, platforms, missing, sensitiveCount,
      };
    });
  };

  // ── Hotfix16 Part 3：所有 POS 商品都要出現在 Health Card（含尚未建立知識的）──
  // 在既有 computeProductInsights() 的基礎上，補上「有 POS 商品、但還沒有 Knowledge」
  // 的項目，標記 uninitialized:true，UI 據此顯示「尚未初始化 / 0% / 建立商品知識」。
  // 不需要 AIMC.store.posProducts 事先載入好（呼叫端的 refresh() 需自行呼叫過
  // AIMC.loadPosProducts()），這裡純粹做合併，不發任何請求。
  AIMC.computeAllProductInsights = function () {
    const withKnowledge = AIMC.computeProductInsights();
    const knownIds = new Set(withKnowledge.map((ins) => ins.row.external_product_id));
    const uninitialized = (AIMC.store.posProducts || [])
      .filter((p) => !knownIds.has(p.external_product_id))
      .map((p) => ({
        row: { id: null, external_product_id: p.external_product_id, product_name: p.product_name },
        detail: {}, pct: 0, topics: [], promptCount: 0, genCount: 0, pendingCount: 0,
        approvedCount: 0, platforms: [], missing: [], sensitiveCount: 0,
        uninitialized: true, posProduct: p,
      }));
    return [...withKnowledge, ...uninitialized];
  };

  AIMC.nextStepHint = function (insight) {
    if (insight.uninitialized) return '立即建立商品知識';
    // Hotfix17：與 Knowledge 健康卡的動態 CTA 共用同一套判斷（AIMC.Workflow.productStepCta），
    // 避免「上面建議產生內容、下面按鈕卻是建主題」這種不一致。
    return AIMC.Workflow.productStepCta(insight).hint;
  };

  // 綜合分數：知識完整 + Topic 多 + Prompt 多 + Generated 多 + 待審核少 → 分數越高越適合主推
  AIMC.recommendScore = function (insight) {
    return insight.pct * 0.4 + insight.topics.length * 6 + insight.promptCount * 5
      + insight.genCount * 4 - insight.pendingCount * 3;
  };

  // ── 複製到剪貼簿（Review 使用）──
  AIMC.copyToClipboard = async function (text) {
    try {
      await navigator.clipboard.writeText(text || '');
      AIMC.toast('已複製內容');
    } catch (e) {
      AIMC.toast('複製失敗，請手動選取文字複製', true);
    }
  };

  // ============================================================
  // V3.1 Stability Pass
  // ============================================================

  // ── Part 1：Shared Safe DOM Library ──────────────────────────
  // 所有方法找不到元素時「不 throw、不 crash」，只 console.warn 並安全跳過，
  // 用來取代各頁面原本各自手寫的 null guard（例如 Dashboard 舊版的 q()/setHTML()）。
  AIMC.DOM = (function () {
    function warn(label, selector, action) {
      console.warn(`[AIMC] ${label || 'page'} missing ${selector} — skip ${action || 'render'}`);
    }
    function safeQuery(root, selector, label) {
      if (!root) { warn(label, selector, 'query (root 不存在)'); return null; }
      const el = root.querySelector(selector);
      if (!el) warn(label, selector, 'query');
      return el;
    }
    function safeHTML(root, selector, html, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.innerHTML = html;
      return el;
    }
    function safeText(root, selector, text, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.textContent = text;
      return el;
    }
    function safeAppend(root, selector, node, label) {
      const el = safeQuery(root, selector, label);
      if (el && node) el.appendChild(node);
      return el;
    }
    function safeWidth(root, selector, width, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.style.width = width;
      return el;
    }
    function safeShow(root, selector, display, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.style.display = display || '';
      return el;
    }
    function safeHide(root, selector, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.style.display = 'none';
      return el;
    }
    function safeRemove(root, selector, label) {
      const el = safeQuery(root, selector, label);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return el;
    }
    function safeClass(root, selector, className, force, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.classList.toggle(className, force);
      return el;
    }
    // 取值：safeValue(root, sel)         → 回傳 value（找不到回傳 ''）
    // 設值：safeValue(root, sel, value)  → 設定 value
    function safeValue(root, selector, value, label) {
      const el = safeQuery(root, selector, label);
      if (!el) return value === undefined ? '' : undefined;
      if (value === undefined) return el.value;
      el.value = value;
      return el;
    }
    function safeOn(root, selector, event, handler, label) {
      const el = safeQuery(root, selector, label);
      if (el) el.addEventListener(event, handler);
      return el;
    }

    // 頁面綁定版本：每個方法自動帶入 label（頁面名稱），減少重複打字，
    // 同時讓 console.warn 訊息自動標示是哪一頁（例如 "[AIMC] Dashboard missing #dashStatGrid"）。
    function forPage(label) {
      return {
        query: (root, selector) => safeQuery(root, selector, label),
        html: (root, selector, html) => safeHTML(root, selector, html, label),
        text: (root, selector, text) => safeText(root, selector, text, label),
        append: (root, selector, node) => safeAppend(root, selector, node, label),
        width: (root, selector, width) => safeWidth(root, selector, width, label),
        show: (root, selector, display) => safeShow(root, selector, display, label),
        hide: (root, selector) => safeHide(root, selector, label),
        remove: (root, selector) => safeRemove(root, selector, label),
        class: (root, selector, className, force) => safeClass(root, selector, className, force, label),
        value: (root, selector, value) => safeValue(root, selector, value, label),
        on: (root, selector, event, handler) => safeOn(root, selector, event, handler, label),
      };
    }

    return {
      safeQuery, safeHTML, safeText, safeAppend, safeWidth,
      safeShow, safeHide, safeRemove, safeClass, safeValue, safeOn, forPage,
    };
  })();

  // ============================================================
  // Hotfix15 — Workspace Lifecycle & Stability Final
  // 在 V3.1 的基礎上（AIMC.DOM / Page Token / startLifecycle）補齊：
  //   Part 1 完整生命週期狀態機（Created→Loading→Active→Leaving→Destroyed）
  //   Part 2 Page Token 新命名 API（getPageToken/isCurrentToken）
  //   Part 3 AbortController 正式啟用（AIMC.api 預設帶入目前 signal）
  //   Part 4 Safe DOM 補齊 replace/classAdd/classRemove
  //   Part 7 Event Listener 集中管理（forPage 內建 registry，destroy() 一次清空）
  //   Part 8 Memory Leak 追蹤（AIMC.Debug：listeners/pendingRequests/renderCount）
  //   Part 9 Render Queue（同一個 label 連續呼叫，只有最後一次會真正 render）
  // 全部只讀取/呼叫既有 API 端點，未新增、未修改任何伺服器邏輯。
  // ============================================================

  // ── Part 1：Workspace Page Lifecycle 狀態機 ───────────────────
  // Created(頁面片段HTML剛插入) → Loading(load()執行中) → Active(load()完成，可互動)
  // → Leaving(使用者切到別頁，開始清理) → Destroyed(destroy()執行完畢)
  AIMC.PAGE_STATES = ['created', 'loading', 'active', 'leaving', 'destroyed'];
  AIMC._pageState = 'destroyed';
  AIMC._currentPageLabel = null;
  AIMC.getPageState = function () { return AIMC._pageState; };
  AIMC.setPageState = function (state, label) {
    AIMC._pageState = state;
    if (label) AIMC._currentPageLabel = label;
    console.info(`[AIMC lifecycle] ${AIMC._currentPageLabel || '(none)'} → ${state}`);
  };

  // ── Part 2：Page Token（新命名 API，向下相容既有 AIMC.pageToken 數字）──
  AIMC.pageToken = 0;
  AIMC.getPageToken = function () { return AIMC.pageToken; };
  AIMC.isCurrentToken = function (token) { return token === AIMC.pageToken; };

  // ── Part 8：Memory Leak 追蹤用統計（供 AIMC.Debug 顯示；listeners 數改由
  // registry 即時加總，這裡只保留真的需要累加/遞減的計數器）──
  AIMC._stats = { timers: 0, pendingRequests: 0, renderCount: 0, abortCount: 0 };

  // ── Part 6/7：目前頁面的銷毀函式（由 router.js 在切頁前呼叫）──
  AIMC._currentDestroy = null;
  AIMC.setCurrentPageDestroy = function (fn) { AIMC._currentDestroy = typeof fn === 'function' ? fn : null; };
  AIMC.destroyCurrentPage = function () {
    if (AIMC._currentDestroy) {
      AIMC.setPageState('leaving');
      try { AIMC._currentDestroy(); } catch (e) { console.warn('[AIMC] destroy() 執行時發生錯誤（已忽略，不影響切頁）：', e.message); }
      AIMC.setPageState('destroyed');
    }
    AIMC._currentDestroy = null;
  };

  AIMC.isAbortError = function (e) {
    return !!e && (e.name === 'AbortError' || e.code === 20 || /aborted/i.test(String(e.message || '')));
  };

  // ── Part 5：Router 每次切頁呼叫 —— token++、abort 上一頁所有請求、
  // 清掉所有「不是最新 token」的殘留 listener（Part 7/8：Memory Leak 防護）──
  AIMC.bumpPageToken = function () {
    AIMC.pageToken += 1;
    if (AIMC.currentAbortController) {
      try { AIMC.currentAbortController.abort(); AIMC._stats.abortCount += 1; } catch (e) { /* 已中止過，忽略 */ }
    }
    AIMC.currentAbortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

    // 不管有多少個「來不及被個別頁面 destroy() 清理」的舊 token，這裡一次全部掃掉。
    // 這是防止快速連續切頁造成 listener 無限累積的關鍵防線。
    if (AIMC._listenerRegistry) {
      Object.keys(AIMC._listenerRegistry).forEach((tokenKey) => {
        if (Number(tokenKey) === AIMC.pageToken) return; // 這是新頁面自己的 token，還沒開始註冊，保留
        const entries = AIMC._listenerRegistry[tokenKey];
        entries.forEach(({ el, event, handler }) => {
          try { el.removeEventListener(event, handler); } catch (e) { /* 元素可能已不存在，忽略 */ }
        });
        delete AIMC._listenerRegistry[tokenKey];
      });
    }
    return AIMC.pageToken;
  };

  // ── Part 3：AbortController 正式啟用 ──
  // 覆寫上面定義的 AIMC.api：預設自動帶入「目前頁面」的 AbortController signal，
  // 呼叫端完全不用改任何一行程式碼就自動享有「切頁自動取消請求」的效果。
  // 仍然可以在個別呼叫傳入 signal: null 明確跳過（目前沒有頁面這樣做）。
  // 同時在這裡追蹤 pendingRequests 供 AIMC.Debug 顯示（Part 8）。
  const _rawApi = AIMC.api;
  AIMC.api = async function (path, opts = {}) {
    const { method = 'GET', body, signal } = opts;
    // 只自動中止「讀取用」的 GET 請求（純粹是為了畫面渲染，切頁後結果沒有意義）。
    // POST/PUT/PATCH/DELETE 一律不自動中止 —— 這些代表使用者已經按下的動作
    // （儲存知識、建立主題、送出生成、核准/退回…），中途切頁也不該被取消，
    // 否則可能白白浪費一次 AI 生成成本、或讓使用者的儲存動作悄悄消失。
    // 呼叫端仍可用 signal 明確覆蓋這個預設值（目前沒有任何頁面這樣做）。
    const isMutating = String(method).toUpperCase() !== 'GET';
    const effectiveSignal = signal !== undefined
      ? signal
      : (isMutating ? undefined : (AIMC.currentAbortController && AIMC.currentAbortController.signal));
    AIMC._stats.pendingRequests += 1;
    try {
      return await _rawApi(path, { method, body, signal: effectiveSignal });
    } finally {
      AIMC._stats.pendingRequests -= 1;
    }
  };

  // ── Part 4：Safe DOM 補齊 replace / classAdd / classRemove ────
  (function extendDOM() {
    function safeReplace(root, selector, newNode, label) {
      const el = AIMC.DOM.safeQuery(root, selector, label);
      if (el && el.parentNode && newNode) el.parentNode.replaceChild(newNode, el);
      return el;
    }
    function safeClassAdd(root, selector, className, label) {
      const el = AIMC.DOM.safeQuery(root, selector, label);
      if (el) el.classList.add(className);
      return el;
    }
    function safeClassRemove(root, selector, className, label) {
      const el = AIMC.DOM.safeQuery(root, selector, label);
      if (el) el.classList.remove(className);
      return el;
    }
    AIMC.DOM.safeReplace = safeReplace;
    AIMC.DOM.safeClassAdd = safeClassAdd;
    AIMC.DOM.safeClassRemove = safeClassRemove;

    // Part 7/8：forPage() 內建 Event Listener registry，改用「以 token 為 key」的
    // 全域登記表（AIMC._listenerRegistry），而非只追蹤『最後一次』的 lifecycle。
    // 原因：若使用者快速連續切頁、中間有好幾個 renderRoute() 呼叫來不及被
    // destroy() 清理就被下一次呼叫覆蓋掉，只追蹤『目前這一個』會讓中間那些
    // 呼叫註冊的 listener 變成孤兒、永遠沒人移除，造成真正的記憶體洩漏
    // （1000 次快速切頁壓力測試證實了這一點）。
    // 修法：bumpPageToken() 每次都會把「不是最新 token」的所有登記，
    // 不論是否曾經被個別頁面呼叫過 destroy()，全部強制移除，
    // 保證 listener 數量的上限只跟『目前這一頁』有關，不會隨切頁次數累積。
    AIMC._listenerRegistry = {};

    const _origForPage = AIMC.DOM.forPage;
    AIMC.DOM.forPage = function (label) {
      const base = _origForPage(label);
      const token = AIMC.pageToken; // 建立當下的 token，之後這批 listener 都歸在這個 token 名下
      const registry = AIMC._listenerRegistry[token] || (AIMC._listenerRegistry[token] = []);
      base.replace = (root, selector, newNode) => safeReplace(root, selector, newNode, label);
      base.classAdd = (root, selector, className) => safeClassAdd(root, selector, className, label);
      base.classRemove = (root, selector, className) => safeClassRemove(root, selector, className, label);
      base.on = (root, selector, event, handler) => {
        const el = AIMC.DOM.safeQuery(root, selector, label);
        if (el) {
          el.addEventListener(event, handler);
          registry.push({ el, event, handler });
        }
        return el;
      };
      base._registry = registry;
      base.removeAllListeners = () => {
        registry.forEach(({ el, event, handler }) => {
          try { el.removeEventListener(event, handler); } catch (e) { /* 元素可能已不存在，忽略 */ }
        });
        registry.length = 0;
      };
      return base;
    };
  })();

  // ── Part 9：Render Queue —— 同一個 label 連續呼叫（例如連點兩次「重新整理」），
  // 只有「最後一次」呼叫在 await 之後還算數，較早的呼叫會在 checkpoint() 判定為過期並安全跳過。
  const _callSeq = {};

  // 供各頁 load()/refresh() 開頭呼叫，建立本次執行的生命週期物件：
  //   const lc = AIMC.startLifecycle('Dashboard');
  //   ...await 一些 API...
  //   if (!lc.checkpoint('API 完成')) return;
  //   lc.dom.html(root, '#xxx', html);
  //   lc.done();
  // 発生錯誤時：
  //   catch (e) { lc.fail(e, root, '#xxx'); }   // 會自動判斷 stale / AbortError / 真的失敗三種情況
  AIMC.startLifecycle = function (label) {
    const token = AIMC.pageToken;
    _callSeq[label] = (_callSeq[label] || 0) + 1;
    const mySeq = _callSeq[label];
    AIMC._stats.renderCount += 1;
    console.group(`[AIMC] ${label} load token=${token}`);
    return {
      token,
      label,
      mySeq,
      dom: AIMC.DOM.forPage(label),
      isStale() {
        return this.token !== AIMC.pageToken || this.mySeq !== _callSeq[label];
      },
      checkpoint(msg) {
        if (this.isStale()) {
          console.info(`[AIMC] ${label} render cancelled — token expired (was ${this.token}, now ${AIMC.pageToken})`);
          console.groupEnd();
          return false;
        }
        console.log(msg || 'token still valid');
        return true;
      },
      // 統一的錯誤處理：stale → 靜默跳過；AbortError（切頁自動取消）→ 靜默跳過；
      // 其餘才是真的失敗，才會顯示錯誤（寫進畫面或彈 toast）。
      fail(e, root, selector, msgPrefix) {
        if (this.isStale()) { console.groupEnd(); return; }
        if (AIMC.isAbortError(e)) {
          console.info(`[AIMC] ${label} request aborted（使用者已切頁，屬正常行為，非錯誤）`);
          console.groupEnd();
          return;
        }
        console.groupEnd();
        if (root && selector) {
          this.dom.html(root, selector, `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`);
        } else {
          AIMC.toast((msgPrefix || '操作失敗：') + e.message, true);
        }
      },
      done(msg) {
        console.log(msg || 'render complete');
        console.groupEnd();
      },
    };
  };

  // ── Part 8：Developer Debug ────────────────────────────────────
  AIMC.Debug = {
    getStats() {
      // listeners 即時從 registry 加總（而非累加/遞減計數器），
      // 保證這個數字永遠等於「當下實際還存在的 listener 數」，不會因為時序問題失準。
      const listeners = AIMC._listenerRegistry
        ? Object.values(AIMC._listenerRegistry).reduce((sum, arr) => sum + arr.length, 0)
        : 0;
      return {
        currentPage: AIMC._currentPageLabel,
        currentState: AIMC._pageState,
        currentToken: AIMC.pageToken,
        pendingRequests: AIMC._stats.pendingRequests,
        listeners,
        renderCount: AIMC._stats.renderCount,
        abortCount: AIMC._stats.abortCount,
        timers: AIMC._stats.timers,
      };
    },
  };
})();
