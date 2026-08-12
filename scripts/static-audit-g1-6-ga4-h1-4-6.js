#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-6.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW
//
// Production Modified 本輪範圍（string-match against real files on disk）：
//   public/js/product-detail-modal.js — 新增：共用商品詳情 Modal 元件
//   public/css/product-detail-modal.css — 新增：對應樣式
//   public/line-order.html            — LINE 外帶／外送：接入商品詳情、view_item
//   public/line-shipping.html         — 宅配：接入商品詳情、view_item
//   public/js/analytics-platforms.js  — GA4_EVENT_MAP 新增 view_item
//   utils/analyticsLog.js             — EVENT_WHITELIST 新增 view_item
//
// 這份 static audit 只驗證「字面事實」（檔案是否存在對應的呼叫關係／事件契約／
// 沒有繞過既有規則），真正的互動行為由 run-g1-6-ga4-h1-4-6-runtime.js 用真實
// jsdom 執行驗證，兩者互補、不重疊。

'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ════════════════════════════════════════════════════════════════
// Group 0：新檔案確實存在（不是宣稱存在）
// ════════════════════════════════════════════════════════════════
check('[存在] public/js/product-detail-modal.js', exists('public/js/product-detail-modal.js'));
check('[存在] public/css/product-detail-modal.css', exists('public/css/product-detail-modal.css'));

const modalJs = read('public/js/product-detail-modal.js');
const modalCss = read('public/css/product-detail-modal.css');
const lineOrder = read('public/line-order.html');
const lineShipping = read('public/line-shipping.html');
const platforms = read('public/js/analytics-platforms.js');
const analyticsLog = read('utils/analyticsLog.js');

// ════════════════════════════════════════════════════════════════
// Group 1：兩個顧客端頁面共用同一份元件（不是各自複製一套）
// ════════════════════════════════════════════════════════════════
check('[line-order.html] 載入共用 product-detail-modal.css', lineOrder.includes('/css/product-detail-modal.css'));
check('[line-order.html] 載入共用 product-detail-modal.js', lineOrder.includes('/js/product-detail-modal.js'));
check('[line-shipping.html] 載入共用 product-detail-modal.css', lineShipping.includes('/css/product-detail-modal.css'));
check('[line-shipping.html] 載入共用 product-detail-modal.js', lineShipping.includes('/js/product-detail-modal.js'));
check('[line-order.html] 沒有內嵌第二份 ProductDetailModal 實作（只透過 <script src> 載入共用檔案）',
  !/global\.ProductDetailModal\s*=/.test(lineOrder));
check('[line-shipping.html] 沒有內嵌第二份 ProductDetailModal 實作（只透過 <script src> 載入共用檔案）',
  !/global\.ProductDetailModal\s*=/.test(lineShipping));
check('[product-detail-modal.js] 只有一份 window.ProductDetailModal 匯出（沒有重複定義）',
  (modalJs.match(/global\.ProductDetailModal\s*=/g) || []).length === 1);

