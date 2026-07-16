// routes/line-analytics.js — fix18-10-hotfix26-E｜LINE Verify Health Dashboard
// × LINE Analytics Center
//
// 重要：這支路由是純粹「唯讀報表」，只從既有的 analytics_events／line_members／
// line_member_history／settings 讀資料做聚合統計。完全不呼叫 LINE 官方 API、
// 不寫入任何資料、不判斷 verify 成功/失敗（那個判斷早就由 routes/line-member.js
// 的 verifyLineIdToken() 做完並寫進 analytics_events 了，這裡只是把已經寫好的
// 紀錄讀出來、統計、分類顯示）。
//
// 不是第二套 Verify API／Login／Verify Logic —— 這裡沒有任何一個 endpoint 會
// 建立會員、驗證 token、或改變登入判斷結果。
//
// 安全原則：
//   - 全部 GET，全部 requireStaffJwt（管理者專用）。
//   - 一律以 req.storeId（requireStaffJwt 設定）隔離查詢，不接受前端傳入
//     tenant_id／store_id 覆蓋。
//   - 不回傳 token／secret／完整 LINE User ID（identity 一律用 maskLineUserId 遮罩）。
//   - 「今日切換日期只打一支 API」：GET /health 一次回傳 summary／
//     error_breakdown／timeline／line_health／analytics／oa_center，
//     前端不必每個區塊各自打一支 API。

'use strict';
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireStaffJwt } = require('../middleware/storeGuard');
const { resolveDateRange, DashboardDateError, ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('../utils/dashboardDate');
const { maskLineUserId } = require('../utils/lineMemberStats');

// ── 期間參數解析（需求文件二：today/yesterday/last7/last30/month/custom）───
// 完全重用既有 utils/dashboardDate.js 的 resolveDateRange()，不另外寫第二套
// 日期計算邏輯；last7／last30 用 'custom' preset 帶入算好的起訖日期，時區固定
// Asia/Taipei（resolveDateRange 本身就只支援這個時區，不允許改別的）。
function twTodayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const map = {}; parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}
function subtractDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}
function resolvePeriod(query) {
  const period = (query.period || 'today').trim();
  const today = twTodayStr();
  if (period === 'last7') return resolveDateRange({ preset: 'custom', start_date: subtractDays(today, 6), end_date: today });
  if (period === 'last30') return resolveDateRange({ preset: 'custom', start_date: subtractDays(today, 29), end_date: today });
  if (period === 'month') return resolveDateRange({ preset: 'month' });
  if (period === 'yesterday') return resolveDateRange({ preset: 'yesterday' });
  if (period === 'custom') return resolveDateRange({ preset: 'custom', start_date: query.start_date, end_date: query.end_date });
  return resolveDateRange({ preset: 'today' });
}

// metadata_json 是純文字 JSON，讀取時安全解析，失敗一律回空物件（不得讓整支
// 報表 500，也不得把未知錯誤變成 500——需求文件四）。
function safeParseMetadata(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; }
}

// fix18-10-hotfix26-G（需求文件二十六）：「使用者登入狀態已過期／可恢復」事件
// 與真正的「系統故障／設定錯誤」分開統計，不能讓 EXPIRED_ID_TOKEN 這類可恢復
// 事件單獨拖累 Verify 系統健康度判斷成 🔴。純粹是「顯示分類」，不改變既有
// verifyLineIdToken() 判斷邏輯或既有 code 值。
const SESSION_EXPIRED_CODES = new Set([
  'EXPIRED_ID_TOKEN', 'LINE_RELOGIN_REQUIRED', 'ID_TOKEN_MISSING', 'ACCESS_TOKEN_EXPIRED',
]);
function isSessionExpiredCode(code) { return SESSION_EXPIRED_CODES.has(code); }
// 設定錯誤（真正需要人工修正 LINE Developers 設定的錯誤），與其他系統性故障
// （網路逾時／LINE API 5xx／未知例外）分開顯示，方便判斷是否要去檢查後台設定。
const CONFIG_ERROR_LABELS = new Set(['Audience Mismatch', 'Store Config Missing']);

