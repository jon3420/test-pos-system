// routes/shipping.js — fix18-10-hotfix21：物流 API 架構預留 V1
//
// 設計原則：
//   1. 這一版「不」真的串接黑貓 / 新竹物流 / 嘉里大榮，只建立設定架構，
//      供未來版本擴充時，前端與資料庫欄位都已就緒。
//   2. 完全獨立於既有冷藏宅配設定（routes/line-shipping.js 的 shipping_* 欄位），
//      不影響、不覆蓋既有冷藏宅配下單流程與商家設定。
//   3. 設定值一律存在 settings 表（key 見 SHIPPING_API_KEYS 白名單），
//      orders 表的物流 API 欄位為 safe migration（見 utils/db.js），此版本
//      不會有任何流程寫入這些欄位（V1 僅預留架構）。
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 支援物流商清單（V1：全部 enabled=false，僅手動輸入可用）──────────
// fix18-10-hotfix21：依最新需求擴充物流商清單
const SHIPPING_PROVIDERS = [
  { id: 'manual',     name: '手動輸入',       enabled: true  },
  { id: 'blackcat',   name: '黑貓宅急便',     enabled: false },
  { id: 'hct',        name: '新竹物流',       enabled: false },
  { id: 'tcat',       name: '台灣宅配通',     enabled: false },
  { id: 'familymart', name: '全家超商取貨',   enabled: false },
  { id: 'seven11',    name: '7-ELEVEN 取貨', enabled: false },
  { id: 'shopee',     name: '蝦皮店到店',     enabled: false },
  { id: 'custom',     name: '自訂物流商',     enabled: false },
];

// ── settings key 白名單（fix18-10-hotfix21）───────────────────────────
const SHIPPING_API_KEYS = [
  'shipping_api_enabled',
  'shipping_provider',
  'shipping_api_key',
  'shipping_api_secret',
  'shipping_customer_id',
  'shipping_sender_name',
  'shipping_sender_phone',
  'shipping_sender_address',
  'shipping_test_mode',
];

const SHIPPING_API_DEFAULTS = {
  shipping_api_enabled:    '0',
  shipping_provider:       'manual',
  shipping_api_key:        '',
  shipping_api_secret:     '',
  shipping_customer_id:    '',
  shipping_sender_name:    '',
  shipping_sender_phone:   '',
  shipping_sender_address: '',
  shipping_test_mode:      '1',
};

function getShippingApiConfig(db, storeId) {
  const rows = db.all(
    `SELECT key, value FROM settings WHERE store_id=? AND key IN (${SHIPPING_API_KEYS.map(() => '?').join(',')})`,
    [storeId, ...SHIPPING_API_KEYS]
  );
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  const cfg = {};
  SHIPPING_API_KEYS.forEach(k => { cfg[k] = map[k] !== undefined ? map[k] : SHIPPING_API_DEFAULTS[k]; });
  cfg.shipping_api_enabled = cfg.shipping_api_enabled === '1';
  cfg.shipping_test_mode   = cfg.shipping_test_mode   !== '0';
  return cfg;
}

// ── GET /api/shipping/providers — 支援物流商清單 ──────────────────────
router.get('/providers', (req, res) => {
  res.json({ success: true, data: SHIPPING_PROVIDERS });
});

// ── GET /api/shipping/config — 讀取物流 API 設定 ──────────────────────
router.get('/config', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    res.json({ success: true, data: getShippingApiConfig(db, storeId) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /api/shipping/config — 儲存物流 API 設定 ────────────────────
router.patch('/config', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;

    // 物流商必須是支援清單內的 id，避免髒資料
    if (req.body.shipping_provider !== undefined) {
      const validIds = SHIPPING_PROVIDERS.map(p => p.id);
      if (!validIds.includes(req.body.shipping_provider)) {
        return res.status(400).json({ success: false, message: '無效的物流商代碼：' + req.body.shipping_provider });
      }
    }

    SHIPPING_API_KEYS.forEach(k => {
      if (req.body[k] === undefined) return;
      const val = String(req.body[k]);
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [val, storeId, k]);
      if (!updated.changes) {
        db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, val]);
      }
    });

    res.json({ success: true, data: getShippingApiConfig(db, storeId) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/shipping/test — 測試連線（V1：僅回傳預留訊息，不真的串接）──
router.post('/test', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cfg = getShippingApiConfig(db, storeId);
    // V1：不論設定為何，一律回傳「尚未串接」訊息，避免誤導已可正式使用
    res.json({
      success: true,
      message: '物流 API 測試功能已預留，尚未串接正式物流商',
      data: { provider: cfg.shipping_provider, enabled: cfg.shipping_api_enabled },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
