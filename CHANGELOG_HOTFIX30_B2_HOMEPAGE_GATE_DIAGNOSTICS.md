# fix18-10-hotfix30-B2｜正式環境狀態診斷 × 首頁 Gate 容錯 × 尚未營業提示修正

## 重要聲明（先講清楚能證明什麼、不能證明什麼）

本輪工作在**本機沙盒環境**進行：實際啟動 Node server、實際寫入/查詢 SQLite（sql.js）、
以真實 HTTP 請求對真實 API 驗證。**沒有、也無法直接連線到使用者的 Zeabur 正式站**，因此：

- ✅ 可以證明：程式碼邏輯本身在本機環境下的行為（Case P–U 全數以真實 HTTP 請求驗證）。
- ✅ 可以證明：找到並修正了一個會導致「明明還會營業，卻被當成整天不可用」的真實邏輯
  bug（`buildServiceStatusBar()` 與首頁 Gate 都只判斷 `enabled` 布林值，沒有分辨
  `not_started` 與 `today_not_open`/`holiday`），且這個 bug 在本機重現時**症狀與使用者
  回報的完全吻合**（詳見下方第 2 節的真實 JSON 範例）。
- ❌ **無法**證明使用者的 Zeabur 正式站目前跑的是哪個版本、是否有 CDN／瀏覽器快取殘留
  舊版 JS、或是否存在本機環境重現不出來的其他因素。這正是本版新增 `build_version` 與
  `[Homepage Gate]` debug log 的目的——讓使用者在正式站的瀏覽器 Console 直接印出實際
  載入的版本與 Gate 判斷過程，而不必再靠雙方各自臆測。

## 1. Root Cause（本機重現、非臆測）

在本機以「未設定 Business Calendar、未特別調整全域截止時間」的**預設情境**下（也就是使用者
所說的「後台顯示外帶接單中、外送接單中」最典型的日常狀態），於真實時間 10:15（早於預設
營業時間 11:00）呼叫 `GET /api/line-orders/shop`，得到：

```json
{
  "takeout_status": {
    "enabled": true,
    "today_open": false,
    "today_state": "not_started",
    "today_reason": "before_start",
    "today_label": "尚未開始",
    "today_start_time": "11:00",
    "today_cutoff_time": "20:00"
  },
  "delivery_status": {
    "enabled": true,
    "today_open": false,
    "today_state": "not_started",
    "today_reason": "before_start",
    "today_label": "尚未開始",
    "today_start_time": "11:00",
    "today_cutoff_time": "21:00"
  }
}
```

`today_open` 兩者皆為 `false`（因為「還沒到開始時間」本來就不能立刻下單，這部分計算完全
正確）。但 Hotfix30-B1 遺留的兩處呼叫端，都只判斷「`enabled`/`today_open` 是否為
`false`」，沒有進一步分辨這個 `false` 究竟是「今天完全不會營業」（`holiday` /
`today_not_open`）還是「今天稍後才會開始營業」（`not_started`）：

1. **首頁 Gate**（`line-order.html` 初始化流程）：`if(!takeoutEnabled && !deliveryEnabled)
   { showClosed('今日暫停接單', ...) }`。
2. **`buildServiceStatusBar()`**（今日服務列本身）：`if(!toStatus.enabled &&
   !dlStatus.enabled){ ... '今日暫停接單（外帶／外送皆已關閉）' ... }`。

兩者都會在「還沒到營業時間」時，錯誤顯示「今日暫停接單」——這與使用者回報的「後台顯示
接單中、前台卻顯示今日暫停接單」症狀完全吻合。使用者回報的是 23:44 這個時間點，本機測試
用的是 10:15（早於開店），兩者本質是同一個 bug（`not_started` 被誤判成「無服務」），只是
時間點不同、剛好都落在「今天原本就有排班，只是現在還沒到那個時間點」的窗口內。

## 2. 首頁 Gate 資料來源確認（一次性稽核，無需再懷疑「是不是有兩套資料」）

首頁 Gate 讀取的資料，與 `GET /shop` 回傳、與 `getFulfillmentStatus()` 內部讀取的，
**是同一個 `shopData` 物件、同一次 API 呼叫結果**，並非三套獨立資料：

```
GET /api/line-orders/shop（一次請求）
  → shopData = 該次回應的 data
  → shopData.takeout_status / shopData.delivery_status（含 today_open/today_state/
     today_reason/today_label，全部來自後端 resolveFulfillmentState()）
  → getFulfillmentStatus('takeout'/'delivery') 直接讀 shopData.takeout_status/delivery_status
  → evaluateHomepageFulfillmentGate() 呼叫 getFulfillmentStatus() 取得判斷依據
  → buildServiceStatusBar() 也呼叫同一個 getFulfillmentStatus()
```

三個消費端（首頁 Gate／今日服務列／購物車按鈕）共用同一份、同一次請求的資料，因此不存在
「資料來源不一致」的可能性——問題出在**同一份正確資料，被兩個呼叫端用了錯誤的判斷邏輯**
（只看 `enabled` 布林值，沒看 `state` 語意），而不是資料本身有分歧。

## 3. 修正內容

### 3.1 `evaluateHomepageFulfillmentGate(shopRequestSucceeded)`（新增，`line-order.html`）

單一首頁 Gate 評估函式，回傳 `{shouldBlock, reason, blockType, takeout, delivery, storeId,
apiStoreId, buildVersion, shopRequestSucceeded}`。判斷矩陣（需求文件第四、五點）：

| 情境 | shouldBlock | blockType |
|---|---|---|
| API 失敗／缺 `takeout_status`/`delivery_status` | true | `api_error` |
| 任一模式 `state ∈ {open, not_started}` | false | `null`（正常進入） |
| 兩者皆 `cutoff` | false | `cutoff_both`（顯示「今日接單已截止」，不阻擋） |
| 兩者皆 `holiday` | true | `holiday`（顯示「今日未營業」） |
| 其餘（含兩者皆 `today_not_open`，或 cutoff/holiday/today_not_open 混合組合） | true | `today_not_open`（顯示「今日暫停接單」） |

只有 `window.__FULFILLMENT_DEBUG__===true` 時才輸出
`console.debug('[Homepage Gate]', {...})`，且明確排除姓名／電話／地址／LINE UID／Token
（只包含 `storeId`／`buildVersion`／原始與解析後的 takeout/delivery 狀態物件／判斷結果）。

### 3.2 `buildServiceStatusBar()` 同步修正（同一根因，一併修正）

原本的 `if(!toStatus.enabled && !dlStatus.enabled)` 短路判斷，改為先計算
`todayHasService = ['open','not_started'].includes(state)`，只有在「兩者都真的完全無法
提供今日服務」時才顯示「今日暫停接單」或「今日未營業」；兩者皆 `cutoff` 時顯示「⏰ 今日
接單已截止」；兩者皆 `not_started` 時在既有「今日服務　外帶（尚未開始）・外送（尚未開始）」
文字前方加上「⏰ 尚未開始接單」提示，不再誤用「暫停接單」字眼。

### 3.3 API 失敗不得偽裝成店休（需求文件第三點）

- 新增 `showSystemError(title, msg)`：與 `showClosed()` 外觀一致但語意不同，附「🔄 重新
  整理」按鈕（`onclick="location.reload()"`）。
- `GET /shop` 回傳 `success:false` 時（先前完全沒有處理、會靜默帶著空 `shopData` 繼續往下
  跑），現在會呼叫 `showSystemError()` 並中止，不再顯示任何「今日暫停接單」字樣。
- 外層 `catch(e)`（涵蓋網路失敗／JSON 解析失敗）也改用 `showSystemError()`（保留原本文字
  訊息當作備援，若 `showSystemError` 本身因故失敗才退回舊版純文字）。
- `evaluateHomepageFulfillmentGate()` 的第一個判斷分支就是 `shopRequestSucceeded` 與資料
  完整性檢查，永遠優先於「今天是否可服務」的判斷，確保系統性錯誤絕不會被那句「今日暫停
  接單」蓋過去。

### 3.4 `store_id` 一致性檢查（需求文件第六點）

- `GET /shop` 新增非敏感欄位 `store_id`（即 `requireStore` 中介層解析出的 `req.storeId`，
  優先序：Bearer JWT → `x-store-id` header → `query.store_id`，沿用既有中介層邏輯，未新增
  第二套解析）。
- 前端在 `shopData` 賦值後、其餘初始化流程之前，比對 `shopData.store_id`（API 實際解析出
  的）與 `LINE_STORE_ID`（頁面 URL 上 `?store_id=` 或預設值）。不一致時呼叫
  `showSystemError('店家資料載入異常', ...)`，不顯示「今日暫停接單」。

### 3.5 `build_version` 診斷欄位（需求文件第一點）

