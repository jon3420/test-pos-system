# H1.4.11.1｜LINE 點餐頁模式 最小補正

直接基底：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11-...-full.zip`（H1.4.11）。
全程未回退 H1.4.10 重做，未進行無關重構。

## 一、Toast 定位（原：底部；修正：頂部安全區）

- `修改前`：`.toast{position:fixed;bottom:calc(80px + env(safe-area-inset-bottom,0px));...white-space:nowrap;...text-overflow:ellipsis}`
- `修改後`：`.toast{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));...word-break:break-word;...}`，移除 `bottom`／`white-space:nowrap`／`text-overflow:ellipsis`，z-index 由 999 提升到 999999（不被 LIFF 標題列或既有 Modal overlay 遮住），保留 `position:fixed`。
- 驗證：CSS 原始碼層級斷言（`.toast{}` 規則本身，不誤判其他規則）＋ jsdom 實際呼叫 `toast()` 長文案後讀回 `textContent` 完整保留。

## 二、下一次服務時間（原：只有通用文字；修正：後端權威日期/時間）

- `routes/line-orders.js` 新增 `findNextServiceInfo(mode, modeSettings)`，完全複用既有
  `getDateClosedStatus()`／`getEffectiveModeSchedule()`（含 Business Calendar／每週營業
  時間／今日覆寫優先序），從明天起掃描最多 60 天（純防呆上限，不是預訂視窗限制），
  外帶／外送分開呼叫。結果經 `GET /api/line-orders/shop` 以
  `takeout_next_service`／`delivery_next_service`（`{date, start_time}` 或 `null`）回傳。
  找不到時誠實回傳 `null`，不捏造日期。
- 這個欄位與 `allow_next_day`／`canPreorderFutureDays`（能不能現在預訂）完全無關——即使
  預訂關閉，`next_service` 仍會計算並顯示，純資訊用途；本身**不會**、也**沒有**被拿去
  覆寫 `selectable`／`canPreorder`／`canOrderNow`（這三個欄位的計算式完全未變動）。
- 前端 `getFulfillmentStatus()` 新增 `nextServiceDate`／`nextServiceStartTime` 欄位（單純
  透傳，不重新計算）；`_ffDetailText()`／`_ffToastText()` 在「今日已結束＋不可預訂」
  「今日公休」「今日未開放但有下一次資料」時改用這兩個欄位組字。
- 新增 `_ffDayLabel(dateStr)`：0/1 天用「今日」／「明日」，≥2 天一律用真實星期幾（例如
  「週一」），不是「後天」／「N天後」——對齊需求文件二的兩個範例格式。刻意與既有
  `dayOffsetLabel()`（其他既有呼叫點仍用「後天」／「N天後」）分開，不影響既有呼叫點。

## 三、`today_not_open` 文案細分（原：一律「目前未提供」；修正：依 reason/holidaySource）

`_ffShortLabel()` 新規則：
- `holiday` + `holidaySource==='today_closed'` → 「今日臨時休息」；其餘 holiday → 「今日公休」。
- `today_not_open` + `reason==='no_schedule'` → 「今日未開放」。
- `today_not_open` + `reason` 為 `global_disabled`／`special_schedule_disabled` → 「目前未提供」。
- `today_not_open` 且 `canPreorderFutureDays===true` → 一律改顯示「可預約」，避免「文字說未提供、卻仍可點擊」的矛盾（需求文件三末段）。

全部只讀取既有 `resolveFulfillmentState()` 已算好的欄位，未新增第二套時間/狀態計算器。

## 四、`routes/settings.js` enum 嚴格驗證（原：`if(pageMode && ...)`會放行空字串；修正：hasOwnProperty + 型別/內容雙重檢查）

- `修改前`：`if (req.body.line_order_page_mode !== undefined) { const pageMode = String(raw).trim(); if (pageMode && !VALID...includes(pageMode)) return 400; }` — 明確送出 `""`／`"   "` 時 `pageMode` 為假值，條件不成立，**會被放行寫入**。
- `修改後`：`if (Object.prototype.hasOwnProperty.call(req.body, 'line_order_page_mode')) { const pageMode = typeof raw==='string' ? raw.trim() : null; if (!pageMode || !VALID...includes(pageMode)) return 400; req.body.line_order_page_mode = pageMode; }` — 空字串／純空白／`null`／陣列／物件／數字一律因為 `typeof raw!=='string'`（非字串）或 trim 後為空字串而被拒絕。
- `VALID_LINE_ORDER_PAGE_MODES` 改為模組層級只定義一次，驗證邏輯與 `router.__test` 匯出共用同一個陣列參照（不再各自維護一份）。
- 合法值 trim 後正規化寫回 `req.body`，沿用既有「寫入允許的 key」共用迴圈，不重複寫 DB 程式碼。

## 五、頁面模式改變時的重繪與生命週期（原：只在 enabled/cutoff 改變時重繪；修正：獨立比較 + coalescing）

- `refreshShopStatus()` 新增：更新 `shopData` 後立即比較 `line_order_page_mode` 前後值，
  若改變則呼叫 `buildServiceStatusBar()` 並清除 `_ffViewMode`（不動 `currentMode`／
  `oType`／購物車）。這個分支獨立於既有「enabled/cutoff/todayClosed 改變才重繪」的判斷，
  兩者互不影響、不重複。
- 新增 `requestShopStatusRefresh()`：60 秒輪詢／`pageshow`／`visibilitychange` 三個觸發
  來源共用同一個 in-flight Promise，避免同時觸發時發出重複請求或新舊回應交錯覆蓋；
  `finally` 保證無論成功或失敗都會解除鎖定，不會永久卡死無法再刷新。
- 原本寫在 `init()` 內的匿名生命週期註冊區塊，抽成具名、冪等的
  `wireFulfillmentLifecycleRefresh()`，由 `init()` 呼叫；函式本身用
  `window._lifecycleWired` guard 防止重複註冊，回傳值可供測試判斷本次是否真的完成
  註冊。測試直接呼叫這支正式函式兩次驗證去重，不是另外重寫一份示意版本。

## 六、圖塊鍵盤操作 double-fire 風險（原：`onclick`+`onkeydown` 各自呼叫同一函式；修正：只保留原生 button 行為）

- `_ffTileHtml()` 移除 `onkeydown="if(event.key==='Enter'||event.key===' '){...}"`，只保留
  `<button type="button">` + `onclick`——原生 button 本身對 Enter/Space 已有觸發 click 的
  預設行為，不需要、也不應該再手動重複綁一次。
- 保留：`aria-disabled`、`.ff-tile:focus-visible` CSS、不使用原生 `disabled`（灰色圖塊仍
  需要能被點擊以顯示 Toast 原因）。

## 七、測試補強與更新

### 新增 `scripts/smoke-h1-4-11-1-fixes.js`（71 PASS / 0 FAIL）

涵蓋：Toast CSS 定位與長文案不截斷／`_ffDayLabel`／`_ffDetailText`／`_ffToastText` 的下一
次服務時間文案／`_ffShortLabel` 的 reason／holidaySource 細分／圖塊移除 onkeydown 後單次
點擊只觸發一次處理／頁面模式單獨改變觸發重繪＋`_ffViewMode` 清除＋無多餘重繪／
`requestShopStatusRefresh()` in-flight coalescing（含鎖定解除後可再次真正發送請求）／
正式 `wireFulfillmentLifecycleRefresh()` 直接呼叫兩次驗證去重／合併模式點擊「非目前
`currentMode`」的可用圖塊只改 `_ffViewMode`、不呼叫 `applyFulfillmentMode()`/
`selectFulfillmentMode()`／**真實**（非 spy）`applyFulfillmentMode()` 整合測試（`currentMode`／
`#oType`／購物車保留／可逆切回）／`settings.js` enum 嚴格驗證的七種非法輸入＋trim＋
未送出保留＋單一定義來源／`findNextServiceInfo()` 端到端（含外帶外送分開計算、
`allow_next_day=0` 時仍計算、連續公休時誠實回傳 `null`）。

