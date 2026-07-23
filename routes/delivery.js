// routes/delivery.js — C3：距離級距滿額免運
// 外送費後端計算（Google Routes API computeRoutes）。
// 前端傳來的 delivery_fee 完全不信任，一律後端重算；本檔案與 routes/line-orders.js
// 的 recalcDeliveryFee() 共用同一份 utils/deliveryFeeCalc.js 計算引擎，避免兩處各自
// 實作導致「前台顯示折抵、購物車/訂單金額卻沒扣除」的不一致 Bug（C2 版根因）。
'use strict';
const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { getDb } = require('../utils/db');
const { calculateDeliveryFeeWithPromotion } = require('../utils/deliveryFeeCalc');

const SERVER_KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || '';

// ── 取得 settings value helper ─────────────────────────
function getSetting(db, storeId, key, defaultVal = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : defaultVal;
}

// ── Google Routes API：取得 driving distance（公里）────
async function getDrivingDistanceKm(originLat, originLng, destLat, destLng) {
  const key = SERVER_KEY();
  if (!key) throw new Error('GOOGLE_MAPS_SERVER_KEY 未設定');

  const body = {
    origin: {
      location: { latLng: { latitude: originLat, longitude: originLng } },
    },
    destination: {
      location: { latLng: { latitude: destLat, longitude: destLng } },
    },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    languageCode: 'zh-TW',
  };

  const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type':        'application/json',
      'X-Goog-Api-Key':      key,
      'X-Goog-FieldMask':    'routes.distanceMeters',
    },
    body: JSON.stringify(body),
    timeout: 10000,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Routes API HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!data.routes || data.routes.length === 0) {
    throw new Error('Routes API 無法找到路線');
  }

  const distMeters = data.routes[0].distanceMeters;
  if (typeof distMeters !== 'number') throw new Error('Routes API 回傳距離無效');

  return Math.round(distMeters / 10) / 100; // 公尺 → 公里，保留兩位小數
}

// ── 讀取店家距離級距規則（升序） ────────────────────────
function loadDistanceRules(db, storeId) {
  let rulesRaw = getSetting(db, storeId, 'delivery_distance_fee_rules', '');
  let rules = [];
  try {
    rules = JSON.parse(rulesRaw);
    if (!Array.isArray(rules)) rules = [];
    rules.sort((a, b) => Number(a.max_km) - Number(b.max_km));
  } catch { rules = []; }
  return rules;
}

function loadLegacySettings(db, storeId) {
  return {
    delivery_free_enabled:    getSetting(db, storeId, 'delivery_free_enabled', ''),
    delivery_free_threshold:  getSetting(db, storeId, 'delivery_free_threshold', '1000'),
    delivery_free_mode:       getSetting(db, storeId, 'delivery_free_mode', ''),
    delivery_basic_fee:       getSetting(db, storeId, 'delivery_basic_fee', '50'),
  };
}

