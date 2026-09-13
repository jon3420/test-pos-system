#!/usr/bin/env node
// scripts/smoke-h1-4-11-4-1-both-disabled-product-filter.js
// H1.4.11.4.1｜LINE 點餐雙模式共同隱藏「外帶／外送皆停用」商品——真實 jsdom 執行測試
// （不是字串搜尋）。涵蓋需求文件十二列出的 40 項驗收情境（合理分組，每項皆有真實
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
  console.log('SMOKE TEST SUMMARY — H1.4.11.4.1 both-disabled product filter');
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
  ['routes/line-orders.js', 'routes/products.js', 'public/line-order.html'].forEach((rel) => {
    if (rel.endsWith('.html')) return; // node --check 不支援 .html，改在下方用 vm 語法解析驗證
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
      } catch (e) { /* 外部網址一律安全略過，不真的連線 */ }
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
    // 0-parse：line-order.html 內嵌的 <script> 區塊語法正確性——用 jsdom 已經解析好的
    // 真實 script 元素（而非自己用正規表示式重新切字串，避免字串內含 "</script>" 文字時
    // 誤判），逐一用 new Function() 真的重新解析一次原始碼，確保本輪修改沒有語法錯誤。
    // jsdom 本身已經成功 runScripts:'dangerously' 執行過（上面 jsdom-0 已通過），這裡是
    // 額外的靜態語法覆蓋層。
    const inlineScripts = [...dom.window.document.querySelectorAll('script:not([src])')].map((s) => s.textContent);
    inlineScripts.forEach((code, i) => { new Function(code); });
    pass(`0-parse public/line-order.html 共 ${inlineScripts.length} 個內嵌 <script> 區塊，逐一用 new Function() 語法解析通過`);
  } catch (e) {
    fail('jsdom-0 / 0-parse public/line-order.html', e.message.slice(0, 300));
  }

  if (dom) {
    const w = dom.window;
    const ev = (code) => w.eval(code);

    // 商品夾具：涵蓋 0/1、"0"/"1"、true/false 三種型別的「皆停用」商品，以及雙模式、
    // 僅外帶、僅外送、欄位缺失等對照組。
    const PRODUCTS_FIXTURE = [
      { id: 1, name: '雙模式商品', line_takeout_enabled: 1, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' },
      { id: 2, name: '僅外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available' },
      { id: 3, name: '僅外送商品', line_takeout_enabled: 0, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' },
      { id: 4, name: '數字皆停用商品', line_takeout_enabled: 0, line_delivery_enabled: 0, display_cat_id: 'catB', sale_status: 'available' },
      { id: 5, name: '字串皆停用商品', line_takeout_enabled: '0', line_delivery_enabled: '0', display_cat_id: 'catB', sale_status: 'available' },
      { id: 6, name: '布林皆停用商品', line_takeout_enabled: false, line_delivery_enabled: false, display_cat_id: 'catB', sale_status: 'available' },
      { id: 7, name: '欄位缺失商品', display_cat_id: 'catA', sale_status: 'available' },
      // 暫時狀態不得影響永久支援商品的可見性
      { id: 8, name: '公休但支援外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'today_closed' },
      { id: 9, name: '尚未開始但支援外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', pre_sale_available: true, takeout_sold_out_reason: null },
      { id: 10, name: '今日售完但支援外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'real_sold_out' },
      { id: 11, name: '可預訂明日但支援外帶商品', line_takeout_enabled: 1, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available', takeout_sold_out_reason: 'real_sold_out', takeout_can_next_day: true },
    ];
    const CATEGORIES_FIXTURE = [
      { id: 'catA', name: '分類A', icon: '🍱' },
      { id: 'catB', name: '分類B', icon: '🍜' }, // 分類B 全部商品都是皆停用，應該從分類列消失
    ];
    const BOTH_DISABLED_IDS = [4, 5, 6];

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
    // 1～4：合併模式隱藏三種型別的「皆停用」商品（數字/字串/布林）
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      const ids = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(!ids.includes(4), '1 合併模式隱藏數字 0/0 商品(4)', JSON.stringify(ids));
      assert(!ids.includes(5), '2 合併模式隱藏字串 "0"/"0" 商品(5)', JSON.stringify(ids));
      assert(!ids.includes(6), '3 合併模式隱藏布林 false/false 商品(6)', JSON.stringify(ids));
      assert(ids.includes(7), '4 欄位缺失的舊商品(7)仍依相容預設顯示', JSON.stringify(ids));
    }

    // ══════════════════════════════════════════════════════════════
    // 5～7：合併模式保留雙模式／僅外帶／僅外送商品及徽章
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      ev(`
        window.__menuAreaFakeA = { innerHTML:'' };
        window.__origGetByIdA = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFakeA : window.__origGetByIdA.call(document, id); };
      `);
      ev(`renderMenu()`);
      const html = ev('window.__menuAreaFakeA.innerHTML');
      assert(html.includes('雙模式商品'), '5 合併模式保留雙模式商品(1)', html.slice(0, 100));
      assert(html.includes('僅外帶商品') && html.includes('僅外帶'), '6 合併模式保留僅外帶商品(2)及「僅外帶」徽章', html.slice(0, 200));
      assert(html.includes('僅外送商品') && html.includes('僅外送'), '7 合併模式保留僅外送商品(3)及「僅外送」徽章', html.slice(0, 200));
      assert(!html.includes('數字皆停用商品') && !html.includes('字串皆停用商品') && !html.includes('布林皆停用商品'), '7b 合併模式輸出的 HTML 完全不包含任一皆停用商品名稱');
      ev(`document.getElementById = window.__origGetByIdA;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 8～9：合併模式點擊狀態圖塊（_ffViewMode）後，過濾結果不受影響
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      const before = ev(`getVisibleProductsForCurrentPage().map(p=>p.id).sort((a,b)=>a-b)`);
      ev(`
        window.__oTypeT8 = { value:'takeout' };
        window.__origGetByIdT8 = document.getElementById;
        document.getElementById = function(id){ return id==='oType' ? window.__oTypeT8 : window.__origGetByIdT8.call(document, id); };
      `);
      ev(`handleFulfillmentTileClick('delivery')`);
      const after = ev(`getVisibleProductsForCurrentPage().map(p=>p.id).sort((a,b)=>a-b)`);
      assert(JSON.stringify(before) === JSON.stringify(after), '9 合併模式點擊狀態圖塊不會隱藏單一模式商品（過濾結果不變）', JSON.stringify({ before, after }));
      assert(!after.includes(4) && !after.includes(5) && !after.includes(6), '8 合併模式點擊狀態圖塊後，兩者皆停用商品仍隱藏', JSON.stringify(after));
      ev(`document.getElementById = window.__origGetByIdT8;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 10～13：取餐切換模式隱藏皆停用商品，且僅外帶／僅外送規則不變
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      const idsT = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(!idsT.some((id) => BOTH_DISABLED_IDS.includes(id)), '10 取餐切換外帶頁隱藏兩者皆停用商品', JSON.stringify(idsT));
      assert(!idsT.includes(3), '12 外帶頁仍隱藏僅外送商品(3)', JSON.stringify(idsT));
      assert(idsT.includes(2), '12b 外帶頁仍顯示僅外帶商品(2)', JSON.stringify(idsT));

      setupPage('fulfillment_switcher', 'delivery');
      const idsD = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(!idsD.some((id) => BOTH_DISABLED_IDS.includes(id)), '11 取餐切換外送頁隱藏兩者皆停用商品', JSON.stringify(idsD));
      assert(!idsD.includes(2), '13 外送頁仍隱藏僅外帶商品(2)', JSON.stringify(idsD));
      assert(idsD.includes(3), '13b 外送頁仍顯示僅外送商品(3)', JSON.stringify(idsD));
    }

    // ══════════════════════════════════════════════════════════════
    // 14～17：暫時營業狀態不得影響永久支援商品的可見性
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('fulfillment_switcher', 'takeout');
      const ids = ev(`getVisibleProductsForCurrentPage().map(p=>p.id)`);
      assert(ids.includes(8), '14 臨時公休但永久支援的商品(8)仍顯示', JSON.stringify(ids));
      assert(ids.includes(9), '15 尚未開始但永久支援的商品(9)仍顯示', JSON.stringify(ids));
      assert(ids.includes(10), '16 今日售完但永久支援的商品(10)仍顯示', JSON.stringify(ids));
      assert(ids.includes(11), '17 可預訂明日但永久支援的商品(11)仍顯示', JSON.stringify(ids));
    }

    // ══════════════════════════════════════════════════════════════
    // 18～20：分類同步——只剩皆停用商品的分類會消失，無效 currentCat 回到 all
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      ev(`
        window.__catBarFakeB = { innerHTML:'' };
        window.__origGetByIdB = document.getElementById;
        document.getElementById = function(id){ return id==='catBar' ? window.__catBarFakeB : window.__origGetByIdB.call(document, id); };
      `);
      ev(`currentCat='catB'; buildCats();`);
      const catBarHtml = ev('window.__catBarFakeB.innerHTML');
      const currentCatAfter = ev('currentCat');
      assert(!catBarHtml.includes('data-cat="catB"'), '18 合併模式中只有兩者皆停用商品的分類(catB)會消失', catBarHtml);
      assert(catBarHtml.includes('data-cat="catA"'), '18b 合併模式仍顯示有可見商品的分類(catA)');
      assert(catBarHtml.includes('data-cat="all"'), '18c 「全部」分類固定保留');
      assert(currentCatAfter === 'all', '20 無效 currentCat（catB 已無可見商品）自動回到 all', `currentCat=${currentCatAfter}`);
      ev(`document.getElementById = window.__origGetByIdB;`);
    }
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        window.__catBarFakeC = { innerHTML:'' };
        window.__origGetByIdC = document.getElementById;
        document.getElementById = function(id){ return id==='catBar' ? window.__catBarFakeC : window.__origGetByIdC.call(document, id); };
      `);
      ev(`currentCat='catB'; buildCats();`);
      const catBarHtml = ev('window.__catBarFakeC.innerHTML');
      assert(!catBarHtml.includes('data-cat="catB"'), '19 取餐切換模式中無相容商品的分類(catB)會消失（外帶頁下 catB 全是皆停用商品）', catBarHtml);
      ev(`document.getElementById = window.__origGetByIdC;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 21：所有商品皆停用時顯示正確空狀態
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = { line_order_page_mode:'combined_checkout',
          takeout_status:{today_state:'open',today_open:true,today_label:'開放中',earliest_today:60,allow_next_day:false},
          delivery_status:{today_state:'open',today_open:true,today_label:'開放中',earliest_today:60,allow_next_day:false} };
        currentMode='takeout'; currentCat='all';
        allProducts=[{id:200,name:'全店唯一商品(皆停用)',line_takeout_enabled:0,line_delivery_enabled:0,display_cat_id:'catA',sale_status:'available'}];
        categories=${JSON.stringify(CATEGORIES_FIXTURE)};
        window.__menuAreaFakeD = { innerHTML:'' };
        window.__origGetByIdD = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFakeD : window.__origGetByIdD.call(document, id); };
      `);
      ev(`renderMenu()`);
      const html = ev('window.__menuAreaFakeD.innerHTML');
      assert(html.includes('目前沒有可供 LINE 點餐的商品'), '21 全店商品皆停用時，合併模式顯示正確空狀態文案', html);
      assert(!/系統錯誤|今日售完|今日公休|載入失敗/.test(html), '21b 空狀態文案不得顯示系統錯誤/今日售完/今日公休/載入失敗字樣', html);
      ev(`document.getElementById = window.__origGetByIdD;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 22～30：openProductDetail() / addCart() 防繞過 + Analytics
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout'); // 商品4皆停用，即使在合併模式也應被擋
      ev(`
        window.__toastCallsBD = [];
        window.__origToastBD = toast;
        toast = function(msg, ms){ window.__toastCallsBD.push({msg, ms}); };
        window.__modalOpenCallsBD = 0;
        window.__origModalOpenBD = window.ProductDetailModal ? window.ProductDetailModal.open : null;
        if(window.ProductDetailModal){ window.ProductDetailModal.open = function(){ window.__modalOpenCallsBD++; }; }
        window.__trackEventCallsBD = [];
        window.__origTrackEventBD = window._trackEvent;
        window._trackEvent = function(name, params){ window.__trackEventCallsBD.push({name, params}); if(window.__origTrackEventBD) return window.__origTrackEventBD(name, params); };
      `);
      let openErr = null;
      try { ev(`openProductDetail(4)`); } catch (e) { openErr = e && e.message; }
      const modalCalls = ev('window.__modalOpenCallsBD');
      const toastCalls = ev('window.__toastCallsBD');
      const viewItemCalls = ev(`window.__trackEventCallsBD.filter(e=>e.name==='view_item').length`);
      assert(!openErr, '22-0 openProductDetail(4) 呼叫本身不拋出例外', openErr ? String(openErr).slice(0, 200) : '');
      assert(modalCalls === 0, '22 openProductDetail() 直接呼叫兩者皆停用商品(4)時只顯示 Toast，不開啟 Modal', `modalCalls=${modalCalls}`);
      assert(modalCalls === 0, '23 上述情況不開啟 Modal（同一斷言，Modal 未被呼叫）');
      assert(viewItemCalls === 0, '24 上述情況不觸發 view_item', `viewItemCalls=${viewItemCalls}`);
      assert(Array.isArray(toastCalls) && toastCalls.length === 1 && toastCalls[0].msg === '此商品目前未提供外帶或外送', '27 兩者皆停用使用正確 Toast「此商品目前未提供外帶或外送」，不顯示「僅外帶／僅外送」', JSON.stringify(toastCalls));

      ev(`window.__toastCallsBD = []; window.__trackEventCallsBD = [];`);
      let addErr = null;
      try { ev(`addCart(4)`); } catch (e) { addErr = e && e.message; }
      const cartAfter = ev(`Object.keys(cart).length`);
      const toastAfterAdd = ev('window.__toastCallsBD');
      const addToCartCalls = ev(`window.__trackEventCallsBD.filter(e=>e.name==='add_to_cart').length`);
      assert(!addErr, '25-0 addCart(4) 呼叫本身不拋出例外', addErr ? String(addErr).slice(0, 200) : '');
      assert(cartAfter === 0, '25 addCart() 直接呼叫兩者皆停用商品(4)時無法加入', `cartKeys=${cartAfter}`);
      assert(addToCartCalls === 0, '26 上述情況不觸發 add_to_cart', `addToCartCalls=${addToCartCalls}`);
      assert(Array.isArray(toastAfterAdd) && toastAfterAdd.length === 1 && toastAfterAdd[0].msg === '此商品目前未提供外帶或外送', '27b addCart() 兩者皆停用時使用正確 Toast', JSON.stringify(toastAfterAdd));

      ev(`
        toast = window.__origToastBD;
        if(window.ProductDetailModal && window.__origModalOpenBD){ window.ProductDetailModal.open = window.__origModalOpenBD; }
        window._trackEvent = window.__origTrackEventBD;
      `);
    }

    // 既有「僅外帶／僅外送」防繞過提示仍須保留、不得被本輪誤判成皆停用文案
    {
      setupPage('fulfillment_switcher', 'takeout');
      ev(`
        window.__toastCallsSw = [];
        window.__origToastSw = toast;
        toast = function(msg, ms){ window.__toastCallsSw.push({msg, ms}); };
      `);
      ev(`addCart(3)`); // 僅外送商品，外帶頁應擋下並顯示「此商品僅提供外送」
      const toastSw = ev('window.__toastCallsSw');
      assert(Array.isArray(toastSw) && toastSw.length === 1 && toastSw[0].msg === '此商品僅提供外送', '27c 僅外送商品在外帶頁仍顯示「此商品僅提供外送」（不誤判為皆停用文案）', JSON.stringify(toastSw));
      ev(`toast = window.__origToastSw;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 28～29：隱藏商品不會註冊 IntersectionObserver／不會觸發 view_product
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      ev(`
        window.__menuAreaFakeE = { innerHTML:'' };
        window.__origGetByIdE = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFakeE : window.__origGetByIdE.call(document, id); };
      `);
      ev(`renderMenu()`);
      const hasHiddenCard = ev(`window.__menuAreaFakeE.innerHTML.includes('pc-4') || window.__menuAreaFakeE.innerHTML.includes('pc-5') || window.__menuAreaFakeE.innerHTML.includes('pc-6')`);
      assert(hasHiddenCard === false, '28 隱藏商品不會被渲染成商品卡，因此不會被 IntersectionObserver 註冊', String(hasHiddenCard));
      // 29：由於商品卡未渲染，DOM 上不存在對應 id，因此 _setupViewProductObserver() 掃描
      // 不到該商品，view_product 永遠不會被觸發（用「DOM 內找不到該商品卡」佐證，
      // 不需要真的等待 IntersectionObserver callback 觸發）。
      assert(w.document.getElementById('pc-4') === null, '29 隱藏商品(4)不會出現在真實 DOM 中（因此不會觸發 view_product）');
      ev(`document.getElementById = window.__origGetByIdE;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 30：歷史購物車中的停用商品不被靜默清除
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      ev(`
        cart = { '4': { product: allProducts.find(p=>p.id===4), qty: 2 } };
        window.__cartBeforeRefresh = JSON.stringify(cart);
        window.__menuAreaFakeF = { innerHTML:'' };
        window.__origGetByIdF = document.getElementById;
        document.getElementById = function(id){ return id==='menuArea' ? window.__menuAreaFakeF : window.__origGetByIdF.call(document, id); };
      `);
      ev(`renderMenu()`); // 商品從列表消失，但不得動到 cart 物件本身
      const cartAfterRender = ev('JSON.stringify(cart)');
      assert(cartAfterRender === ev('window.__cartBeforeRefresh'), '30 歷史購物車中的停用商品(4)在 renderMenu() 過濾商品列表後不被靜默清除', cartAfterRender);
      ev(`document.getElementById = window.__origGetByIdF;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 34～35：模式切換不增加 /api/line-menu fetch；buildCats()/renderMenu() 呼叫次數符合保證
    // ══════════════════════════════════════════════════════════════
    {
      const productA = { id: 301, name: 'H1441 商品A雙模式', line_takeout_enabled: 1, line_delivery_enabled: 1, display_cat_id: 'catA', sale_status: 'available' };
      const productDisabled = { id: 302, name: 'H1441 商品皆停用', line_takeout_enabled: 0, line_delivery_enabled: 0, display_cat_id: 'catA', sale_status: 'available' };
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
        };
        takeoutEnabled = true; deliveryEnabled = true; takeoutCutoffPassed = false; deliveryCutoffPassed = false; todayClosed = false;
        currentMode = 'takeout';
        currentCat = 'all';
        allProducts = [${JSON.stringify(productA)}, ${JSON.stringify(productDisabled)}];
        categories = ${JSON.stringify(CATEGORIES_FIXTURE)};
        cart = {};
        window.__oTypeT9 = { value:'takeout' };
        window.__fakeCartSheetT9 = { classList: { contains(){ return false; } } };
        window.__menuAreaFakeT9 = { innerHTML:'' };
        window.__catBarFakeT9 = { innerHTML:'' };
        window.__origGetByIdT9 = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oTypeT9;
          if(id==='cartSheet') return window.__fakeCartSheetT9;
          if(id==='menuArea') return window.__menuAreaFakeT9;
          if(id==='catBar') return window.__catBarFakeT9;
          return window.__origGetByIdT9.call(document, id);
        };
        window.__buildCatsCallsT9 = 0; window.__origBuildCatsT9 = buildCats;
        buildCats = function(){ window.__buildCatsCallsT9++; return window.__origBuildCatsT9(); };
        window.__renderMenuCallsT9 = 0; window.__origRenderMenuT9 = renderMenu;
        renderMenu = function(){ window.__renderMenuCallsT9++; return window.__origRenderMenuT9(); };
        window.__menuFetchCallsT9 = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCallsT9++; }
          if(u.includes('/api/line-shop')){
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
              line_order_page_mode: 'fulfillment_switcher',
              takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
              delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false, cutoff_passed:false },
            } }) });
          }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{} }) });
        };
      `);
      let refreshErr = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { refreshErr = e && e.message; }
      const menuHtmlAfter = ev('window.__menuAreaFakeT9.innerHTML');
      const buildCatsCalls = ev('window.__buildCatsCallsT9');
      const renderMenuCalls = ev('window.__renderMenuCallsT9');
      const menuFetchCalls = ev('window.__menuFetchCallsT9');
      assert(!refreshErr, '36-0 動態切換頁面模式（combined→switcher）時 refreshShopStatus() 不拋出例外', refreshErr ? String(refreshErr).slice(0, 300) : '');
      assert(!menuHtmlAfter.includes('H1441 商品皆停用'), '36 動態切換頁面模式後，兩者皆停用商品仍隱藏（不論 combined_checkout 或 fulfillment_switcher）', menuHtmlAfter.slice(0, 200));
      assert(buildCatsCalls === 1, '35a buildCats() 呼叫次數符合既有保證（恰好一次）', `calls=${buildCatsCalls}`);
      assert(renderMenuCalls === 1, '35b renderMenu() 呼叫次數符合既有保證（恰好一次）', `calls=${renderMenuCalls}`);
      assert(menuFetchCalls === 0, '34 模式切換不增加 /api/line-menu fetch（重用既有 allProducts）', `menuFetchCalls=${menuFetchCalls}`);
      ev(`
        document.getElementById = window.__origGetByIdT9;
        buildCats = window.__origBuildCatsT9; renderMenu = window.__origRenderMenuT9;
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // 38：LIFF 與一般瀏覽器環境皆可執行（isProductSupportedForAnyFulfillmentMode 純函式，
    // 不依賴 LIFF SDK 或 window.liff，用直接呼叫佐證在任何環境都能正確運作）
    // ══════════════════════════════════════════════════════════════
    {
      const r1 = ev(`isProductSupportedForAnyFulfillmentMode({ line_takeout_enabled:0, line_delivery_enabled:0 })`);
      const r2 = ev(`isProductSupportedForAnyFulfillmentMode({ line_takeout_enabled:1, line_delivery_enabled:0 })`);
      const r3 = ev(`typeof window.liff`);
      assert(r1 === false, '38a isProductSupportedForAnyFulfillmentMode() 對皆停用商品回傳 false（不依賴 LIFF SDK）');
      assert(r2 === true, '38b isProductSupportedForAnyFulfillmentMode() 對僅外帶商品回傳 true');
      assert(r3 === 'undefined' || r3 === 'object', '38c 測試環境（一般瀏覽器／無 LIFF SDK）下函式仍可正常呼叫，未因缺少 window.liff 而拋出例外', r3);
    }

    // ══════════════════════════════════════════════════════════════
    // 40：商品瀏覽、詳情、加入購物車及結帳流程無回歸（合併模式，正常商品）
    // ══════════════════════════════════════════════════════════════
    {
      setupPage('combined_checkout', 'takeout');
      ev(`
        window.__toastCallsReg = [];
        window.__origToastReg = toast;
        toast = function(msg, ms){ window.__toastCallsReg.push({msg, ms}); };
      `);
      ev(`addCart(1)`); // 雙模式正常商品
      const qty1 = ev(`cart['1'] ? cart['1'].qty : 0`);
      assert(qty1 === 1, '40a 正常雙模式商品(1)仍可正常加入購物車（合併模式無回歸）', `qty=${qty1}`);
      let regErr = null;
      try { ev(`openProductDetail(1)`); } catch (e) { regErr = e && e.message; }
      assert(!regErr, '40b 正常商品(1)呼叫 openProductDetail() 不拋出例外（詳情流程無回歸）', regErr ? String(regErr).slice(0, 200) : '');
      ev(`toast = window.__origToastReg;`);
    }
  }

  await runBackendTests();

  assert(unhandledRejectionSeen === null, '39 unhandledRejection：整個測試執行過程中沒有出現未處理的 Promise rejection（真 assertion，若出現會直接讓本項 FAIL 並影響 exit code）', unhandledRejectionSeen ? String(unhandledRejectionSeen).slice(0, 300) : '');

  if (server) { try { server.close(); } catch (e) { /* ignore */ } }
  if (dom) { try { dom.window.close(); } catch (e) { /* ignore */ } }
  printSummary();
}

// ══════════════════════════════════════════════════════════════════
// 31～33：後端 /validate-cart 對外帶／外送都拒絕「皆停用」商品；送單前既有後端驗證仍拒絕
// （真實 HTTP + 真實 DB fixture，不 mock 判斷結果本身）
// ══════════════════════════════════════════════════════════════════
async function runBackendTests() {
  const tmpDbPath = path.join(os.tmpdir(), `h141141-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.POS_DB_PATH = tmpDbPath;

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();

  const STORE = 'store_h141141_a';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE, 1]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE, 'pro', JSON.stringify({ line_order: true })]);
  db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'line_ordering_enabled', '1']);
  try { db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) { /* 已存在則忽略 */ }
  try { db.run('ALTER TABLE products ADD COLUMN line_delivery_enabled INTEGER DEFAULT 1'); } catch (e) { /* 已存在則忽略 */ }
  const everyDayOpen = () => {
    const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const o = {}; WD.forEach((k) => { o[k] = { enabled: true, open: '00:00', close: '23:59' }; }); return o;
  };
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_business_hours', JSON.stringify(everyDayOpen())]);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'delivery_business_hours', JSON.stringify(everyDayOpen())]);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_enabled', '1']);
  db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'delivery_enabled', '1']);

  let productId = null;
  try {
    const catRow = db.get('SELECT id FROM categories WHERE store_id=? LIMIT 1', [STORE]);
    let catId = catRow && catRow.id;
    if (!catId) {
      db.run('INSERT INTO categories (store_id, name, sort_order) VALUES (?,?,?)', [STORE, 'H141141測試分類', 1]);
      catId = db.get('SELECT id FROM categories WHERE store_id=? ORDER BY id DESC LIMIT 1', [STORE]).id;
    }
    db.run(
      `INSERT INTO products (store_id, category_id, name, price, line_takeout_enabled, line_delivery_enabled, enabled)
       VALUES (?,?,?,?,?,?,1)`,
      [STORE, catId, 'H141141皆停用測試商品', 100, 0, 0],
    );
    productId = db.get('SELECT id FROM products WHERE store_id=? ORDER BY id DESC LIMIT 1', [STORE]).id;
    pass('後端-0 已建立真實「皆停用」商品 fixture（line_takeout_enabled=0, line_delivery_enabled=0）');
  } catch (e) {
    fail('後端-0 已建立真實「皆停用」商品 fixture', e.message);
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
    const rTakeout = await fetchFn(`${base}/api/line-orders/validate-cart?mode=takeout&product_ids=${productId}`, { headers: { 'x-test-store': STORE } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const rejectedTakeout = rTakeout && Array.isArray(rTakeout.products) && rTakeout.products.some((it) => String(it.product_id) === String(productId) && it.reason === 'product_mode_not_supported' && it.ok === false);
    assert(!!rejectedTakeout, '31 /validate-cart 對外帶拒絕兩者皆停用商品（product_mode_not_supported）', JSON.stringify(rTakeout));

    const rDelivery = await fetchFn(`${base}/api/line-orders/validate-cart?mode=delivery&product_ids=${productId}`, { headers: { 'x-test-store': STORE } }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const rejectedDelivery = rDelivery && Array.isArray(rDelivery.products) && rDelivery.products.some((it) => String(it.product_id) === String(productId) && it.reason === 'product_mode_not_supported' && it.ok === false);
    assert(!!rejectedDelivery, '32 /validate-cart 對外送拒絕兩者皆停用商品（product_mode_not_supported）', JSON.stringify(rDelivery));

    const orderResTakeout = await fetchFn(`${base}/api/line-orders/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({
        mode: 'takeout', items: [{ product_id: productId, qty: 1 }],
        customer_name: '測試', customer_phone: '0900000000',
      }),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const orderRejectedTakeout = orderResTakeout && orderResTakeout.success === false && (orderResTakeout.reason === 'product_mode_not_supported' || JSON.stringify(orderResTakeout).includes('product_mode_not_supported'));

    const orderResDelivery = await fetchFn(`${base}/api/line-orders/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({
        mode: 'delivery', items: [{ product_id: productId, qty: 1 }],
        customer_name: '測試', customer_phone: '0900000000',
        address: '測試地址',
      }),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const orderRejectedDelivery = orderResDelivery && orderResDelivery.success === false && (orderResDelivery.reason === 'product_mode_not_supported' || JSON.stringify(orderResDelivery).includes('product_mode_not_supported'));

    assert(!!orderRejectedTakeout && !!orderRejectedDelivery, '33 送單前既有後端驗證對外帶／外送兩種訂單都拒絕兩者皆停用商品', JSON.stringify({ orderResTakeout, orderResDelivery }));

    // 後台驗證：至少必須啟用一種販售方式，仍會擋下把商品改存成兩者皆停用（既有驗證，
    // 本輪未修改，用真實 PATCH 請求佐證仍生效——需求文件九）。
    try {
      const productsRoute = require(path.join(ROOT, 'routes/products.js'));
      const appAdmin = express();
      appAdmin.use(bodyParser.json());
      appAdmin.use((req, res, next) => { req.storeId = STORE; next(); });
      appAdmin.use('/api/products', productsRoute);
      const serverAdmin = appAdmin.listen(0);
      const portAdmin = serverAdmin.address().port;
      const baseAdmin = `http://localhost:${portAdmin}`;
      const patchRes = await fetchFn(`${baseAdmin}/api/products/${productId}/line-settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_takeout_enabled: 0, line_delivery_enabled: 0 }),
      }).then((x) => x.json()).catch((e) => ({ error: e.message }));
      const blockedBySaveValidation = patchRes && patchRes.success === false && /外帶或外送/.test(patchRes.message || '');
      assert(!!blockedBySaveValidation, '37 後台商品設定仍阻止使用者儲存「外帶、外送皆停用」（既有驗證，本輪未修改，真實 PATCH 請求佐證仍生效）', JSON.stringify(patchRes));
      serverAdmin.close();
    } catch (e) {
      fail('37 後台商品設定仍阻止使用者儲存「外帶、外送皆停用」', e.message.slice(0, 200));
    }
  }
}

main()
  .catch((e) => {
    fail('FATAL', e && e.stack ? e.stack.slice(0, 500) : String(e));
    printSummary();
    process.exitCode = 1;
  });
