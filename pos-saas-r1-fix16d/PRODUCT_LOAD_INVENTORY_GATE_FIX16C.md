# 商品載入不依賴 inventory — fix16c-hotfix

## 問題
`loadProducts()` 並行呼叫 `/api/inventory`，
`inventory=false` 時 apiFetch 收到 403 → showToast 彈出錯誤提示。

## 修正
```js
async function loadProducts() {
  // 商品列表：不受 inventory feature gate 影響
  const prodRes = await apiFetch('/api/products?enabled=1');

  // 庫存：僅在 inventory=true 時呼叫，且用 fetch 不用 apiFetch（避免 toast）
  const invMap = {};
  if (hasFeature('inventory')) {
    const invRes = await fetch('/api/inventory', { headers: { Authorization: ... } });
    if (invRes.ok) { /* 建立 invMap */ }
  }
  // inventory=false 時 invMap 為空，商品卡片正常顯示，只是不顯示庫存數量
}
```

`refreshInventoryForProducts()` 同樣修正：`!hasFeature('inventory')` 時 return。
