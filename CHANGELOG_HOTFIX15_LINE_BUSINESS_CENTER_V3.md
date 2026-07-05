# CHANGELOG — LINE 營業中心 V3（Hotfix15）

日期：2026-07-05
基礎版本：Business Calendar V2 Hotfix14
本次性質：功能升級（休假不再整頁擋單 + 新增可提前預訂天數限制 + 後台摘要資訊區），非重寫

## 一、核心變更總覽

1. **休假不再整頁擋住點餐**：今日臨時休息 / Business Calendar 店休 / 固定公休日，統一改為「休假公告 Modal」（沿用既有 bottom-sheet 元件），顧客關閉後仍可正常瀏覽菜單、加入購物車；只有休假日期本身**不可送單**，由後端 `/validate-cart` 與正式送單 API 二次把關。
2. **新增「顧客可提前預訂天數」**：`line_preorder_days_limit`（預設 14，範圍 0～60），控制 LINE 點餐日期選單最多可選幾天內，並在後端強制驗證，不可透過前端繞過。
3. **後台 LINE 營業設定頁右側空白**：擴充為三張摘要卡片（📋 今日營業摘要 / 📅 下一次休假 / 🧾 預購摘要）。

## 二、LINE 前台休假公告 Modal（`public/line-order.html`）

- 沿用既有 `.sheet` / `.overlay` bottom-sheet 元件（與購物車、查詢訂單等相同互動模式），新增 `#holidaySheet`。
- 新增函式：
  - `openHolidayAnnouncement(info)`：依 `info.type` 產生對應文案並開啟 sheet。
  - `closeHolidayAnnouncement()`：關閉 sheet（`✕` 按鈕、「我知道了」按鈕皆呼叫此函式）。
  - `Escape` 鍵監聽：當休假 sheet 開啟時按 Esc 可關閉。
  - 點擊背景遮罩（`#overlay`）沿用既有 `closeTopSheet()` 亦可關閉。
- 三種休假文案（依 `isWeekly` / `calendar` 判斷，優先序不變：今日臨時休息 ＞ Business Calendar ＞ 固定公休/指定店休日）：
  - Business Calendar 店休：`🌙 今日休息` + 原因（依 `show_reason`）+ 休假期間 + 預計恢復營業日。
  - 固定公休（`line_closed_weekdays` 命中）：`🌙 今日固定公休` + 「每週X固定店休，您仍可預訂其他營業日期」。
  - 今日臨時休息：`🌙 今日臨時休息` + 「您仍可預訂其他營業日期」。
  - 舊版指定店休日（`line_closed_dates`，無原因欄位）：`🌙 今日店休` + 「您仍可預訂其他營業日期」。
- **關鍵修正**：`init()` 內原本「今日休息 → `showClosed()` 整頁覆蓋 + `return`」的三處分支，全部移除 `return`，改為呼叫 `openHolidayAnnouncement()`，讓程式繼續往下執行完成菜單載入、日期選單建立、加入購物車等既有流程，完全不中斷頁面。
- `showClosed()` 函式保留，但職責限縮為僅處理「LINE 點餐總開關關閉」「外帶外送皆關閉」等**真正需要整頁擋住**的情境（未變動這兩種情境的行為，維持不可破壞需求）。

## 三、日期選單升級（`public/line-order.html`）

- `bizCalOptionSuffix()` 參數拆分為 `isWeeklyClosed` / `isSpecificClosed` 兩個獨立旗標（原本合併為 `isClosedWeekly`），使畫面能分辨：
  - Business Calendar 命中 `closed` → `🔴 店休（原因）`（`show_reason=false` 時只顯示 `🔴 店休`）
  - 固定公休（`line_closed_weekdays`）→ `🔴 固定公休`
  - 舊版指定店休日（`line_closed_dates`）→ `🔴 店休`
  - 命中 `custom_hours` / `open_all_day` → `🟡 特殊營業` / `🟢 全天營業`（不變）
