#!/usr/bin/env node
// scripts/run-h1-4-10-phase4b-recovery-full-runtime.js
// H1.4.10 Phase 4B — FULL Runtime Suite
//
// 這支 suite 從整個 Feature Requirement 角度驗證（不只是把兩支 targeted
// 檔案重跑一次就宣告過關）：
//   Part A：Admin Settings UI（真實 production HTML fragment + app.js
//           函式，jsdom 執行，不重寫假邏輯）
//   Part B：兩個完整 end-to-end scenario（購物車提醒後成交 + LINE Pay
//           付款提醒後成交），組合多個既有 backend 模組驗證整條鏈路
//   Part C：Composition Gate —— 聚合執行 Backend／Frontend Targeted 兩支
//           檔案（真實 spawn，取得真實 exit code 與 PASS/FAIL 數），連同
//           Part A/B 一起構成 Full Suite 的總 PASS/FAIL

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
async function wait(ticks) { for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 10)); }

// ════════════════════════════════════════════════════════════════
// Part A：Admin Settings UI（真實 production HTML fragment + app.js 函式）
// ════════════════════════════════════════════════════════════════
// 需求：非貪婪 regex `[\s\S]*?<\/div><\/div>` 在卡片內容變複雜（出現更多層
// 巢狀 div）時會在第一個「連續兩個 </div>」處提早結束，抓不到完整卡片
// （本輪新增 Recovery Dashboard 面板時就真的踩到這個問題——production HTML
// 本身巢狀結構完全正確，純粹是這支抽取用的正則太脆弱）。改用真正的
// tag-balance 掃描，不管卡片內部巢狀多少層 div 都能正確找到對應的結尾。
function extractBalancedDiv(html, startMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = startIdx;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('</div')) {
      depth -= 1;
      if (depth === 0) return html.slice(startIdx, tagRe.lastIndex);
    } else {
      depth += 1;
    }
  }
  return null; // 沒配對成功（HTML 本身不完整），安全回傳 null 讓呼叫端判斷
}

