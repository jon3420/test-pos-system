// utils/taiwanGeoNormalize.js — fix18-10-hotfix30-B5-R5.2-A
// Taiwan Administrative Area Intelligence — 全台行政區智慧分析中心
//
// R5.1-D 版本只硬編了桃園市 13 個行政區的別名表。R5.2-A 全面提升為全台
// 22 縣市 × 368 鄉鎮市區，資料來源見 data/taiwan-administrative-areas.json
// 與 data/taiwan-administrative-areas.manifest.json（記錄來源／版本／
// 抓取日期／checksum，見需求文件三、十八）。
//
// 名詞使用通用名稱（需求文件二）：
//   county       — 第一級行政區（直轄市／縣／市）
//   subdivision  — 第二級行政區（區／鄉／鎮／縣轄市），不強稱為 district
//   subdivision_type — '區' | '市' | '鎮' | '鄉'
// 既有的 geo_district 欄位／resolution 值為了向下相容繼續保留，本檔案的
// normalizeTaiwanGeo()（R5.1-D 舊介面）維持完全相同的輸入輸出格式，供
// utils/geoProviders/index.js 等既有呼叫端不必修改就能運作（見需求文件
// 十九、向下相容）。

'use strict';

const fs = require('fs');
const path = require('path');

const DATASET_PATH = path.join(__dirname, '..', 'data', 'taiwan-administrative-areas.json');
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'taiwan-administrative-areas.manifest.json');

let _dataset = null;
let _manifest = null;
function _load() {
  if (_dataset) return _dataset;
  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  _manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  _dataset = raw;
  return _dataset;
}
function getManifest() {
  _load();
  return _manifest;
}

// ── 索引（建立一次，供所有查詢函式重用，不必每次都線性掃描 368 筆）──────
let _byCountyCode = null; // countyCode -> county row
let _bySubdivisionCode = null; // subdivisionCode -> subdivision row (含 county 欄位)
let _subdivisionNameIndex = null; // zh subdivision_name (含別名) -> [subdivision rows]（可能有多筆，即歧義）
let _countyAliasIndex = null; // 正規化後的別名字串 -> county_code

// R5.2-A（五、縣市正規化）：縣市別名表。刻意不把單獨的 "Hsinchu"／"Chiayi"
// （沒有 City/County 字尾）列進來——新竹/嘉義同時有市與縣，無法從裸字判斷，
// 依需求文件五「必須維持不確定，禁止猜測」。
const COUNTY_ALIASES = {
  '臺北市': ['臺北市', '台北市', 'Taipei', 'Taipei City'],
  '新北市': ['新北市', 'New Taipei', 'New Taipei City'],
  '桃園市': ['桃園市', '桃園縣', 'Taoyuan', 'Taoyuan City'], // 桃園縣為 2014 改制前舊名，仍可能出現在舊資料
  '臺中市': ['臺中市', '台中市', 'Taichung', 'Taichung City'],
  '臺南市': ['臺南市', '台南市', 'Tainan', 'Tainan City'],
  '高雄市': ['高雄市', 'Kaohsiung', 'Kaohsiung City'],
  '基隆市': ['基隆市', 'Keelung', 'Keelung City'],
  '新竹市': ['新竹市', 'Hsinchu City'], // 不含裸 "Hsinchu"，見上方說明
  '嘉義市': ['嘉義市', 'Chiayi City'], // 不含裸 "Chiayi"
  '新竹縣': ['新竹縣', 'Hsinchu County'],
  '苗栗縣': ['苗栗縣', 'Miaoli County', 'Miaoli'],
  '彰化縣': ['彰化縣', 'Changhua County', 'Changhua'],
  '南投縣': ['南投縣', 'Nantou County', 'Nantou'],
  '雲林縣': ['雲林縣', 'Yunlin County', 'Yunlin'],
  '嘉義縣': ['嘉義縣', 'Chiayi County'], // 不含裸 "Chiayi"
  '屏東縣': ['屏東縣', 'Pingtung County', 'Pingtung'],
  '宜蘭縣': ['宜蘭縣', 'Yilan County', 'Yilan'],
  '花蓮縣': ['花蓮縣', 'Hualien County', 'Hualien'],
  '臺東縣': ['臺東縣', '台東縣', 'Taitung County', 'Taitung'],
  '澎湖縣': ['澎湖縣', 'Penghu County', 'Penghu'],
  '金門縣': ['金門縣', 'Kinmen County', 'Kinmen', 'Quemoy'],
  '連江縣': ['連江縣', 'Lienchiang County', 'Matsu', 'Lienchiang County'],
};

