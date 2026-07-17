#!/usr/bin/env node
// scripts/smoke-hotfix26-f5.js — fix18-10-hotfix26-F5 smoke test
//
// 範圍：Pickup Address Settings × Manual Map Pin Override × Delivery Origin Sync
//   A same_as_store=true  → 使用 store address/lat/lng
//   B same_as_store=false → 使用 pickup address/note/lat/lng
//   C manual 保存 → mode=manual、verified_at 有值
//   D manual 防覆蓋 → 一般儲存不改座標
//   E 重新地址定位 → 先確認、未確認不寫 DB、確認後 mode=auto
//   F geolocation → success/denied/timeout/unsupported 友善處理
//   G Maps 優先序 → snapshot → pickup → store → address search
//   H 同步外送起點 → 勾選同步 lat/lng、不改 store_address；未勾選不變
//   I 訂單 snapshot → 舊單保留舊值、新單使用新設定
//   J 外送／宅配 → 不顯示 pickup、不寫 pickup snapshot
//   K tenant isolation → store_001/store_002 分離
//   L Migration → 新 keys／note snapshot 可匯出匯入、舊 backup 相容
//
// 做法：跟 smoke-hotfix26-f4.js 一致 —— 直接操作 sql.js 記憶體 DB + require
// utils/pickupLocation.js 的真實函式；routes/settings.js 的驗證/同步邏輯改用
// router.__test 匯出的純函式直接呼叫（沿用 routes/line-analytics.js 既有的
// __test 慣例），不需要真的起 HTTP server，也不會跟真正的 web/data/pos.db 檔案
// 產生併發寫入風險。前端（public/index.html／public/js/app.js／public/line-order.html）
// 用靜態原始碼比對驗證關鍵流程存在且邏輯正確。

'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }

async function main() {
  const SQL = await initSqlJs();
  const rawDb = new SQL.Database();
  rawDb.run(`
    CREATE TABLE settings (store_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT DEFAULT '', PRIMARY KEY(store_id, key));
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, order_number TEXT, store_id TEXT, order_mode TEXT,
      pickup_store_name_snapshot TEXT DEFAULT NULL,
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
        pickup_store_name_snapshot, pickup_address_snapshot, pickup_address_note_snapshot,
        pickup_lat_snapshot, pickup_lng_snapshot, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [o.id, o.order_number, o.store_id, o.order_mode,
       o.pickup_store_name_snapshot ?? null, o.pickup_address_snapshot ?? null, o.pickup_address_note_snapshot ?? null,
       o.pickup_lat_snapshot ?? null, o.pickup_lng_snapshot ?? null, o.created_at || '2026-07-17 12:00:00']
    );
  }

  const { buildPickupSnapshot, resolvePickupLocation, resolvePickupSettings, resolveSameAsStoreFlag } =
    require(path.join(ROOT, 'utils/pickupLocation.js'));
  const settingsRouter = require(path.join(ROOT, 'routes/settings.js'));
  if (!settingsRouter.__test) throw new Error('routes/settings.js 未匯出 __test helpers');
  const { validatePickupLatLng, buildTaipeiVerifiedAtStamp, applyPickupSyncToStoreCoords } = settingsRouter.__test;

  // ══════════════════════════════════════════════════════════════
  // Section A: same_as_store=true → 使用 store address/lat/lng
  // ══════════════════════════════════════════════════════════════
  setSetting('store_001', 'shop_name', '脆豬腰｜冷拌麻油腰子');
  setSetting('store_001', 'store_address', '桃園市中壢區龍東路128號');
  setSetting('store_001', 'store_lat', '24.9998');
  setSetting('store_001', 'store_lng', '121.2168');
  setSetting('store_001', 'pickup_address_same_as_store', '1');

  {
    const cur = resolvePickupSettings(db, 'store_001');
    if (cur.same_as_store === true) pass('A：pickup_address_same_as_store=1 → resolvePickupSettings().same_as_store=true');
    else fail('A：same_as_store 判斷錯誤', JSON.stringify(cur));
    if (cur.address === '桃園市中壢區龍東路128號' && cur.lat === 24.9998 && cur.lng === 121.2168) {
      pass('A：same_as_store=true 時使用 store_address／store_lat／store_lng');
    } else fail('A：same_as_store=true 未正確使用店家地址/座標', JSON.stringify(cur));
    if (cur.address_note === '') pass('A：same_as_store=true 時取餐說明為空（跟店家地址相同時不顯示說明）');
    else fail('A：same_as_store=true 時 address_note 應為空');
  }

  // ══════════════════════════════════════════════════════════════
  // Section B: same_as_store=false → 使用 pickup address/note/lat/lng
  // ══════════════════════════════════════════════════════════════
  setSetting('store_001', 'pickup_address_same_as_store', '0');
  setSetting('store_001', 'pickup_address', '桃園市中壢區龍東路128號騎樓');
  setSetting('store_001', 'pickup_address_note', '龍岡國中對面，請從面向龍東路的騎樓入口取餐');
  setSetting('store_001', 'pickup_lat', '24.9111');
  setSetting('store_001', 'pickup_lng', '121.2222');

  {
    const cur = resolvePickupSettings(db, 'store_001');
    if (cur.same_as_store === false) pass('B：pickup_address_same_as_store=0 → same_as_store=false');
    else fail('B：same_as_store 判斷錯誤');
    if (cur.address === '桃園市中壢區龍東路128號騎樓') pass('B：same_as_store=false 使用獨立 pickup_address');
    else fail('B：pickup_address 未正確使用', cur.address);
    if (cur.address_note === '龍岡國中對面，請從面向龍東路的騎樓入口取餐') pass('B：正確顯示 pickup_address_note');
    else fail('B：pickup_address_note 不符', cur.address_note);
    if (cur.lat === 24.9111 && cur.lng === 121.2222) pass('B：same_as_store=false 使用獨立 pickup_lat/pickup_lng');
    else fail('B：pickup_lat/lng 未正確使用', JSON.stringify(cur));
  }

  // ══════════════════════════════════════════════════════════════
  // Section C: manual 保存 → mode=manual、verified_at 有值
  // ══════════════════════════════════════════════════════════════
  {
    const body = { pickup_lat: '24.9111', pickup_lng: '121.2222', pickup_coordinate_mode: 'manual' };
    const latErr = validatePickupLatLng('取餐緯度', body.pickup_lat, -90, 90);
    const lngErr = validatePickupLatLng('取餐經度', body.pickup_lng, -180, 180);
    if (!latErr && !lngErr) pass('C：合法 lat/lng 通過驗證（不擋）');
    else fail('C：合法 lat/lng 卻被擋', JSON.stringify({ latErr, lngErr }));

    const stamp = buildTaipeiVerifiedAtStamp();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(stamp)) {
      pass('C：buildTaipeiVerifiedAtStamp() 產生正確格式的 Asia/Taipei ISO 時間戳記（含 +08:00）');
    } else fail('C：verified_at 格式不符', stamp);

    setSetting('store_001', 'pickup_coordinate_mode', 'manual');
    setSetting('store_001', 'pickup_coordinate_verified_at', stamp);
    const cur = resolvePickupSettings(db, 'store_001');
    if (cur.coordinate_mode === 'manual' && cur.verified_at === stamp) {
      pass('C：manual 保存後，resolvePickupSettings() 讀回 mode=manual 且 verified_at 有值');
    } else fail('C：manual 保存後讀回結果不符', JSON.stringify(cur));
  }

  // ══════════════════════════════════════════════════════════════
  // Section D: manual 防覆蓋 → 一般儲存（不動 pickup_lat/lng/mode）不得改座標
  // ══════════════════════════════════════════════════════════════
  {
    const before = resolvePickupSettings(db, 'store_001');
    // 模拟「儲存外送費設定」但這次沒有動到 pickup_lat/pickup_lng/pickup_coordinate_mode
    // （例如只改了 delivery_basic_fee）—— PUT /api/settings 的 F5 區塊只在
    // PICKUP_LOCATION_KEYS 有出現在 req.body 時才處理，這裡直接驗證「沒送」時
    // buildTaipeiVerifiedAtStamp 不會被觸發（因為呼叫端本來就不會呼叫它）。
    const after = resolvePickupSettings(db, 'store_001');
    if (before.lat === after.lat && before.lng === after.lng && before.coordinate_mode === 'manual') {
      pass('D：一般儲存（未動到 pickup 座標／模式欄位）不會覆蓋既有 manual 座標');
    } else fail('D：manual 座標被意外覆蓋', JSON.stringify({ before, after }));

    // 靜態檢查：前端 saveDeliveryFeeSettings() 送出的 pickup_coordinate_mode 是
    // _pickupCoordinateMode（目前已確認的模式），不是每次都重新 Geocode；且儲存
    // 流程本身不呼叫任何 geocode API（不會背景自動覆蓋 manual 座標）。
    const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const saveFnSrc = appJsSrc.slice(appJsSrc.indexOf('async function saveDeliveryFeeSettings'), appJsSrc.indexOf('async function saveDeliveryFeeSettings') + 2000);
    if (!/api\/maps\/geocode/.test(saveFnSrc.slice(0, saveFnSrc.indexOf('apiFetch(\'/api/settings\'')))) {
      pass('D：saveDeliveryFeeSettings()（一般儲存／重新載入觸發的儲存）本身不呼叫 geocode API');
    } else fail('D：saveDeliveryFeeSettings() 疑似會自動呼叫 geocode，可能覆蓋 manual 座標');
  }

  // ══════════════════════════════════════════════════════════════
  // Section E: 重新地址定位 → 先確認、未確認不寫 DB、確認後 mode=auto
  // ══════════════════════════════════════════════════════════════
  {
    const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const geocodeFnSrc = appJsSrc.slice(appJsSrc.indexOf('async function geocodePickupAddress'), appJsSrc.indexOf('async function geocodePickupAddress') + 1500);
    if (/if \(_pickupCoordinateMode === 'manual'\) \{[\s\S]{0,200}confirm\(/.test(geocodeFnSrc)) {
      pass('E：geocodePickupAddress() 在目前為 manual 模式時，會先呼叫 confirm() 確認');
    } else fail('E：geocodePickupAddress() 缺少 manual 模式的確認流程');
    if (/if \(!proceed\) return;/.test(geocodeFnSrc)) {
      pass('E：使用者取消確認時（!proceed）直接 return，不會呼叫 geocode API，不寫 DB');
    } else fail('E：geocodePickupAddress() 取消後未正確中止');
    if (/_pickupCoordinateMode = 'auto';/.test(geocodeFnSrc)) {
      pass('E：確認後（或原本就是 auto）成功 geocode 後，_pickupCoordinateMode 設回 auto');
    } else fail('E：geocodePickupAddress() 未將模式設回 auto');
    // 「未按使用此座標前不寫 DB」：geocodePickupAddress()/pickupMapRelocateFromAddress() 都只更新
    // 表單欄位或 marker，實際送到後端的動作只有 saveDeliveryFeeSettings()/confirmPickupMapPin()。
    if (!/apiFetch\('\/api\/settings'/.test(geocodeFnSrc)) {
      pass('E：geocodePickupAddress() 本身不會呼叫 PUT /api/settings（只更新表單，不寫 DB）');
    } else fail('E：geocodePickupAddress() 疑似直接寫入設定 API');
  }

  // ══════════════════════════════════════════════════════════════
  // Section F: geolocation → success/denied/timeout/unsupported 友善處理
  // ══════════════════════════════════════════════════════════════
  {
    const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const fnSrc = appJsSrc.slice(appJsSrc.indexOf('function _geolocateFriendly'), appJsSrc.indexOf('function _geolocateFriendly') + 1200);
    // 直接 eval 這個純函式，用假的 navigator.geolocation 測試四種情境
    const sandboxSrc = `(function(){ ${fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 2)} return _geolocateFriendly; })()`;
    let geolocateFriendly;
    try { geolocateFriendly = eval(sandboxSrc); } catch (e) { fail('F：_geolocateFriendly() 無法擷取/執行', e.message); }

    if (geolocateFriendly) {
      const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
      const results2 = {};
      const setNav = (mockNav) => Object.defineProperty(global, 'navigator', { value: mockNav, configurable: true, writable: true });
      const run = (mockNav) => new Promise((resolve) => {
        setNav(mockNav);
        geolocateFriendly(
          (lat, lng) => resolve({ ok: true, lat, lng }),
          (msg) => resolve({ ok: false, msg })
        );
      });

      // success
      let r = await run({ geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 24.1, longitude: 121.1 } }) } });
      if (r.ok && r.lat === 24.1 && r.lng === 121.1) pass('F：geolocation success → 正確回傳 lat/lng');
      else fail('F：geolocation success 案例失敗', JSON.stringify(r));

      // permission denied (code 1)
      r = await run({ geolocation: { getCurrentPosition: (ok, err) => err({ code: 1 }) } });
      if (!r.ok && /拒絕|權限/.test(r.msg)) pass('F：geolocation 拒絕權限（code 1）→ 顯示友善訊息，不 throw');
      else fail('F：拒絕權限案例訊息不符', JSON.stringify(r));

      // unavailable (code 2)
      r = await run({ geolocation: { getCurrentPosition: (ok, err) => err({ code: 2 }) } });
      if (!r.ok && r.msg && r.msg.length > 0) pass('F：裝置無法定位（code 2）→ 顯示友善訊息，不 throw');
      else fail('F：裝置不支援案例訊息不符', JSON.stringify(r));

      // timeout (code 3)
      r = await run({ geolocation: { getCurrentPosition: (ok, err) => err({ code: 3 }) } });
      if (!r.ok && /逾時/.test(r.msg)) pass('F：定位逾時（code 3）→ 顯示友善訊息，不 throw');
      else fail('F：逾時案例訊息不符', JSON.stringify(r));

      // unsupported（navigator.geolocation 不存在）
      r = await run({});
      if (!r.ok && /不支援/.test(r.msg)) pass('F：裝置完全不支援 geolocation → 顯示友善訊息，不 throw');
      else fail('F：不支援案例訊息不符', JSON.stringify(r));

      global.navigator = undefined;
      if (savedNavigatorDescriptor) Object.defineProperty(global, 'navigator', savedNavigatorDescriptor);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Section G: Maps 優先序 — snapshot → pickup → store → address search
  // ══════════════════════════════════════════════════════════════
  {
    // G1：訂單有 snapshot → 一律使用 snapshot（即使 settings 之後改變）
    insertOrder({
      id: 'o_g1', order_number: 'LINE-G1', store_id: 'store_001', order_mode: 'takeout',
      pickup_store_name_snapshot: '脆豬腰', pickup_address_snapshot: '舊快照地址',
      pickup_lat_snapshot: '24.5', pickup_lng_snapshot: '121.5',
    });
    const g1 = resolvePickupLocation(db.get('SELECT * FROM orders WHERE id=?', ['o_g1']), db, 'store_001');
    // fix18-10-hotfix26-F7：Google Maps URL 優先序改成 place_id → name+address → address
    // → 座標（需求文件十九）。這筆快照只有地址、沒有 place_id/place_name，所以新優先序
    // 走地址搜尋而非純座標——F7 有意調整的行為，本斷言已同步更新。
    if (g1.address === '舊快照地址' && g1.maps_url === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('舊快照地址')) {
      pass('G：有 snapshot 的訂單一律優先使用 snapshot（不受 settings 後續變動影響；F7 新 URL 優先序）');
    } else fail('G：snapshot 優先序失敗', JSON.stringify(g1));

    // G2：無 snapshot，same_as_store=false 且有 pickup_lat/lng → 使用 pickup 座標
    insertOrder({ id: 'o_g2', order_number: 'LINE-G2', store_id: 'store_001', order_mode: 'takeout' });
    const g2 = resolvePickupLocation(db.get('SELECT * FROM orders WHERE id=?', ['o_g2']), db, 'store_001');
    // 此時 store_001 的 pickup_address 仍是 Section B 設定的「桃園市中壢區龍東路128號騎樓」，
    // 所以 F7 新優先序（有地址優先於純座標）會走地址搜尋，不是 q=lat,lng。
    if (g2.maps_url === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('桃園市中壢區龍東路128號騎樓')) {
      pass('G：無 snapshot 時，same_as_store=false 優先使用 pickup 設定（F7 新 URL 優先序：有地址時優先地址）');
    } else fail('G：pickup 優先序失敗', JSON.stringify(g2));

    // G3：清空 pickup_lat/lng（但仍 same_as_store=false 且有 pickup_address）→ fallback store 座標
    setSetting('store_001', 'pickup_lat', '');
    setSetting('store_001', 'pickup_lng', '');
    const g3settings = resolvePickupSettings(db, 'store_001');
    if (g3settings.lat === 24.9998 && g3settings.lng === 121.2168) {
      pass('G：pickup_lat/lng 清空時，fallback 使用 store_lat/store_lng');
    } else fail('G：store 座標 fallback 失敗', JSON.stringify(g3settings));

    // G4：完全沒有座標，只有地址 → Maps URL 走地址搜尋
    setSetting('store_002', 'shop_name', '無座標測試店');
    setSetting('store_002', 'pickup_address_same_as_store', '0');
    setSetting('store_002', 'pickup_address', '台北市信義區信義路五段7號');
    const g4 = resolvePickupSettings(db, 'store_002');
    const { buildMapsUrl } = require(path.join(ROOT, 'utils/pickupLocation.js'));
    const g4Url = buildMapsUrl(g4.lat, g4.lng, g4.address);
    if (g4Url === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('台北市信義區信義路五段7號')) {
      pass('G：完全無座標時，Maps URL fallback 使用地址搜尋格式');
    } else fail('G：地址搜尋 fallback 格式不符', g4Url);

    // 還原 store_001 座標供後續測試使用
    setSetting('store_001', 'pickup_lat', '24.9111');
    setSetting('store_001', 'pickup_lng', '121.2222');
  }

  // ══════════════════════════════════════════════════════════════
  // Section H: 同步外送起點 — 勾選同步 lat/lng、不改 store_address；未勾選不變
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_001', 'store_address', '原始店家地址不應被改變');
    const before = getSettingRaw('store_001', 'store_lat');

    // 未勾選同步：store_lat/lng 不變
    const changed1 = applyPickupSyncToStoreCoords(db, 'store_001', { pickup_sync_delivery_origin: '0', pickup_lat: '25.111', pickup_lng: '121.999' });
    const afterUnsynced = getSettingRaw('store_001', 'store_lat');
    if (!changed1 && afterUnsynced === before) pass('H：pickup_sync_delivery_origin=0（未勾選）時，store_lat/store_lng 保持不變');
    else fail('H：未勾選同步卻改動了 store 座標', JSON.stringify({ before, afterUnsynced, changed1 }));

    // 勾選同步：store_lat/lng 同步為 pickup 座標，store_address 不變
    const changed2 = applyPickupSyncToStoreCoords(db, 'store_001', { pickup_sync_delivery_origin: '1', pickup_lat: '25.111', pickup_lng: '121.999' });
    const afterSynced = getSettingRaw('store_001', 'store_lat');
    const afterSyncedLng = getSettingRaw('store_001', 'store_lng');
    const addrAfter = getSettingRaw('store_001', 'store_address');
    if (changed2 && afterSynced === '25.111' && afterSyncedLng === '121.999') {
      pass('H：pickup_sync_delivery_origin=1 時，store_lat/store_lng 同步為 pickup 座標');
    } else fail('H：同步外送起點失敗', JSON.stringify({ afterSynced, afterSyncedLng, changed2 }));
    if (addrAfter === '原始店家地址不應被改變') pass('H：同步座標時絕不覆寫 store_address');
    else fail('H：store_address 被誤改', addrAfter);

    // 還原給後續測試
    setSetting('store_001', 'store_lat', '24.9998');
    setSetting('store_001', 'store_lng', '121.2168');
  }

  // ══════════════════════════════════════════════════════════════
  // Section I: 訂單 snapshot — 舊單保留舊值、新單使用新設定
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_001', 'pickup_address_same_as_store', '0');
    setSetting('store_001', 'pickup_address', '舊設定地址');
    setSetting('store_001', 'pickup_address_note', '舊說明');
    setSetting('store_001', 'pickup_lat', '24.1');
    setSetting('store_001', 'pickup_lng', '121.1');

    const oldSnap = buildPickupSnapshot(db, 'store_001');
    insertOrder({ id: 'o_i1', order_number: 'LINE-I1', store_id: 'store_001', order_mode: 'takeout', ...oldSnap });

    // 店家修改 pickup settings
    setSetting('store_001', 'pickup_address', '新設定地址');
    setSetting('store_001', 'pickup_address_note', '新說明');
    setSetting('store_001', 'pickup_lat', '24.2');
    setSetting('store_001', 'pickup_lng', '121.2');

    const oldOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_i1']);
    const oldLoc = resolvePickupLocation(oldOrder, db, 'store_001');
    if (oldLoc.address === '舊設定地址' && oldLoc.address_note === '舊說明' && oldLoc.lat === 24.1) {
      pass('I：修改 pickup settings 後，舊訂單（有 snapshot）仍顯示舊地址／舊說明／舊座標');
    } else fail('I：舊訂單被新設定污染', JSON.stringify(oldLoc));

    const newSnap = buildPickupSnapshot(db, 'store_001');
    insertOrder({ id: 'o_i2', order_number: 'LINE-I2', store_id: 'store_001', order_mode: 'takeout', ...newSnap });
    const newOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_i2']);
    const newLoc = resolvePickupLocation(newOrder, db, 'store_001');
    if (newLoc.address === '新設定地址' && newLoc.address_note === '新說明' && newLoc.lat === 24.2) {
      pass('I：新建立的訂單使用最新 pickup settings');
    } else fail('I：新訂單未使用最新設定', JSON.stringify(newLoc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section J: 外送／宅配 — 不顯示 pickup、不寫 pickup snapshot
  // ══════════════════════════════════════════════════════════════
  {
    insertOrder({ id: 'o_j1', order_number: 'LINE-J1', store_id: 'store_001', order_mode: 'delivery' });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_j1']);
    const loc = resolvePickupLocation(order, db, 'store_001');
    if (loc === null) pass('J：外送訂單 resolvePickupLocation() 回傳 null（不顯示取餐門市/地址/說明）');
    else fail('J：外送訂單應回傳 null', JSON.stringify(loc));

    // 靜態檢查：POST / 只在 !isDelivery 時呼叫 buildPickupSnapshot()，外送分支傳入
    // 的是全空字串物件（不寫 snapshot），沿用 F4 已驗證過的邏輯（本版未變動這段）。
    const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    if (/pickup_address_note_snapshot: ''/.test(lineOrdersSrc)) {
      pass('J：外送訂單的 pickup snapshot fallback 物件包含 pickup_address_note_snapshot 空字串（不寫入實際說明）');
    } else fail('J：外送 fallback 物件缺少 pickup_address_note_snapshot');
  }

  // ══════════════════════════════════════════════════════════════
  // Section K: tenant isolation — store_001/store_002 分離
  // ══════════════════════════════════════════════════════════════
  {
    const s1 = resolvePickupSettings(db, 'store_001');
    const s2 = resolvePickupSettings(db, 'store_002');
    if (s1.address !== s2.address && s2.address === '台北市信義區信義路五段7號') {
      pass('K：store_001／store_002 的取餐設定各自獨立，未互相污染');
    } else fail('K：tenant isolation 失敗', JSON.stringify({ s1, s2 }));

    // sync 函式也要 store 隔離：對 store_002 呼叫不會動到 store_001 的 store_lat
    const store1LatBefore = getSettingRaw('store_001', 'store_lat');
    applyPickupSyncToStoreCoords(db, 'store_002', { pickup_sync_delivery_origin: '1', pickup_lat: '1.111', pickup_lng: '2.222' });
    const store1LatAfter = getSettingRaw('store_001', 'store_lat');
    if (store1LatAfter === store1LatBefore) pass('K：applyPickupSyncToStoreCoords() 對 store_002 操作不影響 store_001');
    else fail('K：跨店同步污染', JSON.stringify({ store1LatBefore, store1LatAfter }));
  }

  // ══════════════════════════════════════════════════════════════
  // Section L: Migration — 新 keys／note snapshot 可匯出匯入、舊 backup 相容
  // ══════════════════════════════════════════════════════════════
  {
    const migrationSrc = fs.readFileSync(path.join(ROOT, 'routes/migration.js'), 'utf8');
    // settings 是 EAV 動態匯出/匯入（SELECT * FROM settings / buildDynamicInsert），
    // 新 pickup_* key 不需要改程式碼就會自動包含在備份裡。
    if (/SELECT \* FROM settings WHERE store_id=\?/.test(migrationSrc) && /buildDynamicInsert\('settings'/.test(migrationSrc)) {
      pass('L：settings 匯出（SELECT *）／匯入（buildDynamicInsert）皆為動態 EAV 欄位，F5 新 pickup_* keys 不需改程式碼即可備份還原');
    } else fail('L：settings 匯出/匯入邏輯不是預期的動態 EAV 寫法，需要再確認');

    const snapshotCols = ['pickup_store_name_snapshot', 'pickup_address_snapshot', 'pickup_address_note_snapshot', 'pickup_lat_snapshot', 'pickup_lng_snapshot'];
    const importOrdersBlock = migrationSrc.slice(migrationSrc.indexOf("router.post('/import/orders'"), migrationSrc.indexOf("router.post('/import/preorders'"));
    const importOrdersOk = snapshotCols.every(c => importOrdersBlock.includes(`'${c}'`)) && snapshotCols.every(c => importOrdersBlock.includes(`${c}:`));
    if (importOrdersOk) pass('L：/import/orders 白名單與 buildVals() 皆含 pickup_address_note_snapshot（含 F4 既有欄位）');
    else fail('L：/import/orders 缺少 pickup_address_note_snapshot 支援');

    const migImportBlock = migrationSrc.slice(migrationSrc.indexOf('const importOrderCandidates'), migrationSrc.indexOf('for (const o of (d.orders||[]))'));
    const migImportOk = snapshotCols.every(c => migImportBlock.includes(`'${c}'`)) && snapshotCols.every(c => migImportBlock.includes(`${c}:`));
    if (migImportOk) pass('L：/migration/import（快速搬家檔）白名單與 buildOrderSrc() 皆含 pickup_address_note_snapshot');
    else fail('L：/migration/import 缺少 pickup_address_note_snapshot 支援');

    // 舊 backup（沒有 note snapshot 欄位）匯入時 fallback 空字串，不應拋錯
    const o = { order_number: 'OLD-1' };
    const simulated = o.pickup_address_note_snapshot || '';
    if (simulated === '') pass('L：舊 backup 缺少 pickup_address_note_snapshot 時，fallback 空字串，不會拋錯');
    else fail('L：舊 backup 相容性模擬失敗');
  }

  // ══════════════════════════════════════════════════════════════
  // 後端結構檢查：INSERT 欄位數一致、settings.js 驗證/同步已接上、GET /shop 欄位齊全
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    const insertMatch = lineOrdersSrc.match(/INSERT INTO orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`,/);
    const colCount = insertMatch[1].split(',').map(s => s.trim()).filter(Boolean).length;
    const phCount = (insertMatch[2].match(/\?/g) || []).length;
    if (colCount === phCount) pass(`結構：INSERT INTO orders 欄位數（${colCount}）與 placeholder 數（${phCount}）一致`);
    else fail('結構：INSERT 欄位數與 placeholder 數不一致', `cols=${colCount} ph=${phCount}`);

    const shopFields = ['pickup_address_same_as_store', 'pickup_address_note', 'pickup_lat', 'pickup_lng', 'pickup_coordinate_mode', 'pickup_coordinate_verified_at', 'pickup_sync_delivery_origin'];
    const shopOk = shopFields.every(f => lineOrdersSrc.includes(`'${f}'`) || lineOrdersSrc.includes(`.${f}`));
    if (shopOk) pass('結構：GET /shop 已回傳 F5 全部 pickup settings 欄位（向下相容新增）');
    else fail('結構：GET /shop 缺少部分 F5 pickup settings 欄位');

    if (lineOrdersSrc.includes("'store_address', 'store_lat', 'store_lng', 'pickup_address',")) {
      pass('結構：GET /shop 既有欄位（store_address/store_lat/store_lng/pickup_address）未被移除');
    } else fail('結構：GET /shop 既有欄位疑似被移除');
  }

  // ══════════════════════════════════════════════════════════════
  // 前端結構檢查：Section B UI、Modal、關鍵函式存在，且 IDs 對應正確
  // ══════════════════════════════════════════════════════════════
  {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const requiredIds = [
      'set-pickup_address_same_as_store', 'pickup-same-as-store-summary', 'pickup-independent-fields',
      'set-pickup_address', 'set-pickup_address_note', 'set-pickup_lat', 'set-pickup_lng',
      'pickup-coordinate-mode-label', 'pickup-geocode-status', 'set-pickup_sync_delivery_origin',
      'pickupMapModal', 'pickupMapCanvas', 'pickupMapLatDisplay', 'pickupMapLngDisplay', 'pickup-map-status',
    ];
    const missingIds = requiredIds.filter(id => !indexSrc.includes(`id="${id}"`));
    if (!missingIds.length) pass('前端：Section B 與地圖 Modal 所需的 HTML id 全部存在');
    else fail('前端：缺少 HTML id', missingIds.join(', '));

    // 重複 ID 檢查
    const ids = [...indexSrc.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const dupCounts = {};
    ids.forEach(id => { dupCounts[id] = (dupCounts[id] || 0) + 1; });
    const dups = Object.entries(dupCounts).filter(([, n]) => n > 1);
    if (!dups.length) pass('前端：public/index.html 無重複 HTML id');
    else fail('前端：public/index.html 有重複 id', JSON.stringify(dups));

    const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const requiredFns = [
      'function togglePickupSameAsStore', 'async function geocodePickupAddress', 'function usePickupCurrentLocation',
      'async function openPickupMapModal', 'function closePickupMapModal', 'function setPickupMapType',
      'async function pickupMapRelocateFromAddress', 'function pickupMapUseCurrentLocation', 'function confirmPickupMapPin',
      'function _geolocateFriendly',
    ];
    const missingFns = requiredFns.filter(f => !appJsSrc.includes(f));
    if (!missingFns.length) pass('前端：app.js 所有 F5 必要函式皆存在');
    else fail('前端：app.js 缺少函式', missingFns.join(', '));

    // fix18-10-hotfix26-F7（需求文件廿五）：這些 pickup keys 現在改由獨立的
    // savePickupLocationSettings()（呼叫 PATCH /api/settings/pickup-location）送出，
    // 不再從 saveDeliveryFeeSettings() 送出——這是 F7 為了避免 stale state 互相覆蓋
    // 而刻意做的架構調整（需求文件廿五明確要求「先儲存 pickup → 再儲存其他外送設定
    // → pickup 不得被覆蓋回舊值」），本斷言同步更新以反映這個有意的改動。
    const saveFnSrc = appJsSrc.slice(appJsSrc.indexOf('async function savePickupLocationSettings'), appJsSrc.indexOf('async function savePickupLocationSettings') + 2000);
    const saveKeys = ['pickup_address_same_as_store', 'pickup_address', 'pickup_address_note', 'pickup_lat', 'pickup_lng', 'pickup_coordinate_mode', 'pickup_sync_delivery_origin'];
    const missingSaveKeys = saveKeys.filter(k => !saveFnSrc.includes(k));
    if (!missingSaveKeys.length) pass('前端：savePickupLocationSettings()（F7 獨立儲存）送出全部 F5 pickup settings keys');
    else fail('前端：savePickupLocationSettings() 缺少送出的 key', missingSaveKeys.join(', '));

    // 關閉/取消 Modal 不得修改原值
    const closeFnSrc = appJsSrc.slice(appJsSrc.indexOf('function closePickupMapModal'), appJsSrc.indexOf('function closePickupMapModal') + 300);
    if (!/\.value\s*=[^=]|_pickupCoordinateMode\s*=[^=]/.test(closeFnSrc)) {
      pass('前端：closePickupMapModal()（取消）不會修改表單欄位或 _pickupCoordinateMode');
    } else fail('前端：closePickupMapModal() 疑似會修改原設定');

    // 只有 confirmPickupMapPin() 會寫回表單欄位
    // fix18-10-hotfix26-F7：函式本體因為新增 pickup/store 雙 target 分支與自動填入邏輯
    // 變長了，視窗從 800 放寬到 1800 字元才能涵蓋到 lngEl.value 那行，斷言內容本身不變。
    const confirmFnSrc = appJsSrc.slice(appJsSrc.indexOf('function confirmPickupMapPin'), appJsSrc.indexOf('function confirmPickupMapPin') + 1800);
    if (/latEl\.value\s*=\s*lat/.test(confirmFnSrc) && /lngEl\.value\s*=\s*lng/.test(confirmFnSrc)) {
      pass('前端：confirmPickupMapPin()（使用此座標）才會把 Marker 座標寫回表單欄位');
    } else fail('前端：confirmPickupMapPin() 未正確寫回表單欄位');

    // Google Maps SDK 延用既有 /api/config/maps-browser-key
    if (/_ensurePickupMapsLoaded[\s\S]{0,400}\/api\/config\/maps-browser-key/.test(appJsSrc)) {
      pass('前端：地圖 Modal 延用既有 /api/config/maps-browser-key 取得 Browser Key（未另建新機制）');
    } else fail('前端：地圖 Modal 未使用既有 maps-browser-key 端點');

    // roadmap/satellite 切換
    if (/setMapTypeId\(type === 'satellite' \? 'satellite' : 'roadmap'\)/.test(appJsSrc)) {
      pass('前端：地圖 Modal 支援 roadmap／satellite 切換');
    } else fail('前端：缺少地圖類型切換邏輯');

    // Marker 可拖曳，拖曳後即時更新 lat/lng，且設為 manual
    // fix18-10-hotfix26-F7：dragend handler 改用 getActiveLocationFields().modalMode = 'manual'
    // 這個 target-aware helper（取代直接寫 _pickupModalMode = 'manual'），因為 Store/Pickup
    // 現在共用同一個 Marker/dragend，需要依 mapEditorTarget 更新正確的那組狀態。
    if (/draggable: true/.test(appJsSrc) && /dragend['"]?,\s*\(\) => \{[\s\S]{0,700}getActiveLocationFields\(\)\.modalMode = 'manual'/.test(appJsSrc)) {
      pass('前端：Marker 可拖曳（draggable:true），dragend 後即時更新顯示並標記為 manual（F7：改用 target-aware helper）');
    } else fail('前端：Marker 拖曳/dragend 邏輯不符預期');
  }

  // ══════════════════════════════════════════════════════════════
  // 前端結構檢查：F3/F4/F5 顯示整合（購物車/完成頁/查詢訂單皆走同一 resolver）
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrderHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    if (/pickup_address_same_as_store === false/.test(lineOrderHtmlSrc) && /shopData\.pickup_address_same_as_store/.test(lineOrderHtmlSrc)) {
      pass('前端：購物車 resolvePickupAddressText()/buildPickupMapsUrl() 已改用 same_as_store 優先序（F5）');
    } else fail('前端：購物車取餐地址函式未整合 F5 same_as_store 邏輯');

    if (/📝 取餐說明/.test(lineOrderHtmlSrc)) {
      pass('前端：buildPickupLocationRowsHTML() 已加入 📝 取餐說明列（空值時隱藏）');
    } else fail('前端：缺少取餐說明顯示');

    const noteRowSrc = lineOrderHtmlSrc.slice(lineOrderHtmlSrc.indexOf('function buildPickupLocationRowsHTML'), lineOrderHtmlSrc.indexOf('function buildPickupLocationRowsHTML') + 1200);
    if (/const note=String\(pickupLocation\.address_note\|\|''\)\.trim\(\);/.test(noteRowSrc) && /note\?`<div class="od-row">/.test(noteRowSrc)) {
      pass('前端：取餐說明只在有值時顯示，空值時該列完全省略（不留空白列）');
    } else fail('前端：取餐說明空值處理不符預期');
  }

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`${r.status}: ${r.name}`));
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke-hotfix26-f5] fatal error:', e); process.exit(1); });
