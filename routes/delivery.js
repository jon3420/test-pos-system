// routes/delivery.js — fix18-06
// 外送費後端計算（Google Routes API computeRoutes）
// 前端傳來的 delivery_fee 完全不信任，一律後端重算。
'use strict';
const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');
const { getDb } = require('../utils/db');

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

// ── 依級距規則計算外送費 ──────────────────────────────
// rules: [{ max_km, fee }, ...] 須按 max_km 升序排列
// 回傳 { rawFee, deliveryFee, isFreeDelivery }
function calcFee({ distKm, subtotal, rules, basicFee, freeThreshold }) {
  // 找第一個 max_km >= distKm 的級距
  const matched = rules.find(r => distKm <= r.max_km);
  if (!matched) return null; // 超過最遠級距（呼叫前已用 max_distance 擋）

  const rawFee = matched.fee;

  // 滿額免基本外送費
  let deliveryFee = rawFee;
  let isFreeDelivery = false;
  if (freeThreshold > 0 && subtotal >= freeThreshold) {
    const reduced = rawFee - basicFee;
    deliveryFee = reduced > 0 ? reduced : 0;
    isFreeDelivery = deliveryFee === 0;
  }

  return { rawFee, deliveryFee, isFreeDelivery };
}

// ── POST /api/delivery/calculate-fee ─────────────────
// body: { order_mode, subtotal, delivery_address, delivery_lat, delivery_lng }
// resp: { success, distance_km, delivery_fee, raw_fee, is_free_delivery, message }
router.post('/calculate-fee', async (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    const { order_mode, subtotal, delivery_lat, delivery_lng } = req.body;

    // 非外送模式：直接免費
    if (order_mode !== 'delivery') {
      return res.json({ success: true, distance_km: 0, delivery_fee: 0, raw_fee: 0, is_free_delivery: true, message: '非外送模式，無外送費' });
    }

    // 必須有客戶座標
    const destLat = parseFloat(delivery_lat);
    const destLng = parseFloat(delivery_lng);
    if (isNaN(destLat) || isNaN(destLng)) {
      return res.status(400).json({ success: false, message: '請提供有效的外送地址座標' });
    }

    // 讀取店家設定
    const distanceFeeEnabled = getSetting(db, storeId, 'delivery_distance_fee_enabled', '1') === '1';
    const storeLat  = parseFloat(getSetting(db, storeId, 'store_lat', ''));
    const storeLng  = parseFloat(getSetting(db, storeId, 'store_lng', ''));
    const maxDistKm = parseFloat(getSetting(db, storeId, 'delivery_max_distance_km', '7'));
    const basicFee  = parseFloat(getSetting(db, storeId, 'delivery_basic_fee', '50'));
    const freeThr   = parseFloat(getSetting(db, storeId, 'delivery_free_threshold', '1000'));
    const sub       = parseFloat(subtotal) || 0;

    let rulesRaw = getSetting(db, storeId, 'delivery_distance_fee_rules', '');
    let rules = [];
    try {
      rules = JSON.parse(rulesRaw);
      if (!Array.isArray(rules)) rules = [];
      // 確保升序排列
      rules.sort((a, b) => a.max_km - b.max_km);
    } catch { rules = []; }

    // 若未啟用距離計費，直接用基本費
    if (!distanceFeeEnabled) {
      return res.json({
        success: true, distance_km: 0, delivery_fee: basicFee,
        raw_fee: basicFee, is_free_delivery: false,
        message: `固定外送費 NT$${basicFee}`,
      });
    }

    // 必須有店家座標才能計算
    if (isNaN(storeLat) || isNaN(storeLng) || !storeLat || !storeLng) {
      return res.status(503).json({
        success: false,
        code: 'STORE_COORDS_MISSING',
        message: '店家座標尚未設定，無法計算外送費，請聯絡店家',
      });
    }

    // 呼叫 Google Routes API
    let distKm;
    try {
      distKm = await getDrivingDistanceKm(storeLat, storeLng, destLat, destLng);
    } catch (gErr) {
      console.error('[delivery/calculate-fee] Routes API 失敗:', gErr.message);
      return res.status(503).json({
        success: false,
        code: 'MAPS_KEY_MISSING',
        message: '外送距離計算暫時無法使用，請稍後再試或改選外帶取餐',
        reason: 'maps_unavailable',
      });
    }

    // 檢查最大外送距離
    if (distKm > maxDistKm) {
      return res.status(400).json({
        success: false,
        message: `距離 ${distKm} 公里，超過本店外送範圍（最遠 ${maxDistKm} 公里），請改選外帶取餐`,
        reason: 'out_of_range',
        distance_km: distKm,
      });
    }

    // 計算費用
    const feeResult = calcFee({ distKm, subtotal: sub, rules, basicFee, freeThreshold: freeThr });
    if (!feeResult) {
      return res.status(400).json({
        success: false,
        message: `距離 ${distKm} 公里，超過外送費級距設定範圍，請改選外帶取餐`,
        reason: 'out_of_range',
        distance_km: distKm,
      });
    }

    // 組成 Google Maps 導航連結
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${storeLat},${storeLng}&destination=${destLat},${destLng}&travelmode=driving`;

    const feeMsg = feeResult.isFreeDelivery
      ? `距離 ${distKm} 公里，滿額免運！`
      : feeResult.deliveryFee < feeResult.rawFee
        ? `距離 ${distKm} 公里，外送費 NT$${feeResult.deliveryFee}（滿額折抵 NT$${feeResult.rawFee - feeResult.deliveryFee}）`
        : `距離 ${distKm} 公里，外送費 NT$${feeResult.deliveryFee}`;

    return res.json({
      success:         true,
      distance_km:     distKm,
      delivery_fee:    feeResult.deliveryFee,
      raw_fee:         feeResult.rawFee,
      is_free_delivery: feeResult.isFreeDelivery,
      maps_url:        mapsUrl,
      message:         feeMsg,
    });

  } catch (e) {
    console.error('[delivery/calculate-fee]', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
