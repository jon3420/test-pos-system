#!/usr/bin/env node
// scripts/mbv2-rescue-verify.js — R54.4-MBV2 歷史資料救援驗證工具（離線、唯讀）
//
// 只讀取備份 JSON 檔，不連線伺服器、不寫入任何資料庫。
// 用法：
//   node scripts/mbv2-rescue-verify.js --old 1007.json --new 1109.json [--merged merged.json]
//        [--gap-start 2026-10-08 --gap-end 2026-11-08] [--store store_001] [--out report.md]
// 支援 .json 與 .json.gz、舊版完整備份與 V2 備份。
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const mv2 = require('../utils/migrationV2');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function load(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let txt = buf.toString('utf8'); if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  const j = JSON.parse(txt);
  const info = mv2.inspectPayload(j);
  return { file: path.basename(file), json: j, info, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const arr = (b, t) => (Array.isArray(b.json.data[t]) ? b.json.data[t] : []);
function storeRows(b, t, store) { return arr(b, t).filter(r => !store || !r.store_id || r.store_id === store); }
function fingerprint(o) { // 判斷同一訂單內容是否一致（只比較業務欄位）
  const items = typeof o.items === 'string' ? o.items : JSON.stringify(o.items || []);
  return JSON.stringify([o.total, o.subtotal, o.payment_method, o.status, o.order_status, o.refund_status || '', items, o.created_at]);
}

function analyze(b, store) {
  const orders = storeRows(b, 'orders', store);
  const byNum = new Map(); const dupNums = []; const noNum = [];
  for (const o of orders) {
    const n = String(o.order_number || '').trim();
    if (!n) { noNum.push(o.id); continue; }
    if (byNum.has(n)) dupNums.push(n); else byNum.set(n, o);
  }
  const perDay = {}; let noDate = 0;
  for (const o of byNum.values()) { const d = mv2.orderTaipeiDate(o.created_at); if (!d) { noDate++; continue; } perDay[d] = (perDay[d] || 0) + 1; }
  const days = Object.keys(perDay).sort();
  const ev = storeRows(b, 'analytics_events', store);
  const evKeys = new Set(); let evDup = 0;
  for (const e of ev) { const k = mv2.analyticsKey(e, false); if (!k) continue; if (evKeys.has(k)) evDup++; else evKeys.add(k); }
  const members = storeRows(b, 'line_members', store);
  const memIds = new Set(members.map(m => String(m.line_user_id || '').trim()).filter(Boolean));
  return { orders: orders.length, uniqueOrders: byNum.size, dupNums, noNum, byNum, perDay, days, noDate,
    first: days[0] || null, last: days[days.length - 1] || null, events: ev.length, uniqueEvents: evKeys.size, evDup, evKeys,
    members: members.length, uniqueMembers: memIds.size, memIds };
}

(function main() {
  const oldF = arg('old'), newF = arg('new'), mergedF = arg('merged');
  const store = arg('store', null);
  const gapStart = arg('gap-start', '2026-10-08'), gapEnd = arg('gap-end', '2026-11-08');
  const out = arg('out', null);
  if (!oldF || !newF) { console.error('需要 --old 與 --new'); process.exit(2); }
  const L = [];
  const p = (s = '') => L.push(s);
  const files = [['舊備份', load(oldF)], ['新備份', load(newF)]];
  if (mergedF) files.push(['合併救援', load(mergedF)]);
  const A = {}; for (const [name, b] of files) A[name] = analyze(b, store);

  p('# 歷史資料救援驗證報告（由 scripts/mbv2-rescue-verify.js 實際重新計算）'); p();
  p(`產生時間：${mv2.taipeiIsoNow()}　店家篩選：${store || '（全部列）'}　缺口區間：${gapStart} ～ ${gapEnd}（台北日期）`); p();
  p('## 1. 檔案'); p();
  p('| 角色 | 檔名 | SHA-256 | 格式 | 來源店家 | 匯出時間 |'); p('|---|---|---|---|---|---|');
  for (const [name, b] of files) p(`| ${name} | ${b.file} | \`${b.sha256.slice(0, 16)}…\` | ${b.info.kind}／${b.info.backup_type} | ${b.info.source_store_id || '—'} | ${b.info.exported_at || '—'} |`);
  p(); p('## 2. 重新計算的筆數'); p();
  p('| 角色 | 訂單列 | 不重複訂單編號 | 檔內重複編號 | 缺編號 | 無日期 | 最早 | 最晚 | LINE 會員（不重複） | Analytics 事件（不重複鍵） |'); p('|---|---:|---:|---:|---:|---:|---|---|---:|---:|');
  for (const [name] of files) { const a = A[name]; p(`| ${name} | ${a.orders} | ${a.uniqueOrders} | ${a.dupNums.length} | ${a.noNum.length} | ${a.noDate} | ${a.first || '—'} | ${a.last || '—'} | ${a.members}（${a.uniqueMembers}） | ${a.events}（${a.uniqueEvents}） |`); }
  const O = A['舊備份'], N = A['新備份'];
  const union = new Map([...O.byNum]); const conflicts = []; let both = 0;
  for (const [n, o] of N.byNum) { if (union.has(n)) { both++; if (fingerprint(union.get(n)) !== fingerprint(o)) conflicts.push(n); } else union.set(n, o); }
  const onlyOld = [...O.byNum.keys()].filter(n => !N.byNum.has(n));
  const onlyNew = [...N.byNum.keys()].filter(n => !O.byNum.has(n));
  p(); p('## 3. 舊＋新 聯集（以訂單編號為業務鍵）'); p();
  p(`- 只在舊備份：**${onlyOld.length}** 筆（新環境遺失、可由舊備份恢復）`);
  p(`- 只在新備份：**${onlyNew.length}** 筆`);
  p(`- 兩邊都有：**${both}** 筆，其中內容不一致 **${conflicts.length}** 筆${conflicts.length ? `（例：${conflicts.slice(0, 10).join(', ')}）` : ''}`);
  p(`- 聯集應得：**${union.size}** 筆不重複訂單`);
  const memUnion = new Set([...O.memIds, ...N.memIds]);
  const evUnion = new Set([...O.evKeys, ...N.evKeys]);
  p(`- LINE 會員聯集：**${memUnion.size}**；Analytics 事件聯集（去重鍵）：**${evUnion.size}**`);
  if (mergedF) {
    const M = A['合併救援'];
    const missing = [...union.keys()].filter(n => !M.byNum.has(n));
    const extra = [...M.byNum.keys()].filter(n => !union.has(n));
    p(); p('## 4. 合併救援檔核對'); p();
    p(`- 合併檔不重複訂單：**${M.uniqueOrders}**（聯集應得 ${union.size}）→ ${M.uniqueOrders === union.size && !missing.length && !extra.length ? '✅ 一致' : '❌ 不一致'}`);
    p(`- 聯集中有、合併檔缺少：**${missing.length}**${missing.length ? `（例：${missing.slice(0, 10).join(', ')}）` : ''}`);
    p(`- 合併檔多出（兩份來源都沒有，不可憑空補造）：**${extra.length}**${extra.length ? `（例：${extra.slice(0, 10).join(', ')}）` : ''}`);
    p(`- 合併檔檔內重複編號：**${M.dupNums.length}**`);
    p(`- LINE 會員：合併檔 ${M.uniqueMembers}／聯集 ${memUnion.size}；Analytics：合併檔 ${M.uniqueEvents}／聯集 ${evUnion.size}`);
  }
  p(); p(`## ${mergedF ? 5 : 4}. 缺口區間 ${gapStart} ～ ${gapEnd} 逐日訂單數`); p();
  p('| 日期 | 舊備份 | 新備份 | 聯集 | 狀態 |'); p('|---|---:|---:|---:|---|');
  const unionPerDay = {}; for (const o of union.values()) { const d = mv2.orderTaipeiDate(o.created_at); if (d) unionPerDay[d] = (unionPerDay[d] || 0) + 1; }
  const missingDays = [];
  for (let d = gapStart; d <= gapEnd; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    const u = unionPerDay[d] || 0; if (!u) missingDays.push(d);
    p(`| ${d} | ${O.perDay[d] || 0} | ${N.perDay[d] || 0} | ${u} | ${u ? '有資料' : '**兩份備份都沒有**'} |`);
  }
  p(); p(`- 兩份備份都沒有任何訂單的日期：**${missingDays.length}** 天${missingDays.length ? `（${missingDays.join(', ')}）` : ''}`);
  p('- 這些日期的訂單無法由現有兩份備份恢復，**不得自行補造**。可能的其他救援來源：Android POS 本機 Room DB（未同步或已同步的訂單）、LINE Pay／金流後台交易紀錄、LINE 官方帳號聊天紀錄、外送平台後台、Zeabur 舊容器／Volume 快照、n8n／Webhook 紀錄、列印出單紀錄。');
  const txt = L.join('\n') + '\n';
  if (out) fs.writeFileSync(out, txt); else process.stdout.write(txt);
})();
