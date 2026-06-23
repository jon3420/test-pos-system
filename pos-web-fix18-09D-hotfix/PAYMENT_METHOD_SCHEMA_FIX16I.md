# Payment Method Schema 修正 — fix16i

## ensurePaymentMethodsSchema(db)
執行時機：GET /api/payment-methods 首次呼叫 + db.js 啟動 backfill

### Step 1: ALTER TABLE ADD COLUMN
補齊 13 個必要欄位（store_id / name / code / icon / is_active / sort_order / is_default / enable_* / gateway_code / created_at / updated_at）
PRAGMA table_info 確認後只補缺少的欄位。

### Step 2: code backfill（依 name 對應）
`UPDATE payment_methods SET code=? WHERE LOWER(name)=? AND (code IS NULL OR code='')`

### Step 3: UNIQUE INDEX
`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code ON payment_methods(store_id, code)`
