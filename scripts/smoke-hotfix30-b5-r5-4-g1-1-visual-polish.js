#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-1-visual-polish.js
// fix18-10-hotfix30-B5-R5.4-G1.1 — Geo Intelligence Visual Polish
//
// 純前端 Visual Polish：不涉及 DB/API 變更，只驗證 public/js/geo-live-layer.js
// 新增的純函式與 CSS 產出是否正確。沿用專案既有慣例（node --check + 純函式
// 直接 require() 單元測試）。

'use strict';

const path = require('path');
const fs = require('fs');
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
  console.log('VISUAL SMOKE SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.1 (Geo Intelligence Visual Polish)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// 0. node --check
['public/js/geo-live-layer.js', 'public/js/geo-live-coordinate.js'].forEach((rel) => {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
    pass(`0-parse ${rel} node --check 通過`);
  } catch (e) {
    fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200));
  }
});

const G = require(path.join(ROOT, 'public/js/geo-live-layer.js'));

// ══════════════════════════════════════════════════════════════
// 一、Heat Radius / Legend
// ══════════════════════════════════════════════════════════════
assert(G.buildHeatOptions(1).radius === 45, '1-1 只有 1 筆資料時 radius 放大到 45（肉眼可辨）');
assert(G.buildHeatOptions(2).radius === 45, '1-2 只有 2 筆資料時 radius 同樣放大');
assert(G.buildHeatOptions(3).radius === 45, '1-3 剛好 3 筆資料時仍屬「極少筆」放大範圍');
assert(G.buildHeatOptions(4).radius === 35, '1-4 4 筆資料進入中段設定（35）');
assert(G.buildHeatOptions(10).radius === 35, '1-5 10 筆資料仍屬中段設定');
assert(G.buildHeatOptions(11).radius === 25, '1-6 11 筆以上進入一般設定（25，不會過度膨脹）');
assert(G.buildHeatOptions(1).minOpacity >= 0.6, '1-7 極少筆資料時 minOpacity 夠高，不會「淡淡一層」');
assert(G.buildHeatOptions(1).blur > 0 && G.buildHeatOptions(1).maxZoom > 0, '1-8 heat options 含 blur/maxZoom 合法值');
const gradientKeys = Object.keys(G.buildHeatOptions(5).gradient).map(Number).sort((a, b) => a - b);
assert(gradientKeys.length === 5, '1-9 Heat 漸層有 5 個色階（低→高，不是只有一層）');
assert(G.buildHeatOptions(5).gradient[0.2] !== G.buildHeatOptions(5).gradient[1], '1-10 漸層低階與最高階顏色不同');
assert(Array.isArray(G.HEAT_LEGEND_STOPS) && G.HEAT_LEGEND_STOPS.length === 4, '1-11 Heatmap Legend 固定 4 個色階說明（低/中/高/最高）');
assert(G.HEAT_LEGEND_STOPS.every((s) => s.emoji && s.label), '1-12 每個 Legend 色階都有 emoji 與文字說明（不只靠顏色）');

// ══════════════════════════════════════════════════════════════
// 二、Circle Mode
// ══════════════════════════════════════════════════════════════
assert(G.METRIC_COLORS.visitors === '#3b82f6', '2-1 Visitors 指標為藍色');
assert(G.METRIC_COLORS.orders !== G.METRIC_COLORS.visitors, '2-2 Orders 顏色與 Visitors 不同');
assert(G.METRIC_COLORS.revenue !== G.METRIC_COLORS.orders, '2-3 Revenue 顏色與 Orders 不同');
assert(G.METRIC_COLORS.conversion !== G.METRIC_COLORS.revenue, '2-4 Conversion 顏色與 Revenue 不同');
const c1 = G.buildCircleStyle('orders', 2, 0, 10);
const c2 = G.buildCircleStyle('orders', 8, 0, 10);
assert(c2.radius > c1.radius, '2-5 數值較高的 Circle 半徑較大（依比例縮放，不固定大小）');
assert(c1.radius >= G.CIRCLE_MIN_RADIUS_PX && c2.radius <= G.CIRCLE_MAX_RADIUS_PX, '2-6 Circle 半徑落在合法上下限範圍');
const cSingle = G.buildCircleStyle('revenue', 5, 5, 5);
assert(cSingle.radius === G.CIRCLE_MAX_RADIUS_PX, '2-7 只有單一數值時仍給予可辨識大小（不是縮成最小點）');

