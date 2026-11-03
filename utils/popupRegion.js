// utils/popupRegion.js — R51
//
// 🚐 快閃取餐「縣市 → 行政區」地區資料的單一事實來源。
//
//   - 縣市／行政區一律正規化成系統既有的台灣行政區權威資料
//     （data/taiwan-administrative-areas.json，經 utils/taiwanGeoNormalize.js
//     的 normalizeCounty／normalizeSubdivision）——不另建第二份行政區清單。
//   - parseRegionFromAddress() 只做「地址開頭精確比對」：先比縣市（含 台／臺、
//     桃園縣 等既有別名），再比該縣市底下完整的鄉鎮市區名稱。比對不到就回
//     null（＝地區待補），不猜測、不呼叫 Google。只在 migration 回填與管理端
//     儲存時使用，公開頁載入時不做任何地理編碼。
//   - resolveSessionRegion()：公開分組用。場次自己的 snapshot 優先；場次沒有
//     地區、且地址與目前地點庫相同時，才採用地點庫的地區（讓管理員補完地點
//     後，舊場次可以進入正確分組，又不會把已搬家的地點錯套到舊場次）。
'use strict';

const geo = require('./taiwanGeoNormalize');
const pp = require('./popupPickup');

const POSTAL_RE = /^\d{3}(?:\d{2,3})?$/;

function regionFail(message) { pp.fail('POPUP_VALIDATION_ERROR', message, 400); }

function _str(v) { return typeof v === 'string' ? v.trim() : ''; }

// 管理端輸入正規化：空白＝未填（地區待補）；有填就必須是權威資料內的名稱，
// 行政區必須屬於該縣市。回傳 canonical 名稱（例如「台北市」→「臺北市」）。
function normalizeRegionInput(input) {
  const rawCity = _str(input && input.city);
  const rawDistrict = _str(input && input.district);
  const rawPostal = _str(input && input.postal_code);
  if (rawCity.length > 20 || rawDistrict.length > 20) regionFail('縣市／行政區長度超出限制');
  if (rawPostal && !POSTAL_RE.test(rawPostal)) regionFail('郵遞區號格式錯誤（3、5 或 6 碼數字）');
  if (!rawCity) {
    if (rawDistrict) regionFail('填寫行政區前請先選擇縣市');
    return { city: '', district: '', postal_code: rawPostal };
  }
  const county = geo.normalizeCounty(rawCity);
  if (!county) regionFail('縣市不在台灣行政區清單內');
  if (!rawDistrict) return { city: county.county_name, district: '', postal_code: rawPostal };
  const sub = geo.normalizeSubdivision(rawDistrict, county.county_name);
  if (!sub) regionFail(`「${rawDistrict.slice(0, 20)}」不是${county.county_name}的行政區`);
  return { city: county.county_name, district: sub.subdivision_name, postal_code: rawPostal };
}

let _prefixIndex = null;
function _buildPrefixIndex() {
  if (_prefixIndex) return _prefixIndex;
  const countyNames = [];
  geo.listCounties().forEach((c) => {
    const names = new Set([c.county_name]);
    if (c.county_name.startsWith('臺')) names.add('台' + c.county_name.slice(1));
    if (c.county_name === '桃園市') names.add('桃園縣');
    names.forEach((n) => countyNames.push({ prefix: n, county: c }));
  });
  countyNames.sort((a, b) => b.prefix.length - a.prefix.length);
  const subsByCounty = new Map();
  geo.listSubdivisions().forEach((s) => {
    if (!subsByCounty.has(s.county_code)) subsByCounty.set(s.county_code, []);
    subsByCounty.get(s.county_code).push(s);
  });
  subsByCounty.forEach((arr) => arr.sort((a, b) => b.subdivision_name.length - a.subdivision_name.length));
  _prefixIndex = { countyNames, subsByCounty };
  return _prefixIndex;
}

// 「320桃園市中壢區…」「台灣桃園市中壢區…」「臺北市大安區…」→ { city, district, postal_code }
function parseRegionFromAddress(address) {
  let a = _str(address);
  if (!a) return null;
  a = a.replace(/\s+/g, '');
  let postal = '';
  const pm = /^(\d{3}(?:\d{2,3})?)/.exec(a);
  if (pm) { postal = pm[1]; a = a.slice(pm[1].length); }
  a = a.replace(/^(?:台灣|臺灣|中華民國)/, '');
  const { countyNames, subsByCounty } = _buildPrefixIndex();
  const hit = countyNames.find((x) => a.startsWith(x.prefix));
  if (!hit) return null;
  const rest = a.slice(hit.prefix.length);
  const subs = subsByCounty.get(hit.county.county_code) || [];
  const sub = subs.find((s) => rest.startsWith(s.subdivision_name));
  if (!sub) return null; // 只有縣市沒有行政區，仍視為地區待補（分組需要兩層）
  return { city: hit.county.county_name, district: sub.subdivision_name, postal_code: POSTAL_RE.test(postal) ? postal : '' };
}

function resolveSessionRegion(session, location) {
  const sc = _str(session && session.city);
  const sd = _str(session && session.district);
  if (sc && sd) return { city: sc, district: sd, pending: false };
  if (location && _str(location.city) && _str(location.district) && _str(location.address) === _str(session && session.address)) {
    return { city: _str(location.city), district: _str(location.district), pending: false };
  }
  return { city: '', district: '', pending: true };
}

// 公開分組排序：同行政區內依取餐開始時間（日期＋時間）由近到遠，相同時間用
// 穩定的既有 id；全部場次產生一個 display_order，前端只依此排序，不自行比較。
function compareSessionsForDisplay(a, b) {
  const ka = `${a.pickup_date || ''} ${a.pickup_start_time || ''}`;
  const kb = `${b.pickup_date || ''} ${b.pickup_start_time || ''}`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ia = String(a.id || ''); const ib = String(b.id || '');
  return ia < ib ? -1 : (ia > ib ? 1 : 0);
}

// 管理端下拉選單用的權威清單（只有名稱，不含任何店家資料）。
function listRegionCatalog() {
  const subs = geo.listSubdivisions();
  return geo.listCounties().map((c) => ({
    city: c.county_name,
    districts: subs.filter((s) => s.county_code === c.county_code).map((s) => s.subdivision_name),
  }));
}

module.exports = { normalizeRegionInput, parseRegionFromAddress, resolveSessionRegion, compareSessionsForDisplay, listRegionCatalog, POSTAL_RE };
