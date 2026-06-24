# fix18-10-hotfix2 — transaction 根本修正 + 匯出欄位完整修正

## 根本原因（已透過 sql.js 單元測試驗證）

### sql.js export() 在 active transaction 內觸發隱性 COMMIT

```
db.run() wrapper 每次執行後呼叫 save() = sqlDb.export()
sqlDb.export() 在 active transaction 中 → 觸發隱性 COMMIT + 清空 uncommitted data
後續 raw.run('COMMIT') → "cannot commit - no transaction is active"
```

驗證測試：
```js
db.run('BEGIN');
db.run("INSERT INTO t VALUES (1, 'a')");
db.export();  // ← 隱性 COMMIT，uncommitted data 被清除
db.run('COMMIT');  // → Error: cannot commit - no transaction is active
```

### 修正方案：rawRun() + runInTransaction()

```js
// 新增：在 tx 內直接操作 raw sql.js，完全繞過 wrapper save()
function rawRun(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
  // 不呼叫 save()，不呼叫 export()
}

function runInTransaction(db, fn) {
  const raw = db._db;   // raw sql.js
  raw.run('BEGIN');
  try {
    fn(raw);            // fn 使用 rawRun(raw, ...) 寫入
    raw.run('COMMIT');
    db._save();         // COMMIT 後才寫一次檔
  } catch(e) {
    try { raw.run('ROLLBACK'); } catch {}
    throw e;
  }
}
```

所有 import/orders, import/preorders, migration/import 內的 INSERT/UPDATE/DELETE
全部改用 `rawRun(raw, sql, params)`，共 27 處。

## 匯出修正：使用精確欄位名稱

| 資料表 | 匯出查詢 |
|---|---|
| discount_categories | SELECT id,store_id,code,name,icon,color,enabled,sort_order,created_at |
| discount_campaigns | SELECT id,store_id,name,description,enabled,sort_order,created_at |
| product_analysis_groups | SELECT id,store_id,group_name,description,enabled,sort_order,created_at,updated_at |
| product_analysis_group_items | SELECT id,store_id,group_id,product_id,product_name,created_at |
| product_analysis_group_aliases | SELECT id,store_id,group_id,alias_name,created_at |

## 匯入修正：正確欄位對應

同 hotfix1，額外相容性：
- `discount_categories.name` 相容舊格式 `label`
- `product_analysis_groups.group_name` 相容舊格式 `name`
- `enabled` 相容舊格式 `is_active`

## 測試結果

```
COMMIT: OK
Orders after tx: 2 (expected 2)
Campaigns after tx: 1 (expected 1)
COMMIT after partial failure: OK
Orders after partial-fail tx: 4 (expected 4)
ALL TESTS PASSED
```
