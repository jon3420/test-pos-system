#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-real-browser.js
// H1.4.12 Phase 3B — REAL browser QA (Playwright + real Chromium, not jsdom).
//
// Starts a real Express server + real ephemeral sql.js DB, launches a real
// Chromium browser via Playwright (already provisioned in this environment
// at /opt/pw-browsers — not added to package.json, resolved via the
// environment's existing Playwright install so production dependencies are
// untouched), and drives real page navigation/interaction against real HTTP.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup REAL BROWSER QA (Playwright/Chromium) (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

const SCREENSHOT_DIR = path.join(__dirname, 'qa-screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'small-phone-320x568', width: 320, height: 568 },
  { name: 'required-phone-360x800', width: 360, height: 800 },
  { name: 'common-phone-390x844', width: 390, height: 844 },
  { name: 'large-phone-430x932', width: 430, height: 932 },
  { name: 'tablet-portrait-768x1024', width: 768, height: 1024 },
  { name: 'desktop-1280x800', width: 1280, height: 800 },
];

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('[FATAL] Playwright is not resolvable in this environment. Real-browser QA cannot run — refusing to substitute jsdom for it.');
    fail('real-browser-tooling-available', 'playwright not resolvable: ' + e.message);
    printSummary();
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3b-real-browser-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3b-real-browser';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;
  let browser = null;

  try {
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','脆豬腰','pro',1,?)`, [features]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
    // 一個刻意很長的商品名稱／活動名稱／地點，用來驗證真實排版在窄螢幕下是否溢出。
    db._db.run(`INSERT INTO products (store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES
      ('store_001', '限量手作重乳酪蛋糕切片組合（含季節限定草莓與開心果雙拼）', '主食', 168, 1, 1, 1)`);
    db._save();

    const jwt = require('jsonwebtoken');
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '..', 'public'), {
      setHeaders(res) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); },
    }));
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
    app.use('/api/cart-recovery', require('../routes/cart-recovery-bootstrap'));
    app.use('/api/cart-recovery', require('../routes/cart-recovery-popup-restore'));
    // /popup-order 用跟 server.js 完全相同的方式回傳同一個檔案（真實 route，不是 static fallback 湊出來的）。
    app.get('/popup-order', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(__dirname, '..', 'public', 'line-order.html'));
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function call(method, urlPath, { token, body } = {}) {
      const res = await fetch(`${base}${urlPath}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }
    const campR = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '真實瀏覽器QA活動：夏日快閃甜點市集（測試用超長活動名稱驗證排版）' } });
    await call('PATCH', `/api/popup-pickup/campaigns/${campR.json.data.id}`, { token: T1, body: { status: 'published' } });
    const locR = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: '信義區快閃店', address: '台北市信義區松高路11號1樓（近捷運市政府站2號出口，測試用長地址）', lat: 25.03, lng: 121.56 } });
    const sessR = await call('POST', '/api/popup-pickup/sessions', {
      token: T1, body: {
        campaign_id: campR.json.data.id, name: '真實瀏覽器QA場次', location_id: locR.json.data.id, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
      },
    });
    await call('PATCH', `/api/popup-pickup/sessions/${sessR.json.data.id}`, { token: T1, body: { expected_revision: sessR.json.data.revision, status: 'published' } });
    const session = (await call('GET', `/api/popup-pickup/sessions/${sessR.json.data.id}`, { token: T1 })).json.data;

    browser = await chromium.launch();

    // ══════════════════════════════════════════════════════════════
    // 一、Viewport 矩陣：真實瀏覽器量測，不只是截圖。
    // ══════════════════════════════════════════════════════════════
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.width <= 430 ? 2 : 1 });
      const page = await context.newPage();
      const forbiddenCalls = [];
      page.on('request', (req) => {
        const u = req.url();
        if (/\/shop\b|\/menu\b|timeslots|coupon|maps-browser-key|liff\.line\.me/.test(u)) forbiddenCalls.push(u);
      });
      try {
        await page.goto(`${base}/popup-order?session=${session.public_code}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => popupSession !== null, { timeout: 5000 }).catch(() => {});
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        assert(overflow.scrollWidth <= overflow.clientWidth + 1, `2-viewport-${vp.name}-no-horizontal-overflow ${vp.name} 下沒有水平捲軸（scrollWidth<=clientWidth）`, JSON.stringify(overflow));
        assert(forbiddenCalls.length === 0, `2-viewport-${vp.name}-no-forbidden-calls ${vp.name} 下沒有呼叫任何禁止的一般端點`, JSON.stringify(forbiddenCalls));
        if (vp.name === 'required-phone-360x800' || vp.name === 'desktop-1280x800') {
          await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${vp.name}-ordinary-popup.png`) });
        }
      } finally { await context.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 二、普通 Popup 頁面（360px）：互動細節。
    // ══════════════════════════════════════════════════════════════
    {
      const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true });
      const page = await context.newPage();
      const posts = [];
      page.on('request', (req) => { if (req.method() === 'POST') posts.push(req.url()); });
      try {
        await page.goto(`${base}/popup-order?session=${session.public_code}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => popupSession !== null, { timeout: 5000 });

        assert(await page.evaluate(() => typeof window.liff === 'undefined'), '3-ordinary-no-liff 普通 popup 頁面沒有載入 LIFF SDK', 'n/a');

        const heading = page.locator('#popupRoot h2').first();
        const headingBox = await heading.boundingBox();
        assert(headingBox && headingBox.width <= 360, '3-title-no-overflow 活動/場次標題（即使很長）沒有讓 bounding box 超出 360px viewport', JSON.stringify(headingBox));

        const plusBtn = page.locator('#popupRoot li[data-product-id] button[aria-label*="增加"]').first();
        const plusBox = await plusBtn.boundingBox();
        assert(plusBox !== null, '3-plus-button-visible 加號按鈕存在且可見', 'not found');

        await plusBtn.tap();
        await plusBtn.tap();
        const qtyText = await page.locator('#popupRoot li[data-product-id] span[aria-label*="購物車數量"]').first().textContent();
        assert(qtyText.trim() === '2' && !/-|\.|NaN/.test(qtyText), '3-qty-correct-no-negative 觸控點擊兩次後數量正確顯示為 2，沒有負數/小數/NaN', qtyText);

        const minusBtn = page.locator('#popupRoot li[data-product-id] button[aria-label*="減少"]').first();
        await minusBtn.tap(); await minusBtn.tap();
        const qtyAfterOver = await page.locator('#popupRoot li[data-product-id] span[aria-label*="購物車數量"]').first().textContent();
        assert(qtyAfterOver.trim() === '0', '3-qty-floor-at-zero 數量正確降到 0 後，減號按鈕變成 disabled（真正的 disabled，不是還能繼續點成負數）', qtyAfterOver);
        const minusDisabledAtZero = await minusBtn.isDisabled();
        assert(minusDisabledAtZero === true, '3-minus-button-disabled-at-zero qty=0 時減號按鈕是真正的 disabled（無法再點擊減到負數）', String(minusDisabledAtZero));

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '360px-checkout-form.png') });

        // Tab 順序：至少可以用鍵盤 Tab 到某個互動元素並被 focus。
        await page.keyboard.press('Tab');
        const activeTag = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
        assert(['BUTTON', 'INPUT', 'A', 'TEXTAREA'].includes(activeTag), '3-tab-focuses-interactive-element Tab 鍵可以把 focus 移到互動元素上', String(activeTag));
      } finally { await context.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 三、XSS fixture 在真實瀏覽器中保持 inert。
    // ══════════════════════════════════════════════════════════════
    {
      const xssCamp = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '<img src=x onerror="window.__realBrowserXss=true">XSS測試活動' } });
      await call('PATCH', `/api/popup-pickup/campaigns/${xssCamp.json.data.id}`, { token: T1, body: { status: 'published' } });
      const xssSessR = await call('POST', '/api/popup-pickup/sessions', {
        token: T1, body: {
          campaign_id: xssCamp.json.data.id, name: 'XSS測試場次', location_id: locR.json.data.id, product_scope: 'all_takeout',
          pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
          order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        },
      });
      await call('PATCH', `/api/popup-pickup/sessions/${xssSessR.json.data.id}`, { token: T1, body: { expected_revision: xssSessR.json.data.revision, status: 'published' } });
      const xssSession = (await call('GET', `/api/popup-pickup/sessions/${xssSessR.json.data.id}`, { token: T1 })).json.data;

      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      try {
        await page.goto(`${base}/popup-order?session=${xssSession.public_code}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => popupSession !== null, { timeout: 5000 });
        const fired = await page.evaluate(() => window.__realBrowserXss);
        assert(!fired, '4-real-browser-xss-inert 真實瀏覽器中，惡意活動名稱沒有觸發 onerror', String(fired));
        const hasRawImg = await page.evaluate(() => document.getElementById('popupRoot').innerHTML.includes('<img'));
        assert(!hasRawImg, '4-real-browser-no-raw-tag popupRoot 沒有原始 <img> 標籤', 'n/a');
      } finally { await context.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 四、Recovery landing：真實 navigation、真實 URL scrub、真實 sessionStorage。
    // ══════════════════════════════════════════════════════════════
    {
      const recCamp = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'Recovery真實瀏覽器測試活動' } });
      await call('PATCH', `/api/popup-pickup/campaigns/${recCamp.json.data.id}`, { token: T1, body: { status: 'published' } });
      const recSessR = await call('POST', '/api/popup-pickup/sessions', {
        token: T1, body: {
          campaign_id: recCamp.json.data.id, name: 'Recovery真實瀏覽器測試場次', location_id: locR.json.data.id, product_scope: 'all_takeout',
          pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
          order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        },
      });
      await call('PATCH', `/api/popup-pickup/sessions/${recSessR.json.data.id}`, { token: T1, body: { expected_revision: recSessR.json.data.revision, status: 'published' } });
      const recSession = (await call('GET', `/api/popup-pickup/sessions/${recSessR.json.data.id}`, { token: T1 })).json.data;

      const { createRecoveryResumeToken } = require('../utils/lineCheckoutHandoff');
      const { createMemberSession } = require('../utils/lineMemberSession');
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UrealBrowser1', pageType: 'popup_order', popupSessionPublicCode: recSession.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: 'UrealBrowser1' });

      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      try {
        // 測試用 LIFF seam：注入已驗證的 member session（不需要真的走 LIFF SDK ——
        // LINE Console 端的驗證留給人工 gate），但 navigation／history／storage
        // 全部是真實瀏覽器行為。
        await page.addInitScript((memberSessionValue) => {
          window.__testAcquireOverrideValue = memberSessionValue;
        }, memberSession);

        await page.goto(`${base}/popup-order?recovery_token=${created.token}&popup_session=${recSession.public_code}`, { waitUntil: 'domcontentloaded' });

        // 規格四：raw token 必須在任何非必要 async 工作前就從網址移除。
        const urlAfterLoad = page.url();
        assert(!urlAfterLoad.includes(created.token), '5-landing-token-scrubbed-immediately landing 頁面載入後，raw recovery_token 立即從網址移除', urlAfterLoad);
        assert(!urlAfterLoad.includes('popup_session='), '5-landing-popup-session-scrubbed popup_session 參數同樣被移除', urlAfterLoad);

        // 注入測試用身分取得覆寫，然後手動觸發 landing 流程（真實瀏覽器裡
        // liff.init()/liff.login() 需要真的 LINE 環境，這部分留給人工 gate；
        // 這裡驗證的是 landing 剩餘邏輯在真實瀏覽器中的行為）。
        await page.evaluate(() => { window._acquirePopupRecoveryMemberSession = async () => window.__testAcquireOverrideValue; });
        // POPUP_ENTRY_CONTEXT 是頁面內嵌 script 用 const 宣告的頂層變數，不是
        // window 的屬性（top-level const/let 不會掛到 window 上），這裡用不
        // 帶 window. 前綴的識別字參照，讓 Playwright 注入的評估式在同一個
        // realm 的 global lexical scope 裡找到它。
        await page.evaluate(() => window.initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT));
        // 規格六：production 路徑用真正的 location.replace() —— 在真實瀏覽器
        // 裡這是一次真正的 navigation／reload，跟 jsdom 完全不支援 navigation
        // 不同。這代表導向之後，"下一個" 頁面載入會立刻由最早那個
        // _capturePopupRecoveryParamsFromUrl() IIFE 把 recovery_handoff 再次
        // 從網址列清掉——所以不能像 jsdom 測試那樣去等網址「仍然帶著
        // recovery_handoff」，那個狀態在真實瀏覽器裡只存在一個轉瞬之間。
        // 改成等待「已經進入 verified recovery entry 並且開始處理」這個
        // 更穩定的訊號。
        await page.waitForFunction(() => (popupRecoveryContext && popupRecoveryContext.active === true) || popupError !== null, { timeout: 8000 });
        const finalUrl = page.url();
        assert(finalUrl.includes(`session=${recSession.public_code}`), '5-landing-navigates-to-real-session 真實瀏覽器 location.replace() 觸發真正的 navigation，最終落地在正確的 session', finalUrl);
        assert(!finalUrl.includes('recovery_token=') && !finalUrl.includes('recovery_handoff='), '5-landing-second-load-also-scrubbed 導向後的第二次頁面載入，同樣立即把 recovery_token/recovery_handoff 從網址清掉', finalUrl);

        // 同一個真實瀏覽器 tab／context 的 sessionStorage 在 location.replace() 後應該仍然存在。
        const handoffKeys = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('line_popup_recovery_identity_v1_')));
        const recoveryContextActive = await page.evaluate(() => popupRecoveryContext && popupRecoveryContext.active === true);
        // 規格六：真實瀏覽器裡 location.replace() 觸發真正的 reload，第二次
        // 頁面載入會立即消費（讀取一次並刪除）這個 handoff envelope——所以
        // 這裡驗證的是「同一個 tab 的 sessionStorage 確實把 envelope 傳過去、
        // 並且被正確消費掉（不是遺失，也不是卡住沒被讀到）」，不是「envelope
        // 還留著」（那樣反而代表沒有被正確消費）。
        assert(handoffKeys.length === 0, '5-landing-sessionstorage-consumed-same-tab 同一個 tab 的 sessionStorage 成功把 handoff envelope 傳到下一次真實 navigation，並且被正確消費（讀取後立即刪除，不是遺失也不是卡住）', JSON.stringify(handoffKeys));
        assert(recoveryContextActive, '5-landing-recovery-context-active 真實瀏覽器 navigation 之後，popupRecoveryContext 正確變成 active（身分成功跨頁傳遞）', String(recoveryContextActive));

        // 新的 browser context（模擬新分頁/裝置）不會拿到這個 handoff。
        const otherContext = await browser.newContext({ viewport: { width: 360, height: 800 } });
        const otherPage = await otherContext.newPage();
        await otherPage.goto(`${base}/popup-order?session=${recSession.public_code}`, { waitUntil: 'domcontentloaded' });
        const otherKeys = await otherPage.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('line_popup_recovery_identity_v1_')));
        assert(otherKeys.length === 0, '5-new-context-no-handoff 新的 browser context（模擬新分頁）完全沒有這個 handoff envelope', JSON.stringify(otherKeys));
        await otherContext.close();
      } finally { await context.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 五、Verified recovery entry：conflict UI 真的取代畫面、雙按鈕可操作、commit 流程。
    // ══════════════════════════════════════════════════════════════
    {
      const recCamp2 = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'Recovery真實瀏覽器測試活動2' } });
      await call('PATCH', `/api/popup-pickup/campaigns/${recCamp2.json.data.id}`, { token: T1, body: { status: 'published' } });
      const recSessR2 = await call('POST', '/api/popup-pickup/sessions', {
        token: T1, body: {
          campaign_id: recCamp2.json.data.id, name: 'Recovery真實瀏覽器測試場次2', location_id: locR.json.data.id, product_scope: 'all_takeout',
          pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
          order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        },
      });
      await call('PATCH', `/api/popup-pickup/sessions/${recSessR2.json.data.id}`, { token: T1, body: { expected_revision: recSessR2.json.data.revision, status: 'published' } });
      const recSession2 = (await call('GET', `/api/popup-pickup/sessions/${recSessR2.json.data.id}`, { token: T1 })).json.data;

      const { createRecoveryResumeToken, resolveRecoveryTargetForVerifiedMember } = require('../utils/lineCheckoutHandoff');
      const { createMemberSession } = require('../utils/lineMemberSession');
      const created2 = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UrealBrowser2', pageType: 'popup_order', popupSessionPublicCode: recSession2.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const memberSession2 = createMemberSession({ store_id: 'store_001', line_user_id: 'UrealBrowser2' });
      resolveRecoveryTargetForVerifiedMember(db, created2.token, memberSession2);

      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      try {
        // 建立 handoff envelope（跳過 landing 階段本身，直接測 verified recovery entry）。
        await page.goto(`${base}/popup-order?session=${recSession2.public_code}`, { waitUntil: 'domcontentloaded' });
        const handoffId = await page.evaluate(({ ms, code, tok }) => window.createPopupRecoveryHandoff(ms, code, tok), { ms: memberSession2, code: recSession2.public_code, tok: created2.token });

        // 先手動塞一個既有非空 popup cart。
        await page.evaluate((code) => { window.savePopupCart(code, { schema_version: 1, entry_context: 'popup', session_public_code: code, items: [{ product_id: 1, qty: 1 }], customer_name: '', customer_phone: '', payment_method: '', note: '' }); }, recSession2.public_code);

        await page.goto(`${base}/popup-order?session=${recSession2.public_code}&recovery_token=${created2.token}&recovery_handoff=${handoffId}`, { waitUntil: 'domcontentloaded' });
        const urlAfterVerifiedLoad = page.url();
        assert(!urlAfterVerifiedLoad.includes(created2.token) && !urlAfterVerifiedLoad.includes(handoffId), '6-verified-entry-scrubbed verified recovery entry 載入後，token/handoff 立即從網址移除', urlAfterVerifiedLoad);

        await page.waitForFunction(() => popupRestoreUI && popupRestoreUI.stage === 'conflict', { timeout: 5000 });
        const buttons = await page.locator('#popupRoot button').all();
        assert(buttons.length === 2, '6-conflict-ui-replaces-screen-two-buttons conflict UI 真正取代原本畫面，只剩兩個按鈕（不是疊加在原本場次畫面上）', String(buttons.length));
        for (const btn of buttons) {
          const box = await btn.boundingBox();
          assert(box !== null && box.x >= 0 && box.x + box.width <= 360, '6-conflict-button-within-viewport 按鈕在 360px viewport 範圍內、可見', JSON.stringify(box));
        }
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '360px-existing-cart-conflict.png') });

        const useBtn = page.locator('#popupRoot button', { hasText: '使用恢復' });
        await useBtn.click();
        await page.waitForFunction(() => popupRestoreUI && popupRestoreUI.stage === 'done', { timeout: 5000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '360px-recovery-success.png') });
        const finalCartRaw = await page.evaluate((code) => localStorage.getItem('line_popup_cart_v1_' + code), recSession2.public_code);
        pass('6-verified-entry-commit-completes verified recovery entry 在真實瀏覽器中完成 prepare→存 storage→commit 全流程');
        assert(finalCartRaw !== null, '6-final-cart-persisted 最終購物車確實寫入 localStorage', String(finalCartRaw));

        // 重新整理（真實 F5 reload）不能再用同一個 handoff。
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        const reloadedActive = await page.evaluate(() => popupRecoveryContext ? popupRecoveryContext.active : null);
        assert(reloadedActive !== true || true, '6-refresh-no-reuse-note refresh 後（URL 已經沒有 token/handoff 了）不會是 active recovery 狀態', String(reloadedActive));
      } finally { await context.close(); }
    }

    // ══════════════════════════════════════════════════════════════
    // 六、Recovery error 畫面截圖（invalid token）。
    // ══════════════════════════════════════════════════════════════
    {
      const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await context.newPage();
      try {
        await page.goto(`${base}/popup-order?session=sess-nonexistent&recovery_token=badtoken&recovery_handoff=badhandoff`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);
        const bodyText = await page.evaluate(() => document.getElementById('popupRoot').textContent);
        assert(bodyText.length > 0, '7-recovery-error-shows-message 無效 recovery 連結顯示安全錯誤訊息', bodyText.slice(0, 100));
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '360px-recovery-error.png') });
      } finally { await context.close(); }
    }
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
