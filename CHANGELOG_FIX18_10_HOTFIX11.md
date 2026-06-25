# CHANGELOG — fix18-10-hotfix11

## 版本
package.json: 18.1.11

## 根本原因（確認）

hotfix10 的 migration 使用 `BEGIN` transaction 包住 `CREATE TABLE ingredients_h10_tmp`。
Zeabur 上次部署時 server 崩潰，`ingredients_h10_tmp` 遺留在 DB 中。
下次啟動：
  BEGIN
  CREATE TABLE ingredients_h10_tmp  ← 失敗（table already exists）
  ROLLBACK
→ UNIQUE(name) 完全沒被移除。

## 修正內容（utils/db.js）

### hotfix11 migration 策略
1. **先清所有遺留 tmp/new 表**（DROP TABLE IF EXISTS，不用 transaction，不會 ROLLBACK）
   - `ingredients_h10_tmp`、`ingredients_h??_tmp`、`ingredients_h??_new`
2. **PRAGMA 實際查每個 unique index 的欄位**（不用 regex）
   - `PRAGMA index_list('ingredients')` → 逐一 `PRAGMA index_info(idxName)`
   - 只要有 unique index 欄位只含 `name`（不含 `store_id`）→ 觸發重建
3. **重建不用 transaction**（逐步執行，任一步失敗可重試）
4. **DEFAULT 含括號的函數呼叫正確重建**
   - PRAGMA table_info 回傳 `datetime('now','localtime')` 沒有外層括號
   - 重建時補括號：`DEFAULT (datetime('now','localtime'))`
5. **重建後再次 PRAGMA 驗證**，完整印出
6. **跨店同名防彈測試**：插入兩店同名記錄確認不報 UNIQUE 錯誤

## 新增（server.js）

### GET /api/debug/schema（無需登入）
部署後立即可呼叫確認線上 schema：
```json
{
  "success": true,
  "version": "18.1.11",
  "table_sql": "...",
  "indexes": [{ "name": "...", "unique": true, "columns": ["store_id","name"] }],
  "diagnosis": {
    "has_unique_name_only": false,
    "has_unique_store_id_name": true,
    "status": "UNIQUE(store_id,name) OK"
  }
}
```

## 其他修正（繼承自 hotfix10 → hotfix11）
- 全專案 `req.storeId || 'store_001'` 移除（routes/ + middleware/）
- 食材匯入 `INSERT OR IGNORE` → `INSERT`，`changes===0` 時 `skipped++` 非 `added++`
- 食材匯入加 storeId guard：storeId 為 null 直接 401

## 實測驗證結果

### Migration Cases（三種場景）
| Case | 說明 | 結果 |
|------|------|------|
| Case1 | 全新 DB | schema OK ✅ |
| Case2 | 舊版 UNIQUE(name) | 重建完成 ✅ |
| Case3 | UNIQUE(name) + 遺留 h10_tmp（Zeabur 情境）| 清 tmp → 重建 ✅ |

### /api/debug/schema 回傳
```json
{ "diagnosis": { "status": "UNIQUE(store_id,name) OK" } }
```

### 功能測試
```
① CSV 食材匯入 11筆:    added=11, SQL=11, GET=11  ✅
② CSV 扣料公式 13筆:    added=13, SQL=13, GET=13  ✅
③ Restore:               ings=11, fmls=13           ✅
④⑤ 商品庫存/扣料:       products=13, formulas=13   ✅
⑥ 匯出一致:              CSV rows=11                ✅
```
