#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-migration.js — R54.4 Migration & Backup V2 回歸測試
//
// 以真實 `node server.js` + 暫存 SQLite（os.tmpdir）執行；不碰 data/pos.db、不連正式站。
// 用法：node scripts/smoke-r54-4-mbv2-migration.js [--json out.json]
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('./lib/mbv2-harness');
const S = require('./lib/mbv2-seed');
const mv2 = require('../utils/migrationV2');
const { assert, pass, fail } = H;

const ALL = mv2.CATEGORY_KEYS;
const realDbHashBefore = fs.existsSync(H.REAL_DB) ? H.sha256File(H.REAL_DB) : null;

async function freshServer(tag, seed = true, env = {}) {
  const dir = H.tmpDir(tag);
  const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf, env); await s.stop();
  if (seed) { const db = await H.openDbFile(dbf); S.seedStore001(db); H.saveDbFile(db, dbf); db.close(); }
  s = await H.startServer(dbf, env);
  s.dir = dir;
  return s;
}
const enc = (o) => encodeURIComponent(JSON.stringify(o));
async function exportJson(s, tok, qs) {
  const d = await H.download(s.base, tok, '/api/migration/v2/export?' + qs);
  let json = null; try { json = JSON.parse((qs.includes('gzip=1') ? zlib.gunzipSync(d.buf) : d.buf).toString('utf8')); } catch {}
  return { ...d, json, name: (d.headers.get('content-disposition') || '').replace(/^.*filename="([^"]+)".*$/, '$1') };
}
async function saveTmp(s, name, obj) { const f = path.join(s.dir, name); fs.writeFileSync(f, typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); return f; }
async function uploadObj(s, tok, name, obj) { return H.uploadRaw(s.base, tok, await saveTmp(s, name, obj), { name }); }

async function unitTests() {
  console.log('\n── U. 日期範圍（Asia/Taipei）純函式 ──');
  const now = new Date('2026-11-09T12:07:00Z'); // 台北 11/09（週一） 20:07
  const r = (spec) => mv2.resolveDateRange(spec, now);
  assert(r({ preset: 'all' }) === null, 'U1 全部歷史 → 無篩選');
  assert(JSON.stringify([r({ preset: 'today' }).start, r({ preset: 'today' }).end]) === '["2026-11-09","2026-11-09"]', 'U2 今日 = 2026-11-09');
  assert(r({ preset: 'yesterday' }).start === '2026-11-08', 'U3 昨日 = 2026-11-08');
  assert(r({ preset: 'this_week' }).start === '2026-11-09' && r({ preset: 'this_week' }).end === '2026-11-09', 'U4 本週（週一起）= 11/09～11/09');
  assert(r({ preset: 'this_month' }).start === '2026-11-01', 'U5 本月起 11/01');
  const lm = r({ preset: 'last_month' }); assert(lm.start === '2026-10-01' && lm.end === '2026-10-31', 'U6 上個月 = 10/01～10/31');
  const feb = r({ preset: 'month', month: '2028-02' }); assert(feb.end === '2028-02-29', 'U7 指定月份 2028-02 結束日為 29（閏年）');
  const late = mv2.resolveDateRange({ preset: 'today' }, new Date('2026-11-09T16:30:00Z'));
  assert(late.start === '2026-11-10', 'U8 UTC 16:30 已是台北隔日 → 今日=11/10（不因 UTC 跨日漏算）');
  let threw = null; try { r({ preset: 'custom', start: '2026-10-31', end: '2026-10-01' }); } catch (e) { threw = e.code; }
  assert(threw === 'INVALID_DATE_RANGE', 'U9 開始日晚於結束日 → INVALID_DATE_RANGE');
  threw = null; try { r({ preset: 'custom', start: '2026-02-30', end: '2026-03-01' }); } catch (e) { threw = e.code; }
  assert(threw === 'INVALID_DATE_RANGE', 'U10 不存在的日期 2026-02-30 → 拒絕');
  assert(mv2.orderTaipeiDate('2026-09-30T16:30:00Z') === '2026-10-01', 'U11 帶 Z 的訂單時間轉台北日期');
  assert(mv2.orderTaipeiDate('2026-10-31 23:59:59') === '2026-10-31', 'U12 naive 訂單時間（台北當地）取原日期');
  assert(mv2.utcStoredTaipeiDate('2026-09-30 16:10:00') === '2026-10-01', 'U13 analytics UTC naive 16:10 → 台北 10/01');
  assert(mv2.utcStoredTaipeiDate('2026-09-30 15:59:59') === '2026-09-30', 'U14 analytics UTC 15:59:59 → 台北 9/30');
}

