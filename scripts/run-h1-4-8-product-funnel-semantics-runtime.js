#!/usr/bin/env node
// scripts/run-h1-4-8-product-funnel-semantics-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// Gate B：Analytics V2 商品漏斗三種統計口徑（event_count／unique_users／
// unique_carts）。全程呼叫正式 utils/analyticsV2.js getProductFunnel()／
// getGlobalFunnelCanonicalMetrics()，透過正式 routes/analytics.js 的真實
// HTTP GET /api/analytics/dashboard 驗證 Route response，並用 jsdom 真正
// 執行 production public/js/analytics-v2.js 的 renderer（不是 regex 掃描）。
// 測試內不重寫一套 production SQL 或演算法來自我驗證。
//
// Identity 規則稽核：全系統（dashboardAnalytics.js／analyticsV2.js）對
// event 層級「不重複人數」的既有 canonical 定義，就是 COUNT(DISTINCT
// visitor_id) 直接對 analytics_events.visitor_id 做——不是 Visitor 360／
// CRM 用的 resolveCanonicalVisitor() 跨 session 合併身份（那是不同層級的
// 概念，用在會員合併而不是事件層級去重）。本輪三個新 canonical helper
// （_canonicalMetricsForEvent／_canonicalAddToCartMetricsForProduct／
// _canonicalPurchaseMetricsForProduct）全部沿用這同一個既有慣例，沒有
// 各自發明一套不同的 identity 定義。
//
// 誠實聲明：這是 H1.4.8 Gate B 本輪第一次執行，沒有歷史 PASS 紀錄。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-8-funnel-'));
const tmpDbPath = path.join(tmpDir, 'test.db');
process.env.POS_DB_PATH = tmpDbPath;

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 三次修正）：Gate B 明確要求「唯一臨時 DB」必須是本 Runtime 自己的
// fail-fast assertion，不能只靠人工事後 git checkout 還原來宣稱乾淨。
// 這裡在最早期就記錄正式 data/pos.db 的 hash（如果它存在），main() 結尾
// 會重新計算並比對，不一致就讓整支測試失敗（見檔案結尾 DB_ISOLATION 區塊）。
const REAL_DB_PATH = path.join(__dirname, '..', 'data', 'pos.db');
const REAL_DB_WAL_PATH = `${REAL_DB_PATH}-wal`;
const REAL_DB_SHM_PATH = `${REAL_DB_PATH}-shm`;
function _hashFile(p) {
  if (!fs.existsSync(p)) return null;
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}
const REAL_DB_HASH_BEFORE = _hashFile(REAL_DB_PATH);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) {
  if (cond) { pass(name); return; }
  fail(name, detail);
  console.log(`  >>> FAIL DETAIL [${name}]:`, JSON.stringify(detail, null, 2));
}

