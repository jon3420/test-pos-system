// scripts/lib/qa-temp-db.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// Geo Event Taiwan Time & Estimate Marker Verification Hotfix
//
// 完全隔離的 QA Temp DB 建立工具（需求文件八）。
//
// 安全規則（不得違反）：
//   1. 只使用 os.tmpdir() 底下的檔案（或純記憶體 sql.js Database）。
//   2. 絕不 require('../../utils/db.js')／絕不寫入 data/pos.db
//      （utils/db.js 的 DB_PATH 是 module-level 常數，無法安全參數化，
//      本工具刻意完全不 require 它，避免不小心共用同一個 sql.js 實例）。
//   3. createTempQaDb() 在建立前會檢查目的路徑，若指向專案內
//      data/pos.db 或任何 *.db／*.sqlite 落在專案 data/ 目錄，立即拒絕
//      （fail loud，throw，不得靜默改用別的路徑）。
//   4. 只建立 QA 驗證真的需要的兩個資料表（geo_visit_log／
//      geo_live_coordinates），DDL 逐字對照 utils/db.js，避免 Schema
//      Drift；不建立/依賴其餘 60+ 張正式資料表。
//   5. cleanup() 刪除 temp 檔案本體。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const FORBIDDEN_PATH_FRAGMENTS = [
  path.join('data', 'pos.db'),
  path.normalize('data/pos.db'),
];

function assertPathIsSafe(p) {
  const normalized = path.resolve(p);
  for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
    if (normalized.includes(frag)) {
      throw new Error(`[qa-temp-db] 拒絕：路徑指向正式資料庫 (${normalized})`);
    }
  }
  const tmpRoot = path.resolve(os.tmpdir());
  // 這裡刻意要求「直接位於 os.tmpdir() 底下」（dirname === tmpRoot），
  // 不是寬鬆的字串開頭比對（startsWith）。理由：若專案本身被部署／解壓在
  // /tmp 底下（例如 CI 的乾淨解壓驗證常見路徑 /tmp/xxx-clean/...），
  // 寬鬆比對會誤判「專案原始碼目錄裡的任何路徑」都合法，因為它們也是以
  // os.tmpdir() 字串開頭——但那些路徑其實是專案原始碼樹的一部分，不是我們
  // 自己產生的 temp DB 檔案。真正由 createTempQaDb() 產生的檔案一律是
  // `path.join(os.tmpdir(), 'qa-geo-store-<random>.sqlite')`，dirname 必然
  // 就是 os.tmpdir() 本身，不會有巢狀子目錄。
  if (path.dirname(normalized) !== tmpRoot) {
    throw new Error(`[qa-temp-db] 拒絕：QA 溫度 DB 必須直接位於 os.tmpdir() 底下，得到 ${normalized}`);
  }
}

// 逐字對照 utils/db.js 的 geo_visit_log／geo_live_coordinates DDL
// （見 R5.4-G1.6-A1.2.1_TIMEZONE_REALITY_AUDIT.md 附錄）。
const DDL_GEO_VISIT_LOG = `CREATE TABLE IF NOT EXISTS geo_visit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT NOT NULL,
  visitor_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  event_name  TEXT NOT NULL,
  event_time  TEXT NOT NULL DEFAULT (datetime('now')),
  lat         REAL,
  lng         REAL,
  city        TEXT,
  district    TEXT,
  country     TEXT,
  source      TEXT NOT NULL DEFAULT 'unknown',
  is_unknown  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  order_id TEXT,
  source_event_id INTEGER,
  postal_code TEXT,
  channel TEXT,
  device_type TEXT
)`;

const DDL_GEO_LIVE_COORDINATES = `CREATE TABLE IF NOT EXISTS geo_live_coordinates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     TEXT NOT NULL,
  visitor_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  accuracy_m   REAL,
  source       TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT DEFAULT (datetime('now'))
)`;

const DDL_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_time ON geo_visit_log(store_id, event_time)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_event_time ON geo_visit_log(store_id, event_name, event_time)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_session ON geo_visit_log(store_id, session_id)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_visitor ON geo_visit_log(store_id, visitor_id)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_order ON geo_visit_log(store_id, order_id)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_postal ON geo_visit_log(store_id, postal_code)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_channel ON geo_visit_log(store_id, channel)',
  'CREATE INDEX IF NOT EXISTS idx_geo_visit_log_store_device ON geo_visit_log(store_id, device_type)',
  'CREATE INDEX IF NOT EXISTS idx_geo_live_coord_store_visitor ON geo_live_coordinates(store_id, visitor_id, captured_at)',
  'CREATE INDEX IF NOT EXISTS idx_geo_live_coord_store_session ON geo_live_coordinates(store_id, session_id, captured_at)',
  'CREATE INDEX IF NOT EXISTS idx_geo_live_coord_store_time ON geo_live_coordinates(store_id, captured_at)',
];

