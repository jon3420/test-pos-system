# R54.4／MBV2-HF1-C5.4.2 補修最終報告：整單付款防護＋時間標記合併

> 交付 ZIP 本身的 SHA-256 不寫在 ZIP 內（避免自我參照），見交付訊息與專案文件 `claude/R54_4_MBV2_HF1_C5_4_2_PAYMENT_GUARD_TIME_MERGE_FIX_FINAL_REPORT.md`。

## 0. 摘要

| 項目 | 結果 |
|---|---|
| 基準 | C5.4.2（SHA-256 `f2daad57…16f4`，7,439,413 bytes，991 檔／1038 項目，manifest 988 筆逐檔相符） |
| 缺口 A | 既有的「單次付款操作驗證」缺口：付款摘要、建立付款、送出 Confirm、改現金、到期關閉只看選取的一筆付款紀錄；C5.4.2 的整單成立判定沒有同步覆蓋這些操作 |
| 缺口 B | 新增時間來源欄位與既有 MBV2 合併規則的相容性問題：合併保留本地 `updated_at`，卻把來源的 `popup_updated_tz` 當空白欄位補入 |
| 產品修改 | 6 個檔案，沒有新增產品檔、沒有 schema／觸發器變更 |
| 新增測試 | 補修驗收 22 案例；升級／回退 5 案例 |
| 補修驗收 | 未修改 C5.4.2：10／22；補修版：22／22；全新解壓：22／22 |
| 回歸 | 23 支套件在兩棵樹同時段執行，結果逐項相同；全新解壓 15 支全部通過 |
| 外部呼叫 | 真實 LINE、LINE Pay、Sandbox 0 次；未部署、未操作正式資料 |
| 狀態 | 已實作與模擬驗收（API＋真實 Chrome＋可控時鐘＋兩種主機時區）。**LINE 真機驗收：尚待進行** |

---

## 1. 基準核對

- `P3CD_DEPLOY_R54_4_MBV2_HF1_C5_4_2_POPUP_ORDER_ESTABLISHMENT_TAIPEI_TIME_FIX_APP_ROOT.zip`
  - SHA-256 `f2daad578a8dfbdd43f2a2b1d1dcc29fa49ee8731891feed20d3bf9aa90016f4`，與指定值相符；工作區既有同一份 ZIP，雜湊相符後直接使用。
  - 7,439,413 bytes；991 個檔案、1038 個 ZIP 項目；根目錄直接有 `server.js`、`package.json`。
  - `docs/R54_4_MBV2_HF1_C5_4_2/02_FILE_MANIFEST.json` 988 筆逐檔 SHA-256／大小相符；未列入的 3 檔正是該輪文件本身。
- 未使用 C5.4.1 TIMING_FIX 當本輪基準（TIMING_FIX 只在「C5.4.2 升級／回退」既有套件中當舊版使用，與上一輪相同）。
- 兩棵樹：未修改 C5.4.2 樹（只加入本輪驗收腳本）與補修工作樹；打包來源為基準 ZIP 全新解壓後只覆蓋本輪修改檔。

## 2. 缺口 A：整單仍有待核對付款，卻允許改現金

### 2.1 重現（未修改 C5.4.2）

同一張有效、未逾期的快閃訂單：較早一筆 `review`（正式流程：Confirm 回應遺失＋Inquiry 1150），較新一筆確定失敗（[FX]），`payment_status='pending'`，設定允許改現金。先經正式到期整理（狀態查詢路由內建）：

- 付款摘要：`state: payment_failed`、`under_review: false`、`can_switch_to_cash: true`；成立判定卻是「付款結果確認中，請勿重複付款」。
- 有效 token 直接 POST 改現金：200，訂單改成現金，較早一筆仍是 `review`。

同類問題（皆已重現）：

| 情境 | C5.4.2 行為 |
|---|---|
| 較早 `confirm_pending`、`pending/sent`、`pending/unknown`＋較新失敗 | 同上，可改現金 |
| 較早待核對＋較新 `pending/never` | 摘要 `can_pay: true`；建立付款入口 200，**多一次 LINE Pay Request** |
| 舊付款連結的 callback：較新一筆先建立付款，之後較早一筆進入待核對，再回到較新一筆 callback | **送出 Confirm 並入帳**（同單可能重複請款） |
| 較早已付款＋較新 `pending/never` | 摘要 `can_pay: true`；建立付款入口 200，多一次 Request |
| 顧客看到改現金後、點擊前另一筆變成待核對 | 改現金成功（Chrome 實測） |
| 已付款＋較新失敗到期 | 到期整理**釋放已付款訂單的名額** |
| 待核對＋較新失敗到期 | 訂單 `payment_status` 被改成 `cancelled`（宣告未付款） |

