// utils/cartSnapshot.js — fix18-10-hotfix30-B5-R5
//
// 目的（需求文件「Cart Detail × Accurate Cart Snapshot」）：
//   把「目前未完成購物車」從單純加總 add_to_cart 數量，改成優先使用
//   cart_updated / cart_restored 事件裡保存的完整購物車快照（items/subtotal/
//   discount/delivery_fee/total/order_mode），只有在該 cart_id 完全沒有快照時
//   才退回舊的「SUM(add_to_cart.quantity) × 目前商品售價」估算法，並明確標記
//   estimated=true。
//
// 不新增第二套 Analytics 系統：全部讀寫都在既有 analytics_events 表（同一張表、
// 同一個 metadata_json 欄位），不新增 analytics_cart_snapshots 資料表 ——
// 稽核結論見 CHANGELOG_HOTFIX30_B5_R5_CART_DETAIL_ORDER_HOURS.md「資料來源稽核」。
//
// 效能原則：所有查詢一律批次（IN (...)），不對每個購物車逐筆查詢商品／會員／事件
// （需求文件「不得為每個購物車逐筆執行 N+1 商品查詢」）。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
// fix18-10-hotfix31-R4.1（需求文件 B）：唯一的渠道分類/標籤來源，不得另建第二套
// order_mode → 中文標籤的對照表。渠道值本身在事件寫入當下就已經由
// utils/channelResolver.js resolveOrderChannel() 算好、存進 analytics_events.order_channel，
// 這裡只是讀出既有欄位，不重新分類。
const { ORDER_CHANNELS, ORDER_CHANNEL_LABELS } = require('./channelResolver');
let maskLineUserId;
try {
  ({ maskLineUserId } = require('./lineMemberStats'));
} catch (e) {
  maskLineUserId = (id) => { const s = String(id || ''); return s.length <= 8 ? (s ? s[0] + '****' : '') : s.slice(0, 5) + '****' + s.slice(-4); };
}

// ────────────────────────────────────────────────────────────────
// 事件名稱中文化（老闆看得懂的說法，不直接把 event_name 原文丟出去）
// ────────────────────────────────────────────────────────────────
const EVENT_NAME_ZH = {
  page_view: '瀏覽頁面',
  view_product: '瀏覽商品',
  add_to_cart: '加入購物車',
  remove_from_cart: '移除購物車商品',
  cart_updated: '購物車內容更新',
  cart_restored: '重新開啟購物車',
  begin_checkout: '開始結帳',
  submit_order: '填寫資料並送出',
  payment_started: '開始付款',
  purchase: '完成購買',
  line_gate_view: '瀏覽 LINE 會員頁',
  line_login_start: '開啟 LINE Login',
  line_login_success: 'LINE Login 成功',
  line_login_failed: 'LINE Login 失敗',
  friend_prompt_shown: '顯示加好友提示',
  friend_gate_passed: '通過好友檢查',
  line_gate_skipped: '略過 LINE 會員頁',
  member_login: '會員登入',
  fulfillment_method_view: '瀏覽取餐方式',
  fulfillment_method_selected: '選擇取餐方式',
  fulfillment_method_unavailable: '取餐方式不可用',
  fulfillment_method_auto_switched: '自動切換取餐方式',
  mode_conflict: '取餐方式衝突',
  // 需求文件二十三：LINE Checkout Funnel 相容保留（本版尚未正式啟用，
  // 事件若已存在時，Timeline 仍需能顯示，不得寫死只認識目前事件名稱）。
  line_checkout_handoff: 'LINE 結帳轉接',
  line_checkout_handoff_created: '建立 LINE 結帳轉接',
  line_checkout_handoff_opened: '開啟 LINE 結帳轉接',
  line_checkout_message_sent: '傳送 LINE 結帳訊息',
  line_checkout_liff_opened: '開啟 LIFF 結帳',
  line_checkout_cart_restored: 'LINE 端恢復購物車',
  line_checkout_handoff_expired: 'LINE 結帳轉接逾期',
  line_checkout_handoff_consumed: 'LINE 結帳轉接已使用',
};
function zhEventName(name) {
  return EVENT_NAME_ZH[name] || (name ? String(name) : '未知操作');
}

