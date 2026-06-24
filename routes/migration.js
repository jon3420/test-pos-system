// routes/migration.js — fix18-10-hotfix2
//
// 根本原因（已驗證）：
//   sql.js 的 export() / sqlDb.export() 在 active transaction 內
//   會觸發隱性 COMMIT 並清空 uncommitted 資料。
//   db.run() wrapper 每次 INSERT 後都呼叫 save() = sqlDb.export()，
//   因此 transaction 在第一筆 INSERT 後立即被 commit，
//   後續 raw.run('COMMIT') 就拋出「cannot commit - no transaction is active」。
//
// 解法：
//   runInTransaction(db, fn) 改為：
//     - 所有 INSERT/UPDATE/DELETE 改用 rawRun(raw, sql, params)
//       直接呼叫 raw.prepare().run()，完全不呼叫 save()
//     - COMMIT 後才呼叫一次 db._save()
//
// Schema 對照（已從實際原始碼確認）：
//   discount_categories:          id,store_id,code,name,icon,color,enabled,sort_order,created_at
//   discount_campaigns:           id,store_id,name,description,enabled,sort_order,created_at
//   product_analysis_groups:      id,store_id,group_name,description,enabled,sort_order,created_at,updated_at
//   product_analysis_group_items: id,store_id,group_id,product_id,product_name,created_at
//   product_analysis_group_aliases: id,store_id,group_id,alias_name,created_at
//   orders.items:                 JSON string（無獨立 order_items 資料表）

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

// ── migration_logs（on-demand，用 db.exec 在 tx 外建表）──────────────────────
function ensureMigrationLogs(db) {
  // db.exec 可以在 tx 外安全執行
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
    // 這裡用 db.run()（有 save()），因為此時 tx 已結束
    db.run(
      `INSERT INTO migration_logs (store_id,action,file_name,mode,summary_json,status,error_message)
       VALUES (?,?,?,?,?,?,?)`,
      [storeId, action, fileName||'', mode||'', JSON.stringify(summary||{}), status||'success', errMsg||'']
    );
  } catch(e) { console.error('[migration_log]', e.message); }
}

