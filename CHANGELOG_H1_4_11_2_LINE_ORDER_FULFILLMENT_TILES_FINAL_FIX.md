# H1.4.11.2｜LINE 點餐頁模式 最終補正

直接基底：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11.1-...-full.zip`（H1.4.11.1）。
全程未回退重做、未進行無關重構。

## 一、時區依賴修正

`scripts/smoke-h1-4-11-1-fixes.js` 原本用 host `new Date()` 計算「明天」「+3 天」等
期望值；若測試主機 TZ 與 Taipei 不同，在日期交界附近可能得到錯誤的期望值。改為：
- `taipeiTodayStr()`：與 `routes/line-orders.js` 的 `twNow()` 完全相同的
  `toLocaleString(...,{timeZone:'Asia/Taipei'})` 轉換方式，TZ-safe round trip。
- `addDaysToDateStr()`／`weekdayOfDateStr()`：純 `Date.UTC()` 曆法運算，不經過
  host-local 時區解讀字串。
- 已在 TZ=UTC／Asia/Taipei／Asia/Tokyo 下分別執行 `smoke-h1-4-11-1-fixes.js`／
  `smoke-h1-4-11-2-fixes.js`，皆 0 FAIL。

## 二、`wireFulfillmentLifecycleRefresh()` 補上 `focus`

`public/line-order.html`：新增 `window.addEventListener('focus', ()=>
requestShopStatusRefresh())`，與既有 `pageshow`／`visibilitychange` 共用同一個
in-flight coalescing 入口。新增測試：直接呼叫正式函式兩次驗證三種事件都只註冊一次；
真的依序 dispatch 三種事件驗證各自觸發一次 fetch；三者幾乎同時 dispatch 驗證
coalescing 只發出一次 fetch。

## 三、`refreshShopStatus()` 單次重繪保證

- 保留「每次成功刷新統一重繪一次」的方向，但修正了會造成**重複重繪**的問題：原本
  「enabled/cutoff/todayClosed 改變」的重量級分支會呼叫 `refreshModeCutoffUI()`
  （內含 `buildServiceStatusBar()`），與外層無條件的重繪呼叫疊加，同一次刷新最多可能
  重繪兩次。改為互斥的兩條路徑：重量級分支觸發時，重繪工作完全交給
  `refreshModeCutoffUI()`；沒觸發時才用輕量的 `buildServiceStatusBar()` 單獨重繪一次。
  兩者互斥，保證每次成功刷新恰好重繪一次。
- `currentMode` 預選失效的 Toast 邏輯，移除了原本自己額外呼叫的
  `buildServiceStatusBar()`（圖塊已經在上面的路徑重繪過），只保留 Toast 本身，避免
  「Toast 只出現一次」與「圖塊只重繪一次」在同一次刷新裡互相打架。
- `!res.success` 時提早 `return`，完全不觸碰 `shopData`、不重繪，維持刷新前的舊畫面
  （API 失敗不得用半套新資料覆蓋）。
- 新增真實 DOM 測試：cutoff（不可預訂）→ 只把 `allow_next_day` 改為 `true`、其餘
  旗標不變 → `selectable` 從 `false` 變 `true`、圖塊 HTML 不再含 `ff-unavailable`、
  `buildServiceStatusBar()` 恰好執行一次、`currentMode`/`#oType`/購物車不受影響。
- 新增真實 DOM 測試：同一次刷新裡「page mode 改變＋currentMode 從可選變不可用＋
  enabled 改變」三者同時發生 → 圖塊仍只重繪一次、Toast 只出現一次、`_ffViewMode`
  只因 page mode 改變而清除、`currentMode`/`#oType`/購物車不受影響。
- 新增測試：API 回應 `success:false` 時，`buildServiceStatusBar()` 完全不被呼叫。

## 四、`findNextServiceInfo()` 正確性修正

- **修正前**：只要某天 `getEffectiveModeSchedule()` 判斷 enabled，就回傳該天，沒有檢查
  這個服務方式本身是否被店家整個關閉（`modeSettings.enabled`）。
- **修正後**：函式一開始就用與 `resolveFulfillmentState()` 完全相同的
  `toBooleanFlag(modeSettings.enabled, true)` 判斷式，若為 `false`（等同
  `reason:'global_disabled'`）直接回傳 `null`，不再往下掃描週班表——避免「服務方式已被
  整個關閉，卻還顯示下一次開始接單時間」的誤導。