### 2.2 根因

- `popupPaymentSummary()` 以 `derivePopupPaymentState(order, 選取的 attempt)` 產生狀態與 `can_pay`／`can_switch_to_cash`。
- `/linepay-request`、`switchFailedAttemptToCash()`、`handleConfirmCallback()` 的送出前檢查都只看本筆。
- `_cancelOrderAndRelease()`、`commitFailed()`、`closeUnresolvedOnTimeout()`：訂單 UPDATE 有 `payment_status='pending'` 條件，但**不論是否改到列都釋放名額**；也沒有考慮同單其他結果不明的付款。
- C5.4.2 的 `popupOrderStatus`／`paymentDisplay` 已經看全部付款紀錄（未修改），只是付款頁與操作沒有使用同一個整單視角。

### 2.3 修正

`utils/popupPayment.js` 新增 `orderPaymentBlock(raw, storeId, orderId)`：以同店、同單**全部**付款紀錄與訂單欄位判斷（可在交易內以 raw 連線重新讀取）。

| 優先序 | 代碼 | 條件 |
|---|---|---|
| 1 | `refunded` | 訂單已退款 |
| 2 | `refund_pending` | 訂單待退款，或任一筆 `paid_cancelled` |
| 3 | `paid` | 訂單已付款，或任一筆 `paid` |
| 4 | `under_review` | 任一筆 `review`、`confirm_pending`，或 `pending` 且處理階段 `sent`／`unknown`（可能已請款） |

使用位置（只在必要位置加入共用驗證，沿用既有付款恢復機制）：

| 入口 | 修正 |
|---|---|
| `popupPaymentSummary()` | `state`＝整單狀態（`orderLevelState`），與成立判定一致；`can_pay`、`can_switch_to_cash` 有阻擋即為 false；本筆自身結果另以 `attempt_state`／`attempt_state_label`（「此筆付款嘗試：…」）提供，畫面不顯示、不作為許可依據 |
| `/popup-payment/linepay-request` | 有阻擋 → 409（`PAYMENT_UNDER_REVIEW`／`POPUP_PAYMENT_ALREADY_PAID`／`POPUP_PAYMENT_NOT_PAYABLE`），**在呼叫 LINE Pay Request 之前**，附上目前摘要 |
| `switchFailedAttemptToCash()` | 在實際異動的 durable 交易內重新讀取本筆、訂單與同單全部付款紀錄並驗證；不合法即拋錯回滾 |
| `/popup-payment/switch-to-cash` | 拒絕時回傳 409＋目前整單摘要 |
| `handleConfirmCallback()`（送出第一次 Confirm 前） | 在保存處理階段的同一交易內檢查；有阻擋 → 本筆不送 Confirm（不請款，授權逾期即失效），標記 `aborted_cancelled`（`failure_basis=order_payment_<code>_before_confirm`），callback 回到「確認中」。舊付款連結／callback 因此無法繞過 |
| `_cancelOrderAndRelease()`（到期、`markAttemptFailed`）、`commitFailed()`、`closeUnresolvedOnTimeout()` | 同單已付款／退款 → 不取消、不釋放；同單仍有結果不明 → 取消履約與釋放名額照舊，但付款狀態維持 `pending`；訂單 UPDATE 沒有改到列 → 不釋放 |
| `public/line-order.html` | 付款與改現金被拒絕時，以伺服器回傳的目前狀態重畫（不保留舊畫面的按鈕） |

保留的既有流程（皆有驗收）：單一確定失敗可改現金（名額只轉換一次）、正常首次付款、重複 callback 不重送 Confirm、待核對後核對成功入帳、取消後晚到的付款成功保留取消並進入待退款。唯讀核對與「請勿重複付款」提示不變。**不新增失敗原單再次繳款。**

## 3. 缺口 B：備份合併把時間標記與時間值拆開

### 3.1 重現（未修改 C5.4.2，正式 MBV2 匯出 → 上傳 → 預覽 → 匯入）

本地 `updated_at=2026-11-16 08:09:00`、`popup_updated_tz=NULL`；來源 `16:10:00`／`Asia/Taipei`；`merge`：

- 匯入回報完成、筆數核對通過。
- 結果 `updated_at=08:09:00`、`popup_updated_tz=Asia/Taipei`；API 與顧客顯示 `08:09` 且 `known=true`（把來源不明的時間誤認為台北時間）。
- 建立時間同樣：本地 `08:08:00`／NULL、來源 `08:08:00`／`Asia/Taipei` → 標記被補入，僅因無時區字串相同就推定同一時刻。
- 本地有可信 UTC 付款證據的訂單也被補入標記，顯示 `08:09`（應為 `16:09`）。

### 3.2 根因

`utils/migrationV2.js` 的 `importTable()` 合併既有列時「只補空白欄位」：`IGNORE_COMPARE._all` 含 `updated_at`（一律保留本地），但 C5.4.2 新增的 `popup_created_tz`／`popup_updated_tz` 沒有對應規則，被當一般空白欄位補入，與時間值錯配。

### 3.3 修正

- `IGNORE_COMPARE.orders` 加入 `popup_created_tz`、`popup_updated_tz`：**既有列合併時一律不比較、不補入這兩個標記**（保守策略）。
  - 本地已有可信標記 → 不被覆蓋；來源缺標記的舊備份 → 不降級。
  - `created_at` 不同仍整列衝突（既有規則），不產生半套異動。
- 新增整列不受影響：時間與標記一起寫入（成對保留）；舊備份缺標記的新增列維持 NULL。
- `utils/popupOrderTime.js`（防護，讀取時）：標記與同交易可信證據（名額紀錄、付款期限、`confirmed_at`）矛盾時以證據為準（`source` 標為 `…_overrides_marker`）。正常寫入的標記不會與證據矛盾；此規則讓 C5.4.2 或回退後舊版合併已錯配的資料，在有證據時仍能正確換算。
- 不改寫本地歷史時間、不一律加八小時、不改成匯入當下時間、不清除既有可信標記；沒有證據者維持原值並標示「時區未確認」。MBV2 既有合併、跳過、衝突與交易回滾原則不變。

## 4. 修改檔案

| 檔案 | 變更 |
|---|---|
| `utils/popupPayment.js` | `orderPaymentBlock`／`orderBlockError`／`orderLevelState`；`switchFailedAttemptToCash` 交易內重新驗證；`_cancelOrderAndRelease` 整單防護（匯出為 `closeOrderAfterAttempt`） |
| `utils/popupPaymentRecovery.js` | Confirm 送出前交易內整單檢查；`commitFailed`、`closeUnresolvedOnTimeout` 改用整單防護並只在訂單確實更新時釋放名額 |
| `routes/popup-public.js` | 付款摘要改為整單狀態與許可；建立付款入口整單阻擋；改現金拒絕回傳目前摘要 |
| `public/line-order.html` | 付款／改現金被拒絕時以伺服器狀態重畫 |
| `utils/migrationV2.js` | 合併既有列不比較、不補入兩個時間來源標記 |
| `utils/popupOrderTime.js` | 標記與可信證據矛盾時以證據為準 |

未修改：`utils/popupOrderStatus.js`、`utils/paymentDisplay.js`（已依全部付款紀錄判定）。

新增測試：`scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-upgrade-rollback.js`。既有測試與斷言全部未修改。

## 5. 測試結果

### 5.1 補修驗收（同一份腳本、同一組斷言）

標記：[API] 正式路由＋暫存 SQLite；[BR] 真實 Chrome 實際點擊；[FX] 直接寫入資料庫的 fixture（同單第二筆付款紀錄、部分第一筆處理階段、B 類本地舊值與來源備份內容；正常操作無法產生，明確標示，不冒稱完整使用者操作）；[DB] 資料庫欄位；[CLK] 可控時鐘。其餘狀態（review、paid、failed、重複 callback、核對成功、取消後晚到成功）與 B 類匯出／匯入皆由正式流程產生。LINE Pay 替身記錄 Request／Confirm／Inquiry 次數。

