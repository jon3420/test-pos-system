// utils/cartRecoveryDelivery.js
// H1.4.10 Phase 4B — LINE Recovery Eligibility Engine × Due Job Processor
//
// Phase 4A 回答「誰尚未完成？」（cart_recovery_jobs 狀態機）。
// 這支模組回答「這個人是否可以合法、安全地透過 LINE 提醒？」——兩件事
// 完全分開，Recovery Job 存在不代表可以 Push。
//
// 這支模組本身不呼叫 LINE API（那是 utils/linePush.js 的職責），不做狀態
// 轉移判斷（那是 utils/cartRecovery.js 的職責），只做：
//   1. evaluateLineRecoveryEligibility()：eligibility 判斷（純函式，不寫入）
//   2. processDueLineRecoveryJobs()：串起 eligibility → 建立安全連結 →
//      呼叫 utils/linePush.js → 更新 job 狀態
//
// Phase 4B 不建立 cron／setInterval／unauthenticated process endpoint——這支
// 函式只是「可以被呼叫」的 service，由誰在什麼時機呼叫它，留給 Phase 4C。

'use strict';

const linePushModule = require('./linePush');
const { hasValidConsent, getConsentStatus } = require('./cartRecoveryConsent');
const { createRecoveryResumeToken, cancelRecoveryToken } = require('./lineCheckoutHandoff');
const { getDelayMinutes } = require('./cartRecovery');

const REASON_WHITELIST = new Set([
  'recovery_disabled', 'line_recovery_disabled', 'job_not_due', 'job_not_pending',
  'already_converted', 'max_attempts_reached', 'consent_missing', 'consent_revoked',
  'member_not_identified', 'not_friend', 'friend_status_unknown', 'channel_token_missing',
  'recovery_link_unavailable', 'unsupported_variant', 'already_sent', 'unknown',
]);

function _safe(fn, fallback) {
  try { return fn(); } catch (e) {
    console.warn('[cartRecoveryDelivery] fail-open:', e.message);
    return fallback;
  }
}
function _nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function _getSetting(db, storeId, key, fallback) {
  return _safe(() => {
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    if (!row || row.value === undefined || row.value === null || row.value === '') return fallback;
    return row.value;
  }, fallback);
}

function isLineRecoveryEnabled(db, storeId) {
  return _getSetting(db, storeId, 'cart_recovery_line_enabled', '0') === '1';
}

// 只沿用既有 line_channel_token（settings 表），不新增第二份 token。
function getChannelAccessToken(db, storeId) {
  return _getSetting(db, storeId, 'line_channel_token', '');
}

// 只信任 line_members.is_friend（既有可信好友狀態來源，見 Reality Audit）。
// 回傳 'friend' | 'not_friend' | 'unknown'。
function getFriendStatus(db, storeId, lineUserId) {
  return _safe(() => {
    if (!lineUserId) return 'unknown';
    const row = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!row) return 'unknown';
    if (row.is_friend === 1 || row.is_friend === true) return 'friend';
    if (row.is_friend === 0 || row.is_friend === false) return 'not_friend';
    return 'unknown';
  }, 'unknown');
}

/**
 * evaluateLineRecoveryEligibility(db, storeId, job) → { eligible, reason_code }
 *
 * 純判斷函式，不寫入任何資料。job 應該是「剛從 DB 重新查出來」的最新狀態
 * （呼叫端負責在 send 前 re-fetch，見 processDueLineRecoveryJobs 的
 * race-condition 防護）。
 */
