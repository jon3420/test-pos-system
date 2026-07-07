# CHANGELOG — Hotfix17

日期：2026-07-07
基礎版本：Hotfix16
性質：新功能（商家公告中心）＋ 既有休假 Banner 整合，不重寫 LINE 點餐既有模組

## 一、修改檔案清單

- `routes/settings.js` — `LINE_KEYS` 白名單新增 17 個 `line_announcement_*` key
- `routes/line-orders.js` — `/api/line-shop` 新增 `announcement` 物件（manual > auto_holiday > none）
- `public/index.html` — 「設定 → LINE 營業」新增「📢 商家公告」設定區塊（表單 + 即時預覽）
- `public/js/app.js` — 新增公告表單載入/儲存/預覽邏輯（`_fillAnnouncementForm`、`saveAnnouncementSettings`、`renderAnnouncementPreview`、`onAnnouncementButtonActionChange`）
- `public/line-order.html` — 新增商家公告 Modal / Banner 顯示系統、localStorage 再次顯示規則、按鈕動作處理

本次**不需要** Android ZIP（未修改任何 Android 檔案）。

## 二、後台位置

沿用「設定 → LINE 營業」既有頁面（尚未切分子分頁，依指示不大改架構），在「📅 營業行事曆」卡片之後新增一張全寬的「📢 商家公告」卡片，內含表單與右側即時預覽。

## 三、settings key 清單（新增，共 17 個，皆已加入 `routes/settings.js` 的 `LINE_KEYS`）

| key | type | default |
|---|---|---|
| `line_announcement_enabled` | boolean('0'/'1') | `'0'`（false） |
| `line_announcement_type` | string | `general` |
| `line_announcement_title` | string | `""` |
| `line_announcement_body` | text | `""` |
| `line_announcement_image_url` | string | `""` |
| `line_announcement_button_text` | string | `我知道了` |
| `line_announcement_button_action` | string | `close` |
| `line_announcement_button_url` | string | `""` |
| `line_announcement_category_id` | string | `""` |
| `line_announcement_product_id` | string | `""` |
| `line_announcement_start_date` | date | `""` |
| `line_announcement_end_date` | date | `""` |
| `line_announcement_closable` | boolean | `'1'`（true） |
| `line_announcement_display_mode` | string | `modal` |
| `line_announcement_frequency` | string | `version` |
| `line_announcement_version` | string | `"1"` |
| `line_announcement_auto_holiday` | boolean | `'1'`（true） |

## 四、API 變更清單

### `GET /api/line-shop`

新增 `data.announcement` 物件：

```
announcement: {
  enabled, active, type, icon, title, body, image_url,
  button_text, button_action, button_url, category_id, product_id,
  start_date, end_date, closable, display_mode, frequency, version,
  source   // 'manual' | 'auto_holiday' | 'none'
}
```

**優先序（後端 `/shop` 端點計算，前台不重複判斷）**：
1. **手動公告**：`line_announcement_enabled=1` 且今天落在 `[start_date, end_date]` 區間內（留空代表不限制）且標題或內容有填寫 → `source:'manual'`，直接套用後台表單所有欄位。
2. **自動休假公告**：沒有生效中的手動公告，且 `line_announcement_auto_holiday` 不為 `'0'`（預設開），且 `holiday_banner.type==='calendar'`（即 Business Calendar 命中休假）→ `source:'auto_holiday'`，自動產生：
   - `title` = `目前休假中`
   - `body` = `"7/5～7/8\n員工旅遊\n7/9 恢復營業"` 格式（依 `show_reason` 決定是否含原因行）
   - `type` = `holiday`，`display_mode` 固定為 `banner`（不彈窗，維持 Hotfix16 Bug4 不阻擋精神）
   - `button_text` = `立即預訂`，`button_action` = `open_cart`（恢復營業日在可預訂範圍內）或 `scroll_products`（超出範圍）
3. 兩者皆無 → `active:false, source:'none'`。

其餘 `/api/line-shop`、`/api/line-menu`、`/validate-cart`、`POST /api/line-orders`、`/timeslots` **完全未修改**（Business Calendar 判斷、休假不可送單、`line_preorder_days_limit`、LINE 商品份數、今日完售等邏輯原封不動）。

### 其餘 API

無新增路由；`PUT /api/settings` 沿用既有機制，僅白名單新增上述 17 個 key。

## 五、LINE 前台顯示邏輯（`public/line-order.html`）

