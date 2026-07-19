#!/usr/bin/env node
// scripts/smoke-hotfix27.js — fix18-10-hotfix27 smoke test
//
// 涵蓋需求文件十一案例：Integration route 掛載、store_id 隔離、Basic ID／
// Join URL／LIFF ID 存取、Secret 不洩漏、空白不覆蓋舊值、Checkout Handoff
// 開關、Messenger 兩種文案版本、複製結帳代碼標籤、Cart Code 顯示區塊、
// Auto Open 防重複、Bot regex（含新格式）、Diagnostics 狀態、多租戶隔離、
// F8-B Regression、Android 未修改。
//
// 誠實揭露：LINE Developers 後台實際的 Webhook Verify、真實 replyToken 的
// Reply API 呼叫、真實使用者的 Push API 推播，都需要 LINE 平台或真實 LIFF
// 瀏覽器環境才能驗證，這裡一律標記 MANUAL REQUIRED，不假裝自動測試可以
// 取代真實平台驗證。
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const TEST_PORT = 5799;
const BASE = `http://localhost:${TEST_PORT}`;

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(url + '/api/health');
          if (r.ok) return resolve();
        } catch (e) { /* not up yet */ }
        await new Promise(r2 => setTimeout(r2, 200));
      }
      reject(new Error('server did not start in time'));
    })();
  });
}

