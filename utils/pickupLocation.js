// utils/pickupLocation.js — fix18-10-hotfix26-F4
//
// 單一共用 helper：外帶訂單「取餐門市 / 取餐地址」的產生（snapshot）與顯示（resolve）。
// 供以下畫面／流程共用同一套規則，避免各自兜地址造成不一致：
//   - POST /api/line-orders（建立訂單時寫入 snapshot、回傳給前端顯示完成頁）
//   - POST /api/line-orders/query、/history（查詢訂單／我的訂單）
//   - LINE 訂單通知（目前專案未實作顧客端 LINE 訂單推播，見 CHANGELOG）
//
// 地址來源優先序需與既有 fix18-10-hotfix26-F3（購物車取餐地址 UI，
// public/line-order.html 的 resolvePickupAddressText()）完全一致：
//   store_address → pickup_address → 都沒有則顯示安全提示文字
// 座標只有 store_lat/store_lng 一組設定（專案目前沒有獨立的 pickup_lat/pickup_lng
// 設定欄位；曾核對過 routes/settings.js 與 GET /api/line-orders/shop 白名單，
// 確認沒有 pickup_lat/pickup_lng 這組設定，因此不可虛構）。
// 門市名稱使用既有 shop_name 設定（曾核對過 GET /shop 實際回傳欄位，確認店名欄位
// 是 shop_name，不是文件草稿猜測的 store_name/name/shop_name 三選一）。
'use strict';

const FALLBACK_ADDRESS_TEXT = '請洽店家確認取餐地點';
const FALLBACK_STORE_NAME_TEXT = '門市';

function getSettingVal(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// 讀取「當下」店家門市名稱／取餐地址／座標設定。
// 用途：(a) 建立訂單當下寫入 snapshot　(b) 舊訂單沒有 snapshot 時的 fallback 顯示。
// 全程以 store_id 查詢 settings 表，天然具備 tenant isolation（不會跨店讀到別店設定）。
function readCurrentStorePickup(db, storeId) {
  const storeName  = String(getSettingVal(db, storeId, 'shop_name', '') || '').trim();
  const storeAddr  = String(getSettingVal(db, storeId, 'store_address', '') || '').trim();
  const pickupAddr = String(getSettingVal(db, storeId, 'pickup_address', '') || '').trim();
  const address = storeAddr || pickupAddr || '';
  const lat = parseFloat(getSettingVal(db, storeId, 'store_lat', ''));
  const lng = parseFloat(getSettingVal(db, storeId, 'store_lng', ''));
  return {
    store_name: storeName,
    address,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

// 有座標優先用座標產生 Google Maps 連結（較精準）；沒有座標才 fallback 用地址搜尋。
// 與 public/line-order.html 既有 buildPickupMapsUrl() 規則一致。
function buildMapsUrl(lat, lng, address) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps?q=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return '';
}

// 建立訂單當下呼叫：由後端依 store_id 重新讀取店家設定，產生要寫入 orders 的 snapshot 值。
// 重要：不信任前端傳入的門市名稱／地址／座標，一律由這裡（伺服器端）重新解析。
// 只有外帶（含預購外帶）才需要寫入；外送訂單呼叫端不應呼叫本函式（避免誤寫成配送地址）。
function buildPickupSnapshot(db, storeId) {
  const cur = readCurrentStorePickup(db, storeId);
  return {
    pickup_store_name_snapshot: cur.store_name || '',
    pickup_address_snapshot:    cur.address || '',
    pickup_lat_snapshot:        cur.lat != null ? String(cur.lat) : '',
    pickup_lng_snapshot:        cur.lng != null ? String(cur.lng) : '',
  };
}

// 顯示用：訂單完成頁／查詢訂單／我的訂單／（未來若有）LINE 通知共用。
// order 需含 order_mode 及 pickup_*_snapshot 欄位（舊訂單可能是 NULL 或空字串）。
// 規則：外送訂單一律回傳 null（不顯示取餐門市／地址，維持既有顧客配送地址邏輯）；
//       外帶訂單優先使用 order 自己的 snapshot，沒有 snapshot 時（舊訂單）才 fallback
//       顯示「目前」店家設定 —— 這種情況需明確認知：舊訂單沒有快照時，只能顯示目前
//       店家資料，可能與該筆訂單實際下單當時的門市名稱／地址不同。
function resolvePickupLocation(order, db, storeId) {
  if (!order || order.order_mode === 'delivery') return null;

  const snapName = String(order.pickup_store_name_snapshot || '').trim();
  const snapAddr = String(order.pickup_address_snapshot || '').trim();
  const snapLat  = parseFloat(order.pickup_lat_snapshot);
  const snapLng  = parseFloat(order.pickup_lng_snapshot);
  const hasSnapshot = !!(snapName || snapAddr);

  let storeName, address, lat, lng;
  if (hasSnapshot) {
    storeName = snapName;
    address   = snapAddr;
    lat = Number.isFinite(snapLat) ? snapLat : null;
    lng = Number.isFinite(snapLng) ? snapLng : null;
  } else {
    // 舊訂單沒有快照時，只能顯示目前店家資料
    const cur = readCurrentStorePickup(db, storeId);
    storeName = cur.store_name;
    address   = cur.address;
    lat = cur.lat;
    lng = cur.lng;
  }

  const hasAddress = !!address;
  return {
    store_name: storeName || FALLBACK_STORE_NAME_TEXT,
    address: hasAddress ? address : FALLBACK_ADDRESS_TEXT,
    has_address: hasAddress,
    lat, lng,
    maps_url: hasAddress ? buildMapsUrl(lat, lng, address) : '',
    from_snapshot: hasSnapshot,
  };
}

module.exports = {
  buildPickupSnapshot,
  resolvePickupLocation,
  readCurrentStorePickup,
  buildMapsUrl,
  FALLBACK_ADDRESS_TEXT,
  FALLBACK_STORE_NAME_TEXT,
};
