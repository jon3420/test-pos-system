// routes/line-orders.js — SaaS R1 + LINE 接單與可售管理中心 v1
// 修改重點：
//   1. 外帶/外送完全獨立判斷（各自 enabled/cutoff/prep/business_hours）
//   2. LINE 專屬可售份數（line_quota_*），不動主庫存
//   3. 動態取餐時間：max(現在+prep, 營業開始)
//   4. 公休日/店休日攔截（line_closed_weekdays / line_closed_dates）
//   5. 行銷型售完：real_sold_out vs cutoff_sold_out，均不扣主庫存
//   6. 結帳雙重驗證（加入購物車 + 送單前）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { toGrams, fromGrams } = require('../utils/unitConvert');
const { getProductInventoryStatus } = require('../utils/inventoryHelper');
const { resolveAddFriendUrl } = require('../utils/lineCheckoutHandoff');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { validateCoupon } = require('./coupons'); // fix18-05
const { getStoreFeatures } = require('../middleware/featureGate'); // fix18-05 coupon gate
const { applyOrderStatusChange } = require('../utils/orderStatusFlow'); // hotfix13-BUG7：統一狀態機（單一來源，orders.js / online-orders.js 共用）
const { computeTodayStatus: computeCalendarStatus } = require('./business-calendar'); // Business Calendar V2：營業行事曆覆蓋層
const { logServerEvent, buildTrackingMetadata } = require('../utils/analyticsLog'); // fix18-10-hotfix23-A/D：Analytics Foundation + Ads Attribution
const { touchMemberOnOrder, recordMemberPurchase } = require('../utils/lineMemberStats'); // fix18-10-hotfix23-E：LINE 會員入口
const { verifyMemberSession } = require('../utils/lineMemberSession'); // fix18-10-hotfix23-E：安全 Member Session
const { buildPickupSnapshot, resolvePickupLocation, resolveSameAsStoreFlag } = require('../utils/pickupLocation'); // fix18-10-hotfix26-F4/F5：取餐門市/地址/取餐地點設定共用 helper

// ── fix18-06：外送費後端重算 helper ──────────────────
const SERVER_KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || '';

function getSettingVal(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

async function recalcDeliveryFee(db, storeId, destLat, destLng, subtotal) {
  const key = SERVER_KEY();
  if (!key) throw Object.assign(new Error('GOOGLE_MAPS_SERVER_KEY 未設定'), { reason: 'maps_unavailable' });

  const storeLat = parseFloat(getSettingVal(db, storeId, 'store_lat', ''));
  const storeLng = parseFloat(getSettingVal(db, storeId, 'store_lng', ''));
  if (isNaN(storeLat) || isNaN(storeLng) || !storeLat || !storeLng) {
    throw Object.assign(new Error('店家座標尚未設定，無法計算外送費'), { reason: 'maps_unavailable' });
  }

  const maxDistKm = parseFloat(getSettingVal(db, storeId, 'delivery_max_distance_km', '7'));
  const basicFee  = parseFloat(getSettingVal(db, storeId, 'delivery_basic_fee', '50'));
  const freeThr   = parseFloat(getSettingVal(db, storeId, 'delivery_free_threshold', '1000'));
  const sub       = parseFloat(subtotal) || 0;

  let rules = [];
  try {
    const raw = getSettingVal(db, storeId, 'delivery_distance_fee_rules', '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) { rules = parsed; rules.sort((a, b) => a.max_km - b.max_km); }
  } catch {}

  // Google Routes API
  const routesBody = {
    origin:      { location: { latLng: { latitude: storeLat,  longitude: storeLng  } } },
    destination: { location: { latLng: { latitude: destLat,   longitude: destLng   } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    languageCode: 'zh-TW',
  };

  let distKm;
  try {
    const gResp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   key,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify(routesBody),
      timeout: 10000,
    });
    if (!gResp.ok) throw new Error(`Routes API HTTP ${gResp.status}`);
    const gData = await gResp.json();
    if (!gData.routes || !gData.routes.length) throw new Error('Routes API 無路線');
    distKm = Math.round(gData.routes[0].distanceMeters / 10) / 100;
  } catch (gErr) {
    console.error('[line-orders] Routes API 失敗:', gErr.message);
    throw Object.assign(new Error('外送距離計算暫時無法使用，請稍後再試或改選外帶取餐'), { reason: 'maps_unavailable' });
  }

  if (distKm > maxDistKm) {
    throw Object.assign(
      new Error(`距離 ${distKm} 公里，超過本店外送範圍（最遠 ${maxDistKm} 公里）`),
      { reason: 'out_of_range', distance_km: distKm }
    );
  }

  const matched = rules.find(r => distKm <= r.max_km);
  if (!matched) {
    throw Object.assign(
      new Error(`距離 ${distKm} 公里，超過外送費級距設定範圍`),
      { reason: 'out_of_range', distance_km: distKm }
    );
  }

  const rawFee = matched.fee;
  let deliveryFee = rawFee;
  if (freeThr > 0 && sub >= freeThr) {
    const reduced = rawFee - basicFee;
    deliveryFee = reduced > 0 ? reduced : 0;
  }

  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${storeLat},${storeLng}&destination=${destLat},${destLng}&travelmode=driving`;
  return { distKm, deliveryFee, rawFee, mapsUrl };
}

function orderNumber() {
  const n = new Date(), p = (v,l=2) => String(v).padStart(l,'0');
  return `LINE-${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

function getSetting(db, storeId, key, def='') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// ── Hotfix15 LINE 營業中心 V3：顧客可提前預訂天數（0~60，預設14）──
function getPreorderDaysLimit(db, storeId) {
  const raw = getSetting(db, storeId, 'line_preorder_days_limit', '14');
  let n = parseInt(raw, 10);
  if (isNaN(n)) n = 14;
  return Math.max(0, Math.min(60, n));
}
// 兩個 YYYY-MM-DD 之間相差天數（b - a），使用安全解析避免時區誤差
function dateDiffDays(aStr, bStr) {
  const a = parseLocalDate(aStr), b = parseLocalDate(bStr);
  return Math.round((b - a) / 86400000);
}
// YYYY-MM-DD → M/D（供自動休假公告文案顯示用，如 "7/5"）
function fmtMDShort(s) {
  if (!s) return '';
  const p = String(s).split('-');
  return p.length >= 3 ? `${Number(p[1])}/${Number(p[2])}` : s;
}
// Hotfix17：商家公告類型 icon
const ANNOUNCEMENT_ICONS = {
  general: '📢', holiday: '🏖️', promo: '🎉', new_product: '🆕',
  delivery: '📦', member: '🎁', custom: '✨',
};

// ── 台灣時間工具 ──────────────────────────────────────────
function twNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function twDateStr(d) {
  const dt = d || twNow();
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function timeToMins(hhmm) {
  const [h, m] = String(hhmm||'').split(':').map(Number);
  return (h||0)*60 + (m||0);
}
function minsToTime(mins) {
  return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
}

// ── parseLocalDate：安全解析 YYYY-MM-DD，不受伺服器時區影響 ──
// 重要：不要用 new Date('YYYY-MM-DD') → UTC midnight → 在 UTC 伺服器 getDay() 正確
// 但不要用 new Date('YYYY-MM-DT00:00:00+08:00') → 轉成 UTC 前一天 → getDay() 錯位
function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);  // 本地 Date，getDay() 永遠正確
}

const WD_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];

// ── Business Calendar V2：取得某日命中的行事曆覆蓋設定（無命中則 matched:false）──
function getCalendarDateInfo(db, storeId, dateStr) {
  try { return computeCalendarStatus(db, storeId, dateStr); }
  catch { return { matched: false }; }
}

// ── Hotfix16 BUG-003：日期休假狀態單一判斷函式 ──────────────
// 優先序（由高到低，命中即回傳，不再往下判斷）：
//   1. Business Calendar（mode=closed → closed:true；custom_hours/open_all_day → closed:false，且完全覆蓋今日臨時休息與固定公休）
//   2. 今日臨時休息（line_today_closed，僅在 dateStr 為「今天」時才可能命中；Business Calendar 命中時一律不檢查此項）
//   3. 固定公休（line_closed_weekdays）/ 指定店休日（line_closed_dates）
// 回傳：{ closed, source: 'calendar'|'today_closed'|'weekly'|'specific'|null, isWeekly, calendar }
function getDateClosedStatus(db, storeId, dateStr) {
  const cal = getCalendarDateInfo(db, storeId, dateStr);
  if (cal.matched) {
    return { closed: cal.mode === 'closed', source: 'calendar', isWeekly: false, calendar: cal };
  }
  const todayStr = twDateStr();
  if (dateStr === todayStr) {
    const todayClosed = getSetting(db, storeId, 'line_today_closed', '0') === '1'
      && getSetting(db, storeId, 'line_today_closed_date', '') === todayStr;
    if (todayClosed) {
      return { closed: true, source: 'today_closed', isWeekly: false, calendar: null };
    }
  }
  const dow = WD_KEYS[parseLocalDate(dateStr).getDay()];  // 安全解析
  const closedWds = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_weekdays', '[]')); } catch { return []; } })();
  const closedDts = (() => { try { return JSON.parse(getSetting(db, storeId, 'line_closed_dates', '[]')); } catch { return []; } })();
  const isWeekly   = closedWds.includes(dow);
  const isSpecific = closedDts.includes(dateStr);
  return {
    closed: isWeekly || isSpecific,
    source: isWeekly ? 'weekly' : (isSpecific ? 'specific' : null),
    isWeekly, calendar: null,
  };
}

// ── 公休/店休日判斷（向後相容包裝，維持原本 {closed,isWeekly,calendar} 介面）──
// 內部已改用 getDateClosedStatus()，自動套用 Hotfix16 的優先序（Business Calendar > 今日臨時休息 > 固定公休）
function isClosedDate(db, storeId, dateStr) {
  const r = getDateClosedStatus(db, storeId, dateStr);
  return { closed: r.closed, isWeekly: r.isWeekly, calendar: r.calendar };
}

// ── fix18-10-hotfix22E：統一「最終生效營業時段」單一來源 ─────────────────
// getEffectiveModeSchedule(db, storeId, mode, dateStr, modeSettings)
//   mode: 'takeout' | 'delivery'
//   回傳：{ enabled, start, end, source }
//     source='business_calendar'：該日命中 Business Calendar 特殊營業/全天營業，且已依「該模式在該
//       行事曆項目是否開放」判斷 enabled；enabled=false 時 start/end 為 null（不得回退每週營業時間）。
//     source='weekly_schedule'：沒有命中行事曆（或行事曆本身是 mode='closed' 整店休假，那種情況由
//       上層 getDateClosedStatus() 先行攔截，不會走到這裡），回退舊版「每週營業時間」設定。
// 本函式是 GET /shop、GET /menu、GET /timeslots、POST /validate-cart（validateOrderConditions）、
// POST /（新增訂單）共用的單一來源，避免各處各自判斷、彼此不一致。
function getEffectiveModeSchedule(db, storeId, mode, dateStr, modeSettings) {
  const cal = getCalendarDateInfo(db, storeId, dateStr);
  if (cal.matched && cal.mode !== 'closed') {
    const modeEnabledInCal = mode === 'takeout' ? cal.takeout_enabled : cal.delivery_enabled;
    if (!modeEnabledInCal) {
      return { enabled: false, start: null, end: null, source: 'business_calendar' };
    }
    if (cal.mode === 'open_all_day') {
      return { enabled: true, start: '00:00', end: '23:59', source: 'business_calendar' };
    }
    // custom_hours：使用行事曆設定的該模式時段（不得回退每週營業時間）
    const openT  = mode === 'takeout' ? cal.takeout_start_time : cal.delivery_start_time;
    const closeT = mode === 'takeout' ? cal.takeout_end_time   : cal.delivery_end_time;
    return { enabled: true, start: openT || '00:00', end: closeT || '23:59', source: 'business_calendar' };
  }
  // 沒有命中行事曆（或行事曆當天是整店休假，由上層 getDateClosedStatus 攔截）→ 回退每週營業時間
  const wdKey = WD_KEYS[parseLocalDate(dateStr).getDay()];
  const dh = modeSettings.bizHours[wdKey];
  const bizHoursEmpty = !modeSettings.bizHours || Object.keys(modeSettings.bizHours).length === 0;
  if (!bizHoursEmpty && (!dh || !dh.enabled)) {
    return { enabled: false, start: null, end: null, source: 'weekly_schedule' };
  }
  return {
    enabled: true,
    start: dh ? (dh.open  || '09:00') : '09:00',
    end:   dh ? (dh.close || '21:00') : '21:00',
    source: 'weekly_schedule',
  };
}

// ── 某模式某日的「開店/打烊分鐘數」，內部委派給 getEffectiveModeSchedule（單一來源）──
// 回傳 null 代表該日該模式無法下單（行事曆關閉該模式，或每週設定當天未營業）
function getDayOpenClose(db, storeId, mode, dateStr, modeSettings) {
  const sched = getEffectiveModeSchedule(db, storeId, mode, dateStr, modeSettings);
  if (!sched.enabled) return null;
  return { openMins: timeToMins(sched.start), closeMins: timeToMins(sched.end) };
}

// fix18-10-hotfix30-B1 第廿四點：安全布林解析，SQLite/JSON 的布林值可能是
// 0/1、"0"/"1"、false/true、null，不得直接用 Boolean(value)（Boolean("0")===true 是陷阱）。
function toBooleanFlag(value, defaultValue) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return defaultValue;
}

// fix18-10-hotfix30-B1 第九、廿二點：「今日臨時截止」只能讓視窗變短，不能延長超過
// schedule 本身（已含 Business Calendar 覆蓋）的結束時間——修正 root cause：先前
// cutoff_passed 一律拿「全域 cutoffTime 設定」比較，若店家主要靠 Business Calendar
// 設定特殊時段、卻沒有另外設定全域 cutoff_time，isCutoffPassed('', nowMins) 永遠回傳
// false，導致「已超過 Calendar 設定的截止時間，前台仍顯示開放中/接單中」。
function getEffectiveCutoffMins(schedule, todayCutoff) {
  if (!schedule.enabled || !schedule.end) return null;
  const scheduleEndMins = timeToMins(schedule.end);
  if (todayCutoff) {
    const todayCutoffMins = timeToMins(todayCutoff);
    return Math.min(scheduleEndMins, todayCutoffMins);
  }
  return scheduleEndMins;
}

// fix18-10-hotfix30-B1 第二、三點：單一狀態解析器（後端版本）。取代先前「GET /shop 只看
// 全域開關」與「GET /menu 只看全域 cutoffTime」各自判斷、彼此不一致的問題。優先序（需求
// 文件十九）：① 休假（Business Calendar 全休 or 今日臨時休息 or 固定公休/指定店休，見
// getDateClosedStatus 既有優先序）→ holiday；② Business Calendar 命中且該模式被該日設定
// 關閉 → today_not_open/special_schedule_disabled；③ 未命中 Calendar 時，若店家全域開關
// 關閉 → today_not_open/global_disabled；④ 當天無排班（每週營業時間該天未啟用）→
// today_not_open/no_schedule；⑤ 尚未到開始時間 → not_started；⑥ 已超過「有效截止時間」
// （schedule 結束時間與今日臨時截止取較早者）→ cutoff；⑦ 開放中 → open。
// 回傳物件盡量貼合需求文件第二點指定的 getFulfillmentStatus() 介面欄位。
function resolveFulfillmentState(mode, schedule, modeSettings, closedInfo, nowMins) {
  if (closedInfo.closed) {
    return {
      mode, state: 'holiday', reason: 'business_calendar_closed',
      enabled: false, selectable: false, canOrderToday: false, canPreorder: !!modeSettings.allowNextDay,
      startTime: null, cutoffTime: null, label: '今日未營業', shortLabel: '今日未營業',
    };
  }
  if (!schedule.enabled) {
    const reason = schedule.source === 'business_calendar'
      ? 'special_schedule_disabled'
      : (!toBooleanFlag(modeSettings.enabled, true) ? 'global_disabled' : 'no_schedule');
    return {
      mode, state: 'today_not_open', reason,
      enabled: false, selectable: false, canOrderToday: false, canPreorder: !!modeSettings.allowNextDay,
      startTime: null, cutoffTime: null, label: '今日未開放', shortLabel: '今日未開放',
    };
  }
  // schedule.enabled === true：若這一天並非命中 Business Calendar（也就是回退每週營業時間），
  // 仍必須套用店家全域開關（Calendar 命中時，getEffectiveModeSchedule 內已用該日 Calendar 自己
  // 的 takeout_enabled/delivery_enabled 判斷過，不重複套用全域開關，符合需求文件十九的優先序）。
  if (schedule.source !== 'business_calendar' && !toBooleanFlag(modeSettings.enabled, true)) {
    return {
      mode, state: 'today_not_open', reason: 'global_disabled',
      enabled: false, selectable: false, canOrderToday: false, canPreorder: !!modeSettings.allowNextDay,
      startTime: null, cutoffTime: null, label: '今日未開放', shortLabel: '今日未開放',
    };
  }
  const startMins = timeToMins(schedule.start);
  const cutoffMins = getEffectiveCutoffMins(schedule, modeSettings.todayCutoff);
  const cutoffTimeStr = cutoffMins != null ? minsToTime(cutoffMins) : null;
  if (nowMins < startMins) {
    return {
      mode, state: 'not_started', reason: 'before_start',
      enabled: false, selectable: false, canOrderToday: false, canPreorder: !!modeSettings.allowNextDay,
      startTime: schedule.start, cutoffTime: cutoffTimeStr, label: '尚未開始', shortLabel: '尚未開始',
    };
  }
  if (cutoffMins != null && nowMins > cutoffMins) {
    return {
      mode, state: 'cutoff', reason: 'after_cutoff',
      enabled: false, selectable: false, canOrderToday: false, canPreorder: !!modeSettings.allowNextDay,
      startTime: schedule.start, cutoffTime: cutoffTimeStr, label: '今日已截止', shortLabel: '今日已截止',
    };
  }
  return {
    mode, state: 'open', reason: null,
    enabled: true, selectable: true, canOrderToday: true, canPreorder: !!modeSettings.allowNextDay,
    startTime: schedule.start, cutoffTime: cutoffTimeStr, label: '開放中', shortLabel: '開放中',
  };
}

// ── 模式（外帶 takeout / 外送 delivery）設定讀取 ─────────
// fix18-10-hotfix22A：外帶/外送付款方式改為與冷藏宅配一致的「通路獨立開關」架構。
// 若店家尚未設定新版 JSON 陣列（takeout_payment_methods / delivery_payment_methods），
// 自動 fallback 沿用舊版全域 line_payment_*_enabled 設定，確保既有店家設定/行為完全不變。
function getModePaymentMethods(db, storeId, settingKey) {
  const raw = getSetting(db, storeId, settingKey, '');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch {}
  }
  const legacyMap = [
    ['cash', 'line_payment_cash_enabled'],
    ['linepay', 'line_payment_linepay_enabled'],
    ['transfer', 'line_payment_transfer_enabled'],
    ['platform', 'line_payment_platform_enabled'],
    ['credit_card', 'line_payment_credit_card_enabled'],
  ];
  return legacyMap
    .filter(([, key]) => getSetting(db, storeId, key, '') === '1')
    .map(([code]) => code);
}

