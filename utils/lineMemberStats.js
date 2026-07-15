// utils/lineMemberStats.js — fix18-10-hotfix23-E｜LINE 會員入口 × LINE CRM Foundation
//
// line_members / line_member_history / line_member_sessions / line_member_order_links
// 的共用讀寫工具。所有寫入都經過這裡，避免 routes/line-member.js、
// routes/line-orders.js、routes/line-shipping.js、routes/linepay.js、
// routes/analytics.js 各自寫一套規則導致口徑不一致或重複累加。
//
// 核心防重複原則：
//   - total_spent / order_count / first_purchase_at / repeat_purchase 只在
//     line_member_order_links 成功「新增」一筆 (store_id, order_id) 時才更新
//     （UNIQUE index 保證同一張訂單只能成功 insert 一次）。
//   - friend_added / friend_removed / friend_restored 只在狀態「真的轉換」時
//     才寫 history，不會因重複呼叫 upsertMemberProfile 而重複寫入。

'use strict';

function safeStr(v, maxLen) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s;
}

function writeHistory(db, storeId, lineUserId, eventName, oldValue, newValue, metadata) {
  try {
    if (!storeId || !lineUserId) return false;
    let metaStr = '';
    if (metadata) {
      try { metaStr = JSON.stringify(metadata).slice(0, 2000); } catch { metaStr = ''; }
    }
    db.run(
      `INSERT INTO line_member_history (store_id, line_user_id, event_name, old_value, new_value, metadata_json)
       VALUES (?,?,?,?,?,?)`,
      [storeId, lineUserId, eventName, safeStr(oldValue, 200), safeStr(newValue, 200), metaStr]
    );
    return true;
  } catch (e) {
    console.warn('[lineMemberStats] writeHistory failed:', e.message);
    return false;
  }
}

