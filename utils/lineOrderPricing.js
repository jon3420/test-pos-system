'use strict';
// H1.4.12 Phase 3C R44.2D：LINE 訂單「server-authoritative」商品項目與金額建立器。
// 單價／名稱唯一來源：utils/lineProductPricing.js 的 resolveLineProductPricing()
// （line_price > takeaway_price > price，name = line_name.trim() || name），
// 與 GET /menu、popup checkout 完全同一個函式，不另建價格公式。
// client 傳入的 name／price／subtotal／total／discount／fee 一律不被信任、不被持久化。
const { resolveLineProductPricing } = require('./lineProductPricing');

const SAFE_EXTRA_KEYS = ['spec', 'note', 'options']; // 只保留描述性欄位（長度受限），不含任何金額／名稱欄位

function fail(status, message, reason) {
  const e = new Error('order pricing: ' + reason);
  e.httpStatus = status;
  e.publicBody = { success: false, message, reason };
  return e;
}

// rawItems：client 傳入的 items；讀 DB 一律 store-scoped。回傳 { items, subtotal }；失敗 throw tagged error。
function buildCanonicalItems(db, storeId, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw fail(400, '購物車不能為空', 'empty_items');
  if (rawItems.length > 200) throw fail(400, '購物車商品筆數過多', 'too_many_items');
  const items = [];
  let subtotal = 0;
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, '購物車格式錯誤', 'invalid_item');
    const pid = Number(raw.product_id != null ? raw.product_id : raw.id);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw fail(400, '購物車商品格式錯誤', 'invalid_product_id');
    const qty = raw.qty == null ? 1 : raw.qty;
    if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty <= 0) throw fail(400, '商品數量格式錯誤', 'invalid_qty');
    const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    const pr = resolveLineProductPricing(prod);
    if (!pr) throw fail(400, '購物車中有商品已下架', 'product_not_available');
    if (!Number.isFinite(pr.price) || pr.price < 0) throw fail(500, '系統忙碌中，請稍後再試', 'invalid_server_price');
    const lineTotal = pr.price * qty;
    if (!Number.isFinite(lineTotal) || !Number.isSafeInteger(Math.round(lineTotal))) throw fail(400, '訂單金額超出範圍', 'amount_overflow');
    subtotal += lineTotal;
    if (!Number.isFinite(subtotal) || !Number.isSafeInteger(Math.round(subtotal))) throw fail(400, '訂單金額超出範圍', 'amount_overflow');
    const item = { product_id: pid, name: pr.name, price: pr.price, qty };
    for (const k of SAFE_EXTRA_KEYS) {
      if (raw[k] != null) {
        try { if (JSON.stringify(raw[k]).length <= 500) item[k] = raw[k]; } catch { /* 略過無法序列化的欄位 */ }
      }
    }
    items.push(item);
  }
  return { items, subtotal };
}

module.exports = { buildCanonicalItems };
