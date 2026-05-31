# Feature Gate — fix14 完整清單

## 後端 API Feature Gate 完整對應

| API | Feature | 保護方式 |
|-----|---------|---------|
| GET /api/inventory/* | inventory | requireFeature (server.js) |
| GET /api/ingredients/* | inventory | requireFeature (server.js) |
| GET/POST /api/platforms/* | delivery | requireFeature (server.js) |
| GET/PUT /api/payment-gateways/* | payment_api | requireFeature (server.js) |
| GET /api/line-shop | line_order | requireFeature (server.js) |
| GET /api/line-menu | line_order | requireFeature (server.js) |
| ALL /api/line-orders/* | line_order | requireFeature (server.js) |
| ALL /api/online-orders/* | line_order | requireFeature (server.js) ← fix14新增 |
| PATCH /api/products/:id/line-settings | line_order | requireFeature (products.js) ← fix14新增 |
| PATCH /api/products/:id/line-status | line_order | requireFeature (products.js) ← fix14新增 |
| GET /api/products/line-products/list | line_order | requireFeature (products.js) ← fix14新增 |
| POST /api/products/reset-sold-out-today | line_order | requireFeature (products.js) ← fix14新增 |
| PUT /api/settings（LINE keys）| line_order | 內嵌檢查 (settings.js) ← fix14新增 |
| GET /api/license | Super Admin | requireSuperAdmin |
| POST/PUT/DELETE /api/license/* | Super Admin | requireSuperAdmin |
| GET /api/admin/status | 已移除 | ← fix14移除 |
