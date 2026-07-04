# CHANGELOG — 營業行事曆 Business Calendar V2

日期：2026-07-04
需求來源：LINE 營業時間只有週一～週日設定，無法設定「指定日期區間」休假（例如 7/5～7/8 員工旅遊）。

## 一、功能總覽

新增「營業行事曆」作為「每週營業時間」的覆蓋層，支援：
1. 單日休息 / 連續日期區間休息（`mode = closed`）
2. 指定日期特殊營業時間，外帶/外送可分開設定（`mode = custom_hours`）
3. 指定日期全天營業，不受每週營業時間限制（`mode = open_all_day`）
4. 原因可選擇是否顯示給客人（`show_reason`）

判斷優先順序（由高到低）：
```
1. LINE 點餐總開關（line_ordering_enabled）
2. 今日臨時休息（line_today_closed / line_today_closed_date）── 最高優先，一律蓋過營業行事曆
3. 營業行事曆 Business Calendar（store_business_calendar）
4. 每週營業時間（line_closed_weekdays / line_closed_dates / takeout_business_hours / delivery_business_hours）
5. 外帶 / 外送模式開關（takeout_enabled / delivery_enabled）
6. 最短備餐時間 / 今日最後接單時間 / LINE 預購規則
```

## 二、資料庫（Safe Migration，不可 DROP / 不可重建 / 不可清空既有資料）

`utils/db.js` 新增：

```sql
CREATE TABLE IF NOT EXISTS store_business_calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'closed',        -- closed | custom_hours | open_all_day
  reason TEXT DEFAULT '',
  show_reason INTEGER DEFAULT 1,
  takeout_enabled INTEGER DEFAULT 1,
  delivery_enabled INTEGER DEFAULT 1,
  takeout_start_time TEXT DEFAULT '',
  takeout_end_time TEXT DEFAULT '',
  delivery_start_time TEXT DEFAULT '',
  delivery_end_time TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_store_business_calendar_range
  ON store_business_calendar(store_id, start_date, end_date);
```

- 專案目前沒有 tenant_id 概念，沿用既有慣例，僅用 `store_id` 隔離。
- 全部語句皆為 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，重複啟動不會報錯，也不會影響既有資料。

## 三、後端 API（新檔 `routes/business-calendar.js`，掛載於 `server.js`）

掛載路徑：`/api/settings/business-calendar`（`requireStore` + `requireFeature('line_order')`）

| Method | 路徑 | 說明 |
|---|---|---|
| GET | `/api/settings/business-calendar` | 取得該店行事曆列表（依 start_date 排序） |
| POST | `/api/settings/business-calendar` | 新增行事曆項目 |
| PUT | `/api/settings/business-calendar/:id` | 編輯行事曆項目（只能改自己店的） |
| DELETE | `/api/settings/business-calendar/:id` | 刪除行事曆項目（只能刪自己店的） |
| GET | `/api/settings/business-calendar/today` | 取得「今天」命中的行事曆設定與狀態 |

驗證規則：
- `start_date` / `end_date` 必須是 `YYYY-MM-DD`，且 `end_date >= start_date`
- `mode` 必須是 `closed` / `custom_hours` / `open_all_day` 其中之一
- `mode=custom_hours` 時，該模式（外帶/外送）若為開放狀態，必須提供合法 `HH:MM` 時間，且結束時間需晚於開始時間
- 所有查詢／寫入皆以 `req.storeId` 過濾，不會跨店存取

## 四、`routes/line-orders.js` 判斷邏輯整合（疊加，不破壞舊分支）

