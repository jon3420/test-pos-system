# Product Route Order Fix — fix15

## 問題（fix14）

Express.js 路由按**登錄順序**匹配。fix14 的 products.js 中：

```
L79:  router.get('/:id', ...)              ← 先登錄
L242: router.get('/line-products/list', ...) ← 後登錄（永遠不會執行）
```

當 GET /api/products/line-products/list 進來時，Express 先看到 `/:id`，
把 `line-products` 當作 `:id` 參數吸收，`requireFeature('line_order')` 根本不執行。

## 修正（fix15）

正確順序：**所有固定路徑必須在動態路徑 `/:id` 之前登錄。**

```
fix15 routes/products.js 登錄順序：

L65:  router.get('/', ...)                                    ← 列表
L85:  router.get('/line-products/list', requireFeature, ...)  ← 固定路徑 ★
L98:  router.post('/', ...)                                   ← 新增
L129: router.post('/reset-sold-out-today', requireFeature, ...)← 固定路徑 ★
L147: router.get('/:id', ...)                                 ← 動態（在固定路徑之後）
L160: router.put('/:id', ...)
L201: router.delete('/:id', ...)
L213: router.patch('/:id/line-settings', requireFeature, ...) ← sub-path，不受影響
L260: router.patch('/:id/line-status', requireFeature, ...)   ← sub-path，不受影響
```

`PATCH /:id/line-settings` 和 `PATCH /:id/line-status` 不受路由順序問題影響，
因為 `/line-settings` 和 `/line-status` 作為子路徑不會與 `/:id` 衝突。

## 測試驗證（行為測試）

| 請求 | store_002 (line_order=false) | store_001 (line_order=true) |
|------|:---:|:---:|
| GET /api/products/line-products/list | 403 ✅ | 200 ✅ |
| POST /api/products/reset-sold-out-today | 403 ✅ | 200 ✅ |
| PATCH /api/products/:id/line-settings | 403 ✅ | 通過（到達 handler）✅ |
| PATCH /api/products/:id/line-status | 403 ✅ | 通過（到達 handler）✅ |
| GET /api/products（一般列表）| 200 ✅ | 200 ✅ |
| GET /api/products/:id | 404（無資料）✅ | 200 ✅ |

**8/8 全部通過。**

## 防範方法

Express router 設計原則：
1. 精確靜態路徑（如 `/list`、`/reset-sold-out-today`）永遠在動態路徑（`/:id`）之前
2. 子路徑（`/:id/line-settings`）在同 HTTP method 的 `/:id` 後面仍安全（子路徑更精確）
3. 不同 HTTP method 之間不衝突（GET `/:id` 不影響 POST `/reset-sold-out-today`）
