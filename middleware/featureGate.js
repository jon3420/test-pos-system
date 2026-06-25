// middleware/featureGate.js — SaaS R1 fix13
// fix13：加入 licenses.active=0 判斷，停用店家所有受控 API 均 403
'use strict';

const { getDb } = require('../utils/db');

const featureCache = new Map(); // store_id → { result, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

function getCached(storeId) {
  const e = featureCache.get(storeId);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { featureCache.delete(storeId); return null; }
  return e.result;
}
function setCache(storeId, result) {
  featureCache.set(storeId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

function invalidateFeatureCache(storeId) {
  if (storeId) featureCache.delete(storeId);
}

/**
 * 從 DB 取得 store 的授權狀態
 * 回傳 { active, features }
 */
function getStoreLicense(storeId) {
  const cached = getCached(storeId);
  if (cached) return cached;

  try {
    const db  = getDb();
    const lic = db.get('SELECT active, plan, features FROM licenses WHERE store_id=?', [storeId]);
    if (!lic) {
      const defaults = {
        active: true,
        features: { pos:true, orders:true, products:true, reports:true, print:true,
          inventory:false, line_order:false, delivery:false,
          marketing:false, member:false, coupon:false, label_print:false, payment_api:false, payment_methods:true }
      };
      setCache(storeId, defaults);
      return defaults;
    }
    let features = {};
    try { features = JSON.parse(lic.features || '{}'); } catch {}
    const result = { active: !!lic.active, features };
    setCache(storeId, result);
    return result;
  } catch(e) {
    console.error('[featureGate] getStoreLicense error:', e.message);
    return { active: true, features: {} };
  }
}

// 便利函式 — 只取 features
function getStoreFeatures(storeId) {
  return getStoreLicense(storeId).features;
}

/**
 * requireFeature(featureKey)
 *
 * fix13：先檢查 licenses.active，再檢查 feature。
 * active=0 → 403（店家已停用）
 * feature=false → 403（功能未授權）
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const storeId = req.storeId;
    try {
      const lic = getStoreLicense(storeId);

      // 1. 授權停用
      if (!lic.active) {
        return res.status(403).json({
          success: false,
          error:   'LICENSE_INACTIVE',
          message: '此店家授權已停用，請聯絡系統管理員'
        });
      }

      // 2. 功能未啟用
      if (lic.features[featureKey] !== true) {
        return res.status(403).json({
          success: false,
          error:   'FEATURE_DISABLED',
          feature: featureKey,
          message: '此功能未授權，請聯絡系統管理員升級方案'
        });
      }

      return next();
    } catch(e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  };
}

module.exports = { requireFeature, getStoreFeatures, getStoreLicense, invalidateFeatureCache };
