# 付款方式預設值修正 — fix16a

## 問題
fix16 的 seedPaymentMethods 預設啟用了刷卡、LINE Pay、轉帳等，
新店家應只有「現金」開箱即用，其他付款方式由店家自行啟用。

## 修正（utils/db.js + routes/superAdmin.js）

### DEFAULT_PAYMENT_METHODS（兩處同步修正）
| 名稱 | code | is_active | is_default |
|------|------|:---------:|:----------:|
| 現金 | cash | **1** | **1** |
| 刷卡 | card | 0 | 0 |
| LINE Pay | linepay | 0 | 0 |
| 街口支付 | jkopay | 0 | 0 |
| 轉帳 | transfer | 0 | 0 |
| 平台付款 | platform | 0 | 0 |

資料仍會建立（不會空白），只是 `is_active=0`，店家可在設定中自行啟用。
