// ============================================================
// settings.js — AI 設定（介面預留，本次不新增 Settings API / DB）
// ============================================================
(function () {
  async function load(root) {
    root.querySelector('#s_color').addEventListener('input', (e) => {
      root.querySelector('#s_colorSwatch').style.background = e.target.value;
    });
    root.querySelector('#s_saveBtn').addEventListener('click', () => {
      AIMC.toast('設定儲存功能將於未來版本開放（需新增 Settings API，本次重構不建立新 API / DB）', true);
    });
  }
  AIMC.pages.settings = { load };
})();
