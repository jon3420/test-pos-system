// utils/popupPickup.js — H1.4.12 Phase 2
//
// 快閃取餐「日期／時間驗證、正規化、場次狀態解析」的單一事實來源。所有
// route（管理 API、未來 Phase 3 的公開 API／結帳權威驗證器）一律呼叫這裡
// 的函式，不得自行重寫一份判斷邏輯，避免規格禁止的「多處各自兜一份規則」。
'use strict';

const crypto = require('crypto');

// ── 合法儲存狀態（規格六） ────────────────────────────────────────────
const CAMPAIGN_STATUSES = ['draft', 'published', 'paused', 'archived'];
const SESSION_STORED_STATUSES = ['draft', 'published', 'paused', 'cancelled', 'archived'];
const PRODUCT_SCOPES = ['all_takeout', 'selected'];

// ── 對外輸出的 effective state（規格六：ended 只能動態計算，不落地）───
const EFFECTIVE_STATES = [
  'draft', 'paused', 'cancelled', 'archived',
  'scheduled', 'ordering_open', 'ordering_closed', 'pickup_active', 'ended', 'invalid',
];

// ── 結構化 validation error ──────────────────────────────────────────
class PopupValidationError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'PopupValidationError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}
function fail(code, message, status = 400, extra = {}) {
  throw new PopupValidationError(code, message, status, extra);
}

// ══════════════════════════════════════════════════════════════════════
// 日期／時間格式驗證 —— 嚴格格式 + 真實曆法檢查（拒絕 2026-02-30 之類）
// ══════════════════════════════════════════════════════════════════════
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Phase 2.1 修正：明確 Gregorian 閏年計算，不使用 new Date(Date.UTC(y, m, 0))
// 取得月天數——Date.UTC() 對「數值介於 0~99 之間的 year 參數」有 legacy
// 兩位數年份特殊處理（Date.UTC(99,...) 會被當成 1999），即使我們的來源字串
// 一律是 4 碼年份（例如 '0099'），一旦轉成 Number 就變回純數字 99，一樣會觸發
// 這個特殊處理，導致當年判斷錯誤。改用純算術判斷完全避開這個陷阱。
function isGregorianLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
const DAYS_IN_MONTH_NORMAL = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInGregorianMonth(y, m) {
  if (m === 2 && isGregorianLeapYear(y)) return 29;
  return DAYS_IN_MONTH_NORMAL[m - 1];
}

function isValidDateString(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const days = daysInGregorianMonth(y, mo);
  return d >= 1 && d <= days;
}

