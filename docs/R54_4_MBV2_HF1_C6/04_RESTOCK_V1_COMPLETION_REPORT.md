# 補貨系統第一版完成度報告（R54.4／MBV2-HF1-C3～C6）

> 依原始需求逐項核對。狀態分三欄：**功能完成**（程式已實作、有操作入口）／**模擬驗收通過**（以正式 routes＋暫存資料庫、真實瀏覽器、測試替身驗證通過）／**待真機驗收**（尚未在正式站、真機、正式 LINE／LINE Pay 驗證）。
> 本輪所有真實 LINE Messaging API 與 LINE Pay 呼叫皆為 0；任何項目都**不是**「已真機驗證」。
> 程式位置以 C6 套件為準（以函式名稱為準）。測試證據皆為 C6 候選 ZIP 全新解壓後重跑的結果（C6 報告第 8～9 節）；C5.4 付款相關證據另見 `docs/R54_4_MBV2_HF1_C5_4/`。

| # | 需求 | 程式位置 | 操作入口 | 測試證據（C6 全新解壓重跑） | 功能完成 | 模擬驗收通過 | 待真機驗收 |
|---|---|---|---|---|---|---|---|
| 1 | 前台需求登記、期望數量、取餐偏好 | `routes/product-demand.js` publicRouter `/register`、`/subscribe`、`/mine`；`utils/productDemand.register()／subscribe()`；`public/line-order.html` 補貨登記面板 | LINE 點餐頁商品「補貨登記」 | `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js`、`…-c4-5-date-consent.js`、`…-c4-2-demand-ui-refresh.js` | ✅ | ✅ | ⏳ |
| 2 | 同意、撤回、取消、有效期限及週期保護 | `utils/productDemand.cancel()／revokeConsent()`、`consentStatusFor()`；`utils/restockNotify.cycleConsent()／consentState()／evaluateRecipient()`（同意綁定 `request_uuid` 週期） | 「我的補貨登記」取消／撤回 | `…-c4-restock-notify.js`、`…-c4-5-date-consent.js`、C6 `A3`、`B3` | ✅ | ✅ | ⏳ |
| 3 | 後台統計、明細與自動更新 | `utils/productDemand.adminSummary()／adminDetail()`；`/api/product-demand-admin/snapshot`；`public/js/app.js` `pdAutoRefreshNow()` | 後台「LINE 商品管理 → 補貨登記」 | `…-c4-2-demand-ui-refresh.js`、`…-c4-3-async-consistency.js`、`…-c4-4-mutation-response.js` | ✅ | ✅ | ⏳ |
| 4 | 手動預覽與發送 | `utils/restockNotify.previewBatch()／confirmBatch()／runBatch()／resumeBatch()／cancelBatch()` | 補貨登記明細「🔔 補貨通知（店家手動發送）」 | `…-c4-restock-notify.js`、`…-c4-1-dedupe-resume.js`、`…-c4-linepush-compat.js`、C6 `A0` | ✅ | ✅ | ⏳ |
| 5 | 恢復販售自動通知 | `utils/restockAuto.js`（觸發判定、事件、處理、啟動恢復）；`routes/products.js` `_c6Write()`；`routes/product-demand.js` `/restock/auto*` | 補貨登記分頁「恢復販售時自動發送補貨通知」＋商品明細「參與恢復販售自動通知」 | `smoke-r54-4-mbv2-hf1-c6-auto-restock.js`（A0～A7、B1～B3、C1～C8、D1～D3）、`…-c6-upgrade-rollback.js` | ✅（預設關閉） | ✅ | ⏳ |
| 6 | 手動／自動共用防重送 | `restock_notify_deliveries` 唯一索引 `idx_rnd_cycle_claim`；`cycleEvidence()`；自動事件呼叫同一個 `previewBatch／confirmBatch` | — | C6 `A4`、`A5`、`B1`、`B2`；`…-c4-1-dedupe-resume.js` | ✅ | ✅ | ⏳ |
| 7 | 商品直達與正確供應日期、取餐方式 | `restockNotify.buildProductLink()`（LIFF＋`product_ref`＋`rt`）、`resolveProductRef()`、`dateOptions()`；`routes/line-orders.evaluateProductOrderability()`；`restockAuto.nearestDates()`；`public/line-order.html` `_restockLiffPrimary` | 通知訊息連結 | `…-c4-5-restock-link.js`、C6 `A3`、`A5`～`A7` | ✅ | ✅ | ⏳（LIFF 一次／二次導向需真機） |
| 8 | 點擊、加購、訂單、付款及轉換追蹤 | `utils/restockTracking.recordOpen()／recordCartAdd()／attributeOrder()／summary()`；`/api/analytics/restock-notify/summary`（C6 加 `source`） | 營運分析中心「補貨通知成效」 | `…-c5-restock-conversion.js`（`C4_CLOCK_OFFSET_MS=0`）、C6 `D1` | ✅ | ✅ | ⏳ |
| 9 | 一般與快閃付款安全及恢復 | 一般：`utils/linePayRecovery.js`、`routes/linepay.js`（C5.2／C5.3）；快閃：`utils/popupPaymentRecovery.js`、`routes/popup-public.js`（C5.4）；顯示：`utils/paymentDisplay.js` | LINE Pay 返回頁、我的訂單、後台「LINE Pay 付款待核對」 | `…-c5-3-payment-guard.js`、`…-c5-2-payment-recovery.js`、`…-c5-4-payment-ui-popup.js`、`…-c5-4-upgrade-rollback.js` | ✅ | ✅ | ⏳（本輪真實與 Sandbox 付款 0） |
| 10 | 需求資料匯出 | `utils/demandExport.js`；`GET /api/product-demand-admin/export.csv` | 補貨登記分頁「⬇️ 統計 CSV／明細 CSV」 | C6 `D2` | ✅（C6 新增；C5.3 以前只有 MBV2 搬家備份） | ✅ | ⏳ |
| 11 | 備份、搬家與歷史通知證據保留 | `utils/migrationV2.js` 分類 `product_demand`、`restock_notify`（批次、逐筆、點擊、加購、歸因）；匯入時未完成者改為暫停／結果待確認；C6 自動設定列為保護設定 | 系統設定「資料搬家」 | `smoke-r54-4-mbv2-migration.js`、`…-c3-1-backup-manage-login.js`、`…-c4-1-dedupe-resume.js`、C6 `C7` | ✅ | ✅ | ⏳ |
| 12 | 真機驗收與營運操作說明 | `docs/R54_4_MBV2_HF1_C6/03_OPERATIONS_GUIDE.md`（本報告附錄 B） | — | 文件 | ✅（文件） | — | ⏳（真機驗收尚未進行） |

