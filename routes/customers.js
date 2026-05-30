// routes/customers.js — SaaS R1 fix1（多店隔離版）
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { phone, q } = req.query;
    let sql = 'SELECT * FROM customers WHERE store_id=?';
    const p = [storeId];
    if (phone) { sql += ' AND phone=?'; p.push(phone); }
    if (q) { sql += ' AND (name LIKE ? OR phone LIKE ? OR line_id LIKE ?)'; p.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    sql += ' ORDER BY visit_count DESC LIMIT 50';
    res.json({ success: true, data: db.all(sql, p) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const c = db.get('SELECT * FROM customers WHERE store_id=? AND (id=? OR phone=?)', [storeId, req.params.id, req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: '會員不存在' });
    const orders = db.all('SELECT * FROM orders WHERE store_id=? AND customer_phone=? ORDER BY created_at DESC LIMIT 20',
      [storeId, c.phone]);
    res.json({ success: true, data: { ...c, orders: orders.map(o=>({...o, items: JSON.parse(o.items||'[]')})) } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { name='', phone, line_id='' } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: '電話為必填' });
    try {
      db.run('INSERT INTO customers (store_id,name,phone,line_id) VALUES (?,?,?,?)', [storeId, name, phone, line_id]);
      res.status(201).json({ success: true, data: db.get('SELECT * FROM customers WHERE store_id=? AND phone=?', [storeId, phone]) });
    } catch { res.status(409).json({ success: false, message: '電話號碼已存在' }); }
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
