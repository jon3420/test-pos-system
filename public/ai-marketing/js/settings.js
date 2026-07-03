// ============================================================
// settings.js — AI 設定（介面預留，本次不新增 Settings API / DB）
// Hotfix15：補齊 Page API（load/destroy/refresh/resume/pause），
// listener 透過 dom.on() 註冊，destroy() 會經由 currentDom 一次清除。
// ============================================================
(function () {
  let currentDom = null;

  async function load(root) {
    const lc = AIMC.startLifecycle('Settings');
    currentDom = lc.dom;
    lc.dom.on(root, '#s_color', 'input', (e) => {
      const swatch = lc.dom.query(root, '#s_colorSwatch');
      if (swatch) swatch.style.background = e.target.value;
    });
    lc.dom.on(root, '#s_saveBtn', 'click', () => {
      AIMC.toast('設定儲存功能將於未來版本開放（需新增 Settings API，本次重構不建立新 API / DB）', true);
    });
    lc.done('event bindings ready，無 API 呼叫');
  }

  function destroy() {
    if (currentDom) currentDom.removeAllListeners();
    currentDom = null;
  }
  function refresh(root) { return load(root); }
  function resume(root) { return load(root); }
  function pause() { console.info('[AIMC] Settings paused（目前無長駐 timer，純狀態標記）'); }

  AIMC.pages.settings = { load, destroy, refresh, resume, pause };
})();
