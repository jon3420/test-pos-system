// utils/drilldown.js — fix18-10-hotfix31-R1/R2「Operation Analytics 深度營運分析」
//
// 目的（需求文件二、四）：Operation Analytics 的每一個 KPI／圖表區塊都必須可以
// 「點下去」→ 直接看到造成這個數字的訪客／會員／Session／購物車清單，而不是只有
// Cart Abandonment 才能查明細。
//
// 設計原則：不建立第二套 Analytics 系統。所有資料一律讀自既有 analytics_events／
// line_members 表，欄位組裝與購物車金額估算邏輯全部重用 utils/cartSnapshot.js
// 既有的批次查詢函式（getPurchasedCartIdSet／getLatestSnapshotMap／…／
// buildRowFromCandidate），只是把「候選 cart_id 清單」從「最近 30 天內未完成」
// 換成「符合任意維度篩選條件」，purchased 的購物車這裡不排除（Drill Down 需要
// 能看到「已成交」的人，Cart Abandonment 頁面則維持原本排除已購買的行為，兩者
// 用途不同、互不影響）。
//
// 安全與效能慣例，沿用 cartSnapshot.js：
//   - 所有查詢一律以 store_id 隔離、參數化查詢，不做字串拼接。
//   - 批次 IN (...) 查詢，不對每個 cart_id 逐筆查詢。
//   - 候選集合有硬上限（見 MAX_CANDIDATE_CARTS），避免單次撈出整店全部歷史事件。
//   - R2 硬化（需求文件 J）：所有可篩選/可排序欄位一律白名單，拒絕任意欄位名稱；
//     回應附上 generated_at（資料新鮮度時間戳）與 warnings（例如候選集合被
//     MAX_CANDIDATE_CARTS 截斷時明確告知，不悄悄回傳不完整結果）。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
const {
  getPurchasedCartIdSet,
  getLatestSnapshotMap,
  getFirstAddToCartMap,
  getFirstTouchMap,
  getLastEventMap,
  getLegacyCartItemsMap,
  getProductsInfoMap,
  getMemberDisplayNameMap,
  getMemberFriendStatusMap,
  buildRowFromCandidate,
  ageBucketOf,
  AGE_BUCKET_QUERY_MAP,
} = require('./cartSnapshot');

// 允許的 Drill Down 維度（需求文件四：來源／模式／LINE會員／事件皆可點選篩選）。
// 白名單，避免前端傳入任意欄位名稱造成 SQL 注入或查詢到不該查詢的欄位。
// 這些是 analytics_events 的「原始欄位」，用來找候選 cart_id（SQL 層篩選）。
const DIMENSION_COLUMN_MAP = {
  event_name: 'event_name',
  source: 'source',
  campaign: 'campaign',
  medium: 'medium',
  order_mode: 'order_mode',
  identity_type: 'identity_type', // 注意：這是「事件層級」的原始值（line_user_id/session_id/…），
  order_channel: 'order_channel', // 跟下面 identity_state（列層級、line/visitor）是不同的兩件事
  page_type: 'page_type',
};

// fix31-r3：Cart Detail Explorer 篩選列白名單——這些不是 analytics_events 的
// 原始欄位，是 buildRowFromCandidate() 組好列之後才算得出來的「衍生欄位」
// （購物車目前狀態／身份是 LINE 會員還是匿名／LINE 好友狀態／多久沒動作），
// 所以一律在應用層對已組好的列做篩選，不會出現在 SQL WHERE 子句裡。
const CART_STATUS_VALUES = new Set(['active', 'checkout', 'abandoned', 'purchased']);
const IDENTITY_STATE_VALUES = new Set(['line', 'visitor']);
const FRIEND_STATUS_VALUES = new Set(['friend', 'not_friend', 'unknown']);

const MAX_CANDIDATE_CARTS = 3000; // 單次 Drill Down 候選購物車數量上限，避免極端規模拖垮查詢

