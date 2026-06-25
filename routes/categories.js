// routes/categories.js — SaaS R1（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/categories
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { active } = req.query;
    let sql = 'SELECT * FROM categories WHERE store_id=?';
    const p = [storeId];
    if (active !== undefined) { sql += ' AND is_active=?'; p.push(Number(active)); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/line-options', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cats = db.all(
      'SELECT id, name, icon, sort_order FROM categories WHERE store_id=? AND is_active=1 ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    res.json({ success: true, data: cats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/pos-options', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cats = db.all(
      'SELECT id, name, icon, sort_order FROM categories WHERE store_id=? AND is_active=1 ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    res.json({ success: true, data: cats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { name, icon='📌', sort_order=0 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: '分類名稱必填' });
    const exists = db.get('SELECT id FROM categories WHERE store_id=? AND name=?', [storeId, name.trim()]);
    if (exists) return res.status(409).json({ success: false, message: '分類名稱已存在' });
    const r = db.run(
      'INSERT INTO categories (store_id,name,icon,sort_order) VALUES (?,?,?,?)',
      [storeId, name.trim(), icon||'📌', Number(sort_order)]
    );
    res.status(201).json({ success: true, data: db.get('SELECT * FROM categories WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cat = db.get('SELECT * FROM categories WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!cat) return res.status(404).json({ success: false, message: '分類不存在' });
    const { name, icon, sort_order, is_active } = req.body;
    if (name && name.trim() !== cat.name) {
      const dup = db.get('SELECT id FROM categories WHERE store_id=? AND name=? AND id!=?', [storeId, name.trim(), cat.id]);
      if (dup) return res.status(409).json({ success: false, message: '分類名稱已存在' });
    }
    const newName = name ?? cat.name;
    if (name && name.trim() !== cat.name) {
      db.run(`UPDATE products SET line_category=?,updated_at=datetime('now','localtime') WHERE store_id=? AND line_category=?`,
        [name.trim(), storeId, cat.name]);
    }
    db.run(
      "UPDATE categories SET name=?,icon=?,sort_order=?,is_active=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [newName, icon??cat.icon, sort_order!==undefined?Number(sort_order):cat.sort_order,
       is_active!==undefined?Number(is_active):cat.is_active, cat.id, storeId]
    );
    res.json({ success: true, data: db.get('SELECT * FROM categories WHERE id=?', [cat.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cat = db.get('SELECT * FROM categories WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!cat) return res.status(404).json({ success: false, message: '分類不存在' });
    const productCount = db.get('SELECT COUNT(*) as c FROM products WHERE store_id=? AND category=? AND enabled=1', [storeId, cat.name]);
    if (productCount && Number(productCount.c) > 0) {
      return res.status(400).json({ success: false, message: `此分類下有 ${productCount.c} 個啟用商品，請先移除或停用商品` });
    }
    db.run('DELETE FROM categories WHERE id=? AND store_id=?', [cat.id, storeId]);
    res.json({ success: true, message: '分類已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
