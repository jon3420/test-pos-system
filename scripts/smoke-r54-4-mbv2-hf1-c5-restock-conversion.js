#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js
// R54.4／MBV2-HF1-C5 —— 補貨通知成效追蹤：LINE 已受理 → 點擊 → 加購 → 訂單／成交
// 正式路由＋暫存 SQLite＋實際 worker（LINE transport 在測試程序內攔截，真實呼叫 0）；LINE Pay API 以 node-fetch 替身攔截。
// 時間相關（7 日邊界）以測試時鐘重新啟動伺服器（C4_CLOCK_OFFSET_MS）重現，不依賴執行時段。
// 選用：C5_OLD_ROOT=<C4.5 或更早版本程式根目錄> 時，另驗證「舊版建立的批次升級後」與「舊版程式讀取升級後資料庫」。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep, puuid } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const LP_DIR = H.tmpDir('c5-linepay');
const LP_CTRL = path.join(LP_DIR, 'ctrl.json'), LP_LOG = path.join(LP_DIR, 'calls.jsonl');
fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' })); fs.writeFileSync(LP_LOG, '');
const LP_MOCK = path.join(__dirname, 'lib', 'c5-linepay-mock.js');
const CLOCK = path.join(__dirname, 'lib', 'c4-test-clock.js');
const OLD_ROOT = process.env.C5_OLD_ROOT || '';
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const SESSION_TTL = 30 * 86400e3;
// 會員 session 一律以「伺服器目前時鐘」簽發（測試程序與伺服器時鐘位移可能不同），30 天有效
function sessAt(u, offsetMs) {
  return execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${SESSION_TTL}}))`],
    { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(offsetMs) } }).toString();
}
const P_A = 701, P_OTHER = 702, P_B = 704, P_C = 705;
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [702, '測試對照湯', 1, 'available', { quota: 50 }], [703, '測試隱藏品', 2, 'available', { show_on_line: 0 }],
  [704, '測試補貨麵', 3, 'available', { quota: 50, price: 120 }], [705, '測試補貨飯糰', 4, 'available', { quota: 50, price: 80 }]];
const linepaySeed = (db) => {
  db.run("INSERT OR REPLACE INTO payment_gateways (store_id,name,code,is_active,mode,merchant_id,secret_key) VALUES ('store_001','LINE Pay','linepay',1,'test','test-channel-c5','test-secret-c5')");
  db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','line_payment_linepay_enabled','1')");
  db.run("INSERT INTO coupons (store_id,code,name,discount_type,discount_value,min_amount,enabled) VALUES ('store_001','C5OFF','測試折扣','fixed',100,0,1)");
  // 測試店開通優惠券授權（折扣分攤案例需要整單折扣）
  const r = db.exec("SELECT features FROM licenses WHERE store_id='store_001'");
  if (r[0] && r[0].values[0]) { const f = JSON.parse(r[0].values[0][0] || '{}'); f.coupon = true; f.reports = true; db.run("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)]); }
};

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C5 補貨通知成效追蹤 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　舊版程式：' + (OLD_ROOT || '（未提供，略過 K 段）'));
  const boots = [];
  const stopAll = async () => { for (const b of boots) { try { if (b.s.proc.exitCode == null && b.s.proc.signalCode == null) await b.s.stop(); } catch {} } };
  try {
    let OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (off) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js'), '-r', LP_MOCK],
      C4_CLOCK_OFFSET_MS: String(off), C5_LINEPAY_CTRL: LP_CTRL, C5_LINEPAY_LOG: LP_LOG });
    const C = await C45.boot('c5', { products: PRODUCTS, settings: { restock_notify_enabled: '1', coupon_feature_enabled: '1' }, seed: linepaySeed, env: env(OFF) }); boots.push(C);
    // boot() 的第二次啟動未帶 LINE Pay 替身 → 以相同設定重新啟動一次
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b, store) => C45.pub(C.s.base, m, p, b, store);
    const S = (u) => sessAt(u, OFF);
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    const dbq = async (sql, params) => { const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    // 伺服器以 sql.js 在記憶體中運作並在寫入後存檔；查詢檔案前稍候
    const q = async (sql, params) => { await sleep(150); return dbq(sql, params); };
    const register = async (u, pid) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' }); if (!r.json || !r.json.success) throw new Error('register ' + r.text); };
    async function sendBatch(pid, mode, date) {
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: pid, fulfillment_mode: mode, supply_date: date });
      if (!pv.json.success || !pv.json.data.can_send) throw new Error('preview ' + pv.text.slice(0, 300));
      const cf = await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {});
      if (!cf.json.success) throw new Error('confirm ' + cf.text);
      for (let i = 0; i < 80; i++) { const d = await adm('GET', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}`); if (['completed', 'paused'].includes(d.json.data.status)) return { pv: pv.json.data, detail: d.json.data }; await sleep(150); }
      throw new Error('batch did not finish');
    }
    const rtOf = (link) => new URL(link).searchParams.get('rt');
    const open = (rt, pid, key, u, extra = {}) => pub('POST', '/api/product-demand/track/open', { rt, product_id: pid, open_key: key, visitor_id: 'v_' + key, session_id: 's_' + key, ...(u ? { member_session: S(u) } : {}), ...extra });
    const addCart = (rt, pid, key, ek, u, prod) => pub('POST', '/api/analytics/events', { visitor_id: 'v_' + key, session_id: 's_' + key, event_name: 'add_to_cart', product_id: prod || pid, quantity: 1,
      metadata: { restock: { rt, open_key: key, event_key: ek } }, ...(u ? { member_session: S(u) } : {}) });
    // 既有系統的 LINE 訂單編號只到「秒」（同一秒建立的訂單編號相同，見報告「既有問題」）。測試每張訂單間隔 1.1 秒，
    // 避免與本輪無關的既有編號碰撞干擾 LINE Pay 確認與搬家（兩者都以訂單編號對應）。
    async function order(u, items, o = {}) {
      await sleep(1100);
      const body = { customer_name: '測試顧客', customer_phone: '0912345678', order_type: o.mode || 'takeout', pickup_date: tomorrow, pickup_time: '12:00',
        payment_method: o.pay || 'cash', items: items.map(([pid, qty]) => ({ product_id: pid, qty })), analytics: { visitor_id: 'v_order', session_id: 's_order' } };
      if (o.mode === 'delivery') Object.assign(body, { delivery_address: '台北市信義區市府路1號', delivery_lat: 25.0375, delivery_lng: 121.5637 });
      if (u) body.member_session = o.session || S(u);
      if (o.coupon) body.coupon_code = o.coupon;
      const r = await pub('POST', '/api/line-orders', body);
      if (!r.json || !r.json.success) throw new Error('order ' + r.status + ' ' + r.text.slice(0, 300));
      return r.json.data;
    }
    const summary = async (qs = '') => (await adm('GET', '/api/analytics/restock-notify/summary' + (qs ? '?' + qs : ''))).json.data;
    const batchRow = (sum, uuid) => sum.batches.find((b) => b.batch_uuid === uuid);

    // ═══ 0. 選用：舊版（C5_OLD_ROOT）建立的批次 → 升級為 C5 ═══
    let OLD = null;
    if (OLD_ROOT) {
      // 以舊版程式在同一個資料庫建立並發送批次（連結沒有 rt），再以 C5 程式啟動
      await C.s.stop();
      const oldS = await (async () => { const { spawn } = require('child_process'); const port = C.s.port;
        const args = ['-r', CLOCK, '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js'), 'server.js'];
        const proc = spawn(process.execPath, args, { cwd: OLD_ROOT, env: { ...process.env, PORT: String(port), POS_DB_PATH: C.dbf, C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: 'ignore' });
        const base = `http://127.0.0.1:${port}`; for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await sleep(150); }
        return { proc, base, stop: () => new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); }) }; })();
      const tokOld = await H.login(oldS.base, STORE, 'pw001');
      for (const u of [U(21), U(22)]) await C45.pub(oldS.base, 'POST', '/api/product-demand/register', { member_session: S(u), product_id: P_OTHER, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true });
      const pvO = await H.api(oldS.base, tokOld, 'POST', '/api/product-demand-admin/restock/preview', { product_id: P_OTHER, fulfillment_mode: 'takeout', supply_date: today });
      await H.api(oldS.base, tokOld, 'POST', `/api/product-demand-admin/restock/batches/${pvO.json.data.batch_uuid}/confirm`, {});
      await sleep(2500);
      OLD = { uuid: pvO.json.data.batch_uuid, link: pvO.json.data.link_url, msg: pvO.json.data.message_text };
      await oldS.stop();
      await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const d = (await adm('GET', `/api/product-demand-admin/restock/batches/${OLD.uuid}`)).json.data;
      const rows = await q('SELECT tracking_id, message_hash, link_url FROM restock_notify_batches WHERE batch_uuid=?', [OLD.uuid]);
      assert(d && d.tracked === false && !/[?&]rt=/.test(OLD.link) && rows[0].tracking_id === '' && rows[0].link_url === OLD.link && d.counts.accepted === 2,
        'K1 舊版建立的批次升級後：不建立追蹤識別、連結與 hash 不變、已受理紀錄保留', JSON.stringify({ tracked: d && d.tracked, acc: d && d.counts.accepted }));
    }

    // ═══ 1. 建立登記與三個 C5 批次 ═══
    for (let i = 1; i <= 10; i++) await register(U(i), P_A);                       // A：701 外帶 今天（U1–U10）
    for (const i of [11, 12, 13, 15, 16, 17]) await register(U(i), P_B);          // B：704 外送 明天（U17 送出失敗）
    for (const i of [13, 14, 18]) await register(U(i), P_C);                      // C：705 外帶 今天
    fs.writeFileSync(C.mf.ctrl, JSON.stringify({ default: '200', byUser: { [U(17)]: ['400'] } }));
    const A = await sendBatch(P_A, 'takeout', today);
    const B = await sendBatch(P_B, 'delivery', tomorrow);
    const Cb = await sendBatch(P_C, 'takeout', today);
    const rtA = rtOf(A.pv.link_url), rtB = rtOf(B.pv.link_url), rtC = rtOf(Cb.pv.link_url);
    const bRows = await q('SELECT batch_uuid, tracking_id, message_text, message_hash, link_url FROM restock_notify_batches WHERE batch_uuid IN (?,?,?)', [A.pv.batch_uuid, B.pv.batch_uuid, Cb.pv.batch_uuid]);
    const crypto = require('crypto');
    assert(rtA && rtB && rtC && new Set([rtA, rtB, rtC]).size === 3 && bRows.every((r) => r.link_url.includes('rt=' + r.tracking_id) && r.message_text.includes(r.link_url) && r.message_hash === crypto.createHash('sha256').update(r.message_text).digest('hex')),
      'T1 新批次：伺服器產生追蹤識別，在訊息快照前放入連結；訊息 hash 與內容一致', JSON.stringify({ rtA: rtA && rtA.length }));
    assert(/^[A-Za-z0-9_-]{20}$/.test(rtA) && !/Uc45|store_001/.test(rtA), 'T2 追蹤識別不含店別、會員或商品資料', rtA);
    const accA = (await adm('GET', `/api/product-demand-admin/restock/batches/${A.pv.batch_uuid}`)).json.data.counts.accepted;
    const delB = (await adm('GET', `/api/product-demand-admin/restock/batches/${B.pv.batch_uuid}`)).json.data;
    assert(accA === 10 && delB.counts.accepted === 5 && (delB.counts.failed + delB.counts.held + delB.counts.unknown + delB.counts.retry_wait) >= 1, 'T3 批次 A 已受理 10 人；批次 B 已受理 5 人（U17 未受理）', JSON.stringify({ accA, b: delB.counts }));

    // ═══ 2. 點擊 ═══
    const before = (await q('SELECT COUNT(*) AS c FROM restock_notify_clicks'))[0].c;
    await fetch(A.pv.link_url.replace(/^https:\/\/liff\.line\.me\/[^?]+/, `${C.s.base}/line-order.html`)).then((r) => r.text()); // 爬蟲／預覽抓取頁面
    await pub('GET', `/api/product-demand/product-ref?ref=${puuid(P_A)}`);                                                  // 讀取商品資料
    assert((await q('SELECT COUNT(*) AS c FROM restock_notify_clicks'))[0].c === before && before === 0, 'C1 GET 連結頁面（預覽／爬蟲）與讀取商品資料不計為點擊', String(before));
    const keys = {}; const K = (n) => (keys[n] = keys[n] || ('ok' + crypto.randomBytes(8).toString('hex')));
    for (let i = 1; i <= 6; i++) { const r = await open(rtA, P_A, K('a' + i), U(i)); if (!r.json.data.tracked) throw new Error('open A ' + i); }
    const dup1 = await open(rtA, P_A, K('a1'), U(1));                         // 導向／重新整理／重送：同一 open_key
    const second = await open(rtA, P_A, K('a1b'), U(1));                      // U1 第二次點擊（新開啟）
    let s1 = await summary(`batch_uuid=${A.pv.batch_uuid}`); let rA = batchRow(s1, A.pv.batch_uuid);
    assert(dup1.json.data.tracked && second.json.data.tracked && rA.click_people === 6 && rA.click_count === 7, 'C2 重送／重新整理不增加；同一會員再次點擊：人數 6、次數 7', JSON.stringify({ p: rA.click_people, c: rA.click_count }));
    // 匿名開啟後背景辨識（同一 open_key 補送會員）
    await open(rtB, P_B, K('b11'), null); await open(rtB, P_B, K('b11'), U(11));
    // 錯會員：已綁定 U11 的開啟，再以 U12 補送 → 不改
    await open(rtB, P_B, K('b11'), U(12));
    const c11 = await q('SELECT line_user_id, recipient FROM restock_notify_clicks WHERE open_key=?', [K('b11')]);
    assert(c11.length === 1 && c11[0].line_user_id === U(11) && c11[0].recipient === 1, 'C3 匿名開啟後背景辨識補上會員；之後換成其他會員不會改綁', JSON.stringify(c11));
    await open(rtB, P_B, K('b12'), U(12)); await open(rtB, P_B, K('b13'), U(13)); await open(rtB, P_B, K('b15'), U(15)); await open(rtB, P_B, K('b16'), U(16));
    await open(rtB, P_B, K('b17'), U(17));                 // 送出失敗（未受理）的會員
    await open(rtB, P_B, K('b20'), U(20));                 // 轉傳給非收件人
    await open(rtB, P_B, K('banon'), null);                // 匿名
    await open(rtC, P_C, K('c13'), U(13)); await open(rtC, P_C, K('c14'), U(14)); await open(rtC, P_C, K('c18'), U(18));
    const forged = await open('AAAAAAAAAAAAAAAAAAAAAA', P_B, K('forged'), U(11));
    const wrongP = await open(rtB, P_A, K('wrongp'), U(11));
    const cross = await C45.pub(C.s.base, 'POST', '/api/product-demand/track/open', { rt: rtB, product_id: P_B, open_key: K('cross'), member_session: S(U(11)) }, 'store_002');
    assert(!forged.json.data.tracked && !wrongP.json.data.tracked && !(cross.json && cross.json.data && cross.json.data.tracked), 'C4 偽造／不存在的追蹤識別、商品不符、跨店：不記錄（不揭露是否存在）', JSON.stringify({ f: forged.json.data, w: wrongP.json.data, x: cross.status }));
    let sB = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    assert(sB.accepted_people === 5 && sB.click_people === 5 && sB.other_opens === 3, 'C5 未受理會員、非收件人、匿名開啟另列「其他開啟」，不計入收件人漏斗', JSON.stringify({ acc: sB.accepted_people, p: sB.click_people, other: sB.other_opens }));

    // ═══ 3. 加購 ═══
    for (let i = 1; i <= 4; i++) { const r = await addCart(rtA, P_A, K('a' + i), K('ea' + i), U(i)); if (!r.json || !r.json.success) throw new Error('add ' + r.text); }
    await addCart(rtA, P_A, K('a1'), K('ea1'), U(1));                   // 重送同一事件
    await addCart(rtA, P_A, K('a1'), K('ea1b'), U(1));                  // 正常再次加購
    await addCart(rtA, P_A, K('a5'), K('ea5x'), U(5), P_OTHER);         // 非通知商品
    await addCart(rtA, P_A, 'ok' + 'nolinkopen0000', K('ea7'), U(7));    // 沒有點擊紀錄
    const addsA = await q('SELECT event_key, line_user_id FROM restock_notify_cart_adds WHERE batch_uuid=?', [A.pv.batch_uuid]);
    const evts = await q("SELECT metadata_json FROM analytics_events WHERE event_name='add_to_cart'");
    rA = batchRow(await summary(`batch_uuid=${A.pv.batch_uuid}`), A.pv.batch_uuid);
    assert(addsA.length === 5 && rA.add_people === 4, 'A1 加購：重送去重、再次加購保留次數（5 筆）；人數 4；非通知商品與無點擊的加購不計', JSON.stringify({ rows: addsA.length, people: rA.add_people }));
    assert(evts.length >= 7 && evts.every((e) => !/restock|rt|open_key/.test(String(e.metadata_json || '').replace(/"first_touch"|"last_touch"/g, ''))), 'A2 追蹤識別不寫進一般 Analytics 事件', String(evts.length));

    // ═══ 4. 訂單與成交（批次 A：U1 兩張、U2 一張；U5 只點擊不下單；U7 未點擊下單）═══
    await order(U(1), [[P_A, 2], [P_OTHER, 1]]);
    await order(U(1), [[P_A, 1]]);
    await order(U(2), [[P_A, 1]]);
    await order(U(7), [[P_A, 1]]);              // 收件人但沒有點擊 → 不歸因
    await order(U(20), [[P_B, 1]], { mode: 'delivery' }); // 非收件人（轉傳）下單 → 不歸因
    await order(null, [[P_B, 1]], { mode: 'delivery' });   // 匿名下單 → 不歸因
    const sA = await summary(`batch_uuid=${A.pv.batch_uuid}`); rA = batchRow(sA, A.pv.batch_uuid);
    assert(rA.accepted_people === 10 && rA.click_people === 6 && rA.add_people === 4 && rA.deal_people === 2 && rA.orders === 3 && rA.deal_orders === 3
      && rA.ctr === 60 && rA.add_rate === 66.67 && rA.click_deal_rate === 33.33 && rA.notify_deal_rate === 20,
    'O1 範例口徑：已受理 10、點擊 6、加購 4、成交 2 人、訂單 3 張 → 60%／66.67%／33.33%／20%', JSON.stringify({ acc: rA.accepted_people, c: rA.click_people, a: rA.add_people, d: rA.deal_people, o: rA.orders, r: [rA.ctr, rA.add_rate, rA.click_deal_rate, rA.notify_deal_rate] }));
    const attrA = await q('SELECT product_id, quantity, item_gross, item_net FROM restock_notify_order_attributions WHERE batch_uuid=? ORDER BY id', [A.pv.batch_uuid]);
    assert(attrA.length === 3 && attrA.every((x) => x.product_id === P_A) && rA.amount === 150 * 4, 'O2 只計入通知商品明細（其他商品不算補貨營收）：4 份 × $150', JSON.stringify({ attrA, amount: rA.amount }));
    const u7 = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE line_user_id IN (?,?)', [U(7), U(20)]);
    assert(u7[0].c === 0, 'O3 沒有點擊的收件人、轉傳的非收件人、匿名訂單都不歸因', JSON.stringify(u7));

    // 多商品同訂單（B＋C＋其他）、折扣分攤、通知日期／方式與訂單選擇不同
    const oMulti = await order(U(13), [[P_B, 1], [P_C, 2], [P_OTHER, 1]], { mode: 'delivery', coupon: 'C5OFF' });
    const am = await q('SELECT product_id, batch_uuid, item_gross, discount_alloc, item_net, notify_mode, order_mode, notify_supply_date, order_pickup FROM restock_notify_order_attributions WHERE order_uuid=? ORDER BY product_id', [oMulti.uuid]);
    const ord = (await q('SELECT subtotal, discount_amount, total FROM orders WHERE uuid=?', [oMulti.uuid]))[0];
    // 小計 120+160+150=430，折扣 100 → 704: 100*120/430=27.906…、705: 37.209…、702: 34.883… → 以分計最大餘數：27.91／37.21／34.88
    const a704 = am.find((x) => x.product_id === P_B), a705 = am.find((x) => x.product_id === P_C);
    assert(am.length === 2 && a704 && a705 && a704.batch_uuid === B.pv.batch_uuid && a705.batch_uuid === Cb.pv.batch_uuid && ord.discount_amount === 100
      && a704.discount_alloc === 27.91 && a705.discount_alloc === 37.21 && a704.item_net === 92.09 && a705.item_net === 122.79,
    'O4 同一訂單多個通知商品：各自歸因各自批次；整單折扣依商品小計比例分攤（以分計、尾差最大餘數），外送費不計入', JSON.stringify({ am, ord }));
    assert(a705.notify_mode === 'takeout' && a705.order_mode === 'delivery' && a705.notify_supply_date === today && /^\d{4}-\d{2}-\d{2}/.test(a705.order_pickup),
      'O5 通知日期／取餐方式與訂單實際選擇分開保存（改選方式仍算同商品轉換）', JSON.stringify(a705));
    const tot = (await summary(`from=${today}&to=${today}`)).totals;
    assert(tot.orders === (await q(`SELECT COUNT(DISTINCT order_uuid) AS c FROM restock_notify_order_attributions a JOIN orders o ON o.uuid=a.order_uuid WHERE o.status<>'void' AND o.order_status<>'cancelled'`))[0].c,
      'O6 跨商品總覽的訂單數去重（同一訂單含多個通知商品只算一張）', JSON.stringify({ tot: tot.orders }));

    // LINE Pay：未付款 → 不成交；確認成功 → 成交；重複 callback → 不重複；返回取消 → 仍未成交且快照保留
    const oLP = await order(U(14), [[P_C, 1]], { pay: 'linepay' });
    let rC = batchRow(await summary(`batch_uuid=${Cb.pv.batch_uuid}`), Cb.pv.batch_uuid);
    const dealBefore = rC.deal_people;
    // C5.2 調整：確認失敗（1150）屬於該筆 LINE Pay 交易的確定結果，同一交易不會再確認成功；顧客重新付款會取得新的交易代碼。
    // C5.3 調整：改走正式付款請求（/api/linepay/request）與付款嘗試綁定的 callback。沒有付款嘗試的「舊付款」callback
    //   在 C5.3 只做唯讀核對、不補送 Confirm，無法再用來模擬「確認成功」；斷言內容（失敗不算成交、成功才成交、重複不重複）不變。
    const payAttempt = async () => {
      await pub('POST', '/api/linepay/request', { order_uuid: oLP.uuid });
      return (await q('SELECT attempt_uuid, lp_order_id, transaction_id FROM linepay_payment_attempts WHERE order_uuid=? ORDER BY id DESC LIMIT 1', [oLP.uuid]))[0];
    };
    const confirm = (a) => fetch(`${C.s.base}/api/linepay/confirm?store_id=${STORE}&attempt=${a.attempt_uuid}&transactionId=${a.transaction_id}&orderId=${encodeURIComponent(a.lp_order_id)}`, { redirect: 'manual' });
    const att1 = await payAttempt();
    fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '1150' })); await confirm(att1);         // 確認失敗（第一次 Confirm 被明確拒絕）
    rC = batchRow(await summary(`batch_uuid=${Cb.pv.batch_uuid}`), Cb.pv.batch_uuid);
    const afterFail = rC.deal_people;
    fs.writeFileSync(LP_CTRL, JSON.stringify({ confirm: '0000' }));
    const att2 = await payAttempt(); await confirm(att2); await confirm(att2);                     // 重新付款成功＋重複 callback
    rC = batchRow(await summary(`batch_uuid=${Cb.pv.batch_uuid}`), Cb.pv.batch_uuid);
    const purchases = await q("SELECT COUNT(*) AS c FROM analytics_events WHERE order_id=? AND event_name='purchase'", [oLP.uuid]);
    const attrLP = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oLP.uuid]);
    assert(dealBefore === 1 && afterFail === 1 && rC.deal_people === 2 && purchases[0].c === 1 && attrLP[0].c === 1,
      'P1 LINE Pay：未付款／確認失敗不算成交；後端確認成功才成交；重複 callback 不重複計算（purchase 1、歸因 1）', JSON.stringify({ dealBefore, afterFail, after: rC.deal_people, purchases: purchases[0].c }));
    const oLP2 = await order(U(15), [[P_B, 1]], { pay: 'linepay', mode: 'delivery' });
    await fetch(`${C.s.base}/api/linepay/cancel?store_id=${STORE}&orderId=${encodeURIComponent(oLP2.order_number)}`, { redirect: 'manual' });
    const lp2 = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oLP2.uuid]);
    sB = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    assert(lp2[0].c === 1 && sB.orders >= 2 && sB.deal_orders === sB.orders - 1, 'P2 LINE Pay 返回取消（網址沒有追蹤參數）：歸因快照保留，訂單計入「有效」但不算成交', JSON.stringify({ orders: sB.orders, deal: sB.deal_orders }));

    // 取消、作廢：有效訂單與金額反映實際狀態
    const oCancel = await order(U(16), [[P_B, 1]], { mode: 'delivery' });
    let b1 = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    await adm('PATCH', `/api/line-orders/online/${oCancel.uuid}/status`, { status: 'cancelled' });
    let b2 = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    const oVoid = await order(U(12), [[P_B, 1]], { mode: 'delivery' });
    const b3 = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    await adm('POST', `/api/orders/${oVoid.uuid}/void`, { reason: '測試作廢', operator: 'test' });
    const b4 = batchRow(await summary(`batch_uuid=${B.pv.batch_uuid}`), B.pv.batch_uuid);
    assert(b2.orders === b1.orders - 1 && b2.amount === b1.amount - 120 && b4.orders === b3.orders - 1 && b4.amount === b3.amount - 120,
      'R1 取消／作廢的訂單不計入有效訂單與金額（歷史紀錄保留）', JSON.stringify({ b1: [b1.orders, b1.amount], b2: [b2.orders, b2.amount], b3: [b3.orders, b3.amount], b4: [b4.orders, b4.amount] }));

    // ═══ 5. 歸因視窗：7 日邊界、最後一次有效點擊 ═══
    const clickRow = (await q('SELECT created_at FROM restock_notify_clicks WHERE open_key=?', [K('b11')]))[0];
    const clickMs = Date.parse(clickRow.created_at.replace(' ', 'T') + 'Z');
    const shiftTo = async (targetServerMs) => { OFF = String(targetServerMs - RealDate.now()); await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    await shiftTo(clickMs + 7 * 86400e3 - 120e3);
    const oIn = await order(U(11), [[P_B, 1]], { mode: 'delivery', session: sessAt(U(11), OFF) });
    await shiftTo(clickMs + 7 * 86400e3 + 120e3);
    const c12 = (await q('SELECT created_at FROM restock_notify_clicks WHERE open_key=?', [K('b12')]))[0];
    const oOut = await order(U(13), [[P_B, 1]], { mode: 'delivery', session: sessAt(U(13), OFF) }); // U13 的 B 點擊早於 U11（超過 7 日）
    const inA = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oIn.uuid]);
    const outA = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oOut.uuid]);
    assert(inA[0].c === 1 && outA[0].c === 0, 'W1 7×24 小時邊界：點擊後 7 日內（差 2 分鐘）歸因；超過 7 日（多 2 分鐘）不歸因（伺服器時間）', JSON.stringify({ inA: inA[0].c, outA: outA[0].c, c12: !!c12 }));
    await shiftTo(RealDate.now() + Number(TP(10, 30)) + 8 * 86400e3);
    // 最後一次有效點擊：U3 取消後重新登記（新週期），收到第二個 701 批次並點擊 → 訂單歸給較新的批次
    await pub('POST', '/api/product-demand/cancel', { member_session: sessAt(U(3), OFF), product_id: P_A });
    await pub('POST', '/api/product-demand/register', { member_session: sessAt(U(3), OFF), product_id: P_A, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    const day2 = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const A2 = await sendBatch(P_A, 'takeout', day2);
    await C45.pub(C.s.base, 'POST', '/api/product-demand/track/open', { rt: rtA, product_id: P_A, open_key: K('a3late'), member_session: sessAt(U(3), OFF) });   // 舊批次再點一次
    await sleep(1100);
    await C45.pub(C.s.base, 'POST', '/api/product-demand/track/open', { rt: rtOf(A2.pv.link_url), product_id: P_A, open_key: K('a3new'), member_session: sessAt(U(3), OFF) });
    const o3 = await order(U(3), [[P_A, 1]], { session: sessAt(U(3), OFF) });
    const a3 = await q('SELECT batch_uuid FROM restock_notify_order_attributions WHERE order_uuid=?', [o3.uuid]);
    assert(a3.length === 1 && a3[0].batch_uuid === A2.pv.batch_uuid, 'W2 同商品多個有效點擊：歸給下單前最後一次點擊；同一訂單同一商品只歸因一次', JSON.stringify(a3));

    // ═══ 6. 失敗不阻擋、可重跑補登 ═══
    await C45.pub(C.s.base, 'POST', '/api/product-demand/track/open', { rt: rtC, product_id: P_C, open_key: K('c18c'), member_session: sessAt(U(18), OFF) }); // 7 日內的新點擊
    await C.s.stop();
    { const db = await H.openDbFile(C.dbf);
      db.run("CREATE TRIGGER c5_test_block_attr BEFORE INSERT ON restock_notify_order_attributions BEGIN SELECT RAISE(ABORT, 'test block'); END");
      db.run("CREATE TRIGGER c5_test_block_click BEFORE INSERT ON restock_notify_clicks BEGIN SELECT RAISE(ABORT, 'test block'); END");
      H.saveDbFile(db, C.dbf); db.close(); }
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const blockedOpen = await C45.pub(C.s.base, 'POST', '/api/product-demand/track/open', { rt: rtC, product_id: P_C, open_key: K('c18b'), member_session: sessAt(U(18), OFF) });
    let oF = null, oErr = null; try { oF = await order(U(18), [[P_C, 1]], { session: sessAt(U(18), OFF) }); } catch (e) { oErr = e.message; }
    const fA = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oF ? oF.uuid : '']);
    assert(blockedOpen.status === 200 && blockedOpen.json.data.tracked === false && oF && !oErr && fA[0].c === 0, 'F1 追蹤寫入失敗：開啟回應正常、訂單照常成立（歸因暫缺）', JSON.stringify({ open: blockedOpen.status, oErr }));
    await C.s.stop();
    { const db = await H.openDbFile(C.dbf); db.run('DROP TRIGGER c5_test_block_attr'); db.run('DROP TRIGGER c5_test_block_click'); H.saveDbFile(db, C.dbf); db.close(); }
    await C.restart(env(OFF)); C.tok = await H.login(C.s.base, STORE, 'pw001');
    const r1 = await adm('POST', '/api/analytics/restock-notify/reconcile', { days: 30 });
    const r2 = await adm('POST', '/api/analytics/restock-notify/reconcile', { days: 30 });
    const fA2 = await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions WHERE order_uuid=?', [oF.uuid]);
    const allAttr = (await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions'))[0].c;
    const r3 = await adm('POST', '/api/analytics/restock-notify/reconcile', { days: 30 });
    const allAttr2 = (await q('SELECT COUNT(*) AS c FROM restock_notify_order_attributions'))[0].c;
    assert(r1.json.data.attributed === 1 && fA2[0].c === 1 && r2.json.data.attributed === 0 && allAttr === allAttr2 && r3.json.data.attributed === 0,
      'F2 補登可重跑：第一次補上 1 筆，之後重跑不重複計算', JSON.stringify({ r1: r1.json.data, r2: r2.json.data, r3: r3.json.data }));

    // ═══ 7. 報表權限、篩選、未追蹤 ═══
    const noAuth = await H.api(C.s.base, null, 'GET', '/api/analytics/restock-notify/summary?store_id=store_001');
    const tok2 = await H.login(C.s.base, 'store_002', 'pw002');
    const other = await H.api(C.s.base, tok2, 'GET', '/api/analytics/restock-notify/summary');
    assert(noAuth.status === 401 && other.json && other.json.success && other.json.data.batches.length === 0, 'V1 報表需員工登入；以 query store_id 不能讀取；其他店別看不到', JSON.stringify({ noAuth: noAuth.status, other: other.json && other.json.data.batches.length }));
    const fb = await summary(`product_id=${P_B}`), fm = await summary('mode=delivery'), fd = await summary('from=2000-01-01&to=2000-01-02');
    assert(fb.batches.every((b) => b.product_id === P_B) && fb.batches.length === 1 && fm.batches.every((b) => b.fulfillment_mode === 'delivery') && fd.batches.length === 0 && fd.totals.ctr === null,
      'V2 篩選：商品、取餐方式、批次日期；沒有資料時比率顯示「—」（null）', JSON.stringify({ fb: fb.batches.length, fm: fm.batches.length, fd: fd.batches.length }));
    if (OLD) {
      const so = batchRow(await summary(`batch_uuid=${OLD.uuid}`), OLD.uuid);
      assert(so && so.tracked === false && so.click_people === null && so.ctr === null && so.accepted_people === 2, 'K2 C5 以前的批次：顯示「未建立追蹤／無資料」，不寫成 0、不推測', JSON.stringify(so));
    }

    // ═══ 8. 發送程序不變：續送沿用同一份訊息、hash 與 retry key ═══
    for (const i of [24, 25]) await pub('POST', '/api/product-demand/register', { member_session: sessAt(U(i), OFF), product_id: P_OTHER, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
    fs.writeFileSync(C.mf.ctrl, JSON.stringify({ default: '200', byUser: { [U(25)]: ['500', '200'] } }));
    const dayNow = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const pvR = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P_OTHER, fulfillment_mode: 'takeout', supply_date: dayNow });
    if (pvR.json.data.can_send) {
      const before1 = (await q('SELECT message_hash, link_url, tracking_id FROM restock_notify_batches WHERE batch_uuid=?', [pvR.json.data.batch_uuid]))[0];
      await adm('POST', `/api/product-demand-admin/restock/batches/${pvR.json.data.batch_uuid}/confirm`, {});
      await sleep(3000);
      const keys1 = await q('SELECT line_user_id, retry_key, status, attempt_count FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id', [pvR.json.data.batch_uuid]);
      await adm('POST', `/api/product-demand-admin/restock/batches/${pvR.json.data.batch_uuid}/resume`, {}); await sleep(3000);
      const keys2 = await q('SELECT line_user_id, retry_key, status FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id', [pvR.json.data.batch_uuid]);
      const after1 = (await q('SELECT message_hash, link_url, tracking_id FROM restock_notify_batches WHERE batch_uuid=?', [pvR.json.data.batch_uuid]))[0];
      const sentTexts = C.mf.calls().filter((c) => c.text && c.text.includes(after1.tracking_id)).map((c) => c.text);
      assert(JSON.stringify(before1) === JSON.stringify(after1) && keys1.map((x) => x.retry_key).join() === keys2.map((x) => x.retry_key).join() && new Set(sentTexts).size === 1,
        'S1 確認、重試、續送沿用同一份訊息、連結（含追蹤識別）、hash 與 retry key', JSON.stringify({ k1: keys1.map((x) => [x.status, x.attempt_count]), k2: keys2.map((x) => x.status), texts: sentTexts.length }));
    } else assert(false, 'S1 前提：可建立預覽', JSON.stringify(pvR.json.data.blockers));

    // ═══ 9. 搬家：選擇性、完整、跨環境、同店還原、跨店 ═══
    const sumSrc = await summary();
    const counts = async (base, tok) => { const r = await H.api(base, tok, 'GET', '/api/analytics/restock-notify/summary'); return r.json.data.totals; };
    const full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
    const fj = JSON.parse(full.buf.toString('utf8'));
    const part = await H.download(C.s.base, C.tok, '/api/migration/v2/export?categories=restock_notify');
    const pj = JSON.parse(part.buf.toString('utf8'));
    assert(fj.data.restock_notify_clicks.length > 0 && fj.data.restock_notify_order_attributions.length > 0 && pj.data.restock_notify_cart_adds.length === fj.data.restock_notify_cart_adds.length,
      'M1 完整與選擇性備份都包含點擊、加購與訂單歸因', JSON.stringify({ clicks: fj.data.restock_notify_clicks.length, adds: fj.data.restock_notify_cart_adds.length, attrs: fj.data.restock_notify_order_attributions.length }));
    // 新環境（商品 ID 不同）：先只匯入通知紀錄 → 訂單不存在不得串錯；再匯入商品與訂單 → 與來源一致
    const T = await C45.boot('c5t', { products: PRODUCTS.map((p) => [p[0] + 100, ...p.slice(1)]), settings: { restock_notify_enabled: '1' } }); boots.push(T);
    const upP = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'c5full.json' });
    const imP = await H.previewAndImport(T.s.base, T.tok, upP.json.upload_id, { mode: 'merge', categories: ['restock_notify'] });
    const t1 = await counts(T.s.base, T.tok);
    const pidMap = await (async () => { const db = await H.openDbFile(T.dbf); try { return H.q(db, 'SELECT DISTINCT product_id FROM restock_notify_order_attributions'); } finally { db.close(); } })();
    assert(imP.import && imP.import.status === 'done' && t1.click_people === sumSrc.totals.click_people && t1.orders === 0,
      'M2 只匯入通知紀錄：點擊／加購保留；目標沒有對應訂單時不計入、不串到其他訂單', JSON.stringify({ st: imP.import && imP.import.status, t1: [t1.click_people, t1.orders], pid: pidMap }));
    const upP2 = await H.uploadRaw(T.s.base, T.tok, full.buf, { name: 'c5full2.json' });
    const imP2 = await H.previewAndImport(T.s.base, T.tok, upP2.json.upload_id, { mode: 'merge', categories: ['products', 'orders', 'analytics'] });
    const t2 = await counts(T.s.base, T.tok);
    assert(imP2.import && imP2.import.status === 'done' && t2.orders === sumSrc.totals.orders && t2.deal_people === sumSrc.totals.deal_people && t2.amount === sumSrc.totals.amount,
      'M3 再匯入商品、訂單與事件：成效數字與來源一致', JSON.stringify({ src: [sumSrc.totals.orders, sumSrc.totals.deal_people, sumSrc.totals.amount], t2: [t2.orders, t2.deal_people, t2.amount], st: imP2.import && imP2.import.result && imP2.import.result.stats && imP2.import.result.stats.orders }));
    // 同店還原（完整取代）：歸因紀錄保留、不重複
    const upR = await H.uploadRaw(C.s.base, C.tok, full.buf, { name: 'c5restore.json' });
    const imR = await H.previewAndImport(C.s.base, C.tok, upR.json.upload_id, { mode: 'replace', categories: fj.selected_categories, confirm_text: 'store_001', password: 'pw001' });
    const afterR = (await summary()).totals;
    assert(imR.import && imR.import.status === 'done' && afterR.orders === sumSrc.totals.orders && afterR.click_count === sumSrc.totals.click_count && afterR.amount === sumSrc.totals.amount,
      'M4 同店完整還原：歸因保留、不重複計算', JSON.stringify({ st: imR.import ? imR.import.status : (imR.preview && imR.preview.status), before: [sumSrc.totals.orders, sumSrc.totals.click_count], after: [afterR.orders, afterR.click_count] }));
    // 跨店匯入（store_002）：需明確確認；匯入後各店數字各自獨立
    const up2 = await H.uploadRaw(C.s.base, tok2, part.buf, { name: 'c5cross.json' });
    const im2 = await H.previewAndImport(C.s.base, tok2, up2.json.upload_id, { mode: 'merge', categories: ['restock_notify'], allow_cross_store: true });
    const s2 = (await H.api(C.s.base, tok2, 'GET', '/api/analytics/restock-notify/summary')).json.data;
    const s1x = (await summary()).totals;
    const st2 = im2.import && im2.import.result && im2.import.result.stats;
    const n2err = im2.import && im2.import.error; const n2 = await q("SELECT (SELECT COUNT(*) FROM restock_notify_clicks WHERE store_id='store_002') AS c, (SELECT COUNT(*) FROM restock_notify_order_attributions WHERE store_id='store_002') AS a");
    // 同一資料庫內跨店：批次、點擊、歸因的 uuid 全資料庫唯一 → 已在原店存在的紀錄不會複製到目標店（不串店）；原店數字不變
    if (!im2.import) console.log('M5 debug', JSON.stringify({ up: up2.json, pv: im2.previewResp && im2.previewResp.text, pj: im2.preview && { st: im2.preview.status, err: im2.preview.error } }).slice(0, 800));
    assert(im2.import && im2.import.status === 'done' && s1x.orders === sumSrc.totals.orders && s1x.click_count === sumSrc.totals.click_count && (s2.totals.orders === null || s2.totals.orders === 0),
      'M5 同一資料庫跨店匯入：需明確確認；不影響原店數字，目標店不會出現不屬於它的訂單歸因', JSON.stringify({ st: im2.import && im2.import.status, s2: [s2.totals.batches, s2.totals.orders], n2, n2err, stats: st2 && { b: st2.restock_notify_batches, c: st2.restock_notify_clicks } }));

    // ═══ 10. 瀏覽器：最終頁實際開啟才記錄、LIFF 導向不重複、加購（通知商品／其他商品）═══
    if (chromium) {
      const browser = await chromium.launch(C45.launchOpts());
      try {
        // 新登記與新批次（701，U26）以免影響上方數字
        await pub('POST', '/api/product-demand/register', { member_session: sessAt(U(26), OFF), product_id: P_C, desired_qty: 1, fulfillment_pref: 'any', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
        const Cw = await sendBatch(P_C, 'takeout', dayNow);
        const rtW = rtOf(Cw.pv.link_url);
        const inner = `?store_id=${STORE}&product_ref=${puuid(P_C)}&src=restock&m=takeout&d=${dayNow}&rt=${rtW}`;
        const sess = JSON.stringify({ member_session: sessAt(U(26), OFF), display_name: '會員26', is_friend: true, expires_at: Date.now() + 3600e3 });
        const ctx = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__s')) { localStorage.setItem(k, v); sessionStorage.setItem('__s', '1'); } window.__C45_LIFF = { mode: 'resolve_then_redirect' }; }, ['line_member_session_store_001', sess]);
        const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
        const gtag = []; page.on('request', (r) => { if (/google-analytics|googletagmanager|facebook/.test(r.url())) gtag.push(r.url()); });
        await page.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
        await page.goto(`${C.s.base}/line-order.html?store_id=${STORE}&liff.state=${encodeURIComponent(inner)}`, { waitUntil: 'domcontentloaded' });
        await sleep(4500);
        const clicksW = await q('SELECT line_user_id, recipient FROM restock_notify_clicks WHERE batch_uuid=?', [Cw.pv.batch_uuid]);
        assert(clicksW.length === 1 && clicksW[0].line_user_id === U(26) && clicksW[0].recipient === 1, 'B1 LIFF 一次／二次導向後最終頁開啟商品：點擊 1 次、核對為收件人', JSON.stringify(clicksW));
        await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
        assert((await q('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE batch_uuid=?', [Cw.pv.batch_uuid]))[0].c === 1, 'B2 重新整理不增加點擊', '');
        // 加購：通知商品（詳情內加入購物車）與其他商品
        await page.evaluate((pid) => { addCart(pid); addCart(702); return null; }, P_C); await sleep(1500);
        const addsW = await q('SELECT product_id FROM restock_notify_cart_adds WHERE batch_uuid=?', [Cw.pv.batch_uuid]);
        assert(addsW.length === 1 && addsW[0].product_id === P_C, 'B3 真正加購通知商品才記錄；其他商品不計入此漏斗', JSON.stringify(addsW));
        // 開啟補貨登記表單、修改登記份數、購物車還原都不是加購
        await page.evaluate(() => { try { openMyDemandsSheet(); } catch (e) {} return null; }); await sleep(800);
        await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
        assert((await q('SELECT COUNT(*) AS c FROM restock_notify_cart_adds WHERE batch_uuid=?', [Cw.pv.batch_uuid]))[0].c === 1, 'B4 購物車還原、開啟登記清單不計為加購', '');
        assert(errs.length === 0 && gtag.every((u) => !u.includes(rtW)), 'B5 無 JavaScript 錯誤；追蹤識別沒有送往第三方', errs.join('|'));
        // 舊連結（沒有 rt）：照常開啟商品、不建立點擊
        const p2 = await ctx.newPage();
        await p2.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
        await p2.goto(`${C.s.base}/line-order.html?store_id=${STORE}&product_ref=${puuid(P_A)}&src=restock&m=takeout&d=${dayNow}`, { waitUntil: 'domcontentloaded' });
        await sleep(2500);
        const opened = await p2.evaluate(() => !!document.querySelector('.pdm-overlay.pdm-open'));
        assert(opened, 'B6 舊連結（無追蹤識別）照常開啟商品', '');
        await ctx.close();
        // ── V3 後台：營運分析中心「補貨通知成效」與 LINE 商品批次連結 ──
        const actx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        await actx.addInitScript(([t]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); sessionStorage.setItem('__seeded', '1'); } }, [C.tok]);
        const ap = await actx.newPage(); const aerr = []; ap.on('pageerror', (e) => aerr.push(e.message)); ap.on('dialog', (d) => d.accept());
        await ap.goto(C.s.base + '/');
        await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.av2OpenRestockBatch === 'function');
        await ap.evaluate((u) => { av2OpenRestockBatch(u); return null; }, A.pv.batch_uuid);
        await ap.waitForSelector('#av2-rs-table', { timeout: 15000 }).catch(() => {});
        await sleep(800);
        const ui = await ap.evaluate(() => ({ ctr: document.getElementById('av2-rs-k-ctr')?.textContent, add: document.getElementById('av2-rs-k-addrate')?.textContent,
          cd: document.getElementById('av2-rs-k-clickdeal')?.textContent, nd: document.getElementById('av2-rs-k-notifydeal')?.textContent, rows: document.querySelectorAll('#av2-rs-table tbody tr').length,
          notes: (document.getElementById('av2-rs-notes')?.textContent || '').includes('不代表顧客已收到或已讀') }));
        const apiA = batchRow(await summary(`batch_uuid=${A.pv.batch_uuid}`), A.pv.batch_uuid);
        assert(ui.rows === 1 && ui.ctr === `${apiA.ctr}%` && ui.add === `${apiA.add_rate}%` && ui.cd === `${apiA.click_deal_rate}%` && ui.nd === `${apiA.notify_deal_rate}%` && ui.notes,
          'V3-1 營運分析中心「補貨通知成效」：由批次連結開啟單一批次，數字與 API 一致並標示「已受理不代表已收到或已讀」', JSON.stringify({ ui, api: [apiA.ctr, apiA.add_rate, apiA.click_deal_rate, apiA.notify_deal_rate] }));
        // 篩選回應亂序：較早的查詢晚到，不覆蓋較新的篩選結果
        let held = null;
        await ap.route('**/api/analytics/restock-notify/summary**', async (route) => { if (!held && /product_id=704/.test(route.request().url())) { held = route; return; } route.continue(); });
        await ap.evaluate(() => { av2RsClearBatch(); return null; }); await sleep(1200);
        await ap.selectOption('#av2-rs-from', '').catch(() => {});
        await ap.evaluate(() => { document.getElementById('av2-rs-from').value = ''; document.getElementById('av2-rs-to').value = ''; document.getElementById('av2-rs-product').value = '704'; av2RsApply(); return null; }); await sleep(300);
        await ap.evaluate(() => { document.getElementById('av2-rs-product').value = '705'; av2RsApply(); return null; }); await sleep(1500);
        if (held) { const r = await held.fetch().catch(() => null); if (r) await held.fulfill({ response: r }).catch(() => {}); else await held.abort().catch(() => {}); }
        await sleep(1000);
        const rowsNow = await ap.evaluate(() => Array.from(document.querySelectorAll('#av2-rs-table tbody tr td:nth-child(2)')).map((td) => td.textContent));
        assert(rowsNow.length > 0 && rowsNow.every((n) => n === '測試補貨飯糰'), 'V3-2 較早的篩選回應晚到不覆蓋較新的篩選結果', JSON.stringify(rowsNow));
        await ap.unroute('**/api/analytics/restock-notify/summary**');
        // 未追蹤批次顯示「未建立追蹤／無資料」
        if (OLD) {
          await ap.evaluate((u) => { av2OpenRestockBatch(u); return null; }, OLD.uuid); await sleep(1800);
          const un = await ap.evaluate(() => (document.querySelector('#av2-rs-table tr.rs-untracked') || {}).textContent || '');
          assert(/未建立追蹤／無資料/.test(un), 'V3-3 C5 以前的批次在報表顯示「未建立追蹤／無資料」', un.slice(0, 80));
        }
        // LINE 商品管理 → 補貨登記 → 通知批次：有追蹤顯示「📈 成效」連結，舊批次顯示「未建立追蹤」
        await ap.evaluate(() => { showPage('line_products'); return null; }); await sleep(800);
        await ap.evaluate(() => { lpmSwitchTab('demand'); return null; }); await sleep(1500);
        await ap.evaluate((pid) => { openDemandDetail(pid); return null; }, P_A); await sleep(2500);
        const effBtns = await ap.evaluate(() => document.querySelectorAll('#rn-batches [data-act="effect"]').length);
        assert(effBtns >= 1, 'V3-4 通知批次清單提供「📈 成效」連到營運分析中心明細', String(effBtns));
        assert(aerr.length === 0, 'V3-5 後台無 JavaScript 錯誤', aerr.join('|'));
        await actx.close();
      } finally { await browser.close(); }
    }

    // ═══ 11. 選用：舊版程式讀取升級後資料庫 ═══
    if (OLD_ROOT) {
      await C.s.stop();
      const { spawn } = require('child_process'); const port = C.s.port;
      const proc = spawn(process.execPath, ['-r', CLOCK, '-r', path.join(__dirname, 'lib', 'hf1c3-net-mock.js'), '-r', path.join(__dirname, 'lib', 'c4-line-mock.js'), 'server.js'],
        { cwd: OLD_ROOT, env: { ...process.env, PORT: String(port), POS_DB_PATH: C.dbf, C4_CLOCK_OFFSET_MS: String(OFF), GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: 'ignore' });
      const base = `http://127.0.0.1:${port}`; let ok = false; for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { ok = true; break; } } catch {} await sleep(150); }
      const tokO = ok ? await H.login(base, STORE, 'pw001') : null;
      const lst = ok ? await H.api(base, tokO, 'GET', '/api/product-demand-admin/restock/batches') : null;
      assert(ok && lst && lst.json.success && lst.json.data.length > 0, 'K3 舊版程式可在升級後的資料庫正常啟動並讀取通知批次（新增欄位與資料表不影響）', JSON.stringify({ ok, n: lst && lst.json.data.length }));
      if (ok && chromium) {
        // 舊版點餐頁開啟 C5 新連結（含 rt）：照常開啟商品；rt 不留在網址
        const b2 = await chromium.launch(C45.launchOpts());
        try {
          const ctx2 = await b2.newContext({ viewport: { width: 390, height: 860 } }); const pg = await ctx2.newPage(); const e2 = []; pg.on('pageerror', (e) => e2.push(e.message));
          await pg.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: C45.FAKE_LIFF_SDK }));
          const dNow = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
          await pg.goto(`${base}/line-order.html?store_id=${STORE}&product_ref=${puuid(P_A)}&src=restock&m=takeout&d=${dNow}&rt=${rtA}`, { waitUntil: 'domcontentloaded' });
          await sleep(3000);
          const st = await pg.evaluate(() => ({ open: !!document.querySelector('.pdm-overlay.pdm-open'), url: location.search }));
          assert(st.open && !/rt=/.test(st.url) && e2.length === 0, 'K4 舊版點餐頁開啟含追蹤識別的新連結：照常開啟商品，rt 不留在網址', JSON.stringify(st));
        } finally { await b2.close(); }
      }
      await new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); });
      await C.restart(env(OFF));
    }

    const real = boots.reduce((n, b) => n + b.mf.real(), 0);
    assert(real === 0, 'Z 真實 LINE 發送呼叫 0 次（全部在測試程序內攔截）', JSON.stringify({ real, mock: C.mf.calls().length }));
  } catch (e) {
    console.error(e); H.fail('測試例外', e.stack || e.message);
  } finally { await stopAll(); }
  const s = H.summary();
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
