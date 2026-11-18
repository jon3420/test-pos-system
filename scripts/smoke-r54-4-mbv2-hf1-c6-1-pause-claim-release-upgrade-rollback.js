#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release-upgrade-rollback.js
// R54.4／MBV2-HF1-C6.1 補修 —— 升級／回退：C6.1 → 補修版 → 回退 C6.1 → 再升級補修版（同一個資料庫檔；[RS]＝實際停止／啟動服務程序）
//   補修版＝本腳本所在的應用程式根目錄（H.ROOT）；C6.1＝C61P_BASE_ROOT（未修改 C6.1 的全新解壓樹）。
// 每次切換逐表核對：需求、同意、批次、逐筆結果、retry key、版本（商品參與版本、批次 epoch／參與版本、事件版本）、訂單與時間。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const RealDate = Date;
const TP = (h, m) => { const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3); const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds(); return String(h * 3600e3 + m * 60e3 - cur); };
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, U, sleep } = C45;
const { assert } = H;
const RB = process.env.C61P_BASE_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], ...[1, 2, 3, 4].map((i) => [940 + i, '升降補修商品' + i, i, 'paused', { quota: 50 }])];
const TABLES = { product_demand_requests: 'request_uuid', product_demand_consents: 'consent_uuid', restock_notify_batches: 'batch_uuid', restock_notify_deliveries: 'delivery_uuid', products: 'id', orders: 'id', restock_auto_events: 'event_uuid' };
// 會隨正常處理推進的欄位（其餘欄位含 retry_key、版本欄位、時間建立值必須逐列相同）
const MOVING = new Set(['updated_at', 'status', 'pause_reason', 'exclusion_reason', 'claim', 'error_code', 'next_attempt_at', 'completed_at', 'attempt_count', 'first_attempt_at', 'last_attempt_at',
  'accepted_at', 'last_http_status', 'line_request_id', 'accepted_request_id', 'taken_over_by', 'notified_at', 'sale_status', 'line_quota_sold', 'detail_json', 'reason', 'batch_uuids', 'confirmed_at', 'confirmed_by',
  'restock_auto_notify', 'restock_auto_version', 'updated_by']);

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6.1 補修 升級／回退（C6.1 ↔ 補修版，同一資料庫檔）══════════');
  console.log('補修版：' + H.ROOT + '\nC6.1：' + (RB || '（未提供）'));
  if (!RB) { H.fail('需要 C61P_BASE_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const S = (u) => sessAt(u, OFF);
  const dir = H.tmpDir('c61pu'); const dbf = path.join(dir, 'pos.db');
  const mf = C45.lineMockFiles('c61pu'); const GATE = H.tmpDir('c61pu-gate');
  const ctrl = { default: '200', byUser: {} }; const lineCtl = () => fs.writeFileSync(mf.ctrl, JSON.stringify(ctrl)); lineCtl();
  const port = await new Promise((res) => { const sv = require('net').createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  let proc = null, tok = null;
  const start = async (root) => {
    const nodeArgs = ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js'), '-r', path.join(LIB, 'c61-line-gate.js')];
    proc = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: root, env: { ...process.env, C4_CLOCK_OFFSET_MS: String(OFF), RESTOCK_NOTIFY_LINE_TIMEOUT_MS: '30000', C61_LINE_GATE_DIR: GATE,
      PORT: String(port), POS_DB_PATH: dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei', MIGRATION_TMP_DIR: path.join(dir, 'uploads'),
      HF1C3_PUSH_COUNT_FILE: mf.push, C4_LINE_MOCK_CTRL: mf.ctrl, C4_LINE_MOCK_STATE: mf.state, C4_LINE_MOCK_LOG: mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 300; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { tok = await H.login(base, STORE, 'pw001'); break; } } catch {} if (proc.exitCode != null) throw new Error('exit ' + log.slice(-1500)); await sleep(100); }
    if (!tok) throw new Error('start timeout');
    const t0 = Date.now(); while (!/\[restock_auto\] boot recovery done/.test(log) && Date.now() - t0 < 8000) await sleep(30); // 兩版都有開機恢復完成紀錄
    await idle();
  };
  const stop = async () => { const p = proc; proc = null; tok = null; if (!p || p.exitCode != null) return; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000); }); };
  const adm = (m, p, b) => H.api(base, tok, m, p, b);
  const pub = (m, p, b) => C45.pub(base, m, p, b);
  const calls = (u) => mf.calls().filter((c) => c.uid === u);
  const q = async (sql, params) => { const db = await H.openDbFile(dbf); try { return H.q(db, sql, params); } finally { db.close(); } };
  async function idle(ms = 15000) { const t0 = Date.now(); for (;;) { const r = await q("SELECT (SELECT COUNT(*) FROM restock_notify_batches WHERE status='sending') + (SELECT COUNT(*) FROM restock_auto_events WHERE status IN ('queued','processing')) AS n"); if (!Number(r[0].n)) return; if (Date.now() - t0 > ms) return; await sleep(50); } }
  const reg = async (u, pid) => { const r = await pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: 'takeout', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' }); if (!r.json || !r.json.success) throw new Error('reg ' + r.text.slice(0, 200)); };
  const setStatus = (pid, st) => adm('PATCH', `/api/products/${pid}/line-status`, { sale_status: st });
  const waitFile = async (f, ms = 20000) => { const t0 = Date.now(); while (!fs.existsSync(f)) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  const snapshot = async () => { const out = {}; for (const [t, k] of Object.entries(TABLES)) out[t] = new Map((await q(`SELECT * FROM ${t}`)).map((r) => [String(r[k]), r])); return out; };
  const preserved = (a, b) => {
    const lost = [], changed = [];
    for (const t of Object.keys(TABLES)) for (const [k, r] of a[t]) {
      const n = b[t].get(k); if (!n) { lost.push(t + ':' + k); continue; }
      for (const c of Object.keys(r)) {
        if (!(c in n) || MOVING.has(c) || String(r[c]) === String(n[c])) continue;
        if (t === 'orders' && c === 'pickup_type' && (r[c] == null || r[c] === '') && n[c] === 'store') continue; // 各版本相同的既有開機補值
        changed.push(`${t}:${k}:${c}`);
      }
    }
    return { lost, changed };
  };
  const evidence = (a, b) => {
    const bad = [];
    for (const [k, r] of a.restock_notify_deliveries) {
      const n = b.restock_notify_deliveries.get(k);
      if (!n) { bad.push('lost:' + k); continue; }
      if (String(r.retry_key) !== String(n.retry_key)) bad.push('key:' + k);
      if (r.status === 'accepted' && n.status !== 'accepted') bad.push('acc:' + k);
      if (Number(r.attempt_count) > 0 && (Number(n.attempt_count) < Number(r.attempt_count) || String(n.claim) !== String(r.claim))) bad.push('attempted:' + k);
    }
    return bad;
  };
  const versions = async () => ({ p: await q('SELECT id, restock_auto_notify, restock_auto_version FROM products WHERE id BETWEEN 941 AND 944 ORDER BY id'),
    b: await q('SELECT batch_uuid, auto_epoch, auto_product_version FROM restock_notify_batches ORDER BY id'), e: await q('SELECT event_uuid, epoch, product_auto_version FROM restock_auto_events ORDER BY id'),
    ep: (await q("SELECT value FROM settings WHERE store_id=? AND key='restock_auto_notify_epoch'", [STORE]))[0] });
  // 交錯：A 在模擬 LINE 等待回應時全店關閉再開啟，A 回應授權錯誤 → 批次暫停
  const interleave = async (pid, ua, ub, seqA) => {
    ctrl.byUser[ua] = seqA; lineCtl();
    await adm('PATCH', `/api/product-demand-admin/restock/auto/products/${pid}`, { enabled: true });
    for (const u of [ua, ub]) await reg(u, pid);
    fs.writeFileSync(path.join(GATE, 'hold_' + ua), '1');
    await setStatus(pid, 'available');
    if (!await waitFile(path.join(GATE, 'arrived_' + ua))) throw new Error('A not arrived');
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: false }); await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    fs.writeFileSync(path.join(GATE, 'release_' + ua), '1'); await idle();
    const bu = (await q('SELECT batch_uuid FROM restock_notify_batches WHERE product_id=? ORDER BY id DESC LIMIT 1', [pid]))[0].batch_uuid;
    return { bu, b: (await q('SELECT status, claim, exclusion_reason, retry_key, attempt_count FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [bu, ub]))[0],
      pause: (await q('SELECT pause_reason FROM restock_notify_batches WHERE batch_uuid=?', [bu]))[0].pause_reason };
  };
  const newEvent = async (pid) => { await setStatus(pid, 'paused'); await setStatus(pid, 'available'); await idle(); return (await q('SELECT status, reason FROM restock_auto_events WHERE product_id=? ORDER BY id DESC LIMIT 1', [pid]))[0]; };

  try {
    // 以 C6.1 自己的程式建立空資料庫並放入種子
    { const p0 = spawn(process.execPath, ['server.js'], { cwd: RB, env: { ...process.env, PORT: String(port), POS_DB_PATH: dbf, MIGRATION_TMP_DIR: path.join(dir, 'uploads') }, stdio: 'ignore' });
      for (let i = 0; i < 300; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {} await sleep(100); }
      await new Promise((r) => { p0.once('exit', r); p0.kill('SIGTERM'); });
      const db = await H.openDbFile(dbf); require('./lib/mbv2-seed').seedStore001(db); C45.seedStore(db, { products: PRODUCTS, members: 40, settings: { restock_notify_enabled: '1' } }); H.saveDbFile(db, dbf); db.close(); }

    // ── 1. C6.1：產生缺口狀態 ──
    await start(RB);
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    const g1 = await interleave(941, U(1), U(2), ['401', '200']);
    const o = await pub('POST', '/api/line-orders', { customer_name: '補修升降訂單', customer_phone: '0912000111', order_type: 'takeout', pickup_date: new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10), pickup_time: '22:30', payment_method: 'cash', items: [{ product_id: 701, qty: 1 }] });
    const s1 = await snapshot(); const v1 = await versions();
    await stop();
    // ── 2. 升級補修版 ──
    await start(H.ROOT);
    const s2 = await snapshot(); const v2 = await versions(); const p2 = preserved(s1, s2);
    const b2 = (await q('SELECT status, claim, exclusion_reason, retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [g1.bu, U(2)]))[0];
    const pr2 = (await q('SELECT pause_reason FROM restock_notify_batches WHERE batch_uuid=?', [g1.bu]))[0].pause_reason;
    assert(o.json && o.json.success && Number(g1.b.claim) === 1 && !g1.b.exclusion_reason && !p2.lost.length && !p2.changed.length && !evidence(s1, s2).length && JSON.stringify(v1) === JSON.stringify(v2)
      && b2.claim == null && b2.exclusion_reason === 'auto_epoch_stale' && b2.retry_key === g1.b.retry_key && b2.status === 'pending' && pr2 === 'auth_error',
      'U1 [RS] C6.1 → 補修版：C6.1 留下的「過期暫停批次＋未送出仍占名額」在開機時安全清理（釋放名額、記錄原因、retry key 不變、保留授權暫停原因）；需求、同意、批次、逐筆、版本、訂單全部保留',
      JSON.stringify({ c61_B: [g1.b.claim, g1.b.exclusion_reason], fix_B: [b2.claim, b2.exclusion_reason], pause: pr2, lost: p2.lost.slice(0, 3), changed: p2.changed.slice(0, 3), ver_same: JSON.stringify(v1) === JSON.stringify(v2) }));
    ctrl.byUser[U(1)] = ['200']; lineCtl();
    const e2 = await newEvent(941);
    assert(e2.status === 'completed' && calls(U(2)).length === 1, 'U2 [RS] 補修版：新的合法恢復販售事件通知 B 1 則', JSON.stringify({ e2, n: calls(U(2)).length }));
    const g2 = await interleave(942, U(3), U(4), ['429_quota', '200']);
    assert(g2.b.claim == null && g2.b.exclusion_reason === 'auto_epoch_stale' && g2.pause === 'monthly_limit', 'U3 [RS] 補修版：交錯（關閉再開啟＋額度不足）即時釋放 B 名額，不需重啟', JSON.stringify(g2));
    const s3 = await snapshot(); const v3 = await versions();
    await stop();
    // ── 3. 回退 C6.1 ──
    await start(RB);
    const s4 = await snapshot(); const v4 = await versions(); const p4 = preserved(s3, s4);
    const b4 = (await q('SELECT claim, exclusion_reason FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [g2.bu, U(4)]))[0];
    assert(!p4.lost.length && !p4.changed.length && !evidence(s3, s4).length && JSON.stringify(v3) === JSON.stringify(v4) && b4.claim == null,
      'R1 [RS] 補修版 → 回退 C6.1：資料、逐筆證據、retry key 與版本全部保留；已釋放的名額維持釋放（C6.1 不會重新占用）', JSON.stringify({ lost: p4.lost.slice(0, 3), changed: p4.changed.slice(0, 3), B: b4 }));
    ctrl.byUser[U(3)] = ['200']; lineCtl();
    await newEvent(942);
    const n4 = calls(U(4)).length;
    const g3 = await interleave(943, U(5), U(6), ['401', '200']);
    assert(n4 === 1 && Number(g3.b.claim) === 1 && !g3.b.exclusion_reason,
      'R2 [RS] 回退 C6.1 期間：先前已釋放的 B 可由新事件通知 1 則；但新的交錯情境缺口恢復（B 仍占名額 claim=1、無原因）— 回退限制', JSON.stringify({ n4, g3: g3.b }));
    const s5 = await snapshot(); const v5 = await versions();
    await stop();
    // ── 4. 再升級補修版 ──
    await start(H.ROOT);
    const s6 = await snapshot(); const v6 = await versions(); const p6 = preserved(s5, s6);
    const b6 = (await q('SELECT claim, exclusion_reason, retry_key FROM restock_notify_deliveries WHERE batch_uuid=? AND line_user_id=?', [g3.bu, U(6)]))[0];
    ctrl.byUser[U(5)] = ['200']; lineCtl();
    const e6 = await newEvent(943);
    assert(!p6.lost.length && !p6.changed.length && !evidence(s5, s6).length && JSON.stringify(v5) === JSON.stringify(v6) && b6.claim == null && b6.retry_key === g3.b.retry_key && e6.status === 'completed' && calls(U(6)).length === 1
      && [1, 2, 3, 4, 5, 6].every((i) => new Set(calls(U(i)).filter((c) => c.result === 200 || c.result === 409).map((c) => c.retry_key)).size <= 1),
      'R3 [RS] 再升級補修版：回退期間留下的過期名額於開機清理；資料／版本保留；新事件通知 B 1 則；每位會員唯一受理 ≤ 1',
      JSON.stringify({ lost: p6.lost.slice(0, 3), changed: p6.changed.slice(0, 3), B: b6, e6, n6: calls(U(6)).length }));
    assert(mf.real() === 0, 'Z 真實 LINE 呼叫 0 次', JSON.stringify({ real: mf.real() }));
  } catch (e) { assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 1500)); }
  finally { await stop(); }
  const sum = H.summary();
  if (process.env.C61P_RESULT_JSON) fs.writeFileSync(process.env.C61P_RESULT_JSON, JSON.stringify({ suite: 'c6-1-pause-claim-release-upgrade-rollback', pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
