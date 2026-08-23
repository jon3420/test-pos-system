#!/usr/bin/env node
// scripts/run-h1-4-8-route-order-child.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 獨立 child process：在第一次 require('../routes/analytics') 之前，包住
// routes/analytics.js 實際 import 的公開 production APIs
// （createCanonicalIdentityContext／primeFunnelIdentityContext／
// getProductFunnel／getGlobalFunnelCanonicalMetrics），捕捉一次真實
// dashboard HTTP request 的完整呼叫順序與各階段 SQL delta。跟 FRESH
// factory child 同樣的結構性理由：這些函式在 routes/analytics.js 頂部用
// 解構賦值方式 import，必須在該檔案第一次被 require 之前完成 patch。
//
// production 實際呼叫位置（本檔案要驗證的就是這個順序，行號取自目前版本
// routes/analytics.js）：
//   65-68  const { getProductFunnel, ..., getGlobalFunnelCanonicalMetrics,
//               primeFunnelIdentityContext } = require('../utils/analyticsV2');
//   441    primeFunnelIdentityContext(db, storeId, range, channel, sharedIdentityContext);
//   442    const productFunnel = getProductFunnel(db, storeId, range, channel, sharedIdentityContext);
//   469    const globalCanonical = getGlobalFunnelCanonicalMetrics(db, storeId, range, channel, sharedIdentityContext);
//
// 輸出：一行 JSON 到 stdout。exit code：0=成功，1=失敗。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-8-route-order-'));
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

  const trace = []; // { event, atSqlIndex }
  let sqlIndex = 0;
  const sqlLog = []; // { idx, kind, normalized }

  // ── 包住 analyticsV2.js 的公開 exports（routes/analytics.js 用解構 import，
  // 必須在它第一次被 require 之前 patch 完成）──────────────────────────
  const analyticsV2Module = require('../utils/analyticsV2');
  const identityModule = require('../utils/analyticsIdentity');

  const origCreateContext = identityModule.createCanonicalIdentityContext;
  identityModule.createCanonicalIdentityContext = function (...args) {
    trace.push({ event: 'create-context', atSqlIndex: sqlIndex });
    return origCreateContext.apply(this, args);
  };

  const origPrime = analyticsV2Module.primeFunnelIdentityContext;
  analyticsV2Module.primeFunnelIdentityContext = function (...args) {
    trace.push({ event: 'prime:start', atSqlIndex: sqlIndex });
    const r = origPrime.apply(this, args);
    trace.push({ event: 'prime:completed', atSqlIndex: sqlIndex });
    return r;
  };

  const origProductFunnel = analyticsV2Module.getProductFunnel;
  analyticsV2Module.getProductFunnel = function (...args) {
    trace.push({ event: 'product:start', atSqlIndex: sqlIndex });
    const r = origProductFunnel.apply(this, args);
    trace.push({ event: 'product:completed', atSqlIndex: sqlIndex });
    return r;
  };

  const origGlobal = analyticsV2Module.getGlobalFunnelCanonicalMetrics;
  analyticsV2Module.getGlobalFunnelCanonicalMetrics = function (...args) {
    trace.push({ event: 'global:start', atSqlIndex: sqlIndex });
    const r = origGlobal.apply(this, args);
    trace.push({ event: 'global:completed', atSqlIndex: sqlIndex });
    return r;
  };

  const { initDb, getDb } = require('../utils/db');
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

  // ── DB SQL spy（裝在 initDb() 之後，同一個 db instance）───────────
  const origAll = db.all.bind(db);
  db.all = (sql, params) => {
    const norm = normSql(sql);
    let kind = 'other';
    if (norm.startsWith('select distinct visitor_id from analytics_events')) kind = 'discovery';
    else if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) kind = 'members-in'; // direct-member 或 session-confirm，同一種 shape
    else if (norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) kind = 'session-link';
    else if (norm.includes('line_members')) kind = 'crm-line-members';
    sqlLog.push({ idx: sqlIndex, kind, normalized: norm.slice(0, 80) });
    sqlIndex += 1;
    return origAll(sql, params);
  };

  const STORE = 'test_store_h148_route_order';
  const P = 9810;
  const range = resolveDateRange({ preset: 'single', date: '2026-01-15' });
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P, STORE, 'RouteOrderP', '測試', 100]);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE, 'RouteOrder店']);
  const evtUtcMs = Date.UTC(2026, 0, 15, 12, 0, 0) - 8 * 3600 * 1000;
  db.run(
    `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, order_channel, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [STORE, 'ro_v1', 'ro_v1_s', 'ro_cart_1', 'add_to_cart', P, 'line_takeout', new Date(evtUtcMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
  );
  // 一個有 session-link（但不需要 confirm 到底，因為沒有真的 LINE 會員存在——
  // 這是 direct fixture，故意不建立 line_members，讓 session-confirm 這一步
  // 不會被觸發，符合 direct fixture 的計數契約）。

  // ── 第一次 require routes/analytics.js（patch 完成之後）───────────
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

  const res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE)}&preset=single&date=2026-01-15&channel=line_takeout`);
  const json = await res.json();
  server.close();
  db.all = origAll;

  assert(res.status === 200, 'ROUTE-ORDER0. HTTP 200', res.status);

  // ── trace 必須形成 ordered subsequence ──────────────────────────
  const eventOrder = trace.map((t) => t.event);
  function indexOfFirst(ev) { return eventOrder.indexOf(ev); }
  const idxCreate = indexOfFirst('create-context');
  const idxPrimeStart = indexOfFirst('prime:start');
  const idxPrimeDone = indexOfFirst('prime:completed');
  const idxProductStart = indexOfFirst('product:start');
  const idxProductDone = indexOfFirst('product:completed');
  const idxGlobalStart = indexOfFirst('global:start');
  const idxGlobalDone = indexOfFirst('global:completed');

  assert(idxCreate !== -1 && idxPrimeStart !== -1 && idxPrimeDone !== -1 && idxProductStart !== -1 && idxProductDone !== -1 && idxGlobalStart !== -1 && idxGlobalDone !== -1,
    'ROUTE-ORDER1. 完整 trace 包含全部 7 個關鍵事件', eventOrder);
  assert(idxCreate < idxPrimeStart && idxPrimeStart < idxPrimeDone && idxPrimeDone < idxProductStart && idxProductStart < idxProductDone && idxProductDone < idxGlobalStart && idxGlobalStart < idxGlobalDone,
    'ROUTE-ORDER2. 關鍵事件形成正確 ordered subsequence：create-context < prime:start < prime:completed < product:start < product:completed < global:start < global:completed',
    eventOrder);

  // ── SQL delta：canonical evidence SQL 必須全部落在 prime:start～prime:completed 之間 ──
  const primeStartSqlIdx = trace.find((t) => t.event === 'prime:start').atSqlIndex;
  const primeDoneSqlIdx = trace.find((t) => t.event === 'prime:completed').atSqlIndex;
  const productStartSqlIdx = trace.find((t) => t.event === 'product:start').atSqlIndex;
  const productDoneSqlIdx = trace.find((t) => t.event === 'product:completed').atSqlIndex;
  const globalStartSqlIdx = trace.find((t) => t.event === 'global:start').atSqlIndex;
  const globalDoneSqlIdx = trace.find((t) => t.event === 'global:completed').atSqlIndex;

  const canonicalEvidenceKinds = new Set(['discovery', 'members-in', 'session-link']);
  const evidenceDuringPrime = sqlLog.filter((s) => canonicalEvidenceKinds.has(s.kind) && s.idx >= primeStartSqlIdx && s.idx < primeDoneSqlIdx);
  const evidenceDuringProduct = sqlLog.filter((s) => canonicalEvidenceKinds.has(s.kind) && s.idx >= productStartSqlIdx && s.idx < productDoneSqlIdx);
  const evidenceDuringGlobal = sqlLog.filter((s) => canonicalEvidenceKinds.has(s.kind) && s.idx >= globalStartSqlIdx && s.idx < globalDoneSqlIdx);
  const evidenceOutsidePrimeWindow = sqlLog.filter((s) => canonicalEvidenceKinds.has(s.kind) && (s.idx < primeStartSqlIdx || s.idx >= primeDoneSqlIdx));

  assert(evidenceDuringPrime.length > 0, 'ROUTE-ORDER3. prime 階段內確實執行了 canonical evidence SQL（discovery/direct-member/session-link）', evidenceDuringPrime);
  assert(evidenceOutsidePrimeWindow.length === 0,
    'ROUTE-ORDER4. 所有 canonical evidence SQL 都落在 prime:start～prime:completed 之間（沒有任何一筆在這個窗口之外）',
    evidenceOutsidePrimeWindow);
  assert(evidenceDuringProduct.length === 0, 'ROUTE-ORDER5. product helper 階段新增 canonical evidence SQL = 0', evidenceDuringProduct);
  assert(evidenceDuringGlobal.length === 0, 'ROUTE-ORDER6. global helper 階段新增 canonical evidence SQL = 0', evidenceDuringGlobal);

  const crmSqlMisclassified = sqlLog.filter((s) => s.kind === 'crm-line-members' && canonicalEvidenceKinds.has(s.kind));
  assert(crmSqlMisclassified.length === 0, 'ROUTE-ORDER7. CRM 固定查詢（crm-line-members 分類）沒有被誤算進 canonical evidence 分類集合', crmSqlMisclassified);

  const p1Row = json.analytics_v2 && json.analytics_v2.product_funnel.find((f) => f.product_id === P);
  assert(!!p1Row && p1Row.canonical.add_to_cart.unique_users === 1, 'ROUTE-ORDER8. product canonical 結果精確正確（unique_users=1）', p1Row && p1Row.canonical.add_to_cart);
  assert(json.analytics_v2.global_canonical.add_to_cart.unique_users === 1, 'ROUTE-ORDER9. global canonical 結果精確正確（unique_users=1）', json.analytics_v2.global_canonical.add_to_cart);
  assert(!/NaN|Infinity/.test(JSON.stringify(json)), 'ROUTE-ORDER10. Route JSON 不含 NaN/Infinity', null);

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(JSON.stringify({
    results, passCount: results.length - failCount, failCount, total: results.length,
    eventOrder,
    sqlKindCounts: sqlLog.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
  }));
  cleanupTmp();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: (e && e.stack) || String(e) }));
  cleanupTmp();
  process.exit(1);
});
