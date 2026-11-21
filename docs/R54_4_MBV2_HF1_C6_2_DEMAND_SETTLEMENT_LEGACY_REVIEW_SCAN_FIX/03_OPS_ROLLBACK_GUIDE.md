# R54.4／MBV2-HF1-C6.2 歷史待核對紀錄掃描漏標修正 — 營運與回退說明

> 本輪不部署。STATE_EDGE_FIX 與先前各輪的營運說明仍然適用，本文件只補充本輪差異。

## 1. 變更範圍

| 項目 | 內容 |
|---|---|
| 產品程式 | 只修改 `utils/demandSettlement.js`（歷史處理 `repairLegacy` 的掃描方式；補齊每輪如何呼叫它） |
| 資料庫 | **沒有結構變更**：空資料庫啟動 246 個物件，結構雜湊與 STATE_EDGE_FIX 相同 |
| 新增環境變數（選用） | `PD_LEGACY_RETRY_MS`：歷史處理一輪有單筆失敗時，多久後再掃一次。預設 300000（5 分鐘），最短 1000 |
| 外部呼叫 | 無；歷史處理只寫本機的關聯 note、作廢待辦 result 與 updated_at |
| 前端、付款核心、通知引擎、Android、License、Zeabur 部署架構 | 未修改（逐檔雜湊相同，見報告第 9 節） |

## 2. 行為

### 2.1 掃描與篩選

- **SQL 篩選**：在取上限之前，先排除作廢前狀態屬於合法值的紀錄。
  - 合法值：`completed`、`pending`、`accepted`、`preparing`、`ready`、`delivering`、`cancelled`。
  - 比對前會去除前後 ASCII 空白，與 `classifyVoidPrior` 的 JS `trim` 結果一致，或比它保守。
- **游標**：以關聯 id 遞增的游標分批取資料，每批 500 筆。
  - JS 分類為合法而略過的少數紀錄（例如前後是全形空白的合法值）也會推進游標，不會卡住後段。
- **工作量上限**：每輪補齊最多處理 4 批（2,000 筆候選）；沒掃完的部分，下一輪（預設 60 秒）接著處理。

### 2.2 完成與重試

- **完成**：整輪掃完、沒有失敗，就停止歷史處理。之後的補齊輪次不再執行這些查詢，直到下一次啟動。
- **單筆失敗**：
  - 每筆各自用 SAVEPOINT 隔離，同批其他紀錄照常提交。
  - 掃完一輪後若有失敗，`PD_LEGACY_RETRY_MS` 後只重掃尚未標記的候選。
  - 重試沒有次數上限，但每次只查尚未標記的候選，不會全表掃描。

### 2.3 中斷後續行

- 游標只存在記憶體中。已完成的標記已經寫進資料庫，SQL 會排除它們，所以重啟後從頭掃「尚未標記」的候選就等於續行。
- 中斷時，只有最後一批尚未提交的部分需要重做；已提交的批次不會重做。
- 不需要新增游標資料表或欄位。

### 2.4 C 型處理內容

只做標記：
- 關聯 note 加上 `:legacy_review:<原因>`。
- 最新作廢待辦的 result 改為 `legacy_review:<原因>`。

不改份數、關聯 state、`applied_qty`、登記週期、訂單、付款或通知。已標記的紀錄、匯入資料（`import_source`）、未作廢的訂單都不處理。

### 2.5 A 型

證據門檻、有效期檢查與防重規則都與 STATE_EDGE_FIX 相同；只改成同一游標方式分批。

## 3. 部署後檢查

```sql
-- 已標記的 C 型（應人工核對）
SELECT store_id, order_uuid, product_id, applied_qty, note FROM product_demand_order_links WHERE note LIKE '%legacy_review:void_prior_state%';
-- 尚未標記的候選（掃描完成後應為 0；有單筆失敗時會在重試後歸零）
SELECT COUNT(*) FROM product_demand_order_links l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
 WHERE l.state='reverted' AND COALESCE(l.import_source,'')='' AND o.status='void' AND l.note LIKE 'order_cancelled%' AND l.note NOT LIKE '%legacy_review%'
   AND EXISTS (SELECT 1 FROM product_demand_settle_tasks v WHERE v.store_id=l.store_id AND v.order_uuid=l.order_uuid AND v.kind='void' AND v.state='done'
               AND v.id=(SELECT MAX(v2.id) FROM product_demand_settle_tasks v2 WHERE v2.store_id=l.store_id AND v2.order_uuid=l.order_uuid AND v2.kind='void' AND v2.state='done')
               AND (v.prior_order_status IS NULL OR trim(v.prior_order_status) NOT IN ('completed','pending','accepted','preparing','ready','delivering','cancelled')));
```

日誌：
- 設定 `PD_SETTLE_SWEEP_LOG=1` 時，每輪明細會包含 `legacy` 欄位（批次數、標記數、略過、失敗、是否完成）。
- 標示完成後，之後的輪次不再出現 `legacy` 欄位。

## 4. MBV2

本輪沒有新增欄位或資料表，MBV2 政策不變。匯入資料（`import_source` 非空）不參與歷史處理；匯入與升級不發送通知，也不改份數。

## 5. 回退

- **方式**：換回 STATE_EDGE_FIX 程式即可，不需要還原資料庫（沒有結構變更）。
- **已完成的標記**：回退版本不會移除或改寫。STATE_EDGE_FIX 的查詢本來就排除含 `legacy_review` 的紀錄（已驗證）。
- **回退期間重新出現的缺口**：STATE_EDGE_FIX 仍是「先取 500 筆再分類」，前段大量正常紀錄後方的未標記資料仍會漏標。
  - 再升級後，第一次啟動就會補標，不重複追加（已驗證）。
- **同一資料庫實測**：STATE_EDGE_FIX → 本輪 → 回退 → 再升級（`smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-upgrade-rollback.js`），4／4。
