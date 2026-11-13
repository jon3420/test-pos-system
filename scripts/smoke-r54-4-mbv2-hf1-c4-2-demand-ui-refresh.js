#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js
// R54.4／MBV2-HF1-C4.2 —— 真實伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）：
//   P：顧客點餐頁補貨登記入口（公開設定與會員資料分開更新、首屏不跳動、身分確認後才顯示本人資料、
//      LIFF 卡住／失敗、未登入／已登入／登入過期、功能與商品收集開關、既有登記管理、文案與通知承諾）
//   A：後台 LINE 商品管理 → 補貨登記分頁自動更新（10 秒、可見性、離開停止、不累積 timer、不重疊、
//      舊回應不覆蓋新設定／新商品、輸入與展開狀態保留、網路失敗、登出／換店、只讀）
// 同一支測試先在未修改的 C4.1 執行（重現現況），再於 C4.2 執行。
// 安全：暫存資料庫、本機埠；LINE API 由 hf1c3-net-mock 在伺服器子程序內攔截並計數；LIFF SDK 由
// Playwright 攔截（保持 pending／失敗／測試替身）。模擬 LIFF 與模擬 API 不是 LINE 真機驗證。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('playwright not installed — 此測試需要真實瀏覽器，無法執行（未以其他方式代替）');
  process.exit(2);
}
const ONLY = process.env.C42_ONLY || ''; // p,a（預設全部）
const run = (k) => !ONLY || ONLY.split(',').includes(k);
const STORE = 'store_001';
const PID = 701, PNAME = '測試招牌飯';      // 暫停販售 → 可新增登記
const PID2 = 702, PNAME2 = '測試對照湯';    // 正常販售
const PID3 = 706, PNAME3 = '測試第二暫停品'; // 暫停販售（第二款）
const MOCK = path.join(__dirname, 'lib', 'hf1c3-net-mock.js');
const PUSH_FILE = path.join(H.tmpDir('c42-push'), 'line-calls.txt');
fs.writeFileSync(PUSH_FILE, '');
const lineCalls = () => fs.readFileSync(PUSH_FILE, 'utf8').split('\n').filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function twDate(offsetDays = 0) { return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10); }
let MS; try { MS = require(path.join(H.ROOT, 'utils', 'lineMemberSession.js')); } catch { MS = null; }
const session = (store, uid) => MS.createMemberSession({ store_id: store, line_user_id: uid });
const UA = 'Uc42aaaaaaaaaaaaaaaaaaaaaaaaaa01', UB = 'Uc42bbbbbbbbbbbbbbbbbbbbbbbbbb02', UC = 'Uc42cccccccccccccccccccccccccc03', UD = 'Uc42dddddddddddddddddddddddddd04';