function evaluateLineRecoveryEligibility(db, storeId, job) {
  return _safe(() => {
    if (!job) return { eligible: false, reason_code: 'unknown' };

    // 1. Recovery master enabled
    const { isRecoveryEnabled } = require('./cartRecovery');
    if (!isRecoveryEnabled(db, storeId)) return { eligible: false, reason_code: 'recovery_disabled' };

    // 2. LINE recovery enabled
    if (!isLineRecoveryEnabled(db, storeId)) return { eligible: false, reason_code: 'line_recovery_disabled' };

    // 3/4/5. Job 狀態
    if (job.status === 'converted') return { eligible: false, reason_code: 'already_converted' };
    if (job.status === 'sent') return { eligible: false, reason_code: 'already_sent' };
    if (job.status !== 'pending' && job.status !== 'waiting') return { eligible: false, reason_code: 'job_not_pending' };

    // 6. Job 已 due
    const now = _nowIso();
    if (!job.due_at || job.due_at > now) return { eligible: false, reason_code: 'job_not_due' };

    // 7. attempt_count < max_attempts
    const maxAttempts = Number(job.max_attempts) || 1;
    const attemptCount = Number(job.attempt_count) || 0;
    if (attemptCount >= maxAttempts) return { eligible: false, reason_code: 'max_attempts_reached' };

    // 8. Consent（cart_id 是 consent 的 key，job 一定有 cart_id）
    const consentStatus = getConsentStatus(db, storeId, job.cart_id);
    if (consentStatus === 'none') return { eligible: false, reason_code: 'consent_missing' };
    if (consentStatus === 'revoked') return { eligible: false, reason_code: 'consent_revoked' };

    // 9. 可信 line_user_id
    if (!job.line_user_id) return { eligible: false, reason_code: 'member_not_identified' };

    // 10. 好友狀態必須可信且是好友（unknown 一律不發送——安全優先）
    const friendStatus = getFriendStatus(db, storeId, job.line_user_id);
    if (friendStatus === 'not_friend') return { eligible: false, reason_code: 'not_friend' };
    if (friendStatus === 'unknown') return { eligible: false, reason_code: 'friend_status_unknown' };

    // 11. 店家有 LINE Channel Access Token
    const token = getChannelAccessToken(db, storeId);
    if (!token) return { eligible: false, reason_code: 'channel_token_missing' };

    // 11b（本輪收緊，需求文件六／八）：Recovery target 對應的 LIFF ID 必須
    // 存在，否則無法用安全的 LIFF URL 延續 member_session 身分邊界，一律
    // 視為 recovery_link_unavailable，不降級成一般網頁連結。
    const { resolveRecoveryTarget } = module.exports;
    const target = resolveRecoveryTarget(db, storeId, job);
    const memberLiffId = _getSetting(db, storeId, 'line_member_liff_id', '');
    const shippingLiffId = _getSetting(db, storeId, 'line_shipping_liff_id', '');
    const liffId = target.page_type === 'line_shipping' ? (shippingLiffId || memberLiffId) : memberLiffId;
    if (!liffId) return { eligible: false, reason_code: 'recovery_link_unavailable' };

    // 12/13. 尚未 purchase／payment_success（job.status 已經在上面檢查過，
    // markRecoveryConverted() 一旦觸發就會把 status 改成 converted，這裡不用
    // 再重複查 analytics_events）。

    return { eligible: true, reason_code: null };
  }, { eligible: false, reason_code: 'unknown' });
}

// 需求文件五／六：Recovery Target Resolver。cart_id 本身不帶「屬於哪個頁面」
// 的資訊，唯一可信來源是既有 analytics_events 的 order_mode/order_channel
// （見 utils/cartSnapshot.js getFirstTouchMap()，line-shipping.html 的
// _trackEvent() 固定送 order_mode:'shipping'，line-order.html 送
// 'takeout'/'delivery'）——不得用 cart_id 字串格式猜。
function resolvePageType(db, storeId, cartId) {
  return _safe(() => {
    const { getFirstTouchMap } = require('./cartSnapshot');
    const touchMap = getFirstTouchMap(db, storeId, [cartId]);
    const touch = touchMap[cartId];
    const orderMode = (touch && (touch.order_channel || touch.order_mode)) || '';
    return orderMode === 'shipping' ? 'line_shipping' : 'line_order';
  }, 'line_order');
}

