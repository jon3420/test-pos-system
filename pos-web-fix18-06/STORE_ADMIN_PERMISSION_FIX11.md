# Store Admin Permission — fix11
## 移除一般店家後台的「店家授權」
- index.html：完全移除 `data-stab="license"` 按鈕
- index.html：移除 `id="stab-license"` Panel
- license.js：清空為僅含 `showNotAuthorized()` 共用函式
- 授權管理只存在於 `/system-admin`（system-admin.html）

## 授權 API 限制 Super Admin Only
- 所有 `/api/super-admin/*` 均由 `requireSuperAdmin` middleware 保護
- 一般店家 JWT 呼叫 → HTTP 403
- 不可用 ADMIN_MODE / store_id / query 參數作為安全依據
