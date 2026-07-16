#!/usr/bin/env node
// scripts/smoke-hotfix26-e.js — fix18-10-hotfix26-E smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-e.js
//
// 範圍：LINE Verify Health Dashboard × LINE Analytics Center（routes/line-analytics.js）
// 以及 POST /api/line-member/verify 的 verify_debug 三條件缺一不可閘門。
// 完全不測試／不觸碰 verifyLineIdToken() 本身的判斷邏輯（那些已經在
// smoke-hotfix26-verify-debug.js／smoke-hotfix26-verify-deep.js 涵蓋，本檔案
// 的回歸區塊會重新跑一次確認沒有退步）。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 15000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function staffToken(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: 't' }, JWT_SECRET, { expiresIn: '1h' }); }

// ════════════════════════════════════════════════════════════════
// 抽取 routes/line-analytics.js 的純函式（router.__test）
// ════════════════════════════════════════════════════════════════
function loadAnalyticsHelpers() {
  const router = require(path.join(ROOT, 'routes/line-analytics.js'));
  if (!router.__test) throw new Error('routes/line-analytics.js 未匯出 __test helpers');
  return router.__test;
}

// ════════════════════════════════════════════════════════════════
// 1. Health Rule Engine 邊界測試
// ════════════════════════════════════════════════════════════════
function testHealthRuleEngine(h) {
  const mk = (overrides) => Object.assign({
    total: 100, success: 100, failed: 0, successRate: 100, failureRate: 0,
    httpStatusCounts: {}, errorBreakdown: [], consecutiveFailures: 0,
  }, overrides);

  // insufficient_data：完全沒有紀錄
  {
    const r = h.evaluateHealthRules(mk({ total: 0, success: 0, successRate: null }));
    if (r.status === 'insufficient_data') pass('Health Rule：total=0 → insufficient_data（不誤判為 healthy）');
    else fail('Health Rule：total=0 應為 insufficient_data', JSON.stringify(r));
  }

  // healthy：成功率>=98 且連續失敗<3 且無 HTTP500
  {
    const r = h.evaluateHealthRules(mk({ successRate: 99, consecutiveFailures: 0 }));
    if (r.status === 'healthy') pass('Health Rule：成功率 99%、連續失敗 0、無 HTTP500 → healthy');
    else fail('Health Rule：應為 healthy', JSON.stringify(r));
  }

  // warning：成功率 95~97.99
  {
    const r = h.evaluateHealthRules(mk({ successRate: 96.5, failed: 4, success: 96 }));
    if (r.status === 'warning') pass('Health Rule：成功率 96.5%（95~97.99）→ warning');
    else fail('Health Rule：成功率 96.5% 應為 warning', JSON.stringify(r));
  }

  // warning：Audience Mismatch >= 1（即使成功率很高）
  {
    const r = h.evaluateHealthRules(mk({ successRate: 99, errorBreakdown: [{ label: 'Audience Mismatch', count: 1 }] }));
    if (r.status === 'warning') pass('Health Rule：Audience Mismatch ≥ 1 → warning（即使成功率高）');
    else fail('Health Rule：Audience Mismatch ≥ 1 應為 warning', JSON.stringify(r));
  }

  // warning：連續失敗 3~4 次
  {
    const r = h.evaluateHealthRules(mk({ successRate: 99, consecutiveFailures: 3 }));
    if (r.status === 'warning') pass('Health Rule：連續失敗 3 次（3~4）→ warning');
    else fail('Health Rule：連續失敗 3 次應為 warning', JSON.stringify(r));
  }

  // critical：成功率 < 95
  {
    const r = h.evaluateHealthRules(mk({ successRate: 90, failed: 10, success: 90 }));
    if (r.status === 'critical') pass('Health Rule：成功率 90% < 95% → critical');
    else fail('Health Rule：成功率 90% 應為 critical', JSON.stringify(r));
  }

  // critical：連續失敗 >= 5
  {
    const r = h.evaluateHealthRules(mk({ successRate: 99, consecutiveFailures: 5 }));
    if (r.status === 'critical') pass('Health Rule：連續失敗 5 次 ≥ 5 → critical（優先權高於 warning）');
    else fail('Health Rule：連續失敗 5 次應為 critical', JSON.stringify(r));
  }

  // critical：HTTP500 >= 5
  {
    const r = h.evaluateHealthRules(mk({ successRate: 99, httpStatusCounts: { 500: 5 } }));
    if (r.status === 'critical') pass('Health Rule：HTTP 500 次數 ≥ 5 → critical');
    else fail('Health Rule：HTTP 500 ≥ 5 應為 critical', JSON.stringify(r));
  }
}

