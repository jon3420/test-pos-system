// utils/inventoryHelper.js — SaaS R1 fix2（storeId 完整隔離版）
'use strict';

const { toGrams, fromGrams } = require('./unitConvert');

/**
 * 取得單一商品的統一庫存狀態
 * @param {object} db
 * @param {number} pid
 * @param {string} storeId  必填，防跨店
 */
function getProductInventoryStatus(db, pid, storeId) {
  const sid = storeId || 'store_001';
  const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, sid]);
  if (!prod) return null;

  // ★ fix2：JOIN ingredients 時也加 AND i.store_id=? 防同 id 混到別店食材
  const formulas = db.all(
    `SELECT f.*, i.refrigerated_stock, i.unit as ing_unit
     FROM product_ingredient_formulas f
     LEFT JOIN ingredients i ON i.id = f.ingredient_id AND i.store_id = ?
     WHERE f.product_id = ?`,
    [sid, pid]
  );

  let availableGrams = 0, availableUnits = 0;
  let isFormulaControlled = false;

  if (formulas.length > 0) {
    isFormulaControlled = true;
    let minUnits = Infinity, bottleneckG = Infinity;
    formulas.forEach(f => {
      // 若食材不屬於本店（i.* 為 NULL），視為庫存為 0
      const refrigG  = f.ing_unit ? toGrams(Number(f.refrigerated_stock || 0), f.ing_unit) : 0;
      const perUnitG = Number(f.amount_per_unit || 0);
      const units    = perUnitG > 0 ? Math.floor(refrigG / perUnitG) : 0;
      if (units < minUnits) { minUnits = units; bottleneckG = refrigG; }
    });
    availableUnits = minUnits === Infinity ? 0 : minUnits;
    availableGrams = bottleneckG === Infinity ? 0 : bottleneckG;
  } else if (prod.inventory_enabled) {
    // inventory_enabled=1 但 allocated_grams 未設定或為 0 時：
    // 視為「已啟用但尚未設定克數」→ available_units=0（阻止點餐），不回傳 null
    if (Number(prod.allocated_grams) > 0) {
      const stockG   = Number(prod.current_stock_grams || 0);
      const perUnitG = Number(prod.allocated_grams);
      availableGrams = stockG;
      availableUnits = Math.floor(stockG / perUnitG);
    } else {
      // 尚未設定每份克數：阻止點餐直到設定完成
      availableGrams = 0;
      availableUnits = 0;
    }
  } else {
    return {
      product_id: prod.id, product_name: prod.name,
      is_formula_controlled: false,
      available_grams: null, available_units: null,
      low_stock_alert: Number(prod.low_stock_alert || 5),
      is_low_stock: false, is_out_of_stock: false,
      status: 'ok',
    };
  }

  const lowAlert = Number(prod.low_stock_alert || 5);
  const isOut    = availableUnits <= 0;
  const isLow    = !isOut && availableUnits <= lowAlert;
  const status   = isOut ? 'out' : isLow ? 'low' : 'ok';

  return {
    product_id:            prod.id,
    product_name:          prod.name,
    is_formula_controlled: isFormulaControlled,
    available_grams:       availableGrams,
    available_units:       availableUnits,
    low_stock_alert:       lowAlert,
    is_low_stock:          isLow,
    is_out_of_stock:       isOut,
    status,
  };
}

/**
 * 批次取得多個商品的庫存狀態
 */
function getProductInventoryStatusBatch(db, productIds, storeId) {
  const result = {};
  productIds.forEach(pid => {
    const s = getProductInventoryStatus(db, pid, storeId);
    if (s) result[pid] = s;
  });
  return result;
}

/**
 * 取得某店所有啟用庫存管理的商品庫存狀態
 * @param {object} db
 * @param {string} storeId  必填
 */
function getAllInventoryStatuses(db, storeId) {
  const sid = storeId || 'store_001';
  const products = db.all(`
    SELECT DISTINCT p.* FROM products p
    WHERE p.store_id = ?
      AND (
        p.inventory_enabled = 1
        OR EXISTS (
          SELECT 1 FROM product_ingredient_formulas f
          INNER JOIN ingredients i ON i.id = f.ingredient_id AND i.store_id = ?
          WHERE f.product_id = p.id
        )
      )
    ORDER BY p.sort_order ASC, p.id ASC
  `, [sid, sid]);
  return products.map(p => getProductInventoryStatus(db, p.id, sid)).filter(Boolean);
}

module.exports = { getProductInventoryStatus, getProductInventoryStatusBatch, getAllInventoryStatuses };
