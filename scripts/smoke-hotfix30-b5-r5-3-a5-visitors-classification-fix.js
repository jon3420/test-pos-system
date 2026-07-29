#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a5-visitors-classification-fix.js
// fix18-10-hotfix30-B5-R5.3-A5：Analytics/Geo Visitors Classification Bug Fix
//
// 背景：使用者回報「老闆儀表板目前在線 1 人、轉換漏斗商品瀏覽 1 人，但
// Geo 訪客仍為 0」。根因：utils/geoEventEngine.js 的 Visitors 計算原本
// 只認 page_view/session_start 兩種事件，真實流量常見使用者直接落在
// 商品頁（例如 LINE 深連結/QR Code），第一個也是唯一一個事件是
// view_product，從未觸發 page_view，導致被排除在 Geo Visitors 之外，
// 但老闆儀表板的 getRealtime()（任何事件都算在線）與 Analytics 轉換
// 漏斗（商品瀏覽）都正確算作 1 人。
//
// 修正：Visitors 改成涵蓋整個漏斗事件集合（ALL_FUNNEL_EVENT_NAMES），
// 不再只窄限於 VISITOR 分類，同時保留各階段（view_item_visitors／
// add_to_cart_visitors／...）各自只計算對應單一事件類型的既有語意。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function printSummary() {
  const total = results.length;
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A5 (Visitors Classification Fix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${total}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const DB_FILE = path.join(ROOT, 'data', 'pos.db');
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const dashboardAnalytics = require(path.join(ROOT, 'utils/dashboardAnalytics'));
  const GEE = require(path.join(ROOT, 'utils/geoEventEngine'));
  await initDb();
  const db = getDb();
  function fresh(name) { return name + '_' + Math.random().toString(36).slice(2); }

  // ── 1. 原始回報症狀重現 + 驗證修正 ─────────────────────────────
  {
    const S = fresh('store_a5_view_product_only');
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'view_product', product_id: 1, geo: null });
    const realtime = dashboardAnalytics.getRealtime(db, S);
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(realtime.online === 1, 'A5-1 老闆儀表板「目前在線」正確為 1（既有函式，本輪未修改）');
    assert(funnel.visitors === 1, 'A5-2【核心修正】Geo Event Engine Visitors 現在正確為 1（修正前是 0）');
    assert(funnel.view_item_visitors === 1, 'A5-3 view_item_visitors 仍正確為 1（單一事件類型語意不變）');
    assert(realtime.online === funnel.visitors, 'A5-4 老闆儀表板「目前在線」與 Geo Visitors 完全一致');
  }

  // ── 2. 只有 add_to_cart（無 page_view）的 session ──────────────
  {
    const S = fresh('store_a5_atc_only');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'add_to_cart', geo: null });
    const realtime = dashboardAnalytics.getRealtime(db, S);
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1, 'A5-5 只有 add_to_cart 事件（無 page_view）仍正確計入 Visitors');
    assert(realtime.online === funnel.visitors, 'A5-6 與老闆儀表板一致');
  }

  // ── 3. 只有 begin_checkout（無 page_view）的 session ───────────
  {
    const S = fresh('store_a5_checkout_only');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'begin_checkout', geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1, 'A5-7 只有 begin_checkout 事件仍正確計入 Visitors');
  }

  // ── 4. 只有 purchase（無 page_view，例如既有訂單流程直接觸發）───
  {
    const S = fresh('store_a5_purchase_only');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'o1', geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1, 'A5-8 只有 purchase 事件仍正確計入 Visitors');
  }

  // ── 5. 原本就有 page_view 的正常情境不受影響（既有行為維持）────
  {
    const S = fresh('store_a5_normal_pageview');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1, 'A5-9 既有 page_view 情境行為不變，仍正確為 1');
  }

  // ── 6. Visitors 去重仍然正確（同一人多種事件只算 1 人，不會因為
  //      擴大事件集合就重複計算）──────────────────────────────────
  {
    const S = fresh('store_a5_dedup_check');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'view_product', product_id: 1, geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'add_to_cart', geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1, 'A5-10 同一人觸發 page_view+view_product+add_to_cart，Visitors 仍正確去重為 1（不是 3）');
  }

  // ── 7. Unknown 訪客（無 page_view，只有 view_product，且地理未知）
  //      仍正確計入且 Unknown 統計正確 ──────────────────────────────
  {
    const S = fresh('store_a5_unknown_view_product');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'view_product', product_id: 1, geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 1 && funnel.unknown_visitors === 1 && funnel.unknown_rate === 100, 'A5-11 只有 view_product 且地理 Unknown 時，Visitors=1/Unknown=1/Rate=100%（不再是「訪客0但Unknown100%」的另一種矛盾形態）');
  }

  // ── 8. Static Audit：ALL_FUNNEL_EVENT_NAMES 正確涵蓋，
  //      各階段（view_item/add_to_cart/checkout/purchase）語意不變 ──
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.includes('page_view'), 'A5-12 ALL_FUNNEL_EVENT_NAMES 含 page_view');
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.includes('view_product'), 'A5-13 ALL_FUNNEL_EVENT_NAMES 含 view_product');
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.includes('add_to_cart'), 'A5-14 ALL_FUNNEL_EVENT_NAMES 含 add_to_cart');
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.includes('begin_checkout'), 'A5-15 ALL_FUNNEL_EVENT_NAMES 含 begin_checkout');
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.includes('purchase'), 'A5-16 ALL_FUNNEL_EVENT_NAMES 含 purchase');
  assert(GEE.ALL_FUNNEL_EVENT_NAMES.length === 6, 'A5-17 ALL_FUNNEL_EVENT_NAMES 剛好涵蓋全部 6 個已分類事件（page_view/session_start/view_product/add_to_cart/begin_checkout/purchase）');
  {
    const S = fresh('store_a5_stage_semantics_unchanged');
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'view_product', product_id: 1, geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v2', session_id: 's2', event_name: 'add_to_cart', geo: null });
    const funnel = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(funnel.visitors === 2, 'A5-18 Visitors 正確涵蓋兩個不同階段的訪客（各自只有一種事件）');
    assert(funnel.view_item_visitors === 1, 'A5-19 view_item_visitors 仍只計算 view_product 的那 1 人（單一事件語意不變）');
    assert(funnel.add_to_cart_visitors === 1, 'A5-20 add_to_cart_visitors 仍只計算 add_to_cart 的那 1 人（單一事件語意不變）');
  }

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
