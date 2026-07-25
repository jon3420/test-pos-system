// public/js/geo-intelligence.js — fix18-10-hotfix30-B5-R5.1-C
// Geo Intelligence Center — Dashboard UI × Geo Analytics × Business Opportunity
//
// 本輪範圍限制（依需求文件）：只做 UI/UX/Visualization/Business Insight，
// 完全不修改 Analytics Schema / analytics_events / orders / Geo Query /
// Geo API / Visitor Attribution / Fulfillment Logic / Distance Logic——
// 本檔案只呼叫 R5.1-B 已完成的 API（GET /api/analytics/dashboard 的
// geo_summary、GET /api/analytics/geo/*），所有「商機建議」「廣告 ROI」
// 「優惠券建議」「外送費最佳化」「開店建議」「今日洞察」都是純規則式計算
// （見下方 Business Rule Engine 區塊），不是 AI，不呼叫任何外部模型。
//
// 載入順序：public/index.html 在 app.js、analytics-v2.js 之後載入本檔案，
// 因此可直接使用 app.js 的 apiFetch()/escHtml()/_section()/_card()/
// showToast()/_nt()，以及 analytics-v2.js 的 av2DateState/av2Channel
// （沿用同一組日期/渠道篩選，不創造第二套邏輯）。

'use strict';

// ════════════════════════════════════════════════════════════════
// Business Rule Engine — 全部是透明規則，不是 AI，不叫外部模型。
// 每個函式都是純函式（輸入 → 輸出，無副作用），方便獨立測試。
// ════════════════════════════════════════════════════════════════

// 十八、Today's Insight 與 三、Business Opportunity 共用的信心度標示規則：
// 樣本數決定信心度，不是隨意標示。
function geoConfidenceFromSample(n) {
  if (n >= 30) return 'high';
  if (n >= 10) return 'medium';
  return 'low';
}

// 三、⭐ Geo 商機建議：完全依賴 geo_summary（top_intent_areas /
// high_traffic_low_conversion / fulfillment_summary），不额外呼叫任何 API。
function geoComputeOpportunities(summary) {
  const out = [];
  if (!summary) return out;
  const top = (summary.top_intent_areas || [])[0];
  if (top) {
    out.push({
      area: top.district || top.city || '未知區域',
      icon: '✔',
      headline: `${top.district || top.city} 成交率最高`,
      suggestion: '建議提高廣告預算',
      confidence: geoConfidenceFromSample(top.visitors),
      basis: `visitors=${top.visitors}, submitted_order_visitors=${top.submitted_order_visitors}`,
    });
  }
  (summary.high_traffic_low_conversion || []).slice(0, 3).forEach((a) => {
    out.push({
      area: a.district || a.city || '未知區域',
      icon: '✔',
      headline: `${a.district || a.city} 高流量、低成交`,
      suggestion: '建議檢查價格或外送費',
      confidence: geoConfidenceFromSample(a.visitors),
      basis: `visitors=${a.visitors}, add_to_cart_visitors=${a.add_to_cart_visitors}`,
    });
  });
  const fs = summary.fulfillment_summary || {};
  if (fs.takeout_no_fulfillment_address > 0 && fs.orders_with_geo > 0 && fs.takeout_no_fulfillment_address > fs.orders_with_geo) {
    out.push({
      area: null,
      icon: '✔',
      headline: '外帶訂單比例偏高',
      suggestion: '建議評估是否有外送需求尚未滿足',
      confidence: 'medium',
      basis: `takeout=${fs.takeout_no_fulfillment_address}, orders_with_geo=${fs.orders_with_geo}`,
    });
  }
  return out;
}

// 四、⭐ 廣告 ROI 建議：依 source × area 的加購/成交率排序給星等（1~5 顆星）。
// 完全不叫 Meta/Google Ads API，全部由本輪已有的 /api/analytics/geo/source-area
// 資料推算。
function geoComputeAdRoi(sourceAreaRows) {
  if (!Array.isArray(sourceAreaRows)) return [];
  return sourceAreaRows
    .filter((r) => r.visitors >= 5) // 樣本太小不給評等，避免誤導
    .map((r) => {
      const convRate = r.conversion_rate || 0;
      const cartRate = r.visitors > 0 ? (r.add_to_cart || 0) / r.visitors : 0;
      // 星等 = 轉換率與加購率的加權組合，映射到 1~5（透明規則，非黑盒）
      const score = convRate * 0.7 + cartRate * 0.3;
      const stars = Math.max(1, Math.min(5, Math.round(score * 10) || 1));
      let headline;
      if (convRate >= 0.05) headline = '成交率最高';
      else if (cartRate >= 0.2) headline = '加入購物車很多';
      else headline = '表現一般';
      return {
        source: r.source, campaign: r.campaign, city: r.city, district: r.district,
        headline, stars, conversion_rate: convRate,
      };
    })
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 10);
}

