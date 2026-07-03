// ============================================================
// topics.js — 主題 Workspace V3（Master-Detail + AI Topic Suggestions）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /topics 端點，不做任何邏輯變更。
// AI Topic Suggestions 為前端規則式建議（依商品名稱關鍵字比對），
// 「一鍵建立」仍是呼叫既有的 POST /topics，不新增任何 API。
// 支援路由參數 #/topics/<external_product_id>：自動預選對應商品並顯示建議。
// ============================================================
(function () {
  let selectedId = null;

  // 規則式主題建議字典：依商品名稱關鍵字比對；找不到比對時使用通用建議。
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
    root.querySelector('#t_createBtn').addEventListener('click', () => createTopic(root));
    root.querySelector('#t_refreshBtn').addEventListener('click', () => refresh(root));
    root.querySelector('#t_product_select').addEventListener('change', (e) => renderSuggestions(root, e.target.value));
    await loadProductOptions(root);

    if (param) {
      const sel = root.querySelector('#t_product_select');
      if ([...sel.options].some((o) => o.value === param)) {
        sel.value = param;
        renderSuggestions(root, param);
      }
    } else {
      renderSuggestions(root, root.querySelector('#t_product_select').value);
    }

    await refresh(root);
  }

  async function loadProductOptions(root) {
    const sel = root.querySelector('#t_product_select');
    try {
      const { data } = await AIMC.api('/knowledge');
      AIMC.store.knowledge = data;
      sel.innerHTML = data.length
        ? data.map((k) => `<option value="${AIMC.esc(k.external_product_id)}" data-name="${AIMC.esc(k.product_name)}">${AIMC.esc(k.product_name)}（${AIMC.esc(k.external_product_id)}）</option>`).join('')
        : '<option value="">請先建立商品知識</option>';
    } catch (e) { sel.innerHTML = '<option value="">載入失敗</option>'; }
  }

  function renderSuggestions(root, externalProductId) {
    const sel = root.querySelector('#t_product_select');
    const label = root.querySelector('#t_suggestProductLabel');
    const chipsEl = root.querySelector('#t_suggestionChips');
    const opt = [...sel.options].find((o) => o.value === externalProductId);
    if (!opt || !externalProductId) {
      label.textContent = '';
      chipsEl.innerHTML = '<span class="muted">請先選擇對應商品</span>';
      return;
    }
    const productName = opt.dataset.name || opt.textContent;
    label.textContent = `依「${productName}」推導`;
    const existingTitles = new Set(AIMC.store.topics.filter((t) => t.external_product_id === externalProductId).map((t) => t.title));
    const items = suggestionsForProduct(productName);
    chipsEl.innerHTML = items.map((it) => {
      const title = productName + it.kw;
      const already = existingTitles.has(title);
      return `<span class="suggestion-chip">🏷️ ${AIMC.esc(it.kw)}（${AIMC.esc(it.cat)}）
        <button class="btn ${already ? 'secondary' : 'ai'} sm" data-kw="${AIMC.esc(it.kw)}" data-cat="${AIMC.esc(it.cat)}" ${already ? 'disabled' : ''}>${already ? '已建立' : '一鍵建立'}</button>
      </span>`;
    }).join('');
    chipsEl.querySelectorAll('[data-kw]').forEach((btn) => {
      btn.addEventListener('click', () => quickCreateTopic(root, externalProductId, productName, btn.dataset.kw, btn.dataset.cat));
    });
  }

  async function quickCreateTopic(root, externalProductId, productName, kw, cat) {
    const title = productName + kw;
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id: externalProductId, title, category: cat, priority: 0 } });
      AIMC.toast(`已一鍵建立主題「${title}」`);
      await refresh(root);
      renderSuggestions(root, externalProductId);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function createTopic(root) {
    const external_product_id = root.querySelector('#t_product_select').value;
    const title = root.querySelector('#t_title').value.trim();
    const category = root.querySelector('#t_category').value;
    const priority = Number(root.querySelector('#t_priority').value) || 0;
    if (!external_product_id || !title) return AIMC.toast('請選擇商品並填寫標題', true);
    try {
      await AIMC.api('/topics', { method: 'POST', body: { external_product_id, title, category, priority } });
      AIMC.toast('已建立主題');
      root.querySelector('#t_title').value = '';
      await refresh(root);
      renderSuggestions(root, external_product_id);
    } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
  }

  async function refresh(root) {
    root.querySelector('#t_listContainer').innerHTML = AIMC.loadingHtml();
    try {
      const [{ data }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      AIMC.store.topics = data; AIMC.store.prompts = prompts; AIMC.store.history = history;
      renderStats(root);
      renderList(root);
      if (selectedId && data.some((t) => t.id === selectedId)) renderDetail(root, selectedId);
      else if (data.length) { selectedId = data[0].id; renderDetail(root, selectedId); }
      else { selectedId = null; root.querySelector('#t_detailPane').innerHTML = '<div class="empty">請從左側選擇一個主題查看詳情</div>'; }
    } catch (e) {
      root.querySelector('#t_listContainer').innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  function renderStats(root) {
    const s = AIMC.store;
    const genTopicIds = new Set(s.history.map((h) => h.topic_id).filter(Boolean));
    const approvedTopicIds = new Set(s.history.filter((h) => h.status === 'approved').map((h) => h.topic_id).filter(Boolean));
    const total = s.topics.length;
    const generated = s.topics.filter((t) => genTopicIds.has(t.id)).length;
    const notGenerated = total - generated;
    const approved = s.topics.filter((t) => approvedTopicIds.has(t.id)).length;
    const completeness = total ? Math.round((approved / total) * 100) : 0;
    root.querySelector('#tStatGrid').innerHTML = [
      AIMC.statCard('📝', total, '主題數'),
      AIMC.statCard('✅', generated, '已生成數'),
      AIMC.statCard('⬜', notGenerated, '未生成數'),
      AIMC.statCard('👍', approved, '已審核數'),
      AIMC.statCard('📈', completeness + '%', '完成度'),
    ].join('');
  }

  function renderList(root) {
    const s = AIMC.store;
    const el = root.querySelector('#t_listContainer');
    if (!s.topics.length) { el.innerHTML = AIMC.emptyState('📝', '尚無主題，可用上方 AI Topic Suggestions 一鍵建立'); return; }
    el.innerHTML = s.topics.map((t) => `
      <div class="master-list-item ${t.id === selectedId ? 'active' : ''}" data-id="${t.id}">
        <div class="mli-title">${AIMC.esc(t.title)}</div>
        <div class="mli-sub">${AIMC.esc(t.product_name)} ・ ${AIMC.esc(t.category)} ${t.claim_sensitive ? ' ・ ⚠️敏感' : ''}</div>
      </div>`).join('');
    el.querySelectorAll('[data-id]').forEach((item) => {
      item.addEventListener('click', () => { selectedId = item.dataset.id; renderList(root); renderDetail(root, selectedId); });
    });
  }

  function renderDetail(root, id) {
    const s = AIMC.store;
    const t = s.topics.find((x) => x.id === id);
    const pane = root.querySelector('#t_detailPane');
    if (!t) { pane.innerHTML = '<div class="empty">請從左側選擇一個主題查看詳情</div>'; return; }
    const relatedPrompts = s.prompts.filter((p) => p.topic_id === t.id);
    const goals = [...new Set(relatedPrompts.map((p) => p.content_goal))];
    const relatedHistory = s.history.filter((h) => h.topic_id === t.id);
    const risk = t.risk_level || 'low';

    pane.innerHTML = `
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
    `;
    pane.querySelector('#t_toggleBtn').addEventListener('click', () => toggleStatus(root, t));
    pane.querySelector('#t_deleteBtn').addEventListener('click', () => deleteTopic(root, t.id));
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

  AIMC.pages.topics = { load };
})();
