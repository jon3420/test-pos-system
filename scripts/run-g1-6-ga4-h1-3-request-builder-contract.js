#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-3-request-builder-contract.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// Request Builder Contract Gate — Variant B（見需求文件五～十、十二）。
//
// 驗證重點：
//   - visitors 完全維持 H1.2 baseline Contract（summary dimensions:[]，
//     city dimensions 恰好 city/countryId，即使設定了 Stream 也一樣）。
//   - view_item／add_to_cart／checkout(begin_checkout)／purchase 這四個
//     Event Metric：
//       Summary Request：dimensions 至少包含 eventName（有設定 Stream 時
//       還要包含 streamId）。
//       City Request：dimensions 至少包含 city／countryId／eventName
//       （有 Stream 時還要 streamId）。
//       Filter：eventName EXACT <對應的真實 GA4 事件名稱>，有 Stream 時
//       filter 同時包含 streamId EXACT <設定的 streamId>。
//   - buildRealtimeDimensions() 是純函式（不改變傳入的 baseDimensions
//     陣列本身）。
//   - GA4_REQUEST_VARIANT 常數存在且等於 'B'。

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('REQUEST BUILDER CONTRACT — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT (Variant B)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function main() {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js')]); pass('0. node --check requestBuilder.js'); }
  catch (e) { fail('0. node --check requestBuilder.js', e.message.slice(0, 200)); }

  const rb = require(path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js'));

  assert(rb.GA4_REQUEST_VARIANT === 'B', 'GA4_REQUEST_VARIANT === "B"');
  assert(typeof rb.buildRealtimeDimensions === 'function', 'buildRealtimeDimensions is exported');

  // ── visitors baseline unchanged (with AND without stream configured) ──
  ['9001', null].forEach((streamId) => {
    const base = { propertyId: '123', streamId, windowMinutes: 5, metric: 'visitors' };
    const summary = rb.buildGa4RealtimeSummaryRequest(base);
    assert(summary.ok && summary.request.dimensions.length === 0,
      `visitors summary dimensions:[] unchanged (streamId=${streamId})`);
    const city = rb.buildGa4RealtimeCityRequest(base);
    assert(city.ok && city.request.dimensions.map((d) => d.name).join(',') === 'city,countryId',
      `visitors city dimensions exactly city,countryId unchanged (streamId=${streamId})`);
  });

  // ── event metrics: Variant B dimensions/filter contract ──
  const EVENT_METRIC_MAP = {
    view_item: 'view_item',
    add_to_cart: 'add_to_cart',
    checkout: 'begin_checkout',
    purchase: 'purchase',
  };

  Object.entries(EVENT_METRIC_MAP).forEach(([metric, ga4EventName]) => {
    // With stream configured.
    {
      const base = { propertyId: '123', streamId: '9001', windowMinutes: 30, metric };
      const summary = rb.buildGa4RealtimeSummaryRequest(base);
      assert(summary.ok, `${metric} summary request builds ok (with stream)`);
      const sDims = summary.request.dimensions.map((d) => d.name);
      assert(sDims.includes('eventName'), `${metric} summary dimensions include eventName (with stream)`);
      assert(sDims.includes('streamId'), `${metric} summary dimensions include streamId (with stream)`);
      const sFilterStr = JSON.stringify(summary.request.dimensionFilter);
      assert(sFilterStr.includes(ga4EventName) && sFilterStr.includes('EXACT'), `${metric} summary filter eventName EXACT ${ga4EventName}`);
      assert(sFilterStr.includes('9001'), `${metric} summary filter streamId EXACT 9001 (with stream)`);

      const city = rb.buildGa4RealtimeCityRequest(base);
      assert(city.ok, `${metric} city request builds ok (with stream)`);
      const cDims = city.request.dimensions.map((d) => d.name);
      assert(cDims.includes('city') && cDims.includes('countryId'), `${metric} city dimensions still include city/countryId (with stream)`);
      assert(cDims.includes('eventName'), `${metric} city dimensions include eventName (with stream)`);
      assert(cDims.includes('streamId'), `${metric} city dimensions include streamId (with stream)`);
      const cFilterStr = JSON.stringify(city.request.dimensionFilter);
      assert(cFilterStr.includes(ga4EventName) && cFilterStr.includes('9001'), `${metric} city filter eventName+streamId (with stream)`);
    }

    // Without stream configured.
    {
      const base = { propertyId: '123', streamId: null, windowMinutes: 30, metric };
      const summary = rb.buildGa4RealtimeSummaryRequest(base);
      const sDims = summary.request.dimensions.map((d) => d.name);
      assert(sDims.includes('eventName'), `${metric} summary dimensions include eventName (no stream)`);
      assert(!sDims.includes('streamId'), `${metric} summary dimensions do NOT include streamId (no stream)`);

      const city = rb.buildGa4RealtimeCityRequest(base);
      const cDims = city.request.dimensions.map((d) => d.name);
      assert(cDims.includes('eventName'), `${metric} city dimensions include eventName (no stream)`);
      assert(!cDims.includes('streamId'), `${metric} city dimensions do NOT include streamId (no stream)`);
    }
  });

  // ── checkout distinctly filters begin_checkout, not "checkout" itself ──
  {
    const checkoutReq = rb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'checkout' });
    const filterStr = JSON.stringify(checkoutReq.request.dimensionFilter);
    assert(filterStr.includes('begin_checkout') && !filterStr.includes('"checkout"'), 'checkout metric filters begin_checkout distinctly (not literal "checkout")');
  }

  // ── purchase distinct from checkout ──
  {
    const purchaseReq = rb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'purchase' });
    const filterStr = JSON.stringify(purchaseReq.request.dimensionFilter);
    assert(filterStr.includes('purchase') && !filterStr.includes('begin_checkout'), 'purchase metric filter distinct from begin_checkout');
  }

  // ── buildRealtimeDimensions purity ──
  {
    const base = [{ name: 'city' }, { name: 'countryId' }];
    const baseCopy = base.map((d) => ({ ...d }));
    const result = rb.buildRealtimeDimensions(base, { eventName: 'purchase', streamId: '9001' });
    assert(JSON.stringify(base) === JSON.stringify(baseCopy), 'buildRealtimeDimensions does not mutate the input array');
    assert(result.length === base.length + 2 && result !== base, 'buildRealtimeDimensions returns a new, extended array');
    const noEvent = rb.buildRealtimeDimensions(base, { eventName: null, streamId: '9001' });
    assert(noEvent.length === base.length, 'buildRealtimeDimensions leaves dimensions unchanged when eventName is absent (even with streamId)');
  }

  printSummary();
}

main();