async function runAdminUiTests() {
  console.log('\n== Part A：Admin Settings UI ==');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  // 從真實 production 檔案中擷取「購物車找回」卡片的 HTML 片段（逐字擷取，
  // 不重打）。
  const cardMatch = (() => { const t = extractBalancedDiv(indexHtml, '<div class="settings-card" id="cartRecoveryCard"'); return t ? [t] : null; })();
  if (!cardMatch) {
    fail('Admin-0. 在 public/index.html 找到 cartRecoveryCard 區塊', 'not found — 無法繼續 Part A');
    return;
  }
  pass('Admin-0. 在 public/index.html 找到 cartRecoveryCard 區塊（逐字擷取，非重寫）');

  // 從 app.js 擷取真實函式原始碼（逐字擷取）。
  const fnNames = ['CART_RECOVERY_DELAY_DEFAULTS', 'updateCartRecoverySettingsUI', 'loadCartRecoverySettings', 'saveCartRecoverySettings'];
  const constMatch = appJs.match(/const CART_RECOVERY_DELAY_DEFAULTS = \{[^}]*\};/);
  const updateFnMatch = appJs.match(/function updateCartRecoverySettingsUI\(\)[\s\S]*?\n}\n/);
  const loadFnMatch = appJs.match(/async function loadCartRecoverySettings\(\)[\s\S]*?\n}\n/);
  const saveFnMatch = appJs.match(/async function saveCartRecoverySettings\(\)[\s\S]*?\n}\n/);
  assert(!!constMatch && !!updateFnMatch && !!loadFnMatch && !!saveFnMatch, 'Admin-1. app.js 四個真實函式/常數皆擷取成功（CART_RECOVERY_DELAY_DEFAULTS/update/load/save）');
  if (!constMatch || !updateFnMatch || !loadFnMatch || !saveFnMatch) return;

  // 建立最小 jsdom（只放這張卡片的 HTML + 真實函式原始碼），不載入整個
  // 14000+ 行的 admin SPA（避免不必要的複雜度與速度風險），但函式本身
  // 100% 逐字取自 production 原始碼。
  function buildDom(initialSettings) {
    const html = `<!doctype html><html><body>${cardMatch[0]}</body></html>`;
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.settings = initialSettings || {};
    window.apiFetchCalls = [];
    window.apiFetch = async (url, opts) => {
      window.apiFetchCalls.push({ url, opts });
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      Object.assign(window.settings, body);
      return { json: async () => ({ success: true }) };
    };
    window.toast = () => {};
    dom.window.eval(constMatch[0] + '\n' + updateFnMatch[0] + '\n' + loadFnMatch[0] + '\n' + saveFnMatch[0]);
    return dom;
  }

  // A2/A3/A4/A5：default settings（空物件，模擬全新未升級的店）
  {
    const dom = buildDom({});
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const d = dom.window.document;
    assert(d.getElementById('set-cart_recovery_enabled').checked === false, 'A2. default master OFF（未升級舊店不會突然開始 Push）');
    assert(d.getElementById('set-cart_recovery_line_enabled').checked === false, 'A3. default LINE 一次提醒 OFF');
    assert(d.getElementById('set-cart_recovery_cart_delay_minutes').value === '60', 'A4a. default cart delay=60');
    assert(d.getElementById('set-cart_recovery_checkout_delay_minutes').value === '30', 'A4b. default checkout delay=30');
    assert(d.getElementById('set-cart_recovery_payment_delay_minutes').value === '15', 'A4c. default payment delay=15');
    assert(d.getElementById('set-cart_recovery_max_attempts').value === '1', 'A5. default max_attempts=1');
    dom.window.close();
  }

  // A1：card 存在（DOM 元素檢查）
  {
    const dom = buildDom({});
    const d = dom.window.document;
    assert(!!d.getElementById('cartRecoveryCard'), 'A1. Admin card 存在於 DOM');
    dom.window.close();
  }

  // A6：load existing settings 正確顯示
  {
    const dom = buildDom({
      cart_recovery_enabled: '1', cart_recovery_line_enabled: '1',
      cart_recovery_cart_delay_minutes: '90', cart_recovery_checkout_delay_minutes: '45',
      cart_recovery_payment_delay_minutes: '20', cart_recovery_max_attempts: '2',
    });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const d = dom.window.document;
    assert(d.getElementById('set-cart_recovery_enabled').checked === true
      && d.getElementById('set-cart_recovery_line_enabled').checked === true
      && d.getElementById('set-cart_recovery_cart_delay_minutes').value === '90'
      && d.getElementById('set-cart_recovery_checkout_delay_minutes').value === '45'
      && d.getElementById('set-cart_recovery_payment_delay_minutes').value === '20'
      && d.getElementById('set-cart_recovery_max_attempts').value === '2',
      'A6. load 既有設定正確顯示（非 default）');
    dom.window.close();
  }

  // A7/A8/A9：save 正確送出
  {
    const dom = buildDom({});
    const d = dom.window.document;
    d.getElementById('set-cart_recovery_enabled').checked = true;
    d.getElementById('set-cart_recovery_line_enabled').checked = true;
    d.getElementById('set-cart_recovery_cart_delay_minutes').value = '100';
    d.getElementById('set-cart_recovery_checkout_delay_minutes').value = '50';
    d.getElementById('set-cart_recovery_payment_delay_minutes').value = '25';
    d.getElementById('set-cart_recovery_max_attempts').value = '3';
    await dom.window.eval('saveCartRecoverySettings()');
    await wait(10);
    const sentBody = JSON.parse(dom.window.apiFetchCalls[0].opts.body);
    assert(sentBody.cart_recovery_enabled === '1', 'A7. save master enabled 正確送出');
    assert(sentBody.cart_recovery_line_enabled === '1', 'A8. save line enabled 正確送出');
    assert(sentBody.cart_recovery_cart_delay_minutes === '100' && sentBody.cart_recovery_checkout_delay_minutes === '50' && sentBody.cart_recovery_payment_delay_minutes === '25', 'A9. save custom delays 正確送出', JSON.stringify(sentBody));
    dom.window.close();
  }

  // A10：invalid delay 被擋（超出範圍 clamp 回界限內）
  {
    const dom = buildDom({});
    const d = dom.window.document;
    d.getElementById('set-cart_recovery_cart_delay_minutes').value = '99999'; // 超過 1440
    d.getElementById('set-cart_recovery_checkout_delay_minutes').value = '0'; // 低於 5
    d.getElementById('set-cart_recovery_max_attempts').value = '10'; // 超過 3
    await dom.window.eval('saveCartRecoverySettings()');
    await wait(10);
    const sentBody = JSON.parse(dom.window.apiFetchCalls[0].opts.body);
    assert(Number(sentBody.cart_recovery_cart_delay_minutes) === 1440, 'A10a. 超過上限的 delay 被 clamp 到 1440', sentBody.cart_recovery_cart_delay_minutes);
    assert(Number(sentBody.cart_recovery_checkout_delay_minutes) === 5, 'A10b. 低於下限的 delay 被 clamp 到 5', sentBody.cart_recovery_checkout_delay_minutes);
    assert(Number(sentBody.cart_recovery_max_attempts) === 3, 'A10c. 超過上限的 max_attempts 被 clamp 到 3', sentBody.cart_recovery_max_attempts);
    dom.window.close();
  }

  // A11/A12/A13：LINE token readiness 顯示（絕不洩漏 token 值）
  {
    const dom = buildDom({});
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const statusEl = dom.window.document.getElementById('cartRecoveryLineStatus');
    assert(statusEl.textContent === '未設定', 'A11. LINE token 未設定 → 顯示「未設定」');
    dom.window.close();
  }
  {
    const dom = buildDom({ line_channel_token: 'REAL_SECRET_TOKEN_ABCDEFGHIJKLMNOP' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const statusEl = dom.window.document.getElementById('cartRecoveryLineStatus');
    assert(statusEl.textContent === '已設定', 'A12. LINE token 已存在 → 只顯示「已設定」');
    assert(!statusEl.textContent.includes('REAL_SECRET_TOKEN'), 'A13a. 畫面文字不包含完整 token');
    const fullHtml = dom.window.document.documentElement.outerHTML;
    assert(!fullHtml.includes('REAL_SECRET_TOKEN'), 'A13b. 整個 DOM outerHTML 不含完整 token', fullHtml.includes('REAL_SECRET') ? 'LEAK FOUND' : '');
    dom.window.close();
  }

  // Static：確認 loadCartRecoverySettings/saveCartRecoverySettings 原始碼本身沒有 console.log token
  {
    assert(!loadFnMatch[0].includes('console.log') || !/console\.log\([^)]*token/i.test(loadFnMatch[0]), 'Admin-Static. loadCartRecoverySettings() 原始碼沒有把 token 印進 console');
  }
}

// ════════════════════════════════════════════════════════════════
// Part B：完整 End-to-End Scenario
// ════════════════════════════════════════════════════════════════
async function runFullScenarios(db) {
  console.log('\n== Part B：完整 End-to-End Scenario ==');
  const cartRecovery = require('../utils/cartRecovery');
  const delivery = require('../utils/cartRecoveryDelivery');
  const handoff = require('../utils/lineCheckoutHandoff');
  const { logServerEvent } = require('../utils/analyticsLog');
  const { grantConsent } = require('../utils/cartRecoveryConsent');
  const { createMemberSession } = require('../utils/lineMemberSession');

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }

  try {
    const storeId = 'store_001';
    setSetting(storeId, 'cart_recovery_enabled', '1');
    setSetting(storeId, 'cart_recovery_line_enabled', '1');
    setSetting(storeId, 'line_channel_token', 'fake-channel-token');
    setSetting(storeId, 'line_member_liff_id', '2010718887-member');

    // ── Scenario 1：購物車提醒後成交 ──────────────────────────────
    {
      const cartId = 'scenario1-cart';
      const lineUserId = 'Uscenario1000000000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);

      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
      const consentResult = grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
      assert(consentResult.success === true, 'Scenario1-1. consent grant 成功');
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, cartId]);

      let pushCalled = 0;
      const linePushModule = require('../utils/linePush');
      const originalSend = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalled += 1; return { success: true, status: 200 }; };
      const processResult = await delivery.processDueLineRecoveryJobs(db, storeId, {});
      linePushModule.sendLinePush = originalSend;
      assert(pushCalled === 1, 'Scenario1-2. LINE Push 真的被呼叫一次');

      const jobSent = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
      assert(jobSent.status === 'sent', 'Scenario1-3. job.status=sent');

      const tokenRow = db.get(`SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=? AND purpose='recovery_resume'`, [storeId, cartId]);
      assert(!!tokenRow, 'Scenario1-4. Recovery Token 真的被建立');

      const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
      const restoreResult = handoff.restoreRecoveryToken(db, storeId, tokenRow.token, lineUserId, 'line_order');
      assert(restoreResult.ok === true && restoreResult.cart.items.length === 1, 'Scenario1-5. Recovery Restore 成功還原購物車');

      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'scenario1-order', event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'scenario1-order', event_name: 'purchase' });

      const jobConverted = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
      assert(jobConverted.status === 'converted', 'Scenario1-6. job.status=converted');
      assert(!!jobConverted.sent_at, 'Scenario1-7. sent_at 保留');
      assert(!!jobConverted.converted_at, 'Scenario1-8. converted_at 有值');

      const tokenAfter = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tokenRow.token]);
      assert(tokenAfter.status === 'cancelled', 'Scenario1-9. Recovery Token 已 invalidated');

      const restoreAgain = handoff.restoreRecoveryToken(db, storeId, tokenRow.token, lineUserId, 'line_order');
      assert(restoreAgain.ok === false, 'Scenario1-10. 再點舊 Recovery Link → rejected', JSON.stringify(restoreAgain));
    }

    // ── Scenario 2：LINE Pay 付款提醒後成交（不建立第二張訂單／不重複 Purchase）──
    {
      const cartId = 'scenario2-cart';
      const orderId = 'scenario2-order';
      const lineUserId = 'Uscenario2000000000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
      db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, [storeId]);
      db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`, [storeId, 'LINE Pay', 'linepay', 1, 'test', 'test-id', 'test-secret']);
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 800, 800, 'linepay', 'unpaid']);

      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      const consentResult2 = grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
      assert(consentResult2.success === true, 'Scenario2-1. consent grant 成功');
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, orderId]);

      let pushCalled2 = 0;
      const linePushModule2 = require('../utils/linePush');
      const originalSend2 = linePushModule2.sendLinePush;
      linePushModule2.sendLinePush = async () => { pushCalled2 += 1; return { success: true, status: 200 }; };
      await delivery.processDueLineRecoveryJobs(db, storeId, {});
      linePushModule2.sendLinePush = originalSend2;
      assert(pushCalled2 === 1, 'Scenario2-2. Payment Recovery Push 真的被呼叫一次');

      const paymentTokenRow = db.get(`SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND order_id=? AND purpose='recovery_resume' AND resume_type='payment'`, [storeId, orderId]);
      assert(!!paymentTokenRow, 'Scenario2-3. Payment Recovery Token 真的被建立');

      const nodeFetchPath = require.resolve('node-fetch');
      const fakeFetch = async () => ({ json: async () => ({ returnCode: '0000', info: { transactionId: 'txn-scenario2', paymentUrl: { web: 'https://sandbox.line.me/pay/scenario2' } } }) });
      require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };

      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => { req.storeId = storeId; next(); });
      app.use('/api/cart-recovery', require('../routes/cart-recovery'));
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;
      const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
      const resumeRes = await fetch(`http://127.0.0.1:${port}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: paymentTokenRow.token }) });
      const resumeJson = await resumeRes.json();
      server.close();
      delete require.cache[nodeFetchPath];
      assert(resumeJson.success === true && resumeJson.payment_url, 'Scenario2-4. Existing-order LINE Pay request 成功', JSON.stringify(resumeJson));

      const orderCountAfterResume = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id=?`, [storeId]).c;
      const paymentStartedCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started'`, [storeId, orderId]).c;
      assert(paymentStartedCount >= 2, 'Scenario2-5. payment_started（初次 + Recovery backend authority）皆記錄，無遺漏', `count=${paymentStartedCount}`);

      // Confirm success（真實 LINE Pay Confirm 流程）
      const nodeFetchPath2 = require.resolve('node-fetch');
      const fakeFetch2 = async () => ({ json: async () => ({ returnCode: '0000', info: { transactionId: 'txn-scenario2-confirm' } }) });
      require.cache[nodeFetchPath2] = { id: nodeFetchPath2, filename: nodeFetchPath2, loaded: true, exports: fakeFetch2 };
      const app2 = express();
      app2.use(express.json());
      app2.use((req, res, next) => { req.storeId = storeId; next(); });
      app2.use('/api/linepay', require('../routes/linepay'));
      const server2 = http.createServer(app2);
      await new Promise((resolve) => server2.listen(0, resolve));
      const port2 = server2.address().port;
      await fetch(`http://127.0.0.1:${port2}/api/linepay/confirm?store_id=${storeId}&orderId=${orderId}&transactionId=txn-scenario2-confirm`, { redirect: 'manual' });
      server2.close();
      delete require.cache[nodeFetchPath2];

      const paymentJobAfter = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`, [storeId, orderId]);
      assert(paymentJobAfter.status === 'converted', 'Scenario2-6. payment job converted');
      const purchaseCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='purchase'`, [storeId, orderId]).c;
      assert(purchaseCount === 1, 'Scenario2-7. purchase 只有 1 筆（沒有 duplicate Purchase）', `count=${purchaseCount}`);
      assert(orderCountAfterResume === db.get(`SELECT COUNT(*) c FROM orders WHERE store_id=?`, [storeId]).c, 'Scenario2-8. Confirm 前後 orders 筆數不變（沒有 duplicate order）');
      const tokenAfterConfirm = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, paymentTokenRow.token]);
      assert(tokenAfterConfirm.status === 'cancelled', 'Scenario2-9. Payment Recovery Token 已 invalidated');
    }
  } catch (e) {
    fail('Part B：Scenario runner 拋出例外', e && e.stack || String(e));
  }
}

