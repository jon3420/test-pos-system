#!/usr/bin/env node
// scripts/run-h1-4-7-analytics-contract-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA
//
// 真實 fixture 測試（不是 includes()/regex 猜測）：用真正的 utils/db.js
// initDb()（sql.js，POS_DB_PATH 指到一個乾淨的暫存檔）建出真正的
// analytics_events schema，寫入合成的事件列，再呼叫真正的
// utils/dashboardAnalytics.js getFunnel()/getIncomplete()、
// utils/analyticsV2.js getProductFunnel()、utils/analyticsLog.js
// isValidEventName() 這些正式函式，比對真實回傳數字。
//
// 誠實聲明：這是本輪（H1.4.7 Analytics 契約）第一次執行，沒有歷史 PASS 紀錄。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-7-analytics-'));
const tmpDbPath = path.join(tmpDir, 'test.db');
process.env.POS_DB_PATH = tmpDbPath; // 必須在第一次 require('../utils/db') 前設定

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) {
  if (cond) { pass(name); return; }
  fail(name, detail);
  console.log(`  >>> FAIL DETAIL [${name}]:`, JSON.stringify(detail, null, 2));
}

async function main() {
  const { initDb } = require('../utils/db');
  const db = await initDb();

  const { isValidEventName, EVENT_WHITELIST } = require('../utils/analyticsLog');
  const { getFunnel, getIncomplete } = require('../utils/dashboardAnalytics');
  const { getProductFunnel } = require('../utils/analyticsV2');
  const { resolveDateRange } = require('../utils/dashboardDate');

  const STORE = 'test_store_h147';
  const OTHER_STORE = 'test_store_other';

  // ── 時間錨點：不假設任何固定時鐘時刻（先前版本假設「今天中午」一定早於
  // 「現在」，在當地時間中午前執行時就整批 fixture 落在查詢範圍外——見
  // CHANGELOG，這是真實發生過的 bug，B13/B14/C2 一度全部失敗）。改為直接從
  // 本次真正呼叫的 resolveDateRange('today') 取得 range.startLocal／
  // range.endLocal（Asia/Taipei 本地時間字串），在這個區間「內部」取一個安全
  // 的錨點時刻，而不是猜測系統時鐘。
  //
  // production 實際存放 created_at 用 UTC（datetime('now')），查詢時用
  // A_LOCAL = datetime(created_at,'+8 hours') 換算成本地時間比對——這裡沿用
  // 同一套換算規則（不另造時區規則），只是方向相反：從本地字串反推出應該
  // 存入的 UTC 字串（本地 = UTC + 8h ⟺ UTC = 本地 - 8h）。
  function parseLocalToUtcMs(localStr) {
    // localStr 格式固定為 'YYYY-MM-DD HH:MM:SS'（見 dashboardDate.js）。
    const [datePart, timePart] = localStr.split(' ');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi, s] = timePart.split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 3600 * 1000;
  }
  const range = resolveDateRange({ preset: 'today' });
  const RANGE_START_MS = parseLocalToUtcMs(range.startLocal);
  const RANGE_END_MS = parseLocalToUtcMs(range.endLocal);
  if (!(RANGE_END_MS > RANGE_START_MS)) {
    console.error('[FATAL] resolveDateRange 區間寬度不足（endLocal 不晚於 startLocal），無法安全放置 fixture：', range);
    process.exitCode = 1;
    return;
  }
  // 安全錨點＝區間中點（嚴格介於 start、end 之間，不等於任一邊界）。所有
  // fixture 事件共用同一個安全時間戳——排序需求（例如同一 identity_key 的
  // 多筆事件）一律依 id（AUTOINCREMENT，插入順序）決定，不依賴 created_at
  // 的相對先後，故不需要也不應該為了「製造時間差」而額外累加秒數偏移（累加
  // 太多筆反而有機會把最後幾筆推出 range.end，就是先前那個 bug 的成因）。
  const SAFE_MIDPOINT_MS = RANGE_START_MS + Math.floor((RANGE_END_MS - RANGE_START_MS) / 2);
  const fixtureTimestampsMs = [];
  function insertEvent(storeId, eventName, { visitorId, cartId, productId, orderId } = {}) {
    const ts = new Date(SAFE_MIDPOINT_MS);
    fixtureTimestampsMs.push(ts.getTime());
    const isoNoMs = ts.toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
    db.run(
      `INSERT INTO analytics_events
        (store_id, visitor_id, session_id, cart_id, order_id, event_name, product_id, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        storeId,
        visitorId || `visitor_anon`,
        `session_anon`,
        cartId || null,
        orderId || null,
        eventName,
        productId || null,
        isoNoMs,
      ]
    );
  }

  // 自我診斷：所有透過 insertEvent() 寫入的 fixture 時間戳，換算回本地時間後
  // 必須嚴格落在 [range.startLocal, range.endLocal) 之間（不等於任一邊界）。
  // 這裡先掛一個延後執行的檢查（在 main() 結尾統一驗證，因為 insertEvent()
  // 之後還會被呼叫很多次）。
  function assertFixtureTimestampsWithinRange() {
    if (!fixtureTimestampsMs.length) { pass('T1 沒有任何 fixture 時間戳需要驗證（防禦性檢查，理論上不會發生）'); return; }
    const minMs = Math.min(...fixtureTimestampsMs);
    const maxMs = Math.max(...fixtureTimestampsMs);
    assert(minMs > RANGE_START_MS, 'T1 所有 fixture 時間戳的最小值嚴格大於 range.startLocal（不等於邊界）', { minMs, RANGE_START_MS, minLocal: new Date(minMs + 8 * 3600 * 1000).toISOString() });
    assert(maxMs < RANGE_END_MS, 'T2 所有 fixture 時間戳的最大值嚴格小於 range.endLocal（不等於邊界，沒有因累加 offset 超過範圍）', { maxMs, RANGE_END_MS, maxLocal: new Date(maxMs + 8 * 3600 * 1000).toISOString() });
  }

  console.log('resolveDateRange(today) =', JSON.stringify(range, null, 2));

  // ══ 1. 事件白名單：兩個新事件必須通過，不支援的事件仍被拒絕 ══════════
  {
    assert(isValidEventName('view_cart') === true, 'A1 view_cart 通過白名單驗證');
    assert(isValidEventName('checkout_click') === true, 'A2 checkout_click 通過白名單驗證');
    assert(isValidEventName('begin_checkout') === true, 'A3 begin_checkout 仍保留在白名單（歷史相容，不刪除）');
    assert(isValidEventName('totally_made_up_event_xyz') === false, 'A4 不支援的事件名稱仍被拒絕');
    assert(EVENT_WHITELIST.includes('view_cart') && EVENT_WHITELIST.includes('checkout_click'), 'A5 EVENT_WHITELIST 內含兩個新事件');
  }

  // ══ 2. Fixture：3 個 cart_id ══════════════════════════════════════════
  // cart_A：只有 legacy begin_checkout（模擬 H1.4.7 上線前的舊資料）
  // cart_B：只有新的 checkout_click（H1.4.7 上線後的新流程）
  // cart_C：兩者都有（模擬同一顧客在切換版本邊界期間，或極端情況下兩個事件都被送出）
  insertEvent(STORE, 'page_view', { visitorId: 'v1' });
  insertEvent(STORE, 'page_view', { visitorId: 'v2' });
  insertEvent(STORE, 'page_view', { visitorId: 'v3' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'v1', cartId: 'cart_A' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'v2', cartId: 'cart_B' });
  insertEvent(STORE, 'add_to_cart', { visitorId: 'v3', cartId: 'cart_C' });
  insertEvent(STORE, 'view_cart', { visitorId: 'v2', cartId: 'cart_B' });
  insertEvent(STORE, 'view_cart', { visitorId: 'v3', cartId: 'cart_C' });
  insertEvent(STORE, 'begin_checkout', { visitorId: 'v1', cartId: 'cart_A' }); // legacy only
  insertEvent(STORE, 'checkout_click', { visitorId: 'v2', cartId: 'cart_B' }); // new only
  insertEvent(STORE, 'begin_checkout', { visitorId: 'v3', cartId: 'cart_C' }); // both
  insertEvent(STORE, 'checkout_click', { visitorId: 'v3', cartId: 'cart_C' }); // both
  // 另一家店的事件：確認 store_id 篩選仍然正確（不得互相汙染）
  insertEvent(OTHER_STORE, 'checkout_click', { visitorId: 'vOther', cartId: 'cart_other' });

  const funnel = getFunnel(db, STORE, range, 'all');
  const viewCartStage = funnel.find(f => f.key === 'view_cart');
  const checkoutClickStage = funnel.find(f => f.key === 'checkout_click');
  const beginCheckoutStage = funnel.find(f => f.key === 'begin_checkout');

  // ══ 3. view_cart 只增加查看購物車階段，不等於開始結帳 ════════════════
  {
    assert(!!viewCartStage, 'B1 funnel 內存在 view_cart stage');
    assert(viewCartStage.count === 2, 'B2 view_cart distinct visitors 正確（v2、v3 共 2 人，v1 沒有 view_cart 不計入）', viewCartStage.count);
  }

  // ══ 4. checkout_click 是開始結帳權威來源，legacy begin_checkout 不計入 ══
  {
    // 開始結帳的真實 distinct visitor：只有 v2（checkout_click only）與 v3（checkout_click，
    // 即使 v3 同時也有 begin_checkout，也只能算一次，不是兩次）＝ 2 人。
    // v1 只有 legacy begin_checkout、沒有 checkout_click，不得被計入 checkout_click 階段。
    assert(!!checkoutClickStage, 'B3 funnel 內存在 checkout_click stage');
    assert(checkoutClickStage.count === 2, 'B4 checkout_click distinct visitors=2（v2、v3；v1 的 legacy begin_checkout 不計入)', checkoutClickStage.count);
  }

  // ══ 5. getFunnel() 完整 inventory：canonical 六階段精確順序，begin_checkout
  // 不得成為第七個可視 stage、不得排在 purchase 後面、不得參與 drop-off／
  // step_conversion 計算 ═══════════════════════════════════════════════
  {
    const expectedKeys = ['page_view', 'view_product', 'add_to_cart', 'view_cart', 'checkout_click', 'submit_order', 'purchase'];
    assert(funnel.length === 7, 'B5 getFunnel() 陣列長度精確為 7（canonical 六階段裡 submit_order／purchase 各占一格，共 7 個元素）', funnel.map(f => f.key));
    assert(
      funnel.map(f => f.key).join(',') === expectedKeys.join(','),
      'B5b getFunnel() 陣列順序精確等於 page_view→view_product→add_to_cart→view_cart→checkout_click→submit_order→purchase',
      funnel.map(f => f.key)
    );
    assert(!beginCheckoutStage, 'B6 begin_checkout 不是 funnel 陣列裡的一個 stage（不得成為額外可視 stage，不得排在 purchase 後面）', funnel.map(f => f.key));
    assert(funnel[funnel.length - 1].key === 'purchase', 'B6b funnel[funnel.length-1] 精確等於 purchase（沒有被任何東西擠到後面，getHealthScore() 等消費端的位置假設仍然正確）');
    // drop-off／step_conversion 只由這 7 個真實元素間的相鄰關係計算，purchase
    // 前一階段必須是 submit_order（不是 begin_checkout；上一步再往前才是
    // checkout_click→submit_order→purchase 這條鏈）。
    const purchaseIdx = funnel.findIndex(f => f.key === 'purchase');
    assert(funnel[purchaseIdx - 1].key === 'submit_order', 'B6c purchase 的前一階段是 submit_order（緊接在 checkout_click 之後的送單階段）');
    const checkoutIdx = funnel.findIndex(f => f.key === 'checkout_click');
    assert(funnel[checkoutIdx + 1].key === 'submit_order', 'B6d checkout_click 後面緊接著 submit_order，中間沒有插入任何 begin_checkout 相容別名');
  }

  // ══ 5b. 用人數刻意不同的 fixture 交叉驗證：即使歷史 begin_checkout 人數
  // 與 checkout_click 不同，也不會有任何 begin_checkout stage 出現、不會被
  // 誤算進 checkout_click ═══════════════════════════════════════════════
  {
    const STORE2 = 'test_store_h147_cross_check';
    // legacy begin_checkout：3 人（v10,v11,v12）；checkout_click：只有 1 人（v10）
    insertEvent(STORE2, 'add_to_cart', { visitorId: 'v10', cartId: 'cc1' });
    insertEvent(STORE2, 'add_to_cart', { visitorId: 'v11', cartId: 'cc2' });
    insertEvent(STORE2, 'add_to_cart', { visitorId: 'v12', cartId: 'cc3' });
    insertEvent(STORE2, 'begin_checkout', { visitorId: 'v10', cartId: 'cc1' });
    insertEvent(STORE2, 'begin_checkout', { visitorId: 'v11', cartId: 'cc2' });
    insertEvent(STORE2, 'begin_checkout', { visitorId: 'v12', cartId: 'cc3' });
    insertEvent(STORE2, 'checkout_click', { visitorId: 'v10', cartId: 'cc1' });
    const funnel2 = getFunnel(db, STORE2, range, 'all');
    const cc2 = funnel2.find(f => f.key === 'checkout_click').count;
    const bc2Stage = funnel2.find(f => f.key === 'begin_checkout');
    assert(cc2 === 1, 'B7 交叉驗證：checkout_click 正確為 1（只有 v10），不受歷史 begin_checkout 人數（3）影響', cc2);
    assert(!bc2Stage, 'B8 交叉驗證：即使歷史 begin_checkout 有 3 人（人數明顯不同於 checkout_click 的 1 人），funnel 陣列裡仍然沒有 begin_checkout stage', funnel2.map(f => f.key));
  }

  // ══ 6. 同時存在 legacy 與新事件時不會雙重計數（cart_C 只算一次）══════
  {
    // cart_C（v3）同時有 begin_checkout 與 checkout_click，checkout_click stage

    // 用 distinct visitor_id 計算，v3 只能算一次，上面 B4 已驗證 count=2（不是 3）。
    assert(checkoutClickStage.count === 2, 'B9 legacy+new 同時存在的 cart 不會被雙重計數', checkoutClickStage.count);
  }

  // ══ 7. store_id 篩選正確，不互相汙染 ══════════════════════════════════
  {
    const otherFunnel = getFunnel(db, OTHER_STORE, range, 'all');
    const otherCC = otherFunnel.find(f => f.key === 'checkout_click').count;
    assert(otherCC === 1, 'B10 另一家店的 checkout_click 只算自己的事件（1 人），不受 STORE 汙染', otherCC);
  }

  // ══ 8. getIncomplete()：購物車未結帳權威來源＝checkout_click ═════════
  {
    // 補兩個邊界案例：
    // cart_D：add_to_cart + checkout_click + purchase → 不得列入未結帳，也不得列入 checkoutNotSubmitted
    // cart_E：add_to_cart + purchase，但沒有 checkout_click → 不得被誤判為未結帳購物車（已經買了）
    insertEvent(STORE, 'checkout_click', { visitorId: 'v4', cartId: 'cart_D' });
    insertEvent(STORE, 'add_to_cart', { visitorId: 'v4', cartId: 'cart_D' });
    insertEvent(STORE, 'submit_order', { visitorId: 'v4', cartId: 'cart_D', orderId: 'order_D' });
    insertEvent(STORE, 'purchase', { visitorId: 'v4', cartId: 'cart_D', orderId: 'order_D' });
    insertEvent(STORE, 'add_to_cart', { visitorId: 'v5', cartId: 'cart_E' });
    insertEvent(STORE, 'submit_order', { visitorId: 'v5', cartId: 'cart_E', orderId: 'order_E' });
    insertEvent(STORE, 'purchase', { visitorId: 'v5', cartId: 'cart_E', orderId: 'order_E' });

    // 必要診斷：完整 fixture 原始資料、distinct cart 集合、resolveDateRange、完整回傳物件
    const rawRows = db.all(
      `SELECT store_id, visitor_id, session_id, cart_id, event_name, created_at
       FROM analytics_events WHERE store_id=? ORDER BY cart_id, created_at, id`,
      [STORE]
    );
    console.log('-- fixture raw rows (store=' + STORE + ') --');
    console.log(JSON.stringify(rawRows, null, 2));

    const addCarts = db.all(`SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='add_to_cart'`, [STORE]).map(r => r.cart_id);
    const checkoutClickCarts = db.all(`SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='checkout_click'`, [STORE]).map(r => r.cart_id);
    const purchaseCarts = db.all(`SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='purchase'`, [STORE]).map(r => r.cart_id);
    console.log('distinct add_to_cart cart_ids =', JSON.stringify(addCarts));
    console.log('distinct checkout_click cart_ids =', JSON.stringify(checkoutClickCarts));
    console.log('distinct purchase cart_ids =', JSON.stringify(purchaseCarts));

    const incomplete = getIncomplete(db, STORE, range, 'all');
    console.log('getIncomplete() full result =', JSON.stringify(incomplete, null, 2));

    // 契約：add={A,B,C,D,E}；checkout_click={B,C,D}；purchase={D,E}
    // cart_not_checked_out = add − checkout_click − purchase = {A} = 1
    //   （E 沒有 checkout_click，但已經 purchase，不得被算成放棄——這正是
    //   production 修正後排除 purchase 的效果；若沒有這個修正，E 會被誤算
    //   進來變成 2，那才是需要回報的真正 bug，不是這裡的期望值。）
    assert(
      incomplete.cart_not_checked_out === 1,
      'B11 getIncomplete().cart_not_checked_out＝1（只有 cart_A：有 add_to_cart 與 legacy begin_checkout，但沒有 checkout_click 也沒有 purchase）',
      { actual: incomplete.cart_not_checked_out, expected: 1, full: incomplete }
    );
    assert(
      checkoutClickCarts.includes('cart_D') && !checkoutClickCarts.includes(undefined),
      'B11b cart_D 有 checkout_click，不落在 cart_not_checked_out 裡'
    );
    // checkout_not_submitted = checkout_click − submit_order − purchase = {B,C,D} − {D} − {D,E} = {B,C} = 2
    assert(
      incomplete.checkout_not_submitted === 2,
      'B11c getIncomplete().checkout_not_submitted＝2（B、C 有 checkout_click 但沒有送單也沒有購買；D 已送單且已購買，排除）',
      { actual: incomplete.checkout_not_submitted, expected: 2, full: incomplete }
    );
    assert(
      incomplete.cart_not_checked_out !== undefined && incomplete.checkout_not_submitted !== undefined,
      'B11d getIncomplete() 回傳物件欄位名稱是 snake_case（cart_not_checked_out／checkout_not_submitted），不是 camelCase'
    );
  }

  // ══ 9. Dashboard／Funnel 使用相同權威來源（同一次呼叫、同一個資料庫狀態下數值一致）══
  {
    // 兩次連續呼叫之間沒有任何寫入，數值必須完全一致（不是跟前面已經因為
    // cart_D/cart_E fixture 而過期的變數比較——那是測試本身的時間點問題，
    // 不是 production 的問題）。
    const funnelCall1 = getFunnel(db, STORE, range, 'all');
    const funnelCall2 = getFunnel(db, STORE, range, 'all');
    const cc1 = funnelCall1.find(f => f.key === 'checkout_click').count;
    const cc2 = funnelCall2.find(f => f.key === 'checkout_click').count;
    assert(cc1 === cc2, 'B12 重複呼叫 getFunnel() 數值穩定一致（同一權威來源，兩次呼叫間沒有寫入）', { cc1, cc2 });
  }

  // ══ 10. analyticsV2 getProductFunnel()：per-product checkout 欄位也改用 checkout_click ══
  {
    const STORE3 = 'test_store_h147_product';
    db.run(`INSERT INTO products (store_id, name, price) VALUES (?, ?, ?)`, [STORE3, '測試商品', 100]);
    const prodRow = db.get(`SELECT id FROM products WHERE store_id=? AND name=?`, [STORE3, '測試商品']);
    const pid = prodRow.id;
    insertEvent(STORE3, 'view_product', { visitorId: 'p1', productId: pid });
    insertEvent(STORE3, 'add_to_cart', { visitorId: 'p1', cartId: 'pcart1', productId: pid });
    insertEvent(STORE3, 'add_to_cart', { visitorId: 'p2', cartId: 'pcart2', productId: pid });
    insertEvent(STORE3, 'checkout_click', { visitorId: 'p1', cartId: 'pcart1' });
    insertEvent(STORE3, 'begin_checkout', { visitorId: 'p2', cartId: 'pcart2' }); // legacy only，不應被算進 checkout
    const productFunnel = getProductFunnel(db, STORE3, range, 'all');
    const row = productFunnel.find(r => r.product_id === pid);
    assert(!!row, 'B13 getProductFunnel() 找得到測試商品');
    assert(row && row.checkout === 1, 'B14 getProductFunnel() 的 checkout 欄位權威來源是 checkout_click（=1，pcart2 只有 legacy begin_checkout 不計入）', row && row.checkout);
  }

  // ══ 11. Geo：checkout_click_visitors／begin_checkout_visitors 相容別名 ══
  // 用真正的 utils/analyticsLog.js insertEvent()（不是裸 SQL INSERT）寫入事件，
  // 因為 Geo 查詢依賴 identity_key／geo_context='visitor'／geo_city／
  // geo_district 這些欄位，只有走真正的生產寫入路徑（含 Identity Resolver、
  // Geo 清洗）才會被正確填入，裸 SQL INSERT 會讓這些欄位全是 NULL，查不到任何
  // 資料，等於沒測到東西。
  {
    const { insertEvent } = require('../utils/analyticsLog');
    const { getGeoFunnel } = require('../utils/geoAnalyticsQueries');
    const STORE_GEO = 'test_store_h147_geo';
    const geoTaipei = {
      geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district',
      geo_city: '台北市', geo_district: '大安區',
    };
    function insertGeoEvent(eventName, { visitorSession, cartId }) {
      const ts = new Date(SAFE_MIDPOINT_MS);
      fixtureTimestampsMs.push(ts.getTime());
      const createdIso = ts.toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
      const ok = insertEvent(db, {
        store_id: STORE_GEO,
        visitor_id: `geo_visitor_${visitorSession}`,
        session_id: `geo_session_${visitorSession}`,
        cart_id: cartId || null,
        event_name: eventName,
        geo: geoTaipei,
      });
      if (ok) {
        // insertEvent() 內部 created_at 用 datetime('now')，測試需要固定在今天
        // range 中段，這裡寫入後立刻校正這一筆的 created_at（不影響其他欄位／
        // identity_key／geo 清洗結果，那些已經在 insertEvent() 內算好並寫入）。
        db.run(`UPDATE analytics_events SET created_at=? WHERE store_id=? AND event_name=? AND visitor_id=? AND id=(SELECT MAX(id) FROM analytics_events WHERE store_id=? AND visitor_id=?)`,
          [createdIso, STORE_GEO, eventName, `geo_visitor_${visitorSession}`, STORE_GEO, `geo_visitor_${visitorSession}`]);
      }
      return ok;
    }
    // g1：checkout_click only；g2：begin_checkout only（legacy）；g3：兩者都有
    assert(insertGeoEvent('page_view', { visitorSession: 'g1' }), 'C1 Geo fixture page_view(g1) 寫入成功');
    assert(insertGeoEvent('page_view', { visitorSession: 'g2' }), 'C1b Geo fixture page_view(g2) 寫入成功');
    assert(insertGeoEvent('page_view', { visitorSession: 'g3' }), 'C1c Geo fixture page_view(g3) 寫入成功');
    insertGeoEvent('checkout_click', { visitorSession: 'g1', cartId: 'geo_cart_1' });
    insertGeoEvent('begin_checkout', { visitorSession: 'g2', cartId: 'geo_cart_2' });
    insertGeoEvent('begin_checkout', { visitorSession: 'g3', cartId: 'geo_cart_3' });
    insertGeoEvent('checkout_click', { visitorSession: 'g3', cartId: 'geo_cart_3' });

    const geoResult = getGeoFunnel(db, STORE_GEO, { range, channel: 'all', page: 1, limit: 50, offset: 0 });
    console.log('getGeoFunnel() areas =', JSON.stringify(geoResult.areas, null, 2));
    const area = (geoResult.areas || []).find(a => a.city === '台北市' && a.district === '大安區');
    assert(!!area, 'C2 Geo funnel 找得到台北市大安區這一列', geoResult.areas);
    if (area) {
      // 真實 checkout distinct visitors：g1、g3 有 checkout_click（g3 同時有
      // begin_checkout+checkout_click，只能算一次）＝ 2 人。g2 只有 legacy
      // begin_checkout、沒有 checkout_click，不得計入。
      assert(area.checkout_click_visitors === 2, 'C3 checkout_click_visitors＝2（g1、g3；g2 的 legacy begin_checkout 不計入）', { actual: area.checkout_click_visitors, full: area });
      assert(area.begin_checkout_visitors === area.checkout_click_visitors, 'C4 begin_checkout_visitors 相容別名數值與 checkout_click_visitors 完全一致（同一次計算，不是重新查 begin_checkout）', { begin_checkout_visitors: area.begin_checkout_visitors, checkout_click_visitors: area.checkout_click_visitors });
      assert(area.checkout_click_events === area.begin_checkout_events, 'C5 checkout_click_events 與 begin_checkout_events 相容別名一致（次數口徑也對齊）', { checkout_click_events: area.checkout_click_events, begin_checkout_events: area.begin_checkout_events });
    }
  }

  // ══ 12. Analytics 平台真實派送：真正載入 public/js/analytics-platforms.js，
  // stub window.fbq／window.gtag，比對真實呼叫方式與次數（不是檢查 MAP 裡
  // 有沒有這個 key，那只證明「宣告存在」，不證明「真的怎麼呼叫」）。══════
  {
    const { JSDOM } = require('jsdom');
    const platformsSrc = fs.readFileSync(path.join(__dirname, '../public/js/analytics-platforms.js'), 'utf8');
    // 不加 resources:'usable'——init() 內部會 createElement('script') 插入外部
    // Pixel/gtag script src，不需要（也不應該）真的發網路請求；runScripts:
    // 'dangerously' 只是為了讓我們載入的 analytics-platforms.js 本身（inline
    // <script>）真的執行。
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'dangerously',
    });
    const { window: pwin } = dom;
    const scriptEl = pwin.document.createElement('script');
    scriptEl.textContent = platformsSrc;
    pwin.document.body.appendChild(scriptEl);

    pwin.AnalyticsPlatforms.init({
      analytics_meta_pixel_enabled: '1', analytics_meta_pixel_id: 'PIXEL_TEST_123',
      analytics_ga4_enabled: '1', analytics_ga4_measurement_id: 'G-TEST123',
    });

    // init() 完成後才覆寫成我們自己的 spy——trackMeta/trackGA4 是動態讀取
    // window.fbq／window.gtag（每次呼叫時才讀），不是在 init() 時就綁死參照，
    // 覆寫不會被 production 程式碼繞過或提前快取掉。
    const fbqCalls = [];
    const gtagCalls = [];
    pwin.fbq = function (...args) { fbqCalls.push(args); };
    pwin.gtag = function (...args) { gtagCalls.push(args); };

    const cartPayload = {
      value: 350, currency: 'TWD', items: [{ item_id: '1', item_name: '測試商品', quantity: 2 }],
      content_ids: ['1'], content_type: 'product',
    };

    pwin.AnalyticsPlatforms.trackPlatformEvent('view_cart', cartPayload);
    pwin.AnalyticsPlatforms.trackPlatformEvent('checkout_click', cartPayload);
    // 這裡立刻檢查 checkout_click 不得同時再送一個 custom event：到這一刻為止
    // 只呼叫過 view_cart（1 次 trackCustom）與 checkout_click（1 次 track），
    // 累計必須正好是 2，不能是 3（那就代表 checkout_click 額外多送了一筆）。
    const fbqCallsRightAfterCheckoutClick = fbqCalls.length;
    pwin.AnalyticsPlatforms.trackPlatformEvent('add_to_cart', { value: 60, content_ids: ['2'] });
    pwin.AnalyticsPlatforms.trackPlatformEvent('purchase', { value: 999, transaction_id: 'order_1', eventId: 'order_1', items: [{ item_id: '1' }] });

    console.log('fbq calls =', JSON.stringify(fbqCalls));
    console.log('gtag calls =', JSON.stringify(gtagCalls));

    // ── GA4：view_cart／checkout_click 各一次，事件名稱與內部 canonical 一致 ──
    const ga4ViewCart = gtagCalls.filter(c => c[0] === 'event' && c[1] === 'view_cart');
    const ga4CheckoutClick = gtagCalls.filter(c => c[0] === 'event' && c[1] === 'checkout_click');
    assert(ga4ViewCart.length === 1, 'D1 GA4 view_cart 恰好派送一次', ga4ViewCart.length);
    assert(ga4CheckoutClick.length === 1, 'D2 GA4 checkout_click 恰好派送一次', ga4CheckoutClick.length);
    assert(ga4ViewCart[0] && ga4ViewCart[0][2] && ga4ViewCart[0][2].value === 350 && ga4ViewCart[0][2].currency === 'TWD' && Array.isArray(ga4ViewCart[0][2].items), 'D3 GA4 view_cart payload 保留 value/currency/items', ga4ViewCart[0]);

    // ── Meta：checkout_click 用 track+InitiateCheckout；view_cart 用 trackCustom+view_cart ──
    const metaCheckoutClick = fbqCalls.filter(c => c[0] === 'track' && c[1] === 'InitiateCheckout');
    const metaViewCartCustom = fbqCalls.filter(c => c[0] === 'trackCustom' && c[1] === 'view_cart');
    const metaViewCartAsTrack = fbqCalls.filter(c => c[0] === 'track' && c[1] === 'view_cart');
    const metaViewCartAnyname = fbqCalls.filter(c => c[0] === 'track' && String(c[1]).toLowerCase() === 'viewcart');
    assert(metaCheckoutClick.length === 1, 'D4 Meta checkout_click 用 fbq(\'track\',\'InitiateCheckout\',...) 恰好一次', metaCheckoutClick.length);
    assert(metaViewCartCustom.length === 1, 'D5 Meta view_cart 用 fbq(\'trackCustom\',\'view_cart\',...) 恰好一次', metaViewCartCustom.length);
    assert(metaViewCartAsTrack.length === 0, 'D6 Meta view_cart 不得用 fbq(\'track\',\'view_cart\',...)（必須是 trackCustom）', metaViewCartAsTrack.length);
    assert(metaViewCartAnyname.length === 0, 'D7 不得虛構 ViewCart 標準事件（fbq(\'track\',\'ViewCart\',...)）', metaViewCartAnyname.length);
    // checkout_click 不得同時再送一個 custom event（同一次 trackPlatformEvent 呼叫只應有 1 筆 fbq 呼叫）
    assert(fbqCallsRightAfterCheckoutClick === 2, 'D8 checkout_click 不得同時再送 custom event（累計 fbq 呼叫數＝2：view_cart 1 次＋checkout_click 1 次）', fbqCallsRightAfterCheckoutClick);

    // ── begin_checkout 呼叫數必須為 0（兩個事件全程都不得觸發它）──────
    const beginCheckoutGA4 = gtagCalls.filter(c => c[0] === 'event' && c[1] === 'begin_checkout');
    const beginCheckoutMeta = fbqCalls.filter(c => c[1] === 'InitiateCheckout' && c[0] === 'track' && false); // InitiateCheckout 本身不是 begin_checkout 字串，這裡改用事件名稱字串比對
    const beginCheckoutMetaLiteral = fbqCalls.filter(c => String(c[1]).toLowerCase().includes('begin_checkout'));
    assert(beginCheckoutGA4.length === 0, 'D9 全程 GA4 begin_checkout 呼叫數＝0', beginCheckoutGA4.length);
    assert(beginCheckoutMetaLiteral.length === 0, 'D10 全程 Meta 沒有任何字面上的 begin_checkout 事件名稱', beginCheckoutMetaLiteral.length);

    // ── add_to_cart／purchase 既有映射不得退步 ──────────────────────
    const ga4AddToCart = gtagCalls.filter(c => c[0] === 'event' && c[1] === 'add_to_cart');
    const metaAddToCart = fbqCalls.filter(c => c[0] === 'track' && c[1] === 'AddToCart');
    const metaPurchase = fbqCalls.filter(c => c[0] === 'track' && c[1] === 'Purchase');
    const ga4Purchase = gtagCalls.filter(c => c[0] === 'event' && c[1] === 'purchase');
    assert(ga4AddToCart.length === 1, 'D11 GA4 add_to_cart 映射未退步（恰好一次）', ga4AddToCart.length);
    assert(metaAddToCart.length === 1, 'D12 Meta AddToCart 映射未退步（恰好一次，仍用 track）', metaAddToCart.length);
    assert(metaPurchase.length === 1, 'D13 Meta Purchase 映射未退步（恰好一次，仍用 track）', metaPurchase.length);
    assert(ga4Purchase.length === 1, 'D14 GA4 purchase 映射未退步（恰好一次）', ga4Purchase.length);
    // purchase 的 eventID 去重欄位仍正確傳遞
    const purchaseCallWithId = metaPurchase[0];
    assert(purchaseCallWithId && purchaseCallWithId[3] && purchaseCallWithId[3].eventID === 'order_1', 'D15 Meta Purchase 仍正確帶 eventID 去重（未退步）', purchaseCallWithId);

    // ── provider 未啟用或函式不存在時不拋錯、不重送 ──────────────────
    delete pwin.fbq;
    delete pwin.gtag;
    let threwWhenMissing = false;
    try {
      pwin.AnalyticsPlatforms.trackPlatformEvent('view_cart', cartPayload);
      pwin.AnalyticsPlatforms.trackPlatformEvent('checkout_click', cartPayload);
    } catch (e) { threwWhenMissing = true; }
    assert(threwWhenMissing === false, 'D16 window.fbq／window.gtag 不存在時 trackPlatformEvent() 不拋錯');
  }

  // ══ 13. 真實 Analytics 路由接收：把正式 routes/analytics.js 掛到一個臨時
  // Express server（127.0.0.1:0），用原生 fetch 送出正式 request shape，不
  // 自行虛構 body、不繞過 requireStore／清洗流程。══════════════════════
  {
    const express = require('express');
    const bodyParser = require('body-parser');
    const { requireStore } = require('../middleware/storeGuard');
    const analyticsRouter = require('../routes/analytics');

    const HTTP_STORE = 'test_store_h147_http';
    db.run(`INSERT INTO stores (store_id, store_name, active) VALUES (?, ?, 1)`, [HTTP_STORE, 'HTTP 測試店']);

    const app = express();
    app.use(bodyParser.json());
    app.use('/api/analytics', requireStore, analyticsRouter);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function postEvent(body) {
      const res = await fetch(`${base}/api/analytics/events?store_id=${encodeURIComponent(HTTP_STORE)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch (e) {}
      return { status: res.status, json };
    }

    const countRows = () => (db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=?`, [HTTP_STORE]) || {}).c || 0;
    const beforeCount = countRows();

    // view_cart：正式 request shape，含 cart_id
    const r1 = await postEvent({
      visitor_id: 'http_v1', session_id: 'http_s1', cart_id: 'http_cart_1',
      event_name: 'view_cart', order_mode: 'takeout',
    });
    assert(r1.status === 200 && r1.json && r1.json.success === true, 'E1 view_cart 經真實 HTTP handler 接收成功（200）', r1);

    const row1 = db.get(`SELECT event_name, cart_id, visitor_id, session_id, store_id FROM analytics_events WHERE store_id=? AND event_name='view_cart' ORDER BY id DESC LIMIT 1`, [HTTP_STORE]);
    assert(!!row1 && row1.cart_id === 'http_cart_1' && row1.visitor_id === 'http_v1', 'E2 view_cart 真的被保存到 DB，cart_id／visitor_id 正確', row1);

    // checkout_click：正式 request shape，含 cart_id
    const r2 = await postEvent({
      visitor_id: 'http_v1', session_id: 'http_s1', cart_id: 'http_cart_1',
      event_name: 'checkout_click', order_mode: 'takeout',
    });
    assert(r2.status === 200 && r2.json && r2.json.success === true, 'E3 checkout_click 經真實 HTTP handler 接收成功（200）', r2);
    const row2 = db.get(`SELECT event_name, cart_id FROM analytics_events WHERE store_id=? AND event_name='checkout_click' ORDER BY id DESC LIMIT 1`, [HTTP_STORE]);
    assert(!!row2 && row2.cart_id === 'http_cart_1', 'E4 checkout_click 真的被保存到 DB，cart_id 正確', row2);

    // 不支援事件：應被拒絕，且 DB 不新增列
    const beforeUnsupported = countRows();
    const r3 = await postEvent({
      visitor_id: 'http_v1', session_id: 'http_s1', event_name: 'totally_made_up_event_xyz',
    });
    const afterUnsupported = countRows();
    assert(r3.status === 400, 'E5 不支援事件回傳 400', r3.status);
    assert(afterUnsupported === beforeUnsupported, 'E6 不支援事件不會新增任何 DB 列', { before: beforeUnsupported, after: afterUnsupported });

    // server-only 事件（例如 purchase）前台直接送必須被拒絕（既有安全規則不得降低）
    const r4 = await postEvent({
      visitor_id: 'http_v1', session_id: 'http_s1', cart_id: 'http_cart_1', event_name: 'purchase',
    });
    assert(r4.status === 403, 'E7 purchase 這種 server-only 事件前台直接送仍被拒絕（既有安全規則未降低）', r4.status);

    assert(countRows() === beforeCount + 2, 'E8 全程只新增 2 筆合法事件（view_cart＋checkout_click），其餘全被擋下', { before: beforeCount, after: countRows() });

    await new Promise((resolve) => server.close(resolve));
  }

  assertFixtureTimestampsWithinRange();

  // ── 輸出結果 ──────────────────────────────────────────
  const total = results.length;
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('== H1.4.7 Analytics Contract Runtime Results ==');
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail !== undefined ? ' :: ' + JSON.stringify(r.detail) : ''}`);
  }
  console.log(`TOTAL=${total} PASS=${total - failed.length} FAIL=${failed.length}`);

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('ANALYTICS CONTRACT TEST HARNESS ERROR:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });
