// ===== POS 系統 前端邏輯 =====

const API = '';  // 同域，不需要前綴

// ===== 狀態 =====
let allProducts = [];
let filteredProducts = [];
let cart = [];
let selectedPayment = 'cash';
let settings = {};
let currentOrderForPrint = null;
let allPlatforms = [];       // 外送平台列表
let currentOrderMode = 'dine_in';  // 點餐模式：dine_in | takeout | delivery
let selectedPlatform = null;       // 選中的外送平台物件
let currentOrderTab = 'all';       // 訂單分頁
let orderInfoExpanded = true;      // 訂單資訊區展開狀態
let allPaymentMethods = [];        // 付款方式快取

// 訂單編輯狀態
let editOrderItems = [];
let editOrderId = null;

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  startClock();
  await loadSettings();
  await loadCategories();
  await loadPlatforms();
  await loadPaymentMethods();   // 載入付款方式
  await loadProducts();
  initDateRange();
});

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    // 手動格式化避免 zh-TW locale 在部分環境回傳 h24 造成 24:xx:xx
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `${h}:${m}:${s}`;
  };
  tick();
  setInterval(tick, 1000);
}

function initDateRange() {
  const today = new Date().toISOString().slice(0, 10);
  const fromEl = document.getElementById('dateFrom');
  const toEl   = document.getElementById('dateTo');
  if (fromEl) fromEl.value = today;
  if (toEl)   toEl.value   = today;
}

// ===== 頁面切換 =====
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name)?.classList.add('active');
  document.querySelector(`[data-page="${name}"]`)?.classList.add('active');

  if (name === 'orders')     { loadCurrentOrderTab(); }
  if (name === 'products')   loadProductsPage();
  if (name === 'settings')   { loadSettingsPage(); switchSettingsTab('basic'); }
  if (name === 'categories') loadCategoriesPage();
  if (name === 'inventory')  loadInventoryPage();
}

// ===== 設定頁分頁 =====
let currentSettingsTab = 'basic';

function switchSettingsTab(tab) {
  currentSettingsTab = tab;
  document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
  document.querySelectorAll('.settings-tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('stab-' + tab);
  if (panel) panel.style.display = 'block';

  if (tab === 'payment')  loadPaymentMethodsPage();
  if (tab === 'gateway')  loadGatewayPage();
  if (tab === 'platform') loadPlatformsPage();
  if (tab === 'printer')  loadPrinterSettings();
}

// ===== 設定 =====
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const json = await res.json();
    if (json.success) {
      settings = json.data;
      document.getElementById('shopName').textContent = settings.shop_name || '餐車 POS';
    }
  } catch {}
}

async function loadSettingsPage() {
  await loadSettings();
  const fields = ['shop_name', 'n8n_webhook_url', 'line_channel_token', 'receipt_footer'];
  fields.forEach(k => {
    const el = document.getElementById('set-' + k);
    if (el) el.value = settings[k] || '';
  });
}

async function saveSettings() {
  const body = {};
  ['shop_name', 'n8n_webhook_url', 'line_channel_token', 'receipt_footer'].forEach(k => {
    const el = document.getElementById('set-' + k);
    if (el) body[k] = el.value;
  });
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      settings = json.data;
      document.getElementById('shopName').textContent = settings.shop_name || '餐車 POS';
      showToast('設定已儲存', 'success');
    }
  } catch {
    showToast('儲存失敗', 'error');
  }
}

// ===== 商品載入（永遠從 server 取最新庫存，不使用舊快取） =====
async function loadProducts() {
  try {
    // 加 timestamp 防止瀏覽器快取舊回應
    const res = await fetch('/api/products?enabled=1&_t=' + Date.now());
    const json = await res.json();
    if (json.success) {
      allProducts = json.data.map(p => {
        // 合併 localStorage 圖片快取（base64 大圖）
        if (!p.image) {
          const local = getLocalImage(p.id);
          if (local) p = { ...p, image: local };
        }
        // 防禦性：在前端重算 available_units，確保與 server 公式一致
        if (p.inventory_enabled && p.allocated_grams > 0) {
          const freshUnits = Math.floor(Number(p.current_stock_grams) / Number(p.allocated_grams));
          p = {
            ...p,
            available_units: freshUnits,
            is_low_stock: freshUnits > 0 && freshUnits <= Number(p.low_stock_alert || 5),
            is_out_of_stock: freshUnits <= 0,
          };
        } else {
          p = { ...p, available_units: null, is_low_stock: false, is_out_of_stock: false };
        }
        return p;
      });
      // 保持目前篩選分類不變，重新渲染
      const activeCat = document.querySelector('.cat-btn.active')?.dataset?.cat || 'all';
      filteredProducts = activeCat === 'all' ? allProducts : allProducts.filter(p => p.category === activeCat);
      renderProductGrid();
    }
  } catch {
    showToast('商品載入失敗', 'error');
  }
}

// ===== 分類載入（供 POS Tab） =====
let allCategories = [];

async function loadCategories() {
  try {
    const res = await fetch('/api/categories?active=1');
    const json = await res.json();
    if (json.success) {
      allCategories = json.data;
      renderCategoryTabs();
    }
  } catch {}
}

function renderCategoryTabs() {
  const tabs = document.getElementById('categoryTabs');
  if (!tabs) return;
  tabs.innerHTML = `<button class="cat-btn active" data-cat="all" onclick="filterCategory('all')">全部</button>` +
    allCategories.map(c =>
      `<button class="cat-btn" data-cat="${escHtml(c.name)}" onclick="filterCategory('${escHtml(c.name)}')">${c.icon||''} ${escHtml(c.name)}</button>`
    ).join('');
}

