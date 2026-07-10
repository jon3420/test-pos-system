// routes/linepay.js — LINE Pay v3 串接（完整除錯版）
// 正式環境：https://api-pay.line.me
// 沙箱環境：https://sandbox-api-pay.line.me
// 文件：https://pay.line.me/developers/apis/onlineApis
'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { getDb }      = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

// ── API endpoint（依 mode 決定）──────────────────────────
function getApiBase(mode) {
  // mode='test' → sandbox；mode='live'/'prod' → 正式
  return (mode === 'live' || mode === 'prod')
    ? 'https://api-pay.line.me'
    : 'https://sandbox-api-pay.line.me';
}

// ── 讀 LINE Pay 設定（不過濾 is_active，測試時也能讀）────
function getLinePayConfig(db, storeId, requireActive = true) {
  const sql = requireActive
    ? "SELECT * FROM payment_gateways WHERE store_id=? AND code='linepay' AND is_active=1"
    : "SELECT * FROM payment_gateways WHERE store_id=? AND code='linepay'";
  const gw = db.get(sql, [storeId]);
  if (!gw) return null;
  return {
    channelId:     (gw.merchant_id || '').trim(),  // Channel ID 存在 merchant_id
    channelSecret: (gw.secret_key  || '').trim(),  // Channel Secret 存在 secret_key
    mode:          gw.mode || 'test',
    apiBase:       getApiBase(gw.mode || 'test'),
    webhookUrl:    gw.webhook_url  || '',
    callbackUrl:   gw.callback_url || '',
  };
}

// ══════════════════════════════════════════════════════════
// LINE Pay v3 簽章函數（精確對應官方文件）
// POST: message = channelSecret + uri + requestBodyString + nonce
// GET:  message = channelSecret + uri + queryString + nonce
// ══════════════════════════════════════════════════════════
function signLinePayPost(channelSecret, uri, bodyObj, nonce) {
  // 必須用 JSON.stringify 且確保無 BOM / 無多餘空白
  const bodyStr  = JSON.stringify(bodyObj);
  const message  = channelSecret + uri + bodyStr + nonce;
  const signature = crypto
    .createHmac('sha256', channelSecret)
    .update(message, 'utf8')
    .digest('base64');
  return { bodyStr, message, signature };
}

function signLinePayGet(channelSecret, uri, queryStr, nonce) {
  const message  = channelSecret + uri + queryStr + nonce;
  const signature = crypto
    .createHmac('sha256', channelSecret)
    .update(message, 'utf8')
    .digest('base64');
  return { message, signature };
}

function makePostHeaders(channelId, signature, nonce) {
  return {
    'Content-Type':               'application/json',
    'X-LINE-ChannelId':           String(channelId),
    'X-LINE-Authorization-Nonce': String(nonce),
    'X-LINE-Authorization':       signature,
  };
}

function makeGetHeaders(channelId, signature, nonce) {
  return {
    'Content-Type':               'application/json',
    'X-LINE-ChannelId':           String(channelId),
    'X-LINE-Authorization-Nonce': String(nonce),
    'X-LINE-Authorization':       signature,
  };
}

// ── 廣播付款成功 ──────────────────────────────────────────
function broadcastOrderPaid(wss, db, storeId, orderUuid) {
  try {
    const order = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [orderUuid, storeId]);
    if (!order) return;
    broadcastToStore(wss, storeId, { type: 'order_paid', order });
    broadcastToStore(wss, storeId, { type: 'new_line_order', order });
  } catch(e) { console.error('[linepay] broadcast error:', e.message); }
}