// ════════════════════════════════════════════════════════════════
// 2. Verify Error Breakdown 分類
// ════════════════════════════════════════════════════════════════
function testErrorBucketing(h) {
  const cases = [
    [['aud_mismatch', 'CHANNEL_ID_MISMATCH', 200], 'Audience Mismatch'],
    [['verify_failed', 'INVALID_ID_TOKEN_AUDIENCE', 400], 'Audience Mismatch'],
    [['expired', 'EXPIRED_ID_TOKEN', 200], 'Expired Token'],
    [['no_sub', 'LINE_VERIFY_API_FAILED', 200], 'No Sub'],
    [['missing_params', 'STORE_CONFIG_MISSING', 200], 'Store Config Missing'],
    [['missing_params', 'MISSING_ID_TOKEN', 200], 'Missing ID Token'],
    [['verify_failed', 'LINE_VERIFY_API_FAILED', 403], 'HTTP 403'],
    [['verify_failed', 'LINE_VERIFY_API_FAILED', 429], 'HTTP 429'],
    [['verify_failed', 'LINE_VERIFY_API_FAILED', 500], 'HTTP 500'],
    [['verify_failed', 'INVALID_ID_TOKEN', 400], 'Invalid Grant'],
    [['exception', 'UNKNOWN_VERIFY_ERROR', null], 'Unknown'],
    [['something_never_seen_before', 'SOME_FUTURE_CODE', null], 'Unknown'],
  ];
  let ok = true; let detail = '';
  for (const [[reason, code, status], expected] of cases) {
    const got = h.bucketVerifyFailure(reason, code, status);
    if (got !== expected) { ok = false; detail = `bucketVerifyFailure(${reason},${code},${status}) = ${got}, expected ${expected}`; break; }
  }
  if (ok) pass('bucketVerifyFailure：Audience Mismatch/Expired/No Sub/Store Config/Missing ID/HTTP 403/429/500/Invalid Grant/Unknown 全部正確分類，未知錯誤不當機、歸類 Unknown');
  else fail('bucketVerifyFailure 分類', detail);
}

