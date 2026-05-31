// routes/platforms.js — SaaS R1 fix2（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/platforms
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { active } = req.query;
    let sql = 'SELECT * FROM delivery_platforms WHERE store_id=?';
    const p = [storeId];
    if (active !== undefined) { sql += ' AND is_active=?'; p.push(Number(active)); }
    sql += ' ORDER BY id ASC';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/platforms
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { name, commission_rate = 0 } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: '平台名稱必填' });
    // ★ fix2：UNIQUE 檢查限本店
    if (db.get('SELECT id FROM delivery_platforms WHERE store_id=? AND name=?', [storeId, name.trim()]))
      return res.status(409).json({ success: false, message: '平台名稱已存在' });
    const r = db.run(
      'INSERT INTO delivery_platforms (store_id,name,commission_rate) VALUES (?,?,?)',
      [storeId, name.trim(), Number(commission_rate)]
    );
    res.status(201).json({ success: true, data: db.get('SELECT * FROM delivery_platforms WHERE id=?', [r.lastInsertRowid]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/platforms/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查詢加 AND store_id=?
    const plat = db.get('SELECT * FROM delivery_platforms WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!plat) return res.status(404).json({ success: false, message: '平台不存在' });
    const { name, commission_rate, is_active } = req.body;
    if (name && name.trim() !== plat.name) {
      if (db.get('SELECT id FROM delivery_platforms WHERE store_id=? AND name=? AND id!=?', [storeId, name.trim(), plat.id]))
        return res.status(409).json({ success: false, message: '平台名稱已存在' });
    }
    db.run(
      "UPDATE delivery_platforms SET name=?,commission_rate=?,is_active=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?",
      [name ?? plat.name,
       commission_rate !== undefined ? Number(commission_rate) : plat.commission_rate,
       is_active !== undefined ? Number(is_active) : plat.is_active,
       plat.id, storeId]
    );
    res.json({ success: true, data: db.get('SELECT * FROM delivery_platforms WHERE id=? AND store_id=?', [plat.id, storeId]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/platforms/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查詢加 AND store_id=?
    if (!db.get('SELECT id FROM delivery_platforms WHERE id=? AND store_id=?', [req.params.id, storeId]))
      return res.status(404).json({ success: false, message: '平台不存在' });
    db.run('DELETE FROM delivery_platforms WHERE id=? AND store_id=?', [req.params.id, storeId]);
    res.json({ success: true, message: '已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
