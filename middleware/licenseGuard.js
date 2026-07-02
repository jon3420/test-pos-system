// middleware/licenseGuard.js — 後端 API 授權驗證中介層 (v18-r1)
const { getDb } = require('../utils/db');

// ── 本地定義 ensureLicenseTable（避免循環 require）────────
// 與 routes/license.js 中邏輯一致，確保第一次啟動即可使用
const BASIC_FEATURES = {
  order: true, orders: true, products: true, reports: true, print: true,
  inventory: false, line_order: false, delivery: false,
  marketing: false, member: false, coupon: false, label_print: false,
  ai_marketing: false // AI Marketing Center（新增，預設關閉）
};

let _tableEnsured = false;

function ensureLicenseTable(db) {
  if (_tableEnsured) return;
  try {
    db._db.run(`CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id   TEXT NOT NULL UNIQUE,
      store_name TEXT NOT NULL DEFAULT '預設店家',
      plan       TEXT NOT NULL DEFAULT 'basic',
      active     INTEGER NOT NULL DEFAULT 1,
      features   TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
    db._save();

    const count = db.get('SELECT COUNT(*) as c FROM licenses');
    if (!count || Number(count.c) === 0) {
      db.run(
        `INSERT INTO licenses (store_id, store_name, plan, active, features)
         VALUES (?, ?, ?, ?, ?)`,
        ['default_store', '示範店', 'basic', 1, JSON.stringify(BASIC_FEATURES)]
      );
    }
    _tableEnsured = true;
    console.log('[licenseGuard] licenses 資料表已確認');
  } catch(e) {
    console.error('[licenseGuard] ensureLicenseTable error:', e.message);
  }
}

// ── 從 DB 取得授權 ────────────────────────────────────────
function getLicense(storeId) {
  try {
    const db = getDb();
    ensureLicenseTable(db);   // ★ 每次都確保表存在
    const row = db.get('SELECT * FROM licenses WHERE store_id=?', [storeId || 'default_store']);
    if (!row) return null;
    let features = {};
    try { features = JSON.parse(row.features || '{}'); } catch {}
    return { ...row, active: !!row.active, features };
  } catch(e) {
    console.error('[licenseGuard] getLicense error:', e.message);
    return null;
  }
}

/**
 * 產生授權驗證 Middleware
 * storeId 優先從 query.store_id → header x-store-id → 預設 'default_store'
 * @param {string} featureKey  例：'inventory' / 'line_order'
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const storeId = req.query.store_id || req.headers['x-store-id'] || 'default_store';
    const license = getLicense(storeId);

    if (!license) {
      return res.status(403).json({ success: false, message: '找不到授權設定，請聯繫管理員' });
    }
    if (!license.active) {
      return res.status(403).json({ success: false, message: '此店家授權已停用，請聯繫系統管理員' });
    }
    if (!license.features[featureKey]) {
      return res.status(403).json({ success: false, message: '此功能尚未開通，請升級方案或聯繫管理員' });
    }
    next();
  };
}

module.exports = { requireFeature, getLicense, ensureLicenseTable };
