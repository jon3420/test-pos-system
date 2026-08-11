#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-4-view-item-runtime.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.4
//
// 真實載入 Production 檔案（不是重寫一份邏輯來測試自己）：
//   - public/line-order.html   （透過 JSDOM 完整載入，runScripts:'dangerously'）
//   - public/line-shipping.html（同上）
//   - public/js/analytics-platforms.js（由上面兩頁面用 <script src> 真的載入，不是 mock）
//
// 誠實聲明（範圍界線）：
//   - init() 內對 /api/line-shop、/api/line-menu、/api/settings/business-calendar 的
//     網路串接跟這次的 duplicate view_item bug 無關，本測試不驅動整個 init()；而是直接
//     設定 allProducts / categories 這兩個真實模組層變數後呼叫真實的 buildCats() /
//     renderMenu()，這兩個函式、以及它們呼叫的 buildCard() / _setupViewProductObserver()，
//     都是完全沒有被 mock 的 production 函式。
//   - IntersectionObserver 本身 jsdom 不支援真的量測版面位置，所以用一個「忠實轉發」的
//     Fake IntersectionObserver：它不改變任何比對/去重邏輯，只是把 observe() 呼叫記下來，
//     測試程式可以之後手動送出 isIntersecting entries，等同於瀏覽器判斷卡片進入視窗後
//     真正會呼叫的同一個 callback。所有去重（sessionStorage）、送出（_trackEvent）邏輯
//     都是 production 原始碼。
//   - add_to_cart / quantity 的測試透過「真的 dispatch click 事件到 buildCard() 產生的
//     真實 DOM 節點」進行（Category G/H/I），對應使用者真的點擊畫面。
//
// 本輪 Reality Audit 結論（H1.4.4 當時）：目前 codebase 沒有任何 product-detail view 介面，
// 商品卡本身沒有 onclick。Category G 的存在目的是把這件事鎖進 regression：
// 未來如果有人不小心在 buildCard() 加了 onclick，這個測試會抓到。
//
// ── H1.4.6 CHANGELOG（SUPERSEDED，2026）──────────────────────────────────────
// H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW 正式新增了商品詳情 Modal，上面這個「商品卡
// 不應該有 onclick／點擊不應該送 view_item」的假設已經過期。Category G／H／I／K／M
// 已改寫為驗證新契約：「點擊卡片主體＝合法開啟商品詳情，剛好送 1 次 view_item；
// 清單曝光（Cat A–F）與快速加入購物車（Cat H／I）仍然完全不會送 view_item」。
// 其餘所有斷言（Cat A–F 清單曝光、Cat J ecommerce smoke）完全未被放寬。

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const ROOT = path.join(__dirname, '..');

class LocalLoader extends ResourceLoader {
  fetch(url) {
    try {
      const u = new URL(url);
      const filePath = path.join(ROOT, 'public', u.pathname);
      if (fs.existsSync(filePath)) return Promise.resolve(Buffer.from(fs.readFileSync(filePath)));
    } catch (e) { /* ignore */ }
    return Promise.resolve(Buffer.from(''));
  }
}

// Fake IntersectionObserver：忠實轉發，不改變任何 production 邏輯，只讓測試能手動
// 觸發「這張卡進入視窗」。
function installFakeIntersectionObserver(win) {
  const instances = [];
  win.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = new Set(); instances.push(this); }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    // 測試專用：手動模擬某個元素進入視窗
    fireIntersect(el) { this.cb([{ isIntersecting: true, target: el }]); }
  };
  return instances;
}

function makeFixtureProducts(n) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    arr.push({
      id: i, name: 'Product ' + i, line_name: 'Product ' + i, price: 100 + i, line_price: 100 + i,
      display_cat_id: 0, sale_status: 'available', line_sold_out: 0,
      takeout_sold_out_reason: null, delivery_sold_out_reason: null,
      takeout_can_next_day: false, delivery_can_next_day: false,
      pre_sale_available: false, line_quota: { hasQuota: false }, line_preorder: { hasPreorder: false },
    });
  }
  return arr;
}

