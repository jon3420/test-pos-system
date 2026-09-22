#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-landing.js
// H1.4.12 Phase 3B — Popup Recovery Identity Landing / sessionStorage handoff.
'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public/line-order.html');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup recovery landing/handoff (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function cryptoBeforeParse(window) {
  try {
    window.crypto.subtle = require('crypto').webcrypto.subtle;
    window.TextEncoder = require('util').TextEncoder;
  } catch (e) {}
}

async function createHarness(url, opts = {}) {
  const htmlSrc = fs.readFileSync(opts.htmlPath || HTML_PATH, 'utf8');
  const virtualConsole = new VirtualConsole();
  const jsErrors = [];
  virtualConsole.on('jsdomError', (e) => jsErrors.push(e.message));
  const calls = [];
  const timeoutIds = []; const intervalIds = [];
  const unhandled = [];
  const fetchImpl = opts.fetchImpl || ((u) => { calls.push(String(u)); return Promise.reject(new Error('no fixture for ' + u)); });
  const dom = new JSDOM(htmlSrc, {
    url, runScripts: 'dangerously', resources: undefined, virtualConsole,
    beforeParse(window) {
      cryptoBeforeParse(window);
      window.fetch = (u, init) => { calls.push({ url: String(u), method: (init && init.method) || 'GET', body: init && init.body }); return fetchImpl(String(u), init); };
      window.WebSocket = class { constructor() { this.close = () => {}; this.send = () => {}; } };
      const origST = window.setTimeout.bind(window);
      const origSI = window.setInterval.bind(window);
      window.setTimeout = (fn, ms, ...a) => { const id = origST(fn, ms, ...a); timeoutIds.push(id); return id; };
      window.setInterval = (fn, ms, ...a) => { const id = origSI(fn, ms, ...a); intervalIds.push(id); return id; };
      window.addEventListener('error', (e) => unhandled.push('window error: ' + (e.message || '')));
      window.addEventListener('unhandledrejection', (e) => unhandled.push('window unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
      if (opts.presetSessionStorage) {
        for (const [k, v] of Object.entries(opts.presetSessionStorage)) {
          try { window.sessionStorage.setItem(k, v); } catch (e) {}
        }
      }
    },
  });
  const w = dom.window;
  // 規格一：production 預設只呼叫 window.location.replace(url)（jsdom 對
  // Location.replace 是不可設定的原生實作，測試裡完全無法觀察／攔截它的
  // 呼叫參數）。這裡精確替換 production code 自己曝露的 _popupNavigateTo()
  // test seam（一個普通的 top-level function，可安全重新賦值），不去動
  // jsdom 本身不可設定的原生物件；production 沒有讀取任何
  // __testNavigatedTo 之類的測試專用變數。
  try {
    w.eval('window.__testNavigatedTo = null; if (typeof _popupNavigateTo === "function") { _popupNavigateTo = (url) => { window.__testNavigatedTo = String(url); }; }');
  } catch (e) {}
  return {
    dom, w, calls, jsErrors, unhandled,
    async settle(fn, { timeoutMs = 800, intervalMs = 15 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        let v; try { v = fn ? fn() : false; } catch (e) { v = false; }
        if (v) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return !fn;
    },
    cleanup() {
      try { timeoutIds.forEach((id) => { try { w.clearTimeout(id); } catch (e) {} }); } catch (e) {}
      try { intervalIds.forEach((id) => { try { w.clearInterval(id); } catch (e) {} }); } catch (e) {}
      try { dom.window.close(); } catch (e) {}
    },
  };
}
function assertNoUnexpectedErrors(ctx, label) {
  const unexpected = ctx.unhandled.concat(ctx.jsErrors.map((m) => 'jsdomError: ' + m));
  assert(unexpected.length === 0, `${label}-no-unexpected-exceptions 沒有未預期的 exception/rejection`, JSON.stringify(unexpected));
}
async function waitFor(fn, { timeoutMs = 1000, intervalMs = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  {
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAW1&popup_session=claim-code-1');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const e = ctx.w.eval('POPUP_ENTRY_CONTEXT');
      assert(e.entryContext === 'popup' && e.popupEntryType === 'recovery_landing' && e.recoveryToken === 'RAW1' && e.popupSessionCodeClaim === 'claim-code-1', '1-landing-detected LIFF landing 形狀正確判定為 recovery_landing', JSON.stringify(e));
      assert(ctx.w.eval('currentMode') !== 'popup', '1-landing-currentMode-unchanged currentMode 沒有被改成 popup', String(ctx.w.eval('currentMode')));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-landing-detected'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAW2');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const e = ctx.w.eval('POPUP_ENTRY_CONTEXT');
      assert(e.malformed === true, '1-token-only-without-claim-malformed 沒有 popup_session claim 的純 token-only 視為 malformed', JSON.stringify(e));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-token-only-malformed'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-x&recovery_handoff=HANDOFF1');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const e = ctx.w.eval('POPUP_ENTRY_CONTEXT');
      assert(e.malformed === true, '1-handoff-only-malformed handoff-only 視為 malformed', JSON.stringify(e));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-handoff-only-malformed'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-final&recovery_token=RAW3&recovery_handoff=NOPE');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const e = ctx.w.eval('POPUP_ENTRY_CONTEXT');
      assert(e.malformed === false && e.isRecoveryEntry === true && e.popupEntryCode === 'sess-final', '1-recovery-entry-detected 完整三參數判定為 recovery entry', JSON.stringify(e));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-recovery-entry-detected'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?campaign=camp1&recovery_token=RAW4&recovery_handoff=H4');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      assert(ctx.w.eval('POPUP_ENTRY_CONTEXT.malformed') === true, '1-campaign-plus-recovery-malformed campaign + recovery_* 併存視為 malformed', ctx.w.eval('JSON.stringify(POPUP_ENTRY_CONTEXT)'));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-campaign-plus-recovery-malformed'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-x&recovery_token=RAW5&recovery_token=RAWDIFFERENT&recovery_handoff=H5');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      assert(ctx.w.eval('POPUP_ENTRY_CONTEXT.malformed') === true, '1-duplicate-conflicting-param 同名 recovery_token 重複且值衝突視為 malformed', ctx.w.eval('JSON.stringify(POPUP_ENTRY_CONTEXT)'));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-duplicate-conflicting-param'); ctx.cleanup(); }
  }

  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-final&recovery_token=RAWSCRUB&recovery_handoff=HSCRUB');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const href = ctx.w.location.href;
      assert(!href.includes('recovery_token'), '2-scrub-token URL 中已移除 recovery_token', href);
      assert(!href.includes('recovery_handoff'), '2-scrub-handoff URL 中已移除 recovery_handoff', href);
      assert(href.includes('session=sess-final'), '2-scrub-keeps-session URL 保留 session', href);
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '2-scrub'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAWSCRUB2&popup_session=claim-2');
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 500 });
      const href = ctx.w.location.href;
      assert(!href.includes('recovery_token') && !href.includes('popup_session'), '2-scrub-landing landing 形狀的 recovery_token/popup_session 同樣被移除', href);
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '2-scrub-landing'); ctx.cleanup(); }
  }

  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof _generatePopupRecoveryHandoffId==="function"'), { timeoutMs: 300 });
      const ids = ctx.w.eval('[_generatePopupRecoveryHandoffId(),_generatePopupRecoveryHandoffId(),_generatePopupRecoveryHandoffId()]');
      assert(new Set(ids).size === 3, '3-handoff-id-unique 連續產生的 handoff id 互不相同', JSON.stringify(ids));
      assert(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id) && id.length >= 20), '3-handoff-id-urlsafe-and-long handoff id 是 URL-safe 編碼且長度符合 128-bit 隨機度', JSON.stringify(ids));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-handoff-id'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const handoffId = await ctx.w.eval("createPopupRecoveryHandoff('member-session-A','sess-real','raw-token-A')");
      assert(typeof handoffId === 'string' && handoffId.length > 0, '3-create-returns-id createPopupRecoveryHandoff() 回傳 handoff id', String(handoffId));
      const rawStored = ctx.w.eval(`sessionStorage.getItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}))`);
      const envelope = JSON.parse(rawStored);
      assert(envelope.version === 1, '3-envelope-version envelope version=1', JSON.stringify(envelope));
      assert(!('recovery_token' in envelope) && !('store_id' in envelope) && !('line_user_id' in envelope) && !('cart' in envelope) && !('order' in envelope) && !('price' in envelope), '3-envelope-no-forbidden-fields envelope 不含 raw token/store_id/line_user_id/cart/order/price', JSON.stringify(envelope));
      assert(envelope.member_session === 'member-session-A' && envelope.popup_session_public_code === 'sess-real', '3-envelope-allowed-fields envelope 只含允許欄位且值正確', JSON.stringify(envelope));
      assert(/^[0-9a-f]{64}$/.test(envelope.recovery_token_sha256), '3-envelope-digest-format digest 是 64 hex 字元', envelope.recovery_token_sha256);
      assert(envelope.expires_at - envelope.created_at <= 5 * 60 * 1000, '3-envelope-ttl TTL 不超過 5 分鐘', JSON.stringify({ created: envelope.created_at, expires: envelope.expires_at }));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-envelope-shape'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const handoffId = await ctx.w.eval("createPopupRecoveryHandoff('member-B','sess-real','raw-token-B')");
      const first = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-B')`);
      assert(first.ok === true && first.memberSession === 'member-B' && first.popupSessionPublicCode === 'sess-real', '3-consume-success 合法 envelope 可成功讀取一次', JSON.stringify(first));
      const second = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-B')`);
      assert(second.ok === false && second.reason === 'not_found', '3-consume-once-only 讀取後立即刪除，第二次讀取同一 key 失敗', JSON.stringify(second));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-consume-once'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const handoffId = await ctx.w.eval("createPopupRecoveryHandoff('member-C','sess-real','raw-token-C')");
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-WRONG', 'raw-token-C')`);
      assert(result.ok === false && result.reason === 'session_mismatch', '3-session-mismatch envelope 的 session code 與 URL 不符時拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-session-mismatch'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const handoffId = await ctx.w.eval("createPopupRecoveryHandoff('member-D','sess-real','raw-token-D')");
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-WRONG')`);
      assert(result.ok === false && result.reason === 'digest_mismatch', '3-digest-mismatch URL 上的 raw token 對不上 envelope 的 SHA-256 時拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-digest-mismatch'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof popupRecoveryHandoffKey==="function"'), { timeoutMs: 300 });
      const handoffId = 'expired-test-1';
      const now = Date.now();
      const digest = await ctx.w.eval("_sha256Hex('raw-token-E')");
      const envelope = { version: 1, member_session: 'm', popup_session_public_code: 'sess-real', recovery_token_sha256: digest, created_at: now - 10 * 60 * 1000, expires_at: now - 5 * 60 * 1000 };
      ctx.w.eval(`sessionStorage.setItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}), ${JSON.stringify(JSON.stringify(envelope))})`);
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-E')`);
      assert(result.ok === false && result.reason === 'expired', '3-expired-rejected 過期 envelope 被拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-expired'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof popupRecoveryHandoffKey==="function"'), { timeoutMs: 300 });
      const handoffId = 'future-test-1';
      const now = Date.now();
      const digest = await ctx.w.eval("_sha256Hex('raw-token-F')");
      const envelope = { version: 1, member_session: 'm', popup_session_public_code: 'sess-real', recovery_token_sha256: digest, created_at: now + 60 * 60 * 1000, expires_at: now + 65 * 60 * 1000 };
      ctx.w.eval(`sessionStorage.setItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}), ${JSON.stringify(JSON.stringify(envelope))})`);
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-F')`);
      assert(result.ok === false && result.reason === 'future_timestamp', '3-future-timestamp-rejected 未來時間戳的 envelope 被拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-future-timestamp'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof popupRecoveryHandoffKey==="function"'), { timeoutMs: 300 });
      const handoffId = 'malformed-test-1';
      ctx.w.eval(`sessionStorage.setItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}), '{not valid json')`);
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-G')`);
      assert(result.ok === false && result.reason === 'malformed_json', '3-malformed-json 損毀 JSON 被拒絕', JSON.stringify(result));
      assert(ctx.w.eval(`sessionStorage.getItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}))`) === null, '3-malformed-json-still-deleted 即使 JSON 損毀，讀取後仍然刪除該 key', 'n/a');
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-malformed-json'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof popupRecoveryHandoffKey==="function"'), { timeoutMs: 300 });
      const handoffId = 'version-test-1';
      const now = Date.now();
      const digest = await ctx.w.eval("_sha256Hex('raw-token-H')");
      const envelope = { version: 2, member_session: 'm', popup_session_public_code: 'sess-real', recovery_token_sha256: digest, created_at: now, expires_at: now + 60000 };
      ctx.w.eval(`sessionStorage.setItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}), ${JSON.stringify(JSON.stringify(envelope))})`);
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-H')`);
      assert(result.ok === false && result.reason === 'unknown_version', '3-unknown-version-rejected 未知 version 被拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-unknown-version'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof popupRecoveryHandoffKey==="function"'), { timeoutMs: 300 });
      const cases = [
        { member_session: 123 },
        {},
        { member_session: 'm', popup_session_public_code: 'sess-real' },
      ];
      for (let i = 0; i < cases.length; i++) {
        const handoffId = 'badfield-test-' + i;
        ctx.w.eval(`sessionStorage.setItem(popupRecoveryHandoffKey(${JSON.stringify(handoffId)}), ${JSON.stringify(JSON.stringify({ version: 1, ...cases[i] }))})`);
        const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-X')`);
        assert(result.ok === false, `3-bad-field-${i}-rejected 缺欄位/錯誤型別的 envelope（案例 ${i}）被拒絕`, JSON.stringify(result));
      }
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-bad-fields'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof consumePopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const result = await ctx.w.eval("consumePopupRecoveryHandoff('nonexistent-handoff-id', 'sess-real', 'raw-token-Y')");
      assert(result.ok === false && result.reason === 'not_found', '3-nonexistent-handoff 不存在的 handoff key 被拒絕', JSON.stringify(result));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-nonexistent-handoff'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const plantedId = await ctx.w.eval("createPopupRecoveryHandoff('planted-attacker-session','sess-real','planted-token')");
      const result = await ctx.w.eval("consumePopupRecoveryHandoff('totally-different-id-not-planted', 'sess-real', 'raw-token-Z')");
      assert(result.ok === false && result.reason === 'not_found', '3-no-scan-other-keys 指定不存在的 handoff id 時不會誤選攻擊者植入的其他 key', JSON.stringify(result));
      const plantedStillThere = ctx.w.eval(`sessionStorage.getItem(popupRecoveryHandoffKey(${JSON.stringify(plantedId)}))`) !== null;
      assert(plantedStillThere, '3-no-scan-other-keys-untouched 沒有指定的 handoff key 不會被誤刪其他 key', String(plantedStillThere));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-no-scan'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ignore');
    try {
      await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
      const xssPayload = '<img src=x onerror="window.__handoffXss=true">';
      const handoffId = await ctx.w.eval(`createPopupRecoveryHandoff(${JSON.stringify(xssPayload)}, 'sess-real', 'raw-token-XSS')`);
      const result = await ctx.w.eval(`consumePopupRecoveryHandoff(${JSON.stringify(handoffId)}, 'sess-real', 'raw-token-XSS')`);
      assert(result.ok === true && result.memberSession === xssPayload, '3-xss-payload-preserved-as-text XSS payload 原封不動當純文字保存/取回', JSON.stringify(result));
      assert(!ctx.w.eval('window.__handoffXss'), '3-xss-not-executed 沒有被當成可執行 HTML 執行', String(ctx.w.eval('window.__handoffXss')));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-xss-payload'); ctx.cleanup(); }
  }

  {
    const calls = [];
    const routes = (u) => { calls.push(u); if (u.includes('popup-session/sess-ordinary')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { public_code: 'sess-ordinary', name: 'S', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00', product_scope: 'all_takeout', products: [], payment_methods: ['cash'], effective_state: 'ordering_open', can_order: true, campaign: { public_code: 'c', name: 'C' } } }) }); return Promise.reject(new Error('unexpected: ' + u)); };
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ordinary', { fetchImpl: routes });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assert(!calls.some((u) => u.includes('resolve-target')), '4-ordinary-no-resolve-target 一般 popup entry 不呼叫 /resolve-target', JSON.stringify(calls));
      assert(!calls.some((u) => u.includes('liff.line.me')), '4-ordinary-no-liff 一般 popup entry 不呼叫任何 LIFF 端點', JSON.stringify(calls));
      assert(ctx.w.eval('popupRecoveryContext.active') === false, '4-ordinary-no-recovery-context 一般 popup entry 的 popupRecoveryContext 保持 inactive', String(ctx.w.eval('popupRecoveryContext.active')));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '4-ordinary'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ordinary2', {
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { public_code: 'sess-ordinary2', name: 'S', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00', product_scope: 'all_takeout', products: [], payment_methods: ['cash'], effective_state: 'ordering_open', can_order: true, campaign: { public_code: 'c', name: 'C' } } }) }),
      presetSessionStorage: { line_popup_recovery_identity_v1_planted: JSON.stringify({ version: 1, member_session: 'planted', popup_session_public_code: 'sess-ordinary2', recovery_token_sha256: '0'.repeat(64), created_at: Date.now(), expires_at: Date.now() + 60000 }) },
    });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assert(ctx.w.eval('popupRecoveryContext.active') === false, '4-ordinary-ignores-planted-envelope 一般 entry 完全不去讀取任何預先存在的 handoff envelope', String(ctx.w.eval('popupRecoveryContext.active')));
      assert(ctx.w.eval("sessionStorage.getItem('line_popup_recovery_identity_v1_planted')") !== null, '4-ordinary-does-not-delete-others 一般 entry 也沒有誤刪這個不相關的 key', 'n/a');
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '4-ordinary-ignores-planted'); ctx.cleanup(); }
  }

  {
    const posts = [];
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAWLAND1&popup_session=claim-A', {
      fetchImpl: (u, init) => {
        if (String(u).includes('resolve-target')) {
          posts.push(JSON.parse(init.body));
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { page_type: 'popup_order', target_path: '/popup-order?session=server-derived-code', popup_session_public_code: 'server-derived-code' } }) });
        }
        return Promise.reject(new Error('unexpected: ' + u));
      },
    });
    try {
      await ctx.settle(() => ctx.w.eval('typeof _acquirePopupRecoveryMemberSession==="function"'), { timeoutMs: 300 });
      ctx.w.eval('_acquirePopupRecoveryMemberSession = async () => "injected-member-session-for-test";');
      ctx.w.eval('initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT);');
      const navigated = await waitFor(() => { try { return ctx.w.eval('window.__testNavigatedTo') && ctx.w.eval('window.__testNavigatedTo').includes('recovery_handoff='); } catch (e) { return false; } }, { timeoutMs: 800 });
      assert(navigated, '5-landing-navigates-with-handoff landing 成功後導向帶有 recovery_handoff 的網址', (ctx.w.eval('window.__testNavigatedTo')||''));
      assert((ctx.w.eval('window.__testNavigatedTo')||'').includes('session=server-derived-code'), '5-landing-uses-server-session 導向網址的 session 使用伺服器回應的值', (ctx.w.eval('window.__testNavigatedTo')||''));
      assert(posts.length === 1 && Object.keys(posts[0]).sort().join(',') === 'member_session,recovery_token', '5-landing-resolve-target-payload /resolve-target 呼叫只帶 recovery_token + member_session', JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '5-landing-happy-path'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAWLAND2&popup_session=claim-B', {
      fetchImpl: (u) => { if (String(u).includes('resolve-target')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, reason: 'uid_mismatch' }) }); return Promise.reject(new Error('unexpected')); },
    });
    try {
      ctx.w.eval('_acquirePopupRecoveryMemberSession = async () => "wrong-user-session";');
      ctx.w.eval('initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT);');
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 800 });
      assert(!(ctx.w.eval('window.__testNavigatedTo')||'').includes('recovery_handoff'), '5-landing-failure-no-handoff resolve-target 失敗時不建立 handoff、不導向', (ctx.w.eval('window.__testNavigatedTo')||''));
      const anyHandoffKeys = ctx.w.eval("Object.keys(sessionStorage).filter(k=>k.startsWith('line_popup_recovery_identity_v1_'))");
      assert(anyHandoffKeys.length === 0, '5-landing-failure-no-sessionstorage-writes 沒有寫入任何 handoff envelope', JSON.stringify(anyHandoffKeys));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '5-landing-failure'); ctx.cleanup(); }
  }
  {
    const ctx = await createHarness('http://localhost/popup-order?recovery_token=RAWLAND3&popup_session=attacker-claimed-code', {
      fetchImpl: (u, init) => {
        if (String(u).includes('resolve-target')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { page_type: 'popup_order', target_path: '/popup-order?session=real-server-code', popup_session_public_code: 'real-server-code' } }) });
        return Promise.reject(new Error('unexpected'));
      },
    });
    try {
      ctx.w.eval('_acquirePopupRecoveryMemberSession = async () => "member-session-real";');
      ctx.w.eval('initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT);');
      await waitFor(() => { try { return ctx.w.eval('window.__testNavigatedTo') && ctx.w.eval('window.__testNavigatedTo').includes('recovery_handoff='); } catch (e) { return false; } }, { timeoutMs: 800 });
      assert(!(ctx.w.eval('window.__testNavigatedTo')||'').includes('attacker-claimed-code'), '5-landing-ignores-client-claim 最終導向不使用 client 偽造宣稱的場次代碼', (ctx.w.eval('window.__testNavigatedTo')||''));
      assert((ctx.w.eval('window.__testNavigatedTo')||'').includes('real-server-code'), '5-landing-uses-real-server-code 最終導向使用伺服器回應的真正場次代碼', (ctx.w.eval('window.__testNavigatedTo')||''));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '5-landing-ignores-claim'); ctx.cleanup(); }
  }

  {
    const landingCtx = await createHarness('http://localhost/popup-order?recovery_token=RAWNAV&popup_session=claim-nav', {
      fetchImpl: (u, init) => {
        if (String(u).includes('resolve-target')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { page_type: 'popup_order', target_path: '/popup-order?session=nav-session', popup_session_public_code: 'nav-session' } }) });
        return Promise.reject(new Error('unexpected'));
      },
    });
    let handoffKey, handoffValue, finalUrl;
    try {
      landingCtx.w.eval('_acquirePopupRecoveryMemberSession = async () => "member-session-nav";');
      landingCtx.w.eval('initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT);');
      await waitFor(() => { try { return landingCtx.w.eval('window.__testNavigatedTo') && landingCtx.w.eval('window.__testNavigatedTo').includes('recovery_handoff='); } catch (e) { return false; } }, { timeoutMs: 800 });
      finalUrl = landingCtx.w.eval('window.__testNavigatedTo');
      const keys = landingCtx.w.eval("Object.keys(sessionStorage).filter(k=>k.startsWith('line_popup_recovery_identity_v1_'))");
      assert(keys.length === 1, '6-landing-writes-exactly-one-envelope landing 成功後 sessionStorage 恰好多出一個 handoff envelope', JSON.stringify(keys));
      handoffKey = keys[0];
      handoffValue = landingCtx.w.sessionStorage.getItem(handoffKey);
    } finally { await landingCtx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(landingCtx, '6-landing-window'); landingCtx.cleanup(); }

    const finalPath = finalUrl.replace(/^https?:\/\/[^/]+/, '');
    const sessionStorageSeed = {};
    sessionStorageSeed[handoffKey] = handoffValue;
    const fixture = { success: true, data: { public_code: 'nav-session', name: 'NavSession', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00', product_scope: 'all_takeout', products: [], payment_methods: ['cash'], effective_state: 'ordering_open', can_order: true, campaign: { public_code: 'c', name: 'C' } } };
    const nextCtx = await createHarness('http://localhost' + finalPath, {
      presetSessionStorage: sessionStorageSeed,
      fetchImpl: (u) => { if (String(u).includes('popup-session/nav-session')) return Promise.resolve({ ok: true, status: 200, json: async () => fixture }); return Promise.reject(new Error('unexpected: ' + u)); },
    });
    try {
      await waitFor(() => { try { return nextCtx.w.eval('popupRecoveryContext.active===true || popupError!==null'); } catch (e) { return false; } }, { timeoutMs: 1200 });
      assert(nextCtx.w.eval('popupRecoveryContext.active') === true, '6-nav-receives-envelope 模擬同源 navigation 後，新視窗成功接收並驗證 envelope', nextCtx.w.eval('JSON.stringify(popupRecoveryContext)'));
      assert(nextCtx.w.eval('popupRecoveryContext.memberSession') === 'member-session-nav', '6-nav-member-session-correct 接收到的 memberSession 正確', nextCtx.w.eval('popupRecoveryContext.memberSession'));
      assert(nextCtx.w.eval(`sessionStorage.getItem(${JSON.stringify(handoffKey)})`) === null, '6-nav-envelope-deleted-after-receive envelope 接收後立即從 sessionStorage 刪除', 'n/a');
      assert(nextCtx.w.eval('popupSession') !== null, '6-nav-loads-session envelope 驗證通過後正常載入 popup session', String(nextCtx.w.eval('popupSession')));
    } finally { await nextCtx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(nextCtx, '6-nav-window'); nextCtx.cleanup(); }
  }
  {
    const landingCtx = await createHarness('http://localhost/popup-order?recovery_token=RAWNAV2&popup_session=claim-nav2', {
      fetchImpl: (u, init) => {
        if (String(u).includes('resolve-target')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { page_type: 'popup_order', target_path: '/popup-order?session=nav-session-2', popup_session_public_code: 'nav-session-2' } }) });
        return Promise.reject(new Error('unexpected'));
      },
    });
    let handoffKey, handoffValue, finalUrl;
    try {
      landingCtx.w.eval('_acquirePopupRecoveryMemberSession = async () => "member-session-nav2";');
      landingCtx.w.eval('initPopupRecoveryLiffLanding(POPUP_ENTRY_CONTEXT);');
      await waitFor(() => { try { return landingCtx.w.eval('window.__testNavigatedTo') && landingCtx.w.eval('window.__testNavigatedTo').includes('recovery_handoff='); } catch (e) { return false; } }, { timeoutMs: 800 });
      finalUrl = landingCtx.w.eval('window.__testNavigatedTo');
      const keys = landingCtx.w.eval("Object.keys(sessionStorage).filter(k=>k.startsWith('line_popup_recovery_identity_v1_'))");
      handoffKey = keys[0];
      handoffValue = landingCtx.w.sessionStorage.getItem(handoffKey);
    } finally { landingCtx.cleanup(); }
    const finalPath = finalUrl.replace(/^https?:\/\/[^/]+/, '');
    const seed = {}; seed[handoffKey] = handoffValue;
    const firstLoad = await createHarness('http://localhost' + finalPath, { presetSessionStorage: seed, fetchImpl: () => Promise.reject(new Error('n/a')) });
    try { await waitFor(() => { try { return firstLoad.w.eval('popupRecoveryContext.active===true||popupError!==null'); } catch (e) { return false; } }, { timeoutMs: 800 }); } finally { firstLoad.cleanup(); }
    const secondLoad = await createHarness('http://localhost' + finalPath, { fetchImpl: () => Promise.reject(new Error('n/a')) });
    try {
      await waitFor(() => secondLoad.w.eval('popupError') !== null, { timeoutMs: 800 });
      assert(secondLoad.w.eval('popupRecoveryContext.active') === false, '6-reload-cannot-reuse 重整後（envelope 已被消費/刪除）無法再次使用同一 handoff', String(secondLoad.w.eval('popupRecoveryContext.active')));
    } finally { await secondLoad.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(secondLoad, '6-reload-cannot-reuse'); secondLoad.cleanup(); }
  }

  console.log('\n[NOTE] LIFF 實際登入／member-session 取得（_acquirePopupRecoveryMemberSession）目前刻意回傳 null——已知架構缺口，本測試檔案透過直接注入 member session 驗證 landing 剩餘邏輯，不代表該缺口已解決，也不代表已完成端到端 LIFF 驗證。');
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
