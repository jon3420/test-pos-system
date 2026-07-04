// ============================================================
// review.js — Hotfix18：審核頁改成「商品歸類」
//
// 目標：左側先看每個商品各有多少待審核／已通過／已退回／今日生成，
// 點一個商品只看該商品內容；右側維持原本雙欄（清單＋詳情）＋核准/退回。
//
// 不新增/修改 API：approve/reject 仍是既有 POST /review/:id/approve、/reject。
// 列表資料來源改用既有 GET /content-history（本來就會回傳「全部狀態」，
// 不像 GET /review?status= 一次只能拿一種狀態），前端再用 AIMC.store.topics
// 做 join 補上 product_name / topic_title（跟 Topic 頁同樣的作法），
// 這樣才能同時做「商品分類」＋「只看待審核／今日／FB/LINE」這些交叉篩選。
//
// 支援路由參數 #/review/<external_product_id>：自動選定該商品。
//
// Hotfix18 Goal5：待審核／已通過／已退回數字一律用 AIMC.reviewStatsForProduct，
// 跟 Dashboard / Knowledge Health Card / Topic 頁共用同一套算法。
// ============================================================
(function () {
  let selectedItemId = null;
  let selectedProductId = null; // null = 全部商品
  let activeFilter = 'all'; // all|pending|today|fb|line
  let fullList = [];
  let currentDom = null;
  const PLATFORM_ORDER = ['fb', 'line', 'ig', 'tiktok', 'threads', 'google_business', 'youtube_shorts'];

  const FILTER_CHIPS = [
    { key: 'all', label: '全部商品' },
    { key: 'pending', label: '只看待審核' },
    { key: 'today', label: '只看今日生成' },
    { key: 'fb', label: '只看 Facebook' },
    { key: 'line', label: '只看 LINE' },
  ];

  async function load(root, param) {
    const lc = AIMC.startLifecycle('Review');
    currentDom = lc.dom;
    lc.dom.on(root, '#rSortBy', 'change', () => renderList(root, lc.dom));
    lc.dom.on(root, '#rRefreshBtn', 'click', () => refresh(root));
    lc.done('event bindings ready');
    await refresh(root, param ? decodeURIComponent(param) : null);
  }

  async function refresh(root, presetProductId) {
    const lc = AIMC.startLifecycle('Review:refresh');
    currentDom = lc.dom;
    lc.dom.html(root, '#rListPane', AIMC.loadingHtml());
    try {
      const rc = await AIMC.loadReviewCounts();
      if (!lc.checkpoint('review counts 完成')) return;
      renderStats(root, lc.dom, rc);

      const [{ data: history }, { data: topics }, { data: knowledge }] = await Promise.all([
        AIMC.api('/content-history'), AIMC.api('/topics'), AIMC.api('/knowledge'),
      ]);
      if (!lc.checkpoint('content-history/topics/knowledge 完成')) return;
      AIMC.store.topics = topics;
      AIMC.store.knowledge = knowledge;
      AIMC.store.history = history;

      // 用 topic_id join 回 external_product_id / product_name / topic_title，
      // 跟 Topic 頁同一套資料來源，保證兩邊「哪篇屬於哪個商品」永遠一致。
      const topicMap = Object.fromEntries(topics.map((t) => [t.id, t]));
      fullList = history.map((h) => {
        const t = topicMap[h.topic_id];
        return { ...h, external_product_id: t?.external_product_id, product_name: t?.product_name, topic_title: t?.title };
      });

      await ensureCompletenessMap();
      if (!lc.checkpoint('completeness 明細完成')) return;

      if (presetProductId) selectedProductId = presetProductId;
      if (selectedProductId && !knowledge.some((k) => k.external_product_id === selectedProductId)) selectedProductId = null;

      renderProductList(root, lc.dom);
      renderFilterChips(root, lc.dom);
      renderList(root, lc.dom);
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#rListPane');
    }
  }

  // 商品完整度排序需要每個知識項目的明細（loadKnowledgeDetails 會抓 N 次 /knowledge/:id）
  async function ensureCompletenessMap() {
    try { await AIMC.loadKnowledgeDetails(); } catch (e) { /* 排序退回不依完整度也沒關係 */ }
  }

  function renderStats(root, dom, rc) {
    const todayCount = [...rc.a, ...rc.r].filter((h) => AIMC.isToday(h.updated_at)).length;
    dom.html(root, '#rStatGrid', [
      AIMC.statCard('⏳', AIMC.store.reviewCounts.generated, '待審核', 'warn'),
      AIMC.statCard('✅', AIMC.store.reviewCounts.approved, '已通過'),
      AIMC.statCard('❌', AIMC.store.reviewCounts.rejected, '已退回', 'danger'),
      AIMC.statCard('📅', todayCount, '今日審核數'),
    ].join(''));
  }

  // ── 左側：商品分類清單 ──
  function renderProductList(root, dom) {
    const knowledge = AIMC.store.knowledge;
    if (!knowledge.length) { dom.html(root, '#rProductList', AIMC.emptyState('📦', '尚無商品知識')); return; }
    const rows = knowledge.map((k) => ({ k, rs: AIMC.reviewStatsForProduct(k.external_product_id) }))
      .sort((a, b) => b.rs.pending - a.rs.pending);
    dom.html(root, '#rProductList', rows.map(({ k, rs }) => `
      <div class="review-product-item ${k.external_product_id === selectedProductId ? 'active' : ''}" data-pid="${AIMC.esc(k.external_product_id)}">
        <div class="rpi-name">${AIMC.esc(k.product_name)}</div>
        <div class="rpi-stats">待審核 <b class="pending">${rs.pending}</b>｜已通過 <b class="approved">${rs.approved}</b>｜退回 <b class="rejected">${rs.rejected}</b>｜今日生成 ${rs.todayGenerated}</div>
      </div>`).join(''));
    const el = dom.query(root, '#rProductList');
    if (el) el.querySelectorAll('[data-pid]').forEach((item) => item.addEventListener('click', () => {
      selectedProductId = (item.dataset.pid === selectedProductId) ? null : item.dataset.pid;
      selectedItemId = null;
      renderProductList(root, dom);
      renderList(root, dom);
    }));
  }

  // ── 篩選 chip：全部商品／只看待審核／只看今日生成／只看 Facebook／只看 LINE ──
  function renderFilterChips(root, dom) {
    dom.html(root, '#rFilterChips', FILTER_CHIPS.map((f) => `
      <span class="chip ${f.key === activeFilter ? 'active' : ''}" data-filter="${f.key}">${AIMC.esc(f.label)}</span>
    `).join(''));
    const el = dom.query(root, '#rFilterChips');
    if (el) el.querySelectorAll('[data-filter]').forEach((c) => c.addEventListener('click', () => {
      activeFilter = c.dataset.filter;
      if (activeFilter === 'all') { selectedProductId = null; renderProductList(root, dom); }
      renderFilterChips(root, dom);
      renderList(root, dom);
    }));
  }

  function applyFilters(list) {
    let out = list;
    if (selectedProductId) out = out.filter((h) => h.external_product_id === selectedProductId);
    if (activeFilter === 'pending') out = out.filter((h) => h.status === 'generated');
    else if (activeFilter === 'today') out = out.filter((h) => AIMC.isToday(h.created_at));
    else if (activeFilter === 'fb') out = out.filter((h) => h.platform === 'fb');
    else if (activeFilter === 'line') out = out.filter((h) => h.platform === 'line');
    return out;
  }

  function topicOf(item) {
    return AIMC.store.topics.find((t) => t.id === item.topic_id);
  }

  function completenessOf(item) {
    const row = AIMC.store.knowledge.find((k) => k.external_product_id === item.external_product_id);
    if (!row) return 100; // 找不到商品資料時排到後面，避免誤判為急件
    return AIMC.calcCompleteness(AIMC.store.knowledgeDetail[row.id]);
  }

  function sortList(list, sortBy) {
    const arr = [...list];
    if (sortBy === 'sensitive') {
      arr.sort((a, b) => {
        const sa = topicOf(a)?.claim_sensitive ? 1 : 0;
        const sb = topicOf(b)?.claim_sensitive ? 1 : 0;
        return sb - sa;
      });
    } else if (sortBy === 'today') {
      arr.sort((a, b) => (AIMC.isToday(b.created_at) ? 1 : 0) - (AIMC.isToday(a.created_at) ? 1 : 0));
    } else if (sortBy === 'platform') {
      arr.sort((a, b) => {
        const ia = PLATFORM_ORDER.indexOf(a.platform); const ib = PLATFORM_ORDER.indexOf(b.platform);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    } else if (sortBy === 'completeness') {
      arr.sort((a, b) => completenessOf(a) - completenessOf(b));
    } else {
      arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return arr;
  }

  function reviewHint(item) {
    const topic = topicOf(item);
    if (topic && topic.claim_sensitive) return '⚠️ 涉及功效／宣稱，請審慎確認用語';
    if (AIMC.isToday(item.created_at)) return '🕒 今日新生成，建議儘快審核維持時效性';
    if (item.status === 'generated') return '💡 核准後即可作為對外發布素材';
    return '';
  }

  function currentFilteredList(root, dom) {
    const sortBy = dom.value(root, '#rSortBy') || 'default';
    return sortList(applyFilters(fullList), sortBy);
  }

  function renderList(root, dom) {
    const list = currentFilteredList(root, dom);
    if (!list.length) {
      dom.html(root, '#rListPane', AIMC.emptyState('✅', '目前沒有符合條件的內容'));
      dom.html(root, '#rDetailPane', '<div class="empty">請從左側選擇一筆內容查看詳情</div>');
      return;
    }
    dom.html(root, '#rListPane', list.map((item) => {
      const goal = (item.generation_params && item.generation_params.content_goal) || '-';
      const topic = topicOf(item);
      const hint = reviewHint(item);
      return `
      <div class="review-list-item ${item.id === selectedItemId ? 'active' : ''}" data-id="${item.id}">
        <div class="rli-top"><span>${AIMC.platformLabel(item.platform)} ・ ${AIMC.esc(goal)}</span><span>${AIMC.fmtTime(item.created_at)}</span></div>
        <div class="rli-title">${AIMC.esc(item.product_name || '-')} ・ ${AIMC.esc(item.topic_title || '-')} ${topic && topic.claim_sensitive ? AIMC.badge('⚠️敏感', 'sensitive') : ''} ${AIMC.badge(item.status, item.status)}</div>
        <div class="rli-preview">${AIMC.esc((item.generated_text || '').slice(0, 60))}</div>
        ${hint ? `<div class="review-hint">${AIMC.esc(hint)}</div>` : ''}
      </div>`;
    }).join(''));
    const el = dom.query(root, '#rListPane');
    if (el) {
      el.querySelectorAll('[data-id]').forEach((it) => it.addEventListener('click', () => {
        selectedItemId = it.dataset.id; renderList(root, dom);
      }));
    }
    if (selectedItemId && list.some((d) => d.id === selectedItemId)) {
      renderDetail(root, dom, selectedItemId);
    } else {
      selectedItemId = list[0].id;
      renderDetail(root, dom, selectedItemId);
    }
  }

  function renderDetail(root, dom, id) {
    const item = fullList.find((x) => x.id === id);
    if (!item) { dom.html(root, '#rDetailPane', '<div class="empty">請從左側選擇一筆內容查看詳情</div>'); return; }
    const goal = (item.generation_params && item.generation_params.content_goal) || '-';
    const topic = topicOf(item);
    const hint = reviewHint(item);
    dom.html(root, '#rDetailPane', `
      <div class="flex-between">
        <div>
          <strong>${AIMC.platformLabel(item.platform)}</strong>
          ${item.product_name ? ` · <span class="muted">${AIMC.esc(item.product_name)}</span>` : ''}
          ${item.topic_title ? ` · <span class="muted">${AIMC.esc(item.topic_title)}</span>` : ''}
          ${AIMC.badge(goal, 'outline')}
          ${topic && topic.claim_sensitive ? AIMC.badge('⚠️ 需審慎審核', 'sensitive') : ''}
        </div>
        ${AIMC.badge(item.status, item.status)}
      </div>
      <p class="muted" style="margin:8px 0">
        模型：${AIMC.esc(item.model_provider || '-')}/${AIMC.esc(item.model_name || '-')}
        　耗時：${item.duration_ms != null ? item.duration_ms + 'ms' : '-'}
        　生成時間：${AIMC.fmtTime(item.created_at)}
      </p>
      ${hint ? `<p class="review-hint" style="font-size:12px;margin:0 0 8px">${AIMC.esc(hint)}</p>` : ''}
      <div class="gen-result">${AIMC.esc(item.generated_text)}</div>
      ${item.reject_reason ? `<p class="muted">退回原因：${AIMC.esc(item.reject_reason)}</p>` : ''}
      <div class="row-actions">
        <button class="btn secondary" id="r_copyBtn">📋 複製</button>
        ${item.status === 'generated' ? `
          <button class="btn success" id="r_approveBtn">✅ 核准</button>
          <button class="btn danger" id="r_rejectBtn">❌ 退回</button>` : ''}
      </div>
    `);
    dom.on(root, '#r_copyBtn', 'click', () => AIMC.copyToClipboard(item.generated_text));
    if (item.status === 'generated') {
      dom.on(root, '#r_approveBtn', 'click', () => approve(root, item.id));
      dom.on(root, '#r_rejectBtn', 'click', () => reject(root, item.id));
    }
  }

  async function approve(root, id) {
    try {
      await AIMC.api('/review/' + id + '/approve', { method: 'POST', body: {} });
      AIMC.toast('已核准');
      refresh(root);
    } catch (e) { AIMC.toast('操作失敗：' + e.message, true); }
  }

  async function reject(root, id) {
    const reason = prompt('請輸入退回原因（可留空）：') || '';
    try {
      await AIMC.api('/review/' + id + '/reject', { method: 'POST', body: { reject_reason: reason } });
      AIMC.toast('已退回');
      refresh(root);
    } catch (e) { AIMC.toast('操作失敗：' + e.message, true); }
  }

  // ── Part 6：Page API —— destroy / resume / pause（refresh 已定義於上方）──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function resume(root) { return refresh(root); }
  function pause() { console.info('[AIMC] Review paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.review = { load, destroy, refresh, resume, pause };
})();
