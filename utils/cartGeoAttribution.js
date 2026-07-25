// utils/cartGeoAttribution.js — fix18-10-hotfix30-B5-R5.1-D1
// Cart Geo Attribution × Geo Conversion Table × Source × Geo
//
// 設計原則（見需求文件十三：「不要建立第二套去重規則」）：完全重用
// utils/cartSnapshot.js 已經驗證過的批次查詢與列組裝邏輯
// （getPurchasedCartIdSet / getLatestSnapshotMap / getFirstAddToCartMap /
// getFirstTouchMap / getLastEventMap / getLegacyCartItemsMap /
// getProductsInfoMap / getMemberDisplayNameMap / buildRowFromCandidate ——
// 這正是 utils/drilldown.js 已經在用的同一組 building blocks），本檔案只多做
// 兩件事：
//   1. 把「最早有效 Visitor Geo」併進每一列（進站/購物車來源區域，不是履約
//      地址——見需求文件十三：「不要誤用外送地址當成廣告來源區域」）。
//   2. 用 identity_key（既有 Identity Resolver 的輸出，見
//      utils/analyticsIdentity.js）去重後，依區域彙總成排行榜／交叉表／摘要。
//
// Visitor identity 去重規則沿用專案既有慣例：同一 identity_key 不論產生了
// 幾筆 add_to_cart 事件或幾個 cart_id，聚合層一律只算 1 人（cart_count 仍可
// 大於 visitor_count，因為同一人可能有多個購物車）。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
const {
  getPurchasedCartIdSet, getLatestSnapshotMap, getFirstAddToCartMap, getFirstTouchMap,
  getLastEventMap, getLegacyCartItemsMap, getProductsInfoMap, getMemberDisplayNameMap,
  buildRowFromCandidate, round2,
} = require('./cartSnapshot');

// 候選 cart_id 集合的硬上限，避免單次撈出整店全部歷史事件（沿用
// utils/drilldown.js 同一個防禦性慣例，數值上限相同）。
const MAX_CANDIDATE_CARTS = 5000;

function _inParams(arr) { return arr.map(() => '?').join(','); }

// 前端文案轉換（需求文件十四：技術 context/provider 名稱不得直接顯示給一般
// 老闆看，一律轉成中文文案；不知道就顯示「無法辨識」/「—」，不得留白造成
// 誤解）。
const GEO_CONTEXT_LABELS = Object.freeze({
  visitor: 'IP 推估',
  fulfillment: '外送地址',
  shipping: '宅配地址',
  gps: 'GPS 授權',
  unknown: '無法辨識',
});
// 即使 Provider/DB 裡的 geo_accuracy 是 'district'，語意上仍只承諾 city 等級
// 的可信範圍（見需求文件十三、geoResolver.js 對應註解），文案統一顯示「約略城市」。
const GEO_ACCURACY_LABELS = Object.freeze({
  country: '國家等級',
  region: '縣市等級',
  city: '約略城市',
  district: '約略城市',
  unknown: '—',
});

function geoContextLabel(ctx) { return GEO_CONTEXT_LABELS[ctx] || GEO_CONTEXT_LABELS.unknown; }
function geoAccuracyLabel(acc) { return GEO_ACCURACY_LABELS[acc] || GEO_ACCURACY_LABELS.unknown; }

// 找出符合篩選條件（時間範圍／channel／source／campaign）的候選購物車，
// 回傳形狀跟 utils/cartSnapshot.js 內部 getCartsCandidateIds() 一致
// （{cart_id, last_activity_local, first_seen_local}），可直接餵給
// buildRowFromCandidate()。
function _candidateCarts(db, storeId, filters) {
  const { range, channel, source, campaign } = filters;
  let sql = `SELECT cart_id, MAX(${A_LOCAL}) as last_activity_local, MIN(${A_LOCAL}) as first_seen_local
             FROM analytics_events
             WHERE store_id=? AND cart_id IS NOT NULL AND cart_id != '' AND ${A_LOCAL} BETWEEN ? AND ?`;
  const params = [storeId, range.startLocal, range.endLocal];
  if (channel) { sql += ' AND order_channel=?'; params.push(channel); }
  if (source) { sql += ' AND source=?'; params.push(source); }
  if (campaign) { sql += ' AND campaign=?'; params.push(campaign); }
  sql += ' GROUP BY cart_id LIMIT ?';
  params.push(MAX_CANDIDATE_CARTS + 1); // +1 只為了偵測是否被截斷，不影響實際回傳筆數上限
  return db.all(sql, params);
}

