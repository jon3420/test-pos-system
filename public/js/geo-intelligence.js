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
// 二、Dashboard 首頁 — Geo Intelligence 區塊
// ════════════════════════════════════════════════════════════════
function renderDashboardGeoIntelligence(data) {
  const summary = data && data.geo_summary;
  if (!summary) return '';
  const disabled = summary.data_quality && summary.data_quality.status === 'disabled';

  const top = (summary.top_intent_areas || [])[0];
  const waste = (summary.high_traffic_low_conversion || [])[0];
  const fs = summary.fulfillment_summary || {};
  const dq = summary.data_quality || {};

  const kpiCards = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px" role="list" aria-label="Geo Intelligence KPI">
    <div role="listitem">${top
      ? _card('🏆 高意願區域', escHtml(top.district || top.city || '—'), `${top.visitors} 訪客・${top.submitted_order_visitors} 訂單`, '#10b981')
      : _card('🏆 高意願區域', '—', disabled ? 'Geo Analytics 未啟用' : '樣本不足', 'var(--text-secondary,#64748b)')}</div>
    <div role="listitem">${waste
      ? _card('⚠ 高流量低轉換', escHtml(waste.district || waste.city || '—'), `流量 ${waste.visitors}・成交 ${waste.submitted_order_visitors ?? 0}`, '#f59e0b')
      : _card('⚠ 高流量低轉換', '—', '目前沒有符合條件的區域', 'var(--text-secondary,#64748b)')}</div>
    <div role="listitem">${_card('🚚 履約分析', fs.orders_with_geo != null ? `${fs.orders_with_geo} 筆` : '—', fs.takeout_no_fulfillment_address != null ? `外帶（無履約地址）${fs.takeout_no_fulfillment_address} 筆` : '', '#818cf8')}</div>
    <div role="listitem">${_card('📡 Geo Quality', geoQualityBadge(dq.status || 'disabled'), dq.unknown_rate != null ? `未知比例 ${Math.round(dq.unknown_rate * 100)}%` : '', null)}</div>
  </div>`;

  const opportunities = geoComputeOpportunities(summary);
  const oppHtml = opportunities.length ? opportunities.map((o) => `
    <div class="db-v3-hover" style="padding:10px 12px;border:1px solid var(--border,#2a2d3e);border-radius:10px;margin-bottom:8px">
      <div>${o.icon} <strong>${escHtml(o.headline)}</strong> <span style="font-size:.7rem;color:var(--text-secondary,#64748b)">(${o.confidence} confidence)</span></div>
      <div style="font-size:.82rem;color:var(--text-secondary,#64748b);margin-top:2px">建議：${escHtml(o.suggestion)}</div>
    </div>`).join('') : `<div style="color:var(--text-secondary,#64748b);font-size:.85rem">目前沒有足夠資料產生商機建議</div>`;

  const lazyId = 'geo-intel-lazy-' + Date.now();
  const raId = 'geo-ra-' + Date.now();
  const partialActions = geoComputeRecommendedActions({ summary, quality: dq });
  const html = _section('🌍 Geo Intelligence', `
    ${kpiCards}
    <div style="margin-bottom:6px;font-weight:700;font-size:.9rem">💡 今日商機（Business Opportunity，規則式計算，非 AI）</div>
    ${oppHtml}
    <div id="${raId}" aria-live="polite" data-geo-ra-disabled="${disabled ? '1' : ''}">${_renderRecommendedActionsBlock(partialActions, summary)}</div>
    <div id="${lazyId}" aria-live="polite">${geoSkeleton(4)}</div>
  `);
  setTimeout(() => _geoIntelLazyLoad(lazyId, raId, summary), 0);
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
  };
}
