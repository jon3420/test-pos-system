#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-5-exposure-runtime.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.5-PRODUCT-EXPOSURE-TO-CART-RATE
//
// 直接呼叫真實的 utils/dashboardAnalytics.js getProductRanking()（不是重寫一份公式來測
// 試自己），搭配 utils/db.js 的 sql.js 檔案資料庫，寫入真實 analytics_events／orders／
// products 資料列後讀回結果比對。
//
// 涵蓋範圍（對應需求文件四「邊界條件」與六「測試要求」）：
//   Category A：view_to_cart_rate 基本公式（1÷1=100、3÷10=30）
//   Category B：曝光為 0 時回傳 null（不得是 0%／NaN%／Infinity%）
//   Category C：加購人數 > 曝光人數時誠實顯示 >100%，不得 Math.min(100, rate) 封頂
//   Category D：已下架商品（products 表已無該筆資料）不報錯，is_delisted 正確
//   Category E：店家隔離（storeId 不同，事件互不干擾）
//   Category F：日期區間（range 外的事件不得計入）
//   Category G：channel filter（?channel= 篩選不退化，沿用既有 _eventChannelWhereClause）
//
// 誠實聲明：這個測試檔第一次執行於本輪（H1.4.5），沒有「之前跑過 8/8」這種歷史——
// 每次執行都是從頭建立乾淨的 sql.js 檔案資料庫、寫入資料、呼叫真實函式、比對結果。

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();

  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const { resolveDateRange } = require(path.join(ROOT, 'utils/dashboardDate'));
  const { getProductRanking, round2 } = require(path.join(ROOT, 'utils/dashboardAnalytics'));

  function ensureProduct(storeId, id, name, price) {
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`,
      [id, storeId, name, '測試', price]);
  }
  function viewProduct(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id, session_id: opts.session_id || (opts.visitor_id + '_s'),
      event_name: 'view_product', product_id: opts.product_id, order_mode: opts.order_mode,
      channel_source: opts.channel_source,
    });
  }
  function addToCart(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id, session_id: opts.session_id || (opts.visitor_id + '_s'),
      cart_id: opts.cart_id || ('cart_' + opts.visitor_id), event_name: 'add_to_cart', product_id: opts.product_id,
      quantity: opts.qty || 1, order_mode: opts.order_mode, channel_source: opts.channel_source,
    });
  }

  function rangeToday() {
    return resolveDateRange({ preset: 'today' });
  }

  // ════════════════════════════════════════════════════════════════
  // Category A：基本公式 — 1÷1=100、3÷10=30
  // ════════════════════════════════════════════════════════════════
  const STORE_A = 'h145_store_a';
  ensureProduct(STORE_A, 20001, '古法冷拌麻油豬心', 120);
  ensureProduct(STORE_A, 20002, '滷味拼盤', 150);

  // 商品 20001：曝光 1 人、加購 1 人 → 100%
  viewProduct(STORE_A, { visitor_id: 'a1', product_id: 20001, order_mode: 'takeout' });
  addToCart(STORE_A, { visitor_id: 'a1', product_id: 20001, order_mode: 'takeout' });

  // 商品 20002：曝光 10 人（v1~v10）、加購 3 人（v1~v3）→ 30%
  for (let i = 1; i <= 10; i += 1) {
    viewProduct(STORE_A, { visitor_id: `a2_v${i}`, product_id: 20002, order_mode: 'takeout' });
  }
  for (let i = 1; i <= 3; i += 1) {
    addToCart(STORE_A, { visitor_id: `a2_v${i}`, product_id: 20002, order_mode: 'takeout' });
  }

  const rankingA = getProductRanking(db, STORE_A, rangeToday(), 'all');
  const p20001 = rankingA.find((p) => p.product_id === 20001);
  const p20002 = rankingA.find((p) => p.product_id === 20002);

  assert(!!p20001, 'Category A: 商品 20001 出現在 getProductRanking() 結果中');
  if (p20001) {
    assert(p20001.view_people === 1, 'Category A: 商品 20001 view_people === 1', `實際 ${p20001.view_people}`);
    assert(p20001.cart_people === 1, 'Category A: 商品 20001 cart_people === 1', `實際 ${p20001.cart_people}`);
    assert(p20001.view_to_cart_rate === 100, 'Category A: 1÷1=100 → view_to_cart_rate === 100', `實際 ${p20001.view_to_cart_rate}`);
  }
  assert(!!p20002, 'Category A: 商品 20002 出現在 getProductRanking() 結果中');
  if (p20002) {
    assert(p20002.view_people === 10, 'Category A: 商品 20002 view_people === 10', `實際 ${p20002.view_people}`);
    assert(p20002.cart_people === 3, 'Category A: 商品 20002 cart_people === 3', `實際 ${p20002.cart_people}`);
    assert(p20002.view_to_cart_rate === round2(3 / 10 * 100), 'Category A: 3÷10=30 → view_to_cart_rate === 30', `實際 ${p20002.view_to_cart_rate}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Category B：曝光為 0 時 view_to_cart_rate 必須是 null（商品有加購但沒有曝光紀錄——
  // 例如舊資料、tracking 啟用前就已加購的邊緣情境）
  // ════════════════════════════════════════════════════════════════
  const STORE_B = 'h145_store_b';
  ensureProduct(STORE_B, 30001, '零曝光商品', 80);
  addToCart(STORE_B, { visitor_id: 'b1', product_id: 30001, order_mode: 'takeout' });

  const rankingB = getProductRanking(db, STORE_B, rangeToday(), 'all');
  const p30001 = rankingB.find((p) => p.product_id === 30001);
  assert(!!p30001, 'Category B: 零曝光商品出現在結果中（因為有加購事件）');
  if (p30001) {
    assert(p30001.view_people === 0, 'Category B: view_people === 0', `實際 ${p30001.view_people}`);
    assert(p30001.view_to_cart_rate === null, 'Category B: 曝光 0 → view_to_cart_rate === null（不是 0、NaN、Infinity）', `實際 ${p30001.view_to_cart_rate}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Category C：加購人數 > 曝光人數 → 誠實顯示 >100%，不得封頂
  //   曝光 1 人、加購 2 人 → 200%
  // ════════════════════════════════════════════════════════════════
  const STORE_C = 'h145_store_c';
  ensureProduct(STORE_C, 40001, '超額加購商品', 60);
  viewProduct(STORE_C, { visitor_id: 'c1', product_id: 40001, order_mode: 'takeout' });
  addToCart(STORE_C, { visitor_id: 'c1', product_id: 40001, order_mode: 'takeout' });
  addToCart(STORE_C, { visitor_id: 'c2', product_id: 40001, order_mode: 'takeout' });

  const rankingC = getProductRanking(db, STORE_C, rangeToday(), 'all');
  const p40001 = rankingC.find((p) => p.product_id === 40001);
  assert(!!p40001, 'Category C: 超額加購商品出現在結果中');
  if (p40001) {
    assert(p40001.view_people === 1, 'Category C: view_people === 1', `實際 ${p40001.view_people}`);
    assert(p40001.cart_people === 2, 'Category C: cart_people === 2', `實際 ${p40001.cart_people}`);
    assert(p40001.view_to_cart_rate === 200, 'Category C: 曝光1/加購2 → view_to_cart_rate === 200（不封頂於 100）', `實際 ${p40001.view_to_cart_rate}`);
    assert(p40001.view_to_cart_rate > 100, 'Category C: view_to_cart_rate 超過 100 沒有被 Math.min(100,...) 篡改');
  }

  // ════════════════════════════════════════════════════════════════
  // Category D：已下架商品（products 表已無該筆資料）不報錯，is_delisted 正確，
  // view_to_cart_rate 仍能正常計算
  // ════════════════════════════════════════════════════════════════
  const STORE_D = 'h145_store_d';
  // 刻意不呼叫 ensureProduct()：模擬商品已從 products 表移除（下架／刪除）
  viewProduct(STORE_D, { visitor_id: 'd1', product_id: 50001, order_mode: 'takeout' });
  addToCart(STORE_D, { visitor_id: 'd1', product_id: 50001, order_mode: 'takeout' });

  let rankingD, thrownD = null;
  try {
    rankingD = getProductRanking(db, STORE_D, rangeToday(), 'all');
  } catch (e) { thrownD = e; }
  assert(!thrownD, 'Category D: 已下架商品呼叫 getProductRanking() 不拋出例外', thrownD ? String(thrownD) : '');
  const p50001 = (rankingD || []).find((p) => p.product_id === 50001);
  assert(!!p50001, 'Category D: 已下架商品仍出現在排行結果中');
  if (p50001) {
    assert(p50001.is_delisted === true, 'Category D: is_delisted === true', `實際 ${p50001.is_delisted}`);
    assert(p50001.view_to_cart_rate === 100, 'Category D: 已下架商品仍正確計算 view_to_cart_rate（1÷1=100）', `實際 ${p50001.view_to_cart_rate}`);
    assert(typeof p50001.product_name === 'string' && /已下架商品/.test(p50001.product_name), 'Category D: product_name 標示已下架', p50001.product_name);
  }

  // ════════════════════════════════════════════════════════════════
  // Category E：店家隔離 — STORE_A 的資料不得洩漏進 STORE_E 的排行結果
  // ════════════════════════════════════════════════════════════════
  const STORE_E = 'h145_store_e';
  ensureProduct(STORE_E, 20001, '同 ID 不同店商品', 999); // 故意用跟 STORE_A 相同的 product_id
  const rankingE = getProductRanking(db, STORE_E, rangeToday(), 'all');
  const p20001InE = rankingE.find((p) => p.product_id === 20001);
  assert(!p20001InE, 'Category E: 店家隔離 — STORE_E 沒有繼承 STORE_A 的曝光／加購事件（不同店資料不得混算）',
    p20001InE ? JSON.stringify(p20001InE) : '');

  // ════════════════════════════════════════════════════════════════
  // Category F：日期區間 — 區間外事件不得計入
  // ════════════════════════════════════════════════════════════════
  const STORE_F = 'h145_store_f';
  ensureProduct(STORE_F, 60001, '跨日商品', 100);
  // 寫入一筆「昨天」的事件（用真實 SQL UPDATE 改寫 created_at_local，模擬歷史資料，
  // 不新增資料表、不改事件定義，只是測試資料本身的時間戳）
  viewProduct(STORE_F, { visitor_id: 'f_old', product_id: 60001, order_mode: 'takeout' });
  addToCart(STORE_F, { visitor_id: 'f_old', product_id: 60001, order_mode: 'takeout' });
  db.run(
    `UPDATE analytics_events SET created_at = datetime('now','-2 days') WHERE store_id=? AND visitor_id='f_old'`,
    [STORE_F]
  );
  // 今天的區間内再寫入一筆新事件
  viewProduct(STORE_F, { visitor_id: 'f_new', product_id: 60001, order_mode: 'takeout' });
  addToCart(STORE_F, { visitor_id: 'f_new', product_id: 60001, order_mode: 'takeout' });

  const rankingF = getProductRanking(db, STORE_F, rangeToday(), 'all');
  const p60001 = rankingF.find((p) => p.product_id === 60001);
  assert(!!p60001, 'Category F: 跨日商品出現在今日區間結果中');
  if (p60001) {
    assert(p60001.view_people === 1, 'Category F: 日期區間正確排除昨天的事件，view_people === 1（只有今天那筆）', `實際 ${p60001.view_people}`);
    assert(p60001.cart_people === 1, 'Category F: 日期區間正確排除昨天的事件，cart_people === 1', `實際 ${p60001.cart_people}`);
    assert(p60001.view_to_cart_rate === 100, 'Category F: 區間篩選後 1÷1=100', `實際 ${p60001.view_to_cart_rate}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Category G：channel filter 不退化 — channel='pos' 與未指定 channel 篩選結果需不同
  // ════════════════════════════════════════════════════════════════
  const STORE_G = 'h145_store_g';
  ensureProduct(STORE_G, 70001, '渠道測試商品', 100);
  // pos 渠道（channel_source:'pos' + order_mode:'takeout' → resolveOrderChannel 判定為 'pos'）
  viewProduct(STORE_G, { visitor_id: 'g_pos1', product_id: 70001, order_mode: 'takeout', channel_source: 'pos' });
  addToCart(STORE_G, { visitor_id: 'g_pos1', product_id: 70001, order_mode: 'takeout', channel_source: 'pos' });
  // line_takeout 渠道（未指定 channel_source，order_mode:'takeout' → 'line_takeout'）
  viewProduct(STORE_G, { visitor_id: 'g_line1', product_id: 70001, order_mode: 'takeout' });
  viewProduct(STORE_G, { visitor_id: 'g_line2', product_id: 70001, order_mode: 'takeout' });
  addToCart(STORE_G, { visitor_id: 'g_line1', product_id: 70001, order_mode: 'takeout' });

  const rankingAll = getProductRanking(db, STORE_G, rangeToday(), 'all');
  const rankingPos = getProductRanking(db, STORE_G, rangeToday(), 'pos');
  const rankingLine = getProductRanking(db, STORE_G, rangeToday(), 'line_takeout');

  const pAll = rankingAll.find((p) => p.product_id === 70001);
  const pPos = rankingPos.find((p) => p.product_id === 70001);
  const pLine = rankingLine.find((p) => p.product_id === 70001);

  assert(!!pAll && pAll.view_people === 3, 'Category G: channel=all 時曝光人數為 3（1 pos + 2 line_takeout）', pAll ? `實際 ${pAll.view_people}` : 'missing');
  assert(!!pPos && pPos.view_people === 1 && pPos.cart_people === 1, 'Category G: channel=pos 篩選後只有 1 曝光 1 加購', pPos ? JSON.stringify(pPos) : 'missing');
  assert(!!pLine && pLine.view_people === 2 && pLine.cart_people === 1, 'Category G: channel=line_takeout 篩選後有 2 曝光 1 加購', pLine ? JSON.stringify(pLine) : 'missing');
  if (pPos) assert(pPos.view_to_cart_rate === 100, 'Category G: channel=pos 的 view_to_cart_rate 正確計算（1÷1=100）', `實際 ${pPos.view_to_cart_rate}`);
  if (pLine) assert(pLine.view_to_cart_rate === 50, 'Category G: channel=line_takeout 的 view_to_cart_rate 正確計算（1÷2=50）', `實際 ${pLine.view_to_cart_rate}`);

  // ── 收尾：清除本輪測試建立的 DB 檔，避免殘留 ──────────────────────
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failedList = results.filter((r) => r.status === 'FAIL');

  console.log(`\nH1.4.5 Product Exposure-to-Cart Rate Runtime — ${passed}/${total} passed\n`);
  results.forEach((r) => console.log(`${r.status === 'PASS' ? '✓' : '✗'} ${r.name}${r.status === 'FAIL' && r.detail ? ' — ' + r.detail : ''}`));
  console.log(`\nPASS: ${passed}`);
  console.log(`FAIL: ${failedList.length}`);
  console.log(`TOTAL: ${total}`);

  process.exitCode = failedList.length ? 1 : 0;
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
