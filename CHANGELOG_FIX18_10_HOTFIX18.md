# CHANGELOG_FIX18_10_HOTFIX18.md
## fix18-10-hotfix18｜LINE 冷藏宅配中心 V1

版本基礎：POS Web 專案 Hotfix17
建置日期：2026-07-08

---

## 一、本次目標

在不重寫、不破壞現有 LINE 點餐（外帶／外送）的前提下，新增一個**完全獨立**的
「冷藏宅配」下單入口、獨立前台頁面、獨立後台設定、獨立商品欄位與獨立 API。
V1 不串接黑貓 API，只保留物流欄位供手動填寫。

---

## 二、修改檔案清單

### 後端
| 檔案 | 變更內容 |
|---|---|
| `utils/db.js` | safe migration：orders 表新增 18 個宅配欄位、products 表新增 6 個宅配商品欄位、settings 新增 15 個宅配設定 key（皆為 `ALTER TABLE ADD COLUMN` / `INSERT OR IGNORE`，不 DROP、不清空既有資料） |
| `routes/settings.js` | 新增 `SHIPPING_KEYS` 白名單，併入既有 `LINE_KEYS` 授權檢查（沿用 `line_order` feature gate），加入 `ALL_ALLOWED` |
| `routes/line-shipping.js` | **新檔案**：冷藏宅配獨立 API（見下方 API 清單） |
| `routes/products.js` | `enrichProduct()` 新增宅配欄位回傳；新增 `PATCH /:id/shipping-settings` |
| `server.js` | 新增路由掛載 `app.use('/api/line-shipping', requireStore, requireFeature('line_order'), require('./routes/line-shipping'))` |
| `routes/line-orders.js` | `/shop` 設定清單新增 `shipping_enabled`（僅供前台判斷是否顯示宅配入口按鈕，不影響外帶/外送邏輯） |

### 前台
| 檔案 | 變更內容 |
|---|---|
| `public/line-shipping.html` | **新檔案**：冷藏宅配獨立下單頁（品牌區、公告、商品區、加購區、購物車、收件資料、到貨設定、付款、送出、成功頁、查詢訂單） |
| `public/line-order.html` | 首頁新增「📦 冷藏宅配」入口按鈕（依 `shipping_enabled` 設定顯示/隱藏），新增 `goToShippingPage()` 導向函式 |
| `public/css/main.css` | 新增 `.mode-shipping` 徽章樣式 |

### 後台管理介面
| 檔案 | 變更內容 |
|---|---|
| `public/index.html` | 設定 → LINE 營業 頁籤新增「📦 冷藏宅配設定」卡片；商品 LINE 上架設定 Modal 新增「📦 冷藏宅配商品設定」區塊 |
| `public/js/app.js` | 新增 `_fillShippingSettingsForm()` / `saveShippingSettings()`；`openLineSettingsModal()` / `saveLineSettings()` 擴充讀寫宅配商品欄位；`renderOrdersTable()` 新增 `mode-shipping` 徽章與宅配訂單專屬顯示區塊（收件人／電話／地址／到貨日／物流狀態／運費），與外送訂單顯示完全分離 |

---

## 三、新增資料表欄位清單

### `orders` 表（安全新增，未異動既有欄位）
```
fulfillment_type, order_source,
shipping_recipient_name, shipping_phone, shipping_postal_code, shipping_city,
shipping_district, shipping_address, shipping_address_note,
shipping_arrival_type, shipping_arrival_date, shipping_fee, shipping_free_discount,
shipping_carrier_name, shipping_status,
tracking_number, carrier_name, shipping_note   -- V1 保留欄位，尚未串接黑貓 API
```

### `products` 表（安全新增，未異動既有欄位）
```
shipping_enabled, shipping_name, shipping_spec,
shipping_sort_order, shipping_upsell, shipping_share_line_stock
```

---

## 四、新增 settings key 清單

```
shipping_enabled              (預設 0)
shipping_title                (預設 "冷藏宅配")
shipping_description          (預設 "")
shipping_notice               (預設 "")
shipping_storage_note         (預設 "收到後請立即冷藏，建議 48 小時內食用完畢")
shipping_fee                  (預設 200)
shipping_free_threshold       (預設 1500)
shipping_min_order_amount     (預設 150)
shipping_arrival_days_limit   (預設 14)
shipping_lead_days            (預設 1)
shipping_closed_weekdays      (預設 [])
shipping_payment_methods      (預設 ["cash","transfer"])
shipping_carrier_name         (預設 "黑貓冷藏宅配")
shipping_allow_arrival_date   (預設 1)
shipping_upsell_enabled       (預設 1)
```
全部併入 `settings.js` 的 `LINE_KEYS`，沿用既有 `line_order` 授權檢查（未授權店家不可修改）。

