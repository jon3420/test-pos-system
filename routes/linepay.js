// routes/linepay.js — LINE Pay v3 串接
// 正式環境：https://api-pay.line.me
// 文件：https://pay.line.me/developers/apis/onlineApis
'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

const LINE_PAY_API = 'https://api-pay.line.me';

// ── 讀 LINE Pay 設定 ─────────────────────────────────────
function getLinePayConfig(db, storeId) {
  const gw = db.get(
    "SELECT * FROM payment_gateways WHERE store_id=? AND code='linepay' AND is_active=1",
    [storeId]
  );
  if (!gw) return null;
  return {
    channelId:     gw.merchant_id || gw.api_key || '',
    channelSecret: gw.secret_key  || '',
    mode:          gw.mode || 'prod',
  };
}

// ── LINE Pay v3 簽章 ─────────────────────────────────────
// 簽章方式：HMAC-SHA256( channelSecret, channelSecret + URI + requestBody + nonce )
function makeLinePayHeaders(channelId, channelSecret, uri, body, nonce) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const message = channelSecret + uri + bodyStr + nonce;
  const signature = crypto
    .createHmac('sha256', channelSecret)
    .update(message, 'utf8')
    .digest('base64');
  return {
    'Content-Type':                  'application/json',
    'X-LINE-ChannelId':              channelId,
    'X-LINE-Authorization-Nonce':    nonce,
    'X-LINE-Authorization':          signature,
  };
}

function makeLinePayGetHeaders(channelId, channelSecret, uri, queryStr, nonce) {
  // GET 請求：message = channelSecret + URI + queryString + nonce
  const message = channelSecret + uri + queryStr + nonce;
  const signature = crypto
    .createHmac('sha256', channelSecret)
    .update(message, 'utf8')
    .digest('base64');
  return {
    'Content-Type':                  'application/json',
    'X-LINE-ChannelId':              channelId,
    'X-LINE-Authorization-Nonce':    nonce,
    'X-LINE-Authorization':          signature,
  };
}

// ── 付款成功後廣播更新 ────────────────────────────────────
function broadcastOrderPaid(app, db, storeId, orderUuid) {
  try {
    const order = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [orderUuid, storeId]);
    if (!order) return;
    const wss = app?.get ? app.get('wss') : null;
    broadcastToStore(wss, storeId, { type: 'order_paid', order });
    broadcastToStore(wss, storeId, { type: 'new_line_order', order }); // 觸發 POS 出單
  } catch(e) { console.error('[linepay] broadcast error:', e.message); }
}

