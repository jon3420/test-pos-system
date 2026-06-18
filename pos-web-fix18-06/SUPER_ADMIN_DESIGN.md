# Super Admin 設計文件 — R1

## 入口
`/system-admin` — 獨立登入頁，與 POS 登入完全分開

## 預設帳號
- 帳號：`superadmin`
- 密碼：`admin1234`（**上線前請立即修改**）

## API 路由

| Method | Path | 說明 |
|--------|------|------|
| POST | /api/super-admin/login | 登入 |
| GET | /api/super-admin/dashboard | 儀表板數據 |
| GET | /api/super-admin/stores | 所有店家列表 |
| POST | /api/super-admin/stores | 新增店家 |
| PUT | /api/super-admin/stores/:id | 更新店家 |
| DELETE | /api/super-admin/stores/:id | 刪除店家 |
| GET | /api/super-admin/stores/:id/license | 取得授權 |
| PUT | /api/super-admin/stores/:id/license | 更新授權 |
| PUT | /api/super-admin/change-password | 修改密碼 |

## 認證機制
- JWT Token（8 小時有效期）
- `role: 'super_admin'`
- middleware `requireSuperAdmin` 保護所有 `/api/super-admin/*`

## 儀表板功能
- 總店家數
- 啟用店家數
- 停用店家數
- Basic 方案數
- Pro 方案數
- 最近新增店家

## 店家管理功能
- 新增店家（自動建立 license + settings）
- 編輯店家（名稱/聯絡人/電話/方案/狀態）
- 停用/啟用店家
- 刪除店家（store_001 脆豬腰不可刪）

## 授權管理功能
- 查看各店授權狀態
- 切換方案（Basic/Pro）
- 精細控制功能開關（12 項）
- 方案切換時自動套用預設功能清單

