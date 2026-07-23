// utils/deliveryFeeSuggestedRules.js — C3：建議距離級距＋滿額免運預設值
// 用途：
//   1. utils/db.js 新店/尚未設定過規則的店家 seed 預設值（只在 key 完全不存在時才寫入，
//      不會覆蓋任何已設定過規則的既有店家）。
//   2. 後台「套用建議級距」按鈕（public/js/app.js）的來源資料——前端沒有 require()，
//      因此那邊會維持一份「內容相同」的 JS 常數；若要調整建議值，兩處都要同步修改。
'use strict';

module.exports = [
  { max_km: 3,  fee: 50,  free_threshold: 300,  free_mode: 'full',  free_discount: 0 },
  { max_km: 5,  fee: 80,  free_threshold: 500,  free_mode: 'full',  free_discount: 0 },
  { max_km: 7,  fee: 120, free_threshold: 800,  free_mode: 'full',  free_discount: 0 },
  { max_km: 9,  fee: 150, free_threshold: 1000, free_mode: 'fixed', free_discount: 100 },
  { max_km: 11, fee: 180, free_threshold: 1200, free_mode: 'fixed', free_discount: 100 },
  { max_km: 13, fee: 210, free_threshold: 1500, free_mode: 'fixed', free_discount: 100 },
  { max_km: 15, fee: 240, free_threshold: 1800, free_mode: 'fixed', free_discount: 100 },
];