// ══════════════════════════════════════════════════════════════
// 三、Marker Mode（不同 Icon／Tooltip）
// ══════════════════════════════════════════════════════════════
assert(G.resolveMarkerStage('purchase') === 'order', '3-1 purchase 事件對應 order 階段（綠色）');
assert(G.resolveMarkerStage('begin_checkout') === 'checkout', '3-2 begin_checkout 對應 checkout 階段（橘色）');
assert(G.resolveMarkerStage('page_view') === 'visitor', '3-3 page_view 對應 visitor 階段（藍色）');
assert(G.resolveMarkerStage(undefined) === 'visitor', '3-4 未知事件安全退回 visitor 階段（不拋例外）');
assert(G.markerColorForStage('order') === G.MARKER_STAGE_COLORS.order, '3-5 markerColorForStage 對應正確顏色');
assert(G.markerColorForStage('bogus_stage') === G.MARKER_STAGE_COLORS.visitor, '3-6 未知階段安全退回 visitor 顏色');
const tooltipFields = G.buildMarkerTooltipFields({ visitor_key: 'v1', event_name: 'purchase', channel: 'LINE', device_type: 'iphone', accuracy_m: 12 });
assert(tooltipFields.channel === 'LINE' && tooltipFields.device === 'iphone', '3-7 Tooltip 含 Channel/Device 欄位');
assert(!/undefined|NaN|Infinity/.test(JSON.stringify(tooltipFields)), '3-8 Tooltip 欄位序列化後不含 undefined/NaN/Infinity');

// ══════════════════════════════════════════════════════════════
// 四、Auto Fit Bounds
// ══════════════════════════════════════════════════════════════
assert(G.shouldAutoFitBounds(true, false) === true, '4-1 第一次有資料時應該 Auto Fit');
assert(G.shouldAutoFitBounds(true, true) === false, '4-2 已經 Auto Fit 過，即使有資料也不再強制跳（不得每次 Filter 都跳）');
assert(G.shouldAutoFitBounds(false, false) === false, '4-3 沒有資料時不 Auto Fit（維持目前預設）');
assert(G.shouldAutoFitBounds(false, true) === false, '4-4 已完成過、又剛好沒資料時也不觸發');

// ══════════════════════════════════════════════════════════════
// 五、Summary Card
// ══════════════════════════════════════════════════════════════
const summaryInput = {
  districtRows: [
    { district: '中壢區', visitor_count: 42, order_count: 6, conversion_rate_pct: 14.3 },
    { district: '平鎮區', visitor_count: 31, order_count: 2, conversion_rate_pct: 6.5 },
  ],
  unknownPool: { total: 100, unknown: 18, mappable_rate_pct: 25 },
};
const summary = G.buildSummaryCard(summaryInput);
assert(summary.top_visitors.label === '中壢區' && summary.top_visitors.value === 42, '5-1 Summary 正確找出最高訪客區域');
assert(summary.top_orders.label === '中壢區' && summary.top_orders.value === 6, '5-2 Summary 正確找出最高成交區域');
assert(summary.top_revenue === null && summary.revenue_available === false, '5-3 沒有 revenue 資料時誠實回傳 null（不臆測假營收）');
assert(summary.avg_distance_km === null && summary.distance_available === false, '5-4 沒有 distance 資料時誠實回傳 null');
assert(typeof summary.avg_conversion_rate_pct === 'number', '5-5 Summary 含平均轉換率（數字）');
assert(summary.gps_coverage_pct === 25, '5-6 Summary 正確帶入 GPS Coverage 百分比');
assert(summary.unknown_pct === 18, '5-7 Summary 正確計算 Unknown 百分比');
const summaryWithRevenue = G.buildSummaryCard({ districtRows: [{ district: 'X', visitor_count: 1, order_count: 1, revenue: 500 }], unknownPool: {} });
assert(summaryWithRevenue.revenue_available === true && summaryWithRevenue.top_revenue.value === 500, '5-8 若資料含 revenue 欄位則正確帶出（forward-compatible）');
assert(G.buildSummaryCard({ districtRows: [], unknownPool: {} }).top_visitors === null, '5-9 空資料時 top_visitors 安全回傳 null（不拋例外）');

// ══════════════════════════════════════════════════════════════
// 六、Ranking
// ══════════════════════════════════════════════════════════════
const rankRows = [
  { district: 'A', visitor_count: 5, add_to_cart_count: 1, checkout_count: 1, order_count: 1, conversion_rate_pct: 20 },
  { district: 'B', visitor_count: 42, add_to_cart_count: 10, checkout_count: 8, order_count: 6, conversion_rate_pct: 14.3 },
];
const ranked = G.buildRankingTable(rankRows, 'visitor_count');
assert(ranked[0].district === undefined && ranked[0].label === 'B', '6-1 Ranking 依 visitor_count 排序，B（42）排第一');
assert(ranked[0].rank === 1 && ranked[1].rank === 2, '6-2 Ranking 正確標示排名序號');
assert('order_count' in ranked[0] && 'conversion_rate_pct' in ranked[0], '6-3 Ranking 含訂單數與成交率欄位');
const rankedByConversion = G.buildRankingTable(rankRows, 'conversion_rate_pct');
assert(rankedByConversion[0].label === 'A', '6-4 切換 Metric（成交率）後排序跟著改變（A 20% > B 14.3%）');
assert(G.resolveRankingClickAction({ lat: 24.9, lng: 121.2 }).action === 'panTo', '6-5 有座標時點擊 Ranking 回傳 panTo 動作');
assert(G.resolveRankingClickAction({}).action === 'no_coordinate' && G.resolveRankingClickAction({}).message === '目前無地圖座標', '6-6 沒有座標時明確顯示「目前無地圖座標」');

