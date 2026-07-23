// scripts/smoke-hotfix30-c1-rollback.js
// fix18-10-hotfix30-C1-回退：純函式回歸測試，不需要啟動伺服器／資料庫。
// 驗證項目（回退指令第九、十節）：
//   1. 共用時段解析優先順序（優先舊版共同欄位）
//   2. 舊雙欄位相同 → 可 fallback
//   3. 舊雙欄位不同 → 視為未設定，不可任意選一組
//   4. 重置後（共同欄位與雙欄位皆空）→ unrestricted（start/end 皆為 null）
//   5. 外帶／外送商品時間判斷完全一致（getEffectiveProductSaleWindow 回傳同一組值，
//      不因 mode 參數不同而分岔）
//
// 執行方式： node scripts/smoke-hotfix30-c1-rollback.js
'use strict';

const path = require('path');
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. 後端：routes/line-orders.js 的 getEffectiveProductSaleWindow() ──────
// 注意：不直接 require 整個 routes/line-orders.js（會連帶載入 express、node-fetch、
// uuid 等完整依賴，本沙盒環境未安裝 node_modules）。改用與下方前端測試相同的
// 「抽取原始碼＋vm 沙盒執行」方式，只測試這個純函式本身的邏輯，不牽動其餘路由。
console.log('\n[1] routes/line-orders.js getEffectiveProductSaleWindow()（原始碼字串抽取後在沙盒中執行）');
const fs0 = require('fs');
const vm0 = require('vm');
const lineOrdersPath = path.join(__dirname, '..', 'routes', 'line-orders.js');
const lineOrdersSrc = fs0.readFileSync(lineOrdersPath, 'utf8');
const beMatch = lineOrdersSrc.match(/function getEffectiveProductSaleWindow\(product, _mode\) \{[\s\S]*?\n\}/);
let getEffectiveProductSaleWindow = null;
if (beMatch) {
  const sandbox0 = {};
  vm0.createContext(sandbox0);
  vm0.runInContext(beMatch[0] + '\nthis.getEffectiveProductSaleWindow = getEffectiveProductSaleWindow;', sandbox0);
  getEffectiveProductSaleWindow = sandbox0.getEffectiveProductSaleWindow;
}
check('已在 line-orders.js 找到 getEffectiveProductSaleWindow 原始碼並可執行',
  typeof getEffectiveProductSaleWindow === 'function');

if (getEffectiveProductSaleWindow) {
// 案例 A：優先使用共同欄位
{
  const p = { line_sell_start: '15:30', line_sell_end: '19:50',
              line_takeout_sell_start: '09:00', line_takeout_sell_end: '23:00' };
  const r = getEffectiveProductSaleWindow(p);
  check('案例A：優先使用共同欄位', r.start === '15:30' && r.end === '19:50', JSON.stringify(r));
}

// 案例 B：共同欄位皆空，舊雙欄位相同 → fallback
{
  const p = { line_sell_start: null, line_sell_end: null,
              line_takeout_sell_start: '15:30', line_takeout_sell_end: '19:50',
              line_delivery_sell_start: '15:30', line_delivery_sell_end: '19:50' };
  const r = getEffectiveProductSaleWindow(p);
  check('案例B：雙欄位相同 → fallback 為共同時段',
    r.start === '15:30' && r.end === '19:50', JSON.stringify(r));
}

// 案例 C：共同欄位皆空，舊雙欄位不同 → 視為未設定
{
  const p = { line_sell_start: '', line_sell_end: '',
              line_takeout_sell_start: '15:30', line_takeout_sell_end: '19:50',
              line_delivery_sell_start: '09:00', line_delivery_sell_end: '23:00' };
  const r = getEffectiveProductSaleWindow(p);
  check('案例C：雙欄位不同 → 視為未設定（不可任意選一組）',
    r.start === null && r.end === null, JSON.stringify(r));
}

// 案例 D：全部皆空 → unrestricted
{
  const p = { line_sell_start: null, line_sell_end: null };
  const r = getEffectiveProductSaleWindow(p);
  check('案例D：全部皆空 → unrestricted（start/end 皆為 null）',
    r.start === null && r.end === null, JSON.stringify(r));
}

// 案例 E：外帶／外送判斷完全一致（mode 參數不影響結果）
{
  const p = { line_sell_start: '15:30', line_sell_end: '19:50' };
  const rTakeout  = getEffectiveProductSaleWindow(p, 'takeout');
  const rDelivery = getEffectiveProductSaleWindow(p, 'delivery');
  check('案例E：外帶／外送取得同一組共同時段（不因 mode 分岔）',
    rTakeout.start === rDelivery.start && rTakeout.end === rDelivery.end &&
    rTakeout.start === '15:30' && rTakeout.end === '19:50');
}
} // end if (getEffectiveProductSaleWindow)

