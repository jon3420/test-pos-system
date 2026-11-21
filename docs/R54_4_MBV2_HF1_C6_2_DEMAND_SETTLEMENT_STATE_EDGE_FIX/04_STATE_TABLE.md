## 狀態對照表（實作前訂定；即時 hook、啟動補齊、定期補齊共用同一套判斷）

### 1. 判斷順序（每個訂單商品關聯各自判斷）

1. **證據**：綁定只使用待辦保存的店別、已驗證會員、原訂單 UUID、商品、原登記 `request_uuid`、份數。
   - 訂單不存在 → 待辦 `review`（`order_missing`），不建立關聯。
   - 不重新尋找最新 active 登記。
2. **作廢前履約狀態**：只採用作廢交易內保存的作廢待辦，並先分類（第 3 節）。
3. **購買證據**：非 LINE Pay 有效訂單，或 LINE Pay 且後端 `payment_status='paid'`。
   - 履約欄位、紀錄狀態都不能當作付款證據。
4. **原週期有效性**：只有在**新增扣減**的那一刻，於同一 durable 交易內核對（第 2 節）。

### 2. 原週期有效性（只影響「新增扣減」）

| 原週期 | 新增扣減 | 關聯結果 |
|---|---|---|
| `active`／`completed` 且 `julianday(expires_at) > julianday('now')` | 依剩餘份數扣減 | `settled` |
| `active` 但 `expires_at` 已過（自然到期，尚未被改成 expired） | **0** | `settled`，`applied_qty=0`，note `cycle_closed:expired_at` |
| `expired`／`cancelled` | 0 | `settled`，`applied_qty=0`，note `cycle_closed:<status>` |
| `expires_at` 為 NULL、空白或無法解析 | 0 | **`review`**，`applied_qty=0`，note `cycle_validity_unknown` |
| 週期不存在 | 0 | `settled`，`applied_qty=0`，note `cycle_missing` |

補充規則：
- 新增扣減不會移到新週期，也不會讓已過期或已取消的週期復活。
- **既有已完成份數**（已 `settled` 的關聯）不重新判斷期限：
  - 週期之後到期、重試、重啟、補齊，都不清除也不重複回復。
  - 只有訂單取消或作廢的規則會回復這些份數。
- 期限一律以資料庫的 UTC 字串與 SQLite `julianday('now')` 比較，與既有 `expires_at > datetime('now')` 同一時間基準，不受主機 TZ 影響。

### 3. 作廢前履約狀態分類（共用 `classifyVoidPrior`）

正式流程允許的值（`utils/orderStatusFlow.js` `ORDER_STATUSES`）：

| 分類 | 值 | 作廢時 |
|---|---|---|
| 已履約 | `completed` | 待核對（`void_after_completed`），不自動回復 |
| 有充分證據的未履約 | `pending`、`accepted`、`preparing`、`ready`、`delivering` | 依原扣減回復一次 |
| 已取消 | `cancelled` | 與取消規則相同（取消時已處理者不再處理；未處理者依原扣減回復一次） |
| 未知或不合法 | NULL、空字串、其他值、沒有作廢待辦 | 待核對（`void_prior_state_missing`／`void_prior_state_invalid`／`void_prior_state_unknown`），**不自動回復** |

補充：
- 判斷只看 `order_status`（履約流程），不看 `orders.status`（紀錄狀態），也不看付款狀態。
- `status='completed'` 配 `order_status='accepted'` 判為未履約。

### 4. 有效週期下的訂單狀態 × 綁定時點

綁定時點的兩種情況：
- **準時綁定**：訂單交易內完成綁定。
- **延遲綁定**：綁定故障，由待辦稍後補齊。

原則：**延遲綁定的最終結果，必須與準時綁定再經過相同事件的結果一致。**

| 訂單狀態 | 準時綁定 | 延遲綁定（修正後） |
|---|---|---|
| 現金等有效訂單 | `settled` | `settled` |
| LINE Pay 待付款（付款請求仍有效） | `reserved` | `reserved` |
| LINE Pay 已付款（後端確認） | `settled` | `settled` |
| LINE Pay 付款失敗或逾期 | `released` | `released` |
| LINE Pay 付款待核對（confirm_pending／review） | `reserved` | `reserved`（不推定已付款） |
| 未履約取消／作廢 | 已扣減 → `reverted`（回復一次）；訂購中 → `released` | 從未扣減 → `released`（不回復、不多扣） |
| 已履約作廢＋購買證據 | 已扣減 → `review`（保留份數） | **先依原週期扣減，再轉 `review`**（保留份數；週期若已過期或取消則扣 0） |
| 已履約作廢、LINE Pay 未付款或付款不明 | 訂購中 → `review`（扣 0，note `…:payment_unconfirmed`） | 同左，不扣減 |
| 作廢前狀態未知（含 NULL、空字串、不合法、沒有待辦） | 已扣減 → `review`（保留） | 有購買證據：先扣再 `review`；沒有：`review`（扣 0） |

### 5. 待辦結果可追查

- **綁定待辦**：`done`（`linked`／`link_exists`），或 `review`（`order_missing`）。
- **作廢待辦**：`done`，result 記錄實際動作：
  - `cancel`
  - `review:void_after_completed`
  - `review:void_prior_state_missing`
  - 依此類推
- 業務結果以關聯的 `state`、`applied_qty`、`note` 表達。
- 後台登記明細同時列出關聯與待辦。
