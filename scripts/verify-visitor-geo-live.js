#!/usr/bin/env node
// scripts/verify-visitor-geo-live.js — fix18-10-hotfix30-B5-R5.1-D1
//
// 手動/CI 診斷腳本：驗證目前設定的 Visitor IP Geo Provider 是否真的可用，
// 不寫入資料庫、不透過 HTTP route，只直接呼叫 utils/geoProviders 與
// utils/geoResolver，方便在部署環境快速確認 Provider 設定正確。
//
// 使用方式：
//   TEST_VISITOR_IP=8.8.8.8 node scripts/verify-visitor-geo-live.js
//
// 隱私：輸出一律遮罩 IP（只顯示最後一段），絕不印出完整原始 IP 或 Provider
// 原始 response。
//
// Exit code：
//   0 — 成功（Provider 已設定且查詢成功，或明確回報 NOT CONFIGURED 但這是
//        預期的安全預設狀態，視為「診斷腳本本身執行成功」）
//   2 — 設定缺失（GEO_VISITOR_IP_ENABLED=false 或 provider=disabled）
//   3 — Provider 查詢失敗（timeout/429/403/500/...）

'use strict';

function maskIp(ip) {
  if (!ip || typeof ip !== 'string') return '(none)';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `***.***.***.${parts[3]}`;
    return '***.***.***.***';
  }
  if (ip.includes(':')) return '****:****:****:...(ipv6 masked)';
  return '***';
}

async function main() {
  const testIp = process.env.TEST_VISITOR_IP || '';
  const { getGeoFeatureFlags } = require('../utils/geoFeatureFlags');
  const { getActiveProviderName, lookupVisitorGeo, getProviderStatus } = require('../utils/geoProviders');

  const flags = getGeoFeatureFlags();
  const providerName = getActiveProviderName();

  console.log('=== Visitor Geo Provider — Live Verify ===');
  console.log('GEO_VISITOR_IP_ENABLED:', flags.GEO_VISITOR_IP_ENABLED);
  console.log('Provider:', providerName);
  console.log('Test IP:', maskIp(testIp));

  if (!flags.GEO_VISITOR_IP_ENABLED || providerName === 'disabled') {
    console.log('Status: NOT CONFIGURED');
    console.log('(GEO_VISITOR_IP_ENABLED=false 或 GEO_VISITOR_IP_PROVIDER=disabled — 這是安全的預設狀態，不代表程式有錯誤)');
    process.exitCode = 2;
    return;
  }

  if (!testIp) {
    console.log('Status: MISSING TEST_VISITOR_IP');
    console.log('請設定 TEST_VISITOR_IP=<公開測試IP> 後重新執行。');
    process.exitCode = 2;
    return;
  }

  const before = getProviderStatus();
  let result;
  try {
    result = await lookupVisitorGeo(testIp);
  } catch (e) {
    console.log('Status: PROVIDER_THREW_EXCEPTION');
    console.log('Message:', e.message);
    process.exitCode = 3;
    return;
  }
  const after = getProviderStatus();
  const cacheHit = after.cache_hits > before.cache_hits;

  if (!result) {
    console.log('Status: FAILED');
    console.log('Last error code:', after.last_error_code || '(unknown)');
    process.exitCode = 3;
    return;
  }

  console.log('Status: OK');
  console.log('Provider:', result.provider || providerName);
  console.log('Country:', result.country || '(none)');
  console.log('Region:', result.region || '(none)');
  console.log('City:', result.city || '(none)');
  console.log('District:', result.district || '(none)');
  console.log('Accuracy:', result.accuracy || 'unknown');
  console.log('Cache Hit/Miss:', cacheHit ? 'HIT' : 'MISS');
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('Unexpected error:', e.message);
  process.exitCode = 3;
});
