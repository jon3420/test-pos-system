// utils/popupCheckout.js — H1.4.12 Phase 3
//
// 快閃取餐「公開查詢序列化 + 結帳後端權威驗證 + allocation 原子扣減／冪等
// 釋放」的單一事實來源。不得信任前端傳入的活動/場次名稱、地址、時間、
// 剩餘份數、場次狀態——一律以 store_id + popup_session_public_code 重新從
// DB 撈出場次並驗證。
'use strict';

const pp = require('./popupPickup');
const { resolveLineProductPricing } = require('./lineProductPricing');
const { resolveLineChannelPaymentCodes } = require('./linePaymentMethods');

// ══════════════════════════════════════════════════════════════════════
// 公開查詢序列化（不得洩漏內部自增 ID、管理欄位、Secret、完整訂單清單、
// 會員個資、內部變更紀錄——規格 7.3）
// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
// LINE 名稱／價格 SSOT（規格四）：不可只用 products.price/name——LINE 通路
// 有獨立的 line_name/line_price 覆寫欄位，優先序與既有 routes/products.js
// 的 enrichProduct() 完全一致（同一份規則，這裡是快閃專用的對應版本，
// 避免自己另外發明一套不同的判斷）：
//   - 顯示名稱：line_name（非空白）優先，否則用 name。
//   - 顯示/結帳價格：line_price > 0 優先，否則用 price。
//   - 是否可在 LINE 通路購買：show_on_line=1 AND sale_status='available'
//     AND line_sold_out=0 AND enabled=1 AND line_takeout_enabled=1
//     （快閃場次額外要求 line_takeout_enabled，因為快閃訂單一律走外帶）。
// 公開顯示（serializePublicSessionProducts）與結帳權威驗證
// （validatePopupCheckoutAuthority）共用這一個函式，保證兩處金額/名稱
// 永遠一致，不會出現「頁面顯示一個價錢、結帳又算出另一個價錢」的情況。
// ══════════════════════════════════════════════════════════════════════
// H1.4.12 Phase 3A.2：不再複製一份獨立的判斷邏輯——直接呼叫
// utils/lineProductPricing.js 的 resolveLineProductPricing()，這是
// routes/line-orders.js GET /menu 也在用的同一個函式（該檔案的邏輯本身也
// 已經改成呼叫這個共用函式，不是各自兩份互相複製）。保留
// resolvePopupProductSSOT() 這個名稱只是維持既有呼叫端（下方
// serializePublicSessionProducts／validatePopupCheckoutAuthority）不用
// 改呼叫方式，本體邏輯已經是單一事實來源。
function resolvePopupProductSSOT(p) {
  return resolveLineProductPricing(p);
}

function getActiveAllocatedQty(db, storeId, sessionId, productId) {
  const row = db.get(
    `SELECT COALESCE(SUM(qty),0) as q FROM popup_order_allocations
     WHERE store_id=? AND session_id=? AND product_id=? AND status='active'`,
    [storeId, sessionId, productId]
  );
  return row ? Number(row.q) : 0;
}

function serializeSelectedScopeProducts(db, storeId, session) {
  const rows = db.all(
    `SELECT sp.product_id, sp.quota_qty, p.name, p.price, p.takeaway_price, p.line_name, p.line_price,
            p.enabled, p.show_on_line, p.sale_status, p.line_sold_out, p.line_takeout_enabled
     FROM popup_session_products sp
     JOIN products p ON p.id = sp.product_id AND p.store_id = sp.store_id
     WHERE sp.session_id=? AND sp.store_id=? AND sp.enabled=1
     ORDER BY sp.product_id`,
    [session.id, storeId]
  );
  return rows
    .map((r) => {
      const ssot = resolvePopupProductSSOT(r);
      if (!ssot.is_line_takeout_orderable) return null; // show_on_line=0／sale_status 非 available／line_sold_out 等一律不顯示
      const used = r.quota_qty > 0 ? getActiveAllocatedQty(db, storeId, session.id, r.product_id) : 0;
      const remaining = r.quota_qty > 0 ? Math.max(0, r.quota_qty - used) : null; // null=不限量
      return {
        product_id: r.product_id,
        name: ssot.name,
        price: ssot.price,
        quota_qty: r.quota_qty,
        remaining_qty: remaining,
        sold_out: r.quota_qty > 0 && remaining === 0,
      };
    })
    .filter(Boolean);
}

