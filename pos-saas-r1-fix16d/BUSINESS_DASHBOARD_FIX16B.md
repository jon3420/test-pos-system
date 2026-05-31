# 老闆儀表板 — fix16b

## 資料來源
GET /api/dashboard?date=YYYY-MM-DD → routes/dashboard.js → 查 orders 表

## 十大分析區塊

| 區塊 | 內容 | Feature Gate |
|------|------|:---:|
| 今日總覽 | 營收、訂單、客單、已/未結帳 | reports |
| 週月營收 | 本週/本月營收與訂單數 | reports |
| 付款方式 | 各方式筆數、金額、佔比 | reports |
| 訂單來源 | 內用/外帶/外送+平台 | reports |
| 熱銷商品 | TOP10，依銷售量排序 | reports |
| 外送平台 | 平台、筆數、抽成、實收 | delivery |
| 時段分析 | 00-23 時段橫條圖 | reports |
| 星期分析 | 週一～週日近4週橫條圖 | reports |
| LINE 點餐 | 訂單數、營收 | line_order |
| 庫存分析 | 預留（開發中） | inventory |

## 日期選擇器
頁面頂部有日期選擇器，預設台灣今日，可切換任意日期。
