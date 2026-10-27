// routes/cart-recovery-popup-restore.js — H1.4.12 Phase 3B（Popup Recovery
// Cart Restore／Reconcile — RC2 Security Corrective Audit）
//
// POST /api/cart-recovery/prepare-popup-restore
// POST /api/cart-recovery/commit-popup-restore
//
// 兩者都獨立掛載、不依賴 requireStore（store 由 recovery token/receipt
// row 反查）。prepare 完全不改動 recovery token 狀態；只有 commit 會在單一
// transaction 內把 receipt 與 token 一起轉成 consumed。
//
// RC2 修正：rate limiter key 一律用 req.ip（尊重 server.js 的
// app.set('trust proxy', ...) 設定），不再直接讀取
// req.headers['x-forwarded-for']；limiter 邏輯抽到共用的
// utils/rateLimiter.js，狀態仍在 router factory 的 closure 內——production
// 只呼叫一次 module.exports，測試可各自建立獨立實例。
'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const { isDurableError } = require('../utils/db');
const { preparePopupRestore, commitPopupRestore } = require('../utils/popupRestore');
const { createRateLimiter } = require('../utils/rateLimiter');

// Production 安全門檻：30 requests / 60 秒 / IP，不得因測試呼叫次數增加就
// 放寬——測試改成用 createPopupRestoreRouter() 建立隔離的 limiter 狀態。
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;

function createPopupRestoreRouter() {
  const router = express.Router();
  const prepareLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });
  const commitLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });

  router.post('/prepare-popup-restore', (req, res) => {
    try {
      if (!prepareLimiter.check(req)) return res.status(429).json({ success: false, reason: 'rate_limited' });
      const db = getDb();
      // 嚴格 allowlist：只讀這三個欄位。即使 body 夾帶 store_id/line_user_id/
      // page_type/target_path/商品名稱/價格/subtotal/total/pickup snapshot/
      // client eligibility/client payment methods，一律不讀取、不使用。
      const { recovery_token, member_session, popup_session_public_code } = req.body || {};
      if (typeof recovery_token !== 'string' || !recovery_token) {
        return res.status(401).json({ success: false, reason: 'invalid_request' });
      }
      const result = preparePopupRestore(db, recovery_token, member_session, popup_session_public_code);
      if (!result.ok) {
        // 規格一：invalid_snapshot 是結構化的 4xx，跟其他不可枚舉的身分/狀態
        // 錯誤分開回（不洩漏「究竟是哪一種結構問題」，但至少讓前端知道這是
        // 「快照本身不可信」而不是「purely 身分/狀態被拒」，才能正確顯示
        // 「無法恢復」而不是誤判成空購物車）。
        if (result.reason === 'invalid_snapshot') {
          return res.status(400).json({ success: false, reason: 'invalid_snapshot' });
        }
        return res.status(401).json({ success: false, reason: 'prepare_failed' });
      }
      return res.status(200).json({
        success: true,
        data: {
          restore_receipt: result.restoreReceipt,
          popup_session_public_code: result.popupSessionPublicCode,
          cart_state: result.cartState,
          items: result.items,
          removed_items: result.removedItems,
        },
      });
    } catch (e) {
      if (isDurableError(e)) return res.status(503).json({ success: false, error: 'STORAGE_UNAVAILABLE' }); // R44.2F.1
      return res.status(401).json({ success: false, reason: 'prepare_failed' });
    }
  });

  router.post('/commit-popup-restore', (req, res) => {
    try {
      if (!commitLimiter.check(req)) return res.status(429).json({ success: false, reason: 'rate_limited' });
      const db = getDb();
      const { restore_receipt, member_session, popup_session_public_code } = req.body || {};
      if (typeof restore_receipt !== 'string' || !restore_receipt) {
        return res.status(401).json({ success: false, reason: 'invalid_request' });
      }
      const result = commitPopupRestore(db, restore_receipt, member_session, popup_session_public_code);
      if (!result.ok) {
        return res.status(401).json({ success: false, reason: 'commit_failed' });
      }
      return res.status(200).json({ success: true, data: { consumed: true } });
    } catch (e) {
      if (isDurableError(e)) return res.status(503).json({ success: false, error: 'STORAGE_UNAVAILABLE' }); // R44.2F.1
      return res.status(401).json({ success: false, reason: 'commit_failed' });
    }
  });

  return router;
}

module.exports = createPopupRestoreRouter();
module.exports.createPopupRestoreRouter = createPopupRestoreRouter;
module.exports.RATE_LIMIT_MAX = RATE_LIMIT_MAX;
module.exports.RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
