# R54.4／MBV2-HF1-C6.2 補修：登記份數持久化補齊與作廢回復 — 營運與回退說明

> 本輪不部署。本文件供審核通過後的部署與回退參考。

## 1. 變更範圍

| 項目 | 內容 |
|---|---|
| 資料庫 | 只新增，不修改既有欄位，不刪資料。新增 `product_demand_settle_tasks`（綁定與作廢待辦）、`product_demand_sweep_cursors`（補齊游標），以及 3 個索引。啟動時以 `CREATE … IF NOT EXISTS` 建立，可重複執行。 |
| 歷史資料 | 不回溯掃描，不為升級前的訂單建立待辦。 |
| 外部呼叫 | 無新增。補齊只處理本機資料，不呼叫 LINE、LINE Pay 或 Sandbox，也不發送通知。 |
| Android POS、License API、Android License Sync、Feature Gate、Zeabur 部署架構 | 未修改。 |

## 2. 新增的環境變數（皆為選用）

| 變數 | 預設 | 用途 |
|---|---|---|
| `PD_SETTLE_SWEEP_MS` | 60000 | 定期補齊間隔（毫秒，最短 1000）。正式環境維持預設即可。 |
| `PD_SETTLE_SWEEP_LIMIT` | 200 | 每類工作每輪的處理上限（最小 10），依店數平分，每店至少 5 筆。 |
| `PD_SETTLE_SWEEP_LOG` | 未設定 | 設為 `1` 時，每輪都輸出各類、各店的游標起訖與筆數（除錯用）。 |

`.env.example` 未變更，不設定這些變數即為原行為加上補修。

## 3. 執行行為

- **下單**
  - 在同一筆訂單交易內，依「已驗證會員＋商品」找出有效的登記週期，寫入綁定待辦。待辦保存 request_uuid、cycle、份數、付款方式與訂單 UUID。
  - 待辦寫入失敗時，整筆訂單交易回滾（HTTP 500，不建立訂單，也不送出任何外部動作）。
  - 待辦寫入後，在交易內嘗試立即綁定，每個商品各自一個 SAVEPOINT。綁定失敗只回滾該商品，待辦保留。
- **補齊**
  - 交易後立即補一次（bindLate）。
  - 之後每 60 秒定期補齊；啟動後 2.5 秒另有一次啟動補齊。
  - 定期補齊依退避時間處理（15 秒起倍增，最長 30 分鐘）。
  - 啟動補齊不等待退避：重啟本身就是一次恢復機會。
- **作廢**
  - 作廢交易內（狀態更新前）重新讀取 `orders.order_status` 與 `orders.status`，寫入作廢待辦。
  - 交易後的同步與日後的補齊，只依這筆待辦判斷：
    - 作廢前未履約 → 回復一次。
    - 作廢前已履約（`order_status='completed'`）→ 待核對。
    - 沒有待辦（歷史作廢）→ 待核對。
- **公平輪替**
  - 補齊分成四類工作：待辦、訂購中、已解除但可能已付款、已扣減但訂單已取消或作廢。
  - 各類依店別各有一個游標，存在資料庫。重啟後從上次位置繼續，取完一圈再從頭開始。
  - 單筆失敗只計數，其他筆照常處理，游標照常前進。

## 4. 部署前後檢查

1. 部署前備份資料庫檔（沿用既有 SOP：`R54_4_MBV2_PERSISTENCE_DEPLOY_ROLLBACK_SOP.md`）。
2. 啟動後確認新表已建立：
   ```sql
   SELECT name FROM sqlite_master WHERE name IN ('product_demand_settle_tasks','product_demand_sweep_cursors');  -- 2 筆
   SELECT COUNT(*) FROM product_demand_settle_tasks;  -- 升級當下應為 0（不回溯建立）
   ```
3. 觀察：
   ```sql
   -- 長時間未完成的待辦
   SELECT store_id, kind, order_number, product_id, attempts, last_error, next_at FROM product_demand_settle_tasks
    WHERE state='pending' AND created_at < datetime('now','-1 hour');
   -- 需人工核對的待辦
   SELECT * FROM product_demand_settle_tasks WHERE state='review';
   ```
   後台「登記 → 訂單」明細（`/api/product-demand-admin/requests/:id/orders`）也會顯示 `tasks`，包含狀態、嘗試次數與最近錯誤。
4. 日誌關鍵字：`[demand_settlement] sweep: round=… orders=… changed=… failed=…`。只有在有變更或失敗時才輸出。

## 5. MBV2 匯出／匯入政策

| 情境 | 行為 |
|---|---|
| 匯出 | 待辦與游標**不匯出**（只屬於本機，是執行中的工作狀態，不是營業資料）。 |
| 合併匯入 | 不清除本機待辦。匯入的關聯帶有 `import_source`，補齊不處理匯入資料。 |
| 完整取代且選取「商品想買登記」 | 清除本店待辦（與登記、關聯一起清除，避免待辦指向已不存在的週期）。 |
| 商品編號重新對應 | 本機綁定待辦的 `product_id` 依所屬 `request_uuid` 重新對應，與 C6.2 關聯規則相同。 |
| 跨店 | 所有查詢都以 `store_id` 限定。待辦只使用自身保存的店別、會員與 request_uuid，不會綁到其他店或其他週期。 |

## 6. 回退

### 6.1 回退方式

換回原 C6.2 程式即可，不需要還原資料庫。
- 原 C6.2 不讀取新表，新表留在資料庫中無害。
- 已驗證：同一資料庫檔 C6.2 → 補修 → C6.2 → 補修，訂單、登記、已完成與訂購中份數、付款紀錄、通知批次與逐筆紀錄、retry key 全部保留，結構雜湊一致。

### 6.2 回退期間的限制（如實說明）

1. **未完成的待辦停止處理。** 這段期間該訂單的登記份數不會扣減。再升級回補修版後，啟動補齊會依原待辦補齊（已驗證：滷蛋 0 → 2/4）。
2. **回退期間建立的訂單與作廢沒有待辦。** 這是原 C6.2 的行為：
   - 綁定失敗的訂單不會被再升級補回。
   - 作廢依原 C6.2 的記憶體狀態判斷。
   - 再升級後不回溯處理，因為沒有可信的原始證據。
3. **回退期間已處理完的訂單不受影響。** 再升級後也不會重複扣減（已驗證）。
4. **歷史 C6.2 訂單不會被補綁。** 指本版之前已發生的「綁定與補綁都失敗」的訂單：它們沒有保存證據，本版不回溯建立。如需處理，應由人工核對。

### 6.3 完全移除新表（非必要）

只在確定不再升級時執行，執行前先備份：
```sql
DROP TABLE IF EXISTS product_demand_settle_tasks;
DROP TABLE IF EXISTS product_demand_sweep_cursors;
```
