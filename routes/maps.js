// routes/maps.js — fix18-06
// Google Maps Geocoding / Reverse-Geocoding proxy
// GOOGLE_MAPS_SERVER_KEY は絶対に前端へ露出しない
'use strict';
const express  = require('express');
const router   = express.Router();
const fetch    = require('node-fetch');

const SERVER_KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || '';

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
    });
  } catch (e) {
    console.error('[maps/reverse-geocode]', e.message);
    return res.status(503).json({ success: false, message: 'Reverse Geocoding API 暫時無法使用，請稍後再試' });
  }
});

module.exports = router;
