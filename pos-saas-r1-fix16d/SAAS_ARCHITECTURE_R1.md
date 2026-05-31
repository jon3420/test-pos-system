# POS SaaS Foundation R1 — 架構說明

## 版本
v18.1.0 — SaaS Foundation R1

## 核心目標
將原本單店 POS 改造為多店 SaaS 架構，實現資料完全隔離，建立 Super Admin 總控台。

---

## 系統層級

```
Super Admin 總控台 (/system-admin)
         │
         ▼
   stores 資料表（所有店家清單）
         │
   ┌─────┴─────┐
   │           │
store_001    store_002 ...
（脆豬腰）   （A 店）
   │
   ├── products  (store_id = store_001)
   ├── orders    (store_id = store_001)
   ├── categories(store_id = store_001)
   ├── settings  (store_id = store_001)
   └── inventory (store_id = store_001)
```

---

## 資料隔離機制

### store_id 傳遞方式（優先順序）

1. **Bearer JWT Token**（推薦，未來 store login 使用）
2. **x-store-id Header**（Android POS 相容）
3. **?store_id= 查詢參數**（LINE 點餐相容）
4. **預設 store_001**（向後相容脆豬腰）

### middleware/storeGuard.js
- `requireStore`：解析 store_id，注入 req.storeId
- `requireSuperAdmin`：驗證 Super Admin JWT，保護 /api/super-admin/*

---

## 不修改的部分

- ✅ Android POS（完全不動）
- ✅ License API（/api/license/* 原版保留）
- ✅ Android License Sync
- ✅ Android Feature Gate
- ✅ Zeabur 部署架構

---

## R2 預留（本次不做）

- branch_id（多分店）
- 跨店報表
- 跨店庫存
- 跨店會員
- 加盟總部

