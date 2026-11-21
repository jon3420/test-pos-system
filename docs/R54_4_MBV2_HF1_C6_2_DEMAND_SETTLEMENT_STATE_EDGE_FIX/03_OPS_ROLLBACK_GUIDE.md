# R54.4／MBV2-HF1-C6.2 狀態邊界修正 — 營運與回退說明

> 本輪不部署。本文件供審核通過後部署與回退參考；上一輪（DURABLE_RECOVERY_FIX）的營運說明仍然適用，本文件只補充本輪的差異。

## 1. 變更範圍

| 項目 | 內容 |
|---|---|
| 產品程式 | 只修改 `utils/demandSettlement.js` |
| 資料庫 | **沒有新增或修改任何結構**，沒有遷移：空資料庫啟動的結構雜湊與 DURABLE_RECOVERY_FIX 相同 |
| 環境變數 | 無新增；沿用 `PD_SETTLE_SWEEP_MS`、`PD_SETTLE_SWEEP_LIMIT`、`PD_SETTLE_SWEEP_LOG` |
| 外部呼叫 | 無新增；補齊與歷史處理不呼叫 LINE、LINE Pay、Sandbox，也不發送通知 |
| Android POS、License API、Android License Sync、Feature Gate、Zeabur 部署架構 | 未修改 |

## 2. 行為差異（與 DURABLE_RECOVERY_FIX 比較）

| 情況 | DURABLE_RECOVERY_FIX | 本輪 |
|---|---|---|
| 延遲綁定的訂單已履約、作廢，有購買證據（現金或 LINE Pay 已付款） | 關聯 `released`、已完成 0 | 先依原週期補記扣減，再轉 `review`（保留份數） |
| 已履約作廢、LINE Pay 未付款或付款不明 | 訂購中 → `released` | `review`、扣 0（note `…:payment_unconfirmed`） |
| 原週期 `active` 但 `expires_at` 已過 | 照常扣減 | 扣 0（note `cycle_closed:expired_at`） |
| `expires_at` 無法解析 | 照常扣減 | `review`、扣 0（`cycle_validity_unknown`） |
| 作廢前 `order_status` 為 NULL、空字串或不合法值 | 視為未履約、回復 | `review`、不回復（`void_prior_state_missing`／`void_prior_state_invalid`） |
| 作廢待辦的 `result` | `review_void`／`cancel` | `review:<原因>`／`cancel`（可直接看出待核對原因） |

## 3. 啟動時的歷史處理（只依可信證據；可重複執行）

每次啟動補齊時執行 `repairLegacy`。

**A 型：已履約作廢、延遲綁定未扣減**
- 識別條件（全部成立）：
  - 關聯為 `released`，`applied_qty=0`，note 恰為 `void_after_completed`。
  - 訂單 `status='void'`。
  - 作廢待辦為 `done`，且保存的原狀態為 `completed`。
  - 同一訂單、同一商品、同一 `request_uuid` 的綁定待辦為 `done`。
- 有購買證據：補記扣減並轉 `review`，note 加上 `:legacy_repaired`。
  - 原週期如已過期或取消則扣 0，note 會寫出原因。
- 沒有購買證據：轉 `review`、扣 0，note 為 `void_after_completed:payment_unconfirmed:legacy_review`。

**C 型：原履約狀態缺失卻被回復**
- 識別條件：
  - 關聯為 `reverted`，note 以 `order_cancelled` 開頭。
  - 訂單已作廢。
  - 最新的作廢待辦保存的原狀態為 NULL、空字串或不合法值。
- 處理：**不改份數**，因為當時的回復同樣缺乏證據，無法判斷正確份數。只在關聯 note 與作廢待辦 result 標記 `legacy_review:<原因>`，交由人工核對。

**其他歷史資料**：不回溯處理。包含沒有作廢待辦的歷史作廢，以及上一輪之前就已經是 review 的資料。

## 4. 部署後檢查

```sql
-- 啟動後歷史處理結果
SELECT store_id, order_uuid, product_id, state, applied_qty, note FROM product_demand_order_links
 WHERE note LIKE '%legacy_repaired%' OR note LIKE '%legacy_review%';
-- 需人工核對的關聯（含本輪新增原因）
SELECT store_id, order_uuid, product_id, state, applied_qty, note FROM product_demand_order_links WHERE state='review';
-- 作廢待辦的實際結果
SELECT store_id, order_uuid, prior_order_status, result FROM product_demand_settle_tasks WHERE kind='void' AND (result LIKE 'review:%' OR result LIKE 'legacy_review%');
```

日誌：
- 啟動補齊的 `[demand_settlement] sweep:` 行，`changed` 計數已包含歷史處理的筆數。
- 日誌不另外分列 A／C 型筆數（本輪未修改 `server.js`）；明細請用上方 SQL 查詢。

## 5. MBV2

本輪沒有新增欄位或資料表，MBV2 政策與上一輪相同：
- 待辦與游標只屬於本機，不匯出。
- 合併匯入不清除本機待辦。
- 完整取代「商品想買登記」時清除本店待辦。
- 商品重新對應時，待辦的商品編號跟隨 `request_uuid`。

匯入資料（`import_source`）不參與補齊與歷史處理。匯入與升級都不發送通知，也不無證據回填份數。

## 6. 回退

- **方式**：換回 DURABLE_RECOVERY_FIX 程式即可，不需要還原資料庫（本輪沒有結構變更）。
- **回退後保留的部分**：本輪已修正的份數與 `review` 狀態全部保留，舊版不會改動 `review` 關聯（已驗證）。
- **回退期間會重新出現的缺口**（如實說明，已驗證）：
  1. 延遲綁定＋已履約作廢，結果又變成 `released`、已完成 0。
     - 再升級後由啟動歷史處理依證據補記（已驗證）。
  2. 自然到期但 status 仍 active 的週期，補齊仍會扣減。
     - 再升級後**不會清除**這些已扣減份數，依「已完成歷史不因期限清除」的規則保留。
     - 如需更正，應人工核對。
  3. 作廢前狀態為 NULL、空字串或不合法值時仍會回復。
     - 再升級後只標記 `legacy_review`，不改份數。
- **同一資料庫實測**：DURABLE_RECOVERY_FIX → 本輪 → 回退 → 再升級（`smoke-r54-4-mbv2-hf1-c6-2-state-edge-upgrade-rollback.js`），6／6。
  - 份數、待辦、游標、訂單、付款、通知批次、逐筆紀錄與 retry key 都已核對。
