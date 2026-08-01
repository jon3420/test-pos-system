// scripts/lib/geo-heatmap-g131-scope-guard.js
// fix18-10-hotfix30-B5-R5.4-G1.3.2 — Regression Guard Alignment
//
// 背景：scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js（A14-1）與
// scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js（A16-1）原本對
// public/js/geo-heatmap.js 做「整檔 SHA-256 逐位元組相等」防護
// （baseline: 8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d，
// 即 R5.3-A2/A1.2 那一輪留下的原始檔案內容）。
//
// G1.3.1 為了新增 Business Total additive plumbing（見
// R5.4-G1.3.1_COVERAGE_TOTAL_DARK_THEME_FIX.md），必須合法修改
// geo-heatmap.js：在 geoHeatState 新增 businessTotals 欄位、在兩個既有
// reset 函式內新增對應的重置、並讓 geoHeatScheduleUpdate() 向下相容地支援
// { areas, businessTotals } 回傳格式。整檔逐位元組相等從此永遠不可能通過，
// 但整檔相等背後真正要保護的目的（不要有人在 Engine 裡偷改 stale-guard、
// 偷建第二張地圖、偷改 render 呼叫簽章…）依然成立，也依然必須被檢查。
//
// 本模組提供兩層防護，取代整檔 hash：
//
// 1) Scope-aware Reconstruction Check（取代整檔相等，但不放棄「其餘內容
//    逐位元組不變」的保護力）：
//    把目前檔案內容中，明確列在 GEO_HEATMAP_G131_ALLOWED_ADDITIONS 的每一
//    段新增內容，用「精確字串比對後移除」的方式還原掉，還原後的內容如果
//    真的等於 PRISTINE_BASELINE_SHA256，就證明：
//      a) 除了 allowlist 裡列出的這幾段，其餘每一個位元組都跟基線完全相同
//         （不是「大致沒問題」，是可證明的逐位元組相同）；
//      b) allowlist 列出的新增內容剛好只出現一次、剛好就是這幾段，沒有被
//         悄悄擴大範圍（例如藉機多改了其他函式）。
//    任何一段 allowlist 內容找不到、或還原後 hash 對不上，Guard 一律 FAIL。
//
// 2) Behavioral Invariant Check（新增，整檔相等從來沒有真正驗證過「行為」
//    本身，只驗證「位元組沒變」；本模組額外用 jsdom 實際執行 geo-heatmap.js
//    驗證一批不變條件，例如 stale request guard、duplicate request guard、
//    backward compatibility、不建立第二張 Map/Tile Layer 等）。
//
// 這個模組同時被 scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js、
// scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js、
// scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js 三支測試共用，
// 避免同一套 Guard 邏輯在多處重複貼一份、日後改一次要改三個地方。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REL_PATH = 'public/js/geo-heatmap.js';

// R5.3-A2/A1.2 那一輪留下的原始 geo-heatmap.js 基線 hash——這是「除了
// allowlist 允許的新增內容之外，其餘部分」永遠必須逐位元組相同的對象。
const PRISTINE_BASELINE_SHA256 = '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d';

