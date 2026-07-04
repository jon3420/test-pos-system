// routes/business-calendar.js — 營業行事曆 Business Calendar V2
// 用途：作為「每週營業時間」的覆蓋層，支援指定日期（單日/區間）休假或特殊營業時間。
// 隔離：專案沒有 tenant_id 概念，沿用既有慣例，一律用 store_id 隔離。
// 不修改既有 settings key 語意，不刪除 line_closed_dates 等舊設定。
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

const VALID_MODES = ['closed', 'custom_hours', 'open_all_day'];

// ── 台灣時間工具（與 routes/line-orders.js 邏輯一致，獨立複製避免耦合）──
function twNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function twDateStr(d) {
  const dt = d || twNow();
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
// 安全解析 YYYY-MM-DD，不受伺服器時區影響
function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(dateStr, n) {
  const dt = parseLocalDate(dateStr);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = parseLocalDate(s);
  return !isNaN(dt.getTime());
}
function isValidTimeStr(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function toBoolInt(v, def = 1) {
  if (v === undefined || v === null || v === '') return def;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return def;
}

function rowToApi(r) {
  return {
    id: r.id,
    store_id: r.store_id,
    start_date: r.start_date,
    end_date: r.end_date,
    mode: r.mode,
    reason: r.reason || '',
    show_reason: Number(r.show_reason) === 1,
    takeout_enabled: Number(r.takeout_enabled) === 1,
    delivery_enabled: Number(r.delivery_enabled) === 1,
    takeout_start_time: r.takeout_start_time || '',
    takeout_end_time: r.takeout_end_time || '',
    delivery_start_time: r.delivery_start_time || '',
    delivery_end_time: r.delivery_end_time || '',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── 共用驗證：新增/編輯共用 ─────────────────────────────────
function validatePayload(body) {
  const errors = [];
  const start_date = body.start_date;
  const end_date   = body.end_date;
  const mode       = body.mode;

  if (!isValidDateStr(start_date)) errors.push('start_date 格式錯誤，需為 YYYY-MM-DD');
  if (!isValidDateStr(end_date))   errors.push('end_date 格式錯誤，需為 YYYY-MM-DD');
  if (isValidDateStr(start_date) && isValidDateStr(end_date) && end_date < start_date) {
    errors.push('end_date 不可早於 start_date');
  }
  if (!VALID_MODES.includes(mode)) errors.push(`mode 必須是 ${VALID_MODES.join(' / ')} 其中之一`);
  if (errors.length) return { ok: false, errors };

  const takeout_enabled  = toBoolInt(body.takeout_enabled, 1);
  const delivery_enabled = toBoolInt(body.delivery_enabled, 1);
  const show_reason      = toBoolInt(body.show_reason, 1);
  const reason           = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';

  let takeout_start_time = '', takeout_end_time = '', delivery_start_time = '', delivery_end_time = '';

  if (mode === 'custom_hours') {
    if (takeout_enabled) {
      takeout_start_time = body.takeout_start_time || '';
      takeout_end_time   = body.takeout_end_time || '';
      if (!isValidTimeStr(takeout_start_time) || !isValidTimeStr(takeout_end_time)) {
        errors.push('外帶開放時，特殊營業時間模式必須提供正確的外帶開始/結束時間（HH:MM）');
      } else if (takeout_end_time <= takeout_start_time) {
        errors.push('外帶結束時間必須晚於開始時間');
      }
    }
    if (delivery_enabled) {
      delivery_start_time = body.delivery_start_time || '';
      delivery_end_time   = body.delivery_end_time || '';
      if (!isValidTimeStr(delivery_start_time) || !isValidTimeStr(delivery_end_time)) {
        errors.push('外送開放時，特殊營業時間模式必須提供正確的外送開始/結束時間（HH:MM）');
      } else if (delivery_end_time <= delivery_start_time) {
        errors.push('外送結束時間必須晚於開始時間');
      }
    }
  }
  // mode 為 closed / open_all_day 時，時間欄位一律清空，不採用前端可能傳來的殘值

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      start_date, end_date, mode, reason, show_reason,
      takeout_enabled, delivery_enabled,
      takeout_start_time, takeout_end_time, delivery_start_time, delivery_end_time,
    }
  };
}

// ── 核心：找出某日命中的行事曆項目（供本檔案與 line-orders.js 共用）──
// 若有多筆重疊（理論上後台應避免），採「最後建立/編輯的那筆」優先（id DESC）
function findMatchingEntry(db, storeId, dateStr) {
  const row = db.get(
    `SELECT * FROM store_business_calendar
     WHERE store_id=? AND start_date<=? AND end_date>=?
     ORDER BY id DESC LIMIT 1`,
    [storeId, dateStr, dateStr]
  );
  return row || null;
}

// ── 核心：組出「今日狀態」物件，供 /today 與 /shop 共用 ──────
function computeTodayStatus(db, storeId, dateStr) {
  const row = findMatchingEntry(db, storeId, dateStr);
  if (!row) {
    return {
      matched: false, mode: null, reason: '', show_reason: false,
      start_date: null, end_date: null, resume_date: null,
      takeout_enabled: null, delivery_enabled: null,
      takeout_start_time: '', takeout_end_time: '',
      delivery_start_time: '', delivery_end_time: '',
    };
  }
  const api = rowToApi(row);
  return {
    matched: true,
    mode: api.mode,
    reason: api.reason,
    show_reason: api.show_reason,
    start_date: api.start_date,
    end_date: api.end_date,
    resume_date: addDays(api.end_date, 1),
    takeout_enabled: api.takeout_enabled,
    delivery_enabled: api.delivery_enabled,
    takeout_start_time: api.takeout_start_time,
    takeout_end_time: api.takeout_end_time,
    delivery_start_time: api.delivery_start_time,
    delivery_end_time: api.delivery_end_time,
  };
}

// ── GET /api/settings/business-calendar ─────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all(
      'SELECT * FROM store_business_calendar WHERE store_id=? ORDER BY start_date ASC, id ASC',
      [storeId]
    );
    res.json({ success: true, data: rows.map(rowToApi) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/settings/business-calendar/today ────────────────
// 注意：路由順序需在 '/:id' 系列之前，避免 'today' 被誤判成 :id
router.get('/today', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const todayStr = twDateStr();
    const status = computeTodayStatus(db, storeId, todayStr);
    res.json({ success: true, data: { today: todayStr, ...status } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/settings/business-calendar ────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const v = validatePayload(req.body || {});
    if (!v.ok) return res.status(400).json({ success: false, message: v.errors.join('；'), errors: v.errors });

    const d = v.data;
    const result = db.run(
      `INSERT INTO store_business_calendar
        (store_id, start_date, end_date, mode, reason, show_reason,
         takeout_enabled, delivery_enabled,
         takeout_start_time, takeout_end_time, delivery_start_time, delivery_end_time,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'), datetime('now','localtime'))`,
      [storeId, d.start_date, d.end_date, d.mode, d.reason, d.show_reason,
       d.takeout_enabled, d.delivery_enabled,
       d.takeout_start_time, d.takeout_end_time, d.delivery_start_time, d.delivery_end_time]
    );
    const row = db.get('SELECT * FROM store_business_calendar WHERE id=? AND store_id=?', [result.lastInsertRowid, storeId]);
    res.json({ success: true, data: row ? rowToApi(row) : null });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PUT /api/settings/business-calendar/:id ──────────────────
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '無效的 id' });

    const existing = db.get('SELECT * FROM store_business_calendar WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '找不到該行事曆項目' });

    const v = validatePayload(req.body || {});
    if (!v.ok) return res.status(400).json({ success: false, message: v.errors.join('；'), errors: v.errors });

    const d = v.data;
    db.run(
      `UPDATE store_business_calendar SET
        start_date=?, end_date=?, mode=?, reason=?, show_reason=?,
        takeout_enabled=?, delivery_enabled=?,
        takeout_start_time=?, takeout_end_time=?, delivery_start_time=?, delivery_end_time=?,
        updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [d.start_date, d.end_date, d.mode, d.reason, d.show_reason,
       d.takeout_enabled, d.delivery_enabled,
       d.takeout_start_time, d.takeout_end_time, d.delivery_start_time, d.delivery_end_time,
       id, storeId]
    );
    const row = db.get('SELECT * FROM store_business_calendar WHERE id=? AND store_id=?', [id, storeId]);
    res.json({ success: true, data: row ? rowToApi(row) : null });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── DELETE /api/settings/business-calendar/:id ───────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '無效的 id' });

    const existing = db.get('SELECT * FROM store_business_calendar WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '找不到該行事曆項目' });

    db.run('DELETE FROM store_business_calendar WHERE id=? AND store_id=?', [id, storeId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
module.exports.computeTodayStatus = computeTodayStatus;
module.exports.findMatchingEntry  = findMatchingEntry;
