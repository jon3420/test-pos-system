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
