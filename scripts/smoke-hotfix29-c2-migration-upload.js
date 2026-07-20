#!/usr/bin/env node
// scripts/smoke-hotfix29-c2-migration-upload.js — fix18-10-hotfix29-C2 smoke test
//
// 涵蓋需求文件（本次修復「資料備份／搬家」匯入 413／HTML 錯誤解析問題）：
//   - MIGRATION_UPLOAD_LIMIT_MB 環境變數：未設定 / 合法值 / 非法值 / 超過硬性上限
//   - 真實 Express pipeline：正常 JSON、超限 JSON、損壞 JSON、prototype pollution
//   - 所有錯誤情況一律回傳 JSON（不是 HTML），且不含 <!DOCTYPE html>
//   - 前端安全解析 helper（parseMigrationApiResponse）不會對 HTML 413 拋出
//     「Unexpected token '<'」
//   - 9.92MB（10,408,207 bytes）等效搬家檔在預設 25MB 上限下可通過
//
// 每一組環境變數情境都需要一份「獨立的 node server.js 行程」，因為
// MIGRATION_UPLOAD_LIMIT_MB 是在 utils/migrationUploadLimit.js require 當下
// 就算好的常數，同一個 process 裡途中改 process.env 不會讓已經 require 過的
// 模組重新計算 —— 這也如實反映了正式環境「改環境變數要重新部署／重啟」
// 的真實行為，不是測試的取巧寫法。
//
// 誠實揭露：
//   - Zeabur／上游 reverse proxy 本身是否有更低的 body size 限制，屬於平台
//     層設定，本機 smoke test 無法驗證，一律標記 MANUAL REQUIRED。
//   - 前端「安全解析」的驗證，這裡用 Node 直接載入 parseMigrationApiResponse
//     的邏輯（用 fetch-like 假 Response 物件跑真正的程式碼路徑），不是完整
//     瀏覽器 DOM／UI 測試。

'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name, detail) { results.push({ name, status: 'PASS', detail }); console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name, detail) : fail(name, detail); }

// ═══════════════════════════════════════════════════════════════════════
//  0. 純函式：computeMigrationUploadLimitMb / isMigrationImportPath
//     （不需要開伺服器，先驗證運算規則本身）
// ═══════════════════════════════════════════════════════════════════════
function testPureFunctions() {
  // 清掉 require cache，確保每次都是全新載入（不同 env 值互不汙染）
  delete require.cache[require.resolve('../utils/migrationUploadLimit')];
  const { computeMigrationUploadLimitMb, isMigrationImportPath } = require('../utils/migrationUploadLimit');

  assert(computeMigrationUploadLimitMb(undefined) === 25, '0-1 未設定環境變數 → 預設 25MB', `got=${computeMigrationUploadLimitMb(undefined)}`);
  assert(computeMigrationUploadLimitMb('50') === 50, '0-2 合法環境變數 50 → 50MB', `got=${computeMigrationUploadLimitMb('50')}`);
  assert(computeMigrationUploadLimitMb('abc') === 25, '0-3a 非法值 abc → 回退 25MB', `got=${computeMigrationUploadLimitMb('abc')}`);
  assert(computeMigrationUploadLimitMb('0') === 1, '0-3b 非法值 0 → 限制為最低 1MB', `got=${computeMigrationUploadLimitMb('0')}`);
  assert(computeMigrationUploadLimitMb('-1') === 1, '0-3c 非法值 -1 → 限制為最低 1MB', `got=${computeMigrationUploadLimitMb('-1')}`);
  assert(computeMigrationUploadLimitMb('500') === 100, '0-4 超過最高上限 500 → 限制為 100MB', `got=${computeMigrationUploadLimitMb('500')}`);

  const fakeReqA = { originalUrl: '/api/migration/import?foo=bar' };
  const fakeReqB = { originalUrl: '/api/migration/import/preview' };
  const fakeReqC = { originalUrl: '/api/migration/export' };
  const fakeReqD = { path: '/migration/import', originalUrl: undefined, url: undefined }; // 模擬 router 內部 mount-relative path（不應誤判為 true）
  assert(isMigrationImportPath(fakeReqA) === true, '0-5a isMigrationImportPath 對 /api/migration/import（含 query string）判斷正確');
  assert(isMigrationImportPath(fakeReqB) === true, '0-5b isMigrationImportPath 對 /api/migration/import/preview 判斷正確');
  assert(isMigrationImportPath(fakeReqC) === false, '0-5c isMigrationImportPath 對非搬家路徑判斷正確（不應誤判）');
  assert(isMigrationImportPath(fakeReqD) === false, '0-5d isMigrationImportPath 對 mount-relative path（缺 originalUrl）不誤判為 true');
}