// ════════════════════════════════════════════════════════════════
// Part C：Composition Gate —— 聚合 Backend／Frontend Targeted
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// Part D-M：Feature-level Integration（本輪擴充，共用同一個暫存 DB，
// 因為 initDb() 是 process 內單例，開了關又開會撞到已刪除的檔案）
// ════════════════════════════════════════════════════════════════
async function runIntegrationParts() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase4b-integration-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';
  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta_int', 'Store Beta Int', 'x', 'pro', 1]);

  try {
    await runFullScenarios(db);
    await runConsentFullIntegration(db);
    await runSettingsBackendIntegration(db);
    await runEligibilityFullMatrix(db);
    await runPushProcessorFullIntegration(db);
    await runRecoveryUrlFullIntegration(db);
    await runCartCheckoutE2EExtra(db);
    await runPaymentE2ESecurityExtra(db);
    runExternalAnalyticsContract();
    await runSecurityFullAcceptance(db);
    await runAdminUiMasterLineSemantics();
  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }
}

function setSetting(db, storeId, key, value) {
  db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
}
let _intCtr = 0;
function uniqId(prefix) { _intCtr += 1; return `${prefix}-${_intCtr}`; }

// ── Part D：Consent Full Integration（真實 HTTP routes/cart-recovery.js）──
async function runConsentFullIntegration(db) {
  console.log('\n== Part D：Consent Full Integration ==');
  const { createMemberSession } = require('../utils/lineMemberSession');
  const storeId = 'store_001';
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = storeId; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  async function post(body) {
    const res = await fetch(`${base}/api/cart-recovery/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  try {
    const cartId = uniqId('consent-cart');
    const r1 = await post({ cart_id: cartId, consent: true });
    assert(r1.success === false && r1.reason === 'member_not_identified', 'C1. 沒有 member_session → Consent API 拒絕', JSON.stringify(r1));

    const r2 = await post({ cart_id: cartId, consent: true, line_user_id: 'U_FAKE_RAW' });
    assert(r2.success === false, 'C2. fake raw line_user_id（無 member_session）→ 仍拒絕，不因夾帶 UID 而放行', JSON.stringify(r2));

    const lineUserId = 'Uconsentfull0000000000001';
    const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
    const r3 = await post({ member_session: memberSession, cart_id: cartId, consent: true });
    assert(r3.success === true, 'C3. valid signed member_session → Consent grant 成功', JSON.stringify(r3));
    const row = db.get(`SELECT * FROM cart_recovery_consents WHERE store_id=? AND cart_id=?`, [storeId, cartId]);
    assert(row && row.consent_text_version === 'v1', 'C4. consent_text_version=v1');
    assert(row && row.status === 'granted', 'C5. status=granted');
    assert(row && !!row.granted_at, 'C6. granted_at 存在');

    await post({ member_session: memberSession, cart_id: cartId, consent: true });
    const count = db.get(`SELECT COUNT(*) c FROM cart_recovery_consents WHERE store_id=? AND cart_id=?`, [storeId, cartId]).c;
    assert(count === 1, 'C7. 同 cart 再 grant 不 duplicate row', `count=${count}`);

    const r8 = await post({ member_session: memberSession, cart_id: cartId, consent: false });
    assert(r8.success === true, 'C8-pre. revoke 呼叫成功');
    const rowAfterRevoke = db.get(`SELECT * FROM cart_recovery_consents WHERE store_id=? AND cart_id=?`, [storeId, cartId]);
    assert(rowAfterRevoke.status === 'revoked', 'C8. status=revoked');
    assert(!!rowAfterRevoke.revoked_at, 'C9. revoked_at 存在');

    const { logServerEvent } = require('../utils/analyticsLog');
    const cartRecovery = require('../utils/cartRecovery');
    setSetting(db, storeId, 'cart_recovery_enabled', '1');
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
    const jobRow = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(!!jobRow, 'C10. revoke 後 job 本身仍存在（未被連帶刪除）');
    const delivery = require('../utils/cartRecoveryDelivery');
    const evalResult = delivery.evaluateLineRecoveryEligibility(db, storeId, jobRow);
    assert(evalResult.eligible === false && evalResult.reason_code === 'consent_revoked', 'C11. revoke 後 eligibility=false（reason=consent_revoked）', JSON.stringify(evalResult));

    const cartIdBeta = uniqId('consent-cart-beta');
    const appBeta = express();
    appBeta.use(express.json());
    appBeta.use((req, res, next) => { req.storeId = 'store_beta_int'; next(); });
    appBeta.use('/api/cart-recovery', require('../routes/cart-recovery'));
    const serverBeta = http.createServer(appBeta);
    await new Promise((resolve) => serverBeta.listen(0, resolve));
    const portBeta = serverBeta.address().port;
    const resBeta = await fetch(`http://127.0.0.1:${portBeta}/api/cart-recovery/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, cart_id: cartIdBeta, consent: true }) });
    const jsonBeta = await resBeta.json();
    serverBeta.close();
    assert(jsonBeta.success === false, 'C12. store A 的 member_session 不可操作 store B 的 consent（signature store-scoped，驗證失敗）', JSON.stringify(jsonBeta));
  } finally {
    server.close();
  }
}

// ── Part E：Recovery Settings Backend Integration（真實 HTTP routes/settings.js）──
async function runSettingsBackendIntegration(db) {
  console.log('\n== Part E：Recovery Settings Backend Integration ==');
  const cartRecovery = require('../utils/cartRecovery');
  const storeId = 'store_settings_int';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Settings Int', 'x', 'pro', 1]);

  assert(cartRecovery.isRecoveryEnabled(db, storeId) === false, 'SET1. 新店 master default=0');
  assert(require('../utils/cartRecoveryDelivery').isLineRecoveryEnabled(db, storeId) === false, 'SET2. 新店 LINE default=0');
  assert(cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned') === 60, 'SET3. cart delay default=60');
  assert(cartRecovery.getDelayMinutes(db, storeId, 'checkout_abandoned') === 30, 'SET4. checkout delay default=30');
  assert(cartRecovery.getDelayMinutes(db, storeId, 'payment_abandoned') === 15, 'SET5. payment delay default=15');
  assert(cartRecovery.getMaxAttempts(db, storeId) === 1, 'SET6. max_attempts default=1');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = storeId; next(); });
  app.use('/api/settings', require('../routes/settings'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const r7 = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_enabled: '1' }) });
    const j7 = await r7.json();
    assert(j7.success === true && cartRecovery.isRecoveryEnabled(db, storeId) === true, 'SET7. PUT settings master=1 真實生效', JSON.stringify(j7));

    const r8 = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_line_enabled: '1' }) });
    await r8.json();
    assert(require('../utils/cartRecoveryDelivery').isLineRecoveryEnabled(db, storeId) === true, 'SET8. PUT settings line=1 真實生效');

    const r9 = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_cart_delay_minutes: '120' }) });
    await r9.json();
    assert(cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned') === 120, 'SET9. 合法 custom delay 透過真實 PUT 保存', cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned'));
  } finally {
    server.close();
  }

  const storeId2 = 'store_settings_int_2';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId2, 'Settings Int 2', 'x', 'pro', 1]);
  assert(cartRecovery.isRecoveryEnabled(db, storeId2) === false, 'SET10. 完全沒有任何設定 key 的舊店，仍安全 fallback OFF（不因缺欄位而誤判成 enabled）');
}

