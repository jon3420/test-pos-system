# 付款方式結帳控制 — fix16k

## payment_methods=false 時
- 設定 Tab「付款方式」隱藏
- GET /api/payment-methods → 403 FEATURE_DISABLED
- loadPaymentMethods() 直接 return，allPaymentMethods=[]
- renderPaymentMethods() 顯示：⚠️ 付款方式功能未啟用，請聯絡系統管理員
- 結帳付款按鈕區空白，無法選擇付款方式

## payment_methods=true（預設）時
- 設定 Tab「付款方式」顯示
- GET /api/payment-methods → 200（自動補齊 6 筆）
- 點餐頁顯示現金/已啟用的付款方式
- 結帳正常

## 測試結果
| 情境 | 結果 |
|------|:----:|
| store_002 Basic payment_methods=true → 200 6筆 | ✅ |
| store_001 Pro → 200 6筆 | ✅ |
| store_003 payment_methods=false → 403 FEATURE_DISABLED | ✅ |
| No token → 401 NO_STORE_TOKEN | ✅ |
| license.js Basic payment_methods=true | ✅ |
| license.js Pro payment_methods=true | ✅ |
