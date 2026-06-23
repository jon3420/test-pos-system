# Feature Gate 403 不登出 — fix16

## 問題
apiFetch 對 401 和 403 統一 clearToken() + showLoginOverlay()，
導致 FEATURE_DISABLED / LICENSE_INACTIVE 被誤判為「未登入」，強制登出。

## 修正：public/js/app.js apiFetch()

```js
if (res.status === 401) {
  // token 過期 → 登出
  clearToken(); showLoginOverlay();
  return { ok: false, status: 401, body };
}

if (res.status === 403) {
  const body = await res.json();
  if (body.error === 'FEATURE_DISABLED')
    showToast('此功能未授權，請聯絡系統管理員升級方案', 'error');
  else if (body.error === 'LICENSE_INACTIVE')
    showToast('店家授權已停用，請聯絡系統管理員', 'error');
  else
    showToast(body.message || '存取被拒絕', 'error');
  // 不登出，保持登入狀態
  return { ok: false, status: 403, body };
}
```

## 測試結果
- 401（token 過期）→ 登出 ✅
- 403 FEATURE_DISABLED → showToast，保持登入 ✅
- 403 LICENSE_INACTIVE → showToast，保持登入 ✅
- 403 其他（storeGuard 拒絕）→ showToast，保持登入 ✅
