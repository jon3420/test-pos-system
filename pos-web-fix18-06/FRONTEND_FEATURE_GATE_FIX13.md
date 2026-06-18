# 前端 Feature Gate — fix13

## 資料載入流程
```
DOMContentLoaded
  → ensureLogin()           ← JWT 驗證
  → loadCurrentStore()      ← GET /api/store-me
      → window.currentStore = { store_id, store_name, plan, active, features }
      → window.currentFeatures = features
      → applyFeatureGateUI()  ← 隱藏未授權 UI
  → loadSettings() / loadProducts() / ...
```

## applyFeatureGateUI() 控制項目
| UI 元素 | Feature Key | 控制方式 |
|---------|------------|---------|
| 導覽列「庫存」按鈕 | inventory | display:none |
| 設定 Tab「LINE 營業」| line_order | display:none |
| 設定 Tab「LINE 點餐入口」| 永遠顯示 | — |
| 設定 Tab「外送平台」| delivery | display:none |
| 設定 Tab「金流設定」| payment_api | display:none |
| 訂單頁「外送報表」Tab | delivery | display:none |
| 點餐頁外送模式按鈕 | delivery | display:none |
| 商品列表「LINE 設定」按鈕 | line_order | 模板條件渲染 |

## hasFeature(key) 使用方式
```js
if (hasFeature('inventory')) { /* 有庫存功能 */ }
if (hasFeature('line_order')) { /* 有 LINE 點餐功能 */ }
```

## featureGate.js active 判斷（fix13 新增）
- `licenses.active=0` → HTTP 403 `{ error: "LICENSE_INACTIVE" }`
- `feature=false` → HTTP 403 `{ error: "FEATURE_DISABLED" }`
