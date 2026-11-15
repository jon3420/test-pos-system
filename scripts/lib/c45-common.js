// scripts/lib/c45-common.js — R54.4／MBV2-HF1-C4.5／C5 測試共用：暫存伺服器、店家／商品／會員種子、LIFF SDK 替身
// 只在測試程序使用；正式部署不載入。真實 LINE 發送由 c4-line-mock.js（程序內攔截）計數，必須為 0。
'use strict';
const path = require('path');
const fs = require('fs');
const H = require('./mbv2-harness');
const Seed = require('./mbv2-seed');

const STORE = 'store_001';
const TOKEN = 'test-only-channel-token-not-real-c45';
const LIFF = '2000000000-TestLiffC45';
const NET_MOCK = path.join(__dirname, 'hf1c3-net-mock.js');
const LINE_MOCK = path.join(__dirname, 'c4-line-mock.js');
const CLOCK = path.join(__dirname, 'c4-test-clock.js');
const MS = () => require(path.join(H.ROOT, 'utils', 'lineMemberSession.js'));
const session = (u, store = STORE) => MS().createMemberSession({ store_id: store, line_user_id: u });
const U = (n) => 'Uc45' + String(n).padStart(28, '0');
const puuid = (pid) => '00000000-0000-4000-8000-' + String(pid).padStart(12, '0');
const REAL_NOW = () => Date.now() - Number(process.env.C4_CLOCK_OFFSET_MS || 0);

function lineMockFiles(tag) {
  const dir = H.tmpDir(tag + '-linemock');
  const f = { dir, push: path.join(dir, 'real-line-attempts.txt'), ctrl: path.join(dir, 'ctrl.json'), state: path.join(dir, 'state.json'), log: path.join(dir, 'calls.jsonl') };
  fs.writeFileSync(f.push, ''); fs.writeFileSync(f.ctrl, '{}'); fs.writeFileSync(f.state, JSON.stringify({ accepted: {}, used: {} })); fs.writeFileSync(f.log, '');
  f.real = () => fs.readFileSync(f.push, 'utf8').split('\n').filter(Boolean).length;
  f.calls = () => fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return f;
}

function seedStore(db, opts = {}) {
  const runSql = (sql, p) => db.run(sql, p || []);
  const set = (k, v) => runSql('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [STORE, k, String(v)]);
  const allDay = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDay[k] = { enabled: true, open: '00:00', close: '23:59' }; });
  set('takeout_business_hours', JSON.stringify(opts.takeoutHours || allDay)); set('delivery_business_hours', JSON.stringify(allDay));
  set('takeout_enabled', '1'); set('delivery_enabled', '1'); set('takeout_allow_next_day', '1'); set('delivery_allow_next_day', '1');
  set('takeout_prep_minutes', '0'); set('delivery_prep_minutes', '0'); set('line_payment_cash_enabled', '1'); set('line_ordering_enabled', '1');
  set('store_lat', '25.0330'); set('store_lng', '121.5654'); set('delivery_max_distance_km', '7'); set('delivery_basic_fee', '50');
  set('line_order_page_mode', 'combined_checkout');
  set('line_channel_token', TOKEN); set('line_member_liff_id', LIFF);
  for (const [k, v] of Object.entries(opts.settings || {})) set(k, v);
  const cols = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  const want = {
    line_quota_enabled: 'INTEGER DEFAULT 0', line_quota_daily: 'INTEGER DEFAULT 0', line_quota_sold: 'INTEGER DEFAULT 0',
    line_quota_low_threshold: 'INTEGER DEFAULT 2', line_quota_high_threshold: 'INTEGER DEFAULT 10',
    line_preorder_enabled: 'INTEGER DEFAULT 0', line_preorder_daily: 'INTEGER DEFAULT 0', line_preorder_sold: 'INTEGER DEFAULT 0',
    line_preorder_low_threshold: 'INTEGER DEFAULT 2', line_preorder_high_threshold: 'INTEGER DEFAULT 10',
    line_takeout_enabled: 'INTEGER DEFAULT 1', line_delivery_enabled: 'INTEGER DEFAULT 1', shipping_enabled: 'INTEGER DEFAULT 0', shipping_share_line_stock: 'INTEGER DEFAULT 1',
  };
  Object.entries(want).forEach(([c, t]) => { if (!cols.includes(c)) runSql(`ALTER TABLE products ADD COLUMN ${c} ${t}`); });
  const ins = (id, name, sort, status, extra = {}) => runSql(`INSERT INTO products (id,store_id,name,category,category_id,price,enabled,show_on_line,sale_status,sort_order,
      line_quota_enabled,line_quota_daily,line_quota_sold,line_preorder_enabled,line_preorder_daily,line_preorder_sold,line_takeout_enabled,line_delivery_enabled)
      VALUES (?,?,?,?,?,?,1,?,?,?, 1,?,0, 1,20,0, 1,1)`, [id, STORE, name, '飯類', 101, extra.price || 150, extra.show_on_line ?? 1, status, sort, extra.quota ?? 10]);
  const prods = opts.products || [[701, '測試招牌飯', 0, 'available'], [702, '測試對照湯', 1, 'available'], [703, '測試隱藏品', 2, 'available', { show_on_line: 0 }]];
  for (const p of prods) ins(...p);
  const pc = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
  if (pc.includes('product_uuid')) for (const p of prods) runSql('UPDATE products SET product_uuid=? WHERE id=? AND store_id=?', [puuid(p[0]), p[0], STORE]);
  for (let i = 1; i <= (opts.members || 30); i++) runSql('INSERT INTO line_members (store_id, line_user_id, display_name, is_friend) VALUES (?,?,?,1)', [STORE, U(i), '會員' + i]);
}

