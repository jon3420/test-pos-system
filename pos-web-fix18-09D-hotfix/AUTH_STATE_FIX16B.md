# Auth 狀態說明 — fix16b

## Token 儲存位置
localStorage: `pos_store_token`、`pos_store_info`

## 無痕模式
localStorage 為空 → ensureLogin() → !getToken() → showLoginOverlay()

## localStorage.clear() + reload
同上，強制顯示登入視窗。

## window.currentStore
由 ensureLogin() 或 loadCurrentStore() 呼叫 /api/store-me 後填入。
頁面重載時 ensureLogin() 會重新驗證並填入，不依賴 localStorage 快取。
