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
        db.run(
          "UPDATE ingredients SET refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
          [newRefrig, newTotal, ing.id, storeId]
        );
        db.run(
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

  const sets   = ['status=?', 'order_status=?', 'kitchen_status=?', "updated_at=datetime('now','localtime')"];
  const params = [newStatus === 'cancelled' ? order.status : newStatus, newStatus, newStatus];
  // 注意：POS 訂單的 status 欄位（completed/void/modified）跟 order_status（工作流程狀態）意義不同，
  // 這裡的 status 只在明確取消時保留原值，避免誤把 POS 的 status 覆蓋掉；order_status 才是流程狀態。
  if (needsRefund) { sets.push("refund_status='pending_refund'"); }

  db.run(
    `UPDATE orders SET ${sets.join(',')} WHERE id=? AND store_id=?`,
    [...params, order.id, storeId]
  );

  if (newStatus === 'cancelled' && wasCancellableBefore) {
    const items = (() => {
      try { return typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); }
      catch { return []; }
    })();
    const isLineOrder = order.source === 'line' || !!order.customer_line_id;
    // hotfix13：LINE 訂單下單時不扣秤重庫存（只扣食材配方），取消時也不能回補秤重庫存，否則會多補
    restockOrderItems(db, items, order.order_number || order.id, storeId, '訂單取消回補', { includeGramsStock: !isLineOrder });

    // LINE 今日份數 / 預購份數回補（僅 LINE 來源訂單需要）
    if (isLineOrder) {
      const cancelDateStr   = (order.pickup_time || '').slice(0, 10);
      const twNow           = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const todayForCancel  = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
      const cancelIsPreorder = cancelDateStr && cancelDateStr > todayForCancel;
      const items2 = (() => {
        try { return typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); }
        catch { return []; }
      })();
      items2.forEach(item => {
        const pid = item.product_id || item.id;
        if (!pid) return;
        const qty = Number(item.qty || 1);
        if (cancelIsPreorder) {
          db.run(`UPDATE products SET line_preorder_sold = MAX(0, line_preorder_sold - ?),
            updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [qty, pid, storeId]);
        } else {
          db.run(`UPDATE products SET line_quota_sold = MAX(0, line_quota_sold - ?),
            updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [qty, pid, storeId]);
        }
      });
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
};
