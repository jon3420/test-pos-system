# Online Orders Gate — fix14

## 問題
/api/online-orders 屬於 LINE 點餐訂單管理，line_order=false 時應 403。

## 修正
server.js：
```js
// fix13
app.use('/api/online-orders', requireStore, require('./routes/online-orders'));
// fix14
app.use('/api/online-orders', requireStore, requireFeature('line_order'), require('./routes/online-orders'));
```

包含所有 online-orders 子路徑：
- GET /api/online-orders（查詢 LINE 訂單列表）
- PATCH /api/online-orders/:id/status（接單 / 拒單 / 完成）
- GET /api/online-orders/:id/status（查詢訂單狀態）

## /api/admin/status 移除
移除理由：使用 ADMIN_MODE 環境變數判斷權限，已被 requireSuperAdmin 取代。
一般店家不應可查詢 ADMIN_MODE 狀態。
