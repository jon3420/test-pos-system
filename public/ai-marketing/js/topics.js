// ============================================================
// topics.js — 主題 Workspace（Master-Detail）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /topics 端點，不做任何邏輯變更。
// ============================================================
(function () {
  let selectedId = null;

  async function load(root) {
    root.querySelector('#t_createBtn').addEventListener('click', () => createTopic(root));
    root.querySelector('#t_refreshBtn').addEventListener('click', () => refresh(root));
    await loadProductOptions(root);
    await refresh(root);
  }

  async function loadProductOptions(root) {
    const sel = root.querySelector('#t_product_select');
    try {
      const { data } = await AIMC.api('/knowledge');
      AIMC.store.knowledge = data;
      sel.innerHTML = data.length
        ? data.map((k) => `<option value="${AIMC.esc(k.external_product_id)}">${AIMC.esc(k.product_name)}（${AIMC.esc(k.external_product_id)}）</option>`).join('')
        : '<option value="">請先建立商品知識</option>';
    } catch (e) { sel.innerHTML = '<option value="">載入失敗</option>'; }
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
      refresh(root);
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
    if (!s.topics.length) { el.innerHTML = AIMC.emptyState('📝', '尚無主題'); return; }
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
        <button class="btn ghost sm" onclick="location.hash='#/generate'">✨ 去生成內容</button>
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
