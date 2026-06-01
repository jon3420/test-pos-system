# 付款方式基礎功能 — fix16g

## 設計原則
付款方式（payment_methods）是 POS 基礎功能，與金流 API 完全分離。
Basic / Pro 所有方案均可使用。

## 6 筆付款方式（每店必有）
| code | 名稱 | 預設 is_active |
|------|------|:---:|
| cash | 現金 | 1 |
| card | 刷卡 | 0 |
| linepay | LINE Pay | 0 |
| jkopay | 街口支付 | 0 |
| transfer | 轉帳 | 0 |
| platform | 平台付款 | 0 |

## 三層補齊機制
1. **db.js 啟動 backfill**：掃描所有 stores，INSERT OR IGNORE 補齊
2. **GET /api/payment-methods**：每次請求都執行 INSERT OR IGNORE（fix16f-final）
3. **superAdmin POST /stores**：新增店家時立即補齊

## 唯一索引
`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code ON payment_methods(store_id, code)`
確保 INSERT OR IGNORE 正確去重，不覆蓋既有設定。

## 測試結果
store_001 / store_002 / store_003 → GET /api/payment-methods → 6 筆 ✅
