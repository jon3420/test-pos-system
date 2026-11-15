# R54.4／MBV2-HF1-C5.1 最終報告：補貨一致性（R1～R6）與訂單唯一識別（R7）修正

- 交付 ZIP：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_1_RESTOCK_CONSISTENCY_ORDER_ID_FIX_APP_ROOT.zip`
- SHA-256：見專案文件 `claude/R54_4_MBV2_HF1_C5_1_FINAL_REPORT.md`（ZIP 內的報告無法包含自身雜湊；專案文件版本已補上）
- 955 個檔案／996 個 ZIP 項目（41 個資料夾項目）；根目錄直接包含 `server.js`、`package.json`；不含資料庫、憑證、權杖、node_modules、uploads、測試產物或顧客資料
- 唯一開發基準：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_RESTOCK_CONVERSION_TRACKING_APP_ROOT.zip`
- **本輪沒有部署、沒有操作正式資料、沒有開啟店家通知開關；真實 LINE Messaging API 呼叫 0 次、真實 LINE Pay 呼叫 0 次（全部在測試程序內攔截）。**

---

## 0. 基準核對

| 套件 | 實際 SHA-256 | 檔案／ZIP 項目 | 結果 |
|---|---|---|---|
| C5（唯一基準） | `cef817d04ae8d66a99a5c5dceaae5cf4df24e8c91e712fca06b09c20b65cc768` | 946／986，根目錄直接有 `server.js`、`package.json` | 與指定值相符 |
| C4.5（比較用） | `3ad621512894325aaadc33b5cf9f0b0feaa688b46006575d81c6cd256080335c` | 940／979 | 與指定值相符 |

- 建立兩棵樹：**未修改的 C5 基準樹**（只加入本輪的重現測試與其測試替身，產品程式一行未改）與 **C5.1 工作樹**。C4.5 另解壓一棵，供回退測試使用。
- C4.5→C5 差異核對：修改 12、新增 6，與 C5 報告一致。
- 先閱讀 C5 報告（專案 `claude/R54_4_MBV2_HF1_C5_FINAL_REPORT.md`）與相關程式後再修改。

## 1. 測試層級

本輪的重現與驗收都走正式程式，分三層標示在每個案例名稱前：

| 標示 | 內容 |
|---|---|
| `[API]` | 以 `node server.js` 啟動暫存伺服器（暫存 SQLite），呼叫正式路由 |
| `[BR]` | 真實 Chrome（Playwright）開啟正式頁面 `line-order.html`／後台 `index.html`；LIFF SDK 以替身回應 |
| `[DB]` | 直接核對暫存資料庫檔 |

- 回應亂序：先讓伺服器完成操作（Playwright `route.fetch()`），再扣住回應，完成後續操作（換會員、切店、登出、離開頁面）才放行。延後讀完 JSON 以頁面內包裝 `fetch` 製造（測試邊界）。
- 故障注入只在測試邊界：暫存資料庫的 SQLite trigger（第二商品寫入失敗）、durable 寫入故障 preload（`scripts/lib/c51-durable-fault.js`）。正式程式沒有測試專用繞過。
- 同秒訂單：固定時鐘 preload（`scripts/lib/c51-frozen-clock.js`，所有請求落在同一毫秒），不靠等待避開。
- 7 日歸因：以測試時鐘重新啟動伺服器控制伺服器時間（邊界內外各 2 分鐘）。
- LINE Pay：有狀態替身（`scripts/lib/c51-linepay-mock.js`）：每次 Request 回傳唯一的 19 位數交易識別（JSON 數字，超出 JS 安全整數），Confirm 核對交易、金額與是否已確認。
- **以上都不是真機、正式金流或正式站驗證**（見第 9 節）。

## 2. 七項問題：根因、修正與重現前後

同一支腳本 `scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js` 先在未修改的 C5 執行，再在 C5.1 執行（案例名稱與步驟相同）。

| 案例 | 層級與內容 | C5（未修改） | C5.1 |
|---|---|---|---|
| R1-1 | [BR] A 裝置載入「1 份、外帶」→ B 裝置改「5 份、外送」→ A 按「訂閱補貨通知」：資料庫維持 5 份外送、只新增同意；畫面顯示 5 份外送 | ❌ {"db":[1,"takeout"],"ui":{"qty":1,"pref":"takeout","consent":"granted"},"list":"測試招牌飯1 份・外帶自取管理","errs":[]} | ✅ |
| R1-8 | [BR] 訂閱回應途中換會員：舊會員回應不寫入新會員畫面、不提示成功；伺服器只新增舊會員同意、登記不變 | ✅ 通過 | ✅ |
| R1-9 | [BR] 回應途中關閉再開其他商品表單：不關閉、不改寫新表單；登記內容不變 | ✅ 通過 | ✅ |
| R1-2 | [API] 登記已取消：新版與舊版訂閱都被拒絕，不復活登記、不新增同意 | ❌ {"st":404,"code":null,"leg":200,"act":1} | ✅ |
| R1-3 | [API] 取消後重建（新週期）：舊表單的訂閱不能授權新週期、不改新週期內容 | ❌ {"st":404,"g":0} | ✅ |
| R1-4 | [API] 登記已過期：訂閱被拒絕，不延長有效期限、不新增同意 | ❌ {"st":404,"exp":false} | ✅ |
| R1-5 | [API] 撤回後重新訂閱成功；重複提交不產生重複同意；份數、偏好、期限不變 | ❌ {"out":[null,null],"rows":1} | ✅ |
| R1-6 | [API] 舊版前端 consent_action=subscribe：表單快取與伺服器不一致 → 409 不寫入；一致 → 只授權、不改份數 | ❌ {"stale":200,"db":[1,"takeout"],"ok":"unchanged"} | ✅ |
| R1-7 | [API] 保留訂閱方式與文案版本檢查；他人不能以 request_id 訂閱別人的登記 | ❌ {"st":404,"code":null,"other":404} | ✅ |
| R2-1 | [API] 有效會員 A 加購：歸因 A | ✅ 通過 | ✅ |
| R2-2 | [API] 沒有有效會員（匿名）：只保留匿名事件，不沿用點擊者 A | ❌ {"line_user_id":"Uc450000000000000000000000000051","recipient":1} | ✅ |
| R2-3 | [API] 過期／偽造 session：視為匿名，不沿用點擊者 | ❌ {"r3":{"line_user_id":"Uc450000000000000000000000000051","recipient":1},"r4":{"line_user_id":"Uc45000000000000 | ✅ |
| R2-4 | [API] 本次會員 B 與點擊綁定的 A 不同：以 B 記錄但不計入漏斗、不改綁點擊、不合併 | ❌ {"r":{"line_user_id":"Uc450000000000000000000000000052","recipient":1},"click":{"line_user_id":"Uc450000000000 | ✅ |
| R2-5 | [BR] A 開啟後切換為 B、再登出：加購照常（購物車 2 件）但不帶 A 的追蹤；A 的歷史點擊保留 | ❌ {"clicks":1,"addsB":[{"line_user_id":"Uc450000000000000000000000000054"}],"addsAll":[{"line_user_id":"Uc450000 | ✅ |
| R2-6 | [BR] 舊 A 的補認回應晚於切換為 B：不把 A 標記為目前會員；B 的加購不沿用 A 的開啟 | ❌ {"st":{"owner":false,"member":true},"addsB":1,"k":true,"clickRow":{"line_user_id":"Uc4500000000000000000000000 | ✅ |
| R2-7 | [BR] 追蹤與事件請求失敗：一般加購照常 | ✅ 通過 | ✅ |
| R3-1 | [BR] 首次開啟（LIFF 一次→二次必要導向）：只形成 1 次有效開啟 | ✅ 通過 | ✅ |
| R3-2 | [BR] 重新整理兩次：點擊不增加 | ✅ 通過 | ✅ |
| R3-3 | [BR] 同一分頁短時間再次點擊通知連結：建立新的開啟識別、另計一次點擊、商品照常開啟 | ❌ {"n":1,"opened":false} | ✅ |
| R3-4 | [BR] 首次點擊 8 日後在同一分頁再次點擊：新點擊使用伺服器目前時間，舊點擊保留；之後下單歸因到新點擊 | ❌ {"n":1,"at":[],"first":"2026-11-14 02:30:38"} | ✅ |
| R3-5 | [API] 新點擊後的 7×24 小時邊界：差 2 分鐘內歸因、超過 2 分鐘不歸因（伺服器時間） | ✅ 通過 | ✅ |
| R3-6 | [BR] 不同批次的相同商品（同日期、同方式）：第二批次照常開啟並記錄點擊 | ❌ {"c2":0,"opened":false} | ✅ |
| R3-7 | [BR] 匿名開啟後才完成會員辨識：補認同一次開啟，不新增點擊 | ✅ 通過 | ✅ |
| R4-1 | [API] 同張訂單兩個通知商品、第二商品寫入失敗：訂單照常成立，歸因整筆不寫（不留半套） | ❌ {"attrs":[704]} | ✅ |
| R4-2 | [API] 故障排除後補登：兩個商品都補齊，且分屬不同批次 | ❌ {"r":{"scanned":4,"attributed":0},"a":[[704,"0bba3a8b"]]} | ✅ |
| R4-3 | [API] 修補 C5 既有半套資料：補上缺少商品，保留既有正確快照（attr_uuid 不變） | ❌ {"r":{"scanned":4,"attributed":0},"kept":true} | ✅ |
| R4-4 | [API] 重跑兩次與併發補登：不重複計算；回報掃描、補齊、略過、失敗數量 | ❌ {"r1":{"scanned":4,"attributed":0},"n0":3,"n1":3} | ✅ |
| R4-5 | [API] 沒有有效點擊的訂單：補登不產生歸因 | ✅ 通過 | ✅ |
| R4-6 | [API] 歸因交易保存失敗：訂單不受影響、歸因全部不寫；補登以訂單建立時間補齊 | ❌ {"a0":2,"a1":2} | ✅ |
| R4-7 | [API] 10 日後補登：以訂單建立時間計算 7 日視窗（不用補登時間） | ✅ 通過 | ✅ |
| R5-1 | [API] 201 個批次：總計包含排在最後的最舊批次（受理、點擊、成交、金額完整），跨商品同一訂單只算一張 | ❌ {"got":[200,201,101,51,4550],"exp":[201,204,103,51,4640]} | ✅ |
| R5-2 | [API] 分頁（50／200 每頁）切換：總計不變；所有批次都能在明細中取得；回傳總筆數與頁數 | ❌ {"same":true,"ids":200} | ✅ |
| R5-3 | [API] 商品篩選選項包含較早批次的商品；篩選後總計與明細使用同一條件；無資料比率為「—」 | ❌ {"opt":0,"fOld":1} | ✅ |
| R5-4 | [API] 舊批次「未建立追蹤」語意與比率分母口徑維持 | ❌ {"u":1,"row":"untracked"} | ✅ |
| R6-1 | [BR] 延後成功：A 店回應在切換至 B 店後才到達 → 不寫入資料、不顯示 A 店數字 | ❌ {"k0":"212","k1":"212","st":{"owner":null,"hasData":true,"w":{"data":true,"err":false}}} | ✅ |
| R6-2 | [BR] 延後錯誤：切店後才到達的 A 店錯誤不寫入（不顯示、不保留 A 店結果） | ❌ {"err":"模擬錯誤","owner":null,"has":true} | ✅ |
| R6-3 | [BR] 延後 JSON 解析：讀完回應內容時已切店 → 丟棄 | ❌ {"owner":null,"has":true,"w":{"data":true,"err":false}} | ✅ |
| R6-4 | [BR] 換登入身分：前一個身分的回應不寫入目前身分的快取 | ❌ {"w":{"data":true,"err":false}} | ✅ |
| R6-5 | [BR] 登出：清除報表快取，延後回應不寫入 | ❌ {"has":true} | ✅ |
| R6-6 | [BR] 權限失效（403）：清除報表資料，不再顯示數字 | ❌ {"before":true,"st":{"has":true,"acc":"212"}} | ✅ |
| R6-7 | [BR] 離開頁面期間的回應不寫入；重新進入重新查詢並顯示目前店別數字 | ❌ {"mid":{"w":{"data":true,"err":false}},"k":"212"} | ✅ |
| R6-8 | [BR] 原店快取遇到新店查詢失敗：不以「上次結果」顯示前一店資料 | ❌ {"acc":"212","body":"更新失敗，顯示上次結果：模擬錯誤\n      LINE 已受理（有追蹤批次）212\n      已核對點擊（人／次）109／109\n      對應商品加購人數"} | ✅ |
| R6-9 | [BR] 診斷紀錄不含 JWT／會員 session；後台無 JavaScript 錯誤 | ❌ {"leak":["[WSS] Web POS 已連線: ws://127.0.0.1:46355/orders?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIj | ✅ |
| R7-A | [API] 固定時鐘（同一毫秒）連續 20 張＋並行 20 張 LINE 訂單、並行 5 張店內 POS 訂單：顯示編號全部不同、同一秒、新編號受唯一索引保護 | ❌ {"ok":true,"n":40,"distinct":1,"sample":["LINE-20261114-103146","LINE-20261114-103146","LINE-20261114-103146"] | ✅ |
| R7-A2 | [DB] 新編號的持久化唯一索引拒絕重複；宅配（SHIP-）共用同一產生器，同一秒 30 組不重複 | ❌ {"blocked":false,"ship":[]} | ✅ |
| R7-B1 | [API] 歷史同號兩張訂單、升級前付款（伺服器已保存交易識別）：B 的 callback 只確認 B，不串到 A | ❌ {"A":"paid","B":"pending","loc":"/line-order.html?store_id=store_001&linepay=success&order=LINE-20261101-12000 | ✅ |
| R7-B2 | [API] 歷史同號且沒有可靠交易對應：拒絕自動判定（不呼叫 LINE Pay、兩張都不變）並提示需核對 | ❌ {"A":"paid","B":"pending","loc":"/line-order.html?store_id=store_001&linepay=success&order=LINE-20261101-12000 | ✅ |
| R7-B3 | [API] 新付款請求：金額與付款對象由伺服器依訂單 uuid 建立（不信任前端 order_number／total）；callback 以付款嘗試唯一定位 B（不同金額、會員、店別的同號單不受影響）；19 位交易識別完整保存 | ❌ {"amt":[1,240],"A":"pending","B":"pending","s2":"pending","att":[],"loc":"/line-order.html?store_id=store_001& | ✅ |
| R7-B4 | [API] 重複 callback（含同時兩個）：不再呼叫確認、不重複扣份數、purchase、會員消費 | ❌ {"q":["0/5,0/11","0/5,0/11"],"calls":3} | ✅ |
| R7-B5 | [API] 交易識別或 orderId 與付款嘗試不符：拒絕，不呼叫確認、不改訂單 | ❌ {"loc":"/line-order.html?store_id=store_001&linepay=fail&order=LINE-20261101-120000B3&code=1150","calls":1} | ✅ |
| R7-B6 | [API] 付款失敗／取消返回維持原行為；再次付款建立新的付款嘗試（不同 orderId）後成功 | ❌ {"loc":"/line-order.html?store_id=store_001&linepay=fail&order=LINE-20261101-120000B3&co","ids":["LINE-2026110 | ✅ |
| R7-B7 | [API] 付款返回頁以訂單唯一識別取單（顯示 B 的金額）；只用重號編號查詢回 409，不回傳另一張 | ❌ {"total":150,"byNo":200} | ✅ |
| R7-B8 | [API] 升級前已建立的付款請求（唯一編號＋已保存交易識別）：相容路徑照常完成 | ✅ 通過 | ✅ |
| R7-C1 | [DB] 來源資料：同號不同 uuid 兩張訂單與子資料 | ✅ 通過 | ✅ |
| R7-C2 | [API] 完整搬家到新環境：同號不同 uuid 的兩張都存在，優惠券使用、操作紀錄、會員關聯、Analytics、補貨歸因各自跟隨正確訂單；重複匯入維持冪等 | ❌ {"st":"done","c1":[null,{"id":"378226a7-e089-40c1-a0f1-cd1eea8efd90","total":110,"member":"Uc45000000000000000 | ✅ |
| R7-C3 | [API] 選擇性搬家（訂單、會員紀錄、Analytics、折扣）：兩張都存在且子資料關聯正確 | ❌ {"st":"done","c3":[null,{"id":"378226a7-e089-40c1-a0f1-cd1eea8efd90","total":110,"member":"Uc45000000000000000 | ✅ |
| R7-C4 | [API] 同一資料庫跨店匯入（ID 改變）：兩張都存在、子資料跟隨新識別、原店不受影響；重複匯入冪等 | ❌ {"st":"done","s2n":1,"c1":[null,{"id":"afd52f3a-4e26-4ae9-809c-2453c5b7ba46","total":110,"member":"Uc450000000 | ✅ |
| R7-C5 | [API] 跨店匯入訂單的來源付款交易：callback 不自動啟用（不呼叫確認、不改狀態） | ❌ {"st":"paid","loc":"/line-order.html?store_id=store_002&linepay=success&order=LINE-20261102-090000"} | ✅ |
| R7-C6 | [API] 舊備份缺少訂單識別、同號多張：列為衝突（2 筆），不推定、不合併 | ❌ {"st":{"added":65,"conflict":0,"dup":7},"n":1} | ✅ |
| R7-D1 | [API] 有歷史重號時啟動遷移不失敗；不刪除、不合併、不重新編號；診斷 API 列出重號群組 | ❌ {"groups":7,"diag":null,"idx":null} | ✅ |
| Z | 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次（全部在測試程序內攔截） | ✅ 通過 | ✅ |
| **合計** | | **13 通過／48 失敗** | **61 通過／0 失敗** |

說明：「C5 也通過」的案例是邊界或既有保護（例如 R1-8／R1-9 的 C4.4 操作生命週期、R3-1／R3-2 的導向與重新整理、R3-5 的 7 日邊界），列入是為了確認修正後仍保持。C5 在 R1-2～R1-5、R1-7、R5-3 等案例的失敗，部分原因是 C5 沒有對應的新介面（例如 `/api/product-demand/subscribe` 回 404、報表沒有 `product_options`），不是每一項都是原始缺陷的直接重現；直接重現原始缺陷的案例是 R1-1、R1-6、R2-2～R2-6、R3-3、R3-4、R3-6、R4-1～R4-4、R5-1、R5-2、R6-1～R6-8、R7-A、R7-B1～B4、R7-B7、R7-C2～C6。

### R1 只訂閱通知不能覆蓋登記內容

- **根因**：`_submitDemand({subscribe:true})` 把畫面快取的份數與偏好送到 `/register`；後端把它當一般登記更新。
- **修正**：
  - 新增 `POST /api/product-demand/subscribe { product_id, request_id, consent_mode, consent_text_version }`（`utils/productDemand.js` `subscribe()`）：在**同一個交易**中核對店別、後端驗證的會員、商品與指定的登記週期（`request_id`）仍為 active 且未過期；只新增本週期的同意紀錄，不更新份數、偏好、有效期限或週期。已取消、過期、已換新週期 → `409 REQUEST_CHANGED`，不寫入任何資料。保留訂閱方式與文案版本檢查；本週期已有效同意時重送＝不變（不新增紀錄）。
  - 舊版前端仍走 `/register` 並帶 `consent_action='subscribe'`：後端改走同一個同意操作；因為舊前端不帶登記週期，只在「目前有效登記的份數與偏好與表單送出值相同」時才授權，否則 409，**一律不改登記內容**。
  - 前端改用新端點，只送商品與 `request_id`；成功後重新取得本人登記（顯示伺服器上的「5 份、外送」）；409 時重新讀取並提示。沿用 C4.4 的操作生命週期（換會員、關閉再開其他商品表單時舊回應不寫入）。
- **限制**：舊版前端（部署前已開啟的舊頁面）沒有週期識別；若另一裝置「取消後以完全相同的份數與偏好重建」，舊頁面按訂閱會授權新週期（仍是同一會員、同一商品、明確按下訂閱）。新版前端沒有此限制。

### R2 加購歸因不能沿用前位會員

- **根因**：`recordCartAdd` 使用 `uid || click.line_user_id`；前端追蹤狀態不隨會員切換隔離。
- **修正**：
  - 後端只以**本次**後端驗證成功的會員為準：沒有有效會員（未登入、過期、偽造）→ 匿名事件；本次會員與該次開啟綁定的會員不同 → 以本次會員記錄但 `recipient=0`（不計入漏斗），不改綁、不合併。歷史事件保留。
  - 前端追蹤狀態增加擁有者（開啟時的會員，或背景辨識送出時即歸屬該會員）；登出或換會員 → 隔離（不再附帶到加購）；舊的補認回應在取得回應與讀完內容時都核對目前會員與同一次開啟。sessionStorage 鍵含店別。
  - 追蹤失敗不影響一般加購（R2-7）。

### R3 真正再次點擊須更新最後有效點擊

- **根因**：`open_key` 以「同一分頁＋同一 rt」永久保存在 sessionStorage；商品自動開啟以「商品＋日期＋方式」2 分鐘去重，不同批次互相擋住。
- **修正**（`public/line-order.html`）：以瀏覽器導覽類型區分——`reload`／`back_forward`／LINE 登入返回（`line_gate_return`、LIFF 登入回呼）＝同一次開啟（沿用識別、不重複開商品、不新增點擊）；`navigate`（使用者再次點選通知連結、LIFF 一次→二次導向後的最終頁）＝新的一次開啟（新識別，伺服器時間另計一次點擊）。LIFF 一次導向頁不記錄點擊，必要導向只形成一次開啟。自動開啟去重範圍加入 rt，只在「同一次開啟」時生效。會員辨識稍後完成只補認同一次開啟。舊點擊時間不修改。
- 後端 `recordOpen` 不需修改（新識別即新點擊，伺服器時間）。

### R4 歸因部分失敗後必須能補完整

- **根因**：`attributeOrder` 逐商品寫入、沒有交易；`reconcileOrders` 以「整張訂單已有任一歸因」跳過。
- **修正**（`utils/restockTracking.js`）：先唯讀計算這張訂單**缺少哪些商品**的歸因，再以獨立的 durable 交易一次寫入（全部成功或全部不寫）；與訂單／付款交易分開，失敗不回滾訂單。補登以「店別＋訂單 uuid＋商品」判斷缺少項目，既有正確快照原樣保留（`INSERT OR IGNORE` 加唯一索引），以訂單實際保存的建立時間計算視窗。補登回報 `scanned／attributed／completed_orders／skipped／failed`。沒有缺少項目時不開交易（不增加一般下單成本）。

### R5 報表總計不能只統計最新 200 批次

- **根因**：`summary` 以 `LIMIT 200` 取批次後在記憶體加總。
- **修正**：總計改為資料庫聚合（完整篩選範圍，批次層級子查詢加總；跨批次訂單去重另以 `COUNT(DISTINCT)`）；明細分頁 `page`／`page_size`（預設 50、上限 200），回傳 `page { page, page_size, total_batches, total_pages, has_more }`。篩選條件總計與明細共用；未建立追蹤的舊批次與比率分母口徑不變。新增 `product_options`（本店所有已確認批次的商品）。新增報表用索引（只加索引）。前端加上分頁與每頁筆數，換頁不影響總計。

### R6 報表的店別、登入與頁面生命週期保護

- **根因**：`av2RsLoad` 只比對查詢序號。
- **修正**（`public/js/analytics-v2.js`、`public/js/app.js`）：每次查詢記錄「店別＋登入 JWT（只在記憶體比較）」與生命週期；取得回應、讀完回應內容、錯誤處理時都核對，身分改變即丟棄並清除前一身分的快取與畫面。離開分頁或頁面、登出（`clearToken`／`posLogout`）時中止並使舊請求失效。「失敗保留上次結果」只限同一身分。401／403 清除資料。保留「較早查詢不覆蓋新篩選」。另把既有 WebSocket 連線紀錄中的 JWT 遮蔽（`[WSS] Web POS 已連線` 原本會把 `token=` 寫入 console）。

### R7 訂單唯一識別、LINE Pay 與搬家對應

**根因**：`orderNumber()` 只有秒級時間；LINE Pay confirm 以 `(order_number=? OR uuid=?)` 取第一筆；付款請求的 `orderId` 由前端傳入的 `order_number` 決定；搬家以 `order_number` 判定同一訂單；另外 LINE Pay 交易識別（19 位整數）經 `JSON.parse` 會失去精度。

**A. 新訂單**（`utils/orderIdentity.js`）
- 穩定識別：`orders.id`（PRIMARY KEY；LINE 點餐／宅配 `id＝uuid`，店內 POS 為 uuidv4）——已有持久化唯一約束。所有新程式以它定位訂單。
- 新顯示編號：既有秒級格式加 4 碼尾碼（不含 0/O/1/I/L），例如 `LINE-20261114-103003-2XJ4`；在寫入訂單的同一個同步區段查重，並以部分唯一索引 `idx_orders_store_ordno_v2 (store_id, order_number) WHERE order_no_v=2` 持久化保護（重號會讓整筆交易回滾）。新格式一定帶尾碼、舊格式沒有，新編號不會與任何歷史編號相同。
- 共用產生器：LINE 點餐（`LINE-`）、宅配（`SHIP-`）、店內 POS（無前綴）。快閃訂單原本就帶訂單 id 片段，未改；Android 同步（`SYNC-`、由裝置提供）未改。
- 依參照取單改為 `id → uuid → 訂單編號（恰好一筆才採用）`，重號不猜：LINE 訂單狀態變更（409）、店內 POS 訂單 API、列印、線上訂單、宅配狀態、顧客查詢（`/api/line-orders/query` 同號 409，付款返回改用 `order_ref`）。
- 既有下單重送與冪等（cart_token、優惠券唯一索引）不變。

**B. LINE Pay**（`routes/linepay.js`、`utils/linePayService.js`）
- 官方規格核對（2026-11-14 查閱 developers-pay.line.me）：confirmUrl 回呼時 LINE Pay 會附加 `orderId` 與 `transactionId`（已在網址中的參數保留）；`transactionId` 為 19 位整數，應以 64-bit long 或字串處理；`orderId` 為字串、上限 100 字元；結果代碼 1172＝相同 orderId 已有交易、1150＝查無交易、1198＝重複請求。
- 付款請求：只以 `order_uuid` 在店別內取單；金額、品項、`orderId`、confirmUrl 全部由伺服器依資料庫訂單建立（不再採用前端的 `order_number`／`total`／`items`／`redirect_url`；cancel_url 只接受同網域）。已付款或已取消的訂單拒絕。
- 新資料表 `linepay_payment_attempts`：每次請求一筆（店別、訂單 uuid、送出的 orderId、transactionId〔字串〕、金額、狀態）。confirmUrl 帶 `attempt=<付款嘗試識別>`。送出的 orderId：第一次＝訂單編號（便於對帳）；歷史重號的訂單加 uuid 前 8 碼；同一訂單再次請求加 `-P<n>`（避免 1172）。
- Callback：以付款嘗試唯一定位訂單並核對 transactionId 與 orderId；不再使用 OR 查詢。升級前已建立的付款請求（沒有 attempt）：優先用伺服器保存的 `linepay_transaction_id`（店內唯一才採用）；沒有可靠交易對應時，只在 orderId 恰好對應一張訂單且保存的交易識別相符或空白時採用；**重號且沒有可靠交易對應 → 拒絕自動判定**（不呼叫 Confirm、不改訂單，導回 `linepay=error&msg=order_ambiguous`，頁面提示聯絡店家核對）。
- 冪等：已付款訂單的重複 callback 不再呼叫 Confirm、不重複扣份數／purchase／會員消費／補貨歸因；同時兩個 callback 共用同一次處理；「未付款→已付款」以條件式更新作為唯一閘門，份數扣除與付款嘗試狀態在同一個 durable 交易。付款請求後訂單金額被改動 → 不以舊金額完成付款。
- 失敗、取消、返回維持原行為；成功導回多帶 `order_ref`（訂單 uuid），付款返回頁以它精確取單。
- Recovery 付款（`/api/cart-recovery` 既有訂單付款）同樣建立付款嘗試；快閃付款維持自己的付款嘗試與 callback（只改為以字串保存交易識別）。

**C. 快速搬家**（`utils/migrationV2.js` `stepOrders`）
- 訂單業務鍵由 `order_number` 改為穩定識別（uuid；店內 POS 為 id）。同號不同 uuid 的兩張各自匯入；同一份資料重複匯入維持冪等（以 uuid／id／`import_origin_uuid` 對應）。
- 目標資料庫已有相同 id（同一資料庫跨店匯入）→ 換新 id；LINE 訂單同步換 uuid（維持 id＝uuid），原識別保存在 `import_origin_uuid`；操作紀錄、優惠券使用、會員訂單關聯、Analytics、補貨歸因、快閃分配都以既有的訂單對應表跟隨新識別。
- 舊備份缺少 uuid 與 id：只有「目標店沒有同編號」或「恰好一張同編號且建立時間、金額相同」才對應；同編號多張或內容不同 → **列為衝突**，不推定。子資料只以訂單編號指向、且該編號在備份檔有多張 → 列為衝突。
- 匯入的訂單標記 `imported_at`／`import_origin_store`：跨店匯入的付款交易屬歷史資料，callback 不會自動啟用；同店搬移（例如換主機）且交易識別完全相符時才可續用。`linepay_payment_attempts` 不隨搬家匯出。
- 新編號（`order_no_v=2`）與目標店另一張訂單相同時：兩張都保留，匯入那張取消新格式標記（列入診斷）。

**D. 歷史資料**
- 不刪除、不合併、不重新編號；不改既有 uuid、付款狀態、交易識別或訂單內容。
- 新唯一約束只作用於新編號（`order_no_v=2`），歷史重號不會讓啟動遷移失敗；遷移可重複執行（只 `ALTER ADD COLUMN`／`CREATE ... IF NOT EXISTS`）。
- 啟動時稽核並在 log 提示重號組數；`GET /api/order-identity/diagnostics`（員工 JWT，店別只信任 JWT）列出每組重號的訂單（id、uuid、付款方式與狀態、金額、是否有保存交易識別、是否為匯入），`needs_review` 標出「未完成的 LINE Pay 舊付款且沒有保存交易識別」的組別。

## 3. 相對 C5 的變更清單

**新增（7）**
- `utils/orderIdentity.js`：新編號產生器、依參照取單（不猜）、LINE Pay 付款嘗試與 callback 定位、19 位交易識別擷取、歷史重號診斷、安全遷移。
- 測試：`scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js`（R1～R7 重現／驗收）、`scripts/smoke-r54-4-mbv2-hf1-c5-1-rollback.js`（回退相容）。
- 測試替身（只在測試程序以 `node -r` 載入，正式部署不載入）：`scripts/lib/c51-linepay-mock.js`、`scripts/lib/c51-frozen-clock.js`、`scripts/lib/c51-durable-fault.js`。
- 文件：`docs/R54_4_MBV2_HF1_C5_1/`（00_FINAL_REPORT.md、01_TEST_RESULTS.json、02_FILE_MANIFEST.json）。

**修改（20：程式 19、既有測試 1）**
| 檔案 | 內容 |
|---|---|
| `utils/productDemand.js` | R1：`subscribe()` 獨立同意操作；`register()` 的 `consent_action='subscribe'` 改走它 |
| `routes/product-demand.js` | R1：`POST /subscribe` |
| `public/line-order.html` | R1 前端改用 `/subscribe`、成功後重讀；R2 追蹤狀態擁有者與隔離；R3 導覽類型判斷、去重含 rt；R7 付款返回用 `order_ref`、核對提示 |
| `utils/restockTracking.js` | R2 加購只認本次會員；R4 交易式歸因與逐商品補登；R5 資料庫聚合＋分頁＋商品選項＋索引 |
| `public/js/analytics-v2.js` | R5 分頁 UI、商品選項；R6 店別／登入／生命週期保護 |
| `public/js/app.js` | R6：離開頁面、登出、清除 token 時使報表請求失效；WebSocket 紀錄遮蔽 JWT |
| `public/index.html` | 前端資源版本 `r54-4-mbv2-hf1-c5-1` |
| `routes/linepay.js` | R7-B：伺服器建立付款請求、付款嘗試、callback 定位與冪等閘門 |
| `utils/linePayService.js` | R7-B：Recovery 付款建立付款嘗試；交易識別以字串保存 |
| `routes/cart-recovery.js` | R7-B：Recovery 付款啟用付款嘗試 |
| `routes/line-orders.js` | R7-A：新編號＋`order_no_v`；狀態變更取單不猜；`/query` 支援 `order_ref`、重號 409 |
| `routes/line-shipping.js` | R7-A：共用產生器；宅配狀態取單不猜；`/order/:no?ref=` |
| `routes/orders.js` | R7-A：店內 POS 共用產生器；依參照取單不猜 |
| `routes/print.js`、`routes/online-orders.js` | R7-A：依參照取單不猜 |
| `public/line-shipping.html` | R7-B：付款返回以 `order_ref` 取單 |
| `utils/migrationV2.js` | R7-C：訂單以 uuid／id 判定、跨店 id 改變時子資料跟隨、缺識別列衝突、匯入付款標記 |
| `utils/db.js` | 啟動時執行 `orderIdentity.migrate`（失敗只記錄） |
| `server.js` | `GET /api/order-identity/diagnostics`；`/callback/linepay` 完整轉送參數 |
| 測試 `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | L3-4 必要調整（見第 6 節） |

**刪除**：0。


## 4. API、設定、資料庫、付款與搬家格式變更

- **API（新增）**：`POST /api/product-demand/subscribe`；`GET /api/order-identity/diagnostics`。
- **API（變更）**：
  - `POST /api/product-demand/register` 帶 `consent_action='subscribe'` 時只做同意操作（可能回 `409 REQUEST_CHANGED`）。
  - `GET /api/analytics/restock-notify/summary` 新增參數 `page`、`page_size`；回應新增 `page`、`product_options`；`totals` 改為完整篩選範圍（不再只有最新 200 批次）。
  - `POST /api/analytics/restock-notify/reconcile` 回應新增 `completed_orders`、`skipped`、`failed`、`days`；`scanned` 改為期間內所有有會員的 LINE 訂單。
  - `POST /api/linepay/request`：只採用 `order_uuid`（其餘前端欄位忽略）；已付款 409 `ALREADY_PAID`、已取消 409 `ORDER_NOT_PAYABLE`。
  - `GET /api/linepay/confirm`：新增 `attempt` 參數；錯誤導回新增 `msg=order_ambiguous｜payment_mismatch｜already_paid｜amount_changed`；成功導回新增 `order_ref`。`/callback/linepay` 別名完整轉送查詢參數。
  - `POST /api/line-orders/query` 新增 `order_ref`；只用重號編號查詢回 409。`GET /api/line-shipping/order/:orderNo` 新增 `?ref=`；重號回 409。
  - `PATCH /api/line-orders/online/:id/status` 以訂單編號指向多張時回 409 `ORDER_REF_AMBIGUOUS`；店內 POS、列印、線上訂單、宅配狀態 API 以重號編號指向時視為找不到（請改用 id）。
- **設定**：無新增。
- **資料庫（安全遷移，可重複執行，不刪資料、不重建表）**：
  - `orders` 新增 `order_no_v INTEGER`、`import_origin_uuid TEXT`、`imported_at TEXT`、`import_origin_store TEXT`；索引 `idx_orders_store_ordno_v2`（唯一，部分）、`idx_orders_store_ordno`、`idx_orders_store_uuid`、`idx_orders_store_lptx`。
  - 新資料表 `linepay_payment_attempts`（唯一：`attempt_uuid`、`(store_id, lp_order_id)`）。
  - 報表索引：`idx_rnb_store_confirmed`、`idx_rnd_store_batch_status_user`、`idx_rnc_store_batch_user`、`idx_rna_store_batch_user`。
- **付款**：見 R7-B。LINE Pay 送出的 orderId 第一次仍為訂單編號；再次請求加 `-P<n>`。
- **搬家（MBV2）格式**：備份檔格式不變（`orders` 會多帶上述新欄位）；匯入規則改為以 uuid／id 判定同一訂單（見 R7-C）。
- **前端資源版本**：`app.js?v=r54-4-mbv2-hf1-c5-1`、`analytics-v2.js?v=r54-4-mbv2-hf1-c5-1`（`line-order.html`、`line-shipping.html` 為頁面本身）。

## 5. 歷史重號資料的處理原則與診斷

1. 不刪除、不合併、不重新編號，不改任何既有訂單的 uuid、付款狀態、交易識別或內容。
2. 所有新程式只以穩定識別定位訂單；以「訂單編號」指向的舊介面在重號時不猜（409 或找不到）。
3. LINE Pay：升級前已建立、尚未完成的付款——有保存交易識別者可唯一對應並完成；沒有者 callback 被拒絕並提示核對，**不扣款**（LINE Pay 未被 Confirm）。店家可用診斷 API 的 `needs_review` 找出這些訂單，與顧客或 LINE Pay 商家後台核對後人工處理。
4. 診斷：`GET /api/order-identity/diagnostics?limit=100`；啟動 log：`[DB] order_identity: 歷史訂單有 N 組重複編號…`。

## 6. 測試結果與回歸比較（台北時間 2026-11-14）

### 6.1 七項重現／驗收：`scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js`

- 未修改的 C5：**13 通過／48 失敗**；C5.1（候選 ZIP 全新解壓）：**61 通過／0 失敗**（逐案見第 2 節表格）。
- 真實 LINE Messaging API 與 LINE Pay 呼叫：0 次（Z 案例）。

### 6.2 主要回歸（C5.1 工作樹）

| 腳本 | C5.1（本輪） | 備註 |
|---|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | 42／42 | 以 C4_CLOCK_OFFSET_MS=0 執行；預設時鐘在台北 11:30 後 B1 會因測試內會員 session 到期時間計算失敗，未修改的 C5 同時段同樣 41／42（既有、與時段相關） |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | 42／42 | 含 L3-4 必要調整 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | 53／54 | C4_CLOCK_OFFSET_MS=0 時 D1-3（今日截止）失敗，C5 同樣；預設時鐘 C5.1 與 C5 都 54／54 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | 80／80 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | 40／40 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | 12／12 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | 30／30 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | 32／32 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | 54／54 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | 328／332 | O1、O6×2、O9 失敗：測試以今日 12:00 取餐，執行時已過 12:00（time_too_early）；未修改的 C5 同時段同樣 328／332 |
| `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 |  |

### 6.3 61 支既有回歸（與 C5 報告逐支比較）

- C5.1：**41 支 exit 0**（C5 報告同為 41 支）；其餘 20 支非 0 與 C5 報告逐支相同（61/61 支 exit 結果一致）。
- 通過數有差異者只是輸出格式（`TOTAL=… PASS=…` 由執行器解析方式不同），數字與 C5 相同：two-stage checkout 113、friend-live 24、first-touch 37、phase1 68、phase2 114、phase3 付款 111、Recovery 前端 50、Recovery 全量 168、checkout summary 67。
- `static-audit-r48-popup-order-ui`、`smoke-hotfix27-cd` 等既有失敗與 C5 相同（凍結位元組稽核／檔名比對，C5 報告已說明）。

### 6.4 失敗分類

- **既有失敗（C5 同時段同樣失敗，與時段有關）**：C5 成效 B1（預設時鐘、11:30 後）、C4.5 日期 D1-3（offset 0）、C3 O1／O6／O9（12:00 後）。三者都已在相同時段對未修改的 C5 重跑確認結果相同。
- **新增失敗：0。**
- 本輪開發中曾發現並已修正的回歸（最終版本均通過）：LINE Pay 測試替身沒有 `text()`、使用非數字交易識別、精簡測試資料庫沒有 `linepay_transaction_id` 欄位、替身對不同請求回傳相同交易識別——C5.1 均改為相容處理（`readLinePayResponse`、交易識別安全字元檢查、欄位存在檢查、交易識別一般索引）。

### 6.5 必要的既有斷言調整（不放寬斷言）

1. 沿用 C5 的 C4.3 B9、C4.2 A18、C4 B2 調整（C5 報告 7.2）。
2. `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` L3-4「網址整理前重新整理不重複開啟」：原本以 `page.goto` 再次載入同一連結模擬「重新整理」。R3 要求同一分頁再次進入通知連結＝新的一次開啟（須另計點擊並開啟商品），兩者是同一個瀏覽器動作。改為真正的重新整理（網址仍含直達參數時 `page.reload()`，導覽類型＝reload）；斷言「不重複開啟」不變。調整前 C5.1 41／42，調整後 42／42；調整後的操作在 C5 也通過。


## 7. 從候選 ZIP 全新解壓後的驗收

候選 ZIP 全新解壓、`npm ci` 後：
- 啟動：`/api/health`、點餐頁、後台 200；未授權 `/api/analytics/restock-notify/summary`（帶 query store_id）、`/api/order-identity/diagnostics`、`/restock/date-options` 401；`/api/product-demand/subscribe` 未帶會員 401；啟動 log 沒有 `order_identity migration:`／`restock_tracking migration:` 警告。
- 主要測試全部通過：

| 腳本 | 結果 |
|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | 61／61 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | 42／42 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | 54／54 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | 12／12 |
| `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 |
| `scripts/smoke-r54-4-mbv2-migration.js` | 121／121 |
| `scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111／111 |
| `scripts/run-h1-4-10-phase4b-recovery-full-runtime.js` | 168／168 |
| `scripts/smoke-h1-4-12-popup-frontend.js` | 293／293 |
| `scripts/smoke-h1-4-12-popup-public-checkout.js` | 1447／1447 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（C4_CLOCK_OFFSET_MS=0） | RESULT: 42 passed, 0 failed |
| `scripts/smoke-r54-4-mbv2-hf1-c5-1-rollback.js`（舊版＝C5） | 8／8 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-1-rollback.js`（舊版＝C4.5） | 8／8 |

- 最終 ZIP 與受測候選 ZIP 的程式檔逐檔相同（SHA-256 比對），只在 `docs/R54_4_MBV2_HF1_C5_1/` 補上報告、結果與 manifest。


## 8. 部署後最短驗收

維持「啟用 LINE 補貨通知發送」關閉；不發送真實訊息。

1. 服務啟動後 log 沒有 `[DB] order_identity migration:`／`restock_tracking migration:` 警告；若有 `歷史訂單有 N 組重複編號` 提示，屬預期（只是提示）。
2. 員工登入後 `GET /api/order-identity/diagnostics` 回 200；確認 `needs_review` 是否有需要人工核對的舊 LINE Pay 付款。
3. 建立一張測試以外的正常 LINE 訂單（現金）：訂單編號為 `LINE-YYYYMMDD-HHMMSS-XXXX` 格式。
4. 「營運分析中心 → 🔔 補貨通知成效」可開啟，下方顯示「共 N 個批次・第 1／M 頁」。
5. 若店家已啟用 LINE Pay：以小額實際付款一次（或 Sandbox），確認導回成功頁顯示正確訂單、後台訂單為已付款、份數只扣一次。**本輪沒有做真實 LINE Pay 驗證，這一步是部署後的第一個真實驗證。**

## 9. 回退（已測試；保留現有資料庫）

**已測試**（`scripts/smoke-r54-4-mbv2-hf1-c5-1-rollback.js`，舊版＝C5 與 C4.5 各 8／8、8／8）：舊版程式以 C5.1 資料庫啟動並讀取批次、建立新訂單；C5.1 建立的第一次 LINE Pay 付款請求可在舊版完成 callback；C5.1 發出的含 rt 通知連結在舊版頁面照常開啟商品；再升級回 C5.1 時遷移可重複執行、舊版期間的訂單保留。

**步驟**（保留現有資料庫、只退回程式；不得以還原舊資料庫回退，否則遺失新訂單）：
1. 後台取消勾選「啟用 LINE 補貨通知發送」。
2. 等待通知批次清單不再出現「發送中」。
3. 對「已暫停」的批次按「取消未送出項目」；**不要按「續送未完成項目」**。
4. 盡量在沒有進行中 LINE Pay 付款的時段：用 `GET /api/order-identity/diagnostics` 與後台訂單確認待付款的 LINE Pay 訂單。
5. 重新部署 C5 ZIP（建議，保留 C5 成效追蹤；或 C4.5），保留現有資料庫。新增的欄位、資料表、索引不影響舊版（已測）。

**回退後會重新出現的問題**：退回 C5 → R1～R7 全部重新出現（含同秒訂單編號重複、LINE Pay 以 OR 取第一筆、搬家以編號合併）；退回 C4.5 → R1 與 R7 仍在（C4.5 已確認有 R1），另外沒有 C5 成效追蹤。

**未完成付款**：
- C5.1 建立、同一訂單的**第一次**付款請求（orderId＝訂單編號，新編號不重複）：舊版可完成 callback（已測）。
- 同一訂單**再次**付款請求（orderId 加 `-P2` 等）或歷史重號訂單（orderId 加 uuid 片段）：舊版找不到訂單、導回錯誤，**不會扣款**（未呼叫 Confirm）；需請顧客重新付款或由店家核對。
- 退回後舊版建立的新訂單又回到秒級編號（可能同秒重號）；再升級回 C5.1 後，這些訂單依歷史重號原則處理（不改、不合併、診斷列出）。


## 10. 限制與未驗證

- 未驗證：LINE App／LIFF 真機（導覽類型、背景辨識時序）、真實 Messaging API、真實 LINE Pay（Sandbox／正式）付款與 callback、正式 Zeabur、多台伺服器、真實 GA4／Meta Pixel。模擬 LIFF SDK、模擬 LINE／LINE Pay API、Playwright 攔截都不是真機或正式站驗證。
- LINE Pay 對「同一交易重複 Confirm」實際回傳哪個代碼未能從官方頁面確認；C5.1 不依賴這一點（已付款即不再呼叫 Confirm）。
- R3 依瀏覽器導覽類型判斷「同一次開啟」：在 LINE 內建瀏覽器中「再次點選同一則通知」會開新的 LIFF 視窗（新分頁、新識別），與本輪 Playwright 同分頁 `goto` 的結果相同；真機行為未驗證。
- R1 舊版前端的限制見 R1。
- 一個多 CPU／多台伺服器同時下單的情境：新編號在單一程序內同步查重，持久化唯一索引在單一資料庫檔上保護；本系統架構為單一程序＋sql.js，多台伺服器共用資料庫不在支援範圍。
- 金額口徑與退款限制沿用 C5：沒有逐項退款資料，已退款／待退款另行標示，**不是精確淨營收**。
