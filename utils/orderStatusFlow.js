// utils/orderStatusFlow.js — hotfix13-BUG7
// ─────────────────────────────────────────────────────────────
// 統一 Order Status Flow（外帶 / 外送 / LINE 訂單 共用同一組狀態機）
//
// 為什麼要有這個檔案：
//   修 hotfix13 之前，orders.js（POS / Web 現場訂單）與 line-orders.js
//   （LINE 點餐）各自維護一份「合法狀態清單」，兩邊欄位、中文標籤、
//   可轉換的狀態都不一樣，導致 Web 後台跟 Android 平板看到的狀態
//   名稱、可執行的動作會不一致。
//
//   這裡把「狀態是什麼」「中文顯示什麼顏色」「哪個狀態可以轉去哪個
//   狀態」全部集中在後端這一份設定檔，orders.js / line-orders.js
//   都改成引用這裡的內容做驗證；Web 前端與 Android 則透過
//   GET /api/orders/status-flow（或啟動時的 GET /api/sync/config）
//   拿到同一份資料來畫畫面，不再各自寫死一份中文對照表。
'use strict';

// 完整狀態集合（所有訂單模式共用同一組字串，不會因為外帶/外送而改名）
const ORDER_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'completed', 'cancelled'];

const ORDER_STATUS_LABEL = {
  pending:    '待接單',
  accepted:   '已接單',
  preparing:  '製作中',
  ready:      '可取餐',
  delivering: '配送中',
  completed:  '已完成',
  cancelled:  '已取消',
};

// 各訂單模式的「建議流程」（給前端畫步驟條 / 下一步按鈕用，後端驗證不強制卡在這個順序，
// 只要是 ORDER_STATUSES 內的值都允許轉換，避免跟舊資料或跨裝置操作衝突）
const ORDER_STATUS_FLOW_BY_MODE = {
  dine_in:  ['pending', 'preparing', 'completed'],
  takeout:  ['pending', 'accepted', 'preparing', 'ready', 'completed'],
  delivery: ['pending', 'accepted', 'preparing', 'ready', 'delivering', 'completed'],
};

// 哪些狀態允許直接取消（completed / cancelled 不可再取消）
function isCancellable(currentStatus) {
  return !['completed', 'cancelled'].includes(currentStatus);
}

function isValidOrderStatus(status) {
  return ORDER_STATUSES.includes(status);
}

// 退款狀態（hotfix13-BUG6：LinePay 已付款訂單取消 → 待退款流程）
const REFUND_STATUSES = ['', 'pending_refund', 'refunded'];
const REFUND_STATUS_LABEL = {
  '':               '',
  pending_refund:   '待退款',
  refunded:         '已退款',
};

// 判斷一筆訂單取消時，是否需要進入「待退款」流程
// 規則：LinePay 且已經付款成功（payment_status === 'paid'）的訂單，取消時不能直接視為
// 金流結束，必須提醒店家去 LINE Pay 商家後台或用其他方式退款給顧客。
function requiresRefundOnCancel(order) {
  const payMethod = order.payment_method || '';
  const payStatus = order.payment_status || '';
  return payMethod === 'linepay' && payStatus === 'paid';
}

// ─────────────────────────────────────────────────────────────
// hotfix13：唯一一份「訂單取消時如何回補庫存」的邏輯。
// 之前 orders.js（POS）跟 line-orders.js（LINE）各寫一份，而且
// Android 呼叫的 routes/online-orders.js 完全沒有回補——三邊行為
// 都不一樣。現在統一走這裡：
//   1. 商品若有食材配方（product_ingredient_formulas）→ 回補食材冷藏庫存
//   2. 否則若商品本身有秤重庫存（allocated_grams）→ 回補商品庫存
// ─────────────────────────────────────────────────────────────
const { fromGrams } = require('./unitConvert');