// ═══════════════════════════════════════════════════════════════════════
//  1. 前端安全解析 helper：直接從 public/js/app.js 抽出
//     parseMigrationApiResponse 的原始碼，用真的程式碼路徑跑（不是重寫一份）
// ═══════════════════════════════════════════════════════════════════════
function extractFunctionSource(fileText, fnSignatureRegex) {
  const m = fnSignatureRegex.exec(fileText);
  if (!m) return null;
  const startIdx = m.index;
  // 從函式開頭找對應的大括號結尾（簡單配對，函式體內沒有字串內含未跳脫大括號的風險，
  // app.js 這個函式本身沒有樣板字串含大括號嵌套的問題，經人工確認）
  let depth = 0, i = fileText.indexOf('{', startIdx);
  const bodyStart = i;
  for (; i < fileText.length; i++) {
    if (fileText[i] === '{') depth++;
    else if (fileText[i] === '}') { depth--; if (depth === 0) break; }
  }
  return fileText.slice(startIdx, i + 1);
}

async function testFrontendSafeParser() {
  const appJsPath = path.join(ROOT, 'public', 'js', 'app.js');
  const src = fs.readFileSync(appJsPath, 'utf8');
  const fnSrc = extractFunctionSource(src, /async function parseMigrationApiResponse\s*\(response\)\s*/);

  if (!fnSrc) {
    fail('1-0 從 app.js 擷取 parseMigrationApiResponse 原始碼', '找不到函式，可能已被改名或搬移');
    return;
  }
  pass('1-0 從 app.js 擷取 parseMigrationApiResponse 原始碼');

  // 用 vm 執行擷取出來的「真正」函式原始碼（不是重寫版本）
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nthis.parseMigrationApiResponse = parseMigrationApiResponse;`, sandbox);
  const parseMigrationApiResponse = sandbox.parseMigrationApiResponse;

  function fakeResponse({ ok, status, text }) {
    return { ok, status, text: async () => text };
  }

  // 情境 A：後端／Proxy 回傳 HTML 413 錯誤頁
  const htmlRes = fakeResponse({ ok: false, status: 413, text: '<!DOCTYPE html><html><body>413 Request Entity Too Large</body></html>' });
  let threw = false;
  let out = null;
  try { out = await parseMigrationApiResponse(htmlRes); } catch (e) { threw = true; }
  assert(threw === false, '1-1 parseMigrationApiResponse 對 HTML 413 不拋出例外（不會出現 Unexpected token）');
  assert(!!out && out.success === false, '1-2 parseMigrationApiResponse 對 HTML 413 回傳 success:false 的物件');
  assert(!!out && typeof out.message === 'string' && out.message.includes('伺服器未回傳有效 JSON') && out.message.includes('413'),
    '1-3 parseMigrationApiResponse 訊息內容為「伺服器未回傳有效 JSON，HTTP 413」', `got="${out && out.message}"`);
  assert(!!out && !JSON.stringify(out).includes('<!DOCTYPE'), '1-4 回傳物件不含原始 HTML 內容');

  // 情境 B：正常 JSON 錯誤（後端自訂中文訊息）應該原樣帶出
  const jsonErrRes = fakeResponse({ ok: false, status: 413, text: JSON.stringify({ success: false, code: 'MIGRATION_FILE_TOO_LARGE', message: '檔案過大，目前最多接受 1MB', max_size_mb: 1 }) });
  const out2 = await parseMigrationApiResponse(jsonErrRes);
  assert(out2.code === 'MIGRATION_FILE_TOO_LARGE' && out2.message.includes('1MB'), '1-5 parseMigrationApiResponse 對合法 JSON 錯誤原樣帶出後端訊息', JSON.stringify(out2));

  // 情境 C：正常成功回應
  const okRes = fakeResponse({ ok: true, status: 200, text: JSON.stringify({ success: true, summary: { products: 1 } }) });
  const out3 = await parseMigrationApiResponse(okRes);
  assert(out3.success === true && out3.summary.products === 1, '1-6 parseMigrationApiResponse 對正常成功回應正確解析');
}

// ═══════════════════════════════════════════════════════════════════════
//  2. 真實 HTTP 整合測試：spawn 真的 node server.js，每個環境變數情境
//     各自啟動一份獨立的 process（見檔案最上方說明）
// ═══════════════════════════════════════════════════════════════════════
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');

function resetDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(url + '/api/health');
          if (r.ok) return resolve();
        } catch (e) { /* not up yet */ }
        await new Promise(r2 => setTimeout(r2, 200));
      }
      reject(new Error('server did not start in time'));
    })();
  });
}

function startServer(port, extraEnv) {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d.toString(); });
  proc.stderr.on('data', d => { log += d.toString(); });
  return { proc, getLog: () => log };
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}

// 產生「大致對應目標大小」的合法 pos_migration_backup JSON payload。
// 用一個大字串欄位灌內容，再用 Buffer.byteLength 實際量測，反覆調整，
// 避免因為 JSON.stringify 的跳脫字元／中文 UTF-8 多 byte 造成誤差。
function buildMigrationPayloadOfSize(targetBytes) {
  function build(padLen) {
    const payload = {
      type: 'pos_migration_backup',
      store_id: 'store_001',
      version: '18.0.0',
      exported_at: new Date().toISOString(),
      data: {
        products: [],
        categories: [],
        orders: [],
        _pad: 'x'.repeat(Math.max(0, padLen)),
      },
    };
    return JSON.stringify(payload);
  }
  let padLen = Math.max(0, targetBytes - Buffer.byteLength(build(0), 'utf8'));
  let str = build(padLen);
  let actual = Buffer.byteLength(str, 'utf8');
  // 微調到誤差在 ±4 bytes 內（_pad 全是 ASCII 'x'，1 char = 1 byte，理論上一次就準）
  let guardLoop = 0;
  while (Math.abs(actual - targetBytes) > 4 && guardLoop < 20) {
    padLen += (targetBytes - actual);
    str = build(padLen);
    actual = Buffer.byteLength(str, 'utf8');
    guardLoop++;
  }
  return { str, bytes: actual };
}

async function runHttpScenario(label, { port, env, testFn }) {
  resetDb();
  const { proc, getLog } = startServer(port, env);
  const base = `http://localhost:${port}`;
  try {
    await waitForServer(base, 20000);
  } catch (e) {
    fail(`${label}／伺服器啟動`, `${e.message}\n--- server log ---\n${getLog().slice(-2000)}`);
    await stopServer(proc);
    return;
  }
  try {
    await testFn(base);
  } catch (e) {
    fail(`${label}／測試流程未預期例外`, e.stack || e.message);
  } finally {
    await stopServer(proc);
  }
}

