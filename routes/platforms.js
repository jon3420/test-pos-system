// routes/platforms.js — 外送平台管理
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { active } = req.query;
    let sql = 'SELECT * FROM delivery_platforms WHERE 1=1';
    const p = [];
    if (active !== undefined) { sql += ' AND is_active=?'; p.push(Number(active)); }
    sql += ' ORDER BY id ASC';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, commission_rate = 0 } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '平台名稱必填' });
    if (db.get('SELECT id FROM delivery_platforms WHERE name=?', [name.trim()]))
      return res.status(409).json({ success: false, message: '平台名稱已存在' });
    const r = db.run('INSERT INTO delivery_platforms (name,commission_rate) VALUES (?,?)',
      [name.trim(), Number(commission_rate)]);
    res.status(201).json({ success: true, data: db.get('SELECT * FROM delivery_platforms WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const plat = db.get('SELECT * FROM delivery_platforms WHERE id=?', [req.params.id]);
    if (!plat) return res.status(404).json({ success: false, message: '平台不存在' });
    const { name, commission_rate, is_active } = req.body;
    if (name && name.trim() !== plat.name) {
      if (db.get('SELECT id FROM delivery_platforms WHERE name=? AND id!=?', [name.trim(), plat.id]))
        return res.status(409).json({ success: false, message: '平台名稱已存在' });
    }
    db.run(
      "UPDATE delivery_platforms SET name=?,commission_rate=?,is_active=?,updated_at=datetime('now','localtime') WHERE id=?",
      [name ?? plat.name, commission_rate !== undefined ? Number(commission_rate) : plat.commission_rate,
       is_active !== undefined ? Number(is_active) : plat.is_active, plat.id]
    );
    res.json({ success: true, data: db.get('SELECT * FROM delivery_platforms WHERE id=?', [plat.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    if (!db.get('SELECT id FROM delivery_platforms WHERE id=?', [req.params.id]))
      return res.status(404).json({ success: false, message: '平台不存在' });
    db.run('DELETE FROM delivery_platforms WHERE id=?', [req.params.id]);
    res.json({ success: true, message: '已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
