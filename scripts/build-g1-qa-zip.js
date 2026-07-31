#!/usr/bin/env node
// scripts/build-g1-qa-zip.js — fix18-10-hotfix30-B5-R5.4-G1
// 打包 fix18-10-hotfix30-B5-R5.4-G1-QA-full.zip。
// 排除：node_modules、.git、data/pos.db、測試暫存 DB、log、cache、coverage、
// 一次性診斷腳本、系統絕對路徑產物。

'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT_NAME = 'fix18-10-hotfix30-B5-R5.4-G1-QA-full.zip';
const OUT_DIR = '/mnt/user-data/outputs';
const OUT_PATH = path.join(OUT_DIR, OUT_NAME);

// zip 的排除清單一律用相對於專案根目錄的 glob pattern。
const EXCLUDES = [
  'node_modules/*', 'node_modules',
  '.git/*', '.git',
  'data/pos.db',
  'data/*.db-journal',
  '*.db-journal',
  'npm-debug.log*', '*.log',
  '.cache/*', 'coverage/*',
  '*.tmp',
];

function main() {
  if (fs.existsSync(path.join(ROOT, 'data', 'pos.db'))) {
    fs.unlinkSync(path.join(ROOT, 'data', 'pos.db'));
    console.log('[build-zip] 已移除 data/pos.db（測試暫存 DB，不進 ZIP）');
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT_PATH)) fs.unlinkSync(OUT_PATH);

  const args = ['-r', OUT_PATH, '.', '-x'].concat(EXCLUDES);
  execFileSync('zip', args, { cwd: ROOT, stdio: 'inherit' });
  console.log(`[build-zip] 完成：${OUT_PATH}`);

  // 驗證：ZIP 內確實不含被排除的內容。
  const listing = execFileSync('unzip', ['-l', OUT_PATH]).toString();
  const forbidden = ['node_modules/', '.git/', 'data/pos.db'];
  const leaked = forbidden.filter((f) => listing.includes(f));
  if (leaked.length) {
    console.error('[build-zip] ❌ 發現不應存在的內容：', leaked);
    process.exitCode = 1;
  } else {
    console.log('[build-zip] ✅ 驗證通過：ZIP 不含 node_modules/.git/data/pos.db');
  }
}

main();
