// utils/pickupLocation.js — fix18-10-hotfix26-F4 / F5 / F7
//
// 單一共用 helper：外帶訂單「取餐商家 / 取餐地址 / 取餐說明」的產生（snapshot）與
// 顯示（resolve），以及後台「取餐地點設定」「店家地址與外送起點設定」的單一事實
// 來源。供以下畫面／流程共用同一套規則，避免各自兜地址造成不一致：
//   - GET /api/line-orders/shop（購物車取餐地址 UI，F3/F7）
//   - POST /api/line-orders（建立訂單時寫入 snapshot、回傳給前端顯示完成頁，F4/F7）
//   - POST /api/line-orders/query、/history（查詢訂單／我的訂單，F4/F7）
//   - 後台「取餐地點」「店家座標」設定讀取／儲存（routes/settings.js，F5/F7）
//   - LINE 訂單通知（目前專案未實作顧客端 LINE 訂單推播，見 CHANGELOG）
//
// fix18-10-hotfix26-F7（Pickup Place Auto Fill × Store Map Search × Independent Save）
// 這一版修的是三個根因：
//   1. 獨立取餐地點「只有座標、沒有商家名稱或地址文字」時，舊版會 fallback 顯示
//      店家地址，讓顧客誤以為要去店家取餐——這版拿掉這個 fallback，改用
//      coords_only 旗標讓前台顯示中性提示文字。
//   2. 新增 pickup_place_name／pickup_place_id（以及對應的 store_place_name／
//      store_place_id／store_coordinate_mode／store_coordinate_verified_at）讓搜尋到
//      的 Google Place 可以真的「自動填入」，不用店家再手動打一次地址。
//   3. Google Maps 導航網址改成優先用 place_id（更準確，能直接導到店家 Google 商家
//      頁），而不是永遠優先座標。
'use strict';

const FALLBACK_ADDRESS_TEXT = '請洽店家確認取餐地點';
const FALLBACK_STORE_NAME_TEXT = '門市';

function getSettingVal(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// fix18-10-hotfix26-F5 既有 helper：座標優先產生 Google Maps 連結；沒有座標才 fallback
// 用地址搜尋。保留原樣、原簽章不變（F5 smoke test 直接呼叫這個函式驗證），新的
// place_id／商家名稱優先序邏輯獨立成下面的 buildPickupGoogleMapsUrl()，不覆蓋這個。
function buildMapsUrl(lat, lng, address) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps?q=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return '';
}

// fix18-10-hotfix26-F7（需求文件十九）：導航用 Google Maps URL 的單一共用 helper。
// 優先序：Place ID（能直接導到 Google 商家頁，最準確）→ 商家名稱＋地址 → 地址 →
// 座標。不得「只要有座標就永遠優先座標」——因為座標常常是概略位置，商家名稱／
// Place ID 才是使用者真正想去的地方。
function buildPickupGoogleMapsUrl({ placeId, name, address, lat, lng } = {}) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (placeId) {
    const q = name || address || (hasCoords ? `${lat},${lng}` : '');
    if (!q) return '';
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  if (name && address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address}`)}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  if (hasCoords) return `https://www.google.com/maps?q=${lat},${lng}`;
  return '';
}

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

// fix18-10-hotfix26-F7：店家地址／外送起點設定的單一事實來源（新增 store_place_name／
// store_place_id／store_coordinate_mode／store_coordinate_verified_at，都是 F7 新增的
// settings key，預設值皆為空字串／'auto'）。
function resolveStoreLocationSettings(db, storeId) {
  const placeName = String(getSettingVal(db, storeId, 'store_place_name', '') || '').trim();
  const placeId   = String(getSettingVal(db, storeId, 'store_place_id', '') || '').trim();
  const address   = String(getSettingVal(db, storeId, 'store_address', '') || '').trim();
  const lat = parseFloat(getSettingVal(db, storeId, 'store_lat', ''));
  const lng = parseFloat(getSettingVal(db, storeId, 'store_lng', ''));
  const coordinateModeRaw = String(getSettingVal(db, storeId, 'store_coordinate_mode', 'auto') || 'auto');
  const verifiedAt = String(getSettingVal(db, storeId, 'store_coordinate_verified_at', '') || '');
  return {
    place_name: placeName,
    place_id: placeId,
    address,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    coordinate_mode: coordinateModeRaw === 'manual' ? 'manual' : 'auto',
    verified_at: verifiedAt,
  };
}

