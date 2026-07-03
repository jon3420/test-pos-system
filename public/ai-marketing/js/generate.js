// ============================================================
// generate.js — AI Content Studio（AI 推薦生成 + 4 步驟 Wizard）
// 呼叫方式與欄位 100% 沿用 Phase 1 POST /generate，不做任何邏輯變更。
// 「AI 推薦生成」純粹是前端規則（從現有 topics/prompts/content-history
// 推導出一組「有 Prompt 但還沒生成過」的組合），按下後呼叫同一支 API。
// 支援路由參數 #/generate/<external_product_id>：自動選定該商品並跳到 Step 2。
// ============================================================
(function () {
  let step = 1;
  let picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };

  const PLATFORMS = ['fb', 'ig', 'threads', 'tiktok', 'line', 'google_business', 'youtube_shorts'];
  const GOALS = ['教育', '促銷', 'FAQ', '品牌故事', '顧客見證', 'SEO', '短影音', '圖文', 'Google商家', 'general'];
  const STEP_LABELS = ['商品', '主題', '平台', '內容目的'];

  async function load(root, param) {
    resetPicked();
    step = 1;
    renderSteps(root);
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => goStep(root, Number(b.dataset.back))));
    root.querySelector('#gGenerateBtn').addEventListener('click', () => doGenerate(root));
    root.querySelector('#gAgainBtn').addEventListener('click', () => resetWizard(root));
    root.querySelector('#gHistoryRefreshBtn').addEventListener('click', () => loadHistory(root));
    root.querySelector('#gRecRefreshBtn').addEventListener('click', () => renderRecommend(root));

    await loadProducts(root);
    await loadHistory(root);
    await renderRecommend(root);

    if (param) {
      const card = root.querySelector(`#gProductGrid [data-id="${CSS.escape(param)}"]`);
      if (card) await selectProduct(root, card);
    }
  }

  function resetPicked() {
    picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };
  }

  // ── AI 推薦生成：找出「有 Prompt、但尚未生成過內容」的主題，優先推薦 ──
  async function renderRecommend(root) {
    const el = root.querySelector('#gRecommend');
    el.innerHTML = AIMC.loadingHtml();
    try {
      const [{ data: topics }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      AIMC.store.topics = topics; AIMC.store.prompts = prompts; AIMC.store.history = history;

      const promptsByTopic = {};
      prompts.forEach((p) => { if (p.topic_id) (promptsByTopic[p.topic_id] ||= []).push(p); });
      const genTopicIds = new Set(history.map((h) => h.topic_id).filter(Boolean));

      const candidates = topics
        .filter((t) => t.status === 'active' && (promptsByTopic[t.id] || []).length)
        .map((t) => ({ topic: t, prompts: promptsByTopic[t.id], hasGenerated: genTopicIds.has(t.id) }));

      if (!candidates.length) {
        el.innerHTML = AIMC.emptyState('🤖', '目前沒有「已建立 Prompt」的主題，請先到「Prompt」建立範本，AI 才能推薦生成組合。');
        return;
      }
      // 優先推薦尚未生成過的，其次依優先度排序
      candidates.sort((a, b) => (a.hasGenerated === b.hasGenerated ? b.topic.priority - a.topic.priority : (a.hasGenerated ? 1 : -1)));
      const best = candidates[0];
      const prompt = best.prompts.find((p) => p.is_default) || best.prompts[0];

      el.innerHTML = `
        <div class="recommend-card">
          <div class="rc-head">⚡ ${AIMC.esc(best.topic.product_name)} → ${AIMC.esc(best.topic.title)} → ${AIMC.esc(AIMC.platformLabel(prompt.platform))} → ${AIMC.esc(prompt.content_goal)}</div>
          <p class="muted" style="margin:6px 0 0">${best.hasGenerated ? '此主題已生成過內容，可以再生成一篇新素材。' : '此主題尚未生成過內容，建議優先產生第一篇。'}</p>
          <div class="rc-ctas"><button class="btn ai sm" id="gRecGoBtn">⚡ 一鍵生成</button></div>
        </div>`;
      root.querySelector('#gRecGoBtn').addEventListener('click', () => quickGenerate(root, best.topic, prompt));
    } catch (e) {
      el.innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  async function quickGenerate(root, topic, prompt) {
    picked = {
      external_product_id: topic.external_product_id, product_name: topic.product_name,
      topic_id: topic.id, topic_title: topic.title,
      platform: prompt.platform, content_goal: prompt.content_goal,
    };
    step = 4;
    renderSteps(root);
    await doGenerate(root);
  }

  function renderSteps(root) {
    root.querySelector('#gSteps').innerHTML = STEP_LABELS.map((l, i) => {
      const n = i + 1;
      let cls = 'wizard-step';
      if (n < step) cls += ' done'; else if (n === step) cls += ' active';
      const connector = i < STEP_LABELS.length - 1 ? '<div class="wizard-connector"></div>' : '';
      return `<div class="${cls}"><span class="ws-num">${n < step ? '✓' : n}</span>${l}</div>${connector}`;
    }).join('');
  }

  function goStep(root, n) {
    step = n;
    renderSteps(root);
    [1, 2, 3, 4].forEach((i) => root.querySelector('#gPanel' + i).classList.toggle('active', i === n));
  }

  async function loadProducts(root) {
    const el = root.querySelector('#gProductGrid');
    try {
      const { data } = await AIMC.api('/knowledge');
      AIMC.store.knowledge = data;
      if (!data.length) { el.innerHTML = AIMC.emptyState('📦', '請先到「商品知識」建立商品'); return; }
      el.innerHTML = data.map((k) => `
        <div class="pick-card" data-id="${AIMC.esc(k.external_product_id)}" data-name="${AIMC.esc(k.product_name)}">
          <div class="pc-title">${AIMC.esc(k.product_name)}</div>
          <div class="pc-sub">${AIMC.esc(k.external_product_id)}</div>
        </div>`).join('');
      el.querySelectorAll('[data-id]').forEach((c) => c.addEventListener('click', () => selectProduct(root, c)));
    } catch (e) { el.innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`; }
  }

  async function selectProduct(root, cardEl) {
    picked.external_product_id = cardEl.dataset.id;
    picked.product_name = cardEl.dataset.name;
    root.querySelectorAll('#gProductGrid .pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    const el = root.querySelector('#gTopicGrid');
    el.innerHTML = AIMC.loadingHtml();
    try {
      const { data } = await AIMC.api('/topics?external_product_id=' + encodeURIComponent(picked.external_product_id));
      if (!data.length) {
        el.innerHTML = AIMC.emptyState('📝', '此商品尚無主題，請先到「主題」建立');
      } else {
        el.innerHTML = data.map((t) => `
          <div class="pick-card" data-id="${t.id}" data-title="${AIMC.esc(t.title)}">
            <div class="pc-title">${AIMC.esc(t.title)}</div>
            <div class="pc-sub">${AIMC.esc(t.category)}</div>
          </div>`).join('');
        el.querySelectorAll('[data-id]').forEach((c) => c.addEventListener('click', () => selectTopic(root, c)));
      }
    } catch (e) { el.innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`; }
    goStep(root, 2);
  }

  function selectTopic(root, cardEl) {
    picked.topic_id = cardEl.dataset.id;
    picked.topic_title = cardEl.dataset.title;
    root.querySelectorAll('#gTopicGrid .pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    renderPlatformGrid(root);
    goStep(root, 3);
  }

  function renderPlatformGrid(root) {
    const el = root.querySelector('#gPlatformGrid');
    el.innerHTML = PLATFORMS.map((p) => `
      <div class="pick-card" data-p="${p}"><div class="pc-title">${AIMC.esc(AIMC.platformLabel(p))}</div></div>`).join('');
    el.querySelectorAll('[data-p]').forEach((c) => c.addEventListener('click', () => selectPlatform(root, c)));
  }

  function selectPlatform(root, cardEl) {
    picked.platform = cardEl.dataset.p;
    root.querySelectorAll('#gPlatformGrid .pick-card').forEach((c) => c.classList.toggle('selected', c === cardEl));
    renderGoalGrid(root);
    goStep(root, 4);
  }

  function renderGoalGrid(root) {
    const el = root.querySelector('#gGoalGrid');
    el.innerHTML = GOALS.map((g) => `<div class="pick-card" data-g="${g}"><div class="pc-title">${g}</div></div>`).join('');
    el.querySelectorAll('[data-g]').forEach((c) => c.addEventListener('click', () => {
      picked.content_goal = c.dataset.g;
      el.querySelectorAll('.pick-card').forEach((x) => x.classList.toggle('selected', x === c));
    }));
  }

  async function doGenerate(root) {
    if (!picked.topic_id) return AIMC.toast('請選擇主題', true);
    if (!picked.platform) return AIMC.toast('請選擇平台', true);
    if (!picked.content_goal) return AIMC.toast('請選擇內容目的', true);
    const btn = root.querySelector('#gGenerateBtn');
    btn.disabled = true; if (btn.textContent) btn.textContent = '⏳ 生成中...';
    try {
      const { data } = await AIMC.api('/generate', {
        method: 'POST',
        body: { topic_id: picked.topic_id, platform: picked.platform, content_goal: picked.content_goal, content_type: 'text' },
      });
      const card = root.querySelector('#gResultCard');
      card.style.display = 'block';
      root.querySelector('#gResult').innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
          <div><div class="muted" style="margin-bottom:2px">平台</div><b>${AIMC.esc(AIMC.platformLabel(picked.platform))}</b></div>
          <div><div class="muted" style="margin-bottom:2px">商品</div><b>${AIMC.esc(picked.product_name || '-')}</b></div>
          <div><div class="muted" style="margin-bottom:2px">主題</div><b>${AIMC.esc(picked.topic_title || '-')}</b></div>
          <div><div class="muted" style="margin-bottom:2px">狀態</div>${AIMC.badge(data.status, data.status)}</div>
        </div>
        <div class="gen-result">${AIMC.esc(data.generated_text)}</div>
        <p class="muted" style="margin-top:8px">模型：${AIMC.esc(data.model_provider)}/${AIMC.esc(data.model_name)}　請至「審核」核准後才能排程發布（Phase 2 以後功能）</p>
      `;
      card.scrollIntoView({ behavior: 'smooth' });
      loadHistory(root);
      renderRecommend(root);
    } catch (e) {
      AIMC.toast('生成失敗：' + e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = '⚡ 產生內容';
    }
  }

  function resetWizard(root) {
    resetPicked();
    root.querySelector('#gResultCard').style.display = 'none';
    root.querySelectorAll('.pick-card.selected').forEach((c) => c.classList.remove('selected'));
    root.querySelector('#gTopicGrid').innerHTML = '';
    root.querySelector('#gPlatformGrid').innerHTML = '';
    root.querySelector('#gGoalGrid').innerHTML = '';
    goStep(root, 1);
  }

  async function loadHistory(root) {
    const tbody = root.querySelector('#gHistoryBody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">載入中...</td></tr>';
    try {
      const { data } = await AIMC.api('/content-history');
      AIMC.store.history = data;
      if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">尚無生成紀錄</td></tr>'; return; }
      tbody.innerHTML = data.map((h) => `
        <tr>
          <td>${AIMC.platformLabel(h.platform)}</td>
          <td>${AIMC.esc((h.generation_params && h.generation_params.content_goal) || '-')}</td>
          <td>${AIMC.esc((h.generated_text || '').slice(0, 40))}...</td>
          <td>${AIMC.badge(h.status, h.status)}</td>
          <td class="muted">${AIMC.fmtTime(h.created_at)}</td>
        </tr>`).join('');
    } catch (e) { tbody.innerHTML = `<tr><td colspan="5" class="empty">載入失敗：${AIMC.esc(e.message)}</td></tr>`; }
  }

  AIMC.pages.generate = { load };
})();