- `buildDateSelector()` 重構：日期範圍統一由新函式 `getPreorderDaysLimit()`（讀 `shopData.line_preorder_days_limit`，預設 14，clamp 0～60）決定，範圍固定為「今天 ～ 今天+N天」（`forceNextDay=true` 時排除今天）。取代原本「一般模式固定 3 天／預約模式固定 7 天」的寫死邏輯。
- `openCartSheetWithDate()`（今日售完 → 引導預約下一可訂日）：原本重複維護一份 14 天的日期建構邏輯，改為直接呼叫共用的 `buildDateSelector(true)`，避免兩處邏輯分歧、日後只需維護一份。
- 範圍內若有休假日，**仍會顯示在選單中並標示為 disabled**，不會被隱藏（符合「讓客人知道為什麼不能選」的需求）。

## 四、顧客可提前預訂天數（`line_preorder_days_limit`）

### 後端（`routes/line-orders.js`）
- 新增 `getPreorderDaysLimit(db, storeId)`：讀取設定，預設 14，clamp 至 0～60。
- 新增 `dateDiffDays(a, b)`：安全計算兩個 `YYYY-MM-DD` 之間的天數差。
- `/shop`：`keys` 白名單新增 `line_preorder_days_limit`，回傳給前台使用；`nextAvailableDates()` 掃描深度改為 `min(這個值, ...)`（原本寫死 14 天），避免建議超出允許範圍的日期。
- `validateOrderConditions()`（`/validate-cart` 與正式送單 API `POST /api/line-orders` 共用同一份函式）新增第一道檢查：若 `orderDate` 超過 `today + limit` 天，回傳 `reason: 'preorder_limit_exceeded'`，訊息「此日期超出可預訂範圍（最多可預訂 N 天內）」。
- `/timeslots`：同樣新增此檢查，超出範圍時回傳 `slots: [], reason: 'preorder_limit_exceeded'`。

### 後台設定（`routes/settings.js` + `public/index.html` + `public/js/app.js`）
- `routes/settings.js`：`LINE_KEYS` 白名單新增 `line_preorder_days_limit`（沿用既有 line_order 授權保護機制，未新增其他驗證路徑）。
- 「設定 → LINE 營業 → 預約取餐時間設定」卡片新增欄位「顧客可提前預訂天數」（`min=0 max=60 placeholder=14`）。
- `app.js`：`loadLineBizStatus()` 讀值時 clamp 0～60、預設 14；`saveAdvancedLineSettings()` 儲存時同樣 clamp 後轉字串寫入。

## 五、後台摘要資訊區（`public/index.html` + `public/js/app.js`）

原本 Hotfix14 的單一「📋 今日營業摘要」卡片，擴充為三張獨立卡片（沿用 `.settings-grid` 的 `auto-fit` 排版，自動與其他卡片同列排列，不再保留大片空白）：

1. **📋 今日營業摘要**：沿用既有 `#businessCalendarTodayStatus` 狀態文字，新增外帶/外送「今日實際營業時間」（優先套用 Business Calendar 當日覆蓋，否則讀每週營業時間對應今天的星期）與「今日是否可接單」。
2. **📅 下一次休假**：沿用 `_businessCalendarCache`（`loadBusinessCalendar()` 已抓取，不額外呼叫 API），找出最近一筆尚未結束的 `mode=closed` 項目，顯示日期區間、原因、恢復營業日。
3. **🧾 預購摘要**：顯示目前 `line_preorder_days_limit`、換算後的可預訂日期範圍，並掃描 `_businessCalendarCache` + 固定公休 + 指定店休日，找出「下一個可營業日」。

三張卡片共用一次 `renderTodaySummary()`（改為 `async`），掛在既有 `refreshTodayBusinessStatus()` / `loadBusinessCalendar()` 完成後自動觸發，未新增額外的定時輪詢或多餘 API 呼叫路徑。

## 六、相容性 / 不可破壞確認