// ────────────────────────────────────────────────────────────────
// 最後流程階段（依購物車最後一筆事件判斷；找不到對應事件時退回「加入購物車」）
// 注意：目前事件白名單沒有「地址確認」「付款失敗」對應的獨立事件，因此這兩個
// 階段目前無法被辨識為 last_stage（誠實揭露，見 CHANGELOG），退回鄰近階段。
// ────────────────────────────────────────────────────────────────
const STAGE_LABELS = {
  add_to_cart: '加入購物車',
  cart_updated: '加入購物車',
  cart_restored: '加入購物車',
  remove_from_cart: '加入購物車',
  view_product: '加入購物車',
  page_view: '加入購物車',
  begin_checkout: '開始結帳',
  submit_order: '填寫資料',
  line_login_start: 'LINE Login',
  line_login_success: 'LINE Login 成功',
  line_login_failed: 'LINE Login',
  payment_started: '付款開始',
  purchase: '已完成購買',
};
function stageLabel(eventName) {
  return STAGE_LABELS[eventName] || '加入購物車';
}
// 判斷是否屬於「結帳中」的事件（供 status=checkout 判斷）
const CHECKOUT_STAGE_EVENTS = new Set([
  'begin_checkout', 'submit_order', 'payment_started',
  'line_login_start', 'line_login_success', 'line_login_failed',
]);

// ────────────────────────────────────────────────────────────────
// 放置時間格式化（供 age_label 使用，符合需求文件範例：
// 「42 分鐘」「6 小時 20 分」「1 天 3 小時」；不得顯示「1060 分鐘」這種格式）
// ────────────────────────────────────────────────────────────────
function formatAgeLabel(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘`;
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`;
  }
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return h > 0 ? `${d} 天 ${h} 小時` : `${d} 天`;
}

function ageBucketOf(ageSeconds) {
  const m = ageSeconds / 60;
  if (m <= 30) return '30分鐘內';
  if (m <= 60) return '30分鐘~1小時';
  if (m <= 60 * 24) return '1~24小時';
  if (m <= 60 * 24 * 3) return '1~3天';
  if (m <= 60 * 24 * 7) return '3~7天';
  return '7天以上';
}
// 前端查詢用 age_bucket 參數值 → 內部分桶名稱
const AGE_BUCKET_QUERY_MAP = {
  '30m': '30分鐘內',
  '30m_1h': '30分鐘~1小時',
  '1h_24h': '1~24小時',
  '1d_3d': '1~3天',
  '3d_7d': '3~7天',
  '7d_plus': '7天以上',
};

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function shortId(id) {
  const s = String(id || '');
  return s.length <= 10 ? s : s.slice(0, 6) + '…' + s.slice(-4);
}
function maskAttemptId(id) {
  const s = String(id || '');
  return s.length <= 6 ? s : s.slice(0, 4) + '****';
}

// ────────────────────────────────────────────────────────────────
// metadata 欄位級白名單（cart_updated / cart_restored）——不信任前端傳來的任意
// 結構，只挑允許的欄位；壞掉的 JSON／非物件一律回傳 null（呼叫端 insertEvent
// 會把 metadata=null 寫入，事件本身仍成功寫入，不因此整筆 500）。
// ────────────────────────────────────────────────────────────────
const MAX_CART_ITEMS = 50;
const MAX_ITEM_NAME_LEN = 120;
const MAX_VARIANT_LEN = 120;
const ORDER_MODES = new Set(['takeout', 'delivery', 'shipping', 'dine_in', 'unknown']);

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback || 0);
}
function _safeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_CART_ITEMS).map(it => {
    if (!it || typeof it !== 'object') return null;
    const out = {};
    if (it.product_id !== undefined && it.product_id !== null && it.product_id !== '') {
      const pid = Number(it.product_id);
      if (Number.isFinite(pid) && pid > 0) out.product_id = Math.trunc(pid);
    }
    out.name = String(it.name || '').slice(0, MAX_ITEM_NAME_LEN) || '(未命名商品)';
    out.qty = Math.max(0, Math.trunc(_num(it.qty, 0)));
    out.unit_price = Math.max(0, _num(it.unit_price, 0));
    out.subtotal = Math.max(0, _num(it.subtotal, out.qty * out.unit_price));
    out.variant = it.variant ? String(it.variant).slice(0, MAX_VARIANT_LEN) : null;
    return out;
  }).filter(Boolean);
}

