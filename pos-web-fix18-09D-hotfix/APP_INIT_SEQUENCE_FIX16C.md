# App 初始化順序 — fix16c-hotfix

## 正確順序
```
1. ensureLogin()          → 驗證 token，呼叫 /api/store-me
2. loadCurrentStore()     → 取得 currentStore + currentFeatures
3. applyFeatureGateUI()   → 依授權隱藏 UI 元素
4. loadSettings()         → 基礎設定（無 feature gate）
5. loadCategories()       → 分類（無 feature gate）
6. loadPaymentMethods()   → 付款方式（無 feature gate）
7. loadProducts()         → 商品（不依賴 inventory）
8. loadPlatforms()        → 外送平台（需 delivery feature）
```

## 關鍵修正
- `loadProducts()` 不再與 `/api/inventory` 並行，避免 403 中斷
- 非必要 feature API 各自容錯，不阻斷商品/分類載入
- Pro 首次登入商品正常顯示（不需重新登入）
