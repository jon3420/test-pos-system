// ============================================================
// prompts.js — Prompt Workspace（平台分頁 × 內容目的分組 + Prompt Template）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /prompts 端點，不做任何邏輯變更。
//
// V3.1 Stability Pass：所有 DOM 讀寫改用 AIMC.DOM，refresh() 這種
// 「await 之後才寫 DOM」的函式用 AIMC.startLifecycle() 做 Page Token 檢查。
// ============================================================
(function () {
  let activePlatform = null;
  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用

  const PLATFORMS = ['fb', 'ig', 'threads', 'tiktok', 'line', 'google_business', 'youtube_shorts'];
  const CONTENT_GOALS = ['教育', '促銷', 'FAQ', '品牌故事', '顧客見證', 'SEO', '短影音', '圖文', 'Google商家', 'general'];
  const CONTENT_FORMATS = ['text', 'image', 'video', 'carousel'];

  async function load(root) {
    const lc = AIMC.startLifecycle('Prompts');
    currentDom = lc.dom;
    lc.dom.on(root, '#pNewBtn', 'click', () => openForm(root));
    lc.dom.on(root, '#pRefreshBtn', 'click', () => refresh(root));
    lc.done('event bindings ready');
    await refresh(root);
  }

  async function refresh(root) {
    const lc = AIMC.startLifecycle('Prompts:refresh');
    currentDom = lc.dom;
    lc.dom.html(root, '#pGoalGroups', AIMC.loadingHtml());
    try {
      const [{ data: prompts }, { data: topics }] = await Promise.all([AIMC.api('/prompts'), AIMC.api('/topics')]);
      if (!lc.checkpoint('API 完成')) return;
      AIMC.store.prompts = prompts;
      AIMC.store.topics = topics;
      renderTabs(root, lc.dom);
      renderGroups(root, lc.dom);
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#pGoalGroups');
    }
  }

  function renderTabs(root, dom) {
    const s = AIMC.store;
    const inUse = [...new Set(s.prompts.map((p) => p.platform))];
    const all = [...new Set([...PLATFORMS, ...inUse])];
    if (!activePlatform || !all.includes(activePlatform)) activePlatform = all[0] || 'fb';
    dom.html(root, '#pPlatformTabs', all.map((p) => {
      const count = s.prompts.filter((x) => x.platform === p).length;
      return `<div class="platform-tab ${p === activePlatform ? 'active' : ''}" data-p="${p}">${AIMC.esc(AIMC.platformLabel(p))}${count ? ` (${count})` : ''}</div>`;
    }).join(''));
    const el = dom.query(root, '#pPlatformTabs');
    if (el) {
      el.querySelectorAll('[data-p]').forEach((t) => t.addEventListener('click', () => {
        activePlatform = t.dataset.p; renderTabs(root, dom); renderGroups(root, dom);
      }));
    }
  }

  function renderGroups(root, dom) {
    const s = AIMC.store;
    const list = s.prompts.filter((p) => p.platform === activePlatform);
    if (!list.length) { dom.html(root, '#pGoalGroups', AIMC.emptyState('🤖', '此平台尚無 Prompt，按上方「建立 Prompt」新增')); return; }
    const topicMap = Object.fromEntries(s.topics.map((t) => [t.id, t.title]));
    const byGoal = {};
    list.forEach((p) => { (byGoal[p.content_goal] ||= []).push(p); });
    dom.html(root, '#pGoalGroups', Object.keys(byGoal).sort().map((goal) => `
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
    `).join(''));
    const el = dom.query(root, '#pGoalGroups');
    if (el) el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removePrompt(root, b.dataset.del)));
  }

  async function removePrompt(root, id) {
    if (!confirm('確定刪除此 Prompt？')) return;
    try {
      await AIMC.api('/prompts/' + id, { method: 'DELETE' });
      AIMC.toast('已刪除');
      refresh(root);
    } catch (e) { AIMC.toast('刪除失敗：' + e.message, true); }
  }

  // ── V3：Prompt Template 範本庫 ──
  // 涵蓋 FB / LINE / TikTok / Threads / Google 商家 × 常見內容目的，
  // 「使用範本」只是把文字填入既有的 Prompt 表單，仍要按「建立」才會呼叫既有 POST /prompts。
  const TEMPLATES = [
    { platform: 'fb', goal: '教育', label: 'FB・教育', template: '請依{{store_name}}的品牌語氣，為{{topic.title}}撰寫一篇教育型 Facebook 貼文，清楚說明{{product.intro}}，並自然帶入{{product.features}}，結尾附上一句互動提問。' },
    { platform: 'fb', goal: '促銷', label: 'FB・促銷', template: '請以促銷口吻，為{{topic.title}}撰寫一篇 Facebook 貼文，強調{{product.features}}的賣點，並附上限時優惠或行動呼籲（CTA）。' },
    { platform: 'fb', goal: '品牌故事', label: 'FB・品牌故事', template: '請以說故事的方式，介紹{{store_name}}與{{topic.title}}的故事：{{product.story}}，語氣溫暖真誠，帶出品牌理念。' },
    { platform: 'fb', goal: 'SEO', label: 'FB・SEO', template: '請撰寫一篇自然融入關鍵字「{{seo.keywords}}」的{{topic.title}}貼文，兼顧可讀性與 SEO，避免關鍵字堆砌。' },
    { platform: 'line', goal: 'FAQ', label: 'LINE・FAQ', template: '請針對顧客常見問題，為{{topic.title}}撰寫一則 LINE 官方帳號常見問答（FAQ）貼文，條列式呈現，簡潔易懂。' },
    { platform: 'line', goal: '促銷', label: 'LINE・促銷', template: '請為 LINE OA 撰寫一則{{topic.title}}促銷推播文案，字數精簡、語氣有吸引力，並附上明確的行動呼籲。' },
    { platform: 'line', goal: '教育', label: 'LINE・教育', template: '請以親切口吻，為 LINE OA 用戶介紹{{topic.title}}的知識重點：{{product.intro}}，段落簡短適合手機閱讀。' },
    { platform: 'tiktok', goal: '短影音', label: 'TikTok・短影音', template: '請為{{topic.title}}撰寫一支 15-30 秒 TikTok 短影音腳本，開頭 3 秒內要抓住注意力，包含分鏡提示與口白台詞。' },
    { platform: 'threads', goal: '顧客見證', label: 'Threads・顧客見證', template: '請以顧客第一人稱口吻，分享對{{topic.title}}的真實使用心得，語氣自然、不誇大，像朋友聊天一樣。' },
    { platform: 'threads', goal: '教育', label: 'Threads・教育', template: '請用輕鬆口語的方式，在 Threads 上分享一個關於{{topic.title}}的小知識：{{product.intro}}，適合搭配一句吸睛開頭。' },
    { platform: 'google_business', goal: 'Google商家', label: 'Google商家・更新', template: '請為 Google 商家檔案撰寫一篇關於{{topic.title}}的簡短更新貼文，包含營業重點與一句吸引顧客上門的說法。' },
    { platform: 'youtube_shorts', goal: '短影音', label: 'YouTube Shorts・短影音', template: '請為{{topic.title}}撰寫一支 60 秒內的 YouTube Shorts 腳本，含開場鉤子、主體內容與結尾 CTA。' },
  ];

  function renderTemplatePicker() {
    const options = TEMPLATES.map((t, i) => `<option value="${i}">${AIMC.esc(t.label)}</option>`).join('');
    return `
      <div class="template-picker">
        <div class="tp-row">
          <select id="pf_templatePicker">${options}</select>
          <button class="btn ai sm" id="pf_useTemplateBtn" type="button">📋 使用範本</button>
        </div>
        <p class="muted" style="margin:6px 0 0">套用後仍可自行修改文字，範本只是加速起手，不會直接建立 Prompt。</p>
      </div>`;
  }

  function formHtml() {
    const s = AIMC.store;
    return `
      ${renderTemplatePicker()}
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
    const dom = AIMC.DOM.forPage('Prompts:drawer');
    const body = AIMC.openDrawer('④ 建立 Prompt', formHtml());
    dom.on(body, '#pf_useTemplateBtn', 'click', () => {
      const idx = Number(dom.value(body, '#pf_templatePicker'));
      const tpl = TEMPLATES[idx];
      if (!tpl) return;
      dom.value(body, '#pf_platform', tpl.platform);
      dom.value(body, '#pf_goal', tpl.goal);
      dom.value(body, '#pf_template', tpl.template);
      AIMC.toast('已套用範本「' + tpl.label + '」，可依需要調整文字');
    });
    dom.on(body, '#pf_cancelBtn', 'click', () => AIMC.closeDrawer());
    dom.on(body, '#pf_saveBtn', 'click', async () => {
      const template = (dom.value(body, '#pf_template') || '').trim();
      if (!template) return AIMC.toast('請輸入 Prompt 模板內容', true);
      const payload = {
        topic_id: dom.value(body, '#pf_topic') || null,
        platform: dom.value(body, '#pf_platform'),
        content_goal: dom.value(body, '#pf_goal'),
        content_format: dom.value(body, '#pf_format'),
        is_default: dom.value(body, '#pf_default') === 'true',
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

  // ── Part 6：Page API —— destroy / resume / pause（refresh 已定義於上方）──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return refresh(root); }
  function pause() { console.info('[AIMC] Prompts paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.prompts = { load, destroy, refresh, resume, pause };
})();
