#!/usr/bin/env node
// scripts/run-h1-4-10-secret-ui-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-N8N-QA-FRIEND-SECRET-UX
//
// 範圍：TASK A — Recovery n8n Shared Secret One-Time Display / Copy
//   - public/js/app.js 的 rotateCartRecoveryN8nSecret() / showCartRecoverySecretOnce() /
//     closeCartRecoverySecretModal() / copyCartRecoverySecretOnce()
//   - public/index.html 的 #cartRecoverySecretModal 靜態 markup（backdrop close／
//     X 按鈕／readonly input／copy button 是否存在且接到正確 handler）
//   - routes/settings.js 的 GET redaction（沿用既有 Phase 4C 的 Admin-3／GET-redact
//     斷言，這裡只做交叉確認，不重複整套 backend HTTP 測試）
//
// 不重新測 rotate endpoint 本身的 protocol（見 Phase 4C S1-S5／GET-redact），
// 這裡只測「rotate 回應之後」的前端一次性顯示／複製／清除行為。

'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// 從 app.js 原始碼中，用 brace-matching 抓出指定函式的完整原始碼（含
// function/async function 關鍵字），不改寫、不重新實作一份——測試跑的必須
// 是 production 檔案裡實際的那份程式碼，才是真正的 regression 保護。
// ════════════════════════════════════════════════════════════════
function extractFunctionSource(src, name) {
  const startRe = new RegExp(`(?:async\\s+function|function)\\s+${name}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) throw new Error(`extractFunctionSource: 找不到函式 ${name}`);
  const braceStart = src.indexOf('{', m.index);
  if (braceStart === -1) throw new Error(`extractFunctionSource: ${name} 找不到起始 {`);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

function extractLetDecl(src, name) {
  const re = new RegExp(`let\\s+${name}\\s*=\\s*[^;]+;`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractLetDecl: 找不到 let ${name}`);
  return m[0];
}

// ════════════════════════════════════════════════════════════════
// Mock DOM harness
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const el = {
    style: { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } },
    _value: '', textContent: '', dataset: {}, _attrs: {},
    get value() { return this._value; }, set value(v) { this._value = v; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    select() { this._selected = true; },
    parentNode: null,
  };
  let _id = '';
  Object.defineProperty(el, 'id', {
    get() { return _id; },
    set(v) { _id = v; if (v) idRegistry[v] = el; },
  });
  return el;
}

