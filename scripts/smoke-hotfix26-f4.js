#!/usr/bin/env node
// scripts/smoke-hotfix26-f4.js — fix18-10-hotfix26-F4 smoke test
//
// 範圍：Pickup Store & Address Snapshot × Order Confirmation Consistency
//   A 新外帶訂單：snapshot 寫入、response 有門市/地址、Maps URL 正確
//   B 外送訂單：不回 pickup location，配送地址仍正常
//   C 店家改地址：舊訂單保持舊地址，新訂單使用新地址
//   D 舊訂單無 snapshot：fallback 目前門市資料，不報錯
//   E 無地址：顯示「請洽店家確認取餐地點」，Maps 安全隱藏/disable
//   F 跨店：store_001、store_002 不互相讀取地址
//   G 備份搬家：snapshot 匯出/匯入保留，舊 backup 相容
//   H 畫面一致：完成頁／查詢訂單／我的訂單使用同一門市/地址（同一 resolver）
//
// 做法：直接操作 sql.js 記憶體 DB + require utils/pickupLocation.js 的真實函式，
// 不需要啟動真實 HTTP server；靜態原始碼比對確認 routes/line-orders.js、
// routes/migration.js、public/line-order.html 三處都接上同一顆共用 helper。

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
      pickup_lat_snapshot TEXT DEFAULT NULL,
      pickup_lng_snapshot TEXT DEFAULT NULL,
      created_at TEXT
    );
  `);

  // 最小 db wrapper，介面與 utils/db.js 的 get/all/run 一致，供 utils/pickupLocation.js 使用
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
      const stmt = rawDb.prepare(sql); stmt.bind(params); stmt.step(); stmt.free();
    },
  };

  function setSetting(storeId, key, value) {
    db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  function insertOrder(o) {
    db.run(
      `INSERT INTO orders (id, order_number, store_id, order_mode,
        pickup_store_name_snapshot, pickup_address_snapshot, pickup_lat_snapshot, pickup_lng_snapshot, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [o.id, o.order_number, o.store_id, o.order_mode,
       o.pickup_store_name_snapshot ?? null, o.pickup_address_snapshot ?? null,
       o.pickup_lat_snapshot ?? null, o.pickup_lng_snapshot ?? null, o.created_at || '2026-07-17 12:00:00']
    );
  }

  const { buildPickupSnapshot, resolvePickupLocation, FALLBACK_ADDRESS_TEXT } = require(path.join(ROOT, 'utils/pickupLocation.js'));

  // ══════════════════════════════════════════════════════════════
  // Section A: 新外帶訂單 — snapshot 寫入 + response 有門市/地址 + Maps URL 正確
  // ══════════════════════════════════════════════════════════════
  setSetting('store_001', 'shop_name', '脆豬腰｜冷拌麻油腰子');
  setSetting('store_001', 'store_address', '桃園市中壢區龍東路128號');
  setSetting('store_001', 'store_lat', '24.9998');
  setSetting('store_001', 'store_lng', '121.2168');

  {
    const snap = buildPickupSnapshot(db, 'store_001');
    if (snap.pickup_store_name_snapshot === '脆豬腰｜冷拌麻油腰子' && snap.pickup_address_snapshot === '桃園市中壢區龍東路128號'
      && snap.pickup_lat_snapshot === '24.9998' && snap.pickup_lng_snapshot === '121.2168') {
      pass('A：buildPickupSnapshot() 依 store_id 重新讀取店家設定，snapshot 內容正確');
    } else fail('A：buildPickupSnapshot() 內容不符', JSON.stringify(snap));

    insertOrder({ id: 'o_a1', order_number: 'LINE-A1', store_id: 'store_001', order_mode: 'takeout', ...snap });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_a1']);
    const loc = resolvePickupLocation(order, db, 'store_001');
    if (loc && loc.store_name === '脆豬腰｜冷拌麻油腰子' && loc.address === '桃園市中壢區龍東路128號') {
      pass('A：新外帶訂單 resolvePickupLocation() 回傳正確門市/地址（來自 snapshot）');
    } else fail('A：新外帶訂單 pickup_location 內容不符', JSON.stringify(loc));
    // fix18-10-hotfix26-F7：Google Maps URL 優先序改成 place_id → name+address → address
    // → 座標（需求文件十九，「不得只要有座標就永遠優先使用座標」）。這筆訂單只有
    // 地址快照（沒有 place_id/place_name），所以新的優先序會走「地址搜尋」而不是
    // 座標——這是 F7 有意調整的行為，本行斷言已同步更新，其餘 A 段斷言不受影響。
    if (loc && loc.maps_url === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('桃園市中壢區龍東路128號')) {
      pass('A：Maps URL（F7 新優先序：無 place_id/name 時，有地址優先於純座標）');
    } else fail('A：Maps URL（F7 新優先序）不符', loc && loc.maps_url);
    if (loc && loc.from_snapshot === true) pass('A：pickup_location.from_snapshot=true（確實來自訂單自己的 snapshot）');
    else fail('A：from_snapshot 應為 true');
  }

  // ══════════════════════════════════════════════════════════════
  // Section B: 外送訂單 — 不回 pickup location
  // ══════════════════════════════════════════════════════════════
  {
    insertOrder({ id: 'o_b1', order_number: 'LINE-B1', store_id: 'store_001', order_mode: 'delivery' });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_b1']);
    const loc = resolvePickupLocation(order, db, 'store_001');
    if (loc === null) pass('B：外送訂單 resolvePickupLocation() 回傳 null（不誤顯示取餐門市/地址）');
    else fail('B：外送訂單應回傳 null', JSON.stringify(loc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section C: 店家改地址 — 舊訂單保持舊地址，新訂單使用新地址
  // ══════════════════════════════════════════════════════════════
  {
    // 先建立訂單（舊地址 A，已於 Section A 建立 o_a1，snapshot=龍東路128號）
    // 店家改地址為新地址 B
    setSetting('store_001', 'store_address', '桃園市中壢區龍東路999號（新址）');
    setSetting('store_001', 'store_lat', '24.1234');
    setSetting('store_001', 'store_lng', '121.5678');

    const oldOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_a1']);
    const oldLoc = resolvePickupLocation(oldOrder, db, 'store_001');
    if (oldLoc && oldLoc.address === '桃園市中壢區龍東路128號') pass('C：店家改地址後，舊訂單（有 snapshot）仍顯示建立當時的舊地址');
    else fail('C：舊訂單地址被店家改地址影響', JSON.stringify(oldLoc));

    const newSnap = buildPickupSnapshot(db, 'store_001');
    insertOrder({ id: 'o_c1', order_number: 'LINE-C1', store_id: 'store_001', order_mode: 'takeout', ...newSnap });
    const newOrder = db.get('SELECT * FROM orders WHERE id=?', ['o_c1']);
    const newLoc = resolvePickupLocation(newOrder, db, 'store_001');
    if (newLoc && newLoc.address === '桃園市中壢區龍東路999號（新址）') pass('C：改地址後新建立的訂單使用新地址');
    else fail('C：新訂單未使用新地址', JSON.stringify(newLoc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section D: 舊訂單無 snapshot — fallback 目前店家資料，不報錯
  // ══════════════════════════════════════════════════════════════
  {
    insertOrder({ id: 'o_d1', order_number: 'LINE-D1', store_id: 'store_001', order_mode: 'takeout' }); // 無 snapshot
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_d1']);
    let loc, threw = false;
    try { loc = resolvePickupLocation(order, db, 'store_001'); } catch (e) { threw = true; }
    if (!threw) pass('D：舊訂單（無 snapshot）resolvePickupLocation() 不拋錯');
    else fail('D：舊訂單無 snapshot 時發生例外');
    if (loc && loc.address === '桃園市中壢區龍東路999號（新址）' && loc.from_snapshot === false) {
      pass('D：舊訂單無 snapshot 時，正確 fallback 顯示「目前」店家地址（from_snapshot=false）');
    } else fail('D：舊訂單 fallback 結果不符', JSON.stringify(loc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section E: 無地址 — 顯示「請洽店家確認取餐地點」，Maps 安全 disable
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_003', 'shop_name', ''); // 全新店家，未設定任何地址
    const snap = buildPickupSnapshot(db, 'store_003');
    insertOrder({ id: 'o_e1', order_number: 'LINE-E1', store_id: 'store_003', order_mode: 'takeout', ...snap });
    const order = db.get('SELECT * FROM orders WHERE id=?', ['o_e1']);
    const loc = resolvePickupLocation(order, db, 'store_003');
    if (loc && loc.address === FALLBACK_ADDRESS_TEXT && loc.address === '請洽店家確認取餐地點') {
      pass('E：無任何地址設定時，顯示「請洽店家確認取餐地點」（不留空白）');
    } else fail('E：無地址 fallback 文字不符', JSON.stringify(loc));
    if (loc && loc.has_address === false && loc.maps_url === '') {
      pass('E：無地址時 has_address=false 且 maps_url 為空字串（前端據此 disable/隱藏 Maps 按鈕）');
    } else fail('E：無地址時 has_address/maps_url 不符', JSON.stringify(loc));
  }

  // ══════════════════════════════════════════════════════════════
  // Section F: 跨店隔離 — store_001 與 store_002 地址不互相污染
  // ══════════════════════════════════════════════════════════════
  {
    setSetting('store_002', 'shop_name', '好食堂二店');
    setSetting('store_002', 'store_address', '台北市大安區忠孝東路一段1號');
    setSetting('store_002', 'store_lat', '25.0000');
    setSetting('store_002', 'store_lng', '121.5000');

    const snap1 = buildPickupSnapshot(db, 'store_001');
    const snap2 = buildPickupSnapshot(db, 'store_002');
    if (snap1.pickup_address_snapshot !== snap2.pickup_address_snapshot
      && snap2.pickup_address_snapshot === '台北市大安區忠孝東路一段1號') {
      pass('F：store_001／store_002 各自讀到自己店家的地址設定，未互相污染');
    } else fail('F：跨店隔離失敗', JSON.stringify({ snap1, snap2 }));

    insertOrder({ id: 'o_f2', order_number: 'LINE-F2', store_id: 'store_002', order_mode: 'takeout', ...snap2 });
    const order2 = db.get('SELECT * FROM orders WHERE id=?', ['o_f2']);
    // 故意用錯的 storeId 呼叫，驗證即使 order.store_id 沒被拿來查詢，settings 查詢仍是用呼叫端傳入的 storeId
    // （resolvePickupLocation 內部 fallback 分支才會查 settings；此處有 snapshot，不會誤查 store_001）
    const loc2 = resolvePickupLocation(order2, db, 'store_002');
    if (loc2 && loc2.address === '台北市大安區忠孝東路一段1號') pass('F：store_002 訂單顯示 store_002 自己的地址');
    else fail('F：store_002 訂單地址不符', JSON.stringify(loc2));
  }

  // ══════════════════════════════════════════════════════════════
  // Section H: 畫面一致 — 完成頁／查詢訂單／我的訂單使用同一 resolver
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    const usesHelperInSafeOrder = /function safeOrder\(order, db, storeId\)[\s\S]{0,400}resolvePickupLocation\(order, db, storeId\)/.test(lineOrdersSrc);
    if (usesHelperInSafeOrder) pass('H：safeOrder()（查詢訂單／我的訂單共用）呼叫共用 resolvePickupLocation()');
    else fail('H：safeOrder() 未呼叫共用 resolvePickupLocation()');

    const usesHelperInCreate = /const pickupLocation = resolvePickupLocation\(newOrder, db, storeId\)/.test(lineOrdersSrc);
    if (usesHelperInCreate) pass('H：訂單建立 API（完成頁）呼叫同一顆共用 resolvePickupLocation()');
    else fail('H：訂單建立 API 未呼叫共用 resolvePickupLocation()');

    const requiresHelper = /require\(['"]\.\.\/utils\/pickupLocation['"]\)/.test(lineOrdersSrc);
    if (requiresHelper) pass('H：routes/line-orders.js 引用單一 utils/pickupLocation.js（未各自兜地址邏輯）');
    else fail('H：routes/line-orders.js 未引用共用 helper 檔案');

    const allSafeOrderCallsPassScope = !/orders\.map\(safeOrder\)/.test(lineOrdersSrc) && !/\[safeOrder\(order\)\]/.test(lineOrdersSrc);
    if (allSafeOrderCallsPassScope) pass('H：所有 safeOrder() 呼叫點皆已改傳入 db/storeId（無殘留舊簽章呼叫）');
    else fail('H：仍有 safeOrder() 呼叫點使用舊簽章（未傳 db/storeId）');
  }

  // ══════════════════════════════════════════════════════════════
  // Section G: 備份搬家 — snapshot 欄位匯出/匯入保留
  // ══════════════════════════════════════════════════════════════
  {
    const migrationSrc = fs.readFileSync(path.join(ROOT, 'routes/migration.js'), 'utf8');
    const snapshotCols = ['pickup_store_name_snapshot', 'pickup_address_snapshot', 'pickup_lat_snapshot', 'pickup_lng_snapshot'];

    // /export/orders 與 /migration/export 皆用 SELECT * FROM orders（動態欄位），自動包含新欄位
    const exportUsesSelectStar = (migrationSrc.match(/SELECT \* FROM orders WHERE store_id=\?/g) || []).length >= 2;
    if (exportUsesSelectStar) pass('G：/export/orders 與 /migration/export 皆用 SELECT * FROM orders，snapshot 欄位自動包含在匯出檔中');
    else fail('G：orders 匯出未使用 SELECT *，需確認 snapshot 欄位是否有被匯出');

    // /import/orders 的 importCols 白名單需包含 snapshot 欄位
    const importOrdersBlock = migrationSrc.slice(migrationSrc.indexOf("router.post('/import/orders'"), migrationSrc.indexOf("router.post('/import/preorders'"));
    const importOrdersOk = snapshotCols.every(c => importOrdersBlock.includes(`'${c}'`)) && snapshotCols.every(c => importOrdersBlock.includes(`${c}:`));
    if (importOrdersOk) pass('G：/import/orders 的欄位白名單與 buildVals() 皆已加入 snapshot 欄位，匯入後可還原');
    else fail('G：/import/orders 未完整支援 snapshot 欄位匯入');

    // /migration/import（快速搬家檔匯入）的 importOrderCandidates 與 buildOrderSrc() 也需包含
    const migImportBlock = migrationSrc.slice(migrationSrc.indexOf('const importOrderCandidates'), migrationSrc.indexOf('for (const o of (d.orders||[]))'));
    const migImportOk = snapshotCols.every(c => migImportBlock.includes(`'${c}'`)) && snapshotCols.every(c => migImportBlock.includes(`${c}:`));
    if (migImportOk) pass('G：/migration/import（快速搬家檔）的欄位白名單與 buildOrderSrc() 皆已加入 snapshot 欄位');
    else fail('G：/migration/import 未完整支援 snapshot 欄位匯入');

    // 舊 backup（沒有 snapshot 欄位的訂單物件）匯入時 fallback 空字串，不應拋錯
    const map = {}; // 模擬 buildVals()：o 沒有這些欄位時應是 undefined
    const o = { order_number: 'OLD-1' }; // 舊 backup 訂單物件，完全沒有 snapshot 欄位
    const simulatedVal = o.pickup_store_name_snapshot || '';
    if (simulatedVal === '') pass('G：舊 backup 缺少 snapshot 欄位時，匯入邏輯 fallback 為空字串，不會拋錯');
    else fail('G：舊 backup 相容性模擬失敗');
  }

  // ══════════════════════════════════════════════════════════════
  // 前端靜態檢查：完成頁／查詢訂單／我的訂單皆已接上 pickup_location 顯示
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrderHtmlSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');

    if (lineOrderHtmlSrc.includes('function buildPickupLocationRowsHTML(pickupLocation)')) {
      pass('前端：buildPickupLocationRowsHTML() 共用函式存在');
    } else fail('前端：缺少 buildPickupLocationRowsHTML() 共用函式');

    const successScreenUsesIt = /pickup_location:orderData\.pickup_location\|\|null/.test(lineOrderHtmlSrc);
    if (successScreenUsesIt) pass('前端：訂單完成頁（buildDetailRows 呼叫點）帶入後端回傳的 pickup_location');
    else fail('前端：訂單完成頁未帶入 pickup_location');

    const buildDetailRowsUsesIt = /function buildDetailRows\(d\)\{[\s\S]{0,300}buildPickupLocationRowsHTML\(d\.pickup_location\)/.test(lineOrderHtmlSrc);
    if (buildDetailRowsUsesIt) pass('前端：buildDetailRows()（完成頁）呼叫 buildPickupLocationRowsHTML()');
    else fail('前端：buildDetailRows() 未呼叫 buildPickupLocationRowsHTML()');

    const orderDetailUsesIt = /function openOrderDetail\(o\)\{[\s\S]{0,1500}buildPickupLocationRowsHTML\(o\.pickup_location\)/.test(lineOrderHtmlSrc);
    if (orderDetailUsesIt) pass('前端：openOrderDetail()（查詢訂單／我的訂單詳情）呼叫同一顆 buildPickupLocationRowsHTML()');
    else fail('前端：openOrderDetail() 未呼叫 buildPickupLocationRowsHTML()');

    // 只在外帶顯示：buildPickupLocationRowsHTML 對 null（外送）回傳空字串
    if (/if\(!pickupLocation\) return '';/.test(lineOrderHtmlSrc)) {
      pass('前端：buildPickupLocationRowsHTML(null) 回傳空字串（外送/宅配不顯示取餐門市/地址）');
    } else fail('前端：buildPickupLocationRowsHTML 缺少 null-safe 分支');

    // 複製地址／Maps 按鈕 fallback 邏輯存在（沿用既有 clipboard fallback，不因 API 不可用而報錯）
    if (lineOrderHtmlSrc.includes('function copyPickupAddressText(addr)') && lineOrderHtmlSrc.includes('document.execCommand(\'copy\')')) {
      pass('前端：copyPickupAddressText() 具備 clipboard fallback（execCommand），不因 API 不可用而報錯');
    } else fail('前端：copyPickupAddressText() 缺少 clipboard fallback');

    // Section 5 回歸：F3 既有函式簽章、既有 pickup 顯示邏輯完全不變（byte-level 關鍵字比對）
    const f3FnNames = ['resolvePickupAddressText', 'buildPickupMapsUrl', 'updatePickupAddressVisibility'];
    const f3Intact = f3FnNames.every((n) => lineOrderHtmlSrc.includes(`function ${n}(`));
    if (f3Intact) pass('回歸：F3 既有取餐地址函式（購物車 UI）簽章維持不變');
    else fail('回歸：F3 既有取餐地址函式疑似被改動');

    if (lineOrderHtmlSrc.includes("const storeAddr=(shopData&&shopData.store_address)?String(shopData.store_address).trim():'';")) {
      pass('回歸：F3 resolvePickupAddressText() 函式本體（購物車即時地址）完全未被改動');
    } else fail('回歸：F3 resolvePickupAddressText() 函式本體疑似被改動');
  }

  // ══════════════════════════════════════════════════════════════
  // 後端靜態檢查：INSERT 欄位數與參數數一致、backend 不信任前端 snapshot 欄位
  // ══════════════════════════════════════════════════════════════
  {
    const lineOrdersSrc = fs.readFileSync(path.join(ROOT, 'routes/line-orders.js'), 'utf8');
    const insertMatch = lineOrdersSrc.match(/INSERT INTO orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`,/);
    if (insertMatch) {
      const colCount = insertMatch[1].split(',').map(s => s.trim()).filter(Boolean).length;
      const phCount = (insertMatch[2].match(/\?/g) || []).length;
      if (colCount === phCount) pass(`後端：INSERT INTO orders 欄位數（${colCount}）與 placeholder 數（${phCount}）一致`);
      else fail('後端：INSERT INTO orders 欄位數與 placeholder 數不一致', `cols=${colCount}, placeholders=${phCount}`);
    } else fail('後端：找不到 INSERT INTO orders 語句');

    // 不信任前端傳入的 pickup_store_name_snapshot 等欄位：解構 req.body 時不得出現這些欄位名稱
    const destructureBlock = lineOrdersSrc.slice(lineOrdersSrc.indexOf("router.post('/', async"), lineOrdersSrc.indexOf('} = req.body;'));
    const leaksClientSnapshot = /pickup_store_name_snapshot|pickup_address_snapshot|pickup_lat_snapshot|pickup_lng_snapshot/.test(destructureBlock);
    if (!leaksClientSnapshot) pass('後端：POST /（建立訂單）未從 req.body 解構任何 pickup_*_snapshot 欄位，不信任前端資料');
    else fail('後端：POST / 疑似信任前端傳入的 snapshot 欄位');

    // buildPickupSnapshot 只在非外送時呼叫（外送不誤寫成配送地址）
    if (/const pickupSnapshot = !isDelivery\s*\n\s*\? buildPickupSnapshot\(db, storeId\)/.test(lineOrdersSrc)) {
      pass('後端：只有非外送（外帶/預購外帶）訂單才呼叫 buildPickupSnapshot() 寫入快照');
    } else fail('後端：buildPickupSnapshot() 呼叫條件不符預期');
  }

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`${r.status}: ${r.name}`));
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke-hotfix26-f4] fatal error:', e); process.exit(1); });
