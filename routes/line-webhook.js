// routes/line-webhook.js — fix18-10-hotfix26-F8（需求文件八～十五）
//
// LINE Messaging API webhook：目前先處理 follow / unfollow，讓封鎖／重新加入
// 好友能即時反映在 CRM，不必等下次 LIFF getFriendship() 或手動重新驗證。
//
// 路由設計（需求文件十三：多店 tenant mapping，禁止只依單一全域設定）：
//   POST /webhook/line/:storeId
// 每個店家在 LINE Developers Console 設定「自己專屬」的 webhook URL（含
// store_id），這是官方建議的多租戶隔離方式之一（等同「webhook route store
// token」）。收到事件後一律用這個 URL 上的 store_id 查詢「該店家自己的」
// Channel Secret 做簽章驗證與後續 DB 操作（WHERE store_id=?），不會有
// 跨店混用的可能——即使 A 店的 Channel Secret 外洩，也只能對 A 店的
// webhook URL 產生合法簽章。
//
// 不做的事（需求文件十二）：不關閉簽章驗證、不接受未簽名事件、不在 log
// 印出完整 Channel Secret（只印前 4 碼供除錯比對用）。
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');
const { applyFriendEvent } = require('../utils/lineFriendSync');
const { bindTokenToLineUser } = require('../utils/lineCheckoutHandoff');
const { fetchLineApi } = require('../utils/lineApiFetch');

// 需求文件八（F8-A）× 十（hotfix27）× 需求文件七（hotfix27 收尾）：辨識
// 「我要結帳 CART-XXXXXX」或單獨「CART-XXXXXX」，允許前後空白，但不得接受
// 夾在長句中間、只是「包含 CART 字樣」的任意文字（^...$ + trim 已經 anchor
// 頭尾，不會誤判）。
const CHECKOUT_MESSAGE_RE = /^\s*(?:我要結帳\s+)?(CART-[A-Z0-9]{6,32})\s*$/i;

