#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-browser-entry-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 7C
//
// Browser Entry Wiring Gate。直接讀 public/index.html，解析真正的
// <script src="..."> 順序（不是測試自己手刻一份順序），依這個真實順序把
// 對應的 public/js/*.js 檔案內容 eval 進同一個 jsdom window scope。不提供
// Node require 給這個 scope（模擬真實瀏覽器沒有 CommonJS 這件事），這樣
// 如果 Production 檔案之間的載入順序真的有缺口，這裡會像真實瀏覽器一樣
// 出現 undefined/ReferenceError，不會被 Node fallback 悄悄掩蓋過去。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'public/index.html');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('BROWSER ENTRY RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 7C)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ── 1. 直接解析真正的 public/index.html ──────────────────────────
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

// 只抓同源本地 /js/... 的 <script src="...">（忽略 CDN／vendor 絕對網址），
// 依文件出現順序（HTML 原始位置），不做任何排序假設。
function parseLocalScriptOrder(html) {
  const re = /<script\s+src="(\/js\/[^"?]+)(\?[^"]*)?"[^>]*><\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: m[1], index: m.index });
  }
  return out;
}
const fullOrder = parseLocalScriptOrder(indexHtml);

assert(fullOrder.length > 0, '1. index.html 存在且成功解析出至少一個本地 <script src>');

const REQUIRED = ['/js/date-time-format.js', '/js/geo-range-resolver.js', '/js/geo-range-control.js', '/js/geo-ga4-dashboard-layer.js', '/js/geo-ga4-h1-panel.js'];
REQUIRED.forEach((href, i) => {
  const found = fullOrder.some((s) => s.href === href);
  assert(found, `${i + 2}. index.html 真的包含 ${href}`, found ? '' : 'not found in parsed script list');
});

// ── 4. 真正 Load Order Contract（用解析出來的 index 位置比較，不是猜測）──
function orderIndexOf(href) {
  const found = fullOrder.find((s) => s.href === href);
  return found ? found.index : -1;
}
const idxDateTime = orderIndexOf('/js/date-time-format.js');
const idxResolver = orderIndexOf('/js/geo-range-resolver.js');
const idxControl = orderIndexOf('/js/geo-range-control.js');
const idxH1 = orderIndexOf('/js/geo-ga4-h1-panel.js');
const idxDashboard = orderIndexOf('/js/geo-ga4-dashboard-layer.js');
const idxHeatUi = orderIndexOf('/js/geo-heatmap-ui.js');

assert(idxDateTime !== -1 && idxResolver !== -1 && idxDateTime < idxResolver, '8. date-time-format.js 在 geo-range-resolver.js 之前', `${idxDateTime} vs ${idxResolver}`);
assert(idxResolver !== -1 && idxControl !== -1 && idxResolver < idxControl, '9. geo-range-resolver.js 在 geo-range-control.js 之前', `${idxResolver} vs ${idxControl}`);
assert(idxControl !== -1 && idxH1 !== -1 && idxControl < idxH1, '10. geo-range-control.js 在 geo-ga4-h1-panel.js 之前', `${idxControl} vs ${idxH1}`);
assert(idxControl !== -1 && idxDashboard !== -1 && idxControl < idxDashboard, '11. geo-range-control.js 在 geo-ga4-dashboard-layer.js 之前（Dashboard consumer contract）', `${idxControl} vs ${idxDashboard}`);

// geo-heatmap-ui.js 在 runtime 會呼叫 geoDashboardGa4Activate/Deactivate，
// 但那些呼叫點都在函式本體內（不是頂層），本身也有 typeof 安全 guard——
// 所以正式架構是「B：呼叫點具有安全 guard」，不要求 Dashboard module 一定
// 要排在 geo-heatmap-ui.js 之前。這裡只確認這個安全 guard contract 真的
// 存在於原始碼裡（Static Audit Category Q 已驗證過，這裡只做交叉確認，
// 不重新設計）。
const heatUiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
assert(/typeof geoDashboardGa4Activate === 'function'/.test(heatUiSrc) && /typeof geoDashboardGa4Deactivate === 'function'/.test(heatUiSrc),
  '11b. geo-heatmap-ui.js 對 Dashboard module 的呼叫點有安全 typeof guard（架構 B：不要求 Dashboard 一定要排在它之前）');

// ── Include Count（不得重複載入同一支）──────────────────────────
function includeCount(href) { return fullOrder.filter((s) => s.href === href).length; }
assert(includeCount('/js/geo-range-resolver.js') === 1, '12. geo-range-resolver.js 只出現一次（沒有重複載入）');
assert(includeCount('/js/geo-range-control.js') === 1, '13. geo-range-control.js 只出現一次（沒有重複載入）');
assert(includeCount('/js/geo-ga4-dashboard-layer.js') === 1, '14. geo-ga4-dashboard-layer.js 只出現一次（沒有重複載入）');

