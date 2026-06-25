// routes/discount-categories.js — fix18-09E 折扣分類設定
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// 預設折扣分類
const DEFAULT_CATEGORIES = [
  { code: 'product_promo',  name: '商品活動', icon: '🟢', color: '#10b981', sort_order: 1 },
  { code: 'marketing',      name: '廣告行銷', icon: '🔵', color: '#3b82f6', sort_order: 2 },
  { code: 'complaint',      name: '客訴補償', icon: '🟠', color: '#f97316', sort_order: 3 },
  { code: 'loyalty',        name: '老客優惠', icon: '🟣', color: '#a855f7', sort_order: 4 },
  { code: 'staff_family',   name: '員工親友', icon: '⚫', color: '#64748b', sort_order: 5 },
  { code: 'platform_promo', name: '平台活動', icon: '🟡', color: '#eab308', sort_order: 6 },
  { code: 'other',          name: '其他',     icon: '⚪', color: '#94a3b8', sort_order: 7 },
];

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discount_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id    TEXT NOT NULL DEFAULT 'store_001',
      code        TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      icon        TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '#94a3b8',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_discount_categories_store ON discount_categories(store_id);
  `);
}

function seedDefaults(db, storeId) {
  const cnt = db.get('SELECT COUNT(*) as n FROM discount_categories WHERE store_id=?', [storeId]);
  if (cnt && cnt.n > 0) return;
  DEFAULT_CATEGORIES.forEach(c => {
    db.run(
      'INSERT INTO discount_categories (store_id,code,name,icon,color,enabled,sort_order) VALUES (?,?,?,?,?,1,?)',
      [storeId, c.code, c.name, c.icon, c.color, c.sort_order]
    );
  });
}

// GET / — 取得所有折扣分類
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    ensureTable(db);
    seedDefaults(db, storeId);
    const rows = db.all(
      'SELECT * FROM discount_categories WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST / — 新增折扣分類
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    ensureTable(db);
    const { name, code, icon = '⚪', color = '#94a3b8', sort_order = 0 } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '分類名稱為必填' });
    // auto-generate code if not provided
    const autoCode = (code || name).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || ('cat_' + Date.now());
    const result = db.run(
      'INSERT INTO discount_categories (store_id,code,name,icon,color,enabled,sort_order) VALUES (?,?,?,?,?,1,?)',
      [storeId, autoCode, name.trim(), icon, color, Number(sort_order) || 0]
    );
    const row = db.get('SELECT * FROM discount_categories WHERE id=?', [result.lastInsertRowid]);
    res.status(201).json({ success: true, data: row });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /:id — 修改折扣分類
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    ensureTable(db);
    const row = db.get('SELECT * FROM discount_categories WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!row) return res.status(404).json({ success: false, message: '找不到此分類' });
    const { name, icon, color, enabled, sort_order } = req.body;
    db.run(
      `UPDATE discount_categories SET name=?,icon=?,color=?,enabled=?,sort_order=? WHERE id=? AND store_id=?`,
      [
        name !== undefined ? name.trim() : row.name,
        icon !== undefined ? icon : row.icon,
        color !== undefined ? color : row.color,
        enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
        sort_order !== undefined ? Number(sort_order) : row.sort_order,
        row.id, storeId
      ]
    );
    const updated = db.get('SELECT * FROM discount_categories WHERE id=?', [row.id]);
    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /:id — 刪除折扣分類
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    ensureTable(db);
    const row = db.get('SELECT * FROM discount_categories WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!row) return res.status(404).json({ success: false, message: '找不到此分類' });
    db.run('DELETE FROM discount_categories WHERE id=? AND store_id=?', [row.id, storeId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
