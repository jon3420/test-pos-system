// scripts/lib/c4-line-mock.js — R54.4／MBV2-HF1-C4 測試專用 preload（node -r，必須在 hf1c3-net-mock.js 之後載入）
//
// 只在測試子程序載入；正式部署不會載入此檔。
// 攔截所有送往 https://api.line.me/v2/bot/message/push 的 fetch，「完全不連外」，依控制檔模擬 LINE 官方回應：
//   - 已受理過的 X-Line-Retry-Key 再送 → 409 + x-line-accepted-request-id（官方 retry-key 語意）
//   - 行為（依收件人 UID 的序列逐次取用，或 default）：
//       200            受理（記錄 retry key）並回 200 + x-line-request-id
//       timeout        丟出 AbortError（未受理）
//       hang           不回應，直到呼叫端逾時中止（測試真實 AbortController 路徑）
//       accepted_lost  先受理（記錄 retry key），再丟出連線錯誤（模擬「已受理但回應遺失」）
//       accepted_hang  先受理，再掛住不回應（模擬送出後、寫回結果前服務中斷）
//       500／400／401／403  對應狀態碼（未受理）
//       429_rate／429_quota   速率限制／當月額度用完（未受理）
//       409_other      409 但不是 retry-key 已受理（無 accepted id）
// 控制檔：C4_LINE_MOCK_CTRL（JSON：{ default, byUser:{ uid:[...] } }）；狀態（已受理 key、各 UID 已用次數）
// 寫在 C4_LINE_MOCK_STATE，可跨伺服器重啟保留（與真實 LINE 一致：重啟後同 key 仍回 409）。
// 每次呼叫記錄在 C4_LINE_MOCK_LOG（JSON Lines），只含遮罩後 UID、retry key、內容雜湊與模擬行為。
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const CTRL = process.env.C4_LINE_MOCK_CTRL || '';
const STATE = process.env.C4_LINE_MOCK_STATE || '';
const LOG = process.env.C4_LINE_MOCK_LOG || '';
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function writeJson(f, v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch {} }
function log(entry) { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {} } }

function resp(status, body, headers) {
  return new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } });
}
function rid() { return crypto.randomUUID(); }

const prevFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (!/^https:\/\/api\.line\.me\/v2\/bot\/message\/push/.test(u)) return prevFetch(input, init);
  const headers = (init && init.headers) || {};
  const key = headers['X-Line-Retry-Key'] || headers['x-line-retry-key'] || null;
  const auth = String(headers.Authorization || headers.authorization || '');
  let body = {};
  try { body = JSON.parse((init && init.body) || '{}'); } catch {}
  const to = String(body.to || '');
  const bodyHash = crypto.createHash('sha256').update(String((init && init.body) || '')).digest('hex').slice(0, 16);
  const ctrl = readJson(CTRL, {});
  const state = readJson(STATE, { accepted: {}, used: {} });
  const seq = (ctrl.byUser && ctrl.byUser[to]) || null;
  let behavior;
  if (seq && seq.length) {
    const n = state.used[to] || 0;
    behavior = seq[Math.min(n, seq.length - 1)];
    state.used[to] = n + 1;
  } else behavior = ctrl.default || '200';
  const text = Array.isArray(body.messages) ? body.messages.map((m) => (m && m.text) || '').join('\n') : '';
  // C4.1：另記錄訊息文字（測試用暫存檔），用來核對連結屬於哪個店別／LIFF／商品
  const entry = { at: Date.now(), to: to.slice(0, 5) + '…' + to.slice(-4), uid: to, retry_key: key, body_hash: bodyHash, behavior, auth_present: /^Bearer .+/.test(auth), text };
  if (key && state.accepted[key]) {
    entry.result = 409; writeJson(STATE, state); log(entry);
    return resp(409, { message: 'The retry key is already accepted', sentMessages: [{ id: '1', quoteToken: 'q' }] },
      { 'x-line-request-id': rid(), 'x-line-accepted-request-id': state.accepted[key] });
  }
  const accept = () => { const id = rid(); if (key) state.accepted[key] = id; return id; };
  const signal = init && init.signal;
  const hang = () => new Promise((_, rej) => {
    const ab = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e); };
    if (signal) { if (signal.aborted) ab(); else signal.addEventListener('abort', ab); }
  });
  switch (behavior) {
    case '200': { const id = accept(); entry.result = 200; writeJson(STATE, state); log(entry); return resp(200, { sentMessages: [{ id: '1', quoteToken: 'q' }] }, { 'x-line-request-id': id }); }
    case 'timeout': { entry.result = 'timeout'; writeJson(STATE, state); log(entry); const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
    case 'hang': { entry.result = 'hang'; writeJson(STATE, state); log(entry); return hang(); }
    case 'accepted_lost': { accept(); entry.result = 'accepted_lost'; writeJson(STATE, state); log(entry); throw new TypeError('fetch failed'); }
    case 'accepted_hang': { accept(); entry.result = 'accepted_hang'; writeJson(STATE, state); log(entry); return hang(); }
    case '429_rate': entry.result = 429; writeJson(STATE, state); log(entry); return resp(429, { message: 'The API rate limit has been exceeded. Try again later.' }, { 'x-line-request-id': rid() });
    case '429_quota': entry.result = 429; writeJson(STATE, state); log(entry); return resp(429, { message: 'You have reached your monthly limit.' }, { 'x-line-request-id': rid() });
    case '409_other': entry.result = 409; writeJson(STATE, state); log(entry); return resp(409, { message: 'Conflict' }, { 'x-line-request-id': rid() });
    default: {
      const code = Number(behavior) || 500;
      entry.result = code; writeJson(STATE, state); log(entry);
      return resp(code, { message: code === 400 ? 'The request body has 1 error(s)' : 'error', details: [] }, { 'x-line-request-id': rid() });
    }
  }
};
