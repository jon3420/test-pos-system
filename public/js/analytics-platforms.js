// public/js/analytics-platforms.js — fix18-10-hotfix23-D｜Meta Pixel／GA4 Ready
//
// 共用的第三方廣告平台（Meta Pixel／GA4）載入與事件對應模組，供 line-order.html 與
// line-shipping.html 共同載入。安全規則（需求文件四）：
//   1. 沒啟用或沒有 ID，不載入對應 script。
//   2. 同一頁只載入一次（用 DOM id 檔重複插入）。
//   3. script 載入失敗絕不影響點餐流程（全部包在 try/catch）。
//   4. 不把姓名、電話、地址送到 Pixel／GA4。
//   5. Purchase 一律使用後端回傳的 order total，不使用前端自算金額。
//   6. Purchase 用 order_id／order_number 當 eventID／transaction_id 去重。
//   7. LINE Pay 取消／失敗不觸發 Purchase（由呼叫端保證：只在成功結果頁呼叫 trackPlatformEvent('purchase',...)）。
//   8. 前端不得自行假造 Purchase —— 這個模組本身不會主動判斷付款是否成立，
//      呼叫端必須只在後端已確認訂單成立／付款成功時才呼叫。

'use strict';
(function (global) {

  let _config = null; // { metaEnabled, metaPixelId, ga4Enabled, ga4Id }
  let _metaLoaded = false;
  let _ga4Loaded = false;

  // ── Meta Pixel ──────────────────────────────────────────────────
  function initMetaPixel(pixelId) {
    if (_metaLoaded || !pixelId) return;
    if (document.getElementById('meta-pixel-script')) { _metaLoaded = true; return; }
    try {
      /* eslint-disable */
      (function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!f._fbq) f._fbq = n;
        n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = true; t.id = 'meta-pixel-script';
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        if (s && s.parentNode) s.parentNode.insertBefore(t, s); else b.head.appendChild(t);
      })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', String(pixelId));
      window.fbq('track', 'PageView');
      _metaLoaded = true;
    } catch (e) {
      console.warn('[analytics-platforms] Meta Pixel 載入失敗:', e.message);
    }
  }

  // ── GA4 ─────────────────────────────────────────────────────────
  function initGA4(measurementId) {
    if (_ga4Loaded || !measurementId) return;
    if (document.getElementById('ga4-gtag-script')) { _ga4Loaded = true; return; }
    try {
      const s = document.createElement('script');
      s.id = 'ga4-gtag-script';
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(measurementId);
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      // send_page_view:false —— page_view 由我們自己的事件對應觸發，避免 gtag 預設又送一次造成重複
      window.gtag('config', measurementId, { send_page_view: false });
      _ga4Loaded = true;
    } catch (e) {
      console.warn('[analytics-platforms] GA4 載入失敗:', e.message);
    }
  }

  // 依系統設定初始化（沒有啟用或沒有 ID 時完全不載入任何 script）。
  // settings 物件的欄位對應 /api/line-shop 或 /api/line-shipping/shop 回傳的
  // analytics_meta_pixel_enabled / analytics_meta_pixel_id /
  // analytics_ga4_enabled / analytics_ga4_measurement_id。
  function init(settings) {
    settings = settings || {};
    const metaEnabled = settings.analytics_meta_pixel_enabled === '1' || settings.analytics_meta_pixel_enabled === true;
    const metaPixelId = (settings.analytics_meta_pixel_id || '').trim();
    const ga4Enabled = settings.analytics_ga4_enabled === '1' || settings.analytics_ga4_enabled === true;
    const ga4Id = (settings.analytics_ga4_measurement_id || '').trim();
    _config = { metaEnabled, metaPixelId, ga4Enabled, ga4Id };
    try { if (metaEnabled && metaPixelId) initMetaPixel(metaPixelId); } catch (e) {}
    try { if (ga4Enabled && ga4Id) initGA4(ga4Id); } catch (e) {}
  }

  const META_EVENT_MAP = {
    page_view: 'PageView',
    view_product: 'ViewContent',
    add_to_cart: 'AddToCart',
    begin_checkout: 'InitiateCheckout',
    payment_started: 'AddPaymentInfo',
    purchase: 'Purchase',
  };
  const GA4_EVENT_MAP = {
    page_view: 'page_view',
    view_product: 'view_item',
    add_to_cart: 'add_to_cart',
    begin_checkout: 'begin_checkout',
    payment_started: 'add_payment_info',
    purchase: 'purchase',
  };

  // 直接送 Meta Pixel 事件（低階函式，一般建議透過 trackPlatformEvent 呼叫）。
  // eventId：用於 Purchase 去重（order_id／order_number）。
  function trackMeta(eventName, params, eventId) {
    if (!_config || !_config.metaEnabled || !_config.metaPixelId || !window.fbq) return;
    const metaName = META_EVENT_MAP[eventName] || eventName;
    try {
      const opts = eventId ? { eventID: String(eventId) } : undefined;
      if (opts) window.fbq('track', metaName, params || {}, opts);
      else window.fbq('track', metaName, params || {});
    } catch (e) {
      console.warn('[analytics-platforms] Meta Pixel 事件送出失敗:', e.message);
    }
  }

  // 直接送 GA4 事件（低階函式，一般建議透過 trackPlatformEvent 呼叫）。
  function trackGA4(eventName, params) {
    if (!_config || !_config.ga4Enabled || !_config.ga4Id || !window.gtag) return;
    const ga4Name = GA4_EVENT_MAP[eventName] || eventName;
    try {
      window.gtag('event', ga4Name, params || {});
    } catch (e) {
      console.warn('[analytics-platforms] GA4 事件送出失敗:', e.message);
    }
  }

  // 高階統一入口：依我們內部事件名稱（page_view/view_product/add_to_cart/begin_checkout/
  // payment_started/purchase）同時分派給 Meta 與 GA4，兩邊欄位對應規則見檔頭註解。
  //
  // payload 可包含：
  //   content_ids, content_name, value, currency（固定 TWD）,
  //   items（GA4 用）, transaction_id（GA4 purchase）, eventId（Meta 去重用）
  //
  // 重要：purchase 只能在後端已確認訂單成立／付款成功的結果頁呼叫，value 必須是
  // 後端回傳的 order total，不得使用前端自己計算或購物車金額（需求文件四／六）。
  function trackPlatformEvent(eventName, payload) {
    payload = payload || {};
    try {
      if (META_EVENT_MAP[eventName]) {
        const metaParams = { currency: 'TWD' };
        if (payload.content_ids) metaParams.content_ids = payload.content_ids;
        if (payload.content_name) metaParams.content_name = payload.content_name;
        if (payload.content_type) metaParams.content_type = payload.content_type;
        if (payload.value !== undefined && payload.value !== null) metaParams.value = payload.value;
        trackMeta(eventName, metaParams, payload.eventId || payload.transaction_id);
      }
    } catch (e) { console.warn('[analytics-platforms] trackPlatformEvent(meta) failed:', e.message); }

    try {
      if (GA4_EVENT_MAP[eventName]) {
        const ga4Params = { currency: 'TWD' };
        if (payload.value !== undefined && payload.value !== null) ga4Params.value = payload.value;
        if (payload.items) ga4Params.items = payload.items;
        if (payload.transaction_id) ga4Params.transaction_id = payload.transaction_id;
        trackGA4(eventName, ga4Params);
      }
    } catch (e) { console.warn('[analytics-platforms] trackPlatformEvent(ga4) failed:', e.message); }
  }

  global.AnalyticsPlatforms = {
    init, initMetaPixel, initGA4, trackMeta, trackGA4, trackPlatformEvent,
  };
})(window);
