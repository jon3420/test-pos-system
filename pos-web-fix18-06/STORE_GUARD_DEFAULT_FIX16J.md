# storeGuard 修正 — fix16j

## 問題
storeGuard 的 fallback 是 `store_001`，
但某些請求帶了 `x-store-id: default`（Zeabur 環境某層 proxy 可能注入），
導致 log 顯示 `store_id="default": 店家不存在`。

## 修正（middleware/storeGuard.js）
### 移除所有 fallback
```js
// 舊版（有問題）
if (!candidateId) candidateId = 'store_001';  // ← 移除

// 新版（fix16j）
if (!candidateId) {
  return res.status(401).json({
    success: false, error: 'NO_STORE_TOKEN',
    message: '缺少店家登入 token，請重新登入'
  });
}
```

### x-store-id 過濾 'default'
```js
if (xStoreId && xStoreId.trim() && xStoreId.trim() !== 'default') {
  candidateId = xStoreId.trim();
}
```

### 解析順序
1. Bearer JWT payload.store_id（主要）
2. x-store-id header（排除 'default'）
3. query.store_id（排除 'default'）
4. 無 store_id → HTTP 401 NO_STORE_TOKEN

## 日誌輸出
```
[storeGuard] OK store_id="store_002" (from jwt) GET /api/payment-methods
[storeGuard] 401 NO_STORE_TOKEN: GET /api/payment-methods
```