**結論**：第 1～11 項功能完成且模擬驗收通過；全部 12 項都**待真機驗收**。第 5 項自動發送交付時預設關閉，須由店家完成驗收後自行開啟。

## 附錄 A：各項測試數字（C6 候選 ZIP 全新解壓）

| 腳本 | 結果 |
|---|---|
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | 328／332（既有時段案例 4 項，與 C5.3、C5.4 相同） |
| `smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |
| `smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | 40／40 |
| `smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | 80／80 |
| `smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |
| `smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js`／`…-c4-5-date-consent.js` | 42／42、55／55 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（`C4_CLOCK_OFFSET_MS=0`） | 42／42 |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js`／`smoke-r54-4-mbv2-migration.js` | 54／54、121／121 |
| `smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`／`…-c5-2-payment-recovery.js`／`…-c5-4-payment-ui-popup.js` | 25／25、33／33、27／27 |
| `smoke-r54-4-mbv2-hf1-c6-auto-restock.js`／`…-c6-upgrade-rollback.js` | 24／24、4／4 |

## 附錄 B：營運操作說明

見同目錄 `03_OPERATIONS_GUIDE.md`（上線前準備、手動發送、自動通知開啟／停用／處理未送工作、需求匯出、付款狀態、真機驗收最短步驟）。

## 附錄 C：尚未完成或刻意不做的部分

- 真機驗收（全部 12 項）：尚未進行；本輪真實 LINE／LINE Pay 呼叫皆為 0。
- 第一版自動通知不含宅配與快閃場次；每日排程自動恢復與份數每日重設不觸發。
- 系統不會自動退款、不保證訊息送達；「LINE 已受理」不代表顧客已收到或已讀。
