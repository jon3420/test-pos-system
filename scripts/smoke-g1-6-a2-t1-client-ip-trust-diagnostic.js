// scripts/smoke-g1-6-a2-t1-client-ip-trust-diagnostic.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A2-T1
//
// 純單元測試（不需要啟動 server／DB），驗證：
//   1. Scope／Family 分類正確性
//   2. Sentinel 偵測與位置判斷
//   3. Fingerprint 一致性／變動性
//   4. 輸出物件絕不含 raw IP／XFF 原始字串／任何白名單外欄位
//   5. Negative：故意把 sentinel 塞進最左，req.ip 不得等於 sentinel（除非
//      平台真的把它當 client IP 用——這裡只驗證函式本身如實回報，不代表
//      正式 Gate 判定）

'use strict';

const assert = require('assert');
const { buildClientIpTrustDiagnostic, SENTINEL_IP } = require('../utils/clientIpTrustDiagnostic');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

function fakeReq({ socketIp, reqIp, xff, trustProxy = false, trustedHeader = '' } = {}) {
  process.env.GEO_TRUSTED_IP_HEADER = trustedHeader;
  return {
    ip: reqIp,
    ips: reqIp ? [reqIp] : [],
    socket: { remoteAddress: socketIp },
    headers: xff ? { 'x-forwarded-for': xff } : {},
    app: { get: () => trustProxy },
  };
}

const ALLOWED_KEYS = [
  'trust_proxy_configured', 'trusted_header_configured',
  'socket_ip_family', 'socket_ip_scope', 'req_ip_family', 'req_ip_scope',
  'xff_present', 'xff_hop_count', 'xff_hop_scopes',
  'sentinel_seen', 'sentinel_position', 'req_ip_is_sentinel',
  'ephemeral_client_fingerprint', 'process_started_at',
];

const FORBIDDEN_SUBSTRINGS = ['203.0.113', '198.51.100.77-should-not-leak'];

// 1. Public IPv4 client behind one proxy hop
check('public IPv4 socket + reqIp scope', () => {
  const req = fakeReq({ socketIp: '10.0.0.5', reqIp: '8.8.8.8', xff: '8.8.8.8, 10.0.0.5' });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.socket_ip_scope, 'private');
  assert.strictEqual(d.req_ip_scope, 'public');
  assert.strictEqual(d.req_ip_family, 4);
  assert.strictEqual(d.xff_hop_count, 2);
  assert.deepStrictEqual(d.xff_hop_scopes, ['public', 'private']);
});

// 2. Loopback classification
check('loopback classification', () => {
  const req = fakeReq({ socketIp: '127.0.0.1', reqIp: '127.0.0.1' });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.socket_ip_scope, 'loopback');
  assert.strictEqual(d.req_ip_scope, 'loopback');
});

// 3. IPv6 loopback + link-local
check('ipv6 classification', () => {
  const req = fakeReq({ socketIp: '::1', reqIp: 'fe80::1' });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.socket_ip_scope, 'loopback');
  assert.strictEqual(d.socket_ip_family, 6);
  assert.strictEqual(d.req_ip_scope, 'private');
  assert.strictEqual(d.req_ip_family, 6);
});

// 4. Invalid IP format
check('invalid ip format', () => {
  const req = fakeReq({ socketIp: 'not-an-ip', reqIp: null });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.socket_ip_scope, 'invalid');
  assert.strictEqual(d.req_ip_scope, 'invalid');
  assert.strictEqual(d.req_ip_family, null);
});

// 5. Sentinel leftmost, req.ip NOT sentinel (platform appended real client rightmost)
check('sentinel leftmost, platform trustworthy', () => {
  const req = fakeReq({ socketIp: '10.0.0.5', reqIp: '203.0.113.9', xff: `${SENTINEL_IP}, 203.0.113.9` });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.sentinel_seen, true);
  assert.strictEqual(d.sentinel_position, 'leftmost');
  assert.strictEqual(d.req_ip_is_sentinel, false);
});

// 6. Sentinel becomes req.ip (UNSAFE — trust proxy blindly trusting client XFF)
check('sentinel spoof succeeds (must be detected)', () => {
  const req = fakeReq({ socketIp: '10.0.0.5', reqIp: SENTINEL_IP, xff: SENTINEL_IP, trustProxy: true });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.req_ip_is_sentinel, true);
  assert.strictEqual(d.trust_proxy_configured, true);
});

// 7. Middle position
check('sentinel middle position', () => {
  const req = fakeReq({ reqIp: '1.2.3.4', xff: `9.9.9.9, ${SENTINEL_IP}, 10.0.0.1` });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.sentinel_position, 'middle');
});

// 8. No XFF present
check('no xff header', () => {
  const req = fakeReq({ socketIp: '203.0.113.50', reqIp: '203.0.113.50' });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.xff_present, false);
  assert.strictEqual(d.xff_hop_count, 0);
  assert.deepStrictEqual(d.xff_hop_scopes, []);
});

// 9. Fingerprint stable for identical input, differs for different input
check('fingerprint stability and variability', () => {
  const reqA1 = fakeReq({ socketIp: '10.0.0.5', reqIp: '203.0.113.9' });
  const reqA2 = fakeReq({ socketIp: '10.0.0.5', reqIp: '203.0.113.9' });
  const reqB = fakeReq({ socketIp: '10.0.0.5', reqIp: '198.51.100.20' });
  const dA1 = buildClientIpTrustDiagnostic(reqA1);
  const dA2 = buildClientIpTrustDiagnostic(reqA2);
  const dB = buildClientIpTrustDiagnostic(reqB);
  assert.strictEqual(dA1.ephemeral_client_fingerprint, dA2.ephemeral_client_fingerprint);
  assert.notStrictEqual(dA1.ephemeral_client_fingerprint, dB.ephemeral_client_fingerprint);
  assert.strictEqual(typeof dA1.ephemeral_client_fingerprint, 'string');
  assert.ok(dA1.ephemeral_client_fingerprint.length <= 16);
});

// 10. Output whitelist — only allowed keys, no raw IP substrings anywhere in serialized output
check('output field whitelist and no raw IP leakage', () => {
  const req = fakeReq({ socketIp: '203.0.113.50', reqIp: '203.0.113.50', xff: `${SENTINEL_IP}, 203.0.113.50` });
  const d = buildClientIpTrustDiagnostic(req);
  const keys = Object.keys(d).sort();
  assert.deepStrictEqual(keys, [...ALLOWED_KEYS].sort());
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes('203.0.113.50'), 'raw IP leaked into diagnostic output');
  assert.ok(!serialized.includes(SENTINEL_IP), 'sentinel raw IP string leaked (only classification allowed)');
});

// 11. trusted_header_configured reflects env, does not reveal header content
check('trusted_header_configured boolean only', () => {
  const req = fakeReq({ socketIp: '203.0.113.50', reqIp: '203.0.113.50', trustedHeader: 'cf-connecting-ip' });
  const d = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d.trusted_header_configured, true);
  assert.strictEqual(typeof d.trusted_header_configured, 'boolean');
});

// 12. process_started_at is a stable ISO string across calls
check('process_started_at stable', () => {
  const req = fakeReq({ socketIp: '203.0.113.50', reqIp: '203.0.113.50' });
  const d1 = buildClientIpTrustDiagnostic(req);
  const d2 = buildClientIpTrustDiagnostic(req);
  assert.strictEqual(d1.process_started_at, d2.process_started_at);
  assert.ok(!Number.isNaN(Date.parse(d1.process_started_at)));
});

console.log(`\n[smoke-g1-6-a2-t1] PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