// ── POST /api/delivery/calculate-fee ─────────────────
// body: { order_mode, subtotal, delivery_address, delivery_lat, delivery_lng }
//
// resp（統一契約，見需求文件二）：
//   { success, ok, distance_km, raw_fee, delivery_discount, delivery_fee,
//     is_free_delivery, free_rule_applied, free_rule_type, free_threshold,
//     free_discount_value, remaining_for_free_delivery, out_of_range, reason,
//     matched_max_km, maps_url, message }
router.post('/calculate-fee', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    const { order_mode, subtotal, delivery_lat, delivery_lng } = req.body;

    // 非外送模式：直接免費
    if (order_mode !== 'delivery') {
      return res.json({
        success: true, ok: true, distance_km: 0,
        delivery_fee: 0, raw_fee: 0, delivery_discount: 0,
        is_free_delivery: true, free_rule_applied: false, free_rule_type: 'none',
        free_threshold: 0, free_discount_value: 0, remaining_for_free_delivery: 0,
        out_of_range: false, reason: null,
        message: '非外送模式，無外送費',
      });
    }

    // 必須有客戶座標
    const destLat = parseFloat(delivery_lat);
    const destLng = parseFloat(delivery_lng);
    if (isNaN(destLat) || isNaN(destLng)) {
      return res.status(400).json({ success: false, ok: false, message: '請提供有效的外送地址座標' });
    }

    // 讀取店家設定
    const distanceFeeEnabled = getSetting(db, storeId, 'delivery_distance_fee_enabled', '1') === '1';
    const storeLat  = parseFloat(getSetting(db, storeId, 'store_lat', ''));
    const storeLng  = parseFloat(getSetting(db, storeId, 'store_lng', ''));
    const maxDistKm = parseFloat(getSetting(db, storeId, 'delivery_max_distance_km', '7'));
    const basicFee  = parseFloat(getSetting(db, storeId, 'delivery_basic_fee', '50'));
    const sub       = parseFloat(subtotal) || 0;
    const rules     = loadDistanceRules(db, storeId);
    const legacySettings = loadLegacySettings(db, storeId);

    // 若未啟用距離計費，直接用基本費（不套用滿額優惠，維持既有固定費行為）
    if (!distanceFeeEnabled) {
      return res.json({
        success: true, ok: true, distance_km: 0,
        delivery_fee: basicFee, raw_fee: basicFee, delivery_discount: 0,
        is_free_delivery: false, free_rule_applied: false, free_rule_type: 'none',
        free_threshold: 0, free_discount_value: 0, remaining_for_free_delivery: 0,
        out_of_range: false, reason: null,
        message: `固定外送費 NT$${basicFee}`,
      });
    }

    // 必須有店家座標才能計算
    if (isNaN(storeLat) || isNaN(storeLng) || !storeLat || !storeLng) {
      return res.status(503).json({ success: false, ok: false, message: '店家座標尚未設定，無法計算外送費，請聯絡店家' });
    }

    // 呼叫 Google Routes API
    let distKm;
    try {
      distKm = await getDrivingDistanceKm(storeLat, storeLng, destLat, destLng);
    } catch (gErr) {
      console.error('[delivery/calculate-fee] Routes API 失敗:', gErr.message);
      return res.status(503).json({
        success: false, ok: false,
        message: '外送距離計算暫時無法使用，請稍後再試或改選外帶取餐',
        reason: 'maps_unavailable',
      });
    }

    // 檢查最大外送距離（滿額優惠不得解除此限制）
    if (distKm > maxDistKm) {
      return res.status(400).json({
        success: false, ok: false,
        message: `距離 ${distKm} 公里，超過本店外送範圍（最遠 ${maxDistKm} 公里），請改選外帶取餐`,
        reason: 'out_of_range', out_of_range: true,
        distance_km: distKm,
      });
    }

    // ── 統一計算引擎 ──────────────────────────────────
    const calc = calculateDeliveryFeeWithPromotion({
      distanceKm: distKm, eligibleSubtotal: sub, distanceRules: rules,
      legacySettings, maxDistanceKm: maxDistKm,
    });

    if (calc.outOfRange || !calc.matchedRule) {
      return res.status(400).json({
        success: false, ok: false,
        message: `距離 ${distKm} 公里，超過外送費級距設定範圍，請改選外帶取餐`,
        reason: 'out_of_range', out_of_range: true,
        distance_km: distKm,
      });
    }

    const isFreeDelivery = calc.finalFee === 0 && calc.rawFee > 0;
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${storeLat},${storeLng}&destination=${destLat},${destLng}&travelmode=driving`;

    const feeMsg = isFreeDelivery
      ? `距離 ${distKm} 公里，滿額免運！`
      : calc.discount > 0
        ? `距離 ${distKm} 公里，外送費 NT$${calc.finalFee}（滿額折抵 NT$${calc.discount}）`
        : `距離 ${distKm} 公里，外送費 NT$${calc.finalFee}`;

    // free_discount_value：這個級距「設定上」的折抵值（full=原始外送費 / fixed=設定的固定折抵金額），
    // 不受是否已達標影響，供前台「達標後折多少」文案使用（需求文件十二）。
    const freeDiscountValue = calc.promotionMode === 'full'
      ? calc.rawFee
      : (calc.promotionMode === 'fixed' ? calc.configuredFixedDiscount : 0);

    return res.json({
      success:         true,
      ok:              true,
      distance_km:     distKm,
      raw_fee:               calc.rawFee,
      delivery_discount:     calc.discount,
      delivery_fee:          calc.finalFee,
      is_free_delivery:      isFreeDelivery,
      free_rule_applied:     calc.reached,
      free_rule_type:        calc.promotionMode,
      free_threshold:        calc.threshold,
      free_discount_value:   freeDiscountValue,
      remaining_for_free_delivery: calc.remaining,
      out_of_range:    false,
      reason:          null,
      matched_max_km:  calc.matchedRule ? Number(calc.matchedRule.max_km) : null,
      maps_url:        mapsUrl,
      message:         feeMsg,
    });

  } catch (e) {
    console.error('[delivery/calculate-fee]', e.message);
    return res.status(500).json({ success: false, ok: false, message: e.message });
  }
});

module.exports = router;