// ── Verify Error Breakdown 分類（需求文件四）─────────────────────────
// 純粹是「顯示分類」，不是修改 utils/lineMemberAuth.js 既有的 code／reason 值。
// reason 是主要依據，code／http_status 用來做更細的分桶。誠實限制：目前的
// verify 流程（本輪禁止修改）在一般（非 debug）情況下不會保留 LINE 原始
// error/error_description 字串，所以「Invalid Client」與「Invalid Grant」
// 無法 100% 精準區分——這裡把「audience／expired／no_sub／缺參數／HTTP
// 403/429/500」以外的一般性驗證失敗歸類為 Invalid Grant（id_token 本身有問題
// 是比 client_id 有問題更常見的情境），並在文件與回報中誠實註記這個限制。
function bucketVerifyFailure(reason, code, httpStatus) {
  if (reason === 'aud_mismatch' || code === 'CHANNEL_ID_MISMATCH' || code === 'INVALID_ID_TOKEN_AUDIENCE') return 'Audience Mismatch';
  if (reason === 'expired' || code === 'EXPIRED_ID_TOKEN') return 'Expired Token';
  if (reason === 'no_sub') return 'No Sub';
  if (code === 'STORE_CONFIG_MISSING') return 'Store Config Missing';
  if (code === 'MISSING_ID_TOKEN') return 'Missing ID Token';
  const status = Number(httpStatus) || 0;
  if (status === 403) return 'HTTP 403';
  if (status === 429) return 'HTTP 429';
  if (status >= 500) return 'HTTP 500';
  if (reason === 'verify_failed') return 'Invalid Grant';
  if (reason === 'exception') return 'Unknown';
  return 'Unknown';
}

// ── 讀取一段期間內的 verify 相關事件（line_login_success / line_login_failed）──
function fetchVerifyEvents(db, storeId, range, limit) {
  const where = `store_id=? AND event_name IN ('line_login_success','line_login_failed') AND ${A_LOCAL} BETWEEN ? AND ?`;
  const params = [storeId, range.startLocal, range.endLocal];
  const sql = `SELECT event_name, metadata_json, created_at, identity_key FROM analytics_events WHERE ${where} ORDER BY created_at DESC` + (limit ? ` LIMIT ${Number(limit)}` : '');
  return db.all(sql, params);
}

// ── Verify Summary + Error Breakdown 一次算完（需求文件二／四）───────────
// fix18-10-hotfix26-E（需求文件十一）：management 診斷中心自己送出的
// diagnostic_only 測試呼叫，排除在「真實顧客健康度」統計之外，避免管理員
// 自己按幾次「測試 LINE 設定」就把成功率洗掉。Verify Timeline 仍然會顯示
// 這些筆數（並標示 Diagnostic Only 欄位），只是不計入 summary/health。
function computeVerifySummary(db, storeId, range) {
  const events = fetchVerifyEvents(db, storeId, range, null);
  let success = 0; let failed = 0;
  let lastSuccessAt = null; let lastFailureAt = null; let lastHttpStatus = null; let lastEventAt = null;
  const httpStatusCounts = {};
  const errorBreakdownMap = {};
  let consecutiveFailures = 0;
  let sawNonDiagnosticEvent = false;
  // fix18-10-hotfix26-G：session-expired（可恢復）與系統性故障分開累計
  let sessionExpiredFailed = 0;
  let systemFaultFailed = 0;
  let systemConsecutiveFailures = 0;
  let sawNonDiagnosticSystemFault = false;
  const fingerprintCounts = {}; // 偵測是否重複送出同一枚過期 Token

  events.forEach((e) => {
    const meta = safeParseMetadata(e.metadata_json);
    if (meta.diagnostic_only === true) return; // 管理員自己的測試，不計入健康度統計

    const status = meta.http_status || 200;
    if (!lastEventAt) { lastEventAt = e.created_at; lastHttpStatus = status; }

    if (e.event_name === 'line_login_success') {
      success++;
      if (!lastSuccessAt) lastSuccessAt = e.created_at;
      sawNonDiagnosticEvent = true; // 只要遇到（由新到舊）第一筆成功，連續失敗計數就停止往前累加
      sawNonDiagnosticSystemFault = true;
    } else {
      failed++;
      if (!lastFailureAt) lastFailureAt = e.created_at;
      if (!sawNonDiagnosticEvent) consecutiveFailures++;
      const sessionExpired = isSessionExpiredCode(meta.code);
      if (sessionExpired) {
        sessionExpiredFailed++;
        if (meta.token_fingerprint) {
          fingerprintCounts[meta.token_fingerprint] = (fingerprintCounts[meta.token_fingerprint] || 0) + 1;
        }
      } else {
        systemFaultFailed++;
        if (!sawNonDiagnosticSystemFault) systemConsecutiveFailures++;
      }
      const label = bucketVerifyFailure(meta.reason, meta.code, status);
      errorBreakdownMap[label] = (errorBreakdownMap[label] || 0) + 1;
    }
    httpStatusCounts[status] = (httpStatusCounts[status] || 0) + 1;
  });

  const total = success + failed;
  const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : null;
  const failureRate = total > 0 ? Math.round((failed / total) * 1000) / 10 : null;
  const errorBreakdown = Object.entries(errorBreakdownMap)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));

  // fix18-10-hotfix26-G（需求文件二十六）：Verify API 系統健康度——分母排除
  // 「使用者登入狀態過期」這類可恢復事件，避免過期 Token 拖累系統健康度判斷。
  const systemTotal = success + systemFaultFailed;
  const systemHealthRate = systemTotal > 0 ? Math.round((success / systemTotal) * 1000) / 10 : null;
  const configErrorCount = errorBreakdown
    .filter(e => CONFIG_ERROR_LABELS.has(e.label))
    .reduce((sum, e) => sum + e.count, 0);
  // 同一枚過期 Token 的指紋出現 ≥2 次 → 疑似前端重複送出同一枚 Token（需求文件二十六／二十七）
  const duplicateExpiredTokenSuspected = Object.values(fingerprintCounts).some(c => c >= 2);

  return {
    total, success, failed, successRate, failureRate,
    lastSuccessAt, lastFailureAt, lastHttpStatus,
    httpStatusCounts, errorBreakdown, consecutiveFailures,
    // fix18-10-hotfix26-G 新增欄位（additive，既有欄位維持不變，不影響既有呼叫端）
    session_expired_count: sessionExpiredFailed,
    system_fault_failed: systemFaultFailed,
    system_health_rate: systemHealthRate,
    system_consecutive_failures: systemConsecutiveFailures,
    config_error_count: configErrorCount,
    duplicate_expired_token_suspected: duplicateExpiredTokenSuspected,
  };
}

