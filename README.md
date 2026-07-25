# 🍱 餐車 POS 系統 — 完整使用說明

## 專案結構

```
pos-system/
├── server.js              # Express 主程式
├── package.json           # 依賴套件
├── n8n-workflow.json      # n8n 自動化流程（可直接匯入）
├── README.md              # 本說明文件
├── data/
│   └── pos.db             # SQLite 資料庫（自動建立）
├── utils/
│   └── db.js              # 資料庫工具
├── routes/
│   ├── products.js        # 商品 API
│   ├── orders.js          # 訂單 API
│   ├── customers.js       # 會員 API
│   └── settings.js        # 設定 API
└── public/
    ├── index.html         # 前端主頁
    ├── css/main.css       # 樣式
    └── js/app.js          # 前端邏輯
```

---

## 一、快速啟動

### 前提條件
- Node.js 18+ (https://nodejs.org)

### 安裝步驟

```bash
# 1. 進入專案資料夾
cd pos-system

# 2. 安裝依賴
npm install

# 3. 啟動伺服器
npm start

# 4. 開啟瀏覽器
# 前往 http://localhost:5000
```

### 開發模式（自動重啟）
```bash
npm run dev
```

---

## 二、API 文件

### 商品 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/products | 取得所有商品（?category=主食&enabled=1）|
| GET | /api/products/:id | 取得單一商品 |
| POST | /api/products | 新增商品 |
| PUT | /api/products/:id | 更新商品 |
| DELETE | /api/products/:id | 刪除商品 |

**POST /api/products 範例：**
```json
{
  "name": "炒米粉",
  "category": "主食",
  "price": 80
}
```

### 訂單 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/orders | 取得訂單（?date=2026-05-05）|
| GET | /api/orders/:id | 取得單一訂單 |
| POST | /api/orders | 建立訂單（結帳）|
| POST | /api/orders/webhook-test/:id | 手動觸發 Webhook |

**POST /api/orders 結帳 Payload：**
```json
{
  "items": [
    { "productId": 1, "name": "冷拌麻油腰子", "price": 150, "qty": 1, "subtotal": 150 }
  ],
  "payment_method": "cash",
  "customer_name": "王小明",
  "customer_phone": "0912345678",
  "customer_line_id": "U1234567890abcdef",
  "note": "少辣"
}
```

### 會員 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/customers | 取得會員列表（?phone=&q=搜尋）|
| GET | /api/customers/:id | 取得會員詳情（含消費紀錄）|
| POST | /api/customers | 新增會員 |

### 其他 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | /api/stats/today | 今日統計（訂單數、營業額、熱賣商品）|
| GET | /api/settings | 取得系統設定 |
| PUT | /api/settings | 更新系統設定 |
| GET | /api/health | 健康檢查 |
| POST | /webhook/n8n | n8n 回呼端點 |

---

## 二之一、Geo Intelligence 行政區分析

老闆儀表板首頁的「🌍 Geo Intelligence」區塊，除了訪客／加購／結帳／完成訂單／成交率等 KPI，也提供「行政區排行榜」，可以看到每個行政區的表現、篩選特定縣市或行政區、依欄位排序、搜尋、展開查看該區域的完整轉換漏斗，並點擊行政區開啟詳情側欄。

**選縣市／選行政區**：排行榜上方有兩個下拉選單，先選縣市（例如「桃園市」），行政區選單會自動更新成只顯示該縣市底下的行政區（例如「中壢區」「八德區」）；選好之後，KPI、Top 3、排行榜、建議動作會一起重新整理成篩選後的結果。切換縣市時會自動清掉不相容的行政區篩選；選回「全部縣市」則會回到未篩選的全店資料。

**排序**：點擊表頭（訪客／加入購物車／開始結帳／完成訂單／成交率）依該欄位排序，再點一次會切換升冪／降冪（表頭旁的 ↑／↓ 會顯示目前方向）。「未知區域」（無法辨識行政區的訪客）永遠排在最後一列，不會因為數字大就排到第一名。

**搜尋**：在搜尋框輸入行政區名稱的一部分（例如輸入「中壢」）就能立刻篩選出符合的行政區，不需要按 Enter，也不會另外打 API。

**展開 Funnel**：點擊每一列前面的箭頭圖示，可以展開看該行政區的完整轉換路徑：訪客 → 加入購物車 → 開始結帳 → 完成訂單，再點一次收合。

**開啟 Drawer**：點擊行政區名稱，會從右側滑出詳情面板，顯示該區域的完整數據、Geo Quality 狀態，以及跟這個區域相關的建議動作；沒有相關建議時會顯示「目前資料不足」，不會顯示假建議。按右上角關閉按鈕或按 Esc 鍵都可以關閉。

**切換店家／日期**：跟儀表板其他區塊一樣，排行榜會自動套用目前登入的店家與目前選取的日期區間，切換店家或日期時會自動重新載入，不需要另外操作。

> **關於「未知區域」**：訪客的 IP 位置或地址如果無法解析成具體的行政區，會被歸類成「未知區域」，誠實顯示在排行榜與相關統計中（不會被偷偷隱藏），但不會排進正常行政區的排行榜第一名，也不會參與「高意願區域」等排名比較。

---

## 三、n8n 自動化設定

### 匯入 Workflow

1. 開啟 n8n 介面
2. 點擊右上角 **+** → **Import from file**
3. 選擇 `n8n-workflow.json`
4. 點擊 **Import**

### 設定步驟

#### 1. 取得 Webhook URL
- 在 n8n 中啟用「接收 POS 訂單」Webhook 節點
- 複製顯示的 Webhook URL（格式：`https://your-n8n.com/webhook/pos-order`）

#### 2. 設定 Google Sheets
- 在 n8n 中設定 Google Sheets 憑證（Service Account 或 OAuth2）
- 建立 Google Sheet，第一列欄位名稱：
  - `訂單編號` / `時間` / `顧客姓名` / `電話` / `LINE ID` / `商品明細` / `付款方式` / `總金額` / `備註`
- 在 workflow 的「寫入 Google Sheets」節點中填入 Sheet ID

#### 3. 設定 LINE Messaging API
- 前往 [LINE Developers Console](https://developers.line.biz/)
- 建立 Provider → 建立 Messaging API Channel
- 取得 **Channel Access Token**
- 在 n8n 的 HTTP Request 節點中，設定 Authorization: `Bearer {YOUR_TOKEN}`

#### 4. 在 POS 系統設定 Webhook
- 開啟 POS → 點擊「設定」頁
- 在「n8n Webhook URL」欄位填入從 n8n 複製的 URL
- 點擊「儲存設定」

完成後，每次結帳會自動：
1. 推送訂單資料到 n8n
2. 寫入 Google Sheets
3. 如有 LINE ID，發送訂單確認訊息

---

## 四、Webhook 資料格式

POS 結帳後，自動 POST 以下 JSON 到你的 n8n Webhook：

```json
{
  "orderId": "20260505-183000",
  "createdAt": "2026-05-05 18:30:00",
  "customer": {
    "name": "王小明",
    "phone": "0912345678",
    "lineId": "U1234567890abcdef"
  },
  "items": [
    {
      "productId": 1,
      "name": "冷拌麻油腰子",
      "qty": 1,
      "price": 150,
      "subtotal": 150
    }
  ],
  "paymentMethod": "cash",
  "total": 150,
  "note": "少辣"
}
```

---

## 五、Google Sheets 欄位設計

| 欄位名稱 | 說明 | 範例 |
|---------|------|------|
| 訂單編號 | 唯一訂單號 | 20260505-183000 |
| 時間 | 結帳時間 | 2026-05-05 18:30:00 |
| 顧客姓名 | 顧客姓名 | 王小明 |
| 電話 | 顧客電話 | 0912345678 |
| LINE ID | LINE User ID | U1234... |
| 商品明細 | 商品列表（換行分隔）| 冷拌麻油腰子 x1 = NT$150 |
| 付款方式 | 付款方式 | 現金 |
| 總金額 | 訂單總額 | 150 |
| 備註 | 訂單備註 | 少辣 |

---

## 六、LINE 訊息格式

顧客收到的訊息：

```
🍱 感謝您的購買！
以下是您的訂單明細：

📋 訂單編號：20260505-183000
⏰ 時間：2026-05-05 18:30:00

─────────────
▸ 冷拌麻油腰子  x1  NT$150
▸ 珍珠奶茶  x1  NT$50
─────────────
💳 付款方式：現金
💰 總計：NT$200
📝 備註：少辣

歡迎再次光臨！😊
```

---

## 七、雲端部署（Railway / Render）

### Railway 部署
```bash
# 1. 安裝 Railway CLI
npm install -g @railway/cli

# 2. 登入並部署
railway login
railway init
railway up

# 3. 設定環境變數
railway env set PORT=5000
```

### Render 部署
1. 在 Render.com 建立 Web Service
2. 連接 GitHub 倉庫
3. Build Command: `npm install`
4. Start Command: `npm start`
5. 環境變數：`PORT=10000`

---

## 八、測試方式

### 基本 API 測試
```bash
# 健康檢查
curl http://localhost:5000/api/health

# 取得商品
curl http://localhost:5000/api/products

# 新增商品
curl -X POST http://localhost:5000/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"炒米粉","category":"主食","price":80}'

# 結帳（模擬）
curl -X POST http://localhost:5000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"productId":1,"name":"冷拌麻油腰子","price":150,"qty":1,"subtotal":150}],
    "payment_method": "cash",
    "customer_name": "測試顧客",
    "customer_phone": "0911111111"
  }'

# 今日統計
curl http://localhost:5000/api/stats/today
```

### Webhook 測試
```bash
# 手動觸發 Webhook（替換 ORDER_ID）
curl -X POST http://localhost:5000/api/orders/webhook-test/ORDER_ID
```

### 模擬 n8n Webhook 接收
```bash
curl -X POST http://localhost:5000/webhook/n8n \
  -H "Content-Type: application/json" \
  -d '{"test": "hello from n8n"}'
```

---

## 九、熱感印表機接口

預留接口位於 `routes/orders.js` 的 `sendWebhook` 函式。
未來可在此加入 ESC/POS 指令輸出：

```javascript
// 熱感印表機（未來擴充）
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const printer = new ThermalPrinter({
  type: PrinterTypes.EPSON,
  interface: 'tcp://192.168.1.100:9100'
});
// printer.println(order.order_number);
// printer.cut();
// printer.execute();
```

---

## 十、系統需求

- Node.js 18 或以上
- 記憶體：最低 256MB
- 儲存：100MB 以上
- 瀏覽器：Chrome / Safari / Edge（平板友善）

## 十一、資料備份／搬家 JSON 上傳大小上限（fix18-10-hotfix29-C2）

`POST /api/migration/import/preview` 與 `POST /api/migration/import` 這兩條「資料備份／搬家」匯入路由，body size 上限可透過環境變數調整，不需要改程式碼：

```bash
# 預設 25MB，最低 1MB，最高硬性上限 100MB
# 未設定、或設定成非數字／超出範圍的值時，一律回退為預設值 25MB
MIGRATION_UPLOAD_LIMIT_MB=25
```

此設定只影響上述兩條搬家路由，**不影響**全站其他 API（仍固定 5MB）。目前的搬家 JSON 上限判斷、實際運算規則見 `utils/migrationUploadLimit.js`；前端可呼叫 `GET /api/migration/config` 取得目前實際生效的上限值與支援的副檔名，不需要把數字寫死在前端。

### Zeabur 部署設定方式

1. 進入 Zeabur 專案
2. 選擇對應的 Service
3. 進入 **Variables**
4. 新增變數 `MIGRATION_UPLOAD_LIMIT_MB`，值設定為例如 `25`（或依需求調整，最高 `100`）
5. 儲存後 **Redeploy**（重新部署／重新啟動服務）

> ⚠️ 修改環境變數後，通常需要重新部署或重新啟動服務才會生效；改完變數但沒有重啟，程式仍會沿用啟動當下讀到的舊值。

### 已知限制：上游 Proxy 層限制

應用程式層（Express／body-parser）已支援可設定的上限（預設 25MB）。但 Zeabur 平台本身或其上游 reverse proxy／CDN，若另外設有更低的 body size 限制，仍可能在請求抵達 Node.js process 之前就先回應 413 —— 這屬於平台層設定，無法從應用程式程式碼層面確認或覆蓋，需要在實際部署環境用真實大小的搬家檔案（例如 9.92MB）實測才能確認。

## 十二、Geo Intelligence — 全台行政區智慧分析（fix18-10-hotfix30-B5-R5.2-A）

自 `fix18-10-hotfix30-B5-R5.2-A` 起，Geo Analytics 全面支援全台 22 縣市／
368 鄉鎮市區（不只六都、不只桃園），核心模組：

- **行政區 Dataset**：`data/taiwan-administrative-areas.json` +
  `data/taiwan-administrative-areas.manifest.json`（來源、抓取日期、
  SHA-256 checksum，見 manifest 內 `notes` 欄位完整說明）。
- **County Code / Subdivision Code**：`utils/taiwanGeoNormalize.js` 提供
  `resolveTaiwanAdministrativeArea()`、`normalizeCounty()`、
  `normalizeSubdivision()`，把中文全形／台臺別名／英文名稱一律正規化成
  官方縣市代碼（`county_code`）與鄉鎮市區代碼（`subdivision_code`）。
- **Overview / Funnel / Fulfillment**：`GET /api/analytics/geo/overview`、
  `/funnel`、`/fulfillment` 皆支援 `county_code`／`subdivision_code`
  篩選，篩選後所有統計數字（不只是清單）都會一併重新計算。
- **Alerts**：`GET /api/analytics/geo/alerts` 同時包含「進站來源」
  （acquisition，例如 `traffic_waste`）與「履約」（fulfillment，例如
  `delivery_cost_risk`）兩種類型的警示，每筆明確標記
  `geo_context`，兩者不會互相覆蓋。
- **Store Isolation**：所有 Geo API 皆已驗證跨店隔離，一家店永遠看不到另一
  家店的資料。
- **Business Area（商圈）**：`analytics_events` / `orders` 已預留
  `business_area_code` / `business_area_name` 欄位（nullable，預設
  NULL），**目前尚未正式啟用**——沒有 writer、沒有 reader、沒有 API、
  沒有 UI，只是先佔位避免未來版本需要破壞性 migration。

完整功能清單、API 支援矩陣、已知限制見：

- `docs/R5.2-A-completion.md`（完整驗收文件）
- `docs/RC1-release-notes.md`（RC1 封版說明）


