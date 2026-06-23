# fix18-09C — 折扣設定中心＋上月查詢＋商品級折扣標註

## 版本
fix18-09C（基於 fix18-09B）

## 新增功能

### 需求一：折扣活動設定中心
- 設定中心新增「💸 折扣活動」頁籤
- 預設活動：買一送一、套餐折扣、第二件半價、五星評論送毛豆、會員折扣、老客優惠、平台活動、其他
- 商家可：新增、修改名稱/說明、啟用/停用
- 資料表：`discount_campaigns`（store_id, name, description, enabled, sort_order）
- API：`GET/POST /api/discount-campaigns`、`PUT/DELETE /api/discount-campaigns/:id`

### 需求二：日期快捷「上月」
- 日期快捷列新增「上月」按鈕（今日｜昨日｜本週｜本月｜**上月**｜自訂）
- 自動計算：上月第一天 ～ 上月最後一天
- 適用：全部訂單、內用外帶、外送報表、老闆儀表板

### 需求三：折扣活動欄位
- 修改訂單視窗新增「折扣活動」下拉選單（來源：discount_campaigns）
- 儲存欄位：`discount_campaign_id`、`discount_campaign_name`
- 向下相容：舊訂單無活動 → 顯示「其他」

### 需求四：折扣商品欄位
- 修改訂單視窗新增「折扣套用商品」選項
  - 整張訂單：`discount_target_type = 'order'`
  - 指定商品：顯示商品下拉，儲存 `discount_product_id`、`discount_product_name`
- 向下相容：舊訂單 → 自動視為「整張訂單」

### 需求五：折扣備註升級
- 修改訂單視窗：折扣活動 + 折扣商品 + 備註三欄並列

### 需求六：折扣支出卡升級
- 折扣明細彈窗新增「折扣活動」、「折扣商品」欄，改為：日期｜訂單編號｜折扣活動｜折扣商品｜折扣金額｜分類｜備註

### 需求七：折扣排行榜升級
- 統計卡新增「🏆 折扣活動排行」卡片（TOP3 預覽 + 查看 TOP10 按鈕）
- 折扣商品 TOP10 升級（優先使用 discount_product_name 直接歸屬，舊資料平攤）
- 新增折扣活動 TOP10 Modal

### 需求八：訂單列表顯示活動與商品
- 折扣欄新增：🎯 活動名稱 + 📦 折扣商品（若有指定）

### 需求九：修改紀錄 Log
- 修改訂單 Log 增加：折扣活動變更、折扣商品變更

### 需求十：向下相容
- `discount_campaign_id` 不存在 → 視為「其他」
- `discount_product_id` 不存在 → 視為「整張訂單」
- 不重建資料庫，不清空訂單，不刪除歷史資料

## 技術細節
- 所有新欄位透過 `ALTER TABLE ... ADD COLUMN`（safeAdd）安全新增
- `discount_campaigns` 表透過 `CREATE TABLE IF NOT EXISTS` 初始建立
- 前端全域快取 `allDiscountCampaigns`，`openEditOrder` 時自動重載
