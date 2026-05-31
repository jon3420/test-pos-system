# Dashboard API 規劃 — Android 共用

## 端點
GET /api/dashboard?date=YYYY-MM-DD

## 保護
requireStore（store_id 隔離）+ requireFeature('reports')

## 回傳結構（供 Android POS 共用）
```json
{
  "success": true,
  "date": "2025-01-01",
  "store_id": "store_001",
  "data": {
    "todayRevenue": 4950,
    "todayOrders": 16,
    "paidOrders": 14,
    "unpaidOrders": 2,
    "avgOrderValue": 309,
    "weekRevenue": 28500,
    "weekOrders": 92,
    "monthRevenue": 148500,
    "monthOrders": 480,
    "paymentStats": [{ "payment_method": "cash", "count": 10, "revenue": 3000 }],
    "sourceStats":  [{ "mode": "takeout", "platform": "", "count": 11, "revenue": 3300 }],
    "topProducts":  [{ "name": "麻油腰子", "qty": 8, "revenue": 1200 }],
    "deliveryStats":[{ "platform": "Uber Eats", "count": 3, "revenue": 900, "commission": 270, "store_income": 630 }],
    "hourlyStats":  [{ "hour": 18, "label": "18:00", "count": 12, "revenue": 1800 }],
    "weekdayStats": [{ "day": 1, "label": "週一", "count": 80, "revenue": 24000 }],
    "lineStats":    { "orders": 4, "revenue": 600 }
  }
}
```

## Android 使用計畫
- Android POS 儀表板頁：呼叫同一端點
- store_id 由 JWT 或 x-store-id header 傳入
- 日期可由 Android 前端選擇（預設台灣今日）