// ══════════════════════════════════════════════════════════════
// 七、Coverage Panel（Progress Bar）
// ══════════════════════════════════════════════════════════════
const cov = G.buildCoveragePanel({ coverage_pct: 82, mappable_rate_pct: 63, total: 120, unknown: 22 });
assert(cov.known_pct === 82 && cov.gps_pct === 63, '7-1 Coverage Panel 正確帶入已知/GPS 百分比');
assert(Math.abs(cov.unknown_pct - (22 / 120 * 100)) < 0.01, '7-2 Coverage Panel 正確計算 Unknown 百分比');
assert(G.buildCoveragePanel({ coverage_pct: 999 }).known_pct === 100, '7-3 Coverage 百分比超過 100 時 clamp 到 100（Progress Bar 不會爆版）');
assert(G.buildCoveragePanel({ coverage_pct: -5 }).known_pct === 0, '7-4 Coverage 百分比為負時 clamp 到 0');

// ══════════════════════════════════════════════════════════════
// 八、Business Opportunity（Rule-based，非 AI）
// ══════════════════════════════════════════════════════════════
const oppRows = [
  { district: '高轉換區', conversion_rate_pct: 85, order_count: 3, visitor_count: 20 },
  { district: '低轉換區', conversion_rate_pct: 1, order_count: 0, visitor_count: 200 },
];
const opportunities = G.buildBusinessOpportunities(oppRows);
assert(opportunities.some((o) => o.type === 'high_conversion' && o.district === '高轉換區'), '8-1 成交率>80%且有訂單時觸發「高轉換」建議');
assert(opportunities.some((o) => o.type === 'high_traffic_low_conversion' && o.district === '低轉換區'), '8-2 訪客多但轉換率低時觸發「檢查價格/優惠券/結帳流程」建議');
assert(G.buildBusinessOpportunities([]).length === 0, '8-3 沒有資料時不產生任何建議（不硬湊假建議）');
assert(opportunities.every((o) => typeof o.message === 'string' && o.message.length > 0), '8-4 每個建議都有可讀文字說明');

// ══════════════════════════════════════════════════════════════
// 九、Recommended Actions（前三個）
// ══════════════════════════════════════════════════════════════
const recRows = [
  { district: '龍潭區', conversion_rate_pct: 95, visitor_count: 10, checkout_count: 2 },
  { district: '八德區', conversion_rate_pct: 0, visitor_count: 30, checkout_count: 0 },
];
const recommended = G.buildRecommendedActions(recRows, { gps_pct: 20 });
assert(recommended.length <= 3, '9-1 Recommended Actions 最多輸出 3 個');
assert(recommended.some((r) => r.includes('龍潭區') && r.includes('成交率最高')), '9-2 正確標示成交率最高的區域並建議增加曝光');
assert(recommended.some((r) => r.includes('定位同意率偏低')), '9-3 GPS 覆蓋率低時建議提高定位同意率');
assert(recommended.some((r) => r.includes('無結帳')), '9-4 有訪客無結帳時建議改善結帳流程');

// ══════════════════════════════════════════════════════════════
// 十、區域優惠建議（純建議，不修改優惠系統）
// ══════════════════════════════════════════════════════════════
const discounts = G.buildRegionDiscountSuggestions([{ district: 'P1' }, { district: 'P2' }, { district: 'P3' }, { district: 'P4' }]);
assert(discounts.length === 3, '10-1 區域優惠建議最多依 Top3 排名產生');
assert(new Set(discounts.map((d) => d.suggestion)).size === 3, '10-2 三個建議彼此不同（不是同一種建議重複三次）');
assert(discounts[0].district === 'P1', '10-3 優惠建議依 Ranking 順序對應區域（動態資料，非硬編碼特定地名）');

