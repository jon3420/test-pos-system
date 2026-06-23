# Page Active State — fix16f

任何時候 `document.querySelectorAll('.page.active').length` 必須等於 1。

## 保證機制
1. `showPage()` 先隱藏所有 `.page`（style.display='none'）
2. 再顯示目標頁（style.display=''，讓 `.page.active` CSS 的 `display:flex` 生效）
3. `#page-reports:not(.active) { display:none !important }` CSS 規則作為最後防線

## 測試方法
```js
document.querySelectorAll('.page.active').length  // 必須 === 1
document.getElementById('page-reports').classList.contains('active')  // 切到點餐時 false
getComputedStyle(document.getElementById('page-reports')).display  // 切到點餐時 'none'
```
