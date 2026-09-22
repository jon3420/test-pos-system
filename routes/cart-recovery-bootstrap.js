// routes/cart-recovery-bootstrap.js — H1.4.12 Phase 3B（Popup Recovery LIFF
// Member Bootstrap — RC2 Security Corrective Audit）
//
// POST /api/cart-recovery/bootstrap-member
// POST /api/cart-recovery/liff-config
//
// 兩個端點都獨立掛載、不依賴 requireStore（store 要從 recovery_token 反查，
// 驗證前根本沒有已知 store）。bootstrap-member 只接受 recovery_token +
// line_id_token，用 LINE 官方 verify primitive 證明身分後簽發跟一般會員
// 登入完全同格式的 store-bound member_session；本身完全不改動 token 狀態
// （不 consume、不設 opened_at/consumed_at）。liff-config 只回傳這個
// recovery_token 所屬 store 設定的 popup 專用 LIFF ID，同樣不改動狀態、
// 不回傳 store_id，且會對這個 token 做一次 fresh authority 重新驗證
// （見 utils/lineCheckoutHandoff.js 的 resolveLiffIdForRecoveryToken()）。
//
// RC2 修正：rate limiter key 一律用 req.ip（尊重 server.js 的
// app.set('trust proxy', ...) 設定），不再直接讀取
// req.headers['x-forwarded-for']——trust proxy 關閉（預設）時，偽造這個
// header 完全不會影響限流。limiter 狀態放進 router factory 的 closure，
// production 只呼叫一次（module.exports 那次），測試可以各自建立獨立實例。
'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const { bootstrapMemberSessionFromRecoveryToken, resolveLiffIdForRecoveryToken } = require('../utils/lineCheckoutHandoff');
const { createRateLimiter } = require('../utils/rateLimiter');

const BOOTSTRAP_RATE_LIMIT_MAX = 20;
const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function createCartRecoveryBootstrapRouter() {
  const router = express.Router();
  const bootstrapLimiter = createRateLimiter({ windowMs: BOOTSTRAP_RATE_LIMIT_WINDOW_MS, max: BOOTSTRAP_RATE_LIMIT_MAX });
  const liffConfigLimiter = createRateLimiter({ windowMs: BOOTSTRAP_RATE_LIMIT_WINDOW_MS, max: BOOTSTRAP_RATE_LIMIT_MAX });

  router.post('/bootstrap-member', async (req, res) => {
    try {
      if (!bootstrapLimiter.check(req)) {
        return res.status(429).json({ success: false, reason: 'rate_limited' });
      }
      const db = getDb();
      const { recovery_token, line_id_token } = req.body || {};
      if (typeof recovery_token !== 'string' || !recovery_token) {
        return res.status(401).json({ success: false, reason: 'invalid_request' });
      }
      if (typeof line_id_token !== 'string' || !line_id_token) {
        return res.status(401).json({ success: false, reason: 'invalid_request' });
      }
      const result = await bootstrapMemberSessionFromRecoveryToken(db, recovery_token, line_id_token);
      if (!result.ok) {
        return res.status(401).json({ success: false, reason: 'bootstrap_failed' });
      }
      return res.status(200).json({ success: true, data: { member_session: result.memberSession } });
    } catch (e) {
      return res.status(401).json({ success: false, reason: 'bootstrap_failed' });
    }
  });

  router.post('/liff-config', (req, res) => {
    try {
      if (!liffConfigLimiter.check(req)) {
        return res.status(429).json({ success: false, reason: 'rate_limited' });
      }
      const db = getDb();
      const { recovery_token } = req.body || {};
      if (typeof recovery_token !== 'string' || !recovery_token) {
        return res.status(404).json({ success: false, reason: 'liff_config_unavailable' });
      }
      const result = resolveLiffIdForRecoveryToken(db, recovery_token);
      if (!result.ok) {
        return res.status(404).json({ success: false, reason: 'liff_config_unavailable' });
      }
      return res.status(200).json({ success: true, data: { liff_id: result.liffId } });
    } catch (e) {
      return res.status(404).json({ success: false, reason: 'liff_config_unavailable' });
    }
  });

  return router;
}

module.exports = createCartRecoveryBootstrapRouter();
module.exports.createCartRecoveryBootstrapRouter = createCartRecoveryBootstrapRouter;
module.exports.BOOTSTRAP_RATE_LIMIT_MAX = BOOTSTRAP_RATE_LIMIT_MAX;
