// routes/printJobs.js — SaaS R1 fix2（多店隔離版）
//
// ★ fix2 重點：
//   - 全部改用 req.storeId（由 requireStore middleware 解析）
//   - 禁止前端任意指定 store_id（原先 req.query.store_id / body.store_id 均廢棄）
//   - 所有查詢都帶 WHERE store_id=? 防跨店存取
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id      TEXT    NOT NULL DEFAULT 'store_001',
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

function parseJob(job) {
  if (!job) return null;
  return {
    ...job,
    payload: typeof job.payload === 'string'
      ? (() => { try { return JSON.parse(job.payload); } catch { return {}; } })()
      : job.payload,
  };
}

// POST /api/print-jobs — 建立列印任務
router.post('/', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    // ★ fix2：一律使用 req.storeId，忽略 body.store_id
    const storeId = req.storeId;
    const { order_id='', type='receipt', payload={} } = req.body;

    const validTypes = ['receipt', 'kitchen', 'test'];
    if (!validTypes.includes(type))
      return res.status(400).json({ success: false, message: `type 必須為 ${validTypes.join(' | ')}` });

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const result = db.run(
      `INSERT INTO print_jobs (store_id, order_id, type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now','localtime'))`,
      [storeId, order_id, type, payloadStr]
    );
    const job = db.get('SELECT * FROM print_jobs WHERE id=?', [result.lastInsertRowid]);
    console.log(`[PrintJobs] 建立任務 #${job.id} type=${type} store=${storeId} order=${order_id}`);
    res.status(201).json({ success: true, data: parseJob(job) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/print-jobs/pending — Android Bridge 輪詢
router.get('/pending', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    // ★ fix2：一律使用 req.storeId，廢棄 req.query.store_id
    const storeId = req.storeId;
    const limit   = Math.min(Number(req.query.limit) || 20, 50);
    const jobs = db.all(
      `SELECT * FROM print_jobs
       WHERE status='pending' AND store_id=?
       ORDER BY created_at ASC LIMIT ?`,
      [storeId, limit]
    );
    res.json({ success: true, data: jobs.map(parseJob) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/print-jobs — 後台查詢
router.get('/', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    // ★ fix2：一律使用 req.storeId
    const storeId = req.storeId;
    const status  = req.query.status;
    const limit   = Math.min(Number(req.query.limit) || 100, 500);
    let sql = 'SELECT * FROM print_jobs WHERE store_id=?';
    const params = [storeId];
    if (status) { sql += ' AND status=?'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const jobs = db.all(sql, params);
    res.json({ success: true, data: jobs.map(parseJob), total: jobs.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/print-jobs/:id
router.get('/:id', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const storeId = req.storeId;
    // ★ fix2：加 AND store_id=?
    const job = db.get('SELECT * FROM print_jobs WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });
    res.json({ success: true, data: parseJob(job) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/print-jobs/:id/printed
router.post('/:id/printed', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const storeId = req.storeId;
    // ★ fix2：加 AND store_id=?
    const job = db.get('SELECT * FROM print_jobs WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });
    db.run(
      `UPDATE print_jobs SET status='printed', printed_at=datetime('now','localtime'), error_message=''
       WHERE id=? AND store_id=?`,
      [req.params.id, storeId]
    );
    console.log(`[PrintJobs] #${req.params.id} 列印完成 (type=${job.type} order=${job.order_id})`);
    res.json({ success: true, message: '已標記為已列印' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/print-jobs/:id/error
router.post('/:id/error', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const storeId = req.storeId;
    // ★ fix2：加 AND store_id=?
    const job = db.get('SELECT * FROM print_jobs WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });
    const { error_message = '未知錯誤' } = req.body;
    db.run(
      `UPDATE print_jobs SET status='error', error_message=?, printed_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [String(error_message), req.params.id, storeId]
    );
    console.error(`[PrintJobs] #${req.params.id} 列印失敗: ${error_message}`);
    res.json({ success: true, message: '已標記為錯誤' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/print-jobs/:id/retry
router.post('/:id/retry', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const storeId = req.storeId;
    // ★ fix2：加 AND store_id=?
    const job = db.get('SELECT * FROM print_jobs WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!job) return res.status(404).json({ success: false, message: '任務不存在' });
    db.run(
      `UPDATE print_jobs SET status='pending', error_message='', printed_at=''
       WHERE id=? AND store_id=?`,
      [req.params.id, storeId]
    );
    console.log(`[PrintJobs] #${req.params.id} 重設為 pending（重試）`);
    res.json({ success: true, message: '已重設為待列印' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// DELETE /api/print-jobs/cleanup — 清除舊任務（限本店）
router.delete('/cleanup', (req, res) => {
  try {
    ensureTable();
    const db = getDb();
    const storeId = req.storeId;
    const days = Number(req.query.days) || 7;
    // ★ fix2：加 AND store_id=?
    db.run(
      `DELETE FROM print_jobs
       WHERE store_id=? AND status IN ('printed','error')
         AND created_at < datetime('now', '-${days} days', 'localtime')`,
      [storeId]
    );
    res.json({ success: true, message: `已清除 ${days} 天前的已完成任務` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