// ── Health Rule Engine（需求文件五）───────────────────────────────────
// 純函式，方便 smoke test 直接驗證規則邊界。資料不足（total===0）時回
// insufficient_data，絕不把「沒有紀錄」顯示成 healthy。
function evaluateHealthRules(summary) {
  if (summary.total === 0) return { status: 'insufficient_data', reasons: ['期間內尚無 Verify 紀錄'] };

  const audienceMismatch = summary.errorBreakdown.find(e => e.label === 'Audience Mismatch');
  const audienceMismatchCount = audienceMismatch ? audienceMismatch.count : 0;
  const http500 = summary.httpStatusCounts['500'] || summary.httpStatusCounts[500] || 0;
  // fix18-10-hotfix26-G（需求文件二十六）：健康度判斷改用「系統健康度」／
  // 「系統性連續失敗」——排除 EXPIRED_ID_TOKEN 等使用者登入狀態過期（可恢復）
  // 事件，避免使用者剛好連續幾次過期 Token 就被誤判為 🔴 LINE Login 系統異常。
  // fix18-10-hotfix26-I（回歸修正）：hotfix26-G 把這裡改成只讀新欄位
  // system_health_rate／system_consecutive_failures，若呼叫端傳入的 summary
  // 物件沒有這兩個新欄位（例如既有 smoke-hotfix26-e.js 測試 fixture 只帶舊欄位
  // successRate／consecutiveFailures），會讀到 undefined，導致規則永遠判斷不出
  // critical/warning。這裡改為向下相容：新欄位不存在時 fallback 回舊欄位，
  // 產生正式資料的 computeVerifySummary() 一定會同時提供兩者，行為不受影響。
  const rate = summary.system_health_rate != null ? summary.system_health_rate : summary.successRate;
  const consecutive = summary.system_consecutive_failures != null ? summary.system_consecutive_failures : summary.consecutiveFailures;

  const reasons = [];
  // Critical 優先判斷（最嚴重的狀態要蓋過較輕的狀態）
  if (rate !== null && rate < 95) reasons.push(`系統健康度 ${rate}% < 95%`);
  if (consecutive >= 5) reasons.push(`連續系統性失敗 ${consecutive} 次 ≥ 5`);
  if (http500 >= 5) reasons.push(`HTTP 500 ${http500} 次 ≥ 5`);
  if ((rate !== null && rate < 95) || consecutive >= 5 || http500 >= 5) {
    return { status: 'critical', reasons };
  }

  const warnReasons = [];
  if (rate !== null && rate >= 95 && rate <= 97.99) warnReasons.push(`系統健康度 ${rate}%（95%～97.99%）`);
  if (audienceMismatchCount >= 1) warnReasons.push(`Audience Mismatch ${audienceMismatchCount} 次 ≥ 1`);
  if (consecutive >= 3 && consecutive <= 4) warnReasons.push(`連續系統性失敗 ${consecutive} 次（3～4 次）`);
  // fix18-10-hotfix26-G（需求文件二十六）：登入狀態過期本身不算異常，但若疑似
  // 同一枚過期 Token 被重複送出（前端 Token 重用問題），仍需要提示，而不是
  // 靜默放過或被計入系統故障。
  if (summary.duplicate_expired_token_suspected) {
    warnReasons.push('疑似重複提交同一枚過期 ID Token，可能存在前端 Token 重用問題');
  }
  if (warnReasons.length > 0) return { status: 'warning', reasons: warnReasons };

  return { status: 'healthy', reasons: [] };
}

