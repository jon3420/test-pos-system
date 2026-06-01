// routes/superAdmin.js — Super Admin 總控台 API (SaaS R1)
'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('../utils/db');
const { requireSuperAdmin, invalidateStoreCache, JWT_SECRET } = require('../middleware/storeGuard');
const { invalidateFeatureCache } = require('../middleware/featureGate');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── POST /api/super-admin/login ──────────────────────────
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: '請填寫帳號與密碼' });

    const db = getDb();
    const admin = db.get('SELECT * FROM super_admins WHERE username=?', [username]);
    if (!admin || admin.password_hash !== sha256(password)) {
      return res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }

    const token = jwt.sign(
      { role: 'super_admin', username: admin.username, id: admin.id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ success: true, token, username: admin.username });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/super-admin/dashboard — 總控台數據 ──────────
router.get('/dashboard', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const totalStores  = db.get('SELECT COUNT(*) as c FROM stores') || {c:0};
    const activeStores = db.get("SELECT COUNT(*) as c FROM stores WHERE active=1") || {c:0};
    const inactiveStores = db.get("SELECT COUNT(*) as c FROM stores WHERE active=0") || {c:0};
    // fix16: plan 唯一來源 = licenses.plan
    const basicPlans   = db.get("SELECT COUNT(*) as c FROM licenses WHERE plan='basic' AND active=1") || {c:0};
    const proPlans     = db.get("SELECT COUNT(*) as c FROM licenses WHERE plan='pro'   AND active=1") || {c:0};
    const recentStores = db.all(`SELECT s.store_id, s.store_name,
        COALESCE(l.plan, s.plan, 'basic') as plan,
        s.active, s.created_at
        FROM stores s LEFT JOIN licenses l ON l.store_id=s.store_id
        ORDER BY s.created_at DESC LIMIT 5`);
    res.json({
      success: true,
      data: {
        total_stores:    Number(totalStores.c),
        active_stores:   Number(activeStores.c),
        inactive_stores: Number(inactiveStores.c),
        basic_plans:     Number(basicPlans.c),
        pro_plans:       Number(proPlans.c),
        recent_stores:   recentStores,
      }
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/super-admin/stores — 所有店家列表 ──────────
router.get('/stores', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const stores = db.all('SELECT * FROM stores ORDER BY created_at DESC');
    // 附加授權資訊
    const storesWithLicense = stores.map(s => {
      const license = db.get('SELECT plan,active,features FROM licenses WHERE store_id=?', [s.store_id]);
      // fix16: plan 唯一來源 = licenses.plan（licenses 優先，stores.plan 僅備用）
      const effectivePlan = license ? license.plan : (s.plan || 'basic');
      return {
        ...s,
        plan: effectivePlan,   // 覆蓋 stores.plan，確保前端顯示 licenses.plan
        active: !!s.active,
        license: license ? {
          plan: license.plan,
          active: !!license.active,
          features: (() => { try { return JSON.parse(license.features||'{}'); } catch { return {}; } })()
        } : null
      };
    });
    res.json({ success: true, data: storesWithLicense });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/super-admin/stores — 新增店家 ────────────
router.post('/stores', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { store_id, store_name, contact_name='', phone='', plan='basic', active=true } = req.body;
    if (!store_id || !store_name)
      return res.status(400).json({ success: false, message: '請填寫 store_id 與店家名稱' });

    // 驗證 store_id 格式
    if (!/^[a-z0-9_]+$/.test(store_id))
      return res.status(400).json({ success: false, message: 'store_id 只能包含小寫英文、數字和底線' });

    const exists = db.get('SELECT id FROM stores WHERE store_id=?', [store_id]);
    if (exists)
      return res.status(409).json({ success: false, message: 'store_id 已存在' });

    // 新增 store
    db.run(
      'INSERT INTO stores (store_id,store_name,contact_name,phone,plan,active) VALUES (?,?,?,?,?,?)',
      [store_id, store_name, contact_name, phone, plan, active ? 1 : 0]
    );

    // 同步新增 license
    // fix16d: 統一 PLAN_DEFAULTS，payment_api 在 pro 為 true
    const PLAN_DEFAULTS = {
      basic: { order:true,orders:true,products:true,reports:true,print:true,inventory:false,line_order:false,delivery:false,marketing:false,member:false,coupon:false,label_print:false,payment_api:false },
      pro:   { order:true,orders:true,products:true,reports:true,print:true,inventory:true,line_order:true,delivery:true,marketing:false,member:false,coupon:false,label_print:true,payment_api:true },
    };
    const features = PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.basic;
    try {
      db.run(
        'INSERT OR REPLACE INTO licenses (store_id,store_name,plan,active,features) VALUES (?,?,?,?,?)',
        [store_id, store_name, plan, active ? 1 : 0, JSON.stringify(features)]
      );
    } catch {}

    // 初始化 settings
    const sd = (k, v) => {
      try { db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [store_id, k, v]); } catch {}
    };
    sd('shop_name', store_name);
    sd('tax_rate', '0'); sd('receipt_footer', '感謝您的光臨！歡迎再次惠顧');
    sd('printer_enabled', '0'); sd('line_order_enabled', '1');
    sd('line_ordering_enabled', '1'); sd('pickup_enabled', '1'); sd('delivery_enabled', '1');
    sd('line_today_closed', '0'); sd('line_today_closed_date', '');

    invalidateStoreCache(store_id);
    // fix16h: 新增店家後補齊付款方式（統一函式，含 PRAGMA 欄位相容 + UNIQUE INDEX）
    try {
      const { ensureDefaultPaymentMethods } = require('./payment-methods');
      ensureDefaultPaymentMethods(store_id, db);
    } catch(pmErr) { console.error('[superAdmin] 付款方式初始化失敗:', pmErr.message); }

    // fix16d: 新增店家時自動建立 8 個 payment_gateways
    try {
      const GW_PROVIDERS = [
        ['LINE Pay','linepay'],['綠界 ECPay','ecpay'],['藍新 NewebPay','newebpay'],
        ['街口支付','jkopay'],['全支付','pxpay'],['Apple Pay','applepay'],
        ['Google Pay','googlepay'],['信用卡刷卡機','creditcard_terminal'],
      ];
      GW_PROVIDERS.forEach(([name, code]) => {
        try {
          db.run(
            `INSERT OR IGNORE INTO payment_gateways (store_id,name,code,is_active,mode,api_key,secret_key,merchant_id,webhook_url,callback_url,extra_config)
             VALUES (?,?,?,0,'test','','','','','','{}')`,
            [store_id, name, code]
          );
        } catch {}
      });
    } catch(gwErr) { console.error('[superAdmin] payment_gateways 初始化失敗:', gwErr.message); }

    res.status(201).json({ success: true, store_id });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/super-admin/stores/:storeId — 更新店家 ─────
router.put('/stores/:storeId', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { storeId } = req.params;
    const store = db.get('SELECT * FROM stores WHERE store_id=?', [storeId]);
    if (!store) return res.status(404).json({ success: false, message: '店家不存在' });

    const { store_name, contact_name, phone, plan, active } = req.body;

    // fix16a: 不寫 stores.plan，licenses.plan 為唯一方案來源
    db.run(
      `UPDATE stores SET
        store_name=?, contact_name=?, phone=?, active=?,
        updated_at=datetime('now','localtime')
       WHERE store_id=?`,
      [
        store_name   ?? store.store_name,
        contact_name ?? store.contact_name,
        phone        ?? store.phone,
        active !== undefined ? (active ? 1 : 0) : store.active,
        storeId
      ]
    );

    // 方案與 active 只寫 licenses
    if (plan !== undefined || active !== undefined) {
      const curLic = db.get('SELECT plan FROM licenses WHERE store_id=?', [storeId]);
      const newPlan = plan ?? (curLic ? curLic.plan : 'basic');
      try {
        db.run(
          `UPDATE licenses SET plan=?, active=?, updated_at=datetime('now','localtime') WHERE store_id=?`,
          [newPlan, active !== undefined ? (active ? 1 : 0) : store.active, storeId]
        );
      } catch {}
    }

    invalidateStoreCache(storeId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /api/super-admin/stores/:storeId — 刪除店家 ──
router.delete('/stores/:storeId', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { storeId } = req.params;
    if (storeId === 'store_001')
      return res.status(400).json({ success: false, message: '脆豬腰為第一家店，不可刪除' });
    db.run('DELETE FROM stores WHERE store_id=?', [storeId]);
    try { db.run('DELETE FROM licenses WHERE store_id=?', [storeId]); } catch {}
    invalidateStoreCache(storeId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/super-admin/stores/:storeId/license — 授權詳情 ─
router.get('/stores/:storeId/license', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { storeId } = req.params;
    const lic = db.get('SELECT * FROM licenses WHERE store_id=?', [storeId]);
    if (!lic) return res.status(404).json({ success: false, message: '找不到授權' });
    let features = {};
    try { features = JSON.parse(lic.features || '{}'); } catch {}
    res.json({ success: true, data: { ...lic, active: !!lic.active, features } });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/super-admin/stores/:storeId/license — 更新授權 ─
router.put('/stores/:storeId/license', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { storeId } = req.params;
    const { plan, active, features } = req.body;
    const lic = db.get('SELECT * FROM licenses WHERE store_id=?', [storeId]);
    if (!lic) return res.status(404).json({ success: false, message: '找不到授權' });

    // fix16d: 統一 PLAN_DEFAULTS，payment_api 在 pro 為 true
    const PLAN_DEFAULTS = {
      basic: { order:true,orders:true,products:true,reports:true,print:true,inventory:false,line_order:false,delivery:false,marketing:false,member:false,coupon:false,label_print:false,payment_api:false },
      pro:   { order:true,orders:true,products:true,reports:true,print:true,inventory:true,line_order:true,delivery:true,marketing:false,member:false,coupon:false,label_print:true,payment_api:true },
    };
    let finalFeatures;
    if (features) finalFeatures = features;
    else if (plan && PLAN_DEFAULTS[plan]) finalFeatures = PLAN_DEFAULTS[plan];
    else { try { finalFeatures = JSON.parse(lic.features||'{}'); } catch { finalFeatures = {}; } }

    const newLicPlan = plan ?? lic.plan;
    db.run(
      `UPDATE licenses SET plan=?,active=?,features=?,updated_at=datetime('now','localtime') WHERE store_id=?`,
      [newLicPlan, active !== undefined ? (active ? 1 : 0) : lic.active, JSON.stringify(finalFeatures), storeId]
    );
    // fix16a: licenses.plan 為唯一來源，不再同步回 stores.plan
    invalidateFeatureCache(storeId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/super-admin/change-password ─────────────────
router.put('/change-password', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password)
      return res.status(400).json({ success: false, message: '請填寫舊密碼與新密碼' });

    const admin = db.get('SELECT * FROM super_admins WHERE username=?', [req.superAdmin.username]);
    if (!admin || admin.password_hash !== sha256(old_password))
      return res.status(401).json({ success: false, message: '舊密碼錯誤' });

    db.run('UPDATE super_admins SET password_hash=? WHERE username=?',
      [sha256(new_password), req.superAdmin.username]);
    res.json({ success: true, message: '密碼已更新' });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/super-admin/stores/:storeId/password — 設定店家 POS 密碼 ─
// ★ fix5：從 storeLogin.js 移入，受 requireSuperAdmin 保護
// 只有 Super Admin JWT 才能修改店家密碼
router.put('/stores/:storeId/password', requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { storeId } = req.params;
    const { new_password } = req.body;

    if (!new_password || String(new_password).trim().length < 4)
      return res.status(400).json({ success: false, message: '密碼至少 4 碼' });

    const store = db.get('SELECT store_id FROM stores WHERE store_id=?', [storeId]);
    if (!store) return res.status(404).json({ success: false, message: '店家不存在' });

    const crypto = require('crypto');
    const hash   = crypto.createHash('sha256').update(new_password).digest('hex');
    // fix7：不依賴 id 欄位，改用 UPDATE + INSERT OR IGNORE
    const upd = db.run("UPDATE settings SET value=? WHERE store_id=? AND key='pos_password'", [hash, storeId]);
    if (!upd.changes) {
      db.run("INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)", [storeId, 'pos_password', hash]);
    }

    res.json({ success: true, message: `店家 ${storeId} 的 POS 密碼已更新` });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
