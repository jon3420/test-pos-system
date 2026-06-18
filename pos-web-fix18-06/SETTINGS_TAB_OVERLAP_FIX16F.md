# Settings Tab 重疊修正 — fix16f

## switchSettingsTab() 修正
```js
// 隱藏所有 panels（強制 style）
document.querySelectorAll('.settings-tab-panel').forEach(p => {
  p.style.display = 'none';
  p.style.visibility = 'hidden';
  p.style.pointerEvents = 'none';
});
// 顯示目標 panel
panel.style.display = 'block';
panel.style.visibility = 'visible';
panel.style.pointerEvents = 'auto';
```
任何時候只有一個 settings panel 顯示。
