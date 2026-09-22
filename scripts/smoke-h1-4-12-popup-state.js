#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-state.js
// H1.4.12 Phase 2｜快閃取餐狀態解析器（utils/popupPickup.js）真實函式測試。
// 直接 require 並呼叫真實函式，不做 source regex。

'use strict';

const pp = require('../utils/popupPickup');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 2 popup state resolver (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ══════════════════════════════════════════════════════════════════════
// 1. 日期驗證：閏年、世紀年、不存在日期
// ══════════════════════════════════════════════════════════════════════
assert(pp.isValidDateString('2024-02-29') === true, '1-leap 2024 是閏年，2/29 合法');
assert(pp.isValidDateString('2025-02-29') === false, '1-leap 2025 不是閏年，2/29 不合法');
assert(pp.isValidDateString('2000-02-29') === true, '1-century 2000 可被 400 整除，是閏年，2/29 合法');
assert(pp.isValidDateString('2100-02-29') === false, '1-century 2100 可被 100 整除但不能被 400 整除，不是閏年，2/29 不合法');
assert(pp.isValidDateString('2026-04-31') === false, '1-invalid-date 4 月沒有 31 日');
assert(pp.isValidDateString('2026-06-31') === false, '1-invalid-date 6 月沒有 31 日');
assert(pp.isValidDateString('2026-09-31') === false, '1-invalid-date 9 月沒有 31 日');
assert(pp.isValidDateString('2026-11-31') === false, '1-invalid-date 11 月沒有 31 日');
assert(pp.isValidDateString('2026-02-30') === false, '1-invalid-date 2 月沒有 30 日');
assert(pp.isValidDateString('2026-01-31') === true, '1-valid-date 1 月 31 日合法');
assert(pp.isValidDateString('2026-13-01') === false, '1-invalid-month 月份 13 不合法');
assert(pp.isValidDateString('2026-00-01') === false, '1-invalid-month 月份 0 不合法');
assert(pp.isValidDateString('') === false, '1-empty 空字串不合法');
assert(pp.isValidDateString(null) === false, '1-null null 不合法');
assert(pp.isValidDateString(undefined) === false, '1-undefined undefined 不合法');
assert(pp.isValidDateString(20260101) === false, '1-non-string 非字串（數字）不合法');
assert(pp.isValidDateString('2026-1-1') === false, '1-format 月/日缺前導零格式不合法（嚴格 YYYY-MM-DD）');
assert(pp.isValidDateString('2026/01/01') === false, '1-format 斜線分隔格式不合法');

// ══════════════════════════════════════════════════════════════════════
// 2. 時間驗證：時分秒越界、格式
// ══════════════════════════════════════════════════════════════════════
assert(pp.isValidTimeString('00:00') === true, '2-time 00:00 合法（下界）');
assert(pp.isValidTimeString('23:59') === true, '2-time 23:59 合法（上界）');
assert(pp.isValidTimeString('24:00') === false, '2-time 24:00 小時越界不合法');
assert(pp.isValidTimeString('12:60') === false, '2-time 12:60 分鐘越界不合法');
assert(pp.isValidTimeString('12:5') === false, '2-time 缺前導零不合法');
assert(pp.isValidTimeString('12:30:00') === false, '2-time 帶秒的格式對 pickup_start/end_time 而言不合法（只接受 HH:mm）');
assert(pp.isValidTimeString('') === false, '2-time 空字串不合法');
assert(pp.isValidTimeString(null) === false, '2-time null 不合法');
assert(pp.isValidTimeString('9:30') === false, '2-time 缺前導零的小時不合法');

// ══════════════════════════════════════════════════════════════════════
// 3. Asia/Taipei 固定 +08:00 解析：不依賴主機 process.env.TZ
// ══════════════════════════════════════════════════════════════════════
{
  const ms = pp.taipeiWallClockToEpochMs('2026-09-18', '17:30');
  // 2026-09-18T17:30:00+08:00 換算 UTC 應為 2026-09-18T09:30:00Z
  const expected = Date.parse('2026-09-18T09:30:00.000Z');
  assert(ms === expected, '3-taipei-fixed-offset 台北 17:30 正確換算為 UTC 09:30（與主機 TZ 無關）', `got=${ms} expected=${expected}`);
}
{
  // offset 格式不得被錯誤地「二次驗證或重複加八小時」：normalizeTaipeiDateTimeInput
  // 對已經帶 +08:00 的字串應該直接沿用該 offset，不會再疊加一次 +08:00。
  const raw = '2026-09-18T17:30:00+08:00';
  const normalized = pp.normalizeTaipeiDateTimeInput(raw);
  assert(normalized === raw, '3-no-double-offset 已帶 +08:00 的輸入正規化後不變（沒有被重複加 8 小時）', `got=${normalized}`);
  const ms1 = pp.epochMsOfNormalizedIso(normalized);
  const ms2 = pp.taipeiWallClockToEpochMs('2026-09-18', '17:30');
  assert(ms1 === ms2, '3-no-double-offset 兩種路徑算出來的 epoch ms 一致', `ms1=${ms1} ms2=${ms2}`);
}
{
  const noOffset = pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00');
  assert(noOffset === '2026-09-01T09:00:00+08:00', '3-normalize 不帶 offset 的輸入被正確補上 +08:00 與秒數', noOffset);
  const withSeconds = pp.normalizeTaipeiDateTimeInput('2026-09-01T09:00:30');
  assert(withSeconds === '2026-09-01T09:00:30+08:00', '3-normalize 帶秒數的輸入正確保留秒數', withSeconds);
}
assert(pp.normalizeTaipeiDateTimeInput('not-a-date') === null, '3-normalize-invalid 格式錯誤回傳 null');
assert(pp.normalizeTaipeiDateTimeInput('2026-02-30T09:00') === null, '3-normalize-invalid 不存在日期回傳 null');
assert(pp.normalizeTaipeiDateTimeInput(null) === null, '3-normalize-invalid null 回傳 null');
assert(pp.normalizeTaipeiDateTimeInput(12345) === null, '3-normalize-invalid 非字串回傳 null');

// ══════════════════════════════════════════════════════════════════════
// 4. normalizeAndValidateSessionTimes：完整順序驗證 + 不支援跨日
// ══════════════════════════════════════════════════════════════════════
function expectThrow(fn, name, expectedCode) {
  try {
    fn();
    fail(name, '預期應拋出例外，但沒有拋出');
  } catch (e) {
    if (expectedCode && e.code !== expectedCode) {
      fail(name, `拋出例外但 code 不符：got=${e.code} expected=${expectedCode}`);
    } else {
      pass(name);
    }
  }
}

{
  const ok = pp.normalizeAndValidateSessionTimes({
    pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '19:00',
    order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-17T21:00',
  });
  assert(ok.order_open_at === '2026-09-01T09:00:00+08:00', '4-valid 合法輸入通過並正確正規化 order_open_at');
}
expectThrow(() => pp.normalizeAndValidateSessionTimes({
  pickup_date: '2026-09-18', pickup_start_time: '19:00', pickup_end_time: '17:30', // 結束早於開始
  order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-17T21:00',
}), '4-cross-midnight 取餐結束時間早於開始時間（模擬跨日）被拒絕', 'POPUP_VALIDATION_ERROR');
expectThrow(() => pp.normalizeAndValidateSessionTimes({
  pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '17:30', // 相等也不允許
  order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-17T21:00',
}), '4-equal-start-end 取餐開始等於結束時間被拒絕', 'POPUP_VALIDATION_ERROR');
expectThrow(() => pp.normalizeAndValidateSessionTimes({
  pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '19:00',
  order_open_at: '2026-09-17T21:00', order_cutoff_at: '2026-09-01T09:00', // open 晚於 cutoff
}), '4-open-after-cutoff order_open_at 晚於 order_cutoff_at 被拒絕', 'POPUP_VALIDATION_ERROR');
expectThrow(() => pp.normalizeAndValidateSessionTimes({
  pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '19:00',
  order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-18T18:00', // cutoff 晚於 pickup_start
}), '4-cutoff-after-pickup-start order_cutoff_at 晚於 pickup_start_at 被拒絕', 'POPUP_VALIDATION_ERROR');
{
  // cutoff 恰好等於 pickup_start（規格：<=，這個是合法邊界）
  const ok = pp.normalizeAndValidateSessionTimes({
    pickup_date: '2026-09-18', pickup_start_time: '17:30', pickup_end_time: '19:00',
    order_open_at: '2026-09-01T09:00', order_cutoff_at: '2026-09-18T17:30',
  });
  assert(!!ok, '4-cutoff-equals-pickup-start order_cutoff_at 恰好等於 pickup_start_at 是合法邊界（<=）');
}

// ══════════════════════════════════════════════════════════════════════
// 5. resolvePopupSessionState：狀態優先權（campaign/session status）
// ══════════════════════════════════════════════════════════════════════
const baseTimes = {
  pickupDate: '2026-09-18', pickupStartTime: '17:30', pickupEndTime: '19:00',
  orderOpenAt: '2026-09-01T09:00:00+08:00', orderCutoffAt: '2026-09-17T21:00:00+08:00',
};
const openMs = pp.epochMsOfNormalizedIso(baseTimes.orderOpenAt);
const cutoffMs = pp.epochMsOfNormalizedIso(baseTimes.orderCutoffAt);
const pickupStartMs = pp.taipeiWallClockToEpochMs(baseTimes.pickupDate, baseTimes.pickupStartTime);
const pickupEndMs = pp.taipeiWallClockToEpochMs(baseTimes.pickupDate, baseTimes.pickupEndTime);
const midOrderingOpenMs = openMs + Math.floor((cutoffMs - openMs) / 2);

function resolveWith(campaignStatus, sessionStatus, now) {
  return pp.resolvePopupSessionState({ campaignStatus, sessionStatus, ...baseTimes, now });
}

// session 靜態狀態優先於一切（即使時間落在 ordering_open 區間內）
assert(resolveWith('published', 'cancelled', midOrderingOpenMs).state === 'cancelled', '5-priority session=cancelled 優先於時間狀態');
assert(resolveWith('published', 'archived', midOrderingOpenMs).state === 'archived', '5-priority session=archived 優先於時間狀態');
assert(resolveWith('published', 'draft', midOrderingOpenMs).state === 'draft', '5-priority session=draft 優先於時間狀態');
assert(resolveWith('published', 'paused', midOrderingOpenMs).state === 'paused', '5-priority session=paused 優先於時間狀態');
assert(resolveWith('published', 'cancelled', midOrderingOpenMs).can_order === false, '5-priority cancelled 狀態 can_order=false');
assert(resolveWith('published', 'archived', midOrderingOpenMs).can_order === false, '5-priority archived 狀態 can_order=false');

// campaign 非 published 時覆蓋 session（session 本身是 published）
assert(resolveWith('draft', 'published', midOrderingOpenMs).state === 'draft', '5-priority campaign=draft 覆蓋 session 時間狀態為 draft');
assert(resolveWith('paused', 'published', midOrderingOpenMs).state === 'paused', '5-priority campaign=paused 覆蓋 session 時間狀態為 paused');
assert(resolveWith('archived', 'published', midOrderingOpenMs).state === 'archived', '5-priority campaign=archived 覆蓋 session 時間狀態為 archived');
assert(resolveWith('draft', 'published', midOrderingOpenMs).can_order === false, '5-priority campaign 未發布時 can_order=false');

// archived 為終止狀態：一旦是 archived，不因任何 now 值而改變
assert(resolveWith('published', 'archived', openMs - 999999).state === 'archived', '5-archived-terminal archived 不受 now 值影響（scheduled 區間也一樣）');
assert(resolveWith('published', 'archived', pickupEndMs + 999999).state === 'archived', '5-archived-terminal archived 不受 now 值影響（ended 區間也一樣）');

// invalid 狀態（未知字串）不得讓函式拋例外，需回傳 invalid + error_code
{
  const r = pp.resolvePopupSessionState({ campaignStatus: 'published', sessionStatus: 'not-a-real-status', ...baseTimes, now: midOrderingOpenMs });
  assert(r.state === 'invalid' && r.can_order === false && !!r.error_code, '5-invalid-session-status 未知 session status 回傳 invalid，不拋例外', JSON.stringify(r));
}
{
  const r = pp.resolvePopupSessionState({ campaignStatus: 'not-a-real-status', sessionStatus: 'published', ...baseTimes, now: midOrderingOpenMs });
  assert(r.state === 'invalid' && r.can_order === false && !!r.error_code, '5-invalid-campaign-status 未知 campaign status 回傳 invalid，不拋例外', JSON.stringify(r));
}
{
  // 壞掉的時間資料（例如舊資料 pickup_date 被清空）不得讓函式拋例外
  const r = pp.resolvePopupSessionState({ campaignStatus: 'published', sessionStatus: 'published', pickupDate: '', pickupStartTime: '17:30', pickupEndTime: '19:00', orderOpenAt: baseTimes.orderOpenAt, orderCutoffAt: baseTimes.orderCutoffAt, now: midOrderingOpenMs });
  assert(r.state === 'invalid' && r.error_code === 'POPUP_INVALID_SESSION_TIMES', '5-invalid-times 壞掉的 pickup_date 回傳 invalid + POPUP_INVALID_SESSION_TIMES', JSON.stringify(r));
}
{
  // order_open_at/cutoff_at 順序矛盾的舊資料
  const r = pp.resolvePopupSessionState({
    campaignStatus: 'published', sessionStatus: 'published',
    pickupDate: baseTimes.pickupDate, pickupStartTime: baseTimes.pickupStartTime, pickupEndTime: baseTimes.pickupEndTime,
    orderOpenAt: baseTimes.orderCutoffAt, orderCutoffAt: baseTimes.orderOpenAt, // 對調，順序矛盾
    now: midOrderingOpenMs,
  });
  assert(r.state === 'invalid' && r.error_code === 'POPUP_INVALID_SESSION_TIMES', '5-invalid-order 順序矛盾的舊資料回傳 invalid，不拋例外', JSON.stringify(r));
}

// ══════════════════════════════════════════════════════════════════════
// 6. 時間邊界：前一毫秒、精確邊界、後一毫秒（五種狀態全覆蓋）
// ══════════════════════════════════════════════════════════════════════
function stateAt(now) { return resolveWith('published', 'published', now).state; }
function canOrderAt(now) { return resolveWith('published', 'published', now).can_order; }

// order_open_at 邊界
assert(stateAt(openMs - 1) === 'scheduled', '6-boundary order_open_at 前 1ms → scheduled');
assert(stateAt(openMs) === 'ordering_open', '6-boundary order_open_at 精確邊界 → ordering_open');
assert(stateAt(openMs + 1) === 'ordering_open', '6-boundary order_open_at 後 1ms → ordering_open');
assert(canOrderAt(openMs) === true, '6-boundary order_open_at 精確邊界 can_order=true');

// order_cutoff_at 邊界
assert(stateAt(cutoffMs - 1) === 'ordering_open', '6-boundary order_cutoff_at 前 1ms → ordering_open');
assert(stateAt(cutoffMs) === 'ordering_closed', '6-boundary order_cutoff_at 精確邊界 → ordering_closed');
assert(stateAt(cutoffMs + 1) === 'ordering_closed', '6-boundary order_cutoff_at 後 1ms → ordering_closed');
assert(canOrderAt(cutoffMs - 1) === true, '6-boundary order_cutoff_at 前 1ms can_order=true');
assert(canOrderAt(cutoffMs) === false, '6-boundary order_cutoff_at 精確邊界 can_order=false');

// pickup_start_at 邊界
assert(stateAt(pickupStartMs - 1) === 'ordering_closed', '6-boundary pickup_start_at 前 1ms → ordering_closed');
assert(stateAt(pickupStartMs) === 'pickup_active', '6-boundary pickup_start_at 精確邊界 → pickup_active');
assert(stateAt(pickupStartMs + 1) === 'pickup_active', '6-boundary pickup_start_at 後 1ms → pickup_active');

// pickup_end_at 邊界
assert(stateAt(pickupEndMs - 1) === 'pickup_active', '6-boundary pickup_end_at 前 1ms → pickup_active');
assert(stateAt(pickupEndMs) === 'ended', '6-boundary pickup_end_at 精確邊界 → ended');
assert(stateAt(pickupEndMs + 1) === 'ended', '6-boundary pickup_end_at 後 1ms → ended');

// 只有 ordering_open 的 can_order 是 true，其餘全部 false
['scheduled', 'ordering_closed', 'pickup_active', 'ended'].forEach((s) => {
  const sampleNow = {
    scheduled: openMs - 1, ordering_closed: cutoffMs, pickup_active: pickupStartMs, ended: pickupEndMs,
  }[s];
  const r = resolveWith('published', 'published', sampleNow);
  assert(r.state === s && r.can_order === false, `6-can-order-exclusive ${s} 狀態 can_order 必為 false`, JSON.stringify(r));
});
assert(resolveWith('published', 'published', openMs).can_order === true, '6-can-order-exclusive 只有 ordering_open 狀態 can_order=true');

// ══════════════════════════════════════════════════════════════════════
// 7. ended 不可寫入資料庫（SESSION_STORED_STATUSES 不含 ended）
// ══════════════════════════════════════════════════════════════════════
assert(!pp.SESSION_STORED_STATUSES.includes('ended'), '7-ended-not-stored SESSION_STORED_STATUSES 不包含 ended（只能動態計算）');
assert(pp.EFFECTIVE_STATES.includes('ended'), '7-ended-computed EFFECTIVE_STATES（輸出狀態）包含 ended');
assert(pp.SESSION_STORED_STATUSES.includes('draft') && pp.SESSION_STORED_STATUSES.includes('published')
  && pp.SESSION_STORED_STATUSES.includes('paused') && pp.SESSION_STORED_STATUSES.includes('cancelled')
  && pp.SESSION_STORED_STATUSES.includes('archived'), '7-stored-statuses SESSION_STORED_STATUSES 恰好包含五種合法值');
assert(pp.CAMPAIGN_STATUSES.length === 4 && pp.CAMPAIGN_STATUSES.every((s) => ['draft', 'published', 'paused', 'archived'].includes(s)),
  '7-campaign-statuses CAMPAIGN_STATUSES 恰好包含四種合法值');

// ══════════════════════════════════════════════════════════════════════
// 8. 其他 helper：public code、settings 正規化
// ══════════════════════════════════════════════════════════════════════
{
  const c1 = pp.generatePublicCode();
  const c2 = pp.generatePublicCode();
  assert(c1 !== c2, '8-public-code 兩次產生的 code 不同');
  assert(Buffer.from(c1, 'base64url').length === 16, '8-public-code 長度對應 16 bytes（128-bit）', c1);
}
assert(pp.normalizePopupPickupEnabledInput(true) === '1', '8-flag-normalize true → "1"');
assert(pp.normalizePopupPickupEnabledInput(false) === '0', '8-flag-normalize false → "0"');
assert(pp.normalizePopupPickupEnabledInput(1) === '1', '8-flag-normalize 1 → "1"');
assert(pp.normalizePopupPickupEnabledInput(0) === '0', '8-flag-normalize 0 → "0"');
assert(pp.normalizePopupPickupEnabledInput('1') === '1', '8-flag-normalize "1" → "1"');
assert(pp.normalizePopupPickupEnabledInput('0') === '0', '8-flag-normalize "0" → "0"');
assert(pp.normalizePopupPickupEnabledInput('true') === null, '8-flag-normalize "true" 字串不合法');
assert(pp.normalizePopupPickupEnabledInput(null) === null, '8-flag-normalize null 不合法');
assert(pp.normalizePopupPickupEnabledInput([]) === null, '8-flag-normalize 陣列不合法');
assert(pp.normalizePopupPickupEnabledInput({}) === null, '8-flag-normalize 物件不合法');

printSummary();
