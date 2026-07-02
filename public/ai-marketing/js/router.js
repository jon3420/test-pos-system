// ============================================================
// router.js — Workspace Router
//
// 設計原則：
//   - 每個頁面是獨立的 .html「片段」檔案（沒有 <html>/<head>/<body>），
//     切換頁面時才用 fetch() 讀取該檔案並注入 #workspace，
//     不會像舊版一次把 5 個分頁的 DOM 全部渲染出來再用 display:none 切換。
//   - 對應的 js/xxx.js 在 index.html 已經先載入，註冊到 AIMC.pages.xxx，
//     router 只負責「載入 HTML 片段 + 呼叫該頁面的 load(root, param)」。
//   - 路由格式：#/<route>            例如 #/dashboard
//              #/<route>/<param>    例如 #/coming-soon/ai-image
// ============================================================
(function () {
  const ROUTES = ['dashboard', 'knowledge', 'topics', 'prompts', 'generate', 'review', 'analytics', 'settings', 'coming-soon'];
  const TITLES = {
    dashboard: 'Dashboard', knowledge: '商品知識', topics: '主題', prompts: 'Prompt',
    generate: 'AI 生成', review: '審核', analytics: '成效分析', settings: 'AI 設定', 'coming-soon': '即將推出',
  };
  const fragmentCache = {};

  function parseHash() {
    let hash = location.hash.replace(/^#\/?/, '');
    if (!hash) return { route: 'dashboard', param: '' };
    const [route, ...rest] = hash.split('/');
    return { route: ROUTES.includes(route) ? route : 'dashboard', param: rest.join('/') };
  }

  async function fetchFragment(route) {
    if (fragmentCache[route]) return fragmentCache[route];
    const res = await fetch(route + '.html');
    if (!res.ok) throw new Error('無法載入頁面：' + route);
    const html = await res.text();
    fragmentCache[route] = html;
    return html;
  }

  function setTopbarTitle(route, param) {
    const el = document.getElementById('topbarTitle');
    if (!el) return;
    let title = TITLES[route] || route;
    if (route === 'coming-soon' && param) {
      const map = { 'ai-image': 'AI 圖片', 'ai-video': 'AI 影片', schedule: '排程發布', social: '社群發布', automation: 'Automation Center' };
      title = map[param] || title;
    }
    el.innerHTML = `AI Marketing Center <span class="crumb-sep">/</span> ${AIMC.esc(title)}`;
  }

  async function renderRoute() {
    const { route, param } = parseHash();
    const workspace = document.getElementById('workspace');
    workspace.innerHTML = AIMC.loadingHtml('載入頁面中...');
    try {
      const html = await fetchFragment(route);
      workspace.innerHTML = html;
      Sidebar.setActive(route, param);
      setTopbarTitle(route, param);
      const page = AIMC.pages[route];
      if (page && typeof page.load === 'function') {
        await page.load(workspace, param);
      }
    } catch (e) {
      workspace.innerHTML = `<div class="empty">頁面載入失敗：${AIMC.esc(e.message)}</div>`;
    }
  }

  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('DOMContentLoaded', () => {
    Sidebar.render();
    if (!AIMC.storeId) {
      document.getElementById('workspace').innerHTML =
        '<div class="card"><p style="color:var(--danger)">網址缺少 store_id，請由 POS 後台「AI 行銷中心」按鈕進入。</p></div>';
      return;
    }
    renderRoute();
  });

  window.AIMCRouter = { renderRoute, parseHash };
})();
