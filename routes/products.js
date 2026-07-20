// routes/products.js — SaaS R1 fix15
// fix15：修正路由順序——所有固定路徑必須在 /:id 動態路由之前
// 正確順序：
//   GET  /                        (列表)
//   GET  /line-products/list      (固定路徑 ← 必須在 /:id 前)
//   POST /                        (新增)
//   POST /reset-sold-out-today    (固定路徑 ← 必須在 /:id 前)
//   GET  /:id                     (動態)
//   PUT  /:id
//   DELETE /:id
//   PATCH /:id/line-settings
//   PATCH /:id/line-status
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { requireFeature } = require('../middleware/featureGate');
const { calcUnits } = require('./inventory');

// fix18-10-hotfix30-B 第三點：正規化任意輸入為 0/1，不信任任意字串
// （只接受布林、0/1、"0"/"1"/"true"/"false"，其餘一律視為安全預設 1）
function _toModeBit(val) {
  if (val === true || val === 1 || val === '1' || val === 'true') return 1;
  if (val === false || val === 0 || val === '0' || val === 'false') return 0;
  return 1;
}

function enrichProduct(p) {
  if (!p) return null;
  const hasFormula = !!p._has_formula;
  const units = (p.inventory_enabled && p.allocated_grams > 0 && !hasFormula)
    ? Math.floor(p.current_stock_grams / p.allocated_grams) : null;
  const dip = Number(p.dine_in_price)  || Number(p.price) || 0;
  const tap = Number(p.takeaway_price) || dip;
  const dep = Number(p.delivery_price) || tap;
  const linePrice = Number(p.line_price) || 0;
  const effectiveLinePrice = linePrice > 0 ? linePrice : Number(p.price) || 0;
  const effectiveLineName  = (p.line_name && p.line_name.trim()) ? p.line_name : p.name;
  const saleStatus  = p.sale_status || 'available';
  const showOnLine  = p.show_on_line != null ? Number(p.show_on_line) : 1;
  const saleStatusLabel = {
    available:'正常販售', sold_out_today:'今日完售',
    paused:'暫停販售', sold_out_indefinitely:'長期下架'
  }[saleStatus] || saleStatus;
  return {
    ...p,
    dine_in_price: dip, takeaway_price: tap, delivery_price: dep,
    available_units: units,
    is_low_stock:    units !== null && units <= Number(p.low_stock_alert || 5) && units > 0,
    is_out_of_stock: units !== null && units <= 0,
    show_on_line: showOnLine, line_name: p.line_name || '',
    line_price: linePrice, line_description: p.line_description || '',
    line_image_url: p.line_image_url || '', line_category: p.line_category || '',
    line_spec: p.line_spec || '', // fix18-10-hotfix19：LINE 通路獨立規格
    line_category_id: Number(p.line_category_id) || 0,
    effective_line_cat_id: Number(p.line_category_id) || Number(p.category_id) || 0,
    product_barcode: p.product_barcode || '',
    line_hot: Number(p.line_hot) || 0, line_promo: Number(p.line_promo) || 0,
    line_sold_out: Number(p.line_sold_out) || 0,
    // fix18-10-hotfix30-B：LINE 點餐販售模式（外帶/外送），零設定時預設皆啟用（與舊版行為一致）
    line_takeout_enabled:  p.line_takeout_enabled  != null ? Number(p.line_takeout_enabled)  : 1,
    line_delivery_enabled: p.line_delivery_enabled != null ? Number(p.line_delivery_enabled) : 1,
    sale_status: saleStatus, sale_status_label: saleStatusLabel,
    sold_out_until: p.sold_out_until || '',
    auto_restore_next_day: Number(p.auto_restore_next_day) ?? 1,
    effective_line_price: effectiveLinePrice, effective_line_name: effectiveLineName,
    is_line_orderable: showOnLine === 1 && !p.line_sold_out && saleStatus === 'available',
    has_formula: !!p._has_formula,
    // LINE 可售份數（今日現貨）
    line_quota_enabled:        Number(p.line_quota_enabled)        || 0,
    line_quota_daily:          Number(p.line_quota_daily)          || 0,
    line_quota_sold:           Number(p.line_quota_sold)           || 0,
    line_quota_low_threshold:  Number(p.line_quota_low_threshold)  || 2,
    line_quota_high_threshold: Number(p.line_quota_high_threshold) || 10,
    line_sell_start:           p.line_sell_start || '',
    line_sell_end:             p.line_sell_end   || '',
    line_quota_remaining: Number(p.line_quota_enabled)
      ? Math.max(0, Number(p.line_quota_daily||0) - Number(p.line_quota_sold||0))
      : null,
    // LINE 預購數量（明日/未來預購，獨立於今日 line_quota_*）
    line_preorder_enabled:        Number(p.line_preorder_enabled)        || 0,
    line_preorder_daily:          Number(p.line_preorder_daily)          || 0,
    line_preorder_sold:           Number(p.line_preorder_sold)           || 0,
    line_preorder_low_threshold:  Number(p.line_preorder_low_threshold)  || 2,
    line_preorder_high_threshold: Number(p.line_preorder_high_threshold) || 10,
    line_preorder_remaining: Number(p.line_preorder_enabled)
      ? Math.max(0, Number(p.line_preorder_daily||0) - Number(p.line_preorder_sold||0))
      : null,
    // fix18-10-hotfix18：LINE 冷藏宅配中心 V1
    shipping_enabled:          Number(p.shipping_enabled)          || 0,
    shipping_name:             p.shipping_name || '',
    shipping_spec:             p.shipping_spec || '',
    shipping_sort_order:       Number(p.shipping_sort_order)       || 0,
    shipping_upsell:           Number(p.shipping_upsell)           || 0,
    shipping_share_line_stock: p.shipping_share_line_stock != null ? Number(p.shipping_share_line_stock) : 1,
    // fix18-10-hotfix19：宅配通路獨立售價/描述/圖片（不與 LINE 通路互相影響）
    shipping_price:            Number(p.shipping_price) || 0,
    shipping_description:      p.shipping_description || '',
    shipping_image_url:        p.shipping_image_url || '',
  };
}

