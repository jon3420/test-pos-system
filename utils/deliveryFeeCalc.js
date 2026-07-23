// utils/deliveryFeeCalc.js — C3：距離級距滿額免運（單一計算來源）
//
// 本檔案是「外送費 + 滿額優惠折抵」計算的唯一實作。routes/delivery.js（前台試算 API）
// 與 routes/line-orders.js（送單時後端重算）都必須呼叫這裡，禁止各自重寫一份公式，
// 否則會再度出現 C2 版「前台顯示折抵、但購物車/訂單金額沒扣除」的不一致 Bug。
//
// 核心口徑（見需求文件十一）：
//   rawFee    = 命中距離級距的原始外送費
//   discount  = 本次滿額規則實際折抵金額（never negative, never > rawFee）
//   finalFee  = Math.max(rawFee - discount, 0)
//
// 級距規則資料結構（delivery_distance_fee_rules，JSON array，需按 max_km 升序）：
//   { max_km, fee, free_threshold, free_mode: 'none'|'full'|'fixed', free_discount }
//
// 舊資料相容（見需求文件七）：
//   若命中的級距沒有完整 free_mode/free_threshold 欄位 → fallback 使用店家舊版全店
//   設定（delivery_free_enabled/delivery_free_threshold/delivery_free_mode/delivery_basic_fee）。
//   新舊規則都未啟用 → 不套用滿額優惠（discount = 0）。
'use strict';

const VALID_MODES = new Set(['none', 'full', 'fixed']);

// 由小到大找第一個 distanceKm <= max_km 的級距（呼叫前 rules 需已升序排列，這裡仍保險排序一次）
function pickDistanceRule(rules, distanceKm) {
  const list = Array.isArray(rules) ? rules.slice() : [];
  list.sort((a, b) => Number(a.max_km) - Number(b.max_km));
  const found = list.find((r) => distanceKm <= Number(r.max_km));
  return found || null;
}

// 判斷該筆命中的級距是否有「完整」的免運欄位（三個都要有意義，否則視為未設定→fallback）
function ruleHasOwnPromotion(rule) {
  if (!rule) return false;
  const mode = rule.free_mode;
  if (!VALID_MODES.has(mode)) return false;
  // free_threshold 必須是可用的數字（含 0，0 視為「這個級距沒有門檻」但仍是「明確設定」）
  const th = rule.free_threshold;
  if (th === undefined || th === null || th === '') return false;
  if (isNaN(Number(th))) return false;
  return true;
}

// 布林設定值安全解析：避免 Boolean("0") === true 的陷阱
function toBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return defaultVal;
}

// 解析「這個級距實際適用」的滿額優惠設定（rule 自帶優先，否則 fallback 舊版全店設定）
// 回傳 { threshold, mode, fixedDiscount, source }
//   source: 'rule'（用該級距自己的設定）| 'legacy'（fallback 舊版全店設定）| 'none'（都沒有）
function resolvePromotion(rule, legacySettings) {
  const legacy = legacySettings || {};

  if (ruleHasOwnPromotion(rule)) {
    return {
      threshold: Math.max(Number(rule.free_threshold) || 0, 0),
      mode: rule.free_mode,
      fixedDiscount: Math.max(Number(rule.free_discount) || 0, 0),
      source: 'rule',
    };
  }

  // fallback 舊版全店規則：delivery_free_enabled 未設定時視為啟用（沿用既有正式環境行為，
  // 目前只有 delivery_free_threshold 真的被設定過，見需求文件七）
  const legacyEnabled = toBool(legacy.delivery_free_enabled, true);
  const legacyThreshold = Math.max(Number(legacy.delivery_free_threshold) || 0, 0);
  if (legacyEnabled && legacyThreshold > 0) {
    // 舊版 delivery_free_mode='distance_only' 語意上等同「固定折抵 delivery_basic_fee」，
    // 其餘（未設定或 'full'）視為「滿額全免」，與舊版 calcFee() 的實際行為一致。
    const legacyMode = legacy.delivery_free_mode === 'distance_only' ? 'fixed' : 'full';
    const legacyFixedDiscount = Math.max(Number(legacy.delivery_basic_fee) || 0, 0);
    return {
      threshold: legacyThreshold,
      mode: legacyMode,
      fixedDiscount: legacyFixedDiscount,
      source: 'legacy',
    };
  }

  return { threshold: 0, mode: 'none', fixedDiscount: 0, source: 'none' };
}

