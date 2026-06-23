# fix18-09E — 折扣分類整合 + 報表卡片顯示控制

## 新增功能

### 一、折扣分類設定（discount_categories）
- 設定中心 → 💸 折扣活動 分頁整合兩個區塊：
  - 上半部：🏷️ 折扣分類設定
  - 下半部：💸 折扣活動設定
- 新增 `routes/discount-categories.js` API（CRUD）
- 新增 `discount_categories` DB 資料表（自動建立 + seed 預設分類）
- 預設分類：商品活動、廣告行銷、客訴補償、老客優惠、員工親友、平台活動、其他
- 可操作：新增、編輯、停用、排序、刪除
- 新增分類 Modal（categoryEditModal）

### 二、折扣分類動態化（不再寫死）
- `DISCOUNT_CATEGORY_DISPLAY` 改為 Proxy，優先讀取 `allDiscountCategories`
- `normalizeDiscountCategory` 支援動態 code
- 訂單頁快速篩選列（discountFilterBar）動態渲染分類按鈕
- 修改訂單 Modal 折扣分類下拉（editDiscountCategory）動態渲染
- 折扣支出卡、折扣明細 Modal、折扣統計均使用動態分類
- 若 API 無資料，fallback 預設分類

### 三、報表卡片顯示 / 隱藏控制（👁 顯示設定）
- 訂單頁統計卡上方右側加入「👁 顯示設定」按鈕
- 點擊開啟 cardVisibilityModal
- 可勾選顯示/隱藏 12 個卡片：
  訂單數、原價營業額、折扣總額、實收營業額、平均客單價、平台抽成、
  店家實收、熱賣商品、折扣支出、折扣商品排行、折扣活動排行、外送平台卡片
- 設定保存至 localStorage key: `orders_report_visible_cards`
- 重新整理頁面後設定保留

### 四、快速模式
- 顯示設定 Modal 內「全部顯示」/「精簡模式」按鈕
- 精簡模式只顯示：訂單數、實收營業額、平均客單價、折扣總額、平台抽成、店家實收

## 相容性保證
- fix18-07 分頁停留 ✅
- fix18-08 平台來源修改 ✅
- fix18-09 日期補登 ✅
- fix18-09B 折扣追蹤 ✅
- fix18-09C 折扣活動與上月 ✅
- fix18-09D 多商品折扣 ✅
- fix18-09D-hotfix 設定頁不覆蓋其他頁面 ✅
