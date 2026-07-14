// public/js/analytics-attribution.js — fix18-10-hotfix23-D｜Ads Attribution Foundation
//
// 共用歸因模組，供 line-order.html 與 line-shipping.html 共同載入（需求文件二／五：
// 「不得在 line-order.html 與 line-shipping.html 各寫不同規則」）。
//
// 這個檔案只負責：
//   1. normalizeTrafficSource()：統一的來源正規化規則
//   2. localStorage 的 first_touch / last_touch 儲存（key: analytics_attribution_${store_id}）
//   3. 組出事件送出 / 訂單送出所需的追蹤欄位
//
// 原則（沿用需求文件）：
//   - 不判斷金額、付款狀態、訂單是否成立（那些仍由後端負責）。
//   - 失敗絕不拋出例外，最壞情況回傳 'unknown' / 空值，不影響點餐流程。

'use strict';
(function (global) {

  // 需求文件十三：資料安全欄位長度限制
  const MAX_LEN = {
    source: 50, medium: 100, campaign: 200, content: 200, term: 200,
    fbclid: 500, gclid: 500, referrer: 1000, landing_page: 1000,
  };
  function clamp(str, key) {
    if (!str) return '';
    const s = String(str);
    const max = MAX_LEN[key] || 200;
    return s.length > max ? s.slice(0, max) : s;
  }

  // ── 來源正規化（需求文件五：判斷順序 utm_source → fbclid → gclid → referrer domain → direct → unknown）
  function normalizeTrafficSource(params, referrer) {
    const get = (k) => {
      if (!params) return '';
      if (typeof params.get === 'function') return params.get(k) || '';
      return params[k] || '';
    };
    const utmSourceRaw = (get('utm_source') || '').toLowerCase().trim();
    const fbclid = get('fbclid') || '';
    const gclid = get('gclid') || '';
    const ref = (referrer || '').toLowerCase();

    // 1. utm_source（含常見別名對照）
    if (utmSourceRaw) {
      if (['fb', 'facebook', 'meta'].includes(utmSourceRaw)) return 'facebook';
      if (['ig', 'instagram'].includes(utmSourceRaw)) return 'instagram';
      if (utmSourceRaw === 'threads') return 'threads';
      if (['google', 'adwords', 'googleads', 'google-ads'].includes(utmSourceRaw)) return 'google';
      if (utmSourceRaw === 'line' || utmSourceRaw === 'line_oa') return 'line_oa';
      return clamp(utmSourceRaw, 'source'); // 不在已知清單內的自訂來源名稱，原樣保留（不強制歸類 unknown）
    }
    // 2. fbclid 存在
    if (fbclid) return 'facebook';
    // 3. gclid 存在
    if (gclid) return 'google';
    // 4. referrer domain
    if (ref) {
      if (ref.includes('facebook.com') || ref.includes('fb.com')) return 'facebook';
      if (ref.includes('instagram.com')) return 'instagram';
      if (ref.includes('threads.net')) return 'threads';
      if (ref.includes('google.')) return 'google';
      if (ref.includes('liff.line.me') || ref.includes('line.me') || ref.includes('lin.ee')) return 'line_oa';
      try {
        const refHost = new URL(referrer).hostname;
        if (refHost && refHost === location.hostname) return 'direct';
      } catch (e) {}
      return 'referral';
    }
    // 5. 沒有 UTM、沒有 click id、沒有 referrer
    return 'direct';
  }

  function _storageKey(storeId) { return 'analytics_attribution_' + storeId; }

  function _readStore(storeId) {
    try {
      const raw = localStorage.getItem(_storageKey(storeId));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.version === 1) return parsed;
    } catch (e) {}
    return { version: 1, first_touch: null, last_touch: null };
  }
  function _writeStore(storeId, data) {
    try { localStorage.setItem(_storageKey(storeId), JSON.stringify(data)); } catch (e) {}
  }

  // 從目前 URL 擷取「本次進站」的歸因參數。不落地儲存，由呼叫端決定要不要更新 first/last touch。
  function _captureFromLocation() {
    let p;
    try { p = new URLSearchParams(window.location.search); } catch (e) { p = null; }
    const touch = {
      source: normalizeTrafficSource(p, document.referrer || ''),
      medium: clamp(p ? p.get('utm_medium') : '', 'medium'),
      campaign: clamp(p ? p.get('utm_campaign') : '', 'campaign'),
      content: clamp(p ? p.get('utm_content') : '', 'content'),
      term: clamp(p ? p.get('utm_term') : '', 'term'),
      referrer: clamp(document.referrer || '', 'referrer'),
      landing_page: clamp(location.pathname + location.search, 'landing_page'),
      fbclid: clamp(p ? p.get('fbclid') : '', 'fbclid'),
      gclid: clamp(p ? p.get('gclid') : '', 'gclid'),
      captured_at: new Date().toISOString(),
    };
    const hasNewParams = !!(
      (p && p.get('utm_source')) || touch.fbclid || touch.gclid ||
      (p && p.get('utm_medium')) || (p && p.get('utm_campaign'))
    );
    return { touch, hasNewParams };
  }

  // 擷取「本次進站」歸因並視需要寫入 first_touch／last_touch。
  //   - first_touch：第一次有效進站保存，之後不覆蓋（清除瀏覽器資料才會消失）
  //   - last_touch：每次帶新 UTM／click id 的有效進站才更新；沒有新歸因參數的瀏覽
  //     （例如站內導覽、之後 direct 造訪）不會把既有廣告來源覆蓋成 direct
  function captureAttribution(storeId) {
    try {
      const store = _readStore(storeId);
      const { touch, hasNewParams } = _captureFromLocation();
      if (!store.first_touch) store.first_touch = touch;
      if (hasNewParams) store.last_touch = touch;
      else if (!store.last_touch) store.last_touch = touch;
      _writeStore(storeId, store);
      return { first_touch: store.first_touch, last_touch: store.last_touch };
    } catch (e) {
      return { first_touch: null, last_touch: null };
    }
  }

  // 取得目前的歸因狀態（內部會先確保這次進站已經被記錄）。回傳 {first_touch, last_touch}。
  function getAttribution(storeId) {
    return captureAttribution(storeId);
  }

  // 組成一般事件（page_view/view_product/add_to_cart/remove_from_cart/begin_checkout/
  // payment_started）送出時要附帶的追蹤欄位。
  function buildAnalyticsEventContext(storeId) {
    const attr = getAttribution(storeId);
    const lt = attr.last_touch || {};
    return {
      source: lt.source || 'unknown',
      medium: lt.medium || '',
      campaign: lt.campaign || '',
      referrer: lt.referrer || '',
      landing_page: lt.landing_page || '',
      fbclid: lt.fbclid || '',
      gclid: lt.gclid || '',
      metadata: {
        utm_content: lt.content || '',
        utm_term: lt.term || '',
        first_touch: attr.first_touch || null,
        last_touch: attr.last_touch || null,
      },
    };
  }

  // 訂單送出時只附帶「追蹤識別資料」，金額／付款狀態一律由後端自己判斷（需求文件一／二）。
  function buildOrderAnalyticsContext(storeId) {
    const attr = getAttribution(storeId);
    return { first_touch: attr.first_touch || null, last_touch: attr.last_touch || null };
  }

  global.AnalyticsAttribution = {
    normalizeTrafficSource,
    captureAttribution,
    getAttribution,
    buildAnalyticsEventContext,
    buildOrderAnalyticsContext,
    // 舊名稱別名（沿用上一輪已串接的呼叫點，避免又要改一次 call site）
    buildTrackingFields: buildAnalyticsEventContext,
    buildOrderAttribution: buildOrderAnalyticsContext,
    clamp,
  };
})(window);
