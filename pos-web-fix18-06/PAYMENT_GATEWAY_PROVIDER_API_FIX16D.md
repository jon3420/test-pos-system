# Payment Gateway Provider API — fix16d

## 路由變更
| 舊版（fix2，使用 :id）| 新版（fix16d，使用 :provider）|
|---|---|
| GET /api/payment-gateways | ✅ 保留 |
| GET /api/payment-gateways/:id | → GET /api/payment-gateways/:provider |
| PUT /api/payment-gateways/:id | → PUT /api/payment-gateways/:provider |
| POST /api/payment-gateways/:id/test | → POST /api/payment-gateways/:provider/test |

## Provider Codes
`linepay ecpay newebpay jkopay pxpay applepay googlepay creditcard_terminal`

## PUT 邏輯（upsert）
存在 → UPDATE；不存在 → INSERT（新店家自動建立）。
API Key / Secret Key 以 `••••` 開頭表示不更新。

## 前端對應
`saveGateway(code)` → PUT /api/payment-gateways/{code}
`testGateway(code)` → POST /api/payment-gateways/{code}/test
不再傳 existingId。

## 10/10 行為測試通過