const srvEnv = (mf, extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', NET_MOCK, '-r', LINE_MOCK], GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
  HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, ...extra });

async function boot(tag, opts = {}) {
  const mf = lineMockFiles(tag);
  const dir = H.tmpDir(tag); const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); seedStore(db, opts); if (opts.seed) opts.seed(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf, srvEnv(mf, opts.env));
  const tok = await H.login(s.base, STORE, 'pw001');
  const C = { s, dbf, tok, mf };
  // 重新啟動沿用同一個連接埠（已開啟的瀏覽器頁面可以繼續連線）
  C.restart = async (env2) => { const port = C.s.port; try { if (C.s.proc.exitCode == null && C.s.proc.signalCode == null) await C.s.stop(); } catch {} C.s = await startOnPort(dbf, srvEnv(mf, env2 || opts.env), port); return C.s; };
  return C;
}
async function startOnPort(dbPath, extraEnv, port) {
  const { spawn } = require('child_process');
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbPath, MIGRATION_TMP_DIR: path.join(path.dirname(dbPath), 'uploads'), ...extraEnv };
  delete env.DB_PATH;
  const proc = spawn(process.execPath, [...(extraEnv.__nodeArgs || []), 'server.js'], { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; if (log.length > 400000) log = log.slice(-200000); });
  proc.stderr.on('data', (d) => { log += d; if (log.length > 400000) log = log.slice(-200000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {}
    if (proc.exitCode != null) throw new Error('server exited: ' + log.slice(-3000));
    if (Date.now() > deadline) throw new Error('server start timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
  return { proc, base, port, getLog: () => log, dbPath,
    stop: () => new Promise((resolve) => { if (proc.exitCode != null || proc.signalCode != null) return resolve(); proc.once('exit', () => resolve()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}
async function pub(base, method, p, body, store = STORE) {
  const r = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}store_id=${store}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// 讀取商品穩定識別（伺服器啟動時 backfill；直接讀暫存資料庫檔案中的值須先停機，這裡改由 SQL 經 admin 匯出不可行 → 由 sql.js 讀檔）
async function productUuid(dbf, pid) {
  const db = await H.openDbFile(dbf);
  try { const r = H.q1(db, 'SELECT product_uuid FROM products WHERE id=? AND store_id=?', [pid, STORE]); return r && r.product_uuid; } finally { db.close(); }
}

// LIFF SDK 替身（Playwright 攔截 static.line-scdn.net 後回傳）。依官方「一次導向／二次導向」流程模擬：
//   網址帶 liff.state 時 init() 把 liff.state 內容還原到 Endpoint URL 後以 location.replace() 導向（二次導向）。
//   window.__C45_LIFF：{ mode:'resolve_then_redirect'|'hang_redirect', loggedIn, idToken }（由 addInitScript 設定）。
// 每次 init 呼叫記錄在 sessionStorage.__c45liff（只有次數），供測試核對「每頁初始化次數」。
const FAKE_LIFF_SDK = `(function(){
  function log(k){ try{ var o=JSON.parse(sessionStorage.getItem('__c45liff')||'{}'); o[k]=(o[k]||0)+1; sessionStorage.setItem('__c45liff',JSON.stringify(o)); }catch(e){} }
  var cfg=window.__C45_LIFF||{};
  window.liff={
    init:function(c){
      log('init');
      var u=new URL(location.href); var st=u.searchParams.get('liff.state');
      if(st!==null){
        log('primary_init');
        u.searchParams.delete('liff.state'); u.hash='';
        var qi=st.indexOf('?'); if(qi>=0){ new URLSearchParams(st.slice(qi+1).split('#')[0]).forEach(function(v,k){ u.searchParams.append(k,v); }); }
        var target=u.toString();
        if(cfg.mode==='hang_redirect'){ setTimeout(function(){ location.replace(target); },60); return new Promise(function(){}); }
        return new Promise(function(res){ res(); setTimeout(function(){ location.replace(target); },40); });
      }
      return new Promise(function(res){ setTimeout(function(){ window.__c45LiffInitDone=true; log('init_resolved'); res(); }, cfg.initDelay||0); });
    },
    ready:Promise.resolve(), isLoggedIn:function(){ return !!cfg.loggedIn; }, isInClient:function(){ return true; },
    getIDToken:function(){ return cfg.idToken||null; }, getAccessToken:function(){ return null; },
    getProfile:async function(){ return { userId:'Ufakeprofile', displayName:'Fake' }; },
    getFriendship:async function(){ return { friendFlag:true }; }, requestFriendship:async function(){ return {}; },
    login:function(o){ log('login'); try{ sessionStorage.setItem('__c45_login_redirect', (o&&o.redirectUri)||''); }catch(e){} },
    logout:function(){}, openWindow:function(){}, getOS:function(){ return 'web'; }, getLanguage:function(){ return 'zh-TW'; },
    getContext:function(){ return {}; }, isApiAvailable:function(){ return true; }
  };
})();`;

function launchOpts() { return { executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function twDate(offsetDays = 0) { const d = new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3); return d.toISOString().slice(0, 10); }

module.exports = { puuid, STORE, TOKEN, LIFF, session, U, REAL_NOW, lineMockFiles, seedStore, srvEnv, boot, pub, productUuid, FAKE_LIFF_SDK, launchOpts, sleep, twDate, H };
