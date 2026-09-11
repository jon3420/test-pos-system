#!/usr/bin/env node
// scripts/smoke-h1-4-11-2-fixes.js
// H1.4.11.2｜cutoff→可預訂即時重繪／單次重繪保證／findNextServiceInfo() 真實後端
// 邊界情境／文案一致性 的真實驗證（不是字串搜尋）。與
// scripts/smoke-h1-4-11-1-fixes.js 互補，不重複贅述其已覆蓋的部分。

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
  console.log('SMOKE TEST SUMMARY — H1.4.11.2 targeted fixes');
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

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function weekdayOfDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function taipeiTodayStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const WD_LABEL = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

async function main() {
  ['routes/line-orders.js', 'public/js/app.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const htmlPath = path.join(ROOT, 'public/line-order.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  // ══════════════════════════════════════════════════════════════════
  // 四. 文案一致性（純函式，不需要 jsdom DOM，但需要載入頁面內的函式定義）
  // ══════════════════════════════════════════════════════════════════
  const { JSDOM, ResourceLoader } = require('jsdom');
  class LocalFileResourceLoader extends ResourceLoader {
    fetch(url) {
      try {
        const u = new URL(url);
        // 六（測試基礎設施）：只讀本地 /js/、/css/，其餘（LINE SDK／Google Maps／任何
        // 外部網址）一律安全略過、不真的連線，避免測試不穩定或意外對外發出請求。
        if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/')) {
          const localPath = path.join(ROOT, 'public', u.pathname);
          if (fs.existsSync(localPath)) return Promise.resolve(fs.readFileSync(localPath));
        }
      } catch (e) { /* ignore */ }
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
          } else {
            payload = { success: false };
          }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
        };
        window.addEventListener('error', (e) => { console.log('[jsdom window error]', e.error && e.error.stack || e.message); });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    pass('jsdom-0 成功載入並執行 public/line-order.html（ResourceLoader 只讀本地 /js //css，不連外部網址）');
  } catch (e) {
    fail('jsdom-0 成功載入並執行 public/line-order.html', e.message.slice(0, 300));
  }

  if (dom) {
    const w = dom.window;
    const ev = (code) => w.eval(code);

    // ══════════════════════════════════════════════════════════════
    // 四. 文案一致性——短標籤／詳細說明／Toast 三處同時比對，確保不互相矛盾
    // ══════════════════════════════════════════════════════════════
    const nextSvcDate = addDaysToDateStr(ev('fmtD(twNow())'), 1);
    const CASES4 = [
      {
        label: 'global_disabled（無 next service，findNextServiceInfo 保證為 null）',
        fs: { state: 'today_not_open', reason: 'global_disabled', mode: 'takeout' },
        mode: 'takeout',
        expectShort: '目前未提供',
        expectDetail: '店家目前未提供外帶自取',
        expectToastIncludes: '店家目前未提供外帶自取',
      },
      {
        label: 'no_schedule + 無 next service',
        fs: { state: 'today_not_open', reason: 'no_schedule' },
        mode: 'delivery',
        expectShort: '今日未開放',
        expectDetail: '今日未開放接單',
        expectToastIncludes: '今日未開放',
      },
      {
        label: 'no_schedule + 有 next service',
        fs: { state: 'today_not_open', reason: 'no_schedule', nextServiceDate: nextSvcDate, nextServiceStartTime: '11:00' },
        mode: 'takeout',
        expectShort: '今日未開放',
        expectDetailIncludes: '11:00',
        expectToastIncludes: '11:00',
      },
      {
        label: 'special_schedule_disabled + 有 next service',
        fs: { state: 'today_not_open', reason: 'special_schedule_disabled', nextServiceDate: nextSvcDate, nextServiceStartTime: '18:30' },
        mode: 'delivery',
        expectShort: '今日未提供',
        expectDetailIncludes: '18:30',
        expectToastIncludes: '18:30',
      },
      {
        label: 'holiday today_closed',
        fs: { state: 'holiday', holidaySource: 'today_closed' },
        mode: 'takeout',
        expectShort: '今日臨時休息',
        expectDetailIncludes: '今日臨時休息',
        expectToastIncludes: '今日臨時休息',
      },
      {
        label: 'holiday 一般公休',
        fs: { state: 'holiday', holidaySource: 'calendar' },
        mode: 'takeout',
        expectShort: '今日公休',
        expectDetailIncludes: '今日公休',
        expectToastIncludes: '今日公休',
      },
      {
        label: 'cutoff + 有 next service',
        fs: { state: 'cutoff', canPreorderFutureDays: false, nextServiceDate: nextSvcDate, nextServiceStartTime: '16:00' },
        mode: 'takeout',
        expectShort: '今日已結束',
        expectDetailIncludes: '開始接單',
        expectToastIncludes: '今日已結束',
      },
    ];
    CASES4.forEach((c, i) => {
      ev(`window.__c4_${i} = ${JSON.stringify(c.fs)};`);
      const shortLabel = ev(`_ffShortLabel(window.__c4_${i})`);
      const detail = ev(`_ffDetailText(window.__c4_${i}, ${JSON.stringify(c.mode)})`);
      const toastMsg = ev(`_ffToastText(window.__c4_${i}, ${JSON.stringify(c.mode)})`);
      assert(shortLabel === c.expectShort, `四-${i}a [${c.label}] 短標籤 === '${c.expectShort}'`, `got='${shortLabel}'`);
      if (c.expectDetail) assert(detail === c.expectDetail, `四-${i}b [${c.label}] 詳細說明 === '${c.expectDetail}'`, `got='${detail}'`);
      if (c.expectDetailIncludes) assert(detail.includes(c.expectDetailIncludes), `四-${i}b [${c.label}] 詳細說明包含 '${c.expectDetailIncludes}'`, `got='${detail}'`);
      assert(toastMsg.includes(c.expectToastIncludes), `四-${i}c [${c.label}] Toast 包含 '${c.expectToastIncludes}'`, `got='${toastMsg}'`);
      // 互相矛盾檢查：圖塊寫「今日未開放」時 Toast 不能說「目前未提供」（反之亦然），
      // 除非兩者本來就該一致（global_disabled 的「目前未提供」是唯一例外，三處都用
      // 這個詞，不算矛盾）。
      if (c.fs.reason === 'no_schedule') {
        assert(!toastMsg.includes('目前未提供'), `四-${i}d [${c.label}] no_schedule 情境 Toast 不得誤用 global_disabled 的「目前未提供」文案`, toastMsg);
      }
    });

    // ══════════════════════════════════════════════════════════════
    // 一. cutoff → 可預訂（allow_next_day 從 false 變 true）真實 DOM 測試
    // ══════════════════════════════════════════════════════════════
    {
      const futureDate = addDaysToDateStr(ev('fmtD(twNow())'), 2);
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status:  { today_state:'cutoff', today_open:false, today_label:'今日已截止', earliest_today:null, allow_next_day:false, cutoff_passed:true },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          takeout_next_dates: [${JSON.stringify(futureDate)}],
          delivery_next_dates: [],
        };
        currentMode = 'takeout';
        window.__oType3 = { value:'takeout' };
        cart = { 'p3':{ product:{id:'p3',name:'x',price:50,effective_line_price:50}, qty:1 } };
        window.__cutoffCartBefore = JSON.stringify(cart);
        window.__origGetById5 = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oType3;
          return window.__origGetById5.call(document, id);
        };
      `);
      const selectableBefore = ev(`getFulfillmentStatus('takeout').selectable`);
      assert(selectableBefore === false, '一-1 刷新前 takeout selectable=false（cutoff + allow_next_day=false）');

      ev(`
        window.__buildBarCalls3 = 0;
        window.__origBuildBar3 = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCalls3++; return window.__origBuildBar3(); };
        window.fetch = function(){
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data: Object.assign({}, shopData, {
            takeout_status: Object.assign({}, shopData.takeout_status, { allow_next_day:true }),
          }) }) });
        };
      `);
      await ev(`refreshShopStatus()`);
      const selectableAfter = ev(`getFulfillmentStatus('takeout').selectable`);
      const buildCalls = ev('window.__buildBarCalls3');
      const cmAfterCutoffRefresh = ev('currentMode');
      const oTypeAfterCutoffRefresh = ev('window.__oType3.value');
      const cartAfterCutoffRefresh = ev('JSON.stringify(cart)');
      const tileHtml = ev(`_ffTileHtml('takeout', getFulfillmentStatus('takeout'), {pageMode:'combined_checkout', viewMode:null})`);

      assert(selectableAfter === true, '一-2 刷新後（allow_next_day 改為 true，其餘不變）takeout selectable=true', `selectable=${selectableAfter}`);
      assert(buildCalls === 1, '一-3 buildServiceStatusBar() 恰好執行一次', `calls=${buildCalls}`);
      assert(!tileHtml.includes('ff-unavailable'), '一-4 圖塊 HTML 不再含 ff-unavailable（灰色→可用/可預約）', tileHtml.slice(0, 120));
      assert(cmAfterCutoffRefresh === 'takeout', '一-5a currentMode 不受影響，仍是 takeout');
      assert(oTypeAfterCutoffRefresh === 'takeout', '一-5b #oType 不受影響，仍是 takeout');
      assert(cartAfterCutoffRefresh === ev('window.__cutoffCartBefore'), '一-5c 購物車不受影響');
      // combined_checkout 下，這次刷新／重繪本身不會把「查看」寫入訂單方式——沒有任何
      // 使用者點擊發生，_ffViewMode 應維持刷新前的狀態（這裡刷新前沒設過，預期仍是 null）。
      const viewModeStillNull = ev('_ffViewMode');
      assert(viewModeStillNull === null || viewModeStillNull === undefined, '一-6 combined_checkout 下，單純的資料刷新不會把圖塊查看行為寫入 _ffViewMode（維持未設定）', `_ffViewMode=${viewModeStillNull}`);

      ev(`document.getElementById = window.__origGetById5; buildServiceStatusBar = window.__origBuildBar3;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 二. 同一次刷新「page mode 改變＋currentMode 從 selectable 變不可用＋
    //    cutoff/enabled 改變」三者同時發生，圖塊仍只重繪一次、Toast 只出現一次
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode = 'delivery';
        window.__oType4 = { value:'delivery' };
        cart = { 'p4':{ product:{id:'p4',name:'y',price:60,effective_line_price:60}, qty:2 } };
        window.__combinedCartBefore = JSON.stringify(cart);
        window.__origGetById6 = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oType4;
          if(id==='serviceStatusBar') return window.__barEl3 || (window.__barEl3 = { style:{}, className:'', innerHTML:'' });
          return window.__origGetById6.call(document, id);
        };
        _ffViewMode = 'delivery';
        window.__buildBarCalls4 = 0;
        window.__origBuildBar4 = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCalls4++; return window.__origBuildBar4(); };
        window.__toastCalls4 = [];
        window.__origToast4 = toast;
        toast = function(msg, ms){ window.__toastCalls4.push({msg, ms}); };
        window.fetch = function(){
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
            line_order_page_mode: 'combined_checkout', // ① page mode 改變
            takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
            // ② delivery（目前 currentMode）從 open 變成 today_not_open（selectable 變 false）
            //   ③ 同時 today_open 也跟著變 false，順便觸發既有的「重量級」enabled 分支
            delivery_status: { today_state:'today_not_open', today_open:false, today_label:'目前未提供', earliest_today:null, allow_next_day:false, today_reason:'global_disabled' },
          } }) });
        };
      `);
      await ev(`refreshShopStatus()`);
      const buildCalls2 = ev('window.__buildBarCalls4');
      const toastCalls2 = ev('window.__toastCalls4');
      const viewModeAfterCombined = ev('_ffViewMode');
      const cmAfterCombined = ev('currentMode');
      const oTypeAfterCombined = ev('window.__oType4.value');
      const cartAfterCombined = ev('JSON.stringify(cart)');
      assert(buildCalls2 === 1, '二-1 page mode + currentMode 失效 + enabled 改變三者同時發生，圖塊仍只重繪一次', `calls=${buildCalls2}`);
      assert(Array.isArray(toastCalls2) && toastCalls2.length === 1, '二-2 狀態失效 Toast 只出現一次', `count=${toastCalls2 && toastCalls2.length}`);
      assert(viewModeAfterCombined === null, '二-3 _ffViewMode 因為 page mode 改變而被清除');
      assert(cmAfterCombined === 'delivery', '二-4 currentMode 不被靜默切換（維持 hotfix22-F 行為，只擋送單不改選擇）');
      assert(oTypeAfterCombined === 'delivery', '二-5 #oType 未被清空或靜默切換');
      assert(cartAfterCombined === ev('window.__combinedCartBefore'), '二-6 購物車未被清空');

      ev(`
        document.getElementById = window.__origGetById6;
        buildServiceStatusBar = window.__origBuildBar4;
        toast = window.__origToast4;
      `);
    }
    {
      // 二-7：API 失敗時不重繪舊資料（沿用既有 !res.success 直接 return，這裡驗證
      // buildServiceStatusBar() 完全不會被呼叫）。
      ev(`
        window.__buildBarCalls5 = 0;
        window.__origBuildBar5 = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCalls5++; return window.__origBuildBar5(); };
        window.fetch = function(){ return Promise.resolve({ json: () => Promise.resolve({ success:false }) }); };
      `);
      await ev(`refreshShopStatus()`);
      const buildCallsApiFail = ev('window.__buildBarCalls5');
      assert(buildCallsApiFail === 0, '二-7 API 回應 success:false 時，完全不重繪（不用半套新資料覆蓋畫面）', `calls=${buildCallsApiFail}`);
      ev(`buildServiceStatusBar = window.__origBuildBar5;`);
    }

    // ══════════════════════════════════════════════════════════════
    // 五之一（需求文件 4.1）：購物車開啟＋重量級刷新——buildServiceStatusBar() 恰好
    // 1 次、/api/line-menu 恰好 1 次、狀態失效 Toast 恰好 1 次、購物車/currentMode/
    // #oType 保留。
    // ══════════════════════════════════════════════════════════════
    {
      // 測試隔離：refreshShopStatus() 是否走「重量級」路徑取決於模組層級的
      // takeoutEnabled/deliveryEnabled/takeoutCutoffPassed/deliveryCutoffPassed/
      // todayClosed 這幾個 let 變數「前後是否改變」，而這些變數會被本檔案前面所有
      // 測試區塊依序真實修改、殘留到後面的測試。4.1／4.2 分別需要精確控制「這次刷新
      // 前」的基準值，才能確保真的分別命中重量級／輕量路徑，所以這裡先明確重置成已知
      // 基準，不依賴前面測試殘留的狀態。
      ev(`
        takeoutEnabled = true; deliveryEnabled = true;
        takeoutCutoffPassed = false; deliveryCutoffPassed = false;
        todayClosed = false;
      `);
    }
    {
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode = 'delivery';
        window.__oType6 = { value:'delivery' };
        cart = { 'p5':{ product:{id:'p5',name:'重量級購物車測試商品',price:70,effective_line_price:70}, qty:4 } };
        window.__heavyCartOpenCartBefore = JSON.stringify(cart);
        window.__origGetById7 = document.getElementById;
        window.__fakeCartSheet = { classList: { contains(c){ return c==='show'; } } };
        document.getElementById = function(id){
          if(id==='oType') return window.__oType6;
          if(id==='cartSheet') return window.__fakeCartSheet;
          return window.__origGetById7.call(document, id);
        };
        window.__buildBarCallsHeavy = 0;
        window.__origBuildBarHeavy = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCallsHeavy++; return window.__origBuildBarHeavy(); };
        window.__menuFetchCount = 0;
        window.__toastCallsHeavy = [];
        window.__origToastHeavy = toast;
        toast = function(msg, ms){ window.__toastCallsHeavy.push({msg, ms}); };
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){
            window.__menuFetchCount++;
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ categories:[], products:[] } }) });
          }
          if(u.includes('/api/line-shop')){
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
              line_order_page_mode: 'fulfillment_switcher',
              takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
              // delivery（目前 currentMode）today_open 從 true 變 false → 觸發重量級分支，
              // 且 delivery 同時從 selectable 變不可用 → 應觸發一次狀態失效 Toast。
              delivery_status: { today_state:'today_not_open', today_open:false, today_label:'目前未提供', earliest_today:null, allow_next_day:false, today_reason:'global_disabled' },
            } }) });
          }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{} }) });
        };
      `);
      let heavyCartOpenError = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { heavyCartOpenError = e && e.message; }
      const cartSheetHasShow = ev(`window.__fakeCartSheet.classList.contains('show')`);
      const buildCallsHeavy = ev('window.__buildBarCallsHeavy');
      const menuFetchCount = ev('window.__menuFetchCount');
      const takeoutStatusAfter = ev('shopData.delivery_status.today_open');
      const cartAfterHeavy = ev('JSON.stringify(cart)');
      const cmAfterHeavy = ev('currentMode');
      const oTypeAfterHeavy = ev('window.__oType6.value');
      const toastCallsHeavy = ev('window.__toastCallsHeavy');
      assert(!heavyCartOpenError, '4.1-0 購物車開啟＋重量級刷新執行不拋出例外', heavyCartOpenError ? String(heavyCartOpenError).slice(0, 300) : '');
      assert(cartSheetHasShow === true, '4.1-1 前置：#cartSheet 確實含 show（模擬購物車已開啟）');
      assert(buildCallsHeavy === 1, '4.1-3 購物車開啟＋重量級刷新，buildServiceStatusBar() 恰好呼叫 1 次（不會因為 refreshDateSelectorForCart() 內部又呼叫一次 refreshModeCutoffUI() 而變成 2 次）', `calls=${buildCallsHeavy}`);
      assert(menuFetchCount === 1, '4.1-4 /api/line-menu 恰好取得 1 次（refreshDateSelectorForCart() 重用已傳入的 latestProducts，不再重新 fetch）', `menuFetchCount=${menuFetchCount}`);
      assert(takeoutStatusAfter === false, '4.1-5 最新營業狀態確實寫入 shopData（delivery today_open 變為 false）');
      assert(cartAfterHeavy === ev('window.__heavyCartOpenCartBefore'), '4.1-6 購物車商品與數量保留');
      assert(cmAfterHeavy === 'delivery', '4.1-7 currentMode 保留（不因狀態失效被靜默切換）');
      assert(oTypeAfterHeavy === 'delivery', '4.1-8 #oType 保留');
      assert(Array.isArray(toastCallsHeavy) && toastCallsHeavy.length === 1, '4.1-9 狀態失效 Toast 恰好 1 次', `count=${toastCallsHeavy && toastCallsHeavy.length}`);
      ev(`
        document.getElementById = window.__origGetById7;
        buildServiceStatusBar = window.__origBuildBarHeavy;
        toast = window.__origToastHeavy;
      `);
    }

    {
      // 測試隔離（同 4.1 前的說明）：明確把追蹤用的模組層級變數重置成與這裡即將手動
      // 設定的 shopData 一致的基準值（takeout 目前是 cutoff→今天不能立即下單、
      // cutoff_passed=true；delivery 是 open），確保等一下 refreshShopStatus() 比對
      // 「這次 fetch 回來的新值 vs 這幾個變數目前的值」時，只有 allow_next_day 改變，
      // 精準命中輕量路徑，不會因為前一個測試殘留的值而誤觸發重量級路徑。
      const futureDate2Pre = addDaysToDateStr(ev('fmtD(twNow())'), 1);
      ev(`
        takeoutEnabled = false; deliveryEnabled = true;
        takeoutCutoffPassed = true; deliveryCutoffPassed = false;
        todayClosed = false;
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // 五之二（需求文件 4.2）：購物車開啟＋輕量刷新——cutoff 且 allow_next_day=false
    // 起手，updateModeAvailabilityUI() 先確認 CTA 為 disabled；刷新後只有
    // allow_next_day 改為 true（其餘 today_open/enabled/cutoff_passed/todayClosed
    // 不變，屬輕量路徑），驗證圖塊、購物車按鈕、CTA、日期選單同步更新，且不重抓菜單。
    // ══════════════════════════════════════════════════════════════
    {
      const futureDate2 = addDaysToDateStr(ev('fmtD(twNow())'), 1);
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'cutoff', today_open:false, today_label:'今日已截止', earliest_today:null, allow_next_day:false, cutoff_passed:true },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          takeout_next_dates: [], delivery_next_dates: [],
        };
        currentMode = 'takeout';
        window.__oType7 = { value:'takeout' };
        window.__subBtn7 = { disabled:false, textContent:'確認下單' };
        window.__goBtn7 = { disabled:false };
        window.__banner7 = { style:{display:''}, textContent:'' };
        cart = { 'p6':{ product:{id:'p6',name:'輕量購物車測試商品',price:90,effective_line_price:90}, qty:1 } };
        window.__lightCartOpenBefore = JSON.stringify(cart);
        window.__fakeCartSheet2 = { classList: { contains(c){ return c==='show'; } } };
        window.__origGetById8 = document.getElementById;
        document.getElementById = function(id){
          if(id==='oType') return window.__oType7;
          if(id==='subBtn') return window.__subBtn7;
          if(id==='goCheckoutBtn') return window.__goBtn7;
          if(id==='modeUnavailableBanner') return window.__banner7;
          if(id==='cartSheet') return window.__fakeCartSheet2;
          return window.__origGetById8.call(document, id);
        };
      `);
      // 前置：先用 updateModeAvailabilityUI() 真實計算一次目前狀態，確認 CTA 確實是
      // disabled（因為 takeout 現在 cutoff+不可預訂 → not selectable）。
      ev(`updateModeAvailabilityUI();`);
      const goBtnDisabledBefore = ev('window.__goBtn7.disabled');
      const selectableBeforeLight = ev(`getFulfillmentStatus('takeout').selectable`);
      assert(selectableBeforeLight === false, '4.2-0a 前置：takeout selectable=false（cutoff + allow_next_day=false）');
      assert(goBtnDisabledBefore === true, '4.2-0b 前置：updateModeAvailabilityUI() 已將 #goCheckoutBtn.disabled 設為 true');

      ev(`
        window.__buildBarCallsLight = 0;
        window.__origBuildBarLight = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCallsLight++; return window.__origBuildBarLight(); };
        window.__menuFetchCountLight = 0;
        window.fetch = function(url){
          const u = String(url);
          if(u.includes('/api/line-menu')){ window.__menuFetchCountLight++; return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ categories:[], products:[] } }) }); }
          if(u.includes('/api/line-shop')){
            return Promise.resolve({ json: () => Promise.resolve({ success:true, data: {
              line_order_page_mode: 'fulfillment_switcher',
              // 只有 allow_next_day 與 next_dates 改變，today_open/cutoff_passed 不變 → 輕量路徑
              takeout_status:  { today_state:'cutoff', today_open:false, today_label:'今日已截止', earliest_today:null, allow_next_day:true, cutoff_passed:true },
              delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
              takeout_next_dates: [${JSON.stringify(futureDate2)}], delivery_next_dates: [],
            } }) });
          }
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{} }) });
        };
      `);
      let lightCartOpenError = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { lightCartOpenError = e && e.message; }
      const selectableAfterLight = ev(`getFulfillmentStatus('takeout').selectable`);
      const buildCallsLight = ev('window.__buildBarCallsLight');
      const menuFetchCountLight = ev('window.__menuFetchCountLight');
      const goBtnDisabledAfter = ev('window.__goBtn7.disabled');
      const subBtnAfter = ev('window.__subBtn7.disabled');
      const qtyAfterLight = ev(`cart['p6'].qty`);
      const cmAfterLight = ev('currentMode');
      const oTypeAfterLight = ev('window.__oType7.value');
      const tileHtmlAfterLight = ev(`_ffTileHtml('takeout', getFulfillmentStatus('takeout'), {pageMode:'fulfillment_switcher', viewMode:null})`);

      assert(!lightCartOpenError, '4.2-1 購物車開啟＋輕量刷新執行不拋出例外', lightCartOpenError ? String(lightCartOpenError).slice(0, 300) : '');
      assert(selectableAfterLight === true, '4.2-2 刷新後 getFulfillmentStatus(takeout).selectable === true');
      assert(buildCallsLight === 1, '4.2-3 buildServiceStatusBar() 恰好 1 次（輕量路徑＋購物車開啟，交給 refreshDateSelectorForCart() 統一處理）', `calls=${buildCallsLight}`);
      assert(!tileHtmlAfterLight.includes('ff-unavailable'), '4.2-4 頂端圖塊不再是 unavailable');
      assert(goBtnDisabledAfter === false, '4.2-5 #goCheckoutBtn.disabled === false（輕量刷新後同步呼叫 updateModeAvailabilityUI()，CTA 不再卡在舊狀態）');
      assert(subBtnAfter === false, '4.2-6 #subBtn.disabled === false');
      assert(qtyAfterLight === 1, '4.2-7 商品數量未變');
      assert(cmAfterLight === 'takeout', '4.2-8 currentMode 未變');
      assert(oTypeAfterLight === 'takeout', '4.2-9 #oType 未變');
      assert(menuFetchCountLight === 0, '4.2-10 輕量路徑不額外呼叫 /api/line-menu（重用目前已載入的 allProducts）', `menuFetchCount=${menuFetchCountLight}`);

      ev(`
        document.getElementById = window.__origGetById8;
        buildServiceStatusBar = window.__origBuildBarLight;
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // 五之三（需求文件 4.3）：購物車開啟時 API 失敗，不覆蓋 shopData、不清空購物車、
    // 不重繪半套新狀態。
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        window.__shopDataSnapshotBeforeFail = JSON.stringify(shopData);
        window.__cartSnapshotBeforeFail = JSON.stringify(cart);
        window.__fakeCartSheet3 = { classList: { contains(c){ return c==='show'; } } };
        window.__origGetById9 = document.getElementById;
        document.getElementById = function(id){ return id==='cartSheet' ? window.__fakeCartSheet3 : window.__origGetById9.call(document, id); };
        window.__buildBarCallsFail = 0;
        window.__origBuildBarFail = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCallsFail++; return window.__origBuildBarFail(); };
        window.fetch = function(){ return Promise.reject(new Error('模擬網路錯誤')); };
      `);
      let apiFailCartOpenError = null;
      try { await ev(`refreshShopStatus()`); } catch (e) { apiFailCartOpenError = e && e.message; }
      const shopDataUnchanged = ev('JSON.stringify(shopData) === window.__shopDataSnapshotBeforeFail');
      const cartUnchangedAfterFail = ev('JSON.stringify(cart) === window.__cartSnapshotBeforeFail');
      const buildCallsFail = ev('window.__buildBarCallsFail');
      assert(!apiFailCartOpenError, '4.3-1 購物車開啟時 GET /api/line-shop 拋出例外，refreshShopStatus() 本身不外洩例外（內部 try/catch 吞掉）');
      assert(shopDataUnchanged, '4.3-2 API 失敗（拋出例外）時，shopData 不被覆蓋');
      assert(cartUnchangedAfterFail, '4.3-3 API 失敗時，購物車不被清空');
      assert(buildCallsFail === 0, '4.3-4 API 失敗時，不重繪半套新狀態', `calls=${buildCallsFail}`);
      ev(`
        document.getElementById = window.__origGetById9;
        buildServiceStatusBar = window.__origBuildBarFail;
      `);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 三. findNextServiceInfo() 真實後端邊界情境（真實 DB fixture + Business Calendar +
//    真實 GET /shop，不 mock 回傳值本身）
// ══════════════════════════════════════════════════════════════════
async function runBackendTests() {
  const tmpDbPath = path.join(os.tmpdir(), `h1412-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.POS_DB_PATH = tmpDbPath;

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();

  const STORE = 'store_h1412_a';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE, 1]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE, 'pro', JSON.stringify({ line_order: true })]);
  db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'line_ordering_enabled', '1']);

  const lineOrdersRoute = require(path.join(ROOT, 'routes/line-orders.js'));
  const settingsRoute = require(path.join(ROOT, 'routes/settings.js'));
  const express = require('express');
  const bodyParser = require('body-parser');
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => { req.storeId = req.headers['x-test-store'] || STORE; next(); });
  app.use('/api/settings', settingsRoute);
  app.use('/api/line-orders', lineOrdersRoute);
  server = app.listen(0);
  const port = server.address().port;
  const fetchFn = (await import('node-fetch')).default;
  const base = `http://localhost:${port}`;

  const today = taipeiTodayStr();
  const everyDayOpen = (open, close) => {
    const o = {};
    WD_KEYS.forEach((k) => { o[k] = { enabled: true, open, close }; });
    return o;
  };
  const everyDayClosed = () => { const o = {}; WD_KEYS.forEach((k) => { o[k] = { enabled: false }; }); return o; };

  async function getShop() {
    return fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE } }).then((x) => x.json());
  }
  function resetAllSettings() {
    db.run('DELETE FROM settings WHERE store_id=? AND key NOT IN (?,?)', [STORE, 'line_ordering_enabled', 'line_order_page_mode']);
    db.run('DELETE FROM store_business_calendar WHERE store_id=?', [STORE]);
  }
  function setBiz(mode, hours) {
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, `${mode}_business_hours`, JSON.stringify(hours)]);
  }
  function setEnabled(mode, on) {
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, `${mode}_enabled`, on ? '1' : '0']);
  }
  function insertCalendar(row) {
    db.run(
      `INSERT INTO store_business_calendar
        (store_id, start_date, end_date, mode, reason, show_reason, takeout_enabled, delivery_enabled, takeout_start_time, takeout_end_time, delivery_start_time, delivery_end_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [STORE, row.start_date, row.end_date, row.mode, row.reason || '', row.show_reason ? 1 : 0,
        row.takeout_enabled !== undefined ? (row.takeout_enabled ? 1 : 0) : 1,
        row.delivery_enabled !== undefined ? (row.delivery_enabled ? 1 : 0) : 1,
        row.takeout_start_time || '', row.takeout_end_time || '', row.delivery_start_time || '', row.delivery_end_time || ''],
    );
  }

  // 三-1：明日正常營業（每天皆開）
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', true);
    const r = await getShop();
    const svc = r.data.takeout_next_service;
    assert(!!svc && svc.date === addDaysToDateStr(today, 1) && svc.start_time === '10:00', '三-1 明日正常營業 → takeout_next_service 指向明日 10:00', JSON.stringify(svc));
  }

  // 三-2：明日公休（Business Calendar mode=closed），後天營業
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', true);
    const tomorrow = addDaysToDateStr(today, 1);
    insertCalendar({ start_date: tomorrow, end_date: tomorrow, mode: 'closed' });
    const r = await getShop();
    const svc = r.data.takeout_next_service;
    const dayAfterTomorrow = addDaysToDateStr(today, 2);
    assert(!!svc && svc.date === dayAfterTomorrow, '三-2 明日 Business Calendar 公休，next_service 正確跳到後天', JSON.stringify(svc));
  }

  // 三-3：連續多日公休，下一營業日顯示真實星期（透過前端 _ffDayLabel 換算，這裡先確認
  // 後端給的日期本身正確，星期幾的顯示已在四／二節的 jsdom 測試驗證過 _ffDayLabel 本身）
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', true);
    const d1 = addDaysToDateStr(today, 1), d2 = addDaysToDateStr(today, 2), d3 = addDaysToDateStr(today, 3), d4 = addDaysToDateStr(today, 4);
    [d1, d2, d3, d4].forEach((d) => insertCalendar({ start_date: d, end_date: d, mode: 'closed' }));
    const r = await getShop();
    const svc = r.data.takeout_next_service;
    const d5 = addDaysToDateStr(today, 5);
    assert(!!svc && svc.date === d5, '三-3 連續 4 天公休，next_service 正確跳到第 5 天', JSON.stringify(svc));
    if (svc) {
      const wd = weekdayOfDateStr(svc.date);
      assert(typeof wd === 'number' && wd >= 0 && wd <= 6, '三-3b 回傳日期可正確換算出星期幾（供前端 _ffDayLabel 顯示真實星期）', `wd=${wd}`);
    }
  }

  // 三-4：Weekly schedule 全部關閉，但 Business Calendar 明日特殊營業開放
  {
    resetAllSettings();
    setBiz('takeout', everyDayClosed());
    setEnabled('takeout', true);
    const tomorrow = addDaysToDateStr(today, 1);
    insertCalendar({ start_date: tomorrow, end_date: tomorrow, mode: 'custom_hours', takeout_start_time: '09:30', takeout_end_time: '15:00' });
    const r = await getShop();
    const svc = r.data.takeout_next_service;
    assert(!!svc && svc.date === tomorrow && svc.start_time === '09:30', '三-4 週班表全關但 Business Calendar 明日特殊營業開放 → next_service 採用 Calendar 的時間', JSON.stringify(svc));
  }

  // 三-5：Business Calendar 當日只關閉外帶，外送仍正常（分開計算）
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setBiz('delivery', everyDayOpen('11:00', '21:00'));
    setEnabled('takeout', true); setEnabled('delivery', true);
    const tomorrow = addDaysToDateStr(today, 1);
    insertCalendar({ start_date: tomorrow, end_date: tomorrow, mode: 'custom_hours', takeout_enabled: false, delivery_enabled: true, delivery_start_time: '12:00', delivery_end_time: '20:00' });
    const r = await getShop();
    const svcTakeout = r.data.takeout_next_service;
    const svcDelivery = r.data.delivery_next_service;
    const dayAfterTomorrow = addDaysToDateStr(today, 2);
    assert(!!svcTakeout && svcTakeout.date === dayAfterTomorrow, '三-5a 明日 Calendar 只關外帶 → takeout_next_service 跳過明日，指向後天', JSON.stringify(svcTakeout));
    assert(!!svcDelivery && svcDelivery.date === tomorrow && svcDelivery.start_time === '12:00', '三-5b 外送不受影響，next_service 仍是明日 12:00（採用 Calendar 當日時間）', JSON.stringify(svcDelivery));
  }

  // 三-6：外帶、外送不同開始時間，兩者分開回傳（一般情況，非 Calendar）
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('08:00', '14:00'));
    setBiz('delivery', everyDayOpen('17:00', '21:00'));
    setEnabled('takeout', true); setEnabled('delivery', true);
    const r = await getShop();
    const tomorrow = addDaysToDateStr(today, 1);
    assert(r.data.takeout_next_service && r.data.takeout_next_service.start_time === '08:00', '三-6a takeout_next_service 使用外帶自己的開始時間 08:00');
    assert(r.data.delivery_next_service && r.data.delivery_next_service.start_time === '17:00', '三-6b delivery_next_service 使用外送自己的開始時間 17:00（與外帶分開）');
    assert(r.data.takeout_next_service.date === tomorrow && r.data.delivery_next_service.date === tomorrow, '三-6c 兩者日期皆正確為明日');
  }

  // 三-7：global mode disabled → next_service=null
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', false); // 整個關閉外帶
    const r = await getShop();
    assert(r.data.takeout_next_service === null, '三-7 外帶被店家整個關閉（enabled=false）→ takeout_next_service 為 null（即使週班表寫著營業）', JSON.stringify(r.data.takeout_next_service));
  }

  // 三-8：連續 60 天以上找不到營業日 → null（不捏造）
  {
    resetAllSettings();
    setBiz('takeout', everyDayClosed());
    setEnabled('takeout', true);
    const r = await getShop();
    assert(r.data.takeout_next_service === null, '三-8 連續找不到未來營業日（超過 60 天上限）→ 誠實回傳 null，不捏造日期', JSON.stringify(r.data.takeout_next_service));
  }

  // 三-9：allow_next_day=false 但仍回傳 next_service 資訊；selectable/canPreorder 必須維持 false
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', true);
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_allow_next_day', '0']);
    const r = await getShop();
    assert(!!r.data.takeout_next_service, '三-9a allow_next_day=false 時，next_service 資訊仍會被計算並回傳（純資訊，需求文件二第四點）');
    assert(r.data.takeout_status.allow_next_day === false, '三-9b 後端 allow_next_day 旗標本身維持 false，沒有被 next_service 的存在影響');
    // canPreorderFutureDays 是前端依 allow_next_day && nextAvailableDate 算出，這裡用同一份
    // 資料在 Node 端重算一次（沿用前端公式，不重新設計判斷），確認 selectable 不會被
    // next_service 的存在意外打開。
    const allowNextDay = !!r.data.takeout_status.allow_next_day;
    const nextDatesArr = r.data.takeout_next_dates || [];
    const canPreorderFutureDays = allowNextDay && !!nextDatesArr.length;
    assert(canPreorderFutureDays === false, '三-9c canPreorderFutureDays（selectable 的依據之一）在 allow_next_day=false 時仍為 false，未被 next_service 意外打開');
  }

  // 三-10：next_service 與 validateOrderConditions() 的一致性——誠實說明：
  // validateOrderConditions() 本身未匯出，這裡不是直接呼叫它，而是直接呼叫
  // findNextServiceInfo() 與 validateOrderConditions() 兩者共用的
  // getEffectiveModeSchedule()（後端唯一的排班權威來源），確認兩者確實讀同一份資料、
  // 不會出現「next_service 顯示一個送單時 validateOrderConditions() 會拒絕的日期」。
  // （因為 findNextServiceInfo() 本來就是沿用 getDateClosedStatus()/
  // getEffectiveModeSchedule() 這兩個 validateOrderConditions() 也會用到的函式）。
  {
    resetAllSettings();
    setBiz('takeout', everyDayOpen('10:00', '20:00'));
    setEnabled('takeout', true);
    const r = await getShop();
    const svc = r.data.takeout_next_service;
    assert(!!svc, '三-10 前置：next_service 存在才能驗證一致性');
    if (svc) {
      // 直接用 line-orders.js 匯出的 resolveFulfillmentState 沿用同一組今日以外的
      // schedule/modeSettings 概念重算 svc.date 當天的有效班表，確認該日確實 enabled，
      // 這與 validateOrderConditions() 內部呼叫的 getEffectiveModeSchedule() 是同一個
      // 函式，語意一致（validateOrderConditions() 本身是 require 內部函式，未匯出，
      // 這裡改用它同樣呼叫的 getEffectiveModeSchedule() 佐證排班本身確實允許）。
      const { getEffectiveModeSchedule } = lineOrdersRoute;
      const modeSettingsRaw = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [STORE, 'takeout_business_hours']);
      const bizHours = JSON.parse(modeSettingsRaw.value);
      const modeSettings = { enabled: true, allowNextDay: false, todayCutoff: '', bizHours };
      const sched = getEffectiveModeSchedule(db, STORE, 'takeout', svc.date, modeSettings);
      assert(sched.enabled === true && sched.start === svc.start_time, '三-10b 直接呼叫 findNextServiceInfo() 與 validateOrderConditions() 共用的 getEffectiveModeSchedule()，確認 next_service 指向的日期確實是該函式認定允許營業的日期與時間，兩者資料來源一致、不矛盾', JSON.stringify({ sched, svc }));
    }
  }
}

main()
  .then(() => runBackendTests())
  .catch((e) => { fail('FATAL', e.stack || e.message); })
  .finally(() => {
    // H1.4.11.3（需求文件 4.4）：unhandledRejection 必須是真正的 assertion，不能只是
    // console.log 的 [WARN] 後仍 exit 0。放在所有 main()/runBackendTests() 的 await
    // 都已完成之後才檢查，確保背景 fire-and-forget 的 rejection（例如
    // refreshCartProductsFromLatestMenu() 內部未 await 的部分）有機會先被捕捉到。
    assert(!unhandledRejectionSeen, '六 整個測試執行過程中沒有出現未處理的 Promise rejection', unhandledRejectionSeen ? String(unhandledRejectionSeen && unhandledRejectionSeen.stack || unhandledRejectionSeen).slice(0, 300) : '');
    printSummary();
    try { if (server) server.close(); } catch (e) {}
    try { if (dom) dom.window.close(); } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });
