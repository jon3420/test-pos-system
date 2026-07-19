// utils/lineFriendSync.js — fix18-10-hotfix26-F8（需求文件八～十八）
//
// 好友狀態的「唯一寫入入口」。Messaging API webhook（follow/unfollow）與既有
// LIFF getFriendship() / LINE Login verify / 手動重新驗證，全部呼叫這裡的
// applyFriendEvent()，確保：
//   1. 沒有會員資料時不忽略事件，建立最小會員紀錄（需求文件十四）
//   2. 較新的事件時間戳優先，不被較舊來源覆蓋（需求文件十五）
//   3. line_friend_events 只新增、不覆蓋（需求文件十一）
//   4. 舊欄位（is_friend／is_blocked／friend_since／last_friend_check／
//      friend_source／friend_status_changed_at）持續同步，向下相容
//   5. 同步寫入 line_member_history，讓既有 Timeline API 不需要另外改查詢
//      就能顯示新事件（需求文件十六）
'use strict';

const EVENT_LABELS = {
  follow: '加入好友',
  unfollow: '封鎖官方帳號',
  refollow: '重新加入好友',
  friendship_verify_true: '驗證為好友',
  friendship_verify_false: '驗證為非好友／已封鎖',
  manual_verify_true: '驗證為好友',
  manual_verify_false: '驗證為非好友／已封鎖',
};

// 事件事實對 friend_status / is_friend 的意義（true=好友, false=非好友, null=不變更狀態）
function _isFriendFor(eventType) {
  switch (eventType) {
    case 'follow':
    case 'refollow':
    case 'friendship_verify_true':
    case 'manual_verify_true':
      return true;
    case 'unfollow':
    case 'friendship_verify_false':
    case 'manual_verify_false':
      return false;
    default:
      return null;
  }
}

function _nowLocal() {
  // fix18-10-hotfix28（根因修正）：這裡原本強制轉成 Asia/Taipei 時間，但專案
  // 其餘所有「無時區資訊的 naive timestamp」（SQL 端 datetime('now','localtime')、
  // 前端 parseUtcDate()）都是假設系統時區＝UTC（這個部署環境的系統時區確實
  // 是 UTC，見 `date` 指令輸出），所以前端會把這欄位的字串「當作 UTC」再轉換
  // 顯示。若這裡塞進 Taipei 時間，會讓「最後確認」「最後加入好友」等時間在
  // CRM 畫面上多轉了一次時區、多偏移 8 小時。改成直接用 UTC 的
  // toISOString()，格式仍是無時區字串（去掉毫秒與 T/Z），與其他既有欄位
  // 完全一致。
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// fix18-10-hotfix28（需求文件三／八）：把「YYYY-MM-DD HH:mm:ss」或 ISO 字串
// 都安全轉成毫秒數再比較，取代原本的純字串比較（兩種格式混用時字串排序
// 不保證正確）。任一方無法解析就視為「這次事件不算舊」（安全預設：只有
// 明確拿到比較新/舊的時間才會忽略事件）。
function _isTimestampNewerOrEqual(incoming, existing) {
  if (!incoming) return true; // 沒有時間戳可比較，不擋（跟原本行為一致）
  const toMs = (s) => {
    if (!s) return NaN;
    const withT = s.includes('T') ? s : s.replace(' ', 'T');
    const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : withT + 'Z';
    return Date.parse(withZ);
  };
  const incomingMs = toMs(incoming);
  const existingMs = toMs(existing);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(existingMs)) return true;
  return incomingMs >= existingMs;
}

/**
 * @param {object} db          既有 getDb() 回傳的 wrapper
 * @param {string} storeId
 * @param {string} lineUserId
 * @param {object} opts
 * @param {string} opts.eventType  follow|unfollow|friendship_verify_true|friendship_verify_false|manual_verify_true|manual_verify_false
 * @param {string} opts.source     webhook_follow|webhook_unfollow|liff_friendship|login_verify|manual_verify
 * @param {string} [opts.eventAt]  ISO 或 'YYYY-MM-DD HH:mm:ss'；缺省用現在時間
 * @param {string} [opts.displayName]
 * @param {string} [opts.pictureUrl]
 * @param {string} [opts.statusMessage]
 * @param {object} [opts.metadata]
 * @returns {{memberId:number, applied:boolean, isRefollow:boolean, wasIgnored:boolean}}
 */