// fix18-10-hotfix26-F5/F7：後台「取餐地點」設定的單一事實來源。
// 讀取「當下」（不是訂單建立當時）的取餐地點設定，套用文件規格的優先序：
//
//   地址／商家名稱：
//     same_as_store=true  → store 的商家名稱／地址／座標
//     same_as_store=false 且已設定 pickup_place_name 或 pickup_address
//                         → 用 pickup 自己的商家名稱／地址（座標優先 pickup，沒有才 fallback store）
//     same_as_store=false 但「只有座標、沒有商家名稱也沒有地址文字」
//                         → coords_only=true，address 回傳空字串（不 fallback 店家地址！
//                           這是 F7 修的根因問題1——避免顧客誤以為要去店家取餐）
//     same_as_store=false 且什麼都沒設定（座標/名稱/地址都空）
//                         → 尚未完成設定的過渡狀態，才 fallback 店家資料
//
//   取餐說明：只有「獨立取餐地址／商家」時才有意義；跟店家地址相同時不顯示。
//
// 相容性處理（F5 既有，維持不變）：pickup_address_same_as_store 若從未寫入過，
// 用「是否已有 pickup_address」推斷預設值，避免舊店家設定被靜默忽略。
function resolvePickupSettings(db, storeId) {
  const sameAsStore = resolveSameAsStoreFlag(db, storeId);
  const store = resolveStoreLocationSettings(db, storeId);
  const storeName = String(getSettingVal(db, storeId, 'shop_name', '') || '').trim();

  const pickupPlaceName = String(getSettingVal(db, storeId, 'pickup_place_name', '') || '').trim();
  const pickupPlaceId   = String(getSettingVal(db, storeId, 'pickup_place_id', '') || '').trim();
  const pickupAddr = String(getSettingVal(db, storeId, 'pickup_address', '') || '').trim();
  const pickupNote = String(getSettingVal(db, storeId, 'pickup_address_note', '') || '').trim();
  const pickupLatRaw = parseFloat(getSettingVal(db, storeId, 'pickup_lat', ''));
  const pickupLngRaw = parseFloat(getSettingVal(db, storeId, 'pickup_lng', ''));
  const hasIndependentCoords = Number.isFinite(pickupLatRaw) && Number.isFinite(pickupLngRaw);
  const coordinateModeRaw = String(getSettingVal(db, storeId, 'pickup_coordinate_mode', 'auto') || 'auto');
  const verifiedAt = String(getSettingVal(db, storeId, 'pickup_coordinate_verified_at', '') || '');
  const syncDeliveryOriginRaw = String(getSettingVal(db, storeId, 'pickup_sync_delivery_origin', '0') || '0');

  let address, placeName, placeId, lat, lng, coordsOnly;
  if (sameAsStore) {
    address = store.address;
    placeName = store.place_name;
    placeId = store.place_id;
    lat = store.lat; lng = store.lng;
    coordsOnly = false;
  } else {
    const hasNameOrAddress = !!(pickupPlaceName || pickupAddr);
    if (hasNameOrAddress) {
      address = pickupAddr || pickupPlaceName;
      placeName = pickupPlaceName;
      placeId = pickupPlaceId;
      lat = hasIndependentCoords ? pickupLatRaw : store.lat;
      lng = hasIndependentCoords ? pickupLngRaw : store.lng;
      coordsOnly = false;
    } else if (hasIndependentCoords) {
      // fix18-10-hotfix26-F7（問題1修正）：獨立取餐地點只設定了座標、完全沒有商家
      // 名稱或地址文字——不得 fallback 顯示店家地址。
      address = '';
      placeName = '';
      placeId = pickupPlaceId;
      lat = pickupLatRaw; lng = pickupLngRaw;
      coordsOnly = true;
    } else {
      // 完全沒有設定任何獨立資訊（same_as_store=false 但還沒填任何東西）——
      // 這是尚未完成設定的過渡狀態，沒有更好的資訊可顯示，才 fallback 店家資料。
      address = store.address;
      placeName = store.place_name;
      placeId = store.place_id;
      lat = store.lat; lng = store.lng;
      coordsOnly = false;
    }
  }
  const addressNote = (!sameAsStore && (pickupAddr || pickupPlaceName)) ? pickupNote : '';

  return {
    same_as_store: sameAsStore,
    store_name: storeName,
    place_name: placeName || '',
    place_id: placeId || '',
    address,
    address_note: addressNote,
    lat, lng,
    coords_only: coordsOnly,
    coordinate_mode: coordinateModeRaw === 'manual' ? 'manual' : 'auto',
    verified_at: verifiedAt,
    sync_delivery_origin: syncDeliveryOriginRaw === '1' || syncDeliveryOriginRaw.toLowerCase() === 'true',
  };
}

