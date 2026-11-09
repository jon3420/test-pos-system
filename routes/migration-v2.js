// routes/migration-v2.js — R54.4 Migration & Backup V2
//
// 掛載：app.use('/api/migration/v2', router)；router.use(requireStaffJwt)
//   → 一律需要有效的店家 JWT；不接受 x-store-id／query store_id（避免未登入匯出／清除）。
//
// 端點：
//   GET  /config                 上傳上限、分類定義、日期選項、儲存狀態
//   GET  /export/preview         每個分類的筆數／估算大小（可帶日期篩選）
//   GET  /export                 匯出（完整或選擇性；?gzip=1 下載 .json.gz）
//   POST /upload                 串流上傳備份檔（.json 或 .json.gz），驗證檔頭後回傳 upload_id
//   POST /preview                以 upload_id 建立「唯讀預覽」工作（交易內試算後回滾）
//   POST /import                 以 upload_id 建立正式匯入工作（需先預覽、完整取代需二次確認）
//   GET  /jobs/:id               查詢工作狀態與結果
//   GET  /storage-status         SQLite 持久化狀態（不回傳完整路徑）
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const router = express.Router();
const { requireStaffJwt } = require('../middleware/storeGuard');
router.use(requireStaffJwt); // 只信任店家 JWT 內的 store_id

const dbModule = require('../utils/db');
const { getDb } = dbModule;
const mv2 = require('../utils/migrationV2');
const {
  MIGRATION_UPLOAD_LIMIT_MB, MIGRATION_UPLOAD_LIMIT_BYTES,
  DEFAULT_MIGRATION_UPLOAD_LIMIT_MB, MAX_MIGRATION_UPLOAD_LIMIT_MB,
} = require('../utils/migrationUploadLimit');

const UPLOAD_DIR = process.env.MIGRATION_TMP_DIR || path.join(os.tmpdir(), 'pos-migration-v2');
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_UPLOADS_PER_STORE = 3;
const SAFETY_KEEP_PER_STORE = 5;

const uploads = new Map(); // id → { id, storeId, file, gz, bytes, decompressedBytes, info, createdAt, fileName }
const jobs = new Map();    // id → { id, storeId, kind, status, result, error, createdAt, startedAt, finishedAt }
let jobChain = Promise.resolve();

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} }
function newId() { return crypto.randomBytes(16).toString('hex'); }
function sendErr(res, e) {
  const status = e && e.status ? e.status : 500;
  const body = { success: false, code: (e && e.code) || 'INTERNAL_ERROR', message: (e && e.message) || '伺服器錯誤' };
  if (e && e.extra && e.extra.verification) body.verification = e.extra.verification;
  if (e && e.extra && e.extra.required_mb) { body.required_mb = e.extra.required_mb; body.available_mb = e.extra.available_mb; }
  if (status >= 500 && !(e && e.code)) console.error('[migration-v2]', e && e.stack);
  return res.status(status).json(body);
}

