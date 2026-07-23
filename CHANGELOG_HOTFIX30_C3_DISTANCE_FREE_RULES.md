# CHANGELOG — HOTFIX30 C3：距離級距滿額免運＋前後端金額一致

版本：`pos-web-fix18-10-hotfix30-C3-distance-free-rules-full`
基礎：`pos-web-fix18-10-hotfix30-C2-delivery-free-progress-full`

---

## 一、根因（C2 版 Bug）

C2 版的「滿額免運進度提示」只是一個**獨立顯示層**：`public/js/delivery-free-progress.js`
自己讀一份全店 `delivery_free_threshold` 猜測折抵金額，用來顯示「已折抵 NT$50」之類的文案；
但購物車實際外送費、送出訂單金額、`routes/delivery.js` 的 `/calculate-fee`、以及
`routes/line-orders.js` 的 `recalcDeliveryFee()`，各自用**另一套公式**計算真正外送費
（`rawFee - basicFee`，且只有單一全店門檻，沒有「依距離級距各自設定門檻」的概念）。

結果：距離 11.94 km、滿額門檻 NT$1,000、商品小計 NT$1,000 時，提示層可能顯示「已折抵
NT$50」，但購物車/訂單走的是另一條計算路徑，算出來的外送費是 NT$160 且完全反映在應付
金額裡——兩邊「同時都對」，只是對的是不同的數字，才會看起來像「顯示折抵但沒真的扣」。

**根本原因：外送費＋滿額折抵的計算邏輯分散在多處、各自實作，沒有單一計算來源。**

---

## 二、解法：`utils/deliveryFeeCalc.js` 成為唯一 shared engine

新增 `utils/deliveryFeeCalc.js`，匯出：

- `calculateDeliveryFeeWithPromotion({ distanceKm, eligibleSubtotal, distanceRules, legacySettings, maxDistanceKm })`
  → 唯一負責「命中哪個距離級距、套用哪種滿額優惠、算出 rawFee/discount/finalFee」的函式。
- `normalizeDeliveryDistanceFeeRules(input)` → 唯一負責「後台儲存距離級距設定時的驗證/正規化」。
- `pickDistanceRule` / `resolvePromotion` / `ruleHasOwnPromotion` → 內部 helper，供上兩者與測試使用。

呼叫端：

| 檔案 | 用途 |
|---|---|
| `routes/delivery.js` | 前台 `/api/delivery/calculate-fee` 試算 API |
| `routes/line-orders.js` | `recalcDeliveryFee()`：送單時後端重新計算（不信任前端） |
| `routes/settings.js` | `PUT /api/settings`：儲存距離級距設定前的驗證 |
| `public/js/delivery-free-progress.js` | 只負責「把後端算好的結果排成文案」，不再自己猜門檻/折抵 |

Repo-wide grep 確認（見附件章節「Repo-wide grep 結果」）：`calculateDeliveryFeeWithPromotion`
的**實作**只存在於 `utils/deliveryFeeCalc.js` 一處；其餘出現處全部是呼叫端或註解。

---

## 三、新距離級距資料格式

`delivery_distance_fee_rules`（settings，JSON 字串）：

```json
[
  { "max_km": 3,  "fee": 50,  "free_threshold": 300,  "free_mode": "full",  "free_discount": 0 },
  { "max_km": 5,  "fee": 80,  "free_threshold": 500,  "free_mode": "full",  "free_discount": 0 },
  { "max_km": 7,  "fee": 120, "free_threshold": 800,  "free_mode": "full",  "free_discount": 0 },
  { "max_km": 9,  "fee": 150, "free_threshold": 1000, "free_mode": "fixed", "free_discount": 100 },
  { "max_km": 11, "fee": 180, "free_threshold": 1200, "free_mode": "fixed", "free_discount": 100 },
  { "max_km": 13, "fee": 210, "free_threshold": 1500, "free_mode": "fixed", "free_discount": 100 },
  { "max_km": 15, "fee": 240, "free_threshold": 1800, "free_mode": "fixed", "free_discount": 100 }
]
```

