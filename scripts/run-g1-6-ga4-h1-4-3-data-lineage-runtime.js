#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-3-data-lineage-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full
//
// 追完整資料鏈（需求文件三）：
//   Raw GA4 → normalize → persist → read → Heatmap ViewModel → Dashboard
//   ViewModel。真實 SQLite temp DB + 真實 services/ga4GeoSyncService.js +
//   真實 utils/ga4Geo/normalize.js + 真實 public/js/geo-ga4-h1-panel.js /
//   geo-ga4-dashboard-layer.js（不是重寫一份邏輯來測試自己）。不使用 GA4 UI
//   人工截圖數字當唯一資料來源——那些只作為 Manual Reconciliation Report
//   的人工對帳參考（見需求文件二十二），Automated Test 一律用這裡自建、
//   可控的 fixture。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const TMP_DB = path.join(os.tmpdir(), `ga4-h1-4-3-lineage-${process.pid}-${Date.now()}.db`);
process.on('exit', () => { try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ } });
process.env.POS_DB_PATH = TMP_DB;
process.env.GA4_REALTIME_ENABLED = 'true';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/ga4GeoSyncService.js')]);
  pass('0a-parse services/ga4GeoSyncService.js node --check 通過');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'utils/ga4Geo/normalize.js')]);
  pass('0b-parse utils/ga4Geo/normalize.js node --check 通過');

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();
  const { createMockAdapter } = require(path.join(ROOT, 'utils/ga4Geo/mockAdapter'));
  const svc = require(path.join(ROOT, 'services/ga4GeoSyncService'));
  const { normalizeGa4Location } = require(path.join(ROOT, 'utils/ga4Geo/normalize'));

  function setupStore(storeId, propertyId, streamId) {
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name) VALUES (?, ?)`, [storeId, storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_enabled', 'true')`, [storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_property_id', ?)`, [storeId, propertyId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_stream_id', ?)`, [storeId, streamId]);
  }
  setupStore('store_001', '111111111', '211111111');

  const RANGE_START = '2026-08-03';
  const RANGE_END = '2026-08-09';

  // ══════════════════════════════════════════════════════════════
  // Part 1 — Raw GA4 fixture（需求文件十七）：同一 exact range，涵蓋
  // 台灣行政區（可解析）＋兩筆不同國家的 overseas raw identity＋一筆
  // all-not-set（unknown）。
  // ══════════════════════════════════════════════════════════════
  const RAW_FIXTURE = [
    { country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 41, newUsers: 9, sessions: 55 },
    { country: 'Taiwan', region: 'Taoyuan City', city: 'Taoyuan District', activeUsers: 46, newUsers: 12, sessions: 60 },
    { country: 'Taiwan', region: 'New Taipei City', city: 'Banqiao District', activeUsers: 32, newUsers: 8, sessions: 40 },
    { country: 'Japan', region: 'Tokyo', city: 'Shibuya', activeUsers: 3, newUsers: 1, sessions: 4 },
    { country: 'United States', region: 'California', city: 'Los Angeles', activeUsers: 2, newUsers: 1, sessions: 2 },
    { country: '(not set)', region: '(not set)', city: '(not set)', activeUsers: 1, newUsers: 1, sessions: 1 },
  ];

  const adapter = createMockAdapter({ audience: RAW_FIXTURE });
  const syncResult = await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: RANGE_START, end_date: RANGE_END }, { adapter });
  assert(syncResult.success === true, '1. Sync 成功寫入 6 筆 raw row（3 台灣可解析＋2 overseas＋1 unknown）', JSON.stringify(syncResult));
  assert(syncResult.rows_saved === RAW_FIXTURE.length, '2. rows_saved 等於 raw fixture 筆數（沒有中途丟資料，也沒有被誤合併成更少筆）', String(syncResult.rows_saved));

  // ══════════════════════════════════════════════════════════════
  // Part 2 — 每一層輸出 Identity（需求文件十八）：raw_location_key /
  // resolved district / range_start / range_end / metric / activeUsers /
  // synced_at / persisted identity 全部記錄下來逐一驗證。
  // ══════════════════════════════════════════════════════════════
  const read1 = svc.getRangeGeoStats('store_001', 'custom', RANGE_START, RANGE_END);
  assert(read1.success === true, '3. Read（模擬 Heatmap 的 GET）成功', JSON.stringify(read1));
  assert(read1.rows.length === RAW_FIXTURE.length, '4. Read 回來的 row 數與 raw fixture 一致（沒有 all-history 混進來，也沒有漏行）', String(read1.rows.length));

  const zhongliRow = read1.rows.find((r) => r.district_name === '中壢區');
  assert(!!zhongliRow, '5. 中壢區 resolver 成功命中（district_name===中壢區）');
  assert(zhongliRow && zhongliRow.active_users === 41, '6. 中壢區 activeUsers 精確等於 raw GA4 值 41（不是其他欄位或加總值）', JSON.stringify(zhongliRow));
  assert(zhongliRow && zhongliRow.new_users === 9 && zhongliRow.sessions === 55, '7. 中壢區 new_users/sessions 各自對應各自的 raw metric，沒有互相覆蓋', JSON.stringify(zhongliRow));
  assert(zhongliRow && zhongliRow.range_start_date === RANGE_START && zhongliRow.range_end_date === RANGE_END, '8. 中壢區 persisted row 的 range_start_date/range_end_date 精確等於這次查詢的實際日期', JSON.stringify(zhongliRow));
  assert(zhongliRow && zhongliRow.raw_location_key === 'taiwan||taoyuan city||zhongli district', '9. 中壢區 raw_location_key 精確反映 country+region+city（persisted identity 沒有因為 display 修正被改動——需求文件十三）', zhongliRow && zhongliRow.raw_location_key);
  assert(zhongliRow && typeof zhongliRow.synced_at_utc === 'string' && zhongliRow.synced_at_utc.length > 0, '10. 中壢區 persisted row 有記錄 synced_at_utc（不是 null／空字串）');

  const taoyuanRow = read1.rows.find((r) => r.district_name === '桃園區');
  const banqiaoRow = read1.rows.find((r) => r.district_name === '板橋區');
  assert(!!taoyuanRow && taoyuanRow.active_users === 46, '11. 桃園區 activeUsers 精確等於 46');
  assert(!!banqiaoRow && banqiaoRow.active_users === 32, '12. 板橋區（region=New Taipei City／city=Banqiao District，與中壢/桃園不同縣市）resolver 正確解析成板橋區，沒有跟同一次 sync 裡其他縣市的行政區混在一起', JSON.stringify(banqiaoRow));
  assert(banqiaoRow && banqiaoRow.county_name === '新北市', '13. 板橋區 county_name 正確回傳新北市（沒有被同一批次裡其他行政區的縣市污染）', banqiaoRow && banqiaoRow.county_name);

  // ══════════════════════════════════════════════════════════════
  // Part 3 — Metric Definition（需求文件十九）：GA4 UI 的「使用者」對應
  // activeUsers，不是 users/totalUsers/newUsers/sessions/events。這裡直接
  // 檢查 persisted schema／service 程式碼路徑，確認寫入的欄位來源正確。
  // ══════════════════════════════════════════════════════════════
  {
    const svcSrc = fs.readFileSync(path.join(ROOT, 'services/ga4GeoSyncService.js'), 'utf8');
    assert(/entry\.active_users\s*=\s*row\.metrics\.activeUsers/.test(svcSrc), '14. Service 寫入 active_users 欄位的來源精確是 GA4 metrics.activeUsers（不是 totalUsers/newUsers/sessions）', 'grep failed');
    assert(!/entry\.active_users\s*=\s*row\.metrics\.(totalUsers|sessions|newUsers|events)/.test(svcSrc), '15. 沒有任何路徑把 totalUsers/sessions/newUsers/events 誤寫進 active_users 欄位');
  }

  // ══════════════════════════════════════════════════════════════
  // Part 4 — Overseas/Other：兩個不同 raw identity 各自是獨立 persisted
  // row（不是 duplicate），display 需要能區分（需求文件十二、二十七）。
  // ══════════════════════════════════════════════════════════════
  const overseasRows = read1.rows.filter((r) => r.normalization_status === 'overseas_or_other');
  assert(overseasRows.length === 2, '16. Japan／United States 兩筆 raw identity 各自是獨立 persisted row（rows.length===2，不是被合併成 1 筆，也沒有意外多出第 3 筆）', String(overseasRows.length));
  assert(new Set(overseasRows.map((r) => r.raw_location_key)).size === 2, '17. 兩筆 overseas row 的 raw_location_key 確實不同（真的是不同 raw identity，不是同一筆重複寫入兩次）', JSON.stringify(overseasRows.map((r) => r.raw_location_key)));
  {
    const dom = new JSDOM('<div></div>');
    global.window = dom.window; global.document = dom.window.document;
    const panelPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js'));
    delete require.cache[panelPath];
    const panel = require(panelPath);
    const labels = overseasRows.map((r) => panel._geoGa4H1RowLabel(r));
    assert(labels[0] !== labels[1], '18. 兩筆 overseas row 用真實 Production _geoGa4H1RowLabel() 算出來的顯示文字不再完全相同', JSON.stringify(labels));
    const sumOfOverseas = overseasRows.reduce((s, r) => s + r.active_users, 0);
    assert(sumOfOverseas === 5, '19. Sanity：兩筆 overseas row 各自的 activeUsers 仍是原始值（3+2=5），沒有被 sync 階段錯誤合併成一筆彙總數字', String(sumOfOverseas));
  }

  const unknownRows = read1.rows.filter((r) => r.normalization_status === 'unknown');
  assert(unknownRows.length === 1 && unknownRows[0].active_users === 1, '20. all-not-set 的 raw row 正確分類成 unknown，且 activeUsers 保留原始值', JSON.stringify(unknownRows));

  // ══════════════════════════════════════════════════════════════
  // Part 5 — 禁止跨 Snapshot Sum activeUsers（需求文件二十五、二十七）：
  // 對同一行政區分別 sync「today」與「這個 7 天 custom range」，兩次 GA4
  // adapter 回傳完全不相關的數字，驗證 7d 的 persisted 值精確等於這次
  // query 自己回傳的值，不是 today 快取的累加。
  // ══════════════════════════════════════════════════════════════
  {
    const todayAdapter = createMockAdapter({ audience: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 999, newUsers: 0, sessions: 999 }] });
    await svc.syncGeoRangeStats('store_001', { type: 'today' }, { adapter: todayAdapter });
    const todayRead = svc.getRangeGeoStats('store_001', 'today', null, null);
    const todayZhongli = todayRead.rows.find((r) => r.district_name === '中壢區');
    assert(!!todayZhongli && todayZhongli.active_users === 999, '21. today 這個獨立 range 的中壢區 activeUsers=999（跟 7d 的 41 完全無關的另一份 snapshot）');

    // 重新讀一次 7d（RANGE_START~RANGE_END），確認沒有被 today 的 999 污染
    // 或加總（41+999、41 都不該變成別的數字）。
    const read7dAgain = svc.getRangeGeoStats('store_001', 'custom', RANGE_START, RANGE_END);
    const zhongli7dAgain = read7dAgain.rows.find((r) => r.district_name === '中壢區');
    assert(!!zhongli7dAgain && zhongli7dAgain.active_users === 41, '22. 7d 的中壢區重新讀取仍是 41，沒有被 today 的 999 覆蓋或加總（不同 range identity 完全隔離）', JSON.stringify(zhongli7dAgain));

    const svcSrcForSum = fs.readFileSync(path.join(ROOT, 'services/ga4GeoSyncService.js'), 'utf8');
    assert(!/active_users\s*\+=/.test(svcSrcForSum), '23. Service 寫入 active_users 沒有任何 += 累加寫法（每次都是同一次 GA4 Query 內的單一指定值，不是跨查詢累加）', 'grep failed');
  }

  // ══════════════════════════════════════════════════════════════
  // Part 6 — Cross-view Consistency（需求文件十九、二十四、二十五）：
  // Dashboard 與 Heatmap 對「同一 exact range」各自呼叫（模擬兩個分開的
  // browser tab 各自發自己的 GET），中壢區的 activeUsers 必須完全一致，
  // 且能追溯回同一筆 persisted row（同一個 raw_location_key／synced_at）。
  // ══════════════════════════════════════════════════════════════
  const heatmapRead = svc.getRangeGeoStats('store_001', 'custom', RANGE_START, RANGE_END); // 模擬 Heatmap 的 GET
  const dashboardRead = svc.getRangeGeoStats('store_001', 'custom', RANGE_START, RANGE_END); // 模擬 Dashboard 的 GET（同一 exact range，獨立呼叫）
  const heatmapZhongli = heatmapRead.rows.find((r) => r.district_name === '中壢區');
  const dashboardZhongli = dashboardRead.rows.find((r) => r.district_name === '中壢區');
  assert(!!heatmapZhongli && !!dashboardZhongli, '24. Heatmap 與 Dashboard 兩次獨立 GET 都成功找到中壢區 row');
  assert(heatmapZhongli.active_users === dashboardZhongli.active_users, '25. 同一 exact range，Heatmap 中壢區 activeUsers === Dashboard 中壢區 activeUsers（不是 1 vs 31 這種不同來源的落差）', `heatmap=${heatmapZhongli.active_users} dashboard=${dashboardZhongli.active_users}`);
  assert(heatmapZhongli.synced_at_utc === dashboardZhongli.synced_at_utc && heatmapZhongli.raw_location_key === dashboardZhongli.raw_location_key, '26. 兩邊追溯回同一筆 persisted row（synced_at_utc／raw_location_key 完全一致，證明真的是同一份資料，不是兩份不同 snapshot 恰好數字一樣）');

  // 用真實 Production render 函式各自畫一次，確認畫面上顯示的數字也一致
  // （不是 service 層一致，但某個 render 函式又算錯）。
  {
    const dom = new JSDOM('<div></div>');
    global.window = dom.window; global.document = dom.window.document; global.L = undefined;
    const panelPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js'));
    const dashboardPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js'));
    delete require.cache[panelPath]; delete require.cache[dashboardPath];
    const panel = require(panelPath);
    const dashboardLayer = require(dashboardPath);
    const heatmapTooltip = panel.geoGa4H1BuildTooltip(heatmapZhongli);
    const dashboardTooltip = dashboardLayer._geoDashboardGa4BuildTooltip(dashboardZhongli, '2026/08/03 ～ 2026/08/09');
    assert(heatmapTooltip.includes('活躍使用者：41'), '27. Heatmap Tooltip render 出來的文字精確包含 41', heatmapTooltip);
    assert(dashboardTooltip.includes('活躍使用者：41'), '28. Dashboard Tooltip render 出來的文字精確包含 41', dashboardTooltip);
  }

  // ══════════════════════════════════════════════════════════════
  // Part 7 — Marker Coverage vs Value Mismatch（需求文件二十、二十一）：
  // 如果某些 row 沒有可信代表點（無法畫 marker），這是 mapping coverage
  // 缺口，不是數值錨定錯誤——已經成功畫出 marker 的行政區，數值仍必須
  // 跟 Table 一致。這裡用 overseas/unknown rows（administrative_level===
  // null，marker_point 必為 null）驗證這個區分。
  // ══════════════════════════════════════════════════════════════
  {
    const rowsWithoutMarker = read1.rows.filter((r) => !r.marker_point);
    const rowsWithMarker = read1.rows.filter((r) => !!r.marker_point);
    assert(rowsWithoutMarker.length === 3, '29. overseas(2)+unknown(1) 三筆 row 確實沒有 marker_point（coverage gap，不是數值錯誤）', String(rowsWithoutMarker.length));
    assert(rowsWithMarker.length === 3, '30. 三筆台灣可解析行政區都有 marker_point（中壢/桃園/板橋）', String(rowsWithMarker.length));
    const zhongliWithMarker = rowsWithMarker.find((r) => r.district_name === '中壢區');
    assert(!!zhongliWithMarker && zhongliWithMarker.active_users === 41, '31. 已經有 marker 的中壢區，數值仍精確等於 41（marker coverage 與 activeUsers 數值是兩個獨立維度，不能混為一談）');
  }

  console.log('\n======================================================================');
  console.log('H1.4.3 DATA LINEAGE RUNTIME SUMMARY');
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