// 與 routes/line-orders.js 相同慣例（utils/db.js 目前未匯出共用的 getSetting）
function getSetting(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

function _maskSecret(s) {
  if (!s) return '(empty)';
  return s.slice(0, 4) + '***';
}

function verifySignature(channelSecret, rawBody, signatureHeader) {
  if (!channelSecret || !rawBody || !signatureHeader) return false;
  const expected = crypto.createHmac('SHA256', channelSecret).update(rawBody).digest('base64');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

async function fetchLineProfile(channelToken, userId) {
  if (!channelToken || !userId) return null;
  try {
    const resp = await fetchLineApi(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${channelToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { displayName: data.displayName || '', pictureUrl: data.pictureUrl || '', statusMessage: data.statusMessage || '' };
  } catch (e) {
    console.warn('[line-webhook] fetchLineProfile failed:', e.message);
    return null; // 需求文件十四：API 失敗仍要保存 UID 與事件，只是補不到顯示資料
  }
}

// 需求文件十：用 Reply API 回覆文字訊息（最低版本，先不做 Flex Message）。
async function replyMessage(channelToken, replyToken, text) {
  if (!channelToken || !replyToken) return false;
  try {
    const resp = await fetchLineApi('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${channelToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    if (!resp.ok) console.warn('[line-webhook] replyMessage non-200:', resp.status);
    return resp.ok;
  } catch (e) {
    console.warn('[line-webhook] replyMessage failed:', e.message);
    return false;
  }
}

router.post('/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  // 先回 200，避免 LINE 因逾時重送造成事件重複處理；驗證失敗才回非 200。
  try {
    const db = getDb();
    const channelSecret = getSetting(db, storeId, 'line_channel_secret', '');
    const channelToken = getSetting(db, storeId, 'line_channel_token', '');

    if (!channelSecret) {
      console.warn(`[line-webhook] store=${storeId} 尚未設定 line_channel_secret，拒絕事件`);
      return res.status(403).json({ success: false, message: 'channel secret not configured' });
    }

    const signature = req.get('x-line-signature');
    const rawBody = req.rawBody;
    const validSig = verifySignature(channelSecret, rawBody, signature);
    if (!validSig) {
      console.warn(`[line-webhook] store=${storeId} 簽章驗證失敗 secret=${_maskSecret(channelSecret)}`);
      return res.status(403).json({ success: false, message: 'invalid signature' });
    }

    const events = Array.isArray(req.body && req.body.events) ? req.body.events : [];
    // 立即回應 LINE（避免重送），事件在背景逐一處理
    res.status(200).json({ success: true });

    for (const evt of events) {
      try {
        const userId = evt.source && evt.source.userId;
        if (!userId) continue;
        const eventAtIso = evt.timestamp ? new Date(evt.timestamp).toISOString().slice(0, 19).replace('T', ' ') : undefined;

        if (evt.type === 'follow') {
          const profile = await fetchLineProfile(channelToken, userId);
          applyFriendEvent(db, storeId, userId, {
            eventType: 'follow',
            source: 'webhook_follow',
            eventAt: eventAtIso,
            displayName: profile && profile.displayName,
            pictureUrl: profile && profile.pictureUrl,
            metadata: { webhookEventType: 'follow', replyToken: evt.replyToken || '' },
          });
        } else if (evt.type === 'unfollow') {
          // unfollow 事件 LINE 不會給 profile（使用者已封鎖），只用既有資料
          applyFriendEvent(db, storeId, userId, {
            eventType: 'unfollow',
            source: 'webhook_unfollow',
            eventAt: eventAtIso,
            metadata: { webhookEventType: 'unfollow' },
          });
        } else if (evt.type === 'message' && evt.message && evt.message.type === 'text') {
          // 需求文件八～十：只處理「我要結帳 CART-XXXXXX」，其餘文字訊息忽略
          // （不回覆、不當成錯誤——避免對客人正常聊天訊息做出奇怪反應）。
          const text = String(evt.message.text || '').trim();
          const match = text.match(CHECKOUT_MESSAGE_RE);
          if (!match) continue;
          const cartCode = match[1].toUpperCase();

          const bindResult = bindTokenToLineUser(db, storeId, cartCode, userId);
          const replyToken = evt.replyToken;

          if (!bindResult.ok) {
            const failMessages = {
              not_found: '找不到這個結帳代碼，請回到購物車重新點選「到 LINE 完成結帳」。',
              expired: '此結帳連結已過期，請回到購物車重新結帳。',
              consumed: '此結帳連結已完成或已失效。',
              cancelled: '此結帳連結已取消，請回到購物車重新結帳。',
              already_bound_other_user: '此結帳代碼已被使用，請回到購物車重新產生新的結帳連結。',
            };
            await replyMessage(channelToken, replyToken, failMessages[bindResult.reason] || '無法處理此結帳代碼，請回到購物車重新結帳。');
            continue;
          }

          // 需求文件十：CRM 會員建立/更新（沿用 F8-A 的最小會員建立邏輯，但這不是
          // follow/unfollow 事實，不動 friend_status——只確保 line_members 有這筆資料）。
          const existingMember = db.get('SELECT id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, userId]);
          if (!existingMember) {
            const profile = await fetchLineProfile(channelToken, userId);
            db.run(
              `INSERT INTO line_members (store_id, line_user_id, display_name, picture_url, first_seen_at, last_seen_at, member_source, crm_status)
               VALUES (?,?,?,?,datetime('now','localtime'),datetime('now','localtime'),?,?)`,
              [storeId, userId, (profile && profile.displayName) || '', (profile && profile.pictureUrl) || '', 'checkout_handoff', 'active']
            );
          }

          const liffId = getSetting(db, storeId, 'line_member_liff_id', '');
          if (!liffId) {
            console.warn(`[line-webhook] store=${storeId} 尚未設定 line_member_liff_id，無法回覆結帳連結`);
            await replyMessage(channelToken, replyToken, '購物車已保留，但商家尚未完成結帳頁設定，請聯絡店家。');
            continue;
          }
          const liffUrl = `https://liff.line.me/${liffId}/checkout?cart_token=${encodeURIComponent(bindResult.token)}`;
          await replyMessage(channelToken, replyToken, `您的購物車已保留。\n\n請點下方連結繼續完成結帳：\n${liffUrl}`);

          try {
            const { logServerEvent } = require('../utils/analyticsLog');
            logServerEvent(db, {
              store_id: storeId, visitor_id: `webhook_${userId}`, session_id: `webhook_${cartCode}`,
              event_name: 'line_checkout_message_sent', line_user_id: userId, metadata: {},
            });
          } catch (e) {}
        }
        // 其餘事件類型（postback／sticker／image…）目前不處理，交由未來擴充
      } catch (evtErr) {
        console.error('[line-webhook] event processing error:', evtErr.message);
      }
    }
  } catch (e) {
    console.error('[line-webhook] fatal error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
module.exports.verifySignature = verifySignature; // fix18-10-hotfix27：供 LINE Integration Center 自我測試重用同一份簽章邏輯
