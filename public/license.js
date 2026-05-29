/* license.js — 店家授權管理 (v18-r1-fix2)
 *
 * Fix2 修正：
 *  1. 編輯按鈕 onclick 雙引號衝突 → 改用 data-store-id attribute + addEventListener
 *  2. 新增 ADMIN_MODE 控制：呼叫 /api/admin/status 決定是否顯示授權管理
 *  3. 非 ADMIN_MODE 下隱藏整個授權 Tab
 */

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
let _adminMode      = false;

// ── 工具 ─────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function licToast(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type || 'success');
}

// ── ADMIN_MODE 初始化 ─────────────────────────────────────
async function initAdminMode() {
  try {
    const res  = await fetch('/api/admin/status');
    const data = await res.json();
    _adminMode = !!data.admin_mode;
  } catch {
    _adminMode = false;
  }
  applyAdminModeUI();
}

function applyAdminModeUI() {
  const tabBtn = document.querySelector('[data-stab="license"]');
  if (!tabBtn) return;
  if (_adminMode) {
    tabBtn.style.display = '';
  } else {
    tabBtn.style.display = 'none';
    // 若目前在 license tab，切回 basic
    const panel = document.getElementById('stab-license');
    if (panel && panel.style.display !== 'none') {
      if (typeof switchSettingsTab === 'function') switchSettingsTab('basic');
    }
  }
}

// ── 載入授權清單 ──────────────────────────────────────────
async function loadLicenses() {
  if (!_adminMode) return;
  const el = document.getElementById('licenseList');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-secondary,#aaa);padding:12px">載入中…</div>';
  try {
    const res = await fetch('/api/license');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '未知錯誤');
    _allLicenses = data.data || [];
    renderLicenseList(_allLicenses);
  } catch (e) {
    el.innerHTML = `<div style="color:#e53935;padding:12px">載入失敗：${escHtml(e.message)}</div>`;
  }
}

// ── 渲染清單（使用 data-* attribute，避免 onclick 引號衝突）────
function renderLicenseList(list) {
  const el = document.getElementById('licenseList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = '<div style="color:var(--text-secondary,#aaa);padding:12px">尚無授權資料</div>';
    return;
  }

  el.innerHTML = list.map((lic, idx) => {
    const planColor = PLAN_COLORS[lic.plan] || '#607d8b';
    const activeTag = lic.active
      ? '<span style="background:#43a047;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">✅ 啟用</span>'
      : '<span style="background:#e53935;color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">🔴 停用</span>';

    const chips = Object.entries(FEATURE_LABELS).map(([k, label]) => {
      const on = lic.features && lic.features[k];
      return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;margin:2px;
        background:${on?'#e8f5e9':'#2a2a2a'};color:${on?'#2e7d32':'#9e9e9e'};
        border:1px solid ${on?'#a5d6a7':'#444'}">${escHtml(label)} ${on?'✓':'✗'}</span>`;
    }).join('');

    // ★ 關鍵修正：使用 data-idx attribute，不在 onclick 直接嵌入字串
    return `<div style="border:1px solid var(--border,#333);border-radius:10px;padding:16px;margin-bottom:12px;background:var(--bg-card,#1e1e2e)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-weight:700;font-size:16px">${escHtml(lic.store_name)}</span>
        <span style="font-size:12px;color:#888">ID: <code>${escHtml(lic.store_id)}</code></span>
        <span style="background:${planColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${escHtml(PLAN_LABELS[lic.plan]||lic.plan)}</span>
        ${activeTag}
        <div style="margin-left:auto;display:flex;gap:6px;flex-shrink:0">
          <button class="lic-edit-btn" data-idx="${idx}"
            style="font-size:12px;padding:4px 12px;background:transparent;border:1px solid var(--border,#555);border-radius:6px;color:var(--text-primary,#fff);cursor:pointer">
            ✏️ 編輯</button>
          <button class="lic-del-btn" data-idx="${idx}"
            style="font-size:12px;padding:4px 12px;background:transparent;border:1px solid #e53935;border-radius:6px;color:#e53935;cursor:pointer">
            🗑️ 刪除</button>
        </div>
      </div>
      <div>${chips}</div>
    </div>`;
  }).join('');

  // ★ 事件委派：統一在 licenseList 上綁定，避免 onclick HTML 屬性的引號問題
  el.removeEventListener('click', _licenseListClick);
  el.addEventListener('click', _licenseListClick);
}

function _licenseListClick(e) {
  const editBtn = e.target.closest('.lic-edit-btn');
  const delBtn  = e.target.closest('.lic-del-btn');
  if (editBtn) {
    const idx = parseInt(editBtn.dataset.idx, 10);
    licenseEdit(_allLicenses[idx]);
  } else if (delBtn) {
    const idx = parseInt(delBtn.dataset.idx, 10);
    const lic = _allLicenses[idx];
    licenseDelete(lic.store_id, lic.store_name);
  }
}

// ── 新增 ──────────────────────────────────────────────────
function licenseOpenAddModal() {
  if (!_adminMode) return;
  _editingStoreId = null;
  showLicenseModal({
    store_id: '', store_name: '', plan: 'basic', active: true,
    features: { order:true,orders:true,products:true,reports:true,print:true,
                inventory:false,line_order:false,delivery:false,
                marketing:false,member:false,coupon:false,label_print:false }
  }, '➕ 新增店家授權');
}

// ── 編輯（傳入 lic 物件，不再傳字串避免引號問題）──────────
function licenseEdit(lic) {
  if (!_adminMode) return;
  if (!lic) { alert('找不到授權資料，請重新整理'); return; }
  _editingStoreId = lic.store_id;
  showLicenseModal(lic, `✏️ 編輯授權：${lic.store_name}`);
}

