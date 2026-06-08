// routes/line-orders.js — SaaS R1 + LINE 接單與可售管理中心 v1
// 修改重點：
//   1. 外帶/外送完全獨立判斷（各自 enabled/cutoff/prep/business_hours）
//   2. LINE 專屬可售份數（line_quota_*），不動主庫存
//   3. 動態取餐時間：max(現在+prep, 營業開始)
//   4. 公休日/店休日攔截（line_closed_weekdays / line_closed_dates）
//   5. 行銷型售完：real_sold_out vs cutoff_sold_out，均不扣主庫存
//   6. 結帳雙重驗證（加入購物車 + 送單前）
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

function getSetting(db, storeId, key, def='') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// ── 台灣時間工具 ──────────────────────────────────────────
function twNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function twDateStr(d) {
  const dt = d || twNow();
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function timeToMins(hhmm) {
  const [h, m] = String(hhmm||'').split(':').map(Number);
  return (h||0)*60 + (m||0);
}
function minsToTime(mins) {
  return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
}
const WD_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

// ── 公休/店休日判斷 ───────────────────────────────────────
function isClosedDate(db, storeId, dateStr) {
  const dow = WD_KEYS[new Date(dateStr + 'T00:00:00+08:00').getDay()];
  const closedWds = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_weekdays', '[]')); } catch { return []; } })();
  const closedDts = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_dates', '[]')); } catch { return []; } })();
  return { closed: closedWds.includes(dow) || closedDts.includes(dateStr), isWeekly: closedWds.includes(dow) };
}

// ── 模式（外帶 takeout / 外送 delivery）設定讀取 ─────────
function getModeSettings(db, storeId, mode) {
  // mode: 'takeout' | 'delivery'
  if (mode === 'takeout') {
    return {
      enabled:      getSetting(db, storeId, 'takeout_enabled', '1') === '1',
      cutoffTime:   getSetting(db, storeId, 'takeout_cutoff_time', ''),
      prepMins:     Number(getSetting(db, storeId, 'takeout_prep_minutes', '15')),
      allowNextDay: getSetting(db, storeId, 'takeout_allow_next_day', '1') === '1',
      bizHours:     (() => { try { return JSON.parse(getSetting(db, storeId, 'takeout_business_hours', '{}')); } catch { return {}; } })(),
    };
  } else {
    return {
      enabled:      getSetting(db, storeId, 'delivery_enabled', '1') === '1',
      cutoffTime:   getSetting(db, storeId, 'delivery_cutoff_time', ''),
      prepMins:     Number(getSetting(db, storeId, 'delivery_prep_minutes', '30')),
      allowNextDay: getSetting(db, storeId, 'delivery_allow_next_day', '1') === '1',
      bizHours:     (() => { try { return JSON.parse(getSetting(db, storeId, 'delivery_business_hours', '{}')); } catch { return {}; } })(),
    };
  }
}

// ── 模式今日是否已截止（cutoff_sold_out 判斷）─────────────
function isCutoffPassed(cutoffTime, nowMins) {
  if (!cutoffTime) return false;
  return nowMins > timeToMins(cutoffTime);
}

// ── 取得某模式某日的最早可選時間（分鐘）────────────────────
// 若今日超過結束 → 回傳 null（今日無時段）
function getEarliestMins(modeSettings, dateStr, nowMins) {
  const todayStr = twDateStr();
  const isToday = dateStr === todayStr;
  const wdKey = WD_KEYS[new Date(dateStr + 'T00:00:00+08:00').getDay()];
  const dh = modeSettings.bizHours[wdKey];
  // 若 bizHours 完全未設定（空物件），視為全天營業（不限制）
  const bizHoursEmpty = !modeSettings.bizHours || Object.keys(modeSettings.bizHours).length === 0;
  if (!bizHoursEmpty && (!dh || !dh.enabled)) return null; // 非營業日
  const openMins  = dh ? timeToMins(dh.open  || '09:00') : timeToMins('09:00');
  const closeMins = dh ? timeToMins(dh.close || '21:00') : timeToMins('21:00');
  if (isToday) {
    // 最早 = max(現在+prep, 開店時間)，進位至30分鐘格
    const earliest = Math.max(Math.ceil((nowMins + modeSettings.prepMins) / 30) * 30, openMins);
    if (earliest >= closeMins) return null; // 今日已無時段
    return earliest;
  } else {
    return openMins;
  }
}

// ── LINE 商品可售份數檢查 ──────────────────────────────────
function getLineQuotaStatus(product) {
  if (!Number(product.line_quota_enabled)) {
    return { hasQuota: false, remaining: null, reason: null };
  }
  const daily    = Number(product.line_quota_daily  || 0);
  const sold     = Number(product.line_quota_sold   || 0);
  const low      = Number(product.line_quota_low_threshold  || 2);
  const high     = Number(product.line_quota_high_threshold || 10);
  const remaining = Math.max(0, daily - sold);
  let displayLabel = 'available';
  if (remaining <= 0)    displayLabel = 'sold_out';
  else if (remaining <= low)  displayLabel = 'low';
  else if (remaining >= high) displayLabel = 'plenty';
  return { hasQuota: true, daily, sold, remaining, low, high, displayLabel };
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
  try {
    const wss     = app?.get ? app.get('wss') : null;
    const storeId = order?.store_id || 'store_001';
    broadcastToStore(wss, storeId, { type: 'new_line_order', order });
  } catch {}
}

// ── 扣食材冷藏可販售 ──────────────────────────────────────
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
    const now = twNow();
    const todayStr = twDateStr(now);
    const nowMins = now.getHours()*60 + now.getMinutes();

    const keys = [
      'shop_name','shop_logo','shop_cover','shop_address','shop_google_map','shop_hours','shop_announcement',
      'line_order_enabled','line_order_min_amount','line_ordering_enabled',
      'line_business_hours_enabled','line_business_hours','pickup_enabled','delivery_enabled',
      'line_today_closed','line_today_closed_date','same_day_preorder_minutes','next_day_preorder_hours',
      'line_closed_weekdays','line_closed_dates',
      'line_payment_cash_enabled','line_payment_linepay_enabled','line_payment_transfer_enabled',
      'line_payment_platform_enabled','line_payment_credit_card_enabled',
      // v1 新增
      'takeout_enabled','takeout_cutoff_time','takeout_prep_minutes','takeout_allow_next_day','takeout_business_hours',
      'delivery_cutoff_time','delivery_prep_minutes','delivery_allow_next_day','delivery_business_hours',
      'next_day_min_hours',
    ];
    const settings = {};
    keys.forEach(k => { settings[k] = getSetting(db, storeId, k, ''); });

    const isClosed = settings.line_today_closed === '1' && settings.line_today_closed_date === todayStr;
    settings.is_open = settings.line_ordering_enabled === '1' && !isClosed;

    // 外帶/外送獨立狀態
    const takeoutMode   = getModeSettings(db, storeId, 'takeout');
    const deliveryMode  = getModeSettings(db, storeId, 'delivery');
    const closedInfo    = isClosedDate(db, storeId, todayStr);

    settings.takeout_status = {
      enabled:        takeoutMode.enabled,
      cutoff_passed:  takeoutMode.enabled && isCutoffPassed(takeoutMode.cutoffTime, nowMins),
      allow_next_day: takeoutMode.allowNextDay,
      is_closed_day:  closedInfo.closed,
      earliest_today: takeoutMode.enabled && !closedInfo.closed
        ? getEarliestMins(takeoutMode, todayStr, nowMins)
        : null,
    };
    settings.delivery_status = {
      enabled:        deliveryMode.enabled,
      cutoff_passed:  deliveryMode.enabled && isCutoffPassed(deliveryMode.cutoffTime, nowMins),
      allow_next_day: deliveryMode.allowNextDay,
      is_closed_day:  closedInfo.closed,
      earliest_today: deliveryMode.enabled && !closedInfo.closed
        ? getEarliestMins(deliveryMode, todayStr, nowMins)
        : null,
    };

    // 找下一個可訂日（最多往後查 14 天）
    // bizHours 為空物件時視為全天可訂（不限制）
    function nextAvailableDates(modeSettings, count=3) {
      const dates = [];
      const d = new Date(now);
      d.setDate(d.getDate() + 1); // 從明天開始
      const bizEmpty = !modeSettings.bizHours || Object.keys(modeSettings.bizHours).length === 0;
      for (let i=0; i<14 && dates.length<count; i++) {
        const ds = twDateStr(d);
        const cInfo = isClosedDate(db, storeId, ds);
        if (!cInfo.closed) {
          if (bizEmpty) {
            // bizHours 未設定：所有非店休日都可訂
            dates.push(ds);
          } else {
            const wk = WD_KEYS[d.getDay()];
            const dh = modeSettings.bizHours[wk];
            if (dh && dh.enabled) dates.push(ds);
          }
        }
        d.setDate(d.getDate() + 1);
      }
      return dates;
    }
    settings.takeout_next_dates  = nextAvailableDates(takeoutMode, 3);
    settings.delivery_next_dates = nextAvailableDates(deliveryMode, 3);
    settings.today_closed_info   = closedInfo;
    settings.today = todayStr;
    settings.now_mins = nowMins;

    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /menu ──────────────────────────────────────────────
router.get('/menu', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();

    // 模式截止狀態（外帶/外送獨立）
    const takeoutMode  = getModeSettings(db, storeId, 'takeout');
    const deliveryMode = getModeSettings(db, storeId, 'delivery');
    const toCutoff = isCutoffPassed(takeoutMode.cutoffTime, nowMins);
    const dlCutoff = isCutoffPassed(deliveryMode.cutoffTime, nowMins);

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

      // ── LINE 專屬可售份數（優先判斷）──────────────────────
      const quota = getLineQuotaStatus(p);

      // ── 食材/庫存 ──────────────────────────────────────
      // BUG-002 修正：LINE 份數啟用且有剩餘時，食材庫存不阻擋 LINE 販售
      // ingredientOk 僅在 LINE 份數未啟用時才影響前台顯示
      const formulas = db.all(
        'SELECT f.*,i.refrigerated_stock,i.unit as ing_unit FROM product_ingredient_formulas f LEFT JOIN ingredients i ON i.id=f.ingredient_id AND i.store_id=? WHERE f.product_id=?',
        [storeId, p.id]
      );
      let ingredientOk = true, availableUnits = null, availableGrams = null;
      const hasFormula = formulas.length > 0;
      if (hasFormula) {
        let minUnits = Infinity, bottleneckG = Infinity;
        formulas.forEach(f => {
          const { toGrams } = require('../utils/unitConvert');
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
      // LINE 份數啟用且有剩餘 → 忽略食材庫存限制（前台以 quota 狀態優先）
      const lineQuotaOverridesIngredient = quota.hasQuota && Number(quota.remaining) > 0;
      const effectiveIngredientOk = lineQuotaOverridesIngredient ? true : ingredientOk;

      // ══════════════════════════════════════════════════════
      // LINE 接單規則優先順序：
      //   第一位階：每週營業時間（日期/時段基礎）
      //   第二位階：今日最後接單時間（臨時提前結束今日接單）
      //   第三位階：商品販售時段（商品級行銷設定，只限今日）
      //   第四位階：LINE 可售份數（今日額度）
      //
      // 重要原則：位階 2/3/4 都只限制「今日下單」
      // 只要允許明日預購，任何今日限制都不阻擋未來預約
      // ══════════════════════════════════════════════════════

      const nowHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

      // ── 第三位階：商品自身販售時段（只影響今日）──────────
      let productTimeReason = null; // 'not_started' | 'time_ended'（均僅限今日）
      if (p.line_sell_end && nowHHMM >= p.line_sell_end) {
        productTimeReason = 'time_ended';   // 今日販售已結束，不影響明日
      } else if (p.line_sell_start && nowHHMM < p.line_sell_start) {
        productTimeReason = 'not_started';  // 今日尚未開賣，不影響明日
      }

      // ── 第四位階：LINE 可售份數（只影響今日額度）─────────
      const realSoldOut = quota.hasQuota && quota.remaining <= 0;

      // ── 外帶/外送各自的今日售完原因（僅描述今日狀態）─────
      // 優先順序：模式關閉 > 第二位階截止 > 第三位階商品時段 > 第四位階份數
      const takeoutSoldOutReason = !takeoutMode.enabled ? 'mode_closed'
        : (toCutoff ? 'cutoff_sold_out'
          : (productTimeReason === 'time_ended'   ? 'product_time_ended'
            : (productTimeReason === 'not_started' ? 'product_not_started'
              : (realSoldOut ? 'real_sold_out' : null))));

      const deliverySoldOutReason = !deliveryMode.enabled ? 'mode_closed'
        : (dlCutoff ? 'cutoff_sold_out'
          : (productTimeReason === 'time_ended'   ? 'product_time_ended'
            : (productTimeReason === 'not_started' ? 'product_not_started'
              : (realSoldOut ? 'real_sold_out' : null))));

      // ── 可預約明日旗標 ────────────────────────────────────
      // 條件：今日有售完原因（非模式關閉） + 該模式允許次日預購
      // 今日位階 2/3/4 的限制都不阻擋明日預約
      const takeoutCanNextDay  = !!takeoutSoldOutReason  && takeoutSoldOutReason  !== 'mode_closed' && takeoutMode.allowNextDay;
      const deliveryCanNextDay = !!deliverySoldOutReason && deliverySoldOutReason !== 'mode_closed' && deliveryMode.allowNextDay;

      const isOrderable = !p.line_sold_out && saleStatus === 'available' && effectiveIngredientOk && !realSoldOut;

      return {
        ...p,
        display_cat_id: p.displayCatId, display_cat_name: p.displayCatName,
        display_cat_icon: p.displayCatIcon, display_cat_sort: p.displayCatSort,
        effective_price: basePrice, effective_line_price: linePrice, effective_line_name: lineName,
        sale_status: saleStatus,
        ingredient_available: effectiveIngredientOk, is_orderable: isOrderable,
        available_units: availableUnits, available_grams: availableGrams,
        has_formula: hasFormula, low_stock_alert: Number(p.low_stock_alert||5),
        is_hot: hotNames.has(p.name),
        line_description: p.line_description||'', line_image_url: p.line_image_url||'',
        line_hot: Number(p.line_hot)||0, line_promo: Number(p.line_promo)||0,
        // LINE 可售份數
        line_quota: quota,
        takeout_sold_out_reason:  takeoutSoldOutReason,
        delivery_sold_out_reason: deliverySoldOutReason,
        takeout_can_next_day:  takeoutCanNextDay,
        delivery_can_next_day: deliveryCanNextDay,
      };
    });

    res.json({ success: true, data: { categories: lineCategories, products: enriched } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /timeslots — 取得可選時段 API ────────────────────
// ?mode=takeout|delivery&date=YYYY-MM-DD
router.get('/timeslots', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const mode = req.query.mode === 'delivery' ? 'delivery' : 'takeout';
    const dateStr = req.query.date || twDateStr();
    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const todayStr = twDateStr(now);

    const modeSettings = getModeSettings(db, storeId, mode);
    if (!modeSettings.enabled) return res.json({ success: true, slots: [], reason: 'mode_closed' });

    const closedInfo = isClosedDate(db, storeId, dateStr);
    if (closedInfo.closed) return res.json({ success: true, slots: [], reason: 'closed_day' });

    // 截止判斷（今日才判斷 cutoff）
    if (dateStr === todayStr && isCutoffPassed(modeSettings.cutoffTime, nowMins)) {
      return res.json({ success: true, slots: [], reason: 'cutoff_passed' });
    }

    const earliestMins = getEarliestMins(modeSettings, dateStr, nowMins);
    if (earliestMins === null) return res.json({ success: true, slots: [], reason: 'no_slots_today' });

    const wdKey = WD_KEYS[new Date(dateStr + 'T00:00:00+08:00').getDay()];
    const dh = modeSettings.bizHours[wdKey];
    // fallback：若無 bizHours 設定，使用預設 09:00~21:00
    const closeMins = dh ? timeToMins(dh.close || '21:00') : timeToMins('21:00');
    const openMins  = dh ? timeToMins(dh.open  || '09:00') : timeToMins('09:00');

    const slots = [];
    for (let t = earliestMins; t < closeMins; t += 30) {
      slots.push(minsToTime(t));
    }
    res.json({ success: true, slots, earliest: minsToTime(earliestMins), mode, date: dateStr });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /validate-cart — 加入購物車時驗證 ────────────────
// ?mode=takeout|delivery&product_ids=1,2,3
router.get('/validate-cart', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const mode = req.query.mode === 'delivery' ? 'delivery' : 'takeout';
    const productIds = String(req.query.product_ids||'').split(',').map(Number).filter(Boolean);
    const now = twNow();
    const todayStr = twDateStr(now);
    const nowMins = now.getHours()*60 + now.getMinutes();

    const checks = validateOrderConditions(db, storeId, mode, todayStr, null, nowMins);
    const productResults = productIds.map(pid => {
      const p = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
      if (!p) return { product_id: pid, ok: false, reason: 'not_found' };
      const quota = getLineQuotaStatus(p);
      if (quota.hasQuota && quota.remaining <= 0)
        return { product_id: pid, ok: false, reason: 'real_sold_out', name: p.name };
      return { product_id: pid, ok: true, name: p.name };
    });

    res.json({ success: true, mode_ok: checks.ok, mode_reason: checks.reason, products: productResults });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 結帳前驗證邏輯（共用）────────────────────────────────
function validateOrderConditions(db, storeId, mode, dateStr, pickupTime, nowMins) {
  const now = twNow();
  if (nowMins === undefined) nowMins = now.getHours()*60 + now.getMinutes();
  const todayStr = twDateStr(now);

  // 1. 全域 LINE 點餐開關
  if (getSetting(db, storeId, 'line_ordering_enabled', '1') !== '1')
    return { ok: false, reason: 'line_disabled', message: 'LINE 點餐目前暫停營業' };

  // 2. 店休日判斷
  const orderDate = dateStr || todayStr;
  const closedInfo = isClosedDate(db, storeId, orderDate);
  if (closedInfo.closed)
    return { ok: false, reason: 'closed_day', message: `${orderDate} 為店休日，請選擇其他日期` };

  // 3. 今日臨時休息
  const todayClosed = getSetting(db, storeId, 'line_today_closed', '0');
  const closedDate  = getSetting(db, storeId, 'line_today_closed_date', '');
  if (todayClosed === '1' && closedDate === todayStr && orderDate === todayStr)
    return { ok: false, reason: 'today_closed', message: '今日 LINE 點餐休息' };

  // 4. 模式開關（外帶/外送獨立）
  const modeSettings = getModeSettings(db, storeId, mode);
  if (!modeSettings.enabled)
    return { ok: false, reason: 'mode_closed', message: `目前${mode==='takeout'?'外帶':'外送'}服務已關閉` };

  // 5. 今日截止時間（只針對今天的訂單，明日以後不受此限制）
  if (orderDate === todayStr && isCutoffPassed(modeSettings.cutoffTime, nowMins)) {
    return { ok: false, reason: 'cutoff_sold_out',
      message: `${mode==='takeout'?'外帶':'外送'}已超過今日最後接單時間（${modeSettings.cutoffTime}）` };
  }

  // 6. 取餐時間有效性
  if (pickupTime && pickupTime !== '盡快' && orderDate === todayStr) {
    const [ph, pm] = pickupTime.split(':').map(Number);
    const pTotal = ph * 60 + pm;
    if (pTotal < nowMins + modeSettings.prepMins)
      return { ok: false, reason: 'time_too_early',
        message: `此時段距離現在太近，最短備餐時間 ${modeSettings.prepMins} 分鐘` };
  }

  return { ok: true };
}

// ── POST /（新 LINE 訂單）──────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const {
      customer_name, customer_phone, customer_line_id,
      order_type, pickup_time, pickup_date, delivery_address,
      note, payment_method, items, subtotal, discount_amount, total
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: '購物車不能為空' });
    if (!customer_name || !customer_phone)
      return res.status(400).json({ success: false, message: '請填寫姓名與電話' });

    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const todayStr = twDateStr(now);
    const orderDate = pickup_date || todayStr;
    // ── BUG-001 修正：isPreorderOrder 必須在商品驗證迴圈之前宣告 ──
    const isPreorderOrder = orderDate > todayStr;

    // ── 結帳前雙重驗證 ─────────────────────────────────
    const mode = order_type === 'delivery' ? 'delivery' : 'takeout';
    const validation = validateOrderConditions(db, storeId, mode, orderDate, pickup_time, nowMins);
    if (!validation.ok)
      return res.status(403).json({ success: false, message: validation.message, reason: validation.reason });

    // ── 商品驗證（含 LINE 份數）──────────────────────────
    for (const item of items) {
      const pid  = item.product_id || item.id;
      const prod = pid ? db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]) : null;
      if (!prod || !prod.enabled || !prod.show_on_line)
        return res.status(400).json({ success: false, message: `商品「${item.name}」已下架` });
      if (prod.sale_status === 'sold_out_today')
        return res.status(400).json({ success: false, message: `「${prod.name}」今日完售` });
      if (prod.sale_status !== 'available')
        return res.status(400).json({ success: false, message: `「${prod.name}」目前無法購買` });

      // LINE 專屬份數驗證（重要：不動主庫存）
      // 預購訂單不受今日份數限制（今日份數只管今天）
      const quota = getLineQuotaStatus(prod);
      if (quota.hasQuota && !isPreorderOrder) {
        if (quota.remaining <= 0)
          return res.status(400).json({
            success: false, message: `「${prod.name}」LINE 今日份數已售完`,
            reason: 'real_sold_out'
          });
        if (quota.remaining < Number(item.qty||1))
          return res.status(400).json({
            success: false, message: `「${prod.name}」LINE 剩餘份數不足（剩 ${quota.remaining} 份）`,
            reason: 'quota_insufficient'
          });
      }

      // LINE 可販售時段（只限今日訂單，預購訂單不受此限制）
      // 原則：商品販售時段是「今日」的行銷設定，不阻擋未來預約
      if ((prod.line_sell_start || prod.line_sell_end) && !isPreorderOrder) {
        const nowHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if (prod.line_sell_start && nowHHMM < prod.line_sell_start)
          return res.status(400).json({ success: false, message: `「${prod.name}」尚未開始販售（${prod.line_sell_start} 開賣）` });
        if (prod.line_sell_end && nowHHMM >= prod.line_sell_end)
          return res.status(400).json({ success: false, message: `「${prod.name}」今日販售時段已結束` });
      }

      // 食材庫存驗證
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

    // ── 付款方式驗證 ──────────────────────────────────
    const PAYMENT_SETTINGS = {
      cash:'line_payment_cash_enabled', linepay:'line_payment_linepay_enabled',
      transfer:'line_payment_transfer_enabled', platform:'line_payment_platform_enabled',
      credit_card:'line_payment_credit_card_enabled',
    };
    const payKey = PAYMENT_SETTINGS[payment_method];
    if (!payKey || getSetting(db, storeId, payKey, '0') !== '1')
      return res.status(400).json({ success: false, message: `付款方式「${payment_method}」目前未開放` });
    const payment_category = payment_method === 'cash' ? 'cash' : 'non_cash';

    // ── 建立訂單 ──────────────────────────────────────
    const uuid = uuidv4(), orderNo = orderNumber();
    const pad = (n,l=2) => String(n).padStart(l,'0');
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const itemsJson = JSON.stringify(items);
    const finalTotal = Number(total)||Number(subtotal)||0;
    const discAmt    = Number(discount_amount)||0;
    const sub        = Number(subtotal)||0;
    const orderMode  = order_type === 'delivery' ? 'delivery' : 'takeout';
    // 預購訂單：將日期合入 pickup_time，格式 "YYYY-MM-DD HH:MM"，方便後台辨識
    let pickupTimeVal = (pickup_time && pickup_time.trim()) ? pickup_time.trim() : '';
    if (isPreorderOrder && pickupTimeVal && !pickupTimeVal.includes('-')) {
      // 預購且只有時間（HH:MM），補上日期
      pickupTimeVal = `${orderDate} ${pickupTimeVal}`;
    }

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
        note||'', 'synced', 'LINE', 'line', nowStr, nowStr
      ]
    );

    // ── 扣 LINE 專屬份數（不動主庫存）───────────────
    // 重要：只有今日訂單才扣今日份數；明日預約訂單不扣今日份數
    const orderDateStr = pickup_date || todayStr;
    const isNextDayOrder = orderDateStr > todayStr;
    if (!isNextDayOrder) {
      items.forEach(item => {
        const pid = item.product_id || item.id;
        if (!pid) return;
        const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
        if (!prod || !Number(prod.line_quota_enabled)) return;
        db.run(
          `UPDATE products SET line_quota_sold = line_quota_sold + ?, updated_at=datetime('now','localtime')
           WHERE id=? AND store_id=?`,
          [Number(item.qty||1), pid, storeId]
        );
      });
    }

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
    const now2 = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET status=?, order_status=?, kitchen_status=?, updated_at=? WHERE order_number=? AND store_id=?`,
      [newStatus, newStatus, newStatus, now2, orderNo, storeId]
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

    const now3 = twNow();
    const todayStr2 = twDateStr(now3);
    const threeDaysAgo = (() => { const d=new Date(now3); d.setDate(d.getDate()-3); return twDateStr(d); })();
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
        [storeId, last3, todayStr2]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無今日訂單，請確認電話後三碼或詢問店員' });
      return res.json({ success: true, mode: 'list', orders: orders.map(safeOrder) });
    }
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/history', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rawPhone = String(req.body.phone||'').trim();
    const rawName  = String(req.body.customer_name||'').trim();
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話' });
    const now4 = twNow();
    const threeDaysAgo2 = (() => { const d=new Date(now4); d.setDate(d.getDate()-3); return twDateStr(d); })();
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
      [storeId, last3, `%${rawName}%`, threeDaysAgo2]
    );
    if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天訂單，請確認資料或詢問店員' });
    return res.json({ success: true, orders: orders.map(safeOrder) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PUT /quota-reset — 每日重置 LINE 已售份數（排程用）──
// POST /api/line-orders/quota-reset
router.post('/quota-reset', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    db.run(
      `UPDATE products SET line_quota_sold=0, updated_at=datetime('now','localtime')
       WHERE store_id=? AND line_quota_enabled=1`,
      [storeId]
    );
    res.json({ success: true, message: 'LINE 今日已售份數已重置' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
