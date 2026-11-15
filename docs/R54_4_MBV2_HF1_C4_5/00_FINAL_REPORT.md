# R54.4／MBV2-HF1-C4.5 階段報告：補貨通知體驗改善（通知連結載入、選擇日期立即防呆、消費者訂閱方式）

- 交付 ZIP：`P3CD_DEPLOY_R54_4_MBV2_HF1_C4_5_RESTOCK_UX_CONSENT_DATE_GUARD_APP_ROOT.zip`
- SHA-256、檔案數、ZIP 項目數：見專案文件 `claude/R54_4_MBV2_HF1_C4_5_FINAL_REPORT.md`（ZIP 內的報告無法包含自身雜湊）
- 基準：C4.4 `P3CD_DEPLOY_R54_4_MBV2_HF1_C4_4_DEMAND_MUTATION_RESPONSE_FIX_APP_ROOT.zip`
  - 實測 SHA-256 `540ea8c01faba64b1fae851e15519e3b15837fc9e960b6a46946fb54bcf528ca`（與指定值相符）；934 個檔案／972 個 ZIP 項目；根目錄直接包含 `server.js`、`package.json`。
  - 建立未修改的 C4.4 基準樹（只加入本輪新增的 3 個測試檔）與 C4.5 工作樹；本輪測試全部重新執行，不沿用先前紀錄。
- **本輪沒有部署、沒有操作正式資料、沒有開啟店家通知開關（交付預設仍為關閉）、真實 LINE 呼叫 0 次。**
- 資料庫：**沒有結構變更**（沒有新資料表、欄位或索引）。新增一個店別設定鍵 `restock_notify_subscribe_mode`（未設定或未知值＝`opt_in`）。

---

## 1. 通知連結載入（看起來載入兩次）

### 1.1 官方流程核對（LINE Developers）

- 開啟 LIFF URL 時，LIFF 伺服器先導向「一次導向網址」（Endpoint URL，附加資訊全部放在 `liff.state`）；頁面執行 `liff.init()` 後，SDK 再導向「二次導向網址」（附加資訊還原後的最終頁）。兩頁都必須執行 `liff.init()`。
- 官方要求：改變網址（History API）的處理放在 `liff.init()` 完成之後；不得修改或刪除 `liff.*` 參數；一次導向網址可能含使用者憑證，不得送到外部記錄工具。

因此「一次導向＋二次導向」是 LINE 平台必要的兩次文件載入，**不能**、也沒有以略過登入、跳過驗證或刪除導向的方式縮短。

### 1.2 根因（實際重現＋程式推論；以 LIFF SDK 替身依官方流程模擬，不是真機）

| # | C4.4 行為 | 影響 |
|---|---|---|
| R1 | 一次導向頁照一般首屏完整初始化：讀店家、菜單、行事曆、還原購物車、畫出商品頁、送 page_view 等 Analytics，之後會員 Gate 才執行 `liff.init()` 觸發導向 | 顧客看到「載入 → 商品頁 → 整頁重載 → 商品頁 → 開商品」＝網站額外的一次完整載入（L1-2、L4-1） |
| R2 | 店家未啟用會員 Gate／背景辨識時，頁面根本不執行 `liff.init()` | 停在一次導向頁，商品參數留在 `liff.state`，**商品永遠不會開啟**（L2） |
| R3 | `_captureRestockLinkFromUrl` 在腳本一開始就 `history.replaceState()` | 違反官方「URL 變更須在 `liff.init()` 完成後」（L1-6、L3-2） |
| R4 | 進站登入 Gate：商品在登入畫面後方先開啟；且網址已被清掉，LINE 登入返回網址沒有商品參數 | 「先開商品、再導向」；登入返回後**不再開啟**商品（L7-1、L7-2、L7-4） |
| R5 | 一次導向頁送出的 Analytics 帶有 `liff.state` 的網址；第三方 Pixel／GA4 在網址整理前就初始化 | 與官方「一次導向網址不送外部記錄工具」不符（L1-9） |

