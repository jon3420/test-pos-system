// routes/orders.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { writeInventoryLog } = require('./inventory');

// ── helpers ───────────────────────────────────────────────
function orderNumber() {
  const n = new Date();
  const p = (v, l=2) => String(v).padStart(l,'0');
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

function deductInventory(db, items, orderId, action='sale') {
  items.forEach(item => {
    const pid = item.productId || item.product_id;
    if (!pid) return;
    const prod = db.get('SELECT * FROM products WHERE id=?', [pid]);
    if (!prod || !prod.inventory_enabled || !prod.allocated_grams) return;
    const deductG = prod.allocated_grams * item.qty;
    const before  = Number(prod.current_stock_grams || 0);
    const after   = Math.max(0, before - deductG);
    db.run("UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=?", [after, pid]);
    writeInventoryLog(db, pid, prod.name, action, before, -deductG, after, '結帳扣庫存', orderId);
  });
}

function returnInventory(db, items, orderId, action='void_return') {
  items.forEach(item => {
    const pid = item.productId || item.product_id;
    if (!pid) return;
    const prod = db.get('SELECT * FROM products WHERE id=?', [pid]);
    if (!prod || !prod.inventory_enabled || !prod.allocated_grams) return;
    const returnG = prod.allocated_grams * item.qty;
    const before  = Number(prod.current_stock_grams || 0);
    const after   = before + returnG;
    db.run("UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=?", [after, pid]);
    writeInventoryLog(db, pid, prod.name, action, before, returnG, after, '回補庫存', orderId);
  });
}

async function sendWebhook(order) {
  const db = getDb();
  const s = db.get("SELECT value FROM settings WHERE key='n8n_webhook_url'");
  if (!s?.value) return;
  const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
  try {
    await fetch(s.value, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ orderId: order.order_number, createdAt: order.created_at,
        customer: { name: order.customer_name||'', phone: order.customer_phone||'' },
        items, paymentMethod: order.payment_method, total: order.total, note: order.note||''
      }), timeout: 8000
    });
  } catch(e) { console.error('Webhook error:', e.message); }
}

// 產生 dateWhere clause
function buildDateWhere(query) {
  const { date, date_from, date_to } = query;
  if (date) return { clause: "DATE(created_at)=?", params: [date] };
  if (date_from && date_to) return { clause: "DATE(created_at)>=? AND DATE(created_at)<=?", params: [date_from, date_to] };
  return { clause: "DATE(created_at)=?", params: [new Date().toISOString().slice(0,10)] };
}

