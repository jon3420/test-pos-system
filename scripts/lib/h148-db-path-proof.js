'use strict';
// scripts/lib/h148-db-path-proof.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// 小型共用 helper，供 H1.4.8 系列 isolated child 使用，統一產生
// DB_PATH_PROOF 斷言（temp realpath != 正式 data/pos.db realpath；temp
// realpath 位於呼叫端自己的 tmpDir 底下）。不是 production module，只給
// 測試 child 使用；不影響、不修改任何 production 檔案。
const path = require('path');
const fs = require('fs');

function dbPathProof(tmpDbPath, tmpDir) {
  const REAL_DB_PATH = path.join(__dirname, '..', '..', 'data', 'pos.db');
  const resolvedTmpDbPath = path.resolve(tmpDbPath);
  const resolvedRealDbPath = fs.existsSync(REAL_DB_PATH) ? fs.realpathSync(REAL_DB_PATH) : path.resolve(REAL_DB_PATH);
  const resolvedTmpDir = fs.realpathSync(tmpDir);
  return {
    tmpNotEqualReal: resolvedTmpDbPath !== resolvedRealDbPath,
    tmpUnderOwnTmpDir: resolvedTmpDbPath.startsWith(resolvedTmpDir),
    resolvedTmpDbPath,
    resolvedRealDbPath,
    resolvedTmpDir,
  };
}

module.exports = { dbPathProof };
