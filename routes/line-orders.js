// routes/line-orders.js — SaaS R1 fix1（多店隔離版）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getProductInventoryStatus } = require('../utils/inventoryHelper');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

function orderNumber() {
  const n = new Date(), p = (v,l=2) => String(v).padStart(l,'0');
  return `LINE-${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

// ★ 重要：所有 settings 查詢都必須帶 store_id
function getSetting(db, storeId, key, def='') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

async function triggerN8nWebhook(db, storeId, event, payload) {
  try {
    const url = getSetting(db, storeId, 'n8n_webhook_url', '');
    if (!url) return;
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload, triggered_at: new Date().toISOString() }),
      timeout: 5000
    }).catch(() => {});
  } catch {}
}

function broadcastNewOrder(app, order) {
  // ★ fix6：只廣播給同 store_id 的 WebSocket client
  try {
    const wss     = app?.get ? app.get('wss') : null;
    const storeId = order?.store_id || 'store_001';
    broadcastToStore(wss, storeId, { type: 'new_line_order', order });
  } catch {}
}

// ── LINE 點餐資格檢查（依 store_id 讀取設定）──────────────
function checkLineEligibility(db, storeId, orderType, pickupTime, pickupDate) {
  if (getSetting(db, storeId, 'line_ordering_enabled', '1') !== '1')
    return { ok: false, message: 'LINE 點餐目前暫停營業' };

  const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const twDateStr = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
  const dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
  const orderDate = pickupDate || twDateStr;

  const todayClosed = getSetting(db, storeId, 'line_today_closed', '0');
  const closedDate  = getSetting(db, storeId, 'line_today_closed_date', '');
  if (todayClosed === '1' && closedDate === twDateStr && orderDate === twDateStr)
    return { ok: false, message: '今日 LINE 點餐休息，感謝您的理解' };

  if (orderType === 'pickup' && getSetting(db, storeId, 'pickup_enabled', '1') !== '1')
    return { ok: false, message: '目前暫停自取服務' };
  if (orderType === 'delivery' && getSetting(db, storeId, 'delivery_enabled', '1') !== '1')
    return { ok: false, message: '目前暫停外送服務' };

  if (getSetting(db, storeId, 'line_business_hours_enabled', '0') === '1') {
    try {
      const hours = JSON.parse(getSetting(db, storeId, 'line_business_hours', '{}'));
      const targetDate = new Date(orderDate + 'T00:00:00+08:00');
      const pickupWdKey = dayKeys[targetDate.getDay()];
      const dh = hours[pickupWdKey];
      const weekNames = ['週日','週一','週二','週三','週四','週五','週六'];
      if (!dh || !dh.enabled)
        return { ok: false, message: `${orderDate}（${weekNames[targetDate.getDay()]}）非 LINE 點餐營業日` };
      if (pickupTime && pickupTime !== '盡快') {
        const tMatch = String(pickupTime).match(/(\d{1,2}):(\d{2})/);
        if (tMatch) {
          const pHHMM = `${String(tMatch[1]).padStart(2,'0')}:${tMatch[2]}`;
          if (pHHMM < dh.open || pHHMM >= dh.close)
            return { ok: false, message: `選擇的取餐時間（${pHHMM}）不在營業時間內（${dh.open}～${dh.close}）` };
        }
      }
    } catch {}
  }
  return { ok: true };
}

// ── 扣食材冷藏可販售（限 store_id 食材）──────────────────
function deductIngredients(db, storeId, items, orderId) {
  (items || []).forEach(item => {
    const pid = item.product_id || item.id;
    if (!pid) return;
    const formulas = db.all('SELECT * FROM product_ingredient_formulas WHERE product_id=?', [pid]);
    formulas.forEach(f => {
      const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [f.ingredient_id, storeId]);
      if (!ing) return;
      const perUnitG = Number(f.amount_per_unit) * Number(item.qty || 1);
      const deductInUnit = fromGrams(perUnitG, ing.unit || 'g');
      const bRefrig  = Number(ing.refrigerated_stock || 0);
      const newRefrig = Math.max(0, bRefrig - deductInUnit);
      const newTotal  = Math.max(0, Number(ing.total_stock || 0) - deductInUnit);
      db.run(`UPDATE ingredients SET refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
        [newRefrig, newTotal, ing.id, storeId]);
      db.run(`INSERT INTO ingredient_logs
        (ingredient_id,ingredient_name,log_type,before_refrigerated,change_amount,after_refrigerated,
         before_frozen,before_thawing,after_frozen,after_thawing,reason,related_order_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ing.id, ing.name, 'sale_deduct', bRefrig, -deductInUnit, newRefrig,
         ing.frozen_stock, ing.thawing_stock, ing.frozen_stock, ing.thawing_stock,
         'LINE銷售扣料', orderId||'']);
    });
  });
}

// ── GET /shop ──────────────────────────────────────────────
router.get('/shop', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const keys = [
      'shop_name','shop_logo','shop_cover','shop_address','shop_google_map','shop_hours','shop_announcement',
      'line_order_enabled','line_order_min_amount','line_ordering_enabled',
      'line_business_hours_enabled','line_business_hours','pickup_enabled','delivery_enabled',
      'line_today_closed','line_today_closed_date','same_day_preorder_minutes','next_day_preorder_hours',
      'line_closed_weekdays','line_closed_dates',
      'line_payment_cash_enabled','line_payment_linepay_enabled','line_payment_transfer_enabled',
      'line_payment_platform_enabled','line_payment_credit_card_enabled',
    ];
    const settings = {};
    keys.forEach(k => { settings[k] = getSetting(db, storeId, k, ''); });
    const twShopNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const twShopDate = `${twShopNow.getFullYear()}-${String(twShopNow.getMonth()+1).padStart(2,'0')}-${String(twShopNow.getDate()).padStart(2,'0')}`;
    const todayClosed = settings.line_today_closed === '1' && settings.line_today_closed_date === twShopDate;
    settings.is_open = settings.line_ordering_enabled === '1' && !todayClosed;
    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /menu ──────────────────────────────────────────────
router.get('/menu', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';

    const categories = db.all(
      'SELECT * FROM categories WHERE store_id=? AND is_active=1 ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    const activeCatMap = new Map(categories.map(c => [c.id, c]));

    const rawProducts = db.all(
      `SELECT p.*,
              lc.name as line_cat_name, lc.icon as line_cat_icon, lc.sort_order as line_cat_sort, lc.is_active as line_cat_active,
              pc.name as pos_cat_name,  pc.icon as pos_cat_icon,  pc.sort_order as pos_cat_sort,  pc.is_active as pos_cat_active
       FROM products p
       LEFT JOIN categories lc ON lc.id = p.line_category_id AND lc.store_id=?
       LEFT JOIN categories pc ON (pc.id = p.category_id OR (p.category_id = 0 AND pc.name = p.category)) AND pc.store_id=?
       WHERE p.store_id=? AND p.enabled=1 AND p.show_on_line=1
       ORDER BY p.sort_order, p.id`,
      [storeId, storeId, storeId]
    );

    const resolvedProducts = rawProducts.map(p => {
      const lcid = Number(p.line_category_id || 0);
      const pcid = Number(p.category_id || 0);
      let displayCat = null;
      if (lcid > 0 && activeCatMap.has(lcid)) displayCat = activeCatMap.get(lcid);
      if (!displayCat && pcid > 0 && activeCatMap.has(pcid)) displayCat = activeCatMap.get(pcid);
      if (!displayCat && p.category) { const byName = categories.find(c => c.name === p.category); if (byName) displayCat = byName; }
      return {
        ...p,
        displayCatId:   displayCat ? displayCat.id   : 0,
        displayCatName: displayCat ? displayCat.name : '未分類',
        displayCatIcon: displayCat ? displayCat.icon : '📌',
        displayCatSort: displayCat ? Number(displayCat.sort_order) : 9999,
      };
    });

    const filteredProducts = resolvedProducts.filter(p => p.displayCatId > 0 || p.displayCatName === '未分類');
    const usedCatIds = new Set(filteredProducts.map(p => p.displayCatId).filter(id => id > 0));
    const lineCategories = categories.filter(c => usedCatIds.has(c.id));

    // 熱銷（限本店訂單）
    const topRows = db.all(
      `SELECT json_each.value as item_json FROM orders, json_each(orders.items)
       WHERE orders.store_id=? AND orders.created_at >= datetime('now','-30 days') AND orders.status != 'void'`,
      [storeId]
    );
    const saleMap = {};
    topRows.forEach(row => {
      try {
        const item = typeof row.item_json === 'string' ? JSON.parse(row.item_json) : row.item_json;
        if (item?.name) saleMap[item.name] = (saleMap[item.name]||0) + (item.qty||1);
      } catch {}
    });
    const hotNames = new Set(Object.entries(saleMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n])=>n));

    const enriched = filteredProducts.map(p => {
      const basePrice  = Number(p.takeaway_price) > 0 ? Number(p.takeaway_price) : (Number(p.price) || 0);
      const linePrice  = Number(p.line_price) > 0 ? Number(p.line_price) : basePrice;
      const lineName   = (p.line_name||'').trim() || p.name;
      const saleStatus = p.sale_status || 'available';
      const saleLabel  = { available:'正常', sold_out_today:'今日完售', paused:'暫停販售', sold_out_indefinitely:'暫不供應' }[saleStatus] || '正常';

      const formulas = db.all(
        'SELECT f.*,i.refrigerated_stock,i.unit as ing_unit FROM product_ingredient_formulas f LEFT JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=? WHERE f.product_id=?',
        [storeId, p.id]
      );
      let ingredientOk = true, availableUnits = null, availableGrams = null;
      const hasFormula = formulas.length > 0;
      if (hasFormula) {
        let minUnits = Infinity, bottleneckG = Infinity;
        formulas.forEach(f => {
          const refrigG  = toGrams(Number(f.refrigerated_stock||0), f.ing_unit||'g');
          const perUnitG = Number(f.amount_per_unit||0);
          const units    = perUnitG > 0 ? Math.floor(refrigG / perUnitG) : 0;
          if (units < minUnits) { minUnits = units; bottleneckG = refrigG; }
        });
        availableUnits = minUnits === Infinity ? 0 : minUnits;
        availableGrams = bottleneckG === Infinity ? 0 : bottleneckG;
        ingredientOk   = availableUnits > 0;
      } else if (p.inventory_enabled && Number(p.allocated_grams) > 0) {
        const stockG = Number(p.current_stock_grams || 0);
        availableUnits = Math.floor(stockG / Number(p.allocated_grams));
        availableGrams = stockG;
        ingredientOk   = availableUnits > 0;
      }
      const isOrderable = !p.line_sold_out && saleStatus === 'available' && ingredientOk;
      return {
        ...p,
        display_cat_id: p.displayCatId, display_cat_name: p.displayCatName,
        display_cat_icon: p.displayCatIcon, display_cat_sort: p.displayCatSort,
        effective_price: basePrice, effective_line_price: linePrice, effective_line_name: lineName,
        sale_status: saleStatus, sale_status_label: saleLabel,
        ingredient_available: ingredientOk, is_orderable: isOrderable,
        available_units: availableUnits, available_grams: availableGrams,
        has_formula: hasFormula, low_stock_alert: Number(p.low_stock_alert||5),
        is_hot: hotNames.has(p.name),
        line_description: p.line_description||'', line_image_url: p.line_image_url||'',
        line_hot: Number(p.line_hot)||0, line_promo: Number(p.line_promo)||0,
      };
    });

    res.json({ success: true, data: { categories: lineCategories, products: enriched } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /（新 LINE 訂單）──────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const {
      customer_name, customer_phone, customer_line_id,
      order_type, pickup_time, delivery_address,
      note, payment_method, items, subtotal, discount_amount, total
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: '購物車不能為空' });
    if (!customer_name || !customer_phone)
      return res.status(400).json({ success: false, message: '請填寫姓名與電話' });

    const pickup_date = req.body.pickup_date || '';
    const eligible = checkLineEligibility(db, storeId, order_type, pickup_time, pickup_date);
    if (!eligible.ok) return res.status(403).json({ success: false, message: eligible.message });

    // 店休日 + 預訂時間限制
    const WD_MAP2 = ['sun','mon','tue','wed','thu','fri','sat'];
    const twNowV = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const twDateStrV = `${twNowV.getFullYear()}-${String(twNowV.getMonth()+1).padStart(2,'0')}-${String(twNowV.getDate()).padStart(2,'0')}`;
    const validateDate = pickup_date || twDateStrV;
    const targetDayObj = new Date(validateDate + 'T00:00:00+08:00');
    const validateWdKey = WD_MAP2[targetDayObj.getDay()];
    const closedWds2 = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_weekdays', '[]')); } catch { return []; } })();
    const closedDts2 = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_dates', '[]')); } catch { return []; } })();
    if (closedWds2.includes(validateWdKey))
      return res.status(400).json({ success: false, message: `${validateDate} 為固定公休日，請選擇其他日期` });
    if (closedDts2.includes(validateDate))
      return res.status(400).json({ success: false, message: `${validateDate} 為店休日，請選擇其他日期` });
    if (pickup_time && pickup_time !== '盡快' && validateDate === twDateStrV) {
      const [ph, pm] = pickup_time.split(':').map(Number);
      const pTotal   = ph * 60 + pm;
      const nowTotal = twNowV.getHours() * 60 + twNowV.getMinutes();
      const sdMins   = Number(getSetting(db, storeId, 'same_day_preorder_minutes', '30'));
      if (pTotal < nowTotal + sdMins)
        return res.status(400).json({ success: false, message: `此時段距離現在太近，請選擇 ${sdMins} 分鐘後的時段` });
    }

    // 商品驗證（限本店商品）
    for (const item of items) {
      const pid  = item.product_id || item.id;
      const prod = pid ? db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]) : null;
      if (!prod || !prod.enabled || !prod.show_on_line)
        return res.status(400).json({ success: false, message: `商品「${item.name}」已下架` });
      if (prod.sale_status === 'sold_out_today')
        return res.status(400).json({ success: false, message: `「${prod.name}」今日完售` });
      if (prod.sale_status !== 'available')
        return res.status(400).json({ success: false, message: `「${prod.name}」目前無法購買` });

      const formulas = db.all(
        'SELECT f.*,i.refrigerated_stock,i.unit as ing_unit,i.name as ing_name FROM product_ingredient_formulas f LEFT JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=? WHERE f.product_id=?',
        [storeId, prod.id]
      );
      for (const f of formulas) {
        const neededG = Number(f.amount_per_unit) * Number(item.qty||1);
        const refrigG = toGrams(Number(f.refrigerated_stock||0), f.ing_unit||'g');
        if (refrigG < neededG)
          return res.status(400).json({ success: false, message: `「${prod.name}」食材（${f.ing_name}）冷藏可販售庫存不足` });
      }
    }

    // 付款方式驗證
    const PAYMENT_SETTINGS = {
      cash:'line_payment_cash_enabled', linepay:'line_payment_linepay_enabled',
      transfer:'line_payment_transfer_enabled', platform:'line_payment_platform_enabled',
      credit_card:'line_payment_credit_card_enabled',
    };
    const payKey = PAYMENT_SETTINGS[payment_method];
    if (!payKey || getSetting(db, storeId, payKey, '0') !== '1')
      return res.status(400).json({ success: false, message: `付款方式「${payment_method}」目前未開放` });
    const payment_category = payment_method === 'cash' ? 'cash' : 'non_cash';

    const uuid = uuidv4(), orderNo = orderNumber();
    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const pad = (n,l=2) => String(n).padStart(l,'0');
    const now = `${twNow.getFullYear()}-${pad(twNow.getMonth()+1)}-${pad(twNow.getDate())} ${pad(twNow.getHours())}:${pad(twNow.getMinutes())}:${pad(twNow.getSeconds())}`;
    const itemsJson = JSON.stringify(items);
    const finalTotal = Number(total)||Number(subtotal)||0;
    const discAmt    = Number(discount_amount)||0;
    const sub        = Number(subtotal)||0;
    const orderMode  = order_type === 'delivery' ? 'delivery' : 'takeout';
    const pickupTimeVal = (pickup_time && pickup_time.trim()) ? pickup_time.trim() : '';

    db.run(
      `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone, customer_line_id,
        pickup_time, delivery_address, delivery_platform, platform_order_no,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, total,
        note, sync_status, device_id, source, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuid, uuid, orderNo, storeId, orderMode, 'pending', 'pending',
        customer_name, customer_phone, customer_line_id||'',
        pickupTimeVal, delivery_address||'', 'LINE', '',
        itemsJson, payment_method||'cash', payment_category, 'pending',
        sub, 'none', discAmt, finalTotal,
        note||'', 'synced', 'LINE', 'line', now, now
      ]
    );

    deductIngredients(db, storeId, items, orderNo);

    const newOrder = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [uuid, storeId]);
    broadcastNewOrder(req.app, { ...newOrder, items });
    triggerN8nWebhook(db, storeId, 'line_new_order', {
      order_number: orderNo, customer_name, customer_phone,
      customer_line_id: customer_line_id||'', order_type, total: finalTotal,
      payment_method: payment_method||'cash', items
    });

    res.json({ success: true, data: { order_number: orderNo, uuid, total: finalTotal } });
  } catch(e) {
    console.error('[line-orders] POST error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /online（Web POS LINE 訂單列表）──────────────────
router.get('/online', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { status, limit=50, offset=0 } = req.query;
    let where = "WHERE store_id=? AND source='line'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND order_status=?'; params.push(status); }
    const orders = db.all(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ).map(o => ({ ...o, items: typeof o.items==='string' ? JSON.parse(o.items||'[]') : (o.items||[]) }));
    const counts = db.all(
      `SELECT order_status, COUNT(*) as cnt FROM orders WHERE store_id=? AND source='line' GROUP BY order_status`,
      [storeId]
    );
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c.order_status] = Number(c.cnt); });
    res.json({ success: true, data: orders, status_counts: statusCounts });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /online/:id/status ──────────────────────────────