function sanitizeCartSnapshotMetadata(eventName, metadata) {
  if (eventName !== 'cart_updated' && eventName !== 'cart_restored') return metadata; // 不影響其他事件
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const items = _safeItems(metadata.items);
  const subtotal = Math.max(0, _num(metadata.subtotal, items.reduce((s, i) => s + i.subtotal, 0)));
  const discount = Math.max(0, _num(metadata.discount, 0));
  const deliveryFee = Math.max(0, _num(metadata.delivery_fee, 0));
  const out = {
    items,
    subtotal,
    discount,
    delivery_fee: deliveryFee,
    item_count: Math.max(0, Math.trunc(_num(metadata.item_count, items.reduce((s, i) => s + i.qty, 0)))),
  };
  out.total = Math.max(0, _num(metadata.total, subtotal - discount + deliveryFee));
  const om = String(metadata.order_mode || '').trim();
  out.order_mode = ORDER_MODES.has(om) ? om : 'unknown';
  if (metadata.status === 'cleared') out.status = 'cleared';
  // 需求文件「Debounce R5-5」：購物車恢復後若因商品售完／價格／數量被系統自動校正，
  // 允許附上簡短原因字串，讓 Timeline 能區分「系統恢復」與「內容校正」，不是使用者
  // 自己動手改的。選填、白名單欄位、長度受限，不影響既有事件寫入。
  if (metadata.correction_reason) out.correction_reason = String(metadata.correction_reason).slice(0, 80);
  // 需求文件二十三：LINE Checkout Funnel 相容欄位，全部選填 nullable，
  // 沒有提供時不影響事件寫入（不得因缺少這些欄位而拒絕寫入）。
  if (metadata.attempt_id) out.attempt_id = String(metadata.attempt_id).slice(0, 100);
  if (metadata.previous_attempt_id) out.previous_attempt_id = String(metadata.previous_attempt_id).slice(0, 100);
  if (metadata.checkout_stage) out.checkout_stage = String(metadata.checkout_stage).slice(0, 60);
  if (metadata.browser_environment) out.browser_environment = String(metadata.browser_environment).slice(0, 60);
  if (metadata.attribution_reference) out.attribution_reference = String(metadata.attribution_reference).slice(0, 200);
  return out;
}

