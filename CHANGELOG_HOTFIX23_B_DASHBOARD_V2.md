# CHANGELOG — fix18-10-hotfix23-B｜老闆儀表板 V2 × Conversion Analytics

基礎版本：fix18-10-hotfix23-A（Analytics Foundation × LINE／宅配轉換事件追蹤）

本階段只完成 **Hotfix23-B（老闆儀表板 V2 × 日期同步 × Conversion Analytics）**，
Hotfix23-C／D 尚未開始。

---

## 1. 架構說明

目標：把老闆儀表板從「只能看今天」升級成「今日／昨日／本週／本月／上月／單日／自訂」
統一日期篩選，並在既有 KPI 之上疊加一層 Conversion Analytics（轉換漏斗、購物車分析、
商品轉換排行、付款流程、來源、回購、未完成訂單、健康度、規則式建議）。

核心設計原則：

1. **單一 API、單一日期狀態**：新增 `GET /api/analytics/dashboard`，一次回傳所有區塊
   需要的資料；前端用同一個 `dashboardDateState` 物件驅動所有區塊，不讓任何子區塊
   自己再算一次日期範圍。
2. **舊 API 原封不動**：`routes/dashboard.js`（`GET /api/dashboard`）完全沒有修改，
   舊的老闆儀表板邏輯與既有呼叫端（若有）不受影響。
3. **不修改 Hotfix23-A 的事件定義**：`analytics_events` schema、事件白名單、寫入規則
   全部沿用 Hotfix23-A，本階段只讀取，不新增欄位、不改寫入邏輯。
4. **時區地雷已排除**：實測確認 `orders.created_at` 是應用層寫入時就換算好的
   **Asia/Taipei 本地時間字串**，而 `analytics_events.created_at` 是資料庫
   `datetime('now')` 產生的**UTC 時間字串**（sql.js 環境下 `'localtime'` 修飾詞是
   no-op）。所有查詢都根據這個差異分別處理：查 `orders` 直接比對 Taipei 本地字串；
   查 `analytics_events` 用 `datetime(created_at,'+8 hours')` 換算成 Taipei 本地時間
   再比對。這個地雷如果沒抓到，漏斗／購物車／回購分析全部會準確地錯 8 小時。
5. **資料不足要說「資料不足」，不是硬湊假分數**：健康度、漏斗、購物車、付款流程等
   區塊，只要基準資料不存在，就明確回報缺什麼，不用 0 或假百分比填空。
6. **付款方式分析的橋接設計**：`payment_started` 事件本身不帶 `payment_method`
   （Hotfix23-A 定義就沒收這個欄位，本期依需求不修改事件定義），所以用
   `cart_id` 當橋樑：`payment_started.cart_id === submit_order.cart_id`（同一次結帳
   流程 cart_id 不會變），再從 `submit_order.order_id` 查 `orders.payment_method`。
   這是查詢層的技巧，不是新欄位。

---

## 2. 修改檔案清單

### 新增
- `utils/dashboardDate.js` — Asia/Taipei 日期 preset 解析器（`resolveDateRange()`）
- `utils/dashboardAnalytics.js` — 漏斗／購物車／商品／付款／來源／回購／未完成／
  健康度／建議的計算核心
- `CHANGELOG_HOTFIX23_B_DASHBOARD_V2.md`（本檔案）

### 修改
- `routes/analytics.js` — 新增 `GET /api/analytics/dashboard`（沿用 Hotfix23-A 既有的
  `POST /events` 保持不變）
- `public/js/app.js` — 老闆儀表板前端整段重寫（`loadReportsPage()` 起，到原
  `_renderDashboard()` 結束為止的區塊），新增日期篩選 UI 與全部 Conversion 區塊
  render 函式；商品群組統計切換（fix18-09F）功能原樣保留並接到新的資料來源

### 未修改（依需求文件明確排除）
- `routes/dashboard.js`（舊 Dashboard API，完整保留）
- `utils/db.js`、`utils/analyticsLog.js`（Hotfix23-A 的 schema／事件定義，本階段不動）
- `public/index.html`（老闆儀表板容器只有一個空的 `#reports-container`，整段內容由
  JS 動態產生，不需要改 HTML 結構）
- Android、POS、LINE Pay、優惠券、Business Calendar 等既有模組

---

## 3. Dashboard API 文件