### 1.3 修正（`public/line-order.html`、`public/js/analytics-attribution.js`）

- **一次導向頁快速路徑**：只有 `liff.state` 內含補貨直達參數（`product_ref`＋`src=restock`）、且不是登入返回／Recovery／Handoff／LINE Pay 返回時啟用。頁面維持「正在開啟通知的商品…」載入狀態，只讀取 LIFF ID（`/api/line-shop`）、載入 SDK 並執行 `liff.init()`，由 SDK 導向最終頁；不讀菜單、不還原購物車、不送 Analytics、不初始化第三方追蹤，**只讀取、不改寫任何網址或 `liff.*` 參數**。
- **備援**：SDK 載入失敗、逾時、店家未設定 LIFF ID 或 3 秒內沒有導向時，改在本頁照常初始化，並以 `liff.state` 內的參數開啟商品（仍不改寫 `liff.state`）。同一頁面的 `liff.init()` 只真正執行一次（會員 Gate 再呼叫時沿用）。
- **最終頁**：直達參數只讀取；網址整理延到會員 Gate（含 `liff.init()`）結束、且進站登入畫面關閉之後。進站登入 Gate 顯示中不開商品；顧客按 LINE 登入離開時，返回網址保留參數，**返回後的最終頁才開啟一次**。
- **只開一次**：同一頁面以旗標保護；同一分頁 2 分鐘內再次載入同一則連結（網址整理前重新整理）不重複開啟。商品識別查詢與店家／菜單並行，減少串行等待。
- 商品、日期、取餐方式仍只是提示：不加入購物車、不改顧客取餐方式；商品隱藏／刪除／不公開時提示並可繼續瀏覽（文案加上「你可以繼續瀏覽其他商品」）。
- **一般首屏**不變：沒有通知連結時完全不經過上述流程，仍不等待 LIFF／會員 Gate（L11、C3.2 回歸）。
- **隱私**：
  - 網址整理前不初始化第三方 Pixel／GA4（整理後才初始化）；備援的一次導向頁不初始化第三方追蹤。
  - `analytics-attribution.js` 保存 landing page／referrer 時移除 `liff.*`、`access_token`、`id_token`、`code`、`state`、Recovery／Handoff token、`member_session` 等參數與 `#` 片段（UTM 等照舊）。
  - 診斷：`window.__RESTOCK_LINK_DIAG__`（只在記憶體）只有頁面角色、階段與次數（liff_init、shop_fetch、product_ref_fetch、product_open、url_cleanup），不含網址、權杖、商品識別或會員資料，不送 Analytics。
- Recovery token 仍在腳本一開始立即從網址移除（安全要求優先）；有 Recovery／Handoff 時照舊以還原優先、不開啟通知商品。

### 1.4 模擬驗證與真機待確認

- 模擬：Playwright＋真實 Chrome，以 LIFF SDK 替身依官方流程模擬一次／二次導向（`init()` 先 resolve 再導向、或導向前不 resolve 兩種）。結果見第 4 節。
- **待真機確認**：LINE App（iOS／Android）LIFF 瀏覽器、外部瀏覽器實際的導向時序與畫面、`liff.init()` 在一次導向頁的 resolve 行為、`document.referrer` 內容、不同 LIFF SDK 版本。**LINE 平台本身的一次／二次導向仍然存在**；本輪消除的是網站額外的整頁初始化，不宣稱平台導向已消失。

## 2. 選擇日期時立即防呆（後台補貨通知）

