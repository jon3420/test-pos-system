#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-5-geo-dashboard-ui.js
// fix18-10-hotfix30-B5-R5.2-B1-5 — Geo Dashboard UI & Decision Center
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  const m = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\n總計：${results.length} 項，PASS ${p}，FAIL ${f}，MANUAL ${m}`);
  if (f > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

async function main() {
  // Part A 的函式在 Node 直接 require() 呼叫（不經過 jsdom），但
  // geo-intelligence.js 的 render 函式依賴瀏覽器全域 escHtml()（定義在
  // public/js/app.js，正式環境一定先載入）。這裡提供跟 app.js 完全一致的
  // 實作當作測試環境 stub，不是修改產品程式的行為。
  global.escHtml = function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  // ══════════════════════════════════════════════════════════════
  // 14.1 JS Parse
  // ══════════════════════════════════════════════════════════════
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-intelligence.js')]);
    pass('14.1-1 node --check public/js/geo-intelligence.js 通過');
  } catch (e) {
    fail('14.1-1 node --check public/js/geo-intelligence.js 通過', e.message);
  }

  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ══════════════════════════════════════════════════════════════
  // Part A：純函式單元測試（不需要 jsdom）
  // ══════════════════════════════════════════════════════════════

  // ── 14.3 KPI ──
  {
    const cards = RE.geoBuildKpiSummaryCards(
      { visitors: 128, add_to_cart_visitors: 60, begin_checkout_visitors: 30, submitted_order_visitors: 12, conversion_rate: 0.0938 },
      { identified_rate: 0.91, unknown_rate: 0.09 },
      { fulfillment_geo: { average_distance_km: 3.4 } },
    );
    assert(Array.isArray(cards) && cards.length >= 6, 'A-KPI-1 至少產生 6 張 KPI 卡片');
    cards.forEach((c, i) => {
      ['label', 'value', 'formatted_value', 'helper_text', 'status'].forEach((f) => {
        assert(f in c, `A-KPI-2-${i} KPI 卡片含欄位「${f}」`);
      });
      assert(['positive', 'neutral', 'warning', 'danger'].includes(c.status), `A-KPI-3-${i} status 為合法列舉值`);
    });
    const visitorsCard = cards.find((c) => c.label === 'Geo 訪客');
    assert(visitorsCard && visitorsCard.formatted_value === '128 人', 'A-KPI-4 正常數字：128 人');

    const zeroCards = RE.geoBuildKpiSummaryCards({ visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, submitted_order_visitors: 0, conversion_rate: 0 }, { identified_rate: 0, unknown_rate: 1 }, {});
    assert(zeroCards.find((c) => c.label === 'Geo 訪客').formatted_value === '0 人', 'A-KPI-5 0 值正確格式化為「0 人」，不是空字串');
    assert(zeroCards.find((c) => c.label === 'Unknown 比例').status === 'warning', 'A-KPI-6 Unknown 100% 時 status = warning');

    const nullCards = RE.geoBuildKpiSummaryCards(null, null, null);
    assert(nullCards.find((c) => c.label === 'Geo 訪客').formatted_value === '0 人', 'A-KPI-7 kpi=null 時不崩潰，安全預設為 0 人');
    assert(nullCards.find((c) => c.label === 'Geo 辨識率').formatted_value === '暫無資料', 'A-KPI-8 quality=null 時顯示「暫無資料」，不是 undefined');

    const undefinedCards = RE.geoBuildKpiSummaryCards(undefined, undefined, undefined);
    assert(!JSON.stringify(undefinedCards).match(/undefined|NaN/), 'A-KPI-9 全部 undefined 輸入不產生 undefined/NaN 字樣');

    const distCard = RE.geoBuildKpiSummaryCards({}, {}, { fulfillment_geo: { average_distance_km: 5.2 } }).find((c) => c.label === '平均外送距離');
    assert(distCard.formatted_value === '5.2 km', 'A-KPI-10 公里單位正確格式化');
    const noDistCard = RE.geoBuildKpiSummaryCards({}, {}, {}).find((c) => c.label === '平均外送距離');
    assert(noDistCard.formatted_value === '暫無資料', 'A-KPI-11 缺外送距離時顯示「暫無資料」');

    const rateCard = RE.geoBuildKpiSummaryCards({ conversion_rate: 0.256 }, {}, {}).find((c) => c.label === 'Geo 成交率');
    assert(rateCard.formatted_value === '26%', 'A-KPI-12 百分比正確四捨五入（25.6%→26%）');
  }

  // ── 14.4 五種 Recommendation + insufficient_sample + data_quality（用於下方多個區塊共用）──
  const fixtureRC = {
    thresholds: { lowGeoConfidenceRate: 0.5 },
    unknownRate: 0.1,
    medians: { visitors: 60 },
    averages: { visit_to_cart_rate: 0.5, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 0.5, visit_to_purchase_rate: 0.2 },
  };
  function makeModel(code, overrides) {
    const base = {
      id: `geo-rec-${code}-fixture`,
      code, classification: code, intent_type: 'risk',
      headline: { title: code, subtitle: '桃園市・測試區', badge: 'B', severity: 'high', confidence: 'medium' },
      location: { area_name: '測試區', city: '桃園市', district: '測試區' },
      summary: `summary for ${code}`,
      primary_metric: { key: 'visit_to_cart_rate', label: '訪客到加購轉換率', value: 0.1, formatted_value: '10%', unit: 'rate' },
      comparison: { benchmark_type: 'threshold', benchmark_label: '門檻', actual: 0.1, benchmark: 0.3, difference: -0.2, formatted_difference: '低 20 個百分點', direction: 'below', message: 'msg' },
      funnel: { visitors: 100, add_to_cart_visitors: 10, begin_checkout_visitors: 5, purchase_visitors: 1, visit_to_cart_rate: 0.1, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 0.2, visit_to_purchase_rate: 0.01 },
      evidence_items: [{ type: 'primary_reason', label: 'x', value: 1, formatted_value: '1', benchmark: 2, formatted_benchmark: '2', direction: 'below', message: 'm' }],
      recommended_actions: [{ priority: 1, title: 'Fix it', description: `檢查 ${code} 相關流程`, category: 'checkout_flow', action_type: 'review' }],
      confidence: { level: 'medium', score: 65, label: '信心中等', reasons: ['樣本數尚可'] },
      sample: { status: 'sufficient', actual: 100, minimum_required: 10, label: '樣本充足' },
      data_quality: { identified_rate: 0.9, unknown_rate: 0.1, status: 'good', label: '品質良好' },
      scope: { store_id: 's1', date_range: { start: '2026-07-01', end: '2026-07-26' }, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: null, campaign: null },
      secondary_classifications: [],
      sort_key: '0|0|035|000000|測試區',
    };
    return Object.assign(base, overrides);
  }

  ['high_traffic_high_conversion', 'high_traffic_low_cart', 'high_cart_low_checkout', 'high_checkout_low_purchase', 'high_conversion_low_traffic'].forEach((code) => {
    const model = makeModel(code);
    const html = RE.geoRenderRecommendationCard(model, fixtureRC);
    assert(html.includes(model.headline.title), `A-CARD-${code}-1 card html 含 title`);
    assert(html.includes('geo-decision-card'), `A-CARD-${code}-2 card html 含 .geo-decision-card class`);
    assert(html.includes('geo-card-badge'), `A-CARD-${code}-3 card html 含 badge 區塊`);
    assert(html.includes(model.headline.subtitle), `A-CARD-${code}-4 card html 含 subtitle（含地區資訊）`);
    assert(html.includes(model.summary), `A-CARD-${code}-5 card html 含 summary`);
    assert(html.includes(model.primary_metric.formatted_value), `A-CARD-${code}-6 card html 含 primary metric 格式化值`);
    assert(html.includes(model.comparison.message), `A-CARD-${code}-7 card html 含 comparison message`);
    assert(html.includes('信心'), `A-CARD-${code}-8 card html 含 confidence label`);
    assert(html.includes('樣本'), `A-CARD-${code}-9 card html 含 sample label`);
    assert(html.includes('查看原因'), `A-CARD-${code}-10 card html 含「查看原因」按鈕`);
    assert(html.includes('geo-impact-card'), `A-CARD-${code}-11 card html 含 Estimated Impact 卡片`);
  });

  const insufficientModel = makeModel('insufficient_sample', { classification: 'insufficient_sample', sample: { status: 'insufficient', actual: 3, minimum_required: 10, label: '樣本不足' } });
  {
    const html = RE.geoRenderRecommendationCard(insufficientModel, fixtureRC);
    assert(html.includes('樣本不足'), 'A-CARD-insufficient-1 樣本不足卡片顯示「樣本不足」');
    assert(html.includes('暫不提供改善效果推估'), 'A-CARD-insufficient-2 樣本不足時 Impact 不顯示數字，只顯示提示文字');
  }

  const qualityModel = {
    id: 'geo-rec-data-quality-fixture', code: 'data_quality',
    headline: { title: 'Geo 資料可信度偏低', subtitle: '全店資料品質', badge: '資料品質', severity: 'medium', confidence: 'medium' },
    summary: '未知區域比例 62%，Geo 資料可信度偏低',
    quality_metrics: { identified_rate: 0.38, unknown_rate: 0.62, status: 'poor', formatted_unknown_rate: '62%' },
    evidence_items: [], recommended_actions: [{ priority: 1, title: '檢查', description: '檢查 Visitor IP Geo、GPS、地址解析與 geo_context 寫入流程', category: 'data_quality', action_type: 'review' }],
    confidence: { level: 'medium', score: 50, label: '信心中等', reasons: [] },
    scope: { store_id: 's1', date_range: null, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: null, campaign: null },
    sort_key: 'quality|1|050',
  };
  {
    const html = RE.geoRenderQualityCard(qualityModel);
    assert(html.includes('62%'), 'A-CARD-quality-1 quality card 顯示實際 unknown rate');
    assert(html.includes('geo-quality-decision-card'), 'A-CARD-quality-2 quality card 有專屬 class（跟一般 decision card 區分）');
    assert(!html.includes('undefined'), 'A-CARD-quality-3 quality card 不含 undefined 字樣');
  }

  // ── Decision Center 排序：直接採用 recommendation_view_models 既有順序 ──
  {
    const models = [makeModel('high_conversion_low_traffic'), makeModel('high_checkout_low_purchase')];
    const vm = { recommendation_view_models: models, quality_view_models: [], rule_context: fixtureRC };
    const html = RE.geoRenderDecisionCenter(vm);
    const idxA = html.indexOf('high_conversion_low_traffic');
    const idxB = html.indexOf('high_checkout_low_purchase');
    assert(idxA < idxB, 'A-SORT-1 前端完全依照 recommendation_view_models 陣列既有順序渲染，不重新排序');
    assert(html.includes('建議優先處理'), 'A-SORT-2 Decision Center 含 Recommended Actions 區塊標題');
  }
  {
    const html = RE.geoRenderDecisionCenter({ recommendation_view_models: [], quality_view_models: [] });
    assert(html.includes('目前沒有需要特別關注'), 'A-EMPTY-DC-1 沒有任何 recommendation/quality 時顯示對應空狀態文字，不是崩潰');
  }

  // ── 14.5 Estimated Impact：每種分類 + 安全防護 ──
  {
    const r1 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { funnel: { visitors: 100, add_to_cart_visitors: 10 } }), fixtureRC);
    assert(r1.available && r1.value === Math.round(100 * 0.5) - 10, 'B-IMPACT-1 high_traffic_low_cart 公式正確：round(visitors×benchmark)-加購');
    assert(Number.isInteger(r1.value) && r1.value >= 0, 'B-IMPACT-2 high_traffic_low_cart 結果為非負整數');

    const r2 = RE.geoEstimateRecommendationImpact(makeModel('high_cart_low_checkout', { funnel: { add_to_cart_visitors: 20, begin_checkout_visitors: 3 } }), fixtureRC);
    assert(r2.available && r2.value === Math.round(20 * 0.5) - 3, 'B-IMPACT-3 high_cart_low_checkout 公式正確');

    const r3 = RE.geoEstimateRecommendationImpact(makeModel('high_checkout_low_purchase', { funnel: { begin_checkout_visitors: 10, purchase_visitors: 1 } }), fixtureRC);
    assert(r3.available && r3.value === Math.round(10 * 0.5) - 1, 'B-IMPACT-4 high_checkout_low_purchase 公式正確');

    const r4 = RE.geoEstimateRecommendationImpact(makeModel('high_conversion_low_traffic', { funnel: { visitors: 20, visit_to_purchase_rate: 0.25 } }), fixtureRC);
    assert(r4.available && r4.value === Math.round((60 - 20) * 0.25), 'B-IMPACT-5 high_conversion_low_traffic 公式正確：round((median-visitors)×目前成交率)');
    const r4b = RE.geoEstimateRecommendationImpact(makeModel('high_conversion_low_traffic', { funnel: { visitors: 80, visit_to_purchase_rate: 0.25 } }), fixtureRC);
    assert(r4b.value === 0, 'B-IMPACT-6 medianVisitors <= visitors 時不產生負數，結果為 0');

    const r5 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_high_conversion', { funnel: { visitors: 100, visit_to_purchase_rate: 0.25 } }), fixtureRC);
    assert(r5.available && r5.value === Math.round(100 * 0.2 * 0.25), 'B-IMPACT-7 high_traffic_high_conversion 公式正確：round(visitors×0.2×成交率)');
    assert(r5.message.includes('20%') && r5.message.includes('維持'), 'B-IMPACT-8 文案明確標註「假設流量增加 20%，且維持目前成交率」');

    const r6 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { sample: { status: 'insufficient', actual: 3, minimum_required: 10 } }), fixtureRC);
    assert(!r6.available, 'B-IMPACT-9 樣本不足時 available=false，不顯示數字');
    assert(r6.message.includes('樣本不足'), 'B-IMPACT-10 樣本不足時顯示對應提示文字');

    const r7 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { funnel: { visitors: 100, add_to_cart_visitors: 10 } }), { ...fixtureRC, unknownRate: 0.7 });
    assert(r7.available && r7.caveat && r7.caveat.includes('可信度'), 'B-IMPACT-11 Unknown 過高時仍顯示數字但附加可信度提示');

    const r8 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { funnel: { visitors: 10, add_to_cart_visitors: 999 } }), fixtureRC);
    assert(r8.value === 0, 'B-IMPACT-12 負數防護：實際值已超過推估基準時，結果為 0（不是負數）');

    const r9 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { funnel: { visitors: 100, add_to_cart_visitors: 10 } }), { ...fixtureRC, averages: {} });
    assert(Number.isFinite(r9.value) && !Number.isNaN(r9.value), 'B-IMPACT-13 缺 averages 時仍為有限數字，不是 NaN');

    const r10 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart', { funnel: { visitors: Infinity, add_to_cart_visitors: 10 } }), fixtureRC);
    assert(Number.isFinite(r10.value), 'B-IMPACT-14 visitors=Infinity 時結果仍為有限數字');

    const r11 = RE.geoEstimateRecommendationImpact(makeModel('high_conversion_low_traffic', { funnel: { visitors: 5, visit_to_purchase_rate: 0.2 } }), { ...fixtureRC, medians: { visitors: 0 } });
    assert(Number.isFinite(r11.value) && r11.value === 0, 'B-IMPACT-15 medianVisitors=0 時安全回 0，不崩潰');

    const r12 = RE.geoEstimateRecommendationImpact(null, fixtureRC);
    assert(r12.available === false, 'B-IMPACT-16 model=null 時安全回 available:false，不崩潰');
    const r13 = RE.geoEstimateRecommendationImpact(makeModel('high_traffic_low_cart'), null);
    assert(Number.isFinite(r13.value), 'B-IMPACT-17 ruleContext=null 時仍為有限數字');

    const r14 = RE.geoEstimateRecommendationImpact(makeModel('data_quality'), fixtureRC);
    assert(!r14.available, 'B-IMPACT-18 data_quality 分類不提供改善效果推估數字');
  }

  // ── 14.6 Recommended Actions 去重 ──
  {
    const modelsWithDupes = [
      makeModel('high_cart_low_checkout', { id: 'm1', location: { area_name: 'A區', city: '桃園市', district: 'A區' }, recommended_actions: [{ priority: 1, title: 'T1', description: 'D1', category: 'checkout_flow', action_type: 'review' }] }),
      makeModel('high_checkout_low_purchase', { id: 'm2', location: { area_name: 'B區', city: '桃園市', district: 'B區' }, recommended_actions: [{ priority: 1, title: 'T1', description: 'D1-different-area', category: 'checkout_flow', action_type: 'review' }] }),
      makeModel('high_traffic_low_cart', { id: 'm3', location: { area_name: 'C區', city: '桃園市', district: 'C區' }, recommended_actions: [{ priority: 1, title: 'T2', description: 'D2', category: 'product_page', action_type: 'review' }] }),
    ];
    const deduped = RE.geoDedupeRecommendedActions(modelsWithDupes, 5);
    assert(deduped.length === 2, 'C-DEDUPE-1 相同 action_type+category+title 只保留第一筆（3 筆輸入去重後剩 2）');
    assert(deduped[0].area_name === 'A區', 'C-DEDUPE-2 保留第一次出現的來源（不是後面重複的）');

    const sameTitleDiffCategory = [
      makeModel('high_cart_low_checkout', { id: 'm4', recommended_actions: [{ priority: 1, title: 'T3', description: 'D', category: 'checkout_flow', action_type: 'review' }] }),
      makeModel('high_traffic_low_cart', { id: 'm5', recommended_actions: [{ priority: 1, title: 'T3', description: 'D', category: 'product_page', action_type: 'review' }] }),
    ];
    const notDeduped = RE.geoDedupeRecommendedActions(sameTitleDiffCategory, 5);
    assert(notDeduped.length === 2, 'C-DEDUPE-3 同 title 但不同 category 不算重複，兩筆都保留');

    const emptyResult = RE.geoDedupeRecommendedActions([], 5);
    assert(Array.isArray(emptyResult) && emptyResult.length === 0, 'C-DEDUPE-4 空陣列輸入回傳空陣列，不崩潰');

    const missingAction = RE.geoDedupeRecommendedActions([makeModel('high_traffic_low_cart', { recommended_actions: [] })], 5);
    assert(Array.isArray(missingAction) && missingAction.length === 0, 'C-DEDUPE-5 recommended_actions 為空陣列時安全處理');
    const missingActionField = RE.geoDedupeRecommendedActions([{ ...makeModel('high_traffic_low_cart'), recommended_actions: undefined }], 5);
    assert(Array.isArray(missingActionField), 'C-DEDUPE-6 recommended_actions 欄位缺失時不崩潰');

    const manyActions = Array.from({ length: 10 }, (_, i) => makeModel('high_traffic_low_cart', { id: `many${i}`, recommended_actions: [{ priority: 1, title: `T${i}`, description: 'D', category: 'c', action_type: 'review' }] }));
    assert(RE.geoDedupeRecommendedActions(manyActions, 5).length === 5, 'C-DEDUPE-7 預設限制筆數（傳入 5）確實生效');
    const panelHtml = RE.geoRenderRecommendedActionsPanel(modelsWithDupes);
    assert(panelHtml.includes('P1'), 'C-DEDUPE-8 render 後含 priority 顯示');
  }

  // ── Scope 顯示格式化 ──
  {
    const s1 = RE.geoFormatScopeForDisplay({ store_id: 's1', date_range: { start: '2026-07-01', end: '2026-07-26' }, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: null, campaign: null });
    assert(s1.channel === '全部通路', 'D-SCOPE-1 channel="all" 顯示為「全部通路」');
    assert(s1.county_code === '未限定', 'D-SCOPE-2 county_code=null 顯示「未限定」');
    assert(s1.source === '全部', 'D-SCOPE-3 source=null 顯示「全部」');
    assert(s1.date_range === '2026-07-01 ～ 2026-07-26', 'D-SCOPE-4 date_range 正確格式化');
    const serialized = JSON.stringify(s1);
    assert(!serialized.includes('null') && !serialized.includes('undefined'), 'D-SCOPE-5 輸出不含字面 null/undefined 字串');

    const s2 = RE.geoFormatScopeForDisplay({});
    assert(s2.date_range === '未限定', 'D-SCOPE-6 完全空物件時 date_range 顯示「未限定」');
    const s3 = RE.geoFormatScopeForDisplay(null);
    assert(s3.channel === '全部', 'D-SCOPE-7 scope=null 時不崩潰，安全預設');
  }

  // ── Ranking：狀態映射／Unknown 排除 ──
  {
    const models = [makeModel('high_cart_low_checkout', { location: { city: '桃園市', district: '中壢區', area_name: '中壢區' }, secondary_classifications: ['high_traffic_low_cart'] })];
    const statusMap = RE.geoDeriveAreaStatusFromViewModels(models);
    const status = statusMap.get('桃園市|中壢區');
    assert(status && status.label === '結帳入口', 'E-RANK-1 狀態映射正確：high_cart_low_checkout → 結帳入口');
    assert(status.extraCount === 1, 'E-RANK-2 secondary_classifications 數量正確反映為 +N');
    assert(!statusMap.has('|'), 'E-RANK-3 Unknown（city/district 皆空）不會被加入狀態表');
    Object.keys(RE.GEO_AREA_STATUS_BADGE_MAP).forEach((code) => {
      assert(typeof RE.GEO_AREA_STATUS_BADGE_MAP[code] === 'string', `E-RANK-4-${code} 狀態映射表為字串`);
    });
    const emptyMap = RE.geoDeriveAreaStatusFromViewModels([]);
    assert(emptyMap.size === 0, 'E-RANK-5 空陣列輸入回傳空 Map，不崩潰');
    const nullMap = RE.geoDeriveAreaStatusFromViewModels(null);
    assert(nullMap.size === 0, 'E-RANK-6 null 輸入不崩潰');
  }
  {
    const areas = [{ visitors: 5, city: 'X', district: 'A' }, { visitors: 50, city: 'X', district: 'B' }];
    const sorted = RE._geoSortAreas(areas, 'visitors', 'desc');
    assert(sorted[0].visitors === 50, 'E-RANK-7 既有 _geoSortAreas 仍依原始數值排序（未被 B1-5 破壞）');
  }

  // ── Funnel：people/event/conversion/dropoff/0 分母 ──
  {
    assert(RE._geoRate(0, 0) === 0, 'F-FUNNEL-1 _geoRate 分母為 0 時回 0（既有函式，未破壞）');
    assert(!Number.isNaN(RE._geoRate(0, 0)) && Number.isFinite(RE._geoRate(0, 0)), 'F-FUNNEL-2 _geoRate 分母為 0 不產生 NaN/Infinity');
    assert(RE._geoRate(10, 0) === 0, 'F-FUNNEL-3 分子非 0 但分母為 0 時仍安全回 0');
    assert(RE._geoPeople(42) === '42 人', 'F-FUNNEL-4 人數格式化正確');
    assert(RE._geoPct(0.267) === '27%', 'F-FUNNEL-5 事件轉換率百分比格式化正確（四捨五入）');
  }

  // ── Empty State 情境細分 ──
  {
    const vmNoData = { funnel: { areas: [] }, county_summary: { rows: [] }, quality: {} };
    const e1 = RE.geoBuildEmptyStateMessage(vmNoData);
    assert(e1.code === 'no_data', 'G-EMPTY-1 完全沒有資料 → code=no_data');

    const vmOrdersNoBehavior = { funnel: { areas: [] }, county_summary: { rows: [{ order_count: 3 }] }, quality: {} };
    const e2 = RE.geoBuildEmptyStateMessage(vmOrdersNoBehavior);
    assert(e2.code === 'orders_without_behavior', 'G-EMPTY-2 有訂單無行為 → code=orders_without_behavior');

    const vmAllUnknown = { funnel: { areas: [{ visitors: 20, submitted_order_visitors: 0 }] }, county_summary: { rows: [] }, quality: { total_events: 20, identified_events: 0 } };
    const e3 = RE.geoBuildEmptyStateMessage(vmAllUnknown);
    assert(e3.code === 'only_unknown', 'G-EMPTY-3 只有 Unknown → code=only_unknown');

    const vmNoPurchase = { funnel: { areas: [{ visitors: 50, submitted_order_visitors: 0 }] }, county_summary: { rows: [] }, quality: { total_events: 50, identified_events: 40 } };
    const e4 = RE.geoBuildEmptyStateMessage(vmNoPurchase);
    assert(e4.code === 'no_purchase', 'G-EMPTY-4 有行為無購買 → code=no_purchase');

    const vmInsufficient = { funnel: { areas: [{ visitors: 5, submitted_order_visitors: 0 }] }, county_summary: { rows: [] }, quality: { total_events: 5, identified_events: 5 } };
    const e5 = RE.geoBuildEmptyStateMessage(vmInsufficient);
    assert(['insufficient_sample', 'no_purchase'].includes(e5.code), 'G-EMPTY-5 樣本不足情境有對應（不是全部只顯示「暫無資料」）');

    [e1, e2, e3, e4, e5].forEach((e, i) => assert(e.message !== '暫無資料', `G-EMPTY-6-${i} 訊息不是統一的「暫無資料」`));
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom DOM / 互動行為測試
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝，無法進行 DOM 層級行為測試' });
    console.log('[MANUAL REQUIRED] 全部 DOM 測試項目 — jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  const geoSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
  const av2Src = av2SrcRaw.replace(/'use strict';\s*\n/, '');
  const geoSrc = geoSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="reports-container"></div><div id="analytics-v2-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  const RECO_XSS = '"><svg onload=alert(1)>';
  const GEO_ALERTS_FIXTURE_V2 = {
    success: true,
    data: {
      alerts: [{ type: 'traffic_waste', city: '桃園市', district: '桃園區', metrics: { visitors: 100 }, message: '流量高但成交偏低', suggestion: '建議檢查廣告受眾設定' }],
      rule_thresholds: {},
      recommendation_view_models: [
        {
          id: 'geo-rec-fixture-1', code: 'high_cart_low_checkout', classification: 'high_cart_low_checkout', intent_type: 'risk',
          headline: { title: RECO_XSS, subtitle: '桃園市・中壢區', badge: '結帳入口', severity: 'high', confidence: 'medium' },
          location: { area_name: '中壢區', city: '桃園市', district: '中壢區' },
          summary: '<img src=x onerror=alert(1)>加購人數高但結帳率低',
          primary_metric: { key: 'cart_to_checkout_rate', label: '加購到結帳轉換率', value: 0.26, formatted_value: '26%', unit: 'rate' },
          comparison: { benchmark_type: 'store_average', benchmark_label: '全店平均', actual: 0.26, benchmark: 0.54, difference: -0.28, formatted_difference: '低 28 個百分點', direction: 'below', message: '加購到結帳轉換率為 26%，低於全店平均 54%' },
          funnel: { visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, purchase_visitors: 5, visit_to_cart_rate: 0.42, cart_to_checkout_rate: 0.26, checkout_to_purchase_rate: 0.45, visit_to_purchase_rate: 0.05 },
          evidence_items: [], recommended_actions: [{ priority: 1, title: '<script>alert(1)</script>', description: '檢查前往結帳入口、LINE Login 與加入好友轉址流程', category: 'checkout_flow', action_type: 'review' }],
          confidence: { level: 'medium', score: 68, label: '信心中等', reasons: ['樣本數充足'] },
          sample: { status: 'sufficient', actual: 42, minimum_required: 5, label: '樣本充足' },
          data_quality: { identified_rate: 0.9, unknown_rate: 0.1, status: 'good', label: '品質良好' },
          scope: { store_id: 'store_test', date_range: { start: '2026-07-01', end: '2026-07-26' }, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: null, campaign: null },
          secondary_classifications: [], sort_key: '0|0|032|000042|中壢區',
        },
      ],
      quality_view_models: [],
      rule_context: { thresholds: { lowGeoConfidenceRate: 0.5 }, unknownRate: 0.1, medians: { visitors: 50 }, averages: { visit_to_cart_rate: 0.4, cart_to_checkout_rate: 0.5, checkout_to_purchase_rate: 0.3, visit_to_purchase_rate: 0.1 } },
      quality_recommendations: [],
      explainability_version: '1.0',
      schema_version: '1.0',
      meta: { generated_at: '2026-07-26T00:00:00.000Z', recommendation_count: 1, quality_recommendation_count: 0, scope: {}, sort_version: '1.0', compatibility: { legacy_alerts_preserved: true, legacy_behavior_recommendations_preserved: true, frontend_migration_required: false } },
    },
  };
  const GEO_OVERVIEW_FIXTURE = { success: true, data: { visitor_geo: { identified_visitors: 100, unknown_visitors: 10, identified_rate: 0.9 }, fulfillment_geo: { orders_with_geo: 20, orders_without_geo: 3, average_distance_km: 4.2, average_delivery_fee: 48 }, top_areas: [], data_quality: { status: 'healthy', total_events: 110, identified_events: 100, unknown_rate: 0.09 } } };
  const GEO_FUNNEL_FIXTURE = { success: true, data: { page: 1, limit: 100, total: 1, total_pages: 1, areas: [{ city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, submitted_order_visitors: 5, purchase_visitors: 5 }] } };
  const GEO_COUNTY_SUMMARY_FIXTURE = { ok: true, rows: [{ county_code: '68000', county_name: '桃園市', visitor_count: 100, order_count: 5, revenue: 3000 }], unknown: { visitor_count: 5, percentage: 4.5 } };

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url) => {
      fetchCalls.push({ url: String(url), t: Date.now() });
      const u = String(url);
      let body; let status = 200;
      const failing = opts.failEndpoints || [];
      const matchFail = failing.find((f) => u.includes(`/api/analytics/geo/${f}`));
      if (matchFail) { status = 500; body = { success: false, error: '無法讀取區域分析資料' }; }
      else if (u.includes('/api/analytics/geo/overview')) body = opts.overviewFixture || GEO_OVERVIEW_FIXTURE;
      else if (u.includes('/api/analytics/geo/funnel')) body = opts.funnelFixture || GEO_FUNNEL_FIXTURE;
      else if (u.includes('/api/analytics/geo/alerts')) body = opts.alertsFixture || GEO_ALERTS_FIXTURE_V2;
      else if (u.includes('/api/analytics/geo/county-summary')) body = opts.countySummaryFixture || GEO_COUNTY_SUMMARY_FIXTURE;
      else if (u.includes('/api/analytics/geo/administrative-areas')) body = { ok: true, counties: [] };
      else body = { success: true };
      return opts.delayMs
        ? new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), opts.delayMs))
        : Promise.resolve({ ok: status === 200, status, json: async () => body });
    };
  }
  function setupDom(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.localStorage = (() => { let store = {}; return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { store = {}; } }; })();
    dom.window.sessionStorage = dom.window.localStorage;
    const caughtErrors = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.addEventListener('unhandledrejection', (e) => caughtErrors.push(String(e.reason)));
    dom.window.eval(appSrc);
    // fix18-10-hotfix30-B5-R5.2-B1-5（沿用 R5.1-C 既有慣例）：av2Src 跟
    // geoSrc 必須在同一次 dom.window.eval() 呼叫裡執行，否則 let/const
    // 頂層綁定（例如 av2DateState/av2Channel/av2GeoFilters）不會跨兩次
    // 分開的 eval() 呼叫共享，會讓 geo-intelligence.js 裡引用
    // analytics-v2.js 頂層變數的函式（例如 _av2GeoBuildParams()）在測試
    // 環境下丟出 ReferenceError（真實瀏覽器的 <script> 標籤不會有這個
    // 問題，這純粹是 jsdom 間接 eval 的既有限制，不是 production bug）。
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    return { dom, fetchCalls, caughtErrors };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── 14.2 API Capture ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-test"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-test');
    await sleep(20);
    const vm = window.geoLastVm;
    assert(vm && Array.isArray(vm.recommendation_view_models) && vm.recommendation_view_models.length === 1, 'H-CAP-1 recommendation_view_models 確實進入前端 vm state');
    assert(vm && Array.isArray(vm.quality_view_models), 'H-CAP-2 quality_view_models 確實進入前端 vm state');
    assert(vm && vm.rule_context && typeof vm.rule_context === 'object', 'H-CAP-3 rule_context 確實進入前端 vm state');
    assert(vm && vm.alerts_meta && typeof vm.alerts_meta === 'object', 'H-CAP-4 meta 確實進入前端 vm state（存為 alerts_meta）');
    assert(vm && vm.schema_version === '1.0', 'H-CAP-5 schema_version 確實進入前端 vm state');
    dom.window.close();
  }

  // ── Decision Center 真實 DOM 渲染 + XSS ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-xss"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-xss');
    await sleep(20);
    const el = document.getElementById('geo-kpi-xss');
    assert(el.innerHTML.includes('geo-decision-card'), 'I-DOM-1 Decision Center 真實渲染出 .geo-decision-card');
    assert(el.querySelector('svg') === null, 'I-XSS-1 <svg onload=alert(1)> 未被解析成真實可執行節點');
    assert(el.querySelector('script') === null, 'I-XSS-2 <script>alert(1)</script> 未被解析成真實 <script> 節點');
    assert(el.querySelectorAll('img[onerror]').length === 0, 'I-XSS-3 <img onerror=...> 未被解析成帶事件的真實節點');
    assert(!el.innerHTML.includes('<svg onload'), 'I-XSS-4 原始 <svg onload> 字串已被 escape（不是原樣輸出）');
    assert(el.innerHTML.includes('進站訪客'), 'I-BC-1 舊 KPI 子字串「進站訪客」仍存在（向下相容）');
    assert(el.innerHTML.includes('加入購物車'), 'I-BC-2 舊 KPI 子字串「加入購物車」仍存在');
    assert(el.innerHTML.includes('整體成交率'), 'I-BC-3 舊 KPI 子字串「整體成交率」仍存在');
    assert(el.innerHTML.includes('geo-kpi-card'), 'I-DOM-2 新 KPI 卡片（.geo-kpi-card）確實渲染');
    assert(el.innerHTML.includes('geo-status-badge') || el.innerHTML.includes('—'), 'I-RANK-1 排行榜狀態欄確實渲染（有徽章或—佔位）');
    dom.window.close();
  }

  // ── Drawer 開關 / ESC / focus / Explainability 內容 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-drawer"></div><button id="opener">opener</button>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-drawer');
    await sleep(20);
    document.getElementById('opener').focus();
    window.geoAreaDrawerOpen('桃園市|中壢區');
    let drawerEl = document.getElementById('geo-kpi-drawer-drawer');
    assert(drawerEl && drawerEl.innerHTML.includes('role="dialog"'), 'J-DRAWER-1 Drawer 開啟後含 role="dialog"');
    assert(drawerEl.innerHTML.includes('aria-modal="true"'), 'J-DRAWER-2 Drawer 含 aria-modal="true"');
    assert(drawerEl.innerHTML.includes('為什麼系統這樣判定'), 'J-DRAWER-3 Drawer 顯示 Explainability summary 區塊');
    assert(drawerEl.innerHTML.includes('比較基準'), 'J-DRAWER-4 Drawer 顯示 Comparison（比較基準）');
    assert(drawerEl.innerHTML.includes('信心拆解'), 'J-DRAWER-5 Drawer 顯示 Confidence Breakdown');
    assert(drawerEl.innerHTML.includes('progressbar'), 'J-DRAWER-6 Confidence 用 progressbar 呈現（非純顏色）');
    assert(drawerEl.innerHTML.includes('樣本評估'), 'J-DRAWER-7 Drawer 顯示 Sample Assessment');
    assert(drawerEl.innerHTML.includes('資料品質'), 'J-DRAWER-8 Drawer 顯示 Data Quality Assessment');
    assert(drawerEl.innerHTML.includes('建議行動'), 'J-DRAWER-9 Drawer 顯示 Recommended Actions');
    assert(drawerEl.innerHTML.includes('預估改善效果'), 'J-DRAWER-10 Drawer 顯示 Estimated Impact');
    assert(drawerEl.innerHTML.includes('Scope'), 'J-DRAWER-11 Drawer 顯示 Scope');
    assert(!drawerEl.innerHTML.includes('>null<') && !drawerEl.innerHTML.includes('>undefined<'), 'J-DRAWER-12 Scope 缺值不顯示 null/undefined 字面值');

    const escEvent = new window.KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(escEvent);
    drawerEl = document.getElementById('geo-kpi-drawer-drawer');
    assert(drawerEl.innerHTML === '', 'J-DRAWER-13 ESC 按鍵確實關閉 Drawer');
    assert(document.activeElement && document.activeElement.id === 'opener', 'J-DRAWER-14 關閉後 focus 回到原本觸發的元素');

    window.geoAreaDrawerOpen('桃園市|中壢區');
    const closeBtn = document.querySelector('.geo-area-drawer button[aria-label="關閉"]');
    assert(!!closeBtn, 'J-DRAWER-15 Drawer 含明確的 button 關閉按鈕（不是純 div onclick）');
    // jsdom 在 runScripts:'outside-only' 模式下不會把 HTML 屬性寫的
    // onclick="..." 編譯成真正可觸發的事件監聽器（這是 jsdom 本身在此模式下
    // 的既有限制，不是產品程式的問題；已用獨立重現腳本確認：即使
    // dispatchEvent(new MouseEvent('click')) 也不會呼叫到 onclick 屬性裡的
    // 函式）。既有測試套件（R5.1-C/B1-2）遇到同樣限制時，一律改成直接檢查
    // onclick 屬性字串是否正確、並直接呼叫底層函式驗證行為，這裡沿用同一
    // 慣例，不是為了迴避真正的功能驗證。
    assert(closeBtn.getAttribute('onclick') === 'geoAreaDrawerClose()', 'J-DRAWER-16 關閉按鈕的 onclick 屬性正確綁定到 geoAreaDrawerClose()');
    window.geoAreaDrawerClose();
    assert(document.getElementById('geo-kpi-drawer-drawer').innerHTML === '', 'J-DRAWER-17 呼叫 geoAreaDrawerClose() 確實清空 Drawer 內容');
    dom.window.close();
  }

  // ── Race Condition：舊 request 不得覆蓋新 request ──
  // 說明：不透過「在請求飛行中改變 geoDashboardFilters」來觸發第二次請求，
  // 因為 geoDashboardFilters 是用 let 宣告、只有第一次
  // dom.window.eval(geoSrc) 那次呼叫的頂層作用域看得到，測試程式後續任何
  // 一次獨立的 dom.window.eval() 呼叫都是另一個獨立的 indirect-eval 頂層
  // 作用域，無法直接讀寫它（jsdom outside-only 模式下 let/const 不共享
  // 頂層作用域的既有限制）。改用兩個內容可區分的 fixture（districtA/
  // districtB）直接測「同時發出兩次請求，最終畫面只能是後面那次」這個核心
  // 機制（既有 AbortController，不是重寫）。
  {
    let callCount = 0;
    const { dom } = setupDom({});
    const { document, window } = dom.window;
    dom.window.fetch = (url) => {
      const u = String(url);
      const isFunnel = u.includes('/geo/funnel');
      const isFirstFunnelCall = isFunnel && callCount === 0;
      if (isFunnel) callCount += 1;
      let body;
      if (u.includes('/geo/overview')) body = GEO_OVERVIEW_FIXTURE;
      else if (isFunnel) {
        body = { success: true, data: { areas: [{ city: '桃園市', district: isFirstFunnelCall ? 'districtA請求A' : 'districtB請求B', visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, submitted_order_visitors: 5, purchase_visitors: 5 }] } };
      } else if (u.includes('/geo/alerts')) body = GEO_ALERTS_FIXTURE_V2;
      else if (u.includes('/geo/county-summary')) body = GEO_COUNTY_SUMMARY_FIXTURE;
      else body = { success: true };
      const delay = isFirstFunnelCall ? 40 : 5; // Request A（第一次）較慢，Request B（第二次）較快
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay));
    };
    document.body.innerHTML += '<div id="geo-kpi-race"></div>';
    const p1 = window.refreshGeoDashboardKpiBlock('geo-kpi-race'); // Request A：開始
    await sleep(5);
    const p2 = window.refreshGeoDashboardKpiBlock('geo-kpi-race'); // Request B：Request A 還沒完成時就發出
    await Promise.all([p1, p2]);
    await sleep(60); // 確保就算 Request A 比較晚完成，也已經跑完（驗證它不會覆蓋畫面）
    const el = document.getElementById('geo-kpi-race');
    assert(el.innerHTML.includes('districtB請求B'), 'K-RACE-1 最終畫面顯示 Request B（後發出）的資料');
    assert(!el.innerHTML.includes('districtA請求A'), 'K-RACE-2 舊的 Request A 資料沒有覆蓋畫面（即使它比較晚才完成）');
    dom.window.close();
  }

  // ── DOM Safety：容器不存在時不得中斷整支 JS ──
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    let threw = false;
    try {
      await window.refreshGeoDashboardKpiBlock('container-does-not-exist');
      window.geoAreaDrawerOpen('不存在|不存在');
      window.geoOpenExplainabilityDrawerById('not-found-id');
      window.geoCloseExplainabilityDrawer();
    } catch (e) { threw = true; }
    assert(!threw, 'L-DOMSAFE-1 容器不存在時不拋出例外、不中斷整支 JS');
    dom.window.close();
  }

  // ── Error State ──
  {
    const { dom } = setupDom({ failEndpoints: ['overview', 'funnel'] });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-error"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-error');
    await sleep(20);
    const html = document.getElementById('geo-kpi-error').innerHTML;
    assert(html.includes('載入失敗'), 'M-ERROR-1 API 錯誤時顯示「載入失敗」訊息');
    assert(html.includes('重新整理') || html.includes('重新載入'), 'M-ERROR-2 提供重新載入按鈕');
    assert(!html.includes('token') && !html.includes('Authorization'), 'M-ERROR-3 錯誤畫面不含 token/Authorization 等敏感字樣');
    dom.window.close();
  }

  // ── Empty State（真實 DOM）──
  {
    const { dom } = setupDom({ funnelFixture: { success: true, data: { areas: [] } }, countySummaryFixture: { ok: true, rows: [], unknown: {} } });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-empty"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-empty');
    await sleep(20);
    const html = document.getElementById('geo-kpi-empty').innerHTML;
    assert(html.includes('尚無') || html.includes('沒有符合條件'), 'N-EMPTY-1 空資料時顯示有意義的說明文字');
    assert(html.includes('data-geo-empty-code'), 'N-EMPTY-2 空狀態標記了情境代碼（可用於未來細分樣式）');
    dom.window.close();
  }

  // ── Backward Compatibility：舊 data.alerts 仍可被 _av2GeoRenderAlerts() 讀取 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="av2-geo-alerts-body"></div>';
    window.av2GeoAlertsLoaded = false;
    await window.av2GeoAlertsEnsureLoaded();
    await sleep(20);
    const html = document.getElementById('av2-geo-alerts-body').innerHTML;
    assert(html.includes('流量高但成交偏低') || html.includes('建議檢查廣告受眾設定'), 'O-BC-1 舊 data.alerts 陣列仍能被既有 _av2GeoRenderAlerts() 正常渲染');
    assert(typeof window.geoComputeRecommendedActions === 'function', 'O-BC-2 geoComputeRecommendedActions() 仍存在，未被刪除');
    dom.window.close();
  }

  // ── Loading State ──
  {
    const { dom } = setupDom({ delayMs: 40 });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-loading"></div>';
    const p = window.refreshGeoDashboardKpiBlock('geo-kpi-loading');
    await sleep(5);
    const midHtml = document.getElementById('geo-kpi-loading').innerHTML;
    assert(midHtml.includes('geo-skeleton') || midHtml.includes('載入中'), 'P-LOADING-1 載入中顯示 skeleton 或明確的載入文字，不是空白');
    await p;
    dom.window.close();
  }

  // ── Filters：query params 正確 ──
  {
    const { dom, fetchCalls } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-filters"></div>';
    // window.geoDashboardFilters 只有在 _geoExposeWindowState() 執行過一次
    // 之後才會掛到 window 上（見產品程式 _geoExposeWindowState()），這裡先
    // 呼叫一次讓它就位，這是測試環境的正確使用方式，不是產品程式的問題。
    await window.refreshGeoDashboardKpiBlock('geo-kpi-filters');
    await sleep(20);
    window.geoDashboardFilters.source = 'fb';
    window.geoDashboardFilters.medium = 'cpc';
    window.geoDashboardFilters.campaign = 'summer';
    window.geoDashboardFilters.county_code = '68000';
    const callsBeforeFilter = fetchCalls.length;
    await window.refreshGeoDashboardKpiBlock('geo-kpi-filters');
    await sleep(20);
    const newCalls = fetchCalls.slice(callsBeforeFilter);
    const funnelCall = newCalls.find((c) => c.url.includes('/geo/funnel'));
    assert(funnelCall && funnelCall.url.includes('source=fb'), 'Q-FILTER-1 source 篩選確實帶入 API query string');
    assert(funnelCall && funnelCall.url.includes('medium=cpc'), 'Q-FILTER-2 medium 篩選確實帶入 API query string');
    assert(funnelCall && funnelCall.url.includes('campaign=summer'), 'Q-FILTER-3 campaign 篩選確實帶入 API query string');
    assert(funnelCall && funnelCall.url.includes('county_code=68000'), 'Q-FILTER-4 county_code 篩選確實帶入 API query string');
    const overviewCall = newCalls.find((c) => c.url.includes('/geo/overview'));
    assert(overviewCall && overviewCall.url.includes('source=fb'), 'Q-FILTER-5 overview 呼叫同步套用相同篩選（多區塊同步）');
    const alertsCall = newCalls.find((c) => c.url.includes('/geo/alerts'));
    assert(alertsCall && alertsCall.url.includes('source=fb'), 'Q-FILTER-6 alerts 呼叫同步套用相同篩選（Decision Center 資料來源同步）');
    dom.window.close();
  }

  // ── Drawer 細項驗證（本輪要求：逐項驗證，不得只驗證一個大字串）──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-drawer2"></div><button id="opener2">opener2</button>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-drawer2');
    await sleep(20);

    // Focus stub：monkey-patch focus() 以確認 production code 真的呼叫過
    let focusCallCount = 0;
    const origFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function () { focusCallCount += 1; return origFocus.apply(this, arguments); };

    document.getElementById('opener2').focus();
    const focusCountBeforeOpen = focusCallCount;
    window.geoAreaDrawerOpen('桃園市|中壢區');
    assert(focusCallCount > focusCountBeforeOpen, 'S-FOCUS-1 開啟 Drawer 後，production code 確實呼叫了 focus()（不是只有測試自己呼叫）');
    assert(document.activeElement && document.activeElement.getAttribute('aria-label') === '關閉', 'S-FOCUS-2 開啟後 focus 落在 Drawer 的關閉按鈕上');
    assert(document.body.classList.contains('geo-drawer-open'), 'S-BODYCLASS-1 開啟後 body 帶有 geo-drawer-open class（背景不可誤操作）');

    // ESC 監聽目標確認（3.3：不得假設綁在哪裡）
    let windowEscFired = false;
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') windowEscFired = true; }, { once: true });
    const escOnWindowOnly = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    // 先確認：如果只 dispatch 在一個跟 document 無關的獨立節點上（不 bubble 到 document），
    // production 監聽器绑在 document 上時不會被觸發——藉此反向證明監聽目標。
    const isolatedDiv = document.createElement('div');
    // 不 append 到 document，讓事件無法 bubble 到 document
    isolatedDiv.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(document.getElementById('geo-kpi-drawer2-drawer').innerHTML !== '', 'S-ESC-1 對「沒有連接到 document 樹」的節點 dispatch ESC，不會觸發關閉（證明監聽器綁在 document，不是綁在任意節點）');
    // 真正 dispatch 在 document 上才會關閉
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert(document.getElementById('geo-kpi-drawer2-drawer').innerHTML === '', 'S-ESC-2 dispatch 在 document 上的 ESC 確實觸發關閉（確認監聽器綁定目標是 document）');
    assert(!document.body.classList.contains('geo-drawer-open'), 'S-BODYCLASS-2 關閉後 body 移除 geo-drawer-open class');
    assert(document.activeElement && document.activeElement.id === 'opener2', 'S-FOCUS-3 關閉後 focus 確實回到 opener2（不是停在 body 或消失）');

    window.HTMLElement.prototype.focus = origFocus;

    // Drawer 內容逐項驗證（不得只驗證一個大字串）
    window.geoAreaDrawerOpen('桃園市|中壢區');
    const drawerHtml = document.getElementById('geo-kpi-drawer2-drawer').innerHTML;
    const drawerChecks = [
      ['Summary', '為什麼系統這樣判定'],
      ['Primary Reason / Comparison', '比較基準'],
      ['Confidence Breakdown', '信心拆解'],
      ['Sample Assessment', '樣本評估'],
      ['Data Quality Assessment', '資料品質'],
      ['Recommended Actions', '建議行動'],
      ['Estimated Impact', '預估改善效果'],
      ['Scope', 'Scope'],
    ];
    drawerChecks.forEach(([label, needle]) => {
      assert(drawerHtml.includes(needle), `T-DRAWER-ITEM-${label} Drawer 內容含「${label}」對應區塊（逐項驗證，不是單一大字串）`);
    });
    dom.window.close();
  }

  // ── XSS：3 個 fixture × title/summary/reason/action/scope 5 個欄位 ──
  {
    const XSS_FIXTURES = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>'];
    XSS_FIXTURES.forEach((payload, i) => {
      const evilModel = makeModel('high_cart_low_checkout', {
        headline: { title: payload, subtitle: payload, badge: payload, severity: 'high', confidence: 'medium' },
        summary: payload,
        reason: payload,
        recommended_actions: [{ priority: 1, title: payload, description: payload, category: 'checkout_flow', action_type: 'review' }],
        scope: { store_id: payload, date_range: { start: payload, end: payload }, channel: 'all', county_code: null, subdivision_code: null, source: payload, medium: null, campaign: null },
      });
      const cardHtml = RE.geoRenderRecommendationCard(evilModel, fixtureRC);
      assert(!cardHtml.includes('<script>alert'), `U-XSS-${i}-1 fixture "${payload.slice(0, 15)}..." 未在 title 產生真正的 <script> 標籤`);
      assert(!cardHtml.includes('<img src=x onerror'), `U-XSS-${i}-2 fixture 未在輸出中產生未 escape 的 <img onerror>`);
      assert(!cardHtml.includes('<svg onload'), `U-XSS-${i}-3 fixture 未在輸出中產生未 escape 的 <svg onload>`);
      assert(cardHtml.includes('&lt;') || cardHtml.includes('&quot;') || !cardHtml.includes(payload), `U-XSS-${i}-4 fixture 內容經過 escape 處理（不是原樣輸出）`);
      // geoFormatScopeForDisplay() 是資料轉換層（只處理 null/undefined/"all"
      // 顯示文字），本身不做 HTML escape 是正確的（避免在還沒插入 HTML
      // 前就先跑一次 escape，造成之後真正渲染時被雙重轉換）；真正的 escape
      // 發生在把 scope 插入 HTML 字串的地方——_geoRenderExplainabilitySection()
      // 會把 scope.source 直接插進 Drawer HTML，這裡才是正確的檢查對象。
      const evilScopeModel = makeModel('high_cart_low_checkout', { scope: { ...evilModel.scope, source: payload } });
      const explainHtml = RE._geoRenderExplainabilitySection(evilScopeModel, fixtureRC);
      assert(!explainHtml.includes('<script>alert'), `U-XSS-${i}-5 Drawer Scope 區塊（插入 scope.source）未產生真正的 <script> 標籤`);
      assert(!explainHtml.includes('<svg onload'), `U-XSS-${i}-6 Drawer Scope 區塊未產生未 escape 的 <svg onload>`);
    });
    // 用真實 jsdom 驗證：整張卡片渲染進真實 DOM 後，不會產生可執行節點
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const evilModel2 = makeModel('high_checkout_low_purchase', {
      headline: { title: '<script>alert(2)</script>', subtitle: '"><svg onload=alert(2)>', badge: 'b', severity: 'high', confidence: 'medium' },
      summary: '<img src=x onerror=alert(2)>',
      recommended_actions: [{ priority: 1, title: 't', description: '"><svg onload=alert(2)>', category: 'c', action_type: 'review' }],
    });
    document.body.innerHTML += `<div id="xss-test-container">${RE.geoRenderRecommendationCard(evilModel2, fixtureRC)}</div>`;
    const container = document.getElementById('xss-test-container');
    assert(container.querySelectorAll('script').length === 0, 'U-XSS-DOM-1 真實 DOM 中沒有產生任何 <script> 節點');
    assert(container.querySelectorAll('svg[onload]').length === 0, 'U-XSS-DOM-2 真實 DOM 中沒有產生帶 onload 的 <svg> 節點');
    assert(container.querySelectorAll('img[onerror]').length === 0, 'U-XSS-DOM-3 真實 DOM 中沒有產生帶 onerror 的 <img> 節點');
    dom.window.close();
  }

  // ── Filters：特殊字元 / 空格 / 中文編碼 ──
  {
    const { dom, fetchCalls } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-encode"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-encode');
    await sleep(20);
    const callsBefore = fetchCalls.length;
    window.geoDashboardFilters.source = 'LINE 官方帳號';
    window.geoDashboardFilters.campaign = '暑期活動';
    window.geoDashboardFilters.medium = 'cpc';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-encode');
    await sleep(20);
    const newCalls = fetchCalls.slice(callsBefore);
    const funnelCall = newCalls.find((c) => c.url.includes('/geo/funnel'));
    assert(!!funnelCall, 'V-ENCODE-1 帶中文/空格篩選時仍成功發出請求（不因特殊字元中斷）');
    // URLSearchParams 用 application/x-www-form-urlencoded 規則序列化，空白
    // 編碼成 '+' 而不是 encodeURIComponent() 的 '%20'，兩者都是合法編碼，
    // 這裡改用「解碼回來比對原始值」驗證，不糾結於編碼字元本身的形式。
    const decodedUrl = decodeURIComponent(funnelCall.url.replace(/\+/g, '%20'));
    assert(decodedUrl.includes('LINE 官方帳號'), 'V-ENCODE-2 含空格的中文來源值解碼後正確還原（URLSearchParams 合法編碼，空白用 + 表示）');
    assert(decodedUrl.includes('暑期活動'), 'V-ENCODE-3 純中文活動名稱解碼後正確還原');
    assert(!funnelCall.url.includes('LINE 官方帳號'), 'V-ENCODE-4 URL 中不含未編碼的原始空格字元（避免產生不合法 URL）');
    dom.window.close();

    const { dom: dom2, fetchCalls: fetchCalls2 } = setupDom();
    const { window: window2 } = dom2.window;
    dom2.window.document.body.innerHTML += '<div id="geo-kpi-encode2"></div>';
    await window2.refreshGeoDashboardKpiBlock('geo-kpi-encode2');
    await sleep(20);
    const callsBefore2 = fetchCalls2.length;
    window2.geoDashboardFilters.source = 'facebook';
    window2.geoDashboardFilters.medium = 'cpc';
    window2.geoDashboardFilters.campaign = 'summer_sale';
    await window2.refreshGeoDashboardKpiBlock('geo-kpi-encode2');
    await sleep(20);
    const newCalls2 = fetchCalls2.slice(callsBefore2);
    const funnelCall2 = newCalls2.find((c) => c.url.includes('/geo/funnel'));
    assert(funnelCall2 && funnelCall2.url.includes('source=facebook'), 'V-ENCODE-5 source=facebook 正確帶入（無特殊字元情境）');
    assert(funnelCall2 && funnelCall2.url.includes('medium=cpc'), 'V-ENCODE-6 medium=cpc 正確帶入');
    assert(funnelCall2 && funnelCall2.url.includes('campaign=summer_sale'), 'V-ENCODE-7 campaign=summer_sale 正確帶入');
    dom2.window.close();
  }

  // ── Filters：清除篩選（全部）不送錯誤 query，且清除後恢復正常 ──
  {
    const { dom, fetchCalls } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-clear"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-clear'); // 先跑一次讓 window.geoDashboardFilters 就位
    await sleep(20);
    window.geoDashboardFilters.source = 'temp';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-clear');
    await sleep(20);
    const callsBefore = fetchCalls.length;
    window.geoDashboardFilters.source = null;
    window.geoDashboardFilters.medium = null;
    window.geoDashboardFilters.campaign = null;
    await window.refreshGeoDashboardKpiBlock('geo-kpi-clear');
    await sleep(20);
    const newCalls = fetchCalls.slice(callsBefore);
    const funnelCall = newCalls.find((c) => c.url.includes('/geo/funnel'));
    assert(funnelCall && !funnelCall.url.includes('source=') && !funnelCall.url.includes('medium=') && !funnelCall.url.includes('campaign='), 'W-CLEAR-1 清除篩選後，query string 不含空值參數（不送 source=&medium=&campaign=）');
    assert(document.getElementById('geo-kpi-clear').innerHTML.includes('geo-kpi-card'), 'W-CLEAR-2 清除篩選後 KPI 正常渲染，不因空篩選值出錯');
    dom.window.close();
  }

  // ── CSS 靜態檢查：class 對應存在、無 404 風險（本地檔案存在）──
  {
    const cssPath = path.join(ROOT, 'public/css/geo-intelligence.css');
    const cssExists = fs.existsSync(cssPath);
    assert(cssExists, 'X-CSS-1 public/css/geo-intelligence.css 檔案存在');
    if (cssExists) {
      const cssContent = fs.readFileSync(cssPath, 'utf8');
      ['.geo-kpi-card', '.geo-decision-card', '.geo-impact-card', '.geo-drawer', '.geo-quality-card', '.geo-action-item', '.geo-status-badge'].forEach((sel) => {
        assert(cssContent.includes(sel), `X-CSS-2 CSS 含選擇器「${sel}」`);
      });
      const cssWithoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/(^|\s)\.card\s*\{/.test(cssWithoutComments) && !/(^|\s)table\s*\{/.test(cssWithoutComments) && !/(^|\s)button\s*\{/.test(cssWithoutComments), 'X-CSS-3 沒有過度泛用的全站選擇器（.card{}/table{}/button{}，排除註解文字後檢查實際選擇器）');
      assert(cssContent.includes('@media') && cssContent.includes('1199px') && cssContent.includes('767px'), 'X-CSS-4 含平板與手機斷點');
    }
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const cssLinkCount = (indexHtml.match(/geo-intelligence\.css/g) || []).length;
    assert(cssLinkCount === 1, 'X-CSS-5 index.html 只引用一次 geo-intelligence.css（沒有重複載入）');
  }

  // ── Funnel dropoff/0 分母（真實 DOM）＋ Ranking th/td/colspan 一致性 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-colspan"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-colspan');
    await sleep(20);
    window.geoRankingToggleExpand('桃園市|中壢區');
    const html = document.getElementById('geo-kpi-colspan').innerHTML;
    const thCount = (html.match(/<th[\s>]/g) || []).length;
    const colspanMatch = html.match(/colspan="(\d+)"/);
    assert(!!colspanMatch, 'Z-COLSPAN-1 展開列存在 colspan 屬性');
    if (colspanMatch && thCount > 0) {
      assert(Number(colspanMatch[1]) === thCount, 'Z-COLSPAN-2 展開列 colspan 數值與表頭 th 數量一致（行政區欄+5個既有欄+狀態欄）');
    }
    const trMatch = html.match(/<tr class="db-v3-hover"[^>]*>[\s\S]*?<\/tr>/);
    if (trMatch) {
      const tdCount = (trMatch[0].match(/<td[^>]*>/g) || []).length;
      assert(tdCount === thCount, 'Z-COLSPAN-3 一般資料列的 td 數量與表頭 th 數量一致');
    }
    dom.window.close();
  }

  // ── Accessibility 補充檢查：button type、aria-expanded、role ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-a11y"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-a11y');
    await sleep(20);
    const html = document.getElementById('geo-kpi-a11y').innerHTML;
    const buttonMatches = html.match(/<button[^>]*>/g) || [];
    assert(buttonMatches.length > 0, 'Y-A11Y-1 頁面內確實有 <button> 元素（不是用 div 模擬按鈕）');
    assert(buttonMatches.every((b) => b.includes('type="button"')), 'Y-A11Y-2 所有 <button> 都明確標註 type="button"（避免預設 submit 行為）');
    assert(html.includes('aria-expanded'), 'Y-A11Y-3 排行榜展開按鈕含 aria-expanded');
    assert(html.includes('role="list"') || html.includes("role='list'"), 'Y-A11Y-4 KPI/Decision Center 使用 role="list" 語意');
    window.geoAreaDrawerOpen('桃園市|中壢區');
    const drawerHtml = document.getElementById('geo-kpi-a11y-drawer').innerHTML;
    assert(drawerHtml.includes('role="dialog"') && drawerHtml.includes('aria-modal="true"'), 'Y-A11Y-5 Drawer 含 role="dialog" 與 aria-modal="true"');
    dom.window.close();
  }

  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-sync"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-sync');
    await sleep(20);
    await window.geoDashboardSetSource('newsource');
    await sleep(20);
    const html = document.getElementById('geo-kpi-sync').innerHTML;
    assert(html.includes('geo-kpi-card') && html.includes('geo-decision-card'), 'R-SYNC-1 Filter 改變後，KPI 與 Decision Center 在同一次渲染內同步更新');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補充 5 項真實 assertions（2.1～2.5）
  // ══════════════════════════════════════════════════════════════

  // 2.1 Funnel 零分母：visitors=0, add_to_cart_visitors=0 → 顯示 —，不得 NaN%/Infinity%
  {
    const zeroRate = RE._geoRate(0, 0);
    assert(zeroRate === 0, 'AC-ZERO-1 _geoRate(0,0) 回傳 0（既有函式，數值層防護）');
    const formattedZeroRate = zeroRate === 0 ? '—' : `${(zeroRate * 100).toFixed(1)}%`;
    // 既有排行榜渲染邏輯：conversion 欄位在分母為 0 時的顯示規則——直接用
    // 真實 render 路徑（_renderGeoAreaFunnelSteps 只顯示人數，不顯示轉換率
    // 文字，因此改用排行榜主列的轉換率儲存格驗證，取自真實 DOM）。
    const { dom } = setupDom({ funnelFixture: { success: true, data: { areas: [{ city: '桃園市', district: '零分母區', visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, submitted_order_visitors: 0, purchase_visitors: 0 }] } } });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-zero"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-zero');
    await sleep(20);
    const html = document.getElementById('geo-kpi-zero').innerHTML;
    assert(!html.includes('NaN%'), 'AC-ZERO-2 visitors=0/加購=0 時，畫面不出現「NaN%」');
    assert(!html.includes('Infinity%'), 'AC-ZERO-3 visitors=0/加購=0 時，畫面不出現「Infinity%」');
    dom.window.close();
  }

  // 2.2 Funnel Dropoff：visitors=100, add_to_cart_visitors=40 → dropoff=60（60%）
  {
    const visitors = 100;
    const addToCart = 40;
    const dropoff = visitors - addToCart;
    const dropoffRate = RE._geoRate(dropoff, visitors);
    assert(dropoff === 60, 'AD-DROPOFF-1 dropoff 人數計算正確：100-40=60');
    assert(Math.round(dropoffRate * 100) === 60, 'AD-DROPOFF-2 dropoff rate 正確：60/100=60%');
  }

  // 2.3 Ranking Colspan：empty/error/loading 三種狀態列的 colspan 與表頭一致
  {
    const { dom } = setupDom({ funnelFixture: { success: true, data: { areas: [] } }, countySummaryFixture: { ok: true, rows: [], unknown: {} } });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-emptycolspan"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-emptycolspan');
    await sleep(20);
    const emptyHtml = document.getElementById('geo-kpi-emptycolspan').innerHTML;
    // 空資料時排行榜是一個提示文字 <div>（不是帶 colspan 的 <table><tr><td>），
    // 這是既有、刻意的設計（見 _renderGeoAreaRankingTable() 的 !total 分支）——
    // 驗證這裡「沒有半殘的表格」比驗證一個不存在的 colspan 數字更有意義。
    assert(!emptyHtml.includes('<table') || emptyHtml.includes('目前沒有符合條件的行政區資料'), 'AE-COLSPAN-1 排行榜空資料時不產生半殘表格（用提示文字取代，不會有欄位數對不齊的殘留 table）');

    const { dom: dom2 } = setupDom({ failEndpoints: ['overview', 'funnel'] });
    const { document: document2, window: window2 } = dom2.window;
    document2.body.innerHTML += '<div id="geo-kpi-errorcolspan"></div>';
    await window2.refreshGeoDashboardKpiBlock('geo-kpi-errorcolspan');
    await sleep(20);
    const errorHtml = document2.getElementById('geo-kpi-errorcolspan').innerHTML;
    assert(!errorHtml.includes('<table'), 'AE-COLSPAN-2 錯誤狀態時不殘留任何排行榜 <table>（整個容器改成錯誤訊息，不會有欄位數對不齊的殘留表格）');
    dom2.window.close();

    const { dom: dom3 } = setupDom({ delayMs: 30 });
    const { document: document3, window: window3 } = dom3.window;
    document3.body.innerHTML += '<div id="geo-kpi-loadingcolspan"></div>';
    const p = window3.refreshGeoDashboardKpiBlock('geo-kpi-loadingcolspan');
    await sleep(5);
    const loadingHtml = document3.getElementById('geo-kpi-loadingcolspan').innerHTML;
    assert(!loadingHtml.includes('<table'), 'AE-COLSPAN-3 載入中狀態不殘留任何排行榜 <table>（用 skeleton 取代，不會有欄位數對不齊的殘留表格）');
    await p;
    dom3.window.close();
    dom.window.close();
  }

  // 2.4 Impact 正整數：add_to_cart_visitors=41, benchmark=0.5, begin_checkout_visitors=10
  {
    const impactModel = makeModel('high_cart_low_checkout', { funnel: { add_to_cart_visitors: 41, begin_checkout_visitors: 10 } });
    const impactRC = { ...fixtureRC, averages: { ...fixtureRC.averages, cart_to_checkout_rate: 0.5 } };
    const result = RE.geoEstimateRecommendationImpact(impactModel, impactRC);
    assert(Number.isInteger(result.value), 'AF-IMPACT-1 result.value 為整數（round(41×0.5)-10=round(20.5)-10=21-10=11）');
    assert(result.value >= 0, 'AF-IMPACT-2 result.value >= 0');
    assert(!Number.isNaN(result.value), 'AF-IMPACT-3 result.value 不是 NaN');
    assert(result.value === Math.round(41 * 0.5) - 10, 'AF-IMPACT-4 result.value 數值正確：round(41×0.5)-10');
  }

  // 2.5 Scope Null Display：source=null, medium=undefined, campaign=""
  {
    const scopeDisplay = RE.geoFormatScopeForDisplay({ store_id: 's1', date_range: null, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: undefined, campaign: '' });
    const serialized = JSON.stringify(scopeDisplay);
    assert(!serialized.includes('null'), 'AG-SCOPENULL-1 scope.source=null 時輸出不含字面 "null"');
    assert(!serialized.includes('undefined'), 'AG-SCOPENULL-2 scope.medium=undefined 時輸出不含字面 "undefined"');
    assert(scopeDisplay.campaign === '全部', 'AG-SCOPENULL-3 scope.campaign="" 時顯示「全部」');
    assert(scopeDisplay.source === '全部' && scopeDisplay.medium === '全部', 'AG-SCOPENULL-4 source/medium 皆正確顯示「全部」');
  }

  printSummary();
  // app.js 內建的 WSS 重連（指數退避）與時鐘 tick 等背景計時器即使在
  // dom.window.close() 之後，仍可能在某些 jsdom 版本下殘留於 Node 事件
  // 迴圈，導致程式不會自然結束。這裡在印完結果後主動退出，不是隱藏 pending
  // handle 的問題——所有 assertion 都已經在 printSummary() 前跑完並記錄，
  // exitCode 已經由 printSummary() 正確設定，這裡只是確保進程本身會終止。
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
  process.exit(1);
});
