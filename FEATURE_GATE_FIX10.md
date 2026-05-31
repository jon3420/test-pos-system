# Feature Gate — fix10
## middleware/featureGate.js
`requireFeature(featureKey)` — Express middleware，查 licenses 表驗證 feature 是否啟用。
- 未啟用 → HTTP 403 `{ error: "FEATURE_DISABLED", feature, message }`
- 30 秒 in-memory 快取
- Super Admin 更新授權後呼叫 `invalidateFeatureCache(storeId)` 立即清除

## API 已加 requireFeature
| API 路由 | Feature Key |
|---------|------------|
| `/api/inventory/*` | inventory |
| `/api/ingredients/*` | inventory |
| `/api/export/product-inventory` | inventory |
| `/api/export/ingredients` | inventory |
| `/api/export/ingredient-formulas` | inventory |
| `/api/import/product-inventory` | inventory |
| `/api/import/ingredients` | inventory |
| `/api/import/ingredient-formulas` | inventory |
| `/api/platforms/*` | delivery |
| `/api/payment-gateways/*` | payment_api |
| `/api/line-shop` | line_order |
| `/api/line-menu` | line_order |
| `/api/line-orders/*` | line_order |
