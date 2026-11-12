// scripts/lib/c4-test-clock.js — R54.4／MBV2-HF1-C4 測試專用一致時鐘（node -r；正式部署不載入）
// C4_CLOCK_OFFSET_MS 非 0 時，同時位移 JS Date 與 sql.js 的 datetime('now')（sql.js 以 Date.now() 取時間），
// 測試程序、暫存伺服器與瀏覽器頁面使用同一位移，資料庫有效期限與營業時段判斷一致。
'use strict';
const OFF = Number(process.env.C4_CLOCK_OFFSET_MS || 0);
if (OFF) {
  const RD = Date;
  class D extends RD {
    constructor(...a) { if (a.length === 0) super(RD.now() + OFF); else super(...a); }
    static now() { return RD.now() + OFF; }
  }
  globalThis.Date = D;
}