function _norm(s) { return String(s || '').trim().toLowerCase(); }

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.5：GA4 City Dimension
// District→Parent County 白名單（需求文件二）。
//
// 範圍刻意限定：這張表只給 GA4 Realtime「city」這個粗粒度、本來就標示為
// 「僅供區域趨勢分析，非精確定位」的欄位使用（見 utils/ga4Realtime/
// index.js 的 DISCLAIMER），刻意不併入上面的 COUNTY_ALIASES／
// normalizeCounty()／resolveTaiwanAdministrativeArea()——那些函式被訂單
// 履行地址、外送地址解析等對「正確性」要求更高、且已知會被外送地址等
// 精確場景使用的流程共用（見 resolveStoredArea() 的 fulfillment context），
// 混進去風險更高。
//
// 已知風險（誠實記錄，不得隱藏，見
// R5.4-G1.5-B2.5_DISTRICT_NORMALIZATION_AUDIT.md 詳細分析）：
//   "Taoyuan District" 在全國行政區資料集中同時對應到「桃園市桃園區」與
//   「高雄市桃源區」——桃園與桃源中文不同字、但英文皆音譯為
//   Taoyuan／Taoyuan District，是資料集本身就存在的全國唯一性衝突，不是
//   本表誤植。本表仍選擇明確、單向對照到桃園市，是有意識、有記錄的業務
//   決策（GA4 Visitor Geo Layer 情境下，桃源區——人口約 4000 人的高雄山地
//   原住民鄉——產生「這家店」的 GA4 即時流量機率極低，遠低於桃園市桃園區
//   這個人口 20 萬以上的市中心行政區），不是沒注意到衝突就盲猜；也因此
//   刻意不把這個對照併入全域 COUNTY_ALIASES，避免同樣的取捨套用到外送
//   地址等「錯了會造成實際業務後果」的場景。
//   "Longtan District"／"龍潭區" 沒有這個問題——全國資料集中唯一對應桃園市
//   龍潭區，可以安全地當成明確別名，不是取捨，是單純正確。
const DISTRICT_PARENT_ALIASES = Object.freeze({
  '桃園市': [
    'Longtan District', 'Longtan Dist.', 'Longtan', '龍潭區',
    'Taoyuan District', 'Taoyuan Dist.', '桃園區',
  ],
});