// Phase 3B 補強：product_scope='all_takeout' 場次先前完全沒有公開商品清單
// （回傳空陣列），前端無法知道有哪些商品可買——這是 Phase 3B 規格書列明的
// 第一個既知整合缺口。修正原則：不得另外發明一套資格判斷，一律沿用
// GET /menu（routes/line-orders.js）既有的「store 全店可售給 LINE 外帶」
// 查詢條件（p.enabled=1 AND p.show_on_line=1），再用同一份
// resolvePopupProductSSOT()（＝resolveLineProductPricing()）過濾
// is_line_takeout_orderable、決定顯示名稱與價格，跟 selected scope 用的是
// 完全同一顆函式，保證兩種 scope 的價格/名稱規則不會分裂成兩份。
// all_takeout 場次沒有 popup_session_products 白名單、也沒有逐商品配額，
// 因此 quota_qty / remaining_qty 一律是 null（不限量；唯一限制是場次層級
// 的 max_orders 總單量，由 serializePublicSession 另外回傳）。
function serializeAllTakeoutScopeProducts(db, storeId) {
  const rows = db.all(
    `SELECT id as product_id, name, price, takeaway_price, line_name, line_price,
            enabled, show_on_line, sale_status, line_sold_out, line_takeout_enabled
     FROM products
     WHERE store_id=? AND enabled=1 AND show_on_line=1
     ORDER BY sort_order ASC, id ASC`,
    [storeId]
  );
  return rows
    .map((r) => {
      const ssot = resolvePopupProductSSOT(r);
      if (!ssot.is_line_takeout_orderable) return null;
      return {
        product_id: r.product_id,
        name: ssot.name,
        price: ssot.price,
        quota_qty: null,
        remaining_qty: null,
        sold_out: false,
      };
    })
    .filter(Boolean);
}

function serializePublicSessionProducts(db, storeId, session) {
  if (session.product_scope === 'selected') return serializeSelectedScopeProducts(db, storeId, session);
  if (session.product_scope === 'all_takeout') return serializeAllTakeoutScopeProducts(db, storeId);
  return [];
}

// H1.4.12 Phase 3B（Popup Recovery Cart Restore／Reconcile，經核准設計）：
// 唯一的 reconcile SSOT——popup checkout 的權威驗證
// （validatePopupCheckoutAuthority）跟 popup recovery 的 prepare-restore
// 都必須用同一份「fresh 商品清單 + 安全整數 + 去重聚合 + 逐項 clamp」規則，
// 不允許各自維護一套。輸入的 rawItems 只信任 product_id/qty 這兩個欄位
// （呼叫端必須自己先從 token cart snapshot 或 request body 裡只取出這兩個
// 欄位，其餘欄位——名稱/價格/quota/狀態——這裡完全不讀取、也不輸出）。
const POPUP_RESTORE_MAX_ITEM_LINES = 50;
function reconcilePopupCartItemsAgainstFreshAuthority(db, storeId, session, rawItems) {
  const aggregated = new Map(); // product_id -> qty
  (Array.isArray(rawItems) ? rawItems : []).forEach((it) => {
    if (!it || typeof it !== 'object') return;
    const productId = Number(it.product_id);
    const qty = Number(it.qty);
    if (!Number.isSafeInteger(productId) || productId <= 0) return;
    if (!Number.isSafeInteger(qty) || qty <= 0) return;
    const prev = aggregated.get(productId) || 0;
    const next = prev + qty;
    if (!Number.isSafeInteger(next)) return; // 聚合溢位一律捨棄這筆，不讓不安全的數字流入下一步
    aggregated.set(productId, next);
  });

  const freshProducts = serializePublicSessionProducts(db, storeId, session);
  const freshByProductId = new Map(freshProducts.map((p) => [p.product_id, p]));

  const items = [];
  const removedItems = [];
  let lineCount = 0;
  for (const [productId, qty] of aggregated) {
    if (lineCount >= POPUP_RESTORE_MAX_ITEM_LINES) {
      removedItems.push({ product_id: productId, reason: 'too_many_items' });
      continue;
    }
    const fresh = freshByProductId.get(productId);
    if (!fresh || fresh.sold_out) {
      removedItems.push({ product_id: productId, reason: 'unavailable' });
      continue;
    }
    let finalQty = qty;
    if (fresh.remaining_qty != null && finalQty > fresh.remaining_qty) {
      if (fresh.remaining_qty <= 0) {
        removedItems.push({ product_id: productId, reason: 'unavailable' });
        continue;
      }
      finalQty = fresh.remaining_qty;
      removedItems.push({ product_id: productId, reason: 'quota_reduced' });
    }
    items.push({ product_id: productId, qty: finalQty });
    lineCount += 1;
  }
  return { items, removedItems };
}

