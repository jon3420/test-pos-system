#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-4-upgrade-rollback.js
// R54.4／MBV2-HF1-C5.4 —— 真實升級與回退：同一個資料庫檔，程式在「未修改 C5.3（C54_OLD_ROOT，全新解壓樹）」與 C5.4 之間切換。
//   UP1 [RS] C5.3 建立並實際使用的資料庫（快閃已付款、回應遺失被判失敗、已送出 Request 尚未 callback、一般訂單商品無行小計）→ C5.4 啟動遷移：
//       可能已付款的失敗 → 待核對（不能改現金）；有交易識別的 pending → callback 只唯讀核對；一般訂單付款顯示與商品金額正確；重複啟動結果不變
//   RB1 [RS] C5.4 → C5.3：可讀同一資料庫並啟動；待核對的快閃付款在 C5.3 callback 不再送 Confirm；
//       C5.3 對新付款回應遺失判定的失敗，由資料庫觸發器立即轉回待核對
//   RB2 [RS] 再升級回 C5.4：待核對可唯讀核對完成；回退期間建立的付款可正常處理
// 外部呼叫：LINE Pay 由 c54-linepay-mock 替身攔截；真實 LINE／LINE Pay 呼叫必須 0。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, sleep } = C45;
const { assert } = H;
const OLD = process.env.C54_OLD_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const D = H.tmpDir('c54-ur');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [721, '一元測試品', 1, 'available', { quota: 300, price: 1 }], [731, '快閃測試品', 2, 'available', { quota: 300, price: 90 }]];
const POPUP_SETTINGS = { version: 1, methods: { cash: { enabled: true, description: '' }, linepay: { enabled: true, description: '' }, transfer: { enabled: false, description: '' }, credit_card: { enabled: false, description: '' }, platform: { enabled: false, description: '' } },
  customer_choice: true, online_only: false, default_method: 'linepay', timeout_minutes: 15, allow_fallback_cash: true, expire_cancel_release: true };
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-ur','test-secret-ur')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_pickup_enabled','1')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','popup_payment_settings',?)", [JSON.stringify(POPUP_SETTINGS)]);
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { payment_api: true, line_order: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.4 真實升級（C5.3 → C5.4）與回退驗證 ══════════');
  console.log('C5.4：' + H.ROOT + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C54_OLD_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c54-linepay-mock.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
    C51_LINEPAY_SECRETS: JSON.stringify({ 'test-channel-ur': 'test-secret-ur' }) };
  // 先以 C5.4 harness 建立種子資料庫，再完全交給舊版（C5.3）使用
  const C = await C45.boot('c54ur', { products: PRODUCTS, seed, env });
  await C.s.stop();
  const port = C.s.port;
  const base = `http://127.0.0.1:${port}`;
  let proc = null;
  const start = async (root) => {
    proc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: root, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      MIGRATION_TMP_DIR: path.join(path.dirname(C.dbf), 'uploads'), HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; }); proc.getLog = () => log;
    for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return H.login(base, STORE, 'pw001'); } catch {} if (proc.exitCode != null) throw new Error('exit ' + log.slice(-1500)); await sleep(150); }
    throw new Error('start timeout');
  };
  const stop = async () => { const p = proc; proc = null; if (!p || p.exitCode != null) return; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} r(); }, 4000); }); };
  const dbq = async (sql, p) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, p); } finally { db.close(); } };
  const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
  const dayPlus = (n) => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  let tok = null, SC = null, ph = 100;
  const adm = (m, p, b) => H.api(base, tok, m, p, b);
  const pOrder = async () => {
    const r = await fetch(`${base}/api/line-orders/popup-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'c54u' + crypto.randomBytes(10).toString('hex') },
      body: JSON.stringify({ popup_session_public_code: SC, customer_name: '升級測試', customer_phone: '0911222' + String(ph++).padStart(3, '0'), payment_method: 'linepay', items: [{ product_id: 731, qty: 1 }] }) });
    const j = await r.json(); if (!j.success) throw new Error('popup ' + JSON.stringify(j).slice(0, 200)); return j.data;
  };
  const pRequest = async (o) => { await fetch(`${base}/api/line-orders/popup-payment/linepay-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) }); return lpCalls().filter((c) => /request$/.test(c.uri)).pop(); };
  const pCb = async (call) => { const u = new URL(call.confirmUrl); const r = await fetch(`${base}${u.pathname}?${u.searchParams.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`, { redirect: 'manual' }); return r.headers.get('location') || ''; };
  const pCash = async (o) => (await fetch(`${base}/api/line-orders/popup-payment/switch-to-cash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: o.payment.token }) })).status;
  const pAtt = async (o) => (await dbq('SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [o.payment.ref]))[0];
  try {
    // ── 1. 未修改 C5.3 建立並實際使用資料庫 ──
    tok = await start(OLD);
    const camp = await adm('POST', '/api/popup-pickup/campaigns', { name: 'UR 快閃', status: 'published' });
    const loc = await adm('POST', '/api/popup-pickup/locations', { name: 'UR 地點', address: '台北市', lat: 25.04, lng: 121.51 });
    const sess = await adm('POST', '/api/popup-pickup/sessions', { campaign_id: camp.json.data.id, name: 'UR 場次', status: 'published', pickup_date: dayPlus(2), pickup_start_time: '17:00', pickup_end_time: '19:00',
      order_open_at: '2026-01-01T00:00', order_cutoff_at: dayPlus(1) + 'T23:00', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 500 });
    SC = sess.json.data.public_code;
    lpCtrl({});
    const oPaid = await pOrder(); const cPaid = await pRequest(oPaid); await pCb(cPaid);
    lpCtrl({ confirmMode: 'drop' });
    const oLost = await pOrder(); const cLost = await pRequest(oLost); await pCb(cLost); lpCtrl({}); // C5.3：回應遺失 → 判 failed（金流端其實已扣款）
    const oInflight = await pOrder(); const cInflight = await pRequest(oInflight); // 已建立付款、尚未 callback（顧客付款中）
    const lo = await C45.pub(base, 'POST', '/api/line-orders', { customer_name: '升級一般', customer_phone: '0912000111', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'cash', items: [{ product_id: 721, qty: 3 }] });
    const old = { lost: await pAtt(oLost), paid: await pAtt(oPaid) };
    const cashOld = await pCash(oLost); // C5.3 允許改現金（呈現缺陷）—— 這裡只記錄、改用另一筆驗證升級
    void cashOld;
    lpCtrl({ confirmMode: 'drop' });
    const oLost2 = await pOrder(); const cLost2 = await pRequest(oLost2); await pCb(cLost2); lpCtrl({});
    const before = { lost2: await pAtt(oLost2) };
    await stop();

    // ── 2. 升級到 C5.4（同一資料庫）──
    tok = await start(H.ROOT);
    const lost2 = await pAtt(oLost2); const cash2 = await pCash(oLost2);
    // 金流端已扣款（替身）：舊版 pending（有交易識別）callback → 不送 Confirm，唯讀核對完成
    const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[cInflight.tx].confirmed = true; fs.writeFileSync(LP.state, JSON.stringify(st));
    const locIn = await pCb(cInflight); const inflight = await pAtt(oInflight);
    const q = await C45.pub(base, 'POST', '/api/line-orders/query', { order_number: lo.json.data.order_number, order_ref: lo.json.data.uuid });
    const qo = q.json && q.json.orders && q.json.orders[0];
    const migLog = proc.getLog();
    await stop(); tok = await start(H.ROOT); // 重複啟動
    const lost2b = await pAtt(oLost2);
    assert(old.paid.status === 'paid' && before.lost2.status === 'failed' && lost2.status === 'review' && lost2.quarantined_from === 'failed:provider_declined' && cash2 === 409
      && inflight.status === 'paid' && confirmsFor(cInflight.tx) === 0 && /popup_pay_result=paid/.test(locIn)
      && qo && qo.payment_display && qo.payment_display.state === 'pay_at_pickup' && qo.items[0].line_subtotal === 3 && lost2b.status === 'review' && /popup_payment: 已隔離 \d+ 筆/.test(migLog),
      'UP1 [RS] C5.3 實際使用的資料庫升級到 C5.4：回應遺失被判失敗的快閃付款 → 隔離待核對、不能改現金；已建立付款的舊 pending → callback 不送 Confirm、唯讀核對完成；一般訂單付款顯示與商品金額（1 元×3＝$3）正確；重複啟動不變',
      JSON.stringify({ before: before.lost2.status, after: lost2.status, cash2, inflight: inflight.status, confirmsInflight: confirmsFor(cInflight.tx), pd: qo && qo.payment_display && qo.payment_display.state, line: qo && qo.items[0].line_subtotal }));
    await stop();

    // ── 3. 回退到 C5.3（同一資料庫）──
    tok = await start(OLD);
    const rbUp = true;
    const cLost2Before = confirmsFor(cLost2.tx);
    const locRb = await pCb(cLost2); // C5.3 對待核對（status=review）不送 Confirm
    lpCtrl({ confirmMode: 'drop' });
    const oRb = await pOrder(); const cRb = await pRequest(oRb); await pCb(cRb); lpCtrl({}); // C5.3 回應遺失 → 寫 failed → 觸發器轉回待核對
    const rbAtt = await pAtt(oRb); const rbCash = await pCash(oRb);
    assert(rbUp && confirmsFor(cLost2.tx) === cLost2Before && rbAtt.status === 'review' && rbCash === 409,
      'RB1 [RS] 回退到 C5.3：可讀同一資料庫並啟動；待核對的快閃付款在 C5.3 callback 不再送 Confirm；C5.3 對回應遺失判定的失敗由觸發器立即轉回待核對（不能改現金）',
      JSON.stringify({ confirms: [cLost2Before, confirmsFor(cLost2.tx)], rb: rbAtt.status, rbCash, loc: locRb.slice(-30) }));
    await stop();

    // ── 4. 再升級回 C5.4 ──
    tok = await start(H.ROOT);
    const r1 = await adm('POST', '/api/linepay-admin/reconcile', { popup_attempt_id: oRb.payment.ref });
    const rbDone = await pAtt(oRb);
    lpCtrl({}); const oNew = await pOrder(); const cNew = await pRequest(oNew); await pCb(cNew); const newAtt = await pAtt(oNew);
    assert(r1.status === 200 && rbDone.status === 'paid' && confirmsFor(cRb.tx) === 1 && newAtt.status === 'paid' && confirmsFor(cNew.tx) === 1,
      'RB2 [RS] 再升級回 C5.4：回退期間被隔離的付款以唯讀核對完成（外部 Confirm 仍 1 次）；新付款正常完成', JSON.stringify({ rb: rbDone.status, n: newAtt.status }));
    const real = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean).length;
    assert(real === 0 && unexpected === 0 && C.mf.real() === 0, 'Z 真實 LINE／LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次', JSON.stringify({ real, unexpected, line: C.mf.real() }));
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 800));
  } finally { await stop(); }
  const sum = H.summary();
  if (process.env.C54_RESULT_JSON) fs.writeFileSync(process.env.C54_RESULT_JSON, JSON.stringify({ suite: 'c5-4-upgrade-rollback', pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