// 每個 cart_id 的「最早有效 Visitor Geo」（見需求文件十三：分析「進站來源
// 區域」用最早有效 visitor geo，不是最新一筆，也不是 fulfillment/shipping）。
// 只挑 geo_context='visitor' 的事件，履約/宅配/GPS 一律不在這裡出現
// （它們屬於訂單履約分析，見既有 utils/geoAnalyticsQueries.js getGeoFulfillment）。
function getCartVisitorGeoMap(db, storeId, cartIds) {
  const map = {};
  if (!cartIds.length) return map;
  const rows = db.all(
    `SELECT cart_id, geo_city, geo_district, geo_context, geo_accuracy, geo_provider, geo_confidence, id
     FROM analytics_events
     WHERE store_id=? AND cart_id IN (${_inParams(cartIds)}) AND geo_context='visitor'
     ORDER BY id ASC`,
    [storeId, ...cartIds]
  );
  rows.forEach((r) => { if (!map[r.cart_id]) map[r.cart_id] = r; }); // 第一筆（id 最小）＝最早
  return map;
}

function _geoLabelFor(geoRow) {
  if (!geoRow) return { geo_city: null, geo_district: null, geo_area_label: '未知' };
  const label = geoRow.geo_district || geoRow.geo_city || '未知';
  return { geo_city: geoRow.geo_city || null, geo_district: geoRow.geo_district || null, geo_area_label: label };
}

// 建立「已套用 Visitor Geo」的購物車列（供 Cart Abandonment API 附加 geo 欄位、
// 也供下面的彙總函式共用同一份資料，不重複查詢兩次）。
// includePurchased=true：本函式同時服務「未完成購物車清單＋geo」與「彙總／
// 轉換率」兩種用途，後者需要看到已成交的人才能算出轉換率與完成訂單數；
// routes 層若只要「未完成」列表，可自行用 row.status !== 'purchased' 篩掉。
function buildCartRowsWithGeo(db, storeId, filters) {
  const candidates = _candidateCarts(db, storeId, filters);
  const truncated = candidates.length > MAX_CANDIDATE_CARTS;
  const limitedCandidates = truncated ? candidates.slice(0, MAX_CANDIDATE_CARTS) : candidates;
  const cartIds = limitedCandidates.map((c) => c.cart_id);
  if (!cartIds.length) return { rows: [], firstTouchMap: {}, truncated: false };

  const purchasedSet = getPurchasedCartIdSet(db, storeId, cartIds);
  const snapshotMap = getLatestSnapshotMap(db, storeId, cartIds);
  const firstAddMap = getFirstAddToCartMap(db, storeId, cartIds);
  const firstTouchMap = getFirstTouchMap(db, storeId, cartIds);
  const lastEventMap = getLastEventMap(db, storeId, cartIds);
  const cartIdsNeedingLegacy = cartIds.filter((id) => !snapshotMap[id]);
  const legacyItemsMap = getLegacyCartItemsMap(db, storeId, cartIdsNeedingLegacy);
  const legacyProductIds = [...new Set(Object.values(legacyItemsMap).flat().map((i) => i.product_id))];
  const productsInfoMap = getProductsInfoMap(db, storeId, legacyProductIds);
  const lineUserIds = [...new Set(
    Object.values(firstTouchMap)
      .filter((r) => r.identity_type === 'line_user_id')
      .map((r) => (r.identity_key || '').replace('line_user:', ''))
  )];
  const memberNameMap = getMemberDisplayNameMap(db, storeId, lineUserIds);
  const geoMap = getCartVisitorGeoMap(db, storeId, cartIds);

  const ctx = { purchasedSet, snapshotMap, firstAddMap, firstTouchMap, lastEventMap, legacyItemsMap, productsInfoMap, memberNameMap, nowMs: Date.now() };

  const rows = limitedCandidates
    .map((c) => buildRowFromCandidate(c, ctx, { includePurchased: true }))
    .filter(Boolean)
    .map((r) => {
      const geoRow = geoMap[r.cart_id];
      const { geo_city, geo_district, geo_area_label } = _geoLabelFor(geoRow);
      const geoContext = geoRow ? geoRow.geo_context : 'unknown';
      const geoAccuracy = geoRow ? (geoRow.geo_accuracy || 'unknown') : 'unknown';
      const { _age_bucket, _visitor_id_raw, _line_uid_raw, ...pub } = r;
      return {
        ...pub,
        geo_city,
        geo_district,
        geo_area_label,
        geo_context: geoContext,
        geo_context_label: geoContextLabel(geoContext),
        geo_accuracy: geoAccuracy,
        geo_accuracy_label: geoAccuracyLabel(geoAccuracy),
        geo_provider: geoRow ? (geoRow.geo_provider || null) : null,
      };
    });

  // fix18-10-hotfix30-B5-R5.2-A（Stage 6.2：/cart-attribution 支援
  // county_code/subdivision_code 篩選）——在已經合併好 Visitor Geo 的列上
  // 用 resolveTaiwanAdministrativeArea() 現算比對，不用另外查 SQL（候選購物
  // 車數量本來就已經被 MAX_CANDIDATE_CARTS 限制在合理範圍，屬於小結果集後
  // 處理，符合 Stage 6.3「風險最低、容易測試」的選擇）。filters.countyCode/
  // subdivisionCode 已經過 validateAreaFilters() 驗證為資料集內真實代碼。
  let filteredRows = rows;
  if (filters.subdivisionCode) {
    const { resolveTaiwanAdministrativeArea } = require('./taiwanGeoNormalize');
    filteredRows = rows.filter((r) => {
      const resolved = resolveTaiwanAdministrativeArea({ city: r.geo_city, district: r.geo_district });
      return resolved.resolution === 'subdivision' && resolved.subdivision_code === filters.subdivisionCode;
    });
  } else if (filters.countyCode) {
    const { resolveTaiwanAdministrativeArea } = require('./taiwanGeoNormalize');
    filteredRows = rows.filter((r) => {
      const resolved = resolveTaiwanAdministrativeArea({ city: r.geo_city, district: r.geo_district });
      return (resolved.resolution === 'subdivision' || resolved.resolution === 'county') && resolved.county_code === filters.countyCode;
    });
  }

  return { rows: filteredRows, firstTouchMap, truncated };
}