- 新增唯讀端點 `GET /api/product-demand-admin/restock/date-options?product_id=&fulfillment_mode=[&date=]`（員工 JWT，店別只信任 JWT；`Cache-Control: no-store`）。以**伺服器時間＋Asia/Taipei** 判斷今天，對「今天起到可預訂範圍結束」的每一天呼叫既有 `productGate()`（商品收集開關＋`evaluateProductOrderability`：過去日期、最後接單時間、休息日、行事曆、未開放預訂、超出範圍、商品上架／取餐方式、手動販售狀態、額度）；遇到第一個「超出可預訂範圍」即停止（最多 61 天）。**不建立批次、不占名額、不寫入任何資料。**
- 後台面板：
  - 初次開啟依規則預選第一個可供應日期（不依操作電腦的日期）；`min`／`max` 設為伺服器範圍。
  - 鍵盤輸入、貼上、手動修改都即時比對；日期旁顯示原因（例：「此日期已過，請選擇其他供應日期」、「今日已超過接單時間」、「此日期為店休日」、「超出可預訂範圍」）與「下一個可供應日期」＋「改選此日期」按鈕（明確操作）。使用者已選的日期失效時只提示，不在背景改掉。
  - 檢查中、日期空白、無效或不可供應時停用「預覽通知」。
  - 更換日期／商品／取餐方式立即清除舊預覽與確認按鈕；預覽與日期檢查都以序號判斷，晚到的舊回應不得恢復；確認按鈕另核對送出時的日期／方式。
  - 跨午夜或回到頁面：隨既有 10 秒自動更新（不另開輪詢、不重疊）在資料超過 60 秒時重讀一次，更新日期限制並重新檢查，保留其他輸入。
  - 預覽結果中「日期／供應不可用」與「沒有合格收件人」分開顯示。
- 後端預覽、確認與每筆送出前的權威檢查完全保留（D10）。

## 3. 消費者訂閱方式（店別設定）

| 模式 | 顧客畫面 | 授權 |
|---|---|---|
| `opt_in` 消費者自行勾選（預設） | 通知方框預設不勾 | 勾選後送出才授權（來源 `customer_checkbox`，文案版本 `restock-notify-c4-v1`） |
| `register_subscribe` 登記即訂閱 | 顯示「送出即訂閱本商品補貨通知一次，可隨時取消。」，主要按鈕「登記並通知我」 | 新登記按下按鈕即本次授權（來源 `register_submit`，版本 `restock-notify-c45-register-v1`） |

- 與「啟用 LINE 補貨通知發送」總開關分開保存；總開關關閉或設定不完整時，兩種模式都不顯示任何會收到通知的承諾，也不授權。
- 切換模式**不修改任何既有同意紀錄**；舊登記、未同意、已撤回、匯入後需重新確認的資料不會變成同意。
- 既有登記且未訂閱：顯示「訂閱補貨通知／重新訂閱補貨通知」按鈕（來源 `customer_subscribe`），只授權通知，份數與取餐偏好沿用伺服器上的登記；**單純修改份數或取餐偏好不重新授權**（後端回 `consent_outcome='not_applied'`）。
- 保留「取消補貨通知（保留補貨登記）」。
- 後端驗證本次操作：前端送出 `consent_mode`／`consent_text_version`／`consent_action`；與店家目前設定不符時回 409 `CONSENT_MODE_CHANGED` 且**不寫入任何資料**。前端重新讀取設定、保留份數與取餐偏好、勾選框維持未勾，清楚提示後讓顧客再次確認。舊版前端（未帶 `consent_mode`）的明確勾選仍相容處理。
- 後台：「消費者訂閱方式」下拉選單加入既有「儲存設定」與編輯版本保護（儲存中再編輯不被覆蓋）；設定隨既有設定讀取與快速搬家（設定分類）搬移；不合法的值 400，資料庫中的未知值視為 `opt_in`。

## 4. 驗收結果（本輪執行；台北時間 2026-11-14 凌晨，基準與候選同一時段先後執行）

### 4.1 新增測試

