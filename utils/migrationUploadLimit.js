// utils/migrationUploadLimit.js — fix18-10-hotfix29-C2
//
// 「資料備份／搬家」匯入 JSON 上傳大小上限，統一由此檔案計算，
// 避免同一個數字（25MB）散落在多個檔案（server.js / routes/migration.js /
// 前端 app.js）裡各自寫死、之後改一個地方忘了改別的地方。
//
// 規則：
//   - 環境變數 MIGRATION_UPLOAD_LIMIT_MB 可調整
//   - 預設 25MB
//   - 最低 1MB（低於 1 視為無效設定）
//   - 最高硬性上限 100MB（無法透過環境變數繞過）
//   - 無效值（非數字、NaN）一律回退為預設 25MB
//
// 僅影響「搬家匯入」相關路由，不影響全站其他 API 的 body size 限制。

'use strict';

const DEFAULT_MB = 25;
const MIN_MB = 1;
const MAX_MB = 100;

function computeMigrationUploadLimitMb(rawEnvValue) {
  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return DEFAULT_MB;
  }
  return Math.max(MIN_MB, Math.min(parsed, MAX_MB));
}

const MIGRATION_UPLOAD_LIMIT_MB = computeMigrationUploadLimitMb(process.env.MIGRATION_UPLOAD_LIMIT_MB);
const MIGRATION_UPLOAD_LIMIT_BYTES = MIGRATION_UPLOAD_LIMIT_MB * 1024 * 1024;

const MIGRATION_IMPORT_PATHS = new Set([
  '/api/migration/import',
  '/api/migration/import/preview',
]);

// 共用的路徑判斷：server.js 的「全域 parser 跳過」與「413/錯誤處理」都要用
// 同一份邏輯判斷是否為搬家匯入路徑，避免兩處各寫一次、之後改一個忘了改
// 另一個。統一用 originalUrl（去掉 query string）判斷，不用 req.path，
// 因為 req.path 在掛載於子路由（router）底下時只會是「相對於掛載點」的
// 路徑，容易因為 mount 位置改變而判斷失效；originalUrl 從外部視角看永遠
// 是完整路徑，不受 router mount 影響。
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