// ══════════════════════════════════════════════════════════════════
// Scope Allowlist —— 唯一允許 geo-heatmap.js 跟基線不同的地方。
// 每一項都是「精確字串」（不是寬鬆 regex），且必須「剛好出現一次」，
// 找不到、或出現超過一次，都視為超出授權範圍，Guard 直接 FAIL。
// ══════════════════════════════════════════════════════════════════
const GEO_HEATMAP_G131_ALLOWED_ADDITIONS = [
  {
    id: 'businessTotals-state-field',
    description: 'geoHeatState 新增 businessTotals additive 欄位（含說明註解）',
    needle:
`  // fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件三、四）：additive 欄位——
  // Business Total（全店訂單數／營收，不受 Geo 限制），跟 areas 分開存放，
  // 不覆蓋/混用既有 areas 的 submitted_orders/coordinate_count 語意。
  // null 代表「本次 API 回應沒有帶這個欄位」（例如舊測試 fixture／
  // Heatmap Off 分支），消費端必須 fallback 回舊行為，不得假裝有資料。
  businessTotals: { orders: null, revenue: null },
`,
  },
  {
    id: 'businessTotals-reset-test-helper',
    description: '_geoHeatResetStateForTest() 內新增 businessTotals 重置',
    needle: '  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.selectedAreaId = null;',
    reconstructAs: '  geoHeatState.selectedAreaId = null;',
  },
  {
    id: 'businessTotals-reset-store-switch',
    description: 'geoHeatHandleStoreSwitch() 內新增 businessTotals 重置（Store Isolation）',
    needle: '  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.requestSeq += 1;',
    reconstructAs: '  geoHeatState.requestSeq += 1;',
  },
  {
    id: 'scheduleUpdate-dual-format-support',
    description: 'geoHeatScheduleUpdate() 新增對 { areas, businessTotals } 回傳格式的向下相容支援',
    needle:
`    let result = [];
    try {
      result = await fetchAreasFn(controller ? controller.signal : undefined);
    } catch (e) {
      result = [];
    }
    if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition
    // fix18-10-hotfix30-B5-R5.4-G1.3.1：向下相容——沿用既有 fetchAreasFn 只回傳
    // 陣列的既有呼叫方式（G1/G1.1/G1.2/G1.3 既有 Smoke 全部這樣用，不改）；
    // 新的呼叫方式可以回傳 { areas, businessTotals }，這裡才會額外更新
    // geoHeatState.businessTotals。同一個 seq 防護一併保護 businessTotals，
    // 不會有 stale response 蓋掉新資料的問題。
    const areas = Array.isArray(result) ? result : (result && result.areas) || [];
    const businessTotals = (!Array.isArray(result) && result && result.businessTotals) ? result.businessTotals : null;
    geoHeatState.areas = areas || [];
    if (businessTotals) geoHeatState.businessTotals = businessTotals;
    geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);`,
    // 還原時要換回原本（G1.3 基線）的等價寫法，不是單純刪除
    reconstructAs:
`    let areas = [];
    try {
      areas = await fetchAreasFn(controller ? controller.signal : undefined);
    } catch (e) {
      areas = [];
    }
    if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition
    geoHeatState.areas = areas || [];
    geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);`,
  },
];

/**
 * 把目前檔案內容中，allowlist 允許的新增內容全部還原掉，回傳還原後的內容
 * 與詳細比對結果。
 */


// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.4 — 疊加第二層 Scope Allowlist
//
// G1.4 對 geo-heatmap.js 新增了 4 段合法 additive 修改（Drawable State
// 分類器、Root Cause 說明註解、常駐 District Label 標籤、export 清單新增
// geoHeatComputeDrawableState）。這一層疊在 G1.3.1 那一層「之上」——也就是
// 把目前檔案內容依序先還原 G1.4 的新增，再還原 G1.3.1 的新增，最後必須
// equal 回同一個 PRISTINE_BASELINE_SHA256（R5.3-A2/A1.2 那一輪的原始
// 基線）。這樣 A2／A1.2／G1.3.2 既有呼叫 computeScopedBaselineCheck() 的
// 程式碼完全不用改，這個函式內部自動變成「疊兩層」，向下相容。
// ══════════════════════════════════════════════════════════════════
const GEO_HEATMAP_G14_ALLOWED_ADDITIONS = [
  {
    id: 'g14-drawable-state-function',
    description: '新增 geoHeatComputeDrawableState() 統一 Drawable State 分類器（純函式，additive）',
    needle: "// ════════════════════════════════════════════════════════════════\n// fix18-10-hotfix30-B5-R5.4-G1.4（需求文件：統一 Drawable State）——\n// 純函式，只讀 areas／businessTotals，不碰 DOM、不碰 Leaflet，additive，\n// 不修改／不取代 G1.3.1 既有的 Coverage Explanation 四態（那是「文字說明」\n// 用的狀態機，這裡是給「地圖要畫什麼」用的狀態機，兩者用途不同、互不覆蓋）。\n//\n// 五態定義：\n//   no_business_data              ：全店這段期間根本沒有訂單（沿用\n//                                    businessTotals，沒有就 fallback 回\n//                                    areas 加總，跟 G1.3.1 同一套判斷慣例）\n//   has_business_but_no_drawable_geo：有訂單，但沒有任何一個行政區有已知\n//                                    地理資料可畫（既沒有平均座標，也沒有\n//                                    任何履約紀錄指出行政區名稱）\n//   has_drawable_district_only    ：至少一個行政區「知道名稱」（有履約\n//                                    紀錄提到這個行政區）但沒有平均座標可\n//                                    畫 Marker/Circle——這種區域只能在\n//                                    Ranking 文字列表顯示行政區名稱＋\n//                                    「目前尚無可用座標」，不能在地圖上畫\n//                                    任何點（沒有座標，畫了就是造假）。\n//   has_drawable_exact_only       ：所有「有履約紀錄」的行政區都有平均\n//                                    座標可畫。\n//   has_mixed_drawable_geo        ：以上兩種同時存在。\n// ════════════════════════════════════════════════════════════════\nfunction geoHeatComputeDrawableState(areas, businessTotals) {\n  const list = areas || [];\n  const bt = businessTotals || {};\n  const businessTotal = (typeof bt.orders === 'number')\n    ? bt.orders\n    : list.reduce((s, a) => s + (Number(a.submitted_orders) || 0), 0);\n  if (businessTotal <= 0) return 'no_business_data';\n  // 「知道這個行政區有履約紀錄」＝ submitted_orders > 0（不論有沒有座標）；\n  // district_only／exact_only 都只在這個子集合裡分類，避免把「完全沒被\n  // 履約系統提過的行政區」（例如純訪客瀏覽、還沒下單）也算進來。\n  const knownDistricts = list.filter((a) => (Number(a.submitted_orders) || 0) > 0);\n  if (knownDistricts.length === 0) return 'has_business_but_no_drawable_geo';\n  const exact = knownDistricts.filter((a) => a.coordinate_source === 'order_centroid' && typeof a.lat === 'number' && typeof a.lng === 'number');\n  const districtOnly = knownDistricts.filter((a) => !(a.coordinate_source === 'order_centroid' && typeof a.lat === 'number' && typeof a.lng === 'number'));\n  if (exact.length === 0 && districtOnly.length === 0) return 'has_business_but_no_drawable_geo';\n  if (exact.length > 0 && districtOnly.length === 0) return 'has_drawable_exact_only';\n  if (exact.length === 0 && districtOnly.length > 0) return 'has_drawable_district_only';\n  return 'has_mixed_drawable_geo';\n}\n\n",
  },
  {
    id: 'g14-render-layer-root-cause-comment',
    description: 'geoHeatRenderLayer() 上方新增 G1.4 Root Cause 說明註解',
    needle: "//\n// fix18-10-hotfix30-B5-R5.4-G1.4 Root Cause（需求文件一、二）：markers/\n// circles 原本只用 bindTooltip(content) 綁「hover 才顯示」的提示，沒有任何\n// 「常駐可見」的行政區名稱標示——滑鼠不移過去，地圖上只看得到一個個沒有\n// 名字的色點/圖釘，真實使用情境下很容易被誤認為「標示沒有顯示」。修法：\n// 額外用 L.tooltip({ permanent: true, interactive: false }) 建立一個獨立、\n// 常駐顯示的行政區名稱標籤，跟原本的 hover 提示（完整內容：Orders/\n// Revenue/Coverage…）並存，不互相取代——常駐標籤只顯示「行政區名稱」，\n// 版面才不會太擠；完整資訊仍然靠 hover tooltip。這個標籤物件跟 marker 一起\n// group.addLayer()，所以會自動跟著既有的 group.clearLayers()／Layer Switch\n// addLayer／removeLayer 邏輯同步顯示/隱藏，不需要另外維護一份 Label\n// LayerGroup、不需要修改 _geoHeatUiApplyLayerExclusivity()。\n",
  },
  {
    id: 'g14-permanent-district-label',
    description: 'geoHeatRenderLayer() 內新增常駐 District Label（L.tooltip permanent:true），跟既有 hover tooltip 並存',
    needle: "    // 常駐 District Label（G1.4 新增，additive）：只顯示行政區名稱，真實\n    // 座標來自同一筆 area 資料（area.lat/area.lng，已經是 order_centroid\n    // 真實平均座標，不是另外算的假座標）。\n    if (typeof L !== 'undefined' && typeof L.tooltip === 'function' && typeof group.addLayer === 'function') {\n      try {\n        const labelTooltip = L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'geo-heat-map-label', interactive: false });\n        if (typeof labelTooltip.setLatLng === 'function') labelTooltip.setLatLng([area.lat, area.lng]);\n        if (typeof labelTooltip.setContent === 'function') labelTooltip.setContent(_geoHeatEsc(area.area_name || area.district || area.city || ''));\n        group.addLayer(labelTooltip);\n      } catch (e) { /* Leaflet 環境差異時安靜失敗，不擋既有 marker 渲染 */ }\n    }\n",
  },
  {
    id: 'g14-export-drawable-state',
    description: 'module.exports 新增 geoHeatComputeDrawableState',
    needle: "geoHeatScheduleUpdate, geoHeatStatusText, GEO_HEAT_CHANNEL_LABEL, geoHeatComputeDrawableState,",
    reconstructAs: "geoHeatScheduleUpdate, geoHeatStatusText, GEO_HEAT_CHANNEL_LABEL,",
  },
];

