#!/usr/bin/env node
// scripts/run-r54-4-mbv2-ui.js — R54.4-MBV2 前端實機測試（Playwright + Chrome）
// 需要：playwright（可用 NODE_PATH 指向全域安裝）與 Chrome。只連線本機暫存伺服器。
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/mbv2-harness');
const Seed = require('./lib/mbv2-seed');
const { assert, fail } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('playwright not installed — skip'); process.exit(0); }

(async () => {
  console.log('══════════ R54.4-MBV2 UI (real browser) ══════════');
  const dir = H.tmpDir('ui'); const dbf = path.join(dir, 'pos.db');
  let s = await H.startServer(dbf); await s.stop();
  const db = await H.openDbFile(dbf); Seed.seedStore001(db); H.saveDbFile(db, dbf); db.close();
  s = await H.startServer(dbf);
  const shots = process.env.MBV2_SHOT_DIR || dir;
  const browser = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--no-sandbox'] });
  const errors = [];
  try {
    const tok = await H.login(s.base, 'store_001', 'pw001');
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '脆豬腰' })); }, [tok]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(s.base + '/');
    await page.waitForFunction(() => typeof window.mbv2Init === 'function' && typeof window.showPage === 'function');
    await page.evaluate(() => { showPage('settings'); switchSettingsTab('migration'); });
    await page.waitForSelector('#mbv2ExportList .mbv2-item', { timeout: 15000 });
    const items = await page.$$eval('#mbv2ExportList .mbv2-item', (els) => els.length);
    assert(items === 12, 'UI1 匯出區顯示 12 個分類', String(items));
    const limitText = await page.textContent('#mbv2LimitText');
    assert(limitText.includes('192MB'), 'UI2 顯示上傳上限 192MB', limitText);
    await page.screenshot({ path: path.join(shots, 'mbv2-ui-1-export-full.png'), fullPage: false });

    // 完整匯出下載
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mbv2ExportBtn')]);
    const fullFile = path.join(dir, dl.suggestedFilename()); await dl.saveAs(fullFile);
    const fj = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
    assert(/^pos_backup_store_001_full_\d{8}\.json$/.test(dl.suggestedFilename()) && fj.backup_type === 'full', 'UI3 一鍵完整匯出下載', dl.suggestedFilename());

    // 選擇性：取消全選 → 空選擇 → 勾訂單 → 指定月份
    await page.check('input[name="mbv2ExportMode"][value="selective"]');
    await page.waitForSelector('#mbv2ExportToolbar:not([style*="none"])');
    await page.click('#mbv2ExportToolbar >> text=取消全選');
    const emptyMsg = await page.textContent('#mbv2ExportSummary');
    const disabled = await page.$eval('#mbv2ExportBtn', (b) => b.disabled);
    assert(emptyMsg.includes('請至少選擇') && disabled, 'UI4 取消全選 → 提示並停用下載鈕');
    await page.click('#mbv2ExportToolbar >> text=/^全選$/');
    const allChecked = await page.$$eval('#mbv2ExportList input[type=checkbox]', (els) => els.every((e) => e.checked));
    assert(allChecked, 'UI5 全選 → 全部勾選');
    await page.click('#mbv2ExportToolbar >> text=取消全選');
    await page.check('#mbv2ExportList .mbv2-item:has-text("訂單紀錄") input[type=checkbox]');
    await page.selectOption('.mbv2-date[data-key="orders"] select', 'month');
    await page.fill('.mbv2-date[data-key="orders"] input[type=month]', '2026-10');
    await page.dispatchEvent('.mbv2-date[data-key="orders"] input[type=month]', 'change');
    // 10 月：訂單 5 + 操作紀錄 5 + 優惠券使用 1 = 11 筆
    const metaSel = '#mbv2ExportList .mbv2-item:has-text("訂單紀錄") .mbv2-item-meta';
    await page.waitForFunction((sel) => { const e = document.querySelector('#mbv2ExportList'); return [...e.querySelectorAll('.mbv2-item')].some(i => i.innerText.includes('訂單紀錄') && i.querySelector('.mbv2-item-meta').innerText.startsWith('11 筆')); }, metaSel, { timeout: 15000 }).catch(() => {});
    const meta = await page.textContent(metaSel);
    assert(meta.startsWith('11 筆'), 'UI6 選指定月份 2026-10 後預覽筆數即時更新為 11 筆（全部 17 筆）', meta.trim());
    const warn = await page.textContent('#mbv2ExportList .mbv2-item:has-text("訂單紀錄")');
    assert(warn.includes('建議一起匯出'), 'UI7 提示建議一起匯出的關聯分類');
    await page.screenshot({ path: path.join(shots, 'mbv2-ui-2-export-orders-month.png') });
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#mbv2ExportBtn')]);
    assert(dl2.suggestedFilename() === 'pos_backup_store_001_orders_20261001_20261031.json', 'UI8 依月份匯出訂單檔名', dl2.suggestedFilename());
    const octFile = path.join(dir, dl2.suggestedFilename()); await dl2.saveAs(octFile);

    // 匯入：選擇完整備份 → 備份資訊 → 預覽（唯讀）
    const hashBefore = H.sha256File(dbf);
    await page.setInputFiles('#mbv2FileInput', fullFile);
    await page.waitForSelector('#mbv2ImportOptions:not([style*="none"])', { timeout: 20000 });
    const info = await page.textContent('#mbv2BackupInfo');
    assert(info.includes('store_001') && info.includes('完整備份') && info.includes('schema_version 2'), 'UI9 顯示備份來源／版本／類型');
    await page.click('#mbv2PreviewBtn');
    await page.waitForSelector('#mbv2PreviewBox .mbv2-table', { timeout: 30000 });
    const pvText = await page.textContent('#mbv2PreviewBox');
    assert(pvText.includes('預計新增') && pvText.includes('缺少關聯') && pvText.includes('唯讀'), 'UI10 預覽表格含新增／更新／跳過／衝突／缺少關聯欄位');
    await page.screenshot({ path: path.join(shots, 'mbv2-ui-3-import-preview.png'), fullPage: false });
    await new Promise((r) => setTimeout(r, 300));
    assert(H.sha256File(dbf) === hashBefore, 'UI11 前端預覽後資料庫檔案未變更');
    const ibDisabled = await page.$eval('#mbv2ImportBtn', (b) => b.disabled);
    assert(ibDisabled, 'UI12 同店同資料（新增 0）→ 確認匯入鈕停用');
    // 變更選項 → 預覽失效
    await page.check('input[name="mbv2ImportMode"][value="merge"]');
    const hidden = await page.$eval('#mbv2ImportBtn', (b) => b.style.display === 'none');
    assert(hidden, 'UI13 變更匯入模式後需重新預覽（確認鈕隱藏）');
    // 完整取代：自動全選且鎖定
    await page.check('input[name="mbv2ImportMode"][value="replace"]');
    const locked = await page.$$eval('#mbv2ImportCats input[type=checkbox]', (els) => els.every((e) => e.checked && e.disabled));
    assert(locked, 'UI14 完整取代模式：分類全選並鎖定');

    // 匯入部分備份（訂單 10 月）到 store_002（跨店確認流程）—— 以第二個 context 登入 store_002
    const tok2 = await H.login(s.base, 'store_002', 'pw002');
    const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx2.addInitScript(([t]) => { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_002' })); }, [tok2]);
    const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errors.push(e.message)); p2.on('dialog', (d) => d.accept());
    await p2.goto(s.base + '/');
    await p2.waitForFunction(() => typeof window.mbv2Init === 'function');
    await p2.evaluate(() => { showPage('settings'); switchSettingsTab('migration'); });
    await p2.setInputFiles('#mbv2FileInput', octFile);
    await p2.waitForSelector('#mbv2ImportOptions:not([style*="none"])', { timeout: 20000 });
    const replaceDisabled = await p2.$eval('input[name="mbv2ImportMode"][value="replace"]', (e) => e.disabled);
    assert(replaceDisabled, 'UI15 部分備份／跨店：完整取代選項停用');
    await p2.click('#mbv2PreviewBtn');
    const st = await p2.textContent('#mbv2ImportStatus');
    assert(st.includes('跨店'), 'UI16 跨店未勾選確認 → 不送出預覽並提示', st.trim());
    await p2.check('#mbv2CrossCheck');
    await p2.click('#mbv2PreviewBtn');
    await p2.waitForSelector('#mbv2PreviewBox .mbv2-table', { timeout: 30000 });
    await p2.waitForFunction(() => !document.querySelector('#mbv2ImportBtn').disabled);
    await p2.click('#mbv2ImportBtn');
    await p2.waitForFunction(() => /匯入完成/.test(document.querySelector('#mbv2ImportStatus').innerText), null, { timeout: 60000 });
    const res = await p2.textContent('#mbv2ImportStatus');
    assert(res.includes('新增 10') && res.includes('缺少關聯 1') && res.includes('筆數核對：✅'), 'UI17 跨店匯入 10 月訂單：新增 10 筆（訂單 5＋操作紀錄 5）、優惠券紀錄缺少關聯 1 筆並以警告呈現', res.slice(0, 160).replace(/\s+/g, ' '));
    await p2.screenshot({ path: path.join(shots, 'mbv2-ui-4-import-result.png'), fullPage: false });
    const c2 = await H.snapshotCounts(dbf, 'store_002', ['orders']);
    const c1 = await H.snapshotCounts(dbf, 'store_001', ['orders']);
    assert(c2.orders === 6 && c1.orders === 8, 'UI18 資料庫：store_002 新增 5 筆、store_001 不變', JSON.stringify({ c1, c2 }));
    assert(errors.length === 0, 'UI19 頁面無 JavaScript 錯誤', errors.join(' | '));
  } catch (e) { fail('未預期例外', e.stack + '\n' + errors.join('\n')); }
  finally { await browser.close(); await s.stop(); }
  const sm = H.summary();
  console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed  (screenshots: ${shots})`);
  const j = process.argv.indexOf('--json'); if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(sm, null, 2));
  process.exit(sm.failCount ? 1 : 0);
})();
