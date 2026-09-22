#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-rc2-security.js
// H1.4.12 Phase 3B RC2 — Security Corrective Audit: IP trust model, unified
// error contracts, fresh-authority liff-config, empty-snapshot contract.
// RC2.1 (verification-only corrective pass; no production code changed):
//   - liff-config fresh-authority section 6 rebuilt: license-inactive (renamed) +
//     a real store-inactive, each with post-token-creation injection, token-unchanged
//     proof, and exact finally-restore from live-read originals.
//   - section 6b: enabled -> disabled -> enabled fresh-read evidence with the
//     featureGate cache deliberately primed stale in both directions.
//   - final case: session-deleted (session removed via the official DELETE API after
//     token creation), closing the last disclosed liff-config coverage gap; token-unchanged
//     now compares status/opened_at/consumed_at/expires_at/popup_session_public_code per field.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B RC2.1 security corrective audit (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-rc2-security-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rc2-security';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const features = JSON.stringify({ line_order: true, orders: true, products: true });
  db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','脆豬腰','pro',1,?)`, [features]);
  db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
  db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'line_popup_liff_id', 'popup-liff-rc2')");
  try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
  db._save();

  const jwt = require('jsonwebtoken');
  const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  function buildApp(trustProxySetting) {
    const express = require('express');
    const app = express();
    if (trustProxySetting !== undefined) app.set('trust proxy', trustProxySetting);
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    const { createResolveTargetRouter } = require('../routes/cart-recovery-resolve-target');
    const { createCartRecoveryBootstrapRouter } = require('../routes/cart-recovery-bootstrap');
    const { createPopupRestoreRouter } = require('../routes/cart-recovery-popup-restore');
    app.use('/api/cart-recovery/resolve-target', createResolveTargetRouter());
    app.use('/api/cart-recovery', createCartRecoveryBootstrapRouter());
    app.use('/api/cart-recovery', createPopupRestoreRouter());
    return app;
  }

  async function startServer(trustProxySetting) {
    const app = buildApp(trustProxySetting);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    return { server, base: `http://127.0.0.1:${port}` };
  }

  async function call(base, method, urlPath, { token, body, xff } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (xff !== undefined) headers['X-Forwarded-For'] = xff;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
  function taipeiDateStr(offsetDays = 0) {
    const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  }
  async function makeCampaign(base, name) {
    const r = await call(base, 'POST', '/api/popup-pickup/campaigns', { token: T1, body: { name } });
    await call(base, 'PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token: T1, body: { status: 'published' } });
    return r.json.data;
  }
  async function makeLocation(base, name) {
    const r = await call(base, 'POST', '/api/popup-pickup/locations', { token: T1, body: { name, address: name + ' Addr', lat: 25, lng: 121 } });
    return r.json.data;
  }
  async function makeSession(base, campaignId, locationId) {
    const body = {
      campaign_id: campaignId, name: 'RC2SecurityTest場次', location_id: locationId, product_scope: 'all_takeout',
      pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
      order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
    };
    const r = await call(base, 'POST', '/api/popup-pickup/sessions', { token: T1, body });
    if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
    await call(base, 'PATCH', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1, body: { expected_revision: r.json.data.revision, status: 'published' } });
    const fresh = await call(base, 'GET', `/api/popup-pickup/sessions/${r.json.data.id}`, { token: T1 });
    return fresh.json.data;
  }

  const { createRecoveryResumeToken } = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');
  function tokenRow(rawToken) { return db.get('SELECT status FROM line_cart_handoff_tokens WHERE token=?', [rawToken]); }

  // ══════════════════════════════════════════════════════════════
  // 一、IP 信任模型：trust proxy=false 時，偽造 X-Forwarded-For 完全不影響 rate limit key。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2信任模型活動1');
      const loc = await makeLocation(base, 'RC2信任模型地點1');
      const session = await makeSession(base, camp.id, loc.id);

      const results35 = [];
      for (let i = 0; i < 35; i++) {
        // 每次都用完全不同的偽造 X-Forwarded-For，模擬攻擊者試圖用假 header 繞過限流。
        const fakeXff = `10.${i}.${i}.${i}`;
        const r = await call(base, 'POST', '/api/cart-recovery/liff-config', { xff: fakeXff, body: { recovery_token: 'nonexistent-token-' + i } });
        results35.push(r.status);
      }
      const first20 = results35.slice(0, 20);
      const the21st = results35[20];
      assert(first20.every((s) => s !== 429), '1-trust-proxy-false-first20-not-limited trust proxy=false 時，前 20 次請求（liff-config 門檻 20/min）依契約處理，不因為偽造不同 XFF 而被視為不同來源', JSON.stringify(first20));
      assert(the21st === 429, '1-trust-proxy-false-21st-limited 第 21 次請求被 429 擋下——證明所有偽造的 XFF 都被忽略，全部算同一個真實來源（loopback socket）', String(the21st));
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二、各種偽造 XFF 形式（空白、逗號多值、IPv6）都不得繞過，涵蓋
  // liff-config/bootstrap-member/resolve-target/prepare/commit 五個端點。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2信任模型活動2');
      const loc = await makeLocation(base, 'RC2信任模型地點2');
      const session = await makeSession(base, camp.id, loc.id);

      async function fireUntilLimited(urlPath, buildBody, max) {
        const statuses = [];
        const weirdXffValues = ['', '1.2.3.4, 5.6.7.8, 9.10.11.12', '::1', '2001:db8::1', '   ', 'not-an-ip-at-all', '127.0.0.1'];
        for (let i = 0; i < max + 5; i++) {
          const xff = weirdXffValues[i % weirdXffValues.length] + '-' + i; // 每次仍然不同，模擬持續變換偽造值
          const r = await call(base, 'POST', urlPath, { xff, body: buildBody(i) });
          statuses.push(r.status);
        }
        return statuses;
      }

      const liffStatuses = await fireUntilLimited('/api/cart-recovery/liff-config', (i) => ({ recovery_token: 'nonexistent-' + i }), 20);
      assert(liffStatuses[20] === 429, '2-liff-config-weird-xff-still-limited liff-config：各種奇形怪狀的偽造 XFF（空白/多值/IPv6/非 IP 字串）都不能繞過，第 21 次仍被限流', JSON.stringify(liffStatuses.slice(15, 22)));

      const bootstrapStatuses = await fireUntilLimited('/api/cart-recovery/bootstrap-member', (i) => ({ recovery_token: 'nonexistent-' + i, line_id_token: 'x' }), 20);
      assert(bootstrapStatuses[20] === 429, '2-bootstrap-weird-xff-still-limited bootstrap-member 同樣不能被偽造 XFF 繞過', JSON.stringify(bootstrapStatuses.slice(15, 22)));

      const resolveStatuses = await fireUntilLimited('/api/cart-recovery/resolve-target', (i) => ({ recovery_token: 'nonexistent-' + i, member_session: 'x' }), 30);
      assert(resolveStatuses[30] === 429, '2-resolve-target-weird-xff-still-limited resolve-target 同樣不能被偽造 XFF 繞過', JSON.stringify(resolveStatuses.slice(28, 32)));

      const prepareStatuses = await fireUntilLimited('/api/cart-recovery/prepare-popup-restore', (i) => ({ recovery_token: 'nonexistent-' + i, member_session: 'x', popup_session_public_code: 'x' }), 30);
      assert(prepareStatuses[30] === 429, '2-prepare-weird-xff-still-limited prepare-popup-restore 同樣不能被偽造 XFF 繞過', JSON.stringify(prepareStatuses.slice(28, 32)));

      const commitStatuses = await fireUntilLimited('/api/cart-recovery/commit-popup-restore', (i) => ({ restore_receipt: 'nonexistent-' + i, member_session: 'x', popup_session_public_code: 'x' }), 30);
      assert(commitStatuses[30] === 429, '2-commit-weird-xff-still-limited commit-popup-restore 同樣不能被偽造 XFF 繞過', JSON.stringify(commitStatuses.slice(28, 32)));
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 三、trust proxy 受控開啟時，req.ip 行為符合 Express 設定（用不同的
  // X-Forwarded-For 值時，Express 會解析出不同的 req.ip，各自有獨立配額）。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(1); // 信任第一層代理
    try {
      const statusesA = [];
      for (let i = 0; i < 21; i++) {
        const r = await call(base, 'POST', '/api/cart-recovery/liff-config', { xff: '203.0.113.10', body: { recovery_token: 'nonexistent-a-' + i } });
        statusesA.push(r.status);
      }
      assert(statusesA[20] === 429, '3-trust-proxy-enabled-same-xff-limited trust proxy=1 時，同一個 XFF 值（203.0.113.10）在第 21 次被限流', JSON.stringify(statusesA.slice(18, 21)));

      // 換一個不同的 XFF 值，因為 trust proxy 生效，Express 解析出不同的
      // req.ip，應該是全新、未被前面用掉的配額。
      const rDifferentIp = await call(base, 'POST', '/api/cart-recovery/liff-config', { xff: '198.51.100.20', body: { recovery_token: 'nonexistent-b-1' } });
      assert(rDifferentIp.status !== 429, '3-trust-proxy-enabled-different-xff-not-limited trust proxy=1 時，不同的 XFF 值（198.51.100.20）被 Express 解析成不同 req.ip，不會被前一個 IP 的配額卡住', JSON.stringify(rDifferentIp));
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 四、大量不同偽造 XFF 不會造成 limiter Map 無限成長（hard cap 生效）。
  // ══════════════════════════════════════════════════════════════
  {
    const { createRateLimiter } = require('../utils/rateLimiter');
    const limiter = createRateLimiter({ windowMs: 60000, max: 30, hardCapEntries: 100 });
    for (let i = 0; i < 500; i++) {
      limiter.check({ ip: `fake-ip-${i}` });
    }
    assert(limiter._bucket.size <= 100, '4-hard-cap-enforced 即使 500 個完全不同的來源 key 湧入，limiter Map 大小不超過設定的 hard cap（100）', String(limiter._bucket.size));
  }

  // ══════════════════════════════════════════════════════════════
  // 五、429 不得改 token/receipt 狀態，也不得洩漏 token 存在性。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2的429測試活動');
      const loc = await makeLocation(base, 'RC2的429測試地點');
      const session = await makeSession(base, camp.id, loc.id);
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'U429test', pageType: 'popup_order', popupSessionPublicCode: session.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'U429test' });

      // 先把 resolve-target 的配額打滿。
      for (let i = 0; i < 30; i++) {
        await call(base, 'POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: 'burn-quota-' + i, member_session: 'x' } });
      }
      const limitedReal = await call(base, 'POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: created.token, member_session: ms } });
      assert(limitedReal.status === 429, '5-429-blocks-even-valid-token 配額用完後，即使是真正有效的 token 也一樣被 429 擋下（不會因為 token 合法就放行）', JSON.stringify(limitedReal));
      assert(tokenRow(created.token).status === 'bound', '5-429-no-state-change 被 429 擋下的請求完全沒有改變 token 狀態（仍是 bound）', JSON.stringify(tokenRow(created.token)));
      assert(JSON.stringify(limitedReal.json) === JSON.stringify({ success: false, reason: 'resolve_failed' }), '5-429-no-token-existence-leak 429 response 跟其他失敗（包含 token 根本不存在）用同一個 byte-identical body，不洩漏這個 token 其實是有效的', JSON.stringify(limitedReal.json));
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 六、liff-config fresh authority：pre-request mutation 測試（RC2.1 校正版）。
  //
  // RC2.1 verification-only corrective pass（不改任何功能程式）：
  //  1. RC2 原本命名為 "store-inactive" 的案例，實際執行的是
  //     UPDATE licenses SET active=0——那是「license 停用」，不是「store 停用」。
  //     現在正名為 license-inactive，另外新增真正的 store-inactive
  //     （UPDATE stores SET active=0）。
  //  2. 注意：stores 表的 `id` 是 INTEGER PRIMARY KEY AUTOINCREMENT，店家字串代碼
  //     ('store_001') 存放在 `store_id` 欄位。因此 stores 的注入 SQL 必須是
  //     WHERE store_id='store_001'；若寫成 WHERE id='store_001' 會永遠 0 rows
  //     （靜默 no-op，測試就會變成空轉）。每一次注入都用 injectSql() 強制檢查
  //     getRowsModified()===1，並另外用「注入前後整列 snapshot 必須不同」證明注入真的生效。
  //  3. 每個注入案例的順序固定：token 建立 → 注入 → 才呼叫 liff-config。
  //     原始值一律在注入前由 DB 現場讀取（整列 snapshot），finally 精確還原並驗證
  //     整列 byte-identical，不假設任何 seeded default。
  //  4. 每個案例都驗證：統一 404 + 與「不存在 token」byte-identical 的 body、
  //     token 整列完全未變（整列 JSON 比對，另外逐欄位明確比對 status、opened_at、consumed_at、
  //     expires_at、popup_session_public_code）。
  //  5. RC2.1 補齊：session-deleted（token 建立後場次被正式 API 刪除，代碼不再可解析）。
  //     session-draft 與 campaign-draft 的時序本來就是「token 建立 → 正向對照 200 → API 改 draft →
  //     404 → finally 還原」，符合規格，未重複新增。
  // ══════════════════════════════════════════════════════════════
  const { getStoreLicense, invalidateFeatureCache } = require('../middleware/featureGate');
  const LIFF_UNIFIED_BODY = JSON.stringify({ success: false, reason: 'liff_config_unavailable' });
  const SQL_STORE_ROW = "SELECT * FROM stores WHERE store_id='store_001'";
  const SQL_LICENSE_ROW = "SELECT * FROM licenses WHERE store_id='store_001'";
  const SQL_POPUP_FLAG_ROW = "SELECT * FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'";
  function rowJson(sql, params) { return JSON.stringify(db.get(sql, params || []) || null); }
  // watch spec = [sql, params, mode]；mode==='all' 時整個結果集（多列）做 snapshot，否則只取第一列。
  function snap(spec) { const [sql, params, mode] = spec; return mode === 'all' ? JSON.stringify(db.all(sql, params || [])) : rowJson(sql, params); }
  function reinsertRow(table, row) {
    const cols = Object.keys(row);
    injectSql(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]), `reinsert-${table}`);
  }
  function tokenRowFull(rawToken) { return db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=?', [rawToken]); }
  function injectSql(sql, params, label) {
    db._db.run(sql, params || []);
    const n = db._db.getRowsModified();
    if (n !== 1) throw new Error(`${label}: injection SQL modified ${n} rows (expected exactly 1) — refusing a vacuous injection. SQL: ${sql}`);
    db._save();
  }
  function callLiff(base, rawToken) { return call(base, 'POST', '/api/cart-recovery/liff-config', { body: { recovery_token: rawToken } }); }
  // RC2.1：除了整列 JSON 比對，另外「逐欄位」明確比對五個關鍵欄位，並要求 token 仍是
  // status='bound'、從未 opened／consumed、expires_at 仍有值；expectedSessionCode 有給時，
  // popup_session_public_code 必須仍綁定在原本那個場次代碼上。
  const TOKEN_KEY_FIELDS = ['status', 'opened_at', 'consumed_at', 'expires_at', 'popup_session_public_code'];
  function tokenUnchanged(rawToken, beforeRow, expectedSessionCode) {
    const after = tokenRowFull(rawToken);
    const fieldDiffs = TOKEN_KEY_FIELDS.filter((f) => after[f] !== beforeRow[f]);
    const same = JSON.stringify(after) === JSON.stringify(beforeRow)
      && fieldDiffs.length === 0
      && after.status === 'bound'
      && !after.opened_at && !after.consumed_at
      && !!after.expires_at
      && (expectedSessionCode === undefined || after.popup_session_public_code === expectedSessionCode);
    return { same, detail: JSON.stringify({ fieldDiffs, before: beforeRow, after }) };
  }

  // 全部案例開始前，先現場記錄三個「授權」來源的整列 snapshot，全部案例結束後必須完全一致。
  const authorityBeforeSection6 = [SQL_STORE_ROW, SQL_LICENSE_ROW, SQL_POPUP_FLAG_ROW].map((s) => rowJson(s));

  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2LiffFreshAuthority活動');
      const loc = await makeLocation(base, 'RC2LiffFreshAuthority地點');

      // 基準失敗 body：不存在的 token。所有拒絕案例都必須與它 byte-identical。
      {
        const r = await callLiff(base, 'nonexistent-token-canonical-failure');
        assert(r.status === 404 && JSON.stringify(r.json) === LIFF_UNIFIED_BODY, '6-liff-canonical-failure-body 不存在的 token → 404 且 body 恰為統一契約 {success:false,reason:liff_config_unavailable}（其他案例的 byte-identical 比對基準）', JSON.stringify(r));
      }

      // watch(session) → [[sql, params], ...]：注入會改動的狀態，注入前現場讀取、finally 後必須還原一致。
      // inject(session)：注入（一律發生在 token 建立之後、liff-config 呼叫之前）。
      // restore(session, originals)：originals 為注入前現場讀到的整列（已 JSON.parse）。
      async function liffRejectCase(label, { watch, inject, restore, verifyAcceptedAfterRestore }) {
        const session = await makeSession(base, camp.id, loc.id);
        const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'U' + label, pageType: 'popup_order', popupSessionPublicCode: session.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
        if (!created.ok) throw new Error(`liffRejectCase(${label}): token creation failed before injection: ${JSON.stringify(created)}`);
        const tokenBefore = tokenRowFull(created.token);

        // 正向對照：注入前同一個 token 必須能拿到 liff_id，證明後面的 404 確實來自注入，而不是別的原因。
        const ctl = await callLiff(base, created.token);
        assert(ctl.status === 200 && ctl.json.success === true && ctl.json.data && ctl.json.data.liff_id === 'popup-liff-rc2', `6-liff-fresh-${label}-positive-control ${label}：注入前同一個 token 的 liff-config 成功並回傳 liff_id（證明後續 404 來自注入）`, JSON.stringify(ctl));

        const specs = watch(session);
        const originals = specs.map(snap);
        try {
          await inject(session);
          const injectedNow = specs.map(snap);
          assert(injectedNow.some((v, i) => v !== originals[i]), `6-liff-fresh-${label}-injected ${label}：注入確實改變了被監看的 DB 狀態（非空轉）`, JSON.stringify({ originals, injectedNow }));

          const r = await callLiff(base, created.token);
          assert(r.status === 404 && r.json.success === false && r.json.reason === 'liff_config_unavailable' && JSON.stringify(r.json) === LIFF_UNIFIED_BODY, `6-liff-fresh-${label} ${label} 時 liff-config 回統一 404 liff_config_unavailable（body 與「不存在 token」byte-identical）`, JSON.stringify(r));

          const u = tokenUnchanged(created.token, tokenBefore, session.public_code);
          assert(u.same, `6-liff-fresh-${label}-token-unchanged ${label} 被拒絕後 token 整列與拒絕前完全相同（逐欄位明確比對 status=bound、opened_at、consumed_at、expires_at、popup_session_public_code，並仍綁定原場次代碼）`, u.detail);
        } finally {
          await restore(session, originals.map((o) => JSON.parse(o)));
          const restoredNow = specs.map(snap);
          assert(restoredNow.every((v, i) => v === originals[i]), `6-liff-fresh-${label}-restored-exactly ${label}：finally 已依「注入前現場讀到的原始值」精確還原（監看的 DB 狀態與注入前逐字相同）`, JSON.stringify({ originals, restoredNow }));
          if (verifyAcceptedAfterRestore) {
            const back = await callLiff(base, created.token);
            assert(back.status === 200 && back.json.success === true && back.json.data && back.json.data.liff_id === 'popup-liff-rc2', `6-liff-fresh-${label}-accepted-after-restore ${label}：還原後同一個 token 的 liff-config 再度成功（還原真的讓場次恢復可用，且 fixture 沒有殘留污染）`, JSON.stringify(back));
          }
        }
      }

      await liffRejectCase('license-inactive', {
        watch: () => [[SQL_LICENSE_ROW]],
        inject: () => injectSql("UPDATE licenses SET active=0 WHERE store_id='store_001'", [], 'license-inactive'),
        restore: (_s, orig) => injectSql("UPDATE licenses SET active=? WHERE store_id='store_001'", [orig[0].active], 'license-inactive-restore'),
      });

      // 真正的 store-inactive：注意欄位是 store_id（stores.id 是整數主鍵）。
      await liffRejectCase('store-inactive', {
        watch: () => [[SQL_STORE_ROW]],
        inject: () => injectSql("UPDATE stores SET active=0 WHERE store_id='store_001'", [], 'store-inactive'),
        restore: (_s, orig) => injectSql("UPDATE stores SET active=? WHERE store_id='store_001'", [orig[0].active], 'store-inactive-restore'),
      });

      await liffRejectCase('line-order-off', {
        watch: () => [[SQL_LICENSE_ROW]],
        inject: () => {
          const lic = db.get("SELECT features FROM licenses WHERE store_id='store_001'");
          const f = JSON.parse(lic.features); f.line_order = false;
          injectSql("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)], 'line-order-off');
        },
        restore: (_s, orig) => injectSql("UPDATE licenses SET features=? WHERE store_id='store_001'", [orig[0].features], 'line-order-off-restore'),
      });

      await liffRejectCase('popup-flag-off', {
        watch: () => [[SQL_POPUP_FLAG_ROW]],
        inject: () => injectSql("UPDATE settings SET value='0' WHERE store_id='store_001' AND key='popup_pickup_enabled'", [], 'popup-flag-off'),
        restore: (_s, orig) => injectSql("UPDATE settings SET value=? WHERE store_id='store_001' AND key='popup_pickup_enabled'", [orig[0].value], 'popup-flag-off-restore'),
      });

      // session-draft／campaign-draft 透過 admin API 注入；監看的是 status 欄位（revision/updated_at 依設計會被 API 更新）。
      await liffRejectCase('session-draft', {
        watch: (session) => [['SELECT status FROM popup_sessions WHERE id=? AND store_id=?', [session.id, 'store_001']]],
        inject: async (session) => {
          const p = await call(base, 'PATCH', `/api/popup-pickup/sessions/${session.id}`, { token: T1, body: { expected_revision: session.revision, status: 'draft' } });
          if (p.status !== 200) throw new Error('session-draft injection PATCH failed: ' + JSON.stringify(p));
        },
        restore: async (session, orig) => {
          const fresh = await call(base, 'GET', `/api/popup-pickup/sessions/${session.id}`, { token: T1 });
          const p = await call(base, 'PATCH', `/api/popup-pickup/sessions/${session.id}`, { token: T1, body: { expected_revision: fresh.json.data.revision, status: orig[0].status } });
          if (p.status !== 200) throw new Error('session-draft restore PATCH failed: ' + JSON.stringify(p));
        },
      });

      await liffRejectCase('campaign-draft', {
        watch: () => [['SELECT status FROM popup_campaigns WHERE id=? AND store_id=?', [camp.id, 'store_001']]],
        inject: async () => {
          const p = await call(base, 'PATCH', `/api/popup-pickup/campaigns/${camp.id}`, { token: T1, body: { status: 'draft' } });
          if (p.status !== 200) throw new Error('campaign-draft injection PATCH failed: ' + JSON.stringify(p));
        },
        restore: async (_s, orig) => {
          const p = await call(base, 'PATCH', `/api/popup-pickup/campaigns/${camp.id}`, { token: T1, body: { status: orig[0].status } });
          if (p.status !== 200) throw new Error('campaign-draft restore PATCH failed: ' + JSON.stringify(p));
        },
      });

      // RC2.1 補齊：token 建立「之後」場次被正式 API 刪除（DELETE /api/popup-pickup/sessions/:id）——
      // 也就是 liff-config 被呼叫時，token 綁定的場次代碼已經完全無法解析（nonexistent session 走到
      // liff-config 路徑）。場次沒有訂單/份數配額，API 允許刪除。還原＝依注入前現場 snapshot 的整列
      // 重新 INSERT（每一列都經 injectSql 檢查 getRowsModified()===1），再以整列 byte-identical 比對
      // 及「還原後 liff-config 再度 200」雙重驗證。
      await liffRejectCase('session-deleted', {
        watch: (session) => [
          ['SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [session.id, 'store_001']],
          ['SELECT * FROM popup_session_products WHERE session_id=? AND store_id=? ORDER BY id', [session.id, 'store_001'], 'all'],
        ],
        inject: async (session) => {
          const d = await call(base, 'DELETE', `/api/popup-pickup/sessions/${session.id}`, { token: T1 });
          if (d.status !== 200 || d.json.success !== true) throw new Error('session-deleted injection DELETE failed: ' + JSON.stringify(d));
        },
        restore: (session, orig) => {
          const [sessRow, prodRows] = orig;
          if (!sessRow) throw new Error('session-deleted restore: original session row snapshot missing');
          if (db.get('SELECT id FROM popup_sessions WHERE id=? AND store_id=?', [session.id, 'store_001'])) return; // 注入其實沒生效（例如 DELETE 被拒）→ 沒有東西需要還原
          reinsertRow('popup_sessions', sessRow);
          for (const pr of prodRows) reinsertRow('popup_session_products', pr);
        },
        verifyAcceptedAfterRestore: true,
      });

      // 以下兩個不是「state injection」：
      //  - token 建立階段就被拒絕：liff-config 根本不會被呼叫到，因此不是 liff-config 路徑的覆蓋。
      //  - standard page type：token 本身的 page type 不對，不需要任何注入。
      {
        const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Unonexistent', pageType: 'popup_order', popupSessionPublicCode: 'nonexistent-session-code-xyz-force', cartQtyItems: [{ product_id: 1, qty: 1 }] });
        assert(created.ok === false, '6-creation-refused-session-nonexistent 場次代碼根本不存在時，popup_order token 建立本身就被拒絕（注意：這是建立階段的拒絕，liff-config 不會被呼叫，不算 liff-config 路徑覆蓋）', JSON.stringify(created));
      }
      {
        const stdCreated = createRecoveryResumeToken(db, 'store_001', { cartId: 'std-cart-rc2', lineUserId: 'UstdPageType', pageType: 'line_order', cartQtyItems: [{ product_id: 1, qty: 1 }] });
        if (!stdCreated.ok) throw new Error('standard page type token creation failed: ' + JSON.stringify(stdCreated));
        const tokenBefore = tokenRowFull(stdCreated.token);
        const r = await callLiff(base, stdCreated.token);
        assert(r.status === 404 && r.json.reason === 'liff_config_unavailable' && JSON.stringify(r.json) === LIFF_UNIFIED_BODY, '6-liff-fresh-standard-page-type token 是 standard line_order page type 時，liff-config 回統一 404（liff-config 只服務 popup_order；body 與不存在 token byte-identical）', JSON.stringify(r));
        const u = tokenUnchanged(stdCreated.token, tokenBefore);
        assert(u.same, '6-liff-fresh-standard-page-type-token-unchanged standard page type token 被拒絕後整列完全未變（逐欄位明確比對 status=bound、opened_at、consumed_at、expires_at、popup_session_public_code）', u.detail);
      }

      const authorityAfterSection6 = [SQL_STORE_ROW, SQL_LICENSE_ROW, SQL_POPUP_FLAG_ROW].map((s) => rowJson(s));
      assert(JSON.stringify(authorityAfterSection6) === JSON.stringify(authorityBeforeSection6), '6-authority-state-restored-after-all-cases 全部案例結束後，stores/licenses/settings(popup_pickup_enabled) 三個授權來源的整列與第六節開始前現場記錄的完全一致', JSON.stringify({ before: authorityBeforeSection6, after: authorityAfterSection6 }));
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 六之二、fresh-read 行為證據：enabled → disabled → enabled，且 featureGate 快取被
  // 「刻意預熱成過期值」——不是靠讀程式碼 grep。
  //
  // middleware/featureGate.js 的 getStoreLicense() 有 30 秒 TTL 快取（licenses.active／
  // features）。三階段：
  //   E1  DB=啟用；快取預熱成「啟用」→ liff-config 成功（200 + liff_id）。
  //   D   DB 改成停用，且「不」清快取；先直接呼叫 getStoreLicense() 證明快取此刻仍回「啟用」
  //       （= 若 liff-config 走快取就會被騙而放行）→ liff-config 仍必須回統一 404。
  //   E2  反方向：清快取後在 DB=停用時預熱成「停用」，再把 DB 改回啟用且「不」清快取；
  //       先證明 getStoreLicense() 此刻仍回「停用」→ liff-config 仍必須成功（200 + liff_id）。
  // D 證明「不會因快取而誤放行」，E2 證明「不會因快取而誤拒絕」；兩個方向都成立才叫 fresh-read。
  // store-active 維度：featureGate 完全不讀 stores.active，因此不做快取斷言，只驗證同一個
  // E1→D→E2 序列（liff-config 對 stores.active 是即時讀取）。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2FreshReadTriState活動');
      const loc = await makeLocation(base, 'RC2FreshReadTriState地點');
      const licEnabledView = (l) => !!l && l.active === true && l.features && l.features.line_order === true;

      async function triStateCase(label, { cached, watchSql, disable, restore, cacheShowsDisabled }) {
        invalidateFeatureCache('store_001'); // makeSession 走 admin API（requireFeature 快取），先清乾淨
        const session = await makeSession(base, camp.id, loc.id);
        const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Utri' + label, pageType: 'popup_order', popupSessionPublicCode: session.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
        if (!created.ok) throw new Error(`triStateCase(${label}): token creation failed: ${JSON.stringify(created)}`);
        const tokenBefore = tokenRowFull(created.token);
        const original = rowJson(watchSql);
        const P = `6b-fresh-read-${label}`;
        try {
          // ── E1：DB 啟用，快取預熱成「啟用」 ──
          invalidateFeatureCache('store_001');
          const primedEnabled = getStoreLicense('store_001');
          if (cached) assert(licEnabledView(primedEnabled), `${P}-E1-cache-primed-enabled 預熱後 featureGate 快取為「啟用」`, JSON.stringify(primedEnabled));
          const r1 = await callLiff(base, created.token);
          assert(r1.status === 200 && r1.json.success === true && r1.json.data && r1.json.data.liff_id === 'popup-liff-rc2', `${P}-E1-enabled ${label} 啟用時 liff-config 成功回傳 liff_id`, JSON.stringify(r1));

          // ── D：DB 停用，快取「不清」 ──
          disable();
          if (cached) {
            const stale = getStoreLicense('store_001');
            assert(licEnabledView(stale), `${P}-D-cache-stale-proof DB 已停用但 featureGate 快取仍回「啟用」（證明快取確實過期、若被採用就會誤放行）`, JSON.stringify(stale));
          }
          const r2 = await callLiff(base, created.token);
          assert(r2.status === 404 && JSON.stringify(r2.json) === LIFF_UNIFIED_BODY, `${P}-D-disabled-rejected-despite-stale-cache ${label} 停用時 liff-config 仍回統一 404（未被過期快取誤導）`, JSON.stringify(r2));

          // ── E2：反方向。先讓快取記住「停用」，再把 DB 改回啟用、快取不清 ──
          if (cached) {
            invalidateFeatureCache('store_001');
            const primedDisabled = getStoreLicense('store_001');
            assert(cacheShowsDisabled(primedDisabled), `${P}-E2-cache-primed-disabled DB 停用期間預熱後 featureGate 快取為「停用」`, JSON.stringify(primedDisabled));
          }
          restore(JSON.parse(original)); // 依現場讀到的原始值還原（DB 重新啟用），刻意不清快取
          if (cached) {
            const stale2 = getStoreLicense('store_001');
            assert(cacheShowsDisabled(stale2), `${P}-E2-cache-stale-proof DB 已改回啟用但 featureGate 快取仍回「停用」（證明快取確實過期、若被採用就會誤拒絕）`, JSON.stringify(stale2));
          }
          const r3 = await callLiff(base, created.token);
          assert(r3.status === 200 && r3.json.success === true && r3.json.data && r3.json.data.liff_id === 'popup-liff-rc2', `${P}-E2-reenabled-accepted-despite-stale-cache ${label} 重新啟用後 liff-config 成功回傳 liff_id（未被過期快取誤導）`, JSON.stringify(r3));

          const u = tokenUnchanged(created.token, tokenBefore, session.public_code);
          assert(u.same, `${P}-token-unchanged 三次 liff-config 呼叫（成功/拒絕/成功）後 token 整列完全未變（liff-config 為唯讀）`, u.detail);
        } finally {
          restore(JSON.parse(original));
          invalidateFeatureCache('store_001');
          assert(rowJson(watchSql) === original, `${P}-restored-exactly ${label}：finally 已依原始值精確還原（整列 byte-identical）並清除 featureGate 快取`, JSON.stringify({ original, now: rowJson(watchSql) }));
        }
      }

      await triStateCase('license-active', {
        cached: true,
        watchSql: SQL_LICENSE_ROW,
        disable: () => injectSql("UPDATE licenses SET active=0 WHERE store_id='store_001'", [], 'tri-license-disable'),
        restore: (o) => injectSql("UPDATE licenses SET active=? WHERE store_id='store_001'", [o.active], 'tri-license-restore'),
        cacheShowsDisabled: (l) => !!l && l.active === false,
      });

      await triStateCase('line-order-feature', {
        cached: true,
        watchSql: SQL_LICENSE_ROW,
        disable: () => {
          const lic = db.get("SELECT features FROM licenses WHERE store_id='store_001'");
          const f = JSON.parse(lic.features); f.line_order = false;
          injectSql("UPDATE licenses SET features=? WHERE store_id='store_001'", [JSON.stringify(f)], 'tri-feature-disable');
        },
        restore: (o) => injectSql("UPDATE licenses SET features=? WHERE store_id='store_001'", [o.features], 'tri-feature-restore'),
        cacheShowsDisabled: (l) => !!l && !!l.features && l.features.line_order === false,
      });

      await triStateCase('store-active', {
        cached: false,
        watchSql: SQL_STORE_ROW,
        disable: () => injectSql("UPDATE stores SET active=0 WHERE store_id='store_001'", [], 'tri-store-disable'),
        restore: (o) => injectSql("UPDATE stores SET active=? WHERE store_id='store_001'", [o.active], 'tri-store-restore'),
        cacheShowsDisabled: () => false,
      });
    } finally { await new Promise((r) => server.close(r)); }
  }

  // ══════════════════════════════════════════════════════════════
  // 七、commit transaction affected-rows 防禦（沿用 cart-integration.js 已有的一組，這裡再驗證一次跨檔案一致）。
  // ══════════════════════════════════════════════════════════════
  {
    const { server, base } = await startServer(false);
    try {
      const camp = await makeCampaign(base, 'RC2CommitAffectedRows活動');
      const loc = await makeLocation(base, 'RC2CommitAffectedRows地點');
      const session = await makeSession(base, camp.id, loc.id);
      const { resolveRecoveryTargetForVerifiedMember } = require('../utils/lineCheckoutHandoff');
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UaffectedRows2', pageType: 'popup_order', popupSessionPublicCode: session.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UaffectedRows2' });
      resolveRecoveryTargetForVerifiedMember(db, created.token, ms);
      const prep = await call(base, 'POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: created.token, member_session: ms, popup_session_public_code: session.public_code } });
      // 在 commit 之前，直接把 token 狀態改成 consumed（模擬另一條路徑已經消費過）。
      db._db.run("UPDATE line_cart_handoff_tokens SET status='consumed' WHERE token=?", [created.token]);
      db._save();
      const commit = await call(base, 'POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: ms, popup_session_public_code: session.public_code } });
      assert(commit.status === 401, '7-commit-token-already-consumed-elsewhere token 在 commit 之前已經被別的途徑轉成 consumed，commit 正確拒絕（不會二次 consume 或誤判成功）', JSON.stringify(commit));
    } finally { await new Promise((r) => server.close(r)); }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
