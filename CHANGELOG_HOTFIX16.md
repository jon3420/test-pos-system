# CHANGELOG — Hotfix16

日期：2026-07-07
基礎版本：Hotfix15（LINE 營業中心 V3）
性質：Bug 修正（不重寫任何模組）

## 一、修改檔案清單

### Web（pos-web-hotfix16.zip）
- `routes/line-orders.js`
- `public/js/app.js`
- `public/line-order.html`
- `CHANGELOG_HOTFIX16.md`（本檔案）

### Android（pos-android-hotfix16.zip）
- `app/src/main/java/com/foodcart/pos/ui/lineorders/LineOrdersFragment.kt`
- `app/src/main/java/com/foodcart/pos/ui/orders/OrdersFragment.kt`

## 二、BUG 1｜LINE 訂單建立時間錯誤

**問題**：新訂單 Popup 只顯示 `pickup_time`（取餐時間），未顯示 `created_at`（建立時間），管理列表排序也以預約日期為主，造成「建立時間」與「預約取餐時間」混淆。

**修正**：
- 後端 `created_at` 本來就是客人送出訂單當下的時間，`pickup_time`/`pickup_date` 為預約取餐時間，兩者從未混用（已確認）；本次修正的是**顯示層**。
- `public/js/app.js`：LINE 預購管理列表改為 `created_at` 排序（新到舊），欄位標題改為「訂單編號／建立時間」與「預約取餐」兩欄分開顯示，建立時間格式統一為 `YYYY/MM/DD HH:MM`。
- `LineOrdersFragment.kt`：新訂單彈窗（`showNewOrderDialog`）新增「🕒 建立時間：HH:MM」欄位，並將原本的「⏰ 取餐：」改為「⏰ 預約取餐：」，兩者分開顯示。
- `OrdersFragment.kt`：LINE 訂單詳情彈窗欄位由「時間」改為「建立時間」，「取餐時間」改為「預約取餐」，用詞與新規則一致。

## 三、BUG 2｜未營業時仍可預約今天（允許預購）

**問題**：商品設定販售時間尚未開始（例：現在 07:00，商品 15:00 開賣）時，LINE 前台一律顯示「尚未開賣」並禁止加入購物車，即使商店允許客人預約當天稍後時段。

**修正**（沿用既有「LINE 預購管理」開關 `line_preorder_enabled` 作為「允許預購」判斷依據）：
- `routes/line-orders.js`
  - `/api/line-menu`：商品若 `line_preorder_enabled=1` 且尚未到 `line_sell_start`，不再標記為 `product_not_started`（阻擋），改標記 `pre_sale_available=true`（前台顯示「🟢 可預約」，可直接加入購物車）。
  - 若 `line_preorder_enabled=0`，維持原行為（`product_not_started`，禁止加入購物車）。
  - `POST /api/line-orders`（正式送單）：同樣放寬「尚未開賣」限制，但客人選擇的取餐時間（若非「盡快」）必須 `>= line_sell_start`，否則回傳明確錯誤訊息，不可購買開賣前的時段。
- `public/line-order.html`：`buildCard()` 新增 `pre_sale_available` 判斷，顯示綠色「🟢 可預約」徽章、不套用遮罩、加入購物車按鈕正常可按；`addCart()` 沿用後端回傳的 `sold_out_reason`（為 null 時不阻擋)。

## 四、BUG 3｜Business Calendar 權重最高

**問題**：原本「今日臨時休息」優先於 Business Calendar，與需求相反。

**修正**：
- `routes/line-orders.js` 新增單一函式 `getDateClosedStatus()`，取代原本分散在多處的判斷邏輯，優先序改為：
  1. Business Calendar（命中即以此為準，`mode=closed`→休假；`custom_hours`/`open_all_day`→視為開放，完全覆蓋今日臨時休息與固定公休）
  2. 今日臨時休息（`line_today_closed`，僅在 Business Calendar 當天沒有命中時才會生效）
  3. 固定公休（`line_closed_weekdays`）／指定店休日（`line_closed_dates`）
