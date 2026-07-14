// routes/line-member.js — fix18-10-hotfix23-E｜LINE 會員入口 × LIFF 登入 ×
// 好友狀態綁定 × LINE CRM Foundation
//
// POST /api/line-member/verify   — 前台 LIFF 登入後呼叫，後端驗證 ID Token、
//                                   查詢好友狀態、upsert line_members、寫入
//                                   CRM history、寫入對應的 analytics 事件。
// GET  /api/line-member/members         — 後台會員列表（篩選／排序／分頁）
// GET  /api/line-member/members/export  — CSV 匯出（遮罩 LINE User ID）
// GET  /api/line-member/members/:id     — 會員詳細頁（含 CRM Timeline）
//
// 安全原則（需求文件十八／二十）：
//   - Access Token／ID Token／Channel Secret 絕不寫 log、絕不回傳前端。
//   - line_user_id 一律由後端驗證後才視為可信，不接受前端指定。
//   - verify endpoint 有簡易 rate limit。
//   - 所有查詢以 store_id 隔離；LINE User ID 對外一律遮罩顯示。

'use strict';
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { verifyLineIdToken, getFriendshipStatus } = require('../utils/lineMemberAuth');
const { createMemberSession } = require('../utils/lineMemberSession');
const {
  upsertMemberProfile, linkMemberSession, updateTouchAttribution,
  maskLineUserId, computeLifecycleStage,
} = require('../utils/lineMemberStats');
const { logServerEvent } = require('../utils/analyticsLog');