// _normDistrict(s)：trim 前後空白＋大小寫不敏感＋把任何連續空白（含
// tab／換行，\s 涵蓋兩者）正規化成單一空白，避免 "Longtan  District"／
// "Longtan\tDistrict"／" Longtan District\n" 因為空白差異而查不到別名表。
function _normDistrict(s) {
  return String(s === undefined || s === null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

let _districtParentAliasIndex = null;
function _buildDistrictParentAliasIndex() {
  if (_districtParentAliasIndex) return;
  _buildIndexes();
  _districtParentAliasIndex = new Map();
  const ds = _load();
  Object.entries(DISTRICT_PARENT_ALIASES).forEach(([countyName, aliases]) => {
    const county = ds.counties.find((c) => c.county_name === countyName);
    if (!county) return; // 防禦性：資料集與別名表理論上應完全對齊
    aliases.forEach((a) => _districtParentAliasIndex.set(_normDistrict(a), county.county_code));
  });
}

// normalizeDistrictToParentCounty(value) → county row 或 null（不猜測，
// 只認得白名單裡明確列出的字串；沒有 "去掉 District 字尾剩下的文字直接當
// 縣市" 這種通用規則——見需求文件二「不得只做 city.replace(' District',
// '')」）。
function normalizeDistrictToParentCounty(value) {
  _buildDistrictParentAliasIndex();
  if (value === undefined || value === null) return null;
  const key = _normDistrict(value);
  if (!key) return null;
  const code = _districtParentAliasIndex.get(key);
  return code ? _byCountyCode.get(code) : null;
}

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2：全台唯一鄉鎮市區安全映射
//
// 背景：R5.4-G1.5-B2.5 的 DISTRICT_PARENT_ALIASES 只手動列了少數行政區
// （Longtan／Taoyuan），GA4 city 維度回傳的其他鄉鎮市區（Pingzhen／
// Yangmei／Banqiao／…）一律落入 unmapped。本輪不擴充手動白名單，改為
// 重用既有 368 筆全台權威 subdivision 資料與其既有的 _subdivisionNameIndex
// （_buildIndexes() 已經把每個 subdivision 的中文全名／英文全名／資料集內
// aliases 全部索引進同一份 Map，同一個 alias 對到多個不同 subdivision_code
// 時，Map 的 value 陣列天然就會有多筆——這就是「全國唯一性」判斷所需要的
// 候選清單，不必另外複製一份行政區資料或另建 Alias Registry）。
//
// resolveUniqueSubdivisionParentCounty(rawName) 是最低層共用 Helper：
//   - candidates.length === 0                  → status: 'unknown'
//   - candidates 對應 >1 個不同 subdivision_code → status: 'ambiguous'
//   - 其餘（1 個或多個 alias record 但同一個 subdivision_code）→ status: 'unique'
// 呼叫端（目前只有 utils/ga4Realtime/index.js）自行決定 unknown/ambiguous
// 時如何處理（目前都是 unmapped，不猜測）。
//
// 本函式刻意「只」比對既有資料集的 aliases 陣列，唯一額外處理的是輸入端
// 「District / Dist.」標準句點差異正規化（見需求文件四）——因為資料集裡
// 本來就沒有 "Pingzhen Dist." 這種縮寫變體，屬於輸入正規化範疇，不是新增
// 資料。這裡完全不使用模糊比對／Levenshtein／contains／startsWith／任意
// strip 後綴猜測。
function _normSubdivisionAliasInput(s) {
  if (s === undefined || s === null) return '';
  let v = String(s);
  if (typeof v.normalize === 'function') v = v.normalize('NFC'); // Unicode 安全正規化
  v = v.replace(/[\t\n\r]+/g, ' '); // tab／newline 正規化成空白
  v = v.trim();
  v = v.replace(/\s+/g, ' '); // 連續空白折疊成單一空白
  return v.toLowerCase(); // 英文大小寫不敏感
}

function _subdivisionCandidatesForAlias(normalizedKey) {
  _buildIndexes();
  if (!normalizedKey) return [];
  return _subdivisionNameIndex.get(normalizedKey) || [];
}

const _UNMAPPABLE_LITERALS = new Set(['(not set)', 'unknown', 'null', 'undefined', '']);

function resolveUniqueSubdivisionParentCounty(rawName) {
  _buildIndexes();
  if (rawName === undefined || rawName === null) return { status: 'unknown', candidates: [] };
  const trimmedRaw = String(rawName).trim();
  if (!trimmedRaw) return { status: 'unknown', candidates: [] }; // F. 空白 → unmapped，不猜測

  const normalized = _normSubdivisionAliasInput(rawName);
  if (_UNMAPPABLE_LITERALS.has(normalized)) return { status: 'unknown', candidates: [] }; // F. (not set)/unknown/null

  let candidates = _subdivisionCandidatesForAlias(normalized);

  // 標準句點差異：District / Dist.（需求文件四）。資料集 aliases 本身沒有
  // "Dist." 縮寫變體，只在這裡做一次確定性的字尾替換再重查，不是模糊比對。
  if (!candidates.length && /\bdist\.$/.test(normalized)) {
    const expanded = normalized.replace(/\bdist\.$/, 'district');
    candidates = _subdivisionCandidatesForAlias(expanded);
  }

  if (!candidates.length) return { status: 'unknown', candidates: [] }; // A. 無候選

  const uniqueCodes = Array.from(new Set(candidates.map((c) => c.subdivision_code)));
  if (uniqueCodes.length > 1) {
    // B. 多個不同 subdivision_code → ambiguous，不猜測
    return {
      status: 'ambiguous',
      candidates: candidates.map((c) => ({
        county_code: c.county_code, county_name: c.county_name,
        subdivision_code: c.subdivision_code, subdivision_name: c.subdivision_name,
        canonical_name: c.subdivision_name_en || c.subdivision_name,
        administrative_type: c.subdivision_type, source: 'authoritative_taiwan_administrative_areas',
      })),
    };
  }

  // C／D. 只對應一個 subdivision_code（可能有多筆 alias record 指向同一筆，
  // 視為安全重複，仍是唯一候選）。
  const sub = candidates[0];
  const county = _byCountyCode.get(sub.county_code) || null;
  return {
    status: 'unique',
    county_code: sub.county_code,
    county_name: (county && county.county_name) || sub.county_name,
    subdivision_code: sub.subdivision_code,
    subdivision_name: sub.subdivision_name,
    subdivision_type: sub.subdivision_type,
    canonical_name: sub.subdivision_name_en || sub.subdivision_name,
    source: 'authoritative_unique_subdivision',
  };
}

function _buildIndexes() {
  if (_byCountyCode) return;
  const ds = _load();
  _byCountyCode = new Map();
  ds.counties.forEach((c) => _byCountyCode.set(c.county_code, c));

  _bySubdivisionCode = new Map();
  _subdivisionNameIndex = new Map();
  ds.subdivisions.forEach((s) => {
    _bySubdivisionCode.set(s.subdivision_code, s);
    const keys = new Set([s.subdivision_name, s.subdivision_name_en, ...(s.aliases || [])].map(_norm));
    keys.forEach((k) => {
      if (!_subdivisionNameIndex.has(k)) _subdivisionNameIndex.set(k, []);
      _subdivisionNameIndex.get(k).push(s);
    });
  });

  _countyAliasIndex = new Map();
  Object.entries(COUNTY_ALIASES).forEach(([countyName, aliases]) => {
    const county = ds.counties.find((c) => c.county_name === countyName);
    if (!county) return; // 防禦性：資料集與別名表理論上應完全對齊
    aliases.forEach((a) => _countyAliasIndex.set(_norm(a), county.county_code));
  });
}

// ── 對外查詢函式（需求文件六）───────────────────────────────────────────
function listCounties() {
  _buildIndexes();
  return _load().counties.slice();
}
function listSubdivisions(countyCode) {
  _buildIndexes();
  const ds = _load();
  if (!countyCode) return ds.subdivisions.slice();
  return ds.subdivisions.filter((s) => s.county_code === countyCode);
}
function getCountyByCode(code) {
  _buildIndexes();
  return _byCountyCode.get(code) || null;
}
function getSubdivisionByCode(code) {
  _buildIndexes();
  return _bySubdivisionCode.get(code) || null;
}

// normalizeCounty(value) → county row 或 null（無法辨識，不猜測）
function normalizeCounty(value) {
  _buildIndexes();
  if (!value) return null;
  const code = _countyAliasIndex.get(_norm(value));
  return code ? _byCountyCode.get(code) : null;
}

// normalizeSubdivision(value, countyHint) → subdivision row 或 null
//   - countyHint 有給定時：只在該縣市範圍內比對，避免跨縣市同名混淆
//     （需求文件七、八：「中正區」如果有縣市提示就用提示消歧）。
//   - countyHint 未給定時：若名稱在全台唯一，直接回傳；若有多筆（歧義），
//     回傳 null（呼叫端 resolveTaiwanAdministrativeArea() 會走 ambiguous
///    分支，見下方，不在這裡自己選第一筆）。
function normalizeSubdivision(value, countyHint) {
  _buildIndexes();
  if (!value) return null;
  const candidates = _subdivisionNameIndex.get(_norm(value)) || [];
  if (!candidates.length) return null;

  if (countyHint) {
    const countyRow = normalizeCounty(countyHint) || (_byCountyCode.has(countyHint) ? _byCountyCode.get(countyHint) : null);
    const countyCode = countyRow ? countyRow.county_code : null;
    if (!countyCode) return null; // county hint 本身無法辨識，不猜測
    const matched = candidates.filter((c) => c.county_code === countyCode);
    return matched.length === 1 ? matched[0] : null; // 理論上同一縣市內不會有同名 subdivision
  }

  return candidates.length === 1 ? candidates[0] : null; // 多筆候選＝歧義，交給上層處理
}

// resolveTaiwanAdministrativeArea(input) — 主要解析入口（需求文件六、七）
// input: { country, region, city, district, postalCode }
// 解析優先順序（需求文件七）：
//   1. 官方 subdivision code（若 input 直接帶 subdivision_code／district_code）
//   2. 郵遞區號＋縣市提示 —— 本輪資料集未包含郵遞區號資料，此優先序目前
//      永遠跳過，不臆測對照表（見 CHANGELOG Known Limitations）。
//   3. 縣市＋鄉鎮市區完整名稱／別名（中英文皆走同一個索引，見
//      _subdivisionNameIndex 的建立方式，因此第 3～5 項在本實作中合併為
//      同一步驟，用 countyHint 是否存在來分流，行為上等價）。
//   4. 縣市＋鄉鎮市區別名
//   5. 英文縣市＋英文 subdivision
//   6. 僅縣市
//   7. unknown
function resolveTaiwanAdministrativeArea(input = {}) {
  _buildIndexes();
  const { country, region, city, district, subdivision_code: explicitSubCode } = input;

  const base = { country_code: (country && String(country).toUpperCase() === 'TW') ? 'TW' : (country ? null : 'TW') };

  // 1. 官方代碼直接命中
  if (explicitSubCode) {
    const s = getSubdivisionByCode(explicitSubCode);
    if (s) {
      return {
        ...base,
        county_code: s.county_code, county_name: s.county_name,
        subdivision_code: s.subdivision_code, subdivision_name: s.subdivision_name, subdivision_type: s.subdivision_type,
        area_key: `${s.county_code}|${s.subdivision_code}`, area_label: `${s.county_name}－${s.subdivision_name}`,
        resolution: 'subdivision', confidence: 'exact',
      };
    }
  }

  const countyCandidate = city || region; // 縣市層級輸入可能來自 provider 的 city 或 region 欄位
  const countyRow = normalizeCounty(countyCandidate);

  // 3～5. 縣市 + 鄉鎮市區（中文全名／別名／英文皆由 normalizeSubdivision 統一處理）
  if (district) {
    if (countyRow) {
      const sub = normalizeSubdivision(district, countyRow.county_code);
      if (sub) {
        return {
          ...base,
          county_code: sub.county_code, county_name: sub.county_name,
          subdivision_code: sub.subdivision_code, subdivision_name: sub.subdivision_name, subdivision_type: sub.subdivision_type,
          area_key: `${sub.county_code}|${sub.subdivision_code}`, area_label: `${sub.county_name}－${sub.subdivision_name}`,
          resolution: 'subdivision', confidence: 'high',
        };
      }
      // 有縣市提示但這個縣市內找不到這個 subdivision 名稱 → 不強行猜測，
      // 降級為「僅縣市」（下方統一處理，不在這裡重複寫一次）。
    } else {
      // 沒有縣市提示：檢查名稱在全台是否唯一
      const candidates = _subdivisionNameIndex.get(_norm(district)) || [];
      const uniqueCounties = new Set(candidates.map((c) => c.county_code));
      if (candidates.length && uniqueCounties.size === 1) {
        const sub = candidates[0];
        return {
          ...base,
          county_code: sub.county_code, county_name: sub.county_name,
          subdivision_code: sub.subdivision_code, subdivision_name: sub.subdivision_name, subdivision_type: sub.subdivision_type,
          area_key: `${sub.county_code}|${sub.subdivision_code}`, area_label: `${sub.county_name}－${sub.subdivision_name}`,
          resolution: 'subdivision', confidence: 'medium',
        };
      }
      if (candidates.length && uniqueCounties.size > 1) {
        // 需求文件八：歧義時回傳 candidates 供呼叫端判斷是否要進一步詢問，
        // 但 Analytics 儲存層（見 geoResolver.js／analyticsLog.js）絕對不能
        // 把這個 candidates 陣列存進資料庫，只能存 unknown。
        return {
          ...base,
          resolution: 'ambiguous',
          confidence: 'unknown',
          candidates: candidates.map((c) => ({
            county_code: c.county_code, county_name: c.county_name,
            subdivision_code: c.subdivision_code, subdivision_name: c.subdivision_name,
            area_key: `${c.county_code}|${c.subdivision_code}`, area_label: `${c.county_name}－${c.subdivision_name}`,
          })),
        };
      }
    }
  }

  // 6. 僅縣市
  if (countyRow) {
    return {
      ...base,
      county_code: countyRow.county_code, county_name: countyRow.county_name,
      subdivision_code: null, subdivision_name: null, subdivision_type: null,
      area_key: `${countyRow.county_code}|unknown`, area_label: `${countyRow.county_name}－未辨識行政區`,
      resolution: 'county', confidence: 'medium',
    };
  }

  // 7. unknown
  return {
    country_code: base.country_code || null,
    county_code: null, county_name: null,
    subdivision_code: null, subdivision_name: null, subdivision_type: null,
    area_key: 'unknown', area_label: '未知區域',
    resolution: 'unknown', confidence: 'unknown',
  };
}

// ══════════════════════════════════════════════════════════════════
// 向下相容層（R5.1-D 舊介面，需求文件十九）
// ══════════════════════════════════════════════════════════════════
// normalizeTaiwanGeo({ city, district, region }) → { city, district }
// 呼叫端（utils/geoProviders/index.js 等）完全不需要修改，行為與 R5.1-D
// 一致：無法辨識回傳 null，不猜測；名稱歧義（例如裸的「中正區」沒有縣市
// 提示）一律視為無法辨識，回傳 null（對應 resolveTaiwanAdministrativeArea()
// 的 'ambiguous' 分支——見需求文件八：「Analytics 儲存結果不可保存完整候選
// 清單，只保存 unknown」，這裡的向下相容層本來就只回傳 city/district 兩個
// 欄位，天然滿足這個限制）。
function normalizeTaiwanGeo({ city, district, region } = {}) {
  const resolved = resolveTaiwanAdministrativeArea({ city, district, region });
  if (resolved.resolution === 'subdivision') {
    return { city: resolved.county_name, district: resolved.subdivision_name };
  }
  if (resolved.resolution === 'county') {
    return { city: resolved.county_name, district: null };
  }
  return { city: null, district: null }; // unknown / ambiguous
}

// 供 R5.1-D 既有測試/呼叫端相容：桃園市 13 行政區清單（R5.1-D 遺留常數，
// 現在從資料集動態算出，不再是手寫陣列）。
function _taoyuanDistricts() {
  _buildIndexes();
  const taoyuan = normalizeCounty('桃園市');
  if (!taoyuan) return [];
  return listSubdivisions(taoyuan.county_code).map((s) => s.subdivision_name);
}
const TAOYUAN_DISTRICTS = _taoyuanDistricts();

// buildAreaFieldsForApi(resolved) — 統一所有行政區 API 回傳格式（需求文件三）。
// 輸入可以是 resolveTaiwanAdministrativeArea() 的完整回傳，也可以是只有
// county_code/subdivision_code（例如從 DB 已存的官方代碼直接查表，見
// utils/geoDistrictAnalytics.js buildAreaFromCodes()）。'ambiguous' 一律
// 收斂成 unknown（需求文件八：Analytics 對外絕不暴露候選清單）。
function buildAreaFieldsForApi(resolved) {
  if (!resolved || resolved.resolution === 'ambiguous' || resolved.resolution === 'unknown') {
    return {
      county_code: null, county_name: null, subdivision_code: null, subdivision_name: null,
      subdivision_type: null, area_key: 'unknown', area_label: '未知區域', resolution: 'unknown',
    };
  }
  return {
    county_code: resolved.county_code, county_name: resolved.county_name,
    subdivision_code: resolved.subdivision_code, subdivision_name: resolved.subdivision_name,
    subdivision_type: resolved.subdivision_type, area_key: resolved.area_key, area_label: resolved.area_label,
    resolution: resolved.resolution,
  };
}

// 供 utils/geoDistrictAnalytics.js 等已經知道 county_code/subdivision_code
// （例如 DB 已存的官方代碼）時直接組出同一組欄位，不必重新走一次名稱解析。
function buildAreaFromCodes(countyCode, subdivisionCode) {
  if (!countyCode) return buildAreaFieldsForApi(null);
  const county = getCountyByCode(countyCode);
  if (!county) return buildAreaFieldsForApi(null);
  const countyOnlyResult = () => buildAreaFieldsForApi({
    resolution: 'county', county_code: county.county_code, county_name: county.county_name,
    subdivision_code: null, subdivision_name: null, subdivision_type: null,
    area_key: `${county.county_code}|unknown`, area_label: `${county.county_name}－未辨識行政區`,
  });
  if (!subdivisionCode) return countyOnlyResult();
  const sub = getSubdivisionByCode(subdivisionCode);
  if (!sub || sub.county_code !== countyCode) return countyOnlyResult();
  return buildAreaFieldsForApi({
    resolution: 'subdivision', county_code: sub.county_code, county_name: sub.county_name,
    subdivision_code: sub.subdivision_code, subdivision_name: sub.subdivision_name, subdivision_type: sub.subdivision_type,
    area_key: `${sub.county_code}|${sub.subdivision_code}`, area_label: `${sub.county_name}－${sub.subdivision_name}`,
  });
}

// validateAreaFilters({ countyCode, subdivisionCode }) — 共用行政區篩選器
// 驗證（需求文件 Stage 6）。所有支援 county_code/subdivision_code 篩選的
// Geo API 都呼叫這一個函式，不得各自重寫驗證邏輯（避免不同 API 對同樣的
// 錯誤輸入產生不同行為）。
//
// 回傳（成功）：{ ok:true, county_code, subdivision_code, county, subdivision }
//   - 兩者皆未提供 → county_code/subdivision_code/county/subdivision 皆為 null。
//   - 只給 subdivision_code → 允許由資料集反查 county_code（需求文件明確
//     採用這個規則，不要求前端一定要同時給兩個）。
// 回傳（失敗）：{ ok:false, status:400, error:<固定代碼>, message:<中文訊息> }
//   錯誤代碼固定為：unknown_county_code / unknown_subdivision_code /
//   subdivision_not_in_county / invalid_county_code / invalid_subdivision_code
//
// 空字串／純空白字串視為「未提供」而非錯誤（對應下拉選單重置為「全部」時
// 常見的傳值方式），只有型別本身不是 string/number（例如陣列、物件——常見
// 於 query string 被重複帶入變成陣列）才視為 invalid_*。
function _normalizeFilterValue(v) {
  if (v === undefined || v === null) return { present: false, value: null, typeError: false };
  if (typeof v !== 'string' && typeof v !== 'number') return { present: true, value: null, typeError: true };
  const s = String(v).trim();
  if (!s) return { present: false, value: null, typeError: false }; // 空字串/純空白 → 視為未提供
  return { present: true, value: s, typeError: false };
}

function validateAreaFilters({ countyCode, subdivisionCode } = {}) {
  _buildIndexes();
  const cc = _normalizeFilterValue(countyCode);
  const sc = _normalizeFilterValue(subdivisionCode);

  if (cc.typeError) return { ok: false, status: 400, error: 'invalid_county_code', message: '縣市代碼格式錯誤' };
  if (sc.typeError) return { ok: false, status: 400, error: 'invalid_subdivision_code', message: '行政區代碼格式錯誤' };

  // 1. 兩者皆未提供
  if (!cc.present && !sc.present) {
    return { ok: true, county_code: null, subdivision_code: null, county: null, subdivision: null };
  }

  // 3. 只有 subdivision_code：由資料集反查 county
  if (sc.present && !cc.present) {
    const sub = getSubdivisionByCode(sc.value);
    if (!sub) return { ok: false, status: 400, error: 'unknown_subdivision_code', message: '找不到指定行政區代碼' };
    const county = getCountyByCode(sub.county_code);
    return { ok: true, county_code: sub.county_code, subdivision_code: sub.subdivision_code, county, subdivision: sub };
  }

  // 2. 只有 county_code
  if (cc.present && !sc.present) {
    const county = getCountyByCode(cc.value);
    if (!county) return { ok: false, status: 400, error: 'unknown_county_code', message: '找不到指定縣市代碼' };
    return { ok: true, county_code: county.county_code, subdivision_code: null, county, subdivision: null };
  }

  // 4～7：county_code + subdivision_code 都給了
  const county = getCountyByCode(cc.value);
  if (!county) return { ok: false, status: 400, error: 'unknown_county_code', message: '找不到指定縣市代碼' };
  const sub = getSubdivisionByCode(sc.value);
  if (!sub) return { ok: false, status: 400, error: 'unknown_subdivision_code', message: '找不到指定行政區代碼' };
  if (sub.county_code !== county.county_code) {
    return { ok: false, status: 400, error: 'subdivision_not_in_county', message: '所選行政區不屬於指定縣市' };
  }
  return { ok: true, county_code: county.county_code, subdivision_code: sub.subdivision_code, county, subdivision: sub };
}

// resolveStoredArea(row, context) — 需求文件 Stage 7：從「已經存在 DB 裡的一列
// 資料」解析出統一行政區格式，取代各 query 函式各自寫一套「用 code、還是用
// 名稱」的判斷。
//
// 真實 schema 盤點結果（見 orders 表 PRAGMA table_info，本函式只使用確實
// 存在的欄位，不虛構）：
//   - 沒有 delivery_city / delivery_district 這種欄位——外送訂單只有一個
//     單一自由文字欄位 delivery_address，要從裡面解析出城市/行政區是
//     utils/geoResolver.js normalizeDeliveryGeo() 的職責（regex 解析），
//     不在這裡重做一次；本函式讀的是「已經解析完」的 fulfillment_geo_city/
//     fulfillment_geo_district（外送、宅配訂單建立當下都會寫入這兩欄）。
//   - shipping_city / shipping_district 是真實欄位（宅配訂單，使用者填寫的
//     收件地址縣市/行政區原始值，跟 fulfillment_geo_* 是兩份不同性質的資料：
//     一個是使用者輸入的原始值，一個是正規化後的結果）。
//
// context 分流（Stage 7.2 / 7.3）：
//   acquisition — 只允許 geo_county_code/geo_subdivision_code/geo_city/
//                 geo_district（以及相容別名 city/district），絕不讀取任何
//                 fulfillment_geo_*/shipping_* 欄位。
//   fulfillment — 只允許 fulfillment_geo_county_code/
//                 fulfillment_geo_subdivision_code/fulfillment_geo_city/
//                 fulfillment_geo_district/shipping_city/shipping_district，
//                 絕不讀取任何 geo_*（Visitor IP Geo）欄位。
// 兩者互相隔離，不得用其中一種覆蓋或補全另一種（見需求文件禁止事項）。
//
// Code 與名稱衝突規則（Stage 7.4）：有效官方 code 優先於名稱；code 無效
// （資料集查不到）才 fallback 用名稱重新解析。只有 subdivision_code、沒有
// county_code 時，允許用資料集反查 county（Stage 7.5）。
//
// context 不合法：拋 TypeError（Stage 7.6 明確要求不得默默 fallback acquisition）。
function _unknownAreaResult() {
  return {
    county_code: null, county_name: null, subdivision_code: null, subdivision_name: null,
    subdivision_type: null, area_key: 'unknown', area_label: '未知區域', resolution: 'unknown',
  };
}

function _areaFromCodes(countyCode, subdivisionCode) {
  if (!countyCode) return null;
  const county = getCountyByCode(countyCode);
  if (!county) return null; // 無效 county code -> 呼叫端 fallback 名稱
  if (subdivisionCode) {
    const sub = getSubdivisionByCode(subdivisionCode);
    if (sub && sub.county_code === county.county_code) {
      return buildAreaFieldsForApi({
        resolution: 'subdivision', county_code: sub.county_code, county_name: sub.county_name,
        subdivision_code: sub.subdivision_code, subdivision_name: sub.subdivision_name, subdivision_type: sub.subdivision_type,
        area_key: `${sub.county_code}|${sub.subdivision_code}`, area_label: `${sub.county_name}－${sub.subdivision_name}`,
      });
    }
    // subdivision code 無效或跟 county 對不起來：county code 本身仍有效，
    // 不整組放棄退回名稱——這正是 Stage 7.4「有效官方 code 優先」的核心：
    // 縣市層級的有效性，比行政區層級的失敗，優先權更高。
  }
  return buildAreaFieldsForApi({
    resolution: 'county', county_code: county.county_code, county_name: county.county_name,
    subdivision_code: null, subdivision_name: null, subdivision_type: null,
    area_key: `${county.county_code}|unknown`, area_label: `${county.county_name}－未辨識行政區`,
  });
}

function _areaFromSubdivisionCodeOnly(subdivisionCode) {
  if (!subdivisionCode) return null;
  const sub = getSubdivisionByCode(subdivisionCode);
  if (!sub) return null;
  return buildAreaFieldsForApi({
    resolution: 'subdivision', county_code: sub.county_code, county_name: sub.county_name,
    subdivision_code: sub.subdivision_code, subdivision_name: sub.subdivision_name, subdivision_type: sub.subdivision_type,
    area_key: `${sub.county_code}|${sub.subdivision_code}`, area_label: `${sub.county_name}－${sub.subdivision_name}`,
  });
}

function _areaFromNames(city, district) {
  if (!city && !district) return null;
  const resolved = resolveTaiwanAdministrativeArea({ city, district });
  if (resolved.resolution === 'subdivision' || resolved.resolution === 'county') {
    return buildAreaFieldsForApi(resolved);
  }
  return null;
}

function resolveStoredArea(row, context) {
  if (context !== 'acquisition' && context !== 'fulfillment') {
    throw new TypeError(`resolveStoredArea: invalid context "${context}" — must be 'acquisition' or 'fulfillment'`);
  }
  const r = row || {};

  if (context === 'acquisition') {
    const countyCode = r.geo_county_code || null;
    const subdivisionCode = r.geo_subdivision_code || null;
    const city = r.geo_city || r.city || null;
    const district = r.geo_district || r.district || null;

    if (countyCode) {
      const byCode = _areaFromCodes(countyCode, subdivisionCode);
      if (byCode) return byCode;
    } else if (subdivisionCode) {
      const bySub = _areaFromSubdivisionCodeOnly(subdivisionCode);
      if (bySub) return bySub;
    }
    const byName = _areaFromNames(city, district);
    if (byName) return byName;
    return _unknownAreaResult();
  }

  // fulfillment
  const countyCode = r.fulfillment_geo_county_code || null;
  const subdivisionCode = r.fulfillment_geo_subdivision_code || null;
  const fgCity = r.fulfillment_geo_city || null;
  const fgDistrict = r.fulfillment_geo_district || null;
  const shipCity = r.shipping_city || null;
  const shipDistrict = r.shipping_district || null;

  if (countyCode) {
    const byCode = _areaFromCodes(countyCode, subdivisionCode);
    if (byCode) return byCode;
  } else if (subdivisionCode) {
    const bySub = _areaFromSubdivisionCodeOnly(subdivisionCode);
    if (bySub) return bySub;
  }
  const byFulfillmentName = _areaFromNames(fgCity, fgDistrict);
  if (byFulfillmentName) return byFulfillmentName;
  const byShippingName = _areaFromNames(shipCity, shipDistrict);
  if (byShippingName) return byShippingName;
  return _unknownAreaResult();
}

module.exports = {
  // R5.2-A 全台引擎
  normalizeCounty,
  normalizeSubdivision,
  resolveTaiwanAdministrativeArea,
  getCountyByCode,
  getSubdivisionByCode,
  listCounties,
  listSubdivisions,
  getManifest,
  buildAreaFieldsForApi,
  buildAreaFromCodes,
  validateAreaFilters,
  resolveStoredArea,
  COUNTY_ALIASES,
  // R5.4-G1.5-B2.5：GA4 City Dimension District→Parent County 白名單
  normalizeDistrictToParentCounty,
  DISTRICT_PARENT_ALIASES,
  // R5.4-G1.6-GA4-H1.2：全台唯一鄉鎮市區安全映射（重用既有權威資料集，
  // 不建立第二套行政區資料）
  resolveUniqueSubdivisionParentCounty,
  // R5.1-D 向下相容
  normalizeTaiwanGeo,
  TAOYUAN_DISTRICTS,
};