// metadata_json 解析：壞掉的 JSON 一律回傳 null，絕不拋出例外（需求文件 Cart R5-12）。
function safeParseMetadata(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

function _localToMs(localStr) {
  // localStr 格式 'YYYY-MM-DD HH:MM:SS'，已是 Asia/Taipei 本地時間字串
  // （analytics_events 查詢時透過 A_LOCAL 轉換過），這裡直接當作本地時間解析，
  // 用 Date.parse 搭配時區位移計算與現在時間（UTC ms）的差。
  if (!localStr) return NaN;
  // Asia/Taipei 固定 UTC+8，換算成等價的 UTC 時間字串再 parse，避免受執行環境
  // 系統時區影響（container 時區可能不是 Asia/Taipei）。
  const utcEquivalent = localStr.replace(' ', 'T') + '+08:00';
  const t = new Date(utcEquivalent).getTime();
  return Number.isNaN(t) ? NaN : t;
}
function _msToLocalBoundary(ms) {
  // 給定 UTC ms，回傳「該時刻的 Asia/Taipei 本地時間字串」，格式與 A_LOCAL 輸出一致，
  // 供 HAVING 比較使用。
  const d = new Date(ms + 8 * 3600 * 1000); // 位移 +8 小時後直接取 UTC 欄位即為台灣本地時間
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function emptySummary() {
  return { open_carts: 0, open_amount: 0, over_24h: 0, line_identified: 0 };
}

// ────────────────────────────────────────────────────────────────
// 批次查詢工具（全部以 store_id 隔離；cart_id 一律參數化，不做字串拼接）
// ────────────────────────────────────────────────────────────────
function _inParams(ids) { return ids.map(() => '?').join(','); }

function getCartsCandidateIds(db, storeId, sinceLocalStr) {
  return db.all(
    `SELECT cart_id, MAX(${A_LOCAL}) as last_activity_local, MIN(${A_LOCAL}) as first_seen_local
     FROM analytics_events
     WHERE store_id=? AND cart_id IS NOT NULL AND cart_id != ''
     GROUP BY cart_id
     HAVING last_activity_local >= ?`,
    [storeId, sinceLocalStr]
  );
}

function getPurchasedCartIdSet(db, storeId, cartIds) {
  if (!cartIds.length) return new Set();
  const rows = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND cart_id IN (${_inParams(cartIds)})`,
    [storeId, ...cartIds]
  );
  return new Set(rows.map(r => r.cart_id));
}

// 每個 cart_id 最後一筆 cart_updated / cart_restored 快照（用 MAX(id) 取代逐筆查詢）
function getLatestSnapshotMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const rows = db.all(
    `SELECT cart_id, metadata_json, event_name, id, ${A_LOCAL} as created_at_local
     FROM analytics_events
     WHERE store_id=? AND cart_id IN (${_inParams(cartIds)})
       AND event_name IN ('cart_updated','cart_restored') AND metadata_json IS NOT NULL
     ORDER BY id ASC`,
    [storeId, ...cartIds]
  );
  rows.forEach(r => {
    const parsed = safeParseMetadata(r.metadata_json);
    if (!parsed) return; // 壞掉的 JSON：略過這筆，不讓整體查詢失敗（Cart R5-12）
    // cart_restored 若沒帶完整快照欄位（只是「恢復」動作），不要覆蓋掉前一筆真正的快照
    if (r.event_name === 'cart_restored' && !Array.isArray(parsed.items)) return;
    map[r.cart_id] = { metadata: parsed, event_name: r.event_name, created_at_local: r.created_at_local };
  });
  return map;
}

function getFirstAddToCartMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  db.all(
    `SELECT cart_id, MIN(${A_LOCAL}) as first_added_local
     FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND cart_id IN (${_inParams(cartIds)})
     GROUP BY cart_id`,
    [storeId, ...cartIds]
  ).forEach(r => { map[r.cart_id] = r.first_added_local; });
  return map;
}

// 每個 cart_id 的「第一筆事件」欄位（visitor_id / source / campaign / order_mode /
// identity_key / identity_type）——用來當作該購物車的來源／身分依據。
function getFirstTouchMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const rows = db.all(
    `SELECT cart_id, visitor_id, session_id, source, campaign, order_mode, order_channel, identity_key, identity_type, id
     FROM analytics_events
     WHERE store_id=? AND cart_id IN (${_inParams(cartIds)})
     ORDER BY id ASC`,
    [storeId, ...cartIds]
  );
  rows.forEach(r => { if (!map[r.cart_id]) map[r.cart_id] = r; });
  return map;
}

// 每個 cart_id 的最後一筆事件名稱（供 last_stage 判斷）
function getLastEventMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const rows = db.all(
    `SELECT cart_id, event_name, id
     FROM analytics_events
     WHERE store_id=? AND cart_id IN (${_inParams(cartIds)})
     ORDER BY id ASC`,
    [storeId, ...cartIds]
  );
  rows.forEach(r => { map[r.cart_id] = r.event_name; }); // 後面的會覆蓋前面的，最終即最後一筆
  return map;
}

// 舊資料回退估算：SUM(add_to_cart.quantity) - SUM(remove_from_cart.quantity)，
// 下限 0（沒有 cart_updated 快照時才會用到這個函式；估算法本身與 Hotfix23-B
// 舊邏輯一致，只是額外扣除 remove_from_cart，避免比舊版更失真）。
function getLegacyCartItemsMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const addRows = db.all(
    `SELECT cart_id, product_id, SUM(quantity) as qty
     FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND cart_id IN (${_inParams(cartIds)}) AND product_id IS NOT NULL
     GROUP BY cart_id, product_id`,
    [storeId, ...cartIds]
  );
  const removeRows = db.all(
    `SELECT cart_id, product_id, SUM(quantity) as qty
     FROM analytics_events
     WHERE store_id=? AND event_name='remove_from_cart' AND cart_id IN (${_inParams(cartIds)}) AND product_id IS NOT NULL
     GROUP BY cart_id, product_id`,
    [storeId, ...cartIds]
  );
  const removeMap = {};
  removeRows.forEach(r => { removeMap[`${r.cart_id}|${r.product_id}`] = Number(r.qty || 0); });
  addRows.forEach(r => {
    const removed = removeMap[`${r.cart_id}|${r.product_id}`] || 0;
    const netQty = Math.max(0, Number(r.qty || 0) - removed);
    if (netQty <= 0) return;
    if (!map[r.cart_id]) map[r.cart_id] = [];
    map[r.cart_id].push({ product_id: r.product_id, qty: netQty });
  });
  return map;
}

function getProductsInfoMap(db, storeId, productIds) {
  const map = {};
  if (!productIds.length) return map;
  db.all(
    `SELECT id, name, price FROM products WHERE store_id=? AND id IN (${_inParams(productIds)})`,
    [storeId, ...productIds]
  ).forEach(p => { map[p.id] = { name: p.name, price: Number(p.price || 0) }; });
  return map;
}

function getMemberDisplayNameMap(db, storeId, lineUserIds) {
  const map = {};
  if (!lineUserIds.length) return map;
  try {
    db.all(
      `SELECT line_user_id, display_name FROM line_members WHERE store_id=? AND line_user_id IN (${_inParams(lineUserIds)})`,
      [storeId, ...lineUserIds]
    ).forEach(r => { map[r.line_user_id] = r.display_name || null; });
  } catch (e) { /* line_members 表不存在或查詢失敗：略過，displayName 一律 null */ }
  return map;
}

// fix31-r3：友善好友狀態批次查詢——供 Drill Down 篩選（LINE好友狀態）與訪客
// 資訊顯示共用，同一批次查詢時機（跟 getMemberDisplayNameMap 一起呼叫），
// 不對每一列另外查一次。查不到/非 LINE 會員一律回傳 'unknown'，不臆測。
function getMemberFriendStatusMap(db, storeId, lineUserIds) {
  const map = {};
  if (!lineUserIds.length) return map;
  try {
    db.all(
      `SELECT line_user_id, friend_status FROM line_members WHERE store_id=? AND line_user_id IN (${_inParams(lineUserIds)})`,
      [storeId, ...lineUserIds]
    ).forEach(r => { map[r.line_user_id] = r.friend_status || 'unknown'; });
  } catch (e) { /* line_members 表不存在或查詢失敗：略過，friend_status 一律 unknown */ }
  return map;
}

// ────────────────────────────────────────────────────────────────
// B. 目前未完成購物車（不受「今天是否有新的 add_to_cart」限制，獨立於期間篩選）
// ────────────────────────────────────────────────────────────────
const OPEN_CART_WINDOW_DAYS = 30;

function _buildRowFromCandidate(c, ctx, opts = {}) {
  const { purchasedSet, snapshotMap, firstAddMap, firstTouchMap, lastEventMap,
    legacyItemsMap, productsInfoMap, memberNameMap, nowMs } = ctx;
  const cartId = c.cart_id;
  const isPurchased = purchasedSet.has(cartId);
  // fix31-r1：新增 includePurchased 選項供 utils/drilldown.js 重用同一套批次查詢與
  // 欄位組裝邏輯（Drill Down 需要看到「已成交」的人，不只是未完成購物車）。
  // opts 預設為 {}，既有呼叫端（getOpenCartRows）沒有傳第三個參數，行為完全不變：
  // 已購買一律 return null，不列入未完成清單。
  if (isPurchased && !opts.includePurchased) return null; // 已完成購買，不列入未完成清單

  const snap = snapshotMap[cartId];
  let estimated = true, items = [], subtotal = 0, discount = 0, deliveryFee = 0, total = 0, orderMode = 'unknown';
  let checkoutAttemptId = null, checkoutStage = null;

  if (snap && snap.metadata) {
    if (snap.metadata.status === 'cleared') return null; // 已清空，不列入未完成金額
    estimated = false;
    items = snap.metadata.items || [];
    subtotal = snap.metadata.subtotal || 0;
    discount = snap.metadata.discount || 0;
    deliveryFee = snap.metadata.delivery_fee || 0;
    total = snap.metadata.total || 0;
    orderMode = snap.metadata.order_mode || 'unknown';
    checkoutAttemptId = snap.metadata.attempt_id || null;
    checkoutStage = snap.metadata.checkout_stage || null;
  } else {
    const legacy = legacyItemsMap[cartId] || [];
    if (!legacy.length) return null; // 完全沒有可辨識的商品內容（例如只有 page_view）
    items = legacy.map(li => {
      const info = productsInfoMap[li.product_id];
      const unit = info ? info.price : 0;
      return { product_id: li.product_id, name: info ? info.name : `商品#${li.product_id}`, qty: li.qty, unit_price: unit, subtotal: unit * li.qty, variant: null };
    });
    subtotal = items.reduce((s, i) => s + i.subtotal, 0);
    total = subtotal;
    orderMode = (firstTouchMap[cartId] || {}).order_mode || 'unknown';
  }

  const lastActivityLocal = c.last_activity_local;
  const firstAddedLocal = firstAddMap[cartId] || c.first_seen_local;
  const lastActivityMs = _localToMs(lastActivityLocal);
  const ageSeconds = Number.isFinite(lastActivityMs) ? Math.max(0, Math.round((nowMs - lastActivityMs) / 1000)) : null;
  const bucket = ageSeconds !== null ? ageBucketOf(ageSeconds) : null;

  const ft = firstTouchMap[cartId] || {};
  const lastEventName = lastEventMap[cartId] || 'add_to_cart';
  const stage = stageLabel(lastEventName);
  let statusVal = 'abandoned';
  if (isPurchased) statusVal = 'purchased';
  else if (ageSeconds !== null && ageSeconds <= 30 * 60) statusVal = 'active';
  else if (CHECKOUT_STAGE_EVENTS.has(lastEventName)) statusVal = 'checkout';

  const isLine = ft.identity_type === 'line_user_id';
  let lineUidMasked = null, displayName = null, visitorShort = null, lineUidRaw = null;
  if (isLine) {
    lineUidRaw = (ft.identity_key || '').replace('line_user:', '');
    lineUidMasked = maskLineUserId(lineUidRaw);
    displayName = memberNameMap[lineUidRaw] || null;
  } else {
    visitorShort = shortId(ft.visitor_id || cartId);
  }

  return {
    cart_id: cartId,
    cart_id_short: shortId(cartId),
    visitor_id_short: visitorShort,
    _visitor_id_raw: ft.visitor_id || null, // 內部用（同 _line_uid_raw 慣例）：CRM/Drill Down 需要真實可再查詢的 key，不能只有顯示用短碼
    line_uid_masked: lineUidMasked,
    _line_uid_raw: lineUidRaw, // 內部用，供權限判斷/複製 UID 使用；一般 JSON 回應會被 routes 層剔除
    display_name: displayName,
    identity_type: isLine ? 'line' : 'visitor',
    order_mode: ['takeout', 'delivery', 'shipping'].includes(orderMode) ? orderMode : (orderMode === 'dine_in' ? 'takeout' : 'unknown'),
    // fix18-10-hotfix31-R4.1（需求文件 B）：渠道一律讀既有 analytics_events.order_channel
    // 欄位（寫入當下已由 resolveOrderChannel() 算好），不得在這裡重新用 order_mode
    // 猜測渠道——這正是「明細顯示外帶/外送，但跟頂層渠道選擇器對不起來」的根因。
    // 沒有可靠值時一律 'unknown'，不得悄悄併入 line_takeout/line_delivery。
    channel: (ft.order_channel && ORDER_CHANNELS.includes(ft.order_channel)) ? ft.order_channel : 'unknown',
    channel_label: ORDER_CHANNEL_LABELS[(ft.order_channel && ORDER_CHANNELS.includes(ft.order_channel)) ? ft.order_channel : 'unknown'],
    source: ft.source || 'Direct',
    campaign: ft.campaign || '(No Campaign)',
    first_added_at: firstAddedLocal,
    last_activity_at: lastActivityLocal,
    age_seconds: ageSeconds,
    age_label: formatAgeLabel(ageSeconds),
    last_stage: stage,
    status: statusVal,
    items,
    subtotal: round2(subtotal),
    discount: round2(discount),
    delivery_fee: round2(deliveryFee),
    total: round2(total),
    estimated,
    checkout_attempt_count: checkoutAttemptId ? 1 : 0,
    last_attempt_id_masked: checkoutAttemptId ? maskAttemptId(checkoutAttemptId) : null,
    last_checkout_stage: checkoutStage,
    line_checkout_events_available: false, // 本版尚未正式啟用 LINE Checkout Funnel（需求文件二十三）
    _age_bucket: bucket, // 內部用於篩選，不對外輸出
  };
}

