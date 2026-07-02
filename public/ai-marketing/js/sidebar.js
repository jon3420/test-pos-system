// ============================================================
// sidebar.js — 固定左側導航（Shopify Admin / Notion / Linear 風格）
// 只負責畫面渲染與 active 狀態切換，實際換頁交給 router.js
// ============================================================
(function () {
  const NAV_GROUPS = [
    {
      items: [
        { route: 'dashboard', icon: '🏠', label: 'Dashboard' },
        { route: 'knowledge', icon: '📚', label: '商品知識' },
        { route: 'topics', icon: '📝', label: '主題' },
        { route: 'prompts', icon: '🤖', label: 'Prompt' },
        { route: 'generate', icon: '✨', label: 'AI生成' },
        { route: 'review', icon: '✅', label: '審核' },
      ],
    },
    {
      items: [
        { route: 'coming-soon', param: 'ai-image', icon: '🖼', label: 'AI圖片', soon: true },
        { route: 'coming-soon', param: 'ai-video', icon: '🎬', label: 'AI影片', soon: true },
        { route: 'coming-soon', param: 'schedule', icon: '📅', label: '排程發布', soon: true },
        { route: 'coming-soon', param: 'social', icon: '📣', label: '社群發布', soon: true },
        { route: 'analytics', icon: '📈', label: '成效分析', soon: true },
      ],
    },
    {
      items: [
        { route: 'coming-soon', param: 'automation', icon: '⚙️', label: 'Automation Center', soon: true },
        { route: 'settings', icon: '⚙', label: 'AI設定' },
      ],
    },
  ];

  function hrefFor(item) {
    return '#/' + item.route + (item.param ? '/' + item.param : '');
  }

  function render() {
    const el = document.getElementById('sidebar');
    if (!el) return;
    el.innerHTML = `
      <div class="aimc-sidebar-brand">🤖<span class="txt"> AI Marketing Center</span></div>
      ${NAV_GROUPS.map((g) => `
        <div class="aimc-sidebar-group">
          ${g.items.map((item) => `
            <a class="aimc-sidebar-item" data-route="${item.route}" data-param="${item.param || ''}" href="${hrefFor(item)}" title="${AIMC.esc(item.label)}">
              <span class="aimc-sidebar-icon">${item.icon}</span>
              <span class="aimc-sidebar-label">${AIMC.esc(item.label)}</span>
              ${item.soon ? '<span class="badge soon" style="margin-left:auto">Soon</span>' : ''}
            </a>`).join('')}
        </div>
        <div class="aimc-sidebar-divider"></div>
      `).join('')}
    `;
    // 移除最後一個多餘的分隔線
    const dividers = el.querySelectorAll('.aimc-sidebar-divider');
    if (dividers.length) dividers[dividers.length - 1].remove();
  }

  function setActive(route, param) {
    document.querySelectorAll('.aimc-sidebar-item').forEach((a) => {
      const match = a.dataset.route === route && (a.dataset.param || '') === (param || '');
      a.classList.toggle('active', match);
    });
  }

  window.Sidebar = { render, setActive, NAV_GROUPS };
})();
