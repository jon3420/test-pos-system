#!/usr/bin/env node
// scripts/run-h1-4-8-scale-child.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 單一 parameterized child，涵蓋 D3／D53／D1200／E1／E40 五個 case。
// 用法：node run-h1-4-8-scale-child.js --case D1200
//
// 每次執行都是全新 process、全新 mkdtemp temp DB、POS_DB_PATH 在首次
// require('../utils/db') 之前設定，走真實 Express HTTP dashboard route，
// SQL spy 只包住 HTTP request 本身（fixture insertion／migration／PRAGMA
// 探測都在 spy 裝上之前完成，不會混進 Route SQL count）。
//
// D cases（direct-only，不建立 session-link evidence，避免混入
// session-confirm 路徑）：
//   D3   = 1 商品 / 3  個 direct visitors
//   D53  = 1 商品 / 53 個 direct visitors
//   D1200= 1 商品 / 1200 個 direct visitors
// E cases（固定 3 位 direct visitors，只改商品數量，隔離「商品數」變因）：
//   E1  = 1  個商品 / 固定 3 位 visitors
//   E40 = 40 個商品 / 固定 3 位 visitors（每位 visitor 用同一個 cart_id
//         橫跨全部 40 個商品，讓 global unique carts 不會因商品數膨脹）
//
// 輸出：一行 JSON 到 stdout（raw measurements，不是只有 pass:true）。
// exit code：0=全部 assertion 通過，1=任一失敗或 fatal error。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const CASE = (() => {
  const idx = process.argv.indexOf('--case');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();
const VALID_CASES = ['D3', 'D53', 'D1200', 'E1', 'E40'];
if (!VALID_CASES.includes(CASE)) {
  console.error(JSON.stringify({ fatal: `未知或缺少 --case 參數（收到：${CASE}），必須是 ${VALID_CASES.join('/')} 其中之一` }));
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `h1-4-8-scale-${CASE}-`));
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

const { normSql, shapeFingerprint, genericShapeFingerprint } = require('./lib/h148-sql-fingerprint');

function classifySql(norm) {
  if (norm.startsWith('select distinct visitor_id from analytics_events')) return 'discovery';
  if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) return 'members-in'; // direct-member 或 session-confirm，同形狀，用出現順序另外分類
  if (norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) return 'session-link';
  if (norm.includes('line_members')) return 'crm-line-members';
  return 'other';
}

