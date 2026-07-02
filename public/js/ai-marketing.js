// public/js/ai-marketing.js — Phase 3
//
// AI 行銷中心從「獨立分頁（ai-marketing.html + 自己的 api()/showToast()）」
// 改成內嵌進 POS SPA 的 #page-ai_marketing。完全重用 POS 既有的：
//   - apiFetch()（自動帶 Authorization / x-store-id，401/403 處理一致）
//   - showToast(msg, type)
//   - escHtml()
// 所有函式一律加 aimc 前綴，避免跟 app.js 既有全域函式撞名。
//
// 不建立新路由（/admin/ai...），沿用現有 SPA 的 showPage('ai_marketing') 模式
// —— 需求書 A-7：「若目前 router 不支援子路由，可先保留單頁模式，但 UI 必須嵌入 POS Layout」。

const AIMC_API_BASE = '/api/ai-marketing';

const aimcState = {
  inited: false,
  tab: 'knowledge',
  posProducts: [],       // 全店 POS 商品（含停用），來源 GET /api/products
  knowledgeList: [],     // AIMC 商品知識列表
  knowledgeEditingId: null,
  topicCache: [],
  promptsCache: [],
  // Generate step wizard 狀態
  gen: { productId: '', topicId: '', platform: 'fb', goal: '教育' },
};

// ── 共用 API 呼叫：走 POS 既有 apiFetch，自動帶 Authorization / x-store-id ──
async function aimcApi(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(AIMC_API_BASE + path, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('未授權或功能未開通');
  }
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}

function aimcFmtTime(t) { return t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : ''; }

// ── 初始化（由 showPage('ai_marketing') 觸發，只做一次事件綁定，之後每次進頁都重新整理資料）──
function initAIMarketing() {
  if (!aimcState.inited) {
    document.querySelectorAll('#page-ai_marketing .aimc-tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => aimcSwitchTab(btn.dataset.tab));
    });
    aimcState.inited = true;
  }
  aimcSwitchTab(aimcState.tab || 'knowledge');
}

function aimcSwitchTab(tab) {
  aimcState.tab = tab;
  document.querySelectorAll('#page-ai_marketing .aimc-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#page-ai_marketing .aimc-panel').forEach(p => p.classList.toggle('active', p.id === 'aimc-panel-' + tab));

  if (tab === 'knowledge') { aimcLoadPosProductOptions(); aimcLoadKnowledgeList(); }
  if (tab === 'topic')     { aimcLoadKnowledgeOptionsForTopic(); aimcLoadTopicList(); }
  if (tab === 'prompt')    { aimcLoadTopicOptionsForPrompt(); aimcLoadPromptList(); }
  if (tab === 'generate')  { aimcInitGenerateWizard(); }
  if (tab === 'review')    { aimcLoadReviewList(); }
}

// ============ 商品知識（Phase 3：改成選 POS 商品，不再手動輸入編號/名稱/分類）============

async function aimcLoadPosProductOptions() {
  const sel = document.getElementById('k_pos_product_select');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/products');
    const json = await res.json();
    aimcState.posProducts = json.success ? (json.data || []) : [];
  } catch { aimcState.posProducts = []; }

  if (!aimcState.posProducts.length) {
    sel.innerHTML = '<option value="">尚無 POS 商品，請先於「商品」頁建立</option>';
    return;
  }
  sel.innerHTML = '<option value="">請選擇 POS 商品</option>' +
    aimcState.posProducts.map(p =>
      `<option value="${p.id}">${escHtml(p.name)}（${escHtml(p.category || '未分類')}・$${p.price}）${Number(p.enabled) === 0 ? '［已下架］' : ''}</option>`
    ).join('');
}

/** 選擇 POS 商品後：自動帶入 external_product_id/名稱/分類/售價/圖片/上下架，
 *  並呼叫 sync-pos-product 自動建立或更新知識骨架（不覆蓋既有內容欄位）。*/
