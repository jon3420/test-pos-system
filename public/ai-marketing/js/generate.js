// ============================================================
// generate.js — AI 生成 Wizard（商品 → 主題 → 平台 → 內容目的 → 生成）
// 呼叫方式與欄位 100% 沿用 Phase 1 POST /generate，不做任何邏輯變更。
// ============================================================
(function () {
  let step = 1;
  let picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };

  const PLATFORMS = ['fb', 'ig', 'threads', 'tiktok', 'line', 'google_business', 'youtube_shorts'];
  const GOALS = ['教育', '促銷', 'FAQ', '品牌故事', '顧客見證', 'SEO', '短影音', '圖文', 'Google商家', 'general'];
  const STEP_LABELS = ['商品', '主題', '平台', '內容目的'];

  async function load(root) {
    resetPicked();
    step = 1;
    renderSteps(root);
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => goStep(root, Number(b.dataset.back))));
    root.querySelector('#gGenerateBtn').addEventListener('click', () => doGenerate(root));
    root.querySelector('#gAgainBtn').addEventListener('click', () => resetWizard(root));
    root.querySelector('#gHistoryRefreshBtn').addEventListener('click', () => loadHistory(root));
    await loadProducts(root);
    await loadHistory(root);
  }

  function resetPicked() {
    picked = { external_product_id: null, product_name: null, topic_id: null, topic_title: null, platform: null, content_goal: null };
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
    btn.disabled = true; btn.textContent = '⏳ 生成中...';
    try {
      const { data } = await AIMC.api('/generate', {
        method: 'POST',
        body: { topic_id: picked.topic_id, platform: picked.platform, content_goal: picked.content_goal, content_type: 'text' },
      });
      const card = root.querySelector('#gResultCard');
      card.style.display = 'block';
      root.querySelector('#gResult').innerHTML = `
        <div class="gen-result">${AIMC.esc(data.generated_text)}</div>
        <p class="muted" style="margin-top:8px">模型：${AIMC.esc(data.model_provider)}/${AIMC.esc(data.model_name)}　狀態：${AIMC.badge(data.status, data.status)}　請至「審核」核准後才能排程發布（Phase 2 以後功能）</p>
      `;
      card.scrollIntoView({ behavior: 'smooth' });
      loadHistory(root);
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
