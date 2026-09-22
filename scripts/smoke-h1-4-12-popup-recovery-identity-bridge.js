#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-identity-bridge.js
// H1.4.12 Phase 3B — Popup Recovery Identity Bridge, Corrective Completion.
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
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup recovery identity bridge (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-p3b-recovery-bridge-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase3b-recovery';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;

  try {
    {
      const cols = db.all("PRAGMA table_info(line_cart_handoff_tokens)").map((c) => c.name);
      assert(cols.includes('popup_session_public_code'), '1-migration-column popup_session_public_code 欄位存在', JSON.stringify(cols));
    }
    {
      await initDb();
      const cols = db.all("PRAGMA table_info(line_cart_handoff_tokens)").map((c) => c.name);
      assert(cols.filter((c) => c === 'popup_session_public_code').length === 1, '1-migration-idempotent 重跑 initDb() 後欄位仍只有一份', JSON.stringify(cols));
    }

    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`, ['store_001', '脆豬腰', 'pro', 1, features]);
    db._db.run(`INSERT OR REPLACE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_002', 'Store Two', 'Manager2', 'pro', 1]);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`, ['store_002', 'Store Two', 'pro', 1, features]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'popup_pickup_enabled', '1')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_002', 'popup_pickup_enabled', '1')");
    db._save();

    const jwt = require('jsonwebtoken');
    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/cart-recovery/resolve-target', require('../routes/cart-recovery-resolve-target'));
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
        campaign_id: campaignId, name: 'Recovery測試場次', location_id: locationId, product_scope: 'all_takeout',
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

    const camp1 = await makeCampaign(T1, 'Recovery測試活動1');
    const loc1 = await makeLocation(T1, 'Recovery測試地點1');
    const sessionA = await makeSession(T1, camp1.id, loc1.id);
    const sessionB = await makeSession(T1, camp1.id, loc1.id);
    const camp2 = await makeCampaign(T2, 'Recovery測試活動2（store_002）');
    const loc2 = await makeLocation(T2, 'Recovery測試地點2');
    const sessionStore2 = await makeSession(T2, camp2.id, loc2.id);

    const { createRecoveryResumeToken, resolveRecoveryTargetForVerifiedMember, restoreRecoveryToken, consumeRecoveryToken, cancelRecoveryToken } = require('../utils/lineCheckoutHandoff');
    const { buildRecoveryUrl, resolveRecoveryTargetPath } = require('../utils/cartRecoveryDelivery');
    const { createMemberSession } = require('../utils/lineMemberSession');

    function tokenRow(token) { return db.get('SELECT status, opened_at, consumed_at FROM line_cart_handoff_tokens WHERE token=?', [token]); }

    {
      const r = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Utest1', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      assert(r.ok === true, '3-create-success 合法場次可以建立 popup_order token', JSON.stringify(r));
    }
    {
      const r = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'Utest1', pageType: 'popup_order', popupSessionPublicCode: sessionStore2.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      assert(r.ok === false && r.reason === 'popup_session_store_mismatch', '3-create-cross-store 用別家店的場次代碼建立失敗', JSON.stringify(r));
    }
    {
      const r = createRecoveryResumeToken(db, 'store_001', { cartId: 'c1', lineUserId: 'Ustd', pageType: 'line_order', cartQtyItems: [] });
      assert(r.ok === true, '3-create-standard-unaffected 標準 line_order token 建立不受影響', JSON.stringify(r));
    }

    function newPopupToken(lineUserId, sessionCode) {
      const r = createRecoveryResumeToken(db, 'store_001', { lineUserId, pageType: 'popup_order', popupSessionPublicCode: sessionCode, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      if (!r.ok) throw new Error('token creation failed: ' + JSON.stringify(r));
      return r.token;
    }
    function newStandardToken(lineUserId, pageType = 'line_order') {
      const r = createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-' + lineUserId, lineUserId, pageType, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      if (!r.ok) throw new Error('token creation failed: ' + JSON.stringify(r));
      return r.token;
    }

    {
      const tok = newPopupToken('Ubridge1', sessionA.public_code);
      const noMemberSession = resolveRecoveryTargetForVerifiedMember(db, tok, null);
      assert(noMemberSession.ok === false && noMemberSession.reason === 'member_not_identified', '4.1-token-only-rejected 只有合法 token、沒有 member_session 時拒絕', JSON.stringify(noMemberSession));
      assert(tokenRow(tok).status === 'bound', '4.1-token-only-no-state-change 失敗嘗試不改變 token 狀態', JSON.stringify(tokenRow(tok)));
    }
    {
      const tok = newPopupToken('Ubridge2', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'Ubridge2' });
      const before = tokenRow(tok);
      assert(before.status === 'bound' && before.consumed_at === '', '4.2-precondition-bound 建立當下是 bound、consumed_at 空白', JSON.stringify(before));
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === true, '4.2-happy-path 身分正確時成功解析 target', JSON.stringify(result));
      assert(result.pageType === 'popup_order' && result.targetPath === `/popup-order?session=${encodeURIComponent(sessionA.public_code)}`, '4.2-target-correct target_path 正確且經過 allowlist/encode', JSON.stringify(result));
      assert(!('cart' in result) && !('cart_json' in result) && !('items' in result) && !('subtotal' in result) && !('total' in result), '4.2-no-cart-payload 回傳值完全不含購物車內容', JSON.stringify(result));
      const after = tokenRow(tok);
      assert(after.status === 'opened' && after.opened_at !== '', '4.2-bound-to-opened bound → opened 轉移正確發生', JSON.stringify(after));
      assert(after.consumed_at === '' || after.consumed_at === null, '4.2-not-consumed resolve 之後絕對不是 consumed', JSON.stringify(after));
    }
    {
      const tok = newPopupToken('Ubridge3', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'Ubridge3' });
      resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      const openedAtFirst = tokenRow(tok).opened_at;
      await new Promise((r) => setTimeout(r, 1100));
      const r2 = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(r2.ok === true, '4.3-idempotent-same-user 同一個 verified user 對 opened token 重複呼叫仍然成功（冪等）', JSON.stringify(r2));
      assert(tokenRow(tok).opened_at === openedAtFirst, '4.3-idempotent-no-rewrite 第二次呼叫沒有重新覆寫 opened_at', JSON.stringify({ first: openedAtFirst, second: tokenRow(tok).opened_at }));
    }
    {
      const tok = newPopupToken('Ubridge4', sessionA.public_code);
      const wrongMs = createMemberSession({ store_id: 'store_001', line_user_id: 'Uattacker' });
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, wrongMs);
      assert(result.ok === false && result.reason === 'uid_mismatch', '4.4-wrong-user-rejected 錯誤的 verified user 被拒絕', JSON.stringify(result));
      assert(tokenRow(tok).status === 'bound', '4.4-wrong-user-no-state-change 錯誤嘗試沒有把狀態轉成 opened', JSON.stringify(tokenRow(tok)));
    }
    {
      const tok = newPopupToken('Ubridge5', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'Ubridge5' });
      const consumeResult = consumeRecoveryToken(db, 'store_001', tok);
      assert(consumeResult.ok === true, '4.5-setup-consumed 測試用既有 consumeRecoveryToken() 把 token 轉成 consumed', JSON.stringify(consumeResult));
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === false && result.reason === 'consumed', '4.5-consumed-rejected 已 consumed 的 token 無法再被 resolve', JSON.stringify(result));
    }
    {
      const tok = newPopupToken('Ubridge6', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'Ubridge6' });
      cancelRecoveryToken(db, 'store_001', tok);
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === false && result.reason === 'cancelled', '4.5-cancelled-rejected 已 cancelled 的 token 無法被 resolve', JSON.stringify(result));
    }
    {
      const tok = newPopupToken('Ubridge7', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'Ubridge7' });
      db._db.run("UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?", [tok]);
      db._save();
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === false && result.reason === 'expired', '4.5-expired-rejected 過期 token 無法被 resolve', JSON.stringify(result));
      assert(tokenRow(tok).consumed_at === '' || tokenRow(tok).consumed_at === null, '4.5-expired-not-consumed 過期標記不等於消費', JSON.stringify(tokenRow(tok)));
    }
    {
      const draftLater = await makeSession(T1, camp1.id, loc1.id);
      const tok = newPopupToken('UbridgeDraft', draftLater.public_code);
      await call('PATCH', `/api/popup-pickup/sessions/${draftLater.id}`, { token: T1, body: { expected_revision: draftLater.revision, status: 'draft' } });
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UbridgeDraft' });
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === false && result.reason === 'popup_session_not_found', '4.6-fresh-recheck-draft token 建立後場次被下架，resolve 時 fresh 重新驗證後拒絕', JSON.stringify(result));
    }
    {
      const tok = newStandardToken('UbridgeStd1', 'line_order');
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UbridgeStd1' });
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === true && result.pageType === 'line_order' && result.targetPath === '/line-order.html' && !result.popupSessionPublicCode, '4.7-standard-target-correct line_order token 解析出正確固定 target，沒有 popup 專屬欄位', JSON.stringify(result));
    }
    {
      const tok = newStandardToken('UbridgeStd2', 'line_shipping');
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UbridgeStd2' });
      const result = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(result.ok === true && result.pageType === 'line_shipping' && result.targetPath === '/line-shipping.html', '4.7-shipping-target-correct line_shipping token 解析出正確固定 target', JSON.stringify(result));
    }
    {
      const tok = newPopupToken('UbridgeNext', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UbridgeNext' });
      const prep = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(prep.ok === true, '4.8-prepare-succeeds prepare 階段成功', JSON.stringify(prep));
      const full = restoreRecoveryToken(db, 'store_001', tok, 'UbridgeNext', 'popup_order', sessionA.public_code);
      assert(full.ok === true && full.cart_restore_deferred === true, '4.8-full-restore-still-works prepare 成功後，下一階段的 restoreRecoveryToken() 仍能正常運作', JSON.stringify(full));
      assert(tokenRow(tok).consumed_at === '' || tokenRow(tok).consumed_at === null, '4.8-still-not-consumed prepare + 目前這版 restoreRecoveryToken() 呼叫過，仍未 consumed', JSON.stringify(tokenRow(tok)));
    }
    {
      const tok = newPopupToken('UbridgeFault', sessionA.public_code);
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UbridgeFault' });
      resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(tokenRow(tok).status === 'opened', '4.9-fault-boundary-precondition prepare 成功後狀態是 opened', JSON.stringify(tokenRow(tok)));
      const retryPrepare = resolveRecoveryTargetForVerifiedMember(db, tok, ms);
      assert(retryPrepare.ok === true, '4.9-fault-boundary-retry 下一步失敗情境下同一位使用者仍可再次成功 prepare', JSON.stringify(retryPrepare));
    }

    {
      const noLiff = buildRecoveryUrl(db, 'store_001', { token: 'sometoken', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code });
      assert(noLiff.ok === false && noLiff.reason === 'missing_liff_id', '5-no-liff-fail-closed 沒有設定 LIFF ID 時 fail closed', JSON.stringify(noLiff));
    }
    {
      db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'line_popup_liff_id', 'popup-liff-123')");
      db._save();
      const withLiff = buildRecoveryUrl(db, 'store_001', { token: 'sometoken', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code });
      assert(withLiff.ok === true && withLiff.url.startsWith('https://liff.line.me/popup-liff-123'), '5-liff-url-correct-id 設定後正確組出 LIFF URL', JSON.stringify(withLiff));
    }
    {
      const resolved = resolveRecoveryTargetPath('https://evil.example.com/phish');
      assert(resolved.ok === false && resolved.reason === 'invalid_target', '5-no-open-redirect 任意字串不會被當成合法 path', JSON.stringify(resolved));
    }

    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal1' });
      const tok = newPopupToken('UhttpReal1', sessionA.public_code);
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: tok, member_session: ms } });
      assert(r.status === 200 && r.json.success === true, '6-http-popup-success 真實 HTTP：popup token 成功解析', JSON.stringify(r));
      assert(r.json.data.page_type === 'popup_order' && r.json.data.target_path === `/popup-order?session=${encodeURIComponent(sessionA.public_code)}`, '6-http-popup-target 回傳正確 page_type/target_path', JSON.stringify(r.json));
      assert(!('cart' in r.json.data) && !('line_user_id' in r.json.data) && !('store_id' in r.json.data), '6-http-no-leak response 不含 cart/line_user_id/store_id', JSON.stringify(r.json));
      const row = tokenRow(tok);
      assert(row.status === 'opened' && (row.consumed_at === '' || row.consumed_at === null), '6-http-not-consumed 真實 HTTP 呼叫後 token 是 opened、不是 consumed', JSON.stringify(row));
    }
    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal2' });
      const tok = newPopupToken('UhttpReal2', sessionA.public_code);
      const res = await fetch(`${base}/api/cart-recovery/resolve-target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recovery_token: tok, member_session: ms }) });
      const json = await res.json();
      assert(res.status === 200 && json.success === true, '6-http-no-auth-header-needed 端點不需要 Authorization header', JSON.stringify(json));
    }
    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal3' });
      const tok = newPopupToken('UhttpReal3', sessionA.public_code);
      const r = await call('POST', '/api/cart-recovery/resolve-target', {
        body: {
          recovery_token: tok, member_session: ms,
          store_id: 'store_002', page_type: 'line_order', popup_session_public_code: sessionB.public_code,
          target_path: '/evil', line_user_id: 'Uattacker', entry_context: 'standard',
        },
      });
      assert(r.status === 200 && r.json.success === true && r.json.data.page_type === 'popup_order' && r.json.data.target_path === `/popup-order?session=${encodeURIComponent(sessionA.public_code)}`, '6-http-forged-fields-ignored 偽造 store_id/page_type/session/target/line_user_id/entry_context 全部被忽略', JSON.stringify(r.json));
    }
    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal4' });
      const tok = newStandardToken('UhttpReal4', 'line_order');
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: tok, member_session: ms } });
      assert(r.status === 200 && r.json.success === true && r.json.data.page_type === 'line_order' && r.json.data.target_path === '/line-order.html', '6-http-standard-target 真實 HTTP：standard token 導向原標準 target', JSON.stringify(r.json));
    }
    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal5' });
      const tok = newStandardToken('UhttpReal5', 'line_shipping');
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: tok, member_session: ms } });
      assert(r.status === 200 && r.json.success === true && r.json.data.page_type === 'line_shipping' && r.json.data.target_path === '/line-shipping.html', '6-http-shipping-target 真實 HTTP：shipping token 導向原宅配 target', JSON.stringify(r.json));
    }
    {
      const tok = newPopupToken('UhttpReal6', sessionA.public_code);
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: tok } });
      assert(r.status === 200 && r.json.success === false && r.json.reason === 'resolve_failed', '6-http-token-only-rejected 只有 token、沒有 member_session 時拒絕（RC2：不可枚舉的統一 reason）', JSON.stringify(r));
    }
    {
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: 'not-a-real-token', member_session: createMemberSession({ store_id: 'store_001', line_user_id: 'Ux' }) } });
      assert(r.status === 200 && r.json.success === false && r.json.reason === 'resolve_failed', '6-http-invalid-token 不存在的 token 被拒絕（RC2：跟其他失敗用同一個 byte-identical reason，不可枚舉）', JSON.stringify(r));
    }
    {
      // RC2 規格四：所有失敗情境的 response body 必須完全 byte-identical
      // （不只是 reason 字串相同，是整個 JSON serialize 後逐 byte 相同），
      // 不同失敗原因（不存在的 token / 錯誤身分 / consumed token）不得產生
      // 任何可以拿來區分的差異。
      const consumedTok = newPopupToken('UhttpReal7', sessionA.public_code);
      const { consumeRecoveryToken: consumeFn } = require('../utils/lineCheckoutHandoff');
      consumeFn(db, 'store_001', consumedTok);
      const wrongMs = createMemberSession({ store_id: 'store_001', line_user_id: 'UhttpReal7' });

      const rNotFound = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: 'definitely-not-a-real-token-xyz', member_session: wrongMs } });
      const rConsumed = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: consumedTok, member_session: wrongMs } });
      const rWrongUser = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: newPopupToken('UhttpReal8', sessionA.public_code), member_session: createMemberSession({ store_id: 'store_001', line_user_id: 'Uattacker99' }) } });
      const bodies = [JSON.stringify(rNotFound.json), JSON.stringify(rConsumed.json), JSON.stringify(rWrongUser.json)];
      assert(rNotFound.status === 200 && rConsumed.status === 200 && rWrongUser.status === 200, '6-http-byte-identical-status 三種完全不同的失敗原因（不存在/已消費/錯誤身分）全部回同一個 HTTP status', JSON.stringify([rNotFound.status, rConsumed.status, rWrongUser.status]));
      assert(new Set(bodies).size === 1, '6-http-byte-identical-body 三種完全不同的失敗原因回傳的 response body 逐 byte 完全相同', JSON.stringify(bodies));
    }
    {
      const r = await call('POST', '/api/line-orders/popup-recovery-restore', { body: {} });
      assert(r.status === 404, '6-http-old-endpoint-removed 舊的 popup-recovery-restore 端點已經移除', JSON.stringify(r));
    }

    {
      const ms = createMemberSession({ store_id: 'store_001', line_user_id: 'UflowEnd2End' });
      const created = createRecoveryResumeToken(db, 'store_001', { lineUserId: 'UflowEnd2End', pageType: 'popup_order', popupSessionPublicCode: sessionA.public_code, cartQtyItems: [{ product_id: 1, qty: 1 }] });
      const beforeRow = tokenRow(created.token);
      assert(beforeRow.status === 'bound', '7-e2e-precondition token 建立時是 bound', JSON.stringify(beforeRow));
      const r = await call('POST', '/api/cart-recovery/resolve-target', { body: { recovery_token: created.token, member_session: ms } });
      assert(r.status === 200 && r.json.success === true, '7-e2e-resolve-success 完整流程：真實 HTTP resolve 成功', JSON.stringify(r));
      assert(r.json.data.target_path === `/popup-order?session=${encodeURIComponent(sessionA.public_code)}`, '7-e2e-target-matches-session target_path 對應正確場次', r.json.data.target_path);
      const afterRow = tokenRow(created.token);
      assert(afterRow.status === 'opened', '7-e2e-status-opened resolve 後狀態是 opened', JSON.stringify(afterRow));
      assert(afterRow.consumed_at === '' || afterRow.consumed_at === null, '7-e2e-not-consumed 查真實 DB 證明 target resolve 後 token 未被 consume', JSON.stringify(afterRow));
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
