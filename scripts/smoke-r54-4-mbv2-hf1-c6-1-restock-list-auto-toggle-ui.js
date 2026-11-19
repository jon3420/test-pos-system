#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-restock-list-auto-toggle-ui.js
// R54.4／MBV2-HF1-C6.1 補貨通知列表操作優化 —— 商品列表直接勾選「恢復販售通知」（不必開明細），
//   並清楚區分「收集登記」與「恢復販售自動通知」。同一支腳本先在未修改 C6.1（PAUSE_CLAIM_RELEASE_FIX）執行（證明缺少列表入口），
//   再在修正版與候選版全新解壓後執行。
// 測試層級：[BR] 真實 Chrome（Playwright）＋正式伺服器（node server.js）＋暫存 SQLite 檔；
//           [API] 正式路由；[DB] 直接核對資料庫檔。
// 模擬：LINE Messaging API 由 c4-line-mock（程序內攔截）；網路由 hf1c3-net-mock 計數；儲存逾時／中斷／延遲由 Playwright 攔截請求模擬。
//   這些不是 LINE 真機驗證。真實 LINE、LINE Pay、Sandbox 呼叫必須為 0。
// 分類：N＝新功能（基準應失敗）；G＝保留既有行為（基準也應通過）。
'use strict';
const fs = require('fs');
const path = require('path');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30); // 台北 10:30（與 C6 驗收相同）
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const ONLY = (process.env.C61UI_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const SHOT_DIR = process.env.C61UI_SHOT_DIR || H.tmpDir('c61ui-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const META = {};
async function step(name, cls, fn) { META[name] = { cls }; try { await fn(META[name]); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }
const ok = (cond, name, cls, detail) => assert(cond, `${name} [${cls}]`, detail);

// 測試商品（全部為測試資料）：901～910 顯示在列表；920 不在列表（LINE 未顯示且無登記），但預先參與自動通知 → 不得算入「已選擇」分子
const P = { p1: 901, p2: 902, p3: 903, p4: 904, p5: 905, p6: 906, p7: 907, p8: 908, p9: 909, p10: 910, hidden: 920 };
const NAMES = { 901: '古法冷拌麻油豬心', 902: '煙燻蒜味鳳爪', 903: '測試滷牛腱', 904: '測試椒麻雞', 905: '測試麻辣鴨血', 906: '測試蔥油餅', 907: '測試紅油抄手', 908: '測試涼拌木耳', 909: '測試醉雞', 910: '測試豆干', 920: '測試隱藏參與品' };
const PRODUCTS = Object.entries(NAMES).map(([id, name], i) => [Number(id), name, i, 'available', Number(id) === P.hidden ? { quota: 50, show_on_line: 0 } : { quota: 50 }]);
const HEAD = ['商品名稱', '商品狀態', '有效登記人數', '期望總份數', '收集登記', '恢復販售通知', '明細'];

// 攔截：先送達伺服器取得回應再扣住（或不送達、或送達後中斷），由測試決定放行時機
function installHolder(page) {
  const S = { rules: [], log: [] };
  page.on('request', (r) => { if (r.url().includes('/api/')) S.log.push({ m: r.method(), u: r.url().replace(/^https?:\/\/[^/]+/, ''), t: Date.now() }); });
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const idx = S.rules.findIndex((r) => r.method === req.method() && r.re.test(req.url()));
    if (idx < 0) return route.continue().catch(() => {});
    const rule = S.rules[idx]; if (!rule.sticky) S.rules.splice(idx, 1);
    if (rule.abortBefore) { rule.got.resolve({ url: req.url() }); await rule.gate; return route.abort('failed').catch(() => {}); }
    if (rule.fail) { rule.got.resolve({ url: req.url(), body: req.postData() }); await rule.gate; return route.fulfill({ status: rule.fail, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'TEST_ERROR', message: '測試：伺服器錯誤' }) }).catch(() => {}); }
    let resp; try { resp = await route.fetch(); } catch (e) { rule.got.reject(e); return; }
    let body = await resp.text();
    if (rule.mutate) { try { body = JSON.stringify(rule.mutate(JSON.parse(body))); } catch {} }
    rule.got.resolve({ url: req.url(), status: resp.status(), body, reqBody: req.postData() });
    await rule.gate;
    if (rule.abortAfter) return route.abort('failed').catch(() => {});
    return route.fulfill({ response: resp, body }).catch(() => {});
  });
  return {
    log: S.log,
    count: (m, re) => S.log.filter((x) => x.m === m && re.test(x.u)).length,
    hold(method, re, opts = {}) {
      let gres, gotRes, gotRej; const gate = opts.noHold ? Promise.resolve() : new Promise((r) => { gres = r; });
      const got = new Promise((a, b) => { gotRes = a; gotRej = b; });
      const rule = { method, re, gate, got: { resolve: gotRes, reject: gotRej }, ...opts };
      S.rules.push(rule);
      return { got, release: () => gres && gres(), cancel: () => { const i = S.rules.indexOf(rule); if (i >= 0) S.rules.splice(i, 1); gres && gres(); } };
    },
  };
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); let last; for (;;) { last = await fn(); if (last) return last; if (Date.now() - t0 > ms) throw new Error('until timeout ' + label); await sleep(100); } }

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 補貨通知列表操作優化（列表直接勾選恢復販售通知）驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  console.log('截圖目錄：' + SHOT_DIR);
  let browser = null, C = null;
  try {
    if (!chromium) throw new Error('playwright not installed — 此測試需要真實瀏覽器');
    browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
    const env = { __nodeArgs: ['-r', path.join(__dirname, 'lib', 'c4-test-clock.js'), '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js')], C4_CLOCK_OFFSET_MS: String(process.env.C4_CLOCK_OFFSET_MS) };
    C = await C45.boot('c61ui', { products: PRODUCTS, members: 10, settings: { restock_notify_enabled: '1' }, env,
      seed: (db) => { db.run(`UPDATE products SET restock_auto_notify=1, restock_auto_version=1 WHERE id=${P.hidden} AND store_id='store_001'`); } });
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const autoCfg = async () => (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data;
    const partIds = async () => (await autoCfg()).participating_products.map((p) => Number(p.product_id)).sort((a, b) => a - b);
    const isPart = async (pid) => (await partIds()).includes(pid);
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const evCount = async () => ((await adm('GET', '/api/product-demand-admin/restock/auto/events?limit=500')).json.data || []).length;
    const batchCount = async () => Number((await q('SELECT COUNT(*) AS n FROM restock_notify_batches WHERE store_id=?', [STORE]))[0].n);
    const prodVer = async (pid) => Number((await q('SELECT restock_auto_version AS v FROM products WHERE id=? AND store_id=?', [pid, STORE]))[0].v || 0);
    // 測試會員登記（古法冷拌麻油豬心 1 人 1 份）— 先暫停再登記，之後改回正常販售（自動通知關閉中，不建立事件）
    await adm('PATCH', `/api/products/${P.p1}/line-status`, { sale_status: 'paused' });
    const rg = await C45.pub(C.s.base, 'POST', '/api/product-demand/register', { member_session: C45.session(U(1)), product_id: P.p1, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    await adm('PATCH', `/api/products/${P.p1}/line-status`, { sale_status: 'available' });
    console.log('測試會員登記：' + (rg.json && rg.json.success ? '成功' : rg.text.slice(0, 120)));
    await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${P.p1}`, { enabled: true }); // 預先參與（伺服器既有設定）
    const base0 = { cfg: await autoCfg(), sum: (await adm('GET', '/api/product-demand-admin/summary')).json.data.config, cap: (await adm('GET', '/api/product-demand-admin/restock/capability')).json.data };
    const ev0 = await evCount(), bt0 = await batchCount(), mock0 = C.mf.calls().length;
    // 列表範圍以伺服器總表為準（種子店另有其他商品）；列表外的 920 不得計入
    const N = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.length;
    const selRe = (k, n = N) => new RegExp(`已選擇\\s*${k}\\s*／\\s*${n}\\s*項商品`);
    console.log('列表商品數：' + N);

    const errs = [];
    async function openPage(opts = {}) {
      const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 900 } });
      await ctx.addInitScript(([t]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); sessionStorage.setItem('__seeded', '1'); } }, [C.tok]);
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
      const HD = installHolder(pg);
      if (opts.before) await opts.before(pg, HD);
      await pg.goto(C.s.base + '/');
      await pg.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function' && typeof openDemandDetail === 'function', null, { timeout: 15000 });
      await pg.evaluate(() => showPage('line_products')); await sleep(600);
      await pg.evaluate(() => lpmSwitchTab('demand'));
      if (!opts.noWait) await pg.waitForSelector(`#pd-row-${P.p1}`, { timeout: 10000 });
      return { ctx, pg, HD };
    }
    const row = (pg, pid) => pg.evaluate((pid) => {
      const tr = document.getElementById('pd-row-' + pid); if (!tr) return null;
      const cb = tr.querySelector('.pd-auto'); const n = tr.querySelector('.pd-auto-note'); const col = tr.querySelector('.pd-collect');
      return { has: !!cb, checked: cb ? cb.checked : null, ind: cb ? cb.indeterminate : null, dis: cb ? cb.disabled : null, aria: cb ? cb.getAttribute('aria-disabled') : null, note: n ? n.textContent : '', collect: col ? col.checked : null, cells: tr.children.length };
    }, pid);
    const det = (pg) => pg.evaluate(() => { const cb = document.getElementById('rn-auto-product'); const n = document.getElementById('rn-auto-product-note'); return cb ? { pid: Number(cb.dataset.pid), checked: cb.checked, ind: cb.indeterminate, dis: cb.disabled, aria: cb.getAttribute('aria-disabled'), note: n ? n.textContent : '' } : null; });
    const summ = (pg) => pg.evaluate(() => (document.getElementById('pd-auto-state') || {}).innerText || '');
    const refresh = async (pg) => { await pg.evaluate(() => { pdAutoRefreshNow('test'); return null; }); await sleep(1200); };
    const clickAuto = (pg, pid) => pg.click(`#pd-row-${pid} .pd-auto`, { timeout: 4000 });
    const settled = (pg, pid, val) => until(async () => { const r = await row(pg, pid); return r && r.has && r.checked === val && r.aria !== 'true' && !/儲存中|確認中/.test(r.note) ? r : null; }, 8000, `row ${pid} settle ${val}`);
    // 頁面捲動容器（後台內容區自身捲動；找不到時使用文件捲動）
    const SCROLLER = `(() => { let e = document.getElementById('lpm-demand-wrap'); while (e && e !== document.body) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4) return e; e = e.parentElement; } return document.scrollingElement; })()`;
    const reloadDemand = async (p) => { await p.reload(); await p.waitForFunction(() => typeof lpmSwitchTab === 'function' && typeof showPage === 'function'); await p.evaluate(() => showPage('line_products')); await sleep(500); await p.evaluate(() => lpmSwitchTab('demand')); await p.waitForSelector(`#pd-row-${P.p1}`, { timeout: 10000 }); await sleep(800); };
    const shot = async (pg, name, sel) => { const f = path.join(SHOT_DIR, name); try { if (sel) await pg.locator(sel).screenshot({ path: f }); else await pg.screenshot({ path: f, fullPage: false }); } catch (e) { console.log('  （截圖失敗 ' + name + '：' + e.message.slice(0, 80) + '）'); } return f; };

    // ═══ 桌面主頁面 ═══
    const M = await openPage();
    const pg = M.pg, HD = M.HD;
    await sleep(1500);

    if (want('A')) await step('A1', 'N', async () => {
      const t = await pg.evaluate(() => ({ head: Array.from(document.querySelectorAll('#lpm-demand-wrap thead th')).map((x) => x.textContent.trim()),
        cells: Array.from(document.querySelectorAll('#lpm-demand-tbody tr[id^="pd-row-"]')).map((tr) => tr.children.length) }));
      ok(JSON.stringify(t.head) === JSON.stringify(HEAD) && t.cells.length === N && t.cells.every((n) => n === 7),
        'A1 表頭依序為「商品名稱｜商品狀態｜有效登記人數｜期望總份數｜收集登記｜恢復販售通知｜明細」，每列 7 欄', 'N', JSON.stringify(t));
    });
    if (want('A')) await step('A2', 'N', async () => {
      const r1 = await row(pg, P.p1), r2 = await row(pg, P.p2), s = await summ(pg);
      ok(r1 && r1.has && r1.checked === true && !r1.ind && r2 && r2.has && r2.checked === false && !r2.ind && selRe(1).test(s) && !/隱藏參與品/.test(s),
        'A2 伺服器既有參與（古法冷拌麻油豬心）顯示已勾選、其他未勾選；摘要「已選擇 1／N」：列表外的參與商品不計入分子', 'N', JSON.stringify({ r1, r2, s }));
      await shot(pg, 'desktop_01_list_initial.png', '#page-line_products');
    });
    if (want('A')) await step('A3', 'G', async () => {
      const now = { cfg: await autoCfg(), sum: (await adm('GET', '/api/product-demand-admin/summary')).json.data.config, cap: (await adm('GET', '/api/product-demand-admin/restock/capability')).json.data };
      const pick = (x) => JSON.stringify({ en: x.cfg.enabled, ep: x.cfg.epoch, at: x.cfg.enabled_at, part: x.cfg.participating_products.map((p) => p.product_id), send: x.cap.send_enabled, sum: x.sum });
      ok(pick(now) === pick(base0), 'A3 載入新介面不重設店家既有設定（全店自動、epoch、參與商品、總開關、登記設定都不變）', 'G', pick(now).slice(0, 300));
    });

    // ═══ B：列表直接勾選、重新整理後正確、不建立通知 ═══
    if (want('B')) await step('B1', 'N', async () => {
      const v0 = await prodVer(P.p2);
      const patches0 = HD.count('PATCH', /restock\/auto\/products\/902/);
      await clickAuto(pg, P.p2);
      const mid = await row(pg, P.p2);
      const done = await settled(pg, P.p2, true);
      const srv = await isPart(P.p2);
      ok(mid && /儲存中/.test(mid.note) && /已儲存/.test(done.note) && srv && HD.count('PATCH', /restock\/auto\/products\/902/) === patches0 + 1 && await prodVer(P.p2) === v0 + 1,
        'B1 不開明細，在列表勾選「煙燻蒜味鳳爪」：顯示「儲存中…」→「已儲存」，伺服器已參與（PATCH 1 次、參與版本 +1）', 'N', JSON.stringify({ mid, done, srv }));
      await reloadDemand(pg);
      const r = await until(async () => { const x = await row(pg, P.p2); return x && x.has && !x.ind ? x : null; }, 8000, 'B1 reload');
      ok(r.checked === true && selRe(2).test(await summ(pg)), 'B1-2 重新整理後仍為已勾選，摘要「已選擇 2／N」', 'N', JSON.stringify({ r, s: await summ(pg) }));
      await clickAuto(pg, P.p2); await settled(pg, P.p2, false);
      await reloadDemand(pg);
      const r2 = await until(async () => { const x = await row(pg, P.p2); return x && x.has && !x.ind ? x : null; }, 8000, 'B1 reload2');
      ok(r2.checked === false && !(await isPart(P.p2)), 'B1-3 取消勾選並重新整理：伺服器與畫面皆為未參與', 'N', JSON.stringify(r2));
    });
    if (want('B')) await step('B2', 'G', async () => {
      const a = await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${P.p2}`, { enabled: true });
      const b = await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${P.p2}`, { enabled: true });
      await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${P.p2}`, { enabled: false });
      ok(a.json.data.changed === true && b.json.data.changed === false && a.json.data.restock_auto_version === b.json.data.restock_auto_version,
        'B2 相同參與值重複儲存：沿用後端「版本不變」規則（changed=false、版本相同）', 'G', JSON.stringify({ a: a.json.data, b: b.json.data }));
    });
    if (want('B')) await step('B3', 'G', async () => {
      ok(await evCount() === ev0 && await batchCount() === bt0 && C.mf.calls().length === mock0,
        'B3 勾選／取消參與當下：不建立自動通知事件、預覽或批次，不呼叫（模擬）LINE', 'G', JSON.stringify({ ev: [ev0, await evCount()], bt: [bt0, await batchCount()], mock: [mock0, C.mf.calls().length] }));
    });

    // ═══ C：全店開關關閉時可預選；提示正確；開關不連帶修改商品勾選 ═══
    if (want('C')) await step('C1', 'N', async () => {
      await clickAuto(pg, P.p3); const r = await settled(pg, P.p3, true);
      await sleep(2800); await refresh(pg);
      const r2 = await row(pg, P.p3); const s = await summ(pg);
      ok(r && (await isPart(P.p3)) && r2.checked && /已選擇，待開啟自動通知/.test(r2.note) && /自動通知：關閉/.test(s) && /通知發送總開關：已開啟/.test(s),
        'C1 全店自動通知關閉時仍可預選商品：保留勾選並顯示「已選擇，待開啟自動通知」', 'N', JSON.stringify({ r2, s }));
    });
    if (want('C')) await step('C2', 'N', async () => {
      const ep0 = (await autoCfg()).epoch;
      await pg.click('#pd-set-auto'); // 確認對話框自動接受
      await until(async () => /自動通知：已開啟/.test(await summ(pg)), 8000, 'C2 auto on');
      await refresh(pg);
      const r = await row(pg, P.p3), r1 = await row(pg, P.p1), s = await summ(pg), cfg = await autoCfg();
      ok(cfg.enabled && cfg.epoch === ep0 + 1 && r.checked && r.note === '' && r1.checked && /自動通知：已開啟｜通知發送總開關：已開啟｜已選擇/.test(s) && selRe(2).test(s) && await evCount() === ev0,
        'C2 開啟全店自動通知：摘要「自動通知：已開啟｜通知發送總開關：已開啟｜已選擇 2／N 項商品」；商品勾選保留；不建立事件（只建立新基線）', 'N', JSON.stringify({ s, r, ev: await evCount() }));
      await shot(pg, 'desktop_02_auto_on_summary.png', '#page-line_products');
    });
    if (want('C')) await step('C3', 'N', async () => {
      try {
        await pg.click('#pd-set-notify');
        await until(async () => !(await autoCfg()).send_enabled, 8000, 'C3 send off'); await sleep(1500);
        const r = await row(pg, P.p3); const s = await summ(pg);
        ok(r && r.checked && /已選擇，待開啟通知發送總開關/.test(r.note) && /通知發送總開關：關閉/.test(s) && (await isPart(P.p3)), 'C3 關閉通知發送總開關：商品保留勾選，顯示「已選擇，待開啟通知發送總開關」', 'N', JSON.stringify({ r, s: s.slice(0, 80) }));
        await shot(pg, 'desktop_03_send_off_hint.png', '#page-line_products');
      } finally {
        if (!(await autoCfg()).send_enabled) { await pg.click('#pd-set-notify'); await until(async () => (await autoCfg()).send_enabled, 8000, 'C3 send on'); await sleep(1500); }
      }
    });
    if (want('C')) await step('C4', 'N', async () => {
      const cfg = (await adm('GET', '/api/product-demand-admin/summary')).json.data.config;
      await adm('PATCH', '/api/product-demand-admin/settings', { enabled: false, ttl_days: cfg.ttl_days, subscribe_mode: cfg.subscribe_mode });
      await refresh(pg);
      const r = await row(pg, P.p3), s = await summ(pg);
      await adm('PATCH', '/api/product-demand-admin/settings', { enabled: true, ttl_days: cfg.ttl_days, subscribe_mode: cfg.subscribe_mode });
      await refresh(pg);
      ok(r.checked && /已選擇，必要設定尚未完整/.test(r.note) && /必要設定尚未完整/.test(s), 'C4 必要設定不完整：保留勾選並顯示「已選擇，必要設定尚未完整」', 'N', JSON.stringify({ r, s: s.slice(0, 120) }));
    });
    if (want('C')) await step('C5', 'G', async () => {
      // 兩個全店開關分開儲存：切換其中一個不改另一個（舊有行為保留）
      const b = await autoCfg();
      await pg.click('#pd-set-auto');
      await until(async () => !(await autoCfg()).enabled, 8000, 'C5 auto off'); await sleep(1500);
      const a = await autoCfg(); const r = await row(pg, P.p3);
      ok(!a.enabled && a.send_enabled === b.send_enabled && a.participating_products.length === b.participating_products.length && (r ? r.checked !== false : true),
        'C5 關閉全店自動通知：通知發送總開關不受影響、商品參與不被清空', 'G', JSON.stringify({ send: [b.send_enabled, a.send_enabled], part: [b.participating_products.length, a.participating_products.length] }));
      const r2 = await row(pg, P.p3);
      ok(r2 && r2.checked && /已選擇，待開啟自動通知/.test(r2.note), 'C5-2 關閉後列表仍保留勾選並恢復提示「已選擇，待開啟自動通知」', 'N', JSON.stringify(r2));
    });

    // ═══ D：收集登記與參與自動通知互不連動 ═══
    if (want('D')) await step('D1', 'N', async () => {
      const colBefore = (await row(pg, P.p4)).collect;
      await pg.click(`#pd-row-${P.p4} .pd-collect`); await sleep(1500);
      const a = await isPart(P.p4); const sumRow = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.find((x) => x.product_id === P.p4);
      await clickAuto(pg, P.p4); await settled(pg, P.p4, true);
      const sumRow2 = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.find((x) => x.product_id === P.p4);
      const r = await row(pg, P.p4);
      ok(colBefore === true && a === false && sumRow.demand_collect_enabled === 0 && sumRow2.demand_collect_enabled === 0 && (await isPart(P.p4)) && r.collect === false && r.checked === true,
        'D1 收集登記與恢復販售通知分別儲存：關閉收集不改參與；勾選參與不替店家開啟收集', 'N', JSON.stringify({ colBefore, a, c1: sumRow.demand_collect_enabled, c2: sumRow2.demand_collect_enabled, r }));
      await pg.click(`#pd-row-${P.p4} .pd-collect`); await sleep(1200);
      await clickAuto(pg, P.p4); await settled(pg, P.p4, false);
    });

    // ═══ E：儲存中鎖定同商品兩個入口；其他商品可操作 ═══
    if (want('E')) await step('E1', 'N', async () => {
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p5);
      await until(async () => { const d = await det(pg); return d && d.aria != null && d.pid === P.p5 && !d.ind ? d : null; }, 8000, 'E1 detail ready');
      const re5 = /restock\/auto\/products\/905/;
      const h = HD.hold('PATCH', re5);
      await clickAuto(pg, P.p5);
      await withTimeout(h.got, 8000, 'E1 PATCH');
      const lr = await row(pg, P.p5), dr = await det(pg);
      await shot(pg, 'desktop_04_saving_locked.png', '#page-line_products');
      // 明細入口嘗試送出相反設定 → 不送出
      await pg.click('#rn-auto-product', { force: true }).catch(() => null); await sleep(500);
      const n5 = HD.count('PATCH', re5);
      // 其他商品仍可操作
      await clickAuto(pg, P.p6); const r6 = await settled(pg, P.p6, true);
      h.release();
      const lr2 = await settled(pg, P.p5, true); const dr2 = await det(pg);
      ok(lr && lr.aria === 'true' && /儲存中/.test(lr.note) && dr && dr.aria === 'true' && dr.checked === true && /儲存中/.test(dr.note),
        'E1 儲存期間：列表與明細的同商品勾選同時為忙碌（儲存中）狀態', 'N', JSON.stringify({ lr, dr }));
      ok(n5 === 1 && r6.checked && (await isPart(P.p6)), 'E1-2 儲存期間在明細點相反設定：不送出（同商品 PATCH 只有 1 次）；其他商品可正常勾選儲存', 'N', JSON.stringify({ n5, r6 }));
      ok(lr2.checked && dr2.checked && (await isPart(P.p5)), 'E1-3 放行後兩個入口一致為伺服器結果（已參與）', 'N', JSON.stringify({ lr2, dr2 }));
      await clickAuto(pg, P.p6); await settled(pg, P.p6, false);
    });

    // ═══ F：明確失敗、逾時、中斷 ═══
    if (want('F')) await step('F1', 'N', async () => {
      const re = /restock\/auto\/products\/908/;
      const h = HD.hold('PATCH', re, { fail: 500 });
      await clickAuto(pg, P.p8); await withTimeout(h.got, 8000, 'F1'); h.release();
      const r = await until(async () => { const x = await row(pg, P.p8); return x && /儲存失敗/.test(x.note) ? x : null; }, 8000, 'F1 fail note');
      await shot(pg, 'desktop_05_save_failed.png', `#pd-row-${P.p8}`);
      ok(r.checked === false && /測試：伺服器錯誤/.test(r.note) && !(await isPart(P.p8)) && HD.count('PATCH', re) === 1,
        'F1 明確儲存失敗：回復已知狀態（未勾選）並顯示原因；不自動重送', 'N', JSON.stringify(r));
    });
    if (want('F')) await step('F2', 'N', async () => {
      // 送達伺服器（已儲存）後連線中斷 → 重新讀取確認，不重送 PATCH
      const re = /restock\/auto\/products\/908/; const n0 = HD.count('PATCH', re); const v0 = await prodVer(P.p8);
      const g0 = HD.count('GET', /restock\/auto(\?|$)/);
      const h = HD.hold('PATCH', re, { abortAfter: true });
      await clickAuto(pg, P.p8); await withTimeout(h.got, 8000, 'F2'); h.release();
      const r = await until(async () => { const x = await row(pg, P.p8); return x && /已重新確認/.test(x.note) ? x : null; }, 10000, 'F2 confirm');
      ok(r.checked === true && (await isPart(P.p8)) && HD.count('PATCH', re) === n0 + 1 && await prodVer(P.p8) === v0 + 1 && HD.count('GET', /restock\/auto(\?|$)/) >= g0 + 1,
        'F2 回應中斷但伺服器已儲存：重新讀取確認後顯示已勾選（PATCH 只送 1 次、版本只 +1）', 'N', JSON.stringify({ r, patches: HD.count('PATCH', re) - n0 }));
    });
    if (want('F')) await step('F3', 'N', async () => {
      // 未送達伺服器就中斷 → 重新讀取確認：伺服器仍為已參與 → 顯示伺服器目前設定
      const re = /restock\/auto\/products\/908/; const n0 = HD.count('PATCH', re); const v0 = await prodVer(P.p8);
      const h = HD.hold('PATCH', re, { abortBefore: true });
      await clickAuto(pg, P.p8); await withTimeout(h.got, 8000, 'F3'); h.release();
      const r = await until(async () => { const x = await row(pg, P.p8); return x && /伺服器目前設定/.test(x.note) ? x : null; }, 10000, 'F3 confirm');
      ok(r.checked === true && (await isPart(P.p8)) && HD.count('PATCH', re) === n0 + 1 && await prodVer(P.p8) === v0,
        'F3 網路中斷且伺服器未儲存：重新讀取後顯示伺服器目前設定（仍參與），不自動重送', 'N', JSON.stringify({ r, patches: HD.count('PATCH', re) - n0 }));
    });
    if (want('F')) await step('F4', 'N', async () => {
      // 真正逾時（前端 15 秒）：伺服器已處理、回應遲遲未回 → 逾時後重新讀取確認，不重送
      const re = /restock\/auto\/products\/908/; const n0 = HD.count('PATCH', re);
      const h = HD.hold('PATCH', re);
      await clickAuto(pg, P.p8); await withTimeout(h.got, 8000, 'F4');
      await sleep(5000); const mid = await row(pg, P.p8);
      const r = await until(async () => { const x = await row(pg, P.p8); return x && /已重新確認|伺服器目前設定/.test(x.note) ? x : null; }, 20000, 'F4 timeout confirm');
      h.release(); await sleep(500);
      ok(mid && /儲存中/.test(mid.note) && r.checked === false && !(await isPart(P.p8)) && HD.count('PATCH', re) === n0 + 1,
        'F4 儲存逾時（15 秒）：期間顯示儲存中；逾時後重新讀取確認（已取消參與），PATCH 只送 1 次', 'N', JSON.stringify({ mid, r }));
    });

    // ═══ G：較早發出的讀取不覆蓋新的儲存結果 ═══
    if (want('G')) await step('G1', 'N', async () => {
      const h1 = HD.hold('GET', /\/api\/product-demand-admin\/snapshot/);
      await pg.evaluate(() => { pdAutoRefreshNow('test'); return null; });
      await withTimeout(h1.got, 8000, 'G1 snapshot');                // 舊讀取：伺服器已回應（P7 未參與）
      await clickAuto(pg, P.p7); await until(async () => { const x = await row(pg, P.p7); return x && /已儲存/.test(x.note) ? x : null; }, 8000, 'G1 save');
      const h2 = HD.hold('GET', /\/api\/product-demand-admin\/snapshot/); // 扣住下一次讀取，確認舊回應套用後的畫面
      h1.release(); await sleep(700);
      const r = await row(pg, P.p7); const s = await summ(pg);
      h2.release(); await sleep(1200);
      const rB = await row(pg, P.p7);
      ok(r.checked === true && rB.checked === true && (await isPart(P.p7)) && selRe(4).test(s),
        'G1 刻意延遲的舊讀取（snapshot）在儲存成功後才回來：不覆蓋勾選與摘要（已選擇 4／N）', 'N', JSON.stringify({ r, rB, s: s.slice(0, 90) }));
    });
    if (want('G')) await step('G2', 'N', async () => {
      const h1 = HD.hold('GET', /\/restock\/auto(\?|$)/);
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await withTimeout(h1.got, 8000, 'G2 GET auto');
      await clickAuto(pg, P.p7); await until(async () => { const x = await row(pg, P.p7); return x && /已儲存/.test(x.note) ? x : null; }, 8000, 'G2 save');
      h1.release(); await sleep(700);
      const r = await row(pg, P.p7);
      ok(r.checked === false && !(await isPart(P.p7)), 'G2 刻意延遲的舊讀取（GET /restock/auto）晚到：不把已取消的商品改回勾選', 'N', JSON.stringify(r));
    });

    // ═══ H：列表、明細、摘要雙向同步；切換商品後舊回應不影響新商品 ═══
    if (want('H')) await step('H1', 'N', async () => {
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p8);
      await until(async () => { const d = await det(pg); return d && d.aria != null && d.pid === P.p8 && !d.ind ? d : null; }, 8000, 'H1 detail');
      const g0 = HD.count('GET', /restock\/auto(\?|$)/), s0 = HD.count('GET', /snapshot/);
      const h = HD.hold('GET', /\/api\/product-demand-admin\/snapshot/, { sticky: true }); // 擋住所有讀取：同步必須來自儲存結果本身
      await clickAuto(pg, P.p8);
      const d1 = await until(async () => { const d = await det(pg); return d && d.checked === true && d.aria !== 'true' ? d : null; }, 8000, 'H1 list→detail');
      const sA = await summ(pg);
      await pg.click('#rn-auto-product');
      const l2 = await until(async () => { const x = await row(pg, P.p8); return x && x.checked === false && x.aria !== 'true' ? x : null; }, 8000, 'H1 detail→list');
      const sB = await summ(pg);
      h.cancel(); await sleep(300);
      ok(selRe(4).test(sA) && selRe(3).test(sB) && !(await isPart(P.p8)) && HD.count('GET', /restock\/auto(\?|$)/) === g0,
        'H1 列表勾選 → 明細立即同步；明細取消 → 列表與上方「已選擇」數量立即同步（不另送讀取）', 'N', JSON.stringify({ d1, l2, sA: sA.slice(0, 80), sB: sB.slice(0, 80), s: HD.count('GET', /snapshot/) - s0 }));
    });
    if (want('H')) await step('H2', 'N', async () => {
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p9);
      await until(async () => { const d = await det(pg); return d && d.aria != null && d.pid === P.p9 && !d.ind ? d : null; }, 8000, 'H2 detail9');
      const h = HD.hold('PATCH', /restock\/auto\/products\/909/);
      await pg.click('#rn-auto-product'); await withTimeout(h.got, 8000, 'H2 PATCH');
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p10);
      await until(async () => { const d = await det(pg); return d && d.aria != null && d.pid === P.p10 && !d.ind ? d : null; }, 8000, 'H2 detail10');
      h.release();
      const r9 = await settled(pg, P.p9, true); await sleep(400);
      const d10 = await det(pg);
      ok(d10 && d10.pid === P.p10 && d10.checked === false && !/已儲存|儲存中/.test(d10.note) && r9.checked && (await isPart(P.p9)) && !(await isPart(P.p10)),
        'H2 明細切到其他商品後，舊商品較晚回來的儲存回應：只更新舊商品的列表列，不影響新商品明細', 'N', JSON.stringify({ d10, r9 }));
      await clickAuto(pg, P.p9); await settled(pg, P.p9, false);
    });

    // ═══ I：自動更新與商品列重建後，手動通知輸入、預覽、焦點、捲動位置保留 ═══
    if (want('I')) await step('I1', 'N', async () => {
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p1);
      await until(async () => { const d = await det(pg); return d && d.aria != null && d.pid === P.p1 && !d.ind ? d : null; }, 8000, 'I1 detail');
      await sleep(1200);
      await pg.selectOption('#rn-mode', 'delivery').catch(() => null); await sleep(800);
      const dateVal = await pg.evaluate(() => { const el = document.getElementById('rn-date'); return el ? el.value : null; });
      await pg.evaluate(() => { const b = document.getElementById('rn-preview'); if (b) b.insertAdjacentHTML('beforeend', '<div id="t-preview-marker">測試預覽內容（不得被清除）</div>'); });
      await pg.evaluate(([pid, SC]) => { const cb = document.querySelector(`#pd-row-${pid} .pd-auto`); if (cb) cb.focus({ preventScroll: true }); const sc = eval(SC); sc.scrollTop = 180; }, [P.p2, SCROLLER]);
      await sleep(200);
      const before = await pg.evaluate((SC) => ({ y: eval(SC).scrollTop, mode: (document.getElementById('rn-mode') || {}).value, date: (document.getElementById('rn-date') || {}).value }), SCROLLER);
      // 列表重建：另一位管理者把測試豆干改為 LINE 不顯示（不觸發通知）→ 自動更新時商品列重建
      await adm('PATCH', `/api/products/${P.p10}/line-status`, { show_on_line: 0 });
      await pg.keyboard.press('Space'); // 鍵盤勾選焦點中的「煙燻蒜味鳳爪」
      await until(async () => { const x = await row(pg, P.p2); return x && x.checked && /已儲存/.test(x.note) ? x : null; }, 8000, 'I1 key save');
      await refresh(pg); await refresh(pg);
      const after = await pg.evaluate(([pid, SC]) => ({ y: eval(SC).scrollTop, mode: (document.getElementById('rn-mode') || {}).value, date: (document.getElementById('rn-date') || {}).value,
        marker: !!document.getElementById('t-preview-marker'), rows: document.querySelectorAll('#lpm-demand-tbody tr[id^="pd-row-"]').length,
        focus: document.activeElement && document.activeElement.classList.contains('pd-auto') ? Number(document.activeElement.dataset.pid) : (document.activeElement && document.activeElement.tagName) }), [P.p2, SCROLLER]);
      const r2 = await row(pg, P.p2); const s = await summ(pg);
      const listNow = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.map((x) => x.product_id);
      const expSel = (await partIds()).filter((id) => listNow.includes(id)).length;
      ok(before.y > 0 && after.rows === N - 1 && after.mode === 'delivery' && after.date === before.date && after.marker && Math.abs(after.y - before.y) <= 2 && after.focus === P.p2 && r2.checked && (await isPart(P.p2)) && listNow.length === N - 1 && selRe(expSel, N - 1).test(s),
        'I1 鍵盤（空白鍵）勾選＋商品列重建＋自動更新：取餐方式、日期、預覽內容、焦點與捲動位置保留；摘要分子分母都以目前列表範圍計算（N−1）', 'N', JSON.stringify({ before, after, dateVal, s: s.slice(0, 80) }));
      await shot(pg, 'desktop_06_list_detail_sync.png', '#page-line_products');
    });

    // ═══ J：切換店別／帳號、登出、離開頁面後舊回應不更新畫面 ═══
    if (want('J')) await step('J1', 'N', async () => {
      const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
      const h = HD.hold('PATCH', /restock\/auto\/products\/905/);
      await clickAuto(pg, P.p5); await withTimeout(h.got, 8000, 'J1 PATCH');
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_002', store_name: '第二店' })); if (window.currentStore) window.currentStore.store_id = 'store_002'; pdAutoRefreshNow('test'); return null; }, [tok2]);
      await sleep(1500);
      h.release(); await sleep(1500);
      const st = await pg.evaluate((pid) => ({ row: !!document.getElementById('pd-row-' + pid), saved: /已儲存/.test(document.body.innerText), part: (typeof _pdAuto !== 'undefined' && _pdAuto.ap) ? _pdAuto.ap.part[pid] : 'n/a', busy: (typeof _pdAuto !== 'undefined' && _pdAuto.ap) ? Object.keys(_pdAuto.ap.busy).length : -1 }), P.p5);
      const srv = await isPart(P.p5);
      ok(!st.row && !st.saved && st.part === undefined && st.busy === 0 && srv === false,
        'J1 儲存期間切換到其他店別／帳號：舊店的儲存回應不寫入目前畫面（伺服器已依舊店請求取消參與）', 'N', JSON.stringify({ st, srv }));
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); if (window.currentStore) window.currentStore.store_id = 'store_001'; pdAutoRefreshNow('test'); return null; }, [C.tok]);
      const back = await until(async () => { const x = await row(pg, P.p5); return x && x.has && !x.ind ? x : null; }, 8000, 'J1 back');
      ok(back.checked === false && !/儲存中/.test(back.note), 'J1-2 切回原店：以伺服器資料顯示（未參與），不殘留儲存中', 'N', JSON.stringify(back));
    });
    if (want('J')) await step('J2', 'N', async () => {
      const h = HD.hold('PATCH', /restock\/auto\/products\/903/);
      await clickAuto(pg, P.p3); await withTimeout(h.got, 8000, 'J2 PATCH');
      await pg.evaluate(() => { lpmSwitchTab('today'); return null; }); await sleep(300);
      h.release(); await sleep(1000);
      const busy = await pg.evaluate(() => (typeof _pdAuto !== 'undefined' && _pdAuto.ap) ? Object.keys(_pdAuto.ap.busy).length : -1);
      await pg.evaluate(() => { lpmSwitchTab('demand'); return null; });
      const r = await until(async () => { const x = await row(pg, P.p3); return x && x.has && !x.ind && !/儲存中/.test(x.note) ? x : null; }, 8000, 'J2 back');
      ok(busy === 0 && r.checked === false && !(await isPart(P.p3)), 'J2 儲存期間離開分頁：回應不報錯、不殘留忙碌狀態；回到分頁以伺服器資料顯示', 'N', JSON.stringify({ busy, r }));
    });
    if (want('J')) await step('J3', 'N', async () => {
      const h = HD.hold('PATCH', /restock\/auto\/products\/906/);
      await clickAuto(pg, P.p6); await withTimeout(h.got, 8000, 'J3 PATCH');
      await pg.evaluate(() => { localStorage.removeItem('pos_store_token'); pdAutoRefreshNow('test'); return null; }); await sleep(1200);
      h.release(); await sleep(1200);
      const st = await pg.evaluate((pid) => ({ row: !!document.getElementById('pd-row-' + pid), part: (typeof _pdAuto !== 'undefined' && _pdAuto.ap) ? _pdAuto.ap.part[pid] : 'n/a', saved: /已儲存/.test((document.getElementById('lpm-demand-wrap') || {}).innerText || '') }), P.p6);
      ok(!st.row && st.part === undefined && !st.saved, 'J3 儲存期間登出：舊回應不寫入畫面', 'N', JSON.stringify(st));
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); return null; }, [C.tok]);
      await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${P.p6}`, { enabled: false });
      await reloadDemand(pg); // 登出後顯示登入畫面：重新載入回到已登入狀態
    });

    // ═══ K：初次載入失敗不把已參與商品顯示為確定未參與；空清單與錯誤列 colspan ═══
    if (want('K')) await step('K1', 'N', async () => {
      const K = await openPage({ before: async (p, hd) => {
        hd.hold('GET', /\/api\/product-demand-admin\/snapshot/, { sticky: true, noHold: true, mutate: (j) => { if (j && j.data) { j.data.auto = null; j.data.auto_error = 'AUTO_CONFIG_UNAVAILABLE'; } return j; } });
        hd.hold('GET', /\/restock\/auto(\?|$)/, { sticky: true, fail: 500, noHold: true });
      } });
      await sleep(1500);
      const r1 = await row(K.pg, P.p1), s = await summ(K.pg);
      await shot(K.pg, 'desktop_07_load_failed_pending.png', '#page-line_products');
      ok(r1 && r1.has && r1.ind === true && r1.dis === true && /狀態待更新/.test(r1.note) && /狀態待更新/.test(s) && !/0\s*／\s*0/.test(s),
        'K1 參與狀態初次載入失敗：已參與商品顯示「狀態待更新」（不確定狀態），摘要不顯示 0／0', 'N', JSON.stringify({ r1, s: s.slice(0, 120) }));
      await K.ctx.close();
    });
    if (want('K')) await step('K2', 'N', async () => {
      const K = await openPage({ noWait: true, before: async (p, hd) => { hd.hold('GET', /\/api\/product-demand-admin\/snapshot/, { sticky: true, fail: 500, noHold: true }); } });
      await sleep(2500);
      const t = await K.pg.evaluate(() => { const tds = document.querySelectorAll('#lpm-demand-tbody tr td'); return { n: tds.length, cs: tds[0] && tds[0].getAttribute('colspan'), txt: tds[0] && tds[0].textContent }; });
      const s = await summ(K.pg);
      ok(t.n === 1 && t.cs === '7' && /載入失敗/.test(t.txt) && /狀態待更新/.test(s), 'K2 清單載入失敗：錯誤列 colspan＝7；摘要顯示「狀態待更新」', 'N', JSON.stringify({ t, s: s.slice(0, 120) }));
      await K.ctx.close();
      const E = await openPage({ noWait: true, before: async (p, hd) => { hd.hold('GET', /\/api\/product-demand-admin\/snapshot/, { sticky: true, noHold: true, mutate: (j) => { if (j && j.data && j.data.summary) j.data.summary.products = []; return j; } }); } });
      await sleep(2500);
      const t2 = await E.pg.evaluate(() => { const tds = document.querySelectorAll('#lpm-demand-tbody tr td'); return { n: tds.length, cs: tds[0] && tds[0].getAttribute('colspan'), txt: tds[0] && tds[0].textContent }; });
      await E.ctx.close();
      const L = await openPage({ noWait: true, before: async (p, hd) => { hd.hold('GET', /\/api\/product-demand-admin\/snapshot/, { sticky: true }); } });
      await sleep(1500);
      const t3 = await L.pg.evaluate(() => { const tds = document.querySelectorAll('#lpm-demand-tbody tr td'); return { n: tds.length, cs: tds[0] && tds[0].getAttribute('colspan'), txt: tds[0] && tds[0].textContent }; });
      await L.ctx.close();
      ok(t2.n === 1 && t2.cs === '7' && /目前沒有/.test(t2.txt) && t3.n === 1 && t3.cs === '7' && /載入中/.test(t3.txt), 'K2-2 空清單列與載入中列 colspan＝7', 'N', JSON.stringify({ t2, t3 }));
    });

    // ═══ L：同店兩個頁面並行：以重新讀取伺服器結果收斂，不自動重試 ═══
    if (want('L')) await step('L1', 'N', async () => {
      const Y = await openPage();
      await sleep(1200);
      await clickAuto(pg, P.p4); await settled(pg, P.p4, true);
      await refresh(Y.pg);
      const y1 = await row(Y.pg, P.p4);
      await clickAuto(Y.pg, P.p4); await settled(Y.pg, P.p4, false);
      await refresh(pg);
      const x1 = await row(pg, P.p4);
      ok(y1.checked === true && x1.checked === false && !(await isPart(P.p4)) && Y.HD.count('PATCH', /restock\/auto\/products/) === 1,
        'L1 同店兩個頁面：一頁的儲存經自動更新反映到另一頁；不產生額外或重試的 PATCH', 'N', JSON.stringify({ y1, x1, yPatch: Y.HD.count('PATCH', /restock\/auto\/products/) }));
      await Y.ctx.close();
    });
    if (want('L')) await step('L2', 'N', async () => {
      // 一次取得參與清單：開啟明細不另送 GET /restock/auto；自動更新不逐商品讀取
      const g0 = HD.count('GET', /restock\/auto(\?|$)/), p0 = HD.count('GET', /restock\/auto\/products/);
      for (const pid of [P.p2, P.p3, P.p4]) { await pg.evaluate((x) => { openDemandDetail(x); return null; }, pid); await sleep(700); }
      await refresh(pg); await refresh(pg);
      ok(HD.count('GET', /restock\/auto(\?|$)/) === g0 && HD.count('GET', /restock\/auto\/products/) === p0, 'L2 開啟明細與自動更新不逐商品送 GET（參與清單隨 /snapshot 一次取得）', 'N', JSON.stringify({ g: HD.count('GET', /restock\/auto(\?|$)/) - g0 }));
    });

    // ═══ N：窄螢幕可操作（橫向捲動、不壓住「查看」、文字標籤可點、鍵盤） ═══
    if (want('N')) await step('N1', 'N', async () => {
      const Nn = await openPage({ viewport: { width: 390, height: 844 } });
      const pgN = Nn.pg; await sleep(1500);
      await shot(pgN, 'narrow_01_list.png');
      const sc = await pgN.evaluate(() => { const w = document.getElementById('lpm-demand-wrap'); return { sw: w.scrollWidth, cw: w.clientWidth, ox: getComputedStyle(w).overflowX }; });
      // 文字標籤可點
      await pgN.locator(`#pd-row-${P.p5} .pd-auto-cell label`).click();
      const r5 = await settled(pgN, P.p5, true);
      // 查看按鈕：捲動後可見、未被遮住、可開啟明細
      await pgN.locator(`#pd-row-${P.p5} .pd-view`).scrollIntoViewIfNeeded();
      const hit = await pgN.evaluate((pid) => { const b = document.querySelector(`#pd-row-${pid} .pd-view`); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { top: e === b || b.contains(e), w: r.width, h: r.height }; }, P.p5);
      await shot(pgN, 'narrow_02_scrolled_view_button.png');
      await pgN.locator(`#pd-row-${P.p5} .pd-view`).click();
      await until(async () => { const d = await det(pgN); return d && d.aria != null && d.pid === P.p5 && !d.ind ? d : null; }, 8000, 'N1 detail');
      const d5 = await det(pgN);
      // 鍵盤：Tab 焦點到勾選框後按空白鍵
      await pgN.evaluate((pid) => { document.querySelector(`#pd-row-${pid} .pd-auto`).focus(); }, P.p6);
      await pgN.keyboard.press('Space');
      const r6 = await settled(pgN, P.p6, true);
      await shot(pgN, 'narrow_03_detail.png');
      ok(sc.sw > sc.cw && sc.ox === 'auto' && r5.checked && hit.top && hit.w > 20 && d5.checked === true && r6.checked && (await isPart(P.p5)) && (await isPart(P.p6)),
        'N1 窄螢幕（390px）：表格可橫向捲動；文字標籤可點選；「查看」未被遮住且可開啟明細（明細同步已勾選）；鍵盤空白鍵可勾選', 'N', JSON.stringify({ sc, r5, hit, d5, r6 }));
      await Nn.ctx.close();
      for (const pid of [P.p5, P.p6]) await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: false });
    });

    // ═══ Z：全程安全 ═══
    await step('Z1', 'G', async () => {
      ok(await evCount() === ev0 && await batchCount() === bt0 && C.mf.calls().length === mock0,
        'Z1 全程（含勾選、開關切換、逾時、中斷）未建立自動通知事件、預覽或批次，未呼叫（模擬）LINE', 'G', JSON.stringify({ ev: [ev0, await evCount()], bt: [bt0, await batchCount()], mock: [mock0, C.mf.calls().length] }));
    });
    await step('Z2', 'G', async () => { ok(C.mf.real() === 0, 'Z2 真實 LINE API 呼叫 0 次', 'G', String(C.mf.real())); });
    await step('Z3', 'G', async () => {
      const bad = errs.filter((e) => !/net::|Failed to fetch|aborted|AbortError/i.test(e));
      ok(bad.length === 0, 'Z3 全程無 JavaScript 錯誤', 'G', JSON.stringify(bad.slice(0, 3)));
    });
    await M.ctx.close();
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    try { if (C) await C.s.stop(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    const sm = H.summary();
    const out = { ...sm, classes: META, clock_offset_ms: Number(process.env.C4_CLOCK_OFFSET_MS || 0), mock_line_calls: C ? C.mf.calls().length : null, real_line_calls: C ? C.mf.real() : null, shots: SHOT_DIR };
    if (process.env.C61UI_RESULT_FILE) fs.writeFileSync(process.env.C61UI_RESULT_FILE, JSON.stringify(out, null, 2));
    console.log(`\n結果：${sm.passCount} 通過／${sm.failCount} 失敗（模擬 LINE 呼叫 ${out.mock_line_calls} 次；真實 LINE ${out.real_line_calls} 次）`);
    process.exit(sm.failCount ? 1 : 0);
  }
})();