三種 `free_mode`：

- `none`  — 這個級距不套用滿額優惠（`discount = 0`）。
- `full`  — 達門檻後 `discount = rawFee`（全免）。
- `fixed` — 達門檻後 `discount = min(free_discount, rawFee)`（固定折抵，不會讓 finalFee 變負數）。

舊格式 `{ max_km, fee }`（沒有 `free_mode` 欄位）依然合法——後台管理介面稱之為「沿用全店
設定」，儲存時**刻意省略** `free_mode`/`free_threshold`/`free_discount` 三個欄位，交給下面
的 legacy fallback 處理，而不是硬塞一個 `"legacy"` 字串進正式規則 JSON。

`utils/deliveryFeeSuggestedRules.js` 是上面這組「建議級距」的單一資料來源，同時被：
- `utils/db.js`：新店/尚未有任何規則的店家 seed 預設值。
- `public/js/app.js`：後台「✨ 套用建議級距」按鈕（因為前端無法 `require()` 後端模組，
  這裡維持一份內容相同的 JS 常數；日後調整建議值時兩處都要同步修改）。

---

## 四、Legacy fallback 規則

`resolvePromotion(matchedRule, legacySettings)`（`utils/deliveryFeeCalc.js`）判斷順序：

1. **命中的級距本身有完整促銷欄位**（`free_mode` 是 `none`/`full`/`fixed` 其中之一，且
   `free_threshold` 是合法數字）→ 直接使用這個級距自己的設定，**不 fallback**。
   即使 `free_mode === 'none'`，也是「這個級距明確設定不優惠」，不會因為店家舊版全店
   還有 `delivery_free_threshold` 而又被套用進來。
2. **命中的級距沒有 `free_mode`（或為空字串）** → fallback 使用店家舊版全店設定：
   `delivery_free_enabled`（未設定視為啟用）、`delivery_free_threshold`、
   `delivery_free_mode==='distance_only'` 視為 `fixed`（折抵值＝`delivery_basic_fee`），
   其餘視為 `full`。
3. **新舊規則都沒有啟用** → `discount = 0`（不套用任何滿額優惠）。

超過本店最大外送距離（`delivery_max_distance_km`）或超過所有級距設定範圍 → `outOfRange:
true`，滿額優惠**不解除**距離限制。

---

## 五、金額資料流（單一 finalFee）

```
calculateDeliveryFeeWithPromotion()  ← 唯一計算來源
        │  { rawFee, discount, finalFee, matchedRule, threshold, promotionMode, reached, remaining }
        ▼
routes/delivery.js  POST /api/delivery/calculate-fee
        │  { raw_fee, delivery_discount, delivery_fee(=finalFee), free_rule_type,
        │    free_threshold, free_discount_value, remaining_for_free_delivery,
        │    free_rule_applied, is_free_delivery, out_of_range, matched_max_km }
        ▼
public/line-order.html  fetchDeliveryFee()
        │  _deliveryFeeResult = { rawFee, finalFee, discount, mode, threshold, ... }
        ▼
購物車外送費列／應付金額（updateBar()）：一律用 _deliveryFeeResult.finalFee
        ▼
送單 payload：delivery_fee_preview = _deliveryFeeResult.finalFee（僅供一致性檢查，非信任來源）
        ▼
routes/line-orders.js  recalcDeliveryFee()（呼叫同一個 calculateDeliveryFeeWithPromotion()）
        │  calcDelivFee = feeResult.deliveryFee（= finalFee，不是 rawFee）
        ▼
orders.delivery_fee = finalFee
orders.delivery_fee_meta = JSON.stringify({ raw_fee, delivery_discount, final_fee(=finalFee),
                                             distance_km, matched_max_km, free_threshold,
                                             free_rule_type, is_free_delivery })
        ▼
後台訂單詳情（public/js/app.js buildDeliveryFeeMetaHtml()）／Dashboard／報表
        → 全部只讀 orders.delivery_fee（= finalFee）作為實收外送費
```

