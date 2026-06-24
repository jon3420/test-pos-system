// routes/migration.js — fix18-10-hotfix5
//
// fix18-10-hotfix5 修正：
//
// BUG-3: delivery_platforms 硬寫 code 欄位，但 DB 無此欄位
//   根因：migration/import 對 delivery_platforms（與其他多張表）硬寫欄位清單，
//         備份檔欄位多於 DB 實際欄位時 INSERT 失敗，導致整批 failed。
//   修正：所有資料表改用 PRAGMA table_info() 動態取得實際欄位，
//         只 INSERT/UPDATE 目前 DB 實際存在的欄位，多餘欄位自動略過。
//
// 適用所有匯入資料表：
//   categories / products / orders / order_logs /
//   discount_categories / discount_campaigns /
//   product_analysis_groups / product_analysis_group_items /
//   product_analysis_group_aliases /
//   settings / delivery_platforms / delivery_fees
//
// 錯誤計數與狀態顯示：
//   failed > 0 → status = 'partial'，回傳 table_errors 分類清單
//   replace 模式：any error → ROLLBACK（all-or-nothing）
//
// 沿用 fix18-10-hotfix4 的修正：
// BUG-1: 跨店 id PK 衝突 → 用 storeId+'_'+order_number 作為 id
// BUG-2: order_logs 固定欄位 → PRAGMA 動態過濾
// RC-1: 回傳 date_range
// RC-2: ensureTable 先建 discount 表
// RC-3: rawRunCount 確認實際寫入
// RC-4: PRAGMA 動態過濾欄位（orders）

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

