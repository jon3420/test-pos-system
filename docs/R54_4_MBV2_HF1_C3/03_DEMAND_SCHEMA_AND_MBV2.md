# R54.4／MBV2-HF1-C3：想買登記資料表、遷移與 MBV2 備份支援

## 一、遷移方式

- 位置：`utils/productDemand.js` 的 `migrate()`，由 `utils/db.js` 的 `initTables()` 最後一步呼叫。
- 只做新增：`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`、`ALTER TABLE products ADD COLUMN`（欄位不存在時才加）。
- 不刪除、不重建、不改動既有資料。可重複執行。
- 遷移失敗只寫一行警告，不會擋住開機。這時候想買登記 API 會回錯誤，點餐與送單不受影響。

## 二、新增欄位與資料表

### `products.demand_collect_enabled`

整數，預設 `1`。店家可以針對個別商品關閉想買登記（後台「🙋 想買登記」分頁的「收集」勾選框）。這個欄位跟著「商品資料」分類一起備份。

### `product_demand_requests`（想買登記）

| 欄位 | 說明 |
|---|---|
| `id` | 自動編號 |
| `request_uuid` | 全域唯一（唯一索引）。備份匯入時用它判斷是不是同一筆 |
| `store_id` | 店別 |
| `product_id` | 商品 |
| `product_name_snapshot` | 登記當下的商品名稱。匯入時找不到對照表，就用它對回商品 |
| `line_user_id` | 會員。只來自後端驗簽過的 `member_session` |
| `desired_qty` | 想買份數，1～99 的整數 |
| `fulfillment_pref` | 取餐偏好：`takeout`／`delivery`／`any`。只能選商品有支援的方式 |
| `status` | `active`／`cancelled`／`expired`。另外保留 `notified`／`converted` 給以後用 |
| `cycle_no` | 有效週期編號。取消或過期後重新登記時加 1 |
| `source` | 來源，固定 `line_order` |
| `created_at`／`updated_at` | 建立／修改時間（UTC） |
| `expires_at` | 有效期限（UTC）。預設建立後 30 天，店家可改成 1～180 天 |
| `cancelled_at` | 取消時間 |
| `restock_batch_id`／`notified_at`／`converted_order_id` | **保留欄位，本輪不寫入**。之後的補貨批次、發送紀錄、轉單追蹤會用到 |

索引：

- `idx_pdr_active_unique`：部分唯一索引，條件是 `status='active'`，範圍是同一店別、商品、會員。資料庫層保證同一時間最多只有一筆有效登記。
- 另有依店別＋商品、店別＋會員查詢的索引。

### `product_demand_consents`（補貨通知同意，跟登記分開存）

| 欄位 | 說明 |
|---|---|
| `consent_uuid` | 唯一（唯一索引） |
| `store_id`、`product_id`、`line_user_id` | 同意屬於哪個店別、商品、會員 |
| `request_uuid` | 同意當下對應的登記（文字關聯，跨店匯入也不會壞） |
| `channel` | 通知管道，固定 `line` |
| `status` | `granted`／`revoked` |
| `consent_text_version` | 同意文字的版本，目前是 `restock-notify-v1` |
| `granted_at`／`revoked_at`／`created_at`／`updated_at` | 各時間點 |

規則：

- 登入、加好友、曾經下單，都**不算**同意收補貨通知。
- 本輪後端判定通知不可用（`NOTIFY_CHANNEL_IMPLEMENTED=false`），所以 API 不會新增 `granted` 紀錄。
- 撤回同意永遠可以做。取消登記時，也會一併撤回該商品的同意。

## 三、設定值（`settings` 資料表，跟「系統設定」分類一起備份）

| key | 預設 | 用途 |
|---|---|---|
| `product_demand_enabled` | `1` | 整個功能的開關。關閉後前台不顯示「我想買」，登記 API 回 403 |
| `product_demand_ttl_days` | `30` | 登記有效天數，可設 1～180 |
| `product_demand_notify_enabled` | `0` | 店家想不想開補貨通知。**必須同時**程式已實作通知（本輪是 false）才會生效 |

## 四、MBV2 備份與匯入

### 新分類

新增一個分類 `product_demand`，顯示名稱「商品想買登記」，檔名標籤 `demand`。

- 包含 `product_demand_requests` 和 `product_demand_consents` 兩張表。
- 建議一起選「商品資料」和「LINE 會員」。
- 完整備份（`mode=full`）一定會包含這個分類，選擇性備份可以自己勾選。
- 分類總數從 12 個變成 13 個。

### 匯入時關聯怎麼對回來

- **商品**：先用備份檔裡的 `ref_maps.products`，再用 `product_name_snapshot`，對回目標店的商品（依序比對 id＋名稱、條碼、唯一名稱）。都對不到就記為「缺少關聯」，不寫入。測試中 701→801 這種換了 ID 的情況，能正確對回。
- **會員**：用 `line_user_id` 對應，不依賴流水號 id。
- **店別**：一律寫入目前登入的店家。
- **重複判斷**：用 `request_uuid`／`consent_uuid` 判斷是不是同一筆。同一份備份匯入兩次，不會多出資料。
- **有效登記衝突**：目標店已經有「同一會員、同一商品」的有效登記時，保留現有那筆，備份裡的那筆記為「缺少關聯」並附上原因。不覆蓋，也不累加。

### 匯入不會發推播

- 匯入程式只寫資料庫，不呼叫任何 LINE 或推播 API。
- 驗收時用網路攔截器計算 LINE API 呼叫次數，結果是 0 次（B11、Z1）。

### 舊備份不會清掉現有登記

舊備份是 C2 或更早版本做的，裡面沒有 `product_demand` 分類：

- 這個分類不在備份檔的分類清單裡，所以沒辦法被選取。
- 「完整取代」只會清除「備份檔有、而且有被選取」的分類（見 `purgeTablesFor()`）。
- 所以用舊備份做「完整取代」，現有的登記和同意都會留著。驗收 B9 已實測。

### 版本相容提醒（回退時要注意）

- C3 做出來的完整備份含有新分類。C2 的匯入程式不認得這個分類，會以 `UNKNOWN_CATEGORY` 拒絕。
- 回退到 C2 之後，請改用下面任一種備份：
  - C2 時期做的備份；
  - 在 C3 用「選擇性匯出」做的備份，而且沒勾「商品想買登記」。
- `schema_version` 維持 2（本次只是新增分類）。
