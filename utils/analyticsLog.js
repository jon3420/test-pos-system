// utils/analyticsLog.js — fix18-10-hotfix23-A Analytics Foundation
//
// 共用的轉換事件寫入工具。供兩種呼叫端使用：
//   1. routes/analytics.js（前台一般事件，需經白名單 + 各項安全檢查）
//   2. 後端其他路由直接呼叫（submit_order / purchase 等「不可信任前端」的事件，
//      由後端在訂單真正成立 / 付款真正成功時寫入，繞過前台白名單限制，但呼叫端
//      必須是伺服器自己的程式碼，不可由前端直接觸發）
//
// 原則：
//   - 絕不拋出例外中斷呼叫端主要流程（下單、付款、一般事件）。
//   - 所有查詢一律以 store_id 隔離。
//   - metadata_json 大小限制，避免濫用塞入超大字串。

'use strict';

// 本期（Hotfix23-A）事件白名單，只有這 8 種可經由前台一般 API 寫入。
// purchase 不開放前台一般 API 直接寫入（見 routes/analytics.js）。
const EVENT_WHITELIST = [
  'page_view',
  'view_product',
  'add_to_cart',
  'remove_from_cart',
  'begin_checkout',
  'submit_order',
  'payment_started',
  'purchase',
  // fix18-10-hotfix23-E：LINE 會員入口 × LIFF 登入 × 好友狀態綁定
  // 純顯示/操作類事件，沒有安全疑慮，可由前端直接送出。
  'line_gate_view',
  'line_login_start',
  'friend_prompt_shown',
  'friend_gate_passed',
  'line_gate_skipped',
  // 下列事件的真實性只能由後端確認（登入成功與否、好友狀態查詢結果、
  // 好友加入/取消/恢復、CRM 購買事件），不得由前端直接寫入 —— 見
  // routes/analytics.js 的 SERVER_ONLY_EVENTS，這裡列在白名單只是讓
  // logServerEvent() 可以合法寫入，不代表前台 POST /events 允許使用。
  'line_login_success',
  'line_login_failed',
  'friend_status_checked',
  'friend_added',
  'friend_removed',
  'friend_restored',
  'member_login',
  'member_profile_updated',
  'member_first_cart',
  'member_first_purchase',
  'member_repeat_purchase',
  'member_source_updated',
];

const MAX_METADATA_BYTES = 4 * 1024; // 4KB

function isValidEventName(name) {
  return typeof name === 'string' && EVENT_WHITELIST.includes(name);
}

function clampInt(val, { min = null, max = null, fallback = null } = {}) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  let r = Math.trunc(n);
  if (min !== null && r < min) return fallback;
  if (max !== null && r > max) return fallback;
  return r;
}

function safeStr(val, maxLen = 500) {
  if (val === undefined || val === null) return '';
  const s = String(val);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// metadata 可以是物件或字串；一律正規化成 JSON 字串並限制大小，超過則丟棄（不報錯）
function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  let jsonStr;
  try {
    jsonStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  } catch (e) {
    return null;
  }
  if (Buffer.byteLength(jsonStr, 'utf8') > MAX_METADATA_BYTES) return null;
  return jsonStr;
}

