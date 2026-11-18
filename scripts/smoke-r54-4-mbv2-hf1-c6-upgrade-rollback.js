#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c6-upgrade-rollback.js
// R54.4／MBV2-HF1-C6 —— 真實升級與回退：同一個資料庫檔，在「C5.4 全新解壓樹（C6_OLD_ROOT）」與 C6 之間切換。
//   U1 [RS] C5.4 建立並使用（登記、同意、手動批次已受理）→ C6 啟動：自動通知預設關閉、既有批次為「手動」、成效報表不變、不發送任何訊息
//   R1 [RS] C6 開啟自動並產生自動批次 → 退回 C5.4：可啟動、手動預覽可用、恢復販售不會自動發送（C5.4 沒有自動功能）
//   R2 [RS] 再升級回 C6：設定保留；之前已受理的登記不重送；新的恢復販售正常自動通知
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
const OLD = process.env.C6_OLD_ROOT || '';
const LIB = path.join(__dirname, 'lib');
const CLOCK = path.join(LIB, 'c4-test-clock.js');
const MSPATH = path.join(H.ROOT, 'utils', 'lineMemberSession.js');
const sessAt = (u, off) => execFileSync(process.execPath, ['-r', CLOCK, '-e', `process.stdout.write(require(${JSON.stringify(MSPATH)}).createMemberSession({store_id:'${STORE}',line_user_id:'${u}',ttl_ms:${30 * 86400e3}}))`],
  { env: { ...process.env, C4_CLOCK_OFFSET_MS: String(off) } }).toString();
