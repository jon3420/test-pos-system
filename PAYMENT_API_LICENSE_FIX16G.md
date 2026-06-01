# 金流 API 授權 — fix16g

## Feature Key: payment_api
| 方案 | payment_api | 效果 |
|------|:-----------:|------|
| Basic | false | 設定 → 金流 API 不顯示；/api/payment-gateways → 403 |
| Pro | true | 設定 → 💳 金流 API 顯示；/api/payment-gateways → 200 |

## PLAN_DEFAULTS（已同步所有位置）
- utils/db.js PRO_FEATURES
- routes/superAdmin.js（2處）
- routes/license.js
- middleware/featureGate.js fallback
- public/system-admin.html（fix16g 新增）

## 行為測試
- store_001 Pro → GET /payment-gateways → 200（8筆） ✅
- store_002 Basic → GET /payment-gateways → 403 ✅
- store_001 Pro → PUT /payment-gateways/linepay → 200 ✅
- store_002 Basic → PUT /payment-gateways/linepay → 403 ✅