- 新增 10 組真實後端測試（真實 DB fixture + Business Calendar + 真實
  `GET /api/line-orders/shop`，不 mock 回傳值本身）：明日正常營業／明日 Business
  Calendar 公休後天營業／連續 4 天公休正確跳到第 5 天／週班表全關但 Calendar 明日
  特殊營業開放／Calendar 當日只關外帶外送不受影響（分開計算）／外帶外送不同開始時間
  分開回傳／global 關閉→null／連續 60 天以上找不到→null（不捏造）／
  `allow_next_day=false` 時仍回傳資訊但 `canPreorderFutureDays` 維持 `false`／
  回傳的日期用 `validateOrderConditions()` 同一個 `getEffectiveModeSchedule()` 重算
  確認一致，不會顯示一個送單時會被拒絕的日期。

## 五、文案一致性

`_ffShortLabel()`／`_ffDetailText()`／`_ffToastText()` 三處逐一核對，確保同一個
`fs` 狀態物件在三處不會互相矛盾（例如圖塊寫「今日未開放」，Toast 卻說「目前未提供」）：
- `global_disabled` → 「店家目前未提供外帶自取／外送到府」（三處一致，且
  `findNextServiceInfo()` 保證這個 reason 底下 `next_service` 恆為 `null`，不會有
  多餘的時間資訊）。
- `no_schedule` → 「今日未開放」，有 `next_service` 時附上真實下一次開始接單時間。
- `special_schedule_disabled` → 「今日限定未提供」，附下一服務時間（與
  `global_disabled` 的永久語意區分）。
- `holiday`／`today_closed` → 「今日公休」／「今日臨時休息」。
- `cutoff` → 「今日已結束」＋真實下一次開始接單時間。
新增 7 組情境 × 3 處文案（短標籤/詳細/Toast）交叉比對測試，含「no_schedule 不得誤用
global_disabled 措辭」的矛盾檢查。

## 六、`getDeliveryFreeProgressState` ReferenceError（H1.4.11.1 已修，本輪延續驗證）

沿用 H1.4.11.1 的 `LocalFileResourceLoader`（只讀本地 `/js/`、`/css/` 真實檔案，其餘
一律安全略過、不連外部網址），本輪的兩支測試檔案（`smoke-h1-4-11-1-fixes.js`／
`smoke-h1-4-11-2-fixes.js`）全程執行皆無 `ReferenceError`、無未處理 Promise
rejection（已加 `process.on('unhandledRejection', ...)` 監控）。

## 七、`.env.example`

- 確認 H1.4.10／H1.4.11／H1.4.11.1 原始基準版本身都沒有附 `.env.example`（非本輪遺漏，
  是首次新增）。
- 以 `rg "process\.env"`（排除 `node_modules`）掃描實際使用的環境變數，建立根層
  `.env.example`，依功能分類加註解（伺服器基本設定／資料庫／安全性簽章／LINE 會員／
  Google Maps／GA4 Realtime／Geo Intelligence／AI Marketing／其他選用旗標／僅測試
  腳本使用），全部只放空值，不包含任何現存環境的實際值或正式金鑰。
- 打包驗證：ZIP 內有 `.env.example`，沒有 `.env`。

## 八、測試基礎設施

- 自訂 jsdom `ResourceLoader` 只讀取本專案 `/js/`、`/css/` 底下的真實檔案；任何其他
  URL（LINE SDK、Google Maps、CDN 等）一律回傳空內容、不真的對外連線。
- 兩支測試檔均註冊 `process.on('unhandledRejection', ...)` 監控，執行全程未觸發。
- `jsdom` window 與 Express test server 皆在 `finally` 區塊確實關閉
  （`dom.window.close()`／`server.close()`），並用 `setTimeout(...).then(process.exit)`
  避免殘留 timer/interval 導致 process 不結束。
- 已在預設時區、`TZ=UTC`、`TZ=Asia/Taipei`、`TZ=Asia/Tokyo` 下分別執行，全部 0 FAIL。

## 九、完整測試執行紀錄

