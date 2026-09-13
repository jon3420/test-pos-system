#!/usr/bin/env node
// scripts/smoke-h1-4-11-1-fixes.js
// H1.4.11.1｜針對獨立檢查提出的 7 項落差的最小補正驗證。
//
// 範圍（對照使用者需求文件章節）：
//   一. Toast 頂端定位＋長文案不截斷
//   二. cutoff/holiday/today_not_open 狀態下「下一次開始接單時間」使用後端權威資料
//   三. today_not_open 依 reason／holidaySource 細分文案
//   四. settings.js enum 嚴格驗證（空字串/空白/null/陣列/物件一律拒絕）
//   五. 頁面模式改變時單獨觸發圖塊重繪＋生命週期 in-flight coalescing
//   六. 圖塊移除重複鍵盤觸發風險（只保留原生 button 行為）
//   七. 測試真實性補強（合併模式改點不可用/可用圖塊之外的圖塊、切換模式走真正的
//      applyFulfillmentMode()、生命週期呼叫正式函式兩次）
//
// 誠實揭露：本檔與 scripts/smoke-h1-4-11-line-order-page-mode.js 互補，不重複贅述
// 已經驗證過、且本輪未變動的部分（settings store 隔離、8 狀態真值表等），完整回歸
// 仍以两支測試合併執行為準。

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
  console.log('SMOKE TEST SUMMARY — H1.4.11.1 targeted fixes');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

let server;
let dom;
// H1.4.11.3（需求文件 4.4）：unhandledRejection 必須是真正的 assertion，不是只印
// [WARN] 就仍 exit 0。
let unhandledRejectionSeen = null;
process.on('unhandledRejection', (e) => { unhandledRejectionSeen = e; });