// ── Modal ─────────────────────────────────────────────────
function showLicenseModal(lic, title) {
  document.getElementById('licenseModal')?.remove();

  const planOptions = ['basic','pro','enterprise'].map(p =>
    `<option value="${p}"${lic.plan===p?' selected':''}>${PLAN_LABELS[p]}</option>`
  ).join('');

  const featureRows = Object.entries(FEATURE_LABELS).map(([k, label]) => {
    const on = lic.features ? !!lic.features[k] : false;
    return `<label style="display:flex;align-items:center;gap:10px;padding:5px 0;cursor:pointer;user-select:none">
      <input type="checkbox" id="lf_${k}" ${on?'checked':''} style="width:16px;height:16px;cursor:pointer">
      <span style="font-size:14px">${escHtml(label)}</span>
    </label>`;
  }).join('');

  const isEdit = !!_editingStoreId;
  const inputStyle = 'width:100%;box-sizing:border-box;padding:8px 10px;background:var(--bg-card,#1e1e2e);border:1px solid var(--border,#444);border-radius:6px;color:var(--text-primary,#fff);font-size:14px';
  const readonlyStyle = inputStyle + ';opacity:.6;cursor:not-allowed';

  const modal = document.createElement('div');
  modal.id = 'licenseModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.75);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-primary,#12121f);border:1px solid var(--border,#333);border-radius:12px;
                padding:24px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto;
                box-shadow:0 20px 60px rgba(0,0,0,.6)">
      <h2 style="margin:0 0 20px;font-size:18px">${escHtml(title)}</h2>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px">店家名稱 *</label>
        <input id="lm_store_name" type="text" value="${escHtml(lic.store_name)}" placeholder="例：台北店" style="${inputStyle}">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px">
          Store ID * <span style="color:#888;font-size:11px">${isEdit ? '（編輯模式不可修改）' : '（英數字 / 底線，唯一識別）'}</span>
        </label>
        <input id="lm_store_id" type="text" value="${escHtml(lic.store_id)}" placeholder="例：taipei_01"
          ${isEdit ? 'readonly' : ''} style="${isEdit ? readonlyStyle : inputStyle}">
      </div>

      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;color:var(--text-secondary,#aaa);margin-bottom:4px">方案</label>
        <select id="lm_plan" style="${inputStyle}">${planOptions}</select>
      </div>

      <div style="margin-bottom:18px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <input type="checkbox" id="lm_active" ${lic.active?'checked':''} style="width:16px;height:16px;cursor:pointer">
          <span style="font-size:14px">帳號啟用（取消後 Android App 無法登入）</span>
        </label>
      </div>

      <div style="border:1px solid var(--border,#444);border-radius:8px;padding:14px;margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <strong style="font-size:14px">功能授權開關</strong>
          <button id="lm_apply_plan_btn"
            style="font-size:12px;padding:4px 12px;background:transparent;border:1px solid var(--border,#555);
                   border-radius:6px;color:var(--text-primary,#fff);cursor:pointer">
            🔄 套用方案預設
          </button>
        </div>
        <div id="lm_features">${featureRows}</div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="lm_cancel_btn"
          style="padding:8px 20px;background:transparent;border:1px solid var(--border,#555);
                 border-radius:6px;color:var(--text-primary,#fff);cursor:pointer;font-size:14px">
          取消
        </button>
        <button id="lm_save_btn"
          style="padding:8px 20px;background:#1976d2;border:none;border-radius:6px;
                 color:#fff;cursor:pointer;font-size:14px;font-weight:600">
          💾 儲存
        </button>
      </div>
    </div>`;

  // backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) closeLicenseModal(); });
  document.body.appendChild(modal);

  // button events (DOM-based, no onclick attr)
  modal.querySelector('#lm_cancel_btn').addEventListener('click', closeLicenseModal);
  modal.querySelector('#lm_save_btn').addEventListener('click', licenseSave);
  modal.querySelector('#lm_apply_plan_btn').addEventListener('click', licenseApplyPlanDefaults);
}

function closeLicenseModal() {
  document.getElementById('licenseModal')?.remove();
}

// ── 套用方案預設 ──────────────────────────────────────────
async function licenseApplyPlanDefaults() {
  const plan = document.getElementById('lm_plan')?.value;
  if (!plan) return;
  try {
    const res  = await fetch('/api/license/plans/defaults');
    const data = await res.json();
    const defs = data.data?.[plan];
    if (!defs) return;
    Object.entries(defs).forEach(([k, v]) => {
      const cb = document.getElementById(`lf_${k}`);
      if (cb) cb.checked = !!v;
    });
    licToast(`已套用 ${PLAN_LABELS[plan]||plan} 方案預設`, 'success');
  } catch(e) {
    alert('無法取得方案預設：' + e.message);
  }
}

// ── 儲存 ──────────────────────────────────────────────────
async function licenseSave() {
  const store_id   = (document.getElementById('lm_store_id')?.value || '').trim();
  const store_name = (document.getElementById('lm_store_name')?.value || '').trim();
  const plan       = document.getElementById('lm_plan')?.value || 'basic';
  const active     = !!document.getElementById('lm_active')?.checked;

  if (!store_name) { alert('請填寫店家名稱'); return; }
  if (!_editingStoreId && !store_id) { alert('請填寫 Store ID'); return; }

  const features = {};
  Object.keys(FEATURE_LABELS).forEach(k => {
    features[k] = !!(document.getElementById(`lf_${k}`)?.checked);
  });

  const saveBtn = document.getElementById('lm_save_btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '儲存中…'; }

  try {
    let res;
    if (_editingStoreId) {
      res = await fetch(`/api/license/${encodeURIComponent(_editingStoreId)}`, {
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '儲存失敗');
    closeLicenseModal();
    await loadLicenses();
    licToast(_editingStoreId ? '✅ 授權已更新' : '✅ 授權已新增', 'success');
  } catch (e) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 儲存'; }
    alert('儲存失敗：' + e.message);
  }
}

// ── 刪除 ──────────────────────────────────────────────────
async function licenseDelete(storeId, storeName) {
  if (storeId === 'default_store') { alert('預設店家不可刪除'); return; }
  if (!confirm(`確定要刪除「${storeName}」的授權嗎？\n此操作無法復原。`)) return;
  try {
    const res  = await fetch(`/api/license/${encodeURIComponent(storeId)}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message||`HTTP ${res.status}`); }
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '刪除失敗');
    await loadLicenses();
    licToast('🗑️ 授權已刪除', 'success');
  } catch (e) {
    alert('刪除失敗：' + e.message);
  }
}

// ── Tab 切換掛接 ──────────────────────────────────────────
function _hookLicenseTab() {
  const origFn = window.switchSettingsTab;
  if (typeof origFn === 'function') {
    window.switchSettingsTab = function(tab) {
      origFn.call(this, tab);
      if (tab === 'license' && _adminMode) loadLicenses();
    };
  }
}

// ── 初始化 ────────────────────────────────────────────────
(function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _hookLicenseTab(); initAdminMode(); });
  } else {
    _hookLicenseTab();
    initAdminMode();
  }
})();