// 內部寫入（不做白名單檢查，呼叫端需自行確保 event_name 合法）
// 回傳 true/false，絕不拋出例外。
function insertEvent(db, fields) {
  try {
    const {
      store_id, visitor_id, session_id, cart_id = null, order_id = null,
      event_name, product_id = null, quantity = 1, order_mode = null,
      source = null, medium = null, campaign = null, referrer = null,
      landing_page = null, fbclid = null, gclid = null, metadata = null,
    } = fields;

    if (!store_id || !visitor_id || !session_id || !event_name) return false;

    const qty = clampInt(quantity, { min: 1, max: 999, fallback: 1 });
    const pid = product_id === null || product_id === undefined || product_id === ''
      ? null
      : clampInt(product_id, { min: 1, max: 2147483647, fallback: null });

    db.run(
      `INSERT INTO analytics_events (
        store_id, visitor_id, session_id, cart_id, order_id,
        event_name, product_id, quantity, order_mode,
        source, medium, campaign, referrer, landing_page,
        fbclid, gclid, metadata_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        safeStr(store_id, 100), safeStr(visitor_id, 200), safeStr(session_id, 200),
        cart_id ? safeStr(cart_id, 200) : null, order_id ? safeStr(order_id, 200) : null,
        event_name, pid, qty, order_mode ? safeStr(order_mode, 50) : null,
        source ? safeStr(source, 100) : null, medium ? safeStr(medium, 100) : null,
        campaign ? safeStr(campaign, 200) : null, referrer ? safeStr(referrer, 500) : null,
        landing_page ? safeStr(landing_page, 500) : null,
        fbclid ? safeStr(fbclid, 200) : null, gclid ? safeStr(gclid, 200) : null,
        normalizeMetadata(metadata),
      ]
    );
    return true;
  } catch (e) {
    console.warn('[analyticsLog] insertEvent failed:', e.message);
    return false;
  }
}

// 查重：同一 store + order_id + event_name 是否已存在（用於 submit_order / purchase 防重複）
function hasEventForOrder(db, storeId, orderId, eventName) {
  if (!orderId) return false;
  try {
    const row = db.get(
      `SELECT id FROM analytics_events WHERE store_id=? AND order_id=? AND event_name=? LIMIT 1`,
      [storeId, orderId, eventName]
    );
    return !!row;
  } catch (e) {
    console.warn('[analyticsLog] hasEventForOrder failed:', e.message);
    return false;
  }
}

// purchase 事件查重：同一 store + order_id 只能有一筆 purchase（保留原函式名稱相容既有呼叫端）
function hasPurchaseForOrder(db, storeId, orderId) {
  return hasEventForOrder(db, storeId, orderId, 'purchase');
}

// LINE Pay 付款流程：/request 與 /confirm 都不會收到前端的 visitor_id/session_id/
// cart_id（那些只在建立訂單當下的 /api/line-orders、/api/line-shipping 請求中送出）。
// 因此 confirm 成功要寫 purchase 事件時，回頭讀取該訂單建立當下寫入的 submit_order
// 事件，取用同一組追蹤欄位，確保 purchase 與 submit_order 可用 order_id 正確關聯。
function getOrderTrackingContext(db, storeId, orderId) {
  if (!orderId) return null;
  try {
    const row = db.get(
      `SELECT visitor_id, session_id, cart_id, order_mode, source, medium, campaign,
              referrer, landing_page, fbclid, gclid, metadata_json
       FROM analytics_events
       WHERE store_id=? AND order_id=? AND event_name='submit_order'
       ORDER BY id DESC LIMIT 1`,
      [storeId, orderId]
    );
    return row || null;
  } catch (e) {
    console.warn('[analyticsLog] getOrderTrackingContext failed:', e.message);
    return null;
  }
}

// 供後端（訂單建立成功 / LINE Pay Confirm 成功）呼叫的安全寫入。
// 用於 submit_order / purchase，這兩種事件不信任前端直接寫入，只能由伺服器呼叫。
// 兩者皆會自動查重（同一 store_id + order_id + event_name 只寫一次）。
function logServerEvent(db, fields) {
  if (!isValidEventName(fields.event_name)) return false;
  if (fields.event_name === 'submit_order' || fields.event_name === 'purchase') {
    if (hasEventForOrder(db, fields.store_id, fields.order_id, fields.event_name)) return false; // 已存在，略過
  }
  return insertEvent(db, fields);
}

// ── fix18-10-hotfix23-D：把前端送單時附帶的 first_touch／last_touch／utm_content／
// utm_term 組成 submit_order 的 metadata。只挑固定的追蹤欄位，前端就算塞入姓名、電話、
// 金額等其他欄位也不會被寫入（需求文件十四：資料安全）。
const MAX_TOUCH_STR = 300;
function _sanitizeTouch(touch) {
  if (!touch || typeof touch !== 'object') return null;
  const pick = (v, max) => (v === undefined || v === null) ? '' : String(v).slice(0, max || MAX_TOUCH_STR);
  const out = {
    source: pick(touch.source), medium: pick(touch.medium), campaign: pick(touch.campaign),
    content: pick(touch.content), term: pick(touch.term),
    referrer: pick(touch.referrer, 500), landing_page: pick(touch.landing_page, 500),
    fbclid: pick(touch.fbclid), gclid: pick(touch.gclid),
    captured_at: pick(touch.captured_at, 50),
  };
  // 全空就視為沒有資料，不寫入空殼物件
  return Object.values(out).some(v => v) ? out : null;
}
function buildTrackingMetadata(ap) {
  ap = ap || {};
  const metadata = {};
  const rawMeta = (ap.metadata && typeof ap.metadata === 'object') ? ap.metadata : {};
  if (rawMeta.utm_content) metadata.utm_content = String(rawMeta.utm_content).slice(0, 300);
  if (rawMeta.utm_term) metadata.utm_term = String(rawMeta.utm_term).slice(0, 300);
  const ft = _sanitizeTouch(ap.first_touch || rawMeta.first_touch);
  const lt = _sanitizeTouch(ap.last_touch || rawMeta.last_touch);
  if (ft) metadata.first_touch = ft;
  if (lt) metadata.last_touch = lt;
  return Object.keys(metadata).length ? metadata : null;
}

module.exports = {
  EVENT_WHITELIST,
  isValidEventName,
  MAX_METADATA_BYTES,
  clampInt,
  safeStr,
  normalizeMetadata,
  insertEvent,
  hasPurchaseForOrder,
  hasEventForOrder,
  getOrderTrackingContext,
  logServerEvent,
  buildTrackingMetadata,
};
