# QR Code Fallback — fix14

## 載入順序
1. `/js/qrcode.min.js` — 本地 vendor（index.html 預載）
   使用 qrserver.com / Google Charts API 產生 QR Code img
2. CDN `qrcodejs 1.0.0` — 動態 fallback（若本地失敗）
3. `_doRenderQrFallback()` — 最終 fallback
   顯示 LINE 點餐網址連結，複製網址功能仍可用

## 本地 qrcode.min.js 實作
- 路徑：`public/js/qrcode.min.js`
- 使用 `qrserver.com` 和 `chart.googleapis.com` 兩個 QR API 圖片服務
- img.onerror 時自動切換下一個 API
- 所有 API 都失敗時顯示文字連結

## 下載邏輯
downloadLineOrderQR() 支援三種來源：
1. `<canvas id="lineQrCanvas">` (canvas 模式)
2. `<img>` 轉 canvas (API img 模式)
3. 都不可用時 showToast 提示

## LINE 點餐網址保證可用
即使 QR Code 完全失敗，LINE 點餐網址、複製按鈕、開啟按鈕仍完整顯示。
整個 LINE 點餐入口區塊不會因 QR 失敗而損壞。
