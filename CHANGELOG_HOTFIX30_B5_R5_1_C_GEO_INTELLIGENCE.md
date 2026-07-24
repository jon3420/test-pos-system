# CHANGELOG — fix18-10-hotfix30-B5-R5.1-C
## Geo Intelligence Center × Business Opportunity × Recommended Actions

---

## 一、版本基底

基底為 `fix18-10-hotfix30-B5-R5.1-B`（Geo Event Wiring × Geo Analytics API ×
Data Quality）。本輪讀過 `CHANGELOG_HOTFIX30_B5_R5_1_B_GEO_API.md`，確認
Geo API、Dashboard `geo_summary`、Geo Event Wiring 均已完成、既有 regression
全數 PASS。本輪**完全沒有修改**：Analytics Schema、`analytics_events`、
`orders`、Geo Query（`utils/geoAnalyticsQueries.js`）、Geo API
（`routes/analytics-geo.js`）、Visitor Attribution、Fulfillment/Distance
Logic——只做 UI/UX/Visualization/Business Insight，全部讀取既有 API。

## 二、完成範圍 / 未完成範圍

**已完成**：Dashboard Geo Intelligence 區塊、Business Opportunity Engine、
Recommended Actions（含 localStorage store 隔離）、Ad ROI Suggestions、
Coupon Suggestions、Delivery Fee Optimization、Expansion Ranking、Today
Insight、Geo Analytics 六個子分頁、Geo Alerts Center、Drilldown Drawer
（含 focus management）、共用篩選、分頁、排序、Lazy Load、Promise.all、
Skeleton Loading、Widget 級錯誤隔離、Accessibility、Responsive CSS、正式
182 項 jsdom smoke test、8 套件 regression。

**未完成（刻意，本輪範圍外）**：優惠券自動建立 API、LINE 推播串接、
Meta/Google Ads API、CRM Action 串接、AI 行銷中心、行政區地圖、正式 Visitor
IP Geo Provider。全部只有 UI 佔位（`geoComingSoonBadge()`）。

## 三、新增檔案

- `public/js/geo-intelligence.js` — Business Rule Engine + 全部 Geo
  Intelligence UI（Dashboard 區塊、Analytics Center Geo 分頁、Alerts
  Center、Drawer）。
- `scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js` — 182 項測試（Part A 65 項
  純函式測試 + Part B 117 項 jsdom DOM/互動測試）。
- 本檔案。

## 四、修改檔案

- `public/js/app.js` — `renderDashboardV2()` 新增一行呼叫
  `renderDashboardGeoIntelligence(data)`（`typeof` 防禦，該函式缺失或拋錯
  不影響其餘 Dashboard 區塊）。
- `public/js/analytics-v2.js` — `AV2_TABS` 新增 `['geo', '🌍 Geo
  Analytics']`；`av2Render()` 新增 dispatch 分支與 lazy-load 觸發時機（沿用
  R4 Visitor 360 已驗證過的「innerHTML 掛載後才 ensureLoaded」慣例）。
- `public/index.html` — 新增 `<script src="/js/geo-intelligence.js">`，
  於 `analytics-v2.js` 之後、`coupons.js` 之前載入。
- `public/css/main.css` — 新增 `.geo-skeleton`／`.geo-coming-soon`／
  `.geo-drawer`／`.geo-drawer-overlay` 等 scoped 規則，不更動既有規則。

## 五、前端架構

- Dashboard 首頁的「Geo Intelligence」區塊掛在 `renderDashboardV2()`
  （`app.js`，容器 `#db-body-v2`），資料來自 `GET /api/analytics/dashboard`
  已經內含的 `data.geo_summary`（R5.1-B 完成），不新增 API 呼叫。
- Analytics Center 的「🌍 Geo Analytics」分頁掛在 `av2Render()`
  （`analytics-v2.js`，容器 `#av2-body` → `#av2-geo-body`），資料來自
  `GET /api/analytics/geo/*` 七條既有 endpoint。
- 這是**兩個完全不同的頁面/容器/資料來源**，一開始開發時曾經混用測試導致
  誤判為產品 bug，詳見十三、Pagination Root Cause。

## 六、Dashboard Geo Intelligence

