// routes/importExport.js — SaaS R1 fix1（多店隔離版）
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { requireFeature } = require('../middleware/featureGate');

// ── CSV helpers ──────────────────────────────────────────
function parseCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur); return result;
}
function toCsvLine(vals) {
  return vals.map(v => { const s = String(v==null?'':v); return s.includes(',')||s.includes('"')||s.includes('\n')?'"'+s.replace(/"/g,'""')+'"':s; }).join(',');
}
function toCsv(headers, rows) {
  return [toCsvLine(headers), ...rows.map(r => toCsvLine(headers.map(h => r[h]??'')))].join('\n');
}
const BOM = '\uFEFF';

// ── TEMPLATES（不需 store_id）───────────────────────────
router.get('/template/products', (req, res) => {
  const headers = ['商品名稱','分類','售價','每份克數','低庫存警戒(份)','LINE是否上架(1/0)','LINE售價','LINE描述','LINE圖片URL','熱銷(1/0)','優惠(1/0)'];
  const sample  = [['冷拌麻油腰子','主食','150','200','5','1','150','招牌限量','','1','0']];
  const csv = BOM + [toCsvLine(headers), ...sample.map(toCsvLine)].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="products_template.csv"');
  res.send(csv);
});
router.get('/template/product-inventory', (req, res) => {
  const headers = ['商品名稱','每份克數','補充庫存(g)','低庫存警戒(份)'];
  const sample  = [['冷拌麻油腰子','200','3000','5']];
  const csv = BOM + [toCsvLine(headers), ...sample.map(toCsvLine)].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="product_inventory_template.csv"');
  res.send(csv);
});
router.get('/template/ingredients', (req, res) => {
  const headers = ['食材名稱','單位(g/斤/kg)','冷凍庫存','低庫存警戒值','預設解凍時間(小時)','備註'];
  const sample  = [['豬腰','斤','5','2','8','每日早上進貨']];
  const csv = BOM + [toCsvLine(headers), ...sample.map(toCsvLine)].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ingredients_template.csv"');
  res.send(csv);
});
router.get('/template/ingredient-formulas', (req, res) => {
  const headers = ['商品名稱','食材名稱','每份扣除量(g)'];
  const sample  = [['冷拌麻油腰子','豬腰','200']];
  const csv = BOM + [toCsvLine(headers), ...sample.map(toCsvLine)].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ingredient_formulas_template.csv"');
  res.send(csv);
});

// ── EXPORT（限 store_id）────────────────────────────────
router.get('/export/products', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const products = db.all('SELECT * FROM products WHERE store_id=? ORDER BY sort_order ASC, id ASC', [storeId]);
    const headers = ['商品名稱','分類','售價','每份克數','目前庫存(g)','低庫存警戒(份)',
      '商品狀態','LINE是否上架','LINE售價','LINE描述','LINE圖片URL','LINE顯示分類',
      '熱銷標籤','優惠標籤','今日完售','商品圖片URL'];
    const rows = products.map(p => ({
      '商品名稱': p.name, '分類': p.category, '售價': p.price,
      '每份克數': p.allocated_grams||'', '目前庫存(g)': p.current_stock_grams||0,
      '低庫存警戒(份)': p.low_stock_alert||5, '商品狀態': p.sale_status||'available',
      'LINE是否上架': p.show_on_line||1, 'LINE售價': p.line_price||'',
      'LINE描述': p.line_description||'', 'LINE圖片URL': p.line_image_url||'',
      'LINE顯示分類': p.line_category||'', '熱銷標籤': p.line_hot||0,
      '優惠標籤': p.line_promo||0, '今日完售': p.line_sold_out||0, '商品圖片URL': p.image||'',
    }));
    const csv = BOM + toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products_${storeId}_export.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/export/product-inventory', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const products = db.all('SELECT * FROM products WHERE store_id=? AND inventory_enabled=1 ORDER BY sort_order ASC, id ASC', [storeId]);
    const headers = ['商品名稱','每份克數','目前庫存(g)','可售數量','低庫存警戒(份)','食材控管'];
    const rows = products.map(p => {
      const formulas = db.all('SELECT f.amount_per_unit,i.refrigerated_stock,i.unit as ing_unit FROM product_ingredient_formulas f LEFT JOIN ingredients i ON i.id=f.ingredient_id WHERE f.product_id=?', [p.id]);
      let stockG = p.current_stock_grams||0, units = 0, ingControlled = '否';
      if (formulas.length > 0) {
        ingControlled = '是'; let minU = Infinity;
        formulas.forEach(f => { const rG = toGrams(Number(f.refrigerated_stock||0),f.ing_unit||'g'); const pu = Number(f.amount_per_unit||0); const u = pu>0?Math.floor(rG/pu):0; if(u<minU){minU=u;stockG=rG;} });
        units = minU===Infinity?0:minU;
      } else { const alloc=Number(p.allocated_grams||0); units=alloc>0?Math.floor(stockG/alloc):0; }
      return { '商品名稱': p.name, '每份克數': p.allocated_grams||'', '目前庫存(g)': Number(stockG).toFixed(2), '可售數量': units, '低庫存警戒(份)': p.low_stock_alert||5, '食材控管': ingControlled };
    });
    const csv = BOM + toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="product_inventory_${storeId}_export.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/export/ingredients', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const ings = db.all('SELECT * FROM ingredients WHERE store_id=? ORDER BY id ASC', [storeId]);
    const headers = ['食材名稱','單位','冷凍庫存','解凍中','冷藏可販售','總庫存','低庫存警戒值','預設解凍時間(小時)','備註'];
    const rows = ings.map(i => ({
      '食材名稱': i.name, '單位': i.unit, '冷凍庫存': i.frozen_stock||0,
      '解凍中': i.thawing_stock||0, '冷藏可販售': i.refrigerated_stock||0,
      '總庫存': i.total_stock||0, '低庫存警戒值': i.low_stock_threshold||0,
      '預設解凍時間(小時)': i.default_thaw_hours||0, '備註': i.notes||'',
    }));
    const csv = BOM + toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ingredients_${storeId}_export.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/export/ingredient-formulas', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const formulas = db.all(`SELECT f.*,p.name as product_name,i.name as ingredient_name
      FROM product_ingredient_formulas f
      INNER JOIN products p ON p.id=f.product_id AND p.store_id=?
      INNER JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=?
      ORDER BY f.id ASC`, [storeId, storeId]);
    const headers = ['商品名稱','食材名稱','每份扣除量(g)'];
    const rows = formulas.map(f => ({ '商品名稱': f.product_name||'', '食材名稱': f.ingredient_name||'', '每份扣除量(g)': f.amount_per_unit||0 }));
    const csv = BOM + toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ingredient_formulas_${storeId}_export.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── IMPORT（限 store_id）────────────────────────────────
router.post('/import/products', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(400).json({ success: false, message: 'rows 必填' });
    let added=0, updated=0, failed=0; const errors=[];
    rows.forEach((r, idx) => {
      try {
        const name = (r['商品名稱']||'').trim();
        if (!name) { errors.push(`第${idx+2}行：商品名稱不可空白`); failed++; return; }
        const cat = (r['分類']||'主食').trim();
        const price = parseFloat(r['售價']||0);
        if (price < 0) { errors.push(`第${idx+2}行：售價不可為負數`); failed++; return; }
        // 分類需屬於此店
        let catRow = db.get('SELECT id FROM categories WHERE store_id=? AND name=?', [storeId, cat]);
        let catId = catRow ? Number(catRow.id) : 0;
        if (!catRow) {
          const r2 = db.run('INSERT OR IGNORE INTO categories (store_id,name,icon,sort_order,is_active) VALUES (?,?,?,99,1)', [storeId, cat, '📌']);
          catId = Number(r2.lastInsertRowid)||0;
          if (!catId) { const c2=db.get('SELECT id FROM categories WHERE store_id=? AND name=?',[storeId,cat]); catId=c2?Number(c2.id):0; }
        }
        const existing = db.get('SELECT id FROM products WHERE store_id=? AND name=?', [storeId, name]);
        if (existing) {
          db.run(`UPDATE products SET category=?,category_id=?,price=?,allocated_grams=?,low_stock_alert=?,show_on_line=?,line_price=?,line_description=?,line_image_url=?,line_category=?,line_hot=?,line_promo=?,line_sold_out=?,image=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
            [cat,catId,price,parseFloat(r['每份克數']||0)||0,parseInt(r['低庫存警戒(份)']||5)||5,parseInt(r['LINE是否上架']??1),parseFloat(r['LINE售價']||0)||0,r['LINE描述']||'',r['LINE圖片URL']||'',r['LINE顯示分類']||'',parseInt(r['熱銷標籤']||0)||0,parseInt(r['優惠標籤']||0)||0,parseInt(r['今日完售']||0)||0,r['商品圖片URL']||'',existing.id,storeId]);
          updated++;
        } else {
          db.run(`INSERT INTO products (store_id,name,category,category_id,price,allocated_grams,low_stock_alert,show_on_line,line_price,line_description,line_image_url,line_category,line_hot,line_promo,line_sold_out,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [storeId,name,cat,catId,price,parseFloat(r['每份克數']||0)||0,parseInt(r['低庫存警戒(份)']||5)||5,parseInt(r['LINE是否上架']??1),parseFloat(r['LINE售價']||0)||0,r['LINE描述']||'',r['LINE圖片URL']||'',r['LINE顯示分類']||'',parseInt(r['熱銷標籤']||0)||0,parseInt(r['優惠標籤']||0)||0,parseInt(r['今日完售']||0)||0,r['商品圖片URL']||'']);
          added++;
        }
      } catch(e) { errors.push(`第${idx+2}行：${e.message}`); failed++; }
    });
    res.json({ success: true, added, updated, failed, errors });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/import/product-inventory', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(400).json({ success: false, message: 'rows 必填' });
    let updated=0, failed=0; const errors=[];
    rows.forEach((r, idx) => {
      try {
        const name = (r['商品名稱']||'').trim();
        if (!name) { errors.push(`第${idx+2}行：商品名稱不可空白`); failed++; return; }
        const prod = db.get('SELECT * FROM products WHERE store_id=? AND name=?', [storeId, name]);
        if (!prod) { errors.push(`第${idx+2}行：商品「${name}」不存在`); failed++; return; }
        const allocG=parseFloat(r['每份克數'])||Number(prod.allocated_grams)||0;
        const addG=parseFloat(r['補充庫存(g)'])||0;
        const lowAlert=parseInt(r['低庫存警戒(份)'])||Number(prod.low_stock_alert)||5;
        if (addG<0) { errors.push(`第${idx+2}行：庫存不可為負數`); failed++; return; }
        const newStock=Number(prod.current_stock_grams||0)+addG;
        db.run(`UPDATE products SET allocated_grams=?,current_stock_grams=?,low_stock_alert=?,inventory_enabled=1,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
          [allocG,newStock,lowAlert,prod.id,storeId]);
        updated++;
      } catch(e) { errors.push(`第${idx+2}行：${e.message}`); failed++; }
    });
    res.json({ success: true, updated, failed, errors });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/import/ingredients', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(400).json({ success: false, message: 'rows 必填' });
    let added=0, updated=0, failed=0; const errors=[];
    rows.forEach((r, idx) => {
      try {
        const name=(r['食材名稱']||'').trim();
        if (!name) { errors.push(`第${idx+2}行：食材名稱不可空白`); failed++; return; }
        const unit=(r['單位(g/斤/kg)']||r['單位']||'g').trim();
        const frozen=parseFloat(r['冷凍庫存']||0);
        const threshold=parseFloat(r['低庫存警戒值']||0);
        const thawHours=parseFloat(r['預設解凍時間(小時)']||0);
        const notes=r['備註']||'';
        if (frozen<0||threshold<0) { errors.push(`第${idx+2}行：數量不可為負數`); failed++; return; }
        const existing = db.get('SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, name]);
        if (existing) {
          db.run(`UPDATE ingredients SET unit=?,low_stock_threshold=?,default_thaw_hours=?,notes=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
            [unit,threshold,thawHours,notes,existing.id,storeId]);
          updated++;
        } else {
          db.run(`INSERT OR IGNORE INTO ingredients (store_id,name,unit,frozen_stock,total_stock,low_stock_threshold,default_thaw_hours,notes) VALUES (?,?,?,?,?,?,?,?)`,
            [storeId,name,unit,frozen,frozen,threshold,thawHours,notes]);
          added++;
        }
      } catch(e) { errors.push(`第${idx+2}行：${e.message}`); failed++; }
    });
    res.json({ success: true, added, updated, failed, errors });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/import/ingredient-formulas', requireFeature('inventory'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rows = req.body.rows;
    if (!Array.isArray(rows)||!rows.length) return res.status(400).json({ success: false, message: 'rows 必填' });
    let added=0, updated=0, failed=0; const errors=[];
    rows.forEach((r, idx) => {
      try {
        const pName=(r['商品名稱']||'').trim(), iName=(r['食材名稱']||'').trim();
        const amt=parseFloat(r['每份扣除量(g)']||0);
        if (!pName) { errors.push(`第${idx+2}行：商品名稱不可空白`); failed++; return; }
        if (!iName) { errors.push(`第${idx+2}行：食材名稱不可空白`); failed++; return; }
        if (amt<=0) { errors.push(`第${idx+2}行：每份扣除量需大於 0`); failed++; return; }
        const prod = db.get('SELECT id FROM products WHERE store_id=? AND name=?', [storeId, pName]);
        const ing  = db.get('SELECT id FROM ingredients WHERE store_id=? AND name=?', [storeId, iName]);
        if (!prod) { errors.push(`第${idx+2}行：商品「${pName}」不存在`); failed++; return; }
        if (!ing)  { errors.push(`第${idx+2}行：食材「${iName}」不存在`); failed++; return; }
        const exists = db.get('SELECT id FROM product_ingredient_formulas WHERE product_id=? AND ingredient_id=?',[prod.id,ing.id]);
        if (exists) {
          db.run('UPDATE product_ingredient_formulas SET amount_per_unit=? WHERE id=?',[amt,exists.id]);
          updated++;
        } else {
          db.run('INSERT INTO product_ingredient_formulas (product_id,ingredient_id,amount_per_unit) VALUES (?,?,?)',[prod.id,ing.id,amt]);
          added++;
        }
      } catch(e) { errors.push(`第${idx+2}行：${e.message}`); failed++; }
    });
    res.json({ success: true, added, updated, failed, errors });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