function healthStatusMeta(status) {
  return {
    healthy: { icon: '🟢', text: '正常' },
    warning: { icon: '🟡', text: '需注意' },
    critical: { icon: '🔴', text: '異常' },
    insufficient_data: { icon: '⚪', text: '資料不足' },
    not_configured: { icon: '⚪', text: '尚未設定' },
    not_tracked: { icon: '⚪', text: '尚未追蹤' },
  }[status] || { icon: '⚪', text: '未知' };
}

// ── LINE Health / LINE OA Center 模組健康度（需求文件五／七）────────────
// 狀態值：healthy / warning / critical / not_configured / not_tracked。
// 誠實原則：沒有真的串接、或無法在不呼叫 LINE API 的情況下驗證的模組，一律
// not_configured／not_tracked，不假裝已驗證、不把「未設定」當「異常」。
function computeModules(db, storeId, range, verifySummary, ruleResult) {
  const getSetting = (key) => {
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    return row ? row.value : '';
  };
  const liffId = getSetting('line_member_liff_id');
  const channelToken = getSetting('line_channel_token');

  // Login／Verify 共用同一組 verify 事件統計與 Rule Engine 結果。
  const verifyModule = { status: ruleResult.status, reasons: ruleResult.reasons };
  const loginModule = verifyModule;

  const liffModule = liffId
    ? { status: 'healthy', reasons: [] }
    : { status: 'not_configured', reasons: ['尚未設定 LIFF ID'] };

  const messagingApiModule = channelToken
    ? { status: 'healthy', reasons: ['已設定 Channel Access Token（僅設定檢查，非即時連線測試）'] }
    : { status: 'not_configured', reasons: ['尚未設定 Channel Access Token'] };

  const friendshipCount = db.get(
    `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND event_name='friend_status_checked' AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || { c: 0 };
  const friendshipModule = friendshipCount.c > 0
    ? { status: 'healthy', reasons: [] }
    : { status: 'not_tracked', reasons: ['期間內尚無好友狀態查詢紀錄'] };

  const memberCount = db.get('SELECT COUNT(*) c FROM line_members WHERE store_id=?', [storeId]) || { c: 0 };
  const memberModule = memberCount.c > 0
    ? { status: 'healthy', reasons: [] }
    : { status: 'not_tracked', reasons: ['尚無會員資料'] };

  const timelineCount = db.get(
    `SELECT COUNT(*) c FROM line_member_history WHERE store_id=? AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || { c: 0 };
  const timelineModule = timelineCount.c > 0
    ? { status: 'healthy', reasons: [] }
    : { status: 'not_tracked', reasons: ['期間內尚無 Timeline 紀錄'] };

  let couponModule = { status: 'not_tracked', reasons: ['本專案目前沒有 Coupon × LINE 的關聯事件可統計'] };
  try {
    const couponRow = db.get('SELECT COUNT(*) c FROM coupons WHERE store_id=?', [storeId]);
    if (couponRow && couponRow.c > 0) couponModule = { status: 'healthy', reasons: [`共 ${couponRow.c} 組優惠券（一般設定存在，非 LINE 發送追蹤）`] };
  } catch (e) { /* coupons 表不存在或查詢失敗，維持 not_tracked */ }

  // Rich Menu：本專案完全沒有實作 Rich Menu 串接，誠實標示 not_configured。
  const richMenuModule = { status: 'not_configured', reasons: ['本專案尚未實作 Rich Menu 功能'] };

  const crmModule = (memberModule.status === 'healthy')
    ? { status: 'healthy', reasons: [] }
    : { status: memberModule.status, reasons: memberModule.reasons };

  return {
    login: loginModule, verify: verifyModule, liff: liffModule,
    messaging_api: messagingApiModule, friendship: friendshipModule,
    member: memberModule, timeline: timelineModule, coupon: couponModule,
    rich_menu: richMenuModule, crm: crmModule,
  };
}

function moduleToApiShape(mod) {
  const meta = healthStatusMeta(mod.status);
  return { status: mod.status, icon: meta.icon, text: meta.text, reasons: mod.reasons || [] };
}

// ── LINE Analytics Funnel（需求文件六）───────────────────────────────
// 每一項都標示 tracked:true/false；沒有可靠資料來源的一律 tracked:false、
// count:null，前端顯示「尚未追蹤」，不假造為 0。
function computeFunnel(db, storeId, range, verifySummary) {
  const countHistoryEvent = (eventName) => {
    const row = db.get(
      `SELECT COUNT(*) c FROM line_member_history WHERE store_id=? AND event_name=? AND created_at BETWEEN ? AND ?`,
      [storeId, eventName, range.startLocal, range.endLocal]
    );
    return (row && row.c) || 0;
  };
  const friendAdded = countHistoryEvent('friend_added') + countHistoryEvent('friend_restored');

  return [
    { key: 'login_attempts', label: 'Login Attempts', count: verifySummary.total, tracked: true },
    { key: 'verify_success', label: 'Verify Success', count: verifySummary.success, tracked: true },
    { key: 'verify_failed', label: 'Verify Failed', count: verifySummary.failed, tracked: true },
    { key: 'member_created', label: 'Member Created', count: countHistoryEvent('new_member'), tracked: true },
    { key: 'member_updated', label: 'Member Updated', count: countHistoryEvent('profile_updated'), tracked: true },
    { key: 'friend_added', label: 'Friend Added', count: friendAdded, tracked: true },
    { key: 'timeline_written', label: 'Timeline Written', count: db.get(
        `SELECT COUNT(*) c FROM line_member_history WHERE store_id=? AND created_at BETWEEN ? AND ?`,
        [storeId, range.startLocal, range.endLocal]
      ).c || 0, tracked: true },
    // 本專案沒有「發送優惠券給 LINE 好友」的追蹤事件，誠實標示尚未追蹤，不可假造為 0。
    { key: 'coupon_issued', label: 'Coupon Issued', count: null, tracked: false, note: '本專案尚未有 Coupon × LINE 的追蹤事件' },
  ];
}

// ════════════════════════════════════════════════════════════════
// GET /api/line-analytics/health?period=today|yesterday|last7|last30|month|custom
// ════════════════════════════════════════════════════════════════
router.get('/health', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    let range;
    try { range = resolvePeriod(req.query); }
    catch (e) {
      if (e instanceof DashboardDateError) return res.status(400).json({ success: false, message: e.message });
      throw e;
    }

    const summary = computeVerifySummary(db, storeId, range);
    const ruleResult = evaluateHealthRules(summary);
    const statusMeta = healthStatusMeta(ruleResult.status);
    const modules = computeModules(db, storeId, range, summary, ruleResult);
    const funnel = computeFunnel(db, storeId, range, summary);

    const storeRow = db.get('SELECT store_name FROM stores WHERE store_id=?', [storeId]);
    const storeName = (storeRow && storeRow.store_name) || storeId;

    // Verify Timeline：最近 50 筆（需求文件三）。identity 一律遮罩；不含
    // token／secret／完整 LINE User ID／Authorization。
    const rawEvents = fetchVerifyEvents(db, storeId, range, 50);
    const timeline = rawEvents.map((e) => {
      const meta = safeParseMetadata(e.metadata_json);
      const isSuccess = e.event_name === 'line_login_success';
      let identityMasked = null;
      if (e.identity_key && String(e.identity_key).startsWith('line_user:')) {
        identityMasked = maskLineUserId(String(e.identity_key).slice('line_user:'.length));
      }
      return {
        created_at: e.created_at,
        store: storeName,
        result: isSuccess ? 'Success' : 'Failed',
        http_status: meta.http_status || 200,
        code: isSuccess ? null : (meta.code || null),
        reason: isSuccess ? null : (meta.reason || null),
        elapsed_ms: (typeof meta.elapsed_ms === 'number') ? meta.elapsed_ms : null,
        diagnostic_only: meta.diagnostic_only === true,
        identity_masked: identityMasked,
        // fix18-10-hotfix26-G（需求文件二十七）：診斷欄位——絕不含完整 Token，
        // token_fingerprint 只是 sha256 前 8 碼，無法還原原始 Token。
        recoverable: isSuccess ? null : !!meta.recoverable,
        session_expired: isSuccess ? null : isSessionExpiredCode(meta.code),
        token_fingerprint: isSuccess ? null : (meta.token_fingerprint || null),
        retry_attempt: isSuccess ? null : (typeof meta.retry_attempt === 'number' ? meta.retry_attempt : 0),
        client_event: meta.client_event || null,
      };
    });

    res.json({
      success: true,
      period: { preset: range.preset, start_date: range.start_date, end_date: range.end_date },
      summary: {
        total: summary.total, success: summary.success, failed: summary.failed,
        success_rate: summary.successRate, failure_rate: summary.failureRate,
        last_success_at: summary.lastSuccessAt, last_failure_at: summary.lastFailureAt,
        last_http_status: summary.lastHttpStatus,
      },
      // fix18-10-hotfix26-G（需求文件二十六）：把「系統健康度」／「登入狀態過期」／
      // 「設定錯誤」拆開顯示，避免 EXPIRED_ID_TOKEN 這類可恢復事件跟真正的設定
      // 錯誤／系統故障混在一起，誤導管理者去檢查根本沒有問題的設定。
      session_health: {
        system_health_rate: summary.system_health_rate,
        system_fault_count: summary.system_fault_failed,
        session_expired_count: summary.session_expired_count,
        config_error_count: summary.config_error_count,
        session_expired_label: summary.session_expired_count > 0
          ? { icon: '🟡', text: '使用者登入狀態已過期' }
          : { icon: '⚪', text: '無' },
        duplicate_expired_token_suspected: summary.duplicate_expired_token_suspected,
      },
      health: { status: ruleResult.status, icon: statusMeta.icon, text: statusMeta.text, reasons: ruleResult.reasons },
      error_breakdown: summary.errorBreakdown,
      timeline,
      line_health: {
        login: moduleToApiShape(modules.login),
        verify: moduleToApiShape(modules.verify),
        liff: moduleToApiShape(modules.liff),
        messaging_api: moduleToApiShape(modules.messaging_api),
        friendship: moduleToApiShape(modules.friendship),
      },
      oa_center: {
        login: moduleToApiShape(modules.login), verify: moduleToApiShape(modules.verify),
        liff: moduleToApiShape(modules.liff), messaging_api: moduleToApiShape(modules.messaging_api),
        friendship: moduleToApiShape(modules.friendship), member: moduleToApiShape(modules.member),
        timeline: moduleToApiShape(modules.timeline), coupon: moduleToApiShape(modules.coupon),
        rich_menu: moduleToApiShape(modules.rich_menu), crm: moduleToApiShape(modules.crm),
      },
      analytics: { funnel },
    });
  } catch (e) {
    console.error('[line-analytics] GET /health error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;

// fix18-10-hotfix26-E：純函式掛在 router 上，只供 smoke test 直接驗證規則
// 邊界與統計計算，不影響正常掛載方式（express Router 是 function，可以安全
// 附加額外屬性，沿用 routes/line-member.js 已有的作法）。
router.__test = {
  evaluateHealthRules, healthStatusMeta, bucketVerifyFailure,
  resolvePeriod, twTodayStr, subtractDays, safeParseMetadata,
  computeVerifySummary, computeModules, computeFunnel,
  isSessionExpiredCode, SESSION_EXPIRED_CODES,
};