// 登入 / 好友狀態查詢完成後呼叫：建立或更新會員基本資料，並依狀態轉換規則
// 寫入 friend_added / friend_removed / friend_restored 事件（回傳供呼叫端串接
// analytics_events server-only 事件）。
// isFriendRaw: true / false / null（null = 這次查不到，不覆蓋既有狀態）
function upsertMemberProfile(db, storeId, member) {
  try {
    const lineUserId = safeStr(member.line_user_id, 100);
    if (!storeId || !lineUserId) return false;
    const displayName = safeStr(member.display_name, 200);
    const pictureUrl = safeStr(member.picture_url, 500);
    const isFriendRaw = member.is_friend === true ? 1 : (member.is_friend === false ? 0 : null);
    const isLogin = !!member.is_login; // 是否伴隨一次登入（更新 last_login_at）

    const existing = db.get(
      'SELECT id, is_friend, is_blocked, friend_since, display_name FROM line_members WHERE store_id=? AND line_user_id=?',
      [storeId, lineUserId]
    );

    let friendEvent = null; // friend_added / friend_removed / friend_restored
    const nowClause = "datetime('now','localtime')";

    if (!existing) {
      db.run(
        `INSERT INTO line_members (
           store_id, line_user_id, display_name, picture_url, is_friend, is_blocked,
           friend_since, last_friend_check, last_login_at
         ) VALUES (?,?,?,?,?,0,?,?,?)`,
        [
          storeId, lineUserId, displayName, pictureUrl, isFriendRaw,
          isFriendRaw === 1 ? new Date().toISOString() : '',
          isFriendRaw === null ? '' : new Date().toISOString(),
          isLogin ? new Date().toISOString() : '',
        ]
      );
      if (isFriendRaw === 1) friendEvent = 'friend_added';
      writeHistory(db, storeId, lineUserId, 'login', '', 'new_member', { is_friend: isFriendRaw });
      if (friendEvent) writeHistory(db, storeId, lineUserId, friendEvent, '', 'true', {});
      // fix18-10-hotfix26（需求文件七）：CRM Timeline 額外補一筆規格指定命名的事件
      // （friend_status_checked／joined_official_account／unfollowed_official_account）。
      // 刻意用「額外補寫」而不是「取代」上面 friendEvent 的寫入方式——
      // utils/dashboardAnalytics.js 的好友漏斗查詢直接對 line_member_history 的
      // event_name IN ('friend_added','friend_restored') 做統計，取代掉會讓既有
      // Dashboard 漏斗少算，所以兩種命名並存，不刪除、不改寫舊事件。
      let crmFriendEvent = null;
      if (isFriendRaw !== null) crmFriendEvent = 'friend_status_checked'; // 首次取得好友狀態（不論 true/false）
      if (crmFriendEvent) {
        writeHistory(db, storeId, lineUserId, crmFriendEvent, 'unknown', String(!!isFriendRaw), { friend_flag: isFriendRaw === 1 });
      }
      return { created: true, isFriend: isFriendRaw === 1, friendEvent, crmFriendEvent };
    }

    const prevIsFriend = existing.is_friend; // 1 / 0 / null
    const nextIsFriend = isFriendRaw === null ? prevIsFriend : isFriendRaw;

    // ── 好友狀態轉換規則（需求文件三）───────────────────────────
    let nextIsBlocked = existing.is_blocked;
    let friendSinceSql = null;
    // fix18-10-hotfix26（需求文件七）：CRM Timeline 用的規格命名事件，與下面舊有
    // friendEvent（analytics_events／Dashboard 漏斗用，命名不可變更）分開計算，
    // 兩者並存寫入，互不取代。
    let crmFriendEvent = null;
    if (isFriendRaw !== null && isFriendRaw !== prevIsFriend) {
      if (isFriendRaw === 1) {
        // null/false → true
        friendEvent = (prevIsFriend === null || existing.friend_since === '' || existing.friend_since === null)
          ? 'friend_added'
          : 'friend_restored';
        crmFriendEvent = prevIsFriend === null ? 'friend_status_checked' : 'joined_official_account';
        nextIsBlocked = 0;
        // friend_since：第一次加入才設定；重新加入保留原始值
        if (!existing.friend_since) friendSinceSql = new Date().toISOString();
      } else if (isFriendRaw === 0) {
        if (prevIsFriend === 1) {
          friendEvent = 'friend_removed';
          crmFriendEvent = 'unfollowed_official_account';
          nextIsBlocked = 1;
        } else if (prevIsFriend === null) {
          // 第一次確認就是「非好友」：只記錄「已確認」，不算 unfollow（沒有 follow 過）
          crmFriendEvent = 'friend_status_checked';
        }
      }
    }

    const sets = [
      'display_name=?', 'picture_url=?', 'is_friend=?', 'is_blocked=?',
      'last_seen_at=' + nowClause, 'updated_at=' + nowClause,
    ];
    const vals = [displayName, pictureUrl, nextIsFriend, nextIsBlocked];
    if (isFriendRaw !== null) { sets.push('last_friend_check=?'); vals.push(new Date().toISOString()); }
    if (isLogin) { sets.push('last_login_at=?'); vals.push(new Date().toISOString()); }
    if (friendSinceSql) { sets.push('friend_since=?'); vals.push(friendSinceSql); }

    db.run(`UPDATE line_members SET ${sets.join(', ')} WHERE store_id=? AND line_user_id=?`, [...vals, storeId, lineUserId]);

    if (isLogin) writeHistory(db, storeId, lineUserId, 'login', '', 'login', {});
    if (displayName && displayName !== existing.display_name) {
      writeHistory(db, storeId, lineUserId, 'profile_updated', existing.display_name || '', displayName, {});
    }
    if (friendEvent) {
      writeHistory(db, storeId, lineUserId, friendEvent,
        prevIsFriend === null ? 'unknown' : String(!!prevIsFriend),
        String(!!isFriendRaw), {});
    }
    if (crmFriendEvent) {
      writeHistory(db, storeId, lineUserId, crmFriendEvent,
        prevIsFriend === null ? 'unknown' : String(!!prevIsFriend),
        String(!!isFriendRaw), { friend_flag: isFriendRaw === 1 });
    }

    return { created: false, isFriend: nextIsFriend === 1, friendEvent, crmFriendEvent };
  } catch (e) {
    console.warn('[lineMemberStats] upsertMemberProfile failed:', e.message);
    return false;
  }
}

