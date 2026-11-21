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
const { logServerEvent, getOrderTrackingContext } = require('../utils/analyticsLog'); // fix18-10-hotfix23-A
const { recordMemberPurchase } = require('../utils/lineMemberStats'); // fix18-10-hotfix23-E：LINE 會員入口
// H1.4.10 Phase 4B：LINE Pay config／簽章 primitives 的唯一 SSOT，避免
// utils/linePayService.js（Recovery Payment Resume）各自重複定義一套一模一樣
// 的簽章公式（見 utils/linePayClient.js 與 Reality Audit）。這裡 import 進來
// 的函式名稱與行為跟原本這個檔案自己定義的完全相同，下面所有呼叫端一個字元
//都不用改。
const { getApiBase, getLinePayConfig, signLinePayPost, signLinePayGet, makePostHeaders, makeGetHeaders } = require('../utils/linePayClient');

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

    const { bodyStr, signature } = signLinePayPost(channelSecret, testUri, testBody, nonce);

    // === Debug Log ===
    // H1.4.10 Phase 4B（Reality Audit 發現的既有安全問題）：這裡原本印出
    // messagePreview:message.slice(0,60)——message 是
    // channelSecret+uri+bodyStr+nonce 的簽章 preimage，開頭就是完整
    // channelSecret 本身，等於把商家的 LINE Pay Channel Secret 印進 log。
    // 拿掉 message 欄位（見 utils/linePayClient.js 的 signLinePayPost() 已不
    // 再回傳 message）之後這裡改印無害的 diagnostic 欄位。
    console.log('[LINEPAY TEST]', {
      mode,
      apiBase,
      channelId,
      channelIdLen: channelId.length,
      channelSecretLen: channelSecret.length,
      uri: testUri,
      nonce,
      nonceLen: nonce.length,
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
// R54.4／MBV2-HF1-C5.1：
//   - 只以 order_uuid（伺服器保存的唯一識別）定位訂單；金額、品項、orderId、confirmUrl 全部由伺服器以資料庫訂單建立，
//     不採用前端傳入的 order_number／total／items／redirect_url。
//   - 每次請求建立一筆付款嘗試（linepay_payment_attempts：店別＋訂單 uuid＋送出的 orderId＋transactionId），
//     confirmUrl 帶 attempt 參數，callback 以它唯一定位訂單（LINE Pay 另會附上 orderId 與 transactionId）。
//   - transactionId 為 19 位整數：從原始回應文字擷取並以字串保存，不經 JS Number（官方：以 64-bit long 或字串處理）。
// ══════════════════════════════════════════════════════════
const OrderIdentity = require('../utils/orderIdentity');
const LPR = require('../utils/linePayRecovery'); // C5.2
function sameOriginUrl(u, host) {
  try { const x = new URL(String(u || '')); const h = new URL(host); return x.origin === h.origin ? x.toString() : null; } catch { return null; }
}
function linePayProductsFromOrder(order) {
  const finalTotal = Number(order.total || 0);
  const discountAmt = Number(order.discount_amount || 0);
  const couponCode = order.coupon_code ? String(order.coupon_code) : '';
  const delivFee = Number(order.delivery_fee || 0);
  if (discountAmt > 0) {
    // 有折扣：單一總品項（避免 2101 Parameter error）
    const productName = couponCode ? '訂單費用（已套用優惠券 ' + couponCode + '）' : '訂單費用（含優惠折扣）';
    return [{ name: productName.slice(0, 4000), quantity: 1, price: finalTotal }];
  }
  let items = [];
  try { items = typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); } catch { items = []; }
  const products = (Array.isArray(items) ? items : []).map((i) => ({
    name: String(i.name || '商品').slice(0, 4000), quantity: Number(i.qty || 1), price: Number(i.price || 0),
  }));
  if (delivFee > 0) products.push({ name: '外送費', quantity: 1, price: delivFee });
  const sum = products.reduce((t, p) => t + Number(p.quantity) * Number(p.price), 0);
  // 明細加總與訂單金額不一致（例如加價選項、舊資料）→ 改用單一總品項，金額一律以訂單 total 為準
  if (!products.length || Math.round(sum * 100) !== Math.round(finalTotal * 100)) return [{ name: '訂單費用', quantity: 1, price: finalTotal }];
  return products;
}
router.post('/request', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    const cfg     = getLinePayConfig(db, storeId);

    if (!cfg) return res.status(400).json({ success: false, message: 'LINE Pay 未設定或未啟用' });
    if (!cfg.channelId)     return res.status(400).json({ success: false, message: 'LINE Pay Channel ID 未設定（Merchant ID 欄位）' });
    if (!cfg.channelSecret) return res.status(400).json({ success: false, message: 'LINE Pay Channel Secret 未設定（Secret Key 欄位）' });

    const { order_uuid, customer_name, cancel_url } = req.body || {};
    if (!order_uuid) return res.status(400).json({ success: false, message: '缺少必要欄位（order_uuid）' });

    // 只以伺服器保存的唯一識別取單（店別限定）；不以前端傳入的 order_number 決定付款對象
    const order = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [String(order_uuid), storeId]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    if (order.payment_status === 'paid') return res.status(409).json({ success: false, error: 'ALREADY_PAID', message: '此訂單已完成付款' });
    if (order.order_status === 'cancelled' || order.status === 'void') return res.status(409).json({ success: false, error: 'ORDER_NOT_PAYABLE', message: '此訂單已取消，無法付款' });
    // C5.2：前一次付款結果仍待核對（可能已扣款）→ 不建立新的付款請求，避免重複扣款
    if (LPR.isUnderReview(db, storeId, order.uuid)) return res.status(409).json({ success: false, error: 'PAYMENT_UNDER_REVIEW', message: '這筆訂單的付款結果確認中，請勿重複付款，可稍後查詢訂單狀態' });

    const finalTotal = Number(order.total || 0);
    if (!(finalTotal > 0)) return res.status(400).json({ success: false, message: '訂單金額不正確' });
    const linePayProducts = linePayProductsFromOrder(order);
    const lpProductsTotal = linePayProducts.reduce((t, p) => t + Number(p.quantity) * Number(p.price), 0);
    if (Math.round(lpProductsTotal * 100) !== Math.round(finalTotal * 100)) {
      return res.status(400).json({ success: false, message: 'LINE Pay 金額驗證失敗，訂單未送出' });
    }

    // 付款嘗試（同步建立，await 之前完成）
    const attempt = OrderIdentity.createAttempt(db, storeId, order, finalTotal, order.order_mode === 'shipping' ? 'line_shipping' : 'line_order', cfg.channelId);
    const host = `${req.protocol}://${req.get('host')}`;
    const confirmUrl = `${host}/api/linepay/confirm?store_id=${encodeURIComponent(storeId)}&attempt=${attempt.attempt_uuid}`
      + (order.order_mode === 'shipping' ? '&source=shipping' : '');
    const defaultCancel = `${host}/${order.order_mode === 'shipping' ? 'line-shipping.html' : 'line-order.html'}?store_id=${encodeURIComponent(storeId)}&linepay=cancel`;
    const cancelUrlFinal = sameOriginUrl(cancel_url, host) || defaultCancel;

    console.log(`[LINEPAY] request amount=${finalTotal} lpOrderId=${attempt.lp_order_id} discount=${Number(order.discount_amount || 0)}`);
    const requestBody = {
      amount:   finalTotal,
      currency: 'TWD',
      orderId:  attempt.lp_order_id,
      packages: [{
        id:       attempt.lp_order_id,
        amount:   finalTotal,
        name:     String(customer_name || order.customer_name || '訂單').slice(0, 100),
        products: linePayProducts,
      }],
      redirectUrls: { confirmUrl, cancelUrl: cancelUrlFinal },
    };

    const uri   = '/v3/payments/request';
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, requestBody, nonce);

    let text = '', data = null;
    try {
      const apiRes = await fetch(cfg.apiBase + uri, {
        method:  'POST',
        headers: makePostHeaders(cfg.channelId, signature, nonce),
        body:    bodyStr,
        timeout: 10000,
      });
      ({ text, data } = await OrderIdentity.readLinePayResponse(apiRes));
    } catch (netErr) {
      OrderIdentity.attemptFailed(db, storeId, attempt.attempt_uuid, 'network');
      throw netErr;
    }

    if (!data || data.returnCode !== '0000') {
      console.error('[linepay/request] error:', data && data.returnCode);
      OrderIdentity.attemptFailed(db, storeId, attempt.attempt_uuid, data && data.returnCode);
      return res.status(400).json({
        success: false,
        message: `LINE Pay 建立付款失敗（${data && data.returnCode}）：${(data && data.returnMessage) || ''}`,
        linepay_code: data && data.returnCode,
      });
    }

    const transactionId = OrderIdentity.extractTransactionId(text, data);
    OrderIdentity.attemptRequested(db, storeId, attempt.attempt_uuid, transactionId);
    // 更新訂單狀態（既有行為）；舊版欄位 linepay_transaction_id 一併保存最新交易識別（字串），供相容與回退
    db.run(
      `UPDATE orders SET payment_status='pending', order_status='pending',
       updated_at=datetime('now','localtime') WHERE uuid=? AND store_id=? AND COALESCE(payment_status,'')<>'paid'`,
      [order.uuid, storeId]
    );
    if (transactionId) {
      try {
        db.run(`UPDATE orders SET linepay_transaction_id=? WHERE uuid=? AND store_id=? AND COALESCE(payment_status,'')<>'paid'`,
          [String(transactionId), order.uuid, storeId]);
      } catch {
        db.run(`UPDATE orders SET sync_status=? WHERE uuid=? AND store_id=?`,
          [`linepay_txid:${transactionId}`, order.uuid, storeId]);
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
// R54.4／MBV2-HF1-C5.1：以付款嘗試（attempt）唯一定位訂單並核對 transactionId／orderId；重號且沒有可靠交易對應 → 拒絕自動判定。
// R54.4／MBV2-HF1-C5.2（utils/linePayRecovery.js settle）：
//   - 送出 Confirm 前重新讀取訂單與付款嘗試：已取消／作廢不發起 Confirm；先 durable 保存 confirm_pending，保存失敗不呼叫外部 API。
//   - Confirm 回應不明、重複交易代碼、本機保存失敗 → 以官方唯讀查詢核對；仍無法判定 → 待核對（linepay=pending），不推定成功或失敗。
//   - 金流已付款：交易內重新讀取訂單；已取消／作廢 → 記錄已付款、保留取消、標示待退款，不恢復出餐、不扣份數。
//   - 份數已於訂單建立時依快照扣除，付款確認不再扣。副作用以 outbox 補齊，各只一次。
// ══════════════════════════════════════════════════════════
const _confirmInflight = new Map(); // `${store}|${order_uuid}` → Promise<redirect>（同一程序內合併同時的 callback；持久狀態在資料庫）
function lpRedirect(pageBase, storeId, kind, extra) {
  return `/${pageBase}?store_id=${encodeURIComponent(storeId || '')}&linepay=${kind}${extra || ''}`;
}
function outcomeRedirect(pageBase, storeId, order, r) {
  const ref = order ? `&order=${encodeURIComponent(order.order_number)}&order_ref=${encodeURIComponent(order.uuid)}` : '';
  switch (r.outcome) {
    case 'success': return lpRedirect(pageBase, storeId, 'success', ref);
    case 'paid_cancelled': return lpRedirect(pageBase, storeId, 'error', '&msg=paid_cancelled' + ref);
    case 'order_cancelled': return lpRedirect(pageBase, storeId, 'error', '&msg=order_cancelled' + ref);
    case 'already_paid': return lpRedirect(pageBase, storeId, 'error', '&msg=already_paid' + ref);
    case 'amount_changed': return lpRedirect(pageBase, storeId, 'error', '&msg=amount_changed' + ref);
    case 'failed': return lpRedirect(pageBase, storeId, 'fail', `${ref}&code=${encodeURIComponent(r.code || '')}`);
    default: return lpRedirect(pageBase, storeId, 'pending', ref); // 結果確認中：請勿重複付款
  }
}
router.get('/confirm', async (req, res) => {
  const storeId = req.query.store_id || req.storeId || null;
  // hotfix22-B：冷藏宅配訂單付款完成後導回 line-shipping.html（source=shipping 或訂單 order_mode 二次判斷）
  let pageBase = req.query.source === 'shipping' ? 'line-shipping.html' : 'line-order.html';
  try {
    const db  = getDb();
    const cfg = getLinePayConfig(db, storeId);
    if (!cfg) return res.redirect(lpRedirect(pageBase, storeId, 'error', '&msg=config_missing'));

    const tx = String(req.query.transactionId || '');
    const r = OrderIdentity.resolveCallback(db, storeId, req.query);
    if (r.error) {
      // 不揭露其他訂單；只記錄代碼（不記錄交易識別全文）
      console.warn(`[linepay/confirm] rejected: ${r.error} store=${storeId} attempt=${req.query.attempt ? 'yes' : 'no'}`);
      const msg = r.error === 'ambiguous' ? 'order_ambiguous' : (r.error === 'missing_params' ? 'missing_params' : (r.error === 'order_not_found' || r.error === 'attempt_not_found' ? 'order_not_found' : 'payment_mismatch'));
      return res.redirect(lpRedirect(pageBase, storeId, 'error', `&msg=${msg}`));
    }
    const order = r.order;
    if (order.order_mode === 'shipping') pageBase = 'line-shipping.html';
    // 升級前（沒有付款嘗試）的付款：建立對應的付款嘗試，走同一流程
    const attempt = r.attempt || LPR.ensureLegacyAttempt(db, storeId, order, String(req.query.orderId || ''), tx, cfg);
    const key = `${storeId}|${order.uuid}`;
    if (_confirmInflight.has(key)) { await _confirmInflight.get(key).catch(() => null); }
    const p = (async () => {
      const out = await LPR.settle(db, cfg, storeId, attempt.attempt_uuid, { tx, allowConfirm: true });
      // R54.4／MBV2-HF1-C6.2：依訂單目前後端狀態同步補貨登記份數（已付款扣減／失敗解除訂購中；fail-open、可重複）
      require('../utils/demandSettlement').safeSync(db, storeId, order.uuid, {}, 'linepay_confirm');
      if (out.reason === 'in_progress') {
        // 後台核對正在處理同一筆：顯示確認中（不推定）
        return lpRedirect(pageBase, storeId, 'pending', `&order=${encodeURIComponent(order.order_number)}&order_ref=${encodeURIComponent(order.uuid)}`);
      }
      if (out.outcome === 'success' || out.outcome === 'paid_cancelled') {
        try {
          const paidOrder = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [order.uuid, storeId]);
          const wss = req.app.get('wss');
          if (out.outcome === 'success') broadcastToStore(wss, storeId, { type: 'linepay_paid', order_uuid: order.uuid, order_number: order.order_number, payment_status: 'paid' });
          broadcastToStore(wss, storeId, { type: 'order_status_changed', order: paidOrder });
        } catch (e) { console.error('[linepay] paid broadcast error:', e.message); }
      }
      if (out.outcome === 'pending') console.warn(`[linepay/confirm] payment under review store=${storeId} reason=${out.reason || ''}`);
      return outcomeRedirect(pageBase, storeId, out.order || order, out);
    })();
    _confirmInflight.set(key, p);
    let to;
    try { to = await p; } finally { if (_confirmInflight.get(key) === p) _confirmInflight.delete(key); }
    return res.redirect(to);
  } catch(e) {
    console.error('[linepay/confirm] exception:', e.message);
    res.redirect(lpRedirect(pageBase, storeId, 'pending', ''));
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

// ══════════════════════════════════════════════════════════
// R54.4／MBV2-HF1-C5.2：付款待核對（後台；server.js 以 requireStaffJwt＋requireFeature('payment_api') 掛載）
//   GET  /api/linepay-admin/review                       待核對付款嘗試、待退款的已付款取消單、待補齊的副作用
//   POST /api/linepay-admin/reconcile { limit, attempt_uuid } 以官方唯讀查詢核對（不發起 Confirm、不退款）；同店 20 秒最多一次
//   POST /api/linepay-admin/attempts/:uuid/mark-unpaid { note } C5.3 停用：一律 409 TERMINAL_EVIDENCE_REQUIRED（舊版前端呼叫也一樣）
// ══════════════════════════════════════════════════════════
const adminRouter = express.Router();
adminRouter.get('/review', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const db = getDb();
    const data = LPR.listReview(db, req.storeId, req.query.limit);
    // R54.4／MBV2-HF1-C5.4：快閃 LINE Pay 待核對（獨立付款嘗試表；同一面板顯示、核對一樣只做唯讀查詢）
    try { data.popup_attempts = require('../utils/popupPaymentRecovery').listReview(db, req.storeId, req.query.limit); } catch (e) { data.popup_attempts = []; }
    res.json({ success: true, data });
  }
  catch (e) { console.error('[linepay-admin] review:', e && e.message); res.status(500).json({ success: false, message: '系統忙碌，請稍後再試' }); }
});
adminRouter.post('/reconcile', async (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    const PPR = require('../utils/popupPaymentRecovery');
    // C5.4：指定快閃付款嘗試 → 只核對該筆（唯讀）
    if (b.popup_attempt_id) {
      const p = await PPR.reconcile(db, req.storeId, { attempt_id: String(b.popup_attempt_id) });
      if (p.busy) return res.status(409).json({ success: false, error: 'RECONCILE_BUSY', message: '核對進行中，請稍後再試' });
      if (p.rate_limited) return res.status(429).json({ success: false, error: 'RECONCILE_RATE_LIMITED', message: '核對太頻繁，請稍後再試', retry_after_ms: p.retry_after_ms });
      return res.json({ success: true, data: { checked: p.checked, recovered: p.recovered, paid_cancelled: p.paid_cancelled, still_review: p.still_review, popup: p } });
    }
    const out = await LPR.reconcile(db, (sid) => getLinePayConfig(db, sid), req.storeId, { inquire: true, limit: b.limit, attempt_uuid: b.attempt_uuid ? String(b.attempt_uuid) : undefined });
    if (out.busy) return res.status(409).json({ success: false, error: 'RECONCILE_BUSY', message: '核對進行中，請稍後再試' });
    if (out.rate_limited) return res.status(429).json({ success: false, error: 'RECONCILE_RATE_LIMITED', message: '核對太頻繁，請稍後再試', retry_after_ms: out.retry_after_ms });
    if (!b.attempt_uuid) {
      try {
        const p = await PPR.reconcile(db, req.storeId, { limit: b.limit });
        if (p && !p.busy && !p.rate_limited) { out.checked += p.checked; out.recovered += p.recovered; out.paid_cancelled += p.paid_cancelled; out.still_review += p.still_review; out.popup = p; }
      } catch (e) { console.warn('[linepay-admin] popup reconcile:', e && e.message); }
    }
    res.json({ success: true, data: out });
  } catch (e) { console.error('[linepay-admin] reconcile:', e && e.message); res.status(500).json({ success: false, message: '系統忙碌，請稍後再試' }); }
});
adminRouter.post('/attempts/:uuid/mark-unpaid', (req, res) => {
  try {
    const r = LPR.markUnpaid(getDb(), req.storeId, String(req.params.uuid || ''), (req.body || {}).note);
    if (!r.ok) return res.status(r.code || 409).json({ success: false, error: r.error || 'CONFLICT', message: r.message });
    res.json({ success: true });
  } catch (e) { console.error('[linepay-admin] mark-unpaid:', e && e.message); res.status(500).json({ success: false, message: '系統忙碌，請稍後再試' }); }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
