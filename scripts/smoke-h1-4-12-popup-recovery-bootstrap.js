#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-bootstrap.js
// H1.4.12 Phase 3B — Popup Recovery LIFF Member Bootstrap, real HTTP/DB.
//
// Real Express app + real ephemeral sql.js DB + real token rows + real
// createMemberSession/verifyMemberSession + real verifyLineIdToken() code
// path. The ONLY thing stubbed is the actual outbound network call to
// LINE's official verify endpoint (https://api.line.me/oauth2/v2.1/verify)
// — a transport seam, not a shortcut around request construction or
// response validation: the real body (id_token + client_id derived from
// the store's line_member_login_channel_id setting) is sent, and the real
// aud/exp/sub checks in utils/lineMemberAuth.js run against whatever this
// fixture returns.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// ── Transport seam：utils/lineMemberAuth.js 用的是 `require('node-fetch')`
// （不是全域 fetch），必須在它第一次被載入前，把 node-fetch 這個模組本身
// 換成一個 wrapper——對 LINE 官方 verify endpoint 的請求導去我們的
// fixture，其餘 URL 原封不動轉給真正的 node-fetch。這是唯一需要動的
// transport 邊界，request 組裝（channel_id/id_token）與 response 驗證
// （aud/exp/sub）全部是 utils/lineMemberAuth.js 裡真正在跑的程式碼。
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const nodeFetchPath = require.resolve('node-fetch');
const realNodeFetch = require(nodeFetchPath);
const verifyRequestsSeen = [];
const fixtureTokens = new Map();
function registerFixtureToken(idToken, { aud, sub, expiresInSec = 3600 }) {
  fixtureTokens.set(idToken, { aud, sub, exp: Math.floor(Date.now() / 1000) + expiresInSec });
}
function stubbedNodeFetch(url, init) {
  if (String(url) === LINE_VERIFY_URL) {
    const bodyStr = (init && init.body) ? String(init.body) : '';
    const params = new URLSearchParams(bodyStr);
    const idToken = params.get('id_token');
    const clientId = params.get('client_id');
    verifyRequestsSeen.push({ idToken, clientId });
    const fixture = fixtureTokens.get(idToken);
    if (!fixture) {
      return Promise.resolve({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_request', error_description: 'unknown fixture token' }) });
    }
    return Promise.resolve({
      ok: true, status: 200,
      text: async () => JSON.stringify({ aud: fixture.aud, sub: fixture.sub, exp: fixture.exp, iss: 'https://access.line.me', iat: Math.floor(Date.now() / 1000) - 10 }),
    });
  }
  return realNodeFetch(url, init);
}
require.cache[nodeFetchPath].exports = stubbedNodeFetch;

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup recovery LIFF bootstrap REAL HTTP/DB (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3b-bootstrap-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3b-bootstrap';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;

  try {
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`, ['store_001', '脆豬腰', 'pro', 1, features]);
    db._db.run(`INSERT OR REPLACE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_002', 'Store Two', 'Manager2', 'pro', 1]);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`, ['store_002', 'Store Two', 'pro', 1, features]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'line_member_login_channel_id', 'channel-store-001')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'line_popup_liff_id', 'popup-liff-store-001')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_002', 'popup_pickup_enabled', '1')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_002', 'line_member_login_channel_id', 'channel-store-002')");
    db._save();

    const jwt = require('jsonwebtoken');
    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
    app.use('/api/cart-recovery', require('../routes/cart-recovery-bootstrap'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    async function call(method, urlPath, { token, body } = {}) {
      const res = await fetch(`${base}${urlPath}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const T1 = tokenFor('store_001');
    const T2 = tokenFor('store_002');

    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    function taipeiDateStr(offsetDays = 0) {
      const shifted = new Date(Date.now() + TAIPEI_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
    }
    async function makeCampaign(token, name) {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token, body: { name } });
      await call('PATCH', `/api/popup-pickup/campaigns/${r.json.data.id}`, { token, body: { status: 'published' } });
      return r.json.data;
    }
    async function makeLocation(token, name) {
      const r = await call('POST', '/api/popup-pickup/locations', { token, body: { name, address: name + ' Addr', lat: 25, lng: 121 } });
      return r.json.data;
    }
    async function makeSession(token, campaignId, locationId, overrides = {}) {
      const body = {
        campaign_id: campaignId, name: 'BootstrapTest場次', location_id: locationId, product_scope: 'all_takeout',
        pickup_date: taipeiDateStr(2), pickup_start_time: '10:00', pickup_end_time: '20:00',
        order_open_at: `${taipeiDateStr(0)}T00:00`, order_cutoff_at: `${taipeiDateStr(2)}T09:00`,
        ...overrides,
      };
      const r = await call('POST', '/api/popup-pickup/sessions', { token, body });
      if (r.status !== 201) throw new Error('makeSession failed: ' + JSON.stringify(r));
      if (!overrides.status) await call('PATCH', `/api/popup-pickup/sessions/${r.json.data.id}`, { token, body: { expected_revision: r.json.data.revision, status: 'published' } });
      const fresh = await call('GET', `/api/popup-pickup/sessions/${r.json.data.id}`, { token });
      return fresh.json.data;
    }
    const camp1 = await makeCampaign(T1, 'BootstrapTest活動1');
    const loc1 = await makeLocation(T1, 'BootstrapTest地點1');
    const sessionA = await makeSession(T1, camp1.id, loc1.id);
    const camp2 = await makeCampaign(T2, 'BootstrapTest活動2');
    const loc2 = await makeLocation(T2, 'BootstrapTest地點2');
    const sessionStore2 = await makeSession(T2, camp2.id, loc2.id);

    const { createRecoveryResumeToken } = require('../utils/lineCheckoutHandoff');
    const { verifyMemberSession } = require('../utils/lineMemberSession');
    function tokenRow(token) { return db.get('SELECT status, opened_at, consumed_at FROM line_cart_handoff_tokens WHERE token=?', [token]); }

    // ══════════════════════════════════════════════════════════════
    // 一、真實 bootstrap-member：合法 LINE credential → 建立可信 member_session
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uverified1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-good-1', { aud: 'channel-store-001', sub: 'Uverified1' });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-good-1' } });
      assert(r.status === 200 && r.json.success === true, '1-bootstrap-success 合法 LINE credential 成功建立 member_session', JSON.stringify(r));
      assert(typeof r.json.data.member_session === 'string' && r.json.data.member_session.length > 0, '1-bootstrap-returns-session 回傳的 member_session 是非空字串', JSON.stringify(r.json));
      assert(!('store_id' in r.json.data) && !('line_user_id' in r.json.data), '1-bootstrap-no-leak response 不含 store_id/line_user_id', JSON.stringify(r.json));
      const verifiedUid = verifyMemberSession(r.json.data.member_session, 'store_001');
      assert(verifiedUid === 'Uverified1', '1-bootstrap-session-verifiable 回傳的 member_session 可被既有 verifyMemberSession() 正確驗證回同一個 LINE user', String(verifiedUid));
      const row = tokenRow(created.token);
      assert(row.status === 'bound' && (row.opened_at === '' || row.opened_at === null) && (row.consumed_at === '' || row.consumed_at === null), '1-bootstrap-no-state-change bootstrap 完全不改變 token 狀態（仍是 bound，opened_at/consumed_at 都空白）', JSON.stringify(row));
      assert(verifyRequestsSeen[verifyRequestsSeen.length - 1].clientId === 'channel-store-001', '1-bootstrap-correct-channel 送給 LINE 官方 verify API 的 client_id 正確對應到 store_001 的設定', JSON.stringify(verifyRequestsSeen[verifyRequestsSeen.length - 1]));
    }

    // ══════════════════════════════════════════════════════════════
    // 二、跨店 credential 拒絕：token 屬於 store_001，但 credential 的 aud 是 store_002 的 channel。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Ucross1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-wrong-channel', { aud: 'channel-store-002', sub: 'Ucross1' });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-wrong-channel' } });
      assert(r.status === 401 && r.json.success === false, '2-cross-channel-rejected credential 的 channel 跟 token 所屬 store 的 channel 不符時拒絕', JSON.stringify(r));
      const row = tokenRow(created.token);
      assert(row.status === 'bound', '2-cross-channel-no-state-change 失敗嘗試不改變 token 狀態', JSON.stringify(row));
    }

    // ══════════════════════════════════════════════════════════════
    // 三、過期 credential 拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uexpiredcred', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-expired', { aud: 'channel-store-001', sub: 'Uexpiredcred', expiresInSec: -3600 });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-expired' } });
      assert(r.status === 401 && r.json.success === false, '3-expired-credential-rejected 過期的 LINE credential 被拒絕', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 四、無效／不存在的 credential（LINE API 回 400）拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uinvalidcred', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-never-registered' } });
      assert(r.status === 401 && r.json.success === false, '4-invalid-credential-rejected LINE API 本身拒絕的 credential（未註冊過的假 token）被拒絕', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 五、client 偽造欄位完全無效：夾帶 store_id/line_user_id/page_type 等。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uforge1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-forge-test', { aud: 'channel-store-001', sub: 'Uforge1' });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', {
        body: { recovery_token: created.token, line_id_token: 'idtok-forge-test', store_id: 'store_002', line_user_id: 'Uattacker', page_type: 'line_order' },
      });
      assert(r.status === 200 && r.json.success === true, '5-forged-fields-ignored 偽造欄位被完全忽略，bootstrap 仍依真正的 token/credential 成功', JSON.stringify(r));
      const verifiedUid = verifyMemberSession(r.json.data.member_session, 'store_001');
      assert(verifiedUid === 'Uforge1', '5-forged-fields-real-identity-used 簽發的 member_session 綁定的是真正驗證出的 LINE user（Uforge1），不是偽造的 Uattacker', String(verifiedUid));
    }

    // ══════════════════════════════════════════════════════════════
    // 六、consumed/cancelled/expired token 不可 bootstrap。
    // ══════════════════════════════════════════════════════════════
    {
      const { consumeRecoveryToken, cancelRecoveryToken } = require('../utils/lineCheckoutHandoff');
      const c1 = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uc1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      consumeRecoveryToken(db, 'store_001', c1.token);
      registerFixtureToken('idtok-c1', { aud: 'channel-store-001', sub: 'Uc1' });
      const r1 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: c1.token, line_id_token: 'idtok-c1' } });
      assert(r1.status === 401, '6-consumed-token-rejected consumed token 無法 bootstrap', JSON.stringify(r1));

      const c2 = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uc2', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      cancelRecoveryToken(db, 'store_001', c2.token);
      registerFixtureToken('idtok-c2', { aud: 'channel-store-001', sub: 'Uc2' });
      const r2 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: c2.token, line_id_token: 'idtok-c2' } });
      assert(r2.status === 401, '6-cancelled-token-rejected cancelled token 無法 bootstrap', JSON.stringify(r2));

      const c3 = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uc3', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      db._db.run("UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?", [c3.token]);
      db._save();
      registerFixtureToken('idtok-c3', { aud: 'channel-store-001', sub: 'Uc3' });
      const r3 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: c3.token, line_id_token: 'idtok-c3' } });
      assert(r3.status === 401, '6-expired-token-rejected expired token 無法 bootstrap', JSON.stringify(r3));
    }

    // ══════════════════════════════════════════════════════════════
    // 七、popup session 在 bootstrap 前被下架／draft 時拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const draftSession = await makeSession(T1, camp1.id, loc1.id);
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Udraft1', pageType: 'popup_order', popupSessionPublicCode: draftSession.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      await call('PATCH', `/api/popup-pickup/sessions/${draftSession.id}`, { token: T1, body: { expected_revision: draftSession.revision, status: 'draft' } });
      registerFixtureToken('idtok-draft1', { aud: 'channel-store-001', sub: 'Udraft1' });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-draft1' } });
      assert(r.status === 401, '7-draft-session-rejected 場次在 bootstrap 前被下架時拒絕', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 八、bootstrap 重試不 consume；bootstrap 成功後 resolve-target 才
    // bound→opened，兩者狀態轉移正確分工。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uretry1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-retry1', { aud: 'channel-store-001', sub: 'Uretry1' });
      const r1 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-retry1' } });
      assert(r1.status === 200, '8-bootstrap-first-call 第一次 bootstrap 成功', JSON.stringify(r1));
      assert(tokenRow(created.token).status === 'bound', '8-bootstrap-first-call-still-bound bootstrap 後仍是 bound', JSON.stringify(tokenRow(created.token)));
      // 模擬「navigation 失敗，使用者重試 bootstrap」：同一個 token 再 bootstrap 一次。
      const r2 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-retry1' } });
      assert(r2.status === 200, '8-bootstrap-retry-succeeds bootstrap 可以安全重試（不因為已經 bootstrap 過一次就失敗）', JSON.stringify(r2));
      assert(tokenRow(created.token).status === 'bound', '8-bootstrap-retry-still-bound 重試後仍是 bound、沒有被消費', JSON.stringify(tokenRow(created.token)));
      // 現在真正呼叫 resolve-target，這才會轉成 opened。
      const resolveRes = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: created.token, member_session: r2.json.data.member_session } });
      assert(resolveRes.status === 200 && resolveRes.json.success === true, '8-resolve-target-succeeds resolve-target 用 bootstrap 拿到的 member_session 成功', JSON.stringify(resolveRes));
      const afterResolve = tokenRow(created.token);
      assert(afterResolve.status === 'opened' && (afterResolve.consumed_at === '' || afterResolve.consumed_at === null), '8-only-resolve-target-transitions-to-opened 只有 resolve-target 才把狀態轉成 opened，consumed_at 仍空白', JSON.stringify(afterResolve));
      // bootstrap 在已經 opened 之後仍可再重試（例如使用者重新整理 landing 頁）。
      const r3 = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-retry1' } });
      assert(r3.status === 200, '8-bootstrap-after-opened-still-works opened 狀態下 bootstrap 仍可成功（不因為已經 opened 過而卡住合法重試）', JSON.stringify(r3));
    }

    // ══════════════════════════════════════════════════════════════
    // 九、popup session 在 bootstrap 與 resolve 之間被下架時，resolve 仍拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const midSession = await makeSession(T1, camp1.id, loc1.id);
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Umid1', pageType: 'popup_order', popupSessionPublicCode: midSession.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-mid1', { aud: 'channel-store-001', sub: 'Umid1' });
      const bootstrapRes = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-mid1' } });
      assert(bootstrapRes.status === 200, '9-bootstrap-before-disable bootstrap 在場次下架前成功', JSON.stringify(bootstrapRes));
      await call('PATCH', `/api/popup-pickup/sessions/${midSession.id}`, { token: T1, body: { expected_revision: midSession.revision, status: 'draft' } });
      const resolveRes = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: created.token, member_session: bootstrapRes.json.data.member_session } });
      assert(resolveRes.status === 200 && resolveRes.json.success === false, '9-resolve-after-disable-rejected bootstrap 之後、resolve 之前場次被下架，resolve 仍安全拒絕', JSON.stringify(resolveRes));
    }

    // ══════════════════════════════════════════════════════════════
    // 十、LIFF config discovery：只由 token 反查，不回傳 store_id。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Uliffcfg1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const r = await call('POST', '/api/cart-recovery/liff-config', { body: { recovery_token: created.token } });
      assert(r.status === 200 && r.json.success === true && r.json.data.liff_id === 'popup-liff-store-001', '10-liff-config-correct 正確回傳 token 所屬 store 設定的 popup 專用 LIFF ID', JSON.stringify(r));
      assert(!('store_id' in r.json.data), '10-liff-config-no-store-leak response 不含 store_id', JSON.stringify(r.json));
    }
    {
      // store_002 沒有設定 line_popup_liff_id，fail closed。
      const created = createRecoveryResumeToken(db, 'store_002', { lineUserId: 'Uliffcfg2', pageType: 'popup_order', popupSessionPublicCode: sessionStore2.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const r = await call('POST', '/api/cart-recovery/liff-config', { body: { recovery_token: created.token } });
      assert(r.status === 404 && r.json.success === false, '10-liff-config-missing-fail-closed 沒有設定 line_popup_liff_id 時 fail closed（不 fallback member LIFF ID）', JSON.stringify(r));
    }
    {
      const r = await call('POST', '/api/cart-recovery/liff-config', { body: { recovery_token: 'not-a-real-token' } });
      assert(r.status === 404 && r.json.success === false && r.json.reason === 'liff_config_unavailable', '10-liff-config-invalid-token-same-reason 不存在的 token 跟「缺少設定」用同一種不可枚舉錯誤', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 十一、跨店 token 不會被跨店使用：store_002 的 token 不能拿到 store_001 的資源。
    // ══════════════════════════════════════════════════════════════
    {
      const created = createRecoveryResumeToken(db, 'store_002', { lineUserId: 'Ustore2user', pageType: 'popup_order', popupSessionPublicCode: sessionStore2.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      registerFixtureToken('idtok-store2', { aud: 'channel-store-002', sub: 'Ustore2user' });
      const r = await call('POST', '/api/cart-recovery/bootstrap-member', { body: { recovery_token: created.token, line_id_token: 'idtok-store2' } });
      assert(r.status === 200, '11-store2-bootstrap-own-channel store_002 的 token 用 store_002 自己的 channel 驗證成功', JSON.stringify(r));
      const verifiedForStore1 = verifyMemberSession(r.json.data.member_session, 'store_001');
      assert(verifiedForStore1 === null, '11-store2-session-not-usable-for-store1 store_002 簽發的 member_session 無法被驗證成 store_001 的身分', String(verifiedForStore1));
    }
  } finally {
    require.cache[nodeFetchPath].exports = realNodeFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