// H1.4.11.2（需求文件一）：測試用的日期輔助函式，刻意不依賴 host 當地時區的
// `new Date()`（若測試環境的 TZ 與 Taipei 不同，host `new Date()` 讀到的「今天」
// 可能與 production twNow()/fmtD() 算出的 Taipei「今天」差一天，尤其在日期交界
// 附近），全部改成：
//   1. 對「今天」一律以 production 自己算出的 twNow()（前端 jsdom 內）或跟
//      routes/line-orders.js 的 twNow() 完全相同的轉換方式（後端 Node 測試內，見
//      taipeiTodayStr()）為準；
//   2. 「加減天數」與「算星期幾」一律用 Date.UTC() 做純日曆數字運算（不經過 host
//      local 時區解讀字串），確保在任何 TZ 環境下執行都得到相同結果。
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
// 與 routes/line-orders.js 的 twNow()/twDateStr() 完全相同的轉換方式，供後端
// Node 測試（runBackendTests()，沒有 jsdom/production twNow() 可呼叫）取得與
// production 一致的「Taipei 今天」，不受 host TZ 影響（toLocaleString 轉換 +
// 同一個 process 內用同一個 TZ 讀回，本身就是 TZ-safe 的 round trip）。
function taipeiTodayStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  ['routes/settings.js', 'routes/line-orders.js', 'public/js/app.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const htmlPath = path.join(ROOT, 'public/line-order.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  // ══════════════════════════════════════════════════════════════════
  // 一. Toast 定位（CSS 原始碼層級——只檢查 .toast{} 這一條規則本身，不誤判其他
  //    規則裡出現的 top/bottom 字樣）
  // ══════════════════════════════════════════════════════════════════
  {
    const m = htmlSrc.match(/\.toast\{([^}]*)\}/);
    assert(!!m, '一-0 找到 .toast{} CSS 規則');
    if (m) {
      const rule = m[1];
      assert(/top\s*:/.test(rule), '一-1 .toast 使用 top 定位', rule);
      assert(!/bottom\s*:/.test(rule), '一-2 .toast 不再使用 bottom 定位', rule);
      assert(/env\(safe-area-inset-top/.test(rule), '一-3 .toast 使用 env(safe-area-inset-top) 避開 LIFF 標題列／瀏海', rule);
      assert(/position\s*:\s*fixed/.test(rule), '一-4 .toast 仍是 position:fixed');
      assert(!/white-space\s*:\s*nowrap/.test(rule), '一-5 .toast 不再使用 white-space:nowrap（允許長文案換行，不被截斷）', rule);
      assert(!/text-overflow\s*:\s*ellipsis/.test(rule), '一-6 .toast 不再使用 text-overflow:ellipsis（不截斷下一次接單時間）', rule);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // jsdom 載入頁面，供後續大部分測試使用（真實執行，不是字串搜尋）
  // ══════════════════════════════════════════════════════════════════
  const { JSDOM, ResourceLoader } = require('jsdom');
  // H1.4.11.2（需求文件六）：先前用「拒絕所有外部資源」的方式載入頁面，導致
  // <script src="/js/delivery-free-progress.js"> 等外部檔案完全沒被執行，
  // getDeliveryFreeProgressState() 等函式在真正呼叫 applyFulfillmentMode()（會觸發
  // 外送優惠進度渲染）時變成 ReferenceError。改用自訂 ResourceLoader 把頁面實際引用
  // 的 /js/*.js、/css/*.css 對應到磁碟上同一份真實檔案內容（正確載入，不是另外寫一份
  // stub 假裝有這個函式），其餘（字型／地圖 SDK／CDN）安全地回傳空內容，不影響核心
  // 測試邏輯。
  class LocalFileResourceLoader extends ResourceLoader {
    fetch(url) {
      try {
        const u = new URL(url);
        if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/')) {
          const localPath = path.join(ROOT, 'public', u.pathname);
          if (fs.existsSync(localPath)) return Promise.resolve(fs.readFileSync(localPath));
        }
      } catch (e) { /* 非本機路徑（外部 CDN／地圖 SDK 等）：安全忽略 */ }
      return Promise.resolve(Buffer.from(''));
    }
  }
  try {
    // init() 在頁面載入時會立即 fetch /api/line-shop、/api/line-menu、
    // /api/settings/business-calendar（Promise.all）。若讓它們全部 reject，
    // init() 會走進 catch 分支呼叫 showSystemError()，把 #content 整個 innerHTML
    // 換掉（連帶清空 #menuArea 等巢狀容器），導致之後任何依賴真實頁面結構的測試
    // （例如真的呼叫 applyFulfillmentMode() → renderMenu()）因為容器已經不存在而
    // 丟出例外——這不是 production 邏輯的問題，純粹是測試需要讓 init() 走「成功」
    // 分支，才能保留頁面原始 DOM 結構。beforeParse 在任何 <script> 執行之前先把
    // window.fetch 換成回傳合理成功資料的版本，讓 init() 用空菜單/空分類正常完成。
    // 之後各測試區塊會依需要再各自覆蓋 window.fetch／shopData，不影響這裡的初始化。
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
          } else if (u.includes('/api/line-orders/query')) {
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

    // 一-7：長文案不被截斷——真的呼叫 toast() 並讀回 textContent 完整保留
    {
      const longMsg = '⊘ 外帶自取今日已結束，週一 16:00 開始接單，若有任何問題請聯繫店家客服謝謝配合';
      ev(`
        window.__toastEl2 = document.getElementById('toast');
      `);
      ev(`toast(${JSON.stringify(longMsg)}, 4000)`);
      const shown = ev('window.__toastEl2.textContent');
      assert(shown === longMsg, '一-7 toast() 長文案 textContent 完整保留，未被 JS 端截斷', shown);
    }

    // ══════════════════════════════════════════════════════════════
    // 二＋三. _ffDayLabel／_ffShortLabel／_ffDetailText／_ffToastText
    // ══════════════════════════════════════════════════════════════
    {
      // _ffDayLabel：0/1 天用相對稱呼，>=2 天一律用真實星期幾（不是「後天」/「N天後」）。
      // 錨點一律用 production 自己的 fmtD(twNow())（Taipei 今天），加減天數與算星期幾
      // 改用純 UTC 日曆運算（addDaysToDateStr／weekdayOfDateStr），不受 host TZ 影響。
      const today = ev('fmtD(twNow())');
      const plus1Str = addDaysToDateStr(today, 1);
      const plus3Str = addDaysToDateStr(today, 3);
      const WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
      assert(ev(`_ffDayLabel(${JSON.stringify(today)})`) === '今日', '二-1 _ffDayLabel(今天) === 今日');
      assert(ev(`_ffDayLabel(${JSON.stringify(plus1Str)})`) === '明日', '二-2 _ffDayLabel(明天) === 明日');
      const expectWd = WD[weekdayOfDateStr(plus3Str)];
      const got3 = ev(`_ffDayLabel(${JSON.stringify(plus3Str)})`);
      assert(got3 === expectWd, `二-3 _ffDayLabel(+3天) 使用真實星期幾（${expectWd}），不是「後天」或「3天後」`, `got=${got3}`);
    }
    {
      // 今日已結束＋不可預訂＋有後端 next service 資料 → 真實下一次開始接單時間
      ev(`window.__fsCutoffNext = {state:'cutoff', canPreorderFutureDays:false, nextServiceDate:${JSON.stringify(fmtPlus(1))}, nextServiceStartTime:'16:00'};`);
      const detail = ev('_ffDetailText(window.__fsCutoffNext, "takeout")');
      assert(detail === '明日 16:00 開始接單', '二-4 今日已結束＋不可預訂＋有 next service 資料 → detail === 「明日 16:00 開始接單」', detail);
      const toastMsg = ev(`_ffToastText(window.__fsCutoffNext, 'takeout')`);
      assert(toastMsg.includes('明日 16:00 開始接單'), '二-5 對應 Toast 文案同樣包含「明日 16:00 開始接單」', toastMsg);
    }
    {
      // 下一營業日不是明日（例如週一）時，不得誤寫「明日」
      ev(`window.__fsCutoffMon = {state:'cutoff', canPreorderFutureDays:false, nextServiceDate:${JSON.stringify(fmtPlus(3))}, nextServiceStartTime:'16:00'};`);
      const detail = ev('_ffDetailText(window.__fsCutoffMon, "takeout")');
      assert(!detail.includes('明日'), '二-6 下一營業日非明日時，detail 不得誤寫「明日」', detail);
      assert(/^週[一二三四五六日]/.test(detail), '二-6b detail 改用真實星期幾開頭', detail);
    }
    {
      // 完全沒有 next service 資料時，才允許通用文字（不得捏造）
      ev(`window.__fsCutoffNone = {state:'cutoff', canPreorderFutureDays:false};`);
      const detail = ev('_ffDetailText(window.__fsCutoffNone, "takeout")');
      assert(detail === '今日服務時間已結束', '二-7 完全無 next service 資料時，才使用通用文字（不捏造時間）', detail);
    }
    {
      // 尚未開始＋未開放預訂：今日 16:00 開始接單（沿用既有 fs.startTime，未受影響）
      ev(`window.__fsNotStarted = {state:'not_started', canScheduleToday:false, startTime:'16:00'};`);
      assert(ev('_ffDetailText(window.__fsNotStarted, "takeout")') === '今日 16:00 開始接單', '二-8 尚未開始＋未開放預訂 → 「今日 16:00 開始接單」（未受本輪影響，維持正確）');
      ev(`window.__fsScheduleToday = {state:'not_started', canScheduleToday:true, startTime:'16:00'};`);
      assert(ev('_ffDetailText(window.__fsScheduleToday, "takeout")') === '今日 16:00 起可取餐', '二-9 開放預訂 → 「今日 16:00 起可取餐」');
    }
    {
      // 三：today_not_open 依 reason 細分
      assert(ev(`_ffShortLabel({state:'today_not_open', reason:'no_schedule'})`) === '今日未開放', '三-1 today_not_open/no_schedule → 今日未開放');
      assert(ev(`_ffShortLabel({state:'today_not_open', reason:'global_disabled'})`) === '目前未提供', '三-2 today_not_open/global_disabled → 目前未提供');
      // H1.4.11.2（需求文件五）更新：special_schedule_disabled 是「今日限定」被 Business
      // Calendar 關掉這個服務方式，與 global_disabled（店家整個永久關閉）語意不同，短
      // 標籤改為「今日未提供」，不再和 global_disabled 共用「目前未提供」。
      assert(ev(`_ffShortLabel({state:'today_not_open', reason:'special_schedule_disabled'})`) === '今日未提供', '三-3（H1.4.11.2 更新）today_not_open/special_schedule_disabled → 今日未提供（與 global_disabled 的「目前未提供」區分）');
      assert(ev(`_ffShortLabel({state:'holiday', holidaySource:'today_closed'})`) === '今日臨時休息', '三-4 holiday + holidaySource=today_closed → 今日臨時休息');
      assert(ev(`_ffShortLabel({state:'holiday', holidaySource:'calendar'})`) === '今日公休', '三-5 holiday + 其他 holidaySource → 今日公休');
      assert(ev(`_ffShortLabel({state:'holiday'})`) === '今日公休', '三-5b holiday 無 holidaySource → 今日公休（一般公休預設）');
      // 今日不能服務但未來仍可預約 → 不可一邊「目前未提供」一邊仍可點擊，改用「可預約」
      assert(ev(`_ffShortLabel({state:'today_not_open', reason:'no_schedule', canPreorderFutureDays:true})`) === '可預約', '三-6 today_not_open 但 canPreorderFutureDays=true → 短標籤改為「可預約」，不與可點擊狀態矛盾');
    }

    // ══════════════════════════════════════════════════════════════
    // 六. 原生 button 鍵盤操作不會觸發兩次
    // ══════════════════════════════════════════════════════════════
    {
      const html = ev(`_ffTileHtml('takeout', {selectable:true, state:'open'}, {pageMode:'fulfillment_switcher', viewMode:null})`);
      assert(!/onkeydown/.test(html), '六-1 _ffTileHtml() 產生的圖塊不再包含 onkeydown（避免與原生 button Enter/Space 行為重複觸發）');
      ev(`
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
        window.__tileClickCount = 0;
        window.__origHandleClick = handleFulfillmentTileClick;
        handleFulfillmentTileClick = function(mode){ window.__tileClickCount++; };
        window.__tileBtn = document.body.querySelector('.ff-tile[data-mode="takeout"]');
      `);
      // 真的 dispatch 一次 click（模擬「原生 button 對 Enter/Space 的預設行為」——
      // jsdom 對表單元素的 keydown→click 預設行為支援不穩定，這裡改為驗證「若原生
      // 行為觸發一次 click，我們的程式碼不會額外再自己觸發第二次」，因為 onkeydown
      // 已確認完全移除（六-1），click 事件本身只綁定一個 onclick，原生對同一次操作
      // 只會 dispatch 一次 click 事件，不會有第二個事件來源。
      ev(`window.__tileBtn.dispatchEvent(new window.Event('click', {bubbles:true, cancelable:true}))`);
      const clickCount = ev('window.__tileClickCount');
      assert(clickCount === 1, '六-2 圖塊只綁定 onclick（無 onkeydown），一次操作只呼叫一次 handleFulfillmentTileClick()', `count=${clickCount}`);
      ev(`handleFulfillmentTileClick = window.__origHandleClick; window.__tileBtn.remove();`);
    }

    // ══════════════════════════════════════════════════════════════
    // 五. 頁面模式改變時單獨觸發重繪＋in-flight coalescing＋正式生命週期函式冪等
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode='takeout';
        window.__barEl2 = { style:{}, className:'', innerHTML:'' };
        window.__origGetById3 = document.getElementById;
        document.getElementById = function(id){ return id==='serviceStatusBar' ? window.__barEl2 : window.__origGetById3.call(document, id); };
        window.__buildBarCalls = 0;
        window.__origBuildBar = buildServiceStatusBar;
        buildServiceStatusBar = function(){ window.__buildBarCalls++; return window.__origBuildBar(); };
        window.__fetchResponses = [];
        window.fetch = function(){
          const payload = window.__fetchResponses.shift() || { success:true, data: shopData };
          return Promise.resolve({ json: () => Promise.resolve(payload) });
        };
      `);
      // 五-1：只有 line_order_page_mode 改變、enabled/cutoff 狀態完全不變 → 仍要重繪
      ev(`
        window.__fetchResponses.push({ success:true, data: Object.assign({}, shopData, { line_order_page_mode:'fulfillment_switcher' }) });
        _ffViewMode = 'takeout';
      `);
      await ev(`refreshShopStatus()`);
      const buildCallsAfterModeChange = ev('window.__buildBarCalls');
      const viewModeAfterModeChange = ev('_ffViewMode');
      assert(buildCallsAfterModeChange >= 1, '五-1 僅 line_order_page_mode 改變（其餘狀態不變）時，buildServiceStatusBar() 仍被呼叫', `calls=${buildCallsAfterModeChange}`);
      assert(viewModeAfterModeChange === null, '五-2 頁面模式改變後，_ffViewMode 被清除（純顯示用狀態不跨模式殘留）');
      assert(ev('currentMode') === 'takeout', '五-3 頁面模式改變不影響 currentMode（不無聲改變正式取餐方式）');

      // 五-4（H1.4.11.2 更新）：即使頁面模式與既有狀態皆未改變，H1.4.11.2 起
      // buildServiceStatusBar() 改為每次成功刷新統一重繪一次（見需求文件三：不逐欄位
      // 比對，改成安全的「每次都重繪」），所以這裡驗證的是「剛好重繪一次，不多不少」，
      // 不再是「完全不重繪」。
      ev(`window.__buildBarCalls = 0;`);
      ev(`window.__fetchResponses.push({ success:true, data: Object.assign({}, shopData, { line_order_page_mode:'fulfillment_switcher' }) });`);
      await ev(`refreshShopStatus()`);
      const buildCallsNoModeChange = ev('window.__buildBarCalls');
      assert(buildCallsNoModeChange === 1, '五-4（H1.4.11.2）頁面模式與既有狀態皆未改變時，仍統一重繪剛好一次（不因為新增判斷分支而多繪或少繪）', `calls=${buildCallsNoModeChange}`);

      // 五-5：in-flight coalescing——同步連續呼叫 requestShopStatusRefresh() 兩次，
      // 底層 fetch 只應該被呼叫一次（第二次呼叫拿到同一個 in-flight Promise）。
      ev(`
        window.__fetchCallCount = 0;
        window.fetch = function(){
          window.__fetchCallCount++;
          return new Promise((resolve)=> setTimeout(()=> resolve({ json: () => Promise.resolve({ success:true, data: shopData }) }), 30));
        };
      `);
      ev(`window.__p1 = requestShopStatusRefresh(); window.__p2 = requestShopStatusRefresh();`);
      const samePromise = ev('window.__p1 === window.__p2');
      await ev(`Promise.all([window.__p1, window.__p2])`);
      const fetchCallsDuringCoalesce = ev('window.__fetchCallCount');
      assert(samePromise, '五-5a 同步連續呼叫 requestShopStatusRefresh() 兩次，回傳同一個 in-flight Promise');
      assert(fetchCallsDuringCoalesce === 1, '五-5b in-flight coalescing 期間，底層只發出一次真正的 fetch 請求', `fetchCalls=${fetchCallsDuringCoalesce}`);
      // coalescing 結束後，再呼叫一次應該要能再真的打一次 API（不是永久卡死在同一個 Promise）
      ev(`window.__fetchCallCount = 0;`);
      await ev(`requestShopStatusRefresh()`);
      assert(ev('window.__fetchCallCount') === 1, '五-5c 前一輪 in-flight 結束後，下一次呼叫會真的重新發出請求（沒有永久卡死）');

      ev(`document.getElementById = window.__origGetById3; buildServiceStatusBar = window.__origBuildBar;`);
    }
    {
      // 五-6／七（生命週期，H1.4.11.2 補上 focus）：直接呼叫正式的
      // wireFulfillmentLifecycleRefresh()（不是測試自己另外寫一份示意函式）兩次，
      // 驗證 pageshow／visibilitychange／focus 三種事件的 addEventListener 都只真的
      // 註冊一次；並且真的 dispatch 三種事件，驗證都會委派同一個
      // requestShopStatusRefresh()（透過底層 fetch 呼叫次數佐證，而不是只看有沒有
      // 註冊過 listener）。
      ev(`
        window._lifecycleWired = false;
        window.__docAddCalls2 = 0; window.__winAddCalls2 = 0; window.__focusAddCalls2 = 0;
        window.__origDocAdd2 = document.addEventListener.bind(document);
        window.__origWinAdd2 = window.addEventListener.bind(window);
        document.addEventListener = function(type, fn){ if(type==='visibilitychange') window.__docAddCalls2++; return window.__origDocAdd2(type, fn); };
        window.addEventListener = function(type, fn){
          if(type==='pageshow') window.__winAddCalls2++;
          if(type==='focus') window.__focusAddCalls2++;
          return window.__origWinAdd2(type, fn);
        };
      `);
      const firstCallReturn = ev('wireFulfillmentLifecycleRefresh()');
      const secondCallReturn = ev('wireFulfillmentLifecycleRefresh()');
      const docAdd2 = ev('window.__docAddCalls2');
      const winAdd2 = ev('window.__winAddCalls2');
      const focusAdd2 = ev('window.__focusAddCalls2');
      assert(firstCallReturn === true, '五-6a 正式函式 wireFulfillmentLifecycleRefresh() 第一次呼叫回傳 true（真的完成註冊）');
      assert(secondCallReturn === false, '五-6b 正式函式第二次呼叫回傳 false（偵測到已註冊過，no-op）');
      assert(docAdd2 === 1, '五-7a 直接呼叫正式函式兩次，visibilitychange 只真的註冊一次', `docAdd2=${docAdd2}`);
      assert(winAdd2 === 1, '五-7b 直接呼叫正式函式兩次，pageshow 只真的註冊一次', `winAdd2=${winAdd2}`);
      assert(focusAdd2 === 1, '五-7c（H1.4.11.2 新增）直接呼叫正式函式兩次，focus 只真的註冊一次', `focusAdd2=${focusAdd2}`);
      ev(`document.addEventListener = window.__origDocAdd2; window.addEventListener = window.__origWinAdd2;`);

      // 五-8（H1.4.11.2）：真的 dispatch pageshow／visibilitychange／focus 三種事件，
      // 驗證都會真正各自觸發一次底層 fetch（經 requestShopStatusRefresh() 的 in-flight
      // coalescing，依序分開 dispatch＋等待完成，才能各自獨立算作一次）。
      ev(`
        window.__fetchCallCount2 = 0;
        window.fetch = function(){
          window.__fetchCallCount2++;
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data: shopData }) });
        };
        Object.defineProperty(document, 'visibilityState', { configurable:true, get(){ return 'visible'; } });
      `);
      ev(`window.dispatchEvent(new window.Event('pageshow'))`);
      await ev(`new Promise((r)=>setTimeout(r,20))`);
      ev(`document.dispatchEvent(new window.Event('visibilitychange'))`);
      await ev(`new Promise((r)=>setTimeout(r,20))`);
      ev(`window.dispatchEvent(new window.Event('focus'))`);
      await ev(`new Promise((r)=>setTimeout(r,20))`);
      const fetchCallsAfterThreeEvents = ev('window.__fetchCallCount2');
      assert(fetchCallsAfterThreeEvents === 3, '五-8 真實 dispatch pageshow／visibilitychange／focus 三次（不同時間點，各自等待完成），各自觸發一次 requestShopStatusRefresh() → fetch', `fetchCalls=${fetchCallsAfterThreeEvents}`);
    }
    {
      // 五-9（H1.4.11.2）：同一時間點「幾乎同時」dispatch pageshow + visibilitychange +
      // focus 三個事件（不等待），驗證 in-flight coalescing 讓底層只真的發出一次 fetch。
      ev(`
        window.__fetchCallCount3 = 0;
        window.fetch = function(){
          window.__fetchCallCount3++;
          return new Promise((resolve)=> setTimeout(()=> resolve({ json: () => Promise.resolve({ success:true, data: shopData }) }), 20));
        };
        window.dispatchEvent(new window.Event('pageshow'));
        document.dispatchEvent(new window.Event('visibilitychange'));
        window.dispatchEvent(new window.Event('focus'));
      `);
      await ev(`new Promise((r)=>setTimeout(r,60))`);
      const fetchCallsSimultaneous = ev('window.__fetchCallCount3');
      assert(fetchCallsSimultaneous === 1, '五-9 三個生命週期事件幾乎同時觸發時，in-flight coalescing 讓底層只真的發出一次 fetch（不會各自重複打 API）', `fetchCalls=${fetchCallsSimultaneous}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 七. 合併模式：改點「原本不是 currentMode」的可用圖塊，確認只有 _ffViewMode 變、
    //    currentMode／oType 不變、且沒有呼叫 applyFulfillmentMode()/selectFulfillmentMode()
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode = 'takeout';
        window.__oType2 = { value: 'takeout' };
        window.__origGetById4 = document.getElementById;
        document.getElementById = function(id){ return id==='oType' ? window.__oType2 : window.__origGetById4.call(document, id); };
        window.__applyCalls = []; window.__selectCalls = [];
        window.__origApply = applyFulfillmentMode; window.__origSelect = selectFulfillmentMode;
        applyFulfillmentMode = function(mode){ window.__applyCalls.push(mode); };
        selectFulfillmentMode = function(mode){ window.__selectCalls.push(mode); };
        _ffViewMode = null;
      `);
      ev(`handleFulfillmentTileClick('delivery')`); // delivery 是 open → selectable=true，且不是目前 currentMode
      const viewMode = ev('_ffViewMode');
      const cm = ev('currentMode');
      const otype = ev('window.__oType2.value');
      const applyCalls = ev('window.__applyCalls');
      const selectCalls = ev('window.__selectCalls');
      assert(viewMode === 'delivery', '七-1 合併模式點擊「非目前 currentMode」的可用圖塊 → _ffViewMode 正確變為該圖塊');
      assert(cm === 'takeout', '七-2 currentMode 完全不受影響，仍是 takeout');
      assert(otype === 'takeout', '七-3 #oType 完全不受影響，仍是 takeout');
      assert(Array.isArray(applyCalls) && applyCalls.length === 0, '七-4 合併模式點擊可用圖塊，完全沒有呼叫 applyFulfillmentMode()');
      assert(Array.isArray(selectCalls) && selectCalls.length === 0, '七-5 合併模式點擊可用圖塊，完全沒有呼叫 selectFulfillmentMode()');
      ev(`
        document.getElementById = window.__origGetById4;
        applyFulfillmentMode = window.__origApply; selectFulfillmentMode = window.__origSelect;
      `);
    }

    // ══════════════════════════════════════════════════════════════
    // 七（切換模式）：使用真正的 selectFulfillmentMode()/applyFulfillmentMode()（不是
    // spy），驗證 currentMode／#oType 真的改變、購物車未被清空。網路與非核心副作用
    // （timeslots/menu 等）用寬鬆的 fetch stub 避免測試因為缺伺服器而拋例外，但
    // applyFulfillmentMode() 本身是真實呼叫。
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode = 'takeout';
        cart = { 'p1': { product: { id:'p1', name:'測試商品', price:100, effective_line_price:100, effective_line_name:'測試商品' }, qty:2 } };
        window.__cartSnapshotBefore = JSON.stringify(cart);
        window.fetch = function(url){
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ slots:[] }, categories:[], products:[] }) });
        };
      `);
      let realIntegrationError = null;
      try {
        await ev(`applyFulfillmentMode('delivery')`);
      } catch (e) {
        realIntegrationError = e && e.message;
      }
      const cmAfter = ev('currentMode');
      const oTypeAfter = ev(`(document.getElementById('oType')||{}).value`);
      const cartAfter = ev('JSON.stringify(cart)');
      const cartBefore = ev('window.__cartSnapshotBefore');
      if (realIntegrationError) {
        fail('七-6 真實 applyFulfillmentMode(\'delivery\') 執行不拋出例外', realIntegrationError.slice(0, 300));
      } else {
        pass('七-6 真實 applyFulfillmentMode(\'delivery\') 執行不拋出例外');
      }
      assert(cmAfter === 'delivery', '七-7 真實 applyFulfillmentMode() 執行後，currentMode 變成 delivery（未被 mock 掉）', `currentMode=${cmAfter}`);
      assert(oTypeAfter === 'delivery', '七-8 真實 applyFulfillmentMode() 執行後，#oType.value 變成 delivery', `oType=${oTypeAfter}`);
      assert(cartAfter === cartBefore, '七-9 切換取餐方式後，購物車內容未被清空／未被改變', `before=${cartBefore} after=${cartAfter}`);

      // 結帳仍可改回 takeout——同樣呼叫真實函式驗證可逆
      let backError = null;
      try { await ev(`applyFulfillmentMode('takeout')`); } catch (e) { backError = e && e.message; }
      const cmBack = ev('currentMode');
      assert(!backError, '七-10 真實 applyFulfillmentMode(\'takeout\') 改回不拋出例外', backError ? backError.slice(0, 300) : '');
      assert(cmBack === 'takeout', '七-11 結帳/圖塊仍可真實改回 takeout（可逆，未被鎖死在 delivery）', `currentMode=${cmBack}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 七-12～16（H1.4.11.2 需求文件六）：真正從「圖塊 click」這個入口出發，走
    // 完整鏈路 tile click → handleFulfillmentTileClick() → selectFulfillmentMode()
    // → applyFulfillmentMode()，全部是真實函式（不 spy 任何一段），只有網路
    // fetch 被 stub。驗證 currentMode／#oType／購物車在這個真實鏈路下的行為。
    // ══════════════════════════════════════════════════════════════
    {
      ev(`
        shopData = {
          line_order_page_mode: 'fulfillment_switcher',
          takeout_status:  { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
          delivery_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false },
        };
        currentMode = 'takeout';
        cart = { 'p2': { product: { id:'p2', name:'鍵盤整合測試商品', price:80, effective_line_price:80, effective_line_name:'鍵盤整合測試商品' }, qty:3 } };
        window.__cartSnapshotBefore2 = JSON.stringify(cart);
        window.fetch = function(){
          return Promise.resolve({ json: () => Promise.resolve({ success:true, data:{ slots:[] }, categories:[], products:[] }) });
        };
        const deliveryFs = getFulfillmentStatus('delivery');
        const tileHtml = _ffTileHtml('delivery', deliveryFs, {pageMode:'fulfillment_switcher', viewMode:null});
        document.body.insertAdjacentHTML('beforeend', tileHtml);
        window.__realTile = document.body.querySelector('.ff-tile[data-mode="delivery"]');
      `);
      let clickChainError = null;
      try {
        ev(`window.__realTile.dispatchEvent(new window.Event('click', {bubbles:true, cancelable:true}))`);
        // handleFulfillmentTileClick() 內部呼叫的 selectFulfillmentMode() 會觸發
        // applyFulfillmentMode()（async，fire-and-forget，非同步完成），這裡等待一輪
        // microtask/宏任務讓它真正跑完，再讀取結果（避免誤判「還沒跑完」為失敗）。
        await ev(`new Promise((resolve)=> setTimeout(resolve, 30))`);
      } catch (e) {
        clickChainError = e && e.message;
      }
      const cmAfterClick = ev('currentMode');
      const oTypeAfterClick = ev(`(document.getElementById('oType')||{}).value`);
      const cartAfterClick = ev('JSON.stringify(cart)');
      const cartBeforeClick = ev('window.__cartSnapshotBefore2');
      if (clickChainError) {
        fail('七-12 真實 tile click → handleFulfillmentTileClick() → selectFulfillmentMode() → applyFulfillmentMode() 整段鏈路不拋出例外', clickChainError.slice(0, 300));
      } else {
        pass('七-12 真實 tile click → handleFulfillmentTileClick() → selectFulfillmentMode() → applyFulfillmentMode() 整段鏈路不拋出例外（核心函式全部未被 spy 取代）');
      }
      assert(cmAfterClick === 'delivery', '七-13 真實點擊圖塊後，currentMode 透過完整鏈路變成 delivery', `currentMode=${cmAfterClick}`);
      assert(oTypeAfterClick === 'delivery', '七-14 真實點擊圖塊後，#oType.value 透過完整鏈路變成 delivery', `oType=${oTypeAfterClick}`);
      assert(cartAfterClick === cartBeforeClick, '七-15 真實點擊圖塊切換取餐方式，購物車內容未被清空／未被改變');
      // 不可用方式無法寫入或提交：把 takeout 標成不可用，點擊 takeout 圖塊不應該
      // 把 currentMode 從 delivery 改回 takeout。
      ev(`
        shopData.takeout_status = { today_state:'today_not_open', today_open:false, today_label:'目前未提供', earliest_today:null, allow_next_day:false, today_reason:'global_disabled' };
        const takeoutFs = getFulfillmentStatus('takeout');
        const unavailableTileHtml = _ffTileHtml('takeout', takeoutFs, {pageMode:'fulfillment_switcher', viewMode:null});
        document.body.insertAdjacentHTML('beforeend', unavailableTileHtml);
        window.__realTileUnavailable = document.body.querySelectorAll('.ff-tile[data-mode="takeout"]');
        window.__realTileUnavailable = window.__realTileUnavailable[window.__realTileUnavailable.length-1];
      `);
      ev(`window.__realTileUnavailable.dispatchEvent(new window.Event('click', {bubbles:true, cancelable:true}))`);
      await ev(`new Promise((resolve)=> setTimeout(resolve, 30))`);
      const cmAfterUnavailableClick = ev('currentMode');
      assert(cmAfterUnavailableClick === 'delivery', '七-16 真實點擊不可用（takeout 被關閉）圖塊，currentMode 不會被改回 takeout（不可用方式無法寫入）', `currentMode=${cmAfterUnavailableClick}`);
      ev(`window.__realTile.remove(); if(window.__realTileUnavailable) window.__realTileUnavailable.remove();`);
    }
  }

  function fmtPlus(daysAhead) {
    // H1.4.11.2（需求文件一）：改用 Taipei 錨點 + 純 UTC 曆法運算，不受 host TZ 影響。
    return addDaysToDateStr(taipeiTodayStr(), daysAhead);
  }
}

// ══════════════════════════════════════════════════════════════════
// 後端：enum 嚴格驗證 ＋ takeout_next_service／delivery_next_service 端到端驗證
// ══════════════════════════════════════════════════════════════════
async function runBackendTests() {
  const tmpDbPath = path.join(os.tmpdir(), `h1411-1-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.POS_DB_PATH = tmpDbPath;

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();

  const STORE = 'store_h14111_a';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE, 1]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE, 'pro', JSON.stringify({ line_order: true })]);
  db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'line_ordering_enabled', '1']);

  const settingsRoute = require(path.join(ROOT, 'routes/settings.js'));
  const lineOrdersRoute = require(path.join(ROOT, 'routes/line-orders.js'));
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

  // ══════════════════════════════════════════════════════════════
  // 四. enum 嚴格驗證
  // ══════════════════════════════════════════════════════════════
  await fetchFn(`${base}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
    body: JSON.stringify({ line_order_page_mode: 'combined_checkout' }),
  });

  const illegalInputs = [
    ['空字串', ''],
    ['純空白', '   '],
    ['null', null],
    ['陣列', ['combined_checkout']],
    ['物件', { mode: 'combined_checkout' }],
    ['數字', 123],
    ['未知字串', 'garbage_mode'],
  ];
  for (const [labelName, val] of illegalInputs) {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({ line_order_page_mode: val }),
    });
    const j = await r.json();
    assert(r.status === 400 && j.success === false, `四-${labelName} line_order_page_mode=${JSON.stringify(val)} 被拒絕（400）`, `status=${r.status} body=${JSON.stringify(j)}`);
  }
  const rowAfterIllegal = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [STORE, 'line_order_page_mode']);
  assert(rowAfterIllegal && rowAfterIllegal.value === 'combined_checkout', '四-殘留檢查 所有非法輸入被拒絕後，DB 仍保留原本合法值 combined_checkout', JSON.stringify(rowAfterIllegal));

  // 合法值前後有空白，trim 後仍可儲存為標準值
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({ line_order_page_mode: '  fulfillment_switcher  ' }),
    });
    const j = await r.json();
    assert(r.status === 200 && j.success === true && j.data.line_order_page_mode === 'fulfillment_switcher', '四-trim 合法值前後有空白，trim 後可正確儲存為標準值', JSON.stringify(j));
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [STORE, 'line_order_page_mode']);
    assert(row && row.value === 'fulfillment_switcher', '四-trim-db DB 內儲存的是 trim 後的標準值，不是帶空白的原始字串', JSON.stringify(row));
  }

  // 未送出該欄位：完全不影響（允許，且不動原值）
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE },
      body: JSON.stringify({ line_official_name: 'test store name' }),
    });
    const j = await r.json();
    assert(r.status === 200 && j.success === true, '四-未送出 未送出 line_order_page_mode 時，PUT 其他欄位正常成功');
    assert(j.data.line_order_page_mode === 'fulfillment_switcher', '四-未送出-保留 未送出時原本的 line_order_page_mode 值不受影響');
  }

  // VALID_LINE_ORDER_PAGE_MODES 只定義一份，router.__test 與驗證共用同一參照
  {
    const testExports = settingsRoute.__test;
    assert(Array.isArray(testExports.VALID_LINE_ORDER_PAGE_MODES) && testExports.VALID_LINE_ORDER_PAGE_MODES.length === 2, '四-單一定義 router.__test.VALID_LINE_ORDER_PAGE_MODES 存在且為兩個合法值');
  }

  // ══════════════════════════════════════════════════════════════
  // 二. takeout_next_service／delivery_next_service 端到端（真實 DB fixture + 真實
  //    HTTP，透過既有 getDateClosedStatus()／getEffectiveModeSchedule() 計算，不是
  //    另外重新實作一套時間邏輯）
  // ══════════════════════════════════════════════════════════════
  {
    // 只有星期一營業，其餘全天不營業（bizHours 每天皆 enabled:false，除了 mon）
    const disabledDay = { enabled: false };
    const bizHours = { sun: disabledDay, mon: { enabled: true, open: '16:00', close: '20:00' }, tue: disabledDay, wed: disabledDay, thu: disabledDay, fri: disabledDay, sat: disabledDay };
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_business_hours', JSON.stringify(bizHours)]);
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_enabled', '1']);
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'takeout_allow_next_day', '0']); // 刻意關閉預訂，驗證仍能算出 next service

    const r = await fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE } }).then((x) => x.json());
    assert(r.success === true, '二-1 GET /shop 成功（含只有週一營業的 fixture）');
    const nextSvc = r.data.takeout_next_service;
    assert(!!nextSvc && !!nextSvc.date && nextSvc.start_time === '16:00', '二-2 takeout_next_service 正確算出下一個週一 16:00（即使 allow_next_day=0，資訊仍會計算，需求文件二第四點）', JSON.stringify(nextSvc));
    if (nextSvc && nextSvc.date) {
      const d = new Date(nextSvc.date + 'T00:00:00');
      assert(d.getDay() === 1, '二-3 takeout_next_service.date 確實是星期一', `date=${nextSvc.date} getDay=${d.getDay()}`);
    }
    // 外送未特別設定 → 沿用預設全日班表（09:00 開始），與外帶（僅週一 16:00）各自獨立
    // 使用自己的班表計算 next service。兩者「日期恰好相同」是合法結果（例如外帶下一個
    // 週一，剛好也是外送下一個有營業的日子），不能拿「日期不同」當作「分開計算」的
    // 判斷依據；真正能證明兩者沒有互相污染的，是各自的開始時間分別正確反映各自班表
    // （外帶 16:00、外送 09:00，且外送沒有錯誤繼承外帶的 16:00）。
    const nextSvcDelivery = r.data.delivery_next_service;
    const bothExist = !!nextSvc && !!nextSvc.date && !!nextSvcDelivery && !!nextSvcDelivery.date;
    const takeoutCorrect = !!nextSvc && nextSvc.start_time === '16:00';
    const deliveryCorrect = !!nextSvcDelivery && nextSvcDelivery.start_time === '09:00';
    const deliveryDidNotInheritTakeout = !!nextSvcDelivery && nextSvcDelivery.start_time !== '16:00';
    assert(bothExist && takeoutCorrect && deliveryCorrect && deliveryDidNotInheritTakeout, '二-4 外帶／外送的 next service 分開使用各自班表與開始時間（外帶 16:00、外送 09:00，外送未繼承外帶的 16:00；日期是否相同不是判斷依據，因為兩者合法地落在同一天是可能的）', JSON.stringify({ takeout: nextSvc, delivery: nextSvcDelivery }));
  }
  {
    // 完全找不到下一次營業（連續 60 天皆休息）→ 允許前端使用通用文字（後端回 null，
    // 不得硬湊一個假日期）
    const allClosed = { sun: { enabled: false }, mon: { enabled: false }, tue: { enabled: false }, wed: { enabled: false }, thu: { enabled: false }, fri: { enabled: false }, sat: { enabled: false } };
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE, 'delivery_business_hours', JSON.stringify(allClosed)]);
    const r = await fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE } }).then((x) => x.json());
    assert(r.data.delivery_next_service === null, '二-5 連續找不到下一次營業時間時，後端誠實回傳 null（不捏造假日期）', JSON.stringify(r.data.delivery_next_service));
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
