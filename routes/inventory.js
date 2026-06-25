// routes/inventory.js — SaaS R1 fix1（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getAllInventoryStatuses, getProductInventoryStatus } = require('../utils/inventoryHelper');

function calcUnits(grams, allocatedGrams) {
  if (!allocatedGrams || allocatedGrams <= 0) return 0;
  return Math.floor(grams / allocatedGrams);
}

function writeInventoryLog(db, productId, productName, action, before, change, after, reason, orderId='', operator='staff', storeId='store_001') {
  const prod = db.get('SELECT allocated_grams FROM products WHERE id=? AND store_id=?', [productId, storeId]);
  const alloc = prod ? prod.allocated_grams : 0;
  db.run(
    `INSERT INTO inventory_logs
      (store_id,product_id,product_name,action,before_grams,change_grams,after_grams,before_units,after_units,reason,operator,order_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [storeId, productId, productName, action,
     before, change, after,
     calcUnits(before, alloc), calcUnits(after, alloc),
     reason, operator, orderId]
  );
}

// GET /api/inventory
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const statuses = getAllInventoryStatuses(db, storeId);
    const enriched = statuses.map(s => {
      const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [s.product_id, storeId]);
      return {
        ...(prod || {}),
        current_stock_grams: s.available_grams,
        available_units:     s.available_units,
        available_grams:     s.available_grams,
        is_low_stock:        s.is_low_stock,
        is_out_of_stock:     s.is_out_of_stock,
        uses_ingredient:     s.is_formula_controlled,
        low_stock_alert:     s.low_stock_alert,
        status:              s.status,
      };
    });
    res.json({ success: true, data: enriched });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/inventory/restock
router.post('/restock', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { product_id, add_grams, reason='補貨', operator='staff' } = req.body;
    if (!product_id || !add_grams || Number(add_grams) <= 0)
      return res.status(400).json({ success: false, message: 'product_id 與 add_grams 必填且需大於0' });

    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [product_id, storeId]);
    if (!prod) return res.status(404).json({ success: false, message: '商品不存在' });

    const before = Number(prod.current_stock_grams || 0);
    const addG   = Number(add_grams);
    const after  = before + addG;

    db.run("UPDATE products SET current_stock_grams=?,total_stock_grams=total_stock_grams+?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [after, addG, product_id, storeId]);
    writeInventoryLog(db, product_id, prod.name, 'restock', before, addG, after, reason, '', operator, storeId);

    const updated = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [product_id, storeId]);
    res.json({ success: true, data: { ...updated, available_units: calcUnits(updated.current_stock_grams, updated.allocated_grams) } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/inventory/adjust
router.post('/adjust', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { product_id, change_grams, reason='手動調整', operator='staff' } = req.body;
    if (!product_id || change_grams === undefined)
      return res.status(400).json({ success: false, message: 'product_id 與 change_grams 必填' });

    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [product_id, storeId]);
    if (!prod) return res.status(404).json({ success: false, message: '商品不存在' });

    const before  = Number(prod.current_stock_grams || 0);
    const changeG = Number(change_grams);
    const after   = Math.max(0, before + changeG);

    db.run("UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [after, product_id, storeId]);
    writeInventoryLog(db, product_id, prod.name, 'manual_adjust', before, changeG, after, reason, '', operator, storeId);

    const updated = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [product_id, storeId]);
    res.json({ success: true, data: { ...updated, available_units: calcUnits(updated.current_stock_grams, updated.allocated_grams) } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/inventory/logs
router.get('/logs', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { product_id, limit=100, offset=0 } = req.query;
    let sql = 'SELECT * FROM inventory_logs WHERE store_id=?';
    const p = [storeId];
    if (product_id) { sql += ' AND product_id=?'; p.push(Number(product_id)); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), Number(offset));
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { router, calcUnits, writeInventoryLog };
