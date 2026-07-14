# CHANGELOG — fix18-10-hotfix23-C｜Manager Dashboard V3 × AI 經營助理 × 趨勢分析

基礎版本：fix18-10-hotfix23-B（Analytics Foundation × Conversion Analytics × 老闆儀表板 V2）

本階段只完成 **Hotfix23-C（老闆儀表板 V3 × UX 升級）**。依需求文件開發原則，
**不重寫**：POS、Android、LINE Pay、Business Calendar、優惠券、Analytics Events、
Conversion Analytics API、Hotfix22 全部功能、Hotfix23-A／23-B 已完成功能。

---

## 1. 架構說明

沿用 Hotfix23-B 的單一 API 設計：所有 Dashboard V3 新增資料**全部附加在同一個**
`GET /api/analytics/dashboard` 回應裡（不新增端點、不重複查詢），前端仍使用同一個
`dashboardDateState` 驅動所有區塊。

新增計算全部在 `utils/dashboardAnalytics.js` 第 12 節（`getPreviousRange` 起），
純函式讀取既有查詢結果（`kpi`／`funnel`／`cart`／`repeat_customers`／`payments`／
`products`）二次加工，只有兩個地方需要「多打一次既有函式」：

1. `getKpi(db, storeId, previousRange)` —— 用來算「上一期間」KPI 才能比較成長率。
   這是功能本身需要的資料，不是重複查詢同一件事。
2. `getTrend30d(db, storeId)` —— 近 30 天彙總是全新時間範圍（過去 30 天），
   `orders` 表本身就有索引，單一查詢完成，不逐日各打一次 API。

`routes/dashboard.js`（舊版 Dashboard API）、`utils/db.js`、`utils/analyticsLog.js`、
Hotfix23-A 事件定義完全沒有修改。

---

## 2. 修改檔案清單

### 修改
- `utils/dashboardAnalytics.js` —— 新增第 12 節（12a～12i），純附加函式，未動既有
  1～11 節任何一行：
  - `getPreviousRange(range)` —— 上一期間（同長度、緊接在前）
  - `getKpiComparison(currentKpi, previousKpi)` —— 營收／訂單／客單／已結帳／未結帳
    的 ▲／▼／—、百分比、顏色
  - `getHealthScoreV2(...)` —— 健康度星級拆解（營收／轉換率／回購率／放棄率／
    LINE Pay）＋低分警示建議（購物車放棄率偏高 → 降低外送門檻／增加優惠券／
    檢查付款流程；LINE Pay 成功率偏低 → 檢查金流）
  - `getTrend30d(db, storeId)` —— 近 30 天營收／訂單／客單／回購率
  - `getProductTiers(products)` —— 🔥爆款／⭐潛力／⚠低轉換 分級
  - `getForecast(kpi, range)` —— 今日預估營收（見下方「假設」）
  - `getTodaySummary(realtime, forecast, kpi)` —— 今日重點摘要
  - `getTodoList(db, storeId, incomplete, repeat)` —— 今日待處理事項
  - `getDailyTip(recommendations, productTiers, products, cart)` —— 每日一句
    AI 經營建議（Rule Based，不呼叫 AI API）
- `routes/analytics.js` —— `GET /api/analytics/dashboard` 回應新增以下欄位（既有
  欄位一律不變、順序不變）：`kpi_comparison`、`health_score_v2`、`trend_30d`、
  `product_tiers`、`forecast`、`today_summary`、`todo_list`、`ai_daily_tip`
- `public/js/app.js` —— 新增 Dashboard V3 渲染函式，插入既有 `renderDashboardV2()`
  組裝順序中，既有函式（`renderDashboardHealth`／`renderDashboardKpi`／
  `renderDashboardFunnel`／`renderDashboardProducts` 等）**保留未刪除**（供除錯／
  回退參考），實際渲染改呼叫新函式：
  - `renderDashboardTodo()` —— 📋 今日待處理（首頁最上方）
  - `renderDashboardHome()` —— Good Evening 老闆／今日營收／健康度／在線／預估／
    AI 建議 Hero 卡片（僅 `preset==='today'` 時顯示）
  - `renderDashboardKpiV3()` —— KPI 卡片＋成長比較（沿用 `renderDashboardKpi` 其餘
    內容：週月營收／付款方式／熱銷排行 TOP10 原樣保留）
  - `renderDashboardHealthV2()` —— 星級健康度＋警示建議
  - `renderDashboardTrend30d()` —— 近 30 天營收／訂單／客單／回購率折線（純 SVG
    `<polyline>`，未新增任何圖表套件）
  - `renderDashboardFunnelV2()` —— 真正梯形 Funnel（資料來源與 Hotfix23-B 完全相同）
  - `renderDashboardProductsV2()` —— 🏆🥈🥉 TOP3 卡片＋分級標籤（沿用
    `renderDashboardProductsTable()` 排序邏輯，新增分級欄位）
  - `.db-v3-hover` CSS class —— 卡片陰影／hover 效果，維持 Dark Theme

