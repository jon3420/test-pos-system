// utils/lineProductPricing.js — H1.4.12 Phase 3A.2
//
// LINE 通路商品「顯示名稱／價格／是否可購買」的單一事實來源。
//
// 這份邏輯的權威來源是 routes/line-orders.js 的 GET /menu（一般 LINE 點餐
// 商品列表，長期production驗證過的既有行為）——本檔案不是另外發明一套規則，
// 是把 GET /menu 原本內嵌在那支路由裡的價格/名稱判斷抽出來，讓 GET /menu
// 本身、popup 公開商品顯示（utils/popupCheckout.js）、popup 結帳商品驗證
// 三處都呼叫同一個函式，避免三份程式碼各自複製、之後改一處忘記改另一處。
'use strict';

function resolveLineProductPricing(p) {
  if (!p) return null;
  // 外帶價格優先序：line_price > takeaway_price > price（跟 GET /menu 完全
  // 一致）。用 `> 0` 而非 `||` 判斷是否要 fallback——這是既有 GET /menu 本來
  // 就有的行為（沿用，不是本次新發明），代表「明確設為 0」目前仍會被視為
  // 「沒有設定」而 fallback 到下一順位，這是既有既定行為，不在本次修改
  // 範圍內調整。
  const basePrice = Number(p.takeaway_price) > 0 ? Number(p.takeaway_price) : (Number(p.price) || 0);
  const effectivePrice = Number(p.line_price) > 0 ? Number(p.line_price) : basePrice;
  // 顯示名稱：line_name 去除頭尾空白後非空字串才採用，否則一律用 name
  // （null、undefined、空字串、純空白都視為「沒有設定」）。
  const effectiveName = (p.line_name || '').trim() || p.name;
  const saleStatus = p.sale_status || 'available';
  const showOnLine = p.show_on_line != null ? Number(p.show_on_line) : 1;
  const lineSoldOut = Number(p.line_sold_out) || 0;
  const lineTakeoutEnabled = p.line_takeout_enabled == null ? 1 : Number(p.line_takeout_enabled);
  const isLineTakeoutOrderable = Number(p.enabled) === 1
    && showOnLine === 1
    && saleStatus === 'available'
    && lineSoldOut === 0
    && lineTakeoutEnabled === 1;
  return {
    product_id: Number(p.id),
    name: effectiveName,
    price: effectivePrice,
    sale_status: saleStatus,
    show_on_line: showOnLine,
    line_sold_out: lineSoldOut,
    line_takeout_enabled: lineTakeoutEnabled,
    is_line_takeout_orderable: isLineTakeoutOrderable,
  };
}

module.exports = { resolveLineProductPricing };