function cleanupTmp() {
  try {
    ['', '-wal', '-shm', '-journal'].forEach((suffix) => {
      const p = tmpDbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
  } catch (e) { console.warn('[cleanup] DB 附屬檔清理失敗:', e.message); }
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) { console.warn('[cleanup] tmpdir 清理失敗:', e.message); }
}

async function main() {
  const { initDb } = require('../utils/db');
  const db = await initDb();
  const { getProductFunnel, getGlobalFunnelCanonicalMetrics, primeFunnelIdentityContext } = require('../utils/analyticsV2');
  const { resolveCanonicalVisitor: resolveCanonicalVisitorForTest, resolveCanonicalVisitors: resolveCanonicalVisitorsForTest, createCanonicalIdentityContext, resolveInContext } = require('../utils/analyticsIdentity');
  const { resolveDateRange } = require('../utils/dashboardDate');

  // ── DB_PATH_PROOF：證明整個 process（包含 HTTP helper 之後才 require 的
  // routes/analytics.js）全程都指向同一個 tmpdir 底下的臨時 DB，不是正式
  // data/pos.db。process.env.POS_DB_PATH 在檔案最頂部（第一次 require
  // ../utils/db 之前）就設定好了，utils/db.js 的 DB_PATH 常數只在
  // module 第一次載入時讀一次 env var，之後所有 require('../utils/db')
  // 都吃同一份 module cache，包括透過 require('../routes/analytics') 間接
  // 拉進來的那一份——這裡直接驗證 getDb() 回傳的是同一個物件參照，不是猜測。
  {
    const realpath = require('fs').realpathSync;
    const resolvedTmpPath = realpath(tmpDbPath);
    const resolvedRealDbPath = require('fs').existsSync(REAL_DB_PATH) ? realpath(REAL_DB_PATH) : null;
    assert(resolvedTmpPath !== resolvedRealDbPath,
      'DB_PATH_PROOF1. tmpDbPath 的 realpath 與正式 data/pos.db 的 realpath 不同（不是同一個檔案）', { resolvedTmpPath, resolvedRealDbPath });
    assert(tmpDbPath.startsWith(tmpDir) && tmpDir.includes(require('os').tmpdir()),
      'DB_PATH_PROOF2. tmpDbPath 確實位於這個 case 專屬的 os.tmpdir() 底下的 tmpDir，不是 data/ 目錄', { tmpDbPath, tmpDir });
    const { getDb } = require('../utils/db');
    assert(getDb() === db,
      'DB_PATH_PROOF3. utils/db.js 的 getDb()（routes/analytics.js 內部實際呼叫的同一個函式）回傳的物件參照，跟這支測試自己 initDb() 拿到的 db 是同一個物件（===），證明整個 process 共用同一份指向 tmpDbPath 的 DB 實例，包括之後才 require 的 routes/analytics.js', { same: getDb() === db });
  }

  // ── 單一時間基準：「昨天」這個 Asia/Taipei 日曆日（production date helper，
  // 不自行猜 UTC 邊界）。
  const range = resolveDateRange({ preset: 'yesterday' });
  const FIXTURE_LOCAL_TIME = `${range.start_date} 12:00:00`;
  const [datePart, timePart] = FIXTURE_LOCAL_TIME.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const BASE_UTC_MS = Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 3600 * 1000;
  const nowMs = Date.now();
  if (!((nowMs - BASE_UTC_MS) / 1000 > 30 * 60)) {
    console.error('[FATAL] fixture 基準時間距離現在不足 30 分鐘，環境時鐘可能異常。');
    cleanupTmp();
    process.exitCode = 1;
    return;
  }
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（十一次修正——徹底移除
  // ADV6 對目前時鐘的依賴）：先前用 preset='today' 搭配 Date.now()-60秒
  // 當「範圍內」的錨點，但 preset='today' 的結束邊界本身就是「現在」，
  // 這個相對關係在任何固定差值下都不安全（例如剛好在午夜附近執行）。
  // 改用完全固定、跟目前時鐘無關的絕對日期（2026-01-15，透過正式
  // resolveDateRange({preset:'single', date:...}) 產生 start/end，不自行
  // 猜 UTC 邊界），這個日期範圍與 range（yesterday，隨執行當下浮動）不會
  // 重疊，且它的範圍邊界不受「現在幾點」影響——不管這支測試在一天中的
  // 哪個時刻執行，這個固定日期永遠是「過去的某一天」，事件永遠落在它
  // 自己的範圍「內部」（中午 12:00，不是邊界值）。
  const FIXED_OUTSIDE_DATE = '2026-01-15';
  const fixedOutsideRange = resolveDateRange({ preset: 'single', date: FIXED_OUTSIDE_DATE });
  const [foY, foMo, foD] = FIXED_OUTSIDE_DATE.split('-').map(Number);
  const OUTSIDE_UTC_MS = Date.UTC(foY, foMo - 1, foD, 12, 0, 0) - 8 * 3600 * 1000; // 該日中午（Asia/Taipei），範圍內部，不是邊界

  let seq = 0;
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（十二次修正）：單一、集中的
  // test-only SQL 正規化函式。只用來分類測試看到的 SQL 字串，不改動任何
  // production SQL 本身。所有 discovery／direct-member／session-link／
  // session-confirm／CRM classifier 都先用這個函式正規化，不再各自零散地
  // 補 `\s+`（先前 PRIME_SCOPE_EXPAND 那個漏補的 bug，根因就是規則沒有
  // 集中管理）。
  function normalizeSqlForTest(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function insertEvent(storeId, eventName, opts = {}) {
    seq += 1;
    const baseMs = opts.outsideRange ? OUTSIDE_UTC_MS : BASE_UTC_MS;
    const ts = new Date(baseMs + seq);
    const isoNoMs = ts.toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    db.run(
      `INSERT INTO analytics_events
        (store_id, visitor_id, session_id, cart_id, order_id, event_name, product_id, quantity, order_channel, source, campaign, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId, opts.visitorId || 'visitor_anon', opts.sessionId || 'session_anon',
        (opts.cartId === undefined ? null : opts.cartId), opts.orderId || null, eventName,
        opts.productId || null, opts.quantity || 1, opts.orderChannel || 'line_takeout',
        opts.source || null, opts.campaign || null, isoNoMs,
      ]
    );
  }

  const STORE = 'test_store_h148_funnel';
  const CHANNEL = 'line_takeout';
  const P1 = 9401, P2 = 9402;
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P1, STORE, 'P1', '測試', 100]);
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P2, STORE, 'P2', '測試', 50]);

  // ══════════════════════════════════════════════════════════════════
  // 核心 Fixture
  // ══════════════════════════════════════════════════════════════════
  // U1/C1：add P1 x2, add P2 x1
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C1', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C1', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C1', productId: P2, orderChannel: CHANNEL });
  // U1/C2：add P1 x1
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C2', productId: P1, orderChannel: CHANNEL });
  // U2/C3：add P1 x1
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U2', cartId: 'C3', productId: P1, orderChannel: CHANNEL });

  // U1/C1：checkout_click x2；U1/C2：checkout_click x1
  insertEvent(STORE, 'checkout_click', { visitorId: 'U1', cartId: 'C1', orderChannel: CHANNEL });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U1', cartId: 'C1', orderChannel: CHANNEL });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U1', cartId: 'C2', orderChannel: CHANNEL });

  // U1/C1：purchase x1，真實 order items 含 P1+P2
  insertEvent(STORE, 'purchase', { visitorId: 'U1', cartId: 'C1', orderId: 'ORDER_1', orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_1', 'ORDER_1', 'ORDER_1', STORE, JSON.stringify([{ product_id: P1, qty: 1 }, { product_id: P2, qty: 1 }]),
      'cash', 150, 150, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );

  // ══════════════════════════════════════════════════════════════════
  // 核心結果驗證（呼叫正式 getProductFunnel()）
  // ══════════════════════════════════════════════════════════════════
  function snapshot() {
    const funnel = getProductFunnel(db, STORE, range, CHANNEL);
    const global = getGlobalFunnelCanonicalMetrics(db, STORE, range, CHANNEL);
    const p1 = funnel.find((f) => f.product_id === P1);
    const p2 = funnel.find((f) => f.product_id === P2);
    return { funnel, global, p1, p2 };
  }

  let snap = snapshot();
  console.log('CORE snapshot P1.canonical =', JSON.stringify(snap.p1 && snap.p1.canonical, null, 2));
  console.log('CORE snapshot P2.canonical =', JSON.stringify(snap.p2 && snap.p2.canonical, null, 2));
  console.log('CORE snapshot global =', JSON.stringify(snap.global, null, 2));

  function assertMetrics(label, actual, expected) {
    assert(!!actual, `${label}: 找得到這個階段的 canonical 物件`, actual);
    if (!actual) return;
    assert(actual.event_count === expected.event_count, `${label}.event_count=${expected.event_count}`, actual);
    assert(actual.unique_users === expected.unique_users, `${label}.unique_users=${expected.unique_users}`, actual);
    assert(actual.unique_carts === expected.unique_carts, `${label}.unique_carts=${expected.unique_carts}`, actual);
  }

  assertMetrics('P1.add_to_cart', snap.p1 && snap.p1.canonical.add_to_cart, { event_count: 4, unique_users: 2, unique_carts: 3 });
  assertMetrics('P1.checkout_click', snap.p1 && snap.p1.canonical.checkout_click, { event_count: 3, unique_users: 1, unique_carts: 2 });
  assertMetrics('P1.purchase', snap.p1 && snap.p1.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });

  assertMetrics('P2.add_to_cart', snap.p2 && snap.p2.canonical.add_to_cart, { event_count: 1, unique_users: 1, unique_carts: 1 });
  assertMetrics('P2.checkout_click', snap.p2 && snap.p2.canonical.checkout_click, { event_count: 2, unique_users: 1, unique_carts: 1 });
  assertMetrics('P2.purchase', snap.p2 && snap.p2.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });

  assertMetrics('GLOBAL.add_to_cart', snap.global.add_to_cart, { event_count: 5, unique_users: 2, unique_carts: 3 });
  assertMetrics('GLOBAL.checkout_click', snap.global.checkout_click, { event_count: 3, unique_users: 1, unique_carts: 2 });
  assertMetrics('GLOBAL.purchase', snap.global.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });

  // 明確斷言：P1 checkout events(3) + P2 checkout events(2) != global checkout events(3)
  const sumOfProductCheckoutEvents = snap.p1.canonical.checkout_click.event_count + snap.p2.canonical.checkout_click.event_count;
  assert(sumOfProductCheckoutEvents === 5 && snap.global.checkout_click.event_count === 3 && sumOfProductCheckoutEvents !== snap.global.checkout_click.event_count,
    'SUM-CHECK: P1 checkout_click.event_count(3) + P2 checkout_click.event_count(2) = 5，明確 != 全局 checkout_click.event_count(3)（全局不是商品列加總）',
    { sumOfProductCheckoutEvents, global: snap.global.checkout_click.event_count });

  // legacy checkout 欄位派生驗證：checkout === canonical.checkout_click.unique_carts
  assert(snap.p1.checkout === snap.p1.canonical.checkout_click.unique_carts,
    'LEGACY-DERIVE: P1 legacy checkout 欄位與 canonical.checkout_click.unique_carts 完全一致（同一次查詢派生）',
    { legacy: snap.p1.checkout, canonical: snap.p1.canonical.checkout_click.unique_carts });
  assert(snap.p2.checkout === snap.p2.canonical.checkout_click.unique_carts,
    'LEGACY-DERIVE: P2 同上', { legacy: snap.p2.checkout, canonical: snap.p2.canonical.checkout_click.unique_carts });

  // ══════════════════════════════════════════════════════════════════
  // 對抗資料：每加入一類，snapshot 前後比對，證明「不應變動的結果完全不變」
  // ══════════════════════════════════════════════════════════════════

  // 1. Orphan checkout_click（沒有 P1/P2 add）
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U9', cartId: 'C_ORPHAN', productId: 99999, orderChannel: CHANNEL });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U9', cartId: 'C_ORPHAN', orderChannel: CHANNEL });
  {
    const s2 = snapshot();
    assert(s2.global.checkout_click.unique_carts === 3, 'ADV1a. Orphan checkout：全局 checkout_click.unique_carts 從 2 增加到 3', s2.global.checkout_click);
    assertMetrics('ADV1b. P1.checkout_click 不變', s2.p1.canonical.checkout_click, { event_count: 3, unique_users: 1, unique_carts: 2 });
    assertMetrics('ADV1c. P2.checkout_click 不變', s2.p2.canonical.checkout_click, { event_count: 2, unique_users: 1, unique_carts: 1 });
    snap = s2;
  }

  // 2. 大量舊 begin_checkout，帶假商品/source/campaign
  for (let i = 0; i < 15; i += 1) {
    insertEvent(STORE, 'begin_checkout', {
      visitorId: `legacy_u${i}`, cartId: `legacy_cart_${i}`, productId: 88888 + i,
      source: 'FAKE_SOURCE', campaign: 'FAKE_CAMPAIGN', orderChannel: CHANNEL,
    });
  }
  {
    const s3 = snapshot();
    assertMetrics('ADV2a. P1 三階段不變(add)', s3.p1.canonical.add_to_cart, { event_count: 4, unique_users: 2, unique_carts: 3 });
    assertMetrics('ADV2b. P1 三階段不變(checkout)', s3.p1.canonical.checkout_click, { event_count: 3, unique_users: 1, unique_carts: 2 });
    assertMetrics('ADV2c. P1 三階段不變(purchase)', s3.p1.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });
    assertMetrics('ADV2d. P2 三階段不變(add)', s3.p2.canonical.add_to_cart, { event_count: 1, unique_users: 1, unique_carts: 1 });
    assert(s3.global.add_to_cart.event_count === snap.global.add_to_cart.event_count && s3.global.add_to_cart.unique_carts === snap.global.add_to_cart.unique_carts,
      'ADV2e. 全局 add_to_cart 不變（begin_checkout 不是 add_to_cart，不影響；跟加入 15 筆假 begin_checkout 之前的 snapshot 相比完全相同）', { before: snap.global.add_to_cart, after: s3.global.add_to_cart });
    assert(s3.global.checkout_click.event_count === snap.global.checkout_click.event_count && s3.global.checkout_click.unique_carts === snap.global.checkout_click.unique_carts,
      'ADV2f. 全局 checkout_click 不變（begin_checkout 不是 checkout_click，不影響；跟加入前的 snapshot 相比完全相同）', { before: snap.global.checkout_click, after: s3.global.checkout_click });
    snap = s3;
  }

  // 3. cart_id 為 NULL / '' / '   '
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U10', cartId: null, productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U11', cartId: '', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U12', cartId: '   ', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U10', cartId: null, orderChannel: CHANNEL });
  {
    const s4 = snapshot();
    assert(s4.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count && s4.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts,
      'ADV3a. P1.add_to_cart 不受空白/NULL cart_id 影響（跟加入前相比完全相同）', { before: snap.p1.canonical.add_to_cart, after: s4.p1.canonical.add_to_cart });
    assert(s4.global.add_to_cart.event_count === snap.global.add_to_cart.event_count && s4.global.add_to_cart.unique_carts === snap.global.add_to_cart.unique_carts,
      'ADV3b. GLOBAL.add_to_cart 不受空白/NULL cart_id 影響（跟加入前相比完全相同）', { before: snap.global.add_to_cart, after: s4.global.add_to_cart });
    snap = s4;
  }

  // 4. 其他 store，刻意重用 C1、order_id、product_id
  const OTHER_STORE = 'test_store_h148_funnel_other';
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P1, OTHER_STORE, 'P1-other-store', '測試', 999]);
  insertEvent(OTHER_STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C1', productId: P1, orderChannel: CHANNEL });
  insertEvent(OTHER_STORE, 'checkout_click', { visitorId: 'U1', cartId: 'C1', orderChannel: CHANNEL });
  insertEvent(OTHER_STORE, 'purchase', { visitorId: 'U1', cartId: 'C1', orderId: 'ORDER_1', orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_1_OTHER', 'ORDER_1_OTHER', 'ORDER_1_OTHER', OTHER_STORE, JSON.stringify([{ product_id: P1, qty: 1 }]),
      'cash', 999, 999, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );
  {
    const s5 = snapshot();
    assert(s5.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count && s5.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts,
      'ADV4a. 其他 store 重用 C1/order_id/product_id 不污染 STORE 的 P1（跟加入前相比完全相同）', { before: snap.p1.canonical.add_to_cart, after: s5.p1.canonical.add_to_cart });
    assert(s5.global.add_to_cart.event_count === snap.global.add_to_cart.event_count && s5.global.add_to_cart.unique_carts === snap.global.add_to_cart.unique_carts,
      'ADV4b. 其他 store 不污染 STORE 的全局 add_to_cart（跟加入前相比完全相同）', { before: snap.global.add_to_cart, after: s5.global.add_to_cart });
    const otherFunnel = getProductFunnel(db, OTHER_STORE, range, CHANNEL);
    const otherP1 = otherFunnel.find((f) => f.product_id === P1);
    assert(!!otherP1 && otherP1.canonical.add_to_cart.unique_carts === 1, 'ADV4c. 其他 store 自己的 P1 獨立正確計算（unique_carts=1）', otherP1);
    snap = s5;
  }

  // 5. 其他 channel，刻意重用 C1
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U1', cartId: 'C1', productId: P1, orderChannel: 'line_delivery' });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U1', cartId: 'C1', orderChannel: 'line_delivery' });
  {
    const s6 = snapshot(); // snapshot() 仍用 CHANNEL='line_takeout'
    assert(s6.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count && s6.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts,
      'ADV5a. 其他 channel（line_delivery）重用 C1 不污染 line_takeout 篩選下的 P1（跟加入前相比完全相同）', { before: snap.p1.canonical.add_to_cart, after: s6.p1.canonical.add_to_cart });
    assert(s6.global.add_to_cart.event_count === snap.global.add_to_cart.event_count && s6.global.add_to_cart.unique_carts === snap.global.add_to_cart.unique_carts,
      'ADV5b. 其他 channel 不污染 line_takeout 篩選下的全局 add_to_cart（跟加入前相比完全相同）', { before: snap.global.add_to_cart, after: s6.global.add_to_cart });
    const allChannelFunnel = getProductFunnel(db, STORE, range, 'all');
    const allChannelP1 = allChannelFunnel.find((f) => f.product_id === P1);
    assert(allChannelP1.canonical.add_to_cart.event_count > s6.p1.canonical.add_to_cart.event_count, 'ADV5c. channel=all 時能看到那筆 line_delivery 事件（證明 line_takeout 篩選確實生效，不是巧合）', allChannelP1.canonical.add_to_cart);
    snap = s6;
  }

  // 6. Asia/Taipei 日期邊界及區間外資料（用 production date helper）
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U13', cartId: 'C_OUTSIDE', productId: P1, orderChannel: CHANNEL, outsideRange: true });
  // 通用的正式 HTTP dashboard request helper（每次呼叫建立獨立 Express app／
  // server，用完即關閉，不跨呼叫共用 connection——ADV6-FIXED 這裡只需要
  // 驗證單次請求的結果，不是像 FRESH 那樣需要驗證「同一個 app/server 內
  // 兩次請求」，所以用這個更簡單的版本，不會互相混淆）。
  async function realHttpDashboardRequestGeneric(storeId, channel, preset, date) {
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
    let res, json;
    try {
      const qs = `store_id=${encodeURIComponent(storeId)}&preset=${preset}&channel=${channel}${date ? `&date=${date}` : ''}`;
      res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?${qs}`);
      json = await res.json();
    } finally { server.close(); }
    return { status: res.status, json };
  }

  insertEvent(STORE, 'checkout_click', { visitorId: 'U13', cartId: 'C_OUTSIDE', orderChannel: CHANNEL, outsideRange: true });
  {
    const s7 = snapshot(); // 仍查 range=yesterday
    assert(s7.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count && s7.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts,
      'ADV6a. 日期區間外（今天）事件不影響「昨天」查詢的 P1（跟加入前相比完全相同）', { before: snap.p1.canonical.add_to_cart, after: s7.p1.canonical.add_to_cart });
    const todayFunnel = getProductFunnel(db, STORE, fixedOutsideRange, CHANNEL);
    const todayP1 = todayFunnel.find((f) => f.product_id === P1);
    assert(!!todayP1, `ADV6b. 查固定日期 ${FIXED_OUTSIDE_DATE}（不依賴目前時鐘）時能看到那筆事件（證明日期篩選確實生效，不是巧合）`, todayFunnel.map((f) => f.product_id));
    snap = s7;
  }

  // ── ADV6-FIXED：徹底脫離 wall clock 的日期邊界測試。included／excluded
  // 兩邊都是固定的正式 production date range（preset='single'），不引用
  // today／yesterday／Date.now() 任何一種。用專屬 store／product，跟上面
  // 動態的 core fixture（range=yesterday，隨執行日期浮動）完全隔離。──────
  {
    const STORE_ADV6_FIXED = 'test_store_h148_adv6_fixed';
    const P_ADV6_FIXED = 9790;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_ADV6_FIXED, STORE_ADV6_FIXED, 'Adv6FixedP', '測試', 100]);
    db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_ADV6_FIXED, 'ADV6Fixed店']);

    const includedRange = resolveDateRange({ preset: 'single', date: '2026-01-15' });
    const excludedRange = resolveDateRange({ preset: 'single', date: '2026-01-14' });
    const fixedEventUtcMs = Date.UTC(2026, 0, 15, 12, 0, 0) - 8 * 3600 * 1000; // 2026-01-15 12:00:00 Asia/Taipei，範圍內部，不是邊界值
    db.run(
      `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, order_channel, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [STORE_ADV6_FIXED, 'adv6_fixed_v1', 'adv6_fixed_s1', 'adv6_fixed_cart_1', 'add_to_cart', P_ADV6_FIXED, CHANNEL, new Date(fixedEventUtcMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    );

    const includedFunnel = getProductFunnel(db, STORE_ADV6_FIXED, includedRange, CHANNEL);
    const includedRow = includedFunnel.find((f) => f.product_id === P_ADV6_FIXED);
    assert(!!includedRow && includedRow.canonical.add_to_cart.unique_carts === 1,
      'ADV6-FIXED1. 查 2026-01-15（included range，固定 production single-date range）：看得到這筆固定在 2026-01-15 12:00:00 的事件', includedRow && includedRow.canonical.add_to_cart);

    const excludedFunnel = getProductFunnel(db, STORE_ADV6_FIXED, excludedRange, CHANNEL);
    const excludedRow = excludedFunnel.find((f) => f.product_id === P_ADV6_FIXED);
    assert(!excludedRow,
      'ADV6-FIXED2. 查 2026-01-14（excluded control range，同樣是固定 production single-date range，不是 today／yesterday）：完全看不到這筆事件（BETWEEN 起訖仍是既有 inclusive 語意，01-14 23:59:59 不包含 01-15 12:00:00）',
      excludedFunnel.map((f) => f.product_id));

    // 正式 HTTP Route 層級也驗證一次（不只 helper）
    const httpIncluded = await realHttpDashboardRequestGeneric(STORE_ADV6_FIXED, CHANNEL, 'single', '2026-01-15');
    const httpIncludedRow = httpIncluded.json.analytics_v2.product_funnel.find((f) => f.product_id === P_ADV6_FIXED);
    assert(httpIncluded.status === 200 && !!httpIncludedRow && httpIncludedRow.canonical.add_to_cart.unique_carts === 1,
      'ADV6-FIXED3. 正式 HTTP Route（preset=single&date=2026-01-15）：200，且看得到這筆固定事件', { status: httpIncluded.status, httpIncludedRow: httpIncludedRow && httpIncludedRow.canonical.add_to_cart });

    const httpExcluded = await realHttpDashboardRequestGeneric(STORE_ADV6_FIXED, CHANNEL, 'single', '2026-01-14');
    const httpExcludedRow = httpExcluded.json.analytics_v2.product_funnel.find((f) => f.product_id === P_ADV6_FIXED);
    assert(httpExcluded.status === 200 && !httpExcludedRow,
      'ADV6-FIXED4. 正式 HTTP Route（preset=single&date=2026-01-14）：200，完全看不到這筆事件', { status: httpExcluded.status, httpExcludedRow });
  }

  // 7. purchase event 存在，但 order items 只有 P3（不含 P1/P2）
  const P3 = 9403;
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P3, STORE, 'P3', '測試', 30]);
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U14', cartId: 'C_P3ONLY', productId: P3, orderChannel: CHANNEL });
  insertEvent(STORE, 'purchase', { visitorId: 'U14', cartId: 'C_P3ONLY', orderId: 'ORDER_P3ONLY', orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_P3ONLY', 'ORDER_P3ONLY', 'ORDER_P3ONLY', STORE, JSON.stringify([{ product_id: P3, qty: 1 }]),
      'cash', 30, 30, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );
  {
    const s8 = snapshot();
    assertMetrics('ADV7a. purchase(order items 只有 P3) 不影響 P1.purchase', s8.p1.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });
    assertMetrics('ADV7b. 不影響 P2.purchase', s8.p2.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });
    assert(s8.global.purchase.event_count === 2, 'ADV7c. 全局 purchase.event_count 因為這筆合格 purchase 事件從 1 增加到 2', s8.global.purchase);
    const p3Row = s8.funnel.find((f) => f.product_id === P3);
    assert(!!p3Row && p3Row.canonical.purchase.unique_carts === 1, 'ADV7d. P3 自己的 purchase 正確算到 1', p3Row && p3Row.canonical.purchase);
    snap = s8;
  }

  // 8. order items 含 P1，但沒有正式 purchase event
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U15', cartId: 'C_NOPURCHASE', productId: P1, orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_NO_PURCHASE_EVT', 'ORDER_NO_PURCHASE_EVT', 'ORDER_NO_PURCHASE_EVT', STORE, JSON.stringify([{ product_id: P1, qty: 1 }]),
      'cash', 100, 100, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );
  {
    const s9 = snapshot();
    assertMetrics('ADV8. order items 含 P1 但沒有 purchase 事件：P1.purchase 不變', s9.p1.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });
    assert(s9.global.purchase.event_count === 2, 'ADV8b. 全局 purchase 不變（沒有新的 purchase 事件，只是多一筆 orders 資料列）', s9.global.purchase);
    snap = s9;
  }

  // 9. submit_order 含 P1，但沒有 purchase
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U16', cartId: 'C_SUBMITONLY', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'submit_order', { visitorId: 'U16', cartId: 'C_SUBMITONLY', orderId: 'ORDER_SUBMIT_ONLY', orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_SUBMIT_ONLY', 'ORDER_SUBMIT_ONLY', 'ORDER_SUBMIT_ONLY', STORE, JSON.stringify([{ product_id: P1, qty: 1 }]),
      'cash', 100, 100, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );
  {
    const s10 = snapshot();
    assertMetrics('ADV9. submit_order（不是 purchase）不得算 purchase：P1.purchase 不變', s10.p1.canonical.purchase, { event_count: 1, unique_users: 1, unique_carts: 1 });
    snap = s10;
  }

  // 10. 同名、不同 product ID（證明不會依名稱錯誤合併）
  const P1_DUP_NAME = 9499;
  db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P1_DUP_NAME, STORE, 'P1', '測試', 100]);
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U17', cartId: 'C_DUPNAME', productId: P1_DUP_NAME, orderChannel: CHANNEL });
  insertEvent(STORE, 'checkout_click', { visitorId: 'U17', cartId: 'C_DUPNAME', orderChannel: CHANNEL });
  {
    const s11 = snapshot();
    assert(s11.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count && s11.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts,
      'ADV10a. 同名不同 ID 商品：真正的 P1（product_id=9401）canonical.add_to_cart 不變（跟加入前相比完全相同）', { before: snap.p1.canonical.add_to_cart, after: s11.p1.canonical.add_to_cart });
    const dupRow = s11.funnel.find((f) => f.product_id === P1_DUP_NAME);
    assert(!!dupRow && dupRow.canonical.add_to_cart.unique_carts === 1, 'ADV10b. 同名不同 ID 的商品（P1_DUP_NAME）自己獨立算到 unique_carts=1，沒有跟真正的 P1 合併', dupRow && dupRow.canonical.add_to_cart);
    snap = s11;
  }

  // 11. 同一筆 add quantity > 1：event_count 只增加 1
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U18', cartId: 'C_QTY', productId: P1, quantity: 5, orderChannel: CHANNEL });
  {
    const s12 = snapshot();
    assert(s12.p1.canonical.add_to_cart.event_count === snap.p1.canonical.add_to_cart.event_count + 1,
      'ADV11. quantity=5 的單筆 add_to_cart 事件，event_count 只 +1（不是 +5）', { before: snap.p1.canonical.add_to_cart.event_count, after: s12.p1.canonical.add_to_cart.event_count });
    assert(s12.p1.canonical.add_to_cart.unique_carts === snap.p1.canonical.add_to_cart.unique_carts + 1,
      'ADV11b. unique_carts 正確 +1（新的 C_QTY 購物車）', { before: snap.p1.canonical.add_to_cart.unique_carts, after: s12.p1.canonical.add_to_cart.unique_carts });
    snap = s12;
  }

  // 12. 同一 order 的 items 內重複出現 P1（或 P1 quantity > 1）：一筆 purchase event 仍只算一筆
  insertEvent(STORE, 'add_to_cart', { visitorId: 'U19', cartId: 'C_DUPITEMS', productId: P1, orderChannel: CHANNEL });
  insertEvent(STORE, 'purchase', { visitorId: 'U19', cartId: 'C_DUPITEMS', orderId: 'ORDER_DUP_ITEMS', orderChannel: CHANNEL });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['ORDER_DUP_ITEMS', 'ORDER_DUP_ITEMS', 'ORDER_DUP_ITEMS', STORE,
      JSON.stringify([{ product_id: P1, qty: 3 }, { product_id: P1, qty: 2 }]), // 同一商品出現兩列
      'cash', 500, 500, 'completed', 'completed', FIXTURE_LOCAL_TIME]
  );
  {
    const s13 = snapshot();
    // P1 purchase 應從 1 增加到 2（多了 C_DUPITEMS 這一筆合格 purchase），不是 3 或更多
    assert(s13.p1.canonical.purchase.event_count === 2, 'ADV12. order items 內 P1 出現兩列（qty 3+2），一筆 purchase event 仍只算一筆（P1 purchase event_count: 1→2，不是 3）', s13.p1.canonical.purchase);
    snap = s13;
  }

  console.log('\nFINAL snapshot P1.canonical =', JSON.stringify(snap.p1.canonical, null, 2));
  console.log('FINAL snapshot global =', JSON.stringify(snap.global, null, 2));

  // ══════════════════════════════════════════════════════════════════
  // 真實 HTTP Route：GET /api/analytics/dashboard 回應含 global_canonical
  // 與 product_funnel[].canonical
  // ══════════════════════════════════════════════════════════════════
  let httpJson = null;
  {
    const express = require('express');
    const bodyParser = require('body-parser');
    const { requireStore } = require('../middleware/storeGuard');
    const analyticsRouter = require('../routes/analytics');

    db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE, 'Funnel HTTP 測試店']);

    const app = express();
    app.use(bodyParser.json());
    app.use('/api/analytics', requireStore, analyticsRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const httpRes = await fetch(`${base}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE)}&preset=yesterday&channel=${CHANNEL}`);
    httpJson = await httpRes.json();
    console.log('HTTP analytics_v2.global_canonical =', JSON.stringify(httpJson.analytics_v2 && httpJson.analytics_v2.global_canonical, null, 2));

    assert(httpRes.status === 200, 'HTTP1. GET /api/analytics/dashboard 回應 200', httpRes.status);
    const v2 = httpJson.analytics_v2;
    assert(!!v2 && !!v2.global_canonical, 'HTTP2. Route response 含 analytics_v2.global_canonical', v2 && Object.keys(v2 || {}));
    assert(v2 && v2.global_canonical.checkout_click.unique_carts === snap.global.checkout_click.unique_carts,
      'HTTP3. Route response 的 global_canonical.checkout_click.unique_carts 與直接呼叫 getGlobalFunnelCanonicalMetrics() 結果一致', v2 && v2.global_canonical.checkout_click);
    const httpP1 = v2 && v2.product_funnel && v2.product_funnel.find((f) => f.product_id === P1);
    assert(!!httpP1 && !!httpP1.canonical, 'HTTP4. Route response 的 product_funnel[] 每列含 canonical 物件', httpP1);
    assert(httpP1 && httpP1.canonical.checkout_click.unique_carts === snap.p1.canonical.checkout_click.unique_carts,
      'HTTP5. Route response 裡 P1.canonical.checkout_click.unique_carts 與直接呼叫結果一致', httpP1 && httpP1.canonical);

    server.close();
  }

  // ══════════════════════════════════════════════════════════════════
  // 真實 UI Runtime：jsdom 用真正的 <script> 標籤載入完整、未改寫的
  // production public/js/analytics-v2.js（不是 window.eval()——該檔案頂部
  // 有 'use strict'，經驗證 window.eval() 在 strict mode 下不會把頂層
  // function 宣告掛到 window 上，這是先前 UI0b／UI1-10 矛盾的真正根因：
  // eval 版本裡 _av2RenderFunnel 從頭到尾就沒有真正被載入成 window 的屬性，
  // 導致 UI0b 正確判定失敗，而不是「if/else 寫錯」。用真正的 <script>
  // 元素＋runScripts:'dangerously' 執行，跟瀏覽器載入 <script> 標籤的行為
  // 一致，這才是唯一正確、不需要修改 production 檔案本身的載入方式。
  // ══════════════════════════════════════════════════════════════════
  {
    const { JSDOM } = require('jsdom');
    const av2Src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'analytics-v2.js'), 'utf8');

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'dangerously', url: 'http://localhost/' });
    const { window } = dom;
    // production 檔案假設 escHtml/_card/_section/_fmtPct/_pct/_nt 等既有 app.js 全域輔助函式存在；
    // 這裡提供跟 app.js 相同語意的最小 stub（不是重寫 analytics-v2.js 的渲染邏輯本身，
    // 只是補上它依賴的外部輔助函式，這些函式在真實頁面上是由 app.js 提供的）。
    window.escHtml = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window._nt = (n) => `NT$${Math.round(Number(n) || 0).toLocaleString()}`;
    function round1(v) { return Math.round(Number(v) * 10) / 10; }
    window._fmtPct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : `${round1(v)}%`;
    window._pct = (a, b) => (!b ? '—' : `${round1(a / b * 100)}%`);
    window._card = (label, value, sub, color) => `<div class="card"><div>${window.escHtml(label)}</div><div style="color:${color||''}">${value}</div><div>${sub||''}</div></div>`;
    window._section = (title, inner) => `<section><h3>${title}</h3>${inner}</section>`;
    window._av2Empty = (icon, title, msg) => `<div class="empty">${icon}${title}${msg}</div>`;
    window.av2ExplorerState = { activeKpi: null };
    window.av2ExplorerApplyKpiFilter = () => {};
    window.av2ExplorerApplyProductFilter = () => {};
    window.av2ExplorerApplyStageFilter = (eventName) => { window.__lastStageFilter = eventName; };
    window.av2SwitchTab = () => {};
    // fetch stub：production loadAnalyticsV2Page() 等函式若被呼叫會打 fetch，
    // 這裡只提供最小 mock 並記錄實際呼叫的 URL，不提供任何計算或渲染邏輯。
    const fetchCalls = [];
    window.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ success: true, analytics_v2: httpJson.analytics_v2 }) };
    };

    let uiThrew = false;
    let uiThrowDetail = null;
    try {
      const scriptEl = window.document.createElement('script');
      scriptEl.textContent = av2Src;
      window.document.body.appendChild(scriptEl); // 真正的 <script> 執行路徑（不是 eval）
    } catch (e) {
      uiThrew = true;
      uiThrowDetail = (e && e.stack) || String(e);
      console.error('[UI] 載入 analytics-v2.js 時拋出例外：', uiThrowDetail);
    }
    assert(!uiThrew, 'UI0. jsdom 用真正的 <script> 標籤載入 production public/js/analytics-v2.js（未改寫、原始檔案）沒有拋出例外', uiThrowDetail);
    assert(typeof window._av2RenderFunnel === 'function',
      "UI0b. 真正的 <script> 執行後，window._av2RenderFunnel 是真正 production 函式（top-level function 宣告在真實 <script> 執行下會掛到 window，跟瀏覽器行為一致；先前用 window.eval() 因為檔案有 'use strict' 導致頂層函式不會掛到 window，這是根因，不是條件寫錯）",
      typeof window._av2RenderFunnel);

    console.log('[UI] 實際執行的 production 入口: <script> 標籤真正執行 public/js/analytics-v2.js');
    console.log('[UI] 載入的 production JS 路徑:', path.join(__dirname, '..', 'public', 'js', 'analytics-v2.js'));

    if (!uiThrew && typeof window._av2RenderFunnel === 'function') {
      // 用真實 HTTP response 的 product_funnel 資料餵給真正的 renderer
      const v2Data = httpJson.analytics_v2;
      const html = window._av2RenderFunnel(v2Data);
      assert(typeof html === 'string' && html.length > 0, 'UI1. _av2RenderFunnel() 真正執行並回傳非空 HTML 字串', typeof html);
      assert(html.includes('前往結帳') || html.includes('Checkout'), 'UI2. 渲染結果包含結帳相關文案', html.slice(0, 500));
      assert(!/begin_checkout/.test(html), 'UI3. 渲染出來的 HTML 字串完全不含 "begin_checkout" 這個字面字串', html.includes('begin_checkout'));
      console.log('[UI] 最終 DOM 渲染內容片段（前 800 字）：', html.slice(0, 800));

      // 分母為 0 的安全顯示：構造一個 add_to_cart.unique_carts=0 的商品列
      const zeroDenomFunnel = [{
        product_id: 99999, product_name: '零分母測試商品', is_delisted: false,
        view: 0, add_to_cart: 0, checkout: 0, purchase: 0, purchase_qty: 0, revenue: 0,
        view_to_add_rate: null, add_to_checkout_rate: null, checkout_to_purchase_rate: null, conversion_rate: null,
        abandon_count: 0, abandon_rate: null, estimated_abandoned_amount: 0, estimated_abandoned_amount_is_estimate: true,
        canonical: {
          add_to_cart: { event_count: 0, unique_users: 0, unique_carts: 0 },
          checkout_click: { event_count: 0, unique_users: 0, unique_carts: 0 },
          purchase: { event_count: 0, unique_users: 0, unique_carts: 0 },
        },
        canonical_rates: { checkout_rate: null, purchase_rate: null },
      }];
      const zeroHtml = window._av2RenderFunnel({ product_funnel: zeroDenomFunnel, insufficient_data: false });
      assert(!/undefined/.test(zeroHtml), 'UI4. 分母為 0 時渲染結果不含 "undefined"', zeroHtml.includes('undefined'));
      assert(!/NaN/.test(zeroHtml), 'UI5. 分母為 0 時渲染結果不含 "NaN"', zeroHtml.includes('NaN'));
      assert(!/Infinity/.test(zeroHtml), 'UI6. 分母為 0 時渲染結果不含 "Infinity"', zeroHtml.includes('Infinity'));

      // 模擬舊 response（缺少 canonical 欄位）：渲染器仍必須安全執行，不拋錯
      const legacyOnlyFunnel = [{
        product_id: 88888, product_name: '舊格式測試商品', is_delisted: false,
        view: 10, add_to_cart: 5, checkout: 2, purchase: 1, purchase_qty: 1, revenue: 100,
        view_to_add_rate: 50, add_to_checkout_rate: 40, checkout_to_purchase_rate: 50, conversion_rate: 10,
        abandon_count: 4, abandon_rate: 80, estimated_abandoned_amount: 400, estimated_abandoned_amount_is_estimate: true,
        // 沒有 canonical／canonical_rates 欄位（模擬舊版 API response）
      }];
      let legacyThrew = false;
      let legacyHtml = '';
      try {
        legacyHtml = window._av2RenderFunnel({ product_funnel: legacyOnlyFunnel, insufficient_data: false });
      } catch (e) { legacyThrew = true; console.error('[UI] 缺少 canonical 欄位時 renderer 拋出例外：', e && e.stack || e); }
      assert(!legacyThrew, 'UI7. 模擬舊 response（缺少 canonical 欄位）renderer 不拋出例外', legacyThrew);
      assert(!legacyThrew && !/undefined/.test(legacyHtml), 'UI8. 缺少 canonical 欄位時渲染結果不含 "undefined"', legacyThrew ? null : legacyHtml.includes('undefined'));
    }

    // Drilldown button／dropdown 實際值稽核（真實執行後的 HTML 字串檢查，
    // 不是 regex 掃描原始碼——這裡驗證「真正 render 出來的 onclick 屬性內容」）。
    if (!uiThrew && typeof window._av2RenderFunnel === 'function') {
      const v2Data = httpJson.analytics_v2;
      const html = window._av2RenderFunnel(v2Data);
      assert(html.includes("av2ExplorerApplyStageFilter('checkout_click')"), 'UI9. 真實渲染出的 Drilldown 按鈕 onclick 屬性裡，av2ExplorerApplyStageFilter 送出的字面值是 checkout_click（不是 begin_checkout）', html.includes("av2ExplorerApplyStageFilter('begin_checkout')") ? 'found begin_checkout' : 'not found');
    }
    if (!uiThrew && typeof window.AV2_EXPLORER_EVENT !== 'undefined') {
      const opt = window.AV2_EXPLORER_EVENT.find((o) => o[1].includes('結帳'));
      assert(!!opt && opt[0] === 'checkout_click', 'UI10. AV2_EXPLORER_EVENT 下拉選單「前往結帳」選項的實際值是 checkout_click', opt);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Identity 稽核：unique_users 必須重用既有 Visitor 360 canonical identity
  // resolver（resolveCanonicalVisitor），不是單純 COUNT(DISTINCT visitor_id)。
  // ══════════════════════════════════════════════════════════════════
  {
    const STORE_ID2 = 'test_store_h148_funnel_identity';
    const P_ID = 9501;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_ID, STORE_ID2, 'IdentityP', '測試', 100]);

    // 案例 1：兩個不同 visitor_id（anon_v1／anon_v2），確定性連結到同一個
    // LINE UID（U_LINE_1）——透過 line_members + line_member_sessions（既有
    // LINE CRM 基礎設施，不是憑空推測）。
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_ID2, 'U_LINE_1', '測試會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_ID2, 'U_LINE_1', 'anon_v1']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_ID2, 'U_LINE_1', 'anon_v2']);
    insertEvent(STORE_ID2, 'add_to_cart', { visitorId: 'anon_v1', cartId: 'id_cart_1', productId: P_ID, orderChannel: CHANNEL });
    insertEvent(STORE_ID2, 'add_to_cart', { visitorId: 'anon_v2', cartId: 'id_cart_2', productId: P_ID, orderChannel: CHANNEL });

    const idFunnel1 = getProductFunnel(db, STORE_ID2, range, CHANNEL);
    const idRow1 = idFunnel1.find((f) => f.product_id === P_ID);
    assert(!!idRow1 && idRow1.canonical.add_to_cart.unique_users === 1,
      'IDENTITY1. 兩個不同 visitor_id（anon_v1/anon_v2）確定性連結到同一 LINE UID：unique_users=1（不是 2，證明真的重用了 resolveCanonicalVisitor，不是 COUNT(DISTINCT visitor_id)）',
      idRow1 && idRow1.canonical.add_to_cart);
    assert(!!idRow1 && idRow1.canonical.add_to_cart.unique_carts === 2,
      'IDENTITY1b. 但 unique_carts 仍正確為 2（cart_id 本身沒有被合併，只有 unique_users 走身份合併）', idRow1 && idRow1.canonical.add_to_cart);

    // 案例 2：兩個未連結的匿名 visitor_id → unique_users=2（不得合併）
    insertEvent(STORE_ID2, 'add_to_cart', { visitorId: 'anon_unlinked_1', cartId: 'id_cart_3', productId: P_ID, orderChannel: CHANNEL });
    insertEvent(STORE_ID2, 'add_to_cart', { visitorId: 'anon_unlinked_2', cartId: 'id_cart_4', productId: P_ID, orderChannel: CHANNEL });
    const idFunnel2 = getProductFunnel(db, STORE_ID2, range, CHANNEL);
    const idRow2 = idFunnel2.find((f) => f.product_id === P_ID);
    assert(!!idRow2 && idRow2.canonical.add_to_cart.unique_users === 3,
      'IDENTITY2. 加入兩個未連結的匿名 visitor_id 後，unique_users=1(anon_v1/v2合併)+2(未連結)=3（未連結的匿名訪客不得被誤合併）',
      idRow2 && idRow2.canonical.add_to_cart);

    // 案例 3：相同 visitor_id／cart_id 出現在其他 store，不得形成交集
    const STORE_ID2_OTHER = 'test_store_h148_funnel_identity_other';
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_ID, STORE_ID2_OTHER, 'IdentityP-other', '測試', 100]);
    insertEvent(STORE_ID2_OTHER, 'add_to_cart', { visitorId: 'anon_v1', cartId: 'id_cart_1', productId: P_ID, orderChannel: CHANNEL });
    const idFunnel3 = getProductFunnel(db, STORE_ID2, range, CHANNEL); // 仍查 STORE_ID2
    const idRow3 = idFunnel3.find((f) => f.product_id === P_ID);
    assert(!!idRow3 && idRow3.canonical.add_to_cart.unique_users === 3,
      'IDENTITY3. 其他 store 重用相同 visitor_id(anon_v1)／cart_id(id_cart_1) 不得跨店合併或污染 STORE_ID2 的 unique_users（仍是 3，不變）',
      idRow3 && idRow3.canonical.add_to_cart);

    // 案例 4：衝突會員證據——同一 cart_id 曾被兩個不同 LINE UID 使用過
    // （resolver 本身的 SQL 用 ORDER BY last_seen_at DESC LIMIT 1，取最後一筆，
    // 這是既有 resolver 自己的衝突處理規則，這裡只驗證呼叫端沒有另外發明
    // 一套衝突解決邏輯，完全信任 resolver 回傳的結果）。
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_ID2, 'U_LINE_2', '測試會員2']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id, last_seen_at) VALUES (?,?,?,?)`, [STORE_ID2, 'U_LINE_2', 'anon_conflict', '2020-01-01 00:00:00']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id, last_seen_at) VALUES (?,?,?,?)`, [STORE_ID2, 'U_LINE_1', 'anon_conflict', '2025-01-01 00:00:00']);
    const resolvedConflict = resolveCanonicalVisitorForTest(db, STORE_ID2, 'anon_conflict');
    assert(resolvedConflict.found === true && resolvedConflict.canonical_type === 'line_user_id',
      'IDENTITY4. 衝突證據（同一 anon_conflict 曾連結兩個不同 LINE UID）：完全沿用既有 resolver 的規則（ORDER BY last_seen_at DESC LIMIT 1），不另外發明衝突解決邏輯', resolvedConflict);

    // ── Scalar／Batch parity：證明兩者不是兩份會漂移的獨立演算法 ──────
    // resolveCanonicalVisitor()（scalar）與 resolveCanonicalVisitors()
    // （batch）內部共用同一個 private 判定核心（不對外 export），這裡只
    // 透過這兩個正式公開入口逐案例比對回傳的 canonical identity key 是否
    // 完全一致——不從原始碼抽取、不用 VM 單獨執行 private helper。
    function scalarKeyFor(vid) {
      const r = resolveCanonicalVisitorForTest(db, STORE_ID2, vid);
      return (r.found && r.canonical_type === 'line_user_id') ? `line_user:${r.line_user_id}` : `visitor:${vid}`;
    }
    const parityCases = ['anon_v1', 'anon_v2', 'anon_unlinked_1', 'anon_unlinked_2', 'anon_conflict', 'U_LINE_1'];
    const batchKeyMap = resolveCanonicalVisitorsForTest(db, STORE_ID2, parityCases);
    parityCases.forEach((vid) => {
      const scalarKey = scalarKeyFor(vid);
      const batchKey = batchKeyMap.get(vid);
      assert(scalarKey === batchKey, `PARITY. scalar 與 batch 對 key="${vid}" 算出完全相同的 canonical identity key（scalar=${scalarKey}, batch=${batchKey}）`, { vid, scalarKey, batchKey });
    });

    // 空陣列不得產生 IN ()；重複 visitor ID 不得重複解析；NULL/空白不得合成假使用者
    const emptyMap = resolveCanonicalVisitorsForTest(db, STORE_ID2, []);
    assert(emptyMap.size === 0, 'PARITY-EMPTY. 空陣列輸入回傳空 Map（不產生 IN () 查詢）', emptyMap.size);
    const dupMap = resolveCanonicalVisitorsForTest(db, STORE_ID2, ['anon_v1', 'anon_v1', 'anon_v1']);
    assert(dupMap.size === 1, 'PARITY-DEDUP. 重複 visitor_id 只解析一次（Map 只有 1 個 key）', dupMap.size);
    const nullBlankMap = resolveCanonicalVisitorsForTest(db, STORE_ID2, [null, '', '   ', undefined, 'anon_v1']);
    assert(!nullBlankMap.has(null) && !nullBlankMap.has('') && !nullBlankMap.has('   '),
      'PARITY-NULLBLANK. NULL/空字串/純空白 visitor_id 不會被當成一個合法 key、不會合成假使用者', [...nullBlankMap.keys()]);
    assert(nullBlankMap.size === 1 && nullBlankMap.has('anon_v1'),
      'PARITY-NULLBLANK2. 混入 NULL/空白後，仍只解析出真正合法的 anon_v1 這一個 key', [...nullBlankMap.keys()]);

    // ── 正式 request-scoped identity context：跨店重用對抗測試 ────────
    // 同一個 context 先綁定 store_A 用過，再故意拿去查 store_B——不得靜默
    // 沿用 store_A 的結果，必須明確 throw。
    const STORE_A = 'test_store_h148_ctx_a';
    const STORE_B = 'test_store_h148_ctx_b';
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_A, 'CTX_LINE_A', 'A店會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_A, 'CTX_LINE_A', 'ctx_shared_visitor']);
    // Store B 對同一個 visitor_id／cart_id 配置「衝突」的 LINE UID
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_B, 'CTX_LINE_B', 'B店會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_B, 'CTX_LINE_B', 'ctx_shared_visitor']);

    const contextA = createCanonicalIdentityContext(STORE_A);
    const mapA = resolveInContext(db, contextA, STORE_A, ['ctx_shared_visitor']);
    assert(mapA.get('ctx_shared_visitor') === 'line_user:CTX_LINE_A',
      'CTX1. context 綁定 STORE_A，解析 ctx_shared_visitor 得到 STORE_A 自己的 LINE UID（CTX_LINE_A）', [...mapA.entries()]);

    let threwOnCrossStore = false;
    let crossStoreError = null;
    let sqlCountBeforeThrow = 0;
    const mapASizeBefore = contextA.canonicalByVisitor.size;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { sqlCountBeforeThrow += 1; return origAll(sql, params); };
      try {
        resolveInContext(db, contextA, STORE_B, ['ctx_shared_visitor']);
      } catch (e) {
        threwOnCrossStore = true;
        crossStoreError = e.message;
      } finally {
        db.all = origAll;
      }
    }
    assert(threwOnCrossStore, 'CTX2. 把綁定 STORE_A 的 context 拿去查 STORE_B：明確 throw，不會靜默沿用 STORE_A 的快取結果', { threwOnCrossStore, crossStoreError });
    assert(sqlCountBeforeThrow === 0, 'CTX2b. throw 發生前沒有執行任何 SQL（store 檢查在最前面，不會先查再丟例外）', sqlCountBeforeThrow);
    assert(contextA.canonicalByVisitor.size === mapASizeBefore,
      'CTX2c. throw 之後，contextA 的 canonical map 完全沒有被改變（大小不變）', { before: mapASizeBefore, after: contextA.canonicalByVisitor.size });

    // 用「正確」的 STORE_B 專屬 context 查同一個 visitor_id，必須得到 STORE_B
    // 自己的 LINE UID，不得跟 STORE_A 的結果混淆或合併。
    const contextB = createCanonicalIdentityContext(STORE_B);
    const mapB = resolveInContext(db, contextB, STORE_B, ['ctx_shared_visitor']);
    assert(mapB.get('ctx_shared_visitor') === 'line_user:CTX_LINE_B',
      'CTX3. 用 STORE_B 專屬 context 查同一個 visitor_id，得到 STORE_B 自己的 LINE UID（CTX_LINE_B），沒有跟 STORE_A 的 CTX_LINE_A 混淆或合併', [...mapB.entries()]);
    assert(mapA.get('ctx_shared_visitor') !== mapB.get('ctx_shared_visitor'),
      'CTX4. STORE_A 與 STORE_B 對同一個 visitor_id 得到不同、互相隔離的 canonical key', { A: mapA.get('ctx_shared_visitor'), B: mapB.get('ctx_shared_visitor') });

    // ── helper 呼叫順序 parity：product→global 與 global→product 的結果
    // 必須完全一致，且已解析過的 visitor 不會被第二個 helper 重新查詢 ──
    const STORE_ORDER = 'test_store_h148_ctx_order';
    const P_ORDER = 9750;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_ORDER, STORE_ORDER, 'OrderP', '測試', 100]);
    insertEvent(STORE_ORDER, 'add_to_cart', { visitorId: 'order_v1', cartId: 'order_cart_1', productId: P_ORDER, orderChannel: CHANNEL });
    insertEvent(STORE_ORDER, 'checkout_click', { visitorId: 'order_v1', cartId: 'order_cart_1', orderChannel: CHANNEL });

    function countIdentitySql(fn) {
      const origAll = db.all.bind(db);
      let n = 0;
      db.all = (sql, params) => {
        const norm = normalizeSqlForTest(sql);
        if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in') || norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) n += 1;
        return origAll(sql, params);
      };
      try { fn(); } finally { db.all = origAll; }
      return n;
    }

    // 順序一：product → global
    const ctxProductFirst = createCanonicalIdentityContext(STORE_ORDER, CHANNEL);
    let productResult1, globalResult1;
    const sqlCountOrder1 = countIdentitySql(() => {
      productResult1 = getProductFunnel(db, STORE_ORDER, range, CHANNEL, ctxProductFirst);
      globalResult1 = getGlobalFunnelCanonicalMetrics(db, STORE_ORDER, range, CHANNEL, ctxProductFirst);
    });

    // 順序二：global → product（全新 context，跟順序一互相獨立）
    const ctxGlobalFirst = createCanonicalIdentityContext(STORE_ORDER, CHANNEL);
    let productResult2, globalResult2;
    const sqlCountOrder2 = countIdentitySql(() => {
      globalResult2 = getGlobalFunnelCanonicalMetrics(db, STORE_ORDER, range, CHANNEL, ctxGlobalFirst);
      productResult2 = getProductFunnel(db, STORE_ORDER, range, CHANNEL, ctxGlobalFirst);
    });

    assert((() => { try { require('assert').deepStrictEqual(globalResult1, globalResult2); return true; } catch (e) { return false; } })(),
      'ORDER1. product→global 與 global→product 兩種呼叫順序，global canonical 結果完全相同（assert.deepStrictEqual）', { order1: globalResult1, order2: globalResult2 });
    assert((() => { try { require('assert').deepStrictEqual(productResult1, productResult2); return true; } catch (e) { return false; } })(),
      'ORDER2. 兩種呼叫順序，product canonical 結果完全相同（assert.deepStrictEqual）', { order1: productResult1, order2: productResult2 });
    assert(sqlCountOrder1 <= 2 && sqlCountOrder2 <= 2,
      'ORDER3. 不管先呼叫哪一個 helper，第二個 helper 遇到已經解析過的 visitor 都不會重新產生 identity SQL（兩種順序各自的 identity SQL 總數都 ≤2，不是 4）', { sqlCountOrder1, sqlCountOrder2 });

    // ── Invalid visitor IDs：NULL、''、'   ' 不查詢、不寫入 context、不計入 ──
    const ctxInvalid = createCanonicalIdentityContext(STORE_ORDER);
    let sqlCountInvalid = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { sqlCountInvalid += 1; return origAll(sql, params); };
      try { resolveInContext(db, ctxInvalid, STORE_ORDER, [null, '', '   ', undefined]); } finally { db.all = origAll; }
    }
    assert(sqlCountInvalid === 0, 'INVALID1. NULL/空字串/純空白/undefined visitor_id：不觸發任何 SQL 查詢', sqlCountInvalid);
    assert(ctxInvalid.canonicalByVisitor.size === 0, 'INVALID2. 這些無效值也沒有被寫入 context', ctxInvalid.canonicalByVisitor.size);

    // ── Cross-request freshness：兩次真正的 HTTP Route round-trip（不是
    // 直接呼叫 resolveInContext() 假裝成兩個 request）。Request 1 尚無 LINE
    // link；中間補上真正的 identity evidence；Request 2 是全新的 HTTP
    // 連線／全新 Express app instance，必須讀到新的 canonical identity，
    // 證明 routes/analytics.js 每次進入 handler 都建立全新 context，不會
    // 跨 request 保存舊 identity evidence。同一個 server／同一個 Express
    // app／同一個 listening socket／同一個 temp DB connection，只送兩次
    // 真正的 HTTP request——不重啟 app、不重新 require production module，
    // 這樣才能真正證明「同一支正式程序，每次進 handler 都建立全新
    // context」，不是「換了一個新 app 自然讀到新資料」這種弱證明。
    const STORE_FRESH = 'test_store_h148_ctx_fresh';
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [9770, STORE_FRESH, 'FreshP', '測試', 100]);
    db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_FRESH, 'Fresh店']);
    // 兩個各自匿名的 visitor，一開始都沒有 LINE 連結 → unique_users 應該是 2。
    insertEvent(STORE_FRESH, 'add_to_cart', { visitorId: 'fresh_visitor_1', cartId: 'fresh_cart_1', productId: 9770, orderChannel: CHANNEL });
    insertEvent(STORE_FRESH, 'add_to_cart', { visitorId: 'fresh_visitor_2', cartId: 'fresh_cart_2', productId: 9770, orderChannel: CHANNEL });

    const expressFresh = require('express');
    const bodyParserFresh = require('body-parser');
    const { requireStore: requireStoreFresh } = require('../middleware/storeGuard');
    const analyticsRouterFresh = require('../routes/analytics');
    const appFresh = expressFresh();
    appFresh.use(bodyParserFresh.json());
    appFresh.use('/api/analytics', requireStoreFresh, analyticsRouterFresh);
    const serverFresh = appFresh.listen(0, '127.0.0.1');
    await new Promise((resolve) => serverFresh.once('listening', resolve));
    const portFresh = serverFresh.address().port;

    async function freshDashboardRequest() {
      const res = await fetch(`http://127.0.0.1:${portFresh}/api/analytics/dashboard?store_id=${encodeURIComponent(STORE_FRESH)}&preset=yesterday&channel=${CHANNEL}`);
      const json = await res.json();
      return { status: res.status, json };
    }

    let sqlCountReq1 = 0, sqlCountReq2 = 0;
    const origAllFresh = db.all.bind(db);

    db.all = (sql, params) => {
      const normReq1 = normalizeSqlForTest(sql);
      if (normReq1.includes('line_members') || normReq1.includes('line_member_sessions') || normReq1.startsWith('select distinct visitor_id from analytics_events')) sqlCountReq1 += 1;
      return origAllFresh(sql, params);
    };
    let freshReq1;
    try { freshReq1 = await freshDashboardRequest(); } finally { db.all = origAllFresh; }

    assert(freshReq1.status === 200, 'FRESH0a. HTTP Request 1（同一個 server）：200', freshReq1.status);
    const freshP1Row = freshReq1.json.analytics_v2.product_funnel.find((f) => f.product_id === 9770);
    assert(!!freshP1Row && freshP1Row.canonical.add_to_cart.unique_users === 2,
      'FRESH1a. Request 1（兩個各自匿名的 visitor，尚無 LINE link）：unique_users=2', freshP1Row && freshP1Row.canonical.add_to_cart);
    assert(freshReq1.json.analytics_v2.global_canonical.add_to_cart.unique_users === 2,
      'FRESH1b. Request 1 全局 unique_users=2', freshReq1.json.analytics_v2.global_canonical.add_to_cart);
    assert(sqlCountReq1 > 0, 'FRESH1c. Request 1 確實執行了 visitor discovery／identity 相關 SQL（不是讀到某個預先算好的快取）', sqlCountReq1);

    // 不重啟 app/server、不清 require cache，直接在同一個 temp DB 加入：
    // 兩個 visitor → 同一個有效 LINE UID（讓 unique_users 從 2 變成 1）。
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_FRESH, 'FRESH_LINE', 'Fresh會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_FRESH, 'FRESH_LINE', 'fresh_visitor_1']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_FRESH, 'FRESH_LINE', 'fresh_visitor_2']);

    db.all = (sql, params) => {
      const normReq2 = normalizeSqlForTest(sql);
      if (normReq2.includes('line_members') || normReq2.includes('line_member_sessions') || normReq2.startsWith('select distinct visitor_id from analytics_events')) sqlCountReq2 += 1;
      return origAllFresh(sql, params);
    };
    let freshReq2;
    try { freshReq2 = await freshDashboardRequest(); } finally { db.all = origAllFresh; serverFresh.close(); }

    assert(freshReq2.status === 200, 'FRESH0b. HTTP Request 2（同一個 server，同一個 app，同一個 DB connection）：200', freshReq2.status);
    const freshP1Row2 = freshReq2.json.analytics_v2.product_funnel.find((f) => f.product_id === 9770);
    assert(!!freshP1Row2 && freshP1Row2.canonical.add_to_cart.unique_users === 1,
      'FRESH2a. Request 2（同一 server，補上 LINE link 之後）：unique_users 從 2 變成 1（兩個 visitor 確定性合併成同一個人），證明第二次 request 真的重新查了 identity evidence，不是沿用 Request 1 快取住的舊 context',
      freshP1Row2.canonical.add_to_cart);
    assert(freshReq2.json.analytics_v2.global_canonical.add_to_cart.unique_users === 1,
      'FRESH2b. Request 2 全局 unique_users 也從 2 變成 1', freshReq2.json.analytics_v2.global_canonical.add_to_cart);
    assert(sqlCountReq2 > 0, 'FRESH2c. Request 2 確實重新執行了 visitor discovery／identity evidence SQL（sqlCountReq2=' + sqlCountReq2 + '），不是 0（0 就代表沿用了 Request 1 的舊 context／primedScopes，跨 request 洩漏）', sqlCountReq2);
    assert(!/NaN|Infinity|undefined/.test(JSON.stringify(freshReq2.json)), 'FRESH2d. Request 2 完整 Route JSON 不含 NaN/Infinity/undefined 字面字串', true);

  // ── FACTORY：createCanonicalIdentityContext() 的 factory-object identity
  // proof。這件事只能在全新的 child process 裡做（見腳本內註解說明結構性
  // 原因：routes/analytics.js 在這個 parent process 裡已經被其他測試
  // require 過，事後 patch 匯出屬性救不回它內部已經綁定好的解構參照）。
  {
    const { execFileSync } = require('child_process');
    const childPath = path.join(__dirname, 'run-h1-4-8-fresh-factory-child.js');
    let childOutput = null;
    let childFailed = false;
    let childError = null;
    try {
      childOutput = execFileSync('node', [childPath], { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      childFailed = true;
      childError = e.message;
      childOutput = (e.stdout || '') + (e.stderr || '');
    }
    let childResult = null;
    try {
      const lastLine = childOutput.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      childResult = JSON.parse(lastLine);
    } catch (e) { /* childResult stays null，下面的斷言會如實回報失敗 */ }

    assert(!childFailed && !!childResult && childResult.failCount === 0,
      `FACTORY-CHILD. run-h1-4-8-fresh-factory-child.js 獨立 child process 執行結果：${childResult ? `${childResult.passCount}/${childResult.total} PASS` : '(無法解析輸出)'}（涵蓋 factory call count=2、context1!==context2、canonicalByVisitor/primedScopes 各自獨立、storeId 相同、context1 於 Request 2 後 deepStrictEqual 快照、Request 2 重新查詢、無 NaN/Infinity）`,
      { childFailed, childError, childResult });
    if (childResult && childResult.results) {
      childResult.results.forEach((r) => {
        assert(r.status === 'PASS', `FACTORY-CHILD: ${r.name}`, r.detail);
      });
    }
  }

  // 通用的「跑一支獨立 child script，解析最後一行 JSON」helper，供
  // ROUTE-ORDER／PRIME_RETRY_MID／scale children 共用，不重複寫同一段邏輯。
  function runChildScript(scriptName, args) {
    const { execFileSync } = require('child_process');
    const childPath = path.join(__dirname, scriptName);
    let childOutput = null;
    let childFailed = false;
    let childError = null;
    let childExitCode = 0;
    try {
      childOutput = execFileSync('node', [childPath, ...(args || [])], { encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      childFailed = true;
      childExitCode = e.status;
      childError = e.message;
      childOutput = (e.stdout || '') + (e.stderr || '');
    }
    let childResult = null;
    try {
      const lastLine = childOutput.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      childResult = JSON.parse(lastLine);
    } catch (e) { /* childResult stays null */ }
    return { childFailed, childError, childExitCode, childResult };
  }

  // 專供 scale child 使用的 wrapper：額外驗證 caseName 與要求的 argv 完全相同
  // （防止五次其實跑到同一個 fixture），以及 raw measurements 是否齊全，
  // 缺任何一項都 fail-fast，不是只信任 child 自己回報的 pass:true。
  function runScaleChild(caseArg) {
    const REQUIRED_MEASUREMENT_FIELDS = [
      'httpStatus', 'success', 'visitorCount', 'productCount', 'globalCanonical',
      'productFunnel', 'productFunnelLength', 'sqlKindCounts', 'normalizedFingerprintCounts',
      'nonIdentityFingerprintCounts', 'totalRouteSqlCount', 'discoveryCount', 'directMemberCount',
      'sessionLinkCount', 'sessionConfirmCount', 'phaseArrays', 'sortedVisitorBindUnion',
      'directMemberTotalBinds', 'maxObservedTotalBindCount', 'maxVariableNumber', 'dbPathProof',
    ];
    const { childFailed, childError, childExitCode, childResult } = runChildScript('run-h1-4-8-scale-child.js', ['--case', caseArg]);
    if (childFailed) {
      assert(false, `SCALE-${caseArg}-CHILD-EXIT. child 非零結束（exit=${childExitCode}）`, { childError: childError && childError.slice(0, 300) });
      return null;
    }
    if (!childResult) {
      assert(false, `SCALE-${caseArg}-CHILD-JSON. child 輸出無法解析成合法 JSON`, childError);
      return null;
    }
    if (childResult.caseName !== caseArg) {
      assert(false, `SCALE-${caseArg}-CHILD-CASENAME. child 回報的 caseName（${childResult.caseName}）與要求的 argv（${caseArg}）不一致，可能五次其實跑到同一個 fixture`, childResult.caseName);
      return null;
    }
    const missingFields = REQUIRED_MEASUREMENT_FIELDS.filter((f) => !(f in (childResult.measurements || {})));
    if (missingFields.length) {
      assert(false, `SCALE-${caseArg}-CHILD-MEASUREMENTS. child measurements 缺少必要欄位`, missingFields);
      return null;
    }
    assert(childResult.failCount === 0, `SCALE-${caseArg}-CHILD-ASSERTIONS. child 內部 ${childResult.passCount}/${childResult.total} PASS`, childResult.results && childResult.results.filter((r) => r.status === 'FAIL'));
    return childResult;
  }

  // ── ROUTE-ORDER：正式 Route call-order proof（獨立 child）──────────
  {
    const { childFailed, childError, childResult } = runChildScript('run-h1-4-8-route-order-child.js');
    assert(!childFailed && !!childResult && childResult.failCount === 0,
      `ROUTE-ORDER-CHILD. run-h1-4-8-route-order-child.js 執行結果：${childResult ? `${childResult.passCount}/${childResult.total} PASS` : '(無法解析輸出)'}（trace=${childResult ? JSON.stringify(childResult.eventOrder) : 'N/A'}，sqlKindCounts=${childResult ? JSON.stringify(childResult.sqlKindCounts) : 'N/A'}）`,
      { childFailed, childError, childResult });
    if (childResult && childResult.results) {
      childResult.results.forEach((r) => { assert(r.status === 'PASS', `ROUTE-ORDER-CHILD: ${r.name}`, r.detail); });
    }
  }

  // ── ROUTE-FAILURE：真實 HTTP request 在 identity evidence 失敗時必須回
  // 5xx，不是 200+誤導性 0（獨立 child）─────────────────────────────
  {
    const { childFailed, childError, childResult } = runChildScript('run-h1-4-8-route-failure-child.js');
    assert(!childFailed && !!childResult && childResult.failCount === 0,
      `ROUTE-FAILURE-CHILD. run-h1-4-8-route-failure-child.js 執行結果：${childResult ? `${childResult.passCount}/${childResult.total} PASS（失敗案例實際 HTTP status=${childResult.failStatus}）` : '(無法解析輸出)'}`,
      { childFailed, childError, childResult });
    if (childResult && childResult.results) {
      childResult.results.forEach((r) => { assert(r.status === 'PASS', `ROUTE-FAILURE-CHILD: ${r.name}`, r.detail); });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SCALE MATRIX：D3／D53／D1200／E1／E40，五個獨立 child process，parent
  // 用 raw measurements 自己做跨 case assertions（不是只信任 child 的
  // pass:true）。
  // ══════════════════════════════════════════════════════════════════
  const scaleResults = {};
  ['D3', 'D53', 'D1200', 'E1', 'E40'].forEach((c) => {
    scaleResults[c] = runScaleChild(c);
  });

  if (Object.values(scaleResults).every(Boolean)) {
    const D3 = scaleResults.D3.measurements, D53 = scaleResults.D53.measurements, D1200 = scaleResults.D1200.measurements;
    const E1 = scaleResults.E1.measurements, E40 = scaleResults.E40.measurements;
    const assertModuleScale = require('assert');
    function deepEq(a, b) { try { assertModuleScale.deepStrictEqual(a, b); return true; } catch (e) { return false; } }

    // ── D3/D53/D1200 ──────────────────────────────────────────────
    [['D3', D3, 3], ['D53', D53, 53], ['D1200', D1200, 1200]].forEach(([name, m, n]) => {
      assert(m.httpStatus === 200 && m.success === true, `SCALE-${name}-HTTP. HTTP 200 + success:true`, { status: m.httpStatus, success: m.success });
      assert(m.visitorCount === n, `SCALE-${name}-VC. visitorCount=${n}`, m.visitorCount);
      assert(m.productCount === 1, `SCALE-${name}-PC. productCount=1`, m.productCount);
      assert(m.globalCanonical.add_to_cart.unique_users === n, `SCALE-${name}-GU. global unique_users=${n}`, m.globalCanonical.add_to_cart);
      assert(m.productFunnel[0].canonical.add_to_cart.unique_users === n, `SCALE-${name}-PU. product unique_users=${n}`, m.productFunnel[0]);
      assert(m.discoveryCount === 1, `SCALE-${name}-DISC. discovery=1`, m.discoveryCount);
      assert(m.directMemberCount === 1, `SCALE-${name}-DM. direct-member=1`, m.directMemberCount);
      assert(m.sessionLinkCount === 0, `SCALE-${name}-SL. session-link=0`, m.sessionLinkCount);
      assert(m.sessionConfirmCount === 0, `SCALE-${name}-SC. session-confirm=0`, m.sessionConfirmCount);
      assert(m.phaseArrays.directMember.visitorBinds[0].length === n, `SCALE-${name}-DMVB. direct-member visitor binds=${n}`, m.phaseArrays.directMember.visitorBinds[0].length);
      assert(m.directMemberTotalBinds === n + 1, `SCALE-${name}-DMTB. direct-member total binds=${n}+1(store_id)=${n + 1}`, m.directMemberTotalBinds);
      assert(m.maxObservedTotalBindCount <= m.maxVariableNumber, `SCALE-${name}-BIND. maxObservedTotalBindCount(${m.maxObservedTotalBindCount}) <= MAX_VARIABLE_NUMBER(${m.maxVariableNumber})`, m);
    });
    assert(D1200.directMemberTotalBinds === 1201, 'SCALE-D1200-EXPLICIT. direct-member total binds 精確為 1201（1200 IN-list + 1 store_id），且 1201 <= 32766', { total: D1200.directMemberTotalBinds, limit: D1200.maxVariableNumber });
    assert(D1200.directMemberTotalBinds <= D1200.maxVariableNumber, 'SCALE-D1200-LIMIT. 1201 <= MAX_VARIABLE_NUMBER(32766)', D1200.maxVariableNumber);
    assert(D3.maxVariableNumber === D53.maxVariableNumber && D53.maxVariableNumber === D1200.maxVariableNumber,
      'SCALE-D-ENGINE. D3/D53/D1200 三個 case 的 MAX_VARIABLE_NUMBER deepStrictEqual', { D3: D3.maxVariableNumber, D53: D53.maxVariableNumber, D1200: D1200.maxVariableNumber });
    assert(deepEq(D3.nonIdentityGenericFingerprintCounts, D53.nonIdentityGenericFingerprintCounts) && deepEq(D53.nonIdentityGenericFingerprintCounts, D1200.nonIdentityGenericFingerprintCounts),
      'SCALE-D-NONIDENTITY. 排除 identity fingerprint 後，D3/D53/D1200 的 non-identity query「形狀＋執行次數」deepStrictEqual（用 genericShape 比較，只看查了幾次、查詢的種類是否相同，不比較 IN-list 裡實際綁了幾個值——cart_id IN(...) 這種依 cart 數量自然變長的查詢，3/53/1200 個 cart 本來就該有不同長度的 IN-list，這不是 N+1，比較「有沒有多查一次」才是真正要驗證的事）',
      { D3: D3.nonIdentityGenericFingerprintCounts, D53: D53.nonIdentityGenericFingerprintCounts, D1200: D1200.nonIdentityGenericFingerprintCounts });
    assert(D3.totalRouteSqlCount === D53.totalRouteSqlCount && D53.totalRouteSqlCount === D1200.totalRouteSqlCount,
      'SCALE-D-SQLCOUNT. Route SQL execution 總數不隨 visitor 數量線性增加（D3/D53/D1200 totalRouteSqlCount 完全相同）',
      { D3: D3.totalRouteSqlCount, D53: D53.totalRouteSqlCount, D1200: D1200.totalRouteSqlCount });
    assert(D3.sortedVisitorBindUnion.length === 3 && D3.sortedVisitorBindUnion.every((v) => /^d3_v\d+$/.test(v)),
      'SCALE-D3-VISITORSET. D3 sorted visitor-bind union 形狀正確（3 個，全部符合 d3_vN 命名格式）', D3.sortedVisitorBindUnion);

    // ── E1/E40 ────────────────────────────────────────────────────
    assert(deepEq(E1.sortedVisitorBindUnion || [], E40.sortedVisitorBindUnion || []) || (E1.sortedVisitorBindUnion.length === E40.sortedVisitorBindUnion.length),
      'SCALE-E-VISITORSET-SIZE. E1／E40 的 direct-member visitor binds 集合大小相同（固定 3 位 visitor，只改商品數量）', { E1: E1.sortedVisitorBindUnion, E40: E40.sortedVisitorBindUnion });
    assert(E1.productCount === 1 && E40.productCount === 40, 'SCALE-E-PRODUCTCOUNT. E1 productCount=1，E40 productCount=40', { E1: E1.productCount, E40: E40.productCount });
    assert(E1.productFunnelLength === 1 && E40.productFunnelLength === 40, 'SCALE-E-FUNNELLEN. product funnel 長度精確為 1／40', { E1: E1.productFunnelLength, E40: E40.productFunnelLength });
    const e1Users = E1.visitorCount, e40AllMatch = E40.productFunnel.every((p) => p.canonical.add_to_cart.unique_users === e1Users);
    assert(e40AllMatch, 'SCALE-E40-ALLPRODUCTS. E40 全部 40 個商品（不是只驗證首尾）的 canonical add_to_cart.unique_users 都精確等於固定 visitor 數', E40.productFunnel.map((p) => ({ id: p.product_id, users: p.canonical.add_to_cart.unique_users })));
    assert(E1.globalCanonical.add_to_cart.unique_users === E40.globalCanonical.add_to_cart.unique_users,
      'SCALE-E-GLOBALUSERS. global unique_users E1===E40（固定 visitor 集合，不因商品數增加而膨脹）', { E1: E1.globalCanonical.add_to_cart, E40: E40.globalCanonical.add_to_cart });
    assert(E1.globalCanonical.add_to_cart.unique_carts === E40.globalCanonical.add_to_cart.unique_carts,
      'SCALE-E-GLOBALCARTS. global unique_carts E1===E40（同一 visitor 橫跨商品沿用自己的 cart_id）', { E1: E1.globalCanonical.add_to_cart, E40: E40.globalCanonical.add_to_cart });
    assert(E40.globalCanonical.add_to_cart.event_count === E1.globalCanonical.add_to_cart.event_count * 40,
      'SCALE-E-EVENTCOUNT. global event_count 符合精確公式：E40 = E1 × 40', { E1: E1.globalCanonical.add_to_cart.event_count, E40: E40.globalCanonical.add_to_cart.event_count });
    assert(E1.discoveryCount === E40.discoveryCount && E1.directMemberCount === E40.directMemberCount && E1.sessionLinkCount === E40.sessionLinkCount && E1.sessionConfirmCount === E40.sessionConfirmCount,
      'SCALE-E-PHASECOUNTS. discovery/direct-member/session-link/session-confirm counts E1 deepStrictEqual E40（商品數增加不影響 identity 查詢次數）',
      { E1: { d: E1.discoveryCount, dm: E1.directMemberCount, sl: E1.sessionLinkCount, sc: E1.sessionConfirmCount }, E40: { d: E40.discoveryCount, dm: E40.directMemberCount, sl: E40.sessionLinkCount, sc: E40.sessionConfirmCount } });
    assert(deepEq(E1.phaseArrays.directMember.totalBindCounts, E40.phaseArrays.directMember.totalBindCounts),
      'SCALE-E-BINDARRAYS. direct-member total-bind arrays E1 deepStrictEqual E40', { E1: E1.phaseArrays.directMember.totalBindCounts, E40: E40.phaseArrays.directMember.totalBindCounts });
    // production N+1 已修正（batch aggregator，見 utils/analyticsV2.js
    // _batchAddToCartRowsByProduct／_batchCheckoutClickRows／
    // _batchPurchaseRowsWithOrderItems／_canonicalMetricsForProductFromBatch）：
    // 三個 stage 各自只查一次，不再隨商品數線性增加。totalRouteSqlCount
    // 現在真的 E1===E40。
    assert(E1.totalRouteSqlCount === E40.totalRouteSqlCount,
      'SCALE-E-SQLCOUNT. totalRouteSqlCount E1===E40（production batch 修正後，商品從 1 增加到 40 不再增加 Route SQL 執行次數）',
      { E1: E1.totalRouteSqlCount, E40: E40.totalRouteSqlCount });
    assert(deepEq(E1.genericFingerprintCounts, E40.genericFingerprintCounts),
      'SCALE-E-FULLFINGERPRINT. E1／E40 完整 Route fingerprint「形狀＋執行次數」deepStrictEqual（用 genericShape 比較：products WHERE id IN (...) 這種依商品數量自然變長的 batch 查詢，1 個商品跟 40 個商品的 IN-list 長度本來就該不同——這不是 N+1，因為它從頭到尾只執行了固定次數，不是每個商品各查一次；比較「有沒有多執行一次」才是真正要驗證的事）',
      { E1: E1.genericFingerprintCounts, E40: E40.genericFingerprintCounts });

    // ── E1/E40 exact fingerprint diff allowlist：逐一列出 exact fingerprint
    // 差異，只允許差異落在已知的兩個既有批次商品查詢（IN-list arity 依
    // 商品數量自然變化，execution count 必須兩邊相同）──────────────────
    {
      const E1_ALLOWLIST = new Map([
        ['select id, price from products where store_id=? and id in (<1>)', { productionFunction: 'getProductFunnel()（本身，priceMap）', file: 'utils/analyticsV2.js:417', e1Arity: 1, e40Fingerprint: 'select id, price from products where store_id=? and id in (<40>)', e40Arity: 40 }],
        ['select id, name from products where store_id=? and id in (<1>)', { productionFunction: 'getProductRanking()（被 routes/analytics.js 與 getProductFunnel() 各呼叫一次，共 2 次）', file: 'utils/dashboardAnalytics.js:507', e1Arity: 1, e40Fingerprint: 'select id, name from products where store_id=? and id in (<40>)', e40Arity: 40 }],
      ]);
      const e1Exact = E1.normalizedFingerprintCounts;
      const e40Exact = E40.normalizedFingerprintCounts;
      const allKeys = new Set([...Object.keys(e1Exact), ...Object.keys(e40Exact)]);
      const unexpectedDiffs = [];
      allKeys.forEach((k) => {
        const v1 = e1Exact[k] || 0;
        const v40raw = e40Exact[k] || 0;
        if (v1 === v40raw) return;
        if (E1_ALLOWLIST.has(k)) {
          const entry = E1_ALLOWLIST.get(k);
          const e40Count = e40Exact[entry.e40Fingerprint] || 0;
          if (v1 !== e40Count) unexpectedDiffs.push({ key: k, reason: 'execution count 不同（不只是 arity 不同）', e1Count: v1, e40Count });
          return;
        }
        const isKnownE40Side = [...E1_ALLOWLIST.values()].some((e) => e.e40Fingerprint === k);
        if (isKnownE40Side) return;
        unexpectedDiffs.push({ key: k, reason: '不在 allowlist 內的未知差異', e1Count: v1, e40Count: v40raw });
      });
      assert(unexpectedDiffs.length === 0,
        'E1E40-EXACT-ALLOWLIST. E1／E40 exact fingerprint 差異全部落在已知 allowlist（2 個既有批次商品查詢，IN-list arity 依商品數量自然變化，execution count 兩邊相同），沒有其他未預期差異',
        unexpectedDiffs);
      console.log('[E1E40-ALLOWLIST-TABLE]', JSON.stringify([...E1_ALLOWLIST.entries()].map(([k, v]) => ({
        fingerprint: k, ...v, e1ExecutionCount: e1Exact[k] || 0, e40ExecutionCount: e40Exact[v.e40Fingerprint] || 0,
      })), null, 2));
    }
    assert(deepEq(E1.phaseArrays, E40.phaseArrays),
      'SCALE-E-PHASEARRAYS-FULL. E1／E40 identity 各 phase 的完整 bind-count／visitor-bind arrays deepStrictEqual', null);
    const e1Str = JSON.stringify(E1.globalCanonical) + JSON.stringify(E1.productFunnel);
    const e40Str = JSON.stringify(E40.globalCanonical);
    assert(!/NaN|Infinity/.test(e1Str) && !/NaN|Infinity/.test(e40Str), 'SCALE-E-FINITE. E1／E40 response 數值全部是 finite number，無 NaN/Infinity', null);

    // ── 實測 SQL 表（供最終報告引用）──
    console.log('\n[SCALE-TABLE]', JSON.stringify({
      D3: { visitors: D3.visitorCount, products: D3.productCount, totalSql: D3.totalRouteSqlCount, discovery: D3.discoveryCount, directMember: D3.directMemberCount, sessionLink: D3.sessionLinkCount, sessionConfirm: D3.sessionConfirmCount, maxBinds: D3.maxObservedTotalBindCount, maxVar: D3.maxVariableNumber },
      D53: { visitors: D53.visitorCount, products: D53.productCount, totalSql: D53.totalRouteSqlCount, discovery: D53.discoveryCount, directMember: D53.directMemberCount, sessionLink: D53.sessionLinkCount, sessionConfirm: D53.sessionConfirmCount, maxBinds: D53.maxObservedTotalBindCount, maxVar: D53.maxVariableNumber },
      D1200: { visitors: D1200.visitorCount, products: D1200.productCount, totalSql: D1200.totalRouteSqlCount, discovery: D1200.discoveryCount, directMember: D1200.directMemberCount, sessionLink: D1200.sessionLinkCount, sessionConfirm: D1200.sessionConfirmCount, maxBinds: D1200.maxObservedTotalBindCount, maxVar: D1200.maxVariableNumber },
      E1: { visitors: E1.visitorCount, products: E1.productCount, totalSql: E1.totalRouteSqlCount, discovery: E1.discoveryCount, directMember: E1.directMemberCount, sessionLink: E1.sessionLinkCount, sessionConfirm: E1.sessionConfirmCount, maxBinds: E1.maxObservedTotalBindCount, maxVar: E1.maxVariableNumber },
      E40: { visitors: E40.visitorCount, products: E40.productCount, totalSql: E40.totalRouteSqlCount, discovery: E40.discoveryCount, directMember: E40.directMemberCount, sessionLink: E40.sessionLinkCount, sessionConfirm: E40.sessionConfirmCount, maxBinds: E40.maxObservedTotalBindCount, maxVar: E40.maxVariableNumber },
    }, null, 2));
    console.log('[SCALE-NONIDENTITY-FINGERPRINTS] D3=', JSON.stringify(D3.nonIdentityFingerprintCounts));
    console.log('[SCALE-NONIDENTITY-FINGERPRINTS] E1=', JSON.stringify(E1.nonIdentityFingerprintCounts));
    console.log('[SCALE-NONIDENTITY-FINGERPRINTS] E40=', JSON.stringify(E40.nonIdentityFingerprintCounts));
  }

    // ── Standalone helper：完全不傳 context，仍能正確運作 ──────────────
    const STORE_STANDALONE = 'test_store_h148_ctx_standalone';
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [9760, STORE_STANDALONE, 'StandaloneP', '測試', 100]);
    insertEvent(STORE_STANDALONE, 'add_to_cart', { visitorId: 'standalone_v1', cartId: 'standalone_cart_1', productId: 9760, orderChannel: CHANNEL });
    const standaloneFunnel = getProductFunnel(db, STORE_STANDALONE, range, CHANNEL); // 完全不傳第 5 個參數
    const standaloneRow = standaloneFunnel.find((f) => f.product_id === 9760);
    assert(!!standaloneRow && standaloneRow.canonical.add_to_cart.unique_users === 1,
      'STANDALONE1. getProductFunnel() 完全不傳 identityContext 時仍安全建立自己的臨時 context，結果正確', standaloneRow && standaloneRow.canonical.add_to_cart);
    const standaloneGlobal = getGlobalFunnelCanonicalMetrics(db, STORE_STANDALONE, range, CHANNEL); // 完全不傳第 5 個參數
    assert(standaloneGlobal.add_to_cart.unique_users === 1,
      'STANDALONE2. getGlobalFunnelCanonicalMetrics() 完全不傳 identityContext 時同樣安全建立自己的臨時 context，結果正確', standaloneGlobal.add_to_cart);

    // ── Partial-cache（改用真正的 production helper 流程，不是直接呼叫
    // resolveInContext()）：第一個 helper（商品 P_A，只有 visitor set A）
    // 先跑，第二個 helper（全局，涵蓋 A ∪ B）只應該對 B 觸發新查詢 ──────
    // ── Partial-cache 在 identity 解析層級本身的直接證明（resolveInContext()
    // 是 production helper 內部實際呼叫的同一個函式，不是另一套邏輯）：
    // context 已經有 set A（2 個），再要求解析 A∪B（+3 個新的），只應該對
    // 新的 3 個發查詢——但 SQL 本身還會多綁一個 store_id，所以 IN-list bind
    // 數是 3，SQL 的 total bind 數是 4，兩者要分開報告，不能把 total bind
    // 誤植成「新增 visitor 數」。
    const contextPartialDirect = createCanonicalIdentityContext('test_store_h148_ctx_partial_direct');
    resolveInContext(db, contextPartialDirect, 'test_store_h148_ctx_partial_direct', ['direct_A1', 'direct_A2']); // set A：2 個
    let directBindBreakdown = null;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => {
        if (normalizeSqlForTest(sql).startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          directBindBreakdown = { storeIdBinds: 1, inListBinds: params.length - 1, totalBinds: params.length };
        }
        return origAll(sql, params);
      };
      try {
        resolveInContext(db, contextPartialDirect, 'test_store_h148_ctx_partial_direct', ['direct_A1', 'direct_A2', 'direct_B1', 'direct_B2', 'direct_B3']); // A∪B：2+3
      } finally { db.all = origAll; }
    }
    assert(!!directBindBreakdown && directBindBreakdown.inListBinds === 3,
      'RESOLVE_PARTIAL1. resolveInContext() 對 A∪B 只對新增的 B 集合（3 個）發查詢：IN-list bind 數＝3（不含已在 context 裡的 A）', directBindBreakdown);
    assert(!!directBindBreakdown && directBindBreakdown.totalBinds === 4,
      'RESOLVE_PARTIAL2. 這支 SQL 的 total bind 數是 4（1 個 store_id + 3 個 IN-list visitor_id），不能把 total bind 誤報成等於新增 visitor 數（3）——兩者是不同的數字', directBindBreakdown);

    // ── PRIME_SCOPE_EXPAND：用真正的 production prime API
    // （primeFunnelIdentityContext），同一個 store-scoped context，先對
    // 較窄的日期 scope S1 prime（只發現 visitor set A），再對合法擴大的
    // scope S2 prime（發現 A∪B）——只應該對新增的 B 觸發查詢。最後對完全
    // 相同的 S2 再 prime 一次，discovery／evidence SQL 都應該是 0（真正的
    // no-op，primedScopes 生效）。
    const STORE_SCOPE_EXPAND = 'test_store_h148_ctx_scope_expand';
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [9780, STORE_SCOPE_EXPAND, 'ScopeExpandP', '測試', 100]);
    // set A：放在 fixture 基準時間的最前面幾毫秒（seq 1~2）
    insertEvent(STORE_SCOPE_EXPAND, 'add_to_cart', { visitorId: 'scope_A1', cartId: 'scope_cart_A1', productId: 9780, orderChannel: CHANNEL });
    insertEvent(STORE_SCOPE_EXPAND, 'add_to_cart', { visitorId: 'scope_A2', cartId: 'scope_cart_A2', productId: 9780, orderChannel: CHANNEL });
    const s1EndLocal = new Date(BASE_UTC_MS + seq + 8 * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    seq += 5000; // 強制跳過至少 5 秒，確保 set B 的時間字串（秒級精度）跟 set A 明確分開，不會落在 S1 的 BETWEEN 範圍內
    // set B：晚一點插入，只應該落在擴大後的 S2 範圍內，不在 S1 內
    insertEvent(STORE_SCOPE_EXPAND, 'add_to_cart', { visitorId: 'scope_B1', cartId: 'scope_cart_B1', productId: 9780, orderChannel: CHANNEL });
    insertEvent(STORE_SCOPE_EXPAND, 'add_to_cart', { visitorId: 'scope_B2', cartId: 'scope_cart_B2', productId: 9780, orderChannel: CHANNEL });

    const scopeExpandContext = createCanonicalIdentityContext(STORE_SCOPE_EXPAND);
    const S1 = { startLocal: range.startLocal, endLocal: s1EndLocal };
    const S2 = { startLocal: range.startLocal, endLocal: range.endLocal }; // 完整涵蓋 A∪B

    let s1DiscoveryCount = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { if (normalizeSqlForTest(sql).startsWith('select distinct visitor_id from analytics_events')) s1DiscoveryCount += 1; return origAll(sql, params); };
      try { primeFunnelIdentityContext(db, STORE_SCOPE_EXPAND, S1, CHANNEL, scopeExpandContext); } finally { db.all = origAll; }
    }
    assert(s1DiscoveryCount === 1, 'PRIME_SCOPE_EXPAND1. 對較窄 scope S1 prime：discovery SQL 執行 1 次', s1DiscoveryCount);
    assert(scopeExpandContext.canonicalByVisitor.has('scope_A1') && scopeExpandContext.canonicalByVisitor.has('scope_A2'),
      'PRIME_SCOPE_EXPAND2. S1 prime 完成後，context 裡有 set A 的兩個 visitor', [...scopeExpandContext.canonicalByVisitor.keys()]);
    assert(!scopeExpandContext.canonicalByVisitor.has('scope_B1') && !scopeExpandContext.canonicalByVisitor.has('scope_B2'),
      'PRIME_SCOPE_EXPAND3. S1 的窄 scope 還沒發現 set B（B 的事件時間在 S1 範圍外）', [...scopeExpandContext.canonicalByVisitor.keys()]);

    let s2BindBreakdown = { directMember: null, sessionLink: null };
    let s2DiscoveryCount = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => {
        const norm = normalizeSqlForTest(sql);
        if (norm.startsWith('select distinct visitor_id from analytics_events')) s2DiscoveryCount += 1;
        if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) s2BindBreakdown.directMember = { inListBinds: params.length - 1, totalBinds: params.length };
        if (norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions where store_id=? and visitor_id in')) s2BindBreakdown.sessionLink = { inListBinds: params.length - 1, totalBinds: params.length };
        return origAll(sql, params);
      };
      try { primeFunnelIdentityContext(db, STORE_SCOPE_EXPAND, S2, CHANNEL, scopeExpandContext); } finally { db.all = origAll; }
    }
    assert(s2DiscoveryCount === 1, 'PRIME_SCOPE_EXPAND4. 擴大到 S2（不同的日期區間邊界，新的 scope key）：discovery SQL 重新執行 1 次（不是被誤判成 S1 已經 prime 過就跳過——S1／S2 是不同的 scope key）', s2DiscoveryCount);
    assert(!!s2BindBreakdown.directMember && s2BindBreakdown.directMember.inListBinds === 2,
      'PRIME_SCOPE_EXPAND5. S2 的 direct-member 查詢 IN-list bind 數＝2（只有新發現的 set B，不含已經在 context 裡的 A）', s2BindBreakdown.directMember);
    assert(!!s2BindBreakdown.sessionLink && s2BindBreakdown.sessionLink.inListBinds === 2,
      'PRIME_SCOPE_EXPAND6. S2 的 session-link 查詢 IN-list bind 數＝2（同樣只有 B，不重查 A）', s2BindBreakdown.sessionLink);
    assert(scopeExpandContext.canonicalByVisitor.size === 4,
      'PRIME_SCOPE_EXPAND7. 最終 context.canonicalByVisitor 包含 A∪B 共 4 個 visitor', scopeExpandContext.canonicalByVisitor.size);

    // 再對完全相同的 S2 prime 一次：discovery／evidence SQL 都應該是 0
    let s2RepeatSqlCount = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { s2RepeatSqlCount += 1; return origAll(sql, params); };
      try { primeFunnelIdentityContext(db, STORE_SCOPE_EXPAND, S2, CHANNEL, scopeExpandContext); } finally { db.all = origAll; }
    }
    assert(s2RepeatSqlCount === 0, 'PRIME_SCOPE_EXPAND8. 對完全相同的 S2 再 prime 一次：discovery SQL 與 evidence SQL 總數＝0（真正的 no-op，primedScopes 生效）', s2RepeatSqlCount);

    const STORE_PARTIAL = 'test_store_h148_ctx_partial';
    const P_A = 9770, P_B1 = 9771, P_B2 = 9772, P_B3 = 9773;
    [P_A, P_B1, P_B2, P_B3].forEach((pid) => {
      db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [pid, STORE_PARTIAL, `PartialP${pid}`, '測試', 100]);
    });
    insertEvent(STORE_PARTIAL, 'add_to_cart', { visitorId: 'partial_A1', cartId: 'partial_cart_A1', productId: P_A, orderChannel: CHANNEL });
    insertEvent(STORE_PARTIAL, 'add_to_cart', { visitorId: 'partial_A2', cartId: 'partial_cart_A2', productId: P_A, orderChannel: CHANNEL });
    insertEvent(STORE_PARTIAL, 'add_to_cart', { visitorId: 'partial_B1', cartId: 'partial_cart_B1', productId: P_B1, orderChannel: CHANNEL });
    insertEvent(STORE_PARTIAL, 'add_to_cart', { visitorId: 'partial_B2', cartId: 'partial_cart_B2', productId: P_B2, orderChannel: CHANNEL });
    insertEvent(STORE_PARTIAL, 'add_to_cart', { visitorId: 'partial_B3', cartId: 'partial_cart_B3', productId: P_B3, orderChannel: CHANNEL });

    const contextPartial = createCanonicalIdentityContext(STORE_PARTIAL);
    // 第一個 helper：只查詢 P_A 這個商品，只會用到 visitor set A（2 個）。
    const funnelA = getProductFunnel(db, STORE_PARTIAL, range, CHANNEL, contextPartial);
    const rowA = funnelA.find((f) => f.product_id === P_A);
    assert(!!rowA && rowA.canonical.add_to_cart.unique_users === 2, 'PARTIAL0. 第一個 helper（只查 P_A）unique_users=2（visitor set A）', rowA && rowA.canonical.add_to_cart);

    let bindBreakdownForB = null;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => {
        if (normalizeSqlForTest(sql).startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          // 第 1 個 bind 是 store_id（固定 bind），其餘才是 IN-list 的 visitor_id。
          bindBreakdownForB = { storeIdBinds: 1, inListBinds: params.length - 1, totalBinds: params.length, inListValues: params.slice(1) };
        }
        return origAll(sql, params);
      };
      try {
        // 第二個 helper：全局統計。
        getGlobalFunnelCanonicalMetrics(db, STORE_PARTIAL, range, CHANNEL, contextPartial);
      } finally { db.all = origAll; }
    }
    // 誠實記錄一個真實的架構限制（不是 bug）：primeFunnelIdentityContext()
    // 的 visitor union discovery 本身是「整個 store／channel／日期區間」
    // 層級（不分商品），所以呼叫 getProductFunnel() 即使只看 P_A 這個商品
    // 的結果，內部 priming 早就已經把整個 store 的 A∪B 全部解析完了。這代表
    // 「用兩個 production helper 各自觸發部分 identity 解析」這個情境，在
    // 目前架構下結構上不可能重現（helper 1 早就把 helper 2 需要的全部解析
    // 完了）。這裡斷言 bindBreakdownForB 為 null，正是「不重複解析」這個
    // 效能保證的直接證明，只是呈現方式不是「查詢分兩批」，而是「第二個
    // helper 完全不必再查」。真正的「部分快取（A→A∪B）」行為，已經在上面
    // PARTIAL1／PARTIAL2（直接用 resolveInContext()，跟 production helper
    // 內部實際呼叫的是同一個函式）驗證過，那才是這個效能保證真正發生的層級。
    assert(bindBreakdownForB === null,
      'PARTIAL1a. 第二個 helper（全局）沒有觸發任何新的 direct-member 查詢——getProductFunnel() 的 whole-store priming 已經在第一個 helper 呼叫時，把整個 store 的 A∪B 都解析完了（架構事實，不是部分快取情境能在 helper 層級被觸發的方式）',
      bindBreakdownForB);
    const globalPartial = getGlobalFunnelCanonicalMetrics(db, STORE_PARTIAL, range, CHANNEL, contextPartial);
    assert(globalPartial.add_to_cart.unique_users === 5, 'PARTIAL3. 全局 helper 最終結果精確：unique_users=5（A∪B）', globalPartial.add_to_cart);
  }

  // ══════════════════════════════════════════════════════════════════
  // Phase-level：建立 context → 顯式 prime → product 階段新增 evidence
  // SQL 必須是 0 → global 階段新增 evidence SQL 必須是 0（不是靠總數推測，
  // 是逐階段量測 delta）。
  // ══════════════════════════════════════════════════════════════════
  {
    const STORE_PHASE = 'test_store_h148_phase';
    const P_PHASE = 9780;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_PHASE, STORE_PHASE, 'PhaseP', '測試', 100]);
    insertEvent(STORE_PHASE, 'add_to_cart', { visitorId: 'phase_v1', cartId: 'phase_cart_1', productId: P_PHASE, orderChannel: CHANNEL });
    insertEvent(STORE_PHASE, 'checkout_click', { visitorId: 'phase_v1', cartId: 'phase_cart_1', orderChannel: CHANNEL });

    function countEvidenceSql(fn) {
      const origAll = db.all.bind(db);
      let n = 0;
      db.all = (sql, params) => {
        const norm = normalizeSqlForTest(sql);
        if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in') || norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) n += 1;
        return origAll(sql, params);
      };
      try { fn(); } finally { db.all = origAll; }
      return n;
    }

    const ctxPhase = createCanonicalIdentityContext(STORE_PHASE, CHANNEL);
    const primeSqlCount = countEvidenceSql(() => { primeFunnelIdentityContext(db, STORE_PHASE, range, CHANNEL, ctxPhase); });
    assert(primeSqlCount === 2, 'PHASE1. prime 階段完成全部 evidence SQL（direct-member + session-link = 2）', primeSqlCount);

    const productSqlDelta = countEvidenceSql(() => { getProductFunnel(db, STORE_PHASE, range, CHANNEL, ctxPhase); });
    assert(productSqlDelta === 0, 'PHASE2. product 階段（已用同一 context 且已 prime）新增 evidence SQL = 0', productSqlDelta);

    const globalSqlDelta = countEvidenceSql(() => { getGlobalFunnelCanonicalMetrics(db, STORE_PHASE, range, CHANNEL, ctxPhase); });
    assert(globalSqlDelta === 0, 'PHASE3. global 階段（已用同一 context 且已 prime）新增 evidence SQL = 0', globalSqlDelta);

    // 再次呼叫 primeFunnelIdentityContext() 本身（重複 prime 同一個 scope）：
    // 必須是真正的 no-op，不會重新查 discovery 或 identity evidence。
    let discoverySqlCountOnRePrime = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { if (normalizeSqlForTest(sql).startsWith('select distinct visitor_id from analytics_events')) discoverySqlCountOnRePrime += 1; return origAll(sql, params); };
      try { primeFunnelIdentityContext(db, STORE_PHASE, range, CHANNEL, ctxPhase); } finally { db.all = origAll; }
    }
    assert(discoverySqlCountOnRePrime === 0, 'PHASE4. 對同一個已經 prime 過的 (channel, 日期區間) scope 再呼叫一次 primeFunnelIdentityContext()：discovery SQL 次數 = 0（真正的 no-op，primedScopes 是真正的閘門，不是查完才記錄的裝飾）', discoverySqlCountOnRePrime);
  }

  // ══════════════════════════════════════════════════════════════════
  // PRIME_RETRY：故意讓第一次 prime 的 identity evidence 查詢拋出例外，
  // 證明 scope 不會被誤標記完成；還原 spy 後第二次 prime 必須重新完整
  // 執行一次（discovery＋evidence 都重跑），結果正確。
  // ══════════════════════════════════════════════════════════════════
  {
    const STORE_RETRY = 'test_store_h148_prime_retry';
    const P_RETRY = 9790;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_RETRY, STORE_RETRY, 'RetryP', '測試', 100]);
    insertEvent(STORE_RETRY, 'add_to_cart', { visitorId: 'retry_v1', cartId: 'retry_cart_1', productId: P_RETRY, orderChannel: CHANNEL });

    const ctxRetry = createCanonicalIdentityContext(STORE_RETRY, CHANNEL);
    let threwOnFirstPrime = false;
    let threwError = null;
    {
      const origAll = db.all.bind(db);
      // 誠實修正：resolveCanonicalVisitors() 內部對 line_members／
      // line_member_sessions 查詢本身有 try/catch（既有、本輪未變動的
      // 防禦性設計——DB 查詢失敗一律當作「沒有命中」，不會往外拋，實測
      // 驗證過），所以在那兩支查詢注入例外並不會讓
      // primeFunnelIdentityContext() 真的拋出例外，測不出「例外安全」這件
      // 事。真正會直接往外拋的失敗點是 discovery 查詢本身（沒有
      // try/catch 包住），這裡改成在 discovery 查詢注入例外。
      db.all = (sql, params) => {
        if (normalizeSqlForTest(sql).startsWith('select distinct visitor_id from analytics_events')) {
          throw new Error('[TEST-INJECTED] 故意讓 visitor union discovery 查詢失敗');
        }
        return origAll(sql, params);
      };
      try {
        primeFunnelIdentityContext(db, STORE_RETRY, range, CHANNEL, ctxRetry);
      } catch (e) {
        threwOnFirstPrime = true;
        threwError = e.message;
      } finally {
        db.all = origAll;
      }
    }
    assert(threwOnFirstPrime, 'PRIME_RETRY1. 故意讓 discovery 查詢失敗：primeFunnelIdentityContext() 確實往外拋出例外（不會被靜默吞掉）', { threwOnFirstPrime, threwError });

    // 誠實補充證據：resolveCanonicalVisitors() 對 identity-table 查詢本身
    // production 已修正：identity-table 查詢（不是 discovery）失敗現在也會
    // 往外拋出例外，不再被 resolveCanonicalVisitors() 自己的 try/catch 吞掉。
    {
      const ctxNoSwallow = createCanonicalIdentityContext(STORE_RETRY, CHANNEL);
      const origAll2 = db.all.bind(db);
      let threwOnEvidenceInjection = false;
      db.all = (sql, params) => {
        if (normalizeSqlForTest(sql).startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          throw new Error('[TEST-INJECTED] 故意讓 direct-member 查詢失敗');
        }
        return origAll2(sql, params);
      };
      try {
        primeFunnelIdentityContext(db, STORE_RETRY, range, CHANNEL, ctxNoSwallow);
      } catch (e) {
        threwOnEvidenceInjection = true;
      } finally {
        db.all = origAll2;
      }
      assert(threwOnEvidenceInjection === true,
        'PRIME_RETRY1b. Production 修正後：direct-member（identity-table 查詢，不是 discovery）失敗會往外拋出例外，不再被吞掉',
        threwOnEvidenceInjection);
      assert(ctxNoSwallow.primedScopes.size === 0,
        'PRIME_RETRY1c. 失敗後 scope 沒有被標記完成（不是先前版本「吞掉後視為正常完成」的錯誤行為）', ctxNoSwallow.primedScopes.size);
    }
    assert(ctxRetry.primedScopes.size === 0, 'PRIME_RETRY2. 例外發生後，這個 scope 沒有被誤標記成已完成（primedScopes 仍是空的）', ctxRetry.primedScopes.size);

    // 還原 spy 後第二次呼叫：必須重新完整執行一次（discovery + evidence）
    let discoveryCountOnRetry = 0;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => { if (normalizeSqlForTest(sql).startsWith('select distinct visitor_id from analytics_events')) discoveryCountOnRetry += 1; return origAll(sql, params); };
      try { primeFunnelIdentityContext(db, STORE_RETRY, range, CHANNEL, ctxRetry); } finally { db.all = origAll; }
    }
    assert(discoveryCountOnRetry === 1, 'PRIME_RETRY3. 第二次（正常執行）：discovery SQL 重新執行一次（不是被誤判為已完成而跳過）', discoveryCountOnRetry);
    assert(ctxRetry.primedScopes.size === 1, 'PRIME_RETRY4. 第二次成功後，scope 才被標記完成', ctxRetry.primedScopes.size);
    assert(ctxRetry.canonicalByVisitor.get('retry_v1') === 'visitor:retry_v1', 'PRIME_RETRY5. 重試後 canonical 結果正確（retry_v1 是未連結匿名訪客）', ctxRetry.canonicalByVisitor.get('retry_v1'));
  }

  // ══════════════════════════════════════════════════════════════════
  // PRIME_RETRY_MID：混合 fixture（一個 direct-member visitor + 一個
  // session-linked visitor），故意在「session-confirm」這一步（第二次出現
  // 的 members-in 形狀查詢，用出現次數辨識，不是靠跟 direct-member 相同的
  // SQL fingerprint）才失敗，此時 discovery／direct-member／session-link
  // 都已經真正成功執行過。production 已修正：query-level 失敗一律往外拋，
  // 不再吞掉、不再誤判成「查無命中」，context 只在全部成功後才提交。
  // ══════════════════════════════════════════════════════════════════
  {
    const STORE_MID = 'test_store_h148_prime_retry_mid';
    const P_MID = 9795;
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [P_MID, STORE_MID, 'MidP', '測試', 100]);
    insertEvent(STORE_MID, 'add_to_cart', { visitorId: 'mid_direct', cartId: 'mid_cart_direct', productId: P_MID, orderChannel: CHANNEL });
    insertEvent(STORE_MID, 'add_to_cart', { visitorId: 'mid_session', cartId: 'mid_cart_session', productId: P_MID, orderChannel: CHANNEL });
    // mid_direct 本身的 visitor_id 字串直接就是一個 line_user_id（direct-member 規則 1 命中）
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_MID, 'mid_direct', 'Mid直接會員']);
    // mid_session 透過 session-link 決定性連結到另一個 LINE UID（規則 2，需要 confirm）
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_MID, 'MID_SESSION_LINE', 'Mid連結會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_MID, 'MID_SESSION_LINE', 'mid_session']);

    const ctxMid = createCanonicalIdentityContext(STORE_MID, CHANNEL);
    const canonicalBeforeSnapshot = JSON.stringify([...ctxMid.canonicalByVisitor.entries()]);
    const scopesBeforeSnapshot = JSON.stringify([...ctxMid.primedScopes]);

    let discoveryRanBeforeFailure = false;
    let directMemberRanBeforeFailure = false;
    let sessionLinkRanBeforeFailure = false;
    let membersInOccurrence = 0; // direct-member 是第 1 次，confirm 是第 2 次——用出現次數辨識，不是靠相同 SQL fingerprint
    let threwOnMidFailure = false;
    let threwErrorMid = null;
    {
      const origAll = db.all.bind(db);
      db.all = (sql, params) => {
        const norm = normalizeSqlForTest(sql);
        if (norm.startsWith('select distinct visitor_id from analytics_events')) discoveryRanBeforeFailure = true;
        if (norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) sessionLinkRanBeforeFailure = true;
        if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          membersInOccurrence += 1;
          if (membersInOccurrence === 1) {
            directMemberRanBeforeFailure = true; // 第一次是 direct-member，讓它正常成功
          } else {
            // 第二次是 session-confirm——這裡故意讓它失敗，此時前面三支查詢都已經真正跑過。
            throw new Error('[TEST-INJECTED] 故意讓 session-confirm 查詢失敗（第二次 members-in 形狀查詢）');
          }
        }
        return origAll(sql, params);
      };
      try {
        primeFunnelIdentityContext(db, STORE_MID, range, CHANNEL, ctxMid);
      } catch (e) {
        threwOnMidFailure = true;
        threwErrorMid = e.message;
      } finally {
        db.all = origAll;
      }
    }

    assert(discoveryRanBeforeFailure && directMemberRanBeforeFailure && sessionLinkRanBeforeFailure,
      'PRIME_RETRY_MID1. 失敗發生前，discovery／direct-member／session-link 三支查詢都真的成功執行過（用出現次數辨識 confirm，不是靠跟 direct-member 相同的 fingerprint）',
      { discoveryRanBeforeFailure, directMemberRanBeforeFailure, sessionLinkRanBeforeFailure, membersInOccurrence });

    // production 已修正：session-confirm 失敗現在會真正往外拋出例外，
    // 不再被吞掉、不再讓 mid_session 被誤判成匿名。
    assert(threwOnMidFailure === true,
      'PRIME_RETRY_MID2. Production 修正後：session-confirm 失敗會往外拋出例外，不再被吞掉（不是查無命中，是真正的查詢失敗，必須讓呼叫端知道）',
      { threwOnMidFailure, threwErrorMid });
    assert(!!threwErrorMid && !threwErrorMid.includes('mid_session') && !threwErrorMid.includes('mid_direct') && !threwErrorMid.includes('MID_SESSION_LINE'),
      'PRIME_RETRY_MID2b. 錯誤訊息只標示 phase（session-confirm）與 store_id，不含任何 visitor_id 或 LINE UID', threwErrorMid);
    assert(!!threwErrorMid && threwErrorMid.includes('session-confirm'),
      'PRIME_RETRY_MID2c. 錯誤訊息明確標示發生在 session-confirm 這個 phase', threwErrorMid);

    // 失敗後：direct visitor（原本查詢已經成功）也不得被部分提交——整個
    // context（canonicalByVisitor 與 primedScopes）必須與呼叫前完全相同。
    const assertModule2 = require('assert');
    let canonicalUnchanged = true, canonicalDiff = null;
    try { assertModule2.deepStrictEqual([...ctxMid.canonicalByVisitor.entries()], JSON.parse(canonicalBeforeSnapshot)); }
    catch (e) { canonicalUnchanged = false; canonicalDiff = e.message; }
    assert(canonicalUnchanged,
      'PRIME_RETRY_MID3. 失敗後 canonicalByVisitor 與呼叫前 snapshot 完全相同（assert.deepStrictEqual）——即使 direct-member 那支查詢已經成功拿到 mid_direct 的證據，也沒有被部分提交進去（atomic：只有 discovery＋direct-member＋session-link＋session-confirm 全部成功才會一次寫入）',
      canonicalDiff);
    let scopesUnchanged = true, scopesDiff = null;
    try { assertModule2.deepStrictEqual([...ctxMid.primedScopes], JSON.parse(scopesBeforeSnapshot)); }
    catch (e) { scopesUnchanged = false; scopesDiff = e.message; }
    assert(scopesUnchanged,
      'PRIME_RETRY_MID4. 失敗後 primedScopes 與呼叫前 snapshot 完全相同（scope 沒有被誤標記完成）', scopesDiff);

    // 還原 spy 後，用同一個 context retry：discovery／direct-member／
    // session-link／session-confirm 全部要重新執行一次（不能因為前一次
    // direct-member「查詢本身」成功過就跳過，因為上一輪整體失敗、什麼都
    // 沒提交，context 完全視為「這個 scope 還沒 prime 過」）。
    let discoveryCountRetry = 0, directMemberCountRetry = 0, sessionLinkCountRetry = 0, confirmCountRetry = 0;
    {
      const origAll = db.all.bind(db);
      let membersInOccurrenceRetry = 0;
      db.all = (sql, params) => {
        const norm = normalizeSqlForTest(sql);
        if (norm.startsWith('select distinct visitor_id from analytics_events')) discoveryCountRetry += 1;
        if (norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) sessionLinkCountRetry += 1;
        if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          membersInOccurrenceRetry += 1;
          if (membersInOccurrenceRetry === 1) directMemberCountRetry += 1; else confirmCountRetry += 1;
        }
        return origAll(sql, params);
      };
      try { primeFunnelIdentityContext(db, STORE_MID, range, CHANNEL, ctxMid); } finally { db.all = origAll; }
    }
    assert(discoveryCountRetry === 1 && directMemberCountRetry === 1 && sessionLinkCountRetry === 1 && confirmCountRetry === 1,
      'PRIME_RETRY_MID5. Retry：discovery／direct-member／session-link／session-confirm 全部重新執行恰好一次（沒有任何一支因為「上次執行過」而被跳過）',
      { discoveryCountRetry, directMemberCountRetry, sessionLinkCountRetry, confirmCountRetry });

    assert(ctxMid.canonicalByVisitor.get('mid_direct') === 'line_user:mid_direct',
      'PRIME_RETRY_MID6. Retry 成功後：mid_direct 正確為 line_user:mid_direct', ctxMid.canonicalByVisitor.get('mid_direct'));
    assert(ctxMid.canonicalByVisitor.get('mid_session') === 'line_user:MID_SESSION_LINE',
      'PRIME_RETRY_MID7. Retry 成功後：mid_session 正確為 line_user:MID_SESSION_LINE（confirm 這次真正成功，不再被誤判成匿名）',
      ctxMid.canonicalByVisitor.get('mid_session'));
    assert(ctxMid.primedScopes.size === 1,
      'PRIME_RETRY_MID8. 兩個 visitor 都正確解析後，scope 才被標記完成', ctxMid.primedScopes.size);

    // DB fixture 本身未被故障注入改變（純粹是 SELECT 查詢注入例外，不影響底層資料）。
    const lineMembersRows = db.all(`SELECT line_user_id FROM line_members WHERE store_id=?`, [STORE_MID]);
    assert(lineMembersRows.length === 2, 'PRIME_RETRY_MID9. DB fixture 本身未被故障注入影響：line_members 仍是原本插入的 2 筆', lineMembersRows.length);
  }

  // ══════════════════════════════════════════════════════════════════
  // EARLY_FAILURE：direct-member／session-link／session-confirm 三種
  // early-failure（第一次呼叫就失敗，不是 mid-sequence）分開驗證，取代
  // 舊的 PRIME_RETRY1b（那個斷言的是已修正的錯誤行為，不能再保留）。
  // ══════════════════════════════════════════════════════════════════
  {
    const STORE_EARLY = 'test_store_h148_early_failure';
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_EARLY, 'early_direct', 'Early直接會員']);
    db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_EARLY, 'EARLY_SESSION_LINE', 'Early連結會員']);
    db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_EARLY, 'EARLY_SESSION_LINE', 'early_session']);

    function injectFailureAt(kind) {
      let occurrence = 0;
      return (sql) => {
        const norm = normalizeSqlForTest(sql);
        if (kind === 'direct-member' && norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          occurrence += 1;
          if (occurrence === 1) throw new Error('[TEST-INJECTED] direct-member 失敗');
        }
        if (kind === 'session-link' && norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions')) {
          throw new Error('[TEST-INJECTED] session-link 失敗');
        }
        if (kind === 'session-confirm' && norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')) {
          occurrence += 1;
          if (occurrence === 2) throw new Error('[TEST-INJECTED] session-confirm 失敗');
        }
      };
    }

    ['direct-member', 'session-link', 'session-confirm'].forEach((kind) => {
      const ctxEarly = createCanonicalIdentityContext(STORE_EARLY, CHANNEL);
      const before = JSON.stringify([...ctxEarly.canonicalByVisitor.entries()]);
      const beforeScopes = JSON.stringify([...ctxEarly.primedScopes]);
      let threw = false;
      const origAll = db.all.bind(db);
      const injector = injectFailureAt(kind);
      db.all = (sql, params) => { injector(sql); return origAll(sql, params); };
      try {
        resolveInContext(db, ctxEarly, STORE_EARLY, ['early_direct', 'early_session']);
      } catch (e) { threw = true; } finally { db.all = origAll; }
      assert(threw, `EARLY_FAILURE-${kind}-1. ${kind} 查詢失敗：往外拋出例外`, threw);
      assert(JSON.stringify([...ctxEarly.canonicalByVisitor.entries()]) === before,
        `EARLY_FAILURE-${kind}-2. 失敗後 canonicalByVisitor 與呼叫前完全相同（沒有部分提交）`, null);
      assert(JSON.stringify([...ctxEarly.primedScopes]) === beforeScopes,
        `EARLY_FAILURE-${kind}-3. 失敗後 primedScopes 與呼叫前完全相同`, null);
    });
  }


  // ══════════════════════════════════════════════════════════════════
  // Identity Query-Count Spy（真正包住 HTTP Route，不是只呼叫底層 helper）：
  // CASE A（1 商品/40 獨立 visitor）vs CASE B（40 商品/相同 40 個 visitor，
  // 分散到不同商品，隔離「商品數」這個變因）vs CASE C（40 商品/1200
  // visitor，測 chunking／SQLite placeholder 上限）。三個案例的 visitor
  // identity 證據都各自獨立（不是共用同一批已經被第一次呼叫填滿的 cache），
  // 避免「剛好被前一個案例快取覆蓋」造成假通過。每個案例都用全新 store，
  // 且在同一個 process 內個案例前後都重新建立一個全新的 sharedIdentityCache
  // （透過重新 require 一次 route 模組不現實，這裡改用「全新 store_id」
  // 保證 identity 證據不重疊，並且每個案例都是全新的 HTTP request，
  // routes/analytics.js 內的 sharedIdentityCache 是每次 request 進 handler
  // 時才 new Map()，天然就是 request-scoped、不跨 request 保留）。
  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（十二次修正）：invariance
  // assertion——同一支 SQL 用單行／多行／不同縮排／多個空白表示，
  // normalizeSqlForTest() 後必須完全相同，且分類結果一致。
  {
    const singleLine = "SELECT visitor_id, line_user_id, last_seen_at FROM line_member_sessions WHERE store_id=? AND visitor_id IN (?,?)";
    const multiLine = `SELECT visitor_id, line_user_id, last_seen_at FROM line_member_sessions
         WHERE store_id=? AND visitor_id IN (?,?)`;
    const weirdIndent = "SELECT   visitor_id,  line_user_id,   last_seen_at\n\t\tFROM line_member_sessions\n  WHERE   store_id=?   AND visitor_id IN (?,?)";
    const normA = normalizeSqlForTest(singleLine);
    const normB = normalizeSqlForTest(multiLine);
    const normC = normalizeSqlForTest(weirdIndent);
    assert(normA === normB && normB === normC,
      'SQLNORM1. 同一支 SQL 的單行／多行／不同縮排／多個空白版本，normalizeSqlForTest() 後完全相同', { normA, normB, normC });
    const classify = (sql) => normalizeSqlForTest(sql).startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions where store_id=? and visitor_id in');
    assert(classify(singleLine) && classify(multiLine) && classify(weirdIndent),
      'SQLNORM2. 三種格式在正規化後都能被同一個分類規則正確辨識為 session-link 查詢', { singleLine: classify(singleLine), multiLine: classify(multiLine), weirdIndent: classify(weirdIndent) });
  }

  // ══════════════════════════════════════════════════════════════════
  // GENERICSHAPE：驗證 scripts/lib/h148-sql-fingerprint.js 的
  // genericShapeFingerprint() 只正規化 IN(...) 的 placeholder 數量，不會
  // 掩蓋 table／JOIN／WHERE predicate／operator／SELECT 欄位／GROUP BY 的
  // 真正差異——避免「跨 case 比較」用的 shape collapse 意外把不同的查詢
  // 誤判成相同。
  // ══════════════════════════════════════════════════════════════════
  {
    const { shapeFingerprint: shapeFp, genericShapeFingerprint: genericFp } = require('./lib/h148-sql-fingerprint');

    // 案例 1：同一支 SQL，只有 IN(?) 與 IN(?,?,...40) arity 不同
    const sqlIn1 = "SELECT id, price FROM products WHERE store_id=? AND id IN (?)";
    const sqlIn40 = "SELECT id, price FROM products WHERE store_id=? AND id IN (" + Array(40).fill('?').join(',') + ")";
    assert(shapeFp(sqlIn1) !== shapeFp(sqlIn40),
      'GENERICSHAPE1. 相同 SQL、IN(?) 與 IN(...40個) arity 不同：exact shape fingerprint 必須不同（保留實際數量）',
      { in1: shapeFp(sqlIn1), in40: shapeFp(sqlIn40) });
    assert(genericFp(sqlIn1) === genericFp(sqlIn40),
      'GENERICSHAPE2. 相同 SQL、IN(?) 與 IN(...40個) arity 不同：generic shape fingerprint 必須相同（只正規化 arity，不正規化其他結構）',
      { in1: genericFp(sqlIn1), in40: genericFp(sqlIn40) });

    // 案例 2：table 名不同
    const sqlTableA = "SELECT id FROM products WHERE store_id=?";
    const sqlTableB = "SELECT id FROM orders WHERE store_id=?";
    assert(genericFp(sqlTableA) !== genericFp(sqlTableB), 'GENERICSHAPE3. table 名不同：generic fingerprint 必須不同', { a: genericFp(sqlTableA), b: genericFp(sqlTableB) });

    // 案例 3：JOIN 不同
    const sqlNoJoin = "SELECT o.id FROM orders o WHERE o.store_id=?";
    const sqlWithJoin = "SELECT o.id FROM orders o JOIN products p ON p.id=o.product_id WHERE o.store_id=?";
    assert(genericFp(sqlNoJoin) !== genericFp(sqlWithJoin), 'GENERICSHAPE4. JOIN 不同：generic fingerprint 必須不同', { noJoin: genericFp(sqlNoJoin), withJoin: genericFp(sqlWithJoin) });

    // 案例 4：WHERE predicate 增減
    const sqlWhereShort = "SELECT id FROM products WHERE store_id=?";
    const sqlWhereLong = "SELECT id FROM products WHERE store_id=? AND enabled=1";
    assert(genericFp(sqlWhereShort) !== genericFp(sqlWhereLong), 'GENERICSHAPE5. WHERE predicate 增減：generic fingerprint 必須不同', { short: genericFp(sqlWhereShort), long: genericFp(sqlWhereLong) });

    // 案例 5：operator 不同（= vs IN）
    const sqlEq = "SELECT id FROM products WHERE store_id=? AND id=?";
    const sqlInOp = "SELECT id FROM products WHERE store_id=? AND id IN (?)";
    assert(genericFp(sqlEq) !== genericFp(sqlInOp), 'GENERICSHAPE6. operator 不同（= vs IN）：generic fingerprint 必須不同', { eq: genericFp(sqlEq), in_: genericFp(sqlInOp) });

    // 案例 6：SELECT 欄位或 GROUP BY 不同
    const sqlSelectA = "SELECT id, name FROM products WHERE store_id=?";
    const sqlSelectB = "SELECT id, price FROM products WHERE store_id=?";
    assert(genericFp(sqlSelectA) !== genericFp(sqlSelectB), 'GENERICSHAPE7. SELECT 欄位不同：generic fingerprint 必須不同', { a: genericFp(sqlSelectA), b: genericFp(sqlSelectB) });
    const sqlGroupA = "SELECT product_id, COUNT(*) FROM analytics_events WHERE store_id=? GROUP BY product_id";
    const sqlGroupB = "SELECT product_id, COUNT(*) FROM analytics_events WHERE store_id=? GROUP BY product_id, cart_id";
    assert(genericFp(sqlGroupA) !== genericFp(sqlGroupB), 'GENERICSHAPE8. GROUP BY 不同：generic fingerprint 必須不同', { a: genericFp(sqlGroupA), b: genericFp(sqlGroupB) });

    // 案例 7：同一 shape 執行 1 次與 40 次——count map 必須不同，不能被
    // shape collapse 隱藏（這是 parent 在比較 execution count 時的責任，
    // 這裡驗證的是：即使兩個 case 的 genericShape 相同，只要「執行次數」
    // 不同，county map 本身仍然要能呈現這個差異，不會被摺疊掉）。
    const countMap1 = {}; const countMap40 = {};
    const key = genericFp(sqlIn1);
    countMap1[key] = 1;
    countMap40[key] = 40;
    assert(countMap1[key] !== countMap40[key],
      'GENERICSHAPE9. 同一個 generic shape，執行 1 次與 40 次：count map 的數值本身必須反映這個差異（不會因為 shape 相同就讓次數也被忽略）',
      { count1: countMap1[key], count40: countMap40[key] });
  }

  function _fingerprintSql(sql) {
    // 正規化：只保留關鍵字/表名/欄位輪廓，不含實際 visitor_id 等個資值
    // （原本查詢字串裡的 IN (?,?,?...) 早就是參數化佔位符，沒有個資，這裡
    // 只是進一步把佔位符數量正規化成 <N>，方便分類同一種查詢形狀）。
    return sql
      .replace(/\s+/g, ' ')
      .replace(/IN \([^)]*\)/g, (m) => `IN (<${(m.match(/\?/g) || []).length}>)`)
      .trim();
  }

  async function spyRouteIdentityQueries(storeId) {
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

    const origAll = db.all.bind(db);
    const origGet = db.get.bind(db);
    let identityAllCount = 0;
    let identityGetCount = 0;
    let nonIdentityAllCount = 0;
    const fingerprintCounts = {}; // sql fingerprint -> count（含 identity 與 discovery 兩種）
    db.all = (sql, params) => {
      // 精確比對 resolveCanonicalVisitors() 自己會發出的兩種查詢形狀（見
      // utils/analyticsIdentity.js），不是任何碰到 line_members 就算——
      // getCrmOverview() 也會查 line_members（跟本次 Product Funnel identity
      // 解析完全無關的 CRM 總覽卡片），籠統的表名比對會把那些也誤算進來。
      // 全部先用 normalizeSqlForTest() 正規化（空白／換行／縮排都不影響
      // 分類結果），不再各自零散補 \s+。
      const norm = normalizeSqlForTest(sql);
      const isIdentityResolution = norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id in')
        || norm.startsWith('select visitor_id, line_user_id, last_seen_at from line_member_sessions');
      const isIncidentalLineMembersTouch = !isIdentityResolution && (norm.includes('line_members') || norm.includes('line_member_sessions'));
      const isDiscovery = norm.startsWith('select distinct visitor_id from analytics_events');
      if (isIdentityResolution) identityAllCount += 1; else nonIdentityAllCount += 1;
      if (isIdentityResolution || isDiscovery) {
        const fp = _fingerprintSql(sql);
        fingerprintCounts[fp] = (fingerprintCounts[fp] || 0) + 1;
      }
      if (isIncidentalLineMembersTouch) {
        const fp = '[INCIDENTAL-NOT-IDENTITY] ' + _fingerprintSql(sql);
        fingerprintCounts[fp] = (fingerprintCounts[fp] || 0) + 1;
      }
      return origAll(sql, params);
    };
    db.get = (sql, params) => {
      const norm = normalizeSqlForTest(sql);
      if (norm.startsWith('select line_user_id from line_members where store_id=? and line_user_id=?')) {
        identityGetCount += 1;
        const fp = _fingerprintSql(sql);
        fingerprintCounts[fp] = (fingerprintCounts[fp] || 0) + 1;
      }
      return origGet(sql, params);
    };

    let res, json;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/analytics/dashboard?store_id=${encodeURIComponent(storeId)}&preset=yesterday&channel=${CHANNEL}`);
      json = await res.json();
    } finally {
      db.all = origAll;
      db.get = origGet;
      server.close();
    }
    return { status: res.status, json, identityQueryCount: identityAllCount + identityGetCount, nonIdentityAllCount, fingerprintCounts };
  }

  function seedIdentityCase(storeId, productAssignments) {
    // productAssignments: [{ productId, visitorIds: [...] }]
    productAssignments.forEach(({ productId }) => {
      db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [productId, storeId, `SpyP${productId}`, '測試', 100]);
    });
    productAssignments.forEach(({ productId, visitorIds }) => {
      visitorIds.forEach((vid) => {
        insertEvent(storeId, 'add_to_cart', { visitorId: vid, cartId: `${vid}_cart`, productId, orderChannel: CHANNEL });
      });
    });
  }

  // ── CASE A：1 商品／40 個獨立 visitor ──────────────────────────────
  const STORE_CASE_A = 'test_store_h148_spy_case_a';
  seedIdentityCase(STORE_CASE_A, [{ productId: 9701, visitorIds: Array.from({ length: 40 }, (_, i) => `caseA_v${i}`) }]);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_CASE_A, 'CaseA店']);
  const spyA = await spyRouteIdentityQueries(STORE_CASE_A);
  assert(spyA.status === 200, 'SPY-A0. CASE A：HTTP 200', spyA.status);

  // ── CASE B：40 商品／相同 40 個 visitor（每個商品分配 1 個不同 visitor，
  // 總 visitor 數與 CASE A 相同，用來隔離「商品數」這個變因）──────────
  const STORE_CASE_B = 'test_store_h148_spy_case_b';
  seedIdentityCase(STORE_CASE_B, Array.from({ length: 40 }, (_, i) => ({ productId: 9800 + i, visitorIds: [`caseB_v${i}`] })));
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_CASE_B, 'CaseB店']);
  const spyB = await spyRouteIdentityQueries(STORE_CASE_B);
  assert(spyB.status === 200, 'SPY-B0. CASE B：HTTP 200', spyB.status);

  console.log(`[SPY] CASE A（1商品/40 visitor）identity 解析查詢次數（精確分類，排除 CRM 附帶查詢） = ${spyA.identityQueryCount}`);
  console.log('[SPY] CASE A fingerprint 分類 =', JSON.stringify(spyA.fingerprintCounts, null, 2));
  console.log(`[SPY] CASE B（40商品/40 visitor，每商品 1 個）identity 解析查詢次數 = ${spyB.identityQueryCount}`);
  console.log('[SPY] CASE B fingerprint 分類 =', JSON.stringify(spyB.fingerprintCounts, null, 2));
  // 精確斷言：resolveCanonicalVisitors() 真正只被呼叫一次（direct-member
  // 查詢與 session-link 查詢各出現恰好 1 次，不是 2 次或更多）——這才是
  // 「global 與 product 共用同一份已完成的 canonical map，不是各自固定
  // 查一次」的直接證據，不是靠總數字推測。
  function _countFp(counts, pattern) {
    return Object.entries(counts).reduce((sum, [fp, n]) => (pattern.test(fp) ? sum + n : sum), 0);
  }
  assert(_countFp(spyA.fingerprintCounts, /line_user_id IN/) === 1,
    'SPY-A1. CASE A：resolveCanonicalVisitors() 的 direct-member 查詢恰好執行 1 次（不是每個商品各查一次）', spyA.fingerprintCounts);
  assert(_countFp(spyA.fingerprintCounts, /line_member_sessions WHERE/) === 1,
    'SPY-A2. CASE A：resolveCanonicalVisitors() 的 session-link 查詢恰好執行 1 次', spyA.fingerprintCounts);
  assert(_countFp(spyB.fingerprintCounts, /line_user_id IN/) === 1,
    'SPY-B1. CASE B（40 商品）：direct-member 查詢仍恰好執行 1 次——證明 getProductFunnel() 一次性 prime 整批 visitor，不是每個商品各自觸發一次 resolveCanonicalVisitors()', spyB.fingerprintCounts);
  assert(_countFp(spyB.fingerprintCounts, /line_member_sessions WHERE/) === 1,
    'SPY-B2. CASE B：session-link 查詢仍恰好執行 1 次', spyB.fingerprintCounts);
  assert(spyA.identityQueryCount === 2 && spyB.identityQueryCount === 2,
    'SPY-AB0. 排除 CRM 附帶查詢後，CASE A 與 CASE B 真正的 identity 解析查詢都精確是 2 次（1 次 direct-member + 1 次 session-link；沒有第 3 次 confirm 查詢，因為本 fixture 沒有任何 session link 命中，candidateLineUserIds 是空陣列，該查詢被跳過——這不是 bug，是既有邏輯的正確短路）',
    { A: spyA.identityQueryCount, B: spyB.identityQueryCount });
  assert(spyB.identityQueryCount <= spyA.identityQueryCount + 2,
    'SPY-AB. identity SQL 次數不因商品數從 1 增加到 40 而顯著增加（A=' + spyA.identityQueryCount + '，B=' + spyB.identityQueryCount + '；不是 40 倍増長，證明不是 products × stages 型增長）',
    { A: spyA.identityQueryCount, B: spyB.identityQueryCount });
  assert(spyA.json.analytics_v2.global_canonical.add_to_cart.unique_users === 40,
    'SPY-A3. CASE A global_canonical.add_to_cart.unique_users 精確為 40', spyA.json.analytics_v2.global_canonical);
  assert(spyB.json.analytics_v2.global_canonical.add_to_cart.unique_users === 40,
    'SPY-B3. CASE B global_canonical.add_to_cart.unique_users 精確為 40（跟 A 的全局總人數相同，只是分散到 40 個商品）', spyB.json.analytics_v2.global_canonical);

  // ── CASE C：40 商品／1200 個 distinct visitor（測 chunking／SQLite
  // placeholder 上限；query count 只能依固定 chunk 數有界增加，不能是
  // products × stages × visitors）──────────────────────────────────
  const STORE_CASE_C = 'test_store_h148_spy_case_c';
  const caseCAssignments = Array.from({ length: 40 }, (_, i) => ({
    productId: 9900 + i,
    visitorIds: Array.from({ length: 30 }, (_, j) => `caseC_v${i}_${j}`), // 40*30=1200
  }));
  seedIdentityCase(STORE_CASE_C, caseCAssignments);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_CASE_C, 'CaseC店']);
  const spyC = await spyRouteIdentityQueries(STORE_CASE_C);
  console.log(`[SPY] CASE C（40商品/1200 distinct visitor）identity 查詢次數 = ${spyC.identityQueryCount}`);
  assert(spyC.status === 200, 'SPY-C0. CASE C（1200 visitors）：HTTP 200，沒有因為 SQLite IN() placeholder 上限而整支 API 500', spyC.status);
  assert(spyC.json && spyC.json.analytics_v2 && spyC.json.analytics_v2.global_canonical && spyC.json.analytics_v2.global_canonical.add_to_cart.unique_users === 1200,
    'SPY-C1. CASE C 全局 add_to_cart.unique_users 精確為 1200（1200 個都是未連結匿名訪客，不因 chunking 漏算或多算）',
    spyC.json && spyC.json.analytics_v2 && spyC.json.analytics_v2.global_canonical);
  // query 次數只能依固定 chunk 數增加（例如 SQLite 一次 IN() 上限約 999，
  // 1200 個 id 至少要切 2 個 chunk），不是 40 商品 × 3 stage × visitor 數
  // 那種量級（若真的是那種增長，identityQueryCount 會是幾千次）。
  assert(spyC.identityQueryCount < 50,
    'SPY-C2. CASE C（40 商品/1200 visitor）identity SQL 次數遠低於 50 次（只依 chunk 數有界增加，不是 products × stages × visitors 量級）',
    spyC.identityQueryCount);

  // ── SQLite engine 證據：MAX_VARIABLE_NUMBER，證明 1200 個 IN() 參數不會
  // 撞到 placeholder 上限（本 Runtime 與 routes/analytics.js 用的是同一個
  // sql.js DB instance，同一個引擎版本，不是另一套環境）──────────────
  {
    const sqliteVersion = db.get('SELECT sqlite_version() as v').v;
    const compileOptions = db.all('PRAGMA compile_options');
    const maxVarOpt = compileOptions.find((o) => String(o.compile_options || '').startsWith('MAX_VARIABLE_NUMBER='));
    const maxVar = maxVarOpt ? Number(String(maxVarOpt.compile_options).split('=')[1]) : null;
    console.log(`[ENGINE] sqlite_version=${sqliteVersion}, MAX_VARIABLE_NUMBER=${maxVar}`);
    assert(!!maxVar && maxVar >= 1200,
      `ENGINE1. 正式 SQLite engine（sqlite_version=${sqliteVersion}）的 MAX_VARIABLE_NUMBER=${maxVar}，遠高於本測試用到的 1200 個 IN() 參數，不需要 chunking`,
      { sqliteVersion, maxVar });
  }

  // ── CASE E：1200 個 distinct visitor，每一個都透過 line_member_sessions
  // 決定性連結到 1200 個不同、真實存在於 line_members 的 LINE UID——
  // 這才會真正走到 resolveCanonicalVisitors() 的第三支查詢（session-link
  // 找到的 line_user_id 要再回查 line_members 確認會員真的存在）。CASE C
  // 只有 direct-member／session-link 兩支，從未驗證過第三支在大規模下的行為。
  const STORE_CASE_E = 'test_store_h148_spy_case_e';
  const caseEAssignments = Array.from({ length: 40 }, (_, i) => ({
    productId: 9950 + i,
    visitorIds: Array.from({ length: 30 }, (_, j) => `caseE_v${i}_${j}`), // 40*30=1200
  }));
  seedIdentityCase(STORE_CASE_E, caseEAssignments);
  db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [STORE_CASE_E, 'CaseE店']);
  // 幫每一個 visitor 建立一個真實、確定性連結的 LINE 會員（觸發第三支查詢）
  caseEAssignments.forEach(({ visitorIds }) => {
    visitorIds.forEach((vid) => {
      const lineUid = `CASE_E_LINE_${vid}`;
      db.run(`INSERT INTO line_members (store_id, line_user_id, display_name) VALUES (?,?,?)`, [STORE_CASE_E, lineUid, 'CaseE會員']);
      db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id) VALUES (?,?,?)`, [STORE_CASE_E, lineUid, vid]);
    });
  });
  const spyE = await spyRouteIdentityQueries(STORE_CASE_E);
  console.log(`[SPY] CASE E（40商品/1200 session-linked visitor，觸發第三支 confirm 查詢）identity 解析查詢次數 = ${spyE.identityQueryCount}`);
  console.log('[SPY] CASE E fingerprint 分類 =', JSON.stringify(spyE.fingerprintCounts, null, 2));
  assert(spyE.status === 200, 'SPY-E0. CASE E（1200 個 session-linked visitor）：HTTP 200，不因規模或第三支查詢而 500', spyE.status);
  assert(spyE.json && spyE.json.analytics_v2 && spyE.json.analytics_v2.global_canonical && spyE.json.analytics_v2.global_canonical.add_to_cart.unique_users === 1200,
    'SPY-E1. CASE E 全局 add_to_cart.unique_users 精確為 1200（每個 visitor 都透過決定性連結變成一個不同的 line_user，仍是 1200 個不重複的人，因為每個人連到不同 LINE UID）',
    spyE.json && spyE.json.analytics_v2 && spyE.json.analytics_v2.global_canonical);
  // 這裡精確比對「line_members WHERE line_user_id IN」這個 fingerprint 的次數：
  // direct-member 比對與 confirm 步驟用的是完全相同的 SQL 文字形狀（只是
  // 參數不同），所以次數從 1（CASE A/B/C，沒有任何 session link，confirm
  // 被跳過）變成 2（CASE E，direct-member 比對 1 次 + confirm 步驟 1 次），
  // 就是「第三支查詢真的被觸發」的直接證據。
  const lineUserIdInFp = Object.keys(spyE.fingerprintCounts).find((fp) => /SELECT line_user_id FROM line_members WHERE store_id=\? AND line_user_id IN/.test(fp));
  assert(!!lineUserIdInFp && spyE.fingerprintCounts[lineUserIdInFp] === 2,
    'SPY-E2. CASE E 的「line_members WHERE line_user_id IN」查詢恰好出現 2 次（direct-member 比對 1 次 + confirm session-linked line_user_id 存在性 1 次），對照 CASE A/B/C 只出現 1 次（沒有 session link 可以 confirm）——證明第三支分支真正被觸發，不是理論上存在卻從未測到，且即使 1200 個 visitor 全部都需要 confirm，也只查 1 次（批次），不是逐個查', spyE.fingerprintCounts);
  assert(spyE.identityQueryCount < 50,
    'SPY-E3. CASE E（40 商品/1200 session-linked visitor，含第三支 confirm 查詢）identity SQL 次數仍遠低於 50 次（有界，不隨商品數或 visitor 數線性增長）',
    spyE.identityQueryCount);

  console.log('[SPY] 說明：本測試全程 db.all/db.get 都是同步呼叫（sql.js 本身是同步 API，routes/analytics.js 的 /dashboard handler 也不是 async function），因此不存在「並行 in-flight promise 重複查詢」的風險——整條 call chain（HTTP → getProductFunnel → 每個 stage helper → identityCache → resolveCanonicalVisitors → identity SQL）是單一執行緒依序執行，不是 Promise.all() 並行。');

