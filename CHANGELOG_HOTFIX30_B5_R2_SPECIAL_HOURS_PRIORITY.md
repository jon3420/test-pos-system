# fix18-10-hotfix30-B5-R2｜特殊營業最高優先 × 商品卡正常販售 × 取餐方式獨立控制

基礎版本：**Hotfix30-B5**（`pos-web-fix18-10-hotfix30-B5-full.zip`）。**只修改
`routes/line-orders.js` 一個檔案**，`public/line-order.html` 逐行 diff 確認**零差異**
（本輪需求在既有 Hotfix30-B5 的商品卡 `anyImmediate` 修正基礎上已經滿足，問題根源
其實在後端 `/timeslots` 端點，不需要再動前端商品卡邏輯或排版）。

## 1. 問題原因

以真實本機 API 重新、逐項驗證 Hotfix30-B5 宣稱的「特殊營業最高優先」時，發現
`GET /api/line-orders/timeslots` 這支端點本身有一個 Hotfix30-B5 沒有涵蓋到的獨立
bug：這支端點的判斷順序完全沒有走 `resolveFulfillmentState()`（那是給 `GET /shop`
用的），而是自己一套獨立的判斷式，且這套判斷式：

1. **先檢查全域開關，才檢查 Business Calendar**：`if (!modeSettings.enabled) return
   {reason:'mode_closed'}` 是這支端點的第一行判斷，完全沒有給 Business Calendar
   覆蓋的機會。
2. **截止時間判斷用的是全域 `cutoffTime`**，不是「有效截止時間」（Business Calendar
   特殊時段的結束時間 與 今日臨時截止 取較早者）。

**實測重現**：店家全域關閉外帶（`takeout_enabled=0`），但今天有特殊營業設定開放外帶
17:57–23:57——`GET /shop` 正確回傳 `takeout_status.today_state="open"`（因為
`resolveFulfillmentState()` 走的是正確的優先序），但 `GET /timeslots?mode=takeout`
卻回傳 `{slots:[], reason:"mode_closed"}`——前台的「今日服務」顯示開放中，但購物車的
時段選單卻是空的，兩者互相矛盾。這正是使用者回報「特殊營業已開放，但無法選時段」的
根因。

商品卡的 union-of-modes（`anyImmediate` 判斷）在 Hotfix30-B5 已經正確修正，本輪逐項
重新驗證（見第 9 節），**沒有發現新問題，不需要再修改商品卡邏輯或排版**。

## 2. 特殊營業優先序（本輪修正對象：`/timeslots`，`GET /shop` 本身已正確）

修正後的判斷順序（與 `resolveFulfillmentState()` 一致，同一套既有
`getEffectiveModeSchedule()`/`getEffectiveCutoffMins()`，未新增規則）：

```
1. 整店休假（Business Calendar mode=closed／今日臨時休息／固定公休，isClosedDate()）
2. 當日特殊營業設定（getEffectiveModeSchedule() 命中 Business Calendar 時最優先）
3. 店家全域開關（只在「當日未命中 Business Calendar」時才生效）
4. 每週一般營業設定（回退層級最低）
```

`GET /shop`（`resolveFulfillmentState()`）本來就是這個順序（Hotfix30-A/B1 已完成）。
`GET /timeslots` 修正前是「全域開關 → （其餘）」，現在改成「整店休假 →
`getEffectiveModeSchedule()`（已內建特殊營業覆蓋全域開關的邏輯）→ 截止時間」，兩支
API 現在使用同一套判斷依據。

## 3. 特殊營業與每週營業隔離（重新驗證，確認無回歸）

真實 API 驗證：

| Case | 一般營業 | 特殊營業 | 結果 |
|---|---|---|---|
| R2-1 | 外帶/外送皆關閉 | 外帶開 17:57–23:57，外送關 | 外帶 `open`（`today_start_time="17:57"`, `today_cutoff_time="23:57"`），外送 `today_not_open` |
| R2-2 | 外帶/外送皆開放 | 外帶關，外送開 17:57–23:57 | 外帶 `today_not_open`（一般營業開放**未能**覆蓋特殊營業的關閉），外送 `open` |

## 4. 特殊營業取餐方式規則

Case R2-3（特殊營業外帶外送皆開，時段不同：外帶 17:00–23:59、外送 20:00–23:59）：
兩模式各自獨立回傳 `open` 狀態，`today_start_time` 分別為 `"17:00"`／`"20:00"`，
不共用時段，`getEffectiveModeSchedule()` 對兩個 mode 各自呼叫、各自傳入獨立的
`takeoutSchedule`/`deliverySchedule`（`routes/line-orders.js` 第 625-626 行，本輪
未修改）。

## 5. 商品卡簡化規則（Hotfix30-B5 既有修正，本輪重新驗證確認無回歸）

`anyImmediate` 判斷式（`public/line-order.html`，Hotfix30-B5 已完成，本輪**逐行 diff
確認零修改**）：

```js
const anyImmediate = (modeAvail.takeout.enabled && !modeAvail.takeout.reason)
  || (modeAvail.delivery.enabled && !modeAvail.delivery.reason);
```

真實驗證：R2-1（僅外帶開放）與 R2-2（僅外送開放）情境下，商品資料層
`takeout_sold_out_reason`/`delivery_sold_out_reason` 其中一個為 `null`（該模式現在
就能買），對應 `anyImmediate` 模擬計算結果皆為 `true`——商品卡會維持正常販售，不會
顯示「今日售完」或「可預購」。R2-3（兩模式皆開放）兩者的 `sold_out_reason` 皆為
`null`，同樣正常販售。

## 6. 商品支援模式規則（既有邏輯，本輪重新驗證確認無回歸）

