#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js
// R54.4／MBV2-HF1-C5.3 —— 付款待核對防重送、完整回應驗證、重新付款阻擋：重現／驗收（同一組案例先跑未修改 C5.2，再跑 C5.3）
//   F1 結果不明（曾送或可能已送 Confirm）時不得再次 Confirm
//   F2 舊付款（沒有可靠處理階段）與重複交易回應不得誤判為確定失敗
//   F3 付款成功資料完整驗證（F3a 唯讀查詢缺 transactionType；F3b Confirm 只有 0000）
//   F4 「查無交易＋經過時間」不得解除付款阻擋（含舊 API）
//   H  歷史問題紀錄的升級隔離與重複遷移
//   R  付款主流程回歸（正常付款、保存失敗、本機提交失敗、付款中取消、副作用）
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright）；[DB] 直接核對資料庫檔；
//   [RS] 以 SIGKILL 真正終止伺服器程序，再用同一資料庫檔重新啟動；[FX] 以 fixture 建立的歷史資料（明確標示）。
// 外部呼叫：LINE Pay 由 c53-linepay-mock 有狀態替身攔截並核對簽章；未知 LINE Pay 路徑立即拋錯並記錄（必須 0 行）。
//   LINE Messaging API 由 c4-line-mock／hf1c3-net-mock 攔截。這些都不是真機、正式金流或 Sandbox 驗證。
// 分類（在報告中分開列示）：
//   D＝原始缺陷直接重現；N＝新功能／新介面（基準不存在）；P＝測試前提或測試替身問題；C＝連帶失敗；G＝付款主流程回歸保護
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30); // 一律以台北 10:30 執行（取餐 22:30）
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const D = H.tmpDir('c53-lp');
const LP = { ctrl: path.join(D, 'ctrl.json'), state: path.join(D, 'state.json'), log: path.join(D, 'calls.jsonl'), real: path.join(D, 'real.txt'), unexpected: path.join(D, 'unexpected.txt') };
for (const [k, f] of Object.entries(LP)) fs.writeFileSync(f, k === 'state' ? JSON.stringify({ tx: {} }) : (k === 'ctrl' ? '{}' : ''));
const DUR = path.join(D, 'durable.json'); fs.writeFileSync(DUR, '{}');
const SECRETS = { 'test-channel-c53': 'test-secret-c53' };
const lpCalls = () => fs.readFileSync(LP.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lpCtrl = (o) => fs.writeFileSync(LP.ctrl, JSON.stringify(o || {}));
const confirmsFor = (tx) => lpCalls().filter((c) => /\/confirm$/.test(c.uri) && String(c.tx) === String(tx)).length;
const inquiriesFor = (tx) => lpCalls().filter((c) => c.method === 'GET' && c.uri === '/v3/payments' && String(c.tx) === String(tx)).length;
const setMockTx = (tx, patch) => { const st = JSON.parse(fs.readFileSync(LP.state, 'utf8')); st.tx[tx] = { ...(st.tx[tx] || {}), ...patch }; fs.writeFileSync(LP.state, JSON.stringify(st)); };
const ONLY = (process.env.C53_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const STEP_RE = process.env.C53_STEP ? new RegExp(process.env.C53_STEP) : null;
const META = {}; // 案例 → { cls, confirms, repay }
const GAP = [];
async function step(name, cls, fn) {
  if (STEP_RE && !STEP_RE.test(name)) return;
  META[name] = { cls };
  try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
}
function sessAt(u, offsetMs) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}
const P = [711, 712, 713, 714];
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }],
  [711, '付款測試甲', 1, 'available', { quota: 400, price: 100 }], [712, '付款測試乙', 2, 'available', { quota: 400, price: 120 }],
  [713, '付款測試丙', 3, 'available', { quota: 400, price: 80 }], [714, '付款測試丁', 4, 'available', { quota: 400, price: 60 }]];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c53','test-secret-c53')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  const rr = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (rr[0] && rr[0].values[0]) { const f = JSON.parse(rr[0].values[0][0] || '{}'); Object.assign(f, { coupon: true, reports: true, line_order: true, payment_api: true }); db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5.3 付款待核對防重送・完整回應驗證・重新付款阻擋 重現／驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c53-linepay-mock.js'), '-r', path.join(LIB, 'c51-durable-fault.js')],
      C4_CLOCK_OFFSET_MS: String(off), C51_LINEPAY_CTRL: LP.ctrl, C51_LINEPAY_STATE: LP.state, C51_LINEPAY_LOG: LP.log, C51_LINEPAY_REAL: LP.real, C53_LINEPAY_UNEXPECTED: LP.unexpected,
      C51_DURABLE_CTRL: DUR, C51_LINEPAY_SECRETS: JSON.stringify(SECRETS) });
    const C = await C45.boot('c53', { products: PRODUCTS, members: 60, settings: {}, seed, env: env(OFF) }); boots.push(C);
    const restart = async () => { await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    await restart();
    const killAndRestart = async () => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); await restart(); };
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const today = () => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const editDb = async (fn) => { await C.s.stop(); try { const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } } finally { await restart(); } };
    let pi = 0;
    const order = async (u, o = {}) => {
      const pid = o.pid || P[pi++ % P.length];
      const body = { customer_name: '付款測試', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today(), pickup_time: '22:30',
        payment_method: 'linepay', items: [{ product_id: pid, qty: o.qty || 1 }], analytics: { visitor_id: 'v_c53', session_id: 's_c53' }, member_session: sessAt(u, OFF) };
      const r = await pub('POST', '/api/line-orders', body);
      if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 200));
      return { ...r.json.data, pid };
    };
    const lpRequest = async (o) => {
      const r = await pub('POST', '/api/linepay/request', { order_uuid: o.uuid });
      const call = lpCalls().filter((c) => /request$/.test(c.uri)).pop();
      return { r, call };
    };
    const cbUrl = (call, { legacy } = {}) => {
      const sp = new URL(call.confirmUrl).searchParams; if (legacy) sp.delete('attempt');
      return `${C.s.base}/api/linepay/confirm?${sp.toString()}&transactionId=${call.tx}&orderId=${encodeURIComponent(call.orderId)}`;
    };
    const callback = async (call, opt) => { const r = await fetch(cbUrl(call, opt), { redirect: 'manual' }); return r.headers.get('location') || ''; };
    const ord = async (uuid) => (await q('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
    const attempts = async (uuid) => q('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id', [uuid]);
    const attempt = async (uuid) => (await attempts(uuid)).pop() || null;
    const repay = async (o) => (await pub('POST', '/api/linepay/request', { order_uuid: o.uuid })).status; // 重新付款請求：409＝被阻擋
    const reconcileOne = async (a) => { const r = await adm('POST', '/api/linepay-admin/reconcile', { attempt_uuid: a.attempt_uuid }); if (r.status === 404) GAP.push('POST /api/linepay-admin/reconcile'); return r; };
    const events = async (uuid) => (await q("SELECT event_name, COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name IN ('purchase','payment_success') GROUP BY event_name", [uuid])).reduce((m, r) => { m[r.event_name] = r.c; return m; }, {});
    const durable = (o) => fs.writeFileSync(DUR, JSON.stringify(o || {}));
    // 取得一筆「已送出 Confirm（金流已扣款）、回應遺失、唯讀查詢回 X」的待核對付款
    const reviewAfterSent = async (u, inquiryMode) => {
      lpCtrl({ confirmMode: 'drop', inquiry: inquiryMode });
      const o = await order(u); const { call } = await lpRequest(o);
      const loc = await callback(call);
      return { o, call, loc };
    };
    if (chromium) browser = await chromium.launch(C45.launchOpts());

    // ═══════════════════════ F1：結果不明時禁止再次送出 Confirm ═══════════════════════
    if (want('F1')) {
      for (const [name, mode] of [['F1-1', '1150'], ['F1-2', 'empty']]) {
        await step(name, 'D', async (m) => {
          const { o, call, loc } = await reviewAfterSent(U(1), mode);
          const a0 = await attempt(o.uuid);
          const loc2 = await callback(call); // 顧客重新整理返回頁（查詢仍回 1150／空清單）
          lpCtrl({});
          const a = await attempt(o.uuid); const x = await ord(o.uuid); const rp = await repay(o);
          m.confirms = confirmsFor(call.tx); m.repay = rp;
          assert(a0.status === 'review' && /pending/.test(loc) && confirmsFor(call.tx) === 1 && a.status === 'review' && Number(a.confirm_calls) === 1 && x.payment_status !== 'paid' && rp === 409 && /linepay=pending/.test(loc2),
            `${name} [API] 已送 Confirm、查詢回 ${mode === '1150' ? '1150' : '空清單'}、再次 callback：維持待核對、外部 Confirm 仍 1 次、confirm_calls 仍 1、重新付款被阻擋`,
            JSON.stringify({ confirms: confirmsFor(call.tx), calls: a.confirm_calls, st: a.status, repay: rp, loc2: loc2.slice(0, 60) }));
        });
      }
      await step('F1-3', 'D', async (m) => {
        // [RS] 同一情境：重複 callback、後台核對、SIGKILL 重啟後再 callback／核對 → Confirm 次數不增加
        const { o, call } = await reviewAfterSent(U(2), '1150');
        await callback(call); await callback(call);
        const a1 = await attempt(o.uuid); await reconcileOne(a1);
        await killAndRestart();
        await callback(call); await sleep(10500); await reconcileOne(a1);
        lpCtrl({});
        const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(confirmsFor(call.tx) === 1 && a.status === 'review' && rp === 409 && inquiriesFor(call.tx) >= 3,
          'F1-3 [API][RS] 同一待核對付款：重複 callback ×3、後台核對 ×2、程序 SIGKILL 重啟後再 callback：外部 Confirm 仍 1 次、維持待核對、重新付款被阻擋',
          JSON.stringify({ confirms: confirmsFor(call.tx), inq: inquiriesFor(call.tx), st: a.status, calls: a.confirm_calls, repay: rp }));
      });
      await step('F1-4', 'D', async (m) => {
        // [RS] Confirm 送出後卡住、程序被 SIGKILL；重啟後 callback，查詢回 1150 → 不得再 Confirm
        lpCtrl({ confirmMode: 'hang' });
        const o = await order(U(3)); const { call } = await lpRequest(o);
        const pend = fetch(cbUrl(call), { redirect: 'manual' }).catch(() => null);
        for (let i = 0; i < 50 && !confirmsFor(call.tx); i++) await sleep(100);
        await killAndRestart(); await pend;
        lpCtrl({ inquiry: '1150' });
        const loc = await callback(call); lpCtrl({});
        const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(confirmsFor(call.tx) === 1 && ['review', 'confirm_pending'].includes(a.status) && rp === 409 && /pending/.test(loc),
          'F1-4 [RS] Confirm 送出後程序被 SIGKILL：重啟後 callback 只做唯讀查詢（回 1150），外部 Confirm 仍 1 次、重新付款被阻擋',
          JSON.stringify({ confirms: confirmsFor(call.tx), st: a.status, repay: rp, loc: loc.slice(0, 60) }));
      });
      await step('F1-5', 'G', async (m) => {
        // 送出前保存失敗 ≠ 已保存且可能送出：當次外部 Confirm 0 次，下一次 callback 可正常送第一次
        lpCtrl({});
        const o = await order(U(4)); const { call } = await lpRequest(o);
        durable({ skip: 0, fail: 1 });
        const loc = await callback(call);
        const d = JSON.parse(fs.readFileSync(DUR, 'utf8')); durable({});
        const c0 = confirmsFor(call.tx); const rp0 = await repay(o);
        const loc2 = await callback(call);
        const x = await ord(o.uuid);
        m.confirms = confirmsFor(call.tx); m.repay = rp0;
        assert(d.failed === 1 && c0 === 0 && !/success/.test(loc) && /linepay=success/.test(loc2) && x.payment_status === 'paid' && confirmsFor(call.tx) === 1,
          'F1-5 [API] Confirm 前 durable 保存失敗：當次外部 Confirm 0 次；下一次 callback 正常送出第一次並完成（全程 1 次）',
          JSON.stringify({ failed: d.failed, c0, confirms: confirmsFor(call.tx), rp0, loc: loc.slice(0, 50), loc2: loc2.slice(0, 50) }));
      });
    }

    // ═══════════════════════ F2：舊付款與重複交易回應 ═══════════════════════
    // [FX] 舊付款：以 /request 建立交易後刪除付款嘗試列，模擬「升級前建立、沒有付款嘗試紀錄」的付款；callback 不帶 attempt
    const legacyFixture = async (u, gatewayPaid) => {
      lpCtrl({});
      const o = await order(u); const { call } = await lpRequest(o);
      await editDb((db) => { db.run('DELETE FROM linepay_payment_attempts WHERE order_uuid=?', [o.uuid]); });
      if (gatewayPaid) setMockTx(call.tx, { confirmed: true, confirmCount: 1 }); // 金流端已在升級前完成付款
      return { o, call };
    };
    if (want('F2')) {
      await step('F2-1', 'D', async (m) => {
        const { o, call } = await legacyFixture(U(11), true);
        lpCtrl({ confirm: '1152' });
        const loc = await callback(call, { legacy: true }); lpCtrl({});
        const a = await attempt(o.uuid); const x = await ord(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(confirmsFor(call.tx) === 0 && x.payment_status === 'paid' && a && a.status === 'paid' && inquiriesFor(call.tx) >= 1 && /linepay=success/.test(loc) && rp === 409,
          'F2-1 [API][FX] 舊付款（沒有可靠處理階段）、金流端已付款、Confirm 會回 1152：不先補送 Confirm，以唯讀查詢確認後完成付款',
          JSON.stringify({ confirms: confirmsFor(call.tx), inq: inquiriesFor(call.tx), a: a && [a.status, a.result_code], pay: x.payment_status, repay: rp, loc: loc.slice(0, 60) }));
      });
      await step('F2-2', 'D', async (m) => {
        const { o, call } = await legacyFixture(U(12), false);
        lpCtrl({ inquiry: 'empty' });
        const loc = await callback(call, { legacy: true }); const loc2 = await callback(call, { legacy: true }); lpCtrl({});
        const a = await attempt(o.uuid); const x = await ord(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(confirmsFor(call.tx) === 0 && a && a.status === 'review' && x.payment_status !== 'paid' && rp === 409 && /pending/.test(loc) && /pending/.test(loc2),
          'F2-2 [API][FX] 舊付款查不到（空清單）：不補送 Confirm、持續待核對、不開放重新付款',
          JSON.stringify({ confirms: confirmsFor(call.tx), a: a && [a.status, a.review_reason], pay: x.payment_status, repay: rp }));
      });
      await step('F2-3', 'D', async (m) => {
        // 新付款：Confirm 回 1152（重複交易），金流端其實已扣款 → 不判未付款；唯讀查詢完整核對成功才完成
        lpCtrl({ confirm: '1152', captureThen: true });
        const o = await order(U(13)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const a = await attempt(o.uuid); const x = await ord(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(confirmsFor(call.tx) === 1 && a.status === 'paid' && x.payment_status === 'paid' && inquiriesFor(call.tx) >= 1 && /success/.test(loc) && rp === 409,
          'F2-3 [API] Confirm 回 1152（重複交易）、金流端已扣款：不判未付款，唯讀查詢完整核對後完成付款（Confirm 1 次）',
          JSON.stringify({ confirms: confirmsFor(call.tx), inq: inquiriesFor(call.tx), a: [a.status, a.result_code], pay: x.payment_status, repay: rp, loc: loc.slice(0, 60) }));
      });
      await step('F2-4', 'D', async (m) => {
        // 新付款：Confirm 回未知代碼、查無資料 → 待核對、重新付款被阻擋（不採「不在模糊清單即確定失敗」）
        lpCtrl({ confirm: '1999', inquiry: 'empty' });
        const o = await order(U(14)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(a.status === 'review' && rp === 409 && /pending/.test(loc) && confirmsFor(call.tx) === 1,
          'F2-4 [API] Confirm 回未知代碼（1999）、查無資料：維持待核對、重新付款被阻擋', JSON.stringify({ a: [a.status, a.result_code, a.review_reason], repay: rp, loc: loc.slice(0, 60) }));
      });
      await step('F2-5', 'G', async (m) => {
        // 新付款：第一次 Confirm 收到官方明確拒絕（1142 餘額不足）→ 確定未扣款，可重新付款（正常流程不被新防護擋住）
        lpCtrl({ confirm: '1142' });
        const o = await order(U(15)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(a.status === 'failed' && String(a.result_code) === '1142' && /linepay=fail/.test(loc) && rp === 200,
          'F2-5 [API] 新付款第一次 Confirm 回 1142（官方明確拒絕）：判定未扣款、顧客可重新付款', JSON.stringify({ a: [a.status, a.result_code], repay: rp, loc: loc.slice(0, 60) }));
      });
    }

    // ═══════════════════════ F3：付款成功資料完整驗證 ═══════════════════════
    if (want('F3')) {
      await step('F3a', 'D', async (m) => {
        const { o, call } = await reviewAfterSent(U(21), 'noType'); lpCtrl({});
        const x = await ord(o.uuid); const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(x.payment_status !== 'paid' && a.status === 'review' && rp === 409, 'F3a [API] 唯讀查詢的交易、訂單、金額、幣別都符合，但缺少 transactionType：不標記已付款、維持待核對',
          JSON.stringify({ pay: x.payment_status, a: [a.status, a.last_inquiry_result], repay: rp }));
      });
      await step('F3a-2', 'D', async (m) => {
        const res = [];
        for (const mode of ['typeEmpty', 'typeNull', 'typeRefund', 'typeNumber', 'multiple', 'amountString', 'amountNull', 'noPayInfo', 'amount', 'currency', 'order', 'refunded']) {
          const { o, call } = await reviewAfterSent(U(22), mode); lpCtrl({});
          const x = await ord(o.uuid); const a = await attempt(o.uuid);
          res.push([mode, x.payment_status === 'paid', a.status, confirmsFor(call.tx)]);
        }
        m.confirms = 'each 1';
        assert(res.every((r) => !r[1] && r[2] === 'review' && r[3] === 1), 'F3a-2 [API] 查詢 transactionType 空字串／null／PARTIAL_REFUND／數字、多筆無法唯一對應、金額為字串／null、缺 payInfo、金額／幣別／訂單不符、已退款：全部不標記已付款',
          JSON.stringify(res));
      });
      await step('F3b', 'D', async (m) => {
        // Confirm 只回 {"returnCode":"0000"}；唯讀查詢失敗 → 不得標成已付款
        lpCtrl({ confirmBody: 'only0000', inquiry: 'error' });
        const o = await order(U(23)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const x = await ord(o.uuid); const a = await attempt(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(x.payment_status !== 'paid' && a.status === 'review' && inquiriesFor(call.tx) >= 1 && /pending/.test(loc) && rp === 409,
          'F3b [API] Confirm 只回 returnCode=0000、沒有 info，且唯讀查詢失敗：不標記已付款、先查詢、維持待核對', JSON.stringify({ pay: x.payment_status, a: a.status, inq: inquiriesFor(call.tx), repay: rp, loc: loc.slice(0, 60) }));
      });
      await step('F3b-2', 'D', async (m) => {
        // Confirm 只回 0000；唯讀查詢完整相符 → 以查詢結果完成（必須有查詢）
        lpCtrl({ confirmBody: 'only0000' });
        const o = await order(U(24)); const { call } = await lpRequest(o);
        const loc = await callback(call); lpCtrl({});
        const x = await ord(o.uuid);
        m.confirms = confirmsFor(call.tx);
        assert(x.payment_status === 'paid' && inquiriesFor(call.tx) >= 1 && confirmsFor(call.tx) === 1 && /success/.test(loc),
          'F3b-2 [API] Confirm 只回 0000、唯讀查詢完整相符：先以查詢核對，再完成付款（Confirm 1 次）', JSON.stringify({ pay: x.payment_status, inq: inquiriesFor(call.tx), loc: loc.slice(0, 60) }));
      });
      await step('F3b-3', 'D', async (m) => {
        // Confirm 0000 但缺 orderId／缺 payInfo／金額為字串／交易識別不同，且查詢失敗 → 全部不標記已付款
        const res = [];
        for (const cb of ['noOrderId', 'noPayInfo', 'amountString', 'txOther']) {
          lpCtrl({ confirmBody: cb, inquiry: 'error' });
          const o = await order(U(25)); const { call } = await lpRequest(o);
          await callback(call); lpCtrl({});
          const x = await ord(o.uuid); const a = await attempt(o.uuid);
          res.push([cb, x.payment_status === 'paid', a.status, inquiriesFor(call.tx)]);
        }
        m.confirms = 'each 1';
        assert(res.every((r) => !r[1] && r[2] === 'review' && r[3] >= 1), 'F3b-3 [API] Confirm 0000 但缺 orderId／缺 payInfo／金額為字串／交易識別不同，查詢失敗：不標記已付款、維持待核對', JSON.stringify(res));
      });
    }

    // ═══════════════════════ F4：不得以「查無＋時間」解除付款阻擋 ═══════════════════════
    if (want('F4')) {
      let f4 = null;
      await step('F4-1', 'D', async (m) => {
        const { o, call } = await reviewAfterSent(U(31), '1150'); lpCtrl({ inquiry: '1150' });
        const a0 = await attempt(o.uuid);
        await editDb((db) => { db.run("UPDATE linepay_payment_attempts SET created_at=datetime('now','-31 minutes'), last_inquiry_at=datetime('now'), last_inquiry_result='not_found:1150' WHERE attempt_uuid=?", [a0.attempt_uuid]); });
        const r = await adm('POST', `/api/linepay-admin/attempts/${a0.attempt_uuid}/mark-unpaid`, { note: '已於商家後台確認無此交易（人工備註）' });
        lpCtrl({});
        const a = await attempt(o.uuid); const rp = await repay(o);
        f4 = { o, call, a0 };
        m.confirms = confirmsFor(call.tx); m.repay = rp; m.api = r.status;
        assert(r.status === 409 && a.status === 'review' && rp === 409 && r.json && /無法確認/.test(r.json.message || ''),
          'F4-1 [API] 待核對 31 分鐘＋最近查詢 not_found:1150＋人工備註，呼叫既有 mark-unpaid API：409、維持待核對、重新付款仍被阻擋',
          JSON.stringify({ api: r.status, msg: r.json && r.json.message, a: a.status, repay: rp }));
      });
      await step('F4-2', 'N', async (m) => {
        if (!browser || !f4) throw new Error('需要瀏覽器與 F4-1');
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        await ctx.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); }, [C.tok]);
        const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.dismiss());
        await pg.goto(C.s.base + '/');
        await pg.waitForFunction(() => typeof loadLinePayReview === 'function', null, { timeout: 15000 });
        await pg.evaluate(() => loadLinePayReview());
        await pg.waitForFunction(() => { const el = document.getElementById('lpReviewPanel'); return el && el.innerHTML.length > 50; }, null, { timeout: 10000 });
        const ui = await pg.evaluate((au) => { const el = document.getElementById('lpReviewPanel'); const row = el.querySelector(`tr[data-attempt="${au}"]`);
          return { text: el.innerText, rowText: row ? row.innerText : '', unpaidBtn: /標記未付款/.test(el.innerHTML) }; }, f4.a0.attempt_uuid);
        m.ui = ui.rowText.slice(0, 80);
        assert(/目前無法確認付款結果，請勿重新付款/.test(ui.text) && !ui.unpaidBtn && !!ui.rowText,
          'F4-2 [BR] 後台待核對面板：顯示「目前無法確認付款結果，請勿重新付款」，不再提供「標記未付款」按鈕', JSON.stringify({ unpaidBtn: ui.unpaidBtn, row: ui.rowText.slice(0, 120), errs: errs.slice(0, 2) }));
        await ctx.close();
      });
    }

    // ═══════════════════════ H：歷史問題紀錄的升級隔離 ═══════════════════════
    if (want('H')) {
      await step('H1', 'N', async (m) => {
        // [FX][RS] 以 C5.2 留下的紀錄形態建立 fixture，重新啟動（遷移）→ 有付款可能者隔離為待核對；正常失敗、已付款不變；再重啟一次結果相同
        lpCtrl({});
        const mk = async (u) => { const o = await order(u); const { call } = await lpRequest(o); return { o, call }; };
        const fx = {};
        for (const k of ['manual', 'dup1152', 'legacy1142', 'trusted1142', 'noTx', 'paid', 'abortedSent', 'abortedNever', 'amountChanged', 'unknownCode']) fx[k] = await mk(U(40));
        lpCtrl({}); await callback(fx.paid.call); // 正常已付款
        await editDb((db) => {
          const set = (k, sql) => db.run(`UPDATE linepay_payment_attempts SET ${sql} WHERE order_uuid=?`, [fx[k].o.uuid]);
          set('manual', "status='failed', result_code='manual_unpaid', review_reason='manual_unpaid:人工', confirm_calls=1, state_version=2");
          set('dup1152', "status='failed', result_code='1152', confirm_calls=1, state_version=2");
          set('legacy1142', "status='failed', result_code='1142', confirm_calls=1, state_version=2, source='legacy_callback'");
          set('trusted1142', "status='failed', result_code='1142', confirm_calls=1, state_version=2");
          set('noTx', "status='failed', result_code='1104', transaction_id='', confirm_calls=0, state_version=2");
          set('abortedSent', "status='aborted_cancelled', review_reason='order_cancelled_before_confirm', confirm_calls=1, state_version=2");
          set('abortedNever', "status='aborted_cancelled', review_reason='order_cancelled_before_confirm', confirm_calls=0, state_version=2");
          set('amountChanged', "status='failed', result_code='amount_changed', confirm_calls=0, state_version=2");
          set('unknownCode', "status='failed', result_code='1999', confirm_calls=1, state_version=2");
          for (const k of ['abortedSent', 'abortedNever']) db.run("UPDATE orders SET order_status='cancelled' WHERE uuid=?", [fx[k].o.uuid]);
          // 讓 fixture 看起來是 C5.2 寫入（C5.3 欄位若存在，還原為升級前狀態）
          const cols = db.exec('PRAGMA table_info(linepay_payment_attempts)')[0].values.map((r) => r[1]);
          if (cols.includes('confirm_state')) db.run("UPDATE linepay_payment_attempts SET confirm_state=NULL WHERE order_uuid IN (" + Object.values(fx).map(() => '?').join(',') + ')', Object.values(fx).map((f) => f.o.uuid));
          if (cols.includes('quarantined_from')) db.run("UPDATE linepay_payment_attempts SET quarantined_from='' WHERE order_uuid IN (" + Object.values(fx).map(() => '?').join(',') + ')', Object.values(fx).map((f) => f.o.uuid));
        });
        // 以 fixture 原本那一筆付款嘗試比較（重新付款檢查可能另建新的付款嘗試）
        const snap = async () => { const out = {}; for (const [k, f] of Object.entries(fx)) { const a = (await attempts(f.o.uuid))[0]; out[k] = [a.status, a.result_code, a.review_reason]; } return out; };
        const s1 = await snap();
        const rp = {}; for (const k of ['manual', 'dup1152', 'legacy1142', 'unknownCode', 'trusted1142']) rp[k] = await repay(fx[k].o);
        await killAndRestart(); // 遷移再跑一次
        const s2 = await snap();
        const quarantined = ['manual', 'dup1152', 'legacy1142', 'abortedSent', 'unknownCode'];
        const kept = ['trusted1142', 'noTx', 'paid', 'abortedNever', 'amountChanged'];
        m.repay = rp;
        assert(quarantined.every((k) => s1[k][0] === 'review' && /quarantine/.test(s1[k][2] || '')) && s1.trusted1142[0] === 'failed' && s1.noTx[0] === 'failed' && s1.paid[0] === 'paid' && s1.abortedNever[0] === 'aborted_cancelled' && s1.amountChanged[0] === 'failed'
          && ['manual', 'dup1152', 'legacy1142', 'unknownCode'].every((k) => rp[k] === 409) && rp.trusted1142 === 200 && JSON.stringify(s1) === JSON.stringify(s2),
        'H1 [FX][RS] 歷史紀錄升級：manual_unpaid、1152 判失敗、舊付款 callback 判失敗、未知代碼判失敗、送過 Confirm 的取消中止 → 隔離為待核對並阻擋重新付款；官方明確拒絕、未送出、已付款不變；重複遷移結果相同',
        JSON.stringify({ s1, repay: rp, idempotent: JSON.stringify(s1) === JSON.stringify(s2), kept: kept.map((k) => s1[k][0]) }));
        m.fx = fx;
        // H2：隔離紀錄可用唯讀查詢恢復（金流端其實已付款 → 完成；取消單 → 已付款・待退款）
        setMockTx(fx.dup1152.call.tx, { confirmed: true }); setMockTx(fx.abortedSent.call.tx, { confirmed: true });
        const c0 = confirmsFor(fx.dup1152.call.tx) + confirmsFor(fx.abortedSent.call.tx);
        await reconcileOne((await attempts(fx.dup1152.o.uuid))[0]); await reconcileOne((await attempts(fx.abortedSent.o.uuid))[0]);
        const x1 = await ord(fx.dup1152.o.uuid), x2 = await ord(fx.abortedSent.o.uuid);
        assert(x1.payment_status === 'paid' && x2.payment_status === 'paid' && x2.order_status === 'cancelled' && x2.refund_status === 'pending_refund' && confirmsFor(fx.dup1152.call.tx) + confirmsFor(fx.abortedSent.call.tx) === c0,
          'H2 [API][FX] 隔離的歷史紀錄以唯讀核對恢復：金流端已付款 → 完成付款；已取消訂單 → 已付款・待退款、維持取消；不送 Confirm',
          JSON.stringify({ x1: x1.payment_status, x2: [x2.payment_status, x2.order_status, x2.refund_status] }));
      });
    }

    // ═══════════════════════ R：付款主流程回歸 ═══════════════════════
    if (want('R')) {
      await step('R1', 'G', async (m) => {
        lpCtrl({});
        const o = await order(U(51)); const { call } = await lpRequest(o);
        const loc = await callback(call); const loc2 = await callback(call);
        const x = await ord(o.uuid); const ev = await events(o.uuid); const rp = await repay(o);
        m.confirms = confirmsFor(call.tx); m.repay = rp;
        assert(x.payment_status === 'paid' && confirmsFor(call.tx) === 1 && ev.purchase === 1 && ev.payment_success === 1 && /success/.test(loc) && /success/.test(loc2) && rp === 409,
          'R1 [API] 完整正常付款：完成付款（Confirm 1 次）、purchase／payment_success 各一次；重複 callback 不增加', JSON.stringify({ confirms: confirmsFor(call.tx), ev, repay: rp }));
      });
      await step('R2', 'G', async (m) => {
        lpCtrl({});
        const o = await order(U(52)); const { call } = await lpRequest(o);
        durable({ skip: 1, fail: 1 });
        const loc = await callback(call); durable({});
        const x0 = await ord(o.uuid); const rp0 = await repay(o);
        const loc2 = await callback(call);
        const x = await ord(o.uuid); const ev = await events(o.uuid);
        m.confirms = confirmsFor(call.tx); m.repay = rp0;
        assert(x0.payment_status !== 'paid' && /pending/.test(loc) && rp0 === 409 && x.payment_status === 'paid' && confirmsFor(call.tx) === 1 && ev.purchase === 1 && /success/.test(loc2),
          'R2 [API] 金流成功、本機提交失敗：顯示確認中、阻擋重新付款；再次 callback 以唯讀查詢恢復（不再 Confirm）', JSON.stringify({ confirms: confirmsFor(call.tx), rp0, pay: x.payment_status }));
      });
      await step('R3', 'G', async (m) => {
        lpCtrl({ confirmDelayMs: 1500 });
        const o = await order(U(53)); const { call } = await lpRequest(o);
        const p = callback(call); await sleep(600);
        await adm('PATCH', `/api/line-orders/online/${o.uuid}/status`, { status: 'cancelled' });
        const loc = await p; lpCtrl({});
        const x = await ord(o.uuid); const ev = await events(o.uuid);
        m.confirms = confirmsFor(call.tx);
        assert(x.order_status === 'cancelled' && x.payment_status === 'paid' && x.refund_status === 'pending_refund' && x.kitchen_status !== 'pending' && !ev.purchase && /paid_cancelled/.test(loc),
          'R3 [API] 付款中取消：保留取消、已付款者標待退款、不恢復出餐、不記購買', JSON.stringify({ st: [x.order_status, x.payment_status, x.refund_status, x.kitchen_status], ev }));
      });
      await step('R4', 'G', async (m) => {
        lpCtrl({});
        const o = await order(U(54)); const { call } = await lpRequest(o);
        await callback(call);
        const x = await ord(o.uuid);
        const rpx = await repay(o);
        m.repay = rpx;
        // 取消單在付款前：callback 不送 Confirm
        const o2 = await order(U(55)); const r2 = await lpRequest(o2);
        await adm('PATCH', `/api/line-orders/online/${o2.uuid}/status`, { status: 'cancelled' });
        const loc = await callback(r2.call);
        assert(x.payment_status === 'paid' && rpx === 409 && confirmsFor(r2.call.tx) === 0 && /order_cancelled/.test(loc),
          'R4 [API] 已付款訂單不能再付款；付款前已取消的訂單 callback 不送 Confirm', JSON.stringify({ rpx, confirms2: confirmsFor(r2.call.tx), loc: loc.slice(0, 60) }));
      });
    }

    // ═══════════════════════ FN：函式層（直接呼叫受測模組，不替換任何函式） ═══════════════════════
    if (want('FN')) {
      await step('FN1', 'N', async () => {
        const LPR = require(path.join(H.ROOT, 'utils', 'linePayRecovery.js'));
        if (typeof LPR.safeParseLinePay !== 'function' || typeof LPR.confirmNeverSent !== 'function') throw new Error('C5.3 函式不存在（新功能）');
        const big = '9123456789012345678';
        const p1 = LPR.safeParseLinePay(`{"returnCode":"0000","info":[{"transactionId":${big},"refundList":[{"refundTransactionId":${big}1}]}]}`);
        const never = LPR.confirmNeverSent;
        const cases = [
          never({ confirm_state: 'never', status: 'requested', confirm_calls: 0 }) === true,
          never({ confirm_state: 'never', status: 'requested', confirm_calls: 1 }) === false,
          never({ confirm_state: 'never', status: 'review', confirm_calls: 0 }) === false,
          never({ confirm_state: 'unknown', status: 'requested', confirm_calls: 0 }) === false,
          never({ confirm_state: 'sent', status: 'confirm_pending', confirm_calls: 1 }) === false,
          never({ confirm_state: null, status: 'requested', confirm_calls: 0 }) === false,
        ];
        assert(p1 && p1.info[0].transactionId === big && p1.info[0].refundList[0].refundTransactionId === big + '1' && cases.every(Boolean)
          && !LPR.DEFINITIVE_DECLINE_CODES.some((c) => ['1145', '1152', '1172', '1179', '1198', '1199', '9000'].includes(c)),
        'FN1 [FN] 19 位交易識別以字串解析（不經 Number）；只有 never＋requested＋confirm_calls=0 視為從未送出；重複／處理中／內部錯誤代碼不在明確拒絕清單',
        JSON.stringify({ tx: p1 && p1.info[0].transactionId, cases }));
      });
    }

    const real = boots.reduce((n, b) => n + b.mf.real(), 0);
    const realPay = fs.readFileSync(LP.real, 'utf8').split('\n').filter(Boolean).length;
    const unexpected = fs.readFileSync(LP.unexpected, 'utf8').split('\n').filter(Boolean);
    const sigBad = lpCalls().filter((c) => c.sig_ok === false).length;
    assert(real === 0 && realPay === 0 && unexpected.length === 0 && sigBad === 0, 'Z 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；替身核對簽章全部正確',
      JSON.stringify({ line: real, linepay: realPay, unexpected, sigBad, mock: lpCalls().length }));
  } catch (e) { console.error(e); H.fail('測試例外', e.stack || e.message); }
  finally { if (browser) { try { await browser.close(); } catch {} } for (const b of boots) { try { await b.s.stop(); } catch {} } }
  const s = H.summary();
  if (GAP.length) console.log('新介面在此版本不存在：' + [...new Set(GAP)].join('、'));
  if (process.env.C53_RESULT_JSON) fs.writeFileSync(process.env.C53_RESULT_JSON, JSON.stringify({ root: H.ROOT, pass: s.passCount, fail: s.failCount, gaps: [...new Set(GAP)], meta: META, results: s.results, calls: lpCalls() }, null, 1));
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
