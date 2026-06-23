# GET /api/store-me — 使用說明
## 說明
回傳目前登入店家的基本資訊與授權功能清單。
由 requireStore middleware 保護，store_id 來自 JWT，不可偽造。

## 回傳
```json
{
  "success": true,
  "data": {
    "store_id": "store_001",
    "store_name": "脆豬腰",
    "plan": "pro",
    "active": true,
    "features": {
      "pos": true, "orders": true, "products": true, "reports": true,
      "print": true, "inventory": true, "line_order": true, "delivery": true,
      "marketing": false, "member": false, "coupon": false,
      "label_print": true, "payment_api": true
    }
  }
}
```

## 前端使用
```js
window.currentStore    // 店家資訊
window.currentFeatures // 功能開關
hasFeature('inventory') // true/false
```
呼叫時機：登入成功後、DOMContentLoaded。