// 需求文件二～四：Cart / Checkout Recovery 的 authoritative 資料來源——沿用
// 既有 Cart Snapshot SSOT（utils/cartSnapshot.js），不建立第三套購物車快照
// 系統。優先用 cart_updated/cart_restored 的完整快照；沒有的話 fallback 到
// add_to_cart/remove_from_cart 淨算（既有 Dashboard 也用同一套 fallback）。
// 需求文件二～四（本輪收緊）：Restore Authority 與 Analytics 估算必須分開。
// getLegacyCartItemsMap()（SUM(add_to_cart)-SUM(remove_from_cart)）只適合
// Dashboard 的「大概還有多少東西」估算，不能拿來當「真的要發 LINE Push、
// 讓顧客點進去看到正確購物車」的 restore 依據——它無法反映商品被替換／
// 合併後的真實最終狀態，也不保留既有 restore 流程實際需要的資訊。Recovery
// Resume 只接受 getLatestSnapshotMap() 找到的完整快照（cart_updated 或帶
// 完整 items 的 cart_restored），找不到就誠實回 restorable:false，不
// fallback estimated（與純 Analytics 用途的 getLegacyCartItemsMap() 明確
// 分開，那支函式繼續只給 Dashboard 估算使用）。
function resolveRestorableCartSnapshot(db, storeId, cartId) {
  return _safe(() => {
    const { getLatestSnapshotMap } = require('./cartSnapshot');
    const snapMap = getLatestSnapshotMap(db, storeId, [cartId]);
    const snap = snapMap[cartId];
    if (!snap || !snap.metadata || !Array.isArray(snap.metadata.items) || !snap.metadata.items.length) {
      return { restorable: false, reason: 'snapshot_missing', items: null };
    }
    // 需求文件二（本輪 Reality Audit）：確認 public/line-order.html 的
    // _buildCartTrackingItems()（cart_updated metadata 的唯一寫入來源）目前
    // 永遠 hardcode variant:null，全專案沒有任何一處會賦予真實 variant 值，
    // recomputeCart() 也完全沒有 variant-aware 的商品 identity／價格判斷。
    // 也就是說「variant 只是保留欄位，不是已實作的功能」。若快照裡出現任何
    // 非空 variant（理論上不該發生，但不可信任「不會發生」這件事本身），
    // 代表這筆快照的來源已經超出目前已驗證的 restore 能力範圍——寧可安全
    // 拒絕（不追回這張購物車），也不要把「規格 A」誤還原成基本商品。這不是
        // 新造一套規格 pricing engine，只是 fail-closed 的邊界檢查。
    const hasUnsupportedVariant = snap.metadata.items.some((i) => i.variant !== null && i.variant !== undefined && i.variant !== '');
    if (hasUnsupportedVariant) {
      return { restorable: false, reason: 'unsupported_variant', items: null };
    }
    // 沿用既有 cart snapshot schema（見 utils/cartSnapshot.js _safeItems()：
    // product_id/name/qty/unit_price/subtotal/variant）。Recovery Token 只取
    // 既有 utils/lineCheckoutHandoff.js createCartHandoffToken() 既有 restore
    // 流程實際使用的欄位（product_id+qty——既有 Checkout Handoff 本身透過
    // token 也只保留這兩個欄位，recomputeCart() 會重新用 authoritative 商品
    // 資料計算名稱/價格/小計，不信任快照裡的顯示值）。
    const items = snap.metadata.items
      .map((i) => ({ product_id: Number(i.product_id), qty: Number(i.qty) }))
      .filter((i) => i.product_id && i.qty > 0);
    if (!items.length) return { restorable: false, reason: 'snapshot_missing', items: null };
    return { restorable: true, reason: null, items };
  }, { restorable: false, reason: 'exception', items: null });
}

// 需求文件六：Recovery Target Resolver（統整 page_type／resume_type／
// cart_items／order_id，processor 不得永遠 hardcode line-order.html）。
function resolveRecoveryTarget(db, storeId, job) {
  return _safe(() => {
    const pageType = resolvePageType(db, storeId, job.cart_id);
    if (job.stage === 'payment_abandoned') {
      return { resume_type: 'payment', page_type: pageType, cart_items: null, restorable: true, order_id: job.order_id || null };
    }
    const resumeType = job.stage === 'checkout_abandoned' ? 'checkout' : 'cart';
    const snapshot = resolveRestorableCartSnapshot(db, storeId, job.cart_id);
    return { resume_type: resumeType, page_type: pageType, cart_items: snapshot.items, restorable: snapshot.restorable, restorable_reason: snapshot.reason, order_id: null };
  }, { resume_type: 'cart', page_type: 'line_order', cart_items: null, restorable: false, restorable_reason: 'exception', order_id: null });
}

// 需求文件八（本輪收緊）：Recovery Push 一定是從官方 LINE 對話點擊，必須
// 使用 LIFF URL 才能延續 Phase 1 的 member_session/LINE UID 安全邊界——
// 拿掉 LIFF、改用一般網頁 URL 等於允許「token 本身當身分」的降級路徑，
// 這裡明確禁止，找不到對應 LIFF ID 一律 { ok:false, reason:'missing_liff_id' }。
function buildRecoveryUrl(db, storeId, { token, pageType }) {
  return _safe(() => {
    const memberLiffId = _getSetting(db, storeId, 'line_member_liff_id', '');
    const shippingLiffId = _getSetting(db, storeId, 'line_shipping_liff_id', '');
    const liffId = pageType === 'line_shipping' ? (shippingLiffId || memberLiffId) : memberLiffId;
    if (!liffId) return { ok: false, reason: 'missing_liff_id', url: null };
    return { ok: true, reason: null, url: `https://liff.line.me/${encodeURIComponent(liffId)}?recovery_token=${encodeURIComponent(token)}` };
  }, { ok: false, reason: 'exception', url: null });
}