// ── 簡易 in-memory rate limit（同一 store + IP）── 每 60 秒最多 20 次驗證請求
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateBucket = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBucket.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateBucket.delete(key);
  }
}, 5 * 60 * 1000).unref?.();
function checkRateLimit(storeId, ip) {
  const key = `${storeId}|${ip}`;
  const now = Date.now();
  let entry = rateBucket.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateBucket.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

function getSetting(db, storeId, key) {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : '';
}

// ══════════════════════════════════════════════════════════════════
// POST /api/line-member/verify
// ══════════════════════════════════════════════════════════════════
router.post('/verify', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

    if (!checkRateLimit(storeId, ip)) {
      // 不得因驗證頻率限制中斷點餐（需求文件六第 9 點／十八）：回傳結構化錯誤，
      // 前端 fallback 為「請稍後再試」，不擋既有瀏覽/加購行為。
      return res.status(429).json({ success: false, reason: 'rate_limited', message: '請求過於頻繁，請稍後再試' });
    }

    const { id_token, access_token } = req.body || {};
    if (!id_token || typeof id_token !== 'string') {
      return res.status(400).json({ success: false, reason: 'missing_id_token', message: '缺少 id_token' });
    }

    const channelId = getSetting(db, storeId, 'line_member_login_channel_id');
    if (!channelId) {
      return res.status(400).json({ success: false, reason: 'not_configured', message: '此店家尚未設定 LINE Login Channel' });
    }

    // ── 驗證 ID Token（不信任前端傳入的 line_user_id）───────────
    const verifyResult = await verifyLineIdToken(id_token, channelId);
    // 供 analytics 事件關聯用；相容兩種輸入格式：{analytics:{...}} 或頂層
    // visitor_id/session_id/cart_id/attribution（見需求文件四）。
    const bodyAp = (req.body && req.body.analytics && typeof req.body.analytics === 'object') ? req.body.analytics : {};
    const bodyAttr = (req.body && req.body.attribution && typeof req.body.attribution === 'object') ? req.body.attribution : {};
    const ap = {
      visitor_id: req.body.visitor_id || bodyAp.visitor_id,
      session_id: req.body.session_id || bodyAp.session_id,
      cart_id: req.body.cart_id || bodyAp.cart_id,
      gate_stage: bodyAp.gate_stage,
      source: bodyAp.source || bodyAttr.source,
      medium: bodyAp.medium || bodyAttr.medium,
      campaign: bodyAp.campaign || bodyAttr.campaign,
      first_touch: bodyAp.first_touch || bodyAttr.first_touch,
      order_mode: bodyAp.order_mode,
    };
    const evtBase = {
      store_id: storeId,
      visitor_id: ap.visitor_id || `unknown_verify_${Date.now()}`,
      session_id: ap.session_id || `unknown_verify_${Date.now()}`,
      cart_id: ap.cart_id || null,
      order_mode: ap.order_mode || null,
      source: ap.source || null, medium: ap.medium || null, campaign: ap.campaign || null,
      metadata: null,
    };

    if (!verifyResult.ok) {
      logServerEvent(db, { ...evtBase, event_name: 'line_login_failed',
        metadata: { reason: verifyResult.reason, gate_stage: ap.gate_stage || null } });
      // 不得因 LINE API 錯誤回 500 破壞點餐（需求文件六）
      return res.status(200).json({ success: false, reason: verifyResult.reason, message: verifyResult.message });
    }

    const lineUserId = verifyResult.line_user_id;

    // ── 好友狀態（安全 fallback：查不到就是 null，不阻擋流程）─────
    let friendResult = { ok: false, is_friend: null };
    if (access_token) {
      friendResult = await getFriendshipStatus(access_token);
    }
    logServerEvent(db, { ...evtBase, event_name: 'friend_status_checked',
      metadata: { is_friend: friendResult.is_friend, gate_stage: ap.gate_stage || null } });

    // ── upsert 會員資料 + 好友狀態轉換規則 ───────────────────────
    const upsertResult = upsertMemberProfile(db, storeId, {
      line_user_id: lineUserId,
      display_name: verifyResult.display_name,
      picture_url: verifyResult.picture_url,
      is_friend: friendResult.is_friend,
      is_login: true,
    });

    // ── 串接匿名 Analytics 識別（Customer Journey）──────────────
    linkMemberSession(db, storeId, lineUserId, {
      visitor_id: ap.visitor_id, session_id: ap.session_id, cart_id: ap.cart_id,
    });
    // ── 首次來源／最後來源 ───────────────────────────────────────
    if (ap.first_touch || ap.source) {
      updateTouchAttribution(db, storeId, lineUserId, {
        source: (ap.first_touch && ap.first_touch.source) || ap.source,
        campaign: (ap.first_touch && ap.first_touch.campaign) || ap.campaign,
      });
    }

    logServerEvent(db, { ...evtBase, event_name: 'line_login_success',
      metadata: { is_friend: friendResult.is_friend, gate_stage: ap.gate_stage || null } });
    logServerEvent(db, { ...evtBase, event_name: 'member_login', metadata: { gate_stage: ap.gate_stage || null } });

    if (upsertResult && upsertResult.friendEvent) {
      logServerEvent(db, { ...evtBase, event_name: upsertResult.friendEvent, metadata: {} });
    }

    const freshRow = db.get('SELECT is_blocked FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]) || {};

    res.json({
      success: true,
      // fix18-10-hotfix23-E：前端下單流程改帶這個簽章過的短效 session，不再直接
      // 使用/保存原始 line_user_id（見 utils/lineMemberSession.js）。
      member_session: createMemberSession({ store_id: storeId, line_user_id: lineUserId }),
      member: {
        line_user_id_masked: maskLineUserId(lineUserId),
        display_name: verifyResult.display_name,
        picture_url: verifyResult.picture_url,
        is_friend: friendResult.is_friend,
        is_blocked: !!freshRow.is_blocked,
      },
    });
  } catch (e) {
    console.error('[line-member] POST /verify error:', e.message);
    // 不得讓例外破壞點餐流程，回傳結構化失敗，前端安全 fallback
    res.status(200).json({ success: false, reason: 'exception', message: '驗證發生錯誤，請稍後再試' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members — 後台會員列表
// ══════════════════════════════════════════════════════════════════
router.get('/members', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { filter, sort, q, limit = 50, offset = 0 } = req.query;

    const where = ['store_id=?'];
    const params = [storeId];
    if (q && String(q).trim()) {
      where.push('display_name LIKE ?');
      params.push('%' + String(q).trim().slice(0, 100) + '%');
    }
    switch (filter) {
      case 'friend': where.push('is_friend=1'); break;
      case 'not_friend': where.push('(is_friend=0 OR is_friend IS NULL)'); break;
      case 'blocked': where.push('is_blocked=1'); break;
      case 'unblocked': where.push("is_blocked=0 AND friend_since!=''"); break;
      case 'logged_in_no_purchase': where.push("first_purchase_at=''"); break;
      case 'first_buyer': where.push("first_purchase_at!='' AND order_count<=1"); break;
      case 'repeat_buyer': where.push('order_count>1'); break;
      case 'inactive_30d': where.push("last_order_at!='' AND julianday('now','localtime')-julianday(last_order_at) >= 30"); break;
      case 'inactive_90d': where.push("last_order_at!='' AND julianday('now','localtime')-julianday(last_order_at) >= 90"); break;
      case 'high_ltv': where.push('lifetime_value >= (SELECT COALESCE(AVG(lifetime_value),0) FROM line_members WHERE store_id=?)'); params.push(storeId); break;
      default: break;
    }

    let orderBy = 'last_seen_at DESC';
    switch (sort) {
      case 'last_order': orderBy = 'last_order_at DESC'; break;
      case 'total_spent': orderBy = 'total_spent DESC'; break;
      case 'order_count': orderBy = 'order_count DESC'; break;
      case 'ltv': orderBy = 'lifetime_value DESC'; break;
      case 'last_login': default: orderBy = 'last_seen_at DESC'; break;
    }

    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    const rows = db.all(
      `SELECT * FROM line_members WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );
    const totalRow = db.get(`SELECT COUNT(*) c FROM line_members WHERE ${where.join(' AND ')}`, params) || {};

    const data = rows.map(r => {
      const lifecycle = computeLifecycleStage(r);
      return {
        line_user_id_masked: maskLineUserId(r.line_user_id),
        line_user_id_ref: r.id, // 內部參照用（詳情頁用 id，不外洩真實 LINE User ID）
        display_name: r.display_name,
        picture_url: r.picture_url,
        is_friend: r.is_friend,
        is_blocked: r.is_blocked,
        friend_since: r.friend_since,
        last_login_at: r.last_login_at,
        last_friend_check: r.last_friend_check,
        first_touch_source: r.first_touch_source,
        last_touch_source: r.last_touch_source,
        first_order_at: r.first_order_at,
        last_order_at: r.last_order_at,
        order_count: r.order_count,
        total_spent: r.total_spent,
        lifetime_value: r.lifetime_value,
        lifecycle_stage: lifecycle.stage,
        inactive: lifecycle.inactive,
      };
    });

    res.json({ success: true, data, total: Number(totalRow.c || 0), limit: lim, offset: off });
  } catch (e) {
    console.error('[line-member] GET /members error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members/export — CSV 匯出（遮罩 LINE User ID，不含 Token）
// ══════════════════════════════════════════════════════════════════
router.get('/members/export', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all('SELECT * FROM line_members WHERE store_id=? ORDER BY last_seen_at DESC', [storeId]);
    const header = ['顯示名稱','LINE User ID(遮罩)','是否好友','是否封鎖','加入好友日期','最後登入','首次來源','最後來源','首次購買','最後購買','訂單數','累積消費','LTV'];
    const csvRows = [header.join(',')];
    rows.forEach(r => {
      const cells = [
        r.display_name || '', maskLineUserId(r.line_user_id),
        r.is_friend === 1 ? '是' : (r.is_friend === 0 ? '否' : '未知'),
        r.is_blocked ? '是' : '否',
        r.friend_since || '', r.last_login_at || '',
        r.first_touch_source || '', r.last_touch_source || '',
        r.first_order_at || '', r.last_order_at || '',
        r.order_count || 0, r.total_spent || 0, r.lifetime_value || 0,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`);
      csvRows.push(cells.join(','));
    });
    const csv = '\uFEFF' + csvRows.join('\n'); // BOM 讓 Excel 正確辨識 UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="line_members_${storeId}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[line-member] GET /members/export error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/line-member/members/:id — 會員詳細頁（:id 為 line_members.id，不是 LINE User ID）
// ══════════════════════════════════════════════════════════════════
router.get('/members/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const row = db.get('SELECT * FROM line_members WHERE store_id=? AND id=?', [storeId, req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: '找不到會員' });

    const history = db.all(
      `SELECT event_name, old_value, new_value, metadata_json, created_at
       FROM line_member_history WHERE store_id=? AND line_user_id=? ORDER BY created_at DESC LIMIT 100`,
      [storeId, row.line_user_id]
    );
    const lifecycle = computeLifecycleStage(row);
    const avgOrderValue = row.order_count > 0 ? round(row.total_spent / row.order_count) : 0;

    res.json({
      success: true,
      data: {
        line_user_id_masked: maskLineUserId(row.line_user_id),
        display_name: row.display_name, picture_url: row.picture_url,
        is_friend: row.is_friend, is_blocked: row.is_blocked,
        friend_since: row.friend_since, last_login_at: row.last_login_at,
        last_friend_check: row.last_friend_check,
        first_touch_source: row.first_touch_source, first_touch_campaign: row.first_touch_campaign,
        last_touch_source: row.last_touch_source, last_touch_campaign: row.last_touch_campaign,
        first_product_id: row.first_product_id, first_cart_at: row.first_cart_at,
        first_purchase_at: row.first_purchase_at, last_purchase_at: row.last_purchase_at,
        order_count: row.order_count, total_spent: row.total_spent, lifetime_value: row.lifetime_value,
        avg_order_value: avgOrderValue,
        lifecycle_stage: lifecycle.stage, inactive: lifecycle.inactive,
        timeline: history,
      },
    });
  } catch (e) {
    console.error('[line-member] GET /members/:id error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});
function round(n) { return Math.round(Number(n || 0) * 100) / 100; }

module.exports = router;
