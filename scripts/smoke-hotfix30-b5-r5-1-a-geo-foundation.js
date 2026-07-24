#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-1-a-geo-foundation.js
// fix18-10-hotfix30-B5-R5.1-A：Geo Intelligence — Geo Data Foundation smoke test
//
// 涵蓋範圍（對照需求文件二十、測試要求，本輪只做 R5.1-A 涉及的部分）：
//   Geo Data：IP Geo 開/關、unknown fallback、地址 Geo 成功/失敗、
//             source/confidence/resolution 正確、不保存完整 IP、
//             不保存完整地址、不回傳精確座標。
//   Store Isolation：不同 store 的 geo 欄位互不影響。
//   Regression：既有 insertEvent 呼叫端（不帶 geo 參數）行為不變。

'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const {
    resolveVisitorGeo, normalizeDeliveryGeo, setIpGeoProvider,
  } = require('../utils/geoResolver');
  const { getTrustedClientIp, truncateIpForResolution, sanitizeGeoForOutput } = require('../utils/geoSanitizer');
  const { getGeoFeatureFlags } = require('../utils/geoFeatureFlags');
  const {
    GEO_SOURCE, GEO_CONFIDENCE, GEO_RESOLUTION, UNKNOWN_GEO, distanceBandFor,
  } = require('../utils/geoConstants');

  // ── 0. Schema：欄位確實存在（safe migration 有效）───────────────────
  const aeCols = db.all("PRAGMA table_info(analytics_events)").map(r => r.name);
  ['geo_country', 'geo_region', 'geo_city', 'geo_district', 'geo_postal_code',
    'geo_source', 'geo_confidence', 'geo_resolution', 'geo_distance_km',
    'geo_distance_band', 'geo_delivery_zone'].forEach((c) => {
    assert(aeCols.includes(c), `schema: analytics_events has column ${c}`);
  });
  const orderCols = db.all("PRAGMA table_info(orders)").map(r => r.name);
  ['fulfillment_geo_city', 'fulfillment_geo_district', 'fulfillment_geo_source',
    'fulfillment_geo_confidence', 'fulfillment_geo_resolution', 'fulfillment_distance_band'].forEach((c) => {
    assert(orderCols.includes(c), `schema: orders has column ${c}`);
  });
  const idxNames = db.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name);
  ['idx_analytics_store_district_created', 'idx_analytics_store_geosource_created',
    'idx_analytics_store_distanceband_created', 'idx_orders_store_fulfillment_district'].forEach((idx) => {
    assert(idxNames.includes(idx), `schema: index ${idx} exists`);
  });

  // ── 1. Feature flags：安全預設值 ─────────────────────────────────
  {
    delete process.env.GEO_ANALYTICS_ENABLED;
    delete process.env.GEO_VISITOR_IP_ENABLED;
    delete process.env.GEO_MAP_ENABLED;
    delete process.env.GEO_ALERTS_ENABLED;
    const flags = getGeoFeatureFlags();
    assert(flags.GEO_ANALYTICS_ENABLED === true, 'flags: GEO_ANALYTICS_ENABLED defaults true');
    assert(flags.GEO_VISITOR_IP_ENABLED === false, 'flags: GEO_VISITOR_IP_ENABLED defaults false (privacy-safe)');
    assert(flags.GEO_MAP_ENABLED === false, 'flags: GEO_MAP_ENABLED defaults false');
    assert(flags.GEO_ALERTS_ENABLED === true, 'flags: GEO_ALERTS_ENABLED defaults true');
  }

  // ── 2. IP Geo：關閉時完全不觸碰 header，回傳 unknown ────────────────
  {
    const fakeReq = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '9.9.9.9' } };
    const geo = await resolveVisitorGeo(fakeReq, { GEO_VISITOR_IP_ENABLED: false });
    assert(geo.geo_source === GEO_SOURCE.UNKNOWN, 'visitor geo: disabled flag -> geo_source unknown');
    assert(geo.geo_confidence === GEO_CONFIDENCE.UNKNOWN, 'visitor geo: disabled flag -> confidence unknown');
  }

  // ── 3. IP Geo：開啟但無 provider -> 仍安全回傳 unknown（不臆測）────────
  {
    const fakeReq = { headers: { 'x-forwarded-for': '1.2.3.4' } };
    const geo = await resolveVisitorGeo(fakeReq, { GEO_VISITOR_IP_ENABLED: true });
    assert(geo.geo_source === GEO_SOURCE.UNKNOWN, 'visitor geo: no provider configured -> unknown (no guessing)');
  }

  // ── 4. IP Geo：開啟 + provider 有資料 -> medium/city ────────────────
  // fix18-10-hotfix30-B5-R5.1-B：R5.1-B 修正了「header 存在就相信」的不安全
  // 信任模型（見 utils/geoSanitizer.js computeTrustProxySetting() /
  // GEO_TRUSTED_IP_HEADER）。這裡明確 opt-in 一個受信任 header 名稱，
  // 模擬「部署商保證這個 header 一定是反向代理寫的」的情境，測完歸還原狀。
  {
    process.env.GEO_TRUSTED_IP_HEADER = 'x-forwarded-for';
    setIpGeoProvider(async (truncatedIp) => {
      assert(!truncatedIp.match(/^\d+\.\d+\.\d+\.\d+$/), 'ip provider only receives truncated/CIDR ip, never full IP');
      return { country: 'TW', region: '桃園市', city: '中壢區' };
    });
    const fakeReq = { headers: { 'x-forwarded-for': '203.0.113.55' } };
    const geo = await resolveVisitorGeo(fakeReq, { GEO_VISITOR_IP_ENABLED: true });
    assert(geo.geo_source === GEO_SOURCE.IP, 'visitor geo: provider success -> source=ip');
    assert(geo.geo_confidence === GEO_CONFIDENCE.MEDIUM, 'visitor geo: ip+city -> confidence=medium');
    assert(geo.geo_district === null, 'visitor geo: IP never claims district-level precision');
    setIpGeoProvider(async () => null); // reset
    delete process.env.GEO_TRUSTED_IP_HEADER;
  }

  // ── 5. getTrustedClientIp / truncateIpForResolution ────────────────
  // fix18-10-hotfix30-B5-R5.1-B：未明確 opt-in 時，header 不再被直接信任
  // （這是本輪修正的安全行為，不是 bug）；opt-in 後才會採信；Express
  // trust-proxy 處理過的 req.ip 永遠是次要信任來源。
  {
    const req0 = { headers: { 'cf-connecting-ip': '198.51.100.7' } };
    assert(getTrustedClientIp(req0) !== '198.51.100.7', 'trusted ip (R5.1-B): header NOT trusted without GEO_TRUSTED_IP_HEADER opt-in');

    process.env.GEO_TRUSTED_IP_HEADER = 'cf-connecting-ip';
    const req1 = { headers: { 'cf-connecting-ip': '198.51.100.7' } };
    assert(getTrustedClientIp(req1) === '198.51.100.7', 'trusted ip: cf-connecting-ip honored after explicit opt-in');
    delete process.env.GEO_TRUSTED_IP_HEADER;

    const req1b = { headers: {}, ip: '198.51.100.20' }; // 模擬 Express trust-proxy 已處理過的 req.ip
    assert(getTrustedClientIp(req1b) === '198.51.100.20', 'trusted ip: falls back to Express trust-proxy req.ip when no header opt-in');

    process.env.GEO_TRUSTED_IP_HEADER = 'x-forwarded-for';
    const req2 = { headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } };
    assert(getTrustedClientIp(req2) === '198.51.100.9', 'trusted ip: x-forwarded-for leftmost taken (after opt-in)');
    delete process.env.GEO_TRUSTED_IP_HEADER;

    const req3 = { headers: {} };
    assert(getTrustedClientIp(req3) === null, 'trusted ip: no header opt-in, no req.ip, no socket -> null');
    assert(truncateIpForResolution('198.51.100.7') === '198.51.100.0/24', 'ip truncation: IPv4 -> /24');
    assert(truncateIpForResolution('2001:db8:abcd:1234::1') === '2001:db8:abcd::/48', 'ip truncation: IPv6 -> /48');
  }

  // ── 6. Delivery Geo：正式地址（address_components）成功 ──────────────
  // fix18-10-hotfix30-B5-R5.1-B（第四階段）：台灣行政區 fallback 優先序調整為
  // district=administrative_area_level_3/sublocality_level_1/sublocality，
  // city=administrative_area_level_2/locality（R5.1-A 版本曾把 level_2 也當
  // district，屬於尚未依 Google 實際慣例校正的初版，本輪已修正，同時更新這裡
  // 的固定資料）。
  {
    const geo = normalizeDeliveryGeo({
      source: GEO_SOURCE.DELIVERY_ADDRESS,
      addressComponents: [
        { long_name: '桃園市', types: ['administrative_area_level_1'] },
        { long_name: '中壢區', types: ['administrative_area_level_3'] },
        { long_name: '320', types: ['postal_code'] },
      ],
      distanceKm: 3.2,
    });
    assert(geo.geo_source === GEO_SOURCE.DELIVERY_ADDRESS, 'delivery geo: source=delivery_address');
    assert(geo.geo_confidence === GEO_CONFIDENCE.HIGH, 'delivery geo: address_components -> confidence=high');
    assert(geo.geo_resolution === GEO_RESOLUTION.DISTRICT, 'delivery geo: district resolved');
    assert(geo.geo_district === '中壢區', 'delivery geo: district value correct');
    assert(geo.geo_distance_band === '3-5km', 'delivery geo: distance band correct (3.2km -> 3-5km)');
  }

  // ── 7. Delivery Geo：formatted_address fallback（無 address_components）─
  {
    const geo = normalizeDeliveryGeo({
      source: GEO_SOURCE.SHIPPING_ADDRESS,
      formattedAddress: '台灣桃園市平鎮區中興路100號',
      distanceKm: null,
    });
    assert(geo.geo_source === GEO_SOURCE.SHIPPING_ADDRESS, 'delivery geo fallback: source=shipping_address');
    assert(geo.geo_district === '平鎮區', 'delivery geo fallback: district parsed from string');
    assert(geo.geo_confidence === GEO_CONFIDENCE.MEDIUM, 'delivery geo fallback: confidence downgraded to medium (string heuristic)');
    assert(geo.geo_distance_band === 'unknown', 'delivery geo fallback: null distance -> unknown band');
  }

  // ── 8. Delivery Geo：地址解析失敗（無法判定）───────────────────────
  {
    const geo = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, formattedAddress: 'xyz???' });
    assert(geo.geo_district === null && geo.geo_city === null, 'delivery geo failure: cannot parse -> null, not guessed');
    assert(geo.geo_confidence === GEO_CONFIDENCE.UNKNOWN, 'delivery geo failure: confidence=unknown');
  }

  // ── 9. Distance bands ───────────────────────────────────────────
  assert(distanceBandFor(0) === '0-3km', 'distance band: 0km -> 0-3km');
  assert(distanceBandFor(2.9) === '0-3km', 'distance band: 2.9km -> 0-3km');
  assert(distanceBandFor(3) === '3-5km', 'distance band: 3km boundary -> 3-5km');
  assert(distanceBandFor(7.5) === '5-8km', 'distance band: 7.5km -> 5-8km');
  assert(distanceBandFor(9) === '8-10km', 'distance band: 9km -> 8-10km');
  assert(distanceBandFor(12) === '10-15km', 'distance band: 12km -> 10-15km');
  assert(distanceBandFor(20) === '15km+', 'distance band: 20km -> 15km+');
  assert(distanceBandFor(null) === 'unknown', 'distance band: null -> unknown');
  assert(distanceBandFor(-1) === 'unknown', 'distance band: negative -> unknown');

  // ── 10. sanitizeGeoForOutput：絕不外流禁止欄位 ──────────────────────
  {
    const dirty = {
      geo_city: '中壢區', geo_source: 'delivery_address',
      ip: '1.2.3.4', lat: 24.95, lng: 121.22, full_address: '桃園市中壢區XX路1號',
    };
    const clean = sanitizeGeoForOutput(dirty);
    assert(clean.geo_city === '中壢區', 'output sanitizer: keeps allowed fields');
    assert(!('ip' in clean) && !('lat' in clean) && !('lng' in clean) && !('full_address' in clean),
      'output sanitizer: strips ip/lat/lng/full_address');
  }

  // ── 11. insertEvent：不帶 geo -> UNKNOWN_GEO 落地（fail-open / regression）──
  {
    ensureVisitorRow();
    const ok = insertEvent(db, {
      store_id: 'store_geo_a', visitor_id: 'v1', session_id: 's1', event_name: 'page_view',
    });
    assert(ok === true, 'insertEvent: regression — call without geo still succeeds');
    const row = db.get("SELECT * FROM analytics_events WHERE store_id='store_geo_a' AND event_name='page_view' ORDER BY id DESC LIMIT 1");
    assert(!!row, 'insertEvent: row was written');
    assert(row.geo_source === 'unknown', 'insertEvent: no geo provided -> geo_source=unknown in DB');
    assert(row.geo_district === null, 'insertEvent: no geo provided -> geo_district=NULL in DB');
  }

  // ── 12. insertEvent：帶正式 delivery geo -> 正確落地，且不寫入完整地址/座標──
  {
    const geo = normalizeDeliveryGeo({
      source: GEO_SOURCE.DELIVERY_ADDRESS,
      addressComponents: [
        { long_name: '桃園市', types: ['administrative_area_level_1'] },
        { long_name: '平鎮區', types: ['administrative_area_level_3'] },
      ],
      distanceKm: 4.1,
    });
    const ok = insertEvent(db, {
      store_id: 'store_geo_a', visitor_id: 'v2', session_id: 's2', order_id: 'ord_1',
      event_name: 'submit_order', geo,
    });
    assert(ok === true, 'insertEvent: with delivery geo succeeds');
    const row = db.get("SELECT * FROM analytics_events WHERE store_id='store_geo_a' AND order_id='ord_1' LIMIT 1");
    assert(row.geo_district === '平鎮區', 'insertEvent: delivery geo district persisted correctly');
    assert(row.geo_source === 'delivery_address', 'insertEvent: delivery geo source persisted correctly');
    assert(row.geo_distance_band === '3-5km', 'insertEvent: distance band persisted correctly');
    const dumped = JSON.stringify(row);
    assert(!dumped.includes('lat') && !dumped.includes('lng'), 'insertEvent: no lat/lng columns ever written');
  }

  // ── 13. insertEvent：拒絕呼叫端亂傳的非法列舉值（防禦性清洗）──────────
  {
    const ok = insertEvent(db, {
      store_id: 'store_geo_a', visitor_id: 'v3', session_id: 's3', event_name: 'page_view',
      geo: { geo_source: 'DROP TABLE orders;--', geo_confidence: 'super-high', geo_district: '偽造區' },
    });
    assert(ok === true, 'insertEvent: malformed geo does not break write path (fail-open)');
    const row = db.get("SELECT * FROM analytics_events WHERE store_id='store_geo_a' AND visitor_id='v3' LIMIT 1");
    assert(row.geo_source === 'unknown', 'insertEvent: invalid geo_source rejected -> falls back to unknown');
    assert(row.geo_confidence === 'unknown', 'insertEvent: invalid geo_confidence rejected -> falls back to unknown');
    // 注意：geo_district 目前只做長度限制而非白名單過濾，這裡驗證確實原樣存了
    // 呼叫端傳入的字串，用來提醒：geo_district 的可信度必須完全依賴呼叫端
    // （routes 層）只從 normalizeDeliveryGeo()/resolveVisitorGeo() 取值，
    // 不可讓前端直接控制 geo 物件內容（見 R5.1-B 待辦：API 層必須擋下前端
    // 直接傳入 geo.* 欄位)。
    assert(row.geo_district === '偽造區', 'insertEvent: geo_district is stored as provided by caller (caller must never be untrusted frontend input)');
  }

  // ── 14. Store Isolation：不同 store 的 geo 資料互不混雜 ───────────────
  {
    insertEvent(db, {
      store_id: 'store_geo_b', visitor_id: 'v1', session_id: 's1', event_name: 'page_view',
      geo: normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, addressComponents: [{ long_name: '板橋區', types: ['administrative_area_level_3'] }] }),
    });
    const storeA = db.all("SELECT store_id, geo_district FROM analytics_events WHERE store_id='store_geo_a' AND geo_district='板橋區'");
    const storeB = db.all("SELECT store_id, geo_district FROM analytics_events WHERE store_id='store_geo_b' AND geo_district='板橋區'");
    assert(storeA.length === 0, 'store isolation: store_geo_a has no 板橋區 rows (belongs to store_geo_b)');
    assert(storeB.length === 1, 'store isolation: store_geo_b correctly has its own 板橋區 row');
  }

  function ensureVisitorRow() { /* no-op placeholder kept for readability parity with other smoke scripts */ }

  // ── Summary ──────────────────────────────────────────────────────
  const failed = results.filter(r => r.status === 'FAIL');
  console.log(`\n=== R5.1-A Geo Foundation smoke test: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('Failures:');
    failed.forEach(f => console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