function getModeSettings(db, storeId, mode) {
  // mode: 'takeout' | 'delivery'
  // fix18-06: 今日臨時截止時間判斷
  // today_cutoff 只在 today_cutoff_date == 今天時生效，否則回傳空字串
  function getTodayCutoff(prefix) {
    const todayDate = twDateStr();
    const todayTime = getSetting(db, storeId, prefix + '_today_cutoff_time', '');
    const todayDateKey = getSetting(db, storeId, prefix + '_today_cutoff_date', '');
    if (todayTime && todayDateKey === todayDate) return todayTime;
    return '';  // 日期不符或未設定 → 不套用今日限制
  }

  if (mode === 'takeout') {
    const todayCutoff = getTodayCutoff('takeout');
    return {
      enabled:      getSetting(db, storeId, 'takeout_enabled', '1') === '1',
      // fix18-06: 優先使用今日臨時截止；若無則沿用舊版固定 cutoff（向後相容）
      cutoffTime:   todayCutoff || getSetting(db, storeId, 'takeout_cutoff_time', ''),
      todayCutoff:  todayCutoff,  // 單獨保留，讓前端知道是否為今日臨時設定
      prepMins:     Number(getSetting(db, storeId, 'takeout_prep_minutes', '15')),
      allowNextDay: getSetting(db, storeId, 'takeout_allow_next_day', '1') === '1',
      bizHours:     (() => { try { return JSON.parse(getSetting(db, storeId, 'takeout_business_hours', '{}')); } catch { return {}; } })(),
    };
  } else {
    const todayCutoff = getTodayCutoff('delivery');
    return {
      enabled:      getSetting(db, storeId, 'delivery_enabled', '1') === '1',
      cutoffTime:   todayCutoff || getSetting(db, storeId, 'delivery_cutoff_time', ''),
      todayCutoff:  todayCutoff,
      prepMins:     Number(getSetting(db, storeId, 'delivery_prep_minutes', '30')),
      allowNextDay: getSetting(db, storeId, 'delivery_allow_next_day', '1') === '1',
      bizHours:     (() => { try { return JSON.parse(getSetting(db, storeId, 'delivery_business_hours', '{}')); } catch { return {}; } })(),
    };
  }
}

// ── 模式今日是否已截止（cutoff_sold_out 判斷）─────────────
function isCutoffPassed(cutoffTime, nowMins) {
  if (!cutoffTime) return false;
  return nowMins > timeToMins(cutoffTime);
}

// ── 取得某模式某日的最早可選時間（分鐘）────────────────────
// 若今日超過結束 → 回傳 null（今日無時段）
// v2：先查 Business Calendar 覆蓋層（getDayOpenClose），沒命中才走舊的每週營業時間
function getEarliestMins(db, storeId, mode, modeSettings, dateStr, nowMins) {
  const todayStr = twDateStr();
  const isToday = dateStr === todayStr;
  const oc = getDayOpenClose(db, storeId, mode, dateStr, modeSettings);
  if (!oc) return null; // 非營業日 / 行事曆該模式當日關閉
  if (isToday) {
    // 最早 = max(現在+prep, 開店時間)，進位至30分鐘格
    const earliest = Math.max(Math.ceil((nowMins + modeSettings.prepMins) / 30) * 30, oc.openMins);
    if (earliest >= oc.closeMins) return null; // 今日已無時段
    return earliest;
  } else {
    return oc.openMins;
  }
}

// ── LINE 今日可售份數（現貨）──────────────────────────────
function getLineQuotaStatus(product) {
  if (!Number(product.line_quota_enabled)) {
    return { hasQuota: false, remaining: null, reason: null };
  }
  const daily    = Number(product.line_quota_daily  || 0);
  const sold     = Number(product.line_quota_sold   || 0);
  const low      = Number(product.line_quota_low_threshold  || 2);
  const high     = Number(product.line_quota_high_threshold || 10);
  const remaining = Math.max(0, daily - sold);
  let displayLabel = 'available';
  if (remaining <= 0)    displayLabel = 'sold_out';
  else if (remaining <= low)  displayLabel = 'low';
  else if (remaining >= high) displayLabel = 'plenty';
  return { hasQuota: true, daily, sold, remaining, low, high, displayLabel };
}

// ── LINE 預購數量（明日/未來預購，獨立於今日份數）──────────
function getLinePreorderStatus(product) {
  if (!Number(product.line_preorder_enabled)) {
    return { hasPreorder: false, remaining: null };
  }
  const daily     = Number(product.line_preorder_daily  || 0);
  const sold      = Number(product.line_preorder_sold   || 0);
  const low       = Number(product.line_preorder_low_threshold  || 2);
  const high      = Number(product.line_preorder_high_threshold || 10);
  const remaining = Math.max(0, daily - sold);
  let displayLabel = 'available';
  if (remaining <= 0)         displayLabel = 'preorder_full';
  else if (remaining <= low)  displayLabel = 'preorder_low';
  else if (remaining >= high) displayLabel = 'preorder_ok';
  return { hasPreorder: true, daily, sold, remaining, low, high, displayLabel };
}

async function triggerN8nWebhook(db, storeId, event, payload) {
  try {
    const url = getSetting(db, storeId, 'n8n_webhook_url', '');
    if (!url) return;
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload, triggered_at: new Date().toISOString() }),
      timeout: 5000
    }).catch(() => {});
  } catch {}
}

function broadcastNewOrder(app, order) {
  try {
    const wss     = app?.get ? app.get('wss') : null;
    const storeId = order?.store_id;
    broadcastToStore(wss, storeId, { type: 'new_line_order', order });
  } catch {}
}

