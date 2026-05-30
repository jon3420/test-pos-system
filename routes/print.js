// routes/print.js — SaaS R1 fix4（多店隔離 + storeId 傳入 printService）
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const ps = require('../services/printService');

function parseOrder(o) {
  if (!o) return null;
  return { ...o, items: typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []) };
}

// GET /api/print/printers — Windows 印表機清單（無需 store 隔離）
router.get('/printers', async (req, res) => {
  try {
    const list = await ps.getWindowsPrinters();
    res.json({ success: true, data: list });
  } catch(e) { res.json({ success: false, data: [], message: e.message }); }
});

// GET /api/print/status — 印表機狀態
// ★ fix4：傳入 storeId，讀取該店的 settings
router.get('/status', async (req, res) => {
  try {
    const storeId = req.storeId || 'store_001';
    const cfg     = ps.getPrinterConfig(storeId);
    const status  = await ps.checkPrinterStatus(storeId);
    res.json({ success: true, data: { ...status, ...cfg } });
  } catch(e) { res.json({ success: false, data: { connected: false, message: e.message } }); }
});

// POST /api/print/test — 測試列印
// ★ fix4：傳入 storeId
router.post('/test', async (req, res) => {
  try {
    const storeId = req.storeId || 'store_001';
    const result  = await ps.printTest(storeId);
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// POST /api/print/kitchen-test — 廚房單測試（固定內容，無需訂單）
router.post('/kitchen-test', async (req, res) => {
  try {
    const result = await ps.printKitchenTest();
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// POST /api/print/cashdrawer — 開錢櫃
// ★ fix4：傳入 storeId
router.post('/cashdrawer', async (req, res) => {
  try {
    const storeId = req.storeId || 'store_001';
    const result  = await ps.openCashDrawer(storeId);
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// POST /api/print/receipt — 列印訂單收據
// ★ fix3：AND store_id=?  ★ fix4：傳入 storeId 給 printService
router.post('/receipt', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [order_id, order_id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    // ★ fix4：傳入 storeId，printService 用該店設定列印
    const result = await ps.printOrder(parseOrder(order), storeId);
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// POST /api/print/kitchen — 廚房單
// ★ fix3：AND store_id=?  ★ fix4：傳入 storeId 給 printService
router.post('/kitchen', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [order_id, order_id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    // ★ fix4：傳入 storeId
    const result = await ps.printKitchenTicket(parseOrder(order), storeId);
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// POST /api/print/order — 向後相容別名（等同 receipt）
// ★ fix3：AND store_id=?  ★ fix4：傳入 storeId
router.post('/order', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get(
      'SELECT * FROM orders WHERE (id=? OR order_number=?) AND store_id=?',
      [order_id, order_id, storeId]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    // ★ fix4：傳入 storeId
    const result = await ps.printOrder(parseOrder(order), storeId);
    res.json({ success: result.success, message: result.message });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

module.exports = router;
