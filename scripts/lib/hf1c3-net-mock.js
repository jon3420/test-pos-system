// scripts/lib/hf1c3-net-mock.js — R54.4／MBV2-HF1-C3 測試專用 preload（node -r）
//
// 只在測試子程序載入；正式部署不會載入此檔。
//   1. node-fetch 對 Google Routes 固定回 2 公里（可用 HF1C3_ROUTES_DELAY_MS 延遲回應，
//      用來在「送單 BEGIN 前驗證」與「交易內重驗」之間製造時間窗）。其餘網址一律拒絕。
//   2. 全域 fetch／https.request 任何打到 LINE API（api.line.me／api-data.line.me）的呼叫
//      一律拒絕並計數，寫入 HF1C3_PUSH_COUNT_FILE（每行一筆），供測試確認「推播呼叫次數為 0」。
'use strict';
const fs = require('fs');
const Module = require('module');
const https = require('https');

const COUNT_FILE = process.env.HF1C3_PUSH_COUNT_FILE || '';
function recordLineCall(url) {
  if (!COUNT_FILE) return;
  try { fs.appendFileSync(COUNT_FILE, String(url).slice(0, 120) + '\n'); } catch {}
}
function isLineApi(u) { return /^https:\/\/(api|api-data)\.line\.me\//.test(String(u || '')); }

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function mockNodeFetch(url) {
  const u = String(url || '');
  if (u.startsWith('https://routes.googleapis.com/')) {
    const delay = Number(process.env.HF1C3_ROUTES_DELAY_MS || 0);
    return new Promise((r) => setTimeout(() => r(fakeResponse(200, { routes: [{ distanceMeters: 2000 }] })), delay));
  }
  if (isLineApi(u)) recordLineCall(u);
  return Promise.reject(new Error('[hf1c3-net-mock] external network disabled in test: ' + u.slice(0, 80)));
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'node-fetch') return mockNodeFetch;
  return origLoad.apply(this, arguments);
};
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (isLineApi(u)) { recordLineCall(u); return Promise.reject(new Error('[hf1c3-net-mock] LINE API disabled in test')); }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return origFetch(input, init);
  return Promise.reject(new Error('[hf1c3-net-mock] external network disabled in test: ' + String(u).slice(0, 80)));
};
const origRequest = https.request;
https.request = function (opts) {
  const host = typeof opts === 'string' ? opts : (opts && (opts.hostname || opts.host)) || '';
  if (/(^|\.)line\.me/.test(String(host))) recordLineCall('https://' + host);
  return origRequest.apply(this, arguments);
};
