# 補貨系統第一版完成度報告（R54.4／MBV2-HF1-C3～C6.1）

> 依原始需求逐項核對，狀態分三欄：
> - **功能完成**：程式已實作、有操作入口。
> - **模擬驗收通過**：以正式 routes＋暫存檔案型 SQLite、真實 Chrome、測試替身驗證通過。
> - **待真機驗收**：尚未在正式站、真機、正式 LINE／LINE Pay 驗證。
>
> 本輪所有真實 LINE Messaging API、LINE Pay 與 Sandbox 呼叫皆為 0；任何項目都**不是**「已真機驗證」。
> 程式位置以 C6.1 套件為準（以函式名稱為準）。測試證據為 C6.1 候選 ZIP 全新解壓後重跑的結果，數字見最終報告第 6～8 節。
> 基準：最新 C5.4.2（PAYMENT_RESPONSE_TIMING_FIX）＋整合 C6 自動通知功能＋本輪三個缺口修正。

| # | 需求 | 程式位置 | 操作入口 | 測試證據（C6.1 全新解壓重跑） | 功能完成 | 模擬驗收通過 | 待真機驗收 |
|---|---|---|---|---|---|---|---|
| 1 | 前台需求登記、期望數量、取餐偏好 | `routes/product-demand.js` publicRouter `/register`、`/subscribe`、`/mine`；`utils/productDemand`；`public/line-order.html`（與 C5.4.2 逐位元組相同） | LINE 點餐頁商品「補貨登記」 | `…-c3-sale-status-demand.js`、`…-c4-5-date-consent.js`、`…-c4-2-demand-ui-refresh.js` | ✅ | ✅ | ⏳ |
| 2 | 同意、撤回、取消、有效期限及週期保護 | `utils/productDemand`；`utils/restockNotify.cycleConsent()／consentState()／evaluateRecipient()` | 「我的補貨登記」取消／撤回 | `…-c4-restock-notify.js`、`…-c4-5-date-consent.js`、C6 `A3`／`B3`、C6.1 `G2` | ✅ | ✅ | ⏳ |
| 3 | 後台統計、明細與自動更新 | `utils/productDemand.adminSummary()／adminDetail()`；`public/js/app.js` `pdAutoRefreshNow()` | 後台「LINE 商品管理 → 補貨登記」 | `…-c4-2-demand-ui-refresh.js`、`…-c4-3-async-consistency.js`、`…-c4-4-mutation-response.js` | ✅ | ✅ | ⏳ |
| 4 | 手動預覽與發送 | `utils/restockNotify.previewBatch()／confirmBatch()／runBatch()／resumeBatch()／cancelBatch()` | 補貨登記明細「🔔 補貨通知（店家手動發送）」 | `…-c4-restock-notify.js`、`…-c4-1-dedupe-resume.js`、`…-c4-linepush-compat.js`、C6 `A0` | ✅ | ✅ | ⏳ |
| 5 | 恢復販售自動通知 | `utils/restockAuto.js`（觸發、事件、處理、開機恢復）；`routes/products.js` `_c6Write()`；`routes/product-demand.js` `/restock/auto*` | 「恢復販售時自動發送補貨通知」＋商品「參與恢復販售自動通知」 | `…-c6-auto-restock.js`（24 項）、`…-c6-upgrade-rollback.js` | ✅（預設關閉） | ✅ | ⏳ |
| 5a | **C6.1** 自動批次逐筆送出前版本防護（缺口 A／B） | `utils/restockAuto.staleReasonRaw()／applyStaleRaw()／staleSweepRaw()`；`utils/restockNotify.runBatch()` 的 durable claim 交易內核對；`setEnabled()`（epoch）、`setProductParticipation()`（`restock_auto_version`） | 同上（開關、商品參與）；批次「續送未完成項目」＝人工接手 | `…-c6-1-auto-guard-recovery.js` `A1`～`B2`、`V1`、`R1`、`N1`、`M1`、`M2`、`G1`～`G4`、`S1` | ✅ | ✅ | ⏳ |
| 5b | **C6.1** 預覽保存後中斷的恢復（缺口 C） | `utils/restockAuto.processEvent()／continueAutoBatch()／expireEventPreviews()／bootRecover()` | 自動，無需操作；舊資料顯示「待店家確認」 | `…-c6-1-auto-guard-recovery.js` `C1`～`C6`（實際 SIGKILL）、`FX1`／`FX2`（fixture）、`H1` | ✅ | ✅ | ⏳ |
| 6 | 手動／自動共用防重送 | `restock_notify_deliveries` 唯一索引 `idx_rnd_cycle_claim`；`cycleEvidence()`；C6.1 釋放名額後由 `resumeBatch()` 重新取得 | — | C6 `A4`／`A5`／`B1`／`B2`；C6.1 `M1`／`M2`／`N1`；`…-c4-1-dedupe-resume.js` | ✅ | ✅ | ⏳ |
| 7 | 商品直達與正確供應日期、取餐方式 | `restockNotify.buildProductLink()`、`resolveProductRef()`、`dateOptions()`；`routes/line-orders.evaluateProductOrderability()`；`restockAuto.nearestDates()` | 通知訊息連結 | `…-c4-5-restock-link.js`、C6 `A3`／`A5`～`A7`、C6.1 `C6`（連結失配） | ✅ | ✅ | ⏳（LIFF 導向需真機） |
| 8 | 點擊、加購、訂單、付款及轉換追蹤 | `utils/restockTracking`；`/api/analytics/restock-notify/summary`（`source` 篩選） | 營運分析中心「補貨通知成效」 | `…-c5-restock-conversion.js`（`C4_CLOCK_OFFSET_MS=0`）、C6 `D1` | ✅ | ✅ | ⏳ |
| 9 | 一般與快閃付款安全及恢復 | C5.2～C5.4.2 全部保留（付款核心檔案與 C5.4.2 逐位元組相同） | LINE Pay 返回頁、我的訂單、後台「LINE Pay 付款待核對」 | C5.4.2 成立／台北時間 29、PAYMENT_GUARD_TIME_MERGE_FIX 22、PAYMENT_RESPONSE_TIMING_FIX 18、C5.4.1 19＋11、C5.4 27、C5.3 25、C5.2 33 | ✅ | ✅ | ⏳（真實與 Sandbox 付款 0） |
| 10 | 需求資料匯出 | `utils/demandExport.js`；`GET /api/product-demand-admin/export.csv` | 「⬇️ 統計 CSV／明細 CSV」 | C6 `D2` | ✅ | ✅ | ⏳ |
| 11 | 備份、搬家與歷史通知證據保留 | `utils/migrationV2.js`：自動設定為保護設定；**C6.1**：商品參與與參與版本不比較、不補入，新商品一律不參與；匯入批次版本清空 | 系統設定「資料搬家」 | `smoke-r54-4-mbv2-migration.js`、`…-c3-1-backup-manage-login.js`、C6 `C7`、C6.1 升級／回退 `P1`～`P3c` | ✅ | ✅ | ⏳ |
| 12 | 真機驗收與營運操作說明 | `docs/R54_4_MBV2_HF1_C6_1/03_OPERATIONS_GUIDE.md` | — | 文件 | ✅（文件） | — | ⏳（真機驗收尚未進行） |

**結論**：
- 第 1～11 項（含 5a、5b）功能完成，且模擬驗收通過。
- 全部項目都**待真機驗收**。
- 第 5 項自動發送交付時預設關閉，須由店家完成真機驗收後自行開啟。

## 附錄 A：尚未完成或刻意不做的部分

- 真機驗收（全部項目）尚未進行；本輪真實 LINE／LINE Pay／Sandbox 呼叫皆為 0。
- 第一版自動通知不含宅配與快閃場次；每日排程自動恢復與份數每日重設不觸發。本輪也未新增其他行銷功能。
- 系統不會自動退款、不保證訊息送達；「LINE 已受理」不代表顧客已收到或已讀。
- 回退到 C5.4.2 期間，若店家手動續送 C6.1 已釋放名額的舊自動項目，C5.4.2 不會重新取得週期名額。此時防重只靠已受理／曾嘗試證據（見營運說明第 F 節）。
