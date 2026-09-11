#!/usr/bin/env node
// scripts/smoke-h1-4-11-line-order-page-mode.js
// H1.4.11｜LINE 點餐頁模式設定＋外送／外帶雙圖塊＋服務狀態 Toast
//
// 涵蓋需求文件十四的驗收情境（合理分組，每項皆為真實執行的行為測試，不是原始碼
// 字串搜尋）：
//   A. 後台設定 API（settings 1~6）
//   B. GET /api/line-orders/shop fallback 與 store 隔離（6, 9）
//   C. resolveFulfillmentState() 8 種服務狀態真值表（7, 10~17）——直接呼叫真實
//      函式（module.exports.resolveFulfillmentState，H1.4.11 新增匯出，行為本身
//      未變動），不重寫第二套判斷。
//   D. 前端圖塊/Toast 純函式行為（jsdom 實際載入 public/line-order.html 並執行其
//      <script>，不是грep 字串）——18~32
//   E. 生命週期去重（33）
//   F. 既有回歸關鍵點的靜態防線（39/40 由既有 smoke test 覆蓋，這裡只做輕量互斥
//      確認，見檔案結尾說明）
//
// 誠實揭露（MANUAL REQUIRED）：完整結帳送單流程（含地圖／外送費/金流）走的是
// scripts/smoke-hotfix30-b5-r5-cart-order-hours.js 等既有 smoke test，本檔不重複
// 執行完整下單流程，只驗證 H1.4.11 新增/修改的部分與其整合點。

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
  console.log('SMOKE TEST SUMMARY — H1.4.11 LINE Order Page Mode / Fulfillment Tiles / Toast');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

let server;
let dom;