外帶訂單：`calcDelivFee` 維持初始值 `0`、`deliveryFeeMeta` 維持初始值 `null`，不受本次
變更影響（`if (isDelivery) { ... }` 區塊外的初始化不變）。

---

## 六、`price_changed` 價格一致性防護

`routes/line-orders.js` 送單時，**一定**用 `recalcDeliveryFee()`（shared engine）重算一次，
不信任前端 `delivery_fee_preview`；只有在滿足下列條件時才拒單：

```js
const hasPreview = delivery_fee_preview !== undefined && delivery_fee_preview !== null
  && delivery_fee_preview !== '' && Number.isFinite(Number(delivery_fee_preview));
if (hasPreview && Math.abs(Number(delivery_fee_preview) - finalFee) > 0.01) {
  return res.status(409).json({ success:false, reason:'price_changed', ... });
}
```

- **舊版前端沒有傳 `delivery_fee_preview`** → `hasPreview === false` → 完全不比對，正常
  下單，維持向下相容。
- 差異在 0.01 元以內（浮點誤差）→ 視為一致，不拒單。
- 差異明顯（例如店家在顧客瀏覽期間調整了級距設定）→ 回傳 409 + `reason: 'price_changed'`
  + `delivery_fee_result`（後端剛重算出的權威結果），**不建立訂單**。
- 前端收到 `price_changed` 後（`public/line-order.html`）：不關閉購物車、不清空購物車、
  不自動重送，只用後端回傳的權威結果更新 `_deliveryFeeResult` 與畫面金額，讓顧客自行決定
  是否重新送出。

---

## 七、DB：非破壞性新增 `delivery_fee_meta`

`utils/db.js`：

```js
try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_fee_meta TEXT DEFAULT ""'); w._save(); } catch {}
```

- 欄位已存在（重複執行 migration）時 `catch {}` 吞掉，不報錯。
- 不重建 `orders` 表、不修改既有 `delivery_fee` 欄位語意——`delivery_fee` 依然只存
  **最終實收外送費**（現在等於 `finalFee`），`delivery_fee_meta` 是額外的 JSON 明細快照。
- 舊訂單沒有這個欄位值（空字串）時，後台安全解析（`parseDeliveryFeeMeta()`）回傳 `null`，
  訂單詳情頁 fallback 回舊版單行「距離 X km ｜ 外送費 NT$Y」顯示，不報錯。

---

## 八、優惠券實際順序（依現有程式碼如實記錄，未更動）

**這是目前 `routes/line-orders.js` 的實際行為**，與「理想規格」（商品優惠券後的
`eligibleSubtotal` 才拿去判斷距離滿額門檻）有一個關鍵差異，本次**維持原行為未修改**：

```
1. sub = Number(subtotal)              ← 直接信任前端送來的商品小計（既有行為，本次未變更）
2. 若有 coupon_code：
     validateCoupon(db, storeId, code, sub, phone)  ← 用「原始 sub」驗證優惠券
     → discAmt, finalTotal = sub - discAmt（暫定）
3. 距離級距滿額判斷：
     recalcDeliveryFee(db, storeId, lat, lng, sub)  ← eligibleSubtotal 用的是「原始 sub」，
                                                        不是「優惠券折扣後」的金額
     → rawFee, discount, finalFee（= calcDelivFee）
4. 若 coupon_apply_to_delivery_fee 開啟：
     couponBase = sub + calcDelivFee
     重新以 couponBase 驗證同一張優惠券 → 更新 discAmt / finalTotal
   否則：
     finalTotal = sub - discAmt + calcDelivFee
```

