# 付款方式與金流 API 分離 — fix16c-hotfix

## 問題
`applyFeatureGateUI()` 中未明確保護付款方式 Tab，
雖然未設 feature gate，但 `payment_api=false` 隱藏了 `tab-btn-gateway`
而 `tab-btn-payment` 未被設定，若其他代碼意外動到則可能消失。

## 修正
```js
// fix16c-hotfix: 付款方式 Tab 永遠顯示（Basic 基本功能）
const paymentTabBtn = document.querySelector('button[data-stab="payment"]');
if (paymentTabBtn) paymentTabBtn.style.display = '';  // 強制顯示

// 金流 API Tab — Pro/Premium 才可見
const gatewayBtn = document.getElementById('tab-btn-gateway');
if (gatewayBtn) gatewayBtn.style.display = f.payment_api ? '' : 'none';
```

## 功能對照
| 功能 | Feature Key | Basic | Pro |
|------|------------|:-----:|:---:|
| 設定 → 付款方式 | 無（基礎功能）| ✅ | ✅ |
| 設定 → 💳 金流 API | payment_api | ❌ | ✅ |