function computeOpenSummary(rows) {
  const summary = emptySummary();
  rows.forEach(r => {
    summary.open_carts += 1;
    summary.open_amount += Number(r.total || 0);
    if (r.age_seconds !== null && r.age_seconds >= 24 * 3600) summary.over_24h += 1;
    if (r.identity_type === 'line') summary.line_identified += 1;
  });
  summary.open_amount = round2(summary.open_amount);
  return summary;
}

/**
 * 目前未完成購物車列表（獨立於「所選期間」，最近 30 天內仍未完成的購物車）。
 * @param {object} opts { page, limit, status, age_bucket, identity, order_mode }
 */
function getOpenCartRows(db, storeId, opts = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(opts.limit) || 20)));
  const safePage = Math.max(1, Math.trunc(Number(opts.page) || 1));
  const status = opts.status || 'all';
  const ageBucketKey = opts.age_bucket || 'all';
  const identity = opts.identity || 'all';
  const orderMode = opts.order_mode || 'all';

  const nowMs = Date.now();
  const sinceLocal = _msToLocalBoundary(nowMs - OPEN_CART_WINDOW_DAYS * 24 * 3600 * 1000);

  const candidates = getCartsCandidateIds(db, storeId, sinceLocal);
  if (!candidates.length) {
    return { rows: [], total: 0, page: safePage, limit: safeLimit, current_open_summary: emptySummary() };
  }
  const cartIds = candidates.map(c => c.cart_id);
  const purchasedSet = getPurchasedCartIdSet(db, storeId, cartIds);
  const snapshotMap = getLatestSnapshotMap(db, storeId, cartIds);
  const firstAddMap = getFirstAddToCartMap(db, storeId, cartIds);
  const firstTouchMap = getFirstTouchMap(db, storeId, cartIds);
  const lastEventMap = getLastEventMap(db, storeId, cartIds);

  const cartIdsNeedingLegacy = cartIds.filter(id => !snapshotMap[id]);
  const legacyItemsMap = getLegacyCartItemsMap(db, storeId, cartIdsNeedingLegacy);
  const legacyProductIds = [...new Set(Object.values(legacyItemsMap).flat().map(i => i.product_id))];
  const productsInfoMap = getProductsInfoMap(db, storeId, legacyProductIds);

  const lineUserIds = [...new Set(
    Object.values(firstTouchMap)
      .filter(r => r.identity_type === 'line_user_id')
      .map(r => (r.identity_key || '').replace('line_user:', ''))
  )];
  const memberNameMap = getMemberDisplayNameMap(db, storeId, lineUserIds);

  const ctx = { purchasedSet, snapshotMap, firstAddMap, firstTouchMap, lastEventMap, legacyItemsMap, productsInfoMap, memberNameMap, nowMs };

  let rows = candidates.map(c => _buildRowFromCandidate(c, ctx)).filter(Boolean);

  // 篩選（篩選在批次查詢完成之後、於應用層進行；單店 30 天內未完成購物車量級
  // 有限，優先確保正確性與可讀性，不在此為了極端規模做額外 SQL 分頁優化）
  if (orderMode !== 'all') rows = rows.filter(r => r.order_mode === orderMode);
  if (identity !== 'all') rows = rows.filter(r => r.identity_type === identity);
  if (ageBucketKey !== 'all') {
    const bucketName = AGE_BUCKET_QUERY_MAP[ageBucketKey];
    rows = rows.filter(r => r._age_bucket === bucketName);
  }
  if (status !== 'all') rows = rows.filter(r => r.status === status);

  const summary = computeOpenSummary(rows);
  rows.sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || ''));

  const total = rows.length;
  const start = (safePage - 1) * safeLimit;
  const pageRows = rows.slice(start, start + safeLimit).map(r => {
    const { _age_bucket, _line_uid_raw, _visitor_id_raw, ...pub } = r;
    return pub;
  });

  return { rows: pageRows, total, page: safePage, limit: safeLimit, current_open_summary: summary };
}

