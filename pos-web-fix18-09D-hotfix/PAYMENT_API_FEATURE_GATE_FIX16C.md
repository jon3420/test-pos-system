# 金流 API Feature Gate — fix16c-hotfix

| 操作 | Basic (payment_api=false) | Pro (payment_api=true) |
|------|:---:|:---:|
| 設定 → 💳 金流 API Tab 可見 | ❌ | ✅ |
| GET /api/payment-gateways | 403 | 200 |
| PUT /api/payment-gateways/:id | 403 | 200 |
| loadGatewayCards() | 顯示「未授權」提示 | 顯示 8 張卡片 |

Pro 方案 PLAN_DEFAULTS 已修正為 `payment_api: true`。
