// scripts/lib/c61-line-gate.js — R54.4／MBV2-HF1-C6.1 測試專用 preload（node -r，必須在 c4-line-mock.js 之後載入）
//
// 只在測試子程序載入；正式部署不會載入此檔。
// 用途：讓「第一筆請求已送到模擬 LINE、但回應尚未返回」這個時點可以被測試精確控制（不靠固定 sleep）。
//   - 測試在 C61_LINE_GATE_DIR 建立 hold_<LINE UID> → 該 UID 的下一次 push 先交給 c4-line-mock（照常記錄、受理、
//     記住 retry key），再寫出 arrived_<UID>，然後暫停回應，直到測試建立 release_<UID>。
//   - hold 檔是一次性的（到達後即刪除），之後同一 UID 的呼叫不受影響。
//   - 呼叫端逾時中止（AbortSignal）時照常丟出 AbortError；程序被 SIGKILL 時回應永遠不會返回（模擬「已受理但回應遺失」）。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.C61_LINE_GATE_DIR || '';
const prevFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (!DIR || !/^https:\/\/api\.line\.me\/v2\/bot\/message\/push/.test(u)) return prevFetch(input, init);
  let to = '';
  try { to = String(JSON.parse((init && init.body) || '{}').to || ''); } catch {}
  const hold = path.join(DIR, 'hold_' + to);
  if (!to || !fs.existsSync(hold)) return prevFetch(input, init);
  try { fs.unlinkSync(hold); } catch {}
  const res = await prevFetch(input, init); // 模擬 LINE 已處理（含 retry key 受理紀錄）
  fs.writeFileSync(path.join(DIR, 'arrived_' + to), String(Date.now()));
  const signal = init && init.signal;
  await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (fs.existsSync(path.join(DIR, 'release_' + to))) { clearInterval(t); resolve(); }
    }, 20);
    if (signal) signal.addEventListener('abort', () => { clearInterval(t); const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); });
  });
  return res;
};
