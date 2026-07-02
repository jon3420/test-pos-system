// server.js — POS SaaS Foundation R1
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { initDb, getDb } = require('./utils/db');
const { getAllInventoryStatuses } = require('./utils/inventoryHelper');
const { requireStore } = require('./middleware/storeGuard');
const { requireFeature, invalidateFeatureCache } = require('./middleware/featureGate');
const fetch = require('node-fetch'); // AI Marketing Center reverse proxy 用（沿用既有依賴，不新增套件）

const app  = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/orders' });
app.set('wss', wss);

// ── WebSocket 連線驗證（fix6：store_id 綁定）────────────────
// 支援：
//   ws://host/orders?token=<JWT>        （建議，前端帶 token）
//   ws://host/orders?store_id=store_001 （Android / LINE 相容）
//
// 驗證流程：
//   1. 解析 token 或 store_id
//   2. 查 stores 表確認存在且 active=1
//   3. ws.storeId = store_id（後續 broadcast 用於過濾）
//   4. 無效 → ws.close(4001, '...')，拒絕連線

wss.on('error', (e) => console.error('[WSS] 錯誤:', e.message));

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // 解析 URL query string
  const rawUrl = req.url || '';
  const qIdx   = rawUrl.indexOf('?');
  const qs     = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : new URLSearchParams();
  const token   = qs.get('token')    || '';
  const qStoreId = qs.get('store_id') || '';

  let resolvedStoreId = null;

  // 1. JWT token（最高優先）
  if (token) {
    try {
      const jwtLib  = require('jsonwebtoken');
      const { JWT_SECRET } = require('./middleware/storeGuard');
      const payload = jwtLib.verify(token, JWT_SECRET);
      if (payload.store_id && payload.role !== 'super_admin') {
        resolvedStoreId = payload.store_id;
      }
    } catch(e) {
      console.warn('[WSS] token 無效:', e.message);
    }
  }

  // 2. query store_id（Android / LINE 相容）
  if (!resolvedStoreId && qStoreId) {
    resolvedStoreId = qStoreId;
  }

  // 3. 預設 store_001（向後相容）
  if (!resolvedStoreId) {
    resolvedStoreId = 'store_001';
  }

  // 4. 驗證 stores 表（存在 + active=1）
  try {
    const { getDb } = require('./utils/db');
    const db    = getDb();
    const store = db.get('SELECT store_id, active FROM stores WHERE store_id=?', [resolvedStoreId]);
    if (!store || Number(store.active) !== 1) {
      console.warn(`[WSS] 拒絕連線 store="${resolvedStoreId}" (不存在或停用) ip=${ip}`);
      ws.close(4001, `店家 ${resolvedStoreId} 不存在或已停用`);
      return;
    }
  } catch(e) {
    // DB 尚未初始化時放行（極早期連線）
    console.warn('[WSS] store 驗證失敗，放行（DB 未就緒）:', e.message);
  }

  // 5. 綁定 store_id 到 ws 物件
  ws.storeId = resolvedStoreId;
  console.log(`[WSS] 新連線 store=${resolvedStoreId} ip=${ip}`);

  ws.send(JSON.stringify({ type: 'connected', store_id: resolvedStoreId, time: new Date().toISOString() }));
  ws.on('close', () => console.log(`[WSS] 斷線 store=${resolvedStoreId} ip=${ip}`));
  ws.on('error', (e) => console.error(`[WSS] 錯誤 store=${resolvedStoreId}:`, e.message));
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
  res.json({ status: 'ok', time: new Date().toISOString(), version: '18.0.0-saas-r1' });
});