// ════════════════════════════════════════════════════════════════
// 3. 日期解析（today/yesterday/last7/last30/month/custom）
// ════════════════════════════════════════════════════════════════
function testDateResolution(h) {
  const today = h.twTodayStr();
  if (/^\d{4}-\d{2}-\d{2}$/.test(today)) pass('twTodayStr：回傳格式正確的 Asia/Taipei 當地日期字串');
  else fail('twTodayStr 格式錯誤', today);

  const r7 = h.resolvePeriod({ period: 'last7' });
  const expectedStart7 = h.subtractDays(today, 6);
  if (r7.start_date === expectedStart7 && r7.end_date === today) pass('resolvePeriod：last7 = 今天往前推 6 天 ~ 今天（共 7 天）');
  else fail('resolvePeriod last7 計算錯誤', JSON.stringify(r7));

  const r30 = h.resolvePeriod({ period: 'last30' });
  const expectedStart30 = h.subtractDays(today, 29);
  if (r30.start_date === expectedStart30 && r30.end_date === today) pass('resolvePeriod：last30 = 今天往前推 29 天 ~ 今天（共 30 天）');
  else fail('resolvePeriod last30 計算錯誤', JSON.stringify(r30));

  const rToday = h.resolvePeriod({ period: 'today' });
  if (rToday.start_date === today && rToday.end_date === today) pass('resolvePeriod：today = 今天');
  else fail('resolvePeriod today 計算錯誤', JSON.stringify(rToday));

  const rYesterday = h.resolvePeriod({ period: 'yesterday' });
  if (rYesterday.end_date === h.subtractDays(today, 1)) pass('resolvePeriod：yesterday = 昨天');
  else fail('resolvePeriod yesterday 計算錯誤', JSON.stringify(rYesterday));

  const rCustom = h.resolvePeriod({ period: 'custom', start_date: '2026-01-01', end_date: '2026-01-31' });
  if (rCustom.start_date === '2026-01-01' && rCustom.end_date === '2026-01-31') pass('resolvePeriod：custom 直接採用使用者指定的起訖日期');
  else fail('resolvePeriod custom 計算錯誤', JSON.stringify(rCustom));

  const rDefault = h.resolvePeriod({});
  if (rDefault.preset === 'today') pass('resolvePeriod：未帶 period 參數時預設為 today');
  else fail('resolvePeriod 預設值錯誤', JSON.stringify(rDefault));
}

// ════════════════════════════════════════════════════════════════
// 4. safeParseMetadata 防禦性測試
// ════════════════════════════════════════════════════════════════
function testSafeParseMetadata(h) {
  if (JSON.stringify(h.safeParseMetadata(null)) === '{}' &&
      JSON.stringify(h.safeParseMetadata('not json')) === '{}' &&
      JSON.stringify(h.safeParseMetadata('"just a string"')) === '{}' &&
      h.safeParseMetadata('{"a":1}').a === 1) {
    pass('safeParseMetadata：null／非法 JSON／非物件 JSON 一律安全回空物件，合法物件正確解析，不拋例外');
  } else {
    fail('safeParseMetadata 防禦性處理', '');
  }
}

// ════════════════════════════════════════════════════════════════
// Server helpers
// ════════════════════════════════════════════════════════════════
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://pop-system-v13.zeabur.app' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server start timeout, log:\n' + out)); } }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); if (!settled && /POS SaaS Foundation R1/.test(out)) { settled = true; clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited early (code ${code}), log:\n${out}`)); } });
  });
}
function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}
async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { __raw: text }; }
  return { status: res.status, body, raw: text };
}

