// routes/ga4-geo.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// GA4 城市歷史統計、即時快照與行政區轉換地圖 — API
//
// 掛載方式（見 server.js）：
//   app.use('/api/analytics/ga4-geo', requireStore, requireFeature('reports'),
//            require('./routes/ga4-geo'));
// 沿用既有 routes/geo-live.js／routes/analytics-geo.js 同一組保護慣例：
// requireStore 保證 req.storeId 只能是呼叫端自己的店（見需求文件十二：
// 「Query 不得覆寫 Store」——本檔案完全不讀 req.query.store_id）。

'use strict';

const express = require('express');
const router = express.Router();
const svc = require('../services/ga4GeoSyncService');

const ALLOWED_RANGES = new Set(['today', 'yesterday', '7d', '30d', 'custom']);

// ── GET /status ──
router.get('/status', (req, res) => {
  const status = svc.getGa4GeoSyncStatus(req.storeId);
  res.json({ success: true, ...status });
});

// ── GET /realtime ──
router.get('/realtime', (req, res) => {
  const result = svc.getRealtimeGeoSummary(req.storeId);
  if (!result.success) return res.status(200).json(result);
  res.json(result);
});

// ── GET /history?range=today|yesterday|7d|30d|custom&start_date=&end_date= ──
router.get('/history', (req, res) => {
  const range = ALLOWED_RANGES.has(req.query.range) ? req.query.range : 'today';
  const result = svc.getRangeGeoStats(req.storeId, range, req.query.start_date, req.query.end_date);
  res.json(result);
});

// ── POST /sync { sync_type, range, start_date, end_date } ──
// Rate limit: 簡單 in-memory per-store 節流（避免前端手動同步被連點濫用）。
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1（bugfix 輪）：Rate Limit 只能保護
// 「真的會打 GA4／寫 DB」的路徑。輸入驗證（sync_type／range 白名單、日期
// 格式）一律排在 Rate Limit 之前——否則同一店在節流視窗內連續打
// 一次合法同步再打一次「打錯 range 打字」的請求，第二個請求會被 429 擋住，
// 使用者永遠看不到真正的 invalid_range／invalid_sync_type 錯誤訊息，只看到
// 一個誤導的「太頻繁」訊息。這個順序調整不影響 Rate Limit 本身的節流效果：
// 惡意連點合法 sync_type 仍會在下面第二段被擋下。
const _lastManualSync = new Map();
const MANUAL_SYNC_MIN_INTERVAL_MS = 5000;
const SYNC_TYPES = new Set(['realtime', 'range', 'backfill']);
const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

function _validateSyncBody(body) {
  const syncType = body.sync_type;
  if (!SYNC_TYPES.has(syncType)) return { ok: false, code: 'invalid_sync_type' };
  if (syncType === 'range' || syncType === 'backfill') {
    if (!ALLOWED_RANGES.has(body.range)) return { ok: false, code: 'invalid_range' };
    if (body.range === 'custom') {
      if (!DATE_FORMAT_RE.test(body.start_date || '') || !DATE_FORMAT_RE.test(body.end_date || '')) {
        return { ok: false, code: 'invalid_date_format' };
      }
    }
  }
  return { ok: true, syncType, range: body.range };
}

router.post('/sync', async (req, res) => {
  const body = req.body || {};
  const validation = _validateSyncBody(body);
  if (!validation.ok) return res.status(400).json({ success: false, code: validation.code });

  const now = Date.now();
  const last = _lastManualSync.get(req.storeId) || 0;
  if (now - last < MANUAL_SYNC_MIN_INTERVAL_MS) {
    return res.status(429).json({ success: false, code: 'rate_limited' });
  }
  _lastManualSync.set(req.storeId, now);

  try {
    if (validation.syncType === 'realtime') {
      const r = await svc.syncRealtimeGeoSnapshot(req.storeId);
      return res.status(r.success ? 200 : 502).json(r);
    }
    // syncType is 'range' or 'backfill' (validated above; range/date format already checked)
    const fn = validation.syncType === 'backfill' ? svc.backfillGeoStats : svc.syncGeoRangeStats;
    const r = await fn(req.storeId, { type: validation.range, start_date: body.start_date, end_date: body.end_date });
    return res.status(r.success ? 200 : 502).json(r);
  } catch (e) {
    // 需求文件十二：不得回傳 Raw Error／Stack／Credential。
    return res.status(500).json({ success: false, code: 'unexpected_error' });
  }
});

module.exports = router;
