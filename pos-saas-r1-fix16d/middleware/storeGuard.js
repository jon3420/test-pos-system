// middleware/storeGuard.js — SaaS R1 fix4
//
// fix4 / fix5 變更：
//   Bearer JWT 路徑不再無條件信任。
//   store_id 解析後（無論來源），統一經 validateStore() 查 stores 表：
//     存在 + active=1 → 放行
//     不存在 / active=0 → HTTP 403
//
//   停用生效時機：
//     Super Admin 停用店家時會呼叫 invalidateStoreCache()，清除快取，
//     使下一個 API 請求立即查 DB 並收到 403。
//     一般情況下快取 TTL 為 30 秒，最多 30 秒內生效。
//
// store_id 解析優先順序：
//   1. Bearer JWT payload.store_id
//   2. x-store-id header（Android POS 相容）
//   3. query.store_id（LINE 點餐相容）
//   4. 預設 store_001（向後相容）
//
// Super Admin API（/api/super-admin/*）由 requireSuperAdmin 保護，
// 完全不套用 requireStore。

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';

// ── 快取（TTL 30 秒）──────────────────────────────────────
const storeCache = new Map();  // store_id → { valid, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

function getCached(storeId) {
  const e = storeCache.get(storeId);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { storeCache.delete(storeId); return null; }
  return e.valid;
}
function setCache(storeId, valid) {
  storeCache.set(storeId, { valid, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * validateStore — 查 stores 表確認存在且 active=1
 * 結果快取 30 秒，停用後最多延遲 30 秒生效。
 */
function validateStore(storeId) {
  const cached = getCached(storeId);
  if (cached === true)  return { ok: true };
  if (cached === false) return { ok: false, reason: '店家不存在或已停用' };

  try {
    const { getDb } = require('../utils/db');
    const db    = getDb();
    const store = db.get('SELECT store_id, active FROM stores WHERE store_id=?', [storeId]);

    if (!store) {
      setCache(storeId, false);
      return { ok: false, reason: `店家 ${storeId} 不存在` };
    }
    if (Number(store.active) !== 1) {
      setCache(storeId, false);
      return { ok: false, reason: `店家 ${storeId} 已停用` };
    }
    setCache(storeId, true);
    return { ok: true };
  } catch(e) {
    // DB 尚未初始化（極早期請求）→ 放行
    console.warn('[storeGuard] validateStore DB error, allowing through:', e.message);
    return { ok: true };
  }
}

/**
 * requireStore
 *
 * fix4：所有路徑（含 JWT）取得 store_id 後統一驗證，
 * 確保停用店家的舊 JWT 不能繼續使用。
 */
function requireStore(req, res, next) {
  let candidateId = null;

  // ── 1. Bearer JWT ────────────────────────────────────────
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);

      // Super Admin token 誤用於店家 API → 拒絕
      if (payload.role === 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Super Admin token 不可用於店家 API，請使用 /api/super-admin'
        });
      }

      if (payload.store_id) candidateId = payload.store_id;
    } catch(e) {
      // token 無效 → 繼續往下解析
    }
  }

  // ── 2. x-store-id header（Android POS 相容）──────────────
  if (!candidateId && req.headers['x-store-id'])
    candidateId = String(req.headers['x-store-id']).trim();

  // ── 3. query.store_id（LINE 點餐相容）────────────────────
  if (!candidateId && req.query?.store_id)
    candidateId = String(req.query.store_id).trim();

  // ── 4. 預設 store_001（向後相容）─────────────────────────
  if (!candidateId) candidateId = 'store_001';

  // ── 統一驗證（fix4：JWT 路徑也走這裡）────────────────────
  const result = validateStore(candidateId);
  if (!result.ok) {
    console.warn(`[storeGuard] 403 store_id="${candidateId}": ${result.reason}`);
    return res.status(403).json({ success: false, message: result.reason });
  }

  req.storeId = candidateId;
  return next();
}

/**
 * requireSuperAdmin — Super Admin 總控台專用
 * 與 requireStore 完全獨立，不做 store_id 解析。
 */
function requireSuperAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: '需要 Super Admin 權限' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'super_admin')
      return res.status(403).json({ success: false, message: '需要 Super Admin 權限' });
    req.superAdmin = payload;
    return next();
  } catch(e) {
    return res.status(401).json({ success: false, message: 'Token 無效或已過期' });
  }
}

/**
 * invalidateStoreCache — Super Admin 新增 / 更新 / 停用店家後呼叫。
 * 清除該 store_id 的 validateStore 快取，使下一次 API 請求重新查詢 DB。
 *
 * 生效時機：
 *   - Super Admin 主動停用店家 → 呼叫此函式 → 快取立即清除
 *     → 下一個帶舊 JWT 的 API 請求查 DB → active=0 → 403
 *   - 一般情況（未呼叫此函式）→ 快取 TTL 30 秒 → 最多 30 秒後生效
 */
function invalidateStoreCache(storeId) {
  if (storeId) storeCache.delete(storeId);
}

module.exports = { requireStore, requireSuperAdmin, invalidateStoreCache, JWT_SECRET };
