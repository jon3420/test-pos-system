/* license.js — 店家授權管理前台 JS (v18) */

const FEATURE_LABELS = {
  order:       '🛒 點餐',
  orders:      '📋 訂單',
  products:    '📦 商品',
  reports:     '📊 營收',
  print:       '🖨️ 出單',
  inventory:   '🏪 庫存',
  line_order:  '💬 LINE 點餐',
  delivery:    '🛵 外送',
  marketing:   '📣 行銷',
  member:      '👥 會員',
  coupon:      '🎫 優惠券',
  label_print: '🏷️ 標籤列印',
};

const PLAN_LABELS = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
const PLAN_COLORS = { basic: '#607d8b', pro: '#1976d2', enterprise: '#7b1fa2' };

let _editingStoreId = null;
let _allLicenses    = [];

// ── 載入授權清單 ──────────────────────────────────────────
async function loadLicenses() {
  const el = document.getElementById('licenseList');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-secondary);font-size:14px">載入中…</div>';
  try {
    const res  = await fetch('/api/license');
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    _allLicenses = data.data || [];
    renderLicenseList(_allLicenses);
  } catch (e) {
    el.innerHTML = `<div style="color:#e53935">載入失敗：${e.message}</div>`;
  }
}

function renderLicenseList(list) {
  const el = document.getElementById('licenseList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div style="color:var(--text-secondary)">尚無授權資料</div>';
    return;
  }

  el.innerHTML = list.map(lic => {
    const planColor = PLAN_COLORS[lic.plan] || '#607d8b';
    const activeTag = lic.active
      ? '<span style="background:#43a047;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">✅ 啟用</span>'
      : '<span style="background:#e53935;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">🔴 停用</span>';

    const featureChips = Object.entries(FEATURE_LABELS).map(([k, label]) => {
      const on = lic.features && lic.features[k];
      return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;margin:2px;
        background:${on ? '#e8f5e9' : '#fafafa'};color:${on ? '#2e7d32' : '#9e9e9e'};
        border:1px solid ${on ? '#a5d6a7' : '#e0e0e0'}">${label} ${on ? '✓' : '✗'}</span>`;
    }).join('');

    return `
    <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px;background:var(--bg-card)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-weight:700;font-size:16px">${escHtml(lic.store_name)}</span>
        <span style="font-size:12px;color:#888">store_id: <code>${escHtml(lic.store_id)}</code></span>
        <span style="background:${planColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${PLAN_LABELS[lic.plan] || lic.plan}</span>
        ${activeTag}
        <div style="margin-left:auto;display:flex;gap:8px">
          <button class="btn-secondary" style="font-size:12px;padding:4px 12px" onclick="licenseOpenEditModal('${escHtml(lic.store_id)}')">✏️ 編輯</button>
          <button class="btn-secondary" style="font-size:12px;padding:4px 12px;color:#e53935" onclick="licenseDelete('${escHtml(lic.store_id)}','${escHtml(lic.store_name)}')">🗑️ 刪除</button>
        </div>
      </div>
      <div style="margin-top:8px">${featureChips}</div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 新增 Modal ────────────────────────────────────────────
function licenseOpenAddModal() {
  _editingStoreId = null;
  showLicenseModal({
    store_id:   '',
    store_name: '',
    plan:       'basic',
    active:     true,
    features:   null,  // null = 由 plan 決定
  }, '新增店家授權');
}

// ── 編輯 Modal ────────────────────────────────────────────
function licenseOpenEditModal(storeId) {
  const lic = _allLicenses.find(l => l.store_id === storeId);
  if (!lic) return;
  _editingStoreId = storeId;
  showLicenseModal(lic, `編輯授權：${lic.store_name}`);
}

function showLicenseModal(lic, title) {
  // 功能開關 HTML
  const featureRows = Object.entries(FEATURE_LABELS).map(([k, label]) => {
    const on = lic.features ? !!lic.features[k] : false;
    return `
    <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer">
      <input type="checkbox" id="lf_${k}" ${on ? 'checked' : ''} style="width:16px;height:16px">
      <span>${label}</span>
    </label>`;
  }).join('');

  const planOptions = ['basic','pro','enterprise'].map(p =>
    `<option value="${p}" ${lic.plan===p?'selected':''}>${PLAN_LABELS[p]}</option>`
  ).join('');

  const html = `
  <div class="modal-overlay" id="licenseModal" onclick="if(event.target===this)closeLicenseModal()" style="z-index:9999">
    <div class="modal" style="max-width:540px;max-height:85vh;overflow-y:auto">
      <h2 style="margin-bottom:16px">${title}</h2>

      <div style="margin-bottom:12px">
        <label style="display:block;font-size:13px;margin-bottom:4px">店家名稱 *</label>
        <input id="lm_store_name" type="text" value="${escHtml(lic.store_name)}" placeholder="例：台北店" style="width:100%;box-sizing:border-box">
      </div>
      <div style="margin-bottom:12px">
        <label style="display:block;font-size:13px;margin-bottom:4px">Store ID * <span style="color:#888;font-size:11px">（英數字，唯一識別）</span></label>
        <input id="lm_store_id" type="text" value="${escHtml(lic.store_id)}" placeholder="例：taipei_01" ${_editingStoreId ? 'readonly style="opacity:0.6"' : ''} style="width:100%;box-sizing:border-box">
      </div>

      <div style="margin-bottom:12px">
        <label style="display:block;font-size:13px;margin-bottom:4px">方案</label>
        <select id="lm_plan" onchange="licenseOnPlanChange()" style="width:100%">${planOptions}</select>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="lm_active" ${lic.active ? 'checked' : ''} style="width:16px;height:16px">
          <span>帳號啟用（關閉後 Android App 無法登入）</span>
        </label>
      </div>

      <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <strong style="font-size:14px">功能授權開關</strong>
          <button class="btn-secondary" style="font-size:12px;padding:3px 10px" onclick="licenseApplyPlanDefaults()">套用方案預設</button>
        </div>
        <div id="lm_features">${featureRows}</div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn-secondary" onclick="closeLicenseModal()">取消</button>
        <button class="btn-primary" onclick="licenseSave()">💾 儲存</button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

function closeLicenseModal() {
  const m = document.getElementById('licenseModal');
  if (m) m.remove();
}

// 當切換 plan 時詢問是否套用預設
function licenseOnPlanChange() {
  // nothing auto — user must click "套用方案預設"
}

async function licenseApplyPlanDefaults() {
  const plan = document.getElementById('lm_plan')?.value;
  if (!plan) return;
  try {
    const res  = await fetch('/api/license/plans/defaults');
    const data = await res.json();
    const defaults = data.data && data.data[plan];
    if (!defaults) return;
    Object.entries(defaults).forEach(([k, v]) => {
      const cb = document.getElementById(`lf_${k}`);
      if (cb) cb.checked = !!v;
    });
  } catch(e) {
    alert('無法取得方案預設：' + e.message);
  }
}

async function licenseSave() {
  const store_id   = document.getElementById('lm_store_id')?.value.trim();
  const store_name = document.getElementById('lm_store_name')?.value.trim();
  const plan       = document.getElementById('lm_plan')?.value;
  const active     = document.getElementById('lm_active')?.checked;

  if (!store_id || !store_name) { alert('請填寫店家名稱與 Store ID'); return; }

  const features = {};
  Object.keys(FEATURE_LABELS).forEach(k => {
    features[k] = !!(document.getElementById(`lf_${k}`)?.checked);
  });

  try {
    let res;
    if (_editingStoreId) {
      res = await fetch(`/api/license/${_editingStoreId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_name, plan, active, features })
      });
    } else {
      res = await fetch('/api/license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id, store_name, plan, active, features })
      });
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    closeLicenseModal();
    loadLicenses();
    showToast?.('✅ 授權已儲存');
  } catch (e) {
    alert('儲存失敗：' + e.message);
  }
}

async function licenseDelete(storeId, storeName) {
  if (storeId === 'default_store') { alert('預設店家不可刪除'); return; }
  if (!confirm(`確定要刪除「${storeName}」的授權嗎？`)) return;
  try {
    const res  = await fetch(`/api/license/${storeId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    loadLicenses();
    showToast?.('🗑️ 授權已刪除');
  } catch (e) {
    alert('刪除失敗：' + e.message);
  }
}

// ── 當切換到授權 Tab 時自動載入 ─────────────────────────
(function patchSwitchSettingsTab() {
  const _orig = window.switchSettingsTab;
  if (typeof _orig !== 'function') {
    // if original not yet defined, poll
    const t = setInterval(() => {
      if (typeof window.switchSettingsTab === 'function') {
        clearInterval(t);
        patchSwitchSettingsTab();
      }
    }, 200);
    return;
  }
  window.switchSettingsTab = function(tab) {
    _orig(tab);
    if (tab === 'license') loadLicenses();
  };
})();
