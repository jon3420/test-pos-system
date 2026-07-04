// ============================================================
// topics.js — Hotfix17：主題「商品獨立歸類」（Product-Scoped Master-Detail + Tabs）
//
// 目標：左側改成商品列表，右側只顯示「目前選取商品」的主題／Prompt 狀態／
// 生成內容／審核紀錄，不同商品之間資料不會混在一起。
//
// 不改既有 API：仍然是呼叫既有的 GET/POST/PATCH/DELETE /topics、
// GET /prompts、GET /content-history，只是查詢時一律帶 external_product_id
// 做篩選（既有端點本來就支援這個 query），前端另外用
// AIMC.store.topicsByProduct[externalProductId] 做快取，避免混資料。
//
// 支援路由參數 #/topics/<external_product_id>：自動選定該商品。
// ============================================================
(function () {
  let currentDom = null;
  let selectedProductId = null;
  let activeTab = 'overview';
  let searchQuery = '';
  let categoryFilter = '全部';
  let focusedTopicId = null; // 「檢視」按鈕點擊後，Prompt 狀態 tab 用來高亮對應主題

  // AI Topic Suggestions（沿用 Hotfix15 既有規則式建議，未改邏輯，只是改成從
  // selectedProductId 取商品名稱，而不是從 <select> 讀值）
  const SUGGESTION_MAP = [
    { match: '豬腰', items: [
      { kw: '補鐵', cat: '營養' }, { kw: '先燙後冰', cat: '工法' }, { kw: '膽固醇迷思', cat: '迷思' },
      { kw: '保存方式', cat: '知識' }, { kw: '厚切工法', cat: '工法' }, { kw: '去腥秘訣', cat: '工法' },
    ] },
    { match: '鴨賞', items: [
      { kw: '煙燻工法', cat: '工法' }, { kw: '宜蘭文化', cat: '文化' }, { kw: '冷盤吃法', cat: '促銷' }, { kw: '下酒菜推薦', cat: '促銷' },
    ] },
    { match: '鳳爪', items: [
      { kw: 'Q彈口感', cat: '知識' }, { kw: '膠質營養', cat: '營養' }, { kw: '下酒首選', cat: '促銷' },
    ] },
  ];
  const GENERIC_SUGGESTIONS = [
    { kw: '品牌故事', cat: '品牌' }, { kw: '營養知識', cat: '營養' }, { kw: '常見 FAQ', cat: 'FAQ' },
    { kw: '推薦搭配', cat: '促銷' }, { kw: '季節限定', cat: '節日' },
  ];
  function suggestionsForProduct(productName) {
    const hit = SUGGESTION_MAP.find((g) => productName && productName.includes(g.match));
    return hit ? hit.items : GENERIC_SUGGESTIONS;
  }

  // Prompt 狀態 tab 用的平台×目的矩陣設定（沿用 Hotfix16 Part 9 的組態）
  const TOPIC_MATRIX_CONFIG = {
    fb: ['教育', '品牌故事', 'FAQ', '促銷'],
    line: ['推播', '回購'],
  };
  const MATRIX_PLATFORMS = Object.keys(TOPIC_MATRIX_CONFIG); // ['fb','line']，用來算「Prompt X/4」的分母基準

  async function load(root, param) {
    const lc = AIMC.startLifecycle('Topics');
    currentDom = lc.dom;
    AIMC.store.topicsByProduct = AIMC.store.topicsByProduct || {};

    lc.dom.on(root, '#t_refreshBtn', 'click', () => refresh(root));
    lc.dom.on(root, '#t_search', 'input', (e) => { searchQuery = e.target.value.trim(); renderProductList(root, lc.dom); });
    lc.done('event bindings ready');

    await refresh(root, param);
  }

  // ── 一次載入全店的 knowledge/topics/prompts/history，前端再依商品切片 ──
  // （既有 API 沒有「一次只拿某商品」的列表端點以外的用途，所以左側清單統計
  // 仍需要全店資料；右側「選定商品」後才會另外呼叫 GET /topics?external_product_id=
  // 確保右側資料保證是該商品專屬、不會混到別的商品）
  async function refresh(root, presetProductId) {
    const lc = AIMC.startLifecycle('Topics:refresh');
    currentDom = lc.dom;
    lc.dom.html(root, '#t_productList', AIMC.loadingHtml());
    try {
      const [{ data: knowledge }, { data: topics }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/knowledge'), AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.knowledge = knowledge; AIMC.store.topics = topics; AIMC.store.prompts = prompts; AIMC.store.history = history;

      renderStats(root, lc.dom);
      renderCategoryChips(root, lc.dom);
      renderProductList(root, lc.dom);

      const target = presetProductId && knowledge.some((k) => k.external_product_id === presetProductId)
        ? presetProductId
        : (selectedProductId && knowledge.some((k) => k.external_product_id === selectedProductId) ? selectedProductId : (knowledge[0] && knowledge[0].external_product_id));
      if (target) await selectProduct(root, target);
      else lc.dom.html(root, '#t_detailPane', AIMC.emptyState('📦', '尚無商品知識，請先到「商品知識」建立'));
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#t_productList');
    }
  }

  function renderStats(root, dom) {
    const s = AIMC.store;
    const genTopicIds = new Set(s.history.map((h) => h.topic_id).filter(Boolean));
    const approvedTopicIds = new Set(s.history.filter((h) => h.status === 'approved').map((h) => h.topic_id).filter(Boolean));
    const total = s.topics.length;
    const generated = s.topics.filter((t) => genTopicIds.has(t.id)).length;
    const notGenerated = total - generated;
    const approved = s.topics.filter((t) => approvedTopicIds.has(t.id)).length;
    const completeness = total ? Math.round((approved / total) * 100) : 0;
    dom.html(root, '#tStatGrid', [
      AIMC.statCard('📝', total, '主題數'),
      AIMC.statCard('✅', generated, '已生成數'),
      AIMC.statCard('⬜', notGenerated, '未生成數'),
      AIMC.statCard('👍', approved, '已審核數'),
      AIMC.statCard('📈', completeness + '%', '完成度'),
    ].join(''));
  }

  // ── 商品列表（左側）：分類篩選 chip 依「目前所有 Topic 的 category」動態算出，
  // 不是寫死的商品名稱，避免商品一多就對不上（例如原始需求圖片裡的「豬腰」
  // 其實是商品名稱不是分類，這裡改用真正的 Topic 分類欄位，邏輯更一致）──
  function renderCategoryChips(root, dom) {
    const s = AIMC.store;
    const counts = {};
    s.topics.forEach((t) => { counts[t.category] = (counts[t.category] || 0) + 1; });
    const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 5);
    const totalCount = s.topics.length;
    const chips = [{ label: '全部', count: totalCount }, ...cats.map((c) => ({ label: c, count: counts[c] }))];
    if (!chips.some((c) => c.label === categoryFilter)) categoryFilter = '全部';
    dom.html(root, '#t_categoryChips', chips.map((c) => `
      <span class="chip ${c.label === categoryFilter ? 'active' : ''}" data-chip="${AIMC.esc(c.label)}">${AIMC.esc(c.label)}（${c.count}）</span>
    `).join(''));
    const el = dom.query(root, '#t_categoryChips');
    if (el) el.querySelectorAll('[data-chip]').forEach((c) => c.addEventListener('click', () => {
      categoryFilter = c.dataset.chip;
      renderCategoryChips(root, dom);
      renderProductList(root, dom);
    }));
  }

  function productStats(externalProductId) {
    const s = AIMC.store;
    const topics = s.topics.filter((t) => t.external_product_id === externalProductId);
    const topicIds = new Set(topics.map((t) => t.id));
    const promptCount = s.prompts.filter((p) => topicIds.has(p.topic_id)).length;
    // Hotfix18 Goal5：待審核/已通過/已退回一律走 AIMC.reviewStatsForProduct，
    // 跟 Dashboard、Knowledge Health Card、Review 頁共用同一套算法。
    const rs = AIMC.reviewStatsForProduct(externalProductId);
    const pct = topics.length ? Math.round((topics.filter((t) => {
      return s.history.some((h) => h.topic_id === t.id && h.status === 'approved');
    }).length / topics.length) * 100) : 0;
    return {
      topics, promptCount, genCount: rs.total, pendingCount: rs.pending,
      reviewedCount: rs.approved + rs.rejected, approvedCount: rs.approved, rejectedCount: rs.rejected, pct,
    };
  }

  // 幫「生成內容／再次生成」深連結決定要帶哪個 content_goal：
  // 優先找這個主題在指定平台已存在的 Prompt 的 content_goal（一定能成功生成），
  // 找不到才退回 Zero Workflow Engine 的預設目的（教育）。
  function pickGoalForTopic(topicId, platform) {
    const s = AIMC.store;
    const onPlatform = s.prompts.find((p) => p.topic_id === topicId && p.platform === platform);
    if (onPlatform) return onPlatform.content_goal;
    const any = s.prompts.find((p) => p.topic_id === topicId);
    if (any) return any.content_goal;
    return AIMC.Workflow.BASELINE_GOAL;
  }

  function generateHref(externalProductId, topicId, platform, goal) {
    return '#/generate/' + [externalProductId, topicId, platform, goal].map((s) => encodeURIComponent(s)).join('/');
  }

  function renderProductList(root, dom) {
    const s = AIMC.store;
    let list = s.knowledge;
    if (searchQuery) list = list.filter((k) => k.product_name.includes(searchQuery));
    if (categoryFilter !== '全部') {
      list = list.filter((k) => s.topics.some((t) => t.external_product_id === k.external_product_id && t.category === categoryFilter));
    }
    if (!list.length) { dom.html(root, '#t_productList', AIMC.emptyState('📦', '沒有符合條件的商品')); return; }
    dom.html(root, '#t_productList', list.map((k) => {
      const st = productStats(k.external_product_id);
      const active = k.external_product_id === selectedProductId;
      return `
      <div class="product-list-item ${active ? 'active' : ''}" data-pid="${AIMC.esc(k.external_product_id)}">
        ${k.product_image_url ? `<img class="pli-thumb" src="${AIMC.esc(k.product_image_url)}" alt="">` : '<div class="pli-thumb">🍽️</div>'}
        <div class="pli-body">
          <div class="pli-name">${AIMC.esc(k.product_name)}</div>
          <div class="pli-stats">主題 ${st.topics.length} ・ Prompt ${st.promptCount} ・ 生成 ${st.genCount} ・ 待審核 ${st.pendingCount}</div>
        </div>
        <div class="pli-pct">${st.pct}%</div>
      </div>`;
    }).join(''));
    const el = dom.query(root, '#t_productList');
    if (el) el.querySelectorAll('[data-pid]').forEach((item) => item.addEventListener('click', () => selectProduct(document.getElementById('workspace'), item.dataset.pid)));
  }

  // ── 選擇商品：另外呼叫一次 GET /topics?external_product_id=xxx，
  // 保證右側資料是「這個商品專屬」，並快取進 AIMC.store.topicsByProduct，
  // 驗收標準要求的「不同商品之間主題不會混在一起」由這支呼叫保證。──
  async function selectProduct(root, externalProductId) {
    selectedProductId = externalProductId;
    activeTab = 'overview';
    focusedTopicId = null;
    const dom = AIMC.DOM.forPage('Topics');
    renderProductList(root, dom);
    dom.html(root, '#t_detailPane', AIMC.loadingHtml());

    const lc = AIMC.startLifecycle('Topics:selectProduct');
    try {
      const { data } = await AIMC.api('/topics?external_product_id=' + encodeURIComponent(externalProductId));
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.topicsByProduct[externalProductId] = data;
      // 同步回全域快取，讓其他既有邏輯（例如 AIMC.Workflow.checkTopic）看到的資料一致
      AIMC.store.topics = AIMC.store.topics.filter((t) => t.external_product_id !== externalProductId).concat(data);
      renderDetailPane(root, lc.dom);
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#t_detailPane');
    }
  }

  // Hotfix18 Goal2：banner 文字/是否顯示一律用 AIMC.Workflow.productStepCta 算出的 step 決定，
  // 只有「按鈕點下去要做什麼」依頁面情境客製（Knowledge 頁跳頁，Topics 頁盡量頁內完成）。
  function renderNextStepBannerHtml(nextCta, insight, topics) {
    if (nextCta.step === 'topic') {
      return `<div class="workflow-card"><div class="wf-icon">👉</div><div class="wf-body"><div class="wf-title">下一步：${nextCta.hint}</div></div><button class="btn ai sm" data-banner-action="topic">${nextCta.label}</button></div>`;
    }
    if (nextCta.step === 'prompt') {
      return `<div class="workflow-card"><div class="wf-icon">👉</div><div class="wf-body"><div class="wf-title">下一步：${nextCta.hint}</div></div><button class="btn ai sm" data-banner-action="prompt">${nextCta.label}</button></div>`;
    }
    if (nextCta.step === 'generate') {
      const t0 = topics[0];
      const href = t0 ? generateHref(selectedProductId, t0.id, 'fb', pickGoalForTopic(t0.id, 'fb')) : '#/generate/' + encodeURIComponent(selectedProductId);
      return `<div class="workflow-card"><div class="wf-icon">👉</div><div class="wf-body"><div class="wf-title">下一步：${nextCta.hint}</div></div><button class="btn ai sm" onclick="location.hash='${href}'">${nextCta.label}</button></div>`;
    }
    if (nextCta.step === 'review') {
      return `<div class="workflow-card"><div class="wf-icon">👉</div><div class="wf-body"><div class="wf-title">下一步：${nextCta.hint}</div></div><button class="btn ai sm" onclick="location.hash='${nextCta.href(insight)}'">${nextCta.label}</button></div>`;
    }
    // done：全部齊全且沒有待審核 —— 只有已經生成過內容才提示「可以再生成」，避免對全新商品也顯示這句
    if (insight.genCount > 0) {
      const t0 = topics[0];
      const href = t0 ? generateHref(selectedProductId, t0.id, 'fb', pickGoalForTopic(t0.id, 'fb')) : '#/generate/' + encodeURIComponent(selectedProductId);
      return `<div class="workflow-card"><div class="wf-icon">✨</div><div class="wf-body"><div class="wf-title">下一步：再次生成內容</div><div class="wf-desc">目前生成的內容都已審核完畢，可以繼續生成新素材。</div></div><button class="btn ai sm" onclick="location.hash='${href}'">✨ 生成內容</button></div>`;
    }
    return '';
  }

  function handleBannerAction(root, dom, action) {
    if (action === 'topic') { toggleCreatePanel(root, dom); return; }
    if (action === 'prompt') { activeTab = 'promptStatus'; renderDetailPane(root, dom); return; }
  }

  function renderDetailPane(root, dom) {
    const product = AIMC.store.knowledge.find((k) => k.external_product_id === selectedProductId);
    if (!product) { dom.html(root, '#t_detailPane', AIMC.emptyState('📦', '找不到此商品')); return; }
    const topics = AIMC.store.topicsByProduct[selectedProductId] || [];
    const st = productStats(selectedProductId);

    // Hotfix18 Goal2：右側加一個明顯的「下一步」CTA 區，跟 Knowledge 健康卡共用
    // 同一套 AIMC.Workflow.productStepCta() 判斷（Goal5 一致性），不要自己另外寫一份規則。
    // 「建立 Topic／建立 Prompt」在本頁就能完成，所以按鈕改成頁內動作（開表單／切 tab），
    // 不會呆呆導到同一頁；「生成內容／前往審核」才需要真的跳頁。
    const insight = {
      row: { external_product_id: selectedProductId, id: product.id },
      topics: st.topics, promptCount: st.promptCount, genCount: st.genCount, pendingCount: st.pendingCount,
    };
    const nextCta = AIMC.Workflow.productStepCta(insight);
    const nextStepBanner = renderNextStepBannerHtml(nextCta, insight, topics);

    dom.html(root, '#t_detailPane', `
      <div class="flex-between">
        <div>
          <h3 class="td-header-title">${AIMC.esc(product.product_name)} ${AIMC.badge('active', 'active')}</h3>
          <div class="td-meta">📝 主題 ${st.topics.length} ・ 🤖 Prompt ${st.promptCount} ・ ✨ 生成 ${st.genCount} ・ ⏳ 待審核 ${st.pendingCount} ・ 📈 完成度 ${st.pct}%</div>
        </div>
        <div class="row-actions" style="margin-top:0">
          <button class="btn ai sm" id="t_aiSuggestBtn">🪄 AI 建議主題</button>
          <button class="btn sm" id="t_newTopicBtn">➕ 新增主題</button>
        </div>
      </div>

      ${nextStepBanner}

      <div class="topic-create-panel" id="t_suggestPanel">
        <div class="flex-between" style="margin-bottom:8px"><strong style="font-size:13px">🤖 AI Topic Suggestions</strong></div>
        <div class="suggestion-chips" id="t_suggestionChips"></div>
      </div>

      <div class="topic-create-panel" id="t_createPanel">
        <div class="grid">
          <div class="field">
            <label>分類 *</label>
            <select id="t_category">
              <option>營養</option><option>知識</option><option>文化</option><option>品牌</option>
              <option>FAQ</option><option>迷思</option><option>工法</option><option>促銷</option>
              <option>節日</option><option>SEO</option><option>教育</option><option>娛樂</option><option>短影音</option>
            </select>
          </div>
          <div class="field"><label>主題標題 *</label><input type="text" id="t_title" placeholder="例如：豬腰補鐵知識"></div>
          <div class="field"><label>優先度 priority</label><input type="number" id="t_priority" value="0"></div>
        </div>
        <div class="row-actions"><button class="btn sm" id="t_createBtn">➕ 建立主題</button><button class="btn secondary sm" id="t_cancelCreateBtn">取消</button></div>
      </div>

      <div class="detail-tabs" id="t_tabs">
        <div class="detail-tab ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview">主題總覽</div>
        <div class="detail-tab ${activeTab === 'promptStatus' ? 'active' : ''}" data-tab="promptStatus">Prompt 狀態</div>
        <div class="detail-tab ${activeTab === 'content' ? 'active' : ''}" data-tab="content">生成內容</div>
        <div class="detail-tab ${activeTab === 'review' ? 'active' : ''}" data-tab="review">審核記錄</div>
      </div>
      <div id="t_tabPanel"></div>
    `);

    dom.on(root, '#t_aiSuggestBtn', 'click', () => toggleSuggestPanel(root, dom));
    dom.on(root, '#t_newTopicBtn', 'click', () => toggleCreatePanel(root, dom));
    dom.on(root, '#t_cancelCreateBtn', 'click', () => dom.classRemove(root, '#t_createPanel', 'open'));
    dom.on(root, '#t_createBtn', 'click', () => createTopic(root, dom));
    dom.on(root, '[data-banner-action]', 'click', (e) => handleBannerAction(root, dom, e.currentTarget.dataset.bannerAction));
    const tabsEl = dom.query(root, '#t_tabs');
    if (tabsEl) tabsEl.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      renderDetailPane(root, dom);
    }));

    renderTabPanel(root, dom);
  }

  function toggleSuggestPanel(root, dom) {
    const panel = dom.query(root, '#t_suggestPanel');
    if (!panel) return;
    const willOpen = !panel.classList.contains('open');
    dom.classRemove(root, '#t_createPanel', 'open');
    panel.classList.toggle('open', willOpen);
    if (willOpen) renderSuggestionChips(root, dom);
  }

  function toggleCreatePanel(root, dom) {
    const panel = dom.query(root, '#t_createPanel');
    if (!panel) return;
    dom.classRemove(root, '#t_suggestPanel', 'open');
    panel.classList.toggle('open');
  }

  function renderSuggestionChips(root, dom) {
    const product = AIMC.store.knowledge.find((k) => k.external_product_id === selectedProductId);
    const productName = product ? product.product_name : '';
    const existingTitles = new Set((AIMC.store.topicsByProduct[selectedProductId] || []).map((t) => t.title));
    const items = suggestionsForProduct(productName);
    dom.html(root, '#t_suggestionChips', items.map((it) => {
      const title = productName + it.kw;
      const already = existingTitles.has(title);
      return `<span class="suggestion-chip">🏷️ ${AIMC.esc(it.kw)}（${AIMC.esc(it.cat)}）
        <button class="btn ${already ? 'secondary' : 'ai'} sm" data-kw="${AIMC.esc(it.kw)}" data-cat="${AIMC.esc(it.cat)}" ${already ? 'disabled' : ''}>${already ? '已建立' : '一鍵建立'}</button>
      </span>`;
    }).join(''));
    const el = dom.query(root, '#t_suggestionChips');
    if (el) el.querySelectorAll('[data-kw]').forEach((btn) => {
      btn.addEventListener('click', () => quickCreateTopic(root, dom, productName, btn.dataset.kw, btn.dataset.cat));
    });
  }

  async function quickCreateTopic(root, dom, productName, kw, cat) {
    const title = productName + kw;
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id: selectedProductId, title, category: cat, priority: 0 } });
      AIMC.toast(`已一鍵建立主題「${title}」`);
      await selectProduct(root, selectedProductId);
      dom.query(root, '#t_suggestPanel')?.classList.add('open');
      renderSuggestionChips(root, dom);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function createTopic(root, dom) {
    const title = (dom.value(root, '#t_title') || '').trim();
    const category = dom.value(root, '#t_category');
    const priority = Number(dom.value(root, '#t_priority')) || 0;
    if (!title) return AIMC.toast('請輸入主題標題', true);
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id: selectedProductId, title, category, priority } });
      AIMC.toast('已建立主題');
      await selectProduct(root, selectedProductId);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  // ── Tab 內容渲染 ──
  function renderTabPanel(root, dom) {
    if (activeTab === 'overview') return renderOverviewTab(root, dom);
    if (activeTab === 'promptStatus') return renderPromptStatusTab(root, dom);
    if (activeTab === 'content') return renderContentTab(root, dom);
    if (activeTab === 'review') return renderReviewTab(root, dom);
  }

  function priorityBadge(priority) {
    if (priority >= 7) return '<span class="priority-badge high">高</span>';
    if (priority >= 4) return '<span class="priority-badge mid">中</span>';
    return '<span class="priority-badge low">低</span>';
  }

  // 狀態判斷（依需求規則）：未開始＝Prompt=0 且 Generated=0；進行中＝Generated>0 且 已審核=0；已完成＝已審核(approved+rejected)>0
  function topicStatus(promptCount, genCount, reviewedCount) {
    if (reviewedCount > 0) return { key: 'done', label: '已完成' };
    if (genCount > 0) return { key: 'inprogress', label: '進行中' };
    if (promptCount === 0 && genCount === 0) return { key: 'notstarted', label: '未開始' };
    return { key: 'inprogress', label: '進行中' };
  }

  function renderOverviewTab(root, dom) {
    const topics = AIMC.store.topicsByProduct[selectedProductId] || [];
    if (!topics.length) {
      dom.html(root, '#t_tabPanel', AIMC.emptyState('📝', '此商品尚無主題，可用上方「AI 建議主題」或「新增主題」建立'));
      return;
    }
    const s = AIMC.store;
    dom.html(root, '#t_tabPanel', `
      <table>
        <thead><tr><th>主題</th><th>分類</th><th>Prompt</th><th>生成</th><th>待審核</th><th>優先度</th><th>狀態</th><th>操作</th></tr></thead>
        <tbody>
          ${topics.map((t) => {
            const promptCount = s.prompts.filter((p) => p.topic_id === t.id).length;
            const platformsCovered = MATRIX_PLATFORMS.filter((pl) => s.prompts.some((p) => p.topic_id === t.id && p.platform === pl)).length;
            // Hotfix18 Goal5：即使是單一 Topic 的待審核數，也走同一套 AIMC.reviewStatsForTopicIds。
            const topicRs = AIMC.reviewStatsForTopicIds([t.id]);
            const genCount = topicRs.total;
            const pendingCount = topicRs.pending;
            const reviewedCount = topicRs.approved + topicRs.rejected;
            const status = topicStatus(promptCount, genCount, reviewedCount);

            // Hotfix18 Goal2：每列操作依 4 態決定——缺 Prompt／有 Prompt 未生成／有生成待審核／都完成再次生成
            let action;
            if (promptCount === 0) {
              action = { label: '建立 Prompt', href: '#/prompts/' + encodeURIComponent(t.id) + '/fb' };
            } else if (genCount === 0) {
              action = { label: '生成內容', href: generateHref(selectedProductId, t.id, 'fb', pickGoalForTopic(t.id, 'fb')) };
            } else if (pendingCount > 0) {
              action = { label: `前往審核 ${pendingCount}`, href: '#/review/' + encodeURIComponent(selectedProductId) };
            } else {
              action = { label: '再次生成', href: generateHref(selectedProductId, t.id, 'fb', pickGoalForTopic(t.id, 'fb')) };
            }

            return `
            <tr>
              <td>${AIMC.esc(t.title)}</td>
              <td>${AIMC.esc(t.category)}</td>
              <td>${platformsCovered}/${MATRIX_PLATFORMS.length}</td>
              <td>${genCount}</td>
              <td>${pendingCount}</td>
              <td>${priorityBadge(t.priority || 0)}</td>
              <td><span class="topic-status-badge ${status.key}">${status.label}</span></td>
              <td class="row-actions" style="margin-top:0">
                <button class="link-btn" data-view="${t.id}">檢視</button>
                <button class="link-btn" data-action-href="${AIMC.esc(action.href)}">${AIMC.esc(action.label)}</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `);
    const el = dom.query(root, '#t_tabPanel');
    if (el) {
      el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        focusedTopicId = b.dataset.view;
        activeTab = 'promptStatus';
        renderDetailPane(root, dom);
      }));
      el.querySelectorAll('[data-action-href]').forEach((b) => b.addEventListener('click', () => {
        location.hash = b.dataset.actionHref;
      }));
    }
  }

  // Prompt 狀態 tab：每個主題各自一個矩陣卡（fb/line × 對應內容目的），
  // 沿用 Hotfix16 Part 9 的判斷邏輯（AIMC.Workflow.checkPrompt），確保跟
  // Generate 頁「缺 Prompt」判斷完全一致，不會出現兩邊結果不同的情況。
  function renderPromptStatusTab(root, dom) {
    const topics = AIMC.store.topicsByProduct[selectedProductId] || [];
    if (!topics.length) {
      dom.html(root, '#t_tabPanel', AIMC.emptyState('📝', '此商品尚無主題'));
      return;
    }
    dom.html(root, '#t_tabPanel', topics.map((t) => {
      const matrices = Object.keys(TOPIC_MATRIX_CONFIG).map((platform) => {
        const goals = TOPIC_MATRIX_CONFIG[platform];
        const items = goals.map((goal) => ({ goal, ok: !!AIMC.Workflow.checkPrompt(t.id, platform, goal) }));
        const doneCount = items.filter((i) => i.ok).length;
        return `
          <div class="health-matrix-card">
            <div class="hmx-head">
              <span class="hmx-platform">${AIMC.esc(AIMC.platformLabel(platform))}</span>
              <span class="badge ${doneCount === items.length ? 'active' : 'outline'}">${doneCount}/${items.length}</span>
            </div>
            <div class="hmx-rows">
              ${items.map((i) => `
                <div class="hmx-row">
                  <span class="hmx-goal">${i.ok ? '✔' : '✖'} ${AIMC.esc(i.goal)}</span>
                  ${i.ok ? '' : `<button class="link-btn hmx-fix" data-tm-topic="${t.id}" data-tm-platform="${platform}" data-tm-goal="${AIMC.esc(i.goal)}">一鍵建立</button>`}
                </div>`).join('')}
            </div>
          </div>`;
      }).join('');
      return `
        <div class="card" style="margin-bottom:12px;${t.id === focusedTopicId ? 'border-color:var(--accent)' : ''}">
          <h3 style="font-size:13px;margin-top:0">${AIMC.esc(t.title)}　<span class="muted">${AIMC.esc(t.category)}</span></h3>
          <div class="grid" style="grid-template-columns:repeat(2,1fr)">${matrices}</div>
        </div>`;
    }).join(''));
    const el = dom.query(root, '#t_tabPanel');
    if (el) el.querySelectorAll('[data-tm-topic]').forEach((b) => {
      b.addEventListener('click', () => fixTopicPrompt(root, dom, b.dataset.tmTopic, b.dataset.tmPlatform, b.dataset.tmGoal));
    });
  }

  async function fixTopicPrompt(root, dom, topicId, platform, goal) {
    try {
      await AIMC.Workflow.ensurePrompt({ topic_id: topicId, platform, content_goal: goal });
      AIMC.toast(`已建立 ${AIMC.platformLabel(platform)} × ${goal} 的 Prompt`);
      focusedTopicId = topicId;
      await selectProduct(root, selectedProductId);
      activeTab = 'promptStatus';
      renderDetailPane(root, dom);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  function renderContentTab(root, dom) {
    const topics = AIMC.store.topicsByProduct[selectedProductId] || [];
    const topicIds = new Set(topics.map((t) => t.id));
    const topicMap = Object.fromEntries(topics.map((t) => [t.id, t.title]));
    const items = AIMC.store.history.filter((h) => topicIds.has(h.topic_id)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!items.length) { dom.html(root, '#t_tabPanel', AIMC.emptyState('✨', '此商品尚無生成紀錄，前往「AI 生成」建立')); return; }
    dom.html(root, '#t_tabPanel', `
      <table>
        <thead><tr><th>主題</th><th>平台</th><th>內容目的</th><th>狀態</th><th>時間</th></tr></thead>
        <tbody>
          ${items.map((h) => `
            <tr>
              <td>${AIMC.esc(topicMap[h.topic_id] || '-')}</td>
              <td>${AIMC.platformLabel(h.platform)}</td>
              <td>${AIMC.esc((h.generation_params && h.generation_params.content_goal) || '-')}</td>
              <td><span class="badge ${h.status}">${h.status}</span></td>
              <td class="muted">${AIMC.fmtTime(h.created_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `);
  }

  function renderReviewTab(root, dom) {
    const topics = AIMC.store.topicsByProduct[selectedProductId] || [];
    const topicIds = new Set(topics.map((t) => t.id));
    const topicMap = Object.fromEntries(topics.map((t) => [t.id, t.title]));
    const items = AIMC.store.history.filter((h) => topicIds.has(h.topic_id) && h.status !== 'generated').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    // Hotfix18 Goal5：待審核數改走 AIMC.reviewStatsForProduct，跟其他頁一致。
    const pending = AIMC.reviewStatsForProduct(selectedProductId).pending;
    dom.html(root, '#t_tabPanel', `
      ${pending ? `<div class="workflow-card"><div class="wf-icon">⏳</div><div class="wf-body"><div class="wf-title">有 ${pending} 篇待審核</div><div class="wf-desc">實際核准／退回請至「審核」頁進行，這裡只顯示紀錄。</div></div><button class="btn ai sm" onclick="location.hash='#/review/${encodeURIComponent(selectedProductId)}'">前往審核 ${pending}</button></div>` : ''}
      ${items.length ? `
      <table>
        <thead><tr><th>主題</th><th>平台</th><th>決議</th><th>時間</th></tr></thead>
        <tbody>
          ${items.map((h) => `
            <tr>
              <td>${AIMC.esc(topicMap[h.topic_id] || '-')}</td>
              <td>${AIMC.platformLabel(h.platform)}</td>
              <td><span class="badge ${h.status}">${h.status === 'approved' ? '✅ 核准' : h.status === 'rejected' ? '❌ 退回' : '🔎 審核中'}</span></td>
              <td class="muted">${AIMC.fmtTime(h.updated_at || h.created_at)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : AIMC.emptyState('✅', '此商品尚無審核紀錄')}
    `);
  }

  // ── Part 6：Page API —— destroy / resume / pause ──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return refresh(root); }
  function pause() { console.info('[AIMC] Topics paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.topics = { load, destroy, refresh, resume, pause };
})();
