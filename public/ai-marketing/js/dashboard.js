// ============================================================
// dashboard.js — Dashboard V3「AI Command Center」
// 純讀取既有 API 彙整而成，不新增任何端點、不改任何 CRUD 邏輯。
// 所有任務/建議皆為前端規則（knowledge/topics/prompts/content-history）推導。
// ============================================================
(function () {
  async function load(root) {
    root.querySelector('#dashStatGrid').innerHTML = [
      AIMC.statCard('📦', '-', '商品數'),
      AIMC.statCard('📚', '-', '知識數'),
      AIMC.statCard('📝', '-', 'Topic 數'),
      AIMC.statCard('🤖', '-', 'Prompt 數'),
      AIMC.statCard('✨', '-', 'Generated 數'),
      AIMC.statCard('⏳', '-', '待審核', 'warn'),
    ].join('');
    root.querySelector('#dashTaskList').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashRecommend').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashHealthGrid').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashHotProducts').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashRecentActivity').innerHTML = AIMC.loadingHtml();

    const btn = root.querySelector('#dashRefreshBtn');
    if (btn) btn.addEventListener('click', () => load(root));

    renderQuickStart(root);

    try {
      await AIMC.loadCoreData();
      await AIMC.loadKnowledgeDetails();
      const rc = await AIMC.loadReviewCounts();
      const insights = AIMC.computeProductInsights();
      renderStats(root);
      renderCompleteness(root);
      renderTasks(root, insights, rc);
      renderRecommend(root, insights);
      renderHealthGrid(root, insights);
      renderHotProducts(root);
      renderRecentActivity(root);
    } catch (e) {
      AIMC.toast('讀取 Dashboard 資料失敗：' + e.message, true);
    }
  }

  function renderStats(root) {
    const s = AIMC.store;
    root.querySelector('#dashStatGrid').innerHTML = [
      AIMC.statCard('📦', s.knowledge.length, '商品數'),
      AIMC.statCard('📚', s.knowledge.length, '知識數'),
      AIMC.statCard('📝', s.topics.length, 'Topic 數'),
      AIMC.statCard('🤖', s.prompts.length, 'Prompt 數'),
      AIMC.statCard('✨', s.history.length, 'Generated 數'),
      AIMC.statCard('⏳', s.reviewCounts.generated, '待審核', 'warn'),
    ].join('');
  }

  function renderCompleteness(root) {
    const s = AIMC.store;
    const bar = root.querySelector('#dashCompletenessBar');
    const text = root.querySelector('#dashCompletenessText');
    if (!s.knowledge.length) {
      bar.style.width = '0%';
      text.textContent = '尚無商品知識資料，建立第一筆商品知識後即可開始累積完成率。';
      return;
    }
    const total = s.knowledge.reduce((sum, row) => sum + AIMC.calcCompleteness(s.knowledgeDetail[row.id]), 0);
    const avg = Math.round(total / s.knowledge.length);
    bar.style.width = avg + '%';
    text.textContent = `平均知識完整度 ${avg}%（依 ${s.knowledge.length} 項商品知識計算）`;
  }

  // ── ① 今日 AI 任務：逐商品規則推導，附具體數字與 CTA ──
  function taskUrgencyScore(ins) {
    let score = (100 - ins.pct);
    score += ins.pendingCount * 10;
    if (!ins.topics.length) score += 50;
    else if (!ins.promptCount) score += 30;
    else if (!ins.genCount) score += 20;
    if (ins.sensitiveCount) score += 15;
    return score;
  }

  function renderTasks(root, insights, rc) {
    const el = root.querySelector('#dashTaskList');
    if (!insights.length) {
      el.innerHTML = AIMC.emptyState('📦', '尚未建立任何商品知識，建議先從 1-2 個主打商品開始。');
      return;
    }
    const sorted = [...insights].sort((a, b) => taskUrgencyScore(b) - taskUrgencyScore(a)).slice(0, 6);
    el.innerHTML = sorted.map((ins) => {
      const name = AIMC.esc(ins.row.product_name);
      const lines = [];
      lines.push(`完成度 ${ins.pct}%${ins.pct < 50 ? '（偏低）' : ''}　・　Topic ${ins.topics.length}　・　Prompt ${ins.promptCount}　・　Generated ${ins.genCount}　・　待審核 ${ins.pendingCount}`);
      if (ins.platforms.length) lines.push(`今天可生成：${ins.platforms.map((p) => AIMC.platformLabel(p)).join('、')}`);
      if (ins.sensitiveCount) lines.push(`⚠️ 有 ${ins.sensitiveCount} 個主題涉及敏感宣稱，生成後請審慎審核`);

      const ctas = [];
      if (ins.pct < 70) ctas.push({ label: '📚 補知識', href: '#/knowledge/' + ins.row.id });
      if (!ins.topics.length) ctas.push({ label: '📝 建主題', href: '#/topics/' + encodeURIComponent(ins.row.external_product_id) });
      if (ins.promptCount && !ins.genCount) ctas.push({ label: '✨ 生成內容', href: '#/generate/' + encodeURIComponent(ins.row.external_product_id) });
      if (ins.pendingCount) ctas.push({ label: '✅ 去審核', href: '#/review' });
      if (!ctas.length) ctas.push({ label: '👍 保持優化', href: '#/knowledge/' + ins.row.id });

      let cls = 'task-card';
      if (ins.pendingCount || ins.sensitiveCount) cls += ' urgent';
      else if (ins.pct < 50) cls += ' warn';

      return `
      <div class="${cls}">
        <div class="tc-head"><span class="tc-title">${name}</span>${ins.pendingCount ? AIMC.badge(ins.pendingCount + ' 待審核', 'generated') : ''}</div>
        <div class="tc-detail">${lines.join('<br>')}</div>
        <div class="tc-ctas">${ctas.map((c) => `<button class="btn ghost sm" onclick="location.hash='${c.href}'">${c.label}</button>`).join('')}</div>
      </div>`;
    }).join('');
  }

  // ── ② 今日 AI 建議：綜合分數推薦一個主打商品 ──
  function renderRecommend(root, insights) {
    const el = root.querySelector('#dashRecommend');
    const withTopics = insights.filter((i) => i.topics.length > 0);
    const pool = withTopics.length ? withTopics : insights;
    if (!pool.length) {
      el.innerHTML = AIMC.emptyState('💡', '尚無足夠資料，建立商品知識與主題後 AI 才能給出推薦。');
      return;
    }
    const best = [...pool].sort((a, b) => AIMC.recommendScore(b) - AIMC.recommendScore(a))[0];
    const reasons = [];
    if (best.pct >= 70) reasons.push('知識完整');
    if (best.topics.length >= 3) reasons.push('Topic 豐富');
    if (best.promptCount >= 2) reasons.push('Prompt 齊全');
    if (best.genCount >= 3) reasons.push('熱門（生成量高）');
    if (best.pendingCount === 0 && best.genCount > 0) reasons.push('待審核少');
    if (best.row.price) reasons.push(`定價 $${best.row.price}`);
    if (!reasons.length) reasons.push('潛力商品，值得優先投入');

    const ctas = best.platforms.length
      ? best.platforms.map((p) => `<button class="btn sm" onclick="location.hash='#/generate/${encodeURIComponent(best.row.external_product_id)}'">⚡ ${AIMC.esc(AIMC.platformLabel(p))} 生成</button>`).join('')
      : `<button class="btn sm" onclick="location.hash='#/topics/${encodeURIComponent(best.row.external_product_id)}'">📝 建立主題</button>`;

    el.innerHTML = `
      <div class="recommend-card">
        <div class="rc-head">🎯 推薦商品：${AIMC.esc(best.row.product_name)}</div>
        <div class="rc-reasons">${reasons.map((r) => AIMC.badge(r, 'outline')).join('')}</div>
        <p class="muted" style="margin:0">完成度 ${best.pct}%　・　Topic ${best.topics.length}　・　Prompt ${best.promptCount}　・　Generated ${best.genCount}　・　待審核 ${best.pendingCount}</p>
        <div class="rc-ctas">${ctas}</div>
      </div>`;
  }

  // ── ③ 快速開始（三張大卡）──
  function renderQuickStart(root) {
    const el = root.querySelector('#dashQuickStart');
    const items = [
      { icon: '🤖', title: 'AI 補知識', desc: '一鍵產生商品知識草稿（介紹／特色／FAQ／迷思…），確認後再儲存', href: '#/knowledge/new-ai' },
      { icon: '📝', title: 'AI 建主題', desc: '依商品套用 AI Topic Suggestions，一鍵建立主題', href: '#/topics' },
      { icon: '✨', title: 'AI 生成內容', desc: '用 AI Content Studio 快速選商品、主題、平台生成內容', href: '#/generate' },
    ];
    el.innerHTML = items.map((it) => `
      <div class="quickstart-card" onclick="location.hash='${it.href}'">
        <div class="qc-icon">${it.icon}</div>
        <div class="qc-title">${AIMC.esc(it.title)}</div>
        <div class="qc-desc">${AIMC.esc(it.desc)}</div>
      </div>`).join('');
  }

  // ── ④ 商品健康度（精簡版卡片，完整版在 Knowledge 頁）──
  function renderHealthGrid(root, insights) {
    const el = root.querySelector('#dashHealthGrid');
    if (!insights.length) { el.innerHTML = AIMC.emptyState('🩺', '尚無商品資料'); return; }
    const top = [...insights].sort((a, b) => taskUrgencyScore(b) - taskUrgencyScore(a)).slice(0, 6);
    el.innerHTML = top.map((ins) => `
      <div class="health-card" onclick="location.hash='#/knowledge/${ins.row.id}'">
        <div class="hc-head">
          <div><div class="hc-name">${AIMC.esc(ins.row.product_name)}</div><div class="hc-code">${AIMC.esc(ins.row.external_product_id)}</div></div>
          <span class="badge outline">${ins.pct}%</span>
        </div>
        ${ins.missing.length ? `<div class="hc-missing">缺少：${ins.missing.map((m) => AIMC.badge(m, 'sensitive')).join('')}</div>` : ''}
        <div class="hc-stats">
          <div><div class="hc-stat-num">${ins.topics.length}</div><div class="hc-stat-label">Topic</div></div>
          <div><div class="hc-stat-num">${ins.promptCount}</div><div class="hc-stat-label">Prompt</div></div>
          <div><div class="hc-stat-num">${ins.genCount}</div><div class="hc-stat-label">Generated</div></div>
          <div><div class="hc-stat-num">${ins.pendingCount}</div><div class="hc-stat-label">Review</div></div>
        </div>
        <div class="hc-hint">💡 ${AIMC.esc(AIMC.nextStepHint(ins))}</div>
      </div>`).join('');
  }

  function renderHotProducts(root) {
    const s = AIMC.store;
    const el = root.querySelector('#dashHotProducts');
    if (!s.knowledge.length) { el.innerHTML = AIMC.emptyState('📦', '尚無商品資料'); return; }
    const counts = s.knowledge.map((row) => {
      const topicIds = s.topics.filter((t) => t.external_product_id === row.external_product_id).map((t) => t.id);
      const genCount = s.history.filter((h) => topicIds.includes(h.topic_id)).length;
      return { row, genCount };
    }).sort((a, b) => b.genCount - a.genCount).slice(0, 5);
    if (!counts.some((c) => c.genCount > 0)) { el.innerHTML = AIMC.emptyState('🔥', '尚無生成紀錄，快去產生第一篇內容吧'); return; }
    el.innerHTML = counts.map((c, i) => `
      <div class="hot-product-item">
        <span class="rank">${i + 1}</span>
        <span style="flex:1">${AIMC.esc(c.row.product_name)}</span>
        <span class="muted">${c.genCount} 篇內容</span>
      </div>`).join('');
  }

  function renderRecentActivity(root) {
    const s = AIMC.store;
    const el = root.querySelector('#dashRecentActivity');
    const recent = [...s.history].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6);
    if (!recent.length) { el.innerHTML = AIMC.emptyState('🕒', '尚無活動紀錄'); return; }
    el.innerHTML = recent.map((h) => `
      <div class="timeline-item">
        <span class="dot">${h.status === 'approved' ? '✅' : h.status === 'rejected' ? '❌' : '📝'}</span>
        <span class="txt">${AIMC.platformLabel(h.platform)} 內容已${h.status === 'approved' ? '核准' : h.status === 'rejected' ? '退回' : '生成'}</span>
        <span class="time">${AIMC.fmtTime(h.created_at)}</span>
      </div>`).join('');
  }

  AIMC.pages.dashboard = { load };
})();
