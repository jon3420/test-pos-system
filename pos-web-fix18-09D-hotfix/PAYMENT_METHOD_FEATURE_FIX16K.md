# payment_methods Feature Key — fix16k

## 新增 Feature Key
| Key | 顯示名稱 | 用途 |
|-----|---------|------|
| payment_methods | 💳 付款方式 | 控制付款方式功能（設定頁 + API + 結帳） |
| payment_api | 💳 金流 API | 控制第三方金流串接設定 |

## PLAN_DEFAULTS（所有位置同步）
| 方案 | payment_methods | payment_api |
|------|:--------------:|:-----------:|
| Basic | **true** | false |
| Pro | **true** | true |
| Enterprise | **true** | true |

所有方案預設 payment_methods=true（POS 基礎功能）。

## 修改檔案
- routes/superAdmin.js（兩處 PLAN_DEFAULTS）
- routes/license.js（三個方案）
- middleware/featureGate.js（fallback features）
- utils/db.js（PRO_FEATURES）
- public/system-admin.html（PLAN_DEFAULTS + FEATURE_LABELS）
- server.js（requireFeature mount）
- public/js/app.js（UI gate）