// 建立訂單當下呼叫：由後端依 store_id 重新讀取店家設定（含 F5/F7 取餐地點設定），
// 產生要寫入 orders 的 snapshot 值。重要：不信任前端傳入的商家名稱／Place ID／
// 地址／座標／說明，一律由這裡（伺服器端）依 resolvePickupSettings() 重新解析。
// 只有外帶（含預購外帶）才需要寫入；外送訂單呼叫端不應呼叫本函式。
function buildPickupSnapshot(db, storeId) {
  const cur = resolvePickupSettings(db, storeId);
  return {
    pickup_store_name_snapshot:      cur.store_name || '',
    pickup_place_name_snapshot:      cur.place_name || '',
    pickup_place_id_snapshot:        cur.place_id || '',
    pickup_address_snapshot:         cur.address || '',
    pickup_address_note_snapshot:    cur.address_note || '',
    pickup_lat_snapshot:             cur.lat != null ? String(cur.lat) : '',
    pickup_lng_snapshot:             cur.lng != null ? String(cur.lng) : '',
  };
}

// 顯示用：訂單完成頁／查詢訂單／我的訂單／（未來若有）LINE 通知共用。
// order 需含 order_mode 及 pickup_*_snapshot 欄位（舊訂單可能是 NULL 或空字串）。
// 規則：外送訂單一律回傳 null；外帶訂單優先使用 order 自己的 snapshot，沒有
// snapshot 時（舊訂單，F4/F5 之前建立）才 fallback 顯示「目前」取餐地點設定。
function resolvePickupLocation(order, db, storeId) {
  if (!order || order.order_mode === 'delivery') return null;

  const snapName = String(order.pickup_store_name_snapshot || '').trim();
  const snapPlaceName = String(order.pickup_place_name_snapshot || '').trim();
  const snapPlaceId   = String(order.pickup_place_id_snapshot || '').trim();
  const snapAddr = String(order.pickup_address_snapshot || '').trim();
  const snapNote = String(order.pickup_address_note_snapshot || '').trim();
  const snapLat  = parseFloat(order.pickup_lat_snapshot);
  const snapLng  = parseFloat(order.pickup_lng_snapshot);
  const snapHasCoords = Number.isFinite(snapLat) && Number.isFinite(snapLng);
  const hasSnapshot = !!(snapName || snapAddr || snapPlaceName || snapPlaceId || snapHasCoords);

  let storeName, placeName, placeId, address, addressNote, lat, lng, coordsOnly;
  if (hasSnapshot) {
    storeName = snapName;
    const hasNameOrAddress = !!(snapPlaceName || snapAddr);
    if (hasNameOrAddress) {
      placeName = snapPlaceName;
      placeId = snapPlaceId;
      address = snapAddr || snapPlaceName;
      coordsOnly = false;
    } else if (snapHasCoords) {
      // 舊訂單/新訂單 snapshot 只有座標、沒有商家名稱或地址文字（F7 問題1情境）。
      placeName = ''; placeId = snapPlaceId; address = ''; coordsOnly = true;
    } else {
      placeName = ''; placeId = ''; address = ''; coordsOnly = false;
    }
    addressNote = snapNote;
    lat = snapHasCoords ? snapLat : null;
    lng = snapHasCoords ? snapLng : null;
  } else {
    // 舊訂單沒有快照時，只能顯示目前取餐地點設定（fix18-10-hotfix26-F7：向下相容，
    // resolvePickupSettings() 已經內建同一套 coords_only 規則）。
    const cur = resolvePickupSettings(db, storeId);
    storeName = cur.store_name;
    placeName = cur.place_name;
    placeId = cur.place_id;
    address = cur.address;
    addressNote = cur.address_note;
    lat = cur.lat; lng = cur.lng;
    coordsOnly = cur.coords_only;
  }

  const hasAddress = !!address;
  return {
    store_name: storeName || FALLBACK_STORE_NAME_TEXT,
    place_name: placeName || '',
    place_id: placeId || '',
    address: hasAddress ? address : (coordsOnly ? '' : FALLBACK_ADDRESS_TEXT),
    address_note: (hasAddress || coordsOnly) ? (addressNote || '') : '',
    has_address: hasAddress,
    coords_only: coordsOnly && !hasAddress,
    lat, lng,
    maps_url: buildPickupGoogleMapsUrl({ placeId, name: placeName, address: hasAddress ? address : '', lat, lng }),
    from_snapshot: hasSnapshot,
  };
}

module.exports = {
  buildPickupSnapshot,
  resolvePickupLocation,
  resolvePickupSettings,
  resolveSameAsStoreFlag,
  resolveStoreLocationSettings,
  buildPickupGoogleMapsUrl,
  // 保留舊名稱作為 resolvePickupSettings 的別名，避免其他呼叫端（若有）因改名而壞掉。
  readCurrentStorePickup: resolvePickupSettings,
  buildMapsUrl,
  FALLBACK_ADDRESS_TEXT,
  FALLBACK_STORE_NAME_TEXT,
};