// ══════════════════════════════════════════════════════════════
// 十一、外送最佳化（誠實：沒有 distance 欄位時 available:false）
// ══════════════════════════════════════════════════════════════
assert(G.buildDeliveryOptimization([]).available === false, '11-1 沒有任何列時 available:false');
assert(G.buildDeliveryOptimization([{}]).available === false, '11-2 列存在但沒有 distance_km 時 available:false（不臆測假距離）');
const deliveryOpt = G.buildDeliveryOptimization([{ distance_km: 3 }, { distance_km: 9, delivery_fee: 60 }]);
assert(deliveryOpt.available === true && deliveryOpt.avg_distance_km === 6, '11-3 有 distance_km 時正確計算平均距離');
assert(deliveryOpt.suggest_fee_review === true, '11-4 平均距離超過門檻時建議檢視運費');
assert(G.DELIVERY_DISTANCE_ALERT_KM === 5, '11-5 外送距離警戒門檻為 5 公里');

// ══════════════════════════════════════════════════════════════
// LocalStorage（顯示模式記憶）
// ══════════════════════════════════════════════════════════════
function makeFakeStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
}
const fakeStorage1 = makeFakeStorage();
assert(G.getLastDisplayMode(fakeStorage1) === null, 'LS-1 尚未儲存過時回傳 null');
assert(G.saveLastDisplayMode('heatmap', fakeStorage1) === true, 'LS-2 儲存合法模式成功');
assert(G.getLastDisplayMode(fakeStorage1) === 'heatmap', 'LS-3 讀回剛剛儲存的模式');
assert(G.saveLastDisplayMode('not_a_real_mode', fakeStorage1) === false, 'LS-4 儲存不合法模式被拒絕（回傳 false）');
assert(G.getLastDisplayMode(fakeStorage1) === 'heatmap', 'LS-5 不合法模式被拒絕後，先前儲存的合法值不受影響');

// ══════════════════════════════════════════════════════════════
// 十五、動畫（200~300ms，不得過度）
// ══════════════════════════════════════════════════════════════
assert(G.isAcceptableAnimationDuration(G.ANIMATION_DURATION_MS) === true, 'ANIM-1 預設動畫時長落在 200~300ms 範圍');
assert(G.isAcceptableAnimationDuration(199) === false, 'ANIM-2 低於 200ms 判定不合格');
assert(G.isAcceptableAnimationDuration(301) === false, 'ANIM-3 高於 300ms 判定不合格（動畫過度）');
assert(G.isAcceptableAnimationDuration(1000) === false, 'ANIM-4 1 秒的誇張動畫被拒絕');

// ══════════════════════════════════════════════════════════════
// 十八、Accessibility Hooks
// ══════════════════════════════════════════════════════════════
assert(typeof G.ARIA_LABELS.modeSwitcher === 'string' && G.ARIA_LABELS.modeSwitcher.length > 0, 'A11Y-1 模式切換有 aria-label 文案');
assert(typeof G.ARIA_LABELS.heatToggle === 'string', 'A11Y-2 Heatmap Toggle 有 aria-label 文案');
assert(typeof G.ARIA_LABELS.legend === 'string', 'A11Y-3 Legend 有 aria-label 文案');
assert(typeof G.ARIA_LABELS.rankingRow === 'string', 'A11Y-4 Ranking Row 有 aria-label 文案（可點擊項目需要）');

// ══════════════════════════════════════════════════════════════
// CSS 稽核：Progress Bar / Segmented Control / Switch / Dark Theme / 響應式 / 動畫 / Marker 顏色
// ══════════════════════════════════════════════════════════════
const cssText = fs.readFileSync(path.join(ROOT, 'public/css/geo-live-layer.css'), 'utf8');
assert(/\.geo-live-progress-track/.test(cssText) && /\.geo-live-progress-fill/.test(cssText), 'CSS-1 Progress Bar 樣式存在');
assert(/\.geo-live-segmented\b/.test(cssText) && /aria-pressed/.test(cssText), 'CSS-2 Segmented Control 樣式存在且支援 aria-pressed 高亮');
assert(/\.geo-live-switch\b/.test(cssText), 'CSS-3 Switch 樣式存在（取代原本純文字 Toggle）');
assert(/\[data-theme="dark"\]|\.geo-live-theme-dark/.test(cssText), 'CSS-4 Dark Theme 樣式存在');
assert(/prefers-reduced-motion/.test(cssText), 'CSS-5 尊重使用者「減少動畫」偏好設定');
assert(/geoLiveFadeIn|geoLiveZoomIn/.test(cssText), 'CSS-6 定義 Marker Fade In / Circle Zoom 動畫關鍵影格');
assert(/max-width:\s*390px/.test(cssText), 'CSS-7 CSS 含 390px（手機）響應式斷點');
assert(/min-width:\s*1024px/.test(cssText), 'CSS-8 CSS 含 1024px 響應式斷點');
assert(/geo-live-marker-stage-visitor/.test(cssText) && /geo-live-marker-stage-order/.test(cssText), 'CSS-9 不同事件階段有各自的 Marker 顏色樣式');
assert(/focus-visible/.test(cssText), 'CSS-10 互動元件有 :focus-visible 樣式（鍵盤可視焦點）');

printSummary();
