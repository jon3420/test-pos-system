# LINE Pay 串接與訂單修正文件
版本：pos-saas-r1 + linepay-v3 + order-fix-v2
日期：2026-06

---

## 一、LINE Pay v3 串接流程

### 環境
- 正式環境：`https://api-pay.line.me`
- API 版本：v3

### 設定來源
後台「付款設定 → LINE Pay」填入：
- **Channel ID** → `payment_gateways.merchant_id`
- **Channel Secret** → `payment_gateways.secret_key`

### 付款流程

```
LINE 前台選 LINE Pay
       ↓
POST /api/line-orders（建立訂單，payment_status=pending）
       ↓
POST /api/linepay/request（呼叫 LINE Pay /v3/payments/request）
       ↓
取得 paymentUrl → redirect 客人至 LINE Pay 付款頁
       ↓
客人完成付款
       ↓
LINE Pay redirect → GET /api/linepay/confirm?transactionId=&orderId=
       ↓
呼叫 LINE Pay /v3/payments/{transactionId}/confirm
       ↓
成功：更新訂單 payment_status=paid, order_status=accepted
       ↓
廣播 WebSocket：type=new_line_order（觸發 POS 出單）
       ↓
redirect 前台 /line-order.html?linepay=success&order=訂單編號
```

---

## 二、新增 API 清單

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/linepay/request` | 建立 LINE Pay 付款請求，回傳 paymentUrl |
| GET  | `/api/linepay/confirm` | LINE Pay 付款成功 callback（由 LINE Pay redirect）|
| GET  | `/api/linepay/cancel`  | 付款取消 callback |
| POST | `/api/linepay/webhook` | LINE Pay webhook/notify 接收 |
| POST | `/api/linepay/test`    | 測試 Channel ID/Secret 是否有效（真實呼叫 LINE Pay）|

---

## 三、簽章邏輯

LINE Pay v3 HMAC-SHA256 簽章：

**POST 請求：**
```
message = channelSecret + URI + requestBodyString + nonce
signature = HMAC-SHA256(channelSecret, message) → Base64
```

**GET 請求：**
```
message = channelSecret + URI + queryString + nonce
signature = HMAC-SHA256(channelSecret, message) → Base64
```

Headers：
- `X-LINE-ChannelId`：Channel ID
- `X-LINE-Authorization-Nonce`：UUID（每次唯一）
- `X-LINE-Authorization`：HMAC-SHA256 Base64 簽章

---

## 四、訂單狀態流轉

| 階段 | order_status | payment_status |
|------|-------------|----------------|
| 建立訂單（LINE Pay 選擇）| pending | pending |
| 等待付款（redirect 至 LINE Pay）| pending | pending |
| LINE Pay confirm 成功 | accepted | paid |
| LINE Pay 取消 | pending | pending（保留，可重新付款）|
| 現金付款 | pending | pending（不變）|

---

## 五、現金付款不受影響

- 現金付款走原本流程：建立訂單後直接顯示成功頁
- `submitOrder()` 判斷 `selectedPay === 'linepay'` 才走 LINE Pay 路徑
- 其他付款方式（現金、轉帳等）完全不受影響

---

## 六、LINE 今日時段修正說明

**問題：** 今天週一，外送 15:00~20:00，現在 12:30，顯示「今日已無可預約時段」

**根本原因：** `getEarliestMins()` 邏輯正確（`max(nowMins+prep, openMins)`），問題在於前台 `buildTimeSelector` 的錯誤訊息翻譯不夠精確，以及部分情況下 `mode_closed` 被翻譯為「此日無可預約時段」

**修正：**
- `buildTimeSelector` 改進錯誤訊息：`no_slots_today` + 今天 → 顯示「今日時段已過，請選擇其他日期」
- `mode_closed` 顯示「此模式已關閉」

**正確邏輯（已存在且正確）：**
```
最早時間 = max(ceil((現在分鐘 + 備餐分鐘) / 30) * 30, 開店分鐘)
若最早時間 < 關店分鐘 → 有時段（從最早時間到關店）
若最早時間 >= 關店分鐘 → no_slots_today
```

---

## 七、預購訂單修正說明

**BUG-001：`Cannot access 'isPreorderOrder' before initialization`**

原因：`isPreorderOrder` 在第 641 行宣告，但在第 584/599 行就使用。

修正：在 POST `/` handler 進入後，緊接 `todayStr` 之後立即宣告：
```javascript
const orderDate = pickup_date || todayStr;
const isPreorderOrder = orderDate > todayStr;  // ← 提前宣告
```
並移除後面的重複宣告。

**預購訂單保護：**
- `isPreorderOrder=true` → 跳過今日份數限制
- `isPreorderOrder=true` → 跳過商品販售時段限制（只限今日）
- `isPreorderOrder=true` → 不扣 `line_quota_sold`

---

## 八、測試案例

### LINE Pay 測試連線
1. 後台 → 付款設定 → LINE Pay → 填入 Channel ID/Secret → 儲存
2. 點「測試連線」
3. 結果 A（正確）：✅ LINE Pay 設定有效
4. 結果 B（Secret 錯）：❌ Channel Secret 不正確

### LINE Pay 付款流程
1. LINE 前台下單，付款方式選 LINE Pay → 送出
2. 系統建立訂單，redirect 至 LINE Pay 付款頁
3. 完成付款後 LINE Pay redirect 回 `/api/linepay/confirm`
4. 後台可見訂單 `payment_status=paid`

### 今日時段
- 週一外送 15:00~20:00，現在 12:30 → 顯示 15:00~20:00 時段（30分鐘格）
- 週一外送 15:00~20:00，現在 19:50 → 今日時段已過，引導明日

### 預購訂單
- 預約明日外帶 15:30，今日份數已售完 → 成功送出，不扣今日份數