| 測試 | 未修改 C4.4 | C4.5 |
|---|---|---|
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js`（LIFF 一次／二次導向模擬、直接開啟、慢 SDK、SDK 失敗、重複初始化、登入 Gate、商品不存在、既有購物車、Recovery、首屏、診斷） | **26 通過／16 失敗**（L1-2、L1-6、L1-9、L1b-2、L1b-6、L1b-9、L2、L3-2、L3-4、L4-1、L5-1、L6、L7-1、L7-2、L7-4、L12） | **42／42** |
| `smoke-r54-4-mbv2-hf1-c4-5-date-consent.js`（D：日期防呆 23 項；S：訂閱方式 31 項） | D 段：D1 即中止（C4.4 沒有唯讀日期檢查端點）；S 段：**8 通過／12 失敗**（S1、S3、S5-1、S5-2、S7、S10-1、S10-2、S11-1～S11-4，S11 之後因 C4.4 沒有「登記並通知我」按鈕而中止） | **54／54** |

詳細項目：`01_TEST_RESULTS.json`。時間相關案例（截止前後、跨午夜）使用測試時鐘（伺服器與測試程序同一位移），與執行時段無關；瀏覽器時區設為 America/Los_Angeles 驗證不依操作電腦日期。

### 4.2 回歸

**61 支既有回歸**：C4.5 有效 41 支 exit 0（與 C4.4 紀錄相同）；其餘 20 支非 0 在 C4.4 同一時段重跑結果相同或為兩版共同的既有不穩定（逐支比對見 `01_TEST_RESULTS.json`）。**本版新增失敗：0。**
- 測試環境說明：Playwright 套件版本（1254）與預先安裝瀏覽器（1243）不同，3 支未指定 executablePath 的既有瀏覽器測試第一次執行無法啟動瀏覽器；提供瀏覽器路徑後兩版同時段重跑：`smoke-h1-4-12-popup-real-browser` 兩版 36／36；`smoke-h1-4-12-popup-admin-ui-browser` 兩版都有既有的 LINK-published-urls 失敗（C4.4 另多 1 項 BR51 不穩定）；`smoke-r48-popup-order-ui-browser` 兩版相同。
- GA4 多輪總控（h1-4-6、h1-4-7）：兩版都有一輪「B1-6 Geo Explorer」子程序中斷（C4.4 第 1 輪、C4.5 第 3 輪），其餘輪次數字相同，屬既有不穩定（C4.4 報告亦有記載）。
- `static-audit-r48-popup-order-ui`：凍結 R47 位元組稽核，兩版都失敗；差異只反映本輪修改的檔案與新增的一個商品識別查詢呼叫。

**主要回歸**（C4.4 異動回應 20／20、C4.3 34／34、C4.2 80／80、C4.1 40／40、C4 94／94、LINE 發送相容 12／12、C3.3 30／30、C3.2 32／32、C3.1 54／54、C3 332／332、C2 預購 93／93、H1.4.12 popup 前台 293／293、MBV2 UI 19／19、搬家 121／121、系統回歸 exit 0、Recovery 168／168；61 支既有回歸與基準逐支比對）。

**必要的既有斷言調整（只改操作時機或前提，不放寬斷言）**：

1. `smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` B9：原本改取餐方式後**立即**以程式點擊「預覽通知」。C4.5 起日期檢查完成前按鈕停用（新防呆），立即點擊會點到停用中的按鈕。改為先等按鈕可按再點擊；B9 的斷言不變。調整前 33／34（B9 失敗），調整後 34／34。
2. `smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` A18：案例要驗證「已產生的預覽」在自動更新後保持，但當時商品為「暫停」。C4.5 起不可供應的日期／商品不能預覽（不再產生「不可發送」預覽）。改為 A18 開始前讓商品恢復可供應、結束後改回暫停；A18-1～A18-7 斷言不變。調整前 79／80（A18-3 失敗），調整後 80／80。

### 4.3 從候選 ZIP 全新解壓後的驗收

候選 ZIP 全新解壓、`npm ci` 後啟動：health／點餐頁／後台 200；未授權 `/snapshot`、`/restock/date-options` 401；通知預設不可用（`notify_available=false`、`send_enabled=false`）；公開設定 `subscribe_mode=opt_in`；啟動沒有遷移警告。13 支主要測試全部通過：C4.5 連結 42／42、日期與訂閱 54／54、C4.4 20／20、C4.3 34／34、C4.2 80／80、C4.1 40／40、C4 94／94、LINE 發送相容 12／12、C3.1 54／54、C3.3 30／30、C3.2 32／32、MBV2 搬家 121／121、Recovery 168／168。最終 ZIP 只在 `docs/R54_4_MBV2_HF1_C4_5/` 補上結果與 manifest，程式檔與候選 ZIP 逐檔相同。

### 4.4 未驗證

LINE App／LIFF 真機（含 iOS／Android、外部瀏覽器）、真實 Messaging API、正式 Zeabur、多台伺服器、真實 GA4／Meta Pixel。模擬 LIFF SDK、模擬 LINE API、Playwright 攔截都不是真機驗證。

## 5. 變更清單（相對 C4.4）

- 修改：`public/line-order.html`、`public/js/analytics-attribution.js`、`public/js/app.js`、`public/index.html`、`routes/product-demand.js`、`utils/productDemand.js`、`utils/restockNotify.js`、測試 `scripts/smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js`、`scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js`（見 4.2）。
- 新增：`scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js`、`scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js`、`scripts/lib/c45-common.js`、`docs/R54_4_MBV2_HF1_C4_5/`（3 檔）。刪除：0。
- API：新增 `GET /api/product-demand-admin/restock/date-options`（唯讀）；`GET /api/product-demand/config` 多回傳 `subscribe_mode`；`POST /api/product-demand/register` 接受 `consent_mode`／`consent_action`／`consent_text_version`、新增 409 `CONSENT_MODE_CHANGED` 與 `consent_outcome='not_applied'`；`PATCH /api/product-demand-admin/settings` 接受 `subscribe_mode`。
- 設定：新增 `restock_notify_subscribe_mode`（`opt_in`｜`register_subscribe`，預設 `opt_in`）。資料庫結構與搬家格式不變（新設定鍵隨既有「系統設定」分類搬移）。
- 前端資源版本：`app.js?v=r54-4-mbv2-hf1-c4-5`、`analytics-attribution.js?v=r54-4-mbv2-hf1-c4-5`。
- 前向相容：直達網址整理時一併移除 `rt`（C5 新連結的批次追蹤識別；C4.5 不使用，回退情境下也不留在網址或送往第三方）。

## 6. 部署後最短驗收（不發送真實訊息）與回退

**驗收**（維持「啟用 LINE 補貨通知發送」關閉）：
1. 後台「LINE 商品管理 → 📋 補貨登記」展開任一商品：供應日期自動預選可供應日期；手動輸入昨天，日期旁立即顯示「此日期已過…」且「預覽通知」停用。
2. 「消費者訂閱方式」維持「消費者自行勾選（預設）」；顧客頁補貨登記表單的通知方框預設不勾（總開關關閉時不顯示通知承諾）。
3. 手機 LINE 開啟任一舊的補貨通知連結：只見載入畫面後開啟商品一次（LINE 平台的一次導向仍存在）。

**回退**（保留現有資料庫，不得以「續送」清理批次）：
1. 後台取消勾選「啟用 LINE 補貨通知發送」。
2. 等待批次清單不再出現「發送中」。
3. 對「已暫停」的批次按「取消未送出項目」；**不要按「續送未完成項目」**。
4. 重新部署 C4.4 ZIP（`540ea8c0…`），保留現有資料庫。C4.5 沒有資料庫結構變更；`restock_notify_subscribe_mode` 設定在 C4.4 不會被讀取（回到勾選模式），已建立的同意紀錄（含 `register_submit`／`customer_subscribe` 來源與新文案版本）在 C4.4 仍為有效同意。
