#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js
// R54.4／MBV2-HF1-C4：utils/linePush.js 擴充（retryKey／timeoutMs／detailed）向後相容驗證。
// 以程序內替換 global fetch 模擬 LINE 回應，不連外、不發送任何真實訊息。
'use strict';
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + (detail ? '\n     ' + detail : '')); } }
const calls = [];
let behave = () => new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-1' } });
globalThis.fetch = async (url, init) => { calls.push({ url, init }); return behave(url, init); };
const { sendLinePush } = require(path.join(ROOT, 'utils', 'linePush.js'));
const deq = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const K = '3f1c2b9e-1a2b-4c3d-9e8f-0123456789ab';
(async () => {
  const msgs = [{ type: 'text', text: 'hi' }];
  // ── 既有呼叫端（Recovery）：三個參數 ──
  let r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs });
  ok(deq(r, { success: true, status: 200 }), 'LC1 既有呼叫（無 retryKey）成功回傳值與 C3.3 完全相同 {success,status}', JSON.stringify(r));
  const h = calls[0].init.headers;
  ok(!('X-Line-Retry-Key' in h) && h.Authorization === 'Bearer tok-abcdefgh' && calls[0].init.body === JSON.stringify({ to: 'Uabc', messages: msgs }) && calls[0].init.method === 'POST' && calls[0].url === 'https://api.line.me/v2/bot/message/push',
    'LC2 既有呼叫的請求內容不變（不帶 retry key，endpoint／header／body 相同）', JSON.stringify(h));
  behave = () => new Response('{"message":"x"}', { status: 500 });
  r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs });
  ok(deq(r, { success: false, status: 500, error_code: 'line_api_error' }), 'LC3 既有呼叫非 200 回傳值不變', JSON.stringify(r));
  behave = () => { throw new TypeError('fetch failed'); };
  r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs });
  ok(deq(r, { success: false, status: 0, error_code: 'network_error' }), 'LC4 既有呼叫網路錯誤回傳值不變', JSON.stringify(r));
  const n0 = calls.length;
  r = await sendLinePush({ channelAccessToken: '', lineUserId: 'Uabc', messages: msgs });
  const r2 = await sendLinePush({ channelAccessToken: 'tok', lineUserId: '', messages: msgs });
  ok(deq(r, { success: false, status: 0, error_code: 'not_configured' }) && deq(r2, { success: false, status: 0, error_code: 'invalid_input' }) && calls.length === n0, 'LC5 未設定／輸入錯誤：回傳值不變且完全不打網路');
  // ── 新選用參數 ──
  behave = () => new Response('{}', { status: 200, headers: { 'x-line-request-id': 'req-200' } });
  r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs, retryKey: K });
  ok(calls[calls.length - 1].init.headers['X-Line-Retry-Key'] === K && r.success && r.result_class === 'accepted' && r.request_id === 'req-200', 'LC6 retryKey：第一次請求即帶 X-Line-Retry-Key；200 → accepted 並保存 request ID', JSON.stringify(r));
  behave = () => new Response('{"message":"The retry key is already accepted"}', { status: 409, headers: { 'x-line-request-id': 'req-b', 'x-line-accepted-request-id': 'req-a' } });
  r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs, retryKey: K });
  ok(r.success && r.result_class === 'accepted_conflict' && r.accepted_request_id === 'req-a', 'LC7 官方 retry-key 409 → 已受理（帶 accepted request ID）', JSON.stringify(r));
  behave = () => new Response('{"message":"Conflict"}', { status: 409 });
  r = await sendLinePush({ channelAccessToken: 'tok-abcdefgh', lineUserId: 'Uabc', messages: msgs, retryKey: K });
  ok(!r.success && r.result_class === 'unknown_final', 'LC8 非 retry-key 語意的 409 → 結果不明（不可換 key 重送）', JSON.stringify(r));
  behave = () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 });
  const q = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K });
  behave = () => new Response('{"message":"The API rate limit has been exceeded. Try again later."}', { status: 429 });
  const rl = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K });
  behave = () => new Response('{"message":"Authentication failed"}', { status: 401 });
  const au = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K });
  behave = () => new Response('{"message":"bad"}', { status: 400 });
  const bd = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K });
  behave = () => new Response('', { status: 503 });
  const s5 = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K });
  ok(q.result_class === 'quota' && rl.result_class === 'rate_limited' && au.result_class === 'auth' && bd.result_class === 'rejected' && s5.result_class === 'unknown_retryable',
    'LC9 分類：當月額度、速率限制、權杖錯誤、驗證錯誤、5xx（可同 key 重試）', JSON.stringify([q.result_class, rl.result_class, au.result_class, bd.result_class, s5.result_class]));
  behave = (u, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
  const t0 = Date.now();
  const to = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: K, timeoutMs: 300 });
  ok(to.result_class === 'unknown_retryable' && to.error_code === 'timeout' && Date.now() - t0 < 2000, 'LC10 timeoutMs：真實逾時中止 → 結果不明（不視為未送出）', JSON.stringify(to));
  const n1 = calls.length;
  const bk = await sendLinePush({ channelAccessToken: 't', lineUserId: 'U', messages: msgs, retryKey: 'not-a-uuid' });
  ok(bk.error_code === 'invalid_retry_key' && calls.length === n1, 'LC11 retry key 格式錯誤：不送出');
  const out = JSON.stringify([r, q, rl, au, bd, s5, to]);
  ok(!/tok-abcdefgh|Bearer/.test(out), 'LC12 回傳值不含權杖或 Authorization');
  console.log(`\n模擬 fetch 呼叫次數（程序內）：${calls.length}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed（全部為程序內模擬，真實 LINE 呼叫 0 次）`);
  process.exit(fail ? 1 : 0);
})();
