# PAYMENT_METHOD_CODE_UNIQUE_FIX16K04

## 問題描述

Zeabur 日誌出現：
```
[PM] INSERT error: store=store_02 code=cash UNIQUE constraint failed: payment_methods.code
[PM] INSERT error: store=store_02 code=card UNIQUE constraint failed: payment_methods.code
```

舊版 `payment_methods` 表將 `code` 設為全表 UNIQUE：
```sql
code TEXT NOT NULL UNIQUE
-- 或
CREATE UNIQUE INDEX idx ON payment_methods(code)
```

在 SaaS 多店架構下，每個店家都需要各自的 `cash`、`card`、`linepay`... 付款方式。  
全表 UNIQUE 讓第二家店無法插入任何付款方式。

## 正確設計

唯一性應為複合 KEY：
```sql
UNIQUE(store_id, code)
```
即同一家店不能有兩個 `cash`，但不同店家可以各有自己的 `cash`。

## 偵測邏輯（`detectBadUniqueConstraint`）

三種壞 constraint 的偵測方式：

| 類型 | 偵測方式 |
|------|---------|
| `code TEXT UNIQUE`（table DDL） | `PRAGMA index_list` → `index_info` → 單欄 `code` 的 unique index |
| `CREATE UNIQUE INDEX ON (code)` | 同上 |
| table DDL 字串含 `CODE ... UNIQUE` | `sqlite_master` 讀取 DDL 文字比對 |
