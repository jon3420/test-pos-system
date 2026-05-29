// server.js — v16 整合版
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { initDb, getDb } = require('./utils/db');
const { getAllInventoryStatuses } = require('./utils/inventoryHelper');

const app  = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// WebSocketServer 必須共用同一個 HTTP server，不可自己 listen port
const wss = new WebSocketServer({ server, path: '/orders' });
app.set('wss', wss);

wss.on('error', (e) => console.error('[WSS] 錯誤:', e.message));
wss.on('connection', (ws, req) => {
  console.log('[WS] 新連線:', req.socket.remoteAddress);
  ws.send(JSON.stringify({ type: 'connected', time: new Date().toISOString() }));
  ws.on('close', () => console.log('[WS] 連線中斷'));
  ws.on('error', (e) => console.error('[WS] 錯誤:', e.message));
});

setInterval(() => {
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.ping(); });
}, 30000);

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/webhook/n8n', (req, res) => {
  console.log('[n8n Webhook]', JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: 'received', data: req.body });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '16.1.0' });
});

// Stats
app.get('/api/stats/today', (req, res) => {
  try {
    const db = getDb();
    const { date, date_from, date_to } = req.query;
    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const today = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
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
      JSON.parse(o.items||'[]').forEach(item => {
        if (!productMap[item.name]) productMap[item.name] = { name:item.name, qty:0, revenue:0 };
        productMap[item.name].qty += item.qty;
        productMap[item.name].revenue += item.subtotal;
      });
    });
    const top = Object.values(productMap).sort((a,b) => b.qty-a.qty).slice(0,5);
    // 使用統一 inventoryHelper 計算低庫存警示（含食材控管商品）
    const allStatuses = getAllInventoryStatuses(db);
    const lowStock = allStatuses
      .filter(s => s.available_units !== null && s.is_low_stock)
      .map(s => ({
        id:                    s.product_id,
        name:                  s.product_name,
        available_units:       s.available_units,
        available_grams:       s.available_grams,
        current_stock_grams:   s.available_grams,
        low_stock_alert:       s.low_stock_alert,
        is_formula_controlled: s.is_formula_controlled,
      }));
    res.json({ success: true, data: { ...stats, by_payment: byPayment, top_products: top, low_stock_alerts: lowStock } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 今日臨時休息自動清除（每小時檢查）──────────────────
function autoResetTodayClosed() {
  try {
    const db      = getDb();
    const twNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const todayStr = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
    const lastDate = db.get("SELECT value FROM settings WHERE key='line_today_closed_date'");
    if (lastDate && lastDate.value && lastDate.value !== todayStr) {
      db.run("UPDATE settings SET value='0' WHERE key='line_today_closed'");
      db.run(`UPDATE settings SET value='${todayStr}' WHERE key='line_today_closed_date'`);
      console.log('[AUTO] 今日臨時休息已自動重置');
    }
  } catch(e) { console.error('[AUTO] 重置失敗:', e.message); }
}
setInterval(autoResetTodayClosed, 60 * 60 * 1000);

initDb().then((db) => {
  // 啟動時執行一次
  autoResetTodayClosed();

  // ── 舊資料 Migration：修復 LINE 訂單 id 為 null / 空字串 ──
  try {
    // 優先用 uuid 補 id
    db.run(`UPDATE orders SET id = uuid
            WHERE (id IS NULL OR id = '')
              AND uuid IS NOT NULL AND uuid != ''`);
    // 沒有 uuid 的，用 order_number 補
    db.run(`UPDATE orders SET id = order_number
            WHERE (id IS NULL OR id = '')
              AND order_number IS NOT NULL AND order_number != ''`);
    const fixed = db.get("SELECT COUNT(*) as c FROM orders WHERE id IS NOT NULL AND id != ''");
    console.log(`[Migration] orders id 修復完成，有效訂單：${fixed?.c ?? 0} 筆`);
  } catch(e) { console.error('[Migration] id 修復失敗:', e.message); }

  // ── v18+ 授權系統 ─────────────────────────────────────────
  const { router: licenseRouter } = require('./routes/license');
  const { requireFeature } = require('./middleware/licenseGuard');
  app.use('/api/license', licenseRouter);

  app.use('/api/products',         require('./routes/products'));
  app.use('/api/orders',           require('./routes/orders'));
  app.use('/api/customers',        require('./routes/customers'));
  app.use('/api/settings',         require('./routes/settings'));
  app.use('/api/categories',       require('./routes/categories'));
  app.use('/api/platforms',        require('./routes/platforms'));
  app.use('/api/payment-methods',  require('./routes/payment-methods'));
  app.use('/api/payment-gateways', require('./routes/payment-gateways'));
  app.use('/api/print',            require('./routes/print'));
  app.use('/api/print-jobs',       require('./routes/printJobs'));
  app.use('/api/sync',             require('./routes/sync'));
  app.use('/api/kitchen',          require('./routes/kitchen'));
  // v16 新增：食材庫存管理（授權保護）
  app.use('/api/ingredients',      requireFeature('inventory'), require('./routes/ingredients'));

  // LINE 點餐系統（授權保護）
  const lineOrderRouter = require('./routes/line-orders');
  app.use('/api/line-shop',     requireFeature('line_order'), (req, res, next) => { req.url = '/shop'; lineOrderRouter(req, res, next); });
  app.use('/api/line-menu',     requireFeature('line_order'), (req, res, next) => { req.url = '/menu'; lineOrderRouter(req, res, next); });
  app.use('/api/line-orders',   requireFeature('line_order'), lineOrderRouter);
  // v18：直接掛載獨立的 online-orders 路由（不透過 line-orders 別名轉接）
  // 確保 PATCH /api/online-orders/:id/status 不會掉到 index.html fallback
  app.use('/api/online-orders', requireFeature('line_order'), require('./routes/online-orders'));

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
  app.use('/api/inventory', requireFeature('inventory'), invRouter);

  // ── importExport：分拆掛載，對 ingredient 相關 import/export 加授權保護 ──
  // 先掛受保護的 ingredient import/export（/api/import/ingredients 等）
  const importExportRouter = require('./routes/importExport');
  // 建立 middleware：只保護 ingredient / ingredient-formula 路徑
  const _guardIngredientImport = (req, res, next) => {
    const path = req.path; // e.g. /import/ingredients
    const needsGuard = /\/(import|export)\/ingredient/.test(path);
    if (needsGuard) {
      return requireFeature('inventory')(req, res, next);
    }
    next();
  };
  app.use('/api', _guardIngredientImport, importExportRouter);

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // 只呼叫一次 server.listen，WebSocketServer 共用同一個 server 不需另外 listen
  server.on('error', (e) => {
    if (e.code === 'EACCES') {
      console.error(`\n❌ 無法綁定 Port ${PORT}：${e.message}`);
      console.error(`   請換一個 Port：PORT=${Number(PORT)+1} npm start`);
    } else if (e.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} 已被佔用，請關閉佔用程式或換 Port`);
    } else {
      console.error('Server error:', e);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    const addr = server.address();
    console.log(`\n🍱 餐車 POS 系統 v16.1（Web 後台 + Android 同步 + LINE 點餐 + 食材管理）`);
    console.log(`📡 http://localhost:${addr.port}`);
    console.log(`🔌 WebSocket: ws://localhost:${addr.port}/orders\n`);
  });
}).catch(e => { console.error('DB 初始化失敗:', e); process.exit(1); });
