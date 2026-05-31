# Frontend Feature Gate Audit
隱藏邏輯由 `applyFeatureGateUI()` 在 `loadCurrentStore()` 後執行。

| UI 元素 | Feature | 隱藏方式 |
|---------|---------|---------|
| 導覽列「庫存」 | inventory | display:none |
| 設定 Tab「LINE 營業」 | line_order | display:none |
| 設定 Tab「外送平台」 | delivery | display:none |
| 設定 Tab「金流設定」 | payment_api | display:none |
| 訂單頁「外送報表」Tab | delivery | display:none |
| 點餐頁外送模式按鈕 | delivery | display:none |
| 商品列表「LINE設定」按鈕 | line_order | 模板條件渲染 |
| 設定 Tab「店家授權」 | 已徹底移除 | 從 HTML 移除 |
| LINE 點餐入口（line_order=false）| line_order | 顯示「未啟用」訊息 |
