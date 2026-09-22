#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-phase2-1-audit.js
// H1.4.12 Phase 2.1 Corrective Audit｜快閃取餐排程中心 — 對抗性真實測試。
//
// 涵蓋（對應 corrective audit 一~七）：
//   1. confirmation transaction 競態：交易內用 fresh count/revision 做唯一
//      權威決策，交易外任何先前讀到的值都不算數。
//   2. Asia/Taipei 時間格式收緊：Z/+09:00/-08:00 拒絕；canonical +08:00 輸出；
//      無 offset 的資料庫壞資料在三時區都回 invalid。
//   3. 安全整數驗證：Number.isSafeInteger()，拒絕 2^53、1e20、負數、小數、
//      字串數字、null/array/object。
//   4. 所有子資源查詢完整加上 store scope（poisoned-data 測試）。
//   5. 布林輸入嚴格 0/1 正規化，不使用 truthy coercion。
//   6. archived session 終止狀態一致性。
//   7. 真正的 fault-injection transaction 測試（強制 SQL 中途拋錯，證明
//      rollback 是真的發生，不是靠交易外 pre-validation 僥倖沒進 transaction）。
//
// 全部使用真實 sql.js 暫存 DB、真實 Express router、真實 HTTP、真實 JWT。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 2.1 corrective audit (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-phase21-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase2-1';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const pp = require('../utils/popupPickup');
  let server = null;

  try {
    db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`,
      ['store_002', 'Store Two', 'Manager2', 'pro', 1]);
    const features = JSON.stringify({ line_order: true, orders: true, products: true });
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_001', '脆豬腰', 'pro', 1, features]);
    db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_002', 'Store Two', 'pro', 1, features]);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled) VALUES
      (101, 'store_001', '排骨飯', '主食', 120, 1),
      (201, 'store_002', 'Store2 商品', '主食', 100, 1)`);
    db._save();

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/popup-pickup', require('../routes/popup-pickup'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    function tokenFor(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
    async function call(method, urlPath, { token, body } = {}) {
      const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }
    const T1 = tokenFor('store_001');
    const T2 = tokenFor('store_002');

    async function makeCampaignLocation(token, campaignName, locationName) {
      const rc = await call('POST', '/api/popup-pickup/campaigns', { token, body: { name: campaignName } });
      const rl = await call('POST', '/api/popup-pickup/locations', { token, body: { name: locationName, address: locationName + ' Addr' } });
      return { campaignId: rc.json.data.id, locationId: rl.json.data.id };
    }
    async function makeSession(token, campaignId, locationId, overrides = {}) {
      const r = await call('POST', '/api/popup-pickup/sessions', {
        token,
        body: {
          campaign_id: campaignId, name: 'Session', pickup_date: '2028-01-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
          order_open_at: '2027-12-01T00:00', order_cutoff_at: '2027-12-31T00:00', location_id: locationId, product_scope: 'all_takeout',
          ...overrides,
        },
      });
      return r.json.data;
    }
    function insertFakeOrder(sessionId, orderId, storeId = 'store_001') {
      db._db.run(
        `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orderId, orderId, storeId, 'x', '0900000000', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', sessionId, new Date().toISOString()]
      );
      db._save();
    }

    // ════════════════════════════════════════════════════════════════
    // 一、confirmation transaction 競態
    //
    // Phase 2.2 修正：原本的 1a 只是「請求送出前訂單就已經存在」，client
    // 根本沒有機會看到「沒有訂單」的過期畫面，這不構成真正的競態，只是
    // 「fresh 讀取本來就會抓到既有訂單」的平凡情境（已改標為
    // 1a-preexisting-not-a-race，保留當作基本 sanity check，但不再稱為
    // race）。真正的競態測試（1a-race-true-injection）改為：在 outer
    // resource read／格式驗證都已經跑完、但 `BEGIN` 還沒執行的那個精確時間
    // 點，用 monkey-patch 攔截 `db._db.run('BEGIN')`，在放行 BEGIN 之前才
    // 插入並落地一張訂單——這才是「client 讀到的畫面是 0 筆訂單，但送出
    // 請求後，資料庫在交易開始前已經多了一筆」的真實競態情境。
    // ════════════════════════════════════════════════════════════════
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RacePreexisting', 'RaceLocPre');
      const s = await makeSession(T1, campaignId, locationId);
      insertFakeOrder(s.id, 'race-preexisting-order-1');
      const r = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: s.revision, pickup_start_time: '10:30' },
      });
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_CHANGE_CONFIRM_REQUIRED', '1a-preexisting-not-a-race（非競態，僅 sanity check）請求送出前訂單已存在，fresh count 正確偵測，回 409', JSON.stringify(r));
      assert(r.json.affected_order_count === 1, '1a-preexisting-not-a-race affected_order_count=1', JSON.stringify(r.json));
      const afterRow = db.get('SELECT revision, pickup_start_time FROM popup_sessions WHERE id=?', [s.id]);
      assert(afterRow.revision === s.revision && afterRow.pickup_start_time === '10:00', '1a-preexisting-not-a-race 完全未寫入 session', JSON.stringify(afterRow));
    }
    {
      // 真正的 0→1 競態：session 建立後、送出 PATCH 前，先明確驗證
      // affected order count = 0（client 讀到的畫面就是「沒有訂單」）。
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RaceTrueInjection', 'RaceLocTrue');
      const s = await makeSession(T1, campaignId, locationId);
      const countBefore = db.get(
        `SELECT COUNT(*) as c FROM orders WHERE store_id=? AND popup_session_id=? AND order_status NOT IN ('cancelled','voided') AND (voided_at IS NULL OR voided_at='')`,
        ['store_001', s.id]
      ).c;
      assert(countBefore === 0, '1a-race-true-injection 場次建立後、PATCH 送出前，affected order count 確實是 0（測試前提成立）', String(countBefore));

      const originalRun = db._db.run.bind(db._db);
      let injectedAtBegin = false;
      db._db.run = (...args) => {
        const sql = String(args[0]);
        if (!injectedAtBegin && sql.trim() === 'BEGIN') {
          injectedAtBegin = true;
          // 精確注入點：outer resource read／格式驗證都已完成（route 程式碼
          // 跑到要開始 transaction 的這一刻），BEGIN 尚未執行——在這裡才
          // insert 一張有效訂單並立即落地，模擬「另一個完全獨立的請求」在
          // 這個縫隙中搶先成立訂單。
          originalRun(
            `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ['race-true-injection-order-1', 'race-true-injection-order-1', 'store_001', 'x', '0900000001', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', s.id, new Date().toISOString()]
          );
          db._save();
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
          token: T1, body: { expected_revision: s.revision, pickup_start_time: '10:30' },
        });
      } finally {
        db._db.run = originalRun;
      }
      assert(injectedAtBegin, '1a-race-true-injection 確實攔截到 BEGIN 並完成注入（測試機制本身有效）');
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_CHANGE_CONFIRM_REQUIRED', '1a-race-true-injection 交易內 freshAffectedCount 看到注入的訂單，回 409 需要確認（未帶 confirm）', JSON.stringify(r));
      assert(r.json.affected_order_count === 1, '1a-race-true-injection affected_order_count 使用交易內 fresh 值 =1', JSON.stringify(r.json));
      const afterRow = db.get('SELECT revision, pickup_start_time FROM popup_sessions WHERE id=?', [s.id]);
      assert(afterRow.revision === s.revision && afterRow.pickup_start_time === '10:00', '1a-race-true-injection session 欄位與 revision 完全未變', JSON.stringify(afterRow));
      const logCount = db.get('SELECT COUNT(*) as c FROM popup_session_change_logs WHERE session_id=?', [s.id]).c;
      assert(logCount === 0, '1a-race-true-injection change log = 0', String(logCount));
      const injectedOrderStillThere = db.get('SELECT id FROM orders WHERE id=?', ['race-true-injection-order-1']);
      assert(!!injectedOrderStillThere, '1a-race-true-injection 注入的訂單仍存在（未被這次失敗的 PATCH 動到）', JSON.stringify(injectedOrderStillThere));
    }
    {
      // 0→1 競態的確認變體：同樣在 BEGIN 前注入訂單，但這次 client 端從一
      // 開始就送出 confirm_affected_orders:true + change_reason（模擬「client
      // 剛好也預先決定要確認」的情境）；驗證交易內 freshAffectedCount 依然
      // 正確算出 1，成功寫入並真的建立 change log（affected_order_count=1）。
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RaceTrueInjectionConfirm', 'RaceLocTrueConfirm');
      const s = await makeSession(T1, campaignId, locationId);

      const originalRun = db._db.run.bind(db._db);
      let injectedAtBegin = false;
      db._db.run = (...args) => {
        const sql = String(args[0]);
        if (!injectedAtBegin && sql.trim() === 'BEGIN') {
          injectedAtBegin = true;
          originalRun(
            `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ['race-true-injection-confirm-order-1', 'race-true-injection-confirm-order-1', 'store_001', 'x', '0900000002', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', s.id, new Date().toISOString()]
          );
          db._save();
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
          token: T1,
          body: { expected_revision: s.revision, pickup_start_time: '10:30', confirm_affected_orders: true, change_reason: '0→1 競態確認變體測試' },
        });
      } finally {
        db._db.run = originalRun;
      }
      assert(injectedAtBegin, '1a-race-confirm-variant 確實攔截到 BEGIN 並完成注入');
      assert(r.status === 200 && r.json.affected_order_count === 1, '1a-race-confirm-variant 帶 confirm+reason 時，交易內 fresh count=1，成功寫入且 response affected_order_count=1', JSON.stringify(r));
      const logRow = db.get('SELECT * FROM popup_session_change_logs WHERE session_id=? ORDER BY id DESC LIMIT 1', [s.id]);
      assert(!!logRow && logRow.affected_order_count === 1, '1a-race-confirm-variant 真的建立了 change log，affected_order_count=1', JSON.stringify(logRow));
    }
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RaceTest2', 'RaceLoc2');
      const s = await makeSession(T1, campaignId, locationId);

      const originalGet = db.get.bind(db);
      let matchCount = 0;
      db.get = (sql, params) => {
        const result = originalGet(sql, params);
        if (String(sql).includes('FROM popup_sessions WHERE id=? AND store_id=?')) {
          matchCount += 1;
          if (matchCount === 1) {
            db._db.run('UPDATE popup_sessions SET revision=revision+1 WHERE id=?', [s.id]);
            db._save();
          }
        }
        return result;
      };
      let r;
      try {
        r = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
          token: T1, body: { expected_revision: s.revision, pickup_start_time: '10:45' },
        });
      } finally {
        db.get = originalGet;
      }
      assert(r.status === 409 && r.json.error === 'POPUP_SESSION_REVISION_CONFLICT', '1b-race-revision 初次讀取後注入 revision 改變，交易內 fresh 讀取正確偵測並回 409', JSON.stringify(r));
      const afterRow = db.get('SELECT pickup_start_time FROM popup_sessions WHERE id=?', [s.id]);
      assert(afterRow.pickup_start_time === '10:00', '1b-race-revision session 未被這次 PATCH 寫入（原始 pickup_start_time 不變）', JSON.stringify(afterRow));
    }
    {
      // Phase 2.2 強化：change-log SQL fault 測試——除了原本的欄位比對，
      // 新增（a）_save() spy 確認完全未被呼叫、（b）失敗前後整個 DB 檔案
      // 的 SHA-256 逐位元組比對必須完全相同（比欄位比對更嚴格：連 SQLite
      // 內部 page/WAL 層級的任何副作用都不放過），（c）所有 monkey-patch
      // 保證在 finally 還原。
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RaceTest3', 'RaceLoc3');
      const s = await makeSession(T1, campaignId, locationId, { product_scope: 'selected', products: [{ product_id: 101, quota_qty: 5 }] });
      insertFakeOrder(s.id, 'race3-order-1');

      const dbFilePath = process.env.POS_DB_PATH;
      const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');

      const originalRun = db._db.run.bind(db._db);
      const originalSave = db._save.bind(db);
      let saveCalledDuringInjection = false;
      db._save = (...args) => { saveCalledDuringInjection = true; return originalSave(...args); };
      db._db.run = (...args) => {
        if (String(args[0]).includes('INSERT INTO popup_session_change_logs')) {
          throw new Error('INJECTED FAILURE: change log insert forced to fail');
        }
        return originalRun(...args);
      };
      let r;
      try {
        r = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
          token: T1,
          body: { expected_revision: s.revision, pickup_start_time: '10:15', confirm_affected_orders: true, change_reason: '測試 rollback' },
        });
      } finally {
        db._db.run = originalRun;
        db._save = originalSave;
      }
      assert(r.status === 500 && r.json.error === 'POPUP_INTERNAL_ERROR', '1c-changelog-fail-rollback change log INSERT 失敗，API 回 500', JSON.stringify(r));
      const afterRow = db.get('SELECT revision, pickup_start_time FROM popup_sessions WHERE id=?', [s.id]);
      assert(afterRow.revision === s.revision && afterRow.pickup_start_time === '10:00', '1c-changelog-fail-rollback session 的 UPDATE 也一併 ROLLBACK（未部分寫入）', JSON.stringify(afterRow));
      const products = db.all('SELECT product_id FROM popup_session_products WHERE session_id=?', [s.id]);
      assert(products.length === 1 && products[0].product_id === 101, '1c-changelog-fail-rollback session_products 也未被更動', JSON.stringify(products));
      const logCount = db.get('SELECT COUNT(*) as c FROM popup_session_change_logs WHERE session_id=?', [s.id]).c;
      assert(logCount === 0, '1c-changelog-fail-rollback change log 確實沒有殘留任何一筆', String(logCount));
      assert(saveCalledDuringInjection === false, '1c-changelog-fail-rollback _save() 在失敗路徑中完全未被呼叫（spy 驗證）', String(saveCalledDuringInjection));
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbFilePath)).digest('hex');
      assert(shaBefore === shaAfter, '1c-changelog-fail-rollback 失敗前後整個 DB 檔案 SHA-256 完全相同（連底層 page 都沒被動過）', `before=${shaBefore} after=${shaAfter}`);
    }
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'RaceTest4', 'RaceLoc4');
      const s = await makeSession(T1, campaignId, locationId);
      insertFakeOrder(s.id, 'race4-order-1');
      const r1 = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: s.revision, pickup_start_time: '10:20' },
      });
      assert(r1.status === 409, '1d-正常路徑-第一次 未帶 confirm 仍回 409', JSON.stringify(r1));
      const r2 = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: s.revision, pickup_start_time: '10:20', confirm_affected_orders: true, change_reason: '正常確認流程' },
      });
      assert(r2.status === 200 && r2.json.data.revision === s.revision + 1, '1d-正常路徑-確認後 成功、revision+1', JSON.stringify(r2));
      const logRow = db.get('SELECT * FROM popup_session_change_logs WHERE session_id=? ORDER BY id DESC LIMIT 1', [s.id]);
      assert(!!logRow && logRow.change_reason === '正常確認流程', '1d-正常路徑-確認後 change log 正確建立', JSON.stringify(logRow));
    }

    // ════════════════════════════════════════════════════════════════
    // 二、Asia/Taipei 時間格式收緊
    // ════════════════════════════════════════════════════════════════
    assert(pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00Z') === null, '2-offset-reject Z 拒絕');
    assert(pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00+09:00') === null, '2-offset-reject +09:00 拒絕');
    assert(pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00-08:00') === null, '2-offset-reject -08:00 拒絕');
    assert(pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00:00+08:00') === '2026-09-01T09:00:00+08:00', '2-offset-accept +08:00 接受且 canonical');
    assert(pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00') === '2026-09-01T09:00:00+08:00', '2-offset-accept 無 offset 輸入正確補上 +08:00');
    {
      const r = pp.resolvePopupSessionState({
        campaignStatus: 'published', sessionStatus: 'published',
        pickupDate: '2026-09-18', pickupStartTime: '17:30', pickupEndTime: '19:00',
        orderOpenAt: '2026-09-18T08:00:00', orderCutoffAt: '2026-09-18T09:00:00',
        now: Date.parse('2026-09-18T08:30:00Z'),
      });
      assert(r.state === 'invalid' && r.can_order === false, '2-bad-db-data 無 offset 的資料庫壞資料回 invalid（不猜測時區）', JSON.stringify(r));
    }
    assert(pp.epochMsOfNormalizedIso('2026-09-18T08:00:00') === null, '2-epoch-strict 無 offset 字串 epochMsOfNormalizedIso 回 null');
    assert(pp.epochMsOfNormalizedIso('2026-09-18T08:00:00Z') === null, '2-epoch-strict Z offset 字串 epochMsOfNormalizedIso 回 null');
    assert(pp.epochMsOfNormalizedIso('2026-09-18T08:00:00+09:00') === null, '2-epoch-strict 非 +08:00 offset 字串 epochMsOfNormalizedIso 回 null');
    assert(typeof pp.epochMsOfNormalizedIso('2026-09-18T08:00:00+08:00') === 'number', '2-epoch-strict 合法 canonical 字串正確解析');

    // ════════════════════════════════════════════════════════════════
    // 三、安全整數驗證
    // ════════════════════════════════════════════════════════════════
    assert(pp.isPositiveInt(Number.MAX_SAFE_INTEGER) === true, '3-safe-int MAX_SAFE_INTEGER 依規則可接受（正整數）');
    assert(pp.isPositiveInt(Number.MAX_SAFE_INTEGER + 1) === false, '3-safe-int MAX_SAFE_INTEGER+1 拒絕');
    assert(pp.isPositiveInt(1e20) === false, '3-safe-int 1e20 拒絕');
    assert(pp.isPositiveInt(-5) === false, '3-safe-int 負數拒絕');
    assert(pp.isPositiveInt(1.5) === false, '3-safe-int 小數拒絕');
    assert(pp.isPositiveInt('5') === false, '3-safe-int 字串數字拒絕');
    assert(pp.isPositiveInt(null) === false, '3-safe-int null 拒絕');
    assert(pp.isPositiveInt([5]) === false, '3-safe-int array 拒絕');
    assert(pp.isPositiveInt({ v: 5 }) === false, '3-safe-int object 拒絕');
    assert(pp.isNonNegativeInt(Number.MAX_SAFE_INTEGER + 1) === false, '3-safe-int-nonneg MAX_SAFE_INTEGER+1 拒絕（quota_qty/max_orders/sort_order 共用規則）');
    assert(pp.isNonNegativeInt(0) === true, '3-safe-int-nonneg 0 允許（不限量語意）');

    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'SafeIntTest', 'SafeIntLoc');
      const base = {
        campaign_id: campaignId, name: 'X', pickup_date: '2028-02-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2028-01-01T00:00', order_cutoff_at: '2028-01-31T00:00', location_id: locationId, product_scope: 'all_takeout',
      };
      const rBigMaxOrders = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: 9007199254740992 } });
      assert(rBigMaxOrders.status === 400, '3-http max_orders=2^53 回 400（不會因 SQLite/JSON 自動轉型而通過）', JSON.stringify(rBigMaxOrders));
      const rBig1e20 = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: 1e20 } });
      assert(rBig1e20.status === 400, '3-http max_orders=1e20 回 400', JSON.stringify(rBig1e20));
      const rBigQuota = await call('POST', '/api/popup-pickup/sessions', {
        token: T1, body: { ...base, product_scope: 'selected', products: [{ product_id: 101, quota_qty: Number.MAX_SAFE_INTEGER + 1 }] },
      });
      assert(rBigQuota.status === 400, '3-http quota_qty=MAX_SAFE_INTEGER+1 回 400', JSON.stringify(rBigQuota));
      const rOkMax = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: Number.MAX_SAFE_INTEGER } });
      assert(rOkMax.status === 201, '3-http max_orders=MAX_SAFE_INTEGER 允許', JSON.stringify(rOkMax));

      const rc2 = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'RevSafeIntTest' } });
      const s2 = await makeSession(T1, rc2.json.data.id, locationId);
      const rBadRev = await call('PATCH', `/api/popup-pickup/sessions/${s2.id}`, { token: T1, body: { expected_revision: Number.MAX_SAFE_INTEGER + 1, sort_order: 1 } });
      assert(rBadRev.status === 400, '3-http expected_revision=MAX_SAFE_INTEGER+1 回 400（安全整數規則）', JSON.stringify(rBadRev));
    }

    // ════════════════════════════════════════════════════════════════
    // 四、poisoned-data store scope 測試
    // ════════════════════════════════════════════════════════════════
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'PoisonTest', 'PoisonLoc');
      const s = await makeSession(T1, campaignId, locationId, { product_scope: 'selected', products: [{ product_id: 101, quota_qty: 5 }] });

      db._db.run('INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES (?,?,?,?,?)',
        ['store_002', s.id, 201, 1, 99]);
      db._save();

      const r = await call('GET', `/api/popup-pickup/sessions/${s.id}`, { token: T1 });
      const productIds = r.json.data.products.map((p) => p.product_id);
      assert(!productIds.includes(201), '4-poisoned-data GET /sessions/:id 不會混入 store_002 的 poisoned product_id=201', JSON.stringify(productIds));
      assert(productIds.includes(101), '4-poisoned-data 仍正確回傳 store_001 自己的 product_id=101', JSON.stringify(productIds));

      const rp = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: s.revision, products: [{ product_id: 101, quota_qty: 7 }] },
      });
      assert(rp.status === 200, '4-poisoned-data PATCH 替換 products 成功', JSON.stringify(rp));
      const poisonedStillThere = db.get("SELECT id FROM popup_session_products WHERE store_id='store_002' AND session_id=? AND product_id=201", [s.id]);
      assert(!!poisonedStillThere, '4-poisoned-data PATCH 不會誤刪 store_002 的髒資料列（DELETE 有正確帶 store_id 範圍，只清自己的）', JSON.stringify(poisonedStillThere));
    }
    {
      const rc2 = await call('POST', '/api/popup-pickup/campaigns', { token: T2, body: { name: 'Store2OnlyCampaign' } });
      await call('PATCH', `/api/popup-pickup/campaigns/${rc2.json.data.id}`, { token: T2, body: { status: 'published' } });
      const { locationId } = await makeCampaignLocation(T1, 'PoisonCampaignHost', 'PoisonCampaignLoc');
      const fakeSessionId = require('uuid').v4();
      db._db.run(
        `INSERT INTO popup_sessions (id, store_id, campaign_id, public_code, name, pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at, location_id, status, product_scope, max_orders, sort_order, revision)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [fakeSessionId, 'store_001', rc2.json.data.id, 'poison-camp-code-' + Date.now(), 'PoisonedSession', '2028-03-01', '10:00', '11:00', '2028-02-01T00:00:00+08:00', '2028-02-28T00:00:00+08:00', locationId, 'published', 'all_takeout', 0, 0]
      );
      db._save();
      const r = await call('GET', `/api/popup-pickup/sessions/${fakeSessionId}`, { token: T1 });
      assert(r.status === 200, '4-poisoned-campaign session 仍可正常查得（store scope 是自己的）', JSON.stringify(r.status));
      assert(r.json.data.effective_state === 'archived', '4-poisoned-campaign campaign 不屬於 store_001 時，campaign 狀態查詢安全 fallback 成 archived，不會誤用 store_002 campaign 的 published 狀態讓其顯示為可訂購', JSON.stringify(r.json.data));
    }

    // ════════════════════════════════════════════════════════════════
    // 五、布林輸入嚴格正規化
    // ════════════════════════════════════════════════════════════════
    {
      const rLoc = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'BoolTest', address: 'Addr', active: 'false' } });
      assert(rLoc.status === 400, '5-bool-strict location active="false"（字串）回 400（不是 truthy coercion 成 true）', JSON.stringify(rLoc));
      const rLoc2 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'BoolTest2', address: 'Addr', active: 'yes' } });
      assert(rLoc2.status === 400, '5-bool-strict location active="yes" 回 400', JSON.stringify(rLoc2));
      const rLoc3 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'BoolTest3', address: 'Addr', active: '0' } });
      assert(rLoc3.status === 201 && rLoc3.json.data.active === false, '5-bool-strict location active="0"（字串）正確正規化為 false', JSON.stringify(rLoc3.json.data));
      const rLoc4 = await call('PATCH', `/api/popup-pickup/locations/${rLoc3.json.data.id}`, { token: T1, body: { active: 'false' } });
      assert(rLoc4.status === 400, '5-bool-strict PATCH location active="false" 同樣回 400', JSON.stringify(rLoc4));

      const { campaignId, locationId } = await makeCampaignLocation(T1, 'BoolProdTest', 'BoolProdLoc');
      const rSess = await call('POST', '/api/popup-pickup/sessions', {
        token: T1,
        body: {
          campaign_id: campaignId, name: 'X', pickup_date: '2028-04-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
          order_open_at: '2028-03-01T00:00', order_cutoff_at: '2028-03-31T00:00', location_id: locationId,
          product_scope: 'selected', products: [{ product_id: 101, quota_qty: 1, enabled: 'false' }],
        },
      });
      assert(rSess.status === 400, '5-bool-strict session product enabled="false" 回 400', JSON.stringify(rSess));
    }

    // ════════════════════════════════════════════════════════════════
    // 六、archived session 終止狀態一致性
    // ════════════════════════════════════════════════════════════════
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'ArchivedSessionTest', 'ArchivedLoc');
      const s = await makeSession(T1, campaignId, locationId);
      const rArchive = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, { token: T1, body: { expected_revision: s.revision, status: 'archived' } });
      assert(rArchive.status === 200 && rArchive.json.data.status === 'archived', '6-archived 第一次設定 status=archived 成功（無訂單，不需確認）', JSON.stringify(rArchive));

      const rRestore = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: rArchive.json.data.revision, status: 'published' },
      });
      assert(rRestore.status === 409 && rRestore.json.error === 'POPUP_SESSION_ARCHIVED_IMMUTABLE', '6-archived archived session 不得被 PATCH 恢復成 published，回結構化 409', JSON.stringify(rRestore));

      const rTouchSortOrder = await call('PATCH', `/api/popup-pickup/sessions/${s.id}`, {
        token: T1, body: { expected_revision: rArchive.json.data.revision, sort_order: 9 },
      });
      assert(rTouchSortOrder.status === 409 && rTouchSortOrder.json.error === 'POPUP_SESSION_ARCHIVED_IMMUTABLE', '6-archived archived session 連非 protected 欄位（sort_order）也不得修改', JSON.stringify(rTouchSortOrder));

      const afterRow = db.get('SELECT status, revision FROM popup_sessions WHERE id=?', [s.id]);
      assert(afterRow.status === 'archived' && afterRow.revision === rArchive.json.data.revision, '6-archived 兩次被拒絕的 PATCH 完全沒有變動 DB', JSON.stringify(afterRow));
    }

    // ════════════════════════════════════════════════════════════════
    // 七、真正的 fault-injection transaction 測試
    // ════════════════════════════════════════════════════════════════
    {
      const { campaignId, locationId } = await makeCampaignLocation(T1, 'FaultInjectBatch', 'FaultLoc');
      const beforeSessions = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
      const beforeProducts = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE store_id=?', ['store_001']).c;

      const originalRun = db._db.run.bind(db._db);
      let insertSessionCallCount = 0;
      let saveCalledDuringInjection = false;
      const originalSave = db._save.bind(db);
      db._save = (...args) => { saveCalledDuringInjection = true; return originalSave(...args); };
      db._db.run = (...args) => {
        const sql = String(args[0]);
        if (sql.includes('INSERT INTO popup_sessions')) {
          insertSessionCallCount += 1;
          if (insertSessionCallCount === 2) {
            throw new Error('INJECTED FAILURE: forced popup_sessions INSERT failure (fault-injection test)');
          }
        }
        return originalRun(...args);
      };

      let r;
      try {
        r = await call('POST', '/api/popup-pickup/sessions/batch', {
          token: T1,
          body: {
            campaign_id: campaignId,
            sessions: [
              { name: 'FI-1', pickup_date: '2028-05-01', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2028-04-01T00:00', order_cutoff_at: '2028-04-30T00:00', location_id: locationId, product_scope: 'selected', products: [{ product_id: 101, quota_qty: 3 }] },
              { name: 'FI-2', pickup_date: '2028-05-02', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2028-04-01T00:00', order_cutoff_at: '2028-04-30T00:00', location_id: locationId, product_scope: 'all_takeout' },
            ],
          },
        });
      } finally {
        db._db.run = originalRun;
        db._save = originalSave;
      }

      assert(r.status === 500 && r.json.error === 'POPUP_INTERNAL_ERROR', '7-fault-injection 第 2 筆 INSERT 被強制拋錯，API 回安全的 500', JSON.stringify(r));
      const afterSessions = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
      const afterProducts = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE store_id=?', ['store_001']).c;
      assert(afterSessions === beforeSessions, '7-fault-injection session delta=0（第 1 筆也被 ROLLBACK，證明是真的 transaction rollback，不是 pre-validation 僥倖躲過）', `before=${beforeSessions} after=${afterSessions}`);
      assert(afterProducts === beforeProducts, '7-fault-injection session_products delta=0', `before=${beforeProducts} after=${afterProducts}`);
      assert(saveCalledDuringInjection === false, '7-fault-injection _save() 在失敗的 transaction 後完全沒有被呼叫', String(saveCalledDuringInjection));
    }

  } finally {
    if (server) { try { server.close(); } catch (e) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); process.exitCode = 1; });
