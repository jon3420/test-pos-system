# LINE 接單與可售管理中心 v1

版本：fix16k-04 → v1-line-order-center  
日期：2026-06

---

## 修改摘要

### 修改的檔案

| 檔案 | 說明 |
|------|------|
| `utils/db.js` | 新增外帶/外送設定欄位 default、products 新增 7 個 LINE quota 欄位 |
| `routes/settings.js` | LINE_KEYS 新增 9 個外帶/外送/跨日設定 key |
| `routes/line-orders.js` | 全面改寫，新增 6 個階段邏輯 + /timeslots + /validate-cart + /quota-reset |
| `public/line-order.html` | LINE 前台全面升級：外帶/外送分頁、動態時段、售完狀態、雙重驗證 |
| `server.js` | 新增 scheduleDailyQuotaReset、掛載 timeslots/validate-cart 路由 |

---

## 六個階段說明

### 第一階段：外帶 / 外送接單規則

新增 settings key（外帶）：
- `takeout_enabled` — 外帶開關
- `takeout_cutoff_time` — 今日最後接單時間（HH:MM）
- `takeout_prep_minutes` — 最短備餐時間（分鐘）
- `takeout_allow_next_day` — 允許明日預購
- `takeout_business_hours` — 每週營業時間 JSON

新增 settings key（外送）：
- `delivery_cutoff_time`, `delivery_prep_minutes`, `delivery_allow_next_day`, `delivery_business_hours`

**外帶/外送完全獨立，互不影響。**

### 第二階段：LINE 專屬可售份數

新增 products 欄位：
- `line_quota_enabled` — 是否啟用 LINE 份數管理
- `line_quota_daily` — 今日開放份數
- `line_quota_sold` — LINE 已售份數（下單時 +qty，每日 00:05 歸零）
- `line_quota_low_threshold` — 低庫存提醒門檻
- `line_quota_high_threshold` — 充足顯示門檻
- `line_sell_start`, `line_sell_end` — LINE 可販售時段

**重要：`line_quota_sold` 只在 LINE 下單時更新，完全不動 `current_stock_grams`、`allocated_grams`、食材庫存等主庫存欄位。**

### 第三階段：動態時段

`GET /api/line-orders/timeslots?mode=takeout|delivery&date=YYYY-MM-DD`

邏輯：
- 最早時間 = max(現在 + 備餐時間, 開店時間) 進位至 30 分鐘
- 今日若已超過關門時間 → 回傳空陣列
- 前端改為呼叫 API，不再前端自算

### 第四階段：公休日 / 店休日

使用現有 `line_closed_weekdays`（每週公休）與 `line_closed_dates`（指定店休）。

前台 `GET /api/line-shop` 回傳 `today_closed_info`，前端顯示「今日店休」並拒絕下單。

### 第五階段：行銷型售完

兩種售完原因（前台均顯示「今日售完」）：
- `real_sold_out`：`line_quota_sold >= line_quota_daily`
- `cutoff_sold_out`：現在 > `takeout_cutoff_time` 或 `delivery_cutoff_time`

cutoff_sold_out **不扣主庫存**，只影響 LINE 前台顯示。
外帶/外送獨立判斷，可以外帶截止但外送仍可下單。

### 第六階段：結帳雙重驗證

1. **加入購物車時**：前端即時判斷 soldOutReason 和 quota.remaining
2. **送出訂單前**：後端 `validateOrderConditions()` 完整重新驗證 5 個條件：
   - 模式是否開放
   - 是否超過截止時間
   - LINE 剩餘份數
   - 是否店休日
   - 選擇時間是否有效

---

## 測試案例驗證

| 案例 | 驗證方式 | 通過機制 |
|------|---------|---------|
| 1. 外帶開/外送關 | `deliveryEnabled=false` 時前台不渲染外送標籤 | LINE 前台只顯示外帶 |
| 2. 外帶關/外送開 | `takeoutEnabled=false` 時前台不渲染外帶標籤 | LINE 前台只顯示外送 |
| 3. 外帶 18:00 截止，現在 18:10 | `takeoutCutoffPassed=true`，外帶商品 `takeout_sold_out_reason=cutoff_sold_out` | 外帶顯示售完，外送正常 |
| 4. LINE 開放 10 份已售 10 份 | `line_quota_sold>=line_quota_daily` → `real_sold_out`，主庫存不動 | LINE 售完，Web/Android 正常 |
| 5. 12:10 + 備餐 10 分 + 開店 15:00 | `getEarliestMins` 回傳 900（15:00） | 最早選 15:00 |
| 6. 19:55 + 開店 15:00 關店 20:00 + 備餐 10 分 | `earliest=20:05 >= 20:00` → 回傳 null | 今日無時段，前端顯示明天 |
| 7. 今日為公休/店休日 | `isClosedDate()` 或 `today_closed_info.closed=true` | 前台顯示今日店休 |

---

## API 新增

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/line-timeslots?mode=&date=` | 查詢指定模式/日期的可選時段 |
| GET | `/api/line-validate-cart?mode=&product_ids=` | 加入購物車前驗證 |
| POST | `/api/line-orders/quota-reset` | 手動重置今日已售份數 |

---

## 重要限制（已遵守）

1. ✅ 不修改 Android POS
2. ✅ LINE 份數歸零不修改主庫存（`current_stock_grams`、食材庫存等）
3. ✅ cutoff_sold_out 不扣任何庫存
4. ✅ 保留既有 `line_business_hours` 設定，新增的 `takeout_business_hours`/`delivery_business_hours` 為新 key，不覆蓋
