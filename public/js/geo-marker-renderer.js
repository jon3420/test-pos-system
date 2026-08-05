// public/js/geo-marker-renderer.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1
// Geo Marker Rendering Unification — 單一共用 Marker Renderer。
//
// 目的：專案裡「畫訪客/訂單 Marker」的邏輯過去分散在 geo-live-layer.js
// （Dashboard 即時訪客 Marker，只認得真實 lat/lng）與
// geo-heatmap.js（Order Heatmap，使用縣市/行政區中心點 lat/lng）——兩處各自
// 決定 icon／tooltip／要不要畫。本檔案抽出一個共用、資料格式明確的
// Renderer，供 Dashboard（geo-live-layer.js）與 Visitor Layer
// （geo-visitor-layer.js）共同呼叫，統一四種精確度狀態的畫法與文案規則。
//
// 邊界（不得違反）：
//   1. 本檔案完全不負責「怎麼算出座標」——不查 Provider、不算 centroid、
//      不打任何 API。呼叫端把已經算好的點（exact lat/lng，或縣市/行政區
//      中心點 lat/lng）連同 accuracy 標籤傳進來，本檔案只負責畫。
//   2. accuracy === 'unknown' 的點一律不建立 Marker（見
//      geoMarkerBuildPoints() 的 filter），不得為了「畫出東西」而用任何
//      預設座標（店家座標／地圖中心／隨機座標）頂替。
//   3. 'district_centroid'／'county_centroid' 的 tooltip 一律要清楚標示
//      「推估，非實際位置」，不得出現 GPS／即時定位／精確位置／實際地址
//      這類語彙（那些字眼只保留給 'exact' 狀態，且 'exact' 狀態的文案
//      沿用呼叫端既有邏輯，本檔案不改寫）。
//   4. 同一個 district_centroid／county_centroid（用 area_key 判斷）多筆
//      合併成一個 Marker，數量加總顯示，不得畫出重複 Marker。
//   5. 重用既有 Leaflet map（呼叫端傳入 mapInstance），本檔案不建立
//      L.map()／Tile Layer，也不 destroy 既有 map。

'use strict';

const GEO_MARKER_ACCURACY_STATES = Object.freeze([
  'exact', 'district_centroid', 'county_centroid', 'unknown',
]);

function isValidMarkerAccuracy(accuracy) {
  return GEO_MARKER_ACCURACY_STATES.includes(accuracy);
}

// GEO_MARKER_FORBIDDEN_WORDS — centroid 類 tooltip 不得出現的字眼（需求
// 文件十二）。exact 類 tooltip 由呼叫端自己的既有邏輯負責，不受這份表約束
// （見 geoMarkerBuildTooltip() 只對 centroid 狀態套用這個檢查）。
const GEO_MARKER_FORBIDDEN_CENTROID_WORDS = Object.freeze([
  'GPS', '即時定位', '精確位置', '實際地址',
]);

// geoMarkerBuildPoints(rawPoints) → 過濾＋正規化＋（僅 centroid 類）去重聚合。
//   rawPoints：陣列，每筆至少有：
//     { accuracy, lat, lng, area_key, label, count, meta }
//   accuracy='unknown' 或缺少合法 lat/lng 的 centroid/exact 點會被過濾掉
//   （不畫、不報錯，安全跳過）。'exact' 點不做去重聚合（每個 exact 點各自
//   代表一個真實訪客/訂單事件，語意上不能合併）；'district_centroid'／
//   'county_centroid' 點用 area_key 聚合，count 加總。
function geoMarkerBuildPoints(rawPoints) {
  const list = Array.isArray(rawPoints) ? rawPoints : [];
  const exactPoints = [];
  const centroidMap = new Map(); // area_key -> aggregated point

  list.forEach((p) => {
    if (!p || !isValidMarkerAccuracy(p.accuracy) || p.accuracy === 'unknown') return; // 不猜、不畫
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return; // 沒有合法座標，安全跳過，不用預設座標頂替

    if (p.accuracy === 'exact') {
      exactPoints.push({ ...p, lat, lng, count: Number.isFinite(Number(p.count)) ? Number(p.count) : 1 });
      return;
    }

    // district_centroid／county_centroid：用 area_key 聚合（沒有 area_key
    // 就退回用 "accuracy|lat|lng" 當 key，避免同一個中心點意外重複建立
    // Marker）。
    const key = p.area_key || `${p.accuracy}|${lat}|${lng}`;
    const existing = centroidMap.get(key);
    const count = Number.isFinite(Number(p.count)) ? Number(p.count) : 1;
    if (existing) {
      existing.count += count;
    } else {
      centroidMap.set(key, { ...p, lat, lng, count });
    }
  });

  return exactPoints.concat(Array.from(centroidMap.values()));
}