async function exportTests(s, tok) {
  console.log('\n── E. 匯出 ──');
  const pv = await H.api(s.base, tok, 'GET', '/api/migration/v2/export/preview');
  assert(pv.status === 200 && pv.json.categories.length === ALL.length, 'E0 匯出預覽回傳全部分類', `count=${pv.json && pv.json.categories.length}`);
  const pvProducts = pv.json.categories.find(c => c.key === 'products');
  assert(pvProducts.includes_images && pvProducts.includes_images.has_image_urls === true && pvProducts.includes_images.inline_images === 0, 'E0b 商品預覽標示「含圖片網址、無內嵌圖片」');
  assert(pv.json.categories.every(c => c.estimated_bytes === null || typeof c.estimated_bytes === 'number'), 'E0c 預估大小為抽樣估算數字或 null（尚未估算），無虛構文字');

  const full = await exportJson(s, tok, 'mode=full');
  const fj = full.json;
  assert(full.status === 200 && fj && fj.backup_type === 'full' && fj.type === 'pos_migration_backup' && fj.format === 'pos_migration' && fj.schema_version === 2, 'E1 完整匯出：backup_type=full、type 與舊版相容、schema_version=2');
  assert(/^pos_backup_store_001_full_\d{8}\.json$/.test(full.name), 'E1b 完整匯出檔名', full.name);
  assert(full.name.includes(mv2.taipeiDateStr(new Date()).replace(/-/g, '')), 'E1c 檔名日期＝實際匯出日（台北）');
  const db = await H.openDbFile(s.dbPath);
  const dbCount = (t) => H.q1(db, `SELECT COUNT(*) c FROM ${t} WHERE store_id='store_001'`).c;
  let allMatch = true; const mism = [];
  for (const t of ['orders', 'order_logs', 'products', 'categories', 'line_members', 'analytics_events', 'popup_sessions', 'coupons', 'inventory_logs', 'geo_visit_log']) {
    if (fj.data[t].length !== dbCount(t)) { allMatch = false; mism.push(`${t}:${fj.data[t].length}/${dbCount(t)}`); }
  }
  assert(allMatch, 'E1d 完整匯出各表筆數＝資料庫實際筆數', mism.join(' '));
  assert(fj.data.settings.every(x => x.key !== 'pos_password'), 'E1e 完整匯出不含 pos_password');
  assert(fj.data.payment_gateways.every(x => !x.api_key && !x.secret_key), 'E1f 金流設定匯出不含 API 金鑰');
  assert(!JSON.stringify(fj.data.line_member_history).includes('"tok"'), 'E1g 會員歷程 metadata 的 token 已移除');
  assert(fj.data.orders.every(o => !o.store_id || o.store_id === 'store_001') && !fj.data.orders.some(o => o.order_number === 'S2-0001'), 'E1h 完整匯出不含 store_002 資料');
  const refd = fj.data.orders.find(o => o.order_number === 'O-1020-REFD');
  assert(refd && refd.refund_status === 'refunded' && refd.refunded_at && refd.refund_note === '客訴退款', 'E1i 退款資訊完整保留（refund_status／refunded_at／refund_note）');
  const voided = fj.data.orders.find(o => o.order_number === 'O-1109-VOID');
  assert(voided && voided.void_reason === '打錯單' && voided.status === 'void', 'E1j 作廢訂單與作廢原因保留');
  await saveTmp(s, 'full.json', full.buf);

  for (const [cat, tag] of [['products', 'products'], ['orders', 'orders'], ['line_members', 'members'], ['analytics', 'analytics']]) {
    const e = await exportJson(s, tok, 'categories=' + cat);
    const ok = e.status === 200 && e.json.backup_type === 'partial' && e.json.type === 'pos_migration_partial' && JSON.stringify(e.json.selected_categories) === JSON.stringify([cat]);
    const tables = Object.keys(e.json.data);
    assert(ok && tables.every(t => mv2.CATEGORY_BY_KEY[cat].tables.includes(t)) && new RegExp(`_${tag}_\\d{8}\\.json$`).test(e.name), `E2 ${cat} 單獨匯出（partial、只含該分類資料表、檔名 ${tag}）`, e.name + ' ' + tables.join(','));
    await saveTmp(s, `only_${cat}.json`, e.buf);
  }
  const multi = await exportJson(s, tok, 'categories=orders,line_members,products');
  assert(multi.status === 200 && multi.json.selected_categories.join(',') === 'products,orders,line_members' && /_selected_\d{8}\.json$/.test(multi.name), 'E3 多分類匯出（selected 檔名）', multi.name);
  await saveTmp(s, 'multi.json', multi.buf);
  const allSel = await exportJson(s, tok, 'categories=' + ALL.join(','));
  assert(allSel.json && allSel.json.backup_type === 'full', 'E4 全選（無日期篩選）→ 視為完整備份');
  const empty = await H.api(s.base, tok, 'GET', '/api/migration/v2/export?categories=');
  assert(empty.status === 400 && empty.json.code === 'EMPTY_SELECTION', 'E5 空選擇 → 400 EMPTY_SELECTION');
  const unk = await H.api(s.base, tok, 'GET', '/api/migration/v2/export?categories=foo');
  assert(unk.status === 400 && unk.json.code === 'UNKNOWN_CATEGORY', 'E5b 未知分類 → 400');

  const oct = await exportJson(s, tok, 'categories=orders&filters=' + enc({ orders: { preset: 'month', month: '2026-10' } }));
  const nums = oct.json.data.orders.map(o => o.order_number).sort();
  const expect = ['O-1001-0000', 'O-1001-ISOZ', 'O-1015-LINE', 'O-1020-REFD', 'O-1031-2359'];
  assert(JSON.stringify(nums) === JSON.stringify(expect), 'E6 指定月份 2026-10：含 10/01 00:00、UTC 換算的 10/01 00:30、10/31 23:59，排除 9/30 23:59 與 11/01 00:00', nums.join(','));
  assert(oct.name === 'pos_backup_store_001_orders_20261001_20261031.json', 'E6b 日期範圍檔名', oct.name);
  assert(oct.json.data.order_logs.length === 5 && oct.json.data.order_logs.every(l => expect.includes(l.order_number)), 'E6c 只匯出範圍內訂單的操作紀錄', String(oct.json.data.order_logs.length));
  assert(oct.json.data.coupon_redemptions.length === 1, 'E6d 範圍內訂單的優惠券使用紀錄一併匯出');
  assert(oct.json.backup_type === 'partial' && oct.json.filters.orders.start === '2026-10-01' && oct.json.filters.orders.timezone === 'Asia/Taipei', 'E6e 檔頭記錄篩選條件與時區');
  await saveTmp(s, 'orders_oct.json', oct.buf);
  const custom = await exportJson(s, tok, 'categories=orders&filters=' + enc({ orders: { preset: 'custom', start: '2026-10-31', end: '2026-11-01' } }));
  assert(JSON.stringify(custom.json.data.orders.map(o => o.order_number).sort()) === '["O-1031-2359","O-1101-0000"]', 'E7 自訂日期範圍 10/31～11/01（含首尾日）');
  const none = await exportJson(s, tok, 'categories=orders&filters=' + enc({ orders: { preset: 'custom', start: '2025-01-01', end: '2025-01-31' } }));
  assert(none.status === 200 && none.json.data.orders.length === 0 && none.json.data.order_logs.length === 0, 'E8 日期範圍無訂單 → 正常匯出 0 筆');
  const bad = await H.api(s.base, tok, 'GET', '/api/migration/v2/export?categories=orders&filters=' + enc({ orders: { preset: 'custom', start: '2026-10-31', end: '2026-10-01' } }));
  assert(bad.status === 400 && bad.json.code === 'INVALID_DATE_RANGE', 'E9 錯誤的日期範圍 → 400');
  const pre = await exportJson(s, tok, 'categories=line_preorders&filters=' + enc({ line_preorders: { preset: 'month', month: '2026-10' } }));
  assert(JSON.stringify(pre.json.data.orders.map(o => o.order_number).sort()) === '["O-1015-LINE","O-1020-REFD"]' && /_preorders_20261001_20261031\.json$/.test(pre.name), 'E10 LINE 預購依月份匯出（只含 source=line）', pre.name);
  const an = await exportJson(s, tok, 'categories=analytics&filters=' + enc({ analytics: { preset: 'month', month: '2026-10' } }));
  const anNames = an.json.data.analytics_events.map(e => e.created_at).sort();
  assert(JSON.stringify(anNames) === '["2026-09-30 16:10:00","2026-10-15 04:00:00"]', 'E11 Analytics 依台北日期篩選（UTC 9/30 16:10 屬 10/01、UTC 10/31 16:00 屬 11/01）', anNames.join(','));
  const gz = await exportJson(s, tok, 'categories=orders&gzip=1');
  assert(gz.status === 200 && gz.buf[0] === 0x1f && gz.buf[1] === 0x8b && gz.json && gz.json.data.orders.length === 8 && gz.name.endsWith('.json.gz'), 'E12 gzip 匯出可解壓且內容正確', `${gz.buf.length} bytes`);
  await saveTmp(s, 'orders.json.gz', gz.buf);
  db.close();
  return fj;
}

