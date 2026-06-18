# Product LINE Gate — fix14

## 新增保護的端點
- PATCH /api/products/:id/line-settings → requireFeature('line_order')
- PATCH /api/products/:id/line-status → requireFeature('line_order')
- GET /api/products/line-products/list → requireFeature('line_order')
- POST /api/products/reset-sold-out-today → requireFeature('line_order')

## 實作方式
products.js 頂部新增：
```js
const { requireFeature } = require('../middleware/featureGate');
```
各端點改為：
```js
router.patch('/:id/line-settings', requireFeature('line_order'), (req, res) => {
```
