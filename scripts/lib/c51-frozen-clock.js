// scripts/lib/c51-frozen-clock.js — R54.4／MBV2-HF1-C5.1 測試專用 preload（node -r；正式部署不載入）
// C51_FREEZE_MS 設定時，JS Date（含 sql.js 的 datetime('now')）固定在同一毫秒：用來重現「同一秒／同一毫秒」建立多張訂單。
'use strict';
const FIX = Number(process.env.C51_FREEZE_MS || 0);
if (FIX) {
  const RD = Date;
  class D extends RD {
    constructor(...a) { if (a.length === 0) super(FIX); else super(...a); }
    static now() { return FIX; }
  }
  globalThis.Date = D;
}
