// utils/migrationV2.js — R54.4 Migration & Backup V2
//
// 分類備份、選擇性還原、日期篩選的核心引擎。
//
// 設計原則（對應 R54.4-MBV2 需求）：
//   1. 分類只是 UI 分類，實際資料表以 CATEGORY_DEFS 明確列出（依 Reality Audit
//      實際 schema 決定，不從名稱推測）。
//   2. 跨資料庫合併不以自動遞增 ID 為唯一依據：每張表都有業務識別鍵
//      （TABLE_SPECS.key），整數 ID 只在「目標庫沒有被占用」時保留，否則重新配發，
//      並透過 ref map 建立「舊 ID → 新 ID」對照。
//   3. 匯入只使用 raw sql.js prepared statement；正式匯入包在
//      db.runDurableTransaction 內（失敗整批回滾、磁碟原子替換）；預覽在
//      BEGIN … ROLLBACK 內「實際執行一次再撤銷」，資料庫與磁碟皆不變動。
//   4. 任何一列發生 SQL 錯誤：正式匯入整批回滾，不回報成功。
//   5. 匯入歷史異動紀錄（inventory_logs / ingredient_logs）只新增紀錄本身，
//      不扣減、不增加任何現有庫存；既有商品／食材的庫存欄位在合併時一律不改。
//   6. 部分備份（backup_type=partial）永遠不會觸發任何清除。

'use strict';

const crypto = require('crypto');
const { parseStoredUtcTimestamp } = require('./dateTime');

const FORMAT = 'pos_migration';
const SCHEMA_VERSION = 2;
const APP_VERSION = 'R54.4-MBV2';
const TZ = 'Asia/Taipei';
const LEGACY_TYPE = 'pos_migration_backup';   // 舊版完整備份 type（也用於 V2 完整備份，保持 R54.4 舊匯入器可讀）
const PARTIAL_TYPE = 'pos_migration_partial'; // V2 部分備份 type（舊匯入器會因 type 不符拒絕，避免舊版「清空後還原」）

// ══════════════════════════════════════════════════════════════════════════
//  分類定義（UI 分類 → 實際資料表）
// ══════════════════════════════════════════════════════════════════════════
const CATEGORY_DEFS = [
  { key: 'products', label: '商品資料', fileTag: 'products',
    desc: '商品、規格、各通路價格、圖片網址、LINE／預購／限量設定、商品分析群組',
    tables: ['products', 'product_analysis_groups', 'product_analysis_group_items', 'product_analysis_group_aliases'],
    recommends: ['categories'], history: false, dateFilter: false },
  { key: 'categories', label: '商品分類', fileTag: 'categories',
    desc: '商品分類與排序', tables: ['categories'], recommends: [], history: false, dateFilter: false },
  { key: 'orders', label: '訂單紀錄', fileTag: 'orders',
    desc: '訂單主檔（含品項明細快照、付款、退款、折扣快照、外送／取餐／快閃資訊）、訂單操作紀錄、優惠券使用紀錄',
    tables: ['orders', 'order_logs', 'coupon_redemptions'], recommends: ['products', 'discounts'], history: true, dateFilter: true },
  { key: 'ingredients', label: '食材與扣料公式', fileTag: 'ingredients',
    desc: '食材主檔（含目前庫存快照）、商品扣料公式、批號、解凍批次',
    tables: ['ingredients', 'product_ingredient_formulas', 'ingredient_batches', 'ingredient_thaw_batches'],
    recommends: ['products'], history: false, dateFilter: false },
  { key: 'line_preorders', label: 'LINE 預購', fileTag: 'preorders',
    desc: 'LINE 訂單（orders.source=line）與其操作紀錄。商品的預購／限量設定屬「商品資料」，LINE 營業設定屬「系統設定與其他資料」',
    tables: ['orders', 'order_logs', 'coupon_redemptions'], recommends: ['products'], history: true, dateFilter: true },
  { key: 'discounts', label: '折扣活動', fileTag: 'discounts',
    desc: '優惠券、折扣分類、折扣活動', tables: ['coupons', 'discount_categories', 'discount_campaigns'],
    recommends: [], history: false, dateFilter: false },
  { key: 'inventory_movements', label: '庫存異動', fileTag: 'inventory',
    desc: '商品庫存異動紀錄、食材進貨／領料／解凍／報廢／調整紀錄（只匯入歷史紀錄，不會改變目前庫存）',
    tables: ['inventory_logs', 'ingredient_logs'], recommends: ['products', 'ingredients'], history: true, dateFilter: false },
  { key: 'line_members', label: 'LINE 會員', fileTag: 'members',
    desc: 'LINE 會員資料與識別、會員標籤（不含任何 token／secret 欄位）', tables: ['line_members', 'line_member_tags'],
    recommends: [], history: false, dateFilter: false },
  { key: 'member_history', label: '會員歷程', fileTag: 'member_history',
    desc: '會員互動歷程、會員與訂單關聯、好友事件、會員工作階段',
    tables: ['line_member_history', 'line_member_order_links', 'line_friend_events', 'line_member_sessions'],
    recommends: ['line_members'], history: true, dateFilter: false },
  // R54.4／MBV2-HF1-C3：商品想買登記（需求與通知同意分開保存）。匯入只寫資料，不發送任何通知。
  { key: 'product_demand', label: '商品想買登記', fileTag: 'demand',
    desc: '顧客的商品想買登記（期望份數、取餐偏好、有效期限、狀態）與另外記錄的補貨通知同意；匯入不會發送任何通知',
    tables: ['product_demand_requests', 'product_demand_consents'],
    recommends: ['products', 'line_members'], history: false, dateFilter: false },
  // R54.4／MBV2-HF1-C4：LINE 補貨通知紀錄（批次、逐筆受理紀錄與執行狀態）。屬防重歷史：
  // 匯入只合併、不會清除現有紀錄（完整取代也不清除），未完成的工作一律暫停，匯入不發送任何通知。
  { key: 'restock_notify', label: '補貨通知紀錄', fileTag: 'restock_notify',
    desc: '店家手動補貨通知的批次、逐筆 LINE 已受理紀錄（防重依據）與待發送／發送中／待重試／結果不明等執行狀態；匯入後未完成工作一律暫停，不會自動發送',
    tables: ['restock_notify_batches', 'restock_notify_deliveries'],
    recommends: ['product_demand', 'products'], history: true, dateFilter: false },
  { key: 'analytics', label: 'Analytics 事件', fileTag: 'analytics',
    desc: '商品曝光、加購、結帳、轉換等事件，以及訪客地理紀錄', tables: ['analytics_events', 'geo_visit_log'],
    recommends: [], history: true, dateFilter: true },
  { key: 'popup', label: '快閃取餐活動', fileTag: 'popup',
    desc: '取餐地點、活動、場次、場次商品、販售設定、訂單保留量、場次異動紀錄',
    tables: ['popup_locations', 'popup_campaigns', 'popup_sessions', 'popup_session_products', 'popup_session_product_sales', 'popup_order_allocations', 'popup_session_change_logs'],
    recommends: ['products', 'orders'], history: true, dateFilter: false },
  { key: 'settings', label: '系統設定與其他資料', fileTag: 'settings',
    desc: '商店／LINE／付款／GA4 等設定值、外送平台、營業行事曆、付款方式、金流設定（不含 API 金鑰）、POS 顧客、CRM 分群定義',
    tables: ['settings', 'delivery_platforms', 'store_business_calendar', 'payment_methods', 'payment_gateways', 'customers', 'crm_segments'],
    recommends: [], history: false, dateFilter: false, sensitive: true },
];
const CATEGORY_KEYS = CATEGORY_DEFS.map(c => c.key);
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORY_DEFS.map(c => [c.key, c]));

// 明確「不納入」備份的資料表與原因（Reality Audit 結論，供報告與 UI 顯示）
const EXCLUDED_TABLES = {
  stores: '店家帳號主檔（由總控台管理，不屬於單一店家營運資料）',
  super_admins: '總控台帳號',
  licenses: '授權資料（依專案原則不修改 License API）',
  devices: 'Android POS 裝置註冊（依專案原則不修改 Android 相關資料）',
  migration_logs: '搬家操作稽核紀錄（系統紀錄）',
  print_jobs: '暫存列印佇列',
  line_cart_handoff_tokens: '短期購物車交接 token',
  popup_restore_receipts: '短期購物車還原收據 token',
  cart_recovery_jobs: '購物車挽回排程（重新匯入可能造成重複推播）',
  cart_recovery_consents: '購物車挽回同意紀錄（隨排程資料，不重新匯入以免觸發推播）',
  cart_recovery_orchestration_requests: 'n8n 推播請求紀錄（重新匯入可能造成重複推播）',
  crm_actions: 'CRM 推播執行紀錄（重新匯入可能造成重複推播）',
  crm_action_targets: 'CRM 推播對象紀錄（同上）',
  crm_segment_members: 'CRM 分群成員快取（可由分群條件重新計算）',
  ga4_geo_range_stats: 'GA4 API 同步快取（可重新同步）',
  ga4_geo_realtime_snapshots: 'GA4 即時快照快取（可重新同步）',
  ga4_geo_sync_runs: 'GA4 同步執行紀錄',
  geo_live_coordinates: '即時座標暫存',
  geo_coordinate_status_log: '座標狀態暫存紀錄',
};

// 設定值中永遠不匯出、不匯入、不清除的 key
const PROTECTED_SETTING_KEYS = new Set(['pos_password']);

// 敏感欄位（沿用 hotfix26-F0 黑名單）
const SENSITIVE_COLUMN_BLACKLIST = new Set([
  'access_token', 'id_token', 'refresh_token', 'jwt', 'jwt_secret',
  'channel_secret', 'messaging_api_access_token', 'line_pay_secret',
  'line_pay_channel_secret', 'liff_secret', 'oauth_client_secret',
  'client_secret', 'webhook_secret', 'authorization', 'password', 'cookie',
]);
const SENSITIVE_JSON_KEYS = ['token', 'id_token', 'access_token', 'refresh_token', 'authorization',
  'secret', 'channel_secret', 'client_secret', 'password', 'cookie', 'api_key', 'apikey', 'private_key'];
