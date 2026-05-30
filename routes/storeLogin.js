// routes/storeLogin.js — R1 fix5
// 只保留店家登入端點（公開）
// ★ fix5：/set-password 已移除，改由 superAdmin.js 統一保護
'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { getDb } = require('../utils/db');
const { JWT_SECRET, invalidateStoreCache } = require('../middleware/storeGuard');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// POST /api/store-login
// body: { store_id, password }
// → { success, token, store_id, store_name, plan }
// 公開端點（不需 storeGuard）
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { store_id, password } = req.body;

    if (!store_id || !password)
      return res.status(400).json({ success: false, message: '請填寫 store_id 與密碼' });

    // 確認店家存在且啟用
    const store = db.get('SELECT * FROM stores WHERE store_id=?', [store_id]);
    if (!store)
      return res.status(401).json({ success: false, message: '店家不存在' });
    if (!store.active)
      return res.status(403).json({ success: false, message: '此店家已停用，請聯繫管理員' });

    // 驗證密碼（settings 中 key='pos_password' 存 sha256 hash）
    // 未設定時預設密碼 = store_id 明文的 sha256（R1 測試期）
    const pwRow = db.get(
      "SELECT value FROM settings WHERE store_id=? AND key='pos_password'",
      [store_id]
    );
    const expectedHash = pwRow ? pwRow.value : sha256(store_id);

    if (sha256(password) !== expectedHash)
      return res.status(401).json({ success: false, message: '密碼錯誤' });

    // 發行 JWT（8 小時）
    const token = jwt.sign(
      { role: 'store', store_id: store.store_id, store_name: store.store_name, plan: store.plan },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    invalidateStoreCache(store_id);

    res.json({
      success:    true,
      token,
      store_id:   store.store_id,
      store_name: store.store_name,
      plan:       store.plan,
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
