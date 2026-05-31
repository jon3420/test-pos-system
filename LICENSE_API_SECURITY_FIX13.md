# License API 安全修正 — fix13

## 路由保護對應

| 路由 | fix12 前 | fix13 |
|------|---------|-------|
| GET /api/license | 完全公開 | ✅ requireSuperAdmin |
| GET /api/license/plans/defaults | 公開 | ✅ 保持公開（Android 用）|
| GET /api/license/:storeId | 公開（Android）| ✅ 保持公開（Android 相容）|
| POST /api/license | requireAdminMode | ✅ requireSuperAdmin |
| PUT /api/license/:storeId | requireAdminMode | ✅ requireSuperAdmin |
| DELETE /api/license/:storeId | requireAdminMode | ✅ requireSuperAdmin |

## 移除 ADMIN_MODE
- `require('../middleware/adminGuard')` 已從 license.js 移除
- 不再依賴環境變數 `ADMIN_MODE=true`
- 所有管理操作均需有效的 Super Admin JWT（`role: 'super_admin'`）

## 一般店家 JWT 呼叫管理 API 的回應
```json
{ "success": false, "message": "需要 Super Admin 權限" }  // HTTP 403
```
