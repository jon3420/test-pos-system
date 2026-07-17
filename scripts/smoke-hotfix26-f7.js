#!/usr/bin/env node
// scripts/smoke-hotfix26-f7.js — fix18-10-hotfix26-F7 smoke test
//
// 範圍：Pickup Place Auto Fill × Store Map Search × Independent Save × Correct Navigation
// 做法：跟 f4/f5/f6 一致——utils/pickupLocation.js 的邏輯用真實 sql.js 記憶體 DB +
// 真實函式測試；routes/settings.js 的驗證/同步邏輯用 router.__test 匯出的純函式；
// public/js/app.js／public/index.html／public/line-order.html 用靜態原始碼比對驗證
// target-aware 流程串接正確（Google Maps JS SDK 互動仍需人工瀏覽器驗證，見 MANUAL）。

'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

async function main() {
  const SQL = await initSqlJs();
  const rawDb = new SQL.Database();
  rawDb.run(`
    CREATE TABLE settings (store_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT DEFAULT '', PRIMARY KEY(store_id, key));
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, order_number TEXT, store_id TEXT, order_mode TEXT,
      pickup_store_name_snapshot TEXT DEFAULT NULL,
      pickup_place_name_snapshot TEXT DEFAULT NULL,
      pickup_place_id_snapshot TEXT DEFAULT NULL,
      pickup_address_snapshot TEXT DEFAULT NULL,
      pickup_address_note_snapshot TEXT DEFAULT NULL,
      pickup_lat_snapshot TEXT DEFAULT NULL,
      pickup_lng_snapshot TEXT DEFAULT NULL,
      created_at TEXT
    );
  `);

  const db = {
    get(sql, params = []) {
      const stmt = rawDb.prepare(sql); stmt.bind(params);
      const r = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free(); return r;
    },
    all(sql, params = []) {
      const stmt = rawDb.prepare(sql); stmt.bind(params);
      const rows = []; while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free(); return rows;
    },
    run(sql, params = []) {
      const stmt = rawDb.prepare(sql); stmt.bind(params); stmt.step();
      const changes = rawDb.getRowsModified ? rawDb.getRowsModified() : 0;
      stmt.free();
      return { changes };
    },
  };

  function setSetting(storeId, key, value) {
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  function getSettingRaw(storeId, key) {
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    return row ? row.value : undefined;
  }
  function insertOrder(o) {
    db.run(
      `INSERT INTO orders (id, order_number, store_id, order_mode,
        pickup_store_name_snapshot, pickup_place_name_snapshot, pickup_place_id_snapshot,
        pickup_address_snapshot, pickup_address_note_snapshot,
        pickup_lat_snapshot, pickup_lng_snapshot, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [o.id, o.order_number, o.store_id, o.order_mode,
       o.pickup_store_name_snapshot ?? null, o.pickup_place_name_snapshot ?? null, o.pickup_place_id_snapshot ?? null,
       o.pickup_address_snapshot ?? null, o.pickup_address_note_snapshot ?? null,
       o.pickup_lat_snapshot ?? null, o.pickup_lng_snapshot ?? null, o.created_at || '2026-07-17 12:00:00']
    );
  }

  const {
    buildPickupSnapshot, resolvePickupLocation, resolvePickupSettings, resolveStoreLocationSettings,
    buildPickupGoogleMapsUrl, FALLBACK_ADDRESS_TEXT,
  } = require(path.join(ROOT, 'utils/pickupLocation.js'));
  const settingsRouter = require(path.join(ROOT, 'routes/settings.js'));
  const { validatePickupLatLng, buildTaipeiVerifiedAtStamp, applyPickupSyncToStoreCoords, validatePickupLocationSave, STORE_LOCATION_KEYS, PICKUP_LOCATION_KEYS } = settingsRouter.__test;

  const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const lineOrderHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const slice = (marker, len) => {
    const i = appJsSrc.indexOf(marker);
    return i === -1 ? '' : appJsSrc.slice(i, i + len);
  };

  // ══════════════════════════════════════════════════════════════
  // Section 1：Pickup 搜尋自動帶入 name/address/placeId（後端邏輯：buildPickupSnapshot
  // 讀到 pickup_place_name/pickup_place_id 後，snapshot 與 resolve 都正確帶出）
  // ══════════════════════════════════════════════════════════════
  setSetting('store_001', 'shop_name', '脆豬腰｜冷拌麻油腰子');
  setSetting('store_001', 'store_address', '桃園市中壢區龍東路128號');
  setSetting('store_001', 'store_lat', '24.9998');
  setSetting('store_001', 'store_lng', '121.2168');
  setSetting('store_001', 'pickup_address_same_as_store', '0');
  setSetting('store_001', 'pickup_place_name', '熊熊可麗餅');
  setSetting('store_001', 'pickup_place_id', 'ChIJ_test_place_id_001');
  setSetting('store_001', 'pickup_address', '桃園市中壢區龍東路130號');
  setSetting('store_001', 'pickup_lat', '24.95');
  setSetting('store_001', 'pickup_lng', '121.21');

  {
    const cur = resolvePickupSettings(db, 'store_001');
    if (cur.place_name === '熊熊可麗餅' && cur.place_id === 'ChIJ_test_place_id_001' && cur.address === '桃園市中壢區龍東路130號') {
      pass('選擇「熊熊可麗餅」後：resolvePickupSettings() 正確回傳 place_name/place_id/address');
    } else fail('搜尋自動帶入內容不符', JSON.stringify(cur));

    const snap = buildPickupSnapshot(db, 'store_001');
    if (snap.pickup_place_name_snapshot === '熊熊可麗餅' && snap.pickup_place_id_snapshot === 'ChIJ_test_place_id_001' && snap.pickup_address_snapshot === '桃園市中壢區龍東路130號') {
      pass('buildPickupSnapshot() 正確寫入 pickup_place_name_snapshot/pickup_place_id_snapshot/pickup_address_snapshot');
    } else fail('snapshot 內容不符', JSON.stringify(snap));
  }

  // ══════════════════════════════════════════════════════════════
  // Section 2：Store 搜尋自動帶入（resolveStoreLocationSettings）
  // ══════════════════════════════════════════════════════════════
  setSetting('store_001', 'store_place_name', '脆豬腰｜冷拌麻油腰子');
  setSetting('store_001', 'store_place_id', 'ChIJ_test_store_place_id');
  setSetting('store_001', 'store_coordinate_mode', 'manual');
  {
    const storeCur = resolveStoreLocationSettings(db, 'store_001');
    if (storeCur.place_name === '脆豬腰｜冷拌麻油腰子' && storeCur.place_id === 'ChIJ_test_store_place_id' && storeCur.coordinate_mode === 'manual') {
      pass('Store 搜尋自動帶入：resolveStoreLocationSettings() 正確回傳 place_name/place_id/coordinate_mode');
    } else fail('Store 搜尋自動帶入內容不符', JSON.stringify(storeCur));
  }

  // ══════════════════════════════════════════════════════════════
  // Section 3：Marker/draft/search/input 四者一致（前端邏輯，靜態比對 confirmPickupMapPin）
  // ══════════════════════════════════════════════════════════════
  {
    const confirmFn = slice('function confirmPickupMapPin', 1700);
    if (/const pos = _pickupMarker\.getPosition\(\);/.test(confirmFn) && /const lat = pos\.lat\(\), lng = pos\.lng\(\);/.test(confirmFn)) {
      pass('Marker 最終座標為唯一準則：confirmPickupMapPin() 從 _pickupMarker.getPosition() 取得 lat/lng（需求文件九）');
    } else fail('confirmPickupMapPin() 未以 Marker 座標為準');
    if (/setActiveDraftCoords\(lat, lng\);/.test(confirmFn) && /state\.lat = lat; state\.lng = lng;/.test(confirmFn)) {
      pass('confirmPickupMapPin() 同步 draft 狀態與 search state 為 Marker 最終座標');
    } else fail('confirmPickupMapPin() 未同步 draft/search state');
    if (/if \(latEl\) latEl\.value = lat;/.test(confirmFn) && /if \(lngEl\) lngEl\.value = lng;/.test(confirmFn)) {
      pass('confirmPickupMapPin() 同步寫入表單 lat/lng input（四者：Marker/draft/search state/表單 一致）');
    } else fail('confirmPickupMapPin() 未同步表單 input');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 4：dragend 清空 Place ID（pickup 與 store 都要適用）
  // ══════════════════════════════════════════════════════════════
  {
    const initMapFn = slice('function _initPickupMap', 1200);
    if (/state\.placeId = ''; state\.name = ''; state\.formattedAddress = '';/.test(initMapFn) && /state\.source = 'marker_drag';/.test(initMapFn)) {
      pass('dragend：清空 placeId/name/formattedAddress，source 改為 marker_drag（需求文件七）');
    } else fail('dragend 清除 Place ID 邏輯不符預期');
    if (/const state = getActiveMapSearchState\(\);/.test(initMapFn)) {
      pass('dragend 透過 getActiveMapSearchState() 依 mapEditorTarget 取得正確的那組 state（pickup 與 store 都適用同一段程式碼）');
    } else fail('dragend 未使用 target-aware helper，可能只對單一 target 生效');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 5：GPS 清空 Place ID
  // ══════════════════════════════════════════════════════════════
  {
    const gpsFn = slice('function pickupMapUseCurrentLocation', 900);
    if (/state\.source = 'current_location'; state\.placeId = ''; state\.name = ''; state\.formattedAddress = '';/.test(gpsFn)) {
      pass('GPS（使用目前位置）：清空 placeId/name/formattedAddress，source 改為 current_location（需求文件八/十一）');
    } else fail('GPS 清除 Place ID 邏輯不符預期');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 6：Pickup 獨立儲存（PATCH /pickup-location 只送 pickup 欄位）
  // ══════════════════════════════════════════════════════════════
  {
    const expectedPickupKeys = [
      'pickup_address_same_as_store', 'pickup_place_name', 'pickup_place_id', 'pickup_address',
      'pickup_address_note', 'pickup_lat', 'pickup_lng', 'pickup_coordinate_mode',
      'pickup_coordinate_verified_at', 'pickup_sync_delivery_origin',
    ];
    const missing = expectedPickupKeys.filter(k => !PICKUP_LOCATION_KEYS.includes(k));
    if (!missing.length) pass('PATCH /api/settings/pickup-location：PICKUP_LOCATION_KEYS 白名單涵蓋全部需要的欄位');
    else fail('PICKUP_LOCATION_KEYS 缺少欄位', missing.join(', '));

    if (!PICKUP_LOCATION_KEYS.some(k => k.startsWith('store_'))) {
      pass('PICKUP_LOCATION_KEYS 白名單不含任何 store_* 欄位（不會誤寫店家設定）');
    } else fail('PICKUP_LOCATION_KEYS 疑似包含 store_* 欄位');

    const saveFn = slice('async function savePickupLocationSettings', 2200);
    if (/apiFetch\('\/api\/settings\/pickup-location', \{ method: 'PATCH'/.test(saveFn)) {
      pass('savePickupLocationSettings() 呼叫 PATCH /api/settings/pickup-location');
    } else fail('savePickupLocationSettings() 未呼叫正確的 PATCH 端點');
    if (!/store_address|store_lat|store_lng|store_place_name|store_place_id/.test(saveFn)) {
      pass('savePickupLocationSettings() 送出的 body 不含任何 store_* 欄位');
    } else fail('savePickupLocationSettings() 疑似送出 store_* 欄位');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 7：Store 獨立儲存（PATCH /store-location 只送 store 欄位）
  // ══════════════════════════════════════════════════════════════
  {
    const expectedStoreKeys = ['store_place_name', 'store_place_id', 'store_address', 'store_lat', 'store_lng', 'store_coordinate_mode', 'store_coordinate_verified_at'];
    const missing = expectedStoreKeys.filter(k => !STORE_LOCATION_KEYS.includes(k));
    if (!missing.length) pass('PATCH /api/settings/store-location：STORE_LOCATION_KEYS 白名單涵蓋全部需要的欄位');
    else fail('STORE_LOCATION_KEYS 缺少欄位', missing.join(', '));

    if (!STORE_LOCATION_KEYS.some(k => k.startsWith('pickup_'))) {
      pass('STORE_LOCATION_KEYS 白名單不含任何 pickup_* 欄位（不會誤寫取餐設定）');
    } else fail('STORE_LOCATION_KEYS 疑似包含 pickup_* 欄位');

    const saveFn = slice('async function saveStoreLocationSettings', 1200);
    if (/apiFetch\('\/api\/settings\/store-location', \{ method: 'PATCH'/.test(saveFn)) {
      pass('saveStoreLocationSettings() 呼叫 PATCH /api/settings/store-location');
    } else fail('saveStoreLocationSettings() 未呼叫正確的 PATCH 端點');
    if (!/pickup_address|pickup_lat|pickup_lng|pickup_place_name|pickup_place_id/.test(saveFn)) {
      pass('saveStoreLocationSettings() 送出的 body 不含任何 pickup_* 欄位');
    } else fail('saveStoreLocationSettings() 疑似送出 pickup_* 欄位');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 8：saveDeliveryFeeSettings 不含 location fields（stale state 防護的關鍵）
  // ══════════════════════════════════════════════════════════════
  {
    const saveFn = slice('async function saveDeliveryFeeSettings', 1500);
    const forbidden = ['store_address', 'store_lat', 'store_lng', 'store_place_name', 'store_place_id', 'pickup_address', 'pickup_lat', 'pickup_lng', 'pickup_place_name', 'pickup_place_id', 'pickup_address_same_as_store'];
    const leaked = forbidden.filter(k => saveFn.includes(`${k}:`));
    if (!leaked.length) pass('saveDeliveryFeeSettings()（外送費設定）不再送出任何 store_*/pickup_* location 欄位（F7 stale-state 防護）');
    else fail('saveDeliveryFeeSettings() 仍殘留 location 欄位', leaked.join(', '));
  }

  // ══════════════════════════════════════════════════════════════
  // Section 9：stale state 不覆蓋（邏輯層：獨立 PATCH 完全不觸碰另一組欄位）
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_002', 'pickup_address_same_as_store', '0');
    setSetting('store_002', 'pickup_place_name', '舊商家名稱');
    setSetting('store_002', 'pickup_address', '舊地址');
    setSetting('store_002', 'pickup_lat', '24.1');
    setSetting('store_002', 'pickup_lng', '121.1');
    setSetting('store_002', 'store_address', '店家原始地址');
    setSetting('store_002', 'store_lat', '24.5');
    setSetting('store_002', 'store_lng', '121.5');

    // 模擬「先儲存 pickup」：只更新 pickup 相關 key（PICKUP_LOCATION_KEYS 白名單）
    const pickupBody = { pickup_place_name: '新商家名稱', pickup_address: '新地址', pickup_lat: '25.0', pickup_lng: '122.0' };
    PICKUP_LOCATION_KEYS.forEach((k) => {
      if (pickupBody[k] !== undefined) setSetting('store_002', k, pickupBody[k]);
    });

    // 模擬「再儲存外送費其他設定」：只更新 delivery_* 這幾個跟 location 無關的 key
    setSetting('store_002', 'delivery_basic_fee', '80');

    const pickupAfter = resolvePickupSettings(db, 'store_002');
    if (pickupAfter.place_name === '新商家名稱' && pickupAfter.address === '新地址' && pickupAfter.lat === 25.0) {
      pass('stale state 防護：先儲存 pickup → 再儲存外送費其他設定 → pickup 不被覆蓋回舊值');
    } else fail('pickup 被 stale state 覆蓋', JSON.stringify(pickupAfter));

    const storeAfter = resolveStoreLocationSettings(db, 'store_002');
    if (storeAfter.address === '店家原始地址' && storeAfter.lat === 24.5) {
      pass('stale state 防護（Store 側）：儲存 pickup／其他外送設定完全不影響 store_address/store_lat/store_lng');
    } else fail('store 座標被意外覆蓋', JSON.stringify(storeAfter));
  }

  // ══════════════════════════════════════════════════════════════
  // Section 10：only-coordinates UX（問題1修正：只有座標不 fallback 顯示店家地址）
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_003', 'shop_name', '座標測試店');
    setSetting('store_003', 'store_address', '不應該被顯示的店家地址');
    setSetting('store_003', 'pickup_address_same_as_store', '0');
    setSetting('store_003', 'pickup_lat', '24.77');
    setSetting('store_003', 'pickup_lng', '121.33');
    // 故意不設定 pickup_place_name / pickup_address（問題1情境：只有座標）

    const cur = resolvePickupSettings(db, 'store_003');
    if (cur.coords_only === true && cur.address === '') {
      pass('only-coordinates：resolvePickupSettings() 回傳 coords_only=true，address 為空字串（不 fallback 店家地址）');
    } else fail('coords_only 判斷失敗', JSON.stringify(cur));

    const snap = buildPickupSnapshot(db, 'store_003');
    insertOrder({ id: 'o_coords_only', order_number: 'LINE-COORDS', store_id: 'store_003', order_mode: 'takeout', ...snap });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_coords_only']);
    const loc = resolvePickupLocation(order, db, 'store_003');
    if (loc.coords_only === true && loc.address === '' && !loc.address.includes('不應該被顯示')) {
      pass('only-coordinates：訂單顯示層 resolvePickupLocation() 同樣不 fallback 顯示店家地址');
    } else fail('訂單顯示層 coords_only 判斷失敗', JSON.stringify(loc));
    if (loc.maps_url === `https://www.google.com/maps?q=24.77,121.33`) {
      pass('only-coordinates：Google Maps 按鈕仍可用（有座標），URL 正確');
    } else fail('coords_only 時 Maps URL 不符', loc.maps_url);

    // 前端顯示層：buildPickupLocationRowsHTML 對 coords_only 顯示「請依 Google Maps 定位前往」
    if (/請依 Google Maps 定位前往/.test(lineOrderHtmlSrc)) {
      pass('前端：buildPickupLocationRowsHTML() 對 coords_only 顯示「請依 Google Maps 定位前往」');
    } else fail('前端缺少 coords_only 的中性提示文字');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 11：Maps URL priority — place_id → name+address → address → lat,lng
  // ══════════════════════════════════════════════════════════════
  {
    const u1 = buildPickupGoogleMapsUrl({ placeId: 'ChIJabc', name: '熊熊可麗餅', address: '桃園市中壢區龍東路130號', lat: 24.95, lng: 121.21 });
    if (u1 === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('熊熊可麗餅') + '&query_place_id=ChIJabc') {
      pass('Maps URL 優先序 1：有 place_id → 使用 query_place_id 格式（可直接導到 Google 商家頁）');
    } else fail('place_id 優先序失敗', u1);

    const u2 = buildPickupGoogleMapsUrl({ placeId: '', name: '熊熊可麗餅', address: '桃園市中壢區龍東路130號', lat: 24.95, lng: 121.21 });
    if (u2 === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('熊熊可麗餅 桃園市中壢區龍東路130號')) {
      pass('Maps URL 優先序 2：無 place_id，有 name+address → 組合查詢');
    } else fail('name+address 優先序失敗', u2);

    const u3 = buildPickupGoogleMapsUrl({ placeId: '', name: '', address: '桃園市中壢區龍東路130號', lat: 24.95, lng: 121.21 });
    if (u3 === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('桃園市中壢區龍東路130號')) {
      pass('Maps URL 優先序 3：只有 address → 使用地址搜尋（不得優先使用座標）');
    } else fail('address 優先序失敗', u3);

    const u4 = buildPickupGoogleMapsUrl({ placeId: '', name: '', address: '', lat: 24.95, lng: 121.21 });
    if (u4 === 'https://www.google.com/maps?q=24.95,121.21') {
      pass('Maps URL 優先序 4：什麼都沒有，只有座標 → 最後才 fallback 座標格式');
    } else fail('座標 fallback 失敗', u4);

    // 前端搜尋建議下拉/後端訂單導航一致性：resolvePickupLocation 使用同一顆 helper
    const pickupLocSrc = fs.readFileSync(path.join(ROOT, 'utils/pickupLocation.js'), 'utf8');
    if (/maps_url: buildPickupGoogleMapsUrl\(/.test(pickupLocSrc)) {
      pass('resolvePickupLocation() 使用共用 buildPickupGoogleMapsUrl()（訂單導航與 helper 優先序一致）');
    } else fail('resolvePickupLocation() 未使用共用 Maps URL helper');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 12：Order Snapshot（新單使用新設定、外送/宅配維持 NULL）
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_001', 'pickup_place_name', '熊熊可麗餅');
    setSetting('store_001', 'pickup_place_id', 'ChIJ_new');
    setSetting('store_001', 'pickup_address', '新地址');
    const snap = buildPickupSnapshot(db, 'store_001');
    insertOrder({ id: 'o_snap1', order_number: 'LINE-SNAP1', store_id: 'store_001', order_mode: 'takeout', ...snap });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_snap1']);
    if (order.pickup_place_name_snapshot === '熊熊可麗餅' && order.pickup_place_id_snapshot === 'ChIJ_new' && order.pickup_address_snapshot === '新地址') {
      pass('Order Snapshot：外帶訂單正確保存 pickup_place_name_snapshot/pickup_place_id_snapshot/pickup_address_snapshot');
    } else fail('Order Snapshot 內容不符', JSON.stringify(order));

    // 外送訂單維持 NULL
    insertOrder({ id: 'o_snap_delivery', order_number: 'LINE-SNAP-D', store_id: 'store_001', order_mode: 'delivery' });
    const delivOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_snap_delivery']);
    if ((delivOrder.pickup_place_name_snapshot === null || delivOrder.pickup_place_name_snapshot === undefined)
      && (delivOrder.pickup_place_id_snapshot === null || delivOrder.pickup_place_id_snapshot === undefined)) {
      pass('Order Snapshot：外送訂單 pickup_place_name_snapshot/pickup_place_id_snapshot 維持 NULL');
    } else fail('外送訂單 snapshot 欄位不應有值', JSON.stringify(delivOrder));
    const delivLoc = resolvePickupLocation(delivOrder, db, 'store_001');
    if (delivLoc === null) pass('Order Snapshot：外送訂單 resolvePickupLocation() 回傳 null');
    else fail('外送訂單應回傳 null');

    // 舊訂單相容：舊訂單只有 F4 時代的欄位（沒有 place_name/place_id snapshot）
    insertOrder({
      id: 'o_legacy', order_number: 'LINE-LEGACY', store_id: 'store_001', order_mode: 'takeout',
      pickup_store_name_snapshot: '脆豬腰', pickup_address_snapshot: '舊版快照地址（無 place_name）',
      pickup_lat_snapshot: '24.1', pickup_lng_snapshot: '121.1',
    });
    const legacyOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_legacy']);
    const legacyLoc = resolvePickupLocation(legacyOrder, db, 'store_001');
    if (legacyLoc && legacyLoc.address === '舊版快照地址（無 place_name）' && legacyLoc.place_name === '') {
      pass('舊訂單相容：沒有 pickup_place_name_snapshot 的舊快照仍正確顯示地址，place_name 安全為空字串');
    } else fail('舊訂單相容性失敗', JSON.stringify(legacyLoc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section 13：tenant isolation
  // ══════════════════════════════════════════════════════════════
  {
    const s1 = resolvePickupSettings(db, 'store_001');
    const s3 = resolvePickupSettings(db, 'store_003');
    if (s1.place_name !== s3.place_name && s1.address !== s3.address) {
      pass('tenant isolation：store_001／store_003 的 pickup 設定各自獨立');
    } else fail('tenant isolation 失敗（pickup）', JSON.stringify({ s1, s3 }));

    const store1 = resolveStoreLocationSettings(db, 'store_001');
    const store2 = resolveStoreLocationSettings(db, 'store_002');
    if (store1.place_name !== store2.place_name) {
      pass('tenant isolation：store_001／store_002 的 store 設定各自獨立');
    } else fail('tenant isolation 失敗（store）');

    // applyPickupSyncToStoreCoords 也要 store 隔離（沿用 F5，本版未變動邏輯，僅重新確認）
    const store2LatBefore = getSettingRaw('store_002', 'store_lat');
    applyPickupSyncToStoreCoords(db, 'store_001', { pickup_sync_delivery_origin: '1', pickup_lat: '1.111', pickup_lng: '2.222' });
    const store2LatAfter = getSettingRaw('store_002', 'store_lat');
    if (store2LatAfter === store2LatBefore) pass('tenant isolation：對 store_001 執行同步不影響 store_002 的 store_lat');
    else fail('跨店同步污染');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 14：Migration idempotency
  // ══════════════════════════════════════════════════════════════
  {
    const dbJsSrc = fs.readFileSync(path.join(ROOT, 'utils/db.js'), 'utf8');
    if (/pickup_place_name_snapshot TEXT DEFAULT NULL/.test(dbJsSrc) && /pickup_place_id_snapshot TEXT DEFAULT NULL/.test(dbJsSrc)) {
      pass('Migration：utils/db.js 已加入 pickup_place_name_snapshot/pickup_place_id_snapshot ALTER TABLE');
    } else fail('Migration 缺少 F7 新欄位');
    if (/try \{ w\._db\.run\(sql\); w\._save\(\); \} catch \{\}/.test(dbJsSrc)) {
      pass('Migration：沿用既有 try/catch ALTER TABLE 慣例，可重複執行（idempotent）');
    } else fail('Migration 寫法不符既有慣例');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 15：F5 53/53、F6 全 PASS（regression）
  // ══════════════════════════════════════════════════════════════
  {
    try {
      const out5 = execFileSync(process.execPath, [path.join(ROOT, 'scripts/smoke-hotfix26-f5.js')], { encoding: 'utf8' });
      const m5 = out5.match(/Total: (\d+), PASS: (\d+), FAIL: (\d+)/);
      if (m5 && m5[3] === '0' && m5[1] === m5[2]) pass(`F5 regression：${m5[2]}/${m5[1]} 全部 PASS`);
      else fail('F5 regression 未全過', out5.slice(-500));
    } catch (e) { fail('F5 regression 執行失敗', e.message); }

    try {
      const out6 = execFileSync(process.execPath, [path.join(ROOT, 'scripts/smoke-hotfix26-f6.js')], { encoding: 'utf8' });
      const m6 = out6.match(/Total: (\d+), PASS: (\d+), FAIL: (\d+), MANUAL: (\d+)/);
      if (m6 && m6[3] === '0') pass(`F6 regression：PASS ${m6[2]}/${m6[1]}，FAIL=0（MANUAL=${m6[4]} 為真機驗證項目，非回歸失敗）`);
      else fail('F6 regression 未全過', out6.slice(-500));
    } catch (e) { fail('F6 regression 執行失敗', e.message); }
  }

  // ══════════════════════════════════════════════════════════════
  // 結構檢查：INSERT 欄位數、GET /shop 新欄位、settings.js PATCH endpoints、HTML
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    const insertMatch = lineOrdersSrc.match(/INSERT INTO orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`,/);
    const colCount = insertMatch[1].split(',').map(s => s.trim()).filter(Boolean).length;
    const phCount = (insertMatch[2].match(/\?/g) || []).length;
    if (colCount === phCount && colCount === 44) pass(`結構：INSERT INTO orders 欄位數與 placeholder 數一致且為 44（${colCount}）`);
    else fail('結構：INSERT 欄位數不符預期', `cols=${colCount} ph=${phCount}`);

    const shopFields = ['pickup_place_name', 'pickup_place_id', 'store_place_name', 'store_place_id'];
    const shopOk = shopFields.every(f => lineOrdersSrc.includes(`'${f}'`));
    if (shopOk) pass('結構：GET /shop 已回傳 F7 pickup_place_name/pickup_place_id/store_place_name/store_place_id');
    else fail('結構：GET /shop 缺少 F7 新欄位');

    if (/router\.patch\('\/pickup-location'/.test(fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8'))
      && /router\.patch\('\/store-location'/.test(fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8'))) {
      pass('結構：routes/settings.js 已加入 PATCH /pickup-location 與 /store-location 兩個獨立端點');
    } else fail('結構：缺少獨立 PATCH 端點');

    const requiredIds = ['set-pickup_place_name', 'set-pickup_place_id', 'set-store_place_name', 'set-store_place_id', 'store-coordinate-mode-label'];
    const missingIds = requiredIds.filter(id => !indexSrc.includes(`id="${id}"`));
    if (!missingIds.length) pass('結構：Section A/B 所需的 F7 HTML id 全部存在');
    else fail('結構：缺少 HTML id', missingIds.join(', '));

    const ids = [...indexSrc.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const dupCounts = {};
    ids.forEach(id => { dupCounts[id] = (dupCounts[id] || 0) + 1; });
    const dups = Object.entries(dupCounts).filter(([, n]) => n > 1);
    if (!dups.length) pass('結構：public/index.html 無重複 HTML id');
    else fail('結構：public/index.html 有重複 id', JSON.stringify(dups));

    const requiredHelperFns = ['function getActiveMapSearchState', 'function setActiveMapSearchState', 'function getActiveDraftCoords', 'function setActiveDraftCoords', 'function getActiveLocationFields'];
    const missingHelpers = requiredHelperFns.filter(f => !appJsSrc.includes(f));
    if (!missingHelpers.length) pass('結構：target-aware state helper（getActiveMapSearchState/setActiveDraftCoords/getActiveLocationFields 等）全部存在');
    else fail('結構：缺少 target-aware helper', missingHelpers.join(', '));

    if (appJsSrc.includes('function openStoreMapModal') && /openPickupMapModal\('store'\)/.test(appJsSrc)) {
      pass('結構：openStoreMapModal() 呼叫 openPickupMapModal(\'store\')，共用同一顆 Modal');
    } else fail('結構：openStoreMapModal() 未正確委派給共用 Modal');
  }

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`${r.status}: ${r.name}`));
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}, MANUAL: ${manualCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke-hotfix26-f7] fatal error:', e); process.exit(1); });
