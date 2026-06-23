# Payment Method Auth Header — fix16j

## 前端已正確使用 apiFetch
`loadPaymentMethods()` 和 `loadPaymentMethodsPage()` 都已使用：
```js
const res = await apiFetch('/api/payment-methods');
```
`apiFetch` 自動帶 `Authorization: Bearer ${token}`。

## 後端嚴格驗證 storeId
```js
const storeId = req.storeId;  // 由 requireStore 注入
if (!storeId || storeId === 'default') {
  return res.status(401).json({ error: 'NO_STORE_TOKEN' });
}
```

## 403 / 500 → 「重新登入」提示
前端 apiFetch 403 handler：
- `PAYMENT_METHOD_SEED_FAILED` → showToast('店家授權異常，請重新登入')
- store 不存在/停用 → showToast('店家授權異常，請重新登入')

## 測試結果
| 場景 | 結果 |
|------|:----:|
| 無 token → 401 NO_STORE_TOKEN | ✅ |
| x-store-id=default → 401 | ✅ |
| 有效 JWT store_002 → 200, 6筆 | ✅ |
| 第2次呼叫不重複 → 6筆 | ✅ |
| x-store-id=store_001 → 200 | ✅ |
| 無效 JWT → 401 | ✅ |
| DB 筆數 === 6 | ✅ |
