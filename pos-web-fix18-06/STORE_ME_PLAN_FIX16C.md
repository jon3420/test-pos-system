# /api/store-me Plan 修正 — fix16c

## 問題
GET /api/store-me 的 SQL：
```sql
-- ❌ fix16b（錯誤）
SELECT store_id, store_name, plan, active FROM stores WHERE store_id=?
-- 使用 stores.plan，但 stores.plan 可能是過期值
```

## 修正
```sql
-- ✅ fix16c
SELECT s.store_id, s.store_name, s.active,
       COALESCE(l.plan, 'basic') AS plan
FROM stores s
LEFT JOIN licenses l ON l.store_id = s.store_id
WHERE s.store_id = ?
-- plan 來自 licenses.plan，stores.plan 完全不再讀取
```

## 影響範圍

| 顯示位置 | 資料來源 | fix16c 後 |
|---------|---------|-----------|
| 右上角方案徽章 | window.currentStore.plan | ✅ licenses.plan |
| LINE 點餐入口方案顯示 | window.currentStore.plan | ✅ licenses.plan |
| /api/store-me 回傳 | row.plan | ✅ licenses.plan |

## 同步流程

Super Admin 修改授權方案（PUT /api/super-admin/stores/:id/license）
→ UPDATE licenses SET plan=?（fix16a：唯一寫入點）
→ invalidateFeatureCache(storeId)（快取清除）

POS 重新整理
→ ensureLogin() → GET /api/store-me
→ JOIN licenses → 取得新方案
→ updateTopbarStoreInfo() → 右上角立即顯示新方案

## 測試驗證

```
stores.plan  (故意設為 basic):  basic
JOIN result  (licenses.plan):   pro
✅ JOIN 正確回傳 licenses.plan
```

stores.plan = basic，licenses.plan = pro，/api/store-me 回傳 plan=pro，確認 stores.plan 不再影響結果。
