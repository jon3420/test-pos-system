#!/usr/bin/env node
// scripts/smoke-r48-popup-order-ui-browser.js
// R48 — 快閃取餐（/popup-order）顧客前台 UI 整合：真實 Chromium smoke。
//
// - 在同一個 process 內載入真正的 server.js（不是另組 express），使用 os.tmpdir()
//   下的暫存 DB（POS_DB_PATH），結束時刪除；絕不觸碰 data/pos.db 或任何 live DB。
// - 只觀察頁面（Playwright），不在 production 埋任何 seam／observer。
// - 輸出：每個聚合 key 一行 [PASS]/[FAIL]，[INFO] 補充，最後 summary 與
//   `R48_SMOKE_RESULT <json>`（供 repo 外 evaluator 使用）。
// - 環境變數：R48_SCENARIOS（逗號分隔子集，預設全部）、R48_SCREENSHOT_DIR（選用，
//   必須是 repo 外目錄；未設定則不截圖）。
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const ALL_SCENARIOS = ['viewports', 'states', 'functional', 'checkout', 'campaign', 'views', 'error', 'xss', 'general', 'authority'];
const SCEN = (process.env.R48_SCENARIOS || ALL_SCENARIOS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const SHOT_DIR = process.env.R48_SCREENSHOT_DIR || null;
const VIEWPORTS = [[320, 568], [360, 800], [390, 844], [430, 932], [768, 1024], [1280, 800]];
const RAW_STATES = ['ordering_open', 'scheduled', 'ordering_closed', 'pickup_active', 'ended', 'archived', 'cancelled', 'paused', 'invalid', 'draft'];
const EXPECTED_LABEL = {
  open: '開放預訂', scheduled: '尚未開放', closed: '已截止', pickupActive: '取貨進行中', ended: '場次已結束',
  archived: '場次已結束', cancelled: '場次已取消', paused: '暫停接單', full: '名額已滿', invalid: '目前無法預訂',
};

const results = new Map(); // key -> { ok, details: [] }
const info = [];
function check(key, cond, detail) {
  if (!results.has(key)) results.set(key, { ok: true, details: [] });
  const r = results.get(key);
  if (!cond) { r.ok = false; r.details.push(detail === undefined ? 'failed' : String(detail).slice(0, 400)); }
}
function ensureKey(key) { if (!results.has(key)) results.set(key, { ok: true, details: [] }); }
const observations = { console: [], pageErrors: [], requestFailed: [], badResponses: [], hosts: {}, scenariosRun: [] };
const observerStats = { pages: 0, samples: 0, coVisible: 0, where: [] };

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}
const TPE = 8 * 3600 * 1000, H = 3600 * 1000, D = 24 * H;
function tpe(off) { const d = new Date(Date.now() + TPE + off); const p = (n) => String(n).padStart(2, '0'); return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }; }
const isoDb = (off) => { const t = tpe(off); return `${t.date}T${t.time}:00+08:00`; };
const iso = (off) => { const t = tpe(off); return `${t.date}T${t.time}`; };

