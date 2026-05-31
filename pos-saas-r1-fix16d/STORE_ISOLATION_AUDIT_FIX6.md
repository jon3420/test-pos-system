# Store Isolation Audit — R1 fix6
審計日期：2026-05-30
版本：pos-saas-foundation-r1-fix6

---

## fix6 修正項目

| 項目 | fix5 | fix6 |
|------|:----:|:----:|
| WebSocket 連線驗證 store_id | ❌ 無 | ✅ token/query 解析 + stores 表驗證 |
| ws 物件綁定 storeId | ❌ 無 | ✅ `ws.storeId = resolvedStoreId` |
| 前端帶 token 連線 | ❌ 無 | ✅ `/orders?token=<JWT>` |
| broadcastToStore 共用函式 | ❌ 無 | ✅ 新增 `utils/wssBroadcast.js` |
| line-orders.js broadcast 隔離 | ❌ 全送 | ✅ 只送同 store |
| online-orders.js broadcast 隔離 | ❌ 全送 | ✅ 只送同 store |
| settings.js broadcast 隔離 | ❌ 全送 | ✅ 只送同 store |
| ingredients.js broadcast 隔離 | ❌ 全送 | ✅ 只送同 store |

---

## 完整隔離狀態（fix6 後）

### HTTP API

| 路由 / 模組 | 狀態 | 達成版本 |
|------------|:----:|---------|
| middleware/storeGuard.js | ✅ | fix4 |
| routes/storeLogin.js | ✅ | fix5 |
| routes/superAdmin.js（含 set-password）| ✅ | fix5 |
| services/printService.js | ✅ | fix4 |
| routes/print.js | ✅ | fix3 |
| routes/orders.js | ✅ | fix2 |
| routes/products.js | ✅ | R1 |
| routes/categories.js | ✅ | R1 |
| routes/settings.js | ✅ | R1 |
| routes/customers.js | ✅ | fix1 |
| routes/kitchen.js | ✅ | fix1 |
| routes/online-orders.js | ✅ | fix1 |
| routes/sync.js | ✅ | fix1 |
| routes/ingredients.js | ✅ | fix1 |
| routes/importExport.js | ✅ | fix1 |
| routes/line-orders.js | ✅ | fix1 |
| routes/inventory.js | ✅ | fix1 |
| routes/payment-methods.js | ✅ | fix2 |
| routes/payment-gateways.js | ✅ | fix2 |
| routes/platforms.js | ✅ | fix2 |
| routes/printJobs.js | ✅ | fix2 |
| utils/inventoryHelper.js | ✅ | fix2 |
| routes/license.js | ✅ N/A（Android 相容）| — |

### 前端

| 項目 | 狀態 | 達成版本 |
|------|:----:|---------|
| public/js/app.js（apiFetch 83 個呼叫）| ✅ | fix4/fix5 |
| public/line-order.html（?store_id= URL）| ✅ | fix4 |

### WebSocket

| 項目 | 狀態 | 達成版本 |
|------|:----:|---------|
| server.js 連線驗證 + ws.storeId 綁定 | ✅ | fix6 |
| app.js 帶 token 連線 | ✅ | fix6 |
| utils/wssBroadcast.js broadcastToStore | ✅ | fix6 |
| line-orders.js 廣播隔離 | ✅ | fix6 |
| online-orders.js 廣播隔離 | ✅ | fix6 |
| settings.js 廣播隔離 | ✅ | fix6 |
| ingredients.js 廣播隔離 | ✅ | fix6 |

---

## 殘留的 wss.clients.forEach（合法）

```
server.js L94：setInterval ping keepalive
```

ping 為協議層心跳，發給所有連線屬正確行為，與業務資料完全無關。

---

## 結論

fix6 完成後，HTTP API 與 WebSocket 兩個通道的多店資料隔離均已達到：

- **HTTP**：所有 DB 查詢帶 `WHERE store_id=?`，`requireStore` 驗證 stores 表
- **WebSocket**：連線時驗證 token/store_id，`ws.storeId` 綁定，broadcast 過濾同店

A 店的任何事件（新訂單、狀態更新、設定變更、食材更新）
在 fix6 後不會傳送到 B 店的 WebSocket 連線。