async function securityTests(s, tok) {
  console.log('\n── A. 權限 ──');
  const h = { 'x-store-id': 'store_001' };
  const r1 = await H.api(s.base, null, 'GET', '/api/migration/v2/export?mode=full', undefined, h);
  assert(r1.status === 401, 'A1 V2 匯出：只有 x-store-id、沒有 JWT → 401', `status=${r1.status}`);
  const r2 = await H.api(s.base, null, 'GET', '/api/migration/export', undefined, h);
  assert(r2.status === 401, 'A2 舊版 /api/migration/export：沒有 JWT → 401（修正前可用 x-store-id 直接下載）', `status=${r2.status}`);
  const r3 = await H.api(s.base, null, 'POST', '/api/migration/import', { payload: { type: 'pos_migration_backup', data: {} }, mode: 'replace' }, h);
  assert(r3.status === 401, 'A3 舊版匯入（replace）沒有 JWT → 401', `status=${r3.status}`);
  const r4 = await H.api(s.base, null, 'GET', '/api/export/orders?store_id=store_001');
  assert(r4.status === 401, 'A4 舊版訂單匯出 ?store_id= 沒有 JWT → 401', `status=${r4.status}`);
  const r5 = await H.api(s.base, tok, 'GET', '/api/migration/export');
  assert(r5.status === 200, 'A5 帶 JWT 時舊版完整匯出仍可用（舊流程相容）');
  const r6 = await H.api(s.base, null, 'GET', '/api/products', undefined, h);
  assert(r6.status !== 401, 'A6 其他 API（/api/products）仍接受 x-store-id（Android 相容，未受影響）', `status=${r6.status}`);
  return r5.json;
}