- `isClosedDate()` 改為包裝 `getDateClosedStatus()`，對外介面不變，`validateOrderConditions()`、`/api/line-shop`、`/api/line-menu`、`/api/line-orders/timeslots`、`nextAvailableDates()` 全部自動套用新優先序，不需個別修改呼叫端。
- `public/js/app.js`：後台「今日營業摘要」（`businessCalendarTodayStatus` 與 `todaySummaryStatus`）原本各自呼叫 `/api/settings` + `/api/settings/business-calendar/today` 並各自判斷優先序（且判斷邏輯有誤，今日臨時休息優先於 Business Calendar），現改為統一呼叫 `/api/line-shop`，直接使用後端已算好的 `holiday_banner` / `business_calendar_today`，前後台顯示保證一致。

## 五、BUG 4｜休假期間不要 Modal 阻擋，改成頁面 Banner

**問題**：原本休假公告是 bottom-sheet + 遮罩（Modal），雖不整頁擋住但仍需手動關閉。

**修正**（`public/line-order.html`）：
- 移除 `openHolidayAnnouncement()` / `closeHolidayAnnouncement()`、`#holidaySheet` Modal 與其 Esc 監聽。
- 新增 `renderHolidayBanner(banner)` / `hideHolidayBanner()` / `scrollToProducts()` / `selectResumeDate(dateStr)`，改為頁面內固定 Banner（`#holidayBanner`），不使用遮罩、不阻擋任何操作，客人可直接看商品、加入購物車、選日期。
- Banner 內容依 `holiday_banner.type` 顯示：
  - `calendar`：🏖️ 目前休假中 + 休假區間 + 原因（依 `show_reason`）+ 🟢 恢復營業日 +「立即預訂」按鈕；若恢復營業日超出 `line_preorder_days_limit`，顯示「恢復營業日超出可預約天數」，不顯示按鈕。
  - `today_closed` / `weekly`：簡化文案「🌙 今日臨時休息／今日固定公休，可預訂其他營業日期」。
- 「立即預訂」流程：`scrollToProducts()` → 開啟購物車 → `buildDateSelector()` 選到 `resume_date` → 載入該日時段（`buildTimeSelector()`）。
- `init()` 與 `refreshShopStatus()`（60 秒定時刷新）都改用 `shopData.holiday_banner` 作為單一資料來源呼叫 `renderHolidayBanner()`；恢復營業日到達後，下次刷新即自動消失。

## 六、BUG 5｜日期選單標籤

**修正**（`public/line-order.html` `bizCalOptionSuffix()` / 新增 `isResumeDate()`）：
- Business Calendar 休假：`🔴休假（原因）`；`show_reason=false` 時僅顯示 `🔴休假`。
- 固定公休：`🔴固定公休`。
- 恢復營業日（Business Calendar 休假區間結束隔天）：`🟢恢復營業`，可選。
- 特殊營業：`🟡特殊營業`；全天營業：`🟢全天營業`（不變）。
- 休假日期一律 `disabled=true` 不可選；恢復營業日 `disabled=false` 可選並可送單。

## 七、BUG 6｜商品卡狀態顯示

**修正**（`public/line-order.html` `buildCard()`，`routes/line-orders.js` 提供 `pre_sale_available` 與休假原因欄位）：

| 狀態 | 顯示 |
|---|---|
| 尚未開賣但允許預購（`pre_sale_available`） | 🟢 可預約（不灰掉，可直接加入購物車） |
| 尚未開賣且不可預約 | 🟠 尚未開始販售 |
| 今日休假（Business Calendar／今日臨時休息／固定公休） | 🔴 休假中 |
| 今日售完（份數售完／販售時段結束／截止時間已過） | 🔴 今日售完 |
| 需預約下一個營業日 | 🔵 預約下個營業日 / 📅 預約明日按鈕 |

商品遮罩只在「休假／售完／停售／未開放」時出現，`pre_sale_available` 一律不套用遮罩、加入購物車按鈕維持可按。

## 八、BUG 7｜今日營業摘要同步