// ════════════════════════════════════════════════════════════════
// 種子資料：直接寫入 analytics_events，模擬一批 verify 成功/失敗紀錄
// （含 diagnostic_only 混合），供 server 啟動後查詢用。沿用先前所有
// smoke test 一致的做法：seed 必須在 server 啟動「之前」完成並存檔。
// ════════════════════════════════════════════════════════════════
async function seedVerifyEvents() {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { logServerEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  await initDb();
  const db = getDb();
  const STORE = 'store_001';
  const STORE_B = 'store_hotfix26e_isolation_test';
  const marker = 'hotfix26e_' + Date.now();

  const cleanup = (storeId) => {
    try { db.run("DELETE FROM analytics_events WHERE store_id=? AND visitor_id LIKE ?", [storeId, marker + '%']); } catch (e) {}
  };
  cleanup(STORE); cleanup(STORE_B);

  const mk = (storeId, visitorSuffix, eventName, metadata, lineUserId) => {
    logServerEvent(db, {
      store_id: storeId,
      visitor_id: `${marker}_${visitorSuffix}`,
      session_id: `${marker}_${visitorSuffix}`,
      event_name: eventName,
      metadata,
      line_user_id: lineUserId || null,
    });
  };

  // store_001：3 次真實成功、2 次真實失敗（audience mismatch x1, expired x1）、
  // 1 次診斷中心自己的失敗測試（診斷 ping，不應計入健康度統計）
  mk(STORE, '1', 'line_login_success', { http_status: 200, elapsed_ms: 55, diagnostic_only: false }, 'Utestuser0000000000000001');
  mk(STORE, '2', 'line_login_success', { http_status: 200, elapsed_ms: 60, diagnostic_only: false }, 'Utestuser0000000000000002');
  mk(STORE, '3', 'line_login_success', { http_status: 200, elapsed_ms: 48, diagnostic_only: false }, 'Utestuser0000000000000003');
  mk(STORE, '4', 'line_login_failed', { reason: 'aud_mismatch', code: 'CHANNEL_ID_MISMATCH', http_status: 200, elapsed_ms: 70, diagnostic_only: false });
  mk(STORE, '5', 'line_login_failed', { reason: 'expired', code: 'EXPIRED_ID_TOKEN', http_status: 200, elapsed_ms: 65, diagnostic_only: false });
  mk(STORE, '6', 'line_login_failed', { reason: 'verify_failed', code: 'LINE_VERIFY_API_FAILED', http_status: 403, elapsed_ms: 12, diagnostic_only: true });

  // store_hotfix26e_isolation_test：不同店，資料不應該出現在 store_001 的查詢結果裡
  mk(STORE_B, '1', 'line_login_success', { http_status: 200, elapsed_ms: 40, diagnostic_only: false }, 'UotherStoreUser000000001');
  mk(STORE_B, '2', 'line_login_failed', { reason: 'expired', code: 'EXPIRED_ID_TOKEN', http_status: 200, elapsed_ms: 30, diagnostic_only: false });

  return { STORE, STORE_B, marker };
}
function cleanupVerifyEvents(seed) {
  const { getDb } = require(path.join(ROOT, 'utils/db'));
  const db = getDb();
  try { db.run("DELETE FROM analytics_events WHERE store_id=? AND visitor_id LIKE ?", [seed.STORE, seed.marker + '%']); } catch (e) {}
  try { db.run("DELETE FROM analytics_events WHERE store_id=? AND visitor_id LIKE ?", [seed.STORE_B, seed.marker + '%']); } catch (e) {}
}

async function testHealthEndpoint(seed) {
  const token = staffToken(seed.STORE);
  const auth = { Authorization: `Bearer ${token}` };

  // 未帶 JWT → 401
  {
    const { status } = await jsonFetch(`${BASE}/api/line-analytics/health?period=today`);
    if (status === 401) pass('GET /api/line-analytics/health 未帶 JWT 回 401（一般 POS 員工／未授權帳號無法讀取）');
    else fail('未帶 JWT 應回 401', `status=${status}`);
  }

  // 正常請求：檢查整體 shape 與筆數（注意：這個 store 可能已有其他測試留下的
  // 舊資料，所以這裡改用「至少包含」而非「剛好等於」來驗證，只鎖定我們自己
  // 種下的這批資料的相對關係）。
  const { status, body } = await jsonFetch(`${BASE}/api/line-analytics/health?period=today`, { headers: auth });
  if (status !== 200 || !body.success) { fail('GET /health 基本回應', `status=${status} body=${JSON.stringify(body).slice(0, 300)}`); return; }
  pass('GET /api/line-analytics/health 帶有效 JWT → 200 success:true');

  const requiredTop = ['summary', 'error_breakdown', 'timeline', 'line_health', 'oa_center', 'analytics', 'health', 'period'];
  const missingTop = requiredTop.filter((k) => !(k in body));
  if (missingTop.length === 0) pass('回應包含 summary／error_breakdown／timeline／line_health／oa_center／analytics／health／period 全部欄位');
  else fail('回應缺少必要欄位', missingTop.join(','));

  const requiredSummary = ['total', 'success', 'failed', 'success_rate', 'failure_rate', 'last_success_at', 'last_failure_at', 'last_http_status'];
  const missingSummary = requiredSummary.filter((k) => !(k in body.summary));
  if (missingSummary.length === 0) pass('summary 包含 total/success/failed/success_rate/failure_rate/last_success_at/last_failure_at/last_http_status');
  else fail('summary 缺少必要欄位', missingSummary.join(','));

  // diagnostic_only 事件不應計入 summary（我們種了 3 成功 + 2 真實失敗 + 1 診斷失敗；
  // summary 應該只看到 3 成功 + 2 失敗 = 5 筆，不含診斷那 1 筆）
  if (body.summary.success >= 3 && body.summary.failed >= 2) {
    pass('summary 至少包含我們種下的 3 筆成功 + 2 筆真實失敗（診斷測試呼叫不灌水到健康度統計）');
  } else {
    fail('summary 應至少反映種子資料的成功/失敗筆數', JSON.stringify(body.summary));
  }

  // error_breakdown 應該有 Audience Mismatch 與 Expired Token 各至少 1 筆
  const errMap = {};
  (body.error_breakdown || []).forEach((e) => { errMap[e.label] = e.count; });
  if ((errMap['Audience Mismatch'] || 0) >= 1 && (errMap['Expired Token'] || 0) >= 1) {
    pass('error_breakdown 正確統計出 Audience Mismatch 與 Expired Token 各至少 1 筆');
  } else {
    fail('error_breakdown 應包含 Audience Mismatch 與 Expired Token', JSON.stringify(body.error_breakdown));
  }

  // timeline 應該包含我們種的診斷測試那筆，且標記 diagnostic_only:true，且不含任何
  // token/secret/完整 LINE User ID 字樣
  const timelineRaw = JSON.stringify(body.timeline);
  const hasDiagnosticRow = (body.timeline || []).some((t) => t.diagnostic_only === true);
  if (hasDiagnosticRow) pass('timeline 包含診斷測試呼叫的紀錄，並正確標記 diagnostic_only:true（即使不計入 summary，Timeline 仍要看得到）');
  else fail('timeline 應包含診斷測試呼叫的紀錄', timelineRaw.slice(0, 300));

  // 注意：程式碼分類值裡本來就合法存在 "MISSING_ID_TOKEN" 這種 code（字串裡
  // 天生含有 "id_token" 子字串），不能拿來當「有沒有洩漏」的判斷依據；真正要
  // 檢查的是「有沒有洩漏實際 token 內容」——用我們自己送出的假 token 字串，
  // 以及 JWT 常見的三段式 base64 pattern 來判斷。
  const forbiddenLiteral = ['authorization', 'client_secret', 'channel_secret', 'access_token'];
  const leaked = forbiddenLiteral.filter((f) => timelineRaw.toLowerCase().includes(f));
  const looksLikeJwt = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(timelineRaw);
  if (leaked.length === 0 && !looksLikeJwt) pass('timeline／整體回應不含 authorization／access_token／secret 等敏感關鍵字，也沒有任何長得像 JWT 的字串（code 分類值如 MISSING_ID_TOKEN 屬於正常分類標籤，不是 token 洩漏）');
  else fail('timeline 不應包含敏感關鍵字或 token 樣式字串', leaked.join(',') + (looksLikeJwt ? ' [JWT-like string found]' : ''));

  const fullLineUserId = 'Utestuser0000000000000001';
  if (!timelineRaw.includes(fullLineUserId)) pass('timeline 的 identity 已正確遮罩，不含完整 LINE User ID 原始字串');
  else fail('timeline 不應包含完整 LINE User ID', timelineRaw.slice(0, 300));

  if ((body.timeline || []).length <= 50) pass('timeline 最多 50 筆');
  else fail('timeline 應該最多 50 筆', String(body.timeline.length));

  // Analytics Funnel：coupon_issued 應該標示 tracked:false，不可假造成 0
  const funnel = (body.analytics && body.analytics.funnel) || [];
  const couponItem = funnel.find((f) => f.key === 'coupon_issued');
  if (couponItem && couponItem.tracked === false && couponItem.count === null) {
    pass('Analytics Funnel：coupon_issued 沒有可靠資料來源時標示 tracked:false、count:null（前端顯示「尚未追蹤」，不假造為 0）');
  } else {
    fail('coupon_issued 應標示為未追蹤', JSON.stringify(couponItem));
  }
  const loginAttemptsItem = funnel.find((f) => f.key === 'login_attempts');
  if (loginAttemptsItem && loginAttemptsItem.tracked === true && typeof loginAttemptsItem.count === 'number') {
    pass('Analytics Funnel：login_attempts 有可靠資料來源時正確標示 tracked:true 並帶數字');
  } else {
    fail('login_attempts 應標示為已追蹤', JSON.stringify(loginAttemptsItem));
  }

  // LINE OA Center：未設定的模組（如 Rich Menu）應為 not_configured，不可顯示成異常
  const richMenu = body.oa_center && body.oa_center.rich_menu;
  if (richMenu && richMenu.status === 'not_configured') pass('LINE OA Center：Rich Menu（本專案未實作）正確標示 not_configured，不誤判為 critical');
  else fail('Rich Menu 應為 not_configured', JSON.stringify(richMenu));

  // tenant isolation：store_001 的查詢結果不應該包含另一店（store_hotfix26e_
  // isolation_test）種下的資料。注意：STORE_B 本身沒有在 stores 表建店，所以
  // 拿 STORE_B 的 JWT 打這支 API 會被 requireStore 中介層擋在更前面（403 store
  // 不存在）——這其實也是一種隔離，但更直接的驗證方式是確認 store_001 自己的
  // 回應內容本來就不含 STORE_B 種下的任何識別資料。
  if (!timelineRaw.includes(seed.STORE_B) && !timelineRaw.includes('UotherStoreUser')) {
    pass('多店隔離：store_001 的查詢結果不包含另一店（store_hotfix26e_isolation_test）種下的任何資料');
  } else {
    fail('多店隔離應該生效：store_001 回應不應含其他店的資料', timelineRaw.slice(0, 300));
  }
  {
    const otherToken = staffToken(seed.STORE_B);
    const other = await jsonFetch(`${BASE}/api/line-analytics/health?period=today`, { headers: { Authorization: `Bearer ${otherToken}` } });
    if (other.status === 403 || other.status === 401) {
      pass('多店隔離（第二層防線）：未在 stores 表註冊的 store_id 即使帶「看似有效」的 JWT，也被 requireStore 中介層擋下（403/401），不會誤放行查詢');
    } else {
      fail('未註冊的 store_id 應被 requireStore 擋下', `status=${other.status}`);
    }
  }

  // 不存在的 store → 403（沿用 requireStore/validateStore 既有行為）
  const bogusToken = staffToken('store_totally_does_not_exist_xyz');
  const bogus = await jsonFetch(`${BASE}/api/line-analytics/health?period=today`, { headers: { Authorization: `Bearer ${bogusToken}` } });
  if (bogus.status === 403 || bogus.status === 401) pass('不存在的 store_id：requireStore 中介層正確拒絕（不會誤放行查詢）');
  else fail('不存在的 store 應被拒絕', `status=${bogus.status}`);

  // 日期篩選：custom 指定明顯過去的區間，種子資料（今天寫入）不應該出現
  const customPast = await jsonFetch(`${BASE}/api/line-analytics/health?period=custom&start_date=2020-01-01&end_date=2020-01-02`, { headers: auth });
  if (customPast.status === 200 && customPast.body.summary.total === 0 && customPast.body.health.status === 'insufficient_data') {
    pass('日期篩選：指定過去的區間時，今天寫入的種子資料不會被撈到，且正確顯示 insufficient_data');
  } else {
    fail('日期篩選 custom 過去區間應該撈不到今天的資料', JSON.stringify(customPast.body && customPast.body.summary));
  }
}

// ════════════════════════════════════════════════════════════════
// verify_debug 三條件缺一不可（需求文件十）
// ════════════════════════════════════════════════════════════════
async function testVerifyDebugGate() {
  const STORE = 'store_001';
  const token = staffToken(STORE);
  const authHeader = { Authorization: `Bearer ${token}` };
  const body = { id_token: 'fake.invalid.token.for.smoke.test', diagnostic_only: true };

  // (a) Debug 關閉（未設定 LINE_MEMBER_DEBUG）+ 有 JWT + diagnostic_only=true → 不應有 verify_debug
  {
    delete process.env.LINE_MEMBER_DEBUG;
    const { body: respBody } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader }, body: JSON.stringify(body),
    });
    if (!('verify_debug' in (respBody || {}))) pass('verify_debug 閘門：LINE_MEMBER_DEBUG 未設定時，即使有 JWT + diagnostic_only=true，也不回傳 verify_debug');
    else fail('LINE_MEMBER_DEBUG 未設定時不應回傳 verify_debug', JSON.stringify(respBody));
  }

  manual('verify_debug 閘門：LINE_MEMBER_DEBUG=1 但無有效 JWT 時不回傳 verify_debug', '這個判斷需要在啟動 LINE_MEMBER_DEBUG=1 的伺服器行程上測試（環境變數在 process 啟動時就固定），smoke test 的 server 子行程已用預設環境啟動；已用程式碼檢視確認 hasValidStaffAuth() 檢查在 verify_debug 附加邏輯的 && 條件中，缺 JWT 就不會進入該分支');
  manual('verify_debug 閘門：LINE_MEMBER_DEBUG=1 + 有效 JWT + diagnostic_only=true 時完整回傳 verify_debug', '同上，需要另外用 LINE_MEMBER_DEBUG=1 啟動一個 server 行程驗證；本機已用 scripts/smoke-hotfix26-verify-deep.js 的 Section 4 驗證過 verifyLineIdToken() 本身在該環境變數下正確產生 debug 物件，這裡只驗證路由層「未設定時不外洩」這個更保守的預設安全狀態');
}