以下項目經程式碼比對與 API 測試，確認邏輯完全未變動：
- LINE 點餐總開關（`line_ordering_enabled` 全域關閉時仍整頁擋住，行為不變）
- 今日臨時休息（`line_today_closed`，仍是最高優先，Modal 化但判斷邏輯不變）
- Business Calendar（CRUD API、`isClosedDate`/`getDayOpenClose` 覆蓋層邏輯不變）
- 固定公休日 / 舊版指定店休日（`line_closed_weekdays` / `line_closed_dates`，判斷邏輯不變，僅前端顯示文字拆分更清楚）
- 外帶 / 外送獨立規則、Google Maps 外送費、LINE Pay、LINE 預購（`line_preorder_*` 商品份數機制，與本次新增的 `line_preorder_days_limit` 為不同機制，互不影響）、Android 平板接單、既有訂單狀態流程、今日完售 / LINE 商品份數、優惠券、settings 儲存機制。

## 七、settings key 新增清單

| Key | 說明 | 預設值 | 範圍 |
|---|---|---|---|
| `line_preorder_days_limit` | 顧客可提前預訂天數 | `14` | `0`～`60` |

未新增其他 settings key；未修改任何既有 key 的語意。

## 八、API 異動清單

**未新增新的 API 路由**。異動皆為既有 API 的回傳內容或內部驗證邏輯強化：

| API | 異動內容 |
|---|---|
| `GET /api/line-shop` | 回傳新增 `line_preorder_days_limit` 欄位；`takeout_next_dates` / `delivery_next_dates` 掃描範圍改用此設定值 |
| `GET /api/line-timeslots` | 新增日期超出可預訂天數時回傳空陣列 + `reason: 'preorder_limit_exceeded'` |
| `GET /api/line-validate-cart` | 新增日期超出可預訂天數時回傳 `mode_reason: 'preorder_limit_exceeded'` |
| `POST /api/line-orders`（正式送單） | 與 `/validate-cart` 共用 `validateOrderConditions()`，同樣受可預訂天數限制保護 |
| `PUT /api/settings` | `LINE_KEYS` 白名單新增 `line_preorder_days_limit`，可寫入 |

Business Calendar 的 5 支既有 API（`GET/POST/PUT/DELETE /api/settings/business-calendar`、`GET .../today`）本次未修改。

## 九、驗證結果

### node --check（全部通過）
```
✅ routes/business-calendar.js
✅ routes/line-orders.js
✅ routes/settings.js
✅ server.js
✅ utils/db.js
✅ public/js/app.js
✅ public/line-order.html（抽取後的 inline JS）
```

### End-to-End 測試（全部通過）
| 測項 | 結果 |
|---|---|
| Business Calendar 店休（含今天，區間內/外） | `/shop` 正確回傳 `today_closed_info.calendar`；`/validate-cart` 區間內 `calendar_closed`，區間外（隔天）`mode_ok:true` |
| 固定公休日 | `/shop` 回傳 `isWeekly:true, calendar:null`；`/validate-cart` 今日 `closed_day`，其他星期 `mode_ok:true` |
| 今日臨時休息 | `/validate-cart` 今日 `today_closed`（優先於 Business Calendar 開啟中的全天營業設定），明日 `mode_ok:true` |
| `line_preorder_days_limit=7` | 第 7 天 `mode_ok:true`，第 8 天 `/validate-cart` 與 `/timeslots` 皆回傳 `preorder_limit_exceeded` |
| 正式送單 API 超出天數限制 | `POST /api/line-orders` 回傳 `success:false, reason:'preorder_limit_exceeded'`，訊息正確 |
| 前端日期選單標籤模擬（Node 直接執行 `bizCalOptionSuffix`） | 完全符合規格：`明天 07/06 🔴 店休（員工旅遊）`、`show_reason=false` 時只顯示 `🔴 店休`、固定公休顯示 `🔴 固定公休` |
| 測試資料清理 | Business Calendar 測試項目已刪除，settings 已還原為預設值（`line_preorder_days_limit=14`、`line_closed_weekdays=[]`、`line_today_closed=0`） |

### Zip 潔淨度
不含 `node_modules`、`data/`、`.env`、`*.db`。
