# fix18-09D-hotfix — 折扣活動設定頁覆蓋問題修正

## 問題
fix18-09D 部署後，進入「設定 → 折扣活動」再切換至其他頁面（訂單紀錄、LINE 商品等），
折扣活動列表殘留在畫面上方覆蓋其他頁面。

## 根本原因
`stab-discount_campaigns` Panel 被插入在 `page-settings` 容器（`#page-settings`）**外面**。

當 `showPage()` 隱藏所有 `.page` 時，`page-settings` 被隱藏，
但 Panel 因為不在 `page-settings` 內所以不跟著隱藏，繼續顯示在畫面上。

## 修正內容

### 1. index.html — Panel 移回正確位置
- 將 `<div id="stab-discount_campaigns">` 移入 `#page-settings > .page-inner` 內
- 確認具有 `class="settings-tab-panel"` 與 `style="display:none"` 初始狀態

### 2. app.js — showPage() 加入防護
```js
// fix18-09D-hotfix: 離開 settings 頁時強制隱藏所有 settings-tab-panel
if (name !== 'settings') {
  document.querySelectorAll('.settings-tab-panel').forEach(p => {
    p.style.display       = 'none';
    p.style.visibility    = 'hidden';
    p.style.pointerEvents = 'none';
  });
}
```

## 驗證
- 進入 設定→折扣活動 → 切到訂單紀錄：折扣活動列表不殘留 ✅
- 進入 設定→折扣活動 → 切到 LINE 商品：不覆蓋 ✅
- 重新進入 設定→折扣活動：正常顯示 ✅
- 新增/編輯 Modal 正常 ✅
- node --check 全部 OK ✅