四張 KPI 卡（🏆 高意願區域／⚠ 高流量低轉換／🚚 履約分析／📡 Geo
Quality），資料完全來自 `geo_summary`。Quality 狀態
healthy/degraded/insufficient_data/disabled 都有對應中英混合標籤與顏色
（`geoQualityBadge()`）；未知狀態值安全退回不崩潰。KPI 卡與商機建議立即用
`geo_summary` 渲染；ROI／優惠券／外送費／開店建議四個子區塊用
`Promise.all` 一次發出 4 支 lazy API（source-area/fulfillment/distance/
funnel），每個子區塊各自 `_av2Safe()` 包裹、互不影響。

## 七、Business Opportunity Engine

`geoComputeOpportunities()`：讀 `top_intent_areas`／
`high_traffic_low_conversion`／`fulfillment_summary`，純函式、無 side
effect、無隨機性。`geoComputeAdRoi()`：加購率 70%＋轉換率 30% 加權出
1～5 星（樣本 <5 視為不足，不給評等）。`geoComputeCouponSuggestions()`：
高加購低訂單建議發券，高轉換建議不發券（避免浪費毛利），樣本 <10 不產生
建議。`geoComputeDeliveryFeeOptimization()`：轉換率 <50% 建議調整費率，
≥80% 且訂單數 ≥5 建議維持現況，`unknown` 距離帶排除在建議之外。
`geoComputeExpansionRanking()`：訪客 40%＋訂單 40%＋營收 20% 正規化加權，
資料不足時回傳空陣列（呼叫端顯示「目前資料不足以評估設點」，不虛構排行）。
`geoComputeTodayInsight()`：只描述目前資料確實支援的觀察，沒有「比昨天」
比較期間資料時絕不虛構日增減文字。全部函式皆有對應的固定輸入/固定輸出、
null/undefined 不拋錯、除以零不產生 NaN/Infinity 的單元測試。

## 八、Recommended Actions

`geoComputeRecommendedActions()` 統一資料結構（`id`/`type`/`title`/
`recommendation`/`reason`/`confidence`/`area`/`status`/`source`），涵蓋
7 種類型：`coupon`/`delivery_fee`/`advertising`/`pickup_point`/`pricing`/
`conversion`/`data_quality`，每種都沿用既有規則引擎（不重寫判斷邏輯，只是
換一種輸出格式），**只顯示建議，函式本身沒有任何 side effect，不會、也
不能自動執行任何動作**（沒有呼叫任何寫入 API）。排序：confidence
high→medium→low → 型別優先序 → area 字母序 → rule id 字母序，全程無
`Math.random()`、無 `Date.now()` 參與排序或 ID 生成，同樣輸入永遠得到
同樣輸出（已用測試驗證兩次呼叫結果 `JSON.stringify` 完全相等）。最多顯示
5 筆。文案只用「可能／趨勢顯示／建議檢查／值得評估」，測試逐一掃描確認
不含「一定／證明／就是因為／保證有效／必然成交」與「AI」字樣（排除內部
`source: 'geo-rule-engine'` 標記本身）。

狀態（標記已讀／忽略／收藏）存在 `localStorage`，key 格式：

```
pos_geo_recommended_actions_v1:<store_id>
```

不同店家的 key 完全獨立（已用跨店測試驗證：store_A 收藏的建議切到
store_B 看不到，切回 store_A 狀態仍在）。損壞的 JSON（例如
`'{broken-json'`）由 `_geoRALoadState()` 的 try/catch 安全退回空物件，
不會讓 Dashboard 白屏（已用測試驗證）。

## 九、Ad ROI / Coupon / Delivery Fee / Expansion / Today Insight（前端呈現）

四個子區塊各自用對應的 rule engine 輸出渲染成清單/星等文字，皆標示
「Coming Soon」佔位（Meta Ads/Google Ads 自動匯入、CRM 串接等），不宣稱
已經串接外部平台。

## 十、Geo Analytics 六個子分頁

`Overview`/`Visitor Funnel`/`Fulfillment`/`Distance`/`Source × Area`/
`Geo Quality`，全部沿用 R5.1-B 的 7 條既有 API（`quality`/`alerts` 之外的
6 條對應本分頁；`alerts` 獨立顯示在 Geo Alerts Center，見十二）。共用篩選
（date/channel/city/district/source/medium/campaign/geo_context）套用後
所有已載入子分頁快取失效、下次切換重新抓取；分頁用真正的 SQL
`page`/`limit`（沿用 R5.1-B API 既有分頁參數），不是前端切頁。

## 十一、Drilldown Drawer