// ════════════════════════════════════════════════════════════════
// Group 2：LINE 外帶／外送共用同一套商品卡與購物車（既有架構，本輪未破壞）
// ════════════════════════════════════════════════════════════════
check('[line-order.html] 外帶/外送仍是同一個 line-order.html（同一份 buildCard()），不是兩個檔案',
  (lineOrder.match(/function buildCard\(/g) || []).length === 1);
check('[line-order.html] openProductDetail() 沿用 getProductAvailableModes()（與 buildCard() 同一套可購買判斷，不自建第二套規則）',
  /function openProductDetail\(/.test(lineOrder) && /openProductDetail[\s\S]{0,600}getProductAvailableModes\(p\)/.test(lineOrder));

// ════════════════════════════════════════════════════════════════
// Group 3：商品卡點擊行為（點卡片/圖片/名稱開詳情；快速加入不觸發 Modal）
// ════════════════════════════════════════════════════════════════
check('[line-order.html] 商品卡綁定 onProdCardClick（點擊卡片主要區域可開啟詳情）',
  /onclick="onProdCardClick\(event,\$\{p\.id\}\)"/.test(lineOrder));
check('[line-order.html] onProdCardClick 對 .qty-ctrl/.add-btn 做 closest() 判斷，避免快速加入冒泡誤開 Modal',
  /function onProdCardClick[\s\S]{0,300}closest\('\.qty-ctrl, \.add-btn'\)/.test(lineOrder));
check('[line-order.html] 商品卡支援鍵盤 Enter/Space 開啟詳情（onProdCardKeydown + tabindex）',
  /onProdCardKeydown/.test(lineOrder) && /tabindex="0"/.test(lineOrder));
check('[line-shipping.html] 商品卡用容器層級 delegation 綁定商品詳情開啟（_bindProdCardDetailOpen）',
  /_bindProdCardDetailOpen/.test(lineShipping));
check('[line-shipping.html] 詳情開啟 delegation 對 .qty-btn 做 closest() 排除，避免與快速加入衝突',
  /_bindProdCardDetailOpen[\s\S]{0,600}closest\('\.qty-btn'\)/.test(lineShipping));
check('[line-shipping.html] 商品卡支援鍵盤 Enter/Space 開啟詳情',
  /e\.key !== 'Enter' && e\.key !== ' '/.test(lineShipping) && /tabindex="0"/.test(lineShipping));

// ════════════════════════════════════════════════════════════════
// Group 4：加入購物車呼叫既有正式 helper，不建立第二套購物車邏輯
// ════════════════════════════════════════════════════════════════
check('[line-order.html] Modal 加入購物車呼叫既有 addCart()（不是自建的加入邏輯）',
  /openProductDetail[\s\S]{0,4000}for \(let i = 0; i < qty; i\+\+\) addCart\(id\)/.test(lineOrder));
check('[line-shipping.html] Modal 加入購物車呼叫既有 changeQty()（不是自建的加入邏輯）',
  /openProductDetail[\s\S]{0,900}changeQty\(pid, qty\)/.test(lineShipping));
check('[product-detail-modal.js] 元件本身不含任何 fetch(\'/api 呼叫（不自建第二套商品資料來源，一律吃呼叫端傳入的物件）',
  !/fetch\(['"`]\/api/.test(modalJs));
check('[product-detail-modal.js] 元件本身不含任何價格計算之外的金額運算字串（不重建計價公式，只用 price*qty）',
  /price \* .*qty|Number\(s\.product\.price\) \* s\.qty/.test(modalJs));

// ════════════════════════════════════════════════════════════════
// Group 5：不繞過既有販售限制（售完／販售時間／預約明日）
// ════════════════════════════════════════════════════════════════
check('[line-order.html] openProductDetail() 有計算 blocked（依既有 isSoldOut/canPreorderNextDay/quota 邏輯，不允許一律可加入）',
  /const blocked = \(isSoldOut && !canPreorderNextDay\) \|\| quotaRealSoldOut \|\| preorderFullBlocked/.test(lineOrder));
check('[line-shipping.html] openProductDetail() 依 quota_remaining 計算 blocked（沿用既有售完欄位）',
  /const soldOut = p\.quota_remaining !== null[\s\S]{0,60}p\.quota_remaining <= 0/.test(lineShipping));
check('[product-detail-modal.js] blocked 商品的加入按鈕會 disabled，且不綁加入事件（第二層防呆，與呼叫端邏輯互補）',
  /disabled.*s\.product\.blocked|s\.product\.blocked \? 'disabled'/.test(modalJs));

// ════════════════════════════════════════════════════════════════
// Group 6：無圖片／無介紹安全 fallback（不破圖、不留 undefined/null）
// ════════════════════════════════════════════════════════════════
check('[product-detail-modal.js] 沒有圖片時使用 placeholder（pdm-ph），不是空字串或破圖 <img src="">',
  /pdm-img-wrap pdm-ph/.test(modalJs));
check('[product-detail-modal.js] <img> 有 onerror fallback，避免圖片載入失敗時破圖',
  /onerror="this\.closest/.test(modalJs));
check('[product-detail-modal.js] 沒有介紹時隱藏介紹區塊（不渲染 pdm-desc），不是顯示 undefined/null 字串',
  /descText \? '<p class="pdm-desc">/.test(modalJs) && !/\$\{p\.description\}/.test(modalJs));

// ════════════════════════════════════════════════════════════════
// Group 7：Modal UI 要求（bottom sheet／桌機置中／捲動鎖定／關閉方式）
// ════════════════════════════════════════════════════════════════
check('[product-detail-modal.css] 手機版從底部開啟（fixed + bottom:0 + transform translateY）',
  /\.pdm-sheet\{[\s\S]{0,200}bottom:0[\s\S]{0,300}transform:translateY\(100%\)/.test(modalCss));
check('[product-detail-modal.css] 桌機版（min-width:768px）置中顯示，不是沿用手機版 bottom sheet',
  /@media \(min-width:768px\)\{[\s\S]{0,400}\.pdm-sheet\{/.test(modalCss));
check('[product-detail-modal.css] 圖片使用 object-fit（不拉伸變形）',
  /object-fit:cover/.test(modalCss));
check('[product-detail-modal.css] 有 iPhone safe-area 支援（env(safe-area-inset-bottom)）',
  /env\(safe-area-inset-bottom/.test(modalCss));
check('[product-detail-modal.css] 開啟時鎖定背景捲動（html.pdm-scroll-lock）',
  /html\.pdm-scroll-lock\{[\s\S]{0,80}overflow:hidden/.test(modalCss));
check('[product-detail-modal.js] 開啟時加上 pdm-scroll-lock class（_lockScroll）',
  /classList\.add\('pdm-scroll-lock'\)/.test(modalJs));
check('[product-detail-modal.js] 關閉時移除 pdm-scroll-lock class 並還原捲動位置（_unlockScroll）',
  /classList\.remove\('pdm-scroll-lock'\)/.test(modalJs) && /window\.scrollTo\(0, _scrollY\)/.test(modalJs));
check('[product-detail-modal.js] 支援點背景遮罩關閉', /e\.target === overlayEl\) close\(\)/.test(modalJs));
check('[product-detail-modal.js] 支援右上角關閉按鈕', /pdm-close/.test(modalJs));
check('[product-detail-modal.js] 支援 Esc 關閉（keydown 監聽 Escape）', /e\.key === 'Escape'/.test(modalJs));
check('[product-detail-modal.js] 有防止快速連點重複加入的節流判斷（300ms 內只處理一次）',
  /now - _lastAddClickTs < 300/.test(modalJs));

// ════════════════════════════════════════════════════════════════
// Group 8：固定購物車列（件數／總額／前往結帳）——本輪沿用既有實作，未破壞
// ════════════════════════════════════════════════════════════════
check('[line-order.html] cartBar 顯示商品件數（cartCnt）', /id="cartCnt"/.test(lineOrder));
check('[line-order.html] cartBar 顯示總額（cartBarTotal）', /id="cartBarTotal"/.test(lineOrder));
// H1.4.7 supersession:
// 舊契約：cartBar 點擊進入 openCartSheet() 就代表「前往結帳＝既有結帳流程，
//         未重做」；openCartSheet() 零參數簽名、空購物車時提早 return。
// 新契約：cartBar 點擊仍呼叫 openCartSheet()（結構不變，保留），但
//         openCartSheet() 現在只負責打開「購物車摘要」（第一階段），不代表
//         前往結帳；真正的「前往結帳」是獨立的 #goCheckoutBtn/openCheckoutStep()
//         操作。openCartSheet() 也改為可接受 opts 參數（{step,silent}，供
//         LIFF/Gate 導回恢復第二階段用），舊的零參數簽名斷言在結構上已經
//         過期（不是「還沒重做」，是刻意重做）。
check('[line-order.html] cartBar 點擊仍呼叫既有 openCartSheet()（結構不變，只是語意已改為只開第一階段購物車摘要，不是前往結帳）',
  /id="cartBar"[^>]*onclick="openCartSheet\(\)"/.test(lineOrder));
check('[line-order.html] openCartSheet() 空購物車時提早 return（新簽名 openCartSheet(opts)，opts 供 LIFF 導回使用）',
  /function openCartSheet\(opts\)\{\s*opts=opts\|\|\{\};[\s\S]{0,200}if\(!Object\.keys\(cart\)\.length\)return;/.test(lineOrder));
check('[line-order.html] 點 cartBar 打開的購物車摘要（cartStage）不等於前往結帳——checkoutStage 預設仍是 hidden，onclick="openCartSheet()" 本身不會切換 stage',
  /<div id="checkoutStage" hidden>/.test(lineOrder));
check('[line-shipping.html] cartBar 顯示商品件數（cartCnt）', /id="cartCnt"/.test(lineShipping));
check('[line-shipping.html] cartBar 顯示總額（cartBarTotal）', /id="cartBarTotal"/.test(lineShipping));
check('[line-shipping.html] cartBar 點擊仍呼叫既有 openCartSheet()（結構不變，只是語意已改為只開第一階段購物車摘要，不是前往結帳）',
  /id="cartBar"[^>]*onclick="openCartSheet\(\)"/.test(lineShipping));
check('[line-shipping.html] 點 cartBar 打開的購物車摘要不等於前往結帳——checkoutStage 預設仍是 hidden',
  /<div id="checkoutStage" hidden>/.test(lineShipping));

// ════════════════════════════════════════════════════════════════
// Group 9：Analytics 事件契約——view_product 與 view_item 語意分離
// ════════════════════════════════════════════════════════════════
check('[utils/analyticsLog.js] EVENT_WHITELIST 新增 view_item', /'view_item'/.test(analyticsLog));
check('[analytics-platforms.js] GA4_EVENT_MAP 新增 view_item: \'view_item\'', /view_item:\s*'view_item'/.test(platforms));
check('[analytics-platforms.js] META_EVENT_MAP 沒有被本輪修改新增 view_item（不擅自更動既有 Meta Pixel 語意）',
  (() => {
    const m = platforms.match(/const META_EVENT_MAP = \{[\s\S]*?\};/);
    return !!m && !/view_item/.test(m[0]);
  })());
check('[line-order.html] view_product 的 IntersectionObserver 呼叫點沒有被改成 view_item（清單曝光語意不變）',
  /_trackEvent\('view_product',\{product_id:Number\(pid\)\}\)/.test(lineOrder));
check('[line-shipping.html] view_product 的 IntersectionObserver 呼叫點沒有被改成 view_item',
  /_trackEvent\('view_product',\{product_id:Number\(pid\)\}\)/.test(lineShipping));
check('[line-order.html] view_item 只在 openProductDetail() 的 onOpen callback 內觸發一次（不在 buildCard/render 階段送出）',
  /onOpen: function \(\) \{ _trackViewItem\(p, name, price\); \}/.test(lineOrder) &&
  !/function buildCard[\s\S]*?_trackViewItem/.test(lineOrder.slice(0, lineOrder.indexOf('function openProductDetail'))));
check('[line-shipping.html] view_item 只在 openProductDetail() 的 onOpen callback 內觸發一次',
  /onOpen: function \(\) \{ _trackViewItemShipping\(p\); \}/.test(lineShipping));
check('[line-order.html] _trackViewItem() 的 GA4 items 包含 item_id/item_name/price/quantity',
  /item_id: String\(p\.id\), item_name: name, price: Number\(price\) \|\| 0, quantity: 1/.test(lineOrder));
check('[line-shipping.html] _trackViewItemShipping() 的 GA4 items 包含 item_id/item_name/price/quantity',
  /item_id: String\(p\.id\), item_name: p\.name, price: Number\(p\.price\) \|\| 0, quantity: 1/.test(lineShipping));
check('[line-order.html] 快速加入 addCart()/chgQty() 沒有呼叫 _trackViewItem（快速加入不假送 view_item）',
  !/function addCart[\s\S]{0,3000}_trackViewItem/.test(lineOrder) && !/function chgQty[\s\S]{0,2000}_trackViewItem/.test(lineOrder));
check('[line-order.html] _trackEvent() 通用分派會把 extra.items 帶入 GA4 payload（view_item 需要完整 items 陣列）',
  /if \(extra && extra\.items\) pp\.items = extra\.items;/.test(lineOrder));
check('[line-shipping.html] _trackEvent() 通用分派會把 extra.items 帶入 GA4 payload',
  /if \(extra && extra\.items\) pp\.items = extra\.items;/.test(lineShipping));

// ════════════════════════════════════════════════════════════════
// Group 10：begin_checkout / add_to_cart 語意未被重做
// ════════════════════════════════════════════════════════════════
// H1.4.7 supersession:
// 舊契約：begin_checkout 仍只在 openCartSheet()（非空購物車）內、同一
//         cart_id 去重觸發一次。
// 新契約：openCartSheet() 不再觸發 begin_checkout（正式前台已不再送出這個
//         事件，legacy 原始資料保留但不再由新流程產生）；改為觸發
//         view_cart（每次真實打開都記一筆，不是同一 cart_id 永久去重一次）。
//         真正的「開始結帳」事件 checkout_click 由獨立的
//         openCheckoutStep()/前往結帳按鈕觸發，不在 openCartSheet() 內。
check('[line-order.html] openCartSheet() 不再觸發 begin_checkout（整份檔案都沒有任何 _trackEvent(\'begin_checkout\') 呼叫）',
  !/_trackEvent\('begin_checkout'\)/.test(lineOrder));
check('[line-order.html] openCartSheet() 改為觸發 view_cart（打開購物車摘要的正式事件）',
  /function openCartSheet\(opts\)\{[\s\S]{0,900}_trackEvent\('view_cart'/.test(lineOrder));
check('[line-order.html] checkout_click 由獨立的 openCheckoutStep()（前往結帳）觸發，不在 openCartSheet() 內',
  /function openCheckoutStep\(\)\{[\s\S]{0,400}_enterCheckoutStage/.test(lineOrder) && !/function openCartSheet\(opts\)\{[\s\S]{0,2000}_trackEvent\('checkout_click'/.test(lineOrder));
check('[line-shipping.html] openCartSheet() 不再觸發 begin_checkout（整份檔案都沒有任何 _trackEvent(\'begin_checkout\') 呼叫）',
  !/_trackEvent\('begin_checkout'\)/.test(lineShipping));
check('[line-shipping.html] openCartSheet() 改為觸發 view_cart（打開購物車摘要的正式事件）',
  /function openCartSheet\(opts\)\s*\{[\s\S]{0,1200}_trackEvent\('view_cart'/.test(lineShipping));
check('[line-shipping.html] checkout_click 由獨立的 openCheckoutStep()（前往結帳）觸發，不在 openCartSheet() 內',
  /function openCheckoutStep\(\)\s*\{[\s\S]{0,400}_enterCheckoutStage/.test(lineShipping) && !/function openCartSheet\(opts\)\s*\{[\s\S]{0,1060}_trackEvent\('checkout_click'/.test(lineShipping));
check('[line-order.html] add_to_cart 仍由 _trackAddToCart()（真正加入成功後）送出，Modal 沒有繞過它另外送出',
  /function _trackAddToCart/.test(lineOrder) && !/ProductDetailModal[\s\S]{0,50}add_to_cart/.test(lineOrder));

// ════════════════════════════════════════════════════════════════
// Group 11：規格／加料界線——不得虛構前端計價，不誤讀 line_spec
// ════════════════════════════════════════════════════════════════
check('[product-detail-modal.js] 沒有任何實際讀取 options/addons/modifiers 欄位並用於加價運算的程式碼（只在註解中說明「目前不支援」，程式邏輯本身沒有這些欄位）',
  !/product\.(options|addons|modifiers)\b/.test(modalJs) && !/\.addonPrice|\.specPrice|\.modifierPrice/i.test(modalJs));
check('[line-order.html] openProductDetail() 傳給 Modal 的 price 直接來自 effective_line_price/price（不疊加任何規格/加料價差）',
  /const price = Number\(p\.effective_line_price \|\| p\.price\) \|\| 0;/.test(lineOrder));
check('[line-shipping.html] openProductDetail() 傳給 Modal 的 price 直接來自既有 p.price（不疊加任何規格/加料價差）',
  /price: Number\(p\.price\) \|\| 0,/.test(lineShipping));
check('[line-order.html] line_spec（文字型規格，例如"200g"）只用於既有卡片展示，openProductDetail() 沒有把它當成可計價欄位使用',
  !/openProductDetail[\s\S]{0,2600}line_spec[\s\S]{0,50}price/.test(lineOrder));

// ════════════════════════════════════════════════════════════════
// Group 12：後端安全——事件白名單型別驗證未被放寬
// ════════════════════════════════════════════════════════════════
const analyticsRoute = read('routes/analytics.js');
check('[routes/analytics.js] product_id 仍需通過型別/範圍驗證（本輪沒有為了 view_item 放寬驗證）',
  /!Number\.isFinite\(n\) \|\| n <= 0 \|\| !Number\.isInteger\(n\)/.test(analyticsRoute));
check('[routes/analytics.js] purchase 事件仍然被 SERVER_ONLY_EVENTS 或等效機制擋在前台端點之外',
  /purchase/.test(analyticsRoute) && /403/.test(analyticsRoute));

// ── 輸出結果 ──────────────────────────────────────────
const failCount = results.filter(r => !r.pass).length;
results.forEach(r => console.log(`${r.pass ? '✓' : '✗ FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
console.log(`\nPASS: ${results.length - failCount}`);
console.log(`FAIL: ${failCount}`);
console.log(`TOTAL: ${results.length}`);
process.exit(failCount === 0 ? 0 : 1);