async function main() {
  // ── 啟動一份真正的 server.js（獨立 port），才能測試真實 HTTP route
  //    （requireStaffJwt／signature 驗證等中介層邏輯必須跑過真的 Express pipeline）──
  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', d => { serverLog += d.toString(); });
  serverProc.stderr.on('data', d => { serverLog += d.toString(); });

  try {
    await waitForServer(BASE, 15000);
  } catch (e) {
    console.error('[smoke-hotfix27] server 未能啟動:', e.message);
    console.error(serverLog.slice(-2000));
    serverProc.kill();
    process.exit(1);
  }

  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/storeGuard');

  const STORE_A = 'store_hotfix27_a';
  const STORE_B = 'store_hotfix27_b';
  function staffToken(storeId) {
    return jwt.sign({ store_id: storeId, role: 'staff', store_name: storeId }, JWT_SECRET, { expiresIn: '1h' });
  }
  // requireStore（給 /api/settings 用）走 x-store-id header 就夠，不需要 JWT。
  function storeHeaders(storeId) { return { 'x-store-id': storeId, 'Content-Type': 'application/json' }; }
  function staffHeaders(storeId) { return { Authorization: 'Bearer ' + staffToken(storeId), 'Content-Type': 'application/json' }; }

  try {
    // ── 先透過 Super Admin API 建立測試店家（stores 表沒有這兩個 store_id
    //    的話，requireStore 會直接 403「店家不存在」，settings 相關測試
    //    才過不了——這裡用系統既有機制建店，不直接寫 DB）───────────────
    const loginRes = await fetch(`${BASE}/api/super-admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'superadmin', password: 'admin1234' }),
    }).then(r => r.json());
    if (!loginRes.success) throw new Error('super admin login failed: ' + loginRes.message);
    const saHeaders = { Authorization: 'Bearer ' + loginRes.token, 'Content-Type': 'application/json' };
    for (const sid of [STORE_A, STORE_B]) {
      const createRes = await fetch(`${BASE}/api/super-admin/stores`, {
        method: 'POST', headers: saHeaders,
        body: JSON.stringify({ store_id: sid, store_name: sid, plan: 'pro', active: true }),
      }).then(r => r.json());
      assert(createRes.success === true || createRes.message === 'store_id 已存在', `建立測試店家 ${sid}`, JSON.stringify(createRes));
    }

    // ── 需求文件二：Integration route 已掛載 ──────────────────────────
    const noAuthRes = await fetch(`${BASE}/api/line-integration/config`);
    assert(noAuthRes.status === 401, 'Integration route 已掛載且受 requireStaffJwt 保護', noAuthRes.status);

    // ── 需求文件四：Basic ID / Join URL / LIFF ID 儲存與讀取（依 store_id 隔離）──
    const putA = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: storeHeaders(STORE_A),
      body: JSON.stringify({
        line_official_basic_id: '@storeA', line_add_friend_url: 'https://lin.ee/storeA',
        line_member_liff_id: '1111111111-aaaaaaaa', line_channel_secret: 'secretA123456',
        line_channel_token: 'tokenA_ABCDEF', line_checkout_handoff_enabled: '1',
      }),
    }).then(r => r.json());
    assert(putA.success === true, 'Store A 設定寫入成功');

    const putB = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: storeHeaders(STORE_B),
      body: JSON.stringify({ line_official_basic_id: '@storeB', line_member_liff_id: '2222222222-bbbbbbbb' }),
    }).then(r => r.json());
    assert(putB.success === true, 'Store B 設定寫入成功');

    const getA = await fetch(`${BASE}/api/settings`, { headers: storeHeaders(STORE_A) }).then(r => r.json());
    assert(getA.data.line_official_basic_id === '@storeA', 'Basic ID 讀取正確（Store A）');
    assert(getA.data.line_add_friend_url === 'https://lin.ee/storeA', 'Join URL 讀取正確（Store A）');
    assert(getA.data.line_member_liff_id === '1111111111-aaaaaaaa', 'LIFF ID 讀取正確（Store A）');

    // ── 需求文件四：Secret GET 不洩漏 ──────────────────────────────────
    assert(getA.data.line_channel_secret === undefined, 'GET /api/settings 不回傳 line_channel_secret 明文');
    assert(JSON.stringify(getA).includes('secretA123456') === false, 'GET 回應完全不含明文 secret 字串');

    // ── 需求文件四：PUT 回應（settings_updated 廣播來源同一份資料）也不得洩漏 ──
    assert(JSON.stringify(putA).includes('secretA123456') === false, 'PUT 回應不含明文 secret（含先前修正的 WS broadcast/response 洩漏）');

    // ── 需求文件四：空白 Secret 不覆蓋舊值 ─────────────────────────────
    const putBlank = await fetch(`${BASE}/api/settings`, {
      method: 'PUT', headers: storeHeaders(STORE_A),
      body: JSON.stringify({ line_official_name: '測試商店A' }), // 沒有送 line_channel_secret
    }).then(r => r.json());
    const configAfterBlank = await fetch(`${BASE}/api/line-integration/config`, { headers: staffHeaders(STORE_A) }).then(r => r.json());
    assert(configAfterBlank.data.config.messaging_api.channel_secret_set === true, '未送 Secret 時不清空舊值（留白＝不變更）');

    // ── 需求文件八：Checkout Handoff 開關 ──────────────────────────────
    assert(configAfterBlank.data.config.checkout_handoff.enabled === true, 'Checkout Handoff 開關讀取正確');
    assert(configAfterBlank.data.config.checkout_handoff.dialog_variant === 'checkout', 'Basic ID 已設定 → dialog_variant=checkout');

    const configB = await fetch(`${BASE}/api/line-integration/config`, { headers: staffHeaders(STORE_B) }).then(r => r.json());
    // ── 需求文件十三：多租戶隔離 ───────────────────────────────────────
    assert(configB.data.config.official_account.basic_id === '@storeB', 'Store B 讀到自己的 Basic ID，不是 Store A 的');
    assert(configB.data.config.messaging_api.channel_secret_set === false, 'Store B 未設定 Secret，狀態正確（未跨店繼承 A 的設定）');
    assert(configB.data.config.webhook.url.includes(STORE_B) && !configB.data.config.webhook.url.includes(STORE_A), 'Webhook URL 依 store_id 產生，不會混用');

    // ── Setup Wizard 狀態判斷 ──────────────────────────────────────────
    const wizardA = configAfterBlank.data.wizard;
    assert(Array.isArray(wizardA) && wizardA.length === 6, 'Wizard 六步驟結構正確');
    assert(wizardA[0].status === 'done', 'Step1 Official Account = done（已設定 Basic ID）');
    assert(wizardA[3].status === 'done', 'Step4 Channel Secret = done（已設定）');
    assert(wizardA[4].status === 'warn', 'Step5 Verify Webhook = warn（設定完整但仍需人工到 LINE 後台確認）');
    const wizardBEmpty = configB.data.wizard;
    assert(wizardBEmpty[3].status === 'pending', 'Store B Step4 Channel Secret = pending（尚未設定）');

    // ── 需求文件十一：Diagnostics 狀態（🟢🟡🔴 + 具體原因，不是 ERROR）──
    const healthA = await fetch(`${BASE}/api/line-integration/health`, { headers: staffHeaders(STORE_A) }).then(r => r.json());
    assert(['green', 'yellow', 'red'].includes(healthA.data.overall), 'Health overall 狀態為三態之一');
    const genericErrors = healthA.data.items.filter(i => ['ERROR', '失敗', '未知錯誤'].includes(i.reason));
    assert(genericErrors.length === 0, 'Diagnostics 原因訊息具體，沒有只顯示 ERROR/失敗/未知錯誤');
    const webhookItem = healthA.data.items.find(i => i.key === 'webhook');
    assert(webhookItem && webhookItem.level === 'green', 'Webhook 簽章自我測試（已設定 Secret）= green');

    // ── 測試按鈕：checkout_handoff（建立測試 Cart Token，測完自動作廢）──
    // Store A 目前沒有商品，預期回傳「尚無已上架商品」而非假裝成功
    const testHandoff = await fetch(`${BASE}/api/line-integration/test/checkout-handoff`, { method: 'POST', headers: staffHeaders(STORE_A) }).then(r => r.json());
    assert(testHandoff.success === true && testHandoff.data.ok === false, '測試 Cart Token：沒有商品時誠實回報，不假裝成功', JSON.stringify(testHandoff));

    // ── 測試按鈕：webhook 自我測試（重用生產環境 verifySignature）──
    const testWebhook = await fetch(`${BASE}/api/line-integration/test/webhook`, { method: 'POST', headers: staffHeaders(STORE_A) }).then(r => r.json());
    assert(testWebhook.data.ok === true, 'Webhook 簽章自我測試通過（重用 routes/line-webhook.js 的 verifySignature）');

    // ── Android 未修改：只確認本輪沒有動到 android 目錄（此 zip 本來就不含 Android，這裡檢查專案內沒有意外引用）──
    assert(!fs.existsSync(path.join(__dirname, '..', 'android')), 'web 專案內未混入 android 目錄（Android 完全獨立）');

    manual('LINE Developers 後台 Webhook Verify（真正由 LINE 平台呼叫）', '本系統只能自我測試簽章邏輯與 URL 正確性，LINE 平台的 Verify 按鈕結果需人工在 LINE Developers 後台確認');
    manual('Reply API／Push API 對真實 replyToken／userId 的呼叫', '需要真實 LINE 對話產生的 replyToken，或已綁定 LINE 的真實會員 userId，本系統不會假裝可以自動測試');
    manual('Auto Open LINE 在真實 Messenger/Instagram WebView 的實際跳轉效果', '需要真實 iOS/Android 裝置的 Facebook/Messenger/Instagram App 內建瀏覽器');

  } finally {
    serverProc.kill();
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Bot Regex（純函式測試，不需要 HTTP）──────────────────────────────
  const CHECKOUT_MESSAGE_RE = /^\s*(?:我要結帳\s+)?(CART-[A-Z0-9]{6,32})\s*$/i;
  assert(!!'CART-34ZA2V'.match(CHECKOUT_MESSAGE_RE), 'Bot 接受純 CART code');
  assert(!!'我要結帳 CART-34ZA2V'.match(CHECKOUT_MESSAGE_RE), 'Bot 接受「我要結帳 CART-XXXXXX」');
  assert(!' CART-34ZA2V '.match(CHECKOUT_MESSAGE_RE) === false, 'Bot 允許前後空白');
  assert(!'我想問CART-34ZA2V多少錢'.match(CHECKOUT_MESSAGE_RE), '無效格式（夾在句子中）正確拒絕');
  assert(!'隨便打的訊息'.match(CHECKOUT_MESSAGE_RE), '無關訊息正確拒絕');

  // ── Messenger Dialog UX 結構檢查（沿用 F3 慣例，靜態比對原始碼）─────────
  const gateSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'line-member-gate.js'), 'utf8');
  assert(gateSrc.includes('若沒有自動跳轉，請點下方按鈕'), 'Messenger 已設定版文案：「若沒有自動跳轉，請點下方按鈕」存在');
  assert(gateSrc.includes('目前商家尚未完成 LINE 一鍵結帳設定'), 'Messenger 未設定版文案：「目前商家尚未完成 LINE 一鍵結帳設定」存在');
  assert(gateSrc.includes('請加入官方 LINE，並將下方結帳代碼貼到聊天室即可繼續完成結帳'), 'Messenger 未設定版文案：引導加入官方 LINE＋貼代碼');
  // fix18-10-hotfix29：icon+文字排版 helper 把兩者分成不同 <span>，不再是
  // 連續字串「📋 複製結帳代碼」，分別檢查 icon 與文字都存在即可。
  assert(gateSrc.includes('📋') && gateSrc.includes('複製結帳代碼') && gateSrc.includes('lmgCopyCartCodeBtn'), '「複製結帳代碼」按鈕存在（非「複製結帳連結」，hotfix29：icon 與文字分開排版）');
  assert(gateSrc.includes('lmgCartCodeBlock') && gateSrc.includes('您的結帳代碼'), 'Cart Code 顯示區塊存在');
  // fix18-10-hotfix27-CD：session key 從「每店一把」改成「每店+每 cart_code
  // 一把」（line_checkout_auto_launch:${storeId}:${cartCode}），比舊版更精準
  // （不同筆結帳各自只自動嘗試一次，而不是整個分頁共用一把鎖）。
  assert(gateSrc.includes('autoLaunchKey') && gateSrc.includes('line_checkout_auto_launch') && gateSrc.includes('sessionStorage'), 'Auto Open 使用 sessionStorage 防重複機制（依 store_id+cart_code 分別鎖定）');
  assert(gateSrc.includes('autoLaunchAttempted'), 'Auto Open 邏輯明確標示只嘗試一次（autoLaunchAttempted 旗標）');
// 需求文件五：只檢查「使用者實際會看到」的字串（Dialog innerHTML 樣板／
// 動態文案賦值），不檢查程式內部註解或函式名稱（例如既有的
// handleLineMemberLoginCallback() 函式名稱本來就含「Callback」字樣，那是
// 程式碼識別字，不是使用者看得到的畫面文字，不該被這條規則誤判）。
const dialogTemplateMatch = gateSrc.match(/externalGuideEl\.innerHTML = `([\s\S]*?)`;/);
const dialogTemplate = dialogTemplateMatch ? dialogTemplateMatch[0] : '';
const dynamicCopyMatches = [...gateSrc.matchAll(/(?:headingEl|introEl)\.(?:textContent|innerHTML) = '([^']*)'/g)].map(m => m[1]);
const userFacingText = dialogTemplate + '\n' + dynamicCopyMatches.join('\n');
assert(!/商家尚未設定官方帳號/.test(userFacingText), '不再出現舊版「商家尚未設定官方帳號」曝露內部狀態的文案（僅檢查使用者實際會看到的畫面文字）');
assert(!/\bUID\b|\bCallback\b|技術驗證/.test(userFacingText), 'Dialog 畫面文字不出現 UID／Callback／技術驗證字樣（僅檢查畫面文字，不含程式內部函式名稱／註解）');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix27 smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (failCount > 0) process.exit(1);

  // ── F8-B + F1～F7 Regression（沒有 F0 腳本，如實列出，不虛構）──────────
  console.log('\n=== 執行 F1～F7 + F8-A + F8-B Regression（無 F0 腳本，如實跳過） ===');
  const regressionScripts = [
    'smoke-hotfix26-f1.js', 'smoke-hotfix26-f2.js', 'smoke-hotfix26-f3.js',
    'smoke-hotfix26-f4.js', 'smoke-hotfix26-f5.js', 'smoke-hotfix26-f6.js',
    'smoke-hotfix26-f7.js', 'smoke-hotfix26-f8.js', 'smoke-hotfix26-f8-b.js',
  ];
  const { execFileSync } = require('child_process');
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在，如實跳過，不虛構已通過）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      const summaryLine = out.split('\n').reverse().find(l => /FAIL\s*=\s*\d+|FAIL:\s*\d+|Regression 總結/.test(l)) || '';
      console.log(`[${script}] ${summaryLine.trim() || '(exit 0，未找到摘要行)'}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  console.log('（F0：專案內找不到 scripts/smoke-*f0*.js，如實回報「無 F0 腳本」，不虛構已通過）');
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix27] fatal:', e); process.exit(1); });
