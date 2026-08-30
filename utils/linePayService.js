// utils/linePayService.js
// H1.4.10 Phase 4B — server-authoritative LINE Pay Request 共用邏輯
//
// 這支模組給 Recovery Payment Resume（routes/cart-recovery.js
// POST /resume-payment）使用。刻意不去動 routes/linepay.js 既有的
// POST /request（那支路由是 Phase 3 已凍結測試過的既有 client 下單流程，
// 為了零風險，本輪完全不修改它、不重構它），只把 LINE Pay v3 簽章／呼叫
// 這段本來就與訂單來源無關的「純機制」抽成獨立、可重用的小函式，避免
// Recovery 這裡重新發明一套簽章邏輯。
//
// 與 routes/linepay.js /request 的關鍵差異：這裡的 requestBody 一律只能
// 從「已經在 DB 裡查出來的 order」建構，完全不接受任何呼叫端傳入的
// amount／items／customer 資料——這是 Recovery Resume 的核心安全要求。

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getLinePayConfig, signLinePayPost, makePostHeaders } = require('./linePayClient');

/**
 * requestLinePayPayment({ db, storeId, order, redirectUrl, cancelUrl })
 *
 * order 必須是已經從 DB 查出來的 orders row（呼叫端負責先驗證 store_id／
 * payment_status／是否已 payment_success／purchase）。這支函式完全不接受
 * 也不讀取任何 client 傳入的 amount/items/customer 資料——請求內容只用
 * order.total 建構單一品項（與既有 routes/linepay.js 在「有折扣」情境下
 * 的作法一致：避免把品項明細暴露成可被操弄的輸入面）。
 *
 * 回傳：
 *   { success:true, payment_url, transaction_id }
 *   { success:false, reason:'not_configured' | 'line_api_error' | 'network_error' }
 * 絕不 throw。
 */
async function requestLinePayPayment({ db, storeId, order, redirectUrl, cancelUrl }) {
  try {
    if (!order || !order.uuid) return { success: false, reason: 'invalid_order' };
    const cfg = getLinePayConfig(db, storeId);
    if (!cfg || !cfg.channelId || !cfg.channelSecret) return { success: false, reason: 'not_configured' };

    const finalTotal = Number(order.total || 0);
    if (!(finalTotal > 0)) return { success: false, reason: 'invalid_order' };
    const orderIdForLinePay = order.order_number || order.uuid;

    const requestBody = {
      amount: finalTotal,
      currency: 'TWD',
      orderId: orderIdForLinePay,
      packages: [{
        id: orderIdForLinePay,
        amount: finalTotal,
        name: '訂單費用',
        products: [{ name: '訂單費用', quantity: 1, price: finalTotal }],
      }],
      redirectUrls: { confirmUrl: redirectUrl, cancelUrl },
    };

    const uri = '/v3/payments/request';
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, requestBody, nonce);

    const fetch = require('node-fetch');
    const apiRes = await fetch(cfg.apiBase + uri, {
      method: 'POST',
      headers: makePostHeaders(cfg.channelId, signature, nonce),
      body: bodyStr,
      timeout: 10000,
    });
    const data = await apiRes.json();

    if (data.returnCode !== '0000') {
      console.error('[linePayService] request error:', data.returnCode);
      return { success: false, reason: 'line_api_error' };
    }

    const transactionId = data.info && data.info.transactionId;
    db.run(
      `UPDATE orders SET payment_status='pending', order_status='pending', updated_at=datetime('now','localtime') WHERE uuid=? AND store_id=?`,
      [order.uuid, storeId]
    );
    if (transactionId) {
      try { db.run(`UPDATE orders SET linepay_transaction_id=? WHERE uuid=? AND store_id=?`, [String(transactionId), order.uuid, storeId]); } catch (e) {}
    }

    return {
      success: true,
      payment_url: data.info && data.info.paymentUrl && data.info.paymentUrl.web,
      transaction_id: transactionId,
    };
  } catch (e) {
    console.warn('[linePayService] requestLinePayPayment exception:', e.message);
    return { success: false, reason: 'network_error' };
  }
}

module.exports = { requestLinePayPayment, getLinePayConfig };
