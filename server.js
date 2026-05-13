// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { initDb, getDb } = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/webhook/n8n', (req, res) => {
  console.log('[n8n Webhook]', JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: 'received', data: req.body });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.1.0' });
});

// Stats — 支援 ?date= 單日 或 ?date_from=&date_to= 區間
app.get('/api/stats/today', (req, res) => {
  try {
    const db = getDb();
    const { date, date_from, date_to } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let whereClause, whereParams;
    if (date_from && date_to) {
      whereClause = "DATE(created_at)>=? AND DATE(created_at)<=?";
      whereParams = [date_from, date_to];
    } else {
      whereClause = "DATE(created_at)=?";
      whereParams = [date || today];
    }
    const notVoid = `AND status != 'void'`;

    const stats = db.get(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_revenue, COALESCE(AVG(total),0) as avg_order FROM orders WHERE ${whereClause} ${notVoid}`,
      whereParams
    );
    const byPayment = db.all(
      `SELECT payment_method, COUNT(*) as count, SUM(total) as revenue FROM orders WHERE ${whereClause} ${notVoid} GROUP BY payment_method`,
      whereParams
    );
    const allOrders = db.all(`SELECT items FROM orders WHERE ${whereClause} ${notVoid}`, whereParams);
    const productMap = {};
    allOrders.forEach(o => {
      JSON.parse(o.items).forEach(item => {
        if (!productMap[item.name]) productMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
        productMap[item.name].qty += item.qty;
        productMap[item.name].revenue += item.subtotal;
      });
    });
    const top = Object.values(productMap).sort((a,b) => b.qty - a.qty).slice(0, 5);

    // Low stock alert
    const lowStock = db.all(
      "SELECT id,name,current_stock_grams,allocated_grams,low_stock_alert FROM products WHERE inventory_enabled=1 AND allocated_grams>0 AND (current_stock_grams/allocated_grams)<=low_stock_alert"
    ).map(p => ({
      ...p,
      available_units: Math.floor(p.current_stock_grams / p.allocated_grams)
    }));

    res.json({ success: true, data: { ...stats, by_payment: byPayment, top_products: top, low_stock_alerts: lowStock } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

initDb().then(() => {
  app.use('/api/products',         require('./routes/products'));
  app.use('/api/orders',           require('./routes/orders'));
  app.use('/api/customers',        require('./routes/customers'));
  app.use('/api/settings',         require('./routes/settings'));
  app.use('/api/categories',       require('./routes/categories'));
  app.use('/api/platforms',        require('./routes/platforms'));
  app.use('/api/payment-methods',  require('./routes/payment-methods'));
  app.use('/api/payment-gateways', require('./routes/payment-gateways'));
  app.use('/api/print',            require('./routes/print'));
  // 獨立的 printers 路由（GET /api/printers/list）
  app.get('/api/printers/list', async (req, res) => {
    try {
      const ps   = require('./services/printService');
      const list = await ps.getWindowsPrinters();
      res.json({ success: true, data: list });
    } catch(e) {
      res.json({ success: false, data: [], message: e.message });
    }
  });
  const { router: invRouter } = require('./routes/inventory');
  app.use('/api/inventory',        invRouter);

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => {
    console.log(`\n🍱 餐車 POS 系統 v1.2 已啟動`);
    console.log(`📡 http://localhost:${PORT}\n`);
  });
}).catch(e => { console.error('DB 初始化失敗:', e); process.exit(1); });