// ── 通用動態 INSERT helper ─────────────────────────────────────────────────
// candidates: 候選欄位順序陣列（包含備份檔可能有的所有欄位名稱）
// srcObj:     備份檔的單筆資料（含 alias mapping 後）
// colSet:     DB 實際欄位 Set
// orMode:     'OR IGNORE' | 'OR REPLACE' | 'OR IGNORE'
// 回傳 { sql, vals } 或 null（若無有效欄位）
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

    const payload = { type:'orders_backup', version:'fix18-10-hotfix5',
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
    const storeId = req.storeId || 'store_001';
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
    const payload = { type:'preorders_backup', version:'fix18-10-hotfix5',
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
// ══════════════════════════════════════════════════════════════════════════
router.get('/migration/export', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

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
      type: 'pos_migration_backup', version: 'fix18-10-hotfix5',
      exported_at: isoNow(), store_id: storeId,
      store_name: storeRow ? (storeRow.name||storeRow.store_id||storeId) : storeId,
      schema_version: 2,
      data: {
        products, categories, orders,
        order_items: [],
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
// ══════════════════════════════════════════════════════════════════════════
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
      settings:                      (d.settings                     || []).length,
      delivery_platforms:            (d.delivery_platforms           || []).length,
      delivery_fees:                 (d.delivery_fees                || []).length
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
//
//  fix18-10-hotfix5 核心修正：
//  全部資料表改用 PRAGMA table_info() 動態取得欄位，
//  只 INSERT 目前 DB 實際存在的欄位，備份檔多餘欄位自動略過。
// ══════════════════════════════════════════════════════════════════════════
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

    try { ensureDiscountCategoriesTable(db); } catch {}
    try { ensureDiscountCampaignsTable(db); } catch {}

    const d = payload.data || {};

    // 結果計數器（依資料表分開）
    const results = {
      categories:         { added:0, skipped:0, failed:0, errors:[] },
      products:           { added:0, skipped:0, failed:0, errors:[] },
      orders:             { added:0, updated:0, skipped:0, failed:0, errors:[] },
      order_logs:         { added:0, skipped:0, failed:0, errors:[] },
      discount_categories:{ added:0, skipped:0, failed:0, errors:[] },
      discount_campaigns: { added:0, skipped:0, failed:0, errors:[] },
      analysis_groups:    { added:0, skipped:0, failed:0, errors:[] },
      analysis_items:     { added:0, skipped:0, failed:0, errors:[] },
      analysis_aliases:   { added:0, skipped:0, failed:0, errors:[] },
      settings:           { added:0, skipped:0, failed:0, errors:[] },
      delivery_platforms: { added:0, skipped:0, failed:0, errors:[] },
      delivery_fees:      { added:0, skipped:0, failed:0, errors:[] }
    };

    // 預先讀取所有資料表的實際欄位（PRAGMA 在 transaction 外執行更穩定）
    const schemas = {};
    for (const t of Object.keys(results)) {
      // 對應實際 DB 表名
      const tbl = t === 'analysis_groups'   ? 'product_analysis_groups'        :
                  t === 'analysis_items'    ? 'product_analysis_group_items'   :
                  t === 'analysis_aliases'  ? 'product_analysis_group_aliases' : t;
      schemas[t] = getTableCols(db, tbl);
    }

    // INSERT 模式
    const orMode = (mode === 'overwrite') ? 'OR REPLACE' : 'OR IGNORE';

    // replace 模式需要 all-or-nothing；其他模式逐筆記錯不停止
    const strictMode = (mode === 'replace');

    try {
      runInTransaction(db, (raw) => {

        // ── replace：只清本店 ──────────────────────────────────────────────
        if (mode === 'replace') {
          const purge = ['orders','products','categories',
            'discount_categories','discount_campaigns',
            'product_analysis_group_items','product_analysis_group_aliases',
            'product_analysis_groups','inventory'];
          for (const t of purge) {
            rawRun(raw, `DELETE FROM ${t} WHERE store_id=?`, [storeId]);
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

        // ── categories（動態欄位）────────────────────────────────────────
        const catCols = schemas['categories'];
        for (const c of (d.categories||[])) {
          try {
            const src = {
              id: c.id, store_id: storeId,
              name: c.name||'', icon: c.icon||'📌',
              sort_order: c.sort_order||0, is_active: c.is_active??1,
              created_at: c.created_at||''
            };
            const q = buildDynamicInsert('categories',
              ['id','store_id','name','icon','sort_order','is_active','created_at'],
              src, catCols, orMode);
            if (!q) { results.categories.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.categories.added++; else results.categories.skipped++;
          } catch(e) {
            results.categories.errors.push(`id=${c.id}: ${e.message}`);
            results.categories.failed++;
            if (strictMode) throw e;
          }
        }

        // ── products（動態欄位）──────────────────────────────────────────
        const prodCols = schemas['products'];
        for (const p of (d.products||[])) {
          try {
            const src = {
              id: p.id, store_id: storeId,
              name: p.name||'', category: p.category||'', category_id: p.category_id||null,
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
              created_at: p.created_at||'', updated_at: p.updated_at||''
            };
            const candidates = [
              'id','store_id','name','category','category_id','price',
              'allocated_grams','current_stock_grams','low_stock_alert',
              'show_on_line','line_price','line_description','line_image_url','line_category',
              'line_hot','line_promo','line_sold_out','image','sort_order','sale_status',
              'inventory_enabled','line_preorder_enabled','line_preorder_daily','line_preorder_sold',
              'line_preorder_low_threshold','line_preorder_high_threshold',
              'created_at','updated_at'
            ];
            const q = buildDynamicInsert('products', candidates, src, prodCols, orMode);
            if (!q) { results.products.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.products.added++; else results.products.skipped++;
          } catch(e) {
            results.products.errors.push(`id=${p.id}: ${e.message}`);
            results.products.failed++;
            if (strictMode) throw e;
          }
        }

        // ── orders（BUG-1：store_id+order_number 判重，id 加前綴）────────
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

        // ── order_logs（BUG-2：動態欄位）───────────────────────────────
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

        // ── discount_categories（動態欄位）──────────────────────────────
        const discCatCols = schemas['discount_categories'];
        for (const c of (d.discount_categories||[])) {
          try {
            const src = {
              id: c.id, store_id: storeId,
              code: c.code||'', name: c.name||c.label||'',
              icon: c.icon||'💸', color: c.color||'#94a3b8',
              enabled: c.enabled??c.is_active??1,
              sort_order: c.sort_order||0, created_at: c.created_at||''
            };
            const q = buildDynamicInsert('discount_categories',
              ['id','store_id','code','name','icon','color','enabled','sort_order','created_at'],
              src, discCatCols, orMode);
            if (!q) { results.discount_categories.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.discount_categories.added++; else results.discount_categories.skipped++;
          } catch(e) {
            results.discount_categories.errors.push(`id=${c.id}: ${e.message}`);
            results.discount_categories.failed++;
            if (strictMode) throw e;
          }
        }

        // ── discount_campaigns（動態欄位）───────────────────────────────
        const discCampCols = schemas['discount_campaigns'];
        for (const c of (d.discount_campaigns||[])) {
          try {
            const src = {
              id: c.id, store_id: storeId,
              name: c.name||'', description: c.description||'',
              enabled: c.enabled??c.is_active??1,
              sort_order: c.sort_order||0, created_at: c.created_at||''
            };
            const q = buildDynamicInsert('discount_campaigns',
              ['id','store_id','name','description','enabled','sort_order','created_at'],
              src, discCampCols, orMode);
            if (!q) { results.discount_campaigns.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.discount_campaigns.added++; else results.discount_campaigns.skipped++;
          } catch(e) {
            results.discount_campaigns.errors.push(`id=${c.id}: ${e.message}`);
            results.discount_campaigns.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_groups（動態欄位）──────────────────────────
        const grpCols = schemas['analysis_groups'];
        for (const g of (d.product_analysis_groups||[])) {
          try {
            const src = {
              id: g.id, store_id: storeId,
              group_name: g.group_name||g.name||'', description: g.description||'',
              enabled: g.enabled??g.is_active??1,
              sort_order: g.sort_order||0,
              created_at: g.created_at||'', updated_at: g.updated_at||g.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_groups',
              ['id','store_id','group_name','description','enabled','sort_order','created_at','updated_at'],
              src, grpCols, orMode);
            if (!q) { results.analysis_groups.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.analysis_groups.added++; else results.analysis_groups.skipped++;
          } catch(e) {
            results.analysis_groups.errors.push(`id=${g.id}: ${e.message}`);
            results.analysis_groups.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_group_items（動態欄位）─────────────────────
        const giCols = schemas['analysis_items'];
        for (const gi of (d.product_analysis_group_items||[])) {
          try {
            const pName = gi.product_name
              || (safeGet(db,'SELECT name FROM products WHERE id=?',[gi.product_id])?.name)
              || '';
            const src = {
              id: gi.id, store_id: storeId,
              group_id: gi.group_id, product_id: gi.product_id,
              product_name: pName, created_at: gi.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_group_items',
              ['id','store_id','group_id','product_id','product_name','created_at'],
              src, giCols, orMode);
            if (!q) { results.analysis_items.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.analysis_items.added++; else results.analysis_items.skipped++;
          } catch(e) {
            results.analysis_items.errors.push(`id=${gi.id}: ${e.message}`);
            results.analysis_items.failed++;
            if (strictMode) throw e;
          }
        }

        // ── product_analysis_group_aliases（動態欄位）───────────────────
        const alsCols = schemas['analysis_aliases'];
        for (const a of (d.product_analysis_group_aliases||[])) {
          try {
            const src = {
              id: a.id, store_id: storeId,
              group_id: a.group_id, alias_name: a.alias_name||'',
              created_at: a.created_at||''
            };
            const q = buildDynamicInsert('product_analysis_group_aliases',
              ['id','store_id','group_id','alias_name','created_at'],
              src, alsCols, orMode);
            if (!q) { results.analysis_aliases.skipped++; continue; }
            const n = rawRunCount(raw, q.sql, q.vals);
            if (n > 0) results.analysis_aliases.added++; else results.analysis_aliases.skipped++;
          } catch(e) {
            results.analysis_aliases.errors.push(`id=${a.id}: ${e.message}`);
            results.analysis_aliases.failed++;
            if (strictMode) throw e;
          }
        }

        // ── settings（動態欄位）─────────────────────────────────────────
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

        // ── delivery_platforms（BUG-3 修正：PRAGMA 動態欄位，不硬寫 code）
        // duplicate check：用 store_id + name（若有 name 欄位），否則用 id
        const platCols = schemas['delivery_platforms'];
        for (const p of (d.delivery_platforms||[])) {
          try {
            // 建立 source 物件，涵蓋備份檔可能有的所有欄位名稱
            const src = {
              id: p.id, store_id: storeId,
              // code：僅在 DB 有此欄位時才會寫入（buildDynamicInsert 自動過濾）
              code: p.code||'',
              // 相容各版本欄位命名
              name: p.name||p.platform_name||'',
              platform_name: p.platform_name||p.name||'',
              commission_rate: p.commission_rate||0,
              is_active: p.is_active??1,
              created_at: p.created_at||'', updated_at: p.updated_at||''
            };
            // 候選欄位：依 DB 實際有的欄位篩選
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

        // ── delivery_fees（動態欄位）────────────────────────────────────
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

      }); // ── end runInTransaction ─────────────────────────────────────

    } catch(txErr) {
      // replace 模式 rollback 後直接回傳錯誤
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

    // ── 彙整總計與錯誤清單 ───────────────────────────────────────────────
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
      status: overallStatus,                         // 'success' | 'partial'
      status_label: overallStatus === 'partial'      // 給前端顯示用
        ? '部分匯入完成，有錯誤'
        : '匯入完成',
      summary: {
        total_added:   totalAdded,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_failed:  totalFailed
      },
      table_errors: tableErrors,                     // 失敗資料表清單
      results                                        // 逐表明細
    });

  } catch(e) {
    console.error('[migration/import]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