點擊任一資料列（`<tr role="button" tabindex="0">`，支援滑鼠與
Enter/Space 鍵盤觸發）從右側滑出，顯示 Visitor→Product→Cart→Order→
Revenue 步驟（直接用該列已經抓到的資料組成，不新增 API）。關閉方式：
關閉按鈕（`aria-label="關閉"`）、ESC 鍵、點擊背景遮罩。**Focus
management**：開啟時記住觸發元素（`document.activeElement`）並把焦點
移進關閉按鈕；關閉時把焦點還給原觸發元素（若該元素已不在 DOM 上則安全
跳過）。ESC 監聽器用模組層級旗標（`_av2GeoEscListenerBound`）確保全程
只註冊一次，重複開關 100 次不會疊加監聽器（已用測試驗證：手動觸發一次
ESC，`av2GeoCloseDrawer` 只被呼叫一次，不是 100 次）。

## 十二、Geo Alerts Center

沿用 `GET /api/analytics/geo/alerts`，前端用 `geoClassifyAlertSeverity()`
把後端的 warning/info 兩級細分成 critical/high/medium/low 四級（規則
式，非 AI），依嚴重度排序。狀態（已處理/忽略/收藏）存在
`localStorage`（key: `geo_alerts_state_<store_id>`，R5.1-B 就已經是這個
命名慣例，本輪沿用不變），reload 後狀態仍在（已用測試驗證：建立全新
JS 執行環境＋沿用同一份 localStorage 內容，模擬真實瀏覽器重新整理）。

## 十三、Pagination Root Cause（本輪除錯重點）

**現象**：`TypeError: Cannot read properties of undefined (reading
'page')`，測試檔約第 470 行，`dom.window.av2GeoSetPage(0)` 呼叫附近。

**根因**：`av2GeoFilters`、`av2GeoSubTab`、`av2GeoCache` 等模組內部狀態
都是在 `geo-intelligence.js` 頂層用 `let` 宣告的。JavaScript 規範對
「Script 全域詞法環境」與「全域物件（window）」是兩件不同的事：頂層
`function` 宣告（以及舊式 `var`）會成為 `window` 的屬性；但頂層
`let`/`const`/`class` **不會**——它們只存在於該次 script 執行所共享的
詞法環境裡，無法透過 `window.xxx` 從外部讀取或寫入。這**不是 jsdom 限定
的特例，是規範本身的行為，在真實瀏覽器裡也一樣**。測試程式碼原本寫
`dom.window.av2GeoFilters.page`、`dom.window.av2GeoAlertsLoaded = false`
直接從 Node 端讀寫這些 `let` 變數，兩者都必然拿到 `undefined`（或寫入一個
完全無關、對內部邏輯毫無影響的同名新屬性）。

**這是 test harness 的設計缺陷，不是產品 bug**——因為真正的使用者是透過
瀏覽器操作 DOM（點按鈕），從來不會有「從外部直接讀寫模組內部變數」這種
存取路徑。

**最終修正方式**：
1. 把「直接讀寫內部 `let` 狀態」的斷言，全部改成**透過真實使用路徑觀察
   行為**——切換分頁、送出的 fetch URL 查詢字串、渲染出來的 DOM 內容
   （完全依照本輪指令「測試應模擬真實使用路徑」的要求重寫）。
2. 過程中額外發現一個**真正的產品缺口**：目前沒有任何 UI 控制項能改變
   `limit`（分頁大小），但需求明確要求測試「limit 改變後 page 重設為
   1」。新增了 `av2GeoSetLimit(limit)`（沿用既有 `av2GeoApplyFilter()` 的
   「套用後重設頁碼、清快取、重新抓取」慣例），這是本輪唯一因除錯而追加
   的產品程式修改，屬於補齊既有規格缺口，不是修 bug。
3. 另外發現 alerts 「reload 後狀態仍在」的測試也犯了同樣的錯（試圖用
   `dom.window.av2GeoAlertsLoaded = false` 假裝重置內部旗標），改為建立
   全新 dom/eval 環境＋帶入同一份 localStorage 內容，正確模擬「瀏覽器
   重新整理」（新的 JS 執行環境、但 localStorage 內容保留）。

## 十四、CSS.escape 相容性修正

`geoRASetStatus()` 原本用 `CSS.escape(actionId)` 組 attribute selector，
在 jsdom 環境下 `CSS` 全域物件不存在，丟出
`ReferenceError: CSS is not defined`。`CSS.escape` 並非所有執行環境都保證
存在，屬於真正的相容性風險（不只是測試環境的問題）。修正為改用
`querySelectorAll('[data-ra-id]')` 逐一比對屬性值，不依賴 `CSS.escape`。

