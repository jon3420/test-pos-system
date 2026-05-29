// utils/inventoryHelper.js — 統一庫存計算工具
// 所有庫存來源必須透過此模組，避免各地各自計算
'use strict';

const { toGrams, fromGrams } = require('./unitConvert');

/**
 * 取得單一商品的統一庫存狀態
 * @param {object} db   - getDb() 回傳的資料庫物件
 * @param {number} pid  - product id
 * @returns {{
 *   product_id, product_name,
 *   is_formula_controlled,
 *   available_grams, available_units,
 *   low_stock_alert, is_low_stock, is_out_of_stock,
 *   status: 'ok'|'low'|'out'
 * }|null}
 */
function getProductInventoryStatus(db, pid) {
  const prod = db.get('SELECT * FROM products WHERE id=?', [pid]);
  if (!prod) return null;

  const formulas = db.all(
    'SELECT f.*,i.refrigerated_stock,i.unit as ing_unit FROM product_ingredient_formulas f ' +
    'LEFT JOIN ingredients i ON i.id=f.ingredient_id WHERE f.product_id=?',
    [pid]
  );

  let availableGrams = 0;
  let availableUnits = 0;
  let isFormulaControlled = false;

  if (formulas.length > 0) {
    // 食材控管：找瓶頸食材（最少可售份數）
    isFormulaControlled = true;
    let minUnits = Infinity;
    let bottleneckG = Infinity;
    formulas.forEach(f => {
      const refrigG  = toGrams(Number(f.refrigerated_stock || 0), f.ing_unit || 'g');
      const perUnitG = Number(f.amount_per_unit || 0);
      const units    = perUnitG > 0 ? Math.floor(refrigG / perUnitG) : 0;
      if (units < minUnits) {
        minUnits    = units;
        bottleneckG = refrigG;
      }
    });
    availableUnits = minUnits === Infinity ? 0 : minUnits;
    availableGrams = bottleneckG === Infinity ? 0 : bottleneckG;
  } else if (prod.inventory_enabled && Number(prod.allocated_grams) > 0) {
    // 商品自身庫存
    const stockG   = Number(prod.current_stock_grams || 0);
    const perUnitG = Number(prod.allocated_grams);
    availableGrams = stockG;
    availableUnits = Math.floor(stockG / perUnitG);
  } else {
    // 無庫存管理
    return {
      product_id: prod.id, product_name: prod.name,
      is_formula_controlled: false,
      available_grams: null, available_units: null,
      low_stock_alert: Number(prod.low_stock_alert || 5),
      is_low_stock: false, is_out_of_stock: false,
      status: 'ok',
    };
  }

  const lowAlert   = Number(prod.low_stock_alert || 5);
  const isOut      = availableUnits <= 0;
  const isLow      = !isOut && availableUnits <= lowAlert;
  const status     = isOut ? 'out' : isLow ? 'low' : 'ok';

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
 * @param {object} db
 * @param {number[]} productIds
 * @returns {Object.<number, ReturnType<getProductInventoryStatus>>}
 */
function getProductInventoryStatusBatch(db, productIds) {
  const result = {};
  productIds.forEach(pid => {
    const s = getProductInventoryStatus(db, pid);
    if (s) result[pid] = s;
  });
  return result;
}

/**
 * 取得所有啟用庫存管理的商品庫存狀態
 */
function getAllInventoryStatuses(db) {
  // 包含 inventory_enabled=1 或有扣料公式的商品
  const products = db.all(`
    SELECT DISTINCT p.* FROM products p
    WHERE p.inventory_enabled=1
       OR EXISTS (SELECT 1 FROM product_ingredient_formulas f WHERE f.product_id=p.id)
    ORDER BY p.sort_order ASC, p.id ASC
  `);
  return products.map(p => getProductInventoryStatus(db, p.id)).filter(Boolean);
}

module.exports = { getProductInventoryStatus, getProductInventoryStatusBatch, getAllInventoryStatuses };
