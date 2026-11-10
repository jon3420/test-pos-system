// scripts/lib/hf1c1-maps-mock.js — R54.4／MBV2-HF1-C1 測試專用 preload（node -r）
//
// 只在測試子程序以 `node -r ./scripts/lib/hf1c1-maps-mock.js server.js` 載入；
// 正式部署不會載入此檔。將 node-fetch 對 Google Routes API 的呼叫改為固定
// 2 公里回應，其餘網址一律拒絕（測試不得連線任何外部服務）。
'use strict';
const Module = require('module');
const origLoad = Module._load;
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function mockFetch(url) {
  const u = String(url || '');
  if (u.startsWith('https://routes.googleapis.com/')) {
    return Promise.resolve(fakeResponse(200, { routes: [{ distanceMeters: 2000 }] }));
  }
  return Promise.reject(new Error('[hf1c1-maps-mock] external network disabled in test: ' + u.slice(0, 80)));
}
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') return mockFetch;
  return origLoad.apply(this, arguments);
};
