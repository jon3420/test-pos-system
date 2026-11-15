# R54.4／MBV2-HF1-C5 最終報告：補貨通知成效追蹤（點擊、加購、訂單與成交歸因）

- 交付 ZIP：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_RESTOCK_CONVERSION_TRACKING_APP_ROOT.zip`（包含 C4.5 全部改善）
- SHA-256、檔案數、ZIP 項目數：見專案文件 `claude/R54_4_MBV2_HF1_C5_FINAL_REPORT.md`（ZIP 內的報告無法包含自身雜湊）
- 基準：C4.5 階段套件 `P3CD_DEPLOY_R54_4_MBV2_HF1_C4_5_RESTOCK_UX_CONSENT_DATE_GUARD_APP_ROOT.zip`（C4.5 報告見 `docs/R54_4_MBV2_HF1_C4_5/`）
- **本輪沒有部署、沒有操作正式資料、沒有開啟店家通知開關、真實 LINE 呼叫 0 次、真實 LINE Pay 呼叫 0 次。**

---

## 1. 既有架構稽核與設計

| 項目 | 既有架構（沿用） | C5 作法 |
|---|---|---|
| LINE 已受理 | `restock_notify_deliveries.status='accepted'` | 直接沿用；待發送、失敗、結果不明都不算 |
| 會員識別 | 後端簽發的 `member_session`（`verifyMemberSession`） | 點擊、加購、訂單都只信任後端驗證的會員 |
| 加購 | 前台 `add_to_cart`（只在 `addCart`／`addPreorderToCart`／`chgQty(+)` 通過販售限制後送出；購物車還原、登記表單不送） | 沿用同一事件；通知商品的加購另附 `metadata.restock`，後端取出後從事件移除 |
| 結帳 | 正式事件 `checkout_click`（不用舊 `begin_checkout`） | 漏斗不另算結帳步驟，不重複計算 |
| 訂單成立 | `POST /api/line-orders` 後端寫 `submit_order` | 同一處（訂單成立後）寫入歸因快照 |
| 成交 | 非 LINE Pay：訂單成立時後端寫 `purchase`；LINE Pay：`/api/linepay/confirm` 確認成功才寫 | 沿用既有 `purchase` 定義；LINE Pay 另須 `payment_status='paid'` |
| 廣告／UTM／Recovery 歸因 | `analytics_events` 的 first／last touch、Recovery 表 | 不覆蓋；補貨歸因使用獨立資料表 |
| 報表 | 營運分析中心（`analytics-v2.js`） | 新增「🔔 補貨通知成效」頁籤，不另建系統 |

舊通知連結只有店別、商品、日期與取餐方式，無法辨識批次。C5 起由伺服器為每個新批次產生追蹤識別。

## 2. 追蹤識別與連結（版本化）

- `restock_notify_batches.tracking_id`：伺服器以 15 bytes 亂數產生（base64url 20 字元），**在預覽建立訊息快照之前**產生並放入連結 `rt` 參數；確認、重試、續送沿用同一份訊息、連結、hash 與 retry key（S1）。
- 只對應「店別＋批次＋商品」：不含個資，不具登入、查詢名單或發送通知的權限；查不到、商品不符、跨店時一律回 `tracked:false`，不揭露是否存在（C4）。
- 版本化：`tracking_id` 空白的舊批次產生與原本完全相同的連結；跨店、LIFF、商品、訊息完整性檢查（`batchContext`）完全保留，只是把 `rt` 納入預期連結，**沒有放寬**。
- 不增加追蹤轉址：仍是既有 LIFF 連結；C4.5 的直達流程讀取 `rt`，並在網址整理時一併移除。
- C5 以前的批次：不補產生、不改寫訊息／連結／hash／retry key；報表顯示「未建立追蹤／無資料」，不寫成 0、不推測歷史成效（K1、K2、V3-3）。

## 3. 事件定義

**A. LINE 已受理**：沿用 accepted 紀錄。介面標示「LINE 已受理只代表 LINE API 已接受請求，不代表顧客已收到或已讀」。

**B. 點擊**（`POST /api/product-demand/track/open`）
- 最終點餐頁**實際開啟目標商品後**才送出；GET 連結頁面（預覽、爬蟲）、讀取商品資料（`/product-ref`）都不算（C1）。
- `open_key`：同一則連結在同一分頁的開啟識別（sessionStorage），必要導向、重新整理、事件重送沿用同一個 → 唯一索引去重；同一會員再次點擊（新開啟）另計次數，人數另行去重（C2、B1、B2）。
- 會員：後端驗證的 `member_session`；不強迫登入，背景辨識完成後以同一 `open_key` 補送，只補「尚無會員」的紀錄，已綁定的會員不會被改成另一位（C3）。
- 收件人核對：必須是該批次「LINE 已受理」的收件人，且受理時間早於點擊；匿名、轉傳給非收件人、未受理（失敗／結果不明）的開啟另列「其他開啟」，不計入正式漏斗（C5）。
- 同一工作階段同一批次最多 20 筆開啟紀錄（防灌資料）。

**C. 加入購物車**：沿用真正加購成功的 `add_to_cart`。只有「通知商品」且已有同一次開啟的點擊紀錄才計入；`event_key` 去重（重送不重複、正常再次加購保留次數）；人數另行去重。缺貨、限制不符、加購失敗不會送出事件；購物車還原、開啟登記表單、修改登記份數不是加購（A1、B3、B4）。

**D. 訂單與成交**：完全由後端判定，前端不能回報成功或金額。
- 訂單成立（`POST /api/line-orders` 成功後）以已驗證會員＋點擊紀錄計算歸因快照，寫入 `restock_notify_order_attributions`；寫入失敗不影響訂單與付款（F1）。
- 成交：沿用既有 `purchase`（非 LINE Pay 訂單成立時記錄，**不代表已收款**）；LINE Pay 須後端確認付款成功（`payment_status='paid'`）。未付款、確認失敗、返回取消不算成交；重複 callback 不重複（P1、P2）。
- 有效訂單排除已取消（`order_status='cancelled'`）與已作廢（`status='void'`），歷史紀錄保留（R1）。
- 不改變登記週期、通知同意、發送資格，也不觸發重新通知。

## 4. 歸因與金額口徑

**歸因（第一版）：最後一次有效補貨通知點擊後 7×24 小時內下單**
1. 同店、同商品、同一位後端驗證會員；點擊晚於該收件人的受理時間。
2. 多個有效點擊 → 歸給下單前最後一次（W2）。
3. 同一訂單同一商品只歸因一次（唯一索引 `store_id+order_uuid+product_id`）。
4. 以訂單建立時間（伺服器時間）判斷視窗（W1：差 2 分鐘內／外）；LINE Pay 之後完成付款沿用原快照。
5. 通知日期／取餐方式（`notify_supply_date`／`notify_mode`）與訂單實際選擇（`order_pickup`／`order_mode`）分開保存；顧客改選仍算同商品轉換（O5）。
6. 一位會員多張訂單：成交人數與訂單數分開；同一訂單含多個通知商品時各商品有明細，跨商品總覽的訂單數去重（O4、O6）。

**金額**：只計入通知商品的成交明細（單價×數量），不含其他商品與外送費。整單折扣依「各商品明細占商品小計比例」分攤，以「分」計算、最大餘數法處理尾差（同餘數依明細順序），折扣大於商品小計時以小計為上限；不改動原訂單計價（O4：小計 430、折扣 100 → 27.91／37.21／34.88）。
**限制**：系統沒有逐項（部分）退款資料；已退款／待退款訂單另行標示筆數，金額未扣除部分退款，**不是精確淨營收**。

## 5. 報表（營運分析中心「🔔 補貨通知成效」）

- `GET /api/analytics/restock-notify/summary?from=&to=&product_id=&mode=&batch_uuid=`：員工 JWT（店別只信任 JWT）＋ `reports` 權限；以 query `store_id` 不能讀取，其他店別看不到（V1）。
- 以「通知批次」為群體（篩選：批次確認日期［台北］、商品、取餐方式、批次），分子分母同一群體。指標：LINE 已受理人數、已核對點擊人數／次數、對應商品加購人數、下單人數、有效成交人數、去重訂單數（有效／成交）、補貨商品金額、點擊率、點擊後加購率、點擊後成交率、通知成交率；分母為 0 顯示「—」。合計比率只用有追蹤的批次。
- 範例口徑驗證（O1）：已受理 10、點擊 6、加購 4、成交 2 人、有效訂單 3 張 → 60%／66.67%／33.33%／20%。
- 前端沿用分頁生命週期：同一時間只保留最新查詢（序號＋中止），晚到的舊回應不覆蓋新篩選（V3-2）；失敗保留上次結果並提示。
- 「LINE 商品管理 → 補貨登記 → 通知批次」：有追蹤的批次顯示「📈 成效」連到明細；舊批次顯示「成效：未建立追蹤」（V3-4）。
- `POST /api/analytics/restock-notify/reconcile { days }`：補登尚無歸因的 LINE 會員訂單（以訂單建立時間），可重跑、不重複計算（F2）。
- 不依賴 GA4；追蹤識別、會員憑證、LINE UID 不送往外部 Analytics（`metadata.restock` 由後端取出後移除；第三方追蹤在網址整理後才初始化）（A2、B5）。

## 6. 資料庫、API、設定與搬家變更

- **資料庫（安全遷移，可重複執行，不刪資料、不重建訂單表）**：
  - `restock_notify_batches` 新增欄位 `tracking_id TEXT DEFAULT ''`＋部分唯一索引 `(store_id, tracking_id)`。
  - 新資料表 `restock_notify_clicks`、`restock_notify_cart_adds`、`restock_notify_order_attributions`（含唯一索引與查詢索引）。
- **API**：新增 `POST /api/product-demand/track/open`（顧客端）、`GET /api/analytics/restock-notify/summary`、`POST /api/analytics/restock-notify/reconcile`（後台）；`/api/analytics/events` 的 `add_to_cart` 接受 `metadata.restock`；批次清單多回傳 `tracked`。
- **設定**：無新增。
- **搬家（MBV2）**：「補貨通知紀錄」分類加入三張新表（完整與選擇性備份）；匯入只合併、商品沿用批次的對應結果、訂單以本次訂單對應表換成目前訂單識別；完整取代重新對應商品時一併更新三張表的商品關聯。同一資料庫跨店匯入時，已屬於其他店別的批次／紀錄（uuid 全資料庫唯一）保留原紀錄不複製（原本 C4 批次在此情況會讓整次匯入失敗）（M1–M5）。
- 前端資源版本：`app.js?v=r54-4-mbv2-hf1-c5`、`analytics-v2.js?v=r54-4-mbv2-hf1-c5`。

## 6.1 變更清單（C5 相對 C4.5）

- 新增：`utils/restockTracking.js`（追蹤、歸因、報表）、`scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`、`scripts/lib/c5-linepay-mock.js`（測試用 LINE Pay 替身，正式部署不載入）、`docs/R54_4_MBV2_HF1_C5/`（3 檔）。
- 修改：`utils/restockNotify.js`（預覽時產生追蹤識別、連結版本化、`batchContext` 預期連結含 `rt`、批次清單 `tracked`）、`utils/db.js`（啟動時執行 C5 安全遷移）、`utils/migrationV2.js`（三張新表的匯出／匯入／重新對應；同庫跨店 uuid 重複時保留原紀錄）、`routes/product-demand.js`（`/track/open`、報表 router）、`routes/analytics.js`（`add_to_cart` 的 `metadata.restock`）、`routes/line-orders.js`（訂單成立後寫入歸因快照）、`server.js`（掛載報表 router）、`public/line-order.html`（讀取 `rt`、開啟回報、加購附帶歸因、會員補送）、`public/js/analytics-v2.js`（「🔔 補貨通知成效」）、`public/js/app.js`（批次「📈 成效」連結）、`public/index.html`（資源版本）、測試 `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js`（B2，見 7.2）。
- 刪除：0。
- C4.5 相對 C4.4 的變更見 `docs/R54_4_MBV2_HF1_C4_5/00_FINAL_REPORT.md` 第 5 節（本套件一併包含）。

## 7. 驗收與回歸（本輪執行；台北時間 2026-11-14）

### 7.1 新增驗收：`scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`

正式路由、暫存資料庫、實際發送 worker（LINE transport 在測試程序內攔截）、LINE Pay API 以 `node-fetch` 替身攔截、真實 Chrome。7 日邊界以測試時鐘重新啟動伺服器重現（伺服器時間），與執行時段無關。`C5_OLD_ROOT` 指向 C4.5 全新解壓樹時另執行 K1–K4。

| 範圍 | 案例 | 結果 |
|---|---|---|
| 追蹤識別 | T1–T3：訊息快照前產生、放入連結、hash 一致、不含個資；已受理人數 | ✅ |
| 點擊 | C1–C5：GET 連結／讀取商品不算；重送與重新整理不增加、再次點擊另計次數；背景辨識補會員、不改綁；偽造／商品不符／跨店不記錄；未受理、非收件人、匿名另列 | ✅ |
| 加購 | A1–A2：重送去重、再次加購保留次數、只計通知商品、需先有點擊；追蹤識別不寫進一般事件 | ✅ |
| 訂單／成交 | O1（範例口徑 60%／66.67%／33.33%／20%）、O2–O6（只計通知商品、無點擊／轉傳／匿名不歸因、多商品同訂單與折扣分攤、通知與訂單選擇分開、跨商品訂單去重） | ✅ |
| LINE Pay | P1：未付款／確認失敗不算成交、確認成功才算、重複 callback 不重複；P2：返回取消後快照保留、不算成交 | ✅ |
| 取消／作廢 | R1：不計入有效訂單與金額 | ✅ |
| 歸因視窗 | W1：7×24 小時邊界（±2 分鐘）；W2：最後一次有效點擊 | ✅ |
| 失敗與補登 | F1：追蹤寫入失敗不影響開啟回應與下單；F2：補登可重跑不重複 | ✅ |
| 報表 | V1：員工 JWT、query store_id 不可讀、店別隔離；V2：篩選、分母 0 顯示「—」；V3：營運分析中心數字與 API 一致、亂序回應不覆蓋、未追蹤批次標示、批次「📈 成效」連結 | ✅ |
| 發送不變 | S1：確認、重試、續送沿用同一份訊息、連結、hash 與 retry key | ✅ |
| 搬家 | M1–M5：完整／選擇性備份、跨環境匯入（先只有通知紀錄 → 再有訂單）、同店完整還原、同一資料庫跨店匯入 | ✅ |
| 瀏覽器 | B1–B6：LIFF 導向後點擊 1 次、重新整理不增加、加購只計通知商品、購物車還原與登記清單不算加購、追蹤識別不送第三方、舊連結照常開啟 | ✅ |
| 相容（C5_OLD_ROOT） | K1–K4：舊版批次升級不變、報表顯示未建立追蹤、舊版讀取升級後資料庫、舊版頁面開新連結 | ✅ |
| 真實 LINE 呼叫 | Z | 0 次 |
| **合計** | | **47／47** |

### 7.2 回歸

- C4.5 新增測試在 C5：連結 42／42、日期與訂閱 54／54。
- 主要回歸：C4.4 20／20、C4.3 34／34、C4.2 80／80、C4.1 40／40、C4 94／94（B2 調整後；調整前 93／94）、LINE 發送相容 12／12、C3.3 30／30、C3.2 32／32、C3.1 54／54、C3 332／332、C2 預購 93／93、H1.4.12 popup 前台 293／293、MBV2 UI 19／19、搬家 121／121、系統回歸 exit 0、Recovery 168／168。
- 61 支既有回歸：C5 **41 支 exit 0**（與 C4.5 有效結果、C4.4 紀錄相同）；其餘 20 支非 0 與 C4.5 逐支比對結果相同，差異只有：
  - GA4 多輪總控（h1-4-6、h1-4-7）：C4.5 那次有一輪「B1-6 Geo Explorer」子程序中斷，C5 這次三輪都完成（既有不穩定，數字相同）。
  - `static-audit-r48-popup-order-ui`（凍結 R47 位元組稽核，兩版都失敗）：差異只反映本輪修改的檔案與新增的點擊回報呼叫（apiFetch 42→43）。
  - `smoke-hotfix27-cd`：FAIL 數相同（既有 1 項）；PASS 50→49，原因是該靜態檢查以檔名尋找腳本，`analytics-attribution.js` 加上 `?v=` 版本參數後（與其他既有 `?v=` 腳本相同）被略過。已另行以相同規則檢查該檔不含店家登入函式（結果為空）。這項差異同樣存在於 C4.5 最終套件（C4.5 回歸執行時尚未加版本參數）。
- **本版新增失敗：0。**

**必要的既有斷言調整**（不放寬斷言）：
1. 沿用 C4.5 的 C4.3 B9、C4.2 A18 調整（見 C4.5 報告 4.2）。
2. `smoke-r54-4-mbv2-hf1-c4-restock-notify.js` B2：選擇性備份「補貨通知紀錄」分類的**資料表精確清單**加入 C5 新增的三張表（MBV2 格式變更）；其餘斷言不變。調整前 93／94，調整後 94／94。

### 7.3 從候選 ZIP 全新解壓後的驗收

候選 ZIP 全新解壓、`npm ci` 後啟動：health／點餐頁／後台 200；未授權 `/snapshot`、`/restock/date-options`、`/api/analytics/restock-notify/summary`（即使帶 query store_id）401；通知預設不可用；`subscribe_mode=opt_in`；啟動沒有遷移警告。14 支主要測試全部通過：C5 成效 47／47（`C5_OLD_ROOT`＝C4.5 全新解壓樹）、C4.5 連結 42／42、日期與訂閱 54／54、C4.4 20／20、C4.3 34／34、C4.2 80／80、C4.1 40／40、C4 94／94、LINE 發送相容 12／12、C3.1 54／54、C3.3 30／30、C3.2 32／32、MBV2 搬家 121／121、Recovery 168／168。最終 ZIP 與受測版本的程式檔逐檔相同，只在 `docs/R54_4_MBV2_HF1_C5/` 補上結果與 manifest。

### 7.4 未驗證

LINE App／LIFF 真機（點擊在真機的導向與背景辨識時序）、真實 Messaging API、真實 LINE Pay（Sandbox／正式）付款與 callback、正式 Zeabur、多台伺服器、真實 GA4／Meta Pixel。模擬 LIFF SDK、模擬 LINE／LINE Pay API、Playwright 攔截都不是真機或正式站驗證。

## 8. 新發現的既有問題（未修改，記錄）

- **LINE 訂單編號只到「秒」**（`routes/line-orders.js` `orderNumber()`：`LINE-YYYYMMDD-HHMMSS`），同一秒建立的兩張訂單編號相同。LINE Pay `/confirm`（以訂單編號或 uuid 查詢）與 MBV2 訂單匯入（以訂單編號為業務鍵）都可能對應到另一張訂單。C5 歸因以訂單 uuid 保存，不受影響；但 LINE Pay 付款確認與搬家的既有風險仍在。本輪測試以每張訂單間隔 1.1 秒避開，**未修改**（超出本輪範圍，建議另案處理）。

## 9. 部署後最短驗收與回退

**驗收**（維持「啟用 LINE 補貨通知發送」關閉；不發送真實訊息）：
1. 服務啟動後 log 沒有 `[DB] restock_tracking migration` 警告。
2. 後台「營運分析中心 → 🔔 補貨通知成效」可開啟；既有批次顯示「未建立追蹤／無資料」。
3. 「LINE 商品管理 → 補貨登記 → 通知批次」舊批次顯示「成效：未建立追蹤」。
4. 下一次店家實際發送通知後，抽一則訊息確認連結多了 `rt` 參數；顧客開啟後報表「點擊」增加。

**回退**（保留現有資料庫、退回程式碼；不得以還原舊資料庫回退，不得按「續送」清理）：
1. 後台取消勾選「啟用 LINE 補貨通知發送」。
2. 等待批次清單不再出現「發送中」。
3. 對「已暫停」的批次按「取消未送出項目」；**不要按「續送未完成項目」**。
4. 重新部署 C4.5 ZIP（建議；C4.5 會把 `rt` 一併從網址整理。回退到 C4.4 時 `rt` 會留在顧客網址列），保留現有資料庫。新增的欄位與資料表不影響舊版程式（K3 實測舊版可在升級後的資料庫啟動並讀取批次）。C5 建立、含 `rt` 的批次若在舊版續送，舊版會判定連結與目前設定不符而停止並作廢未送出項目（程式推論；依第 3 步先取消即可）。舊版頁面開啟含 `rt` 的連結仍正常開啟商品（`rt` 被忽略）。
