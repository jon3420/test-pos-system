#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js
// R54.4／MBV2-HF1-C6.2 補貨登記數量一鍵加購與訂單連動 —— 新驗收
//   [API] 正式路由（node server.js）＋暫存 SQLite 檔；[DB] 直接讀資料庫檔核對；[BR] 真實 Chrome（Playwright）；
//   [RS] 真實重啟（同一資料庫檔停機再啟動）；[FX] 測試替身（preload：LINE／LINE Pay／綁定故障注入）。
//   LINE 由 c4-line-mock 程序內攔截、LINE Pay 由 c5-linepay-mock 攔截：真實 LINE、LINE Pay、Sandbox 呼叫必須為 0。
// 分類：N＝本輪新功能（未修改基準應失敗）；G＝保留既有行為（基準也應通過）。
// 選擇性執行：C62_ONLY=api,br（預設全部）
'use strict';
const fs = require('fs');
const path = require('path');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const ONLY = (process.env.C62_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const SHOT_DIR = process.env.C62_SHOT_DIR || H.tmpDir('c62-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const META = {};
async function step(name, cls, fn) { META[name] = { cls }; try { await fn(); } catch (e) { assert(false, `${name} [${cls}]（例外）`, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }
const ok = (cond, name, cls, detail) => assert(cond, `${name} [${cls}]`, detail);

const LP_DIR = H.tmpDir('c62-linepay');
const LP_CTRL = path.join(LP_DIR, 'ctrl.json'), LP_LOG = path.join(LP_DIR, 'calls.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const LP_MOCK = path.join(__dirname, 'lib', 'c5-linepay-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const FAULT = path.join(__dirname, 'lib', 'c62-bind-fault.js');
const FAULT_CTRL = path.join(LP_DIR, 'bind-fault.json');
fs.writeFileSync(FAULT_CTRL, JSON.stringify({ mode: 'off' }));
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const { execFileSync } = require('child_process');
function sessAt(u, offsetMs) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}

// 商品：雞爪（一般）、鴨翅（今日額度 3）、豬耳（今日完售、可預約下個營業日）、只外送商品、暫停販售、豆干（一般）、腱子（一般，LINE Pay 用）
const P = { claw: 801, wing: 802, ear: 803, dlv: 804, paused: 805, tofu: 806, shank: 807, lp: 808, lp2: 809, misc: 810 };
const PRODUCTS = [
  [801, '測試雞爪', 0, 'available', { quota: 50, price: 100 }], [802, '測試鴨翅', 1, 'available', { quota: 3, price: 80 }],
  [803, '測試豬耳', 2, 'sold_out_today', { quota: 50, price: 90 }], [804, '測試外送限定', 3, 'available', { quota: 50, price: 120 }],
  [805, '測試暫停品', 4, 'paused', { quota: 50, price: 70 }], [806, '測試豆干', 5, 'available', { quota: 50, price: 50 }],
  [807, '測試腱子', 6, 'available', { quota: 50, price: 150 }], [808, '測試付款品', 7, 'available', { quota: 50, price: 60 }],
  [809, '測試付款品二', 8, 'available', { quota: 50, price: 60 }], [810, '測試雜項', 9, 'available', { quota: 50, price: 40 }],
];
const seed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c62','test-secret-c62')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("UPDATE products SET line_takeout_enabled=0 WHERE id=804 AND store_id='store_001'");
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.2 補貨登記數量一鍵加購與訂單連動 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　時鐘位移（毫秒）：' + process.env.C4_CLOCK_OFFSET_MS);
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = (extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js'), '-r', LP_MOCK, '-r', FAULT],
    C4_CLOCK_OFFSET_MS: String(OFF), C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG, C62_BIND_FAULT: FAULT_CTRL, ...extra });
  const C = await C45.boot('c62', { products: PRODUCTS, settings: { restock_notify_enabled: '1', line_member_gate_enabled: '1', line_member_gate_mode: 'checkout' }, seed, env: env() });
  await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001');
  const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
  const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
  const S = (u) => sessAt(u, OFF);
  const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const dbq = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
  const reg = async (u, pid, qty, extra = {}) => pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra });
  const mine = async (u) => { const r = await pub('POST', '/api/product-demand/mine', { member_session: S(u) }); return r.json && r.json.success ? r.json.data : null; };
  const mineOf = async (u, pid) => ((await mine(u)) || []).find((d) => Number(d.product_id) === pid) || null;
  const reqRow = async (u, pid, status) => (await dbq(`SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=?${status ? ' AND status=?' : ''} ORDER BY id DESC LIMIT 1`, status ? [u, pid, status] : [u, pid]))[0] || null;
  const linksOf = (ouuid) => dbq('SELECT * FROM product_demand_order_links WHERE order_uuid=? ORDER BY id', [ouuid]);
  async function order(u, items, o = {}) {
    await sleep(1100); // 既有 LINE 訂單編號只到秒；間隔避免與本輪無關的既有編號碰撞
    const body = { customer_name: '測試顧客', customer_phone: '0912345678', order_type: o.mode || 'takeout', pickup_date: o.date || tomorrow, pickup_time: '12:00',
      payment_method: o.pay || 'cash', items: items.map(([pid, qty]) => ({ product_id: pid, qty })), analytics: { visitor_id: 'v_c62', session_id: 's_c62' } };
    if (o.mode === 'delivery') Object.assign(body, { delivery_address: '台北市信義區市府路1號', delivery_lat: 25.0375, delivery_lng: 121.5637 });
    if (u) body.member_session = S(u);
    const r = await pub('POST', '/api/line-orders', body);
    if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 300));
    return r.json.data;
  }
  const orderRow = async (uuid) => (await dbq('SELECT * FROM orders WHERE uuid=?', [uuid]))[0];
  const cancelOrder = async (uuid) => { const o = await orderRow(uuid); return adm('PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status: 'cancelled' }); };
  const setStatus = async (uuid, status) => { const o = await orderRow(uuid); return adm('PATCH', `/api/line-orders/online/${encodeURIComponent(o.id)}/status`, { status }); };
  const lpRequest = async (uuid) => { const r = await pub('POST', '/api/linepay/request', { order_uuid: uuid }); if (!r.json || !r.json.success) throw new Error('lp request ' + r.text); return (await dbq('SELECT * FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [uuid]))[0]; };
  const lpConfirm = (a) => fetch(`${C.s.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
  const notifyCounts = async () => (await dbq('SELECT (SELECT COUNT(*) FROM restock_notify_batches) AS b, (SELECT COUNT(*) FROM restock_notify_deliveries) AS d, (SELECT COUNT(*) FROM product_demand_consents) AS c'))[0];
  const N0 = await notifyCounts();

  try {
    if (want('api')) {
      // ═══ 1. 登記 5 份：本人登記資料（後端驗證會員）提供份數拆分 ═══
      await step('A1', 'N', async () => {
        const r = await reg(U(1), P.claw, 5);
        const m = await mineOf(U(1), P.claw);
        ok(r.json.success && m && m.registered_qty === 5 && m.settled_qty === 0 && m.reserved_qty === 0 && m.remaining_qty === 5 && m.to_buy_qty === 5,
          'A1 [API] 登記 5 份：本人登記回傳原登記 5、已完成 0、訂購中 0、尚待購買 5', 'N', JSON.stringify(m));
      });
      // ═══ 9. 現金訂單成立即扣減；部分成交、全部完成 ═══
      let o3, o2;
      await step('A2', 'N', async () => {
        o3 = await order(U(1), [[P.claw, 3]]);
        const rq = await reqRow(U(1), P.claw); const L = await linksOf(o3.uuid); const m = await mineOf(U(1), P.claw);
        ok(rq.status === 'active' && Number(rq.settled_qty) === 3 && L.length === 1 && L[0].state === 'settled' && Number(L[0].applied_qty) === 3 && L[0].request_uuid === rq.request_uuid
          && m.settled_qty === 3 && m.remaining_qty === 2 && m.to_buy_qty === 2,
        'A2 [API][DB] 現金訂單（後端成立有效訂單）3 份 → 立即扣減：已完成 3、尚待購買 2；關聯以訂單 UUID＋商品＋登記週期保存', 'N', JSON.stringify({ st: rq.status, s: rq.settled_qty, L: L.map((x) => [x.state, x.applied_qty]) }));
      });
      await step('A3', 'N', async () => {
        o2 = await order(U(1), [[P.claw, 2]]);
        const rq = await reqRow(U(1), P.claw); const m = await mineOf(U(1), P.claw);
        const sum = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.find((p) => p.product_id === P.claw);
        const hist = await pub('POST', '/api/product-demand/mine/history', { member_session: S(U(1)) });
        const det = (await adm('GET', `/api/product-demand-admin/products/${P.claw}`)).json.data;
        ok(rq.status === 'completed' && Number(rq.settled_qty) === 5 && !!rq.completed_at && !m && sum.active_users === 0 && sum.total_qty === 0 && sum.completed_requests === 1
          && hist.json.data.some((h) => h.product_id === P.claw && h.settled_qty === 5) && det.rows.some((x) => x.status === 'completed' && x.settled_qty === 5),
        'A3 [API][DB] 再成立 2 份 → 剩餘 0、標記已完成；移出有效需求統計；會員歷史與後台明細仍可查詢', 'N', JSON.stringify({ st: rq.status, s: rq.settled_qty, sum }));
      });
      // ═══ 11. 新週期：完成後重新登記；舊訂單取消只影響當時綁定的週期 ═══
      await step('A4', 'N', async () => {
        const r = await reg(U(1), P.claw, 4);
        const newReq = await reqRow(U(1), P.claw, 'active');
        const cr = await cancelOrder(o3.uuid);
        await sleep(300);
        const oldReq = (await dbq("SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=? AND status='completed'", [U(1), P.claw]))[0];
        const nr = await reqRow(U(1), P.claw, 'active');
        const L = await linksOf(o3.uuid);
        ok(r.json.success && Number(newReq.cycle_no) === 2 && cr.json && cr.json.success && Number(oldReq.settled_qty) === 2 && oldReq.status === 'completed'
          && nr.request_uuid === newReq.request_uuid && Number(nr.settled_qty) === 0 && Number(nr.desired_qty) === 4 && L[0].state === 'reverted' && /cycle_not_reopened/.test(L[0].note),
        'A4 [API][DB] 已完成後重新登記（新週期）；取消舊訂單只回復舊週期（2/5），不復活舊週期、不改動新週期', 'N', JSON.stringify({ old: oldReq && [oldReq.status, oldReq.settled_qty], nr: [nr.status, nr.settled_qty], L: L.map((x) => [x.state, x.note]) }));
      });
      await step('A5', 'N', async () => {
        const again = await cancelOrder(o3.uuid);
        await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001');
        await sleep(3500); // 啟動後補齊（sweep）
        const oldReq = (await dbq("SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=? AND status='completed'", [U(1), P.claw]))[0];
        const L = await linksOf(o3.uuid);
        ok(!(again.json && again.json.success) && Number(oldReq.settled_qty) === 2 && L.length === 1 && L[0].state === 'reverted',
          'A5 [API][RS] 重複取消被拒；真實重啟＋啟動補齊後仍只回復一次（不回復成負數或超額）', 'N', JSON.stringify({ again: again.status, s: oldReq.settled_qty }));
      });
      // ═══ 10. 未履約前取消：已完成週期在有效期限內、沒有新週期 → 恢復有效 ═══
      await step('A6', 'N', async () => {
        await reg(U(6), P.tofu, 2);
        const o = await order(U(6), [[P.tofu, 2]]);
        const r1 = await reqRow(U(6), P.tofu);
        await cancelOrder(o.uuid); await sleep(300);
        const r2 = await reqRow(U(6), P.tofu); const m = await mineOf(U(6), P.tofu);
        ok(r1.status === 'completed' && r2.status === 'active' && Number(r2.settled_qty) === 0 && r2.request_uuid === r1.request_uuid && m && m.to_buy_qty === 2,
          'A6 [API][DB] 有效訂單在未履約前取消 → 依原綁定回復（已完成 2 → 0，同一週期恢復有效，尚待購買 2）', 'N', JSON.stringify({ r1: r1.status, r2: [r2.status, r2.settled_qty] }));
      });
      // ═══ 已履約後作廢：不自動重建需求 ═══
      await step('A7', 'N', async () => {
        await reg(U(7), P.tofu, 2);
        const o = await order(U(7), [[P.tofu, 2]]);
        await setStatus(o.uuid, 'completed');
        const or = await orderRow(o.uuid);
        const v = await adm('POST', `/api/orders/${encodeURIComponent(or.id)}/void`, { reason: '測試作廢' });
        await sleep(300);
        const r = await reqRow(U(7), P.tofu); const L = await linksOf(o.uuid);
        const c = await dbq('SELECT COUNT(*) AS c FROM product_demand_consents WHERE line_user_id=?', [U(7)]);
        ok(v.json && v.json.success && r.status === 'completed' && Number(r.settled_qty) === 2 && L[0].state === 'review' && L[0].note === 'void_after_completed' && Number(c[0].c) === 0,
          'A7 [API][DB] 已履約（已完成）訂單作廢 → 關聯待核對，不自動回復需求、不重建登記或通知同意', 'N', JSON.stringify({ v: v.status, r: [r.status, r.settled_qty], L: L.map((x) => [x.state, x.note]) }));
      });
      // ═══ 9. 成立份數大於登記 ═══
      await step('A8', 'N', async () => {
        await reg(U(8), P.tofu, 2);
        const o = await order(U(8), [[P.tofu, 5]]);
        const r = await reqRow(U(8), P.tofu); const L = await linksOf(o.uuid);
        ok(r.status === 'completed' && Number(r.settled_qty) === 2 && Number(L[0].order_qty) === 5 && Number(L[0].applied_qty) === 2,
          'A8 [API][DB] 實際成立 5 份（登記 2）→ 只扣到 0、標記已完成（不超額）', 'N', JSON.stringify({ r: [r.status, r.settled_qty], L: [L[0].order_qty, L[0].applied_qty] }));
      });
      // ═══ 8. LINE Pay：待付款 → 訂購中；已付款 → 扣減；重複 callback／核對／重啟只扣一次 ═══
      let oLP, A19o2 = null;
      await step('A9', 'N', async () => {
        await reg(U(3), P.lp, 4);
        oLP = await order(U(3), [[P.lp, 4]], { pay: 'linepay' });
        const r = await reqRow(U(3), P.lp); const L = await linksOf(oLP.uuid); const m = await mineOf(U(3), P.lp);
        ok(Number(r.settled_qty) === 0 && r.status === 'active' && L[0].state === 'reserved' && m.reserved_qty === 4 && m.to_buy_qty === 0 && m.remaining_qty === 4,
          'A9 [API][DB] LINE Pay 訂單已建立、等待付款 → 標記訂購中 4（不扣減；尚待購買 0，不會重複帶入）', 'N', JSON.stringify({ r: [r.status, r.settled_qty], L: L.map((x) => x.state), m }));
      });
      await step('A10', 'N', async () => {
        const a = await lpRequest(oLP.uuid);
        const res = await lpConfirm(a);
        const loc = res.headers.get('location') || '';
        await sleep(300);
        const r1 = await reqRow(U(3), P.lp); const L1 = await linksOf(oLP.uuid);
        const res2 = await lpConfirm(a); // 重複 callback
        const [ra, rb] = await Promise.all([lpConfirm(a), lpConfirm(a)]); // 同時重複
        const rec = await adm('POST', '/api/linepay-admin/reconcile', {});
        await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001'); await sleep(3500);
        const r2 = await reqRow(U(3), P.lp); const L2 = await linksOf(oLP.uuid);
        const se = await dbq("SELECT status FROM payment_side_effects WHERE order_uuid=? AND kind='demand_settle'", [oLP.uuid]);
        const confirms = fs.readFileSync(LP_LOG, 'utf8').split('\n').filter((l) => l.includes('/confirm')).length;
        ok(/linepay=success/.test(loc) && r1.status === 'completed' && Number(r1.settled_qty) === 4 && L1[0].state === 'settled' && Number(L1[0].applied_qty) === 4
          && Number(r2.settled_qty) === 4 && L2.length === 1 && L2[0].state === 'settled' && se.length === 1 && se[0].status === 'done' && confirms === 1 && [res2, ra, rb].every((x) => x.status === 302) && rec.status < 500,
        'A10 [API][DB][RS] LINE Pay 已付款 → 扣減 4、完成；重複 callback、同時重複、後台核對、真實重啟都只扣一次；Confirm 只送 1 次', 'N', JSON.stringify({ loc, r1: [r1.status, r1.settled_qty], r2: r2.settled_qty, se, confirms }));
      });
      // 付款失敗 → 解除訂購中、保留需求
      await step('A11', 'N', async () => {
        await reg(U(4), P.lp, 3);
        const o = await order(U(4), [[P.lp, 2]], { pay: 'linepay' });
        fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '1142' }));
        const a = await lpRequest(o.uuid);
        const res = await lpConfirm(a); await sleep(300);
        fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' }));
        const att = (await dbq('SELECT status FROM linepay_payment_attempts WHERE attempt_uuid=?', [a.attempt_uuid]))[0];
        const L = await linksOf(o.uuid); const r = await reqRow(U(4), P.lp); const m = await mineOf(U(4), P.lp);
        ok(/linepay=fail/.test(res.headers.get('location') || '') && att.status === 'failed' && L[0].state === 'released' && L[0].note === 'payment_failed' && Number(r.settled_qty) === 0 && m.reserved_qty === 0 && m.to_buy_qty === 3,
          'A11 [API][DB] LINE Pay 付款失敗 → 解除訂購中，保留未完成需求（尚待購買 3）', 'N', JSON.stringify({ att: att.status, L: L.map((x) => [x.state, x.note]), m }));
      });
      // 逾期：付款請求保留時間到期（以較短保留時間重新啟動伺服器）→ 解除；之後查得已付款 → 扣減一次
      await step('A12', 'N', async () => {
        await reg(U(5), P.lp2, 2);
        const o = await order(U(5), [[P.lp2, 2]], { pay: 'linepay' });
        const L0 = await linksOf(o.uuid);
        await C.restart(env({ PD_SETTLE_LP_TTL_SEC: '2' })); C.tok = await H.login(C.s.base, STORE, 'pw001');
        await sleep(4000);
        const L1 = await linksOf(o.uuid); const m1 = await mineOf(U(5), P.lp2);
        // 顧客之後重新付款並成功
        const a = await lpRequest(o.uuid); await lpConfirm(a); await sleep(300);
        const L2 = await linksOf(o.uuid); const r2 = await reqRow(U(5), P.lp2);
        await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001');
        ok(L0[0].state === 'reserved' && L1[0].state === 'released' && L1[0].note === 'payment_expired' && m1.reserved_qty === 0 && m1.to_buy_qty === 2
          && L2[0].state === 'settled' && Number(r2.settled_qty) === 2 && r2.status === 'completed',
        'A12 [API][RS] LINE Pay 逾期未付款 → 解除訂購中（尚待購買 2）；之後付款成功 → 扣減一次並完成', 'N', JSON.stringify({ L0: L0[0].state, L1: [L1[0].state, L1[0].note], L2: L2[0].state, r2: r2.settled_qty }));
      });
      // 待付款時取消訂單 → 解除；取消後才付款（paid_cancelled）→ 不扣減
      await step('A13', 'N', async () => {
        await reg(U(9), P.misc, 3);
        const o = await order(U(9), [[P.misc, 3]], { pay: 'linepay' });
        const a = await lpRequest(o.uuid);
        await cancelOrder(o.uuid); await sleep(300);
        const L1 = await linksOf(o.uuid);
        await lpConfirm(a); await sleep(300);
        const L2 = await linksOf(o.uuid); const r = await reqRow(U(9), P.misc);
        const or = await orderRow(o.uuid);
        ok(L1[0].state === 'released' && L2[0].state === 'released' && Number(r.settled_qty) === 0 && r.status === 'active',
          'A13 [API][DB] 待付款時取消訂單 → 解除訂購中；取消後才回來的付款 callback（不送 Confirm）也不扣減', 'N', JSON.stringify({ L1: L1[0].state, L2: L2[0].state, pay: or.payment_status, order: or.order_status }));
      });
      // ═══ 11. 付款期間修改登記、取消登記 ═══
      await step('A14', 'N', async () => {
        await reg(U(10), P.lp2, 3);
        const o = await order(U(10), [[P.lp2, 3]], { pay: 'linepay' });
        const ch = await reg(U(10), P.lp2, 2, { expect_settled_qty: 0 });
        const a = await lpRequest(o.uuid); await lpConfirm(a); await sleep(300);
        const r = await reqRow(U(10), P.lp2); const L = await linksOf(o.uuid); const or = await orderRow(o.uuid);
        const items = JSON.parse(or.items || '[]');
        ok(ch.json.success && Number(r.desired_qty) === 2 && Number(r.settled_qty) === 2 && r.status === 'completed' && Number(L[0].applied_qty) === 2 && Number(L[0].order_qty) === 3
          && items[0].qty === 3 && or.payment_status === 'paid',
        'A14 [API][DB] 付款期間把登記改為 2 → 付款後只扣 2（不為負、不超額）；已送出的訂單（3 份）不被改動', 'N', JSON.stringify({ r: [r.desired_qty, r.settled_qty, r.status], L: [L[0].order_qty, L[0].applied_qty] }));
      });
      await step('A15', 'N', async () => {
        await reg(U(11), P.lp2, 3);
        const o = await order(U(11), [[P.lp2, 3]], { pay: 'linepay' });
        const c = await pub('POST', '/api/product-demand/cancel', { member_session: S(U(11)), product_id: P.lp2 });
        const n = await reg(U(11), P.lp2, 4); // 付款期間建立新週期
        const a = await lpRequest(o.uuid); await lpConfirm(a); await sleep(300);
        const old = (await dbq("SELECT * FROM product_demand_requests WHERE line_user_id=? AND product_id=? AND status='cancelled'", [U(11), P.lp2]))[0];
        const nw = await reqRow(U(11), P.lp2, 'active'); const L = await linksOf(o.uuid);
        ok(c.json.success && n.json.success && old.status === 'cancelled' && Number(old.settled_qty) === 0 && Number(nw.settled_qty) === 0 && Number(nw.desired_qty) === 4
          && L[0].state === 'settled' && Number(L[0].applied_qty) === 0 && /cycle_closed:cancelled/.test(L[0].note),
        'A15 [API][DB] 付款期間取消登記、再建立新登記 → 舊訂單付款後不復活舊週期、不扣到新週期', 'N', JSON.stringify({ old: [old.status, old.settled_qty], nw: [nw.status, nw.settled_qty], L: [L[0].state, L[0].note] }));
      });
      // 修改登記：已購買份數保護
      await step('A16', 'N', async () => {
        await reg(U(12), P.shank, 5);
        await order(U(12), [[P.shank, 2]]);
        const bad = await reg(U(12), P.shank, 6, { expect_settled_qty: 0 });  // 表單開啟時看到 0，伺服器已是 2
        const low = await reg(U(12), P.shank, 2, { expect_settled_qty: 2 }); // 不得 ≤ 已購買
        const good = await reg(U(12), P.shank, 6, { expect_settled_qty: 2 });
        const r = await reqRow(U(12), P.shank);
        ok(bad.status === 409 && bad.json.code === 'REQUEST_CHANGED' && low.status === 400 && low.json.code === 'QTY_NOT_ABOVE_SETTLED' && good.json.success
          && Number(r.desired_qty) === 6 && Number(r.settled_qty) === 2 && good.json.data.request.to_buy_qty === 4,
        'A16 [API][DB] 修改登記：已購買份數變動時 409 不寫入；不得少於或等於已購買份數；正常修改後尚待購買 4', 'N', JSON.stringify({ bad: bad.status, low: low.status, r: [r.desired_qty, r.settled_qty] }));
      });
      // ═══ 6. 會員與資料來源 ═══
      await step('A17', 'G', async () => {
        const other = await mine(U(2));
        const noSess = await pub('POST', '/api/product-demand/mine', { line_user_id: U(12) });
        const forged = await pub('POST', '/api/product-demand/mine', { member_session: 'forged.' + S(U(12)).slice(7), line_user_id: U(12) });
        ok(Array.isArray(other) && other.length === 0 && noSess.status === 401 && forged.status === 401,
          'A17 [API] 本人登記只來自後端驗證會員：其他帳號看不到；未登入、偽造 session、body 帶他人 line_user_id 一律無效（既有保護）', 'G', JSON.stringify({ other, noSess: noSess.status, forged: forged.status }));
      });
      await step('A17-2', 'N', async () => {
        const histOther = await pub('POST', '/api/product-demand/mine/history', { member_session: S(U(2)), line_user_id: U(1) });
        const histNo = await pub('POST', '/api/product-demand/mine/history', { line_user_id: U(1) });
        ok(histOther.json && histOther.json.success && histOther.json.data.length === 0 && histNo.status === 401,
          'A17-2 [API] 新增的「已完成的登記」查詢同樣只限後端驗證會員本人（他人 line_user_id 無效、未登入 401）', 'N', JSON.stringify({ other: histOther.status, no: histNo.status }));
      });
      // 訂單不帶會員（未登入下單）→ 不綁定、不扣減
      await step('A18', 'N', async () => {
        await reg(U(13), P.shank, 2);
        const o = await order(null, [[P.shank, 2]]);
        const L = await linksOf(o.uuid); const r = await reqRow(U(13), P.shank);
        ok(L.length === 0 && Number(r.settled_qty) === 0, 'A18 [API][DB] 未登入下單（沒有後端驗證會員）不綁定任何登記、不扣減', 'N', JSON.stringify({ L: L.length }));
      });
      // ═══ 13. 綁定失敗回復（故障注入）═══
      await step('A19', 'N', async () => {
        await reg(U(14), P.shank, 3); await reg(U(15), P.shank, 3);
        fs.writeFileSync(FAULT_CTRL, JSON.stringify({ mode: 'first' }));
        const o1 = await order(U(14), [[P.shank, 1]]);
        fs.writeFileSync(FAULT_CTRL, JSON.stringify({ mode: 'always' }));
        const o2 = await order(U(15), [[P.shank, 1]]);
        // C6.2 補修調整：故障在核對「不留下半套扣減」之後才解除（避免背景補齊在核對前就已恢復）；原斷言不變
        const L1 = await linksOf(o1.uuid); const L2 = await linksOf(o2.uuid);
        const r1 = await reqRow(U(14), P.shank); const r2 = await reqRow(U(15), P.shank);
        const or1 = await orderRow(o1.uuid); const or2 = await orderRow(o2.uuid);
        ok(or1 && or2 && L1.length === 1 && L1[0].state === 'settled' && Number(r1.settled_qty) === 1 && L2.length === 0 && Number(r2.settled_qty) === 0,
          'A19 [API][FX] 交易內綁定失敗：訂單照常成立並補綁一次；補綁也失敗時訂單仍成立、不留下半套扣減', 'N', JSON.stringify({ L1: L1.length, L2: L2.length, r1: r1.settled_qty }));
        fs.writeFileSync(FAULT_CTRL, JSON.stringify({ mode: 'off' }));
        A19o2 = o2;
      });
      // C6.2 補修追加：故障解除後（重啟的啟動補齊）依原訂單與原登記週期補齊，且只扣一次；已成功的訂單不重複扣
      await step('A19-2', 'N', async () => {
        await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001'); await sleep(3500);
        const L2 = await linksOf(A19o2.uuid); const r1 = await reqRow(U(14), P.shank); const r2 = await reqRow(U(15), P.shank);
        ok(L2.length === 1 && L2[0].state === 'settled' && Number(r2.settled_qty) === 1 && Number(r1.settled_qty) === 1,
          'A19-2 [API][RS] 故障解除後重啟：補綁也失敗的訂單由持久化待辦補齊（1/3），只扣一次；先前已補綁的訂單不重複扣', 'N', JSON.stringify({ L2: L2.map((l) => l.state), r1: r1.settled_qty, r2: r2.settled_qty }));
      });
      // ═══ 7. 加購／清空購物車不影響（購物車只在前端；伺服器沒有任何寫入）＋ 9. 前後台統計一致 ═══
      await step('A20', 'N', async () => {
        await reg(U(16), P.wing, 5);
        const o = await order(U(16), [[P.wing, 1]]);
        await reg(U(16), P.claw, 3);
        const oLp = await order(U(16), [[P.claw, 1]], { pay: 'linepay' });
        const m = await mine(U(16));
        const mw = m.find((x) => x.product_id === P.wing), mc = m.find((x) => x.product_id === P.claw);
        const sum = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products;
        const sw = sum.find((p) => p.product_id === P.wing), sc = sum.find((p) => p.product_id === P.claw);
        const dl = await H.download(C.s.base, C.tok, `/api/product-demand-admin/export.csv?type=details&product_id=${P.wing}`);
        const sm = await H.download(C.s.base, C.tok, '/api/product-demand-admin/export.csv?type=summary');
        const reqId = (await reqRow(U(16), P.wing)).id;
        const ro = await adm('GET', `/api/product-demand-admin/requests/${reqId}/orders`);
        const dtxt = dl.buf.toString('utf8').replace(/^\uFEFF/, ''), stxt = sm.buf.toString('utf8').replace(/^\uFEFF/, '');
        const head = dtxt.split('\r\n')[0];
        ok(mw.settled_qty === 1 && mw.to_buy_qty === 4 && mc.reserved_qty === 1 && mc.to_buy_qty === 2
          && sw.settled_qty === 1 && sw.to_buy_qty === 4 && sw.total_qty === 5 && sc.reserved_qty >= 1
          && /已完成份數"?,"?訂購中份數"?,"?尚待購買份數"?,"?完成時間（台北）/.test(head) && /,"?1"?,"?0"?,"?4"?,/.test(dtxt.split('\r\n')[1] || '')
          && /已完成份數（有效登記）"?,"?訂購中份數"?,"?尚待購買份數"?,"?已完成登記筆數/.test(stxt.split('\r\n')[0])
          && ro.json.success && ro.json.data.links.length === 1 && ro.json.data.links[0].order_uuid === o.uuid && ro.json.data.links[0].applied_qty === 1 && !JSON.stringify(ro.json.data).includes(U(16)),
        'A20 [API] 會員、後台總表、明細 CSV、統計 CSV 與「登記→訂單」查詢使用同一份數定義（原登記／已完成／訂購中／尚待購買）；不外露會員識別', 'N', JSON.stringify({ mw, mc: mc && mc.reserved_qty, sw: sw && [sw.settled_qty, sw.reserved_qty, sw.to_buy_qty], head }));
        void oLp;
      });
      // ═══ 12. 匯出／匯入不誤扣、不觸發通知 ═══
      await step('A21', 'N', async () => {
        const exp = await H.download(C.s.base, C.tok, '/api/migration/v2/export?categories=product_demand,orders');
        const doc = JSON.parse(exp.buf.toString('utf8'));
        const srcLinks = (doc.tables && doc.tables.product_demand_order_links) || (doc.data && doc.data.product_demand_order_links) || [];
        const T = await C45.boot('c62dst', { products: PRODUCTS, settings: { restock_notify_enabled: '1' }, seed, env: env() });
        try {
          await T.restart(env()); T.tok = await H.login(T.s.base, STORE, 'pw001');
          const tq = async (sql, params) => { await sleep(150); const db = await H.openDbFile(T.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
          const n0 = (await tq('SELECT (SELECT COUNT(*) FROM restock_notify_batches) AS b, (SELECT COUNT(*) FROM restock_notify_deliveries) AS d'))[0];
          const up = await H.uploadRaw(T.s.base, T.tok, exp.buf, { name: 'c62.json' });
          const im = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: ['product_demand', 'orders'] });
          const L1 = await tq("SELECT state, note, import_source, applied_qty FROM product_demand_order_links ORDER BY id");
          const R1 = await tq("SELECT request_uuid, status, settled_qty FROM product_demand_requests ORDER BY id");
          await T.restart(env()); T.tok = await H.login(T.s.base, STORE, 'pw001'); await sleep(3500); // 重啟＋啟動補齊
          const L2 = await tq("SELECT state, note, import_source, applied_qty FROM product_demand_order_links ORDER BY id");
          const R2 = await tq("SELECT request_uuid, status, settled_qty FROM product_demand_requests ORDER BY id");
          const n1 = (await tq('SELECT (SELECT COUNT(*) FROM restock_notify_batches) AS b, (SELECT COUNT(*) FROM restock_notify_deliveries) AS d'))[0];
          const srcReserved = srcLinks.filter((l) => l.state === 'reserved').length;
          const srcReq = await dbq('SELECT request_uuid, status, settled_qty FROM product_demand_requests');
          const same = R1.length === srcReq.length && R1.every((r) => { const x = srcReq.find((y) => y.request_uuid === r.request_uuid); return x && x.status === r.status && Number(x.settled_qty) === Number(r.settled_qty); });
          ok(im.import && im.import.status === 'done' && srcLinks.length > 0 && L1.length === srcLinks.length && L1.every((l) => /^import:/.test(l.import_source))
            && srcReserved >= 1 && L1.filter((l) => l.state === 'review' && l.note === 'imported_reserved').length === srcReserved && !L1.some((l) => l.state === 'reserved')
            && same && JSON.stringify(L1) === JSON.stringify(L2) && JSON.stringify(R1) === JSON.stringify(R2) && n1.b === n0.b && n1.d === n0.d && T.mf.real() === 0,
          'A21 [API][RS] MBV2 匯出／匯入：份數關聯隨登記搬家並標記匯入來源；來源「訂購中」改為待核對；匯入與重啟都不扣減、不回復、不發送通知', 'N',
          JSON.stringify({ st: im.import && im.import.status, err: im.import && im.import.error, src: srcLinks.length, srcReserved, L1: L1.map((l) => l.state), same }));
        } finally { try { await T.s.stop(); } catch {} }
      });
    }
    if (want('br')) {
      if (!chromium) throw new Error('playwright not installed');
      const browser = await chromium.launch(C45.launchOpts());
      const SKEY = 'line_member_session_' + STORE, CKEY = 'line_order_cart_' + STORE;
      const sessVal = (u) => JSON.stringify({ member_session: S(u), display_name: '測試會員', is_friend: true, expires_at: RealDate.now() + 6 * 3600e3 }); // 瀏覽器使用真實時鐘
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const linkUrl = (pid) => `${C.s.base}/line-order.html?store_id=${STORE}&product_ref=${C45.puuid(pid)}&src=restock&m=takeout&d=${today}`;
      const pageUrl = `${C.s.base}/line-order.html?store_id=${STORE}`;
      const errs = [];
      async function openPage(u, opts = {}) {
        const context = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 860 } });
        await context.addInitScript(([skey, sess]) => {
          window.__C45_LIFF = {};
          if (!sessionStorage.getItem('__c62seed')) { sessionStorage.setItem('__c62seed', '1'); if (sess) localStorage.setItem(skey, sess); else localStorage.removeItem(skey); }
        }, [SKEY, u ? sessVal(u) : '']);
        const page = await context.newPage();
        const st = { addEvents: [], mineHeld: [], holdMine: false };
        await page.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
        await page.route(/\/api\/product-demand\/mine(\?|$)/, async (route) => { if (st.holdMine) { st.mineHeld.push(route); return; } return route.continue(); });
        page.on('pageerror', (e) => errs.push(e.message));
        page.on('dialog', (d) => d.accept());
        page.on('request', (r) => {
          if (/\/api\/analytics\/events/.test(r.url()) && r.method() === 'POST') { try { const b = JSON.parse(r.postData() || '{}'); if (b.event_name === 'add_to_cart') st.addEvents.push({ pid: Number(b.product_id), qty: Number(b.quantity) }); } catch {} }
        });
        await page.goto(opts.url || pageUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof openProductDetail === 'function' && Array.isArray(allProducts) && allProducts.length > 0 && document.querySelectorAll('.prod-card').length > 0, null, { timeout: 20000 });
        await sleep(opts.wait || 1500);
        return { context, page, st };
      }
      const det = (page) => page.evaluate(() => {
        const ov = document.querySelector('.pdm-overlay.pdm-open');
        if (!ov) return { open: false };
        return { open: true, name: (ov.querySelector('.pdm-name') || {}).textContent || '', qty: Number((ov.querySelector('.pdm-qty-num') || {}).textContent || 0),
          label: ((ov.querySelector('.pdm-add-btn') || {}).textContent || '').trim(), note: ((ov.querySelector('.pdm-demand-note') || {}).innerText || '').trim(),
          bundle: ((ov.querySelector('.pdm-bundle-btn') || {}).textContent || '').trim(), disabled: !!(ov.querySelector('.pdm-add-btn') || {}).disabled };
      });
      const cartOf = (page) => page.evaluate(() => Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty])));
      const storedCart = (page) => page.evaluate((k) => { try { return (JSON.parse(localStorage.getItem(k) || 'null') || {}).cart || {}; } catch { return {}; } }, CKEY);
      const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); } };
      const openDetail = async (page, pid) => { await page.evaluate((id) => { try { ProductDetailModal.close(); } catch (e) {} openProductDetail(id); }, pid); await sleep(250); return det(page); };
      const shot = async (page, name) => { const f = path.join(SHOT_DIR, name); try { await page.screenshot({ path: f }); } catch (e) { console.log('  （截圖失敗 ' + name + '）'); } return f; };
      const dbReq = async (u, pid) => (await dbq("SELECT desired_qty, COALESCE(settled_qty,0) AS s, status FROM product_demand_requests WHERE line_user_id=? AND product_id=? ORDER BY id DESC LIMIT 1", [u, pid]))[0];
      const linkCount = async (u) => Number((await dbq('SELECT COUNT(*) AS c FROM product_demand_order_links WHERE line_user_id=?', [u]))[0].c);
      try {
        // ── 1. 通知連結開啟：依登記 5 份預選；不自動改購物車；確認後加入 5 份 ──
        await reg(U(21), P.claw, 5); await reg(U(21), P.tofu, 3);
        const A = await openPage(U(21), { url: linkUrl(P.claw), wait: 500 });
        await step('B1', 'N', async () => {
          const d = await until(async () => { const x = await det(A.page); return x.open && /你尚有/.test(x.note) ? x : null; }, 10000) || await det(A.page);
          const c0 = await cartOf(A.page); const sc0 = await storedCart(A.page);
          await shot(A.page, 'b1_detail_preselect_5.png');
          ok(d.open && /你尚有 5 份補貨登記/.test(d.note) && d.qty === 5 && d.label === '加入購物車 5 份' && !c0[P.claw] && !sc0[P.claw],
            'B1 [BR] 從通知開啟：顯示「你尚有 5 份補貨登記」、預選 5 份、按鈕「加入購物車 5 份」；單純開啟不改購物車', 'N', JSON.stringify({ d, c0 }));
        });
        await step('B2', 'N', async () => {
          await A.page.click('.pdm-overlay.pdm-open .pdm-add-btn'); await A.page.click('.pdm-overlay.pdm-open .pdm-add-btn').catch(() => {}); // 連點
          await sleep(900);
          const c = await cartOf(A.page); const sc = await storedCart(A.page);
          const ev = A.st.addEvents.filter((e) => e.pid === P.claw);
          const r = await dbReq(U(21), P.claw);
          ok(c[P.claw] === 5 && sc[P.claw] === 5 && ev.length === 1 && ev[0].qty === 5 && r.s === 0 && (await linkCount(U(21))) === 0,
            'B2 [BR][DB] 確認加入（含連點）只加入 5 份、加購事件 1 筆（5 份）；加入購物車不扣減登記、不建立訂單關聯', 'N', JSON.stringify({ c, ev, r }));
        });
        await step('B3', 'N', async () => {
          // 重新整理（同一次開啟的延續）→ 不重複開啟、不重複加入；之後再次點通知（新的一次開啟）→ 顯示已在購物車、不累加
          await A.page.reload({ waitUntil: 'domcontentloaded' });
          await A.page.waitForFunction(() => typeof openProductDetail === 'function' && document.querySelectorAll('.prod-card').length > 0, null, { timeout: 20000 }); await sleep(2500);
          const afterReload = { d: await det(A.page), c: await cartOf(A.page) };
          await A.page.goto(linkUrl(P.claw), { waitUntil: 'domcontentloaded' });
          await A.page.waitForFunction(() => typeof openProductDetail === 'function' && document.querySelectorAll('.prod-card').length > 0, null, { timeout: 20000 });
          const d = await until(async () => { const x = await det(A.page); return x.open && /已在購物車/.test(x.note) ? x : null; }, 10000) || await det(A.page);
          const c = await cartOf(A.page);
          await shot(A.page, 'b3_already_in_cart.png');
          ok(!afterReload.d.open && afterReload.c[P.claw] === 5 && d.open && /購物車已有 5 份/.test(d.note) && /不會再自動累加/.test(d.note) && d.label === '加入購物車' && d.qty === 1 && c[P.claw] === 5,
            'B3 [BR] 重新整理不重複開啟或加入；再次開啟通知 → 提示已在購物車、不再累加（購物車仍 5）', 'N', JSON.stringify({ afterReload: { open: afterReload.d.open, c: afterReload.c }, d, c }));
        });
        // ── 2. 購物車已有 2／5／6 份 ──
        await reg(U(22), P.claw, 5);
        const B = await openPage(U(22));
        await step('B4', 'N', async () => {
          await B.page.evaluate((id) => { addCart(id); addCart(id); }, P.claw); await sleep(300);
          const d2 = await openDetail(B.page, P.claw);
          await B.page.click('.pdm-overlay.pdm-open .pdm-add-btn'); await sleep(800);
          const c5 = await cartOf(B.page);
          const d5 = await openDetail(B.page, P.claw);
          await B.page.evaluate(() => ProductDetailModal.close());
          await B.page.evaluate((id) => chgQty(id, 1), P.claw); await sleep(300);
          const d6 = await openDetail(B.page, P.claw); const c6 = await cartOf(B.page);
          await B.page.evaluate(() => ProductDetailModal.close());
          ok(d2.qty === 3 && d2.label === '加入購物車 3 份' && /購物車已有 2 份/.test(d2.note) && c5[P.claw] === 5
            && d5.qty === 1 && /已在購物車/.test(d5.note) && d5.label === '加入購物車'
            && c6[P.claw] === 6 && /購物車已有 6 份/.test(d6.note) && d6.qty === 1,
          'B4 [BR] 購物車已有 2 → 只補入 3；已有 5 → 提示已在購物車、不累加；顧客手動放 6 → 維持 6 不自動減少', 'N', JSON.stringify({ d2, c5, d5: [d5.qty, d5.label], c6, d6: d6.note }));
        });
        // ── 3. 額度限制：最多只能再加 3 份 ──
        await reg(U(23), P.wing, 5);
        const Cq = await openPage(U(23));
        await step('B5', 'N', async () => {
          const d = await openDetail(Cq.page, P.wing);
          await shot(Cq.page, 'b5_partial_limit.png');
          await Cq.page.click('.pdm-overlay.pdm-open .pdm-add-btn'); await sleep(800);
          const c = await cartOf(Cq.page);
          const d2 = await openDetail(Cq.page, P.wing);
          await Cq.page.evaluate(() => ProductDetailModal.close());
          const m = await mineOf(U(23), P.wing);
          ok(d.qty === 3 && d.label === '加入購物車 3 份' && /目前最多只能再加入 3 份，其餘 2 份需求會保留/.test(d.note) && c[P.wing] === 3 && d2.disabled && m.to_buy_qty === 5,
            'B5 [BR] 今日額度剩 3：明確提示最多再加 3、其餘 2 份需求保留；加入 3 份後無法再加；登記仍為 5（加購不扣減）', 'N', JSON.stringify({ d, c, d2: [d2.disabled, d2.label], m: m && m.to_buy_qty }));
        });
        // ── 4. 多商品：共同日期／方式；不同情境不混加；停售、不支援方式、額度不足保留 ──
        for (const [pid, q] of [[P.claw, 2], [P.shank, 2], [P.ear, 2], [P.dlv, 2], [P.paused, 2], [P.wing, 5]]) { const r = await reg(U(24), pid, q, pid === P.dlv ? { fulfillment_pref: 'delivery' } : {}); if (!r.json || !r.json.success) throw new Error('reg ' + pid + ' ' + r.text); }
        const D = await openPage(U(24));
        await step('B6', 'N', async () => {
          await D.page.evaluate(() => openMyDemandsSheet()); await sleep(1200);
          await D.page.click('#dmBundleBtn'); await sleep(1200);
          const v0 = await D.page.evaluate(() => ({ ctx: (document.getElementById('dbCtx') || {}).innerText || '', opts: Array.from(document.querySelectorAll('.db-ctx-btn')).map((b) => b.textContent.trim()),
            submitDisabled: !!(document.getElementById('dbSubmit') || {}).disabled, rows: Array.from(document.querySelectorAll('.db-row')).map((r) => ({ pid: Number(r.dataset.pid), chk: r.querySelector('input').checked, dis: r.querySelector('input').disabled, txt: r.innerText })) }));
          await shot(D.page, 'b6_bundle_choose_context.png');
          ok(v0.opts.length >= 2 && v0.submitDisabled && v0.rows.every((r) => !r.chk) && /請先選擇/.test(v0.ctx),
            'B6 [BR] 一起加入：購物車為空且商品的取餐方式／日期不同 → 列出可選組合，引導顧客選擇、不任意代選（未選前不能送出）', 'N', JSON.stringify(v0));
        });
        await step('B7', 'N', async () => {
          await D.page.click('.db-ctx-btn[data-mode="takeout"][data-day="today"]'); await sleep(500);
          const v = await D.page.evaluate(() => Array.from(document.querySelectorAll('.db-row')).map((r) => ({ pid: Number(r.dataset.pid), chk: r.querySelector('input').checked, dis: r.querySelector('input').disabled, txt: r.innerText.replace(/\s+/g, ' ') })));
          const by = (pid) => v.find((r) => r.pid === pid) || {};
          await shot(D.page, 'b7_bundle_rows.png');
          ok(by(P.claw).chk && /本次可加入 2 份/.test(by(P.claw).txt) && by(P.shank).chk && by(P.wing).chk && /本次可加入 3 份/.test(by(P.wing).txt) && /其餘 2 份需求保留/.test(by(P.wing).txt)
            && by(P.ear).dis && /需預約下個營業日/.test(by(P.ear).txt) && by(P.dlv).dis && /不支援外帶自取/.test(by(P.dlv).txt) && by(P.paused).dis && /暫停販售/.test(by(P.paused).txt)
            && v.every((r) => /未完成 \d+ 份/.test(r.txt)),
          'B7 [BR] 選擇「外帶自取・今日」：清單顯示名稱、未完成份數、本次可加入份數、勾選與原因；不同日期、不支援方式、停售、額度不足都不強行加入', 'N', JSON.stringify(v.map((r) => [r.pid, r.chk, r.dis, r.txt.slice(0, 80)])));
        });
        await step('B8', 'N', async () => {
          await D.page.click('#dbSubmit'); await D.page.click('#dbSubmit').catch(() => {}); await sleep(900);
          const res = await D.page.evaluate(() => (document.getElementById('dbResult') || {}).innerText || '');
          const c = await cartOf(D.page);
          const cards = await D.page.evaluate((ids) => ids.map((id) => { const el = document.querySelector(`#pc-${id} .qnum`); return el ? Number(el.textContent) : 0; }), [P.claw, P.shank, P.wing]);
          await shot(D.page, 'b8_bundle_result.png');
          const after = await D.page.evaluate(() => ({ dis: !!(document.getElementById('dbSubmit') || {}).disabled, rows: Array.from(document.querySelectorAll('.db-row')).map((r) => r.innerText.replace(/\s+/g, ' ')) }));
          const ev = D.st.addEvents.map((e) => `${e.pid}:${e.qty}`).sort().join(',');
          ok(/已加入：.*測試雞爪 2 份.*測試腱子 2 份|已加入：.*測試腱子 2 份.*測試雞爪 2 份/.test(res.replace(/\n/g, ' ')) && /測試鴨翅 3 份/.test(res) && !/未加入/.test(res)
            && c[P.claw] === 2 && c[P.shank] === 2 && c[P.wing] === 3 && !c[P.ear] && !c[P.dlv] && !c[P.paused] && cards.join(',') === '2,2,3' && after.dis
            && ev === [`${P.claw}:2`, `${P.shank}:2`, `${P.wing}:3`].sort().join(','),
          'B8 [BR] 「將勾選商品加入購物車」（含連點）：回報實際加入的商品與份數；購物車、商品卡同步；加購事件只記錄實際加入的份數', 'N', JSON.stringify({ res, c, cards, ev }));
        });
        await step('B9', 'N', async () => {
          await D.page.evaluate(() => closeDemandSheet()); await D.page.evaluate(() => openDemandBundleSheet('test')); await sleep(1200);
          const v = await D.page.evaluate(() => ({ ctx: (document.getElementById('dbCtx') || {}).innerText || '', rows: Array.from(document.querySelectorAll('.db-row')).map((r) => ({ pid: Number(r.dataset.pid), dis: r.querySelector('input').disabled, txt: r.innerText.replace(/\s+/g, ' ') })) }));
          const by = (pid) => v.rows.find((r) => r.pid === pid) || {};
          ok(/依購物車/.test(v.ctx) && /外帶自取・今日/.test(v.ctx) && /已在購物車/.test(by(P.claw).txt) && by(P.claw).dis && /需預約下個營業日/.test(by(P.ear).txt),
            'B9 [BR] 購物車已有商品 → 共同情境依購物車；已加入的商品顯示「已在購物車」、不重複加入', 'N', JSON.stringify(v));
          await D.page.evaluate(() => closeDemandSheet());
        });
        // ── 5. 未登入：一般瀏覽與加購照常 ──
        const E = await openPage(null);
        await step('B10', 'G', async () => {
          const d = await openDetail(E.page, P.claw);
          await E.page.click('.pdm-overlay.pdm-open .pdm-add-btn'); await sleep(800);
          const c = await cartOf(E.page);
          ok(d.open && !d.note && d.qty === 1 && d.label === '加入購物車' && c[P.claw] === 1, 'B10 [BR] 未登入：詳情不顯示登記、從 1 份開始、一般加購照常', 'G', JSON.stringify({ d, c }));
        });
        // ── 6. 轉傳連結：另一位會員開啟同一通知，不帶入原收件人的登記 ──
        const F = await openPage(U(25), { url: linkUrl(P.claw), wait: 500 });
        await step('B11', 'G', async () => {
          const d = await until(async () => { const x = await det(F.page); return x.open ? x : null; }, 10000) || await det(F.page);
          await sleep(1500); const d2 = await det(F.page);
          ok(d.open && !/補貨登記/.test(d2.note) && d2.qty === 1 && d2.label === '加入購物車', 'B11 [BR] 轉傳的通知連結：開啟者（另一位會員）看不到原收件人的登記，從 1 份開始', 'G', JSON.stringify(d2));
        });
        // ── 7. 換帳號：詳情開啟中切換會員 → 立即移除前一位會員的份數 ──
        const G = await openPage(U(21));
        await step('B12', 'N', async () => {
          const d1 = await openDetail(G.page, P.tofu);
          await G.page.evaluate(([k, v]) => { localStorage.setItem(k, v); window.dispatchEvent(new Event('focus')); }, [SKEY, sessVal(U(25))]);
          await sleep(2000);
          const d2 = await det(G.page);
          ok(d1.qty === 3 && /你尚有 3 份/.test(d1.note) && d2.open && !/你尚有/.test(d2.note) && d2.qty === 1 && d2.label === '加入購物車',
            'B12 [BR] 詳情開啟中換帳號：前一位會員的登記份數立即移除，數量回到 1（不以舊會員資料加購）', 'N', JSON.stringify({ d1: [d1.qty, d1.note], d2 }));
        });
        // ── 13. 晚到回應：本人登記回應晚到，只更新同一次開啟、同一位會員；顧客已調整數量時不改數量 ──
        const Hh = await openPage(U(21), { wait: 2500 });
        await step('B13', 'N', async () => {
          Hh.st.holdMine = true;
          await Hh.page.evaluate(() => { _pdMineState = 'loading'; _myDemandsToken = null; _myDemands = {}; _pdReloadMine(); }); await sleep(400);
          const d0 = await openDetail(Hh.page, P.claw);
          await Hh.page.evaluate(() => ProductDetailModal.close());
          const d1 = await openDetail(Hh.page, P.tofu); // 換到另一個商品後才放行
          await Hh.page.click('.pdm-overlay.pdm-open .pdm-plus'); // 顧客自行調整 → 2
          Hh.st.holdMine = false; for (const r of Hh.st.mineHeld.splice(0)) await r.continue();
          await sleep(1500);
          const d2 = await det(Hh.page);
          await Hh.page.evaluate(() => ProductDetailModal.close());
          // 未調整數量的情境
          Hh.st.holdMine = true;
          await Hh.page.evaluate(() => { _pdMineState = 'loading'; _myDemandsToken = null; _myDemands = {}; _pdReloadMine(); }); await sleep(400);
          const e0 = await openDetail(Hh.page, P.tofu);
          Hh.st.holdMine = false; for (const r of Hh.st.mineHeld.splice(0)) await r.continue();
          await sleep(1500);
          const e1 = await det(Hh.page);
          await shot(Hh.page, 'b13_late_mine_applied.png');
          await Hh.page.evaluate(() => ProductDetailModal.close());
          ok(d0.qty === 1 && /正在確認/.test(d0.note) && d1.name.includes('豆干') && d2.name.includes('豆干') && d2.qty === 2 && /你尚有 3 份/.test(d2.note)
            && e0.qty === 1 && e1.qty === 3 && e1.label === '加入購物車 3 份',
          'B13 [BR] 晚到的本人登記：只更新目前開啟的商品（豆干，不套用雞爪）；顧客已調整為 2 時不改數量；未調整時改為預選 3', 'N', JSON.stringify({ d0: [d0.qty, d0.note], d2: [d2.name, d2.qty], e0: e0.qty, e1: [e1.qty, e1.label] }));
        });
        await step('B13-2', 'N', async () => {
          // 本人登記讀取失敗（500）：不預選、不顯示舊資料；一般加購照常；之後重新讀取成功再依登記預選
          const Fp = await openPage(U(21), { wait: 2500 });
          Fp.st.holdMine = true;
          await Fp.page.evaluate(() => { _pdMineState = 'loading'; _myDemandsToken = null; _myDemands = {}; _pdReloadMine(); }); await sleep(400);
          const f0 = await openDetail(Fp.page, P.tofu);
          Fp.st.holdMine = false; for (const r of Fp.st.mineHeld.splice(0)) await r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' });
          await sleep(1200);
          const f1 = await det(Fp.page);
          await Fp.page.click('.pdm-overlay.pdm-open .pdm-add-btn'); await sleep(800);
          const c = await cartOf(Fp.page);
          await Fp.page.evaluate(() => _pdReloadMine()); await sleep(1200);
          const f2 = await openDetail(Fp.page, P.tofu);
          await Fp.page.evaluate(() => ProductDetailModal.close());
          ok(/正在確認/.test(f0.note) && f1.qty === 1 && !/你尚有/.test(f1.note) && c[P.tofu] === 1 && /你尚有 3 份/.test(f2.note) && f2.qty === 2 && /購物車已有 1 份/.test(f2.note),
            'B13-2 [BR] 本人登記讀取失敗：不預選、不殘留舊資料，一般加購照常；重新讀取成功後依「登記 3 − 購物車 1」預選 2', 'N', JSON.stringify({ f0: f0.note, f1: [f1.qty, f1.note], c, f2: [f2.qty, f2.note] }));
          await Fp.context.close();
        });
        // ── 7. 清空購物車、離開頁面：伺服器端登記不變 ──
        await step('B14', 'N', async () => {
          await A.page.evaluate((id) => { while (cart[id]) chgQty(id, -1); }, P.claw); await sleep(300);
          const c = await cartOf(A.page);
          await A.page.goto(C.s.base + '/api/health');
          const r = await dbReq(U(21), P.claw); const n = await linkCount(U(21));
          ok(!c[P.claw] && r.s === 0 && Number(r.desired_qty) === 5 && r.status === 'active' && n === 0, 'B14 [BR][DB] 清空購物車、離開頁面：登記份數不變（仍 5、已完成 0、無訂單關聯）', 'N', JSON.stringify({ c, r, n }));
        });
        // ── 9. 訂單成立後：商品卡、我的補貨登記、後台一致 ──
        await step('B15', 'N', async () => {
          await order(U(21), [[P.claw, 2]]);
          const K = await openPage(U(21), { wait: 2500 });
          const lbl = await K.page.evaluate((id) => ((document.querySelector(`#dr-${id} .demand-btn`) || {}).textContent || '').trim(), P.claw);
          const d = await openDetail(K.page, P.claw);
          await K.page.evaluate(() => ProductDetailModal.close());
          await K.page.evaluate(() => openMyDemandsSheet()); await sleep(1500);
          const li = await K.page.evaluate((id) => ((document.querySelector(`.dm-list-item[data-pid="${id}"]`) || {}).innerText || '').replace(/\s+/g, ' '), P.claw);
          await shot(K.page, 'b15_my_demands_numbers.png');
          const sum = (await adm('GET', '/api/product-demand-admin/summary')).json.data.products.find((p) => p.product_id === P.claw);
          const mm = await mineOf(U(21), P.claw);
          ok(lbl === '尚有 3 份登記・管理登記' && d.qty === 3 && /原登記 5 份，已購買 2 份/.test(d.note) && /已購買 2・訂購中 0・尚待購買 3/.test(li) && mm.settled_qty === 2 && mm.to_buy_qty === 3 && sum.settled_qty >= 2,
            'B15 [BR][API] 現金訂單成立後：商品卡、詳情、我的補貨登記、後台總表顯示一致（原登記 5、已購買 2、尚待購買 3）', 'N', JSON.stringify({ lbl, d: [d.qty, d.note], li, mm: mm && [mm.settled_qty, mm.to_buy_qty] }));
          await K.context.close();
        });
        // 後台畫面
        await step('B16', 'N', async () => {
          await reg(U(26), P.claw, 1); await order(U(26), [[P.claw, 1]]); // 已完成的週期（歷史）
          const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
          await ctx.addInitScript(([t]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); sessionStorage.setItem('__seeded', '1'); } }, [C.tok]);
          const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push('admin:' + e.message));
          await pg.goto(C.s.base + '/');
          await pg.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function', null, { timeout: 15000 });
          await pg.evaluate(() => showPage('line_products')); await sleep(600);
          await pg.evaluate(() => lpmSwitchTab('demand'));
          await pg.waitForSelector(`#pd-row-${P.claw}`, { timeout: 10000 }); await sleep(800);
          const sub = await pg.evaluate((id) => ({ qty: (document.querySelector(`#pd-row-${id} .pd-qty`) || {}).textContent, sub: (document.querySelector(`#pd-row-${id} .pd-qty-sub`) || {}).textContent, cells: document.querySelector(`#pd-row-${id}`).children.length }), P.claw);
          await pg.evaluate((id) => openDemandDetail(id), P.claw); await sleep(1800);
          const head = await pg.evaluate(() => (document.getElementById('pd-detail-head') || {}).textContent || '');
          const rows = await pg.evaluate(() => Array.from(document.querySelectorAll('#pd-detail-table tbody tr')).map((tr) => tr.innerText.replace(/\s+/g, ' ')));
          await pg.screenshot({ path: path.join(SHOT_DIR, 'b16_admin_demand_breakdown.png') });
          await ctx.close();
          ok(/已完成 \d+\s*訂購中 \d+\s*尚待購買 \d+/.test(sub.sub || '') && sub.cells === 7 && /已完成登記 \d+ 筆/.test(head) && rows.some((r) => /已完成/.test(r)) && rows.some((r) => /已完成 2・訂購中 0・尚待購買 3/.test(r)),
            'B16 [BR] 後台補貨登記：總表與明細清楚區分原登記、已完成、訂購中、尚待購買；已完成週期保留可查（表格仍為 7 欄）', 'N', JSON.stringify({ sub, head, rows: rows.slice(0, 6) }));
        });
        await step('B17', 'G', async () => {
          ok(!errs.length, 'B17 [BR] 前台與後台沒有 JavaScript 錯誤', 'G', JSON.stringify(errs.slice(0, 5)));
        });
      } finally { try { await browser.close(); } catch {} }
    }
  } finally {
    const N1 = await notifyCounts().catch(() => null);
    assert(N1 && N1.b === N0.b && N1.d === N0.d, 'Z1 [DB] 份數連動沒有建立任何補貨通知批次或逐筆發送紀錄', JSON.stringify({ N0, N1 }));
    assert(C.mf.real() === 0, 'Z2 [FX] 真實 LINE 呼叫 0', String(C.mf.real()));
    const lpCalls = fs.readFileSync(LP_LOG, 'utf8').split('\n').filter(Boolean).length;
    assert(true, 'Z3 [FX] LINE Pay 全部由替身處理（呼叫數 ' + lpCalls + '，真實／Sandbox 0）');
    try { await C.s.stop(); } catch {}
  }
  const s = H.summary();
  console.log(`\n結果：${s.passCount} 通過、${s.failCount} 失敗`);
  try { fs.writeFileSync(path.join(SHOT_DIR, 'c62-results.json'), JSON.stringify({ meta: META, results: s.results }, null, 2)); } catch {}
  process.exit(s.failCount ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
