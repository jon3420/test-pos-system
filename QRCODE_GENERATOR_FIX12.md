# QR Code 產生說明 — fix12
## 工具
CDN: `https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js`
動態載入（僅在用戶打開 LINE 點餐入口 Tab 時載入）

## 產生流程
1. `generateQrCode(url)` → 動態載入 qrcode.js
2. `_renderQr(canvas, url)` → new QRCode(tmp, ...) → 繪製到 Canvas
3. 下載：`canvas.toDataURL('image/png')` → `<a download>` 觸發

## QR Code 內容
`https://目前網域/line-order.html?store_id=store_001`
使用 `window.location.origin`，不寫死。

## 檔名
`line-order-{store_id}.png`
