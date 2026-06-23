# WEB_TEST_REPORT_R1 — POS v18 Web Online R1

測試日期：2026-05-29  
版本：pos-v18-web-online-r1  
測試方式：Node.js 自動化整合測試（curl + Python assert）

---

## 測試結果總覽：9/9 PASS ✅

---

## Test 1：GET /api/license/plans/defaults 路由正確（不被 :storeId 攔截）

```
GET /api/license/plans/defaults
```

**修正前問題：** `plans/defaults` 放在 `/:storeId` 後方，Express 將 "plans" 視為 storeId，查詢 DB 找不到 store_id="plans" 而回傳 404。

**修正後：** 固定路由移至動態路由前方。

```json
{
  "success": true,
  "data": {
    "basic":  { "inventory": false, "line_order": false, ... },
    "pro":    { "inventory": true,  "line_order": true, ... },
    "enterprise": { 全部 true }
  }
}
```

**結果：✅ PASS** — 正確回傳三種方案預設值，`basic.inventory=false`，`enterprise.member=true`

---

## Test 2：GET /api/license/:storeId（default_store）

```
GET /api/license/default_store
```

```json
{
  "success": true, "plan": "basic", "active": true,
  "features": { "inventory": false, "line_order": false, ... }
}
```

**結果：✅ PASS**

---

## Test 3：Basic 方案 inventory=false → /api/inventory 回傳 403

```
GET /api/inventory?store_id=default_store
```

```json
HTTP 403
{ "success": false, "message": "此功能尚未開通，請升級方案或聯繫管理員" }
```

**結果：✅ PASS**

---

## Test 4：Pro 方案 inventory=true → /api/inventory 回傳 200

```
GET /api/inventory?store_id=pro_test
```

```
HTTP 200  →  正常回傳庫存資料
```

**結果：✅ PASS**

---

## Test 5：active=false → 回傳停用訊息

```
GET /api/license/dis_test   （active=false 的店家）
```

```json
{ "success": false, "active": false, "message": "此店家授權已停用，請聯繫系統管理員" }
```

**結果：✅ PASS**

---

## Test 6：第一次啟動，licenses 表不存在，直接呼叫 /api/inventory 不崩潰

**修正前問題：** `licenseGuard.js` 假設 licenses 表已存在，若未進過授權管理頁，表不存在時 DB 查詢拋出 exception，導致 server 崩潰或 500。

**測試步驟：**
1. 刪除 licenses 資料表（模擬全新部署）
2. 重啟 Server
3. 直接呼叫 `GET /api/inventory?store_id=default_store`（未進過授權頁）

**修正後行為：**
- `licenseGuard.js` 在每次 `requireFeature()` 前先執行 `ensureLicenseTable()`
- 自動建立 licenses 表並插入 default_store Basic 授權
- 正常回傳 HTTP 403（功能未開通），不崩潰

```
HTTP 403 → { "success": false, "message": "此功能尚未開通…" }
```

**結果：✅ PASS**

---

## Test 7：PUT /api/license/:storeId 切換方案

```
PUT /api/license/default_store
Body: { "plan": "enterprise", "active": true }
```

```json
{ "success": true }
```

**結果：✅ PASS**

---

## Test 8：Enterprise 方案所有功能開啟

```
GET /api/license/default_store   （切換至 Enterprise 後）
```

```json
{
  "features": {
    "order": true, "orders": true, "products": true,
    "reports": true, "print": true, "inventory": true,
    "line_order": true, "delivery": true, "marketing": true,
    "member": true, "coupon": true, "label_print": true
  }
}
```

**結果：✅ PASS** — Enterprise 12 個功能全部為 true

---

## Test 9：DELETE /api/license/default_store 應被拒絕

```
DELETE /api/license/default_store
```

```
HTTP 400 → { "success": false, "message": "預設店家不可刪除" }
```

**結果：✅ PASS**

---

## 方案功能矩陣驗證

| 功能 | Basic | Pro | Enterprise | 驗證 |
|------|-------|-----|-----------|------|
| order/orders/products/reports/print | ✅ | ✅ | ✅ | ✅ |
| inventory | ❌ | ✅ | ✅ | ✅ |
| line_order | ❌ | ✅ | ✅ | ✅ |
| delivery | ❌ | ✅ | ✅ | ✅ |
| label_print | ❌ | ✅ | ✅ | ✅ |
| marketing/member/coupon | ❌ | ❌ | ✅ | ✅ |

---

## 測試結論

| # | 測試項目 | 結果 |
|---|---------|------|
| 1 | plans/defaults 路由順序正確 | ✅ PASS |
| 2 | default_store 授權查詢 | ✅ PASS |
| 3 | Basic → inventory 403 | ✅ PASS |
| 4 | Pro → inventory 200 | ✅ PASS |
| 5 | active=false 停用訊息 | ✅ PASS |
| 6 | licenseGuard 自建表不崩潰 | ✅ PASS |
| 7 | PUT 切換方案 | ✅ PASS |
| 8 | Enterprise 全功能開啟 | ✅ PASS |
| 9 | DELETE default_store 拒絕 | ✅ PASS |

**總計：9/9 PASS ✅**