---

## 五、API 清單（`routes/line-shipping.js`，掛載於 `/api/line-shipping`）

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/line-shipping/shop` | 取得宅配頁設定、可宅配商品／加購商品、公告、運費規則、可選日期範圍 |
| POST | `/api/line-shipping/validate-cart` | 驗證購物車、運費／免運／最低金額、到貨日期 |
| POST | `/api/line-shipping` | 建立宅配訂單（寫入既有 `orders` 表） |
| GET | `/api/line-shipping/order/:orderNo` | 查詢宅配訂單（供前台「查詢訂單」使用） |
| GET | `/api/line-shipping/admin/orders` | Web 後台宅配訂單列表（含狀態統計） |
| PATCH | `/api/line-shipping/admin/orders/:id/status` | 更新宅配狀態（pending→accepted→packing→shipped→delivered→completed／cancelled），可選填 `tracking_number` / `carrier_name` / `shipping_note` |

以及 `routes/products.js` 新增：

| Method | Path | 說明 |
|---|---|---|
| PATCH | `/api/products/:id/shipping-settings` | 設定商品是否可宅配、宅配名稱／規格／排序／是否為加購商品／是否共用 LINE 份數 |

---

## 六、驗收結果（本機 E2E 實測）

| 測項 | 結果 |
|---|---|
| A. 啟用宅配後，`/api/line-shop` 回傳 `shipping_enabled=1` | ✅ 通過 |
| B. `shipping_enabled=false` 商品不出現在 `/api/line-shipping/shop` | ✅ 通過（SQL 直接以 `shipping_enabled=1` 過濾） |
| C. 運費：未滿免運門檻（750 < 1500）→ 收運費 200 | ✅ 通過 |
| D. 運費：滿免運門檻（1500）→ 運費 0，`free_discount=200` | ✅ 通過 |
| E. 建立宅配訂單成功，`order_source=line_shipping`、`fulfillment_type=shipping`、`order_mode=shipping` | ✅ 通過（實測訂單 `SHIP-20260708-004034`） |
| F. 查詢訂單 `GET /order/:orderNo` 回傳正確收件資訊 | ✅ 通過 |
| G. Web 後台宅配訂單列表可見收件人／電話／地址／到貨日／運費／狀態 | ✅ 通過 |
| H. 更新宅配狀態（pending→accepted）成功且不影響其他欄位 | ✅ 通過 |
| I. 回歸測試：既有 LINE 外帶下單（`/api/line-orders`）不受影響 | ✅ 通過 |
| J. 回歸測試：既有 `/api/orders` 一般訂單列表不受影響 | ✅ 通過 |
| K. `node --check` 全部通過（見下方檔案清單） | ✅ 通過 |

`node --check` 涵蓋：
```
routes/line-shipping.js
routes/settings.js
routes/products.js
routes/line-orders.js
routes/orders.js
server.js
utils/db.js
public/js/app.js
public/line-shipping.html（抽出 inline JS 檢查）
public/line-order.html（抽出 2 段 inline JS 檢查）
```

---

## 七、V1 已知限制（依需求文件第十三節，刻意不做）

1. 未串接黑貓 API（`tracking_number` / `carrier_name` / `shipping_note` 僅供手動填寫）
2. 未自動產生物流單號
3. 未自動列印宅配單
4. 未做溫層多規則
5. 未做複雜分倉
6. 未做多件運費規則（V1 為單一固定運費 + 滿額免運）
7. 前台 LINE Pay 選項於宅配頁會顯示，但選擇後僅提示 `TODO：LINE Pay 尚未支援宅配流程`，不會呼叫既有 LINE Pay 金流（避免誤觸動既有外帶/外送 LINE Pay 邏輯）

---

## 八、Android

本次未修改 Android。宅配訂單寫入既有 `orders` 表（`order_mode='shipping'`），
若 Android 訂單列表原本以「未知 order_mode 一律可見」的方式呈現，應可直接看到宅配訂單；
若需要 Android 專屬 UI（例如宅配專屬圖示、隱藏廚房出單流程），需另行確認 Android 端行為後再評估是否需要 Android ZIP。

---

## 九、輸出

- Web ZIP：`pos-web-hotfix18.zip`
