// public/js/coupons.js — fix18-05 優惠券管理前台邏輯
'use strict';

let _editCouponId = null;   // null = 新增, number = 編輯
let _couponsData  = [];

// ── 頁面載入 ──────────────────────────────────────────────
async function loadCouponsPage() {
  const tbody = document.getElementById('couponsBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">載入中…</td></tr>';
  try {
    const res  = await apiFetch('/api/coupons').then(r => r.json());
    if (!res.success) throw new Error(res.message || '載入失敗');
    _couponsData = res.data || [];
    renderCouponsTable(_couponsData);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--danger)">${escHtml(e.message)}</td></tr>`;
  }
}

function renderCouponsTable(coupons) {
  const tbody = document.getElementById('couponsBody');
  if (!tbody) return;
  const tdS = 'padding:10px 8px;border-bottom:1px solid var(--border,#334155);vertical-align:middle';

  if (!coupons.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted,#64748b)">尚無優惠券，點「新增優惠券」開始建立</td></tr>';
    return;
  }

  tbody.innerHTML = coupons.map(c => {
    const discLabel = c.discount_type === 'fixed'
      ? `折 NT$${c.discount_value}`
      : `${c.discount_value}% OFF`;
    const minLabel  = Number(c.min_amount) > 0 ? `NT$${c.min_amount}` : '—';
    const maxLabel  = Number(c.max_usage)  > 0 ? `${c.usage_count} / ${c.max_usage}` : `${c.usage_count} / ∞`;
    const perPhone  = Number(c.max_usage_per_phone) > 0 ? `每電話限 ${c.max_usage_per_phone} 次` : '';

    const now = new Date();
    const endAt = c.end_at ? new Date(c.end_at.replace(' ', 'T')) : null;
    const isExpired = endAt && endAt < now;

    let periodStr = '';
    if (c.start_at) periodStr += c.start_at.slice(0, 10);
    if (c.start_at && c.end_at) periodStr += ' ~';
    if (c.end_at)  periodStr += ' ' + c.end_at.slice(0, 10);
    if (!periodStr) periodStr = '—';

    const enabledBadge = !Number(c.enabled)
      ? '<span style="background:#64748b;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">停用</span>'
      : isExpired
        ? '<span style="background:#e74c3c;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">已過期</span>'
        : '<span style="background:#06C755;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px">啟用</span>';

    return `<tr>
      <td style="${tdS}"><code style="font-weight:700;font-size:13px;color:var(--accent,#f5a623)">${escHtml(c.code)}</code></td>
      <td style="${tdS}">${escHtml(c.name)}</td>
      <td style="${tdS};font-weight:600;color:var(--success,#06C755)">${discLabel}</td>
      <td style="${tdS}">${minLabel}</td>
      <td style="${tdS};font-size:12px">${escHtml(periodStr)}</td>
      <td style="${tdS};text-align:center">${c.usage_count}</td>
      <td style="${tdS};text-align:center;font-size:12px">${maxLabel}${perPhone ? '<br><span style="color:var(--text-muted,#64748b)">'+perPhone+'</span>' : ''}</td>
      <td style="${tdS};text-align:center">${enabledBadge}</td>
      <td style="${tdS};text-align:center">
        <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
          <button class="btn-icon" title="編輯" onclick="openCouponModal(${c.id})">✏️</button>
          <button class="btn-icon" title="${Number(c.enabled) ? '停用' : '啟用'}"
            style="background:${Number(c.enabled) ? 'var(--warning,#f59e0b)' : 'var(--success,#06C755)'}"
            onclick="toggleCouponEnabled(${c.id},${Number(c.enabled) ? 0 : 1})">
            ${Number(c.enabled) ? '⛔' : '✅'}
          </button>
          <button class="btn-icon" title="刪除" style="background:var(--danger,#e74c3c)"
            onclick="deleteCoupon(${c.id},'${escHtml(c.code)}')">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Modal 開啟（新增 / 編輯）─────────────────────────────
function openCouponModal(id) {
  _editCouponId = id || null;
  const title = document.getElementById('couponModalTitle');
  if (title) title.textContent = id ? '編輯優惠券' : '新增優惠券';

  // 清空表單
  ['cf-code','cf-name','cf-discount-value','cf-min-amount','cf-max-usage','cf-max-per-phone','cf-start-at','cf-end-at']
    .forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  const dt = document.getElementById('cf-discount-type');
  if (dt) dt.value = 'fixed';
  const en = document.getElementById('cf-enabled');
  if (en) en.value = '1';
  updateCouponDiscLabel();

  if (id) {
    const c = _couponsData.find(x => x.id === id);
    if (c) {
      setVal('cf-code',           c.code);
      setVal('cf-name',           c.name);
      setVal('cf-discount-type',  c.discount_type);
      setVal('cf-discount-value', c.discount_value);
      setVal('cf-min-amount',     c.min_amount);
      setVal('cf-max-usage',      c.max_usage);
      setVal('cf-max-per-phone',  c.max_usage_per_phone);
      setVal('cf-enabled',        c.enabled ? '1' : '0');
      // datetime-local 格式需要 "YYYY-MM-DDTHH:MM"
      if (c.start_at) setVal('cf-start-at', c.start_at.slice(0,16).replace(' ','T'));
      if (c.end_at)   setVal('cf-end-at',   c.end_at.slice(0,16).replace(' ','T'));
      updateCouponDiscLabel();
    }
  }

  const modal = document.getElementById('couponModal');
  if (modal) { modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center'; }
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
}

function closeCouponModal() {
  const modal = document.getElementById('couponModal');
  if (modal) modal.style.display = 'none';
  _editCouponId = null;
}

function updateCouponDiscLabel() {
  const dt  = document.getElementById('cf-discount-type');
  const lbl = document.getElementById('cf-disc-label');
  if (!dt || !lbl) return;
  lbl.textContent = dt.value === 'percent' ? '折扣百分比（%）*' : '折扣金額（元）*';
}

// ── 儲存優惠券 ────────────────────────────────────────────
async function saveCoupon() {
  const btn = document.getElementById('couponSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
  try {
    const code         = (document.getElementById('cf-code')?.value || '').trim().toUpperCase();
    const name         = (document.getElementById('cf-name')?.value || '').trim();
    const discountType = document.getElementById('cf-discount-type')?.value || 'fixed';
    const discountVal  = Number(document.getElementById('cf-discount-value')?.value || 0);
    const minAmount    = Number(document.getElementById('cf-min-amount')?.value    || 0);
    const maxUsage     = Number(document.getElementById('cf-max-usage')?.value     || 0);
    const maxPerPhone  = Number(document.getElementById('cf-max-per-phone')?.value || 0);
    const enabled      = Number(document.getElementById('cf-enabled')?.value       || 1);
    const startRaw     = document.getElementById('cf-start-at')?.value || '';
    const endRaw       = document.getElementById('cf-end-at')?.value   || '';
    // datetime-local → "YYYY-MM-DD HH:MM:SS"
    const startAt = startRaw ? startRaw.replace('T', ' ') + ':00' : '';
    const endAt   = endRaw   ? endRaw.replace('T', ' ')   + ':00' : '';

    if (!code) { showToast('請輸入優惠券代碼', 'error'); return; }
    if (!name) { showToast('請輸入優惠券名稱', 'error'); return; }
    if (!discountVal || discountVal <= 0) { showToast('折扣金額必須大於 0', 'error'); return; }
    if (discountType === 'percent' && discountVal > 100) { showToast('百分比折扣不可超過 100', 'error'); return; }

    const body = { code, name, discount_type: discountType, discount_value: discountVal,
      min_amount: minAmount, max_usage: maxUsage, max_usage_per_phone: maxPerPhone,
      enabled, start_at: startAt, end_at: endAt };

    const url    = _editCouponId ? `/api/coupons/${_editCouponId}` : '/api/coupons';
    const method = _editCouponId ? 'PATCH' : 'POST';
    const res    = await apiFetch(url, { method, body: JSON.stringify(body) }).then(r => r.json());

    if (!res.success) { showToast(res.message || '儲存失敗', 'error'); return; }
    showToast(_editCouponId ? '優惠券已更新' : '優惠券已建立', 'success');
    closeCouponModal();
    loadCouponsPage();
  } catch (e) {
    showToast('錯誤：' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '儲存'; }
  }
}

// ── 啟停用 ────────────────────────────────────────────────
async function toggleCouponEnabled(id, newEnabled) {
  try {
    const res = await apiFetch(`/api/coupons/${id}`, {
      method: 'PATCH', body: JSON.stringify({ enabled: newEnabled })
    }).then(r => r.json());
    if (!res.success) { showToast(res.message || '操作失敗', 'error'); return; }
    showToast(newEnabled ? '已啟用' : '已停用', 'success');
    loadCouponsPage();
  } catch (e) { showToast('錯誤：' + e.message, 'error'); }
}

// ── 刪除 ──────────────────────────────────────────────────
async function deleteCoupon(id, code) {
  if (!confirm(`確定要刪除優惠券「${code}」？此操作無法復原。`)) return;
  try {
    const res = await apiFetch(`/api/coupons/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (!res.success) { showToast(res.message || '刪除失敗', 'error'); return; }
    showToast('已刪除', 'success');
    loadCouponsPage();
  } catch (e) { showToast('錯誤：' + e.message, 'error'); }
}
