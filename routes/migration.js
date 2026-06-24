// routes/migration.js — fix18-10-hotfix4
//
// fix18-10-hotfix4 新增修正：
//
// BUG-1: 跨店匯入被誤判重複 → store_02 全部跳過
//   根因：orders.id TEXT PRIMARY KEY 直接使用 order_number，
//         store_001 與 store_02 有相同 order_number 時 INSERT OR IGNORE
//         因 PK 衝突被靜默忽略，即使 store_id 不同。
//   修正：匯入時不再依賴 INSERT OR IGNORE 做去重；
//         改用 SELECT COUNT(*) WHERE store_id=? AND order_number=? 明確判斷。
//         若不存在：INSERT（id 改為 storeId + '_' + order_number 防 PK 衝突）。
//         skip 模式：只跳過「本店 store_id 已有相同 order_number」的資料。
//         overwrite 模式：只 UPDATE 本店資料，不影響其他店。
//         copy 模式：新 order_number 屬於本店。
//
// BUG-2: order_logs 固定寫 old_value/new_value 欄位，但該表無此欄位
//   修正：PRAGMA table_info(order_logs) 動態取得欄位，只 INSERT 實際存在的欄位。
//
// 沿用 fix18-10-hotfix3 的修正：
// RC-1: 回傳 date_range，前端提示切換日期範圍
// RC-2: ensureTable 先建 discount 表
// RC-3: rawRunCount 確認實際寫入
// RC-4: PRAGMA 動態過濾欄位（orders）

'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── CSV helpers ──────────────────────────────────────────────────────────────
function toCsvCell(v) {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsvRow(arr)        { return arr.map(toCsvCell).join(','); }
function toCsv(headers, rows) {
  return [toCsvRow(headers),
    ...rows.map(r => toCsvRow(headers.map(h => r[h] ?? '')))
  ].join('\n');
}
const BOM = '\uFEFF';

// ── Timestamp ────────────────────────────────────────────────────────────────
function tsFile() {
  const d = new Date(), p = (n, l=2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function isoNow() { return new Date().toISOString(); }

// ── migration_logs ───────────────────────────────────────────────────────────
function ensureMigrationLogs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL, action TEXT NOT NULL,
    file_name TEXT DEFAULT '', mode TEXT DEFAULT '',
    summary_json TEXT DEFAULT '{}', status TEXT DEFAULT 'success',
    error_message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
}
function writeMigrationLog(db, storeId, action, fileName, mode, summary, status, errMsg) {
  try {
    ensureMigrationLogs(db);
    db.run(
      `INSERT INTO migration_logs (store_id,action,file_name,mode,summary_json,status,error_message)
       VALUES (?,?,?,?,?,?,?)`,
      [storeId, action, fileName||'', mode||'', JSON.stringify(summary||{}), status||'success', errMsg||'']
    );
  } catch(e) { console.error('[migration_log]', e.message); }
}

// ── safe read wrappers ───────────────────────────────────────────────────────
function safeAll(db, sql, params) {
  try { return db.all(sql, params); } catch { return []; }
}
function safeGet(db, sql, params) {
  try { return db.get(sql, params); } catch { return null; }
}

// ── ensure discount tables (on-demand, same as their respective routes) ──────
function ensureDiscountCategoriesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discount_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL DEFAULT 'store_001',
      code TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#94a3b8',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_discount_categories_store ON discount_categories(store_id);
  `);
}
function ensureDiscountCampaignsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discount_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL DEFAULT 'store_001',
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_discount_campaigns_store ON discount_campaigns(store_id);
  `);
}

// ── PRAGMA: get actual column names for a table ──────────────────────────────
function getTableCols(db, table) {
  try {
    const rows = db.all(`PRAGMA table_info(${table})`);
    return new Set(rows.map(r => r.name));
  } catch { return new Set(); }
}

// ════════════════════════════════════════════════════════════════════════════
//  rawRun — 在 transaction 內執行，不呼叫 save()/export()
// ════════════════════════════════════════════════════════════════════════════
function rawRun(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
}

// rawRun 並回傳實際影響列數（用 getRowsModified）
function rawRunCount(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
  return raw.getRowsModified ? raw.getRowsModified() : 1;
}

