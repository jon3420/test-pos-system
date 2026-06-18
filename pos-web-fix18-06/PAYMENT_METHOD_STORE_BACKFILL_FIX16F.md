# 付款方式 Backfill — fix16f

## 改進
- fix16 backfill 只掃 `WHERE active=1`
- fix16f 改為 `SELECT store_id FROM stores`（不限 active），確保所有店家都補齊

## 啟動日誌
`[DB] fix16f: 付款方式 backfill 完成，共掃描 N 家店`

## 新增店家
superAdmin.js POST /stores 新增後呼叫 `INSERT OR IGNORE` 補付款方式。
