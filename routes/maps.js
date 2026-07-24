// routes/maps.js — fix18-06
// Google Maps Geocoding / Reverse-Geocoding proxy
// GOOGLE_MAPS_SERVER_KEY は絶対に前端へ露出しない
'use strict';
const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');

const SERVER_KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || '';

// fix18-10-hotfix30-B5-R5.1-B（第四階段：Google 結構化地址）——
// R5.1-A 盤點發現這支 API 只回傳 { lat, lng, formatted_address }，Google 原始
// response 其實已經有 address_components，只是後端沒有整理。這裡安全擷取
// country/region/city/district/postal_code，不把完整 address_components
// 陣列回傳給呼叫端（避免多餘欄位外流／未來被誤用當 Analytics 原始輸入）。
//
// 台灣行政區 fallback 優先順序（依需求文件第四階段）：
//   district: administrative_area_level_3 → sublocality_level_1 → sublocality
//   city:     administrative_area_level_2 → locality
//   region:   administrative_area_level_1
function extractSafeGeoComponents(components) {
  if (!Array.isArray(components)) return { country: '', region: '', city: '', district: '', postal_code: '' };
  const byType = (types) => {
    for (const t of types) {
      const hit = components.find((c) => Array.isArray(c.types) && c.types.includes(t));
      if (hit && hit.long_name) return hit.long_name;
    }
    return '';
  };
  return {
    country: byType(['country']),
    region: byType(['administrative_area_level_1']),
    city: byType(['administrative_area_level_2', 'locality']),
    district: byType(['administrative_area_level_3', 'sublocality_level_1', 'sublocality']),
    postal_code: byType(['postal_code']),
  };
}

// ── POST /api/maps/geocode ─────────────────────────────
// body: { address: string }
// resp: { success, lat, lng, formatted_address }
router.post('/geocode', async (req, res) => {
  try {
    const key = SERVER_KEY();
    if (!key) return res.status(503).json({ success: false, message: 'Google Maps API 未設定（GOOGLE_MAPS_SERVER_KEY）' });

    const address = String(req.body.address || '').trim();
    if (!address) return res.status(400).json({ success: false, message: '請提供地址' });

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&key=${key}`;
    const gRes  = await fetch(url, { timeout: 8000 });
    const gData = await gRes.json();

    if (gData.status !== 'OK' || !gData.results || gData.results.length === 0) {
      return res.status(400).json({ success: false, message: `無法解析地址（${gData.status}）` });
    }

    const result = gData.results[0];
    const loc    = result.geometry.location;
    return res.json({
      success:           true,
      lat:               loc.lat,
      lng:               loc.lng,
      formatted_address: result.formatted_address,
      // fix18-10-hotfix30-B5-R5.1-B：向後相容新增，既有欄位（lat/lng/
      // formatted_address）完全保留，不破壞既有前端流程。address_components
      // 原始陣列不整包回傳，只給安全整理過的行政區欄位。
      geo: extractSafeGeoComponents(result.address_components),
    });
  } catch (e) {
    console.error('[maps/geocode]', e.message);
    return res.status(503).json({ success: false, message: 'Geocoding API 暫時無法使用，請稍後再試' });
  }
});

// ── POST /api/maps/reverse-geocode ────────────────────
// body: { lat, lng }
// resp: { success, formatted_address, lat, lng }
router.post('/reverse-geocode', async (req, res) => {
  try {
    const key = SERVER_KEY();
    if (!key) return res.status(503).json({ success: false, message: 'Google Maps API 未設定（GOOGLE_MAPS_SERVER_KEY）' });

    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ success: false, message: '請提供有效的 lat/lng' });

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=zh-TW&key=${key}`;
    const gRes  = await fetch(url, { timeout: 8000 });
    const gData = await gRes.json();

    if (gData.status !== 'OK' || !gData.results || gData.results.length === 0) {
      return res.status(400).json({ success: false, message: `無法解析座標（${gData.status}）` });
    }

    const result = gData.results[0];
    return res.json({
      success:           true,
      lat,
      lng,
      formatted_address: result.formatted_address,
      geo: extractSafeGeoComponents(result.address_components),
    });
  } catch (e) {
    console.error('[maps/reverse-geocode]', e.message);
    return res.status(503).json({ success: false, message: 'Reverse Geocoding API 暫時無法使用，請稍後再試' });
  }
});

module.exports = router;