function cleanup() {
  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.createdAt > UPLOAD_TTL_MS) { try { fs.unlinkSync(u.file); } catch {} uploads.delete(id); }
  }
  for (const [id, j] of jobs) { if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id); }
  // 清掉程序重啟前殘留、超過 TTL 的暫存檔
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { const st = fs.statSync(p); if (now - st.mtimeMs > UPLOAD_TTL_MS) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
const _cleanupTimer = setInterval(cleanup, 10 * 60 * 1000);
if (_cleanupTimer.unref) _cleanupTimer.unref();

function writeMigrationLog(db, storeId, action, fileName, mode, summary, status, errMsg) {
  try {
    db._db.run(`CREATE TABLE IF NOT EXISTS migration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, action TEXT NOT NULL,
      file_name TEXT DEFAULT '', mode TEXT DEFAULT '', summary_json TEXT DEFAULT '{}', status TEXT DEFAULT 'success',
      error_message TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);
    db.run(`INSERT INTO migration_logs (store_id,action,file_name,mode,summary_json,status,error_message) VALUES (?,?,?,?,?,?,?)`,
      [storeId, action, fileName || '', mode || '', JSON.stringify(summary || {}).slice(0, 20000), status || 'success', String(errMsg || '').slice(0, 500)]);
  } catch (e) { console.error('[migration-v2 log]', e.message); }
}

// ── 儲存狀態（持久化稽核）─────────────────────────────────────────────────
function storageStatus() {
  const info = typeof dbModule.getStorageInfo === 'function' ? dbModule.getStorageInfo() : null;
  if (!info) return { available: false };
  const appRoot = path.resolve(__dirname, '..');
  const dbPath = path.resolve(info.dbPath);
  let size = null; try { size = fs.statSync(dbPath).size; } catch {}
  const insideApp = dbPath === appRoot || dbPath.startsWith(appRoot + path.sep);
  const warnings = [];
  if (insideApp) warnings.push('資料庫檔位於程式目錄內。若平台未在此路徑掛載持久化 Volume，重新部署後資料會遺失。建議設定 POS_DB_PATH 指向已掛載的 Volume。');
  if (info.legacyDbPathEnvIgnored) warnings.push('偵測到環境變數 DB_PATH 已設定，但程式只讀取 POS_DB_PATH，DB_PATH 目前沒有作用。');
  if (!info.existedAtBoot) warnings.push('本次啟動時資料庫檔不存在，系統以空資料庫啟動。');
  return {
    available: true,
    engine: 'sql.js（整份資料庫載入記憶體，寫入時以暫存檔＋fsync＋rename 原子替換；不使用 WAL／SHM）',
    configured_by: info.configuredBy,          // 'POS_DB_PATH' | 'default'
    file_name: path.basename(dbPath),
    inside_app_directory: insideApp,
    existed_at_boot: info.existedAtBoot,
    size_at_boot_bytes: info.bootSizeBytes,
    current_size_bytes: size,
    booted_at: info.bootedAt,
    legacy_db_path_env_ignored: !!info.legacyDbPathEnvIgnored,
    warnings,
  };
}

// ── 記憶體保護 ─────────────────────────────────────────────────────────
// 實測：JSON.parse 期間 V8 heap 峰值約為檔案位元組數的 3.4 倍。Node 在 heap 用盡時會
// 直接 abort 整個程序（POS 全站停止），因此解析前先確認可用 heap，不足就拒絕並提示分批。
const MEMORY_FACTOR = 4;
const MEMORY_HEADROOM = 64 * 1024 * 1024;
function memoryCheck(bytes) {
  const v8 = require('v8');
  const h = v8.getHeapStatistics();
  const available = h.heap_size_limit - h.used_heap_size;
  const required = bytes * MEMORY_FACTOR + MEMORY_HEADROOM;
  return { ok: required <= available, required, available, heap_limit: h.heap_size_limit };
}
let _gc = null;
function forceGc() {
  try {
    if (!_gc) { require('v8').setFlagsFromString('--expose_gc'); _gc = require('vm').runInNewContext('gc'); }
    _gc();
  } catch {}
}
function assertMemoryFor(bytes) {
  let m = memoryCheck(bytes);
  // used_heap_size 含尚未回收的垃圾（例如上一個步驟解析過的檔案）；不足時先完整 GC 再判斷一次
  if (!m.ok) { forceGc(); m = memoryCheck(bytes); }
  if (!m.ok) {
    const mb = (x) => Math.round(x / 1024 / 1024);
    throw new mv2.MigrationError('MIGRATION_INSUFFICIENT_MEMORY',
      `伺服器可用記憶體不足以安全處理這個 ${mb(bytes)}MB 的檔案（約需 ${mb(m.required)}MB，目前可用約 ${mb(m.available)}MB）。` +
      '為避免整個 POS 服務中斷，已停止處理。請改用「選擇性匯出」分類或依日期分批，或由管理員提高伺服器記憶體／NODE_OPTIONS=--max-old-space-size。', 507,
      { required_mb: mb(m.required), available_mb: mb(m.available) });
  }
  return m;
}

// ── 讀取已上傳檔案並解析 ───────────────────────────────────────────────────
function readUploadPayload(u) {
  assertMemoryFor(u.decompressedBytes || u.bytes);
  let buf = fs.readFileSync(u.file);
  if (u.gz) buf = zlib.gunzipSync(buf, { maxOutputLength: MIGRATION_UPLOAD_LIMIT_BYTES });
  const text = buf.toString('utf8');
  buf = null;
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

function currentCounts(db, storeId, tables) {
  const out = {};
  for (const t of tables) { try { out[t] = mv2.countScoped(db._db, t, storeId); } catch { out[t] = 0; } }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    upload_limit_mb: MIGRATION_UPLOAD_LIMIT_MB,
    upload_limit_bytes: MIGRATION_UPLOAD_LIMIT_BYTES,
    default_upload_limit_mb: DEFAULT_MIGRATION_UPLOAD_LIMIT_MB,
    max_upload_limit_mb: MAX_MIGRATION_UPLOAD_LIMIT_MB,
    supported_extensions: ['.json', '.json.gz'],
    schema_version: mv2.SCHEMA_VERSION,
    timezone: mv2.TZ,
    categories: mv2.CATEGORY_DEFS.map(c => ({ key: c.key, label: c.label, desc: c.desc, tables: c.tables,
      recommends: c.recommends, includes_history: !!c.history, date_filter_supported: !!c.dateFilter, sensitive: !!c.sensitive })),
    date_presets: [
      { key: 'all', label: '全部歷史' }, { key: 'today', label: '今日' }, { key: 'yesterday', label: '昨日' },
      { key: 'this_week', label: '本週（週一起）' }, { key: 'this_month', label: '本月' }, { key: 'last_month', label: '上個月' },
      { key: 'month', label: '指定月份' }, { key: 'custom', label: '自訂日期範圍' },
    ],
    excluded_tables: mv2.EXCLUDED_TABLES,
    memory: (() => { const m = memoryCheck(0); return { heap_limit_mb: Math.round(m.heap_limit / 1048576), available_mb: Math.round(m.available / 1048576),
      safe_file_mb_estimate: Math.max(0, Math.floor((m.available - MEMORY_HEADROOM) / MEMORY_FACTOR / 1048576)) }; })(),
  });
});

router.get('/storage-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, storage: storageStatus() });
});

function parseFilters(q) {
  if (!q) return {};
  try {
    const f = JSON.parse(String(q));
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error();
    return f;
  } catch { throw new mv2.MigrationError('INVALID_FILTERS', 'filters 參數格式錯誤'); }
}

router.get('/export/preview', (req, res) => {
  try {
    const db = getDb();
    const filters = parseFilters(req.query.filters);
    const data = mv2.exportPreview(db, req.storeId, { filters });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, store_id: req.storeId, ...data });
  } catch (e) { sendErr(res, e); }
});

router.get('/export', (req, res) => {
  let built;
  try {
    const db = getDb();
    const filters = parseFilters(req.query.filters);
    const categories = req.query.mode === 'full' ? mv2.CATEGORY_KEYS : String(req.query.categories || '');
    built = mv2.buildExportChunks(db, req.storeId, { categories, filters });
    const gz = req.query.gzip === '1' || req.query.gzip === 'true';
    const fileName = built.fileName + (gz ? '.gz' : '');
    writeMigrationLog(db, req.storeId, built.backupType === 'full' ? 'V2 完整匯出' : 'V2 選擇性匯出', fileName, built.backupType,
      { categories: built.categories, filters: built.filters, table_counts: built.header.table_counts }, 'success', '');
    res.set('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Backup-Type', built.backupType);
    res.setHeader('X-Backup-File-Name', encodeURIComponent(fileName));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Backup-Type, X-Backup-File-Name');
    if (gz) {
      res.setHeader('Content-Type', 'application/gzip');
      const gzip = zlib.createGzip({ level: 6 });
      gzip.pipe(res);
      for (const c of built.chunks) gzip.write(c);
      built.chunks = null;
      gzip.end();
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      for (const c of built.chunks) res.write(c);
      built.chunks = null;
      res.end();
    }
  } catch (e) { if (!res.headersSent) sendErr(res, e); else res.destroy(e); }
});

// ── 串流上傳 ────────────────────────────────────────────────────────────
router.post('/upload', (req, res) => {
  cleanup();
  const storeId = req.storeId;
  const limit = MIGRATION_UPLOAD_LIMIT_BYTES;
  const tooLarge = (code, extra) => {
    res.set('Connection', 'close');
    return res.status(413).json({ success: false, code: code || 'MIGRATION_FILE_TOO_LARGE',
      message: `檔案過大，目前最多接受 ${MIGRATION_UPLOAD_LIMIT_MB}MB`, max_size_mb: MIGRATION_UPLOAD_LIMIT_MB, ...(extra || {}) });
  };
  const cl = Number(req.headers['content-length']);
  if (Number.isFinite(cl) && cl > limit) { req.resume(); return tooLarge('MIGRATION_FILE_TOO_LARGE', { received_bytes: cl }); }
  ensureDir(UPLOAD_DIR);
  const id = newId();
  const file = path.join(UPLOAD_DIR, `${id}.upload`);
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let bytes = 0, aborted = false, head = null;
  const fail = (fn) => { if (aborted) return; aborted = true; out.destroy(); fs.unlink(file, () => {}); fn(); };
  // 必須監聽 error：寫入暫存檔失敗（磁碟滿）或 destroy 後殘留的 pending write
  // 若沒有 listener 會成為 unhandled 'error' 而讓整個 POS 伺服器程序結束。
  out.on('error', (e) => {
    if (aborted) return;
    fail(() => { req.resume(); if (!res.headersSent) res.status(507).json({ success: false, code: 'UPLOAD_STORAGE_ERROR', message: '伺服器暫存空間寫入失敗，請稍後再試' }); });
    console.error('[migration-v2 upload] temp write error:', e && e.code);
  });
  req.on('data', (chunk) => {
    if (aborted) return;
    if (!head) head = chunk.subarray(0, 4);
    bytes += chunk.length;
    if (bytes > limit) { fail(() => { req.resume(); tooLarge('MIGRATION_FILE_TOO_LARGE', { received_bytes: bytes }); }); return; }
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('aborted', () => fail(() => {}));
  req.on('error', () => fail(() => { if (!res.headersSent) res.status(400).json({ success: false, code: 'UPLOAD_ABORTED', message: '上傳中斷' }); }));
  req.on('end', () => {
    if (aborted) return;
    out.end(() => {
      if (!bytes) { fs.unlink(file, () => {}); return res.status(400).json({ success: false, code: 'EMPTY_FILE', message: '上傳的檔案是空的' }); }
      const gz = !!(head && head[0] === 0x1f && head[1] === 0x8b);
      let payload, info, decompressedBytes = bytes;
      const u = { id, storeId, file, gz, bytes, createdAt: Date.now(), fileName: String(req.headers['x-file-name'] ? decodeURIComponent(String(req.headers['x-file-name'])) : '').slice(0, 200) };
      try {
        if (gz) {
          let raw = fs.readFileSync(file);
          try { raw = zlib.gunzipSync(raw, { maxOutputLength: limit }); }
          catch (e) {
            fs.unlink(file, () => {});
            if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) return tooLarge('MIGRATION_DECOMPRESSED_TOO_LARGE', { message: `解壓縮後超過 ${MIGRATION_UPLOAD_LIMIT_MB}MB 上限，已拒絕` });
            return res.status(400).json({ success: false, code: 'INVALID_GZIP', message: '壓縮檔損壞或不是有效的 gzip 檔' });
          }
          decompressedBytes = raw.length;
          raw = null;
        }
        u.decompressedBytes = decompressedBytes;
        try { payload = readUploadPayload(u); }
        catch (e) {
          fs.unlink(file, () => {});
          if (e && e.code === 'MIGRATION_INSUFFICIENT_MEMORY') return sendErr(res, e);
          return res.status(400).json({ success: false, code: 'INVALID_JSON_BODY', message: '檔案不是有效的 JSON（可能不完整或已損壞）' });
        }
        info = mv2.inspectPayload(payload);
      } catch (e) { fs.unlink(file, () => {}); return sendErr(res, e); }
      payload = null;
      u.decompressedBytes = decompressedBytes;
      u.info = info;
      // 每店最多保留 3 份待處理上傳
      const mine = [...uploads.values()].filter(x => x.storeId === storeId).sort((a, b) => a.createdAt - b.createdAt);
      while (mine.length >= MAX_UPLOADS_PER_STORE) { const old = mine.shift(); try { fs.unlinkSync(old.file); } catch {} uploads.delete(old.id); }
      uploads.set(id, u);
      const db = getDb();
      const tables = [...new Set(info.categories_present.flatMap(c => mv2.CATEGORY_BY_KEY[c].tables))];
      res.json({
        success: true, upload_id: id,
        file: { bytes, gzip: gz, decompressed_bytes: decompressedBytes, name: u.fileName },
        backup: info,
        current_store_id: storeId,
        cross_store: !!(info.source_store_id && info.source_store_id !== storeId),
        current_counts: currentCounts(db, storeId, tables),
        categories: info.categories_present.map(k => ({ key: k, label: mv2.CATEGORY_BY_KEY[k].label, tables: mv2.CATEGORY_BY_KEY[k].tables })),
      });
    });
  });
});

// ── 工作佇列（匯入／預覽為同步運算，一次只跑一個）─────────────────────────
function enqueue(job, fn) {
  jobs.set(job.id, job);
  jobChain = jobChain.then(() => new Promise((resolve) => {
    setImmediate(async () => {
      job.status = 'running'; job.startedAt = Date.now();
      try { job.result = await fn(); job.status = 'done'; }
      catch (e) {
        job.status = 'error';
        job.error = { code: e.code || 'INTERNAL_ERROR', message: e.message || '未預期錯誤', ...(e.extra && e.extra.verification ? { verification: e.extra.verification } : {}) };
        if (!e.code) console.error('[migration-v2 job]', e && e.stack);
      }
      job.finishedAt = Date.now();
      resolve();
    });
  }));
}

function getUpload(req) {
  const u = uploads.get(String(req.body && req.body.upload_id || ''));
  if (!u || u.storeId !== req.storeId) throw new mv2.MigrationError('UPLOAD_NOT_FOUND', '找不到上傳的檔案（可能已逾時，請重新選擇檔案）', 404);
  if (!fs.existsSync(u.file)) { uploads.delete(u.id); throw new mv2.MigrationError('UPLOAD_NOT_FOUND', '暫存檔已不存在，請重新選擇檔案', 404); }
  return u;
}
function importOpts(body) {
  return { mode: String(body.mode || 'skip'), categories: body.categories || [], allowCrossStore: body.allow_cross_store === true };
}

router.post('/preview', (req, res) => {
  try {
    const u = getUpload(req);
    const opts = importOpts(req.body || {});
    const storeId = req.storeId;
    mv2.validateImportOptions(u.info, storeId, opts);
    const job = { id: newId(), storeId, kind: 'preview', status: 'queued', createdAt: Date.now() };
    enqueue(job, () => {
      const db = getDb();
      let payload = readUploadPayload(u);
      const t0 = Date.now();
      const r = mv2.executeImport(db, storeId, payload, u.info, { ...opts, dryRun: true });
      payload = null;
      const purgePreview = [];
      if (opts.mode === 'replace') {
        for (const name of mv2.purgeTablesFor(r.categories)) purgePreview.push({ scope: name, ...mv2.purgeCount(db._db, storeId, name) });
      }
      return { ...r, elapsed_ms: Date.now() - t0, preview_token: mv2.optionsFingerprint(u.id, storeId, opts),
        purge_preview: purgePreview.map(p => ({ table: p.table, scope: p.scope, rows_to_delete: p.count })), backup: u.info };
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status });
  } catch (e) { sendErr(res, e); }
});

function verifyStorePassword(db, storeId, password) {
  if (!password) return false;
  const row = db.get("SELECT value FROM settings WHERE store_id=? AND key='pos_password'", [storeId]);
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
  const expected = row ? row.value : sha(storeId);
  const a = Buffer.from(sha(password)), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let _SQL = null;
async function getSql() { if (!_SQL) _SQL = await require('sql.js')(); return _SQL; }

// 完整取代前：整份資料庫快照 → 寫入 migration-safety → 重新開啟快照核對本店筆數
function safetySnapshot(SQL, db, storeId, categories) {
  const info = dbModule.getStorageInfo();
  const dir = process.env.MIGRATION_SAFETY_DIR || path.join(path.dirname(path.resolve(info.dbPath)), 'migration-safety');
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const name = `pre-replace-${storeId.replace(/[^A-Za-z0-9_-]/g, '_')}-${ts}.sqlite`;
  const file = path.join(dir, name);
  const bytes = Buffer.from(db._db.export());
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, bytes, 0, bytes.length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const snap = new SQL.Database(fs.readFileSync(file));
  const checks = [];
  try {
    const tables = [...new Set(categories.flatMap(c => mv2.CATEGORY_BY_KEY[c].tables))];
    for (const t of tables) {
      const live = mv2.countScoped(db._db, t, storeId);
      const sv = mv2.countScoped(snap, t, storeId);
      checks.push({ table: t, live, snapshot: sv, ok: live === sv });
    }
  } finally { snap.close(); }
  const ok = checks.every(c => c.ok);
  if (!ok) { try { fs.unlinkSync(file); } catch {} throw new mv2.MigrationError('SAFETY_SNAPSHOT_VERIFY_FAILED', '取代前安全快照驗證失敗，已停止，資料庫未變更', 500); }
  // 每店只保留最近 5 份
  try {
    const prefix = `pre-replace-${storeId.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
    const list = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.sqlite')).sort();
    while (list.length > SAFETY_KEEP_PER_STORE) { try { fs.unlinkSync(path.join(dir, list.shift())); } catch {} }
  } catch {}
  return { file_name: name, bytes: bytes.length, verified: true, checks };
}

router.post('/import', (req, res) => {
  try {
    const db = getDb();
    const u = getUpload(req);
    const body = req.body || {};
    const opts = importOpts(body);
    const storeId = req.storeId;
    mv2.validateImportOptions(u.info, storeId, opts);
    const token = mv2.optionsFingerprint(u.id, storeId, opts);
    if (String(body.preview_token || '') !== token) {
      throw new mv2.MigrationError('PREVIEW_REQUIRED', '請先以相同的分類與模式完成預覽，再執行匯入', 409);
    }
    if (opts.mode === 'replace') {
      if (String(body.confirm_text || '').trim() !== storeId) throw new mv2.MigrationError('REPLACE_CONFIRM_REQUIRED', `完整取代需輸入目前店家代碼「${storeId}」確認`, 400);
      if (!verifyStorePassword(db, storeId, body.password)) throw new mv2.MigrationError('REPLACE_PASSWORD_INVALID', '店家登入密碼驗證失敗，未執行完整取代', 403);
    }
    // 先做同步驗證（分類、跨店、模式），錯誤立即回應
    const job = { id: newId(), storeId, kind: 'import', status: 'queued', createdAt: Date.now() };
    enqueue(job, async () => {
      // sql.js 模組先非同步載入；之後「快照 → 清除 → 匯入」全部同步執行，
      // 中間不讓出 event loop，確保快照與取代之間沒有其他請求寫入。
      const SQL = opts.mode === 'replace' ? await getSql() : null;
      let snapshot = null;
      if (opts.mode === 'replace') snapshot = safetySnapshot(SQL, getDb(), storeId, u.info.categories_present);
      let payload = readUploadPayload(u);
      const t0 = Date.now();
      let r;
      try {
        r = mv2.executeImport(getDb(), storeId, payload, u.info, { ...opts, dryRun: false });
      } catch (e) {
        writeMigrationLog(getDb(), storeId, 'V2 匯入失敗（已回滾）', u.fileName, opts.mode, { categories: opts.categories, code: e.code }, 'failed', e.message);
        throw e;
      } finally { payload = null; }
      writeMigrationLog(getDb(), storeId, 'V2 匯入', u.fileName, opts.mode,
        { categories: r.categories, totals: r.totals, source_store_id: r.source_store_id, snapshot: snapshot && snapshot.file_name }, r.status, '');
      return { ...r, elapsed_ms: Date.now() - t0, safety_snapshot: snapshot, backup: u.info };
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status });
  } catch (e) { sendErr(res, e); }
});

router.get('/jobs/:id', (req, res) => {
  const j = jobs.get(String(req.params.id));
  res.set('Cache-Control', 'no-store');
  if (!j || j.storeId !== req.storeId) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND', message: '找不到工作' });
  res.json({ success: true, job: { id: j.id, kind: j.kind, status: j.status, created_at: j.createdAt, started_at: j.startedAt || null,
    finished_at: j.finishedAt || null, result: j.status === 'done' ? j.result : null, error: j.status === 'error' ? j.error : null } });
});

router._internals = { uploads, jobs, cleanup, storageStatus, UPLOAD_DIR };
module.exports = router;
