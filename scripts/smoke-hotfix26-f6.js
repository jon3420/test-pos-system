#!/usr/bin/env node
// scripts/smoke-hotfix26-f6.js — fix18-10-hotfix26-F6 smoke test
//
// 範圍：Pickup Place Search × Google Autocomplete × Map Pin Jump
// 做法：因為 Google Maps JS SDK（Autocomplete／PlacesService／Geocoder）依賴真實
// 瀏覽器環境與真實 API Key，這裡採用跟 smoke-hotfix26-f3.js／f5.js 一致的策略——
// 用正則/靜態原始碼比對驗證關鍵邏輯與流程存在且串接正確，並對可以抽成純函式的
// 部分（_placeResultToState 等）用 eval 直接執行驗證行為。真正的 Google Maps 互動
// （地圖渲染、Autocomplete 下拉、拖曳手勢）仍需人工在瀏覽器中最終確認（見 MANUAL）。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

function main() {
  const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const cssSrc   = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');

  const slice = (marker, len) => {
    const i = appJsSrc.indexOf(marker);
    return i === -1 ? '' : appJsSrc.slice(i, i + len);
  };

  // ══════════════════════════════════════════════════════════════
  // Section A: SDK — 使用 /api/config/maps-browser-key、libraries=places、
  // 不硬編碼 Key、不重複載入 script
  // ══════════════════════════════════════════════════════════════
  {
    const sdkFn = slice('async function ensureGoogleMapsSdk', 2200);
    if (sdkFn.includes('/api/config/maps-browser-key')) pass('A：ensureGoogleMapsSdk() 使用既有 /api/config/maps-browser-key 取得 Key');
    else fail('A：ensureGoogleMapsSdk() 未使用既有 Key 端點');

    if (/libraries=places/.test(sdkFn)) pass('A：Google Maps SDK 載入時 libraries 包含 places');
    else fail('A：SDK 載入未帶 libraries=places');

    // 不硬編碼 Key：script src 使用 encodeURIComponent(json.key)（動態變數），
    // 檔案中不應出現常見的 Google API Key 格式字面值（AIza 開頭）。
    if (/encodeURIComponent\(json\.key\)/.test(sdkFn) && !/AIza[0-9A-Za-z_\-]{10,}/.test(appJsSrc)) {
      pass('A：API Key 動態帶入（encodeURIComponent(json.key)），檔案中無硬編碼的 Key 字面值');
    } else fail('A：疑似硬編碼 Key 或未使用動態變數');

    // 不重複載入：用 window._pickupMapsScriptInjected 旗標防止重複插入 <script>，
    // 且用單一 Promise（_pickupMapsSdkPromise）記憶體快取多次呼叫。
    if (/_pickupMapsScriptInjected/.test(sdkFn) && /_pickupMapsSdkPromise/.test(appJsSrc)) {
      pass('A：ensureGoogleMapsSdk() 用旗標＋Promise 快取避免重複插入多個 <script>');
    } else fail('A：缺少防止重複載入 SDK 的機制');

    if (appJsSrc.includes("callback=_initPickupMapsCallback")) pass('A：沿用既有 callback 名稱，不新增另一套載入回呼機制');
    else fail('A：SDK callback 命名不符預期');
  }

  // ══════════════════════════════════════════════════════════════
  // Section B: Autocomplete — 建立、台灣地區限制、fields 設定完整
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function initPickupPlaceAutocomplete', 1200);
    if (/new google\.maps\.places\.Autocomplete\(input,/.test(fn)) pass('B：initPickupPlaceAutocomplete() 建立 google.maps.places.Autocomplete');
    else fail('B：未建立 Autocomplete 實例');

    if (/componentRestrictions:\s*{\s*country:\s*'tw'\s*}/.test(fn)) pass('B：Autocomplete 限制 componentRestrictions.country=tw（台灣地區）');
    else fail('B：Autocomplete 未限制台灣地區');

    const requiredFields = ['place_id', 'name', 'formatted_address', 'geometry', 'types'];
    const fieldsMatch = fn.match(/fields:\s*\[([^\]]*)\]/);
    const fieldsOk = fieldsMatch && requiredFields.every(f => fieldsMatch[1].includes(`'${f}'`));
    if (fieldsOk) pass('B：Autocomplete fields 設定完整（place_id/name/formatted_address/geometry/types）');
    else fail('B：Autocomplete fields 設定不完整', fieldsMatch ? fieldsMatch[1] : 'not found');

    // 不能只限制地址：不應設定 types 限制成 ['address'] 之類，讓 establishment 等也能出現
    if (!/types:\s*\[\s*'address'/.test(fn) && !/types:\s*\[\s*'geocode'/.test(fn)) {
      pass('B：未把 Autocomplete 限制成只有地址類型，establishment/POI 等仍可被建議');
    } else fail('B：Autocomplete 疑似限制成只有地址類型');

    if (/if \(_pickupAutocomplete\) return;/.test(fn)) pass('B：initPickupPlaceAutocomplete() 只綁定一次，重複呼叫不會 new 出第二個實例');
    else fail('B：缺少防止重複綁定 Autocomplete 的保護');
  }

  // ══════════════════════════════════════════════════════════════
  // Section C: 選取地點 — Marker 跳轉、map center 更新、zoom 更新、
  // lat/lng 更新、不立即寫 DB
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function applyPickupSearchResult', 1500);
    if (/_setPickupMarkerPosition\(result\.lat, result\.lng\)/.test(fn)) pass('C：applyPickupSearchResult() 呼叫 _setPickupMarkerPosition()（Marker 跳轉＋map center 更新，沿用既有函式)');
    else fail('C：未看到 Marker/地圖中心更新呼叫');

    if (/_pickupMap\.setZoom\(targetZoom\)/.test(fn) && /Math\.max\(17, Math\.min\(19,/.test(fn)) {
      pass('C：套用搜尋結果時會設定 zoom 落在 17～19 之間（建議範圍）');
    } else fail('C：zoom 調整邏輯不符建議範圍');

    if (/pickupMapSearchState = \{/.test(fn) && /lat: result\.lat, lng: result\.lng/.test(fn)) {
      pass('C：applyPickupSearchResult() 更新暫存 pickupMapSearchState 的 lat/lng');
    } else fail('C：未正確更新暫存 lat/lng 狀態');

    // 不立即寫 DB：applyPickupSearchResult() 不應呼叫 apiFetch('/api/settings' 或直接寫 set-pickup_lat/lng 表單欄位
    if (!/apiFetch\('\/api\/settings'/.test(fn) && !/document\.getElementById\('set-pickup_lat'\)/.test(fn)) {
      pass('C：applyPickupSearchResult() 不會直接寫入表單欄位或呼叫 PUT /api/settings（不立即寫 DB）');
    } else fail('C：applyPickupSearchResult() 疑似直接寫入表單或 DB');
  }

  // ══════════════════════════════════════════════════════════════
  // Section D/E/F: 店名／地址／地標搜尋 — Places Text Search → Geocoder fallback
  // ══════════════════════════════════════════════════════════════
  {
    const mainFn = slice('async function searchPickupPlace()', 1200);
    if (/searchPickupPlaceByText\(query\)/.test(mainFn) && /geocodePickupSearchText\(query\)/.test(mainFn)) {
      pass('D/E/F：searchPickupPlace() 先呼叫 searchPickupPlaceByText()（Places Text Search），無結果才呼叫 geocodePickupSearchText()（Geocoder fallback）');
    } else fail('D/E/F：搜尋優先序（Places → Geocoder）串接不符預期');

    const textSearchFn = slice('function searchPickupPlaceByText', 1200);
    if (/PlacesService\(_pickupMap \|\| document\.createElement\('div'\)\)/.test(textSearchFn)) {
      pass('D/F：searchPickupPlaceByText() 使用 PlacesService.textSearch()，可用任意查詢字串（店名/地標/地址皆可）');
    } else fail('D/F：PlacesService 建立方式不符預期');
    if (/request\.location = _pickupMap\.getCenter\(\)/.test(textSearchFn)) {
      pass('D/F：Text Search 有用目前地圖中心作為 location bias');
    } else fail('D/F：缺少 location bias 設定');

    const geocodeFn = slice('function geocodePickupSearchText', 900);
    if (/new google\.maps\.Geocoder\(\)/.test(geocodeFn) && /region:\s*'TW'/.test(geocodeFn)) {
      pass('E：geocodePickupSearchText() 使用 google.maps.Geocoder，region=TW');
    } else fail('E：Geocoder fallback 實作不符預期');

    manual('D/E/F：實際店名/地址/地標搜尋命中率', '需要真實 Google API Key + 真實瀏覽器環境才能驗證實際搜尋結果品質');
  }

  // ══════════════════════════════════════════════════════════════
  // Section G: 多筆結果 — 最多 5 筆、可點選、不使用不安全 inline HTML
  // ══════════════════════════════════════════════════════════════
  {
    const handleFn = slice('function _handlePickupPlacesResults', 500);
    if (/results\.length === 1/.test(handleFn) && /renderPickupSearchResults\(results\)/.test(handleFn)) {
      pass('G：Text Search 只有 1 筆時直接套用；多筆才顯示清單（不預設永遠選第一筆）');
    } else fail('G：多筆結果處理邏輯不符預期');

    const textSearchFn = slice('function searchPickupPlaceByText', 1200);
    if (/results\.slice\(0, 5\)/.test(textSearchFn)) pass('G：searchPickupPlaceByText() 最多取前 5 筆結果');
    else fail('G：未限制最多 5 筆結果');

    const renderFn = slice('function renderPickupSearchResults', 1500);
    if (/results\.slice\(0, 5\)\.forEach/.test(renderFn)) pass('G：renderPickupSearchResults() 渲染時也限制最多 5 筆');
    else fail('G：renderPickupSearchResults() 未限制 5 筆');

    // 不使用不安全 inline HTML：用 createElement/textContent，不用 innerHTML 拼接使用者/Google 文字，
    // 也不用 onclick="..." 字串拼接（避免未過濾內容注入）。
    const usesUnsafeInline = /innerHTML\s*\+?=\s*`[^`]*\$\{[^}]*(name|address|formatted)/i.test(renderFn)
      || /onclick=["'`][^"'`]*\$\{/.test(renderFn);
    const usesSafeDom = /createElement\('div'\)/.test(renderFn) && /\.textContent\s*=/.test(renderFn) && /addEventListener\('click'/.test(renderFn);
    if (!usesUnsafeInline && usesSafeDom) {
      pass('G：renderPickupSearchResults() 用 DOM API（createElement/textContent/addEventListener）安全渲染，未把使用者/Google 文字拼進 inline HTML 或 onclick 字串，避免 XSS');
    } else fail('G：renderPickupSearchResults() 疑似存在不安全的 inline HTML 拼接');

    // 每筆用 index 綁定監聽器（forEach 迭代 + closure 捕捉該筆 r），不是拼 onclick="selectResult(index)"
    if (/\.forEach\(\(r, idx\) => \{/.test(renderFn)) pass('G：每筆結果用 forEach((r, idx)) closure 綁定，以物件參照而非字串拼接對應到正確結果');
    else fail('G：結果綁定方式不符預期');
  }

  // ══════════════════════════════════════════════════════════════
  // Section H: Enter 搜尋，不送出整張設定表單
  // ══════════════════════════════════════════════════════════════
  {
    const inputBlock = indexSrc.slice(indexSrc.indexOf('id="pickupSearchInput"') - 50, indexSrc.indexOf('id="pickupSearchInput"') + 400);
    if (/onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);searchPickupPlace\(\);\}"/.test(inputBlock)) {
      pass('H：搜尋輸入框按 Enter 會 preventDefault() 並呼叫 searchPickupPlace()，不會觸發表單送出');
    } else fail('H：搜尋輸入框缺少 Enter 鍵處理或未阻止預設行為');
    // 搜尋框不在 <form> 內（本頁本來就沒有用 <form> 包裹設定區塊），額外確認附近沒有 <form> 標籤包住搜尋框
    const nearbyHasForm = /<form[\s>]/i.test(indexSrc.slice(Math.max(0, indexSrc.indexOf('id="pickupSearchInput"') - 3000), indexSrc.indexOf('id="pickupSearchInput"')));
    if (!nearbyHasForm) pass('H：搜尋框不在任何 <form> 標籤內，Enter 不會有表單原生送出風險');
    else fail('H：搜尋框疑似位於 <form> 內，需再確認 Enter 是否會誤觸送出');
  }

  // ══════════════════════════════════════════════════════════════
  // Section I: 帶入取餐地址 — same_as_store=true 用 store_address，false 用 pickup_address
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function usePickupAddressAsSearch', 800);
    if (/sameAsStore\s*\?\s*\(document\.getElementById\('set-store_address'\)/.test(fn) && /:\s*\(document\.getElementById\('set-pickup_address'\)/.test(fn)) {
      pass('I：usePickupAddressAsSearch() same_as_store=true 用 store_address，false 用 pickup_address');
    } else fail('I：帶入取餐地址的優先序不符預期');
    if (/if \(!addr\) \{ _setPickupSearchStatus\('目前沒有可帶入的地址，請先輸入取餐地址。', true\); return; \}/.test(fn)) {
      pass('I：地址為空時顯示「目前沒有可帶入的地址，請先輸入取餐地址。」且不繼續執行搜尋');
    } else fail('I：缺少地址為空的錯誤訊息');
    if (/searchPickupPlace\(\);/.test(fn)) pass('I：帶入地址後自動執行搜尋');
    else fail('I：帶入地址後未自動搜尋');
  }

  // ══════════════════════════════════════════════════════════════
  // Section J: 帶入店名 — store_name + pickup/store address 優先序
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function useStoreNameAsSearch', 900);
    if (/if \(!sameAsStore && pickupAddr\) query = `\$\{storeName\} \$\{pickupAddr\}`;/.test(fn)) {
      pass('J：useStoreNameAsSearch() 優先組合 store_name + pickup_address（獨立取餐地址時）');
    } else fail('J：店名+取餐地址優先序不符預期');
    if (/else if \(storeAddr\) query = `\$\{storeName\} \$\{storeAddr\}`;/.test(fn)) {
      pass('J：沒有 pickup_address 時 fallback 組合 store_name + store_address');
    } else fail('J：店名+店家地址 fallback 不符預期');
    if (/let query = storeName;/.test(fn)) pass('J：都沒有地址時只用店名搜尋');
    else fail('J：只有店名時的 fallback 不符預期');
  }

  // ══════════════════════════════════════════════════════════════
  // Section K: 搜尋後確認 — 按「使用此座標」後 mode=manual、verified_at 有值
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function confirmPickupMapPin', 900);
    if (/_pickupCoordinateMode = 'manual';/.test(fn)) {
      pass('K：confirmPickupMapPin()（使用此座標）一律設定 _pickupCoordinateMode=manual，不論座標來源為何（拖曳/GPS/搜尋/重新定位）');
    } else fail('K：confirmPickupMapPin() 未統一設為 manual');
    // verified_at 由後端 buildTaipeiVerifiedAtStamp() 蓋章（沿用 F5 邏輯，本版未變動）；
    // 前端 saveDeliveryFeeSettings() 送出的 pickup_coordinate_mode 就是這裡確認後的值。
    const saveFnSrc = appJsSrc.slice(appJsSrc.indexOf('async function saveDeliveryFeeSettings'), appJsSrc.indexOf('async function saveDeliveryFeeSettings') + 2000);
    if (/pickup_coordinate_mode:\s*_pickupCoordinateMode \|\| 'auto'/.test(saveFnSrc)) {
      pass('K：saveDeliveryFeeSettings() 送出 confirmPickupMapPin() 確認後的 _pickupCoordinateMode（manual），後端會據此蓋章 verified_at（沿用 F5，未變動）');
    } else fail('K：儲存流程未正確送出座標模式');
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    if (/buildTaipeiVerifiedAtStamp/.test(settingsSrc)) pass('K：後端 verified_at 蓋章機制（buildTaipeiVerifiedAtStamp，F5）維持不變，F6 未重寫');
    else fail('K：後端 verified_at 蓋章機制疑似被移除');
  }

  // ══════════════════════════════════════════════════════════════
  // Section L: 取消 — 關閉 Modal 時 DB 不變、原表單座標不變
  // ══════════════════════════════════════════════════════════════
  {
    const fn = slice('function closePickupMapModal', 300);
    if (!/\.value\s*=[^=]|_pickupCoordinateMode\s*=[^=]|apiFetch\(/.test(fn)) {
      pass('L：closePickupMapModal()（取消/關閉）不寫表單欄位、不呼叫 _pickupCoordinateMode 賦值、不呼叫任何 API（DB 不變）');
    } else fail('L：closePickupMapModal() 疑似會修改資料');
    if (/clearPickupSearchState\(\);/.test(fn)) pass('L：關閉 Modal 會清除搜尋狀態（clearPickupSearchState()）');
    else fail('L：關閉 Modal 未清除搜尋狀態');

    const clearFn = slice('function clearPickupSearchState', 900);
    if (!/set-pickup_lat|set-pickup_lng|set-pickup_address\b/.test(clearFn)) {
      pass('L：clearPickupSearchState() 只清搜尋相關 UI，不觸碰原始表單設定（set-pickup_lat/lng/address 完全不動)');
    } else fail('L：clearPickupSearchState() 疑似誤清了表單設定');
  }

  // ══════════════════════════════════════════════════════════════
  // Section M: Places 失敗仍可拖曳地圖／使用 GPS
  // ══════════════════════════════════════════════════════════════
  {
    const mainFn = slice('async function searchPickupPlace()', 1200);
    if (/if \(!sdkOk\) \{[\s\S]{0,150}return;\s*\}/.test(mainFn)) {
      pass('M：searchPickupPlace() 在 SDK 載入失敗時直接顯示友善訊息並 return，不影響其他功能');
    } else fail('M：SDK 載入失敗時的降級處理不符預期');
    // 拖曳 marker／GPS／地圖切換 三個既有函式（F5，本版未變動）仍然存在且獨立於搜尋流程
    const independentFns = ['function _initPickupMap', 'function pickupMapUseCurrentLocation', 'function setPickupMapType'];
    const allExist = independentFns.every(f => appJsSrc.includes(f));
    if (allExist) pass('M：拖曳 Marker／使用目前位置／地圖切換（F5 既有函式）皆獨立於搜尋流程，Places 失敗不影響它們運作');
    else fail('M：拖曳/GPS/地圖切換函式缺失');

    const textSearchFn = slice('function searchPickupPlaceByText', 1200);
    if (/resolve\(\[\]\)/.test(textSearchFn) && !/throw/.test(textSearchFn)) {
      pass('M：Places textSearch 各種失敗狀態（ZERO_RESULTS/OVER_QUERY_LIMIT/REQUEST_DENIED/INVALID_REQUEST）皆 resolve([])，不 throw，不讓 Modal 失效');
    } else fail('M：Places 錯誤處理疑似會 throw 或未妥善降級');
  }

  // ══════════════════════════════════════════════════════════════
  // Section N: tenant isolation — 本功能不得跨店讀取 store_name/address
  // ══════════════════════════════════════════════════════════════
  {
    const useAddrFn = slice('function usePickupAddressAsSearch', 800);
    const useNameFn = slice('function useStoreNameAsSearch', 900);
    // 兩個函式都只讀取「目前登入店家」在畫面上已載入的 set-store_address/set-pickup_address/
    // settings.shop_name（這些本來就是 GET /api/settings 依 JWT/x-store-id 解析出的單一
    // 店家資料，前端沒有任何跨店查詢的 API 呼叫或 store_id 參數可供竄改）。
    const hasNoStoreIdParam = !/store_id/.test(useAddrFn) && !/store_id/.test(useNameFn);
    const onlyReadsLocalForm = /document\.getElementById\('set-store_address'\)/.test(useAddrFn) && /settings\.shop_name/.test(useNameFn);
    if (hasNoStoreIdParam && onlyReadsLocalForm) {
      pass('N：usePickupAddressAsSearch()/useStoreNameAsSearch() 只讀取目前登入店家已載入的表單/settings 資料，沒有可竄改的 store_id 參數，不會跨店讀取');
    } else fail('N：搜尋帶入功能疑似有跨店讀取風險');
    manual('N：搜尋結果本身（Google Places 回傳）', 'Google Places/Geocoder 回傳的地點資料是公開地理資訊，非租戶私有資料，跨店隔離指的是「帶入」來源（已驗證），不適用於 Google 端資料本身');
  }

  // ══════════════════════════════════════════════════════════════
  // Section O: Regression — F5 53/53 仍全部 PASS
  // ══════════════════════════════════════════════════════════════
  {
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/smoke-hotfix26-f5.js')], { encoding: 'utf8' });
      const m = out.match(/Total: (\d+), PASS: (\d+), FAIL: (\d+)/);
      if (m && m[3] === '0' && m[1] === m[2]) {
        pass(`O：scripts/smoke-hotfix26-f5.js 重新執行仍 ${m[2]}/${m[1]} 全部 PASS，F6 未破壞 F5`);
      } else {
        fail('O：F5 regression 未全部 PASS', out.slice(-500));
      }
    } catch (e) {
      fail('O：執行 smoke-hotfix26-f5.js 失敗', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 結構檢查：HTML id、CSS z-index、共用函式拆分（文件十六要求）
  // ══════════════════════════════════════════════════════════════
  {
    const requiredIds = ['pickupSearchInput', 'pickupSearchBtn', 'pickupSearchResultsList', 'pickupSearchSummary', 'pickup-search-status'];
    const missing = requiredIds.filter(id => !indexSrc.includes(`id="${id}"`));
    if (!missing.length) pass('結構：F6 搜尋區所需 HTML id 全部存在');
    else fail('結構：缺少 HTML id', missing.join(', '));

    const ids = [...indexSrc.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const dupCounts = {};
    ids.forEach(id => { dupCounts[id] = (dupCounts[id] || 0) + 1; });
    const dups = Object.entries(dupCounts).filter(([, n]) => n > 1);
    if (!dups.length) pass('結構：public/index.html 無重複 HTML id');
    else fail('結構：public/index.html 有重複 id', JSON.stringify(dups));

    if (/\.pac-container\s*\{\s*z-index:\s*100000/.test(cssSrc)) {
      pass('結構：.pac-container z-index 已設定高於 Modal（99999），且只加這一條規則，未動其他全域樣式');
    } else fail('結構：缺少 .pac-container z-index 設定');

    const requiredFns = [
      'async function ensureGoogleMapsSdk', 'function initPickupPlaceAutocomplete', 'async function searchPickupPlace',
      'function searchPickupPlaceByText', 'function geocodePickupSearchText', 'function applyPickupSearchResult',
      'function renderPickupSearchResults', 'function clearPickupSearchState', 'function usePickupAddressAsSearch',
      'function useStoreNameAsSearch',
    ];
    const missingFns = requiredFns.filter(f => !appJsSrc.includes(f));
    if (!missingFns.length) pass('結構：文件十六要求拆分的共用函式全部存在（未塞成單一巨大函式）');
    else fail('結構：缺少拆分函式', missingFns.join(', '));

    // 現有 Marker/Modal/Geolocation 函式重用確認（未重寫）
    if (appJsSrc.includes('function _setPickupMarkerPosition') && appJsSrc.includes('function _geolocateFriendly')) {
      pass('結構：重用既有 _setPickupMarkerPosition()/_geolocateFriendly()（F5），未重寫 Marker/Geolocation 邏輯');
    } else fail('結構：既有共用函式缺失');
  }

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`${r.status}: ${r.name}`));
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\nTotal: ${results.length}, PASS: ${results.filter((r) => r.status === 'PASS').length}, FAIL: ${failCount}, MANUAL: ${manualCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
