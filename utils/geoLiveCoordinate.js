// utils/geoLiveCoordinate.js — fix18-10-hotfix30-B5-R5.4-G1-B
// Geo Intelligence V2 — Live Coordinate Acquisition
//
// 唯一目的：驗證並寫入「使用者裝置自己回報」的真實座標，供 Live Marker 使用。
//
// 允許的來源白名單（GEO_LIVE_COORD_SOURCES）——決策記錄：
//   browser_geolocation      — navigator.geolocation.getCurrentPosition()
//                               （W3C Geolocation API）。桌面瀏覽器一般用
//                               Wi-Fi/IP 訊號估算；手機瀏覽器在使用者同意後，
//                               作業系統會視情況直接動用 GPS 晶片（也是走這同一
//                               套 Web API，見架構文件「三、GPS（手機）」）。
//   google_geolocation_api   — Google Geolocation REST API
//                               （https://www.googleapis.com/geolocation/v1/
//                               geolocate），只有在「呼叫端真的提供 wifi
//                               access point／cell tower 訊號」時才允許使用；
//                               若沒有真實訊號輸入，Google 端會自動退回
//                               IP 估算——這正是使用者明確禁止的行為，因此
//                               本模組要求呼叫端必須先自行確認訊號輸入存在，
//                               沒有訊號輸入就不得呼叫這條路徑（見
//                               routes/geo-live.js 的呼叫端註解與誠實揭露）。
//
// 明確不允許：任何 IP-based 估算、行政區/店家/矩形中心點座標、Math.random()
// 產生的座標、或任何「猜測」補值。驗證失敗一律回傳 { ok:false }，呼叫端必須
// 讓該訪客維持 Unknown（不得畫 Marker），不得靜默 fallback。

'use strict';

const GEO_LIVE_COORD_SOURCES = Object.freeze(['browser_geolocation', 'google_geolocation_api']);

