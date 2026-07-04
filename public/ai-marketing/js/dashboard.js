// ============================================================
// dashboard.js — Dashboard V3「AI Command Center」
// 純讀取既有 API 彙整而成，不新增任何端點、不改任何 CRUD 邏輯。
// 所有任務/建議皆為前端規則（knowledge/topics/prompts/content-history）推導。
//
// V3.1 Stability Pass：
// 原本這支檔案自己寫了一套 q()/setHTML() null guard（見上一輪修正），
// 這次全部拔掉，改用 shared.js 提供的 AIMC.DOM + AIMC.startLifecycle()，
// 避免每頁重複寫一樣的東西（Part 8：Code Cleanup）。
// 邏輯、資料來源、API 呼叫方式完全沒有改變。
// ============================================================
(function () {
  let currentDom = null; // 記錄最近一次 lifecycle 的 dom（含 listener registry），供 destroy() 使用

  async function load(root) {
    const lc = AIMC.startLifecycle('Dashboard');
    const dom = lc.dom;
    currentDom = dom;

    dom.html(root, '#dashStatGrid', [
      AIMC.statCard('📦', '-', '商品數'),
      AIMC.statCard('📚', '-', '知識數'),
      AIMC.statCard('📝', '-', 'Topic 數'),
      AIMC.statCard('🤖', '-', 'Prompt 數'),
      AIMC.statCard('✨', '-', 'Generated 數'),
      AIMC.statCard('⏳', '-', '待審核', 'warn'),
    ].join(''));
    dom.html(root, '#dashTaskList', AIMC.loadingHtml());
    dom.html(root, '#dashRecommend', AIMC.loadingHtml());
    dom.html(root, '#dashHealthGrid', AIMC.loadingHtml());
    dom.html(root, '#dashHotProducts', AIMC.loadingHtml());
    dom.html(root, '#dashRecentActivity', AIMC.loadingHtml());
    dom.on(root, '#dashRefreshBtn', 'click', () => load(root));
    dom.on(root, '#dashInitBtn', 'click', () => AIMC.runInitFlow(root, '#dashInitResult', () => load(root)));

    renderQuickStart(root, dom);

    try {
      await AIMC.loadCoreData();
      await AIMC.loadKnowledgeDetails();
      const rc = await AIMC.loadReviewCounts();
      try { await AIMC.loadPosProducts(); } catch (e) { console.warn('[AIMC] 讀取 POS 商品清單失敗（今日任務仍會顯示已建立知識的商品）：', e.message); }
      if (!lc.checkpoint('API 完成')) return; // Part 9：Render Queue —— token/序號過期就安全跳過

      const allInsights = AIMC.computeAllProductInsights(); // 含尚未初始化的 POS 商品，供 Part 11 流程卡使用
      const knowledgeInsights = AIMC.computeProductInsights(); // 只含已建立知識的商品，供推薦/健康度沿用既有邏輯
      renderStats(root, dom);
      renderCompleteness(root, dom);
      renderTasks(root, dom, allInsights, rc);
      renderRecommend(root, dom, knowledgeInsights);
      renderHealthGrid(root, dom, knowledgeInsights);
      renderHotProducts(root, dom);
      renderRecentActivity(root, dom);
      lc.done();
    } catch (e) {
      lc.fail(e, null, null, '讀取 Dashboard 資料失敗：');
    }
  }

  // ── Part 6：Page API —— destroy / refresh / resume / pause ──
  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function refresh(root) { return load(root); }
  function resume(root) { return load(root); } // 回到此頁時視同重新整理一次，確保資料最新
  function pause() { console.info('[AIMC] Dashboard paused（目前無長駐 timer，純狀態標記）'); }

  function renderStats(root, dom) {
    const s = AIMC.store;
    dom.html(root, '#dashStatGrid', [
      AIMC.statCard('📦', s.knowledge.length, '商品數'),
      AIMC.statCard('📚', s.knowledge.length, '知識數'),
      AIMC.statCard('📝', s.topics.length, 'Topic 數'),
      AIMC.statCard('🤖', s.prompts.length, 'Prompt 數'),
      AIMC.statCard('✨', s.history.length, 'Generated 數'),
      AIMC.statCard('⏳', s.reviewCounts.generated, '待審核', 'warn'),
    ].join(''));
  }

  function renderCompleteness(root, dom) {
    const s = AIMC.store;
    if (!s.knowledge.length) {
      dom.width(root, '#dashCompletenessBar', '0%');
      dom.text(root, '#dashCompletenessText', '尚無商品知識資料，建立第一筆商品知識後即可開始累積完成率。');
      return;
    }
    const total = s.knowledge.reduce((sum, row) => sum + AIMC.calcCompleteness(s.knowledgeDetail[row.id]), 0);
    const avg = Math.round(total / s.knowledge.length);
    dom.width(root, '#dashCompletenessBar', avg + '%');
    dom.text(root, '#dashCompletenessText', `平均知識完整度 ${avg}%（依 ${s.knowledge.length} 項商品知識計算）`);
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

  // Hotfix16 Part 11：流程卡加上明確的 Knowledge/Topic/Prompt/Generate/Review 勾選狀態
  function stageBadge(ok, label) {
    return `<span class="stage-badge ${ok ? 'ok' : 'no'}">${ok ? '✔' : '✖'} ${label}</span>`;
  }

  function renderTasks(root, dom, insights, rc) {
    if (!insights.length) {
      dom.html(root, '#dashTaskList', AIMC.emptyState('📦', '尚無 POS 商品，請先到「商品管理」建立商品'));
      return;
    }
    const sorted = [...insights].sort((a, b) => taskUrgencyScore(b) - taskUrgencyScore(a)).slice(0, 6);
    const html = sorted.map((ins) => {
      const name = AIMC.esc(ins.row.product_name);

      // Part 3：尚未初始化的 POS 商品（連 Knowledge 都還沒有）— 只給一個初始化 CTA
      if (ins.uninitialized) {
        return `
        <div class="task-card warn">
          <div class="tc-head"><span class="tc-title">${name}</span>${AIMC.badge('尚未初始化', 'sensitive')}</div>
          <div class="tc-detail">此商品尚未建立任何 AI 知識，建議先建立商品知識或直接使用一鍵初始化。</div>
          <div class="tc-ctas">
            <button class="btn ai sm" onclick="location.hash='#/knowledge/new-ai'">📚 建立商品知識</button>
          </div>
        </div>`;
      }

      const hasKnowledge = true; // insights 只有已建 knowledge 的商品才會走到這裡（uninitialized 已在上面提前 return）
      const hasTopic = ins.topics.length > 0;
      const hasPrompt = ins.promptCount > 0;
      const hasGenerate = ins.genCount > 0;
      const hasReview = ins.approvedCount > 0;

      const stages = [
        stageBadge(hasKnowledge, 'Knowledge'),
        stageBadge(hasTopic, 'Topic'),
        stageBadge(hasPrompt, 'Prompt'),
        stageBadge(hasGenerate, 'Generate'),
        stageBadge(hasReview, 'Review'),
        `<span class="stage-badge soon">🔒 Publish（即將推出）</span>`,
      ].join('');

      const lines = [];
      lines.push(`完成度 ${ins.pct}%${ins.pct < 50 ? '（偏低）' : ''}　・　Topic ${ins.topics.length}　・　Prompt ${ins.promptCount}　・　Generated ${ins.genCount}　・　待審核 ${ins.pendingCount}`);
      if (ins.platforms.length) lines.push(`今天可生成：${ins.platforms.map((p) => AIMC.platformLabel(p)).join('、')}`);
      if (ins.sensitiveCount) lines.push(`⚠️ 有 ${ins.sensitiveCount} 個主題涉及敏感宣稱，生成後請審慎審核`);

      const ctas = [];
      if (ins.pct < 70) ctas.push({ label: '📚 補知識', href: '#/knowledge/' + ins.row.id });
      if (!hasTopic) ctas.push({ label: '📝 建主題', href: '#/topics/' + encodeURIComponent(ins.row.external_product_id) });
      else if (!hasPrompt) ctas.push({ label: '🤖 補 Prompt', href: '#/prompts' });
      if (hasPrompt && !hasGenerate) ctas.push({ label: '✨ 生成內容', href: '#/generate/' + encodeURIComponent(ins.row.external_product_id) });
      if (ins.pendingCount) ctas.push({ label: '✅ 去審核', href: '#/review' });
      if (!ctas.length) ctas.push({ label: '👍 保持優化', href: '#/knowledge/' + ins.row.id });

      let cls = 'task-card';
      if (ins.pendingCount || ins.sensitiveCount) cls += ' urgent';
      else if (ins.pct < 50) cls += ' warn';

      return `
      <div class="${cls}">
        <div class="tc-head"><span class="tc-title">${name}</span>${ins.pendingCount ? AIMC.badge(ins.pendingCount + ' 待審核', 'generated') : ''}</div>
        <div class="tc-stages">${stages}</div>
        <div class="tc-detail">${lines.join('<br>')}</div>
        <div class="tc-ctas">${ctas.map((c) => `<button class="btn ghost sm" onclick="location.hash='${c.href}'">${c.label}</button>`).join('')}</div>
      </div>`;
    }).join('');
    dom.html(root, '#dashTaskList', html);
  }

  // ── ② 今日 AI 建議：綜合分數推薦一個主打商品 ──
  function renderRecommend(root, dom, insights) {
    const withTopics = insights.filter((i) => i.topics.length > 0);
    const pool = withTopics.length ? withTopics : insights;
    if (!pool.length) {
      dom.html(root, '#dashRecommend', AIMC.emptyState('💡', '尚無足夠資料，建立商品知識與主題後 AI 才能給出推薦。'));
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

    dom.html(root, '#dashRecommend', `
      <div class="recommend-card">
        <div class="rc-head">🎯 推薦商品：${AIMC.esc(best.row.product_name)}</div>
        <div class="rc-reasons">${reasons.map((r) => AIMC.badge(r, 'outline')).join('')}</div>
        <p class="muted" style="margin:0">完成度 ${best.pct}%　・　Topic ${best.topics.length}　・　Prompt ${best.promptCount}　・　Generated ${best.genCount}　・　待審核 ${best.pendingCount}</p>
        <div class="rc-ctas">${ctas}</div>
      </div>`);
  }

  // ── ③ 快速開始（三張大卡）──
  function renderQuickStart(root, dom) {
    const items = [
      { icon: '🤖', title: 'AI 補知識', desc: '一鍵產生商品知識草稿（介紹／特色／FAQ／迷思…），確認後再儲存', href: '#/knowledge/new-ai' },
      { icon: '📝', title: 'AI 建主題', desc: '依商品套用 AI Topic Suggestions，一鍵建立主題', href: '#/topics' },
      { icon: '✨', title: 'AI 生成內容', desc: '用 AI Content Studio 快速選商品、主題、平台生成內容', href: '#/generate' },
    ];
    dom.html(root, '#dashQuickStart', items.map((it) => `
      <div class="quickstart-card" onclick="location.hash='${it.href}'">
        <div class="qc-icon">${it.icon}</div>
        <div class="qc-title">${AIMC.esc(it.title)}</div>
        <div class="qc-desc">${AIMC.esc(it.desc)}</div>
      </div>`).join(''));
  }

  // ── ④ 商品健康度（精簡版卡片，完整版在 Knowledge 頁）──
  function renderHealthGrid(root, dom, insights) {
    if (!insights.length) { dom.html(root, '#dashHealthGrid', AIMC.emptyState('🩺', '尚無商品資料')); return; }
    const top = [...insights].sort((a, b) => taskUrgencyScore(b) - taskUrgencyScore(a)).slice(0, 6);
    dom.html(root, '#dashHealthGrid', top.map((ins) => `
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
      </div>`).join(''));
  }

  function renderHotProducts(root, dom) {
    const s = AIMC.store;
    if (!s.knowledge.length) { dom.html(root, '#dashHotProducts', AIMC.emptyState('📦', '尚無商品資料')); return; }
    const counts = s.knowledge.map((row) => {
      const topicIds = s.topics.filter((t) => t.external_product_id === row.external_product_id).map((t) => t.id);
      const genCount = s.history.filter((h) => topicIds.includes(h.topic_id)).length;
      return { row, genCount };
    }).sort((a, b) => b.genCount - a.genCount).slice(0, 5);
    if (!counts.some((c) => c.genCount > 0)) { dom.html(root, '#dashHotProducts', AIMC.emptyState('🔥', '尚無生成紀錄，快去產生第一篇內容吧')); return; }
    dom.html(root, '#dashHotProducts', counts.map((c, i) => `
      <div class="hot-product-item">
        <span class="rank">${i + 1}</span>
        <span style="flex:1">${AIMC.esc(c.row.product_name)}</span>
        <span class="muted">${c.genCount} 篇內容</span>
      </div>`).join(''));
  }

  function renderRecentActivity(root, dom) {
    const s = AIMC.store;
    const recent = [...s.history].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6);
    if (!recent.length) { dom.html(root, '#dashRecentActivity', AIMC.emptyState('🕒', '尚無活動紀錄')); return; }
    dom.html(root, '#dashRecentActivity', recent.map((h) => `
      <div class="timeline-item">
        <span class="dot">${h.status === 'approved' ? '✅' : h.status === 'rejected' ? '❌' : '📝'}</span>
        <span class="txt">${AIMC.platformLabel(h.platform)} 內容已${h.status === 'approved' ? '核准' : h.status === 'rejected' ? '退回' : '生成'}</span>
        <span class="time">${AIMC.fmtTime(h.created_at)}</span>
      </div>`).join(''));
  }

  AIMC.pages.dashboard = { load, destroy, refresh, resume, pause };
})();
