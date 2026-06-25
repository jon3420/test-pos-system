// routes/migration.js — fix18-10-hotfix9
//
// fix18-10-hotfix9 新增：完整快速搬家（食材庫存＋商品扣料公式＋店家營運資料）
//
// 新增 Backup 資料：
//   ingredients（食材主表）
//   product_ingredient_formulas（商品扣料公式）
//   ingredient_logs（食材異動紀錄）
//   ingredient_batches（批號管理）
//   ingredient_thaw_batches（解凍批次）
//   inventory_logs（庫存變動紀錄）
//
// 新增 Restore：
//   ingredients：id remap，以 (store_id, name) 防重複，跨店不衝突
//   product_ingredient_formulas：product_id / ingredient_id 依 remap 重建
//   ingredient_logs / ingredient_batches / ingredient_thaw_batches：依 ingredient_id remap 重建
//   inventory_logs：依 product_id remap（products 表）重建
//
// 第四階段：Replace 模式全面支援 tableExists 保護
// 第五階段：Merge 模式以 (store_id, name) 判重，不受跨店 PK 影響
// 第六階段：Backup 預覽新增食材 / 扣料公式 / 異動紀錄等統計
// 第七階段：Restore 完成後可驗證食材、公式、庫存設定
// 第八階段：舊版 Backup 缺少欄位直接略過，不 rollback
// 第九階段：不破壞既有流程
//
// 繼承 fix18-10-hotfix8 全部修正：
//   BUG-1: LINE 點餐切換外送後 deliveryAddrWrap 不顯示
//   BUG-2: replace 模式 no such table: inventory → tableExists 保護
//   BUG-3: delivery_platforms 硬寫 code 欄位 → PRAGMA 動態欄位
//   BUG-4: INTEGER PK 跨店衝突 → 不寫 id，以 (store_id, name) 判重

'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── CSV helpers ────────────────────────────────────────────────────────────
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

// ── Timestamp ──────────────────────────────────────────────────────────────
function tsFile() {
  const d = new Date(), p = (n, l=2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function isoNow() { return new Date().toISOString(); }

// ── migration_logs ─────────────────────────────────────────────────────────
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

// ── safe read wrappers ─────────────────────────────────────────────────────
function safeAll(db, sql, params) {
  try { return db.all(sql, params); } catch { return []; }
}
function safeGet(db, sql, params) {
  try { return db.get(sql, params); } catch { return null; }
}

// ── ensure discount tables ─────────────────────────────────────────────────
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

// ── PRAGMA: 取實際欄位（回傳 Set<string>）────────────────────────────────
function getTableCols(db, table) {
  try {
    const rows = db.all(`PRAGMA table_info(${table})`);
    return new Set(rows.map(r => r.name));
  } catch { return new Set(); }
}

// ── 檢查資料表是否存在 ─────────────────────────────────────────────────────
function tableExists(db, tableName) {
  try {
    const row = db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName]
    );
    return !!row;
  } catch { return false; }
}
// rawTableExists：在 transaction 內用 raw sql.js db 檢查
function rawTableExists(raw, tableName) {
  try {
    const stmt = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    );
    stmt.bind([tableName]);
    const exists = stmt.step();
    stmt.free();
    return exists;
  } catch { return false; }
}