function restockOrderItems(db, items, orderId, storeId, reason, opts = {}) {
  // hotfix13：LINE 點餐下單時（routes/line-orders.js deductIngredients）只會扣「食材配方」庫存，
  // 完全不會動商品本身的秤重庫存（allocated_grams / current_stock_grams）——這是既有設計
  // （註解：「LINE 點餐不檢查食材庫存，只適用現場 POS」）。
  // 所以取消 LINE 訂單時，絕對不能對秤重庫存做回補，否則會無中生有多補一次庫存。
  // includeGramsStock 預設 true（給 POS/Web 訂單用，deductInventory 本來就是配方優先、否則才扣秤重庫存）。
  //
  // H1.4.12 Phase 3C R35：這個函式現在可能在 BEGIN/COMMIT 交易內被呼叫
  // （cancel/void 的 atomic 重構），所以食材配方這條分支的寫入全部改用
  // db._db.run()（raw、不自動 _save()），呼叫端自己在 COMMIT 後統一存
  // 一次。db.all()/db.get() 是純讀取，本來就不會 auto-save，不用改。
  //
  // 已知、刻意保留的缺口（本輪範圍內沒有處理，如實記錄）：底下「沒有
  // 配方、走秤重庫存」那條分支（含呼叫 routes/inventory.js 的
  // writeInventoryLog()）仍然用會自動 _save() 的 db.run()。目前唯一會呼叫
  // 這個函式的兩個地方是 LINE 訂單 cancel/void（帶
  // includeGramsStock:false，這條分支整個不會被執行、直接 return），所以
  // 現有 ingredient fixture 測試不會踩到這個缺口；但如果未來 POS/Web
  // 訂單（includeGramsStock 預設 true）也需要在交易內呼叫這個函式，這條
  // 分支必須先一併轉成 raw 寫入。
  const includeGramsStock = opts.includeGramsStock !== false;
  (items || []).forEach(item => {
    const pid = item.productId || item.product_id || item.id;
    if (!pid) return;
    const qty = Number(item.qty || 1);

    const formulas = db.all('SELECT * FROM product_ingredient_formulas WHERE product_id=?', [pid]);
    if (formulas.length > 0) {
      formulas.forEach(f => {
        const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [f.ingredient_id, storeId]);
        if (!ing) return;
        const perUnitG     = Number(f.amount_per_unit) * qty;
        const returnInUnit = fromGrams(perUnitG, ing.unit || 'g');
        const bRefrig      = Number(ing.refrigerated_stock || 0);
        const newRefrig    = bRefrig + returnInUnit;
        const newTotal     = Number(ing.total_stock || 0) + returnInUnit;
        const updResult = db._db.run(
          "UPDATE ingredients SET refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
          [newRefrig, newTotal, ing.id, storeId]
        );
        db._db.run(
          `INSERT INTO ingredient_logs
           (ingredient_id,ingredient_name,log_type,before_refrigerated,change_amount,after_refrigerated,
            before_frozen,before_thawing,after_frozen,after_thawing,reason,related_order_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ing.id, ing.name, 'order_cancel_return', bRefrig, returnInUnit, newRefrig,
           ing.frozen_stock, ing.thawing_stock, ing.frozen_stock, ing.thawing_stock,
           reason || '訂單取消回補', orderId || '']
        );
      });
      return;
    }

    if (!includeGramsStock) return; // LINE 訂單：沒有配方就代表下單當下沒有扣過任何庫存，不用回補

    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    if (!prod || !prod.inventory_enabled || !prod.allocated_grams) return;
    const returnG = prod.allocated_grams * qty;
    const before  = Number(prod.current_stock_grams || 0);
    const after   = before + returnG;
    db.run(
      "UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [after, pid, storeId]
    );
    try {
      const { writeInventoryLog } = require('../routes/inventory');
      writeInventoryLog(db, pid, prod.name, 'order_cancel_return', before, returnG, after, reason || '訂單取消回補', orderId, 'staff', storeId);
    } catch { /* inventory 模組不可用時不中斷主流程 */ }
  });
}

// ─────────────────────────────────────────────────────────────
// 唯一一份「訂單狀態變更」的商業邏輯，orders.js / line-orders.js /
// online-orders.js 三支路由 & Android 都透過各自的 API 呼叫到這裡，
// 確保取消規則、退款規則、回補規則三邊完全一致。
//
// 呼叫端負責：驗證 order 存在、店家權限（store_id）、以及依需求
// broadcast websocket、觸發 webhook；這裡只負責「狀態怎麼變、
// 庫存怎麼補、要不要進待退款」這件事本身。
// ─────────────────────────────────────────────────────────────
function applyOrderStatusChange(db, storeId, order, newStatus) {
  if (!isValidOrderStatus(newStatus)) {
    return { ok: false, code: 400, message: '無效的狀態值: ' + newStatus };
  }
  if (newStatus === 'cancelled' && !isCancellable(order.order_status)) {
    return { ok: false, code: 400, message: '訂單已完成或已取消，無法再次取消' };
  }

  const needsRefund = newStatus === 'cancelled' && requiresRefundOnCancel(order);
  const wasCancellableBefore = isCancellable(order.order_status);
  const isPopupOrder = order.pickup_type === 'popup';

  const sets   = ['status=?', 'order_status=?', 'kitchen_status=?', "updated_at=datetime('now','localtime')"];
  const params = [newStatus === 'cancelled' ? order.status : newStatus, newStatus, newStatus];
  // 注意：POS 訂單的 status 欄位（completed/void/modified）跟 order_status（工作流程狀態）意義不同，
  // 這裡的 status 只在明確取消時保留原值，避免誤把 POS 的 status 覆蓋掉；order_status 才是流程狀態。
  if (needsRefund) { sets.push("refund_status='pending_refund'"); }
  const updateSql = `UPDATE orders SET ${sets.join(',')} WHERE id=? AND store_id=?`;
  const updateParams = [...params, order.id, storeId];

  if (newStatus === 'cancelled' && wasCancellableBefore && isPopupOrder && order.popup_session_id) {
    // H1.4.12 Phase 3A.2 修正：popup 訂單取消時，「訂單狀態變更」與
    // 「allocation release」必須是同一個 raw BEGIN/COMMIT transaction——
    // 交易內完全使用 db._db.run()（不會自行 _save() 的版本），COMMIT 成功
    // 後由 db.runDurableTransaction() 做 atomic file write（R44.2F，取代舊的手動 save）。任一步驟失敗（含 release SQL 本身失敗）
    // 都會 ROLLBACK，讓這個函式往外拋出例外（不吞錯誤、不回傳「假成功」），
    // 呼叫端的 route handler 會被外層 try/catch 接住轉成 500——訂單狀態與
    // allocation 都會維持交易前的狀態，不會出現「訂單已取消但份數沒放出來」
    // 或「份數放出來了但訂單其實沒有真的被取消」這種不一致。
    const { releasePopupOrderAllocations } = require('./popupCheckout');
    // R44.2F：改用 db.runDurableTransaction()——COMMIT 後 disk 寫入失敗時，memory 與 disk 都回到交易前狀態。
    db.runDurableTransaction(() => {
      db._db.run(updateSql, updateParams);
      releasePopupOrderAllocations(db, storeId, order.id, order.popup_session_id);
    });
  } else {
    let counterClassification = null; // 只有非 popup 的標準 LINE 訂單才需要
    if (newStatus === 'cancelled' && wasCancellableBefore && !isPopupOrder) {
      const isLineOrder = order.source === 'line' || !!order.customer_line_id;
      if (isLineOrder) {
        // R44.2B：移除舊的 classifyPersistedOrder()（pickup_time 字串）pre-check。
        // authority 順序：popup 走 popup allocation；LINE／Shipping 以 valid v1
        // snapshot 為主（restoreLineQuotaCounters 在交易內判斷：snapshot=NULL →
        // snapshot-missing 409；invalid snapshot／bucket → 409；全部 rollback）。
        // pickup_time 不得凌駕 valid snapshot。
        counterClassification = 'snapshot-authority';
      }
    }

    // H1.4.12 Phase 3C R35：狀態變更、LINE quota/preorder counter 回補、
    // 一般食材/秤重庫存回補，三者現在是同一個 BEGIN/COMMIT/ROLLBACK 交易
    // ——上一輪只把狀態跟 counter 綁在一起，restock 還是交易外的獨立步驟，
    // 任一步失敗都可能留下「訂單已取消但庫存沒回補」的半套狀態。
    // restockOrderItems() 內部食材配方分支已經改用 db._db.run()（見上方
    // R35 說明），可以安全放進交易；分類已經在上面驗證過，不會再遇到
    // invalid。
    const items = (() => {
      try { return typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); }
      catch { return []; }
    })();
    const isLineOrderForRestock = order.source === 'line' || !!order.customer_line_id;

    // R44.2F：durable transaction（BEGIN／COMMIT／atomic file write 由 helper 管理）。
    let restoreResultForFailClosed = null;
    try {
      db.runDurableTransaction(() => {
        db._db.run(updateSql, updateParams);
        if (counterClassification) {
          const r = restoreLineQuotaCounters(db, storeId, order, counterClassification);
          if (!r.ok) { restoreResultForFailClosed = r; throw new Error('LINE_COUNTER_ALLOCATION_SNAPSHOT_INVALID'); }
        }
        if (newStatus === 'cancelled' && wasCancellableBefore && !isPopupOrder) {
          restockOrderItems(db, items, order.order_number || order.id, storeId, '訂單取消回補', { includeGramsStock: !isLineOrderForRestock });
        }
      });
    } catch (e) {
      if (restoreResultForFailClosed) return restoreResultForFailClosed; // fail closed：整個 rollback 後直接回結構化錯誤，不繼續往外拋成 500
      throw e;
    }
  }

  const updated = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId]);
  return {
    ok: true,
    code: 200,
    data: updated,
    requiresRefund: needsRefund,
    message: needsRefund ? '訂單已取消，該筆為 LINE Pay 已付款訂單，請至待退款清單處理退款' : undefined,
  };
}

// H1.4.12 Phase 3C 稽核修正（P0）：canonical preorder 分類器，建立與回補
// 共用同一個判斷依據，不再各自維護一套邏輯。
//
// 優先依據：order.pickup_date（真正儲存在 orders 表的欄位，routes/line-orders.js
// 建單時就是拿它跟 twDateStr() 比較 `orderDate > todayStr` 來決定
// isPreorderOrder——這裡回補時用同一個欄位、同一種比較方式，保證建立與
// 取消一定分類一致，不會出現「建立時算今日單，取消時卻回補到預購欄位」
// 這種資料錯亂）。
//
// Legacy fallback：只有在這張訂單根本沒有存 pickup_date（比這個欄位還早
// 建立的舊資料）時，才退回舊版的 pickup_time 字串格式判斷
// （長度>10 且同時含 '-' 與空白），維持對舊資料的相容回補能力。
// H1.4.12 Phase 3C 稽核更正（重要）：上一版以為 order.pickup_date 是真正
// 存在的欄位，據此「修正」成用它做 canonical 判斷——但直接查 utils/db.js
// 的 orders CREATE TABLE／所有 ALTER TABLE 之後，確認 orders 表從來沒有
// pickup_date 這個欄位；routes/line-orders.js 的 `pickup_date` 只是從
// request body 解構出來、用來算當次 isPreorderOrder 的暫時變數，從未存進
// DB。那個版本一旦真的執行 cancel 就會直接丟出「no such column:
// pickup_date」，是本輪稽核時才發現並攔下的第二個真實 bug。
//
// 現在退回到唯一真正持久化的訊號：order.pickup_time 的字串格式判斷（跟
// 建立時完全不同的判斷依據——這是原本程式碼真實存在的限制，不是這次才
// 引入的）。要讓建立與取消真正使用同一個 canonical 判斷，需要先讓
// orders 表實際多存一個 pickup_date 或 is_preorder 欄位，這是需要 schema
// migration 的改動，超出這次修正的安全範圍，如實記錄為待辦，不在這裡
// 用不存在的欄位假裝已經解決。
// H1.4.12 Phase 3C R33 稽核修正：嚴格 persisted-order 分類器，回傳只能是
// 'same_day' / 'preorder' / 'invalid'。舊版只憑「有沒有 dash、長度是否
// >10」判斷，這裡改成：
//   1. 嚴格 `HH:mm`（無日期）→ same_day。
//   2. 嚴格 `YYYY-MM-DD HH:mm`：用真正的日曆往返驗證（拒絕 2026-02-30
//      這種 Date.parse() 會自動 rollover 吃掉的假日期），把日期部分拿去
//      跟這張訂單自己的 created_at（twNow() 寫入、本來就是台北當地時間
//      字串，直接取前 10 碼即為建立當下的台北營業日，不需要再轉時區、
//      也不依賴主機 TZ）比較：
//        相同 → same_day（含修正前遺留、same-day 卻帶了日期的 legacy row）
//        晚於建立日 → preorder
//        早於建立日 → invalid（理論上不該出現，fail closed，不猜任一邊）
//   3. 其他格式（含空字串、非日曆日期、多餘字元、T 分隔、秒數、時區
//      後綴等不符合上面兩種嚴格格式的情況）→ invalid，fail closed。
// 關鍵：一律用「建立當下的台北營業日」而不是「取消當下是不是還沒到」，
// 這樣同一張訂單在取貨日當天取消，仍然會被正確分類成預購單。
function isRealCalendarDate(y, mo, da) {
  const d = new Date(Date.UTC(y, mo - 1, da));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da;
}
function classifyPersistedOrder(order) {
  // H1.4.12 Phase 3C R34：line_counter_bucket 是最高 authority，標準 LINE
  // 訂單建立時就會寫死。只有 bucket 是 NULL（representing 這張訂單建立於
  // 加這個欄位之前的 legacy row，或本來就不是標準 LINE 訂單）時，才退回
  // 「可證明」的 legacy fallback；bucket 若是非法字串（既不是 quota 也不是
  // preorder），直接 invalid，不嘗試猜。
  if (order.line_counter_bucket === 'quota') return 'same_day';
  if (order.line_counter_bucket === 'preorder') return 'preorder';
  if (order.line_counter_bucket != null && order.line_counter_bucket !== '') return 'invalid';

  const pt = order.pickup_time || '';
  if (pt === '') return 'invalid'; // R34 更正：空字串在沒有 bucket authority 時無法安全判斷是「同日 ASAP」還是「舊版 bug 產生的預購單」，不能再假設是 same_day
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(pt)) return 'same_day';
  const m = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):[0-5]\d$/.exec(pt);
  if (!m) return 'invalid';
  const [, yStr, moStr, daStr] = m;
  const y = Number(yStr), mo = Number(moStr), da = Number(daStr);
  if (!isRealCalendarDate(y, mo, da)) return 'invalid';
  const createdDateStr = String(order.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(createdDateStr)) return 'invalid'; // created_at 本身格式不可靠，不猜
  const pickupDateStr = `${yStr}-${moStr}-${daStr}`;
  if (pickupDateStr === createdDateStr) return 'same_day';
  if (pickupDateStr > createdDateStr) return 'preorder';
  return 'invalid';
}
// 保留舊函式名稱作 boolean 相容 shim，但改呼叫新的嚴格分類器，避免兩套
// heuristic 各自漂移；呼叫端（下面的 restoreLineQuotaCounters）之後會直接
// 改用 classifyPersistedOrder()。
function classifyOrderAsPreorder(order) {
  return classifyPersistedOrder(order) === 'preorder';
}

// H1.4.12 R44.1B-2：從 persisted order.items 建立「安全聚合」的 product_id→qty
// 表，純 read-only、不做任何 DB write。任何格式問題一律回傳 null（呼叫端
// 視為 invalid，fail closed）。這是 snapshot cross-validation 的唯一資料
// 來源，不重新實作第二套 parser。
function aggregateOrderItemsQty(itemsRaw) {
  let items;
  try { items = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw; } catch { return null; }
  if (!Array.isArray(items)) return null;
  const agg = new Map();
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
    const pid = it.product_id != null ? it.product_id : it.id;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const qty = it.qty;
    if (!Number.isSafeInteger(qty) || qty <= 0) return null;
    const next = (agg.get(pid) || 0) + qty;
    if (!Number.isSafeInteger(next)) return null; // aggregate overflow
    agg.set(pid, next);
  }
  return agg;
}

// H1.4.12 Phase 3C R43：嚴格解析 versioned allocation snapshot。
// 格式：{"version":1,"allocations":[{"product_id":301,"counter_bucket":"quota","qty":2}]}
// 回傳 { ok:true, allocations } 或 { ok:false }——ok:false 代表這個 snapshot
// 存在但格式不合法（不是 NULL），呼叫端必須 fail closed，不能猜測。
function parseAllocationSnapshot(raw, orderBucket) {
  if (raw == null || raw === '') return { ok: true, allocations: null }; // NULL：沒有 snapshot authority（legacy）
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  if (parsed.version !== 1) return { ok: false };
  if (!Array.isArray(parsed.allocations)) return { ok: false };
  // R44.1：top-level 只能有 version、allocations 兩個 key，不能有多餘欄位。
  if (Object.keys(parsed).some((k) => k !== 'version' && k !== 'allocations')) return { ok: false };
  const clean = [];
  for (const a of parsed.allocations) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false };
    // R44.1：allocation row 只能有 product_id、counter_bucket、qty 三個 key。
    if (Object.keys(a).some((k) => k !== 'product_id' && k !== 'counter_bucket' && k !== 'qty')) return { ok: false };
    if (a.counter_bucket !== 'quota' && a.counter_bucket !== 'preorder') return { ok: false };
    if (!Number.isSafeInteger(a.product_id) || a.product_id <= 0) return { ok: false };
    if (!Number.isSafeInteger(a.qty) || a.qty <= 0) return { ok: false };
    // R44.1：order-level bucket 與每一筆 allocation 的 bucket 必須一致
    // （standard LINE 整張訂單只有一個 bucket；shipping 的 allocation
    // 也只能是 quota）。不一致代表資料損壞，fail closed，不猜哪一個對。
    if (orderBucket != null && a.counter_bucket !== orderBucket) return { ok: false };
    clean.push({ product_id: a.product_id, counter_bucket: a.counter_bucket, qty: a.qty });
  }
  // duplicate product+bucket 聚合，聚合結果仍須 safe integer
  const grouped = new Map();
  for (const a of clean) {
    const key = a.product_id + '|' + a.counter_bucket;
    const next = (grouped.get(key) || 0) + a.qty;
    if (!Number.isSafeInteger(next)) return { ok: false };
    grouped.set(key, next);
  }
  const aggregated = [...grouped.entries()].map(([key, qty]) => {
    const [product_id, counter_bucket] = key.split('|');
    return { product_id: Number(product_id), counter_bucket, qty };
  });
  return { ok: true, allocations: aggregated };
}

function restoreLineQuotaCounters(db, storeId, order, precomputedClassification) {
  const isLineOrder = order.source === 'line' || !!order.customer_line_id;
  if (!isLineOrder) return { ok: true };

  const snap = parseAllocationSnapshot(order.line_counter_allocation_snapshot, order.line_counter_bucket);
  if (!snap.ok) {
    // 非 NULL 但格式不合法的 snapshot：資料損壞，fail closed，不猜。
    return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_SNAPSHOT_INVALID',
      message: '這張訂單的份數配額紀錄資料損壞，無法安全恢復，請聯絡系統管理員手動處理' };
  }

  if (snap.allocations !== null) {
    // H1.4.12 Phase 3C R43：versioned per-item snapshot 是最高 authority
    // ——每筆 allocation 自己帶 bucket，不再依賴訂單層級的單一分類，也
    // 完全不會誤扣從未真正被扣過的商品（即使是 empty allocations=[]，
    // 這裡就是單純不做任何 UPDATE，正確行為）。
    // H1.4.12 R44.1B-2 稽核修正（三個真實 P0，已用真實 HTTP+raw DB 重現）：
    // 先前完全沒有拿 snapshot 去跟 persisted order.items 交叉比對，導致：
    //   (a) snapshot 若指向「同店但錯的」商品，會扣錯商品、真正該恢復的
    //       商品永遠不恢復；
    //   (b) snapshot qty 若比訂單實際購買數量小，永久少恢復一部分；
    //   (c) snapshot qty 若比訂單實際購買數量大，會多恢復，導致 counter
    //       比真實已占用的量還低，等同店家可能誤判還有空位而超賣。
    // 這裡在任何 UPDATE 之前，先用純 read-only 的方式重建 order.items 的
    // 安全聚合表，逐筆比對每個 allocation 的 product_id 是否存在、qty
    // 是否「完全相等」；任一筆對不上就整批 fail closed，不猜、不部分
    // 恢復。允許 order.items 包含未參與 counter 的商品（snapshot 不需要
    // 覆蓋全部 items），但 snapshot 裡出現的每一筆都必須能在 order.items
    // 精確對得上。
    if (snap.allocations.length > 0) {
      const orderedQty = aggregateOrderItemsQty(order.items);
      if (orderedQty === null) {
        return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_ITEMS_INVALID',
          message: '這張訂單的商品明細資料損壞，無法安全恢復份數配額，請聯絡系統管理員手動處理' };
      }
      for (const a of snap.allocations) {
        if (!orderedQty.has(a.product_id) || orderedQty.get(a.product_id) !== a.qty) {
          return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_QTY_MISMATCH',
            message: '這張訂單的份數配額紀錄與實際購買數量不一致，無法安全恢復，請聯絡系統管理員手動處理' };
        }
      }
    }
    // R44.1B-3 稽核：用真實 mixed valid+invalid allocation 重現過
    // 「第一筆 legit allocation 的 UPDATE 已經真的執行、counter 已經被
    // 動過，才在第二筆 unknown allocation 上偵測到失敗」這個內部執行
    // 順序（standalone 呼叫這個函式會看到 partial write）。稽核也確認了
    // 兩個真實 caller（cancel／void）都在 db.runDurableTransaction() 內
    // 呼叫，任何 throw 都會觸發 SQL 層級 ROLLBACK，把包括第一筆在內的
    // 所有已執行 UPDATE 一併撤銷，所以目前 production 並未因此留下壞資料
    // ——但仍在這裡加上 defense-in-depth：先用同店批次 SELECT 確認所有
    // allocation 的 product_id 都真實存在且屬於這家店，完全比對兩個
    // ID 集合是否相等，通過後才進入 UPDATE loop；empty-v1（allocations
    // 長度為 0）完全不會執行這段查詢或任何 UPDATE。這樣即使未來出現
    // 不在交易內呼叫這個函式的新 caller，也不會發生任何一筆 partial
    // write，不只是依賴呼叫端的 rollback。
    if (snap.allocations.length > 0) {
      const allocIds = [...new Set(snap.allocations.map((a) => a.product_id))];
      const placeholders = allocIds.map(() => '?').join(',');
      const found = db.all(`SELECT id FROM products WHERE store_id=? AND id IN (${placeholders})`, [storeId, ...allocIds]);
      const foundIds = new Set(found.map((r) => r.id));
      if (foundIds.size !== allocIds.length || allocIds.some((id) => !foundIds.has(id))) {
        return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_PRODUCT_INVALID',
          message: '這張訂單的份數配額紀錄指向不存在或不屬於本店的商品，無法安全恢復，請聯絡系統管理員手動處理' };
      }
    }
    for (const a of snap.allocations) {
      if (a.counter_bucket === 'preorder') {
        db._db.run(`UPDATE products SET line_preorder_sold = MAX(0, line_preorder_sold - ?),
          updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [a.qty, a.product_id, storeId]);
      } else {
        db._db.run(`UPDATE products SET line_quota_sold = MAX(0, line_quota_sold - ?),
          updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [a.qty, a.product_id, storeId]);
      }
      if (db._db.getRowsModified() !== 1) {
        return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_PRODUCT_INVALID',
          message: '這張訂單的份數配額紀錄指向不存在或不屬於本店的商品，無法安全恢復，請聯絡系統管理員手動處理' };
      }
    }
    return { ok: true };
  }

  // H1.4.12 Phase 3C R44：snapshot 是 NULL 時，對「可能操作過 LINE
  // counter」的訂單一律 fail closed，不再遍歷 order.items、不再讀商品
  // 目前設定猜測、不再只因 line_counter_bucket 有合法值就還原——這是
  // R44 稽核明確要求的政策（上一輪暫緩的技術債，這裡正式關閉）。
  return { ok: false, code: 409, error: 'LINE_COUNTER_ALLOCATION_SNAPSHOT_MISSING',
    message: '這張訂單缺少份數配額快照，無法安全判定應恢復哪些商品的份數，請聯絡系統管理員手動處理' };
}

module.exports = {
  ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_FLOW_BY_MODE,
  isCancellable,
  isValidOrderStatus,
  REFUND_STATUSES,
  REFUND_STATUS_LABEL,
  requiresRefundOnCancel,
  restockOrderItems,
  applyOrderStatusChange,
  restoreLineQuotaCounters,
  classifyPersistedOrder,
  aggregateOrderItemsQty,
};
