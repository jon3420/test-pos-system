// routes/cart-recovery-resolve-target.js — H1.4.12 Phase 3B（Popup Recovery
// Identity Bridge — RC2 Security Corrective Audit）
//
// POST /api/cart-recovery/resolve-target
//
// 這是「identity landing」唯一應該呼叫的端點：只接受 recovery_token +
// member_session，完全不接受、也不信任 client 傳入的 store_id／page_type／
// popup session code／target path／line_user_id／entry_context。
//
// 刻意獨立成一個檔案、不掛 requireStore（跟一般需要「已知 store」的端點不
// 同：這裡的 store 要*從 token 反查*，在驗證之前根本沒有 store 可言，掛
// requireStore 反而會逼呼叫端先提供一個尚未被信任的 store_id）。
//
// 只做 prepare／resolve target：驗證身分、驗證 token 狀態、算出安全
// target，必要時把 bound 轉成 opened。絕不回傳購物車內容、絕不把狀態轉成
// consumed、絕不洩漏 line_user_id 或內部 store/license/gateway 資料。
//
// RC2 修正：
//   1. 加入跟其他 recovery 端點同一套 utils/rateLimiter.js（req.ip 為 key，
//      尊重 trust proxy 設定，不直接讀 X-Forwarded-For）。
//   2. 所有失敗情況（not_found/expired/uid_mismatch/consumed/cancelled/
//      invalid_target/popup_session_not_found/exception...）collapse 成同一個
//      byte-identical 的失敗 response，不再把 result.reason 直接透傳出去
//      ——上一版雖然註解說「不可枚舉」，實際上把內部 reason 字串原封不動
//      回傳，等於還是洩漏了可以拿來枚舉 token 狀態的訊號。
'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const { resolveRecoveryTargetForVerifiedMember } = require('../utils/lineCheckoutHandoff');
const { createRateLimiter } = require('../utils/rateLimiter');

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// resolve-target 沒有既有 production 門檻可以沿用（上一版完全沒有限流），
// 這裡選一個跟同類端點（bootstrap/liff-config 20/min、popup prepare/commit
// 30/min）同一數量級的保守值。
const RATE_LIMIT_MAX = 30;

// 規格四：所有失敗一律回這個固定、byte-identical 的 JSON，不夾帶任何
// 隨著失敗原因而變化的欄位。
const RESOLVE_FAILED_RESPONSE = Object.freeze({ success: false, reason: 'resolve_failed' });

function createResolveTargetRouter() {
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });

  router.post('/', (req, res) => {
    try {
      if (!limiter.check(req)) {
        // 429 本身也不得洩漏 token 是否存在——跟一般失敗用同一個回應形狀，
        // 只差 HTTP status。
        return res.status(429).json(RESOLVE_FAILED_RESPONSE);
      }
      const db = getDb();
      const { recovery_token, member_session } = req.body || {};
      // request body 就只讀這兩個欄位；即使 client 額外夾帶 store_id／
      // page_type／popup_session_public_code／target_path／line_user_id／
      // entry_context 等欄位，這裡完全不讀取、也不會被下面的函式用到。
      const result = resolveRecoveryTargetForVerifiedMember(db, recovery_token, member_session);
      if (!result.ok) {
        return res.status(200).json(RESOLVE_FAILED_RESPONSE);
      }
      // 成功時仍只回 allowlisted 欄位。
      const data = { page_type: result.pageType, target_path: result.targetPath };
      if (result.popupSessionPublicCode) data.popup_session_public_code = result.popupSessionPublicCode;
      return res.status(200).json({ success: true, data });
    } catch (e) {
      return res.status(200).json(RESOLVE_FAILED_RESPONSE);
    }
  });

  return router;
}

module.exports = createResolveTargetRouter();
module.exports.createResolveTargetRouter = createResolveTargetRouter;
module.exports.RATE_LIMIT_MAX = RATE_LIMIT_MAX;
