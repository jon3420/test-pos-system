// middleware/storeGuard.js — SaaS R1 fix16j
//
// fix16j 變更：移除所有 fallback 預設值
//   store_id 解析失敗 → 401 NO_STORE_TOKEN
//   store 不存在/停用 → 403
//   不再 fallback 成 store_001 或 default
//
// store_id 解析優先順序：
//   1. Bearer JWT payload.store_id（主要）
//   2. x-store-id header（Android POS 相容，必須真實 store_id）
//   3. query.store_id（LINE 點餐相容）
//   -- 沒有任何 fallback --

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';

// ── 快取（TTL 30 秒）──────────────────────────────────────
const storeCache = new Map();
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
    console.warn('[storeGuard] validateStore DB error, allowing through:', e.message);
    return { ok: true };
  }
}

/**
 * requireStore — fix16j
 *
 * 解析順序：JWT → x-store-id → query.store_id
 * 無任何 fallback，缺少 store_id 時回傳 401。
 */
function requireStore(req, res, next) {
  let candidateId = null;
  let source = '';

  // ── 1. Bearer JWT（最高信任）─────────────────────────────
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.role === 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Super Admin token 不可用於店家 API，請使用 /api/super-admin'
        });
      }
      if (payload.store_id) {
        candidateId = payload.store_id;
        source = 'jwt';
      }
    } catch(e) {
      // JWT 無效或過期
      console.warn('[storeGuard] JWT invalid:', e.message);
      // 繼續嘗試其他來源
    }
  }

  // ── 2. x-store-id header（Android POS 相容）──────────────
  if (!candidateId) {
    const xStoreId = req.headers['x-store-id'];
    if (xStoreId && xStoreId.trim() && xStoreId.trim() !== 'default') {
      candidateId = xStoreId.trim();
      source = 'x-store-id';
    }
  }

  // ── 3. query.store_id（LINE 點餐相容）────────────────────
  if (!candidateId) {
    const qStoreId = req.query?.store_id;
    if (qStoreId && qStoreId.trim() && qStoreId.trim() !== 'default') {
      candidateId = qStoreId.trim();
      source = 'query';
    }
  }

  // ── 4. 無 store_id → 401（fix16j: 不再 fallback）──────────
  if (!candidateId) {
    console.warn(`[storeGuard] 401 NO_STORE_TOKEN: ${req.method} ${req.path}`);
    return res.status(401).json({
      success: false,
      error:   'NO_STORE_TOKEN',
      message: '缺少店家登入 token，請重新登入',
    });
  }

  // ── 驗證 stores 表 ────────────────────────────────────────
  const result = validateStore(candidateId);
  if (!result.ok) {
    console.warn(`[storeGuard] 403 store_id="${candidateId}" (from ${source}): ${result.reason}`);
    return res.status(403).json({ success: false, message: result.reason });
  }

  console.log(`[storeGuard] OK store_id="${candidateId}" (from ${source}) ${req.method} ${req.path}`);
  req.storeId = candidateId;
  return next();
}

/**
 * requireSuperAdmin
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
 * requireStaffJwt — fix18-10-hotfix23-E1
 *
 * 給後台管理端 API 使用（例如 LINE 會員列表／詳情／CSV 匯出）。
 * 與 requireStore 不同：requireStaffJwt 不接受 x-store-id / query.store_id
 * 作為授權依據，store_id 只能來自已驗證的 Bearer JWT。
 *
 *   - 沒有 Authorization / JWT 無效 / JWT 過期        → 401
 *   - JWT 有效但是 super_admin token（非店家 staff）   → 403
 *     （Super Admin 目前沒有專用的跨店 line-member 端點；
 *       如需跨店查詢，請走既有 /api/super-admin 架構，
 *       不得讓一般 staff JWT 冒充。）
 *   - JWT 有效但缺少 store_id                         → 401
 *   - JWT 對應店家不存在 / 已停用                      → 403
 *
 * 成功時設定：
 *   req.auth    = { store_id, role, store_name }
 *   req.storeId = req.auth.store_id（覆蓋 requireStore 可能設定的值，
 *                 確保後續查詢一律以 JWT 內 store_id 為準）
 */
function requireStaffJwt(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'NO_JWT', message: '需要登入權杖（JWT）才能存取此功能' });
  }

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ success: false, error: 'INVALID_JWT', message: 'Token 無效或已過期，請重新登入' });
  }

  if (payload.role === 'super_admin') {
    return res.status(403).json({
      success: false,
      error: 'SUPER_ADMIN_NOT_ALLOWED',
      message: 'Super Admin token 不可直接用於店家管理端 API，請使用 /api/super-admin',
    });
  }

  if (!payload.store_id) {
    return res.status(401).json({ success: false, error: 'NO_STORE_IN_TOKEN', message: 'Token 缺少店家資訊，請重新登入' });
  }

  const result = validateStore(payload.store_id);
  if (!result.ok) {
    return res.status(403).json({ success: false, message: result.reason });
  }

  // 管理端授權只信任 JWT，不接受 query / header 覆寫 store_id
  req.auth = { store_id: payload.store_id, role: payload.role || 'store', store_name: payload.store_name };
  req.storeId = payload.store_id;
  return next();
}

function invalidateStoreCache(storeId) {
  if (storeId) storeCache.delete(storeId);
}

module.exports = { requireStore, requireStaffJwt, requireSuperAdmin, invalidateStoreCache, JWT_SECRET };
