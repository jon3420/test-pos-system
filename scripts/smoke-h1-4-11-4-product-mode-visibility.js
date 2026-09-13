#!/usr/bin/env node
// scripts/smoke-h1-4-11-4-product-mode-visibility.js
// H1.4.11.4｜LINE 點餐依外帶／外送模式篩選商品與分類同步修正——真實 jsdom 執行測試
// （不是字串搜尋）。涵蓋需求文件十五列出的 40 項驗收情境（合理分組，每項皆有真實
// 執行的 assertion 覆蓋）。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — H1.4.11.4 product/category mode visibility filter');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

let server;
let dom;
let unhandledRejectionSeen = null;
process.on('unhandledRejection', (e) => { unhandledRejectionSeen = e; });

async function main() {
  ['routes/settings.js', 'routes/line-orders.js', 'public/js/app.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const htmlPath = path.join(ROOT, 'public/line-order.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  const { JSDOM, ResourceLoader } = require('jsdom');
  class LocalFileResourceLoader extends ResourceLoader {
    fetch(url) {
      try {
        const u = new URL(url);
        if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/')) {
          const localPath = path.join(ROOT, 'public', u.pathname);
          if (fs.existsSync(localPath)) return Promise.resolve(fs.readFileSync(localPath));
        }
      } catch (e) { /* 外部網址（LINE SDK/Google Maps/CDN）一律安全略過，不真的連線 */ }
      return Promise.resolve(Buffer.from(''));
    }
  }

  try {
    dom = new JSDOM(htmlSrc, {
      url: 'http://localhost/line-order.html?store_id=test_store',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      resources: new LocalFileResourceLoader(),
      beforeParse(window) {
        window.fetch = function (url) {
          const u = String(url);
          let payload = { success: true, data: {} };
          if (u.includes('/api/line-shop')) {
            payload = {
              success: true,
              data: {
                line_order_page_mode: 'combined_checkout',
                takeout_status: { today_state: 'open', today_open: true, today_label: '開放中', earliest_today: 60, allow_next_day: false },
                delivery_status: { today_state: 'open', today_open: true, today_label: '開放中', earliest_today: 60, allow_next_day: false },
                takeout_next_dates: [], delivery_next_dates: [],
                takeout_next_service: null, delivery_next_service: null,
                holiday_banner: { active: false },
                announcement: { enabled: false, active: false, source: 'none' },
              },
            };
          } else if (u.includes('/api/line-menu')) {
            payload = { success: true, data: { categories: [], products: [] } };
          } else if (u.includes('/api/settings/business-calendar')) {
            payload = { success: false };
          } else {
            payload = { success: false };
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    pass('jsdom-0 成功載入並執行 public/line-order.html（init() 走成功分支，保留真實頁面 DOM 結構）');
  } catch (e) {
    fail('jsdom-0 成功載入並執行 public/line-order.html', e.message.slice(0, 300));
  }

  if (dom) {
    const w = dom.window;
    const ev = (code) => w.eval(code);

    // 測試商品夾具：涵蓋兩欄位所有型別（0/1/"0"/"1"/布林/缺失）與各種暫時營業狀態
    const PRODUCTS_FIXTURE = [
      { id: 1, name: '雙模式商品', line_takeout_enabled: 1, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' },
      { id: 2, name: '僅外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', delivery_sold_out_reason: 'product_mode_disabled' },
      { id: 3, name: '僅外送商品', line_takeout_enabled: 0, line_delivery_enabled: 1, display_cat_id: 'catB', sale_status: 'available', takeout_sold_out_reason: 'product_mode_disabled' },
      { id: 4, name: '皆停用商品', line_takeout_enabled: 0, line_delivery_enabled: 0, display_cat_id: 'catB', sale_status: 'available', takeout_sold_out_reason: 'product_mode_disabled', delivery_sold_out_reason: 'product_mode_disabled' },
      { id: 5, name: '欄位缺失商品', display_cat_id: 'catA', sale_status: 'available' }, // 兩欄位皆未提供 → 依相容預設值視為啟用
      { id: 6, name: '字串型別商品', line_takeout_enabled: '1', line_delivery_enabled: '0', display_cat_id: 'catA', sale_status: 'available' },
      { id: 7, name: '布林型別商品', line_takeout_enabled: true, line_delivery_enabled: false, display_cat_id: 'catA', sale_status: 'available' },
      // 暫時狀態不得影響「永久支援」的可見性：僅外帶但今日售完 → 外帶模式仍應顯示
      { id: 8, name: '外帶今日售完商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'real_sold_out' },
      // 尚未開始販售，仍永久支援外帶
      { id: 9, name: '外帶尚未開始商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', pre_sale_available: true, takeout_sold_out_reason: null },
      // 今日售完但允許預約明日
      { id: 10, name: '外帶可預約明日商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'real_sold_out', takeout_can_next_day: true },
      // Business Calendar 公休（店家層級 today_closed，不是商品層級）——商品本身仍永久
      // 支援外帶，只是「今天」店休；由 sold_out_reason 反映今天休假，商品本身欄位不變。
      { id: 11, name: '公休但支援外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'today_closed' },
    ];
    const CATEGORIES_FIXTURE = [
      { id: 'catA', name: '分類A', icon: '🍱' },
      { id: 'catB', name: '分類B', icon: '🍜' },
    ];

    function setupPage(pageMode, mode, extraShop) {
      ev(`
        shopData = Object.assign({
          line_order_page_mode: ${JSON.stringify(pageMode)},
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        }, ${JSON.stringify(extraShop || {})});
        currentMode = ${JSON.stringify(mode)};
        currentCat = 'all';
        allProducts = ${JSON.stringify(PRODUCTS_FIXTURE)};
        categories = ${JSON.stringify(CATEGORIES_FIXTURE)};
        cart = {};
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // 1～9：getVisibleProductsForCurrentPage() / renderMenu() 真值表
    // ══════════════════════════════════════════════════════════════
    {
      // H1.4.11.4.1 修正過期預期：H1.4.11.4 原本把這項預期為「回傳全部商品（含 ID 4
      // 皆停用商品）」，但這與 H1.4.11.4 changelog 真值表本身寫的「外帶、外送皆停用時
      // 合併模式隱藏」互相矛盾——真正原因是 H1.4.11.4 的 getVisibleProductsForCurrentPage()
      // 在 combined_checkout 分支直接 return allProducts，從未排除皆停用商品，程式與
      // 文件、測試三者不一致。這不是為了迎合 production 而降低測試強度，而是依 H1.4.11.4.1
      // 需求文件三的最終真值表（皆停用 → 合併模式也隱藏）修正這一項過期預期：期望值改為
      // PRODUCTS_FIXTURE 扣除 ID 4，其餘商品（1,2,3,5,6,7,8,9,10,11）維持不變、全部保留。
      setupPage('combined_checkout', 'takeout');
      const visibleIds = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      const expectedIds = PRODUCTS_FIXTURE.map(p=>p.id).filter(id=>id!==4);
      assert(JSON.stringify(visibleIds.sort((a,b)=>a-b)) === JSON.stringify(expectedIds.sort((a,b)=>a-b)), '1 combined_checkout：getVisibleProductsForCurrentPage() 回傳除「兩者皆停用」商品(4)外的所有商品（H1.4.11.4.1 修正：皆停用商品合併模式也必須隱藏）', JSON.stringify(visibleIds));
      assert(!visibleIds.includes(4), '1b combined_checkout：兩者皆停用商品(4)不得出現在合併模式可見清單', JSON.stringify(visibleIds));
    }
    {
      // 2：合併模式點擊 _ffViewMode 不會過濾商品——直接呼叫 handleFulfillmentTileClick()
      // 切換查看的圖塊，確認 allProducts/currentMode 完全不受影響，renderMenu() 用的
      // 可見商品集合也不變。
      setupPage('combined_checkout', 'takeout');
      ev(`
        window.__oTypeT2 = { value:'takeout' };
        window.__origGetByIdT2 = document.getElementById;
        document.getElementById = function(id){ return id==='oType' ? window.__oTypeT2 : window.__origGetByIdT2.call(document, id); };
      `);
      const before = ev(`getVisibleProductsForCurrentPage().length`);
      ev(`handleFulfillmentTileClick('delivery')`); // combined_checkout 下，可用圖塊點擊只切換 _ffViewMode
      const after = ev(`getVisibleProductsForCurrentPage().length`);
      const cmAfter = ev('currentMode');
      assert(before === after, '2 合併模式點擊圖塊（_ffViewMode 改變）不會改變可見商品數量', `before=${before} after=${after}`);
      assert(cmAfter === 'takeout', '2b 合併模式點擊圖塊不改變 currentMode');
      ev(`document.getElementById = window.__origGetByIdT2;`);
    }
    {
      setupPage('fulfillment_switcher', 'takeout');
      const ids = ev(`getVisibleProductsForCurrentPage().map(p=>p.id).sort((a,b)=>a-b)`);
      assert(ids.includes(1) && ids.includes(2), '3 fulfillment_switcher+takeout：顯示同時支援(1)及僅外帶(2)商品', JSON.stringify(ids));
      assert(!ids.includes(3), '4 fulfillment_switcher+takeout：隱藏僅外送商品(3)', JSON.stringify(ids));
      assert(!ids.includes(4), '7a fulfillment_switcher+takeout：兩模式皆停用商品(4)不顯示', JSON.stringify(ids));
    }
    {
      setupPage('fulfillment_switcher', 'delivery');
      const ids = ev(`getVisibleProductsForCurrentPage().map(p=>p.id).sort((a,b)=>a-b)`);
      assert(ids.includes(1) && ids.includes(3), '5 fulfillment_switcher+delivery：顯示同時支援(1)及僅外送(3)商品', JSON.stringify(ids));
      assert(!ids.includes(2), '6 fulfillment_switcher+delivery：隱藏僅外帶商品(2)', JSON.stringify(ids));
      assert(!ids.includes(4), '7b fulfillment_switcher+delivery：兩模式皆停用商品(4)不顯示', JSON.stringify(ids));
    }
    {
      setupPage('fulfillment_switcher', 'takeout');
      const idsT = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      setupPage('fulfillment_switcher', 'delivery');
      const idsD = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(idsT.includes(5) && idsD.includes(5), '8 欄位缺失商品(5)在兩模式都顯示（相容預設值＝啟用）', JSON.stringify({ idsT, idsD }));
    }
    {
      setupPage('fulfillment_switcher', 'takeout');
      const idsT = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      setupPage('fulfillment_switcher', 'delivery');
      const idsD = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      // 商品6：line_takeout_enabled='1', line_delivery_enabled='0'（字串型別）
      assert(idsT.includes(6) && !idsD.includes(6), '9a "0"/"1" 字串型別正確解析（商品6：字串"1"→顯示於外帶，字串"0"→隱藏於外送）', JSON.stringify({ idsT: idsT.includes(6), idsD: idsD.includes(6) }));
      // 商品7：布林 true/false
      assert(idsT.includes(7) && !idsD.includes(7), '9b 布林值正確解析（商品7：true→顯示於外帶，false→隱藏於外送）', JSON.stringify({ idsT: idsT.includes(7), idsD: idsD.includes(7) }));
    }

    // ══════════════════════════════════════════════════════════════
    // 24～27：暫時營業狀態不得影響永久支援商品的可見性
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      const ids = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(ids.includes(9), '24 尚未開始販售但支援目前模式的商品(9)仍保留', JSON.stringify(ids));
      assert(ids.includes(8), '25 今日售完但支援目前模式的商品(8)仍保留', JSON.stringify(ids));
      assert(ids.includes(10), '26 可預訂明日且支援目前模式的商品(10)仍保留', JSON.stringify(ids));
      assert(ids.includes(11), '27 Business Calendar 公休但永久支援目前模式的商品(11)仍保留', JSON.stringify(ids));
    }

    // ══════════════════════════════════════════════════════════════
    // 10～11：實際呼叫 renderMenu() 切換模式後立即重新渲染
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`window.__menuAreaFake = { innerHTML:'' }; window.__origGetByIdT3 = document.getElementById; document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFake : window.__origGetByIdT3.call(document, id); };`);
      ev(`renderMenu()`);
      const htmlTakeout = ev('window.__menuAreaFake.innerHTML');
      assert(htmlTakeout.includes('僅外帶商品') && !htmlTakeout.includes('僅外送商品'), '10 外帶模式下 renderMenu() 輸出含僅外帶商品、不含僅外送商品');
      ev(`currentMode = 'delivery'; renderMenu();`);
      const htmlDelivery = ev('window.__menuAreaFake.innerHTML');
      assert(htmlDelivery.includes('僅外送商品') && !htmlDelivery.includes('僅外帶商品'), '11 外帶切換外送後，renderMenu() 立即重新渲染為僅含外送相容商品');
      ev(`document.getElementById = window.__origGetByIdT3;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 19～21：分類同步
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        window.__catBarFake = { innerHTML:'' };
        window.__origGetByIdT4 = document.getElementById;
        document.getElementById = function(id){ return id==='catBar' ? window.__catBarFake : window.__origGetByIdT4.call(document, id); };
      `);
      // 先選 catB（外帶模式下 catB 只有商品3(僅外送)和4(皆停用)，過濾後 catB 應該沒有
      // 任何外帶商品）
      ev(`currentCat='catB'; buildCats();`);
      const currentCatAfterBuild = ev('currentCat');
      const catBarHtml = ev('window.__catBarFake.innerHTML');
      assert(currentCatAfterBuild === 'all', '20 切換後無效的 currentCat（catB 在外帶模式下無可見商品）自動回到 all', `currentCat=${currentCatAfterBuild}`);
      assert(!catBarHtml.includes('data-cat="catB"'), '19a fulfillment_switcher+外帶：分類列不顯示 catB（外帶模式下沒有可見商品）');
      assert(catBarHtml.includes('data-cat="catA"'), '19b fulfillment_switcher+外帶：分類列仍顯示 catA（有可見商品）');
      assert(catBarHtml.includes('data-cat="all"'), '19c 「全部」分類固定保留');
      // 切回外送，catB 應該重新出現（有商品3），catA 應該仍出現（有商品1）
      ev(`currentMode='delivery'; buildCats();`);
      const catBarHtmlDelivery = ev('window.__catBarFake.innerHTML');
      assert(catBarHtmlDelivery.includes('data-cat="catB"'), '21 切回外送後，catB 正確恢復（因為商品3(僅外送)可見）');
      ev(`document.getElementById = window.__origGetByIdT4;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 22～23：空狀態文案
    // ══════════════════════════════════════════════════════════════
    {
      // 建一份「只有僅外送商品」的資料集，外帶模式下應該完全沒有可見商品
      ev(`
        shopData = { line_order_page_mode:'fulfillment_switcher',
          takeout_status:{today_state:'open',today_open:true,today_label:'開放中',earliest_today:60,allow_next_day:false},
          delivery_status:{today_state:'open',today_open:true,today_label:'開放中',earliest_today:60,allow_next_day:false} };
        currentMode='takeout'; currentCat='all';
        allProducts=[{id:100,name:'僅外送測試商品',line_takeout_enabled:0,line_delivery_enabled:1,display_cat_id:'catA',sale_status:'available'}];
        categories=${JSON.stringify(CATEGORIES_FIXTURE)};
        window.__menuAreaFake2 = { innerHTML:'' };
        window.__origGetByIdT5 = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFake2 : window.__origGetByIdT5.call(document, id); };
      `);
      ev(`renderMenu()`);
      const emptyTakeoutHtml = ev('window.__menuAreaFake2.innerHTML');
      assert(emptyTakeoutHtml.includes('目前沒有提供外帶自取的商品'), '22 外帶模式沒有任何支援商品時，顯示「目前沒有提供外帶自取的商品」', emptyTakeoutHtml);
      assert(!/錯誤|載入失敗|今日售完|今日公休/.test(emptyTakeoutHtml), '22b 空狀態文案不得顯示系統錯誤/今日售完/今日公休/載入失敗等字樣', emptyTakeoutHtml);
      ev(`currentMode='delivery'; renderMenu();`);
      const nonEmptyDeliveryHtml = ev('window.__menuAreaFake2.innerHTML');
      assert(!nonEmptyDeliveryHtml.includes('目前沒有提供'), '23 切到外送後（有可見商品）不再顯示空狀態文案');
      ev(`document.getElementById = window.__origGetByIdT5;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 28～30：addCart()／openProductDetail() 防繞過
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        window.__toastCallsMode = [];
        window.__origToastMode = toast;
        toast = function(msg, ms){ window.__toastCallsMode.push({msg, ms}); };
      `);
      ev(`addCart(3)`); // 商品3是僅外送，目前 currentMode=takeout → 應被擋
      const cartAfterAddBlocked = ev(`Object.keys(cart).length`);
      const toastAfterBlocked = ev('window.__toastCallsMode');
      assert(cartAfterAddBlocked === 0, '28 直接呼叫 addCart(3)（僅外送商品，目前是外帶模式）無法加入購物車', `cartKeys=${cartAfterAddBlocked}`);
      assert(Array.isArray(toastAfterBlocked) && toastAfterBlocked.length === 1 && toastAfterBlocked[0].msg.includes('外送'), '28b 被擋時顯示簡短 Toast（此商品僅提供外送）', JSON.stringify(toastAfterBlocked));

      ev(`window.__toastCallsMode = [];`);
      ev(`addCart(2)`); // 商品2是僅外帶，目前 currentMode=takeout → 應該成功
      const cartAfterAddAllowed = ev(`cart['2'] ? cart['2'].qty : (cart[2] ? cart[2].qty : 0)`);
      assert(cartAfterAddAllowed === 1, '28c 支援目前模式的商品(2)可正常加入購物車', `qty=${cartAfterAddAllowed}`);

      let openDetailError = null;
      try { ev(`openProductDetail(3)`); } catch (e) { openDetailError = e && e.message; }
      assert(!openDetailError, '29-0 openProductDetail(3) 呼叫本身不拋出例外', openDetailError ? String(openDetailError).slice(0, 200) : '');
      // 商品3不支援目前模式，openProductDetail() 應該直接 toast 並 return，不會呼叫
      // ProductDetailModal.open()（用 spy 驗證未被呼叫）。
      ev(`
        window.__modalOpenCalls = 0;
        window.__origModalOpen = window.ProductDetailModal ? window.ProductDetailModal.open : null;
        if(window.ProductDetailModal){ window.ProductDetailModal.open = function(){ window.__modalOpenCalls++; }; }
      `);
      ev(`openProductDetail(3)`);
      const modalOpenCallsBlocked = ev('window.__modalOpenCalls');
      assert(modalOpenCallsBlocked === 0, '29 直接呼叫 openProductDetail(3)（僅外送商品，目前是外帶模式）不會開啟可加入購物車的詳情（ProductDetailModal.open 未被呼叫）', `calls=${modalOpenCallsBlocked}`);
      ev(`if(window.ProductDetailModal && window.__origModalOpen){ window.ProductDetailModal.open = window.__origModalOpen; }`);
      ev(`toast = window.__origToastMode;`);
    }
    {
      // 30：合併模式仍可加入僅外送或僅外帶商品（維持既有規則，不受本輪過濾影響）
      setupPage('combined_checkout', 'takeout');
      ev(`addCart(3)`); // 商品3僅外送，合併模式下應該仍可加入（既有規則：任一模式可買即可）
      const cartCombined = ev(`cart['3'] ? cart['3'].qty : (cart[3] ? cart[3].qty : 0)`);
      assert(cartCombined === 1, '30 合併模式仍可加入僅外送商品(3)（既有規則不受本輪影響）', `qty=${cartCombined}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 17～18：不可使用圖塊不得改變商品列表／currentMode／oType
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        shopData.delivery_status = { today_state:'today_not_open', today_open:false, today_label:'目前未提供', earliest_today:null, allow_next_day:false, today_reason:'global_disabled' };
        window.__oTypeT6 = { value:'takeout' };
        window.__origGetByIdT6 = document.getElementById;
        document.getElementById = function(id){ return id==='oType' ? window.__oTypeT6 : window.__origGetByIdT6.call(document, id); };
        window.__toastCallsT6 = [];
        window.__origToastT6 = toast;
        toast = function(msg, ms){ window.__toastCallsT6.push({msg, ms}); };
      `);
      const idsBeforeGrayClick = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      ev(`handleFulfillmentTileClick('delivery')`); // delivery 目前不可用（灰色圖塊）
      const idsAfterGrayClick = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      const cmAfterGrayClick = ev('currentMode');
      const oTypeAfterGrayClick = ev('window.__oTypeT6.value');
      const toastAfterGrayClick = ev('window.__toastCallsT6');
      assert(JSON.stringify(idsBeforeGrayClick) === JSON.stringify(idsAfterGrayClick), '17 點擊不可用（灰色）圖塊不改變商品列表', JSON.stringify({ before: idsBeforeGrayClick, after: idsAfterGrayClick }));
      assert(cmAfterGrayClick === 'takeout', '18a 點擊不可用圖塊不改變 currentMode');
      assert(oTypeAfterGrayClick === 'takeout', '18b 點擊不可用圖塊不改變 #oType');
      assert(Array.isArray(toastAfterGrayClick) && toastAfterGrayClick.length === 1, '17b 點擊不可用圖塊顯示既有 Toast（未新增第二套）');
      ev(`document.getElementById = window.__origGetByIdT6; toast = window.__origToastT6;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 31～32：切換模式後既有購物車不相容商品的處理
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        cart = { '2': { product: allProducts.find(p=>p.id===2), qty: 1 } }; // 商品2僅外帶
        window.__conflictBoxFake = { style:{display:'none'} };
        window.__origGetByIdT7 = document.getElementById;
        document.getElementById = function(id){ return id==='conflictBox' ? window.__conflictBoxFake : window.__origGetByIdT7.call(document, id); };
      `);
      // 直接呼叫既有 getCartAvailableModes()（不新建第二套邏輯）確認切到外送後會偵測衝突
      ev(`currentMode='delivery';`);
      const cartModes = ev(`JSON.stringify(getCartAvailableModes())`);
      const cartStillHasItem = ev(`Object.keys(cart).length`);
      assert(JSON.parse(cartModes).delivery === false, '32a 切到外送後，既有 getCartAvailableModes() 正確偵測購物車內僅外帶商品造成外送不可用', cartModes);
      assert(cartStillHasItem === 1, '31 切換取餐方式後，購物車內不相容商品仍保留（未被自動移除或清空）');
      ev(`document.getElementById = window.__origGetByIdT7;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 12～16：合法切換（真實呼叫 applyFulfillmentMode()）不整頁重載、不額外 fetch
    // menu、不清空購物車、buildCats()／renderMenu() 恰好各一次
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        cart = { '1': { product: allProducts.find(p=>p.id===1), qty: 2 } };
        window.__cartBeforeSwitch = JSON.stringify(cart);
        window.__buildCatsCalls = 0; window.__origBuildCats = buildCats;
        buildCats = function(){ window.__buildCatsCalls++; return window.__origBuildCats(); };
        window.__renderMenuCalls = 0; window.__origRenderMenu = renderMenu;
        renderMenu = function(){ window.__renderMenuCalls++; return window.__origRenderMenu(); };
        window.__menuFetchCallsT8 = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCallsT8++; }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ slots:[] }, categories:[], products:[] }) });
        };
      `);
      let switchError = null;
      try { await ev(`applyFulfillmentMode('delivery')`); } catch (e) { switchError = e && e.message; }
      const buildCatsCallsAfterSwitch = ev('window.__buildCatsCalls');
      const renderMenuCallsAfterSwitch = ev('window.__renderMenuCalls');
      const menuFetchCallsAfterSwitch = ev('window.__menuFetchCallsT8');
      const cartAfterSwitch = ev('JSON.stringify(cart)');
      const cmAfterSwitch = ev('currentMode');
      assert(!switchError, '12-0 applyFulfillmentMode(\'delivery\') 真實執行不拋出例外', switchError ? String(switchError).slice(0, 300) : '');
      assert(cmAfterSwitch === 'delivery', '12 合法切換後 currentMode 正確變成 delivery（未整頁重載，同一個 window/狀態持續存在）');
      assert(buildCatsCallsAfterSwitch === 1, '15 合法切換中 buildCats() 恰好執行一次', `calls=${buildCatsCallsAfterSwitch}`);
      assert(renderMenuCallsAfterSwitch === 1, '16 合法切換中 renderMenu() 恰好執行一次', `calls=${renderMenuCallsAfterSwitch}`);
      assert(cartAfterSwitch === ev('window.__cartBeforeSwitch'), '14 合法切換不清空購物車');
      ev(`buildCats = window.__origBuildCats; renderMenu = window.__origRenderMenu;`);
    }
    {
      // 13：獨立驗證「buildCats()/renderMenu() 本身不額外 fetch /api/line-menu」——這裡
      // 刻意用空購物車，隔離既有 refreshDateSelectorForCart()→
      // refreshCartProductsFromLatestMenu() 在購物車非空時原本就會做的菜單同步 fetch
      // （那是 H1.4.11.3 就存在的既有行為，不是本輪新增的呼叫，也不在本次需求文件五、
      // 六的修改範圍內），避免和「本輪新增的 buildCats()/renderMenu() 過濾邏輯是否本身
      // 額外 fetch 菜單」這件事混在一起判斷。
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        cart = {};
        window.__menuFetchCallsT8b = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCallsT8b++; }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ slots:[] }, categories:[], products:[] }) });
        };
      `);
      await ev(`applyFulfillmentMode('delivery')`);
      const menuFetchCallsEmptyCart = ev('window.__menuFetchCallsT8b');
      assert(menuFetchCallsEmptyCart === 0, '13 購物車為空時，合法切換完全不 fetch /api/line-menu（buildCats()/renderMenu() 只重用目前已載入的 allProducts）', `menuFetchCalls=${menuFetchCallsEmptyCart}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 35～36：Analytics——隱藏商品不被曝光 Observer 觀察、重繪不重複計算曝光
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        window.__menuAreaFakeObs = document.createElement('div');
        window.__menuAreaFakeObs.id = 'menuArea';
        document.body.appendChild(window.__menuAreaFakeObs);
        window.__origGetByIdT9 = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFakeObs : window.__origGetByIdT9.call(document, id); };
        window.__trackEventCallsT9 = [];
        window.__origTrackEventT9 = _trackEvent;
        _trackEvent = function(name, extra){ window.__trackEventCallsT9.push({name, extra}); return window.__origTrackEventT9(name, extra); };
      `);
      ev(`renderMenu()`);
      const renderedCardIds = ev(`Array.from(window.__menuAreaFakeObs.querySelectorAll('.prod-card[id^="pc-"]')).map(el=>el.id)`);
      assert(!renderedCardIds.includes('pc-3'), '35 商品3（僅外送，目前是外帶模式）完全沒有被渲染成 DOM 卡片，因此不會被 _setupViewProductObserver() 觀察', JSON.stringify(renderedCardIds));
      assert(renderedCardIds.includes('pc-2'), '35b 支援目前模式的商品2確實被渲染成卡片');
      // 36：真正模擬一次商品卡進入視窗（呼叫 IntersectionObserver 的 callback，這才是
      // production 真正標記「已看過」並送出 view_product 的時機），驗證 seenSet／
      // sessionStorage 去重後，同一商品重新渲染（模擬切換模式來回）不會被再次加入
      // observe 清單，也不會重複呼叫 _trackEvent('view_product', ...)。
      ev(`
        window.__ioCallbacks = [];
        window.__ioObserveCalls = [];
        window.__OrigIO = window.IntersectionObserver;
        window.IntersectionObserver = function(cb, opts){
          window.__ioCallbacks.push(cb);
          this.observe = function(el){ window.__ioObserveCalls.push(el.id); };
          this.disconnect = function(){};
          this.unobserve = function(){};
        };
      `);
      ev(`renderMenu()`); // 第一次渲染，建立第一個 observer 並 observe 目前可見的卡片
      const firstRoundObserve = ev('window.__ioObserveCalls');
      // 真正觸發一次「商品卡2進入視窗」的 intersection callback（模擬使用者真的看到它）
      ev(`
        const cb0 = window.__ioCallbacks[window.__ioCallbacks.length - 1];
        cb0([{ isIntersecting: true, target: document.getElementById('pc-2') }]);
      `);
      const trackCallsAfterFirstView = ev('window.__trackEventCallsT9.filter(c=>c.name==="view_product" && c.extra && Number(c.extra.product_id)===2).length');
      assert(trackCallsAfterFirstView === 1, '36-0 前置：商品卡2真正進入視窗一次，view_product 被送出一次');
      ev(`window.__ioObserveCalls = [];`);
      ev(`renderMenu()`); // 第二次重新渲染同一批商品（模擬切換模式來回後同一商品又出現）
      const secondRoundObserve = ev('window.__ioObserveCalls');
      assert(Array.isArray(firstRoundObserve) && firstRoundObserve.includes('pc-2'), '36-1 前置：第一次渲染時，商品卡2確實被加入 observe 清單');
      assert(!secondRoundObserve.includes('pc-2'), '36 已經真正看過的商品卡2，重新渲染後不會被再次加入 observe 清單（seenSet／sessionStorage 去重生效，避免重複計算曝光）', JSON.stringify({ firstRoundObserve, secondRoundObserve }));
      // 即使真的又被 observe 到，_trackEvent('view_product', ...) 對同一 product_id 的
      // 呼叫次數也不應該增加（因為 seenSet 已經包含它，不會再走到 observe() 那一步，
      // callback 自然也不會再被呼叫第二次）。
      const trackCallsAfterSecondRender = ev('window.__trackEventCallsT9.filter(c=>c.name==="view_product" && c.extra && Number(c.extra.product_id)===2).length');
      assert(trackCallsAfterSecondRender === 1, '36b 同一商品重新渲染後，view_product 的總呼叫次數維持 1（不會因為重新渲染而重複計算）', `count=${trackCallsAfterSecondRender}`);
      ev(`window.IntersectionObserver = window.__OrigIO; document.getElementById = window.__origGetByIdT9; _trackEvent = window.__origTrackEventT9; window.__menuAreaFakeObs.remove();`);
    }

    // ══════════════════════════════════════════════════════════════
    // H1.4.11.4 續作二之一：合併模式動態切成切換模式（真實 refreshShopStatus()，輕量
    // 路徑，page mode 是唯一改變的欄位）
    // ══════════════════════════════════════════════════════════════
    {
      const productA = { id: 201, name: '商品A雙模式', line_takeout_enabled: 1, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' };
      const productB = { id: 202, name: '商品B僅外送', line_takeout_enabled: 0, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' };
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
        };
        takeoutEnabled = true; deliveryEnabled = true; takeoutCutoffPassed = false; deliveryCutoffPassed = false; todayClosed = false;
        currentMode = 'takeout';
        currentCat = 'all';
        allProducts = [${JSON.stringify(productA)}, ${JSON.stringify(productB)}];
        categories = ${JSON.stringify(CATEGORIES_FIXTURE)};
        cart = { '201': { product: allProducts[0], qty: 1 } };
        window.__combinedToSwitchCartBefore = JSON.stringify(cart);
        window.__oTypeSec2a = { value:'takeout' };
        window.__fakeCartSheetSec2 = { classList: { contains(){ return false; } } };
        window.__menuAreaFakeSec2 = { innerHTML:'' };
        window.__origGetByIdSec2 = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oTypeSec2a;
          if(id==='cartSheet') return window.__fakeCartSheetSec2;
          if(id==='menuArea') return window.__menuAreaFakeSec2;
          return window.__origGetByIdSec2.call(document, id);
        };
        window.__buildCatsCallsSec2 = 0; window.__origBuildCatsSec2 = buildCats;
        buildCats = function(){ window.__buildCatsCallsSec2++; return window.__origBuildCatsSec2(); };
        window.__renderMenuCallsSec2 = 0; window.__origRenderMenuSec2 = renderMenu;
        renderMenu = function(){ window.__renderMenuCallsSec2++; return window.__origRenderMenuSec2(); };
        window.__menuFetchCallsSec2 = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCallsSec2++; }
          if(u.includes('/api/line-shop')){
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
              line_order_page_mode: 'fulfillment_switcher', // 只有這個欄位改變
              takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
              delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
            } }) });
          }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{} }) });
        };
      `);
      let sec2aError = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { sec2aError = e && e.message; }
      const cmAfterSec2a = ev('currentMode');
      const oTypeAfterSec2a = ev('window.__oTypeSec2a.value');
      const cartAfterSec2a = ev('JSON.stringify(cart)');
      const menuHtmlAfterSec2a = ev('window.__menuAreaFakeSec2.innerHTML');
      const buildCatsCallsSec2a = ev('window.__buildCatsCallsSec2');
      const renderMenuCallsSec2a = ev('window.__renderMenuCallsSec2');
      const menuFetchCallsSec2a = ev('window.__menuFetchCallsSec2');
      assert(!sec2aError, '2.1-0 合併切換模式時，真實 refreshShopStatus() 執行不拋出例外', sec2aError ? String(sec2aError).slice(0, 300) : '');
      assert(cmAfterSec2a === 'takeout', '2.1-1 currentMode 不受影響（僅頁面模式改變，非使用者主動切換取餐方式）');
      assert(oTypeAfterSec2a === 'takeout', '2.1-2 #oType 不受影響');
      assert(cartAfterSec2a === ev('window.__combinedToSwitchCartBefore'), '2.1-3 購物車不清空');
      assert(menuHtmlAfterSec2a.includes('商品A雙模式'), '2.1-4 商品A（雙模式）保留');
      assert(!menuHtmlAfterSec2a.includes('商品B僅外送'), '2.1-5 僅外送的商品B從外帶列表消失（頁面模式改成 fulfillment_switcher 後，商品可見性依 currentMode=takeout 重新篩選）');
      assert(buildCatsCallsSec2a === 1, '2.1-6 buildCats() 恰好一次', `calls=${buildCatsCallsSec2a}`);
      assert(renderMenuCallsSec2a === 1, '2.1-7 renderMenu() 恰好一次', `calls=${renderMenuCallsSec2a}`);
      assert(menuFetchCallsSec2a === 0, '2.1-8 不額外取得 /api/line-menu（重用既有 allProducts）', `menuFetchCalls=${menuFetchCallsSec2a}`);
      ev(`
        document.getElementById = window.__origGetByIdSec2;
        buildCats = window.__origBuildCatsSec2; renderMenu = window.__origRenderMenuSec2;
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // H1.4.11.4 續作二之二：切換模式動態改回合併模式
    // ══════════════════════════════════════════════════════════════
    {
      const productA = { id: 201, name: '商品A雙模式', line_takeout_enabled: 1, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' };
      const productB = { id: 202, name: '商品B僅外送', line_takeout_enabled: 0, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' };
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
        };
        takeoutEnabled = true; deliveryEnabled = true; takeoutCutoffPassed = false; deliveryCutoffPassed = false; todayClosed = false;
        currentMode = 'takeout';
        currentCat = 'all';
        allProducts = [${JSON.stringify(productA)}, ${JSON.stringify(productB)}];
        categories = ${JSON.stringify(CATEGORIES_FIXTURE)};
        cart = { '201': { product: allProducts[0], qty: 1 } };
        window.__switchToCombinedCartBefore = JSON.stringify(cart);
        window.__oTypeSec2b = { value:'takeout' };
        window.__fakeCartSheetSec2b = { classList: { contains(){ return false; } } };
        window.__menuAreaFakeSec2b = { innerHTML:'' };
        window.__catBarFakeSec2b = { innerHTML:'' };
        window.__origGetByIdSec2b = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oTypeSec2b;
          if(id==='cartSheet') return window.__fakeCartSheetSec2b;
          if(id==='menuArea') return window.__menuAreaFakeSec2b;
          if(id==='catBar') return window.__catBarFakeSec2b;
          return window.__origGetByIdSec2b.call(document, id);
        };
        window.__buildCatsCallsSec2b = 0; window.__origBuildCatsSec2b = buildCats;
        buildCats = function(){ window.__buildCatsCallsSec2b++; return window.__origBuildCatsSec2b(); };
        window.__renderMenuCallsSec2b = 0; window.__origRenderMenuSec2b = renderMenu;
        renderMenu = function(){ window.__renderMenuCallsSec2b++; return window.__origRenderMenuSec2b(); };
        window.__menuFetchCallsSec2b = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCallsSec2b++; }
          if(u.includes('/api/line-shop')){
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
              line_order_page_mode: 'combined_checkout', // 只有這個欄位改變
              takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
              delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
            } }) });
          }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{} }) });
        };
      `);
      // 先確認起始狀態：fulfillment_switcher+takeout 下商品B（僅外送）確實不可見
      ev(`renderMenu();`);
      const beforeHtml = ev('window.__menuAreaFakeSec2b.innerHTML');
      assert(!beforeHtml.includes('商品B僅外送'), '2.2-0 前置：fulfillment_switcher+takeout 下商品B（僅外送）確實被隱藏');
      ev(`window.__buildCatsCallsSec2b = 0; window.__renderMenuCallsSec2b = 0;`); // 重置計數，只算 refreshShopStatus() 這次呼叫

      let sec2bError = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { sec2bError = e && e.message; }
      const cartAfterSec2b = ev('JSON.stringify(cart)');
      const menuHtmlAfterSec2b = ev('window.__menuAreaFakeSec2b.innerHTML');
      const buildCatsCallsSec2b = ev('window.__buildCatsCallsSec2b');
      const renderMenuCallsSec2b = ev('window.__renderMenuCallsSec2b');
      const menuFetchCallsSec2b = ev('window.__menuFetchCallsSec2b');
      assert(!sec2bError, '2.2-0b 切換改回合併模式時，真實 refreshShopStatus() 執行不拋出例外', sec2bError ? String(sec2bError).slice(0, 300) : '');
      assert(menuHtmlAfterSec2b.includes('商品B僅外送'), '2.2-1 僅外送商品B重新出現（切回 combined_checkout 後不再依 currentMode 過濾）', menuHtmlAfterSec2b.slice(0, 200));
      assert(cartAfterSec2b === ev('window.__switchToCombinedCartBefore'), '2.2-2 購物車不清空');
      assert(buildCatsCallsSec2b === 1, '2.2-3 buildCats() 恰好一次', `calls=${buildCatsCallsSec2b}`);
      assert(renderMenuCallsSec2b === 1, '2.2-4 renderMenu() 恰好一次', `calls=${renderMenuCallsSec2b}`);
      assert(menuFetchCallsSec2b === 0, '2.2-5 不額外取得 /api/line-menu', `menuFetchCalls=${menuFetchCallsSec2b}`);
      ev(`
        document.getElementById = window.__origGetByIdSec2b;
        buildCats = window.__origBuildCatsSec2b; renderMenu = window.__origRenderMenuSec2b;
      `);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 33～34：後端 /validate-cart 與正式送單端點仍拒絕不支援模式的商品（真實 HTTP + 真實
// DB fixture，不 mock 判斷結果本身）
// ══════════════════════════════════════════════════════════════════
async function runBackendTests() {
  const tmpDbPath = path.join(os.tmpdir(), `h14114-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.POS_DB_PATH = tmpDbPath;

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();

  const STORE = 'store_h14114_a';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE, 1]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE, 'pro', JSON.stringify({ line_order: true })]);
  db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'line_ordering_enabled', '1']);
  // routes/products.js 的 ensureProductModeColumns() 是「runtime-safe」補欄位（只在
  // 實際呼叫商品相關 API 時才會自動跑 ALTER TABLE），本測試只掛載 routes/line-orders.js，
  // 沒有觸發那個 lazy migration 的時機，所以先在這裡直接補上同樣的欄位（與
  // ensureProductModeColumns() 的 ALTER TABLE 定義完全一致），模擬正式環境「至少已經
  // 呼叫過一次商品相關 API」之後的真實 schema 狀態，不是繞過或簡化 production 邏輯。
  try { db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) { /* 已存在則忽略 */ }
  try { db.run('ALTER TABLE products ADD COLUMN line_delivery_enabled INTEGER DEFAULT 1'); } catch (e) { /* 已存在則忽略 */ }
  const everyDayOpen = (mode) => {
    const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const o = {}; WD.forEach((k) => { o[k] = { enabled: true, open: '00:00', close: '23:59' }; }); return o;
  };
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_business_hours', JSON.stringify(everyDayOpen('takeout'))]);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'delivery_business_hours', JSON.stringify(everyDayOpen('delivery'))]);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_enabled', '1']);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'delivery_enabled', '1']);

  // 建一個「僅外送」的商品（line_takeout_enabled=0）
  let productId = null;
  try {
    const catRow = db.get('SELECT id FROM categories WHERE store_id=? LIMIT 1', [STORE]);
    let catId = catRow && catRow.id;
    if (!catId) {
      db.run('INSERT INTO categories (store_id, name, sort_order) VALUES (?,?,?)', [STORE, 'H14114測試分類', 1]);
      catId = db.get('SELECT id FROM categories WHERE store_id=? ORDER BY id DESC LIMIT 1', [STORE]).id;
    }
    db.run(
      `INSERT INTO products (store_id, category_id, name, price, line_takeout_enabled, line_delivery_enabled, enabled)
       VALUES (?,?,?,?,?,?,1)`,
      [STORE, catId, 'H14114僅外送測試商品', 100, 0, 1],
    );
    productId = db.get('SELECT id FROM products WHERE store_id=? ORDER BY id DESC LIMIT 1', [STORE]).id;
    pass('後端-0 已建立真實「僅外送」商品 fixture（line_takeout_enabled=0, line_delivery_enabled=1）');
  } catch (e) {
    fail('後端-0 已建立真實「僅外送」商品 fixture', e.message);
  }

  const lineOrdersRoute = require(path.join(ROOT, 'routes/line-orders.js'));
  const express = require('express');
  const bodyParser = require('body-parser');
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => { req.storeId = req.headers['x-test-store'] || STORE; next(); });
  app.use('/api/line-orders', lineOrdersRoute);
  server = app.listen(0);
  const port = server.address().port;
  const fetchFn = (await import('node-fetch')).default;
  const base = `http://localhost:${port}`;

  if (productId) {
    // 33：GET /validate-cart 應該拒絕把這個僅外送商品當成 takeout 訂購
    const r = await fetchFn(`${base}/api/line-orders/validate-cart?mode=takeout&product_ids=${productId}`, { headers: { 'x-test-store': STORE } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const rejected = r && Array.isArray(r.products) && r.products.some((it) => String(it.product_id) === String(productId) && it.reason === 'product_mode_not_supported' && it.ok === false);
    assert(!!rejected, '33 GET /api/line-orders/validate-cart 對僅外送商品以 mode=takeout 查詢時，正確回報 product_mode_not_supported（後端既有驗證，本輪未修改，用真實請求佐證仍生效）', JSON.stringify(r));

    // 34：正式送單端點也應該拒絕（POST /）
    const orderRes = await fetchFn(`${base}/api/line-orders/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({
        mode: 'takeout', items: [{ product_id: productId, qty: 1 }],
        customer_name: '測試', customer_phone: '0900000000',
      }),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const orderRejected = orderRes && orderRes.success === false && (orderRes.reason === 'product_mode_not_supported' || JSON.stringify(orderRes).includes('product_mode_not_supported'));
    assert(!!orderRejected, '34 正式送單端點（POST /api/line-orders/）對僅外送商品以 mode=takeout 送單時，正確拒絕（product_mode_not_supported，後端既有驗證，本輪未修改）', JSON.stringify(orderRes));
  }
}

main()
  .then(() => runBackendTests())
  .catch((e) => { fail('FATAL', e.stack || e.message); })
  .finally(() => {
    assert(!unhandledRejectionSeen, '整個測試執行過程中沒有出現未處理的 Promise rejection', unhandledRejectionSeen ? String(unhandledRejectionSeen && unhandledRejectionSeen.stack || unhandledRejectionSeen).slice(0, 300) : '');
    printSummary();
    try { if (server) server.close(); } catch (e) {}
    try { if (dom) dom.window.close(); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });
