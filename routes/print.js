// routes/print.js — 列印 / 錢櫃 / 印表機清單 API
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const ps = require('../services/printService');

function parseOrder(o) {
  if (!o) return null;
  return { ...o, items: typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []) };
}

// GET /api/print/printers — Windows 印表機清單
router.get('/printers', async (req, res) => {
  try {
    const list = await ps.getWindowsPrinters();
    res.json({ success: true, data: list });
  } catch(e) {
    res.json({ success: false, data: [], message: e.message });
  }
});

// GET /api/print/status — 印表機狀態（含設定）
router.get('/status', async (req, res) => {
  try {
    const cfg    = ps.getPrinterConfig();
    const status = await ps.checkPrinterStatus();
    res.json({ success: true, data: { ...status, ...cfg } });
  } catch(e) {
    res.json({ success: false, data: { connected: false, message: e.message } });
  }
});

// POST /api/print/test — 測試列印
router.post('/test', async (req, res) => {
  try {
    const result = await ps.printTest();
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/print/receipt — 列印訂單收據
router.post('/receipt', async (req, res) => {
  try {
    const db = getDb();
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [order_id, order_id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const result = await ps.printOrder(parseOrder(order));
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/print/kitchen — 廚房單
router.post('/kitchen', async (req, res) => {
  try {
    const db = getDb();
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [order_id, order_id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const result = await ps.printKitchenTicket(parseOrder(order));
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/print/kitchen-test — 廚房單測試（固定內容，不需訂單）
router.post('/kitchen-test', async (req, res) => {
  try {
    const result = await ps.printKitchenTest();
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/print/cashdrawer — 開錢櫃
router.post('/cashdrawer', async (req, res) => {
  try {
    const result = await ps.openCashDrawer();
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/print/order — 向後相容別名（等同 receipt）
router.post('/order', async (req, res) => {
  try {
    const db = getDb();
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id 必填' });
    const order = db.get('SELECT * FROM orders WHERE id=? OR order_number=?', [order_id, order_id]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const result = await ps.printOrder(parseOrder(order));
    res.json({ success: result.success, message: result.message });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
