// routes/migration.js — fix18-10 快速搬家檔 + 訂單/LINE預購匯出匯入
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── CSV helpers ──────────────────────────────────────────────────────────────
function toCsvCell(v) {
  const s = (v == null ? '' : String(v));
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}
function toCsvRow(arr) { return arr.map(toCsvCell).join(','); }
function toCsv(headers, rows) {
  return [toCsvRow(headers),
    ...rows.map(r => toCsvRow(headers.map(h => r[h] ?? '')))
  ].join('\n');
}
const BOM = '\uFEFF';

// ── Timestamp helpers ────────────────────────────────────────────────────────
function tsFile() {
  const d = new Date(), p = (n, l=2) => String(n).padStart(l,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function isoNow() { return new Date().toISOString(); }

// ── migration_logs: 建表（on-demand）────────────────────────────────────────
function ensureMigrationLogs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migration_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    action        TEXT NOT NULL,
    file_name     TEXT DEFAULT '',
    mode          TEXT DEFAULT '',
    summary_json  TEXT DEFAULT '{}',
    status        TEXT DEFAULT 'success',
    error_message TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);
}

function writeMigrationLog(db, storeId, action, fileName, mode, summary, status, errMsg) {
  try {
    ensureMigrationLogs(db);
    db.run(
      `INSERT INTO migration_logs
         (store_id, action, file_name, mode, summary_json, status, error_message)
       VALUES (?,?,?,?,?,?,?)`,
      [storeId, action, fileName||'', mode||'',
       JSON.stringify(summary||{}), status||'success', errMsg||'']
    );
  } catch(e) { console.error('[migration_log] write failed:', e.message); }
}

// ── safe db.all wrapper ──────────────────────────────────────────────────────
function safeAll(db, sql, params) {
  try { return db.all(sql, params); } catch { return []; }
}
function safeGet(db, sql, params) {
  try { return db.get(sql, params); } catch { return null; }
}