async function main() {
  const { chromium } = require('playwright');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r48-smoke-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'pos.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'r48-smoke-temp-db-only';
  const port = await freePort();
  process.env.PORT = String(port);
  const serverLines = [];
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  const tag = (lvl) => (...a) => { serverLines.push(`[SERVER] ${lvl} ` + a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ').replace(/\n/g, ' ⏎ ')); };
  console.log = tag('log'); console.error = tag('error'); console.warn = tag('warn');
  require(path.join(ROOT, 'server.js'));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
  const { getDb } = require(path.join(ROOT, 'utils/db'));
  const db = getDb();
  const jwt = require('jsonwebtoken');
  const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  async function call(method, urlPath, { token, body } = {}) {
    const res = await fetch(base + urlPath, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  // ── fixtures（全部寫入暫存 DB）──────────────────────────────
  db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','龍潭測試店','pro',1,?)`, [JSON.stringify({ line_order: true, orders: true, products: true })]);
  db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','popup_pickup_enabled','1')");
  try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
  const prods = [['龍潭花生糖禮盒', 280], ['客家擂茶（冷）', 90], ['手工菜包', 35], ['限量手作重乳酪蛋糕切片組合（含季節限定草莓與開心果雙拼）', 168], ['限量芋頭酥', 60]];
  const ids = prods.map(([n, p]) => { db._db.run(`INSERT INTO products (store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES ('store_001', ?, '快閃', ?, 1, 1, 1)`, [n, p]); return db.get('SELECT id FROM products WHERE store_id=? AND name=?', ['store_001', n]).id; });
  db._save();
  async function mkCampaign(name) {
    const c = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
    await call('PATCH', `/api/popup-pickup/campaigns/${c.json.data.id}`, { token: T1, body: { status: 'published' } });
    return (await call('GET', `/api/popup-pickup/campaigns/${c.json.data.id}`, { token: T1 })).json.data;
  }
  const loc = (await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: '龍潭大池旁停車場', address: '桃園市龍潭區中正路三林段（測試地址）', address_note: '近龍元宮入口，請找綠色帳篷', lat: 24.8638, lng: 121.2163 } })).json.data;
  const camp = await mkCampaign('桃園快閃');
  async function mkSession(name, extra = {}, campaignId = camp.id) {
    const body = { campaign_id: campaignId, name, location_id: loc.id, product_scope: 'selected',
      products: [{ product_id: ids[0], quota_qty: 20 }, { product_id: ids[1], quota_qty: 0 }, { product_id: ids[2], quota_qty: 5 }, { product_id: ids[3], quota_qty: 0 }, { product_id: ids[4], quota_qty: 1 }],
      pickup_date: tpe(2 * D).date, pickup_start_time: '10:00', pickup_end_time: '18:00', order_open_at: iso(-1 * D), order_cutoff_at: `${tpe(2 * D).date}T09:00`, max_orders: 50, ...extra };
    const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body });
    if (r.status !== 201) throw new Error('fixture session create failed: ' + JSON.stringify(r.json));
    const pr = await call('PATCH', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1, body: { expected_revision: r.json.data.revision, status: 'published' } });
    if (pr.status !== 200) throw new Error('fixture session publish failed: ' + JSON.stringify(pr.json));
    return (await call('GET', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1 })).json.data;
  }
  function dbSet(id, sets) { const k = Object.keys(sets); db._db.run(`UPDATE popup_sessions SET ${k.map((x) => x + '=?').join(',')} WHERE id=?`, [...k.map((x) => sets[x]), id]); db._save(); }
  async function apiCheckout(code, items) {
    return call('POST', '/api/line-orders/popup-checkout', { body: { popup_session_public_code: code, customer_name: '測試顧客', customer_phone: '0912000111', payment_method: 'cash', items } });
  }
  const S = {};
  S.open = await mkSession('龍潭場次');
  await apiCheckout(S.open.public_code, [{ product_id: ids[4], qty: 1 }]); // 讓芋頭酥售完、名額 1/50
  S.scheduled = await mkSession('尚未開放場次', { order_open_at: iso(1 * D), order_cutoff_at: `${tpe(3 * D).date}T09:00`, pickup_date: tpe(3 * D).date });
  S.closed = await mkSession('已截止場次', { pickup_date: tpe(1 * D).date, order_cutoff_at: `${tpe(1 * D).date}T09:00` });
  dbSet(S.closed.id, { order_open_at: isoDb(-2 * D), order_cutoff_at: isoDb(-1 * H) });
  S.pickupActive = await mkSession('取貨中場次');
  { const st = tpe(-1 * H), en = tpe(2 * H); dbSet(S.pickupActive.id, { pickup_date: st.date, pickup_start_time: st.time, pickup_end_time: en.date === st.date ? en.time : '23:59', order_open_at: isoDb(-3 * D), order_cutoff_at: isoDb(-2 * H) }); }
  S.ended = await mkSession('已結束場次');
  dbSet(S.ended.id, { pickup_date: tpe(-1 * D).date, order_open_at: isoDb(-4 * D), order_cutoff_at: `${tpe(-2 * D).date}T09:00:00+08:00` });
  S.archived = await mkSession('封存場次'); dbSet(S.archived.id, { status: 'archived' });
  S.cancelled = await mkSession('已取消場次'); dbSet(S.cancelled.id, { status: 'cancelled' });
  S.paused = await mkSession('暫停場次'); dbSet(S.paused.id, { status: 'paused' });
  S.invalid = await mkSession('時間異常場次'); dbSet(S.invalid.id, { order_cutoff_at: 'not-a-time' });
  S.full = await mkSession('額滿場次', { max_orders: 1 });
  await apiCheckout(S.full.public_code, [{ product_id: ids[1], qty: 1 }]);
  S.checkout = await mkSession('結帳場次');
  S.retry = await mkSession('重試場次');
  const xc = await mkCampaign('<img src=x onerror="window.__r48xss=1">XSS活動');
  S.xss = await mkSession('<svg onload="window.__r48xss=2">場次', {}, xc.id);
  const pickerCamp = await mkCampaign('選擇場次活動');
  S.pick1 = await mkSession('第一場', {}, pickerCamp.id);
  S.pick2 = await mkSession('第二場', {}, pickerCamp.id);
  const stateKeys = ['open', 'scheduled', 'closed', 'pickupActive', 'ended', 'archived', 'cancelled', 'paused', 'invalid', 'full'];
  const fxStates = {};
  for (const k of stateKeys) { const r = await call('GET', `/api/line-orders/popup-session/${S[k].public_code}`); fxStates[k] = r.json.data ? r.json.data.effective_state + '/' + r.json.data.can_order : 'HTTP' + r.status; }
  info.push('fixture states ' + JSON.stringify(fxStates));
  const fixtureOk = fxStates.open === 'ordering_open/true' && fxStates.scheduled === 'scheduled/false' && fxStates.closed === 'ordering_closed/false' && fxStates.pickupActive === 'pickup_active/false' && fxStates.ended === 'ended/false' && fxStates.archived === 'archived/false' && fxStates.cancelled === 'cancelled/false' && fxStates.paused === 'paused/false' && fxStates.invalid === 'invalid/false' && fxStates.full === 'ordering_open/true';
  check('R_FIXTURE_STATES', fixtureOk, JSON.stringify(fxStates));

  const browser = await chromium.launch();
  const allPages = [];
  const ALLOWED_PATH = /^\/(popup-order|line-order\.html|css\/[\w.-]+\.css|js\/[\w.-]+\.js|api\/line-orders\/popup-(session|campaign|checkout|entry)\b|api\/[\w/-]+)/;
  async function openPage(vp, urlPath, { clean = true, routeFn = null, record = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] } });
    const page = await ctx.newPage();
    const pageObs = { console: [], pageErrors: [], requestFailed: [], badResponses: [], requests: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') pageObs.console.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
    page.on('pageerror', (e) => pageObs.pageErrors.push(String(e && e.message).slice(0, 300)));
    page.on('requestfailed', (r) => pageObs.requestFailed.push(r.url().replace(base, '')));
    page.on('request', (r) => { const u = new URL(r.url()); pageObs.requests.push(r.method() + ' ' + (u.origin === base ? u.pathname : u.href)); observations.hosts[u.host] = (observations.hosts[u.host] || 0) + 1; });
    page.on('response', (r) => { if (r.status() >= 400) pageObs.badResponses.push(r.status() + ' ' + r.url().replace(base, '')); });
    if (routeFn) await page.route('**/api/line-orders/popup-session/**', routeFn);
    await page.goto(base + urlPath, { waitUntil: 'networkidle' });
    if (record) allPages.push({ urlPath, clean, pageObs });
    return { ctx, page, pageObs };
  }
  async function settle(page) {
    await page.waitForFunction(() => { const r = document.getElementById('popupRoot'); return !!r && r.getAttribute('data-popup-view') && r.getAttribute('data-popup-view') !== 'loading'; }, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
  }
  async function shot(page, name) { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true }); } }

  // 單一頁面量測（session 畫面）
  const MEASURE = () => {
    const vis = (el) => { if (!el || !el.isConnected) return false; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const root = document.getElementById('popupRoot');
    const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
    const cw = document.documentElement.clientWidth;
    const legacyLoading = document.getElementById('loading');
    const spinners = root ? [...root.querySelectorAll('.popup-order-spinner')].filter(vis).length : 0;
    const busy = document.querySelectorAll('[aria-busy="true"]').length;
    const products = root ? root.querySelectorAll('li[data-product-id]').length : 0;
    const legacyHidden = ['content', 'cartBar', 'overlay', 'announceOverlay'].every((id) => !vis(document.getElementById(id))) && [...document.querySelectorAll('.sheet')].every((x) => !vis(x));
    const interactive = root ? [...root.querySelectorAll('button, a[href], input, textarea, select')].filter(vis) : [];
    const touch = root ? [...root.querySelectorAll('button, a[href]')].filter(vis).map((el) => ({ n: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })) : [];
    const accName = (el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent) || el.textContent || el.getAttribute('title') || '').trim();
    const unnamed = interactive.filter((el) => !accName(el)).map((el) => el.tagName + '#' + el.id);
    const labelPairs = ['popupCustomerName', 'popupCustomerPhone', 'popupCustomerNote'].map((id) => { const el = document.getElementById(id); const lab = document.querySelector(`label[for="${id}"]`); return { id, el: !!el, lab: !!lab && lab.textContent.trim().length > 0, linked: !!el && !!el.labels && [...el.labels].includes(lab) }; });
    const fieldRects = ['popupCustomerName', 'popupCustomerPhone', 'popupCustomerNote', 'popupCheckoutSubmitBtn'].map((id) => { const el = document.getElementById(id); return el ? rect(el) : null; });
    const pay = root && root.querySelector('[data-payment-code]');
    const card = root && root.querySelector('.popup-order-checkout');
    const main = root ? [...root.querySelectorAll('li[data-product-id], .popup-order-qty-btn, .popup-order-card, .popup-order-input, #popupCheckoutSubmitBtn, .popup-order-header')].filter(vis).map(rect) : [];
    const outOfView = main.filter((r) => r.l < -0.5 || r.r > cw + 0.5).length;
    const stickyFixed = root ? [...root.querySelectorAll('*')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position)).length : -1;
    const shell = root && root.querySelector('.popup-order-shell');
    const rootRect = root ? rect(root) : null;
    const text = root ? root.innerText : '';
    // data-tone 的值來自 R48 contract §7.4 的 tone 詞彙（open/wait/closed/ended/danger/neutral），
    // 另外單獨驗證；其餘所有屬性值（含 aria-label/title/alt）都納入 raw state 檢查。
    const attrText = root ? [...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => a.name !== 'data-tone' && a.name !== 'class').map((a) => a.value)).join(' ') : '';
    const tones = root ? [...root.querySelectorAll('[data-tone]')].map((el) => el.getAttribute('data-tone')) : [];
    const status = root && root.querySelector('.popup-order-status');
    return {
      view: root && root.getAttribute('data-popup-view'), rootVisible: vis(root), rootRole: root && root.getAttribute('role'), rootClass: root && root.className, bodyMode: document.body.classList.contains('popup-order-mode'),
      legacyLoadingVisible: vis(legacyLoading), spinners, busy, products, legacyHidden, mains: document.querySelectorAll('[role="main"]').length,
      sw: document.documentElement.scrollWidth, cw, touch, unnamed, labelPairs, fieldRects, payRect: pay ? rect(pay) : null, cardRect: card ? rect(card) : null,
      outOfView, stickyFixed, rootRect, shellW: shell ? shell.getBoundingClientRect().width : null, text, attrText,
      tones, statusText: status ? status.textContent.trim() : null, statusTone: status ? status.getAttribute('data-tone') : null,
      notice: (root && root.querySelector('[data-testid="popup-state-notice"]')) ? root.querySelector('[data-testid="popup-state-notice"]').innerText : null,
      brand: root && root.querySelector('.popup-order-brand') ? root.querySelector('.popup-order-brand').textContent : null,
      title: root && root.querySelector('.popup-order-title') ? root.querySelector('.popup-order-title').textContent : null,
      mapLink: !!(root && root.querySelector('a.popup-order-map-link[href*="google.com/maps"]')),
      productTexts: root ? [...root.querySelectorAll('li[data-product-id]')].map((li) => ({ id: li.getAttribute('data-product-id'), t: li.innerText.replace(/\s+/g, ' '), plusDisabled: li.querySelector('[data-action="plus"]').disabled, minusDisabled: li.querySelector('[data-action="minus"]').disabled, dis: li.getAttribute('data-disabled') })) : [],
      allQtyDisabled: root ? [...root.querySelectorAll('li[data-product-id] button')].every((b) => b.disabled) : null,
      allPayDisabled: root ? [...root.querySelectorAll('[data-payment-code]')].every((b) => b.disabled) : null,
      inputsDisabled: ['popupCustomerName', 'popupCustomerPhone', 'popupCustomerNote'].every((id) => document.getElementById(id) && document.getElementById(id).disabled),
      submitDisabled: document.getElementById('popupCheckoutSubmitBtn') ? document.getElementById('popupCheckoutSubmitBtn').disabled : null,
    };
  };
  const rawCodeRe = new RegExp('\\b(' + RAW_STATES.join('|') + ')\\b');
  function statusChecks(m, k, where) {
    check('R_NO_RAW_STATUS', m.statusText === EXPECTED_LABEL[k], `${where} ${k}: pill=${m.statusText} expected=${EXPECTED_LABEL[k]}`);
    check('R_NO_RAW_STATUS', !rawCodeRe.test(m.text) && !rawCodeRe.test(m.attrText), `${where} ${k}: raw state code in text/attributes`);
    check('R_NO_RAW_STATUS', m.tones.every((t) => ['open', 'wait', 'closed', 'ended', 'danger', 'neutral', 'info', 'soldout', 'loading', 'error'].includes(t)), `${where} ${k}: tone outside contract vocabulary ${JSON.stringify(m.tones)}`);
  }
  function loadingGone(m, where, view) {
    check('R_LOADING_HIDDEN', !m.legacyLoadingVisible && m.spinners === 0 && m.busy === 0 && m.view === view, `${where} legacyLoading=${m.legacyLoadingVisible} spinners=${m.spinners} busy=${m.busy} view=${m.view}`);
  }
  function fitChecks(m, vp, where) {
    const fit = m.sw <= m.cw && m.outOfView === 0;
    if (vp[0] === 320) check('R_NO_OVERFLOW_320', fit, `${where} sw=${m.sw} cw=${m.cw} outOfView=${m.outOfView}`);
    else check('R_LAYOUT_FIT', fit, `${where} ${vp[0]}x${vp[1]} sw=${m.sw} cw=${m.cw} outOfView=${m.outOfView}`);
  }
  async function readObserver(page, where) {
    const o = await page.evaluate(() => (window.__R48_OBS ? { samples: window.__R48_OBS.samples, coVisible: window.__R48_OBS.coVisible } : null));
    if (o) { observerStats.pages++; observerStats.samples += o.samples; observerStats.coVisible += o.coVisible; if (o.coVisible) observerStats.where.push(where); }
  }
  function sessionLayoutChecks(m, vp, where) {
    const vpn = `${vp[0]}x${vp[1]}`;
    check('R_LOADING_HIDDEN', !m.legacyLoadingVisible && m.spinners === 0 && m.busy === 0 && m.products > 0 && m.view === 'session', `${where} ${vpn} legacyLoading=${m.legacyLoadingVisible} spinners=${m.spinners} busy=${m.busy} products=${m.products} view=${m.view}`);
    fitChecks(m, vp, where);
    check('R_SINGLE_UI', m.rootVisible && m.rootRole === 'main' && /popup-order-root/.test(m.rootClass) && m.bodyMode && m.legacyHidden && m.mains === 1, `${where} ${vpn} rootVisible=${m.rootVisible} class=${m.rootClass} bodyMode=${m.bodyMode} legacyHidden=${m.legacyHidden} mains=${m.mains}`);
    if (vp[0] >= 760) check('R_LAYOUT_720', m.shellW !== null && m.shellW <= 720.5 && Math.abs(m.rootRect.l - (m.cw - m.rootRect.r)) <= 2, `${where} ${vpn} shellW=${m.shellW} root=${JSON.stringify(m.rootRect)}`);
    const small = m.touch.filter((t) => t.w < 44 || t.h < 44);
    check('R_TOUCH_TARGET_44', m.touch.length > 0 && small.length === 0, `${where} ${vpn} small=${JSON.stringify(small.slice(0, 4))}`);
    check('R_LABELS_A11Y', m.unnamed.length === 0 && m.labelPairs.every((p) => p.el && p.lab && p.linked), `${where} ${vpn} unnamed=${m.unnamed} labels=${JSON.stringify(m.labelPairs)}`);
    const fr = m.fieldRects;
    const vertical = fr.every(Boolean) && fr[0].b <= fr[1].t + 0.5 && fr[1].b <= fr[2].t + 0.5 && fr[2].b <= fr[3].t + 0.5 && m.cardRect && fr.slice(0, 3).every((r) => r.w >= m.cardRect.w * 0.6);
    check('R_FORM_VERTICAL', vertical, `${where} ${vpn} fields=${JSON.stringify(fr)} card=${JSON.stringify(m.cardRect)}`);
    check('R_NO_STICKY_FIXED', m.stickyFixed === 0, `${where} ${vpn} stickyFixed=${m.stickyFixed}`);
  }

  // ═════ 1. 六 viewport：開放中場次 ═════
  if (SCEN.includes('viewports')) {
    observations.scenariosRun.push('viewports');
    for (const vp of VIEWPORTS) {
      const { ctx, page, pageObs } = await openPage(vp, `/popup-order?session=${S.open.public_code}`);
      await settle(page);
      const m = await page.evaluate(MEASURE);
      await readObserver(page, `open vp${vp[0]}`);
      sessionLayoutChecks(m, vp, 'open');
      statusChecks(m, 'open', `vp${vp[0]}`);
      const sessionApi = pageObs.requests.filter((r) => /\/api\/line-orders\/popup-session\//.test(r)).length;
      const unexpected = pageObs.requests.filter((r) => !ALLOWED_PATH.test(r.split(' ')[1]));
      check('R_NO_EXTRA_REQUESTS', sessionApi === 1 && unexpected.length === 0 && pageObs.requests.filter((r) => /\/api\//.test(r)).length === 1, `vp${vp[0]} api=${JSON.stringify(pageObs.requests.filter((r) => /\/api\//.test(r)))} unexpected=${JSON.stringify(unexpected)}`);
      const headerOk = m.brand === '快閃取餐' && m.title === '桃園快閃 － 龍潭場次' && /取貨日期/.test(m.text) && m.text.includes(S.open.pickup_date) && /10:00～18:00/.test(m.text) && m.text.includes('龍潭大池旁停車場') && m.text.includes('桃園市龍潭區中正路三林段（測試地址）') && m.text.includes('近龍元宮入口') && m.mapLink && /預訂截止/.test(m.text) && /1 \/ 50/.test(m.text);
      check('R_HEADER_INFO', headerOk, `vp${vp[0]} brand=${m.brand} title=${m.title} map=${m.mapLink}`);
      const pt = m.productTexts;
      const prodOk = pt.length === 5 && pt[0].t.includes('龍潭花生糖禮盒') && pt[0].t.includes('NT$280') && pt[0].t.includes('剩 20') && pt[2].t.includes('剩 5') && pt[4].t.includes('售完') && pt[4].plusDisabled && pt[4].dis === 'true' && pt.every((p) => p.minusDisabled) && !pt[0].plusDisabled;
      check('R_PRODUCT_CARDS', prodOk, `vp${vp[0]} ${JSON.stringify(pt.map((p) => p.t))}`);
      await shot(page, `session_${vp[0]}x${vp[1]}`);
      // 200% zoom：主要操作不被遮擋且可操作
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
      const occl = [];
      for (const sel of ['#popupRoot li[data-product-id] [data-action="plus"]', '#popupCustomerName', '#popupCustomerPhone', '#popupCheckoutSubmitBtn', '#popupRoot [data-payment-code]']) {
        const loc = page.locator(sel).first();
        await loc.scrollIntoViewIfNeeded();
        const ok = await loc.evaluate((el) => { const r = el.getBoundingClientRect(); const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1; const cx = (r.left + r.width / 2) * (z === 1 ? 1 : 1); const cy = (r.top + r.height / 2); const hit = document.elementFromPoint(cx, cy) || document.elementFromPoint(cx * z, cy * z); return !!hit && (hit === el || el.contains(hit)); });
        if (!ok) occl.push(sel);
      }
      await page.locator('#popupRoot li[data-product-id] [data-action="plus"]').first().click();
      const q = await page.locator('#popupRoot li[data-product-id] .popup-order-qty-value').first().textContent();
      check('R_TEXT_ZOOM_200', occl.length === 0 && q.trim() === '1', `vp${vp[0]} occluded=${JSON.stringify(occl)} qtyAfterClick=${q}`);
      await ctx.close();
    }
  }

  // ═════ 2. 所有已知 effective state ═════
  if (SCEN.includes('states')) {
    observations.scenariosRun.push('states');
    for (const k of stateKeys.filter((x) => x !== 'open')) {
      for (const vp of (k === 'closed' ? VIEWPORTS : [[390, 844]])) {
        const { ctx, page } = await openPage(vp, `/popup-order?session=${S[k].public_code}`);
        await settle(page);
        const m = await page.evaluate(MEASURE);
        await readObserver(page, `${k} vp${vp[0]}`);
        statusChecks(m, k, `vp${vp[0]}`);
        loadingGone(m, `${k} vp${vp[0]}`, 'session');
        if (k === 'full') {
          check('R_READ_ONLY_STATES', m.notice && m.notice.includes('名額已滿') && !m.allPayDisabled && !m.inputsDisabled, `full notice=${m.notice} payDisabled=${m.allPayDisabled}`);
        } else {
          check('R_READ_ONLY_STATES', m.notice && m.notice.includes('此場次目前為唯讀狀態') && m.allQtyDisabled && m.allPayDisabled && m.inputsDisabled && m.submitDisabled === true, `${k} notice=${m.notice} qty=${m.allQtyDisabled} pay=${m.allPayDisabled} inputs=${m.inputsDisabled} submit=${m.submitDisabled}`);
          // 點擊 disabled 加號不得改變購物車
          await page.locator('#popupRoot li[data-product-id] [data-action="plus"]').first().click({ force: true }).catch(() => {});
          const items = await page.evaluate(() => popupCart.items.length);
          check('R_READ_ONLY_STATES', items === 0, `${k} cart items after forced click=${items}`);
        }
        if (vp[0] === 390 || k === 'closed') {
          if (k === 'closed') sessionLayoutChecks(m, vp, 'closed');
          await shot(page, `readonly_${k}_${vp[0]}x${vp[1]}`);
        }
        await ctx.close();
      }
    }
  }

  // ═════ 3. 功能：數量／小計／E1／儲存 ═════
  if (SCEN.includes('functional')) {
    observations.scenariosRun.push('functional');
    const { ctx, page } = await openPage([390, 844], `/popup-order?session=${S.open.public_code}`);
    await settle(page);
    const plus = (i) => page.locator(`#popupRoot li[data-product-id="${ids[i]}"] [data-action="plus"]`);
    const minus = (i) => page.locator(`#popupRoot li[data-product-id="${ids[i]}"] [data-action="minus"]`);
    const qty = async (i) => (await page.locator(`#popupRoot li[data-product-id="${ids[i]}"] .popup-order-qty-value`).textContent()).trim();
    check('R_EMPTY_CART_SUBMIT_DISABLED', await page.evaluate(() => document.getElementById('popupCheckoutSubmitBtn').disabled === true && /購物車是空的/.test(document.querySelector('.popup-order-checkout').innerText)), 'empty cart');
    await plus(0).click(); await plus(0).click();
    const q2 = await qty(0);
    await minus(0).click(); await minus(0).click();
    const q0 = await qty(0);
    const minusDis = await minus(0).isDisabled();
    for (let i = 0; i < 6; i++) { if (!(await plus(2).isDisabled())) await plus(2).click(); }
    const q5 = await qty(2); const plus2Dis = await plus(2).isDisabled();
    await plus(0).click();
    const sub = await page.evaluate(() => document.querySelector('[data-testid="popup-checkout-total"]').textContent.trim());
    const lines = await page.evaluate(() => [...document.querySelectorAll('.popup-order-cart-line')].map((l) => l.innerText.replace(/\s+/g, ' ')));
    check('R_QTY_SUBTOTAL', q2 === '2' && q0 === '0' && minusDis && q5 === '5' && plus2Dis && sub === '小計：NT$455' && lines.length === 2 && lines.some((l) => /手工菜包 x5/.test(l) && /NT\$175/.test(l)) && lines.some((l) => /龍潭花生糖禮盒 x1/.test(l) && /NT\$280/.test(l)), JSON.stringify({ q2, q0, minusDis, q5, plus2Dis, sub, lines }));
    // E1：先選付款，再輸入姓名／電話
    await page.locator('#popupRoot [data-payment-code="cash"]').click();
    const beforeTyping = await page.evaluate(() => document.getElementById('popupCheckoutSubmitBtn').disabled);
    await page.fill('#popupCustomerName', '王小明');
    await page.fill('#popupCustomerPhone', '0912345678');
    const afterTyping = await page.evaluate(() => ({ dis: document.getElementById('popupCheckoutSubmitBtn').disabled, ok: popupValidateCheckout().ok, hint: document.getElementById('popupCheckoutHint').textContent }));
    await page.fill('#popupCustomerPhone', '0912');
    const afterBadPhone = await page.evaluate(() => ({ dis: document.getElementById('popupCheckoutSubmitBtn').disabled, hint: document.getElementById('popupCheckoutHint').textContent }));
    await page.fill('#popupCustomerPhone', '0912345678');
    await page.fill('#popupCustomerNote', '請放門口');
    check('R_E1_SUBMIT_REFRESH', beforeTyping === true && afterTyping.dis === false && afterTyping.ok === true && afterBadPhone.dis === true && /手機/.test(afterBadPhone.hint), JSON.stringify({ beforeTyping, afterTyping, afterBadPhone }));
    // 重新整理後購物車／草稿由 localStorage 還原
    await page.reload({ waitUntil: 'networkidle' }); await settle(page);
    const restored = await page.evaluate(() => ({ items: popupCart.items, name: document.getElementById('popupCustomerName').value, note: document.getElementById('popupCustomerNote').value, pay: popupCart.payment_method, sub: document.querySelector('[data-testid="popup-checkout-total"]').textContent.trim(), dis: document.getElementById('popupCheckoutSubmitBtn').disabled }));
    check('R_STORAGE_PERSIST', restored.items.length === 2 && restored.name === '王小明' && restored.note === '請放門口' && restored.pay === 'cash' && restored.sub === '小計：NT$455' && restored.dis === false, JSON.stringify(restored));
    await ctx.close();
  }

  // ═════ 4. 真實暫存 DB checkout ═════
  if (SCEN.includes('checkout')) {
    observations.scenariosRun.push('checkout');
    const before = db.get("SELECT COUNT(*) AS c FROM orders WHERE store_id='store_001' AND order_number LIKE 'POPUP-%'").c;
    const { ctx, page, pageObs } = await openPage([390, 844], `/popup-order?session=${S.checkout.public_code}`);
    await settle(page);
    await page.locator(`#popupRoot li[data-product-id="${ids[1]}"] [data-action="plus"]`).click();
    await page.locator(`#popupRoot li[data-product-id="${ids[1]}"] [data-action="plus"]`).click();
    await page.locator('#popupRoot [data-payment-code="cash"]').click();
    await page.fill('#popupCustomerName', '結帳測試');
    await page.fill('#popupCustomerPhone', '0911222333');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url().replace(base, '') + ' ' + (r.postData() || '')); });
    await page.locator('#popupCheckoutSubmitBtn').click();
    await page.waitForFunction(() => document.getElementById('popupRoot').getAttribute('data-popup-view') === 'success', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    const after = db.get("SELECT COUNT(*) AS c FROM orders WHERE store_id='store_001' AND order_number LIKE 'POPUP-%'").c;
    const m = await page.evaluate(MEASURE);
    const stored = await page.evaluate((code) => localStorage.getItem('line_popup_cart_v1_' + code), S.checkout.public_code);
    let payloadOk = false;
    try { const body = JSON.parse(posts[0].slice(posts[0].indexOf(' ') + 1)); payloadOk = posts.length === 1 && posts[0].startsWith('/api/line-orders/popup-checkout ') && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['customer_name', 'customer_phone', 'items', 'payment_method', 'popup_session_public_code']) && body.items.length === 1 && body.items[0].qty === 2; } catch (e) { payloadOk = false; }
    const dbOk = after === before + 1 && process.env.POS_DB_PATH.startsWith(os.tmpdir()) && !fs.existsSync(path.join(ROOT, 'data', 'pos.db'));
    check('R_CHECKOUT_TEMP_DB', m.view === 'success' && /訂購成功/.test(m.text) && /訂單編號：POPUP-/.test(m.text) && /NT\$180/.test(m.text) && payloadOk && dbOk && stored === null, JSON.stringify({ view: m.view, before, after, payloadOk, stored, posts }));
    check('R_LOADING_TERMINATES_VIEWS', m.view === 'success' && m.spinners === 0 && m.busy === 0, `success view=${m.view} spinners=${m.spinners} busy=${m.busy}`);
    loadingGone(m, 'success', 'success');
    await shot(page, 'success_390x844');
    await ctx.close();
    if (SHOT_DIR) for (const vp of VIEWPORTS) { // 成功畫面各 viewport 代表截圖（使用 response snapshot 重繪，不再送單）
      const c2 = await openPage(vp, `/popup-order?session=${S.checkout.public_code}`); await settle(c2.page);
      await c2.page.evaluate(() => renderPopupCheckoutSuccess({ order_number: 'POPUP-SCREENSHOT-ONLY', pickup_date: popupSession.pickup_date, pickup_start_time: popupSession.pickup_start_time, pickup_end_time: popupSession.pickup_end_time, place_name: popupSession.place_name, address: popupSession.address, address_note: popupSession.address_note, items: [{ product_id: 1, qty: 2 }], total: 180 }));
      await settle(c2.page); await shot(c2.page, `success_${vp[0]}x${vp[1]}`); await c2.ctx.close();
    }
  }

  // ═════ 5. campaign／store 入口 ═════
  if (SCEN.includes('campaign')) {
    observations.scenariosRun.push('campaign');
    for (const vp of VIEWPORTS) {
      const { ctx, page } = await openPage(vp, `/popup-order?campaign=${pickerCamp.public_code}`);
      await settle(page);
      const m = await page.evaluate(MEASURE);
      const btns = await page.evaluate(() => [...document.querySelectorAll('#popupRoot button[data-session-code]')].map((b) => b.textContent));
      check('R_CAMPAIGN_PICKER', m.view === 'picker' && btns.length === 2 && m.title === '選擇場次活動', `vp${vp[0]} view=${m.view} btns=${btns.length}`);
      fitChecks(m, vp, `picker`);
      check('R_LOADING_TERMINATES_VIEWS', m.view === 'picker' && m.spinners === 0 && m.busy === 0, `picker vp${vp[0]}`);
      loadingGone(m, `picker vp${vp[0]}`, 'picker');
      const small = m.touch.filter((t) => t.w < 44 || t.h < 44);
      check('R_TOUCH_TARGET_44', small.length === 0, `picker vp${vp[0]} small=${JSON.stringify(small)}`);
      await shot(page, `picker_${vp[0]}x${vp[1]}`);
      if (vp[0] === 390) {
        await page.locator('#popupRoot button[data-session-code]').first().click();
        await page.waitForFunction(() => document.getElementById('popupRoot').getAttribute('data-popup-view') === 'session', { timeout: 8000 }).catch(() => {});
        const m2 = await page.evaluate(MEASURE);
        check('R_CAMPAIGN_PICKER', m2.view === 'session' && m2.products === 5, `after pick view=${m2.view}`);
        loadingGone(m2, 'after pick', 'session');
      }
      await ctx.close();
    }
    const st = await openPage([390, 844], `/popup-order?store_id=store_001`);
    await settle(st.page);
    const ms = await st.page.evaluate(MEASURE);
    const n = await st.page.evaluate(() => document.querySelectorAll('#popupRoot button[data-session-code]').length);
    check('R_CAMPAIGN_PICKER', ms.view === 'picker' && n >= 3, `store entry view=${ms.view} sessions=${n}`);
    await st.ctx.close();
  }

  // ═════ 6. 其他畫面（conflict）終止 loading ═════
  if (SCEN.includes('views')) {
    observations.scenariosRun.push('views');
    const { ctx, page } = await openPage([390, 844], `/popup-order?session=${S.open.public_code}`);
    await settle(page);
    await page.evaluate(() => { renderPopupLoading(); renderPopupCartConflictChoice(); });
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    const m = await page.evaluate(MEASURE);
    const nb = await page.evaluate(() => document.querySelectorAll('#popupRoot button').length);
    check('R_LOADING_TERMINATES_VIEWS', m.view === 'conflict' && nb === 2 && m.spinners === 0 && m.busy === 0, `conflict view=${m.view} buttons=${nb}`);
    loadingGone(m, 'conflict', 'conflict');
    const small = m.touch.filter((t) => t.w < 44 || t.h < 44);
    check('R_TOUCH_TARGET_44', small.length === 0, `conflict small=${JSON.stringify(small)}`);
    await ctx.close();
  }

  // ═════ 7. error／retry（刻意錯誤，不計入 R_CONSOLE_CLEAN）═════
  if (SCEN.includes('error')) {
    observations.scenariosRun.push('error');
    for (const vp of VIEWPORTS) {
      const { ctx, page } = await openPage(vp, `/popup-order?session=NOT-A-REAL-SESSION-CODE`, { clean: false });
      await page.waitForFunction(() => document.getElementById('popupRoot') && document.getElementById('popupRoot').getAttribute('data-popup-view') === 'error', { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
      const m = await page.evaluate(MEASURE);
      const retry = await page.evaluate(() => { const b = document.querySelector('#popupRoot button.popup-order-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, label: b.getAttribute('aria-label'), live: !!document.querySelector('#popupRoot [aria-live="polite"]') }; });
      check('R_ERROR_RETRY_LOADING', m.view === 'error' && retry && retry.w >= 44 && retry.h >= 44 && retry.label === '重新載入' && retry.live && !m.legacyLoadingVisible && m.spinners === 0 && m.busy === 0  && !/POPUP_SESSION_NOT_FOUND/.test(m.text), `vp${vp[0]} ${JSON.stringify({ view: m.view, retry, legacy: m.legacyLoadingVisible, spinners: m.spinners, busy: m.busy })}`);
      fitChecks(m, vp, 'error');
      await shot(page, `error_${vp[0]}x${vp[1]}`);
      await ctx.close();
    }
    // network reject → retry → 正式內容
    let n = 0;
    const { ctx, page } = await openPage([390, 844], `/popup-order?session=${S.retry.public_code}`, { clean: false, routeFn: (route) => { n += 1; if (n === 1) route.abort('failed'); else route.continue(); } });
    await page.waitForFunction(() => document.getElementById('popupRoot').getAttribute('data-popup-view') === 'error', { timeout: 8000 }).catch(() => {});
    const e1 = await page.evaluate(MEASURE);
    await page.locator('#popupRoot button.popup-order-btn').click();
    await page.waitForFunction(() => document.getElementById('popupRoot').getAttribute('data-popup-view') === 'session', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    const e2 = await page.evaluate(MEASURE);
    check('R_ERROR_RETRY_LOADING', e1.view === 'error' && e1.spinners === 0 && e1.busy === 0 && !e1.legacyLoadingVisible && e2.view === 'session' && e2.products === 5 && n === 2, `reject→retry ${JSON.stringify({ e1: e1.view, e1s: e1.spinners, e1b: e1.busy, e2: e2.view, e2p: e2.products, n })}`);
    loadingGone(e2, 'after retry', 'session');
    await ctx.close();
  }

  // ═════ 8. XSS fixture inert ═════
  if (SCEN.includes('xss')) {
    observations.scenariosRun.push('xss');
    const { ctx, page, pageObs } = await openPage([390, 844], `/popup-order?session=${S.xss.public_code}`, { clean: false });
    await settle(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const root = document.getElementById('popupRoot'); return { flag: window.__r48xss || 0, tags: root.querySelectorAll('img,svg,script,iframe,object').length, handlers: [...root.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length, text: root.innerText.includes('<img src=x') && root.innerText.includes('<svg onload') }; });
    const unexpected = pageObs.requests.filter((x) => !ALLOWED_PATH.test(x.split(' ')[1]));
    check('R_XSS_INERT', r.flag === 0 && r.tags === 0 && r.handlers === 0 && r.text && unexpected.length === 0 && pageObs.badResponses.length === 0 && pageObs.pageErrors.length === 0 && pageObs.console.length === 0, JSON.stringify({ ...r, unexpected, bad: pageObs.badResponses, pe: pageObs.pageErrors, con: pageObs.console }));
    await ctx.close();
  }

  // ═════ 9. 一般 LINE 外帶／外送頁不受影響 ═════
  if (SCEN.includes('general')) {
    observations.scenariosRun.push('general');
    for (const vp of [[390, 844], [1280, 800]]) {
      const { ctx, page, pageObs } = await openPage(vp, `/line-order.html?store_id=store_001`, { clean: false });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('loading')).display === 'none', { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
      const g = await page.evaluate(() => {
        const props = ['display', 'position', 'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'border-top-width', 'border-top-color', 'border-radius', 'outline-color', 'outline-style', 'box-shadow', 'visibility', 'opacity', 'text-align', 'min-height', 'min-width', 'max-width'];
        const snap = () => [...document.querySelectorAll('body *')].map((el) => { const cs = getComputedStyle(el); return el.tagName + '|' + props.map((p) => cs.getPropertyValue(p)).join(';'); }).join('\n');
        const sheet = [...document.styleSheets].find((s) => s.href && s.href.includes('/css/popup-order.css'));
        if (!sheet) return { sheet: false };
        let sel = []; try { sel = [...sheet.cssRules].flatMap((r) => (r.selectorText ? [r.selectorText] : (r.cssRules ? [...r.cssRules].map((x) => x.selectorText).filter(Boolean) : []))); } catch (e) { return { sheet: 'unreadable' }; }
        const matched = sel.filter((s) => { try { return document.querySelector(s.replace(/::?(before|after|focus-visible|empty|disabled|first-child|last-child)\b/g, '')) !== null; } catch (e) { return false; } });
        const a = snap(); sheet.disabled = true; const b = snap(); sheet.disabled = false;
        return { sheet: true, rules: sel.length, identical: a === b, elements: a.split('\n').length, matched, bodyMode: document.body.classList.contains('popup-order-mode'), popupRoot: !!document.getElementById('popupRoot'), loading: getComputedStyle(document.getElementById('loading')).display, content: getComputedStyle(document.getElementById('content')).display };
      });
      check('R_GENERAL_LINE_UNTOUCHED', g.sheet === true && g.rules > 0 && g.identical && g.matched.length === 0 && !g.bodyMode && !g.popupRoot && g.loading === 'none' && g.content !== 'none', `vp${vp[0]} ${JSON.stringify({ ...g, matched: (g.matched || []).slice(0, 5) })}`);
      const cssReq = pageObs.requests.filter((r) => /\/css\/popup-order\.css/.test(r)).length;
      check('R_GENERAL_LINE_UNTOUCHED', cssReq === 1, `vp${vp[0]} popup-order.css requests=${cssReq}`);
      // 一般頁在暫存 DB（未設定 Maps key）時，R47 既有行為是 /api/config/maps-browser-key 回 503；
      // 這是唯一允許的 bad response／console error，其餘一律視為污染。
      const badOk = pageObs.badResponses.every((x) => x === '503 /api/config/maps-browser-key?store_id=store_001') && pageObs.console.every((x) => x === 'error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)') && pageObs.console.length === pageObs.badResponses.length && pageObs.pageErrors.length === 0 && pageObs.requestFailed.length === 0;
      check('R_GENERAL_LINE_UNTOUCHED', badOk, `vp${vp[0]} general console=${JSON.stringify(pageObs.console)} bad=${JSON.stringify(pageObs.badResponses)} pe=${JSON.stringify(pageObs.pageErrors)}`);
      info.push(`general vp${vp[0]} badResponses=${JSON.stringify(pageObs.badResponses)}`);
      await shot(page, `general_line_${vp[0]}x${vp[1]}`);
      await ctx.close();
    }
  }

  // ═════ 10. server authority 未被 UI 繞過 ═════
  if (SCEN.includes('authority')) {
    observations.scenariosRun.push('authority');
    const blocked = {};
    for (const k of ['scheduled', 'closed', 'pickupActive', 'ended', 'cancelled', 'paused', 'full']) {
      const before = db.get('SELECT COUNT(*) AS c FROM orders WHERE store_id=?', ['store_001']).c;
      const r = await apiCheckout(S[k].public_code, [{ product_id: ids[0], qty: 1 }]);
      const after = db.get('SELECT COUNT(*) AS c FROM orders WHERE store_id=?', ['store_001']).c;
      blocked[k] = `${r.status}/${r.json.error}/${after - before}`;
    }
    const ok = Object.values(blocked).every((v) => /^4\d\d\/POPUP_[A-Z_]+\/0$/.test(v)) && blocked.full.includes('POPUP_SESSION_FULL');
    check('R_SERVER_AUTHORITY', ok, JSON.stringify(blocked));
    // UI 送單於額滿場次：顯示安全錯誤、不建立訂單
    const { ctx, page } = await openPage([390, 844], `/popup-order?session=${S.full.public_code}`, { clean: false });
    await settle(page);
    const before = db.get('SELECT COUNT(*) AS c FROM orders WHERE store_id=?', ['store_001']).c;
    await page.locator(`#popupRoot li[data-product-id="${ids[0]}"] [data-action="plus"]`).click();
    await page.locator('#popupRoot [data-payment-code="cash"]').click();
    await page.fill('#popupCustomerName', '額滿測試'); await page.fill('#popupCustomerPhone', '0933444555');
    await page.locator('#popupCheckoutSubmitBtn').click();
    await page.waitForFunction(() => (document.getElementById('popupCheckoutErrorRegion') || {}).textContent, { timeout: 8000 }).catch(() => {});
    const err = await page.evaluate(() => (document.getElementById('popupCheckoutErrorRegion') || {}).textContent || '');
    const after = db.get('SELECT COUNT(*) AS c FROM orders WHERE store_id=?', ['store_001']).c;
    check('R_SERVER_AUTHORITY', /上限/.test(err) && after === before, `ui full submit err=${err} delta=${after - before}`);
    await ctx.close();
  }

  // ═════ 全域：clean scenario 的 console／network ═════
  for (const pg of allPages) if (pg.clean) ['console', 'pageErrors', 'requestFailed', 'badResponses'].forEach((k) => pg.pageObs[k].forEach((x) => observations[k].push(pg.urlPath + ' :: ' + x)));
  const unknownHosts = Object.keys(observations.hosts).filter((h) => h !== `127.0.0.1:${port}`);
  check('R_CONSOLE_CLEAN', observations.console.length === 0 && observations.pageErrors.length === 0 && observations.requestFailed.length === 0 && observations.badResponses.length === 0 && unknownHosts.length === 0, JSON.stringify({ console: observations.console.slice(0, 5), pageErrors: observations.pageErrors.slice(0, 5), requestFailed: observations.requestFailed.slice(0, 5), bad: observations.badResponses.slice(0, 5), unknownHosts }));
  await browser.close();
  console.log = origLog; console.error = origErr; console.warn = origWarn;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  info.push('temp DB dir removed=' + !fs.existsSync(tmpDir));
  info.push('observer ' + JSON.stringify(observerStats));
  return { serverLines };
}

const KEY_ORDER = ['R_FIXTURE_STATES', 'R_LOADING_HIDDEN', 'R_SINGLE_UI', 'R_NO_OVERFLOW_320', 'R_LAYOUT_FIT', 'R_LAYOUT_720', 'R_TOUCH_TARGET_44', 'R_LABELS_A11Y', 'R_FORM_VERTICAL', 'R_NO_STICKY_FIXED', 'R_NO_RAW_STATUS', 'R_TEXT_ZOOM_200', 'R_HEADER_INFO', 'R_PRODUCT_CARDS', 'R_NO_EXTRA_REQUESTS', 'R_READ_ONLY_STATES', 'R_EMPTY_CART_SUBMIT_DISABLED', 'R_QTY_SUBTOTAL', 'R_E1_SUBMIT_REFRESH', 'R_STORAGE_PERSIST', 'R_CHECKOUT_TEMP_DB', 'R_LOADING_TERMINATES_VIEWS', 'R_CAMPAIGN_PICKER', 'R_ERROR_RETRY_LOADING', 'R_XSS_INERT', 'R_GENERAL_LINE_UNTOUCHED', 'R_SERVER_AUTHORITY', 'R_CONSOLE_CLEAN'];
function report(extra) {
  const keys = KEY_ORDER.filter((k) => results.has(k)).concat([...results.keys()].filter((k) => !KEY_ORDER.includes(k)));
  let p = 0, f = 0;
  for (const k of keys) { const r = results.get(k); if (r.ok) { p++; console.log(`[PASS] ${k}`); } else { f++; console.log(`[FAIL] ${k} — ${r.details.slice(0, 3).join(' | ')}`); } }
  info.forEach((x) => console.log(`[INFO] ${x}`));
  (extra && extra.serverLines || []).forEach((x) => console.log(x));
  console.log(`R48 SMOKE SUMMARY — PASS: ${p}  FAIL: ${f}  TOTAL: ${keys.length}`);
  console.log('R48_SMOKE_RESULT ' + JSON.stringify({ scenarios: observations.scenariosRun, keys: Object.fromEntries(keys.map((k) => [k, results.get(k).ok ? 'PASS' : 'FAIL'])), details: Object.fromEntries(keys.filter((k) => !results.get(k).ok).map((k) => [k, results.get(k).details.slice(0, 10)])), hosts: observations.hosts }));
  process.exitCode = f > 0 ? 1 : 0;
}
main().then((x) => { report(x); process.exit(process.exitCode); }).catch((e) => { check('R_FATAL', false, e && e.stack); report(null); process.exit(1); });
