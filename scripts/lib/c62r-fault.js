// scripts/lib/c62r-fault.js — R54.4／MBV2-HF1-C6.2 補修驗收專用 preload（node -r；正式部署不載入）
// 依控制檔（C62R_CTRL，JSON）對 utils/demandSettlement 注入故障或真實 SIGKILL 停點：
//   bind: 'off' | 'always'                 綁定一律失敗（交易內與交易後補綁）
//   bindPids: [pid…]                       只讓這些商品的綁定失敗（修正版逐商品；基準為整張訂單）
//   recordFail: true                       保存待辦失敗（只有修正版有此函式；基準沒有保存待辦）
//   killAt: 'bindLate' | 'order_void'      在該停點以 SIGKILL 結束伺服器（訂單／作廢交易已提交、後續份數處理尚未執行）
//   syncFailOrders: [order_uuid…]          這些訂單同步時拋出例外（模擬單筆故障）
//   killAfterSyncs: N                      定期補齊中第 N 次同步後 SIGKILL（處理中重啟）
//   killBeforeSyncOrder: order_uuid        該訂單同步開始前 SIGKILL（綁定交易已提交、份數同步尚未開始）
//   voidSettleFail: true                   作廢補記扣減後在同一交易內拋出例外（交易提交前保存失敗；只有狀態邊界修正版有此函式）
//   killInVoidSettle: true                 作廢補記扣減後、交易提交前 SIGKILL（只有狀態邊界修正版有此函式）
//   legacyFailLinkIds: [id,…]              歷史 C 型待核對標記：指定關聯 id 的單筆標記拋出例外（只有掃描漏標修正版有此函式）
//   killAfterLegacyMarks: N                歷史 C 型待核對標記：第 N 次單筆標記時 SIGKILL（批次交易提交前；只有掃描漏標修正版有此函式）
// 受測程式沒有對應函式時不做任何事。
'use strict';
const Module = require('module');
const fs = require('fs');
const CTRL = process.env.C62R_CTRL || '';
const ctrl = () => { try { return JSON.parse(fs.readFileSync(CTRL, 'utf8')); } catch { return {}; } };
const kill = () => { try { fs.appendFileSync(CTRL + '.killed', String(Date.now()) + '\n'); } catch {} process.kill(process.pid, 'SIGKILL'); };
const origLoad = Module._load;
let patched = false;
let syncCount = 0;
Module._load = function (request) {
  const real = origLoad.apply(this, arguments);
  if (patched || !CTRL || !/demandSettlement(\.js)?$/.test(String(request)) || !real || typeof real.syncOrder !== 'function') return real;
  patched = true;
  const pidsOf = (o) => { let it = o && o.items; if (typeof it === 'string') { try { it = JSON.parse(it); } catch { it = []; } } return (Array.isArray(it) ? it : []).map((x) => Number(x.product_id != null ? x.product_id : x.id)); };
  if (typeof real._applyTaskRaw === 'function') {
    const o1 = real._applyTaskRaw;
    real._applyTaskRaw = function (raw, task) {
      const c = ctrl();
      if (c.bind === 'always' || (Array.isArray(c.bindPids) && c.bindPids.includes(Number(task.product_id)))) throw new Error('c62r injected bind fault');
      return o1.apply(this, arguments);
    };
  } else if (typeof real._bindRaw === 'function') {
    const o2 = real._bindRaw;
    real._bindRaw = function (raw, o) {
      const c = ctrl();
      if (c.bind === 'always' || (Array.isArray(c.bindPids) && pidsOf(o).some((p) => c.bindPids.includes(p)))) throw new Error('c62r injected bind fault');
      return o2.apply(this, arguments);
    };
  }
  if (typeof real._recordIntentsRaw === 'function') {
    const o3 = real._recordIntentsRaw;
    real._recordIntentsRaw = function () { if (ctrl().recordFail) throw new Error('c62r injected record fault'); return o3.apply(this, arguments); };
  }
  if (typeof real.bindLate === 'function') {
    const o4 = real.bindLate;
    real.bindLate = function () { if (ctrl().killAt === 'bindLate') kill(); return o4.apply(this, arguments); };
  }
  if (typeof real.safeSync === 'function') {
    const o5 = real.safeSync;
    real.safeSync = function (db, storeId, orderUuid, opts, tag) { if (ctrl().killAt && ctrl().killAt === tag) kill(); return o5.apply(this, arguments); };
  }
  if (typeof real._markLegacyReviewRaw === 'function') {
    const o8 = real._markLegacyReviewRaw;
    let marks = 0;
    real._markLegacyReviewRaw = function (raw, row) {
      const c = ctrl();
      marks++;
      if (c.killAfterLegacyMarks && marks >= Number(c.killAfterLegacyMarks)) kill();
      if (Array.isArray(c.legacyFailLinkIds) && c.legacyFailLinkIds.map(Number).includes(Number(row && row.id))) throw new Error('c62r injected legacy mark fault');
      return o8.apply(this, arguments);
    };
  }
  if (typeof real._voidSettleRaw === 'function') {
    const o7 = real._voidSettleRaw;
    real._voidSettleRaw = function () {
      const r = o7.apply(this, arguments);
      const c = ctrl();
      if (c.killInVoidSettle) kill();
      if (c.voidSettleFail) throw new Error('c62r injected void-settle save fault');
      return r;
    };
  }
  const o6 = real.syncOrder;
  real.syncOrder = function (db, storeId, orderUuid, opts) {
    const c = ctrl();
    if (c.killBeforeSyncOrder && String(c.killBeforeSyncOrder) === String(orderUuid)) kill();
    if (Array.isArray(c.syncFailOrders) && c.syncFailOrders.includes(String(orderUuid))) throw new Error('c62r injected sync fault');
    const r = o6.apply(this, arguments);
    if (opts && opts.sweep && c.killAfterSyncs) { syncCount++; if (syncCount >= c.killAfterSyncs) kill(); }
    return r;
  };
  return real;
};
