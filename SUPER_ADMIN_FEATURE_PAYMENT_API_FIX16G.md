# Super Admin 授權管理 payment_api — fix16g

## 問題
system-admin.html 的 FEATURE_LABELS 缺少 payment_api，
導致授權彈窗看不到「💳 金流 API」選項。

## 修正（public/system-admin.html）
```js
const FEATURE_LABELS = {
  ...
  label_print: '標籤列印',
  payment_api: '💳 金流 API',   // ← fix16g 新增
};

const PLAN_DEFAULTS = {
  basic: { ..., payment_api: false },  // ← fix16g 補上
  pro:   { ..., payment_api: true },   // ← fix16g 補上
};
```

## 效果
Super Admin 授權管理彈窗現在顯示「💳 金流 API」開關。
Pro 方案預設開啟，Basic 方案預設關閉。
修改後店家重新整理 → /api/store-me 回傳新 features → UI 立即同步。
