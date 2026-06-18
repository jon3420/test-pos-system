# LINE 點餐入口 — fix12
## 位置
設定 → 📲 LINE 點餐入口（新增 Tab）

## 顯示內容
- 店家名稱、Store ID、目前方案
- LINE 點餐網址（`/line-order.html?store_id=店家ID`）
- QR Code（使用 qrcodejs 產生，240×240）
- 按鈕：複製網址 / 開啟點餐頁 / 下載 QR Code PNG

## Feature Gate
- `line_order=false` → 顯示「LINE 點餐功能尚未啟用，請聯絡系統管理員升級方案」
- `line_order=true` → 顯示完整入口資訊

## 網址格式
`window.location.origin + '/line-order.html?store_id=' + store.store_id`
不寫死網域，自動取得當前 origin。

## QR Code 下載
檔名：`line-order-{store_id}.png`，使用 Canvas.toDataURL('image/png')
