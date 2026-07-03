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
  AIMC.api = async function (path, { method = 'GET', body } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = AIMC.API_BASE + path + sep + 'store_id=' + encodeURIComponent(AIMC.storeId);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error || ('HTTP ' + res.status));
    }
    return data;
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

  AIMC.nextStepHint = function (insight) {
    if (!insight.topics.length) return '建議建立主題';
    if (!insight.promptCount) return '建議建立 Prompt';
    if (!insight.genCount) return '建議產生內容';
    if (insight.pendingCount) return '有內容待審核';
    return '可持續優化或建立新主題';
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
})();
