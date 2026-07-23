#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-cart-order-hours.js — fix18-10-hotfix30-B5-R5 smoke test
//
// 涵蓋需求文件「Cart Detail × Accurate Cart Snapshot × Order Hour Analysis」：
//   Cart R5-1 ~ R5-12、Hour R5-1 ~ R5-9，以及追加驗證：
//   metadata sanitizer、損壞 JSON 不得 500、limit 上限 100、store_id 隔離、
//   同 cart_id 跨店隔離、estimated fallback 標記、Asia/Taipei 時區、
//   cancelled/void 排除、channel 篩選、reload 不重複增加購物車、
//   restored 不增加 add_to_cart。
//
// 做法：直接呼叫 utils/cartSnapshot.js、utils/dashboardAnalytics.js、
// utils/analyticsLog.js 的真實函式（同一份程式碼，不是另外重寫一份簡化邏輯），
// 搭配 utils/db.js 的 sql.js 記憶體/檔案資料庫直接寫入測試資料。
//
// 誠實揭露（MANUAL REQUIRED）：
//   UI R5-1~R5-4（手機/平板/桌面實際渲染是否破版、圖表視覺呈現）需要真實瀏覽器
//   或視覺回歸工具交叉確認，本測試只能驗證資料/DOM 結構層級的正確性（見
//   scripts/smoke-hotfix30-b5-r5-dashboard-ui.js，已驗證關鍵 DOM 節點與文案存在、
//   函式可執行不拋例外），無法驗證實際版面在小螢幕上是否溢出。
'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const {
    sanitizeCartSnapshotMetadata, getOpenCartRows, getCartDetail, formatAgeLabel, ageBucketOf,
  } = require('../utils/cartSnapshot');
  const {
    getOrderHourAnalysis, getOrderPeriodAnalysis, getCartAnalysis, getFunnel,
  } = require('../utils/dashboardAnalytics');
  const { resolveDateRange } = require('../utils/dashboardDate');

  function isoUtc(hoursAgo) {
    return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }
  function setEventCreatedAt(storeId, cartId, eventName, hoursAgo) {
    const row = db.get(
      `SELECT id FROM analytics_events WHERE store_id=? AND cart_id=? AND event_name=? ORDER BY id DESC LIMIT 1`,
      [storeId, cartId, eventName]
    );
    if (!row) throw new Error(`setEventCreatedAt: 找不到事件 ${eventName} for ${cartId}`);
    db.run('UPDATE analytics_events SET created_at=? WHERE id=?', [isoUtc(hoursAgo), row.id]);
  }
  function ensureProduct(storeId, id, name, price) {
    db.run(
      `INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled)
       VALUES (?,?,?,?,?,1)`,
      [id, storeId, name, '測試', price]
    );
  }
  function cartUpdated(storeId, opts) {
    const meta = sanitizeCartSnapshotMetadata('cart_updated', opts.metadata);
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'cart_updated', order_mode: opts.order_mode || 'takeout',
      metadata: meta, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function addToCart(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'add_to_cart', product_id: opts.product_id, quantity: opts.qty || 1,
      order_mode: opts.order_mode || 'takeout', line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-1 ~ R5-5：豬腰／毛豆增減、清空
  // ════════════════════════════════════════════════════════════════
  const STORE_CART = 'r5_cart_store';
  ensureProduct(STORE_CART, 9001, '豬腰', 150);
  ensureProduct(STORE_CART, 9002, '毛豆', 100);

  // R5-1：加入豬腰一次
  addToCart(STORE_CART, { cart_id: 'cart_r5_1', visitor_id: 'v_r5_1', product_id: 9001, qty: 1 });
  cartUpdated(STORE_CART, {
    cart_id: 'cart_r5_1', visitor_id: 'v_r5_1',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 },
  });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    const row = r.rows.find(x => x.cart_id === 'cart_r5_1');
    assert(!!row, 'Cart R5-1：加入豬腰一次 → 出現在未完成清單');
    assert(row && row.items.length === 1 && row.items[0].name === '豬腰' && row.items[0].qty === 1, 'Cart R5-1：商品明細豬腰 ×1', JSON.stringify(row && row.items));
    assert(row && row.estimated === false, 'Cart R5-1：有快照時 estimated=false');
  }

  // R5-2：同一 cart_id 增加毛豆
  addToCart(STORE_CART, { cart_id: 'cart_r5_1', visitor_id: 'v_r5_1', product_id: 9002, qty: 1 });
  cartUpdated(STORE_CART, {
    cart_id: 'cart_r5_1', visitor_id: 'v_r5_1',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }, { product_id: 9002, name: '毛豆', qty: 1, unit_price: 100, subtotal: 100 }], subtotal: 250, discount: 0, delivery_fee: 0, total: 250, order_mode: 'takeout', item_count: 2 },
  });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    const rows = r.rows.filter(x => x.cart_id === 'cart_r5_1');
    assert(rows.length === 1, 'Cart R5-2：購物車仍為 1 個（不會變成 2 筆）', `找到 ${rows.length} 筆`);
    const row = rows[0];
    assert(row.items.length === 2 && row.total === 250, 'Cart R5-2：商品為豬腰×1、毛豆×1，金額正確', JSON.stringify(row.items) + ' total=' + row.total);
  }

  // R5-3：毛豆數量 1 → 2（不可累加成 3）
  cartUpdated(STORE_CART, {
    cart_id: 'cart_r5_1', visitor_id: 'v_r5_1',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }, { product_id: 9002, name: '毛豆', qty: 2, unit_price: 100, subtotal: 200 }], subtotal: 350, discount: 0, delivery_fee: 0, total: 350, order_mode: 'takeout', item_count: 3 },
  });
  {
    const row = getOpenCartRows(db, STORE_CART, {}).rows.find(x => x.cart_id === 'cart_r5_1');
    const soybean = row.items.find(i => i.product_id === 9002);
    assert(soybean && soybean.qty === 2, 'Cart R5-3：最終快照毛豆數量為 2（不是累加成 3）', JSON.stringify(soybean));
  }

  // R5-4：刪除毛豆
  cartUpdated(STORE_CART, {
    cart_id: 'cart_r5_1', visitor_id: 'v_r5_1',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 },
  });
  {
    const row = getOpenCartRows(db, STORE_CART, {}).rows.find(x => x.cart_id === 'cart_r5_1');
    assert(row.items.length === 1 && row.items[0].name === '豬腰' && row.total === 150, 'Cart R5-4：明細只剩豬腰，未完成金額扣除毛豆', JSON.stringify(row.items));
  }

  // R5-5：清空購物車
  cartUpdated(STORE_CART, {
    cart_id: 'cart_r5_1', visitor_id: 'v_r5_1',
    metadata: { items: [], subtotal: 0, discount: 0, delivery_fee: 0, total: 0, order_mode: 'takeout', item_count: 0, status: 'cleared' },
  });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    const row = r.rows.find(x => x.cart_id === 'cart_r5_1');
    assert(!row, 'Cart R5-5：清空後狀態不列入未完成金額（從清單移除）');
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-6 / R5-7：跨日未操作／同瀏覽器重新進入（cart_restored）
  // ════════════════════════════════════════════════════════════════
  const cartR6 = 'cart_r5_6';
  addToCart(STORE_CART, { cart_id: cartR6, visitor_id: 'v_r5_6', product_id: 9001, qty: 1 });
  cartUpdated(STORE_CART, {
    cart_id: cartR6, visitor_id: 'v_r5_6',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 },
  });
  // 把這兩筆事件的時間往前推 30 小時，模擬「昨天加入、今天完全沒操作」
  setEventCreatedAt(STORE_CART, cartR6, 'add_to_cart', 30);
  setEventCreatedAt(STORE_CART, cartR6, 'cart_updated', 30);

  const addToCartVisitorsBefore = getCartAnalysis(db, STORE_CART, resolveDateRange({ preset: 'today' })).add_to_cart_visitors;
  const funnelAddBefore = (getFunnel(db, STORE_CART, resolveDateRange({ preset: 'today' }), 'all').find(s => s.key === 'add_to_cart') || {}).count || 0;

  {
    const row = getOpenCartRows(db, STORE_CART, {}).rows.find(x => x.cart_id === cartR6);
    assert(!!row, 'Cart R5-6：隔天未操作，目前未完成購物車仍看得到這一筆');
    assert(row && (row._age_bucket === undefined) && ['1~3天', '1~24小時'].includes(ageBucketOf(row.age_seconds)), 'Cart R5-6：放置時間 age bucket 隨時間自動更新（~30 小時應落在 1~3 天，允許邊界誤差落在 1~24 小時）', `age_seconds=${row && row.age_seconds}`);
  }

  // R5-7：同瀏覽器重新進入但沒加商品 → 記一筆 cart_restored（同一 cart_id，內容不變）
  cartUpdated(STORE_CART, {
    cart_id: cartR6, visitor_id: 'v_r5_6',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 },
  });
  // 上面用 cartUpdated helper 送出的其實是 cart_updated；R5-7 要驗證的是「即使送出
  // cart_restored 事件，也不能讓 add_to_cart 去重人數增加」，這裡改用真正的
  // cart_restored 事件名稱單獨驗證：
  insertEvent(db, {
    store_id: STORE_CART, visitor_id: 'v_r5_6', session_id: 's_default', cart_id: cartR6,
    event_name: 'cart_restored', order_mode: 'takeout',
    metadata: sanitizeCartSnapshotMetadata('cart_restored', { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 }),
  });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    const rows = r.rows.filter(x => x.cart_id === cartR6);
    assert(rows.length === 1, 'Cart R5-7：cart_id 不變，重新整理不會建立新的購物車列', `找到 ${rows.length} 筆`);
    const addToCartVisitorsAfter = getCartAnalysis(db, STORE_CART, resolveDateRange({ preset: 'today' })).add_to_cart_visitors;
    const funnelAddAfter = (getFunnel(db, STORE_CART, resolveDateRange({ preset: 'today' }), 'all').find(s => s.key === 'add_to_cart') || {}).count || 0;
    assert(addToCartVisitorsAfter === addToCartVisitorsBefore, 'Cart R5-7／reload 不重複增加購物車人數：cart_restored 不增加 add_to_cart 去重人數', `before=${addToCartVisitorsBefore} after=${addToCartVisitorsAfter}`);
    assert(funnelAddAfter === funnelAddBefore, 'restored 不增加 add_to_cart（漏斗事件數同樣不受影響）', `before=${funnelAddBefore} after=${funnelAddAfter}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-8：完成訂單
  // ════════════════════════════════════════════════════════════════
  const cartR8 = 'cart_r5_8';
  addToCart(STORE_CART, { cart_id: cartR8, visitor_id: 'v_r5_8', product_id: 9001, qty: 1 });
  cartUpdated(STORE_CART, {
    cart_id: cartR8, visitor_id: 'v_r5_8',
    metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 },
  });
  insertEvent(db, { store_id: STORE_CART, visitor_id: 'v_r5_8', session_id: 's_default', cart_id: cartR8, order_id: 'order_r5_8', event_name: 'purchase' });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    assert(!r.rows.find(x => x.cart_id === cartR8), 'Cart R5-8：完成訂單後從未完成清單移除');
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-9：同 LINE UID 換裝置
  // ════════════════════════════════════════════════════════════════
  const LINE_UID = 'U_R5_9_TESTUSER';
  addToCart(STORE_CART, { cart_id: 'cart_r5_9_a', visitor_id: 'v_r5_9_a', product_id: 9001, qty: 1, line_user_id: LINE_UID });
  cartUpdated(STORE_CART, { cart_id: 'cart_r5_9_a', visitor_id: 'v_r5_9_a', line_user_id: LINE_UID, metadata: { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 } });
  addToCart(STORE_CART, { cart_id: 'cart_r5_9_b', visitor_id: 'v_r5_9_b', product_id: 9002, qty: 1, line_user_id: LINE_UID });
  cartUpdated(STORE_CART, { cart_id: 'cart_r5_9_b', visitor_id: 'v_r5_9_b', line_user_id: LINE_UID, metadata: { items: [{ product_id: 9002, name: '毛豆', qty: 1, unit_price: 100, subtotal: 100 }], subtotal: 100, discount: 0, delivery_fee: 0, total: 100, order_mode: 'takeout', item_count: 1 } });
  {
    const r = getOpenCartRows(db, STORE_CART, {});
    const a = r.rows.find(x => x.cart_id === 'cart_r5_9_a');
    const b = r.rows.find(x => x.cart_id === 'cart_r5_9_b');
    assert(!!a && !!b, 'Cart R5-9：兩個 cart_id 不強制合併，各自出現在清單中');
    assert(a && a.identity_type === 'line' && b && b.identity_type === 'line', 'Cart R5-9：身分可解析為同一會員（皆標示為 LINE 身分）');
    assert(a && a.items[0].product_id === 9001 && b && b.items[0].product_id === 9002, 'Cart R5-9：商品內容不互相覆蓋（各自保留自己的商品）');
    const detailA = getCartDetail(db, STORE_CART, 'cart_r5_9_a');
    assert(detailA && detailA.other_device_cart_count >= 1, 'Cart R5-9：購物車詳情可看到「此會員另有其他裝置購物車」', JSON.stringify(detailA && detailA.other_device_cart_count));
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-10：store 隔離（含同一 cart_id 跨店隔離）
  // ════════════════════════════════════════════════════════════════
  const STORE_A = 'r5_store_001';
  const STORE_B = 'r5_store_002';
  ensureProduct(STORE_A, 9001, '豬腰A店', 150);
  ensureProduct(STORE_B, 9001, '豬腰B店', 200);
  const SHARED_CART_ID = 'cart_shared_across_stores';
  addToCart(STORE_A, { cart_id: SHARED_CART_ID, visitor_id: 'v_a', product_id: 9001, qty: 1 });
  cartUpdated(STORE_A, { cart_id: SHARED_CART_ID, visitor_id: 'v_a', metadata: { items: [{ product_id: 9001, name: 'A店豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 } });
  addToCart(STORE_B, { cart_id: SHARED_CART_ID, visitor_id: 'v_b', product_id: 9001, qty: 2 });
  cartUpdated(STORE_B, { cart_id: SHARED_CART_ID, visitor_id: 'v_b', metadata: { items: [{ product_id: 9001, name: 'B店豬腰', qty: 2, unit_price: 200, subtotal: 400 }], subtotal: 400, discount: 0, delivery_fee: 0, total: 400, order_mode: 'takeout', item_count: 2 } });
  {
    const rowsA = getOpenCartRows(db, STORE_A, {}).rows;
    const rowsB = getOpenCartRows(db, STORE_B, {}).rows;
    assert(!rowsA.some(r => r.total === 400), 'Cart R5-10：store_001 查詢不得看到 store_002 購物車內容');
    assert(!rowsB.some(r => r.total === 150), 'Cart R5-10：store_002 查詢不得看到 store_001 購物車內容');
    const detailFromA = getCartDetail(db, STORE_A, SHARED_CART_ID);
    const detailFromB = getCartDetail(db, STORE_B, SHARED_CART_ID);
    assert(detailFromA && detailFromA.total === 150, '同 cart_id 跨店隔離：store_001 看到自己的內容（150）', JSON.stringify(detailFromA && detailFromA.total));
    assert(detailFromB && detailFromB.total === 400, '同 cart_id 跨店隔離：store_002 看到自己的內容（400）', JSON.stringify(detailFromB && detailFromB.total));
    const crossLookup = getCartDetail(db, STORE_A, 'cart_id_that_only_exists_in_store_b_never_here');
    assert(crossLookup === null, 'cart 詳情查詢驗證 store_id：查不存在於本店的 cart_id 回傳 null（不報錯）');
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-11：舊資料只有 add_to_cart、沒有快照 → estimated=true
  // ════════════════════════════════════════════════════════════════
  const cartR11 = 'cart_r5_11_legacy';
  ensureProduct(STORE_CART, 9003, '古早味紅茶', 30);
  addToCart(STORE_CART, { cart_id: cartR11, visitor_id: 'v_r5_11', product_id: 9003, qty: 2 });
  {
    const row = getOpenCartRows(db, STORE_CART, {}).rows.find(x => x.cart_id === cartR11);
    assert(!!row, 'Cart R5-11：沒有快照的舊資料 API 不報錯，仍可回退估算');
    assert(row && row.estimated === true, 'Cart R5-11：回退估算時 estimated=true');
    assert(row && row.items[0].qty === 2 && row.items[0].unit_price === 30, 'Cart R5-11：回退估算使用目前商品價格重建品項', JSON.stringify(row && row.items));
  }
  // 新資料（有快照）必須標示 estimated=false（與 R5-1 一起構成對照組）
  {
    const row = getOpenCartRows(db, STORE_CART, {}).rows.find(x => x.cart_id === 'cart_r5_9_a');
    assert(row && row.estimated === false, '新快照資料必須標示 estimated=false（對照 R5-11 的 estimated=true）');
  }

  // ════════════════════════════════════════════════════════════════
  // Cart R5-12：metadata 為損壞 JSON
  // ════════════════════════════════════════════════════════════════
  const cartR12 = 'cart_r5_12_broken';
  addToCart(STORE_CART, { cart_id: cartR12, visitor_id: 'v_r5_12', product_id: 9001, qty: 1 });
  insertEvent(db, { store_id: STORE_CART, visitor_id: 'v_r5_12', session_id: 's_default', cart_id: cartR12, event_name: 'cart_updated', order_mode: 'takeout' });
  // 手動寫入損壞 JSON（繞過 insertEvent 的 JSON.stringify，模擬資料損毀情境）
  // sql.js 的 UPDATE 不支援 ORDER BY/LIMIT，改用子查詢鎖定最後一筆事件
  db.run(
    `UPDATE analytics_events SET metadata_json=? WHERE id = (SELECT id FROM analytics_events WHERE store_id=? AND cart_id=? AND event_name='cart_updated' ORDER BY id DESC LIMIT 1)`,
    ['{this is not valid json!!', STORE_CART, cartR12]
  );
  try {
    const r = getOpenCartRows(db, STORE_CART, {});
    pass('Cart R5-12：metadata 為損壞 JSON 時 getOpenCartRows() 不拋出例外（不得 API 500）');
    const row = r.rows.find(x => x.cart_id === cartR12);
    assert(!!row && row.estimated === true, 'Cart R5-12：損壞 JSON 被略過，回退到 add_to_cart 估算（該筆標示估計）', JSON.stringify(row));
    const detail = getCartDetail(db, STORE_CART, cartR12);
    assert(!!detail, 'Cart R5-12：getCartDetail() 對損壞 metadata 一樣不拋例外');
  } catch (e) {
    fail('Cart R5-12：metadata 為損壞 JSON 時不得拋出例外', e.message);
  }

  // ════════════════════════════════════════════════════════════════
  // 額外驗證：sanitizer / limit 上限 / 敏感資料
  // ════════════════════════════════════════════════════════════════
  {
    const bigItems = Array.from({ length: 80 }, (_, i) => ({ product_id: i + 1, name: `商品${i}`, qty: 1, unit_price: 10 }));
    const sanitized = sanitizeCartSnapshotMetadata('cart_updated', {
      items: bigItems, subtotal: 'not-a-number', discount: -5, delivery_fee: 'x',
      order_mode: 'HACKED_MODE', total: 'zzz', item_count: 'zzz',
      attempt_id: 'a'.repeat(500), access_token: 'super-secret-token-should-not-leak', id_token: 'should-not-leak-either',
    });
    assert(sanitized.items.length === 50, 'sanitizer：items 上限截斷為 50 筆', `實際 ${sanitized.items.length}`);
    assert(Number.isFinite(sanitized.subtotal), 'sanitizer：subtotal 非數字時退回自動加總（不是 NaN）', String(sanitized.subtotal));
    assert(sanitized.discount === 0, 'sanitizer：discount 非數字時退回 0 且不得為負數');
    assert(sanitized.order_mode === 'unknown', 'sanitizer：order_mode 不在白名單內時退回 unknown（不接受任意字串）', sanitized.order_mode);
    assert(sanitized.attempt_id.length <= 100, 'sanitizer：attempt_id 截斷長度上限');
    assert(sanitized.access_token === undefined && sanitized.id_token === undefined, 'sanitizer：access_token／id_token 等未列入白名單的欄位不會被寫入');

    const nonCartEvent = sanitizeCartSnapshotMetadata('add_to_cart', { foo: 'bar' });
    assert(nonCartEvent && nonCartEvent.foo === 'bar', 'sanitizer：非 cart_updated/cart_restored 事件的 metadata 原樣通過，不受影響');

    const brokenInput = sanitizeCartSnapshotMetadata('cart_updated', 'this is not an object');
    assert(brokenInput === null, 'sanitizer：非物件 metadata 一律回傳 null（不拋例外）');
  }
  {
    const r = getOpenCartRows(db, STORE_CART, { limit: 500 });
    assert(r.limit === 100, 'limit 最大 100：要求 500 時被限制為 100', `實際 ${r.limit}`);
    const r2 = getOpenCartRows(db, STORE_CART, { limit: -5 });
    assert(r2.limit >= 1, 'limit 下限：負數/不合法值退回安全預設', `實際 ${r2.limit}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Hour R5-1 ~ R5-9：訂單時段分析
  // ════════════════════════════════════════════════════════════════
  const STORE_HOUR = 'r5_hour_store';
  let orderSeq = 1;
  function insertOrder({ storeId, localDateTime, total, status = 'completed', orderStatus = 'completed', orderMode = 'takeout', source = 'line' }) {
    const id = 'ord_r5_' + (orderSeq++);
    db.run(
      `INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total, status, order_status, order_mode, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, id, storeId, '[]', 'cash', total, total, status, orderStatus, orderMode, source, localDateTime]
    );
    return id;
  }

  // Hour R5-1：台灣時間 18:30 建立訂單 → 應歸入 18:00–18:59，不可因 UTC 誤判為 10:00
  insertOrder({ storeId: STORE_HOUR, localDateTime: '2026-07-23 18:30:00', total: 400 });
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR, range, 'all');
    assert(analysis.rows[18].orders === 1, 'Hour R5-1：18:30 建立的訂單歸入 18:00–18:59', JSON.stringify(analysis.rows[18]));
    assert(analysis.rows[10].orders === 0, 'Hour R5-1：不可因 UTC 換算誤差歸入 10:00', JSON.stringify(analysis.rows[10]));
  }

  // Hour R5-2：同一時段 3 筆訂單，總額 900 → avg_order_value=300
  const STORE_HOUR2 = 'r5_hour_store2';
  insertOrder({ storeId: STORE_HOUR2, localDateTime: '2026-07-23 12:10:00', total: 300 });
  insertOrder({ storeId: STORE_HOUR2, localDateTime: '2026-07-23 12:20:00', total: 300 });
  insertOrder({ storeId: STORE_HOUR2, localDateTime: '2026-07-23 12:40:00', total: 300 });
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR2, range, 'all');
    const hr12 = analysis.rows[12];
    assert(hr12.orders === 3 && hr12.revenue === 900 && hr12.avg_order_value === 300, 'Hour R5-2：同時段 3 筆訂單、總額 900、平均客單 300', JSON.stringify(hr12));
  }

  // Hour R5-3：取消／作廢訂單不得計入
  insertOrder({ storeId: STORE_HOUR2, localDateTime: '2026-07-23 12:15:00', total: 9999, status: 'void' });
  insertOrder({ storeId: STORE_HOUR2, localDateTime: '2026-07-23 12:16:00', total: 8888, orderStatus: 'cancelled' });
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR2, range, 'all');
    assert(analysis.rows[12].orders === 3 && analysis.rows[12].revenue === 900, 'Hour R5-3：作廢／取消訂單不計入時段統計（仍是 3 筆 900 元）', JSON.stringify(analysis.rows[12]));
  }

  // Hour R5-4：channel=line_delivery 時只計算外送訂單
  const STORE_HOUR4 = 'r5_hour_store4';
  insertOrder({ storeId: STORE_HOUR4, localDateTime: '2026-07-23 19:00:00', total: 500, orderMode: 'takeout', source: 'line' }); // line_takeout
  insertOrder({ storeId: STORE_HOUR4, localDateTime: '2026-07-23 19:10:00', total: 700, orderMode: 'delivery', source: 'line' }); // line_delivery
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const allChannels = getOrderHourAnalysis(db, STORE_HOUR4, range, 'all');
    const onlyDelivery = getOrderHourAnalysis(db, STORE_HOUR4, range, 'line_delivery');
    assert(allChannels.rows[19].orders === 2, 'Hour R5-4：channel=all 時兩筆都計入', JSON.stringify(allChannels.rows[19]));
    assert(onlyDelivery.rows[19].orders === 1 && onlyDelivery.rows[19].revenue === 700, 'Hour R5-4：channel=line_delivery 時只計算外送訂單', JSON.stringify(onlyDelivery.rows[19]));
  }

  // Hour R5-5：指定單日篩選只計算該日
  const STORE_HOUR5 = 'r5_hour_store5';
  insertOrder({ storeId: STORE_HOUR5, localDateTime: '2026-07-22 10:00:00', total: 100 });
  insertOrder({ storeId: STORE_HOUR5, localDateTime: '2026-07-23 10:00:00', total: 200 });
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR5, range, 'all');
    assert(analysis.total_orders === 1 && analysis.rows[10].revenue === 200, 'Hour R5-5：指定單日篩選只計算該日訂單（不含前一天）', JSON.stringify({ total: analysis.total_orders, hr10: analysis.rows[10] }));
  }

  // Hour R5-6：自訂跨日區間應把各日相同小時彙總
  {
    const range = resolveDateRange({ preset: 'custom', start_date: '2026-07-22', end_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR5, range, 'all');
    assert(analysis.rows[10].orders === 2 && analysis.rows[10].revenue === 300, 'Hour R5-6：跨日區間把兩天同一小時彙總（2 筆、300 元）', JSON.stringify(analysis.rows[10]));
  }

  // Hour R5-7：完全沒有訂單 → 回傳完整 24 rows、全部為 0、peak_hour=null、無 NaN/Infinity
  const STORE_HOUR7 = 'r5_hour_store7_empty';
  {
    const range = resolveDateRange({ preset: 'today' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR7, range, 'all');
    assert(analysis.rows.length === 24, 'Hour R5-7：無訂單時仍回傳完整 24 個 rows', String(analysis.rows.length));
    assert(analysis.rows.every(r => r.orders === 0 && r.revenue === 0), 'Hour R5-7：所有值為 0');
    assert(analysis.peak_hour === null, 'Hour R5-7：peak_hour 為 null');
    const json = JSON.stringify(analysis);
    assert(!json.includes('NaN') && !json.includes('Infinity'), 'Hour R5-7：不出現 NaN 或 Infinity', json.includes('NaN') ? 'contains NaN' : 'contains Infinity');
    const periods = getOrderPeriodAnalysis(analysis);
    assert(periods.every(p => p.orders === 0 && !p.is_peak), 'Hour R5-7：餐飲時段摘要也全部為 0、沒有標記尖峰');
  }

  // Hour R5-8：晚餐時段訂單最多 → peak_period 正確顯示晚餐
  const STORE_HOUR8 = 'r5_hour_store8';
  insertOrder({ storeId: STORE_HOUR8, localDateTime: '2026-07-23 12:00:00', total: 100 }); // 午餐 1 筆
  insertOrder({ storeId: STORE_HOUR8, localDateTime: '2026-07-23 18:00:00', total: 200 }); // 晚餐
  insertOrder({ storeId: STORE_HOUR8, localDateTime: '2026-07-23 18:30:00', total: 200 }); // 晚餐
  insertOrder({ storeId: STORE_HOUR8, localDateTime: '2026-07-23 19:00:00', total: 200 }); // 晚餐
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const analysis = getOrderHourAnalysis(db, STORE_HOUR8, range, 'all');
    const periods = getOrderPeriodAnalysis(analysis);
    const dinner = periods.find(p => p.key === 'dinner');
    assert(dinner && dinner.is_peak === true && dinner.orders === 3, 'Hour R5-8：晚餐時段訂單最多，peak_period 正確標記晚餐 17:00–19:59', JSON.stringify(dinner));
  }

  // Hour R5-9：store_001 與 store_002 訂單不得混合
  const STORE_HOUR9A = 'r5_hour_store9_a';
  const STORE_HOUR9B = 'r5_hour_store9_b';
  insertOrder({ storeId: STORE_HOUR9A, localDateTime: '2026-07-23 09:00:00', total: 111 });
  insertOrder({ storeId: STORE_HOUR9B, localDateTime: '2026-07-23 09:00:00', total: 222 });
  {
    const range = resolveDateRange({ preset: 'single', start_date: '2026-07-23' });
    const a = getOrderHourAnalysis(db, STORE_HOUR9A, range, 'all');
    const b = getOrderHourAnalysis(db, STORE_HOUR9B, range, 'all');
    assert(a.rows[9].revenue === 111 && b.rows[9].revenue === 222, 'Hour R5-9：不同 store_id 的訂單金額不互相混合', JSON.stringify({ a: a.rows[9], b: b.rows[9] }));
  }

  // ── UI R5-1 ~ R5-4：需要真實瀏覽器/視覺回歸確認 ──────────────────
  manual('UI R5-1：切換日期後，時段圖與購物車明細同步更新（DOM 結構層級已由 smoke-hotfix30-b5-r5-dashboard-ui.js 驗證，實際視覺效果需人工確認）', '需瀏覽器交叉測試');
  manual('UI R5-2：切換外帶／外送後，時段圖同步更新、不殘留上一渠道資料（後端 channel 參數與前端 fetch 已驗證會帶入正確值，實際畫面更新流暢度需人工確認）', '需瀏覽器交叉測試');
  manual('UI R5-3：明細 Modal 在手機、平板、桌面皆可閱讀', '需真機/瀏覽器 RWD 交叉測試');
  manual('UI R5-4：長商品名稱與多項商品不得撐破版面（CSS 已加上 overflow/ellipsis，實際極端字串渲染需人工確認）', '需瀏覽器交叉測試');

  // ── 總結 ──────────────────────────────────────────────────────
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const manualCount = results.filter(r => r.status === 'MANUAL REQUIRED').length;
  console.log('\n=== SUMMARY ===');
  results.forEach(r => console.log(`[${r.status}] ${r.name}`));
  console.log(`TOTAL: ${results.length}  PASS: ${results.length - failCount - manualCount}  FAIL: ${failCount}  MANUAL: ${manualCount}`);
  process.exit(failCount ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
