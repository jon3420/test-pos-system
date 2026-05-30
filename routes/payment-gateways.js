// routes/payment-gateways.js — SaaS R1 fix2（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

// GET /api/payment-gateways
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：加 WHERE store_id=?
    const gateways = db.all('SELECT * FROM payment_gateways WHERE store_id=? ORDER BY id ASC', [storeId]);
    const safe = gateways.map(g => ({
      ...g,
      api_key:    g.api_key    ? '••••' + g.api_key.slice(-4)    : '',
      secret_key: g.secret_key ? '••••' + g.secret_key.slice(-4) : '',
    }));
    res.json({ success: true, data: safe });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/payment-gateways/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查詢加 AND store_id=?
    const ex = db.get('SELECT * FROM payment_gateways WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '金流不存在' });
    const { is_active, mode, api_key, secret_key, merchant_id, webhook_url, callback_url, extra_config } = req.body;
    db.run(
      `UPDATE payment_gateways SET is_active=?,mode=?,api_key=?,secret_key=?,merchant_id=?,
       webhook_url=?,callback_url=?,extra_config=?,updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [
        is_active !== undefined ? Number(is_active) : ex.is_active,
        mode ?? ex.mode,
        api_key    !== undefined ? (api_key.startsWith('••••')    ? ex.api_key    : api_key)    : ex.api_key,
        secret_key !== undefined ? (secret_key.startsWith('••••') ? ex.secret_key : secret_key) : ex.secret_key,
        merchant_id ?? ex.merchant_id, webhook_url ?? ex.webhook_url,
        callback_url ?? ex.callback_url, extra_config ?? ex.extra_config,
        req.params.id, storeId
      ]
    );
    const updated = db.get('SELECT * FROM payment_gateways WHERE id=? AND store_id=?', [req.params.id, storeId]);

    // 同步停用相關付款方式（限本店）
    if (is_active === 0 || is_active === false) {
      db.run(
        "UPDATE payment_methods SET is_active=0,updated_at=datetime('now','localtime') WHERE store_id=? AND gateway_code=? AND gateway_code!=''",
        [storeId, updated.code]
      );
    }

    res.json({ success: true, data: {
      ...updated,
      api_key:    updated.api_key    ? '••••' + updated.api_key.slice(-4)    : '',
      secret_key: updated.secret_key ? '••••' + updated.secret_key.slice(-4) : '',
    }});
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/payment-gateways/:id/test
router.post('/:id/test', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    // ★ fix2：查詢加 AND store_id=?
    const gw = db.get('SELECT * FROM payment_gateways WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!gw) return res.status(404).json({ success: false, message: '金流不存在' });
    res.json({ success: true, message: `${gw.name} 連線測試預留（尚未串接）`, gateway: gw.name });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
