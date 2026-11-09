// routes/popup-pickup.js — H1.4.12 Phase 2
//
// 🚐 快閃取餐排程中心 — 管理端 API（campaigns / locations / sessions）。
// 全部端點一律：
//   - requireStaffJwt：store_id 只信任已驗證 JWT，不接受 query/body/header 冒充。
//   - requireFeature('line_order')：沿用既有 LINE 點餐 license gate。
//   - 所有查詢/更新/刪除一律帶 WHERE store_id=?；跨店資源一律回傳 404，不
//     透露該資源存在於別店（不回傳 403，避免資源存在與否的差異被推斷出來）。
// 本檔案不處理：/popup-order 公開入口、購物車、真實下單、allocation 扣減、
// 後台 UI、QR Code、出單機/n8n/WebSocket/LINE Pay、Analytics/XSS —— 全部
// 維持 Phase 3～5 範圍。
'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../utils/db');
const { requireStaffJwt } = require('../middleware/storeGuard');
const { requireFeature } = require('../middleware/featureGate');
const pp = require('../utils/popupPickup');
const { countActivePopupOrdersForSession } = require('../utils/popupCheckout');
const ppay = require('../utils/popupPayment');
const pregion = require('../utils/popupRegion'); // R51

router.use(requireStaffJwt);
router.use(requireFeature('line_order'));

// ══════════════════════════════════════════════════════════════════════
// 共用 helper
// ══════════════════════════════════════════════════════════════════════
const { isDurableError } = require('../utils/db');
function sendError(res, err) {
  if (err instanceof ppay.PopupPaymentError) {
    return res.status(err.status).json({ success: false, error: err.code, message: err.message });
  }
  if (err instanceof pp.PopupValidationError) {
    return res.status(err.status).json({ success: false, error: err.code, message: err.message, ...(err.extra || {}) });
  }
  console.error('[popup-pickup] internal error:', err && err.stack ? err.stack : err);
  if (isDurableError(err)) return res.status(503).json({ success: false, error: 'STORAGE_UNAVAILABLE', message: '系統忙碌中，請稍後再試' }); // R44.2F.1：固定 payload
  return res.status(500).json({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '系統發生錯誤，請稍後再試' });
}

function clampLimit(raw, def, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function getOwnedCampaign(db, storeId, campaignId) {
  const row = db.get('SELECT * FROM popup_campaigns WHERE id=? AND store_id=?', [campaignId, storeId]);
  if (!row) pp.fail('POPUP_RESOURCE_NOT_FOUND', '找不到指定的快閃活動', 404);
  return row;
}
function getOwnedLocation(db, storeId, locationId) {
  const row = db.get('SELECT * FROM popup_locations WHERE id=? AND store_id=?', [locationId, storeId]);
  if (!row) pp.fail('POPUP_RESOURCE_NOT_FOUND', '找不到指定的快閃地點', 404);
  return row;
}
function getOwnedSession(db, storeId, sessionId) {
  const row = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [sessionId, storeId]);
  if (!row) pp.fail('POPUP_RESOURCE_NOT_FOUND', '找不到指定的快閃場次', 404);
  return row;
}

// 唯一 public_code 產生 + 有限次重試（唯一衝突時重新產生，不改用流水號）。
// 安全例外（規格四第 6 點明文允許）：public_code 的唯一性檢查故意採用
// 「全域」查詢（不帶 store_id）——因為 schema 設計上 public_code 本身就是
// 給「所有店家共用的公開網址／QR Code」用的全域唯一值（Phase 3 的
// `/popup-order?session=<public_code>` 需要單靠這個代碼就查到正確場次，
// 不能要求網址還要帶 store_id），所以這裡刻意不加店家範圍，其餘所有查詢
// 一律仍要求 store_id。
function generateUniquePublicCode(db, table, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = pp.generatePublicCode();
    const existing = db.get(`SELECT id FROM ${table} WHERE public_code=?`, [code]); // 安全例外：全域唯一性查詢
    if (!existing) return code;
  }
  pp.fail('POPUP_INTERNAL_ERROR', 'public_code 產生失敗，請重試', 500);
}

function assertProductsOwnedByStore(db, storeId, productIds) {
  if (productIds.length === 0) return;
  const placeholders = productIds.map(() => '?').join(',');
  const rows = db.all(`SELECT id FROM products WHERE store_id=? AND id IN (${placeholders})`, [storeId, ...productIds]);
  const foundIds = new Set(rows.map((r) => Number(r.id)));
  const missing = productIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    pp.fail('POPUP_VALIDATION_ERROR', `商品不存在或不屬於此店家：${missing.join(',')}`);
  }
}

// selected products 陣列驗證（規格三）：不得為空、product_id 安全正整數、
// 不得重複、必須真實存在且屬於本店、quota_qty 安全非負整數、enabled 只接受
// 嚴格 boolean/0-1（不使用 truthy coercion）。回傳正規化後的
// [{product_id,enabled,quota_qty}]。
function validateSelectedProducts(db, storeId, products) {
  if (!Array.isArray(products) || products.length === 0) {
    pp.fail('POPUP_VALIDATION_ERROR', 'product_scope=selected 時 products 陣列不得為空');
  }
  const seen = new Set();
  const normalized = products.map((p, idx) => {
    if (!p || !pp.isPositiveInt(p.product_id)) {
      pp.fail('POPUP_VALIDATION_ERROR', `products[${idx}].product_id 必須是大於 0 的安全整數`);
    }
    if (seen.has(p.product_id)) {
      pp.fail('POPUP_VALIDATION_ERROR', `products 陣列中商品 id=${p.product_id} 重複`);
    }
    seen.add(p.product_id);
    const quotaQty = p.quota_qty === undefined ? 0 : p.quota_qty;
    if (!pp.isNonNegativeInt(quotaQty)) {
      pp.fail('POPUP_VALIDATION_ERROR', `products[${idx}].quota_qty 必須是大於等於 0 的安全整數`);
    }
    let enabled = 1;
    if (p.enabled !== undefined) {
      enabled = pp.normalizeStrictBoolTo01(p.enabled);
      if (enabled === null) {
        pp.fail('POPUP_VALIDATION_ERROR', `products[${idx}].enabled 只接受 true/false/1/0（布林或對應字串），其他值一律拒絕`);
      }
    }
    return { product_id: p.product_id, enabled, quota_qty: quotaQty };
  });
  assertProductsOwnedByStore(db, storeId, normalized.map((p) => p.product_id));
  return normalized;
}

function serializeCampaign(row) {
  return {
    id: row.id,
    public_code: row.public_code,
    name: row.name,
    description: row.description,
    image_url: row.image_url,
    status: row.status,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function serializeLocation(row) {
  return {
    id: row.id,
    name: row.name,
    place_id: row.place_id,
    address: row.address,
    address_note: row.address_note,
    lat: row.lat,
    lng: row.lng,
    // R51：結構化地區（空白＝地區待補；不影響既有欄位）
    city: row.city || '',
    district: row.district || '',
    postal_code: row.postal_code || '',
    region_pending: !(row.city && row.district),
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
// Phase 2.1 修正：serializeSession() 明確接收 storeId 參數（不再省略），
// 內部讀取 popup_session_products 一律加上 AND store_id=?，避免「同一個
// session_id 理論上不會跨店重複」的假設被資料污染攻破（見 poisoned-data
// 測試：手動塞一筆 store_002 的 popup_session_products，session_id 故意
// 跟 store_001 的某個 session 相同，驗證不會混進回應）。
function serializeSession(db, row, campaignStatus, now, storeId) {
  const sessionOrderCount = countActivePopupOrdersForSession(db, storeId, row.id);
  const stateResult = pp.resolvePopupSessionState({
    campaignStatus,
    sessionStatus: row.status,
    pickupDate: row.pickup_date,
    pickupStartTime: row.pickup_start_time,
    pickupEndTime: row.pickup_end_time,
    orderOpenAt: row.order_open_at,
    orderCutoffAt: row.order_cutoff_at,
    now,
  });
  let products = [];
  if (row.product_scope === 'selected') {
    products = db.all(
      'SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=? ORDER BY product_id',
      [row.id, storeId]
    ).map((p) => ({ product_id: p.product_id, enabled: !!p.enabled, quota_qty: p.quota_qty }));
  }
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    public_code: row.public_code,
    name: row.name,
    pickup_date: row.pickup_date,
    pickup_start_time: row.pickup_start_time,
    pickup_end_time: row.pickup_end_time,
    order_open_at: row.order_open_at,
    order_cutoff_at: row.order_cutoff_at,
    location_id: row.location_id,
    place_name: row.place_name,
    place_id: row.place_id,
    address: row.address,
    address_note: row.address_note,
    lat: row.lat,
    lng: row.lng,
    city: row.city || '', // R51：場次地區 snapshot（空白＝地區待補）
    district: row.district || '',
    status: row.status,
    product_scope: row.product_scope,
    max_orders: row.max_orders,
    sort_order: row.sort_order,
    revision: row.revision,
    products,
    effective_state: stateResult.state,
    can_order: stateResult.can_order,
    ...(stateResult.error_code ? { state_error_code: stateResult.error_code } : {}),
    // H1.4.12 Phase 3C：管理端與 checkout 共用同一顆權威計數函式
    // （countActivePopupOrdersForSession），確保「後台顯示已額滿」跟
    // 「顧客端 checkout 真的擋下」永遠是同一套判斷，不是各自維護的第二份邏輯。
    // 同一個 row 只查一次，order_count / remaining_orders / is_full 三個欄位
    // 都從這一個數字推導，避免同一次序列化裡多次查詢可能不一致。
    order_count: sessionOrderCount,
    remaining_orders: (pp.isPositiveInt(row.max_orders) && row.max_orders > 0)
      ? Math.max(0, row.max_orders - sessionOrderCount)
      : null,
    is_full: (pp.isPositiveInt(row.max_orders) && row.max_orders > 0) && sessionOrderCount >= row.max_orders,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Phase 2.1 新增：campaign 狀態查詢一律加上 store_id=?（原本只用 id=?，
// 理論上 campaign.id 是 UUID「幾乎不會跨店碰撞」，但規格明確禁止用這個理由
// 取代強制 store isolation，因此統一改走這個 helper）。
function getCampaignStatusScoped(db, storeId, campaignId) {
  const row = db.get('SELECT status FROM popup_campaigns WHERE id=? AND store_id=?', [campaignId, storeId]);
  return row ? row.status : 'archived'; // campaign 若不存在/不屬於本店，安全 fallback 成終止狀態
}

// ══════════════════════════════════════════════════════════════════════
// Campaign API
// ══════════════════════════════════════════════════════════════════════
router.get('/campaigns', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const limit = clampLimit(req.query.limit, 100, 500);
    const rows = db.all(
      'SELECT * FROM popup_campaigns WHERE store_id=? ORDER BY sort_order ASC, created_at DESC LIMIT ?',
      [storeId, limit]
    );
    res.json({ success: true, data: rows.map(serializeCampaign) });
  } catch (e) { sendError(res, e); }
});

router.post('/campaigns', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};

    if (!pp.isNonEmptyString(body.name, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');
    if (!pp.isOptionalString(body.description, 2000)) pp.fail('POPUP_VALIDATION_ERROR', 'description 長度超出限制');
    if (!pp.isOptionalString(body.image_url, 1000)) pp.fail('POPUP_VALIDATION_ERROR', 'image_url 長度超出限制');
    const sortOrder = body.sort_order === undefined ? 0 : body.sort_order;
    if (!pp.isNonNegativeInt(sortOrder)) pp.fail('POPUP_VALIDATION_ERROR', 'sort_order 必須是大於等於 0 的整數');
    const status = body.status === undefined ? 'draft' : body.status;
    if (!pp.CAMPAIGN_STATUSES.includes(status)) pp.fail('POPUP_VALIDATION_ERROR', `status 必須是 ${pp.CAMPAIGN_STATUSES.join('/')} 其中之一`);

    const id = uuidv4();
    const publicCode = generateUniquePublicCode(db, 'popup_campaigns');
    db.runDurableTransaction(() => { db._db.run(
      `INSERT INTO popup_campaigns (id, store_id, public_code, name, description, image_url, status, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, storeId, publicCode, body.name.trim(), body.description || '', body.image_url || '', status, sortOrder]
    ); }); // R44.2F.1

    const row = db.get('SELECT * FROM popup_campaigns WHERE id=? AND store_id=?', [id, storeId]);
    res.status(201).json({ success: true, data: serializeCampaign(row) });
  } catch (e) { sendError(res, e); }
});

router.get('/campaigns/:campaignId', (req, res) => {
  try {
    const db = getDb();
    const row = getOwnedCampaign(db, req.storeId, req.params.campaignId);
    res.json({ success: true, data: serializeCampaign(row) });
  } catch (e) { sendError(res, e); }
});

router.patch('/campaigns/:campaignId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedCampaign(db, storeId, req.params.campaignId);
    const body = req.body || {};

    // archived 是終止狀態，不得被一般 PATCH 無聲恢復或修改任何欄位。
    if (existing.status === 'archived') {
      pp.fail('POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE', '此活動已封存（archived），為終止狀態，不可再修改', 409);
    }

    const next = {
      name: body.name !== undefined ? body.name : existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      image_url: body.image_url !== undefined ? body.image_url : existing.image_url,
      sort_order: body.sort_order !== undefined ? body.sort_order : existing.sort_order,
      status: body.status !== undefined ? body.status : existing.status,
    };
    if (!pp.isNonEmptyString(next.name, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');
    if (!pp.isOptionalString(next.description, 2000)) pp.fail('POPUP_VALIDATION_ERROR', 'description 長度超出限制');
    if (!pp.isOptionalString(next.image_url, 1000)) pp.fail('POPUP_VALIDATION_ERROR', 'image_url 長度超出限制');
    if (!pp.isNonNegativeInt(next.sort_order)) pp.fail('POPUP_VALIDATION_ERROR', 'sort_order 必須是大於等於 0 的整數');
    if (!pp.CAMPAIGN_STATUSES.includes(next.status)) pp.fail('POPUP_VALIDATION_ERROR', `status 必須是 ${pp.CAMPAIGN_STATUSES.join('/')} 其中之一`);
    // R50：已啟用快閃付款設定的店家，沒有任何可用付款方式的活動不得發布。
    if (next.status === 'published' && existing.status !== 'published' && ppay.isPopupPaymentConfigured(db, storeId)
      && (ppay.effectiveCampaignMethods(db, storeId, existing.id) || []).length === 0) {
      pp.fail('POPUP_PAYMENT_NO_USABLE_METHOD', '此活動目前沒有可用的付款方式，請先在「💳 付款方式管理」完成設定再發布', 409);
    }

    db.runDurableTransaction(() => { db._db.run(
      `UPDATE popup_campaigns SET name=?, description=?, image_url=?, sort_order=?, status=?, updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [next.name.trim(), next.description || '', next.image_url || '', next.sort_order, next.status, existing.id, storeId]
    ); }); // R44.2F.1

    const row = db.get('SELECT * FROM popup_campaigns WHERE id=? AND store_id=?', [existing.id, storeId]);
    res.json({ success: true, data: serializeCampaign(row) });
  } catch (e) { sendError(res, e); }
});

router.delete('/campaigns/:campaignId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedCampaign(db, storeId, req.params.campaignId);

    const sessionCount = db.get('SELECT COUNT(*) as c FROM popup_sessions WHERE campaign_id=? AND store_id=?', [existing.id, storeId]).c;
    if (sessionCount > 0) {
      pp.fail('POPUP_CAMPAIGN_HAS_SESSIONS', '此活動已有場次，不得直接刪除，請改用封存（archived）', 409, { session_count: sessionCount });
    }

    db.runDurableTransaction(() => { db._db.run('DELETE FROM popup_campaigns WHERE id=? AND store_id=?', [existing.id, storeId]); }); // R44.2F.1
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
// R50：💳 快閃付款方式管理（快閃獨立通路設定；store_id 只來自 JWT）
// 回應只含啟用狀態／可用性／原因／顧客說明，絕不含任何 provider credential。
// ══════════════════════════════════════════════════════════════════════
function paymentAdminView(db, storeId) {
  const configured = ppay.isPopupPaymentConfigured(db, storeId);
  const settings = ppay.loadPopupPaymentSettings(db, storeId) || ppay.defaultPopupPaymentSettings();
  const campaigns = db.all('SELECT id, name, status FROM popup_campaigns WHERE store_id=? ORDER BY sort_order ASC, created_at DESC LIMIT 500', [storeId]).map((c) => {
    const ov = ppay.getCampaignOverride(db, storeId, c.id);
    return { id: c.id, name: c.name, status: c.status, mode: ov.mode, methods: ov.methods, effective: configured ? ppay.effectiveCampaignMethods(db, storeId, c.id) : null };
  });
  const { updated_by, ...pub } = settings;
  return { configured, settings: pub, methods: ppay.describeMethods(db, storeId, settings), store_usable: configured ? ppay.storeUsableMethods(db, storeId, settings) : [],
    limits: { timeout_min: ppay.TIMEOUT_MIN, timeout_max: ppay.TIMEOUT_MAX }, campaigns };
}
router.get('/payment-settings', (req, res) => {
  try {
    const db = getDb();
    if (ppay.isPopupPaymentConfigured(db, req.storeId)) ppay.reconcileExpiredPopupPayments(db, req.storeId);
    res.json({ success: true, data: paymentAdminView(db, req.storeId) });
  } catch (e) { sendError(res, e); }
});
router.put('/payment-settings', (req, res) => {
  try {
    const db = getDb();
    ppay.savePopupPaymentSettings(db, req.storeId, req.body || {}, req.auth && req.auth.role ? String(req.auth.role) : 'staff');
    res.json({ success: true, data: paymentAdminView(db, req.storeId) });
  } catch (e) { sendError(res, e); }
});
// R51：金流連線診斷（唯讀；只回傳是否已設定、模式與網址網域，絕不回傳任何秘密值）。
router.get('/payment-diagnostics', (req, res) => {
  try {
    const db = getDb();
    res.json({ success: true, data: ppay.paymentDiagnostics(db, req.storeId, req) });
  } catch (e) { sendError(res, e); }
});
router.get('/campaigns/:campaignId/payment-settings', (req, res) => {
  try {
    const db = getDb();
    const c = getOwnedCampaign(db, req.storeId, req.params.campaignId);
    const configured = ppay.isPopupPaymentConfigured(db, req.storeId);
    res.json({ success: true, data: { campaign_id: c.id, configured, ...ppay.getCampaignOverride(db, req.storeId, c.id), store_usable: configured ? ppay.storeUsableMethods(db, req.storeId) : [], effective: configured ? ppay.effectiveCampaignMethods(db, req.storeId, c.id) : null } });
  } catch (e) { sendError(res, e); }
});
router.put('/campaigns/:campaignId/payment-settings', (req, res) => {
  try {
    const db = getDb();
    const c = getOwnedCampaign(db, req.storeId, req.params.campaignId);
    const ov = ppay.saveCampaignOverride(db, req.storeId, c.id, req.body || {});
    res.json({ success: true, data: { campaign_id: c.id, configured: true, ...ov, store_usable: ppay.storeUsableMethods(db, req.storeId), effective: ppay.effectiveCampaignMethods(db, req.storeId, c.id) } });
  } catch (e) { sendError(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
// Location API
// ══════════════════════════════════════════════════════════════════════
router.get('/locations', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const limit = clampLimit(req.query.limit, 200, 500);
    let sql = 'SELECT * FROM popup_locations WHERE store_id=?';
    const params = [storeId];
    if (req.query.active === '1' || req.query.active === '0') {
      sql += ' AND active=?';
      params.push(req.query.active === '1' ? 1 : 0);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = db.all(sql, params);
    res.json({ success: true, data: rows.map(serializeLocation) });
  } catch (e) { sendError(res, e); }
});

function validateLatLng(lat, lng) {
  const hasLat = lat !== undefined && lat !== null;
  const hasLng = lng !== undefined && lng !== null;
  if (hasLat !== hasLng) pp.fail('POPUP_VALIDATION_ERROR', 'lat 與 lng 必須同時存在或同時為空');
  if (hasLat && !pp.isValidLat(lat)) pp.fail('POPUP_VALIDATION_ERROR', 'lat 必須在 -90 ~ 90 之間');
  if (hasLng && !pp.isValidLng(lng)) pp.fail('POPUP_VALIDATION_ERROR', 'lng 必須在 -180 ~ 180 之間');
  return { lat: hasLat ? lat : null, lng: hasLng ? lng : null };
}

// R51：地點的縣市／行政區／郵遞區號。三欄一起處理（原子）：有送任何一欄就以
// 送來的值為準（經權威行政區清單正規化／驗證）；都沒送時，新增或地址有變更
// 的情況下才用地址開頭精確比對自動帶入，否則沿用既有值。
function resolveLocationRegionInput(body, address, existing) {
  const provided = ['city', 'district', 'postal_code'].some((k) => body[k] !== undefined);
  if (provided) {
    ['city', 'district', 'postal_code'].forEach((k) => { if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') pp.fail('POPUP_VALIDATION_ERROR', `${k} 必須是文字`); });
    const r = pregion.normalizeRegionInput({ city: body.city || '', district: body.district || '', postal_code: body.postal_code || '' });
    if (!r.city) {
      const parsed = pregion.parseRegionFromAddress(address);
      if (parsed) return { city: parsed.city, district: parsed.district, postal_code: r.postal_code || parsed.postal_code };
    }
    return r;
  }
  if (existing && String(existing.address || '').trim() === String(address || '').trim()) {
    return { city: existing.city || '', district: existing.district || '', postal_code: existing.postal_code || '' };
  }
  const parsed = pregion.parseRegionFromAddress(address);
  return parsed || { city: '', district: '', postal_code: '' };
}

router.get('/regions', (req, res) => {
  try { res.json({ success: true, data: pregion.listRegionCatalog() }); } catch (e) { sendError(res, e); }
});

router.post('/locations', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};

    if (!pp.isNonEmptyString(body.name, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');
    if (!pp.isNonEmptyString(body.address, 500)) pp.fail('POPUP_VALIDATION_ERROR', 'address 必填，且長度需在 1~500 字之間');
    if (!pp.isOptionalString(body.address_note, 500)) pp.fail('POPUP_VALIDATION_ERROR', 'address_note 長度超出限制');
    if (!pp.isOptionalString(body.place_id, 300)) pp.fail('POPUP_VALIDATION_ERROR', 'place_id 長度超出限制');
    const { lat, lng } = validateLatLng(body.lat, body.lng);
    const region = resolveLocationRegionInput(body, body.address, null);
    let active = 1;
    if (body.active !== undefined) {
      active = pp.normalizeStrictBoolTo01(body.active);
      if (active === null) pp.fail('POPUP_VALIDATION_ERROR', 'active 只接受 true/false/1/0（布林或對應字串），其他值一律拒絕');
    }

    const id = uuidv4();
    db.runDurableTransaction(() => { db._db.run(
      `INSERT INTO popup_locations (id, store_id, name, place_id, address, address_note, lat, lng, active, city, district, postal_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, storeId, body.name.trim(), body.place_id || '', body.address.trim(), body.address_note || '', lat, lng, active, region.city, region.district, region.postal_code]
    ); }); // R44.2F.1
    const row = db.get('SELECT * FROM popup_locations WHERE id=? AND store_id=?', [id, storeId]);
    res.status(201).json({ success: true, data: serializeLocation(row) });
  } catch (e) { sendError(res, e); }
});

router.patch('/locations/:locationId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedLocation(db, storeId, req.params.locationId);
    const body = req.body || {};

    let nextActive = existing.active;
    if (body.active !== undefined) {
      nextActive = pp.normalizeStrictBoolTo01(body.active);
      if (nextActive === null) pp.fail('POPUP_VALIDATION_ERROR', 'active 只接受 true/false/1/0（布林或對應字串），其他值一律拒絕');
    }
    const next = {
      name: body.name !== undefined ? body.name : existing.name,
      address: body.address !== undefined ? body.address : existing.address,
      address_note: body.address_note !== undefined ? body.address_note : existing.address_note,
      place_id: body.place_id !== undefined ? body.place_id : existing.place_id,
      lat: body.lat !== undefined ? body.lat : existing.lat,
      lng: body.lng !== undefined ? body.lng : existing.lng,
      active: nextActive,
    };
    if (!pp.isNonEmptyString(next.name, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');
    if (!pp.isNonEmptyString(next.address, 500)) pp.fail('POPUP_VALIDATION_ERROR', 'address 必填，且長度需在 1~500 字之間');
    if (!pp.isOptionalString(next.address_note, 500)) pp.fail('POPUP_VALIDATION_ERROR', 'address_note 長度超出限制');
    if (!pp.isOptionalString(next.place_id, 300)) pp.fail('POPUP_VALIDATION_ERROR', 'place_id 長度超出限制');
    const { lat, lng } = validateLatLng(next.lat, next.lng);
    const region = resolveLocationRegionInput(body, next.address, existing);

    // 修改地點庫不得回寫任何既有 session——這裡只更新 popup_locations 本身，
    // 已建立的 popup_sessions 全部使用自己建立當下複製的 snapshot 欄位，
    // 完全不會因為這個 UPDATE 而被靜默改動（見規格 5.2／十四.3）。
    db.runDurableTransaction(() => { db._db.run(
      `UPDATE popup_locations SET name=?, address=?, address_note=?, place_id=?, lat=?, lng=?, active=?, city=?, district=?, postal_code=?, updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [next.name.trim(), next.address.trim(), next.address_note || '', next.place_id || '', lat, lng, next.active, region.city, region.district, region.postal_code, existing.id, storeId]
    ); }); // R44.2F.1
    const row = db.get('SELECT * FROM popup_locations WHERE id=? AND store_id=?', [existing.id, storeId]);
    res.json({ success: true, data: serializeLocation(row) });
  } catch (e) { sendError(res, e); }
});

router.delete('/locations/:locationId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedLocation(db, storeId, req.params.locationId);
    // 軟停用，不硬刪——地點庫可能被歷史場次的 snapshot 間接引用（location_id
    // 欄位僅作為建立當下的參考來源，場次資料本身已複製，但保留地點庫紀錄
    // 供後台追溯用途）。
    db.runDurableTransaction(() => { db._db.run("UPDATE popup_locations SET active=0, updated_at=datetime('now','localtime') WHERE id=? AND store_id=?", [existing.id, storeId]); }); // R44.2F.1
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
// Session API
// ══════════════════════════════════════════════════════════════════════
router.get('/sessions', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    let sql = 'SELECT * FROM popup_sessions WHERE store_id=?';
    const params = [storeId];
    if (req.query.campaign_id) {
      sql += ' AND campaign_id=?';
      params.push(req.query.campaign_id);
    }
    if (req.query.status) {
      if (!pp.SESSION_STORED_STATUSES.includes(req.query.status)) {
        pp.fail('POPUP_VALIDATION_ERROR', `status 篩選值不合法，必須是 ${pp.SESSION_STORED_STATUSES.join('/')} 其中之一`);
      }
      sql += ' AND status=?';
      params.push(req.query.status);
    }
    if (req.query.date_from) {
      if (!pp.isValidDateString(req.query.date_from)) pp.fail('POPUP_VALIDATION_ERROR', 'date_from 格式錯誤，需為 YYYY-MM-DD');
      sql += ' AND pickup_date >= ?';
      params.push(req.query.date_from);
    }
    if (req.query.date_to) {
      if (!pp.isValidDateString(req.query.date_to)) pp.fail('POPUP_VALIDATION_ERROR', 'date_to 格式錯誤，需為 YYYY-MM-DD');
      sql += ' AND pickup_date <= ?';
      params.push(req.query.date_to);
    }
    sql += ' ORDER BY pickup_date ASC, sort_order ASC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.all(sql, params);
    const now = Date.now();
    // 一次查出所有牽涉到的 campaign 狀態，避免每列都各自查一次 DB（仍逐一
    // 帶 store_id，不得只靠 campaign_id 本身「幾乎不會跨店碰撞」）。
    const campaignIds = [...new Set(rows.map((r) => r.campaign_id))];
    const campaignStatusMap = {};
    campaignIds.forEach((cid) => {
      campaignStatusMap[cid] = getCampaignStatusScoped(db, storeId, cid);
    });

    const data = rows.map((row) => serializeSession(db, row, campaignStatusMap[row.campaign_id], now, storeId));
    res.json({ success: true, data, page, limit });
  } catch (e) { sendError(res, e); }
});

router.post('/sessions/batch', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};

    if (!pp.isNonEmptyString(body.campaign_id, 100)) pp.fail('POPUP_VALIDATION_ERROR', 'campaign_id 必填');
    const campaign = getOwnedCampaign(db, storeId, body.campaign_id);

    if (!Array.isArray(body.sessions) || body.sessions.length < 1 || body.sessions.length > 100) {
      pp.fail('POPUP_VALIDATION_ERROR', 'sessions 陣列長度必須介於 1~100 之間');
    }

    // 每筆先在交易外完整驗證＋正規化（不含 DB 寫入），確保驗證錯誤訊息能
    // 精確指出是第幾筆；驗證全部通過才進入 transaction 實際寫入。
    const prepared = body.sessions.map((item, idx) => {
      try {
        return prepareSessionInsert(db, storeId, campaign.id, item || {});
      } catch (e) {
        if (e instanceof pp.PopupValidationError) {
          throw new pp.PopupValidationError(e.code, `第 ${idx + 1} 筆：${e.message}`, e.status, e.extra);
        }
        throw e;
      }
    });

    const results = [];
    // R44.2F.1：batch create 整批同一個 durable transaction（disk 失敗 → 整批 memory／disk 皆無變化，503）
    db.runDurableTransaction(() => {
      prepared.forEach((p) => {
        const code = generateUniquePublicCode(db, 'popup_sessions');
        insertSessionRow(db, p, code);
        results.push({ id: p.id, public_code: code, revision: 1 });
      });
    });

    const now = Date.now();
    const data = results.map((r) => {
      const row = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [r.id, storeId]);
      return serializeSession(db, row, campaign.status, now, storeId);
    });
    res.status(201).json({ success: true, data });
  } catch (e) { sendError(res, e); }
});

// 準備單筆場次的驗證與正規化資料（不寫入 DB）；供 POST /sessions 與
// POST /sessions/batch 共用同一份規則，避免兩處各自驗證漂移。
function prepareSessionInsert(db, storeId, campaignId, body) {
  if (!pp.isNonEmptyString(body.name, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');
  if (!pp.isNonEmptyString(body.location_id, 100)) pp.fail('POPUP_VALIDATION_ERROR', 'location_id 必填');

  const location = db.get('SELECT * FROM popup_locations WHERE id=? AND store_id=?', [body.location_id, storeId]);
  if (!location) pp.fail('POPUP_VALIDATION_ERROR', 'location_id 不存在或不屬於此店家');
  if (!location.active) pp.fail('POPUP_VALIDATION_ERROR', '不可使用已停用的地點建立新場次');

  const times = pp.normalizeAndValidateSessionTimes({
    pickup_date: body.pickup_date,
    pickup_start_time: body.pickup_start_time,
    pickup_end_time: body.pickup_end_time,
    order_open_at: body.order_open_at,
    order_cutoff_at: body.order_cutoff_at,
  });

  const maxOrders = body.max_orders === undefined ? 0 : body.max_orders;
  if (!pp.isNonNegativeInt(maxOrders)) pp.fail('POPUP_VALIDATION_ERROR', 'max_orders 必須是大於等於 0 的整數');

  const productScope = body.product_scope;
  if (!pp.PRODUCT_SCOPES.includes(productScope)) {
    pp.fail('POPUP_VALIDATION_ERROR', `product_scope 必須是 ${pp.PRODUCT_SCOPES.join('/')} 其中之一`);
  }
  let products = [];
  if (productScope === 'selected') {
    products = validateSelectedProducts(db, storeId, body.products);
  }

  const status = body.status === undefined ? 'draft' : body.status;
  if (!pp.SESSION_STORED_STATUSES.includes(status) || status === 'ended') {
    pp.fail('POPUP_VALIDATION_ERROR', `status 必須是 ${pp.SESSION_STORED_STATUSES.join('/')} 其中之一`);
  }
  const sortOrder = body.sort_order === undefined ? 0 : body.sort_order;
  if (!pp.isNonNegativeInt(sortOrder)) pp.fail('POPUP_VALIDATION_ERROR', 'sort_order 必須是大於等於 0 的整數');

  return {
    id: uuidv4(),
    store_id: storeId,
    campaign_id: campaignId,
    name: body.name.trim(),
    ...times,
    location_id: location.id,
    // 地點名稱、地址、說明、Place ID、lat/lng 一律從後端 location 資料複製，
    // 不信任前端送來的 snapshot 欄位（規格三）。
    place_name: location.name,
    place_id: location.place_id,
    address: location.address,
    address_note: location.address_note,
    lat: location.lat,
    lng: location.lng,
    city: location.city || '',
    district: location.district || '',
    postal_code: location.postal_code || '',
    status,
    product_scope: productScope,
    max_orders: maxOrders,
    sort_order: sortOrder,
    products,
  };
}

function insertSessionRow(db, p, publicCode) {
  db._db.run(
    `INSERT INTO popup_sessions (
      id, store_id, campaign_id, public_code, name,
      pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at,
      location_id, place_name, place_id, address, address_note, lat, lng,
      status, product_scope, max_orders, sort_order, revision, city, district, postal_code
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    [
      p.id, p.store_id, p.campaign_id, publicCode, p.name,
      p.pickup_date, p.pickup_start_time, p.pickup_end_time, p.order_open_at, p.order_cutoff_at,
      p.location_id, p.place_name, p.place_id, p.address, p.address_note, p.lat, p.lng,
      p.status, p.product_scope, p.max_orders, p.sort_order, p.city || '', p.district || '', p.postal_code || '',
    ]
  );
  if (p.product_scope === 'selected') {
    p.products.forEach((prod) => {
      db._db.run(
        'INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES (?,?,?,?,?)',
        [p.store_id, p.id, prod.product_id, prod.enabled, prod.quota_qty]
      );
    });
  }
}

router.post('/sessions', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = req.body || {};

    if (!pp.isNonEmptyString(body.campaign_id, 100)) pp.fail('POPUP_VALIDATION_ERROR', 'campaign_id 必填');
    const campaign = getOwnedCampaign(db, storeId, body.campaign_id);

    const prepared = prepareSessionInsert(db, storeId, campaign.id, body);
    const publicCode = generateUniquePublicCode(db, 'popup_sessions');

    db.runDurableTransaction(() => { insertSessionRow(db, prepared, publicCode); }); // R44.2F.1

    const row = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [prepared.id, storeId]);
    res.status(201).json({ success: true, data: serializeSession(db, row, campaign.status, Date.now(), storeId) });
  } catch (e) { sendError(res, e); }
});

router.get('/sessions/:sessionId/change-logs', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const session = getOwnedSession(db, storeId, req.params.sessionId);
    const limit = clampLimit(req.query.limit, 50, 200);
    const rows = db.all(
      'SELECT * FROM popup_session_change_logs WHERE session_id=? AND store_id=? ORDER BY created_at DESC, id DESC LIMIT ?',
      [session.id, storeId, limit]
    );
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        revision_before: r.revision_before,
        revision_after: r.revision_after,
        before: JSON.parse(r.before_json || '{}'),
        after: JSON.parse(r.after_json || '{}'),
        change_reason: r.change_reason,
        affected_order_count: r.affected_order_count,
        created_at: r.created_at,
      })),
    });
  } catch (e) { sendError(res, e); }
});

router.get('/sessions/:sessionId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const session = getOwnedSession(db, storeId, req.params.sessionId);
    const campaignStatus = getCampaignStatusScoped(db, storeId, session.campaign_id);
    res.json({ success: true, data: serializeSession(db, session, campaignStatus, Date.now(), storeId) });
  } catch (e) { sendError(res, e); }
});

// Phase 2.1 修正：明確接收 storeId，child query 加上 AND store_id=?。
function allowlistedSessionSnapshot(db, row, storeId) {
  const products = row.product_scope === 'selected'
    ? db.all('SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=? ORDER BY product_id', [row.id, storeId])
      .map((p) => ({ product_id: p.product_id, enabled: !!p.enabled, quota_qty: p.quota_qty }))
    : [];
  return {
    name: row.name,
    pickup_date: row.pickup_date,
    pickup_start_time: row.pickup_start_time,
    pickup_end_time: row.pickup_end_time,
    order_open_at: row.order_open_at,
    order_cutoff_at: row.order_cutoff_at,
    location_id: row.location_id,
    place_name: row.place_name,
    place_id: row.place_id,
    address: row.address,
    address_note: row.address_note,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    product_scope: row.product_scope,
    max_orders: row.max_orders,
    products,
  };
}

function countAffectedOrders(db, storeId, sessionId) {
  const row = db.get(
    `SELECT COUNT(*) as c FROM orders
     WHERE store_id=? AND popup_session_id=?
       AND order_status NOT IN ('cancelled','voided')
       AND (voided_at IS NULL OR voided_at='')`,
    [storeId, sessionId]
  );
  return row ? row.c : 0;
}

router.patch('/sessions/:sessionId', (req, res) => {
  // Protected fields（影響已下單顧客的欄位，變更需經過 revision +（有訂單時）
  // 二次確認流程）：name / pickup_date / pickup_start_time / pickup_end_time /
  // order_open_at / order_cutoff_at / location_id（含地點 snapshot）/ status /
  // product_scope / products / max_orders。sort_order 不在此列，可自由調整、
  // 不觸發確認流程。這份清單僅供閱讀程式碼時參考——實際「是否算作變化」的
  // 權威判斷一律由 transaction 內 freshExisting 與 afterSnapshotCandidate 的
  // 逐欄位比對決定（見下方 protectedChanged／changedFields），不依賴這裡的
  // 欄位名稱列表本身做任何分流決策。
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedSession(db, storeId, req.params.sessionId);
    const body = req.body || {};

    // session archived 是終止狀態，不得被一般 PATCH 恢復或修改任何欄位
    // （對稱於 campaign 的 POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE 規則）。這裡先
    // 用「進入交易前」的值快速擋掉多數請求；交易內還會用 freshExisting 再
    // 檢查一次，防止「檢查當下還沒 archived，但交易開始前被其他請求
    // archived」的race。
    if (existing.status === 'archived') {
      pp.fail('POPUP_SESSION_ARCHIVED_IMMUTABLE', '此場次已封存（archived），為終止狀態，不可再修改', 409);
    }

    if (!pp.isPositiveInt(body.expected_revision)) {
      pp.fail('POPUP_VALIDATION_ERROR', 'expected_revision 必填，且必須是大於 0 的安全整數');
    }
    if (body.expected_revision !== existing.revision) {
      pp.fail('POPUP_SESSION_REVISION_CONFLICT', '場次資料已被其他操作更新，請重新整理後再試', 409, { current_revision: existing.revision });
    }

    // ── 組出合併後的目標值，並驗證格式（純格式驗證，不涉及「是否需要確認」
    //    這種必須用最新資料才能決定的權威判斷——那些一律移到 transaction
    //    內、用 fresh 讀取的資料做決策，見下方）。────────────────────────
    // R54.3：變更所屬活動。只接受同店、存在、非封存的活動 ID；不信任前端的活動名稱
    // （body 只讀 campaign_id）。不存在／已刪除／他店 → 400；封存 → 409；任何失敗都不寫入。
    let targetCampaign = null;
    if (body.campaign_id !== undefined) {
      if (!pp.isNonEmptyString(body.campaign_id, 100)) pp.fail('POPUP_VALIDATION_ERROR', 'campaign_id 必須是 1~100 字的活動 ID');
      if (body.campaign_id !== existing.campaign_id) {
        targetCampaign = db.get('SELECT * FROM popup_campaigns WHERE id=? AND store_id=?', [body.campaign_id, storeId]);
        if (!targetCampaign) pp.fail('POPUP_VALIDATION_ERROR', 'campaign_id 不存在或不屬於此店家');
        if (targetCampaign.status === 'archived') pp.fail('POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE', '目標活動已封存，無法移入場次', 409);
        if (getCampaignStatusScoped(db, storeId, existing.campaign_id) === 'archived') {
          pp.fail('POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE', '原活動已封存，場次不可移出', 409);
        }
      }
    }
    const wantsCampaignChange = !!targetCampaign;
    // R54.3：所屬活動不影響既有訂單的取餐地點／時間／商品（訂單保留活動名稱 snapshot），
    // 因此與 sort_order 同類：不觸發「已有訂單需二次確認」、不寫入顧客影響 change log
    // （change log snapshot 欄位維持 R54.2 allowlist 不變）；但同樣走 revision 與同一個 durable transaction。
    const nextCampaignId = wantsCampaignChange ? targetCampaign.id : existing.campaign_id;

    const wantsLocationChange = body.location_id !== undefined && body.location_id !== existing.location_id;
    let targetLocation = null;
    if (wantsLocationChange) {
      targetLocation = db.get('SELECT * FROM popup_locations WHERE id=? AND store_id=?', [body.location_id, storeId]);
      if (!targetLocation) pp.fail('POPUP_VALIDATION_ERROR', 'location_id 不存在或不屬於此店家');
      if (!targetLocation.active) pp.fail('POPUP_VALIDATION_ERROR', '不可切換到已停用的地點');
    }

    const nextTimesInput = {
      pickup_date: body.pickup_date !== undefined ? body.pickup_date : existing.pickup_date,
      pickup_start_time: body.pickup_start_time !== undefined ? body.pickup_start_time : existing.pickup_start_time,
      pickup_end_time: body.pickup_end_time !== undefined ? body.pickup_end_time : existing.pickup_end_time,
      order_open_at: body.order_open_at !== undefined ? body.order_open_at : existing.order_open_at,
      order_cutoff_at: body.order_cutoff_at !== undefined ? body.order_cutoff_at : existing.order_cutoff_at,
    };
    const timesChanged = ['pickup_date', 'pickup_start_time', 'pickup_end_time', 'order_open_at', 'order_cutoff_at']
      .some((k) => body[k] !== undefined);
    const normalizedTimes = timesChanged ? pp.normalizeAndValidateSessionTimes(nextTimesInput) : {
      pickup_date: existing.pickup_date,
      pickup_start_time: existing.pickup_start_time,
      pickup_end_time: existing.pickup_end_time,
      order_open_at: existing.order_open_at,
      order_cutoff_at: existing.order_cutoff_at,
    };

    const nextName = body.name !== undefined ? body.name : existing.name;
    if (!pp.isNonEmptyString(nextName, 200)) pp.fail('POPUP_VALIDATION_ERROR', 'name 必填，且長度需在 1~200 字之間');

    const nextStatus = body.status !== undefined ? body.status : existing.status;
    if (!pp.SESSION_STORED_STATUSES.includes(nextStatus) || nextStatus === 'ended') {
      pp.fail('POPUP_VALIDATION_ERROR', `status 必須是 ${pp.SESSION_STORED_STATUSES.join('/')} 其中之一`);
    }

    const nextMaxOrders = body.max_orders !== undefined ? body.max_orders : existing.max_orders;
    if (!pp.isNonNegativeInt(nextMaxOrders)) pp.fail('POPUP_VALIDATION_ERROR', 'max_orders 必須是大於等於 0 的安全整數');

    const nextProductScope = body.product_scope !== undefined ? body.product_scope : existing.product_scope;
    if (!pp.PRODUCT_SCOPES.includes(nextProductScope)) {
      pp.fail('POPUP_VALIDATION_ERROR', `product_scope 必須是 ${pp.PRODUCT_SCOPES.join('/')} 其中之一`);
    }
    const productsProvided = body.products !== undefined;
    let nextProducts = null;
    if (nextProductScope === 'selected' && (productsProvided || existing.product_scope !== 'selected')) {
      const source = productsProvided ? body.products : db.all(
        'SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId]
      );
      nextProducts = validateSelectedProducts(db, storeId, source);
    } else if (nextProductScope === 'selected' && !productsProvided) {
      nextProducts = db.all('SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId])
        .map((p) => ({ product_id: p.product_id, enabled: p.enabled, quota_qty: p.quota_qty }));
    }

    const nextSortOrder = body.sort_order !== undefined ? body.sort_order : existing.sort_order;
    if (!pp.isNonNegativeInt(nextSortOrder)) pp.fail('POPUP_VALIDATION_ERROR', 'sort_order 必須是大於等於 0 的安全整數');

    // ── 組出 PATCH 之後「打算」寫入的目標快照（afterSnapshotCandidate）。
    //    這裡只做格式驗證與合併新舊值，不做任何「是否算作變化」的判斷——
    //    is-changed／需不需要確認流程，一律在 transaction 內用 freshExisting
    //    重新比對才算數（見下）。刻意不在交易外預先計算一份近似的
    //    before/after 快照或近似的 changed-fields 清單，避免任何人誤以為
    //    交易外的值可以拿來做決策。
    const afterSnapshotCandidate = {
      name: nextName.trim(),
      ...normalizedTimes,
      location_id: wantsLocationChange ? targetLocation.id : existing.location_id,
      place_name: wantsLocationChange ? targetLocation.name : existing.place_name,
      place_id: wantsLocationChange ? targetLocation.place_id : existing.place_id,
      address: wantsLocationChange ? targetLocation.address : existing.address,
      address_note: wantsLocationChange ? targetLocation.address_note : existing.address_note,
      lat: wantsLocationChange ? targetLocation.lat : existing.lat,
      lng: wantsLocationChange ? targetLocation.lng : existing.lng,
      status: nextStatus,
      product_scope: nextProductScope,
      max_orders: nextMaxOrders,
      products: nextProductScope === 'selected' ? nextProducts : [],
    };

    // ════════════════════════════════════════════════════════════════
    // Phase 2.1 修正核心：一律進入同一個 transaction，並在裡面用 fresh 讀取
    // 做完整權威判斷（revision、session 是否還存在、是否已被 archived、是否
    // 真的有 protected 變化、真正受影響的訂單數）。任何一步失敗都
    // ROLLBACK；COMMIT＋atomic file write 成功才算完成（db.runDurableTransaction）。
    // ════════════════════════════════════════════════════════════════
    let responseAffectedCount = 0;
    db.runDurableTransaction(() => { // R44.2F.1：PATCH（revision／affected-orders 確認／change log）同一個 durable transaction
      const freshExisting = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [existing.id, storeId]);
      if (!freshExisting) {
        throw new pp.PopupValidationError('POPUP_RESOURCE_NOT_FOUND', '找不到指定的快閃場次', 404);
      }
      if (freshExisting.revision !== existing.revision) {
        throw new pp.PopupValidationError('POPUP_SESSION_REVISION_CONFLICT', '場次資料已被其他操作更新，請重新整理後再試', 409, {
          current_revision: freshExisting.revision,
        });
      }
      if (freshExisting.status === 'archived') {
        throw new pp.PopupValidationError('POPUP_SESSION_ARCHIVED_IMMUTABLE', '此場次已封存（archived），為終止狀態，不可再修改', 409);
      }
      if (wantsCampaignChange) {
        // R54.3：交易內以 fresh 讀取再驗一次目標活動（同店、存在、非封存），失敗整筆 ROLLBACK。
        const freshTarget = db.get('SELECT id, status FROM popup_campaigns WHERE id=? AND store_id=?', [targetCampaign.id, storeId]);
        if (!freshTarget) throw new pp.PopupValidationError('POPUP_VALIDATION_ERROR', 'campaign_id 不存在或不屬於此店家', 400);
        if (freshTarget.status === 'archived') throw new pp.PopupValidationError('POPUP_CAMPAIGN_ARCHIVED_IMMUTABLE', '目標活動已封存，無法移入場次', 409);
      }

      // 用 freshExisting 算出這次交易內唯一權威的 before 快照
      // （freshBeforeSnapshot），並據此算出 protectedChanged／changedFields。
      // 交易外完全沒有算過這兩個值，所以這裡不是「重算一次」，而是「唯一
      // 一次」計算——比對基準永遠是交易內當下讀到的資料。
      const freshBeforeSnapshot = allowlistedSessionSnapshot(db, freshExisting, storeId);
      const protectedChanged = JSON.stringify(freshBeforeSnapshot) !== JSON.stringify(afterSnapshotCandidate);
      const changedFields = Object.keys(afterSnapshotCandidate).filter(
        (k) => JSON.stringify(freshBeforeSnapshot[k]) !== JSON.stringify(afterSnapshotCandidate[k])
      );

      if (!protectedChanged) {
        // 只有 sort_order（或完全沒有實質變化）——直接寫入，revision 仍前進
        // 一版，不需要確認流程、不寫 change log、affected_order_count 不適用。
        db._db.run(
          `UPDATE popup_sessions SET campaign_id=?, sort_order=?, revision=revision+1, updated_at=datetime('now','localtime')
           WHERE id=? AND store_id=? AND revision=?`,
          [nextCampaignId, nextSortOrder, existing.id, storeId, freshExisting.revision]
        );
        if (db._db.getRowsModified() !== 1) {
          throw new pp.PopupValidationError('POPUP_SESSION_REVISION_CONFLICT', '場次資料已被其他操作更新，請重新整理後再試', 409, {});
        }
      } else {
        // protected fields 真的有變化——用「交易內剛剛量到的」freshAffectedCount
        // 做出唯一權威決策，交易外任何先前算出的 affectedOrderCount 一律不採用。
        const freshAffectedCount = countAffectedOrders(db, storeId, existing.id);
        responseAffectedCount = freshAffectedCount;

        if (freshAffectedCount > 0 && body.confirm_affected_orders !== true) {
          throw new pp.PopupValidationError('POPUP_SESSION_CHANGE_CONFIRM_REQUIRED', '此場次已有訂單，修改重要欄位需要二次確認', 409, {
            affected_order_count: freshAffectedCount,
            changed_fields: changedFields,
            current_revision: freshExisting.revision,
          });
        }
        if (freshAffectedCount > 0 && !pp.isNonEmptyString(body.change_reason, 500)) {
          throw new pp.PopupValidationError('POPUP_VALIDATION_ERROR', '確認修改時 change_reason 為必填，且長度需在 1~500 字之間', 400);
        }

        db._db.run(
          `UPDATE popup_sessions SET
             campaign_id=?, name=?, pickup_date=?, pickup_start_time=?, pickup_end_time=?, order_open_at=?, order_cutoff_at=?,
             location_id=?, place_name=?, place_id=?, address=?, address_note=?, lat=?, lng=?,
             status=?, product_scope=?, max_orders=?, sort_order=?,
             revision=revision+1, updated_at=datetime('now','localtime')
           WHERE id=? AND store_id=? AND revision=?`,
          [
            nextCampaignId,
            afterSnapshotCandidate.name, afterSnapshotCandidate.pickup_date, afterSnapshotCandidate.pickup_start_time,
            afterSnapshotCandidate.pickup_end_time, afterSnapshotCandidate.order_open_at, afterSnapshotCandidate.order_cutoff_at,
            afterSnapshotCandidate.location_id, afterSnapshotCandidate.place_name, afterSnapshotCandidate.place_id,
            afterSnapshotCandidate.address, afterSnapshotCandidate.address_note, afterSnapshotCandidate.lat, afterSnapshotCandidate.lng,
            afterSnapshotCandidate.status, afterSnapshotCandidate.product_scope, afterSnapshotCandidate.max_orders, nextSortOrder,
            existing.id, storeId, freshExisting.revision,
          ]
        );
        if (db._db.getRowsModified() !== 1) {
          throw new pp.PopupValidationError('POPUP_SESSION_REVISION_CONFLICT', '場次資料已被其他操作更新，請重新整理後再試', 409, {});
        }
        if (wantsLocationChange) {
          // R51：換地點時，地區 snapshot 與地址等 snapshot 一起從新地點複製（同一交易）。
          db._db.run('UPDATE popup_sessions SET city=?, district=?, postal_code=? WHERE id=? AND store_id=?',
            [targetLocation.city || '', targetLocation.district || '', targetLocation.postal_code || '', existing.id, storeId]);
        }

        // R54.3：商品清單（product_id／enabled／quota_qty）與 DB 完全相同時不重寫子資料
        // （例如只變更所屬活動），避免無謂的刪除後重建；有差異時行為與 R54.2 相同。
        const r543Key = (list) => JSON.stringify((list || []).map((p) => [Number(p.product_id), Number(p.enabled) ? 1 : 0, Number(p.quota_qty) || 0]).sort((a, b) => a[0] - b[0]));
        const r543ProductsUnchanged = nextProductScope === 'selected' && freshExisting.product_scope === 'selected'
          && r543Key(db.all('SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId])) === r543Key(nextProducts);
        if (r543ProductsUnchanged) {
          // 保持原樣
        } else if (nextProductScope === 'selected') {
          // R53：記下重寫前的 quota，供販售設定同步（新上限不得低於已保留＋已成立）。
          const r53BeforeProducts = db.all('SELECT product_id, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId]);
          db._db.run('DELETE FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId]);
          nextProducts.forEach((prod) => {
            db._db.run(
              'INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES (?,?,?,?,?)',
              [storeId, existing.id, prod.product_id, prod.enabled, prod.quota_qty]
            );
          });
          require('../utils/popupSales').syncQuotaFromSessionFormInTransaction(db, storeId, existing.id, r53BeforeProducts, nextProducts);
        } else {
          // all_takeout：不得留下舊的白名單資料。
          db._db.run('DELETE FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId]);
        }

        if (freshAffectedCount > 0) {
          // change log 內容完全由伺服器讀取的 allowlist snapshot 產生
          // （freshBeforeSnapshot / afterSnapshotCandidate），絕不使用 client
          // 傳入的 before_json/after_json/其他欄位。
          db._db.run(
            `INSERT INTO popup_session_change_logs
               (store_id, session_id, revision_before, revision_after, before_json, after_json, change_reason, affected_order_count)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              storeId, existing.id, freshExisting.revision, freshExisting.revision + 1,
              JSON.stringify(freshBeforeSnapshot), JSON.stringify(afterSnapshotCandidate),
              body.change_reason.trim(), freshAffectedCount,
            ]
          );
        }
      }
    });

    const row = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [existing.id, storeId]);
    const campaignStatus = getCampaignStatusScoped(db, storeId, row.campaign_id);
    res.json({
      success: true,
      data: serializeSession(db, row, campaignStatus, Date.now(), storeId),
      affected_order_count: responseAffectedCount,
    });
  } catch (e) { sendError(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
// R53：📦 商品販售管理（以快閃場次為單位；資料獨立於一般 LINE 今日販售管理）
// ══════════════════════════════════════════════════════════════════════
const psales = require('../utils/popupSales');
function salesSessionView(db, storeId, row, now) {
  const campaignStatus = getCampaignStatusScoped(db, storeId, row.campaign_id);
  const allowed = psales.batchTargetAllowed(row, campaignStatus, false, now);
  return {
    id: row.id, name: row.name, campaign_id: row.campaign_id, status: row.status, product_scope: row.product_scope,
    pickup_date: row.pickup_date, pickup_start_time: row.pickup_start_time, pickup_end_time: row.pickup_end_time,
    effective_state: psales.sessionTimingState(row, campaignStatus, now), not_started: allowed.ok,
  };
}

router.get('/sessions/:sessionId/sales', (req, res) => {
  try {
    const db = getDb();
    psales.ensurePopupSalesSchema(db);
    const storeId = req.storeId;
    const row = getOwnedSession(db, storeId, req.params.sessionId);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { session: salesSessionView(db, storeId, row, Date.now()), items: psales.listSessionSales(db, storeId, row) } });
  } catch (e) { sendError(res, e); }
});