async function aimcOnPosProductSelected() {
  const sel = document.getElementById('k_pos_product_select');
  const productId = sel.value;
  const preview = document.getElementById('k_pos_product_preview');
  const contentForm = document.getElementById('k_content_form');
  if (!productId) {
    if (preview) preview.innerHTML = '';
    if (contentForm) contentForm.style.display = 'none';
    return;
  }
  const product = aimcState.posProducts.find(p => String(p.id) === String(productId));
  if (!product) return;

  if (preview) {
    preview.innerHTML = `
      ${product.image ? `<img class="aimc-product-thumb" src="${escHtml(product.image)}">` : ''}
      <strong>${escHtml(product.name)}</strong>
      <span class="muted">　分類：${escHtml(product.category || '未分類')}　售價：$${product.price}　${Number(product.enabled) === 0 ? '（已下架）' : '（上架中）'}</span>
    `;
  }

  try {
    const result = await aimcApi('/knowledge/sync-pos-product', {
      method: 'POST',
      body: {
        external_product_id: String(product.id),
        product_name: product.name,
        category_name: product.category || '',
        price: product.price,
        product_image_url: product.image || '',
        active: Number(product.enabled) === 1,
      },
    });
    showToast(result.created ? '已自動建立此商品的 AI 知識骨架' : '已同步商品最新資料（商品故事等內容欄位不受影響）', 'success');
    aimcFillKnowledgeContentForm(result.data);
    if (contentForm) contentForm.style.display = '';
    aimcLoadKnowledgeList();
  } catch (e) {
    showToast('同步商品失敗：' + e.message, 'error');
  }
}

function aimcFillKnowledgeContentForm(k) {
  aimcState.knowledgeEditingId = k.id;
  document.getElementById('k_form_title').textContent = '商品知識內容（' + (k.external_product_id || '') + '）';
  document.getElementById('k_intro').value = k.intro || '';
  document.getElementById('k_features').value = k.features || '';
  document.getElementById('k_story').value = k.story || '';
  document.getElementById('k_technique').value = k.technique || '';
  document.getElementById('k_storage_method').value = k.storage_method || '';
  document.getElementById('k_nutrition').value = k.nutrition || '';
  document.getElementById('k_brand_philosophy').value = k.brand_philosophy || '';
  document.getElementById('k_usp').value = (k.unique_selling_points || []).join('、');
  document.getElementById('k_keywords').value = (k.keywords || []).join(', ');
  document.getElementById('k_hashtags').value = (k.hashtags || []).join(', ');
  document.getElementById('k_ai_usage_allowed').value = String(k.ai_usage_allowed);
}

/** 只更新「內容」欄位（故事/工法/營養/品牌理念/USP...），商品基本資料（名稱/分類/售價/圖片）
 *  一律由 aimcOnPosProductSelected() 的 sync-pos-product 負責，兩者互不覆蓋。*/
async function aimcSaveKnowledgeContent() {
  if (!aimcState.knowledgeEditingId) return showToast('請先選擇 POS 商品', 'error');
  const payload = {
    intro: document.getElementById('k_intro').value,
    features: document.getElementById('k_features').value,
    story: document.getElementById('k_story').value,
    technique: document.getElementById('k_technique').value,
    storage_method: document.getElementById('k_storage_method').value,
    nutrition: document.getElementById('k_nutrition').value,
    brand_philosophy: document.getElementById('k_brand_philosophy').value,
    unique_selling_points: document.getElementById('k_usp').value.split('、').map(s => s.trim()).filter(Boolean),
    keywords: document.getElementById('k_keywords').value.split(',').map(s => s.trim()).filter(Boolean),
    hashtags: document.getElementById('k_hashtags').value.split(',').map(s => s.trim()).filter(Boolean),
    ai_usage_allowed: document.getElementById('k_ai_usage_allowed').value === 'true',
  };
  try {
    await aimcApi('/knowledge/' + aimcState.knowledgeEditingId, { method: 'PUT', body: payload });
    showToast('已儲存商品知識內容', 'success');
    aimcLoadKnowledgeList();
  } catch (e) {
    showToast('儲存失敗：' + e.message, 'error');
  }
}