// ── 扣食材冷藏可販售 ──────────────────────────────────────
function deductIngredients(db, storeId, items, orderId) {
  (items || []).forEach(item => {
    const pid = item.product_id || item.id;
    if (!pid) return;
    const formulas = db.all('SELECT * FROM product_ingredient_formulas WHERE product_id=?', [pid]);
    formulas.forEach(f => {
      const ing = db.get('SELECT * FROM ingredients WHERE id=? AND store_id=?', [f.ingredient_id, storeId]);
      if (!ing) return;
      const perUnitG = Number(f.amount_per_unit) * Number(item.qty || 1);
      const deductInUnit = fromGrams(perUnitG, ing.unit || 'g');
      const bRefrig  = Number(ing.refrigerated_stock || 0);
      const newRefrig = Math.max(0, bRefrig - deductInUnit);
      const newTotal  = Math.max(0, Number(ing.total_stock || 0) - deductInUnit);
      db.run(`UPDATE ingredients SET refrigerated_stock=?,total_stock=?,updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
        [newRefrig, newTotal, ing.id, storeId]);
      db.run(`INSERT INTO ingredient_logs
        (ingredient_id,ingredient_name,log_type,before_refrigerated,change_amount,after_refrigerated,
         before_frozen,before_thawing,after_frozen,after_thawing,reason,related_order_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ing.id, ing.name, 'sale_deduct', bRefrig, -deductInUnit, newRefrig,
         ing.frozen_stock, ing.thawing_stock, ing.frozen_stock, ing.thawing_stock,
         'LINE銷售扣料', orderId||'']);
    });
  });
}

