// routes/product-analysis-groups.js — fix18-09F
// 商品分析群組 CRUD API
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// GET /api/product-analysis-groups — 取得所有群組（含成員）
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const groups = db.all(
      `SELECT * FROM product_analysis_groups WHERE store_id=? ORDER BY sort_order, id`,
      [storeId]
    );
    const items = db.all(
      `SELECT * FROM product_analysis_group_items WHERE store_id=? ORDER BY id`,
      [storeId]
    );
    const result = groups.map(g => ({
      ...g,
      items: items.filter(i => Number(i.group_id) === Number(g.id))
    }));
    res.json({ success: true, data: result });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/product-analysis-groups/:id — 取得單一群組
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const group = db.get(
      `SELECT * FROM product_analysis_groups WHERE id=? AND store_id=?`,
      [req.params.id, storeId]
    );
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });
    const items = db.all(
      `SELECT * FROM product_analysis_group_items WHERE group_id=? AND store_id=? ORDER BY id`,
      [group.id, storeId]
    );
    res.json({ success: true, data: { ...group, items } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/product-analysis-groups — 新增群組
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { group_name, description = '', enabled = 1, sort_order = 0, items = [] } = req.body;
    if (!group_name || !group_name.trim()) return res.status(400).json({ success: false, message: '群組名稱不可空白' });

    const r = db.run(
      `INSERT INTO product_analysis_groups (store_id, group_name, description, enabled, sort_order) VALUES (?,?,?,?,?)`,
      [storeId, group_name.trim(), description, enabled ? 1 : 0, sort_order]
    );
    const groupId = r.lastInsertRowid;

    // 寫入成員
    (items || []).forEach(item => {
      const pname = (item.product_name || item.name || '').trim();
      if (!pname) return;
      db.run(
        `INSERT INTO product_analysis_group_items (store_id, group_id, product_id, product_name) VALUES (?,?,?,?)`,
        [storeId, groupId, item.product_id || 0, pname]
      );
    });

    res.json({ success: true, message: '群組已建立', id: groupId });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/product-analysis-groups/:id — 更新群組（含成員重建）
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const id = req.params.id;
    const { group_name, description, enabled, sort_order, items } = req.body;

    const existing = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '群組不存在' });

    if (group_name !== undefined) {
      db.run(
        `UPDATE product_analysis_groups SET group_name=?, description=?, enabled=?, sort_order=?, updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
        [group_name.trim(), description ?? '', enabled != null ? (enabled ? 1 : 0) : 1, sort_order ?? 0, id, storeId]
      );
    }

    // 若有傳 items，重建成員列表
    if (Array.isArray(items)) {
      db.run(`DELETE FROM product_analysis_group_items WHERE group_id=? AND store_id=?`, [id, storeId]);
      items.forEach(item => {
        const pname = (item.product_name || item.name || '').trim();
        if (!pname) return;
        db.run(
          `INSERT INTO product_analysis_group_items (store_id, group_id, product_id, product_name) VALUES (?,?,?,?)`,
          [storeId, id, item.product_id || 0, pname]
        );
      });
    }

    res.json({ success: true, message: '群組已更新' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/product-analysis-groups/:id/toggle — 切換啟用狀態
router.patch('/:id/toggle', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const group = db.get(`SELECT * FROM product_analysis_groups WHERE id=? AND store_id=?`, [req.params.id, storeId]);
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });
    const newEnabled = group.enabled ? 0 : 1;
    db.run(`UPDATE product_analysis_groups SET enabled=?, updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
      [newEnabled, group.id, storeId]);
    res.json({ success: true, enabled: newEnabled });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/product-analysis-groups/:id — 刪除群組
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const group = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [req.params.id, storeId]);
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });
    db.run(`DELETE FROM product_analysis_group_items WHERE group_id=? AND store_id=?`, [group.id, storeId]);
    db.run(`DELETE FROM product_analysis_groups WHERE id=? AND store_id=?`, [group.id, storeId]);
    res.json({ success: true, message: '群組已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/product-analysis-groups/:id/items — 新增成員到群組
router.post('/:id/items', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const groupId = req.params.id;
    const group = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [groupId, storeId]);
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });

    const { product_name, product_id = 0 } = req.body;
    const pname = (product_name || '').trim();
    if (!pname) return res.status(400).json({ success: false, message: '商品名稱不可空白' });

    // 防止重複
    const existing = db.get(
      `SELECT id FROM product_analysis_group_items WHERE group_id=? AND store_id=? AND product_name=?`,
      [groupId, storeId, pname]
    );
    if (existing) return res.status(409).json({ success: false, message: '此商品已在群組中' });

    db.run(
      `INSERT INTO product_analysis_group_items (store_id, group_id, product_id, product_name) VALUES (?,?,?,?)`,
      [storeId, groupId, product_id, pname]
    );
    res.json({ success: true, message: '成員已新增' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/product-analysis-groups/:id/items/:itemId — 移除成員
router.delete('/:id/items/:itemId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    db.run(`DELETE FROM product_analysis_group_items WHERE id=? AND store_id=?`, [req.params.itemId, storeId]);
    res.json({ success: true, message: '成員已移除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