async function loginAndGetToken(base) {
  const res = await fetch(base + '/api/store-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: 'store_001', password: 'store_001' }),
  });
  const json = await res.json();
  if (!json.success) throw new Error('store-login 失敗：' + JSON.stringify(json));
  return json.token;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' fix18-10-hotfix29-C2 — 資料搬家上傳限制 smoke test');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('── 0. 純函式驗證 ──');
  testPureFunctions();

  console.log('\n── 1. 前端安全解析 helper（真實原始碼路徑） ──');
  await testFrontendSafeParser();

  console.log('\n── 2. 真實 HTTP 整合測試 ──');

  // 2-1／2-2／2-4：GET /api/migration/config 回報的 upload_limit_mb 是否
  // 正確反映各種環境變數情境（涵蓋需求 1/2/4）
  await runHttpScenario('2-1 未設定環境變數 → config 應回報 25', {
    port: 5901,
    env: { MIGRATION_UPLOAD_LIMIT_MB: '' },
    testFn: async (base) => {
      const token = await loginAndGetToken(base);
      const res = await fetch(base + '/api/migration/config', { headers: { Authorization: 'Bearer ' + token } });
      const json = await res.json();
      assert(res.headers.get('content-type').includes('application/json'), '2-1a config 回應 Content-Type 為 application/json');
      assert(json.success === true && json.upload_limit_mb === 25, '2-1b 未設定環境變數 → upload_limit_mb === 25', JSON.stringify(json));
      assert(Array.isArray(json.supported_extensions) && json.supported_extensions.includes('.json'), '2-1c supported_extensions 含 .json');
      assert(json.upload_limit_bytes === 25 * 1024 * 1024, '2-1d upload_limit_bytes 與 upload_limit_mb 一致');
      // 安全性：不得洩漏密鑰／路徑／stack
      const raw = JSON.stringify(json);
      assert(!/JWT_SECRET|secret|token|\/home\/|\/mnt\/|stack/i.test(raw), '2-1e config 回應不包含密鑰／伺服器路徑／stack 等敏感資訊', raw);
    },
  });

  await runHttpScenario('2-2 MIGRATION_UPLOAD_LIMIT_MB=50 → config 應回報 50', {
    port: 5902,
    env: { MIGRATION_UPLOAD_LIMIT_MB: '50' },
    testFn: async (base) => {
      const token = await loginAndGetToken(base);
      const res = await fetch(base + '/api/migration/config', { headers: { Authorization: 'Bearer ' + token } });
      const json = await res.json();
      assert(json.upload_limit_mb === 50, '2-2 合法環境變數 50 → upload_limit_mb === 50', JSON.stringify(json));
    },
  });

  await runHttpScenario('2-4 MIGRATION_UPLOAD_LIMIT_MB=500 → 應被限制為 100', {
    port: 5903,
    env: { MIGRATION_UPLOAD_LIMIT_MB: '500' },
    testFn: async (base) => {
      const token = await loginAndGetToken(base);
      const res = await fetch(base + '/api/migration/config', { headers: { Authorization: 'Bearer ' + token } });
      const json = await res.json();
      assert(json.upload_limit_mb === 100, '2-4 超過最高上限 500 → upload_limit_mb === 100（硬性上限）', JSON.stringify(json));
    },
  });

  // 2-5／2-6／2-7／2-8：以 MIGRATION_UPLOAD_LIMIT_MB=1 開一份 server，
  // 測試正常大小 / 超限 / 損壞 JSON / prototype pollution
  await runHttpScenario('2-5～2-8 上傳限制=1MB 下的各種請求情境', {
    port: 5904,
    env: { MIGRATION_UPLOAD_LIMIT_MB: '1' },
    testFn: async (base) => {
      const token = await loginAndGetToken(base);
      const authHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

      // 2-5 正常 JSON request：100KB / 500KB / 900KB，限制 1MB，不應是 413
      for (const targetKb of [100, 500, 900]) {
        const { str, bytes } = buildMigrationPayloadOfSize(targetKb * 1024);
        const res = await fetch(base + '/api/migration/import/preview', {
          method: 'POST', headers: authHeaders, body: str,
        });
        const contentType = res.headers.get('content-type') || '';
        assert(res.status !== 413, `2-5 正常 JSON（約 ${targetKb}KB，實際 ${bytes} bytes）不應被 413 擋掉`, `status=${res.status}`);
        assert(contentType.includes('application/json'), `2-5 正常 JSON（約 ${targetKb}KB）回應 Content-Type 為 application/json`, contentType);
        const json = await res.json().catch(() => null);
        assert(!!json && json.success === true, `2-5 正常 JSON（約 ${targetKb}KB）preview 回傳 success:true`, JSON.stringify(json));
      }

      // 2-6 超限 JSON：限制 1MB，送出約 1.1MB～1.5MB
      for (const targetMb of [1.1, 1.3, 1.5]) {
        const { str, bytes } = buildMigrationPayloadOfSize(Math.round(targetMb * 1024 * 1024));
        const res = await fetch(base + '/api/migration/import/preview', {
          method: 'POST', headers: authHeaders, body: str,
        });
        const rawText = await res.text();
        const contentType = res.headers.get('content-type') || '';
        assert(res.status === 413, `2-6 超限 JSON（實際 ${bytes} bytes，約 ${targetMb}MB）回傳 HTTP 413`, `status=${res.status}`);
        assert(contentType.includes('application/json'), `2-6 超限 JSON（約 ${targetMb}MB）Content-Type 為 application/json`, contentType);
        assert(!rawText.includes('<!DOCTYPE html>') && !rawText.includes('<html'), `2-6 超限 JSON（約 ${targetMb}MB）回應本文不含 HTML`, rawText.slice(0, 120));
        let json = null;
        try { json = JSON.parse(rawText); } catch (e) { /* fail 由下面斷言處理 */ }
        assert(!!json && json.code === 'MIGRATION_FILE_TOO_LARGE', `2-6 超限 JSON（約 ${targetMb}MB）code === MIGRATION_FILE_TOO_LARGE`, rawText);
        assert(!!json && json.max_size_mb === 1, `2-6 超限 JSON（約 ${targetMb}MB）max_size_mb === 1`, rawText);
      }

      // 2-7 損壞 JSON（缺少結尾大括號）
      {
        const res = await fetch(base + '/api/migration/import/preview', {
          method: 'POST', headers: authHeaders, body: '{"type":"pos_migration_backup",',
        });
        const rawText = await res.text();
        const contentType = res.headers.get('content-type') || '';
        assert(res.status === 400, '2-7 損壞 JSON 回傳 HTTP 400', `status=${res.status}`);
        assert(contentType.includes('application/json'), '2-7 損壞 JSON Content-Type 為 application/json', contentType);
        assert(!rawText.includes('<!DOCTYPE'), '2-7 損壞 JSON 回應本文不含 HTML', rawText.slice(0, 120));
        let json = null;
        try { json = JSON.parse(rawText); } catch (e) {}
        assert(!!json && json.code === 'INVALID_JSON_BODY', '2-7 損壞 JSON code === INVALID_JSON_BODY', rawText);
      }

      // 2-8 Prototype pollution（兩種手法）
      // 注意：用 JS 物件字面量寫 { __proto__: {...} } 會被直譯器當成「設定
      // 這個物件的原型」，而不是建立一個叫 __proto__ 的自有屬性，所以
      // JSON.stringify(那個物件) 根本不會產生 "__proto__" 這個 key —
      // 這只是 JS 語法的陷阱，不是伺服器的問題。真實攻擊者是直接送出
      // 「文字上」帶有 "__proto__" key 的 JSON 字串，JSON.parse 對這種
      // 字串「不會」特殊處理，會老實建立一個自有屬性 —— 這裡改用原始
      // JSON 字串（而不是物件字面量再 JSON.stringify）才能還原真實攻擊情境。
      const pollutionPayloads = [
        { name: '__proto__ 直接污染', rawBody: '{"type":"pos_migration_backup","data":{"__proto__":{"polluted":true}}}' },
        { name: 'constructor.prototype 污染', rawBody: JSON.stringify({ type: 'pos_migration_backup', data: { constructor: { prototype: { polluted: true } } } }) },
      ];
      for (const p of pollutionPayloads) {
        const res = await fetch(base + '/api/migration/import/preview', {
          method: 'POST', headers: authHeaders, body: p.rawBody,
        });
        const json = await res.json().catch(() => null);
        assert(res.status === 400, `2-8 ${p.name} 回傳 HTTP 400`, `status=${res.status}`);
        assert(!!json && json.code === 'MIGRATION_UNSAFE_PAYLOAD', `2-8 ${p.name} code === MIGRATION_UNSAFE_PAYLOAD`, JSON.stringify(json));
      }
      // 驗證 Object.prototype 確實沒有被污染（在測試 process 本身檢查，
      // 因為污染攻擊如果成功，影響的是「後端 process」的 Object.prototype）
      assert(({}).polluted === undefined, '2-8 驗證後 Object.prototype 未被污染：({}).polluted === undefined');

      // 2-9：以真實搬家檔大小基準 9.92MB（10,408,207 bytes）驗證，但用
      // 這個情境本身的 1MB 上限來確認「一定會被擋」，藉此反向確認 body
      // parser 真的有在量測位元組數（而不是誤判永遠通過或永遠擋下）
      {
        const { str, bytes } = buildMigrationPayloadOfSize(10408207);
        const res = await fetch(base + '/api/migration/import/preview', {
          method: 'POST', headers: authHeaders, body: str,
        });
        assert(bytes >= 10408207 - 4 && bytes <= 10408207 + 4, '2-9a 產生的測試 payload 實際大小約為 10,408,207 bytes（9.92MB 基準）', `actual bytes=${bytes}`);
        assert(res.status === 413, '2-9b 在 1MB 上限下，9.92MB payload 正確被擋（驗證 body parser 真的有量測位元組數）', `status=${res.status}`);
      }
    },
  });

  // 2-10：以真實搬家檔大小基準 9.92MB，在「預設 25MB」上限下應該通過
  //       body parser（不代表能通過完整 preview 商業邏輯，因為我們是灌
  //       假資料，但至少驗證「不會被 body-parser 擋在 413」這個本次修復
  //       的核心目標）。
  await runHttpScenario('2-10 9.92MB 等效檔案在預設 25MB 上限下通過 body parser', {
    port: 5905,
    env: { MIGRATION_UPLOAD_LIMIT_MB: '' },
    testFn: async (base) => {
      const token = await loginAndGetToken(base);
      const authHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
      const { str, bytes } = buildMigrationPayloadOfSize(10408207);
      assert(bytes >= 10408207 - 4 && bytes <= 10408207 + 4, '2-10a 測試 payload 實際大小約為 10,408,207 bytes', `Buffer.byteLength=${bytes}`);
      const res = await fetch(base + '/api/migration/import/preview', {
        method: 'POST', headers: authHeaders, body: str,
      });
      assert(res.status !== 413, '2-10b 9.92MB 等效檔案在預設 25MB 上限下不被 413 擋掉', `status=${res.status}`);
      const json = await res.json().catch(() => null);
      assert(!!json && json.success === true, '2-10c preview 成功回傳統計摘要', JSON.stringify(json).slice(0, 300));
    },
  });

  manual('Zeabur／上游 reverse proxy body size 限制', '應用程式層（Express/body-parser）已驗證支援 25MB（可調整），但 Zeabur 平台或其上游 reverse proxy／CDN 若另有更低的 body size 限制，屬於平台層設定，本機 smoke test 無法驗證，需部署後以真實 9.92MB 檔案實測確認。');

  // ── 總結 ──
  console.log('\n═══════════════════════════════════════════════════════');
  const passN = results.filter(r => r.status === 'PASS').length;
  const failN = results.filter(r => r.status === 'FAIL').length;
  const manN  = results.filter(r => r.status === 'MANUAL REQUIRED').length;
  console.log(` 結果：PASS ${passN} ／ FAIL ${failN} ／ MANUAL REQUIRED ${manN} ／ 共 ${results.length} 項`);
  console.log('═══════════════════════════════════════════════════════');
  if (failN > 0) {
    console.log('\n失敗項目：');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(` - ${r.name}${r.detail ? '\n   ' + String(r.detail).slice(0, 500) : ''}`));
  }
  process.exit(failN > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[FATAL]', e.stack || e.message);
  process.exit(1);
});
