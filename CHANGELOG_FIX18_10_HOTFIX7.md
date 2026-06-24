# CHANGELOG — fix18-10-hotfix7

## 問題描述

**快速搬家匯入後分類失敗：UNIQUE constraint failed: categories.name**

商品成功、訂單成功，但分類全部失敗：
```
UNIQUE constraint failed: categories.name
```

---

## 根因分析

### PRAGMA 診斷結果

```sql
PRAGMA table_info(categories);
-- name TEXT NOT NULL UNIQUE   ← 舊版遺留的全域 UNIQUE 約束
```

舊版 DB 建立 categories 時使用 `name TEXT NOT NULL UNIQUE`，
這是單欄位全域唯一約束（跨所有 store_id）。

store_001 已有「主食」、「飲品」等分類，
store_03 嘗試匯入同名分類時，SQLite 拋出：
```
UNIQUE constraint failed: categories.name
```

hotfix6 已改用 `(store_id, name)` 判斷重複，但底層 DB 的舊 UNIQUE 約束
仍在，INSERT 本身就會失敗，無論應用層邏輯如何都繞不過去。

---

## 修正內容

### utils/db.js — 啟動時自動偵測並重建 categories 表

```
PRAGMA table_info(categories)
PRAGMA index_list(categories)
PRAGMA index_info(<index_name>)
```

偵測條件：
1. DDL 中含有 `name TEXT ... UNIQUE`（inline 約束）
2. 或存在僅覆蓋 `name` 欄位的 unique index

若偵測到舊格式，執行原子性重建：

```sql
BEGIN;

CREATE TABLE categories_h7_tmp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL DEFAULT 'store_001',
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📌',
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(store_id, name)      -- ← 正確的多店隔離唯一鍵
);

INSERT INTO categories_h7_tmp (id, store_id, name, icon, sort_order, is_active, created_at, updated_at)
  SELECT id, store_id, name, icon, sort_order, is_active, created_at, updated_at
  FROM categories;

DROP TABLE categories;
ALTER TABLE categories_h7_tmp RENAME TO categories;

COMMIT;
```

若 DB 已是新格式（無問題），則確保存在：
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_store_name ON categories(store_id, name);
```

**所有舊資料完整保留，重建過程 ROLLBACK 安全。**

### routes/migration.js — 分類匯入邏輯（沿用 hotfix6）

重複判斷使用 `WHERE store_id=? AND name=?`，
INSERT 不寫入 `id`（讓 AUTOINCREMENT 指派新 id），
category_id 透過 `catNameToId` 重新對應本店實際 id。

---

## 驗證

| 測試 | 預期結果 |
|------|----------|
| 舊版 DB（有 UNIQUE(name)）啟動 | 自動偵測並重建，日誌顯示「fix18-10-hotfix7: categories 重建完成」 |
| 新版 DB（無問題）啟動 | 建立 UNIQUE INDEX(store_id, name)，無額外動作 |
| store_001 匯出 → store_03 匯入 | 不再出現 UNIQUE constraint failed |
| store_001 原有分類不受影響 | `SELECT COUNT(*) FROM categories WHERE store_id='store_001'` 不變 |
| store_03 分類正確建立 | `SELECT COUNT(*) FROM categories WHERE store_id='store_03'` = 9 |
| products.category_id 正確對應 | store_03 商品的 category_id 指向 store_03 的分類 id |
