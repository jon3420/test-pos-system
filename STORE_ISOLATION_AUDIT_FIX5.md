# Store Isolation Audit — R1 fix5
審計日期：2026-05-30
版本：pos-saas-foundation-r1-fix5

---

## fix5 三項修正

| 項目 | fix4 | fix5 |
|------|:----:|:----:|
| `/set-password` 安全漏洞（公開 API） | ❌ 高危 | ✅ 已修正 |
| `app.js` 殘留 4 個裸 `fetch()` 呼叫 | ⚠️ | ✅ 已修正 |
| `storeGuard.js` 文案誤導「立即 403」 | ⚠️ | ✅ 已修正 |

---

## 一、`/set-password` 安全漏洞修正

### 問題（fix4 高危）

`POST /api/store-login/set-password` 掛在公開路由下，
**任何人都可以不需任何認證修改任意店家的 POS 密碼**：

```js
// ❌ fix4 storeLogin.js — 完全公開
app.use('/api/store-login', require('./routes/storeLogin'));
// → POST /api/store-login/set-password 無任何保護
```

### fix5 修正

**策略：移除 + 搬移**

1. **`routes/storeLogin.js`** — 完全移除 `/set-password` 端點，
   只保留店家登入（`POST /`）這一個公開端點。

2. **`routes/superAdmin.js`** — 新增受 `requireSuperAdmin` 保護的端點：

```
PUT /api/super-admin/stores/:storeId/password
```

呼叫此端點必須帶有效的 Super Admin JWT（`role: 'super_admin'`），
否則收到 **HTTP 401**（token 無效）或 **HTTP 403**（非 Super Admin）。

#### 路由對比

| 端點 | fix4 | fix5 | 保護 |
|------|------|------|------|
| `POST /api/store-login` | ✅ 公開登入 | ✅ 公開登入 | 無需（設計如此）|
| `POST /api/store-login/set-password` | ❌ **公開，無保護** | 🗑️ **已移除** | — |
| `PUT /api/super-admin/stores/:id/password` | — | ✅ **新增** | `requireSuperAdmin` |

#### fix5 端點說明

```
PUT /api/super-admin/stores/:storeId/password
Authorization: Bearer <super_admin_jwt>
Body: { "new_password": "newpass123" }
→ 200: { success: true, message: "店家 store_001 的 POS 密碼已更新" }
→ 401: token 無效
→ 403: 非 Super Admin
→ 404: 店家不存在
→ 400: 密碼不足 4 碼
```

---

## 二、`app.js` 殘留 fetch() 全面修正

### 問題（fix4）

fix4 的 regex 替換未能捕捉到 4 個使用「動態 `url` 變數」的 `fetch(url, ...)` 呼叫，
這些呼叫均指向 `/api/...` 路徑但沒有帶 `Authorization` header。

### fix5 修正（精確字串替換，4 個全部命中）

| 函式 | 呼叫路徑 | fix4 | fix5 |
|------|---------|------|------|
| `saveProduct` | `/api/products` 或 `/api/products/:id` | ❌ `fetch(url, ...)` | ✅ `apiFetch(url, ...)` |
| `saveCat` | `/api/categories` 或 `/api/categories/:id` | ❌ `fetch(url, ...)` | ✅ `apiFetch(url, ...)` |
| `showInventoryLogs` | `/api/inventory/logs?...` | ❌ `fetch(url)` | ✅ `apiFetch(url)` |
| `savePlatform` | `/api/platforms` 或 `/api/platforms/:id` | ❌ `fetch(url, ...)` | ✅ `apiFetch(url, ...)` |

### 驗證結果

修正後掃描 `public/js/app.js`：

```
bare fetch() 呼叫數（不含 apiFetch 內部）：1
```

唯一剩餘的 `fetch()` 位於 `apiFetch` 函式**本體內部**（第 25 行），
是包裝函式本身必要的實作，**不應替換**：

```js
async function apiFetch(url, options = {}) {
  // ...
  const res = await fetch(url, { ...options, headers });  // ← 這是正確的
  // ...
}
```

**結論：所有 POS API 的 `fetch` 呼叫（共 79 個 `apiFetch` + 4 個本次修正）
現在全部透過 `apiFetch` 發出，自動帶 `Authorization: Bearer <token>`。**

---

## 三、storeGuard.js 文案修正

### 問題（fix4）

`invalidateStoreCache` 文件和頂部說明有「立即失效」等誤導性文字，
實際行為取決於快取狀態：

> ❌ fix4 舊文案：「店家停用後，舊 JWT **立即**失效（下個快取週期，最多 30 秒）」

### fix5 修正

```
✅ fix5 新文案：
  停用生效時機：
    Super Admin 停用店家時會呼叫 invalidateStoreCache()，清除快取，
    使下一個 API 請求立即查 DB 並收到 403。
    一般情況下快取 TTL 為 30 秒，最多 30 秒內生效。
```

**準確行為說明：**

| 情境 | 生效時間 |
|------|---------|
| Super Admin 透過後台停用店家 | 下一個請求即生效（快取已清除） |
| 直接修改 DB 的 `active` 欄位（不經 API） | 最多 30 秒後生效（快取 TTL）|
| 舊 JWT 過期（8 小時） | 8 小時後自動失效 |

---

## 四、所有 Routes 完整隔離狀態（fix5 後）

| 路由 / 模組 | R1 | fix1 | fix2 | fix3 | fix4 | fix5 |
|------------|:--:|:----:|:----:|:----:|:----:|:----:|
| **routes/storeLogin.js** | — | — | — | — | ⚠️ set-password 公開 | ✅ |
| **routes/superAdmin.js** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ set-password 受保護 |
| **public/js/app.js** | ❌ | ❌ | ❌ | ❌ | ⚠️ 4 個漏網 | ✅ |
| **middleware/storeGuard.js** | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ 文案誤導 | ✅ |
| services/printService.js | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| routes/print.js | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| public/line-order.html | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| routes/orders.js | ⚠️ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| routes/payment-methods.js | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| routes/payment-gateways.js | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| routes/platforms.js | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| routes/printJobs.js | ❌ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| utils/inventoryHelper.js | ❌ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| routes/products.js | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/categories.js | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/settings.js | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/customers.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/kitchen.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/online-orders.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/sync.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/ingredients.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/importExport.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/line-orders.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/inventory.js | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/superAdmin.js | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| routes/license.js | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

圖例：✅ 完整隔離　⚠️ 部分問題　❌ 未隔離

---

## 五、fix5 後安全邊界總結

```
公開 API（無需認證）
  POST /api/store-login          ← 店家登入，驗證帳密後發行 JWT

Super Admin 保護（requireSuperAdmin）
  GET/POST/PUT/DELETE /api/super-admin/*
  PUT /api/super-admin/stores/:id/password  ← fix5 新增，密碼管理

店家 API（requireStore → validateStore → stores 表）
  GET/POST/PUT/DELETE /api/products/*
  GET/POST/PUT/DELETE /api/orders/*
  ... 所有業務 API

前端 apiFetch 層
  79 個 apiFetch 呼叫，全部自動帶 Authorization: Bearer <token>
  403/401 → clearToken() → showLoginOverlay()
```