// ── 核心函式：calculateDeliveryFeeWithPromotion ──────────────────────────
// 入參：
//   distanceKm       — 實際外送距離（公里）
//   eligibleSubtotal — 滿額門檻判斷金額（商品類優惠券折扣後的 eligibleSubtotal，見需求文件十六）
//   distanceRules    — [{max_km, fee, free_threshold, free_mode, free_discount}, ...]
//   legacySettings   — { delivery_free_enabled, delivery_free_threshold, delivery_free_mode, delivery_basic_fee }
//   maxDistanceKm    — 本店最大外送距離（可省略；外層若已用這個擋過可不重複判斷，這裡仍會用
//                       「找不到任何命中級距」來判斷 outOfRange，兩者是獨立的防呆）
//
// 回傳：
//   { matchedRule, rawFee, threshold, promotionMode, discount, finalFee, reached, remaining, outOfRange }
function calculateDeliveryFeeWithPromotion({ distanceKm, eligibleSubtotal, distanceRules, legacySettings, maxDistanceKm } = {}) {
  const distKm = Number(distanceKm);
  const sub = Math.max(Number(eligibleSubtotal) || 0, 0);

  // 明確超過本店最大外送距離：滿額優惠一律不解除距離限制（需求文件二十）
  if (maxDistanceKm != null && !isNaN(Number(maxDistanceKm)) && distKm > Number(maxDistanceKm)) {
    return {
      matchedRule: null, rawFee: 0, threshold: 0, promotionMode: 'none',
      discount: 0, finalFee: 0, reached: false, remaining: 0, outOfRange: true,
    };
  }

  const matchedRule = pickDistanceRule(distanceRules, distKm);
  if (!matchedRule) {
    // 超過所有級距設定範圍，視同超距離（需求文件十）
    return {
      matchedRule: null, rawFee: 0, threshold: 0, promotionMode: 'none',
      discount: 0, finalFee: 0, reached: false, remaining: 0, outOfRange: true,
    };
  }

  const rawFee = Math.max(Number(matchedRule.fee) || 0, 0);
  const promo = resolvePromotion(matchedRule, legacySettings);
  const threshold = promo.threshold;
  const mode = promo.mode;
  const reached = threshold > 0 && sub >= threshold;

  let discount = 0;
  if (mode === 'full') {
    discount = reached ? rawFee : 0;
  } else if (mode === 'fixed') {
    discount = reached ? Math.min(promo.fixedDiscount, rawFee) : 0;
  } else {
    discount = 0; // 'none'
  }
  // 防負數（需求文件二十）：discount 永遠不超過 rawFee，finalFee 永遠 >= 0
  discount = Math.max(Math.min(discount, rawFee), 0);
  const finalFee = Math.max(rawFee - discount, 0);
  const remaining = threshold > 0 ? Math.max(threshold - sub, 0) : 0;

  return {
    matchedRule, rawFee, threshold, promotionMode: mode,
    discount, finalFee, reached, remaining, outOfRange: false,
    promotionSource: promo.source,
    // 設定值本身（未受 reached/rawFee 上限影響），供 API 顯示「這個級距設定的折抵值」用，
    // 例如 full 模式即使尚未達標，也能告訴前台「達標後折多少」。
    configuredFixedDiscount: promo.fixedDiscount,
  };
}