const FILE_ORDER_RAW = fs.readFileSync(path.join(ROOT, 'public', 'line-order.html'), 'utf8')
  .replace('\ninit();\nloadGoogleMapsScript();\n', '\n/* H1.4.4 test harness: init()/loadGoogleMapsScript() 的網路 bootstrapping（/api/line-shop 等）\n   跟這次的 view_item duplicate bug 無關，本測試不自動觸發，改由測試程式直接呼叫\n   buildCats()/renderMenu() 等「跟這個 bug 直接相關」的真實 production 函式。除了不自動\n   呼叫 init()/loadGoogleMapsScript() 這一行以外，其餘原始碼完全未修改。 */\n');
const FILE_SHIPPING_RAW = fs.readFileSync(path.join(ROOT, 'public', 'line-shipping.html'), 'utf8')
  .replace(/\ninit\(\);\n/, '\n/* H1.4.4 test harness: 同 line-order.html，不自動呼叫 init()，原因同上。 */\n');

function loadPage(htmlFile) {
  const html = htmlFile === 'line-order.html' ? FILE_ORDER_RAW : FILE_SHIPPING_RAW;
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + htmlFile,
    runScripts: 'dangerously',
    resources: new LocalLoader(),
  });
  const win = dom.window;
  const gtagCalls = [];
  win.gtag = (...args) => gtagCalls.push(args);
  const ioInstances = installFakeIntersectionObserver(win);
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, shop: {}, categories: [], products: [], data: {} }) });
  win.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
  let storage = {}, sstorage = {};
  win.localStorage = { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } };
  win.sessionStorage = { getItem: k => (k in sstorage ? sstorage[k] : null), setItem: (k, v) => { sstorage[k] = String(v); }, removeItem: k => { delete sstorage[k]; } };
  win.alert = () => {};
  win.scrollTo = () => {}; // jsdom 沒有實作真正的版面/捲動；避免 _unlockScroll() 的 Not implemented 噪音
  let threw = null;
  win.addEventListener('error', (e) => { threw = threw || (e.error || e.message); });
  return { win, gtagCalls, ioInstances, getThrown: () => threw };
}

function viewItemCount(gtagCalls) { return gtagCalls.filter(c => c[0] === 'event' && c[1] === 'view_item').length; }
function eventCount(gtagCalls, name) { return gtagCalls.filter(c => c[0] === 'event' && c[1] === name).length; }

// 在頁面共用的 top-level lexical scope 中執行程式碼（classic <script> 標籤之間共享同一個
// let/const scope，跟直接對 window 屬性賦值不同——allProducts 等是 `let` 宣告，
// 不會變成 window 的屬性，必須用真的 <script> 標籤才能正確讀寫）。
function runInPageScope(win, code) {
  const el = win.document.createElement('script');
  el.textContent = code;
  win.document.body.appendChild(el);
}

async function settle() { return new Promise(r => setTimeout(r, 30)); }

