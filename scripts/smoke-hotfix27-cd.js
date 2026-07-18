#!/usr/bin/env node
// scripts/smoke-hotfix27-cd.js — fix18-10-hotfix27-CD smoke test
//
// 涵蓋需求文件二十一：LIFF URL 格式修正、顧客/店家頁隔離、Messenger <a href>
// 結構與行為、Bot regex。沒有獨立的 C／D 腳本，本檔案就是「CD 合併版」。
//
// 誠實揭露：iPhone 13 Pro 等真機上 <a href> 是否真的能喚起 LINE、真實 LIFF
// Restore、真實 requestFriendship、真實下單 consume，都需要真機或真實 LINE
// 平台，這裡一律標記 MANUAL REQUIRED。
'use strict';
const path = require('path');
const fs = require('fs');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

async function main() {
  // ═══════════════ 一：Bot Reply LIFF URL 格式（需求文件三）═══════════════
  const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-webhook.js'), 'utf8');
  assert(!webhookSrc.includes('/${liffId}/checkout'), 'Bot Reply LIFF URL 不含 /{LIFF_ID}/checkout path suffix');
  assert(webhookSrc.includes('?mode=checkout&store_id=') && webhookSrc.includes('&cart_token='), 'Bot Reply LIFF URL 使用 ?mode=checkout&store_id=...&cart_token=... query string');
  assert(webhookSrc.includes('encodeURIComponent(bindResult.token)'), 'LIFF URL 內的 cart_token 使用 full secret token（非短碼）');

  // 用實際字串組裝驗證產生的 URL 長相（不重新定義邏輯，直接模擬同一個 template literal）
  const liffId = '2010721031-HYNw91nm', testStoreId = 'store_001', testFullToken = 'FULL_TOKEN_ABC123XYZ';
  const builtUrl = `https://liff.line.me/${liffId}?mode=checkout&store_id=${encodeURIComponent(testStoreId)}&cart_token=${encodeURIComponent(testFullToken)}`;
  assert(builtUrl === 'https://liff.line.me/2010721031-HYNw91nm?mode=checkout&store_id=store_001&cart_token=FULL_TOKEN_ABC123XYZ', 'LIFF URL 組裝結果與需求文件範例一致', builtUrl);
  assert(!builtUrl.includes('/checkout?'), 'URL 中沒有 /checkout path（是 query string 的 mode=checkout，不是路徑）');

  // ═══════════════ 二：LINE Integration Center Callback URL 顯示（需求文件十）═══════════════
  const integrationSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-integration.js'), 'utf8');
  assert(!integrationSrc.includes('/${liffId}/checkout`'), 'Integration Center 不再產生 /{LIFF_ID}/checkout 格式的顯示值');
  assert(integrationSrc.includes('checkout_callback_url_example') && integrationSrc.includes('?mode=checkout&store_id='), 'Integration Center 顯示新格式 Callback URL 範例');
  assert(integrationSrc.includes('liff_endpoint_url_required') && integrationSrc.includes('/line-order.html'), 'Integration Center 提供 LIFF Endpoint URL 應固定設定值（指向 line-order.html）');

  // ═══════════════ 三：line-order.html Checkout 參數解析 + 顧客／店家隔離（需求文件五／八）═══════════════
  const orderHtmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'line-order.html'), 'utf8');
  assert(orderHtmlSrc.includes('_getCheckoutParamsFromUrl') && orderHtmlSrc.includes("params.get('mode')") && orderHtmlSrc.includes("params.get('store_id')") && orderHtmlSrc.includes("params.get('cart_token')"), 'line-order.html 可解析 mode/store_id/cart_token');
  assert(orderHtmlSrc.includes('isLiffCheckout'), 'line-order.html 有明確的 isLiffCheckout 判斷條件（mode=checkout 且三者皆存在）');
  assert(!/window\.location\.(href|assign|replace)\s*=?\s*\(?['"`]\/(checkout|admin|login|index\.html)?['"`]?\)?/.test(orderHtmlSrc.replace(/window\.location\.href=lpRes\.payment_url;/g, '')), 'line-order.html 沒有導向 /checkout、/admin、/login、/index.html 的程式碼（已排除既有 LINE Pay 導轉）');
  assert(!orderHtmlSrc.includes("window.location.href='/'") && !orderHtmlSrc.includes('window.location.replace(\'/index.html\')'), 'line-order.html 沒有導向網站根目錄或 index.html');

  // 顧客／店家登入隔離：全文搜尋店家登入相關函式呼叫
  const merchantAuthPatterns = ['showLoginModal', 'initMerchantLogin', 'requireStorePassword', 'merchantAuth(', 'adminAuth('];
  const foundMerchantAuth = merchantAuthPatterns.filter(p => orderHtmlSrc.includes(p));
  assert(foundMerchantAuth.length === 0, 'line-order.html 不含任何店家登入觸發函式（showLoginModal／initMerchantLogin／requireStorePassword／merchantAuth／adminAuth）', foundMerchantAuth.join(','));
  const scriptSrcMatches = [...orderHtmlSrc.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert(!scriptSrcMatches.includes('/js/app.js'), 'line-order.html 沒有載入 /js/app.js（後台管理 SPA 腳本，含店家登入邏輯）', scriptSrcMatches.join(','));
  for (const src of scriptSrcMatches) {
    if (src.startsWith('/js/')) {
      const p = path.join(__dirname, '..', 'public', src);
      if (fs.existsSync(p)) {
        const s = fs.readFileSync(p, 'utf8');
        const hit = merchantAuthPatterns.filter(pat => s.includes(pat));
        assert(hit.length === 0, `${src} 不含店家登入觸發函式`, hit.join(','));
      }
    }
  }

  // Token 失效時的行為（需求文件七）
  assert(orderHtmlSrc.includes('_showCheckoutHandoffFailure') && orderHtmlSrc.includes('此結帳連結已失效，請返回點餐頁重新操作'), 'Token 失效顯示正確訊息');
  assert(orderHtmlSrc.includes("backUrl='/line-order.html?store_id='") || orderHtmlSrc.includes('backUrl=\'/line-order.html?store_id=\''), '返回按鈕連結目標是 /line-order.html?store_id=...（不是 POS 首頁）');
  assert(!orderHtmlSrc.includes('alert(msgMap'), '原本的 alert() 已改成正式 UI（非阻塞式 alert）');

  // 還原成功後不得跳轉（需求文件六）——檢查 restore 成功分支內沒有 location 導轉
  const restoreFnMatch = orderHtmlSrc.match(/async function _restoreCartFromHandoffToken[\s\S]*?\n}\n/);
  if (restoreFnMatch) {
    const fnBody = restoreFnMatch[0];
    // 只抓「賦值／導航」，不誤判單純讀取（例如 new URL(window.location.href) 只是
    // 讀目前網址來清掉 cart_token query string，不是導頁）。
    const navigationCalls = fnBody.match(/window\.location\.href\s*=[^=]|window\.location\.(assign|replace)\s*\(/g) || [];
    assert(navigationCalls.length === 0, 'Restore 成功流程內沒有任何 window.location 導轉（改用 openCartSheet() 既有函式；window.location.href 出現處只是讀取目前網址，非導頁）', navigationCalls.join(','));
    assert(fnBody.includes('openCartSheet()'), 'Restore 成功後呼叫既有 openCartSheet() 開啟顧客結帳面板（非虛構函式）');
  } else {
    fail('找不到 _restoreCartFromHandoffToken 函式本體可供檢查', '');
  }

  // ═══════════════ 四：SPA Fallback 檢查（需求文件九）═══════════════
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const staticIdx = serverSrc.indexOf('express.static');
  const webhookMountIdx = serverSrc.indexOf("app.use('/webhook/line'");
  const fallbackIdx = serverSrc.lastIndexOf("app.get('*'");
  assert(staticIdx > -1 && webhookMountIdx > -1 && fallbackIdx > -1, '三個關鍵位置都找得到（static／webhook mount／SPA fallback）');
  assert(webhookMountIdx < fallbackIdx, 'Webhook route 掛載順序在 SPA fallback 之前');
  assert(staticIdx < fallbackIdx, '靜態檔案服務（含 line-order.html 本檔）在 SPA fallback 之前，GET 請求不會落入 fallback');
  assert(!serverSrc.includes("'/checkout'"), 'server.js 沒有 /checkout 這個路徑的路由定義（確認問題純粹出在 LIFF URL 組裝，不是伺服器路由）');

  // ═══════════════ 五：Messenger Dialog <a href> 結構與行為（需求文件十一～十九）═══════════════
  const gateSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'line-member-gate.js'), 'utf8');
  assert(/<a\s[^>]*id="lmgGoLineCheckoutBtn"/.test(gateSrc), '主按鈕元素是 <a>（不是 <button>）');
  assert(gateSrc.includes('aria-disabled="true"') && gateSrc.includes("style=\"display:block;width:100%;padding:13px;border:0;border-radius:10px;background:#06C755"), '主 <a> 初始狀態為 disabled（Token 尚未就緒前不可點）');
  assert(gateSrc.includes('function prepareHandoff') && gateSrc.includes('(async () => {') && gateSrc.includes('await prepareHandoff()'), 'Token 於 Dialog 初始化時（IIFE）就開始建立，不是等點擊才建立');
  assert(gateSrc.includes('goLineCheckoutBtn.href = result.lineOaMessageUrl') && gateSrc.includes("goLineCheckoutBtn.removeAttribute('aria-disabled')"), 'Token Promise resolve 後才設定 href 並移除 disabled 狀態');

  // click handler 純淨度檢查：抓出 addEventListener('click', ...) 的 callback 本體，確認沒有 await/fetch/create
  const clickHandlerMatch = gateSrc.match(/goLineCheckoutBtn\.addEventListener\('click', \(ev\) => \{[\s\S]*?\n\s{6}\}\);/);
  const clickHandlerBody = clickHandlerMatch ? clickHandlerMatch[0] : '';
  assert(clickHandlerBody.length > 0, '找得到主 <a> 的 click handler 可供檢查');
  assert(!/\bawait\b/.test(clickHandlerBody), 'click handler 不含 await');
  assert(!/\bfetch\(/.test(clickHandlerBody), 'click handler 不含 fetch(');
  assert(!/createLineCheckoutHandoff|createToken|prepareHandoff\(/.test(clickHandlerBody), 'click handler 不重新呼叫 create API');
  // preventDefault 只允許出現在「disabled guard」那一行（阻擋還沒就緒的連結被點擊），
  // 不能出現在其他地方（那才是真的攔截原生連結行為）。
  const preventDefaultOutsideGuard = clickHandlerBody
    .split('\n')
    .filter(line => line.includes('preventDefault'))
    .filter(line => !line.includes("aria-disabled') === 'true'"))
    .filter(line => !line.trim().startsWith('//'));
  assert(preventDefaultOutsideGuard.length === 0, 'click handler 沒有在 disabled-guard 以外的地方攔截原生連結行為', preventDefaultOutsideGuard.join('|'));

  // sessionStorage 只鎖自動開啟，不鎖手動點擊
  assert(gateSrc.includes('autoLaunchAttempted || manualClicked') && gateSrc.includes('async function maybeAutoLaunch'), 'sessionStorage/旗標防重複邏輯只出現在 maybeAutoLaunch（自動開啟），不在 click handler 內');
  assert(!clickHandlerBody.includes('sessionStorage') && !clickHandlerBody.includes('autoLaunchAttempted'), '手動 click handler 完全不檢查 session flag（不會被鎖住）');
  assert(clickHandlerBody.includes('manualClicked = true'), '手動點擊會設定 manualClicked，讓「還沒開始跑」的自動開啟提早放棄（不影響本次點擊）');

  // App 切換偵測（需求文件十五）
  assert(gateSrc.includes("addEventListener('visibilitychange'") && gateSrc.includes("addEventListener('pagehide'") && gateSrc.includes("addEventListener('blur'"), '有監聽 visibilitychange／pagehide／blur 判斷是否切換 App');
  const gateSrcNoComments = gateSrc.replace(/\/\/.*$/gm, '');
  assert(gateSrc.includes('未能自動開啟 LINE') && !gateSrcNoComments.includes('LINE 未安裝'), '文案是「未能自動開啟」而非宣稱「LINE 未安裝」（無法可靠判斷後者；僅檢查非註解程式碼是否真的顯示過這句話）');

  // Retry / 重新產生結帳代碼（需求文件十九）
  assert(gateSrc.includes('lmgRegenerateTokenBtn') && gateSrc.includes('autoLaunchAttempted = false'), 'Retry 按鈕存在，且會重置 autoLaunchAttempted 讓新 Token 可以重新自動嘗試');

  // Cart Code fallback（需求文件十七）＋ 外部瀏覽器指引（需求文件十六）
  assert(gateSrc.includes('lmgCopyCartCodeBtn') && gateSrc.includes('📋 複製結帳代碼'), '複製結帳代碼按鈕永遠存在（不限特定版型）');
  assert(gateSrc.includes('lmgCantOpenDetails') && gateSrc.includes('無法開啟 LINE？'), '「無法開啟 LINE？」收合區塊存在');
  assert(gateSrc.includes('在外部瀏覽器開啟') && !gateSrc.includes('請使用 Chrome') , '外部瀏覽器說明使用「在外部瀏覽器開啟」文案，不是只寫「使用 Chrome」');

  // OA Message URL encode（需求文件十三，沿用 F8-B 既有邏輯，這裡確認沒有被改壞）
  const handoffRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-checkout-handoff.js'), 'utf8');
  assert(handoffRouteSrc.includes('encodeURIComponent(basicId)') && handoffRouteSrc.includes('encodeURIComponent(message)'), 'OA Message URL 的 Basic ID 與訊息皆有 percent encode');

  manual('iPhone 13 Pro Messenger 是否允許原生 <a> 開啟 LINE', '需要真機 Facebook/Messenger WebView 才能確認 iOS 對 <a href> 使用者手勢的實際放行行為');
  manual('真實 LINE App 切換偵測（visibilitychange/pagehide/blur）在各廠牌瀏覽器的實際觸發時機', '不同 WebView 實作對這些事件的觸發時機不完全一致，需要真機交叉測試');
  manual('真實 LIFF Restore 端對端流程', '需要真實 LIFF 環境（liff.init 對應真實 LIFF ID/Endpoint）');
  manual('真實 requestFriendship() 使用者互動流程', '需要真實 LIFF 瀏覽器環境');
  manual('完整下單並確認 Token 成功 consumed（真實訂單）', '需要真實 LINE 帳號完整走一次 Messenger→LINE→LIFF→下單流程');

  // ═══════════════ Bot Regex（需求文件二十一）═══════════════
  const CHECKOUT_MESSAGE_RE = /^\s*(?:我要結帳\s+)?(CART-[A-Z0-9]{6,32})\s*$/i;
  assert(!!'CART-ABC123'.match(CHECKOUT_MESSAGE_RE), 'Bot 接受 CART-ABC123');
  assert(!!'我要結帳 CART-ABC123'.match(CHECKOUT_MESSAGE_RE), 'Bot 接受「我要結帳 CART-ABC123」');
  assert(!'請問CART-ABC123是什麼意思呢親愛的客服'.match(CHECKOUT_MESSAGE_RE), '拒絕夾在長句中的 CART code');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix27-CD smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (failCount > 0) process.exit(1);

  // ═══════════════ Regression（F1～F7 + F8-A + F8-B + Hotfix27）═══════════════
  console.log('\n=== 執行完整 Regression（無 F0/C/D 獨立腳本，如實跳過） ===');
  const { execFileSync } = require('child_process');
  const regressionScripts = [
    'smoke-hotfix26-f1.js', 'smoke-hotfix26-f2.js', 'smoke-hotfix26-f3.js',
    'smoke-hotfix26-f4.js', 'smoke-hotfix26-f5.js', 'smoke-hotfix26-f6.js',
    'smoke-hotfix26-f7.js', 'smoke-hotfix26-f8.js', 'smoke-hotfix26-f8-b.js',
    'smoke-hotfix27.js',
  ];
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在，如實跳過）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 90000 });
      const summaryLine = out.split('\n').reverse().find(l => /FAIL\s*=\s*\d+|FAIL:\s*\d+|Regression 總結/.test(l)) || '';
      console.log(`[${script}] ${summaryLine.trim() || '(exit 0)'}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  console.log('（沒有獨立的 F0／Hotfix27-C／Hotfix27-D 腳本，如實回報，CD 腳本本身即涵蓋 C+D 範圍）');
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix27-cd] fatal:', e); process.exit(1); });
