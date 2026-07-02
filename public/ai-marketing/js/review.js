// ============================================================
// review.js — 審核 Workspace（雙欄 Email 式介面）
// CRUD 呼叫方式與欄位 100% 沿用 Phase 1 /review 端點，不做任何邏輯變更。
// ============================================================
(function () {
  let selectedId = null;
  let currentList = [];

  async function load(root) {
    root.querySelector('#rStatusFilter').addEventListener('change', () => { selectedId = null; refresh(root); });
    root.querySelector('#rRefreshBtn').addEventListener('click', () => refresh(root));
    await refresh(root);
  }

  async function refresh(root) {
    const status = root.querySelector('#rStatusFilter').value;
    root.querySelector('#rListPane').innerHTML = AIMC.loadingHtml();
    try {
      const rc = await AIMC.loadReviewCounts();
      renderStats(root, rc);
      const { data } = await AIMC.api('/review?status=' + encodeURIComponent(status));
      currentList = data;
      renderList(root, status);
      if (selectedId && data.some((d) => d.id === selectedId)) {
        renderDetail(root, selectedId, status);
      } else if (data.length) {
        selectedId = data[0].id;
        renderDetail(root, selectedId, status);
      } else {
        selectedId = null;
        root.querySelector('#rDetailPane').innerHTML = '<div class="empty">請從左側選擇一筆內容查看詳情</div>';
      }
    } catch (e) {
      root.querySelector('#rListPane').innerHTML = `<div class="empty">載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  function renderStats(root, rc) {
    const todayCount = [...rc.a, ...rc.r].filter((h) => AIMC.isToday(h.updated_at)).length;
    root.querySelector('#rStatGrid').innerHTML = [
      AIMC.statCard('⏳', AIMC.store.reviewCounts.generated, '待審核', 'warn'),
      AIMC.statCard('✅', AIMC.store.reviewCounts.approved, '已通過'),
      AIMC.statCard('❌', AIMC.store.reviewCounts.rejected, '已退回', 'danger'),
      AIMC.statCard('📅', todayCount, '今日審核數'),
    ].join('');
  }

  function renderList(root, status) {
    const el = root.querySelector('#rListPane');
    if (!currentList.length) { el.innerHTML = AIMC.emptyState('✅', '目前沒有符合條件的內容'); return; }
    el.innerHTML = currentList.map((item) => {
      const goal = (item.generation_params && item.generation_params.content_goal) || '-';
      return `
      <div class="review-list-item ${item.id === selectedId ? 'active' : ''}" data-id="${item.id}">
        <div class="rli-top"><span>${AIMC.platformLabel(item.platform)} ・ ${AIMC.esc(goal)}</span><span>${AIMC.fmtTime(item.created_at)}</span></div>
        <div class="rli-title">${AIMC.esc(item.product_name || '-')} ・ ${AIMC.esc(item.topic_title || '-')}</div>
        <div class="rli-preview">${AIMC.esc((item.generated_text || '').slice(0, 60))}</div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-id]').forEach((it) => it.addEventListener('click', () => {
      selectedId = it.dataset.id; renderList(root, status); renderDetail(root, selectedId, status);
    }));
  }

  function renderDetail(root, id, status) {
    const item = currentList.find((x) => x.id === id);
    const pane = root.querySelector('#rDetailPane');
    if (!item) { pane.innerHTML = '<div class="empty">請從左側選擇一筆內容查看詳情</div>'; return; }
    const goal = (item.generation_params && item.generation_params.content_goal) || '-';
    pane.innerHTML = `
      <div class="flex-between">
        <div>
          <strong>${AIMC.platformLabel(item.platform)}</strong>
          ${item.product_name ? ` · <span class="muted">${AIMC.esc(item.product_name)}</span>` : ''}
          ${item.topic_title ? ` · <span class="muted">${AIMC.esc(item.topic_title)}</span>` : ''}
          ${AIMC.badge(goal, 'outline')}
        </div>
        ${AIMC.badge(item.status, item.status)}
      </div>
      <p class="muted" style="margin:8px 0">
        模型：${AIMC.esc(item.model_provider || '-')}/${AIMC.esc(item.model_name || '-')}
        　Prompt 版本：v${AIMC.esc(item.prompt_version ?? '-')}
        　耗時：${item.duration_ms != null ? item.duration_ms + 'ms' : '-'}
        　生成時間：${AIMC.fmtTime(item.created_at)}
      </p>
      <div class="gen-result">${AIMC.esc(item.generated_text)}</div>
      ${item.reject_reason ? `<p class="muted">退回原因：${AIMC.esc(item.reject_reason)}</p>` : ''}
      ${status === 'generated' ? `
        <div class="row-actions">
          <button class="btn success" id="r_approveBtn">✅ 核准</button>
          <button class="btn danger" id="r_rejectBtn">❌ 退回</button>
        </div>` : ''}
    `;
    if (status === 'generated') {
      pane.querySelector('#r_approveBtn').addEventListener('click', () => approve(root, item.id));
      pane.querySelector('#r_rejectBtn').addEventListener('click', () => reject(root, item.id));
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

  AIMC.pages.review = { load };
})();
