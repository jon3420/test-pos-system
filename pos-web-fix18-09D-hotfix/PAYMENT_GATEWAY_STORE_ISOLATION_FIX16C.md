# Payment Gateways Store Isolation — fix16c-hotfix

所有查詢均帶 `WHERE store_id=?`，使用 `req.storeId`（由 requireStore middleware 解析）。
store_001 / store_002 金流設定完全隔離，互不可見。