// ══════════════════════════════════════════════════════════
// POST /api/linepay/request — 建立 LINE Pay 付款請求
// ══════════════════════════════════════════════════════════
router.post('/request', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const cfg     = getLinePayConfig(db, storeId);

    if (!cfg) return res.status(400).json({ success: false, message: 'LINE Pay 未設定或未啟用，請至後台付款設定中啟用' });
    if (!cfg.channelId)     return res.status(400).json({ success: false, message: 'LINE Pay Channel ID 未設定' });
    if (!cfg.channelSecret) return res.status(400).json({ success: false, message: 'LINE Pay Channel Secret 未設定' });

    const { order_uuid, order_number, total, items, customer_name, redirect_url, cancel_url } = req.body;
    if (!order_uuid || !total) return res.status(400).json({ success: false, message: '缺少必要欄位（order_uuid, total）' });

    // 確認訂單存在
    const order = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [order_uuid, storeId]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });

    // 組成 LINE Pay payment 品項
    const linePayProducts = (items || []).map(i => ({
      name:     String(i.name || '商品').slice(0, 4000),
      quantity: Number(i.qty || 1),
      price:    Number(i.price || 0),
    }));
    if (!linePayProducts.length) {
      linePayProducts.push({ name: '訂單費用', quantity: 1, price: Number(total) });
    }

    // 取得 base URL（用於 confirmUrl / cancelUrl）
    const baseUrl = redirect_url
      ? redirect_url.replace(/\/[^/]*$/, '')
      : `${req.protocol}://${req.get('host')}`;

    const confirmUrl = redirect_url || `${baseUrl}/linepay-confirm.html?store_id=${storeId}`;
    const cancelUrlFinal  = cancel_url  || `${baseUrl}/line-order.html?store_id=${storeId}&linepay=cancel`;

    const requestBody = {
      amount:   Number(total),
      currency: 'TWD',
      orderId:  order_number || order_uuid,
      packages: [{
        id:       order_number || order_uuid,
        amount:   Number(total),
        name:     String(customer_name || '訂單').slice(0, 100),
        products: linePayProducts,
      }],
      redirectUrls: {
        confirmUrl:  confirmUrl,
        cancelUrl:   cancelUrlFinal,
      },
    };

    const uri   = '/v3/payments/request';
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const headers = makeLinePayHeaders(cfg.channelId, cfg.channelSecret, uri, requestBody, nonce);

    const apiRes = await fetch(LINE_PAY_API + uri, {
      method:  'POST',
      headers,
      body:    JSON.stringify(requestBody),
      timeout: 10000,
    });
    const data = await apiRes.json();

    if (data.returnCode !== '0000') {
      console.error('[linepay/request] error:', data);
      return res.status(400).json({
        success:    false,
        message:    `LINE Pay 建立付款失敗：${data.returnMessage || data.returnCode}`,
        linepay_code: data.returnCode,
      });
    }

    // 更新訂單為 pending_payment
    db.run(
      `UPDATE orders SET payment_status='pending', status='pending',
       order_status='pending', updated_at=datetime('now','localtime')
       WHERE uuid=? AND store_id=?`,
      [order_uuid, storeId]
    );

    // 儲存 transactionId 備用（先存到 note 或獨立欄位）
    const transactionId = data.info?.transactionId;
    if (transactionId) {
      db.run(
        `UPDATE orders SET sync_status=? WHERE uuid=? AND store_id=?`,
        [`linepay_txid:${transactionId}`, order_uuid, storeId]
      );
    }

    res.json({
      success:        true,
      payment_url:    data.info?.paymentUrl?.web,
      payment_url_app: data.info?.paymentUrl?.app,
      transaction_id: transactionId,
      linepay_raw:    data,
    });
  } catch(e) {
    console.error('[linepay/request] exception:', e.message);
    res.status(500).json({ success: false, message: `LINE Pay 請求失敗：${e.message}` });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/linepay/confirm — LINE Pay 付款成功 callback
// ══════════════════════════════════════════════════════════
router.get('/confirm', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.query.store_id || req.storeId || 'store_001';
    const cfg     = getLinePayConfig(db, storeId);

    if (!cfg) {
      return res.redirect(`/line-order.html?store_id=${storeId}&linepay=error&msg=config_missing`);
    }

    const { transactionId, orderId } = req.query;
    if (!transactionId || !orderId) {
      return res.redirect(`/line-order.html?store_id=${storeId}&linepay=error&msg=missing_params`);
    }

    // 找訂單
    const order = db.get(
      "SELECT * FROM orders WHERE store_id=? AND (order_number=? OR uuid=?)",
      [storeId, orderId, orderId]
    );
    if (!order) {
      return res.redirect(`/line-order.html?store_id=${storeId}&linepay=error&msg=order_not_found`);
    }

    // 呼叫 LINE Pay /confirm API
    const amount = Number(order.total || 0);
    const confirmBody = { amount, currency: 'TWD' };
    const uri   = `/v3/payments/${transactionId}/confirm`;
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const headers = makeLinePayHeaders(cfg.channelId, cfg.channelSecret, uri, confirmBody, nonce);

    const apiRes = await fetch(LINE_PAY_API + uri, {
      method:  'POST',
      headers,
      body:    JSON.stringify(confirmBody),
      timeout: 10000,
    });
    const data = await apiRes.json();

    if (data.returnCode !== '0000') {
      console.error('[linepay/confirm] error:', data);
      return res.redirect(
        `/line-order.html?store_id=${storeId}&linepay=fail&order=${orderId}&code=${data.returnCode}`
      );
    }

    // 付款成功：更新訂單
    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET
        payment_status='paid',
        status='accepted',
        order_status='accepted',
        kitchen_status='pending',
        sync_status=?,
        updated_at=?
       WHERE uuid=? AND store_id=?`,
      [
        `linepay_paid:${transactionId}:${data.info?.payInfo?.[0]?.method || ''}`,
        now,
        order.uuid,
        storeId,
      ]
    );

    // 廣播新訂單通知（觸發 POS 出單）
    broadcastOrderPaid(req.app, db, storeId, order.uuid);

    // 導向成功頁
    res.redirect(
      `/line-order.html?store_id=${storeId}&linepay=success&order=${order.order_number}`
    );
  } catch(e) {
    console.error('[linepay/confirm] exception:', e.message);
    const storeId = req.query.store_id || 'store_001';
    res.redirect(`/line-order.html?store_id=${storeId}&linepay=error&msg=${encodeURIComponent(e.message)}`);
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/linepay/cancel — 付款取消 callback
// ══════════════════════════════════════════════════════════
router.get('/cancel', (req, res) => {
  const storeId  = req.query.store_id || req.storeId || 'store_001';
  const orderId  = req.query.orderId || '';
  // 導向前台，帶取消參數
  res.redirect(`/line-order.html?store_id=${storeId}&linepay=cancel&order=${orderId}`);
});

// ══════════════════════════════════════════════════════════
// POST /api/linepay/webhook — LINE Pay webhook/notify
// ══════════════════════════════════════════════════════════
router.post('/webhook', express.json(), (req, res) => {
  // LINE Pay webhook：只記錄，主要付款確認流程在 /confirm
  console.log('[linepay/webhook]', JSON.stringify(req.body).slice(0, 200));
  res.json({ returnCode: '0000', returnMessage: 'OK' });
});

// ══════════════════════════════════════════════════════════
// POST /api/linepay/test — 測試連線（真實驗證 Channel ID/Secret）
// ══════════════════════════════════════════════════════════
router.post('/test', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    // 允許從 request body 直接傳入（後台儲存前的即時測試）
    const channelId     = req.body?.channel_id     || '';
    const channelSecret = req.body?.channel_secret  || '';

    let cfg = { channelId, channelSecret };
    // 若沒有傳入則讀 DB
    if (!channelId || !channelSecret) {
      const dbCfg = getLinePayConfig(db, storeId);
      if (!dbCfg) return res.status(400).json({ success: false, message: 'LINE Pay 未設定，請先儲存 Channel ID 與 Secret' });
      cfg = dbCfg;
    }

    if (!cfg.channelId)     return res.status(400).json({ success: false, message: 'Channel ID 未填寫' });
    if (!cfg.channelSecret) return res.status(400).json({ success: false, message: 'Channel Secret 未填寫' });
    if (cfg.channelId.length < 4)     return res.status(400).json({ success: false, message: 'Channel ID 格式似乎不正確（過短）' });
    if (cfg.channelSecret.length < 8) return res.status(400).json({ success: false, message: 'Channel Secret 格式似乎不正確（過短）' });

    // 嘗試呼叫 LINE Pay 查詢 API（/v3/payments/profile 不需付款，只需簽章驗證）
    // 使用 /v3/payments 的一個查詢端點做簽章測試
    // LINE Pay v3 沒有公開的 ping API，改用建立並立刻驗證簽章的方式
    const nonce     = uuidv4().replace(/-/g, '').slice(0, 32);
    const testUri   = '/v3/payments';
    const testQuery = `orderId=TEST_${Date.now()}`;
    const message   = cfg.channelSecret + testUri + testQuery + nonce;
    const testSig   = crypto
      .createHmac('sha256', cfg.channelSecret)
      .update(message, 'utf8')
      .digest('base64');

    // 做一個真實請求驗證 Channel ID 是否被 LINE Pay 認識
    // GET /v3/payments（查詢不存在的訂單，正常應回 1104 / order not found，代表認證通過）
    const testHeaders = makeLinePayGetHeaders(cfg.channelId, cfg.channelSecret, testUri, testQuery, nonce);
    let linePayStatus = null;
    let linePayCode   = null;
    try {
      const testRes = await fetch(`${LINE_PAY_API}${testUri}?${testQuery}`, {
        method:  'GET',
        headers: testHeaders,
        timeout: 8000,
      });
      const testData = await testRes.json();
      linePayStatus = testRes.status;
      linePayCode   = testData.returnCode;
      // returnCode '1104' = ORDER_NOT_FOUND（代表簽章正確、Channel 認證通過）
      // returnCode '1190' = INVALID_CHANNEL_SECRET（Channel Secret 錯誤）
      // returnCode '9000' = INTERNAL_ERROR（可能 Channel ID 不存在）
      if (linePayCode === '1104' || linePayCode === '0000') {
        return res.json({
          success: true,
          message: '✅ LINE Pay 設定有效，Channel ID 與 Secret 驗證通過',
          channel_id:   cfg.channelId,
          return_code:  linePayCode,
        });
      } else if (linePayCode === '1190') {
        return res.status(400).json({
          success: false,
          message: '❌ Channel Secret 不正確，請重新確認',
          return_code: linePayCode,
        });
      } else {
        return res.status(400).json({
          success: false,
          message: `❌ LINE Pay 驗證失敗（${linePayCode}）：請確認 Channel ID 是否正確`,
          return_code: linePayCode,
        });
      }
    } catch(netErr) {
      // 網路超時或無法連線
      return res.status(503).json({
        success: false,
        message: `無法連線至 LINE Pay API：${netErr.message}`,
      });
    }
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
