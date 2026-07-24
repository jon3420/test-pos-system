// routes/crm.js — fix18-10-hotfix31-R1/R2「CRM Action Center」
//
// R2 硬化重點（架構修正回合，見對話中的需求文件 A~N）：
//   - Segment：dynamic 分群不再自動快照成員（只在 segment_type='static' 時
//     才寫入 crm_segment_members），列表/詳情一律即時查詢 utils/drilldown.js。
//     刪除分群改為「封存」（enabled=0），不真的刪除歷史分群列。
//   - Action：新增 idempotency_key（同一個 key 重複呼叫不會建立第二筆動作）、
//     cancel／retry 端點、統一透過 utils/crmActions.js 的執行器處理生命週期，
//     不在路由檔案裡各寫一次執行邏輯。
//   - coupon_grant：validate 失敗（優惠券不存在/停用/過期/店家不符）一律
//     在建立動作「之前」就擋下（400，不建立 action row），沿用既有 coupons
//     表驗證規則，不重新發明一套。
//   - csv_export：本機真的產生 CSV 內容回傳，不是假裝匯出成功。
//   - 所有查詢一律以 req.storeId（已由 requireStore 驗證）隔離，segment/action
//     的 :id 一律用 store_id+id 一起查詢，不同店家的 ID 互相查不到。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { getDrilldownRows, resolveMemberKeys, countDrilldownMatches } = require('../utils/drilldown');
const {
  ACTION_TYPES, executeAction, cancelAction, validateCouponForAction, nowStr, safeJsonParse,
} = require('../utils/crmActions');

const SEGMENT_TYPES = new Set(['dynamic', 'static']);

