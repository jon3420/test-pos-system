# LINE 點餐入口 + QR Code — fix13

## 位置
設定 → 📲 LINE 點餐入口（Tab ID: `line_entry`）

## renderLineOrderEntry() 渲染邏輯
1. 顯示店家基本資訊（名稱、Store ID、方案、LINE 點餐狀態）
2. `hasFeature('line_order') === false` → 顯示「功能尚未啟用」提示
3. `hasFeature('line_order') === true` → 顯示完整入口：
   - LINE 點餐網址（`/line-order.html?store_id=store_xxx`）
   - 複製按鈕 → `copyLineOrderUrl()`
   - 開啟按鈕 → `openLineOrderUrl()`（新分頁）
   - 下載 QR Code → `downloadLineOrderQR()`

## QR Code 產生
- CDN: `qrcodejs 1.0.0` 動態載入（僅首次需要網路）
- `_loadAndRenderQr(url)` → `_doRenderQr(url)`
- QRCode.js 產生 canvas/img → 繪製到 `<canvas id="lineQrCanvas">` (220×220)
- 下載：`canvas.toDataURL('image/png')` → `line-order-{store_id}.png`

## 網址格式
`window.location.origin + '/line-order.html?store_id=' + encodeURIComponent(store.store_id)`
不寫死網域。
