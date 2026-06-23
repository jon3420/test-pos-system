// routes/discount-campaigns.js — fix18-09C 折扣活動設定
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// 預設折扣活動
const DEFAULT_CAMPAIGNS = [
  { name: '買一送一',     description: '', sort_order: 1 },
  { name: '套餐折扣',     description: '', sort_order: 2 },
  { name: '第二件半價',   description: '', sort_order: 3 },
  { name: '五星評論送毛豆', description: '', sort_order: 4 },
  { name: '會員折扣',     description: '', sort_order: 5 },
  { name: '老客優惠',     description: '', sort_order: 6 },
  { name: '平台活動',     description: '', sort_order: 7 },
  { name: '其他',         description: '', sort_order: 8 },
];

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discount_campaigns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id    TEXT NOT NULL DEFAULT 'store_001',
      name        TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_discount_campaigns_store ON discount_campaigns(store_id);
  `);
}

function seedDefaults(db, storeId) {
  const cnt = db.get('SELECT COUNT(*) as n FROM discount_campaigns WHERE store_id=?', [storeId]);
  if (cnt && cnt.n > 0) return;
  DEFAULT_CAMPAIGNS.forEach(c => {
    db.run(
      'INSERT INTO discount_campaigns (store_id,name,description,enabled,sort_order) VALUES (?,?,?,1,?)',
      [storeId, c.name, c.description, c.sort_order]
    );
  });
}

// GET / — 取得所有折扣活動
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    ensureTable(db);
    seedDefaults(db, storeId);
    const rows = db.all(
      'SELECT * FROM discount_campaigns WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST / — 新增折扣活動
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    ensureTable(db);
    const { name, description = '', sort_order = 0 } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '活動名稱為必填' });
    const result = db.run(
      'INSERT INTO discount_campaigns (store_id,name,description,enabled,sort_order) VALUES (?,?,?,1,?)',
      [storeId, name.trim(), description.trim(), Number(sort_order) || 0]
    );
    const row = db.get('SELECT * FROM discount_campaigns WHERE id=?', [result.lastInsertRowid]);
    res.status(201).json({ success: true, data: row });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /:id — 修改折扣活動
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    ensureTable(db);
    const row = db.get('SELECT * FROM discount_campaigns WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!row) return res.status(404).json({ success: false, message: '找不到此活動' });
    const { name, description, enabled, sort_order } = req.body;
    db.run(
      `UPDATE discount_campaigns SET name=?,description=?,enabled=?,sort_order=? WHERE id=? AND store_id=?`,
      [
        name !== undefined ? name.trim() : row.name,
        description !== undefined ? description.trim() : row.description,
        enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
        sort_order !== undefined ? Number(sort_order) : row.sort_order,
        row.id, storeId
      ]
    );
    const updated = db.get('SELECT * FROM discount_campaigns WHERE id=?', [row.id]);
    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /:id — 刪除折扣活動
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    ensureTable(db);
    const row = db.get('SELECT * FROM discount_campaigns WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!row) return res.status(404).json({ success: false, message: '找不到此活動' });
    db.run('DELETE FROM discount_campaigns WHERE id=? AND store_id=?', [row.id, storeId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
