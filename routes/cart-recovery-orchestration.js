// routes/cart-recovery-orchestration.js
// H1.4.10 Phase 4C — n8n → POS Due Endpoint（server-to-server，獨立於顧客端
// /api/cart-recovery/* 的 browser/member_session 認證模式）。
//
// 這支路由完全不使用 requireStore/requireFeature（那些假設瀏覽器 JWT／
// x-store-id header 情境），因為呼叫方是 n8n，不是瀏覽器。身分驗證改用
// store-scoped HMAC（見 utils/cartRecoveryOrchestration.js）。

'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const orchestration = require('../utils/cartRecoveryOrchestration');

// Factory function：讓 /secret/rotate（Admin 動作）套用 server.js 既有的
// requireStore 中介層，而 /process-due（n8n server-to-server 呼叫，用 HMAC
// 驗證身分）完全不套用它——兩支端點的認證模型本來就不同。
module.exports = function createCartRecoveryOrchestrationRouter(requireStore) {
  if (typeof requireStore !== 'function') {
    throw new TypeError('createCartRecoveryOrchestrationRouter requires requireStore middleware');
  }
  const router = express.Router();

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/orchestration/process-due
//
// Body（最小化，需求文件十八）：{ version, store_id, timestamp, request_id }
// Headers：X-N8N-Recovery-Version/Timestamp/Request-Id/Signature
// ══════════════════════════════════════════════════════════════════
router.post('/process-due', async (req, res) => {
  try {
    const db = getDb();
    const body = req.body || {};

    // 需求文件二十五：不再 header/body fallback 混用——header 與 body 的
    // version/timestamp/request_id 必須完全一致，只對這一組唯一值驗 HMAC，
    // 避免「簽的是 A，實際用的是 B」這種模糊 contract。
    const headerVersion = req.get('X-N8N-Recovery-Version');
    const headerTimestamp = req.get('X-N8N-Recovery-Timestamp');
    const headerRequestId = req.get('X-N8N-Recovery-Request-Id');
    const providedSignature = (req.get('X-N8N-Recovery-Signature') || '').replace(/^sha256=/, '');
    const storeId = body.store_id;

    const structurallyValid = (
      body.version === 'v1' &&
      headerVersion === 'v1' &&
      storeId && headerTimestamp && headerRequestId && providedSignature &&
      headerTimestamp === String(body.timestamp) &&
      headerRequestId === String(body.request_id)
    );
    if (!structurallyValid) {
      return res.status(401).json({ success: false, reason: 'invalid_or_expired_signature' });
    }
    const timestamp = headerTimestamp;
    const requestId = headerRequestId;

    if (!orchestration.isTimestampFresh(timestamp)) {
      return res.status(401).json({ success: false, reason: 'invalid_or_expired_signature' });
    }
    // 需求文件二十六：signature 驗證「前」不能洩漏 store 存不存在——這裡先
    // 用 storeId 查 secret（查不到 secret 一樣會導致下面驗簽失敗，行為對外
    // 觀察不到差異），驗簽通過「後」才二次確認 store 真的存在/active。
    const secret = orchestration.getSharedSecret(db, storeId);
    if (!secret) {
      return res.status(401).json({ success: false, reason: 'invalid_or_expired_signature' });
    }
    const validSignature = orchestration.verifySignature(secret, { version: 'v1', storeId, timestamp, requestId }, providedSignature);
    if (!validSignature) {
      return res.status(401).json({ success: false, reason: 'invalid_or_expired_signature' });
    }

    // 需求文件二十六：驗簽通過後才確認 store 存在，不存在則安全 no-op，
    // 不得為任意 store_id 建立資料列。
    const storeRow = db.get('SELECT store_id FROM stores WHERE store_id=?', [storeId]);
    if (!storeRow) {
      return res.status(401).json({ success: false, reason: 'invalid_or_expired_signature' });
    }

    // 需求文件二十五：即使 signature 正確，n8n orchestration 沒開啟就不 process。
    if (!orchestration.isOrchestrationEnabled(db, storeId)) {
      return res.json({ success: true, processed: 0, sent: 0, skipped: 0, failed: 0, has_more: false, note: 'orchestration_disabled' });
    }

    // 需求文件二十二／二十三：Replay Protection（DB persisted，不用 in-memory）。
    const recordResult = orchestration.recordOrchestrationRequest(db, storeId, requestId, 'inbound_due');
    if (recordResult.replay) {
      return res.json({ success: true, replay: true, processed: 0, sent: 0, skipped: 0, failed: 0, has_more: false });
    }

    // 需求文件二十七：只呼叫既有 service，不在這支 route 複製 eligibility／
    // push／token creation／conversion check 任何一段邏輯。POS 永遠是
    // authority——即使 n8n 認為「該提醒了」，這裡呼叫的
    // processDueLineRecoveryJobs() 內部會對每一筆 job 重新做完整
    // evaluateLineRecoveryEligibility() 判斷與 send 前 recheck。
    const delivery = require('../utils/cartRecoveryDelivery');
    const BATCH_LIMIT = 50; // 需求文件二十八：安全批次上限，避免一次處理過多 job 拖垮 process
    const result = await delivery.processDueLineRecoveryJobs(db, storeId, { limit: BATCH_LIMIT });

    orchestration.markOrchestrationRequestProcessed(db, storeId, requestId, 'inbound_due', { status: 'processed', httpStatus: 200 });

    // 需求文件二十九／二十九-A：response 只回聚合數字，不回 job rows / UID /
    // cart / order / token / 電話地址。has_more 直接沿用 service 回傳的值，
    // 不用 processed>=BATCH_LIMIT 自行猜測（那在剛好等於上限或被 future
    // rows 卡住時都會算錯）。
    return res.json({
      success: true,
      processed: result.processed,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      has_more: !!result.has_more,
    });
  } catch (e) {
    console.error('[cart-recovery-orchestration] POST /process-due error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/orchestration/secret/rotate
//
// 由店家 Admin（走既有 browser/admin 認證，掛在 server.js 時會加
// requireStore）觸發，產生新的高熵 secret，只有這次呼叫回傳明文一次。
// ══════════════════════════════════════════════════════════════════
router.post('/secret/rotate', requireStore, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    if (!storeId) return res.status(400).json({ success: false, message: 'missing store' });
    const crypto = require('crypto');
    const { validateSharedSecret } = orchestration;
    const newSecret = crypto.randomBytes(32).toString('base64url');
    // 需求：rotate 端點自己產生的 secret 也必須通過同一份 SSOT 驗證——不是
    // 因為信任「這是伺服器自己產生的所以一定沒問題」，而是確保全系統只有
    // 一套判斷「這是不是一個合格的 shared secret」的邏輯，不會出現手動輸入
    // 路徑與自動產生路徑各自認定不同標準的情況。crypto.randomBytes(32) 理論
    // 上必然通過（NIST 等級亂數源），若真的沒通過代表格式常數本身不一致，
    // 直接安全失敗，不寫入一個連自己驗證都過不了的值。
    const selfCheck = validateSharedSecret(newSecret);
    if (!selfCheck.valid) {
      console.error('[cart-recovery-orchestration] rotate self-validation failed:', selfCheck.reason);
      return res.status(500).json({ success: false, message: 'rotate_failed' });
    }
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'cart_recovery_n8n_secret']);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'cart_recovery_n8n_secret', newSecret]);
    // 只有這次 rotate 呼叫回傳明文，之後 GET /api/settings 永遠不再回傳。
    return res.json({ success: true, secret: newSecret });
  } catch (e) {
    console.error('[cart-recovery-orchestration] POST /secret/rotate error:', e.message);
    res.status(500).json({ success: false, message: 'rotate_failed' });
  }
});

return router;
};