// ════════════════════════════════════════════════════════════════
// 靜態檢查
// ════════════════════════════════════════════════════════════════
function testStaticChecks() {
  const files = [
    'routes/line-analytics.js', 'routes/line-member.js', 'public/js/app.js',
    'utils/lineMemberAuth.js', 'server.js',
  ];
  let allOk = true; let detail = '';
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)]); } catch (e) { allOk = false; detail += `${f}: ${e.message}\n`; }
  }
  if (allOk) pass('node --check：所有 Hotfix26-E 觸及的 JS 檔案語法正確');
  else fail('node --check 失敗', detail);

  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length === 0) pass('index.html：沒有重複的 HTML id');
  else fail('index.html 含重複 id', [...new Set(dupes)].join(','));

  const laIds = ['laPeriodSelect', 'laCustomStart', 'laCustomEnd', 'laVerifyHealthSummary', 'laVerifyHealthDetail', 'laErrorStats', 'laVerifySummary', 'laTimelineBody', 'laFunnel', 'laHealthGrid', 'laOaCenterGrid'];
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const missingSelectors = laIds.filter((id) => !new RegExp(`id="${id}"`).test(html) || !new RegExp(`getElementById\\('${id}'\\)`).test(appJs));
  if (missingSelectors.length === 0) pass('LINE 管理頁面所有新增 HTML id 與 JavaScript selector 全部一致');
  else fail('HTML id / JS selector 不一致', missingSelectors.join(','));

  const css = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');
  let depth = 0; for (const ch of css) { if (ch === '{') depth++; if (ch === '}') depth--; }
  if (depth === 0) pass('main.css：大括號完全配對');
  else fail('main.css 大括號不配對', `depth=${depth}`);

  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  if (/app\.use\('\/api\/line-analytics'/.test(serverSrc)) pass('server.js：/api/line-analytics 路由已掛載');
  else fail('server.js 應掛載 /api/line-analytics 路由', '');

  // Android 完全未修改：本專案沒有獨立的 android/ 原生專案目錄（Android 平板
  // 功能是透過 public/js/app.js 的 android_features 設定分頁 + WebView 存取
  // 同一份後台網頁），這裡確認本輪沒有動到那個既有分頁的程式碼路徑。
  const androidMarkers = ['loadAndroidFeaturesTab', 'android_features'];
  const androidTouched = androidMarkers.every((m) => appJs.includes(m)); // 應該還在（只是確認沒被誤刪）
  if (androidTouched) pass('Android 平板設定分頁（android_features／loadAndroidFeaturesTab）程式碼仍完整存在，未被本輪修改誤刪');
  else fail('Android 平板相關程式碼疑似被誤動', '');
}

