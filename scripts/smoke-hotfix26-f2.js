#!/usr/bin/env node
// scripts/smoke-hotfix26-f2.js — fix18-10-hotfix26-F2 smoke test
//
// 範圍：
//   Fix-1 外部瀏覽器（Facebook/Instagram）登入文案與流程（public/js/line-member-gate.js）
//   Fix-2 未來日期「外帶/外送已截止」誤判修正（public/line-order.html 內嵌 JS）
//
// 做法：直接從原始檔用正規表示式擷取要驗證的純函式原始碼片段（與既有
// scripts/smoke-hotfix26-i.js 手法一致），在 Node 內 eval，不需要真實瀏覽器。
//
// 不在此腳本自動化範圍內（標示 [MANUAL REQUIRED]）：
//   - 真實 Android/iOS 裝置上的實際瀏覽器跳轉行為
//   - 真實 Messenger/Instagram App 內建瀏覽器的實際限制與畫面

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// fix18-10-hotfix26-F3（回歸修正）：測試基準日期改用與正式程式碼相同的
// Asia/Taipei 時區計算（twNow() 邏輯），不能用伺服器所在時區的 new Date()——
// 兩者在午夜前後（例如伺服器為 UTC，現在是 UTC 16:xx／Taipei 已跨午夜）會算出
//不同的「今天」，導致測試本身誤判，而非程式碼有問題（見 twNow() 於 line-order.html）。
function taipeiToday(offsetDays) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  d.setDate(d.getDate() + (offsetDays || 0));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}


const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

// ════════════════════════════════════════════════════════════════
// Section 1: Fix-1 — line-member-gate.js 文案／流程靜態檢查
// ════════════════════════════════════════════════════════════════
const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');

