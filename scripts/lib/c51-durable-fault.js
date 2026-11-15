// scripts/lib/c51-durable-fault.js — R54.4／MBV2-HF1-C5.1 測試專用 preload（node -r；正式部署不載入）
// 故障注入只在測試邊界：讓 utils/db.js durableWriteFile 的暫存檔建立失敗（模擬「交易保存失敗」）。
//   C51_DURABLE_CTRL（JSON）：{ skip: n, fail: m }＝先放行 n 次 durable 寫入，接著讓 m 次失敗；之後恢復正常。
'use strict';
const fs = require('fs');
const CTRL = process.env.C51_DURABLE_CTRL || '';
if (CTRL) {
  const orig = fs.openSync;
  fs.openSync = function (p, flags, mode) {
    if (typeof p === 'string' && /\.tmp-\d+-\d+-[a-z0-9]{6}$/.test(p) && flags === 'wx') {
      let c = {}; try { c = JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch {}
      if (c.skip > 0) { c.skip--; fs.writeFileSync(CTRL, JSON.stringify(c)); }
      else if (c.fail > 0) { c.fail--; c.failed = (c.failed || 0) + 1; fs.writeFileSync(CTRL, JSON.stringify(c)); const e = new Error('injected durable write failure'); e.code = 'EIO'; throw e; }
    }
    return orig.apply(this, arguments);
  };
}
