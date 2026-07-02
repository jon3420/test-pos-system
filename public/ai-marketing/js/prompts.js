// ============================================================
// prompts.js — Prompt Workspace（平台分頁 × 內容目的分組）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /prompts 端點，不做任何邏輯變更。
// ============================================================
(function () {
  let activePlatform = null;

  const PLATFORMS = ['fb', 'ig', 'threads', 'tiktok', 'line', 'google_business', 'youtube_shorts'];
  const CONTENT_GOALS = ['教育', '促銷', 'FAQ', '品牌故事', '顧客見證', 'SEO', '短影音', '圖文', 'Google商家', 'general'];
  const CONTENT_FORMATS = ['text', 'image', 'video', 'carousel'];

  async function load(root) {
    root.querySelector('#pNewBtn').addEventListener('click', () => openForm(root));
    root.querySelector('#pRefreshBtn').addEventListener('click', () => refresh(root));
    await refresh(root);
  }

  async function refresh(root) {
    root.querySelector('#pGoalGroups').innerHTML = AIMC.loadingHtml();
    try {
      const [{ data: prompts }, { data: topics }] = await Promise.all([AIMC.api('/prompts'), AIMC.api('/topics')]);
      AIMC.store.prompts = prompts;
      AIMC.store.topics = topics;
      renderTabs(root);
      renderGroups(root);
    } catch (e) {
      root.querySelector('#pGoalGroups').innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  function renderTabs(root) {
    const s = AIMC.store;
    const inUse = [...new Set(s.prompts.map((p) => p.platform))];
    const all = [...new Set([...PLATFORMS, ...inUse])];
    if (!activePlatform || !all.includes(activePlatform)) activePlatform = all[0] || 'fb';
    const el = root.querySelector('#pPlatformTabs');
    el.innerHTML = all.map((p) => {
      const count = s.prompts.filter((x) => x.platform === p).length;
      return `<div class="platform-tab ${p === activePlatform ? 'active' : ''}" data-p="${p}">${AIMC.esc(AIMC.platformLabel(p))}${count ? ` (${count})` : ''}</div>`;
    }).join('');
    el.querySelectorAll('[data-p]').forEach((t) => t.addEventListener('click', () => {
      activePlatform = t.dataset.p; renderTabs(root); renderGroups(root);
    }));
  }

  function renderGroups(root) {
    const s = AIMC.store;
    const el = root.querySelector('#pGoalGroups');
    const list = s.prompts.filter((p) => p.platform === activePlatform);
    if (!list.length) { el.innerHTML = AIMC.emptyState('🤖', '此平台尚無 Prompt，按上方「建立 Prompt」新增'); return; }
    const topicMap = Object.fromEntries(s.topics.map((t) => [t.id, t.title]));
    const byGoal = {};
    list.forEach((p) => { (byGoal[p.content_goal] ||= []).push(p); });
    el.innerHTML = Object.keys(byGoal).sort().map((goal) => `
      <div class="prompt-goal-title">🎯 ${AIMC.esc(goal)}</div>
      <table><thead><tr><th>格式</th><th>綁定主題</th><th>預設</th><th>版本</th><th></th></tr></thead><tbody>
        ${byGoal[goal].map((p) => `
          <tr>
            <td>${AIMC.esc(p.content_format)}</td>
            <td>${p.topic_id ? AIMC.esc(topicMap[p.topic_id] || p.topic_id) : '<span class="muted">通用</span>'}</td>
            <td>${p.is_default ? '⭐' : ''}</td>
            <td>v${p.version}</td>
            <td><button class="link-btn" data-del="${p.id}" style="color:var(--danger)">刪除</button></td>
          </tr>`).join('')}
      </tbody></table>
    `).join('');
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removePrompt(root, b.dataset.del)));
  }

  async function removePrompt(root, id) {
    if (!confirm('確定刪除此 Prompt？')) return;
    try {
      await AIMC.api('/prompts/' + id, { method: 'DELETE' });
      AIMC.toast('已刪除');
      refresh(root);
    } catch (e) { AIMC.toast('刪除失敗：' + e.message, true); }
  }

  function formHtml() {
    const s = AIMC.store;
    return `
      <div class="grid">
        <div class="field">
          <label>綁定主題（可留空 = 通用）</label>
          <select id="pf_topic">
            <option value="">（不綁定，通用 Prompt）</option>
            ${s.topics.map((t) => `<option value="${t.id}">${AIMC.esc(t.product_name)} - ${AIMC.esc(t.title)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>平台 *</label>
          <select id="pf_platform">${PLATFORMS.map((p) => `<option value="${p}" ${p === activePlatform ? 'selected' : ''}>${AIMC.esc(AIMC.platformLabel(p))}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>內容目的 *</label>
          <select id="pf_goal">${CONTENT_GOALS.map((g) => `<option value="${g}">${g}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>內容格式</label>
          <select id="pf_format">${CONTENT_FORMATS.map((f) => `<option value="${f}">${f}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>設為此 platform+目的 的預設 Prompt</label>
          <select id="pf_default"><option value="false">否</option><option value="true">是</option></select>
        </div>
      </div>
      <div class="field">
        <label>Prompt 模板 *（可用 {{store_name}} {{product.intro}} {{product.features}} {{topic.title}} {{topic.category}} 等變數）</label>
        <textarea id="pf_template" style="min-height:120px" placeholder="請依{{store_name}}的品牌語氣，為{{topic.title}}撰寫一篇貼文..."></textarea>
      </div>
      <div class="row-actions">
        <button class="btn sm" id="pf_saveBtn" type="button">➕ 建立</button>
        <button class="btn secondary sm" id="pf_cancelBtn" type="button">取消</button>
      </div>
    `;
  }

  function openForm(root) {
    const body = AIMC.openDrawer('④ 建立 Prompt', formHtml());
    body.querySelector('#pf_cancelBtn').addEventListener('click', () => AIMC.closeDrawer());
    body.querySelector('#pf_saveBtn').addEventListener('click', async () => {
      const template = body.querySelector('#pf_template').value.trim();
      if (!template) return AIMC.toast('請輸入 Prompt 模板內容', true);
      const payload = {
        topic_id: body.querySelector('#pf_topic').value || null,
        platform: body.querySelector('#pf_platform').value,
        content_goal: body.querySelector('#pf_goal').value,
        content_format: body.querySelector('#pf_format').value,
        is_default: body.querySelector('#pf_default').value === 'true',
        template,
      };
      try {
        await AIMC.api('/prompts', { method: 'POST', body: payload });
        AIMC.toast('已建立 Prompt');
        AIMC.closeDrawer();
        activePlatform = payload.platform;
        refresh(root);
      } catch (e) { AIMC.toast('建立失敗：' + e.message, true); }
    });
  }

  AIMC.pages.prompts = { load };
})();
