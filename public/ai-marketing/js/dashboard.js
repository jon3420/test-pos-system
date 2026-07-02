// ============================================================
// dashboard.js — Dashboard 頁面（首頁，非商品知識）
// 純讀取既有 API 彙整而成，不新增任何端點、不改任何 CRUD 邏輯。
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
    root.querySelector('#dashSuggestionList').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashHotProducts').innerHTML = AIMC.loadingHtml();
    root.querySelector('#dashRecentActivity').innerHTML = AIMC.loadingHtml();

    const btn = root.querySelector('#dashRefreshBtn');
    if (btn) btn.addEventListener('click', () => load(root));

    renderQuickStart(root);

    try {
      await AIMC.loadCoreData();
      await AIMC.loadKnowledgeDetails();
      const rc = await AIMC.loadReviewCounts();
      renderStats(root);
      renderCompleteness(root);
      renderTasks(root, rc);
      renderSuggestions(root, rc);
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

  function renderTasks(root, rc) {
    const s = AIMC.store;
    const el = root.querySelector('#dashTaskList');
    const tasks = [];
    if (!s.knowledge.length) {
      tasks.push({ icon: '📦', html: '尚未建立任何<b>商品知識</b>，建議先從 1-2 個主打商品開始。', route: 'knowledge', cta: '前往建立' });
    } else {
      const low = s.knowledge.filter((row) => AIMC.calcCompleteness(s.knowledgeDetail[row.id]) < 50);
      if (low.length) tasks.push({ icon: '📚', html: `有 <b>${low.length}</b> 項商品知識完整度低於 50%，建議補充內容。`, route: 'knowledge', cta: '去補充' });
    }
    const noTopic = s.knowledge.filter((row) => !s.topics.some((t) => t.external_product_id === row.external_product_id));
    if (noTopic.length) tasks.push({ icon: '📝', html: `有 <b>${noTopic.length}</b> 項商品尚未建立任何主題。`, route: 'topics', cta: '去建立' });
    const noPrompt = s.topics.filter((t) => !s.prompts.some((p) => p.topic_id === t.id));
    if (noPrompt.length) tasks.push({ icon: '🤖', html: `有 <b>${noPrompt.length}</b> 個主題尚未建立 Prompt。`, route: 'prompts', cta: '去建立' });
    if (rc.g.length) tasks.push({ icon: '⏳', html: `有 <b>${rc.g.length}</b> 篇內容待審核。`, route: 'review', cta: '去審核' });
    const sensitive = s.topics.filter((t) => t.claim_sensitive);
    if (sensitive.length) tasks.push({ icon: '⚠️', html: `有 <b>${sensitive.length}</b> 個主題涉及敏感宣稱，內容生成後請審慎審核。`, route: 'topics', cta: '查看' });

    if (!tasks.length) { el.innerHTML = AIMC.emptyState('🎉', '目前沒有待處理任務，做得很好！'); return; }
    el.innerHTML = tasks.map((t) => `
      <div class="task-item">
        <span class="dot">${t.icon}</span>
        <span class="txt">${t.html}</span>
        <button class="btn ghost sm cta" onclick="location.hash='#/${t.route}'">${t.cta}</button>
      </div>`).join('');
  }

  function renderSuggestions(root, rc) {
    const s = AIMC.store;
    const el = root.querySelector('#dashSuggestionList');
    const list = [];
    const productNoTopic = s.knowledge.find((row) => !s.topics.some((t) => t.external_product_id === row.external_product_id));
    if (productNoTopic) list.push({ icon: '💡', html: `建議為「<b>${AIMC.esc(productNoTopic.product_name)}</b>」建立第一個主題。`, route: 'topics' });
    const topicNoPrompt = s.topics.find((t) => !s.prompts.some((p) => p.topic_id === t.id));
    if (topicNoPrompt) list.push({ icon: '💡', html: `主題「<b>${AIMC.esc(topicNoPrompt.title)}</b>」還沒有 Prompt，建議建立模板。`, route: 'prompts' });
    const topicReadyToGen = s.topics.find((t) => s.prompts.some((p) => p.topic_id === t.id) && !s.history.some((h) => h.topic_id === t.id));
    if (topicReadyToGen) list.push({ icon: '💡', html: `主題「<b>${AIMC.esc(topicReadyToGen.title)}</b>」已有 Prompt，可以產生第一篇內容了。`, route: 'generate' });
    if (rc.g.length) list.push({ icon: '💡', html: `有 <b>${rc.g.length}</b> 篇內容在等待審核，別讓靈感過期。`, route: 'review' });
    if (!list.length) list.push({ icon: '✨', html: '目前資料完整，AI 暫無特別建議，持續保持！', route: '' });

    el.innerHTML = list.slice(0, 4).map((s2) => `
      <div class="suggestion-item">
        <span class="dot">${s2.icon}</span>
        <span class="txt">${s2.html}</span>
        ${s2.route ? `<button class="btn ghost sm cta" onclick="location.hash='#/${s2.route}'">前往</button>` : ''}
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

  function renderQuickStart(root) {
    const el = root.querySelector('#dashQuickStart');
    const items = [
      { icon: '📚', title: '建立商品知識', desc: '從商品介紹、特色開始累積內容素材', route: 'knowledge' },
      { icon: '✨', title: '產生一篇內容', desc: '用 Wizard 快速選商品、主題、平台生成', route: 'generate' },
      { icon: '✅', title: '前往審核', desc: '確認 AI 生成內容是否可用', route: 'review' },
    ];
    el.innerHTML = items.map((it) => `
      <div class="card" style="cursor:pointer;margin-bottom:0" onclick="location.hash='#/${it.route}'">
        <div style="font-size:22px">${it.icon}</div>
        <div style="font-weight:700;margin:6px 0 2px">${AIMC.esc(it.title)}</div>
        <div class="muted">${AIMC.esc(it.desc)}</div>
      </div>`).join('');
  }

  AIMC.pages.dashboard = { load };
})();
