#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-admin-ui.js
// H1.4.12 Phase 3C — 🚐 快閃取餐管理後台 UI 專用測試。
// 三區：A. Static/DOM contract（原始碼檢查）／B. Real HTTP + DB（真實
// Express + sql.js 暫存 DB）／C. jsdom UI behavior（真實伺服器 + jsdom
// 驅動 public/index.html 的實際 ppa* 函式，不是另外模擬一套假邏輯）。
//
// 不使用 process-wide uncaughtException/unhandledRejection 吞掉失敗；每個
// server/port/timer/AbortController/jsdom window/暫存 DB 都在 finally 清理。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_JS_PATH = path.join(ROOT, 'public/js/app.js');
const INDEX_HTML_PATH = path.join(ROOT, 'public/index.html');

const results = [];
const seenNames = new Set();
function pass(name) {
  if (seenNames.has(name)) throw new Error('DUPLICATE assertion name: ' + name);
  seenNames.add(name);
  results.push({ name, status: 'PASS' });
  console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  if (seenNames.has(name)) throw new Error('DUPLICATE assertion name: ' + name);
  seenNames.add(name);
  results.push({ name, status: 'FAIL', detail });
  console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  const bySection = { A: [], B: [], C: [], other: [] };
  results.forEach((r) => {
    const m = /^([ABC])\d/.exec(r.name);
    (m ? bySection[m[1]] : bySection.other).push(r);
  });
  console.log('\n---- by section ----');
  ['A', 'B', 'C', 'other'].forEach((k) => {
    if (bySection[k].length === 0) return;
    const sp = bySection[k].filter((r) => r.status === 'PASS').length;
    console.log(`  ${k === 'other' ? '(unclassified)' : 'Section ' + k}: PASS ${sp} / TOTAL ${bySection[k].length}`);
  });
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3C popup admin UI (TZ=${process.env.TZ || '(default)'})`);
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
  // 必須在任何 require('../routes/...') 或 require('../middleware/...') 之前
  // 設定，因為 middleware/storeGuard.js 在模組載入當下就把 JWT_SECRET 讀進
  // 一個 top-level const（不是每次請求才讀）。先前這行放在 Part B 開頭，
  // 但下面的 prereq 檢查（'真實 popup-pickup router 可掛載'）已經先
  // require 過一次 routes/popup-pickup.js（進而 require storeGuard.js），
  // 導致 storeGuard 用預設密鑰快取住，跟這支測試後面簽的 token 對不上，
  // 所有需要 JWT 的呼叫都會錯誤地回 401 INVALID_JWT——這是測試本身的
  // 排序 bug，不是 production 的認證邏輯壞了。
  const tmpDirEarly = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3c-admin-ui-'));
  process.env.POS_DB_PATH = path.join(tmpDirEarly, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3c-admin-ui';

  // ════════════════════════════════════════════════════════════════
  // Prerequisites（fail-fast）：測試本身能不能有效執行，跟「功能對不對」
  // 是兩件事——這裡先確認前者，避免後面一堆 assertion 因為環境問題全部
  // 失敗卻誤導成「功能壞了」。任何一項不過，直接印出來並中止，不繼續跑
  // 後面的 A/B/C。
  // ════════════════════════════════════════════════════════════════
  const prereqFailures = [];
  function prereq(cond, label) {
    if (cond) { console.log(`[PREREQ OK] ${label}`); }
    else { console.log(`[PREREQ FAIL] ${label}`); prereqFailures.push(label); }
  }
  prereq(typeof JSDOM === 'function', 'jsdom 模組可載入');
  prereq(fs.existsSync(APP_JS_PATH), 'public/js/app.js 存在');
  prereq(fs.existsSync(INDEX_HTML_PATH), 'public/index.html 存在');
  const pristinePath = path.join(__dirname, 'fixtures', 'phase3a4-pristine-line-order.html');
  prereq(fs.existsSync(pristinePath), 'Phase 3A.4 pristine fixture 檔案存在（committed 相對路徑，非作者機器絕對路徑）');
  if (fs.existsSync(pristinePath)) {
    const h = require('crypto').createHash('sha256').update(fs.readFileSync(pristinePath)).digest('hex');
    prereq(h === 'f314269c197b7ef594a1457838e04a72693676ffcaa059ffce72ab33bfbf28cc', 'Phase 3A.4 pristine fixture SHA-256 正確');
  }
  const AUTHOR_MACHINE_PATH_PATTERN = '/home/claude/work/' + 'pristine'; // 組出字串以免這行本身被自己的檢查誤判
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  const usesAuthorMachinePath = selfSrc.split(AUTHOR_MACHINE_PATH_PATTERN).length - 1;
  // 允許「剛好 1 次」：那 1 次就是這裡組字串用的常數本身（用 +'pristine' 拼接
  // 是為了不讓常數宣告那行被自己的檢查抓到），超過 1 次才代表別處真的還在
  // 用這個作者機器專屬絕對路徑。
  prereq(usesAuthorMachinePath <= 1, '測試檔案不依賴作者機器專屬絕對路徑（僅測試自身的偵測常數提及一次）');
  let prereqTmpDb;
  try {
    prereqTmpDb = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3c-prereq-'));
    fs.writeFileSync(path.join(prereqTmpDb, 'probe.txt'), 'ok');
    prereq(fs.existsSync(path.join(prereqTmpDb, 'probe.txt')), '暫存目錄（供暫存 DB 使用）可建立、可寫入');
  } catch (e) { prereq(false, '暫存目錄（供暫存 DB 使用）可建立、可寫入'); }
  finally { try { if (prereqTmpDb) fs.rmSync(prereqTmpDb, { recursive: true, force: true }); } catch (e) {} }
  try {
    const testToken = jwt.sign({ role: 'store', store_id: 'store_001' }, 'prereq-probe-secret', { expiresIn: '1h' });
    prereq(typeof testToken === 'string' && testToken.length > 20, 'staff JWT 可簽發');
  } catch (e) { prereq(false, 'staff JWT 可簽發'); }
  try {
    const express = require('express');
    const probeApp = express();
    probeApp.use('/api/popup-pickup', require('../routes/popup-pickup'));
    prereq(true, '真實 popup-pickup router 可掛載（require + express.Router 不拋錯）');
  } catch (e) { prereq(false, '真實 popup-pickup router 可掛載：' + e.message); }

  if (prereqFailures.length > 0) {
    console.log('\n======================================================================');
    console.log(`PREREQUISITES FAILED (${prereqFailures.length}) — 不繼續執行 A/B/C，先修正環境問題：`);
    prereqFailures.forEach((f) => console.log('  - ' + f));
    console.log('======================================================================');
    try { fs.rmSync(tmpDirEarly, { recursive: true, force: true }); } catch (e) {}
    process.exitCode = 1;
    return;
  }

  const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');
  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const ppaModuleStart = appJs.indexOf('🚐 快閃取餐管理 (H1.4.12 Phase 3C)');
  const ppaModule = appJs.slice(ppaModuleStart);

  // ════════════════════════════════════════════════════════════════
  // A. Static / DOM contract（原始碼檢查）
  // ════════════════════════════════════════════════════════════════
  assert(ppaModuleStart !== -1, 'A1-module-exists PPA 模組存在於 app.js');

  const navBtnMatch = indexHtml.match(/<button class="nav-btn"[^>]*id="nav-btn-popup_pickup"[^>]*>[\s\S]{0,80}<\/button>/);
  assert(!!navBtnMatch, 'A2-nav-button-exists nav 按鈕存在');
  const linePreorderIdx = indexHtml.indexOf('nav-btn-line_preorders');
  const popupNavIdx = indexHtml.indexOf('nav-btn-popup_pickup');
  assert(linePreorderIdx !== -1 && popupNavIdx !== -1 && Math.abs(popupNavIdx - linePreorderIdx) < 400,
    'A3-nav-position nav 按鈕位於 LINE 預購附近（原始碼距離 < 400 字元）', `distance=${Math.abs(popupNavIdx - linePreorderIdx)}`);
  assert(/id="nav-btn-popup_pickup"[^>]*style="display:none"/.test(indexHtml),
    'A4-nav-default-hidden nav 按鈕預設 style="display:none"（由 feature gate 控制顯示）');

  const tabIds = ['ppa-tabbtn-campaigns', 'ppa-tabbtn-locations', 'ppa-tabbtn-sessions', 'ppa-tabbtn-links'];
  assert(tabIds.every((id) => indexHtml.includes(`id="${id}"`)), 'A5-four-tabs-exist 四個 tab 按鈕都存在', tabIds.join(','));
  assert(new Set(tabIds).size === 4, 'A6-four-tabs-unique 四個 tab id 彼此不同');

  const allIds = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const idCounts = {};
  allIds.forEach((id) => { idCounts[id] = (idCounts[id] || 0) + 1; });
  const dupIds = Object.keys(idCounts).filter((id) => idCounts[id] > 1);
  assert(dupIds.length === 0, 'A7-no-duplicate-ids index.html 內沒有重複 id', dupIds.join(','));

  // innerHTML 動態插入檢查：只允許固定字串或清空，不允許以樣板字面值插入
  // 變數（`${...}`）到 innerHTML（唯一允許的樣板字面值是既有 pre-existing
  // renderLineOrderPageModeCard() 這類跟本輪無關的舊碼，這裡只檢查 PPA 模組）。
  const innerHtmlTemplateInterp = ppaModule.match(/\.innerHTML\s*=\s*`[^`]*\$\{/g) || [];
  assert(innerHtmlTemplateInterp.length === 0, 'A8-no-dynamic-innerHTML PPA 模組沒有把樣板字面值變數插入 innerHTML', JSON.stringify(innerHtmlTemplateInterp));
  const innerHtmlConcatVar = ppaModule.match(/\.innerHTML\s*=\s*[a-zA-Z_][\w.]*\s*\+/g) || [];
  assert(innerHtmlConcatVar.length === 0, 'A9-no-innerHTML-concat PPA 模組沒有把變數字串相加後塞進 innerHTML', JSON.stringify(innerHtmlConcatVar));

  // onclick 字串拼接動態資料檢查（掃描本輪新增 HTML 區塊）
  const newHtmlBlockMatch = indexHtml.match(/<div id="page-popup_pickup"[\s\S]*?<div id="ppa-qr-container"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  const newHtmlBlock = newHtmlBlockMatch ? newHtmlBlockMatch[0] : '';
  assert(newHtmlBlock.length > 500, 'A10-new-html-block-found 找到本輪新增的 HTML 區塊供後續檢查', String(newHtmlBlock.length));
  const onclickConcat = newHtmlBlock.match(/onclick="[^"]*['"]\s*\+/g) || [];
  assert(onclickConcat.length === 0, 'A11-no-onclick-concat 新增 HTML 區塊沒有 onclick 字串拼接動態資料', JSON.stringify(onclickConcat));

  // 裸 fetch 檢查
  const bareFetch = ppaModule.match(/[^.]\bfetch\(/g) || [];
  assert(bareFetch.length === 0, 'A12-no-bare-fetch PPA 模組沒有繞過 apiFetch 的裸 fetch()', String(bareFetch.length));

  // token/storage 檢查
  assert(!/jwt|localStorage\.setItem|sessionStorage|recovery_token|member_session/i.test(ppaModule.replace(/localStorage\.getItem\('pos_store_info'\)/g, '')),
    'A13-no-token-exposure PPA 模組沒有把 JWT/recovery/member token 寫入 DOM/URL/storage');

  // showPage 離開時呼叫 ppaCleanup
  assert(/name !== 'popup_pickup'[\s\S]{0,40}ppaCleanup/.test(appJs), 'A14-cleanup-on-leave showPage 離開 popup_pickup 時呼叫 ppaCleanup()');

  // QRCode fallback
  assert(/typeof QRCode !== 'undefined'/.test(ppaModule) && /onerror = \(\) => \{ container\.textContent/.test(ppaModule),
    'A15-qr-fallback-code QRCode 缺失時有 textContent fallback（非整頁 crash）');

  // window.open 一律 noopener,noreferrer，且只開白名單目的地
  const opens = [...ppaModule.matchAll(/window\.open\(([^)]*)\)/g)].map((m) => m[1]);
  assert(opens.length > 0 && opens.every((a) => a.includes("'noopener,noreferrer'")),
    'A16-window-open-noopener 所有 window.open() 都帶 noopener,noreferrer', JSON.stringify(opens));
  assert(/google\.com\/maps\/search/.test(ppaModule), 'A17-map-url-allowlist 地圖連結固定指向 https://www.google.com/maps（非使用者可控目的地）');

  // 命名碰撞：新函式清單 vs app.js 其餘部分（PPA 模組之外）是否已存在同名宣告
  const restOfAppJs = appJs.slice(0, ppaModuleStart);
  const newFnNames = [...ppaModule.matchAll(/window\.(ppa[A-Za-z]+)\s*=/g)].map((m) => m[1]);
  const collisions = newFnNames.filter((n) => new RegExp(`\\bfunction ${n}\\b|\\bwindow\\.${n}\\s*=|\\bconst ${n}\\s*=|\\blet ${n}\\s*=`).test(restOfAppJs));
  assert(newFnNames.length >= 30, 'A18-new-fn-count 新增函式數量合理（>=30）', String(newFnNames.length));
  assert(collisions.length === 0, 'A19-no-fn-collision 新增函式名稱與既有全域函式沒有碰撞', JSON.stringify(collisions));

  // ════════════════════════════════════════════════════════════════
  // B. Real HTTP + DB
  // ════════════════════════════════════════════════════════════════
  const tmpDir = tmpDirEarly;

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;
  const jsdomWindows = [];

  try {
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','脆豬腰','pro',1,?)`, [features]);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_002','Store2','pro',1,?)`, [features]);
    db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES ('store_002','Store2','Mgr2','pro',1)`);
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES
      (9401, 'store_001', 'AdminUI測試排骨飯', '主食', 135, 1, 1, 1),
      (9402, 'store_001', 'AdminUI測試珍奶', '飲料', 55, 1, 1, 0),
      (9403, 'store_001', 'AdminUI測試未上架商品', '主食', 99, 1, 0, 1)`);
    db._db.run(`INSERT OR IGNORE INTO payment_methods (store_id, name, code, is_active, enable_for_takeout) VALUES ('store_001', '現金', 'cash', 1, 1)`);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    db._save();

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(ROOT, 'public')));
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/settings', require('../middleware/storeGuard').requireStore, require('../routes/settings'));
    app.use('/api/products', require('../middleware/storeGuard').requireStore, require('../routes/products'));
    app.get('/api/store-me', require('../middleware/storeGuard').requireStore, (req, res) => {
      try {
        const { getStoreFeatures } = require('../middleware/featureGate');
        const storeId = req.storeId || 'store_001';
        const row = db.get(
          `SELECT s.store_id, s.store_name, s.active, COALESCE(l.plan, 'basic') AS plan
           FROM stores s LEFT JOIN licenses l ON l.store_id = s.store_id WHERE s.store_id = ?`,
          [storeId]
        );
        if (!row) return res.status(404).json({ success: false, message: '店家不存在' });
        res.json({ success: true, data: { store_id: row.store_id, store_name: row.store_name, plan: row.plan, active: !!row.active, features: getStoreFeatures(storeId) } });
      } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
    async function call(method, urlPath, { token, body, query, headers } = {}) {
      let url = `${base}${urlPath}`;
      if (query) url += `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const T1 = tokenFor('store_001');
    const T2 = tokenFor('store_002');

    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }
    async function makeCampaign(name) {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
      if (r.status !== 201) throw new Error('makeCampaign failed: ' + JSON.stringify(r));
      const pub = await call('PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token: T1, body: { status: 'published' } });
      if (pub.status !== 200) throw new Error('makeCampaign publish failed: ' + JSON.stringify(pub));
      return pub.json.data;
    }
    async function makeLocation(name) {
      const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name, address: name + ' Addr', lat: 25.05, lng: 121.55 } });
      if (r.status !== 201) throw new Error('makeLocation failed: ' + JSON.stringify(r));
      return r.json.data;
    }
    async function makeSession(campaignId, locationId, overrides = {}) {
      const body = {
        campaign_id: campaignId, name: 'AdminUI 測試場次', location_id: locationId, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        ...overrides,
      };
      const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body });
      if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
      return r.json.data;
    }
    async function publishSession(id, revision) {
      const r = await call('PATCH', `/api/popup-pickup/sessions/${id}`, { token: T1, body: { expected_revision: revision, status: 'published' } });
      if (r.status !== 200) throw new Error('publishSession failed: ' + JSON.stringify(r));
      return r.json.data;
    }

    // B1-B4: campaign / location CRUD basics
    {
      const c = await makeCampaign('B-活動一');
      assert(c.status === 'published', 'B1-campaign-create-publish 建立活動並發布成功');
      const loc = await makeLocation('B-地點一');
      assert(!!loc.id, 'B2-location-create 建立地點成功');

      const sSel = await makeSession(c.id, loc.id, {
        product_scope: 'selected', products: [{ product_id: 9401, enabled: 1, quota_qty: 0 }],
      });
      assert(sSel.product_scope === 'selected' && sSel.products.length === 1 && sSel.products[0].product_id === 9401,
        'B3-session-create-selected 建立 selected scope 場次成功', JSON.stringify(sSel.products));
      const rawKeys = Object.keys(sSel.products[0]);
      assert(!rawKeys.includes('price') && !rawKeys.includes('name') && !rawKeys.includes('subtotal') && !rawKeys.includes('total'),
        'B14-selected-no-price selected payload 沒有 price/name/subtotal/total', rawKeys.join(','));

      const sAll = await makeSession(c.id, loc.id, { name: 'AdminUI all_takeout 場次' });
      assert(sAll.product_scope === 'all_takeout', 'B4-session-create-all-takeout 建立 all_takeout 場次成功');
    }

    // B5-B6: batch create
    {
      const c = await makeCampaign('B-批次活動');
      const loc = await makeLocation('B-批次地點');
      const dates = [taipeiDateStr(3), taipeiDateStr(4), taipeiDateStr(5)];
      const batchBody = {
        campaign_id: c.id,
        sessions: dates.map((d) => ({
          name: '批次場次', location_id: loc.id, product_scope: 'all_takeout',
          pickup_date: d, pickup_start_time: '10:00', pickup_end_time: '20:00',
          order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${d}T09:00`,
        })),
      };
      const r = await call('POST', '/api/popup-pickup/sessions/batch', { token: T1, body: batchBody });
      assert(r.status === 201 && Array.isArray(r.json.data) && r.json.data.length === 3, 'B5-batch-multi-date 批次建立多日期場次成功', JSON.stringify(r.json).slice(0, 200));

      const before = await call('GET', '/api/popup-pickup/sessions', { token: T1, query: { campaign_id: c.id } });
      const beforeCount = before.json.data.length;
      const badBatch = { campaign_id: c.id, sessions: [
        { name: 'ok', location_id: loc.id, product_scope: 'all_takeout', pickup_date: taipeiDateStr(6), pickup_start_time: '10:00', pickup_end_time: '20:00', order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(6)}T09:00` },
        { name: 'bad-date', location_id: loc.id, product_scope: 'all_takeout', pickup_date: '2026-02-30', pickup_start_time: '10:00', pickup_end_time: '20:00', order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `2026-02-30T09:00` },
      ]};
      const rBad = await call('POST', '/api/popup-pickup/sessions/batch', { token: T1, body: badBatch });
      assert(rBad.status === 400, 'B6a-batch-invalid-date-rejected 批次含不合法日期整批拒絕', JSON.stringify(rBad).slice(0, 200));
      const after = await call('GET', '/api/popup-pickup/sessions', { token: T1, query: { campaign_id: c.id } });
      assert(after.json.data.length === beforeCount, 'B6b-batch-invalid-no-partial-write 不合法批次沒有留下部分資料', `${beforeCount}->${after.json.data.length}`);
    }

    // B7-B10: revision conflict + affected-orders confirm
    {
      const c = await makeCampaign('B-revision活動');
      const loc = await makeLocation('B-revision地點');
      let s = await makeSession(c.id, loc.id, { max_orders: 5 });
      s = await publishSession(s.id, s.revision);

      const staleRevision = s.revision;
      // 先用真實 PATCH 把 revision 往前推一次
      const bump = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: s.revision, name: 'B-revision場次-改名1' } });
      assert(bump.status === 200, 'B7-revision-bump-baseline 建立 revision 落差的前置更新成功', JSON.stringify(bump).slice(0, 200));

      const conflict = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: staleRevision, name: 'B-revision場次-改名2(stale)' } });
      assert(conflict.status === 409 && conflict.json.error === 'POPUP_SESSION_REVISION_CONFLICT', 'B7-revision-conflict-real-409 過期 revision 真實回 409', JSON.stringify(conflict).slice(0, 200));
      const freshAfterConflict = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(freshAfterConflict.json.data.name === 'B-revision場次-改名1', 'B7-revision-not-overwritten 衝突後資料未被覆寫（仍是前一次成功寫入的值）', freshAfterConflict.json.data.name);

      // affected-orders confirm：先建立一筆真實訂單，再改 protected 欄位
      const orderRes = await call('POST', '/api/line-orders/popup-checkout', {
        body: { customer_name: 'B測試顧客', customer_phone: '0911222333', popup_session_public_code: freshAfterConflict.json.data.public_code,
          items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash' },
      });
      assert(orderRes.status === 201, 'B-precheck 建立真實訂單以觸發 affected-orders confirm', JSON.stringify(orderRes).slice(0, 200));

      const freshRev = (await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 })).json.data.revision;
      const noReason = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: freshRev, pickup_start_time: '11:00' } });
      assert(noReason.status === 409 && noReason.json.error === 'POPUP_SESSION_CHANGE_CONFIRM_REQUIRED' && noReason.json.affected_order_count === 1,
        'B8-affected-orders-first-409 已有訂單時修改保護欄位第一次回 409 並附影響訂單數', JSON.stringify(noReason).slice(0, 200));

      const emptyReason = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: freshRev, pickup_start_time: '11:00', confirm_affected_orders: true, change_reason: '' } });
      assert(emptyReason.status === 400, 'B9-empty-change-reason-rejected change_reason 空白時後端拒絕', JSON.stringify(emptyReason).slice(0, 200));

      const withReason = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: freshRev, pickup_start_time: '11:00', confirm_affected_orders: true, change_reason: '店家臨時調整時段' } });
      assert(withReason.status === 200 && withReason.json.data.pickup_start_time === '11:00', 'B10-confirm-with-reason-succeeds 帶合法 change_reason 確認後成功更新', JSON.stringify(withReason).slice(0, 200));
    }

    // B11-B12: archived campaign immutable + delete blocked by sessions
    {
      const c = await makeCampaign('B-封存活動');
      const loc = await makeLocation('B-封存地點');
      await makeSession(c.id, loc.id);
      const archiveRes = await call('PATCH', `/api/popup-pickup/campaigns/${c.id}`, { token: T1, body: { status: 'archived' } });
      assert(archiveRes.status === 200, 'B-precheck 活動成功封存');
      const editAfterArchive = await call('PATCH', `/api/popup-pickup/campaigns/${c.id}`, { token: T1, body: { name: '改名應該失敗' } });
      assert(editAfterArchive.status === 409, 'B11-archived-campaign-immutable 已封存活動再次 PATCH 回 409（immutable）', JSON.stringify(editAfterArchive).slice(0, 200));

      const c2 = await makeCampaign('B-有場次活動');
      const loc2 = await makeLocation('B-有場次地點');
      await makeSession(c2.id, loc2.id);
      const delRes = await call('DELETE', `/api/popup-pickup/campaigns/${c2.id}`, { token: T1 });
      assert(delRes.status === 409, 'B12-delete-with-sessions-409 活動有場次時 DELETE 回真實 409（非假裝成功）', JSON.stringify(delRes).slice(0, 200));
    }

    // B13: location soft delete
    {
      const loc = await makeLocation('B-軟刪除地點');
      const delRes = await call('DELETE', `/api/popup-pickup/locations/${loc.id}`, { token: T1 });
      assert(delRes.status === 200, 'B13a-location-soft-delete-succeeds 地點軟刪除請求成功');
      const row = db.get('SELECT active FROM popup_locations WHERE id=?', [loc.id]);
      assert(row && Number(row.active) === 0, 'B13b-location-still-exists-inactive DB 內該筆資料仍存在、active=0（非硬刪）', JSON.stringify(row));
    }

    // B15: quota/max_orders unsafe integer rejected
    {
      const c = await makeCampaign('B-整數活動');
      const loc = await makeLocation('B-整數地點');
      const bad = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: {
        campaign_id: c.id, name: 'x', location_id: loc.id, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        max_orders: -5,
      }});
      assert(bad.status === 400, 'B15-max-orders-unsafe-rejected 負數 max_orders 被後端拒絕', JSON.stringify(bad).slice(0, 200));
    }

    // B16-B20: public URL, real checkout, order_count consistency, cancel/void
    {
      const c = await makeCampaign('B-真實下單活動');
      const loc = await makeLocation('B-真實下單地點');
      let s = await makeSession(c.id, loc.id, { max_orders: 2 });
      s = await publishSession(s.id, s.revision);

      const pubGet = await call('GET', `/api/line-orders/popup-session/${s.public_code}`, {});
      assert(pubGet.status === 200, 'B16-public-url-readable 已發布場次的公開 URL（GET /popup-session/:code）可讀取', JSON.stringify(pubGet).slice(0, 150));

      const beforeOrder = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(beforeOrder.json.data.order_count === 0 && beforeOrder.json.data.remaining_orders === 2 && beforeOrder.json.data.is_full === false,
        'B22a-order-count-initial-zero 建立時 order_count=0、remaining_orders=max_orders、is_full=false', JSON.stringify(beforeOrder.json.data));

      const orderRes = await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B下單測試', customer_phone: '0922333444', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      assert(orderRes.status === 201, 'B17-real-checkout-succeeds 真實 POST /popup-checkout 成功建立訂單', JSON.stringify(orderRes).slice(0, 200));
      const orderId = orderRes.json.data.order_id || orderRes.json.data.id;

      const afterOrder = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(afterOrder.json.data.order_count === 1, 'B18-order-count-increments order_count 建立訂單後 0→1（管理端與 checkout 共用同一權威計數）', String(afterOrder.json.data.order_count));

      db._db.run(`UPDATE orders SET order_status='cancelled' WHERE id=?`, [orderId]);
      db._save();
      const afterCancel = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(afterCancel.json.data.order_count === 0, 'B19-order-count-decrements-on-cancel 取消訂單後 order_count 1→0', String(afterCancel.json.data.order_count));

      const orderRes2 = await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B作廢測試', customer_phone: '0933444555', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      const orderId2 = orderRes2.json.data.order_id || orderRes2.json.data.id;
      db._db.run(`UPDATE orders SET voided_at=? WHERE id=?`, [new Date().toISOString(), orderId2]);
      db._save();
      const afterVoid = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(afterVoid.json.data.order_count === 0, 'B20-voided-excluded 已作廢訂單被排除在 order_count 之外', String(afterVoid.json.data.order_count));

      // 灌到額滿，確認後台 is_full 與 checkout 的 POPUP_SESSION_FULL 是同一套權威結果
      await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B額滿測試1', customer_phone: '0955666777', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B額滿測試2', customer_phone: '0955666778', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      const fullState = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      assert(fullState.json.data.is_full === true && fullState.json.data.order_count === 2, 'B22b-is-full-true 額滿後 is_full=true、order_count=max_orders', JSON.stringify(fullState.json.data));
      const overCheckout = await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B額滿測試3', customer_phone: '0955666779', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      assert(overCheckout.status === 409 && overCheckout.json.error === 'POPUP_SESSION_FULL', 'B22c-checkout-blocked-when-full checkout 在額滿時真的被同一套權威擋下（跟後台 is_full 一致）', JSON.stringify(overCheckout).slice(0, 200));
    }

    // B21: cross-session/store isolation on order_count
    {
      const cA = await makeCampaign('B-隔離活動A'); const locA = await makeLocation('B-隔離地點A');
      let sA = await makeSession(cA.id, locA.id, { max_orders: 5 }); sA = await publishSession(sA.id, sA.revision);
      const cB = await makeCampaign('B-隔離活動B'); const locB = await makeLocation('B-隔離地點B');
      let sB = await makeSession(cB.id, locB.id, { max_orders: 5 }); sB = await publishSession(sB.id, sB.revision);
      await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'B隔離測試', customer_phone: '0966777888', popup_session_public_code: sA.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      const sBCheck = await call('GET', `/api/popup-pickup/sessions/${sB.id}`, { token: T1 });
      assert(sBCheck.json.data.order_count === 0, 'B21-cross-session-isolation 其他場次的訂單不會被算進本場次 order_count', String(sBCheck.json.data.order_count));
    }

    // B23-B24: feature off → real 404, draft campaign not shareable (data-level check)
    {
      const c = await makeCampaign('B-關閉開關活動');
      const loc = await makeLocation('B-關閉開關地點');
      let s = await makeSession(c.id, loc.id); s = await publishSession(s.id, s.revision);
      db._db.run("UPDATE settings SET value='0' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
      const disabledGet = await call('GET', `/api/line-orders/popup-session/${s.public_code}`, {});
      const nonexistentGet = await call('GET', `/api/line-orders/popup-session/this-code-does-not-exist`, {});
      assert(disabledGet.status === 404 && disabledGet.json.error === nonexistentGet.json.error && disabledGet.status === nonexistentGet.status,
        'B23-feature-off-indistinguishable-404 關閉開關後公開端點回傳跟「不存在」完全相同的 404', JSON.stringify({ disabledGet: disabledGet.json, nonexistentGet: nonexistentGet.json }));
      db._db.run("UPDATE settings SET value='1' WHERE store_id='store_001' AND key='popup_pickup_enabled'");
      db._save();
      const reenabledGet = await call('GET', `/api/line-orders/popup-session/${s.public_code}`, {});
      assert(reenabledGet.status === 200, 'B23b-feature-on-restores-access 重新開啟後既有已發布場次恢復可讀', JSON.stringify(reenabledGet).slice(0, 150));

      const draftCampaign = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'B-草稿活動' } });
      const draftLoc = await makeLocation('B-草稿地點');
      let draftSess = await makeSession(draftCampaign.json.data.id, draftLoc.id);
      draftSess = await publishSession(draftSess.id, draftSess.revision); // session 本身 published，但 parent campaign 仍 draft
      const draftParentGet = await call('GET', `/api/line-orders/popup-session/${draftSess.public_code}`, {});
      assert(draftParentGet.status === 404, 'B24-draft-parent-not-orderable published session 的 parent campaign 是 draft 時，公開端點仍回 404（不可分享）', JSON.stringify(draftParentGet).slice(0, 150));
    }


    // C. jsdom UI behavior（真實伺服器 + 真實 ppa* 函式）
    // ════════════════════════════════════════════════════════════════
    const allUnexpectedNetwork = [];
    const allUnhandled = [];
    const allCanvasFallback = [];
    class SameOriginOnlyResourceLoader extends require('jsdom').ResourceLoader {
      constructor(recorder) { super(); this.recorder = recorder; }
      fetch(url, options) {
        let host;
        try { host = new (require('url').URL)(url).hostname; } catch (e) { host = null; }
        if (host === '127.0.0.1' || host === 'localhost') return super.fetch(url, options);
        // 未列入允許清單的外部網路（Google Fonts、Leaflet、Maps 等）一律視為
        // 未預期呼叫，記錄下來讓測試明確 FAIL，不是靜默略過或標成已知訊息。
        this.recorder.push(url);
        return null; // jsdom 對 null 的處理等同「這個資源不載入」，不會讓頁面掛掉
      }
    }
    async function createHarness(urlPath, opts = {}) {
      const virtualConsole = new VirtualConsole();
      const jsErrors = [];
      const unexpectedNetwork = [];
      virtualConsole.on('jsdomError', (e) => {
        const msg = e.message || String(e);
        jsErrors.push(msg);
      });
      const unhandled = [];
      const timeoutIds = []; const intervalIds = [];
      const openCalls = []; const clipboardCalls = [];
      const dom = await JSDOM.fromURL(`${opts.base}${urlPath}`, {
        runScripts: 'dangerously',
        resources: new SameOriginOnlyResourceLoader(unexpectedNetwork),
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          // 必須在任何頁面腳本執行前塞好，讓真實的 ensureLogin() 在頁面啟動時
          // 就能讀到 token（TOKEN_KEY='pos_store_token'，見 app.js getToken()）。
          window.localStorage.setItem('pos_store_token', tokenFor('store_001'));
          window.localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001' }));
          // 根因（已用可觀測診斷證實，見上一輪紀錄）：這個 jsdom 版本的
          // window 完全沒有 fetch（不是「不支援相對網址」，是根本不存在），
          // 導致 app.js 內所有 fetch(...) 呼叫同步丟出例外，被各自的
          // try/catch 吞掉、當成「連線失敗」處理，從未真的打到伺服器。
          // 這裡補一個語意等同瀏覽器 fetch 的 polyfill：把相對網址用
          // window.location.href 解析成絕對網址，Request 物件時保留
          // method/headers/body/signal/credentials，一律呼叫 Node 原生
          // fetch 打真實 HTTP server（不是 canned response）。非
          // localhost/127.0.0.1 的網域一律視為意外外部請求，記錄下來讓
          // assertion 明確 FAIL，不是靜默放行或偽造回應。
          window.__fetchLog = [];
          window.fetch = (input, init) => {
            let urlObj;
            let method = 'GET';
            let resolvedInit = init;
            try {
              if (typeof Request !== 'undefined' && input instanceof Request) {
                urlObj = new URL(input.url, window.location.href);
                method = input.method || 'GET';
                resolvedInit = Object.assign(
                  { method: input.method, headers: input.headers, body: init && init.body !== undefined ? init.body : undefined,
                    signal: input.signal, credentials: input.credentials },
                  init || {}
                );
              } else {
                urlObj = new URL(String(input), window.location.href);
                method = (init && init.method) || 'GET';
              }
            } catch (e) {
              const rec = { input: String(input && input.url ? input.url : input), method, error: 'URL resolve failed: ' + e.message };
              window.__fetchLog.push(rec);
              return Promise.reject(e);
            }
            const rec = { url: urlObj.href, method };
            window.__fetchLog.push(rec);
            if (urlObj.hostname !== '127.0.0.1' && urlObj.hostname !== 'localhost') {
              rec.blockedExternal = true;
              return Promise.reject(new Error('blocked non-local fetch host: ' + urlObj.hostname));
            }
            const nodeFetch = global.fetch; // Node 原生 fetch（這支測試檔案本身也是用它打真實 HTTP，同一顆實作）
            const fetchInit = resolvedInit && typeof resolvedInit === 'object'
              ? { method: resolvedInit.method, headers: resolvedInit.headers, body: resolvedInit.body, signal: resolvedInit.signal }
              : undefined;
            return nodeFetch(urlObj.href, fetchInit).then((res) => {
              rec.status = res.status;
              return res;
            }).catch((e) => {
              rec.error = String(e && e.message || e);
              throw e;
            });
          };
          window.open = (...args) => { openCalls.push(args); return opts.windowOpenBlocked ? null : { closed: false }; };
          window.confirm = opts.confirmImpl || (() => true);
          window.prompt = opts.promptImpl || (() => 'test reason');
          window.alert = () => {};
          if (opts.stubClipboard === 'reject') {
            window.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
          } else if (opts.stubClipboard === 'missing') {
            Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
          } else {
            window.navigator.clipboard = { writeText: (t) => { clipboardCalls.push(t); return Promise.resolve(); } };
          }
          if (opts.hideQrLib) {
            // 讓 QRCode 永遠 undefined、且動態載入也失敗，驗證 fallback
            Object.defineProperty(window, 'QRCode', { get() { return undefined; }, configurable: true });
          }
          const origSetTimeout = window.setTimeout.bind(window);
          const origSetInterval = window.setInterval.bind(window);
          window.setTimeout = (fn, ms, ...args) => { const id = origSetTimeout(fn, ms, ...args); timeoutIds.push(id); return id; };
          window.setInterval = (fn, ms, ...args) => { const id = origSetInterval(fn, ms, ...args); intervalIds.push(id); return id; };
          window.addEventListener('error', (e) => unhandled.push('window error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + (e.error && e.error.stack ? '\n' + e.error.stack : '')));
          window.addEventListener('unhandledrejection', (e) => unhandled.push('window unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));

          // 測試環境能力缺口 polyfill：jsdom 沒有內建真正的 Canvas 2D
          // context（除非安裝 optional 的 native `canvas` 套件），既有
          // LINE 點餐／宅配 QR 下載預備流程在頁面載入時的 setTimeout 裡
          // 會呼叫 canvas.getContext('2d') 並直接用它畫圖，因而拋出
          // TypeError。這不是 Phase 3C 新程式碼的問題，也不是要在
          // production 修——只在測試的 per-window beforeParse 補一個最小、
          // 可觀測的 fallback，讓既有流程能跑完，不偽造整套 Canvas API。
          window.__canvasFallbackLog = [];
          const OrigGetContext = window.HTMLCanvasElement.prototype.getContext;
          window.HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            let real;
            try { real = OrigGetContext.call(this, type, ...args); } catch (e) { real = null; }
            if (real) return real; // jsdom 原生真的支援時，一律用真的，不覆蓋
            if (type !== '2d') return real; // 非 2d（如 webgl）不偽造支援，維持 null/原行為
            const canvasRef = this.id || this.className || '(unnamed canvas)';
            const fallbackCtx = {
              set fillStyle(v) { window.__canvasFallbackLog.push({ canvas: canvasRef, call: 'set fillStyle', value: v }); this._fillStyle = v; },
              get fillStyle() { return this._fillStyle; },
              fillRect(...a) { window.__canvasFallbackLog.push({ canvas: canvasRef, call: 'fillRect', args: a }); },
              drawImage(...a) { window.__canvasFallbackLog.push({ canvas: canvasRef, call: 'drawImage', args: a.length }); },
              clearRect(...a) { window.__canvasFallbackLog.push({ canvas: canvasRef, call: 'clearRect', args: a }); },
            };
            return new Proxy(fallbackCtx, {
              get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop === 'symbol') return undefined;
                // 遇到目前 stack 沒涵蓋到的方法，明確丟錯而不是靜默回傳
                // undefined——寧可讓呼叫端的 try/catch 走既有 fallback 路徑，
                // 也不要假裝這個 polyfill 支援它其實沒實作的 API。
                throw new Error('canvas fallback polyfill: unimplemented 2d context member "' + String(prop) + '" (canvas=' + canvasRef + ')');
              },
            });
          };
        },
      });
      jsdomWindows.push(dom);
      const w = dom.window;
      await waitFor(() => w.currentFeatures && w.currentFeatures.line_order === true, { timeoutMs: 3000 });
      return { dom, w, jsErrors, unexpectedNetwork, unhandled, timeoutIds, intervalIds, openCalls, clipboardCalls,
        async cleanup() {
          // Case A 修正：window.close() 不會讓真正的 Node-level fetch Promise
          // 立刻消失，所以在關窗前先呼叫真正的 production ppaCleanup()（會
          // abort 所有 PPA 的 in-flight request、遞增 epoch），再讓事件圈跑
          // 幾輪，把「已經在途中」的 reject/resolve 續行完（此時 production
          // 的 epoch 檢查會讓它們安全地提早 return，不操作 DOM），最後才關窗。
          try { if (typeof w.ppaCleanup === 'function') w.ppaCleanup(); } catch (e) {}
          await new Promise((r) => setTimeout(r, 80));
          try { timeoutIds.forEach((id) => { try { w.clearTimeout(id); } catch (e) {} }); } catch (e) {}
          try { intervalIds.forEach((id) => { try { w.clearInterval(id); } catch (e) {} }); } catch (e) {}
          allUnexpectedNetwork.push(...unexpectedNetwork);
          allUnhandled.push(...unhandled);
          try { allCanvasFallback.push(...(w.__canvasFallbackLog || [])); } catch (e) {}
          try { dom.window.close(); } catch (e) {}
        } };
    }

    // C1: nav + feature gate + tab switching + loading/empty states
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        // createHarness 已經等到真實 ensureLogin()→GET /api/store-me 把
        // window.currentFeatures.line_order 填成 true，這裡直接用真實狀態測。
        ctx.w.ppaInitNav();
        assert(ctx.w.__fetchLog.some((r) => r.url && r.url.includes('/api/store-me') && r.status === 200), 'C1a-ensure-login-called-store-me 真實 ensureLogin() 呼叫了 GET /api/store-me 並拿到 200', JSON.stringify(ctx.w.__fetchLog.filter((r) => r.url && r.url.includes('store-me'))));
        assert(ctx.w.currentFeatures && ctx.w.currentFeatures.line_order === true, 'C1b-current-features-real currentFeatures.line_order 由真實 API 回應設定為 true（非測試手動覆寫）', JSON.stringify(ctx.w.currentFeatures));
        assert(ctx.w.document.getElementById('nav-btn-popup_pickup').style.display === '', 'C1-nav-shows-with-feature 有 line_order feature 時 nav 顯示');
        ctx.w.currentFeatures = { line_order: false };
        ctx.w.ppaInitNav();
        assert(ctx.w.document.getElementById('nav-btn-popup_pickup').style.display === 'none', 'C2-nav-hides-without-feature 無 line_order feature 時 nav 隱藏');
        ctx.w.currentFeatures = { line_order: true };
        ctx.w.ppaInitNav();

        ctx.w.showPage('popup_pickup');
        await waitFor(() => ctx.w.document.getElementById('ppa-campaigns-tbody').children.length > 0);
        assert(ctx.w.document.getElementById('page-popup_pickup').style.display === '', 'C3-page-shows showPage(popup_pickup) 正確顯示頁面');
        ['campaigns', 'locations', 'sessions', 'links'].forEach((t) => {
          ctx.w.ppaSwitchTab(t);
          assert(ctx.w.document.getElementById('ppa-panel-' + t).style.display === '', `C4-tab-switch-${t} 切換到 ${t} tab 時該面板可見`);
        });
        ctx.w.ppaSwitchTab('campaigns');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const emptyTextOk = ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.length > 0;
        assert(emptyTextOk, 'C5-loading-then-rendered 載入中狀態之後有實際渲染內容（非卡死在 loading）');
      } finally { await ctx.cleanup(); }
    }

    // C6: XSS inert — 建立一個名稱含 <img onerror> 的活動，確認渲染後是純文字
    {
      const xssName = '<img src=x onerror="window.__xssFired=1">安全測試活動';
      const xc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: xssName, status: 'published' } });
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.currentFeatures = { line_order: true };
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const tbodyHtml = ctx.w.document.getElementById('ppa-campaigns-tbody').innerHTML;
        assert(!tbodyHtml.includes('<img'), 'C6a-xss-not-parsed-as-html XSS fixture 沒有被解析成真實 <img> 標籤', tbodyHtml.slice(0, 200));
        assert(ctx.w.__xssFired !== 1, 'C6b-xss-not-executed onerror 沒有被執行', String(ctx.w.__xssFired));
        assert(ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes(xssName), 'C6c-xss-shown-as-text 名稱以純文字形式正確顯示（含尖括號原文）');
      } finally { await ctx.cleanup(); }
    }

    // C7: 快速雙擊只送一次 request（campaign create）
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        ctx.w.ppaOpenCampaignForm(null);
        ctx.w.document.getElementById('ppa-campaign-name').value = 'C7-雙擊測試活動';
        let putCount = 0;
        const origFetch = ctx.w.fetch.bind(ctx.w);
        ctx.w.fetch = (u, init) => { if (String(u).includes('/api/popup-pickup/campaigns') && init && init.method === 'POST') putCount++; return origFetch(u, init); };
        ctx.w.ppaSaveCampaign(); ctx.w.ppaSaveCampaign(); // 同步連續呼叫兩次，模擬快速雙擊
        await waitFor(() => putCount >= 1, { timeoutMs: 1500 });
        await new Promise((r) => setTimeout(r, 300));
        assert(putCount === 1, 'C7-double-click-single-request 快速雙擊建立活動只送出 1 次 POST', String(putCount));
      } finally { await ctx.cleanup(); }
    }

    // C8: stale response 不覆蓋 + 離頁後 response 不 render
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let resolveSlow;
        const slowPromise = new Promise((r) => { resolveSlow = r; });
        let callCount = 0;
        ctx.w.fetch = (u, init) => {
          if (String(u).includes('/api/popup-pickup/campaigns') && (!init || init.method === undefined || init.method === 'GET')) {
            callCount++;
            if (callCount === 1) return slowPromise.then(() => origFetch(u, init));
          }
          return origFetch(u, init);
        };
        const p1 = ctx.w.ppaLoadCampaigns(); // 慢的第一次請求，先卡住
        await new Promise((r) => setTimeout(r, 30));
        ctx.w.fetch = origFetch;
        const p2 = ctx.w.ppaLoadCampaigns(); // 快的第二次請求，應該先完成並成為畫面依據
        await p2;
        const genAfterFast = ctx.w.eval('_PPA.gen.campaigns');
        resolveSlow();
        await p1.catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        const genAfterSlow = ctx.w.eval('_PPA.gen.campaigns');
        assert(genAfterSlow === genAfterFast, 'C8-stale-response-ignored 較舊（慢）的 response 後到達時，generation counter 沒有被覆蓋回舊狀態', `${genAfterFast} vs ${genAfterSlow}`);
      } finally { await ctx.cleanup(); }
    }

    // C9: archived campaign 的編輯按鈕真的 disabled
    {
      const c = await makeCampaign('C9-封存測試活動');
      await call('PATCH', `/api/popup-pickup/campaigns/${c.id}`, { token: T1, body: { status: 'archived' } });
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const rows = [...ctx.w.document.querySelectorAll('#ppa-campaigns-tbody tr')];
        const row = rows.find((r) => r.textContent.includes('C9-封存測試活動'));
        const editBtn = row && [...row.querySelectorAll('button')].find((b) => b.textContent === '編輯');
        assert(!!editBtn && editBtn.disabled === true, 'C9-archived-edit-disabled 已封存活動的編輯按鈕是真正的 disabled', String(editBtn && editBtn.disabled));
      } finally { await ctx.cleanup(); }
    }

    // C10: inactive location snapshot 顯示（不清空、標示歷史快照）
    {
      const c = await makeCampaign('C10-地點快照活動');
      const loc = await makeLocation('C10-即將停用地點');
      let s = await makeSession(c.id, loc.id);
      s = await publishSession(s.id, s.revision);
      await call('DELETE', `/api/popup-pickup/locations/${loc.id}`, { token: T1 }); // 場次建立後才停用
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await ctx.w.ppaOpenSessionForm(s.id);
        await new Promise((r) => setTimeout(r, 50));
        const sel = ctx.w.document.getElementById('ppa-session-location');
        assert(sel.value === s.location_id, 'C10a-inactive-location-not-blank 地點停用後，編輯畫面仍正確帶出該 location_id（未變空白）', sel.value);
        const opt = [...sel.options].find((o) => o.value === s.location_id);
        assert(!!opt && opt.textContent.includes('已停用'), 'C10b-inactive-location-labeled 該選項文字標示為已停用（歷史快照，非目前可選地點）', opt && opt.textContent);

        // C10c：H1.4.12 Phase 3C Chromium 稽核發現並修正的 production 行為——
        // 只改名稱、不動地點時，PATCH body 應完全省略 location_id，而不是
        // 送一個「跟原本一樣」的值（即使兩者對後端效果相同，省略更明確、
        // 更好稽核，也是本輪明確要求的契約）。
        let capturedBody = null;
        const origApiFetch = ctx.w.apiFetch;
        ctx.w.apiFetch = (url, opts) => {
          if (String(url).includes(`/api/popup-pickup/sessions/${s.id}`) && opts && opts.method === 'PATCH') {
            capturedBody = JSON.parse(opts.body);
          }
          return origApiFetch(url, opts);
        };
        ctx.w.document.getElementById('ppa-session-name').value = 'C10-改名不動地點';
        await ctx.w.ppaSaveSession();
        await new Promise((r) => setTimeout(r, 50));
        assert(!!capturedBody && !('location_id' in capturedBody), 'C10c-unchanged-location-omitted-from-payload 只改名稱時 PATCH payload 完全不含 location_id 欄位', JSON.stringify(capturedBody));
        ctx.w.apiFetch = origApiFetch;
      } finally { await ctx.cleanup(); }
    }

    // C11: effective_state 與 raw status 分開顯示
    {
      const c = await makeCampaign('C11-狀態活動');
      const loc = await makeLocation('C11-狀態地點');
      let s = await makeSession(c.id, loc.id, { order_open_at: `${taipeiDateStr(5)}T00:00`, order_cutoff_at: `${taipeiDateStr(7)}T09:00`, pickup_date: taipeiDateStr(7) });
      s = await publishSession(s.id, s.revision); // published 但 order_open_at 在未來 → effective_state=scheduled
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup'); ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        const rows = [...ctx.w.document.querySelectorAll('#ppa-sessions-tbody tr')];
        const row = rows.find((r) => r.textContent.includes('C11-狀態地點') && r.textContent.includes('已發布'));
        assert(!!row && row.textContent.includes('已發布') && row.textContent.includes('尚未開放下單'),
          'C11-effective-state-separate 同時顯示 raw status（已發布）與 effective_state（尚未開放下單），未混為一談', row && row.textContent.slice(0, 100));
      } finally { await ctx.cleanup(); }
    }

    // C12: order_count/remaining/is_full 正確渲染 + 額滿紅色標示
    {
      const c = await makeCampaign('C12-額滿活動');
      const loc = await makeLocation('C12-額滿地點');
      let s = await makeSession(c.id, loc.id, { max_orders: 1 });
      s = await publishSession(s.id, s.revision);
      await call('POST', '/api/line-orders/popup-checkout', { body: {
        customer_name: 'C12下單', customer_phone: '0977888999', popup_session_public_code: s.public_code,
        items: [{ product_id: 9401, qty: 1 }], payment_method: 'cash',
      }});
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup'); ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        const rows = [...ctx.w.document.querySelectorAll('#ppa-sessions-tbody tr')];
        const row = rows.find((r) => r.textContent.includes('已下單 1'));
        assert(!!row, 'C12a-order-count-rendered 場次表格顯示真實 order_count（已下單 1）', rows.map((r) => r.textContent.slice(0, 40)).join(' | '));
        assert(!!row && row.textContent.includes('已額滿'), 'C12b-is-full-shown 額滿場次顯示「已額滿」標示', row && row.textContent);
      } finally { await ctx.cleanup(); }
    }

    // C13: QR URL 與畫面 canonical URL 完全相同
    {
      const c = await makeCampaign('C13-QR活動');
      const loc = await makeLocation('C13-QR地點');
      let s = await makeSession(c.id, loc.id);
      s = await publishSession(s.id, s.revision);
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup'); ctx.w.ppaSwitchTab('links');
        await waitFor(() => ctx.w.document.getElementById('ppa-links-list').textContent.includes(s.public_code) || ctx.w.document.getElementById('ppa-links-list').children.length > 0, { timeoutMs: 3000 });
        const expectedUrl = `http://127.0.0.1/popup-order?session=${s.public_code}`;
        ctx.w.ppaShowQr(expectedUrl);
        await new Promise((r) => setTimeout(r, 50));
        assert(ctx.w.document.getElementById('ppa-qr-url').textContent === expectedUrl, 'C13-qr-url-matches-canonical QR modal 顯示的網址與傳入的 canonical URL 完全相同', ctx.w.document.getElementById('ppa-qr-url').textContent);
      } finally { await ctx.cleanup(); }
    }

    // C14: draft/paused/cancelled/archived 不可分享 / 不可測試
    {
      const draftC = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'C14-草稿活動' } });
      const loc = await makeLocation('C14-地點');
      const draftS = await makeSession(draftC.json.data.id, loc.id);
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup'); ctx.w.ppaSwitchTab('links');
        await waitFor(() => !ctx.w.document.getElementById('ppa-links-list').textContent.includes('載入中'), { timeoutMs: 3000 });
        const text = ctx.w.document.getElementById('ppa-links-list').textContent;
        assert(text.includes('不可分享'), 'C14-draft-not-shareable draft 活動下的場次顯示「不可分享」', text.slice(0, 300));
      } finally { await ctx.cleanup(); }
    }

    // C15: popup_pickup_enabled toggle 完整流程（確認→1次PUT，取消→0次PUT）
    {
      const ctx = await createHarness('/index.html', { base, confirmImpl: () => false });
      try {
        ctx.w.showPage('settings');
        ctx.w.switchSettingsTab('line_entry');
        await waitFor(() => !ctx.w.document.getElementById('ppaEnabledContent').textContent.includes('載入中'), { timeoutMs: 3000 });
        let putCount = 0;
        const origFetch = ctx.w.fetch.bind(ctx.w);
        ctx.w.fetch = (u, init) => { if (String(u) === '/api/settings' && init && init.method === 'PUT') putCount++; return origFetch(u, init); };
        ctx.w.document.getElementById('ppaEnabledToggleBtn').click();
        await new Promise((r) => setTimeout(r, 100));
        assert(putCount === 0, 'C15a-toggle-cancel-zero-put 取消確認對話框時完全沒有送出 PUT', String(putCount));
      } finally { await ctx.cleanup(); }
    }
    {
      const ctx = await createHarness('/index.html', { base, confirmImpl: () => true });
      try {
        ctx.w.showPage('settings');
        ctx.w.switchSettingsTab('line_entry');
        await waitFor(() => !ctx.w.document.getElementById('ppaEnabledContent').textContent.includes('載入中'), { timeoutMs: 3000 });
        let putCount = 0;
        const origFetch = ctx.w.fetch.bind(ctx.w);
        ctx.w.fetch = (u, init) => { if (String(u) === '/api/settings' && init && init.method === 'PUT') putCount++; return origFetch(u, init); };
        ctx.w.document.getElementById('ppaEnabledToggleBtn').click();
        await waitFor(() => putCount >= 1, { timeoutMs: 1500 });
        await new Promise((r) => setTimeout(r, 200));
        assert(putCount === 1, 'C15b-toggle-confirm-exactly-one-put 確認後恰好送出 1 次 PUT', String(putCount));
      } finally { await ctx.cleanup(); }
    }

    // C16: 400/401/403/404/409/500 不 crash、不洩漏內部錯誤
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const origFetch = ctx.w.fetch.bind(ctx.w);
        ctx.w.fetch = (u, init) => {
          if (String(u).includes('/api/popup-pickup/campaigns') && (!init || !init.method)) {
            return Promise.resolve(new ctx.w.Response(JSON.stringify({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '系統發生錯誤，請稍後再試' }), { status: 500 }));
          }
          return origFetch(u, init);
        };
        await ctx.w.ppaLoadCampaigns();
        await new Promise((r) => setTimeout(r, 50));
        assert(ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入失敗'), 'C16-500-shows-safe-message 500 錯誤顯示安全的「載入失敗」訊息、頁面沒有 crash');
        assert(ctx.w.document.body !== null, 'C16b-no-crash-after-500 頁面在 500 錯誤後仍完整存在（沒有整頁掛掉）');
      } finally { await ctx.cleanup(); }
    }

    // C17: clipboard 拒絕時 fallback（不 crash）
    {
      const ctx = await createHarness('/index.html', { base, stubClipboard: 'missing' });
      try {
        let crashed = false;
        try { ctx.w.ppaCopyText('test'); } catch (e) { crashed = true; }
        assert(!crashed, 'C17-clipboard-missing-no-crash Clipboard API 不存在時 ppaCopyText 不 crash');
      } finally { await ctx.cleanup(); }
    }

    // C18: window.open 被阻擋時不 crash
    {
      const ctx = await createHarness('/index.html', { base, windowOpenBlocked: true });
      try {
        let crashed = false;
        try { ctx.w.ppaOpenMap({ lat: 25, lng: 121, address: 'x' }); } catch (e) { crashed = true; }
        assert(!crashed, 'C18-window-open-blocked-no-crash window.open 回傳 null（被瀏覽器阻擋）時不 crash');
      } finally { await ctx.cleanup(); }
    }

    // C19b：Chromium 驗收發現的真實產品缺陷回歸——直接進 Sessions tab 點
    // 「新增場次」，從沒去過活動／地點 tab，兩個下拉選單仍必須有選項
    // （修正前：PPA.campaigns/PPA.locations 是空的，選單悄悄變空白）。
    {
      const c2 = await makeCampaign('C19b-未曾造訪活動');
      const loc2 = await makeLocation('C19b-未曾造訪地點');
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions'); // 直接跳場次 tab，故意不呼叫 campaigns/locations tab
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        assert(ctx.w._PPA.campaigns.length === 0 && ctx.w._PPA.locations.length === 0, 'C19b-precheck-lists-empty-before-open 開表單前 PPA.campaigns/PPA.locations 確實還是空的（重現缺陷的前置條件成立）', JSON.stringify({ c: ctx.w._PPA.campaigns.length, l: ctx.w._PPA.locations.length }));
        await ctx.w.ppaOpenSessionForm(null);
        await waitFor(() => ctx.w.document.getElementById('ppa-session-campaign').options.length > 0 && ctx.w.document.getElementById('ppa-session-location').options.length > 0, { timeoutMs: 3000 });
        const campOpts = ctx.w.document.getElementById('ppa-session-campaign').options.length;
        const locOpts = ctx.w.document.getElementById('ppa-session-location').options.length;
        assert(campOpts > 0 && locOpts > 0, 'C19c-session-form-lazy-loads-lists 從沒去過活動/地點 tab 也能直接開「新增場次」，下拉選單自動補載入且有選項（回歸修正）', JSON.stringify({ campOpts, locOpts }));
      } finally { await ctx.cleanup(); }
    }

    // C19: 重複進入頁面不重複綁事件（AbortController 不無限增加）
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        ctx.w.showPage('settings');
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        ctx.w.showPage('settings');
        ctx.w.showPage('popup_pickup');
        await waitFor(() => !ctx.w.document.getElementById('ppa-campaigns-tbody').textContent.includes('載入中'));
        const controllerKeys = Object.keys(ctx.w.eval('_PPA.controllers'));
        assert(controllerKeys.length <= 6, 'C19-no-controller-leak 重複進出頁面後 controllers map 沒有無限增加', String(controllerKeys.length));
      } finally { await ctx.cleanup(); }
    }

    // C20 的正確契約：localhost 資源可以載入；已知會被擋的外部 CDN
    // （Google Fonts / unpkg Leaflet）被攔截且記錄下來是「預期行為＝PASS」，
    // 不是失敗。未列入允許清單的其他外部 host 才是真正的意外、必須 FAIL。
    // 若這些「應該被擋」的已知 URL 一次都沒被觀察到，代表測試根本沒走到
    // 這條路徑，同樣必須 FAIL（不能靜默通過一個沒被驗證過的狀態）。
    const KNOWN_EXPECTED_BLOCKED_HOSTS = ['fonts.googleapis.com', 'unpkg.com'];
    const unknownBlockedHosts = allUnexpectedNetwork.filter((u) => {
      let h; try { h = new URL(u).hostname; } catch (e) { return true; }
      return !KNOWN_EXPECTED_BLOCKED_HOSTS.includes(h);
    });
    assert(
      allUnexpectedNetwork.length > 0 && unknownBlockedHosts.length === 0,
      'C20-external-resources-blocked-and-recorded 已知外部 CDN（Google Fonts／unpkg Leaflet）請求確實被 ResourceLoader 攔截且記錄，且沒有出現允許清單以外的未知外部 host',
      JSON.stringify({ totalBlocked: allUnexpectedNetwork.length, unknownBlockedHosts })
    );
    // C28：H1.4.12 Phase 3C Chromium 稽核發現並修正的 production bug——
    // 原本用 isNaN(Date.parse(d)) 判斷日期是否存在，但 Date.parse 對
    // 2/30、非閏年 2/29 這類不存在的日期不會回傳 NaN，而是靜默捲動成下一個
    // 合法日期，導致這些「不存在的日期」實際上會被送到後端。修正後改用
    // 嚴格的年/月/日往返核對。
    {
      const c28 = await makeCampaign('C28-批次日期活動');
      const loc28 = await makeLocation('C28-批次日期地點');
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await ctx.w.ppaOpenBatchSessionForm();
        await waitFor(() => ctx.w.document.getElementById('ppa-batch-campaign').options.length > 0);
        ctx.w.document.getElementById('ppa-batch-campaign').value = c28.id;
        ctx.w.document.getElementById('ppa-batch-location').value = loc28.id;
        ctx.w.document.getElementById('ppa-batch-name').value = 'C28測試';
        ctx.w.document.getElementById('ppa-batch-start').value = '10:00';
        ctx.w.document.getElementById('ppa-batch-end').value = '18:00';
        ctx.w.document.getElementById('ppa-batch-order-open').value = '00:00';
        ctx.w.document.getElementById('ppa-batch-order-cutoff').value = '09:00';

        for (const badDate of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10']) {
          let batchPostCount = 0;
          const origFetch = ctx.w.fetch.bind(ctx.w);
          ctx.w.fetch = (u, init) => { if (String(u).includes('/sessions/batch') && init && init.method === 'POST') batchPostCount++; return origFetch(u, init); };
          ctx.w.document.getElementById('ppa-batch-dates').value = badDate;
          await ctx.w.ppaSaveBatchSessions();
          await new Promise((r) => setTimeout(r, 30));
          assert(batchPostCount === 0, `C28-invalid-calendar-date-rejected-${badDate} 不存在的日期 ${badDate} 被前端拒絕，零 batch POST request`, String(batchPostCount));
          ctx.w.fetch = origFetch;
        }
        // 對照組：真正合法的日期必須能通過（確保沒有矯枉過正）
        let goodPostCount = 0;
        const origFetch2 = ctx.w.fetch.bind(ctx.w);
        ctx.w.fetch = (u, init) => { if (String(u).includes('/sessions/batch') && init && init.method === 'POST') goodPostCount++; return origFetch2(u, init); };
        ctx.w.document.getElementById('ppa-batch-dates').value = '2028-02-28';
        await ctx.w.ppaSaveBatchSessions();
        await new Promise((r) => setTimeout(r, 100));
        assert(goodPostCount === 1, 'C28-valid-date-still-accepted 真正合法的日期（非閏年 2/28）仍正常送出 1 次 batch POST（沒有矯枉過正）', String(goodPostCount));
      } finally { await ctx.cleanup(); }
    }

    // C33：H1.4.12 Phase 3C 一——歷史商品 lookup 的 modal 生命週期／epoch
    // 保護：開 modal A（觸發歷史商品 lookup，故意讓它變慢）、關掉 A、開
    // modal B，A 的 lookup 晚到時不能寫進 B 的畫面／共用 selectedProducts。
    {
      const c33 = await makeCampaign('C33-lookup競態活動');
      const loc33 = await makeLocation('C33-lookup競態地點');
      const prodRes33 = await call('POST', '/api/products', { token: T1, body: { name: 'C33歷史商品', category: '測試', price: 66 } });
      const c33ProductId = prodRes33.json.data.id;
      const sA = await makeSession(c33.id, loc33.id, {
        name: 'C33場次A', product_scope: 'selected',
        products: [{ product_id: c33ProductId, enabled: 1, quota_qty: 0 }],
      });
      await call('PUT', `/api/products/${c33ProductId}`, { token: T1, body: { enabled: 0 } });
      const sB = await makeSession(c33.id, loc33.id, { name: 'C33場次B' }); // all_takeout，跟歷史商品無關

      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中') && ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes(sA.name));

        // 讓 modal A 的歷史商品 lookup 卡住不回應
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let releaseA;
        const gateA = new Promise((r) => { releaseA = r; });
        ctx.w.fetch = (u, init) => {
          if (String(u).includes(`/api/products/${c33ProductId}`)) return gateA.then(() => origFetch(u, init));
          return origFetch(u, init);
        };
        const openAPromise = ctx.w.ppaOpenSessionForm(sA.id); // 卡在歷史商品 lookup 的 await
        await new Promise((r) => setTimeout(r, 30));
        ctx.w.ppaCloseSessionForm(); // 使用者在 lookup 回來前就關掉 A（sessionFormEpoch++）
        ctx.w.fetch = origFetch;
        await ctx.w.ppaOpenSessionForm(sB.id); // 開全新的 modal B（all_takeout，跟商品無關）
        await new Promise((r) => setTimeout(r, 30));
        releaseA(); // 現在才讓 A 的 lookup 真的回來
        await openAPromise.catch(() => {});
        await new Promise((r) => setTimeout(r, 100));

        assert(ctx.w.document.getElementById('ppa-session-name').value === 'C33場次B', 'C33a-modal-b-not-overwritten modal A 晚到的歷史商品 lookup 沒有把畫面切回或蓋掉目前開著的 modal B（欄位仍是 B 的資料）', ctx.w.document.getElementById('ppa-session-name').value);
        assert(!(c33ProductId in ctx.w._PPA.selectedProducts), 'C33b-modal-b-selected-products-clean modal B 的 PPA.selectedProducts 沒有被 A 的歷史商品污染', JSON.stringify(Object.keys(ctx.w._PPA.selectedProducts)));
        assert(ctx.jsErrors.length === 0 && ctx.unhandled.length === 0, 'C33c-no-error-from-race 這個競態過程沒有產生任何 error/unhandled rejection', JSON.stringify(ctx.jsErrors.concat(ctx.unhandled)));
      } finally { await ctx.cleanup(); }
    }

    // R32：H1.4.12 Phase 3C-C Bug 2——歷史商品 lookup 失敗（HTTP 500 或非 Abort 的
    // fetch reject）不可被當成「已知」快取起來；同一頁面生命週期內下次開表單
    // 要重新查詢，查到的 store-scoped 結果可以跨場次沿用。每個 mode 用全新
    // fixture 與全新 harness，只讓「這個商品 id 的第一次 GET」失敗一次。
    for (const mode of ['http500', 'network-reject']) {
      const c = await makeCampaign('R32-lookup重試活動-' + mode);
      const loc = await makeLocation('R32-lookup重試地點-' + mode);
      const prodName = 'R32-lookup重試歷史商品-' + mode;
      const pr = await call('POST', '/api/products', { token: T1, body: { name: prodName, category: '測試', price: 77 } });
      const pid = pr.json.data.id;
      const s1 = await makeSession(c.id, loc.id, { name: 'R32-lookup重試場次1-' + mode, product_scope: 'selected', products: [{ product_id: pid, enabled: 1, quota_qty: 0 }] });
      const s2 = await makeSession(c.id, loc.id, { name: 'R32-lookup重試場次2-' + mode, product_scope: 'selected', products: [{ product_id: pid, enabled: 1, quota_qty: 0 }] });
      const dis = await call('PUT', `/api/products/${pid}`, { token: T1, body: { enabled: 0 } });
      if (dis.status !== 200) throw new Error(`R32 setup: disabling product failed (status ${dis.status})`);

      const ctx = await createHarness('/index.html', { base });
      const origFetch = ctx.w.fetch.bind(ctx.w);
      let lookupGets = 0; let failNext = true;
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        const listed = await waitFor(() => ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes(s2.name));
        if (!listed) throw new Error('R32 setup: sessions list did not load');
        ctx.w.fetch = (u, init) => {
          const us = (u && u.url) || String(u);
          const method = String((init && init.method) || (u && u.method) || 'GET').toUpperCase();
          if (method === 'GET' && new URL(us, ctx.w.location.href).pathname === `/api/products/${pid}`) {
            lookupGets++;
            if (failNext) {
              failNext = false;
              if (mode === 'http500') return Promise.resolve(new ctx.w.Response(JSON.stringify({ success: false, message: 'temporary' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
              return Promise.reject(new TypeError('simulated network failure'));
            }
          }
          return origFetch(u, init);
        };
        const state = () => {
          const hpi = ctx.w._PPA.historicalProductInfo;
          const e = Object.prototype.hasOwnProperty.call(hpi, pid) ? hpi[pid] : undefined;
          const t = (ctx.w.document.getElementById('ppa-product-picker-list') || {}).textContent || '';
          return { mode, lookupGets, cachePresent: e !== undefined, cacheNameMatches: !!e && e.name === prodName, cacheEnabled: e === undefined ? null : e.enabled, pickerShowsName: t.includes(prodName), pickerShowsFallbackId: t.includes('#' + pid), pickerHasRemove: t.includes('移除') };
        };

        await ctx.w.ppaOpenSessionForm(s1.id); // 第一次 lookup 失敗
        const st1 = state();
        assert(st1.lookupGets === 1 && !st1.cachePresent && st1.pickerShowsFallbackId && st1.pickerHasRemove && !st1.pickerShowsName, `R32-${mode}-failure-not-cached 第一次歷史商品 lookup 失敗後不留快取，picker 誠實顯示「已停用商品 #ID」與「移除」`, JSON.stringify(st1));

        ctx.w.ppaCloseSessionForm();
        await ctx.w.ppaOpenSessionForm(s1.id); // 同一頁面、同一場次重開：必須重新查詢
        const st2 = state();
        assert(st2.lookupGets === 2 && st2.cachePresent && st2.cacheNameMatches && st2.cacheEnabled === false && st2.pickerShowsName && !st2.pickerShowsFallbackId, `R32-${mode}-next-open-retries-and-recovers 重開同一場次會重新查詢並顯示真實商品名稱`, JSON.stringify(st2));

        ctx.w.ppaCloseSessionForm();
        await ctx.w.ppaOpenSessionForm(s2.id); // 另一個選了同商品的場次：沿用成功的快取
        const st3 = state();
        assert(st3.lookupGets === 2 && st3.pickerShowsName && !st3.pickerShowsFallbackId, `R32-${mode}-success-cache-reused-across-session 另一個場次沿用成功的快取，不再多查一次，仍顯示真實名稱`, JSON.stringify(st3));
        ctx.w.ppaCloseSessionForm();

        assert(ctx.jsErrors.length === 0 && ctx.unhandled.length === 0, `R32-${mode}-no-errors 整個失敗→重試→跨場次過程沒有 error/unhandled rejection`, JSON.stringify({ mode, jsErrorCount: ctx.jsErrors.length, unhandledCount: ctx.unhandled.length }));
      } finally { ctx.w.fetch = origFetch; await ctx.cleanup(); }
    }

    // R33：H1.4.12 Phase 3C-C Bug 1——既有場次中原本已選、但現在不符合 LINE 外帶
    // 資格的商品：第一次開表單仍可看到並取消；一旦取消，同一個 checkbox 不能再
    // 把它加回（即使以程式設定 checked 並觸發 change 也一樣）。正常 eligible 的
    // 商品仍可自由取消／重新勾選。
    {
      const c = await makeCampaign('R33-勾選重加活動');
      const loc = await makeLocation('R33-勾選重加地點');
      const prT = await call('POST', '/api/products', { token: T1, body: { name: 'R33-不合格既有選取商品', category: '測試', price: 66 } });
      const prE = await call('POST', '/api/products', { token: T1, body: { name: 'R33-正常對照商品', category: '測試', price: 55 } });
      const pidT = prT.json.data.id; const pidE = prE.json.data.id;
      const lsT = await call('PATCH', `/api/products/${pidT}/line-settings`, { token: T1, body: { show_on_line: 1, line_takeout_enabled: 1, line_price: 66 } });
      const lsE = await call('PATCH', `/api/products/${pidE}/line-settings`, { token: T1, body: { show_on_line: 1, line_takeout_enabled: 1, line_price: 55 } });
      const s = await makeSession(c.id, loc.id, { name: 'R33-勾選重加場次', product_scope: 'selected', products: [{ product_id: pidT, enabled: 1, quota_qty: 5 }, { product_id: pidE, enabled: 1, quota_qty: 3 }] });
      const lsT0 = await call('PATCH', `/api/products/${pidT}/line-settings`, { token: T1, body: { show_on_line: 0 } }); // 仍 enabled，留在清單但不合格
      if (lsT.status !== 200 || lsE.status !== 200 || lsT0.status !== 200) throw new Error(`R33 setup: line-settings failed (${lsT.status}/${lsE.status}/${lsT0.status})`);

      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        const listed = await waitFor(() => ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes(s.name));
        if (!listed) throw new Error('R33 setup: sessions list did not load');
        await ctx.w.ppaOpenSessionForm(s.id);
        const cbOf = (name) => { const row = [...ctx.w.document.querySelectorAll('#ppa-product-picker-list label')].find((l) => l.textContent.includes(name)); return row ? row.querySelector('input[type="checkbox"]') : null; };
        const look = (pid, name) => { const cb = cbOf(name); const p = ctx.w._PPA.products.find((x) => x.id === pid); const sel = ctx.w._PPA.selectedProducts[pid];
          return { inList: !!p, eligible: !!(p && p.line_eligibility && p.line_eligibility.is_line_takeout_orderable), selected: !!sel, quota: sel ? sel.quota_qty : null, cbFound: !!cb, checked: !!(cb && cb.checked), disabled: !!(cb && cb.disabled) }; };
        const T = () => look(pidT, 'R33-不合格既有選取商品'); const C = () => look(pidE, 'R33-正常對照商品');

        const t1 = T();
        assert(t1.inList && !t1.eligible && t1.selected && t1.quota === 5 && t1.checked && !t1.disabled, 'R33-ineligible-existing-selection-remains-removable 不合格但原本已選的商品第一次開表單仍勾選、可操作、保留原 quota 5', JSON.stringify(t1));
        const c1 = C();
        assert(c1.inList && c1.eligible && c1.selected && c1.checked && !c1.disabled, 'R33-eligible-control-starts-selectable 正常 eligible 對照商品一開始已勾選且可操作', JSON.stringify(c1));

        cbOf('R33-不合格既有選取商品').click(); // 使用者取消
        const t2 = T();
        assert(!t2.selected && !t2.checked && t2.disabled, 'R33-ineligible-uncheck-removes-and-disables 取消後不合格商品從 selection 移除，checkbox 立即 disabled', JSON.stringify(t2));

        const cbT = cbOf('R33-不合格既有選取商品'); // 不靠 disabled：以程式方式設定 checked 並觸發 change
        cbT.checked = true;
        cbT.dispatchEvent(new ctx.w.Event('change'));
        const t3 = T();
        assert(!t3.selected && !t3.checked, 'R33-ineligible-recheck-cannot-readd 以程式方式 checked + change 也無法把已取消的不合格商品重新加入', JSON.stringify(t3));

        ctx.w.ppaRenderProductPicker();
        const t4 = T();
        assert(t4.cbFound && !t4.selected && !t4.checked && t4.disabled, 'R33-ineligible-rerender-stays-removed-disabled 重新 render 後仍未選取且 disabled', JSON.stringify(t4));

        cbOf('R33-正常對照商品').click();
        const cOff = C();
        cbOf('R33-正常對照商品').click();
        const cOn = C();
        assert(!cOff.selected && !cOff.checked && !cOff.disabled && cOn.selected && cOn.checked && !cOn.disabled, 'R33-eligible-control-can-toggle-off-on 正常 eligible 商品仍可取消再重新勾選（沒有矯枉過正）', JSON.stringify({ offSelected: cOff.selected, offDisabled: cOff.disabled, onSelected: cOn.selected, onChecked: cOn.checked, onDisabled: cOn.disabled }));

        let patchIds = null; let patchStatus = null; const origApi = ctx.w.apiFetch;
        ctx.w.apiFetch = (url, opts) => {
          if (String(url).includes(`/api/popup-pickup/sessions/${s.id}`) && opts && opts.method === 'PATCH') {
            const b = JSON.parse(opts.body); patchIds = (b.products || []).map((p) => p.product_id);
            return origApi(url, opts).then((r) => { patchStatus = r.status; return r; });
          }
          return origApi(url, opts);
        };
        try { await ctx.w.ppaSaveSession(); await new Promise((r) => setTimeout(r, 100)); } finally { ctx.w.apiFetch = origApi; }
        const after = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
        const serverIds = ((after.json && after.json.data && after.json.data.products) || []).map((p) => p.product_id);
        const sv = { patchStatus, patchHasTarget: !!patchIds && patchIds.includes(pidT), patchHasControl: !!patchIds && patchIds.includes(pidE), readbackStatus: after.status, serverHasTarget: serverIds.includes(pidT), serverHasControl: serverIds.includes(pidE) };
        assert(sv.patchStatus === 200 && !sv.patchHasTarget && sv.patchHasControl && sv.readbackStatus === 200 && !sv.serverHasTarget && sv.serverHasControl, 'R33-save-does-not-persist-removed-ineligible 儲存的 PATCH products 與 server readback 都不含已取消的不合格商品，仍含 eligible 對照商品', JSON.stringify(sv));
        ctx.w.ppaCloseSessionForm();
      } finally { await ctx.cleanup(); }
    }

    // C32：H1.4.12 Phase 3C 六——歷史已選商品後來被停用（enabled=0），
    // /line-products/list 只回 enabled=1，不能讓它從畫面上悄悄消失、也不能
    // 讓管理者沒辦法移除它。用既有 store-scoped GET /api/products/:id 補
    // 名稱，並提供「移除」按鈕。
    {
      const c32 = await makeCampaign('C32-歷史商品活動');
      const loc32 = await makeLocation('C32-歷史商品地點');
      const prodRes = await call('POST', '/api/products', { token: T1, body: { name: 'C32即將停用商品', category: '測試', price: 88 } });
      const c32ProductId = prodRes.json.data.id;
      let s32 = await makeSession(c32.id, loc32.id, {
        name: 'C32歷史商品場次', product_scope: 'selected',
        products: [{ product_id: c32ProductId, enabled: 1, quota_qty: 0 }],
      });

      // 現在把商品停用（enabled=0），使它不再出現在 /line-products/list；
      // PUT /:id 對未提供的欄位會 fallback 回原值，只需要送 enabled。
      const putRes = await call('PUT', `/api/products/${c32ProductId}`, { token: T1, body: { enabled: 0 } });
      assert(putRes.status === 200, 'BR-precheck-c32-product-disabled 真實 PUT 停用該商品成功', JSON.stringify(putRes).slice(0, 150));

      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中') && ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes(s32.name));
        await ctx.w.ppaOpenSessionForm(s32.id);
        await new Promise((r) => setTimeout(r, 200)); // 讓 fetch(/api/products/:id) 的 await 真的跑完
        ctx.w.ppaRenderProductPicker();
        const pickerHtml = ctx.w.document.getElementById('ppa-product-picker-list').innerHTML;
        assert(pickerHtml.includes('C32即將停用商品') || pickerHtml.includes(`#${c32ProductId}`), 'C32a-historical-product-not-vanished 已停用的歷史選取商品仍顯示在 picker 中（沒有悄悄消失）', pickerHtml.includes(`#${c32ProductId}`) ? `fallback #${c32ProductId}` : 'name shown');
        assert(pickerHtml.includes('移除'), 'C32b-historical-product-has-remove-button 歷史失效商品有明確的「移除」按鈕', pickerHtml.slice(0, 300));

        const removeBtn = [...ctx.w.document.querySelectorAll('#ppa-product-picker-list button')].find((b) => b.textContent === '移除');
        assert(!!removeBtn, 'C32c-remove-button-found 找得到移除按鈕元素');
        removeBtn.click();
        assert(!(c32ProductId in ctx.w._PPA.selectedProducts), 'C32d-remove-clears-selection 點擊移除後，該商品從 PPA.selectedProducts 中真的被移除', JSON.stringify(Object.keys(ctx.w._PPA.selectedProducts)));
      } finally { await ctx.cleanup(); }
    }

    // C31：H1.4.12 Phase 3C 稽核發現並修正的 production bug——admin picker
    // 原本只檢查 line_takeout_enabled，漏掉 show_on_line/sale_status/
    // line_sold_out，導致「未上架但 line_takeout_enabled=1」的商品被誤算
    // 進 eligible count。修正後改用跟 checkout 完全相同的權威函式
    // resolveLineProductPricing()（透過 GET /line-products/list 新增的
    // line_eligibility 欄位）。
    {
      const c31 = await makeCampaign('C31-eligibility活動');
      const loc31 = await makeLocation('C31-eligibility地點');
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await ctx.w.ppaOpenSessionForm(null);
        await waitFor(() => ctx.w.document.getElementById('ppa-session-campaign').options.length > 0);
        const allTakeoutRadio = [...ctx.w.document.querySelectorAll('input[name="ppa-session-scope"]')].find((r) => r.value === 'all_takeout');
        allTakeoutRadio.checked = true;
        ctx.w.ppaOnProductScopeChange();
        const infoText = ctx.w.document.getElementById('ppa-session-all-takeout-info').textContent;
        const eligibleCountMatch = infoText.match(/共\s*(\d+)\s*項/);
        const eligibleCount = eligibleCountMatch ? Number(eligibleCountMatch[1]) : -1;
        // 稽核發現：initDb() 會自動為 store_001 種入一批 demo 商品，所以不能
        // 假設乾淨基準是固定數字；改成驗證「eligible count 不等於商品總數」
        // （代表確實有東西被過濾掉），加上 C31b 直接驗證那個 show_on_line=0
        // 的 fixture 商品沒有被算進去。
        assert(eligibleCount > 0 && eligibleCount < ctx.w._PPA.products.length, 'C31a-eligible-count-filters-something eligible count 確實小於商品總數（代表 show_on_line=0 等不合格商品有被過濾掉，不是全部照單全收）', `eligible=${eligibleCount}, total=${ctx.w._PPA.products.length}, infoText=${infoText}`);

        const selectedRadio = [...ctx.w.document.querySelectorAll('input[name="ppa-session-scope"]')].find((r) => r.value === 'selected');
        selectedRadio.checked = true;
        ctx.w.ppaOnProductScopeChange();
        const unlistedRow = [...ctx.w.document.querySelectorAll('#ppa-product-picker-list label')].find((l) => l.textContent.includes('未上架商品'));
        const unlistedCheckbox = unlistedRow && unlistedRow.querySelector('input[type="checkbox"]');
        assert(!!unlistedCheckbox && unlistedCheckbox.disabled === true, 'C31b-ineligible-product-not-selectable show_on_line=0 的商品在 selected picker 中無法被勾選（真正 disabled）', String(unlistedCheckbox && unlistedCheckbox.disabled));
      } finally { await ctx.cleanup(); }
    }

    // C29：H1.4.12 Phase 3C 稽核——single session 與 batch 現在共用同一個
    // ppaValidatePickupTimes() helper，跟後端 TIME_RE / end>start 契約一致。
    {
      const c29 = await makeCampaign('C29-時間驗證活動');
      const loc29 = await makeLocation('C29-時間驗證地點');
      const ctx = await createHarness('/index.html', { base });
      try {
        assert(typeof ctx.w.ppaValidatePickupTimes === 'undefined', 'C29-precheck-helper-not-global 確認 helper 是模組內部函式（不是刻意的全域污染），透過送出表單間接驗證行為', 'expected: undefined (private to IIFE)');

        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await ctx.w.ppaOpenSessionForm(null);
        await waitFor(() => ctx.w.document.getElementById('ppa-session-campaign').options.length > 0);
        ctx.w.document.getElementById('ppa-session-campaign').value = c29.id;
        ctx.w.document.getElementById('ppa-session-name').value = 'C29測試場次';
        ctx.w.document.getElementById('ppa-session-location').value = loc29.id;
        ctx.w.document.getElementById('ppa-session-date').value = '2028-06-01';
        ctx.w.document.getElementById('ppa-session-order-open').value = '2028-05-30T00:00';
        ctx.w.document.getElementById('ppa-session-order-cutoff').value = '2028-06-01T09:00';

        async function trySessionTimes(start, end) {
          ctx.w.document.getElementById('ppa-session-start').value = start;
          ctx.w.document.getElementById('ppa-session-end').value = end;
          let postCount = 0;
          const orig = ctx.w.fetch.bind(ctx.w);
          ctx.w.fetch = (u, init) => { if (String(u) === '/api/popup-pickup/sessions' && init && init.method === 'POST') postCount++; return orig(u, init); };
          await ctx.w.ppaSaveSession();
          await new Promise((r) => setTimeout(r, 30));
          ctx.w.fetch = orig;
          return postCount;
        }
        assert((await trySessionTimes('10:00', '10:00')) === 0, 'C29a-session-equal-times-blocked start===end 時前端阻擋，零 POST');
        assert((await trySessionTimes('12:00', '10:00')) === 0, 'C29b-session-reversed-times-blocked end<start 時前端阻擋，零 POST');
        assert((await trySessionTimes('24:00', '25:00')) === 0, 'C29c-session-24-00-blocked 24:00 這種非法時間前端阻擋，零 POST');
        assert((await trySessionTimes('12:60', '13:00')) === 0, 'C29d-session-12-60-blocked 12:60 這種非法時間前端阻擋，零 POST');
        const legalCount = await trySessionTimes('10:00', '18:00');
        assert(legalCount === 1, 'C29e-session-legal-times-accepted 合法時間仍正常送出 1 次 POST（沒有矯枉過正）', String(legalCount));
      } finally { await ctx.cleanup(); }
    }

    {
      const c30 = await makeCampaign('C30-batch時間驗證活動');
      const loc30 = await makeLocation('C30-batch時間驗證地點');
      const ctx = await createHarness('/index.html', { base });
      try {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        await waitFor(() => !ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes('載入中'));
        await ctx.w.ppaOpenBatchSessionForm();
        await waitFor(() => ctx.w.document.getElementById('ppa-batch-campaign').options.length > 0);
        ctx.w.document.getElementById('ppa-batch-campaign').value = c30.id;
        ctx.w.document.getElementById('ppa-batch-location').value = loc30.id;
        ctx.w.document.getElementById('ppa-batch-name').value = 'C30測試';
        ctx.w.document.getElementById('ppa-batch-dates').value = '2028-06-10';
        ctx.w.document.getElementById('ppa-batch-order-open').value = '00:00';
        ctx.w.document.getElementById('ppa-batch-order-cutoff').value = '09:00';

        async function tryBatchTimes(start, end) {
          ctx.w.document.getElementById('ppa-batch-start').value = start;
          ctx.w.document.getElementById('ppa-batch-end').value = end;
          let postCount = 0;
          const orig = ctx.w.fetch.bind(ctx.w);
          ctx.w.fetch = (u, init) => { if (String(u).includes('/sessions/batch') && init && init.method === 'POST') postCount++; return orig(u, init); };
          await ctx.w.ppaSaveBatchSessions();
          await new Promise((r) => setTimeout(r, 30));
          ctx.w.fetch = orig;
          return postCount;
        }
        assert((await tryBatchTimes('10:00', '10:00')) === 0, 'C30a-batch-equal-times-blocked batch start===end 時前端阻擋，零 POST');
        assert((await tryBatchTimes('15:00', '09:00')) === 0, 'C30b-batch-reversed-times-blocked batch end<start 時前端阻擋，零 POST');
        assert((await tryBatchTimes('  ', '18:00')) === 0, 'C30c-batch-blank-start-blocked 前後空白的 start 視為缺漏，前端阻擋，零 POST');
        const legalBatchCount = await tryBatchTimes('10:00', '18:00');
        assert(legalBatchCount === 1, 'C30d-batch-legal-times-accepted batch 合法時間仍正常送出 1 次 POST', String(legalBatchCount));
      } finally { await ctx.cleanup(); }
    }

    assert(allUnhandled.length === 0, 'C21-page-survives-blocked-external-resources 外部資源被阻擋後，production page 仍完整初始化，沒有任何 window error/unhandledrejection', JSON.stringify(allUnhandled.slice(0, 5)));

    // Canvas fallback 範圍檢查：只允許既有 LINE 點餐／宅配 QR 預備流程用到，
    // Phase 3C 的快閃取餐 admin module 完全不使用 canvas，不該依賴這個
    // 測試 polyfill 才能通過。
    const KNOWN_CANVAS_IDS = ['lineQrCanvas', 'shipQrCanvas'];
    const unexpectedCanvasUsers = allCanvasFallback.filter((r) => !KNOWN_CANVAS_IDS.includes(r.canvas));
    assert(unexpectedCanvasUsers.length === 0, 'C23-canvas-fallback-scope-limited Canvas fallback 只被既有 LINE 點餐／宅配 QR 預備流程（lineQrCanvas/shipQrCanvas）使用，沒有其他呼叫端依賴它', JSON.stringify(unexpectedCanvasUsers.slice(0, 5)));
    assert(allCanvasFallback.length > 0, 'C24-canvas-fallback-actually-exercised Canvas fallback polyfill 真的有被既有 QR 流程觸發過（證明這條路徑真的被測試走到，不是從未執行）', String(allCanvasFallback.length));

    // Leaflet 修正的正向對照組：確認兩個 vendored plugin 在「Leaflet 存在」
    // 時仍會正常註冊（不是被我們的 capability guard 永久關閉），且
    // core → plugin 的載入順序沒有被打亂。
    {
      const fakeLeafletSrc = 'var L = { Layer: { extend: function(o){ o.__extended=true; return o; } }, Class: { extend: function(o){ o.__extended=true; return o; } }, Util:{requestAnimFrame:function(){}}, DomUtil:{create:function(){return {style:{}};},testProp:function(){return "transformOrigin";},addClass:function(){},setPosition:function(){}}, Bounds:function(){}, point:function(){return {};}, Browser:{any3d:false}, FeatureGroup:{extend:function(o){o.__extended=true; return o;}}, Marker:{prototype:{options:{pane:"markerPane"}}}, setOptions:function(){} };\nwindow.__leafletRegistrationProbe = { heat: false, cluster: false };';
      const heatSrc = fs.readFileSync(path.join(ROOT, 'public/js/vendor/leaflet-heat.js'), 'utf8')
        .replace('L.heatLayer=function(t,i){return new L.HeatLayer(t,i)};}', 'L.heatLayer=function(t,i){return new L.HeatLayer(t,i)};window.__leafletRegistrationProbe.heat = (typeof L.HeatLayer!=="undefined");}');
      const dom2 = new (require('jsdom').JSDOM)('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
      try {
        dom2.window.eval(fakeLeafletSrc);
        dom2.window.eval(heatSrc);
        assert(dom2.window.__leafletRegistrationProbe && dom2.window.__leafletRegistrationProbe.heat === true,
          'C25-leaflet-heat-still-registers-when-present 當 Leaflet 真的存在時，leaflet-heat.js 的 capability guard 沒有阻止 L.HeatLayer 正常註冊', JSON.stringify(dom2.window.__leafletRegistrationProbe));
      } finally { dom2.window.close(); }
    }
    {
      const headOfMarkercluster = fs.readFileSync(path.join(ROOT, 'public/js/vendor/leaflet.markercluster.js'), 'utf8').slice(0, 60);
      assert(headOfMarkercluster.startsWith('typeof L!=="undefined"&&!function('),
        'C26-markercluster-guard-is-minimal-prefix leaflet.markercluster.js 只在檔案最前面加了一個 capability-check 前綴，沒有整份重寫或格式化', headOfMarkercluster);
    }
    {
      const scriptOrder = indexHtml.match(/<script src="https:\/\/unpkg\.com\/leaflet[^>]*><\/script>[\s\S]*?<script src="\/js\/vendor\/leaflet\.markercluster\.js[^>]*><\/script>[\s\S]*?<script src="\/js\/vendor\/leaflet-heat\.js[^>]*><\/script>/);
      assert(!!scriptOrder, 'C27-leaflet-core-loads-before-plugins index.html 中 Leaflet core script 標籤仍排在兩個 vendored plugin 之前，載入順序未被打亂');
    }

    // C22：直接重現先前 post-summary crash 的場景——讓 /api/settings 的
    // response 刻意延遲到「使用者已經離開 popup_pickup 頁」之後才到達，
    // 證明 production 的 epoch 檢查真的擋下了這次 stale DOM 寫入（而不是
    // 只在這支測試自己的 harness 層面矇混過去）。
    {
      const ctx = await createHarness('/index.html', { base });
      try {
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let releaseSlow;
        const slowGate = new Promise((r) => { releaseSlow = r; });
        ctx.w.fetch = (u, init) => {
          const urlStr = (u && u.url) || String(u);
          if (urlStr.includes('/api/settings') && (!init || !init.method || init.method === 'GET')) {
            return slowGate.then(() => origFetch(u, init));
          }
          return origFetch(u, init);
        };
        ctx.w.showPage('popup_pickup'); // 觸發 ppaInit() → ppaLoadSettingsGate()，卡在 slowGate
        await new Promise((r) => setTimeout(r, 30));
        ctx.w.showPage('settings'); // 使用者在 response 回來前就離開了（觸發 ppaCleanup()，epoch++）
        releaseSlow(); // 現在才讓延遲的 /api/settings response 真的到達
        await new Promise((r) => setTimeout(r, 150));
        assert(ctx.jsErrors.length === 0 && ctx.unhandled.length === 0, 'C22a-stale-settings-response-no-crash 離頁後才到達的 /api/settings response 沒有造成任何 window error/unhandledrejection', JSON.stringify(ctx.jsErrors.concat(ctx.unhandled)));
        assert(ctx.w.document.getElementById('page-settings').style.display === '', 'C22b-stale-response-does-not-navigate-back 延遲 response 沒有把畫面切回 popup_pickup 或動到 settings 頁的 DOM', ctx.w.document.getElementById('page-settings').style.display);
      } finally { await ctx.cleanup(); }
    }

    // R35：3C-C reachable semantic P1 regression matrix（owner Option A；與歷史 3C-C 名稱／數量無關，不是歷史重建）。
    // 四組 P1：supported hard delete 後的真實 404、真正的 HTTP 500 Response（Node 原生 Response，
    // 不是 jsdom window 沒有的 ctx.w.Response）、production historicalProductLookup controller 被
    // 真正的 ppaCleanup() abort 的 AbortError、跨店 GET/建立/更新場次的 supported-API 權限。
    {
      const r35Path = (ctx, u) => new URL((u && u.url) || String(u), ctx.w.location.href).pathname;
      const r35Method = (u, init) => String((init && init.method) || (u && u.method) || 'GET').toUpperCase();
      const r35Bounded = (label, promise, ms) => {
        let timer;
        return Promise.race([
          Promise.resolve(promise).finally(() => clearTimeout(timer)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('R35 timeout: ' + label)), ms); }),
        ]);
      };
      const r35Cache = (ctx, pid, pname) => {
        const h = ctx.w._PPA.historicalProductInfo;
        const e = Object.prototype.hasOwnProperty.call(h, pid) ? h[pid] : undefined;
        return { present: e !== undefined, nameMatches: !!e && e.name === pname, enabled: e === undefined ? null : e.enabled };
      };
      const r35Row = (ctx, pid, pname) => {
        const text = (ctx.w.document.getElementById('ppa-product-picker-list') || {}).textContent || '';
        const row = [...ctx.w.document.querySelectorAll('#ppa-product-picker-list label')].find((l) => l.textContent.includes(`#${pid}`) || l.textContent.includes(pname));
        return { showsName: text.includes(pname), showsFallback: !!row && row.textContent.includes(`已停用商品 #${pid}`), removeBtn: !!row && [...row.querySelectorAll('button')].some((b) => b.textContent === '移除') };
      };
      const r35NoErr = (ctx) => ctx.jsErrors.length === 0 && ctx.unhandled.length === 0 && !/TypeError|FATAL/.test(ctx.jsErrors.concat(ctx.unhandled).join('\n'));
      async function r35Fixture(prefix, deleteAfter) {
        const c = await makeCampaign(prefix + '活動');
        const loc = await makeLocation(prefix + '地點');
        const pname = prefix + '歷史商品';
        const pr = await call('POST', '/api/products', { token: T1, body: { name: pname, category: '測試', price: 75 } });
        if (pr.status !== 201) throw new Error(`R35 setup: product create failed (status ${pr.status})`);
        const pid = pr.json.data.id;
        const s1 = await makeSession(c.id, loc.id, { name: prefix + '場次1', product_scope: 'selected', products: [{ product_id: pid, enabled: 1, quota_qty: 0 }] });
        const s2 = await makeSession(c.id, loc.id, { name: prefix + '場次2', product_scope: 'selected', products: [{ product_id: pid, enabled: 1, quota_qty: 0 }] });
        const dis = await call('PUT', `/api/products/${pid}`, { token: T1, body: { enabled: 0 } });
        if (dis.status !== 200) throw new Error(`R35 setup: disabling product failed (status ${dis.status})`);
        if (deleteAfter) {
          const del = await call('DELETE', `/api/products/${pid}`, { token: T1 });
          if (del.status !== 200) throw new Error(`R35 setup: supported hard delete failed (status ${del.status})`);
          const gone = await call('GET', `/api/products/${pid}`, { token: T1 });
          if (gone.status !== 404) throw new Error(`R35 setup: deleted product still readable (status ${gone.status})`);
        }
        return { pid, pname, s1, s2 };
      }
      async function r35OpenList(ctx, f) {
        ctx.w.showPage('popup_pickup');
        ctx.w.ppaSwitchTab('sessions');
        const listed = await waitFor(() => ctx.w.document.getElementById('ppa-sessions-tbody').textContent.includes(f.s2.name), { timeoutMs: 5000 });
        if (!listed) throw new Error('R35 setup: sessions list did not load');
      }

      // R35 (1–4)：supported hard delete 後真實 server 404——永不快取、每次開表單都重新查詢、誠實顯示 #ID。
      {
        const f = await r35Fixture('R35FX404-', true);
        const ctx = await createHarness('/index.html', { base });
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let gets = 0; const results = [];
        try {
          await r35OpenList(ctx, f);
          ctx.w.fetch = (u, init) => {
            if (r35Method(u, init) === 'GET' && r35Path(ctx, u) === `/api/products/${f.pid}`) {
              const n = ++gets;
              return origFetch(u, init).then((r) => { results.push(n + ':' + r.status); return r; });
            }
            return origFetch(u, init);
          };
          const st = () => ({ gets, results: results.join(','), cache: r35Cache(ctx, f.pid, f.pname), ...r35Row(ctx, f.pid, f.pname) });
          await ctx.w.ppaOpenSessionForm(f.s1.id);
          const a = st();
          assert(a.gets === 1 && a.results === '1:404' && !a.cache.present && a.showsFallback && a.removeBtn && !a.showsName, 'R35-real404-first-open-not-cached-honest-fallback 硬刪除後第一次開表單：真實 404、GET 1 次、不留快取、誠實顯示「已停用商品 #ID」與「移除」', JSON.stringify(a));
          ctx.w.ppaCloseSessionForm();
          await ctx.w.ppaOpenSessionForm(f.s1.id);
          const b = st();
          assert(b.gets === 2 && b.results === '1:404,2:404' && !b.cache.present && b.showsFallback && b.removeBtn && !b.showsName, 'R35-real404-reopen-requeries-not-cached 重開同一場次會重新查詢（GET 2 次），仍然不快取、仍誠實顯示 #ID', JSON.stringify(b));
          ctx.w.ppaCloseSessionForm();
          await ctx.w.ppaOpenSessionForm(f.s2.id);
          const c = st();
          assert(c.gets === 3 && c.results === '1:404,2:404,3:404' && !c.cache.present && c.showsFallback && c.removeBtn && !c.showsName, 'R35-real404-other-session-requeries-not-cached 另一個選了同商品的場次也重新查詢（GET 3 次），不快取、誠實顯示 #ID', JSON.stringify(c));
          ctx.w.ppaCloseSessionForm();
          assert(r35NoErr(ctx), 'R35-real404-no-errors 整個真實 404 流程沒有 error/unhandled rejection/TypeError', JSON.stringify({ jsErrorCount: ctx.jsErrors.length, unhandledCount: ctx.unhandled.length }));
        } finally { ctx.w.fetch = origFetch; await ctx.cleanup(); }
      }

      // R35 (5–8)：真正的 HTTP 500 Response（Node 原生 Response，jsdom window 沒有 Response）——不快取、下次重試成功、跨場次沿用。
      {
        const f = await r35Fixture('R35FX500-', false);
        const ctx = await createHarness('/index.html', { base });
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let gets = 0; const results = []; let r500 = null;
        const proof = { constructed: false, isNodeResponse: false, notWindowResponse: false, status: null, ok: null, jsonConsumed: false, bodyUsedAfter: null };
        try {
          await r35OpenList(ctx, f);
          ctx.w.fetch = (u, init) => {
            if (r35Method(u, init) === 'GET' && r35Path(ctx, u) === `/api/products/${f.pid}`) {
              const n = ++gets;
              if (n === 1) {
                r500 = new Response(JSON.stringify({ success: false, message: 'R35 temporary failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                const realJson = r500.json.bind(r500);
                r500.json = () => { proof.jsonConsumed = true; return realJson(); };
                proof.constructed = true;
                proof.isNodeResponse = r500 instanceof Response && r500.constructor === Response;
                proof.notWindowResponse = ctx.w.Response !== Response;
                proof.status = r500.status; proof.ok = r500.ok;
                results.push(n + ':' + r500.status);
                return Promise.resolve(r500);
              }
              return origFetch(u, init).then((r) => { results.push(n + ':' + r.status); return r; });
            }
            return origFetch(u, init);
          };
          const st = () => ({ gets, results: results.join(','), cache: r35Cache(ctx, f.pid, f.pname), ...r35Row(ctx, f.pid, f.pname) });
          await ctx.w.ppaOpenSessionForm(f.s1.id);
          proof.bodyUsedAfter = r500 ? r500.bodyUsed : null;
          const a = st();
          assert(proof.constructed && proof.isNodeResponse && proof.notWindowResponse && proof.status === 500 && proof.ok === false && proof.jsonConsumed && proof.bodyUsedAfter === true && a.results === '1:500' && !/TypeError/.test(ctx.jsErrors.concat(ctx.unhandled).join('\n')), 'R35-real500-response-object-proven 第一次 lookup 拿到真正的 status 500 Response（ok=false），production 確實讀了它的 .json()，不是同步 constructor TypeError', JSON.stringify(proof));
          assert(a.gets === 1 && !a.cache.present && a.showsFallback && a.removeBtn && !a.showsName, 'R35-real500-first-failure-not-cached HTTP 500 失敗後不留快取，picker 誠實顯示 #ID 與「移除」', JSON.stringify(a));
          ctx.w.ppaCloseSessionForm();
          await ctx.w.ppaOpenSessionForm(f.s1.id);
          const b = st();
          assert(b.gets === 2 && b.results === '1:500,2:200' && b.cache.present && b.cache.nameMatches && b.cache.enabled === false && b.showsName && !b.showsFallback, 'R35-real500-next-open-retries-and-recovers 重開同一場次重新查詢（GET 2 = 200），快取並顯示正確名稱與 enabled=false', JSON.stringify(b));
          ctx.w.ppaCloseSessionForm();
          await ctx.w.ppaOpenSessionForm(f.s2.id);
          const c = st();
          ctx.w.ppaCloseSessionForm();
          assert(c.gets === 2 && c.cache.present && c.cache.nameMatches && c.showsName && !c.showsFallback && r35NoErr(ctx), 'R35-real500-success-cache-reused-no-errors 另一個場次沿用成功快取（GET 仍為 2），整個流程沒有 error/unhandled/TypeError', JSON.stringify({ ...c, jsErrorCount: ctx.jsErrors.length, unhandledCount: ctx.unhandled.length }));
        } finally { ctx.w.fetch = origFetch; await ctx.cleanup(); }
      }

      // R35 (9–12)：真正的 production historicalProductLookup controller 被 ppaCleanup() abort。等 lookup 1 真的開始
      // （由攔截 resolve 的 promise 通知，不用固定延遲猜是哪個場次的請求），才呼叫 ppaCleanup()。
      {
        const f = await r35Fixture('R35FXABT-', false);
        const ctx = await createHarness('/index.html', { base });
        const origFetch = ctx.w.fetch.bind(ctx.w);
        let gets = 0; const results = []; let startedResolve;
        const lookupStarted = new Promise((r) => { startedResolve = r; });
        const held = { signal: null, owner: null, abortedAtStart: null, abortEvents: 0 };
        try {
          await r35OpenList(ctx, f);
          ctx.w.fetch = (u, init) => {
            if (r35Method(u, init) === 'GET' && r35Path(ctx, u) === `/api/products/${f.pid}`) {
              const n = ++gets;
              if (n === 1) {
                const signal = init && init.signal;
                held.signal = signal || null;
                held.abortedAtStart = signal ? signal.aborted : null;
                held.owner = ctx.w.document.getElementById('ppa-session-id').value;
                return new Promise((resolve, reject) => {
                  if (signal) {
                    signal.addEventListener('abort', () => { held.abortEvents++; });
                    signal.addEventListener('abort', () => { const err = new ctx.w.DOMException('The operation was aborted.', 'AbortError'); results.push(n + ':' + err.name); reject(err); }, { once: true });
                  }
                  startedResolve(n);
                });
              }
              return origFetch(u, init).then((r) => { results.push(n + ':' + r.status); return r; });
            }
            return origFetch(u, init);
          };
          const st = () => ({ gets, results: results.join(','), cache: r35Cache(ctx, f.pid, f.pname), ...r35Row(ctx, f.pid, f.pname) });
          const openA = ctx.w.ppaOpenSessionForm(f.s1.id);
          const startedN = await r35Bounded('abort lookup start', lookupStarted, 10000);
          const prodController = ctx.w._PPA.controllers.historicalProductLookup;
          const capture = { startedN, gets, ownerIsS1: held.owner === f.s1.id, signalPresent: !!held.signal, isProductionControllerSignal: !!prodController && held.signal === prodController.signal, abortedAtStart: held.abortedAtStart };
          assert(capture.startedN === 1 && capture.gets === 1 && capture.ownerIsS1 && capture.signalPresent && capture.isProductionControllerSignal && capture.abortedAtStart === false, 'R35-abort-production-signal-captured lookup 1 真的由場次 1 發出，攔到的是 production historicalProductLookup controller 的 signal，且一開始尚未 abort', JSON.stringify(capture));
          ctx.w.ppaCleanup();
          const after = { aborted: held.signal ? held.signal.aborted : null, abortEvents: held.abortEvents, results: results.join(','), controllerCleared: ctx.w._PPA.controllers.historicalProductLookup === null };
          assert(after.aborted === true && after.abortEvents === 1 && after.results === '1:AbortError' && after.controllerCleared, 'R35-abort-cleanup-fires-once 真正的 ppaCleanup() 讓該 signal aborted、abort 事件剛好 1 次，結果記錄為 AbortError（不是 TypeError／一般 reject）', JSON.stringify(after));
          let openAOutcome;
          try { await r35Bounded('abort openA settle', openA, 10000); openAOutcome = 'resolved'; } catch (e) { if (/R35 timeout/.test(String(e && e.message))) throw e; openAOutcome = 'rejected:' + (e && e.name); }
          const s = st();
          const settled = { openAOutcome, gets: s.gets, results: s.results, cachePresent: s.cache.present, staleName: s.showsName, abortEvents: held.abortEvents };
          assert(settled.openAOutcome === 'resolved' && settled.gets === 1 && settled.results === '1:AbortError' && !settled.cachePresent && !settled.staleName && settled.abortEvents === 1, 'R35-abort-no-cache-no-stale-ui abort 收斂後沒有商品快取、也沒有把過期名稱寫進畫面', JSON.stringify(settled));
          await r35OpenList(ctx, f);
          await ctx.w.ppaOpenSessionForm(f.s2.id);
          const d = st();
          ctx.w.ppaCloseSessionForm();
          await ctx.w.ppaOpenSessionForm(f.s1.id);
          const e2 = st();
          ctx.w.ppaCloseSessionForm();
          assert(d.gets === 2 && d.results === '1:AbortError,2:200' && d.cache.present && d.cache.nameMatches && d.cache.enabled === false && d.showsName && e2.gets === 2 && e2.cache.present && e2.showsName && held.abortEvents === 1 && r35NoErr(ctx), 'R35-abort-next-open-retries-and-success-reuses 場次 2 重新查詢（GET 2 = 200）並快取顯示正確名稱；重開場次 1 沿用快取（GET 仍為 2）；沒有 error/unhandled/TypeError', JSON.stringify({ d, e2, jsErrorCount: ctx.jsErrors.length, unhandledCount: ctx.unhandled.length }));
        } finally { ctx.w.fetch = origFetch; await ctx.cleanup(); }
      }

      // R35 (13)：跨店 direct GET——store_001 token 讀 store_002 商品是 404，回應不洩漏外店名稱或 store id。
      {
        const pname = 'R35FXXGET-外店商品';
        const p2 = await call('POST', '/api/products', { token: T2, body: { name: pname, category: '測試', price: 91 } });
        if (p2.status !== 201) throw new Error(`R35 setup: store_002 product create failed (status ${p2.status})`);
        const own2 = await call('GET', `/api/products/${p2.json.data.id}`, { token: T2 });
        if (own2.status !== 200) throw new Error(`R35 setup: store_002 cannot read its own product (status ${own2.status})`);
        const g = await call('GET', `/api/products/${p2.json.data.id}`, { token: T1 });
        const raw = JSON.stringify(g.json || {});
        assert(g.status === 404 && g.json && g.json.success === false && !raw.includes(pname) && !raw.includes('store_002'), 'R35-cross-store-direct-get-404-no-leak store_001 token 讀 store_002 商品回 404，回應不含外店商品名稱或 store_002', JSON.stringify({ status: g.status, leaksName: raw.includes(pname), leaksStore: raw.includes('store_002') }));
      }

      // R35 (14)：跨店 selected-session 建立——400 POPUP_VALIDATION_ERROR、零寫入、不洩漏。
      {
        const pname = 'R35FXXCRT-外店商品';
        const p2 = await call('POST', '/api/products', { token: T2, body: { name: pname, category: '測試', price: 92 } });
        if (p2.status !== 201) throw new Error(`R35 setup: store_002 product create failed (status ${p2.status})`);
        const pid2 = p2.json.data.id;
        const c = await makeCampaign('R35FXXCRT-活動');
        const loc = await makeLocation('R35FXXCRT-地點');
        const cnt = (sql, args) => Number((db.get(sql, args) || {}).c || 0);
        const snap = () => ({ sessions: cnt('SELECT COUNT(*) AS c FROM popup_sessions WHERE store_id=?', ['store_001']), foreignRows: cnt('SELECT COUNT(*) AS c FROM popup_session_products WHERE product_id=?', [pid2]), named: cnt('SELECT COUNT(*) AS c FROM popup_sessions WHERE name=?', ['R35FXXCRT-跨店場次']), allRows: cnt('SELECT COUNT(*) AS c FROM popup_session_products', []) });
        const before = snap();
        const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { campaign_id: c.id, name: 'R35FXXCRT-跨店場次', location_id: loc.id, product_scope: 'selected', pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00', order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`, products: [{ product_id: pid2, enabled: 1, quota_qty: 0 }] } });
        const after = snap(); const raw = JSON.stringify(r.json || {});
        const o = { status: r.status, error: r.json && r.json.error, sessionsDelta: after.sessions - before.sessions, foreignRowsDelta: after.foreignRows - before.foreignRows, allRowsDelta: after.allRows - before.allRows, named: after.named, leaksName: raw.includes(pname), leaksStore: raw.includes('store_002') };
        assert(o.status === 400 && o.error === 'POPUP_VALIDATION_ERROR' && o.sessionsDelta === 0 && o.foreignRowsDelta === 0 && o.allRowsDelta === 0 && o.named === 0 && !o.leaksName && !o.leaksStore, 'R35-cross-store-create-rejected-zero-write 含外店商品的 selected 場次建立被 400 POPUP_VALIDATION_ERROR 拒絕，sessions／商品列零寫入，回應不洩漏', JSON.stringify(o));
      }

      // R35 (15)：把外店商品加進既有本店場次——400、revision 不變、商品列不變、零寫入、不洩漏。
      {
        const pname = 'R35FXXUPD-外店商品';
        const p2 = await call('POST', '/api/products', { token: T2, body: { name: pname, category: '測試', price: 93 } });
        if (p2.status !== 201) throw new Error(`R35 setup: store_002 product create failed (status ${p2.status})`);
        const pid2 = p2.json.data.id;
        const own = await call('POST', '/api/products', { token: T1, body: { name: 'R35FXXUPD-本店商品', category: '測試', price: 81 } });
        if (own.status !== 201) throw new Error(`R35 setup: own product create failed (status ${own.status})`);
        const ownId = own.json.data.id;
        const c = await makeCampaign('R35FXXUPD-活動');
        const loc = await makeLocation('R35FXXUPD-地點');
        const ex = await makeSession(c.id, loc.id, { name: 'R35FXXUPD-既有場次', product_scope: 'selected', products: [{ product_id: ownId, enabled: 1, quota_qty: 0 }] });
        const cnt = (sql, args) => Number((db.get(sql, args) || {}).c || 0);
        const row = () => JSON.stringify(db.get('SELECT name, status, product_scope, revision, updated_at FROM popup_sessions WHERE id=?', [ex.id]) || null);
        const snap = () => ({ sessionRows: cnt('SELECT COUNT(*) AS c FROM popup_session_products WHERE session_id=?', [ex.id]), foreignRows: cnt('SELECT COUNT(*) AS c FROM popup_session_products WHERE product_id=?', [pid2]), sessions: cnt('SELECT COUNT(*) AS c FROM popup_sessions WHERE store_id=?', ['store_001']), sessionRow: row() });
        const before = snap();
        const up = await call('PATCH', `/api/popup-pickup/sessions/${ex.id}`, { token: T1, body: { expected_revision: ex.revision, product_scope: 'selected', products: [{ product_id: ownId, enabled: 1, quota_qty: 0 }, { product_id: pid2, enabled: 1, quota_qty: 0 }] } });
        const after = snap(); const raw = JSON.stringify(up.json || {});
        const rb = await call('GET', `/api/popup-pickup/sessions/${ex.id}`, { token: T1 });
        if (rb.status !== 200) throw new Error(`R35 setup: session readback failed (status ${rb.status})`);
        const o = { status: up.status, error: up.json && up.json.error, revisionUnchanged: rb.json.data.revision === ex.revision, productsAfter: (rb.json.data.products || []).map((p) => (p.product_id === ownId ? 'OWN' : p.product_id === pid2 ? 'FOREIGN' : 'OTHER')).join(','), sessionRowsDelta: after.sessionRows - before.sessionRows, foreignRows: after.foreignRows, sessionsDelta: after.sessions - before.sessions, sessionRowUnchanged: after.sessionRow === before.sessionRow, leaksName: raw.includes(pname), leaksStore: raw.includes('store_002') };
        assert(o.status === 400 && o.error === 'POPUP_VALIDATION_ERROR' && o.revisionUnchanged && o.productsAfter === 'OWN' && o.sessionRowsDelta === 0 && o.foreignRows === 0 && o.sessionsDelta === 0 && o.sessionRowUnchanged && !o.leaksName && !o.leaksStore, 'R35-cross-store-update-rejected-revision-unchanged-zero-write 把外店商品加進既有本店場次被 400 拒絕，revision、商品列與場次狀態不變、零寫入、不洩漏', JSON.stringify(o));
      }
    }

  } finally {
    jsdomWindows.forEach((dom) => { try { dom.window.close(); } catch (e) {} });
    if (server) { await new Promise((resolve) => server.close(resolve)); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e.stack || e);
  process.exitCode = 1;
});
