// routes/payment-gateways.js — SaaS R1 fix16d
// 改用 provider code（:provider）代替 :id，前後端一致
// 所有查詢均帶 store_id 隔離
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

const PROVIDERS = ['linepay','ecpay','newebpay','jkopay','pxpay','applepay','googlepay','creditcard_terminal'];
const PROVIDER_NAMES = {
  linepay:'LINE Pay', ecpay:'綠界 ECPay', newebpay:'藍新 NewebPay',
  jkopay:'街口支付', pxpay:'全支付', applepay:'Apple Pay',
  googlepay:'Google Pay', creditcard_terminal:'信用卡刷卡機'
};

function safe(g) {
  if (!g) return null;
  return {
    ...g,
    api_key:    g.api_key    ? '••••' + String(g.api_key).slice(-4)    : '',
    secret_key: g.secret_key ? '••••' + String(g.secret_key).slice(-4) : '',
  };
}

// GET /api/payment-gateways — 所有 providers
router.get('/', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const rows    = db.all('SELECT * FROM payment_gateways WHERE store_id=? ORDER BY id ASC', [storeId]);
    res.json({ success: true, data: rows.map(safe) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/payment-gateways/:provider — 單一 provider
router.get('/:provider', (req, res) => {
  try {
    const db       = getDb();
    const storeId  = req.storeId || 'store_001';
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider))
      return res.status(400).json({ success: false, message: '不支援的 provider: ' + provider });
    const gw = db.get('SELECT * FROM payment_gateways WHERE store_id=? AND code=?', [storeId, provider]);
    if (!gw) return res.status(404).json({ success: false, message: 'provider 不存在，請重新初始化' });
    res.json({ success: true, data: safe(gw) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/payment-gateways/:provider — 更新（upsert）
router.put('/:provider', (req, res) => {
  try {
    const db       = getDb();
    const storeId  = req.storeId || 'store_001';
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider))
      return res.status(400).json({ success: false, message: '不支援的 provider: ' + provider });

    const { is_active, mode, api_key, secret_key, merchant_id, webhook_url, callback_url, extra_config } = req.body;
    const ex = db.get('SELECT * FROM payment_gateways WHERE store_id=? AND code=?', [storeId, provider]);

    if (ex) {
      // UPDATE 既有記錄
      db.run(
        `UPDATE payment_gateways SET
          is_active=?, mode=?, api_key=?, secret_key=?, merchant_id=?,
          webhook_url=?, callback_url=?, extra_config=?,
          updated_at=datetime('now','localtime')
         WHERE store_id=? AND code=?`,
        [
          is_active !== undefined ? Number(is_active) : ex.is_active,
          mode ?? ex.mode,
          api_key    !== undefined ? (String(api_key).startsWith('••••')    ? ex.api_key    : api_key)    : ex.api_key,
          secret_key !== undefined ? (String(secret_key).startsWith('••••') ? ex.secret_key : secret_key) : ex.secret_key,
          merchant_id  !== undefined ? merchant_id  : ex.merchant_id,
          webhook_url  !== undefined ? webhook_url  : ex.webhook_url,
          callback_url !== undefined ? callback_url : ex.callback_url,
          extra_config !== undefined ? extra_config : ex.extra_config,
          storeId, provider
        ]
      );
    } else {
      // INSERT 新記錄（provider 不存在時自動建立）
      db.run(
        `INSERT INTO payment_gateways (store_id, name, code, is_active, mode, api_key, secret_key, merchant_id, webhook_url, callback_url, extra_config)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          storeId, PROVIDER_NAMES[provider] || provider, provider,
          is_active !== undefined ? Number(is_active) : 0,
          mode || 'test',
          api_key || '', secret_key || '', merchant_id || '',
          webhook_url || '', callback_url || '', extra_config || '{}'
        ]
      );
    }

    const updated = db.get('SELECT * FROM payment_gateways WHERE store_id=? AND code=?', [storeId, provider]);

    // 金流停用時同步停用對應付款方式
    if ((is_active === 0 || is_active === false) && ex?.is_active) {
      try {
        db.run(
          "UPDATE payment_methods SET is_active=0,updated_at=datetime('now','localtime') WHERE store_id=? AND gateway_code=?",
          [storeId, provider]
        );
      } catch {}
    }

    res.json({ success: true, data: safe(updated) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/payment-gateways/:provider/test — 測試連線
router.post('/:provider/test', (req, res) => {
  try {
    const db       = getDb();
    const storeId  = req.storeId || 'store_001';
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider))
      return res.status(400).json({ success: false, message: '不支援的 provider: ' + provider });
    const gw = db.get('SELECT * FROM payment_gateways WHERE store_id=? AND code=?', [storeId, provider]);
    if (!gw) return res.status(404).json({ success: false, message: 'provider 尚未設定' });
    // 實際串接預留——目前回傳成功訊息
    res.json({
      success: true,
      message: `${PROVIDER_NAMES[provider] || provider} 連線測試預留（尚未串接 SDK）`,
      provider,
      mode: gw.mode,
      is_active: !!gw.is_active,
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