// ── 5/6. Browser Entry Load Smoke：依真實順序把對應本地檔案內容
// eval 進同一個 jsdom window（不提供 Node require，模擬真實瀏覽器）──
const LOCAL_JS_DIR = path.join(ROOT, 'public/js');
function hrefToFsPath(href) { return path.join(ROOT, 'public', href.replace(/^\//, '')); }
function fileExistsForHref(href) { return fs.existsSync(hrefToFsPath(href)); }
function readForHref(href) { return fs.readFileSync(hrefToFsPath(href), 'utf8'); }

// 只載入跟本輪 Geo/H1.4 相關、且是本地檔案的 script（跳過 app.js／
// analytics-v2.js／vendor CDN 等真正跟這條依賴鏈無關的檔案，避免引入
// 不相關的載入失敗雜訊）。哪些算「相關」是用檔名 allowlist 判斷，
// allowlist 本身不影響「相關檔案之間」彼此的相對順序——順序仍然完全來自
// 上面解析出的 fullOrder，這裡只是過濾，不重排。
const RELEVANT_BASENAMES = new Set([
  'date-time-format.js', 'geo-range-resolver.js', 'geo-range-control.js',
  'geo-intelligence.js', 'geo-intelligence-map.js', 'geo-heatmap.js',
  'geo-heatmap-ui.js', 'geo-visitor-layer.js', 'geo-ga4-realtime-layer.js',
  'geo-ga4-dashboard-layer.js', 'geo-ga4-h1-panel.js',
]);
function relevantSubset(order) {
  return order.filter((s) => RELEVANT_BASENAMES.has(path.basename(s.href)) && fileExistsForHref(s.href));
}

function makeBrowserLikeDom() {
  const html = `<!DOCTYPE html><html><body>
    <div id="c-map"></div>
    <div id="c-order-layer"></div><div id="c-visitor-layer" hidden></div><div id="c-ga4-layer" hidden></div>
    <div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>
    <div id="c-dashboard-ga4-range"></div><div id="c-dashboard-ga4-label"></div><div id="c-dashboard-ga4-status"></div>
    <div id="c-panel-dashboard"></div><div id="c-panel-heatmap" hidden></div>
  </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  // 提供最低限度 Leaflet fake／apiFetch／showToast stub（需求文件六：只給
  // 這些「legacy 全域」，不給 Node require）。刻意不設定
  // dom.window.require——真實瀏覽器沒有這個東西。
  dom.window.L = {
    layerGroup() { const g = { _children: [], addLayer(c) { this._children.push(c); return this; }, clearLayers() { this._children.length = 0; return this; }, addTo(m) { m.addLayer(this); return this; }, remove() {} }; return g; },
    geoJSON() { return { setStyle() {}, addTo(m) { m.addLayer(this); return this; } }; },
    marker() { return { bindTooltip() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    circleMarker() { return { bindTooltip() { return this; }, setStyle() { return this; } }; },
    divIcon(o) { return o; },
    map() { const layers = new Set(); return { _layers: layers, hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); return this; }, removeLayer(l) { layers.delete(l); return this; }, setView() { return this; }, on() { return this; }, invalidateSize() {} }; },
    tileLayer() { return { addTo() { return this; } }; },
  };
  dom.window.apiFetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, rows: [] }) });
  dom.window.showToast = () => {};
  return dom;
}

function loadInBrowserLikeOrder(order) {
  const dom = makeBrowserLikeDom();
  const errors = [];
  dom.window.addEventListener('error', (e) => errors.push(e.error ? (e.error.message || String(e.error)) : String(e.message)));
  order.forEach((s) => {
    const src = readForHref(s.href);
    try {
      dom.window.eval(src);
    } catch (e) {
      errors.push(`${s.href}: ${e.message}`);
    }
  });
  return { dom, errors };
}

// ── Positive Case：真實順序，全部載入 ──────────────────────────
const positiveOrder = relevantSubset(fullOrder);
const { dom: domPos, errors: errorsPos } = loadInBrowserLikeOrder(positiveOrder);

assert(errorsPos.length === 0, '15. 依真實 HTML 順序載入，沒有 ReferenceError／其他例外', JSON.stringify(errorsPos));
assert(typeof domPos.window.resolveGeoHistoricalRange === 'function', '16. resolveGeoHistoricalRange 全域函式存在（沒有 "is undefined"）');
assert(typeof domPos.window.GeoRangeControl === 'object' && domPos.window.GeoRangeControl && typeof domPos.window.GeoRangeControl.mount === 'function', '17. GeoRangeControl 全域物件存在且 .mount 是函式（沒有 "is undefined"）');
assert(typeof domPos.window.geoDashboardGa4Activate === 'function' && typeof domPos.window.geoDashboardGa4Deactivate === 'function', '18. geoDashboardGa4Activate/Deactivate 正式 Dashboard export 存在（沒有 "Dashboard module undefined"）');
assert(typeof domPos.window.GeoGa4H1Panel === 'object' && domPos.window.GeoGa4H1Panel && typeof domPos.window.GeoGa4H1Panel.init === 'function', '19. GeoGa4H1Panel 全域物件存在且 .init 是函式');

// 額外正面驗證：resolveGeoHistoricalRange 真的可用（不是「存在但內部
// require fallback 失敗」這種假可用），直接呼叫確認回傳合法結果。
try {
  const r = domPos.window.resolveGeoHistoricalRange('7d', { now: new Date('2026-08-07T04:00:00Z') });
  assert(r && r.ok === true && r.dayCount === 7, '23. Dashboard 依賴的 resolveGeoHistoricalRange 在真實載入順序下真的可以正常運作（不是空殼）', JSON.stringify(r));
} catch (e) {
  fail('23. Dashboard 依賴的 resolveGeoHistoricalRange 在真實載入順序下真的可以正常運作（不是空殼）', e.message);
}

// ── Negative Controls（Browser Entry Runtime 自己的 negative control，
// 不計入正式 30 條 Mutation Suite）─────────────────────────────

// A. 移除 geo-range-resolver.js → resolveGeoHistoricalRange 必須是 undefined
{
  const orderA = positiveOrder.filter((s) => s.href !== '/js/geo-range-resolver.js');
  const { dom: domA } = loadInBrowserLikeOrder(orderA);
  assert(typeof domA.window.resolveGeoHistoricalRange !== 'function', '20. Negative Control A：移除 geo-range-resolver.js 後，resolveGeoHistoricalRange 確實變成 undefined（證明正面測試不是巧合）');
}

// B. 移除 geo-range-control.js → GeoRangeControl 必須是 undefined
{
  const orderB = positiveOrder.filter((s) => s.href !== '/js/geo-range-control.js');
  const { dom: domB } = loadInBrowserLikeOrder(orderB);
  assert(typeof domB.window.GeoRangeControl === 'undefined', '21. Negative Control B：移除 geo-range-control.js 後，GeoRangeControl 確實變成 undefined');
}

// C. 移除 geo-ga4-dashboard-layer.js → Dashboard activation export 必須是 undefined
{
  const orderC = positiveOrder.filter((s) => s.href !== '/js/geo-ga4-dashboard-layer.js');
  const { dom: domC } = loadInBrowserLikeOrder(orderC);
  assert(typeof domC.window.geoDashboardGa4Activate === 'undefined', '22. Negative Control C：移除 geo-ga4-dashboard-layer.js 後，geoDashboardGa4Activate 確實變成 undefined');
}

// D. 把 geo-range-control.js 排到 geo-range-resolver.js 之前（非法順序）
// → GeoRangeControl 雖然還是會被定義出來（函式宣告本身不受影響），但它
// 內部 capture 的 _geoRangeControlResolve 永遠是 null（因為 parse 當下
// resolveGeoHistoricalRange 還不存在，且瀏覽器沒有 require 可以事後補救），
// 導致所有 resolve 呼叫都回傳 timezone_helper_unavailable——這才是「非法
// 順序」在真實瀏覽器裡實際的壞法，不是直接死掉。
{
  const idxR = positiveOrder.findIndex((s) => s.href === '/js/geo-range-resolver.js');
  const idxC = positiveOrder.findIndex((s) => s.href === '/js/geo-range-control.js');
  const swapped = positiveOrder.slice();
  const tmp = swapped[idxR]; swapped[idxR] = swapped[idxC]; swapped[idxC] = tmp;
  const { dom: domD } = loadInBrowserLikeOrder(swapped);
  let staleResult = null;
  try {
    // geoRangeControlHtml/mount 本身不會拋例外，但實際 resolve 會失敗。
    const mountEl = domD.window.document.getElementById('c-dashboard-ga4-range');
    domD.window.GeoRangeControl.mount('c-dashboard-ga4-range', { state: { mode: '7d', singleDate: '', startDate: '', endDate: '' }, onChange: (payload) => { staleResult = payload.resolved; } });
  } catch (e) { staleResult = { ok: false, code: 'threw:' + e.message }; }
  assert(!!staleResult && staleResult.ok === false, '24. Negative Control D：geo-range-control.js 排在 geo-range-resolver.js 之前時，實際 resolve 呼叫失敗（非法順序在真實瀏覽器下的真實症狀）', JSON.stringify(staleResult));
}

printSummary();