| # | 指令 | 結果 | exit |
|---|---|---|---|
| 1 | `node --check routes/settings.js` | OK | 0 |
| 2 | `node --check routes/line-orders.js` | OK | 0 |
| 3 | `node --check public/js/app.js` | OK | 0 |
| 4 | `node --check scripts/smoke-h1-4-11-1-fixes.js` | OK | 0 |
| 5 | `node --check scripts/smoke-h1-4-11-2-fixes.js` | OK | 0 |
| 6 | `node --check scripts/smoke-h1-4-11-line-order-page-mode.js` | OK | 0 |
| 7 | `node scripts/smoke-h1-4-11-2-fixes.js`（含 TZ=UTC/Asia/Taipei/Asia/Tokyo） | 58 PASS / 0 FAIL（×4 次執行皆同） | 0 |
| 8 | `node scripts/smoke-h1-4-11-1-fixes.js`（含三種 TZ） | 79 PASS / 0 FAIL（×4 次執行皆同） | 0 |
| 9 | `node scripts/smoke-h1-4-11-line-order-page-mode.js` | 66 PASS / 0 FAIL | 0 |
| 10 | `node scripts/run-h1-4-9-checkout-order-summary-runtime.js` | 67 PASS / 0 FAIL | 0 |
| 11 | `node scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111 PASS / 0 FAIL | 0 |
| 12 | `node scripts/run-h1-4-10-phase1-liff-identity-runtime.js` | 68 PASS / 0 FAIL | 0 |
| 13 | `node scripts/run-h1-4-10-required-friend-gate-runtime.js` | 98 PASS / 0 FAIL | 0 |
| 14 | `node scripts/run-h1-4-10-asset-cache-bust-runtime.js` | 30 PASS / 0 FAIL | 0 |
| 15 | `node scripts/run-h1-4-10-historical-backend-reconcile-runtime.js` | 35 PASS / 0 FAIL | 0 |
| 16 | `node scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js` | 113 PASS / 0 FAIL | 0 |
| 17 | `node scripts/run-h1-4-10-friend-live-runtime.js` | 24 PASS / 0 FAIL | 0 |
| 18 | `node scripts/run-h1-4-10-friend-sec-mig-runtime.js` | 25 PASS / 0 FAIL | 0 |
| 19 | `node scripts/run-h1-4-8-checkout-backend-unification-runtime.js` | 64 PASS / 0 FAIL | 0 |
| 20 | `node scripts/smoke-delivery-distance-promotion.js` | 98 PASS / 0 FAIL | 0 |
| 21 | `node scripts/smoke-delivery-free-progress.js` | 18 PASS / 0 FAIL | 0 |

**基準版既有失敗（本輪未修改，逐字元比對與 H1.4.10 原始基準版相同，如實記錄）：**

| # | 指令 | 結果 |
|---|---|---|
| 22 | `node scripts/smoke-hotfix26-f2.js` | 22 PASS / **3 FAIL**（過期靜態斷言，見 H1.4.11 changelog） |
| 23 | `node scripts/smoke-hotfix26-f7.js` | 46 PASS / **1 FAIL**（硬編碼欄位數已過期） |
| 24 | `node scripts/smoke-cart-delivery-live-refresh.js` | exit 1（`extractBlock()` 比對已被合法重構取代的舊片段，見 H1.4.11.1 changelog） |

## 十、build_version 與 cache-bust

- `routes/line-orders.js`：`settings.build_version` 更新為 `'H1.4.11.2'`。
- `public/index.html`：`app.js` 版本 query 更新為 `?v=h1-4-11-2`（與 build_version 對齊，
  避免混用舊版本標記；`app.js` 內容本輪未變動）。
- 已確認全專案 `.html`/`.js` 內不再殘留 `h1-4-11-1` 作為 cache-bust query 使用（僅剩
  程式註解裡提及「這是哪一版加的」，非版本標記本身）。

## 十一、已知限制

1. `findNextServiceInfo()` 掃描上限 60 天（防呆非預訂限制），超過時誠實回傳 `null`。
2. `today_not_open` 仍只有三種 reason（`no_schedule`/`global_disabled`/
   `special_schedule_disabled`），對應既有 `resolveFulfillmentState()` 的既有分類，
   未新增第四種。
3. f2/f7/cart-delivery-live-refresh 三支既有測試的基準版既有失敗維持原樣，未修改
   production 邏輯迎合過期斷言。