// 將匿名 Analytics 識別（visitor_id/session_id/cart_id）與登入後的會員串接，
// 供 Customer Journey 使用。UNIQUE(store_id, line_user_id, visitor_id) 避免
// 同一組合重複建立。
function linkMemberSession(db, storeId, lineUserId, ids) {
  try {
    if (!storeId || !lineUserId) return false;
    const visitorId = safeStr(ids && ids.visitor_id, 200);
    const sessionId = safeStr(ids && ids.session_id, 200);
    const cartId = safeStr(ids && ids.cart_id, 200);
    if (!visitorId) return false;
    const existing = db.get(
      'SELECT id FROM line_member_sessions WHERE store_id=? AND line_user_id=? AND visitor_id=?',
      [storeId, lineUserId, visitorId]
    );
    if (existing) {
      db.run(
        `UPDATE line_member_sessions SET session_id=?, cart_id=?,
           last_seen_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
         WHERE id=?`,
        [sessionId || '', cartId || '', existing.id]
      );
    } else {
      db.run(
        `INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id, session_id, cart_id)
         VALUES (?,?,?,?,?)`,
        [storeId, lineUserId, visitorId, sessionId || '', cartId || '']
      );
    }
    return true;
  } catch (e) {
    console.warn('[lineMemberStats] linkMemberSession failed:', e.message);
    return false;
  }
}

