// routes/ingredients.js — SaaS R1 fix1（多店隔離版）
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

function batchNo() {
  const n = new Date();
  return `B${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}-${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}`;
}

function writeLog(db, ing, type, chg, reason, op, batchNoStr='', orderId='', thawTime='') {
  const bFrozen = Number(ing.frozen_stock||0);
  const bThaw   = Number(ing.thawing_stock||0);
  const bRefrig = Number(ing.refrigerated_stock||0);
  const dFrozen = chg.frozen||0, dThaw = chg.thawing||0, dRefrig = chg.refrig||0;
  db.run(`INSERT INTO ingredient_logs
    (ingredient_id,ingredient_name,batch_no,log_type,
     before_frozen,before_thawing,before_refrigerated,change_amount,
     after_frozen,after_thawing,after_refrigerated,
     reason,operator,related_order_id,thaw_complete_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ing.id, ing.name, batchNoStr, type,
     bFrozen, bThaw, bRefrig, Math.abs(dFrozen||dThaw||dRefrig),
     bFrozen+dFrozen, bThaw+dThaw, bRefrig+dRefrig,
     reason, op, orderId, thawTime]
  );
}

function broadcast(req, type, data) {
  // ★ fix6：只廣播給同 store_id 的 WebSocket client
  try {
    const wss     = req.app.get('wss');
    const storeId = req.storeId || 'store_001';
    broadcastToStore(wss, storeId, { type, data });
  } catch {}
}

// GET /api/ingredients
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    res.json({ success: true, data: db.all('SELECT * FROM ingredients WHERE store_id=? ORDER BY id ASC', [storeId]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ingredients/logs/all
router.get('/logs/all', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { ingredient_id, log_type, limit=100, offset=0 } = req.query;
    // ingredient_logs join ingredients で store_id 確認
    let sql = `SELECT il.* FROM ingredient_logs il
               INNER JOIN ingredients i ON i.id=il.ingredient_id AND i.store_id=?
               WHERE 1=1`;
    const p = [storeId];
    if (ingredient_id) { sql += ' AND il.ingredient_id=?'; p.push(Number(ingredient_id)); }
    if (log_type) { sql += ' AND il.log_type=?'; p.push(log_type); }
    sql += ' ORDER BY il.id DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), Number(offset));
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ingredients/batches/all
router.get('/batches/all', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { ingredient_id } = req.query;
    let sql = `SELECT b.*, i.name as ingredient_name FROM ingredient_batches b
               INNER JOIN ingredients i ON i.id=b.ingredient_id AND i.store_id=?
               WHERE 1=1`;
    const p = [storeId];
    if (ingredient_id) { sql += ' AND b.ingredient_id=?'; p.push(Number(ingredient_id)); }
    sql += ' ORDER BY b.id DESC';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ingredients/formulas/all
router.get('/formulas/all', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { product_id } = req.query;
    let sql = `SELECT f.*, i.name as ingredient_name, i.unit, p.name as product_name
               FROM product_ingredient_formulas f
               INNER JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=?
               INNER JOIN products p ON p.id=f.product_id AND p.store_id=?
               WHERE 1=1`;
    const params = [storeId, storeId];
    if (product_id) { sql += ' AND f.product_id=?'; params.push(Number(product_id)); }
    res.json({ success: true, data: db.all(sql, params) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ingredients/thaw-batches/all
router.get('/thaw-batches/all', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { ingredient_id, status } = req.query;
    let sql = `SELECT tb.* FROM ingredient_thaw_batches tb
               INNER JOIN ingredients i ON i.id=tb.ingredient_id AND i.store_id=?
               WHERE 1=1`;
    const p = [storeId];
    if (ingredient_id) { sql += ' AND tb.ingredient_id=?'; p.push(Number(ingredient_id)); }
    if (status) { sql += ' AND tb.status=?'; p.push(status); }
    sql += ' ORDER BY tb.id DESC LIMIT 200';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/ingredients/:id
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    res.json({ success: true, data: ing });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { name, unit='g', ingredient_barcode='', notes='', initial_stock=0, low_stock_threshold=0 } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '食材名稱必填' });
    const exists = db.get('SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, name.trim()]);
    if (exists) return res.status(409).json({ success: false, message: '食材名稱已存在' });
    const initStock = Number(initial_stock)||0;
    const r = db.run(`INSERT INTO ingredients (store_id,name,unit,ingredient_barcode,notes,frozen_stock,total_stock,low_stock_threshold,default_thaw_hours) VALUES (?,?,?,?,?,?,?,?,?)`,
      [storeId, name.trim(), unit, ingredient_barcode, notes, initStock, initStock, Number(low_stock_threshold)||0, Number(req.body.default_thaw_hours)||0]);
    res.status(201).json({ success: true, data: db.get('SELECT * FROM ingredients WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/ingredients/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { name, unit, ingredient_barcode, notes, low_stock_threshold, default_thaw_hours } = req.body;
    db.run(`UPDATE ingredients SET name=?,unit=?,ingredient_barcode=?,notes=?,low_stock_threshold=?,default_thaw_hours=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [name??ing.name, unit??ing.unit, ingredient_barcode??ing.ingredient_barcode, notes??ing.notes,
       low_stock_threshold!=null ? Number(low_stock_threshold) : (ing.low_stock_threshold||0),
       default_thaw_hours!=null ? Number(default_thaw_hours) : (ing.default_thaw_hours||0), ing.id, storeId]);
    res.json({ success: true, data: db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/ingredients/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    db.run('DELETE FROM ingredients WHERE id=? AND store_id=?', [ing.id, storeId]);
    res.json({ success: true, message: '食材已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/:id/purchase
router.post('/:id/purchase', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { amount, batch_no, batch_barcode='', purchase_date='', reason='進貨', operator='staff' } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ success: false, message: 'amount 必填且需大於 0' });
    const addAmt = Number(amount);
    const newBatch = batch_no || batchNo();
    const newFrz   = Number(ing.frozen_stock) + addAmt;
    const newTotal = Number(ing.total_stock)  + addAmt;
    db.run(`UPDATE ingredients SET total_stock=?,frozen_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [newTotal, newFrz, ing.id, storeId]);
    db.run(`INSERT INTO ingredient_batches (ingredient_id,batch_no,batch_barcode,purchase_date,quantity,unit) VALUES (?,?,?,?,?,?)`,
      [ing.id, newBatch, batch_barcode, purchase_date, addAmt, ing.unit]);
    writeLog(db, ing, 'purchase', {frozen: addAmt}, reason, operator, newBatch);
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated, batch_no: newBatch });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/:id/freeze-to-thaw
router.post('/:id/freeze-to-thaw', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { amount, thaw_complete_time='', batch_no='', operator='staff' } = req.body;
    const amt = Number(amount);
    if (amt <= 0) return res.status(400).json({ success: false, message: 'amount 必須大於 0' });
    if (Number(ing.frozen_stock) < amt)
      return res.status(400).json({ success: false, message: `冷凍庫存不足（現有 ${ing.frozen_stock} ${ing.unit}）` });
    db.run(`UPDATE ingredients SET frozen_stock=frozen_stock-?,thawing_stock=thawing_stock+?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [amt, amt, ing.id, storeId]);
    writeLog(db, ing, 'freeze_to_thaw', {frozen:-amt, thawing:amt}, '轉解凍中', operator, batch_no, '', thaw_complete_time);
    db.run(`INSERT INTO ingredient_thaw_batches (ingredient_id,ingredient_name,amount,unit,expected_complete_at,status,notes) VALUES (?,?,?,?,?,?,?)`,
      [ing.id, ing.name, amt, ing.unit, thaw_complete_time||'', 'thawing', batch_no||'']);
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/:id/thaw-complete
router.post('/:id/thaw-complete', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { amount, batch_no='', operator='staff' } = req.body;
    const amt = Number(amount);
    if (amt <= 0) return res.status(400).json({ success: false, message: 'amount 必須大於 0' });
    if (Number(ing.thawing_stock) < amt)
      return res.status(400).json({ success: false, message: `解凍中庫存不足（現有 ${ing.thawing_stock} ${ing.unit}）` });
    db.run(`UPDATE ingredients SET thawing_stock=thawing_stock-?,refrigerated_stock=refrigerated_stock+?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [amt, amt, ing.id, storeId]);
    writeLog(db, ing, 'thaw_complete', {thawing:-amt, refrig:amt}, '解凍完成', operator, batch_no);
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/:id/scrap
router.post('/:id/scrap', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { amount, from='refrigerated', reason='報廢', operator='staff', batch_no='' } = req.body;
    const amt = Number(amount);
    const colMap = { frozen:'frozen_stock', thawing:'thawing_stock', refrigerated:'refrigerated_stock' };
    const col = colMap[from];
    if (!col) return res.status(400).json({ success: false, message: 'from 需為 frozen/thawing/refrigerated' });
    if (Number(ing[col]) < amt)
      return res.status(400).json({ success: false, message: `${from} 庫存不足以報廢（現有 ${ing[col]} ${ing.unit}）` });
    db.run(`UPDATE ingredients SET ${col}=${col}-?,scrapped_total=scrapped_total+?,total_stock=total_stock-?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [amt, amt, amt, ing.id, storeId]);
    const chg = {frozen:0, thawing:0, refrig:0};
    if (from==='frozen') chg.frozen=-amt;
    else if (from==='thawing') chg.thawing=-amt;
    else chg.refrig=-amt;
    writeLog(db, ing, 'scrap', chg, reason, operator, batch_no);
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/:id/manual-adjust
router.post('/:id/manual-adjust', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const { frozen_delta=0, thawing_delta=0, refrigerated_delta=0, reason='手動調整', operator='staff' } = req.body;
    const fd=Number(frozen_delta), td=Number(thawing_delta), rd=Number(refrigerated_delta);
    const nf = Math.max(0, Number(ing.frozen_stock)+fd);
    const nt = Math.max(0, Number(ing.thawing_stock)+td);
    const nr = Math.max(0, Number(ing.refrigerated_stock)+rd);
    const total = nf+nt+nr;
    db.run(`UPDATE ingredients SET frozen_stock=?,thawing_stock=?,refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [nf, nt, nr, total, ing.id, storeId]);
    writeLog(db, ing, 'manual_adjust', {frozen:fd, thawing:td, refrig:rd}, reason, operator);
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/formulas/add
router.post('/formulas/add', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { product_id, ingredient_id, amount_per_unit, product_barcode='', notes='' } = req.body;
    if (!product_id || !ingredient_id || !amount_per_unit)
      return res.status(400).json({ success: false, message: 'product_id/ingredient_id/amount_per_unit 必填' });
    // 確認商品與食材都屬於此店
    const prod = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [product_id, storeId]);
    const ing  = db.get('SELECT id FROM ingredients WHERE id=? AND store_id=?', [ingredient_id, storeId]);
    if (!prod) return res.status(404).json({ success: false, message: '商品不存在' });
    if (!ing)  return res.status(404).json({ success: false, message: '食材不存在' });
    const exists = db.get('SELECT id FROM product_ingredient_formulas WHERE product_id=? AND ingredient_id=?', [product_id, ingredient_id]);
    if (exists) {
      db.run('UPDATE product_ingredient_formulas SET amount_per_unit=?,notes=? WHERE product_id=? AND ingredient_id=?',
        [Number(amount_per_unit), notes, product_id, ingredient_id]);
      db.run("UPDATE products SET inventory_enabled=1,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?", [product_id, storeId]);
      return res.json({ success: true, message: '扣料公式已更新' });
    }
    const r = db.run(`INSERT INTO product_ingredient_formulas (product_id,product_barcode,ingredient_id,amount_per_unit,notes) VALUES (?,?,?,?,?)`,
      [product_id, product_barcode, ingredient_id, Number(amount_per_unit), notes]);
    db.run("UPDATE products SET inventory_enabled=1,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?", [product_id, storeId]);
    res.status(201).json({ success: true, data: db.get('SELECT * FROM product_ingredient_formulas WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/ingredients/formulas/:id
router.delete('/formulas/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // 透過 JOIN 確認該公式屬於此店的商品
    const formula = db.get(`SELECT f.id FROM product_ingredient_formulas f
      INNER JOIN products p ON p.id=f.product_id AND p.store_id=?
      WHERE f.id=?`, [storeId, req.params.id]);
    if (!formula) return res.status(404).json({ success: false, message: '扣料公式不存在' });
    db.run('DELETE FROM product_ingredient_formulas WHERE id=?', [req.params.id]);
    res.json({ success: true, message: '扣料公式已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/thaw-batches/:batchId/complete
router.post('/thaw-batches/:batchId/complete', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const batch = db.get(`SELECT tb.* FROM ingredient_thaw_batches tb
      INNER JOIN ingredients i ON i.id=tb.ingredient_id AND i.store_id=?
      WHERE tb.id=?`, [storeId, req.params.batchId]);
    if (!batch) return res.status(404).json({ success: false, message: '批次不存在' });
    if (batch.status === 'completed') return res.json({ success: true, message: '批次已完成' });
    const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [batch.ingredient_id, storeId]);
    if (!ing) return res.status(404).json({ success: false, message: '食材不存在' });
    const amt = Math.min(Number(batch.amount), Number(ing.thawing_stock || 0));
    if (amt <= 0) return res.status(400).json({ success: false, message: '解凍中庫存不足' });
    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0,16);
    db.run(`UPDATE ingredients SET thawing_stock=thawing_stock-?,refrigerated_stock=refrigerated_stock+?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [amt, amt, ing.id, storeId]);
    db.run(`UPDATE ingredient_thaw_batches SET status='completed',completed_at=?,updated_at=datetime('now','localtime') WHERE id=?`, [now, batch.id]);
    writeLog(db, ing, 'thaw_complete', {thawing:-amt, refrig:amt}, '手動解凍完成（批次）', req.body.operator||'staff', '');
    const updated = db.get('SELECT * FROM ingredients WHERE id=?', [ing.id]);
    broadcast(req, 'ingredient_updated', updated);
    res.json({ success: true, data: updated });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/thaw-batches/:batchId/extend
router.post('/thaw-batches/:batchId/extend', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const batch = db.get(`SELECT tb.* FROM ingredient_thaw_batches tb
      INNER JOIN ingredients i ON i.id=tb.ingredient_id AND i.store_id=?
      WHERE tb.id=?`, [storeId, req.params.batchId]);
    if (!batch) return res.status(404).json({ success: false, message: '批次不存在' });
    const { new_expected_at, notes='' } = req.body;
    if (!new_expected_at) return res.status(400).json({ success: false, message: 'new_expected_at 必填' });
    db.run(`UPDATE ingredient_thaw_batches SET expected_complete_at=?,status='thawing',extended_count=extended_count+1,notes=?,updated_at=datetime('now','localtime') WHERE id=?`,
      [new_expected_at, notes||batch.notes, batch.id]);
    res.json({ success: true, data: db.get('SELECT * FROM ingredient_thaw_batches WHERE id=?', [batch.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/ingredients/thaw-batches/auto-complete
router.post('/thaw-batches/auto-complete', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0,16);
    const due = db.all(`SELECT tb.* FROM ingredient_thaw_batches tb
      INNER JOIN ingredients i ON i.id=tb.ingredient_id AND i.store_id=?
      WHERE tb.status='thawing' AND tb.expected_complete_at != '' AND tb.expected_complete_at <= ?`,
      [storeId, now]);
    let completed = 0;
    due.forEach(batch => {
      const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [batch.ingredient_id, storeId]);
      if (!ing) return;
      const amt = Math.min(Number(batch.amount), Number(ing.thawing_stock || 0));
      if (amt <= 0) { db.run(`UPDATE ingredient_thaw_batches SET status='completed',completed_at=?,updated_at=datetime('now','localtime') WHERE id=?`, [now, batch.id]); return; }
      db.run(`UPDATE ingredients SET thawing_stock=thawing_stock-?,refrigerated_stock=refrigerated_stock+?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [amt, amt, ing.id, storeId]);
      db.run(`UPDATE ingredient_thaw_batches SET status='completed',completed_at=?,updated_at=datetime('now','localtime') WHERE id=?`, [now, batch.id]);
      writeLog(db, ing, 'thaw_complete', {thawing:-amt, refrig:amt}, '自動解凍完成', 'system', '');
      completed++;
    });
    res.json({ success: true, completed });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
