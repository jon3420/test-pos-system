# payment_methods 授權控制 — fix16k

## 後端 Feature Gate
```js
// server.js
app.use('/api/payment-methods',
  requireStore,
  requireFeature('payment_methods'),  // ← fix16k 新增
  require('./routes/payment-methods')
);
```

payment_methods=false → HTTP 403 FEATURE_DISABLED

## 前端 UI Gate
```js
// applyFeatureGateUI()
const paymentTabBtn = document.querySelector('button[data-stab="payment"]');
paymentTabBtn.style.display = f.payment_methods !== false ? '' : 'none';
```

## Super Admin 授權彈窗
system-admin.html FEATURE_LABELS 已加入：
```js
payment_methods: '💳 付款方式'
```
可在授權管理對任意店家開關。
