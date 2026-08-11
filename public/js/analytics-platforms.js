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
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.4｜GA4 view_item 重複觸發修正：
  // view_product 是「商品卡進入視窗」的曝光訊號（IntersectionObserver，見
  // line-order.html / line-shipping.html 的 _setupViewProductObserver），語意上是
  // 清單曝光（list impression），不是使用者真的選擇/開啟/查看某一個特定商品。
  // 之前把 view_product 對應成 GA4 view_item，導致每次 render（首次載入／換分類／
  // 搜尋）時，畫面上任何進入視窗的商品卡都會各自送一次 view_item —— 這就是
  // Production 回報「使用者只點開第一個商品一次，GA4 卻收到 9 次 view_item」的
  // 根因（9 張商品卡各自曝光各送一次，而不是同一次點擊被送 9 次）。
  // 移除這個對應：view_product 只留給內部 /api/analytics/events 記錄與既有 Meta
  // ViewContent（本輪不變更 Meta 語意），不再流向 GA4 view_item。
  //
  // R5.4-G1.6-GA4-H1.4.4 Reality Audit 結論：目前 line-order.html / line-shipping.html
  // 沒有任何「開啟/查看單一商品內容」的介面（沒有商品詳情 modal／drawer／頁面，
  // 商品卡本身點擊不會觸發任何 UI 反應）。因此本輪刻意「不」新增 view_item 事件名稱
  // 對應——那需要先由 Production 決定要不要新增一個真正的商品查看互動，而不是由
  // tracking 層自行造一個看不見的「點卡片＝查看」語意。詳見
  // H1.4.4_GA4_VIEW_ITEM_DUPLICATE_REALITY_AUDIT.md 第六節。
  // 目前狀態：view_item 在 GA4_EVENT_MAP 中不存在任何 key／send site，
  // 這是刻意的（Homepage Load Contract：view_item delta = 0，且沒有製造假事件）。
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.6｜PRODUCT-DETAIL-CHECKOUT-FLOW：
  // 商品詳情 Modal 正式上線後，才新增這個 view_item 對應。與上方 H1.4.4 的
  // 註解一致：view_product（清單曝光）永遠不映射到這裡；只有使用者主動點擊
  // 商品卡並成功開啟商品詳情時，呼叫端（line-order.html/line-shipping.html
  // 的 openProductDetail()）才會用 _trackEvent('view_item', {...}) 觸發一次。
  const GA4_EVENT_MAP = {
    page_view: 'page_view',
    add_to_cart: 'add_to_cart',
    view_item: 'view_item',
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
