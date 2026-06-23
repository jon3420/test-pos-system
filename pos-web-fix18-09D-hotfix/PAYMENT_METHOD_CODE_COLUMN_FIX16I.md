# Payment Method code 欄位相容 — fix16i

## 問題
舊版 payment_methods 可能只有 id/name/is_active，INSERT OR IGNORE 因缺少 code 欄位而靜默失敗。

## 修正流程
1. ALTER TABLE ADD COLUMN code TEXT DEFAULT ''
2. UPDATE SET code 依 name 對應（現金→cash 等）
3. DELETE 空 code 殘留（per-store，每次 GET 都執行）
4. UNIQUE INDEX 建立
5. INSERT OR IGNORE 正確插入 6 筆