// ────────────────────────────────────────────────────────────────
// 購物車詳情（含完整事件時間軸）
// ────────────────────────────────────────────────────────────────
function getCartDetail(db, storeId, cartId, { includeFullUid = false } = {}) {
  if (!cartId) return null;
  const events = db.all(
    `SELECT id, event_name, product_id, quantity, metadata_json, source, campaign, order_mode, order_channel,
            visitor_id, session_id, identity_key, identity_type, ${A_LOCAL} as created_at_local
     FROM analytics_events
     WHERE store_id=? AND cart_id=?
     ORDER BY id ASC`,
    [storeId, cartId]
  );
  if (!events.length) return null;

  const productIds = [...new Set(events.filter(e => e.product_id).map(e => e.product_id))];
  const productsInfoMap = getProductsInfoMap(db, storeId, productIds);

  const timeline = events.map(e => {
    let detail = '';
    if ((e.event_name === 'add_to_cart' || e.event_name === 'remove_from_cart') && e.product_id) {
      const info = productsInfoMap[e.product_id];
      const name = info ? info.name : `商品#${e.product_id}`;
      detail = `${name} ×${e.quantity || 1}`;
    } else if (e.event_name === 'cart_updated') {
      const meta = safeParseMetadata(e.metadata_json);
      if (meta && Array.isArray(meta.items)) {
        detail = meta.items.length ? meta.items.map(i => `${i.name}×${i.qty}`).join('、') : '(購物車已清空)';
        if (meta.correction_reason) detail += `（系統自動校正：${meta.correction_reason}）`;
      }
    }
    // 需求文件「Debounce R5-5」：帶 correction_reason 的 cart_updated 在 Timeline 上
    // 顯示為「購物車內容校正」，跟一般使用者主動修改的「購物車內容更新」區分開來
    // （同一份 metadata 就近判斷，不需要另外掃描整批事件）。
    let eventNameZh = zhEventName(e.event_name);
    if (e.event_name === 'cart_updated') {
      const metaForLabel = safeParseMetadata(e.metadata_json);
      if (metaForLabel && metaForLabel.correction_reason) eventNameZh = '購物車內容校正（系統自動）';
    }
    return {
      time: (e.created_at_local || '').slice(11, 16), // HH:MM，符合需求文件時間軸範例格式
      created_at: e.created_at_local,
      event_name_zh: eventNameZh,
      event_name_raw: e.event_name, // 供未來擴充比對用，一般畫面不需顯示
      detail,
    };
  });

  const purchased = events.some(e => e.event_name === 'purchase');
  const snapshotRows = events.filter(e => (e.event_name === 'cart_updated' || e.event_name === 'cart_restored') && e.metadata_json);
  let snapshot = null;
  for (let i = snapshotRows.length - 1; i >= 0; i--) {
    const parsed = safeParseMetadata(snapshotRows[i].metadata_json);
    if (parsed && (Array.isArray(parsed.items) || snapshotRows[i].event_name === 'cart_updated')) { snapshot = parsed; break; }
  }
  // 供 LINE Checkout Funnel 相容欄位統計（section 23）：目前已知有多少筆帶 attempt_id 的快照
  const attemptIds = new Set();
  snapshotRows.forEach(r => {
    const parsed = safeParseMetadata(r.metadata_json);
    if (parsed && parsed.attempt_id) attemptIds.add(parsed.attempt_id);
  });

  let estimated = true, items = [], subtotal = 0, discount = 0, deliveryFee = 0, total = 0, orderMode = 'unknown';
  if (snapshot) {
    estimated = false;
    items = snapshot.items || [];
    subtotal = snapshot.subtotal || 0;
    discount = snapshot.discount || 0;
    deliveryFee = snapshot.delivery_fee || 0;
    total = snapshot.total || 0;
    orderMode = snapshot.order_mode || 'unknown';
  } else {
    const legacyMap = getLegacyCartItemsMap(db, storeId, [cartId]);
    const legacy = legacyMap[cartId] || [];
    const legacyProductIds = [...new Set(legacy.map(i => i.product_id))];
    const legacyInfoMap = getProductsInfoMap(db, storeId, legacyProductIds);
    items = legacy.map(li => {
      const info = legacyInfoMap[li.product_id];
      const unit = info ? info.price : 0;
      return { product_id: li.product_id, name: info ? info.name : `商品#${li.product_id}`, qty: li.qty, unit_price: unit, subtotal: unit * li.qty, variant: null };
    });
    subtotal = items.reduce((s, i) => s + i.subtotal, 0);
    total = subtotal;
  }

  const first = events[0];
  const last = events[events.length - 1];
  const sessionCount = new Set(events.map(e => e.session_id).filter(Boolean)).size;
  const isLine = first.identity_type === 'line_user_id' || (last.identity_type === 'line_user_id');
  const idRow = events.find(e => e.identity_type === 'line_user_id') || first;
  const lineUidRaw = isLine ? (idRow.identity_key || '').replace('line_user:', '') : null;
  const memberNameMap = lineUidRaw ? getMemberDisplayNameMap(db, storeId, [lineUidRaw]) : {};

  // 同一 LINE 會員在其他裝置上的其他未完成購物車（不合併內容，只提示存在）
  let otherDeviceCartCount = 0;
  if (lineUidRaw) {
    try {
      const idKey = `line_user:${lineUidRaw}`;
      const others = db.all(
        `SELECT DISTINCT cart_id FROM analytics_events
         WHERE store_id=? AND identity_key=? AND cart_id IS NOT NULL AND cart_id != ? `,
        [storeId, idKey, cartId]
      );
      otherDeviceCartCount = others.length;
    } catch (e) { otherDeviceCartCount = 0; }
  }

  return {
    cart_id: cartId,
    cart_id_short: shortId(cartId),
    visitor_id_short: shortId(first.visitor_id || cartId),
    line_uid_masked: lineUidRaw ? maskLineUserId(lineUidRaw) : null,
    line_uid_full: includeFullUid ? lineUidRaw : undefined, // 只在有權限的呼叫端要求時才附上
    display_name: lineUidRaw ? (memberNameMap[lineUidRaw] || null) : null,
    identity_type: isLine ? 'line' : 'visitor',
    other_device_cart_count: otherDeviceCartCount,
    session_count: sessionCount,
    first_added_at: first.created_at_local,
    last_activity_at: last.created_at_local,
    source: first.source || 'Direct',
    campaign: first.campaign || '(No Campaign)',
    order_mode: orderMode,
    // fix18-10-hotfix31-R4.1（需求文件 B）：渠道同樣一律讀既有 order_channel 欄位
    // （用第一筆事件的值，跟 buildRowFromCandidate() 同一套規則），不猜測。
    channel: (first.order_channel && ORDER_CHANNELS.includes(first.order_channel)) ? first.order_channel : 'unknown',
    channel_label: ORDER_CHANNEL_LABELS[(first.order_channel && ORDER_CHANNELS.includes(first.order_channel)) ? first.order_channel : 'unknown'],
    items,
    subtotal: round2(subtotal),
    discount: round2(discount),
    delivery_fee: round2(deliveryFee),
    total: round2(total),
    estimated,
    status: purchased ? 'purchased' : (snapshot && snapshot.status === 'cleared' ? 'cleared' : 'open'),
    timeline,
    // 需求文件二十三：LINE Checkout Funnel 相容預留欄位
    checkout_attempt_count: attemptIds.size,
    last_attempt_id_masked: attemptIds.size ? maskAttemptId([...attemptIds].pop()) : null,
    last_checkout_stage: snapshot ? (snapshot.checkout_stage || null) : null,
    line_checkout_events_available: false,
  };
}

module.exports = {
  EVENT_NAME_ZH,
  zhEventName,
  STAGE_LABELS,
  stageLabel,
  formatAgeLabel,
  ageBucketOf,
  AGE_BUCKET_QUERY_MAP,
  sanitizeCartSnapshotMetadata,
  safeParseMetadata,
  getOpenCartRows,
  getCartDetail,
  OPEN_CART_WINDOW_DAYS,
  // 供測試使用
  round2,
  shortId,
  maskAttemptId,
  // fix31-r1：供 utils/drilldown.js 重用（Operation Analytics Drill Down ×
  // CRM Action Center 需要對「任意 KPI／維度」而非只有「未完成購物車」組出同一種
  // 列格式，重用既有批次查詢，不建立第二套購物車/會員查詢邏輯）。
  getPurchasedCartIdSet,
  getLatestSnapshotMap,
  getFirstAddToCartMap,
  getFirstTouchMap,
  getLastEventMap,
  getLegacyCartItemsMap,
  getProductsInfoMap,
  getMemberDisplayNameMap,
  getMemberFriendStatusMap,
  buildRowFromCandidate: _buildRowFromCandidate,
  emptySummary,
  computeOpenSummary,
};