**與需求文件理想順序的差異**：距離級距的「滿額門檻」判斷用的 `eligibleSubtotal` 是
**優惠券折扣前**的商品小計，不是折扣後的金額（第 3 步用的是原始 `sub`，不是
`sub - discAmt`）。這是 C2 版就存在的既有行為，`public/js/delivery-free-progress.js` 的
註解也明確記載「與後端一致：用的都是優惠券折扣前的商品小計」。本次 C3 **刻意保持這個既有
行為不變**，只是把「怎麼算距離折抵」這件事集中到 shared engine，沒有動「用哪個金額判斷
門檻」這個既有慣例，避免引入未經需求方確認的行為變更。

`coupon_apply_to_delivery_fee` 目前不是獨立的「外送費專屬優惠券」，而是同一張優惠券在
`couponBase = sub + calcDelivFee` 這個更大的基準上重新驗證一次——沒有「兩張券各自作用」
的疊加折抵，因此不會發生規格所擔心的「距離優惠與外送費券重複扣到負數」。`finalFee` 本身
在 shared engine 內已用 `Math.max(rawFee - discount, 0)` 鎖住不會為負。

---

## 九、後台 UI（`public/index.html` + `public/js/app.js`）

距離級距每一列新增欄位：距離上限／外送費／滿額門檻／優惠模式／折抵金額／刪除。

優惠模式下拉：`legacy`（沿用全店設定）／`none`（不優惠）／`full`（滿額全免）／`fixed`
（滿額固定折抵）。切換模式時（`_onDeliveryRuleModeChange()`）：

- `legacy` → `delete r.free_mode; delete r.free_threshold; delete r.free_discount;`
  （不會存字串 `"legacy"` 到正式規則 JSON）。
- `none` → 折抵欄位強制停用、正規化為 0；門檻可為 0。
- `full` → 門檻必填；折抵欄位停用並顯示「全免」（`free_discount` 正規化為 0）。
- `fixed` → 門檻與折抵金額皆必填。

新增一列（`addDeliveryRule()`）預設是 legacy（只有 `{max_km, fee}`），避免店家新增一列
就意外關掉舊版全店免運。

新增「✨ 套用建議級距」按鈕（`public/index.html`，位置：標題／說明 → 按鈕 → 規則列表 →
新增級距），點擊後先 `confirm('將覆蓋目前距離級距設定，是否繼續？')`，確認後只更新畫面
陣列（`_deliveryRules`），**不會自動呼叫儲存 API**，店家仍需按「💾 儲存外送費設定」才會
真正送出。

後端 `routes/settings.js` 的 `PUT /api/settings` 在儲存前呼叫
`normalizeDeliveryDistanceFeeRules()` 做伺服器端驗證（`max_km>0`／`fee>=0`／距離遞增不重複／
各模式必填欄位），正規化後的結果才是真正落地儲存的 JSON。

---

## 十、後台訂單詳情

`public/js/app.js` 新增 `parseDeliveryFeeMeta()`（安全解析，格式錯誤回傳 `null`，不拋例外）
與 `buildDeliveryFeeMetaHtml()`：

- 有 `delivery_fee_meta` → 顯示：配送距離／命中級距／原始外送費／滿額門檻／優惠模式
  （中文：沿用全店設定／不優惠／滿額全免／滿額固定折抵）／滿額折抵（僅 >0 時顯示）／
  最終外送費（只顯示一次，不與舊版單行重複）。
- 沒有 `delivery_fee_meta`（舊訂單）→ fallback 回舊版「距離 X km ｜ 外送費 NT$Y」單行。
- `matched_max_km` 空值不顯示「命中級距」；距離為 0 或空值不顯示「配送距離」。

`GET /api/orders/:id`（`routes/orders.js`）本來就是 `SELECT * FROM orders ...`，
`delivery_fee_meta` 自動包含在回傳結果中，不需要額外修改欄位白名單。

---

## 十一、Dashboard／報表

Repo-wide grep 確認 `routes/dashboard.js`、`routes/analytics.js` 完全沒有出現
`delivery_fee`／`raw_fee`／`delivery_discount` 字樣——現有營收/報表邏輯本來就是用
`orders.total`／`orders.subtotal` 等欄位，沒有另外對外送費做加總或拆分。

