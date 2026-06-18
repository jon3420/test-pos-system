// routes/license.js — SaaS R1 fix13
// Android 授權查詢保持開放；管理操作改用 Super Admin JWT
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { requireSuperAdmin } = require('../middleware/storeGuard');

// fix13：移除 ADMIN_MODE，改用 requireSuperAdmin
// 不再引用 adminGuard

const PLAN_DEFAULTS = {
  basic: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: false, line_order: false, delivery: false,
    marketing: false, member: false, coupon: false, label_print: false, payment_api: false, payment_methods: true
  },
  pro: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: true, line_order: true, delivery: true,
    marketing: false, member: false, coupon: false, label_print: true, payment_api: true, payment_methods: true
  },
  enterprise: {
    order: true, orders: true, products: true, reports: true, print: true,
    inventory: true, line_order: true, delivery: true,
    marketing: true, member: true, coupon: true, label_print: true, payment_api: true, payment_methods: true
  }
};

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
  } catch(e) { console.error('[license] ensureLicenseTable error:', e.message); }
}

// ── GET /api/license/plans/defaults — 公開（Android 用）────
router.get('/plans/defaults', (req, res) => {
  res.json({ success: true, data: PLAN_DEFAULTS });
});

// ── GET /api/license/:storeId — Android 查詢（公開）────────
// 保留給 Android POS 相容，不需要 JWT
router.get('/:storeId', (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const row = db.get('SELECT * FROM licenses WHERE store_id=?', [req.params.storeId]);
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
      store_id: row.store_id, store_name: row.store_name,
      plan: row.plan, active: !!row.active, features
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/license — 所有授權清單（★ 限 Super Admin）────
router.get('/', requireSuperAdmin, (req, res) => {
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
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/license — 新增授權（★ 限 Super Admin）────────
router.post('/', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const { store_id, store_name, plan = 'basic', active = true, features } = req.body;
    if (!store_id || !store_name)
      return res.status(400).json({ success: false, message: '請填寫 store_id 與店家名稱' });
    const finalFeatures = features || PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.basic;
    const result = db.run(
      `INSERT INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      [store_id, store_name, plan, active ? 1 : 0, JSON.stringify(finalFeatures)]
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch(e) {
    if (e.message?.includes('UNIQUE'))
      return res.status(400).json({ success: false, message: 'store_id 已存在' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/license/:storeId — 更新授權（★ 限 Super Admin）
router.put('/:storeId', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    const row = db.get('SELECT * FROM licenses WHERE store_id=?', [req.params.storeId]);
    if (!row) return res.status(404).json({ success: false, message: '找不到此授權' });
    const { store_name, plan, active, features } = req.body;
    let finalFeatures;
    if (features !== undefined) finalFeatures = features;
    else if (plan && plan !== row.plan && PLAN_DEFAULTS[plan]) finalFeatures = PLAN_DEFAULTS[plan];
    else { try { finalFeatures = JSON.parse(row.features || '{}'); } catch { finalFeatures = {}; } }
    db.run(
      `UPDATE licenses SET store_name=?,plan=?,active=?,features=?,updated_at=datetime('now','localtime') WHERE store_id=?`,
      [store_name??row.store_name, plan??row.plan,
       active!==undefined?(active?1:0):row.active, JSON.stringify(finalFeatures), req.params.storeId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── DELETE /api/license/:storeId — 刪除授權（★ 限 Super Admin）
router.delete('/:storeId', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    ensureLicenseTable(db);
    if (req.params.storeId === 'default_store')
      return res.status(400).json({ success: false, message: '預設店家不可刪除' });
    db.run('DELETE FROM licenses WHERE store_id=?', [req.params.storeId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { router, PLAN_DEFAULTS, ensureLicenseTable };
