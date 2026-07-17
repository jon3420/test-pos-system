// utils/pickupLocation.js — fix18-10-hotfix26-F4 / F5
//
// 單一共用 helper：外帶訂單「取餐門市 / 取餐地址 / 取餐說明」的產生（snapshot）與
// 顯示（resolve），以及後台「取餐地點設定」的單一事實來源（resolvePickupSettings）。
// 供以下畫面／流程共用同一套規則，避免各自兜地址造成不一致：
//   - GET /api/line-orders/shop（購物車取餐地址 UI，F3）
//   - POST /api/line-orders（建立訂單時寫入 snapshot、回傳給前端顯示完成頁，F4）
//   - POST /api/line-orders/query、/history（查詢訂單／我的訂單，F4）
//   - 後台「取餐地點」設定讀取／儲存（routes/settings.js，F5）
//   - LINE 訂單通知（目前專案未實作顧客端 LINE 訂單推播，見 CHANGELOG）
//
// fix18-10-hotfix26-F5：新增獨立「取餐地點」設定（pickup_address_same_as_store／
// pickup_address／pickup_address_note／pickup_lat／pickup_lng／pickup_coordinate_mode／
// pickup_coordinate_verified_at／pickup_sync_delivery_origin），全部沿用既有 settings
// key-value 表，不新增資料表。resolvePickupSettings() 是唯一負責套用「相同店家地址 /
// 獨立取餐地址」優先序的地方；buildPickupSnapshot()／resolvePickupLocation() 的 fallback
// 分支都改呼叫這裡，不再各自兜地址。
'use strict';

const FALLBACK_ADDRESS_TEXT = '請洽店家確認取餐地點';
const FALLBACK_STORE_NAME_TEXT = '門市';

function getSettingVal(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// 有座標優先用座標產生 Google Maps 連結（較精準）；沒有座標才 fallback 用地址搜尋。
// 與 public/line-order.html 既有 buildPickupMapsUrl() 規則一致。
function buildMapsUrl(lat, lng, address) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps?q=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return '';
}

// fix18-10-hotfix26-F5：後台「取餐地點」設定的單一事實來源。
// 讀取「當下」（不是訂單建立當時）的取餐地點設定，套用文件規格的優先序：
//
//   地址：same_as_store=true  → store_address
//         same_as_store=false → pickup_address → store_address → ''（呼叫端決定 fallback 文字）
//   座標：same_as_store=true  → store_lat/store_lng
//         same_as_store=false → pickup_lat/pickup_lng → store_lat/store_lng → null（呼叫端 fallback 地址搜尋）
//   取餐說明：只有「獨立取餐地址」時才有意義（跟店家地址相同時不顯示取餐說明）。
//
// 相容性處理（重要）：pickup_address_same_as_store 是本版（F5）才新增的欄位。文件規格
// 預設值是 true，但既有店家可能在 F3／F4 就已經設定過獨立的 pickup_address（那時候
// 還沒有 same_as_store 這個開關，行為等同「一定會 fallback 用 pickup_address」）。
// 如果 F5 上線後，這批舊店家的 pickup_address_same_as_store 一律預設 true，會讓他們
// 已經設定好的獨立取餐地址被「靜默忽略」，改回顯示店家地址——這是不能接受的隱性regression。
// 因此：只有在 pickup_address_same_as_store 這個 key 完全沒被寫入過，才用「是否已有
// pickup_address」推斷合理預設值；只要 key 曾經被寫入過（即使是空字串），一律照字面值。
// 判斷 pickup_address_same_as_store 的「有效值」（供 resolvePickupSettings() 與
// GET /api/line-orders/shop 共用同一份預設值推斷邏輯，避免兩處各自兜一份）。
// key 完全沒寫入過時才用「是否已有 pickup_address」推斷預設值；
// 只要 key 曾被寫入過（即使是空字串），一律照字面值，不再猜測。
function resolveSameAsStoreFlag(db, storeId) {
  const rawRow = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, 'pickup_address_same_as_store']);
  const legacyPickupAddr = String(getSettingVal(db, storeId, 'pickup_address', '') || '').trim();
  if (rawRow === undefined) return legacyPickupAddr ? false : true;
  return String(rawRow.value) === '1' || String(rawRow.value).toLowerCase() === 'true';
}

