// ============================================================
// knowledge.js — 商品知識 V3「Product Health Center」
// CRUD 邏輯 100% 沿用 Phase 1：POST/PUT/DELETE /knowledge，欄位不變。
// 表格改成健康度卡片，編輯一律走右側 Drawer，不再有首頁大表單。
// 支援路由參數：
//   #/knowledge/new-ai   → 自動開啟「AI 建立商品知識」草稿表單
//   #/knowledge/<id>     → 自動開啟該商品的編輯 Drawer（來自 Dashboard CTA）
//
// V3.1 Stability Pass：所有 DOM 讀寫改用 AIMC.DOM（Safe DOM Library），
// refresh() 這種「有 await、之後才寫 DOM」的函式都用 AIMC.startLifecycle()
// 做 Page Token 檢查，使用者若在 await 期間切走，直接安全跳過，不 render。
// ============================================================
(function () {
  const FORM_FIELDS = ['intro', 'features', 'story', 'ingredient_intro', 'technique', 'storage_method',
    'nutrition', 'brand_philosophy', 'faq', 'myths', 'pairing', 'seo_description'];

  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用

  async function load(root, param) {
    const lc = AIMC.startLifecycle('Knowledge');
    currentDom = lc.dom;
    lc.dom.on(root, '#kNewBtn', 'click', () => openForm(null));
    lc.dom.on(root, '#kAiNewBtn', 'click', () => openForm(null, true));
    lc.dom.on(root, '#kRefreshBtn', 'click', () => refresh(root));
    lc.dom.on(root, '#kInitBtn', 'click', () => AIMC.runInitFlow(root, '#kInitResult', () => refresh(root)));
    lc.done('event bindings ready');
    await refresh(root);

    if (param === 'new-ai') {
      openForm(null, true);
    } else if (param && AIMC.store.knowledge.some((k) => k.id === param)) {
      openForm(param);
    }
  }

  async function refresh(root) {
    const lc = AIMC.startLifecycle('Knowledge:refresh');
    currentDom = lc.dom;
    lc.dom.html(root, '#kHealthGrid', AIMC.loadingHtml());
    try {
      const { data } = await AIMC.api('/knowledge');
      const [{ data: topics }, { data: prompts }, { data: history }] = await Promise.all([
        AIMC.api('/topics'), AIMC.api('/prompts'), AIMC.api('/content-history'),
      ]);
      AIMC.store.knowledge = data;
      AIMC.store.topics = topics; AIMC.store.prompts = prompts; AIMC.store.history = history;
      await AIMC.loadKnowledgeDetails();
      try { await AIMC.loadPosProducts(); } catch (e) { console.warn('[AIMC] 讀取 POS 商品清單失敗（Health Card 仍會顯示已建立知識的商品）：', e.message); }
      if (!lc.checkpoint('API 完成')) return;
      renderStats(root, lc.dom);
      renderHealthGrid(root, lc.dom);
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#kHealthGrid');
    }
  }

  function renderStats(root, dom) {
    const s = AIMC.store;
    const avg = s.knowledge.length
      ? Math.round(s.knowledge.reduce((sum, r) => sum + AIMC.calcCompleteness(s.knowledgeDetail[r.id]), 0) / s.knowledge.length)
      : 0;
    const pendingReview = s.history.filter((h) => h.status === 'generated').length;
    const totalProducts = Math.max(s.posProducts.length, s.knowledge.length);
    dom.html(root, '#kStatGrid', [
      AIMC.statCard('📦', totalProducts, 'POS 商品數'),
      AIMC.statCard('📚', s.knowledge.length, '已建知識數'),
      AIMC.statCard('📊', avg + '%', '平均完成度'),
      AIMC.statCard('📝', s.topics.length, 'Topic 數'),
      AIMC.statCard('✨', s.history.length, 'Generated 數'),
      AIMC.statCard('⏳', pendingReview, '待審核', 'warn'),
    ].join(''));
  }

  // Hotfix16 Part 3：改用 computeAllProductInsights()，讓「有 POS 商品但還沒
  // 建立知識」的項目也會出現，並標示 尚未初始化／0%／建立商品知識 CTA。
  function renderHealthGrid(root, dom) {
    const insights = AIMC.computeAllProductInsights();
    if (!insights.length) {
      dom.html(root, '#kHealthGrid', AIMC.emptyState('📦', '尚無 POS 商品，請先到「商品管理」建立商品'));
      return;
    }
    dom.html(root, '#kHealthGrid', insights.map((ins) => {
      const row = ins.row;
      if (ins.uninitialized) {
        return `
        <div class="health-card uninitialized" data-init-product="${AIMC.esc(row.external_product_id)}">
          <div class="hc-head">
            <div><div class="hc-name">${AIMC.esc(row.product_name)}</div><div class="hc-code">${AIMC.esc(row.external_product_id)}</div></div>
            <span class="badge outline">0%</span>
          </div>
          <div class="hc-missing">${AIMC.badge('尚未初始化', 'sensitive')}</div>
          <div class="hc-hint">💡 AI 建議：立即建立商品知識</div>
          <div class="hc-ctas">
            <button class="btn ai sm" data-create="${AIMC.esc(row.external_product_id)}">📚 建立商品知識</button>
          </div>
        </div>`;
      }
      return `
      <div class="health-card" data-open="${row.id}">
        <div class="hc-head">
          <div><div class="hc-name">${AIMC.esc(row.product_name)}</div><div class="hc-code">${AIMC.esc(row.external_product_id)}</div></div>
          <span class="badge outline">${ins.pct}%</span>
        </div>
        ${ins.missing.length ? `<div class="hc-missing">缺少：${ins.missing.map((m) => AIMC.badge(m, 'sensitive')).join('')}</div>` : `<div class="hc-missing">${AIMC.badge('欄位齊全', 'active')}</div>`}
        <div class="hc-stats">
          <div><div class="hc-stat-num">${ins.topics.length}</div><div class="hc-stat-label">Topic</div></div>
          <div><div class="hc-stat-num">${ins.promptCount}</div><div class="hc-stat-label">Prompt</div></div>
          <div><div class="hc-stat-num">${ins.genCount}</div><div class="hc-stat-label">Generated</div></div>
          <div><div class="hc-stat-num">${ins.pendingCount}</div><div class="hc-stat-label">Review</div></div>
        </div>
        <div class="hc-hint">💡 AI 建議：${AIMC.esc(AIMC.nextStepHint(ins))}</div>
        <div class="hc-ctas">
          <button class="btn secondary sm" data-edit="${row.id}">📚 補知識</button>
          ${!ins.topics.length ? `<button class="btn ghost sm" data-topic="${AIMC.esc(row.external_product_id)}">📝 建主題</button>` : ''}
          ${ins.promptCount ? `<button class="btn ghost sm" data-gen="${AIMC.esc(row.external_product_id)}">✨ 生成內容</button>` : ''}
          <button class="btn danger sm" data-del="${row.id}">刪除</button>
        </div>
      </div>`;
    }).join(''));

    const el = dom.query(root, '#kHealthGrid');
    if (!el) return;
    el.querySelectorAll('[data-open]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openForm(card.dataset.open);
      });
    });
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openForm(b.dataset.edit); }));
    el.querySelectorAll('[data-topic]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); location.hash = '#/topics/' + encodeURIComponent(b.dataset.topic); }));
    el.querySelectorAll('[data-gen]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); location.hash = '#/generate/' + encodeURIComponent(b.dataset.gen); }));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeKnowledge(document.getElementById('workspace'), b.dataset.del); }));
    el.querySelectorAll('[data-create]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openForm(null, false, b.dataset.create); }));
  }

  function fieldLabel(key) {
    const map = {
      intro: '商品介紹', features: '商品特色', story: '品牌故事', ingredient_intro: '食材介紹',
      technique: '工法介紹', storage_method: '保存方式', nutrition: '營養知識', brand_philosophy: '品牌理念',
      faq: '常見 FAQ', myths: '常見迷思', pairing: '推薦搭配', seo_description: 'SEO 說明',
    };
    return map[key] || key;
  }

  async function removeKnowledge(root, id) {
    if (!confirm('確定刪除此商品知識？（關聯的主題不會一併刪除）')) return;
    try {
      await AIMC.api('/knowledge/' + id, { method: 'DELETE' });
      AIMC.toast('已刪除');
      refresh(root);
    } catch (e) { AIMC.toast('刪除失敗：' + e.message, true); }
  }

  // Hotfix16 Part 2：第一欄不再手動輸入商品編號/名稱/分類/價格，
  // 一律從 POS 商品下拉選擇，選取後自動帶入（唯讀，不得手動亂改）。
  // 編輯既有知識時（data 存在）：商品本身資訊也一律唯讀顯示，
  // 因為 PUT /knowledge/:id 本來就不接受 external_product_id/product_name 等欄位，
  // 商品基本資料一律由「初始化」或個別 sync-pos-product 呼叫同步，不走這個表單。
  function productInfoBoxHtml(p) {
    if (!p) return '<div class="pos-product-info empty">請選擇一個 POS 商品</div>';
    const price = p.price != null && p.price !== '' ? `NT$ ${AIMC.esc(p.price)}` : '-';
    return `
      <div class="pos-product-info">
        ${p.product_image_url ? `<img src="${AIMC.esc(p.product_image_url)}" alt="">` : '<div class="pos-product-info-noimg">🍽️</div>'}
        <div class="pos-product-info-text">
          <div class="pos-product-info-name">${AIMC.esc(p.product_name)}</div>
          <div class="pos-product-info-sub">編號 ${AIMC.esc(p.external_product_id)} ・ ${AIMC.esc(p.category_name || '未分類')} ・ ${price}</div>
        </div>
      </div>`;
  }

  function formHtml(data, aiDraftMode, posProductOptions, preselectId) {
    const v = (k) => AIMC.esc((data && data[k]) || '');
    const editingPosInfo = data
      ? (AIMC.store.posProducts || []).find((p) => p.external_product_id === data.external_product_id)
      : null;

    const productSelectorHtml = data
      ? `<div class="field full"><label>商品（同步自 POS，不可修改）</label>${productInfoBoxHtml(editingPosInfo || {
          external_product_id: data.external_product_id, product_name: data.product_name,
          category_name: editingPosInfo && editingPosInfo.category_name, price: data.price, product_image_url: data.product_image_url,
        })}</div>`
      : `<div class="field full">
          <label>選擇 POS 商品 *</label>
          <select id="f_pos_product">
            <option value="">請選擇...</option>
            ${(posProductOptions || []).map((p) => `<option value="${AIMC.esc(p.external_product_id)}" ${preselectId === p.external_product_id ? 'selected' : ''}>${AIMC.esc(p.product_name)}（${AIMC.esc(p.external_product_id)}）</option>`).join('')}
          </select>
          <div id="f_productInfoBox" style="margin-top:8px">${productInfoBoxHtml(null)}</div>
        </div>`;

    return `
      <div class="grid">
        ${productSelectorHtml}
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
        <div class="field"><label>關鍵字 / SEO Keyword（逗號分隔）</label><input type="text" id="f_keywords" value="${AIMC.esc(((data && data.keywords) || []).join(', '))}"></div>
        <div class="field"><label>Hashtag（逗號分隔）</label><input type="text" id="f_hashtags" value="${AIMC.esc(((data && data.hashtags) || []).join(', '))}"></div>
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

  // data：編輯既有知識時傳入該筆資料（已知 external_product_id/product_name，商品資訊不可改）
  // selectedPosProduct：新增時，使用者從下拉選擇的 POS 商品（AIMC.normalizePosProduct 格式）
  function collectPayload(data, selectedPosProduct) {
    const g = (id) => document.getElementById(id).value;
    const identity = data
      ? { external_product_id: data.external_product_id, product_name: data.product_name, category_name: undefined }
      : {
          external_product_id: selectedPosProduct ? selectedPosProduct.external_product_id : '',
          product_name: selectedPosProduct ? selectedPosProduct.product_name : '',
          category_name: selectedPosProduct ? (selectedPosProduct.category_name || undefined) : undefined,
        };
    return {
      ...identity,
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
  // 此表單活在 Drawer 內，Drawer 沒有路由生命週期問題，維持原本直接操作即可。
  function fillAiDraft(productName, categoryName) {
    const name = (productName || '').trim();
    if (!name) { AIMC.toast('請先選擇 POS 商品，AI 才能產生草稿', true); return; }
    const cat = (categoryName || '').trim() || '本店';
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

  // preselectExternalId：由 Health Card「建立商品知識」CTA 帶入，開表單時直接選好該商品
  async function openForm(id, aiDraftMode, preselectExternalId) {
    let data = null;
    if (id) {
      try { data = (await AIMC.api('/knowledge/' + id)).data; } catch (e) { AIMC.toast('讀取失敗：' + e.message, true); return; }
    }

    // 確保 POS 商品清單是新的（Drawer 可能在使用者還沒逛過 Knowledge 列表就被開啟，例如從 Dashboard CTA 直接進來）
    if (!data && !(AIMC.store.posProducts || []).length) {
      try { await AIMC.loadPosProducts(); } catch (e) { console.warn('[AIMC] 讀取 POS 商品清單失敗：', e.message); }
    }
    // 新增模式下，只列出「尚未建立知識」的 POS 商品，避免選到已有知識的商品又跳 ALREADY_EXISTS
    const knownIds = new Set((AIMC.store.knowledge || []).map((k) => k.external_product_id));
    const posProductOptions = data ? [] : (AIMC.store.posProducts || []).filter((p) => !knownIds.has(p.external_product_id));

    let selectedPosProduct = data ? null : (posProductOptions.find((p) => p.external_product_id === preselectExternalId) || null);

    const body = AIMC.openDrawer(
      id ? `補知識（${AIMC.esc(data.product_name)}）` : '🤖 AI 建立商品知識',
      formHtml(data, aiDraftMode, posProductOptions, preselectExternalId)
    );

    if (!data) {
      const sel = body.querySelector('#f_pos_product');
      const infoBox = body.querySelector('#f_productInfoBox');
      const syncInfoBox = () => { if (infoBox) infoBox.innerHTML = productInfoBoxHtml(selectedPosProduct); };
      if (sel) {
        sel.addEventListener('change', () => {
          selectedPosProduct = posProductOptions.find((p) => p.external_product_id === sel.value) || null;
          syncInfoBox();
        });
      }
      syncInfoBox();
    }

    body.querySelector('#f_aiDraftBtn').addEventListener('click', () => {
      if (data) fillAiDraft(data.product_name, null);
      else fillAiDraft(selectedPosProduct && selectedPosProduct.product_name, selectedPosProduct && selectedPosProduct.category_name);
    });
    body.querySelector('#f_cancelBtn').addEventListener('click', () => AIMC.closeDrawer());
    body.querySelector('#f_saveBtn').addEventListener('click', async () => {
      if (!data && !selectedPosProduct) return AIMC.toast('請選擇 POS 商品', true);
      const payload = collectPayload(data, selectedPosProduct);
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
          AIMC.toast('此商品已有知識，請從列表點「補知識」', true);
        } else {
          AIMC.toast('儲存失敗：' + e.message, true);
        }
      }
    });
    if (aiDraftMode && data) fillAiDraft(data.product_name, null);
  }

  // ── Part 6：Page API —— destroy / resume / pause（refresh 已定義於上方）──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return refresh(root); }
  function pause() { console.info('[AIMC] Knowledge paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.knowledge = { load, destroy, refresh, resume, pause };
})();
