# CHANGELOG — fix18-10-hotfix5

## 問題描述

**快速搬家檔匯入：delivery_platforms has no column named code**

```
[platform id=1] table delivery_platforms has no column named code
[platform id=2] table delivery_platforms has no column named code
[platform id=3] table delivery_platforms has no column named code
```

備份檔帶有 `code` 欄位，但目前 DB 的 `delivery_platforms` 表無此欄位，導致全部失敗。

---

## 根因分析

### BUG-3：migration/import 所有資料表硬寫欄位清單

`migration/import` 對每張表都使用固定的欄位清單進行 INSERT，
例如：

```sql
-- 舊（錯誤）
INSERT OR IGNORE INTO delivery_platforms
  (id, store_id, code, name, is_active, commission_rate, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
-- code 欄位在舊版 DB 不存在 → 失敗
```

當備份檔來自較新版本（有 `code` 欄位），但目前 DB 是舊版（無 `code` 欄位），
或反之，INSERT 就會失敗。

---

## 修正內容

### routes/migration.js（全面重寫 migration/import 區段）

**一、新增 `buildDynamicInsert()` 通用 helper**

```javascript
function buildDynamicInsert(table, candidates, srcObj, colSet, orMode) {
  const cols = candidates.filter(c => colSet.has(c)); // 只保留 DB 實際有的欄位
  const vals = cols.map(c => srcObj[c] ?? null);
  const phs  = cols.map(()=>'?').join(',');
  return { sql: `INSERT ${orMode} INTO ${table} (${cols.join(',')}) VALUES (${phs})`, vals };
}
```

**二、所有資料表改用動態欄位（PRAGMA 在 transaction 外預讀）**

| 資料表 | 修正前 | 修正後 |
|--------|--------|--------|
| categories | 硬寫 7 欄 | PRAGMA 動態 |
| products | 硬寫 26 欄 | PRAGMA 動態 |
| orders | 已修（hotfix4）| 繼續沿用 |
| order_logs | 已修（hotfix4）| 繼續沿用 |
| discount_categories | 硬寫 9 欄 | PRAGMA 動態 |
| discount_campaigns | 硬寫 7 欄 | PRAGMA 動態 |
| product_analysis_groups | 硬寫 8 欄 | PRAGMA 動態 |
| product_analysis_group_items | 硬寫 6 欄 | PRAGMA 動態 |
| product_analysis_group_aliases | 硬寫 5 欄 | PRAGMA 動態 |
| settings | 硬寫 3 欄 | PRAGMA 動態 |
| **delivery_platforms** | **硬寫含 code → 失敗** | **PRAGMA 動態，code 自動略過** |
| delivery_fees | 硬寫 6 欄 | PRAGMA 動態 |

**三、delivery_platforms 特別相容**

備份檔可能有 `code` / `name` / `platform_name` 等不同欄位命名。
候選清單同時包含所有變體，由 PRAGMA 過濾只保留 DB 實際有的：

```javascript
const candidates = [
  'id','store_id','code','name','platform_name',
  'commission_rate','is_active','created_at','updated_at'
];
// DB 無 code → 自動略過，不報錯
```

**四、錯誤計數與狀態顯示**

- 回傳 `status: 'success' | 'partial'`
- 回傳 `status_label: '匯入完成' | '部分匯入完成，有錯誤'`
- 回傳 `table_errors[]`：失敗資料表清單，含失敗筆數與範例錯誤
- 回傳 `summary`：total_added / total_updated / total_skipped / total_failed
- 回傳 `results`：每張表的 added / skipped / failed / errors 明細

**五、replace 模式 all-or-nothing**

`mode === 'replace'` 時，任何錯誤觸發整個 transaction ROLLBACK，
回傳 HTTP 500 並說明「已全部回滾」。

---

## 驗證測試

| 測試 | 預期結果 |
|------|----------|
| store_001 匯出快速搬家檔 → store_02 匯入 | 不再出現 `delivery_platforms has no column named code` |
| 備份檔欄位多於目前 DB | 多餘欄位自動略過，不報錯 |
| 目前 DB 欄位多於備份檔 | 缺少欄位使用 NULL / 預設值 |
| 商品 / 訂單 / LINE預購 / 折扣活動 / 商品分析群組 / 歷史別名 / 外送平台 | 均正常匯入 |
| failed > 0 | 顯示「部分匯入完成，有錯誤」而非「匯入完成」 |
| replace 模式中途錯誤 | 全部 ROLLBACK，不匯入一半 |