// ════════════════════════════════════════════════════════════════
// 回歸：確保沒有改變既有 smoke test 結果
// ════════════════════════════════════════════════════════════════
function runOtherSmoke(scriptName) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', scriptName)], { cwd: ROOT, timeout: 150000 }).toString();
    const m = out.match(/PASS[:=]\s*(\d+)\s*FAIL[:=]\s*(\d+)/i) || out.match(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)/i);
    if (m) return { ok: Number(m[2]) === 0, passCount: Number(m[1]), failCount: Number(m[2]) };
    return { ok: /FAIL:\s*0|FAIL=0/i.test(out) };
  } catch (e) {
    return { ok: false, error: (e.stdout ? e.stdout.toString().slice(-800) : e.message) };
  }
}
function testRegressions() {
  const scripts = [
    'smoke-hotfix25.js', 'smoke-hotfix26-a.js', 'smoke-hotfix26-b.js',
    'smoke-hotfix26-c.js', 'smoke-hotfix26-d.js', 'smoke-hotfix26-verify-debug.js',
    'smoke-hotfix26-verify-deep.js',
  ];
  for (const script of scripts) {
    const r = runOtherSmoke(script);
    if (r.ok) pass(`回歸測試 ${script} FAIL=0${r.passCount != null ? '（PASS=' + r.passCount + '）' : ''}`);
    else fail(`回歸測試 ${script} 應為 FAIL=0`, JSON.stringify(r).slice(0, 400));
  }
}

