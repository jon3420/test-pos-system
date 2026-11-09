// utils/migrationUploadLimit.js — fix18-10-hotfix29-C2 → R54.4-MBV2
//
// 「資料備份／搬家」匯入檔上傳大小上限，統一由此檔案計算，
// 避免同一個數字散落在多個檔案（server.js / routes/migration.js /
// routes/migration-v2.js / 前端 app.js）裡各自寫死。
//
// 規則（R54.4-MBV2 調整）：
//   - 環境變數 MIGRATION_UPLOAD_LIMIT_MB 可調整
//   - 預設 192MB（舊版 25MB）
//   - 最低 1MB（低於 1 視為無效設定）
//   - 最高硬性上限 256MB（舊版 100MB；無法透過環境變數繞過）
//   - 無效值（非數字、NaN）一律回退為預設 192MB
//   - 同一個上限同時套用在「上傳位元組數」與「gzip 解壓後位元組數」，
//     使用者選的檔案（不論是否壓縮）實際內容都不得超過這個數字。
//
// 僅影響「搬家匯入」相關路由，不影響全站其他 API 的 5MB body size 限制。

'use strict';

const DEFAULT_MB = 192;
const MIN_MB = 1;
const MAX_MB = 256;

function computeMigrationUploadLimitMb(rawEnvValue) {
  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return DEFAULT_MB;
  }
  return Math.max(MIN_MB, Math.min(parsed, MAX_MB));
}

const MIGRATION_UPLOAD_LIMIT_MB = computeMigrationUploadLimitMb(process.env.MIGRATION_UPLOAD_LIMIT_MB);
const MIGRATION_UPLOAD_LIMIT_BYTES = MIGRATION_UPLOAD_LIMIT_MB * 1024 * 1024;

// 舊版（R54.4 以前）以 express.json 解析的兩條路徑，加上 V2 的串流上傳路徑。
// V2 上傳路徑完全不經過任何 JSON body parser：body 以串流方式寫入暫存檔，
// 由 routes/migration-v2.js 自行計算位元組數並在超限時回 413。
const MIGRATION_IMPORT_PATHS = new Set([
  '/api/migration/import',
  '/api/migration/import/preview',
  '/api/migration/v2/upload',
]);

// 共用的路徑判斷：server.js 的「全域 parser 跳過」與「413/錯誤處理」都要用
// 同一份邏輯判斷是否為搬家匯入路徑。統一用 originalUrl（去掉 query string）
// 判斷，不用 req.path（掛在子路由底下時只會是相對路徑）。
function isMigrationImportPath(req) {
  const rawPath = String((req && (req.originalUrl || req.url || req.path)) || '');
  const pathOnly = rawPath.split('?')[0];
  return MIGRATION_IMPORT_PATHS.has(pathOnly);
}

module.exports = {
  DEFAULT_MIGRATION_UPLOAD_LIMIT_MB: DEFAULT_MB,
  MIN_MIGRATION_UPLOAD_LIMIT_MB: MIN_MB,
  MAX_MIGRATION_UPLOAD_LIMIT_MB: MAX_MB,
  MIGRATION_UPLOAD_LIMIT_MB,
  MIGRATION_UPLOAD_LIMIT_BYTES,
  computeMigrationUploadLimitMb, // exported for tests
  isMigrationImportPath, // exported for tests
  MIGRATION_IMPORT_PATHS,
};
