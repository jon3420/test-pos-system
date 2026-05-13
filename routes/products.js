// routes/products.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { calcUnits } = require('./inventory');

// fallback：dine_in_price → price
function resolvePrice(p, mode) {
  const dine     = Number(p.dine_in_price)   || Number(p.price) || 0;
  const takeaway = Number(p.takeaway_price)  || dine;
  const delivery = Number(p.delivery_price)  || takeaway;
  if (mode === 'delivery') return delivery;
  if (mode === 'takeout')  return takeaway;
  return dine;
}

function enrichProduct(p) {
  if (!p) return null;
  const units = (p.inventory_enabled && p.allocated_grams > 0)
    ? Math.floor(p.current_stock_grams / p.allocated_grams)
    : null;
  // Compute resolved prices with fallback
  const dine_in_price_eff  = Number(p.dine_in_price)  || Number(p.price) || 0;
  const takeaway_price_eff = Number(p.takeaway_price)  || dine_in_price_eff;
  const delivery_price_eff = Number(p.delivery_price)  || takeaway_price_eff;
  return {
    ...p,
    dine_in_price:  dine_in_price_eff,
    takeaway_price: takeaway_price_eff,
    delivery_price: delivery_price_eff,
    available_units: units,
    is_low_stock:    units !== null && units <= Number(p.low_stock_alert || 5) && units > 0,
    is_out_of_stock: units !== null && units <= 0,
  };
}

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { category, enabled } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const p = [];
    if (category) { sql += ' AND category=?'; p.push(category); }
    if (enabled !== undefined) { sql += ' AND enabled=?'; p.push(Number(enabled)); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    res.json({ success: true, data: db.all(sql, p).map(enrichProduct) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const product = db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!product) return res.status(404).json({ success: false, message: '商品不存在' });
    res.json({ success: true, data: enrichProduct(product) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const {
      name, category='主食', price, sort_order=0, image='',
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled=0, total_stock_grams=0,
      allocated_grams=0, current_stock_grams=0, low_stock_alert=5
    } = req.body;
    if (!name || price === undefined)
      return res.status(400).json({ success: false, message: '名稱與價格為必填' });
    const basePrice = parseFloat(price);
    const dip = dine_in_price  !== undefined ? parseFloat(dine_in_price)  : basePrice;
    const tap = takeaway_price !== undefined ? parseFloat(takeaway_price) : dip;
    const dep = delivery_price !== undefined ? parseFloat(delivery_price) : tap;
    const r = db.run(
      `INSERT INTO products (name,category,price,sort_order,image,
        dine_in_price,takeaway_price,delivery_price,
        inventory_enabled,total_stock_grams,allocated_grams,current_stock_grams,low_stock_alert)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, category, basePrice, sort_order, image||'',
       dip, tap, dep,
       inventory_enabled?1:0, Number(total_stock_grams),
       Number(allocated_grams), Number(current_stock_grams), Number(low_stock_alert)]
    );
    res.status(201).json({ success: true, data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [r.lastInsertRowid])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const ex = db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const {
      name, category, price, enabled, sort_order, image,
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled, total_stock_grams,
      allocated_grams, current_stock_grams, low_stock_alert
    } = req.body;
    const newPrice = price !== undefined ? parseFloat(price) : ex.price;
    const newDip   = dine_in_price  !== undefined ? parseFloat(dine_in_price)  : (ex.dine_in_price  || newPrice);
    const newTap   = takeaway_price !== undefined ? parseFloat(takeaway_price) : (ex.takeaway_price || newDip);
    const newDep   = delivery_price !== undefined ? parseFloat(delivery_price) : (ex.delivery_price || newTap);
    db.run(
      `UPDATE products SET
        name=?,category=?,price=?,enabled=?,sort_order=?,image=?,
        dine_in_price=?,takeaway_price=?,delivery_price=?,
        inventory_enabled=?,total_stock_grams=?,allocated_grams=?,
        current_stock_grams=?,low_stock_alert=?,
        updated_at=datetime('now','localtime')
       WHERE id=?`,
      [
        name??ex.name, category??ex.category, newPrice,
        enabled!==undefined?Number(enabled):ex.enabled,
        sort_order!==undefined?sort_order:ex.sort_order,
        image!==undefined?image:(ex.image||''),
        newDip, newTap, newDep,
        inventory_enabled!==undefined?Number(inventory_enabled):ex.inventory_enabled,
        total_stock_grams!==undefined?Number(total_stock_grams):ex.total_stock_grams,
        allocated_grams!==undefined?Number(allocated_grams):ex.allocated_grams,
        current_stock_grams!==undefined?Number(current_stock_grams):ex.current_stock_grams,
        low_stock_alert!==undefined?Number(low_stock_alert):ex.low_stock_alert,
        req.params.id
      ]
    );
    res.json({ success: true, data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [req.params.id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.get('SELECT id FROM products WHERE id=?', [req.params.id]))
      return res.status(404).json({ success: false, message: '商品不存在' });
    db.run('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ success: true, message: '商品已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