// ── Part F：Eligibility Full Integration Matrix（14 條）──
async function runEligibilityFullMatrix(db) {
  console.log('\n== Part F：Eligibility Full Integration Matrix ==');
  const delivery = require('../utils/cartRecoveryDelivery');
  const cartRecovery = require('../utils/cartRecovery');
  const { logServerEvent } = require('../utils/analyticsLog');
  const { grantConsent } = require('../utils/cartRecoveryConsent');
  const storeId = 'store_elig_matrix';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Elig Matrix', 'x', 'pro', 1]);

  function baseline() {
    setSetting(db, storeId, 'cart_recovery_enabled', '1');
    setSetting(db, storeId, 'cart_recovery_line_enabled', '1');
    setSetting(db, storeId, 'line_channel_token', 'fake-token');
    setSetting(db, storeId, 'line_member_liff_id', 'liff-id-matrix');
  }
  function makeEligibleJob(overrides) {
    const cartId = uniqId('elig-cart');
    const lineUserId = `Uelig${_intCtr}000000000001`;
    db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
    db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, cartId]);
    const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    return Object.assign(job, overrides || {});
  }

  baseline();
  { const job = makeEligibleJob(); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === true, 'E14. 全部條件符合 → eligible=true', JSON.stringify(r)); }

  { const job = makeEligibleJob(); setSetting(db, storeId, 'cart_recovery_enabled', '0'); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'recovery_disabled', 'E1. master OFF → false（recovery_disabled）', JSON.stringify(r)); baseline(); }
  { const job = makeEligibleJob(); setSetting(db, storeId, 'cart_recovery_line_enabled', '0'); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'line_recovery_disabled', 'E2. LINE OFF → false（line_recovery_disabled）', JSON.stringify(r)); baseline(); }
  { const job = makeEligibleJob(); job.due_at = new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' '); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'job_not_due', 'E3. job 未 due → false（job_not_due）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); job.status = 'converted'; const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'already_converted', 'E4. job converted → false（already_converted）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); job.status = 'cancelled'; const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'job_not_pending', 'E5. job cancelled → false（job_not_pending）', JSON.stringify(r)); }
  { const cartId = uniqId('elig-cart'); const lineUserId = `Uelig${_intCtr}000000000001`; db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]); logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 }); db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, cartId]); const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'consent_missing', 'E6. consent missing → false（consent_missing）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); const { revokeConsent } = require('../utils/cartRecoveryConsent'); revokeConsent(db, storeId, { cartId: job.cart_id }); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'consent_revoked', 'E7. consent revoked → false（consent_revoked）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); job.line_user_id = ''; const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'member_not_identified', 'E8. line_user missing → false（member_not_identified）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); db.run(`UPDATE line_members SET is_friend=0 WHERE store_id=? AND line_user_id=?`, [storeId, job.line_user_id]); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'not_friend', 'E9. friend=false → false（not_friend）', JSON.stringify(r)); }
  { const job = makeEligibleJob(); db.run(`DELETE FROM line_members WHERE store_id=? AND line_user_id=?`, [storeId, job.line_user_id]); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'friend_status_unknown', 'E10. friend unknown → false（friend_status_unknown）', JSON.stringify(r)); }
  { setSetting(db, storeId, 'line_channel_token', ''); const job = makeEligibleJob(); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'channel_token_missing', 'E11. channel token missing → false（channel_token_missing）', JSON.stringify(r)); baseline(); }
  { setSetting(db, storeId, 'line_member_liff_id', ''); const job = makeEligibleJob(); const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'recovery_link_unavailable', 'E12. LIFF ID missing → false（recovery_link_unavailable）', JSON.stringify(r)); baseline(); }
  { const job = makeEligibleJob(); job.attempt_count = 1; job.max_attempts = 1; const r = delivery.evaluateLineRecoveryEligibility(db, storeId, job); assert(r.eligible === false && r.reason_code === 'max_attempts_reached', 'E13. attempt max reached → false（max_attempts_reached）', JSON.stringify(r)); }
}

