# Settings LINE Gate — fix14

## 問題
PUT /api/settings 允許任意修改所有 settings，包含 LINE 相關 key。

## 修正
routes/settings.js 在寫入前檢查：
- 若 request body 包含任何 LINE_KEYS，呼叫 getStoreLicense(storeId)
- active=0 → 403 LICENSE_INACTIVE
- features.line_order=false → 403 FEATURE_DISABLED

## LINE_KEYS 完整清單（19 個）
line_order_enabled, line_order_min_amount, line_ordering_enabled,
line_business_hours_enabled, line_business_hours, pickup_enabled,
delivery_enabled, pickup_business_hours_enabled, delivery_business_hours_enabled,
line_today_closed, line_today_closed_date, same_day_preorder_minutes,
next_day_preorder_hours, line_closed_weekdays, line_closed_dates,
line_payment_cash_enabled, line_payment_linepay_enabled,
line_payment_transfer_enabled, line_payment_platform_enabled,
line_payment_credit_card_enabled

## 回應格式
```json
HTTP 403
{ "success": false, "error": "FEATURE_DISABLED", "feature": "line_order",
  "message": "此功能未授權，請聯絡系統管理員升級方案（LINE 點餐設定需 line_order 授權）" }
```
