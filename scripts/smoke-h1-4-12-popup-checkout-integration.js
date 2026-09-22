#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-checkout-integration.js
// H1.4.12 Phase 3B — real HTTP + real DB popup checkout integration test.
//
// Unlike scripts/smoke-h1-4-12-popup-frontend.js (which stubs fetch with
// canned fixture objects), this file runs a real Express app on a real
// ephemeral port, backed by a real temporary sql.js database, and lets the
// jsdom-loaded line-order.html's popup module make real HTTP requests
// against it. The only thing stubbed is `window.fetch` redirecting a
// relative URL to `http://127.0.0.1:<port>` — the request/response body
// themselves are 100% real, produced by the actual route handlers and the
// actual database.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public/line-order.html');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup checkout REAL HTTP/DB integration (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3b-checkout-int-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3b-checkout';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;
  const jsdomWindows = [];

  try {
    // ── 真實店家、授權、商品、付款方式 ──────────────────────────
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_001', '脆豬腰', 'pro', 1, features]);
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); db._save(); } catch (e) {}
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES
      (9301, 'store_001', '整合測試排骨飯', '主食', 135, 1, 1, 1)`);
    db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES
      ('store_001', '現金', 'cash', 1, 1)`);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    db._save();

    // ── 真實 Express app（跟 server.js 相同掛載順序）─────────────
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
    async function call(method, urlPath, { token, body, query } = {}) {
      let url = `${base}${urlPath}`;
      if (query) url += `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const T1 = tokenFor('store_001');

    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }
    async function makeCampaign(name) {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
      await call('PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token: T1, body: { status: 'published' } });
      return r.json.data;
    }
    async function makeLocation(name) {
      const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name, address: name + ' Addr', lat: 25.05, lng: 121.55 } });
      return r.json.data;
    }
    async function makeSession(campaignId, locationId, overrides = {}) {
      const body = {
        campaign_id: campaignId, name: '整合測試場次', location_id: locationId, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        ...overrides,
      };
      const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body });
      if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
      await call('PATCH', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1, body: { expected_revision: r.json.data.revision, status: 'published' } });
      const fresh = await call('GET', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1 });
      return fresh.json.data;
    }

    // 建立這個整合測試專用的活動/場次（跟其他測試檔案的 fixture 完全隔離，
    // 用自己的溫度計 db + port，不會互相碰撞）。
    const campaign = await makeCampaign('整合測試活動');
    const location = await makeLocation('整合測試地點');
    const session = await makeSession(campaign.id, location.id, { max_orders: 1 }); // 刻意設 1，方便後面測真實 409 FULL

    // jsdom fetch stub：只是把相對路徑轉成真正的 http://127.0.0.1:<port> 網址，
    // 完全不假造 response——實際請求真的打到上面這個 Express app + sql.js DB。
    function makeRealFetchStub() {
      return (u, init) => {
        const urlStr = String(u);
        const target = urlStr.startsWith('http') ? urlStr : `${base}${urlStr}`;
        return fetch(target, init);
      };
    }

    async function createRealHarness(url) {
      const htmlSrc = fs.readFileSync(HTML_PATH, 'utf8');
      const virtualConsole = new VirtualConsole();
      const jsErrors = [];
      virtualConsole.on('jsdomError', (e) => jsErrors.push(e.message));
      const unhandled = [];
      const timeoutIds = [];
      const intervalIds = [];
      const dom = new JSDOM(htmlSrc, {
        url, runScripts: 'dangerously', resources: undefined, virtualConsole,
        beforeParse(window) {
          try { window.eval(fs.readFileSync(path.join(ROOT, 'public/js/phone-utils.js'), 'utf8')); } catch (e) {}
          window.fetch = makeRealFetchStub();
          window.WebSocket = class { constructor() { this.close = () => {}; this.send = () => {}; } };
          const origSetTimeout = window.setTimeout.bind(window);
          const origSetInterval = window.setInterval.bind(window);
          window.setTimeout = (fn, ms, ...args) => { const id = origSetTimeout(fn, ms, ...args); timeoutIds.push(id); return id; };
          window.setInterval = (fn, ms, ...args) => { const id = origSetInterval(fn, ms, ...args); intervalIds.push(id); return id; };
          window.addEventListener('error', (e) => unhandled.push('window error: ' + (e.message || '')));
          window.addEventListener('unhandledrejection', (e) => unhandled.push('window unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
        },
      });
      jsdomWindows.push(dom);
      return { dom, w: dom.window, jsErrors, unhandled, timeoutIds, intervalIds,
        cleanup() {
          try { timeoutIds.forEach((id) => { try { dom.window.clearTimeout(id); } catch (e) {} }); } catch (e) {}
          try { intervalIds.forEach((id) => { try { dom.window.clearInterval(id); } catch (e) {} }); } catch (e) {}
          try { dom.window.close(); } catch (e) {}
        },
      };
    }

    // ══════════════════════════════════════════════════════════════
    // 一、真實 checkout：frontend 產生 payload → 真實 POST → 真實 DB
    // ══════════════════════════════════════════════════════════════
    {
      const ctx = await createRealHarness(`http://localhost/popup-order?session=${session.public_code}`);
      try {
        const loaded = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 3000 });
        assert(loaded, '1-real-session-loads jsdom 頁面真的從 Express app 拿到 session 資料（不是 mock）', ctx.w.eval('popupError ? JSON.stringify(popupError) : "null"'));
        assert(ctx.w.eval('popupSession.public_code') === session.public_code, '1-real-session-code session public_code 正確', String(ctx.w.eval('popupSession.public_code')));
        const productFromFrontend = ctx.w.eval('popupProducts.find(p=>p.product_id===9301)');
        assert(!!productFromFrontend && productFromFrontend.price === 135, '1-real-price 前端顯示的價格就是後端資料庫裡的真實價格（135）', JSON.stringify(productFromFrontend));

        ctx.w.eval(`document.querySelector('#popupRoot li[data-product-id="9301"] button[aria-label*="增加"]').click();`);
        ctx.w.document.getElementById('popupCustomerName').value = '整合測試顧客';
        ctx.w.document.getElementById('popupCustomerName').dispatchEvent(new ctx.w.Event('input'));
        ctx.w.document.getElementById('popupCustomerPhone').value = '0911222333';
        ctx.w.document.getElementById('popupCustomerPhone').dispatchEvent(new ctx.w.Event('input'));
        const cashBtn = ctx.w.document.querySelector('#popupRoot [data-payment-code="cash"]');
        assert(!!cashBtn, '1-real-payment-rendered 後端回傳的 payment_methods 真的被渲染成按鈕', 'not found');
        cashBtn.click();

        const validOk = await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 500 });
        assert(validOk, '1-real-form-valid 表單填完後前端驗證通過', ctx.w.eval('JSON.stringify(popupValidateCheckout())'));

        ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
        const succeeded = await waitFor(() => ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), { timeoutMs: 3000 });
        assert(succeeded, '1-real-checkout-succeeds 真實 POST /popup-checkout 回 201，前端顯示成功畫面', ctx.w.document.getElementById('popupRoot').textContent.slice(0, 300));

        // 直接查真實 DB：不得只讀 201 的 data.id，先確認 response 結構本身（上面已確認畫面顯示成功），
        // 這裡再用真實資料庫驗證 order 與 allocation。
        const orderRow = db.get(`SELECT * FROM orders WHERE popup_session_id=? ORDER BY created_at DESC LIMIT 1`, [session.id]);
        assert(!!orderRow, '1-real-db-order-exists 真實 DB 裡確實新增了一筆 order', 'no row found');
        if (orderRow) {
          assert(orderRow.pickup_type === 'popup', '1-real-db-pickup-type order.pickup_type=popup', orderRow.pickup_type);
          assert(orderRow.popup_session_public_code_snapshot === session.public_code, '1-real-db-session-snapshot popup_session_public_code_snapshot 正確', orderRow.popup_session_public_code_snapshot);
          assert(orderRow.popup_campaign_name_snapshot === campaign.name, '1-real-db-campaign-snapshot popup_campaign_name_snapshot 正確', orderRow.popup_campaign_name_snapshot);
          assert(Number(orderRow.subtotal) === 135, '1-real-db-fresh-price order.subtotal 使用後端 fresh price（135），不是前端假造值', String(orderRow.subtotal));
          assert(orderRow.payment_method === 'cash', '1-real-db-payment-code order.payment_method=cash', orderRow.payment_method);
          assert(orderRow.customer_name === '整合測試顧客' && orderRow.customer_phone === '0911222333', '1-real-db-customer-fields 顧客姓名/電話正確存入', JSON.stringify({ name: orderRow.customer_name, phone: orderRow.customer_phone }));

          const allocRows = db.all('SELECT * FROM popup_order_allocations WHERE order_id=?', [orderRow.id]);
          assert(allocRows.length === 1 && allocRows[0].product_id === 9301 && allocRows[0].qty === 1 && allocRows[0].status === 'active', '1-real-db-allocation allocation 正確寫入（product 9301 x1, active）', JSON.stringify(allocRows));
        }

        assert(ctx.w.localStorage.getItem(`line_popup_cart_v1_${session.public_code}`) === null, '1-real-cart-cleared 前端成功後只清除當前 session 的 popup cart key', String(ctx.w.localStorage.getItem(`line_popup_cart_v1_${session.public_code}`)));
      } finally {
        await new Promise((r) => setTimeout(r, 150));
        assert(ctx.unhandled.length === 0 && ctx.jsErrors.length === 0, '1-real-no-unexpected-exceptions 整合測試過程沒有未預期例外', JSON.stringify(ctx.unhandled.concat(ctx.jsErrors)));
        ctx.cleanup();
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 二、真實 409：max_orders=1 已經在案例一用掉，這個場次現在真的滿了。
    // ══════════════════════════════════════════════════════════════
    {
      const ctx = await createRealHarness(`http://localhost/popup-order?session=${session.public_code}`);
      try {
        await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 3000 });
        ctx.w.eval(`document.querySelector('#popupRoot li[data-product-id="9301"] button[aria-label*="增加"]').click();`);
        ctx.w.document.getElementById('popupCustomerName').value = '第二位顧客';
        ctx.w.document.getElementById('popupCustomerName').dispatchEvent(new ctx.w.Event('input'));
        ctx.w.document.getElementById('popupCustomerPhone').value = '0922333444';
        ctx.w.document.getElementById('popupCustomerPhone').dispatchEvent(new ctx.w.Event('input'));
        const cashBtn2 = ctx.w.document.querySelector('#popupRoot [data-payment-code="cash"]');
        if (cashBtn2) cashBtn2.click();
        await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 500 });

        ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
        const gotError = await waitFor(() => {
          const t = ctx.w.document.getElementById('popupCheckoutErrorRegion');
          return t && t.textContent && t.textContent.length > 0;
        }, { timeoutMs: 3000 });
        assert(gotError, '2-real-409-shows-error 真實 409（場次已滿）時前端顯示錯誤訊息', ctx.w.document.getElementById('popupRoot').textContent.slice(0, 300));
        assert(ctx.w.eval('popupCart.items.length') > 0, '2-real-409-keeps-cart 真實 409 後保留購物車', String(ctx.w.eval('popupCart.items.length')));

        const orderCountAfter = db.get('SELECT COUNT(*) as c FROM orders WHERE popup_session_id=?', [session.id]).c;
        assert(orderCountAfter === 1, '2-real-409-no-extra-order 真實 DB 裡沒有因為這次被拒絕的請求多出一筆 order（還是只有案例一那 1 筆）', String(orderCountAfter));
      } finally {
        await new Promise((r) => setTimeout(r, 150));
        assert(ctx.unhandled.length === 0 && ctx.jsErrors.length === 0, '2-real-409-no-unexpected-exceptions 整合測試過程沒有未預期例外', JSON.stringify(ctx.unhandled.concat(ctx.jsErrors)));
        ctx.cleanup();
      }
    }
  } finally {
    jsdomWindows.forEach((dom) => { try { dom.window.close(); } catch (e) {} });
    if (server) { await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
