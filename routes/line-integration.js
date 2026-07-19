// routes/line-integration.js — fix18-10-hotfix27（需求文件二～十四）
//
// LINE Integration Center 後台。這支路由不改變任何既有 LINE Login／LIFF／
// Webhook／CRM／Analytics 的運作邏輯（需求文件一），只是把散落在多個
// settings key 的設定值，彙整成一份「商家看得懂」的畫面：目前設定了什麼、
// 缺什麼、能不能一鍵測試、Health 是紅是綠。
//
// 安全原則（需求文件十四，與既有機制一致）：
// - line_channel_secret／line_channel_token 一律不在任何 GET 回應中出現明文，
//   只回傳布林值（是否已設定）與遮罩後的前幾碼。
// - 測試動作全部由後端代打 LINE API，前端不會拿到完整 Secret/Token。
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireStaffJwt } = require('../middleware/storeGuard');
const { fetchLineApi } = require('../utils/lineApiFetch');

function getSetting(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}
function mask(value, keep = 4) {
  if (!value) return '';
  const s = String(value);
  return s.length <= keep ? '*'.repeat(s.length) : s.slice(0, keep) + '***';
}
function baseUrl(req) {
  // 需求文件七：Webhook URL 用「目前請求的 host」組出來，商家不需要自己猜網域，
  // 換網域/自訂網域時這裡也會自動跟著對；不寫死任何網域。
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// 讀出這個店家目前 LINE 整合相關的所有設定（含衍生值），供整合中心畫面／
// Setup Wizard／Health 共用同一份資料，不必分好幾支 API 各查一次。
function loadIntegrationConfig(db, storeId, req) {
  const s = (k, d = '') => getSetting(db, storeId, k, d);
  const officialBasicId = s('line_official_basic_id') || s('line_member_basic_id');
  const addFriendUrl = s('line_add_friend_url') || s('line_member_add_friend_url');
  const liffId = s('line_member_liff_id');
  const loginChannelId = s('line_member_login_channel_id');
  const messagingChannelId = s('line_messaging_channel_id');
  const channelSecret = s('line_channel_secret');
  const channelToken = s('line_channel_token');
  const checkoutEnabled = s('line_checkout_handoff_enabled') === '1';

  return {
    official_account: {
      name: s('line_official_name'),
      basic_id: officialBasicId,
      add_friend_url: addFriendUrl,
      home_url: s('line_official_home_url'),
      configured: !!officialBasicId,
    },
    login: {
      channel_id: loginChannelId,
      configured: !!loginChannelId,
    },
    liff: {
      liff_id: liffId,
      liff_url: liffId ? `https://liff.line.me/${liffId}` : '',
      // 需求文件三／十：不得再用 /checkout 當 path suffix（LIFF Endpoint URL
      // 是固定指向 line-order.html 的，結帳資訊一律用 query string 帶）。
      // 這裡顯示的是「範例」（demo cart_token），實際 Bot 回覆會用真正的
      // full token，不是這串範例文字。
      checkout_callback_url_example: liffId
        ? `https://liff.line.me/${liffId}?mode=checkout&store_id=${encodeURIComponent(storeId)}&cart_token=FULL_TOKEN`
        : '',
      liff_endpoint_url_required: `${baseUrl(req)}/line-order.html`,
      configured: !!liffId,
    },
    messaging_api: {
      channel_id: messagingChannelId,
      channel_secret_set: !!channelSecret,
      channel_secret_masked: mask(channelSecret),
      channel_token_set: !!channelToken,
      channel_token_masked: mask(channelToken),
      configured: !!(channelSecret && channelToken),
    },
    webhook: {
      url: `${baseUrl(req)}/webhook/line/${encodeURIComponent(storeId)}`,
      configured: !!channelSecret,
    },
    checkout_handoff: {
      enabled: checkoutEnabled,
      // 需求文件八：Basic ID 已設定才顯示「到 LINE 完成結帳」Dialog，否則
      // 顯示「加入官方 LINE」＋結帳代碼 fallback（見 line-member-gate.js）。
      dialog_variant: officialBasicId ? 'checkout' : 'add_friend_fallback',
      configured: checkoutEnabled && !!officialBasicId && !!liffId,
    },
  };
}

// 需求文件三：Setup Wizard 步驟狀態——完全由設定完整度／診斷結果計算，不需要
// 商家自己判斷「這樣算完成了嗎」。狀態分三態：done（✅ 已完成）／
// warn（⚠️ 需要檢查，設定存在但不確定是否正確）／pending（⏳ 尚未完成）。
function computeWizardSteps(config) {
  return [
    { step: 1, title: '建立 Official Account', status: config.official_account.configured ? 'done' : 'pending' },
    { step: 2, title: '建立 Messaging API（Channel ID）', status: config.messaging_api.channel_id ? 'done' : 'pending' },
    { step: 3, title: '建立 LIFF', status: config.liff.configured ? 'done' : 'pending' },
    { step: 4, title: '填入 Channel Secret', status: config.messaging_api.channel_secret_set ? 'done' : 'pending' },
    // Step 5（Verify Webhook）系統只能確認「簽章邏輯正確、URL 已產生」，
    // 無法代替 LINE 平台完成真正的 Verify，因此設定完整時顯示 warn（需人工
    // 到 LINE Developers 按下 Verify），而不是直接宣稱 done。
    { step: 5, title: 'Verify Webhook（LINE Developers 後台操作）', status: config.webhook.configured ? 'warn' : 'pending' },
    // Step 6 由前端依 /health 結果動態覆蓋（見 loadLineIntegrationHealth()）。
    { step: 6, title: '完成測試（下方健康檢查全綠）', status: 'pending' },
  ];
}

router.get('/config', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const config = loadIntegrationConfig(db, req.storeId, req);
    res.json({ success: true, data: { config, wizard: computeWizardSteps(config) } });
  } catch (e) {
    console.error('[line-integration] GET /config error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── 需求文件十一：LINE Integration Health ───────────────────────────────
router.get('/health', requireStaffJwt, async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const config = loadIntegrationConfig(db, storeId, req);
    const channelToken = getSetting(db, storeId, 'line_channel_token', '');
    const channelSecret = getSetting(db, storeId, 'line_channel_secret', '');

    const items = [];

    // Official Account
    items.push(config.official_account.configured
      ? { key: 'official_account', level: 'green', label: 'Official Account', reason: '已設定 Basic ID' }
      : { key: 'official_account', level: 'red', label: 'Official Account', reason: '尚未設定 Official Account Basic ID' });

    // LINE Login
    items.push(config.login.configured
      ? { key: 'line_login', level: 'green', label: 'LINE Login', reason: '已設定 Channel ID' }
      : { key: 'line_login', level: 'red', label: 'LINE Login', reason: '尚未設定 LINE Login Channel ID' });

    // LIFF
    items.push(config.liff.configured
      ? { key: 'liff', level: 'green', label: 'LIFF', reason: '已設定 LIFF ID' }
      : { key: 'liff', level: 'red', label: 'LIFF', reason: '尚未設定 LIFF ID' });

    // Webhook（無法從後端直接確認 LINE 後台是否已貼上這個網址，只能確認
    // Channel Secret 是否已設定、以及我們自己的簽章驗證邏輯是否正確運作）
    if (!channelSecret) {
      items.push({ key: 'webhook', level: 'red', label: 'Webhook', reason: 'Channel Secret 尚未設定，webhook 會直接拒絕所有事件' });
    } else {
      try {
        const { verifySignature } = require('./line-webhook');
        const testBody = Buffer.from(JSON.stringify({ events: [] }));
        const sig = crypto.createHmac('SHA256', channelSecret).update(testBody).digest('base64');
        const ok = verifySignature(channelSecret, testBody, sig);
        items.push(ok
          ? { key: 'webhook', level: 'green', label: 'Webhook', reason: '簽章驗證邏輯正常；請至 LINE Developers 確認 Webhook URL 已貼上且「使用 Webhook」已開啟' }
          : { key: 'webhook', level: 'red', label: 'Webhook', reason: '簽章自我測試失敗' });
      } catch (e) {
        items.push({ key: 'webhook', level: 'red', label: 'Webhook', reason: 'Channel Secret 格式異常：' + e.message });
      }
    }

    // Reply API / Push API / Friend API（三者共用同一個 Channel Access Token，
    // 用 GET /v2/bot/info 一次驗證是否可用，並取回官方帳號 basicId 做交叉比對）
    if (!channelToken) {
      items.push({ key: 'reply_api', level: 'red', label: 'Reply API', reason: 'Channel Access Token 尚未設定' });
      items.push({ key: 'push_api', level: 'red', label: 'Push API', reason: 'Channel Access Token 尚未設定' });
      items.push({ key: 'friend_api', level: 'red', label: 'Friend API', reason: 'Channel Access Token 尚未設定' });
    } else {
      try {
        const resp = await fetchLineApi('https://api.line.me/v2/bot/info', {
          headers: { Authorization: `Bearer ${channelToken}` },
        });
        if (resp.ok) {
          const info = await resp.json();
          items.push({ key: 'reply_api', level: 'green', label: 'Reply API', reason: 'Channel Access Token 有效（實際發送仍需要真實 replyToken/userId，見下方測試按鈕說明）' });
          items.push({ key: 'push_api', level: 'green', label: 'Push API', reason: 'Channel Access Token 有效（實際推播需選擇已綁定 LINE 的會員，本系統不自動推播）' });
          items.push({ key: 'friend_api', level: 'green', label: 'Friend API', reason: 'Channel Access Token 有效（好友關係仍需個別使用者於 LIFF 內授權才能查詢）' });
          if (config.official_account.basic_id && info.basicId && info.basicId !== config.official_account.basic_id) {
            items.push({ key: 'basic_id_mismatch', level: 'yellow', label: 'Basic ID 一致性', reason: `設定的 Basic ID（${config.official_account.basic_id}）與 Token 實際對應的官方帳號（${info.basicId}）不一致，請確認填錯` });
          }
        } else if (resp.status === 401) {
          items.push({ key: 'reply_api', level: 'red', label: 'Reply API', reason: 'Reply API 驗證失敗：401（Channel Access Token 無效或已過期）' });
          items.push({ key: 'push_api', level: 'red', label: 'Push API', reason: 'Push API 驗證失敗：401（Channel Access Token 無效或已過期）' });
          items.push({ key: 'friend_api', level: 'red', label: 'Friend API', reason: 'Friend API 驗證失敗：401（Channel Access Token 無效或已過期）' });
        } else {
          items.push({ key: 'reply_api', level: 'yellow', label: 'Reply API', reason: `LINE 伺服器回應非預期狀態碼 ${resp.status}，請稍後再測試一次` });
          items.push({ key: 'push_api', level: 'yellow', label: 'Push API', reason: `LINE 伺服器回應非預期狀態碼 ${resp.status}，請稍後再測試一次` });
          items.push({ key: 'friend_api', level: 'yellow', label: 'Friend API', reason: `LINE 伺服器回應非預期狀態碼 ${resp.status}，請稍後再測試一次` });
        }
      } catch (e) {
        items.push({ key: 'reply_api', level: 'yellow', label: 'Reply API', reason: '無法連線至 LINE 伺服器：' + e.message });
        items.push({ key: 'push_api', level: 'yellow', label: 'Push API', reason: '無法連線至 LINE 伺服器：' + e.message });
        items.push({ key: 'friend_api', level: 'yellow', label: 'Friend API', reason: '無法連線至 LINE 伺服器：' + e.message });
      }
    }

    // Checkout Handoff
    if (!config.checkout_handoff.enabled) {
      items.push({ key: 'checkout_handoff', level: 'yellow', label: 'Checkout Handoff', reason: '尚未啟用 LINE 一鍵結帳' });
    } else if (!config.official_account.configured || !config.liff.configured) {
      items.push({ key: 'checkout_handoff', level: 'red', label: 'Checkout Handoff', reason: '已啟用，但 Official Account 或 LIFF 尚未設定完整' });
    } else {
      items.push({ key: 'checkout_handoff', level: 'green', label: 'Checkout Handoff', reason: '設定完整' });
    }

    const overall = items.some(i => i.level === 'red') ? 'red' : (items.some(i => i.level === 'yellow') ? 'yellow' : 'green');
    res.json({ success: true, data: { overall, items } });
  } catch (e) {
    console.error('[line-integration] GET /health error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── 需求文件十二：個別測試按鈕 ───────────────────────────────────────────

// 測試 Webhook 簽章邏輯（自我測試，不需要真的收到 LINE 的請求）——
// 直接重用 routes/line-webhook.js 生產環境用的同一份 verifySignature()，
// 而不是自己再寫一次比對邏輯，避免兩邊邏輯不同步造成「測試綠燈、正式紅燈」。
router.post('/test/webhook', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const channelSecret = getSetting(db, req.storeId, 'line_channel_secret', '');
    if (!channelSecret) return res.json({ success: true, data: { ok: false, reason: 'Channel Secret 尚未設定' } });
    const { verifySignature } = require('./line-webhook');
    const testBody = Buffer.from(JSON.stringify({ events: [] }));
    const sig = crypto.createHmac('SHA256', channelSecret).update(testBody).digest('base64');
    const verifyOk = verifySignature(channelSecret, testBody, sig);
    res.json({ success: true, data: { ok: verifyOk, webhook_url: `${baseUrl(req)}/webhook/line/${encodeURIComponent(req.storeId)}` } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 測試 Messaging API（Reply/Push/Friend 共用 Token）是否可用
router.post('/test/messaging-api', requireStaffJwt, async (req, res) => {
  try {
    const db = getDb();
    const channelToken = getSetting(db, req.storeId, 'line_channel_token', '');
    if (!channelToken) return res.json({ success: true, data: { ok: false, reason: 'Channel Access Token 尚未設定' } });
    const resp = await fetchLineApi('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${channelToken}` } });
    if (!resp.ok) return res.json({ success: true, data: { ok: false, reason: `LINE 回應 ${resp.status}` } });
    const info = await resp.json();
    res.json({ success: true, data: { ok: true, basic_id: info.basicId, display_name: info.displayName } });
  } catch (e) {
    res.json({ success: true, data: { ok: false, reason: e.message } });
  }
});

// 測試 LIFF 設定（沿用既有 hotfix26-D「LINE 連線測試」做完整版；這裡只做
// 格式與 Channel 一致性的後端側檢查，實際 liff.init() 仍需瀏覽器環境）
router.post('/test/liff', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const liffId = getSetting(db, req.storeId, 'line_member_liff_id', '');
    if (!liffId) return res.json({ success: true, data: { ok: false, reason: '尚未設定 LIFF ID' } });
    const formatOk = /^\d{7,}-[a-zA-Z0-9]{8,}$/.test(liffId);
    res.json({ success: true, data: { ok: formatOk, reason: formatOk ? '格式正確；完整登入測試請使用下方「LINE 連線測試」' : 'LIFF ID 格式異常，請確認複製完整' } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 建立測試 Cart Token（診斷用，不綁真實商品，建立後立即標記 cancelled，不會留下有效 token）
router.post('/test/checkout-handoff', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { createCartHandoffToken } = require('../utils/lineCheckoutHandoff');
    const product = db.get('SELECT id FROM products WHERE store_id=? AND enabled=1 LIMIT 1', [storeId]);
    if (!product) return res.json({ success: true, data: { ok: false, reason: '此店家尚無已上架商品，無法建立測試購物車' } });
    const result = createCartHandoffToken(db, storeId, {
      cartQtyItems: [{ product_id: product.id, qty: 1 }],
      checkoutContext: { order_type: 'takeout' },
    });
    // 診斷用途，測完立即作廢，避免產生一筆「不會被使用」的正式 token 殘留在列表中
    db.run("UPDATE line_cart_handoff_tokens SET status='cancelled' WHERE store_id=? AND cart_code=?", [storeId, result.cartCode]);
    res.json({ success: true, data: { ok: true, cart_code: result.cartCode, reason: '建立/寫入/查詢流程正常（測試 token 已自動作廢）' } });
  } catch (e) {
    res.json({ success: true, data: { ok: false, reason: e.message } });
  }
});

// ── fix18-10-hotfix28（需求文件十九）：好友同步診斷 ─────────────────────
router.get('/friend-sync-diagnostics', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const channelSecret = getSetting(db, storeId, 'line_channel_secret', '');
    const liffId = getSetting(db, storeId, 'line_member_liff_id', '');
    const requireFriend = getSetting(db, storeId, 'line_member_require_friend') === '1';

    const lastFollow = db.get(
      "SELECT event_at FROM line_friend_events WHERE store_id=? AND event_type IN ('follow','refollow') ORDER BY event_at DESC LIMIT 1",
      [storeId]
    );
    const lastUnfollow = db.get(
      "SELECT event_at FROM line_friend_events WHERE store_id=? AND event_type='unfollow' ORDER BY event_at DESC LIMIT 1",
      [storeId]
    );
    const counts = db.get(
      `SELECT
         SUM(CASE WHEN is_friend=1 THEN 1 ELSE 0 END) AS friend_count,
         SUM(CASE WHEN is_friend=0 THEN 1 ELSE 0 END) AS not_friend_count,
         SUM(CASE WHEN is_friend IS NULL THEN 1 ELSE 0 END) AS unknown_count
       FROM line_members WHERE store_id=? AND COALESCE(crm_status,'active')='active'`,
      [storeId]
    ) || {};
    const lastSyncFailure = db.get(
      `SELECT created_at, metadata_json FROM analytics_events
       WHERE store_id=? AND event_name='line_login_failed' ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    // 需求文件一／四：最近一次 LIFF friendship 檢查時間／來源——取這個店家
    // line_members 裡 last_friend_check_at 最新的那一筆（不分好友/非好友），
    // 只要有紀錄就代表「同步曾經跑過」，用來判斷同步是否還在正常運作。
    const lastSyncRow = db.get(
      `SELECT last_friend_check_at, last_friend_source FROM line_members
       WHERE store_id=? AND last_friend_check_at IS NOT NULL AND last_friend_check_at != ''
       ORDER BY last_friend_check_at DESC LIMIT 1`,
      [storeId]
    );
    const lastLiffCheckRow = db.get(
      `SELECT last_friend_check_at FROM line_members
       WHERE store_id=? AND last_friend_source='liff_friendship' AND last_friend_check_at IS NOT NULL AND last_friend_check_at != ''
       ORDER BY last_friend_check_at DESC LIMIT 1`,
      [storeId]
    );

    res.json({
      success: true,
      data: {
        webhook_enabled: !!channelSecret,
        last_follow_event_at: lastFollow ? lastFollow.event_at : '',
        last_unfollow_event_at: lastUnfollow ? lastUnfollow.event_at : '',
        // 只能確認 LIFF 已設定；liff.getFriendship() 是瀏覽器端 SDK API，
        // 後端無法代替使用者實際呼叫一次，不假裝「已測試通過」。
        liff_get_friendship_available: !!liffId,
        official_account_linked: !!liffId,
        require_line_friend: requireFriend,
        last_liff_check_at: lastLiffCheckRow ? lastLiffCheckRow.last_friend_check_at : '',
        last_sync_source: lastSyncRow ? lastSyncRow.last_friend_source : '',
        last_sync_error_at: lastSyncFailure ? lastSyncFailure.created_at : '',
        // 錯誤訊息遮罩：只回傳 reason 分類字，不還原任何 token 內容
        // （metadata_json 本來就不含完整 token，沿用 routes/line-member.js
        // 的 verify-debug 慣例）。
        last_sync_error_reason: (() => {
          if (!lastSyncFailure) return '';
          try { return JSON.parse(lastSyncFailure.metadata_json || '{}').reason || ''; } catch (e) { return ''; }
        })(),
        friend_count: Number(counts.friend_count) || 0,
        not_friend_count: Number(counts.not_friend_count) || 0,
        unknown_count: Number(counts.unknown_count) || 0,
      },
    });
  } catch (e) {
    console.error('[line-integration] GET /friend-sync-diagnostics error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── fix18-10-hotfix29-B（需求文件十六）：Messenger Handoff 診斷 ──────────
// 讀取來源：
//   - line_checkout_handoff_diagnostics（前端各階段回報，見
//     routes/line-checkout-handoff.js 的 /diagnostics 端點，已過白名單）
//   - line_checkout_handoff_created（後端 /create 成功時寫入）
// 不顯示完整 Cart Token／完整 Cart Code，只回傳統計數字與最近一筆的遮罩資訊。
router.get('/handoff-diagnostics', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;

    const lastDiag = db.get(
      `SELECT created_at, metadata_json FROM analytics_events
       WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics'
       ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    let lastMeta = {};
    try { lastMeta = lastDiag ? JSON.parse(lastDiag.metadata_json || '{}') : {}; } catch (e) { lastMeta = {}; }

    const lastSuccess = db.get(
      `SELECT created_at FROM analytics_events
       WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics'
         AND metadata_json LIKE '%"error_code":null%' AND metadata_json LIKE '%"stage":"ui_applied"%'
       ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    const lastFailure = db.get(
      `SELECT created_at, metadata_json FROM analytics_events
       WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics'
         AND metadata_json LIKE '%"stage":"fallback_entered"%'
       ORDER BY created_at DESC LIMIT 1`,
      [storeId]
    );
    let lastFailureMeta = {};
    try { lastFailureMeta = lastFailure ? JSON.parse(lastFailure.metadata_json || '{}') : {}; } catch (e) {}

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const rows24h = db.all(
      `SELECT metadata_json FROM analytics_events
       WHERE store_id=? AND event_name='line_checkout_handoff_diagnostics' AND created_at >= ?`,
      [storeId, sinceIso]
    ) || [];

    let attempts24h = 0, success24h = 0, timeout24h = 0, missingCode24h = 0;
    for (const row of rows24h) {
      let m;
      try { m = JSON.parse(row.metadata_json || '{}'); } catch (e) { continue; }
      if (m.stage === 'request_started') attempts24h += 1;
      if (m.stage === 'ui_applied' && !m.error_code) success24h += 1;
      if (m.error_code === 'HANDOFF_TIMEOUT') timeout24h += 1;
      if (m.error_code === 'HANDOFF_MISSING_CART_CODE') missingCode24h += 1;
    }
    const successRate24h = attempts24h > 0 ? Math.round((success24h / attempts24h) * 1000) / 10 : null;

    res.json({
      success: true,
      data: {
        last_success_at: lastSuccess ? lastSuccess.created_at : '',
        last_failure_at: lastFailure ? lastFailure.created_at : '',
        last_error_code: lastFailureMeta.error_code || '',
        last_device: lastMeta.device || '',
        last_browser: lastMeta.browser || '',
        last_http_status: (lastMeta.http_status === undefined || lastMeta.http_status === null) ? null : lastMeta.http_status,
        last_has_cart_code: !!lastMeta.has_cart_code,
        last_has_line_oa_message_url: !!lastMeta.has_line_oa_message_url,
        success_rate_24h: successRate24h,
        timeout_count_24h: timeout24h,
        missing_code_count_24h: missingCode24h,
        attempts_24h: attempts24h,
      },
    });
  } catch (e) {
    console.error('[line-integration] GET /handoff-diagnostics error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