**Dashboard 不需要改公式**，因為 `orders.delivery_fee` 現在已經統一存最終實收外送費
（`finalFee`），沒有任何報表邏輯是直接讀 `raw_fee` 或 `delivery_fee_meta` 當收入。
`routes/migration.js`／`routes/sync.js`／`routes/linepay.js` 對 `delivery_fee` 的引用
都是單純把 `orders.delivery_fee` 這個既有欄位值原封不動搬到匯出/同步/付款流程，同樣不受
影響。若未來要新增「折抵金額統計」報表，建議另開一版，從 `delivery_fee_meta.delivery_discount`
取值，本次不擴大範圍。

---

## 十二、測試結果

| 指令 | 結果 | exit code |
|---|---|---|
| `node -c utils/deliveryFeeCalc.js` | PASS | 0 |
| `node -c utils/deliveryFeeSuggestedRules.js` | PASS | 0 |
| `node -c utils/db.js` | PASS | 0 |
| `node -c routes/delivery.js` | PASS | 0 |
| `node -c routes/line-orders.js` | PASS | 0 |
| `node -c routes/settings.js` | PASS | 0 |
| `node -c public/js/delivery-free-progress.js` | PASS | 0 |
| `node -c public/js/app.js` | PASS | 0 |
| `node scripts/smoke-delivery-free-progress.js` | **18/18 PASS** | 0 |
| `node scripts/smoke-delivery-distance-promotion.js` | **75/75 PASS**（含核心驗收：11.94km→13km 級距，raw=210/discount=100/finalFee=110，以及完整資料流斷言） | 0 |
| `public/line-order.html` 所有 inline `<script>`（2 段） | PASS（`node -c`） | 0 |
| `public/index.html` 所有 inline `<script>` | N/A（0 段，該頁全部外部載入 `app.js`，無 inline script） | — |
| `scripts/regression-all.js` / `scripts/smoke-all.js` / `npm test` | **不存在**（repo 內找不到這幾個檔案/指令，如實回報，未執行） | — |

Repo-wide grep（duplicated formula 檢查）：

- `grep -R "rawFee -"` → 只出現在 `utils/deliveryFeeCalc.js`（shared engine 本體與其註解）。
- `grep -R "raw_fee -"` → 無結果。
- `grep -R "calculateDeliveryFeeWithPromotion"` → 實作僅 `utils/deliveryFeeCalc.js` 一處；
  其餘出現處（`routes/delivery.js`、`routes/line-orders.js`、
  `public/js/delivery-free-progress.js`、兩份 smoke script）皆為呼叫端或註解，
  **沒有第二套完整公式**。
- `free_threshold` 在 `routes/line-shipping.js`／`public/line-shipping.html` 出現，但那是
  完全獨立的「冷藏宅配」功能（`shipping_free_threshold`），與本次距離外送費滿額免運無關。

---

## 十三、未能在沙盒環境自動驗證的項目

以下項目性質上需要真實部署環境／外部服務／人工操作，本次僅能靠 shared engine 層與資料流
模擬測試覆蓋邏輯正確性，無法在此沙盒環境跑通：

1. 正式 Google Routes API 實際回傳距離（`GOOGLE_MAPS_SERVER_KEY` 未設定/無出網權限）。
2. 真實 GPS 定位／瀏覽器 Geolocation 行為。
3. LINE Login／LIFF 實際回跳流程（需要真實 LINE 帳號與網域白名單）。
4. 真實付款（LINE Pay／信用卡）流程與退款。
5. 瀏覽器實際視覺呈現（後台距離級距編輯器在行動裝置窄螢幕下的實際排版、購物車金額明細
   RWD 呈現）。
6. 正式環境資料庫實際落地驗證（`ALTER TABLE ... ADD COLUMN` 在真實既有資料量下的執行時間
   與相容性）。
