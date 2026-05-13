// routes/payment-methods.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/payment-methods?mode=dine_in|takeout|delivery
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { mode, active } = req.query;
    let sql = 'SELECT pm.* FROM payment_methods pm WHERE 1=1';
    const p = [];
    if (active !== undefined) { sql += ' AND pm.is_active=?'; p.push(Number(active)); }
    if (mode === 'dine_in')  { sql += ' AND pm.enable_for_dine_in=1'; }
    if (mode === 'takeout')  { sql += ' AND pm.enable_for_takeout=1'; }
    if (mode === 'delivery') { sql += ' AND pm.enable_for_delivery=1'; }
    sql += ' ORDER BY pm.sort_order ASC, pm.id ASC';
    const methods = db.all(sql, p);

    // 過濾掉 gateway 未啟用的方式
    const filtered = methods.filter(m => {
      if (!m.gateway_code) return true; // 無需 gateway
      const gw = db.get('SELECT is_active FROM payment_gateways WHERE code=?', [m.gateway_code]);
      return gw && gw.is_active;
    });

    res.json({ success: true, data: active !== undefined ? filtered : methods });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const ex = db.get('SELECT * FROM payment_methods WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ success: false, message: '付款方式不存在' });
    const { name, icon, is_active, sort_order, is_default,
      enable_for_dine_in, enable_for_takeout, enable_for_delivery,
      allow_edit_when_platform_order } = req.body;
    db.run(
      `UPDATE payment_methods SET name=?,icon=?,is_active=?,sort_order=?,is_default=?,
       enable_for_dine_in=?,enable_for_takeout=?,enable_for_delivery=?,
       allow_edit_when_platform_order=?,updated_at=datetime('now','localtime') WHERE id=?`,
      [name??ex.name, icon??ex.icon,
       is_active!==undefined?Number(is_active):ex.is_active,
       sort_order!==undefined?Number(sort_order):ex.sort_order,
       is_default!==undefined?Number(is_default):ex.is_default,
       enable_for_dine_in!==undefined?Number(enable_for_dine_in):ex.enable_for_dine_in,
       enable_for_takeout!==undefined?Number(enable_for_takeout):ex.enable_for_takeout,
       enable_for_delivery!==undefined?Number(enable_for_delivery):ex.enable_for_delivery,
       allow_edit_when_platform_order!==undefined?Number(allow_edit_when_platform_order):ex.allow_edit_when_platform_order,
       req.params.id]
    );
    res.json({ success: true, data: db.get('SELECT * FROM payment_methods WHERE id=?', [req.params.id]) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