// 需求文件 J：排序欄位白名單（只允許已知安全欄位，拒絕任意排序字串）
const SORT_FIELD_MAP = {
  last_activity_at: 'last_activity_at',
  first_added_at: 'first_added_at',
  total: 'total',
  age_seconds: 'age_seconds',
};
const DEFAULT_SORT_FIELD = 'last_activity_at';
const SORT_DIRECTIONS = new Set(['asc', 'desc']);

function _inParams(ids) { return ids.map(() => '?').join(','); }

function _sanitizeFilters(filters = {}) {
  const clean = {};
  Object.keys(DIMENSION_COLUMN_MAP).forEach((key) => {
    const val = filters[key];
    if (val !== undefined && val !== null && val !== '' && val !== 'all') clean[key] = String(val).slice(0, 200);
  });
  if (filters.date_from) clean.date_from = String(filters.date_from).slice(0, 32);
  if (filters.date_to) clean.date_to = String(filters.date_to).slice(0, 32);
  if (filters.product_id !== undefined && filters.product_id !== null && filters.product_id !== '') {
    const pid = Number(filters.product_id);
    if (Number.isFinite(pid) && pid > 0) clean.product_id = Math.trunc(pid);
  }
  if (filters.min_amount !== undefined && filters.min_amount !== null && filters.min_amount !== '') {
    const v = Number(filters.min_amount);
    if (Number.isFinite(v)) clean.min_amount = v;
  }
  if (filters.max_amount !== undefined && filters.max_amount !== null && filters.max_amount !== '') {
    const v = Number(filters.max_amount);
    if (Number.isFinite(v)) clean.max_amount = v;
  }
  // fix31-r3：衍生欄位篩選（購物車狀態／身份狀態／LINE好友狀態／未活動時間），
  // 一律走白名單，非白名單值直接忽略（不拋錯、不當成「全部」以外的意思）。
  if (filters.cart_status && CART_STATUS_VALUES.has(filters.cart_status)) clean.cart_status = filters.cart_status;
  if (filters.identity_state && IDENTITY_STATE_VALUES.has(filters.identity_state)) clean.identity_state = filters.identity_state;
  if (filters.friend_status && FRIEND_STATUS_VALUES.has(filters.friend_status)) clean.friend_status = filters.friend_status;
  if (filters.age_bucket && Object.prototype.hasOwnProperty.call(AGE_BUCKET_QUERY_MAP, filters.age_bucket)) clean.age_bucket = filters.age_bucket;
  return clean;
}

/**
 * 依篩選條件找出符合的 cart_id 清單。
 * filters: { event_name, source, campaign, medium, order_mode, identity_type,
 *            order_channel, page_type, date_from, date_to, product_id }
 * date_from / date_to 格式為 'YYYY-MM-DD HH:MM:SS'（Asia/Taipei 本地時間字串），
 * 與既有 A_LOCAL 換算後的欄位比較。min_amount／max_amount 不在這裡篩選——
 * 金額是購物車快照/估算組裝出來的衍生值，不是 analytics_events 的原始欄位，
 * 一律在 buildRowsForCartIds 組好列之後、應用層篩選（見 getDrilldownRows）。
 * 回傳 { ids, truncated }：truncated=true 代表候選集合被 MAX_CANDIDATE_CARTS
 * 截斷，呼叫端必須明確告知使用者結果可能不完整（見需求文件 J warnings）。
 */
