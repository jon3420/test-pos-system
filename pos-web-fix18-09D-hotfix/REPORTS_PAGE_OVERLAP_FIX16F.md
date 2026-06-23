# 報表分析殘留重疊 — fix16f

## 根本原因
`showPage()` 只用 `classList.remove('active')`，但 `#page-reports` 在 main.css 有獨立的
`#page-reports { overflow-y:auto; display:flex; flex-direction:column }` 規則，
優先級高於 `.page { display:none }`，導致 classList 切換無效，報表頁持續顯示。

## 修正 1：main.css
```css
#page-reports:not(.active) { display: none !important; visibility: hidden !important; pointer-events: none !important; }
#page-reports.active { overflow-y: auto !important; visibility: visible !important; pointer-events: auto !important; }
```

## 修正 2：showPage() 改用 style 強制切換
```js
// 隱藏所有 page
document.querySelectorAll('.page').forEach(p => {
  p.classList.remove('active');
  p.style.display = 'none';
  p.style.visibility = 'hidden';
  p.style.pointerEvents = 'none';
});
// 特別確保 reports 隱藏
if (name !== 'reports') {
  document.getElementById('page-reports').style.display = 'none';
  // ...
}
// 顯示目標頁
target.classList.add('active');
target.style.display = '';         // 讓 .page.active CSS 生效
target.style.visibility = 'visible';
target.style.pointerEvents = 'auto';
```
