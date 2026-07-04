// ============================================================
// topics.js — 主題 Workspace V3（Master-Detail + AI Topic Suggestions）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /topics 端點，不做任何邏輯變更。
// AI Topic Suggestions 為前端規則式建議（依商品名稱關鍵字比對），
// 「一鍵建立」仍是呼叫既有的 POST /topics，不新增任何 API。
// 支援路由參數 #/topics/<external_product_id>：自動預選對應商品並顯示建議。
//
// V3.1 Stability Pass：所有 DOM 讀寫改用 AIMC.DOM，refresh()/loadProductOptions()
// 這類「await 之後才寫 DOM」的函式都用 AIMC.startLifecycle() 做 Page Token 檢查。
// ============================================================
(function () {
  let selectedId = null;
  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用

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

  async function load(root, param) {
    const lc = AIMC.startLifecycle('Topics');
    currentDom = lc.dom;
    lc.dom.on(root, '#t_createBtn', 'click', () => createTopic(root));
    lc.dom.on(root, '#t_refreshBtn', 'click', () => refresh(root));
    lc.dom.on(root, '#t_product_select', 'change', (e) => renderSuggestions(root, lc.dom, e.target.value));
    lc.done('event bindings ready');

    await loadProductOptions(root);

    const sel = lc.dom.query(root, '#t_product_select');
    if (param && sel && [...sel.options].some((o) => o.value === param)) {
      sel.value = param;
      renderSuggestions(root, lc.dom, param);
    } else {
      renderSuggestions(root, lc.dom, sel ? sel.value : '');
    }

    await refresh(root);
  }

  async function loadProductOptions(root) {
    const lc = AIMC.startLifecycle('Topics:loadProductOptions');
    try {
      const { data } = await AIMC.api('/knowledge');
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.knowledge = data;
      lc.dom.html(root, '#t_product_select', data.length
        ? data.map((k) => `<option value="${AIMC.esc(k.external_product_id)}" data-name="${AIMC.esc(k.product_name)}">${AIMC.esc(k.product_name)}（${AIMC.esc(k.external_product_id)}）</option>`).join('')
        : '<option value="">請先建立商品知識</option>');
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#t_product_select');
    }
  }

  function renderSuggestions(root, dom, externalProductId) {
    const sel = dom.query(root, '#t_product_select');
    if (!sel) return;
    const opt = [...sel.options].find((o) => o.value === externalProductId);
    if (!opt || !externalProductId) {
      dom.text(root, '#t_suggestProductLabel', '');
      dom.html(root, '#t_suggestionChips', '<span class="muted">請先選擇對應商品</span>');
      return;
    }
    const productName = opt.dataset.name || opt.textContent;
    dom.text(root, '#t_suggestProductLabel', `依「${productName}」推導`);
    const existingTitles = new Set(AIMC.store.topics.filter((t) => t.external_product_id === externalProductId).map((t) => t.title));
    const items = suggestionsForProduct(productName);
    dom.html(root, '#t_suggestionChips', items.map((it) => {
      const title = productName + it.kw;
      const already = existingTitles.has(title);
      return `<span class="suggestion-chip">🏷️ ${AIMC.esc(it.kw)}（${AIMC.esc(it.cat)}）
        <button class="btn ${already ? 'secondary' : 'ai'} sm" data-kw="${AIMC.esc(it.kw)}" data-cat="${AIMC.esc(it.cat)}" ${already ? 'disabled' : ''}>${already ? '已建立' : '一鍵建立'}</button>
      </span>`;
    }).join(''));
    const chipsEl = dom.query(root, '#t_suggestionChips');
    if (chipsEl) {
      chipsEl.querySelectorAll('[data-kw]').forEach((btn) => {
        btn.addEventListener('click', () => quickCreateTopic(root, dom, externalProductId, productName, btn.dataset.kw, btn.dataset.cat));
      });
    }
  }

  async function quickCreateTopic(root, dom, externalProductId, productName, kw, cat) {
    const title = productName + kw;
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id: externalProductId, title, category: cat, priority: 0 } });
      AIMC.toast(`已一鍵建立主題「${title}」`);
      await refresh(root);
      renderSuggestions(root, dom, externalProductId);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function createTopic(root) {
    const dom = AIMC.DOM.forPage('Topics');
    const external_product_id = dom.value(root, '#t_product_select');
    const title = (dom.value(root, '#t_title') || '').trim();
    const category = dom.value(root, '#t_category');
    const priority = Number(dom.value(root, '#t_priority')) || 0;
    if (!external_product_id || !title) return AIMC.toast('請選擇商品並填寫標題', true);
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id, title, category, priority } });
      AIMC.toast('已建立主題');
      dom.value(root, '#t_title', '');
      await refresh(root);
      renderSuggestions(root, dom, external_product_id);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function refresh(root) {
    const lc = AIMC.startLifecycle('Topics:refresh');
    currentDom = lc.dom;
    lc.dom.html(root, '#t_listContainer', AIMC.loadingHtml());
    try {
      const [{ data }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.topics = data; AIMC.store.prompts = prompts; AIMC.store.history = history;
      renderStats(root, lc.dom);
      renderList(root, lc.dom);
      if (selectedId && data.some((t) => t.id === selectedId)) renderDetail(root, lc.dom, selectedId);
      else if (data.length) { selectedId = data[0].id; renderDetail(root, lc.dom, selectedId); }
      else { selectedId = null; lc.dom.html(root, '#t_detailPane', '<div class="empty">請從左側選擇一個主題查看詳情</div>'); }
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#t_listContainer');
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

  function renderList(root, dom) {
    const s = AIMC.store;
    if (!s.topics.length) { dom.html(root, '#t_listContainer', AIMC.emptyState('📝', '尚無主題，可用上方 AI Topic Suggestions 一鍵建立')); return; }
    dom.html(root, '#t_listContainer', s.topics.map((t) => `
      <div class="master-list-item ${t.id === selectedId ? 'active' : ''}" data-id="${t.id}">
        <div class="mli-title">${AIMC.esc(t.title)}</div>
        <div class="mli-sub">${AIMC.esc(t.product_name)} ・ ${AIMC.esc(t.category)} ${t.claim_sensitive ? ' ・ ⚠️敏感' : ''}</div>
      </div>`).join(''));
    const el = dom.query(root, '#t_listContainer');
    if (el) {
      el.querySelectorAll('[data-id]').forEach((item) => {
        item.addEventListener('click', () => { selectedId = item.dataset.id; renderList(root, dom); renderDetail(root, dom, selectedId); });
      });
    }
  }

  function renderDetail(root, dom, id) {
    const s = AIMC.store;
    const t = s.topics.find((x) => x.id === id);
    if (!t) { dom.html(root, '#t_detailPane', '<div class="empty">請從左側選擇一個主題查看詳情</div>'); return; }
    const relatedPrompts = s.prompts.filter((p) => p.topic_id === t.id);
    const goals = [...new Set(relatedPrompts.map((p) => p.content_goal))];
    const relatedHistory = s.history.filter((h) => h.topic_id === t.id);
    const risk = t.risk_level || 'low';

    dom.html(root, '#t_detailPane', `
      <div class="flex-between">
        <h3 style="margin:0">${AIMC.esc(t.title)}</h3>
        <span class="badge ${t.status}">${t.status}</span>
      </div>
      <p class="muted">${AIMC.esc(t.product_name)} ・ 分類：${AIMC.esc(t.category)} ・ 優先度：${t.priority}</p>
      <div class="row-actions" style="margin-top:0">
        ${AIMC.badge(risk, 'risk-' + risk)}
        ${t.claim_sensitive ? AIMC.badge('⚠️ 需審慎審核', 'sensitive') : ''}
        ${goals.length ? goals.map((g) => AIMC.badge(g, 'outline')).join('') : '<span class="muted">尚無 Prompt</span>'}
      </div>

      <div class="card" style="margin-top:16px">
        <h3 style="font-size:13px">關聯 Prompt（${relatedPrompts.length}）</h3>
        ${relatedPrompts.length ? `<table><thead><tr><th>平台</th><th>目的</th><th>版本</th></tr></thead><tbody>
          ${relatedPrompts.map((p) => `<tr><td>${AIMC.platformLabel(p.platform)}</td><td>${AIMC.esc(p.content_goal)}</td><td>v${p.version}</td></tr>`).join('')}
        </tbody></table>` : AIMC.emptyState('🤖', '尚無 Prompt，前往「Prompt」建立')}
      </div>

      <div class="card">
        <h3 style="font-size:13px">🩺 此 Topic 可用 Prompt</h3>
        <div id="t_promptMatrix"></div>
      </div>

      <div class="card">
        <h3 style="font-size:13px">生成紀錄（${relatedHistory.length}）</h3>
        ${relatedHistory.length ? `<table><thead><tr><th>平台</th><th>狀態</th><th>時間</th></tr></thead><tbody>
          ${relatedHistory.slice(0, 8).map((h) => `<tr><td>${AIMC.platformLabel(h.platform)}</td><td><span class="badge ${h.status}">${h.status}</span></td><td class="muted">${AIMC.fmtTime(h.created_at)}</td></tr>`).join('')}
        </tbody></table>` : AIMC.emptyState('✨', '尚無生成紀錄，前往「AI生成」建立')}
      </div>

      <div class="row-actions">
        <button class="btn secondary sm" id="t_toggleBtn">${t.status === 'active' ? '⏸ 暫停' : '▶ 啟用'}</button>
        <button class="btn ghost sm" onclick="location.hash='#/generate/${encodeURIComponent(t.external_product_id)}'">✨ 去生成內容</button>
        <button class="btn danger sm" id="t_deleteBtn">刪除主題</button>
      </div>
    `);
    dom.on(root, '#t_toggleBtn', 'click', () => toggleStatus(root, t));
    dom.on(root, '#t_deleteBtn', 'click', () => deleteTopic(root, t.id));
    renderTopicPromptMatrix(root, dom, t);
  }

  // Hotfix16 Part 9：Topic Detail 顯示「此 Topic 可用 Prompt」矩陣（依平台分組，✔/✖ + 一鍵建立）
  const TOPIC_MATRIX_CONFIG = {
    fb: ['教育', '品牌故事', 'FAQ', '促銷'],
    line: ['推播', '回購'],
  };

  function renderTopicPromptMatrix(root, dom, t) {
    dom.html(root, '#t_promptMatrix', Object.keys(TOPIC_MATRIX_CONFIG).map((platform) => {
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
                ${i.ok ? '' : `<button class="link-btn hmx-fix" data-tm-platform="${platform}" data-tm-goal="${AIMC.esc(i.goal)}">一鍵建立</button>`}
              </div>`).join('')}
          </div>
        </div>`;
    }).join(''));
    const el = dom.query(root, '#t_promptMatrix');
    if (el) {
      el.querySelectorAll('[data-tm-platform]').forEach((b) => {
        b.addEventListener('click', () => fixTopicPrompt(root, t, b.dataset.tmPlatform, b.dataset.tmGoal));
      });
    }
  }

  async function fixTopicPrompt(root, t, platform, goal) {
    try {
      await AIMC.Workflow.ensurePrompt({ topic_id: t.id, platform, content_goal: goal });
      AIMC.toast(`已建立 ${AIMC.platformLabel(platform)} × ${goal} 的 Prompt`);
      await refresh(root);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function toggleStatus(root, t) {
    const next = t.status === 'active' ? 'paused' : 'active';
    try {
      await AIMC.api('/topics/' + t.id, { method: 'PATCH', body: { status: next } });
      refresh(root);
    } catch (e) { AIMC.toast('更新失敗：' + e.message, true); }
  }

  async function deleteTopic(root, id) {
    if (!confirm('確定刪除此主題？')) return;
    try {
      await AIMC.api('/topics/' + id, { method: 'DELETE' });
      AIMC.toast('已刪除');
      if (selectedId === id) selectedId = null;
      refresh(root);
    } catch (e) { AIMC.toast('刪除失敗：' + e.message, true); }
  }

  // ── Part 6：Page API —— destroy / resume / pause（refresh 已定義於上方）──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return refresh(root); }
  function pause() { console.info('[AIMC] Topics paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.topics = { load, destroy, refresh, resume, pause };
})();