function findMatchingCartIds(db, storeId, rawFilters = {}) {
  const filters = _sanitizeFilters(rawFilters);
  const where = ["store_id=?", "cart_id IS NOT NULL", "cart_id != ''"];
  const params = [storeId];

  Object.keys(DIMENSION_COLUMN_MAP).forEach((key) => {
    if (filters[key] !== undefined) { where.push(`${DIMENSION_COLUMN_MAP[key]}=?`); params.push(filters[key]); }
  });
  if (filters.product_id !== undefined) { where.push('product_id=?'); params.push(filters.product_id); }
  if (filters.date_from) { where.push(`${A_LOCAL} >= ?`); params.push(filters.date_from); }
  if (filters.date_to) { where.push(`${A_LOCAL} <= ?`); params.push(filters.date_to); }

  const rows = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE ${where.join(' AND ')}
     LIMIT ${MAX_CANDIDATE_CARTS + 1}`,
    params
  );
  const ids = rows.map((r) => r.cart_id);
  const truncated = ids.length > MAX_CANDIDATE_CARTS;
  return { ids: truncated ? ids.slice(0, MAX_CANDIDATE_CARTS) : ids, truncated };
}

/**
 * 找出符合篩選條件的「所有事件」所屬的 visitor/session 清單（不要求有 cart_id）。
 * 用於 page_view／view_product 等尚未加入購物車就離開的情境（需求文件四「點
 * Facebook → 只剩 Facebook」不應該只看有購物車的人）。目前先回傳 distinct
 * visitor_id 清單，供 GET /drilldown?dimension=... 的「總覆蓋人數」欄位使用；
 * 詳細列表仍以 cart_id 為單位呈現（沿用 Cart Detail Explorer 既有欄位格式），
 * 這是本版（Backend Foundation）明確揭露的範圍限制，見 CHANGELOG。
 */
function countMatchingVisitors(db, storeId, rawFilters = {}) {
  const filters = _sanitizeFilters(rawFilters);
  const where = ["store_id=?", "visitor_id IS NOT NULL", "visitor_id != ''"];
  const params = [storeId];
  Object.keys(DIMENSION_COLUMN_MAP).forEach((key) => {
    if (filters[key] !== undefined) { where.push(`${DIMENSION_COLUMN_MAP[key]}=?`); params.push(filters[key]); }
  });
  if (filters.product_id !== undefined) { where.push('product_id=?'); params.push(filters.product_id); }
  if (filters.date_from) { where.push(`${A_LOCAL} >= ?`); params.push(filters.date_from); }
  if (filters.date_to) { where.push(`${A_LOCAL} <= ?`); params.push(filters.date_to); }

  const row = db.get(
    `SELECT COUNT(DISTINCT visitor_id) as c FROM analytics_events WHERE ${where.join(' AND ')}`,
    params
  );
  return Number((row || {}).c || 0);
}

function getActivityMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const rows = db.all(
    `SELECT cart_id, MAX(${A_LOCAL}) as last_activity_local, MIN(${A_LOCAL}) as first_seen_local
     FROM analytics_events WHERE store_id=? AND cart_id IN (${_inParams(cartIds)})
     GROUP BY cart_id`,
    [storeId, ...cartIds]
  );
  rows.forEach((r) => { map[r.cart_id] = r; });
  return map;
}

/**
 * 依候選 cart_id 清單組出完整列（重用 cartSnapshot.js 的批次查詢與欄位組裝）。
 * includePurchased 預設 true——Drill Down 情境需要看到「已成交」的人（例如
 * 「點開始結帳 → 看到有哪些人，其中誰後來完成了購買」）。
 */
function buildRowsForCartIds(db, storeId, cartIds, { includePurchased = true } = {}) {
  if (!cartIds.length) return [];
  const nowMs = Date.now();
  const activityMap = getActivityMap(db, storeId, cartIds);
  const purchasedSet = getPurchasedCartIdSet(db, storeId, cartIds);
  const snapshotMap = getLatestSnapshotMap(db, storeId, cartIds);
  const firstAddMap = getFirstAddToCartMap(db, storeId, cartIds);
  const firstTouchMap = getFirstTouchMap(db, storeId, cartIds);
  const lastEventMap = getLastEventMap(db, storeId, cartIds);

  const cartIdsNeedingLegacy = cartIds.filter((id) => !snapshotMap[id]);
  const legacyItemsMap = getLegacyCartItemsMap(db, storeId, cartIdsNeedingLegacy);
  const legacyProductIds = [...new Set(Object.values(legacyItemsMap).flat().map((i) => i.product_id))];
  const productsInfoMap = getProductsInfoMap(db, storeId, legacyProductIds);

  const lineUserIds = [...new Set(
    Object.values(firstTouchMap)
      .filter((r) => r.identity_type === 'line_user_id')
      .map((r) => (r.identity_key || '').replace('line_user:', ''))
  )];
  const memberNameMap = getMemberDisplayNameMap(db, storeId, lineUserIds);
  // fix31-r3：好友狀態只在 Drill Down 這條路徑上附加（前端「LINE好友狀態」篩選/
  // 顯示用），刻意不放進 utils/cartSnapshot.js 共用的列組裝函式裡——那個函式同時
  // 被 Boss Dashboard 既有的 /api/analytics/cart-abandonment 使用，本輪不得改變
  // 該既有 API 的回應欄位形狀。
  const friendStatusMap = getMemberFriendStatusMap(db, storeId, lineUserIds);

  const ctx = { purchasedSet, snapshotMap, firstAddMap, firstTouchMap, lastEventMap, legacyItemsMap, productsInfoMap, memberNameMap, nowMs };

  return cartIds
    .map((id) => {
      const c = activityMap[id];
      if (!c) return null; // 理論上不會發生（cartIds 就是從同一張表查出來的），保守處理
      const row = buildRowFromCandidate(c, ctx, { includePurchased });
      if (row && row.identity_type === 'line' && row._line_uid_raw) {
        row.friend_status = friendStatusMap[row._line_uid_raw] || 'unknown';
      } else if (row) {
        row.friend_status = null; // 匿名訪客沒有好友關係可言，明確回傳 null，不是 'unknown'
      }
      return row;
    })
    .filter(Boolean);
}

function _applyAmountFilter(rows, filters) {
  let out = rows;
  if (filters.min_amount !== undefined) out = out.filter((r) => Number(r.total || 0) >= filters.min_amount);
  if (filters.max_amount !== undefined) out = out.filter((r) => Number(r.total || 0) <= filters.max_amount);
  return out;
}

// fix31-r3：統一套用所有「衍生欄位」篩選（金額範圍 + 購物車狀態 + 身份狀態 +
// LINE好友狀態 + 未活動時間分桶）。這些欄位都是 buildRowFromCandidate() 組好列
// 之後才存在，所以一律在應用層篩選，不是 SQL WHERE。
function _applyPostBuildFilters(rows, filters) {
  let out = _applyAmountFilter(rows, filters);
  if (filters.cart_status) out = out.filter((r) => r.status === filters.cart_status);
  if (filters.identity_state) out = out.filter((r) => r.identity_type === filters.identity_state);
  if (filters.friend_status) out = out.filter((r) => r.friend_status === filters.friend_status);
  if (filters.age_bucket) {
    const bucketName = AGE_BUCKET_QUERY_MAP[filters.age_bucket];
    out = out.filter((r) => r.age_seconds !== null && r.age_seconds !== undefined && ageBucketOf(r.age_seconds) === bucketName);
  }
  return out;
}

function _applySort(rows, sortBy, sortDir) {
  const field = SORT_FIELD_MAP[sortBy] || DEFAULT_SORT_FIELD;
  const dir = SORT_DIRECTIONS.has(sortDir) ? sortDir : 'desc';
  const mul = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = a[field], bv = b[field];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' || typeof bv === 'number') return (Number(av) - Number(bv)) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

/**
 * Drill Down 主入口。
 * @param {object} filters 見 findMatchingCartIds 註解，加上 min_amount/max_amount/product_id
 * @param {object} opts { page, limit, include_purchased, sort_by, sort_dir }
 */
function getDrilldownRows(db, storeId, rawFilters = {}, opts = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(opts.limit) || 20)));
  const safePage = Math.max(1, Math.trunc(Number(opts.page) || 1));
  const includePurchased = opts.include_purchased !== false;
  const filters = _sanitizeFilters(rawFilters);
  const warnings = [];

  const { ids: cartIds, truncated } = findMatchingCartIds(db, storeId, filters);
  const visitorCount = countMatchingVisitors(db, storeId, filters);
  if (truncated) warnings.push(`候選購物車數量超過上限（${MAX_CANDIDATE_CARTS}），結果可能不完整，建議縮小日期範圍或加上更多篩選條件。`);

  const generatedAt = new Date().toISOString();

  if (!cartIds.length) {
    return { rows: [], total: 0, page: safePage, limit: safeLimit, visitor_count: visitorCount, filters, warnings, generated_at: generatedAt };
  }

  let rows = buildRowsForCartIds(db, storeId, cartIds, { includePurchased });
  rows = _applyPostBuildFilters(rows, filters);
  rows = _applySort(rows, opts.sort_by, opts.sort_dir);

  const total = rows.length;
  const start = (safePage - 1) * safeLimit;
  const pageRows = rows.slice(start, start + safeLimit).map((r) => {
    const { _age_bucket, _line_uid_raw, _visitor_id_raw, ...pub } = r;
    return pub;
  });

  return {
    rows: pageRows,
    total,
    page: safePage,
    limit: safeLimit,
    total_pages: Math.max(1, Math.ceil(total / safeLimit)),
    visitor_count: visitorCount,
    filters,
    warnings,
    generated_at: generatedAt,
  };
}

/**
 * 快速計數版（不組完整列，供 CRM 動態分群列表/預覽即時顯示人數用，避免每次
 * 列出分群清單就要組出所有欄位）。仍然重用 findMatchingCartIds 同一套篩選，
 * 只是省略批次 hydrate 的成本。
 */
function countDrilldownMatches(db, storeId, rawFilters = {}) {
  const filters = _sanitizeFilters(rawFilters);
  // 衍生欄位（金額範圍／購物車狀態／身份狀態／好友狀態／未活動時間）都無法在
  // SQL 層套用，快速計數版遇到這些條件時改用完整版計數（次數少，接受這個代價）。
  const needsFullHydrate = filters.min_amount !== undefined || filters.max_amount !== undefined
    || filters.cart_status !== undefined || filters.identity_state !== undefined
    || filters.friend_status !== undefined || filters.age_bucket !== undefined;
  if (needsFullHydrate) {
    const { ids } = findMatchingCartIds(db, storeId, filters);
    const rows = _applyPostBuildFilters(buildRowsForCartIds(db, storeId, ids, { includePurchased: true }), filters);
    return rows.length;
  }
  const { ids } = findMatchingCartIds(db, storeId, filters);
  return ids.length;
}

/**
 * 供 CRM 靜態名單快照使用：回傳未去識別化的 member_key 清單（line_user_id 優先，
 * 否則用真實 visitor_id——不可用顯示用短碼，短碼無法反查回真正的訪客）。
 * 不分頁、不截斷內部欄位。呼叫端（routes/crm.js）負責寫入 crm_segment_members，
 * 本函式本身不寫入資料庫。
 */
function resolveMemberKeys(db, storeId, rawFilters = {}, { limit = 2000 } = {}) {
  const filters = _sanitizeFilters(rawFilters);
  const { ids: cartIds } = findMatchingCartIds(db, storeId, filters);
  if (!cartIds.length) return [];
  let rows = buildRowsForCartIds(db, storeId, cartIds, { includePurchased: true });
  rows = _applyPostBuildFilters(rows, filters);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const isLine = r.identity_type === 'line';
    // fix31-r2：修正——原本用 visitor_id_short（顯示用短碼，例如「ab12…f9」）
    // 當 member_key，之後完全無法反查回真正的訪客。改用 _visitor_id_raw
    // （真實 visitor_id），查無 visitor_id 時才退回 cart_id 本身。
    const key = isLine ? r._line_uid_raw : (r._visitor_id_raw || r.cart_id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      member_key: key,
      member_type: isLine ? 'line_user_id' : 'visitor_id',
      display_name: r.display_name || null,
      total: r.total,
      last_activity_at: r.last_activity_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  DIMENSION_COLUMN_MAP,
  SORT_FIELD_MAP,
  CART_STATUS_VALUES,
  IDENTITY_STATE_VALUES,
  FRIEND_STATUS_VALUES,
  findMatchingCartIds,
  countMatchingVisitors,
  countDrilldownMatches,
  buildRowsForCartIds,
  getDrilldownRows,
  resolveMemberKeys,
  MAX_CANDIDATE_CARTS,
};