// ── chunk helper for IN queries ──────────────────────────────────────────────
function fetchByIds(db, table, idCol, ids) {
  if (!ids || !ids.length) return [];
  const result = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph    = chunk.map(() => '?').join(',');
    try {
      const rows = db.all(`SELECT * FROM ${table} WHERE ${idCol} IN (${ph})`, chunk);
      result.push(...rows);
    } catch {}
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
//  訂單匯出  GET /api/export/orders
// ═══════════════════════════════════════════════════════════════════════════
router.get('/export/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const format  = String(req.query.format || 'json').toLowerCase();
    const scope   = req.query.scope   || 'all';
    const dFrom   = req.query.date_from || '';
    const dTo     = req.query.date_to   || '';

    let sql    = 'SELECT * FROM orders WHERE store_id=?';
    const args = [storeId];
    if (scope === 'filtered' && dFrom && dTo) {
      sql += ' AND date(created_at) >= ? AND date(created_at) <= ?';
      args.push(dFrom, dTo);
    }
    sql += ' ORDER BY created_at DESC';

    const orders   = safeAll(db, sql, args);
    const orderIds = orders.map(o => o.id || o.order_number).filter(Boolean);
    const orderItems = fetchByIds(db, 'order_items', 'order_id', orderIds);
    const orderLogs  = fetchByIds(db, 'order_logs',  'order_id', orderIds);

    const ts       = tsFile();
    const fileName = `orders_${ts}.${format}`;
    writeMigrationLog(db, storeId, '匯出訂單', fileName, format,
      { orders: orders.length, order_items: orderItems.length }, 'success', '');

    if (format === 'csv') {
      const headers = [
        'id','order_number','store_id','order_mode','source',
        'customer_name','customer_phone','payment_method','payment_category',
        'subtotal','total','discount_amount','discount_category',
        'discount_campaign_id','discount_campaign_name','discount_product_ids','discount_product_names',
        'status','order_status','note','pickup_name','pickup_time',
        'delivery_platform','delivery_address','delivery_status',
        'platform_commission_rate','platform_commission_amount','store_actual_income',
        'delivery_fee','created_at','updated_at'
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(BOM + toCsv(headers, orders));
    }

    // JSON（完整備份：orders + order_items + order_logs）
    const payload = {
      type: 'orders_backup', version: 'fix18-10',
      exported_at: isoNow(), store_id: storeId,
      data: { orders, order_items: orderItems, order_logs: orderLogs }
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));

  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  訂單匯入  POST /api/import/orders
//  body: { orders:[], order_items:[], order_logs:[], mode:'skip'|'overwrite'|'copy' }
// ═══════════════════════════════════════════════════════════════════════════
router.post('/import/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { orders = [], order_items = [], order_logs = [], mode = 'skip' } = req.body;

    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];

    db.exec('BEGIN');
    try {
      for (const o of orders) {
        const orderNo = (o.order_number || '').trim();
        if (!orderNo) { failed++; continue; }
        try {
          const existing = safeGet(db, 'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);
          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              db.run(
                `UPDATE orders SET
                   customer_name=?, customer_phone=?, order_mode=?, source=?,
                   items=?, payment_method=?, payment_category=?,
                   subtotal=?, total=?, discount_amount=?, discount_category=?,
                   discount_campaign_id=?, discount_campaign_name=?,
                   discount_product_ids=?, discount_product_names=?,
                   status=?, order_status=?, note=?,
                   pickup_name=?, pickup_time=?,
                   delivery_platform=?, delivery_address=?, delivery_status=?,
                   platform_commission_rate=?, platform_commission_amount=?,
                   store_actual_income=?, delivery_fee=?, created_at=?,
                   updated_at=datetime('now','localtime')
                 WHERE store_id=? AND order_number=?`,
                [o.customer_name||'', o.customer_phone||'', o.order_mode||'dine_in', o.source||'pos',
                 typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
                 o.payment_method||'cash', o.payment_category||'cash',
                 o.subtotal||0, o.total||0,
                 o.discount_amount||0, o.discount_category||'none',
                 o.discount_campaign_id||null, o.discount_campaign_name||'',
                 o.discount_product_ids||'', o.discount_product_names||'',
                 o.status||'completed', o.order_status||'completed', o.note||'',
                 o.pickup_name||'', o.pickup_time||'',
                 o.delivery_platform||'', o.delivery_address||'', o.delivery_status||'',
                 o.platform_commission_rate||0, o.platform_commission_amount||0,
                 o.store_actual_income||0, o.delivery_fee||0, o.created_at||'',
                 storeId, orderNo]
              );
              updated++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              const newId = newNo;
              db.run(
                `INSERT INTO orders
                   (id,order_number,store_id,customer_name,customer_phone,
                    order_mode,source,items,payment_method,payment_category,
                    subtotal,total,discount_amount,discount_category,
                    discount_campaign_id,discount_campaign_name,
                    discount_product_ids,discount_product_names,
                    status,order_status,note,pickup_name,pickup_time,
                    delivery_platform,delivery_address,delivery_status,
                    platform_commission_rate,platform_commission_amount,
                    store_actual_income,delivery_fee,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [newId, newNo, storeId,
                 o.customer_name||'', o.customer_phone||'', o.order_mode||'dine_in', o.source||'pos',
                 typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
                 o.payment_method||'cash', o.payment_category||'cash',
                 o.subtotal||0, o.total||0,
                 o.discount_amount||0, o.discount_category||'none',
                 o.discount_campaign_id||null, o.discount_campaign_name||'',
                 o.discount_product_ids||'', o.discount_product_names||'',
                 o.status||'completed', o.order_status||'completed', o.note||'',
                 o.pickup_name||'', o.pickup_time||'',
                 o.delivery_platform||'', o.delivery_address||'', o.delivery_status||'',
                 o.platform_commission_rate||0, o.platform_commission_amount||0,
                 o.store_actual_income||0, o.delivery_fee||0, o.created_at||'']
              );
              added++;
            }
          } else {
            const id = o.id || o.order_number;
            db.run(
              `INSERT OR IGNORE INTO orders
                 (id,order_number,store_id,customer_name,customer_phone,
                  order_mode,source,items,payment_method,payment_category,
                  subtotal,total,discount_amount,discount_category,
                  discount_campaign_id,discount_campaign_name,
                  discount_product_ids,discount_product_names,
                  status,order_status,note,pickup_name,pickup_time,
                  delivery_platform,delivery_address,delivery_status,
                  platform_commission_rate,platform_commission_amount,
                  store_actual_income,delivery_fee,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [id, orderNo, storeId,
               o.customer_name||'', o.customer_phone||'', o.order_mode||'dine_in', o.source||'pos',
               typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
               o.payment_method||'cash', o.payment_category||'cash',
               o.subtotal||0, o.total||0,
               o.discount_amount||0, o.discount_category||'none',
               o.discount_campaign_id||null, o.discount_campaign_name||'',
               o.discount_product_ids||'', o.discount_product_names||'',
               o.status||'completed', o.order_status||'completed', o.note||'',
               o.pickup_name||'', o.pickup_time||'',
               o.delivery_platform||'', o.delivery_address||'', o.delivery_status||'',
               o.platform_commission_rate||0, o.platform_commission_amount||0,
               o.store_actual_income||0, o.delivery_fee||0, o.created_at||'']
            );
            added++;
          }
        } catch(e2) { errors.push(`order ${orderNo}: ${e2.message}`); failed++; }
      }
      db.exec('COMMIT');
    } catch(e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    const summary = { added, updated, skipped, failed };
    writeMigrationLog(db, storeId, '匯入訂單', '', mode, summary,
      failed > 0 ? 'partial' : 'success', errors.slice(0,5).join('; '));
    res.json({ success: true, ...summary, errors: errors.slice(0, 20) });

  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LINE預購匯出  GET /api/export/preorders
//  LINE預購 = orders WHERE source='line'
// ═══════════════════════════════════════════════════════════════════════════
router.get('/export/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const format  = String(req.query.format || 'json').toLowerCase();
    const dFrom   = req.query.date_from || '';
    const dTo     = req.query.date_to   || '';

    let sql    = `SELECT * FROM orders WHERE store_id=? AND source='line'`;
    const args = [storeId];
    if (dFrom && dTo) {
      sql += ' AND date(created_at) >= ? AND date(created_at) <= ?';
      args.push(dFrom, dTo);
    }
    sql += ' ORDER BY created_at DESC';

    const preorders = safeAll(db, sql, args);
    const ts        = tsFile();
    const fileName  = `preorders_${ts}.${format}`;
    writeMigrationLog(db, storeId, '匯出預購', fileName, format,
      { preorders: preorders.length }, 'success', '');

    if (format === 'csv') {
      const headers = [
        'id','order_number','store_id','source','customer_name','customer_phone',
        'order_mode','items','payment_method','subtotal','total',
        'status','order_status','note','pickup_name','pickup_time','created_at'
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(BOM + toCsv(headers, preorders));
    }

    const payload = {
      type: 'preorders_backup', version: 'fix18-10',
      exported_at: isoNow(), store_id: storeId,
      data: { preorders }
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));

  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LINE預購匯入  POST /api/import/preorders
// ═══════════════════════════════════════════════════════════════════════════
router.post('/import/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { preorders = [], mode = 'skip' } = req.body;

    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];

    db.exec('BEGIN');
    try {
      for (const o of preorders) {
        const orderNo = (o.order_number || '').trim();
        if (!orderNo) { failed++; continue; }
        try {
          const existing = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);
          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              db.run(
                `UPDATE orders SET
                   customer_name=?, customer_phone=?, order_mode=?, source='line',
                   items=?, payment_method=?, subtotal=?, total=?,
                   status=?, order_status=?, note=?, pickup_name=?, pickup_time=?,
                   created_at=?, updated_at=datetime('now','localtime')
                 WHERE store_id=? AND order_number=?`,
                [o.customer_name||'', o.customer_phone||'', o.order_mode||'takeout',
                 typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
                 o.payment_method||'line_pay', o.subtotal||o.total||0, o.total||0,
                 o.status||'pending', o.order_status||'pending',
                 o.note||'', o.pickup_name||'', o.pickup_time||'',
                 o.created_at||'', storeId, orderNo]
              );
              updated++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              db.run(
                `INSERT INTO orders
                   (id,order_number,store_id,customer_name,customer_phone,
                    order_mode,source,items,payment_method,subtotal,total,
                    status,order_status,note,pickup_name,pickup_time,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [newNo, newNo, storeId,
                 o.customer_name||'', o.customer_phone||'', o.order_mode||'takeout', 'line',
                 typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
                 o.payment_method||'line_pay', o.subtotal||o.total||0, o.total||0,
                 o.status||'pending', o.order_status||'pending',
                 o.note||'', o.pickup_name||'', o.pickup_time||'', o.created_at||'']
              );
              added++;
            }
          } else {
            const id = o.id || o.order_number;
            db.run(
              `INSERT OR IGNORE INTO orders
                 (id,order_number,store_id,customer_name,customer_phone,
                  order_mode,source,items,payment_method,subtotal,total,
                  status,order_status,note,pickup_name,pickup_time,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [id, orderNo, storeId,
               o.customer_name||'', o.customer_phone||'', o.order_mode||'takeout', 'line',
               typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]),
               o.payment_method||'line_pay', o.subtotal||o.total||0, o.total||0,
               o.status||'pending', o.order_status||'pending',
               o.note||'', o.pickup_name||'', o.pickup_time||'', o.created_at||'']
            );
            added++;
          }
        } catch(e2) { errors.push(`preorder ${orderNo}: ${e2.message}`); failed++; }
      }
      db.exec('COMMIT');
    } catch(e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    const summary = { added, updated, skipped, failed };
    writeMigrationLog(db, storeId, '匯入預購', '', mode, summary,
      failed > 0 ? 'partial' : 'success', errors.slice(0,5).join('; '));
    res.json({ success: true, ...summary, errors: errors.slice(0, 20) });

  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯出  GET /api/migration/export
// ═══════════════════════════════════════════════════════════════════════════
router.get('/migration/export', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    // ── 店家資訊 ──
    const storeRow = safeGet(db, 'SELECT * FROM stores WHERE store_id=?', [storeId]);

    // ── 核心商品/分類 ──
    const products   = safeAll(db, 'SELECT * FROM products   WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const categories = safeAll(db, 'SELECT * FROM categories WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);

    // ── 訂單 ──
    const orders    = safeAll(db, 'SELECT * FROM orders WHERE store_id=? ORDER BY created_at ASC', [storeId]);
    const orderIds  = orders.map(o => o.id || o.order_number).filter(Boolean);
    const orderItems = fetchByIds(db, 'order_items', 'order_id', orderIds);
    const orderLogs  = fetchByIds(db, 'order_logs',  'order_id', orderIds);

    // LINE 預購 = orders where source='line'（已含在 orders 裡，單獨列出 number list）
    const preorderNums = orders.filter(o => o.source === 'line').map(o => o.order_number);

    // ── LINE 商品設定（從 products 提取）──
    const lineProducts = products.map(p => ({
      product_id: p.id, name: p.name, category: p.category,
      show_on_line: p.show_on_line, line_price: p.line_price,
      line_description: p.line_description, line_image_url: p.line_image_url,
      line_category: p.line_category,
      line_hot: p.line_hot, line_promo: p.line_promo, line_sold_out: p.line_sold_out,
      line_preorder_enabled: p.line_preorder_enabled,
      line_preorder_daily: p.line_preorder_daily,
      line_preorder_sold: p.line_preorder_sold,
      line_preorder_low_threshold: p.line_preorder_low_threshold,
      line_preorder_high_threshold: p.line_preorder_high_threshold
    }));

    // ── 庫存 ──
    const inventory = safeAll(db, 'SELECT * FROM inventory WHERE store_id=?', [storeId]);

    // ── 折扣 ──
    const discountCategories = safeAll(db, 'SELECT * FROM discount_categories WHERE store_id=?', [storeId]);
    const discountCampaigns  = safeAll(db, 'SELECT * FROM discount_campaigns  WHERE store_id=?', [storeId]);

    // ── 商品分析群組 ──
    const analysisGroups = safeAll(db, 'SELECT * FROM product_analysis_groups WHERE store_id=?', [storeId]);
    const groupIds       = analysisGroups.map(g => g.id).filter(Boolean);
    const analysisItems  = groupIds.length
      ? safeAll(db, `SELECT i.* FROM product_analysis_group_items i
                     INNER JOIN product_analysis_groups g ON g.id=i.group_id
                     WHERE g.store_id=?`, [storeId])
      : [];
    const analysisAliases = groupIds.length
      ? safeAll(db, `SELECT a.* FROM product_analysis_group_aliases a
                     INNER JOIN product_analysis_groups g ON g.id=a.group_id
                     WHERE g.store_id=?`, [storeId])
      : [];

    // ── 外送設定 ──
    const deliveryPlatforms = safeAll(db, 'SELECT * FROM delivery_platforms WHERE store_id=?', [storeId]);
    const deliveryFees      = safeAll(db, 'SELECT * FROM delivery_fees      WHERE store_id=?', [storeId]);

    // ── 店家設定 ──
    const settings = safeAll(db, 'SELECT * FROM settings WHERE store_id=?', [storeId]);

    // ── 組裝 payload ──
    const ts       = tsFile();
    const fileName = `pos_migration_${storeId}_${ts}.json`;

    const payload = {
      type:           'pos_migration_backup',
      version:        'fix18-10',
      exported_at:    isoNow(),
      store_id:       storeId,
      store_name:     storeRow ? (storeRow.name || storeRow.store_id || storeId) : storeId,
      schema_version: 1,
      data: {
        products,
        categories,
        orders,
        order_items:   orderItems,
        order_logs:    orderLogs,
        preorder_order_numbers: preorderNums,   // 指向 orders 內 source='line' 的單號清單
        line_products: lineProducts,
        inventory,
        discount_categories: discountCategories,
        discount_campaigns:  discountCampaigns,
        product_analysis_groups:         analysisGroups,
        product_analysis_group_items:    analysisItems,
        product_analysis_group_aliases:  analysisAliases,
        delivery_platforms: deliveryPlatforms,
        delivery_fees:      deliveryFees,
        settings
      }
    };

    const summary = {
      products:          products.length,
      categories:        categories.length,
      orders:            orders.length,
      order_items:       orderItems.length,
      order_logs:        orderLogs.length,
      preorders:         preorderNums.length,
      discount_categories: discountCategories.length,
      discount_campaigns:  discountCampaigns.length,
      analysis_groups:   analysisGroups.length,
      analysis_items:    analysisItems.length,
      analysis_aliases:  analysisAliases.length,
      settings:          settings.length
    };

    writeMigrationLog(db, storeId, '匯出快速搬家檔', fileName, 'export', summary, 'success', '');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));

  } catch(e) {
    console.error('[migration/export]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  快速搬家檔 preview  POST /api/migration/import/preview
//  僅讀取 JSON、回傳筆數，不寫入 DB
// ═══════════════════════════════════════════════════════════════════════════
router.post('/migration/import/preview', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const payload = req.body;

    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    const fileStoreId = payload.store_id || '';
    const crossStore  = fileStoreId && fileStoreId !== storeId;
    const d = payload.data || {};

    const preorderCount = (d.orders || []).filter(o => o.source === 'line').length;

    const summary = {
      products:                     (d.products                    || []).length,
      categories:                   (d.categories                  || []).length,
      orders:                       (d.orders                      || []).length,
      order_items:                  (d.order_items                 || []).length,
      order_logs:                   (d.order_logs                  || []).length,
      preorders:                    preorderCount,
      discount_categories:          (d.discount_categories         || []).length,
      discount_campaigns:           (d.discount_campaigns          || []).length,
      product_analysis_groups:      (d.product_analysis_groups     || []).length,
      product_analysis_group_items: (d.product_analysis_group_items|| []).length,
      product_analysis_group_aliases:(d.product_analysis_group_aliases||[]).length,
      settings:                     (d.settings                    || []).length
    };

    res.json({
      success:          true,
      file_store_id:    fileStoreId,
      current_store_id: storeId,
      cross_store:      crossStore,
      version:          payload.version || '',
      exported_at:      payload.exported_at || '',
      store_name:       payload.store_name || '',
      summary
    });

  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯入  POST /api/migration/import
//  body: { payload:{...}, mode:'skip'|'overwrite'|'replace', allowCrossStoreImport:false }
// ═══════════════════════════════════════════════════════════════════════════
router.post('/migration/import', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { payload, mode = 'skip', allowCrossStoreImport = false } = req.body;

    // ── 格式驗證 ──
    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    // ── 跨店安全限制 ──
    const fileStoreId = payload.store_id || storeId;
    if (fileStoreId !== storeId && !allowCrossStoreImport) {
      return res.status(403).json({
        success:       false,
        cross_store:   true,
        file_store_id: fileStoreId,
        message:       `備份檔屬於 ${fileStoreId}，目前店家是 ${storeId}。若確認要匯入，請設定 allowCrossStoreImport=true。`
      });
    }

    const d = payload.data || {};
    const results = {
      products: 0, categories: 0, orders: 0, order_items: 0, order_logs: 0,
      discount_categories: 0, discount_campaigns: 0,
      analysis_groups: 0, analysis_items: 0, analysis_aliases: 0,
      settings: 0, delivery_platforms: 0, delivery_fees: 0,
      errors: []
    };

    const attempt = (label, fn) => {
      try { fn(); }
      catch(e) { results.errors.push(`[${label}] ${e.message}`); }
    };

    // ── 工具：UPSERT 或 INSERT OR IGNORE ──
    const doInsert = (sql, params, overwriteSql, overwriteParams) => {
      if (mode === 'skip' || mode === 'replace') {
        db.run(sql, params);
      } else { // overwrite
        db.run(overwriteSql, overwriteParams);
      }
    };

    db.exec('BEGIN');
    try {

      // ── replace 模式：只清空本店資料 ─────────────────────────
      if (mode === 'replace') {
        const clearTables = [
          'orders', 'order_items', 'order_logs',
          'products', 'categories',
          'discount_categories', 'discount_campaigns',
          'product_analysis_groups',
          'product_analysis_group_items',
          'product_analysis_group_aliases',
          'inventory'
        ];
        for (const t of clearTables) {
          try { db.run(`DELETE FROM ${t} WHERE store_id=?`, [storeId]); } catch {}
        }
        try { db.run(`DELETE FROM settings WHERE store_id=?`, [storeId]); } catch {}
        try { db.run(`DELETE FROM delivery_platforms WHERE store_id=?`, [storeId]); } catch {}
        try { db.run(`DELETE FROM delivery_fees WHERE store_id=?`, [storeId]); } catch {}
      }

      // ── categories ────────────────────────────────────────────
      for (const c of (d.categories || [])) {
        attempt('category', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO categories (id,store_id,name,icon,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [c.id, storeId, c.name||'', c.icon||'', c.sort_order||0, c.is_active??1, c.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO categories (id,store_id,name,icon,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [c.id, storeId, c.name||'', c.icon||'', c.sort_order||0, c.is_active??1, c.created_at||'']
            );
          }
          results.categories++;
        });
      }

      // ── products ──────────────────────────────────────────────
      for (const p of (d.products || [])) {
        attempt('product', () => {
          const vals = [p.id, storeId,
            p.name||'', p.category||'', p.category_id||null, p.price||0,
            p.allocated_grams||0, p.current_stock_grams||0, p.low_stock_alert||5,
            p.show_on_line??1, p.line_price||0, p.line_description||'',
            p.line_image_url||'', p.line_category||'',
            p.line_hot||0, p.line_promo||0, p.line_sold_out||0, p.image||'',
            p.sort_order||0, p.sale_status||'available', p.inventory_enabled||0,
            p.line_preorder_enabled||0, p.line_preorder_daily||0,
            p.line_preorder_low_threshold||2, p.line_preorder_high_threshold||10,
            p.created_at||''
          ];
          const cols = `id,store_id,name,category,category_id,price,
            allocated_grams,current_stock_grams,low_stock_alert,
            show_on_line,line_price,line_description,line_image_url,line_category,
            line_hot,line_promo,line_sold_out,image,sort_order,sale_status,
            inventory_enabled,line_preorder_enabled,line_preorder_daily,
            line_preorder_low_threshold,line_preorder_high_threshold,created_at`;
          const phs = cols.split(',').map(()=>'?').join(',');
          if (mode === 'overwrite') {
            db.run(`INSERT OR REPLACE INTO products (${cols}) VALUES (${phs})`, vals);
          } else {
            db.run(`INSERT OR IGNORE INTO products (${cols}) VALUES (${phs})`, vals);
          }
          results.products++;
        });
      }

      // ── orders ────────────────────────────────────────────────
      for (const o of (d.orders || [])) {
        attempt('order', () => {
          const id     = o.id || o.order_number;
          const items_ = typeof o.items === 'string' ? o.items : JSON.stringify(o.items||[]);
          const vals   = [id, o.order_number, storeId,
            o.customer_name||'', o.customer_phone||'', o.customer_line_id||'',
            items_, o.payment_method||'cash', o.payment_category||'cash',
            o.subtotal||0, o.total||0, o.status||'completed', o.order_status||'completed',
            o.order_mode||'dine_in', o.source||'pos',
            o.received_amount||0, o.change_amount||0, o.note||'',
            o.void_reason||'', o.voided_at||'', o.table_number||'', o.guest_count||0,
            o.pickup_name||'', o.pickup_time||'',
            o.delivery_platform||'', o.delivery_address||'', o.estimated_delivery||'',
            o.delivery_status||'', o.delivery_fee||0,
            o.platform_commission_rate||0, o.platform_commission_amount||0,
            o.store_actual_income||0, o.platform_order_no||'',
            o.discount_amount||0, o.discount_type||'none', o.discount_category||'none',
            o.discount_note||'', o.original_total||o.total||0,
            o.discount_campaign_id||null, o.discount_campaign_name||'',
            o.discount_target_type||'order', o.discount_product_id||'',
            o.discount_product_name||'', o.discount_product_ids||'', o.discount_product_names||'',
            o.kitchen_status||'pending', o.payment_status||'paid',
            o.uuid||id, o.sync_status||'synced', o.device_id||'',
            o.created_at||'', o.updated_at||''
          ];
          const cols = `id,order_number,store_id,
            customer_name,customer_phone,customer_line_id,
            items,payment_method,payment_category,
            subtotal,total,status,order_status,order_mode,source,
            received_amount,change_amount,note,void_reason,voided_at,
            table_number,guest_count,pickup_name,pickup_time,
            delivery_platform,delivery_address,estimated_delivery,
            delivery_status,delivery_fee,
            platform_commission_rate,platform_commission_amount,store_actual_income,
            platform_order_no,
            discount_amount,discount_type,discount_category,discount_note,original_total,
            discount_campaign_id,discount_campaign_name,discount_target_type,
            discount_product_id,discount_product_name,discount_product_ids,discount_product_names,
            kitchen_status,payment_status,uuid,sync_status,device_id,
            created_at,updated_at`;
          const phs = cols.split(',').map(()=>'?').join(',');
          if (mode === 'overwrite') {
            db.run(`INSERT OR REPLACE INTO orders (${cols}) VALUES (${phs})`, vals);
          } else {
            db.run(`INSERT OR IGNORE INTO orders (${cols}) VALUES (${phs})`, vals);
          }
          results.orders++;
        });
      }

      // ── order_items ───────────────────────────────────────────
      for (const oi of (d.order_items || [])) {
        attempt('order_item', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO order_items
                 (id,order_id,product_id,product_name,quantity,unit_price,total_price,note,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [oi.id,oi.order_id,oi.product_id,oi.product_name||'',
               oi.quantity||1,oi.unit_price||0,oi.total_price||0,oi.note||'',oi.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO order_items
                 (id,order_id,product_id,product_name,quantity,unit_price,total_price,note,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [oi.id,oi.order_id,oi.product_id,oi.product_name||'',
               oi.quantity||1,oi.unit_price||0,oi.total_price||0,oi.note||'',oi.created_at||'']
            );
          }
          results.order_items++;
        });
      }

      // ── order_logs ────────────────────────────────────────────
      for (const ol of (d.order_logs || [])) {
        attempt('order_log', () => {
          db.run(
            `INSERT OR IGNORE INTO order_logs
               (id,order_id,action,old_value,new_value,note,operator,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [ol.id,ol.order_id,ol.action||'',ol.old_value||'',ol.new_value||'',
             ol.note||'',ol.operator||'',ol.created_at||'']
          );
          results.order_logs++;
        });
      }

      // ── discount_categories ───────────────────────────────────
      for (const c of (d.discount_categories || [])) {
        attempt('discount_category', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO discount_categories
                 (id,store_id,code,label,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [c.id,storeId,c.code||'',c.label||'',c.sort_order||0,c.is_active??1,c.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO discount_categories
                 (id,store_id,code,label,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [c.id,storeId,c.code||'',c.label||'',c.sort_order||0,c.is_active??1,c.created_at||'']
            );
          }
          results.discount_categories++;
        });
      }

      // ── discount_campaigns ────────────────────────────────────
      for (const c of (d.discount_campaigns || [])) {
        attempt('discount_campaign', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO discount_campaigns
                 (id,store_id,name,discount_type,discount_value,target_type,
                  product_ids,category_code,is_active,start_date,end_date,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              [c.id,storeId,c.name||'',c.discount_type||'',c.discount_value||0,
               c.target_type||'order',c.product_ids||'',c.category_code||'',
               c.is_active??1,c.start_date||'',c.end_date||'',c.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO discount_campaigns
                 (id,store_id,name,discount_type,discount_value,target_type,
                  product_ids,category_code,is_active,start_date,end_date,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              [c.id,storeId,c.name||'',c.discount_type||'',c.discount_value||0,
               c.target_type||'order',c.product_ids||'',c.category_code||'',
               c.is_active??1,c.start_date||'',c.end_date||'',c.created_at||'']
            );
          }
          results.discount_campaigns++;
        });
      }

      // ── product_analysis_groups ───────────────────────────────
      for (const g of (d.product_analysis_groups || [])) {
        attempt('analysis_group', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO product_analysis_groups
                 (id,store_id,name,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?)`,
              [g.id,storeId,g.name||'',g.sort_order||0,g.is_active??1,g.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO product_analysis_groups
                 (id,store_id,name,sort_order,is_active,created_at)
               VALUES (?,?,?,?,?,?)`,
              [g.id,storeId,g.name||'',g.sort_order||0,g.is_active??1,g.created_at||'']
            );
          }
          results.analysis_groups++;
        });
      }

      // ── product_analysis_group_items ──────────────────────────
      for (const gi of (d.product_analysis_group_items || [])) {
        attempt('analysis_item', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO product_analysis_group_items
                 (id,group_id,product_id,created_at) VALUES (?,?,?,?)`,
              [gi.id,gi.group_id,gi.product_id,gi.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO product_analysis_group_items
                 (id,group_id,product_id,created_at) VALUES (?,?,?,?)`,
              [gi.id,gi.group_id,gi.product_id,gi.created_at||'']
            );
          }
          results.analysis_items++;
        });
      }

      // ── product_analysis_group_aliases ────────────────────────
      for (const a of (d.product_analysis_group_aliases || [])) {
        attempt('analysis_alias', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO product_analysis_group_aliases
                 (id,group_id,store_id,alias_name,created_at) VALUES (?,?,?,?,?)`,
              [a.id,a.group_id,storeId,a.alias_name||'',a.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO product_analysis_group_aliases
                 (id,group_id,store_id,alias_name,created_at) VALUES (?,?,?,?,?)`,
              [a.id,a.group_id,storeId,a.alias_name||'',a.created_at||'']
            );
          }
          results.analysis_aliases++;
        });
      }

      // ── settings ──────────────────────────────────────────────
      for (const s of (d.settings || [])) {
        attempt('setting', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)`,
              [storeId, s.key||'', s.value||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)`,
              [storeId, s.key||'', s.value||'']
            );
          }
          results.settings++;
        });
      }

      // ── delivery_platforms ────────────────────────────────────
      for (const p of (d.delivery_platforms || [])) {
        attempt('delivery_platform', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO delivery_platforms
                 (id,store_id,code,name,is_active,commission_rate,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [p.id,storeId,p.code||'',p.name||'',p.is_active??1,p.commission_rate||0,p.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO delivery_platforms
                 (id,store_id,code,name,is_active,commission_rate,created_at)
               VALUES (?,?,?,?,?,?,?)`,
              [p.id,storeId,p.code||'',p.name||'',p.is_active??1,p.commission_rate||0,p.created_at||'']
            );
          }
          results.delivery_platforms++;
        });
      }

      // ── delivery_fees ─────────────────────────────────────────
      for (const f of (d.delivery_fees || [])) {
        attempt('delivery_fee', () => {
          if (mode === 'overwrite') {
            db.run(
              `INSERT OR REPLACE INTO delivery_fees
                 (id,store_id,min_amount,max_amount,fee,created_at)
               VALUES (?,?,?,?,?,?)`,
              [f.id,storeId,f.min_amount||0,f.max_amount||0,f.fee||0,f.created_at||'']
            );
          } else {
            db.run(
              `INSERT OR IGNORE INTO delivery_fees
                 (id,store_id,min_amount,max_amount,fee,created_at)
               VALUES (?,?,?,?,?,?)`,
              [f.id,storeId,f.min_amount||0,f.max_amount||0,f.fee||0,f.created_at||'']
            );
          }
          results.delivery_fees++;
        });
      }

      db.exec('COMMIT');

    } catch(e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    writeMigrationLog(db, storeId, '匯入快速搬家檔', payload.store_id || '', mode, results,
      results.errors.length > 0 ? 'partial' : 'success',
      results.errors.slice(0, 3).join('; '));

    res.json({ success: true, mode, results });

  } catch(e) {
    console.error('[migration/import]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