- `isClosedDate()`：改為先查 Business Calendar（`findMatchingEntry` / `computeTodayStatus`），命中 `closed` → 視為店休；命中 `custom_hours` / `open_all_day` → 不視為店休，且不再套用舊的每週公休/指定店休日（覆蓋層語意）；**沒有命中才完全走舊邏輯**（`line_closed_weekdays` / `line_closed_dates` 原封不動）。
- 新增 `resolveModeHoursForDate()` / `getDayOpenClose()`：依「行事曆覆蓋 → 舊每週營業時間」順序算出某模式某日的開店/打烊時間；若行事曆命中但該模式（外帶或外送）被個別關閉，回傳「當日不可下單」。
- `getEarliestMins()` 改為吃 `db/storeId/mode` 參數，統一透過 `getDayOpenClose()` 計算，`/shop`、`/timeslots` 呼叫點皆已同步更新。
- `/shop` route 新增回傳欄位 `business_calendar_today`（未命中則 `{matched:false}`），並修正 `takeout_next_dates` / `delivery_next_dates` 計算改用行事曆感知的 `getDayOpenClose()`。
- `validateOrderConditions()`（`/validate-cart` 與下單前雙重驗證共用）：
  - 檢查順序調整為「今日臨時休息 → 店休日（含行事曆）→ 行事曆單一模式關閉 → 模式開關 → cutoff → 備餐時間」，確保**今日臨時休息一律優先於行事曆**。
  - 命中行事曆 `closed` 時回傳 `reason:'calendar_closed'`，訊息包含原因（依 `show_reason`）與恢復日期。
  - 命中行事曆但該模式被關閉時回傳 `reason:'calendar_mode_closed'`。

## 五、後台 UI（`public/index.html` + `public/js/app.js`）

位置：設定 → LINE 營業設定 → 在「🌙 今日臨時休息」卡片下方新增「📅 營業行事曆」卡片（未新開分頁，維持原 Dark Theme）。

- 今日狀態：🟢 今日正常營業 / 🟡 今日特殊營業 / 🔴 今日特殊休息 / 🔴 今日臨時休息（臨時休息優先）
- ＋新增行事曆按鈕 → 開啟 Modal（沿用專案既有 `.modal-overlay.open` 樣式），欄位：開始/結束日期、模式（全天休息／特殊營業時間／全天營業）單選、原因、顯示原因給客人、外帶/外送個別開放開關與時間欄位。
  - `mode=closed`：隱藏時間欄位
  - `mode=custom_hours`：顯示時間欄位（依外帶/外送開放狀態個別顯示）
  - `mode=open_all_day`：時間輸入停用（disabled）
- 列表：依 `mode` 顯示對應圖示與明細（全天休息 / 特殊營業含外帶外送時段 / 全天營業），並顯示「顯示給客人：是/否」，含編輯／刪除按鈕。
- 新增 JS 函式：`loadBusinessCalendar()`、`saveBusinessCalendar()`、`editBusinessCalendar()`、`deleteBusinessCalendar()`、`refreshTodayBusinessStatus()`、`renderBusinessCalendar()`、`openBusinessCalendarForm()`、`closeBusinessCalendarForm()`、`onBusinessCalendarModeChange()`，全部呼叫上述新 API；並掛載於既有 `loadLineBizStatus()` 內自動刷新。

## 六、LINE 前台（`public/line-order.html`）

- 命中行事曆 `closed`：整頁顯示「🌙 今日休息」，依 `show_reason` 決定是否顯示「原因：xxx」，並顯示「休假期間：M/D～M/D」與「預計 M/D 恢復營業」。
- 今日臨時休息（`line_today_closed`）優先於行事曆，訊息維持原本「🌙 今日店休」文案，不受影響。
- 命中行事曆 `custom_hours`：不阻擋下單，於公告區下方新增提示 banner「🟡 今日特殊營業」＋外帶/外送時段。
- 命中行事曆 `open_all_day`：顯示提示 banner「🟢 今日全天營業」。
- 未命中：維持原本顯示，不受影響。
- 前端顯示僅供 UX 提示，**下單前後端 `/validate-cart` 與送單 API 仍會二次驗證**，無法透過繞過前端邏輯下單。

## 七、相容性（全部保留，未刪除、未修改語意）

`line_closed_dates`、`line_closed_weekdays`、`line_today_closed` / `line_today_closed_date`、`takeout_business_hours`、`delivery_business_hours` 全部原樣保留；只有在 Business Calendar 沒有命中時才會使用（並且完全走舊程式碼路徑，行為不變）。

## 八、未變動範圍

Android（無需修改，繼續透過既有 Web API 被動取得正確結果）、LINE Pay、Google Maps 外送費、LINE 預購、訂單狀態機（`orderStatusFlow.js`）、既有 settings 儲存機制、多店 store_id 隔離機制。