// ── Part G：Push Processor Full Integration（15 條）──
async function runPushProcessorFullIntegration(db) {
  console.log('\n== Part G：Push Processor Full Integration ==');
  const cartRecovery = require('../utils/cartRecovery');
  const delivery = require('../utils/cartRecoveryDelivery');
  const { logServerEvent } = require('../utils/analyticsLog');
  const { grantConsent } = require('../utils/cartRecoveryConsent');
  const linePushModule = require('../utils/linePush');
  const storeId = 'store_push_proc';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Push Proc', 'x', 'pro', 1]);
  setSetting(db, storeId, 'cart_recovery_enabled', '1');
  setSetting(db, storeId, 'cart_recovery_line_enabled', '1');
  setSetting(db, storeId, 'line_channel_token', 'fake-token');
  setSetting(db, storeId, 'line_member_liff_id', 'liff-push-proc');

  function makeJob() {
    const cartId = uniqId('push-cart');
    const lineUserId = `Upush${_intCtr}000000000001`;
    db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
    db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, cartId]);
    return { cartId, lineUserId };
  }

  {
    const { cartId } = makeJob();
    let calls = 0;
    const original = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => { calls += 1; return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original;
    assert(calls === 1, 'P1. eligible due job → exactly one push', `calls=${calls}`);
    const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(!!job.sent_at, 'P2. sent_at 存在');
    assert(Number(job.attempt_count) === 1, 'P3. attempt_count=1', job.attempt_count);
    assert(job.channel === 'line', 'P4. channel=line');
    assert(job.status === 'sent', 'P5. status=sent');

    let calls2 = 0;
    const original2 = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => { calls2 += 1; return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original2;
    assert(calls2 === 0, 'P6. 同 processor 再跑 → push count 不增加（已 sent，attempt 達上限）', `calls=${calls2}`);
  }

  {
    const { cartId } = makeJob();
    const { revokeConsent } = require('../utils/cartRecoveryConsent');
    revokeConsent(db, storeId, { cartId });
    let calls = 0;
    const original = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => { calls += 1; return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original;
    assert(calls === 0, 'P7. consent revoke 後 → 0 push', `calls=${calls}`);
  }

  {
    const { cartId, lineUserId } = makeJob();
    db.run(`UPDATE line_members SET is_friend=0 WHERE store_id=? AND line_user_id=?`, [storeId, lineUserId]);
    let calls = 0;
    const original = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => { calls += 1; return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original;
    assert(calls === 0, 'P8. friend=false → 0 push', `calls=${calls}`);
  }

  {
    setSetting(db, storeId, 'line_channel_token', '');
    const { cartId } = makeJob();
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    const job = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(job.status === 'not_configured', 'P9. token missing → not_configured（不假裝 sent）', job.status);
    setSetting(db, storeId, 'line_channel_token', 'fake-token');
  }

  {
    const { cartId } = makeJob();
    const original = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => ({ success: false, status: 0, error_code: 'network_error' });
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original;
    const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(job.status === 'failed', 'P10. LINE Push transport failure → failed', job.status);

    let calls = 0;
    const original2 = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async () => { calls += 1; return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original2;
    assert(calls === 0, 'P11. failure 後 max_attempts=1 → 再跑不重送', `calls=${calls}`);
  }

  {
    const { cartId } = makeJob();
    let capturedText = '';
    const original = linePushModule.sendLinePush;
    linePushModule.sendLinePush = async (opts) => { capturedText = JSON.stringify(opts.messages); return { success: true, status: 200 }; };
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule.sendLinePush = original;
    assert(!capturedText.includes('王小明') && !capturedText.includes('測試客戶'), 'P12. Push message 不含 customer name');
    assert(!/09\d{8}/.test(capturedText), 'P13. Push message 不含電話');
    assert(!capturedText.includes('台北市') && !capturedText.includes('地址'), 'P14. Push message 不含地址');
    const job = db.get(`SELECT line_user_id FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(!capturedText.includes(job.line_user_id), 'P15. Push message 文字內容不含 raw line_user_id 字串');
  }
}

// ── Part H：Recovery URL Full Integration（14 條）──
async function runRecoveryUrlFullIntegration(db) {
  console.log('\n== Part H：Recovery URL Full Integration ==');
  const delivery = require('../utils/cartRecoveryDelivery');
  const handoff = require('../utils/lineCheckoutHandoff');
  const storeId = 'store_url_int';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'URL Int', 'x', 'pro', 1]);
  setSetting(db, storeId, 'line_member_liff_id', 'liff-member-url-int');
  setSetting(db, storeId, 'line_shipping_liff_id', 'liff-shipping-url-int');

  { const u = delivery.buildRecoveryUrl(db, storeId, { token: 'TOK1', pageType: 'line_order' }); assert(u.ok && u.url.includes('liff-member-url-int'), 'U1. line_order → member LIFF', JSON.stringify(u)); }
  { const u = delivery.buildRecoveryUrl(db, storeId, { token: 'TOK2', pageType: 'line_shipping' }); assert(u.ok && u.url.includes('liff-shipping-url-int'), 'U2. line_shipping → shipping LIFF', JSON.stringify(u)); }

  {
    const storeId2 = 'store_url_int_2';
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId2, 'URL Int 2', 'x', 'pro', 1]);
    setSetting(db, storeId2, 'line_member_liff_id', 'liff-member-fallback');
    const u = delivery.buildRecoveryUrl(db, storeId2, { token: 'TOK3', pageType: 'line_shipping' });
    assert(u.ok && u.url.includes('liff-member-fallback'), 'U3. shipping LIFF missing → fallback member LIFF', JSON.stringify(u));
  }
  {
    const storeId3 = 'store_url_int_3';
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId3, 'URL Int 3', 'x', 'pro', 1]);
    const u = delivery.buildRecoveryUrl(db, storeId3, { token: 'TOK4', pageType: 'line_order' });
    assert(u.ok === false && !u.url, 'U4. 全部 LIFF missing → no URL', JSON.stringify(u));
  }
  {
    const u = delivery.buildRecoveryUrl(db, storeId, { token: 'OPAQUE_TOKEN_XYZ', pageType: 'line_order' });
    assert(!u.url.includes('cart_id='), 'U5. URL 不含 cart_id');
    assert(!u.url.includes('order_id='), 'U6. URL 不含 order_id');
    assert(!u.url.includes('line_user_id=') && !/U[0-9a-f]{32}/.test(u.url), 'U7. URL 不含 line_user_id');
    assert(u.url.includes('recovery_token=OPAQUE_TOKEN_XYZ'), 'U8. URL 有 opaque recovery_token', u.url);
  }
  {
    const tokOrder = handoff.createRecoveryResumeToken(db, storeId, { cartId: uniqId('url-cart'), lineUserId: 'Uurlint0000000000000001', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    const rOrder = handoff.restoreRecoveryToken(db, storeId, tokOrder.token, 'Uurlint0000000000000001');
    assert(rOrder.pageType === 'line_order', 'U9. token page_type=line_order', JSON.stringify(rOrder.pageType));
    const tokShip = handoff.createRecoveryResumeToken(db, storeId, { cartId: uniqId('url-cart'), lineUserId: 'Uurlint0000000000000002', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_shipping' });
    const rShip = handoff.restoreRecoveryToken(db, storeId, tokShip.token, 'Uurlint0000000000000002');
    assert(rShip.pageType === 'line_shipping', 'U10. token page_type=line_shipping', JSON.stringify(rShip.pageType));
  }
  {
    const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId: uniqId('url-cart'), lineUserId: 'Uurlint0000000000000003', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    const wrongPage = handoff.restoreRecoveryToken(db, storeId, tok.token, 'Uurlint0000000000000003', 'line_shipping');
    assert(wrongPage.ok === false && wrongPage.reason === 'wrong_page', 'U11. wrong page restore rejected', JSON.stringify(wrongPage));
    const wrongMember = handoff.restoreRecoveryToken(db, storeId, tok.token, 'Uwrongmember00000000001');
    assert(wrongMember.ok === false && wrongMember.reason === 'uid_mismatch', 'U12. wrong member rejected', JSON.stringify(wrongMember));

    const tokExpired = handoff.createRecoveryResumeToken(db, storeId, { cartId: uniqId('url-cart'), lineUserId: 'Uurlint0000000000000004', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    db.run(`UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?`, [tokExpired.token]);
    const expired = handoff.restoreRecoveryToken(db, storeId, tokExpired.token, 'Uurlint0000000000000004');
    assert(expired.ok === false && expired.reason === 'expired', 'U13. expired rejected', JSON.stringify(expired));

    const cartIdConv = uniqId('url-cart');
    const lineUserIdConv = 'Uurlint0000000000000005';
    const nowIso = require('../utils/cartRecovery')._nowIso();
    db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartIdConv, 'cart_abandoned', 'converted', nowIso, `cart:${cartIdConv}:cart_abandoned`, nowIso, nowIso]);
    const tokConv = handoff.createRecoveryResumeToken(db, storeId, { cartId: cartIdConv, lineUserId: lineUserIdConv, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.storeId = storeId; next(); });
    app.use('/api/cart-recovery', require('../routes/cart-recovery'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const { createMemberSession } = require('../utils/lineMemberSession');
    const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserIdConv });
    const res = await fetch(`http://127.0.0.1:${port}/api/cart-recovery/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tokConv.token, page_type: 'line_order' }) });
    const json = await res.json();
    server.close();
    assert(json.success === false && json.reason === 'already_completed', 'U14. converted job → restore rejected（already_completed，defense-in-depth）', JSON.stringify(json));
  }
}

// ── Part I：Cart/Checkout E2E 再補（8 條）──
async function runCartCheckoutE2EExtra(db) {
  console.log('\n== Part I：Cart/Checkout E2E 再補 ==');
  const cartRecovery = require('../utils/cartRecovery');
  const delivery = require('../utils/cartRecoveryDelivery');
  const { logServerEvent } = require('../utils/analyticsLog');
  const { grantConsent } = require('../utils/cartRecoveryConsent');
  const linePushModule = require('../utils/linePush');
  const storeId = 'store_cc_e2e';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'CC E2E', 'x', 'pro', 1]);
  setSetting(db, storeId, 'cart_recovery_enabled', '1');
  setSetting(db, storeId, 'cart_recovery_line_enabled', '1');
  setSetting(db, storeId, 'line_channel_token', 'fake-token');
  setSetting(db, storeId, 'line_member_liff_id', 'liff-cc-e2e');

  const cartId = uniqId('cc-e2e-cart');
  const lineUserId = 'Ucce2e00000000000000001';
  db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
  logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
  logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
  grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
  db.run(`UPDATE cart_recovery_jobs SET line_user_id=?, due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, cartRecovery._nowIso(), storeId, cartId]);

  const originalSend = linePushModule.sendLinePush;
  linePushModule.sendLinePush = async () => ({ success: true, status: 200 });
  await delivery.processDueLineRecoveryJobs(db, storeId, {});
  linePushModule.sendLinePush = originalSend;

  {
    const job = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(job.status === 'sent', 'CC1. checkout_click 之前，cart job 已是 sent');
  }
  {
    const before = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).c;
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'checkout_click' });
    const after = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).c;
    assert(before === after, 'CC2. checkout_click 發生後，cart_abandoned 不產生第二筆 row', `before=${before} after=${after}`);
  }
  {
    const orderId = uniqId('cc-e2e-order');
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
    const checkoutJob = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='checkout_abandoned'`, [storeId, cartId]);
    assert(checkoutJob.status === 'cancelled', 'CC3. submit_order 取消 checkout-stage recovery', JSON.stringify(checkoutJob));

    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
    const cartJob = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(cartJob.status === 'converted', 'CC4. purchase → 相關 sent job converted', cartJob.status);

    const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=? AND purpose='recovery_resume'`, [storeId, cartId]);
    assert(tokenRow && tokenRow.status === 'cancelled', 'CC5. purchase 後 old token 被 invalidate（status=cancelled）', JSON.stringify(tokenRow));

    assert(!!cartJob.sent_at, 'CC6. sent_at 不因 conversion 被清掉');
    assert(!!cartJob.converted_at, 'CC7. converted_at 有值');

    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
    const cartJobAgain = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(cartJobAgain.status === 'converted', 'CC8. 第二次 purchase，狀態仍只有 converted（idempotent）', cartJobAgain.status);
  }
}

// ── Part J：Payment E2E 安全性再補（18 條）──
async function runPaymentE2ESecurityExtra(db) {
  console.log('\n== Part J：Payment E2E 安全性再補 ==');
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');
  const { logServerEvent } = require('../utils/analyticsLog');
  const storeId = 'store_pay_e2e';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Pay E2E', 'x', 'pro', 1]);
  db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, [storeId]);
  db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`, [storeId, 'LINE Pay', 'linepay', 1, 'test', 'test-id', 'test-secret']);

  const nodeFetchPath = require.resolve('node-fetch');
  let confirmReturnCode = '0000';
  let lastRequestBody = null;
  let apiCallCount = 0;
  const fakeFetch = async (url, opts) => {
    apiCallCount += 1;
    if (String(url).includes('/request')) { try { lastRequestBody = JSON.parse((opts && opts.body) || '{}'); } catch (e) {} }
    if (confirmReturnCode !== '0000') return { json: async () => ({ returnCode: confirmReturnCode }) };
    return { json: async () => ({ returnCode: '0000', info: { transactionId: 'txn-payj', paymentUrl: { web: 'https://sandbox.line.me/pay/payj' } } }) };
  };
  require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = storeId; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  function makeOrder(orderId, total) {
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`, [orderId, orderId, orderId, storeId, '[]', total, total, 'linepay', 'unpaid']);
  }
  async function resumePayment(token, memberSession, extraBody) {
    const res = await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ member_session: memberSession, recovery_token: token }, extraBody || {})) });
    return res.json();
  }
  async function paymentCancelled(token, memberSession) {
    const res = await fetch(`${base}/api/cart-recovery/payment-cancelled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: token }) });
    return res.json();
  }

  try {
    const lineUserId = 'Upaye2e0000000000000001';
    const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });

    {
      const cartId = uniqId('paye2e-cart');
      const orderId = uniqId('paye2e-order');
      makeOrder(orderId, 1234);
      const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      lastRequestBody = null;
      const r = await resumePayment(tok.token, memberSession, { order_id: 'FAKE-ORDER-ID', total: 1 });
      assert(lastRequestBody && lastRequestBody.amount === 1234, 'PAY1. resume-payment client total=1 → DB request amount 仍是 order.total（1234）', JSON.stringify(lastRequestBody));
      assert(r.success === true, 'PAY2. client fake order_id 被忽略，resume 仍正確使用 token 綁定的真實訂單');
      assert(!('order_id' in r), 'PAY3. resume response 不回 order_id', JSON.stringify(Object.keys(r)));
      assert(!('total' in r), 'PAY4. resume response 不回 total', JSON.stringify(Object.keys(r)));
    }

    {
      confirmReturnCode = '9999';
      const cartId = uniqId('paye2e-cart');
      const orderId = uniqId('paye2e-order');
      makeOrder(orderId, 500);
      const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const before = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started'`, [storeId, orderId]).c;
      await resumePayment(tok.token, memberSession);
      const after = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started'`, [storeId, orderId]).c;
      assert(after === before, 'PAY5. LINE Pay request failure → 不寫 Recovery payment_started', `before=${before} after=${after}`);
      confirmReturnCode = '0000';
    }
    {
      const cartId = uniqId('paye2e-cart');
      const orderId = uniqId('paye2e-order');
      makeOrder(orderId, 500);
      const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      const after = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started'`, [storeId, orderId]).c;
      assert(after === 1, 'PAY6. LINE Pay request success → payment_started +1', `count=${after}`);
      const evt = db.get(`SELECT cart_id, order_id FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started' ORDER BY id DESC LIMIT 1`, [storeId, orderId]);
      assert(evt.cart_id === cartId, 'PAY7. payment_started cart_id = token authoritative cart', evt.cart_id);
      assert(evt.order_id === orderId, 'PAY8. payment_started order_id = token authoritative order', evt.order_id);
    }

    {
      const cartId = uniqId('paye2e-cart');
      const orderId = uniqId('paye2e-order');
      makeOrder(orderId, 500);
      const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      apiCallCount = 0;
      const [r1, r2] = await Promise.all([resumePayment(tok.token, memberSession), resumePayment(tok.token, memberSession)]);
      assert(apiCallCount === 1, 'PAY9. concurrent 2 requests → LINE API only 1 call', `apiCallCount=${apiCallCount}`);
      const loser = [r1, r2].find((r) => r.success === false);
      assert(loser && loser.reason === 'payment_request_in_progress', 'PAY10. loser canonical reason=payment_request_in_progress', JSON.stringify(loser));

      const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tok.token]);
      assert(tokenRow.status === 'payment_requested', 'PAY11. success → token status=payment_requested', tokenRow.status);
      apiCallCount = 0;
      const r3 = await resumePayment(tok.token, memberSession);
      assert(apiCallCount === 0 && r3.success === false, 'PAY12. payment_requested 不可直接再次 request（無新 API call）', JSON.stringify(r3));

      const cancelResult = await paymentCancelled(tok.token, memberSession);
      const tokenRowAfterCancel = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tok.token]);
      assert(cancelResult.success === true && tokenRowAfterCancel.status === 'opened', 'PAY13. payment-cancelled → opened', JSON.stringify(tokenRowAfterCancel));
      apiCallCount = 0;
      const r4 = await resumePayment(tok.token, memberSession);
      assert(r4.success === true && apiCallCount === 1, 'PAY14. cancel 後 user retry → 可再 request', JSON.stringify(r4));

      const orderCountBefore = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id=?`, [storeId]).c;
      // PAY15 需要真的有一筆 payment_abandoned job 可以被 convert——這個 Part
      // 主要在測 resume-payment route 本身，沒有特別走過完整
      // submit_order→payment_started 事件鏈來自然建立 job，這裡直接補一筆
      // pending job（idempotency_key 對齊既有 cartRecovery.js 格式）確保
      // conversion hook 有東西可以轉換，驗證的仍是真實 markRecoveryConverted() 邏輯。
      const nowIsoPay = require('../utils/cartRecovery')._nowIso();
      db.run(`INSERT OR IGNORE INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [storeId, cartId, orderId, 'payment_abandoned', 'pending', nowIsoPay, `order:${orderId}:payment_abandoned`, nowIsoPay, nowIsoPay]);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 500 } });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
      const paymentJob = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`, [storeId, orderId]);
      assert(paymentJob && paymentJob.status === 'converted', 'PAY15. payment_success → payment job converted', paymentJob && paymentJob.status);
      apiCallCount = 0;
      const r5 = await resumePayment(tok.token, memberSession);
      assert(r5.success === false && apiCallCount === 0, 'PAY16. old payment token 不可再 resume（0 API call）', JSON.stringify(r5));
      const purchaseCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='purchase'`, [storeId, orderId]).c;
      assert(purchaseCount === 1, 'PAY17. purchase count remains 1', purchaseCount);
      const orderCountAfter = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id=?`, [storeId]).c;
      assert(orderCountAfter === orderCountBefore, 'PAY18. orders count unchanged（無 duplicate order）', `before=${orderCountBefore} after=${orderCountAfter}`);
    }
  } finally {
    server.close();
    delete require.cache[nodeFetchPath];
  }
}

// ── Part K：External Analytics Contract（8 條，靜態）──
function runExternalAnalyticsContract() {
  console.log('\n== Part K：External Analytics Contract ==');
  const analyticsPlatformsJs = fs.readFileSync(path.join(ROOT, 'public/js/analytics-platforms.js'), 'utf8');
  const ga4MapMatch = analyticsPlatformsJs.match(/const GA4_EVENT_MAP = \{[\s\S]*?\};/);
  const metaMapMatch = analyticsPlatformsJs.match(/const META_EVENT_MAP = \{[\s\S]*?\};/);
  assert(ga4MapMatch[0].includes("checkout_click: 'begin_checkout'"), 'AN1（映射鎖定）. checkout_click → GA4 begin_checkout 契約未變');
  assert(metaMapMatch[0].includes("checkout_click: 'InitiateCheckout'"), 'AN2（映射鎖定）. checkout_click → Meta InitiateCheckout 契約未變');
  // 注意：payment_started 本身在既有 checkout 流程早就合法對應 GA4
  // AddPaymentInfo／Meta add_payment_info（e-commerce 標準漏斗事件，Phase 3
  // 之前就存在），Recovery backend authority 沿用同一個 event_name，不是
  // 發明新事件，所以這裡不檢查 payment_started 是否被排除。
  ['cart_updated', 'cart_restored', 'payment_success', 'checkout_submit_click', 'checkout_validation_failed'].forEach((evt) => {
    assert(!ga4MapMatch[0].includes(`${evt}:`), `AN5-partial. ${evt} 未加入 GA4_EVENT_MAP`);
    assert(!metaMapMatch[0].includes(`${evt}:`), `AN6-partial. ${evt} 未加入 META_EVENT_MAP`);
  });
  assert(ga4MapMatch[0].includes("purchase: 'purchase'") || /purchase:\s*'purchase'/.test(ga4MapMatch[0]), 'AN8a. purchase → GA4 purchase 映射存在（唯一 external Purchase 來源之一）');
  const cartRecoverySrc = fs.readFileSync(path.join(ROOT, 'utils/cartRecovery.js'), 'utf8');
  const deliverySrc = fs.readFileSync(path.join(ROOT, 'utils/cartRecoveryDelivery.js'), 'utf8');
  assert(!cartRecoverySrc.includes('trackPlatformEvent') && !cartRecoverySrc.includes('fbq(') && !cartRecoverySrc.includes('gtag('), 'AN3/AN7a. utils/cartRecovery.js 完全不呼叫第三方 Analytics 平台函式（不建立第二個 Purchase）');
  assert(!deliverySrc.includes('trackPlatformEvent') && !deliverySrc.includes('fbq(') && !deliverySrc.includes('gtag('), 'AN4/AN7b. utils/cartRecoveryDelivery.js 完全不呼叫第三方 Analytics 平台函式');
  const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const recoverySection = orderSrc.match(/H1\.4\.10 Phase 4B：Frontend Recovery Resume[\s\S]*?(?=\/\/ ── 全域狀態 ──)/);
  // 需求文件：只檢查「真的呼叫」，排除掉解說用途的註解行本身也包含這串文字
  // 的情況（例如「這裡故意不呼叫 _trackEvent('payment_started')」這種說明性
  // 註解，不代表真的呼叫）。
  const recoveryCodeLinesOnly = (recoverySection ? recoverySection[0] : '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert(!!recoverySection && !recoveryCodeLinesOnly.includes("_trackEvent('payment_started'"), 'AN3b. line-order.html Recovery 區塊（排除註解說明行）不呼叫 _trackEvent(payment_started)（frontend 不重複送）');
}

// ── Part L：Security Full Acceptance（15 條）──
async function runSecurityFullAcceptance(db) {
  console.log('\n== Part L：Security Full Acceptance ==');
  const linePayClientSrc = fs.readFileSync(path.join(ROOT, 'utils/linePayClient.js'), 'utf8');
  assert(!/return\s*\{[^}]*\bmessage\b/.test(linePayClientSrc.match(/function signLinePayPost[\s\S]*?\n}/)[0]), 'SEC11. signLinePayPost() 回傳值不含 message（簽章 preimage 不外露）');
  assert(!/return\s*\{[^}]*\bmessage\b/.test(linePayClientSrc.match(/function signLinePayGet[\s\S]*?\n}/)[0]), 'SEC11b. signLinePayGet() 回傳值不含 message');

  const linePayRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/linepay.js'), 'utf8');
  // 排除註解說明行本身提到 messagePreview 這個詞（本輪修復的說明文字），只
  // 檢查程式碼中是否還有真的 `messagePreview:` 欄位賦值。
  const linePayRouteCodeOnly = linePayRouteSrc.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert(!/messagePreview\s*:/.test(linePayRouteCodeOnly), 'SEC12. routes/linepay.js 程式碼中不再有 messagePreview: 欄位賦值（簽章 preimage 不進 log，排除說明性註解）');

  ['routes/linepay.js', 'utils/linePayService.js', 'routes/payment-gateways.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(!/crypto\.createHmac\('sha256',\s*channelSecret\)/.test(src) || src.includes("require('../utils/linePayClient')") || src.includes("require('./linePayClient')"), `SEC-SSOT. ${f} 沒有自己重新定義簽章公式（改用 linePayClient import）`);
  });

  const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shipSrc = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  assert(!orderSrc.includes('__RECOVERY_NAVIGATION_HOOK__') && !orderSrc.includes('__RECOVERY_TEST__') && !orderSrc.includes('TEST_ONLY_RECOVERY'), 'SEC13a. line-order.html 無 test-only hook 殘留');
  assert(!shipSrc.includes('__RECOVERY_NAVIGATION_HOOK__') && !shipSrc.includes('__RECOVERY_TEST__') && !shipSrc.includes('TEST_ONLY_RECOVERY'), 'SEC13b. line-shipping.html 無 test-only hook 殘留');

  {
    const storeId = 'store_sec_full';
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Sec Full', 'x', 'pro', 1]);
    const handoff = require('../utils/lineCheckoutHandoff');
    const orderId = uniqId('sec-order');
    handoff.createRecoveryResumeToken(db, storeId, { cartId: uniqId('sec-cart'), lineUserId: 'Usecfull0000000000000001', orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.storeId = storeId; next(); });
    app.use('/api/analytics', require('../routes/analytics'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 999 } }) });
    server.close();
    assert(res.status === 400 || res.status === 403, 'SEC14. client fake payment_success 仍 400/403', res.status);
    const dbCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND event_name='payment_success' AND order_id=?`, [storeId, orderId]).c;
    assert(dbCount === 0, 'SEC15. fake payment_success 未寫入（不 convert recovery）', dbCount);
  }
}

