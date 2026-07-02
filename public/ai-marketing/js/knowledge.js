// ============================================================
// knowledge.js — 商品知識 Workspace
// CRUD 邏輯 100% 沿用 Phase 1：POST/PUT/DELETE /knowledge，欄位不變。
// 只是把原本「同一頁一張大表單」改成「列表 + 右側 Drawer 編輯」。
// ============================================================
(function () {
  let selectedId = null;

  const FORM_FIELDS = ['intro', 'features', 'story', 'ingredient_intro', 'technique', 'storage_method',
    'nutrition', 'brand_philosophy', 'faq', 'myths', 'pairing', 'seo_description'];

  async function load(root) {
    root.querySelector('#kNewBtn').addEventListener('click', () => openForm(null));
    root.querySelector('#kAiNewBtn').addEventListener('click', () => openForm(null, true));
    root.querySelector('#kRefreshBtn').addEventListener('click', () => refresh(root));
    await refresh(root);
  }

  async function refresh(root) {
    root.querySelector('#kListBody').innerHTML = '<tr><td colspan="9" class="empty">載入中...</td></tr>';
    try {
      const { data } = await AIMC.api('/knowledge');
      AIMC.store.knowledge = data;
      const [{ data: topics }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      AIMC.store.topics = topics; AIMC.store.prompts = prompts; AIMC.store.history = history;
      await AIMC.loadKnowledgeDetails();
      renderStats(root);
      renderList(root);
    } catch (e) {
      root.querySelector('#kListBody').innerHTML = `<tr><td colspan="9" class="empty">載入失敗：${AIMC.esc(e.message)}</td></tr>`;
    }
  }

  function renderStats(root) {
    const s = AIMC.store;
    const avg = s.knowledge.length
      ? Math.round(s.knowledge.reduce((sum, r) => sum + AIMC.calcCompleteness(s.knowledgeDetail[r.id]), 0) / s.knowledge.length)
      : 0;
    const pendingReview = s.history.filter((h) => h.status === 'generated').length;
    root.querySelector('#kStatGrid').innerHTML = [
      AIMC.statCard('📦', s.knowledge.length, '商品數'),
      AIMC.statCard('📚', s.knowledge.length, '已建知識數'),
      AIMC.statCard('📊', avg + '%', '平均完成度'),
      AIMC.statCard('📝', s.topics.length, 'Topic 數'),
      AIMC.statCard('✨', s.history.length, 'Generated 數'),
      AIMC.statCard('⏳', pendingReview, '待審核', 'warn'),
    ].join('');
  }

  function nextStepHint(topicsOfProduct, promptCount, genCount, pendingCount) {
    if (!topicsOfProduct.length) return '建議建立主題';
    if (!promptCount) return '建議建立 Prompt';
    if (!genCount) return '建議產生內容';
    if (pendingCount) return '有內容待審核';
    return '可持續優化或建立新主題';
  }

  function renderList(root) {
    const s = AIMC.store;
    const tbody = root.querySelector('#kListBody');
    if (!s.knowledge.length) {
      tbody.innerHTML = `<tr><td colspan="9">${AIMC.emptyState('📦', '尚無資料，請按「新增商品知識」或「🤖 AI 建立商品知識」')}</td></tr>`;
      return;
    }
    const { topicsByProduct, promptsByTopic, historyByTopic } = AIMC.buildDerivedMaps();
    tbody.innerHTML = s.knowledge.map((row) => {
      const pct = AIMC.calcCompleteness(s.knowledgeDetail[row.id]);
      const topicsOfProduct = topicsByProduct[row.external_product_id] || [];
      const topicIds = topicsOfProduct.map((t) => t.id);
      const promptCount = topicIds.reduce((sum, tid) => sum + (promptsByTopic[tid] || []).length, 0);
      const genList = topicIds.flatMap((tid) => historyByTopic[tid] || []);
      const pendingCount = genList.filter((h) => h.status === 'generated').length;
      const hint = nextStepHint(topicsOfProduct, promptCount, genList.length, pendingCount);
      const isSelected = row.id === selectedId;
      return `
      <tr class="row-clickable ${isSelected ? 'selected' : ''}" data-id="${row.id}">
        <td>${AIMC.esc(row.external_product_id)}</td>
        <td>${AIMC.esc(row.product_name)}</td>
        <td>${AIMC.miniBar(pct)}</td>
        <td>${topicsOfProduct.length}</td>
        <td>${promptCount}</td>
        <td>${genList.length}</td>
        <td>${pendingCount ? AIMC.badge(pendingCount, 'generated') : '0'}</td>
        <td><span class="next-step-hint">${AIMC.esc(hint)}</span></td>
        <td>
          <button class="link-btn" data-edit="${row.id}">編輯</button> ·
          <button class="link-btn" style="color:var(--danger)" data-del="${row.id}">刪除</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectedId = tr.dataset.id;
        renderList(root);
        renderPreview(root, selectedId);
      });
    });
    tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.edit)));
    tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeKnowledge(root, b.dataset.del)));
  }

  function fieldLabel(key) {
    const map = {
      intro: '商品介紹', features: '商品特色', story: '品牌故事', ingredient_intro: '食材介紹',
      technique: '工法介紹', storage_method: '保存方式', nutrition: '營養知識', brand_philosophy: '品牌理念',
      faq: '常見 FAQ', myths: '常見迷思', pairing: '推薦搭配', seo_description: 'SEO 說明',
    };
    return map[key] || key;
  }

  async function renderPreview(root, id) {
    const el = root.querySelector('#kPreview');
    el.innerHTML = AIMC.loadingHtml();
    try {
      const { data } = await AIMC.api('/knowledge/' + id);
      const blocks = FORM_FIELDS.filter((f) => data[f] && String(data[f]).trim())
        .map((f) => `<div style="margin-bottom:12px"><div class="muted" style="margin-bottom:4px">${fieldLabel(f)}</div><div>${AIMC.esc(data[f]).replace(/\n/g, '<br>')}</div></div>`)
        .join('');
      const tagsHtml = `
        <div class="row-actions" style="margin-top:0">
          ${(data.keywords || []).map((k) => AIMC.badge(k, 'outline')).join(' ')}
          ${(data.hashtags || []).map((k) => AIMC.badge(k, 'outline')).join(' ')}
        </div>`;
      el.innerHTML = `
        <div class="flex-between">
          <h3 style="margin:0">${AIMC.esc(data.product_name)}（${AIMC.esc(data.external_product_id)}）</h3>
          <button class="btn sm" data-edit="${data.id}">✏️ 編輯</button>
        </div>
        <p class="muted">v${data.version} ・ ${data.ai_usage_allowed ? '✅ AI 可用' : '🚫 AI 停用'}</p>
        ${blocks || AIMC.emptyState('📝', '此商品尚未填寫任何內容欄位')}
        ${tagsHtml}
      `;
      el.querySelector('[data-edit]').addEventListener('click', () => openForm(data.id));
    } catch (e) {
      el.innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  async function removeKnowledge(root, id) {
    if (!confirm('確定刪除此商品知識？（關聯的主題不會一併刪除）')) return;
    try {
      await AIMC.api('/knowledge/' + id, { method: 'DELETE' });
      AIMC.toast('已刪除');
      if (selectedId === id) { selectedId = null; root.querySelector('#kPreview').innerHTML = '<div class="empty">點擊上方任一商品，即可在此預覽完整知識內容</div>'; }
      refresh(root);
    } catch (e) { AIMC.toast('刪除失敗：' + e.message, true); }
  }

  function formHtml(data, aiDraftMode) {
    const v = (k) => AIMC.esc(data && data[k] || '');
    return `
      <div class="grid">
        <div class="field"><label>商品編號 external_product_id *</label><input type="text" id="f_external_product_id" value="${v('external_product_id')}" ${data ? 'disabled' : ''} placeholder="例如 P0001"></div>
        <div class="field"><label>商品名稱 *</label><input type="text" id="f_product_name" value="${v('product_name')}" placeholder="例如 冷拌麻油豬腰"></div>
        <div class="field"><label>分類名稱</label><input type="text" id="f_category_name" value="${v('category_name')}" placeholder="例如 熱炒"></div>
        <div class="field"><label>是否允許 AI 使用</label>
          <select id="f_ai_usage_allowed">
            <option value="true" ${!data || data.ai_usage_allowed ? 'selected' : ''}>允許</option>
            <option value="false" ${data && !data.ai_usage_allowed ? 'selected' : ''}>不允許</option>
          </select>
        </div>
      </div>
      <div class="grid full">
        ${FORM_FIELDS.map((f) => `<div class="field"><label>${fieldLabel(f)}</label><textarea id="f_${f}">${v(f)}</textarea></div>`).join('')}
      </div>
      <div class="grid">
        <div class="field"><label>關鍵字 / SEO Keyword（逗號分隔）</label><input type="text" id="f_keywords" value="${AIMC.esc((data && data.keywords || []).join(', '))}"></div>
        <div class="field"><label>Hashtag（逗號分隔）</label><input type="text" id="f_hashtags" value="${AIMC.esc((data && data.hashtags || []).join(', '))}"></div>
      </div>
      <p class="muted" id="f_aiHint" style="display:${aiDraftMode ? 'block' : 'none'}">✏️ 以下為 AI 產生的草稿內容，請確認 / 修改後再按「儲存」，AI 不會自動發布任何內容。</p>
      <div class="row-actions">
        <button class="btn ai sm" id="f_aiDraftBtn" type="button">🤖 AI 產生草稿</button>
      </div>
      <div class="row-actions">
        <button class="btn" id="f_saveBtn" type="button">💾 儲存</button>
        <button class="btn secondary" id="f_cancelBtn" type="button">取消</button>
      </div>
    `;
  }

  function collectPayload() {
    const g = (id) => document.getElementById(id).value;
    return {
      external_product_id: g('f_external_product_id').trim(),
      product_name: g('f_product_name').trim(),
      category_name: g('f_category_name').trim() || undefined,
      intro: g('f_intro'), features: g('f_features'), story: g('f_story'),
      ingredient_intro: g('f_ingredient_intro'), technique: g('f_technique'), storage_method: g('f_storage_method'),
      nutrition: g('f_nutrition'), brand_philosophy: g('f_brand_philosophy'),
      faq: g('f_faq'), myths: g('f_myths'), pairing: g('f_pairing'), seo_description: g('f_seo_description'),
      keywords: g('f_keywords').split(',').map((s) => s.trim()).filter(Boolean),
      hashtags: g('f_hashtags').split(',').map((s) => s.trim()).filter(Boolean),
      ai_usage_allowed: g('f_ai_usage_allowed') === 'true',
    };
  }

  // 🤖 AI 建立商品知識（草稿）— 純前端範本文字，不呼叫外部 AI/LLM API，
  // 需使用者確認後按「儲存」才會呼叫既有的 POST/PUT /knowledge。
  function fillAiDraft() {
    const name = document.getElementById('f_product_name').value.trim();
    const category = document.getElementById('f_category_name').value.trim();
    if (!name) { AIMC.toast('請先輸入商品名稱，AI 才能產生草稿', true); return; }
    const cat = category || '本店';
    const setIfEmpty = (id, val) => { const el = document.getElementById(id); if (!el.value.trim()) el.value = val; };
    setIfEmpty('f_intro', `${name}是${cat}類別中的人氣品項，選用新鮮食材用心製作，每一口都能感受到店家對品質的堅持。`);
    setIfEmpty('f_features', `- 選用當日新鮮食材\n- 職人手法製作，口感層次豐富\n- 適合搭配多種主餐或單點享用`);
    setIfEmpty('f_story', `${name}的誕生源自店家對${cat}的堅持，經過反覆調整配方與作法，才呈現出現在的風味。`);
    setIfEmpty('f_technique', `製作${name}時，會特別注意食材處理與烹調時間的掌控，確保口感與風味達到最佳平衡。`);
    setIfEmpty('f_nutrition', `${name}提供均衡的營養來源，可依個人需求作為正餐或加菜選項。`);
    setIfEmpty('f_faq', `Q1：${name}會不會很辣或很油？\nA：可依個人口味調整，建議點餐時告知店員。`);
    setIfEmpty('f_myths', `迷思：${cat}類商品都很不健康？\n澄清：${name}選用適量調味與新鮮食材，適度享用並不會造成負擔。`);
    setIfEmpty('f_pairing', `推薦搭配：白飯、湯品，或與其他${cat}品項一起點餐。`);
    setIfEmpty('f_seo_description', `${name}｜${cat}推薦｜新鮮食材、職人手法製作`);
    setIfEmpty('f_keywords', `${name}, ${cat}, 推薦, 必吃`);
    setIfEmpty('f_hashtags', `#${name.replace(/\s/g, '')}, #${cat.replace(/\s/g, '')}美食`);
    document.getElementById('f_aiHint').style.display = 'block';
    AIMC.toast('AI 已產生草稿，請確認內容後再儲存');
  }

  async function openForm(id, aiDraftMode) {
    let data = null;
    if (id) {
      try { data = (await AIMC.api('/knowledge/' + id)).data; } catch (e) { AIMC.toast('讀取失敗：' + e.message, true); return; }
    }
    const body = AIMC.openDrawer(id ? `編輯商品知識（${AIMC.esc(data.product_name)}）` : 'Step ① → ② 新增商品知識', formHtml(data, aiDraftMode));
    body.querySelector('#f_aiDraftBtn').addEventListener('click', fillAiDraft);
    body.querySelector('#f_cancelBtn').addEventListener('click', () => AIMC.closeDrawer());
    body.querySelector('#f_saveBtn').addEventListener('click', async () => {
      const payload = collectPayload();
      if (!payload.external_product_id || !payload.product_name) return AIMC.toast('商品編號與商品名稱為必填', true);
      try {
        if (id) {
          await AIMC.api('/knowledge/' + id, { method: 'PUT', body: payload });
          AIMC.toast('已更新知識');
        } else {
          await AIMC.api('/knowledge', { method: 'POST', body: payload });
          AIMC.toast('已建立知識');
        }
        AIMC.closeDrawer();
        const root = document.getElementById('workspace');
        refresh(root);
      } catch (e) {
        if (String(e.message).includes('ALREADY_EXISTS') || String(e.message).includes('已有知識')) {
          AIMC.toast('此商品已有知識，請從列表點「編輯」', true);
        } else {
          AIMC.toast('儲存失敗：' + e.message, true);
        }
      }
    });
    if (aiDraftMode) fillAiDraft();
  }

  AIMC.pages.knowledge = { load };
})();
