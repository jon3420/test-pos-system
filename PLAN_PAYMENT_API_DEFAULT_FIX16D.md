# Plan payment_api Default — fix16d

## 修正位置
| 檔案 | 修正 |
|------|------|
| routes/superAdmin.js（POST /stores PLAN_DEFAULTS）| payment_api: basic=false, pro=true |
| routes/superAdmin.js（PUT /license PLAN_DEFAULTS）| payment_api: basic=false, pro=true |
| routes/license.js PLAN_DEFAULTS | 已正確（fix16c）|
| utils/db.js PRO_FEATURES | payment_api: true |

## Basic / Pro 對照
| Feature | Basic | Pro |
|---------|:-----:|:---:|
| pos / orders / products / reports / print | ✅ | ✅ |
| inventory / line_order / delivery | ❌ | ✅ |
| payment_api | ❌ | ✅ |
| label_print | ❌ | ✅ |