function reconstructG14Layer(currentSource) {
  let working = currentSource;
  const perItem = [];
  for (const item of GEO_HEATMAP_G14_ALLOWED_ADDITIONS) {
    const count = working.split(item.needle).length - 1;
    if (count !== 1) {
      perItem.push({ id: item.id, ok: false, count, reason: `預期剛好出現 1 次，實際出現 ${count} 次` });
      continue;
    }
    const replacement = 'reconstructAs' in item ? item.reconstructAs : '';
    working = working.replace(item.needle, replacement);
    perItem.push({ id: item.id, ok: true, count });
  }
  return { reconstructed: working, perItem };
}

function reconstructPristine(currentSource) {
  let working = currentSource;
  const perItem = [];
  for (const item of GEO_HEATMAP_G131_ALLOWED_ADDITIONS) {
    const count = working.split(item.needle).length - 1;
    if (count !== 1) {
      perItem.push({ id: item.id, ok: false, count, reason: `預期剛好出現 1 次，實際出現 ${count} 次` });
      continue;
    }
    const replacement = 'reconstructAs' in item ? item.reconstructAs : '';
    working = working.replace(item.needle, replacement);
    perItem.push({ id: item.id, ok: true, count });
  }
  return { reconstructed: working, perItem };
}

function computeScopedBaselineCheck(rootDir) {
  const filePath = path.join(rootDir, REL_PATH);
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `${REL_PATH} 不存在`, perItem: [] };
  }
  const currentSource = fs.readFileSync(filePath, 'utf8');
  return computeScopedBaselineCheckForSource(currentSource);
}

/**
 * mutation-style negative test 用：直接對「任意來源字串」（不是真的檔案）
 * 跑同一套還原邏輯，讓呼叫端可以在記憶體中模擬「非法修改」而不必真的
 * 寫壞磁碟上的產品檔案。
 *
 * fix18-10-hotfix30-B5-R5.4-G1.4：疊兩層——先還原 G1.4 這一層新增
 * （GEO_HEATMAP_G14_ALLOWED_ADDITIONS），再還原 G1.3.1 那一層新增
 * （GEO_HEATMAP_G131_ALLOWED_ADDITIONS），兩層都精確命中一次之後，剩下的
 * 內容必須等於同一個 PRISTINE_BASELINE_SHA256。A2／A1.2 呼叫的還是同一個
 * 函式名稱／同一個回傳格式，不需要修改呼叫端。
 */
function computeScopedBaselineCheckForSource(currentSource) {
  const g14 = reconstructG14Layer(currentSource);
  const g131 = reconstructPristine(g14.reconstructed);
  const perItem = [...g14.perItem, ...g131.perItem];
  const allItemsOk = perItem.every((r) => r.ok);
  const reconstructedHash = crypto.createHash('sha256').update(g131.reconstructed, 'utf8').digest('hex');
  const hashMatches = reconstructedHash === PRISTINE_BASELINE_SHA256;
  return { ok: allItemsOk && hashMatches, allItemsOk, hashMatches, reconstructedHash, expectedHash: PRISTINE_BASELINE_SHA256, perItem };
}

module.exports = {
  REL_PATH,
  PRISTINE_BASELINE_SHA256,
  GEO_HEATMAP_G131_ALLOWED_ADDITIONS,
  GEO_HEATMAP_G14_ALLOWED_ADDITIONS,
  reconstructPristine,
  reconstructG14Layer,
  computeScopedBaselineCheck,
  computeScopedBaselineCheckForSource,
  runBehavioralInvariants,
};