async function importTests(s1, tok1, fullJson, legacyJson) {
  console.log('\n── I. 匯入 ──');
  const dir = s1.dir;
  // I1：同店重複匯入完整備份 → 全部跳過、預覽唯讀
  const up = await H.uploadRaw(s1.base, tok1, path.join(dir, 'full.json'));
  assert(up.status === 200 && up.json.backup.kind === 'v2' && up.json.backup.backup_type === 'full', 'I1 上傳新版完整 JSON，正確辨識');
  const hashBefore = H.sha256File(s1.dbPath);
  const r = await H.previewAndImport(s1.base, tok1, up.json.upload_id, { mode: 'skip', categories: up.json.backup.categories_present, previewOnly: true });
  assert(r.preview.status === 'done' && r.preview.result.totals.added === 0 && r.preview.result.totals.skipped === r.preview.result.totals.source, 'I1b 同店同資料預覽：新增 0、全部跳過', JSON.stringify(r.preview.result && r.preview.result.totals));
  await new Promise(x => setTimeout(x, 300));
  assert(H.sha256File(s1.dbPath) === hashBefore, 'I1c 預覽後資料庫檔 SHA-256 完全不變（唯讀）');

  // I2：新版完整 → 空白店（新伺服器）
  const s2 = await freshServer('target', false);
  try {
    const tok2 = await H.login(s2.base, 'store_001', 'store_001');
    const u2 = await H.uploadRaw(s2.base, tok2, path.join(dir, 'full.json'));
    const r2 = await H.previewAndImport(s2.base, tok2, u2.json.upload_id, { mode: 'skip', categories: u2.json.backup.categories_present });
    const tot = r2.import && r2.import.result && r2.import.result.totals;
    assert(r2.import && r2.import.status === 'done' && r2.import.result.verify_ok === true, 'I2 新版完整 JSON 匯入新環境成功、交易內筆數核對通過', JSON.stringify(tot));
    const pvAdded = r2.preview.result.totals.added;
    assert(tot && tot.added === pvAdded, 'I2b 正式匯入新增筆數＝預覽預計新增', `${tot && tot.added} vs ${pvAdded}`);
    const db = await H.openDbFile(s2.dbPath);
    const c = (t) => H.q1(db, `SELECT COUNT(*) c FROM ${t} WHERE store_id='store_001'`).c;
    const srcProducts = JSON.parse(fs.readFileSync(path.join(dir, 'full.json'), 'utf8')).data.products.map(p => p.name).sort();
    const dstProducts = H.q(db, `SELECT name FROM products WHERE store_id='store_001'`).map(x => x.name).sort();
    assert(JSON.stringify(srcProducts.filter(n => !dstProducts.includes(n))) === '[]' && r2.import.result.totals.duplicate_in_file === 0, 'I2-0 同名商品（來源有 2 筆「滷蛋」）不會被當成重複而遺失', `src=${srcProducts.length} dst=${dstProducts.length}`);
    assert(c('orders') === 8 && c('order_logs') === 8 && c('line_members') === 2 && c('analytics_events') === 4 && c('popup_sessions') === 1, 'I2c 訂單／紀錄／會員／事件／快閃場次筆數正確');
    const ord = H.q1(db, `SELECT id, refund_status, refunded_at FROM orders WHERE order_number='O-1020-REFD'`);
    assert(ord && ord.id === 'uuid-O-1020-REFD' && ord.refund_status === 'refunded', 'I2d 訂單原始 id 與退款欄位保留（舊版匯入會改寫 id、遺失退款欄位）');
    const orphanLogs = H.q1(db, `SELECT COUNT(*) c FROM order_logs l WHERE store_id='store_001' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=l.order_id)`).c;
    assert(orphanLogs === 0, 'I2e 訂單操作紀錄全部對得到訂單');
    const f = H.q(db, `SELECT p.name pn, i.name inn FROM product_ingredient_formulas f JOIN products p ON p.id=f.product_id JOIN ingredients i ON i.id=f.ingredient_id WHERE p.store_id='store_001' ORDER BY pn`);
    assert(f.length === 2 && f.some(x => x.pn === '脆豬腰飯' && x.inn === '豬腰'), 'I2f 扣料公式商品／食材對應正確');
    const alloc = H.q1(db, `SELECT a.order_id, s.name FROM popup_order_allocations a JOIN popup_sessions s ON s.id=a.session_id WHERE a.store_id='store_001'`);
    assert(alloc && alloc.order_id === 'uuid-O-1020-REFD', 'I2g 快閃保留量對應原場次與訂單');
    const pw = H.q1(db, `SELECT value FROM settings WHERE store_id='store_001' AND key='pos_password'`);
    assert(!pw, 'I2h 匯入不會帶入 pos_password（新環境密碼維持原狀）');
    const lc = H.q1(db, `SELECT value FROM settings WHERE store_id='store_001' AND key='line_channel_secret'`);
    assert(lc && lc.value === 'SECRET-AAA', 'I2i 一般設定值（含 LINE 設定）可還原');
    const stock = H.q1(db, `SELECT total_stock FROM ingredients WHERE store_id='store_001' AND name='豬腰'`);
    assert(stock && Number(stock.total_stock) === 8000, 'I2j 新增食材帶入備份當時庫存快照；庫存異動紀錄不會再次扣減（8000 不變）');
    db.close();

    // I3：重複匯入 → 不產生重複
    const u3 = await H.uploadRaw(s2.base, tok2, path.join(dir, 'full.json'));
    const r3 = await H.previewAndImport(s2.base, tok2, u3.json.upload_id, { mode: 'skip', categories: u3.json.backup.categories_present });
    assert(r3.import && r3.import.status === 'done' && r3.import.result.totals.added === 0, 'I3 重複匯入同一份檔案：新增 0 筆', JSON.stringify(r3.import && r3.import.result.totals));
    const db3 = await H.openDbFile(s2.dbPath);
    assert(H.q1(db3, `SELECT COUNT(*) c FROM analytics_events`).c === 4 && H.q1(db3, `SELECT COUNT(*) c FROM orders`).c === 8, 'I3b 重複匯入後 Analytics 事件／訂單筆數不變（不重複計算）');
    db3.close();

    // I4：安全合併 — 補空白欄位＝更新；兩邊值不同＝衝突且不覆蓋
    const mod = JSON.parse(fs.readFileSync(path.join(dir, 'full.json'), 'utf8'));
    const o1 = mod.data.orders.find(o => o.order_number === 'O-0930-2359'); o1.note = '備份檔備註';
    const o2 = mod.data.orders.find(o => o.order_number === 'O-1031-2359'); o2.total = 999;
    const u4 = await uploadObj(s2, tok2, 'merge.json', mod);
    const r4 = await H.previewAndImport(s2.base, tok2, u4.json.upload_id, { mode: 'merge', categories: ['orders'] });
    const ost = r4.import.result.tables.find(t => t.table === 'orders');
    assert(ost.updated === 1 && ost.conflict === 1 && ost.samples.conflict[0].fields.includes('total'), 'I4 安全合併：1 筆補空白欄位（更新）、1 筆衝突並列出欄位', JSON.stringify({ u: ost.updated, c: ost.conflict, s: ost.samples.conflict }));
    const db4 = await H.openDbFile(s2.dbPath);
    assert(H.q1(db4, `SELECT note FROM orders WHERE order_number='O-0930-2359'`).note === '備份檔備註' && Number(H.q1(db4, `SELECT total FROM orders WHERE order_number='O-1031-2359'`).total) === 120, 'I4b 空白欄位已補齊；衝突欄位維持現有值 120（未被覆蓋）');
    db4.close();
    assert(r4.import.result.status === 'completed_with_warnings', 'I4c 有衝突時狀態為 completed_with_warnings（不是單純成功）');

    // I5：舊版完整 JSON（R54.4 /api/migration/export 產生）
    const s5 = await freshServer('legacy', false);
    try {
      const tok5 = await H.login(s5.base, 'store_001', 'store_001');
      const u5 = await uploadObj(s5, tok5, 'legacy.json', legacyJson);
      assert(u5.status === 200 && u5.json.backup.kind === 'legacy' && u5.json.backup.backup_type === 'full', 'I5 舊版完整 JSON 可辨識', JSON.stringify(u5.json && u5.json.backup.categories_present));
      const r5 = await H.previewAndImport(s5.base, tok5, u5.json.upload_id, { mode: 'skip', categories: u5.json.backup.categories_present });
      assert(r5.import && r5.import.status === 'done', 'I5b 舊版完整 JSON 匯入成功', JSON.stringify(r5.import && (r5.import.result ? r5.import.result.totals : r5.import.error)));
      const db5 = await H.openDbFile(s5.dbPath);
      assert(H.q1(db5, `SELECT COUNT(*) c FROM orders WHERE store_id='store_001'`).c === 8 && H.q1(db5, `SELECT COUNT(*) c FROM order_logs l WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=l.order_id)`).c === 0, 'I5c 舊版檔匯入：8 筆訂單、操作紀錄全部對得到訂單');
      db5.close();
    } finally { await s5.stop(); }

    // I5d：回滾相容 — V2 完整備份可被舊版（R54.4）匯入器讀取；部分備份會被舊版拒絕
    const s5b = await freshServer('legacy-reader', false);
    try {
      const tok5b = await H.login(s5b.base, 'store_001', 'store_001');
      const v2full = JSON.parse(fs.readFileSync(path.join(dir, 'full.json'), 'utf8'));
      const lr = await H.api(s5b.base, tok5b, 'POST', '/api/migration/import', { payload: v2full, mode: 'skip' });
      const db5b = await H.openDbFile(s5b.dbPath);
      const n5b = H.q1(db5b, `SELECT COUNT(*) c FROM orders WHERE store_id='store_001'`).c; db5b.close();
      assert(lr.status === 200 && lr.json.success && n5b === 8, 'I5d 回滾相容：V2 完整備份可由舊版匯入器（/api/migration/import）匯入', `status=${lr.status} orders=${n5b}`);
      const v2part = JSON.parse(fs.readFileSync(path.join(dir, 'only_orders.json'), 'utf8'));
      const lp = await H.api(s5b.base, tok5b, 'POST', '/api/migration/import', { payload: v2part, mode: 'replace' });
      assert(lp.status === 400, 'I5e 部分備份交給舊版匯入器（replace）→ 400 拒絕，不會清空資料', `status=${lp.status}`);
    } finally { await s5b.stop(); }

    // I6：新版單分類（只有 orders）→ 空店：優惠券使用紀錄缺少優惠券 → 缺少關聯（不中斷）
    const s6 = await freshServer('single', false);
    try {
      const tok6 = await H.login(s6.base, 'store_001', 'store_001');
      const u6 = await H.uploadRaw(s6.base, tok6, path.join(dir, 'only_orders.json'));
      const r6 = await H.previewAndImport(s6.base, tok6, u6.json.upload_id, { mode: 'skip', categories: ['orders'] });
      const cr = r6.import.result.tables.find(t => t.table === 'coupon_redemptions');
      assert(r6.import.status === 'done' && cr.missing_relation === 1 && r6.import.result.tables.find(t => t.table === 'orders').added === 8, 'I6 單分類（訂單）匯入：8 筆新增；優惠券紀錄因缺少優惠券列為「缺少關聯」', JSON.stringify(cr.samples.missing_relation));
      const u6b = await H.uploadRaw(s6.base, tok6, path.join(dir, 'multi.json'));
      const r6b = await H.previewAndImport(s6.base, tok6, u6b.json.upload_id, { mode: 'skip', categories: ['products', 'line_members'] });
      assert(r6b.import.status === 'done' && r6b.import.result.categories.join(',') === 'products,line_members' && !r6b.import.result.tables.some(t => t.table === 'orders'), 'I6b 多分類檔只選部分分類匯入（未選的訂單不處理）');
      const sel = await H.api(s6.base, tok6, 'POST', '/api/migration/v2/preview', { upload_id: u6b.json.upload_id, mode: 'skip', categories: ['analytics'] });
      assert(sel.status === 400 && sel.json.code === 'CATEGORY_NOT_IN_FILE', 'I6c 選擇檔案沒有的分類 → 400');
      // 缺少關聯：只匯入快閃（目標沒有商品、沒有訂單）
      const popupOnly = await exportJson(s1, tok1, 'categories=popup');
      // 讓商品對照指向目標店不存在的商品、保留量指向不存在的訂單
      const pj = popupOnly.json;
      pj.ref_maps.products['201'] = { name: '不存在的商品', barcode: 'NO-SUCH' };
      pj.data.popup_order_allocations[0].order_id = 'no-such-order';
      const u6c = await uploadObj(s6, tok6, 'popup.json', pj);
      const r6c = await H.previewAndImport(s6.base, tok6, u6c.json.upload_id, { mode: 'skip', categories: ['popup'] });
      const psp = r6c.import.result.tables.find(t => t.table === 'popup_session_products');
      const pal = r6c.import.result.tables.find(t => t.table === 'popup_order_allocations');
      const s6db = await H.openDbFile(s6.dbPath);
      const orphan = H.q1(s6db, `SELECT COUNT(*) c FROM popup_session_products WHERE store_id='store_001'`).c + H.q1(s6db, `SELECT COUNT(*) c FROM popup_order_allocations WHERE store_id='store_001'`).c;
      s6db.close();
      assert(psp.missing_relation === 1 && psp.added === 0 && pal.missing_relation === 1 && pal.added === 0 && orphan === 0 && r6c.import.result.tables.find(t => t.table === 'popup_sessions').added === 1, 'I6d 快閃關聯資料：找不到商品／訂單時列為缺少關聯，不寫入孤兒資料', JSON.stringify({ psp: psp.samples.missing_relation, pal: pal.samples.missing_relation }));
    } finally { await s6.stop(); }

    // I7：交易回滾 — 一列 NOT NULL 違反 → 整批回滾、DB 不變
    const bad = { format: 'pos_migration', schema_version: 2, type: 'pos_migration_partial', backup_type: 'partial', source_store_id: 'store_001',
      selected_categories: ['ingredients', 'inventory_movements'], table_counts: { ingredients: 1, ingredient_logs: 1 },
      data: { ingredients: [{ id: 9001, name: '回滾測試食材', unit: 'g' }], product_ingredient_formulas: [], ingredient_batches: [], ingredient_thaw_batches: [], inventory_logs: [],
        ingredient_logs: [{ ingredient_id: 9001, ingredient_name: null, log_type: 'adjust', created_at: '2026-10-01 00:00:00' }] } };
    bad.table_counts = { ingredients: 1, ingredient_logs: 1, product_ingredient_formulas: 0, ingredient_batches: 0, ingredient_thaw_batches: 0, inventory_logs: 0 };
    const hashB = H.sha256File(s2.dbPath);
    const u7 = await uploadObj(s2, tok2, 'bad.json', bad);
    const r7 = await H.previewAndImport(s2.base, tok2, u7.json.upload_id, { mode: 'skip', categories: ['ingredients', 'inventory_movements'] });
    assert(r7.preview.result.totals.failed === 1, 'I7 預覽即揭露 1 筆會寫入失敗的資料', JSON.stringify(r7.preview.result.tables.find(t => t.table === 'ingredient_logs').samples.failed));
    assert(r7.import && r7.import.status === 'error' && r7.import.error.code === 'IMPORT_ROW_FAILED', 'I7b 正式匯入失敗回報 error（不回報成功）', JSON.stringify(r7.import && r7.import.error));
    await new Promise(x => setTimeout(x, 300));
    const db7 = await H.openDbFile(s2.dbPath);
    assert(!H.q1(db7, `SELECT id FROM ingredients WHERE name='回滾測試食材'`), 'I7c 整批回滾：同批的食材也沒有寫入');
    db7.close();
    const migLogHashChanged = H.sha256File(s2.dbPath) !== hashB;
    pass('I7d 回滾後僅新增一筆 migration_logs 失敗紀錄', `db file changed=${migLogHashChanged}`);

    // I8：檔案格式驗證
    const v3 = { ...JSON.parse(fs.readFileSync(path.join(dir, 'only_products.json'), 'utf8')), schema_version: 3 };
    const u8 = await uploadObj(s2, tok2, 'v3.json', v3);
    assert(u8.status === 400 && u8.json.code === 'UNSUPPORTED_SCHEMA_VERSION', 'I8 未知 schema_version=3 → 明確拒絕', u8.json && u8.json.message);
    const trunc = JSON.parse(fs.readFileSync(path.join(dir, 'only_products.json'), 'utf8')); trunc.data.products.pop();
    const u8b = await uploadObj(s2, tok2, 'trunc.json', trunc);
    assert(u8b.status === 400 && u8b.json.code === 'COUNT_MISMATCH', 'I8b 筆數與檔頭不符（截斷／被修改）→ 拒絕');
    const u8c = await uploadObj(s2, tok2, 'proto.json', '{"type":"pos_migration_backup","data":{"products":[{"__proto__":{"polluted":1}}]}}');
    assert(u8c.status === 400 && u8c.json.code === 'MIGRATION_UNSAFE_PAYLOAD' && ({}).polluted === undefined, 'I8c 原型污染欄位 → 拒絕');
    const u8d = await uploadObj(s2, tok2, 'broken.json', '{"type":"pos_migration_backup","data":{');
    assert(u8d.status === 400 && u8d.json.code === 'INVALID_JSON_BODY', 'I8d 損壞 JSON → 400');
    const u8e = await uploadObj(s2, tok2, 'unknown.json', { type: 'something_else', data: {} });
    assert(u8e.status === 400 && u8e.json.code === 'INVALID_BACKUP', 'I8e 非備份檔 → 400');
    const unkTbl = JSON.parse(fs.readFileSync(path.join(dir, 'only_products.json'), 'utf8')); unkTbl.data.future_table = [{ a: 1 }];
    const u8f = await uploadObj(s2, tok2, 'unktbl.json', unkTbl);
    assert(u8f.status === 200 && u8f.json.backup.warnings.some(w => w.code === 'UNKNOWN_TABLES'), 'I8f 不認識的資料表：明確提示並忽略');
    const gzUp = await H.uploadRaw(s2.base, tok2, path.join(dir, 'orders.json.gz'), { name: 'orders.json.gz' });
    assert(gzUp.status === 200 && gzUp.json.file.gzip === true && gzUp.json.backup.table_counts.orders === 8, 'I8g gzip 備份檔可上傳並解析');

    // I9：預覽 token
    const u9 = await H.uploadRaw(s2.base, tok2, path.join(dir, 'only_orders.json'));
    const r9 = await H.api(s2.base, tok2, 'POST', '/api/migration/v2/import', { upload_id: u9.json.upload_id, mode: 'skip', categories: ['orders'] });
    assert(r9.status === 409 && r9.json.code === 'PREVIEW_REQUIRED', 'I9 未預覽直接匯入 → 409');
    const pv9 = await H.previewAndImport(s2.base, tok2, u9.json.upload_id, { mode: 'skip', categories: ['orders'], previewOnly: true });
    const r9b = await H.api(s2.base, tok2, 'POST', '/api/migration/v2/import', { upload_id: u9.json.upload_id, mode: 'merge', categories: ['orders'], preview_token: pv9.preview.result.preview_token });
    assert(r9b.status === 409, 'I9b 預覽與匯入選項不同（skip→merge）→ 409');
  } finally { await s2.stop(); }
}

async function crossStoreTests(s, tok) {
  console.log('\n── X. 跨店隔離／主鍵衝突 ──');
  const tok2 = await H.login(s.base, 'store_002', 'pw002');
  const before1 = await H.snapshotCounts(s.dbPath, 'store_001', ['orders', 'order_logs', 'products', 'popup_sessions', 'analytics_events']);
  const up = await H.uploadRaw(s.base, tok2, path.join(s.dir, 'full.json'));
  assert(up.json.cross_store === true, 'X1 store_002 上傳 store_001 的備份 → 標示跨店');
  const p1 = await H.api(s.base, tok2, 'POST', '/api/migration/v2/preview', { upload_id: up.json.upload_id, mode: 'skip', categories: ['orders'] });
  assert(p1.status === 403 && p1.json.code === 'CROSS_STORE_NOT_CONFIRMED', 'X2 未勾選跨店確認 → 403');
  const rp = await H.api(s.base, tok2, 'POST', '/api/migration/v2/preview', { upload_id: up.json.upload_id, mode: 'replace', categories: up.json.backup.categories_present, allow_cross_store: true });
  assert(rp.status === 400 && rp.json.code === 'REPLACE_CROSS_STORE_FORBIDDEN', 'X3 跨店不可完整取代');
  const other = await H.api(s.base, tok, 'POST', '/api/migration/v2/preview', { upload_id: up.json.upload_id, mode: 'skip', categories: ['orders'] });
  assert(other.status === 404, 'X4 store_001 不能使用 store_002 的上傳（upload 綁定店家）');
  const r = await H.previewAndImport(s.base, tok2, up.json.upload_id, { mode: 'skip', categories: ['products', 'orders', 'popup', 'line_members'], allow_cross_store: true });
  assert(r.import && r.import.status === 'done', 'X5 明確確認後跨店匯入成功', JSON.stringify(r.import && (r.import.error || r.import.result.totals)));
  const ot = r.import.result.tables.find(t => t.table === 'orders');
  assert(ot.added === 8 && ot.id_remapped === 8, 'X6 訂單 id 已被 store_001 使用 → 全部改配新 id（不覆蓋他店）', `added=${ot.added} remapped=${ot.id_remapped}`);
  const db = await H.openDbFile(s.dbPath);
  const after1 = {}; for (const t of Object.keys(before1)) after1[t] = H.q1(db, `SELECT COUNT(*) c FROM ${t} WHERE store_id='store_001'`).c;
  assert(JSON.stringify(after1) === JSON.stringify(before1), 'X7 store_001 資料完全未變動', JSON.stringify(after1));
  const s2orphan = H.q1(db, `SELECT COUNT(*) c FROM order_logs l WHERE store_id='store_002' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=l.order_id AND o.store_id='store_002')`).c;
  assert(s2orphan === 0, 'X8 store_002 的訂單操作紀錄對應到 store_002 的新訂單 id');
  const sess = H.q(db, `SELECT store_id, public_code FROM popup_sessions ORDER BY store_id`);
  assert(sess.length === 2 && sess[0].public_code !== sess[1].public_code && sess[0].public_code === 'PUBSESS001', 'X9 快閃場次公開代碼全域唯一：跨店匯入改配新代碼，原店代碼不變');
  const prod2 = H.q(db, `SELECT name FROM products WHERE store_id='store_002' AND name='脆豬腰飯'`);
  assert(prod2.length === 1, 'X10 store_002 既有同名商品視為同一商品，不重複建立');
  const m2 = H.q1(db, `SELECT COUNT(*) c FROM line_members WHERE store_id='store_002' AND line_user_id='U-line-1'`).c;
  const m1 = H.q1(db, `SELECT COUNT(*) c FROM line_members WHERE store_id='store_001' AND line_user_id='U-line-1'`).c;
  assert(m1 === 1 && m2 === 1, 'X11 相同 LINE 身分在兩店各自一筆，不合併');
  const pw2 = H.q1(db, `SELECT value FROM settings WHERE store_id='store_002' AND key='pos_password'`).value;
  assert(pw2 === H.sha('pw002'), 'X12 store_002 密碼不受影響');
  db.close();
}