// 五、⭐ 區域優惠建議：加購多、成交少 → 建議發券；成交本來就很好 → 建議不用發券
// （避免浪費毛利）。本輪只做建議文字，不會真的呼叫優惠券系統建立優惠券。
function geoComputeCouponSuggestions(funnelAreas) {
  if (!Array.isArray(funnelAreas)) return [];
  return funnelAreas
    .filter((a) => a.visitors >= 10)
    .map((a) => {
      const cartRate = a.visit_to_cart_rate || 0;
      const orderRate = a.visit_to_order_rate || 0;
      if (cartRate >= 0.15 && orderRate < 0.03) {
        return {
          area: a.district || a.city, action: 'suggest_coupon',
          headline: '加入購物車很多、成交較少', suggestion: '建議發送 95 折優惠券（限定此區域、今日限定）',
          confidence: geoConfidenceFromSample(a.visitors),
        };
      }
      if (orderRate >= 0.05) {
        return {
          area: a.district || a.city, action: 'skip_coupon',
          headline: '成交表現已經很好', suggestion: '建議不用發券，避免浪費毛利',
          confidence: geoConfidenceFromSample(a.visitors),
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 6);
}

// 六、⭐ 外送費最佳化：距離帶的轉換率明顯偏低 + 平均外送費不低 → 建議提高門檻/費率；
// 距離短、訂單多、轉換率高 → 建議維持現行費率。
function geoComputeDeliveryFeeOptimization(distanceBands) {
  if (!Array.isArray(distanceBands)) return [];
  return distanceBands
    .filter((b) => b.band !== 'unknown' && b.submitted_orders > 0)
    .map((b) => {
      if (b.conversion_rate < 0.5 && b.average_delivery_fee > 0) {
        return {
          band: b.band, action: 'raise_fee',
          headline: `${b.band} 轉換率偏低`, suggestion: `建議提高 ${b.band} 距離帶的外送費或免運門檻`,
          confidence: geoConfidenceFromSample(b.submitted_orders),
        };
      }
      if (b.conversion_rate >= 0.8 && b.submitted_orders >= 5) {
        return {
          band: b.band, action: 'maintain',
          headline: `${b.band} 訂單多、轉換率高`, suggestion: '建議維持目前費率',
          confidence: geoConfidenceFromSample(b.submitted_orders),
        };
      }
      return null;
    })
    .filter(Boolean);
}

// 八、⭐ 開店建議：綜合 visitors / submitted_orders / revenue 產生熱門區域排行，
// 星等 1~5（透明規則：visitors 佔 40%、submitted_orders 佔 40%、revenue 佔 20%，
// 正規化後加權，不是黑盒模型）。
function geoComputeExpansionRanking(funnelAreas, fulfillmentAreas) {
  if (!Array.isArray(funnelAreas)) return [];
  const revenueMap = new Map((fulfillmentAreas || []).map((f) => [`${f.city || ''}|${f.district || ''}`, f.revenue || 0]));
  const rows = funnelAreas.map((a) => {
    const key = `${a.city || ''}|${a.district || ''}`;
    return { area: a.district || a.city, visitors: a.visitors, orders: a.submitted_order_visitors, revenue: revenueMap.get(key) || 0 };
  });
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const maxO = Math.max(1, ...rows.map((r) => r.orders));
  const maxR = Math.max(1, ...rows.map((r) => r.revenue));
  return rows
    .map((r) => {
      const score = (r.visitors / maxV) * 0.4 + (r.orders / maxO) * 0.4 + (r.revenue / maxR) * 0.2;
      const stars = Math.max(1, Math.min(5, Math.round(score * 5)));
      return { ...r, stars };
    })
    .sort((a, b) => b.stars - a.stars || b.revenue - a.revenue)
    .slice(0, 5);
}

// 十八、Today's Insight：純規則，比較今天前段資料與 geo_summary 既有欄位，
// 不做額外的「昨天 vs 今天」API 呼叫（本輪不新增 Geo Query），只依現有摘要
// 資料產生描述句。
function geoComputeTodayInsight(summary) {
  const insights = [];
  if (!summary) return insights;
  const top = (summary.top_intent_areas || [])[0];
  if (top) insights.push({ icon: '📈', text: `${top.district || top.city} 目前是高意願區域第一名` });
  const waste = (summary.high_traffic_low_conversion || [])[0];
  if (waste) insights.push({ icon: '⚠️', text: `${waste.district || waste.city} 流量高但成交偏低，值得關注` });
  const fs = summary.fulfillment_summary || {};
  if (fs.takeout_no_fulfillment_address > 0) insights.push({ icon: '🚶', text: `今天有 ${fs.takeout_no_fulfillment_address} 筆外帶訂單（無履約地址）` });
  return insights;
}

// 二十二 / 十、Geo Alerts 嚴重度分類（後端只有 warning/info 兩級，這裡依
// alert.type 與 metrics 細分成 critical/high/medium/low 四級，供老闆
// Alerts Center 排序使用——同樣是透明規則，不是 AI）。
function geoClassifyAlertSeverity(alert) {
  if (!alert) return 'low';
  if (alert.type === 'data_quality' && alert.metrics && alert.metrics.status === 'degraded') return 'high';
  if (alert.type === 'traffic_waste' && alert.metrics && alert.metrics.visitors >= 50) return 'critical';
  if (alert.type === 'traffic_waste') return 'high';
  if (alert.type === 'checkout_drop') return 'high';
  if (alert.type === 'delivery_cost_risk') return 'medium';
  if (alert.type === 'out_of_range_demand') return 'medium';
  return 'low';
}
const GEO_SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const GEO_SEVERITY_LABEL = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🔵 Low' };

// Stage 2：⭐ Recommended Actions —— 統一結構、固定規則 ID、可重複計算、
// 不依賴隨機數、不使用 AI 字樣、不宣稱絕對因果。只顯示建議，不會、也不能
// 自動執行任何動作（本函式只回傳純資料物件，沒有任何 side effect）。
// 信心只允許 high/medium/low；文案只用「可能／趨勢顯示／建議檢查／值得評估」，
// 禁止「一定／證明／就是因為／保證有效／必然成交」。
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
function geoComputeRecommendedActions({ summary, funnelAreas, fulfillmentAreas, distanceBands, sourceAreaRows, quality } = {}) {
  const actions = [];

  // data_quality（全域，不綁區域）——資料品質異常時最優先讓老闆知道要謹慎解讀其他建議
  if (quality && (quality.status === 'degraded' || quality.status === 'insufficient_data')) {
    actions.push({
      id: 'data_quality:global',
      type: 'data_quality',
      title: quality.status === 'degraded' ? 'Geo 資料可信度偏低' : 'Geo 資料樣本不足',
      recommendation: '建議檢查 Visitor IP Geo 或地址解析是否正常運作',
      reason: quality.status === 'degraded' ? '未知區域比例偏高，趨勢顯示資料品質可能下降' : '目前樣本數不足，暫不宜依此下營運判斷',
      confidence: 'medium',
      area: null,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  }

  // coupon：加購多、成交少（沿用 geoComputeCouponSuggestions 的判斷邏輯，同一份規則不重寫兩次）
  geoComputeCouponSuggestions(funnelAreas).filter((s) => s.action === 'suggest_coupon').forEach((s) => {
    actions.push({
      id: `coupon:${s.area}`,
      type: 'coupon',
      title: `${s.area}加購多、成交少`,
      recommendation: `建議建立 ${s.area} 限定優惠券`,
      reason: '購物車率高於門檻，但送單率偏低，值得評估用優惠券促進轉換',
      confidence: s.confidence === 'low' ? 'medium' : s.confidence, // coupon 建議至少 medium，避免樣本邊界時被排到最後
      area: s.area,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  });

  // delivery_fee：距離帶轉換率偏低（沿用 geoComputeDeliveryFeeOptimization）
  geoComputeDeliveryFeeOptimization(distanceBands).filter((o) => o.action === 'raise_fee').forEach((o) => {
    actions.push({
      id: `delivery_fee:${o.band}`,
      type: 'delivery_fee',
      title: `${o.band} 轉換率可能偏低`,
      recommendation: `建議檢查 ${o.band} 外送費設定`,
      reason: '此距離帶轉換率低於其他距離帶，趨勢顯示外送費可能是影響因素之一',
      confidence: 'medium',
      area: null,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  });

  // advertising：成交率最高的 source×area（沿用 geoComputeAdRoi）
  const roiTop = geoComputeAdRoi(sourceAreaRows).find((r) => r.headline === '成交率最高');
  if (roiTop) {
    const area = roiTop.district || roiTop.city;
    actions.push({
      id: `advertising:${roiTop.source}:${area}`,
      type: 'advertising',
      title: `${area}成交率較高`,
      recommendation: `建議評估優先增加 ${area} 的廣告預算`,
      reason: `${roiTop.source} 來源在此區域的轉換率高於其他組合，值得評估投放比重`,
      confidence: roiTop.stars >= 4 ? 'high' : 'medium',
      area,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  }

  // pricing / conversion：高流量低轉換（沿用 summary.high_traffic_low_conversion，不重新計算）
  const waste = summary && (summary.high_traffic_low_conversion || [])[0];
  if (waste) {
    const area = waste.district || waste.city;
    actions.push({
      id: `pricing:${area}`,
      type: 'pricing',
      title: `${area}流量高、成交偏低`,
      recommendation: `建議檢查 ${area} 的價格或外送費是否偏高`,
      reason: '此區域進站人數不低，但送出訂單的比例偏低，值得評估定價策略',
      confidence: 'medium',
      area,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  }
  // conversion：開始結帳但送單率偏低（用 funnelAreas 自己算，跟 pricing 用不同資料切入角度，避免重複同一條規則）
  (funnelAreas || []).forEach((a) => {
    if (a.begin_checkout_visitors >= 10 && a.checkout_to_order_rate < 0.5) {
      const area = a.district || a.city;
      actions.push({
        id: `conversion:${area}`,
        type: 'conversion',
        title: `${area}開始結帳後流失偏高`,
        recommendation: `建議檢查 ${area} 結帳流程是否有阻礙（付款方式、外送費顯示等）`,
        reason: '開始結帳的人數中，實際送出訂單的比例偏低',
        confidence: 'medium',
        area,
        status: 'pending',
        source: 'geo-rule-engine',
      });
    }
  });

  // pickup_point：開店建議星等最高的區域（沿用 geoComputeExpansionRanking）
  const topExpansion = geoComputeExpansionRanking(funnelAreas, fulfillmentAreas)[0];
  if (topExpansion && topExpansion.stars >= 4) {
    actions.push({
      id: `pickup_point:${topExpansion.area}`,
      type: 'pickup_point',
      title: `${topExpansion.area}訂單密度與營收較高`,
      recommendation: `建議評估在 ${topExpansion.area} 設置自取點或快閃取貨點`,
      reason: '訪客數、訂單數與營業額綜合評分在此區域相對領先',
      confidence: topExpansion.stars >= 5 ? 'high' : 'medium',
      area: topExpansion.area,
      status: 'pending',
      source: 'geo-rule-engine',
    });
  }

  // 穩定排序（第 4 節）：confidence high>medium>low → 型別優先序（充當
  // severity）→ area 字母序 → rule id 字母序，全程不使用亂數，同樣輸入
  // 永遠得到同樣順序。
  const TYPE_SEVERITY = { data_quality: 0, pricing: 1, conversion: 1, delivery_fee: 2, coupon: 2, advertising: 3, pickup_point: 3 };
  actions.sort((a, b) => {
    if (CONFIDENCE_RANK[a.confidence] !== CONFIDENCE_RANK[b.confidence]) return CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    const sa = TYPE_SEVERITY[a.type] ?? 9, sb = TYPE_SEVERITY[b.type] ?? 9;
    if (sa !== sb) return sa - sb;
    const areaA = a.area || '', areaB = b.area || '';
    if (areaA !== areaB) return areaA < areaB ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  return actions.slice(0, 5); // 最多顯示 5 筆
}

// 十九、Coming Soon 預留元件——只是 UI 佔位，不實作任何串接。
function geoComingSoonBadge(label) {
  return `<span class="geo-coming-soon" role="note" aria-label="${escHtml(label)}（即將推出）">${escHtml(label)} · Coming Soon</span>`;
}

function geoSkeleton(rows) {
  const n = rows || 3;
  return `<div class="geo-skeleton" aria-busy="true" aria-live="polite">${'<div class="geo-skeleton-row"></div>'.repeat(n)}</div>`;
}

function geoQualityBadge(status) {
  const map = {
    healthy: ['🟢 Healthy', '#10b981'],
    degraded: ['🟡 Degraded', '#f59e0b'],
    insufficient_data: ['⚪ Insufficient Data', '#94a3b8'],
    disabled: ['⚫ Disabled', '#64748b'],
  };
  const [label, color] = map[status] || map.disabled;
  return `<span style="color:${color};font-weight:700">${label}</span>`;
}

// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.2-B1-1 — Geo Dashboard API 換線
//
// 目標：把 Dashboard 首頁「KPI／Geo Quality／Top 3 區域摘要」這一段，從
// 舊版 GET /api/analytics/dashboard 隨附的 data.geo_summary（後端函式
// getGeoDashboardSummary()，見 utils/geoAnalyticsQueries.js），換線到
// R5.2-A 已完成、欄位統一的 GET /api/analytics/geo/* 系列 API。
//
// 本輪明確不動的部分（見需求文件二「本輪禁止」，維持既有行為）：
//   - 💡 今日商機（geoComputeOpportunities）與下方 _geoIntelLazyLoad()
//     產生的廣告 ROI／優惠建議／外送費最佳化／區域會員分析／開店建議——
//     這些本來就不是本輪範圍，且下方 Recommended Actions（raId）本身在
//     _geoIntelLazyLoad() 完成後就已經改用真實 funnel/fulfillment/
//     distance/source-area API 資料重新計算（見該函式結尾），並非只依賴
//     data.geo_summary，本輪不重複建置第二套建議 UI。
//   - 舊函式 getGeoDashboardSummary() / data.geo_summary 本身保留不刪除
//     （見下方 @deprecated 標記與 routes/analytics.js 對應註解），只是
//     新的 KPI／Geo Quality／Top 3 區塊不再讀它。
// ════════════════════════════════════════════════════════════════

// ── 4. Geo Dashboard API Client ───────────────────────────────
// 參數白名單與 utils/geoAnalyticsFilters.js 的 parseGeoAnalyticsFilters()
// 完全一致：query 用 date_from/date_to（不是 from/to）；不接受
// store_id —— storeId 一律由 apiFetch() 自動附加的 Authorization /
// x-store-id header 決定，後端 requireStore 明確拒絕 req.query.store_id
// （見 routes/analytics-geo.js 檔頭註解），前端也不重複傳送。
// 沿用現有 apiFetch() 這一套 HTTP wrapper，不建立第二套 client。
const GEO_DASHBOARD_PARAM_KEYS = ['date_from', 'date_to', 'county_code', 'subdivision_code', 'channel', 'source'];

function _buildGeoDashboardParams(params) {
  const qs = new URLSearchParams();
  GEO_DASHBOARD_PARAM_KEYS.forEach((k) => {
    if (params && params[k] !== undefined && params[k] !== null && params[k] !== '') qs.set(k, params[k]);
  });
  return qs;
}

function getGeoOverview(params, signal) {
  return apiFetch(`/api/analytics/geo/overview?${_buildGeoDashboardParams(params).toString()}`, { signal });
}
function getGeoFunnel(params, signal) {
  const qs = _buildGeoDashboardParams(params);
  // MAX_LIMIT（見 utils/geoAnalyticsFilters.js）——Dashboard KPI 需要盡量
  // 接近「全店」的加總（見 computeGeoDashboardKpi() 的已知限制說明），其他
  // 呼叫端若只需要少量 Top 區域，可自行覆寫 limit。
  if (!params || params.limit === undefined) qs.set('limit', '100');
  return apiFetch(`/api/analytics/geo/funnel?${qs.toString()}`, { signal });
}
function getGeoAlerts(params, signal) {
  return apiFetch(`/api/analytics/geo/alerts?${_buildGeoDashboardParams(params).toString()}`, { signal });
}
function getGeoCountySummary(params, signal) {
  return apiFetch(`/api/analytics/geo/county-summary?${_buildGeoDashboardParams(params).toString()}`, { signal });
}
// fix18-10-hotfix30-B5-R5.2-B1-2：/administrative-areas 與 /available-areas
// 用於雙層縣市／行政區篩選下拉選單。注意：這兩支端點跟 /county-summary 一樣，
// 都不是 routes/analytics-geo.js 的 _safeHandler 包出來的（不是
// {success,data} 形狀），而是各自用 res.json({ok:true,...}) 直接回傳——
// 呼叫端一律用 _readGeoOkJson()（見 loadGeoDashboardData 附近）解析，不是
// _readGeoSuccessJson()。
function getGeoAdministrativeAreas(params, signal) {
  const qs = new URLSearchParams();
  if (params && params.county_code) qs.set('county_code', params.county_code);
  return apiFetch(`/api/analytics/geo/administrative-areas?${qs.toString()}`, { signal });
}
function getGeoAvailableAreas(params, signal) {
  const qs = _buildGeoDashboardParams(params);
  if (params && params.county_code) qs.set('county_code', params.county_code);
  return apiFetch(`/api/analytics/geo/available-areas?${qs.toString()}`, { signal });
}

// ── 5. AbortController ────────────────────────────────────────
// Dashboard 重新整理、切換店家或日期時，取消前一次尚未完成的請求，避免
// 「舊 response 比新 response 晚回來 → 舊資料覆蓋新畫面」（需求文件五）。
let geoDashboardAbortController = null;

// ── 6. Dashboard 聚合載入函式 ─────────────────────────────────
// 並行取得 overview / funnel / county-summary / alerts，用
// Promise.allSettled() 避免單一非核心 API 失敗讓整段空白（需求文件六）。
// 優先級：overview / funnel / county-summary 為必要（任一失敗 → status
// 'error'）；alerts 允許局部失敗（→ status 'partial'，其餘照常顯示）。
async function loadGeoDashboardData(params) {
  if (geoDashboardAbortController) geoDashboardAbortController.abort();
  const controller = new AbortController();
  geoDashboardAbortController = controller;

  const vm = { status: 'loading', overview: null, funnel: null, county_summary: null, county_partial: false, alerts: [], alerts_partial: false, quality: null, updated_at: null, errors: {} };

  // fix18-10-hotfix30-B5-R5.2-B1-2（bug fix，發現於本輪開發 administrative-areas
  // 整合時）：/overview /funnel /alerts 是 _safeHandler 包出來的
  // {success:true, data:{...}} 形狀，但 /county-summary（以及 B1-2 新用到的
  // /administrative-areas /available-areas）是各自獨立的 raw handler，回傳
  // {ok:true, ...其餘欄位直接攤平...}，完全沒有 success/data 兩層包裝。
  // B1-1 原本的 readJson() 只認得 {success,data}，導致 county-summary 在
  // 「真的接正式後端」時無論成功與否都會被解析成 null（county_partial 永遠
  // 是 true）——B1-1 的 smoke test fixture 當時錯誤地把 county-summary mock
  // 包成 {success,data} 形狀，掩蓋了這個問題，一併在本輪修正 fixture。
  const readJson = async (settled) => {
    if (!settled || settled.status !== 'fulfilled') return null;
    const res = settled.value;
    if (!res || !res.ok) return null;
    try {
      const json = await res.json();
      return (json && json.success) ? json.data : null;
    } catch (e) { return null; }
  };
  const readOkJson = async (settled) => {
    if (!settled || settled.status !== 'fulfilled') return null;
    const res = settled.value;
    if (!res || !res.ok) return null;
    try {
      const json = await res.json();
      if (!json || json.ok !== true) return null;
      const { ok, ...rest } = json; // eslint-disable-line no-unused-vars
      return rest;
    } catch (e) { return null; }
  };

  try {
    const [overviewSettled, funnelSettled, countySettled, alertsSettled] = await Promise.allSettled([
      getGeoOverview(params, controller.signal),
      getGeoFunnel(params, controller.signal),
      getGeoCountySummary(params, controller.signal),
      getGeoAlerts(params, controller.signal),
    ]);

    if (controller.signal.aborted) return { status: 'aborted' };

    const overview = await readJson(overviewSettled);
    const funnel = await readJson(funnelSettled);
    const county = await readOkJson(countySettled);
    const alerts = await readJson(alertsSettled);

    if (controller.signal.aborted) return { status: 'aborted' };

    // fix18-10-hotfix30-B5-R5.2-B1-1（續作修正）：只有 overview／funnel 是
    // 必要 API——它們是 KPI 卡片與高意願／低轉換 Top 3 唯一的資料來源，缺一
    // 不可。county-summary 只餵「外送成交（依訪客來源縣市）Top 3」這一個
    // 區塊，本身可以局部失敗，不該讓整張 KPI 卡片跟著進 error 狀態（alerts
    // 原本就是可局部失敗，維持不變）。
    const coreOk = !!(overview && funnel);
    if (!coreOk) {
      vm.status = 'error';
      vm.errors = { overview: !overview, funnel: !funnel };
      return vm;
    }

    vm.overview = overview;
    vm.funnel = funnel;
    vm.county_summary = county; // 可能是 null（局部失敗），呼叫端一律用 (vm.county_summary && ...) 防護
    vm.county_partial = !county;
    vm.alerts = (alerts && alerts.alerts) || [];
    vm.alerts_partial = !alerts; // alerts 失敗時允許局部顯示（需求文件六、十二）
    vm.quality = overview.data_quality || null;
    // API 未回傳 updated_at；改用「前端成功完成載入的時間」，避免使用未成功
    // 請求（例如被 abort）的時間（需求文件十三）。
    vm.updated_at = new Date().toISOString();
    vm.status = (vm.alerts_partial || vm.county_partial) ? 'partial' : 'ready';
    return vm;
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) return { status: 'aborted' };
    vm.status = 'error';
    vm.error_message = e && e.message;
    return vm;
  } finally {
    if (geoDashboardAbortController === controller) geoDashboardAbortController = null;
  }
}

// ── 7. Dashboard KPI（換線） ───────────────────────────────────
// 進站訪客／加購／結帳／成交一律加總 /funnel 回傳的逐區資料，跟後端
// getGeoDashboardSummary() 產生 top_intent_areas 用的是同一份 /funnel
// 查詢結果（見 utils/geoAnalyticsQueries.js），不是前端另外發明的統計
// 邏輯。已知限制：/funnel 有 MAX_LIMIT=100 筆分頁上限，若單一期間內
// city/district 組合超過 100 種，這裡的加總會是「前 100 大區域」的近似值
// 而非絕對全店總量——一般店家的行政區數遠低於 100，此限制誠實記錄於此。
// 成交率＝Σsubmitted_order_visitors ÷ Σvisitors，套用與後端 _rate()
// 完全一致的公式（四捨五入到小數點後 4 位，0～1 之間），不自行改定義。
function _sumFunnelAreas(funnel) {
  const areas = (funnel && funnel.areas) || [];
  return areas.reduce((acc, a) => {
    acc.visitors += a.visitors || 0;
    acc.add_to_cart_visitors += a.add_to_cart_visitors || 0;
    acc.begin_checkout_visitors += a.begin_checkout_visitors || 0;
    acc.submitted_order_visitors += a.submitted_order_visitors || 0;
    return acc;
  }, { visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, submitted_order_visitors: 0 });
}
function _geoRate(n, d) { // 與 utils/geoAnalyticsQueries.js 的 _rate() 定義一致
  const nn = Number(n) || 0, dd = Number(d) || 0;
  if (dd <= 0) return 0;
  return Math.round((nn / dd) * 10000) / 10000;
}
function computeGeoDashboardKpi(vm) {
  const totals = _sumFunnelAreas(vm.funnel);
  return {
    visitors: totals.visitors,
    add_to_cart_visitors: totals.add_to_cart_visitors,
    begin_checkout_visitors: totals.begin_checkout_visitors,
    submitted_order_visitors: totals.submitted_order_visitors,
    conversion_rate: _geoRate(totals.submitted_order_visitors, totals.visitors), // 0–1，顯示時 ×100
  };
}

// ── 8. Geo Quality ─────────────────────────────────────────────
// 狀態值（healthy/degraded/insufficient_data/disabled）與門檻沿用既有
// utils/geoAnalyticsQueries.js:getGeoQuality()，不在前端重新發明；顯示用的
// geoQualityBadge() 也是既有函式（見上方，第一節）。
function renderGeoQualityBlock(quality) {
  if (!quality) {
    return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">Geo Quality：目前無法取得資料品質資訊</div>`;
  }
  const unknownPct = Math.round((quality.unknown_rate || 0) * 100);
  const identifiedPct = Math.round((quality.identified_rate || 0) * 100);
  const allUnknown = (quality.total_events || 0) > 0 && (quality.identified_events || 0) === 0;
  return `<div>
    <div style="font-weight:700">📡 Geo Quality：${geoQualityBadge(quality.status || 'disabled')}</div>
    <div style="font-size:.78rem;color:var(--text-secondary,#64748b);margin-top:2px">未知區域比例 ${unknownPct}%・已辨識比例 ${identifiedPct}%</div>
    ${allUnknown ? `<div style="font-size:.78rem;color:#ef4444;margin-top:4px">目前所有訪客皆為未知區域，請檢查 Acquisition Geo 資料來源</div>` : ''}
  </div>`;
}

// ── 9. Dashboard Top 區域 ──────────────────────────────────────
// 本輪先做：高意願區域 Top 3／高流量低轉換 Top 3／外送成交 Top 3
//（購物車放棄 Top 3 留給 R5.2-B1-2，見需求文件九）。
// 高意願／低轉換排序邏輯與門檻沿用 getGeoDashboardSummary() 既有規則
//（MIN_SAMPLE=10、waste 門檻 visitors>=20 且 submitted_order_visitors=0、
// score = submitted_order_visitors*5 + begin_checkout_visitors），不重新
// 發明新公式，只是資料來源換成前端自己抓的 /funnel。
// ════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.2-B1-2 — 行政區排行榜 + 區域 Funnel + Drill Down
//
// 資料來源限制（需求文件二）：只用 /overview /funnel /county-summary
// /administrative-areas /available-areas，不重新查 SQL、不建新 API、不用
// 舊 geo_summary。排行榜列資料（訪客/加購/結帳/完成訂單/成交率）直接沿用
// loadGeoDashboardData() 已經抓到的 vm.funnel.areas（跟 Top 3、Dashboard
// KPI 同一份資料，見需求文件十一「Top3 不得另外維護第二份」），排序／搜尋／
// 分頁／展開／Drawer 全部是純前端操作，不重新 fetch（需求文件七、八）。
// 縣市／行政區雙層篩選才會觸發真的重新載入（county_code/subdivision_code
// 是 loadGeoDashboardData() 的合法參數，見 utils/geoAnalyticsFilters.js），
// 因此切換縣市會自然讓 Dashboard KPI／Top3／Recommended Actions／排行榜
// 一起同步（需求文件六、十二——都是同一次 refreshGeoDashboardKpiBlock()
// 重繪出來的，不是兩套邏輯各自同步）。
// ════════════════════════════════════════════════════════════════

const GEO_RANKING_PAGE_SIZE = 20;
// 篩選（觸發真的重新 fetch，見上方說明）與純前端 UI 狀態（不重新 fetch）
// 刻意分成兩個變數，避免「改篩選」跟「換頁/排序」混用同一套 reset 邏輯。
let geoDashboardFilters = { county_code: null, subdivision_code: null };
let geoRankingState = { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 };
let geoExpandedAreaKeys = new Set();
let geoLastVm = null; // 最近一次成功（ready/partial）的 loadGeoDashboardData() 結果，供 Drawer/展開/排序/搜尋重用
let geoLastContainerId = null;
let geoAdminAreasCache = null; // { counties: [...] }；subdivisions 用 Map 依 county_code 分開快取
const geoSubdivisionsCache = new Map();

// 頂層 let 宣告在瀏覽器 classic script（以及 jsdom eval）底下都不會自動變成
// window 的屬性（這是標準 JS 行為，不是 jsdom 特有的怪癖）——跟上面既有的
// window.__geoDashboardLegacyDisabled 是同一個理由：狀態需要能被外部（除錯
// 工具、smoke test）讀到時，就得明確掛一份到 window 上。這裡統一用一個
// helper，在每個會修改狀態的地方呼叫，不是測試專用的後門。
function _geoExposeWindowState() {
  if (typeof window === 'undefined') return; // Node（require() 做 Part A 單元測試）下沒有 window，安全跳過
  window.geoDashboardFilters = geoDashboardFilters;
  window.geoRankingState = geoRankingState;
  window.geoExpandedAreaKeys = geoExpandedAreaKeys;
  window.geoLastVm = geoLastVm;
  window.geoAdminAreasCache = geoAdminAreasCache;
}

function _geoAreaKey(a) {
  if (!a) return '';
  return a.area_key || `${a.city || ''}|${a.district || ''}`;
}
function _geoAreaLabel(a) {
  return (a && (a.area_label || a.district || a.city)) || '未知區域';
}
function _geoIsUnknownArea(a) {
  return !a || (!a.city && !a.district);
}

// ── 雙層縣市／行政區篩選：資料來源 /administrative-areas ─────────
async function _geoEnsureAdminAreasLoaded() {
  if (geoAdminAreasCache) return geoAdminAreasCache;
  try {
    const res = await getGeoAdministrativeAreas({});
    if (!res || !res.ok) { geoAdminAreasCache = { counties: [] }; _geoExposeWindowState(); return geoAdminAreasCache; }
    const json = await res.json();
    geoAdminAreasCache = (json && json.ok) ? { counties: json.counties || [] } : { counties: [] };
  } catch (e) {
    geoAdminAreasCache = { counties: [] };
  }
  _geoExposeWindowState();
  return geoAdminAreasCache;
}
async function _geoEnsureSubdivisionsLoaded(countyCode) {
  if (!countyCode) return [];
  if (geoSubdivisionsCache.has(countyCode)) return geoSubdivisionsCache.get(countyCode);
  let subdivisions = [];
  try {
    const res = await getGeoAdministrativeAreas({ county_code: countyCode });
    if (res && res.ok) {
      const json = await res.json();
      if (json && json.ok) subdivisions = json.subdivisions || [];
    }
  } catch (e) { /* 安靜失敗，下拉選單維持只有「全部」 */ }
  geoSubdivisionsCache.set(countyCode, subdivisions);
  return subdivisions;
}

// 切換縣市／行政區：更新篩選狀態，重設分頁與展開狀態，觸發「真的」重新
// 載入（Dashboard KPI／Top3／Recommended Actions／排行榜一起同步，需求文件六）。
async function geoDashboardSetCounty(countyCode) {
  geoDashboardFilters.county_code = countyCode || null;
  geoDashboardFilters.subdivision_code = null; // 縣市變更 → 清除不相容的行政區篩選（需求文件五）
  geoRankingState.page = 1;
  geoExpandedAreaKeys.clear();
  _geoExposeWindowState();
  if (countyCode) await _geoEnsureSubdivisionsLoaded(countyCode);
  if (geoLastContainerId) await refreshGeoDashboardKpiBlock(geoLastContainerId);
}
async function geoDashboardSetSubdivision(subdivisionCode) {
  geoDashboardFilters.subdivision_code = subdivisionCode || null;
  geoRankingState.page = 1;
  geoExpandedAreaKeys.clear();
  _geoExposeWindowState();
  if (geoLastContainerId) await refreshGeoDashboardKpiBlock(geoLastContainerId);
}

// ── 排序／搜尋／分頁／展開：純前端操作，重用 geoLastVm，不重新 fetch ──
function _geoRerenderRankingOnly() {
  if (!geoLastContainerId || !geoLastVm) return;
  const el = document.getElementById(geoLastContainerId + '-ranking');
  if (!el) return;
  el.innerHTML = _renderGeoAreaRankingTable(geoLastVm);
}
function geoRankingSetSort(key) {
  if (geoRankingState.sortKey === key) {
    geoRankingState.sortDir = geoRankingState.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    geoRankingState.sortKey = key;
    geoRankingState.sortDir = 'desc';
  }
  geoRankingState.page = 1;
  _geoExposeWindowState();
  _geoRerenderRankingOnly();
}
function geoRankingSetSearch(value) {
  geoRankingState.search = value || '';
  geoRankingState.page = 1;
  _geoExposeWindowState();
  _geoRerenderRankingOnly();
}
function geoRankingSetPage(page) {
  if (page < 1) return;
  geoRankingState.page = page;
  _geoExposeWindowState();
  _geoRerenderRankingOnly();
}
function geoRankingToggleExpand(areaKey) {
  if (geoExpandedAreaKeys.has(areaKey)) geoExpandedAreaKeys.delete(areaKey);
  else geoExpandedAreaKeys.add(areaKey);
  _geoExposeWindowState();
  _geoRerenderRankingOnly();
}

// ── 排序／搜尋：Unknown 永遠排最後（需求文件四、十七）──────────────
function _geoSortAreas(areas, sortKey, sortDir) {
  const known = areas.filter((a) => !_geoIsUnknownArea(a));
  const unknown = areas.filter((a) => _geoIsUnknownArea(a));
  const dirMul = sortDir === 'asc' ? 1 : -1;
  const valueOf = (a) => {
    if (sortKey === 'conversion') return _geoRate(a.submitted_order_visitors, a.visitors);
    if (sortKey === 'cart') return a.add_to_cart_visitors || 0;
    if (sortKey === 'checkout') return a.begin_checkout_visitors || 0;
    if (sortKey === 'orders') return a.submitted_order_visitors || 0;
    return a.visitors || 0; // 預設/'visitors'
  };
  known.sort((a, b) => (valueOf(a) - valueOf(b)) * dirMul);
  return known.concat(unknown); // unknown 不受排序方向影響，固定排最後
}
function _geoFilterAreasBySearch(areas, search) {
  const list = areas || [];
  const q = (search || '').trim();
  if (!q) return list;
  return list.filter((a) => _geoAreaLabel(a).includes(q));
}

function computeGeoAreaRanking(vm, state) {
  const all = (vm.funnel && vm.funnel.areas) || [];
  const searched = _geoFilterAreasBySearch(all, state.search);
  const sorted = _geoSortAreas(searched, state.sortKey, state.sortDir);
  const totalPages = Math.max(1, Math.ceil(sorted.length / GEO_RANKING_PAGE_SIZE));
  const page = Math.min(Math.max(1, state.page), totalPages);
  const rows = sorted.slice((page - 1) * GEO_RANKING_PAGE_SIZE, page * GEO_RANKING_PAGE_SIZE);
  return { rows, total: sorted.length, page, totalPages };
}

// ── 渲染：篩選列 ──────────────────────────────────────────────
function _renderGeoFilterBarHtml() {
  const counties = (geoAdminAreasCache && geoAdminAreasCache.counties) || [];
  const selectedCounty = geoDashboardFilters.county_code || '';
  const subdivisions = selectedCounty ? (geoSubdivisionsCache.get(selectedCounty) || []) : [];
  const selectedSubdivision = geoDashboardFilters.subdivision_code || '';
  return `<div role="search" aria-label="行政區篩選" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0">
    <select aria-label="縣市" onchange="geoDashboardSetCounty(this.value)" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:inherit">
      <option value="" ${!selectedCounty ? 'selected' : ''}>全部縣市</option>
      ${counties.map((c) => `<option value="${escHtml(c.county_code)}" ${c.county_code === selectedCounty ? 'selected' : ''}>${escHtml(c.county_name)}</option>`).join('')}
    </select>
    <select aria-label="行政區" onchange="geoDashboardSetSubdivision(this.value)" ${!selectedCounty ? 'disabled' : ''} style="padding:5px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:inherit">
      <option value="" ${!selectedSubdivision ? 'selected' : ''}>全部行政區</option>
      ${subdivisions.map((s) => `<option value="${escHtml(s.subdivision_code)}" ${s.subdivision_code === selectedSubdivision ? 'selected' : ''}>${escHtml(s.subdivision_name)}</option>`).join('')}
    </select>
    <input type="search" aria-label="搜尋行政區" placeholder="搜尋行政區（例如：中壢）" value="${escHtml(geoRankingState.search)}"
      oninput="geoRankingSetSearch(this.value)" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:inherit;min-width:160px">
  </div>`;
}

// ── 渲染：排行榜表格（含排序表頭、展開列、分頁）────────────────────
const GEO_RANKING_COLUMNS = [
  ['visitors', '訪客'], ['cart', '加入購物車'], ['checkout', '開始結帳'], ['orders', '完成訂單'], ['conversion', '成交率'],
];
function _geoSortArrow(key) {
  if (geoRankingState.sortKey !== key) return '';
  return geoRankingState.sortDir === 'asc' ? ' ↑' : ' ↓';
}
function _renderGeoAreaRankingTable(vm) {
  if (vm.county_partial) {
    // 需求文件十五：county-summary 失敗時排行榜暫時無法載入，但 Dashboard
    // KPI 仍正常（KPI 卡片在 refreshGeoDashboardKpiBlock() 裡是獨立渲染的，
    // 不受這裡影響）。
    return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">行政區排行榜暫時無法載入</div>`;
  }
  const { rows, total, page, totalPages } = computeGeoAreaRanking(vm, geoRankingState);
  if (!total) {
    return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">目前沒有符合條件的行政區資料</div>`;
  }
  const headerCells = GEO_RANKING_COLUMNS.map(([key, label]) => `<th style="padding:6px 8px;cursor:pointer;user-select:none" onclick="geoRankingSetSort('${key}')" role="columnheader" aria-sort="${geoRankingState.sortKey === key ? (geoRankingState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">${escHtml(label)}${_geoSortArrow(key)}</th>`).join('');
  const rowsHtml = rows.map((a) => {
    const key = _geoAreaKey(a);
    const unknown = _geoIsUnknownArea(a);
    const label = _geoAreaLabel(a);
    const rate = _geoRate(a.submitted_order_visitors, a.visitors);
    const expanded = geoExpandedAreaKeys.has(key);
    const safeKeyAttr = escHtml(key);
    const mainRow = `<tr class="db-v3-hover">
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">
        <button type="button" onclick="geoRankingToggleExpand('${safeKeyAttr}')" aria-expanded="${expanded}" aria-label="展開 ${escHtml(label)} 區域漏斗" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;margin-right:6px">${expanded ? '▾' : '▸'}</button>
        <button type="button" onclick="geoAreaDrawerOpen('${safeKeyAttr}')" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;text-decoration:underline dotted">${escHtml(label)}</button>
        ${unknown ? ' <span style="color:var(--text-secondary,#64748b)">(未知區域)</span>' : ''}
      </td>
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${(a.visitors || 0).toLocaleString('zh-TW')}</td>
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${(a.add_to_cart_visitors || 0).toLocaleString('zh-TW')}</td>
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${(a.begin_checkout_visitors || 0).toLocaleString('zh-TW')}</td>
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${(a.submitted_order_visitors || 0).toLocaleString('zh-TW')}</td>
      <td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${(rate * 100).toFixed(1)}%</td>
    </tr>`;
    const funnelRow = expanded ? `<tr><td colspan="6" style="padding:8px 8px 14px 30px;border-top:none">${_renderGeoAreaFunnelSteps(a)}</td></tr>` : '';
    return mainRow + funnelRow;
  }).join('');

  const paginationHtml = total > GEO_RANKING_PAGE_SIZE ? `<div style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:.8rem">
    <button type="button" onclick="geoRankingSetPage(${page - 1})" ${page <= 1 ? 'disabled' : ''} style="padding:4px 10px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:var(--text-secondary,#64748b);cursor:pointer">上一頁</button>
    <span>第 ${page} 頁 / 共 ${totalPages} 頁（${total} 筆）</span>
    <button type="button" onclick="geoRankingSetPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''} style="padding:4px 10px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:var(--text-secondary,#64748b);cursor:pointer">下一頁</button>
  </div>` : '';

  return `<table style="width:100%;border-collapse:collapse;font-size:.82rem" aria-label="行政區排行榜">
    <thead><tr style="text-align:left;color:var(--text-secondary,#64748b)"><th style="padding:6px 8px">行政區</th>${headerCells}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>${paginationHtml}`;
}

// ── 區域 Funnel（展開列）：完全用同一個 area 物件既有欄位，不重新 fetch ──
function _renderGeoAreaFunnelSteps(a) {
  const steps = [
    ['訪客', a.visitors], ['加入購物車', a.add_to_cart_visitors], ['開始結帳', a.begin_checkout_visitors], ['完成訂單', a.submitted_order_visitors],
  ];
  return `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.8rem;color:var(--text-secondary,#64748b)">
    ${steps.map(([label, val], i) => `<span>${escHtml(label)} <strong style="color:var(--text-primary,#e2e8f0)">${(val || 0).toLocaleString('zh-TW')}</strong></span>${i < steps.length - 1 ? '<span>↓</span>' : ''}`).join('')}
  </div>`;
}

// ── Drill Down Drawer：只用已載入資料，不重新 request（需求文件八）──
let geoAreaDrawerData = null;
let _geoAreaDrawerLastFocusedEl = null;
let _geoAreaDrawerEscBound = false;
function geoAreaDrawerOpen(areaKey) {
  if (!geoLastVm || !geoLastVm.funnel) return;
  const area = (geoLastVm.funnel.areas || []).find((a) => _geoAreaKey(a) === areaKey);
  if (!area) return;
  _geoAreaDrawerLastFocusedEl = document.activeElement || null;
  geoAreaDrawerData = area;
  _renderGeoAreaDrawer();
  _geoAreaDrawerEnsureEscListener();
  const closeBtn = document.querySelector('.geo-area-drawer button[aria-label="關閉"]');
  if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
}
function geoAreaDrawerClose() {
  geoAreaDrawerData = null;
  const el = document.getElementById((geoLastContainerId || '') + '-drawer');
  if (el) el.innerHTML = '';
  if (_geoAreaDrawerLastFocusedEl && document.contains(_geoAreaDrawerLastFocusedEl) && typeof _geoAreaDrawerLastFocusedEl.focus === 'function') {
    _geoAreaDrawerLastFocusedEl.focus();
  }
  _geoAreaDrawerLastFocusedEl = null;
}
// 記憶體守則：ESC 全域 listener 只註冊一次（同 av2Geo drawer 既有慣例，見
// 上方 _av2GeoEnsureEscListener()），避免開關 N 次疊加 N 個 listener。
function _geoAreaDrawerEscListener(e) {
  if (e.key === 'Escape' && geoAreaDrawerData) geoAreaDrawerClose();
}
function _geoAreaDrawerEnsureEscListener() {
  if (_geoAreaDrawerEscBound) return;
  _geoAreaDrawerEscBound = true;
  document.addEventListener('keydown', _geoAreaDrawerEscListener);
}
function _renderGeoAreaDrawer() {
  const el = document.getElementById((geoLastContainerId || '') + '-drawer');
  if (!el) return;
  const a = geoAreaDrawerData;
  if (!a) { el.innerHTML = ''; return; }
  const label = _geoAreaLabel(a);
  const rate = _geoRate(a.submitted_order_visitors, a.visitors);
  const quality = geoLastVm && geoLastVm.quality;
  // Recommended Actions：從已載入的 vm.alerts 篩出跟這個區域相符的（不重新
  // request，需求文件八）。
  // Bug fix（B1-2 收尾發現）：原本用 city 或 district 任一相符就算數（OR），
  // 會導致同一縣市底下所有行政區的 Drawer 都顯示彼此不相關的 alert（例如
  // 桃園市中壢區跟桃園市八德區的 alert 互相污染）。改成要求 city 與
  // district「同時」相符，才是真的同一個區域。
  const relatedAlerts = ((geoLastVm && geoLastVm.alerts) || []).filter((al) => al.city === a.city && al.district === a.district);
  el.innerHTML = `<div class="geo-drawer-overlay" onclick="geoAreaDrawerClose()"></div>
    <div class="geo-drawer geo-area-drawer" role="dialog" aria-modal="true" aria-label="${escHtml(label)} 詳細資料" onclick="event.stopPropagation()">
      <button type="button" onclick="geoAreaDrawerClose()" aria-label="關閉" style="float:right;background:none;border:none;color:var(--text-secondary,#64748b);cursor:pointer;font-size:1rem">✕</button>
      <h4 style="margin:0 0 10px">${escHtml(label)}</h4>
      <div style="font-size:.85rem;line-height:1.8">
        <div>訪客：<strong>${(a.visitors || 0).toLocaleString('zh-TW')}</strong></div>
        <div>加入購物車：<strong>${(a.add_to_cart_visitors || 0).toLocaleString('zh-TW')}</strong></div>
        <div>開始結帳：<strong>${(a.begin_checkout_visitors || 0).toLocaleString('zh-TW')}</strong></div>
        <div>完成訂單：<strong>${(a.submitted_order_visitors || 0).toLocaleString('zh-TW')}</strong></div>
        <div>成交率：<strong>${(rate * 100).toFixed(1)}%</strong></div>
      </div>
      <div style="margin-top:10px">${quality ? renderGeoQualityBlock(quality) : ''}</div>
      <div style="margin-top:10px;font-weight:700;font-size:.85rem">建議動作</div>
      ${relatedAlerts.length ? relatedAlerts.map((al) => `<div style="padding:6px 0;font-size:.8rem;border-top:1px solid var(--border,#2a2d3e)">${escHtml(al.message || '')}</div>`).join('') : `<div style="font-size:.8rem;color:var(--text-secondary,#64748b);padding:6px 0">目前資料不足</div>`}
    </div>`;
}

function computeGeoTopAreas(vm) {
  const areas = (vm.funnel && vm.funnel.areas) || [];
  const MIN_SAMPLE = 10;
  const labelOf = (a) => a.area_label || a.district || a.city || '未知區域';
  const isUnknown = (a) => !a.city && !a.district;

  const highIntent = areas
    .filter((a) => a.visitors >= MIN_SAMPLE)
    .map((a) => ({ area: a, _score: (a.submitted_order_visitors || 0) * 5 + (a.begin_checkout_visitors || 0) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 3)
    .map(({ area: a }) => ({
      area_label: labelOf(a), visitor_count: a.visitors, cart_count: a.add_to_cart_visitors,
      checkout_count: a.begin_checkout_visitors, purchase_count: a.submitted_order_visitors,
      conversion_rate: _geoRate(a.submitted_order_visitors, a.visitors), unknown: isUnknown(a),
    }));

  const lowConversion = areas
    .filter((a) => a.visitors >= 20 && (a.submitted_order_visitors || 0) === 0)
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 3)
    .map((a) => ({
      area_label: labelOf(a), visitor_count: a.visitors, cart_count: a.add_to_cart_visitors,
      checkout_count: a.begin_checkout_visitors, purchase_count: 0, conversion_rate: 0, unknown: isUnknown(a),
    }));

  // 外送成交 Top 3：/county-summary 是 acquisition context（依訪客來源縣市
  // 聚合），這裡明確標示為「訪客來源縣市的成交」，不是「配送/履約區域」，
  // 避免和 Acquisition Geo／Fulfillment Geo 混用（需求文件十六原則、
  // 完整的 /fulfillment 履約區域分析留給 R5.2-B1-2）。
  const countyRows = (vm.county_summary && vm.county_summary.rows) || [];
  const topOrders = countyRows
    .filter((c) => (c.order_count || 0) > 0)
    .sort((a, b) => (b.order_count || 0) - (a.order_count || 0))
    .slice(0, 3)
    .map((c) => ({ area_label: c.county_name || c.county_code || '未知縣市', order_count: c.order_count, revenue: c.revenue, unknown: !c.county_code }));

  return { high_intent: highIntent, low_conversion: lowConversion, top_orders_by_source_county: topOrders };
}

function _renderGeoTopAreaRows(rows) {
  if (!rows || !rows.length) return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有符合條件的區域資料</div>`;
  return rows.map((r) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border,#2a2d3e);font-size:.85rem">
    <span>${escHtml(r.area_label)}${r.unknown ? ' <span style="color:var(--text-secondary,#64748b)">(未知區域)</span>' : ''}</span>
    <span>訪客 ${r.visitor_count}・加購 ${r.cart_count || 0}・結帳 ${r.checkout_count || 0}・成交 ${r.purchase_count || 0}</span>
  </div>`).join('');
}
function _renderGeoOrderAreaRows(rows) {
  if (!rows || !rows.length) return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有符合條件的區域資料</div>`;
  return rows.map((r) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border,#2a2d3e);font-size:.85rem">
    <span>${escHtml(r.area_label)}${r.unknown ? ' <span style="color:var(--text-secondary,#64748b)">(未知)</span>' : ''}</span>
    <span>訂單 ${r.order_count}・營收 ${_nt(r.revenue)}</span>
  </div>`).join('');
}

// ── 12/17. 狀態文案（loading/empty/all-unknown/error）─────────────
function _geoDashboardEmptyHtml() {
  return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">目前沒有符合條件的區域資料</div>`;
}
function _geoDashboardAllUnknownHtml() {
  return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">目前已有 Analytics 事件，但尚無可辨識區域</div>`;
}
function _geoDashboardErrorHtml(containerId) {
  return `<div style="font-size:.85rem;padding:8px 0">
    <span style="color:#ef4444">Geo 分析載入失敗</span>
    <button type="button" class="db-v3-hover" onclick="refreshGeoDashboardKpiBlock('${containerId}')" style="margin-left:8px;padding:2px 10px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:inherit;cursor:pointer">重新整理</button>
  </div>`;
}
function _geoDashboardDisabledHtml() {
  return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">Geo Analytics 未啟用</div>`;
}

// ── 主流程：KPI／Geo Quality／Top 3 容器的非同步載入與渲染 ────────
async function refreshGeoDashboardKpiBlock(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // 快捷路徑：舊摘要已經知道 Geo Analytics 功能未啟用時，不必再打新 API
  // （沿用既有規則，避免多打 4 支注定 403 的請求）。
  const legacyDisabled = window.__geoDashboardLegacyDisabled === true;
  if (legacyDisabled) {
    el.innerHTML = _geoDashboardDisabledHtml();
    return;
  }

  el.innerHTML = `${geoSkeleton(2)}<div style="color:var(--text-secondary,#64748b);font-size:.82rem">Geo 資料載入中…</div>`;

  // 十五、Store / Date Scope：一律讀取目前 Dashboard 日期狀態
  // （dashboardDateState，見 public/js/app.js），不硬寫 today / 30 days；
  // store_id 由 apiFetch() 依目前登入店家自動帶入，這裡完全不接觸。
  const ds = (typeof dashboardDateState !== 'undefined' && dashboardDateState) || {};
  const params = {};
  if (ds.start_date) params.date_from = ds.start_date;
  if (ds.end_date) params.date_to = ds.end_date;
  // fix18-10-hotfix30-B5-R5.2-B1-2：雙層縣市／行政區篩選——county_code/
  // subdivision_code 是 loadGeoDashboardData() 本來就支援的合法參數（見
  // GEO_DASHBOARD_PARAM_KEYS），這裡把 geoDashboardFilters 併入，讓切換
  // 縣市/行政區時 KPI／Top3／Recommended Actions／排行榜全部一起用新篩選
  // 重新載入（需求文件六、十二），不是另外維護一套篩選邏輯。
  if (geoDashboardFilters.county_code) params.county_code = geoDashboardFilters.county_code;
  if (geoDashboardFilters.subdivision_code) params.subdivision_code = geoDashboardFilters.subdivision_code;

  geoLastContainerId = containerId;
  const adminAreasPromise = _geoEnsureAdminAreasLoaded(); // 背景載入雙層篩選的縣市清單，跟 KPI 資料並行

  const vm = await loadGeoDashboardData(params);
  await adminAreasPromise;
  if (vm.status === 'aborted') return; // 被更新的一次呼叫取消，不渲染（需求文件五）

  const elAfter = document.getElementById(containerId); // await 期間畫面可能已重繪
  if (!elAfter) return;

  if (vm.status === 'error') {
    elAfter.innerHTML = _geoDashboardErrorHtml(containerId);
    return;
  }
  geoLastVm = vm; // 供排行榜排序/搜尋/分頁/展開/Drawer 重用，不重新 fetch（需求文件七、八）
  _geoExposeWindowState();

  const kpi = computeGeoDashboardKpi(vm);
  const tops = computeGeoTopAreas(vm);
  const isEmpty = kpi.visitors === 0 && !(vm.county_summary && (vm.county_summary.rows || []).length);
  const isAllUnknown = !isEmpty && vm.quality && (vm.quality.total_events || 0) > 0 && (vm.quality.identified_events || 0) === 0;

  if (isEmpty) { elAfter.innerHTML = _geoDashboardEmptyHtml(); return; }
  if (isAllUnknown) { elAfter.innerHTML = _geoDashboardAllUnknownHtml(); return; }

  const kpiCards = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:14px" role="list" aria-label="Geo Dashboard KPI">
    <div role="listitem">${_card('進站訪客', kpi.visitors.toLocaleString('zh-TW'), '', null)}</div>
    <div role="listitem">${_card('加入購物車', kpi.add_to_cart_visitors.toLocaleString('zh-TW'), '', null)}</div>
    <div role="listitem">${_card('開始結帳', kpi.begin_checkout_visitors.toLocaleString('zh-TW'), '', null)}</div>
    <div role="listitem">${_card('完成訂單', kpi.submitted_order_visitors.toLocaleString('zh-TW'), '', '#10b981')}</div>
    <div role="listitem">${_card('整體成交率', (kpi.conversion_rate * 100).toFixed(1) + '%', '', '#818cf8')}</div>
  </div>`;

  // 履約分析：沿用舊 Dashboard 原本就有的能力（訂單是否已有履約地理資訊），
  // 但資料來源改成新版 /overview 的 fulfillment_geo（不是舊 geo_summary），
  // 保留既有顯示能力、換掉資料來源（見續作指令七的原則，不是為了過測試塞
  // 硬編碼文案——orders_with_geo/orders_without_geo 都是真的 API 欄位）。
  const fg = vm.overview.fulfillment_geo || {};
  const fulfillmentLine = (fg.orders_with_geo != null) ? `<div style="margin-top:10px;font-size:.82rem;color:var(--text-secondary,#64748b)">🚚 履約分析：${Number(fg.orders_with_geo) || 0} 筆訂單已有履約地理資訊${fg.orders_without_geo ? `（另有 ${fg.orders_without_geo} 筆缺少）` : ''}</div>` : '';

  const partialLabels = [];
  if (vm.county_partial) partialLabels.push('外送成交（依訪客來源縣市）Top 3');
  if (vm.alerts_partial) partialLabels.push('區域建議');

  const updatedLabel = vm.updated_at ? new Date(vm.updated_at).toLocaleTimeString('zh-TW', { hour12: false }) : '—';
  elAfter.innerHTML = `
    ${kpiCards}
    ${fulfillmentLine}
    ${renderGeoQualityBlock(vm.quality)}
    <div style="margin:14px 0 6px;font-weight:700;font-size:.9rem">🏆 高意願區域 Top 3</div>
    ${_renderGeoTopAreaRows(tops.high_intent)}
    <div style="margin:14px 0 6px;font-weight:700;font-size:.9rem">⚠ 高流量低轉換 Top 3</div>
    ${_renderGeoTopAreaRows(tops.low_conversion)}
    <div style="margin:14px 0 6px;font-weight:700;font-size:.9rem">🚚 外送成交（依訪客來源縣市）Top 3</div>
    ${_renderGeoOrderAreaRows(tops.top_orders_by_source_county)}
    <div style="margin:16px 0 6px;font-weight:700;font-size:.9rem">📋 行政區排行榜</div>
    ${_renderGeoFilterBarHtml()}
    <div id="${containerId}-ranking">${_renderGeoAreaRankingTable(vm)}</div>
    <div id="${containerId}-drawer"></div>
    ${partialLabels.length ? `<div style="font-size:.72rem;color:var(--text-secondary,#64748b);margin-top:8px">${escHtml(partialLabels.join('、'))}暫時無法載入</div>` : ''}
    <div style="font-size:.7rem;color:var(--text-secondary,#64748b);margin-top:10px">最後更新：${escHtml(updatedLabel)}
      <button type="button" onclick="refreshGeoDashboardKpiBlock('${containerId}')" style="margin-left:8px;padding:1px 8px;border-radius:6px;border:1px solid var(--border,#2a2d3e);background:transparent;color:inherit;cursor:pointer;font-size:.7rem">重新整理</button>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// 二、Dashboard 首頁 — Geo Intelligence 區塊
// ════════════════════════════════════════════════════════════════
function renderDashboardGeoIntelligence(data) {
  const summary = data && data.geo_summary;
  if (!summary) return '';
  const disabled = summary.data_quality && summary.data_quality.status === 'disabled';
  // 供 refreshGeoDashboardKpiBlock() 快捷路徑使用（十一、避免對已知停用的
  // 功能重複打 4 支必定 403 的新 API）。
  window.__geoDashboardLegacyDisabled = !!disabled;
  _geoExposeWindowState();

  const opportunities = geoComputeOpportunities(summary);
  const oppHtml = opportunities.length ? opportunities.map((o) => `
    <div class="db-v3-hover" style="padding:10px 12px;border:1px solid var(--border,#2a2d3e);border-radius:10px;margin-bottom:8px">
      <div>${o.icon} <strong>${escHtml(o.headline)}</strong> <span style="font-size:.7rem;color:var(--text-secondary,#64748b)">(${o.confidence} confidence)</span></div>
      <div style="font-size:.82rem;color:var(--text-secondary,#64748b);margin-top:2px">建議：${escHtml(o.suggestion)}</div>
    </div>`).join('') : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有足夠資料產生商機建議</div>`;

  const kpiContainerId = 'geo-kpi-' + Date.now();
  const lazyId = 'geo-intel-lazy-' + Date.now();
  const raId = 'geo-ra-' + Date.now();
  const partialActions = geoComputeRecommendedActions({ summary, quality: summary.data_quality });
  const html = _section('🌍 Geo Intelligence', `
    <div id="${kpiContainerId}" aria-live="polite">${geoSkeleton(2)}<div style="color:var(--text-secondary,#64748b);font-size:.82rem">Geo 資料載入中…</div></div>
    <div style="margin-bottom:6px;font-weight:700;font-size:.9rem">💡 今日商機（Business Opportunity，規則式計算，非 AI）</div>
    ${oppHtml}
    <div id="${raId}" aria-live="polite" data-geo-ra-disabled="${disabled ? '1' : ''}">${_renderRecommendedActionsBlock(partialActions, summary)}</div>
    <div id="${lazyId}" aria-live="polite">${geoSkeleton(4)}</div>
  `);
  setTimeout(() => _geoIntelLazyLoad(lazyId, raId, summary), 0);
  setTimeout(() => refreshGeoDashboardKpiBlock(kpiContainerId), 0);
  return html;
}

async function _geoIntelLazyLoad(containerId, raId, summary) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const params = new URLSearchParams({ preset: (av2DateState && av2DateState.preset) || 'today' });
  if (av2DateState && av2DateState.start_date) params.set('date_from', av2DateState.start_date);
  if (av2DateState && av2DateState.end_date) params.set('date_to', av2DateState.end_date);

  const endpoints = ['source-area', 'fulfillment', 'distance', 'funnel'];
  const results = await Promise.all(endpoints.map((ep) =>
    apiFetch(`/api/analytics/geo/${ep}?${params.toString()}`)
      .then((r) => r && r.ok ? r.json() : { success: false })
      .catch(() => ({ success: false }))
  ));
  const [sourceAreaRes, fulfillmentRes, distanceRes, funnelRes] = results;

  let html = '';
  html += _av2Safe(() => {
    const rows = (sourceAreaRes.success && sourceAreaRes.data.rows) || [];
    const roi = geoComputeAdRoi(rows);
    const body = roi.length
      ? roi.map((r) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border,#2a2d3e);font-size:.85rem">
          <span>${escHtml(r.source)} × ${escHtml(r.district || r.city || '—')}</span>
          <span>${escHtml(r.headline)} ${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span>
        </div>`).join('')
      : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有足夠樣本產生廣告 ROI 建議</div>`;
    return _section('📣 廣告 ROI 建議 ' + geoComingSoonBadge('Meta Ads / Google Ads 自動匯入'), body);
  }, '廣告 ROI 建議');

  html += _av2Safe(() => {
    const funnelAreas = (funnelRes.success && funnelRes.data.areas) || [];
    const suggestions = geoComputeCouponSuggestions(funnelAreas);
    const body = suggestions.length
      ? suggestions.map((s) => `<div style="padding:8px 0;border-bottom:1px solid var(--border,#2a2d3e);font-size:.85rem">
          <strong>${escHtml(s.area)}</strong>：${escHtml(s.headline)}<br>
          <span style="color:var(--text-secondary,#64748b)">${escHtml(s.suggestion)}（${s.confidence} confidence，僅供參考，不會自動建立優惠券）</span>
        </div>`).join('')
      : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有符合條件的優惠券建議</div>`;
    return _section('🎟️ 區域優惠建議', body);
  }, '區域優惠建議');

  html += _av2Safe(() => {
    const bands = (distanceRes.success && distanceRes.data.bands) || [];
    const opt = geoComputeDeliveryFeeOptimization(bands);
    const body = opt.length
      ? opt.map((o) => `<div style="padding:6px 0;font-size:.85rem">${escHtml(o.band)}：${escHtml(o.headline)} → ${escHtml(o.suggestion)}</div>`).join('')
      : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有足夠資料建議外送費調整</div>`;
    return _section('🚚 外送費最佳化', body);
  }, '外送費最佳化');

  html += _section('👥 區域會員分析', geoComingSoonBadge('串接 LINE UID / CRM / 優惠券系統') +
    `<div style="color:var(--text-secondary,#64748b);font-size:.82rem;margin-top:8px">未來可顯示各區域會員數、回購率，方便針對性經營。</div>`);

  html += _av2Safe(() => {
    const funnelAreas = (funnelRes.success && funnelRes.data.areas) || [];
    const fulfillmentAreas = (fulfillmentRes.success && fulfillmentRes.data.areas) || [];
    const ranking = geoComputeExpansionRanking(funnelAreas, fulfillmentAreas);
    const body = ranking.length
      ? ranking.map((r, i) => `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:.85rem">
          <span>${i + 1}. ${escHtml(r.area || '—')}</span>
          <span>${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span>
        </div>`).join('') + `<div style="margin-top:8px;font-size:.78rem;color:var(--text-secondary,#64748b)">適合設置快閃店／自取點／分店的候選區域，依訪客數、訂單數、營業額綜合評分。</div>`
      : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前資料不足以產生開店建議</div>`;
    return _section('🏪 開店建議', body);
  }, '開店建議');

  el.innerHTML = html;

  // Recommended Actions 用完整資料（funnel/fulfillment/distance/source-area 都到齊後）重新計算一次，
  // 取代一開始只用 geo_summary 算出的 partial 版本——同一份規則引擎，只是輸入更完整。
  const raEl = raId && document.getElementById(raId);
  if (raEl) {
    const full = geoComputeRecommendedActions({
      summary,
      funnelAreas: (funnelRes.success && funnelRes.data.areas) || [],
      fulfillmentAreas: (fulfillmentRes.success && fulfillmentRes.data.areas) || [],
      distanceBands: (distanceRes.success && distanceRes.data.bands) || [],
      sourceAreaRows: (sourceAreaRes.success && sourceAreaRes.data.rows) || [],
      quality: summary.data_quality,
    });
    raEl.innerHTML = _renderRecommendedActionsBlock(full, summary);
  }
}

// ── Recommended Actions：localStorage 狀態（store 隔離）─────────────────
function _geoRAStorageKey() {
  const storeId = (typeof currentStore !== 'undefined' && currentStore && currentStore.store_id) || 'default';
  return `pos_geo_recommended_actions_v1:${storeId}`;
}
function _geoRALoadState() {
  try {
    const raw = localStorage.getItem(_geoRAStorageKey());
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) { return {}; } // 損壞的 JSON 一律安全退回空物件，不拋錯
}
function _geoRASaveState(state) {
  try { localStorage.setItem(_geoRAStorageKey(), JSON.stringify(state)); } catch (e) { /* storage 不可用時安靜失敗 */ }
}
function geoRASetStatus(actionId, status) {
  const state = _geoRALoadState();
  state[actionId] = status;
  _geoRASaveState(state);
  // 就地更新目前畫面上的卡片狀態文字，不必整個 Dashboard 重新抓資料。
  // 不依賴 CSS.escape()（並非所有環境都保證存在），改用屬性值逐一比對。
  document.querySelectorAll('[data-ra-id]').forEach((card) => {
    if (card.getAttribute('data-ra-id') !== actionId) return;
    const statusEl = card.querySelector('.geo-ra-status');
    if (statusEl) statusEl.textContent = _geoRAStatusLabel(status);
    card.dataset.raStatus = status;
  });
}
function _geoRAStatusLabel(status) {
  return { pending: '尚未執行', read: '已標記已讀', ignored: '已忽略', starred: '已收藏' }[status] || '尚未執行';
}
const GEO_RA_CONFIDENCE_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
function _renderRecommendedActionsBlock(actions, summary) {
  const disabled = summary && summary.data_quality && summary.data_quality.status === 'disabled';
  const insufficient = summary && summary.data_quality && summary.data_quality.status === 'insufficient_data';
  const title = '<div style="margin:14px 0 6px;font-weight:700;font-size:.9rem">🎯 建議動作 Recommended Actions</div>';
  if (disabled) return title + `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">區域分析目前未啟用</div>`;
  if (insufficient) return title + `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">資料量不足，暫不產生營運建議</div>`;
  if (!actions || !actions.length) return title + `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前尚無足夠資料產生建議動作</div>`;

  const state = _geoRALoadState();
  const cards = actions.map((a) => {
    const st = state[a.id] || a.status || 'pending';
    return `<div class="db-v3-hover" data-ra-id="${escHtml(a.id)}" data-ra-status="${escHtml(st)}" style="padding:10px 12px;border:1px solid var(--border,#2a2d3e);border-radius:10px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${escHtml(a.title)}</strong>
        <span style="font-size:.72rem;color:var(--text-secondary,#64748b)">信心：${GEO_RA_CONFIDENCE_LABEL[a.confidence] || 'Low'}</span>
      </div>
      <div style="font-size:.85rem;margin:6px 0">建議：${escHtml(a.recommendation)}</div>
      <div style="font-size:.78rem;color:var(--text-secondary,#64748b)">${escHtml(a.reason)}</div>
      <div style="font-size:.74rem;margin-top:4px" class="geo-ra-status">${_geoRAStatusLabel(st)}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" onclick="alert(${JSON.stringify(a.reason)})" style="font-size:.72rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">查看依據</button>
        <button type="button" onclick="geoRASetStatus('${a.id}','read')" style="font-size:.72rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">標記已讀</button>
        <button type="button" onclick="geoRASetStatus('${a.id}','ignored')" style="font-size:.72rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">忽略</button>
        <button type="button" onclick="geoRASetStatus('${a.id}','starred')" style="font-size:.72rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">收藏</button>
      </div>
    </div>`;
  }).join('');
  return title + cards;
}

// ════════════════════════════════════════════════════════════════
// 九、Analytics Center — Geo Analytics 分頁（6 個子頁籤）
// ════════════════════════════════════════════════════════════════
const AV2_GEO_SUBTABS = [
  ['overview', '總覽'],
  ['funnel', 'Visitor Funnel'],
  ['fulfillment', 'Fulfillment'],
  ['distance', 'Distance'],
  ['source-area', 'Source × Area'],
  ['quality', 'Geo Quality'],
];
let av2GeoSubTab = 'overview';
let av2GeoLoaded = false;
let av2GeoCache = {};
let av2GeoFilters = { city: '', district: '', source: '', medium: '', campaign: '', geo_context: '', page: 1, limit: 50 };
let av2GeoDrawerData = null;

function _av2GeoEnsureLoaded() {
  if (av2Tab !== 'geo') return;
  if (!av2GeoLoaded) { av2GeoLoaded = true; av2GeoFetchAndRender(av2GeoSubTab); }
  av2GeoAlertsEnsureLoaded(); // 十、Geo Alerts Center：進入 Geo 分頁就一併載入，跟 6 個子頁籤資料來源分開
}

function av2GeoSwitchSubTab(tab) {
  av2GeoSubTab = tab;
  av2GeoDrawerData = null;
  _av2GeoRenderBody();
  if (!av2GeoCache[tab]) av2GeoFetchAndRender(tab);
}

function _av2GeoBuildParams(extra) {
  const params = new URLSearchParams({ preset: av2DateState.preset || 'today' });
  if (av2DateState.start_date) params.set('date_from', av2DateState.start_date);
  if (av2DateState.end_date) params.set('date_to', av2DateState.end_date);
  if (av2Channel && av2Channel !== 'all') params.set('channel', av2Channel);
  ['city', 'district', 'source', 'medium', 'campaign', 'geo_context'].forEach((k) => {
    if (av2GeoFilters[k]) params.set(k, av2GeoFilters[k]);
  });
  if (extra && extra.page) params.set('page', extra.page);
  if (av2GeoFilters.limit) params.set('limit', av2GeoFilters.limit);
  return params;
}

async function av2GeoFetchAndRender(subTab) {
  const container = document.getElementById('av2-geo-subbody');
  if (container && !av2GeoCache[subTab]) container.innerHTML = geoSkeleton(5);
  try {
    const params = _av2GeoBuildParams({ page: av2GeoFilters.page });
    const res = await apiFetch(`/api/analytics/geo/${subTab}?${params.toString()}`);
    if (!res) { _av2GeoSubError(subTab, '無法連線'); return; }
    if (res.status === 403) { _av2GeoSubError(subTab, 'Geo Analytics 未啟用或未授權（reports 功能）'); return; }
    const json = await res.json();
    if (!json.success) { _av2GeoSubError(subTab, json.error || '載入失敗'); return; }
    av2GeoCache[subTab] = json.data;
    if (av2GeoSubTab === subTab) _av2GeoRenderBody();
  } catch (e) {
    _av2GeoSubError(subTab, e.message);
  }
}

function _av2GeoSubError(subTab, msg) {
  av2GeoCache[subTab] = { __error: msg };
  if (av2GeoSubTab === subTab) _av2GeoRenderBody();
}

function _av2GeoFilterBarHtml() {
  const f = av2GeoFilters;
  const input = (id, placeholder, val) => `<input id="${id}" class="av2-select" placeholder="${escHtml(placeholder)}" value="${escHtml(val || '')}"
    onchange="av2GeoApplyFilter('${id}', this.value)" style="min-width:100px">`;
  return `<div role="search" aria-label="Geo Analytics 篩選" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px">
    ${input('city', '城市', f.city)}
    ${input('district', '行政區', f.district)}
    ${input('source', '來源', f.source)}
    ${input('medium', 'Medium', f.medium)}
    ${input('campaign', 'Campaign', f.campaign)}
    <select id="geo_context" class="av2-select" onchange="av2GeoApplyFilter('geo_context', this.value)">
      <option value="" ${!f.geo_context ? 'selected' : ''}>全部情境</option>
      <option value="visitor" ${f.geo_context === 'visitor' ? 'selected' : ''}>Visitor</option>
      <option value="fulfillment" ${f.geo_context === 'fulfillment' ? 'selected' : ''}>Fulfillment</option>
      <option value="shipping" ${f.geo_context === 'shipping' ? 'selected' : ''}>Shipping</option>
    </select>
    <button type="button" onclick="av2GeoClearFilters()" style="padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;font-size:.78rem">清除篩選</button>
  </div>`;
}
function av2GeoApplyFilter(key, val) {
  av2GeoFilters[key] = val;
  av2GeoFilters.page = 1;
  av2GeoCache = {};
  av2GeoFetchAndRender(av2GeoSubTab);
}
function av2GeoClearFilters() {
  av2GeoFilters = { city: '', district: '', source: '', medium: '', campaign: '', geo_context: '', page: 1, limit: 50 };
  av2GeoCache = {};
  av2GeoFetchAndRender(av2GeoSubTab);
}
// Stage 1 續作：limit 變更也必須跟 filter 變更一樣把 page 重設為 1
// （沿用同一個 apply-then-refetch 慣例，不另建一套邏輯）。
function av2GeoSetLimit(limit) {
  const n = Number(limit);
  av2GeoFilters.limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 50;
  av2GeoFilters.page = 1;
  av2GeoCache = {};
  av2GeoFetchAndRender(av2GeoSubTab);
}
function av2GeoSetPage(p) {
  if (p < 1) return;
  av2GeoFilters.page = p;
  delete av2GeoCache[av2GeoSubTab];
  av2GeoFetchAndRender(av2GeoSubTab);
}

function _av2GeoRenderBody() {
  const wrap = document.getElementById('av2-geo-body');
  if (!wrap) return;
  const tabsHtml = AV2_GEO_SUBTABS.map(([k, label]) => {
    const active = av2GeoSubTab === k;
    return `<button type="button" role="tab" aria-selected="${active}" onclick="av2GeoSwitchSubTab('${k}')"
      style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);font-size:.8rem;cursor:pointer;background:${active ? 'var(--accent)' : 'transparent'};color:${active ? '#111' : 'var(--text-secondary)'};font-weight:${active ? '700' : '400'}">${label}</button>`;
  }).join('');

  const data = av2GeoCache[av2GeoSubTab];
  let bodyHtml;
  if (!data) bodyHtml = geoSkeleton(5);
  else if (data.__error) bodyHtml = `<div class="analytics-empty-state" role="alert"><div class="analytics-empty-icon">❌</div><p>${escHtml(data.__error)}</p>
    <button type="button" onclick="av2GeoFetchAndRender('${av2GeoSubTab}')" style="padding:6px 14px;border-radius:8px;background:var(--info);border:none;color:#fff;cursor:pointer;font-size:.8rem">🔄 重新載入</button></div>`;
  else bodyHtml = _av2Safe(() => _av2GeoRenderSubTab(av2GeoSubTab, data), AV2_GEO_SUBTABS.find(t => t[0] === av2GeoSubTab)[1]);

  wrap.innerHTML = `
    <div role="tablist" aria-label="Geo Analytics 子頁籤" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${tabsHtml}</div>
    ${_av2GeoFilterBarHtml()}
    <div id="av2-geo-subbody" aria-live="polite">${bodyHtml}</div>
    <div id="av2-geo-drawer"></div>
  `;
  if (av2GeoDrawerData) _av2GeoRenderDrawer();
}

function _av2GeoAreaRows(areas, cols) {
  if (!areas || !areas.length) return `<div style="color:var(--text-secondary,#64748b);font-size:.85rem;padding:8px 0">目前沒有符合篩選條件的資料</div>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
    <thead><tr style="text-align:left;color:var(--text-secondary,#64748b)">${cols.map((c) => `<th style="padding:6px 8px">${escHtml(c[1])}</th>`).join('')}</tr></thead>
    <tbody>${areas.map((a, i) => `<tr class="db-v3-hover" style="cursor:pointer" onclick="av2GeoOpenDrawer(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();av2GeoOpenDrawer(${i})}" tabindex="0" role="button" aria-label="展開 ${escHtml(a.district || a.city || '區域')} 詳細資料">
      ${cols.map((c) => `<td style="padding:6px 8px;border-top:1px solid var(--border,#2a2d3e)">${escHtml(_geoFmtVal(a[c[0]]))}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table>`;
}
function _geoFmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && v > 0 && v < 1) return Math.round(v * 10000) / 100 + '%';
  return String(v);
}

function _av2GeoRenderSubTab(tab, data) {
  if (tab === 'overview') {
    const vg = data.visitor_geo || {}, fg = data.fulfillment_geo || {};
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:14px">
      ${_card('已辨識訪客', vg.identified_visitors ?? 0, `未知 ${vg.unknown_visitors ?? 0}`, '#10b981')}
      ${_card('已辨識率', _geoFmtVal(vg.identified_rate), '', null)}
      ${_card('有履約 Geo 訂單', fg.orders_with_geo ?? 0, `無 ${fg.orders_without_geo ?? 0}`, '#818cf8')}
      ${_card('平均距離/外送費', `${fg.average_distance_km ?? 0}km / NT$${fg.average_delivery_fee ?? 0}`, '', null)}
    </div>
    <div style="font-weight:700;margin-bottom:6px">高意願區域</div>
    ${_av2GeoAreaRows(data.top_areas, [['city', '城市'], ['district', '行政區'], ['visitors', '訪客數']])}`;
  }
  if (tab === 'funnel') {
    return _av2GeoAreaRows(data.areas, [
      ['city', '城市'], ['district', '行政區'], ['visitors', '訪客'], ['view_product_visitors', '瀏覽'],
      ['add_to_cart_visitors', '加購'], ['begin_checkout_visitors', '結帳'], ['submitted_order_visitors', '送出訂單'],
      ['purchase_visitors', '完成付款'], ['visit_to_order_rate', '進站→送單率'],
    ]) + _av2GeoPagination(data);
  }
  if (tab === 'fulfillment') {
    return _av2GeoAreaRows(data.areas, [
      ['city', '城市'], ['district', '行政區'], ['submitted_orders', '訂單數'], ['completed_orders', '完成付款'],
      ['revenue', '營業額'], ['average_order_value', '客單價'], ['average_distance_km', '平均距離'],
      ['average_delivery_fee', '平均外送費'], ['out_of_range_attempts', '超距離嘗試'],
    ]) + `<div style="margin-top:8px;font-size:.78rem;color:var(--text-secondary,#64748b)">自取／無履約地址：${data.takeout_no_fulfillment_address ?? 0} 筆</div>` + _av2GeoPagination(data);
  }
  if (tab === 'distance') {
    return _av2GeoAreaRows(data.bands, [
      ['band', '距離帶'], ['submitted_orders', '訂單數'], ['completed_orders', '完成付款'],
      ['conversion_rate', '轉換率'], ['average_delivery_fee', '平均外送費'], ['revenue', '營業額'],
    ]) + `<div style="margin-top:8px">${geoComingSoonBadge('距離帶商家自訂')}</div>`;
  }
  if (tab === 'source-area') {
    return _av2GeoAreaRows(data.rows, [
      ['source', 'Source'], ['medium', 'Medium'], ['campaign', 'Campaign'], ['channel', 'Channel'],
      ['city', '城市'], ['district', '行政區'], ['visitors', '訪客'], ['conversion_rate', '轉換率'],
    ]) + _av2GeoPagination(data);
  }
  if (tab === 'quality') {
    // fix18-10-hotfix30-B5-R5.1-D1（十九、Geo Quality Diagnostics）：改成
    // 使用者可理解文案，而不是只顯示 status:'degraded' 這種工程師字眼。
    // data.visitor_ip_geo_status_label / data.provider 由後端
    // routes/analytics-geo.js 的 /quality handler 疊加，向後相容——舊版後端
    // 沒有這兩個欄位時，這裡安全地不顯示該區塊，不影響既有畫面。
    const providerBlock = data.visitor_ip_geo_status_label ? `
    <div style="margin:10px 0;padding:10px 12px;border:1px solid var(--border-color,#e2e8f0);border-radius:8px;font-size:.85rem">
      <div style="font-weight:700;margin-bottom:4px">${escHtml(data.visitor_ip_geo_status_label)}</div>
      ${data.provider ? `<div style="color:var(--text-secondary,#64748b)">Cache Hit ${data.provider.cache_hits ?? 0} / Miss ${data.provider.cache_misses ?? 0}　最近成功：${data.provider.last_success_at ? escHtml(data.provider.last_success_at) : '—'}　最近錯誤：${data.provider.last_error_code ? escHtml(data.provider.last_error_code) : '—'}</div>` : ''}
    </div>` : '';
    return `<div style="margin-bottom:10px">狀態：${geoQualityBadge(data.status)}</div>
    ${providerBlock}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
      ${_card('High', data.high_count ?? 0, _geoFmtVal(data.high_rate), '#10b981')}
      ${_card('Medium', data.medium_count ?? 0, _geoFmtVal(data.medium_rate), '#f59e0b')}
      ${_card('Low', data.low_count ?? 0, _geoFmtVal(data.low_rate), '#fb923c')}
      ${_card('Unknown', data.unknown_confidence_count ?? 0, _geoFmtVal(data.unknown_rate), '#ef4444')}
    </div>`;
  }
  return '';
}

function _av2GeoPagination(data) {
  if (!data || !('page' in data)) return '';
  const page = data.page || 1;
  const totalPages = data.total_pages || (data.total ? Math.ceil(data.total / (data.limit || 50)) : null);
  return `<div style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:.8rem">
    <button type="button" onclick="av2GeoSetPage(${page - 1})" ${page <= 1 ? 'disabled' : ''} style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer">上一頁</button>
    <span>第 ${page} 頁${totalPages ? ' / 共 ' + totalPages + ' 頁' : ''}</span>
    <button type="button" onclick="av2GeoSetPage(${page + 1})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer">下一頁</button>
  </div>`;
}

// Stage 4：Focus management —— 開啟時記住觸發元素，把 focus 移進 drawer；
// 關閉時把 focus 還給原本觸發的元素（若該元素已經不在 DOM 上，安全跳過，
// 不拋錯）。只用一個模組層級變數記錄，不額外掛 listener，不會造成洩漏。
let _av2GeoLastFocusedEl = null;
function av2GeoOpenDrawer(rowIndex) {
  const data = av2GeoCache[av2GeoSubTab];
  const list = data && (data.areas || data.rows || data.bands || data.top_areas);
  if (!list || !list[rowIndex]) return;
  _av2GeoLastFocusedEl = document.activeElement || null;
  av2GeoDrawerData = list[rowIndex];
  _av2GeoRenderDrawer();
  _av2GeoEnsureEscListener();
  const closeBtn = document.querySelector('.geo-drawer button[aria-label="關閉"]');
  if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
}
function av2GeoCloseDrawer() {
  av2GeoDrawerData = null;
  const el = document.getElementById('av2-geo-drawer');
  if (el) el.innerHTML = '';
  if (_av2GeoLastFocusedEl && document.contains(_av2GeoLastFocusedEl) && typeof _av2GeoLastFocusedEl.focus === 'function') {
    _av2GeoLastFocusedEl.focus();
  }
  _av2GeoLastFocusedEl = null;
}
// 記憶體/監聽器守則（Stage 6）：ESC 關閉 drawer 的全域 keydown listener 只
// 註冊「一次」，用模組層級旗標防止每次開啟 drawer 都疊加一個新的
// listener——不然開關 100 次就會有 100 個 listener 同時觸發。
let _av2GeoEscListenerBound = false;
function _av2GeoEscListener(e) {
  if (e.key === 'Escape' && av2GeoDrawerData) av2GeoCloseDrawer();
}
function _av2GeoEnsureEscListener() {
  if (_av2GeoEscListenerBound) return;
  _av2GeoEscListenerBound = true;
  document.addEventListener('keydown', _av2GeoEscListener);
}
function _av2GeoRenderDrawer() {
  const el = document.getElementById('av2-geo-drawer');
  if (!el) return;
  const d = av2GeoDrawerData;
  if (!d) { el.innerHTML = ''; return; }
  const label = d.district || d.city || d.band || d.source || '詳細資料';
  const steps = [
    ['Visitor', d.visitors], ['Product', d.view_product_visitors], ['Cart', d.add_to_cart_visitors ?? d.add_to_cart],
    ['Order', d.submitted_order_visitors ?? d.submitted_orders], ['Revenue', d.revenue],
  ].filter(([, v]) => v !== undefined);
  el.innerHTML = `<div class="geo-drawer-overlay" onclick="av2GeoCloseDrawer()"></div>
    <div class="geo-drawer" role="dialog" aria-modal="true" aria-label="${escHtml(label)} 詳細資料" onclick="event.stopPropagation()">
      <button type="button" onclick="av2GeoCloseDrawer()" aria-label="關閉" style="float:right;background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1rem">✕</button>
      <h4 style="margin:0 0 12px">${escHtml(label)}</h4>
      ${steps.map(([k, v], i) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="min-width:70px;color:var(--text-secondary,#64748b);font-size:.8rem">${k}</span>
        <strong>${escHtml(_geoFmtVal(v))}</strong>
        ${i < steps.length - 1 ? '<span style="color:var(--text-secondary,#64748b)">↓</span>' : ''}
      </div>`).join('')}
    </div>`;
}

function _av2RenderGeoTab() {
  return `
    <div id="av2-geo-body">${geoSkeleton(6)}</div>
    <div style="margin-top:20px">
      <h4 style="margin:0 0 10px">🔔 Geo Alerts Center</h4>
      <div id="av2-geo-alerts-body" aria-live="polite">${geoSkeleton(3)}</div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// 十、Geo Alerts Center
// ════════════════════════════════════════════════════════════════
let av2GeoAlertsLoaded = false;
let av2GeoAlertsCache = null;
function _av2GeoAlertsStorageKey() {
  const storeId = (typeof currentStore !== 'undefined' && currentStore && currentStore.store_id) || 'default';
  return `geo_alerts_state_${storeId}`;
}
function _av2GeoAlertsLoadState() {
  try { return JSON.parse(localStorage.getItem(_av2GeoAlertsStorageKey()) || '{}'); } catch (e) { return {}; }
}
function _av2GeoAlertsSaveState(state) {
  try { localStorage.setItem(_av2GeoAlertsStorageKey(), JSON.stringify(state)); } catch (e) { /* storage 不可用時安靜失敗 */ }
}
function av2GeoAlertSetStatus(alertKey, status) {
  const state = _av2GeoAlertsLoadState();
  state[alertKey] = status;
  _av2GeoAlertsSaveState(state);
  _av2GeoRenderAlerts();
}
function _av2GeoAlertKey(a, i) { return `${a.type}:${a.city || ''}:${a.district || ''}:${i}`; }

async function av2GeoAlertsEnsureLoaded() {
  if (av2GeoAlertsLoaded) return;
  av2GeoAlertsLoaded = true;
  try {
    const params = _av2GeoBuildParams();
    const res = await apiFetch(`/api/analytics/geo/alerts?${params.toString()}`);
    const json = res && (await res.json());
    av2GeoAlertsCache = (json && json.success) ? json.data : { alerts: [], __error: (json && json.error) || '載入失敗' };
  } catch (e) {
    av2GeoAlertsCache = { alerts: [], __error: e.message };
  }
  _av2GeoRenderAlerts();
}
function _av2GeoRenderAlerts() {
  const el = document.getElementById('av2-geo-alerts-body');
  if (!el) return;
  const data = av2GeoAlertsCache;
  if (!data) { el.innerHTML = geoSkeleton(4); return; }
  if (data.__error) { el.innerHTML = `<div class="analytics-empty-state" role="alert"><p>${escHtml(data.__error)}</p></div>`; return; }
  const state = _av2GeoAlertsLoadState();
  const withSeverity = (data.alerts || []).map((a, i) => ({ ...a, __severity: geoClassifyAlertSeverity(a), __key: _av2GeoAlertKey(a, i) }));
  const sorted = withSeverity.slice().sort((a, b) => GEO_SEVERITY_ORDER[a.__severity] - GEO_SEVERITY_ORDER[b.__severity]);
  el.innerHTML = sorted.length ? sorted.map((a) => {
    const st = state[a.__key] || 'open';
    return `<div class="db-v3-hover" style="padding:10px 12px;border:1px solid var(--border,#2a2d3e);border-radius:10px;margin-bottom:8px;opacity:${st === 'ignored' ? '.5' : '1'}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>${GEO_SEVERITY_LABEL[a.__severity]} · ${escHtml(a.city || '')}${escHtml(a.district || '')}</span>
        <span style="font-size:.75rem;color:var(--text-secondary,#64748b)">${st === 'processed' ? '✅ 已處理' : st === 'starred' ? '⭐ 已收藏' : st === 'ignored' ? '🙈 已忽略' : ''}</span>
      </div>
      <div style="font-size:.85rem;margin:6px 0">${escHtml(a.message)}</div>
      <div style="font-size:.8rem;color:var(--text-secondary,#64748b)">建議：${escHtml(a.suggestion)}</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button type="button" onclick="av2GeoAlertSetStatus('${a.__key}','processed')" style="font-size:.75rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">已處理</button>
        <button type="button" onclick="av2GeoAlertSetStatus('${a.__key}','ignored')" style="font-size:.75rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">忽略</button>
        <button type="button" onclick="av2GeoAlertSetStatus('${a.__key}','starred')" style="font-size:.75rem;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer">收藏</button>
      </div>
    </div>`;
  }).join('') : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有觸發任何警示</div>`;
}

// 可攜性：本檔案在瀏覽器透過 <script> 標籤載入（無模組系統），但測試腳本
// （scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js）需要能在 Node.js 用
// require() 直接載入 Business Rule Engine 做純函式單元測試，不必透過 jsdom
// 也能測。瀏覽器環境沒有全域 `module`，這裡安全地做特徵判斷，不影響瀏覽器
// 執行（純函式本身也同時掛在 window 上，供 DOM 渲染函式使用）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    geoConfidenceFromSample, geoComputeOpportunities, geoComputeAdRoi, geoComputeCouponSuggestions,
    geoComputeDeliveryFeeOptimization, geoComputeExpansionRanking, geoComputeTodayInsight,
    geoClassifyAlertSeverity, geoComputeRecommendedActions, GEO_SEVERITY_ORDER, GEO_SEVERITY_LABEL,
    // fix18-10-hotfix30-B5-R5.2-B1-1
    GEO_DASHBOARD_PARAM_KEYS, _buildGeoDashboardParams, _sumFunnelAreas, _geoRate,
    computeGeoDashboardKpi, computeGeoTopAreas, renderGeoQualityBlock,
    // fix18-10-hotfix30-B5-R5.2-B1-2
    GEO_RANKING_PAGE_SIZE, _geoAreaKey, _geoAreaLabel, _geoIsUnknownArea,
    _geoSortAreas, _geoFilterAreasBySearch, computeGeoAreaRanking,
  };
}