// ── 2. 前端：public/js/app.js 的 _lpmEffectiveSaleWindow() ─────────────────
console.log('\n[2] public/js/app.js _lpmEffectiveSaleWindow()（以原始碼字串抽取後在沙盒中執行）');
const fs = require('fs');
const vm = require('vm');
const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const appSrc = fs.readFileSync(appJsPath, 'utf8');
const fnMatch = appSrc.match(/function _lpmEffectiveSaleWindow\(p\) \{[\s\S]*?\n\}/);
check('已在 app.js 找到 _lpmEffectiveSaleWindow 原始碼', !!fnMatch);

if (fnMatch) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fnMatch[0] + '\nthis._lpmEffectiveSaleWindow = _lpmEffectiveSaleWindow;', sandbox);
  const _lpmEffectiveSaleWindow = sandbox._lpmEffectiveSaleWindow;

  {
    const p = { line_sell_start: '15:30', line_sell_end: '19:50' };
    const r = _lpmEffectiveSaleWindow(p);
    check('前端 案例A：優先使用共同欄位', r.start === '15:30' && r.end === '19:50', JSON.stringify(r));
  }
  {
    const p = { line_sell_start: '', line_sell_end: '',
                line_takeout_sell_start: '15:30', line_takeout_sell_end: '19:50',
                line_delivery_sell_start: '15:30', line_delivery_sell_end: '19:50' };
    const r = _lpmEffectiveSaleWindow(p);
    check('前端 案例B：雙欄位相同 → fallback', r.start === '15:30' && r.end === '19:50', JSON.stringify(r));
  }
  {
    const p = { line_sell_start: '', line_sell_end: '',
                line_takeout_sell_start: '15:30', line_takeout_sell_end: '19:50',
                line_delivery_sell_start: '09:00', line_delivery_sell_end: '23:00' };
    const r = _lpmEffectiveSaleWindow(p);
    check('前端 案例C：雙欄位不同 → 視為未設定', r.start === '' && r.end === '', JSON.stringify(r));
  }
  {
    const p = {};
    const r = _lpmEffectiveSaleWindow(p);
    check('前端 案例D：全部皆空 → 未限制', r.start === '' && r.end === '', JSON.stringify(r));
  }
}

// ── 3. 靜態檢查：確認回退指令要求移除的 UI/邏輯確實不存在 ──────────────────
console.log('\n[3] 靜態檢查：確認拆分欄位已移除、未殘留於商品管理 UI 主要流程');
const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
const indexSrc = fs.readFileSync(indexHtmlPath, 'utf8');
check('index.html 不再含有 lineTakeoutSellStart', !indexSrc.includes('lineTakeoutSellStart'));
check('index.html 不再含有 lineDeliverySellStart', !indexSrc.includes('lineDeliverySellStart'));
check('index.html 不再含有 lpm-to-sell-start（外帶批次輸入框）', !indexSrc.includes('lpm-to-sell-start'));
check('index.html 不再含有 lpm-dl-sell-start（外送批次輸入框）', !indexSrc.includes('lpm-dl-sell-start'));
check('index.html 含有單一 lineSellStart（Modal 共同時段欄位）', indexSrc.includes('id="lineSellStart"'));
check('index.html 含有單一 lpm-today-sell-start（批次共同時段欄位）', indexSrc.includes('id="lpm-today-sell-start"'));

check('app.js 不再含有 sell_time_takeout', !appSrc.includes('sell_time_takeout'));
check('app.js 不再含有 sell_time_delivery', !appSrc.includes('sell_time_delivery'));
check('app.js 含有單一 sell_time 批次類型', appSrc.includes("type === 'sell_time'"));

const productsJsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'products.js'), 'utf8');
check('products.js 含有 normalizeOptionalTime()', productsJsSrc.includes('function normalizeOptionalTime'));
check('products.js 舊雙欄位 migration 函式仍保留（不做破壞性 migration）',
  productsJsSrc.includes('function ensureProductSaleWindowColumns'));

// ── 總結 ───────────────────────────────────────────────────────────────
console.log(`\n總計：${pass} 通過，${fail} 失敗`);
if (fail > 0) process.exit(1);