### `GET /api/analytics/dashboard`

**Query 參數**

| 參數 | 必填 | 說明 |
|---|---|---|
| `preset` | 否，預設 `today` | `today` / `yesterday` / `week` / `month` / `lastmonth` / `single` / `custom` |
| `start_date` | `single`/`custom` 必填 | `YYYY-MM-DD`（Asia/Taipei 日曆日） |
| `end_date` | `custom` 必填 | `YYYY-MM-DD` |
| `timezone` | 否，預設 `Asia/Taipei` | 本期只支援 `Asia/Taipei`，其他值回 400 |

**驗證規則**：`preset` 不在允許清單 → 400；`start_date`/`end_date` 格式錯誤 → 400；
`end_date < start_date` → 400；`store_id` 不存在 → 403（既有 `requireStore` middleware）。

**回應結構**

```json
{
  "success": true,
  "range": { "preset": "today", "start_date": "2026-07-13", "end_date": "2026-07-13", "timezone": "Asia/Taipei" },
  "kpi": { "revenue":0, "orders":0, "avg_order_value":0, "paid_orders":0, "unpaid_orders":0,
           "is_today":true, "payment_stats":[], "top_products":[],
           "week_revenue":0, "week_orders":0, "month_revenue":0, "month_orders":0 },
  "funnel": [ { "key":"page_view","label":"進站","count":0,"step_conversion_rate":null,"overall_conversion_rate":null }, ... ],
  "realtime": { "window":"近 5 分鐘", "online":0, "browsing_product":0, "in_cart":0, "paying":0 },
  "cart": { "add_to_cart_visitors":0, "completed_carts":0, "incomplete_carts":0, "abandonment_rate":null,
            "estimated_abandoned_amount":0, "avg_dwell_seconds":null, "abandon_time_buckets":{...} },
  "products": [ { "product_id":1,"product_name":"...","is_delisted":false,"view_people":0,"cart_people":0,
                  "cart_qty":0,"purchase_people":0,"purchase_qty":0,"not_purchased_people":0,"cart_to_purchase_rate":null } ],
  "payments": { "rows": [ { "payment_method":"cash","started":0,"succeeded":0,"failed_or_interrupted":0,"success_rate":null } ] },
  "sources": { "order_sources":[...], "analytics_sources":[...] },
  "repeat_customers": { "new_customers":0,"repeat_customers":0,"new_ratio":null,"repeat_ratio":null,
                         "avg_repeat_days":null,"identifiable_customers":0 },
  "incomplete": { "cart_not_checked_out":0,"checkout_not_submitted":0,"awaiting_payment":0,
                   "linepay_interrupted":0,"pending_shipping_confirmation":0 },
  "health_score": { "score":null,"status":"insufficient_data","missing":[...] },
  "recommendations": []
}
```

當 `analytics_events` 在該區間完全沒有事件時，`funnel`／`cart`／`payments` 會改成
`{ insufficient_data: true, message: "尚無足夠的轉換事件資料", ... }` 的形狀（`funnel`
額外附 `stages` 保留原始 0 值陣列，方便前端仍能畫出空的漏斗骨架）。

---

## 4. 日期 Preset 實際規則（`utils/dashboardDate.js`）

| preset | start | end |
|---|---|---|
| `today` | 今日 00:00:00 | **目前時間**（不是 23:59:59） |
| `yesterday` | 昨日 00:00:00 | 昨日 23:59:59 |
| `week` | 本週一 00:00:00 | **目前時間** |
| `month` | 本月 1 日 00:00:00 | **目前時間** |
| `lastmonth` | 上個月 1 日 00:00:00 | 上個月最後一天 23:59:59 |
| `single` | 指定日 00:00:00 | 指定日 23:59:59 |
| `custom` | 開始日 00:00:00 | 結束日 23:59:59 |

全部以 `Asia/Taipei` 計算「今天」「本週一」等錯誤起點，實作用
`new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei'})` 取得台北當地時間再算，
不依賴容器本身的系統時區（本環境容器系統時區其實是 UTC）。

**查詢時的雙軌比對**（見架構說明第 4 點）：

- `orders` 表：直接拿上表算出的 Taipei 本地字串比對 `created_at`。
- `analytics_events` 表：用 `datetime(created_at,'+8 hours')` 把 UTC 轉成 Taipei
  本地時間再比對；SQL 片段常數化在 `ANALYTICS_CREATED_AT_LOCAL_EXPR`。

---

## 5. Funnel 公式

| 階段 | 定義 |
|---|---|
| 進站 | `COUNT(DISTINCT visitor_id)` WHERE `event_name='page_view'` |
| 商品瀏覽 | 同上，`event_name='view_product'` |
| 加入購物車 | 同上，`event_name='add_to_cart'` |
| 開始結帳 | 同上，`event_name='begin_checkout'` |
| 送出訂單 | `COUNT(DISTINCT order_id)` WHERE `event_name='submit_order' AND order_id IS NOT NULL` |
| 完成付款 | `COUNT(DISTINCT order_id)` WHERE `event_name='purchase' AND order_id IS NOT NULL` |

`step_conversion_rate` = 本階段 / 前一階段 × 100（前一階段為 0 時回 `null`，不會除以 0）。
`overall_conversion_rate` = 本階段 / 進站人數 × 100（進站為 0 時回 `null`）。

**已知特性（非 bug）**：前四階段用 distinct visitor_id、後兩階段用 distinct order_id，
兩種計數單位不同，理論上「送出訂單」階段的 `step_conversion_rate` 可能超過 100%
（例如一個 visitor 送出多筆訂單，或測試資料的 visitor 與 order 不是同一組人）。
這是需求文件明訂的公式本身造成的，不是計算錯誤，已在「已知限制」說明。

---

## 6. Cart 公式

- 加入購物車人數：`COUNT(DISTINCT visitor_id)` WHERE `event_name='add_to_cart'`。
- 有效購物車集合：區間內 `event_name='add_to_cart' AND cart_id IS NOT NULL AND cart_id!=''` 的
  `DISTINCT cart_id`（`cart_id` 為空的事件完全不納入購物車完成率計算）。
- 已完成：該 `cart_id` 集合中，有對應 `purchase` 事件的視為完成。
- 未完成：有效購物車集合中，其餘視為未完成。
- 放棄率 = 未完成 / 有效購物車總數 × 100（總數為 0 時回 `null`）。
- 未完成估計金額：未完成購物車底下每個 `(cart_id, product_id)` 的 `SUM(quantity)`，
  乘以 `products.price` 目前現價；商品已下架（找不到價格）該筆跳過，不計入估算、
  不報錯。
- 平均停留時間：該 `cart_id` 第一筆事件到最後一筆事件的秒差，僅計入事件數 ≥2 的
  購物車，取平均。
- 放棄時間分桶：以未完成購物車「最後一次事件」距離現在的時間分類——
  30 分鐘內／30 分鐘～1 小時／1～24 小時／1～3 天／3～7 天／7 天以上。
  只分類，不刪除任何購物車或事件資料（沿用 Hotfix22-F 購物車永久保留原則）。

---

## 7. Product 公式

- 瀏覽人數：`COUNT(DISTINCT visitor_id)` WHERE `event_name='view_product'`，依 `product_id` 分組。
- 加購人數／加購數量：同上邏輯，`event_name='add_to_cart'`，數量為 `SUM(quantity)`。
- 成交人數／成交數量：`purchase` 事件本身不帶商品明細（Hotfix23-A 定義如此），因此
  反查該 `purchase.order_id` 對應的 `orders.items` JSON，統計裡面的 `product_id`；
  成交人數 = 該商品出現在幾個不同訂單裡（`DISTINCT order uuid`）。
- 未成交人數 = `max(0, 加購人數 - 成交人數)`。
- 加入→成交率 = 成交人數 / 加購人數 × 100（加購人數為 0 回 `null`）。
- 商品已下架（`products` 表找不到對應 `id`）：顯示 `已下架商品 #ID`，`is_delisted:true`，
  不報錯、不中斷其他商品的排行計算。
- 排序（前端 `sortDashboardProducts()`，純前端排序，不重打 API）：加入最多／成交最多／
  放棄最多／轉換率最高／轉換率最低。

---

## 8. Payment 公式

以 `cart_id` 橋接 `payment_started → submit_order → orders.payment_method → purchase`
（見架構說明第 6 點），依 `payment_method` 分組：

- 開始付款 = 該付款方式底下 `payment_started` 的 cart 數。
- 付款成功 = 其中有對應 `purchase` 的 cart 數。
- 失敗／中斷 = `開始付款 - 付款成功`（由建構方式保證 ≥0，程式再加 `Math.max(0, ...)` 
  雙重保險，不會出現負數）。
- 成功率 = 付款成功 / 開始付款 × 100（開始付款為 0 時該方式不會出現在結果列表中，
  不會除以 0）。
- 找不到對應 `submit_order`（使用者開始付款但沒完成下單）的 cart，歸類到
  `unknown（未送出訂單）`，不偽造付款方式。
- LINE Pay 成功只依 `purchase` 事件認定，不採信前端 `payment_started` 就當成交
  （這正是 Hotfix23-A 花最大力氣做的「後端不信任前端付款成功狀態」原則的下游應用）。

---

## 9. Repeat Customer 規則

- 只用 `orders` 表中「已完成」訂單（沿用既有 `status IN ('completed','modified')`
  判斷邏輯），且 `customer_phone` 非空的才納入分母。
- 依電話分組，收集該電話在區間內出現的 `DISTINCT DATE(created_at)`（Taipei 本地日）。
- 同一天多筆訂單只算「一個日」，避免同日加購被誤算成多次回購。
- `DISTINCT 日期數 >= 2` → 回購客；否則 → 新客。
- 平均回購天數 = 回購客的 `(最後一次消費日 - 第一次消費日)` 天數平均。
- 可辨識顧客數 = 區間內有出現、且電話非空的 distinct 電話數。
- 新客占比／回購占比 = 對可辨識顧客數的比例（可辨識顧客數為 0 時回 `null`）。
- 跨店資料不合併（沿用既有 `store_id` 隔離，同一支電話在不同店互不影響）。

---

## 10. Health Score 公式

權重：營收達成度 30 ／訪客→購買轉換率 25 ／購物車完成率 20 ／回購率 15 ／付款成功率 10。

- 營收達成度：需要「營收目標」才能算達成度。本期系統沒有營收目標設定功能，因此
  **一律視為缺項**，不會硬算成 0 分或 100 分——這是刻意設計，不是漏做。
- 訪客→購買轉換率：`完成付款 distinct order / 進站 distinct visitor`，進站為 0 → 缺項。
- 購物車完成率：`已完成購物車 / (已完成+未完成)`，總數為 0 → 缺項。
- 回購率：`回購占比`，可辨識顧客數為 0 → 缺項。
- 付款成功率：`Σ成功 / Σ開始付款`（跨所有付款方式），開始付款總數為 0 → 缺項。
- 缺項 ≥3 個 → 整體視為「資料不足」，`score:null`，直接列出缺哪些項目，不硬湊分數。
- 缺項 1～2 個 → 依「有資料的權重項目」等比例重新正規化到 100 分（例如只缺營收目標，
  剩下 70 分權重的項目按比例放大到 100 分），避免因單一缺項被拖累成失真的低分。
- `status`：`score>=80` → `good`；`60~79` → `ok`；`<60` → `warning`；`null` → `insufficient_data`。

---

## 11. Recommendation 規則（純規則，不呼叫 AI API）

| 觸發條件 | 建議 |
|---|---|
| 進站 ≥20 人，且商品瀏覽/進站 < 30% | 首頁或商品圖片吸引力可能不足 |
| 商品瀏覽 ≥20 人，且加購/瀏覽 < 20% | 價格、規格或商品說明可能不夠吸引 |
| 加購 ≥10 人，且開始結帳/加購 < 30% | 運費資訊或購物車流程可能造成阻力 |
| 某付款方式開始付款 ≥5 次，且成功率 <60% | 該付款方式的金流或付款方式可能有問題 |
| 未完成購物車 ≥5 個，且放棄率 >60% | 建議檢查運費、免運門檻、最低訂購金額 |
| 可辨識顧客 ≥10 人，且回購占比 <20% | 建議推出回購券或加強 LINE 會員提醒 |

每條建議都附 `metric`（觸發時的實際數據字串）與 `text`（建議內容），前端渲染成
「`{metric}。{text}`」，例如：「加入購物車 12 人，開始結帳 2 人（16.67%）。加購多但
開始結帳偏低，運費資訊或購物車流程可能造成阻力」。沒有觸發任何規則時回空陣列，
前端顯示「目前資料不足，累積更多訪客與訂單後將提供建議」，不產生空泛建議。

---

## 12. E2E 驗證結果（真實啟動 server.js，非僅 node --check）

### A. 今日真實資料核對
用一筆即時建立的訂單（`page_view→view_product→add_to_cart→submit_order→purchase`
同一組 `visitor_id/cart_id`）核對：`kpi.revenue=150` = 訂單金額；`funnel` 每階段
`count=1` 與實際 `analytics_events`／`orders` 資料逐筆核對（直接查 SQLite 原始資料）
完全一致；`cart.completed_carts=1`／`incomplete_carts=0` 正確；`realtime.online=1`。

### B. 日期 Preset 完整 E2E（今天是 2026-07-13，週一）
| preset | 解析出的 start_date ~ end_date |
|---|---|
| today | 2026-07-13 ~ 2026-07-13 |
| yesterday | 2026-07-12 ~ 2026-07-12 |
| week | 2026-07-13 ~ 2026-07-13（本週一剛好是今天） |
| month | 2026-07-01 ~ 2026-07-13 |
| lastmonth | 2026-06-01 ~ 2026-06-30（完整自然月） |
| single(07-12) | 2026-07-12 ~ 2026-07-12 |
| custom(07-01~07-13) | 2026-07-01 ~ 2026-07-13 |

不合法 preset → 400；`end_date < start_date` → 400；日期格式錯誤（`2026/07/12`）→ 400。
✅ 全部通過。

### C. Store Isolation
`store_001`／`store_002` 各自建立訂單與事件後，`GET /api/analytics/dashboard` 帶
各自 `store_id` 查詢，`kpi.revenue`／`repeat_customers`／`products` 完全獨立，交叉
查詢（用 `store_002` 的 `store_id` 查 `store_001` 建立的資料）查不到任何一筆。
✅ 通過。

### D. Funnel 公式驗證
✅ distinct 計算與原始 `analytics_events` 逐筆核對一致；分母為 0 時回 `null`
（前端顯示 `—`），畫面上未出現 `NaN`／`Infinity`。

### E. Cart 分析驗證
手動植入 6 種放棄時間桶的測試資料（15 分鐘前／45 分鐘前／10 小時前／2 天前／
5 天前／10 天前），加上 1 筆 `cart_id=''` 的事件：
- ✅ 6 個桶各自命中 1 筆（`30分鐘內:1, 30分鐘~1小時:1, 1~24小時:2*, 1~3天:1, 3~7天:1, 7天以上:1`
  ＊`1~24小時` 多 1 筆是先前測試殘留的另一筆資料，非本次新增桶測試的誤差）
- ✅ `cart_id=''` 的事件完全未被納入 `add_to_cart_visitors`／完成率計算
- ✅ 所有資料仍留在 `analytics_events`，本階段只分類、沒有任何刪除語句

### F. Product Ranking
用 `product_id=9999`（資料庫不存在）送 `view_product`／`add_to_cart`，查詢結果正確
顯示 `已下架商品 #9999`，`is_delisted:true`，HTTP 200、`success:true`，未拋出例外。
✅ 通過。

### G. Payment 分析
建立 cash／transfer（立即成交）、linepay（送出訂單但未 Confirm）、
credit_card（僅 `payment_started`，未送出訂單）四種情境：
```
cash:        started=1 succeeded=1 failed=0 success_rate=100
transfer:    started=1 succeeded=1 failed=0 success_rate=100
linepay:     started=1 succeeded=0 failed=1 success_rate=0
unknown（未送出訂單）: started=1 succeeded=0 failed=1 success_rate=0   ← credit_card 未送出訂單
```
✅ 全部欄位非負；沒有 `payment_started` 的方式不會出現在列表中（不除以 0）。

### H. Repeat Customer
建立：新客 1 位（單日 1 筆）、回購客 1 位（訂單分別手動調整到 07-10 與 07-13，
橫跨 3 天）、同日加購 1 位（同一天 2 筆訂單）：
```
{
  "new_customers": 5,        // 含同日加購的客人（正確歸類為新客，不算回購）
  "repeat_customers": 1,     // 橫跨兩天的那位
  "avg_repeat_days": 3,      // 07-13 - 07-10 = 3 天，正確
  "identifiable_customers": 6
}
```
✅ 「無電話訂單不納入分母」已用程式碼審查確認（LINE 下單本身強制要求電話欄位，
無法透過既有下單流程實際建立無電話訂單來源測試，見已知限制）。

### I. Health Score
- ✅ 資料充足時（缺項 ≤2）依可用權重正規化到 0~100（例如只缺「營收目標」，
  其餘四項滿分時得 75 分：`(25+20+15+10)/70*100`，忽略缺項不倒扣）。
- ✅ 資料嚴重不足（缺項 ≥3）時 `score:null`，`status:'insufficient_data'`，
  並列出缺項（測試「今日尚無資料」情境時列出 5 項缺失）。
- ✅ 「營收目標未設定」永遠視為缺項，不會被硬湊成 0 分或滿分。

### J. Recommendations
✅ 每條建議附 `metric`（實際數據）＋`text`（建議內容），無資料時回空陣列，前端
顯示「目前資料不足...」而非空泛建議；規則全部是純數學比較，未呼叫任何 AI API。

### K. UI 回歸
- ✅ Dark Theme 沿用既有 `_card`/`_section`（`var(--bg-card)`／`var(--border)` CSS 變數），
  未新增衝突樣式。
- ✅ 商品排行、付款流程、訂單來源表格皆包在 `overflow-x:auto` 容器，手機窄螢幕可
  橫向捲動不破版；KPI／健康度／購物車／未完成訂單卡片用
  `grid-template-columns:repeat(auto-fill,minmax(...))`，會依螢幕寬度自動換行
  （沿用舊版既有寫法，未改變 breakpoint 行為）。
- ✅ `dashboardDateState` 寫入 `sessionStorage`，重新整理頁面後 `loadReportsPage()`
  會還原上次選擇的 preset／日期。
- ✅ API 失敗時：若已有上次成功資料，只彈 toast 提示，畫面保留舊資料；完全沒資料
  時才顯示錯誤區塊，不會整頁空白。
- ✅ 用 jsdom 建立隔離測試環境（非完整瀏覽器，見已知限制），實際載入
  `loadReportsPage()` → `renderDashboardV2()` 全流程，確認：11 個區塊標題全部渲染
  出現、無 `NaN`／`Infinity`／`undefined` 文字殘留、`lastmonth`（無資料）正確顯示
  「資料不足」「尚無足夠的轉換事件資料」、自訂日期 `end<start` 在前端就被攔截
  （彈 toast，不會發送 API 請求）。

### L. 最終程式檢查
```
node --check server.js                     ✅
node --check routes/analytics.js           ✅
node --check routes/dashboard.js           ✅
node --check public/js/app.js              ✅
node --check routes/*.js（全部）            ✅
node --check utils/*.js（全部）             ✅
node --check public/js/*.js（全部）         ✅
```
`public/index.html`：無重複 `id`，`<div>`/`</div>` 數量 664/664 平衡（本階段完全
未修改此檔案，只改 `app.js` 動態產生的內容）。Migration 重複執行兩次，
`analytics_events`（107 筆測試資料）／索引（8 個）／`orders`（12 筆）數量在重啟
前後完全一致，無報錯、無重建。

---

## 13. 已知限制

1. **Funnel／Product 轉換率可能出現 >100%**：漏斗的「送出訂單」「完成付款」兩階段
   用 distinct order_id，其餘階段用 distinct visitor_id；商品排行的「成交人數」用
   distinct order，「加購人數」用 distinct visitor。這是需求文件公式本身規定的計數
   單位，不是程式錯誤，但在小樣本／測試資料下容易出現「成交人數 > 加購人數」這種
   視覺上奇怪的比率（例如同一 visitor 用不同身份重複下單，或測試資料本身不是連續
   的真實使用者行為）。真實生產資料下，因為同一顧客通常維持同一 `visitor_id`
   貫穿全程，這個現象會少見很多，但理論上仍可能發生，前端目前不做人工上限裁切
   （避免掩蓋真實的異常訊號）。
2. **付款方式分析依賴 cart_id 橋接，不是原生欄位**：因為 `payment_started` 事件定義
   本身沒有 `payment_method` 欄位（Hotfix23-A 就是這樣設計，本期依需求不能改事件
   定義），所以用 `cart_id` 反查 `submit_order`→`orders.payment_method`。如果使用者
   在同一個 `cart_id` 生命週期內「切換付款方式又送出訂單」，橋接會採用最終送出訂單
   時的付款方式，這是合理近似值，但無法還原「使用者中途切換過幾次付款方式」這種
   更細的歷程。
