// scripts/lib/mbv2-harness.js — R54.4-MBV2 測試共用工具
//
// 安全規則：所有測試一律使用 os.tmpdir() 底下的暫存資料庫（POS_DB_PATH），
// 絕不讀寫專案內的 data/pos.db，也不連線任何正式站。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_DB = path.join(ROOT, 'data', 'pos.db');

let passCount = 0, failCount = 0;
const results = [];
function pass(name, detail) { passCount++; results.push({ ok: true, name, detail }); console.log(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
function fail(name, detail) { failCount++; results.push({ ok: false, name, detail }); console.log(`  ❌ ${name}${detail ? '\n     ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name, detail) : fail(name, detail); return !!cond; }
function summary() { return { passCount, failCount, results }; }

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `mbv2-${tag}-`)); }
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function freePort() {
  return new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(dbPath, extraEnv = {}) {
  if (path.resolve(dbPath) === path.resolve(REAL_DB)) throw new Error('refuse to use real data/pos.db');
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), POS_DB_PATH: dbPath, MIGRATION_TMP_DIR: path.join(path.dirname(dbPath), 'uploads'), ...extraEnv };
  delete env.DB_PATH;
  if (extraEnv.DB_PATH) env.DB_PATH = extraEnv.DB_PATH;
  const proc = spawn(process.execPath, [...(extraEnv.__nodeArgs || []), 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; if (log.length > 400000) log = log.slice(-200000); });
  proc.stderr.on('data', d => { log += d; if (log.length > 400000) log = log.slice(-200000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {}
    if (proc.exitCode != null) throw new Error('server exited: ' + log.slice(-3000));
    await new Promise(r => setTimeout(r, 150));
  }
  return { proc, base, port, getLog: () => log, dbPath,
    stop: () => new Promise((resolve) => { if (proc.exitCode != null) return resolve(); proc.once('exit', () => resolve()); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 4000); }) };
}

async function login(base, storeId = 'store_001', password = storeId) {
  const r = await fetch(base + '/api/store-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: storeId, password }) });
  const j = await r.json();
  if (!j.success) throw new Error('login failed ' + JSON.stringify(j));
  return j.token;
}

async function api(base, token, method, p, body, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

async function download(base, token, p) {
  const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf, headers: r.headers };
}

// 以串流方式上傳檔案（或 Buffer），可指定是否送 Content-Length、可中途中斷
function uploadRaw(base, token, source, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(base + '/api/migration/v2/upload');
    const isFile = typeof source === 'string';
    const size = isFile ? fs.statSync(source).size : source.length;
    const headers = { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(opts.name || 'backup.json') };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.contentLength !== false) headers['Content-Length'] = String(size);
    else headers['Transfer-Encoding'] = 'chunked';
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (opts.abortAfterBytes) {
      const buf = isFile ? fs.readFileSync(source) : source;
      req.write(buf.subarray(0, opts.abortAfterBytes));
      setTimeout(() => { req.destroy(); resolve({ status: 0, aborted: true }); }, 300);
      return;
    }
    if (isFile) fs.createReadStream(source, { highWaterMark: 1 << 20 }).pipe(req);
    else req.end(source);
  });
}

async function waitJob(base, token, jobId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 輪詢是冪等的：大型匯入同步執行期間 keep-alive 連線可能被伺服器關閉，網路錯誤直接重試
    let r;
    try { r = await api(base, token, 'GET', `/api/migration/v2/jobs/${jobId}`); }
    catch (e) { await new Promise(res => setTimeout(res, 300)); continue; }
    if (r.json && r.json.job && (r.json.job.status === 'done' || r.json.job.status === 'error')) return r.json.job;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error('job timeout');
}

async function previewAndImport(base, token, uploadId, opts) {
  const pv = await api(base, token, 'POST', '/api/migration/v2/preview', { upload_id: uploadId, ...opts });
  if (pv.status !== 202) return { preview: null, previewResp: pv };
  const pj = await waitJob(base, token, pv.json.job_id);
  if (opts.previewOnly || pj.status !== 'done') return { preview: pj };
  const im = await api(base, token, 'POST', '/api/migration/v2/import', { upload_id: uploadId, ...opts, preview_token: pj.result.preview_token });
  if (im.status !== 202) return { preview: pj, importResp: im };
  const ij = await waitJob(base, token, im.json.job_id);
  return { preview: pj, import: ij };
}

// 直接以 sql.js 開啟資料庫檔（伺服器停止後用於種資料／核對）
let _SQL = null;
async function openDbFile(file) {
  if (!_SQL) _SQL = await require(path.join(ROOT, 'node_modules', 'sql.js'))();
  return new _SQL.Database(fs.readFileSync(file));
}
function q(db, sql, params) { const st = db.prepare(sql); if (params) st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; }
function q1(db, sql, params) { return q(db, sql, params)[0]; }
function saveDbFile(db, file) { fs.writeFileSync(file, Buffer.from(db.export())); }

// 讀取伺服器目前的 DB 檔（伺服器每次寫入都會原子替換檔案）
async function snapshotCounts(file, storeId, tables) {
  const db = await openDbFile(file);
  const out = {};
  for (const t of tables) {
    try { out[t] = q1(db, `SELECT COUNT(*) AS c FROM ${t} WHERE store_id=?`, [storeId]).c; } catch { out[t] = null; }
  }
  db.close();
  return out;
}

function peakRssKb(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); const m = s.match(/VmHWM:\s+(\d+)/); return m ? Number(m[1]) : null; } catch { return null; }
}
function rssKb(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); const m = s.match(/VmRSS:\s+(\d+)/); return m ? Number(m[1]) : null; } catch { return null; }
}

module.exports = { ROOT, REAL_DB, pass, fail, assert, summary, tmpDir, sha256File, sha, startServer, login, api, download, uploadRaw, waitJob,
  previewAndImport, openDbFile, q, q1, saveDbFile, snapshotCounts, peakRssKb, rssKb };
