# CHANGELOG — Business Calendar V2 Hotfix14（UI/UX 優化）

日期：2026-07-04
基礎版本：Business Calendar V2（Hotfix13）
本次性質：**純 UI / UX 調整，CSS 優先，未新增/修改任何 API，未變更任何判斷邏輯**

## 修改原則（本次嚴格遵守）

1. 未重寫 LINE 營業設定頁，僅在既有結構上局部調整。
2. 未破壞任何既有功能（LINE 點餐 / 外帶 / 外送 / Business Calendar API / 特殊營業日 / 今日臨時休息 / 外帶規則 / 外送規則 / 預購）。
3. 以 CSS 為主，JS 改動僅限「純畫面呈現」用途（例如日期選單標籤文字、顏色 class），未動到任何後端 API 或下單判斷邏輯。
4. 未修改 `routes/business-calendar.js`、`routes/line-orders.js`、`routes/settings.js`、`server.js`、`utils/db.js`（本次無後端變更）。

## 一、Business Calendar 卡片高度優化（①）

- `main.css`：`.settings-grid` 新增 `align-items: start`，避免同列卡片被拉伸到最高卡片的高度（這也是造成「只有一筆資料仍保留大量空白」的根本原因）。
- 新增 `.settings-card { height: auto; }`，卡片依內容自動撐開，不使用固定高度。

## 二、日期選單改善（②④）

`public/line-order.html`：
- 新增 `bizCalendarList`（於 `init()` 內平行呼叫既有的 `GET /api/settings/business-calendar` 取得列表，唯讀，未新增 API）。
- 新增純前端顯示用函式 `findBizCalEntry()`、`bizCalOptionSuffix()`、`bizCalRangeWarning()`。
- `buildDateSelector()` 與「明日預購」日期產生邏輯，選項文字格式改為 `MM/DD(週)` + 顏色圖示：
  - 命中 Business Calendar `closed` → `🔴 店休（原因）`（`show_reason=false` 時不顯示原因，只顯示 `🔴 店休`）
  - 命中 `custom_hours` → `🟡 特殊營業`
  - 命中 `open_all_day` → `🟢 全天營業`
  - 沒有命中 → 完全維持舊有「每週公休/非營業日」判斷與文字，不受影響
- 日期選單上方新增 `#pDateCalWarning` 提示區塊，若可視日期範圍內有連續休假（`mode=closed`），顯示如「⚠️ 7/5～7/8 員工旅遊休假中」（`show_reason=false` 時不含原因，顯示「⚠️ 7/5～7/8 休假中」）。
- **重要**：此區塊僅為前台選單的 UX 提示，實際下單仍完全由後端 `/validate-cart`、送單 API 做二次驗證（priorities 不變：今日臨時休息 ＞ Business Calendar ＞ 每週營業時間），不可能被前端繞過。

## 三、顏色（③）

`main.css` 新增 `.bc-item` 系列 class，後台「營業行事曆」列表項目依模式顯示左側色條：
- `mode=closed` → 紅色（`#e53935`）
- `mode=custom_hours` → 橘色（`#f9a825`）
- `mode=open_all_day` → 綠色（`#06C755`）

`public/js/app.js` 的 `renderBusinessCalendar()` 只新增 `class="bc-item bc-${item.mode}"`，樣式全部交由 CSS 控制，未變更任何資料邏輯。

## 四、LINE 營業設定版面優化（⑤）

- `.settings-grid` 由固定 `grid-template-columns: 1fr 1fr` 改為 `repeat(auto-fit, minmax(360px, 1fr))`（1600px 以上為 `minmax(420px, 1fr)`），卡片依可視寬度自動排列，減少大螢幕右側空白，維持手機版原本的單欄 media query 不變。

## 五、LINE 點餐付款方式（⑥）

