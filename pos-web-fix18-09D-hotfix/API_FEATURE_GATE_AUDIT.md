# API Feature Gate Audit
| API | Feature | 狀態 |
|-----|---------|------|
| GET/POST/PUT /api/inventory/* | inventory | ✅ requireFeature |
| GET/POST/PUT /api/ingredients/* | inventory | ✅ requireFeature |
| GET/POST/PUT /api/platforms/* | delivery | ✅ requireFeature |
| GET/PUT /api/payment-gateways/* | payment_api | ✅ requireFeature |
| GET /api/line-shop | line_order | ✅ requireFeature |
| GET /api/line-menu | line_order | ✅ requireFeature |
| POST/GET /api/line-orders/* | line_order | ✅ requireFeature |
| GET/POST /api/export/product-inventory | inventory | ✅ requireFeature |
| GET/POST /api/export/ingredients | inventory | ✅ requireFeature |
| GET/POST /api/import/* (inventory) | inventory | ✅ requireFeature |
| GET /api/store-me | 無 (store info) | ✅ requireStore only |
| All /api/super-admin/* | Super Admin JWT | ✅ requireSuperAdmin |
