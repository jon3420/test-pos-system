# fix18-10-hotfix30-C1-回退｜LINE 商品販售時段回退為單一共同時段

## 1. 版本資訊

- **回退對象**：`fix18-10-hotfix30-C1`（外帶/外送商品販售時段分流，見
  `CHANGELOG_HOTFIX30_C1_PRODUCT_SALE_WINDOWS.md`）與其後續 hotfix
  （`CHANGELOG_HOTFIX30_C1_HOTFIX_APPLY_RESET_WIDTH.md`）
- **性質**：功能回退（不刪除資料庫欄位、不做破壞性 migration，僅回退前端 UI／
  部分後端判斷邏輯，寫入來源改回單一共同欄位）

## 2. 修改檔案清單與摘要

| 檔案 | 修改摘要 |
|---|---|
| `public/index.html` | 批次操作面板、商品總表欄位、單項「⚙️LINE設定」Modal 全數移除外帶/外送分流時間輸入框，恢復單一「販售時段」欄位＋「取消設定（重置）」按鈕；表格 `colspan` 由 16 → 14。 |
| `public/js/app.js` | 新增共用 helper `_lpmEffectiveSaleWindow(p)`（讀取優先順序：共同欄位優先，雙欄位相同才 fallback，不同則視為未設定）；`lpmApplyAll()`／`lpmBatch()`／`lpmSaveRow()`／`calcLpmStatus()`／`renderLpmTable()` 全部改回讀寫單一 `line_sell_start`/`line_sell_end`；新增 `lpmResetSaleWindow()`（批次區重置）與 `resetLineSellWindow()`（Modal 重置，僅清空畫面欄位，不直接呼叫 API）；`openLineSettingsModal()`／`saveLineSettings()` 改用 `_lpmEffectiveSaleWindow()` 載入、只寫入共同欄位。 |
| `routes/line-orders.js` | `getEffectiveProductSaleWindow(product, _mode)` 回退為回傳單一共同時段（同一套讀取優先順序，與前端 `_lpmEffectiveSaleWindow` 規則一致），`mode` 參數保留但不再影響回傳值；商品可購買判斷（`_computeProductTimeReason`／`productTimeReasonTakeout`／`productTimeReasonDelivery`）改為共用同一次判斷結果，不再因外帶/外送個別時間而分岔；新增 `module.exports.getEffectiveProductSaleWindow` 供回歸測試使用。 |
| `routes/products.js` | PATCH `/:id/line-settings`：新增 `normalizeOptionalTime()`（`undefined`＝未修改／`null`或`''`＝明確清除為 `null`）；`line_sell_start`/`line_sell_end` 以此函式正規化後寫入（原本寫入空字串，現在明確清除時寫入 SQL `NULL`）；舊版 `line_takeout_sell_*`/`line_delivery_sell_*` 欄位驗證與寫入邏輯保留（API 仍相容接受，供其他呼叫端使用），但管理頁不再主動送出這四個欄位。 |
| `public/css/main.css` | 批次區／表格逐行編輯／Modal 的時間欄位 CSS 選擇器改回對應單一欄位 ID（`#lpm-today-sell-start/end`、`[id^="lpm-ed-sell-start-"]`／`[id^="lpm-ed-sell-end-"]`、`#lineSellStart`/`#lineSellEnd`），統一 `min-width:120px`（Modal／批次區）或 `100px`（表格逐行編輯，欄位較窄）；相關 `<input type="time">` 額外加上 `lang="en-GB"` 強制瀏覽器以 24 小時制渲染，從根本避免「上午/下午」佔用額外寬度導致分鐘被裁切。 |
| `scripts/smoke-hotfix30-c1-rollback.js` | **新增**回歸測試腳本（純函式測試，不需啟動伺服器/資料庫）：驗證共用時段解析優先順序、雙欄位相同/不同的處理、重置後 unrestricted、外帶/外送判斷一致，以及靜態掃描確認 UI 主要流程不再含有拆分欄位。 |
| `CHANGELOG_HOTFIX30_C1_ROLLBACK_SINGLE_SALE_WINDOW.md` | **新增**本檔案。 |

歷史 CHANGELOG（`CHANGELOG_HOTFIX30_C1_PRODUCT_SALE_WINDOWS.md`、
`CHANGELOG_HOTFIX30_C1_HOTFIX_APPLY_RESET_WIDTH.md`）維持原樣不修改，作為
該階段功能曾經存在過的歷史紀錄。

## 3. Repo-wide 搜尋結果摘要

搜尋詞（依回退指令第八節）：`lineTakeoutSellStart`、`lineTakeoutSellEnd`、
`lineDeliverySellStart`、`lineDeliverySellEnd`、`sell_time_takeout`、
`sell_time_delivery`、`sell_time_both`、外帶商品販售時間、外送商品販售時間、
外帶起、外帶迄、外送起、外送迄、takeout/delivery/per-mode sale window。

- **UI／Modal／表格／批次按鈕／商品可購買判斷／狀態計算／主要寫入流程**：皆已
  清除，逐一以 grep 確認（見下方勾選）。
