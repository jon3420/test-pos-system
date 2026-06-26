# CHANGELOG — fix18-10-hotfix12

## 版本
package.json: 18.1.12

## 問題
delivery_platforms 表存在 UNIQUE(name)（舊版遺留），
導致 store_02 無法新增 Uber Eats（store_001 已有同名平台）。

## 根本原因
與 hotfix11 的 ingredients 問題相同：
舊版 CREATE TABLE 有 UNIQUE(name)，
前次 migration 崩潰後 tmp 表遺留，導致重建 ROLLBACK，
UNIQUE(name) 仍存在。

## 修正（utils/db.js）

### hotfix12 migration（步驟同 hotfix11）
1. 清遺留 tmp/new 表（DROP TABLE IF EXISTS）
2. PRAGMA index_list 查每個 unique index 欄位
3. 偵測到 UNIQUE(name) → 重建
4. safeDefault 處理 datetime() 函數呼叫
5. 重建後再次驗證並印出
6. 跨店同名防彈測試

## API（routes/platforms.js）
已正確使用 req.storeId：
- 查詢判重：WHERE store_id=? AND name=?
- 不使用 WHERE name=?（跨店正確隔離）

## 擴充（server.js）

### GET /api/debug/schema
新增 delivery_platforms 欄位：
```json
{
  "version": "18.1.12",
  "ingredients": { "diagnosis": { "status": "UNIQUE(store_id,name) OK" } },
  "delivery_platforms": { "diagnosis": { "status": "UNIQUE(store_id,name) OK" } }
}
```

## 實測結果

### Migration（三種場景）
- Case1 Fresh DB:                    UNIQUE(store_id,name) OK ✅
- Case2 UNIQUE(name):                重建完成 ✅
- Case3 UNIQUE(name) + 遺留 tmp:     清 tmp → 重建 ✅

### 跨店平台測試
- store_001 Uber Eats 存在（seeded）  ✅
- store_02  新增 Uber Eats → 201      ✅（跨店同名成功）
- store_02  再次新增 Uber Eats → 409  ✅（同店重複正確拒絕）
- store_001 原有 6 個平台不受影響      ✅
- SQL 直接跨店插入                     ✅

### /api/debug/schema
```json
{
  "delivery_platforms": {
    "diagnosis": { "status": "UNIQUE(store_id,name) OK" }
  }
}
```