// 依區域彙總「購物車訪客區域排行」／「區域購物車轉換」（需求文件十五、十六）。
// 全部依 identity_key 去重（同一 visitor 多次 add_to_cart／多個 cart_id 只算
// 1 人於 visitors 欄位；cart_count 可以 > visitor_count）。
function buildGeoDistrictRanking(rows, firstTouchMap) {
  const groups = new Map(); // label -> {visitors:Set, carts:Set, checkouts:Set, purchases:Set, cartValue:number}
  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, { visitors: new Set(), carts: new Set(), checkouts: new Set(), purchases: new Set(), cartValue: 0, city: null, district: null });
    return map.get(key);
  };

  rows.forEach((r) => {
    const ft = firstTouchMap[r.cart_id] || {};
    const identityKey = ft.identity_key || `cart:${r.cart_id}`; // fallback：理論上不會發生（每筆事件都會有 identity），保守處理避免拋錯
    const g = ensure(groups, r.geo_area_label);
    g.visitors.add(identityKey);
    g.carts.add(r.cart_id);
    if (r.checkout_attempt_count > 0) g.checkouts.add(identityKey);
    if (r.status === 'purchased') g.purchases.add(identityKey);
    g.cartValue += Number(r.total || 0);
    // fix18-10-hotfix30-B5-R5.2-A（Stage 5：統一行政區格式）——額外記錄
    // city/district，供 routes/analytics-geo.js 的通用 _enrichAreaFields()
    // 補上 county_code/area_key 等統一欄位；純新增欄位，不改變既有去重/
    // 計數邏輯（已被 R5.1-D1 159 項測試驗證過，不重寫那段）。
    if (g.city === null) g.city = r.geo_city || null;
    if (g.district === null) g.district = r.geo_district || null;
  });

  return [...groups.entries()].map(([area, g]) => {
    const cartCount = g.carts.size;
    // 成交率除數為 0 時固定回 0，不得顯示 Infinity/NaN（見需求文件十六）。
    const conversionRate = cartCount > 0 ? round2((g.purchases.size / cartCount) * 100) : 0;
    return {
      area, city: g.city, district: g.district,
      visitors: g.visitors.size,
      add_to_cart: cartCount,
      begin_checkout: g.checkouts.size,
      orders: g.purchases.size,
      abandon: Math.max(0, cartCount - g.purchases.size),
      cart_value: round2(g.cartValue),
      conversion_rate: conversionRate,
    };
  }).sort((a, b) => b.add_to_cart - a.add_to_cart); // 預設排序：加入購物車人數 DESC（需求文件十六）
}

