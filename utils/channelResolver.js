// utils/channelResolver.js — fix18-10-hotfix24-A3｜Order Channel × Page Type Resolver
//
// 目的（需求文件六／七／八）：全系統只有「這一個」判斷「這筆事件／這張訂單屬於
// 哪個點餐渠道」「這個事件發生在哪種頁面」的地方，不在每個 route 各寫一套 switch。
//
// 沿用既有欄位，不重複造欄位（需求文件六）：
//   orders.order_mode        : 'dine_in' | 'takeout' | 'delivery' | 'shipping'
//   orders.source             : 'pos'（預設） | 'line'
//   orders.fulfillment_type   : ''  | 'shipping'（LINE 冷藏宅配中心 V1 既有欄位）
//   orders.order_source       : ''  | 'line_shipping'（同上）
// 這個模組只是把上面既有欄位「正規化」成標準渠道值，不新增 orders 欄位。

'use strict';

// order_channel 標準值（需求文件六）
const ORDER_CHANNELS = ['pos', 'line_takeout', 'line_delivery', 'shipping', 'reservation', 'unknown'];

const ORDER_CHANNEL_LABELS = {
  pos: '店內 POS',
  line_takeout: 'LINE 外帶',
  line_delivery: 'LINE 外送',
  shipping: '冷藏宅配',
  reservation: '預訂',
  unknown: '未知',
};

// page_type 標準值（需求文件七）
const PAGE_TYPES = [
  'line_order_home', 'product_detail', 'cart', 'checkout', 'payment',
  'order_success', 'shipping_page', 'delivery_page', 'reservation_page', 'unknown',
];

function _norm(v) {
  return (v === undefined || v === null) ? '' : String(v).trim().toLowerCase();
}

/**
 * 正規化訂單／事件的點餐渠道。可同時用於：
 *   - orders 表資料列（有 source / fulfillment_type / order_source 可用）
 *   - analytics_events 寫入當下（通常只有 order_mode，來源固定是 LINE 點餐頁面，
 *     因為目前 POS 收銀端本身不送 analytics_events，見需求文件十一）
 * @param {object} input
 * @param {string} [input.order_mode]
 * @param {string} [input.fulfillment_type]
 * @param {string} [input.order_source]
 * @param {string} [input.source] 'pos' | 'line'（訂單建立來源；事件層級若無法取得可略過）
 * @returns {string} ORDER_CHANNELS 其中之一
 */
function resolveOrderChannel(input) {
  input = input || {};
  const orderMode = _norm(input.order_mode);
  const fulfillment = _norm(input.fulfillment_type);
  const orderSource = _norm(input.order_source);
  const src = _norm(input.source);

  // 冷藏宅配：三個既有欄位任一命中都算宅配（需求文件六／LINE_ORDER_CENTER 既有慣例）
  if (fulfillment === 'shipping' || orderSource === 'line_shipping' || orderMode === 'shipping') {
    return 'shipping';
  }
  // 預訂／預購：目前專案沒有獨立欄位，保留標準值供未來擴充（例如 line_preorder_* 相關流程
  // 未來要獨立出來時可在這裡加一行判斷，不必更動呼叫端）。
  if (orderMode === 'reservation' || fulfillment === 'reservation' || orderSource === 'reservation') {
    return 'reservation';
  }
  // 內用：一定是店內 POS 現場點的
  if (orderMode === 'dine_in') return 'pos';
  // 外帶／外送：用 source 判斷是 LINE 點餐頁面下單，還是店員在 POS 現場代客輸入
  if (orderMode === 'takeout' || orderMode === 'delivery') {
    if (src === 'pos') return 'pos';
    return orderMode === 'delivery' ? 'line_delivery' : 'line_takeout';
  }
  // order_mode 缺漏（例如舊資料／事件層級沒有帶 order_mode）時，退而求其次看 source
  if (src === 'pos') return 'pos';
  if (src === 'line') return 'line_takeout';
  return 'unknown';
}

// 與 resolveOrderChannel() 邏輯一致的 SQL CASE 運算式，供 orders 表查詢直接篩選／分組使用
// （需求文件十一：後端支援 ?channel= 篩選）。兩邊邏輯務必保持同步：修改其中一個
// 判斷規則時，另一個也要跟著改。
const ORDER_CHANNEL_SQL_EXPR = `
  CASE
    WHEN COALESCE(fulfillment_type,'')='shipping' OR COALESCE(order_source,'')='line_shipping' OR COALESCE(order_mode,'')='shipping' THEN 'shipping'
    WHEN COALESCE(order_mode,'')='dine_in' THEN 'pos'
    WHEN COALESCE(order_mode,'') IN ('takeout','delivery') THEN
      CASE WHEN COALESCE(source,'pos')='pos' THEN 'pos'
           WHEN COALESCE(order_mode,'')='delivery' THEN 'line_delivery'
           ELSE 'line_takeout' END
    WHEN COALESCE(source,'')='pos' THEN 'pos'
    WHEN COALESCE(source,'')='line' THEN 'line_takeout'
    ELSE 'unknown'
  END
`.trim();

/**
 * 正規化事件所在的頁面類型（需求文件七／八）。
 * 優先採用呼叫端明確傳入的 page_name（若已是標準值）；否則依 event_name +
 * order_mode（渠道情境：宅配頁 vs 一般外帶外送頁）＋ page_url 推斷。
 * @param {object} input
 * @param {string} [input.page_name]  已知標準值時直接採用
 * @param {string} [input.event_name]
 * @param {string} [input.order_mode]
 * @param {string} [input.page_url]
 * @returns {string} PAGE_TYPES 其中之一
 */
function resolvePageType(input) {
  input = input || {};
  const pageName = _norm(input.page_name);
  if (pageName && PAGE_TYPES.includes(pageName)) return pageName;

  const evt = _norm(input.event_name);
  const orderMode = _norm(input.order_mode);
  const url = _norm(input.page_url);
  const isShippingCtx = orderMode === 'shipping' || url.includes('line-shipping');
  const isDeliveryCtx = orderMode === 'delivery';

  switch (evt) {
    case 'page_view':
    case 'line_gate_view':
    case 'line_login_start':
    case 'friend_prompt_shown':
    case 'friend_gate_passed':
    case 'line_gate_skipped':
      if (isShippingCtx) return 'shipping_page';
      if (isDeliveryCtx) return 'delivery_page';
      return 'line_order_home';
    case 'view_product':
      return 'product_detail';
    case 'add_to_cart':
    case 'remove_from_cart':
      return 'cart';
    case 'begin_checkout':
      return 'checkout';
    case 'payment_started':
      return 'payment';
    case 'purchase':
    case 'submit_order':
    case 'member_first_purchase':
    case 'member_repeat_purchase':
      return 'order_success';
    default:
      if (isShippingCtx) return 'shipping_page';
      if (isDeliveryCtx) return 'delivery_page';
      return 'unknown';
  }
}

module.exports = {
  ORDER_CHANNELS,
  ORDER_CHANNEL_LABELS,
  PAGE_TYPES,
  resolveOrderChannel,
  ORDER_CHANNEL_SQL_EXPR,
  resolvePageType,
};
