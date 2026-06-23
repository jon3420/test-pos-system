# 方案同步 — fix16

## 問題
`stores.plan` 與 `licenses.plan` 不同步，修改授權後店家管理頁可能顯示舊方案。

## 修正：licenses.plan 為唯一來源

### GET /api/super-admin/stores
回傳時用 `licenses.plan` 覆蓋 `stores.plan`：
```js
const effectivePlan = license ? license.plan : (s.plan || 'basic');
return { ...s, plan: effectivePlan, ... };
```

### PUT /api/super-admin/stores/:storeId
更新 licenses 後同步寫回 stores：
```js
db.run("UPDATE stores SET plan=? WHERE store_id=?", [newPlan, storeId]);
```

### PUT /api/super-admin/stores/:storeId/license
同上，確保 stores.plan = licenses.plan。

### Dashboard 統計
計畫數改從 `licenses` 表讀取：
```sql
SELECT COUNT(*) FROM licenses WHERE plan='basic' AND active=1
```

## 結果
修改授權方案後，店家管理頁立即顯示新方案，不需重新整理。
