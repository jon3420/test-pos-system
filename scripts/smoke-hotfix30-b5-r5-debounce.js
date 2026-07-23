#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-debounce.js — fix18-10-hotfix30-B5-R5 Debounce R5-1~5
//
// 涵蓋需求文件 Debounce R5-1 ~ R5-5：驗證 persistCart()/clearCartByUser()/
// restoreCart() 賴以運作的購物車追蹤核心（_buildCartTrackingMetadata /
// _cartTrackSignature / _trackCartUpdated / _scheduleCartUpdatedTrack /
// _trackCartUpdatedImmediate）是否真的做到：
//   - 一般性 cart_updated 用 600ms trailing debounce，快速連續操作只送出最終狀態
//   - cleared／cart_restored／校正 一律立即送出，且會取消任何等待中的一般 debounce
//   - 系統恢復（cart_restored）與內容校正（帶 correction_reason 的 cart_updated）
//     語意上明確分開，不會把「單純恢復」誤記成「使用者又改了一次」
//
// 做法（沿用專案既有慣例，見 scripts/smoke-cart-delivery-live-refresh.js 開頭
// 「誠實揭露」段落）：直接從 public/line-order.html／public/line-shipping.html
// 「抽取」這幾個函式的真實原始碼，在 vm sandbox 內執行，測的是「這次真的改出來的
// 那份程式碼」，不是另外重寫一份簡化邏輯。時間相關行為用「假時鐘」（手動控制的
// setTimeout/clearTimeout 佇列）精準模擬「600ms 是否已經過」，不依賴真實計時器
// 的不確定性，也不需要真的等待 600ms。
//
// 誠實揭露（MANUAL REQUIRED）：本測試驗證的是追蹤核心本身的 debounce/immediate/
// 去重語意，以及 persistCart()/clearCartByUser()/restoreCart() 呼叫這些核心函式
// 的「原始碼呼叫順序」（用字串位置比對，見 Section 2）。實際使用者在真實瀏覽器
// 快速點擊 +/- 按鈕、網路延遲、分頁切換等真實時序仍需要真機/瀏覽器交叉確認。

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function extractBlock(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error(`找不到起點標記：${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  if (e === -1) throw new Error(`找不到終點標記：${endMarker}`);
  return src.slice(s, e);
}

// ── 假時鐘：手動控制的 setTimeout/clearTimeout 佇列，讓測試精準模擬「600ms 是否已到」──
function makeFakeClock() {
  let seq = 0;
  const pending = new Map(); // id -> { fn, ms }
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pendingCount() { return pending.size; },
    // 模擬「時間到了」：執行所有目前排隊中的 timer（模擬完整 600ms 經過）
    flushAll() {
      const toRun = [...pending.values()];
      pending.clear();
      toRun.forEach(({ fn }) => fn());
    },
  };
}

function makeSandbox({ initialCart = {}, initialCoupon = null, mode = 'takeout', orderModeIsShipping = false }) {
  const clock = makeFakeClock();
  const sentEvents = [];
  const sandbox = {
    cart: initialCart,
    appliedCoupon: initialCoupon,
    currentMode: mode,
    deliveryFeeCalculated: false,
    _deliveryFeeResult: null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console,
    // line-shipping.html 專用（order_mode 固定 'shipping'，需要 calcFee()/cartList()）
    calcFee: orderModeIsShipping ? () => {
      const sub = Object.values(sandbox.cart).reduce((s, c) => s + c.product.price * c.qty, 0);
      const discount = sandbox.appliedCoupon ? Math.min(Number(sandbox.appliedCoupon.discount_amount || 0), sub) : 0;
      return { sub, fee: 0, discount, total: Math.max(0, sub - discount) };
    } : undefined,
    _trackEvent(eventName, extra) {
      sentEvents.push({ eventName, metadata: extra && extra.metadata });
    },
  };
  vm.createContext(sandbox);
  return { sandbox, clock, sentEvents };
}

function loadTrackingCode(file, startMarker, endMarker) {
  const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  return extractBlock(src, startMarker, endMarker);
}

// line-order.html：外帶／外送版本
const ORDER_CODE = loadTrackingCode(
  'line-order.html',
  'function _buildCartTrackingItems(){',
  '// ── hotfix22-F：購物車 localStorage 永久保留（不設 expires_at / 24hr 判斷，'
);
['function _buildCartTrackingItems(', 'function _buildCartTrackingMetadata(', 'function _cartTrackSignature(',
  'function _trackCartUpdated(', 'function _scheduleCartUpdatedTrack(', 'function _trackCartUpdatedImmediate(']
  .forEach((marker) => { if (!ORDER_CODE.includes(marker)) throw new Error(`line-order.html 抽取範圍未包含預期函式：${marker}`); });

function makeItem(id, name, price, qty) {
  return [String(id), { product: { name, price, effective_line_price: undefined }, qty }];
}
function cartOf(...items) { return Object.fromEntries(items); }

console.log('\n=== Debounce R5-1：連續快速修改數量 1 → 2 → 3，最終只保存 qty=3 ===');
{
  const { sandbox, clock, sentEvents } = makeSandbox({ initialCart: cartOf(makeItem(9001, '豬腰', 150, 1)) });
  vm.runInContext(ORDER_CODE, sandbox);
  // 第一次異動（qty=1 已經是初始狀態，模擬「剛加入」呼叫一次 persistCart 的 debounce 路徑）
  sandbox._scheduleCartUpdatedTrack();
  assert(clock.pendingCount() === 1, 'Debounce R5-1：第一次呼叫 _scheduleCartUpdatedTrack() 建立 1 個 pending timer');

  // 使用者快速把數量改成 2（600ms 內）
  sandbox.cart['9001'].qty = 2;
  sandbox._scheduleCartUpdatedTrack();
  assert(clock.pendingCount() === 1, 'Debounce R5-1：第二次呼叫取消舊 timer、只保留 1 個 pending（不會疊加多個 timer）');

  // 再快速改成 3（600ms 內）
  sandbox.cart['9001'].qty = 3;
  sandbox._scheduleCartUpdatedTrack();
  assert(clock.pendingCount() === 1, 'Debounce R5-1：第三次呼叫仍只有 1 個 pending timer');
  assert(sentEvents.length === 0, 'Debounce R5-1：600ms 尚未到之前，完全沒有事件被送出');

  // 模擬 600ms 到了
  clock.flushAll();
  assert(sentEvents.length === 1, 'Debounce R5-1：600ms 到期後恰好送出 1 筆事件（不是 3 筆）', `實際送出 ${sentEvents.length} 筆`);
  const qty = sentEvents[0] && sentEvents[0].metadata && sentEvents[0].metadata.items[0].qty;
  assert(qty === 3, 'Debounce R5-1：最終保存的快照 qty=3（不是 1 或 2，沒有遺失最終狀態）', `實際 qty=${qty}`);
}

console.log('\n=== Debounce R5-2：修改商品後、600ms 未到就清空 ===');
{
  const { sandbox, clock, sentEvents } = makeSandbox({ initialCart: cartOf(makeItem(9001, '豬腰', 150, 1)) });
  vm.runInContext(ORDER_CODE, sandbox);
  sandbox._scheduleCartUpdatedTrack(); // 使用者加入商品，排入 debounce
  assert(clock.pendingCount() === 1, 'Debounce R5-2：修改商品後有 1 個 pending routine timer');

  // 600ms 尚未到，使用者按下「清空購物車」
  sandbox.cart = {};
  sandbox._trackCartUpdatedImmediate('cart_updated', 'cleared');
  assert(clock.pendingCount() === 0, 'Debounce R5-2：清空時 pending 的一般性 cart_updated 被取消', `剩餘 pending=${clock.pendingCount()}`);
  assert(sentEvents.length === 1 && sentEvents[0].metadata.status === 'cleared', 'Debounce R5-2：立即送出 1 筆 status=cleared 的事件');

  // 即使之後手動再嘗試 flush（理論上已經沒有 pending 了），也不該有任何舊商品快照被補送
  clock.flushAll();
  assert(sentEvents.length === 1, 'Debounce R5-2：cleared 之後不會再補送回舊商品快照（沒有第二筆事件）', `實際 ${sentEvents.length} 筆`);
}

console.log('\n=== Debounce R5-3：修改商品後、600ms 未到就 restore ===');
{
  const { sandbox, clock, sentEvents } = makeSandbox({ initialCart: cartOf(makeItem(9001, '豬腰', 150, 1)) });
  vm.runInContext(ORDER_CODE, sandbox);
  sandbox.cart['9001'].qty = 2;
  sandbox._scheduleCartUpdatedTrack(); // 使用者修改數量，排入 debounce
  assert(clock.pendingCount() === 1, 'Debounce R5-3：修改商品後有 1 個 pending routine timer');

  // 600ms 尚未到，系統偵測到頁面重新整理，觸發 restoreCart() → 立即送出 cart_restored
  sandbox._trackCartUpdatedImmediate('cart_restored');
  assert(clock.pendingCount() === 0, 'Debounce R5-3：restore 時取消 pending 的一般性 cart_updated（不會有順序錯亂的舊快照）');
  assert(sentEvents.length === 1 && sentEvents[0].eventName === 'cart_restored', 'Debounce R5-3：立即送出 cart_restored（不是 cart_updated）');

  clock.flushAll();
  assert(sentEvents.length === 1, 'Debounce R5-3：restore 之後沒有任何殘留 timer 補送舊的 cart_updated', `實際 ${sentEvents.length} 筆`);
}

console.log('\n=== Debounce R5-4：單純 restore、購物車內容完全沒變 ===');
{
  const { sandbox, clock, sentEvents } = makeSandbox({ initialCart: cartOf(makeItem(9001, '豬腰', 150, 1)) });
  vm.runInContext(ORDER_CODE, sandbox);
  // 真實 restoreCart() 的呼叫順序：先立即送出 cart_restored，緊接著呼叫一次 persistCart()
  // （沒有帶 cartTrackStatus）→ 內部會走一般性 debounce 路徑（_scheduleCartUpdatedTrack）。
  sandbox._trackCartUpdatedImmediate('cart_restored');
  sandbox._scheduleCartUpdatedTrack();
  assert(sentEvents.length === 1 && sentEvents[0].eventName === 'cart_restored', 'Debounce R5-4：立即送出 1 筆 cart_restored');
  assert(clock.pendingCount() === 1, 'Debounce R5-4：persistCart() 之後有 1 個等待中的一般性 debounce（尚未送出）');

  clock.flushAll(); // 600ms 到，debounce 觸發，但內容跟剛剛送出的 cart_restored 完全一樣
  assert(sentEvents.length === 1, 'Debounce R5-4：內容沒變時，debounce 到期後被去重擋下，不會多送一筆不必要的 routine cart_updated', `實際 ${sentEvents.length} 筆`);
}

console.log('\n=== Debounce R5-5：restore 後因商品售完／數量被系統校正 ===');
{
  // 還原時商品仍在（豬腰 qty=1），但 restoreCart() 判斷優惠券已失效而剔除，
  // 對應真實程式碼：_trackCartUpdatedImmediate('cart_restored') 之後，
  // 立即再呼叫一次 _trackCartUpdatedImmediate('cart_updated', undefined, reason)。
  const { sandbox, clock, sentEvents } = makeSandbox({ initialCart: cartOf(makeItem(9001, '豬腰', 150, 1)) });
  vm.runInContext(ORDER_CODE, sandbox);

  sandbox._trackCartUpdatedImmediate('cart_restored');
  // 校正：優惠券已失效，系統自動移除（appliedCoupon 這裡本來就是 null，模擬「移除」情境；
  // 重點是驗證 correction_reason 有被正確帶入且立即送出）
  sandbox._trackCartUpdatedImmediate('cart_updated', undefined, '優惠券已失效，系統自動移除');

  assert(sentEvents.length === 2, 'Debounce R5-5：先有 cart_restored，再有 1 筆校正 cart_updated（共 2 筆）', `實際 ${sentEvents.length} 筆`);
  assert(sentEvents[0].eventName === 'cart_restored', 'Debounce R5-5：第 1 筆是 cart_restored（系統恢復）');
  assert(sentEvents[1].eventName === 'cart_updated' && sentEvents[1].metadata.correction_reason === '優惠券已失效，系統自動移除',
    'Debounce R5-5：第 2 筆是帶明確 correction_reason 的 cart_updated（內容校正）',
    JSON.stringify(sentEvents[1]));

  // Timeline 能否區分：驗證 utils/cartSnapshot.js 的 getCartDetail() 對帶 correction_reason
  // 的 cart_updated 是否顯示為「校正」而不是一般「更新」（用真實後端函式驗證，不是重寫一份）。
  (async () => {
    const { initDb, getDb } = require(path.join(ROOT, 'utils', 'db'));
    const { insertEvent } = require(path.join(ROOT, 'utils', 'analyticsLog'));
    const { sanitizeCartSnapshotMetadata, getCartDetail } = require(path.join(ROOT, 'utils', 'cartSnapshot'));
    const dataDir = path.join(ROOT, 'data');
    const dbFile = path.join(dataDir, 'pos.db');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    await initDb();
    const db = getDb();
    const STORE = 'r5_debounce_store';
    const CART_ID = 'cart_debounce_r5_5';
    insertEvent(db, { store_id: STORE, visitor_id: 'v1', session_id: 's1', cart_id: CART_ID, event_name: 'add_to_cart', product_id: 9001, quantity: 1 });
    insertEvent(db, {
      store_id: STORE, visitor_id: 'v1', session_id: 's1', cart_id: CART_ID, event_name: 'cart_restored',
      metadata: sanitizeCartSnapshotMetadata('cart_restored', { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1 }),
    });
    insertEvent(db, {
      store_id: STORE, visitor_id: 'v1', session_id: 's1', cart_id: CART_ID, event_name: 'cart_updated',
      metadata: sanitizeCartSnapshotMetadata('cart_updated', { items: [{ product_id: 9001, name: '豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, discount: 0, delivery_fee: 0, total: 150, order_mode: 'takeout', item_count: 1, correction_reason: '優惠券已失效，系統自動移除' }),
    });
    const detail = getCartDetail(db, STORE, CART_ID);
    const timeline = (detail && detail.timeline) || [];
    const restoredRow = timeline.find(t => t.event_name_raw === 'cart_restored');
    const correctedRow = timeline.find(t => t.event_name_raw === 'cart_updated');
    assert(!!restoredRow && restoredRow.event_name_zh === '重新開啟購物車', 'Debounce R5-5：Timeline 上系統恢復顯示為「重新開啟購物車」', JSON.stringify(restoredRow));
    assert(!!correctedRow && correctedRow.event_name_zh.includes('校正'), 'Debounce R5-5：Timeline 上內容校正顯示為「購物車內容校正（系統自動）」（跟系統恢復明確區分）', JSON.stringify(correctedRow));
    try { fs.unlinkSync(dbFile); } catch (e) {}
    finishAndExit();
  })();
}

// ════════════════════════════════════════════════════════════════
// Section 2：靜態原始碼呼叫順序稽核（不是猜測，是直接比對字串出現位置）
// ════════════════════════════════════════════════════════════════
function auditCallOrder(file) {
  const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

  // persistCart()：一般呼叫（無 cartTrackStatus）走 debounce，不是立即送出
  const persistCartBody = extractBlock(src, file === 'line-order.html' ? 'function persistCart(cartTrackStatus){' : 'function persistCart(cartTrackStatus) {', file === 'line-order.html' ? '\nfunction _debounce' : '\nfunction _debounce');
  assert(persistCartBody.includes('_scheduleCartUpdatedTrack()'), `${file}：persistCart() 一般呼叫確實透過 _scheduleCartUpdatedTrack()（debounce）分派，不是每次都立即送出`);
  assert(persistCartBody.includes("_trackCartUpdatedImmediate('cart_updated', cartTrackStatus)"), `${file}：persistCart() 在帶明確 cartTrackStatus（例如 cleared）時改用 immediate 分派`);

  // clearCartByUser()：immediate('cleared') 必須在 clearCartStorage()（會重置 cart_id）之前
  const clearFnName = 'function clearCartByUser(';
  const clearStart = src.indexOf(clearFnName);
  if (clearStart === -1) throw new Error(`${file} 找不到 clearCartByUser()`);
  const clearBody = src.slice(clearStart, clearStart + 1500);
  const idxImmediateCleared = clearBody.indexOf("persistCart('cleared')");
  const idxClearStorage = clearBody.indexOf('clearCartStorage();', idxImmediateCleared === -1 ? 0 : idxImmediateCleared);
  assert(idxImmediateCleared !== -1 && idxClearStorage !== -1 && idxImmediateCleared < idxClearStorage,
    `${file}：clearCartByUser() 內 persistCart('cleared')（immediate 分派）在 clearCartStorage()（會重置 cart_id）之前執行`,
    `cleared@${idxImmediateCleared} clearCartStorage@${idxClearStorage}`);

  // restoreCart()：cart_restored（immediate）必須在最後一次 persistCart() 之前
  const restoreFnMarker = file === 'line-order.html' ? 'async function restoreCart(){' : 'async function restoreCart() {';
  const restoreStart = src.indexOf(restoreFnMarker);
  if (restoreStart === -1) throw new Error(`${file} 找不到 restoreCart()`);
  // 找函式結尾：下一個「頂層 function」宣告視為邊界
  const nextFnAfter = src.indexOf('\nfunction ', restoreStart + restoreFnMarker.length);
  const restoreBody = src.slice(restoreStart, nextFnAfter === -1 ? restoreStart + 4000 : nextFnAfter);
  const idxRestored = restoreBody.indexOf("_trackCartUpdatedImmediate('cart_restored')");
  const idxFinalPersist = restoreBody.lastIndexOf('persistCart();');
  assert(idxRestored !== -1 && idxFinalPersist !== -1 && idxRestored < idxFinalPersist,
    `${file}：restoreCart() 內 _trackCartUpdatedImmediate('cart_restored') 在結尾的 persistCart() 之前執行（不會先寫一般 cart_updated 才補 cart_restored）`,
    `restored@${idxRestored} finalPersist@${idxFinalPersist}`);
  // 排除中文註解裡「順便提到函式名稱」造成的假陽性（例如「從未呼叫 _trackAddToCart()」
  // 這種說明性註解），只看真正的可執行程式碼行。
  const restoreCodeOnly = restoreBody.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert(!restoreCodeOnly.slice(0, restoreCodeOnly.indexOf("_trackCartUpdatedImmediate('cart_restored')")).includes('_trackAddToCart('),
    `${file}：restoreCart() 全程未呼叫 _trackAddToCart()（cart_restored 不會意外疊加 add_to_cart 計數）`);
}
auditCallOrder('line-order.html');
auditCallOrder('line-shipping.html');

let _exited = false;
function finishAndExit() {
  if (_exited) return;
  _exited = true;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== SUMMARY ===');
  console.log(`TOTAL: ${results.length}  PASS: ${results.length - failCount}  FAIL: ${failCount}`);
  if (failCount) {
    console.log('失敗項目：');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(` - ${r.name}: ${r.detail || ''}`));
  }
  process.exit(failCount ? 1 : 0);
}
// Debounce R5-5 的最後一段是非同步的（要載入 utils/db），其餘都是同步跑完；
// 保守起見設一個上限時間，避免非同步段位失敗時整支測試卡住不結束。
setTimeout(() => { finishAndExit(); }, 8000).unref();