- `GET /shop` 新增 `build_version: 'fix18-10-hotfix30-B2'`。
- 前端寫入 `document.documentElement.dataset.buildVersion`（可在瀏覽器開發者工具的
  Elements 面板直接查看 `<html data-build-version="...">`，不在畫面上長期顯示文字）。
- `window.__FULFILLMENT_DEBUG__===true` 時額外印出 `console.debug('[Build Version]',
  buildVersion)`。

### 3.6 快取（需求文件第七點）

- 確認專案**沒有** Service Worker（`grep -rn "serviceWorker" public/`、搜尋
  `sw.js`/`service-worker.js` 皆無結果），依指示「若沒有 Service Worker，不要新增」，
  本版未新增。
- `GET /api/line-orders/shop` 的兩處呼叫（初始化 `init()`、每 60 秒一次的
  `refreshShopStatus()`）都加上 `cache:'no-store'`，避免瀏覽器快取營業狀態；**未**對
  商品圖片等靜態資源新增任何快取限制。

## 4. Behavior Regression — Case P–U（本機真實 HTTP 請求，13/13 PASS）

| Case | 情境 | 結果 |
|---|---|---|
| P | `takeout.today_open=true`／`delivery.today_open=true` | **PASS** — `shouldBlock=false` |
| Q | `takeout=not_started`／`delivery=not_started` | **PASS** — `shouldBlock=false`，`blockType=null`（不再誤判成 `today_not_open`） |
| R | `takeout=cutoff`／`delivery=cutoff` | **PASS** — `shouldBlock=false`，`blockType='cutoff_both'`（顯示「今日接單已截止」，不是「目前皆已關閉」） |
| S | `takeout=holiday`／`delivery=holiday` | **PASS** — `shouldBlock=true`，`blockType='holiday'` |
| T | `GET /shop` 失敗（實測打不存在路徑製造非預期回應） | **PASS** — 判定為 `api_error`，`shouldBlock=true`（走系統錯誤畫面，不是店休畫面） |
| U | 前台 URL `store_id` 與 API `store_id` 不一致（人工比對，模擬 `store_999_mismatch` vs 實際 `store_001`） | **PASS** — 偵測到不一致 |

**GET /shop 實際回傳範例**（本機真實請求，早於預設營業時間 11:00 時取得，即第 1 節引用的
那組資料）已完整列於第 1 節；`build_version`／`store_id` 兩欄位皆確認存在且值正確
（`"fix18-10-hotfix30-B2"` / `"store_001"`）。

**store_id 對照結果**：本機測試環境下 `x-store-id: store_001` header、`GET /shop` 回傳的
`store_id`、以及測試腳本模擬的「前台 URL store_id」三者一致時判定正常，人為製造不一致
時判定正確攔截（見 Case U）。**正式 Zeabur 環境的實際 store_id 是否一致，仍需使用者在
瀏覽器開啟 `__FULFILLMENT_DEBUG__` 後自行比對 Console 輸出，本機無法代為確認。**

**Service Worker**：確認專案內不存在。**快取風險**：`GET /shop` 兩處呼叫已加
`cache:'no-store'`；CDN／Zeabur 邊緣快取層級的行為超出程式碼範圍，無法從本機驗證，若
懷疑仍有快取問題，建議請使用者在該環境開發者工具的 Network 分頁確認該請求的
`cache-control`/`age` 回應標頭。

## 5. 語法與結構 Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

`div` 標籤平衡 186/186；重複 DOM id：0；無測試用 `console.log`；
`window.__FULFILLMENT_DEBUG__` 全檔案未被設為 `true`（僅在條件式中讀取），正式版預設關閉；
無測試日期硬編碼；無殘留測試資料／`node_modules`／`data/`／暫存 log。

## 6. 宅配未修改證明

以 **Hotfix30-B1**（`pos-web-fix18-10-hotfix30-B1-full.zip`）作為直接基礎版本逐檔
SHA-256 比對：

```
public/line-shipping.html
  Hotfix30-B1 : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  本版最終    : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f

routes/line-shipping.js
  Hotfix30-B1 : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  本版最終    : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
```

`diff -q` 兩檔案皆無輸出（無差異）。**宅配功能本版完全未修改。**

## 7. 已知限制

