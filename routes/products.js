// routes/products.js — SaaS R1 fix15
// fix15：修正路由順序——所有固定路徑必須在 /:id 動態路由之前
// 正確順序：
//   GET  /                        (列表)
//   GET  /line-products/list      (固定路徑 ← 必須在 /:id 前)
//   POST /                        (新增)
//   POST /reset-sold-out-today    (固定路徑 ← 必須在 /:id 前)
//   GET  /:id                     (動態)
//   PUT  /:id
//   DELETE /:id
//   PATCH /:id/line-settings
//   PATCH /:id/line-status
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { requireFeature } = require('../middleware/featureGate');
const { calcUnits } = require('./inventory');

function enrichProduct(p) {
  if (!p) return null;
  const hasFormula = !!p._has_formula;
  const units = (p.inventory_enabled && p.allocated_grams > 0 && !hasFormula)
    ? Math.floor(p.current_stock_grams / p.allocated_grams) : null;
  const dip = Number(p.dine_in_price)  || Number(p.price) || 0;
  const tap = Number(p.takeaway_price) || dip;
  const dep = Number(p.delivery_price) || tap;
  const linePrice = Number(p.line_price) || 0;
  const effectiveLinePrice = linePrice > 0 ? linePrice : Number(p.price) || 0;
  const effectiveLineName  = (p.line_name && p.line_name.trim()) ? p.line_name : p.name;
  const saleStatus  = p.sale_status || 'available';
  const showOnLine  = p.show_on_line != null ? Number(p.show_on_line) : 1;
  const saleStatusLabel = {
    available:'正常販售', sold_out_today:'今日完售',
    paused:'暫停販售', sold_out_indefinitely:'長期下架'
  }[saleStatus] || saleStatus;
  return {
    ...p,
    dine_in_price: dip, takeaway_price: tap, delivery_price: dep,
    available_units: units,
    is_low_stock:    units !== null && units <= Number(p.low_stock_alert || 5) && units > 0,
    is_out_of_stock: units !== null && units <= 0,
    show_on_line: showOnLine, line_name: p.line_name || '',
    line_price: linePrice, line_description: p.line_description || '',
    line_image_url: p.line_image_url || '', line_category: p.line_category || '',
    line_category_id: Number(p.line_category_id) || 0,
    effective_line_cat_id: Number(p.line_category_id) || Number(p.category_id) || 0,
    product_barcode: p.product_barcode || '',
    line_hot: Number(p.line_hot) || 0, line_promo: Number(p.line_promo) || 0,
    line_sold_out: Number(p.line_sold_out) || 0,
    sale_status: saleStatus, sale_status_label: saleStatusLabel,
    sold_out_until: p.sold_out_until || '',
    auto_restore_next_day: Number(p.auto_restore_next_day) ?? 1,
    effective_line_price: effectiveLinePrice, effective_line_name: effectiveLineName,
    is_line_orderable: showOnLine === 1 && !p.line_sold_out && saleStatus === 'available',
    has_formula: !!p._has_formula,
    // LINE 可售份數（v1）
    line_quota_enabled:        Number(p.line_quota_enabled)        || 0,
    line_quota_daily:          Number(p.line_quota_daily)          || 0,
    line_quota_sold:           Number(p.line_quota_sold)           || 0,
    line_quota_low_threshold:  Number(p.line_quota_low_threshold)  || 2,
    line_quota_high_threshold: Number(p.line_quota_high_threshold) || 10,
    line_sell_start:           p.line_sell_start || '',
    line_sell_end:             p.line_sell_end   || '',
    line_quota_remaining: Number(p.line_quota_enabled)
      ? Math.max(0, Number(p.line_quota_daily||0) - Number(p.line_quota_sold||0))
      : null,
  };
}

// ══════════════════════════════════════════════════════════
// ★ 固定路徑 (static routes) — 必須全部在 /:id 之前
// ══════════════════════════════════════════════════════════

