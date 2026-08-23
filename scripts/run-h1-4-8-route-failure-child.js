#!/usr/bin/env node
// scripts/run-h1-4-8-route-failure-child.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 獨立 child process：用 Runtime-only DB spy 注入 evidence-query 失敗（不是
// production test hook——只是暫時替換 db.all，跟其他 children 一致的做法），
// 證明真實 HTTP GET /api/analytics/dashboard 在 identity evidence 查詢失敗
// 時，會依現有 error middleware 回傳 non-2xx（500），而不是悄悄回傳 200
// 加上一堆看起來正常、其實完全不可信的 0 canonical 數字。
//
// 輸出：一行 JSON 到 stdout。exit code：0=成功，1=失敗。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-8-route-failure-'));
const tmpDbPath = path.join(tmpDir, 'test.db');
process.env.POS_DB_PATH = tmpDbPath;

function cleanupTmp() {
  try {
    ['', '-wal', '-shm', '-journal'].forEach((suffix) => {
      const p = tmpDbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
  } catch (e) { /* ignore */ }
  try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function normSql(sql) { return String(sql).replace(/\s+/g, ' ').trim().toLowerCase(); }

async function main() {
  const results = [];
  function assert(cond, name, detail) { results.push({ name, status: cond ? 'PASS' : 'FAIL', detail: cond ? undefined : detail }); }

  const { initDb } = require('../utils/db');
  const db = await initDb();
  const { resolveDateRange } = require('../utils/dashboardDate');

  // DB_PATH_PROOF：證明 tmpDbPath 不是正式 data/pos.db，且位於這次 child 自己的 tmpDir 底下。
  {
    const { dbPathProof } = require('./lib/h148-db-path-proof');
    const proof = dbPathProof(tmpDbPath, tmpDir);
    if (!proof.tmpNotEqualReal || !proof.tmpUnderOwnTmpDir) {
      console.error(JSON.stringify({ fatal: 'DB_PATH_PROOF failed', proof }));
      cleanupTmp();
      process.exit(1);
    }
  }

  const STORE = 'test_store_h148_route_failure';
  const P = 9820;
  const range = resolveDateRange({ preset: 'single', date: '2026-01-15' });
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P, STORE, 'RouteFailP', '測試', 100]);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE, 'RouteFailure店']);
  const evtUtcMs = Date.UTC(2026, 0, 15, 12, 0, 0) - 8 * 3600 * 1000;
  db.run(
    `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, order_channel, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [STORE, 'rf_v1', 'rf_v1_s', 'rf_cart_1', 'add_to_cart', P, 'line_takeout', new Date(evtUtcMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
  );

  const express = require('express');
  const bodyParser = require('body-parser');
  const { requireStore } = require('../middleware/storeGuard');
  const analyticsRouter = require('../routes/analytics');
  const app = express();
  app.use(bodyParser.json());
  app.use('/api/analytics', requireStore, analyticsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  async function req() {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE)}&preset=single&date=2026-01-15&channel=line_takeout`);
    let json = null;
    try { json = await res.json(); } catch (e) { /* body may not be valid JSON on some failures */ }
    return { status: res.status, json };
  }

  // ── 案例 A：先驗證「正常」時真的是 200，且 canonical 數字正確（對照組，
  // 證明失敗案例的 500 不是因為 fixture 本身壞掉，而是真的因為注入的故障）──
  const okResult = await req();
  assert(okResult.status === 200, 'ROUTE-FAILURE-OK0. 對照組（沒有注入故障）：HTTP 200', okResult.status);
  const okP1 = okResult.json && okResult.json.analytics_v2 && okResult.json.analytics_v2.product_funnel.find((f) => f.product_id === P);
  assert(!!okP1 && okP1.canonical.add_to_cart.unique_users === 1, 'ROUTE-FAILURE-OK1. 對照組：canonical 數字正確', okP1 && okP1.canonical.add_to_cart);

  // ── 案例 B：注入 direct-member 查詢失敗，真實 HTTP request 必須回傳 500，
  // 不是 200 加上一堆看起來正常的 0 ──────────────────────────────────
  const origAll = db.all.bind(db);
  db.all = (sql, params) => {
    if (normSql(sql).startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
      throw new Error('[TEST-INJECTED] 故意讓 direct-member 查詢失敗（Route-level 驗證）');
    }
    return origAll(sql, params);
  };
  let failResult;
  try {
    failResult = await req();
  } finally {
    db.all = origAll;
  }

  assert(failResult.status >= 500 && failResult.status < 600,
    `ROUTE-FAILURE1. identity evidence 查詢失敗時，真實 HTTP request 回傳 5xx（實際：${failResult.status}），不是 200`,
    failResult.status);
  assert(failResult.json && failResult.json.success === false,
    'ROUTE-FAILURE2. 500 回應的 JSON body 明確標示 success:false（依現有 error middleware 慣例，見 routes/analytics.js 最外層 catch）',
    failResult.json);

  // ── 回應內容安全性：不得洩漏 synthetic visitor ID、LINE UID、SQL 原文、
  // stack、nested cause ──────────────────────────────────────────────
  const failBodyStr = JSON.stringify(failResult.json || {});
  assert(!failBodyStr.includes('rf_v1'), 'ROUTE-FAILURE2a. 500 回應 body 不含這次 fixture 用的 synthetic visitor ID（rf_v1）', failBodyStr);
  assert(!/select .* from/i.test(failBodyStr), 'ROUTE-FAILURE2b. 500 回應 body 不含任何 SQL 原文（SELECT ... FROM 字樣）', failBodyStr);
  assert(!failBodyStr.includes('at ') && !/\.js:\d+:\d+/.test(failBodyStr), 'ROUTE-FAILURE2c. 500 回應 body 不含 stack trace（沒有 "at ...(file.js:line:col)" 這種格式）', failBodyStr);
  assert(!Object.prototype.hasOwnProperty.call(failResult.json || {}, 'cause') && !failBodyStr.includes('"cause"'),
    'ROUTE-FAILURE2d. 500 回應 body 不含 nested cause 欄位（routes/analytics.js 只序列化 { success, message }，不包含原始 Error 物件）', failBodyStr);
  assert(!failBodyStr.includes('[TEST-INJECTED]'), 'ROUTE-FAILURE2e. 500 回應 body 不含測試注入的內部錯誤原文（[TEST-INJECTED] 那段字串，證明只有外層 identityIntegrityFailure 的訊息被序列化，不是整條 cause chain）', failBodyStr);
  assert(Object.keys(failResult.json || {}).length <= 3,
    'ROUTE-FAILURE2f. 500 回應 body 欄位精簡（只有 success/message，最多再加 code 之類的既有欄位，不是把整個 error 物件序列化出去）', Object.keys(failResult.json || {}));
  // 確認不是「200 但裡面全 0」這種更隱蔽的誤導——如果 status 不是 500，
  // 這個斷言會額外抓到「明明失敗了卻回 200+全0」的情況。
  if (failResult.status === 200 && failResult.json && failResult.json.analytics_v2) {
    assert(false,
      'ROUTE-FAILURE3. 危險訊號：identity 查詢失敗卻回傳 200，且帶有 analytics_v2（可能是全 0 的誤導性資料）——這正是本輪要修正的 bug，不得再發生',
      failResult.json.analytics_v2.global_canonical);
  } else {
    assert(true, 'ROUTE-FAILURE3. 沒有出現「查詢失敗卻回傳 200+analytics_v2」的誤導性回應', null);
  }

  // ── 案例 C：確認 fixture／DB 本身沒有被這次故障注入破壞，後續正常請求恢復 200 ──
  const recoveredResult = await req();
  assert(recoveredResult.status === 200, 'ROUTE-FAILURE4. 移除故障注入後，同一 fixture 的後續請求恢復 HTTP 200（證明前面的 500 純粹是故障注入造成，不是 fixture 或 DB 被破壞）', recoveredResult.status);

  server.close();
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(JSON.stringify({ results, passCount: results.length - failCount, failCount, total: results.length, failStatus: failResult.status }));
  cleanupTmp();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: (e && e.stack) || String(e) }));
  cleanupTmp();
  process.exit(1);
});