// ── safe read wrappers（用 db.all/db.get，僅讀取不觸發 save）────────────────
function safeAll(db, sql, params) {
  try { return db.all(sql, params); } catch { return []; }
}
function safeGet(db, sql, params) {
  try { return db.get(sql, params); } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
//  rawRun — 在 transaction 內執行 INSERT/UPDATE/DELETE
//  直接使用 raw sql.js prepare().run()，完全不呼叫 save() / export()
// ════════════════════════════════════════════════════════════════════════════
function rawRun(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
}

// ════════════════════════════════════════════════════════════════════════════
//  runInTransaction — 包裝整個寫入邏輯
//  BEGIN → fn(raw) → COMMIT → db._save()（一次）
//  任何 throw → ROLLBACK（不寫檔）
// ════════════════════════════════════════════════════════════════════════════
function runInTransaction(db, fn) {
  const raw = db._db;   // raw sql.js Database，不會呼叫 save()
  raw.run('BEGIN');
  try {
    fn(raw);            // fn 接收 raw，使用 rawRun(raw, ...) 寫入
    raw.run('COMMIT');
    db._save();         // commit 後才寫一次檔
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

    // order_items 展開自 orders.items JSON（本專案無獨立 order_items 表）
    const orderItemsExpanded = [];
    for (const o of orders) {
      try {
        const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
        if (Array.isArray(items)) {
          items.forEach((it, idx) => orderItemsExpanded.push({
            order_id:     o.id || o.order_number,
            order_number: o.order_number,
            seq:          idx + 1,
            product_id:   it.id   || it.product_id   || '',
            product_name: it.name || it.product_name || '',
            qty:          it.qty  || it.quantity || 1,
            price:        it.price || it.unit_price || 0,
            subtotal:     (it.price||0) * (it.qty||1)
          }));
        }
      } catch {}
    }

    // order_logs
    const orderIds  = orders.map(o => o.id || o.order_number).filter(Boolean);
    const orderLogs = [];
    for (let i = 0; i < orderIds.length; i += 200) {
      const chunk = orderIds.slice(i, i+200);
      const ph = chunk.map(() => '?').join(',');
      try { orderLogs.push(...db.all(`SELECT * FROM order_logs WHERE order_id IN (${ph})`, chunk)); } catch {}
    }

    const ts = tsFile(), fileName = `orders_${ts}.${format}`;
    writeMigrationLog(db, storeId, '匯出訂單', fileName, format,
      { orders: orders.length, order_items_expanded: orderItemsExpanded.length }, 'success', '');

    if (format === 'csv') {
      const headers = ['id','order_number','store_id','order_mode','source',
        'customer_name','customer_phone','payment_method','payment_category',
        'subtotal','total','discount_amount','discount_category',
        'discount_campaign_id','discount_campaign_name',
        'discount_product_ids','discount_product_names',
        'status','order_status','note','pickup_name','pickup_time',
        'delivery_platform','delivery_address','delivery_status',
        'platform_commission_rate','platform_commission_amount','store_actual_income',
        'delivery_fee','created_at','updated_at'];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.send(BOM + toCsv(headers, orders));
    }
    const payload = { type:'orders_backup', version:'fix18-10-hotfix2',
      exported_at: isoNow(), store_id: storeId,
      data: { orders, order_items: orderItemsExpanded, order_logs: orderLogs } };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  訂單匯入  POST /api/import/orders
// ════════════════════════════════════════════════════════════════════════════
router.post('/import/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { orders = [], mode = 'skip' } = req.body;
    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];

    runInTransaction(db, (raw) => {
      for (const o of orders) {
        const orderNo = (o.order_number || '').trim();
        if (!orderNo) { failed++; continue; }
        const items_ = typeof o.items === 'string' ? o.items : JSON.stringify(o.items || []);
        try {
          const existing = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);

          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              rawRun(raw,
                `UPDATE orders SET
                   customer_name=?,customer_phone=?,order_mode=?,source=?,
                   items=?,payment_method=?,payment_category=?,
                   subtotal=?,total=?,discount_amount=?,discount_category=?,
                   discount_campaign_id=?,discount_campaign_name=?,
                   discount_product_ids=?,discount_product_names=?,
                   status=?,order_status=?,note=?,pickup_name=?,pickup_time=?,
                   delivery_platform=?,delivery_address=?,delivery_status=?,
                   platform_commission_rate=?,platform_commission_amount=?,
                   store_actual_income=?,delivery_fee=?,created_at=?,
                   updated_at=datetime('now','localtime')
                 WHERE store_id=? AND order_number=?`,
                [o.customer_name||'',o.customer_phone||'',o.order_mode||'dine_in',o.source||'pos',
                 items_,o.payment_method||'cash',o.payment_category||'cash',
                 o.subtotal||0,o.total||0,
                 o.discount_amount||0,o.discount_category||'none',
                 o.discount_campaign_id||null,o.discount_campaign_name||'',
                 o.discount_product_ids||'',o.discount_product_names||'',
                 o.status||'completed',o.order_status||'completed',o.note||'',
                 o.pickup_name||'',o.pickup_time||'',
                 o.delivery_platform||'',o.delivery_address||'',o.delivery_status||'',
                 o.platform_commission_rate||0,o.platform_commission_amount||0,
                 o.store_actual_income||0,o.delivery_fee||0,o.created_at||'',
                 storeId,orderNo]);
              updated++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              rawRun(raw,
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
                [newNo,newNo,storeId,
                 o.customer_name||'',o.customer_phone||'',o.order_mode||'dine_in',o.source||'pos',
                 items_,o.payment_method||'cash',o.payment_category||'cash',
                 o.subtotal||0,o.total||0,
                 o.discount_amount||0,o.discount_category||'none',
                 o.discount_campaign_id||null,o.discount_campaign_name||'',
                 o.discount_product_ids||'',o.discount_product_names||'',
                 o.status||'completed',o.order_status||'completed',o.note||'',
                 o.pickup_name||'',o.pickup_time||'',
                 o.delivery_platform||'',o.delivery_address||'',o.delivery_status||'',
                 o.platform_commission_rate||0,o.platform_commission_amount||0,
                 o.store_actual_income||0,o.delivery_fee||0,o.created_at||'']);
              added++;
            }
          } else {
            const id = o.id || o.order_number;
            rawRun(raw,
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
              [id,orderNo,storeId,
               o.customer_name||'',o.customer_phone||'',o.order_mode||'dine_in',o.source||'pos',
               items_,o.payment_method||'cash',o.payment_category||'cash',
               o.subtotal||0,o.total||0,
               o.discount_amount||0,o.discount_category||'none',
               o.discount_campaign_id||null,o.discount_campaign_name||'',
               o.discount_product_ids||'',o.discount_product_names||'',
               o.status||'completed',o.order_status||'completed',o.note||'',
               o.pickup_name||'',o.pickup_time||'',
               o.delivery_platform||'',o.delivery_address||'',o.delivery_status||'',
               o.platform_commission_rate||0,o.platform_commission_amount||0,
               o.store_actual_income||0,o.delivery_fee||0,o.created_at||'']);
            added++;
          }
        } catch(e2) { errors.push(`order ${orderNo}: ${e2.message}`); failed++; }
      }
    });

    const summary = { added, updated, skipped, failed };
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
    const payload = { type:'preorders_backup', version:'fix18-10-hotfix2',
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
        const orderNo = (o.order_number || '').trim();
        if (!orderNo) { failed++; continue; }
        const items_ = typeof o.items === 'string' ? o.items : JSON.stringify(o.items || []);
        try {
          const existing = safeGet(db,
            'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);
          if (existing) {
            if (mode === 'skip') { skipped++; continue; }
            if (mode === 'overwrite') {
              rawRun(raw,
                `UPDATE orders SET
                   customer_name=?,customer_phone=?,order_mode=?,source='line',
                   items=?,payment_method=?,subtotal=?,total=?,
                   status=?,order_status=?,note=?,pickup_name=?,pickup_time=?,
                   created_at=?,updated_at=datetime('now','localtime')
                 WHERE store_id=? AND order_number=?`,
                [o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout',
                 items_,o.payment_method||'line_pay',
                 o.subtotal||o.total||0,o.total||0,
                 o.status||'pending',o.order_status||'pending',
                 o.note||'',o.pickup_name||'',o.pickup_time||'',
                 o.created_at||'',storeId,orderNo]);
              updated++;
            } else if (mode === 'copy') {
              const newNo = orderNo + '_copy_' + Date.now();
              rawRun(raw,
                `INSERT INTO orders
                   (id,order_number,store_id,customer_name,customer_phone,
                    order_mode,source,items,payment_method,subtotal,total,
                    status,order_status,note,pickup_name,pickup_time,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [newNo,newNo,storeId,
                 o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
                 items_,o.payment_method||'line_pay',
                 o.subtotal||o.total||0,o.total||0,
                 o.status||'pending',o.order_status||'pending',
                 o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'']);
              added++;
            }
          } else {
            const id = o.id || o.order_number;
            rawRun(raw,
              `INSERT OR IGNORE INTO orders
                 (id,order_number,store_id,customer_name,customer_phone,
                  order_mode,source,items,payment_method,subtotal,total,
                  status,order_status,note,pickup_name,pickup_time,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [id,orderNo,storeId,
               o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
               items_,o.payment_method||'line_pay',
               o.subtotal||o.total||0,o.total||0,
               o.status||'pending',o.order_status||'pending',
               o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'']);
            added++;
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
//  每個資料表依實際 schema 查詢
// ════════════════════════════════════════════════════════════════════════════
router.get('/migration/export', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    const storeRow   = safeGet(db, 'SELECT * FROM stores WHERE store_id=?', [storeId]);
    const products   = safeAll(db, 'SELECT * FROM products   WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const categories = safeAll(db, 'SELECT * FROM categories WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const orders     = safeAll(db, 'SELECT * FROM orders WHERE store_id=? ORDER BY created_at ASC', [storeId]);

    // order_logs
    const orderIds  = orders.map(o => o.id || o.order_number).filter(Boolean);
    const orderLogs = [];
    for (let i = 0; i < orderIds.length; i += 200) {
      const chunk = orderIds.slice(i, i+200);
      const ph = chunk.map(() => '?').join(',');
      try { orderLogs.push(...db.all(`SELECT * FROM order_logs WHERE order_id IN (${ph})`, chunk)); } catch {}
    }

    const preorderNums = orders.filter(o => o.source === 'line').map(o => o.order_number);

    // LINE 商品設定（from products）
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

    // ── discount_categories: id,store_id,code,name,icon,color,enabled,sort_order,created_at ──
    const discountCategories = safeAll(db,
      'SELECT id,store_id,code,name,icon,color,enabled,sort_order,created_at FROM discount_categories WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    // ── discount_campaigns: id,store_id,name,description,enabled,sort_order,created_at ──
    const discountCampaigns = safeAll(db,
      'SELECT id,store_id,name,description,enabled,sort_order,created_at FROM discount_campaigns WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    // ── product_analysis_groups: id,store_id,group_name,description,enabled,sort_order,created_at,updated_at ──
    const analysisGroups = safeAll(db,
      'SELECT id,store_id,group_name,description,enabled,sort_order,created_at,updated_at FROM product_analysis_groups WHERE store_id=? ORDER BY sort_order ASC, id ASC',
      [storeId]);

    // ── product_analysis_group_items: id,store_id,group_id,product_id,product_name,created_at ──
    const analysisItems = analysisGroups.length
      ? safeAll(db,
          `SELECT i.id,i.store_id,i.group_id,i.product_id,i.product_name,i.created_at
           FROM product_analysis_group_items i
           INNER JOIN product_analysis_groups g ON g.id=i.group_id
           WHERE g.store_id=? ORDER BY i.group_id ASC, i.id ASC`,
          [storeId])
      : [];

    // ── product_analysis_group_aliases: id,store_id,group_id,alias_name,created_at ──
    const analysisAliases = analysisGroups.length
      ? safeAll(db,
          `SELECT a.id,a.store_id,a.group_id,a.alias_name,a.created_at
           FROM product_analysis_group_aliases a
           INNER JOIN product_analysis_groups g ON g.id=a.group_id
           WHERE g.store_id=? ORDER BY a.group_id ASC, a.id ASC`,
          [storeId])
      : [];

    const deliveryPlatforms = safeAll(db, 'SELECT * FROM delivery_platforms WHERE store_id=?', [storeId]);
    const deliveryFees      = safeAll(db, 'SELECT * FROM delivery_fees      WHERE store_id=?', [storeId]);
    const settings          = safeAll(db, 'SELECT * FROM settings WHERE store_id=?', [storeId]);

    const ts = tsFile(), fileName = `pos_migration_${storeId}_${ts}.json`;

    const payload = {
      type:           'pos_migration_backup',
      version:        'fix18-10-hotfix2',
      exported_at:    isoNow(),
      store_id:       storeId,
      store_name:     storeRow ? (storeRow.name || storeRow.store_id || storeId) : storeId,
      schema_version: 2,
      data: {
        products, categories,
        orders,
        order_items:  [],        // 無獨立表，items 已在 orders.items JSON 內
        order_logs:   orderLogs,
        preorder_order_numbers: preorderNums,
        line_products: lineProducts,
        inventory,
        discount_categories:             discountCategories,
        discount_campaigns:              discountCampaigns,
        product_analysis_groups:         analysisGroups,
        product_analysis_group_items:    analysisItems,
        product_analysis_group_aliases:  analysisAliases,
        delivery_platforms: deliveryPlatforms,
        delivery_fees:      deliveryFees,
        settings
      }
    };

    const summary = {
      products:            products.length,
      categories:          categories.length,
      orders:              orders.length,
      preorders:           preorderNums.length,
      order_logs:          orderLogs.length,
      discount_categories: discountCategories.length,
      discount_campaigns:  discountCampaigns.length,
      analysis_groups:     analysisGroups.length,
      analysis_items:      analysisItems.length,
      analysis_aliases:    analysisAliases.length,
      settings:            settings.length
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
//  只讀，不寫 DB
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
      version: payload.version || '', exported_at: payload.exported_at || '',
      store_name: payload.store_name || '',
      summary
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯入  POST /api/migration/import
//  所有 INSERT/UPDATE/DELETE 改用 rawRun(raw,...) 不呼叫 save()
// ════════════════════════════════════════════════════════════════════════════
router.post('/migration/import', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';
    const { payload, mode = 'skip', allowCrossStoreImport = false } = req.body;

    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    // 跨店保護
    const fileStoreId  = payload.store_id || storeId;
    const isCrossStore = fileStoreId !== storeId;
    if (isCrossStore && !allowCrossStoreImport) {
      return res.status(403).json({
        success: false, cross_store: true, file_store_id: fileStoreId,
        message: `備份檔屬於 ${fileStoreId}，目前店家是 ${storeId}。跨店匯入需使用者明確確認。`
      });
    }

    const d = payload.data || {};
    const results = {
      categories:0, products:0, orders:0, order_logs:0,
      discount_categories:0, discount_campaigns:0,
      analysis_groups:0, analysis_items:0, analysis_aliases:0,
      settings:0, delivery_platforms:0, delivery_fees:0,
      skipped:0, failed:0, errors:[]
    };

    // mode → SQL keyword
    const orMode = (mode === 'overwrite') ? 'OR REPLACE' : 'OR IGNORE';

    runInTransaction(db, (raw) => {

      // ── replace：清空本店（精確 store_id 隔離）────────────────────────
      if (mode === 'replace') {
        const purgeByStore = [
          'orders','products','categories',
          'discount_categories','discount_campaigns',
          'product_analysis_group_items','product_analysis_group_aliases',
          'product_analysis_groups','inventory'
        ];
        for (const t of purgeByStore) {
          try { rawRun(raw, `DELETE FROM ${t} WHERE store_id=?`, [storeId]); } catch(e) {
            console.warn(`[replace] DELETE ${t}:`, e.message);
          }
        }
        // order_logs 透過 order_id 關聯
        try {
          const ids = safeAll(db, 'SELECT id FROM orders WHERE store_id=?', [storeId]).map(r=>r.id);
          for (let i=0; i<ids.length; i+=200) {
            const chunk=ids.slice(i,i+200), ph=chunk.map(()=>'?').join(',');
            try { rawRun(raw, `DELETE FROM order_logs WHERE order_id IN (${ph})`, chunk); } catch {}
          }
        } catch {}
        try { rawRun(raw, `DELETE FROM settings WHERE store_id=?`, [storeId]); } catch {}
        try { rawRun(raw, `DELETE FROM delivery_platforms WHERE store_id=?`, [storeId]); } catch {}
        try { rawRun(raw, `DELETE FROM delivery_fees WHERE store_id=?`, [storeId]); } catch {}
      }

      // ── categories: id,store_id,name,icon,sort_order,is_active,created_at ──
      for (const c of (d.categories||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO categories (id,store_id,name,icon,sort_order,is_active,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [c.id,storeId,c.name||'',c.icon||'📌',c.sort_order||0,c.is_active??1,c.created_at||'']);
          results.categories++;
        } catch(e) { results.errors.push(`[cat id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── products ──────────────────────────────────────────────────────────
      for (const p of (d.products||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO products
               (id,store_id,name,category,category_id,price,
                allocated_grams,current_stock_grams,low_stock_alert,
                show_on_line,line_price,line_description,line_image_url,line_category,
                line_hot,line_promo,line_sold_out,image,sort_order,sale_status,
                inventory_enabled,
                line_preorder_enabled,line_preorder_daily,
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
          results.products++;
        } catch(e) { results.errors.push(`[prod id=${p.id}] ${e.message}`); results.failed++; }
      }

      // ── orders ─────────────────────────────────────────────────────────────
      for (const o of (d.orders||[])) {
        try {
          const id     = o.id || o.order_number;
          const items_ = typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]);
          rawRun(raw,
            `INSERT ${orMode} INTO orders
               (id,order_number,store_id,
                customer_name,customer_phone,customer_line_id,
                items,payment_method,payment_category,
                subtotal,total,status,order_status,order_mode,source,
                received_amount,change_amount,note,
                void_reason,voided_at,table_number,guest_count,
                pickup_name,pickup_time,
                delivery_platform,delivery_address,estimated_delivery,
                delivery_status,delivery_fee,
                platform_commission_rate,platform_commission_amount,store_actual_income,
                platform_order_no,
                discount_amount,discount_type,discount_category,discount_note,original_total,
                discount_campaign_id,discount_campaign_name,discount_target_type,
                discount_product_id,discount_product_name,
                discount_product_ids,discount_product_names,
                kitchen_status,payment_status,
                uuid,sync_status,device_id,
                created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [id,o.order_number,storeId,
             o.customer_name||'',o.customer_phone||'',o.customer_line_id||'',
             items_,o.payment_method||'cash',o.payment_category||'cash',
             o.subtotal||0,o.total||0,o.status||'completed',o.order_status||'completed',
             o.order_mode||'dine_in',o.source||'pos',
             o.received_amount||0,o.change_amount||0,o.note||'',
             o.void_reason||'',o.voided_at||'',o.table_number||'',o.guest_count||0,
             o.pickup_name||'',o.pickup_time||'',
             o.delivery_platform||'',o.delivery_address||'',o.estimated_delivery||'',
             o.delivery_status||'',o.delivery_fee||0,
             o.platform_commission_rate||0,o.platform_commission_amount||0,o.store_actual_income||0,
             o.platform_order_no||'',
             o.discount_amount||0,o.discount_type||'none',o.discount_category||'none',
             o.discount_note||'',o.original_total||o.total||0,
             o.discount_campaign_id||null,o.discount_campaign_name||'',o.discount_target_type||'order',
             o.discount_product_id||'',o.discount_product_name||'',
             o.discount_product_ids||'',o.discount_product_names||'',
             o.kitchen_status||'pending',o.payment_status||'paid',
             o.uuid||id,o.sync_status||'synced',o.device_id||'',
             o.created_at||'',o.updated_at||'']);
          results.orders++;
        } catch(e) { results.errors.push(`[order ${o.order_number}] ${e.message}`); results.failed++; }
      }

      // ── order_logs ──────────────────────────────────────────────────────────
      for (const ol of (d.order_logs||[])) {
        try {
          rawRun(raw,
            `INSERT OR IGNORE INTO order_logs
               (id,order_id,action,old_value,new_value,note,operator,created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [ol.id,ol.order_id,ol.action||'',ol.old_value||'',
             ol.new_value||'',ol.note||'',ol.operator||'',ol.created_at||'']);
          results.order_logs++;
        } catch(e) { results.errors.push(`[order_log id=${ol.id}] ${e.message}`); results.failed++; }
      }

      // ── discount_categories: id,store_id,code,name,icon,color,enabled,sort_order,created_at ──
      for (const c of (d.discount_categories||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO discount_categories
               (id,store_id,code,name,icon,color,enabled,sort_order,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [c.id,storeId,c.code||'',
             c.name||c.label||'',          // 相容舊格式 label
             c.icon||'💸',
             c.color||'#94a3b8',
             c.enabled??c.is_active??1,
             c.sort_order||0,c.created_at||'']);
          results.discount_categories++;
        } catch(e) { results.errors.push(`[disc_cat id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── discount_campaigns: id,store_id,name,description,enabled,sort_order,created_at ──
      for (const c of (d.discount_campaigns||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO discount_campaigns
               (id,store_id,name,description,enabled,sort_order,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [c.id,storeId,c.name||'',
             c.description||'',
             c.enabled??c.is_active??1,
             c.sort_order||0,c.created_at||'']);
          results.discount_campaigns++;
        } catch(e) { results.errors.push(`[disc_camp id=${c.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_groups: id,store_id,group_name,description,enabled,sort_order,created_at,updated_at ──
      for (const g of (d.product_analysis_groups||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO product_analysis_groups
               (id,store_id,group_name,description,enabled,sort_order,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            [g.id,storeId,
             g.group_name||g.name||'',     // 相容舊格式 name
             g.description||'',
             g.enabled??g.is_active??1,
             g.sort_order||0,
             g.created_at||'',g.updated_at||g.created_at||'']);
          results.analysis_groups++;
        } catch(e) { results.errors.push(`[group id=${g.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_group_items: id,store_id,group_id,product_id,product_name,created_at ──
      for (const gi of (d.product_analysis_group_items||[])) {
        try {
          // product_name 若備份已有則用，否則查 products
          const pName = gi.product_name
            || (safeGet(db,'SELECT name FROM products WHERE id=?',[gi.product_id])?.name)
            || '';
          rawRun(raw,
            `INSERT ${orMode} INTO product_analysis_group_items
               (id,store_id,group_id,product_id,product_name,created_at)
             VALUES (?,?,?,?,?,?)`,
            [gi.id,storeId,gi.group_id,gi.product_id,pName,gi.created_at||'']);
          results.analysis_items++;
        } catch(e) { results.errors.push(`[group_item id=${gi.id}] ${e.message}`); results.failed++; }
      }

      // ── product_analysis_group_aliases: id,store_id,group_id,alias_name,created_at ──
      for (const a of (d.product_analysis_group_aliases||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO product_analysis_group_aliases
               (id,store_id,group_id,alias_name,created_at)
             VALUES (?,?,?,?,?)`,
            [a.id,storeId,a.group_id,a.alias_name||'',a.created_at||'']);
          results.analysis_aliases++;
        } catch(e) { results.errors.push(`[alias id=${a.id}] ${e.message}`); results.failed++; }
      }

      // ── settings ────────────────────────────────────────────────────────────
      for (const s of (d.settings||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO settings (store_id,key,value) VALUES (?,?,?)`,
            [storeId,s.key||'',s.value||'']);
          results.settings++;
        } catch(e) { results.errors.push(`[setting key=${s.key}] ${e.message}`); results.failed++; }
      }

      // ── delivery_platforms ──────────────────────────────────────────────────
      for (const p of (d.delivery_platforms||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO delivery_platforms
               (id,store_id,code,name,is_active,commission_rate,created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [p.id,storeId,p.code||'',p.name||'',p.is_active??1,p.commission_rate||0,p.created_at||'']);
          results.delivery_platforms++;
        } catch(e) { results.errors.push(`[platform id=${p.id}] ${e.message}`); results.failed++; }
      }

      // ── delivery_fees ───────────────────────────────────────────────────────
      for (const f of (d.delivery_fees||[])) {
        try {
          rawRun(raw,
            `INSERT ${orMode} INTO delivery_fees
               (id,store_id,min_amount,max_amount,fee,created_at)
             VALUES (?,?,?,?,?,?)`,
            [f.id,storeId,f.min_amount||0,f.max_amount||0,f.fee||0,f.created_at||'']);
          results.delivery_fees++;
        } catch(e) { results.errors.push(`[fee id=${f.id}] ${e.message}`); results.failed++; }
      }

    }); // ── end runInTransaction ──────────────────────────────────────────────

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