function serializePublicSession(db, storeId, row, campaignStatus, now) {
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
  return {
    public_code: row.public_code,
    name: row.name,
    pickup_date: row.pickup_date,
    pickup_start_time: row.pickup_start_time,
    pickup_end_time: row.pickup_end_time,
    order_open_at: row.order_open_at,
    order_cutoff_at: row.order_cutoff_at,
    place_name: row.place_name,
    address: row.address,
    address_note: row.address_note,
    lat: row.lat,
    lng: row.lng,
    product_scope: row.product_scope,
    products: serializePublicSessionProducts(db, storeId, row),
    // 規格四要求場次畫面顯示「總單量限制」。max_orders 未設定或 <=0 視為
    // 不限量，兩個欄位都回 null（跟 quota_qty=null 的「不限量」語意一致，
    // 不用 0 表示不限量，避免前端把 0 誤判成「已經沒有名額」）。
    // order_count 只在有總量限制時才需要查（沒有限制時查這個數字對前端
    // 沒有意義，也額外增加一次查詢成本）。
    max_orders: pp.isPositiveInt(row.max_orders) && row.max_orders > 0 ? row.max_orders : null,
    order_count: (pp.isPositiveInt(row.max_orders) && row.max_orders > 0)
      ? countActivePopupOrdersForSession(db, storeId, row.id)
      : null,
    // Phase 3B 補強：第二個既知整合缺口——popup public API 先前完全沒有
    // 回傳任何付款方式資訊，前端無法知道要顯示哪些付款按鈕。這裡回傳的
    // 是「transaction 外僅供顯示」的安全付款方式代碼清單，來源刻意跟
    // POST /popup-checkout 內 validatePopupCheckoutAuthority() 用的兩層
    // 判斷（resolveLineTakeoutAllowedPaymentCodes() ∩ payment_methods 表
    // is_active/enable_for_takeout）完全一致，只是抽成獨立函式給 GET 用，
    // 不會因為兩邊各自維護一份規則而漂移。回傳值一律是對外 canonical 代碼
    // （例如 credit_card，不是資料表內部代碼 card），且已排除 LINE Pay、
    // 不含 gateway_code/license/店家內部資料。
    payment_methods: resolvePublicPopupPaymentMethods(db, storeId),
    effective_state: stateResult.state,
    can_order: stateResult.can_order,
  };
}