function isSensitiveJsonKey(k) { const s = String(k).toLowerCase(); return SENSITIVE_JSON_KEYS.some(b => s.includes(b)); }
function stripSensitiveDeep(v) {
  if (Array.isArray(v)) return v.map(stripSensitiveDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (!isSensitiveJsonKey(k)) out[k] = stripSensitiveDeep(val); }
    return out;
  }
  return v;
}
function sanitizeJsonString(str) {
  if (str == null || str === '') return str;
  const s = String(str);
  try { return JSON.stringify(stripSensitiveDeep(JSON.parse(s))); }
  catch {
    return s.replace(/("(?:token|id_token|access_token|refresh_token|authorization|secret|channel_secret|client_secret|password|cookie|api_key)"\s*:\s*")[^"]*(")/gi, '$1$2');
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  時間：Asia/Taipei
// ══════════════════════════════════════════════════════════════════════════
const _tpFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function taipeiParts(date) {
  const p = {};
  for (const x of _tpFmt.formatToParts(date)) p[x.type] = x.value;
  return { y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, ss: p.second };
}
function taipeiDateStr(date) { const p = taipeiParts(date); return `${p.y}-${p.m}-${p.d}`; }
function taipeiIsoNow(now = new Date()) {
  const p = taipeiParts(now); return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}:${p.ss}+08:00`;
}
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidYmd(s) {
  if (!YMD_RE.test(String(s || ''))) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function dowOf(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

class MigrationError extends Error {
  constructor(code, message, status = 400, extra) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

// spec: { preset, month, start, end }；回傳 null（全部）或 { preset, start, end, timezone }
const DATE_PRESETS = ['all', 'today', 'yesterday', 'this_week', 'this_month', 'last_month', 'month', 'custom'];
function resolveDateRange(spec, now = new Date()) {
  if (!spec || typeof spec !== 'object') return null;
  const preset = String(spec.preset || 'all');
  if (!DATE_PRESETS.includes(preset)) throw new MigrationError('INVALID_DATE_RANGE', `不支援的日期選項：${preset}`);
  if (preset === 'all') return null;
  const today = taipeiDateStr(now);
  let start, end;
  if (preset === 'today') { start = end = today; }
  else if (preset === 'yesterday') { start = end = addDays(today, -1); }
  else if (preset === 'this_week') { // 週一為一週開始（台灣慣例），到今天為止
    const dow = dowOf(today); const back = (dow + 6) % 7; start = addDays(today, -back); end = today;
  } else if (preset === 'this_month') { start = today.slice(0, 8) + '01'; end = today; }
  else if (preset === 'last_month') {
    let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1; if (m === 0) { m = 12; y -= 1; }
    const mm = String(m).padStart(2, '0'); start = `${y}-${mm}-01`; end = `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`;
  } else if (preset === 'month') {
    const mon = String(spec.month || '');
    if (!/^\d{4}-\d{2}$/.test(mon)) throw new MigrationError('INVALID_DATE_RANGE', '指定月份格式錯誤（需為 YYYY-MM）');
    const y = Number(mon.slice(0, 4)), m = Number(mon.slice(5, 7));
    if (m < 1 || m > 12 || y < 2000 || y > 2100) throw new MigrationError('INVALID_DATE_RANGE', '指定月份不存在');
    start = `${mon}-01`; end = `${mon}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`;
  } else { // custom
    start = String(spec.start || ''); end = String(spec.end || '');
    if (!isValidYmd(start) || !isValidYmd(end)) throw new MigrationError('INVALID_DATE_RANGE', '自訂日期需為有效的 YYYY-MM-DD');
    if (start > end) throw new MigrationError('INVALID_DATE_RANGE', '開始日期不可晚於結束日期');
  }
  return { preset, start, end, timezone: TZ, ...(preset === 'month' ? { month: spec.month } : {}) };
}

// 訂單 created_at 的台北日曆日。
//  - 帶 Z／offset：轉成台北日期。
//  - naive 'YYYY-MM-DD HH:MM:SS'：本專案訂單以台北當地時間寫入（twNow()/POPUP nowStr），
//    與「訂單紀錄」頁 DATE(created_at) 的判定一致，直接取前 10 碼。
const HAS_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/;
function orderTaipeiDate(createdAt) {
  if (createdAt == null || createdAt === '') return null;
  const s = String(createdAt).trim();
  if (HAS_TZ_RE.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : taipeiDateStr(d); }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
// analytics_events.created_at / geo_visit_log.event_time：資料庫以 UTC 儲存（dateTime.js 契約）
function utcStoredTaipeiDate(v) {
  const d = parseStoredUtcTimestamp(v);
  return d ? taipeiDateStr(d) : null;
}
function inRange(ymd, range) { return !range || (ymd != null && ymd >= range.start && ymd <= range.end); }

// ══════════════════════════════════════════════════════════════════════════
//  共用 DB helpers（只用 raw sql.js 物件，可在交易內安全使用）
// ══════════════════════════════════════════════════════════════════════════
function rawAll(raw, sql, params) {
  const st = raw.prepare(sql);
  try { if (params && params.length) st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); return rows; }
  finally { st.free(); }
}
function rawGet(raw, sql, params) {
  const st = raw.prepare(sql);
  try { if (params && params.length) st.bind(params); return st.step() ? st.getAsObject() : null; }
  finally { st.free(); }
}
function rawEach(raw, sql, params, fn) {
  const st = raw.prepare(sql);
  try { if (params && params.length) st.bind(params); while (st.step()) fn(st.getAsObject()); }
  finally { st.free(); }
}
function tableExists(raw, t) { return !!rawGet(raw, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]); }
function tableInfo(raw, t) {
  try { return rawAll(raw, `PRAGMA table_info(${t})`); } catch { return []; }
}
function chunked(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function isEmptyVal(v) { return v === null || v === undefined || v === ''; }
function looseEqual(a, b) {
  if (a === b) return true;
  if (isEmptyVal(a) && isEmptyVal(b)) return true;
  if (isEmptyVal(a) || isEmptyVal(b)) return false;
  const na = Number(a), nb = Number(b);
  if (typeof a !== 'object' && typeof b !== 'object' && String(a).trim() !== '' && String(b).trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}
function s(v) { return v == null ? '' : String(v); }

// 討論用：舊版搬家流程會在匯入時建立的兩張表（R54.4 schema 由路由 lazy 建立）
function ensureLazyTables(raw) {
  raw.run(`CREATE TABLE IF NOT EXISTS discount_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL DEFAULT 'store_001',
      code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#94a3b8', enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_discount_categories_store ON discount_categories(store_id)`);
  raw.run(`CREATE TABLE IF NOT EXISTS discount_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL DEFAULT 'store_001',
      name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_discount_campaigns_store ON discount_campaigns(store_id)`);
}

// ══════════════════════════════════════════════════════════════════════════
//  資料表範圍（scope）：哪些列屬於某店家
// ══════════════════════════════════════════════════════════════════════════
// 沒有 store_id 的四張表透過所屬商品／食材判定店家
const SCOPE_SQL = {
  product_ingredient_formulas: 'product_id IN (SELECT id FROM products WHERE store_id=?)',
  ingredient_batches: 'ingredient_id IN (SELECT id FROM ingredients WHERE store_id=?)',
  ingredient_thaw_batches: 'ingredient_id IN (SELECT id FROM ingredients WHERE store_id=?)',
  ingredient_logs: 'ingredient_id IN (SELECT id FROM ingredients WHERE store_id=?)',
};
function scopeWhere(table) { return SCOPE_SQL[table] || 'store_id=?'; }
function countScoped(raw, table, storeId) {
  if (!tableExists(raw, table)) return 0;
  const r = rawGet(raw, `SELECT COUNT(*) AS c FROM ${table} WHERE ${scopeWhere(table)}`, [storeId]);
  return r ? Number(r.c) || 0 : 0;
}

// ══════════════════════════════════════════════════════════════════════════
//  匯出
// ══════════════════════════════════════════════════════════════════════════
function normalizeCategories(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',');
  const out = [];
  for (const k of arr.map(x => String(x).trim()).filter(Boolean)) {
    if (!CATEGORY_BY_KEY[k]) throw new MigrationError('UNKNOWN_CATEGORY', `未知的資料分類：${k}`);
    if (!out.includes(k)) out.push(k);
  }
  return CATEGORY_KEYS.filter(k => out.includes(k)); // 固定順序
}

// 依選擇分類，產生「每張表要匯出的列」的 iterator 描述。
// 回傳 { tables: { name: { rows: [...] } }, counts, refs }，rows 為已清洗的物件。
// onRow(table, rowObj) 版本供串流使用。
function collectExport(raw, storeId, categories, filters, onRow) {
  const sel = new Set(categories);
  const tableCounts = {};
  const emit = (t, row) => { tableCounts[t] = (tableCounts[t] || 0) + 1; onRow(t, row); };
  const ensure = (t) => { if (!(t in tableCounts)) tableCounts[t] = 0; };
  const has = (t) => tableExists(raw, t);
  const notes = [];

  const simple = (t, where, params, order, mapRow) => {
    ensure(t);
    if (!has(t)) return;
    rawEach(raw, `SELECT * FROM ${t} WHERE ${where}${order ? ' ORDER BY ' + order : ''}`, params, (r) => {
      const out = mapRow ? mapRow(r) : r;
      if (out) emit(t, out);
    });
  };

  if (sel.has('categories')) simple('categories', 'store_id=?', [storeId], 'sort_order ASC, id ASC');
  if (sel.has('products')) {
    simple('products', 'store_id=?', [storeId], 'sort_order ASC, id ASC');
    simple('product_analysis_groups', 'store_id=?', [storeId], 'sort_order ASC, id ASC');
    simple('product_analysis_group_items', 'store_id=?', [storeId], 'group_id ASC, id ASC');
    simple('product_analysis_group_aliases', 'store_id=?', [storeId], 'group_id ASC, id ASC');
  }
  if (sel.has('ingredients')) {
    simple('ingredients', 'store_id=?', [storeId], 'id ASC');
    simple('product_ingredient_formulas', scopeWhere('product_ingredient_formulas'), [storeId], 'id ASC');
    simple('ingredient_batches', scopeWhere('ingredient_batches'), [storeId], 'id ASC');
    simple('ingredient_thaw_batches', scopeWhere('ingredient_thaw_batches'), [storeId], 'id ASC');
  }
  if (sel.has('discounts')) {
    simple('coupons', 'store_id=?', [storeId], 'id ASC');
    simple('discount_categories', 'store_id=?', [storeId], 'sort_order ASC, id ASC');
    simple('discount_campaigns', 'store_id=?', [storeId], 'sort_order ASC, id ASC');
  }
  if (sel.has('popup')) {
    for (const t of ['popup_locations', 'popup_campaigns', 'popup_sessions', 'popup_session_products',
      'popup_session_product_sales', 'popup_order_allocations', 'popup_session_change_logs']) {
      simple(t, 'store_id=?', [storeId], t === 'popup_order_allocations' || t === 'popup_session_change_logs' ? 'id ASC' : 'created_at ASC, id ASC');
    }
  }

  // ── 訂單（orders / line_preorders 共用；日期篩選以訂單建立時間的台北日曆日判定）──
  if (sel.has('orders') || sel.has('line_preorders')) {
    const fOrders = sel.has('orders') ? (filters.orders || null) : undefined;
    const fPre = sel.has('line_preorders') ? (filters.line_preorders || null) : undefined;
    const ids = new Set(), nums = new Set();
    let noDate = 0;
    ensure('orders'); ensure('order_logs'); ensure('coupon_redemptions');
    if (has('orders')) {
      rawEach(raw, 'SELECT * FROM orders WHERE store_id=? ORDER BY created_at ASC, id ASC', [storeId], (o) => {
        const ymd = orderTaipeiDate(o.created_at);
        let include = false;
        if (fOrders !== undefined && inRange(ymd, fOrders)) include = true;
        if (!include && fPre !== undefined && o.source === 'line' && inRange(ymd, fPre)) include = true;
        if (!include) { if (ymd == null) noDate++; return; }
        if (o.id != null) ids.add(String(o.id));
        if (o.order_number) nums.add(String(o.order_number));
        emit('orders', o);
      });
    }
    if (noDate) notes.push(`有 ${noDate} 筆訂單沒有可辨識的建立時間，未納入日期範圍匯出`);
    const fullOrderSet = sel.has('orders') && !filters.orders; // 全部訂單 → 全部操作紀錄／使用紀錄
    if (has('order_logs')) {
      rawEach(raw, 'SELECT * FROM order_logs WHERE store_id=? ORDER BY id ASC', [storeId], (l) => {
        if (fullOrderSet || ids.has(String(l.order_id)) || nums.has(String(l.order_id)) || nums.has(String(l.order_number))) emit('order_logs', l);
      });
    }
    if (has('coupon_redemptions')) {
      rawEach(raw, 'SELECT * FROM coupon_redemptions WHERE store_id=? ORDER BY id ASC', [storeId], (r) => {
        if (fullOrderSet || ids.has(String(r.order_id)) || nums.has(String(r.order_id)) || nums.has(String(r.order_number))) emit('coupon_redemptions', r);
      });
    }
  }

  if (sel.has('inventory_movements')) {
    simple('inventory_logs', 'store_id=?', [storeId], 'id ASC');
    simple('ingredient_logs', scopeWhere('ingredient_logs'), [storeId], 'id ASC');
  }
  if (sel.has('line_members')) {
    const safe = has('line_members') ? tableInfo(raw, 'line_members').map(c => c.name).filter(c => !SENSITIVE_COLUMN_BLACKLIST.has(c.toLowerCase())) : [];
    simple('line_members', 'store_id=?', [storeId], 'id ASC', (r) => { const o = {}; for (const c of safe) o[c] = r[c]; return o; });
    simple('line_member_tags', 'store_id=?', [storeId], 'id ASC');
  }
  if (sel.has('member_history')) {
    simple('line_member_history', 'store_id=?', [storeId], 'id ASC', (r) => (r.metadata_json ? { ...r, metadata_json: sanitizeJsonString(r.metadata_json) } : r));
    simple('line_member_order_links', 'store_id=?', [storeId], 'id ASC');
    simple('line_friend_events', 'store_id=?', [storeId], 'id ASC', (r) => (r.metadata_json ? { ...r, metadata_json: sanitizeJsonString(r.metadata_json) } : r));
    simple('line_member_sessions', 'store_id=?', [storeId], 'id ASC');
  }
  if (sel.has('product_demand')) {
    simple('product_demand_requests', 'store_id=?', [storeId], 'id ASC');
    simple('product_demand_consents', 'store_id=?', [storeId], 'id ASC');
  }
  if (sel.has('restock_notify')) {
    simple('restock_notify_batches', 'store_id=?', [storeId], 'id ASC');
    simple('restock_notify_deliveries', 'store_id=?', [storeId], 'id ASC');
  }
  if (sel.has('analytics')) {
    const f = filters.analytics || null;
    simple('analytics_events', 'store_id=?', [storeId], 'id ASC', (r) => {
      if (f && !inRange(utcStoredTaipeiDate(r.created_at), f)) return null;
      const o = { ...r };
      if (o.metadata_json) o.metadata_json = sanitizeJsonString(o.metadata_json);
      if (o.properties_json) o.properties_json = sanitizeJsonString(o.properties_json);
      return o;
    });
    simple('geo_visit_log', 'store_id=?', [storeId], 'id ASC', (r) => {
      if (f && !inRange(utcStoredTaipeiDate(r.event_time || r.created_at), f)) return null;
      return r;
    });
  }
  if (sel.has('settings')) {
    simple('settings', 'store_id=?', [storeId], 'key ASC', (r) => (PROTECTED_SETTING_KEYS.has(r.key) ? null : r));
    simple('delivery_platforms', 'store_id=?', [storeId], 'id ASC');
    simple('store_business_calendar', 'store_id=?', [storeId], 'id ASC');
    simple('payment_methods', 'store_id=?', [storeId], 'id ASC');
    simple('payment_gateways', 'store_id=?', [storeId], 'id ASC', (r) => ({
      ...r, api_key: '', secret_key: '', extra_config: r.extra_config ? sanitizeJsonString(r.extra_config) : r.extra_config,
    }));
    simple('customers', 'store_id=?', [storeId], 'id ASC');
    simple('crm_segments', 'store_id=?', [storeId], 'id ASC');
  }
  return { tableCounts, notes };
}

// 對照表（每份備份都附上，體積很小）：讓匯入端能用名稱／代碼重新對應整數 ID
function buildRefMaps(raw, storeId) {
  const refs = { products: {}, categories: {}, ingredients: {}, coupons: {}, line_members: {}, analysis_groups: {} };
  const grab = (t, sql, fn) => { if (tableExists(raw, t)) rawEach(raw, sql, [storeId], fn); };
  grab('products', 'SELECT id,name,product_barcode FROM products WHERE store_id=?', r => { refs.products[r.id] = { name: r.name, barcode: r.product_barcode || '' }; });
  grab('categories', 'SELECT id,name FROM categories WHERE store_id=?', r => { refs.categories[r.id] = r.name; });
  grab('ingredients', 'SELECT id,name FROM ingredients WHERE store_id=?', r => { refs.ingredients[r.id] = r.name; });
  grab('coupons', 'SELECT id,code FROM coupons WHERE store_id=?', r => { refs.coupons[r.id] = r.code; });
  grab('line_members', 'SELECT id,line_user_id FROM line_members WHERE store_id=?', r => { refs.line_members[r.id] = r.line_user_id; });
  grab('product_analysis_groups', 'SELECT id,group_name FROM product_analysis_groups WHERE store_id=?', r => { refs.analysis_groups[r.id] = r.group_name; });
  return refs;
}

function exportFileName(storeId, categories, filters, backupType, now = new Date()) {
  const date = taipeiDateStr(now).replace(/-/g, '');
  const safeStore = String(storeId).replace(/[^A-Za-z0-9_-]/g, '_');
  if (backupType === 'full') return `pos_backup_${safeStore}_full_${date}.json`;
  if (categories.length === 1) {
    const def = CATEGORY_BY_KEY[categories[0]];
    const f = filters[categories[0]];
    if (f && f.start && f.end) return `pos_backup_${safeStore}_${def.fileTag}_${f.start.replace(/-/g, '')}_${f.end.replace(/-/g, '')}.json`;
    return `pos_backup_${safeStore}_${def.fileTag}_${date}.json`;
  }
  return `pos_backup_${safeStore}_selected_${date}.json`;
}

// 產生完整備份 JSON 的字串片段（同步、一致快照）。回傳 { header, chunks, fileName }
// chunks 依序串接即為完整檔案內容；每列各自 JSON.stringify，避免先建立整份物件再序列化。
function buildExportChunks(db, storeId, opts) {
  const raw = db._db;
  const categories = normalizeCategories(opts.categories);
  if (!categories.length) throw new MigrationError('EMPTY_SELECTION', '請至少選擇一個資料分類');
  const filters = {};
  for (const fk of ['orders', 'line_preorders', 'analytics']) {
    if (categories.includes(fk) && opts.filters && opts.filters[fk]) {
      const r = resolveDateRange(opts.filters[fk], opts.now);
      if (r) filters[fk] = r;
    }
  }
  // 完整備份＝全部分類且沒有任何日期篩選；其他一律標記為部分備份
  const backupType = categories.length === CATEGORY_KEYS.length && Object.keys(filters).length === 0 ? 'full' : 'partial';
  const store = tableExists(raw, 'stores') ? rawGet(raw, 'SELECT store_id, store_name FROM stores WHERE store_id=?', [storeId]) : null;
  const now = opts.now || new Date();

  const perTable = {}; // table -> array of row JSON strings
  const { tableCounts, notes } = collectExport(raw, storeId, categories, filters, (t, row) => {
    (perTable[t] || (perTable[t] = [])).push(JSON.stringify(row));
  });
  for (const t of Object.keys(tableCounts)) if (!perTable[t]) perTable[t] = [];

  const counts = {};
  for (const k of categories) {
    counts[k] = {};
    // orders 與 line_preorders 共用 orders 系列表，筆數以實際匯出（聯集）為準
    for (const t of CATEGORY_BY_KEY[k].tables) counts[k][t] = tableCounts[t] || 0;
  }
  const header = {
    format: FORMAT,
    schema_version: SCHEMA_VERSION,
    type: backupType === 'full' ? LEGACY_TYPE : PARTIAL_TYPE,
    app_version: APP_VERSION,
    version: APP_VERSION,           // 舊版匯入器顯示用
    migration_version: 'MBV2',
    backup_type: backupType,
    source_store_id: storeId,
    store_id: storeId,              // 舊版匯入器相容欄位
    store_name: store ? (store.store_name || storeId) : storeId,
    exported_at: taipeiIsoNow(now),
    exported_at_utc: now.toISOString(),
    timezone: TZ,
    selected_categories: categories,
    filters,
    counts,
    table_counts: tableCounts,
    ref_maps: buildRefMaps(raw, storeId),
    notes,
  };
  const chunks = [];
  const headStr = JSON.stringify(header);
  chunks.push(headStr.slice(0, -1) + ',"data":{');
  const tables = Object.keys(perTable);
  tables.forEach((t, ti) => {
    chunks.push((ti ? ',' : '') + JSON.stringify(t) + ':[');
    const rows = perTable[t];
    for (let i = 0; i < rows.length; i += 2000) chunks.push((i ? ',' : '') + rows.slice(i, i + 2000).join(','));
    chunks.push(']');
    perTable[t] = null;
  });
  if (backupType === 'full') {
    // 舊版匯入器相容：analytics_meta
    let trackingStartDate = '';
    try { ({ TRACKING_START_DATE: trackingStartDate } = require('./dashboardDate')); } catch {}
    chunks.push((tables.length ? ',' : '') + '"analytics_meta":' + JSON.stringify({ tracking_start_date: trackingStartDate || '', tracking_enabled: true, analytics_schema_version: 1 }));
  }
  chunks.push('}}');
  return { header, chunks, fileName: exportFileName(storeId, categories, filters, backupType, now), backupType, categories, filters };
}

// R54.4／MBV2-HF1-C4：補貨通知相關分類在預覽中分開顯示三種內容
//   需求與同意歷史／批次及已受理紀錄／待發送、發送中、待重試、結果不明等執行狀態
function categoryBreakdown(raw, storeId, key) {
  const c = (sql) => { try { const r = rawGet(raw, sql, [storeId]); return r ? Number(r.c) || 0 : 0; } catch { return 0; } };
  if (key === 'product_demand' && tableExists(raw, 'product_demand_requests')) {
    return {
      kind: 'demand_consent_history',
      requests: c('SELECT COUNT(*) AS c FROM product_demand_requests WHERE store_id=?'),
      active_requests: c("SELECT COUNT(*) AS c FROM product_demand_requests WHERE store_id=? AND status='active' AND expires_at > datetime('now')"),
      consents: tableExists(raw, 'product_demand_consents') ? c('SELECT COUNT(*) AS c FROM product_demand_consents WHERE store_id=?') : 0,
      granted_consents: tableExists(raw, 'product_demand_consents') ? c("SELECT COUNT(*) AS c FROM product_demand_consents WHERE store_id=? AND status='granted'") : 0,
      note: '匯入的通知同意只保留歷史；在本環境重新發送前，須由顧客重新確認',
    };
  }
  if (key === 'restock_notify' && tableExists(raw, 'restock_notify_batches') && tableExists(raw, 'restock_notify_deliveries')) {
    return {
      kind: 'restock_notify_history',
      batches: c('SELECT COUNT(*) AS c FROM restock_notify_batches WHERE store_id=?'),
      accepted_records: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='accepted'"),
      dedupe_claims: c('SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND claim=1'),
      execution_states: {
        pending: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='pending'"),
        sending: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='sending'"),
        retry_wait: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='retry_wait'"),
        held: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='held'"),
        unknown: c("SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE store_id=? AND status='unknown'"),
      },
      note: '匯入只合併不清除；未完成的工作匯入後一律暫停，不會自動發送',
    };
  }
  return null;
}

// 匯出前預覽：每個分類的筆數、依實際資料抽樣估算的大小、是否含圖片／歷史、建議一起匯出的分類
function exportPreview(db, storeId, opts = {}) {
  const raw = db._db;
  const filters = {};
  for (const k of ['orders', 'line_preorders', 'analytics']) {
    if (opts.filters && opts.filters[k]) { const r = resolveDateRange(opts.filters[k], opts.now); if (r) filters[k] = r; }
  }
  const out = [];
  for (const def of CATEGORY_DEFS) {
    const tables = [];
    let totalRows = 0, estBytes = 0, estimable = true;
    const single = {};
    // 單一分類各自計算（日期篩選只套用該分類自己的篩選）
    const catFilters = filters[def.key] ? { [def.key]: filters[def.key] } : {};
    const sample = {}; // table -> {n, bytes}
    try {
      const { tableCounts } = collectExport(raw, storeId, [def.key], catFilters, (t, row) => {
        const smp = sample[t] || (sample[t] = { n: 0, bytes: 0 });
        if (smp.n < 300) { smp.n++; smp.bytes += Buffer.byteLength(JSON.stringify(row)); }
      });
      Object.assign(single, tableCounts);
    } catch (e) { estimable = false; }
    for (const t of def.tables) {
      const c = single[t] || 0;
      const smp = sample[t];
      const est = c === 0 ? 0 : (smp && smp.n ? Math.round(smp.bytes / smp.n * c) : null);
      if (est == null) estimable = false; else estBytes += est;
      totalRows += c;
      tables.push({ table: t, rows: c, estimated_bytes: est, exists: tableExists(raw, t) });
    }
    let images = { has_image_urls: false, inline_images: 0 };
    if (def.key === 'products' && tableExists(raw, 'products')) {
      const r = rawGet(raw, `SELECT
          SUM(CASE WHEN COALESCE(image,'')<>'' OR COALESCE(line_image_url,'')<>'' OR COALESCE(shipping_image_url,'')<>'' THEN 1 ELSE 0 END) AS withimg,
          SUM(CASE WHEN image LIKE 'data:%' OR line_image_url LIKE 'data:%' OR shipping_image_url LIKE 'data:%' THEN 1 ELSE 0 END) AS inline
        FROM products WHERE store_id=?`, [storeId]);
      images = { has_image_urls: !!(r && r.withimg), inline_images: (r && r.inline) || 0, with_image_count: (r && r.withimg) || 0 };
    }
    out.push({
      key: def.key, label: def.label, desc: def.desc, tables,
      breakdown: categoryBreakdown(raw, storeId, def.key),
      rows: totalRows,
      estimated_bytes: estimable ? estBytes : null,
      includes_images: def.key === 'products' ? images : null,
      includes_history: !!def.history,
      date_filter_supported: !!def.dateFilter,
      date_filter: filters[def.key] || null,
      recommends: def.recommends,
      sensitive: !!def.sensitive,
    });
  }
  return { categories: out, excluded_tables: EXCLUDED_TABLES, timezone: TZ };
}

// ══════════════════════════════════════════════════════════════════════════
//  備份檔解析（V2 / 舊版）
// ══════════════════════════════════════════════════════════════════════════
const LEGACY_TABLE_TO_CATEGORY = {
  products: 'products', product_analysis_groups: 'products', product_analysis_group_items: 'products', product_analysis_group_aliases: 'products',
  categories: 'categories',
  orders: 'orders', order_logs: 'orders',
  ingredients: 'ingredients', product_ingredient_formulas: 'ingredients', ingredient_batches: 'ingredients', ingredient_thaw_batches: 'ingredients',
  ingredient_logs: 'inventory_movements', inventory_logs: 'inventory_movements',
  discount_categories: 'discounts', discount_campaigns: 'discounts',
  settings: 'settings', delivery_platforms: 'settings',
  analytics_events: 'analytics',
  line_members: 'line_members',
  line_member_history: 'member_history',
};
const LEGACY_IGNORED_KEYS = new Set(['line_products', 'inventory', 'delivery_fees', 'analytics_meta', 'preorder_order_numbers', 'order_items']);
const ALL_V2_TABLES = new Set(CATEGORY_DEFS.flatMap(c => c.tables));

// 迭代式（非遞迴）原型污染檢查
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function containsDangerousKeys(root) {
  const stack = [root];
  let guard = 0;
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (++guard > 50_000_000) return true;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const x = v[i]; if (x !== null && typeof x === 'object') stack.push(x); } continue; }
    for (const k of Object.keys(v)) {
      if (DANGEROUS_KEYS.has(k)) return true;
      const x = v[k]; if (x !== null && typeof x === 'object') stack.push(x);
    }
  }
  return false;
}