- **允許保留的殘留**（皆為歷史紀錄或必要相容代碼）：
  - `CHANGELOG_HOTFIX30_C1_PRODUCT_SALE_WINDOWS.md`、
    `CHANGELOG_HOTFIX30_C1_HOTFIX_APPLY_RESET_WIDTH.md`：歷史 CHANGELOG，
    描述當時已完成的功能，不修改。
  - `public/index.html` 兩處回退說明註解本身提到「外送商品販售時間」，純粹是
    描述「已移除該功能」的註解文字，非程式碼。
  - `routes/products.js`：`ensureProductSaleWindowColumns()`（migration，欄位
    定義）、PATCH handler 中 `line_takeout_sell_*`/`line_delivery_sell_*` 的
    格式驗證與 `add()` 寫入（API 相容層，未被前端呼叫）、`enrichProduct()` 中
    原樣回傳新欄位（API response 相容欄位）。
  - `routes/line-orders.js`：`getEffectiveProductSaleWindow()` 內部讀取
    `line_takeout_sell_*`/`line_delivery_sell_*` 作為 fallback 判斷來源（清楚
    標示為 compatibility fallback）。
  - `public/js/app.js`：`_lpmEffectiveSaleWindow()` 內部同樣讀取這四個舊欄位
    作為 fallback 判斷來源。
  - `外送起`/`外送迄` 另有兩筆誤判（`外送起點`＝店家地址/外送起點設定，與販售
    時段功能無關，予以排除）。

未發現殘留於：LINE 商品管理主表、單項 Modal、批次操作按鈕、商品可購買判斷
（`is_orderable`／`takeoutSoldOutReason`／`deliverySoldOutReason`）、商品狀態
計算（`calcLpmStatus`）、新增或更新商品的主要寫入流程（`lpmApplyAll`／
`lpmBatch`／`lpmSaveRow`／`saveLineSettings`）。

## 4. 執行過的測試與結果

```
$ node -c public/js/app.js               → 通過
$ node -c routes/line-orders.js          → 通過
$ node -c routes/products.js             → 通過
$ node -c scripts/smoke-hotfix30-c1-rollback.js → 通過
$ node scripts/smoke-hotfix30-c1-rollback.js
  [1] 後端 getEffectiveProductSaleWindow()：5/5 通過
  [2] 前端 _lpmEffectiveSaleWindow()：5/5 通過
  [3] 靜態殘留檢查：11/11 通過
  總計：22 通過，0 失敗
$ npm test → 專案本身未定義 test script（package.json 無 "test" 欄位），
             以上方新增的 scripts/smoke-hotfix30-c1-rollback.js 作為本次
             最小必要 regression（回退指令第十節：若無現成測試則補最小
             regression script）。
```

未執行完整伺服器啟動（`npm start`）或連線資料庫的端對端測試，因本沙盒環境未
安裝 `node_modules`（`npm install` 需要外部套件如 express、sql.js、escpos 等，
超出本次純函式回歸測試範圍）；上述純函式測試已涵蓋驗收案例 1、3、4、5 的核心
邏輯（共用時段解析優先順序、雙欄位不同不得採用、重置後 unrestricted、外帶/
外送判斷完全一致）。案例 2（Modal 儲存後重新開啟一致）、6（售完）、7（店鋪
只開外帶）、8（時間顯示裁切）需要實際啟動伺服器＋瀏覽器操作驗證，建議部署後
於 staging 環境依驗收指令第九節逐項人工驗證。

## 5. 是否仍保留舊雙時段欄位

**是，完整保留，未做任何刪除或破壞性 migration：**

- 資料庫欄位 `line_takeout_sell_start`、`line_takeout_sell_end`、
  `line_delivery_sell_start`、`line_delivery_sell_end` 維持存在
  （`ensureProductSaleWindowColumns()` migration 函式未變動）。
- API（`GET /api/products`、`PATCH /:id/line-settings`）仍相容讀取／接受這
  四個欄位，避免舊版前端或其他呼叫端因欄位消失而報錯。
- 保留原因：回退指令第七節明確要求「不要刪欄位、不要做破壞性 migration」，且
  這四個欄位仍作為「舊資料相容 fallback」的資料來源（見
  `getEffectiveProductSaleWindow()`／`_lpmEffectiveSaleWindow()` 讀取優先順序
  第 2 步）。
- 本次**沒有**新增「儲存共同時段時同步覆蓋四個舊欄位」的行為，因為回退指令
  明確要求「除非現有舊版客戶端仍明確依賴這四個欄位，而且測試證明必須同步」
  才做同步，目前沒有這樣的證據或測試需求，故不新增此同步邏輯。

## 6. 驗收對照（回退指令第九節）

| 案例 | 對應驗證方式 |
|---|---|
| 1. 批次套用共同時段 | `lpmApplyAll()` 已改為單一 `line_sell_start`/`line_sell_end`；smoke test 案例 A 驗證解析邏輯 |
| 2. 單項 Modal 儲存 | `openLineSettingsModal()`/`saveLineSettings()` 已改用共用 helper 與單一欄位（建議 staging 人工複驗） |
| 3. 單項重置 | `resetLineSellWindow()` 只清空畫面欄位，儲存後由 `normalizeOptionalTime()` 正規化為 `null`；smoke test 案例 D 驗證 unrestricted |
| 4. 舊雙欄位相同 | smoke test 案例 B：兩組時間相同 → fallback 為共同時段 |
| 5. 舊雙欄位不同 | smoke test 案例 C：兩組時間不同 → 視為未設定，不任意選一組 |
| 6. 商品售完 | 未改動 `line_quota_*`／`realSoldOut` 判斷邏輯 |
| 7. 店鋪只開外帶 | 未改動 `line_takeout_enabled`／`line_delivery_enabled`／店鋪模式開關判斷邏輯 |
| 8. 時間欄位裁切 | CSS `min-width`/`width` 規則＋`lang="en-GB"` 強制 24 小時制（建議瀏覽器人工複驗） |

## 7. 最終交付

- **ZIP 檔名**：見對話中 `present_files` 附件
- **打包規則**：使用本次驗證完成的工作目錄打包；不包含 `node_modules`、
  `.git`、任何資料庫檔案或 `.env`；根目錄結構與原交付版本一致
  （`pos-web-fix18-10-hotfix30-C1-hotfix-full/` 為根目錄）。
- **SHA-256**：見對話回覆內容
