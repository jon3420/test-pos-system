#!/usr/bin/env node
// scripts/run-h1-4-8-ads-canonical-alias-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 驗證 Gate A（Ads canonical／deprecated alias）：
//   - 內部 canonical event = checkout_click
//   - deprecated response alias = begin_checkout（直接引用同一份 checkout_click
//     aggregation 結果，不是第二次查詢／OR／SUM）
//
// 全程呼叫正式 utils/dashboardAnalytics.js getAdsAttribution()（透過
// routes/analytics.js 的真實 GET /api/analytics/dashboard HTTP handler），
// 不在測試內重寫一份 production SQL 或演算法來自我驗證。
//
// 誠實聲明：這是 H1.4.8 Ads Gate 第一次執行，沒有歷史 PASS 紀錄。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-8-ads-'));
const tmpDbPath = path.join(tmpDir, 'test.db');
process.env.POS_DB_PATH = tmpDbPath;

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

// 簡單 deep-equal（不依賴 assert.deepStrictEqual 的 Node 版本差異，也不比較
// object identity——JSON round-trip 前後本來就不會是同一個物件）。
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

// 去除行註解（跟 scripts/static-audit-g1-6-ga4-h1-4-7.js 用的是同一種簡化規則），
// 避免「說明文字裡出現 r.begin_checkout 這幾個字」被誤判成真的程式碼在讀取它。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

