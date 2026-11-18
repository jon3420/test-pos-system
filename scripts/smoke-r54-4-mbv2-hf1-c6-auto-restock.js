#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-auto-restock.js
// R54.4／MBV2-HF1-C6 —— 恢復販售自動補貨通知（保留手動預覽 → 確認發送）＋需求資料 CSV 匯出：驗收（同一組案例先跑 C5.4，再跑 C6）
// 測試層級：[API] 正式路由＋暫存 SQLite 檔（node server.js）；[BR] 真實 Chrome（Playwright）；[RS] SIGKILL 後以同一資料庫檔重啟；
//   [FX] fixture；[DB] 直接核對資料庫檔。
// 外部呼叫：LINE Messaging API 由 c4-line-mock 有狀態替身攔截（retry key 已受理 → 409）；真實 LINE 呼叫必須 0。
// 分類：N＝新功能（基準不存在）；G＝回歸保護（基準本來就應通過）；D＝基準缺陷
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30); // 台北 10:30
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const ONLY = (process.env.C6_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const META = {};
async function step(name, cls, fn) { META[name] = { cls }; try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
// 商品：每個情境一個商品（互不干擾）。第 5 欄 extra：quota／price
const PIDS = { tk: 801, both: 802, quiet: 803, pre: 804, cut: 805, quota: 806, race: 807, queue: 808, rs: 809, sw: 810, master: 811, imp: 812, rpt: 813, nopart: 814, manual: 815, stop: 816, cancel: 817 };
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], ...Object.entries(PIDS).map(([k, id], i) => [id, 'C6商品' + k, i + 1, 'paused', { quota: 50, price: 100 }])];
const seed = (db) => {
  db.run(`UPDATE products SET line_preorder_enabled=1, line_preorder_daily=20 WHERE store_id='store_001'`);
  db.run(`UPDATE products SET line_sell_end='10:00' WHERE id=${PIDS.cut}`); // 今日販售時段已結束（台北 10:30）→ 只能預購
  db.run(`UPDATE products SET sale_status='available', line_quota_enabled=1, line_quota_daily=5, line_quota_sold=5, line_preorder_enabled=0 WHERE id=${PIDS.quota}`); // 今日額度 0、無預購
  db.run(`UPDATE products SET sale_status='available', line_quota_enabled=1, line_quota_daily=1, line_quota_sold=0, line_preorder_enabled=0 WHERE id=${PIDS.cancel}`); // 額度 1（下單後歸零、取消後回補）
};
(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6 恢復販售自動補貨通知＋需求 CSV 匯出 驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const boots = [];
  let browser = null;
  try {
    const OFF = process.env.C4_CLOCK_OFFSET_MS;
    const env = (extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js')], C4_CLOCK_OFFSET_MS: String(OFF), RESTOCK_NOTIFY_BACKOFF_MS: '300,600,900', ...extra });
    const C = await C45.boot('c6', { products: PRODUCTS, members: 120, settings: { restock_notify_enabled: '1' }, seed, env: env() }); boots.push(C);
    const restart = async (extra) => { await C.restart(env(extra)); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    const killAndRestart = async (extra) => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); await restart(extra); };
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const S = (u) => sessAt(u, OFF);
    const q = async (sql, params) => { await sleep(150); const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const editDb = async (fn, extra) => { await C.s.stop(); try { const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } } finally { await restart(extra); } };
    const lineCtl = (o) => fs.writeFileSync(C.mf.ctrl, JSON.stringify(o || { default: '200' }));
    const pushes = () => C.mf.calls();
    const pushesTo = (u) => pushes().filter((c) => c.uid === u);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const dayPlus = (n) => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
    const reg = async (u, pid, pref = 'any', consent = true) => {
      const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: pref, notify_consent: consent, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
      if (!r.json || !r.json.success) throw new Error('register ' + r.text.slice(0, 200)); return r.json.data;
    };
    const setStatus = (pid, st) => adm('PATCH', `/api/products/${pid}/line-status`, { sale_status: st });
    const autoOn = (on = true) => adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: on });
    const part = (pid, on = true) => adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: on });
    const events = async (pid) => { const r = await adm('GET', `/api/product-demand-admin/restock/auto/events?product_id=${pid}`); return (r.json && r.json.data) || []; };
    const batchesOf = async (pid) => { const r = await adm('GET', `/api/product-demand-admin/restock/batches?product_id=${pid}`); return (r.json && r.json.data) || []; };
    const settle = async (pid, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        const ev = await events(pid); const bs = await batchesOf(pid);
        const busy = ev.some((e) => ['queued', 'processing'].includes(e.status)) || bs.some((b) => b.status === 'sending' || b.running);
        if (!busy) return { ev, bs };
        if (Date.now() - t0 > ms) return { ev, bs, timeout: true };
        await sleep(200);
      }
    };
    lineCtl({ default: '200' });
    if (chromium && want('UI')) browser = await chromium.launch(C45.launchOpts());

    // ═══════════════ 開關、基線與觸發 ═══════════════
    await step('A0', 'G', async () => {
      // 開關關閉（預設）時恢復販售：自動 LINE 呼叫 0 次；手動預覽仍可用
      await reg(U(1), PIDS.nopart, 'any');
      const p0 = pushes().length;
      await setStatus(PIDS.nopart, 'available'); await sleep(1200);
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: PIDS.nopart, fulfillment_mode: 'takeout', supply_date: today });
      assert(pushes().length === p0 && pv.json && pv.json.success && pv.json.data.stats.eligible_count === 1,
        'A0 [API] 自動通知預設關閉：商品恢復販售時自動 LINE 呼叫 0 次；手動「預覽」照常計算名單（1 位）', JSON.stringify({ pushes: pushes().length - p0, eligible: pv.json && pv.json.data && pv.json.data.stats.eligible_count }));
    });
    await step('A1', 'N', async () => {
      const r0 = await adm('GET', '/api/product-demand-admin/restock/auto');
      const d = r0.json && r0.json.data;
      assert(r0.status === 200 && d && d.enabled === false && d.participating_products.length === 0 && /最近可訂購日期/.test(d.rules.date) && /外帶/.test(d.rules.modes) && d.mode_priority[0] === 'takeout',
        'A1 [API] 全店自動通知預設關閉、商品預設不參與；設定回傳適用商品、取餐方式與供應日期規則', JSON.stringify({ enabled: d && d.enabled, parts: d && d.participating_products.length }));
    });
    await step('A2', 'N', async () => {
      // 初次啟用只建立觀測基線：已經可售的參與商品不追發
      await reg(U(2), PIDS.quiet, 'any');
      await setStatus(PIDS.quiet, 'available'); await sleep(500); // 尚未開啟自動 → 不觸發
      await part(PIDS.quiet, true);
      const p0 = pushes().length;
      const on = await autoOn(true); await sleep(1500);
      const ev = await events(PIDS.quiet);
      assert(on.json && on.json.success && on.json.data.enabled === true && ev.length === 0 && pushes().length === p0,
        'A2 [API] 開啟自動通知只建立觀測基線：已可售的參與商品不建立事件、不追發（LINE 0 次）', JSON.stringify({ ev: ev.length, pushes: pushes().length - p0 }));
    });
    await step('A3', 'N', async () => {
      // 外帶可訂、外送不可訂：只通知外帶偏好與「都可以」的合格且同意登記；未同意、撤回、取消、外送偏好排除
      const P = PIDS.tk;
      // 外送全週不營業（外送不可訂）；外帶照常
      const noDel = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { noDel[k] = { enabled: false, open: '00:00', close: '23:59' }; });
      await editDb((db) => { db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','delivery_business_hours',?)", [JSON.stringify(noDel)]); });
      await part(P, true);
      await reg(U(10), P, 'takeout'); await reg(U(11), P, 'any'); await reg(U(12), P, 'delivery');
      await reg(U(13), P, 'takeout', false); await reg(U(14), P, 'takeout'); await reg(U(15), P, 'takeout');
      await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(U(14)), product_id: P });
      await pub('POST', '/api/product-demand/cancel', { member_session: S(U(15)), product_id: P });
      const p0 = pushes().length;
      const r = await setStatus(P, 'available');
      const { ev, bs, timeout } = await settle(P);
      const sent = pushes().slice(p0);
      const e = ev[0] || {};
      const det = (e.details || [])[0] || {};
      const msg = sent[0] ? sent[0].text : '';
      assert(r.status === 200 && !timeout && ev.length === 1 && e.status === 'completed' && e.modes.length === 1 && e.modes[0].mode === 'takeout' && e.modes[0].date === today
        && sent.length === 2 && new Set(sent.map((c) => c.uid)).size === 2 && sent.every((c) => [U(10), U(11)].includes(c.uid))
        && bs.length === 1 && bs[0].source === 'auto' && bs[0].counts.accepted === 2 && /已恢復供應/.test(msg) && /[?&]rt=/.test(msg) && /product_ref=/.test(msg) && det.result === 'batch',
        'A3 [API] 恢復販售（外帶可訂、外送不可訂）：自動建立外帶批次，只通知外帶偏好與「都可以」的同意登記（2 位）；外送偏好、未同意、已撤回、已取消皆排除；訊息含商品直達與 rt',
        JSON.stringify({ ev: ev.length, st: e.status, modes: e.modes, sent: sent.length, counts: bs[0] && bs[0].counts, exclusions: det.exclusions }));
    });
    await step('A4', 'N', async () => {
      // 多次儲存、連點、修改名稱／價格、停售再恢復：不重複通知
      const P = PIDS.tk;
      const p0 = pushes().length; const e0 = (await events(P)).length;
      await setStatus(P, 'available'); await Promise.all([setStatus(P, 'available'), setStatus(P, 'available')]);
      await adm('PATCH', `/api/products/${P}/line-settings`, { line_name: 'C6商品tk（改名）', line_price: 120 });
      await adm('PUT', `/api/products/${P}`, { name: 'C6商品tk-renamed', price: 99 });
      await sleep(800);
      const e1 = (await events(P)).length;
      await setStatus(P, 'paused'); await setStatus(P, 'available');
      const { ev } = await settle(P);
      const last = ev[0];
      const allDays = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { allDays[k] = { enabled: true, open: '00:00', close: '23:59' }; });
      await editDb((db) => { db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','delivery_business_hours',?)", [JSON.stringify(allDays)]); });
      assert(e1 === e0 && pushes().length === p0 && ev.length === e0 + 1 && last.status === 'skipped' && JSON.stringify(last.details).includes('already_notified'),
        'A4 [API] 重複儲存可售、連點、改名稱／價格不建立事件；停售再恢復會記錄事件，但本週期已通知者不再發送（LINE 0 次、原因：本週期已通知）',
        JSON.stringify({ e0, e1, total: ev.length, last: last && { st: last.status, reason: last.reason, d: last.details } }));
    });
    await step('A5', 'N', async () => {
      // 兩種取餐方式同時合格：「都可以」只通知一次（外帶優先）；外送偏好走外送批次
      const P = PIDS.both;
      await part(P, true);
      await reg(U(20), P, 'any'); await reg(U(21), P, 'delivery'); await reg(U(22), P, 'takeout');
      const p0 = pushes().length;
      await setStatus(P, 'available');
      const { ev, bs } = await settle(P);
      const sent = pushes().slice(p0);
      const per = (u) => sent.filter((c) => c.uid === u).length;
      const tk = bs.find((b) => b.fulfillment_mode === 'takeout'), dl = bs.find((b) => b.fulfillment_mode === 'delivery');
      assert(ev.length === 1 && ev[0].modes.length === 2 && per(U(20)) === 1 && per(U(21)) === 1 && per(U(22)) === 1 && sent.length === 3
        && tk && dl && /外帶自取/.test(sent.find((c) => c.uid === U(20)).text) && /外送/.test(sent.find((c) => c.uid === U(21)).text),
        'A5 [API] 外帶與外送同時合格：「都可以」只通知一次（外帶優先）、外送偏好收到外送通知、外帶偏好收到外帶通知（共 3 則）',
        JSON.stringify({ per: [per(U(20)), per(U(21)), per(U(22))], modes: ev[0] && ev[0].modes }));
    });
    await step('A6', 'N', async () => {
      // 休息日／今日不可訂：以伺服器判斷的最近可訂購日（未來）發送「開放預購」文案；今日販售時段已結束 → 預購日期為明天
      const P = PIDS.cut;
      await part(P, true); await reg(U(30), P, 'takeout');
      const p0 = pushes().length;
      await setStatus(P, 'available');
      const { ev } = await settle(P);
      const sent = pushes().slice(p0);
      const t = sent[0] ? sent[0].text : '';
      assert(ev.length === 1 && ev[0].modes[0].date === dayPlus(1) && ev[0].modes[0].notice_kind === 'preorder' && /已開放預購/.test(t) && /預購日期/.test(t) && !/已恢復供應/.test(t),
        'A6 [API] 今日販售時段已結束：供應日期取最近可訂購日（明天），訊息使用「已開放預購／預購日期」，不稱今日可取餐', JSON.stringify({ modes: ev[0] && ev[0].modes, text: t.split('\n').slice(0, 3) }));
      // 休息日：今天（星期 X）外帶不營業 → 最近可訂購日跳過今天
      const P2 = PIDS.pre;
      const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(today + 'T00:00:00Z').getUTCDay()];
      const hours = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { hours[k] = { enabled: k !== wd, open: '00:00', close: '23:59' }; });
      await editDb((db) => { db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','takeout_business_hours',?)", [JSON.stringify(hours)]); db.run(`UPDATE products SET line_delivery_enabled=0 WHERE id=${P2}`); });
      await part(P2, true); await reg(U(31), P2, 'takeout');
      const p1 = pushes().length;
      await setStatus(P2, 'available');
      const r2 = await settle(P2);
      const t2 = (pushes().slice(p1)[0] || {}).text || '';
      await editDb((db) => { const all = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { all[k] = { enabled: true, open: '00:00', close: '23:59' }; }); db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','takeout_business_hours',?)", [JSON.stringify(all)]); });
      assert(r2.ev.length === 1 && r2.ev[0].modes[0].date > today && /已開放預購/.test(t2),
        'A6b [API] 休息日：今天外帶不營業 → 供應日期為之後最近的營業日，使用預購文案', JSON.stringify({ modes: r2.ev[0] && r2.ev[0].modes }));
    });
    await step('A7', 'N', async () => {
      // 額度為 0：只改名稱不觸發；手動增加可售額度使今日可訂購 → 觸發；額度再歸零 → 不觸發
      const P = PIDS.quota;
      await part(P, true); await reg(U(40), P, 'takeout');
      const p0 = pushes().length;
      await adm('PATCH', `/api/products/${P}/line-settings`, { line_name: '額度商品' }); await sleep(800);
      const e0 = (await events(P)).length;
      await adm('PATCH', `/api/products/${P}/line-settings`, { line_quota_daily: 8 });
      const { ev } = await settle(P);
      const sent = pushes().slice(p0);
      assert(e0 === 0 && ev.length === 1 && ev[0].trigger_fields.line_quota && ev[0].modes.some((m) => m.mode === 'takeout' && m.date === today) && sent.filter((c) => c.uid === U(40)).length === 1,
        'A7 [API] 今日額度 0：改名稱不觸發；手動增加可售額度（5→8）使今日可訂購 → 自動通知外帶偏好登記 1 次', JSON.stringify({ e0, ev: ev.map((e) => ({ f: e.trigger_fields, m: e.modes })) }));
    });

    // ═══════════════ 手動／自動共用防重送 ═══════════════
    await step('B1', 'N', async () => {
      // 手動先送 → 之後自動恢復不再通知；自動先送 → 之後手動預覽排除
      const P = PIDS.manual;
      await part(P, true); await reg(U(50), P, 'takeout'); await reg(U(51), P, 'takeout');
      await setStatus(P, 'available'); // 第一次：自動（商品原為暫停）
      await settle(P);
      const auto1 = pushes().filter((c) => [U(50), U(51)].includes(c.uid)).length;
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P, fulfillment_mode: 'takeout', supply_date: today });
      // 另一個商品：手動先送，之後自動
      const P2 = PIDS.race;
      await part(P2, true); await reg(U(52), P2, 'takeout');
      await setStatus(P2, 'available'); await settle(P2); // 自動先送給 U52
      await reg(U(53), P2, 'takeout');
      const mpv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P2, fulfillment_mode: 'takeout', supply_date: today });
      await adm('POST', `/api/product-demand-admin/restock/batches/${mpv.json.data.batch_uuid}/confirm`, {}); // 手動送給 U53
      await sleep(1500);
      await setStatus(P2, 'paused'); await setStatus(P2, 'available'); const r2 = await settle(P2);
      assert(auto1 === 2 && pv.json.data.stats.eligible_count === 0 && (pv.json.data.stats.exclusions.already_notified || 0) === 2
        && pushesTo(U(52)).length === 1 && pushesTo(U(53)).length === 1 && r2.ev[0].status === 'skipped',
        'B1 [API] 自動先送 → 手動預覽排除「本週期已通知」；手動先送 → 再次恢復販售的自動事件不再發送（每人只 1 則）',
        JSON.stringify({ auto1, manualEligible: pv.json.data.stats.eligible_count, u52: pushesTo(U(52)).length, u53: pushesTo(U(53)).length, last: r2.ev[0] && r2.ev[0].status }));
    });
    await step('B2', 'N', async () => {
      // 競爭：手動預覽已建立、自動恢復與手動確認同時進行 → 每位只通知一次
      const P = PIDS.stop;
      await part(P, true); for (const i of [60, 61, 62]) await reg(U(i), P, 'takeout');
      await setStatus(P, 'available'); await settle(P); // 自動送出
      await setStatus(P, 'paused');
      for (const i of [63, 64]) await reg(U(i), P, 'takeout');
      await setStatus(P, 'available').then(() => null);
      const mpv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P, fulfillment_mode: 'takeout', supply_date: today });
      const conf = mpv.json.data.batch_uuid ? adm('POST', `/api/product-demand-admin/restock/batches/${mpv.json.data.batch_uuid}/confirm`, {}) : Promise.resolve(null);
      await Promise.all([conf, setStatus(P, 'paused').then(() => setStatus(P, 'available'))]);
      await settle(P); await sleep(1500);
      const per = [60, 61, 62, 63, 64].map((i) => pushesTo(U(i)).length);
      const claims = await q("SELECT request_uuid, COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id='store_001' AND product_id=? AND status='accepted' GROUP BY request_uuid HAVING c>1", [P]);
      assert(per.every((n) => n === 1) && claims.length === 0, 'B2 [API] 手動確認與自動恢復同時進行：每位同意的登記只收到 1 則、同一登記週期最多 1 筆已受理', JSON.stringify({ per }));
    });
    await step('B3', 'N', async () => {
      // 排隊後撤回／取消／停售：發送前重新檢查，排除並保留原因（逐筆間隔 1.2 秒）
      await restart({ RESTOCK_NOTIFY_SEND_INTERVAL_MS: '1200' });
      const P = PIDS.queue;
      await part(P, true); for (const i of [70, 71, 72, 73]) await reg(U(i), P, 'takeout');
      await setStatus(P, 'available');
      for (let i = 0; i < 40 && pushes().filter((c) => [U(70), U(71), U(72), U(73)].includes(c.uid)).length < 1; i++) await sleep(100);
      await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(U(72)), product_id: P });
      await pub('POST', '/api/product-demand/cancel', { member_session: S(U(73)), product_id: P });
      const { bs } = await settle(P, 20000);
      const det = (await adm('GET', `/api/product-demand-admin/restock/batches/${bs[0].batch_uuid}`)).json.data;
      const rows = det.deliveries || det.rows || [];
      const reasonOf = (u) => { const r = rows.find((x) => x.member === undefined ? false : (x.line_user_id === u)); return r; };
      void reasonOf;
      const sentTo = [70, 71, 72, 73].map((i) => pushesTo(U(i)).length);
      const dbRows = await q("SELECT line_user_id, status, exclusion_reason FROM restock_notify_deliveries WHERE batch_uuid=?", [bs[0].batch_uuid]);
      const r72 = dbRows.find((r) => r.line_user_id === U(72)), r73 = dbRows.find((r) => r.line_user_id === U(73));
      // 另一情境：發送途中停售 → 尚未送出者排除（商品不可訂購）
      const P2 = PIDS.sw;
      await part(P2, true); for (const i of [74, 75, 76]) await reg(U(i), P2, 'takeout');
      await setStatus(P2, 'available');
      for (let i = 0; i < 40 && pushes().filter((c) => [U(74), U(75), U(76)].includes(c.uid)).length < 1; i++) await sleep(100);
      await setStatus(P2, 'paused');
      const r2 = await settle(P2, 20000);
      const st2 = await q("SELECT status, exclusion_reason FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id", [r2.bs[0].batch_uuid]);
      await restart();
      assert(sentTo[0] === 1 && sentTo[1] === 1 && sentTo[2] === 0 && sentTo[3] === 0 && r72 && r72.status === 'blocked' && r72.exclusion_reason === 'consent_revoked' && r73 && r73.exclusion_reason === 'cancelled'
        && st2.filter((r) => r.status === 'accepted').length === 1 && st2.filter((r) => r.status === 'blocked' && /product_not_orderable/.test(r.exclusion_reason)).length === 2,
        'B3 [API] 排隊後撤回同意／取消登記／停售：發送前重新檢查並排除（保留原因），已受理者不變', JSON.stringify({ sentTo, r72, r73, st2 }));
    });

    // ═══════════════ 結果不明、重啟、retry key、開關 ═══════════════
    await step('C1', 'N', async () => {
      // timeout → 同一 retry key 重試受理；LINE 已受理但回應遺失 → 同 key 重送得 409（已受理）→ 記錄已受理、不重複
      const P = PIDS.rpt;
      await part(P, true); await reg(U(80), P, 'takeout'); await reg(U(81), P, 'takeout');
      lineCtl({ default: '200', byUser: { [U(80)]: ['timeout', '200'], [U(81)]: ['accepted_lost', '200'] } });
      await setStatus(P, 'available');
      const { bs } = await settle(P, 20000);
      lineCtl({ default: '200' });
      const c80 = pushesTo(U(80)), c81 = pushesTo(U(81));
      const rows = await q('SELECT line_user_id, status, attempt_count, retry_key FROM restock_notify_deliveries WHERE batch_uuid=?', [bs[0].batch_uuid]);
      const keys = (u) => new Set(pushesTo(u).map((c) => c.retry_key));
      assert(rows.every((r) => r.status === 'accepted') && c80.length === 2 && c81.length === 2 && keys(U(80)).size === 1 && keys(U(81)).size === 1 && c81[1].result === 409,
        'C1 [API] 自動批次 timeout 與「LINE 已受理但回應遺失」：沿用同一 retry key 重試，後者得到 409 已受理 → 兩位都記為 LINE 已受理（LINE 端各只受理一次）', JSON.stringify({ rows, c81: c81.map((c) => c.result) }));
    });
    let rsBatch = null;
    await step('C2', 'N', async () => {
      // [RS] LINE 已受理、本機尚未保存（送出後程序中斷）→ 重啟後該筆為結果待確認、不自動重送；其餘從未送出者自動續送（原 retry key）
      await restart({ RESTOCK_NOTIFY_SEND_INTERVAL_MS: '300' });
      const P = PIDS.rs;
      await part(P, true); for (const i of [90, 91, 92]) await reg(U(i), P, 'takeout');
      lineCtl({ default: '200', byUser: { [U(90)]: ['accepted_hang'] } });
      await setStatus(P, 'available');
      for (let i = 0; i < 60 && !pushesTo(U(90)).length; i++) await sleep(100);
      await sleep(150);
      await killAndRestart();
      lineCtl({ default: '200' });
      await sleep(4000);
      const bs = await batchesOf(P); rsBatch = bs[0];
      const rows = await q('SELECT line_user_id, status, error_code FROM restock_notify_deliveries WHERE batch_uuid=? ORDER BY id', [bs[0].batch_uuid]);
      const r90 = rows.find((r) => r.line_user_id === U(90));
      assert(pushesTo(U(90)).length === 1 && r90.status === 'unknown' && pushesTo(U(91)).length === 1 && pushesTo(U(92)).length === 1 && rows.filter((r) => r.status === 'accepted').length === 2,
        'C2 [API][RS] 送出後程序中斷：重啟後已送出者為「結果待確認」、不自動重送；其餘從未送出的項目自動續送（每人 1 則）', JSON.stringify({ rows, b: bs[0] && bs[0].status }));
    });
    await step('C3', 'N', async () => {
      // retry key 超過官方有效時間窗：店家續送也不換新 key 重送結果不明的訊息
      if (!rsBatch) throw new Error('需要 C2');
      await editDb((db) => { db.run("UPDATE restock_notify_deliveries SET first_attempt_at=datetime('now','-25 hours') WHERE batch_uuid=? AND status='unknown'", [rsBatch.batch_uuid]); });
      const p0 = pushesTo(U(90)).length;
      const r = await adm('POST', `/api/product-demand-admin/restock/batches/${rsBatch.batch_uuid}/resume`, {});
      await sleep(1500);
      const row = (await q('SELECT status, error_code, retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [rsBatch.batch_uuid, U(90)]))[0];
      assert(pushesTo(U(90)).length === p0 && row.status === 'unknown' && row.error_code === 'retry_window_expired',
        'C3 [API] retry key 超過有效時間窗：店家續送不換新 key、不重送結果不明的訊息（維持結果待確認）', JSON.stringify({ r: r.status, row: { st: row.status, ec: row.error_code } }));
    });
    await step('C4', 'N', async () => {
      // 自動開關在批次進行中關閉：下一筆前暫停；已受理保留；重新開啟不追發；店家明確續送＝人工接手（沿用原 retry key）
      await restart({ RESTOCK_NOTIFY_SEND_INTERVAL_MS: '1500' });
      const P = PIDS.master;
      await part(P, true); for (const i of [100, 101, 102]) await reg(U(i), P, 'takeout');
      await setStatus(P, 'available');
      for (let i = 0; i < 60 && !pushes().some((c) => [U(100), U(101), U(102)].includes(c.uid)); i++) await sleep(100);
      await autoOn(false);
      await sleep(3500);
      const bs = await batchesOf(P);
      const n1 = [100, 101, 102].map((i) => pushesTo(U(i)).length);
      const keyBefore = (await q("SELECT retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND status IN ('pending','retry_wait')", [bs[0].batch_uuid])).map((r) => r.retry_key);
      await autoOn(true); await sleep(2500);
      const n2 = [100, 101, 102].map((i) => pushesTo(U(i)).length);
      const st2 = (await batchesOf(P))[0];
      const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${bs[0].batch_uuid}/resume`, {});
      await settle(P, 20000);
      const n3 = [100, 101, 102].map((i) => pushesTo(U(i)).length);
      const keysUsed = pushes().filter((c) => [U(101), U(102)].includes(c.uid)).map((c) => c.retry_key);
      const b3 = (await batchesOf(P))[0];
      await restart();
      assert(bs[0].status === 'paused' && bs[0].pause_reason === 'auto_disabled' && n1.reduce((a, b) => a + b, 0) === 1 && n2.join() === n1.join() && st2.status === 'paused'
        && rs.status === 200 && n3.every((n) => n === 1) && keysUsed.every((k) => keyBefore.includes(k)) && b3.taken_over_by,
        'C4 [API] 批次進行中關閉自動通知：下一筆前暫停（已受理 1 則保留）；重新開啟不追發；店家明確續送＝人工接手，沿用原 retry key 完成（每人 1 則）',
        JSON.stringify({ paused: bs[0] && [bs[0].status, bs[0].pause_reason], n1, n2, n3, takeover: b3 && b3.taken_over_by }));
    });
    await step('C8', 'N', async () => {
      // 訂單取消回補額度使商品恢復可訂購：不是商家明確恢復販售 → 不觸發自動通知
      const P = PIDS.cancel;
      await part(P, true);
      const o = await pub('POST', '/api/line-orders', { customer_name: '回補', customer_phone: '0912000999', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'cash', items: [{ product_id: P, qty: 1 }] });
      await reg(U(115), P, 'takeout');
      const e0 = (await events(P)).length; const p0 = pushesTo(U(115)).length;
      const c = await adm('PATCH', `/api/orders/${o.json.data.uuid}/status`, { order_status: 'cancelled' });
      await sleep(1500);
      const sold = (await q('SELECT line_quota_sold FROM products WHERE id=?', [P]))[0];
      assert(o.json.success && c.status === 200 && Number(sold.line_quota_sold) === 0 && (await events(P)).length === e0 && pushesTo(U(115)).length === p0,
        'C8 [API] 訂單取消回補額度（商品因此可訂購）：不建立自動事件、LINE 0 次（只有商家明確恢復販售或手動增加額度才觸發）', JSON.stringify({ c: c.status, sold, e0 }));
    });
    await step('C5', 'N', async () => {
      // 總開關關閉：自動通知不能繞過 → 事件記錄「總開關關閉」、LINE 0 次；手動也不能發送
      const P = PIDS.imp;
      await part(P, true); await reg(U(110), P, 'takeout');
      await adm('PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const p0 = pushes().length;
      await setStatus(P, 'available');
      const { ev } = await settle(P);
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P, fulfillment_mode: 'takeout', supply_date: today });
      await adm('PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      assert(ev.length === 1 && ev[0].status === 'skipped' && ev[0].reason === 'send_disabled' && pushes().length === p0 && pv.json.data.can_send === false,
        'C5 [API] 補貨通知總開關關閉：自動通知不發送（事件記錄「總開關關閉」、LINE 0 次）；手動也無法發送', JSON.stringify({ ev: ev[0] && [ev[0].status, ev[0].reason] }));
    });
    await step('C6', 'N', async () => {
      // 自動開關關閉時已排隊的事件取消；關閉期間的恢復販售不記錄、不追發；商品未參與時不建立事件
      const P = PIDS.imp;
      await setStatus(P, 'paused');
      await autoOn(false);
      await setStatus(P, 'available'); await sleep(800);
      const e1 = await events(P);
      await autoOn(true); await sleep(1500);
      const e2 = await events(P);
      await part(PIDS.nopart, false); await setStatus(PIDS.nopart, 'paused'); await setStatus(PIDS.nopart, 'available'); await sleep(800);
      const e3 = await events(PIDS.nopart);
      assert(e1.length === 1 && e2.length === 1 && e3.length === 0, 'C6 [API] 自動關閉期間的恢復販售不建立事件，重新開啟也不追發；未參與的商品恢復販售不建立事件',
        JSON.stringify({ e1: e1.length, e2: e2.length, e3: e3.length }));
    });
    // ═══════════════ 成效、匯出、畫面 ═══════════════
    await step('D1', 'N', async () => {
      // 自動通知的點擊、加購、訂單與付款歸因與手動同一口徑；報表可依來源篩選
      const sum = (qs) => adm('GET', '/api/analytics/restock-notify/summary' + (qs ? '?' + qs : ''));
      const b = (await batchesOf(PIDS.tk)).find((x) => x.source === 'auto');
      const msg = pushesTo(U(10))[0].text;
      const link = msg.split('\n').find((l) => /liff\.line\.me/.test(l)).replace(/^.*?(https:)/, '$1');
      const rt = new URL(link).searchParams.get('rt');
      await pub('POST', '/api/product-demand/track/open', { rt, product_id: PIDS.tk, open_key: 'c6open0001', visitor_id: 'v_c6', session_id: 's_c6', member_session: S(U(10)) });
      await pub('POST', '/api/analytics/events', { visitor_id: 'v_c6', session_id: 's_c6', event_name: 'add_to_cart', product_id: PIDS.tk, quantity: 1, metadata: { restock: { rt, open_key: 'c6open0001', event_key: 'c6event0001' } }, member_session: S(U(10)) });
      const o = await pub('POST', '/api/line-orders', { customer_name: '成效', customer_phone: '0912345678', order_type: 'takeout', pickup_date: today, pickup_time: '22:30', payment_method: 'cash', items: [{ product_id: PIDS.tk, qty: 2 }], analytics: { visitor_id: 'v_c6', session_id: 's_c6' }, member_session: S(U(10)) });
      await sleep(800);
      const all = (await sum('')).json.data; const auto = (await sum('source=auto')).json.data; const man = (await sum('source=manual')).json.data;
      const row = auto.batches.find((x) => x.batch_uuid === b.batch_uuid);
      assert(o.json && o.json.success && row && row.source === 'auto' && row.click_people === 1 && row.add_people === 1 && row.order_people === 1 && row.deal_people === 1 && row.accepted_people === 2
        && all.totals.batches === auto.totals.batches + man.totals.batches && !man.batches.some((x) => x.batch_uuid === b.batch_uuid),
        'D1 [API] 自動通知出現在成效報表（來源＝自動），點擊、加購、訂單、成交與手動同一口徑；可依手動／自動篩選且合計一致', JSON.stringify({ row, tot: [all.totals.batches, auto.totals.batches, man.totals.batches] }));
    });
    await step('D2', 'N', async () => {
      // CSV 匯出：中文（UTF-8＋BOM）、正確跳脫、防公式注入、遮罩、不輸出 session／權杖；需要員工登入；店別隔離
      await (async () => { const db = await H.openDbFile(C.dbf); db.close(); })();
      await editDb((db) => { db.run("UPDATE line_members SET display_name=? WHERE store_id='store_001' AND line_user_id=?", ['=HYPERLINK("http://x","點我"),"逗號"', U(10)]); });
      const dl = await H.download(C.s.base, C.tok, '/api/product-demand-admin/export.csv?type=details&product_id=' + PIDS.tk);
      const sm = await H.download(C.s.base, C.tok, '/api/product-demand-admin/export.csv?type=summary');
      const txt = dl.buf.toString('utf8'); const stx = sm.buf.toString('utf8');
      const noAuth = await fetch(C.s.base + '/api/product-demand-admin/export.csv?type=details&store_id=store_001');
      const s2 = await H.login(C.s.base, 'store_002', 'pw002').catch(() => null);
      const other = s2 ? await H.download(C.s.base, s2, '/api/product-demand-admin/export.csv?type=details') : null;
      const lines = txt.replace(/^﻿/, '').trim().split('\r\n');
      assert(dl.status === 200 && txt.charCodeAt(0) === 0xFEFF && /補貨通知/.test(lines[0]) && /C6商品tk/.test(txt) && txt.includes(`"'=HYPERLINK(""http://x"",""點我""),""逗號"""`) && !txt.includes(U(10))
        && !/member_session|retry_key|request_uuid|consent_uuid|test-only-channel-token/.test(txt) && /LINE 已受理/.test(txt) && /已撤回/.test(txt) && /已取消/.test(txt)
        && sm.status === 200 && /有效登記人數/.test(stx) && noAuth.status === 401 && (!other || !other.buf.toString('utf8').includes('C6商品tk')),
        'D2 [API] 需求 CSV 匯出：UTF-8＋BOM 中文、雙引號正確跳脫、公式開頭加單引號、會員識別遮罩、不含 session／權杖／內部識別；未登入 401；他店看不到本店資料',
        JSON.stringify({ st: dl.status, rows: lines.length, head: lines[0], noAuth: noAuth.status, other: other && other.status }));
    });
    if (want('UI')) await step('D3', 'N', async () => {
      if (!browser) throw new Error('需要瀏覽器');
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await ctx.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試店' })); }, [C.tok]);
      const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
      await pg.goto(C.s.base + '/');
      await pg.waitForFunction(() => typeof rnAutoLoad === 'function' && typeof openDemandDetail === 'function', null, { timeout: 15000 });
      await pg.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function', null, { timeout: 15000 });
      await pg.evaluate(() => showPage('line_products')); await sleep(800);
      await pg.evaluate(() => lpmSwitchTab('demand'));
      await pg.waitForFunction(() => /已開啟|關閉/.test((document.getElementById('pd-auto-state') || {}).innerText || ''), null, { timeout: 8000 })
        .catch(async (e) => { const dbg = await pg.evaluate(() => ({ st: (document.getElementById('pd-auto-state') || {}).innerText, tab: typeof _lpmTab !== 'undefined' ? _lpmTab : null })); throw new Error(e.message.slice(0, 60) + ' ' + JSON.stringify(dbg) + ' ' + errs.join('|').slice(0, 300)); });
      await pg.evaluate(() => rnAutoEvents());
      await pg.waitForFunction(() => ((document.getElementById('pd-auto-events') || {}).textContent || '').length > 20, null, { timeout: 8000 })
        .catch(async (e) => { const dbg = await pg.evaluate(async () => { let api = null; try { api = await apiFetch('/api/product-demand-admin/restock/auto/events?limit=30').then((r) => r.json()); } catch (x) { api = String(x); } return { box: (document.getElementById('pd-auto-events') || {}).innerHTML, api: JSON.stringify(api).slice(0, 300) }; }); throw new Error(e.message.slice(0, 40) + ' ' + JSON.stringify(dbg).slice(0, 700) + ' ' + errs.join('|').slice(0, 300)); });
      const ui = await pg.evaluate(() => ({ state: document.getElementById('pd-auto-state').innerText, rules: document.getElementById('pd-auto-rules').textContent, auto: document.getElementById('pd-set-auto').checked, ev: document.getElementById('pd-auto-events').textContent }));
      await pg.evaluate((pid) => openDemandDetail(pid), PIDS.tk);
      await pg.waitForFunction(() => document.querySelector('.rn-batch .rn-source'), null, { timeout: 10000 });
      await pg.waitForFunction(() => (document.getElementById('rn-auto-product') || {}).checked === true, null, { timeout: 5000 }).catch(() => null); // 參與狀態以非同步讀取
      const ui2 = await pg.evaluate(() => ({ src: Array.from(document.querySelectorAll('.rn-batch .rn-source')).map((x) => x.innerText), part: (document.getElementById('rn-auto-product') || {}).checked }));
      await ctx.close();
      assert(ui.auto === true && /已開啟/.test(ui.state) && /最近可訂購日期/.test(ui.rules) && /LINE 已受理/.test(ui.rules) && /已建立通知批次|未發送/.test(ui.ev) && /本週期已通知/.test(ui.ev)
        && ui2.src.includes('自動') && ui2.part === true && !errs.length,
        'D3 [BR] 後台：自動通知開關、適用規則、觸發紀錄（含未發送原因「本週期已通知」）、商品明細「參與自動通知」與批次「自動」標示；無 JavaScript 錯誤',
        JSON.stringify({ state: ui.state.slice(0, 80), src: ui2.src, part: ui2.part, errs: errs.slice(0, 2) }));
    });
    await step('C7', 'N', async () => {
      // 搬家匯入／備份還原：商品經匯入變回可售不觸發自動通知；開關設定不隨備份移轉
      const P = PIDS.imp;
      const dl = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
      const tmp = path.join(H.tmpDir('c6-bk'), 'full.json'); fs.writeFileSync(tmp, dl.buf);
      const bk = JSON.parse(dl.buf.toString('utf8'));
      const keys = JSON.stringify(bk).includes('restock_auto_notify_enabled');
      await setStatus(P, 'paused'); await reg(U(111), P, 'takeout');
      const e0 = (await events(P)).length; const p0 = pushes().length;
      const up = await H.uploadRaw(C.s.base, C.tok, tmp);
      const r = await H.previewAndImport(C.s.base, C.tok, up.json.upload_id, { mode: 'replace', categories: up.json.backup.categories_present, confirm_text: STORE, password: 'pw001' });
      await sleep(2500);
      const st = (await q('SELECT sale_status FROM products WHERE id=?', [P]))[0];
      const e1 = (await events(P)).length;
      await restart(); await sleep(3000);
      const e2 = (await events(P)).length;
      assert(r.import && r.import.status === 'done' && st.sale_status === 'available' && e1 === e0 && e2 === e0 && pushes().length === p0 && !keys,
        'C7 [API] 備份還原（取代商品）使商品變回可售：不建立自動事件、LINE 0 次，重啟後也不補發；備份不含自動通知開關設定', JSON.stringify({ imp: r.import ? r.import.status : r, st, e: [e0, e1, e2], keys }).slice(0, 600));
    });

    await step('Z', 'G', async () => {
      const real = C.mf.real();
      assert(real === 0, 'Z 真實 LINE Messaging API 呼叫 0 次（全部在測試程序內攔截）', JSON.stringify({ real, mock: pushes().length }));
    });
  } catch (e) {
    assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 800));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const b of boots) { try { await b.s.stop(); } catch {} }
  }
  const sum = H.summary();
  const out = { suite: 'r54-4-mbv2-hf1-c6-auto-restock', root: H.ROOT, pass: sum.passCount, fail: sum.failCount,
    cases: sum.results.map((r) => ({ ok: r.ok, name: r.name, cls: (META[(r.name.match(/^[A-Z]\d*b?/) || [''])[0]] || {}).cls || null, detail: r.detail })) };
  if (process.env.C6_RESULT_JSON) fs.writeFileSync(process.env.C6_RESULT_JSON, JSON.stringify(out, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
