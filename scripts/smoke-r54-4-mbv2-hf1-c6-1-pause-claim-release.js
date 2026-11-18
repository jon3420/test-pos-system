#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js
// R54.4／MBV2-HF1-C6.1 補修 —— 暫停分支的過期通知名額釋放
//
// 缺口：自動批次第一筆（A）已交給 LINE、回應未返回時，版本改變（全店關閉再開啟／商品退出再加入），
//       接著批次又因其他原因暫停（總開關關閉／授權錯誤／額度不足）→ 第二筆（B）從未送出卻仍占週期名額（claim=1），
//       之後新的合法恢復販售事件把 B 排除為 in_other_batch。
//
// 同一份腳本、同一組斷言分別跑「未修改 C6.1」與補修版（H.ROOT＝腳本所在的應用程式根目錄）。
// 測試層級（案例名稱標示）：
//   [API] 正式路由＋正式事件建立與 worker 流程＋檔案型暫存 SQLite（node server.js 子程序）
//   [RS]  真實 SIGKILL 測試服務子程序後，以同一資料庫檔重新啟動
//   [FX]  停機後直接修改資料庫檔建立指定持久狀態（fixture），再啟動
// 時序：c4-line-mock（依收件人回應序列，記錄 HTTP 呼叫／retry key／已受理 key）＋c61-line-gate（A 的請求先交給模擬 LINE
//       產生結果，再暫停回應直到測試放行）。等待一律以檔案或 API 明確狀態為準，不用固定 sleep 製造競態。
// 真實 LINE 呼叫必須為 0（Z）。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const ONLY = (process.env.C61P_ONLY || '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const META = {};
async function step(name, cls, fn) { if (!want(name)) return; META[name] = { cls }; try { await fn(); } catch (e) { assert(false, name + '（例外）', String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); } }
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const P = { i1: 971, i2: 972, i3: 973, i4: 974, i5: 975, i6: 976, i7: 977, o1: 978, o2: 979, o3: 980, o4: 981, o6: 982, m1: 983, d2: 984 };
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], ...Object.entries(P).map(([k, id], i) => [id, 'C61P商品' + k, i + 1, 'paused', { quota: 50, price: 100 }])];

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 補修：暫停分支的過期通知名額釋放 驗收 ══════════');
  console.log('受測程式：' + H.ROOT);
  const GATE = H.tmpDir('c61p-gate');
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = (extra = {}) => ({ __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c61-line-gate.js')],
    C4_CLOCK_OFFSET_MS: String(OFF), RESTOCK_NOTIFY_BACKOFF_MS: '300,600,900', RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '30000', C61_LINE_GATE_DIR: GATE, ...extra });
  let C = null;
  try {
    C = await C45.boot('c61p', { products: PRODUCTS, members: 80, settings: { restock_notify_enabled: '1' }, env: env() });
    const restart = async () => { await C.restart(env()); C.tok = await H.login(C.s.base, STORE, 'pw001'); await waitBoot(); };
    const kill = async () => { const p = C.s.proc; await new Promise((res) => { if (p.exitCode != null || p.signalCode != null) return res(); p.once('exit', res); p.kill('SIGKILL'); }); return p.signalCode; };
    const adm = (m, p, b) => H.api(C.s.base, C.tok, m, p, b);
    const pub = (m, p, b) => C45.pub(C.s.base, m, p, b);
    const S = (u) => sessAt(u, OFF);
    const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
    const q = async (sql, params) => { const db = await H.openDbFile(C.dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
    const ctrl = { default: '200', byUser: {} };
    const lineCtl = () => fs.writeFileSync(C.mf.ctrl, JSON.stringify(ctrl));
    const calls = (u) => C.mf.calls().filter((c) => c.uid === u);
    const acceptedFor = (u) => new Set(calls(u).filter((c) => c.result === 200 || c.result === 409).map((c) => c.retry_key)).size;
    const reg = async (u, pid) => {
      const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: 'takeout', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
      if (!r.json || !r.json.success) throw new Error('register ' + r.text.slice(0, 200));
    };
    const setStatus = (pid, st) => adm('PATCH', `/api/products/${pid}/line-status`, { sale_status: st });
    const autoOn = (on = true) => adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: on });
    const part = (pid, on = true) => adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: on });
    const master = (on) => adm('PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: on });
    const events = async (pid) => ((await adm('GET', `/api/product-demand-admin/restock/auto/events?product_id=${pid}`)).json || {}).data || [];
    const batchesOf = async (pid) => ((await adm('GET', `/api/product-demand-admin/restock/batches?product_id=${pid}`)).json || {}).data || [];
    const settle = async (pid, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        const ev = await events(pid); const bs = await batchesOf(pid);
        if (!(ev.some((e) => ['queued', 'processing'].includes(e.status)) || bs.some((b) => b.status === 'sending' || b.running))) return { ev, bs };
        if (Date.now() - t0 > ms) return { ev, bs, timeout: true };
        await sleep(50);
      }
    };
    const waitFile = async (f, ms = 20000) => { const t0 = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
    const gf = (n) => path.join(GATE, n);
    async function waitBoot() {
      const t0 = Date.now();
      while (!/\[restock_auto\] boot recovery done/.test(C.s.getLog())) { if (Date.now() - t0 > 8000) break; await sleep(30); }
      for (const pid of Object.values(P)) await settle(pid, 5000);
    }
    const del = async (bu, u) => (await q('SELECT d.*, r.notified_at FROM restock_notify_deliveries d LEFT JOIN product_demand_requests r ON r.request_uuid=d.request_uuid WHERE d.batch_uuid=? AND d.line_user_id=?', [bu, u]))[0] || {};
    const batchRow = async (bu) => (await q('SELECT * FROM restock_notify_batches WHERE batch_uuid=?', [bu]))[0] || {};
    // A 的請求已交給模擬 LINE（依 A 的回應序列產生結果），回應暫停；回傳批次與 B 的 retry key
    const startGated = async (pid, users, opts = {}) => {
      if (!opts.manual) await part(pid, true);
      for (const u of users) await reg(u, pid);
      fs.writeFileSync(gf('hold_' + users[0]), '1');
      let bu;
      if (opts.manual) {
        await setStatus(pid, 'available');
        const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: pid, fulfillment_mode: 'takeout', supply_date: today });
        bu = pv.json.data.batch_uuid;
        await adm('POST', `/api/product-demand-admin/restock/batches/${bu}/confirm`, {});
      } else await setStatus(pid, 'available');
      if (!await waitFile(gf('arrived_' + users[0]))) throw new Error('A 未到達模擬 LINE');
      if (!bu) bu = (await batchesOf(pid))[0].batch_uuid;
      const keys = {}; for (const u of users) keys[u] = (await del(bu, u)).retry_key;
      return { bu, keys };
    };
    const release = (u) => fs.writeFileSync(gf('release_' + u), '1');
    const newLegalEvent = async (pid) => { await setStatus(pid, 'paused'); await setStatus(pid, 'available'); return settle(pid); };
    lineCtl();
    await autoOn(true);

    // ═══════════════ A：交錯情境（版本改變＋其他暫停原因）═══════════════
    const TOG = {
      epoch: { label: '全店關閉再開啟', act: async () => { await autoOn(false); await autoOn(true); }, why: 'auto_epoch_stale' },
      prod: { label: '商品退出再加入', act: async (pid) => { await part(pid, false); await part(pid, true); }, why: 'auto_product_version_stale' },
    };
    const STOP = {
      master: { label: '總開關關閉', seqA: ['200'], act: () => master(false), undo: () => master(true), pause: 'send_disabled', aStatus: 'accepted', aHttp: 200 },
      auth: { label: '授權錯誤', seqA: ['401', '200'], act: async () => {}, undo: async () => {}, pause: 'auth_error', aStatus: 'held', aHttp: 401 },
      quota: { label: '額度不足', seqA: ['429_quota', '200'], act: async () => {}, undo: async () => {}, pause: 'monthly_limit', aStatus: 'held', aHttp: 429 },
    };
    const kept = {};
    const interleave = async (name, pid, tog, stop, ua, ub) => {
      ctrl.byUser[ua] = STOP[stop].seqA; lineCtl();
      const { bu, keys } = await startGated(pid, [ua, ub]);
      await TOG[tog].act(pid);
      await STOP[stop].act();
      release(ua);
      const { bs } = await settle(pid);
      const b = (bs.find((x) => x.batch_uuid === bu)) || {};
      const br = await batchRow(bu);
      const a = await del(bu, ua), bb = await del(bu, ub);
      kept[name] = { pid, bu, ua, ub, keys };
      const r1 = { pause: [b.status, br.pause_reason], A: [a.status, a.last_http_status, a.error_code, a.attempt_count, a.claim], B: [bb.status, bb.attempt_count, bb.claim, bb.exclusion_reason, !!bb.notified_at], httpB: calls(ub).length, sameKey: bb.retry_key === keys[ub] };
      assert(b.status === 'paused' && a.status === STOP[stop].aStatus && Number(a.last_http_status) === STOP[stop].aHttp && Number(a.attempt_count) === 1 && Number(a.claim) === 1 && a.retry_key === keys[ua]
        && calls(ub).length === 0 && bb.status === 'pending' && Number(bb.attempt_count) === 0 && !bb.notified_at && bb.retry_key === keys[ub]
        && bb.claim == null && bb.exclusion_reason === TOG[tog].why,
        `${name} [API] ${TOG[tog].label}＋${STOP[stop].label}：A 結果照實保存（${STOP[stop].aStatus}／HTTP ${STOP[stop].aHttp}，名額與 key 保留）；B HTTP 0、未標示已通知、retry key 不變；B 過期且從未送出的名額已釋放並記錄「${TOG[tog].why}」`,
        JSON.stringify(r1));
      assert(br.pause_reason === STOP[stop].pause,
        `${name}b [API] 批次保留原暫停原因「${STOP[stop].pause}」可追查（版本失效原因記在 B 的逐筆紀錄）`, JSON.stringify({ pause: br.pause_reason, B_reason: bb.exclusion_reason }));
      // 恢復必要設定，再以正式商品操作產生新的合法恢復販售事件
      await STOP[stop].undo();
      const { ev, bs: bs2 } = await newLegalEvent(pid);
      const nb = bs2.find((x) => x.batch_uuid !== bu) || {};
      const e2 = ev[0] || {}; // 最新的事件（清單依建立順序由新到舊）
      const nbB = nb.batch_uuid ? await del(nb.batch_uuid, ub) : {};
      const r2 = { ev: ev.map((e) => [e.status, e.reason]), nb: [nb.status, nb.counts && nb.counts.accepted], nbB: nbB.status, httpB: calls(ub).length, accA: acceptedFor(ua), accB: acceptedFor(ub) };
      assert(ev.length === 2 && e2.status === 'completed' && nbB.status === 'accepted' && calls(ub).length === 1 && acceptedFor(ub) === 1 && acceptedFor(ua) <= 1,
        `${name}c [API] 恢復設定後新的合法恢復販售事件：通知 B 1 則（不再因舊名額 in_other_batch 被跳過）；A 不重複受理`, JSON.stringify(r2));
    };
    await step('I1', 'D', () => interleave('I1', P.i1, 'epoch', 'master', U(1), U(2)));
    await step('I2', 'D', () => interleave('I2', P.i2, 'epoch', 'auth', U(3), U(4)));
    await step('I3', 'D', () => interleave('I3', P.i3, 'epoch', 'quota', U(5), U(6)));
    await step('I4', 'D', () => interleave('I4', P.i4, 'prod', 'master', U(7), U(8)));
    await step('I5', 'D', () => interleave('I5', P.i5, 'prod', 'auth', U(9), U(10)));
    await step('I6', 'D', () => interleave('I6', P.i6, 'prod', 'quota', U(11), U(12)));

    // ═══════════════ B：防止過度清理 ═══════════════
    await step('O1', 'G', async () => {
      // 版本未改變，只有總開關關閉 → 合法批次保留名額與續送能力
      const [ua, ub] = [U(20), U(21)];
      ctrl.byUser[ua] = ['200']; lineCtl();
      const { bu, keys } = await startGated(P.o1, [ua, ub]);
      await master(false); release(ua); await settle(P.o1);
      const br = await batchRow(bu); const bb = await del(bu, ub);
      await master(true);
      const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${bu}/resume`, {}); await settle(P.o1);
      const bb2 = await del(bu, ub);
      assert(br.pause_reason === 'send_disabled' && Number(bb.claim) === 1 && !bb.exclusion_reason && rs.status === 200 && bb2.status === 'accepted' && calls(ub).map((c) => c.retry_key).join() === keys[ub],
        'O1 [API] 版本未改變、只有總開關關閉：B 名額保留（claim=1、無失效原因）；恢復後續送以原 key 送出 1 則', JSON.stringify({ pause: br.pause_reason, B: [bb.status, bb.claim, bb.exclusion_reason], rs: rs.status, B2: bb2.status }));
    });
    await step('O2', 'G', async () => {
      const [ua, ub] = [U(22), U(23)];
      ctrl.byUser[ua] = ['401', '200']; lineCtl();
      const { bu } = await startGated(P.o2, [ua, ub]);
      release(ua); await settle(P.o2);
      const br = await batchRow(bu); const bb = await del(bu, ub);
      assert(br.pause_reason === 'auth_error' && Number(bb.claim) === 1 && !bb.exclusion_reason && calls(ub).length === 0,
        'O2 [API] 版本未改變、只有授權錯誤：批次暫停 auth_error，B 名額保留（不釋放）', JSON.stringify({ pause: br.pause_reason, B: [bb.status, bb.claim, bb.exclusion_reason] }));
    });
    await step('O3', 'G', async () => {
      // 手動批次＋商品退出再加入＋授權錯誤 → 手動批次不受自動參與設定影響
      const [ua, ub] = [U(24), U(25)];
      ctrl.byUser[ua] = ['401', '200']; lineCtl();
      const { bu } = await startGated(P.o3, [ua, ub], { manual: true });
      await part(P.o3, true); await part(P.o3, false); await part(P.o3, true);
      release(ua); await settle(P.o3);
      const br = await batchRow(bu); const bb = await del(bu, ub);
      assert(br.source === 'manual' && br.pause_reason === 'auth_error' && Number(bb.claim) === 1 && !bb.exclusion_reason,
        'O3 [API] 手動批次：商品參與切換＋授權錯誤時名額保留、不記錄自動版本原因', JSON.stringify({ src: br.source, pause: br.pause_reason, B: [bb.status, bb.claim, bb.exclusion_reason] }));
    });
    await step('O4', 'G', async () => {
      // 已人工接手的自動批次：接手後再遇到版本改變＋授權錯誤，保留原行為（名額不釋放）
      const [ua, ub, uc] = [U(26), U(27), U(28)];
      ctrl.byUser[ua] = ['200']; ctrl.byUser[ub] = ['401', '200']; lineCtl();
      const { bu } = await startGated(P.o4, [ua, ub, uc]);
      await autoOn(false); await autoOn(true); release(ua); await settle(P.o4);
      fs.writeFileSync(gf('hold_' + ub), '1');
      const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${bu}/resume`, {});
      if (!await waitFile(gf('arrived_' + ub))) throw new Error('B 未到達');
      await autoOn(false); await autoOn(true);
      release(ub); await settle(P.o4);
      const br = await batchRow(bu); const cc = await del(bu, uc);
      assert(rs.status === 200 && br.taken_over_by && br.pause_reason === 'auth_error' && Number(cc.claim) === 1 && !cc.exclusion_reason && calls(uc).length === 0,
        'O4 [API] 已人工接手的自動批次：再遇版本改變＋授權錯誤 → 維持接手規則（C 名額保留、可再續送）', JSON.stringify({ take: br.taken_over_by, pause: br.pause_reason, C: [cc.status, cc.claim, cc.exclusion_reason] }));
    });
    await step('O5', 'G', async () => {
      // 已嘗試／結果不明／已受理項目：名額與 retry key 保持
      const rows = [];
      for (const k of ['I1', 'I2', 'I3']) { const x = kept[k]; if (!x) continue; const a = await del(x.bu, x.ua); rows.push([k, a.status, a.attempt_count, a.claim, a.retry_key === x.keys[x.ua]]); }
      // 結果不明：A 回應 5xx（等待重試，attempt=1）時全店關閉再開啟
      const [ua, ub] = [U(30), U(31)];
      ctrl.byUser[ua] = ['500']; lineCtl(); // 5xx：已交給 LINE、結果不明 → 等待重試
      const { bu, keys } = await startGated(P.o6, [ua, ub]);
      await autoOn(false); await autoOn(true); release(ua); await settle(P.o6);
      const a = await del(bu, ua); const bb = await del(bu, ub);
      rows.push(['O5u', a.status, a.attempt_count, a.claim, a.retry_key === keys[ua]]);
      assert(rows.length === 4 && rows.every((r) => Number(r[2]) >= 1 && Number(r[3]) === 1 && r[4]) && ['retry_wait', 'unknown'].includes(a.status) && bb.claim == null && calls(ub).length === 0,
        'O5 [API] 已受理（I1）、已嘗試未受理（I2 授權／I3 額度）、結果不明（5xx 等待重試）項目：名額（claim=1）、嘗試次數與 retry key 全部保留；只有從未送出的 B 釋放', JSON.stringify({ rows, B: [bb.status, bb.claim] }));
    });
    await step('O6', 'G', async () => {
      const us = [U(32), U(33), U(34)];
      const pid = P.d2; await part(pid, true); for (const u of us) await reg(u, pid);
      await setStatus(pid, 'available'); const { bs } = await settle(pid);
      assert(bs.length === 1 && bs[0].status === 'completed' && bs[0].counts.accepted === 3 && us.every((u) => calls(u).length === 1),
        'O6 [API] 正常自動批次（沒有切換或暫停）全部送完', JSON.stringify({ st: bs[0] && bs[0].status, c: bs[0] && bs[0].counts }));
    });

    // ═══════════════ C：人工接手與防重 ═══════════════
    await step('M1', 'D', async () => {
      // 交錯清理後，店家明確續送舊批次：沿用原 delivery／原 retry key，重新取得名額
      const [ua, ub] = [U(40), U(41)];
      ctrl.byUser[ua] = ['401', '200']; lineCtl();
      const { bu, keys } = await startGated(P.m1, [ua, ub]);
      await autoOn(false); await autoOn(true); release(ua); await settle(P.m1);
      const before = await del(bu, ub);
      const rs = await adm('POST', `/api/product-demand-admin/restock/batches/${bu}/resume`, {}); await settle(P.m1);
      const after = await del(bu, ub); const a = await del(bu, ua);
      assert(before.claim == null && rs.status === 200 && after.delivery_uuid === before.delivery_uuid && after.status === 'accepted' && Number(after.claim) === 1
        && calls(ub).map((c) => c.retry_key).join() === keys[ub] && a.status === 'accepted' && new Set(calls(ua).map((c) => c.retry_key)).size === 1,
        'M1 [API] 清理後店家明確續送：B 以原 delivery、原 retry key 送出 1 則並重新取得名額；A 以同一 key 重試受理', JSON.stringify({ before: [before.status, before.claim], rs: rs.status, after: [after.status, after.claim], keysA: new Set(calls(ua).map((c) => c.retry_key)).size }));
    });
    await step('M2', 'G', async () => {
      // 新合法批次已通知 B 之後，接手舊批次不得再送；重複續送也不產生第二筆
      const x = kept.I2; if (!x) throw new Error('需要 I2');
      const n0 = calls(x.ub).length;
      const r1 = await adm('POST', `/api/product-demand-admin/restock/batches/${x.bu}/resume`, {}); await settle(x.pid);
      const r2 = await adm('POST', `/api/product-demand-admin/restock/batches/${x.bu}/resume`, {}); await settle(x.pid);
      const b = await del(x.bu, x.ub);
      assert(calls(x.ub).length === n0 && acceptedFor(x.ub) === 1 && b.status !== 'accepted',
        'M2 [API] 新批次已通知 B 後接手舊批次（兩次續送）：B 不再送出（HTTP 次數不變、唯一受理 1）', JSON.stringify({ r: [r1.status, r2.status], http: [n0, calls(x.ub).length], B: [b.status, b.exclusion_reason] }));
    });

    // ═══════════════ D：重啟與既有資料 ═══════════════
    await step('D1', 'G', async () => {
      // 真實 SIGKILL 後以同一資料庫檔重啟：版本與名額一致、沒有重複發送、不補發 skipped 事件
      const snap = async () => ({ ver: await q('SELECT id, restock_auto_notify, restock_auto_version FROM products WHERE id IN (971,972,973,974,975,976) ORDER BY id'),
        ep: (await q("SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE]))[0].value,
        claims: await q("SELECT delivery_uuid, status, claim, exclusion_reason, retry_key, attempt_count FROM restock_notify_deliveries WHERE product_id BETWEEN 971 AND 976 ORDER BY id") });
      const s0 = await snap(); const http0 = C.mf.calls().length;
      const sig = await kill(); await restart();
      const s1 = await snap();
      // 名額、retry key、嘗試次數必須完全一致；狀態只允許既有 C4.1 開機防重規則把「本週期已由其他批次通知」的未送出列改為 blocked／already_notified
      const bad = s0.claims.map((r, i) => {
        const n = s1.claims[i] || {};
        const same = n.delivery_uuid === r.delivery_uuid && String(n.claim) === String(r.claim) && n.retry_key === r.retry_key && Number(n.attempt_count) === Number(r.attempt_count);
        const st = (n.status === r.status && n.exclusion_reason === r.exclusion_reason) || (r.status === 'pending' && Number(r.attempt_count) === 0 && n.status === 'blocked' && n.exclusion_reason === 'already_notified');
        return same && st ? null : [r, n];
      }).filter(Boolean);
      const moved = s0.claims.filter((r, i) => r.status !== (s1.claims[i] || {}).status).length;
      assert(sig === 'SIGKILL' && JSON.stringify(s0.ver) === JSON.stringify(s1.ver) && s0.ep === s1.ep && s0.claims.length === s1.claims.length && !bad.length && C.mf.calls().length === http0,
        'D1 [RS] 實際 SIGKILL 後同一資料庫檔重啟：epoch、商品參與版本、逐筆名額／retry key／嘗試次數一致，沒有任何新發送（狀態只依既有開機防重規則把已由新批次通知者改為 already_notified）',
        JSON.stringify({ sig, http: [http0, C.mf.calls().length], moved_to_already_notified: moved, bad: bad.slice(0, 3), ep: [s0.ep, s1.ep] }));
    });
    await step('D2', 'D', async () => {
      // 基準可能留下：過期的暫停批次（auth_error）＋從未送出但仍占名額（claim=1）＋因此被跳過的新事件（skipped）
      const x = kept.I5; if (!x) throw new Error('需要 I5');
      const [uc] = [U(50)];
      await setStatus(P.i5, 'paused'); // 補貨登記只在不可訂購時開放；改為暫停不觸發自動通知
      await reg(uc, P.i5);
      const ep0 = await events(P.i5);
      let fxEvent = '00000000-0000-4000-8000-0000000d2001';
      await C.s.stop();
      { const db = await H.openDbFile(C.dbf);
        // 舊批次：版本已過期（商品版本已在 I5 改變），把一位未送出者還原成「仍占名額、未記錄原因」，暫停原因為授權錯誤
        const tmpBatch = H.q(db, 'SELECT * FROM restock_notify_batches WHERE batch_uuid=?', [x.bu])[0];
        db.run("UPDATE restock_notify_batches SET status='paused', pause_reason='auth_error' WHERE batch_uuid=?", [x.bu]);
        const req = H.q(db, "SELECT request_uuid, cycle_no FROM product_demand_requests WHERE store_id=? AND line_user_id=? AND product_id=?", [STORE, uc, P.i5])[0];
        const cols = H.q(db, 'PRAGMA table_info(restock_notify_deliveries)').map((c) => c.name);
        const tpl = H.q(db, 'SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [x.bu, x.ub])[0];
        const row = { ...tpl, id: undefined, delivery_uuid: '00000000-0000-4000-8000-0000000d2d01', request_uuid: req.request_uuid, line_user_id: uc, status: 'pending', claim: 1, exclusion_reason: '', attempt_count: 0,
          retry_key: '00000000-0000-4000-8000-0000000d2a01', first_attempt_at: null, last_attempt_at: null, accepted_at: null, last_http_status: null, error_code: '' };
        if ('cycle_no' in tpl && req.cycle_no != null) row.cycle_no = req.cycle_no;
        const ks = cols.filter((c) => c !== 'id' && row[c] !== undefined);
        db.run(`INSERT INTO restock_notify_deliveries (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ks.map((k) => row[k]));
        db.run(`INSERT INTO restock_auto_events (event_uuid, store_id, product_id, product_name, trigger_source, modes_json, status, reason, epoch, completed_at)
                VALUES (?,?,?,?,?,?,'skipped','no_eligible_recipient',?,datetime('now'))`, [fxEvent, STORE, P.i5, 'C61P商品i5', 'line_status', JSON.stringify([{ mode: 'takeout', date: today, notice_kind: 'restock' }]),
          Number(H.q(db, "SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE])[0].value)]);
        void tmpBatch; H.saveDbFile(db, C.dbf); db.close(); }
      await restart();
      const br = await batchRow(x.bu);
      const c = await q("SELECT * FROM restock_notify_deliveries WHERE delivery_uuid='00000000-0000-4000-8000-0000000d2d01'");
      const evAfter = await events(P.i5);
      const fx = evAfter.find((e) => e.event_uuid === fxEvent) || {};
      assert(c[0] && c[0].claim == null && /^auto_(epoch|product_version)_stale$/.test(c[0].exclusion_reason) && c[0].status === 'pending' && c[0].retry_key === '00000000-0000-4000-8000-0000000d2a01'
        && calls(uc).length === 0 && fx.status === 'skipped' && evAfter.length === ep0.length + 1 && br.pause_reason === 'auth_error',
        'D2 [FX] 基準留下的「過期暫停批次＋未送出仍占名額」：重啟後安全清理（釋放名額、記錄原因、保留原 key 與授權暫停原因）；歷史 skipped 事件不自動重排或補發',
        JSON.stringify({ C: c[0] && [c[0].status, c[0].claim, c[0].exclusion_reason], pause: br.pause_reason, fx: fx.status, http: calls(uc).length }));
    });

    assert(C.mf.real() === 0, 'Z 真實 LINE Messaging API 呼叫 0 次', JSON.stringify({ real: C.mf.real(), mock_http: C.mf.calls().length }));
  } catch (e) { assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1500)); }
  finally { try { if (C) await C.s.stop(); } catch {} }
  const sum = H.summary();
  const mock = C ? { http_calls: C.mf.calls().length, retry_keys_seen: new Set(C.mf.calls().map((c) => c.retry_key)).size, unique_accepted_keys: Object.keys(JSON.parse(fs.readFileSync(C.mf.state, 'utf8')).accepted || {}).length } : {};
  if (process.env.C61P_RESULT_JSON) fs.writeFileSync(process.env.C61P_RESULT_JSON, JSON.stringify({ suite: 'c6-1-pause-claim-release', root: H.ROOT, pass: sum.passCount, fail: sum.failCount, meta: META, mock, cases: sum.results }, null, 1));
  console.log(`\n模擬 LINE：HTTP 呼叫 ${mock.http_calls}、retry key ${mock.retry_keys_seen}、唯一受理 ${mock.unique_accepted_keys}`);
  console.log(`結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
