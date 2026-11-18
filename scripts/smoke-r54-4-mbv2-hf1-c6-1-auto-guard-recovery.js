#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-auto-guard-recovery.js
// R54.4／MBV2-HF1-C6.1 —— 自動補貨通知：逐筆送出前的版本防護（缺口 A／B）與預覽保存後中斷的恢復（缺口 C）驗收
//
// 同一份腳本先對「未修改 C6」再對 C6.1 執行（H.ROOT＝腳本所在的應用程式根目錄）。
// 測試層級（每個案例名稱都標示）：
//   [API] 正式路由＋檔案型暫存 SQLite（node server.js 子程序）
//   [RS]  真實 SIGKILL 測試服務子程序，再以同一個資料庫檔重新啟動（不是改資料狀態）
//   [FX]  先以正式 API 建立資料，停機後直接修改資料庫檔建立指定的持久狀態（fixture），再啟動
//   [FN]  直接呼叫函式（另一個 node 子程序）
// 時點控制：
//   - 模擬 LINE：c4-line-mock（有狀態，記錄每次 HTTP 呼叫、retry key、已受理 key）＋ c61-line-gate（指定 UID 的請求先交給模擬 LINE
//     受理，再暫停回應直到測試放行）。等待一律以檔案／API 明確狀態為準，不用固定 sleep 碰運氣。
//   - C6.1 測試掛勾（after_preview／after_confirm）：只在 RESTOCK_AUTO_TEST_HOOKS=1＋RESTOCK_AUTO_TEST_GATE_DIR 時生效。
//     C6 沒有這個掛勾 → [RS] 精確停點案例在 C6 標為「不適用（N/A）」，不計入通過或失敗；
//     C6 的缺口 C 以 [FX] 案例（同一持久狀態）證明業務結果錯誤。
// 真實 LINE 呼叫必須為 0（Z）。
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
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const RA_SRC = fs.readFileSync(path.join(H.ROOT, 'utils', 'restockAuto.js'), 'utf8');
const HAS_HOOKS = RA_SRC.includes('RESTOCK_AUTO_TEST_HOOKS');
const ONLY = (process.env.C61_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const META = {}; const NA = [];
async function step(name, cls, fn) { if (!want(name)) return; META[name] = { cls }; try { await fn(META[name]); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }
function na(name, why) { NA.push({ name, why }); console.log(`  ⚪ ${name}  — 不適用：${why}`); }
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const P = { g1: 951, a1: 952, a2: 953, b1: 954, b2: 955, m2: 956, g2: 957, g3: 958, g4: 959, rs1: 960, rs2: 961, rs3: 962, rs4: 963, rs4b: 964, fx1: 965, fx2: 966, h1: 967, rs5: 968, rs6: 969 };
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], ...Object.entries(P).map(([k, id], i) => [id, 'C61商品' + k, i + 1, 'paused', { quota: 50, price: 100 }])];

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 自動補貨通知防護與中斷恢復 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　測試掛勾：' + (HAS_HOOKS ? '有（C6.1）' : '無（C6 基準）'));
  const GATE = H.tmpDir('c61-gate');
  let OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = (extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c61-line-gate.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), RESTOCK_NOTIFY_BACKOFF_MS: '300,600,900', RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '30000',
    RESTOCK_AUTO_TEST_HOOKS: '1', RESTOCK_AUTO_TEST_GATE_DIR: GATE, C61_LINE_GATE_DIR: GATE, ...extra });
  let C = null;
  try {
    // 第二店（跨店隔離用）：直接在種子資料開啟自動通知與商品參與（第二店未開通 LINE 點餐功能，不經 API）
    const seed2 = (db) => {
      for (const [k, v] of [['restock_auto_notify_enabled', '1'], ['restock_auto_notify_epoch', '7'], ['restock_auto_notify_enabled_at', '2026-11-01T00:00:00.000Z']]) db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_002',?,?)", [k, v]);
      const pc = db.exec('PRAGMA table_info(products)')[0].values.map((r) => r[1]);
      db.run(`UPDATE products SET restock_auto_notify=1${pc.includes('restock_auto_version') ? ', restock_auto_version=5' : ''} WHERE store_id='store_002'`);
    };
    C = await C45.boot('c61', { products: PRODUCTS, members: 120, settings: { restock_notify_enabled: '1' }, seed: seed2, env: env() });
    let curEnv = env();
    const restart = async (extra) => { curEnv = env(extra); await C.restart(curEnv); C.tok = await H.login(C.s.base, STORE, 'pw001'); };
    const kill = async () => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); return p.signalCode; };
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const S = (u) => sessAt(u, OFF);
    const today = () => new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const q = async (sql, params) => { const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const cols = async (t) => (await q(`PRAGMA table_info(${t})`)).map((c) => c.name);
    const editDb = async (fn) => { await C.s.stop(); const db = await H.openDbFile(C.dbf); try { await fn(db); H.saveDbFile(db, C.dbf); } finally { db.close(); } await restart(); await waitBoot(); };
    const lineCtl = (o) => fs.writeFileSync(C.mf.ctrl, JSON.stringify(o || { default: '200' }));
    const calls = (u) => C.mf.calls().filter((c) => c.uid === u);
    const acceptedKeys = () => Object.keys(JSON.parse(fs.readFileSync(C.mf.state, 'utf8')).accepted || {});
    const reg = async (u, pid, pref = 'takeout') => {
      const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: pref, notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
      if (!r.json || !r.json.success) throw new Error('register ' + r.text.slice(0, 200)); return r.json.data;
    };
    const setStatus = (pid, st) => adm('PATCH', `/api/products/${pid}/line-status`, { sale_status: st });
    const autoOn = (on = true) => adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: on });
    const part = (pid, on = true) => adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: on });
    const master = (on) => adm('PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: on });
    const events = async (pid) => { const r = await adm('GET', `/api/product-demand-admin/restock/auto/events?product_id=${pid}`); return (r.json && r.json.data) || []; };
    const batchesOf = async (pid) => { const r = await adm('GET', `/api/product-demand-admin/restock/batches?product_id=${pid}`); return (r.json && r.json.data) || []; };
    const settle = async (pid, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        const ev = await events(pid); const bs = await batchesOf(pid);
        const busy = ev.some((e) => ['queued', 'processing'].includes(e.status)) || bs.some((b) => b.status === 'sending' || b.running);
        if (!busy) return { ev, bs };
        if (Date.now() - t0 > ms) return { ev, bs, timeout: true };
        await sleep(50);
      }
    };
    const waitFile = async (f, ms = 20000) => { const t0 = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
    const gateFile = (n) => path.join(GATE, n);
    const clearGate = () => { for (const f of fs.readdirSync(GATE)) fs.unlinkSync(path.join(GATE, f)); };
    // 重啟後等待開機恢復完成（C6.1 有明確紀錄；C6 沒有 → 以 5 秒上限等待，僅用於基準）
    const waitBoot = async () => {
      const t0 = Date.now();
      while (!/\[restock_auto\] boot recovery done/.test(C.s.getLog())) { if (Date.now() - t0 > 5000) break; await sleep(30); }
      for (const pid of Object.values(P)) await settle(pid, 5000); // 沒有進行中的事件與批次
    };
    const dels = async (bu) => q('SELECT d.*, r.notified_at FROM restock_notify_deliveries d LEFT JOIN product_demand_requests r ON r.request_uuid=d.request_uuid WHERE d.batch_uuid=? ORDER BY d.id', [bu]);
    const delOf = async (bu, u) => (await dels(bu)).find((d) => d.line_user_id === u) || {};
    // 同批兩名以上合格收件人，第一筆在模擬 LINE 處暫停（已受理、回應未返回）
    const startGated = async (pid, users) => {
      await part(pid, true);
      for (const u of users) await reg(u, pid);
      fs.writeFileSync(gateFile('hold_' + users[0]), '1');
      const r = await setStatus(pid, 'available');
      const ok = await waitFile(gateFile('arrived_' + users[0]));
      if (!ok) throw new Error('第一筆未到達模擬 LINE：' + JSON.stringify(await events(pid)));
      return r;
    };
    const release = async (u) => { fs.writeFileSync(gateFile('release_' + u), '1'); };
    lineCtl({ default: '200' });
    const s2pid = (await q("SELECT id FROM products WHERE store_id='store_002' ORDER BY id LIMIT 1"))[0].id;
    const s2Before = await q("SELECT key, value FROM settings WHERE store_id='store_002' AND key LIKE 'restock_auto_notify%' ORDER BY key");
    const s2pBefore = await q('SELECT * FROM products WHERE id=?', [s2pid]);
    await autoOn(true);

    // ═══════════════ 正常批次（沒有變更開關）═══════════════
    await step('G1', 'G', async () => {
      const us = [U(1), U(2), U(3)];
      await part(P.g1, true); for (const u of us) await reg(u, P.g1);
      await setStatus(P.g1, 'available');
      const { bs, timeout } = await settle(P.g1);
      assert(!timeout && bs.length === 1 && bs[0].source === 'auto' && bs[0].status === 'completed' && bs[0].counts.accepted === 3 && us.every((u) => calls(u).length === 1),
        'G1 [API] 沒有變更開關的正常自動批次：3 位全部送完（每人 1 則），批次完成', JSON.stringify({ st: bs[0] && bs[0].status, c: bs[0] && bs[0].counts, n: us.map((u) => calls(u).length) }));
    });

    // ═══════════════ 缺口 A／B：第一筆請求在模擬 LINE 等待回應時變更開關 ═══════════════
    const gated = {};
    const gatedCase = async (key, pid, users, act) => {
      await startGated(pid, users);
      await act();
      await release(users[0]);
      const { bs, timeout } = await settle(pid);
      const b = bs[0] || {};
      gated[key] = { pid, users, batch: b.batch_uuid };
      return { b, timeout, d0: await delOf(b.batch_uuid, users[0]), d1: await delOf(b.batch_uuid, users[1]) };
    };
    await step('A1', 'G', async () => {
      const [u0, u1] = [U(4), U(5)];
      const { b, timeout, d0, d1 } = await gatedCase('a1', P.a1, [u0, u1], () => autoOn(false));
      assert(!timeout && calls(u0).length === 1 && d0.status === 'accepted' && calls(u1).length === 0 && d1.status !== 'accepted' && !d1.notified_at && b.status === 'paused' && b.pause_reason === 'auto_disabled',
        'A1 [API] 第一筆等待 LINE 回應時關閉自動通知：第一筆照實保存為「LINE 已受理」；第二筆未送出、未標示已通知；批次暫停（自動通知已關閉）',
        JSON.stringify({ n: [calls(u0).length, calls(u1).length], d: [d0.status, d1.status], b: [b.status, b.pause_reason] }));
      assert(d1.status === 'pending' && d1.claim == null && d1.exclusion_reason === 'auto_disabled' && Number(d1.attempt_count) === 0 && d1.retry_key,
        'A1b [API] 未送出項目：維持「待發送」、未受理、記錄原因並釋放週期名額（retry key 保留供人工接手），不會永久卡住後續合法通知',
        JSON.stringify({ st: d1.status, claim: d1.claim, why: d1.exclusion_reason }));
      await autoOn(true);
    });
    await step('A2', 'D', async () => {
      const [u0, u1] = [U(6), U(7)];
      const ep0 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data.epoch;
      const { b, timeout, d0, d1 } = await gatedCase('a2', P.a2, [u0, u1], async () => { await autoOn(false); await autoOn(true); });
      const ep1 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data.epoch;
      assert(!timeout && ep1 === ep0 + 1 && calls(u0).length === 1 && d0.status === 'accepted' && calls(u1).length === 0 && d1.status !== 'accepted' && !d1.notified_at && b.status === 'paused',
        'A2 [API] 缺口 A：第一筆等待回應時關閉再開啟自動通知（新 epoch）→ 放行後第二筆不得送出；第一筆照實保存；舊批次不跨越新舊 epoch 繼續',
        JSON.stringify({ epoch: [ep0, ep1], n: [calls(u0).length, calls(u1).length], d: [d0.status, d1.status], b: [b.status, b.pause_reason] }));
      assert(b.pause_reason === 'auto_epoch_stale' && d1.exclusion_reason === 'auto_epoch_stale' && d1.claim == null,
        'A2b [API] 過時批次記錄原因「自動通知曾關閉後重新開啟」、未送出 1 筆（名額已釋放），可由店家明確續送',
        JSON.stringify({ why: b.pause_reason, d1: [d1.status, d1.exclusion_reason, d1.claim], counts: b.counts }));
    });
    await step('B1', 'D', async () => {
      const [u0, u1] = [U(8), U(9)];
      const { b, timeout, d0, d1 } = await gatedCase('b1', P.b1, [u0, u1], () => part(P.b1, false));
      assert(!timeout && calls(u0).length === 1 && d0.status === 'accepted' && calls(u1).length === 0 && d1.status !== 'accepted' && !d1.notified_at && b.status === 'paused' && b.pause_reason === 'auto_product_not_participating',
        'B1 [API] 缺口 B：第一筆等待回應時商品取消參與自動通知 → 第二筆不得送出；第一筆照實保存；批次暫停（商品已退出自動通知）',
        JSON.stringify({ n: [calls(u0).length, calls(u1).length], d: [d0.status, d1.status], b: [b.status, b.pause_reason] }));
    });
    await step('B2', 'D', async () => {
      const [u0, u1] = [U(10), U(11)];
      const v0 = Number((await q('SELECT restock_auto_version AS v FROM products WHERE id=?', [P.b2]).catch(() => [{}]))[0]?.v);
      const { b, timeout, d0, d1 } = await gatedCase('b2', P.b2, [u0, u1], async () => { await part(P.b2, false); await part(P.b2, true); });
      const pr = (await q('SELECT * FROM products WHERE id=?', [P.b2]))[0];
      assert(!timeout && Number(pr.restock_auto_notify) === 1 && calls(u0).length === 1 && d0.status === 'accepted' && calls(u1).length === 0 && d1.status !== 'accepted' && b.status === 'paused' && b.pause_reason === 'auto_product_version_stale',
        'B2 [API] 缺口 B：商品關閉參與後又重新開啟（目前旗標為 1）→ 舊批次不得恢復；第二筆不送出；批次暫停（參與版本已變更）',
        JSON.stringify({ flag: pr.restock_auto_notify, ver: [v0, pr.restock_auto_version], n: [calls(u0).length, calls(u1).length], b: [b.status, b.pause_reason] }));
    });
    await step('V1', 'N', async () => {
      // 相同值重複儲存不製造版本切換
      const e0 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data.epoch;
      const v0 = (await q('SELECT restock_auto_version AS v FROM products WHERE id=?', [P.b2]))[0].v;
      await autoOn(true); await autoOn(true); await part(P.b2, true); await part(P.b2, true);
      const e1 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data.epoch;
      const v1 = (await q('SELECT restock_auto_version AS v FROM products WHERE id=?', [P.b2]))[0].v;
      const evs = (await events(P.b2)).length;
      assert(v0 != null && e1 === e0 && v1 === v0 && evs === 1,
        'V1 [API] 重複儲存相同的自動開關／商品參與：epoch 與參與版本都不變，也不建立新事件', JSON.stringify({ epoch: [e0, e1], ver: [v0, v1], evs }));
    });
    await step('R1', 'D', async () => {
      // 再重啟服務：舊批次不得被自動撿回
      const before = ['a1', 'a2', 'b1', 'b2'].map((k) => calls(gated[k].users[1]).length);
      await restart(); await waitBoot();
      const st = [];
      for (const k of ['a1', 'a2', 'b1', 'b2']) { const bs = await batchesOf(gated[k].pid); st.push([bs[0].status, bs[0].pause_reason]); }
      const after = ['a1', 'a2', 'b1', 'b2'].map((k) => calls(gated[k].users[1]).length);
      assert(before.every((n) => n === 0) && after.every((n) => n === 0) && st.every(([s]) => s === 'paused'),
        'R1 [API] 重新啟動服務後，A1／A2／B1／B2 的舊批次都沒有被自動撿回（第二筆收件人 LINE 0 次、批次維持暫停）', JSON.stringify({ before, after, st }));
    });

    // ═══════════════ 新基線、人工接手、併發與既有防護 ═══════════════
    await step('N1', 'N', async () => {
      // 新基線下之後真正發生的恢復販售仍可正常通知（包含舊批次中未送出的收件人；已受理者不重送）
      const out = [];
      for (const k of ['a2', 'b2']) {
        const { pid, users } = gated[k];
        await setStatus(pid, 'paused'); await setStatus(pid, 'available');
        const { bs, ev } = await settle(pid);
        const nb = bs.find((b) => b.batch_uuid !== gated[k].batch) || {};
        out.push({ k, ev: ev[0] && ev[0].status, nb: [nb.status, nb.counts && nb.counts.accepted], n: users.map((u) => calls(u).length) });
      }
      assert(out.every((o) => o.ev === 'completed' && o.nb[0] === 'completed' && o.nb[1] === 1 && o.n[0] === 1 && o.n[1] === 1),
        'N1 [API] 新基線（重新開啟自動／商品重新加入）後再恢復販售：建立新的自動批次，通知舊批次中未送出的收件人 1 則；已受理者不重送', JSON.stringify(out));
    });
    await step('M1', 'N', async () => {
      // 人工明確接手：店家按「續送未完成項目」→ 沿用原 delivery 與 retry key；已受理者不重送
      const { pid, users, batch } = gated.a1;
      const keyBefore = (await delOf(batch, users[1])).retry_key;
      const n0 = calls(users[0]).length;
      const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${batch}/resume`, {});
      await settle(pid);
      const b = (await batchesOf(pid)).find((x) => x.batch_uuid === batch) || {};
      const d1 = await delOf(batch, users[1]);
      const used = calls(users[1]).map((c) => c.retry_key);
      assert(rs.status === 200 && b.taken_over_by && d1.status === 'accepted' && used.length === 1 && used[0] === keyBefore && calls(users[0]).length === n0 && n0 === 1,
        'M1 [API] 人工接手：店家明確續送過時自動批次 → 記錄接手人；未送出者以原 delivery、原 retry key 送出 1 則；已受理者不重送',
        JSON.stringify({ rs: rs.status, take: b.taken_over_by, d1: d1.status, used: used.length, same: used[0] === keyBefore }));
    });
    await step('M2', 'G', async () => {
      // 手動與自動同時處理同一需求週期：只有一份有效受理
      const us = [U(12), U(13)];
      await startGated(P.m2, us);
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P.m2, fulfillment_mode: 'takeout', supply_date: today() });
      let cf = null; if (pv.json && pv.json.data && pv.json.data.batch_uuid) cf = await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {});
      await release(us[0]); await settle(P.m2);
      const acc = await q("SELECT request_uuid, COUNT(*) AS n FROM restock_notify_deliveries WHERE store_id=? AND product_id=? AND status='accepted' GROUP BY request_uuid", [STORE, P.m2]);
      assert(us.every((u) => calls(u).length === 1) && acc.length === 2 && acc.every((a) => Number(a.n) === 1),
        'M2 [API] 自動批次送出中，店家同時手動預覽／確認同一商品：每個需求週期只有 1 筆有效受理（每人 1 則）',
        JSON.stringify({ manual: pv.json && pv.json.data && pv.json.data.stats && pv.json.data.stats.exclusions, cf: cf && cf.status, n: us.map((u) => calls(u).length), acc }));
    });
    await step('G2', 'G', async () => {
      // 撤回同意、取消需求：既有逐筆送出前防護仍有效
      const us = [U(14), U(15), U(16), U(17)];
      await startGated(P.g2, us);
      await pub('POST', '/api/product-demand/consent/revoke', { member_session: S(us[1]), product_id: P.g2 });
      await pub('POST', '/api/product-demand/cancel', { member_session: S(us[2]), product_id: P.g2 });
      await release(us[0]); const { bs } = await settle(P.g2);
      const ds = await dels(bs[0].batch_uuid);
      const r = (u) => ds.find((d) => d.line_user_id === u) || {};
      assert(calls(us[0]).length === 1 && calls(us[1]).length === 0 && calls(us[2]).length === 0 && calls(us[3]).length === 1 && r(us[1]).status === 'blocked' && r(us[2]).status === 'blocked',
        'G2 [API] 送出中撤回同意、取消需求：發送前擋下並保留原因；其他人照常送出', JSON.stringify(ds.map((d) => [d.status, d.exclusion_reason])));
    });
    await step('G3', 'G', async () => {
      const us = [U(18), U(19)];
      await startGated(P.g3, us);
      await master(false);
      await release(us[0]); const { bs } = await settle(P.g3);
      await master(true);
      assert(calls(us[0]).length === 1 && calls(us[1]).length === 0 && bs[0].status === 'paused' && bs[0].pause_reason === 'send_disabled',
        'G3 [API] 送出中關閉補貨通知總開關：第二筆不送出、批次暫停（總開關關閉）', JSON.stringify({ b: [bs[0].status, bs[0].pause_reason] }));
    });
    await step('G4', 'G', async () => {
      const us = [U(20), U(21)];
      await startGated(P.g4, us);
      await setStatus(P.g4, 'paused');
      await release(us[0]); const { bs } = await settle(P.g4);
      const d1 = await delOf(bs[0].batch_uuid, us[1]);
      assert(calls(us[1]).length === 0 && d1.status === 'blocked' && /product_not_orderable/.test(d1.exclusion_reason),
        'G4 [API] 送出中停售：第二筆發送前擋下（商品不可訂購）', JSON.stringify({ d1: [d1.status, d1.exclusion_reason] }));
    });
    await step('S1', 'N', async () => {
      const s2After = await q("SELECT key, value FROM settings WHERE store_id='store_002' AND key LIKE 'restock_auto_notify%' ORDER BY key");
      const s2pAfter = await q('SELECT * FROM products WHERE id=?', [s2pid]);
      assert(s2Before.length === 3 && JSON.stringify(s2After) === JSON.stringify(s2Before) && JSON.stringify(s2pAfter) === JSON.stringify(s2pBefore) && Number(s2pAfter[0].restock_auto_notify) === 1,
        'S1 [API][DB] 店別隔離：第一店多次關閉／開啟自動通知、商品退出／加入，第二店的自動設定、epoch 與商品參與（含版本）完全不變', JSON.stringify({ s2After, p: [s2pAfter[0].restock_auto_notify, s2pAfter[0].restock_auto_version] }));
    });

    // ═══════════════ 缺口 C：預覽保存後、確認前實際中止（SIGKILL）與恢復 ═══════════════
    const rsCase = async (name, cls, fn) => { if (!want(name)) return; if (!HAS_HOOKS) { na(name, '受測程式沒有 C6.1 測試掛勾（after_preview／after_confirm），無法精確停在該點'); return; } clearGate(); await step(name, cls, fn); clearGate(); };
    const holdAt = async (pid, users, point) => {
      await part(pid, true); for (const u of users) await reg(u, pid);
      fs.writeFileSync(gateFile('hold_' + point), '1');
      await setStatus(pid, 'available');
      if (!await waitFile(gateFile('reached_' + point))) throw new Error('未到達測試掛勾 ' + point);
      return JSON.parse(fs.readFileSync(gateFile('reached_' + point), 'utf8'));
    };
    const killRestart = async (extra) => { const sig = await kill(); fs.unlinkSync(gateFile('hold_after_preview')); await restart(extra); await waitBoot(); return sig; };
    await rsCase('C1', 'D', async () => {
      const us = [U(50), U(51)];
      const at = await holdAt(P.rs1, us, 'after_preview');
      const pre = (await q('SELECT status FROM restock_notify_batches WHERE batch_uuid=?', [at.batch_uuid]))[0];
      const preDel = (await dels(at.batch_uuid)).length;
      const preEv = (await q('SELECT status FROM restock_auto_events WHERE event_uuid=?', [at.event_uuid]))[0];
      const sig = await killRestart();
      const { ev, bs } = await settle(P.rs1);
      const ds = await dels(at.batch_uuid);
      const r1 = { sig, pre: pre.status, preDel, preEv: preEv.status, ev: ev.map((e) => e.status), bs: bs.map((b) => [b.batch_uuid === at.batch_uuid, b.status]), acc: ds.filter((d) => d.status === 'accepted').length, n: us.map((u) => calls(u).length) };
      assert(sig === 'SIGKILL' && pre.status === 'previewed' && preDel === 0 && preEv.status === 'processing' && ev.length === 1 && ev[0].status === 'completed' && bs.length === 1 && bs[0].batch_uuid === at.batch_uuid && bs[0].status === 'completed' && r1.acc === 2 && r1.n.every((n) => n === 1),
        'C1 [RS] 缺口 C：預覽已 durable 保存、確認前實際 SIGKILL → 同一資料庫檔重啟：沿用同一批次確認並送出（2 位各 1 則），不重建批次、事件完成', JSON.stringify(r1));
      await restart(); await waitBoot();
      const bs2 = await batchesOf(P.rs1);
      assert(bs2.length === 1 && us.every((u) => calls(u).length === 1) && (await events(P.rs1))[0].status === 'completed',
        'C1b [RS] 再次重啟：結果維持冪等（批次 1 個、每人 1 則、事件完成）', JSON.stringify({ bs: bs2.length, n: us.map((u) => calls(u).length) }));
    });
    await rsCase('C2', 'N', async () => {
      const us = [U(52), U(53)];
      const at = await holdAt(P.rs2, us, 'after_confirm');
      const pre = (await q('SELECT status FROM restock_notify_batches WHERE batch_uuid=?', [at.batch_uuid]))[0];
      const preDel = await dels(at.batch_uuid);
      const sig = await kill(); fs.unlinkSync(gateFile('hold_after_confirm')); await restart(); await waitBoot();
      const { ev, bs } = await settle(P.rs2);
      const ds = await dels(at.batch_uuid);
      const keysSame = ds.every((d) => preDel.some((p) => p.delivery_uuid === d.delivery_uuid && p.retry_key === d.retry_key));
      assert(sig === 'SIGKILL' && pre.status === 'sending' && preDel.length === 2 && preDel.every((d) => d.status === 'pending') && us.every((u) => calls(u).length === 1) && bs.length === 1 && ds.filter((d) => d.status === 'accepted').length === 2 && keysSame && ev[0].status === 'completed',
        'C2 [RS] 確認後、worker 啟動前 SIGKILL：重啟後沿用原 delivery 與 retry key 續送（每人 1 則），不重新建立收件人', JSON.stringify({ pre: pre.status, preDel: preDel.map((d) => d.status), n: us.map((u) => calls(u).length), ev: ev[0] && ev[0].status }));
    });
    await rsCase('C3', 'N', async () => {
      // 部分收件人已受理後中斷＋供應商已受理但回應遺失（模擬 LINE 已受理第二位、回應未返回時 SIGKILL）
      const us = [U(54), U(55), U(56)];
      await part(P.rs3, true); for (const u of us) await reg(u, P.rs3);
      fs.writeFileSync(gateFile('hold_' + us[1]), '1');
      await setStatus(P.rs3, 'available');
      if (!await waitFile(gateFile('arrived_' + us[1]))) throw new Error('第二位未到達模擬 LINE');
      const bu = (await batchesOf(P.rs3))[0].batch_uuid;
      const keyLost = (await delOf(bu, us[1])).retry_key;
      const sig = await kill(); await restart(); await waitBoot();
      await settle(P.rs3);
      const d = await Promise.all(us.map((u) => delOf(bu, u)));
      const k = acceptedKeys();
      assert(sig === 'SIGKILL' && us.map((u) => calls(u).length).join() === '1,1,1' && d[0].status === 'accepted' && d[1].status === 'unknown' && d[1].retry_key === keyLost && k.includes(keyLost) && d[2].status === 'accepted',
        'C3 [RS] 部分已受理後中斷、第二位「LINE 已受理但回應遺失」：重啟後已受理者保留、結果不明者不換 key 重送（HTTP 1 次）、未送出者沿用原 key 送出',
        JSON.stringify({ n: us.map((u) => calls(u).length), st: d.map((x) => x.status), sameKey: d[1].retry_key === keyLost }));
      await restart(); await waitBoot();
      assert(us.map((u) => calls(u).length).join() === '1,1,1', 'C3b [RS] 再次重啟：沒有任何重送', JSON.stringify(us.map((u) => calls(u).length)));
    });
    await rsCase('C4', 'N', async () => {
      const us = [U(57)];
      const at = await holdAt(P.rs4, us, 'after_preview');
      await part(P.rs4, false);
      const sig = await killRestart();
      const { ev, bs } = await settle(P.rs4);
      assert(sig === 'SIGKILL' && calls(us[0]).length === 0 && bs.length === 1 && bs[0].batch_uuid === at.batch_uuid && bs[0].status === 'expired' && bs[0].pause_reason === 'auto_product_not_participating' && ev[0].status === 'skipped',
        'C4 [RS] 預覽保存後商品退出自動通知，再 SIGKILL 重啟：該預覽安全停止並記錄原因，LINE 0 次，不重建', JSON.stringify({ b: bs.map((b) => [b.status, b.pause_reason]), ev: ev.map((e) => [e.status, e.reason]) }));
    });
    await rsCase('C4b', 'N', async () => {
      const us = [U(58)];
      const at = await holdAt(P.rs4b, us, 'after_preview');
      await autoOn(false);
      const sig = await killRestart();
      const { ev, bs } = await settle(P.rs4b);
      await autoOn(true);
      assert(sig === 'SIGKILL' && calls(us[0]).length === 0 && bs.length === 1 && bs[0].batch_uuid === at.batch_uuid && bs[0].status === 'expired' && bs[0].pause_reason === 'auto_disabled' && ev[0].status === 'skipped' && ev[0].reason === 'auto_disabled',
        'C4b [RS] 預覽保存後關閉自動通知，再 SIGKILL 重啟：預覽停止（自動通知已關閉），事件未發送，LINE 0 次', JSON.stringify({ b: bs.map((b) => [b.status, b.pause_reason]), ev: ev.map((e) => [e.status, e.reason]) }));
    });

    // ═══════════════ 缺口 C：持久狀態 fixture（C6 與 C6.1 同一狀態）═══════════════
    await step('FX2', 'D', async () => {
      // 狀態：自動事件尚待完成處理（processing）＋對應自動批次 previewed＋沒有逐筆 delivery（C6.1 的版本欄位在存在時填入目前值）
      const u = U(62);
      await part(P.fx2, true); await setStatus(P.fx2, 'available'); await settle(P.fx2); // 先可售（此時還沒有登記 → 不發送）
      await reg(u, P.fx2);
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P.fx2, fulfillment_mode: 'takeout', supply_date: today() });
      const bu = pv.json.data.batch_uuid;
      const eu = '00000000-0000-4000-8000-0000000ff002';
      const bc = await cols('restock_notify_batches'); const ec = await cols('restock_auto_events');
      await editDb((db) => {
        const ep = Number((H.q(db, "SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE])[0] || {}).value || 0);
        const pr = H.q(db, 'SELECT * FROM products WHERE id=?', [P.fx2])[0];
        const modes = JSON.stringify([{ mode: 'takeout', date: today(), notice_kind: 'restock', before: null }]);
        const ecols = ['event_uuid', 'store_id', 'product_id', 'product_name', 'trigger_source', 'modes_json', 'status', 'epoch', 'created_at'];
        const evals = [eu, STORE, P.fx2, 'C61商品fx2', 'line_status', modes, 'processing', ep, new Date(Date.now()).toISOString().slice(0, 19).replace('T', ' ')];
        if (ec.includes('product_auto_version')) { ecols.push('product_auto_version'); evals.push(Number(pr.restock_auto_version)); }
        db.run(`INSERT INTO restock_auto_events (${ecols.join(',')}) VALUES (${ecols.map(() => '?').join(',')})`, evals);
        db.run("UPDATE restock_notify_batches SET source='auto', auto_event_uuid=?, created_by=? WHERE batch_uuid=?", [eu, 'auto:' + eu, bu]);
        if (bc.includes('auto_epoch')) db.run('UPDATE restock_notify_batches SET auto_epoch=?, auto_product_version=? WHERE batch_uuid=?', [ep, Number(pr.restock_auto_version), bu]);
      });
      const { ev, bs } = await settle(P.fx2);
      const e = ev.find((x) => x.event_uuid === eu) || {};
      const b = bs.find((x) => x.batch_uuid === bu) || {};
      assert(calls(u).length === 1 && b.status === 'completed' && b.counts && b.counts.accepted === 1 && bs.length === 1 && e.status === 'completed',
        'FX2 [FX] 缺口 C 持久狀態（事件待處理＋自動批次 previewed＋無 delivery）重啟：沿用同一批次確認並送出 1 則；事件完成狀態與實際結果一致',
        JSON.stringify({ n: calls(u).length, b: [b.status, b.counts && b.counts.accepted], bs: bs.length, e: [e.status, e.reason] }));
    });
    await step('FX1', 'D', async () => {
      // 舊 C6 已可能留下：event=completed＋自動 batch=previewed＋沒有 delivery（版本欄位為空）
      const u = U(61);
      await part(P.fx1, true); await setStatus(P.fx1, 'available'); await settle(P.fx1);
      await reg(u, P.fx1);
      const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: P.fx1, fulfillment_mode: 'takeout', supply_date: today() });
      const bu = pv.json.data.batch_uuid;
      const eu = '00000000-0000-4000-8000-0000000ff001';
      await editDb((db) => {
        const ep = Number((H.q(db, "SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE])[0] || {}).value || 0);
        const modes = JSON.stringify([{ mode: 'takeout', date: today(), notice_kind: 'restock', before: null }]);
        const det = JSON.stringify([{ mode: 'takeout', date: today(), result: 'existing_batch', batch_uuid: bu }]);
        db.run(`INSERT INTO restock_auto_events (event_uuid, store_id, product_id, product_name, trigger_source, modes_json, status, epoch, detail_json, batch_uuids, completed_at)
                VALUES (?,?,?,?,?,?,'completed',?,?,?,datetime('now'))`, [eu, STORE, P.fx1, 'C61商品fx1', 'line_status', modes, ep, det, JSON.stringify([bu])]);
        db.run("UPDATE restock_notify_batches SET source='auto', auto_event_uuid=?, created_by=? WHERE batch_uuid=?", [eu, 'auto:' + eu, bu]);
      });
      const { ev, bs } = await settle(P.fx1);
      const e = ev.find((x) => x.event_uuid === eu) || {};
      const b = bs.find((x) => x.batch_uuid === bu) || {};
      assert(calls(u).length === 0 && bs.length === 1 && b.status === 'expired' && b.pause_reason === 'legacy_unverified' && e.status === 'needs_review',
        'FX1 [FX] 舊 C6 留下「事件已完成＋自動預覽未確認＋無 delivery」：無法證明版本 → 不套用目前版本自動發送；預覽停止並記錄原因、事件標為待店家確認（不再顯示為已完成）',
        JSON.stringify({ n: calls(u).length, b: [b.status, b.pause_reason], e: [e.status, e.reason] }));
    });

    // ═══════════════ 測試掛勾預設不啟用 ═══════════════
    await step('H1', 'N', async () => {
      clearGate();
      const u = U(63);
      await restart({ RESTOCK_AUTO_TEST_HOOKS: '' }); await waitBoot();
      fs.writeFileSync(gateFile('hold_after_preview'), '1');
      await part(P.h1, true); await reg(u, P.h1);
      await setStatus(P.h1, 'available'); const { bs } = await settle(P.h1);
      const reached = fs.existsSync(gateFile('reached_after_preview'));
      const fn = execFileSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(path.join(H.ROOT, 'utils', 'restockAuto.js'))}).testHooksEnabled ? require(${JSON.stringify(path.join(H.ROOT, 'utils', 'restockAuto.js'))}).testHooksEnabled() : 'none'))`],
        { env: { ...process.env, NODE_ENV: 'production', RESTOCK_AUTO_TEST_HOOKS: '1', RESTOCK_AUTO_TEST_GATE_DIR: GATE } }).toString();
      const envEx = fs.readFileSync(path.join(H.ROOT, '.env.example'), 'utf8');
      clearGate(); await restart(); await waitBoot();
      assert(!reached && calls(u).length === 1 && bs[0] && bs[0].status === 'completed' && fn === 'false' && !/RESTOCK_AUTO_TEST_HOOKS\s*=\s*1/.test(envEx),
        'H1 [API][FN] 測試掛勾預設不啟用：未設定 RESTOCK_AUTO_TEST_HOOKS 時即使存在停點檔也不停；NODE_ENV=production 時函式判定為停用；.env.example 未開啟',
        JSON.stringify({ reached, n: calls(u).length, fn }));
    });

    // ═══════════════ 會改變時鐘／LIFF 的 [RS] 案例放最後 ═══════════════
    await rsCase('C5', 'N', async () => {
      const us = [U(59)];
      const at = await holdAt(P.rs5, us, 'after_preview');
      OFF = String(Number(OFF) + 31 * 60e3); // 重啟後時間前進 31 分鐘（預覽有效 30 分鐘）
      const sig = await killRestart();
      const { ev, bs } = await settle(P.rs5);
      assert(sig === 'SIGKILL' && calls(us[0]).length === 0 && bs.length === 1 && bs[0].batch_uuid === at.batch_uuid && bs[0].status === 'expired' && bs[0].pause_reason === 'preview_expired' && ev[0].status === 'skipped' && ev[0].reason === 'preview_expired',
        'C5 [RS] 預覽保存後 SIGKILL，重啟時預覽已過期：安全停止並記錄「預覽已逾時」，不悄悄重建新預覽追發（批次 1 個、LINE 0 次）', JSON.stringify({ b: bs.map((b) => [b.status, b.pause_reason]), ev: ev.map((e) => [e.status, e.reason]) }));
    });
    await rsCase('C6', 'N', async () => {
      const us = [U(60)];
      const at = await holdAt(P.rs6, us, 'after_preview');
      const sig = await kill(); fs.unlinkSync(gateFile('hold_after_preview'));
      { const db = await H.openDbFile(C.dbf); db.run("UPDATE settings SET value='2000000000-ChangedLiffC61' WHERE store_id=? AND key='line_member_liff_id'", [STORE]); H.saveDbFile(db, C.dbf); db.close(); }
      await restart(); await waitBoot();
      const { ev, bs } = await settle(P.rs6);
      assert(sig === 'SIGKILL' && calls(us[0]).length === 0 && bs.length === 1 && bs[0].batch_uuid === at.batch_uuid && bs[0].status === 'expired' && bs[0].pause_reason === 'link_mismatch' && ev[0].status === 'skipped',
        'C6 [RS] 預覽保存後 SIGKILL，重啟前 LIFF 設定改變（內容／連結不再匹配）：預覽作廢並記錄原因，LINE 0 次，不重建', JSON.stringify({ b: bs.map((b) => [b.status, b.pause_reason]), ev: ev.map((e) => [e.status, e.reason]) }));
    });

    assert(C.mf.real() === 0, 'Z 真實 LINE Messaging API 呼叫 0 次（全部在測試程序內攔截）', JSON.stringify({ real: C.mf.real(), mock_http_calls: C.mf.calls().length, unique_accepted_keys: acceptedKeys().length }));
  } catch (e) { assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1200)); }
  finally { try { if (C) await C.s.stop(); } catch {} }
  const sum = H.summary();
  const stats = C ? { mock_http_calls: C.mf.calls().length, unique_accepted_keys: Object.keys(JSON.parse(fs.readFileSync(C.mf.state, 'utf8')).accepted || {}).length, retry_keys_seen: new Set(C.mf.calls().map((c) => c.retry_key)).size } : {};
  if (process.env.C61_RESULT_JSON) fs.writeFileSync(process.env.C61_RESULT_JSON, JSON.stringify({ suite: 'c6-1-auto-guard-recovery', root: H.ROOT, hooks: HAS_HOOKS, pass: sum.passCount, fail: sum.failCount, not_applicable: NA, meta: META, mock: stats, cases: sum.results }, null, 1));
  console.log(`\n模擬 LINE：HTTP 呼叫 ${stats.mock_http_calls}、使用的 retry key ${stats.retry_keys_seen}、唯一受理 ${stats.unique_accepted_keys}`);
  console.log(`結果：${sum.passCount} 通過／${sum.failCount} 失敗${NA.length ? `／${NA.length} 不適用` : ''}`);
  process.exit(sum.failCount ? 1 : 0);
})();