// ── safeRawAll：在 transaction 內安全查詢 ─────────────────────────────────
function safeRawAll(raw, sql, params) {
  try {
    const stmt = raw.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch { return []; }
}

// ── safeExportTable：匯出前先確認資料表存在 ───────────────────────────────
function safeExportAll(db, tableName, where, params) {
  try {
    if (!tableExists(db, tableName)) {
      console.warn(`[migration/export] table ${tableName} not found, skipping`);
      return [];
    }
    return safeAll(db, `SELECT * FROM ${tableName} WHERE ${where}`, params);
  } catch(e) {
    console.warn(`[migration/export] ${tableName} error:`, e.message);
    return [];
  }
}

// ── 通用動態 INSERT helper ─────────────────────────────────────────────────
function buildDynamicInsert(table, candidates, srcObj, colSet, orMode) {
  const cols = candidates.filter(c => colSet.has(c));
  if (!cols.length) return null;
  const vals = cols.map(c => srcObj[c] ?? null);
  const phs  = cols.map(()=>'?').join(',');
  return {
    sql: `INSERT ${orMode} INTO ${table} (${cols.join(',')}) VALUES (${phs})`,
    vals
  };
}

// ─── rawRun helpers ────────────────────────────────────────────────────────
function rawRun(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
}
function rawRunCount(raw, sql, params) {
  const stmt = raw.prepare(sql);
  stmt.run(Array.isArray(params) ? params : []);
  stmt.free();
  return raw.getRowsModified ? raw.getRowsModified() : 1;
}

// ── safeRawDelete：只有 table 存在才刪，不存在就 warn ────────────────────
function safeRawDelete(raw, tableName, where, params) {
  if (!rawTableExists(raw, tableName)) {
    console.warn(`[migration] table ${tableName} not found, skipping DELETE`);
    return;
  }
  try { rawRun(raw, `DELETE FROM ${tableName} WHERE ${where}`, params); }
  catch(e) { console.warn(`[migration] skip DELETE ${tableName}:`, e.message); }
}

// ── runInTransaction ───────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════
//  訂單匯出  GET /api/export/orders
// ══════════════════════════════════════════════════════════════════════════
router.get('/export/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
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

    const payload = { type:'orders_backup', version:'fix18-10-hotfix9',
      exported_at: isoNow(), store_id: storeId,
      data: { orders, order_items: orderItemsExpanded, order_logs: orderLogs } };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  訂單匯入  POST /api/import/orders
// ══════════════════════════════════════════════════════════════════════════
router.post('/import/orders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    const { orders = [], mode = 'skip' } = req.body;
    let added = 0, updated = 0, skipped = 0, failed = 0;
    const errors = [];
    let minDate = '', maxDate = '';

    const validCols = getTableCols(db, 'orders');
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
              const updCols = importCols.filter(c => !['id','order_number','store_id'].includes(c));
              const updSql = `UPDATE orders SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND order_number=?`;
              const allVals = buildVals(o, storeId);
              const colIdx  = Object.fromEntries(importCols.map((c,i)=>[c,i]));
              const updVals = [...updCols.map(c => allVals[colIdx[c]] ?? null), storeId, orderNo];
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

// ══════════════════════════════════════════════════════════════════════════
//  LINE 預購匯出  GET /api/export/preorders
// ══════════════════════════════════════════════════════════════════════════
router.get('/export/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
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
    const payload = { type:'preorders_backup', version:'fix18-10-hotfix9',
      exported_at: isoNow(), store_id: storeId, data: { preorders } };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  LINE 預購匯入  POST /api/import/preorders
// ══════════════════════════════════════════════════════════════════════════
router.post('/import/preorders', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
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
              const safeId = storeId + '_' + newNo;
              const n = rawRunCount(raw,
                `INSERT OR REPLACE INTO orders
                   (id,order_number,store_id,customer_name,customer_phone,order_mode,source,
                    items,payment_method,subtotal,total,status,order_status,note,pickup_name,pickup_time,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [safeId,newNo,storeId,o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
                 items_,o.payment_method||'line_pay',o.subtotal||o.total||0,o.total||0,
                 o.status||'pending',o.order_status||'pending',o.note||'',o.pickup_name||'',o.pickup_time||'',o.created_at||'']);
              if (n > 0) added++; else skipped++;
            }
          } else {
            const safeId = storeId + '_' + orderNo;
            const n = rawRunCount(raw,
              `INSERT OR REPLACE INTO orders
                 (id,order_number,store_id,customer_name,customer_phone,order_mode,source,
                  items,payment_method,subtotal,total,status,order_status,note,pickup_name,pickup_time,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [safeId,orderNo,storeId,o.customer_name||'',o.customer_phone||'',o.order_mode||'takeout','line',
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

// ══════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯出  GET /api/migration/export
//  fix18-10-hotfix9：新增 ingredients / product_ingredient_formulas /
//                    ingredient_logs / ingredient_batches /
//                    ingredient_thaw_batches / inventory_logs
// ══════════════════════════════════════════════════════════════════════════
router.get('/migration/export', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

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
      line_preorder_high_threshold: p.line_preorder_high_threshold,
      // fix18-10-hotfix9: LINE quota 管理欄位
      line_quota_enabled: p.line_quota_enabled,
      line_quota_daily: p.line_quota_daily,
      line_quota_sold: p.line_quota_sold,
      line_quota_low_threshold: p.line_quota_low_threshold,
      line_quota_high_threshold: p.line_quota_high_threshold,
      line_sell_start: p.line_sell_start,
      line_sell_end: p.line_sell_end,
      sale_status: p.sale_status
    }));

    // ── hotfix9: inventory（從 products 讀取）────────────────────────────
    const inventory = safeAll(db, 'SELECT * FROM inventory WHERE store_id=?', [storeId]).catch
      ? []
      : (() => {
          try { return safeAll(db, 'SELECT * FROM inventory WHERE store_id=?', [storeId]); }
          catch { return []; }
        })();

    // ── hotfix9: 食材相關資料表（全部有 store_id）────────────────────────
    const ingredients         = safeExportAll(db, 'ingredients', 'store_id=?', [storeId]);
    // inventory_logs 有 store_id
    const inventoryLogs       = safeExportAll(db, 'inventory_logs', 'store_id=?', [storeId]);
    // product_ingredient_formulas 無 store_id，透過 product_id join
    let   productIngFormulas  = [];
    if (tableExists(db, 'product_ingredient_formulas') && products.length) {
      const productIds = products.map(p => p.id);
      for (let i = 0; i < productIds.length; i += 200) {
        const chunk = productIds.slice(i, i+200);
        const ph = chunk.map(()=>'?').join(',');
        try {
          productIngFormulas.push(...db.all(
            `SELECT f.*, p.name as product_name, i.name as ingredient_name
             FROM product_ingredient_formulas f
             LEFT JOIN products p ON p.id=f.product_id
             LEFT JOIN ingredients i ON i.id=f.ingredient_id
             WHERE f.product_id IN (${ph})`,
            chunk
          ));
        } catch {}
      }
    }
    // ingredient_logs 無 store_id，透過 ingredient_id join
    let ingredientLogs = [];
    if (tableExists(db, 'ingredient_logs') && ingredients.length) {
      const ingIds = ingredients.map(i => i.id);
      for (let i = 0; i < ingIds.length; i += 200) {
        const chunk = ingIds.slice(i, i+200);
        const ph = chunk.map(()=>'?').join(',');
        try {
          ingredientLogs.push(...db.all(
            `SELECT il.* FROM ingredient_logs il WHERE il.ingredient_id IN (${ph}) ORDER BY il.created_at ASC LIMIT 5000`,
            chunk
          ));
        } catch {}
      }
    }
    // ingredient_batches 無 store_id，透過 ingredient_id join
    let ingredientBatches = [];
    if (tableExists(db, 'ingredient_batches') && ingredients.length) {
      const ingIds = ingredients.map(i => i.id);
      for (let i = 0; i < ingIds.length; i += 200) {
        const chunk = ingIds.slice(i, i+200);
        const ph = chunk.map(()=>'?').join(',');
        try {
          ingredientBatches.push(...db.all(
            `SELECT * FROM ingredient_batches WHERE ingredient_id IN (${ph})`,
            chunk
          ));
        } catch {}
      }
    }
    // ingredient_thaw_batches 無 store_id，透過 ingredient_id join
    let ingredientThawBatches = [];
    if (tableExists(db, 'ingredient_thaw_batches') && ingredients.length) {
      const ingIds = ingredients.map(i => i.id);
      for (let i = 0; i < ingIds.length; i += 200) {
        const chunk = ingIds.slice(i, i+200);
        const ph = chunk.map(()=>'?').join(',');
        try {
          ingredientThawBatches.push(...db.all(
            `SELECT * FROM ingredient_thaw_batches WHERE ingredient_id IN (${ph})`,
            chunk
          ));
        } catch {}
      }
    }

    const discountCategories = safeAll(db,
      'SELECT * FROM discount_categories WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const discountCampaigns = safeAll(db,
      'SELECT * FROM discount_campaigns WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);

    const analysisGroups = safeAll(db,
      'SELECT * FROM product_analysis_groups WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const analysisItems = analysisGroups.length
      ? safeAll(db,
          `SELECT i.* FROM product_analysis_group_items i
           INNER JOIN product_analysis_groups g ON g.id=i.group_id
           WHERE g.store_id=? ORDER BY i.group_id ASC, i.id ASC`, [storeId])
      : [];
    const analysisAliases = analysisGroups.length
      ? safeAll(db,
          `SELECT a.* FROM product_analysis_group_aliases a
           INNER JOIN product_analysis_groups g ON g.id=a.group_id
           WHERE g.store_id=? ORDER BY a.group_id ASC, a.id ASC`, [storeId])
      : [];

    const deliveryPlatforms = safeAll(db, 'SELECT * FROM delivery_platforms WHERE store_id=?', [storeId]);
    const deliveryFees      = safeAll(db, 'SELECT * FROM delivery_fees      WHERE store_id=?', [storeId]);
    const settings          = safeAll(db, 'SELECT * FROM settings WHERE store_id=?', [storeId]);

    const ts = tsFile(), fileName = `pos_migration_${storeId}_${ts}.json`;

    const payload = {
      type: 'pos_migration_backup', version: 'fix18-10-hotfix9',
      exported_at: isoNow(), store_id: storeId,
      store_name: storeRow ? (storeRow.name||storeRow.store_id||storeId) : storeId,
      schema_version: 3,
      data: {
        products, categories, orders,
        order_items: [],
        order_logs: orderLogs,
        preorder_order_numbers: preorderNums,
        line_products: lineProducts,
        inventory,
        // hotfix9: 新增食材營運資料
        ingredients,
        product_ingredient_formulas: productIngFormulas,
        ingredient_logs: ingredientLogs,
        ingredient_batches: ingredientBatches,
        ingredient_thaw_batches: ingredientThawBatches,
        inventory_logs: inventoryLogs,
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
      ingredients: ingredients.length,
      product_ingredient_formulas: productIngFormulas.length,
      ingredient_logs: ingredientLogs.length,
      ingredient_batches: ingredientBatches.length,
      ingredient_thaw_batches: ingredientThawBatches.length,
      inventory_logs: inventoryLogs.length,
      discount_categories: discountCategories.length,
      discount_campaigns: discountCampaigns.length,
      analysis_groups: analysisGroups.length,
      analysis_items: analysisItems.length,
      analysis_aliases: analysisAliases.length,
      settings: settings.length,
      delivery_platforms: deliveryPlatforms.length,
      delivery_fees: deliveryFees.length
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

// ══════════════════════════════════════════════════════════════════════════
//  Preview  POST /api/migration/import/preview
//  hotfix9：新增 ingredients / formulas / logs 統計
// ══════════════════════════════════════════════════════════════════════════
router.post('/migration/import/preview', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    const payload = req.body;

    if (!payload || payload.type !== 'pos_migration_backup') {
      return res.status(400).json({ success: false, message: '無效的備份檔格式（type 不符）' });
    }

    const fileStoreId = payload.store_id || '';
    const crossStore  = !!(fileStoreId && fileStoreId !== storeId);
    const d = payload.data || {};

    const allDates = (d.orders||[]).map(o => (o.created_at||'').slice(0,10)).filter(Boolean).sort();
    const dateRange = allDates.length
      ? { min: allDates[0], max: allDates[allDates.length-1] }
      : null;

    const summary = {
      products:                      (d.products                        || []).length,
      categories:                    (d.categories                      || []).length,
      orders:                        (d.orders                          || []).length,
      order_logs:                    (d.order_logs                      || []).length,
      preorders:                     (d.orders||[]).filter(o=>o.source==='line').length,
      // hotfix9：新增
      ingredients:                   (d.ingredients                     || []).length,
      product_ingredient_formulas:   (d.product_ingredient_formulas     || []).length,
      ingredient_logs:               (d.ingredient_logs                 || []).length,
      ingredient_batches:            (d.ingredient_batches              || []).length,
      ingredient_thaw_batches:       (d.ingredient_thaw_batches         || []).length,
      inventory_logs:                (d.inventory_logs                  || []).length,
      discount_categories:           (d.discount_categories             || []).length,
      discount_campaigns:            (d.discount_campaigns              || []).length,
      product_analysis_groups:       (d.product_analysis_groups         || []).length,
      product_analysis_group_items:  (d.product_analysis_group_items    || []).length,
      product_analysis_group_aliases:(d.product_analysis_group_aliases  || []).length,
      settings:                      (d.settings                        || []).length,
      delivery_platforms:            (d.delivery_platforms              || []).length,
      delivery_fees:                 (d.delivery_fees                   || []).length
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

// ══════════════════════════════════════════════════════════════════════════
//  快速搬家檔匯入  POST /api/migration/import
//  hotfix9：完整支援 ingredients / formulas / logs，含 ID remap
// ══════════════════════════════════════════════════════════════════════════
router.post('/migration/import', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    console.log('[migration/import] HOTFIX10 ACTIVE', new Date().toISOString(), 'storeId=', storeId);
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

    try { ensureDiscountCategoriesTable(db); } catch {}
    try { ensureDiscountCampaignsTable(db); } catch {}

    const d = payload.data || {};

    // 結果計數器
    const results = {
      categories:         { added:0, skipped:0, failed:0, errors:[] },
      products:           { added:0, skipped:0, failed:0, errors:[] },
      orders:             { added:0, updated:0, skipped:0, failed:0, errors:[] },
      order_logs:         { added:0, skipped:0, failed:0, errors:[] },
      // hotfix9
      ingredients:              { added:0, skipped:0, failed:0, errors:[] },
      product_ingredient_formulas: { added:0, skipped:0, failed:0, errors:[] },
      ingredient_logs:          { added:0, skipped:0, failed:0, errors:[] },
      ingredient_batches:       { added:0, skipped:0, failed:0, errors:[] },
      ingredient_thaw_batches:  { added:0, skipped:0, failed:0, errors:[] },
      inventory_logs:           { added:0, skipped:0, failed:0, errors:[] },
      discount_categories:{ added:0, skipped:0, failed:0, errors:[] },
      discount_campaigns: { added:0, skipped:0, failed:0, errors:[] },
      analysis_groups:    { added:0, skipped:0, failed:0, errors:[] },
      analysis_items:     { added:0, skipped:0, failed:0, errors:[] },
      analysis_aliases:   { added:0, skipped:0, failed:0, errors:[] },
      settings:           { added:0, skipped:0, failed:0, errors:[] },
      delivery_platforms: { added:0, skipped:0, failed:0, errors:[] },
      delivery_fees:      { added:0, skipped:0, failed:0, errors:[] }
    };

    // 預先讀取所有資料表的實際欄位
    const schemas = {};
    const tableMap = {
      categories:   'categories',
      products:     'products',
      orders:       'orders',
      order_logs:   'order_logs',
      ingredients:  'ingredients',
      product_ingredient_formulas: 'product_ingredient_formulas',
      ingredient_logs:   'ingredient_logs',
      ingredient_batches: 'ingredient_batches',
      ingredient_thaw_batches: 'ingredient_thaw_batches',
      inventory_logs: 'inventory_logs',
      discount_categories:  'discount_categories',
      discount_campaigns:   'discount_campaigns',
      analysis_groups:   'product_analysis_groups',
      analysis_items:    'product_analysis_group_items',
      analysis_aliases:  'product_analysis_group_aliases',
      settings:          'settings',
      delivery_platforms: 'delivery_platforms',
      delivery_fees:      'delivery_fees'
    };
    for (const [k, tbl] of Object.entries(tableMap)) {
      schemas[k] = getTableCols(db, tbl);
    }

    const orMode = (mode === 'overwrite') ? 'OR REPLACE' : 'OR IGNORE';
    const strictMode = (mode === 'replace');

    try {
      runInTransaction(db, (raw) => {

        // ── replace：清本店資料 ────────────────────────────────────────
        if (mode === 'replace') {
          // 核心資料表（一定存在）
          const purgeCore = ['orders','products','categories',
            'discount_categories','discount_campaigns',
            'product_analysis_group_items','product_analysis_group_aliases',
            'product_analysis_groups'];
          for (const t of purgeCore) {
            rawRun(raw, `DELETE FROM ${t} WHERE store_id=?`, [storeId]);
          }
          // 可能不存在的資料表（全部用 safeRawDelete）
          const purgeSafe = [
            'inventory','inventory_logs','inventory_recipes',
            // hotfix9 新增：食材系列（有 store_id）
            'ingredients'
          ];
          for (const t of purgeSafe) {
            safeRawDelete(raw, t, 'store_id=?', [storeId]);
          }
          // 食材關聯表（無 store_id，需先找本店 ingredient ids，再刪）
          if (rawTableExists(raw, 'ingredients')) {
            try {
              const ingRows = safeRawAll(raw,
                `SELECT id FROM ingredients WHERE store_id=?`, [storeId]);
              if (ingRows.length) {
                const ingIds = ingRows.map(r => r.id);
                for (let i = 0; i < ingIds.length; i += 200) {
                  const chunk = ingIds.slice(i, i+200);
                  const ph = chunk.map(()=>'?').join(',');
                  for (const t of ['ingredient_logs','ingredient_batches','ingredient_thaw_batches']) {
                    safeRawDelete(raw, t, `ingredient_id IN (${ph})`, chunk);
                  }
                }
              }
            } catch(e) { console.warn('[migration] ingredient related delete:', e.message); }
          }
          // product_ingredient_formulas（無 store_id，依本店 product_id）
          if (rawTableExists(raw, 'products') && rawTableExists(raw, 'product_ingredient_formulas')) {
            try {
              const prodRows = safeRawAll(raw,
                `SELECT id FROM products WHERE store_id=?`, [storeId]);
              if (prodRows.length) {
                const prodIds = prodRows.map(r => r.id);
                for (let i = 0; i < prodIds.length; i += 200) {
                  const chunk = prodIds.slice(i, i+200);
                  const ph = chunk.map(()=>'?').join(',');
                  safeRawDelete(raw, 'product_ingredient_formulas', `product_id IN (${ph})`, chunk);
                }
              }
            } catch(e) { console.warn('[migration] formula delete:', e.message); }
          }
          // orders 的 order_logs
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

        // ── categories（不寫 id，避免跨店 PK 衝突）────────────────────
        const catCols = schemas['categories'];
        const catInsertCandidates = ['store_id','name','icon','sort_order','is_active','created_at'];
        for (const c of (d.categories||[])) {
          try {
            const existCat = safeGet(db,
              'SELECT id FROM categories WHERE store_id=? AND name=?', [storeId, c.name||'']);
            if (existCat) {
              if (mode === 'skip' || mode === 'replace') { results.categories.skipped++; continue; }
              if (mode === 'overwrite') {
                const n = rawRunCount(raw,
                  `UPDATE categories SET icon=?,sort_order=?,is_active=? WHERE store_id=? AND name=?`,
                  [c.icon||'📌', c.sort_order||0, c.is_active??1, storeId, c.name||'']);
                if (n > 0) results.categories.added++; else results.categories.skipped++;
              } else { results.categories.skipped++; }
              continue;
            }
            const src = {
              store_id: storeId,
              name: c.name||'', icon: c.icon||'📌',
              sort_order: c.sort_order||0, is_active: c.is_active??1,
              created_at: c.created_at||''
            };
            const q = buildDynamicInsert('categories', catInsertCandidates, src, catCols, 'OR IGNORE');
            if (!q) { results.categories.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.categories.added++; else results.categories.skipped++;
          } catch(e) {
            results.categories.errors.push(`name=${c.name}: ${e.message}`);
            results.categories.failed++;
            if (strictMode) throw e;
          }
        }

        // category name → 新 id 對照（供 products 更新 category_id）
        // ★ 在 raw（transaction 內）查，確保能看到剛插入的 categories
        const catNameToId = {};
        try {
          const newCats = safeRawAll(raw, 'SELECT id,name FROM categories WHERE store_id=?', [storeId]);
          for (const nc of newCats) catNameToId[nc.name] = nc.id;
        } catch {}

        // ── products（不寫 id，避免跨店 PK 衝突）──────────────────────
        const prodCols = schemas['products'];
        const prodInsertCandidates = [
          'store_id','name','category','category_id','price',
          'allocated_grams','current_stock_grams','low_stock_alert',
          'show_on_line','line_price','line_description','line_image_url','line_category',
          'line_hot','line_promo','line_sold_out','image','sort_order','sale_status',
          'inventory_enabled','line_preorder_enabled','line_preorder_daily','line_preorder_sold',
          'line_preorder_low_threshold','line_preorder_high_threshold',
          // hotfix9: LINE quota
          'line_quota_enabled','line_quota_daily','line_quota_sold',
          'line_quota_low_threshold','line_quota_high_threshold',
          'line_sell_start','line_sell_end',
          'created_at','updated_at'
        ];
        for (const p of (d.products||[])) {
          try {
            const existProd = safeGet(db,
              'SELECT id FROM products WHERE store_id=? AND name=?', [storeId, p.name||'']);
            const remappedCatId = catNameToId[p.category||''] || p.category_id || null;
            if (existProd) {
              if (mode === 'skip' || mode === 'replace') { results.products.skipped++; continue; }
              if (mode === 'overwrite') {
                const updSrc = {
                  store_id: storeId, name: p.name||'',
                  category: p.category||'', category_id: remappedCatId,
                  price: p.price||0, allocated_grams: p.allocated_grams||0,
                  current_stock_grams: p.current_stock_grams||0, low_stock_alert: p.low_stock_alert||5,
                  show_on_line: p.show_on_line??1, line_price: p.line_price||0,
                  line_description: p.line_description||'', line_image_url: p.line_image_url||'',
                  line_category: p.line_category||'', line_hot: p.line_hot||0,
                  line_promo: p.line_promo||0, line_sold_out: p.line_sold_out||0,
                  image: p.image||'', sort_order: p.sort_order||0,
                  sale_status: p.sale_status||'available', inventory_enabled: p.inventory_enabled||0,
                  line_preorder_enabled: p.line_preorder_enabled||0,
                  line_preorder_daily: p.line_preorder_daily||0,
                  line_preorder_sold: p.line_preorder_sold||0,
                  line_preorder_low_threshold: p.line_preorder_low_threshold||2,
                  line_preorder_high_threshold: p.line_preorder_high_threshold||10,
                  line_quota_enabled: p.line_quota_enabled||0,
                  line_quota_daily: p.line_quota_daily||0,
                  line_quota_sold: p.line_quota_sold||0,
                  line_quota_low_threshold: p.line_quota_low_threshold||2,
                  line_quota_high_threshold: p.line_quota_high_threshold||10,
                  line_sell_start: p.line_sell_start||'',
                  line_sell_end: p.line_sell_end||'',
                  updated_at: ''
                };
                const updCandidates = prodInsertCandidates.filter(c => !['store_id','name','created_at'].includes(c));
                const updCols = updCandidates.filter(c => prodCols.has(c));
                if (updCols.length) {
                  const updVals = [...updCols.map(c => updSrc[c] ?? null), storeId, p.name||''];
                  const updSql = `UPDATE products SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND name=?`;
                  const n = rawRunCount(raw, updSql, updVals);
                  if (n > 0) results.products.added++; else results.products.skipped++;
                } else { results.products.skipped++; }
              } else { results.products.skipped++; }
              continue;
            }
            const src = {
              store_id: storeId,
              name: p.name||'', category: p.category||'', category_id: remappedCatId,
              price: p.price||0, allocated_grams: p.allocated_grams||0,
              current_stock_grams: p.current_stock_grams||0, low_stock_alert: p.low_stock_alert||5,
              show_on_line: p.show_on_line??1, line_price: p.line_price||0,
              line_description: p.line_description||'', line_image_url: p.line_image_url||'',
              line_category: p.line_category||'', line_hot: p.line_hot||0,
              line_promo: p.line_promo||0, line_sold_out: p.line_sold_out||0,
              image: p.image||'', sort_order: p.sort_order||0,
              sale_status: p.sale_status||'available', inventory_enabled: p.inventory_enabled||0,
              line_preorder_enabled: p.line_preorder_enabled||0,
              line_preorder_daily: p.line_preorder_daily||0,
              line_preorder_sold: p.line_preorder_sold||0,
              line_preorder_low_threshold: p.line_preorder_low_threshold||2,
              line_preorder_high_threshold: p.line_preorder_high_threshold||10,
              line_quota_enabled: p.line_quota_enabled||0,
              line_quota_daily: p.line_quota_daily||0,
              line_quota_sold: p.line_quota_sold||0,
              line_quota_low_threshold: p.line_quota_low_threshold||2,
              line_quota_high_threshold: p.line_quota_high_threshold||10,
              line_sell_start: p.line_sell_start||'',
              line_sell_end: p.line_sell_end||'',
              created_at: p.created_at||'', updated_at: p.updated_at||''
            };
            const q = buildDynamicInsert('products', prodInsertCandidates, src, prodCols, 'OR IGNORE');
            if (!q) { results.products.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.products.added++; else results.products.skipped++;
          } catch(e) {
            results.products.errors.push(`name=${p.name}: ${e.message}`);
            results.products.failed++;
            if (strictMode) throw e;
          }
        }

        // ── 建立 product name → 新 id 對照（供 formulas / inventory_logs remap）
        // ★ 在 raw（transaction 內）查，確保能看到剛插入的 products
        const prodNameToId = {};
        try {
          const newProds = safeRawAll(raw, 'SELECT id,name FROM products WHERE store_id=?', [storeId]);
          for (const np of newProds) prodNameToId[np.name] = np.id;
        } catch {}

        // ── orders ────────────────────────────────────────────────────
        const orderCols = schemas['orders'];
        const importOrderCandidates = [
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
        const ordPhs = importOrderCandidates.map(()=>'?').join(',');

        function buildOrderSrc(o, sid) {
          const items_ = typeof o.items==='string' ? o.items : JSON.stringify(o.items||[]);
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
            if (!orderNo) { results.orders.failed++; continue; }
            const existingRow = safeGet(db,
              'SELECT id FROM orders WHERE store_id=? AND order_number=?', [storeId, orderNo]);
            if (existingRow) {
              if (mode === 'skip' || mode === 'replace') { results.orders.skipped++; continue; }
              if (mode === 'overwrite') {
                const src = buildOrderSrc(o, storeId);
                const updCols = importOrderCandidates.filter(c => !['id','order_number','store_id'].includes(c));
                const updVals = [...updCols.map(c => src[c] ?? null), storeId, orderNo];
                const updSql = `UPDATE orders SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND order_number=?`;
                const n = rawRunCount(raw, updSql, updVals);
                if (n > 0) results.orders.updated++; else results.orders.skipped++;
              } else if (mode === 'copy') {
                const newNo = orderNo + '_copy_' + Date.now();
                const src = buildOrderSrc({ ...o, order_number: newNo }, storeId);
                const vals = importOrderCandidates.map(c => src[c] ?? null);
                const n = rawRunCount(raw,
                  `INSERT OR REPLACE INTO orders (${importOrderCandidates.join(',')}) VALUES (${ordPhs})`, vals);
                if (n > 0) results.orders.added++; else results.orders.skipped++;
              }
            } else {
              const src = buildOrderSrc(o, storeId);
              const vals = importOrderCandidates.map(c => src[c] ?? null);
              const n = rawRunCount(raw,
                `INSERT OR REPLACE INTO orders (${importOrderCandidates.join(',')}) VALUES (${ordPhs})`, vals);
              if (n > 0) results.orders.added++; else results.orders.skipped++;
            }
          } catch(e) {
            results.orders.errors.push(`order_number=${o.order_number}: ${e.message}`);
            results.orders.failed++;
            if (strictMode) throw e;
          }
        }

        // ── order_logs ────────────────────────────────────────────────
        const logCols = schemas['order_logs'];
        const logCandidates = [
          'id','store_id','order_id','order_number','action','reason','operator',
          'old_value','new_value','note',
          'before_data','after_data','before_total','after_total','amount_diff',
          'before_payment','after_payment','before_received','after_received',
          'before_change','after_change','created_at'
        ].filter(c => logCols.has(c));

        for (const ol of (d.order_logs||[])) {
          try {
            const logSrc = {
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
            const logVals = logCandidates.map(c => logSrc[c] ?? null);
            const logPhs  = logCandidates.map(()=>'?').join(',');
            const n = rawRunCount(raw,
              `INSERT OR IGNORE INTO order_logs (${logCandidates.join(',')}) VALUES (${logPhs})`,
              logVals);
            if (n > 0) results.order_logs.added++; else results.order_logs.skipped++;
          } catch(e) {
            results.order_logs.errors.push(e.message);
            results.order_logs.failed++;
            if (strictMode) throw e;
          }
        }

        // ══════════════════════════════════════════════════════════════
        // hotfix9: 食材相關資料恢復（含 ID remap）
        // ── Restore Log ──────────────────────────────────────────────
        console.log(`[migration/restore] Restoring ingredients... ${(d.ingredients||[]).length} rows`);
        console.log(`[migration/restore] Restoring formulas...    ${(d.product_ingredient_formulas||[]).length} rows`);
        // ══════════════════════════════════════════════════════════════

        // ── ingredients（不寫 id，以 store_id+name 判重）─────────────
        const ingSchema = schemas['ingredients'];
        const ingredientIdRemap = {}; // old ingredient id → new ingredient id

        console.log(`[migration/restore] Restoring ingredients... ${(d.ingredients||[]).length} rows, mode=${mode}`);

        if (ingSchema.size > 0) {
          const ingCandidates = [
            'store_id','name','unit','total_stock','frozen_stock','thawing_stock',
            'refrigerated_stock','scrapped_total','ingredient_barcode','notes',
            'low_stock_threshold','operator','default_thaw_hours',
            'created_at','updated_at'
          ];
          for (const ing of (d.ingredients||[])) {
            try {
              console.log(`[migration/restore] ingredient store_id target=${storeId} source=${ing.store_id} name=${ing.name}`);

              // 查目前 transaction 內，目標 store 是否已有同名食材
              const existIngRows = safeRawAll(raw,
                'SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, ing.name||'']);
              const existIng = existIngRows.length ? existIngRows[0] : null;

              if (existIng) {
                // 目標 store 已有同名食材
                // ★ 無論何種模式，remap 都必須建立
                ingredientIdRemap[ing.id] = existIng.id;

                if (mode === 'replace') {
                  // replace 模式理論上已清空——但若 safeRawDelete 沒成功刪（例如 table 不存在判斷錯誤）
                  // 強制 UPDATE 確保資料是備份內容
                  const src = {
                    store_id: storeId, name: ing.name||'', unit: ing.unit||'g',
                    total_stock: ing.total_stock||0, frozen_stock: ing.frozen_stock||0,
                    thawing_stock: ing.thawing_stock||0,
                    refrigerated_stock: ing.refrigerated_stock||0,
                    scrapped_total: ing.scrapped_total||0,
                    ingredient_barcode: ing.ingredient_barcode||'',
                    notes: ing.notes||'',
                    low_stock_threshold: ing.low_stock_threshold||0,
                    operator: ing.operator||'',
                    default_thaw_hours: ing.default_thaw_hours||0,
                    updated_at: ''
                  };
                  const updCols = ingCandidates.filter(c => ingSchema.has(c) && !['store_id','name','created_at'].includes(c));
                  if (updCols.length) {
                    const updVals = [...updCols.map(c => src[c] ?? null), storeId, ing.name||''];
                    const updSql = `UPDATE ingredients SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND name=?`;
                    rawRunCount(raw, updSql, updVals);
                  }
                  console.log(`[migration/restore]   ingredient remap (replace/update): ${ing.id}→${existIng.id} (${ing.name})`);
                  results.ingredients.added++;
                } else if (mode === 'overwrite') {
                  const src = {
                    store_id: storeId, name: ing.name||'', unit: ing.unit||'g',
                    total_stock: ing.total_stock||0, frozen_stock: ing.frozen_stock||0,
                    thawing_stock: ing.thawing_stock||0,
                    refrigerated_stock: ing.refrigerated_stock||0,
                    scrapped_total: ing.scrapped_total||0,
                    ingredient_barcode: ing.ingredient_barcode||'',
                    notes: ing.notes||'',
                    low_stock_threshold: ing.low_stock_threshold||0,
                    operator: ing.operator||'',
                    default_thaw_hours: ing.default_thaw_hours||0,
                    updated_at: ''
                  };
                  const updCols = ingCandidates.filter(c => ingSchema.has(c) && !['store_id','name','created_at'].includes(c));
                  if (updCols.length) {
                    const updVals = [...updCols.map(c => src[c] ?? null), storeId, ing.name||''];
                    const updSql = `UPDATE ingredients SET ${updCols.map(c=>`${c}=?`).join(',')},updated_at=datetime('now','localtime') WHERE store_id=? AND name=?`;
                    rawRunCount(raw, updSql, updVals);
                    console.log(`[migration/restore]   ingredient remap (overwrite): ${ing.id}→${existIng.id} (${ing.name})`);
                    results.ingredients.added++;
                  } else {
                    console.log(`[migration/restore]   ingredient remap (skip/no-cols): ${ing.id}→${existIng.id} (${ing.name})`);
                    results.ingredients.skipped++;
                  }
                } else {
                  // skip / merge：已存在，不修改，但 remap 已建立
                  console.log(`[migration/restore]   ingredient remap (skip/exist): ${ing.id}→${existIng.id} (${ing.name})`);
                  results.ingredients.skipped++;
                }
                continue;
              }

              // 目標 store 沒有同名食材 → INSERT
              const src = {
                store_id: storeId,   // ★ 強制用目標 storeId，不用 ing.store_id
                name: ing.name||'', unit: ing.unit||'g',
                total_stock: ing.total_stock||0, frozen_stock: ing.frozen_stock||0,
                thawing_stock: ing.thawing_stock||0,
                refrigerated_stock: ing.refrigerated_stock||0,
                scrapped_total: ing.scrapped_total||0,
                ingredient_barcode: ing.ingredient_barcode||'',
                notes: ing.notes||'',
                low_stock_threshold: ing.low_stock_threshold||0,
                operator: ing.operator||'',
                default_thaw_hours: ing.default_thaw_hours||0,
                created_at: ing.created_at||'', updated_at: ing.updated_at||''
              };
              const q = buildDynamicInsert('ingredients', ingCandidates, src, ingSchema, 'OR IGNORE');
              if (!q) {
                console.log(`[migration/restore]   ingredient SKIP (no cols): ${ing.name}`);
                results.ingredients.skipped++;
                continue;
              }
              rawRunCount(raw, q.sql, q.vals);
              // ★ 在 raw（transaction 內）查新 id
              const newIngRows = safeRawAll(raw,
                'SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, ing.name||'']);
              const newIng = newIngRows.length ? newIngRows[0] : null;
              if (newIng) {
                ingredientIdRemap[ing.id] = newIng.id;
                console.log(`[migration/restore]   ingredient remap (insert): ${ing.id}→${newIng.id} (${ing.name})`);
                results.ingredients.added++;
              } else {
                console.log(`[migration/restore]   ingredient INSERT failed (newIng null): ${ing.name}`);
                results.ingredients.skipped++;
              }
            } catch(e) {
              console.error(`[migration/restore]   ingredient ERROR: ${ing.name}`, e.message);
              results.ingredients.errors.push(`name=${ing.name}: ${e.message}`);
              results.ingredients.failed++;
              if (strictMode) throw e;
            }
          }
          console.log(`[migration/restore] ingredientIdRemap built: ${Object.keys(ingredientIdRemap).length} entries`);
        } else {
          console.warn('[migration] ingredients table not found, skipping');
        }

        // ── product_ingredient_formulas（依 product_id + ingredient_id remap）
        const formulaSchema = schemas['product_ingredient_formulas'];
        if (formulaSchema.size > 0) {
          for (const f of (d.product_ingredient_formulas||[])) {
            try {
              // product_id remap：先用 product_name 在 raw（transaction 內）查
              // ★ 不可用 safeGet(db) — transaction 未 COMMIT 前看不到剛寫入的 products
              let newProductId = null;
              if (f.product_name) {
                const prRows = safeRawAll(raw,
                  'SELECT id FROM products WHERE store_id=? AND name=?', [storeId, f.product_name]);
                if (prRows.length) newProductId = prRows[0].id;
              }
              if (!newProductId) newProductId = prodNameToId[f.product_name] || null;
              if (!newProductId) { results.product_ingredient_formulas.skipped++; continue; }

              // ingredient_id remap：先查 ingredientIdRemap，再到 raw 查
              let newIngId = ingredientIdRemap[f.ingredient_id] || null;
              if (!newIngId && f.ingredient_name) {
                const irRows = safeRawAll(raw,
                  'SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, f.ingredient_name]);
                if (irRows.length) newIngId = irRows[0].id;
              }
              if (!newIngId) { results.product_ingredient_formulas.skipped++; continue; }

              // 判重：product_id + ingredient_id（在 raw 內查）
              const existFRows = safeRawAll(raw,
                'SELECT id FROM product_ingredient_formulas WHERE product_id=? AND ingredient_id=?',
                [newProductId, newIngId]);
              const existF = existFRows.length ? existFRows[0] : null;
              if (existF) {
                if (mode === 'skip' || mode === 'replace') { results.product_ingredient_formulas.skipped++; continue; }
                if (mode === 'overwrite') {
                  rawRunCount(raw,
                    `UPDATE product_ingredient_formulas SET amount_per_unit=?,notes=? WHERE product_id=? AND ingredient_id=?`,
                    [f.amount_per_unit||0, f.notes||'', newProductId, newIngId]);
                  results.product_ingredient_formulas.added++;
                } else { results.product_ingredient_formulas.skipped++; }
                continue;
              }
              const src = {
                product_id: newProductId, product_barcode: f.product_barcode||'',
                ingredient_id: newIngId,
                amount_per_unit: f.amount_per_unit||0,
                notes: f.notes||'', created_at: f.created_at||''
              };
              const q = buildDynamicInsert('product_ingredient_formulas',
                ['product_id','product_barcode','ingredient_id','amount_per_unit','notes','created_at'],
                src, formulaSchema, 'OR IGNORE');
              if (!q) { results.product_ingredient_formulas.skipped++; continue; }
              const n = rawRunCount(raw, q.sql, q.vals);
              if (n > 0) results.product_ingredient_formulas.added++;
              else results.product_ingredient_formulas.skipped++;
            } catch(e) {
              results.product_ingredient_formulas.errors.push(e.message);
              results.product_ingredient_formulas.failed++;
              if (strictMode) throw e;
            }
          }
        } else {
          console.warn('[migration] product_ingredient_formulas table not found, skipping');
        }

        // ── ingredient_logs（無 store_id，依 ingredient_id remap）──────
        const ingLogSchema = schemas['ingredient_logs'];
        if (ingLogSchema.size > 0) {
          const ingLogCandidates = [
            'ingredient_id','ingredient_name','batch_no','log_type',
            'before_frozen','before_thawing','before_refrigerated','change_amount',
            'after_frozen','after_thawing','after_refrigerated',
            'reason','operator','related_order_id','thaw_complete_time','created_at'
          ];
          for (const il of (d.ingredient_logs||[])) {
            try {
              const newIngId = ingredientIdRemap[il.ingredient_id] || null;
              if (!newIngId) { results.ingredient_logs.skipped++; continue; }
              const src = {
                ingredient_id: newIngId,
                ingredient_name: il.ingredient_name||'',
                batch_no: il.batch_no||'',
                log_type: il.log_type||'adjust',
                before_frozen: il.before_frozen||0,
                before_thawing: il.before_thawing||0,
                before_refrigerated: il.before_refrigerated||0,
                change_amount: il.change_amount||0,
                after_frozen: il.after_frozen||0,
                after_thawing: il.after_thawing||0,
                after_refrigerated: il.after_refrigerated||0,
                reason: il.reason||'', operator: il.operator||'staff',
                related_order_id: il.related_order_id||'',
                thaw_complete_time: il.thaw_complete_time||'',
                created_at: il.created_at||''
              };
              const q = buildDynamicInsert('ingredient_logs', ingLogCandidates, src, ingLogSchema, 'OR IGNORE');
              if (!q) { results.ingredient_logs.skipped++; continue; }
              const n = rawRunCount(raw, q.sql, q.vals);
              if (n > 0) results.ingredient_logs.added++; else results.ingredient_logs.skipped++;
            } catch(e) {
              results.ingredient_logs.errors.push(e.message);
              results.ingredient_logs.failed++;
              if (strictMode) throw e;
            }
          }
        }

        // ── ingredient_batches（依 ingredient_id remap）──────────────
        const batchSchema = schemas['ingredient_batches'];
        if (batchSchema.size > 0) {
          const batchCandidates = [
            'ingredient_id','batch_no','batch_barcode','purchase_date',
            'quantity','unit','notes','created_at'
          ];
          for (const b of (d.ingredient_batches||[])) {
            try {
              const newIngId = ingredientIdRemap[b.ingredient_id] || null;
              if (!newIngId) { results.ingredient_batches.skipped++; continue; }
              const src = {
                ingredient_id: newIngId,
                batch_no: b.batch_no||'',
                batch_barcode: b.batch_barcode||'',
                purchase_date: b.purchase_date||'',
                quantity: b.quantity||0, unit: b.unit||'g',
                notes: b.notes||'', created_at: b.created_at||''
              };
              const q = buildDynamicInsert('ingredient_batches', batchCandidates, src, batchSchema, 'OR IGNORE');
              if (!q) { results.ingredient_batches.skipped++; continue; }
              const n = rawRunCount(raw, q.sql, q.vals);
              if (n > 0) results.ingredient_batches.added++; else results.ingredient_batches.skipped++;
            } catch(e) {
              results.ingredient_batches.errors.push(e.message);
              results.ingredient_batches.failed++;
              if (strictMode) throw e;
            }
          }
        }

        // ── ingredient_thaw_batches（依 ingredient_id remap）─────────
        const thawSchema = schemas['ingredient_thaw_batches'];
        if (thawSchema.size > 0) {
          const thawCandidates = [
            'ingredient_id','ingredient_name','amount','unit',
            'started_at','expected_complete_at','completed_at',
            'status','extended_count','notes','created_at','updated_at'
          ];
          for (const tb of (d.ingredient_thaw_batches||[])) {
            try {
              const newIngId = ingredientIdRemap[tb.ingredient_id] || null;
              if (!newIngId) { results.ingredient_thaw_batches.skipped++; continue; }
              const src = {
                ingredient_id: newIngId,
                ingredient_name: tb.ingredient_name||'',
                amount: tb.amount||0, unit: tb.unit||'g',
                started_at: tb.started_at||'',
                expected_complete_at: tb.expected_complete_at||'',
                completed_at: tb.completed_at||'',
                status: tb.status||'thawing',
                extended_count: tb.extended_count||0,
                notes: tb.notes||'',
                created_at: tb.created_at||'', updated_at: tb.updated_at||''
              };
              const q = buildDynamicInsert('ingredient_thaw_batches', thawCandidates, src, thawSchema, 'OR IGNORE');
              if (!q) { results.ingredient_thaw_batches.skipped++; continue; }
              const n = rawRunCount(raw, q.sql, q.vals);
              if (n > 0) results.ingredient_thaw_batches.added++; else results.ingredient_thaw_batches.skipped++;
            } catch(e) {
              results.ingredient_thaw_batches.errors.push(e.message);
              results.ingredient_thaw_batches.failed++;
              if (strictMode) throw e;
            }
          }
        }

        // ── inventory_logs（有 store_id，product_id 依 remap）─────────
        const invLogSchema = schemas['inventory_logs'];
        if (invLogSchema.size > 0) {
          const invLogCandidates = [
            'store_id','product_id','product_name','action',
            'before_grams','change_grams','after_grams',
            'before_units','after_units','reason','operator','order_id','created_at'
          ];
          for (const il of (d.inventory_logs||[])) {
            try {
              // product_id remap
              let newProdId = null;
              if (il.product_name) {
                // ★ 在 raw 內查，products 在同一 transaction 內寫入
                const prRows = safeRawAll(raw,
                  'SELECT id FROM products WHERE store_id=? AND name=?', [storeId, il.product_name]);
                if (prRows.length) newProdId = prRows[0].id;
              }
              if (!newProdId) newProdId = prodNameToId[il.product_name] || il.product_id || null;

              const src = {
                store_id: storeId,
                product_id: newProdId,
                product_name: il.product_name||'',
                action: il.action||'adjust',
                before_grams: il.before_grams||0,
                change_grams: il.change_grams||0,
                after_grams: il.after_grams||0,
                before_units: il.before_units||0,
                after_units: il.after_units||0,
                reason: il.reason||'', operator: il.operator||'staff',
                order_id: il.order_id||'',
                created_at: il.created_at||''
              };
              const q = buildDynamicInsert('inventory_logs', invLogCandidates, src, invLogSchema, 'OR IGNORE');
              if (!q) { results.inventory_logs.skipped++; continue; }
              const n = rawRunCount(raw, q.sql, q.vals);
              if (n > 0) results.inventory_logs.added++; else results.inventory_logs.skipped++;
            } catch(e) {
              results.inventory_logs.errors.push(e.message);
              results.inventory_logs.failed++;
              if (strictMode) throw e;
            }
          }
        }

        // ── discount_categories ───────────────────────────────────────
        const discCatCols = schemas['discount_categories'];
        for (const c of (d.discount_categories||[])) {
          try {
            const existDC = safeGet(db,
              'SELECT id FROM discount_categories WHERE store_id=? AND name=?', [storeId, c.name||c.label||'']);
            if (existDC) {
              if (mode === 'skip' || mode === 'replace') { results.discount_categories.skipped++; continue; }
              if (mode === 'overwrite') {
                const n = rawRunCount(raw,
                  `UPDATE discount_categories SET code=?,icon=?,color=?,enabled=?,sort_order=? WHERE store_id=? AND name=?`,
                  [c.code||'', c.icon||'💸', c.color||'#94a3b8', c.enabled??c.is_active??1, c.sort_order||0, storeId, c.name||c.label||'']);
                if (n > 0) results.discount_categories.added++; else results.discount_categories.skipped++;
              } else { results.discount_categories.skipped++; }
              continue;
            }
            const src = {
              store_id: storeId,
              code: c.code||'', name: c.name||c.label||'',
              icon: c.icon||'💸', color: c.color||'#94a3b8',
              enabled: c.enabled??c.is_active??1,
              sort_order: c.sort_order||0, created_at: c.created_at||''
            };
            const q = buildDynamicInsert('discount_categories',
              ['store_id','code','name','icon','color','enabled','sort_order','created_at'],
              src, discCatCols, 'OR IGNORE');
            if (!q) { results.discount_categories.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.discount_categories.added++; else results.discount_categories.skipped++;
          } catch(e) {
            results.discount_categories.errors.push(`name=${c.name}: ${e.message}`);
            results.discount_categories.failed++;
            if (strictMode) throw e;
          }
        }

        // ── discount_campaigns ────────────────────────────────────────
        const discCampCols = schemas['discount_campaigns'];
        for (const c of (d.discount_campaigns||[])) {
          try {
            const existDC2 = safeGet(db,
              'SELECT id FROM discount_campaigns WHERE store_id=? AND name=?', [storeId, c.name||'']);
            if (existDC2) {
              if (mode === 'skip' || mode === 'replace') { results.discount_campaigns.skipped++; continue; }
              if (mode === 'overwrite') {
                const n = rawRunCount(raw,
                  `UPDATE discount_campaigns SET description=?,enabled=?,sort_order=? WHERE store_id=? AND name=?`,
                  [c.description||'', c.enabled??c.is_active??1, c.sort_order||0, storeId, c.name||'']);
                if (n > 0) results.discount_campaigns.added++; else results.discount_campaigns.skipped++;
              } else { results.discount_campaigns.skipped++; }
              continue;
            }
            const src = {
              store_id: storeId,
              name: c.name||'', description: c.description||'',
              enabled: c.enabled??c.is_active??1,
              sort_order: c.sort_order||0, created_at: c.created_at||''
            };
            const q = buildDynamicInsert('discount_campaigns',
              ['store_id','name','description','enabled','sort_order','created_at'],
              src, discCampCols, 'OR IGNORE');
            if (!q) { results.discount_campaigns.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.discount_campaigns.added++; else results.discount_campaigns.skipped++;
          } catch(e) {
            results.discount_campaigns.errors.push(`name=${c.name}: ${e.message}`);
            results.discount_campaigns.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_groups ───────────────────────────────────
        const grpCols = schemas['analysis_groups'];
        const groupIdRemap = {};
        for (const g of (d.product_analysis_groups||[])) {
          try {
            const gName = g.group_name||g.name||'';
            const existGrp = safeGet(db,
              'SELECT id FROM product_analysis_groups WHERE store_id=? AND group_name=?', [storeId, gName]);
            if (existGrp) {
              groupIdRemap[g.id] = existGrp.id;
              if (mode === 'skip' || mode === 'replace') { results.analysis_groups.skipped++; continue; }
              if (mode === 'overwrite') {
                rawRunCount(raw,
                  `UPDATE product_analysis_groups SET description=?,enabled=?,sort_order=?,updated_at=datetime('now','localtime') WHERE store_id=? AND group_name=?`,
                  [g.description||'', g.enabled??1, g.sort_order||0, storeId, gName]);
                results.analysis_groups.added++;
              } else { results.analysis_groups.skipped++; }
              continue;
            }
            const src = {
              store_id: storeId,
              group_name: gName, description: g.description||'',
              enabled: g.enabled??g.is_active??1,
              sort_order: g.sort_order||0,
              created_at: g.created_at||'', updated_at: g.updated_at||g.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_groups',
              ['store_id','group_name','description','enabled','sort_order','created_at','updated_at'],
              src, grpCols, 'OR IGNORE');
            if (!q) { results.analysis_groups.skipped++; continue; }
            rawRunCount(raw, q.sql, q.vals);
            // ★ 在 raw（transaction 內）查，不可用 safeGet(db)
            const newGrpRows = safeRawAll(raw,
              'SELECT id FROM product_analysis_groups WHERE store_id=? AND group_name=?', [storeId, gName]);
            const newGrp = newGrpRows.length ? newGrpRows[0] : null;
            if (newGrp) {
              groupIdRemap[g.id] = newGrp.id;
              results.analysis_groups.added++;
            } else { results.analysis_groups.skipped++; }
          } catch(e) {
            results.analysis_groups.errors.push(`name=${g.group_name}: ${e.message}`);
            results.analysis_groups.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_group_items ──────────────────────────────
        const giCols = schemas['analysis_items'];
        for (const gi of (d.product_analysis_group_items||[])) {
          try {
            const newGroupId = groupIdRemap[gi.group_id] || gi.group_id;
            const pName = gi.product_name || '';
            let newProductId = gi.product_id;
            if (pName) {
              // ★ 在 raw 內查
              const prodRows = safeRawAll(raw, 'SELECT id FROM products WHERE store_id=? AND name=?', [storeId, pName]);
              if (prodRows.length) newProductId = prodRows[0].id;
            }
            const existGIRows = safeRawAll(raw,
              'SELECT id FROM product_analysis_group_items WHERE store_id=? AND group_id=? AND product_id=?',
              [storeId, newGroupId, newProductId]);
            if (existGIRows.length) { results.analysis_items.skipped++; continue; }
            const src = {
              store_id: storeId,
              group_id: newGroupId, product_id: newProductId,
              product_name: pName, created_at: gi.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_group_items',
              ['store_id','group_id','product_id','product_name','created_at'],
              src, giCols, 'OR IGNORE');
            if (!q) { results.analysis_items.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.analysis_items.added++; else results.analysis_items.skipped++;
          } catch(e) {
            results.analysis_items.errors.push(`id=${gi.id}: ${e.message}`);
            results.analysis_items.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_group_aliases ────────────────────────────
        const alsCols = schemas['analysis_aliases'];
        for (const a of (d.product_analysis_group_aliases||[])) {
          try {
            const newGroupId = groupIdRemap[a.group_id] || a.group_id;
            const existAl = safeGet(db,
              'SELECT id FROM product_analysis_group_aliases WHERE store_id=? AND group_id=? AND alias_name=?',
              [storeId, newGroupId, a.alias_name||'']);
            if (existAl) { results.analysis_aliases.skipped++; continue; }
            const src = {
              store_id: storeId,
              group_id: newGroupId, alias_name: a.alias_name||'',
              created_at: a.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_group_aliases',
              ['store_id','group_id','alias_name','created_at'],
              src, alsCols, 'OR IGNORE');
            if (!q) { results.analysis_aliases.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.analysis_aliases.added++; else results.analysis_aliases.skipped++;
          } catch(e) {
            results.analysis_aliases.errors.push(`id=${a.id}: ${e.message}`);
            results.analysis_aliases.failed++;
            if (strictMode) throw e;
          }
        }

        // ── settings ──────────────────────────────────────────────────
        const settingsCols = schemas['settings'];
        for (const s of (d.settings||[])) {
          try {
            const src = { store_id: storeId, key: s.key||'', value: s.value||'' };
            const q = buildDynamicInsert('settings',
              ['store_id','key','value'], src, settingsCols, orMode);
            if (!q) { results.settings.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.settings.added++; else results.settings.skipped++;
          } catch(e) {
            results.settings.errors.push(`key=${s.key}: ${e.message}`);
            results.settings.failed++;
            if (strictMode) throw e;
          }
        }

        // ── delivery_platforms ────────────────────────────────────────
        const platCols = schemas['delivery_platforms'];
        for (const p of (d.delivery_platforms||[])) {
          try {
            const src = {
              id: p.id, store_id: storeId,
              code: p.code||'',
              name: p.name||p.platform_name||'',
              platform_name: p.platform_name||p.name||'',
              commission_rate: p.commission_rate||0,
              is_active: p.is_active??1,
              created_at: p.created_at||'', updated_at: p.updated_at||''
            };
            const candidates = [
              'id','store_id','code','name','platform_name',
              'commission_rate','is_active','created_at','updated_at'
            ];
            const q = buildDynamicInsert('delivery_platforms', candidates, src, platCols, orMode);
            if (!q) { results.delivery_platforms.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.delivery_platforms.added++; else results.delivery_platforms.skipped++;
          } catch(e) {
            results.delivery_platforms.errors.push(`id=${p.id}: ${e.message}`);
            results.delivery_platforms.failed++;
            if (strictMode) throw e;
          }
        }

        // ── delivery_fees ─────────────────────────────────────────────
        const feeCols = schemas['delivery_fees'];
        for (const f of (d.delivery_fees||[])) {
          try {
            const src = {
              id: f.id, store_id: storeId,
              min_amount: f.min_amount||0, max_amount: f.max_amount||0,
              fee: f.fee||0, created_at: f.created_at||''
            };
            const q = buildDynamicInsert('delivery_fees',
              ['id','store_id','min_amount','max_amount','fee','created_at'],
              src, feeCols, orMode);
            if (!q) { results.delivery_fees.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.delivery_fees.added++; else results.delivery_fees.skipped++;
          } catch(e) {
            results.delivery_fees.errors.push(`id=${f.id}: ${e.message}`);
            results.delivery_fees.failed++;
            if (strictMode) throw e;
          }
        }

      }); // ── end runInTransaction ──────────────────────────────────────

      // ★ Restore 完成後 SQL 驗證（COMMIT 後才能用 db 查）
      try {
        const ingCount = db.get('SELECT COUNT(*) as c FROM ingredients WHERE store_id=?', [storeId]);
        const fmlCount = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas');
        console.log(`[migration/restore] POST-COMMIT COUNT ingredients WHERE store_id='${storeId}':`, ingCount ? ingCount.c : 'N/A');
        console.log(`[migration/restore] POST-COMMIT COUNT product_ingredient_formulas (all):`, fmlCount ? fmlCount.c : 'N/A');
        // 顯示 ingredients 所有 store_id 分布，確認寫入哪個 store
        try {
          const allStores = db.all('SELECT store_id, COUNT(*) as c FROM ingredients GROUP BY store_id');
          console.log('[migration/restore] ingredients GROUP BY store_id:', JSON.stringify(allStores));
        } catch {}
        // 結果計數 log
        console.log('[migration/restore] results.ingredients:', JSON.stringify({
          added: results.ingredients.added,
          skipped: results.ingredients.skipped,
          failed: results.ingredients.failed,
          errors: results.ingredients.errors.slice(0,3)
        }));
        console.log('[migration/restore] results.product_ingredient_formulas:', JSON.stringify({
          added: results.product_ingredient_formulas.added,
          skipped: results.product_ingredient_formulas.skipped,
          failed: results.product_ingredient_formulas.failed,
          errors: results.product_ingredient_formulas.errors.slice(0,3)
        }));
      } catch(e) { console.warn('[migration/restore] post-commit count error:', e.message); }

    } catch(txErr) {
      if (strictMode) {
        return res.status(500).json({
          success: false,
          mode,
          message: `replace 模式發生錯誤，已全部回滾：${txErr.message}`,
          results
        });
      }
      throw txErr;
    }

    // ── 彙整總計 ─────────────────────────────────────────────────────────
    let totalAdded = 0, totalUpdated = 0, totalSkipped = 0, totalFailed = 0;
    const tableErrors = [];
    for (const [tbl, r] of Object.entries(results)) {
      totalAdded   += (r.added||0) + (r.updated||0);
      totalUpdated += (r.updated||0);
      totalSkipped += (r.skipped||0);
      totalFailed  += (r.failed||0);
      if (r.failed > 0) {
        tableErrors.push({
          table: tbl,
          failed: r.failed,
          sample_errors: r.errors.slice(0, 3)
        });
      }
    }

    const overallStatus = totalFailed > 0 ? 'partial' : 'success';

    writeMigrationLog(db, storeId, '匯入快速搬家檔', payload.store_id||'', mode,
      { ...results, total_added: totalAdded, total_skipped: totalSkipped, total_failed: totalFailed },
      overallStatus,
      tableErrors.map(e => `${e.table}:${e.failed}筆`).join('; ').slice(0, 200));

    res.json({
      success: true,
      mode,
      status: overallStatus,
      status_label: overallStatus === 'partial'
        ? '部分匯入完成，有錯誤'
        : '匯入完成',
      summary: {
        total_added:   totalAdded,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_failed:  totalFailed
      },
      table_errors: tableErrors,
      results
    });

  } catch(e) {
    console.error('[migration/import]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