// ════════════════════════════════════════════════════════════════════════════
//  runInTransaction — BEGIN → fn(raw) → COMMIT → db._save()
// ════════════════════════════════════════════════════════════════════════════
function runInTransaction(db, fn) {
  const raw = db._db;
  raw.run('BEGIN');
  try {
    fn(raw);
    raw.run('COMMIT');
    db._save();
  } catch(e) {
    try { raw.run('ROLLBACK'); } catch {}
    throw e;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  訂單匯出  GET /api/export/orders
// ════════════════════════════════════════════════════════════════════════════
router.get('/export/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const format  = String(req.query.format || 'json').toLowerCase();
    const scope   = req.query.scope || 'all';
    const dFrom   = req.query.date_from || '';
    const dTo     = req.query.date_to   || '';

    let sql = 'SELECT * FROM orders WHERE store_id=?';
    const args = [storeId];
    if (scope === 'filtered' && dFrom && dTo) {
      sql += ' AND date(created_at) >= ? AND date(created_at) <= ?';
      args.push(dFrom, dTo);
    }
    sql += ' ORDER BY created_at DESC';

    const orders = safeAll(db, sql, args);

    // 展開 items JSON（本專案無獨立 order_items 表）
    const orderItemsExpanded = [];
    for (const o of orders) {
      try {
        const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
        if (Array.isArray(items)) {
          items.forEach((it, idx) => orderItemsExpanded.push({
            order_id: o.id||o.order_number, order_number: o.order_number,
            seq: idx+1, product_id: it.id||it.product_id||'',
            product_name: it.name||it.product_name||'',
            qty: it.qty||it.quantity||1, price: it.price||it.unit_price||0,
            subtotal: (it.price||0)*(it.qty||1)
          }));
        }
      } catch {}
    }

    const orderIds = orders.map(o => o.id||o.order_number).filter(Boolean);
    const orderLogs = [];
    for (let i = 0; i < orderIds.length; i += 200) {
      const chunk = orderIds.slice(i, i+200);
      const ph = chunk.map(()=>'?').join(',');
      try { orderLogs.push(...db.all(`SELECT * FROM order_logs WHERE order_id IN (${ph})`, chunk)); } catch {}
    }

    const ts = tsFile(), fileName = `orders_${ts}.${format}`;
    writeMigrationLog(db, storeId, '匯出訂單', fileName, format,
      { orders: orders.length, order_items_expanded: orderItemsExpanded.length }, 'success', '');

    if (format === 'csv') {
      const headers = ['id','order_number','store_id','order_mode','source',
        'customer_name','customer_phone','payment_method','payment_category',
        'subtotal','total','discount_amount','discount_category',
        'discount_campaign_id','discount_campaign_name','discount_product_ids','discount_product_names',
        'status','order_status','note','pickup_name','pickup_time',
        'delivery_platform','delivery_address','delivery_status',
        'platform_commission_rate','platform_commission_amount','store_actual_income',
        'delivery_fee','created_at','updated_at'];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(BOM + toCsv(headers, orders));
    }

    const payload = { type:'orders_backup', version:'fix18-10-hotfix4',
      exported_at: isoNow(), store_id: storeId,
      data: { orders, order_items: orderItemsExpanded, order_logs: orderLogs } };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  訂單匯入  POST /api/import/orders
//  RC-1 修正：回傳 date_range 讓前端提示使用者切換日期
//  RC-3 修正：用 rawRunCount 確認實際寫入，INSERT OR IGNORE 未寫則計 skipped
// ════════════════════════════════════════════════════════════════════════════
router.post('/import/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { orders = [], mode = 'skip' } = req.body;
    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];
    let minDate = '', maxDate = '';

    // PRAGMA 動態欄位過濾
    const validCols = getTableCols(db, 'orders');

    // 只 INSERT 實際存在的欄位
    const importCols = [
      'id','order_number','store_id','customer_name','customer_phone','customer_line_id',
      'items','payment_method','payment_category','subtotal','total',
      'status','order_status','order_mode','source',
      'received_amount','change_amount','note',
      'void_reason','voided_at','table_number','guest_count',
      'pickup_name','pickup_time','delivery_platform','delivery_address','estimated_delivery',
      'delivery_status','delivery_fee','platform_commission_rate','platform_commission_amount',
      'store_actual_income','platform_order_no',
      'discount_amount','discount_type','discount_category','discount_note','original_total',
      'discount_campaign_id','discount_campaign_name','discount_target_type',
      'discount_product_id','discount_product_name','discount_product_ids','discount_product_names',
      'kitchen_status','payment_status','uuid','sync_status','device_id',
      'created_at','updated_at'
    ].filter(c => validCols.has(c));

    const phs = importCols.map(()=>'?').join(',');

    function buildVals(o, sid) {
      const items_ = typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]);
      // BUG-1 修正：id 加入 storeId 前綴，避免跨店 PK 衝突
      const safeId = sid + '_' + (o.order_number||o.id||'');
      const map = {
        id: safeId, order_number: o.order_number, store_id: sid,
        customer_name: o.customer_name||'', customer_phone: o.customer_phone||'',
        customer_line_id: o.customer_line_id||'',
        items: items_, payment_method: o.payment_method||'cash',
        payment_category: o.payment_category||'cash',
        subtotal: o.subtotal||0, total: o.total||0,
        status: o.status||'completed', order_status: o.order_status||'completed',
        order_mode: o.order_mode||'dine_in', source: o.source||'pos',
        received_amount: o.received_amount||0, change_amount: o.change_amount||0,
        note: o.note||'', void_reason: o.void_reason||'', voided_at: o.voided_at||'',
        table_number: o.table_number||'', guest_count: o.guest_count||0,
        pickup_name: o.pickup_name||'', pickup_time: o.pickup_time||'',
        delivery_platform: o.delivery_platform||'', delivery_address: o.delivery_address||'',
        estimated_delivery: o.estimated_delivery||'', delivery_status: o.delivery_status||'',
        delivery_fee: o.delivery_fee||0,
        platform_commission_rate: o.platform_commission_rate||0,
        platform_commission_amount: o.platform_commission_amount||0,
        store_actual_income: o.store_actual_income||0, platform_order_no: o.platform_order_no||'',
        discount_amount: o.discount_amount||0, discount_type: o.discount_type||'none',
        discount_category: o.discount_category||'none', discount_note: o.discount_note||'',
        original_total: o.original_total||o.total||0,
        discount_campaign_id: o.discount_campaign_id||null,
        discount_campaign_name: o.discount_campaign_name||'',
        discount_target_type: o.discount_target_type||'order',
        discount_product_id: o.discount_product_id||'',
        discount_product_name: o.discount_product_name||'',
        discount_product_ids: o.discount_product_ids||'',
        discount_product_names: o.discount_product_names||'',
        kitchen_status: o.kitchen_status||'pending', payment_status: o.payment_status||'paid',
        uuid: o.uuid||safeId, sync_status: o.sync_status||'synced',
        device_id: o.device_id||'',
        created_at: o.created_at||'', updated_at: o.updated_at||''
      };
      return importCols.map(c => map[c] ?? null);
    }

    runInTransaction(db, (raw) => {
      for (const o of orders) {
        const orderNo = (o.order_number||'').trim();
        if (!orderNo) { failed++; continue; }
        const d = (o.created_at||'').slice(0,10);
        if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }
        try {
          const existing = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);

          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              // UPDATE 只更新存在的欄位
              const updCols = importCols.filter(c => !['id','order_number','store_id'].includes(c));
              const updSql = `UPDATE orders SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND order_number=?`;
              const updMap = { ...Object.fromEntries(importCols.map((c,i)=>[c, buildVals(o,storeId)[i]])) };
              const updVals = [...updCols.map(c=>updMap[c]??null), storeId, orderNo];
              const n = rawRunCount(raw, updSql, updVals);
              if (n > 0) updated++; else skipped++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              const v = buildVals({ ...o, order_number: newNo }, storeId);
              const n = rawRunCount(raw, `INSERT OR REPLACE INTO orders (${importCols.join(',')}) VALUES (${phs})`, v);
              if (n > 0) added++; else skipped++;
            }
          } else {
            const v = buildVals(o, storeId);
            // BUG-1 修正：id 已含 storeId 前綴，用 OR REPLACE 確保寫入
            const n = rawRunCount(raw, `INSERT OR REPLACE INTO orders (${importCols.join(',')}) VALUES (${phs})`, v);
            if (n > 0) added++; else skipped++;
          }
        } catch(e2) { errors.push(`order ${orderNo}: ${e2.message}`); failed++; }
      }
    });

    const summary = { added, updated, skipped, failed, date_range: { min: minDate, max: maxDate } };
    writeMigrationLog(db, storeId, '匯入訂單', '', mode, summary,
      failed > 0 ? 'partial' : 'success', errors.slice(0,5).join('; '));
    res.json({ success: true, ...summary, errors: errors.slice(0, 20) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  LINE 預購匯出  GET /api/export/preorders
// ════════════════════════════════════════════════════════════════════════════
router.get('/export/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const format  = String(req.query.format || 'json').toLowerCase();
    const dFrom   = req.query.date_from || '';
    const dTo     = req.query.date_to   || '';

    let sql = `SELECT * FROM orders WHERE store_id=? AND source='line'`;
    const args = [storeId];
    if (dFrom && dTo) {
      sql += ' AND date(created_at) >= ? AND date(created_at) <= ?';
      args.push(dFrom, dTo);
    }
    sql += ' ORDER BY created_at DESC';

    const preorders = safeAll(db, sql, args);
    const ts = tsFile(), fileName = `preorders_${ts}.${format}`;
    writeMigrationLog(db, storeId, '匯出預購', fileName, format,
      { preorders: preorders.length }, 'success', '');

    if (format === 'csv') {
      const headers = ['id','order_number','store_id','source','customer_name','customer_phone',
        'order_mode','items','payment_method','subtotal','total',
        'status','order_status','note','pickup_name','pickup_time','created_at'];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(BOM + toCsv(headers, preorders));
    }
    const payload = { type:'preorders_backup', version:'fix18-10-hotfix4',
      exported_at: isoNow(), store_id: storeId, data: { preorders } };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  LINE 預購匯入  POST /api/import/preorders
// ════════════════════════════════════════════════════════════════════════════
router.post('/import/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { preorders = [], mode = 'skip' } = req.body;
    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];

    runInTransaction(db, (raw) => {
      for (const o of preorders) {
        const orderNo = (o.order_number||'').trim();
        if (!orderNo) { failed++; continue; }
        const items_ = typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]);
        try {
          const existing = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);
          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              const n = rawRunCount(raw,
                `UPDATE orders SET customer_name=?,customer_phone=?,order_mode=?,source='line',
                   items=?,payment_method=?,subtotal=?,total=?,status=?,order_status=?,
                   note=?,pickup_name=?,pickup_time=?,created_at=?,updated_at=datetime('now','localtime')
                 WHERE store_id=? AND order_number=?`,
                [o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout',
                 items_,o.payment_method||'line_pay',o.subtotal||o.total||0,o.total||0,
                 o.status||'pending',o.order_status||'pending',
                 o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'',storeId,orderNo]);
              if (n > 0) updated++; else skipped++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              const n = rawRunCount(raw,
                `INSERT OR IGNORE INTO orders
                   (id,order_number,store_id,customer_name,customer_phone,order_mode,source,
                    items,payment_method,subtotal,total,status,order_status,note,pickup_name,pickup_time,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [newNo,newNo,storeId,o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
                 items_,o.payment_method||'line_pay',o.subtotal||o.total||0,o.total||0,
                 o.status||'pending',o.order_status||'pending',o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'']);
              if (n > 0) added++; else skipped++;
            }
          } else {
            const id = o.id||o.order_number;
            const n = rawRunCount(raw,
              `INSERT OR IGNORE INTO orders
                 (id,order_number,store_id,customer_name,customer_phone,order_mode,source,
                  items,payment_method,subtotal,total,status,order_status,note,pickup_name,pickup_time,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [id,orderNo,storeId,o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
               items_,o.payment_method||'line_pay',o.subtotal||o.total||0,o.total||0,
               o.status||'pending',o.order_status||'pending',o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'']);
            if (n > 0) added++; else skipped++;
          }
        } catch(e2) { errors.push(`preorder ${orderNo}: ${e2.message}`); failed++; }
      }
    });

    const summary = { added, updated, skipped, failed };
    writeMigrationLog(db, storeId, '匯入預購', '', mode, summary,
      failed > 0 ? 'partial' : 'success', errors.slice(0,5).join('; '));
    res.json({ success: true, ...summary, errors: errors.slice(0, 20) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯出  GET /api/migration/export
//  RC-2 修正：先 ensureTable 再查詢 discount 資料表
// ════════════════════════════════════════════════════════════════════════════
router.get('/migration/export', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    // RC-2 修正：確保 discount 表存在後再查詢
    try { ensureDiscountCategoriesTable(db); } catch {}
    try { ensureDiscountCampaignsTable(db); } catch {}

    const storeRow   = safeGet(db, 'SELECT * FROM stores WHERE store_id=?', [storeId]);
    const products   = safeAll(db, 'SELECT * FROM products   WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const categories = safeAll(db, 'SELECT * FROM categories WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const orders     = safeAll(db, 'SELECT * FROM orders WHERE store_id=? ORDER BY created_at ASC', [storeId]);

    const orderIds = orders.map(o => o.id||o.order_number).filter(Boolean);
    const orderLogs = [];
    for (let i = 0; i < orderIds.length; i += 200) {
      const chunk = orderIds.slice(i, i+200);
      const ph = chunk.map(()=>'?').join(',');
      try { orderLogs.push(...db.all(`SELECT * FROM order_logs WHERE order_id IN (${ph})`, chunk)); } catch {}
    }

    const preorderNums = orders.filter(o => o.source === 'line').map(o => o.order_number);

    const lineProducts = products.map(p => ({
      product_id: p.id, name: p.name, category: p.category,
      show_on_line: p.show_on_line, line_price: p.line_price,
      line_description: p.line_description, line_image_url: p.line_image_url,
      line_category: p.line_category, line_hot: p.line_hot,
      line_promo: p.line_promo, line_sold_out: p.line_sold_out,
      line_preorder_enabled: p.line_preorder_enabled,
      line_preorder_daily: p.line_preorder_daily,
      line_preorder_sold: p.line_preorder_sold,
      line_preorder_low_threshold: p.line_preorder_low_threshold,
      line_preorder_high_threshold: p.line_preorder_high_threshold
    }));

    const inventory = safeAll(db, 'SELECT * FROM inventory WHERE store_id=?', [storeId]);

    // RC-2 修正：精確欄位查詢（ensureTable 後表必定存在）
    const discountCategories = safeAll(db,
      'SELECT id,store_id,code,name,icon,color,enabled,sort_order,created_at FROM discount_categories WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    const discountCampaigns = safeAll(db,
      'SELECT id,store_id,name,description,enabled,sort_order,created_at FROM discount_campaigns WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    // analysis 表在 db.js 建立（startup 時必定存在）
    const analysisGroups = safeAll(db,
      'SELECT id,store_id,group_name,description,enabled,sort_order,created_at,updated_at FROM product_analysis_groups WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    const analysisItems = analysisGroups.length
      ? safeAll(db,
          `SELECT i.id,i.store_id,i.group_id,i.product_id,i.product_name,i.created_at
           FROM product_analysis_group_items i
           INNER JOIN product_analysis_groups g ON g.id=i.group_id
           WHERE g.store_id=? ORDER BY i.group_id ASC, i.id ASC`, [storeId])
      : [];

    const analysisAliases = analysisGroups.length
      ? safeAll(db,
          `SELECT a.id,a.store_id,a.group_id,a.alias_name,a.created_at
           FROM product_analysis_group_aliases a
           INNER JOIN product_analysis_groups g ON g.id=a.group_id
           WHERE g.store_id=? ORDER BY a.group_id ASC, a.id ASC`, [storeId])
      : [];

    const deliveryPlatforms = safeAll(db, 'SELECT * FROM delivery_platforms WHERE store_id=?', [storeId]);
    const deliveryFees      = safeAll(db, 'SELECT * FROM delivery_fees      WHERE store_id=?', [storeId]);
    const settings          = safeAll(db, 'SELECT * FROM settings WHERE store_id=?', [storeId]);

    const ts = tsFile(), fileName = `pos_migration_${storeId}_${ts}.json`;

    const payload = {
      type: 'pos_migration_backup', version: 'fix18-10-hotfix4',
      exported_at: isoNow(), store_id: storeId,
      store_name: storeRow ? (storeRow.name||storeRow.store_id||storeId) : storeId,
      schema_version: 2,
      data: {
        products, categories, orders,
        order_items: [],   // 無獨立表
        order_logs: orderLogs,
        preorder_order_numbers: preorderNums,
        line_products: lineProducts,
        inventory,
        discount_categories:            discountCategories,
        discount_campaigns:             discountCampaigns,
        product_analysis_groups:        analysisGroups,
        product_analysis_group_items:   analysisItems,
        product_analysis_group_aliases: analysisAliases,
        delivery_platforms: deliveryPlatforms,
        delivery_fees:      deliveryFees,
        settings
      }
    };

    const summary = {
      products: products.length, categories: categories.length,
      orders: orders.length, preorders: preorderNums.length,
      order_logs: orderLogs.length,
      discount_categories: discountCategories.length,
      discount_campaigns: discountCampaigns.length,
      analysis_groups: analysisGroups.length,
      analysis_items: analysisItems.length,
      analysis_aliases: analysisAliases.length,
      settings: settings.length
    };

    writeMigrationLog(db, storeId, '匯出快速搬家檔', fileName, 'export', summary, 'success', '');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) {
    console.error('[migration/export]', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  Preview  POST /api/migration/import/preview
// ════════════════════════════════════════════════════════════════════════════
router.post('/migration/import/preview', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const payload = req.body;

    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    const fileStoreId = payload.store_id || '';
    const crossStore  = !!(fileStoreId && fileStoreId !== storeId);
    const d = payload.data || {};

    // 訂單日期範圍（讓前端提示）
    const allDates = (d.orders||[]).map(o => (o.created_at||'').slice(0,10)).filter(Boolean).sort();
    const dateRange = allDates.length
      ? { min: allDates[0], max: allDates[allDates.length-1] }
      : null;

    const summary = {
      products:                      (d.products                     || []).length,
      categories:                    (d.categories                   || []).length,
      orders:                        (d.orders                       || []).length,
      order_logs:                    (d.order_logs                   || []).length,
      preorders:                     (d.orders||[]).filter(o=>o.source==='line').length,
      discount_categories:           (d.discount_categories          || []).length,
      discount_campaigns:            (d.discount_campaigns           || []).length,
      product_analysis_groups:       (d.product_analysis_groups      || []).length,
      product_analysis_group_items:  (d.product_analysis_group_items || []).length,
      product_analysis_group_aliases:(d.product_analysis_group_aliases||[]).length,
      settings:                      (d.settings                     || []).length
    };

    res.json({
      success: true,
      file_store_id: fileStoreId, current_store_id: storeId,
      cross_store: crossStore,
      version: payload.version||'', exported_at: payload.exported_at||'',
      store_name: payload.store_name||'',
      date_range: dateRange,
      summary
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯入  POST /api/migration/import
//  RC-2 修正：先 ensureTable，再匯入 discount 資料
//  RC-3 修正：用 rawRunCount 確認實際寫入
//  RC-4 修正：PRAGMA 動態過濾欄位
// ════════════════════════════════════════════════════════════════════════════
router.post('/migration/import', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { payload, mode = 'skip', allowCrossStoreImport = false } = req.body;

    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    const fileStoreId  = payload.store_id || storeId;
    const isCrossStore = fileStoreId !== storeId;
    if (isCrossStore && !allowCrossStoreImport) {
      return res.status(403).json({
        success: false, cross_store: true, file_store_id: fileStoreId,
        message: `備份檔屬於 ${fileStoreId}，目前店家是 ${storeId}。跨店匯入需使用者明確確認。`
      });
    }

    // RC-2：確保 discount 表存在
    try { ensureDiscountCategoriesTable(db); } catch {}
    try { ensureDiscountCampaignsTable(db); } catch {}

    const d = payload.data || {};
    const results = {
      categories:0, products:0, orders:0, order_logs:0,
      discount_categories:0, discount_campaigns:0,
      analysis_groups:0, analysis_items:0, analysis_aliases:0,
      settings:0, delivery_platforms:0, delivery_fees:0,
      skipped:0, failed:0, errors:[]
    };

    const orMode = (mode === 'overwrite') ? 'OR REPLACE' : 'OR IGNORE';

    // PRAGMA: 動態取 orders 欄位
    const orderCols = getTableCols(db, 'orders');

    runInTransaction(db, (raw) => {

      // ── replace：只清本店 ────────────────────────────────────────────────
      if (mode === 'replace') {
        const purge = ['orders','products','categories',
          'discount_categories','discount_campaigns',
          'product_analysis_group_items','product_analysis_group_aliases',
          'product_analysis_groups','inventory'];
        for (const t of purge) {
          try { rawRun(raw, `DELETE FROM ${t} WHERE store_id=?`, [storeId]); } catch(e) {
            console.warn(`[replace] DELETE ${t}:`, e.message);
          }
        }
        try {
          const ids = safeAll(db,'SELECT id FROM orders WHERE store_id=?',[storeId]).map(r=>r.id);
          for (let i=0;i<ids.length;i+=200) {
            const ch=ids.slice(i,i+200),ph=ch.map(()=>'?').join(',');
            try { rawRun(raw,`DELETE FROM order_logs WHERE order_id IN (${ph})`,ch); } catch {}
          }
        } catch {}
        try { rawRun(raw,`DELETE FROM settings WHERE store_id=?`,[storeId]); } catch {}
        try { rawRun(raw,`DELETE FROM delivery_platforms WHERE store_id=?`,[storeId]); } catch {}
        try { rawRun(raw,`DELETE FROM delivery_fees WHERE store_id=?`,[storeId]); } catch {}
      }

      // ── categories ────────────────────────────────────────────────────────
      for (const c of (d.categories||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO categories (id,store_id,name,icon,sort_order,is_active,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [c.id,storeId,c.name||'',c.icon||'📌',c.sort_order||0,c.is_active??1,c.created_at||'']);
          if (n > 0) results.categories++; else results.skipped++;
        } catch(e) { results.errors.push(`[cat id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── products ──────────────────────────────────────────────────────────
      for (const p of (d.products||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO products
               (id,store_id,name,category,category_id,price,
                allocated_grams,current_stock_grams,low_stock_alert,
                show_on_line,line_price,line_description,line_image_url,line_category,
                line_hot,line_promo,line_sold_out,image,sort_order,sale_status,
                inventory_enabled,line_preorder_enabled,line_preorder_daily,
                line_preorder_low_threshold,line_preorder_high_threshold,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [p.id,storeId,p.name||'',p.category||'',p.category_id||null,p.price||0,
             p.allocated_grams||0,p.current_stock_grams||0,p.low_stock_alert||5,
             p.show_on_line??1,p.line_price||0,p.line_description||'',
             p.line_image_url||'',p.line_category||'',
             p.line_hot||0,p.line_promo||0,p.line_sold_out||0,
             p.image||'',p.sort_order||0,p.sale_status||'available',
             p.inventory_enabled||0,
             p.line_preorder_enabled||0,p.line_preorder_daily||0,
             p.line_preorder_low_threshold||2,p.line_preorder_high_threshold||10,
             p.created_at||'']);
          if (n > 0) results.products++; else results.skipped++;
        } catch(e) { results.errors.push(`[prod id=${p.id}] ${e.message}`); results.failed++; }
      }

      // ── orders（BUG-1 修正：依 store_id+order_number 明確判斷重複，不依賴 PK 衝突）──
      // 根因：orders.id TEXT PRIMARY KEY 使用 order_number，跨店時 INSERT OR IGNORE 因 PK 衝突
      //       被靜默跳過，即使 store_id 不同。修正：先 SELECT WHERE store_id=? AND order_number=?，
      //       依結果決定 skip/insert/update/copy，id 改為 storeId+'_'+order_number 避免 PK 衝突。
      const importOrderCols = [
        'id','order_number','store_id','customer_name','customer_phone','customer_line_id',
        'items','payment_method','payment_category','subtotal','total',
        'status','order_status','order_mode','source',
        'received_amount','change_amount','note','void_reason','voided_at',
        'table_number','guest_count','pickup_name','pickup_time',
        'delivery_platform','delivery_address','estimated_delivery',
        'delivery_status','delivery_fee',
        'platform_commission_rate','platform_commission_amount','store_actual_income',
        'platform_order_no',
        'discount_amount','discount_type','discount_category','discount_note','original_total',
        'discount_campaign_id','discount_campaign_name','discount_target_type',
        'discount_product_id','discount_product_name',
        'discount_product_ids','discount_product_names',
        'kitchen_status','payment_status','uuid','sync_status','device_id',
        'created_at','updated_at'
      ].filter(c => orderCols.has(c));

      const ordPhs = importOrderCols.map(()=>'?').join(',');

      function buildOrderMap(o, sid) {
        const items_ = typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]);
        // id：本店 + order_number 組合，確保跨店不衝突
        const safeId = sid + '_' + (o.order_number||o.id||'');
        return {
          id: safeId, order_number: o.order_number, store_id: sid,
          customer_name: o.customer_name||'', customer_phone: o.customer_phone||'',
          customer_line_id: o.customer_line_id||'',
          items: items_, payment_method: o.payment_method||'cash',
          payment_category: o.payment_category||'cash',
          subtotal: o.subtotal||0, total: o.total||0,
          status: o.status||'completed', order_status: o.order_status||'completed',
          order_mode: o.order_mode||'dine_in', source: o.source||'pos',
          received_amount: o.received_amount||0, change_amount: o.change_amount||0,
          note: o.note||'', void_reason: o.void_reason||'', voided_at: o.voided_at||'',
          table_number: o.table_number||'', guest_count: o.guest_count||0,
          pickup_name: o.pickup_name||'', pickup_time: o.pickup_time||'',
          delivery_platform: o.delivery_platform||'', delivery_address: o.delivery_address||'',
          estimated_delivery: o.estimated_delivery||'',
          delivery_status: o.delivery_status||'', delivery_fee: o.delivery_fee||0,
          platform_commission_rate: o.platform_commission_rate||0,
          platform_commission_amount: o.platform_commission_amount||0,
          store_actual_income: o.store_actual_income||0,
          platform_order_no: o.platform_order_no||'',
          discount_amount: o.discount_amount||0, discount_type: o.discount_type||'none',
          discount_category: o.discount_category||'none', discount_note: o.discount_note||'',
          original_total: o.original_total||o.total||0,
          discount_campaign_id: o.discount_campaign_id||null,
          discount_campaign_name: o.discount_campaign_name||'',
          discount_target_type: o.discount_target_type||'order',
          discount_product_id: o.discount_product_id||'',
          discount_product_name: o.discount_product_name||'',
          discount_product_ids: o.discount_product_ids||'',
          discount_product_names: o.discount_product_names||'',
          kitchen_status: o.kitchen_status||'pending', payment_status: o.payment_status||'paid',
          uuid: o.uuid||safeId, sync_status: o.sync_status||'synced', device_id: o.device_id||'',
          created_at: o.created_at||'', updated_at: o.updated_at||''
        };
      }

      for (const o of (d.orders||[])) {
        try {
          const orderNo = (o.order_number||'').trim();
          if (!orderNo) { results.failed++; continue; }

          // BUG-1 核心修正：用 store_id + order_number 判斷是否本店已有此訂單
          const existingRow = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);

          if (existingRow) {
            // 本店已有此 order_number
            if (mode === 'skip' || mode === 'replace') {
              results.skipped++; continue;
            }
            if (mode === 'overwrite') {
              // 只更新本店資料，不碰其他店
              const updCols = importOrderCols.filter(c => !['id','order_number','store_id'].includes(c));
              const map = buildOrderMap(o, storeId);
              const updVals = [...updCols.map(c => map[c] ?? null), storeId, orderNo];
              const updSql = `UPDATE orders SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND order_number=?`;
              const n = rawRunCount(raw, updSql, updVals);
              if (n > 0) results.orders++; else results.skipped++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              const copyMap = buildOrderMap({ ...o, order_number: newNo }, storeId);
              const copyVals = importOrderCols.map(c => copyMap[c] ?? null);
              const n = rawRunCount(raw,
                `INSERT OR IGNORE INTO orders (${importOrderCols.join(',')}) VALUES (${ordPhs})`, copyVals);
              if (n > 0) results.orders++; else results.skipped++;
            }
          } else {
            // 本店沒有此 order_number → 直接新增（id 用 storeId+'_'+orderNo 防跨店 PK 衝突）
            const map = buildOrderMap(o, storeId);
            const vals = importOrderCols.map(c => map[c] ?? null);
            // 若 id 已被其他店占用，OR REPLACE 僅替換同 PK，不影響本店邏輯
            // 但因 id 已含 storeId 前綴，正常情況不會衝突
            const n = rawRunCount(raw,
              `INSERT OR REPLACE INTO orders (${importOrderCols.join(',')}) VALUES (${ordPhs})`, vals);
            if (n > 0) results.orders++; else results.skipped++;
          }
        } catch(e) { results.errors.push(`[order ${o.order_number}] ${e.message}`); results.failed++; }
      }

      // ── order_logs（BUG-2 修正：PRAGMA 動態過濾欄位，防止 old_value/new_value 不存在錯誤）──
      const logCols = getTableCols(db, 'order_logs');
      // 所有可能欄位（含舊版 old_value/new_value 與新版 before_data/after_data）
      const logCandidates = [
        'id','store_id','order_id','order_number','action','reason','operator',
        'old_value','new_value','note',
        'before_data','after_data','before_total','after_total','amount_diff',
        'before_payment','after_payment','before_received','after_received',
        'before_change','after_change','created_at'
      ].filter(c => logCols.has(c));

      for (const ol of (d.order_logs||[])) {
        try {
          const logMap = {
            id: ol.id, store_id: storeId,
            order_id: ol.order_id, order_number: ol.order_number||ol.order_id||'',
            action: ol.action||'modify', reason: ol.reason||ol.note||'',
            operator: ol.operator||'', note: ol.note||'',
            old_value: ol.old_value||ol.before_data||'',
            new_value: ol.new_value||ol.after_data||'',
            before_data: ol.before_data||ol.old_value||'',
            after_data: ol.after_data||ol.new_value||'',
            before_total: ol.before_total||0, after_total: ol.after_total||0,
            amount_diff: ol.amount_diff||0,
            before_payment: ol.before_payment||'', after_payment: ol.after_payment||'',
            before_received: ol.before_received||0, after_received: ol.after_received||0,
            before_change: ol.before_change||0, after_change: ol.after_change||0,
            created_at: ol.created_at||''
          };
          const logVals = logCandidates.map(c => logMap[c] ?? null);
          const logPhs  = logCandidates.map(()=>'?').join(',');
          const n = rawRunCount(raw,
            `INSERT OR IGNORE INTO order_logs (${logCandidates.join(',')}) VALUES (${logPhs})`,
            logVals);
          if (n > 0) results.order_logs++; else results.skipped++;
        } catch(e) { results.errors.push(`[order_log] ${e.message}`); results.failed++; }
      }

      // ── discount_categories: id,store_id,code,name,icon,color,enabled,sort_order,created_at ──
      for (const c of (d.discount_categories||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO discount_categories
               (id,store_id,code,name,icon,color,enabled,sort_order,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [c.id,storeId,c.code||'',c.name||c.label||'',c.icon||'💸',
             c.color||'#94a3b8',c.enabled??c.is_active??1,c.sort_order||0,c.created_at||'']);
          if (n > 0) results.discount_categories++; else results.skipped++;
        } catch(e) { results.errors.push(`[disc_cat id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── discount_campaigns: id,store_id,name,description,enabled,sort_order,created_at ──
      for (const c of (d.discount_campaigns||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO discount_campaigns
               (id,store_id,name,description,enabled,sort_order,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [c.id,storeId,c.name||'',c.description||'',c.enabled??c.is_active??1,c.sort_order||0,c.created_at||'']);
          if (n > 0) results.discount_campaigns++; else results.skipped++;
        } catch(e) { results.errors.push(`[disc_camp id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_groups: id,store_id,group_name,description,enabled,sort_order,created_at,updated_at ──
      for (const g of (d.product_analysis_groups||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO product_analysis_groups
               (id,store_id,group_name,description,enabled,sort_order,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [g.id,storeId,g.group_name||g.name||'',g.description||'',
             g.enabled??g.is_active??1,g.sort_order||0,g.created_at||'',g.updated_at||g.created_at||'']);
          if (n > 0) results.analysis_groups++; else results.skipped++;
        } catch(e) { results.errors.push(`[group id=${g.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_group_items: id,store_id,group_id,product_id,product_name,created_at ──
      for (const gi of (d.product_analysis_group_items||[])) {
        try {
          const pName = gi.product_name
            || (safeGet(db,'SELECT name FROM products WHERE id=?',[gi.product_id])?.name)
            || '';
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO product_analysis_group_items
               (id,store_id,group_id,product_id,product_name,created_at)
             VALUES (?,?,?,?,?,?)`,
            [gi.id,storeId,gi.group_id,gi.product_id,pName,gi.created_at||'']);
          if (n > 0) results.analysis_items++; else results.skipped++;
        } catch(e) { results.errors.push(`[group_item id=${gi.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_group_aliases: id,store_id,group_id,alias_name,created_at ──
      for (const a of (d.product_analysis_group_aliases||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO product_analysis_group_aliases
               (id,store_id,group_id,alias_name,created_at)
             VALUES (?,?,?,?,?)`,
            [a.id,storeId,a.group_id,a.alias_name||'',a.created_at||'']);
          if (n > 0) results.analysis_aliases++; else results.skipped++;
        } catch(e) { results.errors.push(`[alias id=${a.id}] ${e.message}`); results.failed++; }
      }

      // ── settings ──────────────────────────────────────────────────────────
      for (const s of (d.settings||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO settings (store_id,key,value) VALUES (?,?,?)`,
            [storeId,s.key||'',s.value||'']);
          if (n > 0) results.settings++; else results.skipped++;
        } catch(e) { results.errors.push(`[setting key=${s.key}] ${e.message}`); results.failed++; }
      }

      // ── delivery_platforms ────────────────────────────────────────────────
      for (const p of (d.delivery_platforms||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO delivery_platforms
               (id,store_id,code,name,is_active,commission_rate,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [p.id,storeId,p.code||'',p.name||'',p.is_active??1,p.commission_rate||0,p.created_at||'']);
          if (n > 0) results.delivery_platforms++; else results.skipped++;
        } catch(e) { results.errors.push(`[platform id=${p.id}] ${e.message}`); results.failed++; }
      }

      // ── delivery_fees ─────────────────────────────────────────────────────
      for (const f of (d.delivery_fees||[])) {
        try {
          const n = rawRunCount(raw,
            `INSERT ${orMode} INTO delivery_fees
               (id,store_id,min_amount,max_amount,fee,created_at)
             VALUES (?,?,?,?,?,?)`,
            [f.id,storeId,f.min_amount||0,f.max_amount||0,f.fee||0,f.created_at||'']);
          if (n > 0) results.delivery_fees++; else results.skipped++;
        } catch(e) { results.errors.push(`[fee id=${f.id}] ${e.message}`); results.failed++; }
      }

    }); // ── end runInTransaction ─────────────────────────────────────────────

    writeMigrationLog(db, storeId, '匯入快速搬家檔', payload.store_id||'', mode, results,
      results.errors.length > 0 ? 'partial' : 'success',
      results.errors.slice(0,3).join('; '));

    res.json({ success: true, mode, results });
  } catch(e) {
    console.error('[migration/import]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
