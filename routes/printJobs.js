// routes/printJobs.js
// ─────────────────────────────────────────────────────────
// Print Jobs Queue API
// Android Print Bridge 透過這組 API 取得待列印任務並回報結果
//
// POST   /api/print-jobs              建立列印任務
// GET    /api/print-jobs/pending      查詢待列印任務（?store_id=default）
// POST   /api/print-jobs/:id/printed  回報列印成功
// POST   /api/print-jobs/:id/error    回報列印失敗
// GET    /api/print-jobs              查詢所有任務（?store_id=&status=&limit=）
// DELETE /api/print-jobs/cleanup      清除舊任務（保留 7 天內）
// ─────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 確保 print_jobs 資料表存在（防護性建立）────────────────
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id      TEXT    NOT NULL DEFAULT 'default',
      order_id      TEXT    DEFAULT '',
      type          TEXT    NOT NULL DEFAULT 'receipt',
      payload       TEXT    NOT NULL DEFAULT '{}',
      status        TEXT    NOT NULL DEFAULT 'pending',
      error_message TEXT    DEFAULT '',
      created_at    TEXT    DEFAULT (datetime('now','localtime')),
      printed_at    TEXT    DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_pending
      ON print_jobs(status, store_id, created_at);
  `);
}

// ── 解析 payload 欄位 ──────────────────────────────────────
function parseJob(job) {
  if (!job) return null;
  return {
    ...job,
    payload: typeof job.payload === 'string'
      ? (() => { try { return JSON.parse(job.payload); } catch { return {}; } })()
      : job.payload,
  };
}

// ── POST /api/print-jobs ──────────────────────────────────
// 建立列印任務（由 POS 訂單成立時呼叫，或手動測試）
router.post('/', (req, res) => {
  try {
    ensureTable();
    const db = getDb();

    const {
      store_id = 'default',
      order_id = '',
      type     = 'receipt',    // receipt | kitchen | test
      payload  = {},
    } = req.body;

    const validTypes = ['receipt', 'kitchen', 'test'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ success: false, message: `type 必須為 ${validTypes.join(' | ')}` });
    }

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const result = db.run(
      `INSERT INTO print_jobs (store_id, order_id, type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now','localtime'))`,
      [store_id, order_id, type, payloadStr]
    );

    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [result.lastInsertRowid]);
    console.log(`[PrintJobs] 建立任務 #${job.id} type=${type} store=${store_id} order=${order_id}`);

    res.status(201).json({ success: true, data: parseJob(job) });
  } catch (e) {
    console.error('[PrintJobs] 建立失敗:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/print-jobs/pending ───────────────────────────
// Android Bridge 輪詢端點：只取 pending 任務
router.get('/pending', (req, res) => {
  try {
    ensureTable();
    const db = getDb();

    const store_id = req.query.store_id || 'default';
    const limit    = Math.min(Number(req.query.limit) || 20, 50);

    const jobs = db.all(
      `SELECT * FROM print_jobs
       WHERE status = 'pending' AND store_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [store_id, limit]
    );

    res.json({ success: true, data: jobs.map(parseJob) });
  } catch (e) {
    console.error('[PrintJobs] 查詢待印失敗:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/print-jobs ───────────────────────────────────
// 後台查詢所有任務（含歷史記錄）
router.get('/', (req, res) => {
  try {
    ensureTable();
    const db = getDb();

    const store_id = req.query.store_id || 'default';
    const status   = req.query.status;     // 可選篩選
    const limit    = Math.min(Number(req.query.limit) || 100, 500);

    let sql    = 'SELECT * FROM print_jobs WHERE store_id = ?';
    const params = [store_id];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const jobs = db.all(sql, params);
    res.json({ success: true, data: jobs.map(parseJob), total: jobs.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/print-jobs/:id ───────────────────────────────
router.get('/:id', (req, res) => {
  try {
    ensureTable();
    const db  = getDb();
    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });
    res.json({ success: true, data: parseJob(job) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/print-jobs/:id/printed ─────────────────────
// Android Bridge 列印成功後呼叫
router.post('/:id/printed', (req, res) => {
  try {
    ensureTable();
    const db  = getDb();
    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });

    db.run(
      `UPDATE print_jobs
       SET status='printed', printed_at=datetime('now','localtime'), error_message=''
       WHERE id=?`,
      [req.params.id]
    );

    console.log(`[PrintJobs] #${req.params.id} 列印完成 (type=${job.type} order=${job.order_id})`);
    res.json({ success: true, message: '已標記為已列印' });
  } catch (e) {
    console.error('[PrintJobs] 標記完成失敗:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/print-jobs/:id/error ───────────────────────
// Android Bridge 列印失敗後呼叫
router.post('/:id/error', (req, res) => {
  try {
    ensureTable();
    const db  = getDb();
    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });

    const { error_message = '未知錯誤' } = req.body;

    db.run(
      `UPDATE print_jobs
       SET status='error', error_message=?, printed_at=datetime('now','localtime')
       WHERE id=?`,
      [String(error_message), req.params.id]
    );

    console.error(`[PrintJobs] #${req.params.id} 列印失敗: ${error_message}`);
    res.json({ success: true, message: '已標記為錯誤' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/print-jobs/:id/retry ───────────────────────
// 將 error 任務重新設為 pending（重試）
router.post('/:id/retry', (req, res) => {
  try {
    ensureTable();
    const db  = getDb();
    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });

    db.run(
      `UPDATE print_jobs
       SET status='pending', error_message='', printed_at=''
       WHERE id=?`,
      [req.params.id]
    );

    console.log(`[PrintJobs] #${req.params.id} 重設為 pending（重試）`);
    res.json({ success: true, message: '已重設為待列印' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /api/print-jobs/cleanup ───────────────────────
// 清除 7 天前已完成的任務（節省空間）
router.delete('/cleanup', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const days = Number(req.query.days) || 7;

    db.run(
      `DELETE FROM print_jobs
       WHERE status IN ('printed', 'error')
         AND created_at < datetime('now', '-${days} days', 'localtime')`,
      []
    );

    res.json({ success: true, message: `已清除 ${days} 天前的已完成任務` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