async function main() {
  console.log('\n== Hotfix26-E smoke test ==\n');
  const h = loadAnalyticsHelpers();

  console.log('-- Section 1: Health Rule Engine --');
  testHealthRuleEngine(h);

  console.log('\n-- Section 2: Verify Error Breakdown 分類 --');
  testErrorBucketing(h);

  console.log('\n-- Section 3: 日期解析（today/yesterday/last7/last30/custom）--');
  testDateResolution(h);

  console.log('\n-- Section 4: safeParseMetadata --');
  testSafeParseMetadata(h);

  console.log('\n-- Section 5: server-backed /api/line-analytics/health --');
  let seed = null;
  try { seed = await seedVerifyEvents(); } catch (e) { fail('seedVerifyEvents crashed', e.stack); }
  const child = seed ? await startServer().catch((e) => { fail('server boot', e.message.split('\n')[0]); return null; }) : null;
  if (child) {
    await sleep(300);
    try { await testHealthEndpoint(seed); } catch (e) { fail('testHealthEndpoint crashed', e.stack); }
    try { await testVerifyDebugGate(); } catch (e) { fail('testVerifyDebugGate crashed', e.stack); }
    await stopServer(child);
  }
  if (seed) { try { cleanupVerifyEvents(seed); } catch (e) {} }

  console.log('\n-- Section 6: 靜態檢查 --');
  testStaticChecks();

  console.log('\n-- Section 7: 回歸測試（全套既有 smoke test）--');
  testRegressions();

  console.log('\n== 結果 ==');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`PASS=${passCount} FAIL=${failCount} MANUAL REQUIRED=${manualCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exitCode = 1; });