// ── normalizeDeliveryDistanceFeeRules ────────────────────────────────────
// 集中驗證＋正規化「距離級距＋各級距滿額免運」設定，供 routes/settings.js（後台儲存）
// 呼叫，避免前後端各自亂判斷格式（需求文件四）。
//
// 允許每筆輸入：{ max_km, fee, free_threshold?, free_mode?, free_discount? }
//   - free_mode 不存在／為空字串／為 'legacy' → 視為「這個級距沒有自己的促銷設定」，
//     只保留 { max_km, fee }，計算時交給 calculateDeliveryFeeWithPromotion() 的
//     legacy fallback（沿用全店 delivery_free_threshold 等舊設定）。
//   - free_mode === 'none'  → free_threshold 可為 0，free_discount 強制正規化為 0。
//   - free_mode === 'full'  → free_threshold 必須 > 0，free_discount 正規化為 0
//     （full 模式實際折抵永遠是 rawFee，不使用這個欄位，見 resolvePromotion()）。
//   - free_mode === 'fixed' → free_threshold 與 free_discount 皆必須 > 0。
//
// 回傳 { ok: true, rules } 或 { ok: false, message }。
function normalizeDeliveryDistanceFeeRules(input) {
  if (!Array.isArray(input)) {
    return { ok: false, message: '距離級距規則格式錯誤，需為陣列' };
  }
  if (input.length === 0) {
    return { ok: false, message: '至少需要一筆距離級距規則' };
  }

  const seenMaxKm = new Set();
  const normalized = [];

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const idx = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: `第 ${idx} 筆規則格式錯誤` };
    }

    const max_km = Number(raw.max_km);
    if (!isFinite(max_km) || max_km <= 0) {
      return { ok: false, message: `第 ${idx} 筆距離上限必須大於 0` };
    }
    const fee = Number(raw.fee);
    if (!isFinite(fee) || fee < 0) {
      return { ok: false, message: `第 ${idx} 筆外送費不可為負數` };
    }
    // 距離重複（用字串化到固定精度比較，避免 3 與 3.0 被當成不同值卻又被視為不重複的邊界問題）
    const maxKmKey = String(max_km);
    if (seenMaxKm.has(maxKmKey)) {
      return { ok: false, message: `距離上限 ${max_km} km 重複` };
    }
    seenMaxKm.add(maxKmKey);

    const entry = { max_km, fee };

    const rawMode = raw.free_mode;
    const isLegacySlot = rawMode === undefined || rawMode === null || rawMode === '' || rawMode === 'legacy';

    if (!isLegacySlot) {
      if (!VALID_MODES.has(rawMode)) {
        return { ok: false, message: `第 ${idx} 筆優惠模式不合法（${rawMode}）` };
      }
      const th   = Number(raw.free_threshold);
      const disc = Number(raw.free_discount);

      if (rawMode === 'none') {
        entry.free_mode = 'none';
        entry.free_threshold = (isFinite(th) && th >= 0) ? th : 0;
        entry.free_discount = 0; // 正規化：不優惠模式強制歸零
      } else if (rawMode === 'full') {
        if (!isFinite(th) || th <= 0) {
          return { ok: false, message: `第 ${idx} 筆「滿額全免」必須設定大於 0 的滿額門檻` };
        }
        entry.free_mode = 'full';
        entry.free_threshold = th;
        entry.free_discount = 0; // 正規化：full 折抵永遠等於 rawFee，不使用這個欄位
      } else { // fixed
        if (!isFinite(th) || th <= 0) {
          return { ok: false, message: `第 ${idx} 筆「滿額固定折抵」必須設定大於 0 的滿額門檻` };
        }
        if (!isFinite(disc) || disc <= 0) {
          return { ok: false, message: `第 ${idx} 筆「滿額固定折抵」必須設定大於 0 的折抵金額` };
        }
        entry.free_mode = 'fixed';
        entry.free_threshold = th;
        entry.free_discount = disc;
      }
    }
    // isLegacySlot：不寫入 free_mode/free_threshold/free_discount，保持純 { max_km, fee }，
    // 交給 legacy fallback（需求文件七）。

    normalized.push(entry);
  }

  // 距離必須由小到大遞增（不是「可排序」，是輸入順序本身就必須遞增，逼店家照順序填寫，
  // 避免使用者誤以為填寫順序不影響命中邏輯）。
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].max_km <= normalized[i - 1].max_km) {
      return { ok: false, message: '距離級距必須由小到大遞增排列，且不可重複' };
    }
  }

  return { ok: true, rules: normalized };
}

module.exports = {
  calculateDeliveryFeeWithPromotion,
  pickDistanceRule,
  resolvePromotion,
  ruleHasOwnPromotion,
  normalizeDeliveryDistanceFeeRules,
};