| 案例 | 分類 | C5.4.2 | 補修版 | 全新解壓 |
|---|---|---|---|---|
| A1 review＋較新失敗：摘要＝確認中、不提供付款／改現金；直接 POST 改現金 409；資料與 LINE Pay 呼叫不變 [API][FX] | DE | ❌ | ✅ | ✅ |
| A2 confirm_pending／pending-sent／pending-unknown＋較新失敗 [API][FX] | DE | ❌ | ✅ | ✅ |
| A3 待核對＋較新 pending/never：建立付款入口 409、Request 0 [API][FX] | DE | ❌ | ✅ | ✅ |
| A4 舊付款連結 callback：不送 Confirm、不入帳 [API][FX] | DE | ❌ | ✅ | ✅ |
| A5 已付款＋較新失敗／pending：不可付款或改現金，Request 0、名額維持 [API][FX] | DE | ❌ | ✅ | ✅ |
| A6 看到可改現金後另一筆變待核對：後端重新驗證拒絕 [API][FX] | DE | ❌ | ✅ | ✅ |
| A7 正常單一失敗改現金：一次成功、重複 409、名額只轉一次 [API] | G | ✅ | ✅ | ✅ |
| A8 正常付款、重複 callback 不重送 Confirm [API] | G | ✅ | ✅ | ✅ |
| A9 待核對後核對成功入帳；取消後晚到成功 → 待退款、不恢復名額 [API] | G | ✅ | ✅ | ✅ |
| A10 付款頁（較新一筆憑證）顯示確認中、無付款／改現金按鈕 [BR][FX] | DE | ❌ | ✅ | ✅ |
| A12 Chrome：看到改現金 → 另一筆變待核對 → 按下被拒並改顯示確認中 [BR][FX] | DE | ❌ | ✅ | ✅ |
| A11 到期：已付款單名額不釋放；待核對單不宣告未付款 [API][FX][CLK] | DE | ❌ | ✅ | ✅ |
| B1 精確重現：08:09／NULL＋來源 16:10／台北 → 標記維持 NULL、顯示「時區未確認」（含 Chrome） [API][DB][BR] | DE | ❌ | ✅ | ✅ |
| B2 本地可信 UTC 付款證據 → 仍顯示 16:09 [API][DB][FX] | DE | ❌ | ✅ | ✅ |
| B3 created_at 配對：字串相同不推定同一時刻 [API][DB][FX] | DE | ❌ | ✅ | ✅ |
| B4 本地可信台北配對＋舊備份缺標記 → 保留本地 | G | ✅ | ✅ | ✅ |
| B5 新增整列：時間與標記成對保留；缺標記維持 NULL | G | ✅ | ✅ | ✅ |
| B6 明確 Z／+08:00 跨午夜，不重複加八小時 | G | ✅ | ✅ | ✅ |
| B7 預覽回滾、保存失敗整批回滾、匯入核對、重複匯入、skip | G | ✅ | ✅ | ✅ |
| B8 來源衝突整列不動 | G | ✅ | ✅ | ✅ |
| B9 主機 TZ=UTC 與 Asia/Taipei 結果相同 | G | ✅ | ✅ | ✅ |
| Z 真實 LINE／LINE Pay 0 次 | G | ✅ | ✅ | ✅ |

合計：C5.4.2 10／22、補修版 22／22、全新解壓 22／22。12 項基準失敗都是業務斷言（付款狀態與許可、資料庫欄位、畫面文字），沒有「補修版函式不存在」造成的例外。

### 5.2 升級與回退（同一資料庫檔；舊版＝未修改 C5.4.2）

| 案例 | 補修版 | 全新解壓 |
|---|---|---|
| UP1 C5.4.2 產生的資料（含既有多筆付款 [FX]）升級：結構與資料逐列不變；防護立即生效、拒絕後資料不變 | ✅ | ✅ |
| UP2 重複啟動不變 | ✅ | ✅ |
| RB1 回退 C5.4.2：可啟動、結構不變、結帳／接單／查詢正常 | ✅ | ✅ |
| RB2 再升級：結構不變、資料可查、防護仍生效 | ✅ | ✅ |
| Z 外部呼叫 0 | ✅ | ✅ |

既有「C5.4.2 升級／回退」（TIMING_FIX → 補修版）6／6。

### 5.3 回歸（兩棵樹同時段並行；全新解壓單獨執行）

| 套件 | C5.4.2 | 補修版 | 全新解壓 |
|---|---|---|---|
| C5.4.2 主驗收 | 29／29 | 29／29 | 29／29 |
| C5.4.2 升級／回退 | 6／6 | 6／6 | 6／6 |
| C5.4.1 原 19 項 | 19／19 | 19／19 | 19／19 |
| TIMING_FIX 11 項 | 11／11 | 11／11 | 11／11 |
| C5.4 付款與快閃 | 27／27 | 27／27 | 27／27 |
| C5.3 付款安全 | 25／25 | 25／25 | 25／25 |
| C5.2 付款恢復 | 33／33 | 33／33 | — |
| phase3 一般點餐付款 | 111 | 111 | 111 |
| phase4b full／frontend／resume | 168／50／92 | 168／50／92 | 168／—／— |
| 快閃前端（jsdom）／真實瀏覽器 | 293／36 | 293／36 | 293／36 |
| 快閃公開結帳／結帳整合／購物車恢復前端／狀態 | 1447／20／67／94 | 1447／20／67／94 | 1447／—／—／— |
| MBV2 匯出／合併／預覽 | 121 | 121 | 121 |
| C5.1 訂單識別一致性 | 61 | 61 | 61 |
| C3.3 還原取消、C4.1 去重續傳 | 30／40 | 30／40 | — |
| C1 LINE 預購狀態 | 93 | 93 | — |
| R48 快閃前台 smoke | 10／13 | 10／13 | — |

