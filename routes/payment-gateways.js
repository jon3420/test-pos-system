// routes/payment-gateways.js
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const gateways = db.all('SELECT * FROM payment_gateways ORDER BY id ASC');
    // 遮罩敏感欄位
    const safe = gateways.map(g => ({
      ...g,
      api_key: g.api_key ? '••••' + g.api_key.slice(-4) : '',
      secret_key: g.secret_key ? '••••' + g.secret_key.slice(-4) : '',
    }));
    res.json({ success: true, data: safe });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const ex = db.get('SELECT * FROM payment_gateways WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ success: false, message: '金流不存在' });
    const { is_active, mode, api_key, secret_key, merchant_id, webhook_url, callback_url, extra_config } = req.body;
    db.run(
      `UPDATE payment_gateways SET is_active=?,mode=?,api_key=?,secret_key=?,merchant_id=?,
       webhook_url=?,callback_url=?,extra_config=?,updated_at=datetime('now','localtime') WHERE id=?`,
      [is_active!==undefined?Number(is_active):ex.is_active,
       mode??ex.mode,
       api_key !== undefined ? (api_key.startsWith('••••') ? ex.api_key : api_key) : ex.api_key,
       secret_key !== undefined ? (secret_key.startsWith('••••') ? ex.secret_key : secret_key) : ex.secret_key,
       merchant_id??ex.merchant_id, webhook_url??ex.webhook_url,
       callback_url??ex.callback_url, extra_config??ex.extra_config,
       req.params.id]
    );
    const updated = db.get('SELECT * FROM payment_gateways WHERE id=?', [req.params.id]);

    // 同步：若金流停用，停用相關付款方式
    if (is_active === 0 || is_active === false) {
      db.run(
        "UPDATE payment_methods SET is_active=0,updated_at=datetime('now','localtime') WHERE gateway_code=? AND gateway_code!=''",
        [updated.code]
      );
    }

    res.json({ success: true, data: { ...updated, api_key: updated.api_key ? '••••' + updated.api_key.slice(-4) : '', secret_key: updated.secret_key ? '••••' + updated.secret_key.slice(-4) : '' } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// 測試連線（預留）
router.post('/:id/test', (req, res) => {
  try {
    const db = getDb();
    const gw = db.get('SELECT * FROM payment_gateways WHERE id=?', [req.params.id]);
    if (!gw) return res.status(404).json({ success: false, message: '金流不存在' });
    // 預留：未來串接真實 API 測試
    res.json({ success: true, message: `${gw.name} 連線測試預留（尚未串接）`, gateway: gw.name });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