## 十五、jsdom 共用詞法環境問題

`geo-intelligence.js` 需要直接引用 `analytics-v2.js` 頂層用 `let` 宣告的
`av2DateState`/`av2Channel`。真實瀏覽器裡，多個非 module 的 `<script>`
標籤共用同一個「Script 全域詞法環境」，後面的 `<script>` 可以直接以裸
識別字參照前一個 `<script>` 用 `let` 宣告的變數——這完全正常。但用
`dom.window.eval(sourceA); dom.window.eval(sourceB);` 分開呼叫兩次模擬
兩個 `<script>` 標籤時，jsdom（實際上是 V8 的 indirect eval 語意）並不會
讓兩次呼叫共用同一個「Script 詞法環境」，導致 `sourceB` 讀不到
`sourceA` 用 `let` 宣告的變數。修正：把 `av2Src` 與 `geoSrc` 合併成
**同一次** `eval()` 呼叫，精確重現真實瀏覽器的共用作用域行為。只調整
測試載入方式，沒有改動任何產品程式。

## 十六、Accessibility

- Geo Analytics 六個子分頁的頁籤容器有 `role="tablist"`，每個頁籤按鈕
  `role="tab"` + `aria-selected`（同時間只有一個 `true`）。
- Drawer：`role="dialog"` + `aria-modal="true"` + `aria-label`（可辨識
  標題）；關閉按鈕有 `aria-label="關閉"`。
- 錯誤狀態區塊有 `role="alert"`；loading/skeleton 區塊有
  `aria-busy="true"`。
- 所有互動列都是 `<tr role="button" tabindex="0">` 並同時支援
  `onclick` 與 `onkeydown`（Enter/Space），所有按鈕都是真正的
  `<button type="button">`，不是裸 `<div onclick>`——**唯一例外**是
  Modal 背景遮罩（`.geo-drawer-overlay`），這是刻意設計：遮罩本身不該
  進入 Tab 順序（它只是「點外部關閉」的滑鼠/觸控捷徑），真正需要鍵盤
  等效操作的關閉動作已經有 `<button aria-label>` 與 ESC 鍵兩種鍵盤可達
  路徑。
- **Focus management**：Drawer 開啟時焦點移入關閉按鈕，關閉時焦點還給
  原觸發元素（見十一）。

## 十七、Responsive

KPI 卡與各種資料卡沿用專案既有慣例
`grid-template-columns:repeat(auto-fill,minmax(Npx,1fr))`（與 `app.js`
既有 Dashboard KPI 卡片完全一致的手法），依可用寬度自動呈現
多欄／兩欄／單欄，不是額外發明一套斷點系統。`.geo-drawer` 寬度用
`min(380px, 90vw)`，確保手機上不超出 viewport；`@media (max-width:
640px)` 進一步強制 100vw；`overflow-y: auto` 讓內容過長時垂直捲動而不是
撐爆視窗。資料表格本身沿用瀏覽器預設 `<table>` 版面，長文字會自然換行
（沒有設定 `white-space: nowrap`）。

## 十八、Memory Leak Audit

執行 100 次主 Tab 切換、100 次子 Tab 切換、100 次 filter 變更、100 次
Drawer 開關：
- DOM 節點數量未線性成長（測試斷言 100 次切換後節點數 < 切換前的 3
  倍，允許有限、固定的快取結構增長，不是無限膨脹）。
- ESC 監聽器全程只註冊一次（`_av2GeoEscListenerBound` 旗標把守），開關
  100 次後手動觸發一次 ESC，`av2GeoCloseDrawer` 只被呼叫 1 次，不是
  100 次——證明沒有疊加 100 個監聽器。
- 所有互動都是 inline `onclick`/`onkeydown` 屬性（不是
  `addEventListener`），每次 `innerHTML` 重新賦值就會讓舊的 DOM 節點
  （與其屬性上的處理器）整批被垃圾回收，天生不會累積監聽器。

## 十九、Console / Global Error Audit

正常流程下：0 `TypeError`、0 `ReferenceError`、0 unhandled promise
rejection（已修正的 `CSS is not defined` 除外——修正後也是 0）。刻意模擬
的 7 條 Geo API 500 錯誤（`overview`/`funnel`/`fulfillment`/`distance`/
`source-area`/`alerts`/`quality`）都被對應 widget 的 try/catch 捕捉，
畫面顯示「此區塊暫時無法讀取」，不會冒到 `window.onerror`，也不會產生
unhandled rejection。

