# Payment Gateway Legacy Cleanup — fix16e

## 問題

fix16d 的 `switchSettingsTab('gateway')` 已只呼叫 `loadGatewayCards()`，
但 `loadGatewayCards()` 模板中遺留了 `const gwId = gw.id || 0`，
語意上容易誤會後面仍有 id-based 呼叫。

fix16e 進行最終清理，確保無任何舊版痕跡。

---

## 清理項目

| 項目 | fix16d 狀態 | fix16e 狀態 |
|------|:---:|:---:|
| `loadGatewayPage()` | 🗑️ 已移除（僅剩 comment）| ✅ comment 明確標示 |
| `renderGatewayCards(data)` | 🗑️ 已移除 | ✅ |
| `toggleGateway(id, ...)` | 🗑️ 已移除 | ✅ |
| `setGwMode(id, ...)` | 🗑️ 已移除 | ✅ |
| `saveGateway(id)` | 🗑️ 已移除 | ✅ |
| `testGateway(id)` | 🗑️ 已移除 | ✅ |
| `const gwId = gw.id || 0` in template | ⚠️ 遺留 | ✅ fix16e 移除 |
| `switchSettingsTab('gateway')` | ✅ 只呼叫 `loadGatewayCards()` | ✅ |

---

## 現存函式（唯一版本）

```js
// loadGatewayCards() — 載入 8 個 provider 卡片
async function loadGatewayCards()   // L4640

// saveGateway(code) — PUT /api/payment-gateways/{code}
async function saveGateway(code)    // L4731

// testGateway(code) — POST /api/payment-gateways/{code}/test
async function testGateway(code)    // L4765
```

各只有 **1 份定義**，無重複。

---

## API 呼叫完整清單

```
GET  /api/payment-gateways              ← loadGatewayCards (取得所有 provider)
PUT  /api/payment-gateways/{code}       ← saveGateway(code)
POST /api/payment-gateways/{code}/test  ← testGateway(code)
```

**完全沒有** `/api/payment-gateways/{id}`（數字 id）的呼叫。

---

## 驗證結果

```
switchSettingsTab gateway calls: ["loadGatewayCards()"]   ← 只有一個
saveGateway function defs: 1 ✅
testGateway function defs: 1 ✅
loadGatewayCards function defs: 1 ✅
Old id-based API calls: 0 ✅
```