// ── Stats（store-isolated）─────────────────────────────────
app.get('/api/stats/today', requireStore, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { date, date_from, date_to } = req.query;
    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const today = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
    let whereClause, whereParams;
    if (date_from && date_to) {
      whereClause = "store_id=? AND DATE(created_at)>=? AND DATE(created_at)<=?";
      whereParams = [storeId, date_from, date_to];
    } else {
      whereClause = "store_id=? AND DATE(created_at)=?";
      whereParams = [storeId, date || today];
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
    const allStatuses = getAllInventoryStatuses(db, storeId);
    const lowStock = allStatuses
      .filter(s => s.available_units !== null && s.is_low_stock)
      .map(s => ({
        id: s.product_id, name: s.product_name,
        available_units: s.available_units, available_grams: s.available_grams,
        current_stock_grams: s.available_grams, low_stock_alert: s.low_stock_alert,
        is_formula_controlled: s.is_formula_controlled,
      }));
    res.json({ success: true, data: { ...stats, by_payment: byPayment, top_products: top, low_stock_alerts: lowStock } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 今日臨時休息自動清除 ─────────────────────────────────
function autoResetTodayClosed() {
  try {
    const db = getDb();
    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const todayStr = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
    // 對所有 store 做自動重置
    const stores = db.all('SELECT store_id FROM stores WHERE active=1');
    stores.forEach(({ store_id }) => {
      const lastDate = db.get("SELECT value FROM settings WHERE store_id=? AND key='line_today_closed_date'", [store_id]);
      if (lastDate && lastDate.value && lastDate.value !== todayStr) {
        db.run("UPDATE settings SET value='0' WHERE store_id=? AND key='line_today_closed'", [store_id]);
        db.run(`UPDATE settings SET value='${todayStr}' WHERE store_id=? AND key='line_today_closed_date'`, [store_id]);
      }
    });
  } catch(e) { console.error('[AUTO] 重置失敗:', e.message); }
}

// ── LINE 今日可售份數每日重置（每天 00:05 台灣時間）──────
function autoResetLineQuota() {
  try {
    const db = getDb();
    const stores = db.all('SELECT store_id FROM stores WHERE active=1');
    stores.forEach(({ store_id }) => {
      db.run(
        `UPDATE products SET line_quota_sold=0, updated_at=datetime('now','localtime')
         WHERE store_id=? AND line_quota_enabled=1`,
        [store_id]
      );
    });
    console.log('[AUTO] LINE 今日可售份數已重置，共', stores.length, '家店');
  } catch(e) { console.error('[AUTO] LINE quota 重置失敗:', e.message); }
}

// 每小時執行（臨時店休重置）
setInterval(autoResetTodayClosed, 60 * 60 * 1000);

// 每天 00:05 台灣時間重置 LINE 份數
function scheduleDailyQuotaReset() {
  const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const nextMidnight = new Date(twNow);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 5, 0, 0); // 00:05
  const msUntil = nextMidnight - twNow;
  setTimeout(() => {
    autoResetLineQuota();
    setInterval(autoResetLineQuota, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`[AUTO] LINE 份數重置排程已設定，下次重置：${nextMidnight.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
}

initDb().then((db) => {
  autoResetTodayClosed();
  scheduleDailyQuotaReset();

  // ── Super Admin 總控台（獨立，不需 storeGuard）────────
  app.use('/api/super-admin', require('./routes/superAdmin'));

  // ── hotfix11/12 診斷 API：GET /api/debug/schema ──────────
  // 部署後呼叫此 API 可確認線上 SQLite schema 是否正確（無需登入）
  app.get('/api/debug/schema', (req, res) => {
    try {
      const db = getDb();
      const raw = db._db;

      function tableInfo(tbl) {
        const tableSql = (raw.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tbl}'`)?.[0]?.values?.[0]?.[0]) || null;
        const idxListRaw = (raw.exec(`PRAGMA index_list('${tbl}')`)?.[0]?.values) || [];
        const indexes = [];
        for (const r of idxListRaw) {
          const idxName = r[1];
          const isUnique = r[2] === 1;
          const cols = (raw.exec(`SELECT name FROM pragma_index_info('${idxName}')`)?.[0]?.values || []).map(v => v[0]);
          indexes.push({ name: idxName, unique: isUnique, columns: cols });
        }
        const hasNameOnly    = indexes.some(i => i.unique && i.columns.length === 1 && i.columns[0] === 'name');
        const hasStoreIdName = indexes.some(i => i.unique && i.columns.includes('store_id') && i.columns.includes('name'));
        const status         = hasNameOnly
          ? 'UNIQUE(name) 仍存在，跨店新增會失敗'
          : (hasStoreIdName ? 'UNIQUE(store_id,name) OK' : '無 unique index，請確認');
        return { table_sql: tableSql, indexes, diagnosis: { has_unique_name_only: hasNameOnly, has_unique_store_id_name: hasStoreIdName, status } };
      }

      res.json({
        success: true,
        version: require('./package.json').version,
        ingredients: tableInfo('ingredients'),
        delivery_platforms: tableInfo('delivery_platforms')
      });
    } catch(e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

    // ── 店家登入（公開，不需 storeGuard）─────────────────
  // POST /api/store-login        → 登入，取得 JWT
  // POST /api/store-login/set-password → Super Admin 設密碼（另需保護）

  app.use('/api/store-login', require('./routes/storeLogin'));

  // ── v18+ 授權系統（保持原有相容）────────────────────────
  const { router: licenseRouter } = require('./routes/license');
  // fix14: /api/admin/status removed (was using ADMIN_MODE env var)
  // License admin operations now protected by requireSuperAdmin in routes/license.js
  app.use('/api/license', licenseRouter);

  // ── 所有 POS API 套用 storeGuard ─────────────────────
  // requireStore 從 Bearer JWT / x-store-id header / query.store_id 解析 store_id
  // 向後相容：若無任何 store_id，預設 store_001
  // ── GET /api/store-me — 目前登入店家資訊 + features ─────────────
  app.get('/api/store-me', requireStore, (req, res) => {
    try {
      const db = require('./utils/db').getDb();
      const { getStoreFeatures } = require('./middleware/featureGate');
      const storeId = req.storeId || 'store_001';
      // fix16c: JOIN licenses 取得 plan — licenses.plan 為唯一方案來源
      const row = db.get(
        `SELECT s.store_id, s.store_name, s.active,
                COALESCE(l.plan, 'basic') AS plan
         FROM stores s
         LEFT JOIN licenses l ON l.store_id = s.store_id
         WHERE s.store_id = ?`,
        [storeId]
      );
      if (!row) return res.status(404).json({ success: false, message: '店家不存在' });
      const features = getStoreFeatures(storeId);
      res.json({
        success: true,
        data: {
          store_id:   row.store_id,
          store_name: row.store_name,
          plan:       row.plan,   // 來自 licenses.plan，stores.plan 不再使用
          active:     !!row.active,
          features,
        }
      });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  });

  app.use('/api/products',         requireStore, require('./routes/products'));
  app.use('/api/orders',           requireStore, require('./routes/orders'));
  app.use('/api/customers',        requireStore, require('./routes/customers'));
  app.use('/api/settings',         requireStore, require('./routes/settings'));
  app.use('/api/categories',       requireStore, require('./routes/categories'));
  app.use('/api/platforms',        requireStore, requireFeature('delivery'), require('./routes/platforms'));
  app.use('/api/payment-methods',  requireStore, requireFeature('payment_methods'), require('./routes/payment-methods'));
  app.use('/api/payment-gateways', requireStore, requireFeature('payment_api'), require('./routes/payment-gateways'));
  // LINE Pay v3 — 不需要 payment_api feature gate，/confirm 由 LINE 直接呼叫
  app.use('/api/linepay', requireStore, require('./routes/linepay'));
  // fix18-06: Google Maps proxy & delivery fee calculation
  app.use('/api/maps',     requireStore, require('./routes/maps'));
  app.use('/api/delivery', requireStore, require('./routes/delivery'));
  // fix18-06: 前端取得 Browser Key（只回傳 BROWSER KEY，絕不回傳 SERVER KEY）
  app.get('/api/config/maps-browser-key', requireStore, (req, res) => {
    const browserKey = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
    if (!browserKey) return res.status(503).json({ success: false, message: 'Google Maps Browser Key 未設定' });
    return res.json({ success: true, key: browserKey });
  });
  // fix18-05: 優惠券管理（Web 後台 CRUD + LINE validate）
  app.use('/api/coupons', requireStore, requireFeature('coupon'), require('./routes/coupons'));
  app.use('/api/discount-campaigns', requireStore, require('./routes/discount-campaigns'));
  app.use('/api/discount-categories', requireStore, require('./routes/discount-categories')); // fix18-09E
  app.use('/api/product-analysis-groups', requireStore, require('./routes/product-analysis-groups')); // fix18-09F
  // LINE Pay 相容路由別名（後台 webhook_url 預設為 /webhook/linepay）
  app.post('/webhook/linepay', (req, res, next) => {
    console.log('[linepay/webhook alias]', JSON.stringify(req.body).slice(0, 200));
    res.json({ returnCode: '0000', returnMessage: 'OK' });
  });
  app.get('/callback/linepay', (req, res) => {
    // LINE Pay confirm callback 別名
    const storeId = req.query.store_id || 'store_001';
    const { transactionId, orderId } = req.query;
    res.redirect(`/api/linepay/confirm?store_id=${storeId}&transactionId=${transactionId || ''}&orderId=${orderId || ''}`);
  });
  app.use('/api/print',            requireStore, require('./routes/print'));
  app.use('/api/print-jobs',       requireStore, require('./routes/printJobs'));
  app.use('/api/sync',             requireStore, require('./routes/sync'));
  app.use('/api/kitchen',          requireStore, require('./routes/kitchen'));
  app.use('/api/ingredients',      requireStore, requireFeature('inventory'), require('./routes/ingredients'));

  const lineOrderRouter = require('./routes/line-orders');
  app.use('/api/line-shop',    requireStore, requireFeature('line_order'), (req, res, next) => { req.url = '/shop'; lineOrderRouter(req, res, next); });
  app.use('/api/line-menu',    requireStore, requireFeature('line_order'), (req, res, next) => { req.url = '/menu'; lineOrderRouter(req, res, next); });
  // v1 新增：時段查詢 & 加入購物車驗證
  app.use('/api/line-timeslots',    requireStore, requireFeature('line_order'), (req, res, next) => { req.url = '/timeslots'; lineOrderRouter(req, res, next); });
  app.use('/api/line-validate-cart', requireStore, requireFeature('line_order'), (req, res, next) => { req.url = '/validate-cart'; lineOrderRouter(req, res, next); });
  app.use('/api/line-orders',  requireStore, requireFeature('line_order'), lineOrderRouter);
  app.use('/api/online-orders', requireStore, requireFeature('line_order'), require('./routes/online-orders'));

  // ── 老闆儀表板 Dashboard API（reports feature gate）─────
  app.use('/api/dashboard', requireStore, requireFeature('reports'), require('./routes/dashboard'));

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
  app.use('/api/inventory', requireStore, requireFeature('inventory'), invRouter);

  // importExport — inventory endpoints wrapped with featureGate inside the router
  // (full route handled inside importExport.js with inline checks)
  app.use('/api', requireStore, require('./routes/importExport'));
  app.use('/api', requireStore, require('./routes/migration')); // fix18-10

  // ── AI Marketing Center（新增，獨立服務，反向代理）──────────
  // AIMC 是完全獨立的 Node.js 服務 + 獨立 PostgreSQL，這裡只做：
  //   1. 沿用既有 requireStore 解析/驗證 store_id
  //   2. 沿用既有 requireFeature('ai_marketing') 做功能開關（預設 false，不影響現有店家）
  //   3. 轉送請求給 AIMC_SERVICE_URL，帶上 x-store-id + 內部信任密鑰
  //   4.（Phase 3 新增）帶上 x-store-context：從 POS 自己的 stores/settings 表
  //      組出品牌資料（店名/電話/地址/社群連結/語氣/CTA），base64 編碼後放進 header，
  //      讓 AIMC 服務能把「brand.name」換成真正的品牌名稱，而不是 store_id 裸字串。
  //      這一步失敗（例如 DB 讀取異常）不可讓整個 proxy 掛掉，退回不帶這個 header 即可，
  //      AIMC 端本來就有 fallback。
  // AIMC 服務離線時只影響 /api/ai-marketing/* ，不影響任何既有 POS API。
  const AIMC_SERVICE_URL = process.env.AIMC_SERVICE_URL || 'http://localhost:4100';
  const INTERNAL_PROXY_SECRET = process.env.INTERNAL_PROXY_SECRET || 'change-me-to-a-random-secret';

  function buildStoreContextHeader(storeId) {
    try {
      const { getDb } = require('./utils/db');
      const db = getDb();
      const store = db.get('SELECT store_name, phone FROM stores WHERE store_id=?', [storeId]);
      const rows = db.all(
        `SELECT key, value FROM settings WHERE store_id=? AND key IN (
           'shop_name','shop_address','shop_hours','shop_announcement',
           'shop_slogan','shop_line_url','shop_facebook_url','shop_instagram_url',
           'brand_tone','brand_cta_template'
         )`,
        [storeId]
      );
      const s = {};
      rows.forEach(r => { s[r.key] = r.value; });

      const ctx = {
        store_name: s.shop_name || store?.store_name || null,
        phone: store?.phone || null,
        address: s.shop_address || null,
        business_hours: s.shop_hours || null,
        description: s.shop_announcement || null,
        slogan: s.shop_slogan || null,
        line_url: s.shop_line_url || null,
        facebook_url: s.shop_facebook_url || null,
        instagram_url: s.shop_instagram_url || null,
        brand_tone: s.brand_tone || null,
        cta_template: s.brand_cta_template || null,
      };
      return Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64');
    } catch (e) {
      console.warn('[aimcProxy] buildStoreContextHeader 失敗，略過（不影響請求）:', e.message);
      return null;
    }
  }

  async function aimcProxy(req, res) {
    try {
      const targetPath = req.originalUrl.replace(/^\/api\/ai-marketing/, '') || '/';
      const targetUrl  = AIMC_SERVICE_URL + targetPath;
      const headers = {
        'Content-Type':      'application/json',
        'x-internal-secret': INTERNAL_PROXY_SECRET,
        'x-store-id':        req.storeId,
      };
      const storeContext = buildStoreContextHeader(req.storeId);
      if (storeContext) headers['x-store-context'] = storeContext;
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = JSON.stringify(req.body || {});
      }
      const upstream = await fetch(targetUrl, init);
      const text = await upstream.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { success:false, message:'AIMC 回傳格式錯誤' }; }
      res.status(upstream.status).json(data);
    } catch (e) {
      console.error('[aimcProxy] 連線 AIMC 服務失敗:', e.message);
      res.status(502).json({ success:false, error:'AIMC_UNAVAILABLE', message:'AI 行銷中心服務暫時無法連線，請稍後再試' });
    }
  }

  app.use('/api/ai-marketing', requireStore, requireFeature('ai_marketing'), aimcProxy);

  // ── Super Admin 前端入口（/system-admin 獨立路由）────
  app.get('/system-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'system-admin.html')));
  app.get('/system-admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'system-admin.html')));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  server.on('error', (e) => {
    if (e.code === 'EACCES') {
      console.error(`\n❌ 無法綁定 Port ${PORT}：${e.message}`);
    } else if (e.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} 已被佔用`);
    } else {
      console.error('Server error:', e);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    const addr = server.address();
    console.log(`\n🍱 POS SaaS Foundation R1`);
    console.log(`📡 POS: http://localhost:${addr.port}`);
    console.log(`🔐 Super Admin: http://localhost:${addr.port}/system-admin`);
    console.log(`🔌 WebSocket: ws://localhost:${addr.port}/orders\n`);
  });
}).catch(e => { console.error('DB 初始化失敗:', e); process.exit(1); });