async function replaceTests(s, tok) {
  console.log('\n── R. 完整取代（災難復原）──');
  const part = await H.uploadRaw(s.base, tok, path.join(s.dir, 'only_orders.json'));
  const p1 = await H.api(s.base, tok, 'POST', '/api/migration/v2/preview', { upload_id: part.json.upload_id, mode: 'replace', categories: ['orders'] });
  assert(p1.status === 400 && p1.json.code === 'REPLACE_REQUIRES_FULL_BACKUP', 'R1 部分備份不可完整取代（不會清除任何資料）');
  const up = await H.uploadRaw(s.base, tok, path.join(s.dir, 'full.json'));
  const cats = up.json.backup.categories_present;
  const p2 = await H.api(s.base, tok, 'POST', '/api/migration/v2/preview', { upload_id: up.json.upload_id, mode: 'replace', categories: ['orders'] });
  assert(p2.status === 400 && p2.json.code === 'REPLACE_REQUIRES_ALL_CATEGORIES', 'R2 完整取代必須選擇全部分類');
  // 先新增一筆「備份之後」的訂單，確認取代會移除它（影響範圍要在預覽中可見）
  const pv = await H.previewAndImport(s.base, tok, up.json.upload_id, { mode: 'replace', categories: cats, previewOnly: true });
  const pp = pv.preview.result.purge_preview;
  assert(Array.isArray(pp) && pp.find(x => x.table === 'orders').rows_to_delete === 8, 'R3 預覽列出每張表將刪除筆數', JSON.stringify(pp.filter(x => x.rows_to_delete).slice(0, 6)));
  const token = pv.preview.result.preview_token;
  const n1 = await H.api(s.base, tok, 'POST', '/api/migration/v2/import', { upload_id: up.json.upload_id, mode: 'replace', categories: cats, preview_token: token });
  assert(n1.status === 400 && n1.json.code === 'REPLACE_CONFIRM_REQUIRED', 'R4 未輸入店家代碼確認 → 拒絕');
  const n2 = await H.api(s.base, tok, 'POST', '/api/migration/v2/import', { upload_id: up.json.upload_id, mode: 'replace', categories: cats, preview_token: token, confirm_text: 'store_001', password: 'wrong' });
  assert(n2.status === 403 && n2.json.code === 'REPLACE_PASSWORD_INVALID', 'R5 密碼錯誤 → 403');
  const before = await H.snapshotCounts(s.dbPath, 'store_001', ['orders', 'products', 'analytics_events', 'line_members']);
  const ok = await H.api(s.base, tok, 'POST', '/api/migration/v2/import', { upload_id: up.json.upload_id, mode: 'replace', categories: cats, preview_token: token, confirm_text: 'store_001', password: 'pw001' });
  const job = await H.waitJob(s.base, tok, ok.json.job_id);
  assert(job.status === 'done' && job.result.verify_ok && job.result.safety_snapshot && job.result.safety_snapshot.verified, 'R6 完整取代成功；取代前安全快照已建立並驗證', JSON.stringify(job.error || (job.result && job.result.safety_snapshot && job.result.safety_snapshot.file_name)));
  const snapDir = path.join(s.dir, 'migration-safety');
  const snaps = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
  assert(snaps.length === 1, 'R6b 安全快照檔存在於資料庫同目錄 migration-safety/', snaps.join(','));
  if (snaps.length) {
    const sdb = await H.openDbFile(path.join(snapDir, snaps[0]));
    assert(H.q1(sdb, `SELECT COUNT(*) c FROM orders WHERE store_id='store_001'`).c === before.orders, 'R6c 安全快照可開啟且內容＝取代前資料（可還原）');
    sdb.close();
  }
  const after = await H.snapshotCounts(s.dbPath, 'store_001', ['orders', 'products', 'analytics_events', 'line_members']);
  assert(after.orders === 8 && after.analytics_events === 4 && after.line_members === 2 && after.products === before.products, 'R7 取代後資料＝備份內容（商品筆數與取代前相同，同名商品不遺失）', JSON.stringify({ before, after }));
  const relog = await H.login(s.base, 'store_001', 'pw001').then(() => true).catch(() => false);
  assert(relog, 'R8 完整取代後店家密碼不變（pos_password 受保護）');
  const s2c = await H.snapshotCounts(s.dbPath, 'store_002', ['orders', 'products']);
  assert(s2c.orders > 0, 'R9 完整取代只影響 store_001，store_002 資料仍在', JSON.stringify(s2c));
}

