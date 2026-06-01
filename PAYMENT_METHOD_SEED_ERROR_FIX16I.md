# Payment Method Seed 錯誤處理 — fix16i

## 不靜默吃錯誤
```
[payment-methods] seed failed: store=xxx code=cash err=...
[payment-methods] PRAGMA table_info failed: ...
[payment-methods] UNIQUE INDEX failed: ...
[payment-methods] PAYMENT_METHOD_SEED_FAILED: store=xxx
```

## 0 筆時回傳 500
```json
{ "success": false, "error": "PAYMENT_METHOD_SEED_FAILED",
  "message": "付款方式初始化失敗（store: store_002），請聯絡系統管理員" }
```