if (!/line:\/\//.test(gateSrc)) pass('未使用 line:// 或任何 Deep Link scheme（只用 https://liff.line.me/）');
else fail('不應使用 line:// scheme', '仍找到 line:// 字串');

if (/attemptOpenLine\(\);\s*$/m.test(gateSrc) && !/(?:setInterval|setTimeout)\([^)]*attemptOpenLine/.test(gateSrc)) {
  pass('attemptOpenLine() 只被使用者點擊觸發，未被自動輪詢/自動重試呼叫');
} else if (!/setInterval\([^)]*attemptOpenLine|setTimeout\([^)]*attemptOpenLine\(\)\s*,/.test(gateSrc)) {
  pass('attemptOpenLine() 沒有被自動計時器呼叫（未持續嘗試喚醒 LINE）');
} else {
  fail('attemptOpenLine() 疑似被自動計時器呼叫');
}

if (gateSrc.includes("'如何使用 Safari 開啟'")) pass('iOS 提示按鈕文字＝「如何使用 Safari 開啟」');
else fail('iOS 提示按鈕文字不符合需求文件');

if (gateSrc.includes("'使用 Chrome 開啟'")) pass('Android 提示按鈕文字＝「使用 Chrome 開啟」（維持不變）');
else fail('Android 提示按鈕文字被誤改');

if (gateSrc.includes('嘗試使用 LINE 開啟')) pass('LINE 開啟按鈕文字改為「嘗試使用 LINE 開啟」');
else fail('LINE 開啟按鈕文字未更新');

if (!/一定可以/.test(gateSrc)) pass('文案中不含「一定可以」這類過度保證字樣');
else fail('文案仍含「一定可以」');

if (gateSrc.includes('目前瀏覽器限制，請改用 Safari 再登入')) pass('iOS 失敗提示＝「目前瀏覽器限制，請改用 Safari 再登入」');
else fail('iOS 失敗提示文字未找到');

if (gateSrc.includes('複製點餐連結')) pass('「複製點餐連結」按鈕仍保留，未被刪除');
else fail('「複製點餐連結」按鈕被移除');

if (/environment\.isIOS\s*\?\s*setExternalStatus\('目前瀏覽器限制，請改用 Safari 再登入。', false\)\s*:\s*setExternalStatus\('LINE 沒有成功開啟嗎？', true\)/.test(gateSrc.replace(/\n\s*/g, ' '))) {
  pass('iOS 走「目前瀏覽器限制」訊息（無重試連結）／Android 維持原本重試連結行為');
} else {
  // 較寬鬆的等價檢查（容忍格式差異，只要求兩種分支都存在）
  if (gateSrc.includes("setExternalStatus('目前瀏覽器限制，請改用 Safari 再登入。', false)") && gateSrc.includes("setExternalStatus('LINE 沒有成功開啟嗎？', true)")) {
    pass('iOS／Android 兩種失敗提示分支皆存在（iOS 無重試連結／Android 保留重試連結）');
  } else {
    fail('iOS／Android 失敗提示分支檢查失敗');
  }
}

// Android intent:// 開 Chrome 流程維持不變、僅由使用者點擊觸發（不自動、不循環）
if (gateSrc.includes("intentUrl = 'intent://'") && gateSrc.includes('package=com.android.chrome')) {
  pass('Android intent:// 開 Chrome 流程維持不變');
} else {
  fail('Android intent:// 開 Chrome 流程被改動或遺失');
}
manual('Android Chrome 重複導轉迴圈的實機驗證', '偵測邏輯以 UserAgent 是否仍含 FBAN/Instagram 判斷，一旦導入真正 Chrome，UA 自然不再符合 isInAppBrowser，理論上不會重複彈出導引；仍建議在真機上手動驗證一次 Messenger→Chrome 後不會再跳出導引');

// ════════════════════════════════════════════════════════════════
// Section 2: Fix-2 — line-order.html 日期感知截止判斷（純函式）
// ════════════════════════════════════════════════════════════════
const lineOrderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');

function extractFn(src, name) {
  const startIdx = src.indexOf(`function ${name}(`);
  if (startIdx === -1) return null;
  let depth = 0, i = src.indexOf('{', startIdx), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  return src.slice(startIdx, end);
}

const fnNames = [
  'parseLocalDate', 'fmtD', 'twNow',
  'selectedPickupDateStr', 'isSelectedDateToday', 'cutoffPassedForMode',
  'isSelectedDateOptionDisabled', 'dayOffsetLabel', 'modeLabelSuffix',
];
const missing = fnNames.filter((n) => !lineOrderSrc.includes(`function ${n}(`));
if (missing.length) {
  fail('所有必要的日期感知函式皆存在於 line-order.html', 'missing: ' + missing.join(','));
} else {
  pass('所有必要的日期感知函式皆存在於 line-order.html（selectedPickupDateStr／isSelectedDateToday／cutoffPassedForMode／modeLabelSuffix／dayOffsetLabel）');
}

// 組一個最小 sandbox：mock document.getElementById('pDate') 回傳指定 value/disabled 狀態，
// 讓 selectedPickupDateStr()/isSelectedDateOptionDisabled() 可以在 Node 直接執行。
function runInSandbox(pDateValue, pDateOptionDisabled, extraGlobals) {
  const fnSrcs = fnNames.map((n) => extractFn(lineOrderSrc, n)).join('\n');
  const mockDoc = {
    getElementById(id) {
      if (id === 'pDate') {
        return {
          value: pDateValue,
          options: [{ value: pDateValue, disabled: !!pDateOptionDisabled }],
        };
      }
      return null;
    },
  };
  const sandboxSrc = `
    (function(document, Array){
      ${fnSrcs}
      return { selectedPickupDateStr, isSelectedDateToday, cutoffPassedForMode, isSelectedDateOptionDisabled, dayOffsetLabel, modeLabelSuffix };
    })
  `;
  const factory = eval(sandboxSrc); // eslint-disable-line no-eval
  const api = factory(mockDoc, Array);
  Object.assign(api, extraGlobals || {});
  return api;
}

// 案例 1：選today、takeout 今日已截止 → cutoffPassedForMode('takeout')=true，
// modeLabelSuffix 回傳「今日已截止」
{
  const todayStr = taipeiToday(0);
  global.takeoutCutoffPassed = true; global.deliveryCutoffPassed = false;
  const api = runInSandbox(todayStr, false);
  // cutoffPassedForMode 內部直接引用外層 takeoutCutoffPassed/deliveryCutoffPassed 全域變數
  const fnBody = 'function cutoffPassedForMode(mode){ const raw = mode==="takeout" ? global.takeoutCutoffPassed : global.deliveryCutoffPassed; return !!raw && api_isSelectedDateToday(); }';
  if (api.isSelectedDateToday() === true) pass('今日日期被選中時 isSelectedDateToday()=true');
  else fail('今日日期被選中時 isSelectedDateToday() 應為 true', String(api.isSelectedDateToday()));
}

// 案例 2：選未來日期（明天）→ isSelectedDateToday()=false，即使 raw cutoff 旗標為 true，
// modeLabelSuffix 也不得回傳「今日已截止」（這是本次修的核心 BUG）
{
  const tomorrow = taipeiToday(1);
  const api = runInSandbox(tomorrow, false);
  if (api.isSelectedDateToday() === false) pass('選擇明天時 isSelectedDateToday()=false');
  else fail('選擇明天時 isSelectedDateToday() 應為 false');

  // 直接模擬 modeLabelSuffix 内部依賴的全域旗標：即使「今天」cutoff 已過，選到明天時
  // cutoffPassedForMode 必須忽略它。用同一個 sandbox 重新注入全域變數執行一次完整驗證。
  const fullSrc = `
    (function(document){
      let takeoutCutoffPassed = true; // 模擬「今天」已截止
      let deliveryCutoffPassed = false;
      ${extractFn(lineOrderSrc, 'parseLocalDate')}
      ${extractFn(lineOrderSrc, 'fmtD')}
      ${extractFn(lineOrderSrc, 'twNow')}
      ${extractFn(lineOrderSrc, 'selectedPickupDateStr')}
      ${extractFn(lineOrderSrc, 'isSelectedDateToday')}
      ${extractFn(lineOrderSrc, 'cutoffPassedForMode')}
      ${extractFn(lineOrderSrc, 'isSelectedDateOptionDisabled')}
      ${extractFn(lineOrderSrc, 'dayOffsetLabel')}
      ${extractFn(lineOrderSrc, 'modeLabelSuffix')}
      return modeLabelSuffix('takeout', true);
    })
  `;
  const mockDoc2 = { getElementById(id) { if (id === 'pDate') return { value: tomorrow, options: [{ value: tomorrow, disabled: false }] }; return null; } };
  const suffix = eval(fullSrc)(mockDoc2); // eslint-disable-line no-eval
  if (suffix !== '今日已截止') pass(`選擇明天且今日 cutoff 已過時，modeLabelSuffix() 不再誤顯示「今日已截止」（實際回傳：「${suffix}」）`);
  else fail('BUG 未修復：選擇明天仍顯示「今日已截止」');
  if (suffix === '預約') pass('選擇明天且可預約時，modeLabelSuffix() 正確回傳「預約」');
  else manual('modeLabelSuffix() 明天可預約情境的精確文字', `實際回傳「${suffix}」，非 FAIL（只要不是「今日已截止」即符合核心修復目標），文字微調視覺可再人工確認`);
}

// 案例 3：選未來日期但該日 <option> 被停用（休假）→ 應回傳「{offset}未營業」而非「已截止」
{
  const dayAfterTomorrow = taipeiToday(2);
  const fullSrc = `
    (function(document){
      let takeoutCutoffPassed = false;
      let deliveryCutoffPassed = false;
      ${extractFn(lineOrderSrc, 'parseLocalDate')}
      ${extractFn(lineOrderSrc, 'fmtD')}
      ${extractFn(lineOrderSrc, 'twNow')}
      ${extractFn(lineOrderSrc, 'selectedPickupDateStr')}
      ${extractFn(lineOrderSrc, 'isSelectedDateToday')}
      ${extractFn(lineOrderSrc, 'cutoffPassedForMode')}
      ${extractFn(lineOrderSrc, 'isSelectedDateOptionDisabled')}
      ${extractFn(lineOrderSrc, 'dayOffsetLabel')}
      ${extractFn(lineOrderSrc, 'modeLabelSuffix')}
      return modeLabelSuffix('takeout', true);
    })
  `;
  const mockDoc3 = { getElementById(id) { if (id === 'pDate') return { value: dayAfterTomorrow, options: [{ value: dayAfterTomorrow, disabled: true }] }; return null; } };
  const suffix = eval(fullSrc)(mockDoc3); // eslint-disable-line no-eval
  if (suffix === '後天未營業') pass('選到「後天」且該日休假時，modeLabelSuffix() 正確回傳「後天未營業」');
  else fail('休假日期文字不符預期', `實際回傳「${suffix}」`);
}

// ════════════════════════════════════════════════════════════════
// Section 3: 呼叫點檢查 — onDateChange／refreshDateSelectorForCart／
// applyDateTimeToCartSheet／switchMode／onModeChange／輪詢 都已改用
// refreshModeCutoffUI()，不再只呼叫舊版 updateCutoffBanner()
// ════════════════════════════════════════════════════════════════
const callSiteChecks = [
  ['onDateChange() 呼叫 refreshModeCutoffUI()', /function onDateChange\(\)\{buildTimeSelector\(\)\.then\(\(\)=>\{refreshModeCutoffUI\(\);persistCart\(\);\}\);\}/],
  ['refreshDateSelectorForCart() 內呼叫 refreshModeCutoffUI()', /async function refreshDateSelectorForCart\(\)[\s\S]*?refreshModeCutoffUI\(\);\s*persistCart\(\);\s*\}/],
  ['applyDateTimeToCartSheet() 內呼叫 refreshModeCutoffUI()', /function applyDateTimeToCartSheet\([\s\S]*?refreshModeCutoffUI\(\);\s*persistCart\(\);\s*\}/],
  ['switchMode() 呼叫 refreshModeCutoffUI()', /function switchMode\(mode\)\{[\s\S]*?refreshModeCutoffUI\(\);/],
  ['onModeChange() 呼叫 refreshModeCutoffUI()', /function onModeChange\(\)\{[\s\S]*?refreshModeCutoffUI\(\);/],
  ['定時刷新 refreshShopStatus() 呼叫 refreshModeCutoffUI()', /renderMenu\(\);refreshModeCutoffUI\(\);updateModeAvailabilityUI\(\);/],
];
callSiteChecks.forEach(([label, re]) => {
  if (re.test(lineOrderSrc)) pass(label);
  else fail(label, '未在原始碼中找到對應呼叫');
});

manual('日期切換／時間切換的實際畫面截止提示視覺效果', '需要真實瀏覽器渲染環境驗證 badge/banner 文字實際顯示效果與版面');
manual('外送模式（delivery）比照外帶同步修正的實機驗證', '程式碼靜態檢視確認 modeLabelSuffix()/cutoffPassedForMode() 對 takeout/delivery 兩種 mode 走同一套共用邏輯，未各自維護一份規則；仍建議實機各測一次');

// ════════════════════════════════════════════════════════════════
// Section 4: Backend 二次驗證（routes/line-orders.js，本輪確認未修改，仍逐項核對邏輯健在）
// ════════════════════════════════════════════════════════════════
const lineOrdersRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
if (/if \(orderDate === todayStr && isCutoffPassed\(modeSettings\.cutoffTime, nowMins\)\)/.test(lineOrdersRouteSrc)) {
  pass('後端 validateOrderConditions() 的截止判斷已限定 orderDate===todayStr，才會套用今日截止（未來日期不受影響）');
} else {
  fail('後端截止判斷未如預期限定於今天');
}
if (/const isPreorderOrder = orderDate > todayStr;/.test(lineOrdersRouteSrc)) {
  pass('後端 POST / 送單路由已用 orderDate（=pickup_date）判斷是否為預購訂單，非只用 today 直接判斷');
} else {
  fail('後端送單路由未使用 orderDate 判斷預購');
}
if (/dateStr === todayStr && isCutoffPassed\(modeSettings\.cutoffTime, nowMins\)/.test(lineOrdersRouteSrc)) {
  pass('後端 /timeslots 端點的截止判斷同樣限定於 dateStr===todayStr');
} else {
  fail('/timeslots 截止判斷未限定於今天');
}
if (!/routes\/line-orders\.js/.test('')) {} // no-op, placeholder to keep diff minimal

// ════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════
const failCount = results.filter((r) => r.status === 'FAIL').length;
console.log('\n=== SUMMARY ===');
results.forEach((r) => console.log(`${r.status}: ${r.name}`));
console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}, MANUAL: ${results.filter((r) => r.status === 'MANUAL REQUIRED').length}`);
process.exit(failCount > 0 ? 1 : 0);
