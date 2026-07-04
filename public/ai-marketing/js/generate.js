// ============================================================
// generate.js — AI Content Studio（AI 推薦生成 + 4 步驟 Wizard）
// Hotfix16：Generate 一律走 AIMC.Workflow.runGenerateWorkflow()，
// 缺 Knowledge / Topic / Prompt 一律顯示 Inline Workflow Card + 「立即建立」，
// 不再讓使用者看到「找不到 Prompt」這類工程錯誤 Toast，也不再需要自己猜下一步。
// 呼叫的 AI 生成 API 本身（POST /generate）欄位與行為完全不變。
//
// 支援路由參數 #/generate/<external_product_id>：自動選定該商品並跳到 Step 2。
//
// V3.1 Stability Pass：所有 DOM 讀寫改用 AIMC.DOM，doGenerate() 呼叫真正的
// AI 生成 API（耗時最長、最容易被使用者切頁打斷），用 AIMC.startLifecycle()
// 做 Page Token 檢查，切頁後生成結果回來也不會再誤寫入別頁的 DOM。
// ============================================================
(function () {
  let step = 1;
  let picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };
  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用

  const PLATFORMS = ['fb', 'ig', 'threads', 'tiktok', 'line', 'google_business', 'youtube_shorts'];
  const GOALS = ['教育', '促銷', 'FAQ', '品牌故事', '顧客見證', 'SEO', '短影音', '圖文', 'Google商家', 'general'];
  const STEP_LABELS = ['商品', '主題', '平台', '內容目的'];

  async function load(root, param) {
    const lc = AIMC.startLifecycle('Generate');
    currentDom = lc.dom;
    resetPicked();
    step = 1;
    renderSteps(root, lc.dom);
    const backEls = root.querySelectorAll('[data-back]'); // 純同步綁定，querySelectorAll 不會是 null，安全
    backEls.forEach((b) => b.addEventListener('click', () => goStep(root, lc.dom, Number(b.dataset.back))));
    lc.dom.on(root, '#gGenerateBtn', 'click', () => doGenerate(root));
    lc.dom.on(root, '#gAgainBtn', 'click', () => resetWizard(root));
    lc.dom.on(root, '#gHistoryRefreshBtn', 'click', () => loadHistory(root));
    lc.dom.on(root, '#gRecRefreshBtn', 'click', () => renderRecommend(root));
    lc.done('event bindings ready');

    await loadProducts(root);
    await loadHistory(root);
    await renderRecommend(root);

    if (param) {
      // Hotfix18 Goal2：支援 #/generate/<product>/<topic_id>/<platform>/<content_goal> 深連結，
      // 從 Topic 頁的每列動作（生成內容／再次生成）點過來時，直接跳到對應步驟，不用使用者重選一次。
      const parts = param.split('/').map((p) => decodeURIComponent(p));
      const [extId, topicId, platform, goal] = parts;
      const dom = AIMC.DOM.forPage('Generate');
      const grid = dom.query(root, '#gProductGrid');
      const card = grid ? grid.querySelector(`[data-id="${CSS.escape(extId)}"]`) : null;
      if (card) {
        await selectProduct(root, card);
        if (topicId) {
          const topicGrid = dom.query(root, '#gTopicGrid');
          const topicCard = topicGrid ? topicGrid.querySelector(`[data-id="${CSS.escape(topicId)}"]`) : null;
          if (topicCard) {
            selectTopic(root, topicCard);
            if (platform) {
              const platGrid = dom.query(root, '#gPlatformGrid');
              const platCard = platGrid ? platGrid.querySelector(`[data-p="${CSS.escape(platform)}"]`) : null;
              if (platCard) {
                selectPlatform(root, platCard);
                if (goal) {
                  const goalGrid = dom.query(root, '#gGoalGrid');
                  const goalCard = goalGrid ? goalGrid.querySelector(`[data-g="${CSS.escape(goal)}"]`) : null;
                  if (goalCard) selectGoalCard(root, dom, goalCard);
                }
              }
            }
          }
        }
      }
    }
  }

  function resetPicked() {
    picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };
  }

  // ── AI 推薦生成：找出「有 Prompt、但尚未生成過內容」的主題，優先推薦 ──
  async function renderRecommend(root) {
    const lc = AIMC.startLifecycle('Generate:renderRecommend');
    lc.dom.html(root, '#gRecommend', AIMC.loadingHtml());
    try {
      const [{ data: topics }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.topics = topics; AIMC.store.prompts = prompts; AIMC.store.history = history;

      const promptsByTopic = {};
      prompts.forEach((p) => { if (p.topic_id) (promptsByTopic[p.topic_id] ||= []).push(p); });
      const genTopicIds = new Set(history.map((h) => h.topic_id).filter(Boolean));

      const candidates = topics
        .filter((t) => t.status === 'active' && (promptsByTopic[t.id] || []).length)
        .map((t) => ({ topic: t, prompts: promptsByTopic[t.id], hasGenerated: genTopicIds.has(t.id) }));

      if (!candidates.length) {
        lc.dom.html(root, '#gRecommend', AIMC.emptyState('🤖', '目前沒有「已建立 Prompt」的主題，請先到「Prompt」建立範本，或直接使用下方「選擇商品」流程，缺什麼系統會自動帶你補齊。'));
        lc.done();
        return;
      }
      candidates.sort((a, b) => (a.hasGenerated === b.hasGenerated ? b.topic.priority - a.topic.priority : (a.hasGenerated ? 1 : -1)));
      const best = candidates[0];
      const prompt = best.prompts.find((p) => p.is_default) || best.prompts[0];

      lc.dom.html(root, '#gRecommend', `
        <div class="recommend-card">
          <div class="rc-head">⚡ ${AIMC.esc(best.topic.product_name)} → ${AIMC.esc(best.topic.title)} → ${AIMC.esc(AIMC.platformLabel(prompt.platform))} → ${AIMC.esc(prompt.content_goal)}</div>
          <p class="muted" style="margin:6px 0 0">${best.hasGenerated ? '此主題已生成過內容，可以再生成一篇新素材。' : '此主題尚未生成過內容，建議優先產生第一篇。'}</p>
          <div class="rc-ctas"><button class="btn ai sm" id="gRecGoBtn">⚡ 一鍵生成</button></div>
        </div>`);
      lc.dom.on(root, '#gRecGoBtn', 'click', () => quickGenerate(root, best.topic, prompt));
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#gRecommend');
    }
  }

  async function quickGenerate(root, topic, prompt) {
    const dom = AIMC.DOM.forPage('Generate');
    picked = {
      external_product_id: topic.external_product_id, product_name: topic.product_name,
      topic_id: topic.id, topic_title: topic.title,
      platform: prompt.platform, content_goal: prompt.content_goal,
    };
    step = 4;
    renderSteps(root, dom);
    await doGenerate(root);
  }

  function renderSteps(root, dom) {
    dom.html(root, '#gSteps', STEP_LABELS.map((l, i) => {
      const n = i + 1;
      let cls = 'wizard-step';
      if (n < step) cls += ' done'; else if (n === step) cls += ' active';
      const connector = i < STEP_LABELS.length - 1 ? '<div class="wizard-connector"></div>' : '';
      return `<div class="${cls}"><span class="ws-num">${n < step ? '✓' : n}</span>${l}</div>${connector}`;
    }).join(''));
  }

  function goStep(root, dom, n) {
    step = n;
    renderSteps(root, dom);
    [1, 2, 3, 4].forEach((i) => dom.class(root, '#gPanel' + i, 'active', i === n));
  }

  // Hotfix16 Part 5：Step1 商品清單改用「全部 POS 商品」，不再只列出已建知識的商品——
  // 使用者可以選任何 POS 商品，Zero Workflow Engine 會自動帶著補齊 Knowledge/Topic/Prompt。
  async function loadProducts(root) {
    const lc = AIMC.startLifecycle('Generate:loadProducts');
    try {
      const [posProducts] = await Promise.all([AIMC.loadPosProducts(), AIMC.api('/knowledge').then((r) => { AIMC.store.knowledge = r.data; })]);
      if (!lc.checkpoint('API 完成')) return;
      if (!posProducts.length) { lc.dom.html(root, '#gProductGrid', AIMC.emptyState('📦', '請先到「商品管理」建立 POS 商品')); lc.done(); return; }
      const knownIds = new Set(AIMC.store.knowledge.map((k) => k.external_product_id));
      lc.dom.html(root, '#gProductGrid', posProducts.map((p) => `
        <div class="pick-card" data-id="${AIMC.esc(p.external_product_id)}" data-name="${AIMC.esc(p.product_name)}">
          <div class="pc-title">${AIMC.esc(p.product_name)}</div>
          <div class="pc-sub">${AIMC.esc(p.external_product_id)} ${!knownIds.has(p.external_product_id) ? '・ <span class="muted">尚未初始化</span>' : ''}</div>
        </div>`).join(''));
      const grid = lc.dom.query(root, '#gProductGrid');
      if (grid) grid.querySelectorAll('[data-id]').forEach((c) => c.addEventListener('click', () => selectProduct(root, c)));
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#gProductGrid');
    }
  }

  // ── Zero Workflow Engine：STEP1 檢查 Knowledge ──
  async function selectProduct(root, cardEl) {
    const dom = AIMC.DOM.forPage('Generate');
    picked.external_product_id = cardEl.dataset.id;
    picked.product_name = cardEl.dataset.name;
    picked.topic_id = null; picked.topic_title = null; // 換商品要重選主題
    const grid = dom.query(root, '#gProductGrid');
    if (grid) grid.querySelectorAll('.pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    dom.html(root, '#gKnowledgeWorkflowCard', '');

    if (!AIMC.Workflow.checkKnowledge(picked.external_product_id)) {
      dom.html(root, '#gKnowledgeWorkflowCard', AIMC.Workflow.renderInlineCard('knowledge'));
      dom.on(root, '#gKnowledgeWorkflowCard [data-workflow-fix="knowledge"]', 'click', () => fixKnowledge(root));
      dom.html(root, '#gTopicGrid', '');
      dom.html(root, '#gTopicWorkflowCard', '');
      return; // 停在 Step1，等使用者按「立即建立」
    }
    await proceedToTopicStep(root);
  }

  async function fixKnowledge(root) {
    const dom = AIMC.DOM.forPage('Generate');
    const posProduct = (AIMC.store.posProducts || []).find((p) => p.external_product_id === picked.external_product_id);
    if (!posProduct) { AIMC.toast('找不到此 POS 商品資料', true); return; }
    try {
      await AIMC.Workflow.ensureKnowledge(posProduct);
      AIMC.toast('已建立商品知識草稿，可至「商品知識」補充細節');
      dom.html(root, '#gKnowledgeWorkflowCard', '');
      await proceedToTopicStep(root);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  // ── Zero Workflow Engine：STEP2 檢查 Topic ──
  async function proceedToTopicStep(root) {
    const dom = AIMC.DOM.forPage('Generate');
    goStep(root, dom, 2);
    dom.html(root, '#gTopicGrid', AIMC.loadingHtml());
    dom.html(root, '#gTopicWorkflowCard', '');
    try {
      const { data } = await AIMC.api('/topics?external_product_id=' + encodeURIComponent(picked.external_product_id));
      AIMC.store.topics = AIMC.store.topics.filter((t) => t.external_product_id !== picked.external_product_id).concat(data);
      if (!data.length) {
        dom.html(root, '#gTopicGrid', '');
        dom.html(root, '#gTopicWorkflowCard', AIMC.Workflow.renderInlineCard('topic'));
        dom.on(root, '#gTopicWorkflowCard [data-workflow-fix="topic"]', 'click', () => fixTopic(root));
        return;
      }
      renderTopicGrid(root, dom, data);
    } catch (e) {
      dom.html(root, '#gTopicGrid', `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`);
    }
  }

  function renderTopicGrid(root, dom, topics) {
    dom.html(root, '#gTopicGrid', topics.map((t) => `
      <div class="pick-card" data-id="${t.id}" data-title="${AIMC.esc(t.title)}">
        <div class="pc-title">${AIMC.esc(t.title)}</div>
        <div class="pc-sub">${AIMC.esc(t.category)}</div>
      </div>`).join(''));
    const topicGrid = dom.query(root, '#gTopicGrid');
    if (topicGrid) topicGrid.querySelectorAll('[data-id]').forEach((c) => c.addEventListener('click', () => selectTopic(root, c)));
  }

  async function fixTopic(root) {
    const dom = AIMC.DOM.forPage('Generate');
    try {
      const result = await AIMC.Workflow.ensureTopic(picked.external_product_id);
      AIMC.toast(`已建立 ${result.created_count} 個主題${result.skipped_count ? `（${result.skipped_count} 個已存在，已跳過）` : ''}`);
      dom.html(root, '#gTopicWorkflowCard', '');
      await proceedToTopicStep(root);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  function selectTopic(root, cardEl) {
    const dom = AIMC.DOM.forPage('Generate');
    picked.topic_id = cardEl.dataset.id;
    picked.topic_title = cardEl.dataset.title;
    const grid = dom.query(root, '#gTopicGrid');
    if (grid) grid.querySelectorAll('.pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    renderPlatformGrid(root, dom);
    goStep(root, dom, 3);
  }

  function renderPlatformGrid(root, dom) {
    dom.html(root, '#gPlatformGrid', PLATFORMS.map((p) => `
      <div class="pick-card" data-p="${p}"><div class="pc-title">${AIMC.esc(AIMC.platformLabel(p))}</div></div>`).join(''));
    const grid = dom.query(root, '#gPlatformGrid');
    if (grid) grid.querySelectorAll('[data-p]').forEach((c) => c.addEventListener('click', () => selectPlatform(root, c)));
  }

  function selectPlatform(root, cardEl) {
    const dom = AIMC.DOM.forPage('Generate');
    picked.platform = cardEl.dataset.p;
    picked.content_goal = null;
    const grid = dom.query(root, '#gPlatformGrid');
    if (grid) grid.querySelectorAll('.pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    renderGoalGrid(root, dom);
    goStep(root, dom, 4);
  }

  // ── Zero Workflow Engine：STEP3 檢查 Prompt（選定平台+目的後立即檢查）──
  function renderGoalGrid(root, dom) {
    dom.html(root, '#gGoalGrid', GOALS.map((g) => `<div class="pick-card" data-g="${g}"><div class="pc-title">${g}</div></div>`).join(''));
    dom.html(root, '#gPromptWorkflowCard', '');
    setGenerateEnabled(root, dom, false);
    const grid = dom.query(root, '#gGoalGrid');
    if (grid) {
      grid.querySelectorAll('[data-g]').forEach((c) => c.addEventListener('click', () => selectGoalCard(root, dom, c)));
    }
  }

  function selectGoalCard(root, dom, cardEl) {
    const grid = dom.query(root, '#gGoalGrid');
    picked.content_goal = cardEl.dataset.g;
    if (grid) grid.querySelectorAll('.pick-card').forEach((x) => x.classList.toggle('selected', x === cardEl));
    checkPromptStep(root, dom);
  }

  function setGenerateEnabled(root, dom, enabled) {
    const btn = dom.query(root, '#gGenerateBtn');
    if (btn) { btn.style.display = enabled ? '' : 'none'; }
  }

  function checkPromptStep(root, dom) {
    dom.html(root, '#gPromptWorkflowCard', '');
    const prompt = AIMC.Workflow.checkPrompt(picked.topic_id, picked.platform, picked.content_goal);
    if (!prompt) {
      dom.html(root, '#gPromptWorkflowCard', AIMC.Workflow.renderInlineCard('prompt', { platform: picked.platform, contentGoal: picked.content_goal }));
      dom.on(root, '#gPromptWorkflowCard [data-workflow-fix="prompt"]', 'click', () => fixPrompt(root));
      setGenerateEnabled(root, dom, false);
    } else {
      setGenerateEnabled(root, dom, true);
    }
  }

  async function fixPrompt(root) {
    const dom = AIMC.DOM.forPage('Generate');
    try {
      await AIMC.Workflow.ensurePrompt({ topic_id: picked.topic_id, platform: picked.platform, content_goal: picked.content_goal });
      AIMC.toast('Prompt 已建立，可立即重新生成');
      checkPromptStep(root, dom);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  // ── STEP4：全部齊全後才呼叫既有 POST /generate（透過 AIMC.Workflow.runGenerateWorkflow）──
  async function doGenerate(root) {
    if (!picked.topic_id) return AIMC.toast('請選擇主題', true);
    if (!picked.platform) return AIMC.toast('請選擇平台', true);
    if (!picked.content_goal) return AIMC.toast('請選擇內容目的', true);

    const lc = AIMC.startLifecycle('Generate:doGenerate');
    const btn = lc.dom.query(root, '#gGenerateBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中...'; }
    try {
      const result = await AIMC.Workflow.runGenerateWorkflow(picked, {
        onMissing: (missingStep) => {
          // 理論上 UI 已經逐步擋掉，這裡是最後一道防線（例如資料在別的分頁被改動）：
          // 一樣顯示 Inline Workflow Card，不丟工程錯誤 Toast。
          lc.dom.html(root, '#gPromptWorkflowCard', AIMC.Workflow.renderInlineCard(missingStep, { platform: picked.platform, contentGoal: picked.content_goal }));
          lc.dom.on(root, `#gPromptWorkflowCard [data-workflow-fix="${missingStep}"]`, 'click', () => {
            if (missingStep === 'knowledge') fixKnowledge(root);
            else if (missingStep === 'topic') fixTopic(root);
            else fixPrompt(root);
          });
        },
      });
      if (!lc.checkpoint('生成 API 完成')) return; // 使用者已切頁：內容其實已經生成成功、也已落地 content_history，
                                                     // 只是「這個畫面」不需要再顯示結果，下次進審核頁會看得到，安全跳過即可
      if (!result.ok) { lc.done('缺資料，已顯示 Inline Workflow Card'); return; }
      const data = result.data;
      lc.dom.show(root, '#gResultCard', 'block');
      lc.dom.html(root, '#gResult', `
        <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
          <div><div class="muted" style="margin-bottom:2px">平台</div><b>${AIMC.esc(AIMC.platformLabel(picked.platform))}</b></div>
          <div><div class="muted" style="margin-bottom:2px">商品</div><b>${AIMC.esc(picked.product_name || '-')}</b></div>
          <div><div class="muted" style="margin-bottom:2px">主題</div><b>${AIMC.esc(picked.topic_title || '-')}</b></div>
          <div><div class="muted" style="margin-bottom:2px">狀態</div>${AIMC.badge(data.status, data.status)}</div>
        </div>
        <div class="gen-result">${AIMC.esc(data.generated_text)}</div>
        <p class="muted" style="margin-top:8px">模型：${AIMC.esc(data.model_provider)}/${AIMC.esc(data.model_name)}　請至「審核」核准後才能排程發布（Phase 2 以後功能）</p>
      `);
      // Hotfix18 Goal4：前往審核按鈕要帶上「這個商品」目前的待審核數，並導到該商品專屬的 Review 分類，
      // 數字一律用 AIMC.reviewStatsForProduct（跟 Dashboard/Knowledge/Topic 同一套算法）。
      const reviewBtn = lc.dom.query(root, '#gReviewBtn');
      if (reviewBtn) {
        const pending = AIMC.reviewStatsForProduct(picked.external_product_id).pending;
        reviewBtn.textContent = `✅ 前往審核 ${pending}`;
        reviewBtn.setAttribute('onclick', `location.hash='#/review/${encodeURIComponent(picked.external_product_id)}'`);
      }
      const resultCard = lc.dom.query(root, '#gResultCard');
      if (resultCard) resultCard.scrollIntoView({ behavior: 'smooth' });
      loadHistory(root);
      renderRecommend(root);
      lc.done();
    } catch (e) {
      lc.fail(e, null, null, '生成失敗：');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ 產生內容'; }
    }
  }

  function resetWizard(root) {
    const dom = AIMC.DOM.forPage('Generate');
    resetPicked();
    dom.hide(root, '#gResultCard');
    root.querySelectorAll('.pick-card.selected').forEach((c) => c.classList.remove('selected'));
    dom.html(root, '#gTopicGrid', '');
    dom.html(root, '#gPlatformGrid', '');
    dom.html(root, '#gGoalGrid', '');
    dom.html(root, '#gKnowledgeWorkflowCard', '');
    dom.html(root, '#gTopicWorkflowCard', '');
    dom.html(root, '#gPromptWorkflowCard', '');
    setGenerateEnabled(root, dom, true);
    goStep(root, dom, 1);
  }

  async function loadHistory(root) {
    const lc = AIMC.startLifecycle('Generate:loadHistory');
    lc.dom.html(root, '#gHistoryBody', '<tr><td colspan="5" class="empty">載入中...</td></tr>');
    try {
      const { data } = await AIMC.api('/content-history');
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.history = data;
      if (!data.length) { lc.dom.html(root, '#gHistoryBody', '<tr><td colspan="5" class="empty">尚無生成紀錄</td></tr>'); lc.done(); return; }
      lc.dom.html(root, '#gHistoryBody', data.map((h) => `
        <tr>
          <td>${AIMC.platformLabel(h.platform)}</td>
          <td>${AIMC.esc((h.generation_params && h.generation_params.content_goal) || '-')}</td>
          <td>${AIMC.esc((h.generated_text || '').slice(0, 40))}...</td>
          <td>${AIMC.badge(h.status, h.status)}</td>
          <td class="muted">${AIMC.fmtTime(h.created_at)}</td>
        </tr>`).join(''));
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#gHistoryBody');
    }
  }

  // ── Part 6：Page API —— destroy / resume / pause ──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return load(root); } // 回到此頁時視同重新載入，確保商品/主題/推薦都是最新
  function pause() { console.info('[AIMC] Generate paused（目前無長駐 timer，純狀態標記）'); }
  function refresh(root) { return load(root); } // Generate 沒有單一的重新整理概念，等同重新載入整頁

  AIMC.pages.generate = { load, destroy, refresh, resume, pause };
})();
