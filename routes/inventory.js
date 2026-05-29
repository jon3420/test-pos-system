// routes/inventory.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getAllInventoryStatuses, getProductInventoryStatus } = require('../utils/inventoryHelper');

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
    // 使用統一 inventoryHelper，確保與結帳/警示等完全一致
    const statuses = getAllInventoryStatuses(db);
    // 補上商品完整欄位供前端使用
    const enriched = statuses.map(s => {
      const prod = db.get('SELECT * FROM products WHERE id=?', [s.product_id]);
      return {
        ...(prod || {}),
        // 覆蓋庫存相關欄位為統一計算值
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