// ── GET /shop ──────────────────────────────────────────────
router.get('/shop', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const now = twNow();
    const todayStr = twDateStr(now);
    const nowMins = now.getHours()*60 + now.getMinutes();

    const keys = [
      'shop_name','shop_logo','shop_cover','shop_address','shop_google_map','shop_hours','shop_announcement',
      'line_order_enabled','line_order_min_amount','line_ordering_enabled',
      'line_business_hours_enabled','line_business_hours','pickup_enabled','delivery_enabled',
      'line_today_closed','line_today_closed_date','same_day_preorder_minutes','next_day_preorder_hours',
      'line_closed_weekdays','line_closed_dates',
      'line_payment_cash_enabled','line_payment_linepay_enabled','line_payment_transfer_enabled',
      'line_payment_platform_enabled','line_payment_credit_card_enabled',
      // v1 新增
      'takeout_enabled','takeout_cutoff_time','takeout_prep_minutes','takeout_allow_next_day','takeout_business_hours',
      'delivery_cutoff_time','delivery_prep_minutes','delivery_allow_next_day','delivery_business_hours',
      'next_day_min_hours',
      // fix18-06: 今日臨時截止設定
      'takeout_today_cutoff_time','takeout_today_cutoff_date',
      'delivery_today_cutoff_time','delivery_today_cutoff_date',
      // Hotfix15 LINE 營業中心 V3
      'line_preorder_days_limit',
      // Hotfix17：商家公告中心
      'line_announcement_enabled','line_announcement_type','line_announcement_title','line_announcement_body',
      'line_announcement_image_url','line_announcement_button_text','line_announcement_button_action',
      'line_announcement_button_url','line_announcement_category_id','line_announcement_product_id',
      'line_announcement_start_date','line_announcement_end_date','line_announcement_closable',
      'line_announcement_display_mode','line_announcement_frequency','line_announcement_version',
      'line_announcement_auto_holiday',
      // fix18-10-hotfix23-D：廣告追蹤設定（Pixel ID／Measurement ID 本身非密鑰，
      // 前台本來就需要明碼載入才能初始化 Meta Pixel／GA4）
      'analytics_meta_pixel_enabled', 'analytics_meta_pixel_id',
      'analytics_ga4_enabled', 'analytics_ga4_measurement_id',
      // fix18-10-hotfix23-E：LINE 會員入口 —— LIFF ID／Channel ID／文字/網址設定
      // 皆為前端初始化 LIFF SDK 必需的公開值，不含 Channel Secret（那個只在後端使用）。
      'line_member_gate_enabled', 'line_member_gate_mode', 'line_member_require_friend',
      'line_member_allow_skip', 'line_member_add_friend_url', 'line_member_basic_id',
      'line_member_login_channel_id', 'line_member_liff_id', 'line_member_return_url',
      'line_member_title', 'line_member_description', 'line_member_friend_button_text',
      'line_member_login_button_text', 'line_member_skip_button_text',
      // fix18-10-hotfix29-C（需求文件三）：LINE 整合中心的正式加好友網址欄位，
      // 之前這裡完全沒有讀取，導致結帳頁 config 永遠讀不到（見下方 resolveAddFriendUrl()）。
      'line_add_friend_url',
      // fix18-10-hotfix26-F3：取餐地址（外帶模式顯示用）。store_address／store_lat／
      // store_lng 本來就已存在於既有外送距離費率設定，這裡純粹「額外」讓 GET /shop
      // 一併回傳，不新增資料表、不影響既有外送費率計算邏輯；pickup_address 為新增
      // 選填欄位，當 store_address 未設定時才使用（優先序見前端 resolvePickupAddressText()：
      // store_address → pickup_address → 都沒有則顯示「請洽店家確認取餐地點」）。
      'store_address', 'store_lat', 'store_lng', 'pickup_address',
      // fix18-10-hotfix26-F5：獨立「取餐地點」設定（向下相容新增，不移除既有欄位）。
      // pickup_address_note／pickup_lat／pickup_lng／pickup_coordinate_mode／
      // pickup_coordinate_verified_at 直接用原始字串回傳；pickup_address_same_as_store／
      // pickup_sync_delivery_origin 在下面覆寫成真正的 boolean（與 settings.is_open 同樣寫法）。
      // 前台只有外帶模式會用到這些欄位。
      'pickup_address_note', 'pickup_lat', 'pickup_lng',
      'pickup_coordinate_mode', 'pickup_coordinate_verified_at',
      // fix18-10-hotfix26-F7：向下相容新增（需求文件廿六）。搜尋到明確商家後自動填入
      // 的商家名稱/Place ID；不移除任何既有欄位。
      'pickup_place_name', 'pickup_place_id', 'store_place_name', 'store_place_id',
    ];
    const settings = {};
    keys.forEach(k => { settings[k] = getSetting(db, storeId, k, ''); });

    // Hotfix16 BUG-003：今日休假狀態改用單一函式判斷，優先序 Business Calendar > 今日臨時休息 > 固定公休
    const todayClosedStatus = getDateClosedStatus(db, storeId, todayStr);
    settings.is_open = settings.line_ordering_enabled === '1' && !todayClosedStatus.closed;

    // fix18-10-hotfix29-C（需求文件三／四）：統一解析加好友網址，回傳一個
    // 「保證是正式來源」的 add_friend_url 欄位，供前端 _buildLineMemberGateConfig()
    // 優先使用；同時保留 line_add_friend_url／line_member_add_friend_url 兩個
    // 原始欄位供相容，但三者永遠是同一個 resolveAddFriendUrl() 結果，不會互相矛盾。
    settings.add_friend_url = resolveAddFriendUrl({
      line_add_friend_url: settings.line_add_friend_url,
      line_member_add_friend_url: settings.line_member_add_friend_url,
    });

    // fix18-10-hotfix26-F5：pickup_address_same_as_store／pickup_sync_delivery_origin
    // 覆寫成真正的 boolean（跟上面 is_open 同樣寫法），且 same_as_store 的預設值推斷
    // 呼叫共用 helper resolveSameAsStoreFlag()，跟 resolvePickupSettings() 用同一份邏輯，
    // 確保購物車頁跟訂單完成頁/查詢訂單看到的「相同店家地址」判斷完全一致。
    settings.pickup_address_same_as_store = resolveSameAsStoreFlag(db, storeId);
    settings.pickup_sync_delivery_origin = settings.pickup_sync_delivery_origin === '1' || String(settings.pickup_sync_delivery_origin).toLowerCase() === 'true';
    settings.pickup_coordinate_mode = settings.pickup_coordinate_mode === 'manual' ? 'manual' : 'auto';

    // 外帶/外送獨立狀態
    const takeoutMode   = getModeSettings(db, storeId, 'takeout');
    const deliveryMode  = getModeSettings(db, storeId, 'delivery');
    const closedInfo    = { closed: todayClosedStatus.closed, isWeekly: todayClosedStatus.isWeekly, calendar: todayClosedStatus.calendar };

    // fix18-10-hotfix22E：統一來源 getEffectiveModeSchedule()，取得「今日」該模式最終生效時段。
    // 修正 root cause：先前 is_closed_day 只看整店休假（closedInfo.closed），沒有涵蓋「Business Calendar
    // 命中特殊營業/全天營業，但單獨關閉外帶或外送」的情況，導致該情況下 is_closed_day 仍是 false，
    // 前台誤以為當天照常營業。
    const takeoutSchedule  = getEffectiveModeSchedule(db, storeId, 'takeout',  todayStr, takeoutMode);
    const deliverySchedule = getEffectiveModeSchedule(db, storeId, 'delivery', todayStr, deliveryMode);

    // fix18-10-hotfix30-B1：單一狀態解析器，供 today_open/today_state/today_reason/
    // today_label 使用；.enabled（全域開關原始值）與 .is_closed_day 保持既有語意不變
    // （後台「LINE 營業狀態」面板明確依賴 .enabled 表示「功能是否開啟」，不得混用今日營業判斷），
    // 新增欄位供 line-order.html 的 getFulfillmentStatus() 作為唯一資料來源。
    const takeoutFulfillState  = resolveFulfillmentState('takeout',  takeoutSchedule,  takeoutMode,  closedInfo, nowMins);
    const deliveryFulfillState = resolveFulfillmentState('delivery', deliverySchedule, deliveryMode, closedInfo, nowMins);

    settings.takeout_status = {
      enabled:        takeoutMode.enabled,
      // fix18-10-hotfix30-B1：cutoff_passed 改用「有效截止時間」（Business Calendar 覆蓋時段
      // 的結束時間 與 今日臨時截止 取較早者），修正「Calendar 設定了特殊時段但沒設全域
      // cutoff_time，導致永遠判斷不到已截止」的 root cause（需求文件第九點）。
      cutoff_passed:  takeoutFulfillState.state === 'cutoff',
      allow_next_day: takeoutMode.allowNextDay,
      is_closed_day:  closedInfo.closed || !takeoutSchedule.enabled,
      earliest_today: takeoutMode.enabled && !closedInfo.closed
        ? getEarliestMins(db, storeId, 'takeout', takeoutMode, todayStr, nowMins)
        : null,
      // fix18-06: 今日臨時截止資訊（供前台顯示用）
      today_cutoff:   takeoutMode.todayCutoff || '',
      // fix18-10-hotfix22E：今日最終生效時段來源，前台用來判斷是否要顯示「特殊營業」而非每週固定時段
      schedule_source: takeoutSchedule.source,
      today_schedule:  takeoutSchedule,
      // fix18-10-hotfix30-B1：單一狀態解析器輸出，line-order.html 的 getFulfillmentStatus()
      // 「今日快照」（useTodaySnapshot）唯一資料來源，不得再自行拼狀態。
      today_open:   takeoutFulfillState.enabled,
      today_state:  takeoutFulfillState.state,
      today_reason: takeoutFulfillState.reason,
      today_label:  takeoutFulfillState.label,
      today_start_time:  takeoutFulfillState.startTime,
      today_cutoff_time: takeoutFulfillState.cutoffTime,
    };
    settings.delivery_status = {
      enabled:        deliveryMode.enabled,
      cutoff_passed:  deliveryFulfillState.state === 'cutoff',
      allow_next_day: deliveryMode.allowNextDay,
      is_closed_day:  closedInfo.closed || !deliverySchedule.enabled,
      earliest_today: deliveryMode.enabled && !closedInfo.closed
        ? getEarliestMins(db, storeId, 'delivery', deliveryMode, todayStr, nowMins)
        : null,
      today_cutoff:   deliveryMode.todayCutoff || '',
      schedule_source: deliverySchedule.source,
      today_schedule:  deliverySchedule,
      today_open:   deliveryFulfillState.enabled,
      today_state:  deliveryFulfillState.state,
      today_reason: deliveryFulfillState.reason,
      today_label:  deliveryFulfillState.label,
      today_start_time:  deliveryFulfillState.startTime,
      today_cutoff_time: deliveryFulfillState.cutoffTime,
    };

    // fix18-10-hotfix22A：外帶/外送付款方式（通路獨立開關，未設定時 fallback 沿用全域設定）
    settings.takeout_payment_methods  = getModePaymentMethods(db, storeId, 'takeout_payment_methods');
    settings.delivery_payment_methods = getModePaymentMethods(db, storeId, 'delivery_payment_methods');

    // 找下一個可訂日（掃描範圍受 line_preorder_days_limit 限制，避免建議超出可預訂範圍的日期）
    // v2：改用 getDayOpenClose（Business Calendar 優先，沒命中才走舊的 bizHours 空值=全天可訂邏輯）
    const _preorderLimitForScan = getPreorderDaysLimit(db, storeId);
    function nextAvailableDates(modeSettings, mode, count=3) {
      const dates = [];
      const d = new Date(now);
      d.setDate(d.getDate() + 1); // 從明天開始
      for (let i=0; i<_preorderLimitForScan && dates.length<count; i++) {
        const ds = twDateStr(d);
        const cInfo = isClosedDate(db, storeId, ds);
        if (!cInfo.closed) {
          const oc = getDayOpenClose(db, storeId, mode, ds, modeSettings);
          if (oc) dates.push(ds);
        }
        d.setDate(d.getDate() + 1);
      }
      return dates;
    }
    settings.takeout_next_dates  = nextAvailableDates(takeoutMode, 'takeout', 3);
    settings.delivery_next_dates = nextAvailableDates(deliveryMode, 'delivery', 3);
    settings.today_closed_info   = closedInfo;
    settings.today = todayStr;
    settings.now_mins = nowMins;

    // ── Hotfix16 BUG-004/007：休假公告 Banner（單一資料來源，前台 Banner 與後台今日摘要都吃這份）──
    const _preorderLimitForBanner = getPreorderDaysLimit(db, storeId);
    let holidayBanner = { active: false };
    if (todayClosedStatus.closed) {
      if (todayClosedStatus.source === 'calendar') {
        const cal = todayClosedStatus.calendar;
        const daysAheadToResume = dateDiffDays(todayStr, cal.resume_date);
        holidayBanner = {
          active: true,
          type: 'calendar',
          start_date: cal.start_date,
          end_date: cal.end_date,
          reason: (cal.show_reason && cal.reason) ? cal.reason : '',
          show_reason: !!cal.show_reason,
          resume_date: cal.resume_date,
          resume_within_limit: daysAheadToResume <= _preorderLimitForBanner,
        };
      } else if (todayClosedStatus.source === 'today_closed') {
        holidayBanner = { active: true, type: 'today_closed' };
      } else {
        holidayBanner = { active: true, type: 'weekly' };
      }
    }
    settings.holiday_banner = holidayBanner;

    // ── Hotfix17：商家公告中心（優先序：手動公告 > 自動休假公告 > 無）──
    // 注意：公告只負責顯示提醒，不可取代送單驗證；能不能送單仍由 Business Calendar / validateOrderConditions 把關。
    {
      const announceEnabled = settings.line_announcement_enabled === '1';
      const startD = settings.line_announcement_start_date || '';
      const endD   = settings.line_announcement_end_date || '';
      const withinRange = (!startD || todayStr >= startD) && (!endD || todayStr <= endD);
      const hasContent  = !!(settings.line_announcement_title || settings.line_announcement_body);

      let announcement = { enabled: announceEnabled, active: false, source: 'none' };

      if (announceEnabled && withinRange && hasContent) {
        const type = settings.line_announcement_type || 'general';
        announcement = {
          enabled: true,
          active: true,
          type,
          icon: ANNOUNCEMENT_ICONS[type] || '📢',
          title: settings.line_announcement_title || '',
          body: settings.line_announcement_body || '',
          image_url: settings.line_announcement_image_url || '',
          button_text: settings.line_announcement_button_text || '我知道了',
          button_action: settings.line_announcement_button_action || 'close',
          button_url: settings.line_announcement_button_url || '',
          category_id: settings.line_announcement_category_id || '',
          product_id: settings.line_announcement_product_id || '',
          start_date: startD,
          end_date: endD,
          closable: settings.line_announcement_closable !== '0',
          display_mode: settings.line_announcement_display_mode || 'modal',
          frequency: settings.line_announcement_frequency || 'version',
          version: settings.line_announcement_version || '1',
          source: 'manual',
        };
      } else {
        // 沒有生效中的手動公告 → 是否自動產生休假公告（僅在 Business Calendar 命中休假時，預設開啟）
        const autoHoliday = settings.line_announcement_auto_holiday !== '0';
        if (autoHoliday && holidayBanner.active && holidayBanner.type === 'calendar') {
          const rangeTxt = holidayBanner.start_date === holidayBanner.end_date
            ? fmtMDShort(holidayBanner.start_date)
            : `${fmtMDShort(holidayBanner.start_date)}～${fmtMDShort(holidayBanner.end_date)}`;
          const bodyLines = [rangeTxt];
          if (holidayBanner.reason) bodyLines.push(holidayBanner.reason);
          bodyLines.push(`${fmtMDShort(holidayBanner.resume_date)} 恢復營業`);
          announcement = {
            enabled: announceEnabled,
            active: true,
            type: 'holiday',
            icon: ANNOUNCEMENT_ICONS.holiday,
            title: '目前休假中',
            body: bodyLines.join('\n'),
            image_url: '',
            button_text: '立即預訂',
            button_action: holidayBanner.resume_within_limit ? 'open_cart' : 'scroll_products',
            button_url: '',
            category_id: '',
            product_id: '',
            start_date: holidayBanner.start_date,
            end_date: holidayBanner.end_date,
            closable: true,
            display_mode: 'banner',
            frequency: 'always',
            version: holidayBanner.resume_date || '1',
            source: 'auto_holiday',
            resume_date: holidayBanner.resume_date,
            resume_within_limit: holidayBanner.resume_within_limit,
          };
        }
      }
      settings.announcement = announcement;
    }

    // ── Business Calendar V2：今日行事曆命中狀態（供後台/前台顯示用）──
    const calToday = getCalendarDateInfo(db, storeId, todayStr);
    settings.business_calendar_today = calToday.matched ? {
      matched: true,
      mode: calToday.mode,
      reason: calToday.reason,
      show_reason: calToday.show_reason,
      start_date: calToday.start_date,
      end_date: calToday.end_date,
      resume_date: calToday.resume_date,
      takeout_enabled: calToday.takeout_enabled,
      delivery_enabled: calToday.delivery_enabled,
      takeout_start_time: calToday.takeout_start_time,
      takeout_end_time: calToday.takeout_end_time,
      delivery_start_time: calToday.delivery_start_time,
      delivery_end_time: calToday.delivery_end_time,
    } : { matched: false };

    // fix18-05: 加入 coupon feature 旗標，讓 LINE 前台決定是否顯示優惠券輸入框
    const lineFeatures = getStoreFeatures(storeId);
    settings.coupon_feature_enabled = lineFeatures.coupon === true;

    // fix18-10-hotfix30-B2 第一、六點：非敏感診斷欄位——build_version 供前台確認實際
    // 載入的後端版本（避免正式環境 CDN/快取殘留舊版時，誤以為是邏輯 bug）；store_id
    // 供前台核對「目前頁面使用的 store_id」與「API 實際解析出的 store_id」是否一致。
    settings.build_version = 'fix18-10-hotfix30-B2';
    settings.store_id = storeId;
    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /menu ──────────────────────────────────────────────
router.get('/menu', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const todayStr = twDateStr(now);

    // 模式截止狀態（外帶/外送獨立）
    const takeoutMode  = getModeSettings(db, storeId, 'takeout');
    const deliveryMode = getModeSettings(db, storeId, 'delivery');

    // fix18-10-hotfix22E ROOT CAUSE FIX：先前這裡完全沒有檢查 Business Calendar 對「單一模式」
    // 的關閉設定（只有整店休假 mode='closed' 才會被 dayClosedReason 攔截）。導致特殊營業日
    // 若只關閉外帶、開放外送（或反之），/menu 回傳的 takeout_sold_out_reason 會是 null（完全可購買），
    // 商品卡因此顯示「正常可下單」，與 Business Calendar 設定不符。
    // 這裡改用與 /timeslots、/shop、validateOrderConditions 相同的單一來源 getEffectiveModeSchedule()。
    const takeoutSchedule  = getEffectiveModeSchedule(db, storeId, 'takeout',  todayStr, takeoutMode);
    const deliverySchedule = getEffectiveModeSchedule(db, storeId, 'delivery', todayStr, deliveryMode);
    const takeoutCalendarModeClosed  = takeoutSchedule.source  === 'business_calendar' && !takeoutSchedule.enabled;
    const deliveryCalendarModeClosed = deliverySchedule.source === 'business_calendar' && !deliverySchedule.enabled;

    // fix18-10-hotfix30-B1 第九點 root cause fix：cutoff 判斷改用「有效截止時間」
    // （getEffectiveCutoffMins：Business Calendar 覆蓋時段的結束時間 與 今日臨時截止 取較早者），
    // 不再只比對全域 cutoffTime 設定。修正「店家主要靠 Business Calendar 設定特殊時段，
    // 卻沒另外設定全域截止時間，導致已超過 Calendar 時段仍判斷成『尚未截止』」的問題。
    const toCutoff = takeoutSchedule.enabled
      && (() => { const m = getEffectiveCutoffMins(takeoutSchedule, takeoutMode.todayCutoff); return m != null && nowMins > m; })();
    const dlCutoff = deliverySchedule.enabled
      && (() => { const m = getEffectiveCutoffMins(deliverySchedule, deliveryMode.todayCutoff); return m != null && nowMins > m; })();

    // ── Hotfix16 BUG-003/006：今日休假狀態（優先序 Business Calendar > 今日臨時休息 > 固定公休），
    //    命中時所有商品當天皆視為休假（今日售完原因統一顯示為休假，不再各別顯示販售時段/份數狀態）
    const todayDayClosed = getDateClosedStatus(db, storeId, todayStr);
    const dayClosedReason = !todayDayClosed.closed ? null
      : (todayDayClosed.source === 'calendar' ? 'calendar_closed'
        : (todayDayClosed.source === 'today_closed' ? 'today_closed' : 'weekly_closed'));

    const categories = db.all(
      'SELECT * FROM categories WHERE store_id=? AND is_active=1 ORDER BY sort_order ASC, id ASC',
      [storeId]
    );
    const activeCatMap = new Map(categories.map(c => [c.id, c]));

    const rawProducts = db.all(
      `SELECT p.*,
              lc.name as line_cat_name, lc.icon as line_cat_icon, lc.sort_order as line_cat_sort, lc.is_active as line_cat_active,
              pc.name as pos_cat_name,  pc.icon as pos_cat_icon,  pc.sort_order as pos_cat_sort,  pc.is_active as pos_cat_active
       FROM products p
       LEFT JOIN categories lc ON lc.id = p.line_category_id AND lc.store_id=?
       LEFT JOIN categories pc ON (pc.id = p.category_id OR (p.category_id = 0 AND pc.name = p.category)) AND pc.store_id=?
       WHERE p.store_id=? AND p.enabled=1 AND p.show_on_line=1
       ORDER BY p.sort_order, p.id`,
      [storeId, storeId, storeId]
    );

    const resolvedProducts = rawProducts.map(p => {
      const lcid = Number(p.line_category_id || 0);
      const pcid = Number(p.category_id || 0);
      let displayCat = null;
      if (lcid > 0 && activeCatMap.has(lcid)) displayCat = activeCatMap.get(lcid);
      if (!displayCat && pcid > 0 && activeCatMap.has(pcid)) displayCat = activeCatMap.get(pcid);
      if (!displayCat && p.category) { const byName = categories.find(c => c.name === p.category); if (byName) displayCat = byName; }
      return {
        ...p,
        displayCatId:   displayCat ? displayCat.id   : 0,
        displayCatName: displayCat ? displayCat.name : '未分類',
        displayCatIcon: displayCat ? displayCat.icon : '📌',
        displayCatSort: displayCat ? Number(displayCat.sort_order) : 9999,
      };
    });

    const filteredProducts = resolvedProducts.filter(p => p.displayCatId > 0 || p.displayCatName === '未分類');
    const usedCatIds = new Set(filteredProducts.map(p => p.displayCatId).filter(id => id > 0));
    const lineCategories = categories.filter(c => usedCatIds.has(c.id));

    const topRows = db.all(
      `SELECT json_each.value as item_json FROM orders, json_each(orders.items)
       WHERE orders.store_id=? AND orders.created_at >= datetime('now','-30 days') AND orders.status != 'void'`,
      [storeId]
    );
    const saleMap = {};
    topRows.forEach(row => {
      try {
        const item = typeof row.item_json === 'string' ? JSON.parse(row.item_json) : row.item_json;
        if (item?.name) saleMap[item.name] = (saleMap[item.name]||0) + (item.qty||1);
      } catch {}
    });
    const hotNames = new Set(Object.entries(saleMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n])=>n));

    const enriched = filteredProducts.map(p => {
      const basePrice  = Number(p.takeaway_price) > 0 ? Number(p.takeaway_price) : (Number(p.price) || 0);
      const linePrice  = Number(p.line_price) > 0 ? Number(p.line_price) : basePrice;
      const lineName   = (p.line_name||'').trim() || p.name;
      const saleStatus = p.sale_status || 'available';

      // ── LINE 專屬可售份數（優先判斷）──────────────────────
      const quota = getLineQuotaStatus(p);

      // ── 食材/庫存 ──────────────────────────────────────
      // LINE 點餐不檢查食材庫存 / inventory_enabled。
      // 食材控管只適用於現場 POS / Web POS。
      // ingredient_available 固定回傳 true，前台不顯示「備料不足」。
      const availableUnits = null;
      const availableGrams = null;
      const hasFormula = false;
      const effectiveIngredientOk = true;

      // ══════════════════════════════════════════════════════
      // Hotfix16 LINE 接單規則優先順序：
      //   第零位階：模式關閉（外帶/外送總開關）
      //   第一位階：今日休假（Business Calendar > 今日臨時休息 > 固定公休，見 getDateClosedStatus）
      //   第二位階：今日最後接單時間（臨時提前結束今日接單）
      //   第三位階：商品販售時段（商品級行銷設定，只限今日）
      //   第四位階：LINE 可售份數（今日額度）
      //
      // 重要原則：位階 1/2/3/4 都只限制「今日下單」
      // 只要允許明日預購，任何今日限制都不阻擋未來預約
      //
      // BUG-002（Hotfix16）：商品尚未到販售開始時間時，若該商品已啟用 LINE 預購管理
      // （line_preorder_enabled=1，即既有「允許預購」開關），則不阻擋今日加入購物車，
      // 客人可直接預約「今天稍後」的時段（送單時仍會檢查取餐時間需 >= 開賣時間）。
      // ══════════════════════════════════════════════════════

      const nowHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const allowPreorderBeforeStart = Number(p.line_preorder_enabled) === 1;

      // ── 第三位階：商品自身販售時段（只影響今日）──────────
      let productTimeReason = null; // 'not_started' | 'time_ended'（均僅限今日）
      let preSaleAvailable = false; // BUG-002：尚未開賣但允許預購今天稍後時段
      if (p.line_sell_end && nowHHMM >= p.line_sell_end) {
        productTimeReason = 'time_ended';   // 今日販售已結束，不影響明日
      } else if (p.line_sell_start && nowHHMM < p.line_sell_start) {
        if (allowPreorderBeforeStart) {
          preSaleAvailable = true;          // 不阻擋加入購物車，前台顯示「🟢 可預約」
        } else {
          productTimeReason = 'not_started';  // 今日尚未開賣，不影響明日
        }
      }

      // ── 第四位階：LINE 可售份數（只影響今日額度）─────────
      const realSoldOut = quota.hasQuota && quota.remaining <= 0;

      // ── 外帶/外送各自的今日售完原因（僅描述今日狀態）─────
      // 優先順序：商品自身模式開關(新，hotfix30-A) > 模式關閉(店家) > 今日休假(整店)
      //           > Business Calendar 單一模式關閉 > 第二位階截止 > 第三位階商品時段 > 第四位階份數
      // fix18-10-hotfix30-A 第五點：商品是否啟用外帶/外送，屬於商品自身設定（預設皆啟用，
      // 零設定時行為與舊版完全相同），優先序高於店家模式開關，因為即使店家兩種模式都開放，
      // 商家仍可能把單一商品設定為「僅外帶」或「僅外送」。
      const productTakeoutDisabled  = Number(p.line_takeout_enabled  ?? 1) === 0;
      const productDeliveryDisabled = Number(p.line_delivery_enabled ?? 1) === 0;
      // fix18-10-hotfix30-B1 第十九、廿一點：優先序修正——Business Calendar 命中時，該日
      // 該模式的開放與否完全由 Calendar 自己的設定決定（takeoutCalendarModeClosed／
      // takeoutSchedule.enabled），不得被「店家全域開關」蓋掉；全域開關只在「當天並未命中
      // Calendar」時才生效。先前寫法是 !takeoutMode.enabled 一律最先判斷，導致「Calendar
      // 當天有開放外帶，但店家全域開關剛好是關閉」時，仍被錯誤判斷成 mode_closed。
      const takeoutGlobalClosed  = takeoutSchedule.source  !== 'business_calendar' && !takeoutMode.enabled;
      const deliveryGlobalClosed = deliverySchedule.source !== 'business_calendar' && !deliveryMode.enabled;

      const takeoutSoldOutReason = productTakeoutDisabled ? 'product_mode_disabled'
        : (dayClosedReason ? dayClosedReason
        : (takeoutCalendarModeClosed ? 'calendar_mode_closed'
          : (takeoutGlobalClosed ? 'mode_closed'
            : (toCutoff ? 'cutoff_sold_out'
              : (productTimeReason === 'time_ended'   ? 'product_time_ended'
                : (productTimeReason === 'not_started' ? 'product_not_started'
                  : (realSoldOut ? 'real_sold_out' : null)))))));

      const deliverySoldOutReason = productDeliveryDisabled ? 'product_mode_disabled'
        : (dayClosedReason ? dayClosedReason
        : (deliveryCalendarModeClosed ? 'calendar_mode_closed'
          : (deliveryGlobalClosed ? 'mode_closed'
            : (dlCutoff ? 'cutoff_sold_out'
              : (productTimeReason === 'time_ended'   ? 'product_time_ended'
                : (productTimeReason === 'not_started' ? 'product_not_started'
                  : (realSoldOut ? 'real_sold_out' : null)))))));

      // ── 可預約明日旗標 ────────────────────────────────────
      // 條件：今日有售完原因（非模式關閉，非尚未開賣，非商品自身停用該模式） + 該模式允許次日預購
      // BUG-003 修正：product_not_started 不應觸發「預約明日」
      //   今日尚未開賣 ≠ 今日售完；商品只是還沒到販售時間，稍後仍可購買
      //   只有真正的售完/截止/販售結束/今日休假才允許預約明日（或恢復營業日）
      // fix18-10-hotfix30-A：product_mode_disabled 是商家對該商品的永久性通路設定，
      // 不屬於「今日」限制，不得提供「預約明日」（明日該商品仍然不支援該模式）。
      const todayTrulySoldOutForTakeout = !!takeoutSoldOutReason
        && takeoutSoldOutReason !== 'mode_closed'
        && takeoutSoldOutReason !== 'product_not_started'
        && takeoutSoldOutReason !== 'product_mode_disabled';
      const todayTrulySoldOutForDelivery = !!deliverySoldOutReason
        && deliverySoldOutReason !== 'mode_closed'
        && deliverySoldOutReason !== 'product_not_started'
        && deliverySoldOutReason !== 'product_mode_disabled';
      const takeoutCanNextDay  = todayTrulySoldOutForTakeout  && takeoutMode.allowNextDay;
      const deliveryCanNextDay = todayTrulySoldOutForDelivery && deliveryMode.allowNextDay;

      const isOrderable = !p.line_sold_out && saleStatus === 'available' && effectiveIngredientOk && !realSoldOut;

      return {
        ...p,
        display_cat_id: p.displayCatId, display_cat_name: p.displayCatName,
        display_cat_icon: p.displayCatIcon, display_cat_sort: p.displayCatSort,
        effective_price: basePrice, effective_line_price: linePrice, effective_line_name: lineName,
        sale_status: saleStatus,
        ingredient_available: effectiveIngredientOk, is_orderable: isOrderable,
        available_units: availableUnits, available_grams: availableGrams,
        has_formula: hasFormula, low_stock_alert: Number(p.low_stock_alert||5),
        is_hot: hotNames.has(p.name),
        line_description: p.line_description||'', line_image_url: p.line_image_url||'',
        line_hot: Number(p.line_hot)||0, line_promo: Number(p.line_promo)||0,
        // LINE 可售份數（今日）
        line_quota: quota,
        // LINE 預購數量（明日/未來）
        line_preorder: getLinePreorderStatus(p),
        takeout_sold_out_reason:  takeoutSoldOutReason,
        delivery_sold_out_reason: deliverySoldOutReason,
        takeout_can_next_day:  takeoutCanNextDay,
        delivery_can_next_day: deliveryCanNextDay,
        // fix18-10-hotfix30-A：商品自身通路開關（預設皆 1，供前台商品卡/購物車模式交集判斷）
        line_takeout_enabled:  productTakeoutDisabled  ? 0 : 1,
        line_delivery_enabled: productDeliveryDisabled ? 0 : 1,
        // Hotfix16 BUG-002/006：尚未開賣但允許預約今天稍後時段（前台顯示 🟢 可預約）
        pre_sale_available: preSaleAvailable,
      };
    });

    res.json({ success: true, data: { categories: lineCategories, products: enriched } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /timeslots — 取得可選時段 API ────────────────────
// ?mode=takeout|delivery&date=YYYY-MM-DD
router.get('/timeslots', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const mode = req.query.mode === 'delivery' ? 'delivery' : 'takeout';
    const dateStr = req.query.date || twDateStr();
    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const todayStr = twDateStr(now);

    const modeSettings = getModeSettings(db, storeId, mode);
    if (!modeSettings.enabled) return res.json({ success: true, slots: [], reason: 'mode_closed' });

    // Hotfix15 V3：顧客可提前預訂天數上限
    const preorderLimit = getPreorderDaysLimit(db, storeId);
    if (dateDiffDays(todayStr, dateStr) > preorderLimit) {
      return res.json({ success: true, slots: [], reason: 'preorder_limit_exceeded' });
    }

    const closedInfo = isClosedDate(db, storeId, dateStr);
    if (closedInfo.closed) return res.json({ success: true, slots: [], reason: 'closed_day' });

    // 截止判斷（今日才判斷 cutoff）
    if (dateStr === todayStr && isCutoffPassed(modeSettings.cutoffTime, nowMins)) {
      return res.json({ success: true, slots: [], reason: 'cutoff_passed' });
    }

    const earliestMins = getEarliestMins(db, storeId, mode, modeSettings, dateStr, nowMins);
    if (earliestMins === null) return res.json({ success: true, slots: [], reason: 'no_slots_today' });

    // v2：closeMins 需與 getEarliestMins 使用同一套「Business Calendar 覆蓋 + 舊每週營業時間」邏輯
    const oc = getDayOpenClose(db, storeId, mode, dateStr, modeSettings);
    if (!oc) return res.json({ success: true, slots: [], reason: 'no_slots_today' }); // 理論上不會發生，安全防呆

    const slots = [];
    for (let t = earliestMins; t < oc.closeMins; t += 30) {
      slots.push(minsToTime(t));
    }
    res.json({ success: true, slots, earliest: minsToTime(earliestMins), mode, date: dateStr });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /validate-cart — 加入購物車時驗證 ────────────────
// ?mode=takeout|delivery&product_ids=1,2,3&date=YYYY-MM-DD
router.get('/validate-cart', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const mode = req.query.mode === 'delivery' ? 'delivery' : 'takeout';
    const productIds = String(req.query.product_ids||'').split(',').map(Number).filter(Boolean);
    const now = twNow();
    const todayStr = twDateStr(now);
    const nowMins = now.getHours()*60 + now.getMinutes();
    // BUG-002 修正：接受 date 參數，以便判斷是今日訂單還是預購訂單
    const orderDate = req.query.date || todayStr;
    const isPreorder = orderDate > todayStr;

    const checks = validateOrderConditions(db, storeId, mode, orderDate, null, nowMins);
    const productResults = productIds.map(pid => {
      const p = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
      if (!p) return { product_id: pid, ok: false, reason: 'not_found' };
      // fix18-10-hotfix30-A：商品自身通路開關優先於份數/預購檢查
      const modeEnabledField = mode === 'delivery' ? 'line_delivery_enabled' : 'line_takeout_enabled';
      if (Number(p[modeEnabledField] ?? 1) === 0) {
        return { product_id: pid, ok: false, reason: 'product_mode_not_supported', name: p.name, mode };
      }
      if (isPreorder) {
        // BUG-002 修正：預購訂單用 line_preorder_*，不用 line_quota_*
        const preorder = getLinePreorderStatus(p);
        if (preorder.hasPreorder && preorder.remaining <= 0)
          return { product_id: pid, ok: false, reason: 'preorder_full', name: p.name };
      } else {
        // 今日訂單用 line_quota_*
        const quota = getLineQuotaStatus(p);
        if (quota.hasQuota && quota.remaining <= 0)
          return { product_id: pid, ok: false, reason: 'real_sold_out', name: p.name };
      }
      return { product_id: pid, ok: true, name: p.name };
    });

    res.json({ success: true, mode_ok: checks.ok, mode_reason: checks.reason, products: productResults });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── 結帳前驗證邏輯（共用）────────────────────────────────
function validateOrderConditions(db, storeId, mode, dateStr, pickupTime, nowMins) {
  const now = twNow();
  if (nowMins === undefined) nowMins = now.getHours()*60 + now.getMinutes();
  const todayStr = twDateStr(now);

  // 1. 全域 LINE 點餐開關
  if (getSetting(db, storeId, 'line_ordering_enabled', '1') !== '1')
    return { ok: false, reason: 'line_disabled', message: 'LINE 點餐目前暫停營業' };

  const orderDate = dateStr || todayStr;

  // 1b. 顧客可提前預訂天數上限（Hotfix15 V3：line_preorder_days_limit，預設14天，0~60）
  const preorderLimit = getPreorderDaysLimit(db, storeId);
  const daysAhead = dateDiffDays(todayStr, orderDate);
  if (daysAhead > preorderLimit) {
    return { ok: false, reason: 'preorder_limit_exceeded',
      message: `此日期超出可預訂範圍（最多可預訂 ${preorderLimit} 天內）` };
  }

  // 2/3. 店休/休假判斷（Hotfix16 BUG-003：優先序改為 Business Calendar > 今日臨時休息 > 固定公休，
  //      getDateClosedStatus() 內部已整合此優先序，一次判斷完成）
  const closedStatus = getDateClosedStatus(db, storeId, orderDate);
  if (closedStatus.closed) {
    if (closedStatus.source === 'calendar') {
      const cal = closedStatus.calendar;
      const reasonMsg = (cal.show_reason && cal.reason) ? `（${cal.reason}）` : '';
      return { ok: false, reason: 'calendar_closed',
        message: `${orderDate} 為特殊休假日${reasonMsg}，預計 ${cal.resume_date} 恢復營業` };
    }
    if (closedStatus.source === 'today_closed') {
      return { ok: false, reason: 'today_closed', message: '今日 LINE 點餐休息' };
    }
    return { ok: false, reason: 'closed_day', message: `${orderDate} 為店休日，請選擇其他日期` };
  }

  // fix18-10-hotfix22E：4. 模式開關讀取提前到這裡，讓下面的 Business Calendar 判斷可以共用同一份
  // modeSettings（呼叫與 GET /shop、GET /menu、GET /timeslots 完全相同的 getEffectiveModeSchedule()）。
  const modeSettings = getModeSettings(db, storeId, mode);

  // 3b. 該模式在此日的最終生效時段（Business Calendar 覆蓋 > 每週營業時間，單一來源
  //     getEffectiveModeSchedule，與 GET /shop、GET /menu、GET /timeslots 完全一致）。
  //     只在「行事曆有命中且該模式被關閉」時才在此攔截；沒有命中行事曆時維持原本行為
  //     （每週營業時間本身是否開放，交由 GET /timeslots 判斷可選時段，這裡不新增額外限制）。
  const effSchedule = getEffectiveModeSchedule(db, storeId, mode, orderDate, modeSettings);
  if (effSchedule.source === 'business_calendar' && !effSchedule.enabled) {
    return { ok: false, reason: 'calendar_mode_closed',
      message: `${orderDate} ${mode === 'takeout' ? '外帶' : '外送'}服務依營業行事曆設定暫停服務` };
  }

  // 4. 模式開關（外帶/外送獨立）
  if (!modeSettings.enabled)
    return { ok: false, reason: 'mode_closed', message: `目前${mode==='takeout'?'外帶':'外送'}服務已關閉` };

  // 5. 今日截止時間（只針對今天的訂單，明日以後不受此限制）
  // fix18-10-hotfix30-B1 第九點 root cause fix：改用「有效截止時間」（Business Calendar
  // 覆蓋時段的結束時間 與 今日臨時截止 取較早者），不再只比對全域 cutoffTime 設定，
  // 與 GET /menu、GET /shop 的判斷邏輯一致（見 getEffectiveCutoffMins()）。
  if (orderDate === todayStr) {
    const effCutoffMins = getEffectiveCutoffMins(effSchedule, modeSettings.todayCutoff);
    if (effCutoffMins != null && nowMins > effCutoffMins) {
      return { ok: false, reason: 'cutoff_sold_out',
        message: `${mode==='takeout'?'外帶':'外送'}已超過今日最後接單時間（${minsToTime(effCutoffMins)}）` };
    }
  }

  // 6. 取餐時間有效性
  if (pickupTime && pickupTime !== '盡快' && orderDate === todayStr) {
    const [ph, pm] = pickupTime.split(':').map(Number);
    const pTotal = ph * 60 + pm;
    if (pTotal < nowMins + modeSettings.prepMins)
      return { ok: false, reason: 'time_too_early',
        message: `此時段距離現在太近，最短備餐時間 ${modeSettings.prepMins} 分鐘` };
  }

  return { ok: true };
}

// ── POST /（新 LINE 訂單）──────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const {
      customer_name, customer_phone, customer_line_id,
      order_type, pickup_time, pickup_date, delivery_address,
      delivery_address_note, delivery_lat, delivery_lng,
      note, payment_method, items, subtotal, discount_amount, total,
      coupon_code,
      // fix18-10-hotfix23-A：Analytics Foundation — 前端隨訂單一併送出的追蹤欄位（僅供
      // submit_order / purchase 事件關聯使用，不影響訂單金額 / 付款狀態等信任邊界）
      analytics: analyticsPayload,
      // fix18-10-hotfix23-E：LINE 會員入口 —— 前端改帶「後端登入時簽發的短效
      // member_session」，不再直接信任前端傳入的 line_user_id（見
      // utils/lineMemberSession.js）。舊欄位名稱不再被信任，僅接受 member_session。
      member_session,
      // fix18-10-hotfix26-F8-B（需求文件十五）：Messenger →「到 LINE 完成結帳」的
      // cart handoff token；訂單成立後標記 consumed，避免同一 token 重複下單。
      cart_token,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: '購物車不能為空' });
    if (!customer_name || !customer_phone)
      return res.status(400).json({ success: false, message: '請填寫姓名與電話' });

    // ── fix18-06：外送模式必填地址與座標 ────────────────
    const isDelivery = order_type === 'delivery';
    if (isDelivery) {
      if (!delivery_address || !String(delivery_address).trim())
        return res.status(400).json({ success: false, message: '外送訂單請填寫外送地址' });
      const dLat = parseFloat(delivery_lat);
      const dLng = parseFloat(delivery_lng);
      if (isNaN(dLat) || isNaN(dLng))
        return res.status(400).json({ success: false, message: '外送地址座標無效，請重新選擇地址' });
    }

    const now = twNow();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const todayStr = twDateStr(now);
    const orderDate = pickup_date || todayStr;
    // ── BUG-001 修正：isPreorderOrder 必須在商品驗證迴圈之前宣告 ──
    const isPreorderOrder = orderDate > todayStr;

    // ── 結帳前雙重驗證 ─────────────────────────────────
    const mode = order_type === 'delivery' ? 'delivery' : 'takeout';
    const validation = validateOrderConditions(db, storeId, mode, orderDate, pickup_time, nowMins);
    if (!validation.ok)
      return res.status(403).json({ success: false, message: validation.message, reason: validation.reason });

    // ── 商品驗證（含 LINE 份數）──────────────────────────
    for (const item of items) {
      const pid  = item.product_id || item.id;
      const prod = pid ? db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]) : null;
      if (!prod || !prod.enabled || !prod.show_on_line)
        return res.status(400).json({ success: false, message: `商品「${item.name}」已下架` });
      // fix18-10-hotfix30-A 第五、十四點：商品是否支援目前選擇的取餐方式（外帶/外送），
      // 不得只信任前端 UI 的 disabled 狀態；商品自身通路開關優先於其他售完原因判斷。
      const modeEnabledField = mode === 'delivery' ? 'line_delivery_enabled' : 'line_takeout_enabled';
      if (Number(prod[modeEnabledField] ?? 1) === 0) {
        return res.status(400).json({
          success: false,
          message: `「${prod.name}」不支援${mode === 'delivery' ? '外送' : '外帶'}，請調整購物車後再送出`,
          reason: 'product_mode_not_supported',
          product_id: prod.id,
          product_name: prod.name,
          mode,
        });
      }
      if (prod.sale_status === 'sold_out_today')
        return res.status(400).json({ success: false, message: `「${prod.name}」今日完售` });
      if (prod.sale_status !== 'available')
        return res.status(400).json({ success: false, message: `「${prod.name}」目前無法購買` });

      // ── 今日訂單：LINE 份數 + 商品販售時段驗證 ──────────
      // 預購訂單不受今日限制（位階 2/3/4 只限今日）
      const quota = getLineQuotaStatus(prod);
      if (!isPreorderOrder) {
        // 今日 LINE 份數驗證
        if (quota.hasQuota) {
          if (quota.remaining <= 0)
            return res.status(400).json({
              success: false, message: `「${prod.name}」LINE 今日份數已售完，可選擇預購`,
              reason: 'real_sold_out'
            });
          if (quota.remaining < Number(item.qty||1))
            return res.status(400).json({
              success: false, message: `「${prod.name}」LINE 剩餘份數不足（剩 ${quota.remaining} 份）`,
              reason: 'quota_insufficient'
            });
        }
        // 今日商品販售時段驗證（只限今日）
        if (prod.line_sell_start || prod.line_sell_end) {
          const nowHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
          if (prod.line_sell_end && nowHHMM >= prod.line_sell_end)
            return res.status(400).json({ success: false, message: `「${prod.name}」今日販售時段已結束，可選擇預購` });
          if (prod.line_sell_start && nowHHMM < prod.line_sell_start) {
            // Hotfix16 BUG-002：已啟用 LINE 預購管理（既有「允許預購」開關）→ 不阻擋下單，
            // 但客人選的取餐時間（若非「盡快」）必須 >= 開賣時間，否則拒絕
            const allowPreorderBeforeStart = Number(prod.line_preorder_enabled) === 1;
            if (!allowPreorderBeforeStart) {
              return res.status(400).json({ success: false, message: `「${prod.name}」尚未開始販售（${prod.line_sell_start} 開賣）` });
            }
            const pt = pickup_time ? String(pickup_time).trim() : '';
            if (pt && pt !== '盡快' && pt < prod.line_sell_start) {
              return res.status(400).json({
                success: false,
                message: `「${prod.name}」最早可於 ${prod.line_sell_start} 取餐，請重新選擇取餐時間`,
              });
            }
          }
        }
      } else {
        // ── 預購訂單：使用 line_preorder_* 驗證 ────────────
        const preorder = getLinePreorderStatus(prod);
        if (preorder.hasPreorder) {
          if (preorder.remaining <= 0)
            return res.status(400).json({
              success: false, message: `「${prod.name}」預購已滿，請選擇其他日期`,
              reason: 'preorder_full'
            });
          if (preorder.remaining < Number(item.qty||1))
            return res.status(400).json({
              success: false, message: `「${prod.name}」預購剩餘份數不足（剩 ${preorder.remaining} 份）`,
              reason: 'preorder_insufficient'
            });
        }
      }

      // 食材庫存驗證：LINE 點餐不檢查食材庫存（只適用現場 POS / Web POS）
    }

    // ── 付款方式驗證 ──────────────────────────────────
    const PAYMENT_SETTINGS = {
      cash:'line_payment_cash_enabled', linepay:'line_payment_linepay_enabled',
      transfer:'line_payment_transfer_enabled', platform:'line_payment_platform_enabled',
      credit_card:'line_payment_credit_card_enabled',
    };
    const payKey = PAYMENT_SETTINGS[payment_method];
    if (!payKey || getSetting(db, storeId, payKey, '0') !== '1')
      return res.status(400).json({ success: false, message: `付款方式「${payment_method}」目前未開放` });
    const payment_category = payment_method === 'cash' ? 'cash' : 'non_cash';

    // ── fix18-05：優惠券後端重新驗證（不信任前端金額）──────
    const sub = Number(subtotal) || 0;
    let discAmt    = 0;
    let finalTotal = sub;
    let appliedCouponId   = null;
    let appliedCouponCode = '';
    const normalCouponCode = coupon_code ? String(coupon_code).trim().toUpperCase() : '';

    if (normalCouponCode) {
      // coupon feature gate 檢查（LINE 前台也必須受授權控制）
      const storeFeatures = getStoreFeatures(storeId);
      if (storeFeatures.coupon !== true) {
        return res.status(403).json({
          success: false,
          error:   'COUPON_FEATURE_DISABLED',
          message: '優惠券功能未啟用'
        });
      }
      const phone = String(customer_phone || '').trim();
      const cvResult = validateCoupon(db, storeId, normalCouponCode, sub, phone);
      if (!cvResult.ok) {
        return res.status(400).json({ success: false, message: cvResult.message, reason: 'coupon_invalid' });
      }
      discAmt            = cvResult.discount_amount;
      finalTotal         = cvResult.final_total;
      appliedCouponId    = cvResult.coupon.id;
      appliedCouponCode  = cvResult.coupon.code;
    }

    // ── fix18-06：外送費後端重算（不信任前端）────────────
    let calcDelivFee    = 0;
    let calcDistKm      = 0;
    let calcMapsUrl     = '';
    const couponApplyToDelivery = getSettingVal(db, storeId, 'coupon_apply_to_delivery_fee', '0') === '1';

    if (isDelivery) {
      const destLat = parseFloat(delivery_lat);
      const destLng = parseFloat(delivery_lng);
      try {
        const feeResult = await recalcDeliveryFee(db, storeId, destLat, destLng, sub);
        calcDelivFee = feeResult.deliveryFee;
        calcDistKm   = feeResult.distKm;
        calcMapsUrl  = feeResult.mapsUrl;
      } catch (delivErr) {
        return res.status(delivErr.reason === 'out_of_range' ? 400 : 503).json({
          success: false,
          message: delivErr.message,
          reason:  delivErr.reason || 'delivery_error',
          distance_km: delivErr.distance_km,
        });
      }

      // 根據 coupon_apply_to_delivery_fee 計算 finalTotal
      if (couponApplyToDelivery) {
        // 折扣適用於 subtotal + delivery_fee
        const couponBase = sub + calcDelivFee;
        if (normalCouponCode && appliedCouponId) {
          // 重新以含運費金額計算折扣（需 re-validate）
          const phone = String(customer_phone || '').trim();
          const cvResult2 = validateCoupon(db, storeId, normalCouponCode, couponBase, phone);
          if (cvResult2.ok) {
            discAmt    = cvResult2.discount_amount;
            finalTotal = cvResult2.final_total; // = couponBase - discount
          } else {
            finalTotal = couponBase - discAmt;
          }
        } else {
          finalTotal = sub - discAmt + calcDelivFee;
        }
      } else {
        // 折扣只適用於 subtotal（預設）
        finalTotal = sub - discAmt + calcDelivFee;
      }
    }

    // ── 建立訂單 ──────────────────────────────────────
    const uuid = uuidv4(), orderNo = orderNumber();
    const pad = (n,l=2) => String(n).padStart(l,'0');
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const itemsJson = JSON.stringify(items);
    const orderMode  = order_type === 'delivery' ? 'delivery' : 'takeout';
    // 預購訂單：將日期合入 pickup_time，格式 "YYYY-MM-DD HH:MM"，方便後台辨識
    let pickupTimeVal = (pickup_time && pickup_time.trim()) ? pickup_time.trim() : '';
    if (isPreorderOrder && pickupTimeVal && !pickupTimeVal.includes('-')) {
      // 預購且只有時間（HH:MM），補上日期
      pickupTimeVal = `${orderDate} ${pickupTimeVal}`;
    }

    // fix18-10-hotfix23-E：line_user_id 只信任伺服器簽章過的 member_session；
    // 驗證失敗（過期／簽章錯誤／store_id 不符）一律視為未登入，不阻擋下單。
    const knownLineUserId = member_session ? verifyMemberSession(member_session, storeId) : null;

    // fix18-10-hotfix26-F4：外帶（含預購外帶）訂單建立當下，由後端依 storeId 重新
    // 讀取店家設定寫入「取餐門市/地址」snapshot；不信任前端傳入的門市名稱/地址/座標。
    // 外送訂單不寫 snapshot（維持既有顧客配送地址欄位，避免誤寫成配送地址）。
    const pickupSnapshot = !isDelivery
      ? buildPickupSnapshot(db, storeId)
      : { pickup_store_name_snapshot: '', pickup_place_name_snapshot: '', pickup_place_id_snapshot: '', pickup_address_snapshot: '', pickup_address_note_snapshot: '', pickup_lat_snapshot: '', pickup_lng_snapshot: '' };

    db.run(
      `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone, customer_line_id,
        pickup_time, delivery_address, delivery_address_note,
        delivery_platform, platform_order_no,
        delivery_lat, delivery_lng, delivery_distance_km, delivery_maps_url,
        delivery_fee,
        pickup_store_name_snapshot, pickup_place_name_snapshot, pickup_place_id_snapshot,
        pickup_address_snapshot, pickup_address_note_snapshot,
        pickup_lat_snapshot, pickup_lng_snapshot,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, original_total, coupon_code, total,
        note, sync_status, device_id, source, created_at, updated_at, line_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuid, uuid, orderNo, storeId, orderMode, 'pending', 'pending',
        customer_name, customer_phone, customer_line_id||'',
        pickupTimeVal, delivery_address||'', delivery_address_note||'',
        'LINE', '',
        isDelivery ? String(parseFloat(delivery_lat)||'') : '',
        isDelivery ? String(parseFloat(delivery_lng)||'') : '',
        calcDistKm, calcMapsUrl,
        calcDelivFee,
        pickupSnapshot.pickup_store_name_snapshot, pickupSnapshot.pickup_place_name_snapshot, pickupSnapshot.pickup_place_id_snapshot,
        pickupSnapshot.pickup_address_snapshot, pickupSnapshot.pickup_address_note_snapshot,
        pickupSnapshot.pickup_lat_snapshot, pickupSnapshot.pickup_lng_snapshot,
        itemsJson, payment_method||'cash', payment_category, 'pending',
        sub, 'none', discAmt, sub, appliedCouponCode, finalTotal,
        note||'', 'synced', 'LINE', 'line', nowStr, nowStr, knownLineUserId||''
      ]
    );

    // ── fix18-05：寫入 coupon_redemptions（訂單建立成功後）
    if (appliedCouponId) {
      try {
        db.run(
          `INSERT OR IGNORE INTO coupon_redemptions
             (store_id, coupon_id, coupon_code, order_id, order_number,
              customer_phone, discount_amount, original_total, final_total, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            storeId, appliedCouponId, appliedCouponCode,
            uuid, orderNo,
            String(customer_phone || '').trim(),
            discAmt, sub, finalTotal, nowStr
          ]
        );
      } catch (rErr) {
        console.error('[line-orders] coupon_redemptions 寫入失敗:', rErr.message);
        // redemption 寫入失敗不中斷訂單，但記錄錯誤
      }
    }

    // ── 扣 LINE 份數（不動主庫存）────────────────────
    // 規則：
    //   今日訂單 → 扣 line_quota_sold（只要 line_quota_daily > 0 即扣，不需 enabled=1）
    //   預購訂單 → 扣 line_preorder_sold（只要 line_preorder_daily > 0 即扣）
    items.forEach(item => {
      const pid = item.product_id || item.id;
      if (!pid) return;
      const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
      if (!prod) return;
      const qty = Number(item.qty || 1);
      if (isPreorderOrder) {
        // 預購：扣 line_preorder_sold（不扣今日 quota）
        if (Number(prod.line_preorder_daily) > 0 || Number(prod.line_preorder_enabled)) {
          db.run(
            `UPDATE products SET line_preorder_sold = MAX(0, line_preorder_sold + ?),
             updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
            [qty, pid, storeId]
          );
        }
      } else {
        // 今日：扣 line_quota_sold（只要有設定今日份數即扣）
        if (Number(prod.line_quota_daily) > 0 || Number(prod.line_quota_enabled)) {
          db.run(
            `UPDATE products SET line_quota_sold = MAX(0, line_quota_sold + ?),
             updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
            [qty, pid, storeId]
          );
        }
      }
    });

    deductIngredients(db, storeId, items, orderNo);

    const newOrder = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [uuid, storeId]);
    // ── 訂單建立通知 ─────────────────────────────────
    // 只廣播 order_created（讓後台列表刷新），不送 new_line_order（避免 Android 提前出單）
    // Android 出單事件只在店家按【接單】（PATCH status=accepted）後才廣播
    try {
      const wss = req.app?.get ? req.app.get('wss') : null;
      broadcastToStore(wss, storeId, { type: 'line_order_created', order: { ...newOrder, items } });
    } catch {}
    triggerN8nWebhook(db, storeId, 'line_new_order', {
      order_number: orderNo, customer_name, customer_phone,
      customer_line_id: customer_line_id||'', order_type, total: finalTotal,
      payment_method: payment_method||'cash', items
    });

    // ── fix18-10-hotfix23-A：Analytics Foundation ──────────────────────
    // submit_order：訂單後端建立成功時寫入（無論付款方式）。
    // purchase：非 LINE Pay 訂單在此視為成交立即寫入；LINE Pay 訂單的 purchase
    // 改由 routes/linepay.js 的 /confirm 成功時才寫入（此處不寫，避免顧客未完成
    // 付款卻被算入成交）。事件寫入失敗絕不影響訂單本身（analyticsLog 內部已 try/catch）。
    try {
      const ap = (analyticsPayload && typeof analyticsPayload === 'object') ? analyticsPayload : {};
      const evtBase = {
        store_id: storeId,
        visitor_id: ap.visitor_id || `unknown_${uuid}`,
        session_id: ap.session_id || `unknown_${uuid}`,
        cart_id: ap.cart_id || null,
        order_id: uuid,
        order_mode: orderMode,
        source: ap.source || null,
        medium: ap.medium || null,
        campaign: ap.campaign || null,
        referrer: ap.referrer || null,
        landing_page: ap.landing_page || null,
        fbclid: ap.fbclid || null,
        gclid: ap.gclid || null,
        // fix18-10-hotfix23-D：first_touch／last_touch／utm_content／utm_term 一律走白名單
        // 組裝（buildTrackingMetadata 只挑追蹤欄位，前端塞入其他資料不會被寫入）
        metadata: buildTrackingMetadata(ap),
        // fix18-10-hotfix24-A3：Identity × Channel（需求文件四／六）—— knownLineUserId
        // 是本檔案已用 verifyMemberSession() 驗證過的 line_user_id（見上方下單流程），
        // 這裡的訂單一律來自 LINE 點餐頁面，channel_source 固定為 'line'。
        line_user_id: knownLineUserId || null,
        channel_source: 'line',
      };
      logServerEvent(db, { ...evtBase, event_name: 'submit_order' });
      // fix18-10-hotfix23-E：訂單成立就更新 order_count/first_order_at/last_order_at
      // （無論付款方式）；total_spent/LTV/首購回購只在「真正成交」時才累加。
      if (knownLineUserId) touchMemberOnOrder(db, storeId, knownLineUserId);
      if (payment_method !== 'linepay') {
        const purchaseWritten = logServerEvent(db, { ...evtBase, event_name: 'purchase' });
        if (purchaseWritten && knownLineUserId) {
          const purchaseEvent = recordMemberPurchase(db, storeId, knownLineUserId, uuid, finalTotal);
          if (purchaseEvent) logServerEvent(db, { ...evtBase, event_name: purchaseEvent === 'first_purchase' ? 'member_first_purchase' : 'member_repeat_purchase' });
        }
      }
      // LINE Pay：這裡只寫 submit_order，total_spent/LTV 改由 routes/linepay.js
      // 的 /confirm 成功時呼叫 recordMemberPurchase()，避免顧客未完成付款卻被計入。
    } catch (evtErr) {
      console.warn('[line-orders] analytics event write failed:', evtErr.message);
    }

    // fix18-10-hotfix26-F4：完成頁需要顯示取餐門市/地址，直接回傳剛寫入的 snapshot
    // 解析結果，向下相容新增 pickup_location 欄位（不移除任何既有 response 欄位）。
    // 外送/宅配一律回傳 null，不得誤回取餐地址（resolvePickupLocation 內部已判斷
    // order_mode==='delivery' 回傳 null）。
    const pickupLocation = resolvePickupLocation(newOrder, db, storeId);

    // fix18-10-hotfix26-F8-B（需求文件十五）：token 消費是「盡力而為」的收尾動作，
    // 失敗（token 不存在/已過期/已用過）不得影響訂單本身已經成立這件事，只記 log。
    if (cart_token) {
      try {
        const { consumeCartToken } = require('../utils/lineCheckoutHandoff');
        const consumeResult = consumeCartToken(db, storeId, String(cart_token), uuid);
        if (consumeResult && consumeResult.ok) {
          try {
            logServerEvent(db, {
              store_id: storeId,
              visitor_id: `order_${uuid}`, session_id: `order_${uuid}`,
              order_id: uuid, event_name: 'line_checkout_handoff_consumed',
              line_user_id: knownLineUserId || null, metadata: {},
            });
          } catch (analyticsErr) { /* Analytics 失敗不影響訂單已成立 */ }
        }
      } catch (tokErr) {
        console.warn('[line-orders] cart_token consume failed:', tokErr.message);
      }
    }

    res.json({ success: true, data: {
      order_number: orderNo, uuid, total: finalTotal,
      delivery_fee: calcDelivFee, distance_km: calcDistKm,
      pickup_location: pickupLocation,
    } });
  } catch(e) {
    console.error('[line-orders] POST error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /online（Web POS LINE 訂單列表）──────────────────
router.get('/online', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { status, limit=50, offset=0 } = req.query;
    let where = "WHERE store_id=? AND source='line'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND order_status=?'; params.push(status); }
    const orders = db.all(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ).map(o => ({ ...o, items: typeof o.items==='string' ? JSON.parse(o.items||'[]') : (o.items||[]) }));
    const counts = db.all(
      `SELECT order_status, COUNT(*) as cnt FROM orders WHERE store_id=? AND source='line' GROUP BY order_status`,
      [storeId]
    );
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c.order_status] = Number(c.cnt); });
    res.json({ success: true, data: orders, status_counts: statusCounts });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /online/:id/status ──────────────────────────────
