// ============================================================
// comingsoon.js — 即將推出頁（AI圖片 / AI影片 / 排程發布 / 社群發布 /
// Knowledge Marketplace）與 Automation Center（AIMC × n8n 說明）
// 純靜態內容，不呼叫任何 API，也不實作真正的自動化。
// ============================================================
(function () {
  const ITEMS = {
    'ai-image': { icon: '🖼', title: 'AI 圖片', desc: '依商品知識與主題自動產生行銷用圖片／去背／模板合成，搭配文案一併產出。', phase: '預計 Phase 2' },
    'ai-video': { icon: '🎬', title: 'AI 影片', desc: '將圖文內容自動轉為短影音腳本與影片素材，支援 Reels / Shorts 格式。', phase: '預計 Phase 2' },
    schedule: { icon: '📅', title: '排程發布', desc: '審核通過的內容可設定發布時間，到時間自動發佈到指定平台。', phase: '預計 Phase 2' },
    social: { icon: '📣', title: '社群發布', desc: '直接串接 FB / IG / Threads / LINE OA 等平台 API，一鍵發佈多平台。', phase: '預計 Phase 2' },
    marketplace: { icon: '🛒', title: 'Knowledge Marketplace', desc: '跨店家共享／選購產業知識與內容模板，加速新店家建置知識庫。', phase: '預計 Phase 3' },
  };

  const AUTOMATION_ITEMS = [
    { icon: '🌙', title: '每天 22:30 自動產生營運報告', sub: '彙整當日銷售 / 內容成效，自動整理成報告' },
    { icon: '🌅', title: '每天早上自動推薦今日主推商品', sub: '依庫存、熱度等條件挑選主打商品' },
    { icon: '⭐', title: 'Google 評論新增後自動生成感謝貼文', sub: '收到新評論即觸發 AI 生成感謝文案草稿' },
    { icon: '🔥', title: '熱門商品暴增後自動生成促銷文案', sub: '銷量異常上升時自動產出趁勢行銷內容' },
    { icon: '📉', title: '庫存不足時提醒不要推該商品', sub: '避免行銷缺貨商品造成顧客體驗不佳' },
    { icon: '📅', title: '審核通過後自動排程發布', sub: '核准內容直接排入發布時程，免人工上稿' },
    { icon: '📥', title: '發布後自動回收成效', sub: '自動抓取觸及、互動等成效數據回填系統' },
    { icon: '📈', title: '成效好時建議加碼廣告，差時建議換素材', sub: '依成效數據自動給出優化建議' },
  ];

  async function load(root, param) {
    const auto = root.querySelector('#csAutomationSection');
    const grid = root.querySelector('#csGrid');
    const note = root.querySelector('#csNote');

    if (param === 'automation') {
      auto.style.display = 'block';
      grid.style.display = 'none';
      note.textContent = 'Automation Center：以下情境目前皆為人工在 AI 行銷中心手動操作，未來串接 n8n 後可自動觸發。';
      root.querySelector('#csAutomationList').innerHTML = AUTOMATION_ITEMS.map((a, i) => `
        <div class="automation-item">
          <span class="a-num">${i + 1}</span>
          <span class="a-txt">${a.icon} ${AIMC.esc(a.title)}<br><span class="a-sub">${AIMC.esc(a.sub)}</span></span>
        </div>`).join('');
      return;
    }

    auto.style.display = 'none';
    grid.style.display = 'grid';
    note.textContent = '以下功能為未來規劃，目前尚未開放，僅供預覽用途。';
    const keys = Object.keys(ITEMS);
    grid.innerHTML = keys.map((k) => `
      <div class="cs-card" id="cs-${k}" style="${k === param ? 'outline:2px solid var(--accent)' : ''}">
        <div class="cs-icon">${ITEMS[k].icon}</div>
        <div class="cs-title">${AIMC.esc(ITEMS[k].title)}</div>
        <div class="cs-desc">${AIMC.esc(ITEMS[k].desc)}</div>
        <div class="cs-meta"><span class="cs-phase">${AIMC.esc(ITEMS[k].phase)}</span><span class="badge soon">Coming Soon</span></div>
      </div>`).join('');
    if (param && document.getElementById('cs-' + param)) {
      document.getElementById('cs-' + param).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  AIMC.pages['coming-soon'] = { load };
})();