function filterCategory(cat) {
  document.querySelectorAll('.cat-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
  filteredProducts = cat === 'all' ? allProducts : allProducts.filter(p => p.category === cat);
  renderProductGrid();
}

// 取得商品在目前模式的有效價格（含 fallback）
function getProductPrice(product, mode) {
  mode = mode || currentOrderMode || 'dine_in';
  if (mode === 'dine_in')  return Number(product.dine_in_price)  || Number(product.price) || 0;
  if (mode === 'takeout')  return Number(product.takeaway_price) || Number(product.dine_in_price) || Number(product.price) || 0;
  if (mode === 'delivery') return Number(product.delivery_price) || Number(product.takeaway_price) || Number(product.dine_in_price) || Number(product.price) || 0;
  return Number(product.price) || 0;
}

function renderProductGrid() {
  const grid = document.getElementById('productGrid');
  if (!filteredProducts.length) {
    grid.innerHTML = '<div class="loading-card">此分類暫無商品</div>';
    return;
  }
  const catEmoji = {};
  allCategories.forEach(c => { catEmoji[c.name] = c.icon || '📌'; });

  grid.innerHTML = filteredProducts.map(p => {
    const imgSrc = p.image || getLocalImage(p.id) || '';
    const imgHtml = imgSrc
      ? `<img class="product-card-img" src="${escAttr(imgSrc)}" alt="${escAttr(p.name)}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholderHtml = `
      <div class="product-card-img-placeholder" ${imgSrc ? 'style="display:none"' : ''}>
        <span class="product-card-img-placeholder-icon">${catEmoji[p.category] || '🍽️'}</span>
        <span class="product-card-img-placeholder-cat">${p.category}</span>
      </div>`;

    // 庫存徽章
    let stockBadge = '';
    let soldOutClass = '';
    if (p.inventory_enabled && Number(p.allocated_grams) > 0) {
      const units = Math.floor(Number(p.current_stock_grams) / Number(p.allocated_grams));
      const lowAlert = Number(p.low_stock_alert || 5);
      if (units <= 0) {
        soldOutClass = ' sold-out';
        stockBadge = `<div class="product-card-stock zero">已售完</div>`;
      } else if (units <= lowAlert) {
        stockBadge = `<div class="product-card-stock low">⚠️ 剩 ${units} 份</div>`;
      } else {
        stockBadge = `<div class="product-card-stock">剩 ${units} 份</div>`;
      }
    }

    // 依目前模式顯示正確價格
    const modePrice = getProductPrice(p, currentOrderMode);
    const priceLabel = currentOrderMode === 'delivery' ? '<span class="delivery-price-tag">外送</span>' : '';

    return `
      <div class="product-card${soldOutClass}" id="pc-${p.id}" onclick="addToCart(${p.id})">
        <div class="product-card-img-wrap">
          ${imgHtml}
          ${placeholderHtml}
        </div>
        <div class="product-card-body">
          <div class="product-card-name">${escHtml(p.name)}</div>
          <div class="product-card-price">${priceLabel}$${modePrice}</div>
          ${stockBadge}
        </div>
      </div>`;
  }).join('');
}

// ===== 購物車 =====
function addToCart(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;

  // 即時庫存防護：已售完直接擋
  if (product.inventory_enabled && product.allocated_grams > 0) {
    const freshUnits = Math.floor(Number(product.current_stock_grams) / Number(product.allocated_grams));
    const alreadyInCart = cart.find(i => i.productId === productId)?.qty || 0;
    if (freshUnits <= 0) {
      showToast(`${product.name} 已售完`, 'error');
      return;
    }
    if (alreadyInCart >= freshUnits) {
      showToast(`${product.name} 庫存不足（最多 ${freshUnits} 份）`, 'error');
      return;
    }
  }

  // 動畫
  const card = document.getElementById('pc-' + productId);
  if (card) {
    card.classList.add('added');
    setTimeout(() => card.classList.remove('added'), 400);
  }

  const existing = cart.find(i => i.productId === productId);
  if (existing) {
    existing.qty++;
    existing.subtotal = existing.price * existing.qty;
  } else {
    // 使用當前模式價格（加入後不隨模式切換變動）
    const modePrice = getProductPrice(product, currentOrderMode);
    cart.push({
      productId,
      name: product.name,
      price: modePrice,
      orderMode: currentOrderMode,
      qty: 1,
      subtotal: modePrice
    });
  }
  renderCart();
}

function updateQty(productId, delta) {
  const idx = cart.findIndex(i => i.productId === productId);
  if (idx === -1) return;
  cart[idx].qty += delta;
  if (cart[idx].qty <= 0) {
    cart.splice(idx, 1);
  } else {
    cart[idx].subtotal = cart[idx].price * cart[idx].qty;
  }
  renderCart();
}

function removeFromCart(productId) {
  cart = cart.filter(i => i.productId !== productId);
  renderCart();
}

function clearCart() {
  cart = [];
  // 清空各模式欄位（容錯：元素可能不存在）
  const safeVal = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };
  safeVal('customerPhone'); safeVal('customerName'); safeVal('orderNote');
  safeVal('tableNumber'); safeVal('guestCount');
  safeVal('pickupName'); safeVal('takeoutPhone'); safeVal('pickupTime'); safeVal('notetakeout');
  safeVal('deliveryName'); safeVal('deliveryPhone'); safeVal('deliveryAddress');
  safeVal('estimatedDelivery'); safeVal('notedelivery'); safeVal('platformOrderNo');
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  selectedPlatform = null;
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  if (cart.length === 0) {
    container.innerHTML = `
      <div class="cart-empty">
        <span class="cart-empty-icon">🛒</span>
        <p>點選左側商品加入</p>
      </div>
    `;
  } else {
    container.innerHTML = cart.map(item => `
      <div class="cart-item">
        <div class="cart-item-name">${escHtml(item.name)}</div>
        <div class="cart-item-qty">
          <button class="qty-btn" onclick="updateQty(${item.productId}, -1)">−</button>
          <span class="qty-num">${item.qty}</span>
          <button class="qty-btn" onclick="updateQty(${item.productId}, 1)">＋</button>
        </div>
        <div class="cart-item-price">$${item.subtotal}</div>
        <button class="cart-item-del" onclick="removeFromCart(${item.productId})">✕</button>
      </div>
    `).join('');
  }

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0);
  document.getElementById('subtotalDisplay').textContent = '$' + subtotal;
  document.getElementById('totalDisplay').textContent = '$' + subtotal;

  // 更新找零面板應收金額
  const cashDue = document.getElementById('cashDue');
  if (cashDue) cashDue.textContent = 'NT$' + subtotal;

  updateCheckoutButton();
  calcChange();
  // 外送模式：同步更新抽成計算
  if (typeof updateDeliveryCalc === 'function') updateDeliveryCalc();
}

// ===== 現金找零計算 =====
function calcChange() {
  const total = cart.reduce((s, i) => s + i.subtotal, 0);
  const receivedEl = document.getElementById('receivedAmount');
  const changeEl   = document.getElementById('changeAmount');
  const warnEl     = document.getElementById('cashWarn');
  if (!receivedEl) return;

  const received = parseFloat(receivedEl.value) || 0;
  const change = received - total;

  if (changeEl) changeEl.textContent = change >= 0 ? 'NT$' + change : 'NT$0';
  if (warnEl)   warnEl.style.display = (received > 0 && change < 0) ? 'block' : 'none';
  updateCheckoutButton();
}

function updateCheckoutButton() {
  const btn = document.getElementById('checkoutBtn');
  if (!btn) return;
  const total = cart.reduce((s, i) => s + i.subtotal, 0);
  if (cart.length === 0) { btn.disabled = true; return; }
  if (selectedPayment === 'cash') {
    const received = parseFloat(document.getElementById('receivedAmount')?.value || '0') || 0;
    btn.disabled = received < total;
  } else {
    btn.disabled = false;
  }
}

function selectPayment(method) {
  selectedPayment = method;
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === method);
  });
  const panel = document.getElementById('cashChangePanel');
  if (panel) panel.style.display = method === 'cash' ? 'block' : 'none';
  if (method !== 'cash') {
    const r = document.getElementById('receivedAmount');
    if (r) r.value = '';
    const w = document.getElementById('cashWarn');
    if (w) w.style.display = 'none';
  }
  updateCheckoutButton();
}

// ===== 動態付款方式 =====
async function loadPaymentMethods() {
  try {
    const res  = await fetch('/api/payment-methods?active=1');
    const json = await res.json();
    if (json.success) {
      allPaymentMethods = json.data;
      renderPaymentMethods();
    }
  } catch {}
}

function renderPaymentMethods() {
  const container = document.getElementById('paymentMethodsContainer');
  const warnEl    = document.getElementById('paymentWarn');
  if (!container) return;

  // 依當前模式過濾
  const modeKey = {
    dine_in:  'enable_for_dine_in',
    takeout:  'enable_for_takeout',
    delivery: 'enable_for_delivery',
  }[currentOrderMode] || 'enable_for_dine_in';

  const available = allPaymentMethods.filter(m => m.is_active && m[modeKey]);

  if (!available.length) {
    container.innerHTML = '';
    if (warnEl) warnEl.style.display = 'block';
    return;
  }
  if (warnEl) warnEl.style.display = 'none';

  container.innerHTML = available.map(m =>
    `<button class="pay-btn${m.is_default && !selectedPayment ? ' active' : selectedPayment === m.code ? ' active' : ''}"
       data-method="${m.code}" onclick="selectPayment('${m.code}')">${m.icon} ${m.name}</button>`
  ).join('');

  // 若目前 selectedPayment 不在可用清單中，自動選預設
  if (!available.find(m => m.code === selectedPayment)) {
    const def = available.find(m => m.is_default) || available[0];
    if (def) selectPayment(def.code);
  }
}

// ===== 結帳 =====
async function checkout() {
  if (cart.length === 0) return;

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0);
  const isCash   = selectedPayment === 'cash';
  const receivedRaw = parseFloat(document.getElementById('receivedAmount')?.value || '0') || 0;
  const received = isCash ? receivedRaw : subtotal;
  const change   = isCash ? Math.max(0, received - subtotal) : 0;

  if (isCash && received < subtotal) {
    showToast('實收金額不足，無法結帳', 'error');
    return;
  }

  // 外送模式：必須選擇平台
  if (currentOrderMode === 'delivery' && !selectedPlatform) {
    showToast('請先選擇外送平台', 'error');
    return;
  }

  // 外送模式：平台單號必填
  if (currentOrderMode === 'delivery') {
    const pno = document.getElementById('platformOrderNo')?.value?.trim() || '';
    if (!pno) {
      showToast('請輸入外送單號', 'error');
      document.getElementById('platformOrderNo')?.focus();
      return;
    }
  }

  // 蒐集模式欄位
  let modeFields = {};
  if (currentOrderMode === 'dine_in') {
    modeFields = {
      table_number:  document.getElementById('tableNumber')?.value?.trim() || '',
      guest_count:   parseInt(document.getElementById('guestCount')?.value) || 0,
      note:          document.getElementById('notedinein')?.value?.trim() || '',
    };
  } else if (currentOrderMode === 'takeout') {
    modeFields = {
      pickup_name:  document.getElementById('pickupName')?.value?.trim() || '',
      customer_phone: document.getElementById('takeoutPhone')?.value?.trim() || '',
      pickup_time:  document.getElementById('pickupTime')?.value || '',
      note:         document.getElementById('notetakeout')?.value?.trim() || '',
    };
  } else if (currentOrderMode === 'delivery') {
    modeFields = {
      delivery_platform:  selectedPlatform?.name || '',
      platform_order_no:  document.getElementById('platformOrderNo')?.value?.trim() || '',
      customer_name:      document.getElementById('deliveryName')?.value?.trim() || '',
      customer_phone:     document.getElementById('deliveryPhone')?.value?.trim() || '',
      delivery_address:   document.getElementById('deliveryAddress')?.value?.trim() || '',
      estimated_delivery: document.getElementById('estimatedDelivery')?.value || '',
      note:               document.getElementById('notedelivery')?.value?.trim() || '',
    };
  }

  const btn = document.getElementById('checkoutBtn');
  btn.disabled = true;
  btn.textContent = '處理中...';

  const payload = {
    items: cart.map(i => ({
      productId: i.productId,
      name: i.name,
      price: i.price,
      qty: i.qty,
      subtotal: i.subtotal
    })),
    payment_method: selectedPayment,
    order_mode: currentOrderMode,
    order_status: currentOrderMode === 'delivery' ? 'preparing' : 'completed',
    received_amount: received,
    change_amount: change,
    ...modeFields,
  };

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (json.success) {
      currentOrderForPrint = json.data;
      showReceiptModal(json.data);
      clearCart();
      const r = document.getElementById('receivedAmount');
      if (r) r.value = '';
      calcChange();
      _invProducts = [];
      loadProducts();
    } else {
      showToast('結帳失敗：' + (json.message || '未知錯誤'), 'error');
    }
  } catch {
    showToast('網路錯誤，請重試', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '結帳';
  }
}

// ===== 收據 Modal =====
function showReceiptModal(order) {
  const payLabel = {
    cash:'💵 現金', linepay:'💚 LINE Pay', card:'💳 刷卡',
    transfer:'🏦 轉帳', jkopay:'🟠 街口', platform:'📱 平台'
  };
  document.getElementById('receiptShopName').textContent = settings.shop_name || '餐車 POS';
  document.getElementById('receiptOrderNum').textContent = '訂單：' + order.order_number;
  document.getElementById('receiptTime').textContent = order.created_at;
  document.getElementById('receiptPayment').textContent = payLabel[order.payment_method] || order.payment_method;
  document.getElementById('receiptTotal').textContent = 'NT$' + order.total;
  document.getElementById('receiptFooter').textContent = settings.receipt_footer || '感謝您的光臨！';

  // 模式資訊
  const modeInfo = [];
  if (order.order_mode === 'dine_in' && order.table_number) modeInfo.push(`桌號：${order.table_number}`);
  if (order.order_mode === 'takeout' && order.pickup_name)  modeInfo.push(`取餐：${order.pickup_name}`);
  if (order.order_mode === 'delivery') {
    if (order.delivery_platform) modeInfo.push(`平台：${order.delivery_platform}`);
    if (order.delivery_address)  modeInfo.push(`地址：${order.delivery_address}`);
    if (order.platform_commission_rate > 0) {
      modeInfo.push(`抽成：${order.platform_commission_rate}%（NT$${order.platform_commission_amount}）`);
      modeInfo.push(`店家實收：NT$${order.store_actual_income}`);
    }
  }

  // 現金找零
  const isCash = order.payment_method === 'cash';
  const recvRow   = document.getElementById('receiptReceivedRow');
  const changeRow = document.getElementById('receiptChangeRow');
  if (recvRow)   recvRow.style.display   = isCash ? 'flex' : 'none';
  if (changeRow) changeRow.style.display = isCash ? 'flex' : 'none';
  if (isCash) {
    const recv = document.getElementById('receiptReceived');
    const chng = document.getElementById('receiptChange');
    if (recv) recv.textContent = 'NT$' + (order.received_amount || 0);
    if (chng) chng.textContent = 'NT$' + (order.change_amount   || 0);
  }

  const body = document.getElementById('receiptBody');
  body.innerHTML =
    (modeInfo.length ? `<div style="font-size:12px;color:var(--text-muted);padding:6px 0;border-bottom:1px dashed #333;margin-bottom:6px">${modeInfo.join('　')}</div>` : '') +
    order.items.map(i => `
      <div class="receipt-item">
        <span class="receipt-item-name">${escHtml(i.name)}</span>
        <span class="receipt-item-qty">x${i.qty}</span>
        <span class="receipt-item-price">$${i.subtotal}</span>
      </div>`).join('');

  document.getElementById('successModal').classList.add('open');

  // 顯示自動列印提示
  const msgEl = document.getElementById('printStatusMsg');
  if (msgEl) {
    const autoPrint = settings.auto_print;
    if (autoPrint) {
      msgEl.style.display = 'block';
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = '✅ 已送出自動列印';
    } else {
      msgEl.style.display = 'none';
    }
  }
}

function closeSuccess() {
  document.getElementById('successModal').classList.remove('open');
  currentOrderForPrint = null;
}

// 「完成」按鈕：只關閉 modal，列印已在建立訂單後自動執行
function completeCheckout() {
  closeSuccess();
}

function printReceipt() {
  if (!currentOrderForPrint) return;
  openPrintWindow(currentOrderForPrint);
  // 同時呼叫後端 ESC/POS 列印
  if (currentOrderForPrint.id) {
    fetch(`/api/orders/${currentOrderForPrint.id}/reprint`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'receipt' })
    }).then(r => r.json()).then(j => {
      if (j?.printResult?.success === false) showToast('ESC/POS: ' + (j.printResult.message || '列印失敗'), 'error');
    }).catch(() => {});
  }
}

function printOrderReceipt() {
  if (!currentOrderForPrint) return;
  openPrintWindow(currentOrderForPrint);
}

function openPrintWindow(order, printType='receipt') {
  const payLabel = { cash: '現金', linepay: 'LINE Pay', card: '刷卡', transfer: '轉帳', jkopay: '街口', platform: '平台付款' };
  const modeLabel = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
  const shopName = settings.shop_name || '餐車 POS';
  const footer = settings.receipt_footer || '感謝您的光臨！';
  const isVoid = order.status === 'void';
  const isCash = order.payment_method === 'cash';
  const mode   = modeLabel[order.order_mode] || '';

  const itemsHtml = order.items.map(i =>
    `<tr>
       <td>${escHtml(i.name)}</td>
       <td style="text-align:center">x${i.qty}</td>
       <td style="text-align:center">$${i.price||''}</td>
       <td style="text-align:right">$${i.subtotal}</td>
     </tr>`
  ).join('');

  const cashRows = isCash ? `
    <tr><td>實收</td><td colspan="3" style="text-align:right">NT$${order.received_amount || 0}</td></tr>
    <tr><td>找零</td><td colspan="3" style="text-align:right">NT$${order.change_amount || 0}</td></tr>
  ` : '';

  const voidBanner = isVoid ? `<p style="text-align:center;color:red;font-size:16px;font-weight:bold;border:2px solid red;padding:4px;margin:6px 0">【 已作廢 】</p>` : '';

  // 外送資訊區塊
  const deliveryRows = order.order_mode === 'delivery' ? `
    ${order.delivery_platform ? `<tr><td>外送平台</td><td colspan="3" style="text-align:right">${escHtml(order.delivery_platform)}</td></tr>` : ''}
    ${order.platform_order_no ? `<tr><td>平台單號</td><td colspan="3" style="text-align:right">${escHtml(order.platform_order_no)}</td></tr>` : ''}
    ${order.customer_name     ? `<tr><td>顧客</td><td colspan="3" style="text-align:right">${escHtml(order.customer_name)}</td></tr>` : ''}
    ${order.customer_phone    ? `<tr><td>電話</td><td colspan="3" style="text-align:right">${escHtml(order.customer_phone)}</td></tr>` : ''}
    ${order.delivery_address  ? `<tr><td>地址</td><td colspan="3" style="text-align:right">${escHtml(order.delivery_address)}</td></tr>` : ''}
  ` : order.order_mode === 'dine_in' && order.table_number ? `
    <tr><td>桌號</td><td colspan="3" style="text-align:right">${escHtml(order.table_number)}</td></tr>
  ` : order.order_mode === 'takeout' && order.pickup_name ? `
    <tr><td>取餐</td><td colspan="3" style="text-align:right">${escHtml(order.pickup_name)}</td></tr>
  ` : '';

  const html = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${isVoid ? '[作廢]' : ''}訂單收據</title>
    <style>
      body { font-family: monospace; font-size: 13px; width: 80mm; margin: 0 auto; padding: 8px; }
      h2 { text-align: center; font-size: 18px; margin: 0 0 2px; }
      .center { text-align: center; }
      .mode { text-align: center; font-size: 12px; margin-bottom: 4px; }
      .dashed { border-top: 1px dashed #000; margin: 6px 0; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 2px 2px; font-size: 12px; }
      .total { font-size: 15px; font-weight: bold; }
      @media print { @page { margin: 0; } body { padding: 0; } }
    </style>
  </head><body>
    <h2>${shopName}</h2>
    ${mode ? `<div class="mode">【${mode}】</div>` : ''}
    ${voidBanner}
    <p class="center" style="font-size:11px">訂單：${order.order_number}</p>
    <p class="center" style="font-size:11px">${order.created_at}</p>
    <div class="dashed"></div>
    <table>
      <tr style="font-weight:bold;border-bottom:1px solid #000"><td>品項</td><td style="text-align:center">數量</td><td style="text-align:center">單價</td><td style="text-align:right">小計</td></tr>
      ${itemsHtml}
    </table>
    <div class="dashed"></div>
    <table>
      ${deliveryRows}
      <tr><td>付款方式</td><td colspan="3" style="text-align:right">${payLabel[order.payment_method] || order.payment_method}</td></tr>
      ${order.note ? `<tr><td>備註</td><td colspan="3" style="text-align:right">${escHtml(order.note)}</td></tr>` : ''}
    </table>
    <div class="dashed"></div>
    <table>
      <tr class="total"><td>應收</td><td colspan="3" style="text-align:right">NT$${order.total}</td></tr>
      ${cashRows}
    </table>
    ${order.order_mode === 'delivery' && Number(order.platform_commission_amount) > 0 ? `
    <div class="dashed"></div>
    <table>
      <tr><td>平台抽成(${order.platform_commission_rate}%)</td><td colspan="3" style="text-align:right">NT$${order.platform_commission_amount}</td></tr>
      <tr><td>店家實收</td><td colspan="3" style="text-align:right">NT$${order.store_actual_income}</td></tr>
    </table>` : ''}
    <div class="dashed"></div>
    <p class="center" style="font-size:12px">${footer}</p>
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 1200); }</scr` + `ipt>
  </body></html>`;

  const w = window.open('', '_blank', 'width=420,height=700');
  if (w) { w.document.write(html); w.document.close(); }
  else { showToast('無法開啟列印視窗，請允許彈出視窗', 'error'); }
}

// ===== 日期區間控制 =====
let currentDateRange = 'today';

function setDateRange(range) {
  currentDateRange = range;
  document.querySelectorAll('.shortcut-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  const customDiv = document.getElementById('customDateRange');
  if (customDiv) customDiv.style.display = range === 'custom' ? 'flex' : 'none';
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  let from = fmt(today), to = fmt(today);
  if (range === 'yesterday') { const y = new Date(today); y.setDate(y.getDate()-1); from = to = fmt(y); }
  else if (range === 'week') { const mon = new Date(today); mon.setDate(today.getDate()-today.getDay()+(today.getDay()===0?-6:1)); from = fmt(mon); to = fmt(today); }
  else if (range === 'month') { from = fmt(new Date(today.getFullYear(),today.getMonth(),1)); to = fmt(today); }
  const fromEl = document.getElementById('dateFrom'); const toEl = document.getElementById('dateTo');
  if (fromEl && range !== 'custom') fromEl.value = from;
  if (toEl   && range !== 'custom') toEl.value   = to;
  if (range !== 'custom') loadCurrentOrderTab();
}

// ===== 訂單分頁切換 =====
function switchOrderTab(tab) {
  currentOrderTab = tab;
  document.querySelectorAll('.order-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('order-tab-all').style.display      = tab === 'delivery' ? 'none' : 'block';
  document.getElementById('order-tab-delivery').style.display = tab === 'delivery' ? 'block' : 'none';
  loadCurrentOrderTab();
}

function loadCurrentOrderTab() {
  if (currentOrderTab === 'delivery') loadDeliveryReport();
  else loadOrders(currentOrderTab === 'pos' ? 'pos' : null);
}

// ===== 訂單頁 =====
// 計算統計（從前端已篩選 orders 陣列計算，確保列表與統計一致）
function calcStatsFromOrders(orders) {
  // 排除作廢
  const valid = orders.filter(o => {
    if (o.status === 'void') return false;
    if (o.order_status === 'cancelled') return false;
    // 外送訂單：只有 delivery_status=completed 才計入；cancelled 排除；preparing/delivering 仍計入（進行中）
    if (o.order_mode === 'delivery' && o.delivery_status === 'cancelled') return false;
    return true;
  });
  const order_count   = valid.length;
  const total_revenue = valid.reduce((s, o) => s + Number(o.total || 0), 0);
  const avg_order     = order_count > 0 ? total_revenue / order_count : 0;
  const total_commission  = valid.reduce((s, o) => s + Number(o.platform_commission_amount || 0), 0);
  const total_store_income = valid.reduce((s, o) => s + Number(o.store_actual_income || o.total || 0), 0);

  // 熱賣商品
  const productMap = {};
  valid.forEach(o => {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    items.forEach(item => {
      if (!productMap[item.name]) productMap[item.name] = { name: item.name, qty: 0, revenue: 0 };
      productMap[item.name].qty    += Number(item.qty || 0);
      productMap[item.name].revenue += Number(item.subtotal || 0);
    });
  });
  const top_products = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

  return { order_count, total_revenue, avg_order, total_commission, total_store_income, top_products };
}

async function loadOrders(modeFilter) {
  const from = document.getElementById('dateFrom')?.value;
  const to   = document.getElementById('dateTo')?.value;
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = from || today, dateTo = to || today;
  try {
    const res = await fetch(`/api/orders?date_from=${dateFrom}&date_to=${dateTo}`);
    const json = await res.json();
    let orders = json.success ? json.data : [];

    // 依分頁過濾
    if (modeFilter === 'pos') {
      // 內用/外帶：排除外送
      orders = orders.filter(o => o.order_mode !== 'delivery');
    }
    // 全部訂單：不過濾

    // 從篩選後的 orders 計算統計（確保列表與統計一致）
    const stats = calcStatsFromOrders(orders);

    renderOrdersTable(orders);
    renderStatCards(stats);
  } catch { showToast('訂單載入失敗', 'error'); }
}

async function loadDeliveryReport() {
  const from = document.getElementById('dateFrom')?.value || new Date().toISOString().slice(0,10);
  const to   = document.getElementById('dateTo')?.value   || new Date().toISOString().slice(0,10);
  try {
    const res  = await fetch(`/api/orders/delivery-report?date_from=${from}&date_to=${to}`);
    const json = await res.json();
    if (!json.success) return;

    // 從回傳的外送訂單陣列重新計算統計（確保一致）
    const delivOrders = json.data || [];
    const stats = calcStatsFromOrders(delivOrders);
    // 外送報表額外加平台分組
    renderStatCards({ ...stats, _hasDelivery: true });

    const byPlat = json.by_platform || [];
    const platStats = document.getElementById('platformStats');
    if (platStats) {
      platStats.innerHTML = byPlat.length ? `<div class="platform-stat-grid">${byPlat.map(p=>
        `<div class="platform-stat-card"><h4>🛵 ${escHtml(p.platform)}</h4>
         <div class="psc-revenue">NT$${Math.round(p.revenue)}</div>
         <div class="psc-detail">訂單${p.count}筆 ｜ 抽成NT$${Math.round(p.commission)} ｜ 實收NT$${Math.round(p.store_income)}</div>
         </div>`).join('')}</div>` : '';
    }
    renderDeliveryTable(delivOrders);
  } catch { showToast('外送報表載入失敗', 'error'); }
}

function renderStatCards(stats) {
  const container = document.getElementById('statCards');
  if (!container) return;
  // _hasDelivery: 明確傳入時才顯示抽成卡片（外送報表分頁）
  const showDelivery = stats._hasDelivery && stats.total_commission > 0;
  container.innerHTML = `
    <div class="stat-card"><div class="stat-card-label">訂單數</div><div class="stat-card-value">${stats.order_count||0}</div><div class="stat-card-sub">筆訂單</div></div>
    <div class="stat-card"><div class="stat-card-label">總營業額</div><div class="stat-card-value">$${Math.round(stats.total_revenue||0)}</div><div class="stat-card-sub">新台幣</div></div>
    <div class="stat-card"><div class="stat-card-label">平均客單價</div><div class="stat-card-value">$${Math.round(stats.avg_order||0)}</div><div class="stat-card-sub">每筆訂單</div></div>
    ${showDelivery ? `<div class="stat-card"><div class="stat-card-label">平台抽成</div><div class="stat-card-value" style="color:var(--danger)">$${Math.round(stats.total_commission)}</div></div><div class="stat-card"><div class="stat-card-label">店家實收</div><div class="stat-card-value" style="color:var(--success)">$${Math.round(stats.total_store_income)}</div></div>` : ''}
    ${stats.top_products?.length ? `<div class="stat-card"><div class="stat-card-label">🏆 熱賣</div><div class="stat-card-value" style="font-size:14px;line-height:1.6">${stats.top_products.slice(0,3).map(p=>`${escHtml(p.name)} <small style="color:#999">×${p.qty}</small>`).join('<br>')}</div></div>` : ''}`;
}

function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersBody');
  if (!orders.length) { tbody.innerHTML = '<tr><td colspan="9" class="table-empty">無訂單</td></tr>'; return; }
  const payLabel = { cash:'現金', card:'刷卡', linepay:'LINE', jkopay:'街口', transfer:'轉帳', platform:'平台' };
  const statusMap = { completed:['status-completed','正常'], modified:['status-modified','已修改'], void:['status-void','已作廢'] };
  const modeLabel = { dine_in:'🍽️ 內用', takeout:'🛍️ 外帶', delivery:'🛵 外送' };
  const ostatusLabel = { pending:'待接單', preparing:'製作中', delivering:'配送中', completed:'已完成', cancelled:'已取消' };
  const ostatusCls   = { pending:'ostatus-pending', preparing:'ostatus-preparing', delivering:'ostatus-delivering', completed:'ostatus-completed', cancelled:'ostatus-cancelled' };

  tbody.innerHTML = orders.map(o => {
    const [sCls, sLabel] = statusMap[o.status] || ['status-completed','正常'];
    const isVoid = o.status === 'void';
    const modeKey = o.order_mode || 'dine_in';
    const ident = o.order_mode === 'dine_in' ? (o.table_number||'—') :
                  o.order_mode === 'takeout'  ? (o.pickup_name||o.customer_name||'—') :
                  (o.delivery_platform||o.customer_name||'—');
    return `
      <tr style="${isVoid?'opacity:0.5':''}">
        <td><span class="order-num">${escHtml(o.order_number)}</span></td>
        <td><span class="mode-badge mode-${modeKey}">${modeLabel[modeKey]||modeKey}</span></td>
        <td style="font-size:12px;color:#999">${o.created_at?.slice(11,19)||''}</td>
        <td style="font-size:13px">${escHtml(ident)}</td>
        <td style="font-size:12px">${o.items.map(i=>`${i.name}×${i.qty}`).join('、')}</td>
        <td style="font-size:12px">${payLabel[o.payment_method]||o.payment_method}</td>
        <td style="font-family:monospace;font-weight:700;color:#f5a623">NT$${o.total}</td>
        <td>
          <span class="order-status ${sCls}">${sLabel}</span>
          ${o.order_status&&o.order_status!=='completed'?`<br><span class="ostatus-badge ${ostatusCls[o.order_status]||''}">${ostatusLabel[o.order_status]||o.order_status}</span>`:''}
        </td>
        <td>
          <div class="order-actions">
            <button class="btn-icon" onclick="showOrderDetail('${o.id}')">📋</button>
            ${!isVoid?`<button class="btn-icon edit-btn" onclick="openEditOrder('${o.id}')">✏️</button>`:''}
            ${!isVoid?`<button class="btn-icon void-btn" onclick="openVoidModal('${o.id}','${escHtml(o.order_number)}','${o.total}')">🚫</button>`:''}
            <button class="btn-icon print-btn" onclick="reprintOrder('${o.id}')">🖨️</button>
            ${o.payment_method==='cash'?`<button class="btn-icon" style="background:var(--success);color:#fff" title="開錢櫃" onclick="openDrawerFromOrder('${o.id}')">💰</button>`:''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

function renderDeliveryTable(orders) {
  const tbody = document.getElementById('deliveryOrdersBody');
  if (!orders || !orders.length) { tbody.innerHTML = '<tr><td colspan="12" class="table-empty">無外送訂單</td></tr>'; return; }
  const payLabel = { cash:'現金', card:'刷卡', linepay:'LINE', jkopay:'街口', transfer:'轉帳', platform:'平台' };
  const statusMap = { completed:['status-completed','正常'], modified:['status-modified','已修改'], void:['status-void','已作廢'] };
  // 外送狀態設定
  const dstatusLabel = { preparing:'製作中', completed:'已完成', cancelled:'已取消' };
  const dstatusCls   = { preparing:'ostatus-preparing', completed:'ostatus-completed', cancelled:'ostatus-cancelled' };

  tbody.innerHTML = orders.map(o => {
    const [sCls, sLabel] = statusMap[o.status] || ['status-completed','正常'];
    const isVoid = o.status === 'void';
    const isCancelled = o.delivery_status === 'cancelled';
    const itemsText = (o.items||[]).map(i => `${escHtml(i.name)}×${i.qty}`).join('、');
    const commText = Number(o.platform_commission_amount) > 0
      ? `NT$${o.platform_commission_amount}（${o.platform_commission_rate}%）`
      : '—';
    // 外送狀態 Dropdown（非作廢才可操作）
    const ds = o.delivery_status || 'preparing';
    const dsOptions = ['preparing','completed','cancelled'].map(v =>
      `<option value="${v}" ${ds===v?'selected':''}>${dstatusLabel[v]||v}</option>`
    ).join('');
    const dsSelect = isVoid
      ? `<span class="ostatus-badge ${dstatusCls[ds]||''}">${dstatusLabel[ds]||ds}</span>`
      : `<select class="delivery-status-select ds-${ds}" onchange="changeDeliveryStatus('${o.id}',this.value)">${dsOptions}</select>`;

    return `
      <tr style="${isVoid||isCancelled ? 'opacity:0.55' : ''}">
        <td><span class="order-num">${escHtml(o.order_number)}</span></td>
        <td style="font-size:12px;color:#999;white-space:nowrap">${o.created_at?.slice(11,19)||''}</td>
        <td style="font-weight:600;color:#ce93d8">${escHtml(o.delivery_platform||'—')}</td>
        <td style="font-size:12px;color:var(--text-muted);font-family:monospace">${escHtml(o.platform_order_no||'—')}</td>
        <td style="font-size:13px">${escHtml(o.customer_name||o.pickup_name||'—')}</td>
        <td style="font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${itemsText}">${itemsText||'—'}</td>
        <td style="font-family:monospace;font-weight:700;color:${isCancelled?'var(--text-muted)':'#f5a623'};white-space:nowrap;${isCancelled?'text-decoration:line-through':''}">NT$${o.total}</td>
        <td style="font-family:monospace;color:${isCancelled?'var(--text-muted)':'var(--danger)'};white-space:nowrap;${isCancelled?'text-decoration:line-through':''}">${commText}</td>
        <td style="font-family:monospace;color:${isCancelled?'var(--text-muted)':'var(--success)'};white-space:nowrap;${isCancelled?'text-decoration:line-through':''}">NT$${o.store_actual_income||o.total}</td>
        <td style="font-size:12px">${payLabel[o.payment_method]||o.payment_method||'—'}</td>
        <td>${dsSelect}</td>
        <td>
          <div class="order-actions">
            <button class="btn-icon" onclick="showOrderDetail('${o.id}')">📋</button>
            ${!isVoid ? `<button class="btn-icon edit-btn" onclick="openEditOrder('${o.id}')">✏️</button>` : ''}
            ${!isVoid ? `<button class="btn-icon void-btn" onclick="openVoidModal('${o.id}','${escHtml(o.order_number)}','${o.total}')">🚫</button>` : ''}
            <button class="btn-icon print-btn" onclick="reprintOrder('${o.id}')">🖨️</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function changeDeliveryStatus(orderId, newStatus) {
  try {
    const res = await fetch(`/api/orders/${orderId}/delivery-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_status: newStatus })
    });
    const json = await res.json();
    if (json.success) {
      const label = { preparing:'製作中', completed:'已完成', cancelled:'已取消' }[newStatus] || newStatus;
      showToast(`狀態已更新：${label}`, 'success');
      // 更新統計（取消可能影響報表）
      loadDeliveryReport();
    } else {
      showToast(json.message || '更新失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

async function showOrderDetail(orderId) {
  try {
    const [orderRes, logsRes] = await Promise.all([
      fetch('/api/orders/' + orderId),
      fetch('/api/orders/' + orderId + '/logs')
    ]);
    const orderJson = await orderRes.json();
    const logsJson  = await logsRes.json();
    if (!orderJson.success) return;
    const o = orderJson.data;
    const logs = logsJson.success ? logsJson.data : [];
    currentOrderForPrint = o;

    const payLabel = { cash:'💵 現金', linepay:'💚 LINE Pay', card:'💳 刷卡', transfer:'🏦 轉帳' };
    const isCash = o.payment_method === 'cash';
    const isVoid = o.status === 'void';
    const statusMap = { completed:'正常', modified:'已修改', void:'已作廢' };

    const logsHtml = logs.length ? `
      <div class="order-log-section">
        <h4>📝 修改 / 作廢記錄（共 ${logs.length} 筆）</h4>
        ${logs.map(l => `
          <div class="log-item">
            <div class="log-item-header">
              <span class="log-action-${l.action}">${l.action === 'void' ? '🚫 作廢' : '✏️ 修改'}</span>
              <span class="log-time">${l.created_at||''}</span>
            </div>
            <div class="log-reason">原因：${escHtml(l.reason||'—')}</div>
            <div class="log-diff">
              金額：NT$${l.before_total} → NT$${l.after_total}
              ${l.amount_diff !== 0 ? `（${l.amount_diff > 0 ? '＋' : ''}${l.amount_diff}）` : ''}
              ｜付款：${l.before_payment} → ${l.after_payment}
            </div>
          </div>`).join('')}
      </div>` : '';

    document.getElementById('orderDetailBody').innerHTML = `
      <div style="padding:16px 20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <p style="font-family:monospace;color:#f5a623">訂單：${escHtml(o.order_number)}</p>
          <span class="order-status ${isVoid?'status-void':o.status==='modified'?'status-modified':'status-completed'}">${statusMap[o.status]||'正常'}</span>
        </div>
        <p style="font-size:12px;color:#999;margin-bottom:16px">${o.created_at}</p>
        ${isVoid ? `<div style="background:#2a0a0a;border:1px solid var(--danger);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:var(--danger)">🚫 作廢原因：${escHtml(o.void_reason||'—')}</div>` : ''}
        <div class="receipt-body" style="margin:0;padding:0;border-bottom:1px dashed #333;padding-bottom:12px;margin-bottom:12px">
          ${o.items.map(i=>`
            <div class="receipt-item">
              <span class="receipt-item-name">${escHtml(i.name)}</span>
              <span class="receipt-item-qty">x${i.qty}</span>
              <span class="receipt-item-price">$${i.subtotal}</span>
            </div>`).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>付款方式</span><span>${payLabel[o.payment_method]||o.payment_method}</span>
        </div>
        ${o.customer_name||o.customer_phone ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>顧客</span><span>${escHtml(o.customer_name||'')} ${escHtml(o.customer_phone||'')}</span>
        </div>` : ''}
        ${o.note ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px;color:#999">
          <span>備註</span><span>${escHtml(o.note)}</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:20px;font-weight:900;margin-top:12px;border-top:1px solid #333;padding-top:12px">
          <span>應收</span><span style="color:#f5a623;font-family:monospace">NT$${o.total}</span>
        </div>
        ${isCash ? `
        <div style="display:flex;justify-content:space-between;font-size:14px;padding-top:6px;color:#999">
          <span>實收</span><span style="font-family:monospace">NT$${o.received_amount||0}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:14px;padding-top:4px;color:#4caf50">
          <span>找零</span><span style="font-family:monospace">NT$${o.change_amount||0}</span>
        </div>` : ''}
      </div>
      ${logsHtml}
    `;
    document.getElementById('orderDetailModal').classList.add('open');
  } catch(e) {
    showToast('載入失敗：' + e.message, 'error');
  }
}

function closeOrderDetail() {
  document.getElementById('orderDetailModal').classList.remove('open');
  currentOrderForPrint = null;
}

// ===== 商品管理頁 =====
async function loadProductsPage() {
  try {
    const res = await fetch('/api/products');
    const json = await res.json();
    if (json.success) renderProductsTable(json.data);
  } catch {
    showToast('商品載入失敗', 'error');
  }
}

function renderProductsTable(products) {
  const tbody = document.getElementById('productsBody');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">尚無商品</td></tr>';
    return;
  }
  const catEmoji = {};
  allCategories.forEach(c => { catEmoji[c.name] = c.icon || '📌'; });
  tbody.innerHTML = products.map(p => {
    const imgSrc = p.image || getLocalImage(p.id) || '';
    const thumbHtml = imgSrc
      ? `<img class="product-thumb" src="${escAttr(imgSrc)}" alt="${escAttr(p.name)}" onerror="this.outerHTML='<div class=\\'product-thumb-placeholder\\'>${catEmoji[p.category]||'🍽️'}</div>'">`
      : `<div class="product-thumb-placeholder">${catEmoji[p.category] || '🍽️'}</div>`;

    let invBadge = '';
    if (p.inventory_enabled) {
      const units = p.available_units !== null ? p.available_units : 0;
      const cls = units <= 0 ? 'status-void' : p.is_low_stock ? 'status-modified' : 'status-completed';
      invBadge = `<br><span class="order-status ${cls}" style="margin-top:4px;display:inline-block">${units <= 0 ? '售完' : `庫存${units}份`}</span>`;
    }
    return `
      <tr>
        <td>${thumbHtml}</td>
        <td style="font-weight:600">${escHtml(p.name)}${invBadge}</td>
        <td>${catEmoji[p.category] || ''} ${p.category}</td>
        <td style="font-family:monospace;color:#f5a623;font-weight:700">$${p.price}</td>
        <td><span class="status-badge ${p.enabled ? 'status-on' : 'status-off'}">${p.enabled ? '販售中' : '已停用'}</span></td>
        <td>
          <button class="btn-icon" onclick="openProductModal(${p.id})" style="margin-right:4px">✏️ 編輯</button>
          <button class="btn-icon danger" onclick="deleteProduct(${p.id})">🗑️ 刪除</button>
        </td>
      </tr>`;
  }).join('');
}

function openProductModal(id) {
  _imageCleared = false;  // 重置清除旗標
  document.getElementById('editProductId').value = id || '';
  document.getElementById('editProductImage').value = '';
  document.getElementById('editProductImageUrl').value = '';
  document.getElementById('productModalTitle').textContent = id ? '編輯商品' : '新增商品';
  document.getElementById('editProductName').value = '';
  document.getElementById('editProductPrice').value = '';
  // 重置多模式價格
  const safeSet = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  safeSet('editDineInPrice', '');
  safeSet('editTakeawayPrice', '');
  safeSet('editDeliveryPrice', '');
  document.getElementById('editProductEnabled').checked = true;
  document.getElementById('editInventoryEnabled').checked = false;
  document.getElementById('editAllocatedGrams').value = '';
  document.getElementById('editCurrentStockGrams').value = '';
  document.getElementById('editLowStockAlert').value = '5';
  setImagePreview('');
  toggleInventoryFields();

  // 動態分類選單
  const catSel = document.getElementById('editProductCategory');
  if (catSel) {
    catSel.innerHTML = allCategories.map(c =>
      `<option value="${escHtml(c.name)}">${c.icon||''} ${escHtml(c.name)}</option>`
    ).join('');
    if (!catSel.options.length) catSel.innerHTML = '<option value="主食">🍚 主食</option>';
  }

  if (id) {
    fetch('/api/products/' + id).then(r => r.json()).then(json => {
      if (json.success) {
        const p = json.data;
        document.getElementById('editProductName').value = p.name;
        if (catSel) catSel.value = p.category;
        document.getElementById('editProductPrice').value = p.price;
        // 載入多模式價格
        const safeSet = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        safeSet('editDineInPrice',   p.dine_in_price || '');
        safeSet('editTakeawayPrice', p.takeaway_price || '');
        safeSet('editDeliveryPrice', p.delivery_price || '');
        document.getElementById('editProductEnabled').checked = !!p.enabled;
        document.getElementById('editInventoryEnabled').checked = !!p.inventory_enabled;
        document.getElementById('editAllocatedGrams').value = p.allocated_grams || '';
        document.getElementById('editCurrentStockGrams').value = p.current_stock_grams || '';
        document.getElementById('editLowStockAlert').value = p.low_stock_alert || 5;
        toggleInventoryFields();
        // 載入圖片：優先 server，再查 localStorage（但若已清除不重帶）
        const imgSrc = p.image || getLocalImage(p.id) || '';
        document.getElementById('editProductImage').value = imgSrc;
        if (imgSrc) {
          document.getElementById('editProductImageUrl').value = imgSrc.startsWith('data:') ? '' : imgSrc;
          setImagePreview(imgSrc);
        }
      }
    });
  }
  document.getElementById('productModal').classList.add('open');
}

function toggleInventoryFields() {
  const enabled = document.getElementById('editInventoryEnabled')?.checked;
  const fields = document.getElementById('inventoryFields');
  if (fields) fields.style.display = enabled ? 'block' : 'none';
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('open');
}

async function saveProduct() {
  const id = document.getElementById('editProductId').value;
  const name = document.getElementById('editProductName').value.trim();
  const catSel = document.getElementById('editProductCategory');
  const category = catSel ? catSel.value : '主食';
  const price = document.getElementById('editProductPrice').value;
  const enabled = document.getElementById('editProductEnabled').checked ? 1 : 0;
  const image = document.getElementById('editProductImage').value || '';
  const inventory_enabled = document.getElementById('editInventoryEnabled')?.checked ? 1 : 0;
  const allocated_grams     = parseFloat(document.getElementById('editAllocatedGrams')?.value || '0') || 0;
  const current_stock_grams = parseFloat(document.getElementById('editCurrentStockGrams')?.value || '0') || 0;
  const low_stock_alert     = parseInt(document.getElementById('editLowStockAlert')?.value || '5') || 5;
  // 多模式價格（空白時後端自動 fallback 到定價）
  const dine_in_price  = parseFloat(document.getElementById('editDineInPrice')?.value || '') || null;
  const takeaway_price = parseFloat(document.getElementById('editTakeawayPrice')?.value || '') || null;
  const delivery_price = parseFloat(document.getElementById('editDeliveryPrice')?.value || '') || null;

  if (!name || !price) { showToast('名稱與價格為必填', 'error'); return; }

  // 決定送給 server 的圖片值
  let serverImage = image;
  if (_imageCleared) {
    serverImage = '';
  } else if (image.startsWith('data:')) {
    const approxKb = Math.round(image.length * 0.75 / 1024);
    if (approxKb > 300) { serverImage = ''; showToast(`圖片較大(${approxKb}KB)，已暫存於本機`, 'info'); }
  }

  const body = { name, category, price: parseFloat(price), enabled, image: serverImage,
    inventory_enabled, allocated_grams, current_stock_grams, low_stock_alert,
    dine_in_price, takeaway_price, delivery_price };
  const url = id ? '/api/products/' + id : '/api/products';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (json.success) {
      const productId = json.data?.id;

      if (_imageCleared && productId) {
        // 使用者清除圖片：清除 localStorage 快取 + 更新記憶體快取
        removeLocalImage(productId);
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = '';
        _imageCleared = false;
      } else if (image.startsWith('data:') && productId) {
        // base64 大圖：存 localStorage + 更新記憶體快取
        saveLocalImage(productId, image);
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = image;
      } else if (image && productId) {
        // URL 圖片：更新記憶體快取
        const idx = allProducts.findIndex(p => p.id === productId);
        if (idx !== -1) allProducts[idx].image = image;
      }

      showToast(id ? '商品已更新' : '商品已新增', 'success');
      closeProductModal();
      loadProductsPage();
      loadProducts();
    } else {
      showToast(json.message || '儲存失敗', 'error');
    }
  } catch {
    showToast('網路錯誤', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('確定要刪除此商品？')) return;
  try {
    const res = await fetch('/api/products/' + id, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      removeLocalImage(id);  // 清除 localStorage 圖片快取
      showToast('商品已刪除', 'success');
      loadProductsPage();
      loadProducts();
    } else {
      showToast(json.message || '刪除失敗', 'error');
    }
  } catch {
    showToast('網路錯誤', 'error');
  }
}

// ===== 重新列印 =====
async function reprintOrder(orderId) {
  try {
    const res = await fetch('/api/orders/' + orderId);
    const json = await res.json();
    if (json.success) {
      openPrintWindow(json.data, 'receipt');
      // 非同步通知後端（預留熱感列表機接口）
      fetch('/api/orders/' + orderId + '/reprint', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'receipt'}) }).catch(()=>{});
    }
  } catch { showToast('列印失敗', 'error'); }
}

// ===== 作廢訂單 =====
function openVoidModal(orderId, orderNum, amount) {
  document.getElementById('voidOrderId').value = orderId;
  document.getElementById('voidOrderNum').textContent = orderNum;
  document.getElementById('voidOrderAmount').textContent = 'NT$' + amount;
  document.getElementById('voidReason').value = '';
  document.getElementById('voidOrderModal').classList.add('open');
}
function closeVoidModal() {
  document.getElementById('voidOrderModal').classList.remove('open');
}
async function confirmVoid() {
  const id = document.getElementById('voidOrderId').value;
  const reason = document.getElementById('voidReason').value;
  if (!reason) { showToast('請選擇作廢原因', 'error'); return; }
  try {
    const res = await fetch('/api/orders/' + id + '/void', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const json = await res.json();
    if (json.success) {
      showToast('訂單已作廢，庫存已回補', 'success');
      closeVoidModal();
      loadOrders();
      // 作廢後後端回補庫存，立即重載點餐頁商品
      _invProducts = [];
      loadProducts();
    } else {
      showToast(json.message || '作廢失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

// ===== 訂單編輯 =====
async function openEditOrder(orderId) {
  try {
    const res = await fetch('/api/orders/' + orderId);
    const json = await res.json();
    if (!json.success) { showToast('載入訂單失敗', 'error'); return; }
    const o = json.data;
    editOrderId = o.id;
    editOrderItems = o.items.map(i => ({ ...i }));

    document.getElementById('editOrderId').value = o.id;
    document.getElementById('editOrderNum').textContent = o.order_number;
    document.getElementById('editOrderPayment').value = o.payment_method;
    document.getElementById('editCustomerName').value = o.customer_name || '';
    document.getElementById('editCustomerPhone').value = o.customer_phone || '';
    document.getElementById('editOrderNote').value = o.note || '';
    document.getElementById('editOrderReason').value = '';
    document.getElementById('editReceivedAmount').value = o.payment_method === 'cash' ? (o.received_amount || '') : '';

    // 填入可選商品清單
    const sel = document.getElementById('addItemSelect');
    sel.innerHTML = '<option value="">選擇商品...</option>' +
      allProducts.map(p => `<option value="${p.id}" data-price="${p.price}" data-name="${escHtml(p.name)}">${p.name} — NT$${p.price}</option>`).join('');

    document.getElementById('addItemPanel').style.display = 'none';
    onEditPaymentChange();
    renderEditOrderItems();
    document.getElementById('editOrderModal').classList.add('open');
  } catch(e) { showToast('載入失敗：' + e.message, 'error'); }
}

function closeEditOrder() {
  document.getElementById('editOrderModal').classList.remove('open');
  editOrderId = null;
  editOrderItems = [];
}

function renderEditOrderItems() {
  const total = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  document.getElementById('editOrderItems').innerHTML = editOrderItems.length
    ? editOrderItems.map((item, idx) => `
        <div class="edit-item-row">
          <span class="edit-item-name">${escHtml(item.name)}</span>
          <span class="edit-item-price">$${item.price}</span>
          <div class="cart-item-qty" style="gap:4px">
            <button class="qty-btn" onclick="editItemQty(${idx},-1)">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="editItemQty(${idx},1)">＋</button>
          </div>
          <span class="edit-item-subtotal">$${item.price*item.qty}</span>
          <button class="cart-item-del" onclick="removeEditItem(${idx})">✕</button>
        </div>`).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-muted)">暫無商品</div>';

  document.getElementById('editOrderNewTotal').textContent = 'NT$' + total;
  calcEditChange();
  updateEditAmountDiff(total);
}

function editItemQty(idx, delta) {
  editOrderItems[idx].qty += delta;
  if (editOrderItems[idx].qty <= 0) editOrderItems.splice(idx, 1);
  else editOrderItems[idx].subtotal = editOrderItems[idx].price * editOrderItems[idx].qty;
  renderEditOrderItems();
}

function removeEditItem(idx) {
  editOrderItems.splice(idx, 1);
  renderEditOrderItems();
}

function openAddItemToOrder() {
  document.getElementById('addItemPanel').style.display = 'block';
  document.getElementById('addItemQty').value = 1;
  document.getElementById('addItemSelect').value = '';
}

function confirmAddItem() {
  const sel = document.getElementById('addItemSelect');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) { showToast('請選擇商品', 'error'); return; }
  const qty = parseInt(document.getElementById('addItemQty').value) || 1;
  const pid = parseInt(opt.value);
  const price = parseFloat(opt.dataset.price);
  const name = opt.dataset.name;
  const existing = editOrderItems.find(i => i.productId === pid || i.name === name);
  if (existing) { existing.qty += qty; existing.subtotal = existing.price * existing.qty; }
  else editOrderItems.push({ productId: pid, name, price, qty, subtotal: price * qty });
  document.getElementById('addItemPanel').style.display = 'none';
  renderEditOrderItems();
}

function onEditPaymentChange() {
  const method = document.getElementById('editOrderPayment').value;
  const panel = document.getElementById('editCashPanel');
  if (panel) panel.style.display = method === 'cash' ? 'block' : 'none';
}

function calcEditChange() {
  const total = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  const method = document.getElementById('editOrderPayment')?.value;
  const recvEl = document.getElementById('editReceivedAmount');
  const chngEl = document.getElementById('editChangeAmount');
  const warnEl = document.getElementById('editCashWarn');
  if (!recvEl) return;
  if (method !== 'cash') {
    if (chngEl) chngEl.textContent = 'NT$0';
    if (warnEl) warnEl.style.display = 'none';
    return;
  }
  const recv = parseFloat(recvEl.value) || 0;
  const change = recv - total;
  if (chngEl) chngEl.textContent = change >= 0 ? 'NT$' + change : 'NT$0';
  if (warnEl) warnEl.style.display = (recv > 0 && change < 0) ? 'block' : 'none';
}

// 儲存當前原始金額用於計算差異
let _editOriginalTotal = 0;
async function updateEditAmountDiff(newTotal) {
  // 取出原始金額
  if (!editOrderId) return;
  if (!_editOriginalTotal) {
    const r = await fetch('/api/orders/' + editOrderId);
    const j = await r.json();
    if (j.success) _editOriginalTotal = j.data.total;
  }
  const diff = newTotal - _editOriginalTotal;
  const banner = document.getElementById('editAmountDiff');
  if (!banner) return;
  if (diff > 0) {
    banner.style.display = 'block';
    banner.className = 'amount-diff-banner diff-surcharge';
    banner.textContent = `需補收 NT$${diff}`;
  } else if (diff < 0) {
    banner.style.display = 'block';
    banner.className = 'amount-diff-banner diff-refund';
    banner.textContent = `需退款 NT$${Math.abs(diff)}`;
  } else {
    banner.style.display = 'none';
  }
}

async function saveEditOrder() {
  const reason = document.getElementById('editOrderReason').value;
  if (!reason) { showToast('請選擇修改原因', 'error'); return; }
  if (!editOrderItems.length) { showToast('商品不能為空', 'error'); return; }

  const payment = document.getElementById('editOrderPayment').value;
  const isCash = payment === 'cash';
  const newTotal = editOrderItems.reduce((s,i) => s + i.price * i.qty, 0);
  const received = isCash ? (parseFloat(document.getElementById('editReceivedAmount').value) || 0) : newTotal;

  if (isCash && received < newTotal) { showToast('實收金額不足', 'error'); return; }

  const payload = {
    items: editOrderItems.map(i => ({ ...i, subtotal: i.price * i.qty })),
    payment_method: payment,
    customer_name: document.getElementById('editCustomerName').value.trim(),
    customer_phone: document.getElementById('editCustomerPhone').value.trim(),
    note: document.getElementById('editOrderNote').value.trim(),
    received_amount: received,
    reason
  };

  try {
    const res = await fetch('/api/orders/' + editOrderId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      const diff = json.diff;
      if (diff?.type === 'surcharge') showToast(`已儲存，需補收 NT$${diff.amount}`, 'success');
      else if (diff?.type === 'refund') showToast(`已儲存，需退款 NT$${diff.amount}`, 'success');
      else showToast('訂單已修改', 'success');
      _editOriginalTotal = 0;
      closeEditOrder();
      loadOrders();
      // 訂單修改後後端已同步庫存，重載點餐頁
      _invProducts = [];
      loadProducts();
    } else {
      showToast(json.message || '修改失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}

// ===== Toast =====
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

// ===== 工具函式 =====
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== 圖片 localStorage 快取 =====
// 用於暫存 base64 大圖，key = pos_img_{productId}
function saveLocalImage(productId, dataUrl) {
  try {
    localStorage.setItem(`pos_img_${productId}`, dataUrl);
  } catch (e) {
    // localStorage 滿了：清掉最舊的
    try {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('pos_img_'));
      if (keys.length) { localStorage.removeItem(keys[0]); }
      localStorage.setItem(`pos_img_${productId}`, dataUrl);
    } catch {}
  }
}

function getLocalImage(productId) {
  try {
    return localStorage.getItem(`pos_img_${productId}`) || null;
  } catch { return null; }
}

function removeLocalImage(productId) {
  try { localStorage.removeItem(`pos_img_${productId}`); } catch {}
}

// ===== 圖片上傳處理 =====

// 讀取上傳的檔案，壓縮後設為預覽
function handleImageFile(event) {
  const file = event.target?.files?.[0] || event.file;
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('請選擇圖片檔案', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const original = e.target.result;
    compressImage(original, 600, 0.82, (compressed) => {
      document.getElementById('editProductImage').value = compressed;
      document.getElementById('editProductImageUrl').value = '';
      setImagePreview(compressed);
    });
    // 重置 input 讓同一檔案可再次選擇（在 onload 後，不在 change 時立即重置）
    const inp = document.getElementById('imgFileInput');
    if (inp) inp.value = '';
  };
  reader.readAsDataURL(file);
}

// 壓縮圖片到指定最大尺寸
function compressImage(dataUrl, maxSize, quality, callback) {
  const img = new Image();
  img.onload = () => {
    let w = img.width, h = img.height;
    if (w > maxSize || h > maxSize) {
      if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
      else { w = Math.round(w * maxSize / h); h = maxSize; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL('image/jpeg', quality));
  };
  img.src = dataUrl;
}

// 處理 URL 輸入
function handleImageUrl(value) {
  const url = value.trim();
  if (!url) {
    const current = document.getElementById('editProductImage').value;
    if (!current.startsWith('data:')) {
      setImagePreview('');
      document.getElementById('editProductImage').value = '';
    }
    return;
  }
  document.getElementById('editProductImage').value = url;
  setImagePreview(url);
}

// 設定 modal 內的圖片預覽
// 修正：base64 不走 onerror（data: URI 不會失敗），URL 才掛 onerror
function setImagePreview(src) {
  const preview     = document.getElementById('imgPreview');
  const placeholder = document.getElementById('imgPlaceholder');
  const actions     = document.getElementById('imgActions');
  if (!preview) return;

  // 先清除舊的 onerror，避免殘留
  preview.onerror = null;

  if (src) {
    placeholder.style.display = 'none';
    actions.style.display = 'flex';
    preview.style.display = 'block';

    if (src.startsWith('data:')) {
      // base64：直接設定，不需要 onerror
      preview.src = src;
    } else {
      // URL：掛 onerror
      preview.onerror = () => {
        preview.style.display = 'none';
        preview.onerror = null;
        placeholder.style.display = 'flex';
        actions.style.display = 'none';
        showToast('圖片網址無法載入，請確認連結', 'error');
      };
      preview.src = src;
    }
  } else {
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
    actions.style.display = 'none';
  }
}

// 清除圖片
// 記錄「使用者主動清除圖片」旗標，確保儲存時送空值到 server
let _imageCleared = false;

function clearProductImage() {
  _imageCleared = true;
  document.getElementById('editProductImage').value = '';
  document.getElementById('editProductImageUrl').value = '';
  // 同步清除 localStorage 快取（若是編輯既有商品）
  const pid = document.getElementById('editProductId').value;
  if (pid) removeLocalImage(Number(pid));
  setImagePreview('');
  showToast('圖片已移除', 'info');
}

// ===== 拖曳上傳 + click 綁定（統一由 JS 管理，避免 HTML onclick 雙觸發）=====
document.addEventListener('DOMContentLoaded', () => {
  const area  = document.getElementById('imgUploadArea');
  const input = document.getElementById('imgFileInput');
  if (!area || !input) return;

  // 單一 click 綁定：只在 area 上，不在 HTML onclick 屬性
  area.addEventListener('click', () => input.click());

  // file input change
  input.addEventListener('change', (e) => handleImageFile(e));

  // 拖曳
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleImageFile({ file });
    }
  });
});

// =============================================
// ===== 分類管理 =====
// =============================================

let allCatsAdmin = [];

async function loadCategoriesPage() {
  try {
    const res = await fetch('/api/categories');
    const json = await res.json();
    if (json.success) {
      allCatsAdmin = json.data;
      renderCategoriesTable(json.data);
    }
  } catch { showToast('分類載入失敗', 'error'); }
}

function renderCategoriesTable(cats) {
  const tbody = document.getElementById('categoriesBody');
  if (!cats.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">尚無分類</td></tr>';
    return;
  }
  tbody.innerHTML = cats.map(c => `
    <tr>
      <td><span class="cat-icon-big">${c.icon||'📌'}</span></td>
      <td style="font-weight:700">${escHtml(c.name)}</td>
      <td style="color:var(--text-muted)">${c.sort_order}</td>
      <td><span class="status-badge ${c.is_active?'status-on':'status-off'}">${c.is_active?'啟用':'停用'}</span></td>
      <td>
        <button class="btn-icon" style="margin-right:4px" onclick="openCatModal(${c.id})">✏️ 編輯</button>
        <button class="btn-icon" style="margin-right:4px" onclick="toggleCatActive(${c.id},${c.is_active})">${c.is_active?'⏸️ 停用':'▶️ 啟用'}</button>
        <button class="btn-icon danger" onclick="deleteCat(${c.id})">🗑️ 刪除</button>
      </td>
    </tr>`).join('');
}

function openCatModal(id) {
  document.getElementById('editCatId').value = id || '';
  document.getElementById('catModalTitle').textContent = id ? '編輯分類' : '新增分類';
  document.getElementById('editCatIcon').value = '';
  document.getElementById('editCatName').value = '';
  document.getElementById('editCatOrder').value = '0';
  document.getElementById('editCatActive').checked = true;
  if (id) {
    const cat = allCatsAdmin.find(c => c.id === id);
    if (cat) {
      document.getElementById('editCatIcon').value = cat.icon || '';
      document.getElementById('editCatName').value = cat.name;
      document.getElementById('editCatOrder').value = cat.sort_order;
      document.getElementById('editCatActive').checked = !!cat.is_active;
    }
  }
  document.getElementById('catModal').classList.add('open');
}

function closeCatModal() {
  document.getElementById('catModal').classList.remove('open');
}

async function saveCat() {
  const id   = document.getElementById('editCatId').value;
  const name = document.getElementById('editCatName').value.trim();
  const icon = document.getElementById('editCatIcon').value.trim() || '📌';
  const sort_order = parseInt(document.getElementById('editCatOrder').value) || 0;
  const is_active  = document.getElementById('editCatActive').checked ? 1 : 0;
  if (!name) { showToast('分類名稱必填', 'error'); return; }
  const url    = id ? '/api/categories/' + id : '/api/categories';
  const method = id ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify({name,icon,sort_order,is_active}) });
    const json = await res.json();
    if (json.success) {
      showToast(id ? '分類已更新' : '分類已新增', 'success');
      closeCatModal();
      loadCategoriesPage();
      loadCategories(); // 更新 POS Tab
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

async function toggleCatActive(id, currentActive) {
  try {
    const res  = await fetch('/api/categories/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ is_active: currentActive ? 0 : 1 }) });
    const json = await res.json();
    if (json.success) { loadCategoriesPage(); loadCategories(); showToast('已更新分類狀態', 'success'); }
  } catch { showToast('操作失敗', 'error'); }
}

async function deleteCat(id) {
  if (!confirm('確認刪除此分類？')) return;
  try {
    const res  = await fetch('/api/categories/' + id, { method:'DELETE' });
    const json = await res.json();
    if (json.success) { showToast('分類已刪除', 'success'); loadCategoriesPage(); loadCategories(); }
    else { showToast(json.message || '刪除失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 庫存管理 =====
// =============================================

async function loadInventoryPage() {
  try {
    const [invRes, statsRes] = await Promise.all([
      fetch('/api/inventory'),
      fetch('/api/stats/today')
    ]);
    const invJson   = await invRes.json();
    const statsJson = await statsRes.json();

    if (invJson.success) renderInventoryTable(invJson.data);
    if (statsJson.success && statsJson.data.low_stock_alerts?.length) {
      renderLowStockAlerts(statsJson.data.low_stock_alerts);
    } else {
      document.getElementById('lowStockAlerts').innerHTML = '';
    }
  } catch { showToast('庫存載入失敗', 'error'); }
}

function renderLowStockAlerts(items) {
  if (!items.length) { document.getElementById('lowStockAlerts').innerHTML = ''; return; }
  document.getElementById('lowStockAlerts').innerHTML = `
    <div class="low-stock-banner">
      <h4>⚠️ 低庫存警示（${items.length} 項商品）</h4>
      ${items.map(p => `
        <div class="low-stock-item">
          <span>${escHtml(p.name)}</span>
          <span class="inv-stock-low">剩 ${p.available_units} 份（${p.current_stock_grams}g）</span>
        </div>`).join('')}
    </div>`;
}

function renderInventoryTable(products) {
  const tbody = document.getElementById('inventoryBody');
  const noNote = document.getElementById('noInventoryNote');
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">無庫存管理商品</td></tr>';
    if (noNote) noNote.style.display = 'block';
    return;
  }
  if (noNote) noNote.style.display = 'none';
  tbody.innerHTML = products.map(p => {
    const units = p.available_units;
    const stockCls = units <= 0 ? 'inv-stock-empty' : p.is_low_stock ? 'inv-stock-low' : 'inv-stock-ok';
    const statusText = units <= 0 ? '已售完' : p.is_low_stock ? '低庫存' : '正常';
    const statusCls  = units <= 0 ? 'status-void' : p.is_low_stock ? 'status-modified' : 'status-completed';
    return `
      <tr>
        <td style="font-weight:600">${escHtml(p.name)}</td>
        <td style="font-family:monospace">${p.allocated_grams}g</td>
        <td style="font-family:monospace">${Number(p.current_stock_grams).toFixed(0)}g</td>
        <td class="${stockCls}">${units} 份</td>
        <td style="font-family:monospace;color:var(--text-muted)">${p.low_stock_alert} 份</td>
        <td><span class="order-status ${statusCls}">${statusText}</span></td>
        <td>
          <button class="btn-icon edit-btn" style="margin-right:4px" onclick="openRestockModal(${p.id})">📦 補貨</button>
          <button class="btn-icon" onclick="openAdjustModal(${p.id})">🔧 調整</button>
        </td>
      </tr>`;
  }).join('');
}

// ── 補貨 Modal ────────────────────────────────────────────
let _invProducts = [];
async function _ensureInvProducts() {
  if (!_invProducts.length) {
    const r = await fetch('/api/inventory');
    const j = await r.json();
    if (j.success) _invProducts = j.data;
  }
}

async function openRestockModal(productId) {
  await _ensureInvProducts();
  const p = _invProducts.find(x => x.id === productId);
  if (!p) return;
  document.getElementById('restockProductId').value = productId;
  document.getElementById('restockProductName').textContent = p.name;
  document.getElementById('restockCurrentInfo').textContent =
    `目前庫存：${Number(p.current_stock_grams).toFixed(0)}g（可售 ${p.available_units} 份）`;
  document.getElementById('restockGrams').value = '';
  document.getElementById('restockReason').value = '補貨';
  document.getElementById('restockModal').classList.add('open');
}

function closeRestockModal() { document.getElementById('restockModal').classList.remove('open'); }

async function confirmRestock() {
  const pid  = document.getElementById('restockProductId').value;
  const grams  = parseFloat(document.getElementById('restockGrams').value);
  const reason = document.getElementById('restockReason').value || '補貨';
  if (!grams || grams <= 0) { showToast('請輸入有效補貨克數', 'error'); return; }
  try {
    const res  = await fetch('/api/inventory/restock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ product_id:pid, add_grams:grams, reason }) });
    const json = await res.json();
    if (json.success) {
      const units = json.data.available_units;
      showToast(`補貨成功！現在可售 ${units} 份`, 'success');
      closeRestockModal();
      _invProducts = [];
      loadInventoryPage();
      loadProducts();
    } else { showToast(json.message || '補貨失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// ── 調整 Modal ────────────────────────────────────────────
async function openAdjustModal(productId) {
  await _ensureInvProducts();
  const p = _invProducts.find(x => x.id === productId);
  if (!p) return;
  document.getElementById('adjustProductId').value = productId;
  document.getElementById('adjustProductName').textContent = p.name;
  document.getElementById('adjustCurrentInfo').textContent =
    `目前庫存：${Number(p.current_stock_grams).toFixed(0)}g（可售 ${p.available_units} 份）`;
  document.getElementById('adjustGrams').value = '';
  document.getElementById('adjustModal').classList.add('open');
}

function closeAdjustModal() { document.getElementById('adjustModal').classList.remove('open'); }

async function confirmAdjust() {
  const pid    = document.getElementById('adjustProductId').value;
  const grams  = parseFloat(document.getElementById('adjustGrams').value);
  const reason = document.getElementById('adjustReason').value || '手動調整';
  if (grams === undefined || isNaN(grams)) { showToast('請輸入調整克數', 'error'); return; }
  try {
    const res  = await fetch('/api/inventory/adjust', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ product_id:pid, change_grams:grams, reason }) });
    const json = await res.json();
    if (json.success) {
      showToast(`調整成功！現在可售 ${json.data.available_units} 份`, 'success');
      closeAdjustModal();
      _invProducts = [];
      loadInventoryPage();
      loadProducts();
    } else { showToast(json.message || '調整失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// ── 庫存紀錄 ──────────────────────────────────────────────
async function showInventoryLogs(productId) {
  const url = productId ? `/api/inventory/logs?product_id=${productId}&limit=100` : '/api/inventory/logs?limit=100';
  try {
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.success) return;
    const logs = json.data;
    const actionLabel = { sale:'售出', restock:'補貨', manual_adjust:'手動調整', void_return:'作廢回補', order_modify_return:'修改回補' };
    document.getElementById('invLogsBody').innerHTML = logs.length
      ? `<table class="data-table" style="font-size:12px">
          <thead><tr><th>時間</th><th>商品</th><th>動作</th><th>變化(g)</th><th>後庫存(g)</th><th>原因</th></tr></thead>
          <tbody>
          ${logs.map(l => `
            <tr>
              <td style="font-family:monospace;white-space:nowrap">${l.created_at?.slice(0,16)||''}</td>
              <td>${escHtml(l.product_name)}</td>
              <td><span class="order-status ${l.action.includes('return')||l.action==='restock'?'status-completed':l.action==='sale'?'status-modified':'status-completed'}">${actionLabel[l.action]||l.action}</span></td>
              <td style="font-family:monospace;color:${l.change_grams>=0?'#4caf50':'#e53935'}">${l.change_grams>=0?'+':''}${l.change_grams}g</td>
              <td style="font-family:monospace">${l.after_grams}g</td>
              <td style="color:var(--text-muted)">${escHtml(l.reason||'')}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : '<div style="text-align:center;color:var(--text-muted);padding:40px">尚無庫存紀錄</div>';
    document.getElementById('invLogsModal').classList.add('open');
  } catch { showToast('載入失敗', 'error'); }
}

function closeInvLogs() { document.getElementById('invLogsModal').classList.remove('open'); }

// =============================================
// ===== 點餐模式切換 =====
// =============================================

async function loadPlatforms() {
  try {
    const res  = await fetch('/api/platforms?active=1');
    const json = await res.json();
    if (json.success) {
      allPlatforms = json.data;
      renderPlatformChips();
    }
  } catch {}
}

function renderPlatformChips() {
  const sel = document.getElementById('platformSelector');
  if (!sel) return;
  sel.innerHTML = allPlatforms.map(p =>
    `<button type="button" class="platform-chip" data-id="${p.id}" data-name="${escHtml(p.name)}" data-rate="${p.commission_rate}" onclick="selectDeliveryPlatform(this)">${escHtml(p.name)}</button>`
  ).join('');
}

function selectDeliveryPlatform(el) {
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedPlatform = { id: Number(el.dataset.id), name: el.dataset.name, commission_rate: Number(el.dataset.rate) };
  updateDeliveryCalc();
}

function switchOrderMode(mode) {
  currentOrderMode = mode;
  selectedPlatform = null;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  // 切換各模式欄位（不清空已輸入資料）
  ['dine_in','takeout','delivery'].forEach(m => {
    const el = document.getElementById('fields-' + m);
    if (el) el.style.display = m === mode ? 'flex' : 'none';
  });

  // 外送：顯示平台選擇
  const platWrap = document.getElementById('delivery-platform-wrap');
  if (platWrap) platWrap.style.display = mode === 'delivery' ? 'block' : 'none';

  // 更新標題
  const titles = { dine_in:'📝 內用點餐', takeout:'🛍️ 外帶點餐', delivery:'🛵 外送點餐' };
  const titleEl = document.getElementById('cartTitle');
  if (titleEl) titleEl.textContent = titles[mode] || '📝 點餐';

  // 重置平台選擇
  document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('selected'));
  selectedPlatform = null;

  // 若購物車已有商品，提示不自動改價
  if (cart.length > 0) {
    showToast('切換訂單模式不會更改已加入商品價格', 'info');
  }

  // 重繪商品卡（更新顯示價格）
  renderProductGrid();

  // 重新渲染付款方式（依模式不同）
  renderPaymentMethods();

  updateDeliveryCalc();
}

function updateDeliveryCalc() {
  const calcEl = document.getElementById('deliveryCalc');
  if (!calcEl) return;
  if (currentOrderMode !== 'delivery' || !selectedPlatform) { calcEl.style.display = 'none'; return; }
  const subtotal = cart.reduce((s,i) => s+i.subtotal, 0);
  const rate     = selectedPlatform.commission_rate;
  const comm     = Math.round(subtotal * rate / 100 * 100) / 100;
  const income   = subtotal - comm;
  document.getElementById('dcSubtotal').textContent   = 'NT$' + subtotal;
  document.getElementById('dcPlatformName').textContent = selectedPlatform.name;
  document.getElementById('dcRate').textContent         = rate + '%';
  document.getElementById('dcCommission').textContent  = 'NT$' + comm;
  document.getElementById('dcStoreIncome').textContent = 'NT$' + income;
  calcEl.style.display = 'block';
}

// 結帳後重繪外送計算（因為購物車清空）
const _origClearCart = clearCart;

// 覆寫 renderCart 讓外送計算同步
const _origRenderCart = renderCart;
// 注：不需要 monkey-patch，直接在 renderCart 末尾加呼叫 —— 但那函式已存在
// 改用定期檢查：在 calcChange 中呼叫
function _afterRenderCart() {
  updateDeliveryCalc();
}

// =============================================
// ===== 平台管理（設定頁） =====
// =============================================

let allPlatformsAdmin = [];

async function loadPlatformsPage() {
  try {
    const res  = await fetch('/api/platforms');
    const json = await res.json();
    if (json.success) {
      allPlatformsAdmin = json.data;
      renderPlatformsTable(json.data);
    }
  } catch { showToast('平台載入失敗', 'error'); }
}

function renderPlatformsTable(platforms) {
  const tbody = document.getElementById('platformsBody');
  if (!platforms.length) { tbody.innerHTML = '<tr><td colspan="4" class="table-empty">尚無平台</td></tr>'; return; }
  tbody.innerHTML = platforms.map(p => `
    <tr>
      <td style="font-weight:700">${escHtml(p.name)}</td>
      <td style="font-family:monospace;color:var(--accent)">${p.commission_rate}%</td>
      <td><span class="status-badge ${p.is_active?'status-on':'status-off'}">${p.is_active?'啟用':'停用'}</span></td>
      <td>
        <button class="btn-icon" style="margin-right:4px" onclick="openPlatformModal(${p.id})">✏️</button>
        <button class="btn-icon danger" onclick="deletePlatform(${p.id})">🗑️</button>
      </td>
    </tr>`).join('');
}

function openPlatformModal(id) {
  document.getElementById('editPlatformId').value = id || '';
  document.getElementById('platformModalTitle').textContent = id ? '編輯平台' : '新增平台';
  document.getElementById('editPlatformName').value = '';
  document.getElementById('editPlatformRate').value = '';
  document.getElementById('editPlatformActive').checked = true;
  if (id) {
    const p = allPlatformsAdmin.find(x => x.id === id);
    if (p) {
      document.getElementById('editPlatformName').value = p.name;
      document.getElementById('editPlatformRate').value = p.commission_rate;
      document.getElementById('editPlatformActive').checked = !!p.is_active;
    }
  }
  document.getElementById('platformModal').classList.add('open');
}
function closePlatformModal() { document.getElementById('platformModal').classList.remove('open'); }

async function savePlatform() {
  const id   = document.getElementById('editPlatformId').value;
  const name = document.getElementById('editPlatformName').value.trim();
  const rate = parseFloat(document.getElementById('editPlatformRate').value) || 0;
  const is_active = document.getElementById('editPlatformActive').checked ? 1 : 0;
  if (!name) { showToast('平台名稱必填', 'error'); return; }
  const url = id ? '/api/platforms/' + id : '/api/platforms';
  const method = id ? 'PUT' : 'POST';
  try {
    const res  = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, commission_rate:rate, is_active}) });
    const json = await res.json();
    if (json.success) {
      showToast(id ? '已更新' : '已新增', 'success');
      closePlatformModal();
      loadPlatformsPage();
      loadPlatforms();  // 更新 POS 外送平台列表
    } else { showToast(json.message || '儲存失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

async function deletePlatform(id) {
  if (!confirm('確認刪除此平台？')) return;
  try {
    const res  = await fetch('/api/platforms/' + id, { method:'DELETE' });
    const json = await res.json();
    if (json.success) { showToast('已刪除', 'success'); loadPlatformsPage(); loadPlatforms(); }
    else { showToast(json.message || '刪除失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 訂單資訊展開/隱藏 =====
// =============================================

function toggleOrderInfo() {
  orderInfoExpanded = !orderInfoExpanded;
  const fields = document.getElementById('orderInfoFields');
  const arrow  = document.getElementById('toggleArrow');
  const label  = document.getElementById('orderInfoToggleLabel');
  if (!fields) return;

  if (orderInfoExpanded) {
    fields.classList.remove('collapsed');
    fields.style.maxHeight = fields.scrollHeight + 'px';
    if (arrow) arrow.classList.remove('collapsed');
    if (label) label.textContent = '訂單資訊';
  } else {
    fields.style.maxHeight = fields.scrollHeight + 'px'; // 先設定確切高度再收合
    requestAnimationFrame(() => {
      fields.classList.add('collapsed');
      fields.style.maxHeight = '0';
    });
    if (arrow) arrow.classList.add('collapsed');
    if (label) label.textContent = '訂單資訊（隱藏中）';
  }
}

// 確保初始狀態正確
document.addEventListener('DOMContentLoaded', () => {
  const fields = document.getElementById('orderInfoFields');
  if (fields) fields.style.maxHeight = '600px'; // 初始展開
});

// =============================================
// ===== 付款方式管理頁 =====
// =============================================

async function loadPaymentMethodsPage() {
  try {
    const res  = await fetch('/api/payment-methods');
    const json = await res.json();
    if (json.success) renderPaymentMethodsTable(json.data);
  } catch { showToast('付款方式載入失敗', 'error'); }
}

function renderPaymentMethodsTable(methods) {
  const tbody = document.getElementById('paymentMethodsBody');
  if (!methods.length) { tbody.innerHTML = '<tr><td colspan="8" class="table-empty">無資料</td></tr>'; return; }

  tbody.innerHTML = methods.map(m => `
    <tr id="pm-row-${m.id}">
      <td style="font-weight:600">${m.icon} ${escHtml(m.name)}</td>
      <td>
        <label class="pm-toggle">
          <input type="checkbox" ${m.is_active?'checked':''} onchange="updatePM(${m.id},{is_active:this.checked?1:0})">
          <span class="pm-toggle-slider"></span>
        </label>
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_dine_in?'checked':''}
          onchange="updatePM(${m.id},{enable_for_dine_in:this.checked?1:0})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_takeout?'checked':''}
          onchange="updatePM(${m.id},{enable_for_takeout:this.checked?1:0})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.enable_for_delivery?'checked':''}
          onchange="updatePM(${m.id},{enable_for_delivery:this.checked?1:0})">
      </td>
      <td>
        <input type="number" value="${m.sort_order}" min="0" style="width:50px;background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:4px;border-radius:4px;text-align:center"
          onchange="updatePM(${m.id},{sort_order:Number(this.value)})">
      </td>
      <td style="text-align:center">
        <input type="checkbox" class="pm-checkbox" ${m.is_default?'checked':''}
          onchange="updatePM(${m.id},{is_default:this.checked?1:0})">
      </td>
      <td>
        <span style="font-size:11px;color:${m.gateway_code?'var(--text-muted)':'transparent'}">${m.gateway_code||''}</span>
      </td>
    </tr>`).join('');
}

async function updatePM(id, fields) {
  try {
    const res  = await fetch('/api/payment-methods/' + id, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields)
    });
    const json = await res.json();
    if (json.success) {
      // 立即同步前台付款方式
      await loadPaymentMethods();
      showToast('已更新', 'success');
    } else { showToast(json.message || '更新失敗', 'error'); }
  } catch { showToast('網路錯誤', 'error'); }
}

// =============================================
// ===== 金流設定頁 =====
// =============================================

async function loadGatewayPage() {
  try {
    const res  = await fetch('/api/payment-gateways');
    const json = await res.json();
    if (json.success) renderGatewayCards(json.data);
  } catch { showToast('金流載入失敗', 'error'); }
}

function renderGatewayCards(gateways) {
  const container = document.getElementById('gatewayCards');
  if (!container) return;

  container.innerHTML = gateways.map(gw => `
    <div class="gateway-card ${gw.is_active ? 'active-gw' : ''}" id="gw-card-${gw.id}">
      <div class="gateway-card-header">
        <h4>${escHtml(gw.name)}</h4>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="gateway-status ${gw.is_active?'gw-on':'gw-off'}">${gw.is_active?'已啟用':'未啟用'}</span>
          <label class="pm-toggle" style="margin:0">
            <input type="checkbox" ${gw.is_active?'checked':''} onchange="toggleGateway(${gw.id},this.checked)">
            <span class="pm-toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="gateway-mode-toggle">
        <div class="mode-chip ${gw.mode==='test'?'selected':''}" onclick="setGwMode(${gw.id},'test',this)">🧪 測試模式</div>
        <div class="mode-chip ${gw.mode==='live'?'selected':''}" onclick="setGwMode(${gw.id},'live',this)">🚀 正式模式</div>
      </div>

      <label>Merchant ID / Channel ID
        <input type="text" id="gw-mid-${gw.id}" value="${escHtml(gw.merchant_id||'')}" placeholder="商家 ID">
      </label>
      <label>API Key
        <input type="text" id="gw-apikey-${gw.id}" value="${escHtml(gw.api_key||'')}" placeholder="API Key">
      </label>
      <label>Secret Key
        <input type="password" id="gw-secret-${gw.id}" value="${escHtml(gw.secret_key||'')}" placeholder="Secret Key">
      </label>
      <label>Webhook URL
        <input type="url" id="gw-webhook-${gw.id}" value="${escHtml(gw.webhook_url||'')}" placeholder="https://yoursite.com/webhook/${gw.code}">
      </label>
      <label>Callback URL
        <input type="url" id="gw-callback-${gw.id}" value="${escHtml(gw.callback_url||'')}" placeholder="https://yoursite.com/callback/${gw.code}">
      </label>

      <div class="gateway-card-actions">
        <button class="btn-secondary" style="flex:1;font-size:13px" onclick="testGateway(${gw.id})">🔌 測試連線</button>
        <button class="btn-primary" style="flex:1;font-size:13px" onclick="saveGateway(${gw.id})">💾 儲存</button>
      </div>
    </div>`).join('');
}

async function toggleGateway(id, active) {
  try {
    const res  = await fetch('/api/payment-gateways/' + id, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ is_active: active?1:0 })
    });
    const json = await res.json();
    if (json.success) {
      showToast(active ? '金流已啟用' : '金流已停用（相關付款方式已同步停用）', active ? 'success' : 'info');
      loadGatewayPage();
      loadPaymentMethods();      // 同步前台
      loadPaymentMethodsPage();  // 同步設定頁
    }
  } catch { showToast('網路錯誤', 'error'); }
}

function setGwMode(id, mode, el) {
  el.closest('.gateway-mode-toggle').querySelectorAll('.mode-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  fetch('/api/payment-gateways/' + id, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ mode })
  }).catch(() => {});
}

async function saveGateway(id) {
  const body = {
    merchant_id: document.getElementById('gw-mid-'+id)?.value    || '',
    api_key:     document.getElementById('gw-apikey-'+id)?.value  || '',
    secret_key:  document.getElementById('gw-secret-'+id)?.value  || '',
    webhook_url: document.getElementById('gw-webhook-'+id)?.value || '',
    callback_url:document.getElementById('gw-callback-'+id)?.value|| '',
  };
  try {
    const res  = await fetch('/api/payment-gateways/' + id, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) showToast('金流設定已儲存', 'success');
    else showToast(json.message || '儲存失敗', 'error');
  } catch { showToast('網路錯誤', 'error'); }
}

async function testGateway(id) {
  try {
    const res  = await fetch('/api/payment-gateways/' + id + '/test', { method: 'POST' });
    const json = await res.json();
    showToast(json.message || '連線測試完成', json.success ? 'info' : 'error');
  } catch { showToast('測試失敗', 'error'); }
}

// =============================================
// ===== 出單機設定頁 =====
// =============================================

// 依後端狀態回傳更新 badge（用於「檢查狀態」按鈕）
function _updatePrinterBadge(data) {
  const badge = document.getElementById('printerStatusBadge');
  const msgEl = document.getElementById('printerStatusMsg');
  const enabled   = data.enabled;
  const connected = data.connected;
  const mode      = data.type || data.mode || 'network';
  if (!badge) return;
  if (!enabled) {
    badge.innerHTML = '<span class="order-status status-void">未啟用</span>';
    if (msgEl) { msgEl.textContent = '請勾選「啟用印表機」並儲存設定。'; msgEl.style.color = 'var(--text-muted)'; }
    return;
  }
  if (connected) {
    badge.innerHTML = `<span class="order-status status-completed">已連線（${mode === 'usb' ? (data.printer_name || 'USB') : (data.ip + ':' + data.port)}）</span>`;
    if (msgEl) { msgEl.textContent = data.message || '印表機正常'; msgEl.style.color = 'var(--success)'; }
  } else {
    badge.innerHTML = `<span class="order-status status-modified">啟用中，未連線</span>`;
    if (msgEl) { msgEl.textContent = data.message || '無法連線'; msgEl.style.color = 'var(--danger)'; }
  }
}

// 儲存設定後純前端更新 badge（不呼叫後端、不觸發 PowerShell / TCP）
function _updatePrinterBadgeFromConfig(cfg) {
  const badge = document.getElementById('printerStatusBadge');
  const msgEl = document.getElementById('printerStatusMsg');
  if (!badge) return;
  const enabled = cfg.printer_enabled === '1' || cfg.printer_enabled === true;
  if (!enabled) {
    badge.innerHTML = '<span class="order-status status-void">未啟用</span>';
    if (msgEl) { msgEl.textContent = '印表機已停用。'; msgEl.style.color = 'var(--text-muted)'; }
    return;
  }
  const type = cfg.printer_type || 'network';
  if (type === 'usb') {
    const name  = cfg.printer_name       || '';
    const share = cfg.printer_share_name || '';
    if (share) {
      badge.innerHTML = `<span class="order-status status-completed">已設定（\\\\127.0.0.1\\${escHtml(share)}）</span>`;
      if (msgEl) { msgEl.textContent = `共享名稱：${share}${name ? '（' + name + '）' : ''}。按「測試列印」驗證。`; msgEl.style.color = 'var(--success)'; }
    } else if (name) {
      badge.innerHTML = '<span class="order-status status-modified">啟用中，未設共享名稱</span>';
      if (msgEl) { msgEl.textContent = '請填寫「Windows 印表機共享名稱」（例如：XP80）。'; msgEl.style.color = 'var(--accent)'; }
    } else {
      badge.innerHTML = '<span class="order-status status-modified">啟用中，未設定印表機</span>';
      if (msgEl) { msgEl.textContent = '請填寫共享名稱與印表機名稱。'; msgEl.style.color = 'var(--accent)'; }
    }
  } else {
    const ip   = cfg.printer_ip   || '192.168.1.100';
    const port = cfg.printer_port || '9100';
    badge.innerHTML = `<span class="order-status status-modified">啟用中（${escHtml(ip)}:${port}）</span>`;
    if (msgEl) { msgEl.textContent = 'LAN 模式，按「檢查狀態」確認 TCP 連線。'; msgEl.style.color = 'var(--text-muted)'; }
  }
}

async function loadPrinterSettings() {
  try {
    const [settingsRes, statusRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/print/status')
    ]);
    const sJson = await settingsRes.json();
    const pJson = await statusRes.json();

    if (sJson.success) {
      const s = sJson.data;
      const safeCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = (val === '1' || val === true); };
      const safeVal   = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };
      safeCheck('set-printer_enabled', s.printer_enabled);
      safeCheck('set-auto_print',      s.auto_print);
      safeCheck('set-auto_drawer',     s.auto_drawer);
      safeVal('set-printer_type', s.printer_type || 'network');
      safeVal('set-printer_ip',   s.printer_ip   || '192.168.1.100');
      safeVal('set-printer_port', s.printer_port  || '9100');
      safeVal('set-printer_name',       s.printer_name       || '');
      safeVal('set-printer_share_name', s.printer_share_name || '');
    }
    onPrinterTypeChange();
    _updatePrinterBadge(pJson?.data || {});
  } catch(e) {
    console.error('[PrinterSettings] loadPrinterSettings:', e);
  }
}

async function onPrinterEnabledChange() {
  await savePrinterSettings();
}

function onPrinterTypeChange() {
  const type = document.getElementById('set-printer_type')?.value;
  const netF = document.getElementById('networkFields');
  const usbF = document.getElementById('usbFields');
  if (netF) netF.style.display = type === 'usb' ? 'none'  : 'block';
  if (usbF) usbF.style.display = type === 'usb' ? 'block' : 'none';
  // ⚠️ 不自動呼叫 refreshPrinterList()，等使用者點「重新整理」按鈕
}

function onPrinterNameSelect() {
  const sel     = document.getElementById('printerNameSelect');
  const inputEl = document.getElementById('set-printer_name');
  if (sel && inputEl && sel.value) inputEl.value = sel.value;
}

async function refreshPrinterList() {
  const sel = document.getElementById('printerNameSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">載入中...</option>';
  try {
    const res  = await fetch('/api/printers/list');
    const json = await res.json();
    const list = json.data || [];
    if (!list.length) {
      sel.innerHTML = '<option value="">找不到 Windows 印表機（請確認環境）</option>';
      return;
    }
    const current = document.getElementById('set-printer_name')?.value || '';
    sel.innerHTML = '<option value="">— 請選擇印表機 —</option>' +
      list.map(name =>
        `<option value="${escHtml(name)}" ${name === current ? 'selected' : ''}>${escHtml(name)}</option>`
      ).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">載入失敗：' + escHtml(e.message) + '</option>';
  }
}

async function savePrinterSettings() {
  const getCheck = id => document.getElementById(id)?.checked ? '1' : '0';
  const getVal   = id => document.getElementById(id)?.value || '';
  const body = {
    printer_enabled: getCheck('set-printer_enabled'),
    printer_type:    getVal('set-printer_type'),
    printer_ip:      getVal('set-printer_ip'),
    printer_port:    getVal('set-printer_port'),
    printer_name:       getVal('set-printer_name'),
    printer_share_name: getVal('set-printer_share_name'),
    auto_print:      getCheck('set-auto_print'),
    auto_drawer:     getCheck('set-auto_drawer'),
  };
  try {
    const res  = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.success) {
      showToast('設定已儲存', 'success');
      // ⚠️ 只更新前端 badge，不重新呼叫後端狀態（避免觸發 PowerShell）
      _updatePrinterBadgeFromConfig(body);
    } else {
      showToast(json.message || '儲存失敗', 'error');
    }
  } catch { showToast('網路錯誤', 'error'); }
}


async function testPrint() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 列印中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    const res  = await fetch('/api/print/test', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ ${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ API 連線失敗'; msgEl.style.color = 'var(--danger)'; }
    showToast('測試列印失敗', 'error');
  }
}

async function testKitchenPrint() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 廚房單列印中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    // 使用固定測試內容，不依賴訂單資料
    const res  = await fetch('/api/print/kitchen-test', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ 廚房單：${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ 失敗：' + e.message; msgEl.style.color = 'var(--danger)'; }
  }
}

async function testCashDrawer() {
  const msgEl = document.getElementById('printerTestResult');
  if (msgEl) { msgEl.textContent = '⏳ 開錢櫃中...'; msgEl.style.color = 'var(--text-muted)'; }
  try {
    const res  = await fetch('/api/print/cashdrawer', { method: 'POST' });
    const json = await res.json();
    if (msgEl) {
      msgEl.textContent = json.success ? `✅ ${json.message}` : `❌ ${json.message}`;
      msgEl.style.color = json.success ? 'var(--success)' : 'var(--danger)';
    }
    showToast(json.message, json.success ? 'success' : 'error');
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ API 連線失敗'; msgEl.style.color = 'var(--danger)'; }
    showToast('開錢櫃失敗', 'error');
  }
}

// 訂單紀錄 — 現金訂單手動開錢櫃
async function openDrawerFromOrder(orderId) {
  try {
    const res  = await fetch('/api/print/cashdrawer', { method: 'POST' });
    const json = await res.json();
    showToast(json.success ? '💰 錢櫃已開啟' : ('開錢櫃失敗：' + json.message), json.success ? 'success' : 'error');
  } catch(e) {
    showToast('開錢櫃失敗：' + e.message, 'error');
  }
}

async function checkPrinterStatus() {
  const badge = document.getElementById('printerStatusBadge');
  if (badge) badge.innerHTML = '<span class="order-status status-modified">檢查中...</span>';
  try {
    const res  = await fetch('/api/print/status');
    const json = await res.json();
    _updatePrinterBadge(json?.data || {});
    return json?.data;
  } catch(e) {
    if (badge) badge.innerHTML = '<span class="order-status status-void">API 連線失敗</span>';
    return null;
  }
}
