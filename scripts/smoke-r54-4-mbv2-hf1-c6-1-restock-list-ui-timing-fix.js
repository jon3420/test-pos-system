#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-restock-list-ui-timing-fix.js
// R54.4／MBV2-HF1-C6.1 補貨通知列表 UI 時序補修 —— 兩個已重現的前端缺口：
//   A：儲存結果不明後的確認 GET 沒有等待上限（可能一直「確認中」，busy／mutation pending 不解除）。
//   B：/snapshot 的 auto 與 GET /restock/auto（設定讀取、確認讀取）之間沒有跨來源讀取順序防護，
//      晚到的舊回應（含另一個同店用戶端造成的變化）可能蓋掉新勾選與摘要。
// 同一支腳本、同一組斷言：先在未修改的列表 UI 版（RESTOCK_LIST_AUTO_TOGGLE_UI）執行以重現，再測修正版與候選版全新解壓。
// 斷言只讀畫面與既有結構（_pdAuto.ap.busy、_pdAuto.mut.pending 皆為基準已有），不依賴修正版新增的函式。
// 測試層級：[BR] 真實 Chrome（Playwright）＋正式伺服器（node server.js）＋暫存 SQLite 檔；[API] 正式路由；[DB] 資料庫檔。
// 時序：以 Playwright 請求攔截控制回應（先送伺服器取得正式回應再扣住、未送達就中斷、永不回應、只送 headers 不送完內容）。
//   等待上限以真實計時量測；另有一項以 page.clock 受控時鐘快轉 2 分鐘。
// 模擬：LINE 由 c4-line-mock 程序內攔截。真實 LINE、LINE Pay、Sandbox 呼叫必須為 0。
// 分類：N＝本輪修正（基準應失敗）；G＝保留既有行為（基準也應通過）。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const ONLY = (process.env.C61T_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const SHOT_DIR = process.env.C61T_SHOT_DIR || H.tmpDir('c61t-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const META = {}; const TIMING = {};
async function step(name, cls, fn) { META[name] = { cls }; try { await fn(META[name]); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }
const ok = (cond, name, cls, detail) => assert(cond, `${name} [${cls}]`, detail);

const P = { p1: 901, p2: 902, p3: 903, p4: 904, p5: 905, p6: 906, p7: 907, p8: 908, p9: 909, p10: 910 };
const NAMES = { 901: '古法冷拌麻油豬心', 902: '煙燻蒜味鳳爪', 903: '測試滷牛腱', 904: '測試椒麻雞', 905: '測試麻辣鴨血', 906: '測試蔥油餅', 907: '測試紅油抄手', 908: '測試涼拌木耳', 909: '測試醉雞', 910: '測試豆干' };
const PRODUCTS = Object.entries(NAMES).map(([id, name], i) => [Number(id), name, i, 'available', { quota: 50 }]);
const RE_AUTO_GET = /\/api\/product-demand-admin\/restock\/auto(\?|$)/;
const RE_SNAP = /\/api\/product-demand-admin\/snapshot/;
const rePatch = (pid) => new RegExp(`/restock/auto/products/${pid}(\\?|$)`);

// 只送 headers、內容永遠不送完的伺服器（驗證等待上限涵蓋回應內容解析）
function stallServer() {
  const open = []; let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.write('{"success":true,"data":{"enabled":'); open.push(res); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/stall`, hits: () => hits, close: () => { open.forEach((x) => { try { x.destroy(); } catch {} }); srv.close(); } })));
}

// 攔截：fetch＝先送伺服器取得正式回應再扣住；abortBefore＝未送達就中斷；hang＝不送伺服器、永不回應（放行時可給正式 API 先前取得的舊內容）；
//       fail＝回 500；redirect＝轉到只送 headers 的伺服器；abortAfter＝送達後中斷
function installHolder(page) {
  const S = { rules: [], log: [] };
  page.on('request', (r) => { if (r.url().includes('/api/')) S.log.push({ m: r.method(), u: r.url().replace(/^https?:\/\/[^/]+/, ''), t: Date.now() }); });
  page.route('**/api/**', async (route) => {
    const req = route.request();
    const idx = S.rules.findIndex((r) => r.method === req.method() && r.re.test(req.url()));
    if (idx < 0) return route.continue().catch(() => {});
    const rule = S.rules[idx]; if (!rule.sticky) S.rules.splice(idx, 1);
    const at = Date.now(); rule.req = req;
    try {
      if (rule.redirect) { rule.got.resolve({ at, req }); return await route.continue({ url: rule.redirect }).catch(() => {}); }
      if (rule.abortBefore) { rule.got.resolve({ at, req }); await rule.gate; return await route.abort('failed').catch(() => {}); }
      if (rule.hang) { rule.got.resolve({ at, req }); await rule.gate; if (rule.late && rule.late.body) return await route.fulfill({ status: 200, contentType: 'application/json', body: rule.late.body }).catch(() => {}); return await route.abort('failed').catch(() => {}); }
      if (rule.fail) { rule.got.resolve({ at, req }); await rule.gate; return await route.fulfill({ status: rule.fail, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'TEST_ERROR', message: '測試：伺服器錯誤' }) }).catch(() => {}); }
      let resp; try { resp = await route.fetch(); } catch (e) { rule.got.reject(e); return; }
      const body = await resp.text();
      rule.got.resolve({ at, req, status: resp.status(), body });
      await rule.gate;
      if (rule.abortAfter) return await route.abort('failed').catch(() => {});
      return await route.fulfill({ response: resp, body }).catch(() => {});
    } finally { rule.done.resolve(); }
  });
  return {
    log: S.log,
    count: (m, re) => S.log.filter((x) => x.m === m && re.test(x.u)).length,
    hold(method, re, opts = {}) {
      let gres, gotRes, gotRej, dRes; const gate = new Promise((r) => { gres = r; });
      const got = new Promise((a, b) => { gotRes = a; gotRej = b; });
      const done = new Promise((r) => { dRes = r; });
      const late = {};
      const rule = { method, re, gate, got: { resolve: gotRes, reject: gotRej }, done: { resolve: dRes }, late, ...opts };
      if (opts.noHold) gres();
      S.rules.push(rule);
      return { got, done, release: (lateBody) => { if (lateBody) late.body = lateBody; gres(); }, cancel: () => { const i = S.rules.indexOf(rule); if (i >= 0) S.rules.splice(i, 1); gres(); } };
    },
  };
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);
async function until(fn, ms = 8000, label = '') { const t0 = Date.now(); let last; for (;;) { last = await fn(); if (last) return last; if (Date.now() - t0 > ms) throw new Error('until timeout ' + label); await sleep(100); } }

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 補貨通知列表 UI 時序補修 驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  let browser = null, C = null, ST = null;
  try {
    if (!chromium) throw new Error('playwright not installed — 此測試需要真實瀏覽器');
    browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
    ST = await stallServer();
    const env = { __nodeArgs: ['-r', path.join(__dirname, 'lib', 'c4-test-clock.js'), '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js')], C4_CLOCK_OFFSET_MS: String(process.env.C4_CLOCK_OFFSET_MS) };
    C = await C45.boot('c61t', { products: PRODUCTS, members: 4, settings: { restock_notify_enabled: '1' }, env });
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const autoRaw = async () => (await adm('GET', '/api/product-demand-admin/restock/auto')).text;
    const partIds = async () => JSON.parse(await autoRaw()).data.participating_products.map((p) => Number(p.product_id));
    const isPart = async (pid) => (await partIds()).includes(pid);
    const setPart = (pid, on) => adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: !!on }); // 另一個同店用戶端（正式 API）
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const evCount = async () => ((await adm('GET', '/api/product-demand-admin/restock/auto/events?limit=500')).json.data || []).length;
    const cnt = async (t) => Number((await q(`SELECT COUNT(*) AS n FROM ${t} WHERE store_id=?`, [STORE]))[0].n);
    const retryKeys = async () => Number((await q("SELECT COUNT(*) AS n FROM restock_notify_deliveries WHERE retry_key IS NOT NULL", []))[0].n);
    const prodVer = async (pid) => Number((await q('SELECT restock_auto_version AS v FROM products WHERE id=? AND store_id=?', [pid, STORE]))[0].v || 0);
    await setPart(P.p1, true);
    const N = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.length;
    const z0 = { ev: await evCount(), bt: await cnt('restock_notify_batches'), dl: await cnt('restock_notify_deliveries'), rk: await retryKeys(), mock: C.mf.calls().length };
    console.log('列表商品數：' + N + '；起始 ' + JSON.stringify(z0));

    const errs = [];
    async function openPage(opts = {}) {
      const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1400, height: 900 } });
      await ctx.addInitScript(([t]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); sessionStorage.setItem('__seeded', '1'); } }, [C.tok]);
      const pg = await ctx.newPage();
      if (opts.clock) await pg.clock.install();
      pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
      const HD = installHolder(pg);
      await pg.goto(C.s.base + '/');
      await pg.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function' && typeof openDemandDetail === 'function', null, { timeout: 15000 });
      await pg.evaluate(() => showPage('line_products')); await sleep(600);
      await pg.evaluate(() => lpmSwitchTab('demand'));
      await pg.waitForSelector(`#pd-row-${P.p1} .pd-auto`, { timeout: 10000 });
      await until(async () => { const r = await row(pg, P.p1); return r && !r.ind ? r : null; }, 10000, 'initial auto state');
      return { ctx, pg, HD };
    }
    const row = (pg, pid) => pg.evaluate((pid) => {
      const tr = document.getElementById('pd-row-' + pid); const A = (typeof _pdAuto !== 'undefined') ? _pdAuto : null;
      const busy = !!(A && A.ap && A.ap.busy[pid]); const pend = A && A.mut ? (A.mut.pending['auto:' + pid] || 0) : -1;
      if (!tr) return { missing: true, busy, pend };
      const cb = tr.querySelector('.pd-auto'); const n = tr.querySelector('.pd-auto-note');
      return { has: !!cb, checked: cb ? cb.checked : null, ind: cb ? cb.indeterminate : null, dis: cb ? cb.disabled : null, aria: cb ? cb.getAttribute('aria-disabled') : null, note: n ? n.textContent : '', busy, pend };
    }, pid);
    const summ = (pg) => pg.evaluate(() => (document.getElementById('pd-auto-state') || {}).innerText || '');
    const det = (pg) => pg.evaluate(() => { const cb = document.getElementById('rn-auto-product'); const n = document.getElementById('rn-auto-product-note'); return cb ? { pid: Number(cb.dataset.pid), checked: cb.checked, ind: cb.indeterminate, aria: cb.getAttribute('aria-disabled'), note: n ? n.textContent : '' } : null; });
    const clickAuto = (pg, pid) => pg.click(`#pd-row-${pid} .pd-auto`, { timeout: 4000 });
    // 讓已放行的回應被頁面處理完（等待該請求完成，再經過兩次事件迴圈與一個動畫影格）
    const drain = async (pg, h) => {
      const g = await withTimeout(h.got, 8000, 'drain got');
      await withTimeout(h.done, 8000, 'route done');
      const resp = await withTimeout(g.req.response().catch(() => null), 8000, 'drain response').catch(() => null);
      if (resp) await withTimeout(resp.finished().catch(() => null), 8000, 'drain finished').catch(() => null);
      for (let i = 0; i < 3; i++) await pg.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => setTimeout(r, 0)), 0)));
    };
    const refreshNow = async (pg) => { await pg.evaluate(() => { pdAutoRefreshNow('test'); return null; }); };
    const known = (pg, pid, val, ms = 8000, label = '') => until(async () => { const r = await row(pg, pid); return r && r.has && !r.ind && r.checked === val && !r.busy && r.pend === 0 && r.aria !== 'true' && !/儲存中|確認中/.test(r.note) ? r : null; }, ms, `known ${pid} ${val} ${label}`);
    const selRe = (k, n = N) => new RegExp(`已選擇\\s*${k}\\s*／\\s*${n}\\s*項商品`);
    const expSel = async () => (await partIds()).filter((id) => id >= 901 && id <= 910).length + 0;
    const shot = async (pg, name, sel) => { const f = path.join(SHOT_DIR, name); try { if (sel) await pg.locator(sel).screenshot({ path: f }); else await pg.screenshot({ path: f }); } catch (e) { console.log('  （截圖失敗 ' + name + '）'); } return f; };
    // 等待「確認流程結束」：不再是確認中，且 busy／pending 都解除（上限 limit 毫秒，真實計時）
    const confirmEnd = async (pg, pid, limit) => { const t0 = Date.now(); try { const r = await until(async () => { const x = await row(pg, pid); return x && !x.busy && x.pend === 0 && !/確認中|儲存中/.test(x.note) ? x : null; }, limit, 'confirm end ' + pid); return { r, ms: Date.now() - t0 }; } catch { return { r: await row(pg, pid), ms: null }; } };

    const M = await openPage();
    const pg = M.pg, HD = M.HD;

    // ═══ A：確認等待上限 ═══
    if (want('A')) await step('A1', 'N', async () => {
      // PATCH 已儲存但回應中斷；確認 GET 一直不回
      const pid = P.p2; const stale = await autoRaw(); const v0 = await prodVer(pid); const n0 = HD.count('PATCH', rePatch(pid));
      const hp = HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      const hs = HD.hold('GET', RE_SNAP, { sticky: true }); // 扣住背景 snapshot（取得正式回應後才放行），以觀察確認逾時當下的畫面
      await clickAuto(pg, pid);
      await withTimeout(hp.got, 8000, 'A1 patch');
      const c = await withTimeout(hc.got, 8000, 'A1 confirm GET');
      const mid = await row(pg, pid);
      const e = await confirmEnd(pg, pid, 14000); const realMs = e.ms == null ? null : Date.now() - c.at;
      TIMING.A1 = { setting_ms: 10000, measured_from_confirm_get_ms: realMs };
      const r = e.r; await shot(pg, 'a1_confirm_timeout_notice.png', `#pd-row-${pid}`);
      ok(/確認中/.test(mid.note) && e.ms != null && realMs >= 9500 && realMs <= 12500 && r.ind === true && r.checked === false && /暫時無法確認/.test(r.note),
        'A1 PATCH 已儲存但回應中斷、確認 GET 一直不回：10 秒上限內結束確認，busy／pending 解除，值保持未知並提示「暫時無法確認，將重新更新狀態」', 'N', JSON.stringify({ mid, r, realMs }));
      // A5：之後新的 snapshot 成功 → 恢復正確狀態（已參與）與操作能力
      hs.cancel(); await refreshNow(pg);
      const r2 = await known(pg, pid, true, 8000, 'A1 resolve').catch(async () => row(pg, pid));
      await shot(pg, 'a5_recovered_after_snapshot.png', `#pd-row-${pid}`);
      ok(r2 && r2.checked === true && r2.ind === false && r2.dis === false && r2.aria !== 'true' && (await isPart(pid)) && HD.count('PATCH', rePatch(pid)) === n0 + 1 && (await prodVer(pid)) === v0 + 1,
        'A1-2（A5）確認逾時後，新的 snapshot 成功：商品恢復伺服器狀態（已參與）且可操作；PATCH 只 1 次', 'N', JSON.stringify(r2));
      // A6：完成後才放行舊確認回應（正式 API 先前取得的舊內容：未參與）→ 不覆蓋
      hc.release(stale); await drain(pg, hc);
      const r3 = await row(pg, pid);
      ok(r3.checked === true && !r3.ind && !r3.busy && r3.pend === 0, 'A1-3（A6）流程完成後才放行的舊確認回應（內容為未參與）：不覆蓋新值', 'G', JSON.stringify(r3));
      await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('A')) await step('A2', 'N', async () => {
      // PATCH 未送達就中斷；確認 GET 一直不回
      const pid = P.p3; const v0 = await prodVer(pid);
      HD.hold('PATCH', rePatch(pid), { abortBefore: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      const hs = HD.hold('GET', RE_SNAP, { sticky: true });
      await clickAuto(pg, pid);
      const c = await withTimeout(hc.got, 8000, 'A2 confirm');
      const e = await confirmEnd(pg, pid, 14000); const realMs = e.ms == null ? null : Date.now() - c.at;
      TIMING.A2 = { setting_ms: 10000, measured_from_confirm_get_ms: realMs };
      ok(e.ms != null && e.r.ind === true && /暫時無法確認/.test(e.r.note), 'A2 PATCH 未送達就中斷、確認 GET 一直不回：上限內結束、值保持未知（不當成未參與）', 'N', JSON.stringify({ r: e.r, realMs }));
      hs.cancel(); await refreshNow(pg);
      const r2 = await known(pg, pid, false, 8000, 'A2 resolve').catch(async () => row(pg, pid));
      ok(r2 && r2.checked === false && !r2.ind && r2.dis === false && !(await isPart(pid)) && (await prodVer(pid)) === v0, 'A2-2 之後 snapshot 成功：顯示伺服器狀態（未參與，伺服器未儲存）並可操作', 'N', JSON.stringify(r2));
      hc.release(); await drain(pg, hc);
    });
    if (want('A')) await step('A3', 'N', async () => {
      // PATCH 達 15 秒逾時（伺服器已處理、回應不回），確認 GET 再達 10 秒逾時；之後才放行舊的 PATCH 回應與舊確認回應
      const pid = P.p4; const stale = await autoRaw(); const n0 = HD.count('PATCH', rePatch(pid));
      const hp = HD.hold('PATCH', rePatch(pid));
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      const hs = HD.hold('GET', RE_SNAP, { sticky: true });
      const t0 = Date.now();
      await clickAuto(pg, pid);
      await withTimeout(hp.got, 8000, 'A3 patch');
      const c = await withTimeout(hc.got, 20000, 'A3 confirm');
      const patchMs = c.at - t0;
      const e = await confirmEnd(pg, pid, 14000); const confirmMs = e.ms == null ? null : Date.now() - c.at;
      TIMING.A3 = { patch_setting_ms: 15000, confirm_setting_ms: 10000, measured_patch_to_confirm_ms: patchMs, measured_confirm_ms: confirmMs, total_ms: Date.now() - t0 };
      ok(patchMs >= 14500 && patchMs <= 17500 && e.ms != null && confirmMs >= 9500 && confirmMs <= 12500 && e.r.ind === true,
        'A3 PATCH 15 秒逾時後確認 GET 再 10 秒逾時：兩段上限各自生效（實測見 TIMING），busy／pending 解除，值未知', 'N', JSON.stringify({ TIMING: TIMING.A3, r: e.r }));
      hs.cancel(); await refreshNow(pg);
      await known(pg, pid, true, 8000, 'A3 resolve').catch(() => null);
      hp.release(); hc.release(stale); await drain(pg, hp); await drain(pg, hc);
      const r = await row(pg, pid);
      ok(r.checked === true && !r.ind && !r.busy && r.pend === 0 && (await isPart(pid)) && HD.count('PATCH', rePatch(pid)) === n0 + 1,
        'A3-2 之後才放行的舊 PATCH 回應與舊確認回應：不覆蓋 snapshot 取得的新值；PATCH 只 1 次', 'G', JSON.stringify(r));
      await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('A')) await step('A4', 'N', async () => {
      // 確認 GET 已回 headers，但回應內容未完成
      const pid = P.p5; const h0 = ST.hits();
      HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { redirect: ST.url });
      const hs = HD.hold('GET', RE_SNAP, { sticky: true });
      await clickAuto(pg, pid);
      const c = await withTimeout(hc.got, 8000, 'A4 confirm');
      const e = await confirmEnd(pg, pid, 14000); const realMs = e.ms == null ? null : Date.now() - c.at;
      TIMING.A4 = { setting_ms: 10000, measured_from_confirm_get_ms: realMs, headers_sent: ST.hits() > h0 };
      ok(ST.hits() > h0 && e.ms != null && realMs >= 9500 && realMs <= 12500 && e.r.ind === true && /暫時無法確認/.test(e.r.note),
        'A4 確認 GET 已收到 headers 但內容未完成：等待上限涵蓋內容解析，10 秒內結束、值未知', 'N', JSON.stringify({ r: e.r, realMs }));
      hs.cancel(); await refreshNow(pg); const r2 = await known(pg, pid, true, 8000, 'A4 resolve').catch(async () => row(pg, pid));
      ok(r2 && r2.checked === true && r2.dis === false, 'A4-2 之後 snapshot 成功：恢復已參與並可操作', 'G', JSON.stringify(r2));
      await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('A')) await step('A7', 'N', async () => {
      // 確認等待期間切換店別／帳號：舊流程上限內收尾，不污染新畫面；切回以伺服器為準
      const pid = P.p6; const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
      HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      await clickAuto(pg, pid); const c = await withTimeout(hc.got, 8000, 'A7 confirm');
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_002', store_name: '第二店' })); pdAutoRefreshNow('test'); return null; }, [tok2]);
      const end = await until(async () => { const x = await row(pg, pid); return x.pend === 0 && !x.busy ? x : null; }, 13000, 'A7 pend').catch(async () => row(pg, pid));
      const ms = Date.now() - c.at;
      hc.release(await autoRaw()); await drain(pg, hc);
      const st = await pg.evaluate((pid) => ({ row: !!document.getElementById('pd-row-' + pid), text: (document.getElementById('lpm-demand-wrap') || {}).innerText || '', part: _pdAuto.ap.part[pid] }), pid);
      ok(end.pend === 0 && !end.busy && ms <= 12500 && !st.row && !/暫時無法確認|已重新確認|已儲存/.test(st.text) && st.part === undefined,
        'A7 確認等待期間切換店別／帳號：舊流程在上限內解除 pending／busy，舊回應不寫入新身分畫面', 'N', JSON.stringify({ end, ms, st: { row: st.row, part: st.part } }));
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); pdAutoRefreshNow('test'); return null; }, [C.tok]);
      const back = await known(pg, pid, true, 8000, 'A7 back').catch(async () => row(pg, pid));
      ok(back && back.checked === true && !back.ind && (await isPart(pid)), 'A7-2 切回原店：以伺服器資料顯示（PATCH 已在伺服器完成），可操作', 'G', JSON.stringify(back));
      await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('A')) await step('A8', 'N', async () => {
      // 確認等待期間離開頁面（分頁）：上限內收尾；回來以伺服器資料顯示
      const pid = P.p7;
      HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      await clickAuto(pg, pid); await withTimeout(hc.got, 8000, 'A8 confirm');
      await pg.evaluate(() => { lpmSwitchTab('today'); return null; });
      const end = await until(async () => { const x = await row(pg, pid); return x.pend === 0 && !x.busy ? x : null; }, 13000, 'A8 pend').catch(async () => row(pg, pid));
      await pg.evaluate(() => { lpmSwitchTab('demand'); return null; });
      const back = await known(pg, pid, true, 8000, 'A8 back').catch(async () => row(pg, pid));
      hc.release(); await drain(pg, hc);
      ok(end.pend === 0 && !end.busy && back && back.checked === true && !back.ind, 'A8 確認等待期間離開分頁：上限內解除；回到分頁以伺服器資料顯示並可操作', 'N', JSON.stringify({ end, back }));
      await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('A')) await step('A9', 'N', async () => {
      // 確認等待期間登出：上限內收尾，舊回應不寫入
      const pid = P.p8;
      HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET, { hang: true });
      await clickAuto(pg, pid); await withTimeout(hc.got, 8000, 'A9 confirm');
      await pg.evaluate(() => { localStorage.removeItem('pos_store_token'); pdAutoRefreshNow('test'); return null; });
      const end = await until(async () => { const x = await row(pg, pid); return x.pend === 0 && !x.busy ? x : null; }, 13000, 'A9 pend').catch(async () => row(pg, pid));
      hc.release(await autoRaw()); await drain(pg, hc);
      const st = await pg.evaluate((pid) => ({ row: !!document.getElementById('pd-row-' + pid), part: _pdAuto.ap.part[pid] }), pid);
      ok(end.pend === 0 && !end.busy && !st.row && st.part === undefined, 'A9 確認等待期間登出：上限內解除 pending／busy，舊回應不寫入', 'N', JSON.stringify({ end, st }));
      await setPart(pid, false);
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); return null; }, [C.tok]);
      await pg.reload(); await pg.waitForFunction(() => typeof lpmSwitchTab === 'function'); await pg.evaluate(() => showPage('line_products')); await sleep(500); await pg.evaluate(() => lpmSwitchTab('demand'));
      await until(async () => { const r = await row(pg, P.p1); return r && r.has && !r.ind ? r : null; }, 10000, 'A9 reload');
    });
    if (want('A')) await step('A10', 'N', async () => {
      // 受控時鐘（page.clock）：確認 GET 不回，快轉 2 分鐘 → 不得仍為「確認中」，busy／pending 不得殘留
      const K = await openPage({ clock: true });
      const pid = P.p9;
      K.HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = K.HD.hold('GET', RE_AUTO_GET, { hang: true });
      const hs = K.HD.hold('GET', RE_SNAP, { sticky: true });
      await clickAuto(K.pg, pid); await withTimeout(hc.got, 8000, 'A10 confirm');
      await K.pg.clock.runFor(120000);
      await K.pg.evaluate(() => new Promise((r) => setTimeout(r, 0)));
      const r = await row(K.pg, pid);
      ok(!/確認中/.test(r.note) && !r.busy && r.pend === 0 && r.ind === true, 'A10 受控時鐘快轉 2 分鐘：不再「確認中」、busy 與 pending 已解除、值保持未知', 'N', JSON.stringify(r));
      hs.cancel(); hc.release(); await K.ctx.close();
      await setPart(pid, false);
    });

    // ═══ B：跨來源讀取順序 ═══
    if (want('B')) await step('B1', 'N', async () => {
      // 舊設定 GET（內容：未參與）晚到，不能蓋掉新的 snapshot（另一個同店用戶端已改為參與；本頁沒有本地 mutation）
      const pid = P.p4; await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false, 8000, 'pre');
      const h = HD.hold('GET', RE_AUTO_GET);
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await withTimeout(h.got, 8000, 'B1 GET');
      await setPart(pid, true);
      await refreshNow(pg); await known(pg, pid, true, 8000, 'B1 snapshot');
      h.release(); await drain(pg, h);
      const r = await row(pg, pid), s = await summ(pg), k = await expSel();
      ok(r.checked === true && !r.ind && selRe(k).test(s), 'B1 舊設定 GET（未參與）晚到：不蓋掉較新的 snapshot（已參與）；摘要一致', 'N', JSON.stringify({ r, s: s.slice(0, 80), k }));
    });
    if (want('B')) await step('B1-2', 'N', async () => {
      // 取消方向（前置：伺服器與畫面皆為已參與）
      const pid = P.p4; await setPart(pid, true); await refreshNow(pg); await known(pg, pid, true, 8000, 'pre');
      const h = HD.hold('GET', RE_AUTO_GET);
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await withTimeout(h.got, 8000, 'B1-2 GET');
      await setPart(pid, false);
      await refreshNow(pg); await known(pg, pid, false, 8000, 'B1-2 snapshot');
      h.release(); await drain(pg, h);
      const r = await row(pg, pid), s = await summ(pg), k = await expSel();
      ok(r.checked === false && !r.ind && selRe(k).test(s), 'B1-2 取消方向：舊設定 GET（已參與）晚到，不蓋掉較新的 snapshot（未參與）', 'N', JSON.stringify({ r, s: s.slice(0, 80), k }));
    });
    if (want('B')) await step('B2', 'N', async () => {
      // 舊 snapshot（未參與）晚到，不能蓋掉新的設定 GET（已參與）
      const pid = P.p5; await setPart(pid, false); await refreshNow(pg); await known(pg, pid, false, 8000, 'pre');
      const h = HD.hold('GET', RE_SNAP);
      await refreshNow(pg); await withTimeout(h.got, 8000, 'B2 snap');
      await setPart(pid, true);
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await known(pg, pid, true, 8000, 'B2 GET');
      h.release(); await drain(pg, h);
      const r = await row(pg, pid), s = await summ(pg), k = await expSel();
      ok(r.checked === true && !r.ind && selRe(k).test(s), 'B2 舊 snapshot（未參與）晚到：不蓋掉較新的設定 GET（已參與）', 'N', JSON.stringify({ r, s: s.slice(0, 80), k }));
    });
    if (want('B')) await step('B2-2', 'N', async () => {
      const pid = P.p5; await setPart(pid, true); await refreshNow(pg); await known(pg, pid, true, 8000, 'pre');
      const h = HD.hold('GET', RE_SNAP);
      await refreshNow(pg); await withTimeout(h.got, 8000, 'B2-2 snap');
      await setPart(pid, false);
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await known(pg, pid, false, 8000, 'B2-2 GET');
      h.release(); await drain(pg, h);
      const r = await row(pg, pid), s = await summ(pg), k = await expSel();
      ok(r.checked === false && !r.ind && selRe(k).test(s), 'B2-2 取消方向：舊 snapshot（已參與）晚到，不蓋掉較新的設定 GET（未參與）', 'N', JSON.stringify({ r, s: s.slice(0, 80), k }));
      await refreshNow(pg); await known(pg, pid, false).catch(() => null);
    });
    if (want('B')) await step('B3', 'G', async () => {
      // 舊確認 GET 晚到：本頁儲存中斷 → 確認 GET（扣住，內容為儲存後的已參與）；另一用戶端改為未參與；較新的 snapshot 顯示未參與
      //   確認 GET 在上限內放行（內容較舊）→ 不蓋掉較新的 snapshot
      const pid = P.p9;
      HD.hold('PATCH', rePatch(pid), { abortAfter: true, noHold: true });
      const hc = HD.hold('GET', RE_AUTO_GET);
      await clickAuto(pg, pid); await withTimeout(hc.got, 8000, 'B3 confirm');
      await setPart(pid, false);
      const r0 = await row(pg, pid);
      await refreshNow(pg); await sleep(1200);           // snapshot 在 busy 期間完成：本商品不套用
      const r1 = await row(pg, pid);
      hc.release(); await drain(pg, hc);
      await until(async () => { const x = await row(pg, pid); return !x.busy && x.pend === 0 ? x : null; }, 8000, 'B3 end');
      await refreshNow(pg);
      const r2 = await known(pg, pid, false, 8000, 'B3 final').catch(async () => row(pg, pid));
      ok(r0.busy && r1.busy && r1.pend > 0 && r2 && r2.checked === false && !r2.ind && !(await isPart(pid)),
        'B3 商品儲存中、確認 GET 與背景 snapshot 同時進行：snapshot 不誤解鎖；確認結束後收斂到伺服器現況（另一用戶端已取消）', 'G', JSON.stringify({ r0, r1, r2 }));
    });
    if (want('B')) await step('B4', 'N', async () => {
      // 舊失敗回應晚到：舊 snapshot 失敗（500）晚於較新的設定 GET 成功 → 不把新成功資料標成失敗
      const h = HD.hold('GET', RE_SNAP, { fail: 500 });
      await refreshNow(pg); await withTimeout(h.got, 8000, 'B4 snap');
      await pg.evaluate(() => { rnAutoLoad(); return null; });
      await until(async () => !/狀態待更新/.test(await summ(pg)), 5000, 'B4 pre').catch(() => null);
      h.release(); await drain(pg, h);
      const s = await summ(pg), r = await row(pg, P.p1);
      ok(!/狀態待更新/.test(s) && /已選擇\s*\d+\s*／/.test(s) && r.checked === true && !/狀態待更新/.test(r.note), 'B4 舊 snapshot 失敗晚於較新的設定 GET 成功：摘要與商品不被改回「狀態待更新」', 'N', JSON.stringify({ s: s.slice(0, 100), r }));
      await refreshNow(pg); await sleep(800);
    });
    if (want('B')) await step('B4-2', 'G', async () => {
      // 舊設定 GET 失敗（500）晚於較新的 snapshot 成功
      const h = HD.hold('GET', RE_AUTO_GET, { fail: 500 });
      await pg.evaluate(() => { rnAutoLoad(); return null; }); await withTimeout(h.got, 8000, 'B4-2 GET');
      await refreshNow(pg); await sleep(1200);
      h.release(); await drain(pg, h);
      const s = await summ(pg);
      ok(!/狀態待更新/.test(s) && /已選擇\s*\d+\s*／/.test(s), 'B4-2 舊設定 GET 失敗晚於較新的 snapshot 成功：摘要不被標成待更新', 'G', s.slice(0, 100));
    });
    if (want('B')) await step('B5', 'G', async () => {
      // 較新的讀取失敗：保留最後成功資料並顯示待更新；不顯示 0／0、不取消勾選
      const h = HD.hold('GET', RE_SNAP, { fail: 500, noHold: true });
      await refreshNow(pg);
      await until(async () => /狀態待更新/.test(await summ(pg)), 8000, 'B5 stale').catch(() => null);
      const s = await summ(pg), r = await row(pg, P.p1);
      await shot(pg, 'b5_newer_read_failed_keep_last.png', '#page-line_products');
      ok(/狀態待更新/.test(s) && !/0\s*／\s*0/.test(s) && r.checked === true && !r.ind, 'B5 較新的讀取失敗：摘要「狀態待更新」，已參與商品仍保留最後成功的勾選', 'G', JSON.stringify({ s: s.slice(0, 100), r }));
      void h; await refreshNow(pg); await until(async () => !/狀態待更新/.test(await summ(pg)), 8000, 'B5 recover').catch(() => null);
    });
    if (want('B')) await step('B6', 'G', async () => {
      // 換店／帳號後，舊讀取（設定 GET、snapshot）不更新新身分的列表、明細或摘要
      const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, P.p1); await sleep(800);
      const hg = HD.hold('GET', RE_AUTO_GET);
      await pg.evaluate(() => { rnAutoLoad(); return null; }); await withTimeout(hg.got, 8000, 'B6 GET');
      const hs = HD.hold('GET', RE_SNAP);
      await refreshNow(pg); await withTimeout(hs.got, 8000, 'B6 snap');
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_002', store_name: '第二店' })); return null; }, [tok2]);
      await pg.evaluate(() => { _pdClearDisplay('owner'); return null; });
      hg.release(); hs.release(); await drain(pg, hg); await drain(pg, hs);
      const st = await pg.evaluate(() => ({ rows: document.querySelectorAll('#lpm-demand-tbody tr[id^="pd-row-"]').length, det: !!document.getElementById('rn-auto-product'), s: (document.getElementById('pd-auto-state') || {}).innerText || '' }));
      ok(st.rows === 0 && !st.det && !/已選擇\s*\d/.test(st.s), 'B6 換店／帳號後，舊設定 GET 與舊 snapshot 不寫入新身分的列表、明細與摘要', 'G', JSON.stringify(st));
      await pg.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); pdAutoRefreshNow('test'); return null; }, [C.tok]);
      await until(async () => { const r = await row(pg, P.p1); return r && r.has && !r.ind ? r : null; }, 10000, 'B6 back');
    });

    // ═══ G：保留既有行為（列表直接勾選、同步） ═══
    if (want('G')) await step('G1', 'G', async () => {
      const pid = P.p10;
      await clickAuto(pg, pid); const r = await known(pg, pid, true, 8000, 'G1');
      await pg.evaluate((pid) => { openDemandDetail(pid); return null; }, pid);
      const d = await until(async () => { const x = await det(pg); return x && x.pid === pid && !x.ind ? x : null; }, 8000, 'G1 det');
      await pg.click('#rn-auto-product'); const r2 = await known(pg, pid, false, 8000, 'G1 back');
      await shot(pg, 'g1_normal_operation.png', '#page-line_products');
      ok(r.checked && d.checked && !r2.checked && !(await isPart(pid)), 'G1 列表直接勾選、明細同步、明細取消後列表同步（既有行為保留）', 'G', JSON.stringify({ r, d, r2 }));
    });

    // ═══ Z：安全 ═══
    await step('Z1', 'G', async () => {
      const z1 = { ev: await evCount(), bt: await cnt('restock_notify_batches'), dl: await cnt('restock_notify_deliveries'), rk: await retryKeys(), mock: C.mf.calls().length };
      ok(JSON.stringify(z1) === JSON.stringify(z0), 'Z1 全程未因 UI 確認增加事件、批次、逐筆紀錄、retry key 或（模擬）LINE 發送', 'G', JSON.stringify({ z0, z1 }));
    });
    await step('Z2', 'G', async () => {
      const multi = [P.p2, P.p3, P.p4, P.p5, P.p6, P.p7, P.p8, P.p9].map((pid) => ({ pid, n: HD.count('PATCH', rePatch(pid)) }));
      const used = multi.filter((x) => x.n > 0);
      ok(used.length > 0 && used.every((x) => x.n === 1), 'Z2 每次中斷／逾時／確認流程中 PATCH 都只送 1 次（不自動重送）', 'G', JSON.stringify(multi));
    });
    await step('Z3', 'G', async () => { ok(C.mf.real() === 0, 'Z3 真實 LINE API 呼叫 0 次', 'G', String(C.mf.real())); });
    await step('Z4', 'G', async () => { const bad = errs.filter((e) => !/net::|Failed to fetch|aborted|AbortError/i.test(e)); ok(bad.length === 0, 'Z4 全程無 JavaScript 錯誤', 'G', JSON.stringify(bad.slice(0, 3))); });
    await M.ctx.close();
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    try { if (C) await C.s.stop(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    try { if (ST) ST.close(); } catch {}
    const sm = H.summary();
    const out = { ...sm, classes: META, timing: TIMING, clock_offset_ms: Number(process.env.C4_CLOCK_OFFSET_MS || 0), mock_line_calls: C ? C.mf.calls().length : null, real_line_calls: C ? C.mf.real() : null, shots: SHOT_DIR };
    if (process.env.C61T_RESULT_FILE) fs.writeFileSync(process.env.C61T_RESULT_FILE, JSON.stringify(out, null, 2));
    console.log('TIMING ' + JSON.stringify(TIMING));
    console.log(`\n結果：${sm.passCount} 通過／${sm.failCount} 失敗（模擬 LINE 呼叫 ${out.mock_line_calls} 次；真實 LINE ${out.real_line_calls} 次）`);
    process.exit(sm.failCount ? 1 : 0);
  }
})();