- 後台「📋 今日營業摘要」「📅 下一次休假」「🧾 預購摘要」與 LINE 前台休假 Banner、商品 Badge、日期選單，全部改用 `/api/line-shop` 回傳的 `holiday_banner` / `business_calendar_today` 作為單一資料來源，移除原本分散、且優先序有誤的重複判斷邏輯。

## 九、不可破壞項目確認

以下項目經程式碼比對，確認邏輯未變動：LINE Pay、Google Maps 外送費計算、優惠券驗證、LINE 商品份數（`line_quota_*`）、今日完售判斷、預購份數（`line_preorder_*` quota）、Android 接單流程、WebSocket 廣播事件（`line_order_created` / `new_line_order` / `order_status_changed`）、現金付款、開錢櫃、Business Calendar CRUD API（5 支既有 API 完全未修改）、`line_preorder_days_limit`、固定公休設定、既有訂單資料欄位。

## 十、API 變更清單

| API | 異動內容 |
|---|---|
| `GET /api/line-shop` | 新增 `holiday_banner` 物件（`active`/`type`/`start_date`/`end_date`/`reason`/`show_reason`/`resume_date`/`resume_within_limit`）；`is_open` 與 `today_closed_info` 改用新優先序計算 |
| `GET /api/line-menu` | 商品新增 `pre_sale_available` 欄位；`takeout_sold_out_reason` / `delivery_sold_out_reason` 新增 `calendar_closed`/`today_closed`/`weekly_closed` 三種休假原因值，優先序最高 |
| `POST /api/line-orders`（正式送單） | 商品尚未開賣但已啟用 LINE 預購管理時不再擋單，改為驗證取餐時間需 `>= line_sell_start` |
| `GET /api/line-orders/validate-cart`、`GET /api/line-orders/timeslots` | 透過共用的 `isClosedDate()`／`validateOrderConditions()` 自動套用 Business Calendar 最高優先序，無需個別修改 |

**未新增新的 API 路由，未新增新的 settings key**（Bug2 沿用既有 `line_preorder_enabled` 商品欄位，未新增設定）。

## 十一、驗收結果

| 測項 | 結果 |
|---|---|
| A. 建立時間與取餐時間分離 | 新訂單 Popup／LINE 管理列表／Android 訂單詳情皆分開顯示「建立時間」與「預約取餐」，列表以 `created_at` 排序 |
| B. 未營業可預約（`line_preorder_enabled=1`） | 商品卡顯示 🟢 可預約，可加入購物車，可選今天稍後（≥開賣時間）時段並送單成功；選開賣前時段送單會被拒絕並提示正確訊息 |
| C. Business Calendar 權重最高 | 同時設定 Business Calendar 休假與今日臨時休息，前台僅顯示 Business Calendar 休假 Banner（原因＋恢復營業日），不顯示今日臨時休息文案；後台今日摘要顯示一致 |
| D. Banner 取代 Modal | 休假期間開啟 LINE 點餐，無遮罩、無 Modal，可直接滑動商品／加入購物車，點「立即預訂」後日期自動選到恢復營業日並可送單 |
| E. 日期選單 | 休假日顯示 🔴休假（原因）且不可選；恢復營業日顯示 🟢恢復營業且可選；固定公休顯示 🔴固定公休 |
| F. 商品卡 Badge | 可預約／尚未開始販售／休假中／今日售完／預約下個營業日，顏色與文字符合規格，無全灰誤解問題 |

### node --check（全部通過）
```
✅ routes/business-calendar.js
✅ routes/line-orders.js
✅ routes/settings.js
✅ routes/orders.js
✅ server.js
✅ utils/db.js
✅ public/js/app.js
✅ public/line-order.html（抽取 inline JS 後檢查）
```

## 十二、Zip 內容

- `pos-web-hotfix16.zip`：不含 `node_modules`、`data/`、`.env`、`*.db`
- `pos-android-hotfix16.zip`：僅因 Bug1 修改 `LineOrdersFragment.kt`、`OrdersFragment.kt` 兩支檔案，其餘未變動