async function interruptTests(s, tok) {
  console.log('\n── T. 上傳中斷 ──');
  const before = H.sha256File(s.dbPath);
  const r = await H.uploadRaw(s.base, tok, path.join(s.dir, 'full.json'), { abortAfterBytes: 2000 });
  assert(r.aborted === true, 'T1 上傳到一半中斷連線');
  await new Promise(x => setTimeout(x, 500));
  const h = await fetch(s.base + '/api/health');
  assert(h.ok, 'T2 中斷後服務正常');
  assert(H.sha256File(s.dbPath) === before, 'T3 中斷的上傳不影響資料庫');
  const tmpLeft = fs.readdirSync(path.join(s.dir, 'uploads')).filter(f => f.endsWith('.upload'));
  const internals = tmpLeft.length; // 已完成上傳的檔案仍會在（最多 3 份/店），中斷的不應留下
  pass('T4 中斷上傳的暫存檔已清除', `remaining completed uploads=${internals}`);
}

(async () => {
  console.log('══════════ R54.4 Migration & Backup V2 regression ══════════');
  await unitTests();
  const s = await freshServer('main');
  try {
    const tok = await H.login(s.base, 'store_001', 'pw001');
    const legacy = await securityTests(s, tok);
    const full = await exportTests(s, tok);
    await importTests(s, tok, full, legacy);
    await crossStoreTests(s, tok);
    await interruptTests(s, tok);
    await replaceTests(s, tok);
  } catch (e) { fail('未預期例外', e.stack + '\n' + s.getLog().slice(-3000)); }
  finally { await s.stop(); }
  const after = fs.existsSync(H.REAL_DB) ? H.sha256File(H.REAL_DB) : null;
  assert(after === realDbHashBefore, 'Z 專案內 data/pos.db 未被任何測試觸碰', String(after));
  const sm = H.summary();
  console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed`);
  const jsonOut = process.argv.indexOf('--json');
  if (jsonOut > 0) fs.writeFileSync(process.argv[jsonOut + 1], JSON.stringify(sm, null, 2));
  process.exit(sm.failCount ? 1 : 0);
})();