/* GET /api/products — 商品列表 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { category, enabled } = req.query;
    let sql = 'SELECT * FROM products WHERE store_id=?';
    const p = [storeId];
    if (category) { sql += ' AND category=?'; p.push(category); }
    if (enabled !== undefined) { sql += ' AND enabled=?'; p.push(Number(enabled)); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    const rows = db.all(sql, p).map(r => {
      const fc = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas WHERE product_id=?', [r.id]);
      r._has_formula = fc && Number(fc.c) > 0;
      return enrichProduct(r);
    });
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* GET /api/products/line-products/list — ★ 固定路徑，在 /:id 之前 */
router.get('/line-products/list', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const products = db.all(
      'SELECT * FROM products WHERE store_id=? AND enabled=1 AND show_on_line=1 ORDER BY sort_order, id',
      [storeId]
    ).map(enrichProduct);
    res.json({ success: true, data: products });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* POST /api/products — 新增商品 */
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { name, category='主食', price, sort_order=0, image='',
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled=0, total_stock_grams=0,
      allocated_grams=0, current_stock_grams=0, low_stock_alert=5 } = req.body;
    if (!name || price === undefined)
      return res.status(400).json({ success: false, message: '名稱與價格為必填' });
    const bp  = parseFloat(price);
    const dip = dine_in_price  != null ? parseFloat(dine_in_price)  : bp;
    const tap = takeaway_price != null ? parseFloat(takeaway_price) : dip;
    const dep = delivery_price != null ? parseFloat(delivery_price) : tap;
    const r = db.run(
      `INSERT INTO products (store_id,name,category,price,sort_order,image,
        dine_in_price,takeaway_price,delivery_price,
        inventory_enabled,total_stock_grams,allocated_grams,current_stock_grams,low_stock_alert)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, name, category, bp, sort_order, image || '', dip, tap, dep,
       inventory_enabled ? 1 : 0, Number(total_stock_grams),
       Number(allocated_grams), Number(current_stock_grams), Number(low_stock_alert)]
    );
    res.status(201).json({
      success: true,
      data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [r.lastInsertRowid]))
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* POST /api/products/reset-sold-out-today — ★ 固定路徑，在 /:id 之前 */
router.post('/reset-sold-out-today', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    db.run(
      `UPDATE products SET sale_status='available', updated_at=datetime('now','localtime')
       WHERE store_id=? AND sale_status='sold_out_today' AND auto_restore_next_day=1`,
      [storeId]
    );
    res.json({ success: true, message: '已重置今日完售商品' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
// ★ 動態路徑 (dynamic routes /:id) — 必須全部在固定路徑之後
// ══════════════════════════════════════════════════════════

/* GET /api/products/:id */
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const product = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!product) return res.status(404).json({ success: false, message: '商品不存在' });
    const fc = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas WHERE product_id=?', [product.id]);
    product._has_formula = fc && Number(fc.c) > 0;
    res.json({ success: true, data: enrichProduct(product) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PUT /api/products/:id */
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ex = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const { name, category, price, enabled, sort_order, image,
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled, total_stock_grams, allocated_grams, current_stock_grams, low_stock_alert } = req.body;
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
       WHERE id=? AND store_id=?`,
      [name ?? ex.name, category ?? ex.category, newPrice,
       enabled !== undefined ? Number(enabled) : ex.enabled,
       sort_order !== undefined ? sort_order : ex.sort_order,
       image !== undefined ? image : (ex.image || ''),
       newDip, newTap, newDep,
       inventory_enabled !== undefined ? Number(inventory_enabled) : ex.inventory_enabled,
       total_stock_grams !== undefined ? Number(total_stock_grams) : ex.total_stock_grams,
       allocated_grams !== undefined ? Number(allocated_grams) : ex.allocated_grams,
       current_stock_grams !== undefined ? Number(current_stock_grams) : ex.current_stock_grams,
       low_stock_alert !== undefined ? Number(low_stock_alert) : ex.low_stock_alert,
       req.params.id, storeId]
    );
    res.json({
      success: true,
      data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [req.params.id]))
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* DELETE /api/products/:id */
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    if (!db.get('SELECT id FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]))
      return res.status(404).json({ success: false, message: '商品不存在' });
    db.run('DELETE FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    res.json({ success: true, message: '商品已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/:id/line-settings */
router.patch('/:id/line-settings', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const id = req.params.id;
    const ex = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const {
      show_on_line, line_name, line_price, line_description,
      line_image_url, line_category, line_category_id, line_hot, line_promo,
      line_sold_out, sale_status, sold_out_until, auto_restore_next_day, product_barcode,
      // LINE 接單與可售管理中心 v1 新增欄位
      line_quota_enabled, line_quota_daily, line_quota_sold,
      line_quota_low_threshold, line_quota_high_threshold,
      line_sell_start, line_sell_end,
    } = req.body;
    const sets = []; const vals = [];
    const add = (col, val) => { if (val !== undefined) { sets.push(`${col}=?`); vals.push(val); } };
    add('show_on_line',          show_on_line          != null ? Number(show_on_line)          : undefined);
    add('line_name',             line_name);
    add('line_price',            line_price             != null ? Number(line_price)            : undefined);
    add('line_description',      line_description);
    add('line_image_url',        line_image_url);
    add('line_hot',              line_hot               != null ? Number(line_hot)              : undefined);
    add('line_promo',            line_promo             != null ? Number(line_promo)            : undefined);
    add('line_sold_out',         line_sold_out          != null ? Number(line_sold_out)         : undefined);
    add('sale_status',           sale_status);
    add('sold_out_until',        sold_out_until);
    add('auto_restore_next_day', auto_restore_next_day  != null ? Number(auto_restore_next_day) : undefined);
    add('product_barcode',       product_barcode);
    // v1：LINE 可售份數欄位（僅影響 LINE，不動主庫存）
    add('line_quota_enabled',        line_quota_enabled        != null ? Number(line_quota_enabled)        : undefined);
    add('line_quota_daily',          line_quota_daily          != null ? Number(line_quota_daily)          : undefined);
    // line_quota_sold 允許手動重置（設為 0）
    add('line_quota_sold',           line_quota_sold           != null ? Number(line_quota_sold)           : undefined);
    add('line_quota_low_threshold',  line_quota_low_threshold  != null ? Number(line_quota_low_threshold)  : undefined);
    add('line_quota_high_threshold', line_quota_high_threshold != null ? Number(line_quota_high_threshold) : undefined);
    add('line_sell_start',           line_sell_start);
    add('line_sell_end',             line_sell_end);
    if (line_category_id !== undefined) {
      const catId = Number(line_category_id);
      add('line_category_id', catId);
      if (catId > 0) {
        const catRow = db.get('SELECT name FROM categories WHERE id=? AND store_id=?', [catId, storeId]);
        if (catRow) add('line_category', catRow.name);
      } else if (line_category !== undefined) { add('line_category', line_category); }
    } else if (line_category !== undefined) {
      add('line_category', line_category);
      const catRow = db.get('SELECT id FROM categories WHERE name=? AND store_id=?', [line_category, storeId]);
      if (catRow) add('line_category_id', catRow.id);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的欄位' });
    sets.push("updated_at=datetime('now','localtime')");
    vals.push(id); vals.push(storeId);
    db.run(`UPDATE products SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);
    const updated = db.get('SELECT * FROM products WHERE id=?', [id]);
    // 計算 LINE 剩餘份數供前端顯示
    const quotaRemaining = Number(updated.line_quota_enabled)
      ? Math.max(0, Number(updated.line_quota_daily||0) - Number(updated.line_quota_sold||0))
      : null;
    res.json({ success: true, data: { ...enrichProduct(updated), line_quota_remaining: quotaRemaining } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/:id/line-status */
router.patch('/:id/line-status', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const id = req.params.id;
    const ex = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const { sale_status, show_on_line } = req.body;
    const sets = []; const vals = [];
    const validStatuses = ['available', 'sold_out_today', 'paused', 'sold_out_indefinitely'];
    if (sale_status !== undefined) {
      if (!validStatuses.includes(sale_status))
        return res.status(400).json({ success: false, message: '無效的 sale_status' });
      sets.push('sale_status=?'); vals.push(sale_status);
    }
    if (show_on_line !== undefined) { sets.push('show_on_line=?'); vals.push(Number(show_on_line)); }
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的欄位' });
    sets.push("updated_at=datetime('now','localtime')");
    vals.push(id); vals.push(storeId);
    db.run(`UPDATE products SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);
    res.json({ success: true, data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