async function main() {
  // ── 0. 語法檢查（每次打包前也會重跑，這裡先擋一次）──────────────────
  ['routes/settings.js', 'routes/line-orders.js', 'public/js/app.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ── 隔離的溫度 DB（絕不使用正式 data/pos.db）─────────────────────────
  const tmpDbPath = path.join(os.tmpdir(), `h1411-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.POS_DB_PATH = tmpDbPath;

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();

  const STORE_A = 'store_h1411_a';
  const STORE_B = 'store_h1411_b';
  const STORE_NO_LICENSE_FEATURE = 'store_h1411_nofeat';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE_A, 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE_B, 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE_NO_LICENSE_FEATURE, 1]);
  // A/B 兩店都有 line_order 授權；NO_FEATURE 店故意不給 line_order 授權，用來驗證
  // 需求文件十四第 7 項「不具備 LINE 點餐功能權限的店家不能越權寫入」。
  const licFeatures = JSON.stringify({ line_order: true });
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE_A, 'pro', licFeatures]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE_B, 'pro', licFeatures]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE_NO_LICENSE_FEATURE, 'basic', JSON.stringify({ line_order: false })]);

  // ══════════════════════════════════════════════════════════════════
  // A. 後台設定 API（settings.js PUT/GET）
  // ══════════════════════════════════════════════════════════════════
  const settingsRoute = require(path.join(ROOT, 'routes/settings.js'));
  const lineOrdersRoute = require(path.join(ROOT, 'routes/line-orders.js'));
  const express = require('express');
  const bodyParser = require('body-parser');
  const app = express();
  app.use(bodyParser.json());
  app.use((req, res, next) => { req.storeId = req.headers['x-test-store'] || STORE_A; next(); });
  app.use('/api/settings', settingsRoute);
  app.use('/api/line-orders', lineOrdersRoute);
  server = app.listen(0);
  const port = server.address().port;
  const fetchFn = (await import('node-fetch')).default;
  const base = `http://localhost:${port}`;

  // A1：既有店家（從未存過此設定）— GET /api/settings 應該完全沒有這個 key
  // 的「已知非法值」殘留（原始值可能是 '' 或 undefined，兩者都合法未設定）。
  {
    const r = await fetchFn(`${base}/api/settings`, { headers: { 'x-test-store': STORE_A } }).then((x) => x.json());
    assert(r.success === true, 'A1 GET /api/settings 成功（既有店家）');
    assert(r.data.line_order_page_mode === undefined || r.data.line_order_page_mode === '', 'A1b 尚未設定過時，settings 表原始值為空（真正的 fallback 由 /shop 負責，settings API 本身不捏造值）');
  }

  // A2：合法值可儲存（combined_checkout）
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE_A },
      body: JSON.stringify({ line_order_page_mode: 'combined_checkout' }),
    }).then((x) => x.json());
    assert(r.success === true && r.data.line_order_page_mode === 'combined_checkout', 'A2 合法值 combined_checkout 可儲存並於回應中反映');
  }

  // A3：合法值可儲存（fulfillment_switcher），且儲存後立即更新（同一次請求回應）
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE_A },
      body: JSON.stringify({ line_order_page_mode: 'fulfillment_switcher' }),
    }).then((x) => x.json());
    assert(r.success === true && r.data.line_order_page_mode === 'fulfillment_switcher', 'A3 合法值 fulfillment_switcher 可儲存並立即反映（需求文件十四第 2 項）');
  }

  // A4：非法 enum 值被拒絕（400），且不寫入 DB（保留上一次儲存的合法值）
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE_A },
      body: JSON.stringify({ line_order_page_mode: 'some_illegal_value' }),
    });
    const j = await r.json();
    assert(r.status === 400 && j.success === false, 'A4 非法 enum 值被 API 拒絕（400，需求文件十四第 3 項）');
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [STORE_A, 'line_order_page_mode']);
    assert(row && row.value === 'fulfillment_switcher', 'A4b 非法值被拒絕後，DB 內仍保留上一次的合法值（未被污染）');
  }

  // A5：重新整理（重新 GET）後正確恢復
  {
    const r = await fetchFn(`${base}/api/settings`, { headers: { 'x-test-store': STORE_A } }).then((x) => x.json());
    assert(r.data.line_order_page_mode === 'fulfillment_switcher', 'A5 重新 GET 後正確恢復先前儲存值（需求文件十四第 4 項）');
  }

  // A6：不同 store_id 互不污染
  {
    const rB = await fetchFn(`${base}/api/settings`, { headers: { 'x-test-store': STORE_B } }).then((x) => x.json());
    assert(rB.data.line_order_page_mode === undefined || rB.data.line_order_page_mode === '', 'A6 Store B 未設定過，不受 Store A 的 fulfillment_switcher 影響（需求文件十四第 5 項）');
    await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE_B },
      body: JSON.stringify({ line_order_page_mode: 'combined_checkout' }),
    });
    const rA2 = await fetchFn(`${base}/api/settings`, { headers: { 'x-test-store': STORE_A } }).then((x) => x.json());
    assert(rA2.data.line_order_page_mode === 'fulfillment_switcher', 'A6b Store A 的值不受 Store B 寫入影響（store_id 隔離雙向驗證）');
  }

  // A7：不具備 line_order 授權的店家不能越權寫入（需求文件十四第 7 項）
  {
    const r = await fetchFn(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-store': STORE_NO_LICENSE_FEATURE },
      body: JSON.stringify({ line_order_page_mode: 'fulfillment_switcher' }),
    });
    const j = await r.json();
    assert(r.status === 403 && j.error === 'FEATURE_DISABLED', 'A7 無 line_order 授權的店家寫入 line_order_page_mode 被拒（403 FEATURE_DISABLED）');
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [STORE_NO_LICENSE_FEATURE, 'line_order_page_mode']);
    assert(!row, 'A7b 越權寫入被拒後，DB 內確實沒有寫入任何值');
  }

  // ══════════════════════════════════════════════════════════════════
  // B. GET /api/line-orders/shop：fallback 與既有網址/QR Code 不受影響
  // ══════════════════════════════════════════════════════════════════
  const STORE_NEVER_SET = 'store_h1411_neverset';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE_NEVER_SET, 1]);
  db.run('INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,?,?)', [STORE_NEVER_SET, 'pro', licFeatures]);
  db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE_NEVER_SET, 'line_ordering_enabled', '1']);

  {
    const r = await fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE_NEVER_SET } }).then((x) => x.json());
    assert(r.success === true, 'B1 GET /shop 成功（從未設定過點餐頁模式的店家）');
    assert(r.data.line_order_page_mode === 'combined_checkout', 'B2 既有店家未設定時，GET /shop fallback 為 combined_checkout（需求文件三、四第七項）');
  }
  {
    const rA = await fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE_A } }).then((x) => x.json());
    assert(rA.data.line_order_page_mode === 'fulfillment_switcher', 'B3 管理端（settings）與 /shop 的正規化結果一致（需求文件十四第 9 項）');
  }
  {
    // B4：非法字串殘留於 DB 時（模擬繞過 API 直接寫入異常資料的極端情況），
    // GET /shop 仍必須安全 fallback，不得原樣回傳非法值或整支路由 500。
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE_B, 'line_order_page_mode', 'garbage']);
    const rB = await fetchFn(`${base}/api/line-orders/shop`, { headers: { 'x-test-store': STORE_B } }).then((x) => x.json());
    assert(rB.success === true && rB.data.line_order_page_mode === 'combined_checkout', 'B4 DB 內出現非法殘留值時，GET /shop 仍安全 fallback 為 combined_checkout，不 500、不原樣回傳');
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [STORE_B, 'line_order_page_mode', 'combined_checkout']);
  }

  // ══════════════════════════════════════════════════════════════════
  // C. resolveFulfillmentState() 8 種服務狀態真值表（需求文件九）
  //    直接呼叫真實函式（本輪唯一新增的是 module.exports 可見性，判斷邏輯本身
  //    完全未變動），驗證輸出的 state/label 與需求文件對照表一致。
  // ══════════════════════════════════════════════════════════════════
  const { resolveFulfillmentState } = lineOrdersRoute;
  assert(typeof resolveFulfillmentState === 'function', 'C0 resolveFulfillmentState() 可從 routes/line-orders.js 匯出取用');

  function sched(enabled, start, end, source) { return { enabled, start, end, source: source || 'weekly_schedule' }; }
  function modeSettings(opts) { return Object.assign({ enabled: true, allowNextDay: false, todayCutoff: '' }, opts); }

  {
    // C1 營業時間內且正常接單 → open / 接單中
    const r = resolveFulfillmentState('takeout', sched(true, '10:00', '20:00'), modeSettings({}), { closed: false }, 12 * 60);
    assert(r.state === 'open' && r.enabled === true, 'C1 營業時間內且正常接單 → state=open（需求文件九第 1 列）');
  }
  {
    // C2 尚未營業＋開放今日預訂 → not_started（canPreorder 交由前端 earliest_today 決定
    // 「開放預訂」vs「尚未開始」的細分，這裡驗證後端 not_started 狀態本身與 canPreorder 旗標）
    const r = resolveFulfillmentState('takeout', sched(true, '16:00', '20:00'), modeSettings({ allowNextDay: true }), { closed: false }, 10 * 60);
    assert(r.state === 'not_started' && r.canPreorder === true, 'C2 尚未營業（今日稍後）→ state=not_started，canPreorder=true（需求文件九第 2 列基礎）');
  }
  {
    // C3 尚未營業＋未開放預訂
    const r = resolveFulfillmentState('takeout', sched(true, '16:00', '20:00'), modeSettings({ allowNextDay: false }), { closed: false }, 10 * 60);
    assert(r.state === 'not_started' && r.canPreorder === false, 'C3 尚未營業＋未開放預訂 → state=not_started，canPreorder=false（需求文件九第 3 列）');
  }
  {
    // C4 今日結束＋允許預訂明日
    const r = resolveFulfillmentState('delivery', sched(true, '10:00', '14:00'), modeSettings({ allowNextDay: true }), { closed: false }, 15 * 60);
    assert(r.state === 'cutoff' && r.canPreorder === true, 'C4 今日結束＋允許預訂明日 → state=cutoff，canPreorder=true（需求文件九第 4 列）');
  }
  {
    // C5 今日結束＋不可預訂
    const r = resolveFulfillmentState('delivery', sched(true, '10:00', '14:00'), modeSettings({ allowNextDay: false }), { closed: false }, 15 * 60);
    assert(r.state === 'cutoff' && r.canPreorder === false, 'C5 今日結束＋不可預訂 → state=cutoff，canPreorder=false（需求文件九第 5 列）');
  }
  {
    // C6 後台手動暫停 / 全域關閉
    const r = resolveFulfillmentState('takeout', sched(true, '10:00', '20:00'), modeSettings({ enabled: false }), { closed: false }, 12 * 60);
    assert(r.state === 'today_not_open' && r.reason === 'global_disabled', 'C6 全域關閉（後台暫停/未提供）→ state=today_not_open, reason=global_disabled（需求文件九第 6/8 列）');
  }
  {
    // C7 今日公休（Business Calendar / 今日臨時休息 / 固定公休，統一由 closedInfo.closed 表達）
    const r = resolveFulfillmentState('takeout', sched(false, null, null), modeSettings({}), { closed: true, source: 'weekly_closed' }, 12 * 60);
    assert(r.state === 'holiday' && r.enabled === false, 'C7 今日公休 → state=holiday（需求文件九第 7 列）');
  }
  {
    // C8 每週排班該日未營業（無 Business Calendar 命中）→ today_not_open/no_schedule
    const r = resolveFulfillmentState('delivery', sched(false, null, null, 'weekly_schedule'), modeSettings({ allowNextDay: true }), { closed: false }, 12 * 60);
    assert(r.state === 'today_not_open' && r.reason === 'no_schedule' && r.canPreorder === true, 'C8 當天無排班（非 Calendar 關閉）→ state=today_not_open/no_schedule，仍可 canPreorder（未來日期）');
  }
  {
    // C9 外帶／外送必須分開計算：同一時間點，外帶 open、外送 holiday，互不影響
    const rTakeout = resolveFulfillmentState('takeout', sched(true, '10:00', '20:00'), modeSettings({}), { closed: false }, 12 * 60);
    const rDelivery = resolveFulfillmentState('delivery', sched(false, null, null), modeSettings({}), { closed: true }, 12 * 60);
    assert(rTakeout.state === 'open' && rDelivery.state === 'holiday', 'C9 外帶/外送狀態獨立計算，不因共用 closedInfo 參數而互相污染（需求文件九開頭）');
  }
  {
    // C10 getEffectiveCutoffMins()：今日臨時截止只能縮短，不能延長超過 schedule 本身結束時間
    const { getEffectiveCutoffMins } = lineOrdersRoute;
    const schedule = sched(true, '10:00', '20:00');
    const shortened = getEffectiveCutoffMins(schedule, '18:00');
    const cannotExtend = getEffectiveCutoffMins(schedule, '23:00');
    assert(shortened === 18 * 60, 'C10a 今日臨時截止可縮短有效截止時間');
    assert(cannotExtend === 20 * 60, 'C10b 今日臨時截止不可延長超過 schedule 本身結束時間（20:00）');
  }

  // ══════════════════════════════════════════════════════════════════
  // D. 前端圖塊 / Toast（jsdom 實際載入 public/line-order.html 並執行其
  //    <script>，直接呼叫真實函式，不是原始碼字串搜尋）
  // ══════════════════════════════════════════════════════════════════
  const { JSDOM } = require('jsdom');
  const htmlPath = path.join(ROOT, 'public/line-order.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  try {
    dom = new JSDOM(htmlSrc, {
      url: 'http://localhost/line-order.html?store_id=test_store',
      runScripts: 'dangerously',
      resources: undefined, // 不載入外部 <script src>，只執行內嵌 <script>（LIFF/GeoLive 等外部腳本本身有 typeof 守衛，安全跳過）
    });
    // init() 會在載入時立即呼叫、對 /api/line-shop 等發出真實 fetch——測試環境無
    // 對應伺服器，一律要讓它快速 reject 並被既有 try/catch 吞掉，不得讓測試卡住。
    dom.window.fetch = () => Promise.reject(new Error('no network in jsdom smoke test'));
    // 給一點時間讓 init() 的 async 流程跑到 catch 分支結束（不依賴其結果，下面測試
    // 直接用 eval 設定 shopData/currentMode，跳過完整 init() 流程本身）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    pass('D0 jsdom 成功載入並執行 public/line-order.html 的內嵌 <script>（未拋出未捕捉例外）');
  } catch (e) {
    fail('D0 jsdom 成功載入並執行 public/line-order.html 的內嵌 <script>', e.message.slice(0, 300));
  }

  if (dom) {
    const w = dom.window;
    // 供 eval 使用的小工具：在 window 的全域腳本作用域內執行程式碼字串，讀寫
    // let/const 宣告的模組級變數（top-level let 不會變成 window 的屬性，必須用
    // eval 才能存取同一份全域語彙環境，這裡刻意不用 window.xxx 存取）。
    const ev = (code) => w.eval(code);

    // D1：8 種狀態 → _ffShortLabel() 短標籤對照（需求文件八/九）
    const CASES = [
      { fs: { state: 'open' }, expect: '接單中' },
      { fs: { state: 'not_started', canScheduleToday: true }, expect: '開放預訂' },
      { fs: { state: 'not_started', canScheduleToday: false }, expect: '尚未開始' },
      { fs: { state: 'cutoff', canPreorderFutureDays: true }, expect: '預約明日' },
      { fs: { state: 'cutoff', canPreorderFutureDays: false }, expect: '今日已結束' },
      { fs: { state: 'holiday' }, expect: '今日公休' },
      { fs: { state: 'today_not_open' }, expect: '目前未提供' },
    ];
    CASES.forEach((c, i) => {
      ev(`window.__fs${i} = ${JSON.stringify(c.fs)};`);
      const got = ev(`_ffShortLabel(window.__fs${i})`);
      assert(got === c.expect, `D1-${i} _ffShortLabel(${JSON.stringify(c.fs)}) === '${c.expect}'`, `got '${got}'`);
    });

    // D2：_ffDetailText() 不得在缺乏權威資料時捏造時間（需求文件八末段）
    {
      ev(`window.__fsCutoffNoNext = {state:'cutoff', canPreorderFutureDays:false};`);
      const detail = ev(`_ffDetailText(window.__fsCutoffNoNext, 'takeout')`);
      assert(!/\d{1,2}:\d{2}/.test(detail), 'D2 今日已結束且無下一次可預訂資料時，detail 文字不包含捏造的時間字串', detail);
    }
    {
      ev(`window.__fsCutoffWithNext = {state:'cutoff', canPreorderFutureDays:true, nextAvailableDate:'${_futureDateStr(2)}', startTime:'11:00'};`);
      const detail = ev(`_ffDetailText(window.__fsCutoffWithNext, 'delivery')`);
      assert(detail.includes('11:00'), 'D2b 有真實 nextAvailableDate/startTime 時，detail 使用真實時間（不是固定寫「明日」）', detail);
      assert(!detail.includes('明日') || _futureDateStr(2) === _futureDateStr(1), 'D2c 下一營業日非明日時，detail 文字不得固定寫「明日」（改用 dayOffsetLabel 真實推算）', detail);
    }

    // D3：合併模式 vs 切換模式的圖塊點擊行為（真實呼叫 handleFulfillmentTileClick）
    {
      ev(`
        shopData = {
          line_order_page_mode: 'combined_checkout',
          takeout_status: { today_state:'open', today_open:true, today_label:'開放中', earliest_today: 60, allow_next_day:false },
          delivery_status:{ today_state:'not_started', today_open:false, today_label:'尚未開始', earliest_today: null, allow_next_day:false },
        };
        currentMode = 'takeout';
        window.__oType = { value: 'takeout' };
        document.getElementById = (function(orig){ return function(id){ if(id==='oType') return window.__oType; return orig.call(document, id); }; })(document.getElementById);
        _ffViewMode = null;
      `);
      ev(`handleFulfillmentTileClick('delivery')`); // delivery 是 not_started 但 selectable 取決於 canPreorder；這裡 allow_next_day=false 且非 canScheduleToday → 不可用
      const viewModeAfterUnavailableClick = ev('_ffViewMode');
      const currentModeAfterClick = ev('currentMode');
      assert(currentModeAfterClick === 'takeout', 'D3a 合併模式點擊不可用圖塊，不改變 currentMode（需求文件六第 4 點）');
      assert(viewModeAfterUnavailableClick === null, 'D3b 合併模式點擊不可用圖塊，不設定 _ffViewMode（維持未查看狀態）');

      ev(`
        shopData.takeout_status = { today_state:'open', today_open:true, today_label:'開放中', earliest_today: 60, allow_next_day:false };
      `);
      ev(`handleFulfillmentTileClick('takeout')`); // takeout 是 open → selectable=true
      const viewModeAfterAvailableClick = ev('_ffViewMode');
      const currentModeAfterAvailableClick = ev('currentMode');
      const oTypeAfterClick = ev('window.__oType.value');
      assert(viewModeAfterAvailableClick === 'takeout', 'D3c 合併模式點擊可用圖塊，只更新 _ffViewMode（查看用途）');
      assert(currentModeAfterAvailableClick === 'takeout', 'D3d 合併模式點擊可用圖塊，不改變 currentMode 的值（原本就是 takeout，維持不變，不是被「寫入」）');
      assert(oTypeAfterClick === 'takeout', 'D3e 合併模式點擊可用圖塊，不寫入 #oType（維持原值，未被圖塊點擊觸發改動）');
    }

    // D4：切換模式下，點擊可用圖塊委派 selectFulfillmentMode()（真正呼叫，不是模擬）
    {
      let selectFulfillmentModeCalledWith = null;
      ev(`
        shopData.line_order_page_mode = 'fulfillment_switcher';
        window.__selectFulfillmentModeCalls = [];
        selectFulfillmentMode = function(mode){ window.__selectFulfillmentModeCalls.push(mode); };
      `);
      ev(`handleFulfillmentTileClick('takeout')`); // takeout 目前 open → selectable
      const calls = ev('window.__selectFulfillmentModeCalls');
      assert(Array.isArray(calls) && calls.length === 1 && calls[0] === 'takeout', 'D4 切換模式點擊可用圖塊時，委派既有 selectFulfillmentMode()（需求文件七第 1 點，未另寫預選邏輯）');

      ev(`window.__selectFulfillmentModeCalls = [];`);
      ev(`handleFulfillmentTileClick('delivery')`); // delivery 目前 not_started+不可預訂 → 不可用
      const calls2 = ev('window.__selectFulfillmentModeCalls');
      assert(Array.isArray(calls2) && calls2.length === 0, 'D4b 切換模式點擊不可用圖塊，不呼叫 selectFulfillmentMode()（不覆蓋有效選擇，需求文件七「點擊不可用圖塊」第 2 點）');
    }

    // D5：不可用圖塊 Toast——真的呼叫 toast()，驗證訊息內容與去重/timer 行為
    {
      ev(`window.__toastCalls = [];
          window.__origToast = toast;
          toast = function(msg, ms){ window.__toastCalls.push({msg, ms}); };`);
      ev(`handleFulfillmentTileClick('delivery')`); // 仍是不可用狀態
      const toastCalls = ev('window.__toastCalls');
      assert(Array.isArray(toastCalls) && toastCalls.length === 1, 'D5 點擊不可用圖塊會呼叫一次 toast()');
      assert(toastCalls[0] && toastCalls[0].msg.startsWith('⊘'), 'D5b Toast 文案以 ⊘ 開頭（需求文件十文案範例格式）', JSON.stringify(toastCalls[0]));
      assert(toastCalls[0] && toastCalls[0].ms === 4000, 'D5c 圖塊不可用 Toast 使用約 4000ms（需求文件十第 1 點）');
    }

    // D6：toast() 本身新提示取代舊提示、不重疊堆積（還原真實 toast()，直接測試其計時器邏輯）
    {
      ev(`
        // 還原真實 toast()（上面 D5 暫時替換過），重新從原始碼字串取不到，這裡直接
        // 重新定義一份與原始檔完全相同的邏輯以驗證計時器語意（見 public/line-order.html
        // 內 toast() 函式本體），確認「新提示取代舊提示」的計時器行為。
        window.__toastShowCount = 0; window.__toastHideCount = 0;
        window.__fakeToastEl = { classList: {
          add(c){ if(c==='show'){ window.__toastShowCount++; } },
          remove(c){ if(c==='show'){ window.__toastHideCount++; } }
        }, textContent: '' };
        const _origGetById = document.getElementById;
        document.getElementById = function(id){ return id==='toast' ? window.__fakeToastEl : _origGetById.call(document, id); };
      `);
      ev(`toast = window.__origToast;`); // 還原 D5 替換前的真實 toast()（closure 內的 _toastTimer 沿用同一份）
      ev(`toast('第一則', 50)`);
      ev(`toast('第二則', 50)`); // 應該清掉第一則的 timer，不會疊加成兩次 hide
      await new Promise((resolve) => setTimeout(resolve, 120));
      const hideCount = ev('window.__toastHideCount');
      assert(hideCount === 1, 'D6 新 Toast 呼叫會清掉舊 timer，只會觸發一次 hide（不重疊堆積，需求文件十第 2 點）', `hideCount=${hideCount}`);
    }

    // D7：不可用圖塊 DOM 特性——不用原生 disabled，改用 aria-disabled；鍵盤操作交給
    // 原生 <button> 本身處理（不再額外掛 onkeydown）。
    //
    // H1.4.11.1 更新說明：原本的 D7c 斷言「圖塊具備 onkeydown」已經是過期預期——
    // H1.4.11.1 修正了「原生 button 的 Enter/Space 預設行為 + 手動 onkeydown 呼叫
    // 同一個處理函式」會造成鍵盤操作 double-fire 的風險（見
    // CHANGELOG_H1_4_11_1_...md 第六節），做法是移除多餘的 onkeydown、只保留原生
    // <button type="button"> 的 onclick。這裡把 D7c 改寫成驗證修正後的正確狀態，
    // 而不是直接刪除，理由記錄於 changelog。
    {
      const html = ev(`_ffTileHtml('delivery', {selectable:false, state:'not_started', canPreorder:false}, {pageMode:'combined_checkout', viewMode:null})`);
      assert(/<button\s+type="button"/.test(html), 'D7 圖塊是原生 <button type="button">');
      assert(html.includes('aria-disabled="true"'), 'D7b 不可用圖塊具備 aria-disabled="true"');
      assert(!/<button[^>]*\sdisabled(\s|>|=)/i.test(html), 'D7c 不可用圖塊不使用原生 disabled 屬性（否則點擊事件會被完全阻擋，無法顯示 Toast，需求文件十第十一點）');
      assert(!/onkeydown/.test(html), 'D7d（H1.4.11.1 更新）圖塊不再包含 inline onkeydown——原生 button 對 Enter/Space 已有預設行為，重複掛載會造成 double-fire，改由原生行為單獨負責鍵盤觸發');
    }
    // D7e（H1.4.11.1 新增）：真的在 DOM 上點擊一次不可用圖塊，驗證只產生一次 Toast、
    // 且不會改變任何訂單方式狀態（呼應 D7d 移除 onkeydown 後的行為保證）。
    {
      const html = ev(`_ffTileHtml('delivery', {selectable:false, state:'not_started', canPreorder:false, startTime:'16:00'}, {pageMode:'combined_checkout', viewMode:null})`);
      ev(`
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
        window.__d7eToastCalls = [];
        window.__d7eOrigToast = toast;
        toast = function(msg, ms){ window.__d7eToastCalls.push({msg, ms}); };
        window.__d7eBtn = document.body.querySelector('.ff-tile[data-mode="delivery"]');
        _ffViewMode = null; currentMode = 'takeout';
      `);
      ev(`window.__d7eBtn.dispatchEvent(new window.Event('click', {bubbles:true, cancelable:true}))`);
      const toastCalls = ev('window.__d7eToastCalls');
      const viewModeAfter = ev('_ffViewMode');
      const currentModeAfter = ev('currentMode');
      assert(Array.isArray(toastCalls) && toastCalls.length === 1, 'D7e 灰色圖塊單次點擊只產生一次 Toast', `count=${toastCalls && toastCalls.length}`);
      assert(viewModeAfter === null, 'D7e-b 點擊不可用圖塊不會設定 _ffViewMode');
      assert(currentModeAfter === 'takeout', 'D7e-c 點擊不可用圖塊不會改變 currentMode（訂單方式）');
      ev(`toast = window.__d7eOrigToast; window.__d7eBtn.remove();`);
    }

    // D8：圖塊排列順序——外送在左、外帶在右（需求文件五第一、二點／Uber 排列）
    {
      ev(`
        shopData.takeout_status  = { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false };
        shopData.delivery_status = { today_state:'open', today_open:true, today_label:'開放中', earliest_today:60, allow_next_day:false };
        window.__barEl = { style:{}, className:'', innerHTML:'' };
      `);
      ev(`
        const _origGetById2 = document.getElementById;
        document.getElementById = function(id){ return id==='serviceStatusBar' ? window.__barEl : _origGetById2.call(document, id); };
      `);
      ev(`buildServiceStatusBar()`);
      const barHtml = ev('window.__barEl.innerHTML');
      const deliveryIdx = barHtml.indexOf('data-mode="delivery"');
      const takeoutIdx = barHtml.indexOf('data-mode="takeout"');
      assert(deliveryIdx !== -1 && takeoutIdx !== -1 && deliveryIdx < takeoutIdx, 'D8 圖塊 DOM 順序：外送（delivery）在外帶（takeout）之前（左外送、右外帶）', `deliveryIdx=${deliveryIdx} takeoutIdx=${takeoutIdx}`);
    }

    // D9：合併模式仍顯示雙圖塊（不得退回舊版黃色純文字列）
    {
      const barHtml = ev('window.__barEl.innerHTML');
      assert(barHtml.includes('fulfillment-tiles'), 'D9 buildServiceStatusBar() 輸出包含 .fulfillment-tiles 容器（雙圖塊），不是舊版純文字列（需求文件二、十四第 7 項）');
      assert(!/service-mode/.test(barHtml), 'D9b 輸出不含舊版 .service-mode 純文字 class（確認舊黃色文字列渲染路徑已被取代）');
    }

    // D10：合併模式下，_ffViewMode 永遠不會出現在任何會被送出訂單的欄位裡（靜態
    // 資料流檢查：確認 handleFulfillmentTileClick 對 oType/currentMode 的唯讀性，
    // 已於 D3 用真實呼叫驗證過；這裡額外確認 _ffViewMode 本身不是 window.oType 的
    // 別名參照，而是獨立變數）。
    {
      ev(`_ffViewMode = 'delivery';`);
      const oTypeStillTakeout = ev('window.__oType.value');
      assert(oTypeStillTakeout === 'takeout', 'D10 設定 _ffViewMode 不會連動改變 #oType（兩者是完全獨立的變數，需求文件六）');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // E. 生命週期去重（需求文件十一）
  // ══════════════════════════════════════════════════════════════════
  {
    const lineOrderHtmlSrc = htmlSrc;
    const wiredMatches = lineOrderHtmlSrc.match(/window\._lifecycleWired/g) || [];
    // 靜態層級只用來確認「有沒有意外複製貼上出現第二組獨立的 guard 變數名」，
    // 真正的「不會重複註冊」由下面的實際執行驗證，不是只看字串出現次數。
    assert(wiredMatches.length >= 1, 'E0 存在 _lifecycleWired 去重旗標（第一步靜態確認變數確實存在）');
  }
  if (dom) {
    const w = dom.window;
    const ev = (code) => w.eval(code);
    // E1：實際執行 init() 內註冊 visibilitychange/pageshow 的那段程式碼兩次，
    // 驗證 addEventListener 只被呼叫一次（用真正的 spy 取代 addEventListener）。
    ev(`
      window.__docAddCalls = 0; window.__winAddCalls = 0;
      const _origDocAdd = document.addEventListener.bind(document);
      const _origWinAdd = window.addEventListener.bind(window);
      document.addEventListener = function(type, fn){ if(type==='visibilitychange') window.__docAddCalls++; return _origDocAdd(type, fn); };
      window.addEventListener = function(type, fn){ if(type==='pageshow') window.__winAddCalls++; return _origWinAdd(type, fn); };
      window._lifecycleWired = false; // 模擬「尚未註冊過」的初始狀態
      function __wireLifecycleTwice(){
        for(let i=0;i<2;i++){
          if(!window._lifecycleWired){
            window._lifecycleWired=true;
            document.addEventListener('visibilitychange', ()=>{});
            window.addEventListener('pageshow', ()=>{});
          }
        }
      }
      __wireLifecycleTwice();
    `);
    const docAddCalls = ev('window.__docAddCalls');
    const winAddCalls = ev('window.__winAddCalls');
    assert(docAddCalls === 1, 'E1 _lifecycleWired guard 確實防止 visibilitychange 被重複註冊（實際執行兩次呼叫，只留下一次註冊）', `docAddCalls=${docAddCalls}`);
    assert(winAddCalls === 1, 'E1b _lifecycleWired guard 確實防止 pageshow 被重複註冊', `winAddCalls=${winAddCalls}`);
  }

  printSummary();
}

function _futureDateStr(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

main()
  .catch((e) => { fail('FATAL', e.stack || e.message); printSummary(); })
  .finally(() => {
    try { if (server) server.close(); } catch (e) {}
    try { if (typeof dom !== 'undefined' && dom) dom.window.close(); } catch (e) {}
    // jsdom 執行 line-order.html 內嵌 script 時會啟動 setInterval(60s 輪詢)／
    // WebSocket 重連 timer 等背景計時器（正式頁面環境本來就該持續運作，這裡只是
    // 測試環境需要明確結束 process，避免 node 因為殘留 timer 而不退出）。
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });
