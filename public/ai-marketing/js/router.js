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
    const previousHtml = workspace.innerHTML; // Part 10：保留目前畫面，供錯誤時還原用

    // Part 5：Router Cleanup —— 先徹底清理上一頁（移除 listener、呼叫 destroy()），
    // 再 bump Page Token（Part 2）＋ abort 上一頁尚未完成的請求（Part 3）。
    AIMC.destroyCurrentPage();
    AIMC.bumpPageToken();
    AIMC.setPageState('created', route);

    workspace.innerHTML = AIMC.loadingHtml('載入頁面中...');
    try {
      const html = await fetchFragment(route);
      workspace.innerHTML = html;
      Sidebar.setActive(route, param);
      setTopbarTitle(route, param);
      const page = AIMC.pages[route];
      if (page && typeof page.load === 'function') {
        AIMC.setPageState('loading', route);
        await page.load(workspace, param);
        AIMC.setPageState('active', route);
      }
      // Part 6/7：若頁面有提供 destroy()，記下來，下次切頁時（或本次流程開頭）會自動呼叫，
      // 統一負責移除透過 AIMC.DOM 註冊的所有 listener，避免記憶體洩漏。
      if (page && typeof page.destroy === 'function') {
        AIMC.setCurrentPageDestroy(page.destroy);
      } else {
        AIMC.setCurrentPageDestroy(null);
      }
    } catch (e) {
      // Part 10：Workspace Error —— 頁面載入失敗時，不要用滿版錯誤蓋掉整個 Workspace，
      // 只顯示 toast + console.error，並還原成切頁前的畫面，讓使用者不會看到嚇人的空白/錯誤頁。
      // AbortError（使用者自己又切了下一頁）視為正常行為，不顯示任何錯誤。
      if (!AIMC.isAbortError(e)) {
        console.error('[AIMC router] 頁面載入失敗：', e);
        AIMC.toast('頁面載入失敗：' + e.message, true);
      }
      workspace.innerHTML = previousHtml;
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