// ── GET / (訂單列表) ──────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { limit=200, offset=0, status, order_mode } = req.query;
    const { clause, params } = buildDateWhere(req.query);

    let sql = `SELECT * FROM orders WHERE ${clause}`;
    const p = [...params];
    if (status) { sql += ' AND status=?'; p.push(status); }
    if (order_mode) { sql += ' AND order_mode=?'; p.push(order_mode); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), Number(offset));
    const orders = db.all(sql, p);

    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue, COALESCE(AVG(total),0) as avg_order,
       COALESCE(SUM(platform_commission_amount),0) as total_commission,
       COALESCE(SUM(store_actual_income),0) as total_store_income
       FROM orders WHERE ${clause} AND status!='void' AND order_status!='cancelled'`,
      params
    );
    res.json({ success: true, data: orders.map(parseOrder), stats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /delivery-report ─────────────────────────────────
router.get('/delivery-report', (req, res) => {
  try {
    const db = getDb();
    const { clause, params } = buildDateWhere(req.query);

    // 全部外送訂單（含已取消），由前端 calcStatsFromOrders 負責排除
    const orders = db.all(
      `SELECT * FROM orders WHERE ${clause} AND order_mode='delivery' ORDER BY created_at DESC`,
      params
    );

    // 平台分組統計：只計算非作廢且非已取消
    const platformMap = {};
    orders.forEach(o => {
      const plat = o.delivery_platform || '未知';
      if (!platformMap[plat]) platformMap[plat] = { platform: plat, count: 0, revenue: 0, commission: 0, store_income: 0 };
      const isActive = o.status !== 'void' && o.delivery_status !== 'cancelled' && o.order_status !== 'cancelled';
      if (isActive) {
        platformMap[plat].count++;
        platformMap[plat].revenue     += Number(o.total || 0);
        platformMap[plat].commission  += Number(o.platform_commission_amount || 0);
        platformMap[plat].store_income += Number(o.store_actual_income || 0);
      }
    });

    // Server 端統計（同樣排除作廢與取消）
    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue, COALESCE(AVG(total),0) as avg_order,
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

// ── GET /:id ──────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    res.json({ success: true, data: parseOrder(order) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /:id/logs ─────────────────────────────────────────
router.get('/:id/logs', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT id,order_number FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const logs = db.all('SELECT * FROM order_logs WHERE order_id=? ORDER BY created_at DESC', [order.id]);
    res.json({ success: true, data: logs.map(l => ({
      ...l,
      before_data: l.before_data ? JSON.parse(l.before_data) : null,
      after_data:  l.after_data  ? JSON.parse(l.after_data)  : null,
    }))});
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST / (建立訂單) ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const {
      items, payment_method='cash',
      customer_name='', customer_phone='', customer_line_id='',
      note='', received_amount, change_amount,
      // 訂單模式欄位
      order_mode='dine_in',
      order_status='completed',
      table_number='', guest_count=0,
      pickup_name='', pickup_time='',
      delivery_platform='', delivery_address='', estimated_delivery='',
      delivery_fee=0, discount_amount=0,
      platform_order_no='', delivery_status='',
    } = req.body;

    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ success: false, message: '購物車不能為空' });

    // 庫存檢查
    for (const item of items) {
      const pid = item.productId || item.product_id;
      if (!pid) continue;
      const prod = db.get('SELECT * FROM products WHERE id=?', [pid]);
      if (!prod || !prod.inventory_enabled || !prod.allocated_grams) continue;
      const avail = Math.floor(Number(prod.current_stock_grams) / Number(prod.allocated_grams));
      if (item.qty > avail)
        return res.status(400).json({ success: false, message: `${prod.name} 庫存不足（可賣 ${avail} 份）` });
    }

    const subtotal = items.reduce((s,i) => s + i.price * i.qty, 0);
    const discountAmt = Number(discount_amount) || 0;
    const delivFee    = Number(delivery_fee) || 0;
    const total = subtotal - discountAmt + delivFee;

    // 外送：從資料庫取當下平台抽成比例寫入訂單（歷史固定）
    let commRate = 0, commAmount = 0, storeIncome = total;
    if (order_mode === 'delivery' && delivery_platform) {
      const plat = db.get('SELECT commission_rate FROM delivery_platforms WHERE name=? AND is_active=1', [delivery_platform]);
      commRate   = plat ? Number(plat.commission_rate) : 0;
      commAmount = Math.round(subtotal * commRate / 100 * 100) / 100;
      storeIncome = subtotal - commAmount;
    }

    const isCash = payment_method === 'cash';
    const recv = isCash ? Number(received_amount || 0) : total;
    const chng = isCash ? Math.max(0, recv - total) : 0;
    if (isCash && recv < total)
      return res.status(400).json({ success: false, message: '實收金額不足' });

    const id = uuidv4();
    const order_number = orderNumber();
    // 外送訂單預設 delivery_status = preparing；其他留空
    const effDelivStatus = order_mode === 'delivery' ? (delivery_status || 'preparing') : '';

    db.run(
      `INSERT INTO orders (id,order_number,customer_name,customer_phone,customer_line_id,
         items,payment_method,subtotal,total,note,received_amount,change_amount,status,
         order_mode,order_status,table_number,guest_count,
         pickup_name,pickup_time,
         delivery_platform,delivery_address,estimated_delivery,
         platform_commission_rate,platform_commission_amount,store_actual_income,
         delivery_fee,discount_amount,platform_order_no,delivery_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, order_number, customer_name, customer_phone, customer_line_id,
       JSON.stringify(items), payment_method, subtotal, total, note, recv, chng,
       order_mode, order_status||'completed', table_number, Number(guest_count)||0,
       pickup_name, pickup_time,
       delivery_platform, delivery_address, estimated_delivery,
       commRate, commAmount, storeIncome,
       delivFee, discountAmt, platform_order_no||'', effDelivStatus]
    );

    deductInventory(db, items, id, 'sale');

    if (customer_phone) {
      const ex = db.get('SELECT id FROM customers WHERE phone=?', [customer_phone]);
      if (ex) {
        db.run("UPDATE customers SET total_spent=total_spent+?,visit_count=visit_count+1,updated_at=datetime('now','localtime') WHERE phone=?", [total, customer_phone]);
      } else {
        db.run('INSERT INTO customers (name,phone,line_id,total_spent,visit_count) VALUES (?,?,?,?,1)', [customer_name, customer_phone, customer_line_id, total]);
      }
    }

    const order = db.get('SELECT * FROM orders WHERE id=?', [id]);
    sendWebhook(order).catch(()=>{});
    // 自動列印（非同步，失敗不影響訂單回應）
    try {
      const printService = require('../services/printService');
      printService.autoCheckoutPrint(parseOrder(order)).catch(e => console.error('[AutoPrint]', e.message));
    } catch(pe) { console.error('[AutoPrint] 載入失敗:', pe.message); }
    res.status(201).json({ success: true, data: parseOrder(order) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PUT /:id (修改訂單) ───────────────────────────────────
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
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

    // 外送抽成維持建立時的比例（歷史固定），但重算金額
    const commRate   = Number(order.platform_commission_rate || 0);
    const commAmount = Math.round(subtotal * commRate / 100 * 100) / 100;
    const storeIncome = subtotal - commAmount;

    const oldItems   = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    const amountDiff = newTotal - Number(order.total);

    db.run(
      `INSERT INTO order_logs (order_id,order_number,action,reason,operator,before_data,after_data,
         before_total,after_total,amount_diff,before_payment,after_payment,
         before_received,after_received,before_change,after_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [order.id, order.order_number, 'modify', reason.trim(), operator,
       order.items, JSON.stringify(items),
       Number(order.total), newTotal, amountDiff,
       order.payment_method, newPayment,
       Number(order.received_amount||0), newRecv,
       Number(order.change_amount||0), newChng]
    );

    returnInventory(db, oldItems, order.id, 'order_modify_return');
    deductInventory(db, items, order.id, 'sale');

    db.run(
      `UPDATE orders SET items=?,payment_method=?,subtotal=?,total=?,discount_amount=?,delivery_fee=?,
         platform_commission_amount=?,store_actual_income=?,
         customer_name=?,customer_phone=?,customer_line_id=?,note=?,received_amount=?,change_amount=?,
         order_status=?,table_number=?,guest_count=?,pickup_name=?,pickup_time=?,
         delivery_address=?,estimated_delivery=?,
         status='modified',updated_at=datetime('now','localtime') WHERE id=?`,
      [JSON.stringify(items), newPayment, subtotal, newTotal, discAmt, delivFee,
       commAmount, storeIncome,
       customer_name??order.customer_name, customer_phone??order.customer_phone,
       customer_line_id??order.customer_line_id, note!==undefined?note:order.note,
       newRecv, newChng,
       order_status??order.order_status, table_number??order.table_number,
       guest_count!==undefined?Number(guest_count):order.guest_count,
       pickup_name??order.pickup_name, pickup_time??order.pickup_time,
       delivery_address??order.delivery_address, estimated_delivery??order.estimated_delivery,
       order.id]
    );

    const updated = db.get('SELECT * FROM orders WHERE id=?', [order.id]);
    const diff = amountDiff > 0 ? {type:'surcharge',amount:amountDiff} : amountDiff < 0 ? {type:'refund',amount:Math.abs(amountDiff)} : {type:'none',amount:0};
    res.json({ success: true, data: parseOrder(updated), diff });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/status ────────────────────────────────────
router.patch('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT id FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const { order_status } = req.body;
    const valid = ['pending','preparing','delivering','completed','cancelled'];
    if (!valid.includes(order_status)) return res.status(400).json({ success: false, message: '無效狀態' });
    db.run("UPDATE orders SET order_status=?,updated_at=datetime('now','localtime') WHERE id=?", [order_status, order.id]);
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=?', [order.id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /:id/delivery-status  (外送狀態專用) ────────────
router.patch('/:id/delivery-status', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '已作廢訂單不可修改狀態' });
    const { delivery_status } = req.body;
    const valid = ['preparing', 'completed', 'cancelled'];
    if (!valid.includes(delivery_status)) return res.status(400).json({ success: false, message: '無效的外送狀態' });
    db.run(
      "UPDATE orders SET delivery_status=?,updated_at=datetime('now','localtime') WHERE id=?",
      [delivery_status, order.id]
    );
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=?', [order.id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/void ────────────────────────────────────────
router.post('/:id/void', (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '訂單已作廢' });
    const { reason='', operator='staff' } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: '作廢原因為必填' });

    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    db.run(
      `INSERT INTO order_logs (order_id,order_number,action,reason,operator,before_data,after_data,
         before_total,after_total,amount_diff,before_payment,after_payment,
         before_received,after_received,before_change,after_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [order.id, order.order_number, 'void', reason.trim(), operator,
       order.items, order.items,
       Number(order.total), 0, -Number(order.total),
       order.payment_method, order.payment_method,
       Number(order.received_amount||0), 0, Number(order.change_amount||0), 0]
    );
    returnInventory(db, items, order.id, 'void_return');
    db.run(
      `UPDATE orders SET status='void',order_status='cancelled',void_reason=?,voided_at=datetime('now','localtime'),updated_at=datetime('now','localtime') WHERE id=?`,
      [reason.trim(), order.id]
    );
    res.json({ success: true, data: parseOrder(db.get('SELECT * FROM orders WHERE id=?', [order.id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /:id/reprint ────────────────────────────────────
router.post('/:id/reprint', async (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const { type='receipt' } = req.body;
    // 嘗試 ESC/POS 列印（失敗不影響回應）
    let printResult = { success: false, message: '列印未啟用' };
    try {
      const printService = require('../services/printService');
      printResult = await printService.printOrder(parseOrder(order));
    } catch(pe) { console.error('[Reprint]', pe.message); }
    res.json({ success: true, data: parseOrder(order), printType: type, printResult });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /webhook-test/:id ────────────────────────────────
router.post('/webhook-test/:id', async (req, res) => {
  try {
    const db = getDb();
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    await sendWebhook(order);
    res.json({ success: true, message: 'Webhook 已觸發' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