function parseSalesItems(body) {
  const items = body && body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) pp.fail('POPUP_VALIDATION_ERROR', 'items 必須是 1~500 筆的陣列');
  const seen = new Set();
  return items.map((it, idx) => {
    if (!it || !pp.isPositiveInt(it.product_id)) pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].product_id 必須是正整數`);
    if (seen.has(it.product_id)) pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].product_id 重複`);
    seen.add(it.product_id);
    return { product_id: it.product_id, patch: psales.normalizeSalesPatch(it, idx) };
  });
}

router.put('/sessions/:sessionId/sales', (req, res) => {
  try {
    const db = getDb();
    psales.ensurePopupSalesSchema(db);
    const storeId = req.storeId;
    const row = getOwnedSession(db, storeId, req.params.sessionId);
    const updates = parseSalesItems(req.body || {});
    let result;
    db.runDurableTransaction(() => {
      const fresh = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [row.id, storeId]);
      result = psales.applySalesUpdatesInTransaction(db, storeId, fresh, updates, true);
    });
    res.json({ success: true, data: { updated: result.updated, session: salesSessionView(db, storeId, row, Date.now()), items: psales.listSessionSales(db, storeId, row) } });
  } catch (e) { sendError(res, e); }
});

// R54：📦 批次操作（啟用／停用／設定總數量／設定每筆限購）＝一次 bulk request、一個交易。
// 後端重新驗證：登入與權限（router 層 requireStaffJwt＋line_order）、同店（getOwnedSession）、
// 同場次（只寫 URL 指定場次）、ID 去重、每個 ID 確實在此場次、action 與值合法；任一失敗整批 rollback。
router.post('/sessions/:sessionId/sales/batch', (req, res) => {
  try {
    const db = getDb();
    psales.ensurePopupSalesSchema(db);
    const storeId = req.storeId;
    const row = getOwnedSession(db, storeId, req.params.sessionId);
    const input = psales.normalizeSalesBatchInput(req.body);
    let result;
    db.runDurableTransaction(() => {
      const fresh = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [row.id, storeId]);
      if (!fresh) pp.fail('POPUP_RESOURCE_NOT_FOUND', '找不到指定的快閃場次', 404);
      result = psales.applySalesBatchInTransaction(db, storeId, fresh, input);
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { ...result, session: salesSessionView(db, storeId, row, Date.now()), items: psales.listSessionSales(db, storeId, row) } });
  } catch (e) { sendError(res, e); }
});

