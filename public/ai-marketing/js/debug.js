// ============================================================
// debug.js — Developer Debug Overlay（Part 12）
// 只有在網址帶 ?debug=1 時才會顯示，一般店家使用者完全看不到、
// 也完全不影響一般使用時的效能（沒帶 debug=1 時，這支檔案什麼事都不做）。
// 顯示：目前頁面 / 目前狀態 / Page Token / Pending Requests /
//       Listener 數 / Render 次數 / Abort 次數，方便開發時排查
//       Race Condition、Memory Leak。
// 純讀取 AIMC.Debug.getStats()（shared.js 提供），不影響任何業務邏輯。
// ============================================================
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') !== '1') return; // 非開發模式，完全不啟動，零成本

  function ensurePanel() {
    let panel = document.getElementById('aimc-debug-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'aimc-debug-panel';
    panel.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:99999',
      'background:rgba(15,15,15,.92)', 'color:#f0f0f0', 'font:11px/1.5 monospace',
      'border:1px solid #f5a623', 'border-radius:8px', 'padding:10px 12px',
      'min-width:200px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(panel);
    return panel;
  }

  function render() {
    if (!window.AIMC || !AIMC.Debug) return;
    const panel = ensurePanel();
    const s = AIMC.Debug.getStats();
    panel.innerHTML = `
      <div style="color:#ffc15e;font-weight:700;margin-bottom:4px">🐞 AIMC Debug</div>
      <div>Page: <b>${s.currentPage || '-'}</b></div>
      <div>State: <b>${s.currentState}</b></div>
      <div>Token: <b>${s.currentToken}</b></div>
      <div>Pending Req: <b>${s.pendingRequests}</b></div>
      <div>Listeners: <b>${s.listeners}</b></div>
      <div>Renders: <b>${s.renderCount}</b></div>
      <div>Aborts: <b>${s.abortCount}</b></div>
    `;
  }

  // 用單一 setInterval 每 500ms 更新一次，並且這個 timer 本身也計入統計，
  // 方便驗證「這是唯一的長駐 timer，不會無限增生」。
  if (window.AIMC) {
    AIMC._stats.timers += 1;
    setInterval(render, 500);
    render();
  } else {
    // shared.js 尚未載入完成時（理論上不會發生，因為 index.html 已固定載入順序），保底重試一次
    window.addEventListener('DOMContentLoaded', () => {
      if (window.AIMC) { AIMC._stats.timers += 1; setInterval(render, 500); render(); }
    });
  }
})();
