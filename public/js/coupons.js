// public/js/coupons.js — fix18-05 優惠券管理前台邏輯
// 此檔案在 app.js 之後載入，透過 window.* 使用共用函式。
// 若 app.js 未完成載入，以下 safe fallback 確保不崩潰。
'use strict';

// ── 安全引用 app.js 共用函式 ──────────────────────────────
var safeEscHtml = function(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

function _apiFetch(url, options) {
  if (typeof window.apiFetch === 'function') return window.apiFetch(url, options);
  var sep = url.includes('?') ? '&' : '?';
  var storeId = new URLSearchParams(window.location.search).get('store_id') || 'store_001';
  return fetch(url + sep + 'store_id=' + encodeURIComponent(storeId), Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, options || {}));
}

function _showToast(msg, type) {
  if (typeof window.showToast === 'function') { window.showToast(msg, type); return; }
  alert(msg);
}

// ── 模組狀態 ──────────────────────────────────────────────
var _editCouponId = null;
var _couponsData  = [];

// ── 頁面載入 ──────────────────────────────────────────────
async function loadCouponsPage() {
  var tbody = document.getElementById('couponsBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">載入中…</td></tr>';
  try {
    var res = await _apiFetch('/api/coupons').then(function(r) { return r.json(); });
    if (!res.success) throw new Error(res.message || '載入失敗');
    _couponsData = res.data || [];
    renderCouponsTable(_couponsData);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--danger,#e74c3c)">' + safeEscHtml(e.message) + '</td></tr>';
  }
}

function renderCouponsTable(coupons) {
  var tbody = document.getElementById('couponsBody');
  if (!tbody) return;
  var tdS = 'padding:10px 8px;border-bottom:1px solid var(--border,#334155);vertical-align:middle';

  if (!coupons.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">尚無優惠券，點「新增優惠券」開始建立</td></tr>';
    return;
  }

  tbody.innerHTML = coupons.map(function(c) {
    var discLabel = c.discount_type === 'fixed'
      ? '折 NT$' + c.discount_value
      : c.discount_value + '% OFF';
    var minLabel  = Number(c.min_amount) > 0 ? 'NT$' + c.min_amount : '—';
    var maxLabel  = Number(c.max_usage)  > 0 ? c.usage_count + ' / ' + c.max_usage : c.usage_count + ' / ∞';
    var perPhone  = Number(c.max_usage_per_phone) > 0 ? '每電話限 ' + c.max_usage_per_phone + ' 次' : '';

    var now = new Date();
    var endAtDate = c.end_at ? new Date(c.end_at.replace(' ', 'T')) : null;
    var isExpired = endAtDate && endAtDate < now;

    var periodStr = '';
    if (c.start_at) periodStr += c.start_at.slice(0, 10);
    if (c.start_at && c.end_at) periodStr += ' ~';
    if (c.end_at)  periodStr += ' ' + c.end_at.slice(0, 10);
    if (!periodStr) periodStr = '—';

    var enabledBadge = !Number(c.enabled)
      ? '<span style="background:#64748b;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">停用</span>'
      : isExpired
        ? '<span style="background:#e74c3c;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">已過期</span>'
        : '<span style="background:#06C755;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">啟用</span>';

    var toggleLabel = Number(c.enabled) ? '停用' : '啟用';
    var toggleBg    = Number(c.enabled) ? 'var(--warning,#f59e0b)' : 'var(--success,#06C755)';
    var toggleIcon  = Number(c.enabled) ? '⛔' : '✅';
    var toggleNext  = Number(c.enabled) ? 0 : 1;

    return '<tr>'
      + '<td style="' + tdS + '"><code style="font-weight:700;font-size:13px;color:var(--accent,#f5a623)">' + safeEscHtml(c.code) + '</code></td>'
      + '<td style="' + tdS + '">' + safeEscHtml(c.name) + '</td>'
      + '<td style="' + tdS + ';font-weight:600;color:var(--success,#06C755)">' + discLabel + '</td>'
      + '<td style="' + tdS + '">' + minLabel + '</td>'
      + '<td style="' + tdS + ';font-size:12px">' + safeEscHtml(periodStr) + '</td>'
      + '<td style="' + tdS + ';text-align:center">' + c.usage_count + '</td>'
      + '<td style="' + tdS + ';text-align:center;font-size:12px">' + maxLabel + (perPhone ? '<br><span style="color:var(--text-muted,#64748b)">' + perPhone + '</span>' : '') + '</td>'
      + '<td style="' + tdS + ';text-align:center">' + enabledBadge + '</td>'
      + '<td style="' + tdS + ';text-align:center">'
      +   '<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">'
      +     '<button class="btn-icon" title="編輯" onclick="openCouponModal(' + c.id + ')">✏️</button>'
      +     '<button class="btn-icon" title="' + toggleLabel + '" style="background:' + toggleBg + '" onclick="toggleCouponEnabled(' + c.id + ',' + toggleNext + ')">' + toggleIcon + '</button>'
      +     '<button class="btn-icon" title="刪除" style="background:var(--danger,#e74c3c)" onclick="deleteCoupon(' + c.id + ',\'' + safeEscHtml(c.code) + '\')">&#128465;&#65039;</button>'
      +   '</div>'
      + '</td>'
      + '</tr>';
  }).join('');
}

// ── Modal 開啟 ────────────────────────────────────────────
function openCouponModal(id) {
  _editCouponId = id || null;
  var title = document.getElementById('couponModalTitle');
  if (title) title.textContent = id ? '編輯優惠券' : '新增優惠券';

  ['cf-code','cf-name','cf-discount-value','cf-min-amount','cf-max-usage','cf-max-per-phone','cf-start-at','cf-end-at']
    .forEach(function(f) { var el = document.getElementById(f); if (el) el.value = ''; });
  var dt = document.getElementById('cf-discount-type');
  if (dt) dt.value = 'fixed';
  var en = document.getElementById('cf-enabled');
  if (en) en.value = '1';
  updateCouponDiscLabel();

  if (id) {
    var c = _couponsData.find(function(x) { return x.id === id; });
    if (c) {
      _setVal('cf-code',          c.code);
      _setVal('cf-name',          c.name);
      _setVal('cf-discount-type', c.discount_type);
      _setVal('cf-discount-value',c.discount_value);
      _setVal('cf-min-amount',    c.min_amount);
      _setVal('cf-max-usage',     c.max_usage);
      _setVal('cf-max-per-phone', c.max_usage_per_phone);
      _setVal('cf-enabled',       c.enabled ? '1' : '0');
      if (c.start_at) _setVal('cf-start-at', c.start_at.slice(0,16).replace(' ','T'));
      if (c.end_at)   _setVal('cf-end-at',   c.end_at.slice(0,16).replace(' ','T'));
      updateCouponDiscLabel();
    }
  }

  var modal = document.getElementById('couponModal');
  if (modal) {
    modal.style.display        = 'flex';
    modal.style.alignItems     = 'center';
    modal.style.justifyContent = 'center';
  }
}

function _setVal(id, v) {
  var el = document.getElementById(id);
  if (el) el.value = v;
}

function closeCouponModal() {
  var modal = document.getElementById('couponModal');
  if (modal) modal.style.display = 'none';
  _editCouponId = null;
}

function updateCouponDiscLabel() {
  var dt  = document.getElementById('cf-discount-type');
  var lbl = document.getElementById('cf-disc-label');
  if (!dt || !lbl) return;
  lbl.textContent = dt.value === 'percent' ? '折扣百分比（%） *' : '折扣金額（元） *';
}

// ── 儲存 ─────────────────────────────────────────────────
async function saveCoupon() {
  var btn = document.getElementById('couponSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
  try {
    var code        = (document.getElementById('cf-code') ? document.getElementById('cf-code').value : '').trim().toUpperCase();
    var name        = (document.getElementById('cf-name') ? document.getElementById('cf-name').value : '').trim();
    var discType    = document.getElementById('cf-discount-type') ? document.getElementById('cf-discount-type').value : 'fixed';
    var discVal     = Number(document.getElementById('cf-discount-value') ? document.getElementById('cf-discount-value').value : 0);
    var minAmount   = Number(document.getElementById('cf-min-amount') ? document.getElementById('cf-min-amount').value : 0);
    var maxUsage    = Number(document.getElementById('cf-max-usage') ? document.getElementById('cf-max-usage').value : 0);
    var maxPerPhone = Number(document.getElementById('cf-max-per-phone') ? document.getElementById('cf-max-per-phone').value : 0);
    var enabled     = Number(document.getElementById('cf-enabled') ? document.getElementById('cf-enabled').value : 1);
    var startRaw    = document.getElementById('cf-start-at') ? document.getElementById('cf-start-at').value : '';
    var endRaw      = document.getElementById('cf-end-at')   ? document.getElementById('cf-end-at').value   : '';
    var startAt     = startRaw ? startRaw.replace('T', ' ') + ':00' : '';
    var endAt       = endRaw   ? endRaw.replace('T', ' ')   + ':00' : '';

    if (!code)                   { _showToast('請輸入優惠券代碼', 'error'); return; }
    if (!name)                   { _showToast('請輸入優惠券名稱', 'error'); return; }
    if (!discVal || discVal <= 0){ _showToast('折扣金額必須大於 0', 'error'); return; }
    if (discType === 'percent' && discVal > 100) { _showToast('百分比折扣不可超過 100', 'error'); return; }

    var body = {
      code: code, name: name,
      discount_type: discType, discount_value: discVal,
      min_amount: minAmount, max_usage: maxUsage,
      max_usage_per_phone: maxPerPhone, enabled: enabled,
      start_at: startAt, end_at: endAt
    };

    var url    = _editCouponId ? '/api/coupons/' + _editCouponId : '/api/coupons';
    var method = _editCouponId ? 'PATCH' : 'POST';
    var res    = await _apiFetch(url, { method: method, body: JSON.stringify(body) }).then(function(r) { return r.json(); });

    if (!res.success) { _showToast(res.message || '儲存失敗', 'error'); return; }
    _showToast(_editCouponId ? '優惠券已更新' : '優惠券已建立', 'success');
    closeCouponModal();
    loadCouponsPage();
  } catch (e) {
    _showToast('錯誤：' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '儲存'; }
  }
}

// ── 啟停用 ───────────────────────────────────────────────
async function toggleCouponEnabled(id, newEnabled) {
  try {
    var res = await _apiFetch('/api/coupons/' + id, {
      method: 'PATCH', body: JSON.stringify({ enabled: newEnabled })
    }).then(function(r) { return r.json(); });
    if (!res.success) { _showToast(res.message || '操作失敗', 'error'); return; }
    _showToast(newEnabled ? '已啟用' : '已停用', 'success');
    loadCouponsPage();
  } catch (e) { _showToast('錯誤：' + e.message, 'error'); }
}

// ── 刪除 ─────────────────────────────────────────────────
async function deleteCoupon(id, code) {
  if (!confirm('確定要刪除優惠券「' + code + '」？此操作無法復原。')) return;
  try {
    var res = await _apiFetch('/api/coupons/' + id, { method: 'DELETE' }).then(function(r) { return r.json(); });
    if (!res.success) { _showToast(res.message || '刪除失敗', 'error'); return; }
    _showToast('已刪除', 'success');
    loadCouponsPage();
  } catch (e) { _showToast('錯誤：' + e.message, 'error'); }
}

// ── window 全域匯出（供 index.html onclick 呼叫）─────────
window.loadCouponsPage       = loadCouponsPage;
window.openCouponModal       = openCouponModal;
window.closeCouponModal      = closeCouponModal;
window.saveCoupon            = saveCoupon;
window.deleteCoupon          = deleteCoupon;
window.toggleCouponEnabled   = toggleCouponEnabled;
window.updateCouponDiscLabel = updateCouponDiscLabel;