// ────────────────────────────────────────────────────────────────
// POST /api/crm/segments — 建立分群
// body: { name, description, segment_type: 'dynamic'|'static', filter: {...} }
// ────────────────────────────────────────────────────────────────
router.post('/segments', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ success: false, message: '缺少分群名稱' });
    const segmentType = SEGMENT_TYPES.has(body.segment_type) ? body.segment_type : 'dynamic';
    const description = String(body.description || '').slice(0, 500);
    const filter = (body.filter && typeof body.filter === 'object') ? body.filter : {};
    const filterJson = JSON.stringify(filter);
    const now = nowStr();

    const insertResult = db.run(
      `INSERT INTO crm_segments (store_id, name, description, segment_type, filter_json, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?)`,
      [storeId, name, description, segmentType, filterJson, now, now]
    );
    const segmentId = insertResult.lastInsertRowid;

    let memberCount;
    if (segmentType === 'static') {
      // fix18-10-hotfix31-R3：前端「選取特定對象」建立靜態分群時，會直接送出
      // 明確選取的 member_keys 清單（不是重新依 filter 解析）——這樣快照的
      // 才是「使用者實際勾選的人」，不是「目前符合篩選條件的所有人」，兩者
      // 語意不同（需求文件 M：「Static segment snapshots the explicitly
      // selected audience」）。沒有帶 member_keys 時（例如舊版呼叫端、或
      // 「依目前篩選整批建立靜態快照」的情境）才退回用 filter 解析，行為與
      // R1/R2 完全相同，向下相容。
      const explicitKeys = Array.isArray(body.member_keys) ? body.member_keys : null;
      const members = explicitKeys
        ? (() => {
            const seen = new Map();
            explicitKeys
              .filter((m) => m && typeof m.member_key === 'string' && (m.member_type === 'line_user_id' || m.member_type === 'visitor_id'))
              .slice(0, 2000)
              .forEach((m) => {
                const key = m.member_key.slice(0, 200);
                // fix31-r3：同一個 member_key 重複出現時只保留第一筆，member_count
                // 才會等於「資料庫實際會有幾筆成員」，不是「輸入陣列長度」。
                if (!seen.has(key)) seen.set(key, { member_key: key, member_type: m.member_type, display_name: (m.display_name || '').slice(0, 100) });
              });
            return [...seen.values()];
          })()
        : resolveMemberKeys(db, storeId, filter, { limit: 2000 });
      members.forEach((m) => {
        try {
          db.run(
            `INSERT OR IGNORE INTO crm_segment_members
               (store_id, segment_id, member_key, member_type, display_name, snapshot_json, added_at)
             VALUES (?,?,?,?,?,?,?)`,
            [storeId, segmentId, m.member_key, m.member_type, m.display_name || '', JSON.stringify(m), now]
          );
        } catch (e) { /* 個別成員寫入失敗不影響整批分群建立 */ }
      });
      memberCount = members.length;
      db.run('UPDATE crm_segments SET member_count_cache=?, cache_updated_at=? WHERE store_id=? AND id=?', [memberCount, now, storeId, segmentId]);
    } else {
      // 需求文件 B/C：dynamic 分群人數是「預覽」，即時計算，不快取成靜態數字
      // （member_count_cache 這裡仍然寫一份，純粹當作「上次建立時的參考值」，
      // 讀取端一律優先呼叫 countDrilldownMatches 取得當下即時人數）。
      memberCount = countDrilldownMatches(db, storeId, filter);
      db.run('UPDATE crm_segments SET member_count_cache=?, cache_updated_at=? WHERE store_id=? AND id=?', [memberCount, now, storeId, segmentId]);
    }

    res.json({ success: true, id: segmentId, segment_type: segmentType, member_count: memberCount });
  } catch (e) {
    console.error('[crm] POST /segments error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/crm/segments — 列出分群（預設不含已封存；?include_archived=true 可看全部）
router.get('/segments', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const includeArchived = req.query.include_archived === 'true';
    const where = includeArchived ? 'store_id=?' : 'store_id=? AND COALESCE(enabled,1)=1';
    const rows = db.all(
      `SELECT id, name, description, segment_type, member_count_cache, cache_updated_at, enabled, created_at, updated_at
       FROM crm_segments WHERE ${where} ORDER BY created_at DESC`,
      [storeId]
    );
    // 需求文件 B/C：dynamic 分群的人數一律即時重新計算，不能只回傳可能過期的快取值
    const segments = rows.map((s) => {
      if (s.segment_type !== 'dynamic') return s;
      try {
        const filter = safeJsonParse(db.get('SELECT filter_json FROM crm_segments WHERE store_id=? AND id=?', [storeId, s.id]).filter_json, {});
        return { ...s, member_count_cache: countDrilldownMatches(db, storeId, filter) };
      } catch (e) { return s; }
    });
    res.json({ success: true, segments });
  } catch (e) {
    console.error('[crm] GET /segments error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/crm/segments/:id — 分群詳情 + 成員清單
router.get('/segments/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '無效的分群 ID' });

    const segment = db.get('SELECT * FROM crm_segments WHERE store_id=? AND id=?', [storeId, id]);
    if (!segment) return res.status(404).json({ success: false, message: '找不到這個分群' });

    let members;
    if (segment.segment_type === 'static') {
      members = db.all(
        'SELECT member_key, member_type, display_name, added_at FROM crm_segment_members WHERE store_id=? AND segment_id=? ORDER BY added_at DESC LIMIT 500',
        [storeId, id]
      );
    } else {
      // 需求文件 B：dynamic 分群「預覽時即時解析」，資料變動後下次查詢立刻反映
      const filter = safeJsonParse(segment.filter_json, {});
      members = resolveMemberKeys(db, storeId, filter, { limit: 500 });
    }

    res.json({
      success: true,
      segment: {
        id: segment.id,
        name: segment.name,
        description: segment.description,
        segment_type: segment.segment_type,
        filter: safeJsonParse(segment.filter_json, {}),
        enabled: !!segment.enabled,
        member_count_cache: segment.member_count_cache,
        created_at: segment.created_at,
        updated_at: segment.updated_at,
      },
      members,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[crm] GET /segments/:id error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/crm/segments/:id — 封存（軟刪除）。歷史分群/動作紀錄不得被
// 悄悄清掉（需求文件 G.5），static 分群的快照名單也保留，只是分群本身標記
// enabled=0，預設列表不再顯示。
router.delete('/segments/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '無效的分群 ID' });
    const segment = db.get('SELECT id FROM crm_segments WHERE store_id=? AND id=?', [storeId, id]);
    if (!segment) return res.status(404).json({ success: false, message: '找不到這個分群' });
    db.run('UPDATE crm_segments SET enabled=0, updated_at=? WHERE store_id=? AND id=?', [nowStr(), storeId, id]);
    res.json({ success: true, archived: true });
  } catch (e) {
    console.error('[crm] DELETE /segments/:id error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /api/crm/actions — 建立並執行一個 CRM 動作
// body: { segment_id, action_type, name, payload: {...}, idempotency_key? }
// ────────────────────────────────────────────────────────────────
router.post('/actions', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};
    const segmentId = parseInt(body.segment_id, 10);
    const actionType = body.action_type;
    const idempotencyKey = body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : '';

    if (!Number.isFinite(segmentId)) return res.status(400).json({ success: false, message: '缺少 segment_id' });
    if (!ACTION_TYPES.has(actionType)) return res.status(400).json({ success: false, message: `不支援的 action_type：${actionType}` });

    // 需求文件 G.1：Idempotency——同一個 key 重複呼叫，回傳既有動作，不建立第二筆。
    if (idempotencyKey) {
      const existing = db.get('SELECT * FROM crm_actions WHERE store_id=? AND idempotency_key=?', [storeId, idempotencyKey]);
      if (existing) {
        return res.json({
          success: true,
          id: existing.id,
          status: existing.status,
          target_count: existing.target_count,
          success_count: existing.success_count,
          fail_count: existing.fail_count,
          idempotent_replay: true,
        });
      }
    }

    const segment = db.get('SELECT * FROM crm_segments WHERE store_id=? AND id=?', [storeId, segmentId]);
    if (!segment) return res.status(404).json({ success: false, message: '找不到這個分群' });
    if (!segment.enabled) return res.status(400).json({ success: false, message: '此分群已封存，無法用於建立新動作' });

    const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

    // 需求文件 H：coupon_grant 的驗證必須在「建立動作之前」就擋下無效優惠券，
    // 不得先建立一筆之後才發現失敗。
    if (actionType === 'coupon_grant') {
      const check = validateCouponForAction(db, storeId, payload.coupon_code);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
    }

    let members;
    if (segment.segment_type === 'static') {
      members = db.all(
        'SELECT member_key, member_type, display_name FROM crm_segment_members WHERE store_id=? AND segment_id=?',
        [storeId, segmentId]
      );
    } else {
      const filter = safeJsonParse(segment.filter_json, {});
      members = resolveMemberKeys(db, storeId, filter, { limit: 2000 });
    }

    const now = nowStr();
    const name = String(body.name || '').slice(0, 100);

    const actionInsert = db.run(
      `INSERT INTO crm_actions
         (store_id, action_type, name, segment_id, payload_json, status, target_count, success_count, fail_count, skipped_count, idempotency_key, result_message, created_at, started_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, actionType, name, segmentId, JSON.stringify(payload), 'pending',
        members.length, 0, 0, 0, idempotencyKey, '', now, '', '']
    );
    const actionId = actionInsert.lastInsertRowid;

    members.forEach((m) => {
      try {
        db.run(
          `INSERT OR IGNORE INTO crm_action_targets (store_id, action_id, member_key, member_type, status)
           VALUES (?,?,?,?,'pending')`,
          [storeId, actionId, m.member_key, m.member_type]
        );
      } catch (e) { /* 個別 target 寫入失敗不影響整體動作紀錄 */ }
    });

    // csv_export：真的產生 CSV 內容（不是假裝匯出），與狀態機執行分開處理。
    let csvContent;
    if (actionType === 'csv_export') {
      const header = 'member_key,member_type,display_name\n';
      const lines = members.map((m) => [m.member_key, m.member_type, (m.display_name || '').replace(/,/g, ' ')].join(','));
      csvContent = header + lines.join('\n');
    }

    const execResult = executeAction(db, storeId, actionId);
    const finalAction = db.get('SELECT * FROM crm_actions WHERE store_id=? AND id=?', [storeId, actionId]);

    const responseBody = {
      success: true,
      id: actionId,
      status: finalAction.status,
      target_count: finalAction.target_count,
      success_count: finalAction.success_count,
      fail_count: finalAction.fail_count,
      skipped_count: finalAction.skipped_count,
      message: finalAction.status === 'not_configured'
        ? (actionType === 'line_push' ? 'LINE Messaging API 尚未串接，本次僅記錄名單，尚未實際發送。'
          : actionType === 'email' ? 'Email 發送尚未串接，本次僅記錄名單。'
          : actionType === 'sms' ? '簡訊發送尚未串接，本次僅記錄名單。'
          : actionType === 'webhook' ? 'Webhook 尚未設定，本次僅記錄名單。'
          : actionType === 'meta_audience_export' ? 'Meta CAPI 尚未串接，本次僅記錄名單。'
          : actionType === 'google_audience_export' ? 'GA4 Audience 匯出尚未串接，本次僅記錄名單。'
          : '此動作類型尚未串接對應管道，本次僅記錄名單。')
        : (execResult && execResult.message) || '',
    };
    if (csvContent !== undefined) responseBody.csv = csvContent;

    res.json(responseBody);
  } catch (e) {
    console.error('[crm] POST /actions error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/crm/actions/:id/cancel — 取消：尚未處理的 target 標成 cancelled，
// 已完成的部分維持不變。
router.post('/actions/:id/cancel', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '無效的動作 ID' });
    const result = cancelAction(db, storeId, id);
    if (!result) return res.status(404).json({ success: false, message: '找不到這筆動作紀錄' });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[crm] POST /actions/:id/cancel error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/crm/actions/:id/retry — 重試：只重跑 pending/failed 的 target，
// 已完成/已跳過/已取消的 target 完全不動。
router.post('/actions/:id/retry', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '無效的動作 ID' });
    const action = db.get('SELECT id FROM crm_actions WHERE store_id=? AND id=?', [storeId, id]);
    if (!action) return res.status(404).json({ success: false, message: '找不到這筆動作紀錄' });
    const result = executeAction(db, storeId, id);
    const finalAction = db.get('SELECT * FROM crm_actions WHERE store_id=? AND id=?', [storeId, id]);
    res.json({
      success: true,
      id,
      status: finalAction.status,
      success_count: finalAction.success_count,
      fail_count: finalAction.fail_count,
      skipped_count: finalAction.skipped_count,
    });
  } catch (e) {
    console.error('[crm] POST /actions/:id/retry error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/crm/actions — 動作紀錄列表（歷史紀錄不會被刪除，見需求文件 G.5）
router.get('/actions', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all(
      `SELECT id, action_type, name, segment_id, status, target_count, success_count, fail_count, skipped_count,
              idempotency_key, error_code, result_message, created_at, started_at, completed_at, cancelled_at
       FROM crm_actions WHERE store_id=? ORDER BY created_at DESC LIMIT 200`,
      [storeId]
    );
    res.json({ success: true, actions: rows });
  } catch (e) {
    console.error('[crm] GET /actions error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/crm/actions/:id — 動作詳情 + 每位成員狀態
router.get('/actions/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: '無效的動作 ID' });
    const action = db.get('SELECT * FROM crm_actions WHERE store_id=? AND id=?', [storeId, id]);
    if (!action) return res.status(404).json({ success: false, message: '找不到這筆動作紀錄' });
    const targets = db.all(
      'SELECT member_key, member_type, status, error, error_code, sent_at, updated_at FROM crm_action_targets WHERE store_id=? AND action_id=? LIMIT 2000',
      [storeId, id]
    );
    res.json({
      success: true,
      action: { ...action, payload: safeJsonParse(action.payload_json, {}) },
      targets,
    });
  } catch (e) {
    console.error('[crm] GET /actions/:id error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
