// utils/rateLimiter.js — H1.4.12 Phase 3B RC2（Security Corrective Audit）
//
// 共用、可測的 rate limiter helper，給 recovery 公開端點使用。核心安全
// 承諾：key 一律來自 Express 自己解析過的 req.ip（尊重 server.js 既有的
// `app.set('trust proxy', computeTrustProxySetting(...))` 設定），這裡完全
// 不直接讀取、也不信任 req.headers['x-forwarded-for']——trust proxy 設成
// false（預設）時，client 自己在 header 裡塞什麼都不會改變 rate-limit key；
// 只有部署端明確設定可信的 proxy 層數/位址時，Express 自己解析出的 req.ip
// 才會反映代理鏈最前端的來源，而且信任邊界完全由 server.js 那一份設定
// 決定，這裡不重新發明一套 header 解析邏輯。
'use strict';

function createRateLimiter({ windowMs, max, hardCapEntries = 5000 }) {
  const bucket = new Map();
  let lastSweep = Date.now();
  const SWEEP_INTERVAL_MS = Math.max(windowMs, 30000);

  function sweepExpired(now) {
    // 規格六：定期清除過期 bucket，避免不同來源 IP（或偽造嘗試）造成 Map
    // 無限成長；用「距離上次 sweep 是否已經過了至少一個 window」節流，
    // 不必每次 request 都整個 Map 掃一輪。
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [key, entry] of bucket) {
      if (now - entry.windowStart > windowMs) bucket.delete(key);
    }
  }

  function check(req) {
    const now = Date.now();
    sweepExpired(now);
    // req.ip 是 Express 自己依 trust proxy 設定解析出來的唯一可信來源，
    // 這裡不讀取任何 header 本身。req.ip 缺失（理論上不會，但防禦性處理）
    // 時退回一個固定 key，行為上等同「所有無法辨識來源的請求共用同一個
    // 桶」，不會因此完全繞過限制。
    const key = (req && req.ip) ? String(req.ip) : 'unknown';
    let entry = bucket.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      // 規格六：hard cap——即使清不掉（例如大量不同來源在同一個 window
      // 內湧入），Map 大小也不會無限成長；達到上限時，新的、之前沒見過的
      // key 一律視為「這次不通過」（保守 fail closed，不會為了省記憶體反而
      // 讓限流形同虛設）。
      if (!bucket.has(key) && bucket.size >= hardCapEntries) {
        return false;
      }
      entry = { count: 0, windowStart: now };
      bucket.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  }

  return { check, _bucket: bucket, _windowMs: windowMs, _max: max, _hardCapEntries: hardCapEntries };
}

module.exports = { createRateLimiter };
