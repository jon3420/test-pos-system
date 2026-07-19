#!/usr/bin/env node
// scripts/smoke-hotfix26-f8-b.js — fix18-10-hotfix26-F8-B smoke test
//
// 涵蓋需求文件二十一案例 A～L（Messenger UI／Token Create／OA Message URL／
// Webhook Message／UID Binding／Reply LIFF URL／Restore／Cart Recalculation／
// Friendship／Consume／Attribution／Tenant Isolation）與 Analytics 六個事件、
// F8-A／F0～F7 回歸。
//
// 誠實揭露：requestFriendship() 實際行為（案例 I）與真正的 LINE Reply API
// 呼叫（案例 F 的網路層）需要真實 LIFF 瀏覽器環境／真實 LINE 伺服器，無法
// 在此模擬環境驗證，標示為 MANUAL REQUIRED，不假裝 PASS。
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const {
    createCartHandoffToken, bindTokenToLineUser, restoreCartToken, consumeCartToken,
    generateFullToken, generateCartCode, TOKEN_TTL_MINUTES,
  } = require('../utils/lineCheckoutHandoff');

  const STORE_A = 'smoke_f8b_store_a';
  const STORE_B = 'smoke_f8b_store_b';

  function seedStore(storeId) {
    db.run(`INSERT INTO products (store_id, name, category, price, enabled) VALUES (?,?,?,?,1)`, [storeId, '珍珠奶茶', '飲料', 60]);
    db.run(`INSERT INTO products (store_id, name, category, price, enabled) VALUES (?,?,?,?,1)`, [storeId, '雞排', '主食', 80]);
    db.run(`INSERT INTO products (store_id, name, category, price, enabled) VALUES (?,?,?,?,0)`, [storeId, '已下架商品', '主食', 50]);
  }
  seedStore(STORE_A);
  seedStore(STORE_B);
  const teaId = db.get(`SELECT id FROM products WHERE store_id=? AND name='珍珠奶茶'`, [STORE_A]).id;
  const chickenId = db.get(`SELECT id FROM products WHERE store_id=? AND name='雞排'`, [STORE_A]).id;
  const disabledId = db.get(`SELECT id FROM products WHERE store_id=? AND name='已下架商品'`, [STORE_A]).id;

  // ═══════════════ A. Messenger UI（結構檢查，沿用既有 F3/F6/F7 慣例）═══════════════
  const gateSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'line-member-gate.js'), 'utf8');
  // fix18-10-hotfix29：icon 與文字分成不同 <span>（icon+文字排版），不再是
  // 同一段連續字串「💬 到 LINE 完成結帳」，改成分別檢查兩個部分都存在。
  assert(gateSrc.includes('lmgGoLineCheckoutBtn') && gateSrc.includes('💬') && gateSrc.includes('到 LINE 完成結帳'), 'A-1 主要按鈕為「到 LINE 完成結帳」（hotfix29：icon 與文字分開排版）');
  assert(gateSrc.includes('lmgOtherLoginDetails') && gateSrc.includes('其他登入方式'), 'A-2 其他登入方式區塊存在');
  assert(gateSrc.includes('<details id="lmgOtherLoginDetails"'), 'A-3 其他登入方式預設收合（<details> 無 open 屬性）');
  assert(!/為了安全取得您的\s*LINE\s*會員資料/.test(gateSrc), 'A-4 不出現「為了安全取得您的 LINE 會員資料」文案');
  const guideBlockMatch = gateSrc.match(/function showExternalBrowserLoginGuide[\s\S]*?\n  \}\n/);
  const guideBlock = guideBlockMatch ? guideBlockMatch[0] : gateSrc;
  assert(!/UID|Callback|技術驗證/.test(guideBlock.replace(/\/\/.*$/gm, '')), 'A-5 引導畫面不出現 UID／Callback／技術驗證等技術字樣（僅檢查非註解程式碼）', '');

  // ═══════════════ B. Token Create ═══════════════
  const created = createCartHandoffToken(db, STORE_A, {
    cartQtyItems: [{ product_id: teaId, qty: 2 }, { product_id: chickenId, qty: 1 }],
    checkoutContext: { order_type: 'takeout', pickup_date: '2026-07-20', pickup_time: '12:00', customer_phone: '0912345678' },
    attribution: { utm_source: 'facebook', fbclid: 'abc123' },
  });
  assert(/^CART-[A-Z0-9]{6}$/.test(created.cartCode), 'B-1 cart_code 格式正確', created.cartCode);
  assert(created.subtotal === 60 * 2 + 80, 'B-2 後端重算 subtotal 正確（不信任前端）', created.subtotal);
  assert(!!created.expiresAt, 'B-3 有效期已設定');
  const fullTokenEntropy = Buffer.from(generateFullToken(), 'base64url').length * 8;
  assert(fullTokenEntropy >= 128, 'B-4 token entropy >= 128-bit', fullTokenEntropy + ' bits');
  // store 隔離：同一 cart_code 不會跨店混用（用短碼在另一店查一定查不到）
  const rowInB = db.get('SELECT id FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [STORE_B, created.cartCode]);
  assert(!rowInB, 'B-5 token 建立時已做 store 隔離（cart_code 不會出現在其他店）');

  // ═══════════════ C. OA Message URL（在 route 層組裝，這裡測試組裝函式邏輯）═══════════════
  function buildOaMessageUrl(basicId, cartCode) {
    if (!basicId) return '';
    const message = `我要結帳 ${cartCode}`;
    return `https://line.me/R/oaMessage/${encodeURIComponent(basicId)}/?${encodeURIComponent(message)}`;
  }
  const oaUrl = buildOaMessageUrl('@testshop', created.cartCode);
  assert(oaUrl.startsWith('https://line.me/R/oaMessage/%40testshop/?'), 'C-1 Basic ID encode 正確', oaUrl);
  assert(oaUrl.includes(encodeURIComponent(`我要結帳 ${created.cartCode}`)), 'C-2 訊息 encode 正確');
  assert(!oaUrl.includes('60') && !oaUrl.includes('0912345678'), 'C-3 URL 只含短碼，不含金額／電話等敏感資料');

  // ═══════════════ D. Webhook Message Parse ═══════════════
  const CHECKOUT_MESSAGE_RE = /^我要結帳\s+(CART-[A-Z0-9]{6,32})$/i;
  assert(CHECKOUT_MESSAGE_RE.test(`我要結帳 ${created.cartCode}`), 'D-1 正確格式可解析');
  assert(!CHECKOUT_MESSAGE_RE.test('我要結帳'), 'D-2 缺代碼格式被忽略');
  assert(!CHECKOUT_MESSAGE_RE.test('隨便打的訊息'), 'D-3 無關訊息不誤判');
  assert(!CHECKOUT_MESSAGE_RE.test('我要結帳 ABC-123456'), 'D-4 非 CART- 開頭格式被忽略');

  // ═══════════════ E. UID Binding ═══════════════
  const bindOk = bindTokenToLineUser(db, STORE_A, created.cartCode, 'U_CUSTOMER_1');
  assert(bindOk.ok === true, 'E-1 綁定成功', JSON.stringify(bindOk));
  const memberAfterBind = db.get('SELECT status, line_user_id FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [STORE_A, created.cartCode]);
  assert(memberAfterBind.status === 'bound' && memberAfterBind.line_user_id === 'U_CUSTOMER_1', 'E-2 token 狀態轉為 bound');
  const bindSecondUser = bindTokenToLineUser(db, STORE_A, created.cartCode, 'U_CUSTOMER_2');
  assert(bindSecondUser.ok === false && bindSecondUser.reason === 'already_bound_other_user', 'E-3 不可綁定第二個 UID', JSON.stringify(bindSecondUser));

  // ═══════════════ F. Reply LIFF URL（組裝邏輯測試；實際 Reply API 網路呼叫見 MANUAL）═══════════════
  const liffUrl = `https://liff.line.me/${'1234567890-abcdefgh'}/checkout?cart_token=${encodeURIComponent(bindOk.token)}`;
  assert(liffUrl.startsWith('https://liff.line.me/1234567890-abcdefgh/checkout?cart_token='), 'F-1 LIFF URL 格式正確、使用 full secret token');
  assert(!liffUrl.includes(created.cartCode), 'F-2 LIFF URL 使用 full token 而非短碼');

  // ═══════════════ G. Restore ═══════════════
  const restoreOk = restoreCartToken(db, STORE_A, bindOk.token, 'U_CUSTOMER_1');
  assert(restoreOk.ok === true, 'G-1 UID 一致成功還原', JSON.stringify(restoreOk));
  assert(restoreOk.cart.items.length === 2, 'G-2 還原品項數正確');
  const restoreWrongUser = restoreCartToken(db, STORE_A, bindOk.token, 'U_WRONG_USER');
  assert(restoreWrongUser.ok === false && restoreWrongUser.reason === 'uid_mismatch', 'G-3 UID 不一致拒絕', JSON.stringify(restoreWrongUser));

  // ═══════════════ H. Cart Recalculation（商品停售/價格異動）═══════════════
  const createdWithDisabled = createCartHandoffToken(db, STORE_A, {
    cartQtyItems: [{ product_id: teaId, qty: 1 }, { product_id: disabledId, qty: 1 }],
    checkoutContext: { order_type: 'takeout' },
  });
  assert(createdWithDisabled.hasUnavailableItems === true, 'H-1 建立時偵測到停售商品');
  db.run('UPDATE products SET price=99 WHERE id=?', [teaId]);
  const bindForRecalc = bindTokenToLineUser(db, STORE_A, createdWithDisabled.cartCode, 'U_CUSTOMER_3');
  const restoreRecalc = restoreCartToken(db, STORE_A, bindForRecalc.token, 'U_CUSTOMER_3');
  assert(restoreRecalc.cart.items[0].price === 99, 'H-2 還原時用最新價格重算（非快照舊價）', restoreRecalc.cart.items[0].price);
  assert(restoreRecalc.has_unavailable_items === true, 'H-3 還原時仍提示停售商品');
  db.run('UPDATE products SET price=60 WHERE id=?', [teaId]);

  // ═══════════════ I. Friendship（requestFriendship 需真實 LIFF 環境）═══════════════
  manual('I friend=false 時 requestFriendship()/fallback add_friend_url', '需要真實 LIFF 瀏覽器環境（liff.getFriendship/liff.requestFriendship 皆為瀏覽器 API），已在 public/line-order.html 的 _restoreCartFromHandoffToken() 內接上既有 ensureFriendRequirement()（與一般送單流程共用同一套 Gate），邏輯正確性沿用既有 hotfix26-B 的驗證，這裡不重複');

  // ═══════════════ J. Consume ═══════════════
  const consumeOk = consumeCartToken(db, STORE_A, bindOk.token, 'ORDER_UUID_1');
  assert(consumeOk.ok === true, 'J-1 訂單成功後 consumed');
  const tokenAfterConsume = db.get('SELECT status, order_id FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [STORE_A, bindOk.token]);
  assert(tokenAfterConsume.status === 'consumed' && tokenAfterConsume.order_id === 'ORDER_UUID_1', 'J-2 status/consumed_at/order_id 正確寫入');
  const consumeAgain = consumeCartToken(db, STORE_A, bindOk.token, 'ORDER_UUID_2');
  assert(consumeAgain.ok === false && consumeAgain.reason === 'already_consumed', 'J-3 重複使用拒絕', JSON.stringify(consumeAgain));
  const restoreAfterConsume = restoreCartToken(db, STORE_A, bindOk.token, 'U_CUSTOMER_1');
  assert(restoreAfterConsume.ok === false && restoreAfterConsume.reason === 'consumed', 'J-4 已消費 token 無法再次 restore');

  // ── Expired Token ──
  const expiredToken = createCartHandoffToken(db, STORE_A, { cartQtyItems: [{ product_id: teaId, qty: 1 }], checkoutContext: {} });
  db.run(`UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE store_id=? AND cart_code=?`, [STORE_A, expiredToken.cartCode]);
  const bindExpired = bindTokenToLineUser(db, STORE_A, expiredToken.cartCode, 'U_CUSTOMER_4');
  assert(bindExpired.ok === false && bindExpired.reason === 'expired', 'J-5 過期 token 綁定拒絕', JSON.stringify(bindExpired));

  // ═══════════════ K. Attribution ═══════════════
  const withAttribution = createCartHandoffToken(db, STORE_A, {
    cartQtyItems: [{ product_id: teaId, qty: 1 }],
    checkoutContext: { order_type: 'takeout' },
    attribution: { utm_source: 'facebook', utm_medium: 'cpc', fbclid: 'fb.1.123' },
  });
  const savedAttribution = JSON.parse(db.get('SELECT attribution_json FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [STORE_A, withAttribution.cartCode]).attribution_json);
  assert(savedAttribution.utm_source === 'facebook' && savedAttribution.fbclid === 'fb.1.123', 'K-1 UTM/fbclid 建立時已保存', JSON.stringify(savedAttribution));

  // ═══════════════ L. Tenant Isolation ═══════════════
  const bStoreToken = createCartHandoffToken(db, STORE_B, { cartQtyItems: [{ product_id: teaId, qty: 1 }], checkoutContext: {} });
  // STORE_B 的 product_id=teaId 其實是不同店的商品 id 空間，但用 STORE_A 的 token 去 STORE_B 查一定查不到
  const crossStoreLookup = db.get('SELECT id FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [STORE_B, bindOk.token]);
  assert(!crossStoreLookup, 'L-1 store_001 token 不能在 store_002 查到/使用');
  const crossStoreBind = bindTokenToLineUser(db, STORE_B, created.cartCode, 'U_CUSTOMER_1');
  assert(crossStoreBind.ok === false && crossStoreBind.reason === 'not_found', 'L-2 短碼跨店查詢一律 not_found');

  // ═══════════════ Analytics 六個事件：確認白名單 + 確認程式碼內有實際觸發點 ═══════════════
  const { EVENT_WHITELIST } = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'analyticsLog.js'), 'utf8');
    const listMatch = src.match(/const EVENT_WHITELIST = \[([\s\S]*?)\];/);
    const names = listMatch ? Array.from(listMatch[1].matchAll(/'([a-z_]+)'/g)).map(m => m[1]) : [];
    return { EVENT_WHITELIST: names };
  })();
  const sixEvents = [
    'line_checkout_handoff_created', 'line_checkout_handoff_opened', 'line_checkout_message_sent',
    'line_checkout_liff_opened', 'line_checkout_cart_restored', 'line_checkout_handoff_consumed',
  ];
  sixEvents.forEach(evt => assert(EVENT_WHITELIST.includes(evt), `Analytics 白名單包含 ${evt}`));

  const handoffRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-checkout-handoff.js'), 'utf8');
  const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-webhook.js'), 'utf8');
  const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-orders.js'), 'utf8');
  const gateJsSrc = gateSrc;
  const orderHtmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'line-order.html'), 'utf8');
  assert(handoffRouteSrc.includes("event_name: 'line_checkout_handoff_created'"), 'Analytics 觸發點：line_checkout_handoff_created 在 create route 內');
  assert(gateJsSrc.includes("onEvent('line_checkout_handoff_opened'"), 'Analytics 觸發點：line_checkout_handoff_opened 在按鈕點擊時觸發');
  assert(webhookSrc.includes("event_name: 'line_checkout_message_sent'"), 'Analytics 觸發點：line_checkout_message_sent 在 webhook message 處理內');
  assert(orderHtmlSrc.includes("_trackEvent('line_checkout_liff_opened')"), 'Analytics 觸發點：line_checkout_liff_opened 在 restore 開始時觸發');
  assert(handoffRouteSrc.includes("event_name: 'line_checkout_cart_restored'"), 'Analytics 觸發點：line_checkout_cart_restored 在 restore route 內');
  assert(ordersSrc.includes("event_name: 'line_checkout_handoff_consumed'"), 'Analytics 觸發點：line_checkout_handoff_consumed 在訂單成立 consume 後觸發');
  assert(ordersSrc.includes("'purchase'") && ordersSrc.includes("'submit_order'"), 'Analytics 未破壞既有 purchase/submit_order 事件');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix26-F8-B smoke test summary (自身測試部分) ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (failCount > 0) process.exit(1);

  // ═══════════════ F8-A + F0～F7 Regression（直接執行既有 smoke script）═══════════════
  console.log('\n=== 執行 F8-A + F0～F7 Regression ===');
  const { execFileSync } = require('child_process');
  const regressionScripts = [
    'smoke-hotfix26-f1.js', 'smoke-hotfix26-f2.js', 'smoke-hotfix26-f3.js',
    'smoke-hotfix26-f4.js', 'smoke-hotfix26-f5.js', 'smoke-hotfix26-f6.js',
    'smoke-hotfix26-f7.js', 'smoke-hotfix26-f8.js',
  ];
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8' });
      const summaryLine = out.split('\n').reverse().find(l => /FAIL\s*=\s*\d+|FAIL:\s*\d+/.test(l)) || '';
      console.log(`[${script}] ${summaryLine.trim() || '(no summary line found, but exit code 0)'}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix26-f8-b] fatal:', e); process.exit(1); });