async function main() {
  const { initDb } = require('../utils/db');
  const db = await initDb();
  const { getAdsAttribution } = require('../utils/dashboardAnalytics');
  const { resolveDateRange } = require('../utils/dashboardDate');

  // ── 單一時間基準：「昨天」這個 Asia/Taipei 日曆日 ──────────────────
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

  let seq = 0;
  function insertEvent(storeId, eventName, opts = {}) {
    seq += 1;
    const ts = new Date(BASE_UTC_MS + seq);
    const isoNoMs = ts.toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    db.run(
      `INSERT INTO analytics_events
        (store_id, visitor_id, session_id, cart_id, order_id, event_name, product_id, quantity, order_channel, source, medium, campaign, metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId, opts.visitorId || 'visitor_anon', opts.sessionId || 'session_anon',
        (opts.cartId === undefined ? null : opts.cartId), opts.orderId || null, eventName,
        opts.productId || null, opts.quantity || 1, opts.orderChannel || null,
        opts.source || null, opts.medium || null, opts.campaign || null,
        opts.metadata ? JSON.stringify(opts.metadata) : null, isoNoMs,
      ]
    );
  }

  const STORE = 'test_store_h148_ads';

  // ══════════════════════════════════════════════════════════════════
  // 對抗 fixture：canonical checkout_click（event_count=3, unique_users=2,
  // unique_carts=2）＋ 大量舊 begin_checkout（帶假 source/campaign），驗證
  // canonical 結果完全不受影響。
  // ══════════════════════════════════════════════════════════════════
  insertEvent(STORE, 'page_view', { visitorId: 'u1', source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'page_view', { visitorId: 'u2', source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'u1', cartId: 'ads_cart_1', productId: 9301, source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'u2', cartId: 'ads_cart_2', productId: 9301, source: 'facebook', campaign: 'camp_a' });

  // canonical checkout_click：u1 兩次點擊（同一 cart，快速連點），u2 一次 → event_count=3
  insertEvent(STORE, 'checkout_click', { visitorId: 'u1', cartId: 'ads_cart_1', source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'checkout_click', { visitorId: 'u1', cartId: 'ads_cart_1', source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'checkout_click', { visitorId: 'u2', cartId: 'ads_cart_2', source: 'facebook', campaign: 'camp_a' });

  // 第二個真實來源 google，entry（page_view 數）故意比 facebook 少，
  // 用來驗證排序（依 entry 由多到少）與轉換率分母不受任何舊事件影響。
  insertEvent(STORE, 'page_view', { visitorId: 'u3', source: 'google', campaign: 'camp_b' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'u3', cartId: 'ads_cart_3', productId: 9301, source: 'google', campaign: 'camp_b' });
  insertEvent(STORE, 'checkout_click', { visitorId: 'u3', cartId: 'ads_cart_3', source: 'google', campaign: 'camp_b' });
  insertEvent(STORE, 'purchase', { visitorId: 'u3', cartId: 'ads_cart_3', orderId: 'ads_order_3', source: 'google', campaign: 'camp_b' });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['ads_order_3', 'ads_order_3', 'ads_order_3', STORE, '[]', 'cash', 300, 300, 'completed', 'completed', 'google', FIXTURE_LOCAL_TIME]
  );

  insertEvent(STORE, 'submit_order', { visitorId: 'u1', cartId: 'ads_cart_1', orderId: 'ads_order_1', source: 'facebook', campaign: 'camp_a' });
  insertEvent(STORE, 'purchase', { visitorId: 'u1', cartId: 'ads_cart_1', orderId: 'ads_order_1', source: 'facebook', campaign: 'camp_a' });
  db.run(
    `INSERT INTO orders (id, order_number, uuid, store_id, items, payment_method, subtotal, total, status, order_status, source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['ads_order_1', 'ads_order_1', 'ads_order_1', STORE, '[]', 'cash', 500, 500, 'completed', 'completed', 'facebook', FIXTURE_LOCAL_TIME]
  );

  // 舊 begin_checkout：大量、帶假 source/campaign，絕對不能被算進任何 canonical 結果
  for (let i = 0; i < 20; i += 1) {
    insertEvent(STORE, 'begin_checkout', {
      visitorId: `legacy_u${i}`, cartId: `legacy_cart_${i}`,
      source: 'FAKE_LEGACY_SOURCE', campaign: 'FAKE_LEGACY_CAMPAIGN',
    });
  }

  // 只有舊 begin_checkout、沒有 checkout_click 的獨立 store：canonical 與 alias 都應為 0
  const STORE_LEGACY_ONLY = 'test_store_h148_ads_legacy_only';
  insertEvent(STORE_LEGACY_ONLY, 'page_view', { visitorId: 'lo1', source: 'google' });
  insertEvent(STORE_LEGACY_ONLY, 'add_to_cart', { visitorId: 'lo1', cartId: 'lo_cart_1', productId: 9301, source: 'google' });
  for (let i = 0; i < 5; i += 1) {
    insertEvent(STORE_LEGACY_ONLY, 'begin_checkout', { visitorId: `lo_legacy_${i}`, cartId: `lo_legacy_cart_${i}`, source: 'google' });
  }

  // 污染防護：其他 store、其他 channel、日期區間外、空白 cart_id
  insertEvent('other_store_h148_ads', 'add_to_cart', { visitorId: 'other1', cartId: 'other_cart_1', productId: 9301, source: 'facebook' });
  insertEvent('other_store_h148_ads', 'checkout_click', { visitorId: 'other1', cartId: 'other_cart_1', source: 'facebook' });
  {
    const todayIso = new Date(nowMs).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    db.run(
      `INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, event_name, product_id, source, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [STORE, 'outside1', 'session_outside', 'outside_cart_1', 'checkout_click', null, 'facebook', todayIso]
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // 直接呼叫正式 getAdsAttribution()（內部函式驗證，用真實 canonical 數字）
  // ══════════════════════════════════════════════════════════════════
  const adsResult = getAdsAttribution(db, STORE, range);
  console.log('getAdsAttribution(STORE) =', JSON.stringify(adsResult, null, 2));

  const fbSourceRow = adsResult.sources.find((s) => s.source === 'facebook');
  assert(!!fbSourceRow, '1a. Last Touch sources 找得到 facebook 這一列', adsResult.sources);
  assert(fbSourceRow && fbSourceRow.checkout_click === 2,
    '1b. canonical checkout_click（依 source 分組後的 distinct visitor 數）＝2（u1、u2；u1 快速連點兩次仍只算 1 人）——完全由三筆 canonical rows 決定，不受任何 begin_checkout 影響',
    fbSourceRow);
  assert(fbSourceRow && fbSourceRow.begin_checkout === fbSourceRow.checkout_click,
    '2. deprecated begin_checkout response alias 與 canonical checkout_click 數值完全一致（同一份 aggregation 結果）',
    { begin_checkout: fbSourceRow.begin_checkout, checkout_click: fbSourceRow.checkout_click });

  const fbCampaignRow = adsResult.campaigns.find((c) => c.source === 'facebook' && c.campaign === 'camp_a');
  assert(!!fbCampaignRow && fbCampaignRow.checkout_click === 2 && fbCampaignRow.begin_checkout === 2,
    '6a. Campaign 明細（camp_a + facebook）checkout_click=2，begin_checkout alias=2，兩者一致', fbCampaignRow);

  // ══════════════════════════════════════════════════════════════════
  // Last Touch 存在性稽核（需求文件一）：utils/dashboardAnalytics.js
  // getAdsAttribution() 的 mode:'last_touch' 是預設／主要模式——頂層
  // sources／campaigns 就是 lastTouchSources／lastTouchCampaigns 本身，
  // by_mode.last_touch.sources／campaigns 是同一份資料的具名別名（不是
  // 另一次查詢）。這裡明確用具名路徑 by_mode.last_touch.* 驗證，避免
  // 只用頂層欄位名稱含糊帶過「這其實就是 Last Touch」這件事。
  // ══════════════════════════════════════════════════════════════════
  {
    const ltSources = adsResult.by_mode.last_touch.sources;
    const ltFbRow = ltSources.find((s) => s.source === 'facebook');
    const ltGoogleRow = ltSources.find((s) => s.source === 'google');
    assert(deepEqual(ltSources, adsResult.sources),
      'LT1. by_mode.last_touch.sources 與頂層 sources 是同一份 Last Touch 資料（deep-equal）', { lt: ltSources, top: adsResult.sources });
    assert(!!ltFbRow && ltFbRow.checkout_click === 2 && ltFbRow.begin_checkout === 2,
      'LT2. Last Touch：facebook checkout_click canonical=2，begin_checkout alias=2', ltFbRow);
    assert(!!ltGoogleRow && ltGoogleRow.checkout_click === 1 && ltGoogleRow.begin_checkout === 1,
      'LT3. Last Touch：google checkout_click canonical=1，begin_checkout alias=1', ltGoogleRow);
    // 排序（依 entry／page_view 數由多到少）：facebook（entry=2）在 google（entry=1）之前。
    assert(ltSources[0].source === 'facebook' && ltSources[1].source === 'google',
      'LT4. Last Touch 排序：facebook（entry=2）在 google（entry=1）之前，依 entry 由多到少', ltSources.map((s) => ({ source: s.source, entry: s.entry })));
    // 轉換率分母：facebook conversion_rate = purchase/entry = 1/2 = 50；google = 1/1 = 100。
    assert(ltFbRow.conversion_rate === 50, 'LT5. Last Touch：facebook conversion_rate=50（purchase=1／entry=2）', ltFbRow.conversion_rate);
    assert(ltGoogleRow.conversion_rate === 100, 'LT6. Last Touch：google conversion_rate=100（purchase=1／entry=1）', ltGoogleRow.conversion_rate);
  }

  const fbFirstTouchRow = adsResult.by_mode.first_touch.sources
    ? adsResult.by_mode.first_touch.sources.find((s) => s.source === 'facebook')
    : null;
  // First Touch 資料需要 metadata_json.first_touch，本 fixture 沒有寫入這個欄位，
  // 所以 first_touch_available 應為 false（誠實反映沒有資料，不是錯誤）；
  // 這裡驗證的重點是：即使 first_touch_available=false，也不會因為 begin_checkout
  // 污染而產生假的 first-touch checkout 數字。
  assert(adsResult.first_touch_available === false,
    '6b. 本 fixture 沒有寫入 metadata_json.first_touch，first_touch_available 誠實回報 false（不假裝有資料）', adsResult.first_touch_available);
  assert(adsResult.by_mode.first_touch.insufficient_data === true && adsResult.by_mode.first_touch.sources.length === 0,
    '6c. First Touch 在沒有資料時回傳 insufficient_data=true、sources 空陣列（不是拿 begin_checkout 湊數字）', adsResult.by_mode.first_touch);

  // ── 3. 增加任意數量的舊 begin_checkout rows 後，canonical 與 alias 完全不變 ──
  for (let i = 20; i < 40; i += 1) {
    insertEvent(STORE, 'begin_checkout', {
      visitorId: `legacy_u${i}`, cartId: `legacy_cart_${i}`,
      source: 'FAKE_LEGACY_SOURCE', campaign: 'FAKE_LEGACY_CAMPAIGN',
    });
  }
  const adsResultAfterMoreLegacy = getAdsAttribution(db, STORE, range);
  const fbSourceRowAfter = adsResultAfterMoreLegacy.sources.find((s) => s.source === 'facebook');
  assert(fbSourceRowAfter.checkout_click === 2 && fbSourceRowAfter.begin_checkout === 2,
    '3. 增加另外 20 筆舊 begin_checkout rows 後，canonical checkout_click 與 alias 依然是 2（完全不變）', fbSourceRowAfter);
  assert(deepEqual(fbSourceRow, fbSourceRowAfter),
    '3b. facebook 這一列在增加更多舊 begin_checkout 後，整列（所有欄位）deep-equal 完全相同', { before: fbSourceRow, after: fbSourceRowAfter });
  // 假來源 FAKE_LEGACY_SOURCE／FAKE_LEGACY_CAMPAIGN 不得出現在任何 attribution row
  assert(!adsResultAfterMoreLegacy.sources.find((s) => s.source === 'FAKE_LEGACY_SOURCE'),
    '7a. 舊 begin_checkout 帶的假 source（FAKE_LEGACY_SOURCE）不得產生任何 attribution row', adsResultAfterMoreLegacy.sources.map((s) => s.source));
  assert(!adsResultAfterMoreLegacy.campaigns.find((c) => c.campaign === 'FAKE_LEGACY_CAMPAIGN'),
    '7b. 舊 begin_checkout 帶的假 campaign（FAKE_LEGACY_CAMPAIGN）不得產生任何 attribution row', adsResultAfterMoreLegacy.campaigns.map((c) => c.campaign));
  assert(adsResultAfterMoreLegacy.sources[0].source === fbSourceRowAfter.source,
    '7c. 假 source 沒有擠進排序（sources 陣列第一名仍是 facebook，不是被假資料撐大 entry 數）', adsResultAfterMoreLegacy.sources.map((s) => ({ source: s.source, entry: s.entry })));

  // Last Touch 在污染之後：排序、分母（entry）、轉換率全部不變。
  {
    const ltAfter = adsResultAfterMoreLegacy.by_mode.last_touch.sources;
    assert(ltAfter[0].source === 'facebook' && ltAfter[1].source === 'google',
      'LT7. 增加 20 筆假 begin_checkout 後，Last Touch 排序仍是 facebook 在前、google 在後（不變）', ltAfter.map((s) => s.source));
    const ltFbAfter = ltAfter.find((s) => s.source === 'facebook');
    const ltGoogleAfter = ltAfter.find((s) => s.source === 'google');
    assert(ltFbAfter.entry === 2 && ltFbAfter.conversion_rate === 50,
      'LT8. Last Touch facebook：entry（分母）仍是 2，conversion_rate 仍是 50（沒有被假 page_view 灌水）', ltFbAfter);
    assert(ltGoogleAfter.entry === 1 && ltGoogleAfter.conversion_rate === 100,
      'LT9. Last Touch google：entry（分母）仍是 1，conversion_rate 仍是 100', ltGoogleAfter);
    assert(!ltAfter.find((s) => s.source === 'FAKE_LEGACY_SOURCE'),
      'LT10. Last Touch 結果裡沒有任何 FAKE_LEGACY_SOURCE 列', ltAfter.map((s) => s.source));
  }

  // ── 4. 只有舊 begin_checkout、沒有 checkout_click：canonical 與 alias 都是 0 ──
  const legacyOnlyResult = getAdsAttribution(db, STORE_LEGACY_ONLY, range);
  const googleRow = legacyOnlyResult.sources.find((s) => s.source === 'google');
  assert(!!googleRow, '4a. 只有舊事件的 store 仍能看到 google 這個 source（因為有 add_to_cart）', legacyOnlyResult.sources);
  assert(googleRow.checkout_click === 0 && googleRow.begin_checkout === 0,
    '4b. 只有舊 begin_checkout、沒有 checkout_click 時：canonical checkout_click=0，deprecated alias=0（不是把舊事件算回來）', googleRow);

  // ── 8. 其他 store／channel／日期區間外全部排除（已透過上面 fixture 隔離，
  // 這裡明確驗證數字沒有被污染）──────────────────────────────────────
  assert(fbSourceRow.checkout_click === 2,
    '8. 其他 store（other_store_h148_ads）、日期區間外（outside_cart_1）事件都沒有污染 STORE 的 facebook checkout_click（仍是 2，不是 3 或 4）', fbSourceRow);

  // ══════════════════════════════════════════════════════════════════
  // 5. 同一 canonical cart 重複點擊（ads_cart_1 兩次 checkout_click）：
  // event_count／unique_users／unique_carts 各自依正式定義計算，不得偷換。
  // ══════════════════════════════════════════════════════════════════
  {
    const evtCount = (db.get(
      `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND event_name='checkout_click' AND source='facebook' AND created_at BETWEEN ? AND ?`,
      [STORE, new Date(BASE_UTC_MS - 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0], new Date(BASE_UTC_MS + 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    ) || {}).c;
    const uniqUsers = (db.get(
      `SELECT COUNT(DISTINCT visitor_id) c FROM analytics_events WHERE store_id=? AND event_name='checkout_click' AND source='facebook' AND created_at BETWEEN ? AND ?`,
      [STORE, new Date(BASE_UTC_MS - 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0], new Date(BASE_UTC_MS + 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    ) || {}).c;
    const uniqCarts = (db.get(
      `SELECT COUNT(DISTINCT cart_id) c FROM analytics_events WHERE store_id=? AND event_name='checkout_click' AND source='facebook' AND cart_id IS NOT NULL AND TRIM(cart_id)!='' AND created_at BETWEEN ? AND ?`,
      [STORE, new Date(BASE_UTC_MS - 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0], new Date(BASE_UTC_MS + 3600000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0]]
    ) || {}).c;
    assert(evtCount === 3, '5a. checkout_click event_count=3（原始事件筆數，快速連點確實計 2 筆）', evtCount);
    assert(uniqUsers === 2, '5b. checkout_click unique_users=2（u1、u2；u1 快速連點只算 1 人）', uniqUsers);
    assert(uniqCarts === 2, '5c. checkout_click unique_carts=2（ads_cart_1、ads_cart_2）', uniqCarts);
    // getAdsAttribution() 的 sources 表用的是 distinct visitor（AD_SOURCE_STAGE_EVENTS 裡
    // checkout_click 對應 distinctCol='visitor_id'），所以 fbSourceRow.checkout_click（=2）
    // 對應的正是 unique_users，不是 event_count，也不是 unique_carts——三個數字不會被
    // 誤植成同一個。
    assert(fbSourceRow.checkout_click === uniqUsers && fbSourceRow.checkout_click !== evtCount,
      '5d. getAdsAttribution() sources 表的 checkout_click 欄位對應 unique_users（=2），不是 event_count（=3），三種口徑沒有被偷換成同一數字', { sourcesValue: fbSourceRow.checkout_click, evtCount, uniqUsers, uniqCarts });
  }

  // ══════════════════════════════════════════════════════════════════
  // 9/10 — 真實 HTTP Route：/api/analytics/dashboard 的 ads_attribution
  // 保留 begin_checkout alias；第一方 UI 原始碼不讀它；canonical 缺失時
  // UI 安全顯示 0，不出現 undefined/NaN。
  // ══════════════════════════════════════════════════════════════════
  {
    const express = require('express');
    const bodyParser = require('body-parser');
    const { requireStore } = require('../middleware/storeGuard');
    const analyticsRouter = require('../routes/analytics');

    const HTTP_STORE = 'test_store_h148_ads_http';
    db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [HTTP_STORE, 'Ads HTTP 測試店']);
    insertEvent(HTTP_STORE, 'page_view', { visitorId: 'hv1', source: 'instagram' });
    insertEvent(HTTP_STORE, 'add_to_cart', { visitorId: 'hv1', cartId: 'h_cart_1', productId: 9301, source: 'instagram' });
    insertEvent(HTTP_STORE, 'checkout_click', { visitorId: 'hv1', cartId: 'h_cart_1', source: 'instagram' });
    insertEvent(HTTP_STORE, 'begin_checkout', { visitorId: 'h_legacy1', cartId: 'h_legacy_cart_1', source: 'FAKE_HTTP_LEGACY' });

    const app = express();
    app.use(bodyParser.json());
    app.use('/api/analytics', requireStore, analyticsRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const httpRes = await fetch(`${base}/api/analytics/dashboard?store_id=${encodeURIComponent(HTTP_STORE)}&preset=yesterday`);
    const httpJson = await httpRes.json();
    console.log('HTTP /dashboard ads_attribution =', JSON.stringify(httpJson.ads_attribution, null, 2));

    assert(httpRes.status === 200, '9a. GET /api/analytics/dashboard 回應 200', httpRes.status);
    const httpFbRow = httpJson.ads_attribution && httpJson.ads_attribution.sources
      ? httpJson.ads_attribution.sources.find((s) => s.source === 'instagram') : null;
    assert(!!httpFbRow, '9b. HTTP response ads_attribution.sources 找得到 instagram', httpJson.ads_attribution);
    assert(httpFbRow && httpFbRow.checkout_click === 1 && httpFbRow.begin_checkout === 1,
      '9c. HTTP response 裡 checkout_click canonical 與 begin_checkout deprecated alias 一致（deep equality，非 object identity——經過 JSON 序列化後仍必須數值相等）', httpFbRow);
    assert(!httpJson.ads_attribution.sources.find((s) => s.source === 'FAKE_HTTP_LEGACY'),
      '9d. HTTP response 裡舊 begin_checkout 的假 source 沒有出現在任何 attribution row', httpJson.ads_attribution.sources.map((s) => s.source));

    server.close();
  }

  // ── 第一方 UI 原始碼不讀 begin_checkout alias（靜態原始碼檢查）──────
  {
    const appJsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const sourceTableFnMatch = appJsSrc.match(/function _adsSourceTableHtml\(rows\)[\s\S]*?\n}\n/);
    const campaignTableFnMatch = appJsSrc.match(/function _adsCampaignTableHtml\(rows\)[\s\S]*?\n}\n/);
    assert(!!sourceTableFnMatch, '9e. 在 app.js 找到 _adsSourceTableHtml() 函式區塊', !!sourceTableFnMatch);
    assert(!!campaignTableFnMatch, '9f. 在 app.js 找到 _adsCampaignTableHtml() 函式區塊', !!campaignTableFnMatch);
    if (sourceTableFnMatch) {
      const codeOnly = stripLineComments(sourceTableFnMatch[0]);
      assert(!/r\.begin_checkout\b/.test(codeOnly), '9g. _adsSourceTableHtml() 不讀取 r.begin_checkout（第一方 UI 只讀 canonical checkout_click；已排除純註解文字提及）', codeOnly.includes('r.begin_checkout'));
      assert(/r\.checkout_click/.test(codeOnly), '9h. _adsSourceTableHtml() 讀取 r.checkout_click（canonical）', codeOnly.includes('r.checkout_click'));
      assert(/前往結帳/.test(sourceTableFnMatch[0]), '9i. _adsSourceTableHtml() 畫面文字包含「前往結帳」', sourceTableFnMatch[0].includes('前往結帳'));
    }
    if (campaignTableFnMatch) {
      const codeOnlyCamp = stripLineComments(campaignTableFnMatch[0]);
      assert(!/r\.begin_checkout\b/.test(codeOnlyCamp), '9j. _adsCampaignTableHtml() 不讀取 r.begin_checkout（已排除純註解文字提及）', codeOnlyCamp.includes('r.begin_checkout'));
      assert(/r\.checkout_click/.test(codeOnlyCamp), '9k. _adsCampaignTableHtml() 讀取 r.checkout_click（canonical）', codeOnlyCamp.includes('r.checkout_click'));
    }
  }

  // ── 10. canonical 欄位缺失時 UI 顯示 0，不得出現 undefined/NaN ────────
  {
    const missingRow = { source: 'x', entry: 5 }; // 沒有 checkout_click 欄位
    const rendered = `${missingRow.checkout_click || '—'}`;
    assert(rendered === '—', '10. r.checkout_click 缺失時，畫面模板 "${r.checkout_click || \'—\'}" 渲染為 "—"（不是 "undefined" 或 "NaN"，跟 app.js 實際模板寫法一致）', rendered);
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