function serializePublicCampaign(row) {
  return {
    public_code: row.public_code,
    name: row.name,
    description: row.description,
    image_url: row.image_url,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 依 public_code 查場次／活動（store_id + public_code 雙重驗證，不得跨店讀取）
// ══════════════════════════════════════════════════════════════════════
function findPublicSessionByCode(db, storeId, sessionPublicCode) {
  const session = db.get('SELECT * FROM popup_sessions WHERE public_code=? AND store_id=?', [sessionPublicCode, storeId]);
  if (!session) return null;
  const campaign = db.get('SELECT * FROM popup_campaigns WHERE id=? AND store_id=?', [session.campaign_id, storeId]);
  if (!campaign) return null;
  return { session, campaign };
}

function findPublicCampaignByCode(db, storeId, campaignPublicCode) {
  return db.get('SELECT * FROM popup_campaigns WHERE public_code=? AND store_id=?', [campaignPublicCode, storeId]);
}

function countActivePopupOrdersForSession(db, storeId, sessionId) {
  const row = db.get(
    `SELECT COUNT(*) as c FROM orders WHERE store_id=? AND popup_session_id=? AND order_status NOT IN ('cancelled') AND (voided_at IS NULL OR voided_at='')`,
    [storeId, sessionId]
  );
  return row ? row.c : 0;
}

// Phase 3A.2 新增：直接 fresh 查 stores/licenses，完全不經過
// middleware/featureGate.js 的 30 秒 featureCache——checkout transaction
// 內的權威判斷不能依賴任何 TTL 快取，即使快取剛好還沒過期也不行。
function fetchFreshStoreAuthority(db, storeId) {
  const store = db.get('SELECT active FROM stores WHERE store_id=?', [storeId]);
  const storeActive = !!store && Number(store.active) === 1;
  const lic = db.get('SELECT active, features FROM licenses WHERE store_id=?', [storeId]);
  let licenseActive = true;
  let lineOrderEnabled = false;
  if (lic) {
    licenseActive = !!lic.active;
    try {
      const f = JSON.parse(lic.features || '{}');
      lineOrderEnabled = f.line_order === true;
    } catch (e) { lineOrderEnabled = false; }
  }
  return { storeActive, licenseActive, lineOrderEnabled };
}

// ══════════════════════════════════════════════════════════════════════
// H1.4.12 Phase 3A.3 修正：canonical 信用卡代碼映射。
//
// 對外（LINE 通路 request/settings、訂單 payment_method 欄位）一律使用
// `credit_card`；但 `payment_methods` 資料表本身既有 seed 用的 code 是
// `card`（見 routes/payment-methods.js DEFAULT_PM）。這是兩套本來就存在、
// 各自有自己資料來源的代碼，不得直接拿同一個字串同時比對兩邊——查
// `payment_methods` 表時必須先映射成 `card`，其餘所有地方（LINE 通路層級
// 允許清單、訂單實際保存的 payment_method）一律維持對外代碼 `credit_card`
// 不變。目前只有信用卡這一組代碼需要映射，其餘代碼（cash/linepay/
// transfer/platform）對外代碼與資料表代碼本來就相同。
// ══════════════════════════════════════════════════════════════════════
const EXTERNAL_TO_PAYMENT_METHODS_TABLE_CODE = { credit_card: 'card' };
function toPaymentMethodsTableCode(externalCode) {
  return EXTERNAL_TO_PAYMENT_METHODS_TABLE_CODE[externalCode] || externalCode;
}
// 反向集合：payment_methods 資料表內部代碼（目前只有 'card'）本身不是
// 對外契約的一部分——canonical 對外代碼是 credit_card，request/LINE
// settings 只能用 credit_card。如果呼叫端直接送出資料表內部代碼字面值
// （例如 'card'），一律視為不存在的付款方式，不能因為它剛好跟資料表
// 內部代碼字串相同就矇混通過（那樣等於繞過了「對外代碼與資料表代碼是
// 兩套不同字串」這個契約）。未來若有更多需要映射的代碼，只要維護上面
// 那一份 map，這個集合會自動同步。
const PAYMENT_METHODS_TABLE_INTERNAL_ONLY_CODES = new Set(Object.values(EXTERNAL_TO_PAYMENT_METHODS_TABLE_CODE));

// ══════════════════════════════════════════════════════════════════════
// 結帳權威驗證（規格十二）：前端送出的活動/場次名稱、地址、日期、時間、
// 剩餘份數、場次狀態一律不信任；只認 store_id + popup_session_public_code。
// ══════════════════════════════════════════════════════════════════════
function validatePopupCheckoutAuthority(db, { storeId, sessionPublicCode, items, paymentMethodCode, now }) {
  // Phase 3A.2 修正：stores.active／licenses.active／
  // licenses.features.line_order 全部在這裡（transaction 內、唯一權威呼叫
  // 點）用 fresh 查詢重新驗證一次，不依賴呼叫端在 BEGIN 之前用
  // getStoreLicense()（含 30 秒快取）做過的任何判斷。找不到/停用一律回
  // 跟「場次不存在」相同的 404，不透露是哪一關失敗。
  const authority = fetchFreshStoreAuthority(db, storeId);
  if (!authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled) {
    pp.fail('POPUP_SESSION_NOT_FOUND', '找不到此快閃場次', 404);
  }
  // Phase 3A.3 修正：功能總開關關閉時，統一回跟「code 不存在」完全相同的
  // 404 POPUP_SESSION_NOT_FOUND（不再回 403 POPUP_PICKUP_DISABLED）——
  // 403 這個獨立的 error code 本身就是一種洩漏（等於告訴呼叫端「這個 code
  // 其實存在，只是功能被關掉」），跟其餘所有 checkout authority failure
  // 一樣必須是不可區分的「找不到」。
  if (!pp.isPopupPickupEnabled(db, storeId)) {
    pp.fail('POPUP_SESSION_NOT_FOUND', '找不到此快閃場次', 404);
  }
  if (!pp.isNonEmptyString(sessionPublicCode, 200)) {
    pp.fail('POPUP_VALIDATION_ERROR', '缺少快閃場次代碼');
  }
  const found = findPublicSessionByCode(db, storeId, sessionPublicCode);
  if (!found) pp.fail('POPUP_SESSION_NOT_FOUND', '找不到此快閃場次', 404);
  const { session, campaign } = found;

  // Phase 3A.3 修正：session 自己是 draft，或它的 parent campaign 是
  // draft，必須在呼叫 resolvePopupSessionState() 之前就擋下、回跟「code
  // 不存在」完全相同的 404——絕不能讓它先被 resolvePopupSessionState()
  // 判斷成 409 state=draft（那樣等於告訴呼叫端「這個 code 其實存在，只是
  // 還沒發布」，是一種存在性洩漏）。跟 GET /popup-session 的既有契約
  // （routes/popup-public.js）保持一致。
  if (session.status === 'draft' || campaign.status === 'draft') {
    pp.fail('POPUP_SESSION_NOT_FOUND', '找不到此快閃場次', 404);
  }

  const stateResult = pp.resolvePopupSessionState({
    campaignStatus: campaign.status,
    sessionStatus: session.status,
    pickupDate: session.pickup_date,
    pickupStartTime: session.pickup_start_time,
    pickupEndTime: session.pickup_end_time,
    orderOpenAt: session.order_open_at,
    orderCutoffAt: session.order_cutoff_at,
    now,
  });
  if (!stateResult.can_order) {
    const messages = {
      // Phase 3A.3：draft 這個分支理論上已經在上面被攔截、不會再走到這裡
      // （保留 key 只是 defense-in-depth，不代表這條路徑會被觸發）。
      draft: '此快閃場次尚未發布',
      paused: '此快閃活動／場次目前暫停接單',
      cancelled: '本場快閃已取消',
      archived: '本場快閃已結束封存',
      scheduled: '尚未開放預訂',
      ordering_closed: '本場快閃已截止預訂',
      pickup_active: '本場快閃已截止預訂',
      ended: '本場快閃已結束',
      invalid: '此快閃場次資料異常，請聯絡店家',
    };
    pp.fail('POPUP_SESSION_NOT_ORDERABLE', messages[stateResult.state] || '此快閃場次目前無法下單', 409, { state: stateResult.state });
  }

  if (pp.isPositiveInt(session.max_orders) && session.max_orders > 0) {
    const orderCount = countActivePopupOrdersForSession(db, storeId, session.id);
    if (orderCount >= session.max_orders) {
      pp.fail('POPUP_SESSION_FULL', '此場次訂單已達上限，請選擇其他場次', 409);
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    pp.fail('POPUP_VALIDATION_ERROR', '購物車不得為空');
  }
  // 規格七：合理的 items 列數上限，避免單一請求撐爆 SQLite bind-variable
  // 上限（也避免惡意超大陣列拖垮伺服器）。快閃場次一次能賣的品項數量本來
  // 就有限，50 筆列（不是數量，是「不同品項列數」）綽綽有餘。
  const MAX_ITEM_LINES = 50;
  if (items.length > MAX_ITEM_LINES) {
    pp.fail('POPUP_VALIDATION_ERROR', `購物車品項列數不得超過 ${MAX_ITEM_LINES} 筆`);
  }
  const normalizedItems = items.map((it, idx) => {
    if (!it || !pp.isPositiveInt(it.product_id)) {
      pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].product_id 必須是大於 0 的安全整數`);
    }
    if (!pp.isPositiveInt(it.qty)) {
      pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].qty 必須是大於 0 的安全整數`);
    }
    return { product_id: it.product_id, qty: it.qty };
  });

  // 商品資格：必須真實存在、屬於本店；名稱／價格／是否可購買一律用
  // resolvePopupProductSSOT() 這個單一事實來源（line_name/line_price 優先
  // 序、show_on_line/sale_status/line_sold_out/line_takeout_enabled 全部
  // 一起判斷），跟公開頁面顯示用的是同一份規則，保證兩邊金額/名稱一致。
  // 若場次為 selected scope，還必須是該場次白名單內的商品（enabled=1）且
  // 份數足夠。
  const productRows = db.all(
    `SELECT id, name, price, takeaway_price, line_name, line_price, enabled, show_on_line, sale_status, line_sold_out, line_takeout_enabled
     FROM products WHERE store_id=? AND id IN (${normalizedItems.map(() => '?').join(',')})`,
    [storeId, ...normalizedItems.map((i) => i.product_id)]
  );
  const productMap = new Map(productRows.map((p) => [Number(p.id), p]));

  const priced = normalizedItems.map((it) => {
    const p = productMap.get(it.product_id);
    if (!p) pp.fail('POPUP_VALIDATION_ERROR', `商品 id=${it.product_id} 不存在或不屬於此店家`);
    const ssot = resolvePopupProductSSOT(p);
    if (!ssot.is_line_takeout_orderable) {
      pp.fail('POPUP_PRODUCT_NOT_AVAILABLE', `商品「${ssot.name}」目前不開放外帶購買`, 409);
    }
    // 規格七：單價與數量都必須是有限、非負的安全數值，單品小計
    // （price*qty）本身也必須是安全整數／有限值，避免極端輸入讓後續的
    // subtotal 加總溢位成 Infinity/NaN。
    if (!Number.isFinite(ssot.price) || ssot.price < 0) {
      pp.fail('POPUP_INTERNAL_ERROR', `商品「${ssot.name}」價格設定異常，請聯絡店家`, 500);
    }
    const lineTotal = ssot.price * it.qty;
    if (!Number.isFinite(lineTotal) || !Number.isSafeInteger(Math.round(lineTotal))) {
      pp.fail('POPUP_VALIDATION_ERROR', `商品「${ssot.name}」數量過大，小計超出安全範圍`);
    }
    return { product_id: it.product_id, qty: it.qty, name: ssot.name, price: ssot.price };
  });

  if (session.product_scope === 'selected') {
    // Phase 3A 修正：先彙總購物車內重複的 product_id 再檢查份數，避免把同一
    // 商品拆成兩筆（例如 qty=2 + qty=2）分別檢查都「看起來」沒超過，但加總
    // 其實已經超額的繞過手法。這裡是「快速失敗」用的預先檢查（讓明顯會
    // 超賣的請求不必等到進了 transaction 才被拒絕）；真正權威、不可繞過的
    // 檢查一律是 allocatePopupOrderItemsInTransaction() 在交易內對同一份
    // 彙總結果重新查一次目前已扣份數才算數。
    const groupedForCheck = new Map();
    priced.forEach((it) => {
      const nextQty = (groupedForCheck.get(it.product_id) || 0) + it.qty;
      if (!Number.isSafeInteger(nextQty)) {
        pp.fail('POPUP_VALIDATION_ERROR', `商品 id=${it.product_id} 彙總數量超出安全整數範圍`);
      }
      groupedForCheck.set(it.product_id, nextQty);
    });
    groupedForCheck.forEach((qty, productId) => {
      const label = priced.find((it) => it.product_id === productId).name;
      const spRow = db.get(
        'SELECT quota_qty FROM popup_session_products WHERE session_id=? AND store_id=? AND product_id=? AND enabled=1',
        [session.id, storeId, productId]
      );
      if (!spRow) pp.fail('POPUP_PRODUCT_NOT_IN_SESSION', `商品「${label}」不在此場次可售清單中`, 409);
      if (spRow.quota_qty > 0) {
        const used = getActiveAllocatedQty(db, storeId, session.id, productId);
        if (used + qty > spRow.quota_qty) {
          pp.fail('POPUP_PRODUCT_SOLD_OUT', `商品「${label}」剩餘份數不足`, 409, {
            product_id: productId, remaining: Math.max(0, spRow.quota_qty - used),
          });
        }
      }
    });
  }

  // 付款方式（Phase 3A.2 修正）：
  //   - 只有「完全沒有送這個欄位」（undefined）才會被正規化成預設值 'cash'。
  //   - null、空字串、陣列、物件、數字等「有送但送了不合法的東西」一律視為
  //     嚴格型別錯誤，直接 400，不會被寬鬆地當成「沒送」處理。
  const paymentMethodCodeOmitted = paymentMethodCode === undefined;
  const normalizedPaymentCode = paymentMethodCodeOmitted ? 'cash' : paymentMethodCode;
  if (typeof normalizedPaymentCode !== 'string' || !normalizedPaymentCode.trim()) {
    pp.fail('POPUP_VALIDATION_ERROR', 'payment_method 必須是非空字串（省略欄位時才會預設為 cash）');
  }
  // LINE Pay（或任何 gateway_code/code 指向 LINE Pay 的付款方式）在 Phase 4
  // 前尚未真的串接金流，快閃取餐一律明確拒絕，不得建立佔用 quota 的
  // 「假成功」訂單——這個檢查刻意放在查 payment_methods 表之前也做一次
  // code 本身的字面比對，涵蓋「code 本身就叫 linepay 但這張表資料還沒填
  // gateway_code」的情況。
  if (/linepay/i.test(normalizedPaymentCode)) {
    pp.fail('POPUP_PAYMENT_METHOD_NOT_READY', '此付款方式尚未開放於快閃取餐，請選擇現金或其他已開放的付款方式', 409);
  }
  // Phase 3A.3 修正：payment_methods 資料表的內部代碼（目前只有 'card'）
  // 不是對外契約的一部分——canonical 對外代碼是 credit_card，request 或
  // LINE settings 只能用 credit_card。呼叫端直接送出 'card' 這個字面值
  // 一律視為不存在的付款方式，不會因為它剛好跟資料表內部代碼字串相同
  // 就矇混通過（否則等於讓兩套代碼在對外 API 上變成同義詞，破壞「對外
  // 代碼與資料表代碼是兩套不同字串」這個契約）。
  if (PAYMENT_METHODS_TABLE_INTERNAL_ONLY_CODES.has(normalizedPaymentCode)) {
    pp.fail('POPUP_PAYMENT_METHOD_NOT_ALLOWED', '此付款方式不適用於快閃取餐', 400);
  }
  const pm = db.get('SELECT * FROM payment_methods WHERE store_id=? AND code=? AND is_active=1', [storeId, toPaymentMethodsTableCode(normalizedPaymentCode)]);
  if (!pm || Number(pm.enable_for_takeout) !== 1) {
    pp.fail('POPUP_PAYMENT_METHOD_NOT_ALLOWED', '此付款方式不適用於快閃取餐', 400);
  }
  if (pm.gateway_code && /linepay/i.test(pm.gateway_code)) {
    pp.fail('POPUP_PAYMENT_METHOD_NOT_READY', '此付款方式尚未開放於快閃取餐，請選擇現金或其他已開放的付款方式', 409);
  }
  // 同時驗證 LINE 通路層級的付款方式設定（takeout_payment_methods，未設定
  // 時 fallback 既有 line_payment_* 個別開關）——這是「LINE 點餐頁面願意
  // 顯示/允許哪些付款按鈕」的既有設定，跟 payment_methods 資料表本身的
  // enable_for_takeout 是兩層獨立的權限，必須同時通過。任一層沒開放這個
  // 付款方式，都視為不允許。Phase 3A.4 修正：這個函式現在永遠回傳一個
  // 陣列（可能是空陣列），不再有「回傳 null 代表沒有額外限制」這個分支
  // ——跟 GET /shop 的既有語意一致：空陣列就是「這個通路目前不允許任何
  // 付款方式」，不是「沒有限制」。
  const lineAllowedCodes = resolveLineTakeoutAllowedPaymentCodes(db, storeId);
  if (!lineAllowedCodes.includes(normalizedPaymentCode)) {
    pp.fail('POPUP_PAYMENT_METHOD_NOT_ALLOWED', '此付款方式未在 LINE 點餐開放使用', 400);
  }

  const subtotal = priced.reduce((sum, it) => sum + it.price * it.qty, 0);
  // 規格七：每一行的 price*qty 個別都已經檢查過安全整數範圍，但把最多 50
  // 行加總起來的 subtotal 本身從未再檢查過一次——50 行「個別安全」的極端
  // 大金額加總後可能超出 Number.MAX_SAFE_INTEGER，靜默失去精度卻沒有任何
  // 錯誤，等於一張金額被悄悄算錯的訂單。這裡補上加總後的安全檢查，跟
  // 逐行檢查用同一個判斷式，不是另外發明一套。
  if (!Number.isFinite(subtotal) || !Number.isSafeInteger(subtotal)) {
    pp.fail('POPUP_VALIDATION_ERROR', '訂單總金額超出安全範圍，請減少購買數量或分開下單');
  }
  if (!Number.isFinite(subtotal) || subtotal < 0 || !Number.isSafeInteger(Math.round(subtotal))) {
    pp.fail('POPUP_VALIDATION_ERROR', '訂單金額超出安全範圍');
  }

  return { session, campaign, items: priced, subtotal, paymentMethodCode: normalizedPaymentCode };
}

// ══════════════════════════════════════════════════════════════════════
// LINE 通路層級「允許哪些付款方式代碼」（Phase 3A.4 修正：真正共用同一個
// 函式，不再是各自維護一份會漂移的規則）：
//
// 本體邏輯已經抽到 `utils/linePaymentMethods.js` 的
// `resolveLineChannelPaymentCodes()`——這正是 `routes/line-orders.js`
// GET /shop 讀取 `settings.takeout_payment_methods` 時實際呼叫的同一個
// 函式（該檔案的 `getModePaymentMethods()` 現在也只是薄包裝，呼叫的是
// 同一份實作）。語意（不得為了配合 popup 而改變，這是既有一般 LINE 通路
// 的正式行為）：
//   1. `settings.takeout_payment_methods` 存在且能解析成「合法、非空」的
//      JSON 陣列 → 直接使用該陣列，視為權威，不 fallback。
//   2. 空陣列 `[]`、空值／未設定、非法 JSON、或解析結果不是陣列 → 全部
//      視為「沒有明確設定新版陣列」，fallback 到既有的
//      `line_payment_cash_enabled`／`line_payment_linepay_enabled`／
//      `line_payment_transfer_enabled`／`line_payment_platform_enabled`／
//      `line_payment_credit_card_enabled` 個別開關，只要有任何一個等於
//      `'1'` 就組出對應允許清單。
//   3. legacy 開關全部是 `'0'`（或都沒設定過）→ 回傳空陣列 `[]`，代表
//      「這個通路目前不允許任何付款方式」——popup checkout 同樣視為拒絕
//      所有付款方式，跟 GET /shop 對這個空陣列的解讀完全一致。
// ══════════════════════════════════════════════════════════════════════
function resolveLineTakeoutAllowedPaymentCodes(db, storeId) {
  return resolveLineChannelPaymentCodes(db, storeId, 'takeout_payment_methods');
}

// ══════════════════════════════════════════════════════════════════════
// Phase 3B 補強：公開、僅供顯示用的付款方式清單（規格七）。
//
// 刻意重用 POST /popup-checkout 權威驗證裡的同兩層判斷，而不是另外發明
// 一套規則：
//   1. LINE 通路層級允許清單：resolveLineTakeoutAllowedPaymentCodes()
//      （跟 validatePopupCheckoutAuthority() 用的是同一個函式）。
//   2. payment_methods 資料表本身：is_active=1 AND enable_for_takeout=1
//      （用 toPaymentMethodsTableCode() 做 credit_card→card 映射，跟
//      checkout 查詢用的是同一份映射表）。
// 任一層沒開放的付款方式一律不會出現在這個清單。額外排除規則（跟
// checkout 一致）：
//   - code 或 payment_methods.gateway_code 命中 /linepay/i 一律排除
//     （LINE Pay 尚未串接完成，不能出現在可選清單，即使被手動注入仍會被
//     checkout 拒絕，但「顯示」這一層本身也不該讓它出現）。
//   - payment_methods 資料表內部代碼（目前只有 'card'）不是對外契約，
//     防禦性忽略，理論上 resolveLineTakeoutAllowedPaymentCodes() 不會回
//     傳這個字面值。
// 回傳值只是字串陣列（對外 canonical 代碼），不含 gateway_code、金額、
// 內部 id 或任何 license/店家資料，可以安全地放進公開 GET 回應。
// ══════════════════════════════════════════════════════════════════════
function resolvePublicPopupPaymentMethods(db, storeId) {
  const lineAllowedCodes = resolveLineTakeoutAllowedPaymentCodes(db, storeId);
  if (!Array.isArray(lineAllowedCodes) || lineAllowedCodes.length === 0) return [];
  const result = [];
  lineAllowedCodes.forEach((externalCode) => {
    if (typeof externalCode !== 'string' || !externalCode) return;
    if (PAYMENT_METHODS_TABLE_INTERNAL_ONLY_CODES.has(externalCode)) return;
    if (/linepay/i.test(externalCode)) return;
    const tableCode = toPaymentMethodsTableCode(externalCode);
    const pm = db.get(
      'SELECT gateway_code FROM payment_methods WHERE store_id=? AND code=? AND is_active=1 AND enable_for_takeout=1',
      [storeId, tableCode]
    );
    if (!pm) return;
    if (pm.gateway_code && /linepay/i.test(pm.gateway_code)) return;
    if (!result.includes(externalCode)) result.push(externalCode);
  });
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Allocation 原子扣減（規格十）：呼叫端必須已經在自己的 BEGIN...COMMIT 交易
// 內呼叫這個函式——本函式不自己開交易，讓訂單 INSERT 與份數扣減同屬一個
// atomic 單位。同一商品若在 items 中出現多次，先加總再檢查一次，避免
// 「拆成兩筆各自檢查都通過，但加總已經超額」的漏洞。
// ══════════════════════════════════════════════════════════════════════
function allocatePopupOrderItemsInTransaction(db, storeId, session, orderId, items) {
  const grouped = new Map();
  items.forEach((it) => {
    // Defense-in-depth（規格七）：即使 validatePopupCheckoutAuthority() 已經
    // 檢查過一次，這裡是交易內真正寫入份數帳本前的最後一道防線，任何呼叫
    // 端（含未來可能新增的呼叫路徑）都不能繞過這個檢查直接呼叫這個函式。
    if (!pp.isPositiveInt(it.product_id) || !pp.isPositiveInt(it.qty)) {
      pp.fail('POPUP_VALIDATION_ERROR', 'allocation 內部資料異常：product_id/qty 必須是安全正整數', 500);
    }
    const nextQty = (grouped.get(it.product_id) || 0) + it.qty;
    if (!Number.isSafeInteger(nextQty)) {
      pp.fail('POPUP_VALIDATION_ERROR', `商品 id=${it.product_id} 彙總數量超出安全整數範圍`, 400);
    }
    grouped.set(it.product_id, nextQty);
  });

  grouped.forEach((qty, productId) => {
    if (session.product_scope === 'selected') {
      const spRow = db.get(
        'SELECT quota_qty FROM popup_session_products WHERE session_id=? AND store_id=? AND product_id=? AND enabled=1',
        [session.id, storeId, productId]
      );
      if (!spRow) pp.fail('POPUP_PRODUCT_NOT_IN_SESSION', `商品 id=${productId} 不在此場次可售清單中`, 409);
      if (spRow.quota_qty > 0) {
        // 交易內重新查一次目前已扣的份數（權威值，不沿用交易外任何估計）。
        const used = getActiveAllocatedQty(db, storeId, session.id, productId);
        if (used + qty > spRow.quota_qty) {
          pp.fail('POPUP_PRODUCT_SOLD_OUT', `商品 id=${productId} 剩餘份數不足`, 409, {
            product_id: productId, remaining: Math.max(0, spRow.quota_qty - used),
          });
        }
      }
    }
    db._db.run(
      'INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)',
      [storeId, session.id, orderId, productId, qty, 'active']
    );
  });
}

// ══════════════════════════════════════════════════════════════════════
// 冪等釋放（規格十）：WHERE status='active' 確保重複呼叫（重複取消／作廢）
// 只有第一次會真的改變資料，之後都是 0 rows affected，不會扣成負數。
// 建議在呼叫端自己的交易內呼叫；若不在交易內，這個 UPDATE 本身仍是單一
// atomic 陳述句，SQLite 保證單一陳述句的原子性。
// ══════════════════════════════════════════════════════════════════════
// 冪等釋放（規格十）：WHERE 同時限制 store_id、order_id、session_id 與
// status='active'——四個條件缺一不可（sessionId 為必填，不是選填），確保
// 這個 UPDATE 只會動到「這張訂單、這個場次」自己的 allocation 列，不會誤動
// 到理論上不該存在、但萬一因為資料污染而混進來的其他列。重複呼叫（重複
// 取消／重複作廢／取消後再作廢）只有第一次會真的改變資料，之後都是 0 rows
// affected，不會扣成負數。
function releasePopupOrderAllocations(db, storeId, orderId, sessionId) {
  db._db.run(
    `UPDATE popup_order_allocations SET status='released', released_at=datetime('now','localtime')
     WHERE store_id=? AND order_id=? AND session_id=? AND status='active'`,
    [storeId, orderId, sessionId]
  );
  return db._db.getRowsModified();
}

module.exports = {
  findPublicSessionByCode,
  findPublicCampaignByCode,
  serializePublicSession,
  serializePublicCampaign,
  serializePublicSessionProducts,
  serializeSelectedScopeProducts,
  serializeAllTakeoutScopeProducts,
  getActiveAllocatedQty,
  countActivePopupOrdersForSession,
  fetchFreshStoreAuthority,
  toPaymentMethodsTableCode,
  resolveLineTakeoutAllowedPaymentCodes,
  resolvePublicPopupPaymentMethods,
  validatePopupCheckoutAuthority,
  allocatePopupOrderItemsInTransaction,
  releasePopupOrderAllocations,
  reconcilePopupCartItemsAgainstFreshAuthority,
};
