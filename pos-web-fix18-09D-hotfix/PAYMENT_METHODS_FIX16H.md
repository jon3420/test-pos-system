# 付款方式初始化 — fix16h

## 問題根源
舊版資料庫沒有 `UNIQUE INDEX (store_id, code)`，導致 `INSERT OR IGNORE` 無效，
變成重複 INSERT（多達 48 筆）或在舊資料庫上 INSERT 失敗。

## 核心函式：ensureDefaultPaymentMethods(storeId, db)
位於 `routes/payment-methods.js`，匯出供 db.js / superAdmin.js 使用。

### 功能
1. `ensureIndex(db)` — 自帶 UNIQUE INDEX 建立，先清理重複資料再建 index
2. `getActualCols(db)` — `PRAGMA table_info` 取得實際欄位，動態建 INSERT SQL
3. `INSERT OR IGNORE` 6 筆預設付款方式，cash=1，其他=0

### 6 筆付款方式
| code | 名稱 | is_active |
|------|------|:---------:|
| cash | 現金 | **1** |
| card | 刷卡 | 0 |
| linepay | LINE Pay | 0 |
| jkopay | 街口支付 | 0 |
| transfer | 轉帳 | 0 |
| platform | 平台付款 | 0 |

## GET /api/payment-methods
每次請求都呼叫 `ensureDefaultPaymentMethods(storeId, db)`，
確保任何方案（Basic/Pro）的任何店家都能取得 6 筆。

## 測試結果
- store_002 第1次（從無到有）→ 6 筆 ✅
- store_002 第2次（無重複）→ 6 筆 ✅
- store_003 第1次 → 6 筆 ✅
- DB 實際筆數 === 6 ✅