// wrap()：跟 utils/db.js 的 get/all/run 介面形狀一致，讓 utils/geoVisitLog.js
// 等模組的既有函式（接受 `db` 參數，呼叫 db.all()/db.run()）可以直接重用，
// 不需要修改任何一行正式邏輯程式碼。跟 utils/db.js 不同的地方只有：
// 這裡「save」是寫回本檔案自己的 temp 檔案路徑，不是 data/pos.db。
function wrapSqlJsDb(sqlDb, tempFilePath) {
  const save = () => {
    if (!tempFilePath) return; // 純記憶體模式：不落地
    fs.writeFileSync(tempFilePath, Buffer.from(sqlDb.export()));
  };
  return {
    _db: sqlDb, _save: save, _tempFilePath: tempFilePath,
    get(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const result = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return result;
    },
    all(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    run(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.run(Array.isArray(params) ? params : [params]);
      const changes = sqlDb.getRowsModified ? sqlDb.getRowsModified() : 0;
      stmt.free();
      const r = sqlDb.exec('SELECT last_insert_rowid() as id');
      save();
      return { lastInsertRowid: r[0]?.values[0][0] ?? null, changes };
    },
  };
}

// createTempQaDb({ persist }) → { db, tempFilePath, cleanup() }
//   persist=false（預設）：純記憶體，連 os.tmpdir() 都不落地檔案，最安全。
//   persist=true：落地到 os.tmpdir() 底下一個隨機檔名，供 Manual Browser QA
//   Harness 需要「重新啟動的 HTTP Server 讀同一份資料」時使用。
async function createTempQaDb(options) {
  const opts = options || {};
  let tempFilePath = null;
  if (opts.persist) {
    tempFilePath = path.join(os.tmpdir(), `qa-geo-store-${crypto.randomBytes(8).toString('hex')}.sqlite`);
    assertPathIsSafe(tempFilePath);
  }

  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database(); // 永遠是全新、空白的 DB，絕不讀取任何既有檔案
  const db = wrapSqlJsDb(sqlDb, tempFilePath);

  db._db.run(DDL_GEO_VISIT_LOG);
  db._db.run(DDL_GEO_LIVE_COORDINATES);
  DDL_INDEXES.forEach((sql) => db._db.run(sql));
  db._save();

  function cleanup() {
    try { sqlDb.close(); } catch (e) { /* noop */ }
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }

  return { db, tempFilePath, cleanup };
}

module.exports = { createTempQaDb, assertPathIsSafe };

// ════════════════════════════════════════════════════════════════════════
// Stage 3A additions (H1.4.8 destructive-script remediation) — ADDITIVE ONLY.
// Nothing above this line was changed; both existing consumers
// (scripts/run-g1-6-a1-2-1-manual-qa.js,
//  scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js) keep
// using createTempQaDb()/assertPathIsSafe() exactly as before.
//
// The functions below are for a DIFFERENT use case: run-regression-*.js
// orchestrators and their execFileSync'd children need a REAL, full-schema
// (60+ table) SQLite file at a temp path so that utils/db.js's own
// initDb()/initTables() can populate it normally -- createTempQaDb() above
// deliberately only creates 2 geo-specific tables and is not a fit here.
// These helpers manage the temp *path* and process *env*, never touch
// utils/db.js themselves, and never read/write data/pos.db.
// ════════════════════════════════════════════════════════════════════════

const REAL_DB_PATH = path.join(__dirname, '..', '..', 'data', 'pos.db');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Broad, deliberately-forbidden roots: cleanup/delete operations must never be
// allowed to target any of these, even indirectly.
function assertNotBroadPath(resolved) {
  const forbidden = [
    path.resolve(REPO_ROOT),
    path.resolve(REPO_ROOT, 'data'),
    path.resolve(os.tmpdir()), // the bare tmpdir root itself, not a subdirectory of it
    path.resolve(os.homedir()),
    '/', '/tmp', '/home', '/root', '/usr', '/etc', '/var',
  ];
  if (forbidden.includes(resolved)) {
    throw new Error(`[qa-temp-db] REFUSED: path resolves to a forbidden broad directory (${resolved})`);
  }
  if (!resolved || resolved.trim() === '' || !path.isAbsolute(resolved)) {
    throw new Error(`[qa-temp-db] REFUSED: empty, relative, or unresolved path (${JSON.stringify(resolved)})`);
  }
}

// Verify a real-DB realpath (or its intended resolved path if it doesn't exist
// yet) never equals a candidate path -- used before any delete/cleanup.
function assertNotRealDb(resolved) {
  const resolvedRealDb = fs.existsSync(REAL_DB_PATH) ? fs.realpathSync(REAL_DB_PATH) : path.resolve(REAL_DB_PATH);
  if (resolved === resolvedRealDb) {
    throw new Error(`[qa-temp-db] REFUSED: path equals the real data/pos.db (${resolved})`);
  }
}

// createOrchestratorTempRoot(label) -> { tmpRoot, cleanupRoot }
// mkdtemp-based unique directory for ONE orchestrator invocation. Every
// child DB path must live inside this directory so a single cleanup call
// can safely remove everything from this run and nothing else.
function createOrchestratorTempRoot(label) {
  const prefix = path.join(os.tmpdir(), `h148-${(label || 'orch').replace(/[^a-zA-Z0-9_-]/g, '_')}-`);
  const tmpRoot = fs.mkdtempSync(prefix);
  const resolvedTmpRoot = fs.realpathSync(tmpRoot);
  assertNotBroadPath(resolvedTmpRoot);
  assertNotRealDb(resolvedTmpRoot);
  if (path.dirname(resolvedTmpRoot) !== path.resolve(os.tmpdir())) {
    throw new Error(`[qa-temp-db] REFUSED: mkdtemp result is not a direct child of os.tmpdir() (${resolvedTmpRoot})`);
  }

  function cleanupRoot() {
    // Fail-fast re-verification immediately before every delete, not just at
    // creation time -- protects against the variable being mutated/reassigned
    // elsewhere before cleanup runs.
    const reResolved = fs.existsSync(tmpRoot) ? fs.realpathSync(tmpRoot) : resolvedTmpRoot;
    assertNotBroadPath(reResolved);
    assertNotRealDb(reResolved);
    if (path.dirname(reResolved) !== path.resolve(os.tmpdir())) {
      throw new Error(`[qa-temp-db] REFUSED cleanup: path drifted outside a direct os.tmpdir() child (${reResolved})`);
    }
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  return { tmpRoot: resolvedTmpRoot, cleanupRoot };
}

// createChildDbPath(tmpRoot, childLabel) -> verified absolute path for one
// child's SQLite file, guaranteed to live inside tmpRoot.
function createChildDbPath(tmpRoot, childLabel) {
  const resolvedTmpRoot = fs.realpathSync(tmpRoot);
  assertNotBroadPath(resolvedTmpRoot);
  const safeLabel = (childLabel || 'child').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dbPath = path.join(resolvedTmpRoot, `${safeLabel}-${crypto.randomBytes(6).toString('hex')}.db`);
  const resolvedDbPath = path.resolve(dbPath);
  if (path.dirname(resolvedDbPath) !== resolvedTmpRoot) {
    throw new Error(`[qa-temp-db] REFUSED: child DB path escapes its own tmpRoot (${resolvedDbPath} not under ${resolvedTmpRoot})`);
  }
  assertNotRealDb(resolvedDbPath);
  return resolvedDbPath;
}

// buildChildEnv(dbPath) -> env object for execFileSync/spawn, guaranteed to
// carry a verified, non-real POS_DB_PATH plus the rest of the current env.
// buildChildEnv(dbPath, tmpRoot) -> env object for execFileSync/spawn,
// carries BOTH POS_DB_PATH and POS_DB_TEMP_ROOT (the root-marker required
// for the child/grandchild to prove containment before trusting the path).
function buildChildEnv(dbPath, tmpRoot, extraEnv) {
  const resolved = path.resolve(dbPath);
  assertNotRealDb(resolved);
  assertNotBroadPath(path.dirname(resolved));
  if (!tmpRoot) {
    throw new Error('[qa-temp-db] buildChildEnv REFUSED: tmpRoot is required (second argument) so POS_DB_TEMP_ROOT can be passed to the child for containment verification.');
  }
  const rootResolved = path.resolve(tmpRoot);
  assertNotBroadPath(rootResolved);
  return { ...process.env, ...(extraEnv || {}), POS_DB_PATH: resolved, POS_DB_TEMP_ROOT: rootResolved };
}

function cleanupDbFileAndSidecars(dbPath) {
  const resolved = path.resolve(dbPath);
  assertNotBroadPath(path.dirname(resolved));
  assertNotRealDb(resolved);
  [resolved, `${resolved}-wal`, `${resolved}-shm`, `${resolved}-journal`].forEach((p) => {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* best-effort; directory-level cleanupRoot() is the backstop */ }
  });
}

// ════════════════════════════════════════════════════════════════════════
// Stage 3A ownership contract (this turn's addition) — a single shared
// bootstrap children call instead of each duplicating standalone-vs-parent
// detection logic. Two env vars, both-or-neither:
//   POS_DB_PATH       - the DB file path
//   POS_DB_TEMP_ROOT  - the temp root the DB path must be contained within
//
// - Neither present  -> standalone: create our own mkdtemp root + DB path,
//                        set both env vars, caller owns cleanup.
// - Both present     -> parent-invoked: validate real containment (root
//                        under os.tmpdir(), db path's real parent dir
//                        actually inside the root via path.relative, not
//                        just a string-prefix match -- this blocks the
//                        "/tmp/h148-abc" vs "/tmp/h148-abc-evil" sibling-
//                        prefix trick), never delete anything.
// - Exactly one       -> fail closed (throw), never silently fall back to
//                        standalone or to the real DB.
// ════════════════════════════════════════════════════════════════════════
const POS_DB_TEMP_ROOT_ENV = 'POS_DB_TEMP_ROOT';

function validateParentProvidedDb(dbPathRaw, tempRootRaw) {
  if (!dbPathRaw || !tempRootRaw || typeof dbPathRaw !== 'string' || typeof tempRootRaw !== 'string') {
    throw new Error('[qa-temp-db] REFUSED: POS_DB_PATH / POS_DB_TEMP_ROOT must be non-empty strings.');
  }
  const tmpRootResolved = path.resolve(tempRootRaw);
  if (!fs.existsSync(tmpRootResolved)) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_TEMP_ROOT does not exist (${tmpRootResolved})`);
  }
  const rootReal = fs.realpathSync(tmpRootResolved);
  assertNotBroadPath(rootReal);
  assertNotRealDb(rootReal);
  const osTmpReal = fs.realpathSync(os.tmpdir());
  const relRootToTmp = path.relative(osTmpReal, rootReal);
  if (relRootToTmp === '' || relRootToTmp.startsWith('..') || path.isAbsolute(relRootToTmp)) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_TEMP_ROOT is not a real subdirectory of os.tmpdir() (${rootReal})`);
  }

  const dbPathResolved = path.resolve(dbPathRaw);
  assertNotRealDb(dbPathResolved);
  if (dbPathResolved === rootReal) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_PATH equals POS_DB_TEMP_ROOT itself (${dbPathResolved})`);
  }
  const dbParent = path.dirname(dbPathResolved);
  if (!fs.existsSync(dbParent)) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_PATH's parent directory does not exist (${dbParent}) -- cannot verify containment.`);
  }
  const dbParentReal = fs.realpathSync(dbParent);
  // path.relative-based check (NOT string prefix) -- this is what actually
  // blocks the sibling-prefix escape: root=/tmp/h148-abc,
  // db=/tmp/h148-abc-evil/pos.db -> path.relative gives '../h148-abc-evil',
  // which starts with '..' and is correctly rejected below. A naive
  // `dbParentReal.startsWith(rootReal)` string check would NOT catch this.
  const relDbToRoot = path.relative(rootReal, dbParentReal);
  const escapes = path.isAbsolute(relDbToRoot) || relDbToRoot === '..' || relDbToRoot.startsWith('..' + path.sep);
  if (escapes) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_PATH is outside POS_DB_TEMP_ROOT (db parent real=${dbParentReal}, root real=${rootReal}, relative=${relDbToRoot})`);
  }
  return { dbPath: dbPathResolved, tmpRoot: rootReal };
}

// bootstrapChildDb(label, _deps) -- the optional second parameter is a
// TEST-ONLY dependency-injection seam (createChildDbPath override) used to
// deterministically prove bootstrapChildDb()'s own internal rollback when a
// failure happens *between* root creation and DB-path creation. Real
// callers (all 9 Batch C children, all 17 orchestrators) call
// bootstrapChildDb(label) with exactly one argument, so _deps is always
// undefined for them and behavior is byte-identical to before. This is not
// an env var or a persistent fault flag -- it cannot be triggered
// accidentally by any real caller, only by a test that explicitly passes it.
function bootstrapChildDb(label, _deps) {
  const createChildDbPathFn = (_deps && _deps.createChildDbPath) || createChildDbPath;
  const hasDbPath = typeof process.env.POS_DB_PATH === 'string' && process.env.POS_DB_PATH.length > 0;
  const hasTempRoot = typeof process.env[POS_DB_TEMP_ROOT_ENV] === 'string' && process.env[POS_DB_TEMP_ROOT_ENV].length > 0;

  if (hasDbPath && hasTempRoot) {
    const { dbPath, tmpRoot } = validateParentProvidedDb(process.env.POS_DB_PATH, process.env[POS_DB_TEMP_ROOT_ENV]);
    return { dbPath, tmpRoot, ownsTempRoot: false, cleanup: () => {} };
  }
  if (hasDbPath !== hasTempRoot) {
    throw new Error(`[qa-temp-db] REFUSED: POS_DB_PATH and POS_DB_TEMP_ROOT must both be set or both be absent (POS_DB_PATH present=${hasDbPath}, POS_DB_TEMP_ROOT present=${hasTempRoot}). Refusing to silently fall back to standalone or to the real DB.`);
  }

  // standalone mode: neither env var present
  const { tmpRoot, cleanupRoot } = createOrchestratorTempRoot(label || 'standalone');
  let dbPath;
  try {
    dbPath = createChildDbPathFn(tmpRoot, label || 'standalone');
  } catch (e) {
    // Requirement: if anything after root creation fails during bootstrap
    // itself, the caller's try/finally cannot know about it yet (the
    // context hasn't been returned/assigned). bootstrapChildDb() must clean
    // up its own partial state before propagating the error, so a failure
    // here can never leak the freshly-created standalone root.
    cleanupRoot();
    throw e;
  }
  try {
    process.env.POS_DB_PATH = dbPath;
    process.env[POS_DB_TEMP_ROOT_ENV] = tmpRoot;
  } catch (e) {
    cleanupDbFileAndSidecars(dbPath);
    cleanupRoot();
    throw e;
  }
  return {
    dbPath,
    tmpRoot,
    ownsTempRoot: true,
    cleanup: () => {
      cleanupDbFileAndSidecars(dbPath);
      cleanupRoot();
      delete process.env.POS_DB_PATH;
      delete process.env[POS_DB_TEMP_ROOT_ENV];
    },
  };
}

module.exports.bootstrapChildDb = bootstrapChildDb;
module.exports.validateParentProvidedDb = validateParentProvidedDb;
module.exports.POS_DB_TEMP_ROOT_ENV = POS_DB_TEMP_ROOT_ENV;

module.exports.createOrchestratorTempRoot = createOrchestratorTempRoot;
module.exports.createChildDbPath = createChildDbPath;
module.exports.buildChildEnv = buildChildEnv;
module.exports.cleanupDbFileAndSidecars = cleanupDbFileAndSidecars;
module.exports.assertNotRealDb = assertNotRealDb;
module.exports.assertNotBroadPath = assertNotBroadPath;

// ════════════════════════════════════════════════════════════════════════
// Stage 3A cleanup-error policy (this turn's addition) — a single shared
// implementation instead of each child duplicating (and inconsistently
// getting wrong) its own catch/log/never-rethrow logic.
//
// Truth table:
//   primary=none, cleanup=none    -> success, nothing thrown
//   primary=none, cleanup=fails   -> cleanup error IS thrown (failure)
//   primary=some, cleanup=none    -> primary preserved, rethrown as-is
//   primary=some, cleanup=fails   -> primary preserved and rethrown;
//                                    cleanup error attached as a
//                                    non-throwing secondary diagnostic
//                                    (primaryError.secondaryCleanupErrors),
//                                    never overrides/replaces primary.
// ════════════════════════════════════════════════════════════════════════

// attachSecondaryDiagnostics(primaryError, cleanupErrors) -- safely attaches
// cleanup errors to a primary error's .secondaryCleanupErrors property
// WITHOUT ever throwing itself and WITHOUT changing the primary error's
// identity/reference. A primitive thrown value (string/number/etc.), a
// frozen Error, or a non-extensible object cannot have a new property
// added (strict-mode assignment throws; even non-strict silently no-ops
// for frozen objects, but Object.isExtensible lets us detect and avoid the
// attempt entirely rather than relying on silent failure). In any of those
// cases, the secondary diagnostics are logged instead of attached, and the
// original thrown value is always returned unchanged by the caller.
function attachSecondaryDiagnostics(primaryError, cleanupErrors) {
  const canAttach = primaryError !== null
    && (typeof primaryError === 'object' || typeof primaryError === 'function')
    && Object.isExtensible(primaryError);
  if (canAttach) {
    try {
      primaryError.secondaryCleanupErrors = (primaryError.secondaryCleanupErrors || []).concat(cleanupErrors);
    } catch (e) {
      // Extremely defensive: some exotic object could still reject the
      // assignment (e.g. a Proxy with a throwing set trap). Never let that
      // propagate and mask the primary error -- just fall through to the
      // log-only path below.
      cleanupErrors.forEach((ce) => console.error(`[CLEANUP-ERROR] secondary (could not attach to primary, step="${ce.cleanupStepName}"):`, ce.message || ce));
      return;
    }
  }
  cleanupErrors.forEach((e) => {
    console.error(`[CLEANUP-ERROR] secondary (primary error preserved${canAttach ? '' : ', NOT attachable -- primary was primitive/frozen/non-extensible, logged only'}, step="${e.cleanupStepName}"):`, e.message || e);
  });
}

function buildCombinedCleanupError(cleanupErrors) {
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  if (typeof AggregateError !== 'undefined') {
    return new AggregateError(cleanupErrors, `${cleanupErrors.length} cleanup steps failed (no primary error): ${cleanupErrors.map((e) => e.cleanupStepName).join(', ')}`);
  }
  const combined = new Error(`${cleanupErrors.length} cleanup steps failed (no primary error): ${cleanupErrors.map((e) => `${e.cleanupStepName}: ${e.message}`).join('; ')}`);
  combined.allCleanupErrors = cleanupErrors;
  return combined;
}

// runCleanupSteps(steps, primaryError) -- SYNCHRONOUS. steps: array of
// {name, fn}. Runs every step (collecting failures instead of stopping at
// the first one, so e.g. a DB-handle-close failure doesn't prevent a
// subsequent root cleanup from running), then applies the truth table
// above. Does not access or log step return values / any DB content --
// only step names and error messages, so it cannot leak visitor/DB data
// into diagnostics.
//
// Fail-fast on thenables: if a step's fn() returns a Promise/thenable, that
// means the step is actually asynchronous and this sync helper cannot
// correctly wait for it -- silently ignoring the pending promise would let
// the step's real outcome (including a possible rejection) go unobserved,
// which would look like success when it might not be. Use
// runCleanupStepsAsync()/handleOwnedCleanupAsync() for any step that
// returns a Promise.
function runCleanupSteps(steps, primaryError) {
  const cleanupErrors = [];
  (steps || []).forEach(({ name, fn }) => {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        // Attach a no-op rejection handler to the orphaned thenable BEFORE
        // throwing our own fail-closed error. Without this, if the
        // returned promise later rejects, Node would report it as an
        // unhandledRejection (a separate, confusing failure mode) even
        // though we're correctly already failing this step for the
        // misuse itself. This does not change the outcome (the step is
        // still marked as a cleanup error either way) -- it only prevents
        // a second, spurious process-level warning/crash.
        result.then(() => {}, () => {});
        throw new Error(`[qa-temp-db] runCleanupSteps REFUSED: step "${name}" returned a thenable/Promise -- use runCleanupStepsAsync() for asynchronous cleanup steps instead of the synchronous helper (which cannot safely wait for it).`);
      }
    } catch (e) {
      e.cleanupStepName = e.cleanupStepName || name;
      cleanupErrors.push(e);
    }
  });

  if (cleanupErrors.length === 0) return;

  if (primaryError) {
    attachSecondaryDiagnostics(primaryError, cleanupErrors);
    return;
  }

  throw buildCombinedCleanupError(cleanupErrors);
}

// runCleanupStepsAsync(steps, primaryError) -- ASYNC equivalent. steps:
// array of {name, fn} where fn may be sync or return a Promise; each step
// is awaited in order (sequential, not Promise.all, so step ordering/side
// effects stay predictable -- e.g. "await server close" before "close DB
// handle"). A rejecting step does not stop subsequent steps from running.
// Same truth table and same safe-attachment logic as the sync version.
// Never produces an unhandled rejection: this function itself is the only
// thing awaiting each step's promise, and every step's rejection is caught
// locally.
async function runCleanupStepsAsync(steps, primaryError) {
  const cleanupErrors = [];
  for (const { name, fn } of (steps || [])) {
    try {
      await fn(); // await on a non-promise value is a no-op, so sync fn() is fine too
    } catch (e) {
      e.cleanupStepName = e.cleanupStepName || name;
      cleanupErrors.push(e);
    }
  }

  if (cleanupErrors.length === 0) return;

  if (primaryError) {
    attachSecondaryDiagnostics(primaryError, cleanupErrors);
    return;
  }

  throw buildCombinedCleanupError(cleanupErrors);
}

// handleOwnedCleanup(dbContext, primaryError) -- convenience wrapper for
// the common single-step SYNCHRONOUS case (just dbContext.cleanup()).
// Non-owners (ownsTempRoot === false, i.e. parent-invoked) are a no-op:
// nothing is ever deleted for a path this script doesn't own.
function handleOwnedCleanup(dbContext, primaryError) {
  if (!dbContext || !dbContext.ownsTempRoot) return;
  runCleanupSteps([{ name: 'dbContext.cleanup', fn: () => dbContext.cleanup() }], primaryError);
}

// handleOwnedCleanupAsync(dbContext, primaryError) -- async equivalent, for
// children whose dbContext.cleanup() (or an additional async step) returns
// a Promise (e.g. an HTTP server's `await server.close()`-based cleanup).
async function handleOwnedCleanupAsync(dbContext, primaryError) {
  if (!dbContext || !dbContext.ownsTempRoot) return;
  await runCleanupStepsAsync([{ name: 'dbContext.cleanup', fn: () => dbContext.cleanup() }], primaryError);
}

module.exports.runCleanupSteps = runCleanupSteps;
module.exports.handleOwnedCleanup = handleOwnedCleanup;
module.exports.runCleanupStepsAsync = runCleanupStepsAsync;
module.exports.handleOwnedCleanupAsync = handleOwnedCleanupAsync;

// ════════════════════════════════════════════════════════════════════════
// closeHttpServerBounded(server, timeoutMs) -- shared, additive helper.
//
// State machine (module-local WeakMap<server, state>, keys don't prevent
// GC): three states -- 'pending' (in-flight), 'completed' (the ORIGINAL
// close promise genuinely resolved -- server is actually closed), or
// absent from the map (never touched by this helper, or a prior attempt
// FAILED and was cleared to allow retry).
//
//   - No entry + server.listening === false: never touched by this
//     helper, already not listening (external/never-started) -- safe
//     no-op, recorded as 'completed'.
//   - No entry + server.listening === true: start a fresh close attempt.
//   - Entry status 'pending': a close is already in-flight for this exact
//     server object -- return/await the SAME promise, never call
//     server.close() a second time.
//   - Entry status 'completed' + server.listening === false: genuinely
//     still closed -- safe no-op.
//   - Entry status 'completed' + server.listening === true: the server
//     was re-listen()'d since the last close (Node http.Server supports
//     listen -> close -> listen -> close again) -- this is a NEW
//     generation, the stale resolved promise is NOT reused; a fresh close
//     attempt starts (map entry replaced, not appended to).
//   - No entry because a PRIOR attempt's original close promise itself
//     REJECTED: that failure is never recorded as 'completed' (only a
//     genuinely successful original close is), and the map entry is
//     deleted specifically so the NEXT call retries with a real new
//     server.close() call rather than being stuck forever.
//
// Success/failure determination is based on the ORIGINAL close promise,
// not on closeAllConnections(): if the original close ultimately resolves
// (even after a timeout + force-close), the server IS closed and the
// state is marked 'completed' -- but if closeAllConnections() itself
// threw along the way, THAT specific error is still thrown to this call's
// caller (a real problem occurred even though the end state is "closed").
// If the original close promise itself rejects (with or without a timeout
// having occurred first), the attempt is NOT marked completed, and the
// map entry is removed so a future call can retry.
// ════════════════════════════════════════════════════════════════════════
const _closeStateByServer = new WeakMap();

async function closeHttpServerBounded(server, timeoutMs) {
  if (!server) return;

  const existing = _closeStateByServer.get(server);
  if (existing) {
    if (existing.status === 'pending') {
      return existing.promise;
    }
    // status === 'completed'
    if (server.listening !== true) {
      return; // genuinely still closed -- safe no-op
    }
    // re-listened since the last completed close -- fall through to start
    // a fresh generation instead of reusing the stale resolved promise.
  } else if (server.listening === false) {
    _closeStateByServer.set(server, { status: 'completed', promise: Promise.resolve() });
    return;
  }

  const state = { status: 'pending', promise: null };
  _closeStateByServer.set(server, state);

  const doClose = (async () => {
    let timedOut = false;
    let timeoutHandle;
    const closePromise = new Promise((resolve, reject) => {
      server.close((err) => { if (err) reject(err); else resolve(); });
    });
    const timeoutSignal = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
    });
    try {
      try {
        await Promise.race([closePromise, timeoutSignal]);
      } catch (raceRejection) {
        // The original close promise itself rejected before the timeout
        // fired -- a genuine close failure, not a timeout. Do not mark
        // completed; remove the entry so a later call retries with a real
        // new server.close() call instead of being permanently stuck.
        _closeStateByServer.delete(server);
        throw raceRejection;
      }

      if (timedOut) {
        let forceCloseError = null;
        try {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        } catch (e) {
          forceCloseError = e;
        }
        let closeSettleError = null;
        try {
          await closePromise;
        } catch (e) {
          closeSettleError = e;
        }

        if (closeSettleError) {
          // The original close itself ultimately failed even after the
          // force-close attempt -- not completed, allow retry.
          _closeStateByServer.delete(server);
          if (forceCloseError) {
            const combined = new Error(`[qa-temp-db] closeHttpServerBounded: closeAllConnections() failed AND the original server.close() promise also failed after timeout -- both preserved: [1] ${forceCloseError.message} ; [2] ${closeSettleError.message}`);
            combined.causes = [forceCloseError, closeSettleError];
            throw combined;
          }
          throw closeSettleError;
        }

        // Original close genuinely succeeded (possibly only after the
        // force-close nudged lingering connections shut) -- the server IS
        // closed, so mark completed regardless of forceCloseError. Still
        // throw forceCloseError to this call's caller if it occurred: a
        // real problem happened along the way even though the end state
        // is "closed".
        _closeStateByServer.set(server, { status: 'completed', promise: Promise.resolve() });
        if (forceCloseError) throw forceCloseError;
        return;
      }

      // Not timed out: closePromise resolved normally before the timer
      // fired (a rejection here would already have been caught above).
      _closeStateByServer.set(server, { status: 'completed', promise: Promise.resolve() });
    } finally {
      clearTimeout(timeoutHandle);
    }
  })();

  state.promise = doClose;
  await doClose;
}

module.exports.closeHttpServerBounded = closeHttpServerBounded;

// ════════════════════════════════════════════════════════════════════════
// parseRegressionCliArgs(args, { allowDryRun = false } = {}) -- shared,
// additive, strict CLI-argument parser for the 17 regression orchestrator
// roots (Stage 3C0 unified round-count contract). Replaces two prior,
// inconsistent patterns: 9 roots with a hardcoded `<= 3` loop and no CLI
// override at all, and 8 roots sharing a LOOSE expression
// (`Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3`) that
// silently defaulted 0/negative/non-numeric input to 3 and silently
// accepted fractional/unbounded values -- none of that is fail-closed.
//
// Contract (args is process.argv.slice(2)):
//   []              -> { mode: 'run', roundCount: 3 }
//   ['1']           -> { mode: 'run', roundCount: 1 }
//   ['2']           -> { mode: 'run', roundCount: 2 }
//   ['3']           -> { mode: 'run', roundCount: 3 }
//   ['--dry-run']   -> { mode: 'dry-run' }  ONLY if allowDryRun === true
// Every other input throws, including: '', ' ', '0', '-1', '1.5', '01',
// '+1', '1e0', 'abc', '4', huge integers, unknown flags, multiple args
// (['1','2']), dry-run combined with a round value in either order,
// '--dry-run' when allowDryRun is false, and non-array input. No trimming
// or coercion is applied -- only the exact strings '1', '2', '3', or
// (when allowed) '--dry-run' are accepted; anything else is rejected as-is.
// Error messages describe only the legal CLI shape, never any internal
// path/DB information.
// ════════════════════════════════════════════════════════════════════════
function parseRegressionCliArgs(args, opts) {
  const allowDryRun = !!(opts && opts.allowDryRun);
  const USAGE = allowDryRun
    ? 'usage: <script> [1|2|3] | --dry-run'
    : 'usage: <script> [1|2|3]';
  if (!Array.isArray(args)) {
    throw new Error(`[parseRegressionCliArgs] REFUSED: expected an array of CLI arguments. ${USAGE}`);
  }
  if (args.length === 0) {
    return { mode: 'run', roundCount: 3 };
  }
  if (args.length === 1 && args[0] === '--dry-run') {
    if (!allowDryRun) {
      throw new Error(`[parseRegressionCliArgs] REFUSED: --dry-run is not supported by this script. ${USAGE}`);
    }
    return { mode: 'dry-run' };
  }
  if (args.length === 1 && /^[123]$/.test(args[0])) {
    return { mode: 'run', roundCount: Number(args[0]) };
  }
  throw new Error(`[parseRegressionCliArgs] REFUSED: invalid CLI arguments. ${USAGE}`);
}

module.exports.parseRegressionCliArgs = parseRegressionCliArgs;
