// routes/license.js — 雲端授權管理 API (v18-r1-fix2)
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { requireAdminMode } = require('../middleware/adminGuard');

// ── 管理員模式說明 ────────────────────────────────────────
// GET  /api/license           → 開放（管理員查詢清單）
// GET  /api/license/plans/defaults → 開放（前台套用預設）
// GET  /api/license/:storeId  → 開放（Android 查詢授權）
// POST /api/license           → 需要 ADMIN_MODE=true
// PUT  /api/license/:storeId  → 需要 ADMIN_MODE=true
// DELETE /api/license/:storeId → 需要 ADMIN_MODE=true

// ── 預設方案功能清單 ──────────────────────────────────────
const PLAN_DEFAULTS = {
  basic: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: false, line_order: false, delivery: false,
    marketing: false, member: false, coupon: false, label_print: false
  },
  pro: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: true, line_order: true, delivery: true,
    marketing: false, member: false, coupon: false, label_print: true
  },
  enterprise: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: true, line_order: true, delivery: true,
    marketing: true, member: true, coupon: true, label_print: true
  }
};

// ── 確保 license 資料表存在（共用，供 licenseGuard 也可呼叫）──
function ensureLicenseTable(db) {
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

    // 若完全沒有授權，建立預設店家
    const count = db.get('SELECT COUNT(*) as c FROM licenses');
    if (!count || Number(count.c) === 0) {
      db.run(
        `INSERT INTO licenses (store_id, store_name, plan, active, features)
         VALUES (?, ?, ?, ?, ?)`,
        ['default_store', '示範店', 'basic', 1, JSON.stringify(PLAN_DEFAULTS.basic)]
      );
    }
  } catch(e) {
    console.error('[license] ensureLicenseTable error:', e.message);
  }
}

// ── ★ 重要：固定路由必須在動態 :storeId 之前 ─────────────

// ── GET /api/license — 後台取得所有授權清單 ──────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const rows = db.all('SELECT * FROM licenses ORDER BY id ASC');
    const list = rows.map(r => {
      let features = {};
      try { features = JSON.parse(r.features || '{}'); } catch {}
      return { ...r, active: !!r.active, features };
    });
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/license/plans/defaults — ★ 必須在 :storeId 之前 ──
router.get('/plans/defaults', (req, res) => {
  res.json({ success: true, data: PLAN_DEFAULTS });
});

// ── GET /api/license/:storeId — Android 查詢授權 ─────────
router.get('/:storeId', (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const { storeId } = req.params;

    const row = db.get('SELECT * FROM licenses WHERE store_id=?', [storeId]);
    if (!row) {
      return res.status(404).json({
        success: false, active: false,
        message: '找不到此店家授權，請聯繫系統管理員'
      });
    }

    let features = {};
    try { features = JSON.parse(row.features || '{}'); } catch {}

    if (!row.active) {
      return res.json({
        success: false, active: false,
        message: '此店家授權已停用，請聯繫系統管理員'
      });
    }

    return res.json({
      success: true,
      store_id:   row.store_id,
      store_name: row.store_name,
      plan:       row.plan,
      active:     !!row.active,
      features
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/license — 新增授權（需 ADMIN_MODE）────────────
router.post('/', requireAdminMode, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const { store_id, store_name, plan = 'basic', active = true, features } = req.body;
    if (!store_id || !store_name) {
      return res.status(400).json({ success: false, message: '請填寫 store_id 與店家名稱' });
    }
    const finalFeatures = features || PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.basic;
    const result = db.run(
      `INSERT INTO licenses (store_id, store_name, plan, active, features)
       VALUES (?, ?, ?, ?, ?)`,
      [store_id, store_name, plan, active ? 1 : 0, JSON.stringify(finalFeatures)]
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(400).json({ success: false, message: 'store_id 已存在' });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/license/:storeId — 更新授權（需 ADMIN_MODE）──
router.put('/:storeId', requireAdminMode, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const { storeId } = req.params;
    const { store_name, plan, active, features } = req.body;

    const row = db.get('SELECT * FROM licenses WHERE store_id=?', [storeId]);
    if (!row) {
      return res.status(404).json({ success: false, message: '找不到此授權' });
    }

    let finalFeatures;
    if (features !== undefined) {
      finalFeatures = features;
    } else if (plan && plan !== row.plan && PLAN_DEFAULTS[plan]) {
      finalFeatures = PLAN_DEFAULTS[plan];
    } else {
      try { finalFeatures = JSON.parse(row.features || '{}'); } catch { finalFeatures = {}; }
    }

    db.run(
      `UPDATE licenses SET
        store_name = ?,
        plan       = ?,
        active     = ?,
        features   = ?,
        updated_at = datetime('now','localtime')
       WHERE store_id = ?`,
      [
        store_name ?? row.store_name,
        plan       ?? row.plan,
        active !== undefined ? (active ? 1 : 0) : row.active,
        JSON.stringify(finalFeatures),
        storeId
      ]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /api/license/:storeId — 刪除授權（需 ADMIN_MODE）
router.delete('/:storeId', requireAdminMode, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const { storeId } = req.params;
    if (storeId === 'default_store') {
      return res.status(400).json({ success: false, message: '預設店家不可刪除' });
    }
    db.run('DELETE FROM licenses WHERE store_id=?', [storeId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = { router, PLAN_DEFAULTS, ensureLicenseTable };