1. **無法直接驗證 Zeabur 正式站**：本輪所有測試皆在本機沙盒環境完成，包含真實啟動
   server、真實資料庫讀寫、真實 HTTP 請求。無法連線到使用者的 Zeabur 部署，因此無法
   100% 排除「正式站有本機重現不出來的環境差異（例如舊版建置產物、CDN 快取、環境變數
   差異）」的可能性。這是本版新增 `build_version`／`[Homepage Gate]` debug log 的原因：
   下一步應由使用者在正式站瀏覽器 Console 執行
   `window.__FULFILLMENT_DEBUG__=true` 後重新整理頁面，把印出的 `[Build Version]` 與
   `[Homepage Gate]` 內容回報，才能確認正式站實際載入的版本與判斷過程。
2. **CDN／邊緣快取層級無法從程式碼驗證**：`cache:'no-store'` 只能控制瀏覽器不快取這支
   API 回應，若 Zeabur 或其前方有額外的 CDN／反向代理快取層，需要在該平台的設定介面
   確認，非本次程式碼修改範圍。
3. **`today_not_open` 與 `holiday` 以外的混合組合統一顯示「今日暫停接單」**：例如
   一個模式 `cutoff`、另一個模式 `today_not_open`，本版依需求文件第五點的精神歸類為
   「今日暫停接單」而非另外設計專屬文案，未來如需更細緻的混合狀態文案，可在
   `evaluateHomepageFulfillmentGate()` 的 `else` 分支進一步拆分。
4. Case T 的「API 失敗」是以「打不存在的路徑製造非預期回應」模擬，並非真的模擬伺服器
   500 或逾時；`evaluateHomepageFulfillmentGate()` 的判斷條件（`!shopRequestSucceeded ||
   !shopData.takeout_status || !shopData.delivery_status`）已涵蓋這些情境，但實際
   timeout／500 情境未逐一在本機重現伺服器端故障來測試（該情境屬於網路層/伺服器層問題，
   不易在本機安全重現）。

## 8. 部署後驗證步驟（正式環境，需使用者親自於 Zeabur 部署後執行）

**本節列出的步驟尚未在正式站執行過，以下只是操作說明，不是已完成的驗證結果。**

1. 開啟正式站頁面，在瀏覽器開發者工具 Console 執行：
   ```js
   document.documentElement.dataset.buildVersion
   ```
   預期輸出：`"fix18-10-hotfix30-B2"`。若不是，代表 Zeabur／CDN／瀏覽器仍在載入舊版本。

2. 開啟診斷模式並重新整理：
   ```js
   window.__FULFILLMENT_DEBUG__ = true;
   location.reload();
   ```
   重新整理後應在 Console 看到 `[Build Version]` 與 `[Homepage Gate]` 兩組 log（不含
   任何姓名／電話／地址／LINE UID／Token）。

3. 直接查看 `GET /api/line-orders/shop` 的回應（開發者工具 Network 分頁，或
   `fetch('/api/line-orders/shop').then(r=>r.json()).then(console.log)`），應包含：
   ```json
   {
     "build_version": "fix18-10-hotfix30-B2",
     "store_id": "...",
     "takeout_status": { "today_state": "...", "today_reason": "...", "today_open": true },
     "delivery_status": { "today_state": "...", "today_reason": "...", "today_open": true }
   }
   ```
   （`today_open` 的實際值依當下真實時間與店家設定而定，不必然為 `true`；重點是欄位
   本身要存在。）

4. 確認前台 URL 上的 `store_id`（若有帶 `?store_id=` 參數）與上述回應的 `store_id`
   一致。

5. 確認開發者工具 Network 分頁中 `GET /api/line-orders/shop` 請求的回應標頭沒有被
   瀏覽器從快取讀取（可觀察是否為 `(from disk cache)`／`(from memory cache)`，若有，
   代表快取問題不在這支 API 本身，需往 CDN／代理層排查）。

6. 若以上皆正常但畫面仍顯示「今日暫停接單」，請把 `[Homepage Gate]` 印出的完整內容
   回報，內含 `shouldBlock`／`reason`／`takeoutResolved`／`deliveryResolved` 等欄位，
   可用來精確定位是資料問題還是快取問題還是本版未覆蓋到的情境。

**在使用者完成以上步驟並回報結果之前，本 CHANGELOG 不宣稱「Zeabur 正式站已驗證修復」，
只宣稱「本機環境已驗證此 root cause 的修正邏輯正確」。**

## 9. 回退方式

1. 還原 `public/line-order.html`、`routes/line-orders.js` 為 Hotfix30-B1 版本內對應檔案
   即可（本版只修改這兩個檔案）。
2. `GET /shop` 新增的 `build_version`／`store_id` 為純附加欄位，回退後不影響任何既有
   邏輯或資料結構。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
