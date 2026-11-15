// scripts/lib/c54-linepay-mock.js — R54.4／MBV2-HF1-C5.4 測試專用 preload（node -r；正式部署不載入）
// 由 c53-linepay-mock.js 複製，額外提供：confirmBody 'txNear'（交易識別只差最後一位，JS Number 下與原值相等）、
//   confirmMode 'dropBefore'（尚未扣款就回應遺失）。其餘行為與 C5.3 替身完全相同（C5.3 測試仍使用原檔）。
// 由 c51-linepay-mock.js 延伸，額外提供 C5.3 的回應變體；未知的 LINE Pay 路徑一律記錄並拋錯（不落到真實金流）。
//   ctrl.confirm + ctrl.captureThen=true：先完成扣款，再回傳指定代碼（例如 1152 重複交易、未知代碼）
//   ctrl.confirmBody: 'only0000'（只有 returnCode）｜'noOrderId'｜'noPayInfo'｜'amountString'｜'txOther'
//   ctrl.inquiry 另加：'noType'｜'typeEmpty'｜'typeNull'｜'typeRefund'｜'typeNumber'｜'multiple'｜'amountString'｜'amountNull'｜'noPayInfo'
//   C53_LINEPAY_UNEXPECTED：未知 LINE Pay 路徑的紀錄檔（必須為 0 行）
// 有狀態的 LINE Pay v3 替身：攔截 node-fetch 與全域 fetch 送往 *pay.line.me 的請求，完全不連外。
//   - Request（POST /v3/payments/request）：每次回傳唯一的 19 位數 transactionId（JSON 數字，超出 JS 安全整數範圍）。
//   - Confirm（POST /v3/payments/{tx}/confirm）：未知交易 → 1150；金額不符 → 1106（替身代碼）；已確認 → ctrl.reconfirm（預設 1172）。
//   - Retrieve payment details（GET /v3/payments?transactionId=&orderId=）：唯讀；只回傳「已確認」的交易；查無 → info:[]。
//   - 簽章：C51_LINEPAY_SECRETS（JSON {channelId: secret}）有設定時，核對 X-LINE-Authorization
//     （POST：secret+path+body+nonce；GET：secret+path+queryString+nonce），不符 → 1106，並記錄 sig_ok=false。
//   C51_LINEPAY_CTRL（JSON；每次請求重新讀取）：
//     request: code                 Request 強制回傳代碼
//     confirm: code                 Confirm 強制回傳代碼（不改變交易狀態）
//     reconfirm: code               已確認交易再次 Confirm 的回傳（預設 1172）
//     allowUnknown: true            未知交易也可 Confirm（模擬升級前建立的付款）
//     confirmMode: 'drop'           先完成扣款，再讓回應遺失（拋出網路錯誤）
//                  'garbage'        先完成扣款，回應內容無法解析
//                  'hang'           先完成扣款，回應永遠不回（用於中止程序）
//     confirmDelayMs: n             先完成扣款，等待 n 毫秒後才回應
//     confirmDelayBeforeMs: n       等待 n 毫秒後才處理（尚未扣款）
//     inquiry: 'normal'|'error'|'timeout'|'empty'|'unparseable'|'amount'|'currency'|'order'|'refunded'|'1150'
//   C51_LINEPAY_STATE：交易狀態檔；C51_LINEPAY_LOG：每次呼叫一行 JSON；C51_LINEPAY_REAL：未被攔截的 LINE 請求（必須為 0 行）
'use strict';
const Module = require('module');
const fs = require('fs');
const crypto = require('crypto');
const CTRL = process.env.C51_LINEPAY_CTRL || '';
const STATE = process.env.C51_LINEPAY_STATE || '';
const LOG = process.env.C51_LINEPAY_LOG || '';
const REAL = process.env.C51_LINEPAY_REAL || '';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeState = (s) => { if (STATE) fs.writeFileSync(STATE, JSON.stringify(s)); };
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} } };
let seq = 0;
function nextTx() { seq++; return '9' + String(Date.now() % 1e9).padStart(9, '0') + String(process.pid % 1000).padStart(3, '0') + String(seq).padStart(6, '0'); } // 19 位
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hdr(init, k) { const h = (init && init.headers) || {}; return h[k] || h[k.toLowerCase()] || ''; }
function sigOk(method, path, qsOrBody, init) {
  const secrets = (() => { try { return JSON.parse(process.env.C51_LINEPAY_SECRETS || ''); } catch { return null; } })();
  if (!secrets) return null;
  const cid = hdr(init, 'X-LINE-ChannelId'), nonce = hdr(init, 'X-LINE-Authorization-Nonce'), sig = hdr(init, 'X-LINE-Authorization');
  const sec = secrets[cid];
  if (!sec || !nonce || !sig) return false;
  const want = crypto.createHmac('sha256', sec).update(sec + path + qsOrBody + nonce, 'utf8').digest('base64');
  return want === sig;
}
const resp = (text) => ({ ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text });
async function handle(u, init) {
  const ctrl = readJson(CTRL, {});
  const method = String((init && init.method) || 'GET').toUpperCase();
  const url = new URL(u);
  const path = url.pathname;
  const qs = url.search ? url.search.slice(1) : '';
  let body = {};
  try { body = init && init.body ? JSON.parse(init.body) : {}; } catch {}
  const so = sigOk(method, path, method === 'GET' ? qs : String((init && init.body) || ''), init);
  if (so === false) { log({ uri: path, method, code: '1106', sig_ok: false }); return resp(JSON.stringify({ returnCode: '1106', returnMessage: 'mock signature' })); }
  if (method === 'POST' && /\/v3\/payments\/request$/.test(path)) {
    const code = ctrl.request || '0000';
    if (code !== '0000') { log({ uri: path, code }); return resp(JSON.stringify({ returnCode: code, returnMessage: 'mock' })); }
    const st = readJson(STATE, { tx: {} });
    const tx = nextTx();
    st.tx[tx] = { orderId: body.orderId, amount: body.amount, currency: body.currency, confirmUrl: body.redirectUrls && body.redirectUrls.confirmUrl, confirmed: false, channel: hdr(init, 'X-LINE-ChannelId') };
    writeState(st);
    log({ uri: path, code: '0000', tx, orderId: body.orderId, amount: body.amount, confirmUrl: body.redirectUrls && body.redirectUrls.confirmUrl, sig_ok: so });
    return resp(`{"returnCode":"0000","returnMessage":"Success.","info":{"transactionId":${tx},"paymentAccessToken":"mock","paymentUrl":{"web":"https://example.invalid/pay?tx=${tx}","app":"line://pay"}}}`);
  }
  const mc = /\/v3\/payments\/([A-Za-z0-9_-]+)\/confirm$/.exec(path);
  if (method === 'POST' && mc) {
    const tx = mc[1];
    if (ctrl.confirmDelayBeforeMs) await sleep(ctrl.confirmDelayBeforeMs);
    if (ctrl.confirmMode === 'dropBefore') { log({ uri: path, method, code: 'drop_before', tx: mc[1], sig_ok: so }); const e = new Error('mock: request lost before capture'); e.code = 'ECONNRESET'; throw e; }
    const st = readJson(STATE, { tx: {} });
    const rec = st.tx[tx];
    let code;
    if (ctrl.confirm && ctrl.captureThen && rec && !rec.confirmed && Number(rec.amount) === Number(body.amount)) { rec.confirmed = true; rec.confirmCount = (rec.confirmCount || 0) + 1; writeState(st); code = ctrl.confirm; }
    else if (ctrl.confirm) code = ctrl.confirm;
    else if (!rec && !ctrl.allowUnknown) code = '1150';
    else if (rec && Number(rec.amount) !== Number(body.amount)) code = '1106';
    else if (rec && rec.confirmed) code = ctrl.reconfirm || '1172';
    else code = '0000';
    if (code === '0000') {
      if (!rec) st.tx[tx] = { confirmed: true, amount: body.amount, currency: body.currency || 'TWD', orderId: ctrl.unknownOrderId || null };
      else rec.confirmed = true;
      st.tx[tx].confirmCount = (st.tx[tx].confirmCount || 0) + 1;
      writeState(st);
    }
    const oid = rec ? rec.orderId : (ctrl.unknownOrderId || 'unknown');
    log({ uri: path, method, code, tx, amount: body.amount, mode: ctrl.confirmMode || '', sig_ok: so });
    if (ctrl.confirmDelayMs) await sleep(ctrl.confirmDelayMs);
    if (ctrl.confirmMode === 'drop') { const e = new Error('mock: response lost'); e.code = 'ECONNRESET'; throw e; }
    if (ctrl.confirmMode === 'hang') await new Promise(() => {});
    if (ctrl.confirmMode === 'garbage') return resp('<html>502 Bad Gateway');
    if (code === '0000') {
      const cb = ctrl.confirmBody || '';
      if (cb === 'only0000') return resp('{"returnCode":"0000"}');
      const oidPart = cb === 'noOrderId' ? '' : `"orderId":${JSON.stringify(oid)},`;
      const txPart = cb === 'txOther' ? '1234567890123456789' : cb === 'txNear' ? tx.slice(0, -1) + String((Number(tx.slice(-1)) + 1) % 10) : tx;
      const pay = cb === 'noPayInfo' ? '' : `,"payInfo":[{"method":"BALANCE","amount":${cb === 'amountString' ? JSON.stringify(String(Number(body.amount))) : Number(body.amount)}}]`;
      return resp(`{"returnCode":"0000","returnMessage":"OK","info":{${oidPart}"transactionId":${txPart}${pay}}}`);
    }
    return resp(JSON.stringify({ returnCode: code, returnMessage: 'mock' }));
  }
  if (method === 'GET' && path === '/v3/payments') {
    const p = url.searchParams;
    const tx = p.get('transactionId') || p.get('transactionId[]') || '';
    const oid = p.get('orderId') || p.get('orderId[]') || '';
    const mode = ctrl.inquiry || 'normal';
    log({ uri: path, method, tx, orderId: oid, mode, sig_ok: so });
    if (mode === 'timeout') { await sleep(30); const e = new Error('mock: inquiry timeout'); e.type = 'request-timeout'; throw e; }
    if (mode === 'error') return resp(JSON.stringify({ returnCode: '9000', returnMessage: 'mock internal error' }));
    if (mode === 'unparseable') return resp('<<not json>>');
    if (mode === '1150') return resp(JSON.stringify({ returnCode: '1150', returnMessage: 'no transaction' }));
    const st = readJson(STATE, { tx: {} });
    const rec = st.tx[tx];
    if (mode === 'empty' || !rec || !rec.confirmed || (oid && rec.orderId && rec.orderId !== oid)) return resp('{"returnCode":"0000","returnMessage":"Success.","info":[]}');
    const amount = mode === 'amount' ? Number(rec.amount) + 1 : Number(rec.amount);
    const currency = mode === 'currency' ? 'JPY' : (rec.currency || 'TWD');
    const orderId = mode === 'order' ? String(rec.orderId) + 'X' : String(rec.orderId || oid);
    const typePart = mode === 'noType' ? '' : mode === 'typeEmpty' ? '"transactionType":"",' : mode === 'typeNull' ? '"transactionType":null,' : mode === 'typeRefund' ? '"transactionType":"PARTIAL_REFUND",' : mode === 'typeNumber' ? '"transactionType":1,' : '"transactionType":"PAYMENT",';
    const amtJson = mode === 'amountString' ? JSON.stringify(String(amount)) : mode === 'amountNull' ? 'null' : String(amount);
    const payPart = mode === 'noPayInfo' ? '' : `"payInfo":[{"method":"BALANCE","amount":${amtJson}}],`;
    if (['noType', 'typeEmpty', 'typeNull', 'typeRefund', 'typeNumber', 'amountString', 'amountNull', 'noPayInfo', 'multiple'].includes(mode)) {
      const one = `{"transactionId":${tx},"transactionDate":"2026-11-14T00:00:00Z",${typePart}${payPart}"productName":"x","currency":"${currency}","orderId":${JSON.stringify(orderId)}}`;
      return resp(`{"returnCode":"0000","returnMessage":"Success.","info":[${mode === 'multiple' ? one + ',' + one : one}]}`);
    }
    const refunds = mode === 'refunded' ? `,"refundList":[{"refundTransactionId":1,"transactionType":"PAYMENT_REFUND","refundAmount":-${amount},"refundTransactionDate":"2026-11-14T00:00:00Z"}]` : '';
    return resp(`{"returnCode":"0000","returnMessage":"Success.","info":[{"transactionId":${tx},"transactionDate":"2026-11-14T00:00:00Z","transactionType":"PAYMENT","payInfo":[{"method":"BALANCE","amount":${amount}}],"productName":"x","currency":"${currency}","orderId":${JSON.stringify(orderId)}${refunds}}]}`);
  }
  // 未知 LINE Pay 路徑：記錄並拋錯（不得落到真實金流，也不得回傳假成功）
  log({ uri: path, method, unexpected: true });
  if (process.env.C53_LINEPAY_UNEXPECTED) fs.appendFileSync(process.env.C53_LINEPAY_UNEXPECTED, method + ' ' + path + '\n');
  throw new Error('c53 mock: unexpected LINE Pay call ' + method + ' ' + path);
}
const isPay = (u) => /pay\.line\.me/.test(String(u || ''));
const origLoad = Module._load;
let wrapped = null;
Module._load = function (request, parent, isMain) {
  const real = origLoad.apply(this, arguments);
  if (request !== 'node-fetch') return real;
  if (wrapped) return wrapped;
  const fn = async function (url, init) { if (isPay(url)) return handle(String(url), init); return real(url, init); };
  Object.assign(fn, real);
  wrapped = fn;
  return wrapped;
};
// 全域 fetch（undici）也攔截：LINE Pay 一律走替身；其他 LINE 網域若漏網則記錄為「真實呼叫嘗試」並拒絕
if (typeof globalThis.fetch === 'function') {
  const gf = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (isPay(u)) return handle(u, init);
    if (/api\.line\.me|api-data\.line\.me|access\.line\.me/.test(u) && !process.env.C4_LINE_MOCK_LOG) { if (REAL) fs.appendFileSync(REAL, u + '\n'); throw new Error('blocked real LINE call'); }
    return gf.apply(this, arguments);
  };
}