async function aimcLoadKnowledgeList() {
  const tbody = document.getElementById('aimc-knowledgeListBody');
  if (!tbody) return;
  try {
    const { data } = await aimcApi('/knowledge');
    aimcState.knowledgeList = data;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">尚無資料，請於上方選擇 POS 商品建立</td></tr>'; return; }
    tbody.innerHTML = data.map(row => `
      <tr>
        <td>${escHtml(row.external_product_id)}</td>
        <td>${escHtml(row.product_name)}</td>
        <td>${escHtml(row.category_name || '-')}</td>
        <td>${row.price != null ? '$' + row.price : '-'}</td>
        <td><span class="badge ${row.pos_product_status === 'active' ? 'active' : 'paused'}">${escHtml(row.pos_product_status || '-')}</span></td>
        <td>v${row.version}</td>
        <td><button class="link-btn" onclick="aimcEditKnowledgeById('${row.id}')">編輯內容</button></td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

async function aimcEditKnowledgeById(id) {
  try {
    const { data } = await aimcApi('/knowledge/' + id);
    aimcFillKnowledgeContentForm(data);
    document.getElementById('k_content_form').style.display = '';
    const sel = document.getElementById('k_pos_product_select');
    if (sel) sel.value = data.external_product_id || '';
    const preview = document.getElementById('k_pos_product_preview');
    if (preview) preview.innerHTML = `<strong>${escHtml(data.product_name)}</strong> <span class="muted">正在編輯內容</span>`;
    window.scrollTo({ top: document.getElementById('page-ai_marketing').offsetTop, behavior: 'smooth' });
  } catch (e) { showToast('讀取失敗：' + e.message, 'error'); }
}

// ============ 主題 ============
async function aimcLoadKnowledgeOptionsForTopic() {
  const sel = document.getElementById('t_product_select');
  if (!sel) return;
  try {
    const { data } = await aimcApi('/knowledge');
    if (!data.length) { sel.innerHTML = '<option value="">請先建立商品知識</option>'; return; }
    sel.innerHTML = data.map(k => `<option value="${escHtml(k.external_product_id)}">${escHtml(k.product_name)}</option>`).join('');
  } catch (e) { sel.innerHTML = '<option value="">載入失敗</option>'; }
}

async function aimcCreateTopic() {
  const external_product_id = document.getElementById('t_product_select').value;
  const title = document.getElementById('t_title').value.trim();
  const category = document.getElementById('t_category').value;
  const priority = Number(document.getElementById('t_priority').value) || 0;
  if (!external_product_id || !title) return showToast('請選擇商品並輸入主題標題', 'error');
  try {
    await aimcApi('/topics', { method: 'POST', body: { external_product_id, title, category, priority } });
    showToast('已建立主題', 'success');
    document.getElementById('t_title').value = '';
    aimcLoadTopicList();
  } catch (e) { showToast('建立失敗：' + e.message, 'error'); }
}

async function aimcToggleTopicStatus(id, status) {
  try {
    await aimcApi('/topics/' + id, { method: 'PATCH', body: { status: status === 'active' ? 'paused' : 'active' } });
    aimcLoadTopicList();
  } catch (e) { showToast('操作失敗：' + e.message, 'error'); }
}

async function aimcDeleteTopic(id) {
  if (!confirm('確定刪除此主題？')) return;
  try {
    await aimcApi('/topics/' + id, { method: 'DELETE' });
    showToast('已刪除', 'success');
    aimcLoadTopicList();
  } catch (e) { showToast('刪除失敗：' + e.message, 'error'); }
}

async function aimcLoadTopicList() {
  const tbody = document.getElementById('aimc-topicListBody');
  if (!tbody) return;
  try {
    const { data } = await aimcApi('/topics');
    aimcState.topicCache = data;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">尚無主題</td></tr>'; return; }
    tbody.innerHTML = data.map(t => `
      <tr>
        <td>${escHtml(t.product_name)}</td>
        <td>${escHtml(t.title)}</td>
        <td>${escHtml(t.category)}</td>
        <td>${t.priority}</td>
        <td><span class="badge ${t.status}">${escHtml(t.status)}</span></td>
        <td>
          <button class="link-btn" onclick="aimcToggleTopicStatus('${t.id}','${t.status}')">${t.status === 'active' ? '暫停' : '啟用'}</button> ·
          <button class="link-btn" style="color:var(--aimc-danger)" onclick="aimcDeleteTopic('${t.id}')">刪除</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

// ============ Prompt ============
async function aimcLoadTopicOptionsForPrompt() {
  const sel = document.getElementById('p_topic_select');
  if (!sel) return;
  try {
    const { data } = await aimcApi('/topics');
    sel.innerHTML = '<option value="">（不綁定，通用 Prompt）</option>' +
      data.map(t => `<option value="${t.id}">${escHtml(t.product_name)} - ${escHtml(t.title)}</option>`).join('');
  } catch (e) { /* 保留預設 */ }
}

async function aimcCreatePrompt() {
  const topic_id = document.getElementById('p_topic_select').value || null;
  const platform = document.getElementById('p_platform').value;
  const content_goal = document.getElementById('p_content_goal').value;
  const content_format = document.getElementById('p_content_format').value;
  const is_default = document.getElementById('p_is_default').value === 'true';
  const template = document.getElementById('p_template').value.trim();
  if (!template) return showToast('請輸入 Prompt 模板內容', 'error');
  try {
    await aimcApi('/prompts', { method: 'POST', body: { topic_id, platform, content_goal, content_format, is_default, template } });
    showToast('已建立 Prompt（版本自動遞增，不覆蓋舊版本）', 'success');
    document.getElementById('p_template').value = '';
    aimcLoadPromptList();
  } catch (e) { showToast('建立失敗：' + e.message, 'error'); }
}

async function aimcDeletePrompt(id) {
  if (!confirm('確定刪除此 Prompt？')) return;
  try {
    await aimcApi('/prompts/' + id, { method: 'DELETE' });
    showToast('已刪除', 'success');
    aimcLoadPromptList();
  } catch (e) { showToast('刪除失敗：' + e.message, 'error'); }
}

async function aimcLoadPromptList() {
  const tbody = document.getElementById('aimc-promptListBody');
  if (!tbody) return;
  try {
    const { data } = await aimcApi('/prompts');
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">尚無 Prompt</td></tr>'; return; }
    const topicMap = Object.fromEntries(aimcState.topicCache.map(t => [t.id, t.title]));
    tbody.innerHTML = data.map(p => `
      <tr>
        <td>${escHtml(p.platform)}</td>
        <td>${escHtml(p.content_goal)}</td>
        <td>${escHtml(p.content_format)}</td>
        <td>${p.topic_id ? escHtml(topicMap[p.topic_id] || p.topic_id) : '<span class="muted">通用</span>'}</td>
        <td>${p.is_default ? '⭐' : ''}</td>
        <td>v${p.version}</td>
        <td><button class="link-btn" style="color:var(--aimc-danger)" onclick="aimcDeletePrompt('${p.id}')">刪除</button></td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

// ============ Generate（Phase 3：Step1 選商品 → Step2 選主題 → Step3 平台 → Step4 目的 → Step5 生成）============
function aimcInitGenerateWizard() {
  aimcRenderGenSteps();
  aimcLoadProductsForGenerateStep1();
  aimcLoadHistoryList();
}

function aimcRenderGenSteps() {
  const g = aimcState.gen;
  const productName = (aimcState.posProducts.find(p => String(p.id) === String(g.productId)) || {}).name || '尚未選擇';
  const topicTitle = (aimcState.topicCache.find(t => String(t.id) === String(g.topicId)) || {}).title || '尚未選擇';
  const el = document.getElementById('aimc-gen-steps');
  if (!el) return;
  el.innerHTML = `
    <div class="aimc-step ${g.productId ? 'done' : 'current'}"><div class="aimc-step-title">Step1 商品</div><div class="aimc-step-value">${escHtml(productName)}</div></div>
    <div class="aimc-step ${g.topicId ? 'done' : (g.productId ? 'current' : '')}"><div class="aimc-step-title">Step2 主題</div><div class="aimc-step-value">${escHtml(topicTitle)}</div></div>
    <div class="aimc-step current"><div class="aimc-step-title">Step3 平台</div><div class="aimc-step-value">${escHtml(g.platform)}</div></div>
    <div class="aimc-step current"><div class="aimc-step-title">Step4 內容目的</div><div class="aimc-step-value">${escHtml(g.goal)}</div></div>
  `;
}

async function aimcLoadProductsForGenerateStep1() {
  const sel = document.getElementById('g_product_select');
  if (!sel) return;
  try {
    const res = await apiFetch('/api/products');
    const json = await res.json();
    aimcState.posProducts = json.success ? (json.data || []) : [];
  } catch { aimcState.posProducts = []; }
  sel.innerHTML = '<option value="">請選擇商品</option>' +
    aimcState.posProducts.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
  sel.value = aimcState.gen.productId || '';
}

/** Step1 選商品後 → 載入 Step2 該商品相關主題（用需求書 K 節：GET /topics?external_product_id=）*/
async function aimcOnGenProductChange() {
  const productId = document.getElementById('g_product_select').value;
  aimcState.gen.productId = productId;
  aimcState.gen.topicId = '';
  const topicSel = document.getElementById('g_topic_select');
  if (!productId) { topicSel.innerHTML = '<option value="">請先選擇商品</option>'; aimcRenderGenSteps(); return; }
  try {
    const { data } = await aimcApi('/topics?external_product_id=' + encodeURIComponent(productId));
    aimcState.topicCache = data;
    topicSel.innerHTML = data.length
      ? data.map(t => `<option value="${t.id}">${escHtml(t.title)}（${escHtml(t.category)}）</option>`).join('')
      : '<option value="">此商品尚無主題，請先於「主題」頁建立</option>';
  } catch (e) {
    topicSel.innerHTML = '<option value="">載入失敗</option>';
  }
  aimcRenderGenSteps();
}

function aimcOnGenTopicChange() {
  aimcState.gen.topicId = document.getElementById('g_topic_select').value;
  aimcRenderGenSteps();
}
function aimcOnGenPlatformChange() {
  aimcState.gen.platform = document.getElementById('g_platform').value;
  aimcRenderGenSteps();
}
function aimcOnGenGoalChange() {
  aimcState.gen.goal = document.getElementById('g_content_goal').value;
  aimcRenderGenSteps();
}

async function aimcGenerateContent() {
  const { productId, topicId, platform, goal } = aimcState.gen;
  const resultBox = document.getElementById('aimc-generateResult');
  if (!topicId) return showToast('請完成 Step1／Step2：選擇商品與主題', 'error');

  const btn = document.getElementById('aimc-generateBtn');
  btn.disabled = true; btn.textContent = '⏳ 生成中...';
  resultBox.innerHTML = '';
  try {
    const { data } = await aimcApi('/generate', {
      method: 'POST',
      body: { product_id: productId, topic_id: topicId, platform, content_goal: goal, content_type: 'text' },
    });
    resultBox.innerHTML = `
      <div class="gen-result">${escHtml(data.generated_text)}</div>
      <p class="muted" style="margin-top:8px">
        模型：${escHtml(data.model_provider)}/${escHtml(data.model_name)}　
        狀態：<span class="badge ${data.status}">${escHtml(data.status)}</span>　
        請至「審核」分頁核准後才能排程發布（後續階段功能）
      </p>
    `;
    aimcLoadHistoryList();
  } catch (e) {
    resultBox.innerHTML = `<p style="color:var(--aimc-danger)">生成失敗：${escHtml(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = '⚡ 產生內容';
  }
}

async function aimcLoadHistoryList() {
  const tbody = document.getElementById('aimc-historyListBody');
  if (!tbody) return;
  try {
    const { data } = await aimcApi('/content-history');
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">尚無生成紀錄</td></tr>'; return; }
    tbody.innerHTML = data.map(h => `
      <tr>
        <td>${escHtml(h.platform)}</td>
        <td>${escHtml((h.generation_params && h.generation_params.content_goal) || '-')}</td>
        <td>${escHtml((h.generated_text || '').slice(0, 40))}...</td>
        <td><span class="badge ${h.status}">${escHtml(h.status)}</span></td>
        <td class="muted">${aimcFmtTime(h.created_at)}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">載入失敗：${escHtml(e.message)}</td></tr>`;
  }
}

// ============ 審核（Phase 3：顯示引用商品/USP/Prompt/Provider/Model/Context Snapshot）============
async function aimcLoadReviewList() {
  const container = document.getElementById('aimc-reviewListContainer');
  const status = document.getElementById('aimc-reviewStatusFilter').value;
  try {
    const { data } = await aimcApi('/review?status=' + encodeURIComponent(status));
    if (!data.length) { container.innerHTML = '<div class="empty">目前沒有符合條件的內容</div>'; return; }
    container.innerHTML = data.map(item => `
      <div class="card" style="margin-bottom:12px">
        <div class="flex-between">
          <div>
            ${item.product_image_url ? `<img class="aimc-product-thumb" src="${escHtml(item.product_image_url)}">` : ''}
            <strong>${escHtml(item.platform)}</strong> <span class="muted">${aimcFmtTime(item.created_at)}</span>
          </div>
          <span class="badge ${item.status}">${escHtml(item.status)}</span>
        </div>
        <p class="muted" style="margin:4px 0">
          引用商品：${escHtml(item.product_name || '-')}（${escHtml(item.external_product_id || '-')}）　知識版本：v${item.knowledge_version ?? '-'}<br>
          引用主題：${escHtml(item.topic_title || '-')}　引用 Prompt：${item.prompt_template ? escHtml(item.prompt_template.slice(0, 40)) + '...' : '-'}（v${item.prompt_version ?? '-'}）<br>
          Provider/Model：${escHtml(item.model_provider || '-')}/${escHtml(item.model_name || '-')}　耗時：${item.duration_ms != null ? item.duration_ms + 'ms' : '-'}<br>
          引用 USP：${(item.used_usp && item.used_usp.length) ? escHtml(item.used_usp.join('、')) : '<span class="muted">（無/未偵測到）</span>'}
        </p>
        <div class="gen-result">${escHtml(item.generated_text)}</div>
        ${item.reject_reason ? `<p class="muted">退回原因：${escHtml(item.reject_reason)}</p>` : ''}
        <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Context Snapshot（除錯用）</summary>
          <pre style="white-space:pre-wrap;font-size:11px;color:var(--aimc-text-secondary)">${escHtml(JSON.stringify(item.brand_context_snapshot || {}, null, 2))}</pre>
        </details>
        ${status === 'generated' ? `
          <div class="row-actions">
            <button class="btn success" onclick="aimcApproveContent('${item.id}')">✅ 核准</button>
            <button class="btn danger" onclick="aimcRejectContent('${item.id}')">❌ 退回</button>
          </div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty">載入失敗：${escHtml(e.message)}</div>`;
  }
}

async function aimcApproveContent(id) {
  try {
    await aimcApi('/review/' + id + '/approve', { method: 'POST', body: {} });
    showToast('已核准', 'success');
    aimcLoadReviewList();
  } catch (e) { showToast('操作失敗：' + e.message, 'error'); }
}

async function aimcRejectContent(id) {
  const reason = prompt('請輸入退回原因（可留空）：') || '';
  try {
    await aimcApi('/review/' + id + '/reject', { method: 'POST', body: { reject_reason: reason } });
    showToast('已退回', 'success');
    aimcLoadReviewList();
  } catch (e) { showToast('操作失敗：' + e.message, 'error'); }
}