`public/index.html`：`#linePaymentToggles` 由直排 `flex-direction:column` 改為兩欄 `display:grid;grid-template-columns:1fr 1fr`，並將顯示順序調整為「現金／LINE Pay、信用卡／平台付款、轉帳」；`main.css` 同步縮小欄位間的 `margin-bottom`，降低整體高度。JS 儲存邏輯（`saveLinePaymentSettings()`）完全未變動，仍以 element id 讀值。

## 六、舊版營業時間收合（⑦）

`public/index.html`：原本一直展開的「LINE 整體營業時間（舊版相容）」卡片，改用原生 `<details>`／`<summary>` 包裹，預設收合（無 `open` 屬性），點擊標題展開。純 HTML/CSS 實作，未使用額外 JS 控制顯示/隱藏，內部欄位 id（`set-line_business_hours_enabled`、`bizHoursGrid` 等）與既有儲存邏輯完全不變。

## 七、今日營業摘要（⑧，補充項目）

新增小卡片「📋 今日營業摘要」，放在「🚦 當前接單狀態」卡片旁（同一列，利用 auto-fit 排版），內容：
- 直接複用 `#businessCalendarTodayStatus` 已渲染好的今日狀態文字（不重複呼叫 API）
- 從既有的 `_businessCalendarCache`（`loadBusinessCalendar()` 已抓取）找出「下一次休假」（最近一筆尚未結束的 `mode=closed` 項目）並顯示日期區間與原因
- 新增 `renderTodaySummary()` 函式，掛在 `refreshTodayBusinessStatus()` 與 `loadBusinessCalendar()` 完成後（`finally` 區塊）自動更新，**未新增任何 API 呼叫**

## 八、響應式（⑨）

- `.settings-grid` 使用 `auto-fit` + `minmax()`，在 1280 / 1366 / 1600 / 1920 寬度下會自動產生對應欄數（約 3～5 欄），卡片不會因固定 50% 寬度而在寬螢幕上過度拉伸或在窄螢幕上被壓縮跑版。
- 既有 `@media (max-width:768px)` 手機版單欄設定完全保留、未受影響。
- 「營業行事曆」「今日營業摘要」卡片皆為 `height:auto`、`flex-wrap` 排版，不會因欄寬變化而跑版。

## 九、不可破壞確認（⑩）

本次修改範圍侷限於 `public/index.html`、`public/js/app.js`（僅新增/微調畫面渲染函式）、`public/line-order.html`（僅新增顯示用 helper）、`public/css/main.css`。以下功能經 API 測試與程式碼比對，確認邏輯完全未變動：
- LINE 點餐總開關 / 今日臨時休息 / 每週營業時間 / 外帶外送獨立開關 / 最短備餐時間 / 今日最後接單時間 / LINE 預購 / Business Calendar 判斷優先序（今日臨時休息 ＞ Business Calendar ＞ 每週營業時間）。

## 十、驗證結果

- `node --check` 全數通過：`routes/business-calendar.js`、`routes/line-orders.js`、`routes/settings.js`、`server.js`、`utils/db.js`、`public/js/app.js`、`public/line-order.html`（抽取後的 inline JS）。
- HTML id 檢查：所有新增 JS 參照的 element id（`bc-*`、`businessCalendar*`、`todaySummary*`、`pDateCalWarning`）皆在對應 HTML 中存在且唯一。
- API 端對端測試：Business Calendar CRUD（新增 4 種模式含 `show_reason=false`）、`/api/line-shop`、`/api/line-timeslots`、`/api/line-validate-cart` 全數行為正確，測試資料已清除。
- 前端日期選單邏輯以相同資料在 Node 環境下單獨模擬驗證，輸出符合規格：
  - `07/05(日) 🔴 店休（員工旅遊）` ～ `07/08(三) 🔴 店休（員工旅遊）`
  - `08/01(六) 🔴 店休`（`show_reason=false`，不顯示原因）
  - `09/17(四) 🟡 特殊營業`
  - `12/24(四) 🟢 全天營業`
  - 連續假期警示：`⚠️ 7/5～7/8 員工旅遊休假中`
