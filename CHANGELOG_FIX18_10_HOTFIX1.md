# fix18-10-hotfix1 — migration.js 修正

## 根因與修正對照

### 問題一：cannot commit - no transaction is active

**根因**
`db.run()` wrapper 每次執行後呼叫 `save()`（即 `sqlDb.export()`）。
在 `db.exec('BEGIN')` 開始的 transaction 中，若某個 `db.run()` 因欄位錯誤拋出異常，
`attempt()` 吞掉錯誤，但 sql.js 內部 transaction 狀態已損壞，
後續 `db.exec('COMMIT')` 失敗：cannot commit - no transaction is active。

**修正**
新增 `runInTransaction(db, fn)` helper：
```js
function runInTransaction(db, fn) {
  const raw = db._db;      // 直接操作 raw sql.js，跳過 wrapper save()
  raw.run('BEGIN');
  try {
    fn();
    raw.run('COMMIT');
    db._save();            // 只在 COMMIT 成功後寫一次檔
  } catch(e) {
    try { raw.run('ROLLBACK'); } catch {}
    throw e;
  }
}
```
所有匯入操作改用此 helper，錯誤發生時必定 ROLLBACK。
每一筆錯誤以 `results.errors.push(...)` 記錄，不影響 transaction 繼續。

### 問題二：order_items 顯示 0

**根因**
本專案無獨立 `order_items` 資料表，訂單明細存在 `orders.items`（JSON 字串）。
`fetchByIds(db, 'order_items', ...)` 查詢不存在的表，`safeAll` 吞錯回傳 `[]`。

**修正**
- 匯出：展開 `orders.items` JSON，組成 `order_items_expanded`（供參考）
- 匯入：完全不依賴 `order_items`，items 已含在每筆 `orders.items` 欄位
- 搬家檔 `data.order_items` 固定為 `[]`，加上註解說明

### 問題三：欄位名稱對應錯誤

| 資料表 | 舊（錯誤）| 新（正確）|
|---|---|---|
| `product_analysis_groups` | `name`, `is_active` | `group_name`, `enabled`；補 `description`, `updated_at` |
| `product_analysis_group_items` | 缺 `store_id`, `product_name` | 補齊；`product_name` 從 products 查補 |
| `discount_categories` | `label`, `is_active` | `name`（相容 `label`）, `enabled`；補 `icon`, `color` |
| `discount_campaigns` | 大量不存在欄位 | 只保留 `name`, `description`, `enabled`, `sort_order` |

### 問題四：跨店保護失效

**根因**
```js
// 舊（錯誤）：cross_store=true 被當成「允許」旗標
const allowCross = _migrationPreviewData?.cross_store;  // true = 允許
```

**修正**
```js
// 新：獨立旗標，只有使用者明確勾選才設為 true
let _migrationCrossAllowed = false;

function onCrossStoreCheckChanged(checkbox) {
  _migrationCrossAllowed = checkbox.checked;
  // 只有勾選後才顯示匯入按鈕
}

// 傳給後端
allowCrossStoreImport: isCrossStore ? _migrationCrossAllowed : false
```

跨店時後端預設 403 拒絕，前端需使用者勾選「我確認要跨店匯入」才允許。

### Preview 統計修正
移除 `order_items`（不存在的表），正確顯示：
products / categories / orders / preorders /
discount_categories / discount_campaigns /
product_analysis_groups / _items / _aliases / settings

## 測試對照

| 測試 | 預期 | 狀態 |
|---|---|---|
| A. store_001→store_002 未勾選 | 後端 403，前端阻擋 | ✅ |
| B. store_001→store_002 勾選確認 | 允許匯入 | ✅ |
| C. skip 模式重複單號 | skipped++ 不重複新增 | ✅ |
| D. overwrite 模式 | 用 INSERT OR REPLACE 更新 | ✅ |
| E. replace 模式 | DELETE WHERE store_id=store_002 | ✅ |
| F. transaction 失敗 | ROLLBACK，不寫入一半 | ✅ |