// hotfix13-BUG7：跟 orders.js PATCH /:id/status、online-orders.js PATCH /:id/status
// 共用同一份 utils/orderStatusFlow.applyOrderStatusChange() 商業邏輯，
// 三支 API（Web LINE 訂單中心 / Web POS / Android）行為保證一致，不會各自為政。
router.patch('/online/:id/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.order_status;

    const order = db.get(
      `SELECT * FROM orders WHERE store_id=? AND (order_number=? OR id=? OR uuid=?)`,
      [storeId, rawId, rawId, rawId]
    );
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: '找不到訂單：' + rawId });

    const result = applyOrderStatusChange(db, storeId, order, newStatus);
    if (!result.ok) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    const orderNo = order.order_number;
    const verified = db.get(
      `SELECT order_number, status, order_status, kitchen_status, updated_at, refund_status FROM orders WHERE order_number=? AND store_id=?`,
      [orderNo, storeId]
    );
    if (!verified || verified.order_status !== newStatus)
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED', expected: newStatus, actual: verified?.order_status });

    const fullOrder = result.data;
    try {
      const wss = req.app.get('wss');
      // 基本狀態變更廣播（後台刷新用）
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: fullOrder });

      // 接單時才觸發 Android POS 出單（new_line_order）
      if (newStatus === 'accepted') {
        broadcastToStore(wss, storeId, { type: 'new_line_order', order: fullOrder });
      }
    } catch {}

    triggerN8nWebhook(db, storeId, 'line_order_status_changed', {
      order_number: order.order_number, customer_line_id: order.customer_line_id,
      old_status: order.order_status, new_status: newStatus,
      reject_reason: req.body.reject_reason||''
    });
    res.json({
      success: true,
      data: fullOrder,
      requires_refund: result.requiresRefund,
      message: result.message,
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

const STATUS_LABELS = { pending:'待確認', accepted:'已接單', preparing:'製作中', ready:'可取餐', completed:'已完成', cancelled:'已取消' };
const ORDER_TYPE_LABELS = { delivery:'外送', takeout:'自取', pickup:'自取' };
const PAYMENT_LABELS = { cash:'現金', linepay:'LINE Pay', transfer:'轉帳', platform:'平台付款', credit_card:'信用卡' };

function safeOrder(order, db, storeId) {
  let items = [];
  try { items = typeof order.items==='string' ? JSON.parse(order.items||'[]') : (order.items||[]); } catch {}
  const phone = String(order.customer_phone || '');
  // fix18-10-hotfix26-F4：外帶訂單附上取餐門市/地址（外送回傳 null，見
  // resolvePickupLocation）。查詢訂單／我的訂單／歷史訂單詳情共用同一份 resolver，
  // 確保跟訂單完成頁（POST / 回傳的 pickup_location）資料來源完全一致。
  const pickupLocation = resolvePickupLocation(order, db, storeId);
  return {
    order_number: order.order_number, status: order.order_status,
    status_label: STATUS_LABELS[order.order_status] || order.order_status,
    order_type: order.order_mode, order_type_label: ORDER_TYPE_LABELS[order.order_mode] || order.order_mode,
    pickup_time: order.pickup_time||'', customer_name: order.customer_name||'',
    phone_last3: phone.slice(-3), items,
    subtotal: Number(order.subtotal||0), total: Number(order.total||0),
    payment_method: order.payment_method||'', payment_label: PAYMENT_LABELS[order.payment_method]||order.payment_method||'',
    note: order.note||'', created_at: order.created_at, source: order.source,
    pickup_location: pickupLocation,
    pickup_store_name: pickupLocation ? pickupLocation.store_name : '',
    pickup_place_name: pickupLocation ? (pickupLocation.place_name || '') : '',
    pickup_address: pickupLocation ? pickupLocation.address : '',
    pickup_address_note: pickupLocation ? (pickupLocation.address_note || '') : '',
    pickup_coords_only: pickupLocation ? !!pickupLocation.coords_only : false,
    pickup_lat: pickupLocation ? pickupLocation.lat : null,
    pickup_lng: pickupLocation ? pickupLocation.lng : null,
    pickup_maps_url: pickupLocation ? pickupLocation.maps_url : '',
  };
}

function isFullPhone(input) { return /^\d{6,}$/.test(String(input||'').replace(/[-\s]/g,'')); }

router.get('/status/:orderNo', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const order = db.get(
      'SELECT order_number, order_status, kitchen_status, created_at, total FROM orders WHERE store_id=? AND order_number=?',
      [storeId, req.params.orderNo]
    );
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    res.json({ success: true, data: order });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/query', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawPhone = String(req.body.phone||req.body.customer_phone||'').trim();
    const rawName  = String(req.body.customer_name||'').trim();
    const rawOrderNo = String(req.body.order_number||'').trim();

    if (!rawPhone && rawOrderNo) {
      const order = db.get("SELECT * FROM orders WHERE store_id=? AND order_number=? AND source='line'", [storeId, rawOrderNo]);
      if (!order) return res.status(404).json({ success: false, message: '查無此訂單' });
      return res.json({ success: true, mode: 'single', orders: [safeOrder(order, db, storeId)] });
    }
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話或電話後三碼' });

    const now3 = twNow();
    const todayStr2 = twDateStr(now3);
    const threeDaysAgo = (() => { const d=new Date(now3); d.setDate(d.getDate()-3); return twDateStr(d); })();
    const fullPhone = isFullPhone(rawPhone);

    if (rawOrderNo) {
      const order = db.get("SELECT * FROM orders WHERE store_id=? AND order_number=? AND source='line'", [storeId, rawOrderNo]);
      if (!order) return res.status(404).json({ success: false, message: '查無此訂單，請確認訂單編號或電話' });
      const storedPhone = String(order.customer_phone||'');
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const verified = storedPhone===cleaned || storedPhone.endsWith(cleaned.slice(-3)) || (cleaned.length>=4 && storedPhone.endsWith(cleaned));
      if (!verified) return res.status(403).json({ success: false, message: '查無此訂單，請確認訂單編號或電話' });
      return res.json({ success: true, mode: 'single', orders: [safeOrder(order, db, storeId)] });
    }
    if (fullPhone) {
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const orders = db.all("SELECT * FROM orders WHERE store_id=? AND source='line' AND customer_phone=? ORDER BY created_at DESC LIMIT 30", [storeId, cleaned]);
      if (!orders.length) return res.status(404).json({ success: false, message: '查無訂單記錄，請確認電話號碼' });
      return res.json({ success: true, mode: 'list', orders: orders.map(o => safeOrder(o, db, storeId)) });
    }
    const last3 = rawPhone.slice(-3);
    if (!/^\d{3}$/.test(last3)) return res.status(400).json({ success: false, message: '電話後三碼請輸入3位數字' });
    if (rawName) {
      const orders = db.all(
        `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND customer_name LIKE ? AND date(created_at) >= ? ORDER BY created_at DESC LIMIT 10`,
        [storeId, last3, `%${rawName}%`, threeDaysAgo]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天訂單，請確認資料或詢問店員' });
      return res.json({ success: true, mode: 'list', orders: orders.map(o => safeOrder(o, db, storeId)) });
    } else {
      const orders = db.all(
        `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND date(created_at)=? ORDER BY created_at DESC LIMIT 10`,
        [storeId, last3, todayStr2]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無今日訂單，請確認電話後三碼或詢問店員' });
      return res.json({ success: true, mode: 'list', orders: orders.map(o => safeOrder(o, db, storeId)) });
    }
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/history', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawPhone = String(req.body.phone||'').trim();
    const rawName  = String(req.body.customer_name||'').trim();
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話' });
    const now4 = twNow();
    const threeDaysAgo2 = (() => { const d=new Date(now4); d.setDate(d.getDate()-3); return twDateStr(d); })();
    const fullPhone = isFullPhone(rawPhone);
    if (fullPhone) {
      const cleaned = rawPhone.replace(/[-\s]/g,'');
      const orders = db.all("SELECT * FROM orders WHERE store_id=? AND source='line' AND customer_phone=? ORDER BY created_at DESC LIMIT 30", [storeId, cleaned]);
      if (!orders.length) return res.status(404).json({ success: false, message: '查無訂單記錄，請確認電話號碼' });
      return res.json({ success: true, orders: orders.map(o => safeOrder(o, db, storeId)) });
    }
    if (!rawName) return res.status(400).json({ success: false, message: '電話後三碼查詢需搭配姓名' });
    const last3 = rawPhone.slice(-3);
    if (!/^\d{3}$/.test(last3)) return res.status(400).json({ success: false, message: '電話後三碼請輸入3位數字' });
    const orders = db.all(
      `SELECT * FROM orders WHERE store_id=? AND source='line' AND substr(customer_phone,-3)=? AND customer_name LIKE ? AND date(created_at) >= ? ORDER BY created_at DESC LIMIT 30`,
      [storeId, last3, `%${rawName}%`, threeDaysAgo2]
    );
    if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天訂單，請確認資料或詢問店員' });
    return res.json({ success: true, orders: orders.map(o => safeOrder(o, db, storeId)) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PUT /quota-reset — 每日重置 LINE 已售份數（排程用）──
// POST /api/line-orders/quota-reset
router.post('/quota-reset', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    db.run(
      `UPDATE products SET line_quota_sold=0, updated_at=datetime('now','localtime')
       WHERE store_id=? AND line_quota_enabled=1`,
      [storeId]
    );
    // 同時重置預購已售數（若有指定參數 reset_preorder=1 才重置）
    if (req.body && req.body.reset_preorder) {
      db.run(
        `UPDATE products SET line_preorder_sold=0, updated_at=datetime('now','localtime')
         WHERE store_id=? AND line_preorder_enabled=1`,
        [storeId]
      );
    }
    res.json({ success: true, message: 'LINE 今日已售份數已重置' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
// fix18-10-hotfix22D：匯出既有 Business Calendar 唯讀查詢函式，供 routes/line-shipping.js
// 的「冷藏宅配公告」自動休假判斷共用（不重寫、不修改 Business Calendar 本身邏輯）。
module.exports.getCalendarDateInfo = getCalendarDateInfo;
module.exports.getEffectiveModeSchedule = getEffectiveModeSchedule;