// ══════════════════════════════════════════════════════════
// ★ 固定路徑 (static routes) — 必須全部在 /:id 之前
// ══════════════════════════════════════════════════════════

/* GET /api/products — 商品列表 */
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { category, enabled } = req.query;
    let sql = 'SELECT * FROM products WHERE store_id=?';
    const p = [storeId];
    if (category) { sql += ' AND category=?'; p.push(category); }
    if (enabled !== undefined) { sql += ' AND enabled=?'; p.push(Number(enabled)); }
    sql += ' ORDER BY sort_order ASC, id ASC';
    const rows = db.all(sql, p).map(r => {
      const fc = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas WHERE product_id=?', [r.id]);
      r._has_formula = fc && Number(fc.c) > 0;
      return enrichProduct(r);
    });
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* GET /api/products/line-products/list — ★ 固定路徑，在 /:id 之前
   v1 擴充：回傳全部 enabled 商品（含未上架），方便 Web 後台總表管理 */
router.get('/line-products/list', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    // 回傳全部 enabled 商品，show_on_line 不限（管理頁需看到未上架）
    const products = db.all(
      'SELECT * FROM products WHERE store_id=? AND enabled=1 ORDER BY sort_order, id',
      [storeId]
    ).map(p => {
      const fc = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas WHERE product_id=?', [p.id]);
      p._has_formula = fc && Number(fc.c) > 0;
      return enrichProduct(p);
    });
    res.json({ success: true, data: products });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* POST /api/products — 新增商品 */
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { name, category='主食', price, sort_order=0, image='',
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled=0, total_stock_grams=0,
      allocated_grams=0, current_stock_grams=0, low_stock_alert=5 } = req.body;
    if (!name || price === undefined)
      return res.status(400).json({ success: false, message: '名稱與價格為必填' });
    const bp  = parseFloat(price);
    const dip = dine_in_price  != null ? parseFloat(dine_in_price)  : bp;
    const tap = takeaway_price != null ? parseFloat(takeaway_price) : dip;
    const dep = delivery_price != null ? parseFloat(delivery_price) : tap;
    const r = db.run(
      `INSERT INTO products (store_id,name,category,price,sort_order,image,
        dine_in_price,takeaway_price,delivery_price,
        inventory_enabled,total_stock_grams,allocated_grams,current_stock_grams,low_stock_alert)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, name, category, bp, sort_order, image || '', dip, tap, dep,
       inventory_enabled ? 1 : 0, Number(total_stock_grams),
       Number(allocated_grams), Number(current_stock_grams), Number(low_stock_alert)]
    );
    res.status(201).json({
      success: true,
      data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [r.lastInsertRowid]))
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* POST /api/products/reset-sold-out-today — ★ 固定路徑，在 /:id 之前 */
router.post('/reset-sold-out-today', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    db.run(
      `UPDATE products SET sale_status='available', updated_at=datetime('now','localtime')
       WHERE store_id=? AND sale_status='sold_out_today' AND auto_restore_next_day=1`,
      [storeId]
    );
    res.json({ success: true, message: '已重置今日完售商品' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════
// ★ 動態路徑 (dynamic routes /:id) — 必須全部在固定路徑之後
// ══════════════════════════════════════════════════════════

/* GET /api/products/:id */
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const product = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!product) return res.status(404).json({ success: false, message: '商品不存在' });
    const fc = db.get('SELECT COUNT(*) as c FROM product_ingredient_formulas WHERE product_id=?', [product.id]);
    product._has_formula = fc && Number(fc.c) > 0;
    res.json({ success: true, data: enrichProduct(product) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PUT /api/products/:id */
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ex = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const { name, category, price, enabled, sort_order, image,
      dine_in_price, takeaway_price, delivery_price,
      inventory_enabled, total_stock_grams, allocated_grams, current_stock_grams, low_stock_alert } = req.body;
    const newPrice = price !== undefined ? parseFloat(price) : ex.price;
    const newDip   = dine_in_price  !== undefined ? parseFloat(dine_in_price)  : (ex.dine_in_price  || newPrice);
    const newTap   = takeaway_price !== undefined ? parseFloat(takeaway_price) : (ex.takeaway_price || newDip);
    const newDep   = delivery_price !== undefined ? parseFloat(delivery_price) : (ex.delivery_price || newTap);
    db.run(
      `UPDATE products SET
        name=?,category=?,price=?,enabled=?,sort_order=?,image=?,
        dine_in_price=?,takeaway_price=?,delivery_price=?,
        inventory_enabled=?,total_stock_grams=?,allocated_grams=?,
        current_stock_grams=?,low_stock_alert=?,
        updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [name ?? ex.name, category ?? ex.category, newPrice,
       enabled !== undefined ? Number(enabled) : ex.enabled,
       sort_order !== undefined ? sort_order : ex.sort_order,
       image !== undefined ? image : (ex.image || ''),
       newDip, newTap, newDep,
       inventory_enabled !== undefined ? Number(inventory_enabled) : ex.inventory_enabled,
       total_stock_grams !== undefined ? Number(total_stock_grams) : ex.total_stock_grams,
       allocated_grams !== undefined ? Number(allocated_grams) : ex.allocated_grams,
       current_stock_grams !== undefined ? Number(current_stock_grams) : ex.current_stock_grams,
       low_stock_alert !== undefined ? Number(low_stock_alert) : ex.low_stock_alert,
       req.params.id, storeId]
    );
    res.json({
      success: true,
      data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [req.params.id]))
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* DELETE /api/products/:id */
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    if (!db.get('SELECT id FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]))
      return res.status(404).json({ success: false, message: '商品不存在' });
    db.run('DELETE FROM products WHERE id=? AND store_id=?', [req.params.id, storeId]);
    res.json({ success: true, message: '商品已刪除' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ── ensureProductPreorderColumns ────────────────────────────────────────
   每次 PATCH /line-settings 執行前呼叫。
   用同一個 db wrapper 的 PRAGMA 確認欄位，缺少就 ALTER TABLE ADD COLUMN。
   - 不依賴 utils/db.js 的 initTables，因為 Zeabur 舊 DB 可能在 initTables
     之前就已經建立，且 sql.js 的 forEach run() 在特定狀態下可能靜默略過。
   - 相容 db.all / db.exec 兩種 sql.js 介面。
   - 每次 ALTER 後呼叫 db.save()（若存在）確保寫回磁碟。
   ─────────────────────────────────────────────────────────────────────── */
function ensureProductPreorderColumns(db) {
  const COLS = [
    ['line_preorder_enabled',        'INTEGER DEFAULT 0'],
    ['line_preorder_daily',          'INTEGER DEFAULT 0'],
    ['line_preorder_sold',           'INTEGER DEFAULT 0'],
    ['line_preorder_low_threshold',  'INTEGER DEFAULT 2'],
    ['line_preorder_high_threshold', 'INTEGER DEFAULT 10'],
  ];
  try {
    // 取得現有欄位清單：優先用 db.all，若不存在改用 db.exec（sql.js 原生 API）
    let existCols;
    if (typeof db.all === 'function') {
      existCols = db.all('PRAGMA table_info(products)').map(r => r.name);
    } else if (typeof db.exec === 'function') {
      const result = db.exec('PRAGMA table_info(products)');
      existCols = (result && result[0] && result[0].values)
        ? result[0].values.map(row => row[1])   // column index 1 = name
        : [];
    } else {
      console.error('[products] ensureProductPreorderColumns: db 不支援 all/exec');
      return;
    }
    for (const [col, def] of COLS) {
      if (existCols.includes(col)) continue;
      try {
        db.run(`ALTER TABLE products ADD COLUMN ${col} ${def}`);
        if (typeof db.save === 'function') db.save();
        console.log(`[products] ✅ ALTER TABLE products ADD COLUMN ${col}`);
      } catch (e2) {
        // 若已存在（race condition）則忽略，其他錯誤印出
        if (!/already exists/i.test(e2.message)) {
          console.error(`[products] ❌ ALTER TABLE 失敗 ${col}:`, e2.message);
        }
      }
    }
  } catch (e) {
    console.error('[products] ensureProductPreorderColumns 失敗:', e.message);
  }
}

/* fix18-10-hotfix30-B 第十二點：line_takeout_enabled / line_delivery_enabled 的
   runtime-safe 補欄位（與 ensureProductPreorderColumns 相同模式）——確保正式環境
   即使沒有手動跑過 scripts/migrate-hotfix30-a-product-mode.js，第一次呼叫商品
   相關 API 時仍會自動補上欄位，不會出現 "no such column" 錯誤。可重複呼叫。 */
function ensureProductModeColumns(db) {
  const COLS = [
    ['line_takeout_enabled',  'INTEGER DEFAULT 1'],
    ['line_delivery_enabled', 'INTEGER DEFAULT 1'],
  ];
  try {
    let existCols;
    if (typeof db.all === 'function') {
      existCols = db.all('PRAGMA table_info(products)').map(r => r.name);
    } else if (typeof db.exec === 'function') {
      const result = db.exec('PRAGMA table_info(products)');
      existCols = (result && result[0] && result[0].values)
        ? result[0].values.map(row => row[1])
        : [];
    } else {
      console.error('[products] ensureProductModeColumns: db 不支援 all/exec');
      return;
    }
    for (const [col, def] of COLS) {
      if (existCols.includes(col)) continue;
      try {
        db.run(`ALTER TABLE products ADD COLUMN ${col} ${def}`);
        if (typeof db.save === 'function') db.save();
        console.log(`[products] ✅ ALTER TABLE products ADD COLUMN ${col}`);
      } catch (e2) {
        if (!/already exists/i.test(e2.message)) {
          console.error(`[products] ❌ ALTER TABLE 失敗 ${col}:`, e2.message);
        }
      }
    }
  } catch (e) {
    console.error('[products] ensureProductModeColumns 失敗:', e.message);
  }
}

/* PATCH /api/products/:id/line-settings */
router.patch('/:id/line-settings', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    // BUG-001 修正：確保 line_preorder_* 欄位存在，防止 Zeabur 舊 DB 出現
    //   "no such column: line_preorder_enabled"
    ensureProductPreorderColumns(db);
    ensureProductModeColumns(db);
    const storeId = req.storeId;
    const id = req.params.id;
    const ex = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const {
      show_on_line, line_name, line_price, line_description,
      line_image_url, line_category, line_category_id, line_hot, line_promo,
      line_sold_out, sale_status, sold_out_until, auto_restore_next_day, product_barcode,
      line_spec, // fix18-10-hotfix19：LINE 通路獨立規格
      // LINE 接單與可售管理中心 v1 新增欄位
      line_quota_enabled, line_quota_daily, line_quota_sold,
      line_quota_low_threshold, line_quota_high_threshold,
      line_sell_start, line_sell_end,
      // fix18-10-hotfix30-B 第二、三點：LINE 點餐販售模式（外帶/外送），只影響 line-order.html，
      // 不得與宅配設定（shipping_*）混用。未傳入時保持既有值，不強制覆蓋。
      line_takeout_enabled, line_delivery_enabled,
    } = req.body;
    // 至少必須啟用一種模式——用「更新後的最終值」判斷，未傳入的欄位視為沿用現有資料庫值。
    if (line_takeout_enabled !== undefined || line_delivery_enabled !== undefined) {
      const finalTakeout  = line_takeout_enabled  !== undefined ? _toModeBit(line_takeout_enabled)  : Number(ex.line_takeout_enabled  ?? 1);
      const finalDelivery = line_delivery_enabled !== undefined ? _toModeBit(line_delivery_enabled) : Number(ex.line_delivery_enabled ?? 1);
      if (finalTakeout === 0 && finalDelivery === 0) {
        return res.status(400).json({ success: false, message: 'LINE 點餐商品至少必須啟用外帶或外送其中一種販售方式。' });
      }
    }
    const sets = []; const vals = [];
    const add = (col, val) => { if (val !== undefined) { sets.push(`${col}=?`); vals.push(val); } };
    add('show_on_line',          show_on_line          != null ? Number(show_on_line)          : undefined);
    add('line_name',             line_name);
    add('line_price',            line_price             != null ? Number(line_price)            : undefined);
    add('line_description',      line_description);
    add('line_image_url',        line_image_url);
    add('line_spec',             line_spec);
    add('line_hot',              line_hot               != null ? Number(line_hot)              : undefined);
    add('line_promo',            line_promo             != null ? Number(line_promo)            : undefined);
    add('line_sold_out',         line_sold_out          != null ? Number(line_sold_out)         : undefined);
    add('sale_status',           sale_status);
    add('sold_out_until',        sold_out_until);
    add('auto_restore_next_day', auto_restore_next_day  != null ? Number(auto_restore_next_day) : undefined);
    add('product_barcode',       product_barcode);
    // v1：LINE 可售份數欄位（僅影響 LINE，不動主庫存）
    add('line_quota_enabled',        line_quota_enabled        != null ? Number(line_quota_enabled)        : undefined);
    add('line_quota_daily',          line_quota_daily          != null ? Number(line_quota_daily)          : undefined);
    // line_quota_sold 允許手動重置（設為 0）
    add('line_quota_sold',           line_quota_sold           != null ? Number(line_quota_sold)           : undefined);
    add('line_quota_low_threshold',  line_quota_low_threshold  != null ? Number(line_quota_low_threshold)  : undefined);
    add('line_quota_high_threshold', line_quota_high_threshold != null ? Number(line_quota_high_threshold) : undefined);
    add('line_sell_start',           line_sell_start);
    add('line_sell_end',             line_sell_end);
    // fix18-10-hotfix30-B：LINE 點餐販售模式（外帶/外送），正規化為 0/1，不信任任意字串
    add('line_takeout_enabled',  line_takeout_enabled  !== undefined ? _toModeBit(line_takeout_enabled)  : undefined);
    add('line_delivery_enabled', line_delivery_enabled !== undefined ? _toModeBit(line_delivery_enabled) : undefined);
    // LINE 預購數量欄位
    const { line_preorder_enabled, line_preorder_daily, line_preorder_sold,
            line_preorder_low_threshold, line_preorder_high_threshold } = req.body;
    add('line_preorder_enabled',        line_preorder_enabled        != null ? Number(line_preorder_enabled)        : undefined);
    add('line_preorder_daily',          line_preorder_daily          != null ? Number(line_preorder_daily)          : undefined);
    add('line_preorder_sold',           line_preorder_sold           != null ? Number(line_preorder_sold)           : undefined);
    add('line_preorder_low_threshold',  line_preorder_low_threshold  != null ? Number(line_preorder_low_threshold)  : undefined);
    add('line_preorder_high_threshold', line_preorder_high_threshold != null ? Number(line_preorder_high_threshold) : undefined);
    if (line_category_id !== undefined) {
      const catId = Number(line_category_id);
      add('line_category_id', catId);
      if (catId > 0) {
        const catRow = db.get('SELECT name FROM categories WHERE id=? AND store_id=?', [catId, storeId]);
        if (catRow) add('line_category', catRow.name);
      } else if (line_category !== undefined) { add('line_category', line_category); }
    } else if (line_category !== undefined) {
      add('line_category', line_category);
      const catRow = db.get('SELECT id FROM categories WHERE name=? AND store_id=?', [line_category, storeId]);
      if (catRow) add('line_category_id', catRow.id);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的欄位' });
    sets.push("updated_at=datetime('now','localtime')");
    vals.push(id); vals.push(storeId);
    db.run(`UPDATE products SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);
    const updated = db.get('SELECT * FROM products WHERE id=?', [id]);
    // 計算 LINE 剩餘份數供前端顯示
    const quotaRemaining = Number(updated.line_quota_enabled)
      ? Math.max(0, Number(updated.line_quota_daily||0) - Number(updated.line_quota_sold||0))
      : null;
    res.json({ success: true, data: { ...enrichProduct(updated), line_quota_remaining: quotaRemaining } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/:id/line-status */
router.patch('/:id/line-status', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = req.params.id;
    const ex = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const { sale_status, show_on_line } = req.body;
    const sets = []; const vals = [];
    const validStatuses = ['available', 'sold_out_today', 'paused', 'sold_out_indefinitely'];
    if (sale_status !== undefined) {
      if (!validStatuses.includes(sale_status))
        return res.status(400).json({ success: false, message: '無效的 sale_status' });
      sets.push('sale_status=?'); vals.push(sale_status);
    }
    if (show_on_line !== undefined) { sets.push('show_on_line=?'); vals.push(Number(show_on_line)); }
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的欄位' });
    sets.push("updated_at=datetime('now','localtime')");
    vals.push(id); vals.push(storeId);
    db.run(`UPDATE products SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);
    res.json({ success: true, data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/:id/shipping-settings — fix18-10-hotfix18：LINE 冷藏宅配商品設定 */
router.patch('/:id/shipping-settings', requireFeature('line_order'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = req.params.id;
    const ex = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '商品不存在' });
    const {
      shipping_enabled, shipping_name, shipping_spec,
      shipping_sort_order, shipping_upsell, shipping_share_line_stock,
      shipping_price, shipping_description, shipping_image_url, // fix18-10-hotfix19
    } = req.body;
    const sets = []; const vals = [];
    const add = (col, val) => { if (val !== undefined) { sets.push(`${col}=?`); vals.push(val); } };
    add('shipping_enabled',           shipping_enabled           != null ? Number(shipping_enabled)           : undefined);
    add('shipping_name',              shipping_name);
    add('shipping_spec',              shipping_spec);
    add('shipping_sort_order',        shipping_sort_order        != null ? Number(shipping_sort_order)        : undefined);
    add('shipping_upsell',            shipping_upsell            != null ? Number(shipping_upsell)            : undefined);
    add('shipping_share_line_stock',  shipping_share_line_stock  != null ? Number(shipping_share_line_stock)  : undefined);
    add('shipping_price',             shipping_price             != null ? Number(shipping_price)             : undefined);
    add('shipping_description',       shipping_description);
    add('shipping_image_url',         shipping_image_url);
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的欄位' });
    sets.push("updated_at=datetime('now','localtime')");
    vals.push(id, storeId);
    db.run(`UPDATE products SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);
    res.json({ success: true, data: enrichProduct(db.get('SELECT * FROM products WHERE id=?', [id])) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/batch-inventory-control
 * 批量開啟／關閉食材控管（只影響現場 POS / Web POS，不影響 LINE 點餐）
 * body: { ids: [1,2,3], inventory_enabled: 0|1 }
 */
router.patch('/batch-inventory-control', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { ids, inventory_enabled } = req.body;

    // 驗證
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, message: 'ids 必須為非空陣列' });
    if (inventory_enabled !== 0 && inventory_enabled !== 1)
      return res.status(400).json({ success: false, message: 'inventory_enabled 只能是 0 或 1' });

    const safeIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (safeIds.length === 0)
      return res.status(400).json({ success: false, message: 'ids 內無有效數字' });

    const placeholders = safeIds.map(() => '?').join(',');
    const result = db.run(
      `UPDATE products SET inventory_enabled=?, updated_at=datetime('now','localtime')
       WHERE id IN (${placeholders}) AND store_id=?`,
      [inventory_enabled, ...safeIds, storeId]
    );

    const updated = result.changes ?? 0;
    const skipped = safeIds.length - updated;
    res.json({
      success: true,
      updated,
      skipped,
      message: `已${inventory_enabled ? '開啟' : '關閉'}食材控管：${updated} 筆更新，${skipped} 筆略過（不屬於本店）`
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

/* PATCH /api/products/batch-inventory-settings
 * 批量設定食材控管細節（inventory_enabled、allocated_grams、low_stock_alert）
 * 不清空任何庫存、不刪除配方、不影響 LINE 設定
 * body: { ids:[1,2,3], inventory_enabled:1, allocated_grams:250, low_stock_alert:5 }
 */
router.patch('/batch-inventory-settings', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { ids, inventory_enabled, allocated_grams, low_stock_alert } = req.body;

    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, message: 'ids 必須為非空陣列' });
    if (inventory_enabled !== 0 && inventory_enabled !== 1)
      return res.status(400).json({ success: false, message: 'inventory_enabled 只能是 0 或 1' });
    if (allocated_grams === undefined || Number(allocated_grams) <= 0)
      return res.status(400).json({ success: false, message: 'allocated_grams 必須 > 0' });
    if (low_stock_alert === undefined || Number(low_stock_alert) < 0)
      return res.status(400).json({ success: false, message: 'low_stock_alert 必須 >= 0' });

    const safeIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (safeIds.length === 0)
      return res.status(400).json({ success: false, message: 'ids 內無有效數字' });

    const placeholders = safeIds.map(() => '?').join(',');
    const result = db.run(
      `UPDATE products
       SET inventory_enabled=?, allocated_grams=?, low_stock_alert=?,
           updated_at=datetime('now','localtime')
       WHERE id IN (${placeholders}) AND store_id=?`,
      [inventory_enabled ? 1 : 0, Number(allocated_grams), Number(low_stock_alert), ...safeIds, storeId]
    );

    const updated = result.changes ?? 0;
    const skipped = safeIds.length - updated;
    res.json({
      success: true,
      updated,
      skipped,
      message: `食材控管設定已套用：${updated} 筆更新，${skipped} 筆略過（不屬於本店）`
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix30-B：附掛在 router 上供 server.js 開機時呼叫（router 本身是函式，
// 掛屬性不影響 Express 掛載行為）
router.ensureProductModeColumns = ensureProductModeColumns;

module.exports = router;