## 二十、Security / XSS Audit

對 `top_intent_areas` 等欄位注入 `<img src=x onerror=alert(1)>`，確認
Dashboard 渲染結果中該字串被 `escHtml()` 正確跳脫（不是原樣輸出的
`<img>` 標籤），也沒有產生任何 `onerror=` 內聯事件屬性。所有 API 提供
的動態文字（district/city/campaign/source/recommendation/reason/alert
message）在渲染前都經過 `escHtml()`（沿用 `app.js` 既有函式，未自建第二
套跳脫邏輯）。

## 二十一、測試結果

| 測試檔 | PASS | FAIL | MANUAL | exit code |
|---|---|---|---|---|
| `smoke-hotfix30-b5-r5-cart-order-hours.js` | 55/59 | 0 | 4 | 0 |
| `smoke-hotfix30-b5-r5-dashboard-ui.js` | 20/20 | 0 | 0 | 0 |
| `smoke-hotfix30-b5-r5-debounce.js` | 32/32 | 0 | 0 | 0 |
| `smoke-hotfix31-r4-channel-visitor360.js` | 116/116 | 0 | 0 | 0 |
| `smoke-hotfix31-r4-1-ui-fixes.js` | 80/81 | 0 | 1 | 0 |
| `smoke-hotfix30-b5-r5-1-a-geo-foundation.js` | 76/76 | 0 | 0 | 0 |
| `smoke-hotfix30-b5-r5-1-b-geo-api.js` | 111/111 | 0 | 0 | 0 |
| `smoke-hotfix30-b5-r5-1-c-geo-ui.js`（本輪） | 182/182 | 0 | 0 | 0 |

本輪新測試 **182 項**（要求 ≥160），Part A 純規則引擎 65 項、Part B
jsdom DOM/互動測試 117 項，全數 0 FAIL。8 套件全部 0 FAIL，沒有修改、
放寬或註解掉任何既有測試斷言。

## 二十二、Manual Required

1. 正式瀏覽器 Desktop 測試（Chrome/Edge）
2. Android 平板測試
3. 手機版（iOS/Android）實機測試
4. Safari 測試（尤其 `URLSearchParams`/CSS `min()` 相容性）
5. 正式環境 `reports` 權限瀏覽器實測
6. `GEO_ANALYTICS_ENABLED=false` 正式環境狀態實測
7. 正式營運資料量下的效能實測（本輪測試資料量小，未驗證大量區域/長期間
   查詢下的前端渲染效能）
8. 圖表與文字對實際店家資料的可讀性（長行政區名稱、極端數值）
9. Recommended Actions 文案是否符合老闆實際操作習慣（措辭、按鈕位置）
10. localStorage 跨店切換在真實登入/登出流程下的驗證（本輪只用模擬
    `currentStore` 物件測試，未走真實登入流程）

## 二十三、Known Limitations

- Recommended Actions 只顯示建議，不會、也不能執行任何動作。
- 未串優惠券建立 API、LINE 推播、Meta Ads API、Google Ads API、CRM
  Action、AI 行銷中心。
- 未做行政區地圖。
- Visitor Geo 正式 IP provider 尚未完成（見 R5.1-A/B changelog）。
- 歷史事件（R5.1-A 之前）可能沒有 Geo 資料。
- Today's Insight 若無比較期間（如「昨天」）的 API 資料，不會顯示日增減
  文字，只描述目前資料確實支援的觀察。
- Expansion Ranking 是依訪客/訂單/營收的透明加權評分，**不等於**正式的
  開店選址分析（未考慮租金、競爭、人流動線等因素）。
- Pagination 的「Next 按鈕在最後一頁」目前**沒有**禁用（`disabled`），
  而是仰賴後端回傳的下一頁資料為空；這是既有實作方式，本輪未强制修改為
  禁用按鈕（避免額外的行為變更超出本輪除錯範圍），列為已知限制而非
  bug——如需要，可在 R5.1-D 加入。
- Distance API 的 `address_resolved_events` 欄位仍如 R5.1-B changelog
  所述，恆為 0（該限制未變動）。

## 二十四、下一階段（只列規劃，不開始實作）

R5.2（暫定）可評估：行政區地圖、優惠券系統串接（真正建立優惠券，而非
只顯示建議）、正式 IP Geo Provider 選型與串接。
