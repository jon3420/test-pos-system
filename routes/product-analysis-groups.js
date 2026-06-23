// routes/product-analysis-groups.js — fix18-09F-hotfix4
// 商品分析群組 CRUD API（含歷史品名別名）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 共用：取得群組完整資料（含 items + aliases）─────────────
function fetchGroupFull(db, storeId, groupId) {
  const group = db.get(
    `SELECT * FROM product_analysis_groups WHERE id=? AND store_id=?`,
    [groupId, storeId]
  );
  if (!group) return null;
  const items = db.all(
    `SELECT * FROM product_analysis_group_items WHERE group_id=? AND store_id=? ORDER BY id`,
    [groupId, storeId]
  );
  const aliases = db.all(
    `SELECT * FROM product_analysis_group_aliases WHERE group_id=? AND store_id=? ORDER BY id`,
    [groupId, storeId]
  );
  return { ...group, items, aliases };
}

// GET /api/product-analysis-groups — 取得所有群組（含 items + aliases）
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
    // Safe query for aliases (table may not exist on first run before restart)
    let aliases = [];
    try {
      aliases = db.all(
        `SELECT * FROM product_analysis_group_aliases WHERE store_id=? ORDER BY id`,
        [storeId]
      );
    } catch(e) { aliases = []; }

    const result = groups.map(g => ({
      ...g,
      items:   items.filter(i => Number(i.group_id) === Number(g.id)),
      aliases: aliases.filter(a => Number(a.group_id) === Number(g.id))
    }));
    res.json({ success: true, data: result });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/product-analysis-groups/:id — 取得單一群組（含 items + aliases）
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const full = fetchGroupFull(db, storeId, req.params.id);
    if (!full) return res.status(404).json({ success: false, message: '群組不存在' });
    res.json({ success: true, data: full });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 共用：寫入 items（現有商品）────────────────────────────
function insertItems(db, storeId, groupId, items) {
  (items || []).forEach(item => {
    const pname = (item.product_name || item.name || '').trim();
    if (!pname) return;
    db.run(
      `INSERT INTO product_analysis_group_items (store_id, group_id, product_id, product_name) VALUES (?,?,?,?)`,
      [storeId, groupId, item.product_id || 0, pname]
    );
  });
}

// ── 共用：寫入 aliases（歷史品名別名）──────────────────────
function insertAliases(db, storeId, groupId, aliases) {
  (aliases || []).forEach(a => {
    const name = (typeof a === 'string' ? a : (a.alias_name || '')).trim();
    if (!name) return;
    db.run(
      `INSERT INTO product_analysis_group_aliases (store_id, group_id, alias_name) VALUES (?,?,?)`,
      [storeId, groupId, name]
    );
  });
}

// POST /api/product-analysis-groups — 新增群組
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { group_name, description = '', enabled = 1, sort_order = 0, items = [], aliases = [] } = req.body;
    if (!group_name || !group_name.trim()) return res.status(400).json({ success: false, message: '群組名稱不可空白' });

    const r = db.run(
      `INSERT INTO product_analysis_groups (store_id, group_name, description, enabled, sort_order) VALUES (?,?,?,?,?)`,
      [storeId, group_name.trim(), description, enabled ? 1 : 0, sort_order]
    );
    const groupId = r.lastInsertRowid;
    insertItems(db, storeId, groupId, items);
    insertAliases(db, storeId, groupId, aliases);

    res.json({ success: true, message: '群組已建立', id: groupId });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/product-analysis-groups/:id — 更新群組（含 items + aliases 重建）
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const id = req.params.id;
    const { group_name, description, enabled, sort_order, items, aliases } = req.body;

    const existing = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '群組不存在' });

    if (group_name !== undefined) {
      db.run(
        `UPDATE product_analysis_groups SET group_name=?, description=?, enabled=?, sort_order=?, updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
        [group_name.trim(), description ?? '', enabled != null ? (enabled ? 1 : 0) : 1, sort_order ?? 0, id, storeId]
      );
    }

    // 重建 items
    if (Array.isArray(items)) {
      db.run(`DELETE FROM product_analysis_group_items WHERE group_id=? AND store_id=?`, [id, storeId]);
      insertItems(db, storeId, id, items);
    }

    // 重建 aliases
    if (Array.isArray(aliases)) {
      try {
        db.run(`DELETE FROM product_analysis_group_aliases WHERE group_id=? AND store_id=?`, [id, storeId]);
        insertAliases(db, storeId, id, aliases);
      } catch(e) { console.warn('[AG] aliases write:', e.message); }
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

// DELETE /api/product-analysis-groups/:id — 刪除群組（含 aliases）
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const group = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [req.params.id, storeId]);
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });
    db.run(`DELETE FROM product_analysis_group_items WHERE group_id=? AND store_id=?`, [group.id, storeId]);
    try { db.run(`DELETE FROM product_analysis_group_aliases WHERE group_id=? AND store_id=?`, [group.id, storeId]); } catch(e) {}
    db.run(`DELETE FROM product_analysis_groups WHERE id=? AND store_id=?`, [group.id, storeId]);
    res.json({ success: true, message: '群組已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/product-analysis-groups/:id/items — 新增單一成員
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

    const dup = db.get(
      `SELECT id FROM product_analysis_group_items WHERE group_id=? AND store_id=? AND product_name=?`,
      [groupId, storeId, pname]
    );
    if (dup) return res.status(409).json({ success: false, message: '此商品已在群組中' });

    db.run(
      `INSERT INTO product_analysis_group_items (store_id, group_id, product_id, product_name) VALUES (?,?,?,?)`,
      [storeId, groupId, product_id, pname]
    );
    res.json({ success: true, message: '成員已新增' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/product-analysis-groups/:id/items/:itemId — 移除單一成員
router.delete('/:id/items/:itemId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    db.run(`DELETE FROM product_analysis_group_items WHERE id=? AND store_id=?`, [req.params.itemId, storeId]);
    res.json({ success: true, message: '成員已移除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/product-analysis-groups/:id/aliases — 新增單一別名
router.post('/:id/aliases', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const groupId = req.params.id;
    const group = db.get(`SELECT id FROM product_analysis_groups WHERE id=? AND store_id=?`, [groupId, storeId]);
    if (!group) return res.status(404).json({ success: false, message: '群組不存在' });

    const { alias_name } = req.body;
    const aname = (alias_name || '').trim();
    if (!aname) return res.status(400).json({ success: false, message: '別名不可空白' });

    const dup = db.get(
      `SELECT id FROM product_analysis_group_aliases WHERE group_id=? AND store_id=? AND alias_name=?`,
      [groupId, storeId, aname]
    );
    if (dup) return res.status(409).json({ success: false, message: '此別名已存在' });

    db.run(
      `INSERT INTO product_analysis_group_aliases (store_id, group_id, alias_name) VALUES (?,?,?)`,
      [storeId, groupId, aname]
    );
    res.json({ success: true, message: '別名已新增' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/product-analysis-groups/:id/aliases/:aliasId — 移除單一別名
router.delete('/:id/aliases/:aliasId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    db.run(`DELETE FROM product_analysis_group_aliases WHERE id=? AND store_id=?`, [req.params.aliasId, storeId]);
    res.json({ success: true, message: '別名已移除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
