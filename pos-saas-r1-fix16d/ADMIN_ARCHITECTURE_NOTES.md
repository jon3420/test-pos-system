# ADMIN_ARCHITECTURE_NOTES — POS v18 授權系統架構說明

版本：pos-v18-web-online-r1-fix2  
日期：2026-05-29

---

## 目前架構（v18 r1-fix2）

```
┌─────────────────────────────────────────────────────────┐
│                   Web POS 後台                          │
│  （店家自行管理，完整功能開放，不受授權方案限制）          │
│                                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │  簡易管理員模式（ADMIN_MODE=true 時顯示）        │   │
│  │  → 店家授權管理 Tab                             │   │
│  │  → 新增 / 編輯 / 刪除 店家授權                  │   │
│  │  → 設定方案（basic / pro / enterprise）         │   │
│  │  → 控制功能開關                                 │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                  /api/license/:storeId
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Android POS App                        │
│                                                          │
│  啟動時查詢授權 → LicenseManager.fetch()                │
│  → 快取授權（SharedPreferences，30分鐘 TTL）            │
│  → applyLicenseVisibility() 隱藏未授權功能選單          │
│  → line_order=false 時不啟動 LineOrderService           │
│  → active=false 時 LicenseCheckActivity 阻擋進入        │
└─────────────────────────────────────────────────────────┘
```

---

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `ADMIN_MODE` | `false` | `true` 時顯示店家授權管理 Tab，允許 CRUD |
| `PORT` | `5000` | Web 服務埠號 |

---

## API 權限設計

| API | 方法 | 需要 ADMIN_MODE | 說明 |
|-----|------|:---:|------|
| `/api/license/:storeId` | GET | ❌ | Android 查詢授權，公開 |
| `/api/license/plans/defaults` | GET | ❌ | 方案預設值，公開 |
| `/api/license` | GET | ❌ | 授權清單（管理頁用） |
| `/api/license` | POST | ✅ | 新增店家授權 |
| `/api/license/:storeId` | PUT | ✅ | 更新授權 |
| `/api/license/:storeId` | DELETE | ✅ | 刪除授權 |
| `/api/admin/status` | GET | ❌ | 前端查詢目前是否管理員模式 |
| 其餘 `/api/*` | ALL | ❌ | Web POS 完整開放 |

---

## 目前方案定義

| 功能 | Basic | Pro | Enterprise |
|------|:---:|:---:|:---:|
| 點餐/訂單/商品/出單/營收 | ✅ | ✅ | ✅ |
| 庫存管理 | ❌ | ✅ | ✅ |
| LINE 點餐 | ❌ | ✅ | ✅ |
| 外送整合 | ❌ | ✅ | ✅ |
| 標籤列印 | ❌ | ✅ | ✅ |
| 行銷 | ❌ | ❌ | ✅ |
| 會員 | ❌ | ❌ | ✅ |
| 優惠券 | ❌ | ❌ | ✅ |

> 注意：以上方案僅控制 Android POS 功能開關。Web POS 後台完整開放。

---

## 未來獨立 Admin Console 架構（預留）

```
┌─────────────────────────────────────────────────────────────┐
│                  獨立 Admin Console（未來）                  │
│                                                              │
│  店家管理                                                    │
│  ├── 新增店家（store_id / store_name）                       │
│  ├── 方案管理（basic / pro / enterprise / custom）           │
│  ├── 功能開關（細粒度控制）                                  │
│  ├── Android 裝置綁定數量限制                               │
│  ├── 月租狀態 / 到期日                                      │
│  └── 暫停帳號 / 強制登出                                    │
│                                                              │
│  API 設計（預留）                                            │
│  ├── POST   /admin/stores          → 建立店家                │
│  ├── GET    /admin/stores          → 列出所有店家            │
│  ├── PUT    /admin/stores/:id      → 更新方案/功能           │
│  ├── POST   /admin/stores/:id/suspend → 暫停               │
│  ├── GET    /admin/stores/:id/devices → 裝置清單            │
│  └── GET    /admin/stats           → 整體統計               │
└─────────────────────────────────────────────────────────────┘
                          │
                  共用 License API
                          │
          ┌───────────────┴────────────────┐
          ▼                                ▼
   Web POS 後台                    Android POS App
   （各店家獨立管理）               （依授權控制功能）
```

### 抽離步驟規劃

1. **Phase 1（目前）**：Web POS 內建簡易 ADMIN_MODE，單台部署
2. **Phase 2**：將 `/api/license` 路由抽離為獨立微服務（`admin-api`）
3. **Phase 3**：獨立 Admin Console 前端（React / Next.js）
4. **Phase 4**：多租戶資料隔離，licenses 表加 `tenant_id`

### 資料庫擴充預留（Phase 2+）

```sql
-- 目前結構
CREATE TABLE licenses (
  id INTEGER PRIMARY KEY,
  store_id TEXT UNIQUE,
  store_name TEXT,
  plan TEXT,
  active INTEGER,
  features TEXT,    -- JSON
  created_at TEXT,
  updated_at TEXT
);

-- Phase 2 新增欄位（預留，不破壞現有）
-- expires_at TEXT          -- 授權到期日
-- max_devices INTEGER      -- 最大裝置數
-- billing_cycle TEXT       -- monthly / yearly
-- notes TEXT               -- 管理備註
```

---

## 部署說明

### 一般模式（店家使用）

```bash
node server.js
# 或
PORT=5000 node server.js
```

- Web POS 完整功能開放
- 授權管理 Tab 隱藏
- Android 仍可查詢 `/api/license/:storeId`

### 管理員模式

```bash
ADMIN_MODE=true node server.js
# 或
ADMIN_MODE=true PORT=5000 node server.js
```

- 授權管理 Tab 顯示
- 可新增 / 編輯 / 刪除店家授權
- 建議：管理員模式只在後台管理時啟用，一般營業時關閉

### 環境變數檔案（建議）

```bash
# .env（不要提交到 git）
ADMIN_MODE=true
PORT=5000
```

可搭配 `dotenv` 套件使用：
```javascript
require('dotenv').config();
```
