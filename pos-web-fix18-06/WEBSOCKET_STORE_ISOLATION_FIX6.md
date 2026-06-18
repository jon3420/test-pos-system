# WebSocket Store Isolation — fix6
版本：pos-saas-foundation-r1-fix6
日期：2026-05-30

---

## 問題說明

fix5 前，所有 WebSocket 連線共用同一個 `wss` 實例，
`wss.clients` 包含所有店家的連線，broadcast 時一律全送：

```js
// ❌ fix5 以前（跨店外洩）
wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
// → A 店的 new_line_order 會送到 B 店的 POS 後台
```

---

## fix6 修正架構

```
WebSocket 連線建立
  └─ /orders?token=<JWT>       ← app.js 帶 token（優先）
  └─ /orders?store_id=xxx      ← Android / LINE 相容
  └─ /orders                   ← 向後相容（預設 store_001）
         ↓
  server.js onConnection
    1. 解析 token → jwt.verify → store_id
    2. 或讀 ?store_id query param
    3. 查 stores 表：存在 + active=1
    4. ✅ ws.storeId = store_id   ← 綁定
    5. ❌ invalid → ws.close(4001)
         ↓
  業務事件觸發
    broadcastToStore(wss, storeId, payload)
      └─ wss.clients.forEach
           └─ if client.storeId === storeId → send  ✅
           └─ if client.storeId !== storeId → skip  🚫
```

---

## 一、WebSocket 連線驗證（server.js）

```js
wss.on('connection', (ws, req) => {
  // 解析 token 或 store_id
  const qs       = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
  const token    = qs.get('token')    || '';
  const qStoreId = qs.get('store_id') || '';

  let resolvedStoreId = null;

  // 1. JWT token（最高優先）
  if (token) {
    const payload     = jwt.verify(token, JWT_SECRET);
    resolvedStoreId = payload.store_id;
  }
  // 2. query store_id
  if (!resolvedStoreId && qStoreId) resolvedStoreId = qStoreId;
  // 3. 預設 store_001
  if (!resolvedStoreId) resolvedStoreId = 'store_001';

  // 4. 驗證 stores 表
  const store = db.get('SELECT store_id, active FROM stores WHERE store_id=?', [resolvedStoreId]);
  if (!store || store.active !== 1) {
    ws.close(4001, `店家 ${resolvedStoreId} 不存在或已停用`);
    return;
  }

  // 5. 綁定
  ws.storeId = resolvedStoreId;
});
```

---

## 二、前端帶 token 連線（app.js）

```js
// ❌ fix5
const url = proto + '//' + location.host + '/orders';

// ✅ fix6
const token = getToken();  // localStorage JWT
const url   = proto + '//' + location.host + '/orders'
  + (token ? '?token=' + encodeURIComponent(token) : '');
```

token 過期或 store 停用時，server 回傳 close(4001)，
前端 `onclose` 觸發指數退避重連（已有的邏輯）。

---

## 三、共用 broadcastToStore（utils/wssBroadcast.js）

```js
function broadcastToStore(wss, storeId, payload) {
  if (!wss || !storeId) return;
  const msg = JSON.stringify({ ...payload, store_id: storeId });
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.storeId === storeId) {
      client.send(msg);  // ✅ 只發給同 storeId
    }
  });
}
```

---

## 四、各檔案修正

| 檔案 | 舊寫法 | fix6 |
|------|--------|------|
| `server.js` | 無驗證，ws 無 storeId | token/store_id 解析 + stores 驗證 + ws.storeId 綁定 |
| `public/js/app.js` | `new WebSocket('/orders')` | `new WebSocket('/orders?token=...')` |
| `routes/line-orders.js` | `broadcastNewOrder`→全送 | `broadcastToStore(wss, storeId, ...)` |
| `routes/line-orders.js` | PATCH status 全送 | `broadcastToStore(wss, storeId, ...)` |
| `routes/online-orders.js` | PATCH status 全送 | `broadcastToStore(wss, storeId, ...)` |
| `routes/settings.js` | settings_updated 全送 | `broadcastToStore(wss, storeId, ...)` |
| `routes/ingredients.js` | `broadcast()` 全送 | `broadcastToStore(wss, req.storeId, ...)` |
| `utils/wssBroadcast.js` | — | **新增**（共用工具） |

---

## 五、保留不變的 wss.clients 用法

```js
// server.js — ping keepalive（不需隔離，ping 所有連線）
setInterval(() => {
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.ping(); });
}, 30000);
```

ping 是協議層心跳，與業務資料無關，正確地發給所有連線。

---

## 六、事件類型與 storeId 對應

| 事件類型 | 觸發位置 | storeId 來源 | fix6 |
|---------|---------|-------------|------|
| `new_line_order` | line-orders.js POST / | `order.store_id` | ✅ 限店 |
| `order_status_changed` | line-orders.js PATCH /online/:id/status | `storeId`（req.storeId）| ✅ 限店 |
| `order_status_changed` | online-orders.js PATCH /:id/status | `storeId`（req.storeId）| ✅ 限店 |
| `settings_updated` | settings.js PUT / | `storeId`（req.storeId）| ✅ 限店 |
| `ingredient_updated` | ingredients.js 各操作 | `req.storeId` | ✅ 限店 |
| `connected` | server.js onConnection | `ws.storeId` | ✅ 僅發給自己 |
