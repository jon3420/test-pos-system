// scripts/lib/c62-bind-fault.js — R54.4／MBV2-HF1-C6.2 測試專用 preload（node -r；正式部署不載入）
// 依控制檔對 utils/demandSettlement._bindRaw 注入故障：
//   C62_BIND_FAULT（JSON）：{ mode: 'off' | 'first'（下一次呼叫失敗一次）| 'always' }
// 受測程式沒有 demandSettlement 模組（例如未修改基準）時不做任何事。
'use strict';
const Module = require('module');
const fs = require('fs');
const CTRL = process.env.C62_BIND_FAULT || '';
const readCtrl = () => { try { return JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch { return { mode: 'off' }; } };
const origLoad = Module._load;
let patched = false;
let firstUsedFor = null;
Module._load = function (request, parent, isMain) {
  const real = origLoad.apply(this, arguments);
  if (patched || !CTRL || !/demandSettlement(\.js)?$/.test(String(request)) || !real || typeof real._bindRaw !== 'function') return real;
  patched = true;
  const orig = real._bindRaw;
  real._bindRaw = function (raw, o) {
    const c = readCtrl();
    const key = o && o.orderUuid;
    if (c.mode === 'always') throw new Error('c62 injected bind fault');
    if (c.mode === 'first' && firstUsedFor !== key) { firstUsedFor = key; throw new Error('c62 injected bind fault (first)'); }
    return orig.apply(this, arguments);
  };
  return real;
};