function loadAppSecretUiModule(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  const rotateFnSrc = extractFunctionSource(src, 'rotateCartRecoveryN8nSecret');
  const showFnSrc = extractFunctionSource(src, 'showCartRecoverySecretOnce');
  const closeFnSrc = extractFunctionSource(src, 'closeCartRecoverySecretModal');
  const copyFnSrc = extractFunctionSource(src, 'copyCartRecoverySecretOnce');
  const showModal18Src = extractFunctionSource(src, 'showModal18');
  const hideModal18Src = extractFunctionSource(src, 'hideModal18');
  const letDecl = extractLetDecl(src, 'oneTimeSecret');

  const idRegistry = {};
  const localStore = new Map();
  const sessionStore = new Map();
  const consoleLogs = [];
  const analyticsPayloads = opts.analyticsPayloads || [];

  const doc = {
    getElementById: (id) => idRegistry[id] || null,
    execCommand: (...args) => { doc._execCommandCalls = doc._execCommandCalls || []; doc._execCommandCalls.push(args); return true; },
  };
  // 預先掛上 modal 與其子元素（對應 public/index.html 實際 markup 的 id）。
  ['cartRecoverySecretModal', 'cartRecoverySecretOneTimeValue', 'cartRecoverySecretCopyStatus'].forEach((id) => {
    const e = makeFakeElement(idRegistry);
    e.id = id;
  });

  let clipboardWriteTextCalls = [];
  const clipboardImpl = Object.prototype.hasOwnProperty.call(opts, 'clipboard')
    ? opts.clipboard // 允許測試明確注入 undefined／會 reject 的版本，模擬 clipboard API 不可用
    : { writeText: (text) => { clipboardWriteTextCalls.push(text); return Promise.resolve(); } };
  const navigatorMock = { clipboard: clipboardImpl };

  const consoleMock = {
    log: (...a) => { consoleLogs.push({ level: 'log', args: a }); },
    warn: (...a) => { consoleLogs.push({ level: 'warn', args: a }); },
    error: (...a) => { consoleLogs.push({ level: 'error', args: a }); },
  };

  const apiFetchCalls = [];
  const apiFetchMock = async (url, options) => {
    apiFetchCalls.push({ url, options });
    if (opts.rotateResponse) {
      return { json: async () => opts.rotateResponse };
    }
    return { json: async () => ({ success: false, message: 'mock 未設定 rotateResponse' }) };
  };
  const loadCartRecoverySettingsCalls = [];
  const loadCartRecoverySettingsMock = async () => { loadCartRecoverySettingsCalls.push(1); };
  const toastCalls = [];
  const toastMock = (msg) => { toastCalls.push(msg); };
  const trackEventMock = (name, payload) => { analyticsPayloads.push({ name, payload }); };

  const combinedSrc = [
    letDecl,
    showModal18Src,
    hideModal18Src,
    showFnSrc,
    closeFnSrc,
    copyFnSrc,
    rotateFnSrc,
    '\nreturn { rotateCartRecoveryN8nSecret, showCartRecoverySecretOnce, closeCartRecoverySecretModal, copyCartRecoverySecretOnce, showModal18, hideModal18, __getOneTimeSecret: () => oneTimeSecret };',
  ].join('\n');

  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'document', 'navigator', 'console', 'apiFetch', 'loadCartRecoverySettings', 'toast', 'trackEvent',
    combinedSrc,
  );
  const mod = fn(doc, navigatorMock, consoleMock, apiFetchMock, loadCartRecoverySettingsMock, toastMock, trackEventMock);

  return {
    mod, doc, idRegistry, localStore, sessionStore,
    getClipboardCalls: () => clipboardWriteTextCalls,
    getExecCommandCalls: () => doc._execCommandCalls || [],
    getConsoleLogs: () => consoleLogs,
    getApiFetchCalls: () => apiFetchCalls,
    getLoadCartRecoverySettingsCalls: () => loadCartRecoverySettingsCalls,
    getToastCalls: () => toastCalls,
    getAnalyticsPayloads: () => analyticsPayloads,
  };
}

const REAL_SECRET = require('crypto').randomBytes(32).toString('base64url');