### 更新 `scripts/smoke-h1-4-11-line-order-page-mode.js`（62 → 66 PASS，0 FAIL）

- **D7c 過期預期更新**：原斷言「圖塊具備 onkeydown」是修正鍵盤 double-fire 風險前的
  預期，H1.4.11.1 移除 onkeydown 後這個斷言必然恆假。改寫為驗證修正後的正確狀態
  （D7＝原生 `<button type="button">`；D7b＝有 `aria-disabled="true"`；D7c＝不用原生
  `disabled`；D7d＝**不**包含 inline `onkeydown`），並新增 D7e：實際在 DOM 上對不可用
  圖塊 dispatch 一次 click，驗證只產生一次 Toast、且不寫入 `_ffViewMode`／不改變
  `currentMode`。未直接刪除或弱化原本的驗收意圖（「灰色圖塊只顯示 Toast、不可成為
  訂單方式」），只是把「用什麼機制達成鍵盤可操作性」的斷言改成符合修正後的正確實作。
- 其餘 60 項既有斷言（8 狀態真值表、settings API、圖塊渲染、Toast 去重、生命週期去重等）
  全數維持原樣重跑通過，未因本輪修改而需要調整。

### 已修改的測試

- 無其他測試因本輪修改而需要調整文案／欄位／行為預期。

## 八、完整測試執行紀錄（實際指令與結果）

