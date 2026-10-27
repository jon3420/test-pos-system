#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-admin-ui-browser.js
// H1.4.12 Phase 3C — REAL browser acceptance for 🚐 快閃取餐管理 (Playwright +
// real Chromium, not jsdom). No Canvas polyfill, no Leaflet stub, no manual
// currentFeatures override — real login/token/feature-gate flow, real
// Express + sql.js DB, real API calls throughout.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const results = [];
const seenNames = new Set();
function pass(name) {
  if (seenNames.has(name)) throw new Error('DUPLICATE assertion name: ' + name);
  seenNames.add(name);
  results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  if (seenNames.has(name)) throw new Error('DUPLICATE assertion name: ' + name);
  seenNames.add(name);
  results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3C popup admin UI REAL BROWSER (Playwright/Chromium) (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

const ARTIFACT_DIR = path.join(__dirname, 'qa-screenshots', 'h1-4-12-phase3c-admin-ui');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 },
];

async function main() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    fail('browser-tooling-available', 'playwright not resolvable: ' + e.message);
    printSummary();
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3c-browser-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3c-browser';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;
  let browser = null;
  const openContexts = [];

  try {
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','脆豬腰','pro',1,?)`, [features]);
    db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES ('store_002','Store2','Mgr2','pro',1)`);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_002','Store2','pro',1,?)`, [features]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES
      (9501, 'store_001', 'Chromium測試排骨飯', '主食', 135, 1, 1, 1)`);
    db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES ('store_001', '現金', 'cash', 1, 1)`);
    db._save();

    const jwt = require('jsonwebtoken');
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const T2 = jwt.sign({ role: 'store', store_id: 'store_002', store_name: 'store_002' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders(res) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    const { requireStore } = require('../middleware/storeGuard');
    const { requireFeature } = require('../middleware/featureGate');
    const lineOrderRouter = require('../routes/line-orders');
    app.use('/api/line-menu', requireStore, requireFeature('line_order'), (req, res, next) => { req.url = '/menu'; lineOrderRouter(req, res, next); });
    // 標準 LINE/POS 訂單的真正 endpoint：POST /api/line-orders（根路徑）。
    // 這個掛載順序完全比照 server.js：popup-public.js（store-blind）先掛，
    // 沒被它處理到的路徑（例如根路徑 POST /）才落到這個 requireStore 版本
    // 的 lineOrderRouter，不是另外猜一個路徑。
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), lineOrderRouter);
    app.use('/api/settings', requireStore, require('../routes/settings'));
    app.use('/api/products', requireStore, require('../routes/products'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    app.get('/api/store-me', requireStore, (req, res) => {
      try {
        const { getStoreFeatures } = require('../middleware/featureGate');
        const storeId = req.storeId || 'store_001';
        const row = db.get(`SELECT s.store_id, s.store_name, s.active, COALESCE(l.plan, 'basic') AS plan FROM stores s LEFT JOIN licenses l ON l.store_id = s.store_id WHERE s.store_id = ?`, [storeId]);
        if (!row) return res.status(404).json({ success: false, message: '店家不存在' });
        res.json({ success: true, data: { store_id: row.store_id, store_name: row.store_name, plan: row.plan, active: !!row.active, features: getStoreFeatures(storeId) } });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });
    app.get('/popup-order', (req, res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.sendFile(path.join(__dirname, '..', 'public', 'line-order.html')); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function call(method, urlPath, { token, body, query } = {}) {
      let url = `${base}${urlPath}`;
      if (query) url += `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }
    async function makeCampaign(name) {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
      if (r.status !== 201) throw new Error('makeCampaign failed: ' + JSON.stringify(r));
      const pub = await call('PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token: T1, body: { status: 'published' } });
      return pub.json.data;
    }
    async function makeLocation(name) {
      const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name, address: name + ' Addr', lat: 25.05, lng: 121.55 } });
      return r.json.data;
    }
    async function makeSession(campaignId, locationId, overrides = {}) {
      const body = { campaign_id: campaignId, name: 'Chromium測試場次', location_id: locationId, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`, ...overrides };
      const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body });
      if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
      return r.json.data;
    }
    async function publishSession(id, revision) {
      const r = await call('PATCH', `/api/popup-pickup/sessions/${id}`, { token: T1, body: { expected_revision: revision, status: 'published' } });
      return r.json.data;
    }

    // ── A–J 商品矩陣 fixture helper（H1.4.12 Phase 3C product_scope）──────
    const PROD_PREFIX = 'PM' + Date.now() + '_';
    // ── raw DB snapshot helper（H1.4.12 Phase 3C 稽核：查真實 row，不是
    //    只比對 session.order_count）。orders.items 是 JSON TEXT 欄位（不是
    //    獨立 table，已確認 utils/db.js schema），popup_order_allocations /
    //    order_logs 是獨立 table，欄位如下已核對 utils/db.js：
    //    allocations: id/store_id/session_id/order_id/product_id/qty/status
    //    order_logs:  id/store_id/order_id/order_number/action/reason...
    function rawSnapshot({ storeId, sessionId, productId, phoneMarker }) {
      const orderRows = db.all('SELECT id, store_id, items, subtotal, total FROM orders WHERE customer_phone=?', [phoneMarker]);
      const matchingOrderIds = orderRows.map((r) => r.id);
      const itemHits = orderRows.filter((r) => {
        try { return JSON.parse(r.items || '[]').some((it) => it.product_id === productId); } catch (e) { return false; }
      });
      const allocRows = db.all('SELECT id, store_id, session_id, order_id, product_id, qty, status FROM popup_order_allocations WHERE session_id=? AND product_id=?', [sessionId, productId]);
      const logRows = matchingOrderIds.length ? db.all(`SELECT id, order_id, action FROM order_logs WHERE order_id IN (${matchingOrderIds.map(() => '?').join(',') || "''"})`, matchingOrderIds) : [];
      return { orderIds: matchingOrderIds, itemHitCount: itemHits.length, allocRows, logRows };
    }

    async function createProductMatrix() {
      async function mk(nameSuffix, body, lineSettings) {
        const r = await call('POST', '/api/products', { token: T1, body: { name: PROD_PREFIX + nameSuffix, category: '測試', price: 100, ...body } });
        if (r.status !== 201) throw new Error('create product failed: ' + JSON.stringify(r));
        const id = r.json.data.id;
        if (lineSettings) {
          const ls = await call('PATCH', `/api/products/${id}/line-settings`, { token: T1, body: lineSettings });
          if (ls.status !== 200) throw new Error('line-settings failed for ' + nameSuffix + ': ' + JSON.stringify(ls));
        }
        return id;
      }
      const ids = {};
      ids.A = await mk('A合格', {}, { line_name: PROD_PREFIX + 'A的LINE名稱', line_price: 120, show_on_line: 1, line_takeout_enabled: 1 });
      ids.B = await mk('B空白名fallback', {}, { line_name: '', line_price: 130, show_on_line: 1, line_takeout_enabled: 1 });
      ids.C = await mk('C價格fallback', { price: 100, takeaway_price: 110 }, { line_name: PROD_PREFIX + 'C', line_price: null, show_on_line: 1, line_takeout_enabled: 1 });
      ids.D = await mk('D零元fallback', { price: 100, takeaway_price: 105 }, { line_name: PROD_PREFIX + 'D', line_price: 0, show_on_line: 1, line_takeout_enabled: 1 });
      ids.E = await mk('E已停用', {}, { line_name: PROD_PREFIX + 'E', line_price: 100, show_on_line: 1, line_takeout_enabled: 1 });
      await call('PUT', `/api/products/${ids.E}`, { token: T1, body: { enabled: 0 } });
      ids.F = await mk('F未上架', {}, { line_name: PROD_PREFIX + 'F', line_price: 100, show_on_line: 0, line_takeout_enabled: 1 });
      ids.G = await mk('G外帶關閉', {}, { line_name: PROD_PREFIX + 'G', line_price: 100, show_on_line: 1, line_takeout_enabled: 0, line_delivery_enabled: 1 });
      ids.H = await mk('H今日完售', {}, { line_name: PROD_PREFIX + 'H', line_price: 100, show_on_line: 1, line_takeout_enabled: 1, sale_status: 'sold_out_today' });
      ids.I = await mk('I手動售完', {}, { line_name: PROD_PREFIX + 'I', line_price: 100, show_on_line: 1, line_takeout_enabled: 1, line_sold_out: 1 });
      // J：另一店家的合格商品——用 store_002 的 JWT 呼叫同一組 API
      const jRes = await call('POST', '/api/products', { token: T2, body: { name: PROD_PREFIX + 'J跨店', category: '測試', price: 100 } });
      ids.J = jRes.json.data.id;
      await call('PATCH', `/api/products/${ids.J}/line-settings`, { token: T2, body: { line_name: PROD_PREFIX + 'J', line_price: 100, show_on_line: 1, line_takeout_enabled: 1 } });
      return ids;
    }
    async function deleteProductMatrix(ids) {
      for (const key of Object.keys(ids)) {
        const tok = key === 'J' ? T2 : T1;
        await call('DELETE', `/api/products/${ids[key]}`, { token: tok }).catch(() => {});
      }
    }

    browser = await chromium.launch();

    const KNOWN_EXTERNAL_ABORT_HOSTS = ['fonts.googleapis.com', 'unpkg.com'];
    // pathname(不含 query) -> 原因，只有明確列在這裡的同源 404 才算「已知、
    // 跟本功能無關」；任何不在清單上的同源 404/4xx/5xx 一律讓案例 FAIL。
    const KNOWN_404_ALLOWLIST = {
      '/api/categories': '既有分類 widget，跟快閃取餐無關，這支測試 server 未掛載',
      '/api/discount-campaigns': '既有折扣活動 widget，跟快閃取餐無關',
      '/api/discount-categories': '既有折扣分類 widget，跟快閃取餐無關',
      '/api/product-analysis-groups': '既有商品分析群組 widget，跟快閃取餐無關',
      '/api/coupons': '既有優惠券 widget，跟快閃取餐無關',
      '/api/orders': '既有訂單列表/即時 widget，跟快閃取餐無關',
    };
    const GUARDED_API_PREFIXES = ['/api/popup-pickup', '/api/settings', '/api/store-me'];

    // 共用：開一個已「登入」的 admin context（真實 token 流程：先塞
    // localStorage，導覽後由頁面自己的 ensureLogin() 打 /api/store-me）。
    async function newAdminPage(opts = {}) {
      const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
      openContexts.push(context);
      const page = await context.newPage();
      const pageErrors = []; const consoleErrors = []; const dialogs = []; const unexpectedDialogs = [];
      const failedSameOrigin = []; const externalHosts = []; const unknownSame4xx5xx = []; const unexpectedExternalHosts = [];
      const requestLog = []; // [{method, pathname, status}]
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      const h = {
        context, page, pageErrors, consoleErrors, dialogs, unexpectedDialogs, failedSameOrigin, externalHosts,
        unknownSame4xx5xx, requestLog, unexpectedExternalHosts,
        _dialogExpectation: null,
        _expectedApiErrors: [], // [{method, pathname}] — 這次呼叫允許回非 2xx，不算 unknownSame4xx5xx
        // 案例呼叫這個來「預期」下一個 dialog：驗證 type 與 message 關鍵字，
        // 用完自動消耗（重設為 null），不會污染下一個案例。
        expectDialog(action, { typeContains, messageContains, promptText } = {}) {
          this._dialogExpectation = { action, typeContains, messageContains, promptText, matched: false };
        },
        expectApiError(method, pathname) { this._expectedApiErrors.push({ method, pathname }); },
      };
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        const exp = h._dialogExpectation;
        h._dialogExpectation = null; // 用一次就消耗掉，避免污染下一次
        if (!exp) {
          unexpectedDialogs.push({ type: d.type(), message: d.message() });
          d.dismiss().catch(() => {});
          return;
        }
        const typeOk = !exp.typeContains || d.type().includes(exp.typeContains);
        const msgOk = !exp.messageContains || d.message().includes(exp.messageContains);
        if (!typeOk || !msgOk) unexpectedDialogs.push({ type: d.type(), message: d.message(), expected: exp });
        (exp.action === 'accept' ? d.accept(exp.promptText) : d.dismiss()).catch(() => {});
      });
      page.on('requestfailed', (req) => { const u = req.url(); if (u.startsWith(base)) failedSameOrigin.push(u + ' :: ' + (req.failure() && req.failure().errorText)); });
      page.on('response', (res) => {
        const url = res.url();
        if (!url.startsWith(base)) return;
        const u = new URL(url);
        const method = res.request().method();
        const status = res.status();
        requestLog.push({ method, pathname: u.pathname, status });
        if (status < 400) return;
        if (status === 404 && KNOWN_404_ALLOWLIST[u.pathname]) return; // 已知、跟本功能無關
        const isGuarded = GUARDED_API_PREFIXES.some((p) => u.pathname.startsWith(p));
        const expectedIdx = h._expectedApiErrors.findIndex((e) => e.method === method && e.pathname === u.pathname);
        if (expectedIdx !== -1) { h._expectedApiErrors.splice(expectedIdx, 1); return; } // 這次案例明確預期這個錯誤
        if (isGuarded || !KNOWN_404_ALLOWLIST[u.pathname]) unknownSame4xx5xx.push(`${method} ${u.pathname} -> ${status}`);
      });
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(base) || u.startsWith('about:') || u.startsWith('data:')) return route.continue();
        let host; try { host = new URL(u).hostname; } catch (e) { host = null; }
        externalHosts.push(u);
        if (!KNOWN_EXTERNAL_ABORT_HOSTS.includes(host)) unexpectedExternalHosts.push(u);
        return route.abort();
      });
      await page.addInitScript((token) => { window.localStorage.setItem('pos_store_token', token); window.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001' })); }, T1);
      h.close = async () => { try { await page.close(); } catch (e) {} try { await context.close(); } catch (e) {} };
      return h;
    }

    // ══════════════════════════════════════════════════════════════
    // 一、真實登入與功能閘門
    // ══════════════════════════════════════════════════════════════
    {
      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        const navVisible = await h.page.locator('#nav-btn-popup_pickup').isVisible();
        assert(navVisible, 'BR1-nav-visible-with-feature 真實登入後 line_order feature 開啟時，🚐 快閃取餐 nav 可見');
        await h.page.click('#nav-btn-popup_pickup');
        await h.page.waitForSelector('#page-popup_pickup', { state: 'visible' });
        const pageVisible = await h.page.locator('#page-popup_pickup').isVisible();
        assert(pageVisible, 'BR2-nav-click-enters-page 點擊 nav 後真的進入 popup_pickup 頁');
        // 404/4xx/5xx 的允許清單、guarded API 判斷、外部 host 判斷都已經在
        // newAdminPage() 的 response/route handler 裡集中處理，這裡只要看
        // 累積結果就好，不在每個案例重複寫一次 allowlist。
        const genuinelyUnexpected = h.consoleErrors.filter((m) =>
          !/net::ERR_FAILED/.test(m) && // 我們自己用 route.abort() 擋掉外部資源造成的預期噪音
          !/ws:\/\/127\.0\.0\.1/.test(m) && // 既有、跟 popup-pickup 無關的即時訂單 WebSocket（這個測試環境沒有掛載對應後端）
          !/status of 404/.test(m) // 404 已經用 unknownSame4xx5xx 精確比對 URL+method，這裡不重複判斷
        );
        assert(
          h.pageErrors.length === 0 && genuinelyUnexpected.length === 0 && h.unknownSame4xx5xx.length === 0 && h.unexpectedExternalHosts.length === 0,
          'BR3-no-errors-on-entry 進入頁面過程沒有 pageerror、沒有非預期的 console error、沒有 guarded API 以外未預期的 4xx/5xx、也沒有允許清單以外的外部 host',
          JSON.stringify({ pageErrors: h.pageErrors, genuinelyUnexpected, unknownSame4xx5xx: h.unknownSame4xx5xx, unexpectedExternalHosts: h.unexpectedExternalHosts }).slice(0, 500)
        );
      } finally { await h.close(); }
    }
    {
      db._db.run("UPDATE settings SET value='0' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        const navVisible = await h.page.locator('#nav-btn-popup_pickup').isVisible();
        assert(navVisible, 'BR4-nav-visible-regardless-of-toggle nav 本身只受 line_order feature 控制，跟 popup_pickup_enabled 總開關無關，仍可見');
        await h.page.click('#nav-btn-popup_pickup');
        await h.page.waitForSelector('#ppa-disabled-banner', { state: 'visible', timeout: 5000 });
        const bannerVisible = await h.page.locator('#ppa-disabled-banner').isVisible();
        assert(bannerVisible, 'BR5-disabled-banner-shown 總開關關閉時，直接切入頁面顯示停用提示');
        await h.page.click('#ppa-disabled-banner button');
        await h.page.waitForSelector('#page-settings', { state: 'visible' });
        await h.page.waitForFunction(() => { const c = document.getElementById('ppaEnabledCard'); return c && getComputedStyle(c).outline !== 'none' && getComputedStyle(c).outline !== ''; }, { timeout: 3000 }).catch(() => {});
        const cardInView = await h.page.locator('#ppaEnabledCard').isVisible();
        assert(cardInView, 'BR6-goto-settings-lands-on-real-card 「前往開啟」切到 Settings 並顯示真正的控制卡（非空白頁）');
      } finally { await h.close(); }
      db._db.run("UPDATE settings SET value='1' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
    }

    // Settings toggle：取消 0 次 PUT／確認恰好 1 次 PUT／雙擊不重複
    {
      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('settings'); switchSettingsTab('line_entry'); });
        await h.page.waitForFunction(() => document.getElementById('ppaEnabledContent') && !document.getElementById('ppaEnabledContent').textContent.includes('載入中'), { timeout: 5000 });
        let putCount = 0;
        await h.page.route(`${base}/api/settings`, (route) => { if (route.request().method() === 'PUT') putCount++; return route.continue(); });
        h.expectDialog('dismiss', { typeContains: 'confirm', messageContains: '關閉' });
        await h.page.click('#ppaEnabledToggleBtn');
        await h.page.waitForTimeout(300);
        assert(putCount === 0, 'BR7-settings-cancel-zero-put 取消確認對話框時完全沒有送出 PUT', String(putCount));

        h.expectDialog('accept', { typeContains: 'confirm', messageContains: '關閉' });
        await h.page.click('#ppaEnabledToggleBtn');
        await h.page.waitForTimeout(500);
        assert(putCount === 1, 'BR8-settings-confirm-one-put 確認後恰好送出 1 次 PUT', String(putCount));
        assert(h.unexpectedDialogs.length === 0, 'BR8b-settings-dialog-type-and-message-verified 兩次 confirm dialog 的 type 與訊息關鍵字都符合預期，沒有非預期 dialog', JSON.stringify(h.unexpectedDialogs));
      } finally { await h.close(); }
      // BR8 的確認點擊是一次真實 PUT，會把 popup_pickup_enabled 真的關掉；
      // 後面所有場次/checkout 案例都依賴它是開的，這裡測試隔離要負責復原。
      db._db.run("UPDATE settings SET value='1' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
    }

    // ══════════════════════════════════════════════════════════════
    // 二、四個 tab 的真實 UI/API 流程
    // ══════════════════════════════════════════════════════════════
    {
      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => showPage('popup_pickup'));
        await h.page.waitForFunction(() => !document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));

        // 活動：建立、編輯、發布
        await h.page.click('#ppa-btn-new-campaign');
        await h.page.fill('#ppa-campaign-name', 'BR真實瀏覽器活動');
        // R42：BR9 hard predicate — click 前註冊的精確 POST response、201/success/id/name/draft、store-scoped detail readback、exact row、modal 關閉、無 pageerror。
        const br9Name = 'BR真實瀏覽器活動';
        const isBr9Post = (method, url) => method === 'POST' && new URL(url).pathname === '/api/popup-pickup/campaigns';
        let br9PostCount = 0;
        const onBr9Request = (req) => { if (isBr9Post(req.method(), req.url())) br9PostCount++; };
        h.page.on('request', onBr9Request);
        const br9ResponsePromise = h.page.waitForResponse((r) => isBr9Post(r.request().method(), r.url()), { timeout: 10000 }).then((r) => r, () => null);
        let br9ClickError = null;
        try {
          await h.page.click('#ppa-campaign-save-btn', { timeout: 5000 });
        } catch (e) {
          br9ClickError = (e && e.name) ? String(e.name) : 'Error';
        }
        const br9Response = await br9ResponsePromise;
        let br9Json = null;
        if (br9Response) { try { br9Json = await br9Response.json(); } catch (e) { br9Json = null; } }
        const br9ModalClosed = await h.page.waitForFunction(() => { const m = document.getElementById('ppa-modal-campaign'); return !!m && getComputedStyle(m).display === 'none'; }, null, { timeout: 5000 }).then(() => true, () => false);
        const br9ListWaited = await h.page.waitForFunction(() => document.getElementById('ppa-campaigns-tbody').textContent.includes('BR真實瀏覽器活動'), null, { timeout: 5000 }).then(() => true, () => false);
        h.page.off('request', onBr9Request);
        const br9Data = br9Json && br9Json.data ? br9Json.data : null;
        const br9Id = br9Data && typeof br9Data.id === 'string' && br9Data.id.length > 0 ? br9Data.id : null;
        const br9Readback = br9Id ? await call('GET', `/api/popup-pickup/campaigns/${encodeURIComponent(br9Id)}`, { token: T1 }) : null;
        const br9Rb = br9Readback && br9Readback.json && br9Readback.json.data ? br9Readback.json.data : null;
        const br9Row = h.page.locator('#ppa-campaigns-tbody tr', { hasText: br9Name });
        const br9RowCount = await br9Row.count();
        const br9RowText = br9RowCount === 1 ? await br9Row.textContent() : '';
        const br9Detail = {
          clickOk: br9ClickError === null,
          postOnce: br9PostCount === 1,
          responseStatus: br9Response ? br9Response.status() : null,
          success: !!(br9Json && br9Json.success === true),
          idPresent: br9Id !== null,
          nameExact: !!br9Data && br9Data.name === br9Name,
          statusExact: !!br9Data && br9Data.status === 'draft',
          readbackStatus: br9Readback ? br9Readback.status : null,
          readbackExact: !!br9Rb && br9Readback.json.success === true && br9Rb.id === br9Id && br9Rb.name === br9Name && br9Rb.status === 'draft',
          rowCount: br9RowCount,
          rowShowsName: br9RowText.includes(br9Name),
          listWaited: br9ListWaited,
          modalClosed: br9ModalClosed,
          pageErrorCount: h.pageErrors.length,
        };
        assert(
          br9Detail.clickOk && br9Detail.postOnce && br9Detail.responseStatus === 201 && br9Detail.success && br9Detail.idPresent && br9Detail.nameExact && br9Detail.statusExact
            && br9Detail.readbackStatus === 200 && br9Detail.readbackExact && br9Detail.rowCount === 1 && br9Detail.rowShowsName && br9Detail.listWaited && br9Detail.modalClosed && br9Detail.pageErrorCount === 0,
          'BR9-campaign-create-via-ui 真實透過 UI 建立活動成功並出現在列表',
          JSON.stringify(br9Detail),
        );

        const row = h.page.locator('#ppa-campaigns-tbody tr', { hasText: 'BR真實瀏覽器活動' });
        // R42：BR10 hard predicate — click 前註冊的精確 PATCH response（同 BR9 id）、200/success/name/published、fresh detail readback、exact row 已發布、無 pageerror。
        const isBr10Patch = (method, url) => method === 'PATCH' && br9Id !== null && new URL(url).pathname === `/api/popup-pickup/campaigns/${br9Id}`;
        let br10PatchCount = 0;
        let br10BodyPublished = false;
        const onBr10Request = (req) => {
          if (!isBr10Patch(req.method(), req.url())) return;
          br10PatchCount++;
          try { br10BodyPublished = JSON.parse(req.postData() || 'null').status === 'published'; } catch (e) { br10BodyPublished = false; }
        };
        h.page.on('request', onBr10Request);
        const br10ResponsePromise = h.page.waitForResponse((r) => isBr10Patch(r.request().method(), r.url()), { timeout: 10000 }).then((r) => r, () => null);
        let br10ClickError = null;
        try {
          await row.locator('button', { hasText: '發布' }).click({ timeout: 5000 });
        } catch (e) {
          br10ClickError = (e && e.name) ? String(e.name) : 'Error';
        }
        const br10Response = await br10ResponsePromise;
        let br10Json = null;
        if (br10Response) { try { br10Json = await br10Response.json(); } catch (e) { br10Json = null; } }
        const br10ListWaited = await h.page.waitForFunction(() => { const t = document.getElementById('ppa-campaigns-tbody').textContent; return t.includes('BR真實瀏覽器活動') && t.includes('已發布'); }, null, { timeout: 5000 }).then(() => true, () => false);
        h.page.off('request', onBr10Request);
        const br10Data = br10Json && br10Json.data ? br10Json.data : null;
        const br10Readback = br9Id ? await call('GET', `/api/popup-pickup/campaigns/${encodeURIComponent(br9Id)}`, { token: T1 }) : null;
        const br10Rb = br10Readback && br10Readback.json && br10Readback.json.data ? br10Readback.json.data : null;
        const br10Row = h.page.locator('#ppa-campaigns-tbody tr', { hasText: br9Name });
        const br10RowCount = await br10Row.count();
        const br10RowText = br10RowCount === 1 ? await br10Row.textContent() : '';
        const br10Detail = {
          clickOk: br10ClickError === null,
          patchOnce: br10PatchCount === 1,
          bodyPublished: br10BodyPublished,
          responseStatus: br10Response ? br10Response.status() : null,
          success: !!(br10Json && br10Json.success === true),
          idExact: !!br10Data && br9Id !== null && br10Data.id === br9Id,
          nameExact: !!br10Data && br10Data.name === br9Name,
          statusExact: !!br10Data && br10Data.status === 'published',
          readbackStatus: br10Readback ? br10Readback.status : null,
          readbackExact: !!br10Rb && br10Readback.json.success === true && br10Rb.id === br9Id && br10Rb.name === br9Name && br10Rb.status === 'published',
          rowCount: br10RowCount,
          rowShowsName: br10RowText.includes(br9Name),
          rowShowsPublished: br10RowText.includes('已發布'),
          listWaited: br10ListWaited,
          pageErrorCount: h.pageErrors.length,
        };
        assert(
          br10Detail.clickOk && br10Detail.patchOnce && br10Detail.bodyPublished && br10Detail.responseStatus === 200 && br10Detail.success && br10Detail.idExact && br10Detail.nameExact && br10Detail.statusExact
            && br10Detail.readbackStatus === 200 && br10Detail.readbackExact && br10Detail.rowCount === 1 && br10Detail.rowShowsName && br10Detail.rowShowsPublished && br10Detail.listWaited && br10Detail.pageErrorCount === 0,
          'BR10-campaign-publish-via-ui 真實透過 UI 點擊發布，狀態變成已發布',
          JSON.stringify(br10Detail),
        );

        // 封存後 Edit 真正 disabled（ppaCampaignSetStatus 本身不彈 confirm，這裡不需要處理 dialog）
        await row.locator('button', { hasText: '封存' }).click().catch(() => {});
        await h.page.waitForTimeout(400);
        const archivedRow = h.page.locator('#ppa-campaigns-tbody tr', { hasText: 'BR真實瀏覽器活動' });
        const editBtn = archivedRow.locator('button', { hasText: '編輯' });
        const isDisabled = await editBtn.isDisabled();
        assert(isDisabled, 'BR11-archived-edit-really-disabled 封存後編輯按鈕在真實瀏覽器中是真正的 disabled 屬性（不能點擊）');

        // 地點：建立、複製地址
        await h.page.click('#ppa-tabbtn-locations');
        await h.page.click('#ppa-btn-new-location');
        await h.page.fill('#ppa-location-name', 'BR真實地點');
        await h.page.fill('#ppa-location-address', '台北市測試路1號');
        // R42（owner option (a)）：BR12 hard predicate — click 前註冊的精確 POST response、201/success/id/name/address、既有 store-scoped
        // GET /api/popup-pickup/locations?limit=500 依建立回應 id 精確篩選恰好一筆（id/name/address/active）、exact row、modal 關閉、無 pageerror。
        const br12Name = 'BR真實地點';
        const br12Address = '台北市測試路1號';
        const isBr12Post = (method, url) => method === 'POST' && new URL(url).pathname === '/api/popup-pickup/locations';
        let br12PostCount = 0;
        const onBr12Request = (req) => { if (isBr12Post(req.method(), req.url())) br12PostCount++; };
        h.page.on('request', onBr12Request);
        const br12ResponsePromise = h.page.waitForResponse((r) => isBr12Post(r.request().method(), r.url()), { timeout: 10000 }).then((r) => r, () => null);
        let br12ClickError = null;
        try {
          await h.page.click('#ppa-location-save-btn', { timeout: 5000 });
        } catch (e) {
          br12ClickError = (e && e.name) ? String(e.name) : 'Error';
        }
        const br12Response = await br12ResponsePromise;
        let br12Json = null;
        if (br12Response) { try { br12Json = await br12Response.json(); } catch (e) { br12Json = null; } }
        const br12ModalClosed = await h.page.waitForFunction(() => { const m = document.getElementById('ppa-modal-location'); return !!m && getComputedStyle(m).display === 'none'; }, null, { timeout: 5000 }).then(() => true, () => false);
        const br12ListWaited = await h.page.waitForFunction(() => document.getElementById('ppa-locations-tbody').textContent.includes('BR真實地點'), null, { timeout: 5000 }).then(() => true, () => false);
        h.page.off('request', onBr12Request);
        const br12Data = br12Json && br12Json.data ? br12Json.data : null;
        const br12Id = br12Data && typeof br12Data.id === 'string' && br12Data.id.length > 0 ? br12Data.id : null;
        const br12List = await call('GET', '/api/popup-pickup/locations', { token: T1, query: { limit: '500' } });
        const br12ListArray = !!(br12List.json && Array.isArray(br12List.json.data));
        const br12Rows = br12Id && br12ListArray ? br12List.json.data.filter((r) => r.id === br12Id) : [];
        const br12UiRows = await h.page.evaluate(({ n, a }) => [...document.querySelectorAll('#ppa-locations-tbody tr')].filter((tr) => tr.cells.length >= 2 && tr.cells[0].textContent === n && tr.cells[1].textContent === a).length, { n: br12Name, a: br12Address });
        const br12Detail = {
          clickOk: br12ClickError === null,
          postOnce: br12PostCount === 1,
          responseStatus: br12Response ? br12Response.status() : null,
          success: !!(br12Json && br12Json.success === true),
          idPresent: br12Id !== null,
          nameExact: !!br12Data && br12Data.name === br12Name,
          addressExact: !!br12Data && br12Data.address === br12Address,
          readbackStatus: br12List.status,
          readbackSuccess: !!(br12List.json && br12List.json.success === true),
          readbackArray: br12ListArray,
          readbackCount: br12Rows.length,
          readbackExact: br12Rows.length === 1 && br12Rows[0].id === br12Id && br12Rows[0].name === br12Name && br12Rows[0].address === br12Address,
          activeExact: br12Rows.length === 1 && Number(br12Rows[0].active) === 1,
          rowCount: br12UiRows,
          listWaited: br12ListWaited,
          modalClosed: br12ModalClosed,
          pageErrorCount: h.pageErrors.length,
        };
        assert(
          br12Detail.clickOk && br12Detail.postOnce && br12Detail.responseStatus === 201 && br12Detail.success && br12Detail.idPresent && br12Detail.nameExact && br12Detail.addressExact
            && br12Detail.readbackStatus === 200 && br12Detail.readbackSuccess && br12Detail.readbackArray && br12Detail.readbackCount === 1 && br12Detail.readbackExact && br12Detail.activeExact
            && br12Detail.rowCount === 1 && br12Detail.listWaited && br12Detail.modalClosed && br12Detail.pageErrorCount === 0,
          'BR12-location-create-via-ui 真實透過 UI 建立地點成功',
          JSON.stringify(br12Detail),
        );

        await h.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const locRow = h.page.locator('#ppa-locations-tbody tr', { hasText: 'BR真實地點' });
        await locRow.locator('button', { hasText: '複製地址' }).click();
        const clip = await h.page.evaluate(() => navigator.clipboard.readText());
        assert(clip.includes('台北市測試路1號'), 'BR13-copy-address-real-clipboard 複製地址按鈕真的把地址寫進瀏覽器剪貼簿', clip);

        // Google Maps 開啟只因使用者點擊、noopener
        // R23 B-A0：觀察 production 實際要求瀏覽器開啟的 URL（click 前在 context 註冊 route，攔截 popup 的
        // 初始 navigation 並以本機最小 HTML fulfill，不需 DNS／外網），而不是 popup 真實導航後的最終 URL。
        // 本地點只填地址、未填座標，ppaOpenMap() 的 query 即為地址。
        const mapNavUrls = [];
        const mapRouteHandler = (route) => {
          const rq = route.request();
          // 不呼叫 rq.frame()：popup 的初始 navigation 在 frame 建立前發出，frame() 會丟錯（R23 B attempt 1）。
          // opener 頁的請求由其 page-scoped catch-all route 先處理，不會進到這個 context route。
          if (rq.isNavigationRequest() && rq.resourceType() === 'document' && !rq.url().startsWith(base)) {
            mapNavUrls.push(rq.url());
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>map</title>' });
          }
          return route.continue();
        };
        await h.context.route('**/*', mapRouteHandler);
        const [popup] = await Promise.all([
          h.page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null),
          locRow.locator('button', { hasText: '開啟地圖' }).click(),
        ]);
        if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
        let mapUrl = null;
        try { mapUrl = mapNavUrls.length === 1 ? new URL(mapNavUrls[0]) : null; } catch (e) { mapUrl = null; }
        const mapDetail = JSON.stringify({ popup: !!popup, hits: mapNavUrls.length, url: mapNavUrls[0] || null,
          protocol: mapUrl && mapUrl.protocol, host: mapUrl && mapUrl.hostname, path: mapUrl && mapUrl.pathname,
          api: mapUrl && mapUrl.searchParams.get('api'), query: mapUrl && mapUrl.searchParams.get('query') });
        if (popup) {
          assert(mapNavUrls.length === 1 && !!mapUrl && mapUrl.protocol === 'https:' && mapUrl.hostname === 'www.google.com'
            && mapUrl.pathname === '/maps/search/' && mapUrl.searchParams.get('api') === '1'
            && mapUrl.searchParams.get('query') === '台北市測試路1號',
          'BR14-map-url-https-google-maps 開啟地圖的網址是 HTTPS Google Maps', mapDetail);
          await popup.close().catch(() => {});
        } else {
          assert(false, 'BR14-map-url-https-google-maps 開啟地圖的網址是 HTTPS Google Maps', mapDetail);
        }
        await h.context.unroute('**/*', mapRouteHandler).catch(() => {});
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 三、場次 single create/edit + revision conflict + affected-orders
    //     confirm + order_count/checkout parity + inactive-location snapshot
    //     每個情境使用自己獨立的 fixture（唯一名稱/public_code），不依賴
    //     前一案例殘留的 id 或「第一列」。
    // ══════════════════════════════════════════════════════════════
    {
      const campS = await makeCampaign('SLICE2-場次活動-' + Date.now());
      const locA = await makeLocation('SLICE2-地點A-' + Date.now());
      const locB = await makeLocation('SLICE2-地點B-' + Date.now());

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => showPage('popup_pickup'));
        await h.page.evaluate(() => ppaSwitchTab('sessions'));
        await h.page.waitForFunction(() => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));

        // ── 單一場次建立 ──────────────────────────────────────────
        let sessionPostCount = 0; let lastSessionPostBody = null;
        await h.page.route(`${base}/api/popup-pickup/sessions`, (route) => {
          if (route.request().method() === 'POST') { sessionPostCount++; lastSessionPostBody = route.request().postDataJSON(); }
          return route.continue();
        });
        const uniqueSessionName = 'SLICE2單場次-' + Date.now();
        await h.page.click('button:has-text("＋ 新增場次")');
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible', timeout: 5000 });
        await h.page.waitForFunction(() => document.getElementById('ppa-session-campaign').options.length > 0, { timeout: 5000 });
        await h.page.selectOption('#ppa-session-campaign', campS.id);
        await h.page.fill('#ppa-session-name', uniqueSessionName);
        await h.page.selectOption('#ppa-session-location', locA.id);
        await h.page.fill('#ppa-session-date', taipeiDateStr(3));
        await h.page.fill('#ppa-session-start', '10:00');
        await h.page.fill('#ppa-session-end', '20:00');
        await h.page.fill('#ppa-session-order-open', `${taipeiDateStr(0)}T00:00`);
        await h.page.fill('#ppa-session-order-cutoff', `${taipeiDateStr(3)}T09:00`);
        await h.page.fill('#ppa-session-max-orders', '1');
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), uniqueSessionName, { timeout: 5000 });
        assert(sessionPostCount === 1, 'BR15-session-create-single-post 單一場次建立真實 POST 恰好 1 次', String(sessionPostCount));

        const listed = await call('GET', '/api/popup-pickup/sessions', { token: T1, query: { campaign_id: campS.id } });
        const created = listed.json.data.find((s) => s.name === uniqueSessionName);
        assert(!!created && created.location_id === locA.id && created.max_orders === 1, 'BR16-session-db-consistent 建立後 GET API/DB 資料與 UI 輸入一致', JSON.stringify(created));

        // ── 編輯：只改名稱，payload 檢查 ──────────────────────────
        let sessionPatchCount = 0; let lastPatchBody = null; let lastPatchPathname = null;
        await h.page.route(`${base}/api/popup-pickup/sessions/${created.id}`, (route) => {
          if (route.request().method() === 'PATCH') { sessionPatchCount++; lastPatchBody = route.request().postDataJSON(); lastPatchPathname = new URL(route.request().url()).pathname; }
          return route.continue();
        });
        const row1 = h.page.locator('#ppa-sessions-tbody tr', { hasText: uniqueSessionName });
        await row1.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        const renamedTo = uniqueSessionName + '-已改名';
        await h.page.fill('#ppa-session-name', renamedTo);
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), renamedTo, { timeout: 5000 });
        assert(sessionPatchCount === 1, 'BR17-session-edit-single-patch 編輯場次名稱真實 PATCH 恰好 1 次', String(sessionPatchCount));
        assert(lastPatchBody && typeof lastPatchBody.expected_revision === 'number', 'BR18-session-patch-has-expected-revision PATCH payload 帶正確 expected_revision', JSON.stringify(lastPatchBody));
        const forbiddenKeys = ['price', 'subtotal', 'total', 'store_id', 'public_code'];
        const hasForbidden = lastPatchBody && forbiddenKeys.some((k) => k in lastPatchBody);
        assert(!hasForbidden, 'BR19-session-patch-no-forbidden-fields PATCH payload 不含 price/subtotal/total/store_id/public_code', JSON.stringify(lastPatchBody));

        // ── 重複點擊儲存只送一次、按鈕 pending 中真正 disabled ─────
        const row2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: renamedTo });
        await row2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        sessionPatchCount = 0;
        await h.page.fill('#ppa-session-name', renamedTo + '-x');
        await h.page.evaluate(() => {
          const btn = document.getElementById('ppa-session-save-btn');
          btn.click(); btn.click();
        });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), renamedTo + '-x', { timeout: 5000 });
        assert(sessionPatchCount === 1, 'BR20-session-double-click-single-mutation 快速連點儲存仍只送出 1 次 mutation', String(sessionPatchCount));

        // ── API 失敗：modal 保留、輸入不消失、按鈕恢復 ─────────────
        const row3 = h.page.locator('#ppa-sessions-tbody tr', { hasText: renamedTo + '-x' });
        await row3.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.route(`${base}/api/popup-pickup/sessions/${created.id}`, (route) => {
          if (route.request().method() === 'PATCH') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '測試用強制失敗' }) });
          return route.continue();
        });
        h.expectApiError('PATCH', `/api/popup-pickup/sessions/${created.id}`);
        const failName = renamedTo + '-should-fail';
        await h.page.fill('#ppa-session-name', failName);
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForTimeout(400);
        const modalStillOpen = await h.page.locator('#ppa-modal-session').isVisible();
        const nameStillThere = await h.page.inputValue('#ppa-session-name');
        const btnText = await h.page.locator('#ppa-session-save-btn').textContent();
        assert(modalStillOpen && nameStillThere === failName && btnText.trim() === '儲存', 'BR21-session-patch-failure-recovers API 失敗時 modal 保留、使用者輸入不消失、按鈕恢復（不停留在儲存中）', JSON.stringify({ modalStillOpen, nameStillThere, btnText }));
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")');
      } finally { await h.close(); }
    }

    // ── revision conflict：用真實 API 在 UI 之外把 revision 推進一次 ──
    {
      const campR = await makeCampaign('SLICE2-衝突活動-' + Date.now());
      const locR = await makeLocation('SLICE2-衝突地點-' + Date.now());
      let sessR = await makeSession(campR.id, locR.id, { name: 'SLICE2衝突場次-' + Date.now() });
      const uniqueName = sessR.name;

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), uniqueName, { timeout: 5000 });

        const row = h.page.locator('#ppa-sessions-tbody tr', { hasText: uniqueName });
        await row.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' }); // UI 現在載入了 revision N

        // 真實 API 把 revision 推進到 N+1（跟 UI 目前開著的表單完全無關的另一個 client）
        const bumped = await call('PATCH', `/api/popup-pickup/sessions/${sessR.id}`, { token: T1, body: { expected_revision: sessR.revision, name: uniqueName + '-server端改名' } });
        assert(bumped.status === 200, 'BR-precheck-server-side-bump 測試端真實 API 先把 revision 推進一次', JSON.stringify(bumped));

        const patchesSeen = [];
        await h.page.route(`${base}/api/popup-pickup/sessions/${sessR.id}`, (route) => { if (route.request().method() === 'PATCH') patchesSeen.push({ status: null }); return route.continue(); });
        const getsSeen = [];
        h.page.on('response', (res) => { const u = new URL(res.url()); if (u.pathname === '/api/popup-pickup/sessions' && res.request().method() === 'GET') getsSeen.push(res.status()); });

        h.expectApiError('PATCH', `/api/popup-pickup/sessions/${sessR.id}`);
        await h.page.fill('#ppa-session-name', uniqueName + '-UI端舊revision改名');
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), uniqueName + '-server端改名', { timeout: 5000 });

        assert(getsSeen.length > 0, 'BR22-revision-conflict-fresh-refetch 收到 409 後 UI 真的重新 GET 該場次（不是假造畫面更新）', String(getsSeen.length));
        const finalText = await h.page.locator('#ppa-sessions-tbody').textContent();
        assert(finalText.includes(uniqueName + '-server端改名') && !finalText.includes('UI端舊revision改名'), 'BR23-revision-conflict-not-overwritten 畫面顯示的是伺服器端 N+1 的資料，UI 的舊 mutation 沒有覆蓋它', finalText.slice(0, 200));
        const toastText = await h.page.evaluate(() => { const c = document.getElementById('toastContainer'); return c ? c.textContent : ''; }).catch(() => '');
        assert(toastText.includes('已被其他操作更新'), 'BR24-revision-conflict-user-message 使用者看到明確的衝突提示訊息（toast）', toastText);
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 四、affected-orders confirm：真實取消 + 真實確認 + 錯誤邊界
    //     Reality audit 確認：UI 用 window.prompt()（不是自訂 modal），
    //     message 為「此場次已有 N 筆訂單，修改重要欄位需要輸入變更原因以
    //     二次確認：」；取消（prompt 回傳 null）→ toast「已取消變更」、
    //     不送第二次 PATCH；確認則帶著 trim 過的文字重送同一個 PATCH，
    //     多帶 confirm_affected_orders:true + change_reason。
    // ══════════════════════════════════════════════════════════════
    {
      const campAO = await makeCampaign('SLICE3-確認活動-' + Date.now());
      const locAO = await makeLocation('SLICE3-確認地點-' + Date.now());
      let sessAO = await makeSession(campAO.id, locAO.id, { name: 'SLICE3確認場次-' + Date.now() });
      sessAO = await publishSession(sessAO.id, sessAO.revision);
      const orderRes = await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'SLICE3測試顧客', customer_phone: '0911000111', popup_session_public_code: sessAO.public_code,
        items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
      }});
      assert(orderRes.status === 201, 'BR-precheck-ao-order-created 測試端真實建立一張 popup order 作為 affected-orders 前提', JSON.stringify(orderRes).slice(0, 200));

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sessAO.name, { timeout: 5000 });

        // ── 取消路徑 ──────────────────────────────────────────────
        let patchCount = 0; let lastBody = null;
        await h.page.route(`${base}/api/popup-pickup/sessions/${sessAO.id}`, (route) => {
          if (route.request().method() === 'PATCH') { patchCount++; lastBody = route.request().postDataJSON(); }
          return route.continue();
        });
        const row = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessAO.name });
        await row.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.fill('#ppa-session-start', '11:30');
        h.expectDialog('dismiss', { typeContains: 'prompt', messageContains: '已有 1 筆訂單' });
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForTimeout(500);
        assert(patchCount === 1, 'BR25-affected-first-patch-once 第一次 PATCH（觸發 confirm-required）恰好 1 次', String(patchCount));
        assert(!('confirm_affected_orders' in (lastBody || {})) && !('change_reason' in (lastBody || {})), 'BR26-affected-first-patch-no-confirm-fields 第一次 PATCH payload 不含 confirm_affected_orders/change_reason', JSON.stringify(lastBody));
        assert(h.unexpectedDialogs.length === 0, 'BR27-affected-dialog-type-message-verified prompt 的 type 與訊息關鍵字（含「已有 1 筆訂單」）符合實際 production 契約', JSON.stringify(h.unexpectedDialogs));

        const afterCancelGet = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}`, { token: T1 });
        assert(afterCancelGet.json.data.revision === sessAO.revision && afterCancelGet.json.data.pickup_start_time === sessAO.pickup_start_time, 'BR28-affected-cancel-no-mutation 使用者取消 prompt 後，revision 與 pickup_start_time 完全沒變（DB 真實驗證）', JSON.stringify(afterCancelGet.json.data));
        const logsAfterCancel = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}/change-logs`, { token: T1 });
        assert((logsAfterCancel.json.data || []).length === 0, 'BR29-affected-cancel-no-changelog 取消後沒有新增 change log', JSON.stringify(logsAfterCancel.json.data));
        const btnAfterCancel = await h.page.locator('#ppa-session-save-btn').textContent();
        assert(btnAfterCancel.trim() === '儲存', 'BR30-affected-cancel-button-recovers 取消後按鈕恢復可用文字（非停在儲存中）', btnAfterCancel);
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});

        // ── 確認路徑（fresh 重新打開表單）──────────────────────────
        patchCount = 0;
        await h.page.evaluate(() => ppaLoadSessions());
        await h.page.waitForFunction((n) => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sessAO.name, { timeout: 5000 });
        const row2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessAO.name });
        await row2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.fill('#ppa-session-start', '11:45');
        const testReason = 'SLICE3測試變更原因-店家臨時調整';
        h.expectDialog('accept', { typeContains: 'prompt', messageContains: '已有 1 筆訂單', promptText: testReason });
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction(() => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes('11:45'), { timeout: 5000 });
        assert(patchCount === 2, 'BR31-affected-confirm-second-patch-once 確認後第二次 PATCH（連同第一次）總共 2 次，第二次恰好 1 次新請求', String(patchCount));
        assert(lastBody && lastBody.confirm_affected_orders === true && typeof lastBody.change_reason === 'string' && lastBody.change_reason.trim().length > 0, 'BR32-affected-confirm-payload-correct 第二次 PATCH payload 含 confirm_affected_orders===true 與非空白 change_reason', JSON.stringify(lastBody));
        const forbidden2 = lastBody && ['store_id', 'public_code', 'price', 'subtotal', 'total'].some((k) => k in lastBody);
        assert(!forbidden2, 'BR33-affected-confirm-no-forbidden-fields 第二次 PATCH 不含 store_id/public_code/價格/訂單 snapshot', JSON.stringify(lastBody));

        const afterConfirmGet = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}`, { token: T1 });
        assert(afterConfirmGet.json.data.pickup_start_time === '11:45' && afterConfirmGet.json.data.revision > sessAO.revision, 'BR34-affected-confirm-db-updated 真實 DB/API 顯示新的 pickup_start_time 且 revision 正確前進', JSON.stringify(afterConfirmGet.json.data));
        const finalTableText = await h.page.locator('#ppa-sessions-tbody').textContent();
        assert(finalTableText.includes('11:45'), 'BR35-affected-confirm-ui-fresh-reload UI fresh reload 後畫面顯示新值', finalTableText.slice(0, 150));

        const logsAfterConfirm = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}/change-logs`, { token: T1 });
        const logs = logsAfterConfirm.json.data || [];
        assert(logs.length === 1 && logs[0].change_reason === testReason && logs[0].affected_order_count === 1, 'BR36-affected-confirm-changelog-created change-log 真實新增恰好一筆，reason 與 affected_order_count 符合這次異動', JSON.stringify(logs));

        // ── 錯誤邊界：第二次 PATCH 注入 500 ──────────────────────
        const row3 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessAO.name });
        await row3.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.fill('#ppa-session-start', '12:00');
        let firstPatchSeen = false;
        await h.page.route(`${base}/api/popup-pickup/sessions/${sessAO.id}`, async (route) => {
          if (route.request().method() !== 'PATCH') return route.continue();
          const body = route.request().postDataJSON();
          if (!body.confirm_affected_orders) { firstPatchSeen = true; return route.continue(); } // 讓第一次真的走 409
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '測試用強制失敗' }) });
        });
        h.expectApiError('PATCH', `/api/popup-pickup/sessions/${sessAO.id}`);
        h.expectDialog('accept', { typeContains: 'prompt', promptText: '第二次失敗測試原因' });
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForTimeout(600);
        const modalStillOpen2 = await h.page.locator('#ppa-modal-session').isVisible();
        const btnAfter500 = await h.page.locator('#ppa-session-save-btn').textContent();
        assert(firstPatchSeen && modalStillOpen2 && btnAfter500.trim() === '儲存', 'BR37-affected-second-patch-500-recovers 第二次 PATCH 真實 500 時 modal 保留、按鈕恢復，不假裝成功', JSON.stringify({ firstPatchSeen, modalStillOpen2, btnAfter500 }));
        const afterFailGet = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}`, { token: T1 });
        assert(afterFailGet.json.data.pickup_start_time === '11:45', 'BR38-affected-second-patch-500-no-db-change 500 後 DB pickup_start_time 沒有變成 12:00（沒有假成功）', JSON.stringify(afterFailGet.json.data));
        const logsAfter500 = await call('GET', `/api/popup-pickup/sessions/${sessAO.id}/change-logs`, { token: T1 });
        assert((logsAfter500.json.data || []).length === 1, 'BR39-affected-second-patch-500-no-changelog 500 後沒有多出 change log', JSON.stringify(logsAfter500.json.data));
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 五、order_count / remaining_orders / is_full 與 checkout parity
    //     獨立 fixture，不與 affected-orders 案例共用 incidental state。
    // ══════════════════════════════════════════════════════════════
    {
      const campU = await makeCampaign('SLICE3-不限量活動-' + Date.now());
      const locU = await makeLocation('SLICE3-不限量地點-' + Date.now());
      let sessU = await makeSession(campU.id, locU.id, { name: 'SLICE3不限量場次-' + Date.now() });
      sessU = await publishSession(sessU.id, sessU.revision);

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sessU.name, { timeout: 5000 });

        const initGet = await call('GET', `/api/popup-pickup/sessions/${sessU.id}`, { token: T1 });
        assert(initGet.json.data.order_count === 0 && initGet.json.data.remaining_orders === null && initGet.json.data.is_full === false, 'BR40-unlimited-initial-contract 不限量場次初始 order_count=0/remaining_orders=null/is_full=false', JSON.stringify(initGet.json.data));
        let rowText = await h.page.locator('#ppa-sessions-tbody tr', { hasText: sessU.name }).textContent();
        assert(rowText.includes('已下單 0') && rowText.includes('不限量') && !rowText.includes('已額滿'), 'BR41-unlimited-ui-initial UI 顯示「已下單 0／不限量」且沒有「已額滿」', rowText);

        const orderU = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE3不限量顧客', customer_phone: '0922000222', popup_session_public_code: sessU.public_code,
          items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
        }});
        assert(orderU.status === 201, 'BR-precheck-unlimited-order 真實 checkout 建立一張訂單', JSON.stringify(orderU).slice(0, 150));
        await h.page.evaluate(() => ppaLoadSessions());
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n) && document.getElementById('ppa-sessions-tbody').textContent.includes('已下單 1'), sessU.name, { timeout: 5000 });
        const afterGetU = await call('GET', `/api/popup-pickup/sessions/${sessU.id}`, { token: T1 });
        assert(afterGetU.json.data.order_count === 1 && afterGetU.json.data.remaining_orders === null && afterGetU.json.data.is_full === false, 'BR42-unlimited-after-order order_count=1，remaining_orders 仍是 null，is_full 仍是 false', JSON.stringify(afterGetU.json.data));
        rowText = await h.page.locator('#ppa-sessions-tbody tr', { hasText: sessU.name }).textContent();
        assert(rowText.includes('已下單 1') && rowText.includes('不限量'), 'BR43-unlimited-ui-after-order UI fresh reload 顯示「已下單 1／不限量」', rowText);
      } finally { await h.close(); }
    }

    {
      const campL = await makeCampaign('SLICE3-限量活動-' + Date.now());
      const locL = await makeLocation('SLICE3-限量地點-' + Date.now());
      let sessL = await makeSession(campL.id, locL.id, { name: 'SLICE3限量場次-' + Date.now(), max_orders: 1 });
      sessL = await publishSession(sessL.id, sessL.revision);

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sessL.name, { timeout: 5000 });

        const initGetL = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(initGetL.json.data.order_count === 0 && initGetL.json.data.remaining_orders === 1 && initGetL.json.data.is_full === false, 'BR44-limited-initial-contract 限量場次初始 order_count=0/remaining_orders=1/is_full=false', JSON.stringify(initGetL.json.data));

        const orderL1 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE3限量顧客1', customer_phone: '0933000333', popup_session_public_code: sessL.public_code,
          items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
        }});
        assert(orderL1.status === 201, 'BR-precheck-limited-order1 真實 checkout 建立第一張訂單', JSON.stringify(orderL1).slice(0, 150));
        const orderL1Id = orderL1.json.data.order_id || orderL1.json.data.id;

        const afterOrder1 = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(afterOrder1.json.data.order_count === 1 && afterOrder1.json.data.remaining_orders === 0 && afterOrder1.json.data.is_full === true, 'BR45-limited-full-contract 第一張訂單後 order_count=1/remaining_orders=0/is_full=true（GET detail）', JSON.stringify(afterOrder1.json.data));
        const listAfterOrder1 = await call('GET', '/api/popup-pickup/sessions', { token: T1, query: { campaign_id: campL.id } });
        const listEntry = listAfterOrder1.json.data.find((s) => s.id === sessL.id);
        assert(listEntry && listEntry.order_count === 1 && listEntry.remaining_orders === 0 && listEntry.is_full === true, 'BR46-limited-full-contract-list GET list 回傳與 GET detail 相同的三個欄位（契約一致）', JSON.stringify(listEntry));

        await h.page.evaluate(() => ppaLoadSessions());
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n) && document.getElementById('ppa-sessions-tbody').textContent.includes('已額滿'), sessL.name, { timeout: 5000 });
        const rowTextL = await h.page.locator('#ppa-sessions-tbody tr', { hasText: sessL.name }).textContent();
        assert(rowTextL.includes('已下單 1') && rowTextL.includes('上限 1') && rowTextL.includes('剩餘 0') && rowTextL.includes('已額滿'), 'BR47-limited-ui-full UI fresh reload 顯示「已下單 1／上限 1／剩餘 0」且顯示「已額滿」', rowTextL);

        // 第二次真實 checkout：必須被同一套權威擋下（不是測試自己另寫 count）
        const orderL2 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE3限量顧客2', customer_phone: '0933000334', popup_session_public_code: sessL.public_code,
          items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
        }});
        assert(orderL2.status === 409 && orderL2.json.error === 'POPUP_SESSION_FULL', 'BR48-limited-second-checkout-blocked 第二次真實 checkout 回正式 session-full 409（admin is_full 與 checkout 共用同一權威）', JSON.stringify(orderL2).slice(0, 200));
        const afterBlockedCheckout = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(afterBlockedCheckout.json.data.order_count === 1, 'BR49-limited-blocked-checkout-no-increment 被擋下的第二次 checkout 沒有讓 order_count 增加', String(afterBlockedCheckout.json.data.order_count));

        // ── 取消／作廢／隔離：使用真實 /api/orders 路由 ─────────────
        const cancelRes = await call('PATCH', `/api/orders/${orderL1Id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        assert(cancelRes.status === 200, 'BR-precheck-cancel-real-route 真實 PATCH /api/orders/:id/status 取消訂單成功', JSON.stringify(cancelRes).slice(0, 200));
        const afterCancelL = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(afterCancelL.json.data.order_count === 0 && afterCancelL.json.data.remaining_orders === 1 && afterCancelL.json.data.is_full === false, 'BR50-cancel-resets-count 真實取消後 fresh GET：order_count=0/remaining=1/is_full=false', JSON.stringify(afterCancelL.json.data));
        // R42：BR51 hard predicate — click/reload 前註冊的 sessions list response、exact session row（恰好一列）含 已下單 0／上限 1／剩餘 1 且無 已額滿、fresh server GET 0/1/false、無 pageerror。
        const isBr51List = (method, url) => method === 'GET' && new URL(url).pathname === '/api/popup-pickup/sessions';
        const br51ResponsePromise = h.page.waitForResponse((r) => isBr51List(r.request().method(), r.url()), { timeout: 10000 }).then((r) => r, () => null);
        await h.page.evaluate(() => ppaLoadSessions());
        const br51Response = await br51ResponsePromise;
        const br51ListWaited = await h.page.waitForFunction((n) => { const t = document.getElementById('ppa-sessions-tbody').textContent; return t.includes(n) && t.includes('已下單 0') && !t.includes('已額滿'); }, sessL.name, { timeout: 5000 }).then(() => true, () => false);
        const br51Row = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessL.name });
        const br51RowCount = await br51Row.count();
        const br51RowText = br51RowCount === 1 ? await br51Row.textContent() : '';
        const br51Get = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        const br51Data = br51Get.json && br51Get.json.data ? br51Get.json.data : null;
        const br51Detail = {
          responseStatus: br51Response ? br51Response.status() : null,
          rowCount: br51RowCount,
          rowShowsName: br51RowText.includes(sessL.name),
          rowShowsOrdered0: /已下單 0(?!\d)/.test(br51RowText),
          rowShowsCap1: /上限 1(?!\d)/.test(br51RowText),
          rowShowsRemaining1: /剩餘 1(?!\d)/.test(br51RowText),
          rowShowsFull: br51RowText.includes('已額滿'),
          listWaited: br51ListWaited,
          readbackStatus: br51Get.status,
          readbackExact: !!br51Data && br51Data.order_count === 0 && br51Data.remaining_orders === 1 && br51Data.is_full === false,
          pageErrorCount: h.pageErrors.length,
        };
        assert(
          br51Detail.responseStatus === 200 && br51Detail.rowCount === 1 && br51Detail.rowShowsName && br51Detail.rowShowsOrdered0 && br51Detail.rowShowsCap1 && br51Detail.rowShowsRemaining1
            && !br51Detail.rowShowsFull && br51Detail.listWaited && br51Detail.readbackStatus === 200 && br51Detail.readbackExact && br51Detail.pageErrorCount === 0,
          'BR51-cancel-ui-removes-full-badge UI fresh reload 後「已額滿」標示移除',
          JSON.stringify(br51Detail),
        );

        const orderL3 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE3限量顧客3', customer_phone: '0933000335', popup_session_public_code: sessL.public_code,
          items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
        }});
        const orderL3Id = orderL3.json.data.order_id || orderL3.json.data.id;
        const voidRes = await call('POST', `/api/orders/${orderL3Id}/void`, { token: T1, body: { reason: 'SLICE3測試作廢', operator: 'test' } });
        assert(voidRes.status === 200, 'BR-precheck-void-real-route 真實 POST /api/orders/:id/void 作廢訂單成功', JSON.stringify(voidRes).slice(0, 200));
        const afterVoidL = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(afterVoidL.json.data.order_count === 0 && afterVoidL.json.data.remaining_orders === 1 && afterVoidL.json.data.is_full === false, 'BR52-void-excluded 真實作廢後 order_count 排除該筆，回到 0/1/false', JSON.stringify(afterVoidL.json.data));

        // 隔離：另一 session 的訂單不影響本 session
        const campIso = await makeCampaign('SLICE3-隔離活動-' + Date.now());
        const locIso = await makeLocation('SLICE3-隔離地點-' + Date.now());
        let sessIso = await makeSession(campIso.id, locIso.id, { name: 'SLICE3隔離場次-' + Date.now(), max_orders: 5 });
        sessIso = await publishSession(sessIso.id, sessIso.revision);
        await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE3隔離顧客', customer_phone: '0933000336', popup_session_public_code: sessIso.public_code,
          items: [{ product_id: 9501, qty: 1 }], payment_method: 'cash',
        }});
        const afterIso = await call('GET', `/api/popup-pickup/sessions/${sessL.id}`, { token: T1 });
        assert(afterIso.json.data.order_count === 0, 'BR53-cross-session-isolation 另一場次的新訂單不影響本場次 order_count', String(afterIso.json.data.order_count));
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 六、inactive-location snapshot（真實 UI + request log + DB readback）
    // ══════════════════════════════════════════════════════════════
    {
      const campIL = await makeCampaign('SLICE4-地點快照活動-' + Date.now());
      const locA = await makeLocation('SLICE4-地點A-' + Date.now());
      const locB = await makeLocation('SLICE4-地點B-' + Date.now());
      let sessIL = await makeSession(campIL.id, locA.id, { name: 'SLICE4快照場次-' + Date.now() });
      sessIL = await publishSession(sessIL.id, sessIL.revision);
      const originalSnapshot = { place_name: sessIL.place_name, address: sessIL.address, location_id: sessIL.location_id };

      const delRes = await call('DELETE', `/api/popup-pickup/locations/${locA.id}`, { token: T1 });
      assert(delRes.status === 200, 'BR-precheck-location-soft-delete 真實 API 將地點 A 軟停用成功', JSON.stringify(delRes).slice(0, 150));
      const locRow = db.get('SELECT active FROM popup_locations WHERE id=?', [locA.id]);
      assert(locRow && Number(locRow.active) === 0, 'BR54-location-soft-delete-db-confirmed DB 內地點 A 確實 active=0（軟停用，非硬刪）', JSON.stringify(locRow));

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('locations'); });
        await h.page.waitForFunction((n) => !document.getElementById('ppa-locations-tbody').textContent.includes('載入中') && document.getElementById('ppa-locations-tbody').textContent.includes(n), 'SLICE4-地點A', { timeout: 5000 });
        const locARow = await h.page.locator('#ppa-locations-tbody tr', { hasText: locA.name }).textContent();
        assert(locARow.includes('已停用'), 'BR55-inactive-location-shown-disabled 地點列表中 A 顯示「已停用」，不是假裝從 DB 消失', locARow);

        // 新建場次：A 不得出現、B 仍可選
        await h.page.evaluate(() => ppaSwitchTab('sessions'));
        await h.page.waitForFunction(() => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await h.page.click('button:has-text("＋ 新增場次")');
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.waitForFunction(() => document.getElementById('ppa-session-location').options.length > 0, { timeout: 5000 });
        const newSessionLocOptions = await h.page.locator('#ppa-session-location option').allTextContents();
        assert(!newSessionLocOptions.some((t) => t.includes(locA.name)) && newSessionLocOptions.some((t) => t.includes(locB.name)), 'BR56-new-session-excludes-inactive 新建場次的地點下拉不含已停用的 A，但含仍啟用的 B', JSON.stringify(newSessionLocOptions));
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});

        // 編輯既有 S：A 仍以「已停用」歷史選項顯示，值不清空
        const rowS = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessIL.name });
        await rowS.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        const selValue = await h.page.inputValue('#ppa-session-location');
        assert(selValue === locA.id, 'BR57-edit-session-location-not-blank 編輯既有場次時，地點欄位仍正確帶出 A 的 id（未清空）', selValue);
        const selectedOptText = await h.page.locator('#ppa-session-location option:checked').textContent();
        assert(selectedOptText.includes('已停用'), 'BR58-edit-session-location-labeled-historical 選中的歷史地點選項清楚標示已停用', selectedOptText);

        // 只改名稱：PATCH body 不含 location_id，DB snapshot 完全不變
        let patchBodyIL = null; let patchCountIL = 0;
        await h.page.route(`${base}/api/popup-pickup/sessions/${sessIL.id}`, (route) => {
          if (route.request().method() === 'PATCH') { patchCountIL++; patchBodyIL = route.request().postDataJSON(); }
          return route.continue();
        });
        await h.page.fill('#ppa-session-name', sessIL.name + '-改名不動地點');
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), sessIL.name + '-改名不動地點', { timeout: 5000 });
        assert(patchCountIL === 1 && patchBodyIL && !('location_id' in patchBodyIL), 'BR59-name-only-patch-omits-location-id 只改名稱的 PATCH payload 完全不含 location_id', JSON.stringify(patchBodyIL));
        const dbAfterNameChange = await call('GET', `/api/popup-pickup/sessions/${sessIL.id}`, { token: T1 });
        assert(dbAfterNameChange.json.data.location_id === originalSnapshot.location_id && dbAfterNameChange.json.data.place_name === originalSnapshot.place_name && dbAfterNameChange.json.data.address === originalSnapshot.address, 'BR60-name-only-patch-snapshot-unchanged 只改名稱後 DB 的 location_id/place_name/address snapshot 完全沒變', JSON.stringify(dbAfterNameChange.json.data));

        // 主動改選 B：PATCH body 才包含新 location_id，snapshot 改為 B
        const rowS2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sessIL.name + '-改名不動地點' });
        await rowS2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        patchCountIL = 0; patchBodyIL = null;
        await h.page.selectOption('#ppa-session-location', locB.id);
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForFunction((placeName) => document.getElementById('ppa-sessions-tbody').textContent.includes(placeName), locB.name, { timeout: 5000 });
        assert(patchCountIL === 1 && patchBodyIL && patchBodyIL.location_id === locB.id, 'BR61-switch-to-active-location-sends-id 主動改選 B 時，PATCH body 才包含新 location_id', JSON.stringify(patchBodyIL));
        const dbAfterSwitch = await call('GET', `/api/popup-pickup/sessions/${sessIL.id}`, { token: T1 });
        assert(dbAfterSwitch.json.data.location_id === locB.id && dbAfterSwitch.json.data.place_name === locB.name, 'BR62-switch-to-active-location-snapshot-updated fresh GET 確認 snapshot 全部改為 B', JSON.stringify(dbAfterSwitch.json.data));

        // 嘗試直接送 API 選 inactive A：後端必須拒絕
        const forceInactive = await call('PATCH', `/api/popup-pickup/sessions/${sessIL.id}`, { token: T1, body: { expected_revision: dbAfterSwitch.json.data.revision, location_id: locA.id } });
        assert(forceInactive.status !== 200, 'BR63-force-inactive-location-rejected 即使直接呼叫 API 指定已停用的 A，後端依正式契約拒絕', JSON.stringify(forceInactive).slice(0, 200));

        assert(h.unexpectedDialogs.length === 0 && h.unknownSame4xx5xx.filter((e) => !e.includes(`sessions/${sessIL.id}`)).length === 0, 'BR64-inactive-location-case-clean 這組情境結束時沒有非預期 dialog，也沒有 guarded API 以外的未預期錯誤', JSON.stringify({ unexpectedDialogs: h.unexpectedDialogs, unknownSame4xx5xx: h.unknownSame4xx5xx }));
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 七、batch create（合法案例 + 前端阻擋案例 + double click）
    // ══════════════════════════════════════════════════════════════
    {
      const campB = await makeCampaign('SLICE4-批次活動-' + Date.now());
      const locB2 = await makeLocation('SLICE4-批次地點-' + Date.now());

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction(() => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));

        let batchPostCount = 0; let lastBatchBody = null;
        await h.page.route(`${base}/api/popup-pickup/sessions/batch`, (route) => {
          if (route.request().method() === 'POST') { batchPostCount++; lastBatchBody = route.request().postDataJSON(); }
          return route.continue();
        });

        const d1 = taipeiDateStr(10); const d2 = taipeiDateStr(11);
        await h.page.click('button:has-text("📆 批次建立場次")');
        await h.page.waitForSelector('#ppa-modal-batch', { state: 'visible' });
        await h.page.waitForFunction(() => document.getElementById('ppa-batch-campaign').options.length > 0, { timeout: 5000 });
        await h.page.selectOption('#ppa-batch-campaign', campB.id);
        await h.page.selectOption('#ppa-batch-location', locB2.id);
        await h.page.fill('#ppa-batch-name', 'SLICE4批次場次-' + Date.now());
        await h.page.fill('#ppa-batch-dates', `${d1}\n${d2}`);
        await h.page.fill('#ppa-batch-start', '10:00');
        await h.page.fill('#ppa-batch-end', '18:00');
        await h.page.fill('#ppa-batch-order-open', '00:00');
        await h.page.fill('#ppa-batch-order-cutoff', '09:00');
        await h.page.click('#ppa-batch-save-btn');
        await h.page.waitForFunction(() => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'), { timeout: 8000 });
        await h.page.waitForTimeout(300);
        assert(batchPostCount === 1, 'BR65-batch-legal-single-post 合法批次（2 個日期）真實 POST /sessions/batch 恰好 1 次', String(batchPostCount));
        assert(lastBatchBody && lastBatchBody.sessions && lastBatchBody.sessions.length === 2, 'BR66-batch-payload-expected-count payload 展開數量等於 UI 輸入的 2 個日期', JSON.stringify(lastBatchBody && lastBatchBody.sessions && lastBatchBody.sessions.length));
        const forbiddenBatch = lastBatchBody && lastBatchBody.sessions.some((s) => 'store_id' in s || 'public_code' in s || 'price' in s || 'subtotal' in s || 'total' in s);
        assert(!forbiddenBatch, 'BR67-batch-payload-no-forbidden-fields batch payload 每筆不含 store_id/public_code/價格/subtotal/total', JSON.stringify(lastBatchBody));

        const listAfterBatch = await call('GET', '/api/popup-pickup/sessions', { token: T1, query: { campaign_id: campB.id } });
        assert(listAfterBatch.json.data.length === 2, 'BR68-batch-db-count-matches GET list／DB 確實存在 2 筆新場次', String(listAfterBatch.json.data.length));
        assert(listAfterBatch.json.data.every((s) => s.location_id === locB2.id && s.status === 'draft' && s.product_scope === 'all_takeout'), 'BR69-batch-fields-correct 每筆場次的 location_id/status/product_scope 正確', JSON.stringify(listAfterBatch.json.data.map((s) => ({ loc: s.location_id, status: s.status, scope: s.product_scope }))));

        // ── 前端阻擋案例：零 API request ──────────────────────────
        async function assertBatchBlocked(setupFn, name) {
          batchPostCount = 0;
          await h.page.click('button:has-text("📆 批次建立場次")');
          await h.page.waitForSelector('#ppa-modal-batch', { state: 'visible' });
          await h.page.waitForFunction(() => document.getElementById('ppa-batch-campaign').options.length > 0, { timeout: 5000 });
          await h.page.selectOption('#ppa-batch-campaign', campB.id);
          await h.page.selectOption('#ppa-batch-location', locB2.id);
          await h.page.fill('#ppa-batch-name', 'X');
          await h.page.fill('#ppa-batch-start', '10:00');
          await h.page.fill('#ppa-batch-end', '18:00');
          await h.page.fill('#ppa-batch-order-open', '00:00');
          await h.page.fill('#ppa-batch-order-cutoff', '09:00');
          await h.page.fill('#ppa-batch-dates', '');
          await setupFn();
          await h.page.click('#ppa-batch-save-btn');
          await h.page.waitForTimeout(300);
          assert(batchPostCount === 0, name, String(batchPostCount));
          await h.page.click('#ppa-modal-batch .modal-close, #ppa-modal-batch button:has-text("取消")').catch(() => {});
        }
        await assertBatchBlocked(() => Promise.resolve(), 'BR70-batch-empty-dates-blocked 空日期前端阻擋，零 API request');
        await assertBatchBlocked(() => h.page.fill('#ppa-batch-dates', '2026-02-30'), 'BR71-batch-invalid-date-blocked 不存在的日期（2/30）前端阻擋，零 API request');
        await assertBatchBlocked(() => h.page.fill('#ppa-batch-dates', '2025-02-29'), 'BR72-batch-non-leap-feb29-blocked 非閏年 2/29 前端阻擋，零 API request');
        // H1.4.12 Phase 3C：ppaSaveBatchSessions() 現在跟單筆場次共用
        // ppaValidatePickupTimes()，end<=start 與非法時間格式都會被前端擋下。
        await assertBatchBlocked(async () => { await h.page.fill('#ppa-batch-dates', taipeiDateStr(16)); await h.page.fill('#ppa-batch-start', '15:00'); await h.page.fill('#ppa-batch-end', '09:00'); }, 'BR73-batch-end-before-start-blocked end<start 前端阻擋，零 API request（production 已修正）');
        await assertBatchBlocked(async () => { await h.page.fill('#ppa-batch-dates', taipeiDateStr(17)); await h.page.fill('#ppa-batch-start', '10:00'); await h.page.fill('#ppa-batch-end', '10:00'); }, 'BR73b-batch-equal-times-blocked start===end 前端阻擋，零 API request');
        // 註：25:00 這類非法時間無法透過真實瀏覽器測試——原生
        // <input type="time"> 本身就會在瀏覽器層拒絕這種值（page.fill()
        // 對此丟出 "Malformed value"），使用者透過原生 time picker 或鍵盤
        // 輸入根本打不出 25:00。ppaValidatePickupTimes() 裡的格式檢查是
        // 針對「非透過原生 picker」的輸入路徑（例如未來若改用純文字輸入）
        // 的縱深防禦，這裡不需要、也無法對它做 Chromium UI 層驗證。
        {
          const manyDates = Array.from({ length: 101 }, (_, i) => taipeiDateStr(20 + i)).join('\n');
          await assertBatchBlocked(() => h.page.fill('#ppa-batch-dates', manyDates), 'BR74-batch-over-100-blocked 超過 100 筆前端阻擋，零 API request');
        }

        // ── R38：恰好 100 筆的批次正邊界（owner-approved semantic successor；不是歷史 Repair 4 原始測試的復原）───
        // 真實 UI 填入 100 個不同的有效日期並點擊「批次建立」：恰好 1 次 POST、100 筆 request、201、
        // success、100 筆 response（id／public_code 皆非空且唯一）、request 無 client-authoritative 欄位、
        // modal 關閉、按鈕恢復。沒有 response 時記為 FAIL（不是 FATAL）。
        {
          const ex100Dates = Array.from({ length: 100 }, (_, i) => taipeiDateStr(200 + i));
          const ex100 = { postCount: 0, status: null, success: false, requestCount: 0, responseCount: 0, uniqueIds: 0, uniqueCodes: 0, forbiddenFields: null, modalClosed: false, buttonRestored: false };
          batchPostCount = 0; lastBatchBody = null;
          await h.page.click('button:has-text("📆 批次建立場次")');
          await h.page.waitForSelector('#ppa-modal-batch', { state: 'visible' });
          await h.page.waitForFunction(() => document.getElementById('ppa-batch-campaign').options.length > 0, { timeout: 5000 });
          await h.page.selectOption('#ppa-batch-campaign', campB.id);
          await h.page.selectOption('#ppa-batch-location', locB2.id);
          await h.page.fill('#ppa-batch-name', 'R38恰好100筆批次');
          await h.page.fill('#ppa-batch-dates', ex100Dates.join('\n'));
          await h.page.fill('#ppa-batch-start', '10:00');
          await h.page.fill('#ppa-batch-end', '18:00');
          await h.page.fill('#ppa-batch-order-open', '00:00');
          await h.page.fill('#ppa-batch-order-cutoff', '09:00');
          const ex100RespP = h.page.waitForResponse((r) => r.url() === `${base}/api/popup-pickup/sessions/batch` && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
          await h.page.click('#ppa-batch-save-btn');
          const ex100Resp = await ex100RespP;
          let ex100Json = null;
          if (ex100Resp) { ex100.status = ex100Resp.status(); ex100Json = await ex100Resp.json().catch(() => null); }
          await h.page.waitForFunction(() => { const b = document.getElementById('ppa-batch-save-btn'); return b && !b.disabled; }, null, { timeout: 15000 }).catch(() => {});
          await h.page.waitForTimeout(300);
          ex100.postCount = batchPostCount;
          const ex100Sessions = lastBatchBody && Array.isArray(lastBatchBody.sessions) ? lastBatchBody.sessions : [];
          ex100.requestCount = ex100Sessions.length;
          ex100.forbiddenFields = ex100Sessions.filter((s) => ['store_id', 'public_code', 'price', 'subtotal', 'total'].some((k) => k in s)).length;
          const ex100Data = ex100Json && Array.isArray(ex100Json.data) ? ex100Json.data : [];
          ex100.success = !!(ex100Json && ex100Json.success === true);
          ex100.responseCount = ex100Data.length;
          ex100.uniqueIds = new Set(ex100Data.map((d) => (d && d.id != null ? String(d.id) : '')).filter((x) => x !== '')).size;
          ex100.uniqueCodes = new Set(ex100Data.map((d) => (d && d.public_code != null ? String(d.public_code) : '')).filter((x) => x !== '')).size;
          const ex100Ui = await h.page.evaluate(() => { const m = document.getElementById('ppa-modal-batch'); const b = document.getElementById('ppa-batch-save-btn'); return { modalClosed: !!m && getComputedStyle(m).display === 'none', buttonRestored: !!b && !b.disabled && b.textContent === '批次建立' }; });
          ex100.modalClosed = ex100Ui.modalClosed; ex100.buttonRestored = ex100Ui.buttonRestored;
          assert(ex100.postCount === 1 && ex100.requestCount === 100 && ex100.status === 201 && ex100.success && ex100.responseCount === 100 && ex100.uniqueIds === 100 && ex100.uniqueCodes === 100 && ex100.forbiddenFields === 0 && ex100.modalClosed && ex100.buttonRestored,
            'R38-batch-exactly-100-accepted 恰好 100 筆日期的批次建立被接受：真實點擊恰好 1 次 POST、100 筆 request、201、100 筆唯一 id／public_code、無禁止欄位、modal 關閉且按鈕恢復',
            JSON.stringify(ex100));
          if (!ex100.modalClosed) await h.page.click('#ppa-modal-batch .modal-close, #ppa-modal-batch button:has-text("取消")').catch(() => {});
        }

        // ── double click：合法輸入仍只建立一次 ─────────────────────
        batchPostCount = 0;
        const d3 = taipeiDateStr(30);
        await h.page.click('button:has-text("📆 批次建立場次")');
        await h.page.waitForSelector('#ppa-modal-batch', { state: 'visible' });
        await h.page.waitForFunction(() => document.getElementById('ppa-batch-campaign').options.length > 0, { timeout: 5000 });
        await h.page.selectOption('#ppa-batch-campaign', campB.id);
        await h.page.selectOption('#ppa-batch-location', locB2.id);
        await h.page.fill('#ppa-batch-name', 'SLICE4雙擊批次');
        await h.page.fill('#ppa-batch-dates', d3);
        await h.page.fill('#ppa-batch-start', '10:00');
        await h.page.fill('#ppa-batch-end', '18:00');
        await h.page.fill('#ppa-batch-order-open', '00:00');
        await h.page.fill('#ppa-batch-order-cutoff', '09:00');
        await h.page.evaluate(() => {
          const btn = document.getElementById('ppa-batch-save-btn');
          btn.click(); btn.click(); // 真正的雙擊：同一個事件循環內連續兩次原生 click，不受 Playwright 自己的 actionability 等待影響
        });
        await h.page.waitForTimeout(600);
        assert(batchPostCount === 1, 'BR75-batch-double-click-single-post 合法輸入下快速雙擊仍只送出 1 次 batch POST', String(batchPostCount));
      } finally { await h.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 九、product_scope：line_eligibility API 契約 + A–J 商品矩陣
    // ══════════════════════════════════════════════════════════════
    {
      const ids = await createProductMatrix();
      try {
        const listRes = await call('GET', '/api/products/line-products/list', { token: T1 });
        assert(listRes.status === 200, 'BR-precheck-matrix-list-ok 真實 GET /line-products/list 成功', JSON.stringify(listRes).slice(0, 150));
        const byId = {}; listRes.json.data.forEach((p) => { byId[p.id] = p; });

        const pA = byId[ids.A]; const pB = byId[ids.B]; const pC = byId[ids.C]; const pD = byId[ids.D];
        assert(!!pA && pA.line_eligibility.is_line_takeout_orderable === true && pA.line_eligibility.name === PROD_PREFIX + 'A的LINE名稱' && pA.line_eligibility.price === 120, 'BR76-eligibility-A-correct A（合格、line_name/line_price 都有值）的 line_eligibility 正確', JSON.stringify(pA && pA.line_eligibility));
        assert(!!pB && pB.line_eligibility.is_line_takeout_orderable === true && pB.line_eligibility.name === PROD_PREFIX + 'B空白名fallback', 'BR77-eligibility-B-fallback-name B（line_name 空白）display name fallback 回一般 name', JSON.stringify(pB && pB.line_eligibility));
        assert(!!pC && pC.line_eligibility.price === 110, 'BR78-eligibility-C-fallback-110 C（line_price=null、takeaway_price=110）display_price 正確 fallback 為 110', JSON.stringify(pC && pC.line_eligibility));
        assert(!!pD && pD.line_eligibility.price > 0, 'BR79-eligibility-D-zero-fallback D（line_price=0）依正式 >0 規則 fallback，不視為免費', JSON.stringify(pD && pD.line_eligibility));
        assert(byId[ids.E] === undefined, 'BR80-eligibility-E-not-listed E（enabled=0）不出現在一般列表中', String(byId[ids.E]));
        ['F', 'G', 'H', 'I'].forEach((k) => {
          const p = byId[ids[k]];
          assert(!!p && p.line_eligibility.is_line_takeout_orderable === false, `BR81-eligibility-${k}-ineligible ${k} 的 line_eligibility.is_line_takeout_orderable 正確為 false`, JSON.stringify(p && p.line_eligibility));
        });
        assert(byId[ids.J] === undefined, 'BR82-eligibility-J-not-cross-store J（另一店家商品）不出現在 store_001 的列表中', String(byId[ids.J]));

        const rawStr = JSON.stringify(listRes.json.data);
        const sensitiveLeak = ['cost', 'purchase_price', 'supplier', 'token', 'secret', 'gateway', 'license'].filter((k) => new RegExp(`"${k}"`, 'i').test(rawStr));
        assert(sensitiveLeak.length === 0, 'BR83-no-sensitive-fields-leaked response 不含 cost/purchase_price/supplier/token/secret/gateway/license 等敏感欄位', JSON.stringify(sensitiveLeak));
        assert(Number.isFinite(pA.line_eligibility.price) && pA.line_eligibility.price >= 0, 'BR84-price-finite-nonnegative display_price 是 finite、非負數值', String(pA.line_eligibility.price));

        // ── all_takeout 真實 Chromium UI ──────────────────────────
        const campAT = await makeCampaign('SLICE5-合格活動-' + Date.now());
        const locAT = await makeLocation('SLICE5-合格地點-' + Date.now());
        const h = await newAdminPage();
        try {
          await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
          await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
          await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
          await h.page.waitForFunction(() => !document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
          await h.page.click('button:has-text("＋ 新增場次")');
          await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
          await h.page.waitForFunction(() => document.getElementById('ppa-session-campaign').options.length > 0);
          await h.page.selectOption('#ppa-session-campaign', campAT.id);
          await h.page.click('input[name="ppa-session-scope"][value="all_takeout"]');
          await h.page.waitForFunction(() => document.getElementById('ppa-session-all-takeout-info').textContent.includes('共'));
          const infoText = await h.page.locator('#ppa-session-all-takeout-info').textContent();
          const uiCount = Number((infoText.match(/共\s*(\d+)\s*項/) || [])[1]);
          const apiEligibleCount = listRes.json.data.filter((p) => p.line_eligibility.is_line_takeout_orderable).length;
          assert(uiCount === apiEligibleCount, 'BR85-all-takeout-count-matches-api UI 顯示的 eligible count 與真實 API 計算結果完全一致', `ui=${uiCount}, api=${apiEligibleCount}`);

          await h.page.click('input[name="ppa-session-scope"][value="selected"]');
          await h.page.waitForFunction(() => document.getElementById('ppa-product-picker-list').children.length > 0);
          const pickerHtml = await h.page.locator('#ppa-product-picker-list').innerHTML();
          assert(pickerHtml.includes(PROD_PREFIX + 'A的LINE名稱') && pickerHtml.includes('120'), 'BR86-picker-shows-A-line-name-price picker 顯示 A 的 line_name 與 120 元價格', pickerHtml.includes(PROD_PREFIX + 'A的LINE名稱') ? 'name ok' : 'missing');
          assert(pickerHtml.includes(PROD_PREFIX + 'B空白名fallback'), 'BR87-picker-shows-B-fallback-name picker 顯示 B 的 fallback name（一般 name，非空白）');
          assert(pickerHtml.includes('110'), 'BR88-picker-shows-C-110 picker 顯示 C 的 fallback 價格 110');
          assert(!pickerHtml.includes(PROD_PREFIX + 'J'), 'BR89-picker-excludes-J picker 完全沒有出現另一店家的 J 商品');

          // eligible 商品可勾選；F/G/H/I 不可勾選（disabled）
          const rowA = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'A的LINE名稱' });
          const cbA = rowA.locator('input[type="checkbox"]');
          assert(!(await cbA.isDisabled()), 'BR90-eligible-selectable A（eligible）的 checkbox 可以正常勾選');
          for (const k of ['F', 'G', 'H', 'I']) {
            const rowX = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + k });
            const cbX = rowX.locator('input[type="checkbox"]');
            assert(await cbX.isDisabled(), `BR91-${k}-not-selectable ${k}（不合格）的 checkbox 無法勾選（真正 disabled）`);
          }
          await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
        } finally { await h.close(); }
      } finally { await deleteProductMatrix(ids); }
    }

    // ══════════════════════════════════════════════════════════════
    // 十、historical enabled=0 商品 + modal A/B 競態（真實 Chromium）
    // ══════════════════════════════════════════════════════════════
    {
      const campH = await makeCampaign('SLICE5-歷史商品活動-' + Date.now());
      const locH = await makeLocation('SLICE5-歷史商品地點-' + Date.now());
      const histProdRes = await call('POST', '/api/products', { token: T1, body: { name: PROD_PREFIX + 'HIST歷史商品', category: '測試', price: 77 } });
      const histProdId = histProdRes.json.data.id;
      const sHist = await makeSession(campH.id, locH.id, {
        name: 'SLICE5歷史場次-' + Date.now(), product_scope: 'selected',
        products: [{ product_id: histProdId, enabled: 1, quota_qty: 0 }],
      });
      const sOther = await makeSession(campH.id, locH.id, { name: 'SLICE5其他場次-' + Date.now() }); // all_takeout，跟歷史商品無關
      const replacementProdRes = await call('POST', '/api/products', { token: T1, body: { name: PROD_PREFIX + 'HIST替代商品', category: '測試', price: 55 } });
      const replacementProdId = replacementProdRes.json.data.id;

      await call('PUT', `/api/products/${histProdId}`, { token: T1, body: { enabled: 0 } });

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sHist.name, { timeout: 5000 });

        let getProductCalls = 0;
        await h.page.route(`${base}/api/products/${histProdId}`, (route) => { getProductCalls++; return route.continue(); });
        const rowHist = h.page.locator('#ppa-sessions-tbody tr', { hasText: sHist.name });
        await rowHist.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.click('input[name="ppa-session-scope"][value="selected"]').catch(() => {});
        await h.page.waitForFunction(() => document.getElementById('ppa-product-picker-list').textContent.includes('歷史選取'), { timeout: 5000 });
        assert(getProductCalls >= 1, 'BR92-historical-lookup-real-get 編輯歷史 selected 場次時，真實呼叫了 GET /api/products/:id', String(getProductCalls));
        const pickerText = await h.page.locator('#ppa-product-picker-list').textContent();
        assert(pickerText.includes(PROD_PREFIX + 'HIST歷史商品') && pickerText.includes('歷史選取'), 'BR93-historical-labeled-and-visible 歷史失效商品顯示名稱且標示「歷史選取・已停用」', pickerText.slice(0, 200));

        const removeBtn = h.page.locator('#ppa-product-picker-list button', { hasText: '移除' });
        await removeBtn.click();
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
        const afterCancelGet = await call('GET', `/api/popup-pickup/sessions/${sHist.id}`, { token: T1 });
        assert(afterCancelGet.json.data.products.some((p) => p.product_id === histProdId), 'BR94-remove-then-cancel-db-unchanged 按「移除」後取消 modal，DB 仍保留原本的 selected row（移除只改表單 state）', JSON.stringify(afterCancelGet.json.data.products));

        // 真正移除並儲存
        await rowHist.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.waitForFunction(() => document.getElementById('ppa-product-picker-list').textContent.includes('歷史選取'), { timeout: 5000 });
        await h.page.locator('#ppa-product-picker-list button', { hasText: '移除' }).click();
        // production 正確地擋下「selected scope 但零選取商品」的儲存（合理的業務規則：
        // 不能有一個「販售指定商品」的場次卻一項商品都沒選）。要證明「移除」真的持久化，
        // 測試這裡要嘛換成 all_takeout、要嘛補選一個真正合格的商品；選後者更貼近真實
        // 使用情境（移除失效商品、換成別的）。
        const replacementSearch = h.page.locator('#ppa-product-search');
        await replacementSearch.fill(PROD_PREFIX + 'HIST替代商品');
        await h.page.waitForFunction((prefix) => document.getElementById('ppa-product-picker-list').textContent.includes(prefix + 'HIST替代商品'), PROD_PREFIX, { timeout: 3000 });
        const replacementRow = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'HIST替代商品' });
        await replacementRow.locator('input[type="checkbox"]').check();
        await h.page.click('#ppa-session-save-btn');
        await h.page.waitForTimeout(600);
        const afterRemoveSaveGet = await call('GET', `/api/popup-pickup/sessions/${sHist.id}`, { token: T1 });
        assert(!afterRemoveSaveGet.json.data.products.some((p) => p.product_id === histProdId), 'BR95-remove-then-save-db-updated 真正移除並儲存後，fresh GET/DB 確認該商品不再是 selected', JSON.stringify(afterRemoveSaveGet.json.data.products));

        // ── modal A/B 競態（真實瀏覽器）──────────────────────────
        const sHist2 = await makeSession(campH.id, locH.id, {
          name: 'SLICE5競態場次A-' + Date.now(), product_scope: 'selected',
          products: [{ product_id: histProdId, enabled: 1, quota_qty: 0 }],
        });
        await h.page.evaluate(() => ppaLoadSessions());
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody').textContent.includes(n), sHist2.name, { timeout: 5000 });

        let releaseHist;
        const gateHist = new Promise((r) => { releaseHist = r; });
        await h.page.route(`${base}/api/products/${histProdId}`, async (route) => {
          await gateHist;
          return route.continue();
        });
        const rowA2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sHist2.name });
        await rowA2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await new Promise((r) => setTimeout(r, 100));
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
        const rowB2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sOther.name });
        await rowB2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        const bNameBeforeRelease = await h.page.inputValue('#ppa-session-name');
        releaseHist();
        await new Promise((r) => setTimeout(r, 400));
        const bNameAfterRelease = await h.page.inputValue('#ppa-session-name');
        assert(bNameBeforeRelease === sOther.name && bNameAfterRelease === sOther.name, 'BR96-modal-race-b-unaffected 真實瀏覽器中，modal A 晚到的歷史商品 response 沒有覆蓋已經開著的 modal B 的欄位', JSON.stringify({ bNameBeforeRelease, bNameAfterRelease }));
        assert(h.pageErrors.length === 0, 'BR97-modal-race-no-pageerror 競態過程沒有任何 pageerror', JSON.stringify(h.pageErrors));
        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
      } finally {
        await h.close();
        await call('DELETE', `/api/products/${histProdId}`, { token: T1 }).catch(() => {});
        await call('DELETE', `/api/products/${replacementProdId}`, { token: T1 }).catch(() => {});
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 十一、selected picker 真實互動 + payload allowlist（獨立 fixture）
    // ══════════════════════════════════════════════════════════════
    {
      async function mkProd(nameSuffix, price) {
        const r = await call('POST', '/api/products', { token: T1, body: { name: PROD_PREFIX + nameSuffix, category: '測試', price } });
        const id = r.json.data.id;
        await call('PATCH', `/api/products/${id}/line-settings`, { token: T1, body: { line_name: PROD_PREFIX + nameSuffix, line_price: price, show_on_line: 1, line_takeout_enabled: 1 } });
        return id;
      }
      const pidA = await mkProd('SEL選取A', 111);
      const pidB = await mkProd('SEL選取B', 222);
      const pidC = await mkProd('SEL選取C', 333);
      const campSel = await makeCampaign('SLICE6-selected活動-' + Date.now());
      const locSel = await makeLocation('SLICE6-selected地點-' + Date.now());
      const sSel = await makeSession(campSel.id, locSel.id, { name: 'SLICE6selected場次-' + Date.now() });

      const h = await newAdminPage();
      try {
        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sSel.name, { timeout: 5000 });

        const row = h.page.locator('#ppa-sessions-tbody tr', { hasText: sSel.name });
        await row.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.click('input[name="ppa-session-scope"][value="selected"]');
        await h.page.waitForFunction(() => document.getElementById('ppa-product-picker-list').children.length > 0);

        async function searchAndCheck(suffix) {
          await h.page.fill('#ppa-product-search', PROD_PREFIX + suffix);
          await h.page.waitForFunction((t) => document.getElementById('ppa-product-picker-list').textContent.includes(t), PROD_PREFIX + suffix, { timeout: 3000 });
          const r = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + suffix });
          await r.locator('input[type="checkbox"]').check();
        }
        await searchAndCheck('SEL選取A');
        await searchAndCheck('SEL選取B');
        // 搜尋 B 之後，先確認 A 仍在 form state 裡（即使目前搜尋字串把 A 濾掉、不在畫面上）
        let stateAfterB = await h.page.evaluate(() => Object.keys(_PPA.selectedProducts));
        assert(stateAfterB.includes(String(pidA)), 'BR98-search-does-not-lose-prior-selection 搜尋 B 後，先前選取的 A 仍留在 form state（沒被搜尋清掉）', JSON.stringify(stateAfterB));
        await searchAndCheck('SEL選取C');

        await h.page.fill('#ppa-product-search', '');
        await h.page.waitForFunction(() => !document.getElementById('ppa-product-search').value);
        const afterClearHtml = await h.page.locator('#ppa-product-picker-list').innerHTML();
        assert(afterClearHtml.includes('SEL選取A') && afterClearHtml.includes('SEL選取B') && afterClearHtml.includes('SEL選取C'), 'BR99-clear-search-shows-all-three 清除搜尋後 A/B/C 都仍顯示在清單中');
        const checkedStates = await Promise.all(['A', 'B', 'C'].map(async (k) => {
          const cb = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'SEL選取' + k }).locator('input[type="checkbox"]');
          return cb.isChecked();
        }));
        assert(checkedStates.every(Boolean), 'BR100-clear-search-selection-preserved 清除搜尋後 A/B/C 的勾選狀態全部保留', JSON.stringify(checkedStates));

        // 設定 quota：A unlimited（留空）、B=5、C=2
        const qtyB = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'SEL選取B' }).locator('input[type="number"]');
        await qtyB.fill('5');
        const qtyC = h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'SEL選取C' }).locator('input[type="number"]');
        await qtyC.fill('2');

        let saveRequestCount = 0; let lastSaveBody = null;
        await h.page.route(`${base}/api/popup-pickup/sessions/${sSel.id}`, (route) => {
          if (route.request().method() === 'PATCH') { saveRequestCount++; lastSaveBody = route.request().postDataJSON(); }
          return route.continue();
        });
        // pending 中真正 disabled + 同一 event loop 雙擊只送一次
        await h.page.evaluate(() => { const btn = document.getElementById('ppa-session-save-btn'); btn.click(); btn.click(); });
        await h.page.waitForTimeout(600);
        assert(saveRequestCount === 1, 'BR101-selected-save-double-click-single-patch 雙擊儲存仍只送出 1 次真實 PATCH', String(saveRequestCount));

        // payload allowlist 檢查
        const items = lastSaveBody.products;
        assert(Array.isArray(items) && items.length === 3, 'BR102-selected-payload-item-count payload 有恰好 3 個 product item', JSON.stringify(items));
        const allowedKeys = new Set(['product_id', 'enabled', 'quota_qty']);
        const forbiddenKeysFound = items.flatMap((it) => Object.keys(it).filter((k) => !allowedKeys.has(k)));
        assert(forbiddenKeysFound.length === 0, 'BR103-selected-payload-allowlist-only 每個 item 只含 product_id/enabled/quota_qty，沒有 name/price/line_price/takeaway_price/subtotal/total/store_id/public_code/line_eligibility 等欄位', JSON.stringify(forbiddenKeysFound));
        const ids2 = items.map((it) => it.product_id);
        assert(new Set(ids2).size === ids2.length, 'BR104-selected-payload-no-duplicates payload 沒有重複的 product_id', JSON.stringify(ids2));
        assert(items.every((it) => Number.isInteger(it.product_id) && it.product_id > 0), 'BR105-selected-payload-product-id-safe-integer 每個 product_id 都是正整數', JSON.stringify(ids2));
        const bItem = items.find((it) => it.product_id === pidB);
        const cItem = items.find((it) => it.product_id === pidC);
        assert(bItem && bItem.quota_qty === 5 && cItem && cItem.quota_qty === 2, 'BR106-selected-payload-quota-correct B/C 的 quota_qty 分別正確送出 5 與 2', JSON.stringify({ bItem, cItem }));

        // ── 儲存成功後關閉、重開，必須從 fresh server state 還原 ──────
        await h.page.waitForFunction(() => !document.getElementById('ppa-modal-session').classList.contains('active') || getComputedStyle(document.getElementById('ppa-modal-session')).display === 'none', { timeout: 3000 }).catch(() => {});
        await h.page.reload({ waitUntil: 'networkidle' }); // 完全重新整理頁面，確保不是沿用 browser memory
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => { showPage('popup_pickup'); ppaSwitchTab('sessions'); });
        await h.page.waitForFunction((n) => document.getElementById('ppa-sessions-tbody') && document.getElementById('ppa-sessions-tbody').textContent.includes(n), sSel.name, { timeout: 5000 });
        const row2 = h.page.locator('#ppa-sessions-tbody tr', { hasText: sSel.name });
        await row2.locator('button', { hasText: '編輯' }).click();
        await h.page.waitForSelector('#ppa-modal-session', { state: 'visible' });
        await h.page.waitForFunction(() => document.getElementById('ppa-product-picker-list').children.length > 0);
        const reopenHtml = await h.page.locator('#ppa-product-picker-list').innerHTML();
        assert(reopenHtml.includes('SEL選取A') && reopenHtml.includes('SEL選取B') && reopenHtml.includes('SEL選取C'), 'BR107-reopen-restores-from-fresh-server 整頁重新整理、重開 modal 後，A/B/C 仍從真實 server response 還原顯示（不是沿用瀏覽器記憶體）');
        const qtyBAfterReopen = await h.page.locator('#ppa-product-picker-list label', { hasText: PROD_PREFIX + 'SEL選取B' }).locator('input[type="number"]').inputValue();
        assert(qtyBAfterReopen === '5', 'BR108-reopen-quota-restored 重開後 B 的 quota 顯示為 5（來自 fresh GET，不是前端快取）', qtyBAfterReopen);

        // fresh GET/DB 與 UI 一致
        const freshGet = await call('GET', `/api/popup-pickup/sessions/${sSel.id}`, { token: T1 });
        const freshIds = freshGet.json.data.products.map((p) => p.product_id).sort();
        assert(JSON.stringify(freshIds) === JSON.stringify([pidA, pidB, pidC].sort()), 'BR109-fresh-db-matches-ui fresh GET/DB 的 selected product_id 集合與 UI 完全一致', JSON.stringify({ freshIds, expected: [pidA, pidB, pidC] }));

        await h.page.click('#ppa-modal-session .modal-close, #ppa-modal-session button:has-text("取消")').catch(() => {});
      } finally {
        await h.close();
        await call('DELETE', `/api/products/${pidA}`, { token: T1 }).catch(() => {});
        await call('DELETE', `/api/products/${pidB}`, { token: T1 }).catch(() => {});
        await call('DELETE', `/api/products/${pidC}`, { token: T1 }).catch(() => {});
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 十二、真實掛載路由 precheck + 四路 parity + selected checkout authority
    // ══════════════════════════════════════════════════════════════
    {
      const menuProbe = await fetch(`${base}/api/line-menu?store_id=store_001`);
      assert(menuProbe.status !== 404, 'BR110-menu-route-mounted /api/line-menu 真的掛載了 production lineOrderRouter（非 404）', String(menuProbe.status));

      const ids = await createProductMatrix();
      const campP = await makeCampaign('SLICE7-parity活動-' + Date.now());
      const locP = await makeLocation('SLICE7-parity地點-' + Date.now());
      let sessP = await makeSession(campP.id, locP.id, {
        name: 'SLICE7parity場次-' + Date.now(), product_scope: 'selected', max_orders: 0,
        products: [
          { product_id: ids.A, enabled: 1, quota_qty: 0 },
          { product_id: ids.B, enabled: 1, quota_qty: 0 },
          { product_id: ids.C, enabled: 1, quota_qty: 0 },
          { product_id: ids.D, enabled: 1, quota_qty: 0 },
        ],
      });
      sessP = await publishSession(sessP.id, sessP.revision);

      try {
        const adminList = await call('GET', '/api/products/line-products/list', { token: T1 });
        const adminById = {}; adminList.json.data.forEach((p) => { adminById[p.id] = p; });

        const menuRes = await fetch(`${base}/api/line-menu?store_id=store_001`);
        const menuJson = await menuRes.json();
        const menuProducts = menuJson.data && (menuJson.data.products || menuJson.data.categories?.flatMap((c) => c.products || []) || []);
        function findInMenu(pid) { return (menuProducts || []).find((p) => p.id === pid || p.product_id === pid); }

        const pubRes = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
        assert(pubRes.status === 200, 'BR-precheck-parity-public-session popup public session 真實可讀', JSON.stringify(pubRes).slice(0, 150));
        const pubProducts = pubRes.json.data.products || [];
        function findInPublic(pid) { return pubProducts.find((p) => p.product_id === pid); }

        // A：line_name/line_price
        const menuA = findInMenu(ids.A);
        const pubA = findInPublic(ids.A);
        assert(!!pubA && pubA.name === PROD_PREFIX + 'A的LINE名稱' && pubA.price === 120, 'BR111-parity-A-public popup public session 顯示 A 的 line_name/line_price（120），跟 admin 一致', JSON.stringify(pubA));
        if (menuA) assert((menuA.line_name || menuA.name) === (PROD_PREFIX + 'A的LINE名稱'), 'BR112-parity-A-menu 一般 LINE /menu 顯示的 A 名稱與 admin/public 一致', JSON.stringify(menuA));

        // B：fallback name
        const pubB = findInPublic(ids.B);
        assert(!!pubB && pubB.name === PROD_PREFIX + 'B空白名fallback', 'BR113-parity-B-fallback-name-public popup public session 的 B 使用 fallback name（一般 name），跟 admin 一致', JSON.stringify(pubB));

        // C：四路皆 110
        const pubC = findInPublic(ids.C);
        assert(!!pubC && pubC.price === 110, 'BR114-parity-C-110-public popup public session 的 C 價格為 110', JSON.stringify(pubC));
        assert(adminById[ids.C].line_eligibility.price === 110, 'BR115-parity-C-110-admin admin line_eligibility 的 C 價格為 110（跟 public 一致）', String(adminById[ids.C].line_eligibility.price));

        // D：>0 fallback
        const pubD = findInPublic(ids.D);
        assert(!!pubD && pubD.price === adminById[ids.D].line_eligibility.price && pubD.price > 0, 'BR116-parity-D-fallback-consistent D 的 fallback 價格在 admin 與 public 兩路完全一致，且不是 0', JSON.stringify({ pub: pubD, admin: adminById[ids.D].line_eligibility.price }));

        // ── 四路 parity（含真實 order.items[] 逐欄比對，不只比 admin/public）──
        const ABCD_EXPECT = {
          A: { name: PROD_PREFIX + 'A的LINE名稱', price: 120 },
          B: { name: PROD_PREFIX + 'B空白名fallback', price: 130 },
          C: { name: PROD_PREFIX + 'C', price: 110 },
          D: { name: PROD_PREFIX + 'D', price: adminById[ids.D].line_eligibility.price },
        };
        for (const k of ['A', 'B', 'C', 'D']) {
          const exp = ABCD_EXPECT[k];
          const co = await call('POST', '/api/line-orders/popup-checkout', { body: {
            customer_name: 'SLICE7顧客' + k, customer_phone: '0955111' + (200 + 'ABCD'.indexOf(k)), popup_session_public_code: sessP.public_code,
            items: [{ product_id: ids[k], qty: 1 }], payment_method: 'cash',
          }});
          assert(co.status === 201, `BR117-${k}-admin-menu-public-checkout-order-created ${k} 真實 checkout 成功建立 order`, JSON.stringify(co).slice(0, 150));
          const orderId = co.json.data.order_id || co.json.data.id;
          const detail = await call('GET', `/api/orders/${orderId}`, { token: T1 });
          const item = detail.json.data.items && detail.json.data.items.find((it) => it.product_id === ids[k]);
          assert(!!item && item.name === exp.name, `BR118-${k}-admin-menu-public-checkout-item-name order_items 的 ${k} name 與 admin/public 一致（${exp.name}）`, JSON.stringify(item));
          assert(!!item && item.price === exp.price, `BR119-${k}-admin-menu-public-checkout-item-price order_items 的 ${k} unit price 與 admin/public 一致（${exp.price}）`, JSON.stringify(item));
          assert(!!item && item.qty === 1, `BR120-${k}-admin-menu-public-checkout-item-qty order_items 的 ${k} qty 正確為 1`, JSON.stringify(item));
          const lineSubtotal = item.price * item.qty;
          assert(detail.json.data.subtotal === lineSubtotal && detail.json.data.total === lineSubtotal, `BR121-${k}-admin-menu-public-checkout-order-total 單商品 order 的 subtotal/total 與 line subtotal 一致（${lineSubtotal}）`, JSON.stringify({ subtotal: detail.json.data.subtotal, total: detail.json.data.total, lineSubtotal }));
        }

        // ── price/name/store tampering：逐案記錄唯一、精確的結果 ──────
        // 逐一送出：price=1、subtotal=1、total=1、name='FORGED'、store_id=跨店，
        // 每案都直接查真實 order.items，明確判定 production 究竟是「結構化拒絕」
        // 還是「忽略非權威欄位、採用 DB fresh authority」，兩者只能是其中一種、
        // 且必須逐案寫清楚，不能用 A-or-B 的模糊 assertion 蒙混過去。
        const tamperCases = [
          { label: 'price', body: { product_id: ids.A, qty: 1, price: 1 } },
          { label: 'subtotal', body: { product_id: ids.A, qty: 1, subtotal: 1 } },
          { label: 'name', body: { product_id: ids.A, qty: 1, name: 'FORGED' } },
        ];
        for (const tc of tamperCases) {
          const r = await call('POST', '/api/line-orders/popup-checkout', { body: {
            customer_name: 'SLICE7tamper' + tc.label, customer_phone: '0955113' + tamperCases.indexOf(tc),
            popup_session_public_code: sessP.public_code, items: [tc.body], payment_method: 'cash',
          }});
          if (r.status === 201) {
            const tid = r.json.data.order_id || r.json.data.id;
            const td = await call('GET', `/api/orders/${tid}`, { token: T1 });
            const titem = td.json.data.items.find((it) => it.product_id === ids.A);
            const clean = titem.name === PROD_PREFIX + 'A的LINE名稱' && titem.price === 120;
            assert(clean, `BR122-tamper-${tc.label}-ignored-fresh-authority-used production 對 ${tc.label} tampering 採「忽略非權威欄位、用 DB fresh authority」（成功建單但 name/price 仍是真實值）`, JSON.stringify(titem));
          } else {
            assert(r.status >= 400, `BR122-tamper-${tc.label}-structurally-rejected production 對 ${tc.label} tampering 採「結構化拒絕」（真實 status ${r.status}）`, JSON.stringify(r).slice(0, 150));
          }
        }
        // store_id tampering：body 帶一個偽造的 store_id，不得改變 popup public code 自己解析出的 store authority
        const storeIdTamperRes = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7tamperstore', customer_phone: '0955114000', store_id: 'store_002',
          popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash',
        }});
        if (storeIdTamperRes.status === 201) {
          const stid = storeIdTamperRes.json.data.order_id || storeIdTamperRes.json.data.id;
          const std = await call('GET', `/api/orders/${stid}`, { token: T1 }); // T1=store_001；若訂單真的被寫進 store_002，這裡就查不到
          assert(std.status === 200, 'BR123-tamper-store-id-ignored 偽造 body.store_id=store_002 沒有改變 authority，訂單仍屬於 popup code 真正所屬的 store_001（用 store_001 token 查得到）', JSON.stringify(std).slice(0, 150));
        } else {
          assert(storeIdTamperRes.status >= 400, 'BR123-tamper-store-id-ignored 偽造 body.store_id 時 checkout 結構化拒絕', JSON.stringify(storeIdTamperRes).slice(0, 150));
        }

        // ── K：同店 eligible 但未 selected，allowlist authority ─────
        const kRes = await call('POST', '/api/products', { token: T1, body: { name: PROD_PREFIX + 'K未選', category: '測試', price: 88 } });
        const kId = kRes.json.data.id;
        await call('PATCH', `/api/products/${kId}/line-settings`, { token: T1, body: { line_name: PROD_PREFIX + 'K', line_price: 88, show_on_line: 1, line_takeout_enabled: 1 } });
        const pubBeforeK = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
        assert(!pubBeforeK.json.data.products.some((p) => p.product_id === kId), 'BR124-k-not-in-public-before-selected K 尚未被 selected 前，public session 不列出它', JSON.stringify(pubBeforeK.json.data.products.map((p) => p.product_id)));
        const kCheckoutBefore = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7顧客K前', customer_phone: '0955115000', popup_session_public_code: sessP.public_code,
          items: [{ product_id: kId, qty: 1 }], payment_method: 'cash',
        }});
        assert(kCheckoutBefore.status >= 400, 'BR125-k-checkout-rejected-before-selected K 未被 selected 前，真實 checkout 正式拒絕', JSON.stringify(kCheckoutBefore).slice(0, 200));
        const beforeKCount = (await call('GET', `/api/popup-pickup/sessions/${sessP.id}`, { token: T1 })).json.data.order_count;
        const addKRes = await call('PATCH', `/api/popup-pickup/sessions/${sessP.id}`, { token: T1, body: {
          expected_revision: (await call('GET', `/api/popup-pickup/sessions/${sessP.id}`, { token: T1 })).json.data.revision,
          products: [{ product_id: ids.A, enabled: 1, quota_qty: 0 }, { product_id: ids.B, enabled: 1, quota_qty: 0 }, { product_id: ids.C, enabled: 1, quota_qty: 0 }, { product_id: ids.D, enabled: 1, quota_qty: 0 }, { product_id: kId, enabled: 1, quota_qty: 0 }],
          confirm_affected_orders: true, change_reason: 'SLICE7測試：加入K商品',
        }});
        assert(addKRes.status === 200, 'BR-precheck-add-k-to-selected 真實 PATCH 把 K 加入 selected 商品清單', JSON.stringify(addKRes).slice(0, 150));
        const pubAfterK = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
        assert(pubAfterK.json.data.products.some((p) => p.product_id === kId), 'BR126-k-in-public-after-selected K 加入 selected 後，fresh public session 才顯示它', JSON.stringify(pubAfterK.json.data.products.map((p) => p.product_id)));
        const kCheckoutAfter = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7顧客K後', customer_phone: '0955115001', popup_session_public_code: sessP.public_code,
          items: [{ product_id: kId, qty: 1 }], payment_method: 'cash',
        }});
        assert(kCheckoutAfter.status === 201, 'BR127-k-checkout-succeeds-after-selected K 加入 selected 後，真實 checkout 才成功', JSON.stringify(kCheckoutAfter).slice(0, 200));
        await call('DELETE', `/api/products/${kId}`, { token: T1 }).catch(() => {});

        // ── transaction-fresh price：誠實記錄範圍限制 ────────────
        // sql.js 在這個測試環境是單一連線、同步的記憶體 DB，沒有真正的
        // 並行連線可以在「BEGIN 之後、SELECT 之前」從外部插入另一次
        // commit——沒有第二個連線就沒有可以攔截的中間狀態。因此這裡改用
        // 指令允許的退路：證明「先用真實 API 把 C 的價格改掉，再 checkout」
        // 一定採用改過的新值，而不是任何 UI／瀏覽器先前讀到的舊快照值。
        // 這不是「client tampering」測試（client 從未送價格），而是證明
        // checkout 的價格來源是當下 DB 狀態，不是任何呼叫端持有的舊值。
        await call('PATCH', `/api/products/${ids.C}/line-settings`, { token: T1, body: { line_price: 130 } });
        const checkoutCNewPrice = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7顧客C新價', customer_phone: '0955116000', popup_session_public_code: sessP.public_code,
          items: [{ product_id: ids.C, qty: 1 }], payment_method: 'cash',
        }});
        assert(checkoutCNewPrice.status === 201, 'BR128-fresh-price-checkout-succeeds C 改價後 checkout 成功', JSON.stringify(checkoutCNewPrice).slice(0, 150));
        const cNewOrderId = checkoutCNewPrice.json.data.order_id || checkoutCNewPrice.json.data.id;
        const cNewDetail = await call('GET', `/api/orders/${cNewOrderId}`, { token: T1 });
        const cNewItem = cNewDetail.json.data.items.find((it) => it.product_id === ids.C);
        assert(cNewItem && cNewItem.price === 130, 'BR129-fresh-price-uses-current-db-value C 改價（110→130）後真實 checkout 使用的是新的 DB 值（130），不是任何舊快照（110）', JSON.stringify(cNewItem));
        await call('PATCH', `/api/products/${ids.C}/line-settings`, { token: T1, body: { line_price: null } }); // 還原

        // ══════════════════════════════════════════════════════════
        // 成功路徑 store-forgery：用合法 A，證明 forged store hints 被忽略
        // （不是「J 失敗了」代替「A 成功了但 authority 仍正確」）。
        // ══════════════════════════════════════════════════════════
        async function checkoutAAndVerifyStoreAuthority(label, phone, extra, fetchOverride) {
          const before = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
          let r;
          if (fetchOverride) {
            const res = await fetchOverride(phone);
            r = { status: res.status, json: await res.json() };
          } else {
            const bodyExtra = Object.assign({}, extra);
            const queryExtra = bodyExtra.__query;
            delete bodyExtra.__query;
            r = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9' + label, customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash', ...bodyExtra }, ...(queryExtra ? { query: queryExtra } : {}) });
          }
          assert(r.status === 201, `BR-forge-${label}-http-201 合法 A + ${label} forgery：public route ignores untrusted store hints，仍正常回 201`, JSON.stringify(r).slice(0, 200));
          const orderRow = db.get('SELECT id, store_id, items FROM orders WHERE customer_phone=?', [phone]);
          assert(!!orderRow && orderRow.store_id === 'store_001', `BR-forge-${label}-db-store-id authority 真的是從 popup code 解析（raw orders.store_id===store_001），不是 ${label} 裡的偽造值`, JSON.stringify(orderRow && orderRow.store_id));
          const itemsParsed = JSON.parse(orderRow.items || '[]');
          assert(itemsParsed.length === 1 && itemsParsed[0].product_id === ids.A, `BR-forge-${label}-db-items-store001-only order.items 只含 store_001 的 A，沒有摻入 store_002 資料`, JSON.stringify(itemsParsed));
          const allocRow = db.get('SELECT store_id, session_id, product_id FROM popup_order_allocations WHERE order_id=?', [orderRow.id]);
          assert(!!allocRow && allocRow.store_id === 'store_001' && allocRow.session_id === sessP.id && allocRow.product_id === ids.A, `BR-forge-${label}-allocation-store001 allocation 的 store_id/session_id/product_id 全部正確屬於 store_001`, JSON.stringify(allocRow));
          const store002Leftover = db.all('SELECT id FROM orders WHERE store_id=? AND customer_phone=?', ['store_002', phone]);
          assert(store002Leftover.length === 0, `BR-forge-${label}-store002-zero-write store_002 沒有被這次 ${label} forgery 意外寫入任何 order`, JSON.stringify(store002Leftover));
          // 清理：cancel 這張測試訂單，避免佔用 sessP 的 max_orders/quota（sessP max_orders=0=不限量，這裡仍養成習慣性歸還）
          await call('PATCH', `/api/orders/${orderRow.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        }
        await checkoutAAndVerifyStoreAuthority('body', '0955140001', { store_id: 'store_002' });
        await checkoutAAndVerifyStoreAuthority('query', '0955140002', { __query: { store_id: 'store_002' } });
        await checkoutAAndVerifyStoreAuthority('header', '0955140003', null, (phone) => fetch(`${base}/api/line-orders/popup-checkout`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Store-Id': 'store_002' },
          body: JSON.stringify({ customer_name: 'SLICE9header', customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash' }),
        }));
        await checkoutAAndVerifyStoreAuthority('body-query-header-jwt', '0955140004', null, (phone) => fetch(`${base}/api/line-orders/popup-checkout?store_id=store_002`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Store-Id': 'store_002', Authorization: `Bearer ${T2}` },
          body: JSON.stringify({ customer_name: 'SLICE9combo', customer_phone: phone, store_id: 'store_002', popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash' }),
        }));

        // ── nonexistent code + 全部 forged store inputs 同時出現：仍安全 404 ──
        {
          const beforeNE1 = db.all('SELECT id FROM orders WHERE store_id=?', ['store_001']).length;
          const beforeNE2 = db.all('SELECT id FROM orders WHERE store_id=?', ['store_002']).length;
          const neRes = await fetch(`${base}/api/line-orders/popup-checkout?store_id=store_002`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Store-Id': 'store_002', Authorization: `Bearer ${T2}` },
            body: JSON.stringify({ customer_name: 'SLICE9NE', customer_phone: '0955140005', store_id: 'store_002', popup_session_public_code: 'THIS-CODE-DOES-NOT-EXIST-' + Date.now(), items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash' }),
          });
          const neJson = await neRes.json();
          const nonexistentReal = await call('GET', `/api/line-orders/popup-session/THIS-CODE-DOES-NOT-EXIST-${Date.now()}`, {});
          assert(neRes.status === 404, 'BR-nonexistent-code-forged-still-404 不存在的 code + 全部 forged store inputs，仍安全 404（forgery 既不能覆寫也不能補足不存在的 code）', String(neRes.status));
          assert(neJson.error === nonexistentReal.json.error, 'BR-nonexistent-code-forged-same-code 回應 error code 與一般不存在 code 一致', JSON.stringify({ ne: neJson.error, real: nonexistentReal.json.error }));
          const afterNE1 = db.all('SELECT id FROM orders WHERE store_id=?', ['store_001']).length;
          const afterNE2 = db.all('SELECT id FROM orders WHERE store_id=?', ['store_002']).length;
          assert(afterNE1 === beforeNE1 && afterNE2 === beforeNE2, 'BR-nonexistent-code-forged-zero-write 兩店 raw orders 都零寫入', JSON.stringify({ beforeNE1, afterNE1, beforeNE2, afterNE2 }));
        }

        // ══════════════════════════════════════════════════════════
        // total:1 獨立 tampering（不與 price/subtotal/name 混在同一 request）
        // ══════════════════════════════════════════════════════════
        {
          const phone = '0955141001';
          const before = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
          const r = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9total', customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], total: 1, payment_method: 'cash' } });
          assert(r.status === 201 || r.status >= 400, 'BR-tamper-total-http-contract total:1 tampering 的實際 HTTP 結果（唯一值，見 detail）', `status=${r.status}`);
          if (r.status === 201) {
            const orderId = r.json.data.order_id || r.json.data.id;
            const orderRow = db.get('SELECT total, subtotal, items FROM orders WHERE id=?', [orderId]);
            const items = JSON.parse(orderRow.items || '[]');
            const item = items.find((it) => it.product_id === ids.A);
            assert(Number(orderRow.total) !== 1 && Number(orderRow.total) === 120, 'BR-tamper-total-db-authoritative total:1 被忽略，DB 內 orders.total 仍是權威值 120（不是 1）', JSON.stringify(orderRow));
            assert(item && item.price === 120, 'BR-tamper-total-db-authoritative-item item.price 仍是真實值 120', JSON.stringify(item));
            const allocRow = db.get('SELECT store_id, session_id, product_id, qty FROM popup_order_allocations WHERE order_id=?', [orderId]);
            assert(!!allocRow && allocRow.qty === 1, 'BR-tamper-total-allocation-authoritative allocation qty 正確為 1，不受 total tampering 影響', JSON.stringify(allocRow));
            await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
          } else {
            const after = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
            assert(after.orderIds.length === 0 && after.allocRows.length === before.allocRows.length, 'BR-tamper-total-db-authoritative total:1 被結構化拒絕，raw DB 零寫入', JSON.stringify({ before, after }));
          }
        }

        // ══════════════════════════════════════════════════════════
        // qty 非法值矩陣：逐案 raw DB before/after
        // ══════════════════════════════════════════════════════════
        async function tryIllegalQty(label, qtyValue, phoneSuffix) {
          const phone = '09551420' + phoneSuffix;
          const before = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
          const r = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9qty' + label, customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: qtyValue }], payment_method: 'cash' } });
          assert(r.status >= 400, `BR-qty-${label}-http-rejected qty=${label} 真實回 4xx，status=${r.status} code=${r.json && r.json.error}`, JSON.stringify(r).slice(0, 180));
          const after = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
          assert(after.orderIds.length === 0, `BR-qty-${label}-raw-orders-zero-write qty=${label} 拒絕後零新增 order`, JSON.stringify(after.orderIds));
          assert(after.allocRows.length === before.allocRows.length, `BR-qty-${label}-raw-allocations-zero-write qty=${label} 拒絕後 allocation 列數未增加`, JSON.stringify({ before: before.allocRows.length, after: after.allocRows.length }));
        }
        await tryIllegalQty('zero', 0, '01');
        await tryIllegalQty('negative', -1, '02');
        await tryIllegalQty('decimal', 1.5, '03');
        await tryIllegalQty('string-numeric', '1', '04');
        await tryIllegalQty('empty-string', '', '05');
        await tryIllegalQty('whitespace-string', '   ', '06');
        await tryIllegalQty('null', null, '07'); // JSON.stringify 也是 NaN/Infinity 實際落地會變成的值；不另外宣稱測了 NaN/Infinity 本身
        await tryIllegalQty('true', true, '08');
        await tryIllegalQty('false', false, '09');
        await tryIllegalQty('empty-array', [], '10');
        await tryIllegalQty('empty-object', {}, '11');
        await tryIllegalQty('unsafe-integer', Number.MAX_SAFE_INTEGER + 1, '12');

        // ── 合法對照：qty=1/2 成功，數值型別與 subtotal 正確 ──────────
        {
          const phone1 = '0955143001';
          const r1 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9qtylegal1', customer_phone: phone1, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }], payment_method: 'cash' } });
          assert(r1.status === 201, 'BR-qty-legal-1-succeeds qty=1 合法通過（避免驗證器過度封鎖）', JSON.stringify(r1).slice(0, 150));
          const row1 = db.get('SELECT items, subtotal FROM orders WHERE customer_phone=?', [phone1]);
          const item1 = JSON.parse(row1.items)[0];
          assert(Number.isInteger(item1.qty) && item1.qty === 1 && Number(row1.subtotal) === item1.price * item1.qty, 'BR-qty-legal-1-db-correct qty/price/subtotal 在 DB 中型別與數值正確', JSON.stringify({ item1, subtotal: row1.subtotal }));

          const phone2 = '0955143002';
          const r2 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9qtylegal2', customer_phone: phone2, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 2 }], payment_method: 'cash' } });
          assert(r2.status === 201, 'BR-qty-legal-2-succeeds qty=2 合法通過', JSON.stringify(r2).slice(0, 150));
          const allocRow2 = db.get('SELECT qty FROM popup_order_allocations WHERE order_id=?', [r2.json.data.order_id || r2.json.data.id]);
          assert(allocRow2 && allocRow2.qty === 2, 'BR-qty-legal-2-allocation-matches allocation.qty 與 item.qty 一致（2）', JSON.stringify(allocRow2));

          const o1 = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone1]);
          const o2 = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone2]);
          await call('PATCH', `/api/orders/${o1.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
          await call('PATCH', `/api/orders/${o2.id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        }

        // ── duplicate item rows：同一 product 出現兩列，合計是否溢位 ──────
        {
          const phone = '0955144001';
          const before = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
          const rDup = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE9dup', customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: ids.A, qty: 1 }, { product_id: ids.A, qty: 1 }], payment_method: 'cash' } });
          if (rDup.status === 201) {
            const orderId = rDup.json.data.order_id || rDup.json.data.id;
            const row = db.get('SELECT items FROM orders WHERE id=?', [orderId]);
            const items = JSON.parse(row.items);
            const aItems = items.filter((it) => it.product_id === ids.A);
            const totalQty = aItems.reduce((s, it) => s + it.qty, 0);
            const allocRows = db.all('SELECT qty FROM popup_order_allocations WHERE order_id=?', [orderId]);
            const duplicateShapeValid =
              items.length === aItems.length &&
              totalQty === 2 &&
              ((aItems.length === 1 && aItems[0].qty === 2) ||
               (aItems.length === 2 && aItems.every((it) => it.qty === 1)));
            assert(duplicateShapeValid, 'BR-duplicate-item-aggregated-or-kept production 對 duplicate product_id 的真實行為：' + (aItems.length === 1 ? `聚合成單一 row（qty=${totalQty}）` : `保留為 ${aItems.length} 列（各自 qty）`), JSON.stringify({ duplicateShapeValid, itemCount: items.length, aItemCount: aItems.length, quantities: aItems.map((it) => it.qty), totalQty }));
            assert(allocRows.reduce((s, r) => s + r.qty, 0) === totalQty, 'BR-duplicate-item-allocation-matches allocation 總 qty 與 order items 總 qty 一致（沒有雙重配額或短少）', JSON.stringify({ totalQty, allocRows }));
            await call('PATCH', `/api/orders/${orderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
          } else {
            const after = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.A, phoneMarker: phone });
            assert(after.orderIds.length === 0, 'BR-duplicate-item-rejected-zero-write production 對同一 product_id 出現兩列採結構化拒絕，raw DB 零寫入', JSON.stringify(after));
          }
        }

        // ══════════════════════════════════════════════════════════
        // MAX_SAFE_INTEGER 與數值安全邊界
        // ══════════════════════════════════════════════════════════
        await tryIllegalQty('max-safe-integer', Number.MAX_SAFE_INTEGER, '13');
        await tryIllegalQty('max-safe-minus-1', Number.MAX_SAFE_INTEGER - 1, '14');
        // qty 本身是 safe integer，但 price(120) × qty 遠超過 safe integer 範圍
        const unsafeMulQty = Math.floor(Number.MAX_SAFE_INTEGER / 120) + 1000;
        assert(Number.isSafeInteger(unsafeMulQty), 'BR-precheck-unsafe-mul-qty-itself-safe 用來測 price×qty 溢位的 qty 本身仍是 safe integer（不是因為 qty 本身不合法才被擋）', String(unsafeMulQty));
        await tryIllegalQty('price-times-qty-unsafe', unsafeMulQty, '15');

        // ══════════════════════════════════════════════════════════
        // duplicate rows 不得繞過 selected quota
        // ══════════════════════════════════════════════════════════
        {
          const campDQ = await makeCampaign('SLICE10-dupquota活動-' + Date.now());
          const locDQ = await makeLocation('SLICE10-dupquota地點-' + Date.now());
          let sessDQ = await makeSession(campDQ.id, locDQ.id, {
            name: 'SLICE10dupquota場次-' + Date.now(), product_scope: 'selected', max_orders: 0,
            products: [{ product_id: ids.B, enabled: 1, quota_qty: 5 }],
          });
          sessDQ = await publishSession(sessDQ.id, sessDQ.revision);

          // 3+3=6，超過 quota=5，必須拒絕
          const before1 = rawSnapshot({ storeId: 'store_001', sessionId: sessDQ.id, productId: ids.B, phoneMarker: '0955150001' });
          const r1 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE10dq1', customer_phone: '0955150001', popup_session_public_code: sessDQ.public_code, items: [{ product_id: ids.B, qty: 3 }, { product_id: ids.B, qty: 3 }], payment_method: 'cash' } });
          assert(r1.status >= 400, 'BR-dupquota-3plus3-rejected 兩列各 qty=3（合計 6 超過 quota=5）真實拒絕', JSON.stringify(r1).slice(0, 200));
          const after1 = rawSnapshot({ storeId: 'store_001', sessionId: sessDQ.id, productId: ids.B, phoneMarker: '0955150001' });
          assert(after1.orderIds.length === 0 && after1.allocRows.length === before1.allocRows.length, 'BR-dupquota-3plus3-raw-zero-write 拒絕後 raw DB 零寫入', JSON.stringify({ before1, after1 }));

          // 三列 qty=2，合計 6，超過 quota=5，必須拒絕
          const r2 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE10dq2', customer_phone: '0955150002', popup_session_public_code: sessDQ.public_code, items: [{ product_id: ids.B, qty: 2 }, { product_id: ids.B, qty: 2 }, { product_id: ids.B, qty: 2 }], payment_method: 'cash' } });
          assert(r2.status >= 400, 'BR-dupquota-2x3-rejected 三列各 qty=2（合計 6）真實拒絕', JSON.stringify(r2).slice(0, 200));

          // qty=2+3=5，剛好等於 quota，成功
          const r3 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE10dq3', customer_phone: '0955150003', popup_session_public_code: sessDQ.public_code, items: [{ product_id: ids.B, qty: 2 }, { product_id: ids.B, qty: 3 }], payment_method: 'cash' } });
          assert(r3.status === 201, 'BR-dupquota-2plus3-succeeds 兩列 qty=2+3（合計剛好=5）成功', JSON.stringify(r3).slice(0, 150));
          const order3Id = r3.json.data.order_id || r3.json.data.id;
          const alloc3 = db.all('SELECT qty FROM popup_order_allocations WHERE order_id=? AND status=?', [order3Id, 'active']);
          const alloc3Total = alloc3.reduce((s, r) => s + r.qty, 0);
          assert(alloc3Total === 5, 'BR-dupquota-2plus3-allocation-correct allocation aggregate 正確為 5（沒有少配或重複配）', JSON.stringify(alloc3));

          // quota 已滿，再送 qty=1，必須拒絕，DB 不變
          const beforeFull = rawSnapshot({ storeId: 'store_001', sessionId: sessDQ.id, productId: ids.B, phoneMarker: '0955150004' });
          const r4 = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE10dq4', customer_phone: '0955150004', popup_session_public_code: sessDQ.public_code, items: [{ product_id: ids.B, qty: 1 }], payment_method: 'cash' } });
          assert(r4.status >= 400, 'BR-dupquota-exhausted-rejected quota 已用滿後再 checkout qty=1 真實拒絕', JSON.stringify(r4).slice(0, 200));
          const afterFull = rawSnapshot({ storeId: 'store_001', sessionId: sessDQ.id, productId: ids.B, phoneMarker: '0955150004' });
          assert(afterFull.orderIds.length === 0, 'BR-dupquota-exhausted-raw-zero-write 拒絕後零寫入', JSON.stringify(afterFull));

          // cancel 恢復 5（不是 2 或 3）
          await call('PATCH', `/api/orders/${order3Id}/status`, { token: T1, body: { order_status: 'cancelled' } });
          const pubAfterCancel = await call('GET', `/api/line-orders/popup-session/${sessDQ.public_code}`, {});
          const bAfterCancel = pubAfterCancel.json.data.products.find((p) => p.product_id === ids.B);
          assert(bAfterCancel && bAfterCancel.remaining_qty === 5, 'BR-dupquota-cancel-restores-aggregate cancel 後 remaining 恢復完整的 5（不是誤恢復成 2 或 3）', JSON.stringify(bAfterCancel));
        }

        // ══════════════════════════════════════════════════════════
        // 標準 LINE/POS order 路徑對照組（真正 endpoint：POST /api/line-orders）
        // ══════════════════════════════════════════════════════════
        {
          db._db.run('UPDATE products SET line_quota_enabled=1, line_quota_daily=100, line_quota_sold=0 WHERE id=?', [ids.A]);
          db._save();
          const beforeSold = db.get('SELECT line_quota_sold FROM products WHERE id=?', [ids.A]).line_quota_sold;
          // R44.2F.1：Chromium suite 之前沒有 business-calendar fixture，標準 LINE 今日單會被「今日最後接單時間」擋下，
          // 導致結果隨執行時刻改變（Taipei 20:00 之後 317→316，且被 soft-fallback 悄悄當成 PASS）。
          // 這裡與 backend suite 相同：只在建單當下把營業時間設為全天，snapshot／restore 原始 settings 並驗證精確還原。
          const _bcKeys = ['takeout_business_hours', 'takeout_cutoff_time', 'takeout_today_cutoff_time'];
          const _bcSnap = _bcKeys.map((k) => db.get("SELECT value FROM settings WHERE store_id='store_001' AND key=?", [k]));
          const _bcCal = db.all("SELECT key, value FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
          const _allDay = JSON.stringify(Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map((d) => [d, { open: '00:00', close: '23:59', enabled: true }])));
          db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_business_hours',?)", [_allDay]);
          db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','takeout_cutoff_time','')");
          db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
          db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
          db._save();
          const normalOrder = await call('POST', '/api/line-orders', {
            token: T1,
            body: { customer_name: 'SLICE10標準訂單', customer_phone: '0955151001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: ids.A, qty: 1 }] },
          });
          _bcKeys.forEach((k, i) => { if (_bcSnap[i]) db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001',?,?)", [k, _bcSnap[i].value]); else db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key=?", [k]); });
          db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
          _bcCal.forEach((r) => db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001',?,?)", [r.key, r.value]));
          db._save();
          assert(_bcKeys.every((k, i) => { const now = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key=?", [k]); return _bcSnap[i] ? (now && now.value === _bcSnap[i].value) : !now; }), 'BR-business-calendar-fixture-restored-exactly business-hours fixture 使用後 settings 精確還原（與原始 rows 一致）', '');
          if (normalOrder.status === 200 || normalOrder.status === 201) {
            const orderRowDebug = db.get('SELECT id, source, customer_line_id, pickup_time, pickup_type, order_status, status, items FROM orders WHERE customer_phone=?', ['0955151001']);
            const afterSold = db.get('SELECT line_quota_sold FROM products WHERE id=?', [ids.A]).line_quota_sold;
            assert(afterSold === beforeSold + 1, 'BR-standard-order-quota-increments 真正 POST /api/line-orders 建立標準訂單後，line_quota_sold 依原設計 +1（popup 完全不共用這個欄位，兩者互不影響）', `before=${beforeSold} after=${afterSold}`);
            const normalOrderId = orderRowDebug && (orderRowDebug.id || db.get('SELECT id FROM orders WHERE customer_phone=?', ['0955151001']).id);
            const cancelRes = await call('PATCH', `/api/orders/${normalOrderId}/status`, { token: T1, body: { order_status: 'cancelled' } });
            const afterCancelSold = db.get('SELECT line_quota_sold FROM products WHERE id=?', [ids.A]).line_quota_sold;
            assert(afterCancelSold === beforeSold, 'BR-standard-order-cancel-restores 標準訂單 cancel 後，line_quota_sold 依原設計回補', `before=${beforeSold} after=${afterCancelSold}`);
          } else {
            console.log('[note] 標準 LINE order（真正 POST /api/line-orders）在這個測試環境回：' + JSON.stringify(normalOrder).slice(0, 200) + '——記錄第一個正式拒絕原因，未進一步補 fixture 排除它');
            assert(false, 'BR-standard-order-real-endpoint-attempted 已使用真正 production route（POST /api/line-orders，掛載順序與 server.js 一致），不是猜測路徑；實際回應已如實記錄於 console', `status=${normalOrder.status}`);
          }
        }


        // ── E–I：逐商品、逐路徑（admin/menu/public/checkout/DB）獨立驗證 ──
        const menuResE = await fetch(`${base}/api/line-menu?store_id=store_001`);
        const menuJsonE = await menuResE.json();
        const menuProductsE = menuJsonE.data && (menuJsonE.data.products || menuJsonE.data.categories?.flatMap((c) => c.products || []) || []) || [];
        function menuHasProduct(pid) { return menuProductsE.some((p) => (p.id === pid || p.product_id === pid)); }

        // 共用：checkout 應被拒絕的案例，用 raw DB snapshot 精確驗證零寫入
        // （orders/items JSON、allocations、order_logs 分別列出，不合併）。
        async function assertRejectedRawZeroWrite(label, productId, phone) {
          const before = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId, phoneMarker: phone });
          const co = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE8顧客' + label, customer_phone: phone, popup_session_public_code: sessP.public_code, items: [{ product_id: productId, qty: 1 }], payment_method: 'cash' } });
          assert(co.status >= 400 && !!co.json.error, `BR-${label}-checkout-rejected-code ${label} checkout 真實拒絕，status=${co.status} code=${co.json.error}`, JSON.stringify(co).slice(0, 200));
          const after = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId, phoneMarker: phone });
          assert(after.orderIds.length === 0, `BR-${label}-raw-orders-zero-write ${label} 被拒絕後，找不到任何用這個測試 marker（phone=${phone}）建立的 order`, JSON.stringify(after.orderIds));
          assert(after.itemHitCount === 0, `BR-${label}-raw-items-zero-write ${label} 被拒絕後，沒有任何 order.items JSON 含這個 product_id`, String(after.itemHitCount));
          assert(after.allocRows.length === before.allocRows.length, `BR-${label}-raw-allocations-zero-write ${label} 被拒絕後，popup_order_allocations 對這個 session+product 的列數沒有增加`, JSON.stringify({ before: before.allocRows.length, after: after.allocRows.length }));
          assert(after.logRows.length === 0, `BR-${label}-raw-logs-zero-write ${label} 被拒絕後，沒有相關 order_logs 新增`, JSON.stringify(after.logRows));
        }

        // E：enabled=0，admin 根本不出現在一般列表
        {
          const adminListE2 = await call('GET', '/api/products/line-products/list', { token: T1 });
          assert(!adminListE2.json.data.some((p) => p.id === ids.E), 'BR-E-admin-not-orderable E（enabled=0）不出現在 admin 一般 enabled 列表中', String(adminListE2.json.data.some((p) => p.id === ids.E)));
          assert(!menuHasProduct(ids.E), 'BR-E-menu-not-orderable E 不出現在一般 LINE /menu 的可購商品集合', String(menuHasProduct(ids.E)));
          const pubE = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubE.json.data.products.some((p) => p.product_id === ids.E), 'BR-E-public-not-orderable E 不出現在 popup public session 的可購商品清單', JSON.stringify(pubE.json.data.products.map((p) => p.product_id)));
          await assertRejectedRawZeroWrite('E', ids.E, '0955130001');
        }
        // F：show_on_line=0
        {
          const adminListF = await call('GET', '/api/products/line-products/list', { token: T1 });
          const pF = adminListF.json.data.find((p) => p.id === ids.F);
          assert(!!pF && pF.line_eligibility.is_line_takeout_orderable === false, 'BR-F-admin-not-orderable F（show_on_line=0）admin 存在於列表但 is_line_takeout_orderable=false', JSON.stringify(pF && pF.line_eligibility));
          assert(!menuHasProduct(ids.F), 'BR-F-menu-not-orderable F 不出現在一般 LINE /menu 的可購商品集合', String(menuHasProduct(ids.F)));
          const pubF = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubF.json.data.products.some((p) => p.product_id === ids.F), 'BR-F-public-not-orderable F 不出現在 popup public session 的可購商品清單', JSON.stringify(pubF.json.data.products.map((p) => p.product_id)));
          await assertRejectedRawZeroWrite('F', ids.F, '0955130002');
        }
        // G：line_takeout_enabled=0
        {
          const adminListG = await call('GET', '/api/products/line-products/list', { token: T1 });
          const pG = adminListG.json.data.find((p) => p.id === ids.G);
          assert(!!pG && pG.line_eligibility.is_line_takeout_orderable === false, 'BR-G-admin-not-orderable G（line_takeout_enabled=0）admin 列表中 is_line_takeout_orderable=false', JSON.stringify(pG && pG.line_eligibility));
          const pubG = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubG.json.data.products.some((p) => p.product_id === ids.G), 'BR-G-public-not-orderable G 不出現在 popup public session 的可購商品清單', JSON.stringify(pubG.json.data.products.map((p) => p.product_id)));
          await assertRejectedRawZeroWrite('G', ids.G, '0955130003');
        }
        // H：sale_status=sold_out_today
        {
          const adminListH = await call('GET', '/api/products/line-products/list', { token: T1 });
          const pH = adminListH.json.data.find((p) => p.id === ids.H);
          assert(!!pH && pH.line_eligibility.is_line_takeout_orderable === false, 'BR-H-admin-not-orderable H（sold_out_today）admin 列表中 is_line_takeout_orderable=false', JSON.stringify(pH && pH.line_eligibility));
          const pubH = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubH.json.data.products.some((p) => p.product_id === ids.H), 'BR-H-public-not-orderable H 不出現在 popup public session 的可購商品清單', JSON.stringify(pubH.json.data.products.map((p) => p.product_id)));
          await assertRejectedRawZeroWrite('H', ids.H, '0955130004');
        }
        // I：line_sold_out=1
        {
          const adminListI = await call('GET', '/api/products/line-products/list', { token: T1 });
          const pI = adminListI.json.data.find((p) => p.id === ids.I);
          assert(!!pI && pI.line_eligibility.is_line_takeout_orderable === false, 'BR-I-admin-not-orderable I（line_sold_out=1）admin 列表中 is_line_takeout_orderable=false', JSON.stringify(pI && pI.line_eligibility));
          const pubI = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubI.json.data.products.some((p) => p.product_id === ids.I), 'BR-I-public-not-orderable I 不出現在 popup public session 的可購商品清單', JSON.stringify(pubI.json.data.products.map((p) => p.product_id)));
          await assertRejectedRawZeroWrite('I', ids.I, '0955130005');
        }

        // ── J：跨店四路隔離（raw DB，兩店都查）──────────────────────
        {
          const adminListJ = await call('GET', '/api/products/line-products/list', { token: T1 });
          assert(!adminListJ.json.data.some((p) => p.id === ids.J), 'BR-J-admin-not-visible J（跨店）不出現在 store_001 的 admin 列表', String(adminListJ.json.data.some((p) => p.id === ids.J)));
          assert(!menuHasProduct(ids.J), 'BR-J-menu-not-visible J 不出現在一般 LINE /menu', String(menuHasProduct(ids.J)));
          const pubJ = await call('GET', `/api/line-orders/popup-session/${sessP.public_code}`, {});
          assert(!pubJ.json.data.products.some((p) => p.product_id === ids.J), 'BR-J-public-not-visible J 不出現在 popup public session', JSON.stringify(pubJ.json.data.products.map((p) => p.product_id)));

          const beforeJ1 = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.J, phoneMarker: '0955130006' });
          const coJ = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE8顧客J', customer_phone: '0955130006', popup_session_public_code: sessP.public_code, items: [{ product_id: ids.J, qty: 1 }], payment_method: 'cash' } });
          assert(coJ.status >= 400, `BR-J-checkout-rejected J（跨店）checkout 真實拒絕，status=${coJ.status}`, JSON.stringify(coJ).slice(0, 200));
          const rawJStr = JSON.stringify(coJ.json);
          assert(!rawJStr.includes(PROD_PREFIX + 'J') && !rawJStr.includes('store_002'), 'BR-J-response-no-leak checkout 拒絕的 response 不洩漏 J 的名稱或 store_002', rawJStr.slice(0, 200));
          const afterJ1 = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.J, phoneMarker: '0955130006' });
          assert(afterJ1.orderIds.length === 0, 'BR-J-raw-orders-zero-write-store001 J 被拒絕後，store_001 沒有任何用這個 marker 建立的 order', JSON.stringify(afterJ1.orderIds));
          assert(afterJ1.allocRows.length === beforeJ1.allocRows.length, 'BR-J-raw-allocations-zero-write-store001 J 被拒絕後，store_001 對應 session 的 allocation 列數沒有增加', JSON.stringify({ before: beforeJ1.allocRows.length, after: afterJ1.allocRows.length }));
          // store_002 本身也不得因為這次（失敗的）跨店嘗試而多出任何 order
          const store002OrdersAfter = db.all('SELECT id FROM orders WHERE store_id=? AND customer_phone=?', ['store_002', '0955130006']);
          assert(store002OrdersAfter.length === 0, 'BR-J-raw-orders-zero-write-store002 store_002 也沒有被意外寫入任何 order', JSON.stringify(store002OrdersAfter));

          // ── store authority forgery：body / query / header，逐一獨立測試 ──
          const beforeForgeBody = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.J, phoneMarker: '0955130007' });
          const coJForgedBody = await call('POST', '/api/line-orders/popup-checkout', { body: { customer_name: 'SLICE8顧客Jforge', customer_phone: '0955130007', store_id: 'store_002', popup_session_public_code: sessP.public_code, items: [{ product_id: ids.J, qty: 1 }], payment_method: 'cash' } });
          assert(coJForgedBody.status >= 400, 'BR-J-forged-body-store-id-rejected 偽造 body.store_id=store_002 仍無法讓 J 通過 checkout（ignored input，public route 本來就自己從 popup code 解析 store）', JSON.stringify(coJForgedBody).slice(0, 200));
          const afterForgeBody = rawSnapshot({ storeId: 'store_001', sessionId: sessP.id, productId: ids.J, phoneMarker: '0955130007' });
          assert(afterForgeBody.orderIds.length === 0, 'BR-J-forged-body-raw-zero-write body.store_id 偽造被拒絕後，raw DB 沒有任何新 order', JSON.stringify(afterForgeBody.orderIds));

          const coJForgedQuery = await call('POST', '/api/line-orders/popup-checkout', { query: { store_id: 'store_002' }, body: { customer_name: 'SLICE8顧客Jforgeq', customer_phone: '0955130008', popup_session_public_code: sessP.public_code, items: [{ product_id: ids.J, qty: 1 }], payment_method: 'cash' } });
          assert(coJForgedQuery.status >= 400, 'BR-J-forged-query-store-id-rejected 偽造 query.store_id=store_002 仍無法讓 J 通過 checkout（ignored input：popup-public.js 的 checkout route 本來就不讀 query.store_id，是靠 popup code 反查店家）', JSON.stringify(coJForgedQuery).slice(0, 200));
          const afterForgeQuery = db.all('SELECT id FROM orders WHERE customer_phone=?', ['0955130008']);
          assert(afterForgeQuery.length === 0, 'BR-J-forged-query-raw-zero-write query.store_id 偽造被拒絕後，raw DB 沒有任何新 order', JSON.stringify(afterForgeQuery));

          const coJForgedHeader = await fetch(`${base}/api/line-orders/popup-checkout`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Store-Id': 'store_002' },
            body: JSON.stringify({ customer_name: 'SLICE8顧客Jforgeh', customer_phone: '0955130009', popup_session_public_code: sessP.public_code, items: [{ product_id: ids.J, qty: 1 }], payment_method: 'cash' }),
          });
          const coJForgedHeaderJson = await coJForgedHeader.json();
          assert(coJForgedHeader.status >= 400, 'BR-J-forged-header-store-id-rejected 偽造 X-Store-Id: store_002 header（popup public route 根本不是這個 header 的正式輸入，ignored input）仍無法讓 J 通過 checkout', JSON.stringify(coJForgedHeaderJson).slice(0, 200));
          const afterForgeHeader = db.all('SELECT id FROM orders WHERE customer_phone=?', ['0955130009']);
          assert(afterForgeHeader.length === 0, 'BR-J-forged-header-raw-zero-write 偽造 header 被拒絕後，raw DB 沒有任何新 order', JSON.stringify(afterForgeHeader));
        }

        // ── selected quota 實際扣用：B quota=5 ─────────────────────
        const campQ = await makeCampaign('SLICE7-quota活動-' + Date.now());
        const locQ = await makeLocation('SLICE7-quota地點-' + Date.now());
        let sessQ = await makeSession(campQ.id, locQ.id, {
          name: 'SLICE7quota場次-' + Date.now(), product_scope: 'selected', max_orders: 0,
          products: [{ product_id: ids.B, enabled: 1, quota_qty: 5 }],
        });
        sessQ = await publishSession(sessQ.id, sessQ.revision);
        const pubQBefore = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bBefore = pubQBefore.json.data.products.find((p) => p.product_id === ids.B);
        assert(bBefore && bBefore.remaining_qty === 5, 'BR132-quota-initial-remaining-5 B 初始 remaining_qty 正確為 5', JSON.stringify(bBefore));

        const qOrder1 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7quota顧客1', customer_phone: '0955222001', popup_session_public_code: sessQ.public_code,
          items: [{ product_id: ids.B, qty: 2 }], payment_method: 'cash',
        }});
        assert(qOrder1.status === 201, 'BR133-quota-checkout-qty2-succeeds qty=2 checkout 成功（未超過 quota）', JSON.stringify(qOrder1).slice(0, 150));
        const qOrder1Id = qOrder1.json.data.order_id || qOrder1.json.data.id;

        const qOrder2 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7quota顧客2', customer_phone: '0955222002', popup_session_public_code: sessQ.public_code,
          items: [{ product_id: ids.B, qty: 3 }], payment_method: 'cash',
        }});
        assert(qOrder2.status === 201, 'BR134-quota-checkout-qty3-fills-exactly 再 qty=3 成功，剛好用滿 5', JSON.stringify(qOrder2).slice(0, 150));

        const pubQFull = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bFull = pubQFull.json.data.products.find((p) => p.product_id === ids.B);
        assert(bFull && bFull.remaining_qty === 0 && bFull.sold_out === true, 'BR135-quota-fully-used 用滿後 remaining_qty=0 且 sold_out=true', JSON.stringify(bFull));

        const qOrder3 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7quota顧客3', customer_phone: '0955222003', popup_session_public_code: sessQ.public_code,
          items: [{ product_id: ids.B, qty: 1 }], payment_method: 'cash',
        }});
        assert(qOrder3.status >= 400, 'BR136-quota-exceeded-rejected 再 qty=1 超過剩餘配額，真實拒絕', JSON.stringify(qOrder3).slice(0, 200));

        // cancel 釋放 allocation
        await call('PATCH', `/api/orders/${qOrder1Id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const pubQAfterCancel = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterCancel = pubQAfterCancel.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterCancel && bAfterCancel.remaining_qty === 2, 'BR137-quota-released-after-cancel 取消 qty=2 的訂單後，remaining_qty 正確恢復為 2', JSON.stringify(bAfterCancel));

        // 重複 cancel 不得重複釋放
        await call('PATCH', `/api/orders/${qOrder1Id}/status`, { token: T1, body: { order_status: 'cancelled' } });
        const pubQAfterDoubleCancel = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterDoubleCancel = pubQAfterDoubleCancel.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterDoubleCancel && bAfterDoubleCancel.remaining_qty === 2, 'BR138-quota-double-cancel-no-double-release 對同一張訂單重複執行取消，remaining_qty 仍是 2（不會變成 4）', JSON.stringify(bAfterDoubleCancel));

        // 重新 checkout qty=2 → remaining=0，再 void
        const qOrder4 = await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7quota顧客4', customer_phone: '0955222004', popup_session_public_code: sessQ.public_code,
          items: [{ product_id: ids.B, qty: 2 }], payment_method: 'cash',
        }});
        assert(qOrder4.status === 201, 'BR139-quota-recheckout-succeeds 重新 checkout qty=2 成功', JSON.stringify(qOrder4).slice(0, 150));
        const qOrder4Id = qOrder4.json.data.order_id || qOrder4.json.data.id;
        const pubQAfterRecheckout = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterRecheckout = pubQAfterRecheckout.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterRecheckout && bAfterRecheckout.remaining_qty === 0, 'BR140-quota-recheckout-fills-again 重新 checkout 後 remaining_qty 再次變為 0', JSON.stringify(bAfterRecheckout));

        const voidRes4 = await call('POST', `/api/orders/${qOrder4Id}/void`, { token: T1, body: { reason: 'SLICE7測試作廢', operator: 'test' } });
        assert(voidRes4.status === 200, 'BR141-quota-void-succeeds 真實 void 該訂單成功', JSON.stringify(voidRes4).slice(0, 150));
        const pubQAfterVoid = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterVoid = pubQAfterVoid.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterVoid && bAfterVoid.remaining_qty === 2, 'BR142-quota-released-after-void void 後 remaining_qty 正確恢復為 2', JSON.stringify(bAfterVoid));

        // 重複 void 不得重複釋放
        const voidRes4Again = await call('POST', `/api/orders/${qOrder4Id}/void`, { token: T1, body: { reason: '重複作廢測試', operator: 'test' } });
        const pubQAfterDoubleVoid = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterDoubleVoid = pubQAfterDoubleVoid.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterDoubleVoid && bAfterDoubleVoid.remaining_qty === 2, 'BR143-quota-double-void-no-double-release 對同一張訂單重複 void，remaining_qty 仍是 2（不會變成 4）', JSON.stringify(bAfterDoubleVoid));

        // 另一 session 使用同商品 B，不影響本 session 的 remaining
        const campQ2 = await makeCampaign('SLICE7-quota隔離活動-' + Date.now());
        const locQ2 = await makeLocation('SLICE7-quota隔離地點-' + Date.now());
        let sessQ2 = await makeSession(campQ2.id, locQ2.id, {
          name: 'SLICE7quota隔離場次-' + Date.now(), product_scope: 'selected', max_orders: 0,
          products: [{ product_id: ids.B, enabled: 1, quota_qty: 5 }],
        });
        sessQ2 = await publishSession(sessQ2.id, sessQ2.revision);
        await call('POST', '/api/line-orders/popup-checkout', { body: {
          customer_name: 'SLICE7quota隔離顧客', customer_phone: '0955222999', popup_session_public_code: sessQ2.public_code,
          items: [{ product_id: ids.B, qty: 3 }], payment_method: 'cash',
        }});
        const pubQAfterOtherSession = await call('GET', `/api/line-orders/popup-session/${sessQ.public_code}`, {});
        const bAfterOtherSession = pubQAfterOtherSession.json.data.products.find((p) => p.product_id === ids.B);
        assert(bAfterOtherSession && bAfterOtherSession.remaining_qty === 2, 'BR144-quota-cross-session-isolation 另一個 session 對同一商品 B 的 allocation，完全不影響本 session 的 remaining_qty', JSON.stringify(bAfterOtherSession));
      } finally {
        await deleteProductMatrix(ids);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 3C-A：Links/QR/XSS/external-resource resilience
    // Reality Audit（記錄）：
    //   - Links tab：window.ppaLoadLinksTab() → ppaRenderLinksTab()，店家卡片
    //     從 window.currentStore.store_id 組 `${origin}/popup-order?store_id=`；
    //     每個 session 卡片的 blocked reason 來自 ppaShareBlockedReason(status)，
    //     session 自己 status 優先於 campaign status；未 blocked 才渲染
    //     ppaLinkRow()（session 直達網址 `?session=public_code`、活動入口
    //     `?campaign=public_code`，皆用 encodeURIComponent 包 server
    //     public_code，不是用內部數字 id）。
    //   - Copy：ppaCopyText() 用真實 navigator.clipboard.writeText()。
    //   - Open／Test：兩個按鈕都是 window.open(url,'_blank','noopener,noreferrer')，
    //     「以顧客身分測試」沒有額外 confirm dialog，警示文字只是卡片內
    //     一行文字。
    //   - QR：ppaShowQr(url) 用同源 vendor library（/js/qrcode.min.js，不是
    //     unpkg／外部 CDN），已載入就直接 new QRCode(container,{...})；
    //     若 `typeof QRCode === 'undefined'` 才動態插入 <script src="/js/qrcode.min.js">，
    //     onerror 時把 container.textContent 設成「QR Code 產生失敗，請使用複製網址功能」。
    //   - Google Maps：ppaOpenMap() 固定用
    //     'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(...)。
    //   - 兩個欄位（campaign name、location name/address）的渲染全部用
    //     DOM textContent／.value，沒有找到 innerHTML 字串拼接。
    // ═══════════════════════════════════════════════════════════════════
    {
      const h = await newAdminPage();
      try {
        // ── 一／二：Links fixture matrix（六種狀態，各自獨立 public_code）──
        // R24 B-A1：先建立全部 fixture、以每個狀態 mutation 的成功 response 作為最終資料，再於第一次
        // goto／showPage 之前註冊兩個精確 GET route；本流程只執行一次 goto 與一次 showPage。舊流程先
        // showPage 再建 fixture，第一次 fetch 已把 PPA 快取填滿，route 永遠不會命中（R22 Reality Audit）。
        // window._PPA 只用於 readiness，資料仍走真實 ppaInit → fetch → ppaRenderLinksTab。
        const tag = 'L3CA' + Date.now();
        const campPub = await makeCampaign(tag + '已發布活動');
        const locPub = await makeLocation(tag + '地點');
        let sessPub = await makeSession(campPub.id, locPub.id, { name: tag + '已發布場次', pickup_date: taipeiDateStr(1), order_cutoff_at: `${taipeiDateStr(1)}T09:00` });
        sessPub = await publishSession(sessPub.id, sessPub.revision);

        const campDraftRes = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: tag + '草稿活動' } });
        const campDraft = campDraftRes.json.data;
        const sessDraft = await makeSession(campDraft.id, locPub.id, { name: tag + '草稿場次', pickup_date: taipeiDateStr(1), order_cutoff_at: `${taipeiDateStr(1)}T09:00` });

        let campPaused = await makeCampaign(tag + '暫停活動');
        let sessForPause = await makeSession(campPaused.id, locPub.id, { name: tag + '暫停場次', pickup_date: taipeiDateStr(1), order_cutoff_at: `${taipeiDateStr(1)}T09:00` });
        sessForPause = await publishSession(sessForPause.id, sessForPause.revision);
        const pausePatchResult = await call('PATCH', `/api/popup-pickup/campaigns/${campPaused.id}`, { token: T1, body: { status: 'paused' } });
        campPaused = pausePatchResult.json.data;

        const campForCancel = await makeCampaign(tag + '取消母活動');
        let sessCancel = await makeSession(campForCancel.id, locPub.id, { name: tag + '取消場次', pickup_date: taipeiDateStr(1), order_cutoff_at: `${taipeiDateStr(1)}T09:00` });
        sessCancel = await publishSession(sessCancel.id, sessCancel.revision);
        const cancelPatchResult = await call('PATCH', `/api/popup-pickup/sessions/${sessCancel.id}`, { token: T1, body: { expected_revision: sessCancel.revision, status: 'cancelled' } });
        sessCancel = cancelPatchResult.json.data;

        let campArchive = await makeCampaign(tag + '封存活動');
        let sessArchive = await makeSession(campArchive.id, locPub.id, { name: tag + '封存場次', pickup_date: taipeiDateStr(1), order_cutoff_at: `${taipeiDateStr(1)}T09:00` });
        sessArchive = await publishSession(sessArchive.id, sessArchive.revision);
        const archivePatchResult = await call('PATCH', `/api/popup-pickup/campaigns/${campArchive.id}`, { token: T1, body: { status: 'archived' } });
        campArchive = archivePatchResult.json.data;

        const fixtureSessions = [sessPub, sessDraft, sessForPause, sessCancel, sessArchive];
        const fixtureCampaigns = [campPub, campDraft, campPaused, campForCancel, campArchive];
        {
          const expectSessionStatus = ['published', 'draft', 'published', 'cancelled', 'published'];
          const expectCampaignStatus = ['published', 'draft', 'paused', 'published', 'archived'];
          const setupProblems = [];
          [['campDraft', campDraftRes, 201], ['pause', pausePatchResult, 200], ['cancel', cancelPatchResult, 200], ['archive', archivePatchResult, 200]].forEach(([k, r, st]) => { if (!r || r.status !== st || !r.json || !r.json.data) setupProblems.push(k + ':' + (r && r.status)); });
          fixtureSessions.forEach((s, i) => { if (!s || s.status !== expectSessionStatus[i] || !s.public_code || !fixtureCampaigns[i] || s.campaign_id !== fixtureCampaigns[i].id) setupProblems.push('session' + i + ':' + (s && s.status)); });
          fixtureCampaigns.forEach((c, i) => { if (!c || c.status !== expectCampaignStatus[i] || !c.public_code) setupProblems.push('campaign' + i + ':' + (c && c.status)); });
          if (setupProblems.length) throw new Error('Links fixture setup failed: ' + JSON.stringify(setupProblems));
        }

        const linksRouteHits = { campaigns: 0, sessions: 0 };
        const linksCampaignsUrl = (u) => u.pathname === '/api/popup-pickup/campaigns' && u.search === '';
        const linksSessionsUrl = (u) => u.pathname === '/api/popup-pickup/sessions' && u.search === '?limit=100';
        const linksCampaignsHandler = (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          linksRouteHits.campaigns++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: fixtureCampaigns }) });
        };
        const linksSessionsHandler = (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          linksRouteHits.sessions++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: fixtureSessions }) });
        };
        await h.page.route(linksCampaignsUrl, linksCampaignsHandler);
        await h.page.route(linksSessionsUrl, linksSessionsHandler);

        await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 5000 });
        await h.page.evaluate(() => showPage('popup_pickup'));
        await h.page.waitForFunction(() => window._PPA && window._PPA.joinSessionsLoaded === true && window._PPA.campaigns.length > 0, null, { timeout: 8000 });
        await h.page.evaluate(() => ppaSwitchTab && ppaSwitchTab('links'));
        await h.page.waitForFunction(() => { const b = document.getElementById('ppa-links-list'); return b && !b.textContent.includes('載入中'); }, { timeout: 8000 });

        // store 入口卡片
        const storeUrlText = await h.page.evaluate(() => { const rows = [...document.querySelectorAll('#ppa-links-list > div')]; const storeCard = rows.find((r) => r.textContent.includes('店家入口')); const span = storeCard && storeCard.querySelector('span[style*="word-break"]'); return span ? span.textContent : null; });
        assert(!!storeUrlText && storeUrlText.startsWith(`${base}/popup-order?store_id=`), 'LINK-store-entry-url-authority 店家入口 URL 以真實 store_id 組成、same-origin', storeUrlText);
        assert(!/Authorization|token|localStorage|jwt/i.test(storeUrlText), 'LINK-store-entry-no-token 店家入口 URL 不含 admin token／Authorization／localStorage 字樣', storeUrlText);

        async function cardFor(sessName) {
          return h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); return c ? c.outerHTML : null; }, sessName);
        }
        const pubCardHtml = await cardFor(tag + '已發布場次');
        const linksRendered = await h.page.evaluate(() => ({ titles: [...document.querySelectorAll('#ppa-links-list > div')].map((d) => (d.firstChild && d.firstChild.textContent) || '').filter((t) => !t.startsWith('店家入口')), joinSessionsLoaded: !!(window._PPA && window._PPA.joinSessionsLoaded), campaignsLoaded: !!(window._PPA && window._PPA.campaigns.length > 0) }));
        const linksRenderedFromFixtures = linksRendered.titles.length === fixtureSessions.length && fixtureSessions.every((s, i) => linksRendered.titles[i].startsWith(s.name + '（'));
        assert(linksRouteHits.campaigns === 1 && linksRouteHits.sessions === 1 && linksRenderedFromFixtures && !!pubCardHtml && pubCardHtml.includes(`session=${encodeURIComponent(sessPub.public_code)}`) && pubCardHtml.includes(`campaign=${encodeURIComponent(campPub.public_code)}`), 'LINK-published-urls-use-public-code 已發布 session 卡片的 session／campaign URL 都使用真實 server public_code（不是內部數字 id）', JSON.stringify({ routeHits: linksRouteHits, joinSessionsLoaded: linksRendered.joinSessionsLoaded, campaignsLoaded: linksRendered.campaignsLoaded, renderedFromFixtures: linksRenderedFromFixtures, cardFound: !!pubCardHtml, sessionStatuses: fixtureSessions.map((s) => s.status), campaignStatuses: fixtureCampaigns.map((c) => c.status) }));
        assert(!new RegExp(`[?&](session|campaign)=${sessPub.id}\\b`).test(pubCardHtml || '') && !new RegExp(`[?&](session|campaign)=${campPub.id}\\b`).test(pubCardHtml || ''), 'LINK-published-no-internal-id URL 不含內部數字 id', '');
        assert(!/Authorization|localStorage|jwt/i.test(pubCardHtml || ''), 'LINK-published-no-token URL／卡片不含 admin token 相關字樣', '');

        // 五：blocked-state matrix（draft/paused/cancelled/archived）
        for (const [label, name, reasonFrag] of [['draft', tag + '草稿場次', '草稿'], ['paused', tag + '暫停場次', '暫停'], ['cancelled', tag + '取消場次', '取消'], ['archived', tag + '封存場次', '封存']]) {
          const html = await cardFor(name);
          assert(!!html && html.includes('不可分享') && html.includes(reasonFrag), `LINK-blocked-${label}-reason ${label} 狀態卡片顯示精確 blocked reason（含「${reasonFrag}」）`, html ? html.slice(0, 200) : 'not found');
          assert(html && !html.includes('複製') && !html.includes('開啟') && !html.includes('QR Code'), `LINK-blocked-${label}-no-controls ${label} 狀態卡片不渲染 copy/open/QR 控制`, '');
        }
        // active session 控制仍可用（沒有 over-block）
        {
          const activeHtml = pubCardHtml;
          assert(activeHtml.includes('複製') && activeHtml.includes('開啟') && activeHtml.includes('QR Code') && activeHtml.includes('以顧客身分測試'), 'LINK-active-not-over-blocked 已發布 session 的 copy/open/QR/test 控制全部正常渲染（沒有過度封鎖）', '');
        }

        // ── 三／四：Copy／Open（真實 clipboard permission + 真實 popup 事件）──
        await h.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const sessionUrlExpected = `${base}/popup-order?session=${encodeURIComponent(sessPub.public_code)}`;
        await h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('複製')).click(); }, tag + '已發布場次');
        await h.page.waitForTimeout(200);
        const clipboardVal = await h.page.evaluate(() => navigator.clipboard.readText());
        assert(clipboardVal === sessionUrlExpected, 'LINK-copy-exact copy 後 clipboard 精確等於畫面上的 session URL（不是 hidden token 或別列 URL）', JSON.stringify({ clipboardVal, sessionUrlExpected }));

        const [newPage] = await Promise.all([
          h.context.waitForEvent('page'),
          h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('開啟')).click(); }, tag + '已發布場次'),
        ]);
        await newPage.waitForLoadState('domcontentloaded').catch(() => {});
        assert(newPage.url() === sessionUrlExpected || newPage.url() === sessionUrlExpected + '', 'LINK-open-exact-url 真實 new page 事件，URL 精確等於 session URL', newPage.url());
        const openerIsNull = await newPage.evaluate(() => window.opener === null);
        assert(openerIsNull, 'LINK-open-noopener window.opener === null（noopener 生效）', '');
        await newPage.close();

        // Test 按鈕：開真實 public 頁、不自動建立 order
        const q0ForTest = db.get(`SELECT COUNT(*) AS c FROM orders`).c;
        const [testPage] = await Promise.all([
          h.context.waitForEvent('page'),
          h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('以顧客身分測試')).click(); }, tag + '已發布場次'),
        ]);
        await testPage.waitForLoadState('domcontentloaded').catch(() => {});
        assert(testPage.url() === sessionUrlExpected, 'LINK-test-opens-real-public-page Test 按鈕開啟真實 public 頁（不是 admin-auth preview）', testPage.url());
        assert(db.get(`SELECT COUNT(*) AS c FROM orders`).c === q0ForTest, 'LINK-test-no-auto-order 僅開啟頁面不自動建立 order（raw DB order count 不變）', '');
        await testPage.close();

        // forged DOM dataset 不能改變 server public_code authority：竄改卡片 dataset 後點擊該卡片真實的「複製」按鈕，
        // clipboard 仍必須精確等於 session URL（copy handler 用 render 時的 URL，不讀 dataset）。
        await h.page.evaluate(() => navigator.clipboard.writeText('clipboard-before-forged-copy'));
        const forgedApplied = await h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); if (!c) return null; c.dataset.forgedPublicCode = 'evil-code'; return c.dataset.forgedPublicCode; }, tag + '已發布場次');
        await h.page.locator('#ppa-links-list > div', { hasText: tag + '已發布場次' }).locator('button', { hasText: '複製' }).first().click();
        await h.page.waitForFunction(async () => (await navigator.clipboard.readText()) !== 'clipboard-before-forged-copy', null, { timeout: 5000 }).catch(() => {});
        const clipAfterForge = await h.page.evaluate(() => navigator.clipboard.readText());
        assert(forgedApplied === 'evil-code' && clipAfterForge === sessionUrlExpected, 'LINK-forged-dataset-no-effect 竄改 DOM dataset 不影響卡片顯示的真實 public_code URL', JSON.stringify({ forgedApplied, clipAfterForge, sessionUrlExpected }));
        await h.page.unroute(linksSessionsUrl, linksSessionsHandler).catch(() => {}); // Links 檢查結束即解除，避免影響本頁後續 QR 操作
        await h.page.unroute(linksCampaignsUrl, linksCampaignsHandler).catch(() => {});

        // ── 六：QR 正常路徑（真實 browser canvas）──
        const qrExternalStart = h.externalHosts.length;
        await h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('QR Code')).click(); }, tag + '已發布場次');
        await h.page.waitForFunction(() => { const el = document.getElementById('ppa-modal-qr'); return el && getComputedStyle(el).display !== 'none'; }, { timeout: 5000 });
        await h.page.waitForFunction(() => { const c = document.getElementById('ppa-qr-container'); return c && c.children.length > 0; }, { timeout: 5000 });
        const qrInfo = await h.page.evaluate(() => {
          const c = document.getElementById('ppa-qr-container');
          const canvas = c.querySelector('canvas'), img = c.querySelector('img'), table = c.querySelector('table');
          const urlText = document.getElementById('ppa-qr-url').textContent;
          let ctxOk = null, rasterHasVariation = null;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            ctxOk = ctx !== null && typeof ctx.getImageData === 'function';
            if (ctxOk) {
              const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let minLum = 255, maxLum = 0, opaque = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] === 0) continue;
                opaque++;
                const lum = Math.round((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
                if (lum < minLum) minLum = lum;
                if (lum > maxLum) maxLum = lum;
              }
              rasterHasVariation = opaque > 0 && minLum < 64 && maxLum > 191;
            }
          }
          return { hasCanvas: !!canvas, hasImg: !!img, hasTable: !!table, urlText, ctxOk, rasterHasVariation };
        });
        assert(qrInfo.hasCanvas || qrInfo.hasImg || qrInfo.hasTable, 'QR-container-renders-real-element QR container 真的產生 canvas/img/table 之一（非空容器）', JSON.stringify(qrInfo));
        assert(qrInfo.urlText === sessionUrlExpected, 'QR-encoded-url-matches QR 對應的顯示網址精確等於 session URL', JSON.stringify({ urlText: qrInfo.urlText, sessionUrlExpected }));
        if (qrInfo.hasCanvas) assert(qrInfo.ctxOk === true && qrInfo.rasterHasVariation === true, 'QR-real-browser-canvas-context getContext(2d) 是真實非 null 的 browser canvas context，且 raster 同時含深淺像素（非空白 canvas／jsdom polyfill）', JSON.stringify(qrInfo));
        await h.page.waitForTimeout(100);
        const qrExternalRequests = h.externalHosts.slice(qrExternalStart);
        assert(qrExternalRequests.length === 0, 'QR-generator-no-external-request QR 產生器不向任何第三方 host 傳送 session URL', JSON.stringify(qrExternalRequests));
        // close/reopen 不疊加
        await h.page.evaluate(() => ppaCloseQrModal());
        await h.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('QR Code')).click(); }, tag + '已發布場次');
        await h.page.waitForFunction(() => { const c = document.getElementById('ppa-qr-container'); return c && c.children.length > 0; }, { timeout: 5000 });
        const childCountAfterReopen = await h.page.evaluate(() => document.getElementById('ppa-qr-container').children.length);
        assert(childCountAfterReopen <= 2, 'QR-reopen-no-stacking close/reopen 後 QR container 沒有疊加舊內容（children 數量沒有異常累積）', String(childCountAfterReopen));
        await h.page.evaluate(() => ppaCloseQrModal());

        // ── 七：QR unavailable fallback（阻擋同源 /js/qrcode.min.js，不是外部 CDN）──
        // newAdminPage() 已先安裝 page catch-all；後註冊的精確 page route 必須在 goto 前攔截。
        const h2 = await newAdminPage();
        const blockedQrRequests = [];
        await h2.page.route('**/js/qrcode.min.js*', (route) => {
          blockedQrRequests.push(route.request().url());
          return route.abort('failed');
        });
        await h2.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h2.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, null, { timeout: 5000 });
        await h2.page.evaluate(() => showPage('popup_pickup'));
        await h2.page.evaluate(() => ppaSwitchTab && ppaSwitchTab('links'));
        await h2.page.waitForFunction(() => { const b = document.getElementById('ppa-links-list'); return b && !b.textContent.includes('載入中'); }, null, { timeout: 8000 });
        await h2.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('QR Code')).click(); }, tag + '已發布場次');
        let fallbackWaitError = null;
        const fallbackReached = await h2.page.waitForFunction(() => {
          const c = document.getElementById('ppa-qr-container');
          return c && c.textContent.trim().length > 0;
        }, null, { timeout: 8000 }).then(
          () => true,
          (e) => { fallbackWaitError = String(e && (e.message || e)); return false; },
        );
        const fallbackInfo = await h2.page.evaluate(() => {
          const c = document.getElementById('ppa-qr-container');
          return {
            text: c ? c.textContent : '',
            urlText: document.getElementById('ppa-qr-url')?.textContent || '',
            qrCodeType: typeof QRCode,
            hasCanvas: Boolean(c && c.querySelector('canvas')),
            hasImg: Boolean(c && c.querySelector('img')),
            hasTable: Boolean(c && c.querySelector('table')),
          };
        });
        const expectedStaticQrUrl = `${base}/js/qrcode.min.js?v=h1-4-12-r26-qr-local-1`;
        const expectedDynamicQrUrl = `${base}/js/qrcode.min.js`;
        const routeEvidenceOk = blockedQrRequests.length === 2
          && blockedQrRequests[0] === expectedStaticQrUrl
          && blockedQrRequests[1] === expectedDynamicQrUrl;
        const fallbackDetail = JSON.stringify({
          fallbackReached,
          fallbackWaitError,
          ...fallbackInfo,
          blockedQrRequests,
        });
        assert(
          fallbackReached === true
            && routeEvidenceOk
            && fallbackInfo.text.includes('失敗')
            && fallbackInfo.text.includes('複製')
            && fallbackInfo.urlText === sessionUrlExpected
            && fallbackInfo.qrCodeType === 'undefined'
            && !fallbackInfo.hasCanvas
            && !fallbackInfo.hasImg
            && !fallbackInfo.hasTable,
          'QR-fallback-readable-text QR 資源被阻擋後顯示可讀 fallback 文字（含「失敗」與「複製」提示）',
          fallbackDetail,
        );
        assert(
          fallbackReached === true && routeEvidenceOk && h2.pageErrors.length === 0,
          'QR-fallback-no-pageerror QR 資源被阻擋不產生 pageerror',
          JSON.stringify({ fallbackReached, routeEvidenceOk, pageErrors: h2.pageErrors }),
        );
        // copy/open 仍可用
        await h2.context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await h2.page.evaluate((name) => { const cards = [...document.querySelectorAll('#ppa-links-list > div')]; const c = cards.find((x) => x.textContent.includes(name)); const btns = [...c.querySelectorAll('button')]; btns.find((b) => b.textContent.includes('複製')).click(); }, tag + '已發布場次');
        await h2.page.waitForTimeout(150);
        const clip2 = await h2.page.evaluate(() => navigator.clipboard.readText());
        assert(
          fallbackReached === true && routeEvidenceOk && clip2 === sessionUrlExpected,
          'QR-fallback-copy-still-works QR fallback 狀態下，複製功能仍正常運作',
          JSON.stringify({ fallbackReached, routeEvidenceOk, clip2 }),
        );
        await h2.page.evaluate(() => ppaCloseQrModal());
        await h2.page.waitForFunction(() => {
          const modal = document.getElementById('ppa-modal-qr');
          return modal && getComputedStyle(modal).display === 'none';
        }, null, { timeout: 3000 });
        await h2.page.unroute('**/js/qrcode.min.js*').catch(() => {});

        // ── 八／九：XSS fixture（campaign name、location name/address；透過真實 API）──
        const XSS_PAYLOADS = [
          '<img src=x onerror="window.__PPA_XSS=1">',
          '</script><script>window.__PPA_XSS=2</script>',
          '"><svg onload="window.__PPA_XSS=3">',
          'javascript:window.__PPA_XSS=4',
          `q"u'o\`te&amp;中文😀`,
        ];
        await h2.page.evaluate(() => { window.__PPA_XSS = undefined; });
        let xssIdx = 0;
        for (const payload of XSS_PAYLOADS) {
          xssIdx++;
          const expectedName = payload + '-camp-' + xssIdx;
          const campXss = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: expectedName } });
          let publishXss = null;
          if (campXss.status === 201 && campXss.json?.success === true && campXss.json?.data?.id) {
            publishXss = await call('PATCH', `/api/popup-pickup/campaigns/${campXss.json.data.id}`, { token: T1, body: { status: 'published' } });
          }
          const safeAccepted = (
            campXss.status === 201
            && campXss.json?.success === true
            && typeof campXss.json?.data?.id === 'string'
            && campXss.json.data.id.length > 0
            && campXss.json.data.name === expectedName
            && publishXss?.status === 200
            && publishXss.json?.success === true
            && publishXss.json?.data?.id === campXss.json.data.id
            && publishXss.json?.data?.name === expectedName
            && publishXss.json?.data?.status === 'published'
          );
          assert(safeAccepted, `XSS-campaign-${xssIdx}-api-result campaign name payload #${xssIdx} 必須由 API 安全接受並發布（safeAccepted=${safeAccepted}）`, JSON.stringify({
            createStatus: campXss.status,
            createSuccess: campXss.json?.success === true,
            createIdPresent: typeof campXss.json?.data?.id === 'string' && campXss.json.data.id.length > 0,
            createNameExact: campXss.json?.data?.name === expectedName,
            publishStatus: publishXss?.status ?? null,
            publishSuccess: publishXss?.json?.success === true,
            publishIdExact: publishXss?.json?.data?.id === campXss.json?.data?.id,
            publishNameExact: publishXss?.json?.data?.name === expectedName,
            publishState: publishXss?.json?.data?.status ?? null,
          }));
        }
        await h2.page.evaluate(() => showPage('popup_pickup'));
        await h2.page.evaluate(() => ppaSwitchTab && ppaSwitchTab('campaigns'));
        await h2.page.waitForFunction(() => { const b = document.getElementById('ppa-campaigns-tbody'); return b && !b.textContent.includes('載入中'); }, { timeout: 8000 });
        const injectedEls = await h2.page.evaluate(() => ({ imgCount: document.querySelectorAll('#ppa-campaigns-tbody img').length, svgCount: document.querySelectorAll('#ppa-campaigns-tbody svg').length, scriptCount: document.querySelectorAll('#ppa-campaigns-tbody script').length }));
        assert(injectedEls.imgCount === 0 && injectedEls.svgCount === 0 && injectedEls.scriptCount === 0, 'XSS-campaign-no-injected-elements campaign 列表中沒有任何 payload 注入的 img/svg/script element', JSON.stringify(injectedEls));
        const xssFlagAfterCampaign = await h2.page.evaluate(() => window.__PPA_XSS);
        assert(xssFlagAfterCampaign === undefined, 'XSS-campaign-flag-undefined window.__PPA_XSS 在 campaign 列表渲染後仍是 undefined（沒有任何 payload 執行）', String(xssFlagAfterCampaign));
        assert(h2.pageErrors.length === 0 && h2.unexpectedDialogs.length === 0, 'XSS-campaign-no-pageerror-no-dialog campaign XSS payload 渲染沒有 pageerror、沒有非預期 dialog', JSON.stringify({ pe: h2.pageErrors, d: h2.unexpectedDialogs }));

        // location name/address
        // B-A4 location 契約：location 斷言不得被 campaign 的 page-global 狀態或 campaign 表格影響，且 save 必須真的送出、被接受並持久化。
        await h2.page.evaluate(() => ppaSwitchTab && ppaSwitchTab('locations'));
        await h2.page.waitForFunction(() => { const b = document.getElementById('ppa-locations-tbody'); return b && !b.textContent.includes('載入中'); }, { timeout: 8000 });
        await h2.page.evaluate(() => { delete window.__PPA_XSS; });
        const xssFlagResetAtLocation = await h2.page.evaluate(() => ({ undefinedAfterReset: window.__PPA_XSS === undefined, ownPropertyAfterReset: Object.prototype.hasOwnProperty.call(window, '__PPA_XSS') }));
        const expectedLocationName = XSS_PAYLOADS[0] + '-loc';
        const expectedLocationAddress = XSS_PAYLOADS[2] + '-addr';
        await h2.page.evaluate(() => ppaOpenLocationForm && ppaOpenLocationForm(null));
        await h2.page.fill('#ppa-location-name', expectedLocationName);
        await h2.page.fill('#ppa-location-address', expectedLocationAddress);
        const isLocationCreatePost = (method, url) => method === 'POST' && new URL(url).pathname === '/api/popup-pickup/locations';
        let locationPostCount = 0;
        const onLocationRequest = (req) => { if (isLocationCreatePost(req.method(), req.url())) locationPostCount++; };
        h2.page.on('request', onLocationRequest);
        const locationResponsePromise = h2.page.waitForResponse((r) => isLocationCreatePost(r.request().method(), r.url()), { timeout: 10000 }).then((r) => r, () => null);
        let locationClickErrorClass = null;
        try {
          await h2.page.click('#ppa-location-save-btn', { timeout: 5000 });
        } catch (e) {
          locationClickErrorClass = (e && e.name) ? String(e.name) : 'Error';
        }
        const locationResponse = await locationResponsePromise;
        let locationJson = null;
        if (locationResponse) locationJson = await locationResponse.json().catch(() => null);
        await h2.page.waitForFunction(() => { const m = document.getElementById('ppa-modal-location'); return !!m && getComputedStyle(m).display === 'none'; }, null, { timeout: 5000 }).catch(() => {});
        await h2.page.waitForFunction(() => { const b = document.getElementById('ppa-locations-tbody'); return b && !b.textContent.includes('載入中'); }, null, { timeout: 8000 }).catch(() => {});
        await h2.page.waitForTimeout(500);
        h2.page.off('request', onLocationRequest);
        const xssFlagAfterLocation = await h2.page.evaluate(() => window.__PPA_XSS);
        assert(xssFlagAfterLocation === undefined, 'XSS-location-flag-undefined location name/address payload 送出後 window.__PPA_XSS 仍是 undefined', String(xssFlagAfterLocation));
        assert(h2.pageErrors.length === 0, 'XSS-location-no-pageerror location XSS payload 沒有產生 pageerror', JSON.stringify(h2.pageErrors));
        const locInjected = await h2.page.evaluate(() => ({ img: document.querySelectorAll('#ppa-locations-tbody img').length, svg: document.querySelectorAll('#ppa-locations-tbody svg').length, script: document.querySelectorAll('#ppa-locations-tbody script').length }));
        assert(locInjected.img === 0 && locInjected.svg === 0 && locInjected.script === 0, 'XSS-location-no-injected-elements location 欄位沒有注入 img/svg element', JSON.stringify(locInjected));
        const locationData = locationJson && locationJson.data ? locationJson.data : null;
        const locationId = locationData && typeof locationData.id === 'string' && locationData.id.length > 0 ? locationData.id : null;
        const locationReadback = await call('GET', '/api/popup-pickup/locations', { token: T1, query: { limit: '500' } });
        const locationReadbackRows = locationId && Array.isArray(locationReadback.json?.data) ? locationReadback.json.data.filter((row) => row.id === locationId) : [];
        // 顯示檢查只證明 reload 後的 tbody 真的出現這一筆 name/address（文字或 HTML 兩種呈現都算該列）；渲染是否安全由上面三個 XSS-location-* 斷言負責。
        const locationTbodyRows = await h2.page.evaluate(({ n, a }) => {
          const asShown = (s) => { const t = document.createElement('template'); t.innerHTML = s; return t.content.textContent; };
          const rows = [...document.querySelectorAll('#ppa-locations-tbody tr')].filter((tr) => tr.cells.length >= 2);
          return rows.filter((tr) => (tr.cells[0].textContent === n || tr.cells[0].textContent === asShown(n)) && (tr.cells[1].textContent === a || tr.cells[1].textContent === asShown(a))).length;
        }, { n: expectedLocationName, a: expectedLocationAddress });
        const locationModalClosed = await h2.page.evaluate(() => { const m = document.getElementById('ppa-modal-location'); return !!m && getComputedStyle(m).display === 'none'; });
        const locationDetail = {
          clickOk: locationClickErrorClass === null,
          postCount: locationPostCount,
          responseSeen: locationResponse !== null,
          status: locationResponse ? locationResponse.status() : null,
          success: !!(locationJson && locationJson.success === true),
          idPresent: locationId !== null,
          responseNameExact: !!locationData && locationData.name === expectedLocationName,
          responseAddressExact: !!locationData && locationData.address === expectedLocationAddress,
          modalClosed: locationModalClosed,
          readbackCount: locationReadbackRows.length,
          readbackExact: locationReadbackRows.length === 1 && locationReadbackRows[0].name === expectedLocationName && locationReadbackRows[0].address === expectedLocationAddress,
          tbodyTextExact: locationTbodyRows === 1,
        };
        assert(
          locationDetail.clickOk && locationDetail.postCount === 1 && locationDetail.responseSeen && locationDetail.status === 201 && locationDetail.success
            && locationDetail.idPresent && locationDetail.responseNameExact && locationDetail.responseAddressExact && locationDetail.modalClosed
            && locationDetail.readbackCount === 1 && locationDetail.readbackExact && locationDetail.tbodyTextExact,
          'R39-XSS-location-save-reachable-and-persisted location save 真實 click 恰好送出 1 個 POST /api/popup-pickup/locations，201 success、id 與 name/address 精確、modal 關閉、readback 恰好 1 筆且精確、tbody 顯示該筆',
          JSON.stringify(locationDetail),
        );

        await h2.context.close();

        // ── 十：External-resource resilience（阻擋 fonts.googleapis.com，確認頁面仍可用）──
        const h3 = await newAdminPage();
        const blockedHosts = [];
        const blockedFontRequests = [];
        const blockedLeafletRequests = [];
        await h3.page.route('**://fonts.googleapis.com/**', (route) => {
          const req = route.request();
          blockedHosts.push('fonts.googleapis.com');
          blockedFontRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
          route.abort('failed');
        });
        await h3.page.route('**://fonts.gstatic.com/**', (route) => {
          const req = route.request();
          blockedHosts.push('fonts.gstatic.com');
          blockedFontRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
          route.abort('failed');
        });
        await h3.page.route('**://unpkg.com/leaflet@1.9.4/**', (route) => {
          const req = route.request();
          blockedLeafletRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
          route.abort('failed');
        });
        await h3.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
        await h3.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 8000 });
        await h3.page.evaluate(() => showPage('popup_pickup'));
        const extTabStates = [];
        for (const t of ['campaigns', 'locations', 'sessions', 'links']) {
          await h3.page.evaluate((tn) => ppaSwitchTab && ppaSwitchTab(tn), t);
          await h3.page.waitForTimeout(300);
          extTabStates.push(await h3.page.evaluate((tn) => {
            const panel = document.getElementById('ppa-panel-' + tn);
            const button = document.getElementById('ppa-tabbtn-' + tn);
            return {
              tab: tn,
              panelVisible: !!panel && getComputedStyle(panel).display !== 'none',
              buttonActive: !!button && button.classList.contains('active'),
            };
          }, t));
        }
        assert(h3.pageErrors.length === 0, 'EXT-fonts-blocked-no-pageerror Google Fonts 被阻擋，四個 tab 切換沒有 pageerror', JSON.stringify(h3.pageErrors));
        const fontCssRequests = blockedFontRequests.filter((x) => {
          try { const u = new URL(x.url); return u.hostname === 'fonts.googleapis.com' && u.pathname === '/css2'; } catch (e) { return false; }
        });
        const fontEvidence = {
          blockedFontRequests,
          cssHitCount: fontCssRequests.length,
          cssRequestExact: fontCssRequests.length === 1 && fontCssRequests[0].method === 'GET' && fontCssRequests[0].resourceType === 'stylesheet',
          tabs: extTabStates,
          pageErrors: h3.pageErrors,
        };
        assert(
          fontEvidence.cssHitCount === 1 && fontEvidence.cssRequestExact
            && extTabStates.length === 4 && extTabStates.every((x) => x.panelVisible && x.buttonActive)
            && h3.pageErrors.length === 0,
          'R40-EXT-font-block-reached-and-tabs-usable Google Fonts CSS 阻擋 route 恰好命中 1 次，且四個 popup tab 仍可用、無 pageerror',
          JSON.stringify(fontEvidence),
        );
        const leafletTags = await h3.page.evaluate(() => {
          const css = document.querySelector('link[rel="stylesheet"][href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"]');
          const script = document.querySelector('script[src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"]');
          return {
            css: css ? { integrity: css.getAttribute('integrity'), crossorigin: css.getAttribute('crossorigin') } : null,
            script: script ? { integrity: script.getAttribute('integrity'), crossorigin: script.getAttribute('crossorigin') } : null,
          };
        });
        const leafletCssRequests = blockedLeafletRequests.filter((x) => {
          try { const u = new URL(x.url); return u.hostname === 'unpkg.com' && u.pathname === '/leaflet@1.9.4/dist/leaflet.css'; } catch (e) { return false; }
        });
        const leafletJsRequests = blockedLeafletRequests.filter((x) => {
          try { const u = new URL(x.url); return u.hostname === 'unpkg.com' && u.pathname === '/leaflet@1.9.4/dist/leaflet.js'; } catch (e) { return false; }
        });
        const leafletRequestEvidence = {
          blockedLeafletRequests,
          cssHitCount: leafletCssRequests.length,
          jsHitCount: leafletJsRequests.length,
          tags: leafletTags,
          pageErrors: h3.pageErrors,
        };
        assert(
          blockedLeafletRequests.length === 2
            && leafletCssRequests.length === 1 && leafletCssRequests[0].method === 'GET' && leafletCssRequests[0].resourceType === 'stylesheet'
            && leafletJsRequests.length === 1 && leafletJsRequests[0].method === 'GET' && leafletJsRequests[0].resourceType === 'script'
            && leafletTags.css?.integrity === 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=' && leafletTags.css?.crossorigin === ''
            && leafletTags.script?.integrity === 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=' && leafletTags.script?.crossorigin === ''
            && h3.pageErrors.length === 0,
          'R41-EXT-leaflet-unpkg-block-reached Leaflet 1.9.4 CSS/JS 必須各自精確發出 1 個 GET、由本機 route 阻擋，且兩個 SRI 標籤完整、無 pageerror',
          JSON.stringify(leafletRequestEvidence),
        );
        const leafletFallbackEvidence = await h3.page.evaluate(() => {
          const holder = document.createElement('div');
          const mapId = 'r41-leaflet-fallback-map';
          holder.id = 'r41-leaflet-fallback-probe';
          holder.innerHTML = `<div id="${mapId}" class="geo-map-canvas"></div>`;
          document.body.appendChild(holder);
          _geoResetMapStateForTest();
          const leafletType = typeof window.L;
          const initResult = geoInitMap(mapId, []);
          const loading = holder.querySelector('.geo-map-loading');
          const result = {
            leafletType,
            initResult,
            lastError: window.geoMapState?.lastError ?? null,
            loadingCount: holder.querySelectorAll('.geo-map-loading').length,
            text: loading?.textContent?.trim() ?? null,
            ariaBusy: loading?.getAttribute('aria-busy') ?? null,
            ariaLive: loading?.getAttribute('aria-live') ?? null,
            errorCount: holder.querySelectorAll('.geo-map-error').length,
          };
          holder.remove();
          _geoResetMapStateForTest();
          return result;
        });
        assert(
          leafletFallbackEvidence.leafletType === 'undefined' && leafletFallbackEvidence.initResult === false
            && leafletFallbackEvidence.lastError === 'loading_leaflet'
            && leafletFallbackEvidence.loadingCount === 1 && leafletFallbackEvidence.text === '地圖元件載入中'
            && leafletFallbackEvidence.ariaBusy === 'true' && leafletFallbackEvidence.ariaLive === 'polite'
            && leafletFallbackEvidence.errorCount === 0 && h3.pageErrors.length === 0,
          'R41-EXT-leaflet-missing-safe-fallback Leaflet 被本機阻擋時 geoInitMap 必須安全回傳 false，並顯示可存取的地圖元件載入中文字、無 pageerror',
          JSON.stringify({ ...leafletFallbackEvidence, pageErrors: h3.pageErrors }),
        );
        // 真實、可回復的 admin mutation：建一個 campaign 再刪除
        const mutTag = 'EXT-r40-cleanup-9f4a2c7e6b10';
        const extCamp = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: mutTag } });
        assert(extCamp.status === 201, 'EXT-mutation-still-works 外部資源被阻擋期間，真實 admin mutation（建立 campaign）仍正常運作', JSON.stringify(extCamp));
        const extCampId = extCamp.status === 201 && typeof extCamp.json?.data?.id === 'string' ? extCamp.json.data.id : null;
        const extDelete = extCampId ? await call('DELETE', `/api/popup-pickup/campaigns/${extCampId}`, { token: T1 }) : null;
        const extReadback = extCampId ? await call('GET', `/api/popup-pickup/campaigns/${extCampId}`, { token: T1 }) : null;
        const extList = await call('GET', '/api/popup-pickup/campaigns', { token: T1, query: { limit: '500' } });
        const extListRows = Array.isArray(extList.json?.data) && extCampId ? extList.json.data.filter((row) => row.id === extCampId) : [];
        const extDbCount = extCampId ? db.get('SELECT COUNT(*) AS c FROM popup_campaigns WHERE id=? AND store_id=?', [extCampId, 'store_001']).c : null;
        const extCleanup = {
          createStatus: extCamp.status,
          createSuccess: extCamp.json?.success === true,
          idPresent: extCampId !== null,
          createNameExact: extCamp.json?.data?.name === mutTag,
          deleteStatus: extDelete?.status ?? null,
          deleteSuccess: extDelete?.json?.success === true,
          detailStatusAfterDelete: extReadback?.status ?? null,
          listStatusAfterDelete: extList.status,
          listCountAfterDelete: extListRows.length,
          dbCountAfterDelete: extDbCount,
        };
        assert(
          extCleanup.createStatus === 201 && extCleanup.createSuccess && extCleanup.idPresent && extCleanup.createNameExact
            && extCleanup.deleteStatus === 200 && extCleanup.deleteSuccess
            && extCleanup.detailStatusAfterDelete === 404
            && extCleanup.listStatusAfterDelete === 200 && extCleanup.listCountAfterDelete === 0
            && extCleanup.dbCountAfterDelete === 0,
          'R40-EXT-delete-cleanup-confirmed 外部資源被阻擋期間建立的 campaign 必須 DELETE 200 success，且 detail 404、list 0 筆、DB 0 列',
          JSON.stringify(extCleanup),
        );
        assert(h3.unexpectedExternalHosts.length === 0, 'EXT-no-unknown-external-host 除了刻意阻擋的 fonts host，沒有其他未知 external host 被請求', JSON.stringify(h3.unexpectedExternalHosts));
        await h3.context.close();
      } finally {
        await h.context.close().catch(() => {});
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 十一、六 viewport RWD／可用性語意契約（owner-approved R36 contract R36_CONTRACT.json 506daa03…；R37 正式納入）
    // NOT a historical 3C-B reconstruction. 6 viewports × 10 checks = 60 R36D assertions appended after the original 360.
    // Optional evidence output: SMOKE_VIEWPORT_EVIDENCE_DIR (repo-external); when unset no file is written.
    // ══════════════════════════════════════════════════════════════
    {
      const vpcOut = process.env.SMOKE_VIEWPORT_EVIDENCE_DIR || null;
      const vpcContract = [['320x568', 320, 568], ['360x800', 360, 800], ['390x844', 390, 844], ['430x932', 430, 932], ['768x1024', 768, 1024], ['1280x800', 1280, 800]];
      const vpcChecks = ['viewport-exact', 'page-horizontal-contained', 'tabs-visible-reachable', 'campaign-action-visible', 'campaign-table-scroll-owned',
        'sessions-controls-visible-reachable', 'sessions-table-scroll-owned', 'session-modal-contained-scrollable', 'session-modal-accessible-names-focus', 'runtime-clean'];
      const vpcVpsOk = VIEWPORTS.length === 6 && VIEWPORTS.every((v, i) => v.name === vpcContract[i][0] && v.width === vpcContract[i][1] && v.height === vpcContract[i][2]);
      const vpcMark = 'RWD6';
      const vpcNames = { campaign: vpcMark + '-campaign', location: vpcMark + '-loc', session: vpcMark + '-session' };
      let vpcSeq = 0;
      const vpcWrite = (rec) => { if (vpcOut) fs.appendFileSync(path.join(vpcOut, 'measurements.jsonl'), JSON.stringify(rec) + '\n'); };
      const vpcEmit = (vp, check, ok, m) => {
        const name = `R36D-${vp}-${check}`;
        vpcSeq++; vpcWrite({ seq: vpcSeq, vp, check, name, pass: !!ok, m });
        let d = ''; try { d = JSON.stringify(m); } catch (e) { d = 'unserializable'; }
        assert(!!ok, name, d.length > 600 ? d.slice(0, 600) + '…' : d);
      };
      let vpcFx = null; let vpcFxErr = null;
      try {
        const c = await makeCampaign(vpcNames.campaign);
        const l = await makeLocation(vpcNames.location);
        const s0 = await makeSession(c.id, l.id, { name: vpcNames.session });
        const s = await publishSession(s0.id, s0.revision);
        vpcFx = { campaignId: c.id, campaignStatus: c.status, locationId: l.id, sessionId: s && s.id, sessionStatus: s && s.status };
      } catch (e) { vpcFxErr = String(e && e.message || e).slice(0, 200); }
      vpcWrite({ kind: 'fixture', fixture: vpcFx, error: vpcFxErr, viewportsMatchContract: vpcVpsOk });

      // page-side measurement helpers (pure DOM reads)
      const vpcLib = () => {
        if (window.__vpclib) return;
        const T = 1;
        const R = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left * 100) / 100, right: Math.round(r.right * 100) / 100, top: Math.round(r.top * 100) / 100, bottom: Math.round(r.bottom * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }; };
        const vis = (el) => { if (!el || !el.isConnected) return false; if (el.hidden) return false; if (el.tagName === 'INPUT' && el.type === 'hidden') return false; const cv = typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkVisibilityCSS: true }) : true; const r = el.getBoundingClientRect(); return cv && r.width > 0 && r.height > 0; };
        const enabled = (el) => !!el && !el.disabled && !el.closest('fieldset[disabled]') && el.getAttribute('aria-disabled') !== 'true';
        const withinH = (r, b) => r.left >= b.left - T && r.right <= b.right + T;
        const withinV = (r, b) => r.top >= b.top - T && r.bottom <= b.bottom + T;
        const page = () => document.getElementById('page-popup_pickup');
        const pageVis = () => { const r = R(page()); return { left: Math.max(r.left, 0), right: Math.min(r.right, window.innerWidth), top: r.top, bottom: r.bottom }; };
        const vpRect = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
        const idOf = (el) => el ? (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '')) : null;
        const scrollOwned = (tableSel, tbodyId, panelId, rowText) => {
          const m = { table: tableSel, tbody: tbodyId };
          const table = document.querySelector(tableSel); const tbody = document.getElementById(tbodyId); const panel = document.getElementById(panelId); const pg = page();
          m.tableExists = !!table; m.tbodyExists = !!tbody; if (!table || !tbody || !panel) return { ok: false, m };
          const row = Array.from(tbody.querySelectorAll('tr')).find((tr) => tr.textContent.includes(rowText));
          m.rowExists = !!row; m.rowVisible = vis(row);
          const tr = R(table); m.tableWidth = tr.width; m.panelClientWidth = panel.clientWidth; m.fits = tr.width <= panel.clientWidth + T;
          if (!row || !m.rowVisible) return { ok: false, m };
          if (m.fits) { m.rule = 'fits-direct-pass'; return { ok: true, m }; }
          const pv = pageVis(); const hiddenAnc = []; let owner = null; let a = table.parentElement;
          while (a && a !== pg && a !== document.body) {
            const cs = getComputedStyle(a);
            if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + T && withinH(R(a), pv)) { owner = a; break; }
            if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') hiddenAnc.push({ el: idOf(a), overflowX: cs.overflowX, scrollWidth: a.scrollWidth, clientWidth: a.clientWidth });
            a = a.parentElement;
          }
          m.hiddenAncestorsNotOwners = hiddenAnc; m.reachedPageWithoutOwner = !owner;
          if (!owner) return { ok: false, m };
          const ocs = getComputedStyle(owner); m.owner = { el: idOf(owner), overflowX: ocs.overflowX, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, rect: R(owner), isPage: owner === pg };
          const btns = row.querySelectorAll('button'); const last = btns.length ? btns[btns.length - 1] : null; m.rowButtons = btns.length; m.lastButtonText = last ? last.textContent.trim().slice(0, 12) : null;
          if (!last) return { ok: false, m };
          const orig = owner.scrollLeft; owner.scrollLeft = owner.scrollWidth - owner.clientWidth; m.scrollLeftMax = owner.scrollLeft;
          const lr = R(last); const or = R(owner); m.lastButtonRectAtMax = lr; m.lastButtonWithinOwner = withinH(lr, or);
          owner.scrollLeft = orig; m.scrollLeftRestored = owner.scrollLeft === orig;
          return { ok: m.lastButtonWithinOwner && !m.owner.isPage && m.owner.overflowX !== 'hidden', m };
        };
        const nameOf = (el) => {
          const t = (s) => (s || '').replace(/\s+/g, ' ').trim();
          let n = t(el.getAttribute('aria-label')); if (n) return { name: n, src: 'aria-label' };
          const lb = el.getAttribute('aria-labelledby');
          if (lb) { n = t(lb.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ')); if (n) return { name: n, src: 'aria-labelledby' }; }
          if (el.labels && el.labels.length) {
            n = t(Array.from(el.labels).map((l) => { const c = l.cloneNode(true); c.querySelectorAll('button,input,select,textarea,option').forEach((x) => x.remove()); return c.textContent; }).join(' '));
            if (n) return { name: n, src: 'label' };
          }
          n = t(el.getAttribute('placeholder')); if (n) return { name: n, src: 'placeholder' };
          n = t(el.getAttribute('title')); if (n) return { name: n, src: 'title' };
          n = t(el.innerText); if (n) return { name: n, src: 'text' };
          if ((el.tagName === 'BUTTON' || el.tagName === 'INPUT') && t(el.value)) return { name: t(el.value), src: 'value' };
          return { name: '', src: 'none' };
        };
        window.__vpclib = { T, R, vis, enabled, withinH, withinV, page, pageVis, vpRect, idOf, scrollOwned, nameOf };
      };

      // animation-stable wait (modal measured only after opacity 1, identity transform, finished animations, 2-frame-stable rect) and cause records
      const vpcWaitStable = async () => {
        const md = document.querySelector('#ppa-modal-session .modal'); const t0 = performance.now();
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        let prev = null; let frames = 0; let last = null;
        while (performance.now() - t0 < 5000) {
          await raf(); frames++;
          const cs = getComputedStyle(md); const anims = md.getAnimations({ subtree: true });
          const done = anims.every((a) => a.playState === 'finished' || a.playState === 'idle');
          const tf = cs.transform; const ident = tf === 'none' || tf === 'matrix(1, 0, 0, 1, 0, 0)';
          const r = md.getBoundingClientRect(); const cur = [r.left, r.top, r.width, r.height];
          const stable = !!prev && cur.every((v, i) => Math.abs(v - prev[i]) <= 1);
          last = { opacity: cs.opacity, transform: tf, animations: anims.length, animStates: anims.map((a) => a.playState), frames, elapsedMs: Math.round(performance.now() - t0), rect: cur.map((v) => Math.round(v * 100) / 100), rectStableTwoFrames: stable };
          if (cs.opacity === '1' && ident && done && stable) return Object.assign({ stable: true }, last);
          prev = cur;
        }
        return Object.assign({ stable: false }, last);
      };
      const vpcModalCause = () => {
        const L = window.__vpclib; const md = document.querySelector('#ppa-modal-session .modal'); const mr = md.getBoundingClientRect();
        const bound = mr.left + md.clientLeft + md.clientWidth; const rd = (v) => Math.round(v * 100) / 100;
        const pos = (el) => { const p = el.parentElement; return p ? Array.from(p.children).indexOf(el) + 1 : 0; };
        const pathOf = (el) => { const p = []; for (let a = el; a && a !== md; a = a.parentElement) p.unshift(L.idOf(a) + ':nth-child(' + pos(a) + ')'); return '.modal > ' + p.join(' > '); };
        const rec = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return { path: pathOf(el), tag: el.tagName.toLowerCase(), type: el.type || null, left: rd(r.left), right: rd(r.right), width: rd(r.width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          cs: { display: c.display, width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth, flexBasis: c.flexBasis, flexShrink: c.flexShrink, flexGrow: c.flexGrow, overflowX: c.overflowX, boxSizing: c.boxSizing, paddingLeft: c.paddingLeft, paddingRight: c.paddingRight } }; };
        md.scrollLeft = 0;
        const all = Array.from(md.querySelectorAll('*')).filter(L.vis);
        const over = all.filter((el) => el.getBoundingClientRect().right > bound + 1);
        const leaves = over.filter((el) => !over.some((o) => o !== el && el.contains(o)));
        const chain = (el) => { const c = []; for (let a = el; a && a !== md; a = a.parentElement) c.push(rec(a)); c.push(rec(md)); return c; };
        const widest = leaves.slice().sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
        return { modal: { scrollWidth: md.scrollWidth, clientWidth: md.clientWidth, rect: [rd(mr.left), rd(mr.right)], contentRightBound: rd(bound) }, visibleDescendants: all.length, overflowingCount: over.length,
          overflowing: over.map(rec), leafCauses: leaves.map((el) => ({ ...rec(el), chain: chain(el) })), widestLeaf: widest ? rec(widest) : null, maxRight: rd(Math.max(...all.map((el) => el.getBoundingClientRect().right))) };
      };
      const vpcFilterCause = () => {
        const L = window.__vpclib; const s = document.getElementById('ppa-session-filter-campaign'); const opts = Array.from(s.options);
        let li = -1; let ll = -1; opts.forEach((o, i) => { if (o.textContent.length > ll) { ll = o.textContent.length; li = i; } });
        const c = getComputedStyle(s); const p = s.parentElement; const pc = getComputedStyle(p);
        return { optionCount: opts.length, longestOptionLength: ll, longestOptionIndex: li, rect: L.R(s), scrollWidth: s.scrollWidth, clientWidth: s.clientWidth,
          cs: { display: c.display, width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth, flexBasis: c.flexBasis, flexShrink: c.flexShrink, flexGrow: c.flexGrow, boxSizing: c.boxSizing },
          parent: { el: L.idOf(p), rect: L.R(p), display: pc.display, flexWrap: pc.flexWrap, width: pc.width, gap: pc.gap }, pageVis: L.pageVis(), innerWidth };
      };
      const vpcRun = async (vp) => {
        const res = []; const add = (check, fn) => res.push({ check, fn });
        let h = null; let setupErr = null; const failedReq = [];
        try {
          h = await newAdminPage({ viewport: { width: vp.width, height: vp.height } });
          h.page.on('requestfailed', (req) => { try { const u = new URL(req.url()); if (req.url().startsWith(base)) failedReq.push({ method: req.method(), pathname: u.pathname, errorText: (req.failure() && req.failure().errorText) || '' }); } catch (e) {} });
          await h.page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
          await h.page.waitForFunction(() => window.currentFeatures && window.currentFeatures.line_order === true, { timeout: 8000 });
          await h.page.evaluate(() => showPage('popup_pickup'));
          await h.page.waitForFunction((n) => { const b = document.getElementById('ppa-campaigns-tbody'); return b && !b.textContent.includes('載入中') && b.textContent.includes(n); }, vpcNames.campaign, { timeout: 8000 });
          await h.page.evaluate(vpcLib);
        } catch (e) { setupErr = String(e && e.message || e).split('\n')[0].slice(0, 200); }
        const P = h && h.page; const ev = (f, a) => P.evaluate(f, a);
        const run = async (check, fn) => { let ok = false; let m = {}; try { if (!P) throw new Error('no page: ' + setupErr); const r = await fn(); ok = !!r.ok; m = r.m; } catch (e) { ok = false; m = { error: String(e && e.message || e).split('\n')[0].slice(0, 200) }; } if (setupErr) m.setupError = setupErr; vpcEmit(vp.name, check, ok, m); };
        await run('viewport-exact', () => ev((x) => { const vv = window.visualViewport; const m = { innerWidth: innerWidth, innerHeight: innerHeight, expected: [x.w, x.h], visualViewport: vv ? [vv.width, vv.height] : null }; return { ok: innerWidth === x.w && innerHeight === x.h && (!vv || (Math.abs(vv.width - x.w) <= 1 && Math.abs(vv.height - x.h) <= 1)), m }; }, { w: vp.width, h: vp.height }));
        await run('page-horizontal-contained', () => ev(() => {
          const L = window.__vpclib; const pg = L.page(); const cs = getComputedStyle(pg); const r = L.R(pg); const de = document.documentElement; const bd = document.body;
          const chain = []; for (let a = pg; a; a = a.parentElement) chain.push(a);
          const scaleZoom = chain.map((a) => { const c = getComputedStyle(a); return { el: L.idOf(a), transform: c.transform, zoom: c.zoom }; }).filter((x) => x.transform !== 'none' || !(x.zoom === '1' || x.zoom === 'normal' || x.zoom === ''));
          const m = { active: pg.classList.contains('active'), display: cs.display, rect: r, innerWidth, doc: [de.scrollWidth, de.clientWidth], body: [bd.scrollWidth, bd.clientWidth], page: [pg.scrollWidth, pg.clientWidth], scaleOrZoom: scaleZoom };
          const ok = m.active && cs.display !== 'none' && r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1 && de.scrollWidth <= de.clientWidth + 1 && bd.scrollWidth <= bd.clientWidth + 1 && pg.scrollWidth <= pg.clientWidth + 1 && scaleZoom.length === 0;
          return { ok, m };
        }));
        await run('tabs-visible-reachable', () => ev(() => {
          const L = window.__vpclib; const pv = L.pageVis(); const pg = L.page(); const out = []; let ok = true;
          for (const t of ['campaigns', 'locations', 'sessions', 'links']) {
            const el = document.getElementById('ppa-tabbtn-' + t); const x = { id: 'ppa-tabbtn-' + t, exists: !!el };
            if (el) {
              const r = L.R(el); x.rect = r; x.visible = L.vis(el); x.enabled = L.enabled(el); x.withinPageVis = L.withinH(r, pv); x.clippedBy = [];
              for (let a = el.parentElement; a; a = a.parentElement) { const c = getComputedStyle(a); if (['hidden', 'clip'].includes(c.overflowX) || ['hidden', 'clip'].includes(c.overflowY)) { const ar = L.R(a); if (!(L.withinH(r, ar) && L.withinV(r, ar))) x.clippedBy.push(L.idOf(a)); } if (a === pg) break; }
              x.ok = x.visible && x.enabled && r.width > 0 && r.height > 0 && x.withinPageVis && x.clippedBy.length === 0;
            } else x.ok = false;
            ok = ok && x.ok; out.push(x);
          }
          return { ok, m: { pageVis: pv, tabs: out } };
        }));
        await run('campaign-action-visible', () => ev(() => {
          const L = window.__vpclib; const el = document.getElementById('ppa-btn-new-campaign'); if (!el) return { ok: false, m: { exists: false } };
          const r = L.R(el); const m = { rect: r, innerWidth, visible: L.vis(el), enabled: L.enabled(el) }; el.focus(); m.focused = document.activeElement === el; el.blur();
          return { ok: m.visible && m.enabled && r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1 && m.focused, m };
        }));
        await run('campaign-table-scroll-owned', () => ev((n) => window.__vpclib.scrollOwned('#ppa-panel-campaigns table.data-table', 'ppa-campaigns-tbody', 'ppa-panel-campaigns', n), vpcNames.campaign));
        if (P && vpcOut) { try { await P.screenshot({ path: path.join(vpcOut, 'screenshots', `${vp.name}-campaign.png`) }); } catch (e) { vpcWrite({ kind: 'screenshot-error', vp: vp.name, which: 'campaign', error: String(e.message).slice(0, 200) }); } }
        let sessWait = null;
        await run('sessions-controls-visible-reachable', async () => {
          await ev(() => ppaSwitchTab('sessions'));
          sessWait = await P.waitForFunction((n) => { const b = document.getElementById('ppa-sessions-tbody'); return b && !b.textContent.includes('載入中') && b.textContent.includes(n); }, vpcNames.session, { timeout: 8000 }).then(() => 'loaded', () => 'timeout');
          return ev((w) => {
            const L = window.__vpclib; const pv = L.pageVis(); const sels = ['#ppa-session-filter-campaign', '#ppa-session-filter-status', '#ppa-session-filter-from', '#ppa-session-filter-to', '#ppa-panel-sessions button[onclick="ppaOpenBatchSessionForm()"]', '#ppa-panel-sessions button[onclick="ppaOpenSessionForm(null)"]'];
            let ok = true; const cs = sels.map((s) => { const el = document.querySelector(s); if (!el) { ok = false; return { sel: s, exists: false }; } const r = L.R(el); const x = { sel: s, rect: r, visible: L.vis(el), enabled: L.enabled(el), withinPageVis: L.withinH(r, pv) }; x.ok = x.visible && x.enabled && r.width > 0 && r.height > 0 && x.withinPageVis; ok = ok && x.ok; return x; });
            const nb = document.querySelector(sels[5]); let focused = false; if (nb) { nb.focus(); focused = document.activeElement === nb; nb.blur(); }
            return { ok: ok && focused, m: { sessionsLoad: w, pageVis: pv, controls: cs, newSessionFocused: focused } };
          }, sessWait);
        });
        if (P && vpcOut) { try { vpcWrite({ kind: 'filter-cause', vp: vp.name, cause: await ev(vpcFilterCause) }); } catch (e) { vpcWrite({ kind: 'filter-cause', vp: vp.name, error: String(e.message).slice(0, 200) }); } }
        await run('sessions-table-scroll-owned', () => ev((n) => window.__vpclib.scrollOwned('#ppa-panel-sessions table.data-table', 'ppa-sessions-tbody', 'ppa-panel-sessions', n), vpcNames.session));
        let modalOpen = false;
        await run('session-modal-contained-scrollable', async () => {
          await ev(() => ppaOpenSessionForm(null));
          await P.waitForFunction(() => { const o = document.getElementById('ppa-modal-session'); return o && window.__vpclib.vis(o); }, null, { timeout: 5000 });
          modalOpen = true;
          const vpcSt = await P.evaluate(vpcWaitStable); vpcWrite({ kind: 'modal-stable', vp: vp.name, state: vpcSt });
          if (vpcOut) try { await P.screenshot({ path: path.join(vpcOut, 'screenshots', `${vp.name}-session-modal.png`) }); } catch (e) { vpcWrite({ kind: 'screenshot-error', vp: vp.name, which: 'session-modal', error: String(e.message).slice(0, 200) }); }
          return ev(() => {
            const L = window.__vpclib; const ov = document.getElementById('ppa-modal-session'); const md = ov.querySelector('.modal'); const V = L.vpRect();
            const mr = L.R(md); const cs = getComputedStyle(md);
            const m = { overlayVisible: L.vis(ov), modalVisible: L.vis(md), modalRect: mr, innerWidth, innerHeight, scrollW: [md.scrollWidth, md.clientWidth], scrollH: [md.scrollHeight, md.clientHeight], overflowY: cs.overflowY };
            m.contained = mr.left >= -1 && mr.top >= -1 && mr.right <= innerWidth + 1 && mr.bottom <= innerHeight + 1;
            m.noHorizontalOverflow = md.scrollWidth <= md.clientWidth + 1;
            m.needsVScroll = md.scrollHeight > md.clientHeight + 1; m.vScrollOk = !m.needsVScroll || cs.overflowY === 'auto' || cs.overflowY === 'scroll';
            md.scrollTop = 0; const cl = md.querySelector('.modal-close'); const clr = cl ? L.R(cl) : null;
            m.close = cl ? { rect: clr, visible: L.vis(cl), inViewport: L.withinH(clr, V) && L.withinV(clr, V), inModalV: L.withinV(clr, mr) } : { exists: false };
            md.scrollTop = md.scrollHeight - md.clientHeight; m.scrollTopMax = md.scrollTop;
            const fx = (el) => { if (!el) return { exists: false }; const r = L.R(el); return { rect: r, visible: L.vis(el), inViewport: L.withinH(r, V) && L.withinV(r, V), inModalV: L.withinV(r, mr) }; };
            m.cancel = fx(md.querySelector('.modal-footer button.btn-secondary')); m.save = fx(document.getElementById('ppa-session-save-btn'));
            md.scrollTop = 0;
            const okc = (x) => x && x.visible && x.inViewport && x.inModalV;
            return { ok: m.overlayVisible && m.modalVisible && m.contained && m.noHorizontalOverflow && m.vScrollOk && okc(m.close) && okc(m.cancel) && okc(m.save), m };
          });
        });
        if (P && modalOpen && vpcOut) { try { vpcWrite({ kind: 'modal-cause', vp: vp.name, cause: await ev(vpcModalCause) }); } catch (e) { vpcWrite({ kind: 'modal-cause', vp: vp.name, error: String(e.message).slice(0, 200) }); } }
        await run('session-modal-accessible-names-focus', () => {
          if (!modalOpen) throw new Error('modal not open');
          return ev(() => {
            const L = window.__vpclib; const md = document.querySelector('#ppa-modal-session .modal');
            const ctl = Array.from(md.querySelectorAll('button,input,select,textarea,[role=button]')).filter(L.vis);
            const items = ctl.map((el) => { const n = L.nameOf(el); const iconOnly = /^[✕\s]+$/.test(n.name); const id = el.id || null; const docCount = id ? document.querySelectorAll('[id="' + CSS.escape(id) + '"]').length : null; return { el: L.idOf(el), tag: el.tagName.toLowerCase(), type: el.type || null, nameSrc: n.src, nameLen: n.name.length, iconOnly, id, docIdCount: docCount }; });
            const empty = items.filter((x) => x.nameLen === 0); const dup = items.filter((x) => x.id && x.docIdCount !== 1);
            const visIds = items.filter((x) => x.id).map((x) => x.id); const dupWithinVisible = visIds.filter((x, i) => visIds.indexOf(x) !== i);
            const fo = {}; for (const [k, s] of [['close', '.modal-close'], ['name', '#ppa-session-name'], ['save', '#ppa-session-save-btn']]) { const el = md.querySelector(s); if (!el) { fo[k] = false; continue; } el.focus(); fo[k] = document.activeElement === el; el.blur(); }
            return { ok: items.length > 0 && empty.length === 0 && dup.length === 0 && fo.close && fo.name && fo.save, m: { controls: items.length, emptyNames: empty, duplicateIds: dup, dupWithinVisible, iconOnly: items.filter((x) => x.iconOnly).map((x) => x.el), focus: fo, controlsDetail: items } };
          });
        });
        if (P && modalOpen) { try { await ev(() => ppaCloseSessionForm()); await P.waitForTimeout(200); } catch (e) {} }
        await run('runtime-clean', async () => {
          const allowed = failedReq.filter((f) => f.method === 'GET' && f.errorText === 'net::ERR_ABORTED' && (f.pathname === '/api/settings' || f.pathname.startsWith('/api/popup-pickup/')));
          const unknownFailed = failedReq.filter((f) => !allowed.includes(f));
          const consoleUnknown = h.consoleErrors.filter((m) => !/net::ERR_FAILED/.test(m) && !/ws:\/\/127\.0\.0\.1/.test(m) && !/status of 404/.test(m));
          const m = { pageErrors: h.pageErrors.length, unexpectedDialogs: h.unexpectedDialogs.length, unknownSame4xx5xx: h.unknownSame4xx5xx.slice(0, 10), unexpectedExternalHosts: h.unexpectedExternalHosts.length,
            failedSameOriginHarnessCount: h.failedSameOrigin.length, failedSameOriginR36Count: failedReq.length, allowlistedAborts: allowed.map((f) => `${f.method} ${f.pathname} ${f.errorText}`), unknownFailedSameOrigin: unknownFailed.map((f) => `${f.method} ${f.pathname} ${f.errorText}`),
            consoleErrorsTotal: h.consoleErrors.length, consoleErrorsUnknown: consoleUnknown.map((s) => s.slice(0, 120)), pageErrorSample: h.pageErrors.slice(0, 3).map((s) => s.slice(0, 120)) };
          return { ok: h.pageErrors.length === 0 && h.unexpectedDialogs.length === 0 && h.unknownSame4xx5xx.length === 0 && h.unexpectedExternalHosts.length === 0 && unknownFailed.length === 0 && consoleUnknown.length === 0, m };
        });
        let closed = false; if (h) { await h.close(); closed = h.context.pages().length === 0; }
        vpcWrite({ kind: 'context-closed', vp: vp.name, closed, setupError: setupErr });
      };
      if (vpcOut) fs.mkdirSync(path.join(vpcOut, 'screenshots'), { recursive: true });
      for (let i = 0; i < vpcContract.length; i++) {
        const vp = vpcVpsOk ? VIEWPORTS[i] : { name: vpcContract[i][0], width: vpcContract[i][1], height: vpcContract[i][2] };
        await vpcRun(vp);
      }
      vpcWrite({ kind: 'vpc-block-end', emitted: vpcSeq });
    }

    printSummary();

  } catch (e) {
    console.error('[FATAL]', e.stack || e);
    process.exitCode = 1;
  } finally {
    for (const c of openContexts) { try { await c.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    if (server) { await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('[FATAL]', e.stack || e); process.exitCode = 1; });