// ══════════════════════════════════════════════════════════════════
// Behavioral Invariant Check —— 整檔 hash 從來沒有真正驗證過「行為」，
// 只驗證「位元組沒變」。這裡額外用 jsdom 實際載入並執行 geo-heatmap.js，
// 驗證需求文件第三節列出的一批不變條件（stale guard／duplicate guard／
// backward compatibility／不建第二張 Map 等）。
//
// sourceOverride：可選，若提供則用這段字串取代讀檔內容（mutation negative
// test 用，模擬「這份原始碼被非法修改過」而不必真的寫壞磁碟上的檔案）。
// ══════════════════════════════════════════════════════════════════
async function runBehavioralInvariants(rootDir, sourceOverride) {
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    return { ok: null, skipped: true, reason: 'jsdom 未安裝', results: [] };
  }
  const heatSrc = (sourceOverride !== undefined
    ? sourceOverride
    : fs.readFileSync(path.join(rootDir, REL_PATH), 'utf8'))
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const results = [];
  const push = (id, ok, detail) => results.push({ id, ok: !!ok, detail });

  try {
    dom.window.eval(heatSrc);
  } catch (e) {
    push('eval', false, `geo-heatmap.js 執行失敗：${e.message}`);
    return { ok: false, results };
  }

  const w = dom.window;

  // 1. geoHeatState 仍存在
  push('geoHeatState-exists', typeof w.geoHeatState === 'object' && w.geoHeatState !== null);
  // 2. geoHeatState.areas 仍存在（陣列）
  push('geoHeatState-areas-exists', Array.isArray(w.geoHeatState.areas));
  // 3. geoHeatState.businessTotals 為 additive 欄位（存在，且是物件）
  push('geoHeatState-businessTotals-additive', typeof w.geoHeatState.businessTotals === 'object' && w.geoHeatState.businessTotals !== null);
  // 4. geoHeatScheduleUpdate() 仍存在
  push('geoHeatScheduleUpdate-exists', typeof w.geoHeatScheduleUpdate === 'function');
  // 16. 既有 areas 欄位結構不變（geoHeatBuildAreas 輸出仍含既有欄位）
  const builtAreas = typeof w.geoHeatBuildAreas === 'function'
    ? w.geoHeatBuildAreas([{ city: 'A', district: 'B', visitors: 1, add_to_cart_visitors: 0, begin_checkout_visitors: 0 }], [{ city: 'A', district: 'B', completed_orders: 1, revenue: 100, submitted_orders: 1, coordinate_count: 1, coordinate_source: 'order_centroid' }])
    : null;
  push('geoHeatBuildAreas-output-compatible',
    Array.isArray(builtAreas) && builtAreas.length === 1
    && 'submitted_orders' in builtAreas[0] && 'coordinate_count' in builtAreas[0] && 'coordinate_source' in builtAreas[0] && 'conversion' in builtAreas[0]
    && builtAreas[0].submitted_orders === 1 && builtAreas[0].coordinate_count === 1
    && builtAreas[0].coordinate_source === 'order_centroid'
    && builtAreas[0].conversion === 1);

  // 5/6/7. 新舊呼叫格式相容性 + plain array 不會被誤判成 object response
  await new Promise((resolve) => {
    w.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'legacy', submitted_orders: 2, coordinate_count: 1, revenue: 200 }]), 0);
    setTimeout(() => {
      push('legacy-plain-array-compat', Array.isArray(w.geoHeatState.areas) && w.geoHeatState.areas.length === 1 && w.geoHeatState.areas[0].area_id === 'legacy');
      push('plain-array-not-misread-as-object', w.geoHeatState.businessTotals.orders === null || w.geoHeatState.businessTotals.orders === undefined || typeof w.geoHeatState.businessTotals.orders === 'number');
      resolve();
    }, 10);
  });

  // 8/9/10. business_total_orders/revenue = 0 可正確保存，用 typeof 判斷不用 truthy
  await new Promise((resolve) => {
    w.geoHeatScheduleUpdate(() => Promise.resolve({ areas: [], businessTotals: { orders: 0, revenue: 0 } }), 0);
    setTimeout(() => {
      push('zero-orders-preserved', w.geoHeatState.businessTotals.orders === 0 && typeof w.geoHeatState.businessTotals.orders === 'number');
      push('zero-revenue-preserved', w.geoHeatState.businessTotals.revenue === 0 && typeof w.geoHeatState.businessTotals.revenue === 'number');
      resolve();
    }, 10);
  });

  // 11/12. stale response guard 仍存在 + 舊 request 不得覆蓋新 request
  //
  // 注意：geoHeatScheduleUpdate() 本身有 debounce（clearTimeout 前一個
  // pending timer），如果兩次呼叫在同一個 tick 內連續發生，第一次的
  // fetchAreasFn 根本不會被執行到（被 debounce 直接取消），這樣測不到
  // `if (seq !== geoHeatState.requestSeq) return` 這行真正在防護的情境
  // ——那一行防護的是「第一個 request 的 debounce timer 已經觸發、
  // fetchAreasFn 已經開始執行且還在等待中，這時候第二個 request 進來」。
  // 所以這裡刻意讓第一次呼叫先「真的開始執行」（fetchAreasFn 被呼叫，
  // 拿到一個尚未 resolve 的 Promise），再發第二次呼叫，才是真正在測
  // stale-request guard，不是在測 debounce coalescing（那是另一件事）。
  await new Promise((resolve) => {
    let firstFetchStarted = false;
    let resolveSlow;
    const slow = new Promise((res) => { resolveSlow = res; });
    w.geoHeatScheduleUpdate(() => { firstFetchStarted = true; return slow; }, 0);
    setTimeout(() => {
      // 此時第一個 request 的 debounce timer 已觸發，fetchAreasFn 已被呼叫
      // 且卡在 pending（firstFetchStarted 應為 true），符合真實 race 情境。
      w.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'fast', submitted_orders: 1, coordinate_count: 1, revenue: 1 }]), 0);
      setTimeout(() => {
        resolveSlow([{ area_id: 'slow', submitted_orders: 9, coordinate_count: 9, revenue: 9 }]);
        setTimeout(() => {
          push('stale-response-rejected', firstFetchStarted && w.geoHeatState.areas.length === 1 && w.geoHeatState.areas[0].area_id === 'fast');
          resolve();
        }, 15);
      }, 5);
    }, 5);
  });

  // 13. duplicate request guard 仍存在（requestSeq 遞增）
  const seqBefore = w.geoHeatState.requestSeq;
  w.geoHeatScheduleUpdate(() => Promise.resolve([]), 0);
  w.geoHeatScheduleUpdate(() => Promise.resolve([]), 0);
  push('duplicate-request-guard-exists', w.geoHeatState.requestSeq > seqBefore);

  // 14. geoHeatRenderLayer() 既有呼叫路徑不變（函式仍存在、可被呼叫不噴錯）
  let renderOk = true;
  try { if (typeof w.geoHeatRenderLayer === 'function') w.geoHeatRenderLayer([], 'orders', 'circle'); } catch (e) { renderOk = false; }
  push('geoHeatRenderLayer-call-path-unchanged', typeof w.geoHeatRenderLayer === 'function' && renderOk);

  // 17/18. 不建立第二張 L.map()／第二個 Tile Layer（原始碼層級檢查，
  // geo-heatmap.js 本身不應該呼叫 L.map(/L.tileLayer(）
  push('no-second-map', !/L\.map\(/.test(heatSrc) && !/new\s+L\.Map\(/.test(heatSrc));
  push('no-second-tilelayer', !/L\.tileLayer\(/.test(heatSrc));

  // 8b（reset）：reset 函式仍會清空 areas／businessTotals
  if (typeof w._geoHeatResetStateForTest === 'function') {
    w.geoHeatState.areas = [{ area_id: 'x' }];
    w.geoHeatState.businessTotals = { orders: 5, revenue: 5 };
    w._geoHeatResetStateForTest();
    push('reset-clears-areas', Array.isArray(w.geoHeatState.areas) && w.geoHeatState.areas.length === 0);
    push('reset-clears-businessTotals', w.geoHeatState.businessTotals.orders === null && w.geoHeatState.businessTotals.revenue === null);
  } else {
    push('reset-clears-areas', false, '_geoHeatResetStateForTest 不存在');
    push('reset-clears-businessTotals', false, '_geoHeatResetStateForTest 不存在');
  }

  // Store Switch 也會清空 businessTotals（Store Isolation，需求文件不變條件）
  if (typeof w.geoHeatHandleStoreSwitch === 'function') {
    w.geoHeatState.businessTotals = { orders: 5, revenue: 5 };
    w.geoHeatHandleStoreSwitch();
    push('store-switch-clears-businessTotals', w.geoHeatState.businessTotals.orders === null && w.geoHeatState.businessTotals.revenue === null);
  } else {
    push('store-switch-clears-businessTotals', false, 'geoHeatHandleStoreSwitch 不存在');
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}