async function run() {
  // ══════════════════════════════════════════════════════════════
  // PART 1 — line-order.html
  // ══════════════════════════════════════════════════════════════
  {
    const { win, gtagCalls, ioInstances, getThrown } = loadPage('line-order.html');
    await settle();
    check('line-order.html 載入時沒有 uncaught error', !getThrown(), getThrown() ? String(getThrown().message || getThrown()) : '');

    win.AnalyticsPlatforms.init({ analytics_ga4_enabled: '1', analytics_ga4_measurement_id: 'G-TEST' });
    runInPageScope(win, `allProducts = ${JSON.stringify(makeFixtureProducts(9))}; categories = []; buildCats(); renderMenu();`);
    await settle();

    const io = ioInstances[ioInstances.length - 1];
    check('renderMenu() 後，_setupViewProductObserver 建立了一個 IntersectionObserver 實例', !!io);
    const cards = [...win.document.querySelectorAll('.prod-card[id^="pc-"]')];
    check('renderMenu() 產生 9 張商品卡（.prod-card）', cards.length === 9, `實際=${cards.length}`);

    // Category A — 單張卡片進入 viewport
    io.fireIntersect(cards[0]);
    check('[Cat A] 1 張卡片進入 viewport → GA4 view_item = 0', viewItemCount(gtagCalls) === 0);

    // Category B — 9 張卡片依序進入 viewport（本輪最重要 regression：對應症狀 "1 click → 9 view_item"）
    cards.forEach(c => io.fireIntersect(c));
    check('[Cat B] 9 張卡片全部進入 viewport → GA4 view_item = 0（不是 9）', viewItemCount(gtagCalls) === 0, `實際=${viewItemCount(gtagCalls)}`);
    check('[Cat B] 9 張卡片曝光後，gtag(\'event\', ...) 完全沒有被呼叫過（不是送了又被過濾）', gtagCalls.filter(c => c[0] === 'event').length === 0);

    // Category C — 重新 render 後再曝光一次
    runInPageScope(win, `renderMenu();`);
    await settle();
    const io2 = ioInstances[ioInstances.length - 1];
    const cardsAfterRerender = [...win.document.querySelectorAll('.prod-card[id^="pc-"]')];
    cardsAfterRerender.forEach(c => io2.fireIntersect(c));
    check('[Cat C] 重新 render 後再曝光一次 → view_item 仍 = 0', viewItemCount(gtagCalls) === 0);

    // Category D — 切分類重新 render
    runInPageScope(win, `categories = [{ id: 5, name: '熱門' }]; allProducts.forEach((p, i) => { if (i < 3) p.display_cat_id = 5; }); selectCat('5');`);
    await settle();
    const io3 = ioInstances[ioInstances.length - 1];
    [...win.document.querySelectorAll('.prod-card[id^="pc-"]')].forEach(c => io3.fireIntersect(c));
    check('[Cat D] 切分類重新 render + 曝光 → view_item 仍 = 0', viewItemCount(gtagCalls) === 0);
    runInPageScope(win, `selectCat('all');`);
    await settle();

    // Category F — 模擬「往下滾動，更多卡片進入 viewport」= 對同一批 observer 多次 fire
    const io4 = ioInstances[ioInstances.length - 1];
    const allCardsNow = [...win.document.querySelectorAll('.prod-card[id^="pc-"]')];
    allCardsNow.forEach(c => io4.fireIntersect(c));
    allCardsNow.forEach(c => io4.fireIntersect(c)); // 滾動來回，同一張卡可能被送第二次 intersect
    check('[Cat F] scroll 情境（同批卡片重複進入 viewport） → view_item 仍 = 0', viewItemCount(gtagCalls) === 0);

    // Category G — 點擊商品卡本體
    // ── H1.4.6 CHANGELOG（SUPERSEDED）──────────────────────────────
    // 原始 H1.4.4 假設「目前沒有 product-detail 介面，商品卡沒有 onclick，點擊
    // 卡片不會送出 view_item」。H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW 正式新增了
    // 商品詳情 Modal 後，這個假設不再成立：點擊卡片主要區域「正是」開啟商品
    // 詳情、送出 view_item 的合法途徑（見 public/line-order.html 的
    // onProdCardClick()/openProductDetail()）。新契約驗證的重點從「完全不送」
    // 改成「只在使用者真的點擊卡片主體時，剛好送一次，且是透過正式的
    // openProductDetail() → ProductDetailModal.open() → onOpen 路徑，不是清單
    // 曝光（IntersectionObserver／Category A–F）意外觸發的」。
    const viewItemBeforeCardClick = viewItemCount(gtagCalls);
    const cardToClick = win.document.getElementById('pc-1');
    check('[Cat G→H1.4.6 SUPERSEDED] .prod-card 現在「應該」有 onclick 屬性（H1.4.6 商品詳情：點擊卡片主體開啟詳情，取代 H1.4.4「沒有隱形 view 觸發」假設）',
      cardToClick.hasAttribute('onclick'));
    cardToClick.dispatchEvent(new win.Event('click', { bubbles: true }));
    await settle();
    check('[Cat G→H1.4.6 SUPERSEDED] 點擊商品卡本體會開啟商品詳情並剛好送出 1 次 view_item（不是 0 次也不是多次）——取代 H1.4.4「完全不送」舊契約',
      viewItemCount(gtagCalls) === viewItemBeforeCardClick + 1,
      `before=${viewItemBeforeCardClick} after=${viewItemCount(gtagCalls)}`);
    check('[Cat G] Modal 確實真的開啟了（window.ProductDetailModal.isOpen()===true），不是誤判/假送事件',
      win.ProductDetailModal && win.ProductDetailModal.isOpen() === true);
    win.ProductDetailModal.close();
    const viewItemAfterCardClick = viewItemCount(gtagCalls);

    // Category H — add_to_cart：呼叫真實的 _trackAddToCart()（addCart() 成功路徑最終呼叫的同一個函式）
    const beforeAdd = eventCount(gtagCalls, 'add_to_cart');
    win._trackAddToCart(1, 1);
    check('[Cat H] add_to_cart 觸發 → GA4 add_to_cart +1', eventCount(gtagCalls, 'add_to_cart') === beforeAdd + 1);
    check('[Cat H→H1.4.6 SUPERSEDED] add_to_cart 觸發後 view_item 計數不變（快速加入購物車不會假送 view_item，只是基準值不再是絕對 0，而是 Cat G 開啟詳情後的計數）',
      viewItemCount(gtagCalls) === viewItemAfterCardClick);

    // Category I — 數量按鈕（quantity）：chgQty 內部同樣呼叫 _trackAddToCart/_trackRemoveFromCart，
    // 不應觸發 view_item。這裡直接呼叫 _trackRemoveFromCart 驗證對稱的一半。
    win._trackRemoveFromCart(1, 1);
    check('[Cat I→H1.4.6 SUPERSEDED] remove_from_cart（對應數量 "-"）不會觸發 view_item（基準值同上，改為相對 Cat G 之後不變，不是絕對 0）',
      viewItemCount(gtagCalls) === viewItemAfterCardClick);

    // Category J — 既有 ecommerce smoke：begin_checkout / purchase 不受影響
    win.AnalyticsPlatforms.trackPlatformEvent('begin_checkout', {});
    win.AnalyticsPlatforms.trackPlatformEvent('purchase', { transaction_id: 'ORDX', value: 100, items: [{ item_id: '1', item_name: 'A', price: 100, quantity: 1 }] });
    check('[Cat J] begin_checkout 正常送出 1 次', eventCount(gtagCalls, 'begin_checkout') === 1);
    check('[Cat J] purchase 正常送出 1 次', eventCount(gtagCalls, 'purchase') === 1);

    // Category K — mapping contract 直接驗證（跟 static audit 互補，這裡驗證「真實載入後」的行為）
    check('[Cat K→H1.4.6 SUPERSEDED] 完整跑完 A–J 全部情境後，累積 view_item 總次數恰好 = 1（只來自 Cat G 那一次真實點擊開啟詳情，A–F 清單曝光/H–I 快速加入都沒有額外貢獻）',
      viewItemCount(gtagCalls) === 1, `實際=${viewItemCount(gtagCalls)}`);

    // Category M — Init Idempotence：重複 init + 重複建立 observer，不應讓 view_product 變成 view_item
    const viewItemBeforeM = viewItemCount(gtagCalls);
    for (let i = 0; i < 3; i++) win.AnalyticsPlatforms.init({ analytics_ga4_enabled: '1', analytics_ga4_measurement_id: 'G-TEST' });
    win.renderMenu();
    await settle();
    const ioLast = ioInstances[ioInstances.length - 1];
    [...win.document.querySelectorAll('.prod-card[id^="pc-"]')].forEach(c => ioLast.fireIntersect(c));
    check('[Cat M→H1.4.6 SUPERSEDED] 重複 init() 3 次 + 重新 render + 清單曝光（IntersectionObserver）→ view_item 計數不變（清單曝光永遠只送 view_product，不會因重複 init 或重繪變成 view_item；基準值改為 Cat G 之後的計數，不是絕對 0）',
      viewItemCount(gtagCalls) === viewItemBeforeM);
  }

  // ══════════════════════════════════════════════════════════════
  // PART 2 — line-shipping.html（同一套 analytics-platforms.js，獨立頁面驗證）
  // ══════════════════════════════════════════════════════════════
  {
    const { win, gtagCalls, ioInstances, getThrown } = loadPage('line-shipping.html');
    await settle();
    check('line-shipping.html 載入時沒有 uncaught error', !getThrown(), getThrown() ? String(getThrown().message || getThrown()) : '');

    win.AnalyticsPlatforms.init({ analytics_ga4_enabled: '1', analytics_ga4_measurement_id: 'G-TEST' });
    // H1.4.6：openProductDetail() 需要真的存在的 SHOP_DATA（頁面資料尚未載入完成時的安全
    // guard，見 public/line-shipping.html openProductDetail() 開頭）。SHOP_DATA 是頁面
    // inline <script> 頂層用 `let` 宣告的變數，不是 window 的屬性，必須透過真的 <script>
    // 標籤（runInPageScope）才能正確寫入，直接 win.SHOP_DATA=... 對它沒有作用。
    const shippingFixture = makeFixtureProducts(9).map(p => ({ ...p, image: '', description: '', spec: '', quota_remaining: null }));
    runInPageScope(win, `SHOP_DATA = ${JSON.stringify({ products: shippingFixture, upsell_products: [] })};`);
    win.renderProductGrid('prodGrid', shippingFixture);
    await settle();

    const io = ioInstances[ioInstances.length - 1];
    const cards = [...win.document.querySelectorAll('#prodGrid .prod-card[data-pid]')];
    check('[line-shipping] renderProductGrid 產生 9 張商品卡', cards.length === 9, `實際=${cards.length}`);

    cards.forEach(c => io.fireIntersect(c));
    check('[line-shipping][Cat B] 9 張卡片曝光 → GA4 view_item = 0', viewItemCount(gtagCalls) === 0, `實際=${viewItemCount(gtagCalls)}`);

    // ── H1.4.6 SUPERSEDED（同 PART 1 的 Cat G 說明）：宅配頁現在也有商品詳情，
    // 點擊卡片主體正是合法開啟途徑。
    const viewItemBeforeCardClick = viewItemCount(gtagCalls);
    const cardToClick = cards[0];
    check('[line-shipping][Cat G→H1.4.6 SUPERSEDED] .prod-card 現在「應該」有 tabindex/role（H1.4.6 商品詳情：整卡可點擊/鍵盤開啟，取代「沒有 onclick」舊假設）',
      cardToClick.hasAttribute('tabindex'));
    cardToClick.dispatchEvent(new win.Event('click', { bubbles: true }));
    await settle();
    check('[line-shipping][Cat G→H1.4.6 SUPERSEDED] 點擊商品卡本體會開啟商品詳情並剛好送出 1 次 view_item',
      viewItemCount(gtagCalls) === viewItemBeforeCardClick + 1,
      `before=${viewItemBeforeCardClick} after=${viewItemCount(gtagCalls)}`);
    win.ProductDetailModal.close();
    const viewItemAfterCardClick = viewItemCount(gtagCalls);

    const beforeAdd = eventCount(gtagCalls, 'add_to_cart');
    win._trackEvent('add_to_cart', { product_id: 1, quantity: 1 });
    check('[line-shipping][Cat H→H1.4.6 SUPERSEDED] add_to_cart 觸發 → +1，且不影響 view_item 計數（基準值改為 Cat G 開啟詳情之後，不是絕對 0）',
      eventCount(gtagCalls, 'add_to_cart') === beforeAdd + 1 && viewItemCount(gtagCalls) === viewItemAfterCardClick);
  }

  // ── Report ──────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  console.log(`\nH1.4.4 View Item Semantics Runtime — ${passed}/${total} passed\n`);
  results.forEach(r => console.log(`${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ' — ' + r.detail : ''}`));
  process.exitCode = failed.length ? 1 : 0;
}

run();