### 未修改（依需求文件明確排除）
- `routes/dashboard.js`（舊 Dashboard API）
- `utils/db.js`、`utils/analyticsLog.js`（Hotfix23-A schema／事件定義）
- Android、POS、LINE Pay、優惠券、Business Calendar 等既有模組
- `public/index.html`（容器仍是空的 `#reports-container`，內容由 JS 動態產生）

---

## 3. 重要假設（需與老闆確認的簡化設計）

1. **今日預估營收的「營業時間」**：系統目前沒有「店鋪營業時間」設定欄位，本期
   先用假設常數 **10:00～22:00（共 12 小時）** 計算「已營業時間」與「今日總營業
   時間」。公式：`目前營收 ÷ 已營業時間 × 今日總營業時間`（純規則，不用 AI）。
   若之後要接上真實營業時間設定，只要替換 `utils/dashboardAnalytics.js` 裡的
   `DEFAULT_BUSINESS_START_HOUR` / `DEFAULT_BUSINESS_END_HOUR` 常數即可，不需要
   改資料結構。
2. **KPI 成長比較的「上一期間」**：一律取「與目前查詢區間**同長度、緊接在前**」
   的區間（例如今日 vs 昨日；本週已過 3 天 vs 上週同樣前 3 天）。這是最常見的
   環比定義，但如果實際需求是「去年同期」或固定「上週同一天」，需要另外調整
   `getPreviousRange()`。
3. **健康度星級門檻**：本期星級門檻（如回購率 ≥40% 才 5 星）是初版合理假設，
   實際上線後建議依店家真實數據分布微調，門檻集中在
   `utils/dashboardAnalytics.js` 的 `_toStars()` 呼叫處，方便之後調整。
4. **今日待處理「商品庫存不足」**：只統計 `inventory_enabled=1` 且
   `current_stock_grams <= low_stock_alert` 的商品，沿用既有庫存欄位，未新增
   任何庫存判斷邏輯。
5. **首頁 Hero 模式**只在 `preset==='today'`（今日視圖）時顯示；查詢昨日／本週／
   自訂區間時，KPI 成長比較與健康度星級仍然正常顯示，但不顯示「Good Evening」
   Hero 卡片（不同日期沒有「今天」語意）。

---

## 4. 驗收對照

| 需求文件項目 | 狀態 |
|---|---|
| ✅ KPI 正確比較上一期間 | 完成（`kpi_comparison`） |
| ✅ 健康度正常 | 完成（`health_score_v2` 星級＋警示） |
| ✅ AI 建議正常 | 完成（Rule Based `ai_daily_tip`，未呼叫 AI API） |
| ✅ 今日重點正常 | 完成（`today_summary` ＋ Hero 卡片） |
| ✅ 趨勢圖正常 | 完成（`trend_30d`，純 SVG，未新增圖表套件） |
| ✅ Funnel 正常 | 完成（`renderDashboardFunnelV2`，資料來源不變） |
| ✅ 商品排行正常 | 完成（TOP1/2/3 ＋ 🔥爆款／⭐潛力／⚠低轉換） |
| ✅ 即時狀態正常 | 沿用 Hotfix23-B `getRealtime()`，未修改 |
| ✅ 營收預估正常 | 完成（`forecast`，見上方假設 1） |
| ✅ Dashboard 不新增重複 API | 完成，全部附加在同一個 `/api/analytics/dashboard` |
| ✅ 不影響既有報表／POS／Android／LINE Pay／Business Calendar | 完成，相關檔案未修改 |

### 十六、Hotfix23-D 預留（本階段依需求文件明確**不實作**）

Meta Pixel／Meta Conversion API／GA4／Google Ads／UTM／fbclid／gclid／LINE OA／
Email 催單／購物車放棄提醒／自動優惠券／廣告 ROAS／LTV／AI 廣告成效分析／
AI 自動經營建議／AI 每日推播摘要 —— 皆未實作、亦未預先建立資料表或 API 骨架，
待 Hotfix23-D 需求確認後再開發，避免現在猜錯結構要重寫。