// geoMarkerEscapeHtml(value) — Renderer 內建的 HTML escape（需求文件八：
// 共用 Renderer 不應依賴每一個未來呼叫端都正確 escape）。至少處理
// & < > " '，跟專案其餘既有 escape 慣例（例如 geo-ga4-realtime-layer.js
// 的 _geoGa4Esc()）行為一致，不使用 innerHTML 以外的插入方式。
function geoMarkerEscapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// geoMarkerBuildTooltip(point) → HTML 字串。fix18-10-hotfix30-B5-R5.4-
// G1.6-A1.1：label／count／tooltip 動態值一律先經過 geoMarkerEscapeHtml()，
// 不再假設呼叫端已經處理過（見需求文件八）。也不得顯示完整 visitor_id／
// 完整地址／IP／Token／LIFF ID——本函式本身只讀 label／count／tooltip 三個
// 欄位，呼叫端如果誤塞這些敏感值進 label，escape 只防 XSS，不做內容過濾，
// 敏感欄位的過濾責任仍在呼叫端組 point 物件時就不要放進去（見
// geo-visitor-layer.js／geo-live-layer.js 的既有 Tooltip 慣例：只用
// visitor_key 這種已遮罩過的安全值，不用 visitor_id/session_id 原始值）。
function geoMarkerBuildTooltip(point) {
  const p = point || {};
  const safeLabel = geoMarkerEscapeHtml(p.label);
  const safeCount = geoMarkerEscapeHtml(p.count);
  if (p.accuracy === 'district_centroid') {
    return `<strong>${safeLabel || '未知行政區'}</strong><br/>行政區推估，非實際位置`
      + (Number(p.count) > 1 ? `<br/>共 ${safeCount} 筆` : '');
  }
  if (p.accuracy === 'county_centroid') {
    return `<strong>${safeLabel || '未知縣市'}</strong><br/>縣市級推估，非實際位置`
      + (Number(p.count) > 1 ? `<br/>共 ${safeCount} 筆` : '');
  }
  // 'exact'：呼叫端可傳入 buildTooltip 覆寫（見 geoMarkerRenderGroup 的
  // opts.buildExactTooltip），這裡只提供一個安全預設值（同樣先 escape），
  // 不假裝知道 Dashboard/訂單那些欄位的既有格式。
  return geoMarkerEscapeHtml(p.tooltip || p.label || '');
}

// geoMarkerIconClassFor(accuracy) — 四態視覺區分用的 CSS class 命名慣例
// （需求文件七）：
//   exact              → 實心 Marker（沿用呼叫端既有事件顏色／實線）
//   district_centroid  → 空心／半透明、虛線外框
//   county_centroid    → 比 district 更低透明度、不同 class
//   unknown            → 不會走到這裡（geoMarkerBuildPoints 已過濾掉）
function geoMarkerIconClassFor(accuracy) {
  return `geo-marker-accuracy-${accuracy}`;
}