兩棵樹 23 支套件結果逐項相同。R48 的 3 項（`R_FATAL`、`R_NO_STICKY_FIXED`、`R_TOUCH_TARGET_44`）是 C5.4.1 以前即存在的場次頁頁首 40px／sticky／捲動逾時，失敗鍵逐項相同，非本輪回歸。

### 5.4 全新解壓與最終比對

- 候選 ZIP（不含本輪三份文件）：993 個檔案、1040 個項目，SHA-256 `8c544637c30780bc300daa77b9d875aa104be2ce260bd56bc0d030643b1cff59`。
- 全新解壓 → `npm ci`（476 packages）→ 空資料庫、TZ=UTC 啟動：`/api/health` 200、`/popup-order` 200、啟動紀錄無錯誤。
- 在全新解壓目錄執行 §5.1～§5.3 標示的套件，全部通過。
- 最終 ZIP 與候選逐檔比較：候選 993 個檔案逐位元組相同；最終只多 `docs/R54_4_MBV2_HF1_C5_4_2_PAYMENT_GUARD_TIME_MERGE_FIX/` 三份文件，產品與測試程式不需重跑。

## 6. 資料庫變更、相容性與回退

- **沒有 schema／觸發器變更**：沿用 C5.4.2 的 `orders.popup_created_tz`／`popup_updated_tz` 與兩個觸發器（UP1 逐項比對結構相同）。
- 回退：直接部署 C5.4.2 套件即可，資料庫不需處理（RB1 實測）。回退期間的限制：
  - 付款頁與改現金回到「只看選取付款紀錄」，同單多筆且有待核對時可能再次允許改現金或建立付款；舊付款連結的 callback 可能送出 Confirm。正常操作每張訂單只有一筆付款紀錄，此情境需要歷史多筆紀錄才會出現。
  - 回退期間執行 MBV2 合併可能再次把來源標記補到本地時間上；再升級後，有可信證據者以證據顯示，其餘仍顯示被補入的標記（無法自動辨識）。建議回退期間不執行 merge 匯入。
- 本補修不改寫任何訂單、付款、名額或時間資料；只在新的不合法操作發生時拒絕。

## 7. 部署後最短真機驗收步驟

1. 在 LINE 開快閃場次，以 LINE Pay 下 1 元訂單並完成付款：付款頁「付款狀態：已付款」「訂單：已成立」。
2. 另下一筆 1 元，在 LINE Pay 頁取消：付款頁應顯示付款失敗、未成立，並可「改用現金」；按下後改為「已成立，取貨時付款」，再按不會重複轉換。
3. 用同一筆的舊付款頁重新整理：不應再出現付款或改現金按鈕。
4. 後台搬家：匯出訂單備份後，以 merge 匯入同一店（或測試店）：完成後我的訂單時間不變；舊訂單若顯示「時區未確認」，匯入後仍維持，不會變成另一個時間。

多筆付款紀錄的待核對情境無法在正常操作中產生，以模擬驗收為準；LINE App 內建瀏覽器、iOS Safari、真實 LINE Pay 尚待真機驗證。

## 8. 檔案清單

- 產品修改（6）：`public/line-order.html`、`routes/popup-public.js`、`utils/migrationV2.js`、`utils/popupOrderTime.js`、`utils/popupPayment.js`、`utils/popupPaymentRecovery.js`
- 測試新增（2）：`scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-upgrade-rollback.js`
- 文件：`docs/R54_4_MBV2_HF1_C5_4_2_PAYMENT_GUARD_TIME_MERGE_FIX/00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json`；先前各輪文件（含 `docs/R54_4_MBV2_HF1_C5_4_2/`）原樣保留並列入 manifest
- 排除：`node_modules/`、資料庫檔、`.env`、上傳資料、log、測試輸出與秘密資料；原有 `.env.example` 保留
