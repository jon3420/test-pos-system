// routes/orders.js — fix18-09（補登訂單日期＋折扣成本歸類＋全分頁折扣報表）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb }  = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getProductInventoryStatus } = require('../utils/inventoryHelper');
const { v4: uuidv4 } = require('uuid');
const fetch    = require('node-fetch');
const { writeInventoryLog } = require('./inventory');

// ── fix18-09：safe migration（不重建資料庫）────────────────
function ensureFix1809Columns(db) {
  const safeAdd = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch(e) {
      if (!e.message.includes('duplicate column')) console.error(`[migration] ${col}:`, e.message);
    }
  };
  safeAdd('orders', 'original_total',           'REAL DEFAULT 0');
  safeAdd('orders', 'discount_category',         'TEXT DEFAULT \'none\'');
  safeAdd('orders', 'discount_note',             'TEXT DEFAULT \'\'');
  // fix18-09C 新增欄位
  safeAdd('orders', 'discount_campaign_id',      'INTEGER DEFAULT NULL');
  safeAdd('orders', 'discount_campaign_name',    'TEXT DEFAULT \'\'');
  safeAdd('orders', 'discount_target_type',      'TEXT DEFAULT \'order\'');
  safeAdd('orders', 'discount_product_id',       'TEXT DEFAULT \'\'');
  safeAdd('orders', 'discount_product_name',     'TEXT DEFAULT \'\'');
  // fix18-09D：多商品折扣
  safeAdd('orders', 'discount_product_ids',      'TEXT DEFAULT \'\''  );
  safeAdd('orders', 'discount_product_names',    'TEXT DEFAULT \'\''  );
}

// ── fix18-09：折扣分類標準化 ──────────────────────────────
function normalizeDiscountCategory(value) {
  if (!value || value === '' || value === undefined || value === null) return 'none';
  const v = String(value).trim().toLowerCase();
  const map = {
    none: 'none', marketing: 'marketing', product_promo: 'product_promo',
    complaint: 'complaint', loyalty: 'loyalty', staff_family: 'staff_family',
    platform_promo: 'platform_promo', other: 'other'
  };
  return map[v] || 'none';
}

const DISCOUNT_CATEGORY_LABEL = {
  none: '無折扣', marketing: '廣告行銷支出', product_promo: '商品活動支出',
  complaint: '客訴補償', loyalty: '老客戶優惠', staff_family: '員工/親友優惠',
  platform_promo: '平台活動', other: '其他'
};

