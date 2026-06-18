# 付款方式 ≠ 金流 API — fix16g

## 明確分離
| 功能 | Feature Key | 路由 | Basic | Pro |
|------|------------|------|:-----:|:---:|
| 設定 → 付款方式 | 無（基礎）| /api/payment-methods | ✅ | ✅ |
| 設定 → 💳 金流 API | payment_api | /api/payment-gateways | ❌ 403 | ✅ |

## applyFeatureGateUI()
```js
// 付款方式 Tab 永遠顯示
const paymentTabBtn = document.querySelector('button[data-stab="payment"]');
if (paymentTabBtn) paymentTabBtn.style.display = '';

// 金流 API Tab — payment_api=true 才顯示
const gatewayBtn = document.getElementById('tab-btn-gateway');
if (gatewayBtn) gatewayBtn.style.display = f.payment_api ? '' : 'none';
```

## 點餐結帳
checkout() 從 /api/payment-methods 取得付款選項，
完全不依賴 payment_api，Basic 現金結帳正常。