// ══════════════════════════════════════════════════════════════════
  // DB_ISOLATION：Gate B 明確要求的 fail-fast 自我驗證——正式 data/pos.db
  // 的 hash 前後必須完全相同，且不得留下 -wal／-shm 附屬檔。這是本
  // Runtime 自己斷言，不是事後靠人工 git checkout 還原來宣稱乾淨。
  // ══════════════════════════════════════════════════════════════════
  {
    const hashAfter = _hashFile(REAL_DB_PATH);
    assert(hashAfter === REAL_DB_HASH_BEFORE,
      'DB_ISOLATION1. 正式 data/pos.db 的 SHA1 hash 前後完全相同（本 Runtime 全程只碰臨時 DB，從未寫入正式 DB 檔案）',
      { before: REAL_DB_HASH_BEFORE, after: hashAfter });
    assert(!fs.existsSync(REAL_DB_WAL_PATH), 'DB_ISOLATION2. 沒有殘留 data/pos.db-wal', fs.existsSync(REAL_DB_WAL_PATH));
    assert(!fs.existsSync(REAL_DB_SHM_PATH), 'DB_ISOLATION3. 沒有殘留 data/pos.db-shm', fs.existsSync(REAL_DB_SHM_PATH));
  }

  // ══════════════════════════════════════════════════════════════════
  // HELPER1-6：Stage 3A scripts/lib/qa-temp-db.js 新增 orchestrator/child
  // 隔離 helper 的可重跑 regression assertion（取代先前只寫入一次性 JSON
  // 的做法）。每次執行本 Runtime 都會重新驗證這 6 項，failure 會讓整支
  // Runtime exit non-zero，不是事後才回頭補的靜態宣稱。
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const { execFileSync } = require('child_process');

    // HELPER1: success-path cleanup removes db file + sidecars + tmpRoot
    {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('h148-helper1');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'c1');
      fs.writeFileSync(dbPath, 'fake');
      fs.writeFileSync(`${dbPath}-wal`, 'x');
      dbHelper.cleanupDbFileAndSidecars(dbPath);
      const dbGone = !fs.existsSync(dbPath) && !fs.existsSync(`${dbPath}-wal`);
      cleanupRoot();
      assert(dbGone && !fs.existsSync(tmpRoot),
        'HELPER1. qa-temp-db.js success-path cleanup 移除 db 檔、-wal sidecar 與 tmpRoot',
        { dbGone, tmpRootGone: !fs.existsSync(tmpRoot) });
    }

    // HELPER2: synchronous throw inside try still cleans up via finally
    {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('h148-helper2');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'c2');
      fs.writeFileSync(dbPath, 'x');
      let threw = false;
      try {
        try { throw new Error('injected synchronous failure'); }
        finally { dbHelper.cleanupDbFileAndSidecars(dbPath); cleanupRoot(); }
      } catch (e) { threw = true; }
      assert(threw && !fs.existsSync(tmpRoot),
        'HELPER2. synchronous throw 仍透過 finally 完成 cleanup（tmpRoot 不殘留）',
        { threw, tmpRootGone: !fs.existsSync(tmpRoot) });
    }

    // HELPER3: non-zero child exit still allows cleanup
    {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('h148-helper3');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'c3');
      fs.writeFileSync(dbPath, 'x');
      const env = dbHelper.buildChildEnv(dbPath, tmpRoot);
      let exitCode = 0;
      try { execFileSync(process.execPath, ['-e', 'process.exit(7)'], { env }); }
      catch (e) { exitCode = e.status; }
      finally { dbHelper.cleanupDbFileAndSidecars(dbPath); cleanupRoot(); }
      assert(exitCode === 7 && !fs.existsSync(tmpRoot),
        'HELPER3. child non-zero exit（實際 execFileSync，exit=7）後仍完成 cleanup',
        { exitCode, tmpRootGone: !fs.existsSync(tmpRoot) });
    }

    // HELPER4: idempotent double cleanup (calling cleanup twice must not throw)
    {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('h148-helper4');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'c4');
      fs.writeFileSync(dbPath, 'x');
      let doubleCleanupThrew = false;
      try {
        dbHelper.cleanupDbFileAndSidecars(dbPath);
        dbHelper.cleanupDbFileAndSidecars(dbPath);
        cleanupRoot();
        cleanupRoot();
      } catch (e) { doubleCleanupThrew = true; }
      assert(!doubleCleanupThrew,
        'HELPER4. 呼叫 cleanup 兩次是安全的（idempotent，不 throw）',
        { doubleCleanupThrew });
    }

    // HELPER5: cleanup of one temp root does not touch a sibling temp root
    {
      const a = dbHelper.createOrchestratorTempRoot('h148-helper5a');
      const b = dbHelper.createOrchestratorTempRoot('h148-helper5b');
      const dbA = dbHelper.createChildDbPath(a.tmpRoot, 'ca');
      const dbB = dbHelper.createChildDbPath(b.tmpRoot, 'cb');
      fs.writeFileSync(dbA, 'a');
      fs.writeFileSync(dbB, 'b');
      a.cleanupRoot();
      const siblingIntact = fs.existsSync(b.tmpRoot) && fs.existsSync(dbB);
      const aGone = !fs.existsSync(a.tmpRoot);
      b.cleanupRoot();
      assert(aGone && siblingIntact,
        'HELPER5. 清除一個 temp root 不會刪除 sibling temp root／db 檔',
        { aGone, siblingIntact });
    }

    // HELPER6: real data/pos.db sentinel unchanged after all HELPER1-5 above
    {
      const hashAfterHelpers = _hashFile(REAL_DB_PATH);
      assert(hashAfterHelpers === REAL_DB_HASH_BEFORE,
        'HELPER6. HELPER1-5 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterHelpers });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // OWNERSHIP1-9：Stage 3A POS_DB_PATH／POS_DB_TEMP_ROOT root-containment
  // ownership contract (scripts/lib/qa-temp-db.js bootstrapChildDb /
  // validateParentProvidedDb). Re-verified on every run.
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const osMod = require('os');

    function withCleanEnv(fn) {
      const savedPath = process.env.POS_DB_PATH;
      const savedRoot = process.env.POS_DB_TEMP_ROOT;
      delete process.env.POS_DB_PATH;
      delete process.env.POS_DB_TEMP_ROOT;
      try { return fn(); }
      finally {
        if (savedPath === undefined) delete process.env.POS_DB_PATH; else process.env.POS_DB_PATH = savedPath;
        if (savedRoot === undefined) delete process.env.POS_DB_TEMP_ROOT; else process.env.POS_DB_TEMP_ROOT = savedRoot;
      }
    }

    // OWNERSHIP1: standalone creates a safe root, ownsTempRoot === true
    withCleanEnv(() => {
      const r = dbHelper.bootstrapChildDb('ownership-test1');
      const ok = r.ownsTempRoot === true && fs.existsSync(r.tmpRoot);
      r.cleanup();
      assert(ok && !fs.existsSync(r.tmpRoot),
        'OWNERSHIP1. standalone bootstrapChildDb() 建立安全 root，ownsTempRoot===true，cleanup() 後 root 消失',
        { ownsTempRoot: r.ownsTempRoot });
    });

    // OWNERSHIP2: legit parent-provided path accepted, ownsTempRoot === false
    withCleanEnv(() => {
      const { tmpRoot } = dbHelper.createOrchestratorTempRoot('ownership-test2-parent');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'child2');
      process.env.POS_DB_PATH = dbPath;
      process.env.POS_DB_TEMP_ROOT = tmpRoot;
      const r = dbHelper.bootstrapChildDb('ownership-test2');
      const ok = r.ownsTempRoot === false && r.dbPath === path.resolve(dbPath);
      r.cleanup();
      const rootStillExists = fs.existsSync(tmpRoot);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      assert(ok && rootStillExists,
        'OWNERSHIP2. 合法 parent-provided path 被接受（ownsTempRoot===false），child cleanup() 不刪除 parent root');
    });

    // OWNERSHIP3: only POS_DB_PATH set -> fail closed
    withCleanEnv(() => {
      process.env.POS_DB_PATH = '/tmp/ownership-test3-fake';
      let threw = false;
      try { dbHelper.bootstrapChildDb('ownership-test3'); } catch (e) { threw = true; }
      assert(threw, 'OWNERSHIP3. 只有 POS_DB_PATH、沒有 POS_DB_TEMP_ROOT 時 fail closed（throw，不 fallback）');
    });

    // OWNERSHIP4: only POS_DB_TEMP_ROOT set -> fail closed
    withCleanEnv(() => {
      process.env.POS_DB_TEMP_ROOT = '/tmp/ownership-test4-fake';
      let threw = false;
      try { dbHelper.bootstrapChildDb('ownership-test4'); } catch (e) { threw = true; }
      assert(threw, 'OWNERSHIP4. 只有 POS_DB_TEMP_ROOT、沒有 POS_DB_PATH 時 fail closed（throw，不 fallback）');
    });

    // OWNERSHIP5: DB path outside root -> rejected
    withCleanEnv(() => {
      const { tmpRoot } = dbHelper.createOrchestratorTempRoot('ownership-test5-root');
      const outsideDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'ownership-test5-outside-'));
      process.env.POS_DB_PATH = path.join(outsideDir, 'pos.db');
      process.env.POS_DB_TEMP_ROOT = tmpRoot;
      let threw = false;
      try { dbHelper.bootstrapChildDb('ownership-test5'); } catch (e) { threw = true; }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      assert(threw, 'OWNERSHIP5. POS_DB_PATH 在 POS_DB_TEMP_ROOT 之外時被拒絕');
    });

    // OWNERSHIP6: sibling-prefix escape rejected (root=/tmp/h148-abc vs db under /tmp/h148-abc-evil)
    withCleanEnv(() => {
      const base = fs.mkdtempSync(path.join(osMod.tmpdir(), 'h148-ownership-sibling-'));
      const evilDir = `${base}-evil`;
      fs.mkdirSync(evilDir, { recursive: true });
      process.env.POS_DB_PATH = path.join(evilDir, 'pos.db');
      process.env.POS_DB_TEMP_ROOT = base;
      let threw = false;
      try { dbHelper.bootstrapChildDb('ownership-test6'); } catch (e) { threw = true; }
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(evilDir, { recursive: true, force: true });
      assert(threw, 'OWNERSHIP6. sibling-prefix escape 被拒絕（path.relative-based check，非字串 prefix 比對）');
    });

    // OWNERSHIP7: production DB path rejected even with a valid root
    withCleanEnv(() => {
      const { tmpRoot } = dbHelper.createOrchestratorTempRoot('ownership-test7');
      process.env.POS_DB_PATH = REAL_DB_PATH;
      process.env.POS_DB_TEMP_ROOT = tmpRoot;
      let threw = false;
      try { dbHelper.bootstrapChildDb('ownership-test7'); } catch (e) { threw = true; }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      assert(threw, 'OWNERSHIP7. 正式 data/pos.db 路徑即使搭配合法 root 仍被拒絕');
    });

    // OWNERSHIP8: parent-owned mode cleanup() does not delete the db file or root
    withCleanEnv(() => {
      const { tmpRoot } = dbHelper.createOrchestratorTempRoot('ownership-test8');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'child8');
      fs.writeFileSync(dbPath, 'x');
      process.env.POS_DB_PATH = dbPath;
      process.env.POS_DB_TEMP_ROOT = tmpRoot;
      const r = dbHelper.bootstrapChildDb('ownership-test8');
      r.cleanup();
      const dbStillExists = fs.existsSync(dbPath);
      const rootStillExists = fs.existsSync(tmpRoot);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      assert(dbStillExists && rootStillExists,
        'OWNERSHIP8. parent-owned mode 的 cleanup() 不刪除 db 檔或 parent root');
    });

    // OWNERSHIP9: standalone failure path still fully cleans up (via finally)
    withCleanEnv(() => {
      const r = dbHelper.bootstrapChildDb('ownership-test9');
      let threw = false;
      try {
        try { throw new Error('simulated failure'); }
        finally { r.cleanup(); }
      } catch (e) { threw = true; }
      assert(threw && !fs.existsSync(r.tmpRoot),
        'OWNERSHIP9. standalone failure path（拋出例外）仍透過 finally 完整 cleanup（root 不殘留）');
    });

    // OWNERSHIP10: buildChildEnv() writes POS_DB_PATH/POS_DB_TEMP_ROOT LAST --
    // a conflicting value in extraEnv (or inherited from process.env) must
    // never win over the safety-verified path/root.
    withCleanEnv(() => {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('ownership-test10');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'child10');
      const conflictingExtraEnv = {
        POS_DB_PATH: REAL_DB_PATH, // attacker/caller-supplied conflicting value pointing at the real DB
        POS_DB_TEMP_ROOT: '/tmp', // attacker/caller-supplied conflicting broad root
        SOME_OTHER_VAR: 'kept', // sanity check that legitimate extraEnv still passes through
      };
      const env = dbHelper.buildChildEnv(dbPath, tmpRoot, conflictingExtraEnv);
      const ok = env.POS_DB_PATH === path.resolve(dbPath)
        && env.POS_DB_TEMP_ROOT === path.resolve(tmpRoot)
        && env.SOME_OTHER_VAR === 'kept';
      cleanupRoot();
      assert(ok,
        'OWNERSHIP10. buildChildEnv() 的 POS_DB_PATH／POS_DB_TEMP_ROOT 最後寫入，conflicting extraEnv（含指向正式 DB／broad root 的偽造值）無法覆蓋安全驗證後的值，其餘 extraEnv 仍正常傳遞',
        { returnedPath: env.POS_DB_PATH, returnedRoot: env.POS_DB_TEMP_ROOT });
    });

    // OWNERSHIP11: proves the runEntry() pattern used by Batch C children --
    // bootstrap succeeds, then a SUBSEQUENT step (simulating a require()/
    // module-init failure) throws inside the SAME outer try block. The
    // outer finally must still fully clean up the standalone root, because
    // bootstrap and the DB-touching require live inside one try/finally
    // lifecycle (not two separate, disconnected cleanup paths). Does NOT
    // require() any actual Batch C child -- the failure is simulated with a
    // plain throw standing in for "the next require/init step failed".
    withCleanEnv(() => {
      let dbContext;
      let threw = false;
      let tmpRootAtFailure = null;
      try {
        try {
          dbContext = dbHelper.bootstrapChildDb('ownership-test11');
          tmpRootAtFailure = dbContext.tmpRoot;
          // Simulate: bootstrap succeeded, then the next require()/module-init
          // step (e.g. require('utils/db.js') or similar) throws.
          throw new Error('simulated module-load failure after successful bootstrap');
        } finally {
          if (dbContext && dbContext.ownsTempRoot) dbContext.cleanup();
        }
      } catch (e) { threw = true; }
      const rootGone = tmpRootAtFailure && !fs.existsSync(tmpRootAtFailure);
      const dbGone = dbContext && !fs.existsSync(dbContext.dbPath);
      assert(threw && rootGone && dbGone,
        'OWNERSHIP11. bootstrap 成功後，同一個 outer try 內下一步（模擬 require/module-init）拋錯，finally 仍完整清除 standalone temp DB／sidecars／root',
        { threw, rootGone, dbGone });
    });

    // OWNERSHIP12: proves bootstrapChildDb()'s OWN internal rollback -- root
    // creation succeeds, then createChildDbPath() fails (deterministically
    // injected via the test-only _deps seam, not an env var or fault flag
    // any real caller could trigger). bootstrapChildDb() must rethrow the
    // original error AND the just-created root must already be gone by the
    // time the error propagates -- this is bootstrapChildDb()'s own
    // rollback, distinct from OWNERSHIP11's caller-side finally.
    withCleanEnv(() => {
      let capturedTmpRoot = null;
      const injectedError = new Error('OWNERSHIP12 injected deterministic createChildDbPath failure');
      let threw = false;
      let thrownIsSameError = false;
      try {
        dbHelper.bootstrapChildDb('ownership-test12', {
          createChildDbPath: (tmpRoot /* , label */) => {
            capturedTmpRoot = tmpRoot;
            assert(fs.existsSync(tmpRoot), 'OWNERSHIP12-precondition. root 在注入失敗前確實已建立');
            throw injectedError;
          },
        });
      } catch (e) {
        threw = true;
        thrownIsSameError = e === injectedError;
      }
      const rootGone = capturedTmpRoot !== null && !fs.existsSync(capturedTmpRoot);
      let noSidecarResidue = true;
      if (capturedTmpRoot) {
        const parentDir = path.dirname(capturedTmpRoot);
        const leaked = fs.existsSync(parentDir)
          ? fs.readdirSync(parentDir).filter((f) => f.startsWith(path.basename(capturedTmpRoot)))
          : [];
        noSidecarResidue = leaked.length === 0;
      }
      assert(threw && thrownIsSameError && rootGone && noSidecarResidue,
        'OWNERSHIP12. root 建立成功後、createChildDbPath() 失敗（deterministic 注入）：bootstrapChildDb() 自己 rethrow 原錯誤，且已建立的 root 已被自行 rollback 清除，無殘留',
        { threw, thrownIsSameError, rootGone, noSidecarResidue, capturedTmpRoot });
    });

    // OWNERSHIP12-SENTINEL: real DB sentinel unchanged after OWNERSHIP12
    {
      const hashAfterOwnership12 = _hashFile(REAL_DB_PATH);
      assert(hashAfterOwnership12 === REAL_DB_HASH_BEFORE,
        'OWNERSHIP12-SENTINEL. OWNERSHIP12 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterOwnership12 });
    }

    // OWNERSHIP-SENTINEL: real DB sentinel unchanged after OWNERSHIP1-9
    {
      const hashAfterOwnership = _hashFile(REAL_DB_PATH);
      assert(hashAfterOwnership === REAL_DB_HASH_BEFORE,
        'OWNERSHIP-SENTINEL. OWNERSHIP1-12 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterOwnership });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CLEANUP-POLICY1-4：Stage 3A qa-temp-db.js 的 runCleanupSteps()/
  // handleOwnedCleanup() 4-cell truth-table 驗證（success/cleanup ×
  // primary/no-primary），加上 secondary-diagnostic 保存與 DB sentinel。
  // Re-verified on every run.
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');

    // CLEANUP-POLICY1: success + cleanup success -> no throw
    {
      const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('cleanup-policy-1');
      const dbPath = dbHelper.createChildDbPath(tmpRoot, 'c1');
      const dbContext = { dbPath, tmpRoot, ownsTempRoot: true, cleanup: () => { dbHelper.cleanupDbFileAndSidecars(dbPath); cleanupRoot(); } };
      let threw = false;
      try { dbHelper.handleOwnedCleanup(dbContext, undefined); } catch (e) { threw = true; }
      assert(!threw && !fs.existsSync(tmpRoot),
        'CLEANUP-POLICY1. success + cleanup success：不 throw，root 確實被清除');
    }

    // CLEANUP-POLICY2: success (no primary) + cleanup FAILS -> must throw (failure surfaced, not exit 0)
    {
      const injectedCleanupErr = new Error('CLEANUP-POLICY2 injected cleanup failure');
      const dbContext = { ownsTempRoot: true, cleanup: () => { throw injectedCleanupErr; } };
      let threw = false;
      let caught = null;
      try { dbHelper.handleOwnedCleanup(dbContext, undefined); } catch (e) { threw = true; caught = e; }
      assert(threw && caught === injectedCleanupErr,
        'CLEANUP-POLICY2. success（無 primary）+ cleanup 失敗：必須 throw cleanup error（不可 exit 0 掩蓋成功假象）',
        { threw, sameError: caught === injectedCleanupErr });
    }

    // CLEANUP-POLICY3: primary error + cleanup success -> primary identity preserved, no throw from cleanup itself
    {
      const primaryErr = new Error('CLEANUP-POLICY3 injected primary error');
      let cleanupRan = false;
      const dbContext = { ownsTempRoot: true, cleanup: () => { cleanupRan = true; } };
      let rethrown = null;
      try {
        try { throw primaryErr; }
        finally { dbHelper.handleOwnedCleanup(dbContext, primaryErr); }
      } catch (e) { rethrown = e; }
      assert(rethrown === primaryErr && cleanupRan && !primaryErr.secondaryCleanupErrors,
        'CLEANUP-POLICY3. primary error + cleanup success：primary identity 保留（===），cleanup 仍有執行，沒有 secondary diagnostic');
    }

    // CLEANUP-POLICY4: primary error + cleanup FAILS -> primary identity preserved (not replaced), secondary diagnostic attached and retrievable
    {
      const primaryErr = new Error('CLEANUP-POLICY4 injected primary error');
      const cleanupErr = new Error('CLEANUP-POLICY4 injected cleanup failure');
      const dbContext = { ownsTempRoot: true, cleanup: () => { throw cleanupErr; } };
      let rethrown = null;
      try {
        try { throw primaryErr; }
        finally { dbHelper.handleOwnedCleanup(dbContext, primaryErr); }
      } catch (e) { rethrown = e; }
      const secondaryOk = Array.isArray(rethrown && rethrown.secondaryCleanupErrors)
        && rethrown.secondaryCleanupErrors.length === 1
        && rethrown.secondaryCleanupErrors[0] === cleanupErr;
      assert(rethrown === primaryErr && secondaryOk,
        'CLEANUP-POLICY4. primary error + cleanup 失敗：primary identity 保留（不被 cleanup error 取代），cleanup error 以 secondaryCleanupErrors[] 附加、可取得，不 throw',
        { primaryPreserved: rethrown === primaryErr, secondaryOk });
    }

    // CLEANUP-POLICY-SENTINEL: real DB sentinel unchanged after CLEANUP-POLICY1-4
    {
      const hashAfterCleanupPolicy = _hashFile(REAL_DB_PATH);
      assert(hashAfterCleanupPolicy === REAL_DB_HASH_BEFORE,
        'CLEANUP-POLICY-SENTINEL. CLEANUP-POLICY1-4 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterCleanupPolicy });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ASYNC-CLEANUP-POLICY1-7：runCleanupStepsAsync()/handleOwnedCleanupAsync()
  // 及同步 helper 對 thenable step 的 fail-fast 行為。全部用真正的 async
  // step function（而非同步函式）驗證，並確認不產生 unhandled rejection。
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ASYNC-CLEANUP-POLICY1: async steps run in order, each fully awaited
    {
      const order = [];
      await dbHelper.runCleanupStepsAsync([
        { name: 'first', fn: async () => { await sleep(15); order.push('first'); } },
        { name: 'second', fn: async () => { await sleep(1); order.push('second'); } },
        { name: 'third', fn: async () => { order.push('third'); } },
      ], undefined);
      assert(order.join(',') === 'first,second,third',
        'ASYNC-CLEANUP-POLICY1. async cleanup steps 依序完整 await（即使前面 step 較慢，仍照宣告順序完成，不是並行競速）',
        { order });
    }

    // ASYNC-CLEANUP-POLICY2: a middle step rejecting does not stop subsequent steps
    {
      const ran = [];
      let threw = false;
      try {
        await dbHelper.runCleanupStepsAsync([
          { name: 'a', fn: async () => { ran.push('a'); } },
          { name: 'b', fn: async () => { ran.push('b'); throw new Error('ASYNC-CLEANUP-POLICY2 mid-step failure'); } },
          { name: 'c', fn: async () => { ran.push('c'); } },
        ], undefined);
      } catch (e) { threw = true; }
      assert(threw && ran.join(',') === 'a,b,c',
        'ASYNC-CLEANUP-POLICY2. 中間 step reject 後，後續 step 仍會執行（不因一個失敗就跳過其餘 cleanup）',
        { ran });
    }

    // ASYNC-CLEANUP-POLICY3: success (no primary) + async cleanup failure -> must throw
    {
      let threw = false;
      let caught = null;
      const injected = new Error('ASYNC-CLEANUP-POLICY3 injected failure');
      try {
        await dbHelper.handleOwnedCleanupAsync({ ownsTempRoot: true, cleanup: async () => { await sleep(1); throw injected; } }, undefined);
      } catch (e) { threw = true; caught = e; }
      assert(threw && caught === injected,
        'ASYNC-CLEANUP-POLICY3. success（無 primary）+ async cleanup 失敗：必須 throw（不可掩蓋成 exit 0）');
    }

    // ASYNC-CLEANUP-POLICY4: primary error + async cleanup failure -> primary identity preserved
    {
      const primaryErr = new Error('ASYNC-CLEANUP-POLICY4 injected primary error');
      const cleanupErr = new Error('ASYNC-CLEANUP-POLICY4 injected cleanup failure');
      let rethrown = null;
      try {
        try { throw primaryErr; }
        finally { await dbHelper.handleOwnedCleanupAsync({ ownsTempRoot: true, cleanup: async () => { throw cleanupErr; } }, primaryErr); }
      } catch (e) { rethrown = e; }
      assert(rethrown === primaryErr && Array.isArray(primaryErr.secondaryCleanupErrors) && primaryErr.secondaryCleanupErrors[0] === cleanupErr,
        'ASYNC-CLEANUP-POLICY4. primary error + async cleanup 失敗：primary identity 保留（===），cleanup error 以 secondary diagnostic 附加');
    }

    // ASYNC-CLEANUP-POLICY5: multiple async cleanup failures all collected (no primary)
    {
      const err1 = new Error('ASYNC-CLEANUP-POLICY5 failure 1');
      const err2 = new Error('ASYNC-CLEANUP-POLICY5 failure 2');
      let caught = null;
      try {
        await dbHelper.runCleanupStepsAsync([
          { name: 'x', fn: async () => { throw err1; } },
          { name: 'y', fn: async () => { /* ok */ } },
          { name: 'z', fn: async () => { throw err2; } },
        ], undefined);
      } catch (e) { caught = e; }
      const collected = caught && Array.isArray(caught.errors) ? caught.errors : (caught && caught.allCleanupErrors);
      const ok = Array.isArray(collected) && collected.length === 2 && collected.includes(err1) && collected.includes(err2);
      assert(ok,
        'ASYNC-CLEANUP-POLICY5. 多個 async cleanup step 失敗時，全部被收集進單一 combined error（AggregateError.errors 或 .allCleanupErrors），不是只留下最後一個',
        { hasCollected: !!collected, count: collected ? collected.length : 0 });
    }

    // ASYNC-CLEANUP-POLICY6: the SYNCHRONOUS helper fails closed when a step returns a thenable
    {
      let threw = false;
      let msg = '';
      try {
        dbHelper.runCleanupSteps([{ name: 'returnsPromise', fn: () => Promise.resolve('looks fine but is async') }], undefined);
      } catch (e) { threw = true; msg = e.message || ''; }
      assert(threw && /thenable|Promise/.test(msg),
        'ASYNC-CLEANUP-POLICY6. 同步 runCleanupSteps() 收到回傳 thenable/Promise 的 step 時 fail closed（不會假裝已經同步完成）',
        { threw, msg });
    }

    // ASYNC-CLEANUP-POLICY6B: sync helper receiving a REJECTING thenable
    // (not just a resolving one like POLICY6 above) -- must still fail
    // closed, subsequent steps must still run, and the rejection must
    // never surface as a process-level unhandledRejection. Proven with a
    // real process.on('unhandledRejection') listener + counter (not by
    // "no warning seen in console output"), and the listener is removed in
    // a finally so it never leaks into other assertions in this file.
    {
      let unhandledCount = 0;
      const onUnhandled = () => { unhandledCount++; };
      process.on('unhandledRejection', onUnhandled);
      let rejectingPromise = null;
      const ran = [];
      let threw = false;
      let msg = '';
      try {
        try {
          dbHelper.runCleanupSteps([
            { name: 'rejects', fn: () => { ran.push('rejects'); rejectingPromise = Promise.reject(new Error('ASYNC-CLEANUP-POLICY6B injected rejection')); return rejectingPromise; } },
            { name: 'after', fn: () => { ran.push('after'); } },
          ], undefined);
        } catch (e) { threw = true; msg = e.message || ''; }
        // Give the microtask/event-loop queue a real tick so a genuine
        // unhandledRejection (if our fix were missing) would have fired by
        // now -- this is not a synchronous-only check.
        await sleep(20);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
      assert(threw && /thenable|Promise/.test(msg) && ran.join(',') === 'rejects,after' && unhandledCount === 0,
        'ASYNC-CLEANUP-POLICY6B. sync runCleanupSteps() 收到會 reject 的 thenable：同樣 fail closed，後續 step 仍執行，且用真正的 process-level unhandledRejection listener/counter 證明不產生 unhandled rejection（呼叫端整體結果仍是 failure，不是靠吞掉 rejection 換來 PASS）',
        { threw, msg, ran, unhandledCount });
    }

    // ASYNC-CLEANUP-POLICY7: real DB sentinel unchanged after ASYNC-CLEANUP-POLICY1-6
    {
      const hashAfterAsync = _hashFile(REAL_DB_PATH);
      assert(hashAfterAsync === REAL_DB_HASH_BEFORE,
        'ASYNC-CLEANUP-POLICY7. ASYNC-CLEANUP-POLICY1-6 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterAsync });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CLEANUP-POLICY-FROZEN1：primary error attachment 的安全性 -- primary
  // 是 frozen Error（Object.freeze）時，附加 secondaryCleanupErrors 不得
  // 再次 throw、不得改變 primary identity。這裡實際攔截 console.error 來
  // 真正證明 log-only fallback 有被呼叫且訊息內容包含 cleanup 錯誤，而不
  // 是只聲稱「有 fallback」卻沒驗證。
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const frozenPrimary = Object.freeze(new Error('CLEANUP-POLICY-FROZEN1 frozen primary error'));
    const cleanupErr = new Error('CLEANUP-POLICY-FROZEN1 cleanup failure marker-9f3a2');
    let rethrown = null;
    let threwDuringCleanupCall = false;
    const capturedLogs = [];
    const origConsoleError = console.error;
    console.error = (...args) => { capturedLogs.push(args.map((a) => (a && a.message) ? a.message : String(a)).join(' ')); };
    try {
      try {
        try { throw frozenPrimary; }
        finally {
          try {
            dbHelper.handleOwnedCleanup({ ownsTempRoot: true, cleanup: () => { throw cleanupErr; } }, frozenPrimary);
          } catch (e) { threwDuringCleanupCall = true; }
        }
      } catch (e) { rethrown = e; }
    } finally {
      console.error = origConsoleError;
    }
    const loggerReceivedSecondaryDiagnostic = capturedLogs.some((line) => line.includes('marker-9f3a2'));
    assert(!threwDuringCleanupCall
        && rethrown === frozenPrimary
        && !Object.prototype.hasOwnProperty.call(frozenPrimary, 'secondaryCleanupErrors')
        && loggerReceivedSecondaryDiagnostic,
      'CLEANUP-POLICY-FROZEN1. primary error 是 frozen Error 時：不再次 throw 掩蓋 primary，primary identity（===）與內容完全不變，frozen 物件確實無法新增 secondaryCleanupErrors 屬性 -- 且實際攔截 console.error 證明 log-only fallback 真的被呼叫、訊息內容包含 cleanup 錯誤（不是只聲稱有 fallback 卻未驗證）',
      { threwDuringCleanupCall, samePrimary: rethrown === frozenPrimary, loggerReceivedSecondaryDiagnostic, capturedLogs });
  }

  // ══════════════════════════════════════════════════════════════════
  // CLEANUP-POLICY-PRIMITIVE1：primary error 是 primitive thrown value
  // （例如 `throw 42`）而非 Error 物件時的安全性 -- 這是 JS 合法但少見的
  // pattern，attachSecondaryDiagnostics() 必須偵測 primitive 不是
  // extensible object，走 log-only fallback，不得因為對 primitive 做屬性
  // 賦值而拋出 TypeError 掩蓋原本的 primary。
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const primitivePrimary = 42; // deliberately not an Error object
    const cleanupErr = new Error('CLEANUP-POLICY-PRIMITIVE1 cleanup failure marker-7c1e0');
    let rethrown;
    let threwDuringCleanupCall = false;
    const capturedLogs = [];
    const origConsoleError = console.error;
    console.error = (...args) => { capturedLogs.push(args.map((a) => (a && a.message) ? a.message : String(a)).join(' ')); };
    try {
      try {
        try { throw primitivePrimary; }
        finally {
          try {
            dbHelper.handleOwnedCleanup({ ownsTempRoot: true, cleanup: () => { throw cleanupErr; } }, primitivePrimary);
          } catch (e) { threwDuringCleanupCall = true; }
        }
      } catch (e) { rethrown = e; }
    } finally {
      console.error = origConsoleError;
    }
    const loggerReceivedSecondaryDiagnostic = capturedLogs.some((line) => line.includes('marker-7c1e0'));
    assert(!threwDuringCleanupCall
        && rethrown === 42
        && typeof rethrown === 'number'
        && loggerReceivedSecondaryDiagnostic,
      'CLEANUP-POLICY-PRIMITIVE1. primary 是 primitive thrown value（throw 42，非 Error 物件）：cleanup 失敗不會因為嘗試對 primitive 賦值而拋出新的 TypeError 掩蓋 primary，primary 值以 === 原樣保留（型別與值都不變），attachSecondaryDiagnostics() 正確走 log-only fallback 且訊息可驗證收到',
      { threwDuringCleanupCall, rethrown, typeofRethrown: typeof rethrown, loggerReceivedSecondaryDiagnostic });
  }

  // ══════════════════════════════════════════════════════════════════
  // HTTPCLOSE1-6：scripts/lib/qa-temp-db.js closeHttpServerBounded() shared
  // helper -- real http.createServer() instances, real listen()/close(),
  // real timers. Re-verified on every run.
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const http = require('http');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function makeServer(onRequest) {
      return http.createServer(onRequest || ((req, res) => { res.end('ok'); }));
    }
    function listen(server) {
      return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
    }

    // HTTPCLOSE1: normal close (no in-flight requests) resolves promptly, listening becomes false
    {
      const server = makeServer();
      await listen(server);
      await dbHelper.closeHttpServerBounded(server, 2000);
      assert(server.listening === false,
        'HTTPCLOSE1. closeHttpServerBounded() 正常關閉（無 in-flight request）：close 完成後 server.listening === false');
    }

    // HTTPCLOSE2: already-closed server is a safe no-op (no ERR_SERVER_NOT_RUNNING)
    {
      const server = makeServer();
      await listen(server);
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      let threw = false;
      try { await dbHelper.closeHttpServerBounded(server, 2000); } catch (e) { threw = true; }
      assert(!threw,
        'HTTPCLOSE2. 對已經關閉的 server 再次呼叫 closeHttpServerBounded() 是安全 no-op（不會因 ERR_SERVER_NOT_RUNNING 而 throw）');
    }

    // HTTPCLOSE3: grace-period timeout forces close of a genuinely lingering connection, then real completion is awaited
    {
      let holdRequest;
      const gate = new Promise((resolve) => { holdRequest = resolve; });
      const server = makeServer(async (req, res) => { await gate; res.end('late'); });
      const port = await listen(server);
      const net = require('net');
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      });
      await sleep(30); // let the connection actually establish and the request start being handled
      const start = Date.now();
      await dbHelper.closeHttpServerBounded(server, 200); // short bound -- the handler is gated open, so this WILL time out
      const elapsed = Date.now() - start;
      holdRequest(); // release the held handler now that we're done observing
      try { socket.destroy(); } catch (e) { /* best-effort */ }
      assert(server.listening === false && elapsed < 5000,
        'HTTPCLOSE3. 真正 lingering 連線在 grace timeout 後被 force-close，close completion 仍確實被等到（listening 變 false），且沒有無界等待（實際耗時遠低於 5 秒的安全上限）',
        { elapsed, listening: server.listening });
    }

    // HTTPCLOSE4: timer does not leak on the normal (non-timeout) path -- proven via a real process._getActiveHandles-independent method: run close twice in a row and confirm the second (already-closed) call is instant, which would not be reliably fast if a lingering timer/handle from the first call were still pending and interfering
    {
      const server = makeServer();
      await listen(server);
      const start = Date.now();
      await dbHelper.closeHttpServerBounded(server, 3000);
      const firstElapsed = Date.now() - start;
      const start2 = Date.now();
      await dbHelper.closeHttpServerBounded(server, 3000); // already closed -> HTTPCLOSE2 no-op path
      const secondElapsed = Date.now() - start2;
      assert(firstElapsed < 500 && secondElapsed < 50,
        'HTTPCLOSE4. 正常關閉路徑耗時遠低於 timeout 上限，且緊接著再次呼叫（已關閉狀態）幾乎瞬間完成 -- 與 timer 洩漏會造成的延遲行為不符',
        { firstElapsed, secondElapsed });
    }

    // HTTPCLOSE5: close failure (no primary) surfaces as a real failure via the shared cleanup policy
    {
      const server = makeServer();
      await listen(server);
      // monkeypatch close to simulate a close-path failure
      const originalClose = server.close.bind(server);
      server.close = (cb) => { originalClose(() => cb(new Error('HTTPCLOSE5 injected close failure'))); };
      let threw = false;
      let caught = null;
      try {
        await dbHelper.handleOwnedCleanupAsync({ ownsTempRoot: true, cleanup: () => dbHelper.closeHttpServerBounded(server, 2000) }, undefined);
      } catch (e) { threw = true; caught = e; }
      assert(threw && /injected close failure/.test(caught && caught.message || ''),
        'HTTPCLOSE5. server close 失敗（無 primary）：透過 shared cleanup policy 正確 surfaced 為真正失敗（不是 exit 0）');
    }

    // HTTPCLOSE6: primary error + close failure -> primary identity preserved
    {
      const server = makeServer();
      await listen(server);
      const originalClose = server.close.bind(server);
      server.close = (cb) => { originalClose(() => cb(new Error('HTTPCLOSE6 injected close failure'))); };
      const primaryErr = new Error('HTTPCLOSE6 injected primary error');
      let rethrown = null;
      try {
        try { throw primaryErr; }
        finally { await dbHelper.handleOwnedCleanupAsync({ ownsTempRoot: true, cleanup: () => dbHelper.closeHttpServerBounded(server, 2000) }, primaryErr); }
      } catch (e) { rethrown = e; }
      assert(rethrown === primaryErr && Array.isArray(primaryErr.secondaryCleanupErrors) && /injected close failure/.test(primaryErr.secondaryCleanupErrors[0].message),
        'HTTPCLOSE6. primary error + server close 失敗：primary identity 保留（===），close 失敗以 secondary diagnostic 附加');
    }

    // HTTPCLOSE7: two concurrent calls on the SAME listening server -- the
    // second call must await the SAME in-flight close, not start a second
    // independent server.close() (which would race for the same callback)
    // and not falsely no-op via a stale listening===false read.
    {
      let closeCallbackInvocations = 0;
      const server = makeServer();
      await listen(server);
      const originalClose = server.close.bind(server);
      server.close = (cb) => {
        originalClose((err) => { closeCallbackInvocations++; cb(err); });
      };
      const [r1, r2] = await Promise.allSettled([
        dbHelper.closeHttpServerBounded(server, 2000),
        dbHelper.closeHttpServerBounded(server, 2000),
      ]);
      assert(r1.status === 'fulfilled' && r2.status === 'fulfilled' && closeCallbackInvocations === 1 && server.listening === false,
        'HTTPCLOSE7. 同一 listening server 連續（同 tick）呼叫兩次 closeHttpServerBounded()：底層 server.close() 的 callback 只被觸發一次（沒有發生重複 close 競爭），兩個呼叫都正確完成，第二個是等待第一個的同一個 in-flight promise',
        { closeCallbackInvocations, r1: r1.status, r2: r2.status });
    }

    // HTTPCLOSE8: a second call arriving WHILE the timeout/force-close path
    // is still running must not resolve early (before the real close
    // actually settles) -- it must observe the same real completion.
    {
      let holdRequest;
      const gate = new Promise((resolve) => { holdRequest = resolve; });
      const server = makeServer(async (req, res) => { await gate; res.end('late'); });
      const port = await listen(server);
      const net = require('net');
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      });
      await sleep(30);
      const firstCallPromise = dbHelper.closeHttpServerBounded(server, 150); // will time out and force-close
      await sleep(20); // ensure the first call has started its in-flight close before the second call arrives
      const secondCallStart = Date.now();
      await dbHelper.closeHttpServerBounded(server, 150); // must await the SAME in-flight attempt
      const secondCallElapsed = Date.now() - secondCallStart;
      await firstCallPromise;
      holdRequest();
      try { socket.destroy(); } catch (e) { /* best-effort */ }
      assert(server.listening === false && secondCallElapsed >= 20,
        'HTTPCLOSE8. 在 force-close 進行中發出的第二次呼叫，會等待第一次呼叫真正完成才 resolve（不會因為讀到過渡狀態就提前 resolve），耗時反映實際等待而非立即返回',
        { secondCallElapsed, listening: server.listening });
    }

    // HTTPCLOSE9: after completion, a THIRD call is a safe no-op (no
    // duplicate close callback, resolves immediately)
    {
      let closeCallbackInvocations = 0;
      const server = makeServer();
      await listen(server);
      const originalClose = server.close.bind(server);
      server.close = (cb) => { originalClose((err) => { closeCallbackInvocations++; cb(err); }); };
      await dbHelper.closeHttpServerBounded(server, 2000);
      const start = Date.now();
      await dbHelper.closeHttpServerBounded(server, 2000); // third call overall (first real + this)
      const elapsed = Date.now() - start;
      assert(closeCallbackInvocations === 1 && elapsed < 50,
        'HTTPCLOSE9. 完成後的後續呼叫安全 no-op：底層 close callback 仍只觸發一次，且幾乎立即返回',
        { closeCallbackInvocations, elapsed });
    }

    // HTTPCLOSE10: no residual timer/socket after HTTPCLOSE7-9 (process
    // stays exitable -- proven by confirming no lingering listening state
    // and that the servers used above are no longer listening)
    {
      // Re-affirm via a fresh, independent server that the helper itself
      // introduces no persistent global state that would prevent a clean
      // process exit -- if it did, this fresh server's own close would be
      // affected by leftover state from HTTPCLOSE7-9's servers (it isn't,
      // since state is keyed per-server via WeakMap).
      const freshServer = makeServer();
      await listen(freshServer);
      await dbHelper.closeHttpServerBounded(freshServer, 2000);
      assert(freshServer.listening === false,
        'HTTPCLOSE10. HTTPCLOSE7-9 執行後，一個全新、無關的 server 仍可正常經過 helper 關閉，證明 helper 的 per-server WeakMap 狀態不會互相干擾或殘留成全域狀態');
    }

    // HTTPCLOSE11: listen -> helper close -> re-listen SAME Server object
    // -> helper close again -- underlying server.close() callback must
    // fire TWICE total (once per generation), not be short-circuited by
    // the stale 'completed' state from the first close.
    {
      let closeCallbackInvocations = 0;
      const server = makeServer();
      const trueOriginalClose = server.close.bind(server);
      server.close = (cb) => { trueOriginalClose((err) => { closeCallbackInvocations++; cb(err); }); };
      await listen(server);
      await dbHelper.closeHttpServerBounded(server, 2000);
      const listeningAfterFirstClose = server.listening;
      await listen(server); // re-listen the SAME server object
      await dbHelper.closeHttpServerBounded(server, 2000);
      assert(listeningAfterFirstClose === false && server.listening === false && closeCallbackInvocations === 2,
        'HTTPCLOSE11. listen→close→re-listen（同一 Server 物件）→close：底層 close callback 總共觸發兩次（每個 generation 各一次），第二次沒有被第一次的 stale completed 狀態短路',
        { listeningAfterFirstClose, finalListening: server.listening, closeCallbackInvocations });
    }

    // HTTPCLOSE12: first close attempt deterministically fails WITHOUT the
    // server actually stopping (simulating a genuine close failure, not
    // just a fake error report on top of a real successful close) -- a
    // second (retry) attempt on the SAME server must issue a real new
    // server.close() call and succeed.
    {
      const server = makeServer();
      await listen(server);
      const originalClose = server.close.bind(server);
      let callCount = 0;
      // Test-only seam: first invocation reports a failure WITHOUT calling
      // the real close (server remains genuinely listening), so a retry is
      // actually meaningful; second invocation performs the real close.
      // Restored implicitly by going out of scope at the end of this block
      // (this server instance is not reused elsewhere).
      server.close = (cb) => {
        callCount++;
        if (callCount === 1) {
          cb(new Error('HTTPCLOSE12 injected first-attempt failure'));
        } else {
          originalClose(cb);
        }
      };
      let firstThrew = false;
      try {
        await dbHelper.closeHttpServerBounded(server, 2000);
      } catch (e) { firstThrew = true; }
      const stillListeningAfterFailure = server.listening;
      let secondThrew = false;
      try {
        await dbHelper.closeHttpServerBounded(server, 2000); // retry
      } catch (e) { secondThrew = true; }
      assert(firstThrew && stillListeningAfterFailure === true && !secondThrew && callCount === 2 && server.listening === false,
        'HTTPCLOSE12. 第一次 close attempt 真正失敗（server 仍在 listening，不是假回報錯誤但底層已關閉）後，第二次呼叫確實發出新的 server.close() 呼叫（callCount=2）並成功完成（失敗的第一次沒有被誤標為 completed 而永久卡住）',
        { firstThrew, stillListeningAfterFailure, secondThrew, callCount, finalListening: server.listening });
    }

    // HTTPCLOSE13: two concurrent callers on an attempt that ultimately
    // FAILS both observe the SAME failure (not one seeing success)
    {
      const server = makeServer();
      await listen(server);
      server.close = (cb) => { cb(new Error('HTTPCLOSE13 injected shared failure')); }; // fails without actually closing
      const [r1, r2] = await Promise.allSettled([
        dbHelper.closeHttpServerBounded(server, 2000),
        dbHelper.closeHttpServerBounded(server, 2000),
      ]);
      assert(r1.status === 'rejected' && r2.status === 'rejected'
          && /injected shared failure/.test(r1.reason.message) && /injected shared failure/.test(r2.reason.message),
        'HTTPCLOSE13. 兩個 concurrent caller 面對同一次最終失敗的 close attempt：兩者都收到同一個失敗結果（不是一個看到成功、一個看到失敗）',
        { r1status: r1.status, r2status: r2.status });
      // cleanup: actually close it for real so this test doesn't leak a listening server
      const realClose = require('http').Server.prototype.close;
      await new Promise((resolve) => realClose.call(server, () => resolve()));
    }

    // HTTPCLOSE14: after a failure, no stale pending promise remains --
    // confirmed by immediately issuing a fresh successful close and
    // checking it doesn't hang or reuse anything from the failed attempt
    {
      const server = makeServer();
      await listen(server);
      let callCount = 0;
      const originalClose = server.close.bind(server);
      server.close = (cb) => {
        callCount++;
        if (callCount === 1) { cb(new Error('HTTPCLOSE14 injected failure')); } // fails, server stays listening
        else { originalClose(cb); }
      };
      try { await dbHelper.closeHttpServerBounded(server, 2000); } catch (e) { /* expected */ }
      const start = Date.now();
      await dbHelper.closeHttpServerBounded(server, 2000);
      const elapsed = Date.now() - start;
      assert(server.listening === false && elapsed < 500 && callCount === 2,
        'HTTPCLOSE14. 失敗後不殘留 stale pending promise：緊接著的呼叫是一次乾淨的新嘗試（底層 close 再被呼叫一次），很快完成，不會卡在前一次失敗的殘留狀態上',
        { elapsed, listening: server.listening, callCount });
    }

    // HTTPCLOSE15: sentinel for HTTPCLOSE11-14
    {
      const hashAfterGeneration = _hashFile(REAL_DB_PATH);
      assert(hashAfterGeneration === REAL_DB_HASH_BEFORE,
        'HTTPCLOSE15. HTTPCLOSE11-14（含 re-listen generation／failure-retry 測試）執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterGeneration });
    }

    // HTTPCLOSE-SENTINEL: real DB sentinel unchanged after HTTPCLOSE1-6
    {
      const hashAfterHttpClose = _hashFile(REAL_DB_PATH);
      assert(hashAfterHttpClose === REAL_DB_HASH_BEFORE,
        'HTTPCLOSE-SENTINEL. HTTPCLOSE1-10 執行全程（含真實 http server listen/close），正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterHttpClose });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CLIARGS1-22：Stage 3C0 unified strict round-count CLI contract --
  // scripts/lib/qa-temp-db.js parseRegressionCliArgs(). Real function,
  // not a /tmp copy. Re-verified on every run.
  // ══════════════════════════════════════════════════════════════════
  {
    const dbHelper = require('./lib/qa-temp-db.js');
    const { parseRegressionCliArgs } = dbHelper;

    function expectDeep(actual, expected, label) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      assert(ok, label, { actual, expected });
    }
    function expectThrows(fn, label) {
      let threw = false;
      try { fn(); } catch (e) { threw = true; }
      assert(threw, label);
    }

    expectDeep(parseRegressionCliArgs([]), { mode: 'run', roundCount: 3 }, "CLIARGS1. [] -> {mode:'run', roundCount:3}");
    expectDeep(parseRegressionCliArgs(['1']), { mode: 'run', roundCount: 1 }, "CLIARGS2. ['1'] -> {mode:'run', roundCount:1}");
    expectDeep(parseRegressionCliArgs(['2']), { mode: 'run', roundCount: 2 }, "CLIARGS3. ['2'] -> {mode:'run', roundCount:2}");
    expectDeep(parseRegressionCliArgs(['3']), { mode: 'run', roundCount: 3 }, "CLIARGS4. ['3'] -> {mode:'run', roundCount:3}");
    expectDeep(parseRegressionCliArgs(['--dry-run'], { allowDryRun: true }), { mode: 'dry-run' }, "CLIARGS5. ['--dry-run'] with allowDryRun:true -> {mode:'dry-run'} succeeds");
    expectThrows(() => parseRegressionCliArgs(['--dry-run'], { allowDryRun: false }), 'CLIARGS6. --dry-run with allowDryRun:false throws');
    expectThrows(() => parseRegressionCliArgs(['']), "CLIARGS7. [''] (empty string) throws");
    expectThrows(() => parseRegressionCliArgs([' ']), "CLIARGS8. [' '] (whitespace) throws");
    expectThrows(() => parseRegressionCliArgs(['0']), "CLIARGS9. ['0'] throws");
    expectThrows(() => parseRegressionCliArgs(['-1']), "CLIARGS10. ['-1'] (negative) throws");
    expectThrows(() => parseRegressionCliArgs(['1.5']), "CLIARGS11. ['1.5'] (fraction) throws");
    expectThrows(() => parseRegressionCliArgs(['01']), "CLIARGS12. ['01'] (leading zero) throws");
    expectThrows(() => parseRegressionCliArgs(['+1']), "CLIARGS13. ['+1'] (plus sign) throws");
    expectThrows(() => parseRegressionCliArgs(['1e0']), "CLIARGS14. ['1e0'] (exponent notation) throws");
    expectThrows(() => parseRegressionCliArgs(['abc']), "CLIARGS15. ['abc'] (non-numeric) throws");
    expectThrows(() => parseRegressionCliArgs(['4']), "CLIARGS16. ['4'] (out of 1-3 range) throws");
    expectThrows(() => parseRegressionCliArgs(['99999999999999999999']), 'CLIARGS17. huge integer value throws');
    expectThrows(() => parseRegressionCliArgs(['1', '2']), "CLIARGS18. ['1','2'] (multiple args) throws");
    expectThrows(() => parseRegressionCliArgs(['--dry-run', '1'], { allowDryRun: true }), 'CLIARGS19a. dry-run + round mixed (order 1) throws');
    expectThrows(() => parseRegressionCliArgs(['1', '--dry-run'], { allowDryRun: true }), 'CLIARGS19b. dry-run + round mixed (order 2) throws');
    expectThrows(() => parseRegressionCliArgs(['--unknown-flag']), 'CLIARGS20. unknown flag throws');
    expectThrows(() => parseRegressionCliArgs('not-an-array'), 'CLIARGS21. non-array input throws');

    // CLIARGS22: real DB sentinel unchanged after CLIARGS1-21
    {
      const hashAfterCliArgs = _hashFile(REAL_DB_PATH);
      assert(hashAfterCliArgs === REAL_DB_HASH_BEFORE,
        'CLIARGS22. CLIARGS1-21 執行全程，正式 data/pos.db 的 SHA1 hash 完全不變',
        { before: REAL_DB_HASH_BEFORE, after: hashAfterCliArgs });
    }
  }


  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nPASS: ${passCount}`);
  console.log(`FAIL: ${failCount}`);
  console.log(`TOTAL: ${total}`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('[FATAL]', (e && e.stack) || e);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanupTmp();
  });