Case R2-5（特殊營業只開外帶，商品僅支援外送）：商品的
`takeout_sold_out_reason="product_mode_disabled"`（商品自身不支援外帶，
Hotfix30-B 既有邏輯，本輪未修改），`delivery_sold_out_reason="calendar_mode_closed"`
（外送今日被特殊營業關閉）。兩個原因都不是 `null`，商品在今天無法購買——這是既有
`_productModeStatus()`／商品模式 intersection 邏輯的正確結果，本輪未新增或修改任何
判斷規則。

## 7. timeslots 修正（本輪核心修改，`routes/line-orders.js`）

```diff
- if (!modeSettings.enabled) return res.json({ success: true, slots: [], reason: 'mode_closed' });
- ...(其餘判斷)...
- if (dateStr === todayStr && isCutoffPassed(modeSettings.cutoffTime, nowMins)) {
-   return res.json({ success: true, slots: [], reason: 'cutoff_passed' });
- }
+ const closedInfo = isClosedDate(db, storeId, dateStr);
+ if (closedInfo.closed) return res.json({ success: true, slots: [], reason: 'closed_day' });
+ const effSchedule = getEffectiveModeSchedule(db, storeId, mode, dateStr, modeSettings);
+ if (!effSchedule.enabled) return res.json({ success: true, slots: [], reason: 'mode_closed' });
+ ...(其餘判斷，順序不變)...
+ if (dateStr === todayStr) {
+   const effCutoffMins = getEffectiveCutoffMins(effSchedule, modeSettings.todayCutoff);
+   if (effCutoffMins != null && nowMins > effCutoffMins) {
+     return res.json({ success: true, slots: [], reason: 'cutoff_passed' });
+   }
+ }
```

`getEffectiveModeSchedule()`／`getEffectiveCutoffMins()` 皆是 Hotfix30-A/B1 階段
已建立的既有函式（本輪未修改其內部實作），這裡只是讓 `/timeslots` 改用與
`resolveFulfillmentState()`／`validateOrderConditions()` 相同的單一來源，**未新增
任何判斷規則**。

**實測驗證**：全域 `takeout_enabled=0`，但明日有特殊營業設定 09:00–22:00，
`GET /timeslots?mode=takeout&date=明天` 修正前回傳 `{slots:[], reason:'mode_closed'}`，
修正後正確回傳 26 個時段（`09:00` 起、每 30 分鐘一格，`earliest:"09:00"`）。

## 8. 商品卡排版未修改證明

`public/line-order.html` 以 Hotfix30-B5 為基準逐行 `diff`，**輸出完全空白（零差異）**
——本輪對商品卡的 HTML、CSS、標籤位置、DOM 結構、判斷邏輯**完全沒有任何修改**，
因為問題根源在後端 `/timeslots` 端點，前端商品卡邏輯（`anyImmediate`／
`canPreorderNextDay`）在 Hotfix30-B5 已經正確，本輪不需要也沒有再次觸碰。

## 9. Case R2-1～R2-6 結果（真實本機 API，本輪執行）

| Case | 結果 |
|---|---|
| R2-1（一般營業皆關 + 特殊營業外帶開 17:57–23:57，外送關） | **PASS**（8 項斷言：外帶 `open`／時段來自特殊營業／外送 `today_not_open`／商品正常可買） |
| R2-2（一般營業皆開 + 特殊營業外帶關，外送開 17:57–23:57） | **PASS**（4 項斷言：外帶 `today_not_open`／外送 `open`／商品正常可買） |
| R2-3（特殊營業兩者皆開，時段不同） | **PASS**（4 項斷言：兩模式獨立 `open`，時段不同） |
| R2-4（特殊營業兩者皆關，允許未來預約） | **PASS**（2 項斷言：`holiday` 狀態 + 有未來可預約日期） |
| R2-5（特殊營業只開外帶，商品僅支援外送） | **PASS**（商品 `takeout_sold_out_reason="product_mode_disabled"`，正確不可購買） |
| R2-6（特殊營業開放，但商品 LINE 份數用罄） | **PASS**（`takeout_sold_out_reason="real_sold_out"`，Business Calendar 未覆蓋真實庫存售完狀態） |

**本輪累計：20/20 PASS，0 FAIL。**

## 10. Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 187/187（與 Hotfix30-B5 完全相同，本輪未新增或刪除任何 HTML 元素）；
重複 DOM id：0；無測試用 `console.log`／除錯程式碼殘留於正式檔案；本輪未修改
`fulfillmentContext`／`applyFulfillmentMode()`／`fulfillmentRenderToken`／地址隔離／
外送費公式／Google Maps／localStorage／LINE Login／LINE Pay／Analytics／
Dashboard／商品卡排版。

## 11. 已知限制

1. **`/timeslots` 修正未逐一測試所有時區邊界情境**（例如跨日午夜前後的 prep-time
   四捨五入邊界），本輪驗證聚焦於「特殊營業覆蓋全域開關」這個核心 root cause，
   `getEarliestMins()` 的分鐘數計算本身沿用 Hotfix30-B1 既有實作，未修改。
2. **未使用完整瀏覽器測試**：延續前幾輪環境限制（沙盒網路白名單擋下瀏覽器二進位檔
   下載），本輪驗證全部透過真實本機 Node server + 真實 HTTP API 完成，未透過真實
   DOM 操作重新確認商品卡在瀏覽器中的實際渲染結果（僅透過商品資料層與既有前端邏輯
   程式碼確認判斷依據正確）。

## 12. 回退方式

1. 還原 `routes/line-orders.js` 為 Hotfix30-B5 版本內對應檔案即可（本版只修改這一個
   檔案，`public/line-order.html` 與 Hotfix30-B5 完全相同，回退時甚至不需要處理）。
2. 未新增資料庫欄位、未修改 migration，回退不需要處理資料庫層面。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
