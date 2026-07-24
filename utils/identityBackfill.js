// utils/identityBackfill.js — fix18-10-hotfix31-R4「Safe Identity Backfill」
//
// 目的（需求文件 F/I）：對「歷史」資料補齊 匿名訪客 ↔ LINE 會員 的決定性連結
// （line_member_sessions），只用在寫入當下沒有機會建立連結的舊資料——例如
// 這位會員之前登入時，連結邏輯還沒補齊某個 cart_id／session_id，導致同一次
// 結帳流程裡「登入前的匿名事件」跟「登入後的會員事件」沒有被 line_member_sessions
// 記錄起來，Visitor 360 因此看不到完整旅程。
//
// 絕對原則：
//   - 只使用「決定性」證據——同一個 cart_id 或 session_id 同時出現在：
//       (a) 某位 LINE 會員登入後的事件（identity_key = 'line_user:UID'）
//       (b) 一筆「匿名」事件（identity_key 不是該會員，或為 null／session_id／cart_id 型）
//     才視為可連結；絕不使用 IP、姓名相似、同商品、同時段等弱假設。
//   - 若同一個 cart_id/session_id 同時被兩個不同 line_user_id 的登入事件使用
//     （理論上不該發生，但保守處理），視為「不明確」，直接跳過（unresolved），
//     不得任意選一個連結。
//   - 不新增第二套身份系統：寫入目的地就是既有的 line_member_sessions 表
//     （utils/analyticsIdentity.js resolveCanonicalVisitor() 讀的就是這張表）。
//   - 不改寫、不刪除任何既有 analytics_events 資料列。
//   - 預設 dry-run（不寫入），需要明確 apply=true 才會真的 INSERT。
//   - Idempotent：對同一批資料重複執行，第二次 apply 不會產生新的連結
//     （INSERT OR IGNORE + 既有 UNIQUE(store_id, line_user_id, visitor_id) 索引）。
//   - 嚴格 store 隔離：一律以呼叫端指定的單一 store_id 為範圍，不跨店比對。
//   - 不在伺服器啟動流程中自動執行（見 server.js 未呼叫本模組）。

'use strict';

function _nowStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 掃描單一店家，找出可用「決定性證據」補齊的匿名訪客 ↔ LINE 會員連結。
 * @param {object} db
 * @param {string} storeId 必要，單一店家範圍，不跨店查詢
 * @param {object} opts { apply: boolean（預設 false=dry-run） }
 * @returns {{ store_id, apply, scanned, linked, already_linked, unresolved, skipped, errors, details, generated_at }}
 */
