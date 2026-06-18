# fix13 修復報告

## 問題根源

fix10-fix12 的 Python 字串替換因 app.js 在 fix4 已被修改，舊版標記文字不完全匹配，導致 Feature Gate 代碼完全未插入。

## fix13 修正項目

| 項目 | 問題 | 修正 |
|------|------|------|
| app.js Feature Gate 代碼 | 完全未插入 | 改用精確 MARKER 定位，確認插入 |
| window.currentStore / currentFeatures | 不存在 | ✅ 已插入 |
| loadCurrentStore() | 不存在 | ✅ 已插入 |
| applyFeatureGateUI() | 不存在 | ✅ 已插入 |
| loadLineEntryPage() / renderLineOrderEntry() | 不存在 | ✅ 已插入 |
| copyLineOrderUrl() / openLineOrderUrl() / downloadLineOrderQR() | 不存在 | ✅ 已插入 |
| QR Code 產生邏輯 | 不存在 | ✅ 已插入（動態載入 qrcodejs CDN）|
| routes/license.js ADMIN_MODE | 仍使用 ADMIN_MODE | ✅ 改用 requireSuperAdmin |
| featureGate.js licenses.active 判斷 | 未檢查 active | ✅ active=0 → 403 |