router.patch('/online/:id/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.order_status;
    const valid = ['pending','accepted','preparing','ready','completed','cancelled'];
    if (!valid.includes(newStatus))
      return res.status(400).json({ success: false, message: '無效的狀態值: ' + newStatus });

    const order = db.get(
      `SELECT * FROM orders WHERE store_id=? AND (order_number=? OR id=? OR uuid=?)`,
      [storeId, rawId, rawId, rawId]
    );
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: '找不到訂單：' + rawId });

    const orderNo = order.order_number;
    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET status=?, order_status=?, kitchen_status=?, updated_at=? WHERE order_number=? AND store_id=?`,
      [newStatus, newStatus, newStatus, now, orderNo, storeId]
    );

    const verified = db.get(
      `SELECT order_number, status, order_status, kitchen_status, updated_at FROM orders WHERE order_number=? AND store_id=?`,
      [orderNo, storeId]
    );
    if (!verified || verified.order_status !== newStatus)
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED', expected: newStatus, actual: verified?.order_status });

    const fullOrder = db.get('SELECT * FROM orders WHERE order_number=? AND store_id=?', [orderNo, storeId]);
    try {
      const wss = req.app.get('wss');
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: fullOrder });
    } catch {}
    triggerN8nWebhook(db, storeId, 'line_order_status_changed', {
      order_number: order.order_number, customer_line_id: order.customer_line_id,
      old_status: order.order_status, new_status: newStatus,
      reject_reason: req.body.reject_reason||''
    });
    res.json({ success: true, data: fullOrder });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 共用常數 ────────────────────────────────────────────────
const STATUS_LABELS = { pending:'待確認', accepted:'已接單', preparing:'製作中', ready:'可取餐', completed:'已完成', cancelled:'已取消' };
const ORDER_TYPE_LABELS = { delivery:'外送', takeout:'自取', pickup:'自取' };
const PAYMENT_LABELS = { cash:'現金', linepay:'LINE Pay', transfer:'轉帳', platform:'平台付款', credit_card:'信用卡' };

function safeOrder(order) {
  let items = [];
  try { items = typeof order.items==='string' ? JSON.parse(order.items||'[]') : (order.items||[]); } catch {}
  const phone = String(order.customer_phone || '');
  return {
    order_number: order.order_number, status: order.order_status,
    status_label: STATUS_LABELS[order.order_status] || order.order_status,
    order_type: order.order_mode, order_type_label: ORDER_TYPE_LABELS[order.order_mode] || order.order_mode,
    pickup_time: order.pickup_time||'', customer_name: order.customer_name||'',
    phone_last3: phone.slice(-3), items,
    subtotal: Number(order.subtotal||0), total: Number(order.total||0),
    payment_method: order.payment_method||'', payment_label: PAYMENT_LABELS[order.payment_method]||order.payment_method||'',
    note: order.note||'', created_at: order.created_at, source: order.source,
  };
}

function isFullPhone(input) { return /^\d{6,}$/.test(String(input||'').replace(/[-\s]/g,'')); }

// ── GET /status/:orderNo ──────────────────────────────────
router.get('/status/:orderNo', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const order = db.get(
      'SELECT order_number, order_status, kitchen_status, created_at, total FROM orders WHERE store_id=? AND order_number=?',
      [storeId, req.params.orderNo]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    res.json({ success: true, data: order });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /query ───────────────────────────────────────────
router.post('/query', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rawPhone = String(req.body.phone||req.body.customer_phone||'').trim();
    const rawName  = String(req.body.customer_name||'').trim();
    const rawOrderNo = String(req.body.order_number||'').trim();

    if (!rawPhone && rawOrderNo) {
      const order = db.get("SELECT * FROM orders WHERE store_id=? AND order_number=? AND source='line'", [storeId, rawOrderNo]);
      if (!order) return res.status(404).json({ success: false, message: '查無此訂單' });
      return res.json({ success: true, mode: 'single', orders: [safeOrder(order)] });
    }
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話或電話後三碼' });

    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const todayStr = `${twNow.getFullYear()}-${String(twNow.getMonth()+1).padStart(2,'0')}-${String(twNow.getDate()).padStart(2,'0')}`;
    const threeDaysAgo = (() => { const d=new Date(twNow); d.setDate(d.getDate()-3); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const fullPhone = isFullPhone(rawPhone);

    if (rawOrderNo) {
      const order = db.get("SELECT * FROM orders WHERE store_id=? AND order_number=? AND source='line'", [storeId, rawOrderNo]);
      if (!order) return res.status(404).json({ success: false, message: '查無此訂單，請確認訂單編號或電話' });
      const storedPhone = String(order.customer_phone||'');
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const verified = storedPhone===cleaned || storedPhone.endsWith(cleaned.slice(-3)) || (cleaned.length>=4 && storedPhone.endsWith(cleaned));
      if (!verified) return res.status(403).json({ success: false, message: '查無此訂單，請確認訂單編號或電話' });
      return res.json({ success: true, mode: 'single', orders: [safeOrder(order)] });
    }
    if (fullPhone) {
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const orders = db.all("SELECT * FROM orders WHERE store_id=? AND source='line' AND customer_phone=? ORDER BY created_at DESC LIMIT 30", [storeId, cleaned]);
      if (!orders.length) return res.status(404).json({ success: false, message: '查無訂單記錄，請確認電話號碼' });
      return res.json({ success: true, mode: 'list', orders: orders.map(safeOrder) });
    }
    const last3 = rawPhone.slice(-3);
    if (!/^\d{3}$/.test(last3)) return res.status(400).json({ success: false, message: '電話後三碼請輸入3位數字' });
    if (rawName) {
      const orders = db.all(
        `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND customer_name LIKE ? AND date(created_at) >= ? ORDER BY created_at DESC LIMIT 10`,
        [storeId, last3, `%${rawName}%`, threeDaysAgo]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天訂單，請確認資料或詢問店員' });
      return res.json({ success: true, mode: 'list', orders: orders.map(safeOrder) });
    } else {
      const orders = db.all(
        `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND date(created_at)=? ORDER BY created_at DESC LIMIT 10`,
        [storeId, last3, todayStr]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無今日訂單，請確認電話後三碼或詢問店員' });
      return res.json({ success: true, mode: 'list', orders: orders.map(safeOrder) });
    }
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /history ─────────────────────────────────────────
router.post('/history', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rawPhone = String(req.body.phone||'').trim();
    const rawName  = String(req.body.customer_name||'').trim();
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話' });
    const twNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const threeDaysAgo = (() => { const d=new Date(twNow); d.setDate(d.getDate()-3); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const fullPhone = isFullPhone(rawPhone);
    if (fullPhone) {
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const orders = db.all("SELECT * FROM orders WHERE store_id=? AND source='line' AND customer_phone=? ORDER BY created_at DESC LIMIT 30", [storeId, cleaned]);
      if (!orders.length) return res.status(404).json({ success: false, message: '查無訂單記錄，請確認電話號碼' });
      return res.json({ success: true, orders: orders.map(safeOrder) });
    }
    if (!rawName) return res.status(400).json({ success: false, message: '電話後三碼查詢需搭配姓名' });
    const last3 = rawPhone.slice(-3);
    if (!/^\d{3}$/.test(last3)) return res.status(400).json({ success: false, message: '電話後三碼請輸入3位數字' });
    const orders = db.all(
      `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND customer_name LIKE ? AND date(created_at) >= ? ORDER BY created_at DESC LIMIT 30`,
      [storeId, last3, `%${rawName}%`, threeDaysAgo]
    );
    if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天訂單，請確認資料或詢問店員' });
    return res.json({ success: true, orders: orders.map(safeOrder) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
