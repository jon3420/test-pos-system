// ============================================================
// analytics.js — 成效分析（Coming Soon，純靜態預覽頁）
// 不呼叫任何 API，僅供 UI 預覽，未來 Phase 3 才會串接真實成效數據。
// Hotfix15：補齊 Page API（load/destroy/refresh/resume/pause），
// 這頁沒有任何 DOM 寫入、沒有 listener，destroy/pause/resume 皆為誠實的無操作。
// ============================================================
(function () {
  async function load() {
    const lc = AIMC.startLifecycle('Analytics');
    lc.done('純靜態頁面，無需額外資料載入');
  }
  function destroy() { /* 無註冊任何 listener，無需清理 */ }
  function refresh() { return load(); }
  function resume() { return load(); }
  function pause() { console.info('[AIMC] Analytics paused（純靜態頁，無長駐資源）'); }

  AIMC.pages.analytics = { load, destroy, refresh, resume, pause };
})();