function resolvePickupSettings(db, storeId) {
  const sameAsStore = resolveSameAsStoreFlag(db, storeId);
  const legacyPickupAddr = String(getSettingVal(db, storeId, 'pickup_address', '') || '').trim();

  const storeName = String(getSettingVal(db, storeId, 'shop_name', '') || '').trim();
  const storeAddr = String(getSettingVal(db, storeId, 'store_address', '') || '').trim();
  const storeLat  = parseFloat(getSettingVal(db, storeId, 'store_lat', ''));
  const storeLng  = parseFloat(getSettingVal(db, storeId, 'store_lng', ''));

  const pickupAddr = legacyPickupAddr;
  const pickupNote = String(getSettingVal(db, storeId, 'pickup_address_note', '') || '').trim();
  const pickupLat  = parseFloat(getSettingVal(db, storeId, 'pickup_lat', ''));
  const pickupLng  = parseFloat(getSettingVal(db, storeId, 'pickup_lng', ''));
  const coordinateModeRaw = String(getSettingVal(db, storeId, 'pickup_coordinate_mode', 'auto') || 'auto');
  const verifiedAt = String(getSettingVal(db, storeId, 'pickup_coordinate_verified_at', '') || '');
  const syncDeliveryOriginRaw = String(getSettingVal(db, storeId, 'pickup_sync_delivery_origin', '0') || '0');

  let address, lat, lng;
  if (sameAsStore) {
    address = storeAddr;
    lat = Number.isFinite(storeLat) ? storeLat : null;
    lng = Number.isFinite(storeLng) ? storeLng : null;
  } else {
    address = pickupAddr || storeAddr || '';
    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      lat = pickupLat; lng = pickupLng;
    } else if (Number.isFinite(storeLat) && Number.isFinite(storeLng)) {
      lat = storeLat; lng = storeLng;
    } else {
      lat = null; lng = null;
    }
  }
  // 取餐說明只在「獨立取餐地址」時才有意義；跟店家地址相同時，說明欄位不顯示。
  const addressNote = (!sameAsStore && pickupAddr) ? pickupNote : '';

  return {
    same_as_store: sameAsStore,
    store_name: storeName,
    address,
    address_note: addressNote,
    lat, lng,
    coordinate_mode: coordinateModeRaw === 'manual' ? 'manual' : 'auto',
    verified_at: verifiedAt,
    sync_delivery_origin: syncDeliveryOriginRaw === '1' || syncDeliveryOriginRaw.toLowerCase() === 'true',
  };
}

// 建立訂單當下呼叫：由後端依 store_id 重新讀取店家設定（含 F5 取餐地點設定），產生
// 要寫入 orders 的 snapshot 值。重要：不信任前端傳入的門市名稱／地址／座標／說明，
// 一律由這裡（伺服器端）依 resolvePickupSettings() 重新解析。
// 只有外帶（含預購外帶）才需要寫入；外送訂單呼叫端不應呼叫本函式（避免誤寫成配送地址）。
function buildPickupSnapshot(db, storeId) {
  const cur = resolvePickupSettings(db, storeId);
  return {
    pickup_store_name_snapshot:      cur.store_name || '',
    pickup_address_snapshot:         cur.address || '',
    pickup_address_note_snapshot:    cur.address_note || '',
    pickup_lat_snapshot:             cur.lat != null ? String(cur.lat) : '',
    pickup_lng_snapshot:             cur.lng != null ? String(cur.lng) : '',
  };
}

// 顯示用：訂單完成頁／查詢訂單／我的訂單／（未來若有）LINE 通知共用。
// order 需含 order_mode 及 pickup_*_snapshot 欄位（舊訂單可能是 NULL 或空字串）。
// 規則：外送訂單一律回傳 null（不顯示取餐門市／地址，維持既有顧客配送地址邏輯）；
//       外帶訂單優先使用 order 自己的 snapshot，沒有 snapshot 時（舊訂單）才 fallback
//       顯示「目前」取餐地點設定（resolvePickupSettings）—— 這種情況需明確認知：
//       舊訂單沒有快照時，只能顯示目前設定，可能與該筆訂單實際下單當時不同。
function resolvePickupLocation(order, db, storeId) {
  if (!order || order.order_mode === 'delivery') return null;

  const snapName = String(order.pickup_store_name_snapshot || '').trim();
  const snapAddr = String(order.pickup_address_snapshot || '').trim();
  const snapNote = String(order.pickup_address_note_snapshot || '').trim();
  const snapLat  = parseFloat(order.pickup_lat_snapshot);
  const snapLng  = parseFloat(order.pickup_lng_snapshot);
  const hasSnapshot = !!(snapName || snapAddr);

  let storeName, address, addressNote, lat, lng;
  if (hasSnapshot) {
    storeName = snapName;
    address = snapAddr;
    addressNote = snapNote;
    lat = Number.isFinite(snapLat) ? snapLat : null;
    lng = Number.isFinite(snapLng) ? snapLng : null;
  } else {
    // 舊訂單沒有快照時，只能顯示目前取餐地點設定
    const cur = resolvePickupSettings(db, storeId);
    storeName = cur.store_name;
    address = cur.address;
    addressNote = cur.address_note;
    lat = cur.lat;
    lng = cur.lng;
  }

  const hasAddress = !!address;
  return {
    store_name: storeName || FALLBACK_STORE_NAME_TEXT,
    address: hasAddress ? address : FALLBACK_ADDRESS_TEXT,
    address_note: hasAddress ? (addressNote || '') : '',
    has_address: hasAddress,
    lat, lng,
    maps_url: hasAddress ? buildMapsUrl(lat, lng, address) : '',
    from_snapshot: hasSnapshot,
  };
}

module.exports = {
  buildPickupSnapshot,
  resolvePickupLocation,
  resolvePickupSettings,
  resolveSameAsStoreFlag,
  // 保留舊名稱作為 resolvePickupSettings 的別名，避免其他呼叫端（若有）因改名而壞掉。
  readCurrentStorePickup: resolvePickupSettings,
  buildMapsUrl,
  FALLBACK_ADDRESS_TEXT,
  FALLBACK_STORE_NAME_TEXT,
};