// 需求文件二十三：柔性提醒文案，三個 stage 各自固定，不做倒數/緊迫感字眼。
function buildRecoveryMessageText(stage, url) {
  const copyMap = {
    cart_abandoned: '你的購物車還保留著，如果還想完成訂購，可以從這裡繼續。',
    checkout_abandoned: '你剛剛的訂單還沒有完成，如果需要，可以從這裡繼續結帳。',
    payment_abandoned: '你的 LINE Pay 付款似乎尚未完成，如果仍要完成訂單，可以從這裡返回確認。',
  };
  const body = copyMap[stage] || copyMap.cart_abandoned;
  return `${body}\n${url}`;
}

/**
 * processDueLineRecoveryJobs(db, storeId, options)
 *
 * 只是「可以被呼叫」的 service，不接 cron/scheduler（Phase 4C 才決定由誰
 * 觸發）。options.baseUrl 用來組 Recovery URL（呼叫端負責提供，這裡不猜測
 * 網域）。
 */
async function processDueLineRecoveryJobs(db, storeId, options = {}) {
  const { getRecoverableJobs, STAGES } = require('./cartRecovery');
  const baseUrl = options.baseUrl || '';
  const results = { processed: 0, sent: 0, skipped: 0, failed: 0, details: [] };

  const allDueCandidates = _safe(() => {
    let all = [];
    STAGES.forEach((stage) => { all = all.concat(getRecoverableJobs(db, storeId, { stage })); });
    // 需求文件二十八：getRecoverableJobs() 本身已經只回傳 due_at<=now 的
    // job（不含未到期的 future job，所以不存在「被 future rows 卡住」的
    // 情境），但三個 stage 各自排序後串接會破壞跨 stage 的全域 due_at
    // 順序，這裡重新依 due_at ASC（id ASC 當 tie-breaker）全域排序，確保
    // 最早到期的一定排在最前面，才不會被 limit 誤切掉。
    all.sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : a.id - b.id));
    return all;
  }, []);
  const hasLimit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0;
  const jobs = hasLimit ? allDueCandidates.slice(0, Number(options.limit)) : allDueCandidates;
  // 需求文件二十九-A：has_more 直接基於「真正的 due 候選總數是否超過這次
  // 處理的筆數」，不是靠 processed>=limit 事後猜測（那在 limit 前被過濾掉
  // 一部分 job、或剛好等於 limit 時都會算錯）。
  results.has_more = hasLimit && allDueCandidates.length > jobs.length;

  for (const jobStub of jobs) {
    results.processed += 1;
    try {
      // 需求文件十八：race-condition 防護——重新從 DB 撈最新狀態，不信任
      // getRecoverableJobs() 快照回來的舊資料（顧客可能在這幾秒內完成付款）。
      const job = db.get('SELECT * FROM cart_recovery_jobs WHERE id=?', [jobStub.id]);
      if (!job) { results.skipped += 1; continue; }

      const evalResult = module.exports.evaluateLineRecoveryEligibility(db, storeId, job);
      if (!evalResult.eligible) {
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: evalResult.reason_code });
        // 只對「短期內不會自己改變」的原因做安全標記，避免資料被無意義覆寫；
        // job_not_due／max_attempts_reached 之類留待下次自然重跑判斷。
        if (evalResult.reason_code === 'channel_token_missing') {
          db.run(`UPDATE cart_recovery_jobs SET status='not_configured', updated_at=? WHERE id=? AND status IN ('pending','waiting')`, [_nowIso(), job.id]);
        } else if (['consent_missing', 'consent_revoked', 'member_not_identified', 'not_friend', 'friend_status_unknown'].includes(evalResult.reason_code)) {
          db.run(`UPDATE cart_recovery_jobs SET status='not_contactable', cancel_reason=?, updated_at=? WHERE id=? AND status IN ('pending','waiting')`, [evalResult.reason_code, _nowIso(), job.id]);
        }
        continue;
      }

      // 需求文件二～八：Recovery Target Resolver——決定這筆 job 要恢復到
      // 哪個頁面（line_order／line_shipping）、是 cart/checkout/payment 哪一種
      // resume，以及（cart/checkout）authoritative 的購物車內容。
      const target = resolveRecoveryTarget(db, storeId, job);
      if (target.resume_type !== 'payment' && !target.restorable) {
        // 需求文件四：找不到可恢復的 cart snapshot，或 snapshot 含未支援的
        // variant，不得假裝成功發一條「購物車還保留著」但點進去是空的或
        // 錯誤商品的訊息。
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: target.restorable_reason === 'unsupported_variant' ? 'unsupported_variant' : 'recovery_link_unavailable' });
        continue;
      }
      if (target.resume_type === 'payment' && !target.order_id) {
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: 'recovery_link_unavailable' });
        continue;
      }

      // 需求文件十八：Token TTL 不得晚於這筆 job 的 current-recoverable
      // horizon（= created_at + 24 小時），不是無條件固定 24 小時。
      const { CURRENT_RECOVERABLE_HORIZON_HOURS } = require('./cartRecovery');
      const jobCreatedMs = Date.parse((job.created_at || '').replace(' ', 'T') + 'Z');
      const horizonDeadlineMs = Number.isFinite(jobCreatedMs) ? jobCreatedMs + CURRENT_RECOVERABLE_HORIZON_HOURS * 3600000 : Date.now() + 24 * 3600000;
      const remainingMinutes = Math.max(1, Math.floor((horizonDeadlineMs - Date.now()) / 60000));

      // 建立安全 Recovery Token（需求文件十九：不把 cart_id/line_user_id/
      // order_id 當作可操作的 URL 參數，只放這裡產生的 random token）。
      const tokenResult = createRecoveryResumeToken(db, storeId, {
        cartId: job.cart_id, lineUserId: job.line_user_id,
        cartQtyItems: target.cart_items || [], orderId: target.order_id || '',
        resumeType: target.resume_type, pageType: target.page_type, ttlMinutes: remainingMinutes,
      });
      if (!tokenResult.ok) {
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: 'recovery_link_unavailable' });
        continue;
      }
      const urlResult = buildRecoveryUrl(db, storeId, { token: tokenResult.token, pageType: target.page_type });
      if (!urlResult.ok) {
        // 沒有 LIFF ID：剛建立的 token 尚未使用，安全作廢，不留下無法安全開啟的 token。
        cancelRecoveryToken(db, storeId, tokenResult.token);
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: 'recovery_link_unavailable' });
        continue;
      }
      const recoveryUrl = urlResult.url;
      const messageText = buildRecoveryMessageText(job.stage, recoveryUrl);

      // 需求文件十八／十九：SEND 前最後一次 recheck（同一次處理內的極短窗口，
      // 防止 evaluate 之後、真正呼叫 LINE API 之前的瞬間狀態變化——例如顧客
      // 剛好在這幾秒內完成付款、取消同意、封鎖官方帳號）。若不再 eligible，
      // 剛建立、還沒使用的 token 必須安全作廢，不留下「已取消 Recovery 但仍
      // 可被點開」的有效 token。
      const freshJob = db.get('SELECT * FROM cart_recovery_jobs WHERE id=?', [job.id]);
      const finalCheck = module.exports.evaluateLineRecoveryEligibility(db, storeId, freshJob);
      if (!finalCheck.eligible) {
        cancelRecoveryToken(db, storeId, tokenResult.token);
        results.skipped += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: finalCheck.reason_code });
        continue;
      }

      const channelAccessToken = getChannelAccessToken(db, storeId);
      const pushResult = await linePushModule.sendLinePush({
        channelAccessToken,
        lineUserId: job.line_user_id,
        messages: [{ type: 'text', text: messageText }],
      });

      const now = _nowIso();
      if (pushResult.success) {
        db.run(
          `UPDATE cart_recovery_jobs SET status='sent', channel='line', sent_at=?, attempt_count=attempt_count+1, updated_at=? WHERE id=?`,
          [now, now, job.id]
        );
        results.sent += 1;
        results.details.push({ job_id: job.id, sent: true });
      } else {
        // 需求文件二十五：只存安全的 error_code，不存完整 LINE response。
        db.run(
          `UPDATE cart_recovery_jobs SET status='failed', channel='line', attempt_count=attempt_count+1, cancel_reason=?, updated_at=? WHERE id=?`,
          [pushResult.error_code || 'unknown', now, job.id]
        );
        results.failed += 1;
        results.details.push({ job_id: job.id, sent: false, reason_code: pushResult.error_code || 'unknown' });
      }
    } catch (e) {
      console.warn('[cartRecoveryDelivery] processDueLineRecoveryJobs job error:', e.message);
      results.skipped += 1;
    }
  }

  return results;
}

module.exports = {
  REASON_WHITELIST,
  evaluateLineRecoveryEligibility, buildRecoveryMessageText,
  processDueLineRecoveryJobs, isLineRecoveryEnabled, getChannelAccessToken, getFriendStatus,
  resolvePageType, resolveRestorableCartSnapshot, resolveRecoveryTarget, buildRecoveryUrl,
};
