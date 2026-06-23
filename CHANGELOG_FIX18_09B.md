# fix18-09B — 折扣追蹤強化

## 版本：fix18-09B
## 基底：fix18-09

---

## 新增功能

### 需求一：訂單列表折扣拆分顯示
- `renderOrdersTable()` 和 `renderDeliveryTable()` 金額欄改為三行顯示：
  - 原價 NT$xxx
  - 💸 -NT$xxx（折扣）
  - **NT$xxx**（實收，橘色大字）
- 無折扣訂單只顯示實收金額（不變）

### 需求二：折扣分類標籤
- 有折扣訂單在金額欄下方顯示彩色分類標籤：
  - 🟢 商品活動、🔵 廣告行銷、🟠 客訴補償、🟣 老客優惠、⚫ 員工親友、🟡 平台活動、⚪ 其他

### 需求三：折扣快速篩選列
- 訂單頁新增篩選 bar（`#discountFilterBar`）：全部 / 有折扣 / 無折扣 / 各分類
- 切換分頁（全部/內用外帶/外送）時自動重置為「全部」
- 篩選不重新呼叫 API，從快取 `_allOrdersCache` 過濾（效能優化）
- 篩選狀態存於 `currentDiscountFilter`

### 需求四：折扣支出卡顯示筆數
- 折扣支出卡各分類列顯示金額 + 筆數
- 格式：`商品活動 | -NT$3870 | 12筆`

### 需求五：折扣支出分類可點擊
- 各分類列可點擊，直接套用該分類篩選並刷新列表

### 需求六：折扣明細彈窗
- 折扣支出卡右上角加「📄 查看明細」按鈕
- 開啟 Modal 顯示：日期 / 訂單編號 / 原價 / 折扣 / 實收 / 分類 / 備註

### 需求七：折扣排行榜
- 新增「📉 折扣最多商品 TOP10」統計卡
- 依折扣分配比例計算各商品被折扣金額及筆數

### 需求八：高折扣警示
- 單筆折扣 ≥ 原價 50% 時顯示 `⚠ 高折扣`（紅色小字）
- 適用於訂單列表及折扣明細彈窗

### 需求九：折扣修改紀錄
- 已於 fix18-09 實作（`showOrderDetail()` 顯示 discount_category / discount_note 變更）
- fix18-09B 不重複新增

---

## 修改檔案清單

| 檔案 | 說明 |
|---|---|
| `public/js/app.js` | 新增 `applyDiscountFilter()`、`setDiscountFilter()`、`openDiscountDetail()`、`closeDiscountDetail()`、`renderDiscountTopProducts()`；更新 `renderStatCards()`、`renderOrdersTable()`、`renderDeliveryTable()`、`loadOrders()`、`loadDeliveryReport()`、`switchOrderTab()` |
| `public/index.html` | 新增折扣篩選列 `#discountFilterBar`、折扣明細 Modal `#discountDetailModal` |
| `public/css/main.css` | 新增 `.disc-filter-btn`、`.disc-badge`、`.disc-badge-*`、`.high-discount-warn`、`.stat-card-clickable` |
| `CHANGELOG_FIX18_09B.md` | 本文件 |

## 相容性

- ✅ fix18-07：`currentOrderView` / `refreshCurrentOrderView()` 完整保留
- ✅ fix18-08：平台來源修改、抽成率設定完整保留
- ✅ fix18-09：日期補登、折扣分類、折扣統計完整保留
- 篩選為前端 in-memory 過濾，不影響後端 API
