# 選單層級修正 — fix16

## 報表分析
- 位置：主選單（與點餐、訂單、商品同層）
- 按鈕：`<button id="nav-btn-reports" data-page="reports">📊 報表分析</button>`
- Feature Gate：`reports = true` 才顯示（預設 true，Basic 方案也開放）
- `showPage('reports')` → `loadReportsPage()`

## 金流 API
- 位置：設定 → 💳 金流 API Tab（原「金流設定」改名）
- Tab 按鈕 ID：`tab-btn-gateway`，`data-stab="gateway"`
- Feature Gate：`payment_api = false` → `display:none`

## applyFeatureGateUI() 控制
```js
const reportsNav = document.getElementById('nav-btn-reports');
reportsNav.style.display = f.reports !== false ? '' : 'none';

const gatewayBtn = document.getElementById('tab-btn-gateway');
gatewayBtn.style.display = f.payment_api ? '' : 'none';
```