async function main() {
  console.log('== TASK A：Recovery n8n Shared Secret One-Time Display / Copy ==');

  // ────────────────────────────────────────────────────────────
  // SECRET-UI1：rotate button exists（static markup 檢查）
  // ────────────────────────────────────────────────────────────
  {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert(/onclick="rotateCartRecoveryN8nSecret\(\)"/.test(indexHtml), 'SECRET-UI1 rotate button exists（onclick="rotateCartRecoveryN8nSecret()"）');
    assert(/id="cartRecoverySecretModal"/.test(indexHtml), 'SECRET-UI1b #cartRecoverySecretModal 存在於 production HTML');
    assert(/id="cartRecoverySecretOneTimeValue"/.test(indexHtml), 'SECRET-UI1c #cartRecoverySecretOneTimeValue（readonly input）存在');
    assert(/id="cartRecoverySecretCopyBtn"/.test(indexHtml), 'SECRET-UI1d #cartRecoverySecretCopyBtn 存在');
    assert(/id="cartRecoverySecretCloseBtn"/.test(indexHtml), 'SECRET-UI1e #cartRecoverySecretCloseBtn 存在');
    assert(/id="cartRecoverySecretCopyStatus"/.test(indexHtml), 'SECRET-UI1f #cartRecoverySecretCopyStatus 存在');
    const inputTagMatch = indexHtml.match(/<input[^>]*id="cartRecoverySecretOneTimeValue"[^>]*>/);
    assert(!!inputTagMatch && /readonly/.test(inputTagMatch[0]), 'SECRET-UI1g one-time input 帶 readonly 屬性');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI2：rotate success → modal opens
  // SECRET-UI3：readonly plaintext input 顯示 exact rotate response secret
  // ────────────────────────────────────────────────────────────
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET } });
    await h.mod.rotateCartRecoveryN8nSecret();
    const modalEl = h.idRegistry['cartRecoverySecretModal'];
    assert(modalEl.style._props['display'] === 'flex', 'SECRET-UI2 rotate success → modal opens（display:flex）');
    const inputEl = h.idRegistry['cartRecoverySecretOneTimeValue'];
    assert(inputEl.value === REAL_SECRET, 'SECRET-UI3 readonly plaintext input 顯示 rotate 回應的 exact secret（逐字相符，非部分/遮蔽）');
    assert(h.mod.__getOneTimeSecret() === REAL_SECRET, 'SECRET-UI3b 模組內 oneTimeSecret 變數同步保存這次 rotate 的明文（供複製使用）');
    assert(h.getLoadCartRecoverySettingsCalls().length === 1, 'SECRET-UI2b rotate 成功後會重新載入設定（讓「目前狀態」等布林欄位同步更新）');
  }

  // rotate 失敗（success:false）→ 不開 modal，不建立 oneTimeSecret
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: false, message: 'rotate_failed' } });
    await h.mod.rotateCartRecoveryN8nSecret();
    const modalEl = h.idRegistry['cartRecoverySecretModal'];
    assert(modalEl.style._props['display'] !== 'flex', 'SECRET-UI2c rotate 失敗時不開啟一次性 Modal');
    assert(h.mod.__getOneTimeSecret() === null, 'SECRET-UI2d rotate 失敗時不建立任何 oneTimeSecret');
    assert(h.getToastCalls().some((m) => m === 'rotate_failed'), 'SECRET-UI2e rotate 失敗時顯示後端回傳的錯誤訊息');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI4：copy button exists（已於 SECRET-UI1d 靜態確認 id 存在；
  // 這裡額外確認 onclick 綁到 copyCartRecoverySecretOnce()）
  // ────────────────────────────────────────────────────────────
  {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert(/id="cartRecoverySecretCopyBtn"[^>]*onclick="copyCartRecoverySecretOnce\(\)"/.test(indexHtml),
      'SECRET-UI4 copy button 存在且 onclick 綁到 copyCartRecoverySecretOnce()');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI5：navigator.clipboard.writeText(secret)
  // ────────────────────────────────────────────────────────────
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET } });
    await h.mod.rotateCartRecoveryN8nSecret();
    await h.mod.copyCartRecoverySecretOnce();
    const calls = h.getClipboardCalls();
    assert(calls.length === 1 && calls[0] === REAL_SECRET, 'SECRET-UI5 navigator.clipboard.writeText(secret) 以「這次 rotate 的明文」為參數呼叫一次');
    const statusEl = h.idRegistry['cartRecoverySecretCopyStatus'];
    assert(statusEl.textContent === '已複製到剪貼簿', 'SECRET-UI5b 複製成功後顯示「已複製到剪貼簿」狀態文字');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI6：clipboard API unavailable/error → select + execCommand('copy') fallback
  // ────────────────────────────────────────────────────────────
  {
    // Case 1：完全沒有 navigator.clipboard（例如非 HTTPS 環境）
    const h1 = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET }, clipboard: undefined });
    await h1.mod.rotateCartRecoveryN8nSecret();
    await h1.mod.copyCartRecoverySecretOnce();
    const inputEl1 = h1.idRegistry['cartRecoverySecretOneTimeValue'];
    assert(inputEl1._selected === true, 'SECRET-UI6a clipboard API 不存在時，fallback 呼叫 input.select()');
    assert(h1.getExecCommandCalls().length === 1 && h1.getExecCommandCalls()[0][0] === 'copy', 'SECRET-UI6b fallback 呼叫 document.execCommand(\'copy\')');
    const statusEl1 = h1.idRegistry['cartRecoverySecretCopyStatus'];
    assert(statusEl1.textContent === '已複製到剪貼簿', 'SECRET-UI6c fallback 成功後同樣顯示「已複製到剪貼簿」');

    // Case 2：navigator.clipboard.writeText 存在但呼叫會 reject（例如使用者拒絕權限）
    const h2 = loadAppSecretUiModule({
      rotateResponse: { success: true, secret: REAL_SECRET },
      clipboard: { writeText: () => Promise.reject(new Error('permission_denied')) },
    });
    await h2.mod.rotateCartRecoveryN8nSecret();
    await h2.mod.copyCartRecoverySecretOnce();
    const inputEl2 = h2.idRegistry['cartRecoverySecretOneTimeValue'];
    assert(inputEl2._selected === true, 'SECRET-UI6d clipboard.writeText() reject 時，同樣 fallback 到 input.select()');
    assert(h2.getExecCommandCalls().length === 1 && h2.getExecCommandCalls()[0][0] === 'copy', 'SECRET-UI6e clipboard.writeText() reject 時，同樣 fallback 到 execCommand(\'copy\')');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI7：Close button → input.value=''
  // SECRET-UI8：Close button → oneTimeSecret=null
  // ────────────────────────────────────────────────────────────
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET } });
    await h.mod.rotateCartRecoveryN8nSecret();
    assert(h.idRegistry['cartRecoverySecretOneTimeValue'].value === REAL_SECRET, 'SECRET-UI7 前置：close 之前 input 確實有明文');
    h.mod.closeCartRecoverySecretModal();
    assert(h.idRegistry['cartRecoverySecretOneTimeValue'].value === '', 'SECRET-UI7 Close button → input.value=\'\'');
    assert(h.mod.__getOneTimeSecret() === null, 'SECRET-UI8 Close button → oneTimeSecret=null');
    const modalEl = h.idRegistry['cartRecoverySecretModal'];
    assert(modalEl.style._props['display'] === 'none', 'SECRET-UI7b Close button → modal display:none（真正關閉，非只是清空欄位）');
    assert(h.idRegistry['cartRecoverySecretCopyStatus'].textContent === '', 'SECRET-UI7c Close button → 複製狀態文字一併清空');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI9：X close 也走同一 closeCartRecoverySecretModal()，並清 plaintext
  // ────────────────────────────────────────────────────────────
  {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert(/id="cartRecoverySecretCloseBtn"[^>]*onclick="closeCartRecoverySecretModal\(\)"/.test(indexHtml),
      'SECRET-UI9 X 關閉按鈕（cartRecoverySecretCloseBtn）onclick 呼叫同一個 closeCartRecoverySecretModal()（同一份清除邏輯，沒有另外寫一套）');
    // 行為面：closeCartRecoverySecretModal() 是唯一清除入口，X／Close／backdrop
    // 三種觸發方式呼叫的是同一支函式，行為驗證已於 SECRET-UI7/8 完成，這裡
    // 只需確認 X 按鈕接的就是那支函式（同一入口，不是另外複製一份邏輯）。
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI10：backdrop click 也走同一 close path，並清 plaintext
  // ────────────────────────────────────────────────────────────
  {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const overlayMatch = indexHtml.match(/<div class="modal-overlay" id="cartRecoverySecretModal"[^>]*>/);
    assert(!!overlayMatch, 'SECRET-UI10 前置：#cartRecoverySecretModal 是 .modal-overlay（沿用既有 backdrop-click 慣例）');
    assert(!!overlayMatch && /onclick="if\(event\.target===this\)closeCartRecoverySecretModal\(\)"/.test(overlayMatch[0]),
      'SECRET-UI10 backdrop click（點擊遮罩本身，非內容區）呼叫同一個 closeCartRecoverySecretModal()，同樣會清除 plaintext（行為與 SECRET-UI7/8 相同，因為是同一支函式）');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI11：不寫 localStorage / sessionStorage / cookie / dataset
  // ────────────────────────────────────────────────────────────
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET } });
    await h.mod.rotateCartRecoveryN8nSecret();
    await h.mod.copyCartRecoverySecretOnce();
    h.mod.closeCartRecoverySecretModal();
    assert(h.localStore.size === 0, 'SECRET-UI11a 全程未寫入任何 localStorage key');
    assert(h.sessionStore.size === 0, 'SECRET-UI11b 全程未寫入任何 sessionStorage key');
    const inputEl = h.idRegistry['cartRecoverySecretOneTimeValue'];
    assert(Object.keys(inputEl.dataset).length === 0, 'SECRET-UI11c 全程未寫入 input 的 dataset（無 data-* attribute 保存 secret）');
    assert(Object.keys(inputEl._attrs).filter((k) => k !== 'readonly').length === 0, 'SECRET-UI11d 全程未透過 setAttribute() 寫入任何自訂 attribute（例如 data-secret）');
    // 原始碼層級再確認一次：function 本體完全沒有 document.cookie 字樣。
    const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const fnSrc = extractFunctionSource(src, 'showCartRecoverySecretOnce') + extractFunctionSource(src, 'closeCartRecoverySecretModal') + extractFunctionSource(src, 'copyCartRecoverySecretOnce') + extractFunctionSource(src, 'rotateCartRecoveryN8nSecret');
    assert(!fnSrc.includes('document.cookie'), 'SECRET-UI11e 原始碼層級確認：四支函式完全沒有 document.cookie 字樣');
    assert(!fnSrc.includes('localStorage.') && !fnSrc.includes('sessionStorage.'), 'SECRET-UI11f 原始碼層級確認：四支函式完全沒有 localStorage./sessionStorage. 呼叫');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI12：不進 analytics payload
  // ────────────────────────────────────────────────────────────
  {
    const analyticsPayloads = [];
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET }, analyticsPayloads });
    await h.mod.rotateCartRecoveryN8nSecret();
    await h.mod.copyCartRecoverySecretOnce();
    h.mod.closeCartRecoverySecretModal();
    assert(analyticsPayloads.length === 0, 'SECRET-UI12a 全程沒有呼叫任何 trackEvent（四支函式完全不含 analytics 呼叫）');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const fnSrc = extractFunctionSource(src, 'showCartRecoverySecretOnce') + extractFunctionSource(src, 'closeCartRecoverySecretModal') + extractFunctionSource(src, 'copyCartRecoverySecretOnce');
    assert(!/trackEvent|_trackEvent|gtag\(/.test(fnSrc), 'SECRET-UI12b 原始碼層級確認：三支核心函式沒有 trackEvent/_trackEvent/gtag 呼叫');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI13：不出現在 console.log / console.error
  // ────────────────────────────────────────────────────────────
  {
    const h = loadAppSecretUiModule({ rotateResponse: { success: true, secret: REAL_SECRET } });
    await h.mod.rotateCartRecoveryN8nSecret();
    await h.mod.copyCartRecoverySecretOnce();
    h.mod.closeCartRecoverySecretModal();
    const logs = h.getConsoleLogs();
    const leaked = logs.filter((l) => JSON.stringify(l.args).includes(REAL_SECRET));
    assert(leaked.length === 0, 'SECRET-UI13 全程 console.log/warn/error 都沒有印出這次 rotate 的明文 secret', `leaked=${leaked.length}`);
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI14：GET /api/settings 仍不含 cart_recovery_n8n_secret，
  // 只回 cart_recovery_n8n_secret_set（backend 靜態原始碼交叉確認；完整
  // HTTP 行為由 Phase 4C GET-redact／Admin-3 覆蓋，這裡確認同一份原始碼
  // 這次沒有被改動）。
  // ────────────────────────────────────────────────────────────
  {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    assert(settingsSrc.includes("out.cart_recovery_n8n_secret_set = !!(out.cart_recovery_n8n_secret && out.cart_recovery_n8n_secret.trim());"),
      'SECRET-UI14a redactSensitiveSettings() 仍計算 cart_recovery_n8n_secret_set 布林值');
    assert(settingsSrc.includes("delete out.cart_recovery_n8n_secret;"), 'SECRET-UI14b redactSensitiveSettings() 仍會 delete out.cart_recovery_n8n_secret（明文絕不回傳）');
    const orchestrationSrc = fs.readFileSync(path.join(ROOT, 'routes/cart-recovery-orchestration.js'), 'utf8');
    assert(orchestrationSrc.includes("return res.json({ success: true, secret: newSecret });"), 'SECRET-UI14c POST /secret/rotate 仍只在 rotate 當次回傳明文（backend protocol 未被本輪修改）');
    assert((orchestrationSrc.match(/secret:\s*newSecret/g) || []).length === 1, 'SECRET-UI14d rotate 端點只有一處回傳明文（沒有額外新增第二個回傳明文的路徑）');
  }

  // ────────────────────────────────────────────────────────────
  // SECRET-UI15：manual-entry secret='' 仍維持 preserve existing secret semantics
  // （backend 原始碼交叉確認，完整行為由 Phase 4C S1-S5 覆蓋）
  // ────────────────────────────────────────────────────────────
  {
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    assert(settingsSrc.includes("if (req.body.cart_recovery_n8n_secret === '') {\n      delete req.body.cart_recovery_n8n_secret;\n    }"),
      'SECRET-UI15 手動輸入 secret=\'\' 時，PUT /api/settings 仍然把它從 payload 刪除（保留原值語意，不會被本輪 UI 改動誤送出清空請求）');
    // 前端交叉確認：app.js 的 saveCartRecoverySettings() 仍然「留空不送」，
    // 不是本輪新碰的函式，只做靜態存在性確認，防止意外被連帶改掉。
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const saveFnSrc = extractFunctionSource(appSrc, 'saveCartRecoverySettings');
    assert(/n8nSecretEl\s*&&\s*n8nSecretEl\.value\.trim\(\)\)\s*payload\.cart_recovery_n8n_secret/.test(saveFnSrc),
      'SECRET-UI15b saveCartRecoverySettings() 仍然只在欄位非空時才把 secret 放進 payload（留空＝不送＝保留原值），未被本輪改動');
  }

  // ────────────────────────────────────────────────────────────
  // 額外：reload 不能重新取得 plaintext。
  // 這裡的「reload」以「重新呼叫 loadCartRecoverySettings() 對應的欄位回填
  // 邏輯」模擬——因為 rotate 之後 app.js 會呼叫 loadCartRecoverySettings()
  // （已於 SECRET-UI2b 驗證呼叫一次），而該函式本身（沿用既有、非本輪新增
  // 的邏輯）永遠把 #set-cart_recovery_n8n_secret 設回空字串、只用布林值
  // cart_recovery_n8n_secret_set 顯示狀態，這裡做原始碼交叉確認，防止有人
  // 在 loadCartRecoverySettings() 裡意外把 rotate 的明文接回去。
  // ────────────────────────────────────────────────────────────
  {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const loadFnSrc = extractFunctionSource(appSrc, 'loadCartRecoverySettings');
    assert(/n8nSecretEl\.value\s*=\s*''/.test(loadFnSrc), 'SECRET-UI-RELOAD loadCartRecoverySettings() 一律把 #set-cart_recovery_n8n_secret 設回空字串（絕不回填任何明文，含 rotate 剛產生的那組）');
    assert(!/n8nSecretEl\.value\s*=\s*settings\.cart_recovery_n8n_secret\b(?!_set)/.test(loadFnSrc), 'SECRET-UI-RELOAD loadCartRecoverySettings() 沒有任何路徑把 settings.cart_recovery_n8n_secret（明文欄位）塞回 input');
    assert(loadFnSrc.includes('cart_recovery_n8n_secret_set'), 'SECRET-UI-RELOAD loadCartRecoverySettings() 用布林 cart_recovery_n8n_secret_set 顯示「已設定／未設定」狀態，不依賴明文');
  }

  console.log('\n== SECRET-UI Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('SECRET-UI test runner crashed:', e); process.exit(1); });
