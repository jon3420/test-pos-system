// routes/payment-methods.js — SaaS R1 fix2（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/payment-methods
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { mode, active } = req.query;
    let sql = 'SELECT pm.* FROM payment_methods pm WHERE pm.store_id=?';
    const p = [storeId];
    if (active !== undefined) { sql += ' AND pm.is_active=?'; p.push(Number(active)); }
    if (mode === 'dine_in')  sql += ' AND pm.enable_for_dine_in=1';
    if (mode === 'takeout')  sql += ' AND pm.enable_for_takeout=1';
    if (mode === 'delivery') sql += ' AND pm.enable_for_delivery=1';
    sql += ' ORDER BY pm.sort_order ASC, pm.id ASC';
    const methods = db.all(sql, p);

    // ★ fix2：gateway 過濾也加 store_id
    const filtered = methods.filter(m => {
      if (!m.gateway_code) return true;
      const gw = db.get(
        'SELECT is_active FROM payment_gateways WHERE store_id=? AND code=?',
        [storeId, m.gateway_code]
      );
      return gw && gw.is_active;
    });

    res.json({ success: true, data: active !== undefined ? filtered : methods });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/payment-methods/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查詢加 AND store_id=?
    const ex = db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '付款方式不存在' });
    const { name, icon, is_active, sort_order, is_default,
      enable_for_dine_in, enable_for_takeout, enable_for_delivery,
      allow_edit_when_platform_order } = req.body;
    db.run(
      `UPDATE payment_methods SET name=?,icon=?,is_active=?,sort_order=?,is_default=?,
       enable_for_dine_in=?,enable_for_takeout=?,enable_for_delivery=?,
       allow_edit_when_platform_order=?,updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [name ?? ex.name, icon ?? ex.icon,
       is_active !== undefined ? Number(is_active) : ex.is_active,
       sort_order !== undefined ? Number(sort_order) : ex.sort_order,
       is_default !== undefined ? Number(is_default) : ex.is_default,
       enable_for_dine_in  !== undefined ? Number(enable_for_dine_in)  : ex.enable_for_dine_in,
       enable_for_takeout  !== undefined ? Number(enable_for_takeout)  : ex.enable_for_takeout,
       enable_for_delivery !== undefined ? Number(enable_for_delivery) : ex.enable_for_delivery,
       allow_edit_when_platform_order !== undefined ? Number(allow_edit_when_platform_order) : ex.allow_edit_when_platform_order,
       req.params.id, storeId]
    );
    res.json({ success: true, data: db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?', [req.params.id, storeId]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