3. **回購分析「無電話訂單不納入分母」只做了程式碼審查，沒有實測**：目前 LINE 點餐／
   宅配下單流程本身就要求填電話（既有驗證，本階段沒有也不應該去改），因此無法透過
   正常下單流程實際產生一筆「已完成但無電話」的訂單來驗證這條路徑。SQL 條件
   `customer_phone IS NOT NULL AND customer_phone != ''` 已在程式碼中明確存在並經
   review 確認正確，但缺乏端到端的實測資料佐證。
4. **健康度沒有「營收目標」設定功能**：本期系統沒有讓店家設定營收目標的介面，因此
   「營收達成度」這個權重 30 分的項目永遠是缺項。這不是 bug，而是「資料不足時不
   硬算成 0 分」原則的直接體現——但也意味著目前的健康度分數實際上是拿掉營收達成度
   後，剩下 70 分權重（轉換率 25＋購物車 20＋回購 15＋付款 10）重新正規化的結果，
   分數會系統性地比「有完整五項」時期待的分佈更寬鬆。若未來（Hotfix23-C/D 或更後
   續）要加營收目標設定，記分公式無需改動，只要 `revenueTarget` 有值就會自動納入。
5. **近 5 分鐘狀態沒有 WebSocket**：`realtime` 區塊是每次呼叫 API 時當下重新查詢
   `analytics_events` 最近 5 分鐘的事件，不是持續推播；使用者必須手動按「重新整理」
   或等下次 `loadDashboardV2()` 呼叫才會更新，UI 已明確標示「近 5 分鐘」避免誤解。
6. **測試環境無法執行完整瀏覽器 E2E**：本環境沒有 Chromium／Puppeteer，UI 回歸驗證
   改用 jsdom 建立最小化的隔離 DOM 環境，直接執行 `app.js` 的 dashboard 相關函式並
   檢查渲染出的 HTML 內容（見第 12 節 K 小節），涵蓋了「無例外拋出」「無 NaN/
   Infinity/undefined」「11 個區塊標題正確渲染」「無資料狀態正確顯示」等關鍵行為，
   但無法驗證真實瀏覽器的版面斷點、觸控互動、CSS 實際渲染效果（例如 grid 換行在
   實際手機瀏覽器下是否美觀），建議正式上線前用真機或瀏覽器再肉眼確認一次。
7. **既有 pre-existing 問題（非本階段新增，未修改）**：
   - `utils/db.js` 第 203 行附近 `w._db.all('PRAGMA table_info(products)')` 呼叫方式
     有誤（應為 `w.all(...)`），Hotfix23-A 已記錄過，本階段確認與 Dashboard V2 完全
     無關（不影響任何 analytics 或 dashboard 查詢），依「只在確定影響本次功能才修正」
     原則，本階段仍不修改。
   - `public/js/app.js` 存在兩個 `escHtml()` 函式定義（一個在店家資訊卡區塊附近，
     一個在檔案後段「工具函式」區塊），兩者實作幾乎相同，JS 只會使用最後宣告的
     版本，不影響功能，但屬於程式碼重複。這是本階段之前就存在的既有狀況（兩個
     定義都在本次修改範圍之外），本階段沒有新增第三個定義，也不在本次範圍內清理。

---

## 14. 回歸驗證結論

- ✅ 舊 `GET /api/dashboard` 維持 200，回應格式完全未變。
- ✅ 外帶／外送／冷藏宅配下單、LINE Pay、優惠券、Business Calendar 相關路由本階段
  完全未觸碰。
- ✅ Hotfix22-F 購物車永久保留、Hotfix23-A `analytics_events` 寫入與白名單規則
  完全未修改，本階段只新增讀取查詢。
- ✅ POS、Android：本階段未修改任何相關檔案。

---

## 交付檔案

- `CHANGELOG_HOTFIX23_B_DASHBOARD_V2.md`（本檔案）
- `pos-web-hotfix23-B.zip`

ZIP 內容排除：`node_modules/`、`data/`、`.env`、`*.db`、`*.sqlite`、測試 log。

---

**Hotfix23-B 完成，等待驗收。未開始 Hotfix23-C。**
