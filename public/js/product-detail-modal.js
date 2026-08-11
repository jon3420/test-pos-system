// public/js/product-detail-modal.js
// H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW
//
// 共用的「商品詳情」Modal / Bottom Sheet 元件，供 LINE 外帶/外送點餐頁
// (public/line-order.html) 與宅配商品頁 (public/line-shipping.html) 共同載入。
//
// 設計原則（對應需求文件三～五）：
//   1. 這個檔案只負責「畫面與互動」（開/關、數量增減、即時小計、呼叫加入購物車），
//      不重建計價公式、不建立第二套商品資料——所有欄位（圖片/名稱/介紹/價格/
//      是否可加入）一律由呼叫端（line-order.html / line-shipping.html）用既有
//      商品資料算好、傳進來，本檔案不向後端另外打 API 取商品資料。
//   2. 目前專案商品資料沒有「規格(spec)/加料(addon)」選項系統（見各頁 Reality
//      Audit 註記），所以本元件不假造一套規格/加料 UI；只有在呼叫端真的傳入
//      options（見 openProductDetail 的 options 參數）時才會渲染對應區塊，
//      未來若商品資料表新增規格/加料欄位，只需要讓呼叫端把資料整理好傳進來，
//      不需要重寫本元件。
//   3. 開啟(open)只能由使用者主動點擊觸發一次；同一次開啟期間內部任何重繪
//      （數量增減、視窗尺寸/裝置旋轉造成的 resize）都不得重新呼叫 onOpen。
//
'use strict';
(function (global) {
  let overlayEl = null;
  let sheetEl = null;
  let bodyEl = null;
  let footerEl = null;
  let closeBtnEl = null;

  let _state = null; // 目前開啟中的商品詳情狀態
  let _scrollY = 0;
  let _lastAddClickTs = 0; // 防止快速連點重複觸發加入購物車

  function _ensureDom() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.className = 'pdm-overlay';
    overlayEl.setAttribute('role', 'presentation');
    overlayEl.innerHTML =
      '<div class="pdm-sheet" role="dialog" aria-modal="true" aria-labelledby="pdmName">' +
        '<button type="button" class="pdm-close" aria-label="關閉">&times;</button>' +
        '<div class="pdm-scroll">' +
          '<div class="pdm-imgbox"></div>' +
          '<div class="pdm-body"></div>' +
        '</div>' +
        '<div class="pdm-footer"></div>' +
      '</div>';
    document.body.appendChild(overlayEl);
    sheetEl = overlayEl.querySelector('.pdm-sheet');
    bodyEl = overlayEl.querySelector('.pdm-body');
    footerEl = overlayEl.querySelector('.pdm-footer');
    closeBtnEl = overlayEl.querySelector('.pdm-close');

    // 點背景遮罩關閉（點 sheet 本身不關閉，靠 stopPropagation 這裡改成判斷 target）
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) close();
    });
    closeBtnEl.addEventListener('click', function () { close(); });
    // Esc 關閉（桌機）
    document.addEventListener('keydown', _onKeydown);
  }

  function _onKeydown(e) {
    if (e.key === 'Escape' && overlayEl && overlayEl.classList.contains('pdm-open')) {
      close();
    }
  }

  function _lockScroll() {
    _scrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add('pdm-scroll-lock');
  }
  function _unlockScroll() {
    document.documentElement.classList.remove('pdm-scroll-lock');
    // 關閉後恢復頁面可捲動，且保持在原本瀏覽位置
    window.scrollTo(0, _scrollY);
  }

  function _escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // product: {
  //   id, name, price(number), image(url|''), description(string|''),
  //   startQty(number, 預設 1), maxQty(number|null, 份數/庫存上限，null=不限),
  //   blocked(bool, 是否完全無法加入), blockedLabel(string),
  // }
  // opts: {
  //   onOpen(product)          — 開啟成功時觸發一次（用於 view_item 追蹤），
  //                               只在 open() 被呼叫時觸發一次，內部重繪不會再觸發
  //   onAddToCart(product,qty) — 回傳 true/false（或 boolean 的 truthy 值）代表
  //                               是否真的成功加入購物車；由呼叫端沿用既有驗證
  //                               （例如份數不足、售完、必選規格未選等）
  // }
  function open(product, opts) {
    if (!product || product.id == null) return;
    _ensureDom();
    opts = opts || {};
    const startQty = Math.max(1, Number(product.startQty) || 1);
    _state = {
      product: product,
      opts: opts,
      qty: startQty,
      added: false,
    };
    _render();
    overlayEl.classList.add('pdm-open');
    _lockScroll();
    // 只在「這一次 open() 呼叫」觸發一次 onOpen，不因為後續 _render() 重繪而重複觸發
    if (typeof opts.onOpen === 'function') {
      try { opts.onOpen(product); } catch (e) { /* 追蹤失敗不影響商品詳情本身 */ }
    }
  }

  function close() {
    if (!overlayEl) return;
    overlayEl.classList.remove('pdm-open');
    _unlockScroll();
    _state = null;
  }

  function isOpen() {
    return !!(overlayEl && overlayEl.classList.contains('pdm-open'));
  }

  function _clampQty(q) {
    const s = _state;
    if (!s) return q;
    let v = Math.max(1, Math.trunc(Number(q) || 1));
    if (Number.isFinite(s.product.maxQty) && s.product.maxQty != null) {
      v = Math.min(v, Math.max(1, Number(s.product.maxQty)));
    }
    return v;
  }

  function _changeQty(delta) {
    if (!_state) return;
    _state.qty = _clampQty(_state.qty + delta);
    _renderFooter();
    _renderQtyRow();
  }

  function _renderQtyRow() {
    const s = _state;
    const row = bodyEl.querySelector('.pdm-qty-row');
    if (!row) return;
    const atMax = Number.isFinite(s.product.maxQty) && s.product.maxQty != null && s.qty >= s.product.maxQty;
    row.querySelector('.pdm-qty-num').textContent = String(s.qty);
    row.querySelector('.pdm-plus').disabled = !!atMax || s.product.blocked;
    row.querySelector('.pdm-minus').disabled = s.qty <= 1 || s.product.blocked;
  }

  function _renderFooter() {
    const s = _state;
    const price = Number(s.product.price) || 0;
    const subtotal = price * s.qty;
    footerEl.innerHTML =
      '<div class="pdm-subtotal">小計 <b>$' + subtotal + '</b></div>' +
      '<button type="button" class="pdm-add-btn" ' + (s.product.blocked ? 'disabled' : '') + '>' +
        (s.product.blocked ? (s.product.blockedLabel || '無法加入') : (s.added ? '已加入 ✓' : '加入購物車')) +
      '</button>';
    const btn = footerEl.querySelector('.pdm-add-btn');
    if (btn && !s.product.blocked) {
      btn.addEventListener('click', _onAddClick);
    }
  }

  function _onAddClick() {
    const now = Date.now();
    // 快速連點防護：300ms 內只處理一次，避免冒泡或連點造成重複加入
    if (now - _lastAddClickTs < 300) return;
    _lastAddClickTs = now;
    const s = _state;
    if (!s || s.product.blocked) return;
    let ok = false;
    try {
      ok = !!(typeof s.opts.onAddToCart === 'function' && s.opts.onAddToCart(s.product, s.qty));
    } catch (e) { ok = false; }
    if (!ok) return; // 呼叫端既有驗證會自行提示錯誤（例如 alert），詳情視窗保持開啟，不誤導使用者「已加入」
    s.added = true;
    _renderFooter();
    // 加入成功後短暫顯示「已加入 ✓」再關閉，避免使用者誤以為尚未加入
    setTimeout(function () { close(); }, 450);
  }

  function _render() {
    const s = _state;
    const p = s.product;
    const imgBox = overlayEl.querySelector('.pdm-imgbox');
    if (p.image) {
      imgBox.innerHTML = '<div class="pdm-img-wrap"><img src="' + _escapeHtml(p.image) + '" alt="' + _escapeHtml(p.name) + '" ' +
        'onerror="this.closest(\'.pdm-img-wrap\').classList.add(\'pdm-ph\');this.remove()"></div>';
    } else {
      // 沒有圖片：使用預設 placeholder，不顯示破圖
      imgBox.innerHTML = '<div class="pdm-img-wrap pdm-ph">🍽️</div>';
    }
    const descText = (p.description && String(p.description).trim())
      ? _escapeHtml(p.description)
      : ''; // 沒有介紹：隱藏介紹區塊，不顯示 undefined/null/空白大區塊
    bodyEl.innerHTML =
      (p.blocked && p.blockedLabel ? '<span class="pdm-badge pdm-badge-block">' + _escapeHtml(p.blockedLabel) + '</span><br>' : '') +
      '<h3 class="pdm-name" id="pdmName">' + _escapeHtml(p.name) + '</h3>' +
      (descText ? '<p class="pdm-desc">' + descText + '</p>' : '') +
      '<div class="pdm-price-row">基本價格 <span class="pdm-price">$' + (Number(p.price) || 0) + '</span></div>' +
      (p.blocked ? '' :
        '<div class="pdm-qty-row">' +
          '<span class="pdm-qty-label">數量</span>' +
          '<div class="pdm-qty-ctrl">' +
            '<button type="button" class="pdm-minus" aria-label="減少">&minus;</button>' +
            '<span class="pdm-qty-num">' + s.qty + '</span>' +
            '<button type="button" class="pdm-plus" aria-label="增加">+</button>' +
          '</div>' +
        '</div>');
    if (!p.blocked) {
      bodyEl.querySelector('.pdm-minus').addEventListener('click', function () { _changeQty(-1); });
      bodyEl.querySelector('.pdm-plus').addEventListener('click', function () { _changeQty(1); });
      // 初始渲染時就套用一次數量上下限狀態（例如 maxQty=1 或起始數量已達下限 1），
      // 不能只靠使用者點擊過一次 +/- 才第一次套用 disabled 狀態。
      _renderQtyRow();
    }
    _renderFooter();
  }

  global.ProductDetailModal = { open: open, close: close, isOpen: isOpen };
})(window);