const PRODUCTS = [[701, '測試招牌飯', 0, 'available', { quota: 50 }], [901, '升級商品甲', 1, 'available', { quota: 50 }], [902, '升級商品乙', 2, 'paused', { quota: 50 }], [903, '升級商品丙', 3, 'paused', { quota: 50 }]];
(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C6 真實升級（C5.4 → C6）與回退驗證 ══════════');
  console.log('C6：' + H.ROOT + '　舊版：' + (OLD || '（未提供）'));
  if (!OLD) { H.fail('需要 C6_OLD_ROOT', ''); process.exit(1); }
  const OFF = process.env.C4_CLOCK_OFFSET_MS;
  const env = { __nodeArgs: ['-r', CLOCK, '-r', path.join(LIB, 'hf1c3-net-mock.js'), '-r', path.join(LIB, 'c4-line-mock.js')], C4_CLOCK_OFFSET_MS: String(OFF) };
  const C = await C45.boot('c6ur', { products: PRODUCTS, members: 30, settings: { restock_notify_enabled: '1' }, env });
  await C.s.stop();
  const port = C.s.port; const base = `http://127.0.0.1:${port}`;
  let proc = null, tok = null;
  const start = async (root) => {
    proc = spawn(process.execPath, [...env.__nodeArgs, 'server.js'], { cwd: root, env: { ...process.env, ...env, PORT: String(port), POS_DB_PATH: C.dbf, GOOGLE_MAPS_SERVER_KEY: 'test-only-key', TZ: 'Asia/Taipei',
      MIGRATION_TMP_DIR: path.join(path.dirname(C.dbf), 'uploads'), HF1C3_PUSH_COUNT_FILE: C.mf.push, C4_LINE_MOCK_CTRL: C.mf.ctrl, C4_LINE_MOCK_STATE: C.mf.state, C4_LINE_MOCK_LOG: C.mf.log }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; }); proc.getLog = () => log;
    for (let i = 0; i < 200; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) { tok = await H.login(base, STORE, 'pw001'); return; } } catch {} if (proc.exitCode != null) throw new Error('exit ' + log.slice(-1500)); await sleep(150); }
    throw new Error('start timeout');
  };
  const stop = async () => { const p = proc; proc = null; if (!p || p.exitCode != null) return; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(() => { try { p.kill('SIGKILL'); } catch {} r(); }, 4000); }); };
  const adm = (m, p, b) => H.api(base, tok, m, p, b);
  const pub = (m, p, b) => C45.pub(base, m, p, b);
  const S = (u) => sessAt(u, OFF);
  const today = new Date(RealDate.now() + Number(OFF) + 8 * 3600e3).toISOString().slice(0, 10);
  const pushesTo = (u) => C.mf.calls().filter((c) => c.uid === u).length;
  const reg = (u, pid) => pub('POST', '/api/product-demand/register', { member_session: S(u), product_id: pid, desired_qty: 1, fulfillment_pref: 'takeout', notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
  const waitBatch = async (pid) => { for (let i = 0; i < 80; i++) { const r = await adm('GET', `/api/product-demand-admin/restock/batches?product_id=${pid}`); const bs = (r.json && r.json.data) || []; if (bs.length && !bs.some((b) => b.status === 'sending' || b.running)) return bs; await sleep(200); } return []; };
  fs.writeFileSync(C.mf.ctrl, JSON.stringify({ default: '200' }));
  try {
    // ── C5.4 建立並使用 ──
    await start(OLD);
    for (const i of [1, 2]) await reg(U(i), 901);
    const pv = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 901, fulfillment_mode: 'takeout', supply_date: today });
    await adm('POST', `/api/product-demand-admin/restock/batches/${pv.json.data.batch_uuid}/confirm`, {});
    await waitBatch(901);
    const sumOld = (await adm('GET', '/api/analytics/restock-notify/summary')).json.data.totals;
    await stop();
    // ── 升級到 C6 ──
    await start(H.ROOT);
    const cfg = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data;
    const bs = await waitBatch(901);
    const sumNew = (await adm('GET', '/api/analytics/restock-notify/summary')).json.data;
    await adm('PATCH', '/api/products/902/line-status', { sale_status: 'available' }); await sleep(1200);
    const ev = (await adm('GET', '/api/product-demand-admin/restock/auto/events')).json.data;
    assert(cfg.enabled === false && bs[0].source === 'manual' && bs[0].counts.accepted === 2 && sumNew.totals.batches === sumOld.batches && sumNew.batches[0].source === 'manual' && ev.length === 0 && pushesTo(U(1)) === 1,
      'U1 [RS] C5.4 資料庫升級到 C6：自動通知預設關閉、既有批次標示為手動、成效報表批次數不變、恢復販售不自動發送', JSON.stringify({ en: cfg.enabled, src: bs[0] && bs[0].source, b: [sumOld.batches, sumNew.totals.batches], ev: ev.length }));
    // C6 開啟自動並產生自動批次
    await adm('PATCH', '/api/product-demand-admin/restock/auto', { enabled: true });
    await adm('PATCH', '/api/product-demand-admin/restock/auto/products/903', { enabled: true });
    await reg(U(3), 903);
    await adm('PATCH', '/api/products/903/line-status', { sale_status: 'available' });
    const b903 = await waitBatch(903);
    await adm('PATCH', '/api/products/903/line-status', { sale_status: 'paused' });
    await reg(U(4), 903);
    await stop();
    // ── 退回 C5.4 ──
    await start(OLD);
    await adm('PATCH', '/api/products/903/line-status', { sale_status: 'available' }); await sleep(1500);
    const listOld = (await adm('GET', '/api/product-demand-admin/restock/batches?product_id=903')).json.data;
    const pvOld = await adm('POST', '/api/product-demand-admin/restock/preview', { product_id: 903, fulfillment_mode: 'takeout', supply_date: today });
    assert(b903[0] && b903[0].source === 'auto' && pushesTo(U(3)) === 1 && pvOld.json.success && pvOld.json.data.stats.eligible_count === 1 && pushesTo(U(4)) === 0 && listOld.length === b903.length && listOld.some((b) => b.batch_uuid === b903[0].batch_uuid),
      'R1 [RS] 退回 C5.4：可讀同一資料庫並啟動；手動預覽可用（已受理者排除、新登記 1 位）；恢復販售不會自動發送；自動批次紀錄保留', JSON.stringify({ src: b903[0] && b903[0].source, eligible: pvOld.json.data && pvOld.json.data.stats.eligible_count, u4: pushesTo(U(4)) }));
    await adm('PATCH', '/api/products/903/line-status', { sale_status: 'paused' });
    await stop();
    // ── 再升級回 C6 ──
    await start(H.ROOT);
    const cfg2 = (await adm('GET', '/api/product-demand-admin/restock/auto')).json.data;
    await adm('PATCH', '/api/products/903/line-status', { sale_status: 'available' });
    await sleep(500); await waitBatch(903); await sleep(500);
    assert(cfg2.enabled === true && pushesTo(U(3)) === 1 && pushesTo(U(4)) === 1,
      'R2 [RS] 再升級回 C6：自動設定保留；已受理的登記不重送；新的恢復販售自動通知新登記（1 則）', JSON.stringify({ en: cfg2.enabled, u3: pushesTo(U(3)), u4: pushesTo(U(4)) }));
    assert(C.mf.real() === 0, 'Z 真實 LINE 呼叫 0 次', JSON.stringify({ real: C.mf.real() }));
  } catch (e) { assert(false, '測試執行例外', String(e && e.stack || e).slice(0, 800)); }
  finally { await stop(); }
  const sum = H.summary();
  if (process.env.C6_RESULT_JSON) fs.writeFileSync(process.env.C6_RESULT_JSON, JSON.stringify({ suite: 'c6-upgrade-rollback', pass: sum.passCount, fail: sum.failCount, cases: sum.results }, null, 1));
  console.log(`\n結果：${sum.passCount} 通過／${sum.failCount} 失敗`);
  process.exit(sum.failCount ? 1 : 0);
})();