function _isFiniteNum(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

// 驗證：型別、範圍、以及「Null Island」(0,0) 這種常見的無效/未初始化座標。
function validateCoordinate(input) {
  const i = input || {};
  if (!i.store_id || typeof i.store_id !== 'string') return { ok: false, reason: 'store_id 必填' };
  if (!i.visitor_id || typeof i.visitor_id !== 'string') return { ok: false, reason: 'visitor_id 必填' };
  if (!i.session_id || typeof i.session_id !== 'string') return { ok: false, reason: 'session_id 必填' };
  if (!GEO_LIVE_COORD_SOURCES.includes(i.source)) {
    return { ok: false, reason: `source 必須是 ${GEO_LIVE_COORD_SOURCES.join('/')} 其中之一` };
  }
  if (!_isFiniteNum(i.lat) || !_isFiniteNum(i.lng)) return { ok: false, reason: 'lat/lng 必須是有效數字' };
  const lat = Number(i.lat);
  const lng = Number(i.lng);
  if (lat < -90 || lat > 90) return { ok: false, reason: 'lat 超出 -90..90 範圍' };
  if (lng < -180 || lng > 180) return { ok: false, reason: 'lng 超出 -180..180 範圍' };
  // (0,0) 幾乎必定是裝置初始化失敗或未取得定位時的預設殘留值，不是真實座標
  // （落在大西洋幾內亞灣外海）；一律拒絕，避免污染地圖。
  if (lat === 0 && lng === 0) return { ok: false, reason: '(0,0) 視為無效座標（Null Island），拒絕寫入' };
  let accuracy = null;
  if (i.accuracy_m !== undefined && i.accuracy_m !== null) {
    if (!_isFiniteNum(i.accuracy_m) || Number(i.accuracy_m) < 0) return { ok: false, reason: 'accuracy_m 必須是非負數字' };
    accuracy = Number(i.accuracy_m);
    // 精確度極差（>50km）的定位對「Live Marker」幾乎沒有意義，且容易誤導成
    // 精確定位；誠實地拒絕而不是畫一個看起來很精確但其實誤差極大的點。
    if (accuracy > 50000) return { ok: false, reason: `accuracy_m (${accuracy}) 超過可接受上限（50000 公尺），視為不可靠定位` };
  }
  return {
    ok: true,
    value: {
      store_id: String(i.store_id).slice(0, 100),
      visitor_id: String(i.visitor_id).slice(0, 200),
      session_id: String(i.session_id).slice(0, 200),
      lat, lng, accuracy_m: accuracy,
      source: i.source,
    },
  };
}

// 寫入：fail-open（絕不拋出例外中斷呼叫端），但驗證失敗一律回傳 false，
// 不寫入任何資料列（誠實：沒有真實座標就是沒有，不得補一筆「看起來合理」的值）。
function recordLiveCoordinate(db, input) {
  const v = validateCoordinate(input);
  if (!v.ok) return { ok: false, reason: v.reason };
  try {
    const c = v.value;
    db.run(
      `INSERT INTO geo_live_coordinates (store_id, visitor_id, session_id, lat, lng, accuracy_m, source, captured_at)
       VALUES (?,?,?,?,?,?,?, datetime('now'))`,
      [c.store_id, c.visitor_id, c.session_id, c.lat, c.lng, c.accuracy_m, c.source]
    );
    return { ok: true };
  } catch (e) {
    console.warn('[geoLiveCoordinate] recordLiveCoordinate failed:', e.message);
    return { ok: false, reason: 'db_error' };
  }
}

// 讀取：某個 store 底下，時間範圍內，每位訪客「最新一筆」真實座標。
// 這是 Live Marker 圖層讀取真實座標的唯一入口——絕不用 city/district 中心點
// 或任何推定值代替這裡查不到的結果。
function getLatestCoordinatesByVisitor(db, storeId, sinceIso) {
  try {
    const rows = db.all(
      `SELECT visitor_id, session_id, lat, lng, accuracy_m, source, captured_at
       FROM geo_live_coordinates
       WHERE store_id = ? AND captured_at >= ?
       ORDER BY captured_at DESC`,
      [storeId, sinceIso]
    ) || [];
    const latestByVisitor = new Map();
    const latestBySession = new Map();
    for (const r of rows) {
      if (r.visitor_id && !latestByVisitor.has(r.visitor_id)) latestByVisitor.set(r.visitor_id, r);
      if (r.session_id && !latestBySession.has(r.session_id)) latestBySession.set(r.session_id, r);
    }
    return { byVisitor: latestByVisitor, bySession: latestBySession };
  } catch (e) {
    console.warn('[geoLiveCoordinate] getLatestCoordinatesByVisitor failed:', e.message);
    return { byVisitor: new Map(), bySession: new Map() };
  }
}

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1-C｜Coordinate Consent Status
//
// 需求文件二：座標同意與狀態。這裡記錄「每一次」定位嘗試的結果（不只是
// 成功的），供 Coverage KPI（總訪客/可畫座標/拒絕/逾時/不支援/無法取得/
// 未知）使用。跟 recordLiveCoordinate() 完全獨立——granted 且座標驗證通過
// 時，呼叫端（routes/geo-live.js）會「同時」呼叫這裡與 recordLiveCoordinate()，
// 兩張表各自負責一件事：geo_live_coordinates 只放「能拿來畫 Marker 的真實
// 座標」，這裡放「同意流程的完整稽核軌跡」。
// ══════════════════════════════════════════════════════════════════
const GEO_COORD_STATUSES = Object.freeze([
  'granted', 'denied', 'timeout', 'unavailable', 'unsupported', 'error', 'unknown',
]);

function recordCoordinateStatus(db, input) {
  const i = input || {};
  if (!i.store_id || !i.visitor_id || !i.session_id) return { ok: false, reason: 'store_id/visitor_id/session_id 必填' };
  const status = GEO_COORD_STATUSES.includes(i.status) ? i.status : 'unknown';
  let source = null;
  if (i.source !== undefined && i.source !== null) {
    // source 不強制列舉（denied/timeout 等狀態呼叫端可能還是想標明來源是
    // 'browser_geolocation' 嘗試失敗，而不是 google_geolocation_api），但仍
    // 做長度限制與型別清洗，不信任任意字串直接寫入。
    source = String(i.source).slice(0, 50);
  }
  let accuracy = null;
  if (i.accuracy_m !== undefined && i.accuracy_m !== null && _isFiniteNum(i.accuracy_m) && Number(i.accuracy_m) >= 0) {
    accuracy = Number(i.accuracy_m);
  }
  try {
    db.run(
      `INSERT INTO geo_coordinate_status_log (store_id, visitor_id, session_id, status, source, accuracy_m, captured_at)
       VALUES (?,?,?,?,?,?, datetime('now'))`,
      [String(i.store_id).slice(0, 100), String(i.visitor_id).slice(0, 200), String(i.session_id).slice(0, 200), status, source, accuracy]
    );
    return { ok: true, status };
  } catch (e) {
    console.warn('[geoLiveCoordinate] recordCoordinateStatus failed:', e.message);
    return { ok: false, reason: 'db_error' };
  }
}

// Coverage 摘要：依「每位訪客最新一筆狀態」計算（同一訪客反覆嘗試只算最新
// 結果，不會因為使用者拒絕後重試一次成功，就把同一人同時算進 denied 又算
// 進 granted）。
function getCoordinateStatusSummary(db, storeId, sinceIso) {
  try {
    const rows = db.all(
      `SELECT visitor_id, session_id, status, captured_at
       FROM geo_coordinate_status_log
       WHERE store_id = ? AND captured_at >= ?
       ORDER BY captured_at DESC`,
      [storeId, sinceIso]
    ) || [];
    const latestByKey = new Map();
    for (const r of rows) {
      const key = r.visitor_id || r.session_id;
      if (!key || latestByKey.has(key)) continue;
      latestByKey.set(key, r.status);
    }
    const counts = { granted: 0, denied: 0, timeout: 0, unavailable: 0, unsupported: 0, error: 0, unknown: 0 };
    for (const status of latestByKey.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status]++;
      else counts.unknown++;
    }
    const total = latestByKey.size;
    return { total_reporting_visitors: total, ...counts };
  } catch (e) {
    console.warn('[geoLiveCoordinate] getCoordinateStatusSummary failed:', e.message);
    return { total_reporting_visitors: 0, granted: 0, denied: 0, timeout: 0, unavailable: 0, unsupported: 0, error: 0, unknown: 0 };
  }
}

module.exports = {
  GEO_LIVE_COORD_SOURCES,
  validateCoordinate,
  recordLiveCoordinate,
  getLatestCoordinatesByVisitor,
  // fix18-10-hotfix30-B5-R5.4-G1-C（Consent Status）
  GEO_COORD_STATUSES,
  recordCoordinateStatus,
  getCoordinateStatusSummary,
};
