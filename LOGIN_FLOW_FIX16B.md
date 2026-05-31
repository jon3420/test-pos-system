# 登入流程修正 — fix16b

## ensureLogin() 修正
舊版用 `/api/health` 驗證（不帶 store_id），無法確認 store 是否仍有效。

fix16b 改用 `/api/store-me`：
- 200 → 寫入 window.currentStore / currentFeatures，呼叫 applyFeatureGateUI + updateTopbarStoreInfo
- 401 → clearToken() + showLoginOverlay()（唯一登出點）
- 403 → 不登出，讓後續 API 的 apiFetch 各自處理

## posLogout() 修正
```js
localStorage.removeItem('pos_store_token');
localStorage.removeItem('pos_store_info');
sessionStorage.clear();
window.currentStore = null;
window.currentFeatures = {};
location.reload(); // 完整刷新，確保 UI 狀態清除
```

## 右上角店家資訊
`updateTopbarStoreInfo()` 填入 `#topbar-store-info`，顯示店名、Store ID、方案徽章。
登出按鈕（🚪 登出）呼叫 posLogout()，hover 時顯示紅色警示。