// 將來源場次的指定商品設定套用到其他場次。預設只允許「尚未開放下單」的場次；
// include_open=true 時另允許下單中場次；已截止／取貨中／已結束／已取消／封存一律拒絕。
// dry_run=true 只回傳預覽（目標場次、可套用商品數、拒絕原因），不寫入；正式套用需 confirm=true。
const SALES_APPLY_FIELDS = ['sale_enabled', 'stock_mode', 'stock_total', 'per_order_limit', 'manual_sold_out'];
router.post('/sales/apply', (req, res) => {
  try {
    const db = getDb();
    psales.ensurePopupSalesSchema(db);
    const storeId = req.storeId;
    const body = req.body || {};
    const source = getOwnedSession(db, storeId, String(body.source_session_id || ''));
    const fields = Array.isArray(body.fields) ? body.fields : [];
    if (!fields.length || fields.some((f) => !SALES_APPLY_FIELDS.includes(f))) pp.fail('POPUP_VALIDATION_ERROR', `fields 只能包含 ${SALES_APPLY_FIELDS.join('/')}`);
    const productIds = Array.isArray(body.product_ids) ? body.product_ids : [];
    if (!productIds.length || productIds.length > 500 || productIds.some((x) => !pp.isPositiveInt(x))) pp.fail('POPUP_VALIDATION_ERROR', 'product_ids 必須是 1~500 個正整數');
    const targetIds = Array.isArray(body.target_session_ids) ? [...new Set(body.target_session_ids)] : [];
    if (!targetIds.length || targetIds.length > 100) pp.fail('POPUP_VALIDATION_ERROR', 'target_session_ids 必須是 1~100 個場次');
    const includeOpen = body.include_open === true;
    const dryRun = body.dry_run === true;
    if (!dryRun && body.confirm !== true) pp.fail('POPUP_CONFIRM_REQUIRED', '批次套用前必須確認（confirm=true）', 400);
    const now = Date.now();
    const srcSales = new Map(psales.listSessionSales(db, storeId, source).map((r) => [r.product_id, r]));
    const updates = productIds.filter((pid) => srcSales.has(pid)).map((pid) => {
      const r = srcSales.get(pid); const patch = {};
      fields.forEach((f) => {
        if (f === 'stock_total') patch.stock_total = r.stock_total || 0;
        else if (f === 'per_order_limit') patch.per_order_limit = r.per_order_limit || 0;
        else patch[f] = r[f];
      });
      if (fields.includes('stock_total') && !fields.includes('stock_mode')) patch.stock_mode = r.stock_mode;
      return { product_id: pid, patch };
    });
    const targets = targetIds.map((tid) => {
      const t = db.get('SELECT * FROM popup_sessions WHERE id=? AND store_id=?', [String(tid), storeId]);
      if (!t || t.id === source.id) return { session_id: String(tid), ok: false, reason: t ? '不可套用到來源場次本身' : '找不到指定場次' };
      const campaignStatus = getCampaignStatusScoped(db, storeId, t.campaign_id);
      const allowed = psales.batchTargetAllowed(t, campaignStatus, includeOpen, now);
      return { session_id: t.id, name: t.name, pickup_date: t.pickup_date, row: t, ok: allowed.ok, reason: allowed.reason || '' };
    });
    const results = [];
    const runAll = () => targets.forEach((t) => {
      if (!t.ok) { results.push({ session_id: t.session_id, name: t.name || '', applied: 0, skipped_session: true, reason: t.reason }); return; }
      const r = psales.applySalesUpdatesInTransaction(db, storeId, t.row, updates, false);
      results.push({ session_id: t.session_id, name: t.name, pickup_date: t.pickup_date, applied: r.updated, rejected: r.rejected });
    });
    if (dryRun) {
      // 預覽：在交易內試算後一律 rollback，不留下任何寫入。
      try { db._db.run('BEGIN'); runAll(); } finally { db._db.run('ROLLBACK'); }
    } else {
      db.runDurableTransaction(runAll);
    }
    res.json({ success: true, data: { dry_run: dryRun, product_count: updates.length, source_session_id: source.id, targets: results } });
  } catch (e) { sendError(res, e); }
});

router.delete('/sessions/:sessionId', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const existing = getOwnedSession(db, storeId, req.params.sessionId);

    const orderCount = db.get('SELECT COUNT(*) as c FROM orders WHERE store_id=? AND popup_session_id=?', [storeId, existing.id]).c;
    const allocCount = db.get('SELECT COUNT(*) as c FROM popup_order_allocations WHERE store_id=? AND session_id=?', [storeId, existing.id]).c;
    if (orderCount > 0 || allocCount > 0) {
      pp.fail('POPUP_SESSION_HAS_DEPENDENCIES', '此場次已有訂單或份數配額紀錄，不得刪除，請改用取消（status=cancelled）', 409, {
        order_count: orderCount,
        allocation_count: allocCount,
      });
    }

    db.runDurableTransaction(() => { // R44.2F.1
      db._db.run('DELETE FROM popup_session_products WHERE session_id=? AND store_id=?', [existing.id, storeId]);
      db._db.run('DELETE FROM popup_sessions WHERE id=? AND store_id=?', [existing.id, storeId]);
    });
    res.json({ success: true });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