- `renderAnnouncement(a)`：依 `a.display_mode` 顯示 `modal`（80% 彈窗，半透明背景，右上角 X，可背景/Esc 關閉，皆依 `closable`）或 `banner`（頁面內公告，置於商品列表上方，不遮罩、不阻擋操作，右上角 X 依 `closable` 顯示）。
- 公告類型 icon 對照：`general📢 holiday🏖️ promo🎉 new_product🆕 delivery📦 member🎁 custom✨`。
- 按鈕動作：`close`（僅關閉）／`scroll_products`（捲到商品區）／`open_cart`（捲到商品區＋開啟購物車）／`open_url`（開新視窗）／`category`（切換指定分類＋捲動）／`product`（捲動並定位到指定商品卡）／`none`（不顯示按鈕）。`source=auto_holiday` 時一律沿用 Hotfix16 已測試過的 `selectResumeDate()` 流程（含「超出可預訂範圍」檢查），不受 `button_action` 覆蓋。
- **localStorage 再次顯示規則**（key: `line_announcement_dismissed_${store_id}_${suffix}`）：
  - `always`：不記錄，每次重新整理都會依目前 `active` 狀態重新顯示（同一頁面 session 內手動關閉後，直到重新整理前不會再彈出，避免定時輪詢把剛關閉的公告又跳出來）。
  - `daily`：`suffix='daily'`，值為關閉當天日期字串，同一天不再顯示。
  - `version`：`suffix=版本號`，關閉後同版本不再顯示，後台將 `line_announcement_version` 改成新值即重新顯示。
  - `once`：`suffix='once'`，關閉後永遠不再顯示（除非清除瀏覽器 localStorage），不受版本更新影響。
- **與現有 Holiday Banner 整合**：當 `announcement.source==='auto_holiday'`（即 Business Calendar 休假觸發）時，改由新公告系統顯示（內容等同、格式更豐富），Hotfix16 舊版 `holidayBanner` 該次不重複顯示；「今日臨時休息」與「固定公休」（非 Business Calendar）情境完全不受影響，仍照 Hotfix16 原邏輯顯示舊版 Banner。
- 公告只負責顯示提醒；能否送單仍由 Business Calendar / `validateOrderConditions()` / 後端二次驗證把關，未變更。

## 六、後台 UI（`public/index.html` + `public/js/app.js`）

表單欄位：啟用開關、公告類型、公告版本、標題、內容（多行）、圖片 URL、按鈕文字、按鈕動作（依動作動態顯示對應的網址／分類 ID／商品 ID 欄位）、有效期間（起訖日期）、允許顧客關閉、顯示方式（彈窗／頁面公告）、再次顯示規則（四選一）、Business Calendar 自動休假公告開關；右側即時預覽卡片會隨輸入即時更新（純前端渲染，不呼叫 API）。「儲存公告設定」呼叫既有 `PUT /api/settings`。

## 七、不可破壞項目確認

經程式碼比對，以下項目本次完全未修改：Business Calendar 判斷（`getDateClosedStatus`／`isClosedDate`／CRUD API）、休假日不可送單與恢復營業日可預約（`validateOrderConditions` 未變更）、`line_preorder_days_limit`、LINE 商品份數（`line_quota_*`）、今日完售判斷、LINE Pay、Google Maps 外送費、優惠券、Android 接單、WebSocket 新訂單通知、既有 settings 儲存機制（`PUT /api/settings` 邏輯不變，僅擴充白名單）。

## 八、驗收結果

| 測項 | 結果 |
|---|---|
| A. 手動公告（活動公告／新品上市，含按鈕文字） | 後台儲存後，前台依 `display_mode` 顯示對應內容與按鈕 |
| B. modal 模式 | 80% 彈窗顯示，可點 X／背景／Esc 關閉（`closable=true` 時），關閉後可正常點餐、加入購物車 |
| C. banner 模式 | 公告顯示於商品列表上方，不遮罩、不阻擋操作，可直接滑動商品 |
| D. localStorage（`frequency=version`） | 關閉公告後重新整理不再顯示；後台將 `version` 改為 `2` 後重新顯示 |
| E. 自動休假公告 | Business Calendar 設定 7/5～7/8 休假、`auto_holiday=true`、無手動公告時，前台自動顯示「目前休假中」公告，按「立即預訂」可捲動並開啟購物車，日期預設選到恢復營業日 |
| F. 關閉自動休假公告（`auto_holiday=false`） | Business Calendar 仍正常擋下休假日送單，但前台不再顯示自動公告（若無手動公告則完全不顯示） |
| G. 不破壞送單 | 休假日送單被拒絕（`calendar_closed`／`today_closed`／`closed_day`）、恢復營業日與正常營業日送單成功，行為與 Hotfix16 一致 |

### node --check（全部通過）
```
✅ routes/business-calendar.js
✅ routes/line-orders.js
✅ routes/settings.js
✅ server.js
✅ utils/db.js
✅ public/js/app.js
✅ public/line-order.html（抽取 inline JS 後檢查）
```

## 九、Zip 內容

- `pos-web-hotfix17.zip`：不含 `node_modules`、`data/`、`.env`、`*.db`