function seedLine(db, extra = {}) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql(`INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001',?,?)`, [k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1');
  set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0');
  set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654');
  set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout');
  for (const [k, v] of Object.entries(extra.settings || {})) set(k, v);
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_quota_low_threshold: 'INTEGER DEFAULT 2', line_quota_high_threshold: 'INTEGER DEFAULT 10',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_preorder_low_threshold: 'INTEGER DEFAULT 2', line_preorder_high_threshold: 'INTEGER DEFAULT 10',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1',
    shipping_enabled: 'INTEGER DEFAULT 0', shipping_share_line_stock: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const ins = (id, name, sort) => runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
        line_quota_enabled,line_quota_daily,line_quota_sold,line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_takeout_enabled,line_delivery_enabled)
       VALUES (?,?,?,?,?,?,1,1,'available',?, 1,10,0, 1,20,0, 1,1)`, [id, STORE, name, '飯類', 101, 150, sort]);
  ins(PID, PNAME, 0); ins(PID2, PNAME2, 1); ins(PID3, PNAME3, 2);
}
async function bootServer(dir, opts = {}) {
  const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedLine(db, opts); if (opts.extraSeed) opts.extraSeed(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf, srvEnv(opts));
  const tok = await H.login(s.base, STORE, 'pw001');
  return { s, dbf, tok, dir, opts };
}
const srvEnv = (opts) => ({ __nodeArgs: ['-r', MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', HF1C3_PUSH_COUNT_FILE: PUSH_FILE, ...((opts && opts.env) || {}) });
async function safeStop(srv) { const p = srv && srv.proc; if (p && p.exitCode == null && p.signalCode == null) await srv.stop(); }
async function restart(ctx, mutate) {
  await safeStop(ctx.s);
  if (mutate) { const db = await H.openDbFile(ctx.dbf); mutate(db); H.saveDbFile(db, ctx.dbf); db.close(); }
  ctx.s = ctx.port ? await startFixed(ctx.dbf, ctx.port, srvEnv(ctx.opts)) : await H.startServer(ctx.dbf, srvEnv(ctx.opts));
  ctx.tok = await H.login(ctx.s.base, STORE, 'pw001');
}
// 後台頁面持續開著時重啟伺服器：沿用同一個埠（harness 的 startServer 每次換新埠）
async function startFixed(dbPath, port, extraEnv) {
  const { spawn } = require('child_process');
  const env = { ...process.env, POS_DB_PATH: dbPath, MIGRATION_TMP_DIR: path.join(path.dirname(dbPath), 'uploads'), ...extraEnv, PORT: String(port) };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, [...(extraEnv.__nodeArgs || []), 'server.js'], { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => { log = (log + d).slice(-100000); }); proc.stderr.on('data', (d) => { log = (log + d).slice(-100000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {}
    if (proc.exitCode != null) throw new Error('server exited: ' + log.slice(-3000));
    await sleep(150);
  }
  return { proc, base, port, getLog: () => log, dbPath,
    stop: () => new Promise((resolve) => { if (proc.exitCode != null) return resolve(); proc.once('exit', () => resolve()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}
async function patchProduct(ctx, body, pid = PID) {
  const r = await H.api(ctx.s.base, ctx.tok, 'PATCH', `/api/products/${pid}/line-settings`, body);
  if (!r.json || !r.json.success) throw new Error('patch failed ' + r.text.slice(0, 200));
}
async function pub(ctx, method, p, body, store = STORE) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${ctx.s.base}${p}${sep}store_id=${store}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const reg = (ctx, uid, pid, qty, extra = {}) => pub(ctx, 'POST', '/api/product-demand/register', { member_session: session(STORE, uid), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra });
const cancelReg = (ctx, uid, pid) => pub(ctx, 'POST', '/api/product-demand/cancel', { member_session: session(STORE, uid), product_id: pid });
async function liveCounters(ctx) {
  const r = await H.api(ctx.s.base, ctx.tok, 'GET', '/api/products/line-products/list');
  const p = (r.json && r.json.data || []).find((x) => Number(x.id) === PID) || {};
  const o = await H.api(ctx.s.base, ctx.tok, 'GET', '/api/line-orders/online?limit=500');
  const orders = o.json && (o.json.data || o.json.orders) || [];
  return { quota_sold: Number(p.line_quota_sold || 0), preorder_sold: Number(p.line_preorder_sold || 0), orders: Array.isArray(orders) ? orders.length : -1 };
}
const FAKE_LIFF = `window.liff={init:async()=>{},ready:Promise.resolve(),isLoggedIn:()=>true,isInClient:()=>true,
  getIDToken:()=>'fake.id.token',getAccessToken:()=>'fake-access-token',getProfile:async()=>({userId:'Ufakeprofile',displayName:'Fake'}),
  getFriendship:async()=>({friendFlag:true}),requestFriendship:async()=>({}),login:()=>{},logout:()=>{},openWindow:()=>{},
  getOS:()=>'web',getLanguage:()=>'zh-TW',getContext:()=>({}),isApiAvailable:()=>true};`;
const LIFF_SETTINGS = { line_member_liff_id: '2000000000-c42test', line_member_gate_enabled: '1', line_member_gate_mode: 'checkout' };
const SKEY = 'line_member_session_store_001';
const sessVal = (tok) => JSON.stringify({ member_session: tok, display_name: '測試會員', is_friend: true, expires_at: Date.now() + 3600e3 });

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C4.2 補貨登記入口首屏、後台自動更新、文案 驗收 ══════════');
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const ctxs = [];
  const shots = H.tmpDir('c42-shots');
  try {
    // ═════════════════ P：顧客點餐頁 ═════════════════
    if (run('p')) {
      const C = await bootServer(H.tmpDir('c42-p'), {}); ctxs.push(C);
      await patchProduct(C, { sale_status: 'paused' }, PID);
      await patchProduct(C, { sale_status: 'paused' }, PID3);
      const rA = await reg(C, UA, PID, 2);
      if (!rA.json || !rA.json.success) throw new Error('seed reg A ' + rA.text.slice(0, 200));
      const c0 = await liveCounters(C);
      const pushP0 = lineCalls();
      // 開啟點餐頁：每 40ms 取樣入口文字、入口列／商品卡高度、頁首入口
      async function openP({ member = null, cfgDelay = 0, mineDelay = 0, mineFail = '', sdk = null, query = '', onMine = null } = {}) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([sk, sv, pid]) => {
          if (!sessionStorage.getItem('__seeded')) { if (sv) localStorage.setItem(sk, sv); sessionStorage.setItem('__seeded', '1'); }
          window.__samples = []; window.__t0 = performance.now(); window.__pdOpens = 0;
          const sample = () => {
            const c = document.getElementById('content');
            const vis = !!(c && getComputedStyle(c).display !== 'none' && document.querySelector('.prod-card'));
            const card = document.getElementById('pc-' + pid); const row = document.getElementById('dr-' + pid);
            const btn = row ? row.querySelector('button.demand-btn') : null;
            const hb = document.getElementById('myDemandsBtn');
            const hbVis = !!(hb && getComputedStyle(hb).display !== 'none' && getComputedStyle(hb).visibility !== 'hidden');
            window.__samples.push({ t: Math.round(performance.now() - window.__t0), vis, btn: btn ? btn.textContent : null,
              rowTxt: row ? row.textContent : null, rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
              cardH: card ? Math.round(card.getBoundingClientRect().height) : null, hb: hbVis ? hb.textContent : null,
              hbY: hbVis ? Math.round(hb.getBoundingClientRect().top + window.scrollY) : null });
          };
          setInterval(sample, 40);
          document.addEventListener('DOMContentLoaded', () => {
            let was = false;
            new MutationObserver(() => { const ov = document.getElementById('demandOverlay'); const now = !!(ov && ov.classList.contains('show')); if (now && !was) window.__pdOpens++; was = now; })
              .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
          });
        }, [SKEY, member || '', PID]);
        const page = await context.newPage();
        const st = { errors: [], held: null, mineCalls: 0, cfgCalls: 0, posts: [] };
        if (sdk) await page.route('https://static.line-scdn.net/**', async (route) => {
          if (sdk === 'fail') return route.abort('failed');
          if (sdk === 'fake') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF });
          st.held = route;
        });
        await page.route('**/api/product-demand/config**', async (route) => { st.cfgCalls++; if (cfgDelay) await sleep(cfgDelay); route.continue().catch(() => {}); });
        await page.route('**/api/product-demand/mine**', async (route) => {
          st.mineCalls++;
          if (onMine) await onMine(st.mineCalls, page);
          if (mineDelay) await sleep(mineDelay);
          if (mineFail === 'abort') return route.abort('failed').catch(() => {});
          if (mineFail === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"message":"x"}' }).catch(() => {});
          route.continue().catch(() => {});
        });
        page.on('pageerror', (e) => st.errors.push(e.message));
        page.on('request', (r) => { if (r.method() !== 'GET' && !/analytics|line-member|cart-recovery|link-context/.test(r.url())) st.posts.push(r.method() + ' ' + r.url().replace(C.s.base, '')); });
        await page.goto(`${C.s.base}/line-order.html?store_id=store_001${query}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__samples.some((s) => s.vis), null, { timeout: 15000 }).catch(() => {});
        st.release = async () => { if (st.held) { const r = st.held; st.held = null; await r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF }); } };
        return { context, page, st };
      }
      const samples = (page) => page.evaluate(() => window.__samples);
      const firstVis = (S) => (S.find((s) => s.vis) || {}).t;
      const firstWhen = (S, f) => { const s = S.find((x) => x.vis && f(x)); return s ? s.t : null; };
      const visRange = (S, key) => { const v = S.filter((s) => s.vis && s[key] != null).map((s) => s[key]); return v.length ? Math.max(...v) - Math.min(...v) : null; };
      const isReg = (t) => /^已登記 \d+ 份・管理登記$/.test(t || '');
      const anyBtn = (s) => !!s.btn;
      const genBtn = (s) => s.btn === '補貨登記' || s.btn === '🔔 補貨通知我';

      // P2 公開設定延遲 1.5 秒（未登入）：首屏先保留中性位置，設定就緒後才顯示入口；商品卡高度不跳動
      { const L = await openP({ cfgDelay: 1500 }); await sleep(2800);
        const S = await samples(L.page); const fv = firstVis(S);
        const early = S.filter((s) => s.vis && s.t < fv + 600);
        const earlyNoBtn = early.length > 0 && early.every((s) => !s.btn);
        const earlyReserved = early.length > 0 && early.every((s) => s.rowH != null && s.rowH >= 24);
        const last = S[S.length - 1];
        assert(earlyNoBtn, 'P2-1 公開設定未就緒：不先顯示可點的登記入口（不假定已開啟收集）', JSON.stringify(early.slice(0, 3)));
        assert(earlyReserved, 'P2-2 公開設定未就緒：首屏已保留入口高度（中性載入狀態）', JSON.stringify(early.slice(0, 3)));
        assert(last.btn === '補貨登記', 'P2-3 設定就緒（通知未啟用）：入口顯示「補貨登記」', JSON.stringify(last));
        const dH = visRange(S, 'cardH');
        assert(dH != null && dH <= 2, 'P2-4 入口出現前後商品卡高度不跳動（≤2px）', JSON.stringify({ dH, first: early[0], last }));
        assert(last.hb == null, 'P2-5 未登入：不顯示頁首「我的補貨登記」', JSON.stringify(last));
        await L.context.close(); }
      // P3 本人登記 API 延遲 2.5 秒（Gate 不需 LIFF）：一般入口先出現，本人資料稍後局部更新，卡片與頁首不跳動
      { const L = await openP({ member: sessVal(session(STORE, UA)), mineDelay: 2500 }); await sleep(800);
        await clickIf(L.page, `#pc-${PID2} .add-btn`); await sleep(200);
        const cartN = await L.page.evaluate((id) => (cart[id] ? cart[id].qty : 0), PID2);
        await sleep(3000);
        const S = await samples(L.page); const fv = firstVis(S);
        const fg = firstWhen(S, genBtn); const fr = firstWhen(S, (s) => isReg(s.btn));
        assert(fg != null && fg - fv <= 800, 'P3-1 本人登記查詢延遲：一般入口「補貨登記」在首屏 0.8 秒內出現', JSON.stringify({ fv, fg }));
        assert(fr != null && fr - fv >= 1800 && S[S.length - 1].btn === '已登記 2 份・管理登記', 'P3-2 本人登記取得後才補上「已登記 2 份・管理登記」', JSON.stringify({ fv, fr, last: S[S.length - 1] }));
        const preReg = S.filter((s) => s.vis && fr != null && s.t < fr);
        assert(preReg.every((s) => !isReg(s.btn)), 'P3-3 本人資料取得前不顯示任何本人份數', '');
        const dH = visRange(S, 'cardH');
        assert(dH != null && dH <= 2, 'P3-4 一般入口→已登記入口：商品卡高度不跳動（≤2px）', JSON.stringify({ dH }));
        const hbS = S.filter((s) => s.vis);
        const hbFirst = hbS.find((s) => s.hb != null);
        assert(hbFirst && hbFirst.t - fv <= 800 && hbS.filter((s) => s.t >= hbFirst.t).every((s) => s.hb != null && s.hbY === hbFirst.hbY) && /📋 我的補貨登記/.test(S[S.length - 1].hb || ''),
          'P3-5 頁首「📋 我的補貨登記」首屏即有穩定位置，不因等待本人資料而跳動', JSON.stringify({ fv, hbFirst, last: S[S.length - 1] }));
        assert(cartN === 1 && L.st.errors.length === 0, 'P3-6 本人資料載入中仍可正常加入購物車、無 JavaScript 錯誤', JSON.stringify({ cartN, e: L.st.errors }));
        await L.context.close(); }
      // P4 本人登記 API 失敗：一般入口可用、不顯示本人資料、不誤稱「沒有登記」
      { const L = await openP({ member: sessVal(session(STORE, UA)), mineFail: '500' }); await sleep(2000);
        const S = await samples(L.page); const last = S[S.length - 1];
        assert(genBtn(last) && !S.some((s) => isReg(s.btn)), 'P4-1 本人登記 API 失敗：保留一般入口，不顯示本人份數', JSON.stringify(last));
        await clickIf(L.page, '#myDemandsBtn'); await sleep(1500);
        const txt = await L.page.evaluate(() => (document.getElementById('demandPanel') || {}).innerText || '');
        assert(/暫時無法/.test(txt) && !/目前沒有有效/.test(txt), 'P4-2 失敗時開啟「我的補貨登記」顯示暫時無法取得，不誤稱沒有登記', txt.slice(0, 200));
        assert(L.st.errors.length === 0, 'P4-3 無 JavaScript 錯誤', L.st.errors.join(' | '));
        await L.context.close(); }
      // P5 身分切換：A 的本人查詢尚未回應時，本機 session 改為 B → A 的資料不得顯示給 B
      { const L = await openP({ member: sessVal(session(STORE, UA)), mineDelay: 1500,
          onMine: async (n, page) => { if (n === 1) { await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SKEY, sessVal(session(STORE, UB))]); } } });
        await sleep(4500);
        const S = await samples(L.page); const last = S[S.length - 1];
        const shownA = S.some((s) => s.btn === '已登記 2 份・管理登記');
        assert(!shownA && genBtn(last), 'P5 本人查詢期間身分改變：不把上一位會員（2 份）的登記顯示給目前會員', JSON.stringify({ shownA, last, calls: L.st.mineCalls }));
        await L.context.close(); }
      // P6 需 LIFF 設定：重開伺服器帶 LIFF 設定（SDK 由 Playwright 攔截）
      // P7 LIFF SDK 載入失敗：入口正常、無錯誤
      await restart(C, (db) => { for (const [k, v] of Object.entries(LIFF_SETTINGS)) db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, v]); });
      { const L = await openP({ member: sessVal(session(STORE, UA)), sdk: 'fail' }); await sleep(2500);
        const S = await samples(L.page); const fv = firstVis(S); const fb = firstWhen(S, anyBtn);
        assert(fb != null && fb - fv <= 1200 && L.st.errors.length === 0, 'P7 LIFF SDK 載入失敗：入口於首屏 1.2 秒內出現、無 JavaScript 錯誤', JSON.stringify({ fv, fb, e: L.st.errors }));
        await L.context.close(); }
      // P1 LIFF 設定啟用、SDK 卡住（會員 Gate pending）＋已存 session：一般入口不等 Gate
      { const L = await openP({ member: sessVal(session(STORE, UA)), sdk: 'hold' }); await sleep(2500);
        const S = await samples(L.page); const fv = firstVis(S); const fb = firstWhen(S, anyBtn);
        assert(fv != null && fb != null && fb - fv <= 1200, 'P1-1 LIFF SDK 卡住、會員 Gate 未完成：商品卡補貨登記入口在首屏後 1.2 秒內出現（不等待 Gate）', JSON.stringify({ fv, fb, last: S[S.length - 1] }));
        const last = S[S.length - 1];
        assert(isReg(last.btn) && last.btn === '已登記 2 份・管理登記', 'P1-2 不需重建身分的頁面：本人 session 經伺服器驗證後，以局部更新補上「已登記 2 份・管理登記」', JSON.stringify(last));
        await clickIf(L.page, `#pc-${PID2} .add-btn`); await sleep(300);
        const cartN = await L.page.evaluate((id) => (cart[id] ? cart[id].qty : 0), PID2);
        assert(cartN === 1 && L.st.errors.length === 0, 'P1-3 Gate 卡住時一般點餐（加入購物車）可用、無 JavaScript 錯誤', JSON.stringify({ cartN, e: L.st.errors }));
        await L.st.release(); await sleep(2500);
        const S2 = await samples(L.page); const l2 = S2[S2.length - 1];
        assert(l2.btn === '已登記 2 份・管理登記' && L.st.errors.length === 0, 'P1-4 Gate 晚完成：本人入口維持正確（2 份）、不重建、無錯誤', JSON.stringify({ l2, e: L.st.errors }));
        await L.context.close(); }
      { const L = await openP({ member: sessVal(session(STORE, UA)), sdk: 'hold', query: '&recovery_token=rt-c42-test' }); await sleep(1500);
        const pre = (await samples(L.page)).some((s) => isReg(s.btn));
        await L.st.release(); await sleep(3500);
        const S = await samples(L.page); const last = S[S.length - 1];
        assert(!pre && last.btn === '已登記 2 份・管理登記', 'P6 Recovery 頁（需重建身分）＋SDK 卡住：一般入口可用；Gate 完成前不顯示本人份數，完成後才以局部更新補上', JSON.stringify({ pre, last }));
        await L.context.close(); }
      await restart(C, (db) => { for (const k of Object.keys(LIFF_SETTINGS)) db.run('DELETE FROM settings WHERE store_id=? AND key=?', [STORE, k]); });
      // P9 未登入：一般入口、點擊沿用登入流程；不顯示頁首入口
      { const L = await openP({}); await sleep(1500);
        const S = await samples(L.page); const last = S[S.length - 1];
        await clickIf(L.page, `#dr-${PID} button.demand-btn`); await sleep(500);
        const ui = await L.page.evaluate(() => ({ open: !!document.getElementById('demandOverlay')?.classList.contains('show'), login: !!document.getElementById('dmLoginBtn'), txt: (document.getElementById('demandPanel') || {}).innerText || '' }));
        assert(last.btn === '補貨登記' && last.hb == null && ui.open && ui.login && !/已登記/.test(ui.txt), 'P9 未登入：入口「補貨登記」，點擊開啟表單並要求 LINE 登入；不顯示本人資料與頁首入口', JSON.stringify({ last, ui: { ...ui, txt: ui.txt.slice(0, 120) } }));
        await L.context.close(); }
      // P10 登入過期（session 簽章無效 → 後端 401）：不顯示本人資料；點擊顯示重新登入
      { const L = await openP({ member: sessVal('invalid.session.token') }); await sleep(2000);
        const S = await samples(L.page); const last = S[S.length - 1];
        await clickIf(L.page, `#dr-${PID} button.demand-btn`); await sleep(500);
        const txt = await L.page.evaluate(() => (document.getElementById('demandPanel') || {}).innerText || '');
        assert(genBtn(last) && !S.some((s) => isReg(s.btn)) && /過期/.test(txt) && /重新以 LINE 登入/.test(txt), 'P10 登入過期：不顯示本人份數，點擊入口顯示重新登入', JSON.stringify({ last, txt: txt.slice(0, 120) }));
        await L.context.close(); }
      // P11 文案（通知未啟用）：入口、說明、送出、免責，無訂閱承諾
      { const L = await openP({ member: sessVal(session(STORE, UB)) }); await sleep(1500);
        await clickIf(L.page, `#dr-${PID} button.demand-btn`); await sleep(500);
        const ui = await L.page.evaluate(() => ({ desc: Array.from(document.querySelectorAll('#demandPanel .dm-desc')).map((e) => e.textContent), consent: !!document.getElementById('dmConsent'),
          submit: (document.getElementById('dmSubmit') || {}).textContent, disc: (document.getElementById('dmDisclaimer') || {}).textContent, txt: document.getElementById('demandPanel').innerText,
          hb: (document.getElementById('myDemandsBtn') || {}).textContent, btn: (document.querySelector('#dr-' + 706 + ' button.demand-btn') || {}).textContent }));
        const disc = ui.disc || '';
        assert(ui.desc[0] === '留下想買的份數，讓我們安排備貨。目前僅提供補貨登記，不會發送 LINE 通知。' && !ui.consent && ui.submit === '送出補貨登記' && ui.btn === '補貨登記' && ui.hb === '📋 我的補貨登記',
          'P11-1 通知未啟用：入口「補貨登記」、說明、無通知勾選、「送出補貨登記」、頁首「📋 我的補貨登記」', JSON.stringify(ui));
        assert(/不代表訂單成立/.test(disc) && /不保留商品/.test(disc) && /補貨時間尚未確定/.test(disc) && /實際供應以下單時為準/.test(disc), 'P11-2 保留：登記不代表訂單成立、不保留商品、補貨時間尚未確定、實際供應以下單時為準', disc);
        assert(!/補貨通知我|立即通知|已訂閱|訂閱通知/.test(ui.txt), 'P11-3 通知未啟用時沒有訂閱或「立即通知」承諾', ui.txt.slice(0, 300));
        await L.page.click('#dmSubmit'); await sleep(1200);
        const after = await L.page.evaluate(() => ({ toast: (document.getElementById('toast') || {}).textContent || '', btn: (document.querySelector('#dr-701 button.demand-btn') || {}).textContent }));
        assert(/已收到你的補貨登記/.test(after.toast) && after.btn === '已登記 1 份・管理登記', 'P11-4 送出補貨登記：提示正確，商品卡局部更新為「已登記 1 份・管理登記」', JSON.stringify(after));
        await clickIf(L.page, `#dr-${PID} button.demand-btn`); await sleep(500);
        const mg = await L.page.evaluate(() => ({ cancel: (document.getElementById('dmCancel') || {}).textContent, revoke: !!document.getElementById('dmRevoke') }));
        assert(mg.cancel === '取消補貨登記' && !mg.revoke, 'P11-5 管理登記：「取消補貨登記」；未同意者不顯示撤回通知', JSON.stringify(mg));
        await L.page.click('#dmCancel'); await sleep(1000);
        const ac = await L.page.evaluate(() => ({ toast: (document.getElementById('toast') || {}).textContent || '', btn: (document.querySelector('#dr-701 button.demand-btn') || {}).textContent }));
        assert(/已取消補貨登記/.test(ac.toast) && ac.btn === '補貨登記', 'P11-6 取消補貨登記：提示正確，入口回到「補貨登記」', JSON.stringify(ac));
        await L.context.close(); }
      // P12 功能關閉：既有登記仍可管理、取消；不顯示新增入口
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: false });
      { const L = await openP({ member: sessVal(session(STORE, UA)) }); await sleep(1800);
        const st = await L.page.evaluate(() => ({ a: (document.querySelector('#dr-701 button.demand-btn') || {}).textContent || null, b: (document.querySelector('#dr-706 button.demand-btn') || {}).textContent || null,
          bRow: (document.getElementById('dr-706') || {}).textContent || '', hb: getComputedStyle(document.getElementById('myDemandsBtn')).display }));
        assert(st.a === '已登記 2 份・管理登記' && st.b === null && !st.bRow.trim() && st.hb !== 'none', 'P12-1 功能關閉：本人既有登記仍顯示「已登記 2 份・管理登記」與頁首入口；其他商品無新增入口', JSON.stringify(st));
        await clickIf(L.page, '#dr-701 button.demand-btn'); await sleep(500);
        const ui = await L.page.evaluate(() => ({ cancel: (document.getElementById('dmCancel') || {}).textContent, submit: !!document.getElementById('dmSubmit') }));
        assert(ui.cancel === '取消補貨登記' && !ui.submit, 'P12-2 功能關閉：管理畫面只能取消（「取消補貨登記」），不能修改', JSON.stringify(ui));
        await L.context.close(); }
      { const L = await openP({}); await sleep(1500);
        const S = await samples(L.page);
        assert(!S.some((s) => s.btn), 'P12-3 功能關閉＋未登入：不顯示新增登記入口', JSON.stringify(S[S.length - 1]));
        await L.context.close(); }
      await H.api(C.s.base, C.tok, 'PATCH', '/api/product-demand-admin/settings', { enabled: true });
      // P13 商品收集關閉：該商品不顯示入口，也不顯示載入佔位
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID3}/collect`, { enabled: false });
      { const L = await openP({ cfgDelay: 1200 }); await sleep(2000);
        const r = await L.page.evaluate(() => ({ t: (document.getElementById('dr-706') || {}).textContent, h: Math.round((document.getElementById('dr-706') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height), btn: !!document.querySelector('#dr-706 button') }));
        assert(r.btn === false && r.h === 0, 'P13 商品關閉收集：該商品沒有入口也沒有佔位', JSON.stringify(r));
        await L.context.close(); }
      await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID3}/collect`, { enabled: true });
      // P14 通知可用（測試資料庫內設定；LINE 呼叫由伺服器模擬層攔截）：依實際能力顯示訂閱文案
      await restart(C, (db) => { for (const [k, v] of [['line_channel_token', 'test-token-not-real'], ['line_member_liff_id', '2000000000-c42n'], ['restock_notify_enabled', '1']]) db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, v]); });
      { const L = await openP({ member: sessVal(session(STORE, UC)), sdk: 'fail' }); await sleep(1800);
        const b = await L.page.evaluate(() => (document.querySelector('#dr-701 button.demand-btn') || {}).textContent);
        await clickIf(L.page, '#dr-701 button.demand-btn'); await sleep(500);
        const u1 = await L.page.evaluate(() => ({ checked: (document.getElementById('dmConsent') || {}).checked, submit: (document.getElementById('dmSubmit') || {}).textContent, sub: !!document.getElementById('dmSubscribed'), txt: document.getElementById('demandPanel').innerText }));
        await L.page.click('#dmConsent'); await sleep(100);
        const s2 = await L.page.evaluate(() => (document.getElementById('dmSubmit') || {}).textContent);
        assert(b === '🔔 補貨通知我' && u1.checked === false && u1.submit === '送出補貨登記' && !u1.sub && s2 === '登記並訂閱通知' && !/立即通知/.test(u1.txt),
          'P14-1 通知可用：入口「🔔 補貨通知我」、勾選預設不勾、未勾「送出補貨登記」、勾選後「登記並訂閱通知」、無「立即通知」', JSON.stringify({ b, u1: { ...u1, txt: undefined }, s2 }));
        await L.page.click('#dmSubmit'); await sleep(1200);
        await clickIf(L.page, '#dr-701 button.demand-btn'); await sleep(500);
        const u2 = await L.page.evaluate(() => ({ sub: (document.getElementById('dmSubscribed') || {}).textContent, revoke: (document.getElementById('dmRevoke') || {}).textContent, cancel: (document.getElementById('dmCancel') || {}).textContent }));
        assert(/已訂閱補貨通知/.test(u2.sub || '') && u2.revoke === '取消補貨通知（保留補貨登記）' && u2.cancel === '取消補貨登記', 'P14-2 明確同意後：顯示「已訂閱補貨通知」、「取消補貨通知（保留補貨登記）」、「取消補貨登記」', JSON.stringify(u2));
        await L.page.click('#dmRevoke'); await sleep(800);
        const u3 = await L.page.evaluate(() => ({ sub: !!document.getElementById('dmSubscribed'), consent: !!document.getElementById('dmConsent'), checked: (document.getElementById('dmConsent') || {}).checked, msg: (document.getElementById('dmMsg') || {}).textContent }));
        assert(!u3.sub && u3.consent && u3.checked === false && /補貨登記仍保留/.test(u3.msg || ''), 'P14-3 僅撤回通知：不再顯示已訂閱、勾選回到未勾、提示補貨登記仍保留', JSON.stringify(u3));
        await L.context.close(); }
      { const L = await openP({ member: sessVal(session(STORE, UA)), sdk: 'fail' }); await sleep(1800);
        await clickIf(L.page, '#dr-701 button.demand-btn'); await sleep(500);
        const u = await L.page.evaluate(() => ({ sub: !!document.getElementById('dmSubscribed'), checked: (document.getElementById('dmConsent') || {}).checked, submit: (document.getElementById('dmSubmit') || {}).textContent }));
        assert(!u.sub && u.checked === false && u.submit === '送出補貨登記', 'P14-4 只有登記、沒有同意的會員：不顯示已訂閱，勾選預設不勾', JSON.stringify(u));
        await L.context.close(); }
      await restart(C, (db) => { for (const k of ['line_channel_token', 'line_member_liff_id', 'restock_notify_enabled']) db.run('DELETE FROM settings WHERE store_id=? AND key=?', [STORE, k]); });
      const c1 = await liveCounters(C);
      assert(JSON.stringify(c0) === JSON.stringify(c1), 'P15 顧客端驗收：未建立訂單、未改額度', JSON.stringify({ c0, c1 }));
      assert(lineCalls() === pushP0, 'P16 顧客端驗收：LINE API 呼叫 0 次', String(lineCalls() - pushP0));
      await safeStop(C.s);
    }

    // ═════════════════ A：後台補貨登記分頁自動更新 ═════════════════
    if (run('a')) {
      const SUP = twDate(1);
      const C = await bootServer(H.tmpDir('c42-a'), {
        extraSeed: (db) => {
          db.run("UPDATE products SET sale_status='paused' WHERE id IN (701,706) AND store_id='store_001'");
        },
      }); ctxs.push(C);
      C.port = new URL(C.s.base).port;
      await reg(C, UA, PID, 3); await reg(C, UB, PID3, 2);
      // 已完成批次（含一筆 LINE 已受理紀錄）：展開批次明細用；直接寫入暫存資料庫，不經發送流程
      await restart(C, (db) => {
        const rq = H.q1(db, 'SELECT request_uuid FROM product_demand_requests WHERE line_user_id=? AND product_id=?', [UA, PID]);
        db.run(`INSERT INTO restock_notify_batches (batch_uuid,store_id,product_id,product_name_snapshot,fulfillment_mode,supply_date,notice_kind,message_text,link_url,message_hash,status,candidate_count,confirmed_at,completed_at)
                VALUES ('c42-batch-1',?,?,?,'takeout',?,'restock','測試訊息','https://example.invalid/x','h','completed',1,datetime('now'),datetime('now'))`, [STORE, PID, PNAME, SUP]);
        db.run(`INSERT INTO restock_notify_deliveries (delivery_uuid,batch_uuid,store_id,product_id,request_uuid,line_user_id,status,attempt_count,max_attempts,accepted_at,first_attempt_at)
                VALUES ('c42-d-1','c42-batch-1',?,?,?,?,'accepted',1,4,datetime('now'),datetime('now'))`, [STORE, PID, rq.request_uuid, UA]);
      });
      const c0 = await liveCounters(C); const push0 = lineCalls();
      const tok2 = await H.login(C.s.base, 'store_002', 'pw002').catch(() => '');
      const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await actx.addInitScript(([t]) => {
        if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); sessionStorage.setItem('__seeded', '1'); }
        window.__toasts = [];
        const hook = () => { if (typeof window.showToast === 'function' && !window.showToast.__c42) { const o = window.showToast; const w = function (m, t) { window.__toasts.push([String(m), t]); return o.apply(this, arguments); }; w.__c42 = true; window.showToast = w; } };
        document.addEventListener('DOMContentLoaded', () => { hook(); setInterval(hook, 200); });
      }, [C.tok]);
      const ap = await actx.newPage();
      const A = { errs: [], dialogs: 0, reqs: [], inflight: 0, maxInflight: 0, writes: [], delay: null, abortAll: false, delayLog: [] };
      ap.on('pageerror', (e) => A.errs.push(e.message)); ap.on('dialog', (d) => { A.dialogs++; d.accept(); });
      const isPoll = (u) => /\/api\/product-demand-admin\/(snapshot|summary|products\/\d+$|products\/\d+\?|restock\/batches|restock\/capability)/.test(u.replace(/\?.*$/, (m) => m));
      ap.on('request', (r) => {
        const u = r.url();
        if (!u.includes('/api/')) return;
        if (r.method() !== 'GET') A.writes.push({ t: Date.now(), m: r.method(), u: u.replace(C.s.base, '') });
        else if (isPoll(u)) { A.reqs.push({ t: Date.now(), u: u.replace(C.s.base, '') }); }
      });
      const done = (r) => { if (r.method() === 'GET' && isPoll(r.url())) A.inflight = Math.max(0, A.inflight - 1); };
      ap.on('requestfinished', done); ap.on('requestfailed', done);
      ap.on('request', (r) => { if (r.method() === 'GET' && isPoll(r.url())) { A.inflight++; A.maxInflight = Math.max(A.maxInflight, A.inflight); } });
      await ap.route('**/api/product-demand-admin/**', async (route) => {
        const req = route.request();
        if (req.method() === 'GET') {
          if (A.abortAll) return route.abort('failed').catch(() => {});
          if (A.delay && A.delay.match(req.url())) {
            const ms = A.delay.ms; if (A.delay.once) A.delay = null;
            // 先讓伺服器讀取（取得「當下」資料），再延遲交付回應 → 模擬較早發出、較晚回來的 GET
            let resp = null; try { resp = await route.fetch(); } catch (e) { A.delayLog.push('fetch-err ' + e.message.slice(0, 80)); return route.abort('failed').catch(() => {}); }
            await sleep(ms);
            A.delayLog.push('late ' + req.url().replace(C.s.base, ''));
            return route.fulfill({ response: resp }).catch((e) => { A.delayLog.push('fulfill-err ' + e.message.slice(0, 80)); });
          }
        }
        route.continue().catch(() => {});
      });
      const reqsSince = (t0) => A.reqs.filter((r) => r.t >= t0);
      const writesSince = (t0) => A.writes.filter((w) => w.t >= t0);
      // 只觸發、不等待（page.evaluate 會等待回傳的 Promise，否則「較晚回來的回應」情境無法重疊）
      const refreshNow = () => ap.evaluate(() => { (typeof window.pdAutoRefreshNow === 'function' ? window.pdAutoRefreshNow('test') : loadDemandAdminTab()); return null; });
      const openDetail = (id) => ap.evaluate((x) => { openDemandDetail(x); return null; }, id);
      const rowOf = (pid) => ap.evaluate((id) => { const r = document.getElementById('pd-row-' + id); return r ? { users: r.querySelector('.pd-users').textContent, qty: r.querySelector('.pd-qty').textContent, collect: r.querySelector('.pd-collect').checked, status: r.querySelector('.pd-status').textContent } : null; }, pid);
      const detailOf = () => ap.evaluate(() => {
        const box = document.getElementById('lpm-demand-detail'); if (!box || getComputedStyle(box).display === 'none') return null;
        const head = (box.querySelector('strong') || {}).textContent || '';
        const rows = Array.from(box.querySelectorAll('#pd-detail-table tbody tr')).map((tr) => tr.innerText.replace(/\s+/g, ' '));
        return { head, rows, pid: (document.getElementById('rn-panel') || {}).dataset ? document.getElementById('rn-panel').dataset.pid : null };
      });
      const lastUpd = () => ap.evaluate(() => { const e = document.getElementById('pd-last-updated'); return e ? e.textContent : null; });
      const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(250); } return null; };
      const setHidden = (hidden) => ap.evaluate((h) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        document.dispatchEvent(new Event('visibilitychange'));
        if (!h) window.dispatchEvent(new Event('focus'));
      }, hidden);

      await ap.goto(C.s.base + '/');
      await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function');
      await ap.evaluate(() => showPage('line_products')); await sleep(800);
      // A1 進入分頁立即讀取
      let t0 = Date.now();
      await ap.evaluate(() => lpmSwitchTab('demand'));
      const firstReqMs = await waitFor(async () => reqsSince(t0).length > 0, 3000);
      await ap.waitForSelector(`#pd-row-${PID}`, { timeout: 8000 }).catch(() => {});
      const r0 = await rowOf(PID);
      assert(firstReqMs != null && firstReqMs < 1500 && r0 && r0.users === '1' && r0.qty === '3', 'A1 進入補貨登記分頁立即讀取（有效 1 人、3 份）', JSON.stringify({ firstReqMs, r0 }));
      const tabTxt = await ap.evaluate(() => ({ tab: document.getElementById('lpm-tab-demand').textContent.trim(), en: (document.getElementById('pd-set-enabled') || {}).parentNode.textContent.trim(), ns: document.getElementById('pd-notify-state').textContent }));
      assert(/補貨登記/.test(tabTxt.tab) && !/想買/.test(tabTxt.tab) && /補貨登記/.test(tabTxt.en) && !/我想買/.test(tabTxt.en) && /補貨登記/.test(tabTxt.ns) && !/想買/.test(tabTxt.ns), 'A2 後台分頁、入口設定說明與通知狀態改用「補貨登記」用語', JSON.stringify(tabTxt));
      // 展開明細
      await openDetail(PID); await sleep(1200);
      const d0 = await detailOf();
      assert(d0 && /有效登記 1 人、期望 3 份/.test(d0.head), 'A3 展開商品明細（1 人、3 份）', JSON.stringify(d0));
      const lu0 = await lastUpd();
      assert(lu0 && /最後更新/.test(lu0) && /\d{1,2}:\d{2}:\d{2}/.test(lu0) && /台北/.test(lu0), 'A4 顯示台北時間「最後更新時間」', String(lu0));
      // A5 顧客新增 → 下一輪（≤10 秒＋網路）總表與展開明細一起更新
      const tw = Date.now();
      await reg(C, UC, PID, 4);
      const ms5 = await waitFor(async () => { const r = await rowOf(PID); const d = await detailOf(); return r && r.users === '2' && r.qty === '7' && d && /有效登記 2 人、期望 7 份/.test(d.head); }, 13000);
      assert(ms5 != null, 'A5 顧客新增登記：下一輪自動更新內總表與展開明細一致更新（2 人、7 份）', JSON.stringify({ ms5, r: await rowOf(PID), d: await detailOf() }));
      // A6 顧客修改份數
      await reg(C, UC, PID, 6);
      const ms6 = await waitFor(async () => { const r = await rowOf(PID); const d = await detailOf(); return r && r.qty === '9' && d && /期望 9 份/.test(d.head); }, 13000);
      assert(ms6 != null, 'A6 顧客修改份數：總表與明細一起更新（9 份）', JSON.stringify({ ms6, r: await rowOf(PID) }));
      // A7 顧客取消
      await cancelReg(C, UC, PID);
      const ms7 = await waitFor(async () => { const r = await rowOf(PID); const d = await detailOf(); return r && r.users === '1' && r.qty === '3' && d && /有效登記 1 人、期望 3 份/.test(d.head) && d.rows.some((x) => /已取消/.test(x)); }, 13000);
      assert(ms7 != null, 'A7 顧客取消登記：統計排除已取消，明細標示已取消（1 人、3 份）', JSON.stringify({ ms7, r: await rowOf(PID), d: await detailOf() }));
      const pollWrites = writesSince(tw);
      assert(pollWrites.length === 0, 'A8 自動更新期間只發出讀取請求（無 POST／PATCH／DELETE）', JSON.stringify(pollWrites));
      // A9 間隔：約 10 秒一次
      const t9 = Date.now(); await sleep(21500);
      const n9 = reqsSince(t9).map((r) => r.t);
      const rounds9 = n9.filter((t, i) => i === 0 || t - n9[i - 1] > 1500).length;
      assert(rounds9 >= 2 && rounds9 <= 3, 'A9 停留分頁且可見：約每 10 秒更新一次（21.5 秒內 2～3 輪）', JSON.stringify({ rounds9, n: n9.length }));
      // A10 隱藏瀏覽器 → 停止；恢復可見 → 立即更新
      await setHidden(true); await sleep(300);
      const t10 = Date.now(); await sleep(14000);
      const hiddenReqs = reqsSince(t10).length;
      const t10b = Date.now(); await setHidden(false);
      const visMs = await waitFor(async () => reqsSince(t10b).length > 0, 3000);
      assert(hiddenReqs === 0, 'A10-1 頁面隱藏時停止輪詢（14 秒 0 次）', String(hiddenReqs));
      assert(visMs != null && visMs < 1500, 'A10-2 恢復可見時立即更新', String(visMs));
      // A11 切到其他分頁 → 停止；重新進入 → 立即更新；離開 LINE 商品管理頁 → 停止
      await sleep(1500);
      await ap.evaluate(() => lpmSwitchTab('today'));
      const t11 = Date.now(); await sleep(12500);
      const otherTab = reqsSince(t11).length;
      const t11b = Date.now(); await ap.evaluate(() => lpmSwitchTab('demand'));
      const backMs = await waitFor(async () => reqsSince(t11b).length > 0, 3000);
      await sleep(1500);
      await ap.evaluate(() => showPage('orders'));
      const t11c = Date.now(); await sleep(12500);
      const otherPage = reqsSince(t11c).filter((r) => /product-demand-admin/.test(r.u)).length;
      assert(otherTab === 0 && otherPage === 0, 'A11-1 切到其他分頁或離開 LINE 商品管理頁：停止輪詢', JSON.stringify({ otherTab, otherPage }));
      assert(backMs != null && backMs < 1500, 'A11-2 重新進入分頁立即更新', String(backMs));
      // A12 多次進出不累積 timer
      await ap.evaluate(() => showPage('line_products')); await sleep(600);
      for (let i = 0; i < 6; i++) { await ap.evaluate(() => lpmSwitchTab('today')); await sleep(80); await ap.evaluate(() => lpmSwitchTab('demand')); await sleep(80); await setHidden(true); await setHidden(false); }
      await sleep(2500);
      const t12 = Date.now(); await sleep(21000);
      const n12 = reqsSince(t12).map((r) => r.t);
      const rounds12 = n12.filter((t, i) => i === 0 || t - n12[i - 1] > 1500).length;
      const dbg12 = await ap.evaluate(() => (typeof window.pdAutoState === 'function' ? window.pdAutoState() : null));
      assert(rounds12 >= 1 && rounds12 <= 3 && (!dbg12 || dbg12.listeners === 1), 'A12 多次進出／切換可見性後仍只有一組 timer（21 秒內 ≤3 輪）、事件監聽器只有一組', JSON.stringify({ rounds12, n: n12.length, dbg12 }));
      // A13 請求延遲超過 10 秒：不重疊
      A.maxInflight = 0; A.inflight = 0;
      A.delay = { match: () => true, ms: 14000, once: false };
      await sleep(33000);
      const maxIn = A.maxInflight;
      A.delay = null; await sleep(15000);
      assert(maxIn === 1, 'A13 請求延遲 14 秒：同一時間只有一個讀取請求，不重疊', String(maxIn));
      // A14 舊 GET 不覆蓋剛完成的 PATCH（收集開關）
      await waitFor(async () => A.inflight === 0, 15000); await sleep(500);
      A.delay = { match: () => true, ms: 3000, once: true };
      await refreshNow(); await sleep(300);
      const tw14 = Date.now();
      // 讀取進行中立即點擊（不等待元素重新出現：若更新時表格被清空，視為失敗）
      const click14 = await ap.evaluate((id) => { const cb = document.querySelector(`#pd-row-${id} .pd-collect`); if (!cb) return 'missing'; cb.click(); return 'ok'; }, PID);
      await sleep(4500);
      const r14 = await rowOf(PID);
      const db14 = (await H.api(C.s.base, C.tok, 'GET', '/api/product-demand-admin/summary')).json.data.products.find((p) => p.product_id === PID);
      assert(click14 === 'ok' && r14 && r14.collect === false && db14.demand_collect_enabled === 0 && writesSince(tw14).filter((w) => w.m === 'PATCH').length === 1, 'A14 讀取進行中表格不清空；較早發出的讀取晚回應不把剛完成的收集開關改回舊值', JSON.stringify({ click14, r14, db: db14.demand_collect_enabled, log: A.delayLog.slice(-3) }));
      if (db14.demand_collect_enabled === 0) await H.api(C.s.base, C.tok, 'PATCH', `/api/product-demand-admin/products/${PID}/collect`, { enabled: true });
      await refreshNow(); await sleep(1500);
      // A15 有效天數尚未儲存：輪詢不覆蓋輸入
      await ap.fill('#pd-set-ttl', '45');
      await ap.evaluate(() => { const e = document.getElementById('pd-set-ttl'); e.blur(); });
      await refreshNow(); await sleep(1500); await sleep(10500);
      const ttl15 = await ap.evaluate(() => document.getElementById('pd-set-ttl').value);
      assert(ttl15 === '45', 'A15 修改有效天數但尚未儲存：自動更新不覆蓋輸入', ttl15);
      await ap.evaluate(() => saveDemandSettings()); await sleep(1500);
      const ttlSaved = (await H.api(C.s.base, C.tok, 'GET', '/api/product-demand-admin/summary')).json.data.config.ttl_days;
      await refreshNow(); await sleep(1500);
      const ttl15b = await ap.evaluate(() => document.getElementById('pd-set-ttl').value);
      assert(ttlSaved === 45 && ttl15b === '45', 'A15-2 儲存後立即更新並保持 45 天', JSON.stringify({ ttlSaved, ttl15b }));
      // A16 切換商品：舊商品的延遲回應不能寫入新面板
      A.delay = { match: (u) => /product_id=701|products\/701(\?|$)/.test(u), ms: 3000, once: true };
      await openDetail(PID); await sleep(200);
      await openDetail(PID3); await sleep(4500);
      const d16 = await detailOf();
      assert(d16 && d16.pid === String(PID3) && new RegExp(PNAME3).test(d16.head) && /有效登記 1 人、期望 2 份/.test(d16.head), 'A16 切換商品後，上一個商品的延遲回應不寫入新面板', JSON.stringify({ d16, log: A.delayLog.slice(-3) }));
      // A17 關閉明細後的延遲回應不重新打開
      A.delay = { match: (u) => /product_id=706|products\/706(\?|$)/.test(u), ms: 3000, once: true };
      await refreshNow(); await sleep(200);
      await ap.evaluate(() => (typeof window.closeDemandDetail === 'function' ? closeDemandDetail() : (document.getElementById('lpm-demand-detail').style.display = 'none')));
      await sleep(4000);
      assert((await detailOf()) === null, 'A17 關閉明細後，延遲回應不重新打開或寫入明細', '');
      // A18 展開明細、日期、方式、預覽、批次明細、焦點、捲動位置在自動更新後保持
      await openDetail(PID); await sleep(1500);
      await ap.waitForSelector('#rn-preview-btn', { timeout: 8000 }).catch(() => {});
      await ap.selectOption('#rn-mode', 'delivery').catch(() => {}); await ap.fill('#rn-date', SUP).catch(() => {});
      await clickIf(ap, '#rn-preview-btn'); await ap.waitForSelector('#rn-preview-box', { timeout: 8000 }).catch(() => {});
      const pv0 = await ap.evaluate(() => (document.getElementById('rn-preview-box') || {}).innerHTML || '');
      await ap.waitForSelector('.rn-batch', { timeout: 8000 }).catch(() => {});
      await ap.evaluate(() => { const b = document.querySelector('.rn-batch button'); if (b) b.click(); }); await sleep(1200);
      // 找出 #rn-date 實際的捲動容器，捲動到非 0 位置
      await ap.evaluate(() => {
        const el = document.getElementById('rn-date'); if (!el) return;
        let sc = el.parentElement; while (sc && !(sc.scrollHeight > sc.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        window.__c42sc = sc || document.scrollingElement;
        el.scrollIntoView({ block: 'center' }); window.__c42sc.scrollTop = Math.max(37, window.__c42sc.scrollTop + 37);
      });
      await ap.focus('#rn-date').catch(() => {});
      const s0 = await ap.evaluate(() => ({ y: Math.round(window.scrollY), sy: Math.round((window.__c42sc || document.scrollingElement).scrollTop), mode: (document.getElementById('rn-mode') || {}).value, date: (document.getElementById('rn-date') || {}).value, focus: document.activeElement && document.activeElement.id, bd: ((document.querySelector('.rn-detail') || {}).innerHTML || '').length }));
      const tw18 = Date.now(); const lu18 = await lastUpd();
      await sleep(21500);
      const s1 = await ap.evaluate(() => ({ y: Math.round(window.scrollY), sy: Math.round((window.__c42sc || document.scrollingElement).scrollTop), mode: (document.getElementById('rn-mode') || {}).value, date: (document.getElementById('rn-date') || {}).value, focus: document.activeElement && document.activeElement.id, bd: ((document.querySelector('.rn-detail') || {}).innerHTML || '').length }));
      const pv1 = await ap.evaluate(() => (document.getElementById('rn-preview-box') || {}).innerHTML || '');
      const ref18 = reqsSince(tw18).length; const lu18b = await lastUpd();
      assert(ref18 >= 2 && lu18b !== lu18, 'A18-1 期間至少完成兩輪自動更新（最後更新時間已更新）', JSON.stringify({ ref18, lu18, lu18b }));
      assert(s0.mode === 'delivery' && s1.mode === 'delivery' && s1.date === SUP && s0.date === SUP, 'A18-2 通知面板的取餐方式與日期保持', JSON.stringify({ s0, s1 }));
      assert(pv0.length > 0 && pv1 === pv0, 'A18-3 已產生的預覽內容（含批次識別）保持', JSON.stringify({ l0: pv0.length, l1: pv1.length }));
      assert(s0.bd > 0 && s1.bd > 0, 'A18-4 展開的批次明細保持', JSON.stringify({ s0: s0.bd, s1: s1.bd }));
      assert(s0.focus === 'rn-date' && s1.focus === 'rn-date' && s0.y === s1.y && s0.sy === s1.sy && s0.sy > 0, 'A18-5 鍵盤焦點與捲動位置保持', JSON.stringify({ s0, s1 }));
      assert((await detailOf()) !== null, 'A18-6 展開的商品明細保持', '');
      assert(writesSince(tw18).length === 0, 'A18-7 自動更新沒有建立預覽、確認、續送或其他寫入', JSON.stringify(writesSince(tw18)));
      // A19 網路失敗：保留原資料，提示可能尚未更新，最後更新時間不變，不連續跳通知；失敗重試有間隔
      await waitFor(async () => A.inflight === 0, 15000); await sleep(300);
      const r19a = await rowOf(PID); const d19a = await detailOf(); const lu19 = await lastUpd();
      const toast0 = await ap.evaluate(() => window.__toasts.length);
      A.abortAll = true; const t19 = Date.now();
      await sleep(36000);
      const r19b = await rowOf(PID); const d19b = await detailOf(); const lu19b = await lastUpd();
      const warn = await ap.evaluate(() => { const e = document.getElementById('pd-refresh-warning'); return e && getComputedStyle(e).display !== 'none' ? e.textContent : ''; });
      const fails = reqsSince(t19).map((r) => r.t); const failRounds = fails.filter((t, i) => i === 0 || t - fails[i - 1] > 1500).length;
      const toast1 = await ap.evaluate(() => window.__toasts.length);
      assert(r19b && JSON.stringify(r19a) === JSON.stringify(r19b) && d19b && d19a.head === d19b.head && r19b.users !== '0', 'A19-1 網路失敗：保留原資料，不清成 0 人、0 份', JSON.stringify({ r19a, r19b, h: d19b && d19b.head }));
      assert(lu19 === lu19b && /可能尚未更新/.test(warn), 'A19-2 網路失敗：最後更新時間不變，提示資料可能尚未更新', JSON.stringify({ lu19, lu19b, warn }));
      assert(toast1 === toast0 && A.dialogs === 0, 'A19-3 網路失敗不跳出打斷操作的通知', JSON.stringify({ toast0, toast1, d: A.dialogs }));
      assert(failRounds >= 2 && failRounds <= 3, 'A19-4 失敗重試有合理間隔（36 秒內 2～3 次，逐次拉長）', JSON.stringify({ failRounds, gaps: fails.map((t, i) => (i ? t - fails[i - 1] : 0)) }));
      A.abortAll = false;
      const rec = await waitFor(async () => { const w = await ap.evaluate(() => { const e = document.getElementById('pd-refresh-warning'); return e && getComputedStyle(e).display !== 'none'; }); return !w && (await lastUpd()) !== lu19; }, 35000);
      assert(rec != null, 'A19-5 網路恢復後自動更新成功，提示消失、最後更新時間更新', String(rec));
      // A20 登記過期：統計正確變化（伺服器重啟並把一筆登記改為已過期；重啟期間也驗證失敗保留）
      await restart(C, (db) => db.run("UPDATE product_demand_requests SET expires_at=datetime('now','-1 minute') WHERE line_user_id=? AND product_id=? AND status='active'", [UA, PID]));
      const ms20 = await waitFor(async () => { const r = await rowOf(PID); const d = await detailOf(); return r && r.users === '0' && r.qty === '0' && d && /有效登記 0 人、期望 0 份/.test(d.head) && d.rows.some((x) => /已過期/.test(x)); }, 45000);
      assert(ms20 != null, 'A20 登記過期：總表與明細都排除過期登記並標示已過期', JSON.stringify({ ms20, r: await rowOf(PID), d: await detailOf() }));
      // A21 手動重新整理按鈕
      const t21 = Date.now();
      const hasBtn = await clickIf(ap, '#pd-refresh-btn');
      const ms21 = await waitFor(async () => reqsSince(t21).length > 0, 2000);
      assert(hasBtn && ms21 != null, 'A21 保留手動重新整理按鈕（點擊立即讀取）', JSON.stringify({ hasBtn, ms21 }));
      await sleep(1500);
      // A22 換店：不顯示上一個店別的資料
      await ap.evaluate(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_002', store_name: '第二店' })); if (window.currentStore) window.currentStore.store_id = 'store_002'; }, [tok2]);
      const ms22 = await waitFor(async () => !(await rowOf(PID)) && (await detailOf()) === null, 14000);
      assert(tok2 && ms22 != null, 'A22 店別（登入身分）改變後：不再顯示上一個店別的登記資料與明細', JSON.stringify({ ms22, tok2: !!tok2, r: await rowOf(PID) }));
      // A23 登出／權限失效（401）：停止輪詢並清除資料
      await ap.evaluate(() => { localStorage.setItem('pos_store_token', 'invalid.jwt.token'); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001' })); if (window.currentStore) window.currentStore.store_id = 'store_001'; });
      await ap.evaluate(() => (typeof window.pdAutoRefreshNow === 'function' ? pdAutoRefreshNow('test') : null));
      await sleep(3000);
      const t23 = Date.now(); await sleep(22000);
      const after401 = reqsSince(t23).length;
      const rows401 = await ap.evaluate(() => document.querySelectorAll('#lpm-demand-tbody tr[id^="pd-row-"]').length);
      assert(after401 === 0 && rows401 === 0, 'A23 登入失效（401）：停止輪詢且不顯示上一個身分的資料', JSON.stringify({ after401, rows401 }));
      assert(A.errs.length === 0, 'A24 後台頁面無 JavaScript 錯誤', A.errs.join(' | '));
      await ap.screenshot({ path: path.join(shots, 'c42-admin.png') }).catch(() => {});
      await actx.close();
      const c1 = await liveCounters(C);
      assert(JSON.stringify(c0) === JSON.stringify(c1), 'A25 後台輪詢：未建立訂單、未修改額度', JSON.stringify({ c0, c1 }));
      const nb = (await H.api(C.s.base, C.tok, 'GET', `/api/product-demand-admin/restock/batches?product_id=${PID}`)).json.data;
      assert(nb.filter((b) => b.status !== 'previewed' && b.status !== 'expired').length === 1, 'A26 後台輪詢：沒有確認、續送或建立新的發送批次（只有測試手動按的一次預覽）', JSON.stringify(nb.map((b) => b.status)));
      assert(lineCalls() === push0, 'A27 後台驗收：LINE API 呼叫 0 次', String(lineCalls() - push0));
      await safeStop(C.s);
    }
    assert(lineCalls() === 0, 'Z1 整個驗收過程 LINE API 呼叫次數為 0（測試程序攔截）', String(lineCalls()));
  } catch (e) {
    H.fail('UNCAUGHT ' + (e && e.message), e && e.stack);
  } finally {
    for (const c of ctxs) { try { await safeStop(c.s); } catch {} }
    try { await browser.close(); } catch {}
    const sm = H.summary();
    const out = process.env.C42_RESULT_FILE;
    if (out) fs.writeFileSync(out, JSON.stringify(sm, null, 2));
    console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed`);
    process.exit(sm.failCount ? 1 : 0);
  }
})();

async function clickIf(page, sel) { const el = await page.$(sel); if (!el) return false; await el.click({ timeout: 5000 }).catch(() => {}); return true; }