| # | 指令 | 結果 | exit |
|---|---|---|---|
| 1 | `node --check routes/settings.js` | OK | 0 |
| 2 | `node --check routes/line-orders.js` | OK | 0 |
| 3 | `node --check public/js/app.js` | OK | 0 |
| 4 | `node --check scripts/smoke-h1-4-11-1-fixes.js` | OK | 0 |
| 5 | `node scripts/smoke-h1-4-11-1-fixes.js` | **71 PASS / 0 FAIL** | 0 |
| 6 | `node scripts/smoke-h1-4-11-line-order-page-mode.js` | **66 PASS / 0 FAIL** | 0 |
| 7 | `node scripts/run-h1-4-9-checkout-order-summary-runtime.js` | 67 PASS / 0 FAIL | 0 |
| 8 | `node scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111 PASS / 0 FAIL | 0 |
| 9 | `node scripts/run-h1-4-10-phase1-liff-identity-runtime.js` | 68 PASS / 0 FAIL | 0 |
| 10 | `node scripts/run-h1-4-10-required-friend-gate-runtime.js` | 98 PASS / 0 FAIL | 0 |
| 11 | `node scripts/run-h1-4-10-asset-cache-bust-runtime.js` | 30 PASS / 0 FAIL | 0 |
| 12 | `node scripts/run-h1-4-10-historical-backend-reconcile-runtime.js` | 35 PASS / 0 FAIL | 0 |
| 13 | `node scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js` | 113 PASS / 0 FAIL | 0 |
| 14 | `node scripts/run-h1-4-10-friend-live-runtime.js` | 24 PASS / 0 FAIL | 0 |
| 15 | `node scripts/run-h1-4-10-friend-sec-mig-runtime.js` | 25 PASS / 0 FAIL | 0 |
| 16 | `node scripts/run-h1-4-8-checkout-backend-unification-runtime.js` | 64 PASS / 0 FAIL | 0 |
| 17 | `node scripts/smoke-delivery-distance-promotion.js` | PASS（全過） | 0 |
| 18 | `node scripts/smoke-delivery-free-progress.js` | PASS（全過） | 0 |

**基準版既有失敗（本輪未修改 production 邏輯迎合，如實記錄）：**

| # | 指令 | 結果 | 說明 |
|---|---|---|---|
| 19 | `node scripts/smoke-hotfix26-f2.js` | 22 PASS / **3 FAIL** | 與未修改的 H1.4.10 原始基準版逐字元相同（見 H1.4.11 changelog 4.3 節）；過期靜態 regex 斷言，非本次回歸 |
| 20 | `node scripts/smoke-hotfix26-f7.js` | 46 PASS / **1 FAIL** | 同上，硬編碼欄位數已過期 |
| 21 | `node scripts/smoke-cart-delivery-live-refresh.js` | exit 1 | **本輪新確認**：在未修改的 H1.4.10 原始基準版上執行，同樣因為 `extractBlock()` 找不到已被合法重構取代的舊原始碼片段而丟出例外，逐字元相同的失敗訊息；同一類「比對過期原始碼片段」的既有測試問題，非本次回歸，未修改 production 邏輯 |

## 九、build_version 與 cache-busting

- `routes/line-orders.js`：`settings.build_version` 由 `'fix18-10-hotfix30-B2'` 更新為
  `'H1.4.11.1'`（非敏感診斷值，純供前台/客服核對目前載入的後端版本，`GET /shop` 既有欄位，
  未新增端點）。確認沒有任何既有測試斷言這個字串的確切值（既有測試用的是各自的 mock
  `'test'`），變更安全。
- `public/index.html`：`app.js` 版本 query 由 `?v=h1-4-11-1` 更新為 `?v=h1-4-11-1-fix1`
  （`app.js` 本身內容這輪未變動，但依你的指示更新版本標記以利辨識）。
- `.html` 仍全面套用既有 `server.js` 規則（`Cache-Control: no-store, no-cache,
  must-revalidate`），未全面停用快取，未修改 `server.js`。
- `run-h1-4-10-asset-cache-bust-runtime.js` 重新執行仍 30/30 通過，確認未破壞 H1.4.10 的
  asset-cache/backend-reconcile。

## 十、已知限制

1. `today_not_open` 仍對應「後台手動暫停」與「後台完全未提供該服務方式」兩種情境（沿用
   既有 `resolveFulfillmentState()` 語意），H1.4.11.1 已補上「若未來仍可預約則顯示可預約」
   的修正，但兩種「不可預約」的子情境本身仍共用同一個 `global_disabled` reason，未進一步
   拆分（若日後需要，需後端新增欄位，不在本輪最小補正範圍內）。
2. `findNextServiceInfo()` 掃描上限為 60 天，屬防呆上限非預訂視窗限制；理論上連續公休
   超過 60 天的極端設定會誠實回傳 `null`（不捏造），前端會改用通用文字。
3. `smoke-hotfix26-f2.js`／`smoke-hotfix26-f7.js`／`smoke-cart-delivery-live-refresh.js`
   存在基準版就有的過期靜態斷言，本輪未修改，見上表第 19～21 項。
