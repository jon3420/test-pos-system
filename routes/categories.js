// routes/categories.js — v16 整合版（含 LINE 聯動）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/categories
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { active } = req.query;
    let sql = 'SELECT * FROM categories WHERE 1=1';
    const p = [];
    if (active !== undefined) { sql += ' AND is_active=?'; p.push(Number(active)); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/categories/line-options — LINE 顯示分類下拉選單（客人端）
// 說明：資料來自同一個 categories 表，但用途是 LINE 點餐頁的「客人端顯示分類」
//       與 POS 內部分類是同一份資料，只是呈現在不同入口
router.get('/line-options', (req, res) => {
  try {
    const db = getDb();
    const cats = db.all(
      'SELECT id, name, icon, sort_order FROM categories WHERE is_active=1 ORDER BY sort_order ASC, id ASC'
    );
    res.json({ success: true, data: cats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/categories/pos-options — POS 內部分類下拉選單（Web + Android 共用）
// 用途：Web 商品新增/編輯的分類選單
router.get('/pos-options', (req, res) => {
  try {
    const db = getDb();
    const cats = db.all(
      'SELECT id, name, icon, sort_order FROM categories WHERE is_active=1 ORDER BY sort_order ASC, id ASC'
    );
    res.json({ success: true, data: cats });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/categories
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, icon='📌', sort_order=0 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: '分類名稱必填' });
    const exists = db.get('SELECT id FROM categories WHERE name=?', [name.trim()]);
    if (exists) return res.status(409).json({ success: false, message: '分類名稱已存在' });
    const r = db.run(
      'INSERT INTO categories (name,icon,sort_order) VALUES (?,?,?)',
      [name.trim(), icon||'📌', Number(sort_order)]
    );
    res.status(201).json({ success: true, data: db.get('SELECT * FROM categories WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/categories/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const cat = db.get('SELECT * FROM categories WHERE id=?', [req.params.id]);
    if (!cat) return res.status(404).json({ success: false, message: '分類不存在' });
    const { name, icon, sort_order, is_active } = req.body;
    if (name && name.trim() !== cat.name) {
      const dup = db.get('SELECT id FROM categories WHERE name=? AND id!=?', [name.trim(), cat.id]);
      if (dup) return res.status(409).json({ success: false, message: '分類名稱已存在' });
    }
    const newName = name ?? cat.name;
    // 同步更新 products.line_category（若分類名稱改變）
    if (name && name.trim() !== cat.name) {
      db.run(`UPDATE products SET line_category=?,updated_at=datetime('now','localtime') WHERE line_category=?`,
        [name.trim(), cat.name]);
    }
    db.run(
      "UPDATE categories SET name=?,icon=?,sort_order=?,is_active=?,updated_at=datetime('now','localtime') WHERE id=?",
      [newName, icon??cat.icon, sort_order!==undefined?Number(sort_order):cat.sort_order,
       is_active!==undefined?Number(is_active):cat.is_active, cat.id]
    );
    res.json({ success: true, data: db.get('SELECT * FROM categories WHERE id=?', [cat.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/categories/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const cat = db.get('SELECT * FROM categories WHERE id=?', [req.params.id]);
    if (!cat) return res.status(404).json({ success: false, message: '分類不存在' });
    const productCount = db.get('SELECT COUNT(*) as c FROM products WHERE category=? AND enabled=1', [cat.name]);
    if (productCount && Number(productCount.c) > 0) {
      return res.status(400).json({ success: false, message: `此分類下有 ${productCount.c} 個啟用商品，請先移除或停用商品` });
    }
    db.run('DELETE FROM categories WHERE id=?', [cat.id]);
    res.json({ success: true, message: '分類已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