function backfillIdentityLinksForStore(db, storeId, opts = {}) {
  const apply = opts.apply === true;
  const summary = {
    store_id: storeId, apply,
    scanned: 0, linked: 0, already_linked: 0, unresolved: 0, skipped: 0, errors: 0,
    details: [], generated_at: new Date().toISOString(),
  };
  if (!db || !storeId) {
    summary.errors += 1;
    summary.details.push({ error: '缺少 db 或 store_id，安全中止（不執行任何寫入）' });
    return summary;
  }

  let lineMembers;
  try {
    lineMembers = db.all('SELECT line_user_id FROM line_members WHERE store_id=?', [storeId]);
  } catch (e) {
    summary.errors += 1;
    summary.details.push({ error: `查詢 line_members 失敗：${e.message}` });
    return summary;
  }
  if (!lineMembers.length) return summary; // 這家店沒有任何 LINE 會員，沒有可補的連結

  // 既有已知連結（避免重複計數 already_linked／避免對已連結的 visitor_id 重工）
  let existingLinks;
  try {
    existingLinks = db.all(
      "SELECT line_user_id, visitor_id FROM line_member_sessions WHERE store_id=? AND visitor_id != ''",
      [storeId]
    );
  } catch (e) {
    summary.errors += 1;
    summary.details.push({ error: `查詢 line_member_sessions 失敗：${e.message}` });
    return summary;
  }
  const existingSet = new Set(existingLinks.map((r) => `${r.line_user_id}::${r.visitor_id}`));

  const now = _nowStr();

  for (const { line_user_id: uid } of lineMembers) {
    if (!uid) continue;

    // (a) 這位會員登入後、確實歸屬於他的事件（identity_key 已在寫入當下就是
    // 'line_user:UID'，這是決定性的——見 utils/analyticsIdentity.js resolveIdentity()）
    let postLoginRows;
    try {
      postLoginRows = db.all(
        `SELECT DISTINCT cart_id, session_id FROM analytics_events
         WHERE store_id=? AND identity_key=? AND (cart_id IS NOT NULL AND cart_id != '' OR session_id IS NOT NULL AND session_id != '')`,
        [storeId, `line_user:${uid}`]
      );
    } catch (e) {
      summary.errors += 1;
      summary.details.push({ line_user_id: uid, error: `查詢登入後事件失敗：${e.message}` });
      continue;
    }
    if (!postLoginRows.length) continue;

    const cartIds = [...new Set(postLoginRows.map((r) => r.cart_id).filter(Boolean))];
    const sessionIds = [...new Set(postLoginRows.map((r) => r.session_id).filter(Boolean))];

    // (b) 同一個 cart_id／session_id 底下，是否存在「匿名」事件（identity_key
    // 不是這個會員自己——包含 null、session_id 型、cart_id 型，或甚至是其他人，
    // 後者在下面用「不明確就跳過」的規則擋下，不會誤連）
    const candidateVisitorIds = new Set();
    const ambiguous = new Set();

    function scanBy(column, ids) {
      if (!ids.length) return;
      const placeholders = ids.map(() => '?').join(',');
      let rows;
      try {
        rows = db.all(
          `SELECT DISTINCT visitor_id, identity_key FROM analytics_events
           WHERE store_id=? AND ${column} IN (${placeholders})
             AND visitor_id IS NOT NULL AND visitor_id != ''`,
          [storeId, ...ids]
        );
      } catch (e) {
        summary.errors += 1;
        summary.details.push({ line_user_id: uid, error: `查詢 ${column} 候選事件失敗：${e.message}` });
        return;
      }
      rows.forEach((r) => {
        if (r.identity_key === `line_user:${uid}`) return; // 這就是會員自己的事件，不是「匿名」證據
        if (r.identity_key && r.identity_key.startsWith('line_user:')) {
          // 同一個 cart_id/session_id 底下出現「另一個」LINE 會員的事件——證據不明確
          // （理論上不該發生，保守起見直接標記為不明確，不猜測要連給誰）。
          ambiguous.add(r.visitor_id);
          return;
        }
        candidateVisitorIds.add(r.visitor_id);
      });
    }
    scanBy('cart_id', cartIds);
    scanBy('session_id', sessionIds);

    ambiguous.forEach((vid) => candidateVisitorIds.delete(vid));

    candidateVisitorIds.forEach((visitorId) => {
      summary.scanned += 1;
      const dedupKey = `${uid}::${visitorId}`;
      if (existingSet.has(dedupKey)) {
        summary.already_linked += 1;
        return;
      }
      if (apply) {
        try {
          db.run(
            `INSERT OR IGNORE INTO line_member_sessions
               (store_id, line_user_id, visitor_id, session_id, cart_id, first_seen_at, last_seen_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [storeId, uid, visitorId, '', '', now, now, now, now]
          );
          existingSet.add(dedupKey); // 同一次執行內防止對同一組合重複計數
          summary.linked += 1;
        } catch (e) {
          summary.errors += 1;
          summary.details.push({ line_user_id: uid, visitor_id: visitorId, error: e.message });
        }
      } else {
        // dry-run：只回報「會被連結」，不寫入
        summary.linked += 1;
      }
    });

    ambiguous.forEach(() => { summary.unresolved += 1; });
  }

  return summary;
}

/**
 * 多店掃描（呼叫端可傳入 storeIds 陣列；每個店家仍各自獨立呼叫
 * backfillIdentityLinksForStore()，一律不跨店比對，不共用候選集合）。
 */
function backfillIdentityLinks(db, storeIds, opts = {}) {
  const ids = Array.isArray(storeIds) ? storeIds : [storeIds];
  return ids.map((storeId) => backfillIdentityLinksForStore(db, storeId, opts));
}

module.exports = {
  backfillIdentityLinksForStore,
  backfillIdentityLinks,
};