function isValidTimeString(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

// Asia/Taipei 全年固定 UTC+8（台灣不採行日光節約時間），因此把「日期＋時間」
// 解讀為台北當地時間，不需要 Intl 時區資料庫，也不依賴主機
// process.env.TZ——直接固定組出帶 +08:00 offset 的 ISO 字串再用
// Date.parse()，天生不受執行環境時區影響（已在測試以 TZ=UTC/Asia/Taipei/
// Asia/Tokyo 三種環境驗證結果一致）。
const TAIPEI_OFFSET = '+08:00';

function taipeiWallClockToEpochMs(dateStr, timeStr) {
  if (!isValidDateString(dateStr) || !isValidTimeString(timeStr)) return null;
  const ms = Date.parse(`${dateStr}T${timeStr}:00${TAIPEI_OFFSET}`);
  return Number.isFinite(ms) ? ms : null;
}

// order_open_at / order_cutoff_at 前端輸入正規化：只接受 'YYYY-MM-DDTHH:mm'
// 或 'YYYY-MM-DDTHH:mm:ss'（一律視為 Asia/Taipei 當地時間，落地補上
// +08:00），或「已經正規化過、offset 精確等於 +08:00」的字串直接通過（讓
// 「重新驗證資料庫已存的值」與「驗證前端新輸入」可以共用同一個函式）。
//
// Phase 2.1 修正：offset 部分只允許「完全不帶」或「精確等於 +08:00」兩種，
// 不再用萬用的 `Z|[+-]\d{2}:\d{2}` 接受任何 offset 並原樣保留——那樣會讓
// `Z`／`+09:00`／`-08:00` 等非台北時間的輸入被誤當成「已經是對的」而直接
// 落地，違反「一律正規化為 Asia/Taipei +08:00」的規則。凡是帶了非
// `+08:00` 的 offset，一律視為格式不合法，回傳 null（由呼叫端轉成 400，
// 或在讀取舊資料時視為 invalid，不做任何猜測性轉換）。
const OPEN_CUTOFF_INPUT_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(\+08:00)?$/;

function normalizeTaipeiDateTimeInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed !== raw) return null; // 不接受前後帶空白的輸入，避免曖昧解讀
  const m = OPEN_CUTOFF_INPUT_RE.exec(trimmed);
  if (!m) return null; // 含 Z、+09:00、-08:00 等非 +08:00 offset 一律在這裡被拒絕
  const [, datePart, hh, mm, ss] = m;
  if (!isValidDateString(datePart)) return null;
  const iso = `${datePart}T${hh}:${mm}:${ss || '00'}${TAIPEI_OFFSET}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

// 嚴格 canonical 格式：正規化輸出／資料庫既有值都必須長這樣，不接受任何
// 其他 offset 或變形。
const CANONICAL_TAIPEI_ISO_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\+08:00$/;

// 已經是正規化 canonical ISO 字串（'YYYY-MM-DDTHH:mm:ss+08:00'）時，取其
// epoch ms；用於解析「已從資料庫讀出」的 order_open_at/order_cutoff_at，
// 這兩欄本來就應該已經是 normalizeTaipeiDateTimeInput() 正規化過的格式。
//
// Phase 2.1 修正：不再對未經驗證的字串直接呼叫環境相依的 Date.parse()——
// 先用嚴格的 canonical 格式（含精確 +08:00 offset）+ 真實日期/時間合法性
// 檢查過關，才進入 Date.parse()。資料庫裡任何無 offset、非 ISO、非法日期、
// 非 +08:00 offset 的舊資料/壞資料，一律回傳 null，呼叫端據此判斷為
// invalid，絕不會因為 Date.parse() 對「無 offset 字串」採用「當地時區」
// 解讀（隨執行主機 TZ 而變）而產生不一致的結果。
function epochMsOfNormalizedIso(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const m = CANONICAL_TAIPEI_ISO_RE.exec(iso);
  if (!m) return null;
  const [, datePart, hh, mm, ss] = m;
  if (!isValidDateString(datePart)) return null;
  // hh/mm/ss 已被正則的字元類別限制在合法範圍（00-23 / 00-59 / 00-59），
  // 這裡不需要再另外檢查；格式與曆法都驗證通過後才呼叫 Date.parse()，
  // 此時字串已是完全固定、無二義性的 canonical 格式，Date.parse() 對它的
  // 解讀不受執行環境時區影響（offset 已明確寫死在字串裡）。
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ══════════════════════════════════════════════════════════════════════
// 場次時間正規化與驗證（規格六）：
//   order_open_at < order_cutoff_at <= pickup_start_at < pickup_end_at
// 不支援跨日取餐；格式或順序不合法一律 fail()（呼叫端會轉成 400）。
// ══════════════════════════════════════════════════════════════════════
function normalizeAndValidateSessionTimes(input) {
  const { pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at } = input;

  if (!isValidDateString(pickup_date)) {
    fail('POPUP_VALIDATION_ERROR', 'pickup_date 格式錯誤或日期不存在，需為 YYYY-MM-DD');
  }
  if (!isValidTimeString(pickup_start_time)) {
    fail('POPUP_VALIDATION_ERROR', 'pickup_start_time 格式錯誤，需為 HH:mm');
  }
  if (!isValidTimeString(pickup_end_time)) {
    fail('POPUP_VALIDATION_ERROR', 'pickup_end_time 格式錯誤，需為 HH:mm');
  }

  const normalizedOpenAt = normalizeTaipeiDateTimeInput(order_open_at);
  if (!normalizedOpenAt) {
    fail('POPUP_VALIDATION_ERROR', 'order_open_at 格式錯誤或日期不存在，需為 YYYY-MM-DDTHH:mm[:ss]');
  }
  const normalizedCutoffAt = normalizeTaipeiDateTimeInput(order_cutoff_at);
  if (!normalizedCutoffAt) {
    fail('POPUP_VALIDATION_ERROR', 'order_cutoff_at 格式錯誤或日期不存在，需為 YYYY-MM-DDTHH:mm[:ss]');
  }

  const pickupStartAtMs = taipeiWallClockToEpochMs(pickup_date, pickup_start_time);
  const pickupEndAtMs = taipeiWallClockToEpochMs(pickup_date, pickup_end_time);
  const openAtMs = epochMsOfNormalizedIso(normalizedOpenAt);
  const cutoffAtMs = epochMsOfNormalizedIso(normalizedCutoffAt);

  if (pickupEndAtMs <= pickupStartAtMs) {
    fail('POPUP_VALIDATION_ERROR', 'pickup_end_time 必須晚於 pickup_start_time（第一版不支援跨日取餐）');
  }
  if (!(openAtMs < cutoffAtMs && cutoffAtMs <= pickupStartAtMs && pickupStartAtMs < pickupEndAtMs)) {
    fail('POPUP_VALIDATION_ERROR', '時間順序必須符合 order_open_at < order_cutoff_at <= pickup_start_at < pickup_end_at');
  }

  return {
    pickup_date,
    pickup_start_time,
    pickup_end_time,
    order_open_at: normalizedOpenAt,
    order_cutoff_at: normalizedCutoffAt,
  };
}

// ══════════════════════════════════════════════════════════════════════
// resolvePopupSessionState —— 單一事實來源，輸出統一 effective state。
//
// 優先順序（規格六明文要求）：
//   1. session 的靜態終止狀態（cancelled／archived）優先於一切。
//   2. session 為 draft／paused 時直接反映（尚未牽涉時間或 campaign）。
//   3. session 為 published，但 campaign 非 published 時，campaign 狀態
//      覆蓋 session 的時間狀態（campaign draft/paused/archived → 對應
//      session 也顯示同一個狀態，因為整個活動都還沒公開，底下場次不該
//      表現得像是可訂購）。
//   4. session 與 campaign 皆 published，才用時間邊界計算五種時間狀態。
//   5. 任何一步驟遇到無法解析的舊資料／壞資料，回傳 'invalid'，附
//      error_code，絕不拋出例外——單一場次的壞資料不得讓整個列表 API 崩潰。
// ══════════════════════════════════════════════════════════════════════
function resolvePopupSessionState(params) {
  const {
    campaignStatus,
    sessionStatus,
    pickupDate,
    pickupStartTime,
    pickupEndTime,
    orderOpenAt,
    orderCutoffAt,
    now = Date.now(),
  } = params || {};

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    return { state: 'invalid', can_order: false, error_code: 'POPUP_INVALID_NOW' };
  }

  if (sessionStatus === 'cancelled') return { state: 'cancelled', can_order: false };
  if (sessionStatus === 'archived') return { state: 'archived', can_order: false };
  if (sessionStatus === 'draft') return { state: 'draft', can_order: false };
  if (sessionStatus === 'paused') return { state: 'paused', can_order: false };

  if (sessionStatus !== 'published') {
    return { state: 'invalid', can_order: false, error_code: 'POPUP_INVALID_SESSION_STATUS' };
  }

  if (campaignStatus !== 'published') {
    if (campaignStatus === 'draft') return { state: 'draft', can_order: false };
    if (campaignStatus === 'paused') return { state: 'paused', can_order: false };
    if (campaignStatus === 'archived') return { state: 'archived', can_order: false };
    return { state: 'invalid', can_order: false, error_code: 'POPUP_INVALID_CAMPAIGN_STATUS' };
  }

  if (!isValidDateString(pickupDate) || !isValidTimeString(pickupStartTime) || !isValidTimeString(pickupEndTime)) {
    return { state: 'invalid', can_order: false, error_code: 'POPUP_INVALID_SESSION_TIMES' };
  }

  const pickupStartAtMs = taipeiWallClockToEpochMs(pickupDate, pickupStartTime);
  const pickupEndAtMs = taipeiWallClockToEpochMs(pickupDate, pickupEndTime);
  const openAtMs = epochMsOfNormalizedIso(orderOpenAt);
  const cutoffAtMs = epochMsOfNormalizedIso(orderCutoffAt);

  if (
    pickupStartAtMs == null || pickupEndAtMs == null || openAtMs == null || cutoffAtMs == null ||
    !(openAtMs < cutoffAtMs && cutoffAtMs <= pickupStartAtMs && pickupStartAtMs < pickupEndAtMs)
  ) {
    return { state: 'invalid', can_order: false, error_code: 'POPUP_INVALID_SESSION_TIMES' };
  }

  let state;
  if (nowMs < openAtMs) state = 'scheduled';
  else if (nowMs < cutoffAtMs) state = 'ordering_open';
  else if (nowMs < pickupStartAtMs) state = 'ordering_closed';
  else if (nowMs < pickupEndAtMs) state = 'pickup_active';
  else state = 'ended';

  return { state, can_order: state === 'ordering_open' };
}

// ══════════════════════════════════════════════════════════════════════
// 快閃取餐總開關（規格 7.4 / Phase 1 已 seed 到 settings，這裡只負責讀取）
// ══════════════════════════════════════════════════════════════════════
function isPopupPickupEnabled(db, storeId) {
  const row = db.get("SELECT value FROM settings WHERE store_id=? AND key='popup_pickup_enabled'", [storeId]);
  return !!row && row.value === '1';
}

// 落地正規化：只接受 true/false/1/0/'1'/'0'，其餘一律視為不合法（由呼叫端 400）。
function normalizePopupPickupEnabledInput(raw) {
  if (raw === true || raw === 1 || raw === '1') return '1';
  if (raw === false || raw === 0 || raw === '0') return '0';
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 安全的公開代碼產生器（規格：至少 128-bit 不可預測隨機值，不使用流水號）
// ══════════════════════════════════════════════════════════════════════
function generatePublicCode() {
  return crypto.randomBytes(16).toString('base64url'); // 16 bytes = 128 bits
}

// ══════════════════════════════════════════════════════════════════════
// 通用欄位驗證 helper（管理 API 共用）
// ══════════════════════════════════════════════════════════════════════
function isNonEmptyString(v, maxLen = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}
function isOptionalString(v, maxLen = 1000) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= maxLen);
}
function isNonNegativeInt(v) {
  // Phase 2.1 修正：改用 Number.isSafeInteger()，拒絕超出 JS 安全整數範圍
  // 的值（例如 9007199254740992 = 2^53，Number.isInteger() 對它仍回傳
  // true，但已經無法精確表示，寫進 SQLite INTEGER 或序列化成 JSON 時都
  // 可能失真）。所有外部整數欄位（product_id/quota_qty/max_orders/
  // sort_order/expected_revision）一律套用這兩個 helper。
  return Number.isSafeInteger(v) && v >= 0;
}
function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}
function isValidLat(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}
function isValidLng(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

// ── Phase 2.1 新增：嚴格 boolean/0-1 正規化（不使用 truthy coercion）──
// 只接受 true/false/1/0/'1'/'0'；其餘（包含字串 'true'/'false'/'yes'、
// 陣列、物件、null）一律回傳 null，由呼叫端視為不合法輸入（400）。
// 呼叫端負責處理「未提供欄位時沿用既有預設值」的邏輯，這個函式只負責
// 「有提供值時，這個值是否是嚴格合法的布林/0/1 表示法」。
function normalizeStrictBoolTo01(raw) {
  if (raw === true || raw === 1 || raw === '1') return 1;
  if (raw === false || raw === 0 || raw === '0') return 0;
  return null;
}

module.exports = {
  CAMPAIGN_STATUSES,
  SESSION_STORED_STATUSES,
  PRODUCT_SCOPES,
  EFFECTIVE_STATES,
  PopupValidationError,
  fail,
  isValidDateString,
  isValidTimeString,
  taipeiWallClockToEpochMs,
  normalizeTaipeiDateTimeInput,
  epochMsOfNormalizedIso,
  normalizeAndValidateSessionTimes,
  resolvePopupSessionState,
  isPopupPickupEnabled,
  normalizePopupPickupEnabledInput,
  generatePublicCode,
  isNonEmptyString,
  isOptionalString,
  isNonNegativeInt,
  isPositiveInt,
  normalizeStrictBoolTo01,
  isValidLat,
  isValidLng,
};
