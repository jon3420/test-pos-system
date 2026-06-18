# 點擊失效修正 — fix16f

## 原因
報表頁殘留在其他頁面上方（`visibility:visible; pointer-events:auto`），
攔截了所有點擊事件，導致商品卡、按鈕等無法響應。

## 修正
`showPage()` 切換時同步設定 `pointer-events: none` 在所有非 active page，
確保不攔截下方頁面的點擊事件。

`hideLoginOverlay()` 新增 `pointer-events: none; z-index: -1`，
確保登入 overlay 完全不攔截點擊。
