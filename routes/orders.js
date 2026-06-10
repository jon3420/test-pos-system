// routes/orders.js — SaaS R1 fix2（多店隔離完整版）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getProductInventoryStatus } = require('../utils/inventoryHelper');
const { v4: uuidv4 } = require('uuid');
const fetch    = require('node-fetch');
const { writeInventoryLog } = require('./inventory');

// ── helpers ───────────────────────────────────────────────
function orderNumber() {
  const n = new Date(), p = (v, l=2) => String(v).padStart(l,'0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

function parseOrder(o) {
  if (!o) return null;
  return {
    ...o,
    items:                    typeof o.items === 'string' ? JSON.parse(o.items) : o.items,
    received_amount:          Number(o.received_amount          || 0),
    change_amount:            Number(o.change_amount            || 0),
    total:                    Number(o.total                    || 0),
    subtotal:                 Number(o.subtotal                 || 0),
    platform_commission_rate:   Number(o.platform_commission_rate   || 0),
    platform_commission_amount: Number(o.platform_commission_amount || 0),
    store_actual_income:        Number(o.store_actual_income        || 0),
    delivery_fee:             Number(o.delivery_fee             || 0),
    discount_amount:          Number(o.discount_amount          || 0),
    guest_count:              Number(o.guest_count              || 0),
    platform_order_no:        o.platform_order_no || '',
    delivery_status:          o.delivery_status   || '',
  };
}

/**
 * 扣除庫存（含食材扣料）
 * ★ fix2：所有 products / ingredients 查詢都加 AND store_id=?
 */
function deductInventory(db, items, orderId, action, storeId) {
  const sid = storeId || 'store_001';
  items.forEach(item => {
    const pid = item.productId || item.product_id;
    if (!pid) return;

    // 檢查是否有扣料公式（食材控管）
    const formulas = db.all(
      'SELECT f.*,i.name as ing_name FROM product_ingredient_formulas f ' +
      'LEFT JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=? ' +
      'WHERE f.product_id=?',
      [sid, pid]
    );

    if (formulas.length > 0) {
      formulas.forEach(f => {
        // 必須確認食材屬於本店
        const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [f.ingredient_id, sid]);
        if (!ing) return;
        const perUnitG     = Number(f.amount_per_unit) * Number(item.qty || 1);
        const deductInUnit = fromGrams(perUnitG, ing.unit || 'g');
        const bRefrig      = Number(ing.refrigerated_stock || 0);
        const newRefrig    = Math.max(0, bRefrig - deductInUnit);
        const newTotal     = Math.max(0, Number(ing.total_stock || 0) - deductInUnit);
        db.run(
          "UPDATE ingredients SET refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
          [newRefrig, newTotal, ing.id, sid]
        );
        db.run(
          `INSERT INTO ingredient_logs
           (ingredient_id,ingredient_name,log_type,before_refrigerated,change_amount,after_refrigerated,
            before_frozen,before_thawing,after_frozen,after_thawing,reason,related_order_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ing.id, ing.name, 'sale_deduct', bRefrig, -deductInUnit, newRefrig,
           ing.frozen_stock, ing.thawing_stock, ing.frozen_stock, ing.thawing_stock,
           'POS結帳扣料', orderId || '']
        );
      });
      return; // 不扣商品庫存
    }

    // 無扣料公式 → 商品庫存邏輯，加 AND store_id=?
    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, sid]);
    if (!prod || !prod.inventory_enabled || !prod.allocated_grams) return;
    const deductG = prod.allocated_grams * item.qty;
    const before  = Number(prod.current_stock_grams || 0);
    const after   = Math.max(0, before - deductG);
    db.run(
      "UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [after, pid, sid]
    );
    writeInventoryLog(db, pid, prod.name, action, before, -deductG, after, '結帳扣庫存', orderId, 'staff', sid);
  });
}

/**
 * 回補庫存（作廢 / 修改舊品項）
 * ★ fix2：products 查詢加 AND store_id=?
 */
function returnInventory(db, items, orderId, action, storeId) {
  const sid = storeId || 'store_001';
  items.forEach(item => {
    const pid = item.productId || item.product_id;
    if (!pid) return;
    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, sid]);
    if (!prod || !prod.inventory_enabled || !prod.allocated_grams) return;
    const returnG = prod.allocated_grams * item.qty;
    const before  = Number(prod.current_stock_grams || 0);
    const after   = before + returnG;
    db.run(
      "UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [after, pid, sid]
    );
    writeInventoryLog(db, pid, prod.name, action, before, returnG, after, '回補庫存', orderId, 'staff', sid);
  });
}

// ── Webhook（settings 已在 fix1 加 store_id）─────────────
async function sendWebhook(order) {
  const db  = getDb();
  const sid = order.store_id || 'store_001';
  const s   = db.get("SELECT value FROM settings WHERE store_id=? AND key='n8n_webhook_url'", [sid]);
  if (!s?.value) return;
  const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
  try {
    await fetch(s.value, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: order.order_number, createdAt: order.created_at,
        customer: { name: order.customer_name || '', phone: order.customer_phone || '' },
        items, paymentMethod: order.payment_method, total: order.total, note: order.note || ''
      }), timeout: 8000
    });
  } catch(e) { console.error('Webhook error:', e.message); }
}

function buildDateWhere(query, storeId) {
  const { date, date_from, date_to } = query;
  const sid = storeId || 'store_001';
  if (date) return { clause: "store_id=? AND DATE(created_at)=?", params: [sid, date] };
  if (date_from && date_to) return { clause: "store_id=? AND DATE(created_at)>=? AND DATE(created_at)<=?", params: [sid, date_from, date_to] };
  return { clause: "store_id=? AND DATE(created_at)=?", params: [sid, new Date().toISOString().slice(0,10)] };
}

// ── 列印模式 ─────────────────────────────────────────────
function getPrintMode() {
  if (process.env.PRINT_MODE) return process.env.PRINT_MODE;
  if (process.env.NODE_ENV === 'production') return 'queue';
  return 'direct';
}

function ensurePrintJobsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id      TEXT    NOT NULL DEFAULT 'store_001',
      order_id      TEXT    DEFAULT '',
      type          TEXT    NOT NULL DEFAULT 'receipt',
      payload       TEXT    NOT NULL DEFAULT '{}',
      status        TEXT    NOT NULL DEFAULT 'pending',
      error_message TEXT    DEFAULT '',
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      printed_at    TEXT    DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_pending
      ON print_jobs(status, store_id);
  `);
}

function enqueueJob(order, type) {
  try {
    const db = getDb();
    ensurePrintJobsTable(db);
    const storeId = order.store_id || 'store_001';
    const orderId = order.order_number || order.id || '';
    const result = db.run(
      `INSERT INTO print_jobs (store_id, order_id, type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now','localtime'))`,
      [storeId, orderId, type, JSON.stringify(order)]
    );
    console.log(`[PrintJobs] 建立 ${type} 任務 #${result.lastInsertRowid} → order: ${orderId}`);
  } catch (e) {
    console.error(`[PrintJobs] 建立 ${type} 任務失敗:`, e.message);
  }
}

async function autoPrintOrEnqueue(order) {
  const mode = getPrintMode();
  if (mode === 'queue') {
    enqueueJob(order, 'receipt');
    try {
      const db  = getDb();
      const sid = order.store_id || 'store_001';
      // ★ fix2：print_kitchen settings 查詢加 store_id
      const kitchenRow = db.get("SELECT value FROM settings WHERE store_id=? AND key='print_kitchen'", [sid]);
      const needKitchen = kitchenRow ? kitchenRow.value !== '0' : true;
      if (needKitchen) enqueueJob(order, 'kitchen');
    } catch (e) { console.error('[AutoPrint] 廚房單入列失敗:', e.message); }
  } else {
    try {
      const printService = require('../services/printService');
      await printService.autoCheckoutPrint(order);
    } catch (e) { console.error('[AutoPrint] 直接列印失敗:', e.message); }
  }
}

// ══════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════

// GET /
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { limit=200, offset=0, status, order_mode } = req.query;
    const { clause, params } = buildDateWhere(req.query, storeId);
    let sql = `SELECT * FROM orders WHERE ${clause}`;
    const p = [...params];
    if (status)     { sql += ' AND status=?';     p.push(status); }
    if (order_mode) { sql += ' AND order_mode=?'; p.push(order_mode); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), Number(offset));
    const orders = db.all(sql, p);
    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue,
              COALESCE(AVG(total),0) as avg_order,
              COALESCE(SUM(platform_commission_amount),0) as total_commission,
              COALESCE(SUM(store_actual_income),0) as total_store_income
       FROM orders WHERE ${clause} AND status!='void' AND order_status!='cancelled'`,
      params
    );
    res.json({ success: true, data: orders.map(parseOrder), stats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /delivery-report
router.get('/delivery-report', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { clause, params } = buildDateWhere(req.query, storeId);
    const orders = db.all(
      `SELECT * FROM orders WHERE ${clause} AND order_mode='delivery' ORDER BY created_at DESC`, params
    );
    const platformMap = {};
    orders.forEach(o => {
      const plat = o.delivery_platform || '未知';
      if (!platformMap[plat]) platformMap[plat] = { platform: plat, count: 0, revenue: 0, commission: 0, store_income: 0 };
      const isActive = o.status !== 'void' && o.delivery_status !== 'cancelled' && o.order_status !== 'cancelled';
      if (isActive) {
        platformMap[plat].count++;
        platformMap[plat].revenue      += Number(o.total || 0);
        platformMap[plat].commission   += Number(o.platform_commission_amount || 0);
        platformMap[plat].store_income += Number(o.store_actual_income || 0);
      }
    });
    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue,
              COALESCE(AVG(total),0) as avg_order,
              COALESCE(SUM(platform_commission_amount),0) as total_commission,
              COALESCE(SUM(store_actual_income),0) as total_store_income
       FROM orders WHERE ${clause} AND order_mode='delivery' AND status!='void'
         AND (delivery_status IS NULL OR delivery_status='' OR delivery_status!='cancelled')
         AND order_status!='cancelled'`,
      params
    );
    res.json({ success: true, data: orders.map(parseOrder), stats, by_platform: Object.values(platformMap) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /:id
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    res.json({ success: true, data: parseOrder(order) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /:id/logs — ★ fix2：先驗 order 屬於本店，再查 logs
router.get('/:id/logs', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // 先確認訂單屬於本店
    const order = db.get(
      'SELECT id, order_number FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const logs = db.all('SELECT * FROM order_logs WHERE order_id=? ORDER BY created_at DESC', [order.id]);
    res.json({ success: true, data: logs.map(l => ({
      ...l,
      before_data: l.before_data ? JSON.parse(l.before_data) : null,
      after_data:  l.after_data  ? JSON.parse(l.after_data)  : null,
    }))});
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST / — 建立訂單
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const {
      items, payment_method='cash',
      customer_name='', customer_phone='', customer_line_id='',
      note='', received_amount, change_amount,
      order_mode='dine_in', order_status='completed',
      table_number='', guest_count=0,
      pickup_name='', pickup_time='',
      delivery_platform='', delivery_address='', estimated_delivery='',
      delivery_fee=0, discount_amount=0,
      platform_order_no='', delivery_status='',
    } = req.body;

    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ success: false, message: '購物車不能為空' });

    // 庫存檢查（加 storeId）
    for (const item of items) {
      const pid = item.productId || item.product_id;
      if (!pid) continue;
      const invStatus = getProductInventoryStatus(db, pid, storeId);
      if (!invStatus || invStatus.available_units === null) continue;
      if (invStatus.available_units <= 0)
        return res.status(400).json({
          success: false,
          message: `${invStatus.product_name} 商品庫存不足，無法點餐`
        });
      if (item.qty > invStatus.available_units)
        return res.status(400).json({
          success: false,
          message: `${invStatus.product_name} 庫存不足（可賣 ${invStatus.available_units} 份）`
        });
    }

    const subtotal    = items.reduce((s,i) => s + i.price * i.qty, 0);
    const discountAmt = Number(discount_amount) || 0;
    const delivFee    = Number(delivery_fee) || 0;
    const total       = subtotal - discountAmt + delivFee;

    let commRate = 0, commAmount = 0, storeIncome = total;
    if (order_mode === 'delivery' && delivery_platform) {
      // ★ fix2：delivery_platforms 查詢加 store_id=?
      const plat = db.get(
        'SELECT commission_rate FROM delivery_platforms WHERE store_id=? AND name=? AND is_active=1',
        [storeId, delivery_platform]
      );
      commRate    = plat ? Number(plat.commission_rate) : 0;
      commAmount  = Math.round(subtotal * commRate / 100 * 100) / 100;
      storeIncome = subtotal - commAmount;
    }

    const isCash = payment_method === 'cash';
    const recv   = isCash ? Number(received_amount || 0) : total;
    const chng   = isCash ? Math.max(0, recv - total) : 0;
    if (isCash && recv < total)
      return res.status(400).json({ success: false, message: '實收金額不足' });

    const id           = uuidv4();
    const order_number = orderNumber();
    const effDelivStatus = order_mode === 'delivery' ? (delivery_status || 'preparing') : '';

    db.run(
      `INSERT INTO orders (id,order_number,store_id,customer_name,customer_phone,customer_line_id,
         items,payment_method,subtotal,total,note,received_amount,change_amount,status,
         order_mode,order_status,table_number,guest_count,
         pickup_name,pickup_time,
         delivery_platform,delivery_address,estimated_delivery,
         platform_commission_rate,platform_commission_amount,store_actual_income,
         delivery_fee,discount_amount,platform_order_no,delivery_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, order_number, storeId, customer_name, customer_phone, customer_line_id,
       JSON.stringify(items), payment_method, subtotal, total, note, recv, chng,
       order_mode, order_status || 'completed', table_number, Number(guest_count) || 0,
       pickup_name, pickup_time,
       delivery_platform, delivery_address, estimated_delivery,
       commRate, commAmount, storeIncome,
       delivFee, discountAmt, platform_order_no || '', effDelivStatus]
    );

    // ★ fix2：deductInventory 傳入 storeId
    deductInventory(db, items, id, 'sale', storeId);

    // ★ fix2：customers 查詢與新增都加 store_id
    if (customer_phone) {
      const ex = db.get('SELECT id FROM customers WHERE store_id=? AND phone=?', [storeId, customer_phone]);
      if (ex) {
        db.run(
          "UPDATE customers SET total_spent=total_spent+?,visit_count=visit_count+1,updated_at=datetime('now','localtime') WHERE store_id=? AND phone=?",
          [total, storeId, customer_phone]
        );
      } else {
        db.run(
          'INSERT INTO customers (store_id,name,phone,line_id,total_spent,visit_count) VALUES (?,?,?,?,?,1)',
          [storeId, customer_name, customer_phone, customer_line_id, total]
        );
      }
    }

    const order = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [id, storeId]);
    sendWebhook(order).catch(() => {});
    autoPrintOrEnqueue(parseOrder(order)).catch(e => console.error('[AutoPrint]', e.message));

    res.status(201).json({ success: true, data: parseOrder(order) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /:id — 修改訂單
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '已作廢訂單不可修改' });

    const { items, payment_method, customer_name, customer_phone, customer_line_id,
      note, received_amount, reason='', operator='staff',
      order_status, table_number, guest_count, pickup_name, pickup_time,
      delivery_address, estimated_delivery, delivery_fee, discount_amount } = req.body;

    if (!reason?.trim()) return res.status(400).json({ success: false, message: '修改原因為必填' });
    if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ success: false, message: '商品不能為空' });

    const subtotal  = items.reduce((s,i) => s + i.price * i.qty, 0);
    const discAmt   = discount_amount !== undefined ? Number(discount_amount) : Number(order.discount_amount || 0);
    const delivFee  = delivery_fee    !== undefined ? Number(delivery_fee)    : Number(order.delivery_fee    || 0);
    const newTotal  = subtotal - discAmt + delivFee;
    const newPayment = payment_method || order.payment_method;
    const isCash    = newPayment === 'cash';
    const newRecv   = isCash ? Number(received_amount || 0) : newTotal;
    const newChng   = isCash ? Math.max(0, newRecv - newTotal) : 0;
    if (isCash && newRecv < newTotal) return res.status(400).json({ success: false, message: '實收金額不足' });

    const commRate    = Number(order.platform_commission_rate || 0);
    const commAmount  = Math.round(subtotal * commRate / 100 * 100) / 100;
    const storeIncome = subtotal - commAmount;
    const oldItems    = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    const amountDiff  = newTotal - Number(order.total);

    // ★ fix2：order_logs INSERT 加 store_id
    db.run(
      `INSERT INTO order_logs (store_id,order_id,order_number,action,reason,operator,before_data,after_data,
         before_total,after_total,amount_diff,before_payment,after_payment,
         before_received,after_received,before_change,after_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, order.id, order.order_number, 'modify', reason.trim(), operator,
       order.items, JSON.stringify(items),
       Number(order.total), newTotal, amountDiff,
       order.payment_method, newPayment,
       Number(order.received_amount || 0), newRecv,
       Number(order.change_amount   || 0), newChng]
    );

    // ★ fix2：returnInventory / deductInventory 傳入 storeId
    returnInventory(db, oldItems, order.id, 'order_modify_return', storeId);
    deductInventory(db, items, order.id, 'sale', storeId);

    // ★ fix2：UPDATE 加 AND store_id=?
    db.run(
      `UPDATE orders SET items=?,payment_method=?,subtotal=?,total=?,discount_amount=?,delivery_fee=?,
         platform_commission_amount=?,store_actual_income=?,
         customer_name=?,customer_phone=?,customer_line_id=?,note=?,received_amount=?,change_amount=?,
         order_status=?,table_number=?,guest_count=?,pickup_name=?,pickup_time=?,
         delivery_address=?,estimated_delivery=?,
         status='modified',updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [JSON.stringify(items), newPayment, subtotal, newTotal, discAmt, delivFee,
       commAmount, storeIncome,
       customer_name   ?? order.customer_name,   customer_phone    ?? order.customer_phone,
       customer_line_id ?? order.customer_line_id, note !== undefined ? note : order.note,
       newRecv, newChng,
       order_status ?? order.order_status, table_number ?? order.table_number,
       guest_count !== undefined ? Number(guest_count) : order.guest_count,
       pickup_name ?? order.pickup_name, pickup_time ?? order.pickup_time,
       delivery_address ?? order.delivery_address, estimated_delivery ?? order.estimated_delivery,
       order.id, storeId]
    );

    const updated = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId]);
    const diff = amountDiff > 0
      ? { type: 'surcharge', amount: amountDiff }
      : amountDiff < 0
        ? { type: 'refund', amount: Math.abs(amountDiff) }
        : { type: 'none', amount: 0 };
    res.json({ success: true, data: parseOrder(updated), diff });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /:id/status
router.patch('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT id FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const { order_status } = req.body;
    const valid = ['pending','preparing','delivering','completed','cancelled'];
    if (!valid.includes(order_status)) return res.status(400).json({ success: false, message: '無效狀態' });
    // ★ fix2：UPDATE 加 AND store_id=?
    db.run(
      "UPDATE orders SET order_status=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [order_status, order.id, storeId]
    );
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /:id/delivery-status
router.patch('/:id/delivery-status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '已作廢訂單不可修改狀態' });
    const { delivery_status } = req.body;
    const valid = ['preparing', 'completed', 'cancelled'];
    if (!valid.includes(delivery_status)) return res.status(400).json({ success: false, message: '無效的外送狀態' });
    db.run(
      "UPDATE orders SET delivery_status=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [delivery_status, order.id, storeId]
    );
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /:id/void — 作廢訂單
router.post('/:id/void', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '訂單已作廢' });
    const { reason='', operator='staff' } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: '作廢原因為必填' });

    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    // ★ fix2：order_logs INSERT 加 store_id
    db.run(
      `INSERT INTO order_logs (store_id,order_id,order_number,action,reason,operator,before_data,after_data,
         before_total,after_total,amount_diff,before_payment,after_payment,
         before_received,after_received,before_change,after_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, order.id, order.order_number, 'void', reason.trim(), operator,
       order.items, order.items,
       Number(order.total), 0, -Number(order.total),
       order.payment_method, order.payment_method,
       Number(order.received_amount || 0), 0, Number(order.change_amount || 0), 0]
    );
    // ★ fix2：returnInventory 傳入 storeId
    returnInventory(db, items, order.id, 'void_return', storeId);
    // ★ fix2：UPDATE 加 AND store_id=?
    db.run(
      `UPDATE orders SET status='void',order_status='cancelled',void_reason=?,voided_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [reason.trim(), order.id, storeId]
    );
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /:id/reprint
router.post('/:id/reprint', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const { type='receipt' } = req.body;
    let printResult = { success: false, message: '列印未啟用' };
    const mode = getPrintMode();
    try {
      if (mode === 'queue') {
        const jobType = type === 'kitchen' ? 'kitchen' : 'receipt';
        enqueueJob(parseOrder(order), jobType);
        printResult = { success: true, message: `已加入列印佇列（${jobType}）` };
      } else {
        const printService = require('../services/printService');
        printResult = type === 'kitchen'
          ? await printService.printKitchenTicket(parseOrder(order))
          : await printService.printOrder(parseOrder(order));
      }
    } catch(pe) { console.error('[Reprint]', pe.message); }
    res.json({ success: true, data: parseOrder(order), printType: type, printResult, printMode: mode });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /webhook-test/:id
router.post('/webhook-test/:id', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查訂單加 AND store_id=?
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    await sendWebhook(order);
    res.json({ success: true, message: 'Webhook 已觸發' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
