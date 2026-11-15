// scripts/lib/c5-linepay-mock.js — R54.4／MBV2-HF1-C5 測試專用 preload（node -r；正式部署不載入）
// 攔截 routes/linepay.js 使用的 node-fetch：送往 *pay.line.me 的請求完全不連外，依控制檔回應。
//   C5_LINEPAY_CTRL（JSON）：{ request: '0000', confirm: '0000' | '1150' | ... }
//   C5_LINEPAY_LOG：每次呼叫一行（只記錄 URI 與回應代碼）
'use strict';
const Module = require('module');
const fs = require('fs');
const CTRL = process.env.C5_LINEPAY_CTRL || '';
const LOG = process.env.C5_LINEPAY_LOG || '';
const readCtrl = () => { try { return JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch { return {}; } };
const origLoad = Module._load;
let wrapped = null;
const _reqs = new Map(); let _seq = 0; // C5.3：交易 → Request 的 orderId／金額（同一伺服器程序內）
Module._load = function (request, parent, isMain) {
  const real = origLoad.apply(this, arguments);
  if (request !== 'node-fetch') return real;
  if (wrapped) return wrapped;
  const fn = async function (url, init) {
    const u = String(url || '');
    if (!/pay\.line\.me/.test(u)) return real(url, init);
    const ctrl = readCtrl();
    const uri = u.replace(/^https?:\/\/[^/]+/, '');
    let body;
    let req = {}; try { req = init && init.body ? JSON.parse(init.body) : {}; } catch { req = {}; }
    if (/\/confirm$/.test(uri)) {
      // C5.3：成功回應依官方 Confirm 結構提供 orderId、transactionId、payInfo（由 Request 時記下的 orderId／金額）
      const tx = uri.split('/')[3]; const rec = _reqs.get(tx);
      const code = ctrl.confirm || '0000';
      body = code === '0000' && rec ? { returnCode: code, returnMessage: 'mock', info: { orderId: rec.orderId, transactionId: tx, payInfo: [{ method: 'BALANCE', amount: Number(req.amount) }] } }
        : { returnCode: code, returnMessage: 'mock', info: { transactionId: tx } };
    } else if (/\/v3\/payments\/request$/.test(uri)) {
      const tx = String(Date.now()) + String(++_seq).padStart(4, '0');
      if ((ctrl.request || '0000') === '0000') _reqs.set(tx, { orderId: req.orderId, amount: req.amount });
      body = { returnCode: ctrl.request || '0000', returnMessage: 'mock', info: { transactionId: tx, paymentUrl: { web: 'https://example.invalid/pay', app: 'line://pay' } } };
    }
    else body = { returnCode: '0000', returnMessage: 'mock' };
    if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify({ uri, code: body.returnCode }) + '\n'); } catch {} }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  Object.assign(fn, real);
  wrapped = fn;
  return wrapped;
};
