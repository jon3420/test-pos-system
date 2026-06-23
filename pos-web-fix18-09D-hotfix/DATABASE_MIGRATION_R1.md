# Database Migration R1

## 遷移策略：零停機 ALTER TABLE

所有遷移透過 SQLite `ALTER TABLE ADD COLUMN` 實現，在 `initTables()` 啟動時自動執行，使用 `try-catch` 忽略已存在的欄位錯誤。

---

## 新增欄位

### products
```sql
ALTER TABLE products ADD COLUMN store_id TEXT NOT NULL DEFAULT 'store_001';
UPDATE products SET store_id='store_001' WHERE store_id IS NULL OR store_id='';
```

### categories
```sql
ALTER TABLE categories ADD COLUMN store_id TEXT NOT NULL DEFAULT 'store_001';
UPDATE categories SET store_id='store_001' WHERE store_id IS NULL OR store_id='';
```

### orders
```sql
ALTER TABLE orders ADD COLUMN store_id TEXT NOT NULL DEFAULT 'store_001';
UPDATE orders SET store_id='store_001' WHERE store_id IS NULL OR store_id='';
```

### settings
舊版 settings 為 `(key TEXT PRIMARY KEY, value TEXT)`
新版為 `(id, store_id, key, value, UNIQUE(store_id, key))`

Migration 會將舊版資料遷移至 store_001：
```sql
INSERT OR IGNORE INTO settings (store_id, key, value)
SELECT 'store_001', key, value FROM settings WHERE store_id IS NULL;
```

### inventory_logs, order_logs, customers, payment_methods, payment_gateways, delivery_platforms, devices, ingredients
```sql
ALTER TABLE <table> ADD COLUMN store_id TEXT NOT NULL DEFAULT 'store_001';
UPDATE <table> SET store_id='store_001' WHERE store_id IS NULL OR store_id='';
```

---

## 新增資料表

### stores
```sql
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL UNIQUE,
  store_name TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'basic',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
```

### super_admins
```sql
CREATE TABLE IF NOT EXISTS super_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
```

---

## 初始資料

1. `stores`: 插入 store_001 脆豬腰（若不存在）
2. `super_admins`: 插入 superadmin（SHA-256 of 'admin1234'）
3. `licenses`: 將 default_store 更新為 store_001 脆豬腰

---

## 風險評估

| 風險 | 等級 | 對策 |
|------|------|------|
| 舊資料沒有 store_id | 低 | Migration 自動補 store_001 |
| settings 表結構改變 | 低 | INSERT OR IGNORE 保護 |
| Android POS 相容性 | 無 | /api/license 完全未動 |
| LINE 點餐相容性 | 低 | x-store-id header / ?store_id= 均相容 |