// 首次來源／最後來源（需求文件七）。first_touch 永久保留、只在為空時寫入；
// last_touch 每次登入／下單更新，但『direct』不得覆蓋既有有效廣告來源。
function updateTouchAttribution(db, storeId, lineUserId, touch) {
  try {
    if (!storeId || !lineUserId || !touch) return false;
    const source = safeStr(touch.source, 100);
    const campaign = safeStr(touch.campaign, 200);
    if (!source) return false;
    const row = db.get('SELECT first_touch_source, last_touch_source FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!row) return false;
    const sets = [];
    const vals = [];
    if (!row.first_touch_source) {
      sets.push('first_touch_source=?', 'first_touch_campaign=?');
      vals.push(source, campaign);
    }
    const isDirect = source === 'direct' || source === 'unknown';
    if (!(isDirect && row.last_touch_source && row.last_touch_source !== 'direct' && row.last_touch_source !== 'unknown')) {
      sets.push('last_touch_source=?', 'last_touch_campaign=?');
      vals.push(source, campaign);
    }
    if (!sets.length) return false;
    sets.push("updated_at=datetime('now','localtime')");
    db.run(`UPDATE line_members SET ${sets.join(', ')} WHERE store_id=? AND line_user_id=?`, [...vals, storeId, lineUserId]);
    return true;
  } catch (e) {
    console.warn('[lineMemberStats] updateTouchAttribution failed:', e.message);
    return false;
  }
}

// 第一次 add_to_cart 時呼叫（需求文件八）。只寫第一次；商品下架仍保留 product_id。
function recordFirstCart(db, storeId, lineUserId, productId) {
  try {
    if (!storeId || !lineUserId) return false;
    const row = db.get('SELECT first_cart_at FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!row || row.first_cart_at) return false; // 未知會員或已記錄過，略過
    const pid = (productId === undefined || productId === null || productId === '') ? null : Number(productId);
    db.run(
      `UPDATE line_members SET first_product_id=?, first_cart_at=datetime('now','localtime'),
         updated_at=datetime('now','localtime') WHERE store_id=? AND line_user_id=?`,
      [Number.isFinite(pid) ? pid : null, storeId, lineUserId]
    );
    writeHistory(db, storeId, lineUserId, 'first_cart', '', String(pid || ''), {});
    return true;
  } catch (e) {
    console.warn('[lineMemberStats] recordFirstCart failed:', e.message);
    return false;
  }
}

// 訂單成立時呼叫（無論付款方式）：更新 order_count / first_order_at / last_order_at。
// 呼叫端須確保 line_user_id 已存在於 line_members（ensureKnownMember 檢查過），
// 避免前端偽造未經驗證的 line_user_id 也能建立會員列。
function touchMemberOnOrder(db, storeId, lineUserId) {
  try {
    if (!storeId || !lineUserId) return false;
    const row = db.get('SELECT id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!row) return false;
    db.run(
      `UPDATE line_members SET
         first_order_at = CASE WHEN first_order_at IS NULL OR first_order_at='' THEN datetime('now','localtime') ELSE first_order_at END,
         last_order_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime')
       WHERE store_id=? AND line_user_id=?`,
      [storeId, lineUserId]
    );
    return true;
  } catch (e) {
    console.warn('[lineMemberStats] touchMemberOnOrder failed:', e.message);
    return false;
  }
}

// 訂單真正視為成交時呼叫（需求文件九）：累加 order_count/total_spent/lifetime_value，
// 寫 first_purchase 或 repeat_purchase history。以 line_member_order_links 的
// UNIQUE(store_id, order_id) 保證同一張訂單只會成功執行一次；amount 一律由呼叫端
// 傳入「後端已確認的訂單金額」，不得信任前端傳入的 total。
// 回傳 'first_purchase' / 'repeat_purchase' / false（false = 這張訂單已經算過，略過）
function recordMemberPurchase(db, storeId, lineUserId, orderId, amount) {
  try {
    if (!storeId || !lineUserId || !orderId) return false;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return false;

    // UNIQUE index 保證同一 (store_id, order_id) 只能成功 insert 一次
    try {
      db.run(
        `INSERT INTO line_member_order_links (store_id, line_user_id, order_id) VALUES (?,?,?)`,
        [storeId, lineUserId, safeStr(orderId, 100)]
      );
    } catch (dupErr) {
      return false; // 已存在 → 這張訂單已經處理過，直接略過，不重複累加
    }

    const row = db.get('SELECT first_purchase_at, order_count FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    if (!row) return false;
    const isFirst = !row.first_purchase_at;

    db.run(
      `UPDATE line_members SET
         order_count = order_count + 1,
         total_spent = total_spent + ?,
         lifetime_value = lifetime_value + ?,
         first_purchase_at = CASE WHEN first_purchase_at IS NULL OR first_purchase_at='' THEN datetime('now','localtime') ELSE first_purchase_at END,
         last_purchase_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime')
       WHERE store_id=? AND line_user_id=?`,
      [amt, amt, storeId, lineUserId]
    );

    const eventName = isFirst ? 'first_purchase' : 'repeat_purchase';
    writeHistory(db, storeId, lineUserId, eventName, '', String(amt), { order_id: orderId });
    return eventName;
  } catch (e) {
    console.warn('[lineMemberStats] recordMemberPurchase failed:', e.message);
    return false;
  }
}

// 確認 line_user_id 是否為該店家「已知」的會員（曾經完成過 /api/line-member/verify）。
// 訂單路由收到前端帶來的 line_user_id 時，一律先用這個檢查；查不到就當作未登入
// （line_user_id 設為 null），不得信任前端自行指定的任意值（需求文件二十第 6 點）。
function ensureKnownMember(db, storeId, lineUserId) {
  try {
    if (!storeId || !lineUserId) return null;
    const row = db.get('SELECT line_user_id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, String(lineUserId).slice(0, 100)]);
    return row ? row.line_user_id : null;
  } catch (e) {
    console.warn('[lineMemberStats] ensureKnownMember failed:', e.message);
    return null;
  }
}

// 後台列表 / CSV 匯出用：LINE User ID 遮罩顯示（需求文件十五、二十第 9 點）。
// 例如 U1234567890abcdef → U1234****cdef
function maskLineUserId(id) {
  const s = safeStr(id);
  if (s.length <= 8) return s ? s[0] + '****' : '';
  return s.slice(0, 5) + '****' + s.slice(-4);
}

// 會員生命週期階段（需求文件十七）——Dashboard 與會員列表共用同一函式，
// 避免各自寫不同規則。優先順序：blocked > repeat_buyer > first_buyer > cart >
// friend > logged_in > anonymous；inactive_30d/90d 為附加狀態（不影響主階段判斷）。
function computeLifecycleStage(member, nowMs) {
  if (!member) return { stage: 'anonymous', inactive: null };
  const now = nowMs || Date.now();
  let stage = 'logged_in';
  if (member.is_blocked) stage = 'blocked';
  else if (Number(member.order_count) > 1) stage = 'repeat_buyer';
  else if (member.first_purchase_at) stage = 'first_buyer';
  else if (member.first_cart_at) stage = 'cart';
  else if (member.is_friend === 1 || member.is_friend === true) stage = 'friend';
  else if (member.line_user_id) stage = 'logged_in';
  else stage = 'anonymous';

  let inactive = null;
  if (member.last_order_at) {
    const days = (now - new Date(member.last_order_at.replace(' ', 'T')).getTime()) / 86400000;
    if (Number.isFinite(days)) {
      if (days >= 90) inactive = 'inactive_90d';
      else if (days >= 30) inactive = 'inactive_30d';
    }
  }
  return { stage, inactive };
}

module.exports = {
  writeHistory,
  upsertMemberProfile,
  linkMemberSession,
  updateTouchAttribution,
  recordFirstCart,
  touchMemberOnOrder,
  recordMemberPurchase,
  ensureKnownMember,
  maskLineUserId,
  computeLifecycleStage,
};
