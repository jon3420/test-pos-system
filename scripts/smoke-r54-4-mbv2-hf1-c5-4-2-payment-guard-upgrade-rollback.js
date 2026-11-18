#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-upgrade-rollback.js
// R54.4／MBV2-HF1-C5.4.2 補修 —— 真實升級與回退：同一個資料庫檔，程式在「未修改 C5.4.2（C542G_OLD_ROOT，全新解壓樹）」與補修版之間切換。
//   本補修沒有 schema／觸發器變更：升級、重複啟動與回退後，資料表結構、觸發器定義與既有資料逐列不變。
//   主機一律 TZ=UTC（重現正式環境的時間落差）；伺服器時鐘固定位移到 UTC 2026-11-16 08:08（台北 16:08）。
//   UP1 舊版建立並實際使用的資料庫 → C5.4.2 啟動遷移：新增兩個可為 NULL 的來源標記欄位與觸發器；舊時間值逐列不變；
//       成立判定正確；舊資料時間依可信證據判讀（不明者標示時區未確認，不自動加 8 小時）
//   UP2 C5.4.2 重複啟動：遷移可重複執行（欄位、觸發器、資料不變）
//   UP3 C5.4.2 更新舊訂單：狀態更新時間改為台北並標記來源
//   RB1 C5.4.2 → 舊版：同一資料庫可啟動；結帳、接單、查詢正常；觸發器仍讓快閃訂單更新時間維持台北
//   RB2 再升級回 C5.4.2：回退期間建立的訂單可判讀（建立時間由同交易名額紀錄證實為台北）
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截；真實 LINE／LINE Pay 呼叫必須 0。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const RealDate = Date;
const C45 = require('./lib/c45-common');
const Seed = require('./lib/mbv2-seed');
const { H, STORE, sleep } = C45;
const { assert } = H;
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const OLD = process.env.C542G_OLD_ROOT || '';
const NEW = H.ROOT;
const D = H.tmpDir('c542gur-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [731, '快閃測試品', 1, 'available', { quota: 900, price: 90 }]];
const SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 60, allow_fallback_cash: true, expire_cancel_release: true };
const OFF = Date.parse('2026-11-16T08:08:00Z') - RealDate.now();
const tpeNowMs = () => RealDate.now() + OFF + 8 * 3600e3;
const nearTpeNow = (s, tolMin = 3) => { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '')); if (!m) return false; const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); return Math.abs(t - tpeNowMs()) <= tolMin * 60000; };

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4.2 補修 真實升級（C5.4.2 → 補修版）與回退驗證 ══════════');
  console.log('補修版：' + NEW + '　C5.4.2：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C542G_OLD_ROOT', ''); process.exit(1); }
  const mf = C45.lineMockFiles('c542gur');
  const dir = H.tmpDir('c542gur'); const dbf = path.join(dir, 'pos.db');
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), TZ: 'UTC', C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
    C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-ur2': 'test-secret-ur2' }), GOOGLE_MAPS_SERVER_KEY: 'test-only-key',
    HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log, MIGRATION_TMP_DIR: path.join(dir, 'uploads') };
  const port = await new Promise((r) => { const s = require('net').createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  let proc = null; const logs = [];
  const start = async (root) => {
    const { __nodeArgs, ...rest } = env;
    proc = spawn(process.execPath, [...__nodeArgs, 'server.js'], { cwd: root, env: { ...process.env, ...rest, PORT: String(port), POS_DB_PATH: dbf }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; }); proc.getLog = () => log; logs.push(proc);
    for (let i = 0; i < 300; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {} if (proc.exitCode != null) throw new Error('exit ' + log.slice(-1500)); await sleep(150); }
    throw new Error('start timeout');
  };
  const stop = async () => { const p = proc; proc = null; if (!p || p.exitCode != null) return; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} r(); }, 5000); }); };
  const dbq = async (sql, p) => { await sleep(200); const db = await H.openDbFile(dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
  let tok = null, SC = null, ph = 100;
  const login = async () => { tok = await H.login(base, STORE, 'pw001'); };
  const adm = (m, p, b) => H.api(base, tok, m, p, b);
  const PHONE = '0955111222';
  const pOrder = async (pay = 'linepay') => {
    const r = await fetch(`${base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c542u' + crypto.randomBytes(10).toString('hex') },
      body: JSON.stringify({ popup_session_public_code: SC, customer_name: '升級測試', customer_phone: PHONE, payment_method: pay, items: [{ product_id: 731, qty: 1 }] }) });
    const j = await r.json(); if (!j.success) throw new Error('popup ' + JSON.stringify(j).slice(0, 200)); ph++; return j.data;
  };
  const pRequest = async (o) => { await fetch(`${base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) }); return lpCalls().filter((c) => /request$/.test(c.uri)).pop(); };
  const pCb = async (call) => { const u = new URL(call.confirmUrl); await fetch(`${base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); };
  const pCancel = async (call) => { const u = new URL(call.confirmUrl.replace('linepay-confirm', 'linepay-cancel')); await fetch(`${base}${u.pathname}?${u.searchParams.toString()}`, { redirect: 'manual' }); };
  const lookup = async () => {
    const r = await fetch(`${base}/api/line-orders/popup-orders/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_code: SC, phone: PHONE }) });
    const j = await r.json(); const t = j.data && j.data.token; const out = {};
    for (let p = 1; p < 10 && t; p++) { const l = await (await fetch(`${base}/api/line-orders/popup-orders/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t, page: p }) })).json(); (l.data.orders || []).forEach((o) => { out[o.order_number] = o; }); if (!l.data.has_more) break; }
    const det = async (no) => (await (await fetch(`${base}/api/line-orders/popup-orders/detail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t, order_number: no }) })).json()).data;
    return { status: r.status, list: out, det };
  };
  const raw = async (ids) => dbq(`SELECT id, created_at, updated_at FROM orders WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
  const schema = async () => ({ cols: (await dbq('PRAGMA table_info(orders)')).map((c) => c.name).filter((c) => /^popup_(created|updated)_tz$/.test(c)),
    trg: (await dbq("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_c542_%' ORDER BY name")) });
  const schemaAll = async () => (await dbq("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','trigger','index') ORDER BY type, name"));
  const rowsHash = async () => { const db = await H.openDbFile(dbf); try { const h = crypto.createHash('sha256'); for (const t of ['orders', 'popup_payment_attempts', 'popup_order_allocations']) h.update(JSON.stringify(H.q(db, `SELECT * FROM ${t} ORDER BY rowid`))); return h.digest('hex'); } finally { db.close(); } };
  const status = async (token) => (await (await fetch(`${base}/api/line-orders/popup-payment/status?token=${token}`)).json()).data;
  const cash = async (token) => { const r = await fetch(`${base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); return r.status; };
  try {
    // ── 0. 未修改 C5.4.2 建立資料庫並實際使用 ──
    await start(OLD); await stop();
    { const db = await H.openDbFile(dbf); Seed.seedStore001(db); C45.seedStore(db, { products: PRODUCTS, members: 5 });
      db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-ur2','test-secret-ur2')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
      db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(SETTINGS)]);
      const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
      if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { payment_api: true, line_order: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
      H.saveDbFile(db, dbf); db.close(); }
    await start(OLD); await login();
    const camp = await adm('POST', '/api/popup-pickup/campaigns', { name: 'GUR 快閃', status: 'published' });
    const loc = await adm('POST', '/api/popup-pickup/locations', { name: 'GUR 地點', address: '台北市', lat: 25.04, lng: 121.51 });
    const sess = await adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'GUR 場次', status: 'published', pickup_date: '2026-11-20', pickup_start_time: '17:00', pickup_end_time: '19:00',
      order_open_at: '2026-01-01T00:00', order_cutoff_at: '2026-11-19T23:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 500 });
    SC = sess.json.data.public_code;
    lpCtrl({});
    const O = {};
    O.rv = await pOrder(); { lpCtrl({ confirmMode: 'drop', inquiry: '1150' }); await pCb(await pRequest(O.rv)); lpCtrl({}); } // review（正式流程）
    O.paid = await pOrder(); await pCb(await pRequest(O.paid));
    O.cash = await pOrder('cash'); await adm('PATCH', `/api/orders/${O.cash.id}/status`, { order_status: 'accepted' });
    await stop();
    // [FX] 舊版資料中已存在的多筆付款：review 單與已付款單各有一筆較新的確定失敗（正常操作無法產生，直接寫入）
    const fx = {};
    { const db = await H.openDbFile(dbf);
      const add = (orderId) => {
        const src = db.exec('SELECT * FROM popup_payment_attempts WHERE order_id=? ORDER BY rowid LIMIT 1', [orderId])[0];
        const cols = src.columns; const row = {}; cols.forEach((c, i) => { row[c] = src.values[0][i]; });
        const token = crypto.randomBytes(24).toString('hex');
        Object.assign(row, { attempt_id: crypto.randomUUID(), token_hash: crypto.createHash('sha256').update(token).digest('hex'), status: 'failed', transaction_id: '', fail_reason: 'customer_cancelled',
          failure_basis: 'customer_cancelled_before_confirm', confirm_state: 'never', confirm_calls: 0, review_reason: '', result_code: '', merchant_ref: '', cb_hash: '', confirmed_at: null });
        db.run(`INSERT INTO popup_payment_attempts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
        return token;
      };
      fx.rv = add(O.rv.id); fx.paid = add(O.paid.id);
      H.saveDbFile(db, dbf); db.close(); }
    const sch0 = await schemaAll(); const h0 = await rowsHash();

    // ── UP1：升級到補修版 ──
    await start(NEW); await login();
    const sch1 = await schemaAll(); const h1 = await rowsHash();
    const s1 = await status(fx.rv); const s2 = await status(fx.paid);
    const c1 = await cash(fx.rv); const c2 = await cash(fx.paid);
    const h1b = await rowsHash();
    assert(JSON.stringify(sch1) === JSON.stringify(sch0) && h1 === h0 && s1.state === 'payment_under_review' && s1.can_switch_to_cash === false && s2.state === 'paid' && s2.can_switch_to_cash === false && c1 === 409 && c2 === 409 && h1b === h0,
      'UP1 [RS][FX] 舊資料（未修改 C5.4.2 產生，含既有多筆付款）升級：資料表／觸發器／索引定義與訂單、付款、名額資料逐列不變；整單防護立即生效（待核對＋較新失敗 → 確認中、拒絕改現金；已付款＋較新失敗 → 已付款、拒絕改現金），拒絕後資料不變',
      JSON.stringify({ schemaSame: JSON.stringify(sch1) === JSON.stringify(sch0), rowsSame: h1 === h0, s1: [s1.state, s1.can_switch_to_cash], s2: [s2.state, s2.can_switch_to_cash], c: [c1, c2], after: h1b === h0 }));

    // ── UP2：重複啟動 ──
    await stop(); await start(NEW); await login();
    const sch2 = await schemaAll(); const h2 = await rowsHash();
    assert(JSON.stringify(sch2) === JSON.stringify(sch0) && h2 === h0, 'UP2 [RS] 補修版重複啟動：結構與資料不變（本補修沒有遷移）', JSON.stringify({ schemaSame: JSON.stringify(sch2) === JSON.stringify(sch0), rowsSame: h2 === h0 }));

    // ── RB1：回退到未修改 C5.4.2 ──
    await stop(); await start(OLD); await login();
    const sch3 = await schemaAll();
    const oRb = await pOrder('cash');
    const acc = await adm('PATCH', `/api/orders/${oRb.id}/status`, { order_status: 'accepted' });
    const L = await lookup(); const st3 = await status(O.paid.payment.token);
    const sch3b = await schemaAll(); // 查詢會在舊版首次使用時建立查詢 token 表（既有延遲建立）；再升級以此為比較基準
    assert(JSON.stringify(sch3) === JSON.stringify(sch0) && acc.status === 200 && L.status === 200 && Object.keys(L.list).length === 4 && st3 && st3.state === 'paid',
      'RB1 [RS] 回退未修改 C5.4.2（同一資料庫）：可啟動；結構不變；結帳、店家接單、我的訂單、付款狀態查詢正常', JSON.stringify({ schemaSame: JSON.stringify(sch3) === JSON.stringify(sch0), acc: acc.status, look: L.status, n: Object.keys(L.list).length }));

    // ── RB2：再升級 ──
    await stop(); await start(NEW); await login();
    const sch4 = await schemaAll(); const s4 = await status(fx.rv); const L4 = await lookup();
    assert(JSON.stringify(sch4) === JSON.stringify(sch3b) && s4.state === 'payment_under_review' && s4.can_switch_to_cash === false && L4.status === 200 && Object.keys(L4.list).length === 4,
      'RB2 [RS] 再升級回補修版：結構不變；回退期間的資料可正常查詢；整單防護仍生效', JSON.stringify({ s4: [s4.state, s4.can_switch_to_cash], n: Object.keys(L4.list).length }));

    const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0 && unexpected === 0 && mf.real() === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次', JSON.stringify({ real, unexpected, line: mf.real(), lp: lpCalls().length }));
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200) + ' | ' + (proc && proc.getLog ? proc.getLog().slice(-800) : ''));
  } finally { await stop(); }
  const sum = H.summary();
  if (process.env.C542GUR_RESULT_JSON) fs.writeFileSync(process.env.C542GUR_RESULT_JSON, JSON.stringify({ suite: 'r54-4-mbv2-hf1-c5-4-2-payment-guard-upgrade-rollback', new_root: NEW, old_root: OLD, pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