// ── helpers ───────────────────────────────────────────────
function orderNumber() {
  const n = new Date(), p = (v, l=2) => String(v).padStart(l,'0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

function parseOrder(o) {
  if (!o) return null;
  const discountAmt = Number(o.discount_amount || 0);
  const total       = Number(o.total || 0);
  // fix18-09：若無 original_total，倒推
  const originalTotal = o.original_total ? Number(o.original_total) : total + discountAmt;
  return {
    ...o,
    items:                    typeof o.items === 'string' ? JSON.parse(o.items) : o.items,
    received_amount:          Number(o.received_amount          || 0),
    change_amount:            Number(o.change_amount            || 0),
    total,
    original_total:           originalTotal,
    subtotal:                 Number(o.subtotal                 || 0),
    platform_commission_rate:   Number(o.platform_commission_rate   || 0),
    platform_commission_amount: Number(o.platform_commission_amount || 0),
    store_actual_income:        Number(o.store_actual_income        || 0),
    delivery_fee:             Number(o.delivery_fee             || 0),
    discount_amount:          discountAmt,
    discount_category:        normalizeDiscountCategory(o.discount_category),
    discount_note:            o.discount_note || '',
    // fix18-09C
    discount_campaign_id:     o.discount_campaign_id || null,
    discount_campaign_name:   o.discount_campaign_name || '',
    discount_target_type:     o.discount_target_type || 'order',
    discount_product_id:      o.discount_product_id || '',
    discount_product_name:    o.discount_product_name || '',
    // fix18-09D：多商品
    discount_product_ids:     o.discount_product_ids   ? (typeof o.discount_product_ids   === 'string' ? JSON.parse(o.discount_product_ids)   : o.discount_product_ids)   : [],
    discount_product_names:   o.discount_product_names ? (typeof o.discount_product_names === 'string' ? JSON.parse(o.discount_product_names) : o.discount_product_names) : [],
    guest_count:              Number(o.guest_count              || 0),
    platform_order_no:        o.platform_order_no || '',
    delivery_status:          o.delivery_status   || '',
  };
}

function deductInventory(db, items, orderId, action, storeId) {
  const sid = storeId;
  items.forEach(item => {
    const pid = item.productId || item.product_id;
    if (!pid) return;
    const formulas = db.all(
      'SELECT f.*,i.name as ing_name FROM product_ingredient_formulas f ' +
      'LEFT JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=? ' +
      'WHERE f.product_id=?',
      [sid, pid]
    );
    if (formulas.length > 0) {
      formulas.forEach(f => {
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
      return;
    }
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

function returnInventory(db, items, orderId, action, storeId) {
  const sid = storeId;
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

async function sendWebhook(order) {
  const db  = getDb();
  const sid = order.store_id || null;
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
  const sid = storeId;
  const taipeiToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date) return { clause: "store_id=? AND DATE(created_at)=?", params: [sid, date] };
  if (date_from && date_to) return { clause: "store_id=? AND DATE(created_at)>=? AND DATE(created_at)<=?", params: [sid, date_from, date_to] };
  return { clause: "store_id=? AND DATE(created_at)=?", params: [sid, taipeiToday] };
}

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
    const storeId = order.store_id || null;
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
      const sid = order.store_id || null;
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

// ── fix18-08：平台標準化（保留） ──────────────────────────
function normalizePlatform(v) {
  if (!v || v === 'unknown' || v === 'undefined') return 'unknown';
  const s = String(v).toLowerCase().replace(/\s/g, '');
  if (['pos', 'pos現場'].includes(s)) return 'pos';
  if (['ubereats', 'uber eats', 'uber'].includes(s)) return 'ubereats';
  if (['foodpanda', 'panda'].includes(s)) return 'foodpanda';
  if (['line', 'line點餐', 'line_order'].includes(s)) return 'line';
  if (['phone', '電話訂購'].includes(s)) return 'phone';
  if (['other', '其他'].includes(s)) return 'other';
  return 'unknown';
}

const PLATFORM_LABEL = {
  unknown: '未知', pos: 'POS現場', ubereats: 'Uber Eats',
  foodpanda: 'foodpanda', line: 'LINE點餐', phone: '電話訂購', other: '其他'
};

const COMMISSION_KEY = {
  ubereats: 'ubereats_commission_rate', foodpanda: 'foodpanda_commission_rate',
  line: 'line_commission_rate', pos: 'pos_commission_rate',
  phone: 'phone_commission_rate', other: 'other_commission_rate',
  unknown: 'unknown_commission_rate'
};

const DEFAULT_RATE = { ubereats: 31, foodpanda: 35 };

// ══════════════════════════════════════════════════════════
// Routes
// ══════════════════════════════════════════════════════════

// GET /
router.get('/', (req, res) => {
  try {
    const db = getDb();
    ensureFix1809Columns(db);
    const storeId = req.storeId;
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
              COALESCE(SUM(store_actual_income),0) as total_store_income,
              COALESCE(SUM(discount_amount),0) as total_discount,
              COALESCE(SUM(CASE WHEN original_total>0 THEN original_total ELSE total+COALESCE(discount_amount,0) END),0) as total_original
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
    ensureFix1809Columns(db);
    const storeId = req.storeId;
    const { clause, params } = buildDateWhere(req.query, storeId);
    const orders = db.all(
      `SELECT * FROM orders WHERE ${clause} AND order_mode='delivery' ORDER BY created_at DESC`, params
    );
    const platformMap = {};
    orders.forEach(o => {
      const plat = o.delivery_platform || '未知';
      if (!platformMap[plat]) platformMap[plat] = { platform: plat, count: 0, revenue: 0, commission: 0, store_income: 0, discount: 0, original_revenue: 0 };
      const isActive = o.status !== 'void' && o.delivery_status !== 'cancelled' && o.order_status !== 'cancelled';
      if (isActive) {
        const discAmt = Number(o.discount_amount || 0);
        const tot     = Number(o.total || 0);
        const origTot = o.original_total ? Number(o.original_total) : tot + discAmt;
        platformMap[plat].count++;
        platformMap[plat].revenue          += tot;
        platformMap[plat].commission       += Number(o.platform_commission_amount || 0);
        platformMap[plat].store_income     += Number(o.store_actual_income || 0);
        platformMap[plat].discount         += discAmt;
        platformMap[plat].original_revenue += origTot;
      }
    });
    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue,
              COALESCE(AVG(total),0) as avg_order,
              COALESCE(SUM(platform_commission_amount),0) as total_commission,
              COALESCE(SUM(store_actual_income),0) as total_store_income,
              COALESCE(SUM(discount_amount),0) as total_discount,
              COALESCE(SUM(CASE WHEN original_total>0 THEN original_total ELSE total+COALESCE(discount_amount,0) END),0) as total_original
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
    ensureFix1809Columns(db);
    const storeId = req.storeId;
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    res.json({ success: true, data: parseOrder(order) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /:id/logs
router.get('/:id/logs', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
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
    ensureFix1809Columns(db);
    const storeId = req.storeId;
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
      discount_category='none', discount_note='',
      // fix18-09C 新增
      discount_campaign_id=null, discount_campaign_name='',
      discount_target_type='order', discount_product_id='', discount_product_name='',
      discount_product_ids=null, discount_product_names=null,
    } = req.body;

    if (!items || !Array.isArray(items) || !items.length)
      return res.status(400).json({ success: false, message: '購物車不能為空' });

    for (const item of items) {
      const pid = item.productId || item.product_id;
      if (!pid) continue;
      const invStatus = getProductInventoryStatus(db, pid, storeId);
      if (!invStatus || invStatus.available_units === null) continue;
      if (invStatus.available_units <= 0)
        return res.status(400).json({ success: false, message: `${invStatus.product_name} 商品庫存不足，無法點餐` });
      if (item.qty > invStatus.available_units)
        return res.status(400).json({ success: false, message: `${invStatus.product_name} 庫存不足（可賣 ${invStatus.available_units} 份）` });
    }

    const subtotal     = items.reduce((s,i) => s + i.price * i.qty, 0);
    const discountAmt  = Number(discount_amount) || 0;
    const delivFee     = Number(delivery_fee) || 0;
    const total        = subtotal - discountAmt + delivFee;
    const originalTotal = subtotal + delivFee; // 含運費但不含折扣

    let commRate = 0, commAmount = 0, storeIncome = total;
    if (order_mode === 'delivery' && delivery_platform) {
      const plat = db.get(
        'SELECT commission_rate FROM delivery_platforms WHERE store_id=? AND name=? AND is_active=1',
        [storeId, delivery_platform]
      );
      commRate    = plat ? Number(plat.commission_rate) : 0;
      // fix18-09：抽成用實收金額 total 計算
      commAmount  = Math.round(total * commRate / 100 * 100) / 100;
      storeIncome = Math.round((total - commAmount) * 100) / 100;
    }

    const isCash = payment_method === 'cash';
    const recv   = isCash ? Number(received_amount || 0) : total;
    const chng   = isCash ? Math.max(0, recv - total) : 0;
    if (isCash && recv < total)
      return res.status(400).json({ success: false, message: '實收金額不足' });

    const id           = uuidv4();
    const order_number = orderNumber();
    const effDelivStatus = order_mode === 'delivery' ? (delivery_status || 'preparing') : '';
    const normCat = normalizeDiscountCategory(discount_category);

    db.run(
      `INSERT INTO orders (id,order_number,store_id,customer_name,customer_phone,customer_line_id,
         items,payment_method,subtotal,total,original_total,note,received_amount,change_amount,status,
         order_mode,order_status,table_number,guest_count,
         pickup_name,pickup_time,
         delivery_platform,delivery_address,estimated_delivery,
         platform_commission_rate,platform_commission_amount,store_actual_income,
         delivery_fee,discount_amount,discount_category,discount_note,
         discount_campaign_id,discount_campaign_name,discount_target_type,discount_product_id,discount_product_name,
         discount_product_ids,discount_product_names,
         platform_order_no,delivery_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, order_number, storeId, customer_name, customer_phone, customer_line_id,
       JSON.stringify(items), payment_method, subtotal, total, originalTotal, note, recv, chng,
       order_mode, order_status || 'completed', table_number, Number(guest_count) || 0,
       pickup_name, pickup_time,
       delivery_platform, delivery_address, estimated_delivery,
       commRate, commAmount, storeIncome,
       delivFee, discountAmt, normCat, discount_note || '',
       discount_campaign_id || null, discount_campaign_name || '', discount_target_type || 'order',
       discount_product_id || '', discount_product_name || '',
       discount_product_ids  ? JSON.stringify(discount_product_ids)  : '[]',
       discount_product_names ? JSON.stringify(discount_product_names) : '[]',
       platform_order_no || '', effDelivStatus]
    );

    deductInventory(db, items, id, 'sale', storeId);

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

// PUT /:id — 修改訂單（fix18-09：加入 created_at / discount_category / discount_note）
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    ensureFix1809Columns(db);
    const storeId = req.storeId;
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '已作廢訂單不可修改' });

    const {
      items, payment_method, customer_name, customer_phone, customer_line_id,
      note, received_amount, reason='', operator='staff',
      order_status, table_number, guest_count, pickup_name, pickup_time,
      delivery_address, estimated_delivery, delivery_fee, discount_amount,
      platform,
      // fix18-09 新增
      created_at,
      discount_category,
      discount_note,
      // fix18-09C 新增
      discount_campaign_id,
      discount_campaign_name,
      discount_target_type,
      discount_product_id,
      discount_product_name,
      discount_product_ids,
      discount_product_names,
    } = req.body;

    if (!reason?.trim()) return res.status(400).json({ success: false, message: '修改原因為必填' });
    if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ success: false, message: '商品不能為空' });

    const subtotal  = items.reduce((s,i) => s + i.price * i.qty, 0);
    const discAmt   = discount_amount !== undefined ? Number(discount_amount) : Number(order.discount_amount || 0);
    const delivFee  = delivery_fee    !== undefined ? Number(delivery_fee)    : Number(order.delivery_fee    || 0);
    const newTotal  = subtotal - discAmt + delivFee;
    const newOriginalTotal = subtotal + delivFee; // 原價（不扣折扣）

    const newPayment = payment_method || order.payment_method;
    const isCash    = newPayment === 'cash';
    const newRecv   = isCash ? Number(received_amount || 0) : newTotal;
    const newChng   = isCash ? Math.max(0, newRecv - newTotal) : 0;
    if (isCash && newRecv < newTotal) return res.status(400).json({ success: false, message: '實收金額不足' });

    // fix18-09：折扣分類
    const normCat  = discount_category !== undefined ? normalizeDiscountCategory(discount_category) : normalizeDiscountCategory(order.discount_category);
    const normNote = discount_note     !== undefined ? discount_note : (order.discount_note || '');

    // 折扣分類必填驗證
    if (discAmt > 0 && normCat === 'none') {
      return res.status(400).json({ success: false, message: '有折扣金額時折扣分類為必填' });
    }

    // fix18-09：訂單日期（負責人才可修改，後端由 operator 判斷）
    const newCreatedAt = created_at ? created_at : order.created_at;

    // fix18-08：平台來源
    const oldPlatformRaw = order.delivery_platform || order.platform || '';
    const oldPlatformCode = normalizePlatform(oldPlatformRaw);
    let newPlatformCode = platform !== undefined ? normalizePlatform(platform) : oldPlatformCode;
    const newPlatformLabel = PLATFORM_LABEL[newPlatformCode] || '未知';

    const getRate = (code) => {
      const key = COMMISSION_KEY[code] || 'unknown_commission_rate';
      const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
      if (row && row.value !== undefined && row.value !== '') return Number(row.value);
      return DEFAULT_RATE[code] || 0;
    };

    const oldCommRate   = Number(order.platform_commission_rate || 0);
    const newCommRate   = getRate(newPlatformCode);
    // fix18-09：抽成以實收 total 計算
    const commAmount    = Math.round(newTotal * newCommRate / 100 * 100) / 100;
    const storeIncome   = Math.round((newTotal - commAmount) * 100) / 100;

    const oldItems    = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    const amountDiff  = newTotal - Number(order.total);

    // ── fix18-09：組合完整 diff log ──────────────────────────
    const oldDiscCat    = normalizeDiscountCategory(order.discount_category);
    const oldDiscNote   = order.discount_note || '';
    const oldCreatedAt  = order.created_at || '';
    // fix18-09C
    const oldCampaignName  = order.discount_campaign_name || '';
    const newCampaignName  = discount_campaign_name !== undefined ? (discount_campaign_name || '') : oldCampaignName;
    const oldProdName      = order.discount_product_name || '';
    const newProdName      = discount_product_name !== undefined ? (discount_product_name || '') : oldProdName;
    const oldTargetType    = order.discount_target_type || 'order';
    const newTargetType    = discount_target_type !== undefined ? (discount_target_type || 'order') : oldTargetType;
    const newCampaignId    = discount_campaign_id !== undefined ? (discount_campaign_id || null) : (order.discount_campaign_id || null);
    const newProdId        = discount_product_id  !== undefined ? (discount_product_id  || '') : (order.discount_product_id || '');
    // fix18-09D：多商品
    const parseJsonArr = (v) => { try { return v ? (typeof v === 'string' ? JSON.parse(v) : v) : []; } catch { return []; } };
    const oldProdIds   = parseJsonArr(order.discount_product_ids);
    const oldProdNms   = parseJsonArr(order.discount_product_names);
    const newProdIds   = discount_product_ids   !== undefined ? (discount_product_ids   || []) : oldProdIds;
    const newProdNms   = discount_product_names !== undefined ? (discount_product_names || []) : oldProdNms;
    // 若有多商品 names，覆蓋 newProdName（向下相容，讓 display 用 names 陣列）
    const effectiveProdName = newProdNms.length ? newProdNms.join('、') : newProdName;

    const platformChanged  = newPlatformCode !== oldPlatformCode;
    const dateChanged      = created_at && newCreatedAt !== oldCreatedAt;
    const catChanged       = normCat !== oldDiscCat;
    const noteChanged      = normNote !== oldDiscNote;

    const diffLines = [];
    if (dateChanged) diffLines.push(`訂單日期：${oldCreatedAt} → ${newCreatedAt}`);
    if (catChanged)  diffLines.push(`折扣分類：${DISCOUNT_CATEGORY_LABEL[oldDiscCat]||oldDiscCat} → ${DISCOUNT_CATEGORY_LABEL[normCat]||normCat}`);
    if (noteChanged) diffLines.push(`折扣備註：${oldDiscNote||'空白'} → ${normNote||'空白'}`);
    // fix18-09C
    if (newCampaignName !== oldCampaignName) diffLines.push(`折扣活動：${oldCampaignName||'無'} → ${newCampaignName||'無'}`);
    if (effectiveProdName !== (oldProdNms.length ? oldProdNms.join('、') : oldProdName)) diffLines.push(`折扣商品：${(oldProdNms.length?oldProdNms.join('、'):oldProdName)||'無'} → ${effectiveProdName||'無'}`);
    if (platformChanged) {
      diffLines.push(`平台來源：${PLATFORM_LABEL[oldPlatformCode]||'未知'} → ${newPlatformLabel}`);
      diffLines.push(`抽成率：${oldCommRate}% → ${newCommRate}%`);
      diffLines.push(`平台抽成：NT$${order.platform_commission_amount||0} → NT$${commAmount}`);
      diffLines.push(`店家實收：NT$${order.store_actual_income||order.total} → NT$${storeIncome}`);
    }
    if (amountDiff !== 0) diffLines.push(`金額：${order.total} → ${newTotal}`);

    const diffNote = diffLines.join('；');
    const logReason = diffNote ? `${reason.trim()}｜${diffNote}` : reason.trim();

    const afterDiff = {
      platform_before: PLATFORM_LABEL[oldPlatformCode] || '未知',
      platform_after: newPlatformLabel,
      commission_rate_before: oldCommRate,
      commission_rate_after: newCommRate,
      commission_amount_before: Number(order.platform_commission_amount || 0),
      commission_amount_after: commAmount,
      store_income_before: Number(order.store_actual_income || order.total),
      store_income_after: storeIncome,
      // fix18-09
      created_at_before: oldCreatedAt,
      created_at_after: newCreatedAt,
      discount_category_before: DISCOUNT_CATEGORY_LABEL[oldDiscCat] || oldDiscCat,
      discount_category_after: DISCOUNT_CATEGORY_LABEL[normCat] || normCat,
      discount_note_before: oldDiscNote,
      discount_note_after: normNote,
      discount_amount_before: Number(order.discount_amount || 0),
      discount_amount_after: discAmt,
      // fix18-09C
      discount_campaign_before: oldCampaignName,
      discount_campaign_after: newCampaignName,
      discount_product_before: oldProdNms.length ? oldProdNms.join('、') : oldProdName,
      discount_product_after:  effectiveProdName,
      // fix18-09D
      discount_product_ids_before:   oldProdIds,
      discount_product_ids_after:    newProdIds,
      discount_product_names_before: oldProdNms,
      discount_product_names_after:  newProdNms,
    };

    db.run(
      `INSERT INTO order_logs (store_id,order_id,order_number,action,reason,operator,before_data,after_data,
         before_total,after_total,amount_diff,before_payment,after_payment,
         before_received,after_received,before_change,after_change)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, order.id, order.order_number, 'modify', logReason, operator,
       order.items, JSON.stringify({ items, platform_diff: afterDiff }),
       Number(order.total), newTotal, amountDiff,
       order.payment_method, newPayment,
       Number(order.received_amount || 0), newRecv,
       Number(order.change_amount   || 0), newChng]
    );

    returnInventory(db, oldItems, order.id, 'order_modify_return', storeId);
    deductInventory(db, items, order.id, 'sale', storeId);

    // fix18-09：同時更新 created_at, discount_category, discount_note, original_total
    db.run(
      `UPDATE orders SET items=?,payment_method=?,subtotal=?,total=?,original_total=?,discount_amount=?,delivery_fee=?,
         delivery_platform=?,platform_commission_rate=?,platform_commission_amount=?,store_actual_income=?,
         customer_name=?,customer_phone=?,customer_line_id=?,note=?,received_amount=?,change_amount=?,
         order_status=?,table_number=?,guest_count=?,pickup_name=?,pickup_time=?,
         delivery_address=?,estimated_delivery=?,
         discount_category=?,discount_note=?,
         discount_campaign_id=?,discount_campaign_name=?,discount_target_type=?,discount_product_id=?,discount_product_name=?,
         discount_product_ids=?,discount_product_names=?,
         created_at=?,
         status='modified',updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [JSON.stringify(items), newPayment, subtotal, newTotal, newOriginalTotal, discAmt, delivFee,
       newPlatformLabel,
       newCommRate, commAmount, storeIncome,
       customer_name   ?? order.customer_name,   customer_phone    ?? order.customer_phone,
       customer_line_id ?? order.customer_line_id, note !== undefined ? note : order.note,
       newRecv, newChng,
       order_status ?? order.order_status, table_number ?? order.table_number,
       guest_count !== undefined ? Number(guest_count) : order.guest_count,
       pickup_name ?? order.pickup_name, pickup_time ?? order.pickup_time,
       delivery_address ?? order.delivery_address, estimated_delivery ?? order.estimated_delivery,
       normCat, normNote,
       newCampaignId, newCampaignName, newTargetType, newProdId, effectiveProdName,
       JSON.stringify(newProdIds), JSON.stringify(newProdNms),
       newCreatedAt,
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
    const storeId = req.storeId;
    const order = db.get(
      'SELECT id FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const { order_status } = req.body;
    const valid = ['pending','preparing','delivering','completed','cancelled'];
    if (!valid.includes(order_status)) return res.status(400).json({ success: false, message: '無效狀態' });
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
    const storeId = req.storeId;
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

// POST /:id/void
router.post('/:id/void', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [req.params.id, req.params.id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.status === 'void') return res.status(400).json({ success: false, message: '訂單已作廢' });
    const { reason='', operator='staff' } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: '作廢原因為必填' });

    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
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
    returnInventory(db, items, order.id, 'void_return', storeId);
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
    const storeId = req.storeId;
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
    const storeId = req.storeId;
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