// geoMarkerBuildLegendHtml() — 需求文件二：Legend 必須出現在使用 Marker
// 的 Dashboard／Visitor Layer，不能只存在程式常數中。回傳純 HTML 字串，
// 呼叫端負責插入實際 DOM（跟本專案既有 buildSummaryCard()／
// buildCoveragePanel() 等 pure HTML builder 慣例一致）。所有文字都是固定
// 常數（沒有動態值），但仍走 geoMarkerEscapeHtml() 一次，避免未來有人
// 誤改成動態內容時忘記加 escape。
function geoMarkerBuildLegendHtml() {
  const items = [
    ['●', '精確位置'],
    ['◌', '行政區推估'],
    ['▢', '縣市級推估'],
    ['—', 'Unknown 不顯示'],
  ];
  const itemsHtml = items.map(([symbol, text]) => (
    `<span class="geo-marker-legend-item">${geoMarkerEscapeHtml(symbol)} ${geoMarkerEscapeHtml(text)}</span>`
  )).join('');
  return `<div class="geo-marker-legend">${itemsHtml}</div>`;
}

// geoMarkerBuildBlockedNoticeHtml() — 需求文件三：Centroid Source
// Blocker 時的安全說明文案（不得顯示「沒有地區資料」，因為 Summary／
// Ranking 實際上還是有 county／district 統計，只是缺少可驗證的中心點座標
// 可以畫 Marker）。
function geoMarkerBuildBlockedNoticeHtml() {
  return '<div class="geo-marker-blocked-notice">已取得區域統計，但目前缺少可驗證的區域中心資料，因此未顯示推估標註。</div>';
}

// geoMarkerDefaultIcon(point) — 預設 icon：exact 沿用呼叫端既有慣例（見
// opts.buildIcon 覆寫機制，Dashboard 的 exact Marker 走既有
// resolveMarkerStage()／markerColorForStage() 邏輯，不受這裡影響）；
// district_centroid／county_centroid 兩態使用 geoMarkerIconClassFor()
// 產生的 class，搭配 divIcon 呈現空心／半透明樣式差異（實際顏色深淺由
// CSS 檔案定義，這裡只負責掛上正確的 class，不 inline 寫死顏色）。
function geoMarkerDefaultIcon(point) {
  if (typeof L === 'undefined' || typeof L.divIcon !== 'function') return undefined;
  const cls = geoMarkerIconClassFor(point.accuracy);
  const shape = point.accuracy === 'county_centroid' ? '▢' : (point.accuracy === 'district_centroid' ? '◌' : '●');
  return L.divIcon({
    className: `geo-marker-icon ${cls}`,
    html: `<span class="geo-marker-icon-shape">${shape}</span>`,
    iconSize: [18, 18],
  });
}

// geoMarkerRenderGroup(mapInstance, existingGroup, rawPoints, opts) →
// { group, drawn, skipped }
//   - existingGroup：呼叫端已建立的 L.layerGroup()（或 null／undefined，
//     這裡會建立一個新的並回傳，呼叫端負責存起來供下次呼叫沿用——見需求
//     文件十二「Layer Cleanup 完整」：本函式每次呼叫都先 clearLayers()，
//     不會疊加舊 Marker）。
//   - opts.buildTooltip(point) 可覆寫預設 tooltip（例如 Dashboard 的
//     exact 狀態需要 visitor/last_event/channel/device 等既有欄位格式，
//     見 geo-live-layer.js 既有的 buildMarkerTooltipFields()）。
//   - opts.buildIcon(point) 可覆寫預設 icon（例如沿用 Dashboard 既有的
//     stage 顏色／divIcon 慣例）。
function geoMarkerRenderGroup(mapInstance, existingGroup, rawPoints, opts = {}) {
  if (typeof L === 'undefined' || typeof L.layerGroup !== 'function') {
    return { group: existingGroup || null, drawn: 0, skipped: (rawPoints || []).length };
  }
  const group = existingGroup && typeof existingGroup.clearLayers === 'function'
    ? existingGroup
    : L.layerGroup();
  if (typeof group.clearLayers === 'function') group.clearLayers();
  if (mapInstance && typeof group.addTo === 'function' && (!existingGroup || existingGroup !== group)) {
    group.addTo(mapInstance);
  }

  const points = geoMarkerBuildPoints(rawPoints);
  const buildTooltip = typeof opts.buildTooltip === 'function' ? opts.buildTooltip : geoMarkerBuildTooltip;
  const buildIcon = typeof opts.buildIcon === 'function' ? opts.buildIcon : geoMarkerDefaultIcon;

  let drawn = 0;
  points.forEach((p) => {
    try {
      const markerOpts = buildIcon ? { icon: buildIcon(p) } : {};
      const marker = L.marker([p.lat, p.lng], markerOpts);
      if (typeof marker.bindTooltip === 'function') marker.bindTooltip(buildTooltip(p));
      group.addLayer(marker);
      drawn += 1;
    } catch (e) { /* 單一點失敗不影響其餘點繪製 */ }
  });

  return { group, drawn, skipped: (Array.isArray(rawPoints) ? rawPoints.length : 0) - drawn };
}