// 來源 × 區域交叉分析（需求文件十七：只做表格，不做 ROI 自動結論）。
function buildSourceAreaTable(rows, firstTouchMap) {
  const groups = new Map(); // `${source}||${area}` -> counts
  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, { visitors: new Set(), carts: new Set(), checkouts: new Set(), purchases: new Set(), city: null, district: null });
    return map.get(key);
  };

  rows.forEach((r) => {
    const ft = firstTouchMap[r.cart_id] || {};
    const identityKey = ft.identity_key || `cart:${r.cart_id}`;
    const key = `${r.source || 'Direct'}||${r.geo_area_label}`;
    const g = ensure(groups, key);
    g.visitors.add(identityKey);
    g.carts.add(r.cart_id);
    if (r.checkout_attempt_count > 0) g.checkouts.add(identityKey);
    if (r.status === 'purchased') g.purchases.add(identityKey);
    if (g.city === null) g.city = r.geo_city || null;
    if (g.district === null) g.district = r.geo_district || null;
  });

  return [...groups.entries()].map(([key, g]) => {
    const [source, area] = key.split('||');
    const cartCount = g.carts.size;
    return {
      source, area, city: g.city, district: g.district,
      visitors: g.visitors.size,
      add_to_cart: cartCount,
      begin_checkout: g.checkouts.size,
      orders: g.purchases.size,
      conversion_rate: cartCount > 0 ? round2((g.purchases.size / cartCount) * 100) : 0,
    };
  }).sort((a, b) => b.add_to_cart - a.add_to_cart);
}

// 「購物車訪客區域」精簡摘要（需求文件十五）。同一 visitor 有多個 cart 時：
// visitor_count = 1、cart_count 可以 > 1（明確符合需求文件十五結尾範例）。
function buildGeoSummary(rows, firstTouchMap) {
  const visitorSet = new Set();
  const checkoutVisitorSet = new Set();
  const purchaseVisitorSet = new Set();
  let abandonCount = 0;
  let cartValue = 0;

  rows.forEach((r) => {
    const ft = firstTouchMap[r.cart_id] || {};
    const identityKey = ft.identity_key || `cart:${r.cart_id}`;
    visitorSet.add(identityKey);
    if (r.checkout_attempt_count > 0) checkoutVisitorSet.add(identityKey);
    if (r.status === 'purchased') purchaseVisitorSet.add(identityKey);
    if (r.status === 'abandoned') abandonCount += 1;
    cartValue += Number(r.total || 0);
  });

  return {
    visitor_count: visitorSet.size,
    cart_count: rows.length,
    begin_checkout_count: checkoutVisitorSet.size,
    purchase_count: purchaseVisitorSet.size,
    abandon_count: abandonCount,
    estimated_cart_value: round2(cartValue),
  };
}

// Top N 區域排行（需求文件十五：Top 5，預設依加入購物車人數 DESC，未知墊底
// 不強制排除，但排序上通常自然落到後面；這裡不特別排序『未知』一定墊底，
// 只依既有排序規則排，若『未知』人數真的很多，如實顯示，不刻意隱藏）。
function topAreas(ranking, n = 5) {
  return ranking.slice(0, n);
}

module.exports = {
  buildCartRowsWithGeo,
  buildGeoDistrictRanking,
  buildSourceAreaTable,
  buildGeoSummary,
  topAreas,
  geoContextLabel,
  geoAccuracyLabel,
  getCartVisitorGeoMap,
  GEO_CONTEXT_LABELS,
  GEO_ACCURACY_LABELS,
  MAX_CANDIDATE_CARTS,
};
