#!/usr/bin/env node
// scripts/run-h1-4-8-fresh-factory-child.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 獨立 child process，只做一件事：在第一次 require('../routes/analytics')
// 之前，包住 utils/analyticsIdentity.js 真正公開匯出的
// createCanonicalIdentityContext()，藉此證明「每次 HTTP request 都建立
// 一份新的 context」。這件事不可能在父測試進程裡做到，因為
// routes/analytics.js 在同一個 process 內早就被其他測試 require 過、
// 它內部對 createCanonicalIdentityContext 的解構參照已經綁定到原始函式，
// 事後 monkey-patch module.exports 上的屬性也救不回來。
//
// 用法：node run-h1-4-8-fresh-factory-child.js
// 輸出：一行 JSON 到 stdout，parent 用 JSON.parse 讀取結果。
// exit code：0=成功，1=失敗。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-8-fresh-factory-'));
const tmpDbPath = path.join(tmpDir, 'test.db');
process.env.POS_DB_PATH = tmpDbPath; // 必須在第一次 require('../utils/db') 之前設定

function cleanupTmp() {
  try {
    ['', '-wal', '-shm', '-journal'].forEach((suffix) => {
      const p = tmpDbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
  } catch (e) { /* ignore */ }
  try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function main() {
  const identityModule = require('../utils/analyticsIdentity');
  const originalFactory = identityModule.createCanonicalIdentityContext;
  let factoryCallCount = 0;
  const createdContexts = [];
  // 在 routes/analytics.js 第一次被 require 之前，patch 掉 module.exports
  // 上的這個屬性——routes/analytics.js 用的是
  // `const { createCanonicalIdentityContext } = require('../utils/analyticsIdentity')`，
  // 這種解構寫法會在 require 當下就把值複製出來，所以這個 patch 必須發生在
  // routes/analytics.js 第一次被 require 之前才有效（這也是為什麼這件事
  // 只能在全新的 child process 做，不能在已經 require 過 routes/analytics.js
  // 的父進程裡事後補做）。
  identityModule.createCanonicalIdentityContext = function spyCreateCanonicalIdentityContext(...args) {
    factoryCallCount += 1;
    const ctx = originalFactory.apply(this, args);
    createdContexts.push(ctx);
    return ctx;
  };

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

  const STORE = 'test_store_h148_fresh_factory';
  const range = resolveDateRange({ preset: 'single', date: '2026-01-15' });
  const P = 9800;

  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P, STORE, 'FreshFactoryP', '測試', 100]);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE, 'FreshFactory店']);
  const evtLocal = '2026-01-15 12:00:00';
  const evtUtcMs = Date.UTC(2026, 0, 15, 12, 0, 0) - 8 * 3600 * 1000;
  function insertEvt(eventName, opts) {
    db.run(
      `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, order_channel, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [STORE, opts.visitorId, opts.visitorId + '_s', opts.cartId, eventName, P, 'line_takeout', new Date(evtUtcMs + (opts.offset || 0)).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    );
  }
  insertEvt('add_to_cart', { visitorId: 'ff_v1', cartId: 'ff_cart_1', offset: 0 });
  insertEvt('add_to_cart', { visitorId: 'ff_v2', cartId: 'ff_cart_2', offset: 1000 });

  // ── 這個時間點之後才 require routes/analytics.js（透過真正的 HTTP server）──
  const express = require('express');
  const bodyParser = require('body-parser');
  const { requireStore } = require('../middleware/storeGuard');
  const analyticsRouter = require('../routes/analytics'); // 第一次 require，此時 factory 已被 patch
  const app = express();
  app.use(bodyParser.json());
  app.use('/api/analytics', requireStore, analyticsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const results = [];
  function assert(cond, name, detail) { results.push({ name, status: cond ? 'PASS' : 'FAIL', detail: cond ? undefined : detail }); }

  async function req() {
    const res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE)}&preset=single&date=2026-01-15&channel=line_takeout`);
    const json = await res.json();
    return { status: res.status, json };
  }

  const r1 = await req();
  assert(r1.status === 200, 'FACTORY0a. Request 1: HTTP 200', r1.status);
  const p1Row1 = r1.json.analytics_v2 && r1.json.analytics_v2.product_funnel.find((f) => f.product_id === P);
  assert(!!p1Row1 && p1Row1.canonical.add_to_cart.unique_users === 2, 'FACTORY1a. Request 1: product unique_users=2', p1Row1 && p1Row1.canonical.add_to_cart);
  assert(r1.json.analytics_v2.global_canonical.add_to_cart.unique_users === 2, 'FACTORY1b. Request 1: global unique_users=2', r1.json.analytics_v2.global_canonical.add_to_cart);

  assert(factoryCallCount === 1, 'FACTORY2. createCanonicalIdentityContext() 呼叫次數（Request 1 後）= 1', factoryCallCount);
  const context1 = createdContexts[0];
  const context1Snapshot = JSON.parse(JSON.stringify({
    storeId: context1.storeId,
    canonicalByVisitor: [...context1.canonicalByVisitor.entries()],
    primedScopes: [...context1.primedScopes],
  }));

  // 補上正式 identity evidence：兩個 visitor 確定性連結到同一個 LINE UID
  db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE, 'FF_LINE', 'FF會員']);
  db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE, 'FF_LINE', 'ff_v1']);
  db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE, 'FF_LINE', 'ff_v2']);

  let sqlCountReq2 = 0;
  const origAll = db.all.bind(db);
  db.all = (sql, params) => {
    const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm.includes('line_members') || norm.includes('line_member_sessions') || norm.startsWith('select distinct visitor_id from analytics_events')) sqlCountReq2 += 1;
    return origAll(sql, params);
  };
  let r2;
  try { r2 = await req(); } finally { db.all = origAll; }

  assert(r2.status === 200, 'FACTORY0b. Request 2: HTTP 200', r2.status);
  const p1Row2 = r2.json.analytics_v2 && r2.json.analytics_v2.product_funnel.find((f) => f.product_id === P);
  assert(!!p1Row2 && p1Row2.canonical.add_to_cart.unique_users === 1, 'FACTORY3a. Request 2 (LINE-merged): product unique_users=1', p1Row2 && p1Row2.canonical.add_to_cart);
  assert(r2.json.analytics_v2.global_canonical.add_to_cart.unique_users === 1, 'FACTORY3b. Request 2: global unique_users=1', r2.json.analytics_v2.global_canonical.add_to_cart);
  assert(sqlCountReq2 > 0, 'FACTORY3c. Request 2 重新執行了 discovery／identity evidence SQL（不是零查詢沿用舊結果）', sqlCountReq2);

  assert(factoryCallCount === 2, 'FACTORY4. createCanonicalIdentityContext() 呼叫次數（Request 2 後）= 2', factoryCallCount);
  const context2 = createdContexts[1];
  assert(context1 !== context2, 'FACTORY5. context1 !== context2（不是同一個物件）', { same: context1 === context2 });
  assert(context1.canonicalByVisitor !== context2.canonicalByVisitor, 'FACTORY6. context1.canonicalByVisitor !== context2.canonicalByVisitor（不是同一個 Map）', null);
  assert(context1.primedScopes !== context2.primedScopes, 'FACTORY7. context1.primedScopes !== context2.primedScopes（不是同一個 Set）', null);
  assert(context1.storeId === context2.storeId, 'FACTORY8. 兩個 context 的 storeId 相同（同一個 store 的兩次 request）', { s1: context1.storeId, s2: context2.storeId });

  const context1AfterRequest2 = JSON.parse(JSON.stringify({
    storeId: context1.storeId,
    canonicalByVisitor: [...context1.canonicalByVisitor.entries()],
    primedScopes: [...context1.primedScopes],
  }));
  const assertModule = require('assert');
  let deepEqualOk = true;
  let deepEqualError = null;
  try { assertModule.deepStrictEqual(context1AfterRequest2, context1Snapshot); } catch (e) { deepEqualOk = false; deepEqualError = e.message; }
  assert(deepEqualOk, 'FACTORY9. context1 在 Request 2 完成後，跟 Request 1 完成當下的 snapshot 完全相同（assert.deepStrictEqual）——Request 2 沒有回頭污染 context1', deepEqualError);

  const jsonStr1 = JSON.stringify(r1.json);
  const jsonStr2 = JSON.stringify(r2.json);
  assert(!/NaN|Infinity/.test(jsonStr1) && !/NaN|Infinity/.test(jsonStr2), 'FACTORY10. 兩次 Route response JSON 都不含 NaN/Infinity 字面字串', null);

  server.close();
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(JSON.stringify({ results, passCount: results.length - failCount, failCount, total: results.length }));
  cleanupTmp();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: (e && e.stack) || String(e) }));
  cleanupTmp();
  process.exit(1);
});