// 解析並驗證備份檔頭。回傳 normalized 描述，不修改 payload。
function inspectPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MigrationError('INVALID_BACKUP', '不是有效的備份檔（內容不是 JSON 物件）');
  if (containsDangerousKeys(payload)) throw new MigrationError('MIGRATION_UNSAFE_PAYLOAD', '備份檔內容含有不允許的欄位名稱（__proto__ / prototype / constructor）');
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MigrationError('MIGRATION_INVALID_DATA', '無效的備份檔：缺少 data 區塊或格式錯誤');
  const warnings = [];
  let kind, backupType, categoriesPresent, schemaVersion;
  if (payload.format === FORMAT) {
    schemaVersion = Number(payload.schema_version);
    if (!Number.isInteger(schemaVersion)) throw new MigrationError('UNKNOWN_SCHEMA_VERSION', '備份檔缺少 schema_version');
    if (schemaVersion > SCHEMA_VERSION) throw new MigrationError('UNSUPPORTED_SCHEMA_VERSION', `備份檔版本 schema_version=${schemaVersion} 比目前系統支援的版本（${SCHEMA_VERSION}）新，請先升級系統再匯入`);
    if (schemaVersion < 2) throw new MigrationError('UNSUPPORTED_SCHEMA_VERSION', `不支援的 schema_version=${schemaVersion}`);
    if (payload.backup_type !== 'full' && payload.backup_type !== 'partial') throw new MigrationError('INVALID_BACKUP', 'backup_type 必須為 full 或 partial');
    if (payload.backup_type === 'full' && payload.type !== LEGACY_TYPE) throw new MigrationError('INVALID_BACKUP', '完整備份的 type 標記不一致');
    if (payload.backup_type === 'partial' && payload.type !== PARTIAL_TYPE) throw new MigrationError('INVALID_BACKUP', '部分備份的 type 標記不一致');
    kind = 'v2'; backupType = payload.backup_type;
    categoriesPresent = normalizeCategories(payload.selected_categories || []);
    // 筆數核對：檔頭 table_counts 必須與實際陣列長度一致（檔案被截斷或被手動修改時可偵測）
    const tc = payload.table_counts || {};
    for (const [t, n] of Object.entries(tc)) {
      const arr = data[t];
      if (!Array.isArray(arr)) { warnings.push({ code: 'TABLE_MISSING', table: t, message: `檔頭記載 ${t} 有 ${n} 筆，但資料區塊沒有此表` }); continue; }
      if (arr.length !== Number(n)) throw new MigrationError('COUNT_MISMATCH', `備份檔內 ${t} 實際 ${arr.length} 筆，與檔頭記載 ${n} 筆不一致（檔案可能不完整或被修改）`);
    }
  } else if (payload.type === LEGACY_TYPE) {
    kind = 'legacy'; backupType = 'full'; schemaVersion = Number(payload.schema_version) || null;
    const cats = new Set();
    for (const k of Object.keys(data)) { if (LEGACY_TABLE_TO_CATEGORY[k] && Array.isArray(data[k])) cats.add(LEGACY_TABLE_TO_CATEGORY[k]); }
    if (Array.isArray(data.orders) && data.orders.some(o => o && o.source === 'line')) cats.add('line_preorders');
    categoriesPresent = CATEGORY_KEYS.filter(k => cats.has(k));
  } else if (payload.type === PARTIAL_TYPE) {
    throw new MigrationError('INVALID_BACKUP', '部分備份檔缺少 format 標記');
  } else {
    throw new MigrationError('INVALID_BACKUP', `無效的備份檔格式（type=${String(payload.type || '').slice(0, 40) || '空白'}）`);
  }
  const tableCounts = {};
  const unknownTables = [];
  for (const [k, v] of Object.entries(data)) {
    if (ALL_V2_TABLES.has(k)) {
      if (!Array.isArray(v)) throw new MigrationError('MIGRATION_INVALID_DATA', `資料表 ${k} 格式錯誤（不是陣列）`);
      tableCounts[k] = v.length;
    } else if (!LEGACY_IGNORED_KEYS.has(k)) unknownTables.push(k);
  }
  if (unknownTables.length) warnings.push({ code: 'UNKNOWN_TABLES', tables: unknownTables, message: `備份檔含有目前系統不認識的資料區塊，將忽略：${unknownTables.join(', ')}` });
  const ordersArr = Array.isArray(data.orders) ? data.orders : [];
  const dates = []; for (const o of ordersArr) { const d = o && orderTaipeiDate(o.created_at); if (d) dates.push(d); }
  dates.sort();
  return {
    kind, backup_type: backupType, schema_version: schemaVersion,
    format: payload.format || null, type: payload.type,
    source_store_id: payload.source_store_id || payload.store_id || '',
    store_name: payload.store_name || '',
    exported_at: payload.exported_at || '',
    app_version: payload.app_version || payload.version || '',
    categories_present: categoriesPresent,
    filters: payload.filters || {},
    table_counts: tableCounts,
    order_date_range: dates.length ? { min: dates[0], max: dates[dates.length - 1] } : null,
    line_order_count: ordersArr.filter(o => o && o.source === 'line').length,
    warnings,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  匯入引擎
// ══════════════════════════════════════════════════════════════════════════
// 各表合併時「不比較、不補值」的欄位（衍生值或目前庫存快照，以現有資料為準）
const IGNORE_COMPARE = {
  _all: ['id', 'store_id', 'updated_at'],
  orders: ['sync_status', 'webhook_sent'],
  products: ['current_stock_grams', 'total_stock_grams', 'allocated_grams', 'line_quota_sold', 'line_preorder_sold', 'category_id', 'line_category_id', 'product_uuid'],
  ingredients: ['total_stock', 'frozen_stock', 'thawing_stock', 'refrigerated_stock', 'scrapped_total'],
  line_members: ['last_seen_at', 'last_login_at', 'order_count', 'total_spent', 'lifetime_value', 'last_order_at', 'last_purchase_at',
    'last_friend_check', 'last_friend_check_at', 'first_product_id', 'merged_into_id', 'is_friend', 'is_blocked', 'friend_status',
    'friend_status_changed_at', 'last_follow_at', 'last_unfollow_at', 'last_refollow_at', 'refollow_count', 'last_friend_source'],
  popup_sessions: ['revision'],
  payment_gateways: ['api_key', 'secret_key', 'extra_config'],
  settings: [],
  crm_segments: ['member_count_cache', 'cache_updated_at'],
  customers: ['total_spent', 'visit_count'],
};

function newStats(table, cat) {
  return { table, category: cat, source: 0, existing_before: 0, added: 0, updated: 0, skipped: 0, duplicate_in_file: 0,
    conflict: 0, missing_relation: 0, invalid: 0, failed: 0, purged: 0, id_remapped: 0, relation_cleared: 0, protected: 0,
    samples: { conflict: [], missing_relation: [], invalid: [], failed: [] } };
}
function pushSample(st, kind, obj) { if (st.samples[kind].length < 5) st.samples[kind].push(obj); }

class ImportContext {
  constructor(db, raw, storeId, payload, info, opts) {
    this.db = db; this.raw = raw; this.storeId = storeId; this.payload = payload; this.info = info;
    this.mode = opts.mode; this.dryRun = !!opts.dryRun; this.categories = opts.categories;
    this.cat = new Set(opts.categories);
    this.data = payload.data || {};
    this.stats = {}; this.cols = {}; this.stmts = new Map();
    this.maps = { product: new Map(), category: new Map(), ingredient: new Map(), group: new Map(), coupon: new Map(),
      member: new Map(), popupLocation: new Map(), popupCampaign: new Map(), popupSession: new Map(), order: new Map() };
    this.refs = this.buildFileRefs();
    this.targetProductIndex = null; this.warnings = [];
    this.genCode = opts.genPublicCode || (() => crypto.randomBytes(16).toString('base64url'));
  }
  buildFileRefs() {
    const r = this.payload.ref_maps || {};
    const refs = { products: { ...(r.products || {}) }, categories: { ...(r.categories || {}) }, ingredients: { ...(r.ingredients || {}) },
      coupons: { ...(r.coupons || {}) }, line_members: { ...(r.line_members || {}) }, analysis_groups: { ...(r.analysis_groups || {}) } };
    for (const p of (this.data.products || [])) if (p && p.id != null && !refs.products[p.id]) refs.products[p.id] = { name: p.name, barcode: p.product_barcode || '' };
    for (const c of (this.data.categories || [])) if (c && c.id != null && !refs.categories[c.id]) refs.categories[c.id] = c.name;
    for (const i of (this.data.ingredients || [])) if (i && i.id != null && !refs.ingredients[i.id]) refs.ingredients[i.id] = i.name;
    for (const c of (this.data.coupons || [])) if (c && c.id != null && !refs.coupons[c.id]) refs.coupons[c.id] = c.code;
    for (const m of (this.data.line_members || [])) if (m && m.id != null && !refs.line_members[m.id]) refs.line_members[m.id] = m.line_user_id;
    for (const g of (this.data.product_analysis_groups || [])) if (g && g.id != null && !refs.analysis_groups[g.id]) refs.analysis_groups[g.id] = g.group_name || g.name;
    return refs;
  }
  st(table, cat) { return this.stats[table] || (this.stats[table] = newStats(table, cat)); }
  colSet(table) {
    if (!this.cols[table]) {
      const info = tableInfo(this.raw, table);
      this.cols[table] = { set: new Set(info.map(c => c.name)), info, intPk: info.some(c => c.pk && c.name === 'id' && /INT/i.test(c.type)), textPk: info.some(c => c.pk && c.name === 'id' && !/INT/i.test(c.type)) };
    }
    return this.cols[table];
  }
  run(sql, params) {
    let st = this.stmts.get(sql);
    if (!st) { st = this.raw.prepare(sql); this.stmts.set(sql, st); }
    st.run(params);
    return this.raw.getRowsModified();
  }
  lastId() { const r = rawGet(this.raw, 'SELECT last_insert_rowid() AS id'); return r ? r.id : null; }
  freeStatements() { for (const st of this.stmts.values()) { try { st.free(); } catch {} } this.stmts.clear(); }
  rows(table) { const a = this.data[table]; return Array.isArray(a) ? a : []; }

  // 目標店商品索引（條碼／名稱 → id），名稱重複時視為無法唯一對應
  productIndex(force) {
    if (this.targetProductIndex && !force) return this.targetProductIndex;
    const byBarcode = new Map(), byName = new Map(), byId = new Map();
    rawEach(this.raw, 'SELECT id, name, product_barcode FROM products WHERE store_id=?', [this.storeId], (r) => {
      byId.set(String(r.id), String(r.name || ''));
      if (r.product_barcode) { const k = String(r.product_barcode); byBarcode.set(k, byBarcode.has(k) ? null : r.id); }
      const n = String(r.name || ''); byName.set(n, byName.has(n) ? null : r.id);
    });
    this.targetProductIndex = { byBarcode, byName, byId };
    return this.targetProductIndex;
  }
  resolveProduct(oldId, hint) {
    if (oldId == null || oldId === '') return null;
    const k = String(oldId);
    if (this.maps.product.has(k)) return this.maps.product.get(k);
    const ref = this.refs.products[k] || hint || null;
    let id = null;
    if (ref) {
      const idx = this.productIndex();
      if (idx.byId.get(k) === String(ref.name)) id = Number(k);
      if (id == null && ref.barcode && idx.byBarcode.get(String(ref.barcode))) id = idx.byBarcode.get(String(ref.barcode));
      if (id == null && ref.name != null && idx.byName.get(String(ref.name))) id = idx.byName.get(String(ref.name));
    }
    this.maps.product.set(k, id);
    return id;
  }
  resolveByName(mapName, refName, table, col, oldId) {
    if (oldId == null || oldId === '') return null;
    const k = String(oldId);
    const m = this.maps[mapName];
    if (m.has(k)) return m.get(k);
    const name = this.refs[refName][k];
    let id = null;
    if (name != null && tableExists(this.raw, table)) {
      const rows = rawAll(this.raw, `SELECT id FROM ${table} WHERE store_id=? AND ${col}=? LIMIT 2`, [this.storeId, name]);
      if (rows.length === 1) id = rows[0].id;
    }
    m.set(k, id);
    return id;
  }
  resolveIngredient(oldId, nameHint) {
    if (oldId == null || oldId === '') return null;
    const k = String(oldId);
    if (this.maps.ingredient.has(k)) return this.maps.ingredient.get(k);
    const name = this.refs.ingredients[k] != null ? this.refs.ingredients[k] : nameHint;
    let id = null;
    if (name != null) { const r = rawGet(this.raw, 'SELECT id FROM ingredients WHERE store_id=? AND name=?', [this.storeId, name]); if (r) id = r.id; }
    this.maps.ingredient.set(k, id);
    return id;
  }
  resolveMember(oldId) {
    if (oldId == null || oldId === '') return null;
    const k = String(oldId);
    if (this.maps.member.has(k)) return this.maps.member.get(k);
    const lu = this.refs.line_members[k];
    let id = null;
    if (lu) { const r = rawGet(this.raw, 'SELECT id FROM line_members WHERE store_id=? AND line_user_id=?', [this.storeId, lu]); if (r) id = r.id; }
    this.maps.member.set(k, id);
    return id;
  }
  mapOrderRef(v) { if (v == null || v === '') return v; const k = String(v); return this.maps.order.has(k) ? this.maps.order.get(k) : v; }
  mapText(mapName, v) { if (v == null || v === '') return v; const k = String(v); return this.maps[mapName].has(k) ? this.maps[mapName].get(k) : v; }
}

// 通用「依業務鍵」匯入一張表
//  spec: {
//    table, cat, rows, keyOf(row)→string|null, existingSql (預設 SELECT * FROM t WHERE scope), existingKeyOf(row),
//    transform(row, stats) → { values } | { missing: 'reason' } | { invalid: 'reason' },
//    idMode: 'int'|'text'|'none', textIdMap: mapName, onAdded(row, newId, values), onExisting(row, existingRow)
//    appendOnly: bool（歷程類資料：存在即跳過，不做補值／衝突比較）
//  }
function importTable(ctx, spec) {
  const { table } = spec;
  const st = ctx.st(table, spec.cat);
  const rows = spec.rows;
  st.source += rows.length;
  if (!tableExists(ctx.raw, table)) {
    if (rows.length) { st.invalid += rows.length; pushSample(st, 'invalid', { reason: `目前系統沒有資料表 ${table}` }); }
    return st;
  }
  const meta = ctx.colSet(table);
  // 既有資料索引
  const existing = new Map();
  const existingSql = spec.existingSql || `SELECT * FROM ${table} WHERE ${scopeWhere(table)}`;
  rawEach(ctx.raw, existingSql, [ctx.storeId], (r) => {
    const k = (spec.existingKeyOf || spec.keyOf)(r, true);
    if (k != null && !existing.has(k)) existing.set(k, r.id !== undefined ? r.id : r);
  });
  st.existing_before = countScoped(ctx.raw, table, ctx.storeId);
  const seenInFile = new Set();
  const ignore = new Set([...(IGNORE_COMPARE._all), ...(IGNORE_COMPARE[table] || [])]);

  for (const row0 of rows) {
    if (!row0 || typeof row0 !== 'object' || Array.isArray(row0)) { st.invalid++; pushSample(st, 'invalid', { reason: '資料列格式錯誤' }); continue; }
    let tr;
    try { tr = spec.transform(row0, st); } catch (e) { st.invalid++; pushSample(st, 'invalid', { reason: e.message }); continue; }
    if (tr.invalid) { st.invalid++; pushSample(st, 'invalid', { key: tr.key, reason: tr.invalid }); continue; }
    if (tr.protect) { st.protected++; st.skipped++; continue; }
    const values = tr.values;
    if (tr.missing) { st.missing_relation++; pushSample(st, 'missing_relation', { key: safeKey(spec, values), reason: tr.missing }); continue; }
    const key = spec.keyOf(values, false);
    if (key == null) { st.invalid++; pushSample(st, 'invalid', { reason: '缺少業務識別鍵' }); continue; }
    if (seenInFile.has(key)) { st.duplicate_in_file++; continue; }
    seenInFile.add(key);

    if (existing.has(key)) {
      const ex = existing.get(key);
      if (spec.onExisting) spec.onExisting(row0, values, ex);
      if (ctx.mode === 'skip' || spec.appendOnly) { st.skipped++; continue; }
      // merge：只補空白欄位；兩邊都有值且不同 → 衝突，整列不動
      const exRow = (ex && typeof ex === 'object') ? ex : rawGet(ctx.raw, `SELECT * FROM ${table} WHERE id=?`, [ex]);
      if (!exRow) { st.skipped++; continue; }
      const fills = {}; const conflicts = [];
      for (const c of Object.keys(values)) {
        if (!meta.set.has(c) || ignore.has(c) || c.startsWith('_')) continue;
        const nv = values[c], ov = exRow[c];
        if (isEmptyVal(nv)) continue;
        if (isEmptyVal(ov)) fills[c] = nv;
        else if (!looseEqual(ov, nv)) conflicts.push(c);
      }
      if (conflicts.length) { st.conflict++; pushSample(st, 'conflict', { key, fields: conflicts.slice(0, 8) }); continue; }
      const fc = Object.keys(fills);
      if (!fc.length) { st.skipped++; continue; }
      try {
        const where = meta.set.has('id') ? 'id=?' : 'store_id=? AND key=?';
        const wp = meta.set.has('id') ? [exRow.id] : [exRow.store_id, exRow.key];
        ctx.run(`UPDATE ${table} SET ${fc.map(c => `${c}=?`).join(',')} WHERE ${where}`, [...fc.map(c => fills[c]), ...wp]);
        st.updated++;
      } catch (e) { st.failed++; pushSample(st, 'failed', { key, error: e.message }); }
      continue;
    }

    // 新增
    const ins = {};
    for (const c of Object.keys(values)) { if (meta.set.has(c) && !c.startsWith('_')) ins[c] = values[c]; }
    if (meta.set.has('store_id')) ins.store_id = ctx.storeId;
    let oldId = row0.id;
    if (meta.intPk) {
      delete ins.id;
      if (spec.idMode === 'int' && oldId != null && Number.isInteger(Number(oldId)) && Number(oldId) > 0) {
        const taken = rawGet(ctx.raw, `SELECT 1 AS x FROM ${table} WHERE id=?`, [Number(oldId)]);
        if (!taken) ins.id = Number(oldId); else st.id_remapped++;
      }
    } else if (meta.textPk) {
      const want = ins.id != null && ins.id !== '' ? String(ins.id) : null;
      const taken = want ? rawGet(ctx.raw, `SELECT store_id FROM ${table} WHERE id=?`, [want]) : null;
      if (!want || taken) { ins.id = crypto.randomUUID(); if (want) st.id_remapped++; }
      if (spec.textIdMap && want) ctx.maps[spec.textIdMap].set(want, ins.id);
    }
    if (spec.beforeInsert) {
      const r = spec.beforeInsert(ins, row0, st);
      if (r && r.missing) { st.missing_relation++; pushSample(st, 'missing_relation', { key, reason: r.missing }); continue; }
    }
    const cols = Object.keys(ins);
    try {
      ctx.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => (ins[c] === undefined ? null : ins[c])));
      const newId = meta.intPk ? ctx.lastId() : ins.id;
      existing.set(key, newId);
      st.added++;
      if (spec.onAdded) spec.onAdded(row0, newId, ins);
    } catch (e) {
      st.failed++; pushSample(st, 'failed', { key, error: e.message });
    }
  }
  return st;
}