function applyFriendEvent(db, storeId, lineUserId, opts) {
  if (!storeId || !lineUserId) throw new Error('applyFriendEvent: storeId/lineUserId 必填');
  const eventType = opts.eventType;
  const source = opts.source || '';
  const eventAt = opts.eventAt || _nowLocal();
  const targetIsFriend = _isFriendFor(eventType); // true/false/null

  let member = db.get(
    'SELECT id, is_friend, last_friend_check_at, first_follow_at, last_unfollow_at, refollow_count FROM line_members WHERE store_id=? AND line_user_id=?',
    [storeId, lineUserId]
  );

  let isRefollow = false;
  let memberId;

  if (!member) {
    // 需求文件十四：找不到會員時不能忽略事件，建立最小會員紀錄
    db.run(
      `INSERT INTO line_members
        (store_id, line_user_id, display_name, picture_url, is_friend, friend_status,
         first_seen_at, last_seen_at, last_friend_source, member_source, crm_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId, lineUserId, opts.displayName || '', opts.pictureUrl || '',
        targetIsFriend === null ? null : (targetIsFriend ? 1 : 0),
        targetIsFriend === null ? 'unknown' : (targetIsFriend ? 'friend' : 'blocked'),
        eventAt, eventAt, source, 'webhook', 'active',
      ]
    );
    member = db.get('SELECT id, is_friend, last_friend_check_at, first_follow_at, last_unfollow_at, refollow_count FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
  }
  memberId = member.id;

  // 需求文件十五（F8-A）× hotfix28 需求文件三／八：較新的事件優先，不得用
  // 較舊事件覆蓋較新狀態。這裡不能只用字串比較——last_friend_check_at 可能是
  // 這支函式自己寫的「YYYY-MM-DD HH:mm:ss」，也可能是 utils/lineMemberStats.js
  // （LIFF 登入路徑）寫的 ISO 字串（含 'T'/'Z'），字串排序在兩種格式混用時
  // 不保證正確，必須用 Date.parse() 轉毫秒數比較。
  const currentCheckedAt = member.last_friend_check_at || '';
  const isNewerOrEqual = !currentCheckedAt || _isTimestampNewerOrEqual(eventAt, currentCheckedAt);

  // follow → refollow 判斷：先前已有 unfollow 紀錄，代表這次是回鍋
  if (eventType === 'follow' && member.last_unfollow_at) {
    isRefollow = true;
  }
  const effectiveEventType = isRefollow ? 'refollow' : eventType;

  if (isNewerOrEqual && targetIsFriend !== null) {
    const sets = [
      'friend_status=?', 'is_friend=?', 'is_blocked=?',
      'last_friend_check_at=?', 'last_friend_source=?',
      'last_friend_check=?', 'friend_source=?',
      'last_seen_at=?', 'updated_at=?',
    ];
    const params = [
      targetIsFriend ? 'friend' : 'blocked', targetIsFriend ? 1 : 0, targetIsFriend ? 0 : 1,
      eventAt, source,
      eventAt, source,
      eventAt, eventAt,
    ];
    // friend_status_changed_at 只在真的發生 true<->false 轉換時更新（既有欄位語意，需求文件十保持相容）
    if ((member.is_friend === 1 ? true : member.is_friend === 0 ? false : null) !== targetIsFriend) {
      sets.push('friend_status_changed_at=?');
      params.push(eventAt);
    }
    if (effectiveEventType === 'follow' || effectiveEventType === 'refollow') {
      sets.push('last_follow_at=?'); params.push(eventAt);
      if (!member.first_follow_at) { sets.push('first_follow_at=?'); params.push(eventAt); }
      sets.push('friend_since=?'); params.push(eventAt);
      if (isRefollow) {
        sets.push('last_refollow_at=?'); params.push(eventAt);
        sets.push('refollow_count=refollow_count+1');
      }
    } else if (effectiveEventType === 'unfollow') {
      sets.push('last_unfollow_at=?'); params.push(eventAt);
    }
    if (opts.displayName) { sets.push('display_name=?'); params.push(opts.displayName); }
    if (opts.pictureUrl) { sets.push('picture_url=?'); params.push(opts.pictureUrl); }
    params.push(storeId, lineUserId);
    db.run(`UPDATE line_members SET ${sets.join(', ')} WHERE store_id=? AND line_user_id=?`, params);
  } else {
    // 事件比目前狀態舊：狀態不覆蓋，但仍更新 last_seen_at，事件仍要保留（見下方 insert）
    db.run('UPDATE line_members SET last_seen_at=? WHERE store_id=? AND line_user_id=?', [eventAt, storeId, lineUserId]);
  }

  // 需求文件十一：append-only，事件永遠寫入，不因狀態被較新事件覆蓋而省略
  db.run(
    `INSERT INTO line_friend_events (store_id, line_user_id, member_id, event_type, source, event_at, metadata_json)
     VALUES (?,?,?,?,?,?,?)`,
    [storeId, lineUserId, memberId, effectiveEventType, source, eventAt, JSON.stringify(opts.metadata || {})]
  );

  // 需求文件十六：沿用既有 line_member_history 供 Timeline 顯示，不用另開一支 API
  try {
    db.run(
      `INSERT INTO line_member_history (store_id, line_user_id, event_name, old_value, new_value, metadata_json)
       VALUES (?,?,?,?,?,?)`,
      [storeId, lineUserId, `friend_${effectiveEventType}`, '', EVENT_LABELS[effectiveEventType] || effectiveEventType, JSON.stringify({ source, event_at: eventAt })]
    );
  } catch (e) { console.warn('[lineFriendSync] history insert failed:', e.message); }

  return { memberId, applied: isNewerOrEqual, isRefollow, wasIgnored: !isNewerOrEqual };
}

module.exports = { applyFriendEvent, EVENT_LABELS, _isFriendFor };
