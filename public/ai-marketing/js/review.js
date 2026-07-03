// ============================================================
// review.js — 審核 Workspace V3（雙欄 Email 式介面 + 排序 + 建議 + 複製）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /review 端點，不做任何邏輯變更。
// 排序 / 敏感標示 / AI 建議文字 / 複製功能，全部是前端對既有資料的
// 排序與展示處理，不新增、不修改任何 API。
//
// V3.1 Stability Pass：所有 DOM 讀寫改用 AIMC.DOM，refresh()（打了 3 支 API
// ＋ N 支 /knowledge/:id 明細）用 AIMC.startLifecycle() 做 Page Token 檢查。
// ============================================================
(function () {
  let selectedId = null;
  let currentList = [];
  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用
  const PLATFORM_ORDER = ['fb', 'line', 'ig', 'tiktok', 'threads', 'google_business', 'youtube_shorts'];

  async function load(root) {
    const lc = AIMC.startLifecycle('Review');
    currentDom = lc.dom;
    lc.dom.on(root, '#rStatusFilter', 'change', () => { selectedId = null; refresh(root); });
    lc.dom.on(root, '#rSortBy', 'change', () => { renderList(root, lc.dom, lc.dom.value(root, '#rStatusFilter')); });
    lc.dom.on(root, '#rRefreshBtn', 'click', () => refresh(root));
    lc.done('event bindings ready');
    await refresh(root);
  }

  async function refresh(root) {
    const lc = AIMC.startLifecycle('Review:refresh');
    currentDom = lc.dom;
    const status = lc.dom.value(root, '#rStatusFilter') || 'generated';
    lc.dom.html(root, '#rListPane', AIMC.loadingHtml());
    try {
      const rc = await AIMC.loadReviewCounts();
      if (!lc.checkpoint('review counts 完成')) return;
      renderStats(root, lc.dom, rc);

      const [{ data: list }, { data: topics }, { data: knowledge }] = await Promise.all([
        AIMC.api('/review?status=' + encodeURIComponent(status)), AIMC.api('/topics'), AIMC.api('/knowledge'),
      ]);
      if (!lc.checkpoint('review/topics/knowledge 完成')) return;
      AIMC.store.topics = topics;
      AIMC.store.knowledge = knowledge;
      currentList = list;

      await ensureCompletenessMap();
      if (!lc.checkpoint('completeness 明細完成')) return;

      renderList(root, lc.dom, status);
      if (selectedId && list.some((d) => d.id === selectedId)) {
        renderDetail(root, lc.dom, selectedId, status);
      } else if (list.length) {
        selectedId = list[0].id;
        renderDetail(root, lc.dom, selectedId, status);
      } else {
        selectedId = null;
        lc.dom.html(root, '#rDetailPane', '<div class="empty">請從左側選擇一筆內容查看詳情</div>');
      }
      lc.done();
    } catch (e) {
      lc.fail(e, root, '#rListPane');
    }
  }

  // 商品完整度排序需要每個知識項目的明細（loadKnowledgeDetails 會抓 N 次 /knowledge/:id）
  async function ensureCompletenessMap() {
    try { await AIMC.loadKnowledgeDetails(); } catch (e) { /* 排序退回不依完整度也沒關係 */ }
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
    }
    return arr;
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

  function reviewHint(item) {
    const topic = topicOf(item);
    if (topic && topic.claim_sensitive) return '⚠️ 涉及功效／宣稱，請審慎確認用語';
    if (AIMC.isToday(item.created_at)) return '🕒 今日新生成，建議儘快審核維持時效性';
    if (item.status === 'generated') return '💡 核准後即可作為對外發布素材';
    return '';
  }

  function renderList(root, dom, status) {
    if (!currentList.length) { dom.html(root, '#rListPane', AIMC.emptyState('✅', '目前沒有符合條件的內容')); return; }
    const sortBy = dom.value(root, '#rSortBy') || 'default';
    const sorted = sortList(currentList, sortBy);
    dom.html(root, '#rListPane', sorted.map((item) => {
      const goal = (item.generation_params && item.generation_params.content_goal) || '-';
      const topic = topicOf(item);
      const hint = reviewHint(item);
      return `
      <div class="review-list-item ${item.id === selectedId ? 'active' : ''}" data-id="${item.id}">
        <div class="rli-top"><span>${AIMC.platformLabel(item.platform)} ・ ${AIMC.esc(goal)}</span><span>${AIMC.fmtTime(item.created_at)}</span></div>
        <div class="rli-title">${AIMC.esc(item.product_name || '-')} ・ ${AIMC.esc(item.topic_title || '-')} ${topic && topic.claim_sensitive ? AIMC.badge('⚠️敏感', 'sensitive') : ''}</div>
        <div class="rli-preview">${AIMC.esc((item.generated_text || '').slice(0, 60))}</div>
        ${hint ? `<div class="review-hint">${AIMC.esc(hint)}</div>` : ''}
      </div>`;
    }).join(''));
    const el = dom.query(root, '#rListPane');
    if (el) {
      el.querySelectorAll('[data-id]').forEach((it) => it.addEventListener('click', () => {
        selectedId = it.dataset.id; renderList(root, dom, status); renderDetail(root, dom, selectedId, status);
      }));
    }
  }

  function renderDetail(root, dom, id, status) {
    const item = currentList.find((x) => x.id === id);
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
        　Prompt 版本：v${AIMC.esc(item.prompt_version ?? '-')}
        　耗時：${item.duration_ms != null ? item.duration_ms + 'ms' : '-'}
        　生成時間：${AIMC.fmtTime(item.created_at)}
      </p>
      ${hint ? `<p class="review-hint" style="font-size:12px;margin:0 0 8px">${AIMC.esc(hint)}</p>` : ''}
      <div class="gen-result">${AIMC.esc(item.generated_text)}</div>
      ${item.reject_reason ? `<p class="muted">退回原因：${AIMC.esc(item.reject_reason)}</p>` : ''}
      <div class="row-actions">
        <button class="btn secondary" id="r_copyBtn">📋 複製</button>
        ${status === 'generated' ? `
          <button class="btn success" id="r_approveBtn">✅ 核准</button>
          <button class="btn danger" id="r_rejectBtn">❌ 退回</button>` : ''}
      </div>
    `);
    dom.on(root, '#r_copyBtn', 'click', () => AIMC.copyToClipboard(item.generated_text));
    if (status === 'generated') {
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