const k = (...parts) => parts.map(s).join('\u0001');
function safeKey(spec, values) { try { const x = values ? spec.keyOf(values, false) : null; return x == null ? null : String(x).replace(/\u0001/g, ' | '); } catch { return null; } }

// ── 各分類匯入步驟 ─────────────────────────────────────────────────────────
function stepCategories(ctx) {
  importTable(ctx, { table: 'categories', cat: 'categories', rows: ctx.rows('categories'), idMode: 'int',
    keyOf: r => (r.name ? k(r.name) : null),
    transform: r => ({ values: { ...r } }),
    onAdded: (row, id) => { if (row.id != null) ctx.maps.category.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.category.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
}

function stepProducts(ctx) {
  const idx = ctx.productIndex(true);
  const fileProductById = new Map(ctx.rows('products').filter(p => p && p.id != null).map(p => [String(p.id), String(p.name)]));
  // 業務識別：條碼（非空白且目標店唯一）優先，其次商品名稱（目標店唯一）。
  // 對應到既有商品時鍵為 'id:<目標 id>'；否則以條碼／名稱作為新商品鍵（同檔重複可偵測）。
  const keyOfProduct = (r, isExisting) => {
    if (!r || r.name == null || r.name === '') return null;
    if (isExisting) return 'id:' + r.id;
    let hit = null;
    // 同一資料庫還原：目標店同 id 且同名 → 視為同一商品（可處理同名商品）
    if (r.id != null && idx.byId.get(String(r.id)) === String(r.name)) hit = Number(r.id);
    if (hit == null && r.product_barcode && idx.byBarcode.get(String(r.product_barcode))) hit = idx.byBarcode.get(String(r.product_barcode));
    if (hit == null && idx.byName.get(String(r.name))) {
      const cand = idx.byName.get(String(r.name));
      // 若備份檔裡另有一筆「同 id 同名」的商品會對應到這個目標商品，代表本列是來源店的另一個同名商品 → 視為新商品
      const twin = fileProductById.get(String(cand));
      if (!(twin !== undefined && twin === String(r.name) && String(r.id) !== String(cand))) hit = cand;
    }
    if (hit != null) return 'id:' + hit;
    // 新商品：以來源 id 區分（來源店允許同名商品，不能因同名而丟掉第二筆）
    if (r.id != null && r.id !== '') return 'new-src:' + r.id;
    return r.product_barcode ? 'new-b:' + r.product_barcode : 'new-n:' + r.name;
  };
  // 名稱重複的目標商品無法唯一對應：標成衝突
  importTable(ctx, { table: 'products', cat: 'products', rows: ctx.rows('products'), idMode: 'int',
    keyOf: keyOfProduct,
    transform: (r) => {
      const v = { ...r };
      if (r.category_id != null && r.category_id !== '') {
        const nid = ctx.resolveByName('category', 'categories', 'categories', 'name', r.category_id);
        v.category_id = nid; // 找不到對應分類時清空，保留 category 名稱文字欄位
      }
      if (r.line_category_id != null && r.line_category_id !== '') v.line_category_id = ctx.resolveByName('category', 'categories', 'categories', 'name', r.line_category_id);
      const barcodeHit = (r.product_barcode && idx.byBarcode.get(String(r.product_barcode))) || (r.id != null && idx.byId.get(String(r.id)) === String(r.name));
      if (!barcodeHit && idx.byName.has(String(r.name)) && idx.byName.get(String(r.name)) === null) {
        return { missing: `目前店家有多個同名商品「${r.name}」，無法唯一對應`, values: v };
      }
      return { values: v };
    },
    // R54.4／MBV2-HF1-C4：商品穩定識別（product_uuid）在同店必須唯一；已被占用時不沿用（之後自動補發新識別）
    beforeInsert: (ins) => {
      if (ins.product_uuid != null && ins.product_uuid !== '' && ctx.colSet('products').set.has('product_uuid')) {
        if (rawGet(ctx.raw, 'SELECT 1 AS x FROM products WHERE store_id=? AND product_uuid=?', [ctx.storeId, String(ins.product_uuid)])) ins.product_uuid = null;
      }
      return null;
    },
    onAdded: (row, id) => { if (row.id != null) ctx.maps.product.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.product.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
  ctx.productIndex(true);
  // 商品分析群組
  importTable(ctx, { table: 'product_analysis_groups', cat: 'products', rows: ctx.rows('product_analysis_groups'), idMode: 'int',
    keyOf: r => { const n = r.group_name || r.name; return n ? k(n) : null; },
    transform: r => ({ values: { ...r, group_name: r.group_name || r.name } }),
    onAdded: (row, id) => { if (row.id != null) ctx.maps.group.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.group.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
  const grp = (old) => ctx.resolveByName('group', 'analysis_groups', 'product_analysis_groups', 'group_name', old);
  importTable(ctx, { table: 'product_analysis_group_items', cat: 'products', rows: ctx.rows('product_analysis_group_items'), appendOnly: true,
    keyOf: r => (r.group_id != null && r.product_id != null ? k(r.group_id, r.product_id) : (r.group_id != null && r.product_name ? k(r.group_id, 'n:' + r.product_name) : null)),
    transform: r => {
      const g = grp(r.group_id);
      if (g == null) return { missing: '找不到對應的商品分析群組', values: { ...r } };
      const p = ctx.resolveProduct(r.product_id, r.product_name ? { name: r.product_name } : null);
      return { values: { ...r, group_id: g, product_id: p } };
    },
  });
  importTable(ctx, { table: 'product_analysis_group_aliases', cat: 'products', rows: ctx.rows('product_analysis_group_aliases'), appendOnly: true,
    keyOf: r => (r.group_id != null && r.alias_name ? k(r.group_id, r.alias_name) : null),
    transform: r => { const g = grp(r.group_id); return g == null ? { missing: '找不到對應的商品分析群組', values: { ...r } } : { values: { ...r, group_id: g } }; },
  });
}

function stepIngredients(ctx) {
  importTable(ctx, { table: 'ingredients', cat: 'ingredients', rows: ctx.rows('ingredients'), idMode: 'int',
    keyOf: r => (r.name ? k(r.name) : null),
    transform: r => ({ values: { ...r } }),
    onAdded: (row, id) => { if (row.id != null) ctx.maps.ingredient.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.ingredient.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
  importTable(ctx, { table: 'product_ingredient_formulas', cat: 'ingredients', rows: ctx.rows('product_ingredient_formulas'), idMode: 'none',
    keyOf: r => (r.product_id != null && r.ingredient_id != null ? k(r.product_id, r.ingredient_id) : null),
    transform: r => {
      const p = ctx.resolveProduct(r.product_id, r.product_name ? { name: r.product_name, barcode: r.product_barcode || '' } : null);
      const i = ctx.resolveIngredient(r.ingredient_id, r.ingredient_name);
      const v = { ...r, product_id: p, ingredient_id: i };
      if (p == null) return { missing: `找不到扣料公式對應的商品（${r.product_name || r.product_id}）`, values: v };
      if (i == null) return { missing: `找不到扣料公式對應的食材（${r.ingredient_name || r.ingredient_id}）`, values: v };
      return { values: v };
    },
  });
  const ingStep = (table, keyFn) => importTable(ctx, { table, cat: 'ingredients', rows: ctx.rows(table), appendOnly: true,
    keyOf: r => (r.ingredient_id != null ? keyFn(r) : null),
    transform: r => { const i = ctx.resolveIngredient(r.ingredient_id, r.ingredient_name); const v = { ...r, ingredient_id: i }; return i == null ? { missing: '找不到對應食材', values: v } : { values: v }; },
  });
  ingStep('ingredient_batches', r => k(r.ingredient_id, r.batch_no, r.purchase_date, r.created_at, r.quantity));
  ingStep('ingredient_thaw_batches', r => k(r.ingredient_id, r.started_at, r.amount, r.created_at));
}

function stepDiscounts(ctx) {
  importTable(ctx, { table: 'coupons', cat: 'discounts', rows: ctx.rows('coupons'), idMode: 'int',
    keyOf: r => (r.code ? k(String(r.code)) : null), transform: r => ({ values: { ...r } }),
    onAdded: (row, id) => { if (row.id != null) ctx.maps.coupon.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.coupon.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
  importTable(ctx, { table: 'discount_categories', cat: 'discounts', rows: ctx.rows('discount_categories'), idMode: 'int',
    keyOf: r => { const n = r.name || r.label; return n ? k(n) : null; }, transform: r => ({ values: { ...r, name: r.name || r.label } }) });
  importTable(ctx, { table: 'discount_campaigns', cat: 'discounts', rows: ctx.rows('discount_campaigns'), idMode: 'int',
    keyOf: r => (r.name ? k(r.name) : null), transform: r => ({ values: { ...r } }) });
}

function popupPublicCodeOk(ctx, table, code, id) {
  if (!code) return false;
  const r = rawGet(ctx.raw, `SELECT id FROM ${table} WHERE public_code=?`, [code]);
  return !r || String(r.id) === String(id);
}
function stepPopupMaster(ctx) {
  const textKey = r => (r.id ? k(r.id) : null);
  importTable(ctx, { table: 'popup_locations', cat: 'popup', rows: ctx.rows('popup_locations'), idMode: 'text', textIdMap: 'popupLocation',
    keyOf: textKey, existingSql: 'SELECT * FROM popup_locations WHERE store_id=?', transform: r => ({ values: { ...r } }) });
  importTable(ctx, { table: 'popup_campaigns', cat: 'popup', rows: ctx.rows('popup_campaigns'), idMode: 'text', textIdMap: 'popupCampaign',
    keyOf: textKey, transform: r => ({ values: { ...r } }),
    beforeInsert: (ins, row, st) => { if (!popupPublicCodeOk(ctx, 'popup_campaigns', ins.public_code, ins.id)) { ins.public_code = ctx.genCode(); st.id_remapped++; } } });
  importTable(ctx, { table: 'popup_sessions', cat: 'popup', rows: ctx.rows('popup_sessions'), idMode: 'text', textIdMap: 'popupSession',
    keyOf: textKey,
    transform: r => {
      const v = { ...r, campaign_id: ctx.mapText('popupCampaign', r.campaign_id), location_id: ctx.mapText('popupLocation', r.location_id) };
      const c = v.campaign_id ? rawGet(ctx.raw, 'SELECT store_id FROM popup_campaigns WHERE id=?', [v.campaign_id]) : null;
      if (!c || c.store_id !== ctx.storeId) return { missing: '找不到場次所屬的快閃活動', values: v };
      if (v.location_id) { const l = rawGet(ctx.raw, 'SELECT store_id FROM popup_locations WHERE id=?', [v.location_id]); if (!l || l.store_id !== ctx.storeId) v.location_id = null; }
      return { values: v };
    },
    beforeInsert: (ins, row, st) => { if (!popupPublicCodeOk(ctx, 'popup_sessions', ins.public_code, ins.id)) { ins.public_code = ctx.genCode(); st.id_remapped++; } } });
  const sessOk = (sid) => { if (!sid) return false; const r = rawGet(ctx.raw, 'SELECT store_id FROM popup_sessions WHERE id=?', [sid]); return !!r && r.store_id === ctx.storeId; };
  for (const table of ['popup_session_products', 'popup_session_product_sales']) {
    importTable(ctx, { table, cat: 'popup', rows: ctx.rows(table), idMode: 'none',
      keyOf: r => (r.session_id && r.product_id != null ? k(r.session_id, r.product_id) : null),
      transform: r => {
        const sid = ctx.mapText('popupSession', r.session_id); const p = ctx.resolveProduct(r.product_id);
        const v = { ...r, session_id: sid, product_id: p };
        if (!sessOk(sid)) return { missing: '找不到對應場次', values: v };
        if (p == null) return { missing: '找不到對應商品', values: v };
        return { values: v };
      } });
  }
}
function stepPopupAfterOrders(ctx) {
  const sessOk = (sid) => { if (!sid) return false; const r = rawGet(ctx.raw, 'SELECT store_id FROM popup_sessions WHERE id=?', [sid]); return !!r && r.store_id === ctx.storeId; };
  importTable(ctx, { table: 'popup_order_allocations', cat: 'popup', rows: ctx.rows('popup_order_allocations'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.session_id && r.order_id && r.product_id != null ? k(r.session_id, r.order_id, r.product_id) : null),
    transform: r => {
      const sid = ctx.mapText('popupSession', r.session_id); const p = ctx.resolveProduct(r.product_id); const oid = ctx.mapOrderRef(r.order_id);
      const v = { ...r, session_id: sid, product_id: p, order_id: oid };
      if (!sessOk(sid)) return { missing: '找不到對應場次', values: v };
      if (p == null) return { missing: '找不到對應商品', values: v };
      const o = rawGet(ctx.raw, 'SELECT 1 AS x FROM orders WHERE store_id=? AND (id=? OR order_number=?)', [ctx.storeId, oid, oid]);
      if (!o) return { missing: '找不到對應訂單（請一併匯入訂單紀錄）', values: v };
      return { values: v };
    } });
  importTable(ctx, { table: 'popup_session_change_logs', cat: 'popup', rows: ctx.rows('popup_session_change_logs'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.session_id ? k(r.session_id, r.revision_before, r.revision_after, r.created_at) : null),
    transform: r => { const sid = ctx.mapText('popupSession', r.session_id); const v = { ...r, session_id: sid }; return sessOk(sid) ? { values: v } : { missing: '找不到對應場次', values: v }; } });
}

function stepOrders(ctx) {
  const all = ctx.cat.has('orders');
  const onlyLine = !all && ctx.cat.has('line_preorders');
  const src = ctx.rows('orders').filter(o => all || (onlyLine && o && o.source === 'line'));
  const importedOrderRefs = new Set();
  importTable(ctx, { table: 'orders', cat: all ? 'orders' : 'line_preorders', rows: src, idMode: 'text', textIdMap: 'order',
    keyOf: r => (r.order_number ? k(String(r.order_number).trim()) : null),
    existingSql: 'SELECT id, order_number FROM orders WHERE store_id=?',
    transform: r => {
      const num = String(r.order_number || '').trim();
      if (!num) return { invalid: '訂單缺少 order_number' };
      const v = { ...r, order_number: num };
      if (typeof v.items !== 'string' && v.items != null) v.items = JSON.stringify(v.items);
      if (v.popup_session_id) v.popup_session_id = ctx.mapText('popupSession', v.popup_session_id);
      if (v.popup_campaign_id) v.popup_campaign_id = ctx.mapText('popupCampaign', v.popup_campaign_id);
      return { values: v };
    },
    onAdded: (row) => { importedOrderRefs.add(String(row.id)); importedOrderRefs.add(String(row.order_number).trim()); },
    onExisting: (row, v, ex) => {
      // 已存在（同店同訂單編號）：子資料以目前訂單 id 對應
      const exId = typeof ex === 'object' ? ex.id : ex;
      if (row.id != null && exId != null && String(row.id) !== String(exId)) ctx.maps.order.set(String(row.id), exId);
      importedOrderRefs.add(String(row.id)); importedOrderRefs.add(String(row.order_number).trim());
    },
  });
  // 只處理屬於本次匯入範圍訂單的子資料
  const belongs = (r) => importedOrderRefs.has(String(r.order_id)) || (r.order_number && importedOrderRefs.has(String(r.order_number)));
  const orderExists = (ref) => !!rawGet(ctx.raw, 'SELECT 1 AS x FROM orders WHERE store_id=? AND (id=? OR order_number=?)', [ctx.storeId, ref, ref]);
  importTable(ctx, { table: 'order_logs', cat: all ? 'orders' : 'line_preorders', rows: ctx.rows('order_logs').filter(belongs), idMode: 'none', appendOnly: true,
    keyOf: r => (r.order_id != null ? k(r.order_id, r.action, r.created_at, r.before_total, r.after_total, r.reason) : null),
    transform: r => {
      const oid = ctx.mapOrderRef(r.order_id);
      const v = { ...r, order_id: oid, order_number: r.order_number || r.order_id };
      return orderExists(oid) || orderExists(v.order_number) ? { values: v } : { missing: '找不到對應訂單', values: v };
    } });
  importTable(ctx, { table: 'coupon_redemptions', cat: all ? 'orders' : 'line_preorders', rows: ctx.rows('coupon_redemptions').filter(belongs), idMode: 'none', appendOnly: true,
    keyOf: r => (r.order_id != null ? k(r.order_id) : null),
    transform: r => {
      const oid = ctx.mapOrderRef(r.order_id);
      const v = { ...r, order_id: oid };
      let cid = null;
      if (r.coupon_code) { const c = rawGet(ctx.raw, 'SELECT id FROM coupons WHERE store_id=? AND code=?', [ctx.storeId, r.coupon_code]); if (c) cid = c.id; }
      if (cid == null && r.coupon_id != null) cid = ctx.resolveByName('coupon', 'coupons', 'coupons', 'code', r.coupon_id);
      v.coupon_id = cid;
      if (!orderExists(oid)) return { missing: '找不到對應訂單', values: v };
      if (cid == null) return { missing: `找不到優惠券代碼 ${r.coupon_code || ''}（請一併匯入折扣活動）`, values: v };
      return { values: v };
    } });
}

function stepInventoryMovements(ctx) {
  importTable(ctx, { table: 'inventory_logs', cat: 'inventory_movements', rows: ctx.rows('inventory_logs'), idMode: 'none', appendOnly: true,
    keyOf: r => k(r.product_name, r.action, r.created_at, r.change_grams, r.after_grams, r.order_id),
    existingKeyOf: r => k(r.product_name, r.action, r.created_at, r.change_grams, r.after_grams, r.order_id),
    transform: (r, st) => {
      const p = ctx.resolveProduct(r.product_id, r.product_name ? { name: r.product_name } : null);
      if (p == null && r.product_id != null) st.relation_cleared++;
      return { values: { ...r, product_id: p, order_id: r.order_id ? ctx.mapOrderRef(r.order_id) : r.order_id } };
    } });
  importTable(ctx, { table: 'ingredient_logs', cat: 'inventory_movements', rows: ctx.rows('ingredient_logs'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.ingredient_id != null ? k(r.ingredient_id, r.log_type, r.created_at, r.change_amount, r.batch_no) : null),
    transform: r => {
      const i = ctx.resolveIngredient(r.ingredient_id, r.ingredient_name);
      const v = { ...r, ingredient_id: i };
      return i == null ? { missing: `找不到對應食材（${r.ingredient_name || r.ingredient_id}）`, values: v } : { values: v };
    } });
}

function stepMembers(ctx) {
  importTable(ctx, { table: 'line_members', cat: 'line_members', rows: ctx.rows('line_members'), idMode: 'int',
    keyOf: r => (r.line_user_id ? k(String(r.line_user_id).trim()) : null),
    transform: (r, st) => {
      const v = {};
      for (const [c, val] of Object.entries(r)) if (!SENSITIVE_COLUMN_BLACKLIST.has(c.toLowerCase())) v[c] = val;
      v.line_user_id = String(r.line_user_id || '').trim();
      if (!v.line_user_id) return { invalid: '缺少 line_user_id' };
      if (r.first_product_id != null && r.first_product_id !== '') { v.first_product_id = ctx.resolveProduct(r.first_product_id); if (v.first_product_id == null) st.relation_cleared++; }
      v.merged_into_id = null; // 合併後另行處理
      return { values: v };
    },
    onAdded: (row, id) => { if (row.id != null) ctx.maps.member.set(String(row.id), id); },
    onExisting: (row, v, ex) => { if (row.id != null) ctx.maps.member.set(String(row.id), typeof ex === 'object' ? ex.id : ex); },
  });
  // merged_into_id：只在新增的會員上，以 line_user_id 重新對應
  for (const m of ctx.rows('line_members')) {
    if (!m || m.merged_into_id == null || m.merged_into_id === '') continue;
    const self = ctx.resolveMember(m.id); const target = ctx.resolveMember(m.merged_into_id);
    if (self != null && target != null) {
      const cur = rawGet(ctx.raw, 'SELECT merged_into_id FROM line_members WHERE id=?', [self]);
      if (cur && isEmptyVal(cur.merged_into_id)) ctx.run('UPDATE line_members SET merged_into_id=? WHERE id=?', [target, self]);
    }
  }
  importTable(ctx, { table: 'line_member_tags', cat: 'line_members', rows: ctx.rows('line_member_tags'), idMode: 'none',
    keyOf: r => (r.line_user_id && r.tag_code ? k(r.line_user_id, r.tag_code) : null), transform: r => ({ values: { ...r } }) });
}

function stepMemberHistory(ctx) {
  importTable(ctx, { table: 'line_member_history', cat: 'member_history', rows: ctx.rows('line_member_history'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.line_user_id && r.event_name ? k(r.line_user_id, r.event_name, r.created_at, r.old_value, r.new_value) : null),
    transform: r => {
      const lu = String(r.line_user_id || r.member_id || '').trim();
      return { values: { ...r, line_user_id: lu, metadata_json: r.metadata_json ? sanitizeJsonString(r.metadata_json) : r.metadata_json } };
    } });
  importTable(ctx, { table: 'line_member_order_links', cat: 'member_history', rows: ctx.rows('line_member_order_links'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.order_id ? k(r.order_id) : null),
    transform: r => ({ values: { ...r, order_id: ctx.mapOrderRef(r.order_id) } }) });
  importTable(ctx, { table: 'line_friend_events', cat: 'member_history', rows: ctx.rows('line_friend_events'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.line_user_id && r.event_type ? k(r.line_user_id, r.event_type, r.event_at, r.source, r.created_at) : null),
    transform: (r, st) => {
      const v = { ...r, metadata_json: r.metadata_json ? sanitizeJsonString(r.metadata_json) : r.metadata_json };
      if (r.member_id != null && r.member_id !== '') { v.member_id = ctx.resolveMember(r.member_id); if (v.member_id == null) st.relation_cleared++; }
      return { values: v };
    } });
  importTable(ctx, { table: 'line_member_sessions', cat: 'member_history', rows: ctx.rows('line_member_sessions'), idMode: 'none', appendOnly: true,
    keyOf: r => (r.line_user_id && r.visitor_id ? k(r.line_user_id, r.visitor_id) : null), transform: r => ({ values: { ...r } }) });
}

// R54.4／MBV2-HF1-C3：商品想買登記。商品以 ref_maps／名稱快照重新對應；會員以 line_user_id
// （LINE 會員的業務識別鍵）保存；店別一律寫入目前店家。匯入不呼叫任何推播。
function stepProductDemand(ctx) {
  importTable(ctx, { table: 'product_demand_requests', cat: 'product_demand', rows: ctx.rows('product_demand_requests'), idMode: 'int',
    keyOf: r => (r.request_uuid ? k(r.request_uuid) : null),
    transform: r => {
      const lu = String(r.line_user_id || '').trim();
      if (!lu) return { invalid: '缺少 line_user_id' };
      if (!r.request_uuid) return { invalid: '缺少 request_uuid' };
      const p = ctx.resolveProduct(r.product_id, r.product_name_snapshot ? { name: r.product_name_snapshot } : null);
      const v = { ...r, line_user_id: lu, product_id: p };
      if (p == null) return { missing: `找不到想買登記對應的商品（${r.product_name_snapshot || r.product_id}）`, values: v };
      return { values: v };
    },
    // 同一店別、商品、會員只能有一筆 active：目標店已有有效登記時保留現有資料，不覆蓋、不累加
    beforeInsert: (ins) => {
      if (ins.status === 'active') {
        const ex = rawGet(ctx.raw, "SELECT id FROM product_demand_requests WHERE store_id=? AND product_id=? AND line_user_id=? AND status='active'", [ctx.storeId, ins.product_id, ins.line_user_id]);
        if (ex) return { missing: '目前店家已有同一會員對同一商品的有效登記，保留現有登記' };
      }
      return null;
    },
  });
  importTable(ctx, { table: 'product_demand_consents', cat: 'product_demand', rows: ctx.rows('product_demand_consents'), idMode: 'int',
    keyOf: r => (r.consent_uuid ? k(r.consent_uuid) : null),
    transform: r => {
      const lu = String(r.line_user_id || '').trim();
      if (!lu) return { invalid: '缺少 line_user_id' };
      if (!r.consent_uuid) return { invalid: '缺少 consent_uuid' };
      const p = ctx.resolveProduct(r.product_id);
      const v = { ...r, line_user_id: lu, product_id: p };
      // R54.4／MBV2-HF1-C4：匯入來源的同意只保留歷史；在本環境重新發送前須由顧客重新確認。
      // 既有同 uuid 的同意（例如目前已撤回）不會被備份覆蓋（skip 跳過、merge 欄位不同即衝突不動）。
      if (ctx.colSet('product_demand_consents').set.has('reconfirm_required')) {
        v.reconfirm_required = 1;
        v.import_source = importSourceTag(ctx);
      }
      if (p == null) return { missing: `找不到通知同意對應的商品（${r.product_id}）`, values: v };
      return { values: v };
    },
  });
}

// R54.4／MBV2-HF1-C4：補貨通知紀錄。只合併（appendOnly：同 uuid 已存在即跳過），不覆蓋現有紀錄；
//   - 商品以 ref_maps／名稱快照重新對應；無法唯一對應時 product_id=0（未連結），絕不指向另一款商品。
//   - 未完成的批次一律改為 paused（pause_reason='imported'），未完成的逐筆紀錄改為 held／unknown，
//     必須由店家在本環境明確續送；匯入本身不呼叫任何推播。
//   - 防重名額（claim=1）保留；目標店同一登記週期已有名額時，匯入列只保留為歷史（claim=NULL）。
function importSourceTag(ctx) {
  const src = String(ctx.info.source_store_id || '').slice(0, 40);
  const at = String(ctx.info.exported_at || '').slice(0, 40);
  return `import:${src}@${at}`;
}
const RESTOCK_OPEN_DELIVERY = new Set(['pending', 'sending', 'retry_wait', 'held']);
const RESTOCK_OPEN_BATCH = new Set(['previewed', 'sending', 'paused']);
function stepRestockNotify(ctx) {
  const tag = importSourceTag(ctx);
  const mapProduct = (r) => {
    const p = ctx.resolveProduct(r.product_id, r.product_name_snapshot ? { name: r.product_name_snapshot } : null);
    return p == null ? 0 : p;
  };
  const batchProduct = new Map(); // batch_uuid → product_id（逐筆沿用批次的對應結果）
  importTable(ctx, { table: 'restock_notify_batches', cat: 'restock_notify', rows: ctx.rows('restock_notify_batches'), idMode: 'int', appendOnly: true,
    keyOf: r => (r.batch_uuid ? k(r.batch_uuid) : null),
    transform: r => {
      if (!r.batch_uuid) return { invalid: '缺少 batch_uuid' };
      const v = { ...r, product_id: mapProduct(r), import_source: tag };
      if (RESTOCK_OPEN_BATCH.has(String(r.status))) { v.status = r.status === 'previewed' ? 'expired' : 'paused'; v.pause_reason = 'imported'; }
      batchProduct.set(String(r.batch_uuid), v.product_id);
      return { values: v };
    },
  });
  for (const r of ctx.rows('restock_notify_batches')) {
    if (r && r.batch_uuid && !batchProduct.has(String(r.batch_uuid))) batchProduct.set(String(r.batch_uuid), mapProduct(r));
  }
  importTable(ctx, { table: 'restock_notify_deliveries', cat: 'restock_notify', rows: ctx.rows('restock_notify_deliveries'), idMode: 'int', appendOnly: true,
    keyOf: r => (r.delivery_uuid ? k(r.delivery_uuid) : null),
    transform: r => {
      if (!r.delivery_uuid || !r.request_uuid || !r.batch_uuid) return { invalid: '缺少 delivery_uuid／request_uuid／batch_uuid' };
      let pid = batchProduct.has(String(r.batch_uuid)) ? batchProduct.get(String(r.batch_uuid)) : null;
      if (pid == null) {
        const ex = rawGet(ctx.raw, 'SELECT product_id FROM restock_notify_batches WHERE store_id=? AND batch_uuid=?', [ctx.storeId, r.batch_uuid]);
        pid = ex ? Number(ex.product_id) : 0;
      }
      const v = { ...r, product_id: pid, import_source: tag };
      if (RESTOCK_OPEN_DELIVERY.has(String(r.status))) {
        // 曾交給 LINE 的（attempt_count>0）可能已受理 → 結果待確認；從未嘗試 → 暫停待續送
        v.status = Number(r.attempt_count) > 0 ? 'unknown' : 'held';
        v.error_code = 'imported_unfinished';
        v.next_attempt_at = null;
      }
      return { values: v };
    },
    beforeInsert: (ins) => {
      if (Number(ins.claim) === 1) {
        const ex = rawGet(ctx.raw, 'SELECT 1 AS x FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND claim=1', [ctx.storeId, ins.request_uuid]);
        if (ex) ins.claim = null; // 目標店已有此週期的名額，匯入列只當歷史
      }
      if (ins.retry_key) {
        const ex = rawGet(ctx.raw, 'SELECT 1 AS x FROM restock_notify_deliveries WHERE retry_key=?', [ins.retry_key]);
        if (ex) { ins.retry_key = null; if (RESTOCK_OPEN_DELIVERY.has(String(ins.status)) || ins.status === 'held') ins.status = 'unknown'; }
      }
      const dupe = rawGet(ctx.raw, 'SELECT 1 AS x FROM restock_notify_deliveries WHERE batch_uuid=? AND request_uuid=?', [ins.batch_uuid, ins.request_uuid]);
      if (dupe) return { missing: '同一批次已有此登記週期的紀錄，保留現有紀錄' };
      return null;
    },
  });
  // R54.4／MBV2-HF1-C4.1：匯入的已受理證據即使因本地已有名額而成為 claim=NULL，也必須生效——
  // 同一交易內把本店同週期尚未完成的本地工作停止並標示「本週期已通知」（預覽匯入會一併回滾）。
  require('./restockNotify').blockConflictsRaw(ctx.raw, ctx.storeId);
}

const LOGIN_EVENTS = new Set(['line_login_success', 'line_login_failed', 'line_verify_success', 'line_verify_failed']);
function analyticsKey(r, hasUuid) {
  if (!r || !r.event_name) return null;
  if (hasUuid && r.event_uuid) return 'u' + k(r.event_uuid);
  if (r.order_id) return 'o' + k(r.event_name, r.order_id); // 與 idx_analytics_order_event_unique 一致
  if (LOGIN_EVENTS.has(r.event_name)) return 'l' + k(r.event_name, r.identity_key, r.created_at);
  return 'e' + k(r.event_name, r.session_id, r.cart_id, r.product_id == null ? '' : r.product_id, r.created_at, r.visitor_id);
}
function stepAnalytics(ctx) {
  const hasUuid = ctx.colSet('analytics_events').set.has('event_uuid');
  importTable(ctx, { table: 'analytics_events', cat: 'analytics', rows: ctx.rows('analytics_events'), idMode: 'none', appendOnly: true,
    existingSql: `SELECT id, event_name, order_id, identity_key, created_at, session_id, cart_id, product_id, visitor_id${hasUuid ? ', event_uuid' : ''} FROM analytics_events WHERE store_id=?`,
    keyOf: r => analyticsKey(r, hasUuid),
    transform: (r, st) => {
      const v = { ...r };
      if (r.product_id != null && r.product_id !== '') { v.product_id = ctx.resolveProduct(r.product_id); if (v.product_id == null) st.relation_cleared++; }
      if (v.order_id) v.order_id = ctx.mapOrderRef(v.order_id);
      if (v.metadata_json) v.metadata_json = sanitizeJsonString(v.metadata_json);
      if (v.properties_json) v.properties_json = sanitizeJsonString(v.properties_json);
      return { values: v };
    } });
  importTable(ctx, { table: 'geo_visit_log', cat: 'analytics', rows: ctx.rows('geo_visit_log'), idMode: 'none', appendOnly: true,
    existingSql: 'SELECT id, source_event_id, visitor_id, session_id, event_name, event_time FROM geo_visit_log WHERE store_id=?',
    keyOf: r => (r.source_event_id ? 's' + k(r.source_event_id) : (r.event_name ? 'e' + k(r.visitor_id, r.session_id, r.event_name, r.event_time) : null)),
    transform: r => ({ values: { ...r, order_id: r.order_id ? ctx.mapOrderRef(r.order_id) : r.order_id } }) });
}

function stepSettings(ctx) {
  const st0 = ctx.st('settings', 'settings');
  importTable(ctx, { table: 'settings', cat: 'settings', rows: ctx.rows('settings'), idMode: 'none',
    existingSql: 'SELECT store_id, key, value FROM settings WHERE store_id=?',
    existingKeyOf: r => k(r.key),
    keyOf: r => (r.key ? k(r.key) : null),
    // pos_password（店家登入密碼雜湊）受保護：永遠不匯入，避免備份檔改掉目前密碼
    transform: r => (PROTECTED_SETTING_KEYS.has(r.key) ? { protect: true } : { values: { key: r.key, value: r.value == null ? '' : r.value } }),
    onExisting: () => {},
  });
  // settings 沒有 id 欄位：merge 補值走 store_id+key（importTable 已處理）
  void st0;
  importTable(ctx, { table: 'delivery_platforms', cat: 'settings', rows: ctx.rows('delivery_platforms'), idMode: 'int',
    keyOf: r => { const n = r.name || r.platform_name; return n ? k(n) : null; }, transform: r => ({ values: { ...r, name: r.name || r.platform_name } }) });
  importTable(ctx, { table: 'store_business_calendar', cat: 'settings', rows: ctx.rows('store_business_calendar'), idMode: 'int',
    keyOf: r => (r.start_date && r.end_date ? k(r.start_date, r.end_date, r.mode, r.takeout_start_time, r.delivery_start_time) : null), transform: r => ({ values: { ...r } }) });
  importTable(ctx, { table: 'payment_methods', cat: 'settings', rows: ctx.rows('payment_methods'), idMode: 'int',
    keyOf: r => (r.code ? k(r.code) : null), transform: r => ({ values: { ...r } }) });
  importTable(ctx, { table: 'payment_gateways', cat: 'settings', rows: ctx.rows('payment_gateways'), idMode: 'int',
    keyOf: r => (r.code ? k(r.code) : null), transform: r => { const v = { ...r }; delete v.api_key; delete v.secret_key; return { values: v }; } });
  importTable(ctx, { table: 'customers', cat: 'settings', rows: ctx.rows('customers'), idMode: 'int',
    keyOf: r => (r.phone ? 'p' + k(r.phone) : (r.name ? 'n' + k(r.name) : null)), transform: r => ({ values: { ...r } }) });
  importTable(ctx, { table: 'crm_segments', cat: 'settings', rows: ctx.rows('crm_segments'), idMode: 'int',
    keyOf: r => (r.name ? k(r.name) : null), transform: r => ({ values: { ...r } }) });
}

// 完整取代：清除範圍（只清除本店、只清除備份檔確實包含的分類）
function purgeTablesFor(categories) {
  const set = new Set(categories);
  const order = [];
  const add = (...t) => { for (const x of t) if (!order.includes(x)) order.push(x); };
  if (set.has('analytics')) add('analytics_events', 'geo_visit_log');
  if (set.has('member_history')) add('line_member_history', 'line_member_order_links', 'line_friend_events', 'line_member_sessions');
  // R54.4／MBV2-HF1-C3：只在備份檔確實含「商品想買登記」且已選取時才清除；舊備份沒有此分類 → 不清除現有登記
  if (set.has('product_demand')) add('product_demand_consents', 'product_demand_requests');
  if (set.has('line_members')) add('line_member_tags', 'line_members');
  if (set.has('inventory_movements')) add('inventory_logs', 'ingredient_logs');
  if (set.has('popup')) add('popup_session_change_logs', 'popup_order_allocations', 'popup_session_product_sales', 'popup_session_products', 'popup_sessions', 'popup_campaigns', 'popup_locations');
  if (set.has('orders')) add('coupon_redemptions', 'order_logs', 'orders');
  else if (set.has('line_preorders')) add('line_order_logs', 'line_orders');
  if (set.has('ingredients')) add('product_ingredient_formulas', 'ingredient_batches', 'ingredient_thaw_batches', 'ingredients');
  if (set.has('discounts')) add('coupons', 'discount_categories', 'discount_campaigns');
  if (set.has('products')) add('product_analysis_group_aliases', 'product_analysis_group_items', 'product_analysis_groups', 'products');
  if (set.has('categories')) add('categories');
  if (set.has('settings')) add('settings', 'delivery_platforms', 'store_business_calendar', 'payment_methods', 'payment_gateways', 'customers', 'crm_segments');
  return order;
}
const PURGE_SQL = {
  line_orders: { table: 'orders', where: "store_id=? AND source='line'" },
  line_order_logs: { table: 'order_logs', where: "store_id=? AND order_id IN (SELECT id FROM orders WHERE store_id=? AND source='line')", params: 2 },
  settings: { table: 'settings', where: `store_id=? AND key NOT IN (${[...PROTECTED_SETTING_KEYS].map(x => `'${x}'`).join(',')})` },
};
function purgeCount(raw, storeId, name) {
  const p = PURGE_SQL[name];
  const table = p ? p.table : name;
  if (!tableExists(raw, table)) return { table, count: 0 };
  const where = p ? p.where : scopeWhere(name);
  const params = p && p.params === 2 ? [storeId, storeId] : [storeId];
  const r = rawGet(raw, `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params);
  return { table, count: r ? Number(r.c) : 0, where, params };
}

// ══════════════════════════════════════════════════════════════════════════
//  執行（預覽 = 交易內執行後 ROLLBACK；正式 = runDurableTransaction）
// ══════════════════════════════════════════════════════════════════════════
function validateImportOptions(info, storeId, opts) {
  const mode = String(opts.mode || 'skip');
  if (!['skip', 'merge', 'replace'].includes(mode)) throw new MigrationError('INVALID_MODE', `不支援的匯入模式：${mode}`);
  const categories = normalizeCategories(opts.categories || []);
  if (!categories.length) throw new MigrationError('EMPTY_SELECTION', '請至少選擇一個要匯入的資料分類');
  const notInFile = categories.filter(c => !info.categories_present.includes(c));
  if (notInFile.length) throw new MigrationError('CATEGORY_NOT_IN_FILE', `備份檔沒有這些分類：${notInFile.map(c => CATEGORY_BY_KEY[c].label).join('、')}`);
  const cross = !!(info.source_store_id && info.source_store_id !== storeId);
  if (cross && !opts.allowCrossStore) throw new MigrationError('CROSS_STORE_NOT_CONFIRMED', `備份檔屬於 ${info.source_store_id}，目前店家是 ${storeId}。跨店匯入需明確確認。`, 403);
  if (mode === 'replace') {
    if (info.backup_type !== 'full') throw new MigrationError('REPLACE_REQUIRES_FULL_BACKUP', '完整取代僅限使用完整備份檔，部分備份不得清除任何資料');
    const missing = info.categories_present.filter(c => !categories.includes(c));
    if (missing.length) throw new MigrationError('REPLACE_REQUIRES_ALL_CATEGORIES', `完整取代必須選擇備份檔內的全部分類（缺少：${missing.map(c => CATEGORY_BY_KEY[c].label).join('、')}）`);
    if (cross) throw new MigrationError('REPLACE_CROSS_STORE_FORBIDDEN', '完整取代不可用於跨店匯入');
  }
  return { mode, categories, cross };
}

// ══════════════════════════════════════════════════════════════════════════
//  R54.4／MBV2-HF1-C3.1：完整取代重建「商品」但保留「商品想買登記」時的商品關聯重新對應
// ══════════════════════════════════════════════════════════════════════════
// 情境：完整取代會清除並重新匯入 products（商品 id 以備份檔為準），但沒有
// product_demand 分類的舊備份不會清除既有登記與通知同意。若不處理，保留下來的資料
// 仍指向舊商品 id → 變成孤兒，或該 id 被備份裡另一款商品占用而指錯商品。
// 規則（預覽與正式匯入共用，皆在交易內執行；預覽最後 ROLLBACK）：
//   1. 清除前，記下每個被登記／同意引用的商品「可唯一確認的識別」：
//      目前商品的條碼（非空白）與名稱；商品已不存在時，使用登記上的商品名稱快照。
//   2. 商品匯入完成後，在目標店新商品中比對：條碼恰好 1 筆 → 採用；條碼多筆 → 無法唯一；
//      無條碼或條碼 0 筆 → 名稱恰好 1 筆 → 採用；名稱 0 筆 → 商品缺失；多筆 → 無法唯一。
//      不使用「數字 id 相同」作為依據。
//   3. 任何一個商品無法唯一對應 → 拋出 DEMAND_PRODUCT_REMAP_FAILED，整次完整取代回滾
//      （商品、訂單、登記與其他資料都不變），不回報成功。
//   4. 全部可對應 → 先檢查最終不得有重複有效登記，再以「負數暫存值 → 最終 id」兩階段逐筆更新（C3.2），
//      其餘欄位（會員、狀態、期限、份數、同意狀態）完全不動。不觸發任何通知。
function snapshotPreservedDemand(raw, storeId) {
  if (!tableExists(raw, 'product_demand_requests') || !tableExists(raw, 'product_demand_consents')) return null;
  const reqs = rawAll(raw, 'SELECT id, product_id, product_name_snapshot, line_user_id, status FROM product_demand_requests WHERE store_id=? ORDER BY id DESC', [storeId]);
  const cons = rawAll(raw, 'SELECT id, product_id FROM product_demand_consents WHERE store_id=?', [storeId]);
  if (!reqs.length && !cons.length) return null;
  const ident = new Map();
  for (const pid of new Set([...reqs, ...cons].map(r => Number(r.product_id)))) {
    const cur = rawGet(raw, 'SELECT id, name, product_barcode FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    const snap = reqs.find(r => Number(r.product_id) === pid && r.product_name_snapshot);
    ident.set(pid, {
      old_product_id: pid,
      existed: !!cur,
      name: cur ? String(cur.name || '') : (snap ? String(snap.product_name_snapshot) : ''),
      barcode: cur && cur.product_barcode ? String(cur.product_barcode) : '',
    });
  }
  return { reqs, cons, ident };
}
function remapPreservedDemand(raw, storeId, snap) {
  const prods = rawAll(raw, 'SELECT id, name, product_barcode FROM products WHERE store_id=?', [storeId]);
  const failures = [];
  const map = new Map();
  for (const it of snap.ident.values()) {
    let cand = [];
    let by = '';
    if (it.barcode) { cand = prods.filter(p => p.product_barcode && String(p.product_barcode) === it.barcode); by = 'barcode'; }
    if (!cand.length && it.name) { cand = prods.filter(p => String(p.name || '') === it.name); by = 'name'; }
    if (cand.length === 1) map.set(it.old_product_id, { to: Number(cand[0].id), by });
    else failures.push({ old_product_id: it.old_product_id, name: it.name, barcode: it.barcode, existed_before: it.existed,
      reason: cand.length === 0 ? 'missing' : 'ambiguous', candidates: cand.map(p => Number(p.id)) });
  }
  const countFor = (pid) => snap.reqs.filter(r => Number(r.product_id) === pid).length + snap.cons.filter(r => Number(r.product_id) === pid).length;
  if (failures.length) {
    const desc = failures.map(f => `「${f.name || ('#' + f.old_product_id)}」${f.reason === 'missing' ? '在備份商品中找不到' : `在備份商品中有 ${f.candidates.length} 筆同識別`}（${countFor(f.old_product_id)} 筆登記／同意）`).join('、');
    throw new MigrationError('DEMAND_PRODUCT_REMAP_FAILED',
      `完整取代會重建商品資料，但現有想買登記／通知同意引用的商品無法唯一對應：${desc}。已拒絕本次完整取代並整批回滾，資料庫未變更。請改用包含「商品想買登記」分類的完整備份，或確認備份中的商品名稱／條碼可唯一對應。`,
      409, { demand_remap_failures: failures });
  }
  // R54.4／MBV2-HF1-C3.2：最終衝突檢查——重新對應後同一會員對同一商品不得有兩筆 active 登記
  // （例如兩個舊商品對應到同一個新商品）。在任何更新之前判斷，衝突即拒絕並回滾。
  const finalActive = new Map();
  const conflicts = [];
  for (const r of snap.reqs) {
    if (r.status !== 'active') continue;
    const to = map.get(Number(r.product_id)).to;
    const key = to + '\u0001' + r.line_user_id;
    if (finalActive.has(key)) conflicts.push({ new_product_id: to, request_ids: [finalActive.get(key), r.id] });
    else finalActive.set(key, r.id);
  }
  if (conflicts.length) {
    throw new MigrationError('DEMAND_PRODUCT_REMAP_FAILED',
      `完整取代會重建商品資料，但重新對應後有 ${conflicts.length} 組「同一會員對同一商品」的有效登記會重複（商品 ${[...new Set(conflicts.map(c => c.new_product_id))].join('、')}）。已拒絕本次完整取代並整批回滾，資料庫未變更。`,
      409, { demand_remap_failures: conflicts.map(c => ({ reason: 'final_conflict', ...c })) });
  }
  // R54.4／MBV2-HF1-C3.2：分階段更新，支援 ID 互換（801↔701）與循環對應（A→B→C→A）。
  //   第 1 階段：要變動的資料列先改成「每列唯一的負數暫存值」（-id），不會與任何真實商品 id 或
  //              彼此衝突，active 部分唯一索引（store_id, product_id, line_user_id）全程保留、有效。
  //   第 2 階段：再改成最終商品 id。上面已確認最終狀態無重複，因此第 2 階段也不會撞索引。
  //   其餘欄位（會員、份數、偏好、週期、期限、狀態、同意關聯）完全不動。全部在同一交易內。
  const moveReq = snap.reqs.filter(r => map.get(Number(r.product_id)).to !== Number(r.product_id));
  const moveCon = snap.cons.filter(r => map.get(Number(r.product_id)).to !== Number(r.product_id));
  for (const r of moveReq) raw.run('UPDATE product_demand_requests SET product_id=? WHERE id=? AND store_id=?', [-Number(r.id), r.id, storeId]);
  for (const r of moveCon) raw.run('UPDATE product_demand_consents SET product_id=? WHERE id=? AND store_id=?', [-Number(r.id), r.id, storeId]);
  for (const r of moveReq) raw.run('UPDATE product_demand_requests SET product_id=? WHERE id=? AND store_id=?', [map.get(Number(r.product_id)).to, r.id, storeId]);
  for (const r of moveCon) raw.run('UPDATE product_demand_consents SET product_id=? WHERE id=? AND store_id=?', [map.get(Number(r.product_id)).to, r.id, storeId]);
  // 核對：不得殘留暫存值；每列都等於預期的最終商品
  const leftover = rawGet(raw, 'SELECT (SELECT COUNT(*) FROM product_demand_requests WHERE store_id=? AND product_id<0) + (SELECT COUNT(*) FROM product_demand_consents WHERE store_id=? AND product_id<0) AS c', [storeId, storeId]);
  if (leftover && Number(leftover.c) > 0) throw new MigrationError('DEMAND_PRODUCT_REMAP_FAILED', '想買登記商品關聯重新對應未完成，已整批回滾，資料庫未變更。', 500);
  const changes = [];
  for (const [from, m] of map) changes.push({ from, to: m.to, matched_by: m.by, rows: countFor(from) });
  return changes;
}

// R54.4／MBV2-HF1-C4：補貨通知紀錄永遠不被清除（防重歷史），完整取代重建商品時需重新對應其商品關聯。
//   與想買登記相同的唯一識別規則（條碼恰 1 筆 → 名稱恰 1 筆），但歷史紀錄無法唯一對應時不拒絕整次匯入，
//   而是改為 product_id=0（未連結），絕不指向另一款商品；防重依據（request_uuid／claim）不受影響。
function snapshotPreservedRestock(raw, storeId) {
  if (!tableExists(raw, 'restock_notify_batches') || !tableExists(raw, 'restock_notify_deliveries')) return null;
  const batches = rawAll(raw, 'SELECT id, product_id, product_name_snapshot FROM restock_notify_batches WHERE store_id=?', [storeId]);
  const dels = rawAll(raw, 'SELECT id, product_id FROM restock_notify_deliveries WHERE store_id=?', [storeId]);
  if (!batches.length && !dels.length) return null;
  const ident = new Map();
  for (const pid of new Set([...batches, ...dels].map(r => Number(r.product_id)).filter(x => x > 0))) {
    const cur = rawGet(raw, 'SELECT id, name, product_barcode FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    const snap = batches.find(b => Number(b.product_id) === pid && b.product_name_snapshot);
    ident.set(pid, { name: cur ? String(cur.name || '') : (snap ? String(snap.product_name_snapshot) : ''), barcode: cur && cur.product_barcode ? String(cur.product_barcode) : '' });
  }
  return { batches, dels, ident };
}
function remapPreservedRestock(raw, storeId, snap) {
  const prods = rawAll(raw, 'SELECT id, name, product_barcode FROM products WHERE store_id=?', [storeId]);
  const map = new Map();
  const out = [];
  for (const [pid, it] of snap.ident) {
    let cand = [];
    if (it.barcode) cand = prods.filter(p => p.product_barcode && String(p.product_barcode) === it.barcode);
    if (!cand.length && it.name) cand = prods.filter(p => String(p.name || '') === it.name);
    const to = cand.length === 1 ? Number(cand[0].id) : 0;
    map.set(pid, to);
    out.push({ from: pid, to, kind: 'restock_history', unlinked: to === 0 });
  }
  for (const b of snap.batches) { const to = Number(b.product_id) > 0 ? map.get(Number(b.product_id)) : 0; if (to !== Number(b.product_id)) raw.run('UPDATE restock_notify_batches SET product_id=? WHERE id=?', [to, b.id]); }
  for (const d of snap.dels) { const to = Number(d.product_id) > 0 ? map.get(Number(d.product_id)) : 0; if (to !== Number(d.product_id)) raw.run('UPDATE restock_notify_deliveries SET product_id=? WHERE id=?', [to, d.id]); }
  return out;
}

function executeImport(db, storeId, payload, info, opts) {
  const { mode, categories, cross } = validateImportOptions(info, storeId, opts);
  const dryRun = !!opts.dryRun;
  const raw = db._db;
  let ctx;
  const work = () => {
    const r = db._db; // runDurableTransaction 可能在失敗時換掉 _db，一律重新取得
    ensureLazyTables(r);
    ctx = new ImportContext(db, r, storeId, payload, info, { mode, dryRun, categories, genPublicCode: opts.genPublicCode });
    const before = {};
    const touched = new Set(categories.flatMap(c => CATEGORY_BY_KEY[c].tables));
    for (const t of touched) before[t] = countScoped(r, t, storeId);
    const purge = [];
    const baseline = {};
    // R54.4／MBV2-HF1-C3.1：完整取代會重建商品、但不會清除想買登記時，先記下商品識別
    const demandSnap = (mode === 'replace' && categories.includes('products') && !categories.includes('product_demand'))
      ? snapshotPreservedDemand(r, storeId) : null;
    // R54.4／MBV2-HF1-C4：補貨通知紀錄不會被清除 → 只要完整取代重建商品，就要重新對應
    const restockSnap = (mode === 'replace' && categories.includes('products')) ? snapshotPreservedRestock(r, storeId) : null;
    if (mode === 'replace') {
      for (const name of purgeTablesFor(categories)) {
        const pc = purgeCount(r, storeId, name);
        if (pc.count && pc.where) r.run(`DELETE FROM ${pc.table} WHERE ${pc.where}`, pc.params);
        purge.push({ table: pc.table, deleted: pc.count, scope: name });
        ctx.st(pc.table, null).purged += pc.count;
      }
    }
    for (const t of touched) baseline[t] = countScoped(r, t, storeId); // 清除後的基準筆數
    const c = ctx.cat;
    if (c.has('categories')) stepCategories(ctx);
    if (c.has('products')) stepProducts(ctx);
    if (c.has('ingredients')) stepIngredients(ctx);
    if (c.has('discounts')) stepDiscounts(ctx);
    if (c.has('popup')) stepPopupMaster(ctx);
    if (c.has('orders') || c.has('line_preorders')) stepOrders(ctx);
    if (c.has('popup')) stepPopupAfterOrders(ctx);
    if (c.has('inventory_movements')) stepInventoryMovements(ctx);
    if (c.has('line_members')) stepMembers(ctx);
    if (c.has('member_history')) stepMemberHistory(ctx);
    if (c.has('product_demand')) stepProductDemand(ctx);
    if (c.has('restock_notify')) stepRestockNotify(ctx);
    if (c.has('analytics')) stepAnalytics(ctx);
    if (c.has('settings')) stepSettings(ctx);
    ctx.freeStatements();
    // R54.4／MBV2-HF1-C3.1：商品已依備份重建 → 重新對應保留的登記／同意（無法唯一對應即拋錯回滾）
    const demandRemap = demandSnap ? remapPreservedDemand(r, storeId, demandSnap) : [];
    if (restockSnap) demandRemap.push(...remapPreservedRestock(r, storeId, restockSnap));

    // 交易內核對：每張表 匯入後筆數 − 匯入前筆數（扣除清除筆數）＝ 新增筆數
    const verification = [];
    for (const t of Object.keys(ctx.stats)) {
      const stt = ctx.stats[t];
      const after = countScoped(r, t, storeId);
      const b = before[t] != null ? before[t] : stt.existing_before;
      const base = baseline[t] != null ? baseline[t] : stt.existing_before;
      const expected = base + stt.added;
      verification.push({ table: t, before: b, purged: stt.purged, baseline: base, added: stt.added, after, expected, ok: after === expected });
      stt.count_after = after;
    }
    const totals = summarize(ctx.stats);
    const verifyOk = verification.every(v => v.ok);
    if (!dryRun) {
      if (totals.failed > 0) throw new MigrationError('IMPORT_ROW_FAILED', `有 ${totals.failed} 筆資料寫入失敗，已整批回滾，資料庫未變更`, 422, { stats: ctx.stats });
      if (!verifyOk) throw new MigrationError('IMPORT_VERIFY_FAILED', '匯入後筆數核對不一致，已整批回滾，資料庫未變更', 500, { verification });
    }
    return { stats: ctx.stats, totals, verification, verify_ok: verifyOk, purge, demand_remap: demandRemap };
  };

  let result;
  if (dryRun) {
    raw.run('BEGIN');
    try { result = work(); }
    finally { try { db._db.run('ROLLBACK'); } catch {} if (ctx) ctx.freeStatements(); }
  } else {
    try { result = db.runDurableTransaction(() => work()); }
    finally { if (ctx) ctx.freeStatements(); }
  }
  return {
    dry_run: dryRun, mode, categories, cross_store: cross,
    source_store_id: info.source_store_id, target_store_id: storeId,
    ...result,
    tables: Object.values(result.stats),
    status: result.totals.failed > 0 ? 'failed' : (result.totals.conflict + result.totals.missing_relation + result.totals.invalid > 0 ? 'completed_with_warnings' : 'success'),
  };
}

function summarize(stats) {
  const t = { source: 0, added: 0, updated: 0, skipped: 0, duplicate_in_file: 0, conflict: 0, missing_relation: 0, invalid: 0, failed: 0, purged: 0, protected: 0 };
  for (const s0 of Object.values(stats)) for (const key of Object.keys(t)) t[key] += s0[key] || 0;
  return t;
}

// 預覽的「選項指紋」：正式匯入必須帶同一組選項，確保使用者看過的預覽就是要執行的內容
function optionsFingerprint(uploadId, storeId, opts) {
  const o = { u: uploadId, s: storeId, m: opts.mode, c: normalizeCategories(opts.categories || []), x: !!opts.allowCrossStore };
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);
}

module.exports = {
  FORMAT, SCHEMA_VERSION, APP_VERSION, TZ, LEGACY_TYPE, PARTIAL_TYPE,
  CATEGORY_DEFS, CATEGORY_KEYS, CATEGORY_BY_KEY, EXCLUDED_TABLES, PROTECTED_SETTING_KEYS,
  MigrationError,
  resolveDateRange, orderTaipeiDate, utcStoredTaipeiDate, taipeiDateStr, taipeiIsoNow,
  normalizeCategories, buildExportChunks, exportPreview, exportFileName,
  inspectPayload, containsDangerousKeys, executeImport, validateImportOptions, optionsFingerprint, purgeTablesFor, purgeCount,
  countScoped, sanitizeJsonString, analyticsKey,
};