// geoMarkerClearGroup(group) — Layer Cleanup：離開頁面/切換 Layer 時呼叫，
// 把整個 group 從地圖上移除並清空（不留殘留 Marker，也不需要另外一套
// save/restore-style machinery——跟本專案既有 GA4/Visitor Layer 的
// clearLayers 慣例一致）。
function geoMarkerClearGroup(group) {
  if (!group) return;
  if (typeof group.clearLayers === 'function') group.clearLayers();
}

// _geoMarkerValidateNoForbiddenWords(point) — 內部／測試用：確認某個
// centroid 點的 tooltip 沒有出現禁止字眼（見需求文件十二）。
function _geoMarkerTooltipHasForbiddenWords(html) {
  return GEO_MARKER_FORBIDDEN_CENTROID_WORDS.some((w) => String(html || '').includes(w));
}

// fix18-10-hotfix30-B5-R5.4-G1.6-A1.1：明確 Browser Namespace（需求文件
// 三）——不依賴 classic script 把 function declaration 隱性掛到 window 的
//行為，呼叫端（geo-visitor-layer.js／geo-live-layer.js）一律優先透過
// window.GeoMarkerRenderer.xxx 呼叫；為了向下相容既有已經寫好的裸函式呼叫
// （例如既有測試／未來其他呼叫端可能還是直接呼叫 geoMarkerRenderGroup()），
// 這裡兩種寫法並存，不是互斥的兩套實作——同一份函式，只是多一個明確掛載
// 的物件別名。
if (typeof window !== 'undefined') {
  window.GeoMarkerRenderer = {
    ACCURACY_STATES: GEO_MARKER_ACCURACY_STATES,
    FORBIDDEN_CENTROID_WORDS: GEO_MARKER_FORBIDDEN_CENTROID_WORDS,
    isValidAccuracy: isValidMarkerAccuracy,
    buildPoints: geoMarkerBuildPoints,
    buildTooltip: geoMarkerBuildTooltip,
    escapeHtml: geoMarkerEscapeHtml,
    iconClassFor: geoMarkerIconClassFor,
    defaultIcon: geoMarkerDefaultIcon,
    buildLegendHtml: geoMarkerBuildLegendHtml,
    buildBlockedNoticeHtml: geoMarkerBuildBlockedNoticeHtml,
    renderGroup: geoMarkerRenderGroup,
    clearGroup: geoMarkerClearGroup,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_MARKER_ACCURACY_STATES,
    GEO_MARKER_FORBIDDEN_CENTROID_WORDS,
    isValidMarkerAccuracy,
    geoMarkerBuildPoints,
    geoMarkerBuildTooltip,
    geoMarkerEscapeHtml,
    geoMarkerIconClassFor,
    geoMarkerDefaultIcon,
    geoMarkerBuildLegendHtml,
    geoMarkerBuildBlockedNoticeHtml,
    geoMarkerRenderGroup,
    geoMarkerClearGroup,
    _geoMarkerTooltipHasForbiddenWords,
  };
}
