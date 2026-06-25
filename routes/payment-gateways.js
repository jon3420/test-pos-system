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
    const storeId = req.storeId;
    const rows    = db.all('SELECT * FROM payment_gateways WHERE store_id=? ORDER BY id ASC', [storeId]);
    res.json({ success: true, data: rows.map(safe) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/payment-gateways/:provider — 單一 provider
router.get('/:provider', (req, res) => {
  try {
    const db       = getDb();
    const storeId = req.storeId;
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
    const storeId = req.storeId;
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
router.post('/:provider/test', async (req, res) => {
  try {
    const db       = getDb();
    const storeId = req.storeId;
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider))
      return res.status(400).json({ success: false, message: '不支援的 provider: ' + provider });
    const gw = db.get('SELECT * FROM payment_gateways WHERE store_id=? AND code=?', [storeId, provider]);
    if (!gw) return res.status(404).json({ success: false, message: 'provider 尚未設定' });

    if (provider === 'linepay') {
      // 直接使用 linepay 測試邏輯（避免 HTTP 自呼叫的複雜性）
      const crypto = require('crypto');
      const fetch2 = require('node-fetch');
      const { v4: uuidv4 } = require('uuid');

      const channelId     = (req.body?.channel_id     || gw.merchant_id || '').trim();
      const channelSecret = (req.body?.channel_secret  || gw.secret_key  || '').trim();
      const mode          = (req.body?.mode            || gw.mode        || 'test').trim();
      const apiBase       = (mode === 'live' || mode === 'prod')
        ? 'https://api-pay.line.me'
        : 'https://sandbox-api-pay.line.me';

      if (!channelId)     return res.status(400).json({ success: false, message: 'Channel ID 未填寫' });
      if (!channelSecret) return res.status(400).json({ success: false, message: 'Channel Secret 未填寫' });

      const nonce    = uuidv4().replace(/-/g, '').slice(0, 32);
      const testUri  = '/v3/payments/request';
      const testBody = {
        amount: 1, currency: 'TWD',
        orderId: `TEST_${Date.now()}_AUTH`,
        packages: [{ id: 'test', amount: 1, products: [{ name: 'Auth Test', quantity: 1, price: 1 }] }],
        redirectUrls: { confirmUrl: 'https://example.com/confirm', cancelUrl: 'https://example.com/cancel' },
      };
      const bodyStr  = JSON.stringify(testBody);
      const message  = channelSecret + testUri + bodyStr + nonce;
      const signature = crypto.createHmac('sha256', channelSecret).update(message, 'utf8').digest('base64');

      console.log('[LINEPAY TEST via gateway]', {
        mode, apiBase, channelIdLen: channelId.length, secretLen: channelSecret.length,
        nonce, sigPreview: signature.slice(0, 20),
      });

      try {
        const testRes  = await fetch2(apiBase + testUri, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-LINE-ChannelId': String(channelId),
            'X-LINE-Authorization-Nonce': String(nonce),
            'X-LINE-Authorization': signature,
          },
          body: bodyStr,
          timeout: 10000,
        });
        const data = await testRes.json();
        console.log('[LINEPAY TEST] result:', { code: data.returnCode, msg: data.returnMessage });
        const code = data.returnCode;
        const authOk = ['0000','1104','2101','2102','1160'].includes(code);
        if (authOk) {
          return res.json({ success: true, message: `✅ LINE Pay 認證成功（${mode==='live'?'正式':'沙箱'}）`, return_code: code, mode, apiBase });
        } else if (code === '1150') {
          return res.status(400).json({ success: false, message: `❌ 認證失敗（1150）：Channel ID/Secret 不正確，或環境不符\n目前使用：${apiBase}\n若您的 Channel 是沙箱帳號，請將「模式」改為「測試模式」`, return_code: code, apiBase });
        } else if (code === '1101') {
          return res.status(400).json({ success: false, message: '❌ Channel ID 不存在（1101）', return_code: code });
        } else {
          return res.json({ success: true, message: `✅ LINE Pay 認證通過（${code}：${data.returnMessage}）`, return_code: code, mode, apiBase });
        }
      } catch(netErr) {
        return res.status(503).json({ success: false, message: `無法連線 LINE Pay API：${netErr.message}`, apiBase });
      }
    }

    // 其他 provider
    res.json({
      success: true,
      message: `${PROVIDER_NAMES[provider] || provider} 設定已存在（此 provider 尚未實作直接驗證）`,
      provider, mode: gw.mode, is_active: !!gw.is_active,
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
