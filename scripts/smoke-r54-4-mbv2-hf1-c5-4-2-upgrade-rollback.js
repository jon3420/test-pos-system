#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-2-upgrade-rollback.js
// R54.4／MBV2-HF1-C5.4.2 —— 真實升級與回退：同一個資料庫檔，程式在「未修改 C5.4.1 TIMING_FIX（C542_OLD_ROOT，全新解壓樹）」與 C5.4.2 之間切換。
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
const OLD = process.env.C542_OLD_ROOT || '';
const NEW = H.ROOT;
const D = H.tmpDir('c542ur-lp');
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
  console.log('══════════ R54.4／MBV2-HF1-C5.4.2 真實升級（TIMING_FIX → C5.4.2）與回退驗證 ══════════');
  console.log('C5.4.2：' + NEW + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C542_OLD_ROOT', ''); process.exit(1); }
  const mf = C45.lineMockFiles('c542ur');
  const dir = H.tmpDir('c542ur'); const dbf = path.join(dir, 'pos.db');
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
  try {
    // ── 0. 舊版建立資料庫並實際使用 ──
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
    const camp = await adm('POST', '/api/popup-pickup/campaigns', { name: 'UR2 快閃', status: 'published' });
    const loc = await adm('POST', '/api/popup-pickup/locations', { name: 'UR2 地點', address: '台北市', lat: 25.04, lng: 121.51 });
    const sess = await adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'UR2 場次', status: 'published', pickup_date: '2026-11-20', pickup_start_time: '17:00', pickup_end_time: '19:00',
      order_open_at: '2026-01-01T00:00', order_cutoff_at: '2026-11-19T23:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 500 });
    SC = sess.json.data.public_code;
    lpCtrl({});
    const O = {};
    O.pend = await pOrder();
    O.fail = await pOrder(); await pCancel(await pRequest(O.fail));
    O.paid = await pOrder(); await pCb(await pRequest(O.paid));
    O.acc = await pOrder('cash'); await adm('PATCH', `/api/orders/${O.acc.id}/status`, { order_status: 'accepted' });
    const ids = Object.values(O).map((o) => o.id);
    await sleep(300);
    const rawOld = await raw(ids);
    const oldLook = await lookup();
    await stop();

    // ── UP1：升級 ──
    await start(NEW); await login();
    const sch1 = await schema();
    const rawUp = await raw(ids);
    const nulls = await dbq(`SELECT COUNT(*) AS c FROM orders WHERE id IN (${ids.map(() => '?').join(',')}) AND popup_created_tz IS NULL AND popup_updated_tz IS NULL`, ids);
    const L1 = await lookup();
    const v = (o) => { const x = L1.list[o.order_number] || {}; return { est: x.establishment_label, created: x.times && x.times.created, updated: x.times && x.times.updated }; };
    const up1 = { pend: v(O.pend), fail: v(O.fail), paid: v(O.paid), acc: v(O.acc) };
    assert(sch1.cols.length === 2 && sch1.trg.length === 2 && JSON.stringify(rawUp) === JSON.stringify(rawOld) && nulls[0].c === ids.length
      && /尚未成立/.test(up1.pend.est) && /^未成立/.test(up1.fail.est) && up1.paid.est === '已成立' && up1.acc.est === '已成立，取貨時付款'
      && Object.values(up1).every((x) => x.created && x.created.known === true && /16:0[89]/.test(x.created.text))
      && up1.acc.updated && up1.acc.updated.known === false && !/16:0/.test(up1.acc.updated.text)
      && up1.paid.updated && up1.paid.updated.known === true && /^2026-11-16 16:0/.test(up1.paid.updated.text),
      'UP1 [RS] 舊版資料庫升級：新增 2 個來源標記欄位與 2 個觸發器；舊時間值逐列不變、標記維持 NULL；成立判定正確；舊建立時間由同交易名額紀錄證實為台北；舊更新時間：已付款者由同交易 UTC 確認時間證實、其餘來源不明者標示未確認（不加 8 小時）',
      JSON.stringify({ sch: { cols: sch1.cols, trg: sch1.trg.map((t) => t.name) }, rawOld, rawUp, up1, oldStatus: oldLook.status }));

    // ── UP2：重複啟動 ──
    await stop(); await start(NEW); await login();
    const sch2 = await schema(); const rawUp2 = await raw(ids);
    assert(JSON.stringify(sch2) === JSON.stringify(sch1) && JSON.stringify(rawUp2) === JSON.stringify(rawOld), 'UP2 [RS] C5.4.2 重複啟動：欄位、觸發器定義與舊時間值都不變（遷移可重複執行）', JSON.stringify({ cols: sch2.cols, trg: sch2.trg.map((t) => t.name) }));

    // ── UP3：更新舊訂單 ──
    await adm('PATCH', `/api/orders/${O.acc.id}/status`, { order_status: 'preparing' });
    const r3 = (await dbq('SELECT updated_at, popup_updated_tz, popup_created_tz, created_at FROM orders WHERE id=?', [O.acc.id]))[0];
    const L3 = await lookup(); const d3 = await L3.det(O.acc.order_number);
    assert(nearTpeNow(r3.updated_at) && r3.popup_updated_tz === 'Asia/Taipei' && r3.popup_created_tz == null && r3.created_at === rawOld.find((x) => x.id === O.acc.id).created_at && d3.times.updated.known === true && /準備中/.test(d3.status_label),
      'UP3 [API] 升級後更新舊訂單：狀態更新時間寫入台北並標記來源；建立時間值與標記不被改動；履約進度如實呈現', JSON.stringify({ r3, upd: d3.times.updated, st: d3.status_label }));

    // ── RB1：回退到舊版 ──
    await stop(); await start(OLD); await login();
    const oRb = await pOrder('cash');
    const acc = await adm('PATCH', `/api/orders/${oRb.id}/status`, { order_status: 'accepted' });
    const rRb = (await dbq('SELECT created_at, updated_at, popup_created_tz, popup_updated_tz FROM orders WHERE id=?', [oRb.id]))[0];
    const Lrb = await lookup();
    const ordersOk = await adm('GET', '/api/orders?date_from=2026-11-16&date_to=2026-11-16&limit=200');
    assert(acc.status === 200 && nearTpeNow(rRb.created_at) && nearTpeNow(rRb.updated_at) && rRb.popup_created_tz == null && rRb.popup_updated_tz === 'Asia/Taipei' && Lrb.status === 200 && Object.keys(Lrb.list).length === 5 && ordersOk.status === 200,
      'RB1 [RS] 回退舊版（同一資料庫）：可啟動；結帳、店家接單、我的訂單、後台列表正常；資料庫觸發器仍讓快閃訂單更新時間維持台北（舊版程式不受影響）', JSON.stringify({ rRb, acc: acc.status, look: Lrb.status, n: Object.keys(Lrb.list).length }));

    // ── RB2：再升級 ──
    await stop(); await start(NEW); await login();
    const L4 = await lookup(); const x4 = L4.list[oRb.order_number] || {};
    const sch4 = await schema();
    assert(JSON.stringify(sch4) === JSON.stringify(sch1) && x4.times && x4.times.created.known === true && x4.times.updated.known === true && x4.establishment_label === '已成立，取貨時付款',
      'RB2 [RS] 再升級回 C5.4.2：回退期間建立的訂單建立時間由同交易名額紀錄證實為台北、更新時間有來源標記；成立判定正確；結構不變', JSON.stringify({ times: x4.times, est: x4.establishment_label }));

    const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0 && unexpected === 0 && mf.real() === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次', JSON.stringify({ real, unexpected, line: mf.real(), lp: lpCalls().length }));
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200) + ' | ' + (proc && proc.getLog ? proc.getLog().slice(-800) : ''));
  } finally { await stop(); }
  const sum = H.summary();
  if (process.env.C542UR_RESULT_JSON) fs.writeFileSync(process.env.C542UR_RESULT_JSON, JSON.stringify({ suite: 'r54-4-mbv2-hf1-c5-4-2-upgrade-rollback', new_root: NEW, old_root: OLD, pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
