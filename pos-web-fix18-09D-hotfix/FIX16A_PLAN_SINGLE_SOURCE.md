# 方案單一來源 — fix16a

## 設計原則
`licenses.plan` 為唯一方案來源。`stores.plan` 欄位保留但不作為顯示或邏輯依據。

## 修正點（routes/superAdmin.js）

### PUT /api/super-admin/stores/:storeId（更新店家基本資料）
```js
// fix16a: stores 只更新基本資訊，不寫 plan
db.run(`UPDATE stores SET store_name=?, contact_name=?, phone=?, active=?, ... WHERE store_id=?`, [...]);

// 方案只寫 licenses
if (plan !== undefined || active !== undefined) {
  const curLic = db.get('SELECT plan FROM licenses WHERE store_id=?', [storeId]);
  const newPlan = plan ?? curLic?.plan ?? 'basic';
  db.run(`UPDATE licenses SET plan=?, active=?, ... WHERE store_id=?`, [newPlan, ...]);
}
```

### PUT /api/super-admin/stores/:storeId/license（更新授權）
```js
// 不再執行：UPDATE stores SET plan=? WHERE store_id=?
// 只寫 licenses：
db.run(`UPDATE licenses SET plan=?,active=?,features=?,... WHERE store_id=?`, [newLicPlan, ...]);
```

### GET /api/super-admin/stores（取得店家列表）
```js
// effectivePlan 優先讀 licenses
const effectivePlan = license ? license.plan : (s.plan || 'basic');
return { ...s, plan: effectivePlan };   // 覆蓋 stores.plan 顯示值
```

## 驗證
修改授權方案後，`stores.plan` 欄位不會被更新，
但前端透過 GET /stores 取得的 `plan` 欄位永遠來自 `licenses.plan`。

```sql
-- 查詢兩表確認
SELECT s.store_id, s.plan AS stores_plan, l.plan AS licenses_plan
FROM stores s LEFT JOIN licenses l ON l.store_id=s.store_id;
-- stores_plan 可能不同步，licenses_plan 為準確值
```
