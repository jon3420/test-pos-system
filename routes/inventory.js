// routes/inventory.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// ── helper ────────────────────────────────────────────────
function calcUnits(grams, allocatedGrams) {
  if (!allocatedGrams || allocatedGrams <= 0) return 0;
  return Math.floor(grams / allocatedGrams);
}

function writeInventoryLog(db, productId, productName, action, before, change, after, reason, orderId='', operator='staff') {
  const prod = db.get('SELECT allocated_grams FROM products WHERE id=?', [productId]);
  const alloc = prod ? prod.allocated_grams : 0;
  db.run(
    `INSERT INTO inventory_logs
      (product_id,product_name,action,before_grams,change_grams,after_grams,before_units,after_units,reason,operator,order_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [productId, productName, action,
     before, change, after,
     calcUnits(before, alloc), calcUnits(after, alloc),
     reason, operator, orderId]
  );
}

// ── GET /api/inventory ───────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const products = db.all('SELECT * FROM products WHERE inventory_enabled=1 ORDER BY sort_order ASC, id ASC');
    const enriched = products.map(p => ({
      ...p,
      available_units: calcUnits(p.current_stock_grams, p.allocated_grams),
      is_low_stock: calcUnits(p.current_stock_grams, p.allocated_grams) <= Number(p.low_stock_alert || 5),
      is_out_of_stock: calcUnits(p.current_stock_grams, p.allocated_grams) <= 0,
    }));
    res.json({ success: true, data: enriched });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/inventory/restock ──────────────────────────
router.post('/restock', (req, res) => {
  try {
    const db = getDb();
    const { product_id, add_grams, reason='補貨', operator='staff' } = req.body;
    if (!product_id || !add_grams || Number(add_grams) <= 0)
      return res.status(400).json({ success: false, message: 'product_id 與 add_grams 必填且需大於0' });

    const prod = db.get('SELECT * FROM products WHERE id=?', [product_id]);
    if (!prod) return res.status(404).json({ success: false, message: '商品不存在' });

    const before = Number(prod.current_stock_grams || 0);
    const addG   = Number(add_grams);
    const after  = before + addG;

    db.run("UPDATE products SET current_stock_grams=?,total_stock_grams=total_stock_grams+?,updated_at=datetime('now','localtime') WHERE id=?",
      [after, addG, product_id]);
    writeInventoryLog(db, product_id, prod.name, 'restock', before, addG, after, reason, '', operator);

    const updated = db.get('SELECT * FROM products WHERE id=?', [product_id]);
    res.json({ success: true, data: { ...updated, available_units: calcUnits(updated.current_stock_grams, updated.allocated_grams) } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/inventory/adjust ───────────────────────────
router.post('/adjust', (req, res) => {
  try {
    const db = getDb();
    const { product_id, change_grams, reason='手動調整', operator='staff' } = req.body;
    if (!product_id || change_grams === undefined)
      return res.status(400).json({ success: false, message: 'product_id 與 change_grams 必填' });

    const prod = db.get('SELECT * FROM products WHERE id=?', [product_id]);
    if (!prod) return res.status(404).json({ success: false, message: '商品不存在' });

    const before  = Number(prod.current_stock_grams || 0);
    const changeG = Number(change_grams);
    const after   = Math.max(0, before + changeG);

    db.run("UPDATE products SET current_stock_grams=?,updated_at=datetime('now','localtime') WHERE id=?",
      [after, product_id]);
    writeInventoryLog(db, product_id, prod.name, 'manual_adjust', before, changeG, after, reason, '', operator);

    const updated = db.get('SELECT * FROM products WHERE id=?', [product_id]);
    res.json({ success: true, data: { ...updated, available_units: calcUnits(updated.current_stock_grams, updated.allocated_grams) } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/inventory/logs ──────────────────────────────
router.get('/logs', (req, res) => {
  try {
    const db = getDb();
    const { product_id, limit=100, offset=0 } = req.query;
    let sql = 'SELECT * FROM inventory_logs WHERE 1=1';
    const p = [];
    if (product_id) { sql += ' AND product_id=?'; p.push(Number(product_id)); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), Number(offset));
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { router, calcUnits, writeInventoryLog };
