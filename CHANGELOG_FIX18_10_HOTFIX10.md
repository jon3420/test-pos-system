# CHANGELOG — fix18-10-hotfix10

## 版本：fix18-10-hotfix10
## 輸出：pos-web-fix18-10-hotfix10-full.zip

## 修正：ingredients UNIQUE(name) 跨店衝突

### 問題
舊版 `ingredients` 表有 `UNIQUE(name)` 約束，導致跨店匯入時：
- store_001 已有「豬腰」，store_02 匯入「豬腰」→ `UNIQUE constraint failed: ingredients.name`

### 修正方式
`utils/db.js` 啟動時自動偵測並修正：
1. 偵測 inline `UNIQUE` 或 `CREATE UNIQUE INDEX ... ON ingredients(name)`
2. 若偵測到，動態重建表為 `UNIQUE(store_id, name)`
3. 資料完整保留（`INSERT OR IGNORE` 跳過同店同名重複）

### 驗證結果
- inline UNIQUE(name) 偵測與重建：✓
- UNIQUE INDEX ON ingredients(name) 偵測與重建：✓
- 正確 schema 不觸發重建：✓
- 跨店同名不衝突：✓
- 同店同名阻止：✓
- Restore 11食材 13公式：✓

## 同時包含 hotfix9 全部修正
- Restore ingredients loop 重寫（replace 模式 existIng 場景）
- ingredientIdRemap 保證建立
- 所有 transaction 內查詢改用 safeRawAll(raw)
- 匯出 API token 修正（downloadWithAuth）
