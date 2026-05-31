// utils/unitConvert.js — 食材單位換算工具（前後端共用邏輯）
// 1斤 = 600g, 1kg = 1000g, 1g = 1g

'use strict';

const UNIT_TO_G = { '斤': 600, 'kg': 1000, 'g': 1, 'G': 1, 'KG': 1000 };

/**
 * 將任意食材單位的數量轉換為公克 (g)
 * @param {number} amount 數量
 * @param {string} unit   單位 ('斤' | 'kg' | 'g')
 * @returns {number} 公克數
 */
function toGrams(amount, unit) {
  const factor = UNIT_TO_G[unit] || 1;
  return Number(amount) * factor;
}

/**
 * 將公克數轉換回指定單位
 * @param {number} grams 公克數
 * @param {string} unit  目標單位
 * @returns {number}
 */
function fromGrams(grams, unit) {
  const factor = UNIT_TO_G[unit] || 1;
  return Number(grams) / factor;
}

module.exports = { toGrams, fromGrams };
