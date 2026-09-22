#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-cart-integration.js
// H1.4.12 Phase 3B — Popup Recovery Cart Restore/Reconcile, real HTTP/DB.
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
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup recovery cart restore REAL HTTP/DB (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3b-cart-restore-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3b-cart-restore';

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
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_002', 'popup_pickup_enabled', '1')");
    try { db._db.run('ALTER TABLE products ADD COLUMN line_takeout_enabled INTEGER DEFAULT 1'); } catch (e) {}
    db._save();

    const jwt = require('jsonwebtoken');
    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
    // 規格一（本輪）：production rate limit 維持真實的 30/min，不放寬。這個
    // 測試檔案本身會對 prepare/commit 發出遠超過 30 次的呼叫（這是測試涵蓋
    // 面廣，不是攻擊）——用「每個測試群組各自一份、彼此獨立的 router 實例」
    // 隔離 limiter 狀態（跟「每個真實使用者各自打自己的 IP／連線」是同一種
    // 隔離精神），而不是調整 production 門檻本身。每一份實例都是真正的
    // createPopupRestoreRouter()，跑的是同一套 production 程式碼與同一個
    // 30/min 門檻，只是彼此的 rateBucket Map 不共用。
    const { createPopupRestoreRouter, RATE_LIMIT_MAX: PROD_RATE_LIMIT_MAX } = require('../routes/cart-recovery-popup-restore');
    const RESTORE_GROUP_PREFIXES = ['/api/cart-recovery', '/api/cart-recovery-g2', '/api/cart-recovery-g3', '/api/cart-recovery-g4', '/api/cart-recovery-g5', '/api/cart-recovery-g6'];
    RESTORE_GROUP_PREFIXES.forEach((prefix) => { app.use(prefix, createPopupRestoreRouter()); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    // 每呼叫 25 次 prepare/commit 就換下一個隔離群組（30/min 門檻留一點
    // buffer），popup-pickup／popup-session／resolve-target 這些不受這個
    // limiter 影響的端點不會被重寫路徑。
    let restoreCallCount = 0;
    async function call(method, urlPath, { token, body } = {}) {
      let effectivePath = urlPath;
      if (urlPath.startsWith('/api/cart-recovery/prepare-popup-restore') || urlPath.startsWith('/api/cart-recovery/commit-popup-restore')) {
        const groupIndex = Math.floor(restoreCallCount / 25) % RESTORE_GROUP_PREFIXES.length;
        restoreCallCount += 1;
        effectivePath = urlPath.replace('/api/cart-recovery', RESTORE_GROUP_PREFIXES[groupIndex]);
      }
      const res = await fetch(`${base}${effectivePath}`, {
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
        campaign_id: campaignId, name: 'CartRestoreTest場次', location_id: locationId, product_scope: 'all_takeout',
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
    const camp1 = await makeCampaign(T1, 'CartRestore活動1');
    const loc1 = await makeLocation(T1, 'CartRestore地點1');
    const sessionA = await makeSession(T1, camp1.id, loc1.id);
    const camp2 = await makeCampaign(T2, 'CartRestore活動2');
    const loc2 = await makeLocation(T2, 'CartRestore地點2');
    const sessionStore2 = await makeSession(T2, camp2.id, loc2.id);

    // 場次自帶 demo seed 商品（id 1~12），可直接用來當 cart 內容。
    const { createRecoveryResumeToken, resolveRecoveryTargetForVerifiedMember } = require('../utils/lineCheckoutHandoff');
    const { createMemberSession, verifyMemberSession } = require('../utils/lineMemberSession');
    function tokenRow(rawToken) { return db.get('SELECT status, opened_at, consumed_at FROM line_cart_handoff_tokens WHERE token=?', [rawToken]); }
    function receiptRow(rawReceipt) {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(String(rawReceipt)).digest('hex');
      return db.get('SELECT * FROM popup_restore_receipts WHERE receipt_hash=?', [hash]);
    }

    // helper：建立一個「已經 opened」的 popup_order token，且 cart_json 帶有指定的 items（模擬「當初放進購物車時存下來的 snapshot」）。
    function makeOpenedTokenWithCart(storeId, lineUserId, sessionPublicCode, items) {
      const created = createRecoveryResumeToken(db, storeId, { lineUserId, pageType: 'popup_order', popupSessionPublicCode: sessionPublicCode, cartQtyItems: items });
      const ms = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
      const resolved = resolveRecoveryTargetForVerifiedMember(db, created.token, ms);
      if (!resolved.ok) throw new Error('resolve-target failed in fixture: ' + JSON.stringify(resolved));
      return { token: created.token, memberSession: ms };
    }

    // ══════════════════════════════════════════════════════════════
    // 一、Landing/bootstrap/resolve 後 token 為 opened（沿用上一輪已驗證的鏈路，這裡只驗證 fixture helper 本身正確）。
    // ══════════════════════════════════════════════════════════════
    {
      const { token } = makeOpenedTokenWithCart('store_001', 'Ucart1', sessionA.public_code, [{ product_id: 1, qty: 2 }]);
      assert(tokenRow(token).status === 'opened', '1-fixture-opened fixture helper 建出的 token 確實是 opened', JSON.stringify(tokenRow(token)));
    }

    // ══════════════════════════════════════════════════════════════
    // 二、Prepare 回 canonical cart，但 token 未 consumed。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart2', sessionA.public_code, [{ product_id: 1, qty: 2 }, { product_id: 2, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 200 && r.json.success === true, '2-prepare-success prepare 成功回傳 canonical cart', JSON.stringify(r));
      assert(Array.isArray(r.json.data.items) && r.json.data.items.length === 2, '2-prepare-items 回傳兩項商品', JSON.stringify(r.json.data.items));
      assert(typeof r.json.data.restore_receipt === 'string' && r.json.data.restore_receipt.length > 0, '2-prepare-receipt 回傳 restore_receipt', String(r.json.data.restore_receipt));
      assert(!('store_id' in r.json.data) && !JSON.stringify(r.json.data.items).includes('price'), '2-prepare-no-price-leak 回傳不含 store_id/price', JSON.stringify(r.json.data));
      const row = tokenRow(token);
      assert(row.status === 'opened' && (row.consumed_at === '' || row.consumed_at === null), '2-prepare-not-consumed prepare 後 token 仍是 opened、未 consumed', JSON.stringify(row));
    }

    // ══════════════════════════════════════════════════════════════
    // 三、Prepare 重試不 consume；重複 prepare 會 supersede 舊 receipt。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart3', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const r1 = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const r2 = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r1.status === 200 && r2.status === 200 && r1.json.data.restore_receipt !== r2.json.data.restore_receipt, '3-prepare-retry-new-receipt 重複 prepare 得到不同的新 receipt', JSON.stringify({ r1: r1.json.data.restore_receipt, r2: r2.json.data.restore_receipt }));
      assert(receiptRow(r1.json.data.restore_receipt).status === 'superseded', '3-prepare-retry-old-superseded 舊 receipt 被標成 superseded', JSON.stringify(receiptRow(r1.json.data.restore_receipt)));
      assert(receiptRow(r2.json.data.restore_receipt).status === 'prepared', '3-prepare-retry-new-prepared 新 receipt 是 prepared', JSON.stringify(receiptRow(r2.json.data.restore_receipt)));
      assert(tokenRow(token).status === 'opened', '3-prepare-retry-not-consumed 重複 prepare 沒有 consume token', JSON.stringify(tokenRow(token)));
    }

    // ══════════════════════════════════════════════════════════════
    // 四、Wrong member / wrong session 不改狀態；跨店資料無法恢復。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart4', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const wrongMs = createMemberSession({ store_id: 'store_001', line_user_id: 'Uattacker' });
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: wrongMs, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 401, '4-wrong-member-rejected 錯誤的 member_session 被拒絕', JSON.stringify(r));
      assert(tokenRow(token).status === 'opened', '4-wrong-member-no-state-change 錯誤嘗試不改變 token 狀態', JSON.stringify(tokenRow(token)));

      const r2 = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: 'totally-different-session' } });
      assert(r2.status === 401, '4-wrong-session-rejected 錯誤的 popup_session_public_code 被拒絕', JSON.stringify(r2));
      assert(tokenRow(token).status === 'opened', '4-wrong-session-no-state-change 錯誤嘗試不改變 token 狀態', JSON.stringify(tokenRow(token)));
    }
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_002', 'Ucart4b', sessionStore2.public_code, [{ product_id: 1, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 401, '4-cross-store-rejected store_002 的 token 帶 store_001 的場次代碼被拒絕', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 五、Draft/disabled session 拒絕；token expired/cancelled/consumed 拒絕。
    // ══════════════════════════════════════════════════════════════
    {
      const draftSession = await makeSession(T1, camp1.id, loc1.id);
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart5', draftSession.public_code, [{ product_id: 1, qty: 1 }]);
      await call('PATCH', `/api/popup-pickup/sessions/${draftSession.id}`, { token: T1, body: { expected_revision: draftSession.revision, status: 'draft' } });
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: draftSession.public_code } });
      assert(r.status === 401, '5-draft-session-rejected 場次已下架時 prepare 拒絕', JSON.stringify(r));
    }
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart6', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      db._db.run("UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?", [token]);
      db._save();
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 401, '5-expired-token-rejected expired token 無法 prepare', JSON.stringify(r));
    }
    {
      const { consumeRecoveryToken } = require('../utils/lineCheckoutHandoff');
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'Ucart7', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      consumeRecoveryToken(db, 'store_001', token);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 401, '5-consumed-token-rejected consumed token 無法 prepare', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // 六（本輪修正）：明確三態——invalid_snapshot（快照本身不可信，
    // fail closed 且不得顯示成「空購物車」）vs valid_empty_after_reconcile
    // （快照本身合法、只是 fresh authority 判定全部不可用）vs
    // valid_non_empty。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartBad1', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      db._db.run("UPDATE line_cart_handoff_tokens SET cart_json='{not valid json' WHERE token=?", [token]);
      db._save();
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 400 && r.json.success === false && r.json.reason === 'invalid_snapshot', '6-malformed-json-is-invalid-snapshot 損毀的 cart_json 回結構化 400 invalid_snapshot，不是空購物車', JSON.stringify(r));
      assert(!('items' in (r.json.data || {})), '6-malformed-json-no-items-field invalid_snapshot response 不含 items（不得讓前端誤判成合法空陣列）', JSON.stringify(r.json));
      assert(db.get("SELECT COUNT(*) as c FROM popup_restore_receipts WHERE token_id=(SELECT id FROM line_cart_handoff_tokens WHERE token=?)", [token]).c === 0, '6-malformed-json-no-receipt 沒有建立任何 receipt', 'n/a');
      assert(tokenRow(token).status === 'opened', '6-malformed-json-token-still-opened token 仍是 opened', JSON.stringify(tokenRow(token)));
    }
    {
      // qty=0/-1/1.5/NaN/Infinity/型別錯誤 → 整份快照不可信（不是逐項丟棄後回空陣列）。
      // 注意：createRecoveryResumeToken() 本身在建立時就會用 Number()+filter
      // 先做一次寬鬆清理（既有、非本輪範圍的既有行為），所以這裡直接改寫
      // DB 裡的 cart_json，真正模擬「儲存後的快照已經毀損／不可信」這個
      // 情境，而不是被創建時的寬鬆清理提早擋掉，導致測試沒測到真正要測的
      // 東西。
      const badCartJsonCases = [
        '{"items":[{"product_id":-1,"qty":1}]}',
        '{"items":[{"product_id":1,"qty":-5}]}',
        '{"items":[{"product_id":1.5,"qty":1}]}',
        '{"items":[{"product_id":1,"qty":0}]}',
        '{"items":[{"product_id":1,"qty":null}]}',
        '{"items":[{"product_id":1,"qty":1e309}]}',
        '{"items":[{"product_id":"1","qty":1}]}',
      ];
      for (let i = 0; i < badCartJsonCases.length; i++) {
        const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartBad2_' + i, sessionA.public_code, [{ product_id: 1, qty: 1 }]);
        db._db.run('UPDATE line_cart_handoff_tokens SET cart_json=? WHERE token=?', [badCartJsonCases[i], token]);
        db._save();
        const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
        assert(r.status === 400 && r.json.reason === 'invalid_snapshot', `6-unsafe-qty-${i}-invalid-snapshot 不安全的 product_id/qty（案例 ${i}：${badCartJsonCases[i]}）整份快照視為不可信`, JSON.stringify(r));
        assert(tokenRow(token).status === 'opened', `6-unsafe-qty-${i}-token-still-opened token 仍是 opened`, JSON.stringify(tokenRow(token)));
      }
    }
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartDup', sessionA.public_code, [{ product_id: 1, qty: 1 }, { product_id: 1, qty: 2 }, { product_id: 1, qty: 3 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const p1 = r.json.data.items.find((it) => it.product_id === 1);
      assert(r.status === 200 && r.json.data.cart_state === 'valid_non_empty' && r.json.data.items.length === 1 && p1 && p1.qty === 6, '6-duplicate-aggregated 重複 product_id 正確聚合成一筆（1+2+3=6），cart_state=valid_non_empty', JSON.stringify(r.json.data));
    }
    {
      // 聚合溢位（Number.MAX_SAFE_INTEGER 附近）→ invalid_snapshot。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartOverflow', sessionA.public_code, [{ product_id: 1, qty: Number.MAX_SAFE_INTEGER - 1 }, { product_id: 1, qty: 10 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 400 && r.json.reason === 'invalid_snapshot', '6-aggregate-overflow-invalid-snapshot 聚合溢位視為快照不可信', JSON.stringify(r));
    }
    {
      // 建立 55 個真實可用商品：raw snapshot 本身就超過 50 筆上限 → 整份 invalid_snapshot（不是靜默截斷成 50 筆 + removed_items）。
      for (let i = 1; i <= 55; i++) {
        db._db.run(`INSERT INTO products (store_id, name, category, price, enabled, show_on_line, line_takeout_enabled) VALUES ('store_001', ?, '主食', 50, 1, 1, 1)`, [`CapTest商品${i}`]);
      }
      db._save();
      const capProductIds = db.all("SELECT id FROM products WHERE store_id='store_001' AND name LIKE 'CapTest商品%'").map((r) => r.id);
      const manyItems = capProductIds.map((id) => ({ product_id: id, qty: 1 }));
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartMany', sessionA.public_code, manyItems);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 400 && r.json.reason === 'invalid_snapshot', '6-too-many-items-invalid-snapshot 原始快照超過 51 筆時，整份 prepare 失敗（不是靜默截斷）', JSON.stringify(r));
    }
    {
      // valid_empty_after_reconcile：快照本身合法（至少一筆合法項目），只是 fresh authority 判定全部不可用。
      db._db.run("UPDATE products SET enabled=0 WHERE id=3 AND store_id='store_001'");
      db._save();
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartEmptyAfter', sessionA.public_code, [{ product_id: 3, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 200 && r.json.success === true, '6-valid-empty-after-reconcile-success 快照本身合法、fresh 後全部失效時，prepare 仍成功（不是 400）', JSON.stringify(r));
      assert(r.json.data.cart_state === 'valid_empty_after_reconcile' && r.json.data.items.length === 0, '6-valid-empty-after-reconcile-state cart_state 明確標示 valid_empty_after_reconcile，不是跟 invalid_snapshot 混淆', JSON.stringify(r.json.data));
      assert(r.json.data.removed_items.length === 1 && r.json.data.removed_items[0].product_id === 3, '6-valid-empty-after-reconcile-removed-list 有 removed_items 記錄被移除的商品', JSON.stringify(r.json.data.removed_items));
      db._db.run("UPDATE products SET enabled=1 WHERE id=3 AND store_id='store_001'");
      db._save();
    }
    {
      // 兩者的 receipt 都必須真的建立（valid_empty_after_reconcile 也可以 commit——只是前端要先讓使用者明確確認）；invalid_snapshot 則完全不建立 receipt（上面已驗證過)。
      db._db.run("UPDATE products SET enabled=0 WHERE id=4 AND store_id='store_001'");
      db._save();
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartEmptyCommit', sessionA.public_code, [{ product_id: 4, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(prep.json.data.cart_state === 'valid_empty_after_reconcile', '6-empty-after-reconcile-has-receipt precondition：cart_state 正確', JSON.stringify(prep.json.data));
      const commit = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(commit.status === 200 && commit.json.success === true, '6-empty-after-reconcile-can-commit valid_empty_after_reconcile 在使用者確認後（前端邏輯）仍可正常 commit', JSON.stringify(commit));
      db._db.run("UPDATE products SET enabled=1 WHERE id=4 AND store_id='store_001'");
      db._save();
    }

    // ══════════════════════════════════════════════════════════════
    // 七、Selected scope quota 降低；all_takeout 商品停用移除；改價/改名顯示 fresh 值。
    // ══════════════════════════════════════════════════════════════
    {
      const selSession = await makeSession(T1, camp1.id, loc1.id, { product_scope: 'selected', products: [{ product_id: 1, quota_qty: 1 }] });
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartSel', selSession.public_code, [{ product_id: 1, qty: 5 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: selSession.public_code } });
      const p1 = r.json.data.items.find((it) => it.product_id === 1);
      assert(p1 && p1.qty === 1, '7-selected-quota-clamped selected scope quota_qty=1 時，要恢復的 qty=5 被縮減為 1', JSON.stringify(r.json.data));
      assert(r.json.data.removed_items.some((it) => it.product_id === 1 && it.reason === 'quota_reduced'), '7-selected-quota-reason removed_items 標示 quota_reduced', JSON.stringify(r.json.data.removed_items));
    }
    {
      db._db.run("UPDATE products SET enabled=0 WHERE id=2 AND store_id='store_001'");
      db._save();
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartDisabled', sessionA.public_code, [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(!r.json.data.items.some((it) => it.product_id === 2), '7-disabled-product-removed all_takeout 已停用的商品（product 2）從 canonical cart 移除', JSON.stringify(r.json.data.items));
      assert(r.json.data.removed_items.some((it) => it.product_id === 2 && it.reason === 'unavailable'), '7-disabled-product-reason removed_items 標示 unavailable', JSON.stringify(r.json.data.removed_items));
      db._db.run("UPDATE products SET enabled=1 WHERE id=2 AND store_id='store_001'");
      db._save();
    }
    {
      // 名稱/價格由 fresh session products 取得，不是 token snapshot——這裡確認 prepare 不回傳名稱/價格（前端拿 fresh popupProducts 顯示），只回 product_id+qty。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartFresh', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const p1 = r.json.data.items.find((it) => it.product_id === 1);
      assert(Object.keys(p1).sort().join(',') === 'product_id,qty', '7-items-shape-minimal canonical cart 每項只有 product_id/qty，名稱/價格由前端 fresh session 取得', JSON.stringify(p1));
    }

    // ══════════════════════════════════════════════════════════════
    // 八、Commit：只有 commit 把 token 轉 consumed，receipt 同步 consumed，原子性。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartCommit1', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const commit = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(commit.status === 200 && commit.json.success === true && commit.json.data.consumed === true, '8-commit-success commit 成功', JSON.stringify(commit));
      assert(!('store_id' in commit.json.data) && !('cart' in commit.json.data) && !('token' in commit.json.data), '8-commit-no-leak commit response 不含 cart/store/token', JSON.stringify(commit.json));
      const tRow = tokenRow(token);
      assert(tRow.status === 'consumed' && tRow.consumed_at, '8-commit-token-consumed commit 後 recovery token 為 consumed', JSON.stringify(tRow));
      assert(receiptRow(prep.json.data.restore_receipt).status === 'consumed', '8-commit-receipt-consumed commit 後 receipt 同步 consumed', JSON.stringify(receiptRow(prep.json.data.restore_receipt)));
    }
    {
      // Idempotent retry：同一張已成功 commit 的 receipt 重試，回同樣成功結果，不報錯、不二次 consume（已經是 consumed，UPDATE 條件不成立）。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartCommit2', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const retry = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(retry.status === 200 && retry.json.success === true, '8-commit-idempotent-retry 同一 receipt 重試 commit 仍回成功（idempotent，不是報錯）', JSON.stringify(retry));
    }
    {
      // 另一張（不同）receipt 不能二次 consume 同一個已經 consumed 的 token。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartCommit3', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep1 = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep1.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      // 這個 token 現在已經 consumed，再 prepare 一次應該直接被拒絕（token 狀態不是 opened）。
      const prep2 = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(prep2.status === 401, '8-no-second-receipt-after-consumed token 已經 consumed 後，無法再 prepare 出第二張 receipt', JSON.stringify(prep2));
    }
    {
      // Wrong member 不能 commit 別人的 receipt。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartCommit4', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const wrongMs = createMemberSession({ store_id: 'store_001', line_user_id: 'Uattacker2' });
      const commit = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: wrongMs, popup_session_public_code: sessionA.public_code } });
      assert(commit.status === 401, '8-wrong-member-cannot-commit 錯誤的 member_session 無法 commit 別人的 receipt', JSON.stringify(commit));
      assert(tokenRow(token).status === 'opened', '8-wrong-member-commit-no-state-change 錯誤嘗試不改變 token 狀態', JSON.stringify(tokenRow(token)));
    }

    // ══════════════════════════════════════════════════════════════
    // 九、Commit fault injection：模擬 DB transaction 中途失敗，token/receipt 都不能變成 consumed，整筆 rollback，可重試。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartFault', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });

      const hashBefore = fs.readFileSync(process.env.POS_DB_PATH).length; // 用檔案長度粗略代表內容雜湊（sql.js 每次 _save() 才落地）
      const origRun = db._db.run.bind(db._db);
      let callCount = 0;
      db._db.run = function (...args) {
        callCount += 1;
        // 讓 receipt 那筆 UPDATE 成功，但緊接著 token 那筆 UPDATE 故意失敗，模擬 commit transaction 中途出錯。
        if (typeof args[0] === 'string' && args[0].includes('UPDATE line_cart_handoff_tokens SET status=\'consumed\'')) {
          throw new Error('INJECTED FAULT: simulated mid-transaction failure');
        }
        return origRun(...args);
      };
      let threw = false;
      try {
        // 直接呼叫 utils 層（而不是走 HTTP）以確保注入的 fault 一定會被打到；HTTP 層會把例外轉成 401，這裡改成直接呼叫函式驗證 rollback 本身正確。
        const { commitPopupRestore } = require('../utils/popupRestore');
        const result = commitPopupRestore(db, prep.json.data.restore_receipt, memberSession, sessionA.public_code);
        assert(result.ok === false, '9-fault-injection-returns-failure fault injection 後 commitPopupRestore() 回傳失敗（不是拋出未捕捉例外）', JSON.stringify(result));
      } catch (e) { threw = true; }
      db._db.run = origRun;
      assert(!threw, '9-fault-injection-no-uncaught-throw commitPopupRestore() 內部有 try/catch，不會讓例外往外拋', 'threw=' + threw);

      const tRowAfterFault = tokenRow(token);
      assert(tRowAfterFault.status === 'opened', '9-fault-injection-token-still-opened fault injection 後 token 仍是 opened（沒有半成品狀態）', JSON.stringify(tRowAfterFault));
      const rRowAfterFault = receiptRow(prep.json.data.restore_receipt);
      assert(rRowAfterFault.status === 'prepared', '9-fault-injection-receipt-still-prepared fault injection 後 receipt 仍是 prepared（rollback 生效，沒有卡在中間狀態）', JSON.stringify(rRowAfterFault));

      // 可以正常重試（拿掉 fault 之後）。
      const retryResult = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(retryResult.status === 200 && retryResult.json.success === true, '9-fault-injection-retry-succeeds 拿掉 fault 後，用同一張 receipt 重試 commit 成功', JSON.stringify(retryResult));
      assert(tokenRow(token).status === 'consumed', '9-fault-injection-retry-consumed 重試成功後 token 正確變成 consumed', JSON.stringify(tokenRow(token)));
    }

    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    // 十一（本輪修正用語＋新增 DB 層級不變量證據）：Receipt supersede／
    // same-process competing prepare requests。
    //
    // 用語澄清（本輪要求）：下面的 Promise.all() 只證明「同一個 Node
    // process、同一個 event loop 裡，幾乎同時發出的兩個 request」的最終
    // 結果——因為 preparePopupRestore() 全程同步、沒有 await，Node 單執行緒
    // 保證這兩個 request 的 handler 不會真的交錯執行。這不是、也不構成
    // 「已證明 multi-process 或 multi-instance 並行安全」的證據。真正的
    // 額外保護是下面新增的 DB 層級 partial unique index
    // （idx_prr_token_single_prepared，UNIQUE(token_id) WHERE
    // status='prepared'）——這是資料庫自己強制執行的不變量，不管呼叫端是
    // 單一 process 還是多個 process/實例，SQLite 都不允許兩筆同時有效的
    // prepared receipt 存在。multi-instance 部署（多個 Node process 打同一個
    // 檔案型 DB）仍然需要外部 single-writer 或 DB 層級鎖，這裡不宣稱已經
    // 解決那個問題，只證明「就算竟然真的並行寫入，DB 本身也會擋下第二筆」。
    // ══════════════════════════════════════════════════════════════
    {
      const idxRow = db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_prr_token_single_prepared'");
      assert(!!idxRow, '11-partial-unique-index-exists DB 層級的 partial unique index（idx_prr_token_single_prepared）確實存在', JSON.stringify(idxRow));
    }
    {
      // 直接繞過 preparePopupRestore()，用最原始的 SQL 證明 DB 本身（不是
      // application 邏輯）就會拒絕同一個 token_id 出現兩筆 status='prepared'。
      const { token } = makeOpenedTokenWithCart('store_001', 'UcartIndexProof', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const tokenId = db.get('SELECT id FROM line_cart_handoff_tokens WHERE token=?', [token]).id;
      const crypto = require('crypto');
      db._db.run(
        `INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [crypto.randomBytes(16).toString('hex'), 'store_001', tokenId, 'UcartIndexProof', sessionA.public_code, 'digest1', 'prepared', '2099-01-01 00:00:00', '2099-01-01 00:05:00', '']
      );
      db._save();
      let threw = false;
      try {
        db._db.run(
          `INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [crypto.randomBytes(16).toString('hex'), 'store_001', tokenId, 'UcartIndexProof', sessionA.public_code, 'digest2', 'prepared', '2099-01-01 00:00:00', '2099-01-01 00:05:00', '']
        );
      } catch (e) { threw = true; }
      assert(threw, '11-partial-unique-index-enforced 直接對 DB 插入第二筆 status=prepared（同 token_id）時，SQLite 本身的 partial unique index 拒絕（不是 application 邏輯擋下）', 'threw=' + threw);
    }
    {
      // 兩個「幾乎同時」的 prepare（用 Promise.all 真的送出兩個 same-process
      // 的 HTTP request）：驗證 same-process competing requests 的最終結果
      // 只留下一張有效 receipt。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartConcurrent', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const [rA, rB] = await Promise.all([
        call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } }),
        call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } }),
      ]);
      assert(rA.status === 200 && rB.status === 200, '11-competing-prepare-both-succeed 兩次 same-process 並發 prepare 呼叫本身都成功（各自拿到一張 receipt）', JSON.stringify({ rA: rA.status, rB: rB.status }));
      const preparedCount = db.get(
        "SELECT COUNT(*) as c FROM popup_restore_receipts WHERE token_id=(SELECT id FROM line_cart_handoff_tokens WHERE token=?) AND status='prepared'",
        [token]
      ).c;
      assert(preparedCount === 1, '11-competing-prepare-single-valid-receipt same-process competing prepare 結束後，同一個 token 最多只有一張 status=prepared 的 receipt', String(preparedCount));
      // 舊的那張（先發出但被 supersede 的）不能拿去 commit。
      const olderReceipt = rA.json.data.restore_receipt === rB.json.data.restore_receipt ? null : rA.json.data.restore_receipt;
      if (olderReceipt && receiptRow(olderReceipt).status === 'superseded') {
        const commitOld = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: olderReceipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
        assert(commitOld.status === 401, '11-superseded-receipt-cannot-commit 被 supersede 的舊 receipt 無法 commit', JSON.stringify(commitOld));
        assert(tokenRow(token).status === 'opened', '11-superseded-receipt-no-consume 舊 receipt 的失敗嘗試沒有 consume token', JSON.stringify(tokenRow(token)));
      }
    }
    {
      // Fault injection：撤銷舊 receipt 與建立新 receipt 之間發生 SQL 錯誤時，整筆 rollback——舊 receipt 仍有效、DB 沒有半成品狀態。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartSupersedeFault', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const firstPrep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(firstPrep.status === 200, '11-supersede-fault-precondition 第一次 prepare 成功建立初始 receipt', JSON.stringify(firstPrep));

      const origRun = db._db.run.bind(db._db);
      db._db.run = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO popup_restore_receipts')) {
          throw new Error('INJECTED FAULT: simulated failure between supersede and insert');
        }
        return origRun(...args);
      };
      const { preparePopupRestore } = require('../utils/popupRestore');
      const faultResult = preparePopupRestore(db, token, memberSession, sessionA.public_code);
      db._db.run = origRun;
      assert(faultResult.ok === false, '11-supersede-fault-returns-failure fault injection 後 preparePopupRestore() 回傳失敗（沒有拋出未捕捉例外）', JSON.stringify(faultResult));

      const firstReceiptRow = receiptRow(firstPrep.json.data.restore_receipt);
      assert(firstReceiptRow.status === 'prepared', '11-supersede-fault-old-receipt-still-valid fault injection 後，原本那張 receipt 仍是 prepared（rollback 生效，沒有被誤 supersede）', JSON.stringify(firstReceiptRow));
      assert(tokenRow(token).status === 'opened', '11-supersede-fault-token-still-opened fault injection 後 token 仍是 opened', JSON.stringify(tokenRow(token)));

      // 舊 receipt 拿掉 fault 之後仍可正常 commit。
      const commitOriginal = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: firstPrep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(commitOriginal.status === 200 && commitOriginal.json.success === true, '11-supersede-fault-original-still-commits fault injection 沒有波及原本那張 receipt，仍可正常 commit', JSON.stringify(commitOriginal));
    }

    // ══════════════════════════════════════════════════════════════
    // 十二（本輪新增）：Commit idempotency 的身分邊界。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UcartIdemA', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      const firstCommit = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(firstCommit.status === 200, '12-idem-precondition 第一次 commit 成功', JSON.stringify(firstCommit));

      // same user + same session + same receipt → idempotent success。
      const sameUserRetry = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(sameUserRetry.status === 200 && sameUserRetry.json.success === true, '12-idem-same-identity-success 相同 verified user + 相同 session + 相同 receipt 重試仍成功（真正的 idempotent replay）', JSON.stringify(sameUserRetry));

      // wrong user + consumed receipt → 拒絕。
      const wrongMs = createMemberSession({ store_id: 'store_001', line_user_id: 'UcartIdemAttacker' });
      const wrongUserRetry = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: wrongMs, popup_session_public_code: sessionA.public_code } });
      assert(wrongUserRetry.status === 401, '12-idem-wrong-user-rejected 已 consumed 的 receipt，換成錯誤的 verified user 重試被拒絕（不是只看 status=consumed 就無條件成功）', JSON.stringify(wrongUserRetry));

      // wrong session + consumed receipt → 拒絕。
      const wrongSessionRetry = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: 'totally-different-session-code' } });
      assert(wrongSessionRetry.status === 401, '12-idem-wrong-session-rejected 已 consumed 的 receipt，換成錯誤的 session code 重試被拒絕', JSON.stringify(wrongSessionRetry));

      // 偽造 client store/page/token ID 欄位無效。
      const forgedRetry = await call('POST', '/api/cart-recovery/commit-popup-restore', {
        body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code, store_id: 'store_002', page_type: 'line_order', token_id: 999999 },
      });
      assert(forgedRetry.status === 200 && forgedRetry.json.success === true, '12-idem-forged-fields-ignored 偽造 store_id/page_type/token_id 欄位被忽略，仍依真正 receipt 身分回成功', JSON.stringify(forgedRetry));
      assert(!('store_id' in forgedRetry.json.data) && !('user' in forgedRetry.json.data) && !('token' in forgedRetry.json.data), '12-idem-no-leak idempotent 回應同樣不洩漏 store/user/token row', JSON.stringify(forgedRetry.json));
    }
    {
      // receipt A 已經 consume token 後，receipt B（不同 token/使用者建立的另一張，指向不同 token）不得二次 consume 同一個 token —— 用兩個不同 token 個別 prepare，只 commit 其中一個，確認另一個 token 完全不受影響（証明 receipt 與 token 是一對一綁定，不會互相干擾）。
      const fixtureA = makeOpenedTokenWithCart('store_001', 'UcartIdemB1', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const fixtureB = makeOpenedTokenWithCart('store_001', 'UcartIdemB2', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prepA = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: fixtureA.token, member_session: fixtureA.memberSession, popup_session_public_code: sessionA.public_code } });
      const prepB = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: fixtureB.token, member_session: fixtureB.memberSession, popup_session_public_code: sessionA.public_code } });
      await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prepA.json.data.restore_receipt, member_session: fixtureA.memberSession, popup_session_public_code: sessionA.public_code } });
      // 嘗試用 A 的（已consumed）receipt 但帶 B 的 member_session 去 commit——不同身分，應該被拒絕，且不能影響 token B。
      const crossAttempt = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prepA.json.data.restore_receipt, member_session: fixtureB.memberSession, popup_session_public_code: sessionA.public_code } });
      assert(crossAttempt.status === 401, '12-receipt-a-cannot-be-hijacked-by-b receipt A 已被 token A 的使用者 consume，B 的身分無法冒用 A 的 receipt', JSON.stringify(crossAttempt));
      assert(tokenRow(fixtureB.token).status === 'opened', '12-token-b-unaffected token B 完全不受 receipt A 的操作影響，仍是 opened', JSON.stringify(tokenRow(fixtureB.token)));
    }

    // resolve-target 仍支援三種 page type；standard restore 不接受 popup
    // receipt；popup restore 不接受 standard token。
    // ══════════════════════════════════════════════════════════════
    {
      const { createRecoveryResumeToken: createTok } = require('../utils/lineCheckoutHandoff');
      const stdCreated = createTok(db, 'store_001', { cartId: 'std-cart-1', lineUserId: 'UstdUser1', pageType: 'line_order', cartQtyItems: [{ product_id: 1, qty: 1 }] });
      assert(stdCreated.ok === true, '10-standard-token-unaffected 標準 line_order token 建立不受本輪影響', JSON.stringify(stdCreated));
      const stdMs = createMemberSession({ store_id: 'store_001', line_user_id: 'UstdUser1' });
      const stdResolve = resolveRecoveryTargetForVerifiedMember(db, stdCreated.token, stdMs);
      assert(stdResolve.ok === true && stdResolve.pageType === 'line_order', '10-generic-resolve-still-supports-standard generic resolve-target 仍正確支援 line_order page type', JSON.stringify(stdResolve));

      // popup restore 端點不接受標準 token（page type 不是 popup_order，prepare 直接拒絕）。
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: stdCreated.token, member_session: stdMs, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 401, '10-popup-restore-rejects-standard-token popup 的 prepare-popup-restore 拒絕標準 line_order token', JSON.stringify(r));
    }
    {
      // legacy row（沒有 popup_session_public_code）不受影響，仍視為標準 token。
      const legacyId = db.run(`INSERT INTO line_cart_handoff_tokens (token, store_id, status, purpose, cart_code, line_user_id, recovery_page_type, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        ['legacy-cart-restore-token', 'store_001', 'opened', 'recovery_resume', 'LEGACYCODE1', 'UlegacyUser', 'line_order', '2099-01-01 00:00:00', '2099-01-02 00:00:00']).lastInsertRowid;
      const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE id=?', [legacyId]);
      assert(row.popup_session_public_code === null || row.popup_session_public_code === undefined, '10-legacy-row-compatible legacy row 沒有 popup_session_public_code，向後相容', JSON.stringify(row));
      const legacyMs = createMemberSession({ store_id: 'store_001', line_user_id: 'UlegacyUser' });
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: 'legacy-cart-restore-token', member_session: legacyMs, popup_session_public_code: 'anything' } });
      assert(r.status === 401, '10-legacy-row-not-popup-restorable legacy standard row 無法用 popup restore 端點恢復（page type 不是 popup_order）', JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    // 十四（RC2 新增）：popup 空 snapshot 契約——原始 items=[] 必須直接
    // invalid_snapshot，不得產生 valid_empty_after_reconcile；標準
    // line_order/line_shipping 的既有空 items 契約不變。
    // ══════════════════════════════════════════════════════════════
    {
      const r = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UemptyCreate1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [] });
      assert(r.ok === false && r.reason === 'empty_cart', '14-create-empty-cart-rejected popup_order token 建立時原始 cartQtyItems=[] 直接被拒絕', JSON.stringify(r));
    }
    {
      const r = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UemptyCreate2', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: -1, qty: 1 }, { product_id: 1, qty: -5 }] });
      assert(r.ok === false && (r.reason === 'invalid_cart_item' || r.reason === 'empty_cart'), '14-create-all-invalid-items-rejected 全部項目都不安全（會被寬鬆 filter 悄悄清空）時，popup_order 建立直接拒絕，不會建立出一個「看似成功、內容其實是空的」token', JSON.stringify(r));
    }
    {
      // 標準 line_order 空 items 的既有契約完全不變：仍然可以建立成功。
      const r = createRecoveryResumeToken(db, 'store_001', { cartId: 'std-empty-cart-1', lineUserId: 'UstdEmpty1', pageType: 'line_order', cartQtyItems: [] });
      assert(r.ok === true, '14-standard-empty-items-unchanged 標準 line_order token 允許空 cartQtyItems（既有契約不變）', JSON.stringify(r));
    }
    {
      // 直接在 DB 層級偽造一筆「原始 items=[]」的 popup 快照（繞過建立階段的
      // 新防護，模擬萬一有舊資料或其他路徑寫入空快照的情境），prepare 必須
      // 回 invalid_snapshot（400），不是空 canonical cart（200）。
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UemptySnapshot', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      db._db.run("UPDATE line_cart_handoff_tokens SET cart_json='{\"items\":[]}' WHERE token=?", [token]);
      db._save();
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 400 && r.json.reason === 'invalid_snapshot', '14-prepare-raw-empty-items-invalid-snapshot 原始快照 items=[] 時 prepare 回 400 invalid_snapshot，不是 200 空購物車', JSON.stringify(r));
      assert(tokenRow(token).status === 'opened', '14-prepare-raw-empty-items-token-unaffected token 仍是 opened', JSON.stringify(tokenRow(token)));
    }
    {
      // 對照組：原始快照至少一項合法商品，只是後續被停用，才是 valid_empty_after_reconcile（已在第六節測過，這裡再次確認兩者互不混淆）。
      db._db.run("UPDATE products SET enabled=0 WHERE id=5 AND store_id='store_001'");
      db._save();
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UemptyAfterReconcileCheck', sessionA.public_code, [{ product_id: 5, qty: 1 }]);
      const r = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(r.status === 200 && r.json.data.cart_state === 'valid_empty_after_reconcile', '14-contrast-valid-empty-after-reconcile 原始快照合法、只是商品後續被停用，正確得到 200 valid_empty_after_reconcile（跟上面的 invalid_snapshot 明確不同）', JSON.stringify(r));
      db._db.run("UPDATE products SET enabled=1 WHERE id=5 AND store_id='store_001'");
      db._save();
    }

    // ══════════════════════════════════════════════════════════════
    // 十五（RC2 新增）：commit transaction affected-rows 防禦——正常路徑
    // 不受影響（已由前面既有測試涵蓋），這裡額外驗證「receipt 已經被別的
    // 途徑動過狀態」時，commit 不會誤判成功。
    // ══════════════════════════════════════════════════════════════
    {
      const { token, memberSession } = makeOpenedTokenWithCart('store_001', 'UaffectedRows1', sessionA.public_code, [{ product_id: 1, qty: 1 }]);
      const prep = await call('POST', '/api/cart-recovery/prepare-popup-restore', { body: { recovery_token: token, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      // 在 commit 之前，直接把 receipt 狀態改成 superseded（模擬「這期間已經被別的途徑改變」）。
      const crypto = require('crypto');
      const receiptHash = crypto.createHash('sha256').update(prep.json.data.restore_receipt).digest('hex');
      db._db.run("UPDATE popup_restore_receipts SET status='superseded' WHERE receipt_hash=?", [receiptHash]);
      db._save();
      const commit = await call('POST', '/api/cart-recovery/commit-popup-restore', { body: { restore_receipt: prep.json.data.restore_receipt, member_session: memberSession, popup_session_public_code: sessionA.public_code } });
      assert(commit.status === 401 && commit.json.success === false, '15-affected-rows-guard receipt 狀態已經不是 prepared 時，commit 正確拒絕（不會因為條件 UPDATE 影響 0 筆卻還是回成功）', JSON.stringify(commit));
      assert(tokenRow(token).status === 'opened', '15-affected-rows-guard-token-unaffected token 沒有被誤判成 consumed', JSON.stringify(tokenRow(token)));
    }

    // 十三（本輪新增）：Production rate limit（30/min）本身的正式測試——
    // 用一個全新、獨立的 router 實例（不跟上面任何測試共用 limiter 狀態），
    // 直接對著 production 真正的 30/min 門檻測試，不是對著被放寬過的門檻。
    // ══════════════════════════════════════════════════════════════
    {
      const { createPopupRestoreRouter: freshFactory, RATE_LIMIT_MAX: prodMax } = require('../routes/cart-recovery-popup-restore');
      assert(prodMax === 30, '13-rate-limit-production-value production RATE_LIMIT_MAX 確實是 30（沒有被本輪測試放寬）', String(prodMax));

      const rlApp = express();
      rlApp.use(express.json());
      rlApp.use('/api/cart-recovery', freshFactory());
      const rlServer = http.createServer(rlApp);
      await new Promise((resolve) => rlServer.listen(0, resolve));
      const rlPort = rlServer.address().port;
      const rlBase = `http://127.0.0.1:${rlPort}`;
      async function rlCall(body) {
        const res = await fetch(`${rlBase}/api/cart-recovery/prepare-popup-restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, json };
      }
      try {
        const results = [];
        for (let i = 0; i < 31; i++) {
          results.push(await rlCall({ recovery_token: 'nonexistent-rl-token-' + i, member_session: 'x' }));
        }
        const first30 = results.slice(0, 30);
        const the31st = results[30];
        assert(first30.every((r) => r.status !== 429), '13-rate-limit-first-30-not-limited 前 30 次請求都依既有契約處理（不是 429——各自因為 token 不存在被拒絕，但不是被限流）', JSON.stringify(first30.map((r) => r.status)));
        assert(the31st.status === 429 && the31st.json.reason === 'rate_limited', '13-rate-limit-31st-blocked 第 31 次請求（同一個全新 router 實例、同一個來源 IP）被 429 擋下', JSON.stringify(the31st));
        assert(!('token' in the31st.json) && !JSON.stringify(the31st.json).includes('nonexistent-rl-token'), '13-rate-limit-429-no-token-leak 429 response 不洩漏任何 token 是否存在的資訊', JSON.stringify(the31st.json));

        // 全新的另一個 router 實例不會繼承上一個實例的計數。
        const rlApp2 = express();
        rlApp2.use(express.json());
        rlApp2.use('/api/cart-recovery', freshFactory());
        const rlServer2 = http.createServer(rlApp2);
        await new Promise((resolve) => rlServer2.listen(0, resolve));
        const rlPort2 = rlServer2.address().port;
        try {
          const res2 = await fetch(`http://127.0.0.1:${rlPort2}/api/cart-recovery/prepare-popup-restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recovery_token: 'fresh-instance-token', member_session: 'x' }) });
          assert(res2.status !== 429, '13-rate-limit-fresh-instance-not-inherited 全新的 router 實例不會繼承前一個實例已經用掉的請求數', String(res2.status));
        } finally { await new Promise((resolve) => rlServer2.close(resolve)); }
      } finally {
        await new Promise((resolve) => rlServer.close(resolve));
      }
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
