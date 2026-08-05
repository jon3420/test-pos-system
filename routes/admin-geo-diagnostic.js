// routes/admin-geo-diagnostic.js — fix18-10-hotfix30-B5-R5.4-G1.6-A2-T1
// Zeabur Client IP Trust Verification — 暫時性、Super Admin 限定診斷端點。
//
// 本端點：
//   - 不啟用／不觸碰 GEO_VISITOR_IP_ENABLED、不呼叫任何 IP Geo Provider。
//   - 不是第二套 Client IP Resolver——只讀取 req 既有屬性並分類，沿用
//     utils/clientIpTrustDiagnostic.js 的唯讀分類邏輯。
//   - 沿用既有 Super Admin 驗證（middleware/storeGuard.js requireSuperAdmin），
//     不新建一套權限系統。
//   - 只回傳白名單欄位，見 utils/clientIpTrustDiagnostic.js 頂部註解。
//   - 這是 T1（驗證階段）的暫時工具，待 Client IP Trust Gate 判定完成後
//     應予以移除或永久關閉（見 R5.4-G1.6-A2-T1_ZEABUR_CLIENT_IP_TRUST_AUDIT.md）。

'use strict';

const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../middleware/storeGuard');
const { buildClientIpTrustDiagnostic } = require('../utils/clientIpTrustDiagnostic');

router.get('/client-ip-trust-diagnostic', requireSuperAdmin, (req, res) => {
  try {
    const diagnostic = buildClientIpTrustDiagnostic(req);
    return res.json({ success: true, diagnostic });
  } catch (error) {
    // 安全錯誤處理：絕不把例外訊息（可能包含 header 內容）回傳給客戶端。
    console.error('[ClientIpTrustDiagnostic] failed');
    return res.status(500).json({ success: false, message: '診斷失敗' });
  }
});

module.exports = router;
