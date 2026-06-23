# Feature Gate 403 不登出 — fix16b

## apiFetch 行為
| HTTP Status | 行為 |
|-------------|------|
| 401 | clearToken() + showLoginOverlay()（唯一登出點）|
| 403 FEATURE_DISABLED | showToast('此功能未授權...') 不登出 |
| 403 LICENSE_INACTIVE | showToast('授權已停用...') 不登出 |
| 403 其他 | showToast(body.message) 不登出 |

## ensureLogin 行為
| HTTP Status from /api/store-me | 行為 |
|---|---|
| 200 | 允許進入 POS，載入 currentStore |
| 401 | clearToken() + showLoginOverlay() |
| 403 | 不登出（讓後續 API 各自處理）|
