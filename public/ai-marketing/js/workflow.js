// ============================================================
// workflow.js — AIMC.Workflow — Zero Workflow Engine（Hotfix16）
//
// 目的：Generate / Dashboard / Knowledge / Topic / Prompt 五個頁面
// 共用同一套「檢查缺什麼 → 補什麼」邏輯，不要各頁各寫一份。
//
// 只呼叫既有端點 + 兩支新增的 idempotent 端點：
//   既有：GET /knowledge、GET /topics、GET /prompts、POST /knowledge/sync-pos-product
//   新增：POST /topics/ensure-defaults、POST /prompts/ensure-default
// 完全不碰 POST /topics、POST /prompts（那兩支是「使用者手動建立」用的舊端點，
// 語意是「一定新增」，不適合拿來做「不得重複建立」的初始化/自動補齊）。
//
// 不呼叫任何社群平台 API、不自動發布、不自動大量生成內容 —— 這裡只負責把
// Knowledge / Topic / Prompt 這三層「骨架」補齊，Generate 本身仍要使用者按下才會執行。
// ============================================================
window.AIMC = window.AIMC || { pages: {} };

(function () {
  const BASELINE_PLATFORM = 'fb';
  const BASELINE_GOAL = '教育';

  // ── 檢查（一律讀 AIMC.store 快取，呼叫端要自行確保資料是新的，
  //    通常在頁面 load()/refresh() 已經 fetch 過 knowledge/topics/prompts）──

  function checkKnowledge(externalProductId) {
    return AIMC.store.knowledge.find((k) => k.external_product_id === externalProductId) || null;
  }

  function checkTopic(externalProductId) {
    return AIMC.store.topics.filter((t) => t.external_product_id === externalProductId);
  }

  // 找 Prompt：優先 topic 專屬（同 platform+content_goal），否則店內該 platform+content_goal 的通用 Prompt。
  // 邏輯對齊 AIMC service routes/generate.js 實際查找順序，避免「前端說有、後端說沒有」的落差。
  function checkPrompt(topicId, platform, contentGoal) {
    const byTopic = AIMC.store.prompts.find(
      (p) => p.topic_id === topicId && p.platform === platform && p.content_goal === contentGoal
    );
    if (byTopic) return byTopic;
    return AIMC.store.prompts.find(
      (p) => !p.topic_id && p.platform === platform && p.content_goal === contentGoal && p.is_default
    ) || null;
  }

  // 依序回傳目前流程卡在哪一步：'knowledge' | 'topic' | 'prompt' | null（全部齊全）
  function nextMissingStep({ external_product_id, topic_id, platform, content_goal }) {
    if (!checkKnowledge(external_product_id)) return 'knowledge';
    const topics = checkTopic(external_product_id);
    if (!topics.length) return 'topic';
    const effectiveTopicId = topic_id || topics[0].id;
    if (platform && content_goal && !checkPrompt(effectiveTopicId, platform, content_goal)) return 'prompt';
    return null;
  }

  // ── 補齊（呼叫 API 後，同步更新 AIMC.store 對應快取，呼叫端不用自己再 refetch 一次）──

  async function ensureKnowledge(posProduct) {
    const { data, created } = await AIMC.api('/knowledge/sync-pos-product', {
      method: 'POST',
      body: {
        external_product_id: posProduct.external_product_id,
        product_name: posProduct.product_name,
        category_name: posProduct.category_name || undefined,
        price: posProduct.price,
        product_image_url: posProduct.product_image_url,
        active: posProduct.active,
      },
    });
    const idx = AIMC.store.knowledge.findIndex((k) => k.external_product_id === posProduct.external_product_id);
    const row = { ...data, external_product_id: posProduct.external_product_id, product_name: posProduct.product_name };
    if (idx >= 0) AIMC.store.knowledge[idx] = { ...AIMC.store.knowledge[idx], ...row };
    else AIMC.store.knowledge.push(row);
    AIMC.store.knowledgeDetail[data.id] = data;
    return { created, data };
  }

  async function ensureTopic(externalProductId) {
    const { data } = await AIMC.api('/topics/ensure-defaults', {
      method: 'POST',
      body: { external_product_id: externalProductId },
    });
    if (data.created && data.created.length) {
      data.created.forEach((t) => AIMC.store.topics.push(t));
    }
    return data; // { created:[...], skipped:[...], created_count, skipped_count }
  }

  async function ensurePrompt({ topic_id, platform, content_goal, content_format }) {
    const { data, created } = await AIMC.api('/prompts/ensure-default', {
      method: 'POST',
      body: { topic_id: topic_id || null, platform, content_goal, content_format: content_format || 'text' },
    });
    const idx = AIMC.store.prompts.findIndex((p) => p.id === data.id);
    if (idx >= 0) AIMC.store.prompts[idx] = data;
    else AIMC.store.prompts.push(data);
    return { created, data };
  }

  // ── 一鍵初始化：對「單一商品」跑完 Knowledge → Topic → 基準 Prompt ──
  // 回傳每一層的 created/skipped，供初始化結果彙總畫面顯示「已存在/已跳過/新建立」。
  async function initProduct(posProduct) {
    const result = { external_product_id: posProduct.external_product_id, product_name: posProduct.product_name };

    const { created: knowledgeCreated } = await ensureKnowledge(posProduct);
    result.knowledge = knowledgeCreated ? 'created' : 'existing';

    const topicResult = await ensureTopic(posProduct.external_product_id);
    result.topic = topicResult.created_count > 0
      ? (topicResult.skipped_count > 0 ? 'partial' : 'created')
      : 'existing';
    result.topicCreated = topicResult.created_count;
    result.topicSkipped = topicResult.skipped_count;

    // 基準 Prompt 掛在該商品目前第一個主題上（哪個主題不影響生成品質，
    // content_goal/platform 才是決定內容方向的關鍵，topic 只是分類掛點）
    const topics = checkTopic(posProduct.external_product_id);
    if (topics.length) {
      const { created: promptCreated } = await ensurePrompt({
        topic_id: topics[0].id, platform: BASELINE_PLATFORM, content_goal: BASELINE_GOAL,
      });
      result.prompt = promptCreated ? 'created' : 'existing';
    } else {
      result.prompt = 'skipped'; // 理論上不會發生（ensureTopic 一定至少建立通用主題包）
    }

    return result;
  }

  // 對「全店所有 POS 商品」執行一鍵初始化。onProgress(i, total, result) 供 UI 顯示進度。
  async function runInit(onProgress) {
    const posProducts = await AIMC.loadPosProducts();
    const summary = {
      total: posProducts.length,
      knowledge: { created: 0, existing: 0 },
      topic: { created: 0, existing: 0, skippedTitles: 0 },
      prompt: { created: 0, existing: 0 },
      details: [],
    };
    for (let i = 0; i < posProducts.length; i++) {
      const p = posProducts[i];
      let result;
      try {
        result = await initProduct(p);
      } catch (e) {
        result = { external_product_id: p.external_product_id, product_name: p.product_name, error: e.message };
      }
      summary.details.push(result);
      if (!result.error) {
        summary.knowledge[result.knowledge === 'created' ? 'created' : 'existing'] += 1;
        summary.topic[result.topic === 'existing' ? 'existing' : 'created'] += 1;
        summary.topic.skippedTitles += result.topicSkipped || 0;
        summary.prompt[result.prompt === 'created' ? 'created' : 'existing'] += 1;
      }
      if (typeof onProgress === 'function') onProgress(i + 1, posProducts.length, result);
    }
    return summary;
  }

  // ── Inline Workflow Card：Generate（以及其他頁）用來取代工程錯誤 Toast ──
  // 回傳 HTML 字串，呼叫端負責把它塞進畫面、並綁定 [data-workflow-fix] 按鈕的 click。
  const CARD_COPY = {
    knowledge: { icon: '📚', title: '缺少商品知識', desc: '此商品尚未建立 AI 知識，需要先建立才能繼續。', cta: '立即建立' },
    topic: { icon: '📝', title: '缺少 Topic', desc: '此商品尚未有可用的行銷主題。', cta: '立即建立' },
    prompt: { icon: '🤖', title: '缺少 Prompt', desc: '尚未有符合此平台與內容目的的 Prompt 範本。', cta: '立即建立' },
  };

  function renderInlineCard(step, { platform, contentGoal } = {}) {
    const copy = CARD_COPY[step];
    if (!copy) return '';
    const sub = step === 'prompt' && platform && contentGoal
      ? `<div class="wf-sub">目前缺少 ${AIMC.esc(AIMC.platformLabel(platform))} × ${AIMC.esc(contentGoal)} Prompt</div>`
      : '';
    return `
      <div class="workflow-card" data-workflow-step="${step}">
        <div class="wf-icon">${copy.icon}</div>
        <div class="wf-body">
          <div class="wf-title">${copy.title}</div>
          <div class="wf-desc">${copy.desc}</div>
          ${sub}
        </div>
        <button class="btn ai sm" data-workflow-fix="${step}">${copy.cta}</button>
      </div>`;
  }

  // ── Generate 專用：STEP1-4 全自動跑完，缺什麼就回傳缺口讓呼叫端渲染 Inline Card；
  //    全部齊全時才真正呼叫既有 POST /generate。
  //    呼叫端傳入 { external_product_id, product_name, topic_id, platform, content_goal }，
  //    以及 hooks：{ onMissing(step, ctx), onReady() }（用於畫面切換提示，非必填）。
  async function runGenerateWorkflow(ctx, hooks = {}) {
    const { external_product_id, topic_id, platform, content_goal } = ctx;
    const missing = nextMissingStep({ external_product_id, topic_id, platform, content_goal });
    if (missing) {
      if (typeof hooks.onMissing === 'function') hooks.onMissing(missing, ctx);
      return { ok: false, missing };
    }
    if (typeof hooks.onReady === 'function') hooks.onReady(ctx);
    const effectiveTopicId = topic_id || checkTopic(external_product_id)[0].id;
    const { data } = await AIMC.api('/generate', {
      method: 'POST',
      body: { topic_id: effectiveTopicId, platform, content_goal, content_type: 'text' },
    });
    AIMC.store.history.unshift(data);
    return { ok: true, data };
  }

  // ── 一鍵初始化按鈕的共用 UI 邏輯（Dashboard / Knowledge / Settings 三處按鈕共用，
  //    避免每頁各寫一份進度條 + 結果彙總的渲染）──
  function renderInitSummaryHtml(summary) {
    const errorCount = summary.details.filter((d) => d.error).length;
    return `
      <div class="init-summary">
        <div class="init-summary-row"><span>📦 商品總數</span><b>${summary.total}</b></div>
        <div class="init-summary-row"><span>📚 Knowledge 草稿</span><b>新建立 ${summary.knowledge.created} ・ 已存在（跳過） ${summary.knowledge.existing}</b></div>
        <div class="init-summary-row"><span>📝 Topic</span><b>新建立 ${summary.topic.created} ・ 已存在（跳過） ${summary.topic.existing}</b></div>
        <div class="init-summary-row"><span>🤖 基準 Prompt（${AIMC.platformLabel(BASELINE_PLATFORM)}×${BASELINE_GOAL}）</span><b>新建立 ${summary.prompt.created} ・ 已存在（跳過） ${summary.prompt.existing}</b></div>
        ${errorCount ? `<div class="init-summary-errors">⚠️ ${errorCount} 個商品初始化時發生錯誤，可個別到「商品知識」補齊</div>` : `<div class="init-summary-ok">✅ 初始化完成，不會自動發布任何內容，請至各頁確認 / 補充細節</div>`}
      </div>`;
  }

  AIMC.runInitFlow = async function (root, resultSelector, onDone) {
    const dom = AIMC.DOM.forPage('Init');
    dom.html(root, resultSelector, `
      <div class="init-progress">
        <div class="init-progress-bar"><div class="init-progress-fill" style="width:0%"></div></div>
        <div class="init-progress-text">初始化中...</div>
      </div>`);
    try {
      const summary = await runInit((done, total, result) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        const fill = dom.query(root, resultSelector + ' .init-progress-fill');
        const text = dom.query(root, resultSelector + ' .init-progress-text');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `初始化中...（${done}/${total}）${AIMC.esc(result && result.product_name || '')}`;
      });
      dom.html(root, resultSelector, renderInitSummaryHtml(summary));
      AIMC.toast('AI 行銷中心初始化完成');
      if (typeof onDone === 'function') onDone(summary);
    } catch (e) {
      dom.html(root, resultSelector, `<div class="empty">初始化失敗：${AIMC.esc(e.message)}</div>`);
    }
  };

  AIMC.Workflow = {
    BASELINE_PLATFORM,
    BASELINE_GOAL,
    checkKnowledge,
    checkTopic,
    checkPrompt,
    nextMissingStep,
    ensureKnowledge,
    ensureTopic,
    ensurePrompt,
    initProduct,
    runInit,
    renderInlineCard,
    runGenerateWorkflow,
  };
})();
