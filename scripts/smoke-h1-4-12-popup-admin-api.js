#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-admin-api.js
// H1.4.12 Phase 2｜快閃取餐排程中心 — 管理端 API 真實 HTTP 測試。
// 真實 sql.js 暫存資料庫 + 真實 Express router + 真實 HTTP request/response +
// 真實 staff JWT（jsonwebtoken 簽發，middleware/storeGuard 驗證）。
// 不使用 regex 搜尋程式文字代替行為測試。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 2 popup pickup admin API (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-admin-api-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-12-phase2';

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  let server = null;
  try {

  // ── 測試店家：store_001（已存在）、store_002（有 line_order 授權）、
  //    store_003（沒有 line_order 授權）───────────────────────────────
  db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`,
    ['store_002', 'Store Two', 'Manager2', 'pro', 1]);
  db._db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`,
    ['store_003', 'Store Three (No License)', 'Manager3', 'basic', 1]);
  const features = JSON.stringify({ line_order: true, orders: true, products: true });
  db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
    ['store_001', '脆豬腰', 'pro', 1, features]);
  db._db.run(`INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
    ['store_002', 'Store Two', 'pro', 1, features]);
  // store_003 故意不建立 licenses 列，getStoreLicense() 對未知 store 的預設值
  // features.line_order=false，requireFeature('line_order') 應回 403。

  // 商品：store_001 有 id=101/102，store_002 有 id=201（跨店關聯測試用）。
  db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled) VALUES
    (101, 'store_001', '排骨飯', '主食', 120, 1),
    (102, 'store_001', '珍珠奶茶', '飲料', 60, 1),
    (201, 'store_002', 'Store2 商品', '主食', 100, 1)`);
  db._save();

  // ── 真實 Express app + 真實 HTTP server ──────────────────────────
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/popup-pickup', require('../routes/popup-pickup'));
  app.use('/api/settings', require('../middleware/storeGuard').requireStore, require('../routes/settings'));

  const server2 = http.createServer(app);
  server = server2;
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  function tokenFor(storeId, role = 'store') {
    return jwt.sign({ role, store_id: storeId, store_name: storeId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  }
  async function call(method, urlPath, { token, body, headers, query } = {}) {
    let url = `${base}${urlPath}`;
    if (query) url += `?${new URLSearchParams(query).toString()}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  const T1 = tokenFor('store_001');
  const T2 = tokenFor('store_002');
  const T3 = tokenFor('store_003');

  // ══════════════════════════════════════════════════════════════════
  // 1. 授權邊界
  // ══════════════════════════════════════════════════════════════════
  {
    const r = await call('GET', '/api/popup-pickup/campaigns');
    assert(r.status === 401, '1-auth 無 JWT 存取 GET /campaigns 回 401', JSON.stringify(r));
  }
  {
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: T3 });
    assert(r.status === 403 && r.json.error === 'FEATURE_DISABLED', '1-auth 無 line_order 授權的 store_003 回 403 FEATURE_DISABLED', JSON.stringify(r));
  }
  {
    // query/x-store-id 不得冒充管理員 store——用 store_001 JWT，但夾帶
    // store_002 的 query/x-store-id，建立的資料必須落在 store_001。
    const r = await call('POST', '/api/popup-pickup/campaigns', {
      token: T1,
      query: { store_id: 'store_002' },
      headers: { 'x-store-id': 'store_002' },
      body: { name: 'JWT 覆蓋測試活動' },
    });
    assert(r.status === 201, '2-jwt-override POST 成功建立', JSON.stringify(r));
    const row = db.get('SELECT store_id FROM popup_campaigns WHERE id=?', [r.json.data.id]);
    assert(row && row.store_id === 'store_001', '2-jwt-override 實際寫入 store_001（JWT），未被 query/x-store-id 覆蓋為 store_002', JSON.stringify(row));
    // 清掉，避免影響後續列表計數
    db._db.run('DELETE FROM popup_campaigns WHERE id=?', [r.json.data.id]);
    db._save();
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. Campaign CRUD + 跨店 404 + archived 終止狀態
  // ══════════════════════════════════════════════════════════════════
  let campaignId, campaignIdStore2;
  {
    const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '桃園九月巡迴快閃', description: '測試', sort_order: 1 } });
    assert(r.status === 201 && r.json.data.status === 'draft', '3-campaign-crud POST 建立成功、預設 draft', JSON.stringify(r));
    campaignId = r.json.data.id;
    assert(typeof r.json.data.public_code === 'string' && r.json.data.public_code.length >= 20, '3-campaign-crud public_code 由伺服器產生且長度合理（128-bit）', r.json.data.public_code);
  }
  {
    const r2 = await call('POST', '/api/popup-pickup/campaigns', { token: T2, body: { name: 'Store2 活動' } });
    campaignIdStore2 = r2.json.data.id;
  }
  {
    const r = await call('GET', `/api/popup-pickup/campaigns/${campaignId}`, { token: T1 });
    assert(r.status === 200 && r.json.data.name === '桃園九月巡迴快閃', '3-campaign-crud GET 單筆成功', JSON.stringify(r));
  }
  {
    const r = await call('PATCH', `/api/popup-pickup/campaigns/${campaignId}`, { token: T1, body: { status: 'published' } });
    assert(r.status === 200 && r.json.data.status === 'published', '3-campaign-crud PATCH 更新狀態成功', JSON.stringify(r));
  }
  {
    // 跨店：store_002 JWT 存取 store_001 的 campaign → 404（不得回 403 洩漏存在性）
    const r = await call('GET', `/api/popup-pickup/campaigns/${campaignId}`, { token: T2 });
    assert(r.status === 404 && r.json.error === 'POPUP_RESOURCE_NOT_FOUND', '4-cross-store GET 跨店 campaign 回 404', JSON.stringify(r));
    const rp = await call('PATCH', `/api/popup-pickup/campaigns/${campaignId}`, { token: T2, body: { name: 'hacked' } });
    assert(rp.status === 404, '4-cross-store PATCH 跨店 campaign 回 404', JSON.stringify(rp));
    const rd = await call('DELETE', `/api/popup-pickup/campaigns/${campaignId}`, { token: T2 });
    assert(rd.status === 404, '4-cross-store DELETE 跨店 campaign 回 404', JSON.stringify(rd));
  }
  {
    // 兩兩獨立驗證：跨店輸入驗證會在下方 session 段落測試，這裡先驗證
    // 一般欄位驗證（過長/型別錯誤）
    const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '' } });
    assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '5-validation campaign name 空字串回 400', JSON.stringify(r));
    const r2 = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'x', status: 'not-a-status' } });
    assert(r2.status === 400, '5-validation campaign status 非法值回 400', JSON.stringify(r2));
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. Location CRUD + lat/lng 驗證 + 軟刪除 + 不回寫 session snapshot
  // ══════════════════════════════════════════════════════════════════
  let locationId;
  {
    const r = await call('POST', '/api/popup-pickup/locations', {
      token: T1,
      body: { name: '風禾公園', address: '桃園市風禾公園旁停車場', lat: 24.993, lng: 121.301 },
    });
    assert(r.status === 201, '6-location-crud POST 建立成功', JSON.stringify(r));
    locationId = r.json.data.id;
  }
  {
    const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'x', address: 'y', lat: 999, lng: 0 } });
    assert(r.status === 400, '6-location-crud lat 超出範圍回 400', JSON.stringify(r));
    const r2 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'x', address: 'y', lat: 1 } });
    assert(r2.status === 400, '6-location-crud lat 有值但 lng 缺少回 400（必須同時存在或同時為空）', JSON.stringify(r2));
  }
  {
    const rd = await call('DELETE', `/api/popup-pickup/locations/${locationId}`, { token: T2 });
    assert(rd.status === 404, '4-cross-store DELETE 跨店 location 回 404', JSON.stringify(rd));
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. Session：建立、時間/整數驗證、selected products、跨店關聯拒絕
  // ══════════════════════════════════════════════════════════════════
  let sessionId;
  {
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId,
        name: '風禾公園場',
        pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '19:00',
        order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-17T21:00',
        location_id: locationId,
        product_scope: 'selected',
        products: [{ product_id: 101, quota_qty: 30 }, { product_id: 102, quota_qty: 0 }],
        max_orders: 50,
      },
    });
    assert(r.status === 201 && r.json.data.revision === 1, '7-session-create POST 建立成功、revision=1', JSON.stringify(r));
    sessionId = r.json.data.id;
    assert(r.json.data.place_name === '風禾公園' && r.json.data.address === '桃園市風禾公園旁停車場', '7-session-create 地點欄位由後端 location 複製而非信任前端', JSON.stringify(r.json.data));
    assert(Array.isArray(r.json.data.products) && r.json.data.products.length === 2, '7-session-create selected products 正確寫入 2 筆', JSON.stringify(r.json.data.products));
  }
  {
    // 不存在的曆法日期
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-02-30', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-01-01T00:00', order_cutoff_at: '2026-02-01T00:00', location_id: locationId, product_scope: 'all_takeout',
      },
    });
    assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '8-validation 不存在的日期 2026-02-30 回 400', JSON.stringify(r));
  }
  {
    // 時間順序錯誤：cutoff > pickup_start
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-09-18', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-18T10:30', location_id: locationId, product_scope: 'all_takeout',
      },
    });
    assert(r.status === 400, '8-validation order_cutoff_at 晚於 pickup_start_at 回 400', JSON.stringify(r));
  }
  {
    // 停用地點不可用於新場次
    await call('DELETE', `/api/popup-pickup/locations/${locationId}`, { token: T1 }); // 軟停用
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-09-19', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-18T00:00', location_id: locationId, product_scope: 'all_takeout',
      },
    });
    assert(r.status === 400, '8-validation 已停用 location 不可用於新場次回 400', JSON.stringify(r));
    // 還原成 active，後續測試還要用
    const locRow = db.get('SELECT id FROM popup_locations WHERE id=?', [locationId]);
    db._db.run('UPDATE popup_locations SET active=1 WHERE id=?', [locationId]);
    db._save();
  }
  {
    // 跨店 location_id / product_id 關聯拒絕
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-09-20', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-19T00:00',
        location_id: 'nonexistent-or-other-store-location', product_scope: 'all_takeout',
      },
    });
    assert(r.status === 400, '9-cross-store-assoc 不存在／跨店 location_id 回 400', JSON.stringify(r));

    const r2 = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-09-20', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-19T00:00',
        location_id: locationId, product_scope: 'selected', products: [{ product_id: 201, quota_qty: 5 }],
      },
    });
    assert(r2.status === 400, '9-cross-store-assoc store_002 的 product_id=201 不可用於 store_001 場次，回 400', JSON.stringify(r2));

    const r3 = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'X', pickup_date: '2026-09-20', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-19T00:00',
        location_id: locationId, product_scope: 'selected', products: [{ product_id: 101 }, { product_id: 101 }],
      },
    });
    assert(r3.status === 400, '9-cross-store-assoc 同一商品重複出現在 products 回 400', JSON.stringify(r3));
  }
  {
    // location 修改不會回寫既有 session snapshot
    await call('PATCH', `/api/popup-pickup/locations/${locationId}`, { token: T1, body: { address: '地址已變更（不應出現在既有場次）' } });
    const r = await call('GET', `/api/popup-pickup/sessions/${sessionId}`, { token: T1 });
    assert(r.json.data.address === '桃園市風禾公園旁停車場', '10-location-no-rewrite 修改地點庫地址後，既有場次 snapshot 完全不變', JSON.stringify(r.json.data.address));
  }
  {
    // 跨店 session 存取
    const r = await call('GET', `/api/popup-pickup/sessions/${sessionId}`, { token: T2 });
    assert(r.status === 404, '4-cross-store GET 跨店 session 回 404', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. Batch：全成功 + 中途錯誤全批 rollback
  // ══════════════════════════════════════════════════════════════════
  {
    const before = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
    const r = await call('POST', '/api/popup-pickup/sessions/batch', {
      token: T1,
      body: {
        campaign_id: campaignId,
        sessions: [
          { name: 'B1', pickup_date: '2026-10-01', pickup_start_time: '10:00', pickup_end_time: '12:00', order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-30T00:00', location_id: locationId, product_scope: 'all_takeout' },
          { name: 'B2', pickup_date: '2026-10-02', pickup_start_time: '10:00', pickup_end_time: '12:00', order_open_at: '2026-09-01T00:00', order_cutoff_at: '2026-09-30T00:00', location_id: locationId, product_scope: 'all_takeout' },
        ],
      },
    });
    assert(r.status === 201 && r.json.data.length === 2, '11-batch 全成功建立 2 筆', JSON.stringify(r));
    const publicCodes = r.json.data.map((s) => s.public_code);
    assert(new Set(publicCodes).size === 2, '11-batch 兩筆 public_code 各自不同', JSON.stringify(publicCodes));
    const after = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
    assert(after === before + 2, '11-batch DB 實際新增 2 筆', `before=${before} after=${after}`);
  }
  {
    const before = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
    const r = await call('POST', '/api/popup-pickup/sessions/batch', {
      token: T1,
      body: {
        campaign_id: campaignId,
        sessions: [
          { name: 'C1', pickup_date: '2026-11-01', pickup_start_time: '10:00', pickup_end_time: '12:00', order_open_at: '2026-10-01T00:00', order_cutoff_at: '2026-10-30T00:00', location_id: locationId, product_scope: 'all_takeout' },
          { name: 'C2-bad', pickup_date: '2026-11-02', pickup_start_time: '12:00', pickup_end_time: '11:00', order_open_at: '2026-10-01T00:00', order_cutoff_at: '2026-10-30T00:00', location_id: locationId, product_scope: 'all_takeout' },
        ],
      },
    });
    assert(r.status === 400, '12-batch-rollback 第 2 筆時間順序錯誤，整批回 400', JSON.stringify(r));
    const after = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [campaignId]).c;
    assert(after === before, '12-batch-rollback 第 1 筆未被部分寫入，DB 筆數完全不變（全批 rollback）', `before=${before} after=${after}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. Revision 衝突 + 有訂單時二次確認流程 + change log + orders snapshot 不變
  // ══════════════════════════════════════════════════════════════════
  {
    const before = db.get('SELECT pickup_date, revision FROM popup_sessions WHERE id=?', [sessionId]);
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sessionId}`, {
      token: T1, body: { expected_revision: before.revision + 999, name: '改名' },
    });
    assert(r.status === 409 && r.json.error === 'POPUP_SESSION_REVISION_CONFLICT', '13-revision-conflict 錯誤 expected_revision 回 409', JSON.stringify(r));
    const after = db.get('SELECT pickup_date, revision, name FROM popup_sessions WHERE id=?', [sessionId]);
    assert(after.revision === before.revision, '13-revision-conflict revision 未被改變（完全未寫入）', JSON.stringify(after));
  }
  {
    // sort_order 這種非 protected field，不需要確認流程，直接成功並 bump revision。
    const before = db.get('SELECT revision FROM popup_sessions WHERE id=?', [sessionId]);
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sessionId}`, {
      token: T1, body: { expected_revision: before.revision, sort_order: 5 },
    });
    assert(r.status === 200 && r.json.data.revision === before.revision + 1, '14-non-protected sort_order 修改直接成功、revision+1', JSON.stringify(r));
  }
  // 手動插入一筆「已有快閃訂單」模擬（Phase 3 才會有真實下單流程，這裡用直接
  // SQL 建構測試 fixture，驗證 Phase 2 的確認流程邏輯本身）。
  const fakeOrderId = 'popup-test-order-1';
  db._db.run(
    `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, popup_pickup_date_snapshot, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fakeOrderId, fakeOrderId, 'store_001', '快閃顧客', '0999999999', '[]', 'cash', 100, 100, 'takeout', 'completed', 'popup', sessionId, '2026-09-18', new Date().toISOString()]
  );
  db._save();
  {
    const before = db.get('SELECT revision, pickup_date FROM popup_sessions WHERE id=?', [sessionId]);
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sessionId}`, {
      token: T1, body: { expected_revision: before.revision, pickup_date: '2026-09-19' },
    });
    assert(r.status === 409 && r.json.error === 'POPUP_SESSION_CHANGE_CONFIRM_REQUIRED', '15-confirm-required 有訂單時第一次修改 protected field 回 409', JSON.stringify(r));
    assert(r.json.affected_order_count === 1, '15-confirm-required affected_order_count=1', JSON.stringify(r.json));
    assert(Array.isArray(r.json.changed_fields) && r.json.changed_fields.includes('pickup_date'), '15-confirm-required changed_fields 包含 pickup_date', JSON.stringify(r.json.changed_fields));
    const after = db.get('SELECT revision, pickup_date FROM popup_sessions WHERE id=?', [sessionId]);
    assert(after.revision === before.revision && after.pickup_date === before.pickup_date, '15-confirm-required 完全未寫入 session', JSON.stringify(after));
    const logCountBefore = db.get('SELECT COUNT(*) as c FROM popup_session_change_logs WHERE session_id=?', [sessionId]).c;
    assert(logCountBefore === 0, '15-confirm-required 未確認前不寫入 change log', String(logCountBefore));
  }
  {
    // 缺 change_reason
    const before = db.get('SELECT revision FROM popup_sessions WHERE id=?', [sessionId]);
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sessionId}`, {
      token: T1, body: { expected_revision: before.revision, pickup_date: '2026-09-19', confirm_affected_orders: true },
    });
    assert(r.status === 400, '16-confirm-reason 缺少 change_reason 回 400', JSON.stringify(r));
  }
  {
    const before = db.get('SELECT revision FROM popup_sessions WHERE id=?', [sessionId]);
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sessionId}`, {
      token: T1,
      body: { expected_revision: before.revision, pickup_date: '2026-09-19', confirm_affected_orders: true, change_reason: '場地租借時間異動' },
    });
    assert(r.status === 200 && r.json.data.revision === before.revision + 1, '17-confirm-success 確認後成功、revision+1', JSON.stringify(r));
    assert(r.json.data.pickup_date === '2026-09-19', '17-confirm-success pickup_date 已更新', JSON.stringify(r.json.data));

    const logRow = db.get('SELECT * FROM popup_session_change_logs WHERE session_id=? ORDER BY id DESC LIMIT 1', [sessionId]);
    assert(!!logRow, '17-confirm-success change log 已寫入', JSON.stringify(logRow));
    const beforeJson = JSON.parse(logRow.before_json);
    const afterJson = JSON.parse(logRow.after_json);
    assert(beforeJson.pickup_date === '2026-09-18' && afterJson.pickup_date === '2026-09-19', '17-confirm-success change log before/after_json 正確記錄異動內容', JSON.stringify({ beforeJson, afterJson }));
    assert(logRow.change_reason === '場地租借時間異動', '17-confirm-success change_reason 正確寫入', logRow.change_reason);
    assert(logRow.affected_order_count === 1, '17-confirm-success affected_order_count 正確寫入 change log', String(logRow.affected_order_count));

    // 既有 orders snapshot 完全不變（我們手動塞的那筆訂單本身的 snapshot 欄位
    // 不應被這次場次修改回頭改寫——Phase 2 完全沒有寫入 orders 表的程式碼路徑）。
    const orderRow = db.get('SELECT popup_pickup_date_snapshot FROM orders WHERE id=?', [fakeOrderId]);
    assert(orderRow.popup_pickup_date_snapshot === '2026-09-18', '17-confirm-success 既有訂單自己的 snapshot 完全未被場次修改回頭改寫', JSON.stringify(orderRow));
  }
  {
    // DELETE 依賴保護：這個 session 已經有訂單關聯，應該被擋下。
    const r = await call('DELETE', `/api/popup-pickup/sessions/${sessionId}`, { token: T1 });
    assert(r.status === 409 && r.json.error === 'POPUP_SESSION_HAS_DEPENDENCIES', '18-delete-protection 有訂單的場次 DELETE 回 409', JSON.stringify(r));
  }
  {
    // 沒有訂單的場次可以直接 DELETE
    const rc = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'ToDelete', pickup_date: '2026-12-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-11-01T00:00', order_cutoff_at: '2026-11-30T00:00', location_id: locationId, product_scope: 'all_takeout',
      },
    });
    const rd = await call('DELETE', `/api/popup-pickup/sessions/${rc.json.data.id}`, { token: T1 });
    assert(rd.status === 200, '18-delete-protection 沒有訂單的場次可正常刪除', JSON.stringify(rd));
    const gone = db.get('SELECT id FROM popup_sessions WHERE id=?', [rc.json.data.id]);
    assert(!gone, '18-delete-protection 刪除後資料表確實移除該筆', JSON.stringify(gone));
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. all_takeout 清除白名單
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'ScopeSwitch', pickup_date: '2026-12-05', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-11-01T00:00', order_cutoff_at: '2026-12-04T00:00', location_id: locationId,
        product_scope: 'selected', products: [{ product_id: 101, quota_qty: 5 }],
      },
    });
    const sid2 = rc.json.data.id;
    const beforeCount = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE session_id=?', [sid2]).c;
    assert(beforeCount === 1, '19-scope-switch 初始 selected 白名單 1 筆', String(beforeCount));

    const r = await call('PATCH', `/api/popup-pickup/sessions/${sid2}`, {
      token: T1, body: { expected_revision: rc.json.data.revision, product_scope: 'all_takeout' },
    });
    assert(r.status === 200 && r.json.data.product_scope === 'all_takeout', '19-scope-switch PATCH 改成 all_takeout 成功', JSON.stringify(r));
    const afterCount = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE session_id=?', [sid2]).c;
    assert(afterCount === 0, '19-scope-switch 改成 all_takeout 後，舊白名單資料已清除', String(afterCount));
  }
  {
    // selected products 替換：換成不同的商品組合
    const rc = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: campaignId, name: 'ReplaceProducts', pickup_date: '2026-12-06', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-11-01T00:00', order_cutoff_at: '2026-12-05T00:00', location_id: locationId,
        product_scope: 'selected', products: [{ product_id: 101, quota_qty: 5 }],
      },
    });
    const sid3 = rc.json.data.id;
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sid3}`, {
      token: T1,
      body: { expected_revision: rc.json.data.revision, products: [{ product_id: 102, quota_qty: 8 }] },
    });
    assert(r.status === 200, '20-products-replace PATCH 替換 products 成功', JSON.stringify(r));
    const rows = db.all('SELECT product_id, quota_qty FROM popup_session_products WHERE session_id=?', [sid3]);
    assert(rows.length === 1 && rows[0].product_id === 102 && rows[0].quota_qty === 8, '20-products-replace 舊商品 101 被移除、新商品 102 正確寫入', JSON.stringify(rows));
  }

  // ══════════════════════════════════════════════════════════════════
  // 8. Campaign 有場次時 DELETE 409；無場次時可刪除；archived 不可再 PATCH
  // ══════════════════════════════════════════════════════════════════
  {
    const r = await call('DELETE', `/api/popup-pickup/campaigns/${campaignId}`, { token: T1 });
    assert(r.status === 409 && r.json.error === 'POPUP_CAMPAIGN_HAS_SESSIONS', '21-campaign-delete 有場次的活動 DELETE 回 409', JSON.stringify(r));
  }
  {
    const rd = await call('DELETE', `/api/popup-pickup/campaigns/${campaignIdStore2}`, { token: T2 });
    assert(rd.status === 200, '21-campaign-delete 無場次的活動可直接刪除', JSON.stringify(rd));
  }
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'ArchiveMe' } });
    const cid = rc.json.data.id;
    await call('PATCH', `/api/popup-pickup/campaigns/${cid}`, { token: T1, body: { status: 'archived' } });
    const r = await call('PATCH', `/api/popup-pickup/campaigns/${cid}`, { token: T1, body: { status: 'published' } });
    assert(r.status === 409 && r.json.error === 'POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE', '22-archived-immutable archived 活動不得被一般 PATCH 無聲恢復', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════
  // 9. feature flag 正規化與 line_order license gate（routes/settings.js）
  // ══════════════════════════════════════════════════════════════════
  {
    const r = await call('PUT', '/api/settings', { query: { store_id: 'store_001' }, body: { popup_pickup_enabled: true } });
    assert(r.status === 200, '23-feature-flag true 正規化寫入成功', JSON.stringify(r));
    const row = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'");
    assert(row && row.value === '1', '23-feature-flag 落地正規化為字串 "1"', JSON.stringify(row));
  }
  for (const bad of [null, [], {}, 'true', 'yes']) {
    const r = await call('PUT', '/api/settings', { query: { store_id: 'store_001' }, body: { popup_pickup_enabled: bad } });
    assert(r.status === 400, `24-feature-flag-invalid popup_pickup_enabled=${JSON.stringify(bad)} 回 400`, JSON.stringify(r));
  }
  {
    // 未送出此 key 不得影響既有值
    await call('PUT', '/api/settings', { query: { store_id: 'store_001' }, body: { popup_pickup_enabled: '0' } });
    const before = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'").value;
    await call('PUT', '/api/settings', { query: { store_id: 'store_001' }, body: { shop_name: '不動 popup flag' } });
    const after = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'").value;
    assert(before === after, '25-feature-flag-untouched 未送出 popup_pickup_enabled 時既有值不變', `before=${before} after=${after}`);
  }
  {
    const r = await call('GET', '/api/settings', { query: { store_id: 'store_001' } });
    assert(Object.prototype.hasOwnProperty.call(r.json.data, 'popup_pickup_enabled'), '26-feature-flag-get GET /api/settings 正常回傳此 key', JSON.stringify(Object.keys(r.json.data)));
  }
  {
    // operation flag 關閉時（目前是 '0'）管理 API 仍可正常管理資料。
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: T1 });
    assert(r.status === 200, '27-flag-off-still-manageable popup_pickup_enabled=0 時管理 API 仍可讀取資料', JSON.stringify(r.status));
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '關閉開關時仍可建立' } });
    assert(rc.status === 201, '27-flag-off-still-manageable popup_pickup_enabled=0 時仍可建立新活動', JSON.stringify(rc));
  }

  // ══════════════════════════════════════════════════════════════════
  // 10（本輪新增）：畸形／過期／錯誤簽章 JWT
  // ══════════════════════════════════════════════════════════════════
  {
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: 'not-a-real-jwt-at-all' });
    assert(r.status === 401, '28-jwt-malformed 畸形 JWT 回 401', JSON.stringify(r));
  }
  {
    const wrongSecretToken = jwt.sign({ role: 'store', store_id: 'store_001' }, 'wrong-secret-entirely', { expiresIn: '1h' });
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: wrongSecretToken });
    assert(r.status === 401, '28-jwt-wrong-signature 錯誤簽章 JWT 回 401', JSON.stringify(r));
  }
  {
    const expiredToken = jwt.sign({ role: 'store', store_id: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '-1h' });
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: expiredToken });
    assert(r.status === 401, '28-jwt-expired 過期 JWT 回 401', JSON.stringify(r));
  }
  {
    const superAdminToken = jwt.sign({ role: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: superAdminToken });
    assert(r.status === 403, '28-jwt-super-admin super_admin token 不可直接用於店家管理 API，回 403', JSON.stringify(r));
  }
  {
    const noStoreToken = jwt.sign({ role: 'store' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const r = await call('GET', '/api/popup-pickup/campaigns', { token: noStoreToken });
    assert(r.status === 401, '28-jwt-no-store Token 缺少 store_id 回 401', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════
  // 11（本輪新增）：store 身分覆寫防護——PATCH/DELETE 也不得被 body/query/
  // header 的 store_id 覆寫（POST 已於第 2 節驗證過）。
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: '身分覆寫防護測試' } });
    const cid = rc.json.data.id;
    // 用 store_001 JWT，PATCH body 夾帶 store_id=store_002，驗證仍然正確更新
    // store_001 自己的活動（因為 route 完全不讀 body.store_id，只用 req.storeId）。
    const r = await call('PATCH', `/api/popup-pickup/campaigns/${cid}`, {
      token: T1, body: { store_id: 'store_002', name: '改名後仍屬於 store_001' },
    });
    assert(r.status === 200, '29-store-override-patch PATCH 成功（body.store_id 被忽略）', JSON.stringify(r));
    const row = db.get('SELECT store_id, name FROM popup_campaigns WHERE id=?', [cid]);
    assert(row.store_id === 'store_001' && row.name === '改名後仍屬於 store_001', '29-store-override-patch 實際仍寫在 store_001，未被 body.store_id 覆蓋', JSON.stringify(row));

    // DELETE 也一樣：body/query 夾帶別店 store_id 不應讓別店能刪除或誤刪。
    const rd = await call('DELETE', `/api/popup-pickup/campaigns/${cid}`, {
      token: T2, query: { store_id: 'store_001' }, headers: { 'x-store-id': 'store_001' },
    });
    assert(rd.status === 404, '29-store-override-delete store_002 JWT 即使夾帶 store_id=store_001 的 query/header，仍視為 store_002 的操作，對 store_001 資源回 404', JSON.stringify(rd));
    const stillThere = db.get('SELECT id FROM popup_campaigns WHERE id=?', [cid]);
    assert(!!stillThere, '29-store-override-delete 該活動確實未被刪除', JSON.stringify(stillThere));
  }

  // ══════════════════════════════════════════════════════════════════
  // 12（本輪新增）：public_code 唯一衝突時確實 retry（而非直接失敗）
  // ══════════════════════════════════════════════════════════════════
  {
    const crypto = require('crypto');
    const popupPickup = require('../utils/popupPickup');
    const collidingCode = 'FORCED-COLLISION-CODE-001';
    // 先預埋一個會與「下一次產生的第一個 code」衝突的既有列，透過 monkey-patch
    // generatePublicCode 讓它第一次回傳這個已存在的 code，第二次才回傳真隨機值，
    // 驗證 routes/popup-pickup.js 的 generateUniquePublicCode() 真的會重試。
    db._db.run(`INSERT INTO popup_campaigns (id, store_id, public_code, name, status) VALUES (?,?,?,?,?)`,
      [require('uuid').v4(), 'store_001', collidingCode, '預埋衝突用', 'draft']);
    db._save();

    const original = popupPickup.generatePublicCode;
    let callCount = 0;
    popupPickup.generatePublicCode = () => {
      callCount += 1;
      return callCount === 1 ? collidingCode : original();
    };
    try {
      const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'Retry 測試活動' } });
      assert(r.status === 201, '30-public-code-retry 唯一衝突時仍成功建立（有重試）', JSON.stringify(r));
      assert(r.json.data.public_code !== collidingCode, '30-public-code-retry 最終拿到的 public_code 不是衝突值', r.json.data.public_code);
      assert(callCount >= 2, '30-public-code-retry generatePublicCode 確實被呼叫超過一次（證明重試發生）', String(callCount));
    } finally {
      popupPickup.generatePublicCode = original;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 13（本輪新增）：change log 內容只包含允許欄位，且由伺服器產生
  // （不信任 client 傳入的 before/after JSON）。
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'ChangeLogTest 活動' } });
    const cid2 = rc.json.data.id;
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'CL Loc', address: 'CL Addr', lat: 25, lng: 121 } });
    const lid2 = rl.json.data.id;
    const rs = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: cid2, name: 'CL場次', pickup_date: '2027-01-10', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2026-12-01T00:00', order_cutoff_at: '2027-01-09T00:00', location_id: lid2, product_scope: 'all_takeout',
      },
    });
    const sid4 = rs.json.data.id;
    const fakeOrder2 = 'cl-test-order-1';
    db._db.run(
      `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fakeOrder2, fakeOrder2, 'store_001', 'CL顧客', '0988888888', '[]', 'cash', 50, 50, 'takeout', 'completed', 'popup', sid4, new Date().toISOString()]
    );
    db._save();

    // 嘗試在 body 塞入偽造的 before_json/after_json/change_reason 帶有惡意內容，
    // 驗證伺服器完全忽略這些欄位，change log 內容仍是伺服器自己讀出來的 allowlist snapshot。
    const forged = {
      expected_revision: rs.json.data.revision,
      pickup_start_time: '10:30',
      confirm_affected_orders: true,
      change_reason: '正常原因',
      before_json: { hacked: true, secret_token: 'should-not-appear' },
      after_json: { hacked: true },
    };
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sid4}`, { token: T1, body: forged });
    assert(r.status === 200, '31-changelog-server-authoritative 確認修改成功', JSON.stringify(r));
    const logRow = db.get('SELECT * FROM popup_session_change_logs WHERE session_id=? ORDER BY id DESC LIMIT 1', [sid4]);
    const beforeJ = JSON.parse(logRow.before_json);
    const afterJ = JSON.parse(logRow.after_json);
    assert(!('hacked' in beforeJ) && !('secret_token' in beforeJ), '31-changelog-server-authoritative client 偽造的 before_json 欄位完全未進入 change log', JSON.stringify(beforeJ));
    assert(!('hacked' in afterJ), '31-changelog-server-authoritative client 偽造的 after_json 欄位完全未進入 change log', JSON.stringify(afterJ));
    const allowedKeys = ['name', 'pickup_date', 'pickup_start_time', 'pickup_end_time', 'order_open_at', 'order_cutoff_at',
      'location_id', 'place_name', 'place_id', 'address', 'address_note', 'lat', 'lng', 'status', 'product_scope', 'max_orders', 'products'];
    const beforeKeysOk = Object.keys(beforeJ).every((k) => allowedKeys.includes(k));
    assert(beforeKeysOk, '31-changelog-server-authoritative before_json 只包含允許的欄位（allowlist）', JSON.stringify(Object.keys(beforeJ)));
  }

  // ══════════════════════════════════════════════════════════════════
  // 14（本輪新增）：session PATCH 缺少 expected_revision 回 400
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'NoRevisionTest' } });
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'NR Loc', address: 'NR Addr' } });
    const rs = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: rc.json.data.id, name: 'NR場次', pickup_date: '2027-02-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2027-01-01T00:00', order_cutoff_at: '2027-01-31T00:00', location_id: rl.json.data.id, product_scope: 'all_takeout',
      },
    });
    const r = await call('PATCH', `/api/popup-pickup/sessions/${rs.json.data.id}`, { token: T1, body: { name: '沒帶 expected_revision' } });
    assert(r.status === 400 && r.json.error === 'POPUP_VALIDATION_ERROR', '32-missing-expected-revision 缺少 expected_revision 回 400 POPUP_VALIDATION_ERROR', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════
  // 15（本輪新增）：max_orders / quota 型別邊界（負數、非整數）
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'MaxOrdersTest' } });
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'MO Loc', address: 'MO Addr' } });
    const base = {
      campaign_id: rc.json.data.id, name: 'MO場次', pickup_date: '2027-03-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
      order_open_at: '2027-02-01T00:00', order_cutoff_at: '2027-02-28T00:00', location_id: rl.json.data.id, product_scope: 'all_takeout',
    };
    const rNeg = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: -1 } });
    assert(rNeg.status === 400, '33-max-orders-negative max_orders=-1 回 400', JSON.stringify(rNeg));
    const rFloat = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: 1.5 } });
    assert(rFloat.status === 400, '33-max-orders-float max_orders=1.5 回 400', JSON.stringify(rFloat));
    const rZero = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, max_orders: 0 } });
    assert(rZero.status === 201 && rZero.json.data.max_orders === 0, '33-max-orders-zero max_orders=0（不限量）允許', JSON.stringify(rZero));

    const rQuotaNeg = await call('POST', '/api/popup-pickup/sessions', {
      token: T1, body: { ...base, product_scope: 'selected', products: [{ product_id: 101, quota_qty: -5 }] },
    });
    assert(rQuotaNeg.status === 400, '33-quota-negative quota_qty=-5 回 400', JSON.stringify(rQuotaNeg));
  }

  // ══════════════════════════════════════════════════════════════════
  // 16（本輪新增）：selected scope 至少一項商品
  // ══════════════════════════════════════════════════════════════════
  {
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'EmptyProductsTest' } });
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'EP Loc', address: 'EP Addr' } });
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: rc.json.data.id, name: 'EP場次', pickup_date: '2027-04-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2027-03-01T00:00', order_cutoff_at: '2027-03-31T00:00', location_id: rl.json.data.id,
        product_scope: 'selected', products: [],
      },
    });
    assert(r.status === 400, '34-selected-empty product_scope=selected 但 products 為空陣列回 400', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════
  // 17（本輪新增）：500 response 不得洩漏內部細節（模擬 DB 層錯誤）
  // ══════════════════════════════════════════════════════════════════
  {
    const originalGet = db.get.bind(db);
    let triggered = false;
    db.get = (...args) => {
      if (!triggered && String(args[0]).includes('FROM popup_campaigns WHERE id=? AND store_id=?')) {
        triggered = true;
        throw new Error(`simulated internal failure at /secret/path/to/pos.db with SQL: ${args[0]}`);
      }
      return originalGet(...args);
    };
    try {
      const r = await call('GET', '/api/popup-pickup/campaigns/any-id-triggering-lookup', { token: T1 });
      assert(r.status === 500 && r.json.error === 'POPUP_INTERNAL_ERROR', '35-internal-error-safe 內部錯誤回 500 POPUP_INTERNAL_ERROR', JSON.stringify(r));
      const bodyText = JSON.stringify(r.json);
      assert(!/secret\/path|pos\.db|SELECT .* FROM/i.test(bodyText), '35-internal-error-safe response 不含 SQL 內容、檔案路徑或 stack trace', bodyText);
    } finally {
      db.get = originalGet;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 18（本輪新增）：補強缺口——public_code/snapshot 不信任 client、
  // product_id 型別邊界、quota 浮點數、batch 筆數上下限、batch rollback
  // 涵蓋 session_products、確認流程 revision 二次檢查、allocation-only
  // 依賴阻擋 DELETE、cancelled 走確認流程、settings 更多非法值、
  // settings 透過 JWT scope、location DELETE 後直接驗證 active=0。
  // ══════════════════════════════════════════════════════════════════
  {
    // public_code 不接受 client 指定：即使 body 夾帶 public_code，伺服器仍自己產生。
    const forgedCode = 'CLIENT-FORGED-PUBLIC-CODE';
    const r = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'ForgedCodeTest', public_code: forgedCode } });
    assert(r.status === 201 && r.json.data.public_code !== forgedCode, '36-public-code-not-client-supplied client 指定的 public_code 被忽略，伺服器自行產生', JSON.stringify(r.json.data.public_code));
  }
  {
    // session snapshot 欄位（place_name/address/place_id/lat/lng）不信任 client：
    // 即使 body 夾帶這些欄位，一律以後端 location 資料為準。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'SnapshotForgeTest' } });
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: '真實地點', address: '真實地址', lat: 22, lng: 120 } });
    const r = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: {
        campaign_id: rc.json.data.id, name: 'SF場次', pickup_date: '2027-05-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
        order_open_at: '2027-04-01T00:00', order_cutoff_at: '2027-04-30T00:00', location_id: rl.json.data.id, product_scope: 'all_takeout',
        place_name: '偽造地點', address: '偽造地址', place_id: '偽造PlaceID', lat: 0, lng: 0,
      },
    });
    assert(r.status === 201 && r.json.data.place_name === '真實地點' && r.json.data.address === '真實地址' && Number(r.json.data.lat) === 22,
      '37-snapshot-not-client-supplied body 偽造的 snapshot 欄位完全被忽略，一律用後端 location 資料', JSON.stringify(r.json.data));
  }
  {
    // product_id 型別邊界：0、負數、字串一律拒絕。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'ProductIdTypeTest' } });
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'PT Loc', address: 'PT Addr' } });
    const base = {
      campaign_id: rc.json.data.id, name: 'PT場次', pickup_date: '2027-06-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
      order_open_at: '2027-05-01T00:00', order_cutoff_at: '2027-05-31T00:00', location_id: rl.json.data.id, product_scope: 'selected',
    };
    for (const badId of [0, -1, 'abc', 1.5]) {
      const r = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, products: [{ product_id: badId, quota_qty: 1 }] } });
      assert(r.status === 400, `38-product-id-type product_id=${JSON.stringify(badId)} 回 400`, JSON.stringify(r));
    }
    const rFloatQty = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: { ...base, products: [{ product_id: 101, quota_qty: 2.5 }] } });
    assert(rFloatQty.status === 400, '38-quota-float quota_qty=2.5（非整數）回 400', JSON.stringify(rFloatQty));
  }
  {
    // batch 筆數上下限：0 筆與 101 筆都應拒絕。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'BatchBoundsTest' } });
    const r0 = await call('POST', '/api/popup-pickup/sessions/batch', { token: T1, body: { campaign_id: rc.json.data.id, sessions: [] } });
    assert(r0.status === 400, '39-batch-bounds 0 筆回 400', JSON.stringify(r0));
    const template = {
      name: 'X', pickup_date: '2027-07-01', pickup_start_time: '10:00', pickup_end_time: '11:00',
      order_open_at: '2027-06-01T00:00', order_cutoff_at: '2027-06-30T00:00', location_id: null, product_scope: 'all_takeout',
    };
    const rl2 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'BB Loc', address: 'BB Addr' } });
    const many = Array.from({ length: 101 }, () => ({ ...template, location_id: rl2.json.data.id }));
    const r101 = await call('POST', '/api/popup-pickup/sessions/batch', { token: T1, body: { campaign_id: rc.json.data.id, sessions: many } });
    assert(r101.status === 400, '39-batch-bounds 101 筆回 400（上限 100）', JSON.stringify(r101));
  }
  {
    // batch rollback 涵蓋 popup_session_products：第一筆帶 selected products 成功
    // 驗證通過，第二筆時間順序錯誤觸發整批失敗，第一筆的 session_products 也
    // 不得殘留（因為第一筆的 session 本身也必須整批消失）。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'BatchProductsRollbackTest' } });
    const rl3 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'BPR Loc', address: 'BPR Addr' } });
    const beforeSessions = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [rc.json.data.id]).c;
    const beforeProducts = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE store_id=?', ['store_001']).c;
    const r = await call('POST', '/api/popup-pickup/sessions/batch', {
      token: T1,
      body: {
        campaign_id: rc.json.data.id,
        sessions: [
          { name: 'BPR-OK', pickup_date: '2027-08-01', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2027-07-01T00:00', order_cutoff_at: '2027-07-31T00:00', location_id: rl3.json.data.id, product_scope: 'selected', products: [{ product_id: 101, quota_qty: 3 }] },
          { name: 'BPR-BAD', pickup_date: '2027-08-02', pickup_start_time: '12:00', pickup_end_time: '11:00', order_open_at: '2027-07-01T00:00', order_cutoff_at: '2027-07-31T00:00', location_id: rl3.json.data.id, product_scope: 'all_takeout' },
        ],
      },
    });
    assert(r.status === 400, '40-batch-rollback-products 第 2 筆失敗，整批回 400', JSON.stringify(r));
    const afterSessions = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=?', [rc.json.data.id]).c;
    const afterProducts = db.get('SELECT COUNT(*) as c FROM popup_session_products WHERE store_id=?', ['store_001']).c;
    assert(afterSessions === beforeSessions, '40-batch-rollback-products 第 1 筆 session 也未殘留', `before=${beforeSessions} after=${afterSessions}`);
    assert(afterProducts === beforeProducts, '40-batch-rollback-products 第 1 筆的 selected products 也未殘留', `before=${beforeProducts} after=${afterProducts}`);
  }
  {
    // 確認修改時，即使帶 confirm_affected_orders:true，錯誤的 expected_revision
    // 仍必須回 409 revision conflict，不得因為有 confirm 旗標就略過版本檢查。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'ConfirmRevisionCheckTest' } });
    const rl4 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'CRC Loc', address: 'CRC Addr' } });
    const rs = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: { campaign_id: rc.json.data.id, name: 'CRC場次', pickup_date: '2027-09-01', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2027-08-01T00:00', order_cutoff_at: '2027-08-31T00:00', location_id: rl4.json.data.id, product_scope: 'all_takeout' },
    });
    const sid5 = rs.json.data.id;
    db._db.run(
      `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['crc-order-1', 'crc-order-1', 'store_001', 'x', '0900000001', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', sid5, new Date().toISOString()]
    );
    db._save();
    const r = await call('PATCH', `/api/popup-pickup/sessions/${sid5}`, {
      token: T1,
      body: { expected_revision: rs.json.data.revision + 999, pickup_start_time: '10:30', confirm_affected_orders: true, change_reason: '測試' },
    });
    assert(r.status === 409 && r.json.error === 'POPUP_SESSION_REVISION_CONFLICT', '41-confirm-still-checks-revision confirm_affected_orders=true 時，錯誤的 expected_revision 仍回 409 revision conflict', JSON.stringify(r));
  }
  {
    // allocation-only 依賴也應阻擋 DELETE（即使沒有 orders）。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'AllocOnlyDeleteTest' } });
    const rl5 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'AO Loc', address: 'AO Addr' } });
    const rs = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: { campaign_id: rc.json.data.id, name: 'AO場次', pickup_date: '2027-10-01', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2027-09-01T00:00', order_cutoff_at: '2027-09-30T00:00', location_id: rl5.json.data.id, product_scope: 'all_takeout' },
    });
    const sid6 = rs.json.data.id;
    db._db.run('INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)',
      ['store_001', sid6, 'ao-fake-order', 101, 1, 'active']);
    db._save();
    const r = await call('DELETE', `/api/popup-pickup/sessions/${sid6}`, { token: T1 });
    assert(r.status === 409 && r.json.error === 'POPUP_SESSION_HAS_DEPENDENCIES', '42-alloc-only-delete-block 只有 allocation、沒有 orders 的場次同樣不得 DELETE', JSON.stringify(r));
  }
  {
    // 取消場次應走 PATCH status=cancelled，有訂單時同樣遵循確認流程。
    const rc = await call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'CancelFlowTest' } });
    const rl6 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'CF Loc', address: 'CF Addr' } });
    const rs = await call('POST', '/api/popup-pickup/sessions', {
      token: T1,
      body: { campaign_id: rc.json.data.id, name: 'CF場次', pickup_date: '2027-11-01', pickup_start_time: '10:00', pickup_end_time: '11:00', order_open_at: '2027-10-01T00:00', order_cutoff_at: '2027-10-31T00:00', location_id: rl6.json.data.id, product_scope: 'all_takeout' },
    });
    const sid7 = rs.json.data.id;
    db._db.run(
      `INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, order_status, pickup_type, popup_session_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['cf-order-1', 'cf-order-1', 'store_001', 'x', '0900000002', '[]', 'cash', 10, 10, 'takeout', 'completed', 'popup', sid7, new Date().toISOString()]
    );
    db._save();
    const r1 = await call('PATCH', `/api/popup-pickup/sessions/${sid7}`, { token: T1, body: { expected_revision: rs.json.data.revision, status: 'cancelled' } });
    assert(r1.status === 409 && r1.json.error === 'POPUP_SESSION_CHANGE_CONFIRM_REQUIRED', '43-cancel-confirm-flow 有訂單時 PATCH status=cancelled 第一次也回 409 需要確認', JSON.stringify(r1));
    const r2 = await call('PATCH', `/api/popup-pickup/sessions/${sid7}`, {
      token: T1, body: { expected_revision: rs.json.data.revision, status: 'cancelled', confirm_affected_orders: true, change_reason: '場地取消' },
    });
    assert(r2.status === 200 && r2.json.data.status === 'cancelled', '43-cancel-confirm-flow 確認後成功取消', JSON.stringify(r2));
  }
  {
    // settings 更多非法值：字串 'false'、數字 2。
    for (const bad of ['false', 2]) {
      const r = await call('PUT', '/api/settings', { query: { store_id: 'store_001' }, body: { popup_pickup_enabled: bad } });
      assert(r.status === 400, `44-feature-flag-more-invalid popup_pickup_enabled=${JSON.stringify(bad)} 回 400`, JSON.stringify(r));
    }
  }
  {
    // GET /api/settings 透過 JWT（Authorization header，不靠 query）取得正確 store scope。
    const r = await call('GET', '/api/settings', { token: T1 });
    assert(r.status === 200 && Object.prototype.hasOwnProperty.call(r.json.data, 'popup_pickup_enabled'), '45-settings-jwt-scope 透過 JWT 取得的 settings 仍包含 popup_pickup_enabled', JSON.stringify(r.status));
  }
  {
    // location DELETE 後直接驗證 DB 內 active=0（軟停用，非硬刪）。
    const r = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'SoftDeleteCheck', address: 'SDC Addr' } });
    const lid3 = r.json.data.id;
    await call('DELETE', `/api/popup-pickup/locations/${lid3}`, { token: T1 });
    const row = db.get('SELECT active FROM popup_locations WHERE id=?', [lid3]);
    assert(row && row.active === 0, '46-location-soft-delete DELETE 後 DB 內確實是 active=0（軟停用非硬刪）', JSON.stringify(row));
    const stillExists = db.get('SELECT id FROM popup_locations WHERE id=?', [lid3]);
    assert(!!stillExists, '46-location-soft-delete 該筆資料仍存在於資料表（未被硬刪除）', JSON.stringify(stillExists));
  }

  // ══════════════════════════════════════════════════════════════════
  // R44.2F.1：popup admin／settings durable mutation——每種代表案例注入 disk failure（rename／write／fsync），
  // 驗證固定 503、memory／disk hash／fresh process 皆 before-state、無 temp 殘留、後續無關 save 不復活、retry 只生效一次。
  // ══════════════════════════════════════════════════════════════════
  {
    const crypto2 = require('crypto'); const { execFile } = require('child_process'); const execP = require('util').promisify(execFile);
    const dbFile = process.env.POS_DB_PATH, dbDir = require('path').dirname(dbFile);
    const fileSha = () => crypto2.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const freshDisk = async (sql) => JSON.parse((await execP('node', ['-e', `const i=require('sql.js');i().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: require('path').join(__dirname, '..'), env: process.env })).stdout.trim().split('\n').pop());
    const FAULTS = {
      rename: () => { const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; }; },
      write: () => { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; },
      fsync: () => { const o = fs.fsyncSync; fs.fsyncSync = function () { throw new Error('inj fsync'); }; return () => { fs.fsyncSync = o; }; },
    };
    async function adminDiskCase(label, fault, spec) {
      const memBefore = JSON.stringify(spec.mem()), h0 = fileSha(), bytes0 = fs.readFileSync(dbFile), diskBefore = JSON.stringify(await freshDisk(spec.diskSql));
      const undo = FAULTS[fault](); let r; try { r = await spec.run(); } finally { undo(); }
      const tag = `R44.2F.1-admin-${label}-${fault}`;
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj|tmp|\.db|SELECT|INSERT|UPDATE|\/tmp/i.test(JSON.stringify(r.json)), `${tag}-safe-503 API 收到固定 503 STORAGE_UNAVAILABLE（不是成功、不含 path／SQL）`, JSON.stringify(r).slice(0, 140));
      assert(JSON.stringify(spec.mem()) === memBefore, `${tag}-memory-before memory 維持 before-state`, JSON.stringify({ memBefore, now: spec.mem() }));
      assert(fileSha() === h0 && Buffer.compare(fs.readFileSync(dbFile), bytes0) === 0 && JSON.stringify(await freshDisk(spec.diskSql)) === diskBefore, `${tag}-disk-before DB 檔 SHA-256／bytes 與 fresh child process 讀回皆為 before-state`, '');
      assert(fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-')).length === 0, `${tag}-no-temp-residue 無 temp 檔殘留`, '');
      await call('PATCH', `/api/popup-pickup/locations/${lidOther}`, { token: T1, body: { address: '無關 save ' + label + fault } }); // 之後任何一次成功 save
      assert(JSON.stringify(spec.mem()) === memBefore && JSON.stringify(await freshDisk(spec.diskSql)) === diskBefore, `${tag}-not-resurrected 之後無關的成功 save 不會讓失敗的 mutation 復活（memory＋disk）`, '');
      const retry = await spec.run();
      assert(retry.status < 300 && JSON.stringify(spec.mem()) !== memBefore && JSON.stringify(await freshDisk(spec.diskSql)) !== diskBefore, `${tag}-retry-once retry 成功一次，memory＝fresh process 一致`, `status=${retry.status}`);
    }
    const rl = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'R44F1 other', address: 'x', lat: 24.9, lng: 121.3 } });
    const lidOther = rl.json.data.id;
    // campaign create
    await adminDiskCase('campaign-create', 'rename', { run: () => call('POST', '/api/popup-pickup/campaigns', { token: T1, body: { name: 'R44F1-campaign' } }), mem: () => db.get("SELECT COUNT(*) AS c FROM popup_campaigns WHERE name='R44F1-campaign'").c, diskSql: "SELECT COUNT(*) FROM popup_campaigns WHERE name='R44F1-campaign'" });
    // location soft-delete
    const rl2 = await call('POST', '/api/popup-pickup/locations', { token: T1, body: { name: 'R44F1 del', address: 'y', lat: 24.8, lng: 121.2 } });
    const lidDel = rl2.json.data.id;
    await adminDiskCase('location-soft-delete', 'write', { run: () => call('DELETE', `/api/popup-pickup/locations/${lidDel}`, { token: T1 }), mem: () => db.get('SELECT active FROM popup_locations WHERE id=?', [lidDel]).active, diskSql: `SELECT active FROM popup_locations WHERE id='${lidDel}'` });
    // session batch create（整批）
    const mkSess = (n) => ({ name: n, pickup_date: '2026-12-01', pickup_start_time: '10:00', pickup_end_time: '12:00', order_open_at: '2026-11-01T00:00', order_cutoff_at: '2026-11-30T00:00', location_id: lidOther, product_scope: 'all_takeout' });
    await adminDiskCase('session-batch', 'rename', { run: () => call('POST', '/api/popup-pickup/sessions/batch', { token: T1, body: { campaign_id: campaignId, sessions: [mkSess('R44F1-B1'), mkSess('R44F1-B2')] } }), mem: () => db.get("SELECT COUNT(*) AS c FROM popup_sessions WHERE name LIKE 'R44F1-B%'").c, diskSql: "SELECT COUNT(*) FROM popup_sessions WHERE name LIKE 'R44F1-B%'" });
    // session update with revision
    const rs = await call('POST', '/api/popup-pickup/sessions', { token: T1, body: Object.assign({ campaign_id: campaignId }, mkSess('R44F1-S')) });
    const sid = rs.json.data.id;
    let nextOrder = 50;
    await adminDiskCase('session-update-revision', 'fsync', { run: () => { const cur = db.get('SELECT revision FROM popup_sessions WHERE id=?', [sid]).revision; return call('PATCH', `/api/popup-pickup/sessions/${sid}`, { token: T1, body: { expected_revision: cur, sort_order: nextOrder++ } }); }, mem: () => { const r = db.get('SELECT revision, sort_order FROM popup_sessions WHERE id=?', [sid]); return [r.revision, r.sort_order]; }, diskSql: `SELECT revision, sort_order FROM popup_sessions WHERE id='${sid}'` });
    // settings：popup_pickup_enabled
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'"); db._save();
    await adminDiskCase('settings-popup-enabled', 'rename', { run: () => call('PUT', '/api/settings', { token: T1, body: { popup_pickup_enabled: true } }), mem: () => { const r = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'"); return r ? r.value : null; }, diskSql: "SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'" });
    assert(db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'").value === '1', 'R44.2F.1-admin-settings-final-value retry 後 popup_pickup_enabled 為 1', '');
  }

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    if (server) { try { server.close(); } catch (e) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); process.exitCode = 1; });