// ── Part M：Admin UI Master/Line Semantics（8 條）──
async function runAdminUiMasterLineSemantics() {
  console.log('\n== Part M：Admin UI Master/Line Semantics ==');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const cardMatch = (() => { const t = extractBalancedDiv(indexHtml, '<div class="settings-card" id="cartRecoveryCard"'); return t ? [t] : null; })();
  const constMatch = appJs.match(/const CART_RECOVERY_DELAY_DEFAULTS = \{[^}]*\};/);
  const updateFnMatch = appJs.match(/function updateCartRecoverySettingsUI\(\)[\s\S]*?\n}\n/);
  const loadFnMatch = appJs.match(/async function loadCartRecoverySettings\(\)[\s\S]*?\n}\n/);
  const saveFnMatch = appJs.match(/async function saveCartRecoverySettings\(\)[\s\S]*?\n}\n/);
  if (!cardMatch || !constMatch || !updateFnMatch || !loadFnMatch || !saveFnMatch) { fail('Part M：找不到必要片段，無法測試'); return; }

  function buildDom(initialSettings) {
    const html = `<!doctype html><html><body>${cardMatch[0]}</body></html>`;
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.settings = initialSettings || {};
    dom.window.apiFetchCalls = [];
    dom.window.apiFetch = async (url, opts) => { dom.window.apiFetchCalls.push({ url, opts }); const body = opts && opts.body ? JSON.parse(opts.body) : {}; Object.assign(dom.window.settings, body); return { json: async () => ({ success: true }) }; };
    dom.window.toast = () => {};
    dom.window.eval(constMatch[0] + '\n' + updateFnMatch[0] + '\n' + loadFnMatch[0] + '\n' + saveFnMatch[0]);
    return dom;
  }

  {
    const dom = buildDom({ cart_recovery_enabled: '0' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    assert(dom.window.document.getElementById('set-cart_recovery_line_enabled').disabled === true, 'A14. master OFF → line checkbox disabled');
    dom.window.close();
  }
  {
    const dom = buildDom({ cart_recovery_enabled: '1' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    assert(dom.window.document.getElementById('set-cart_recovery_line_enabled').disabled === false, 'A15. master ON → line checkbox enabled');
    dom.window.close();
  }
  {
    const dom = buildDom({ cart_recovery_enabled: '0', cart_recovery_line_enabled: '1' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    assert(dom.window.document.getElementById('set-cart_recovery_line_enabled').checked === true, 'A16. master OFF 不自動清除既有 line setting 值（load 仍正確顯示 checked）');
    dom.window.close();
  }
  {
    const dom = buildDom({ cart_recovery_enabled: '0' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const hint = dom.window.document.getElementById('cartRecoveryLineDisabledHint');
    assert(hint && hint.style.display === 'block', 'A17. master OFF 時畫面 hint 正確顯示');
    dom.window.close();
  }
  {
    const dom = buildDom({});
    await dom.window.eval('saveCartRecoverySettings()');
    await wait(10);
    const sentBody = JSON.parse(dom.window.apiFetchCalls[0].opts.body);
    assert(!('line_channel_token' in sentBody), 'A18. settings save payload 不包含 line_channel_token（這張卡不負責改 token）', JSON.stringify(Object.keys(sentBody)));
    dom.window.close();
  }
  {
    const dom = buildDom({ line_channel_token: 'ANOTHER_REAL_TOKEN_VALUE_ZZZZ' });
    await dom.window.eval('loadCartRecoverySettings()');
    await wait(5);
    const statusEl = dom.window.document.getElementById('cartRecoveryLineStatus');
    assert(statusEl.textContent === '已設定' && !statusEl.textContent.includes('ANOTHER_REAL'), 'A19. token readiness 只顯示布林狀態（不同 token 值仍只顯示已設定）');
    dom.window.close();
  }
  {
    assert(cardMatch[0].includes('顧客主動'), 'A20. 卡片文案包含「顧客主動」相關說明');
    assert(cardMatch[0].includes('完成訂單') && cardMatch[0].includes('不會發送'), 'A21. 卡片文案包含「已完成訂單…不會發送」相關說明');
  }
}


function runComposedTargetedSuites() {
  console.log('\n== Part C：Composition Gate（Backend／Frontend Targeted）==');
  const suites = [
    { name: 'Backend Recovery Targeted', file: 'run-h1-4-10-phase4b-recovery-resume-targeted.js' },
    { name: 'Frontend Recovery Targeted', file: 'run-h1-4-10-phase4b-recovery-frontend-targeted.js' },
  ];
  for (const suite of suites) {
    try {
      const output = execFileSync('node', [path.join(ROOT, 'scripts', suite.file)], { encoding: 'utf8', cwd: ROOT });
      const m = output.match(/TOTAL=(\d+) PASS=(\d+) FAIL=(\d+)/);
      if (m) {
        const [, total, passN, failN] = m;
        assert(Number(failN) === 0, `Composition. ${suite.name}: ${passN}/${total} PASS（FAIL=0）`, `FAIL=${failN}`);
      } else {
        fail(`Composition. ${suite.name}: 無法解析輸出`, output.slice(-300));
      }
    } catch (e) {
      fail(`Composition. ${suite.name}: 執行失敗（非 0 exit code）`, (e.stdout || e.message || '').toString().slice(-500));
    }
  }
}

async function main() {
  await runAdminUiTests();
  await runIntegrationParts();
  runComposedTargetedSuites();

  console.log('\n== Phase 4B Full Suite Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Full suite runner crashed:', e && e.stack || e); process.exit(1); });
