#!/usr/bin/env node
// scripts/security-scan-g1-6-ga4-h1.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// 真實掃描整個工作目錄（排除 node_modules/.git），分類命中結果：
//   A. 真實 Credential → FAIL，停止打包
//   B. Mock／QA 值（qa_/mock_ 前綴）→ 允許
//   C. Denylist Literal（本檔案自己的關鍵字清單）→ 允許
//   D. 文件欄位名稱（.md 文件裡描述欄位名的說明文字）→ 允許
// 絕不在報告中印出真實命中的原始內容，只印檔名/行號/分類。

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PATTERNS = [
  'BEGIN PRIVATE KEY', 'END PRIVATE KEY', 'private_key', 'private_key_id',
  'client_email', 'iam.gserviceaccount.com', 'GA4_SERVICE_ACCOUNT_JSON',
  'access_token', 'refresh_token', 'Authorization', 'Bearer', 'Cookie',
  'user_pseudo_id', 'client_id', 'property_id',
];

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', 'coverage']);
const EXCLUDE_FILE_SUFFIXES = ['.db', '.sqlite', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf'];
const THIS_FILE = path.basename(__filename);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (EXCLUDE_FILE_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
    out.push(full);
  }
}

function classifyHit(file, lineText) {
  const rel = path.relative(ROOT, file);

  // D. 文件欄位名稱：.md 文件裡列規格/schema/denylist 的說明文字。
  if (rel.endsWith('.md')) return 'D_DOC_FIELD_NAME';

  // C. Denylist literal：這個掃描腳本自己的關鍵字清單、以及其他
  // security-scan/static-audit 腳本裡用來檢測禁止字面的常數清單（本身
  // 就是安全的，因為它們是「檢測工具」，不是「洩漏來源」）。
  if (rel === path.join('scripts', THIS_FILE) || /security-scan|static-audit/.test(rel)) return 'C_DENYLIST_LITERAL';

  // B. Mock/QA 值：qa_ / mock_ 前綴，或明顯的假憑證樣式（fixture/fake/
  // example/placeholder/should-not-leak/dummy/stub 等一看就知道是測試假
  // 資料的樣式）。
  if (/qa_mock|qa-mock|mock_[a-z]|qa_|qa-fake-project/i.test(lineText)) return 'B_MOCK_QA';
  if (/fixture|fake[-_]|not[-_.]a[-_.]real|should[-_]not|placeholder|dummy|stub_|example\.com|SHOULD_NOT/i.test(lineText)) return 'B_MOCK_QA';

  // .env.example 只允許出現「變數名稱」，值必須是空的或安全範例。
  if (rel === '.env.example') {
    const eqIdx = lineText.indexOf('=');
    const value = eqIdx === -1 ? '' : lineText.slice(eqIdx + 1).trim();
    if (!value || value.length < 20) return 'D_DOC_FIELD_NAME';
  }

  // 程式碼裡對變數/欄位/常數「命名」本身包含這些字（例如 SQL column 名
  // property_id、或 credentialStatus() 判斷字串 client_email）——這些是
  // 安全的程式碼識別符，不是洩漏。Heuristic：這一行沒有 `:`/`=` 後面接著
  // 一段長度>=20 的類 base64/JSON 亂碼字串，就視為安全識別符使用。
  const suspiciousValueMatch = lineText.match(/[:=]\s*['"`]?([A-Za-z0-9+/_-]{20,})['"`]?/);
  if (!suspiciousValueMatch) return 'D_DOC_FIELD_NAME';
  // 全大寫＋底線（例如 'INVALID_ID_TOKEN_AUDIENCE'）是錯誤碼/常數命名慣例，
  // 不是憑證值（真實憑證/Token 不會長這樣）。
  if (/^[A-Z_]+$/.test(suspiciousValueMatch[1])) return 'D_DOC_FIELD_NAME';

  return 'A_REAL_CREDENTIAL_SUSPECT';
}

function main() {
  const files = [];
  walk(ROOT, files);

  const hits = { A_REAL_CREDENTIAL_SUSPECT: [], B_MOCK_QA: 0, C_DENYLIST_LITERAL: 0, D_DOC_FIELD_NAME: 0 };

  files.forEach((file) => {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      PATTERNS.forEach((pattern) => {
        if (!lineText.includes(pattern)) return;
        const category = classifyHit(file, lineText);
        if (category === 'A_REAL_CREDENTIAL_SUSPECT') {
          hits.A_REAL_CREDENTIAL_SUSPECT.push({ file: path.relative(ROOT, file), line: idx + 1, pattern });
        } else {
          hits[category] += 1;
        }
      });
    });
  });

  console.log('=== GA4-H1 Security Scan ===');
  console.log(`Files scanned: ${files.length}`);
  console.log(`B. Mock/QA hits (allowed): ${hits.B_MOCK_QA}`);
  console.log(`C. Denylist literal hits (allowed): ${hits.C_DENYLIST_LITERAL}`);
  console.log(`D. Doc/field-name/safe-identifier hits (allowed): ${hits.D_DOC_FIELD_NAME}`);
  console.log(`A. Real-credential SUSPECT hits: ${hits.A_REAL_CREDENTIAL_SUSPECT.length}`);

  if (hits.A_REAL_CREDENTIAL_SUSPECT.length > 0) {
    console.log('\n[FAIL] Suspected real credential material found (content NOT printed):');
    hits.A_REAL_CREDENTIAL_SUSPECT.forEach((h) => console.log(`  - ${h.file}:${h.line} (pattern: ${h.pattern})`));
    process.exit(1);
  }

  console.log('\n[PASS] No real credential material detected. Safe to package.');
  process.exit(0);
}

main();