// ══════════════════════════════════════════════════════════
// POST /api/linepay/test — 完整 debug 測試連線
// ══════════════════════════════════════════════════════════
router.post('/test', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    // 允許從 body 傳入（儲存前即時測試），否則讀 DB（不需 is_active）
    let channelId     = (req.body?.channel_id     || '').trim();
    let channelSecret = (req.body?.channel_secret  || '').trim();
    let mode          = (req.body?.mode            || '').trim();

    if (!channelId || !channelSecret) {
      const cfg = getLinePayConfig(db, storeId, false); // false = 不需 is_active
      if (!cfg) {
        return res.status(400).json({
          success: false,
          message: 'LINE Pay 未設定，請先填寫 Channel ID 與 Channel Secret 並儲存'
        });
      }
      if (!channelId)     channelId     = cfg.channelId;
      if (!channelSecret) channelSecret = cfg.channelSecret;
      if (!mode)          mode          = cfg.mode;
    }
    if (!mode) mode = 'test';

    // 防呆
    if (!channelId) {
      return res.status(400).json({ success: false, message: 'Channel ID 未填寫（對應後台「Merchant ID / Channel ID」欄位）' });
    }
    if (!channelSecret) {
      return res.status(400).json({ success: false, message: 'Channel Secret 未填寫（對應後台「Secret Key」欄位）' });
    }

    const apiBase = getApiBase(mode);

    // 使用 POST /v3/payments/request 帶最小 body 做簽章驗證
    // 這是最可靠的測試方式 — 若 Channel 認證失敗會回傳 1150/1101
    // 若認證通過但 body 有問題會回傳其他 code（1150 代表 auth 失敗，不是 body 問題）
    const nonce     = uuidv4().replace(/-/g, '').slice(0, 32);
    const testUri   = '/v3/payments/request';
    const testBody  = {
      amount:   1,
      currency: 'TWD',
      orderId:  `TEST_${Date.now()}_AUTHCHECK`,
      packages: [{
        id:     'test_pkg',
        amount: 1,
        products: [{ name: 'Auth Check', quantity: 1, price: 1 }],
      }],
      redirectUrls: {
        confirmUrl: 'https://example.com/confirm',
        cancelUrl:  'https://example.com/cancel',
      },
    };

    const { bodyStr, message, signature } = signLinePayPost(channelSecret, testUri, testBody, nonce);

    // === Debug Log ===
    console.log('[LINEPAY TEST]', {
      mode,
      apiBase,
      channelId,
      channelIdLen: channelId.length,
      channelSecretLen: channelSecret.length,
      uri: testUri,
      nonce,
      nonceLen: nonce.length,
      messagePreview: message.slice(0, 60) + '...',
      signature: signature.slice(0, 20) + '...',
      bodyPreview: bodyStr.slice(0, 80) + '...',
    });

    let linePayData = null;
    let linePayStatus = null;
    try {
      const testRes = await fetch(apiBase + testUri, {
        method:  'POST',
        headers: makePostHeaders(channelId, signature, nonce),
        body:    bodyStr,
        timeout: 10000,
      });
      linePayStatus = testRes.status;
      linePayData   = await testRes.json();

      console.log('[LINEPAY TEST] LINE Pay 回傳:', {
        httpStatus: linePayStatus,
        returnCode: linePayData.returnCode,
        returnMessage: linePayData.returnMessage,
        full: JSON.stringify(linePayData).slice(0, 300),
      });
    } catch(netErr) {
      console.error('[LINEPAY TEST] 網路錯誤:', netErr.message);
      return res.status(503).json({
        success: false,
        message: `無法連線至 LINE Pay API（${apiBase}）：${netErr.message}`,
        debug: { apiBase, mode },
      });
    }

    const code = linePayData?.returnCode;
    const msg  = linePayData?.returnMessage || '';

    // returnCode 判斷
    // 0000 = 成功（幾乎不可能，因為 orderId 是 test 格式）
    // 1104 = ORDER_NOT_FOUND（認證通過，只是訂單不存在）→ 成功
    // 2101/2102 = 參數問題（認證通過）→ 成功
    // 1150 = Authentication Failed → Channel ID/Secret 錯誤 或 mode 錯誤
    // 1101 = MERCHANT_NOT_FOUND → Channel ID 不存在
    // 1102 = MERCHANT_STATUS_NOT_USABLE → 商家狀態不可用
    const authOk = ['0000','1104','2101','2102','1160'].includes(code);
    const authFail = ['1150','1101','1102','1190'].includes(code);

    if (authOk) {
      return res.json({
        success: true,
        message: `✅ LINE Pay 認證成功（${mode === 'live' ? '正式' : '沙箱'}環境），Channel ID 與 Secret 有效`,
        channel_id:  channelId,
        mode,
        return_code: code,
        return_msg:  msg,
      });
    } else if (code === '1150') {
      return res.status(400).json({
        success: false,
        message: `❌ 認證失敗（1150）：Channel ID 或 Channel Secret 不正確，或環境不符\n
目前使用：${mode === 'live' ? '正式環境' : '沙箱環境'}（${apiBase}）\n
若您的 Channel 是沙箱帳號，請在後台將「模式」改為「測試模式」`,
        return_code: code,
        mode,
        apiBase,
        debug_channelId_len: channelId.length,
        debug_secret_len: channelSecret.length,
      });
    } else if (code === '1101') {
      return res.status(400).json({
        success: false,
        message: '❌ Channel ID 不存在（1101），請確認 Merchant ID / Channel ID 是否正確',
        return_code: code,
      });
    } else if (code === '1190') {
      return res.status(400).json({
        success: false,
        message: '❌ Channel Secret 不正確（1190），請重新確認 Secret Key',
        return_code: code,
      });
    } else {
      // 其他 code（非認證失敗）→ 認證通過但其他問題
      return res.json({
        success: true,
        message: `✅ LINE Pay 認證通過（回傳 ${code}：${msg}），Channel 設定有效`,
        channel_id:  channelId,
        mode,
        return_code: code,
        return_msg:  msg,
      });
    }
  } catch(e) {
    console.error('[LINEPAY TEST] exception:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// POST /api/linepay/request — 建立 LINE Pay 付款請求
// ══════════════════════════════════════════════════════════
router.post('/request', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    const cfg     = getLinePayConfig(db, storeId);

    if (!cfg) return res.status(400).json({ success: false, message: 'LINE Pay 未設定或未啟用' });
    if (!cfg.channelId)     return res.status(400).json({ success: false, message: 'LINE Pay Channel ID 未設定（Merchant ID 欄位）' });
    if (!cfg.channelSecret) return res.status(400).json({ success: false, message: 'LINE Pay Channel Secret 未設定（Secret Key 欄位）' });

    const { order_uuid, order_number, total, items, customer_name, redirect_url, cancel_url } = req.body;
    if (!order_uuid || !total) return res.status(400).json({ success: false, message: '缺少必要欄位（order_uuid, total）' });

    const order = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [order_uuid, storeId]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });

    // fix18-06: LINE Pay amount 使用 DB order.total（含外送費、折扣後的最終金額）
    // 不信任前端傳來的 total。
    const finalTotal  = Number(order.total || 0);
    const discountAmt = Number(order.discount_amount || 0);
    const couponCode  = order.coupon_code ? String(order.coupon_code) : '';
    const delivFee    = Number(order.delivery_fee || 0);
    let linePayProducts;
    if (discountAmt > 0) {
      // 有折扣：方案 C — 單一總品項（避免 2101 Parameter error）
      const productName = couponCode
        ? '訂單費用（已套用優惠券 ' + couponCode + '）'
        : '訂單費用（含優惠折扣）';
      linePayProducts = [{ name: productName.slice(0, 4000), quantity: 1, price: finalTotal }];
    } else {
      // 無折扣：商品明細 + 外送費（若有）
      linePayProducts = (items || []).map(i => ({
        name:     String(i.name || '商品').slice(0, 4000),
        quantity: Number(i.qty || 1),
        price:    Number(i.price || 0),
      }));
      if (!linePayProducts.length) {
        linePayProducts.push({ name: '訂單費用', quantity: 1, price: finalTotal });
      }
      // fix18-06：外送費加一筆（若有）
      if (delivFee > 0) {
        linePayProducts.push({ name: '外送費', quantity: 1, price: delivFee });
      }
    }

    const host = `${req.protocol}://${req.get('host')}`;
    const confirmUrl   = redirect_url || `${host}/api/linepay/confirm?store_id=${storeId}`;
    const cancelUrlFinal = cancel_url || `${host}/line-order.html?store_id=${storeId}&linepay=cancel`;

    const lpAmount        = Number(total);
    const lpPackageAmount = Number(total);
    const lpProductsTotal = linePayProducts.reduce((s, p) => s + Number(p.quantity) * Number(p.price), 0);

    // ── fix18-06: 送出前三值一致性驗證 ───────────────────
    console.log(
      `[LINEPAY] amount=${lpAmount}` +
      ` packageAmount=${lpPackageAmount}` +
      ` productsTotal=${lpProductsTotal}` +
      ` orderId=${order_number || order_uuid}` +
      ` discount=${discountAmt}` +
      ` coupon=${couponCode || '(none)'}`
    );
    if (lpAmount !== lpProductsTotal) {
      console.error(
        `[LINEPAY] MISMATCH — amount(${lpAmount}) !== productsTotal(${lpProductsTotal})` +
        ` orderId=${order_number || order_uuid}`
      );
      return res.status(400).json({
        success: false,
        message: `LINE Pay 金額驗證失敗：amount(${lpAmount}) ≠ products加總(${lpProductsTotal})，訂單未送出`,
        debug: { amount: lpAmount, packageAmount: lpPackageAmount, productsTotal: lpProductsTotal },
      });
    }

    const requestBody = {
      amount:   lpAmount,
      currency: 'TWD',
      orderId:  order_number || order_uuid,
      packages: [{
        id:       order_number || order_uuid,
        amount:   lpPackageAmount,
        name:     String(customer_name || '訂單').slice(0, 100),
        products: linePayProducts,
      }],
      redirectUrls: {
        confirmUrl,
        cancelUrl: cancelUrlFinal,
      },
    };

    const uri   = '/v3/payments/request';
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, requestBody, nonce);

    const apiRes = await fetch(cfg.apiBase + uri, {
      method:  'POST',
      headers: makePostHeaders(cfg.channelId, signature, nonce),
      body:    bodyStr,
      timeout: 10000,
    });
    const data = await apiRes.json();

    if (data.returnCode !== '0000') {
      console.error('[linepay/request] error:', data);
      return res.status(400).json({
        success: false,
        message: `LINE Pay 建立付款失敗（${data.returnCode}）：${data.returnMessage || ''}`,
        linepay_code: data.returnCode,
      });
    }

    const transactionId = data.info?.transactionId;
    // 更新訂單狀態
    db.run(
      `UPDATE orders SET payment_status='pending', order_status='pending',
       updated_at=datetime('now','localtime') WHERE uuid=? AND store_id=?`,
      [order_uuid, storeId]
    );
    // 儲存 transactionId 至獨立欄位
    if (transactionId) {
      try {
        db.run(`UPDATE orders SET linepay_transaction_id=? WHERE uuid=? AND store_id=?`,
          [String(transactionId), order_uuid, storeId]);
      } catch {
        // 若欄位不存在（尚未 migrate），存到 sync_status 備用
        db.run(`UPDATE orders SET sync_status=? WHERE uuid=? AND store_id=?`,
          [`linepay_txid:${transactionId}`, order_uuid, storeId]);
      }
    }

    res.json({
      success:         true,
      payment_url:     data.info?.paymentUrl?.web,
      payment_url_app: data.info?.paymentUrl?.app,
      transaction_id:  transactionId,
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
  const storeId = req.query.store_id || req.storeId || null;
  // hotfix22-B：冷藏宅配訂單走同一組 Request/Confirm/Webhook，但付款完成後應導回
  // line-shipping.html 而非 line-order.html。前端呼叫 /api/linepay/request 時會在
  // confirmUrl 附上 &source=shipping，此處據以決定導回頁面；若缺少此參數，稍後也會
  // 用讀到的 order.order_mode 做二次判斷（雙重保險，不影響既有外帶/外送行為）。
  let pageBase = req.query.source === 'shipping' ? 'line-shipping.html' : 'line-order.html';
  try {
    const db  = getDb();
    const cfg = getLinePayConfig(db, storeId);

    if (!cfg) {
      return res.redirect(`/${pageBase}?store_id=${storeId}&linepay=error&msg=config_missing`);
    }

    const { transactionId, orderId } = req.query;
    if (!transactionId || !orderId) {
      return res.redirect(`/${pageBase}?store_id=${storeId}&linepay=error&msg=missing_params`);
    }

    const order = db.get(
      "SELECT * FROM orders WHERE store_id=? AND (order_number=? OR uuid=?)",
      [storeId, orderId, orderId]
    );
    if (!order) {
      return res.redirect(`/${pageBase}?store_id=${storeId}&linepay=error&msg=order_not_found`);
    }
    // 二次判斷：即使呼叫端漏帶 source 參數，仍可用訂單本身的 order_mode 修正導回頁面
    if (order.order_mode === 'shipping') pageBase = 'line-shipping.html';

    const confirmBody = { amount: Number(order.total || 0), currency: 'TWD' };
    const uri   = `/v3/payments/${transactionId}/confirm`;
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, confirmBody, nonce);

    const apiRes = await fetch(cfg.apiBase + uri, {
      method:  'POST',
      headers: makePostHeaders(cfg.channelId, signature, nonce),
      body:    bodyStr,
      timeout: 10000,
    });
    const data = await apiRes.json();

    if (data.returnCode !== '0000') {
      console.error('[linepay/confirm] error:', data);
      return res.redirect(
        `/${pageBase}?store_id=${storeId}&linepay=fail&order=${orderId}&code=${data.returnCode}`
      );
    }

    // 付款成功：更新訂單狀態（設為 pending 等店家接單，不直接 accepted）
    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET
        payment_status='paid',
        status='pending',
        order_status='pending',
        kitchen_status='pending',
        updated_at=?
       WHERE uuid=? AND store_id=?`,
      [now, order.uuid, storeId]
    );
    // 儲存 transactionId 至獨立欄位
    try {
      db.run(`UPDATE orders SET linepay_transaction_id=? WHERE uuid=? AND store_id=?`,
        [String(transactionId), order.uuid, storeId]);
    } catch {
      db.run(`UPDATE orders SET sync_status=? WHERE uuid=? AND store_id=?`,
        [`linepay_paid:${transactionId}`, order.uuid, storeId]);
    }

    // ── LINE Pay 付款成功後扣份數 ──────────────────────────
    // 訂單的商品在建立時（POST /api/line-orders）已存入 DB，現在從 DB 讀取並扣份數
    // hotfix22-B：冷藏宅配訂單（order_mode='shipping'）在建立訂單當下（routes/line-shipping.js）
    // 就已經扣過共用 LINE 份數（line_quota_sold），與外帶/外送「付款成功才扣」的時機不同。
    // 若在此再扣一次會造成重複扣份數，因此宅配訂單跳過這段（避免新問題：宅配 LINE Pay 雙重扣份數）。
    if (order.order_mode !== 'shipping') {
    const paidItems = (() => {
      try { return typeof order.items === 'string' ? JSON.parse(order.items||'[]') : (order.items||[]); }
      catch { return []; }
    })();
    const paidPickupDate = (order.pickup_time||'').slice(0, 10);
    const todayStrPay    = (() => {
      const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
    })();
    const isPreorderPaid = paidPickupDate && paidPickupDate > todayStrPay;
    paidItems.forEach(item => {
      const pid = item.product_id || item.id;
      if (!pid) return;
      const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
      if (!prod) return;
      const qty = Number(item.qty || 1);
      if (isPreorderPaid) {
        if (Number(prod.line_preorder_daily) > 0 || Number(prod.line_preorder_enabled)) {
          db.run(`UPDATE products SET line_preorder_sold = MAX(0, line_preorder_sold + ?),
            updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [qty, pid, storeId]);
        }
      } else {
        if (Number(prod.line_quota_daily) > 0 || Number(prod.line_quota_enabled)) {
          db.run(`UPDATE products SET line_quota_sold = MAX(0, line_quota_sold + ?),
            updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`, [qty, pid, storeId]);
        }
      }
    });
    }

    // 廣播付款成功通知（後台列表刷新）
    try {
      const paidOrder = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [order.uuid, storeId]);
      const wss = req.app.get('wss');
      broadcastToStore(wss, storeId, {
        type:            'linepay_paid',
        order_uuid:      order.uuid,
        order_number:    order.order_number,
        transactionId:   transactionId,
        payment_status:  'paid'
      });
      // 也廣播 order_status_changed 讓列表刷新
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: paidOrder });
    } catch(e) { console.error('[linepay] paid broadcast error:', e.message); }
    res.redirect(`/${pageBase}?store_id=${storeId}&linepay=success&order=${order.order_number}`);
  } catch(e) {
    console.error('[linepay/confirm] exception:', e.message);
    res.redirect(`/${pageBase}?store_id=${storeId}&linepay=error&msg=${encodeURIComponent(e.message)}`);
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/linepay/cancel — 付款取消 callback
// ══════════════════════════════════════════════════════════
router.get('/cancel', (req, res) => {
  const storeId = req.query.store_id || req.storeId || null;
  res.redirect(`/line-order.html?store_id=${storeId}&linepay=cancel&order=${req.query.orderId || ''}`);
});

// ══════════════════════════════════════════════════════════
// POST /api/linepay/webhook — LINE Pay webhook notify
// 路由別名：/webhook/linepay（相容後台預設 URL）
// ══════════════════════════════════════════════════════════
router.post('/webhook', (req, res) => {
  console.log('[linepay/webhook]', JSON.stringify(req.body).slice(0, 300));
  res.json({ returnCode: '0000', returnMessage: 'OK' });
});

module.exports = router;