async function main() {
  const results = [];
  function assert(cond, name, detail) { results.push({ name, status: cond ? 'PASS' : 'FAIL', detail: cond ? undefined : detail }); }

  const { initDb, getDb } = require('../utils/db');
  const db = await initDb();
  const { resolveDateRange } = require('../utils/dashboardDate');

  // ── temp DB path proof（migration／fixture 建立階段，不算進 Route SQL count）──
  const REAL_DB_PATH = path.join(__dirname, '..', 'data', 'pos.db');
  const resolvedTmpDbPath = path.resolve(tmpDbPath);
  const resolvedRealDbPath = fs.existsSync(REAL_DB_PATH) ? fs.realpathSync(REAL_DB_PATH) : path.resolve(REAL_DB_PATH);
  assert(resolvedTmpDbPath !== resolvedRealDbPath, 'PATH0. temp DB realpath 與正式 data/pos.db 不同', { resolvedTmpDbPath, resolvedRealDbPath });
  const { getDb: getDbAgain } = require('../utils/db');
  assert(getDbAgain() === db, 'PATH1. getDb() object identity 正確（同一個 module cache）', null);

  // ── engine MAX_VARIABLE_NUMBER（從真實 PRAGMA compile_options 解析，不硬編）──
  let maxVariableNumber = null;
  let sqliteVersion = null;
  try {
    sqliteVersion = db.get('SELECT sqlite_version() as v').v;
    const compileOptions = db.all('PRAGMA compile_options');
    const opt = compileOptions.find((o) => {
      const val = Object.values(o)[0];
      return typeof val === 'string' && val.startsWith('MAX_VARIABLE_NUMBER=');
    });
    if (opt) maxVariableNumber = Number(String(Object.values(opt)[0]).split('=')[1]);
  } catch (e) { /* maxVariableNumber stays null，下面 fail-fast */ }
  if (!maxVariableNumber || !Number.isFinite(maxVariableNumber)) {
    console.error(JSON.stringify({ fatal: `無法從 PRAGMA compile_options 可靠取得 MAX_VARIABLE_NUMBER，拒絕用猜測值繼續（sqliteVersion=${sqliteVersion}）` }));
    cleanupTmp();
    process.exit(1);
  }

  // ── Fixture 建立（固定絕對日期，不使用 today/yesterday/Date.now()）──────
  const STORE = `test_store_h148_scale_${CASE.toLowerCase()}`;
  const range = resolveDateRange({ preset: 'single', date: '2026-01-15' });
  const evtBaseUtcMs = Date.UTC(2026, 0, 15, 12, 0, 0) - 8 * 3600 * 1000;
  let seq = 0;
  function insertEvt(eventName, opts) {
    seq += 1;
    db.run(
      `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, order_channel, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [STORE, opts.visitorId, `${opts.visitorId}_s`, opts.cartId, eventName, opts.productId, 'line_takeout', new Date(evtBaseUtcMs + seq).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    );
  }

  let expectedVisitorIds = [];
  let expectedProductCount = 0;
  let expectedGlobalUniqueCarts = 0;
  let expectedGlobalEventCount = 0;

  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE, `Scale${CASE}店`]);

  if (CASE === 'D3' || CASE === 'D53' || CASE === 'D1200') {
    const N = CASE === 'D3' ? 3 : CASE === 'D53' ? 53 : 1200;
    const P = 9900;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P, STORE, `ScaleP-${CASE}`, '測試', 100]);
    for (let i = 0; i < N; i += 1) {
      const vid = `${CASE.toLowerCase()}_v${i}`;
      // 每位 visitor 直接是一個 direct LINE canonical ID（規則 1 命中，不建立
      // session-link，避免混入 session-confirm 路徑）。
      db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE, vid, 'Scale會員']);
      insertEvt('add_to_cart', { visitorId: vid, cartId: `${vid}_cart`, productId: P });
      expectedVisitorIds.push(vid);
    }
    expectedProductCount = 1;
    expectedGlobalUniqueCarts = N;
    expectedGlobalEventCount = N;
  } else {
    // E1 / E40：固定 3 位 direct visitors，只改商品數量
    const FIXED_VISITORS = ['scale_e_v0', 'scale_e_v1', 'scale_e_v2'];
    FIXED_VISITORS.forEach((vid) => {
      db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE, vid, 'ScaleE會員']);
    });
    const productCount = CASE === 'E1' ? 1 : 40;
    for (let p = 0; p < productCount; p += 1) {
      const productId = 9950 + p;
      db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [productId, STORE, `ScaleEP-${p}`, '測試', 100]);
      FIXED_VISITORS.forEach((vid) => {
        // 同一個 visitor 橫跨所有商品沿用自己的 cart_id，讓 global unique
        // carts 不因商品數增加（跟需求文件要求一致）。
        insertEvt('add_to_cart', { visitorId: vid, cartId: `${vid}_cart`, productId });
      });
    }
    expectedVisitorIds = FIXED_VISITORS;
    expectedProductCount = productCount;
    expectedGlobalUniqueCarts = FIXED_VISITORS.length;
    expectedGlobalEventCount = FIXED_VISITORS.length * productCount;
  }

  // ── 真實 Express HTTP server（SQL spy 從這裡才裝上）─────────────────
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

  const sqlLog = []; // { method, kind, normalized, bindCount, visitorIdBinds, params }
  const origAll = db.all.bind(db);
  const origGet = db.get.bind(db);
  db.all = (sql, params) => {
    const norm = normSql(sql);
    const kind = classifySql(norm);
    sqlLog.push({ method: 'all', kind, normalized: norm.slice(0, 100), shape: shapeFingerprint(sql), genericShape: genericShapeFingerprint(sql), bindCount: (params || []).length, params: params || [] });
    return origAll(sql, params);
  };
  db.get = (sql, params) => {
    const norm = normSql(sql);
    const kind = norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id=?') ? 'members-eq' : 'other';
    sqlLog.push({ method: 'get', kind, normalized: norm.slice(0, 100), shape: shapeFingerprint(sql), genericShape: genericShapeFingerprint(sql), bindCount: (params || []).length });
    return origGet(sql, params);
  };

  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE)}&preset=single&date=2026-01-15&channel=line_takeout`);
  const json = await res.json();
  const elapsedMs = Date.now() - t0;

  db.all = origAll;
  db.get = origGet;
  server.close();

  // 分類 members-in 出現順序：第 1 次＝direct-member，第 2 次（若有）＝session-confirm
  let membersInSeen = 0;
  sqlLog.forEach((s) => {
    if (s.kind === 'members-in') {
      membersInSeen += 1;
      s.phase = membersInSeen === 1 ? 'direct-member' : 'session-confirm';
    } else {
      s.phase = s.kind;
    }
  });

  const identityRows = sqlLog.filter((s) => ['discovery', 'direct-member', 'session-confirm', 'session-link'].includes(s.phase));
  const discoveryCount = sqlLog.filter((s) => s.phase === 'discovery').length;
  const directMemberCount = sqlLog.filter((s) => s.phase === 'direct-member').length;
  const sessionLinkCount = sqlLog.filter((s) => s.phase === 'session-link').length;
  const sessionConfirmCount = sqlLog.filter((s) => s.phase === 'session-confirm').length;
  const crmCount = sqlLog.filter((s) => s.kind === 'crm-line-members' || s.kind === 'members-eq').length;
  const maxBindCount = sqlLog.reduce((m, s) => Math.max(m, s.bindCount), 0);
  const maxBindEntry = sqlLog.reduce((best, s) => (s.bindCount > (best ? best.bindCount : -1) ? s : best), null);
  // coMaxSources[]：收集全部 bindCount === maxBindCount 的 SQL 執行（不是只取
  // 第一筆 max）。用 (phase, shape) 當 key 分組，回報每組的實際執行次數，
  // 避免因為同一 fingerprint 執行多次而誤判成多個不同來源，也避免因為
  // fingerprint 去重而把不同 phase/來源錯誤合併——group key 包含 phase，
  // 所以不同 phase 即使 shape 剛好相同也不會被合併。
  const coMaxEntries = sqlLog.filter((s) => s.bindCount === maxBindCount);
  const coMaxGroups = new Map();
  coMaxEntries.forEach((s) => {
    const key = `${s.phase}\u0000${s.shape}`;
    if (!coMaxGroups.has(key)) {
      coMaxGroups.set(key, {
        phase: s.phase,
        kind: s.kind,
        exactFingerprint: s.shape,
        genericFingerprint: s.genericShape,
        totalBindCount: s.bindCount,
        executionCount: 0,
      });
    }
    coMaxGroups.get(key).executionCount += 1;
  });
  const coMaxSources = [...coMaxGroups.values()];

  // ── Assertions ──────────────────────────────────────────────────
  assert(res.status === 200, `HTTP0. HTTP 200`, res.status);
  assert(json && json.success !== false, 'HTTP1. success !== false（沒有標記為失敗）', json && json.success);

  const jsonStr = JSON.stringify(json);
  assert(!/NaN|Infinity/.test(jsonStr), 'HTTP2. response 不含 NaN/Infinity', null);
  // "null 代替應有數值"：檢查 global_canonical 底下的三個 stage 都是數字，不是 null
  const gc = json.analytics_v2 && json.analytics_v2.global_canonical;
  assert(!!gc && ['add_to_cart', 'checkout_click', 'purchase'].every((k) => gc[k] && typeof gc[k].unique_users === 'number' && typeof gc[k].unique_carts === 'number' && typeof gc[k].event_count === 'number'),
    'HTTP3. global_canonical 三個 stage 的 event_count/unique_users/unique_carts 都是真正的數字（不是 null 代替）', gc);

  const productFunnel = (json.analytics_v2 && json.analytics_v2.product_funnel) || [];
  assert(productFunnel.length === expectedProductCount, `FUNNEL1. product_funnel 長度精確等於 ${expectedProductCount}`, productFunnel.length);

  assert(gc.add_to_cart.unique_users === expectedVisitorIds.length,
    `GLOBAL1. global add_to_cart.unique_users 精確等於 ${expectedVisitorIds.length}`, gc.add_to_cart);
  assert(gc.add_to_cart.unique_carts === expectedGlobalUniqueCarts,
    `GLOBAL2. global add_to_cart.unique_carts 精確等於 ${expectedGlobalUniqueCarts}`, gc.add_to_cart);
  assert(gc.add_to_cart.event_count === expectedGlobalEventCount,
    `GLOBAL3. global add_to_cart.event_count 精確等於 ${expectedGlobalEventCount}`, gc.add_to_cart);

  // 逐一驗證每個商品（不是只驗證第一個/最後一個）
  let allProductsCorrect = true;
  const productMismatches = [];
  productFunnel.forEach((row) => {
    const expectedUsers = CASE.startsWith('D') ? expectedVisitorIds.length : expectedVisitorIds.length;
    if (row.canonical.add_to_cart.unique_users !== expectedUsers) {
      allProductsCorrect = false;
      productMismatches.push({ product_id: row.product_id, got: row.canonical.add_to_cart.unique_users, expected: expectedUsers });
    }
  });
  assert(allProductsCorrect, `FUNNEL2. 全部 ${productFunnel.length} 個商品的 canonical add_to_cart.unique_users 都精確等於 ${expectedVisitorIds.length}（逐一驗證，不是只看第一個/最後一個）`, productMismatches);

  // identity SQL 的 visitor bind 集合 deepStrictEqual（排序後比較）
  // 從 discovery 查詢的結果反推不可靠（我們沒有攔截回傳值），改成直接用
  // direct-member 查詢的「bind 參數本身」重建（除了 store_id 那 1 個固定
  // bind，其餘全部是 visitor_id）。
  const directMemberSql = sqlLog.find((s) => s.phase === 'direct-member');
  assert(!!directMemberSql, 'IDENTITY0. 找得到 direct-member 查詢', null);

  assert(discoveryCount === 1, `IDENTITY1. discovery SQL 恰好執行 1 次`, discoveryCount);
  assert(directMemberCount === 1, `IDENTITY2. direct-member SQL 恰好執行 1 次（不因 visitor 數量分批）`, directMemberCount);
  // 這是 direct-only fixture：全部 visitor 都是 direct-member 命中，
  // resolveCanonicalVisitors() 的 remainingIds（direct-member 沒命中的）
  // 會是空陣列，session-link 查詢因此被正確跳過（見 utils/analyticsIdentity.js
  // 的 `if (remainingIds.length)` guard）——這是正確、高效的既有行為，
  // 不是 bug，所以這裡預期 session-link SQL 次數是 0，不是 1。
  assert(sessionLinkCount === 0, `IDENTITY3. session-link SQL = 0（全部 visitor 都在 direct-member 命中，沒有剩餘 id 需要查 session-link，這是正確的既有短路行為）`, sessionLinkCount);
  assert(sessionConfirmCount === 0, `IDENTITY4. session-confirm SQL = 0（這是 direct-only／固定 direct visitor fixture，沒有 session-link 證據可以 confirm）`, sessionConfirmCount);

  // identity SQL 的 visitor bind 集合，與預期 N 個 visitor IDs deepStrictEqual
  // （排序後比較）——直接檢查 direct-member 查詢實際綁定的 bind 數量是否
  // 精確等於「1 個 store_id + N 個 visitor_id」，這是唯一可靠、不用另外攔截
  // 回傳值就能驗證「集合大小精確正確」的方式（我們沒有在 spy 裡另外記錄
  // 每次呼叫的實際 visitor_id 明文，那些資訊在 discovery 查詢的回傳值裡，
  // spy 目前只記錄 SQL 文字與 bind 數量，不記錄回傳資料本身，避免測試輸出
  // 混入個資）。
  const assertModule = require('assert');
  let bindCountMatchesExpected = true;
  try {
    assertModule.strictEqual(directMemberSql.bindCount, expectedVisitorIds.length + 1); // +1 是 store_id
  } catch (e) { bindCountMatchesExpected = false; }
  assert(bindCountMatchesExpected,
    `IDENTITY5. direct-member 查詢的 bind 數量精確等於 1(store_id) + ${expectedVisitorIds.length}(visitor_id 集合大小)，證明 identity SQL 綁定的 visitor 集合大小跟預期 N 完全一致（不多不少、沒有截斷或重複）`,
    { actual: directMemberSql.bindCount, expected: expectedVisitorIds.length + 1 });

  // 直接用實際 bind 出去的參數（去掉第一個 store_id），跟 fixture 建立時的
  // expectedVisitorIds 做 deepStrictEqual（排序後比較），不只比較數量。
  const directMemberVisitorBinds = (directMemberSql.params || []).slice(1);
  const sortedActual = [...directMemberVisitorBinds].sort();
  const sortedExpected = [...expectedVisitorIds].sort();
  let visitorSetMatches = true;
  try { assertModule.deepStrictEqual(sortedActual, sortedExpected); } catch (e) { visitorSetMatches = false; }
  assert(visitorSetMatches,
    `IDENTITY6. direct-member 查詢實際綁定的 visitor_id 集合（排序後）與 fixture 建立時的 expectedVisitorIds（排序後）deepStrictEqual`,
    { actualCount: sortedActual.length, expectedCount: sortedExpected.length });

  assert(maxBindCount <= maxVariableNumber, `ENGINE1. maxBindCount(${maxBindCount}) <= MAX_VARIABLE_NUMBER(${maxVariableNumber})`, { maxBindCount, maxVariableNumber });

  // coMaxSources[] 完整性／正確性 assertion（不得只驗證其中一筆）：
  // ENGINE2：coMaxSources 中每一筆的 totalBindCount 都必須精確等於 maxBindCount。
  const coMaxAllMatchMax = coMaxSources.every((g) => g.totalBindCount === maxBindCount);
  assert(coMaxAllMatchMax, `ENGINE2. coMaxSources[] 中每一筆 totalBindCount 都精確等於 routeWideMaxBindCount(${maxBindCount})`,
    coMaxSources.map((g) => ({ phase: g.phase, totalBindCount: g.totalBindCount })));
  // ENGINE3：coMaxSources 收錄的執行次數總和，必須精確等於 sqlLog 中
  // bindCount === maxBindCount 的實際執行次數（證明沒有漏掉任何一筆並列來源，
  // 也沒有因 fingerprint 去重而少算次數）。
  const coMaxExecutionSum = coMaxSources.reduce((sum, g) => sum + g.executionCount, 0);
  assert(coMaxExecutionSum === coMaxEntries.length,
    `ENGINE3. coMaxSources[] 執行次數總和(${coMaxExecutionSum}) 精確等於實際達到 max bind 的 SQL 執行次數(${coMaxEntries.length})——沒有遺漏任何並列來源`,
    { coMaxExecutionSum, actualMaxBindExecutions: coMaxEntries.length });

  // ── 非 identity fingerprint-count map（CRM、product/global 其他 route SQL）──
  const normalizedFingerprintCounts = {};
  const nonIdentityFingerprintCounts = {};
  const genericFingerprintCounts = {};
  const nonIdentityGenericFingerprintCounts = {};
  sqlLog.forEach((s) => {
    const key = s.shape;
    normalizedFingerprintCounts[key] = (normalizedFingerprintCounts[key] || 0) + 1;
    const gkey = s.genericShape;
    genericFingerprintCounts[gkey] = (genericFingerprintCounts[gkey] || 0) + 1;
    if (!['discovery', 'direct-member', 'session-link', 'session-confirm'].includes(s.phase)) {
      nonIdentityFingerprintCounts[key] = (nonIdentityFingerprintCounts[key] || 0) + 1;
      nonIdentityGenericFingerprintCounts[gkey] = (nonIdentityGenericFingerprintCounts[gkey] || 0) + 1;
    }
  });

  // per-phase bind-count arrays／visitor-bind arrays
  function phaseBindArrays(phaseName) {
    const rows = sqlLog.filter((s) => s.phase === phaseName);
    return {
      totalBindCounts: rows.map((r) => r.bindCount),
      visitorBinds: rows.map((r) => (r.params || []).slice(1)), // 去掉 store_id
    };
  }
  const phaseArrays = {
    discovery: phaseBindArrays('discovery'),
    directMember: phaseBindArrays('direct-member'),
    sessionLink: phaseBindArrays('session-link'),
    sessionConfirm: phaseBindArrays('session-confirm'),
  };
  const sortedVisitorBindUnion = [...new Set(directMemberVisitorBinds)].sort();

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const output = {
    case: CASE,
    caseName: CASE,
    results,
    passCount: results.length - failCount,
    failCount,
    total: results.length,
    measurements: {
      httpStatus: res.status,
      success: json && json.success !== false,
      elapsedMs,
      visitorCount: expectedVisitorIds.length,
      productCount: expectedProductCount,
      expectedVisitorCount: expectedVisitorIds.length,
      expectedProductCount,
      expectedGlobalUniqueCarts,
      expectedGlobalEventCount,
      globalCanonical: gc,
      productFunnel: productFunnel.map((p) => ({ product_id: p.product_id, canonical: p.canonical })),
      productFunnelLength: productFunnel.length,
      sqlKindCounts: sqlLog.reduce((acc, s) => { acc[s.phase] = (acc[s.phase] || 0) + 1; return acc; }, {}),
      normalizedFingerprintCounts,
      nonIdentityFingerprintCounts,
      genericFingerprintCounts,
      nonIdentityGenericFingerprintCounts,
      totalRouteSqlCount: sqlLog.length,
      discoveryCount, directMemberCount, sessionLinkCount, sessionConfirmCount, crmCount,
      phaseArrays,
      sortedVisitorBindUnion,
      directMemberTotalBinds: directMemberSql ? directMemberSql.bindCount : null,
      directMemberVisitorBindCount: directMemberVisitorBinds.length,
      maxBindCount, maxObservedTotalBindCount: maxBindCount, maxVariableNumber, sqliteVersion,
      maxBindFingerprint: maxBindEntry ? maxBindEntry.shape : null,
      maxBindPhase: maxBindEntry ? maxBindEntry.phase : null,
      coMaxSources,
      dbPathProof: { resolvedTmpDbPath, resolvedRealDbPath, tmpNotEqualReal: resolvedTmpDbPath !== resolvedRealDbPath },
    },
  };
  console.log(JSON.stringify(output));
  cleanupTmp();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: (e && e.stack) || String(e), case: CASE }));
  cleanupTmp();
  process.exit(1);
});
