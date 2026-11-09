#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-large-upload.js — R54.4-MBV2 大檔案上傳／記憶體測試
//
// 以真實 `node server.js` + 暫存 SQLite 執行；產生的大檔放在 os.tmpdir()，測試結束即刪除。
// 用法：node scripts/smoke-r54-4-mbv2-large-upload.js [--skip-real-import] [--json out.json]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('./lib/mbv2-harness');
const { assert, pass, fail } = H;
const MB = 1024 * 1024;

// 產生「指定位元組數」的合法舊版格式 JSON（以未知資料區塊填充，不含真實資料）
function writePaddedJson(file, targetBytes) {
  const head = '{"type":"pos_migration_backup","store_id":"store_001","data":{"products":[],"_pad":"';
  const tail = '"}}';
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, head);
  let remaining = targetBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const block = Buffer.alloc(4 * MB, 'x');
  while (remaining > 0) { const n = Math.min(remaining, block.length); fs.writeSync(fd, block, 0, n); remaining -= n; }
  fs.writeSync(fd, tail);
  fs.closeSync(fd);
  return fs.statSync(file).size;
}

// 產生接近 targetBytes 的「真實結構」V2 Analytics 部分備份（事件欄位與正式資料相同）
function writeRealisticAnalytics(file, targetBytes) {
  const fd = fs.openSync(file, 'w');
  const sample = (i) => JSON.stringify({ id: i + 1, store_id: 'store_001', visitor_id: 'v' + (i % 50000), session_id: 's' + (i % 120000), cart_id: 'c' + (i % 30000),
    order_id: null, event_name: ['view_item', 'add_to_cart', 'begin_checkout', 'page_view'][i % 4], product_id: 1 + (i % 12), quantity: 1, order_mode: 'takeout',
    source: 'line', medium: 'social', campaign: 'oct_campaign_2026', referrer: 'https://liff.line.me/xxxxxxxx', landing_page: '/line-order?store_id=store_001&utm_source=line',
    fbclid: null, gclid: null, metadata_json: '{"ua":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Line/14.0","screen":"390x844"}',
    created_at: `2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
    identity_key: 'v' + (i % 50000), identity_type: 'visitor', is_estimated_identity: 0, order_channel: 'line', page_type: 'menu',
    geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium' });
  // 先估算筆數，再寫入（檔頭的 table_counts 必須正確）
  const avg = Buffer.byteLength(sample(12345)) + 1;
  const n = Math.floor((targetBytes - 2000) / avg);
  const header = JSON.stringify({ format: 'pos_migration', schema_version: 2, type: 'pos_migration_partial', backup_type: 'partial', source_store_id: 'store_001',
    store_id: 'store_001', exported_at: '2026-11-09T20:00:00+08:00', selected_categories: ['analytics'], filters: {}, table_counts: { analytics_events: n, geo_visit_log: 0 } });
  fs.writeSync(fd, header.slice(0, -1) + ',"data":{"geo_visit_log":[],"analytics_events":[');
  let buf = [];
  for (let i = 0; i < n; i++) {
    buf.push((i ? ',' : '') + sample(i));
    if (buf.length >= 5000) { fs.writeSync(fd, buf.join('')); buf = []; }
  }
  if (buf.length) fs.writeSync(fd, buf.join(''));
  fs.writeSync(fd, ']}}');
  fs.closeSync(fd);
  return { bytes: fs.statSync(file).size, events: n };
}

async function freshServer(tag, env) {
  const dir = H.tmpDir(tag);
  const dbf = path.join(dir, 'pos.db');
  const s = await H.startServer(dbf, env || {});
  s.dir = dir; global.__lastServer = s;
  return s;
}

(async () => {
  console.log('══════════ R54.4-MBV2 large upload / memory ══════════');
  const work = H.tmpDir('big');
  const skipReal = process.argv.includes('--skip-real-import');
  try {
    // ── L1：預設 192MB ─────────────────────────────────────────────
    let s = await freshServer('l192', {});
    try {
      const tok = await H.login(s.base);
      const cfg = await H.api(s.base, tok, 'GET', '/api/migration/v2/config');
      assert(cfg.json.upload_limit_mb === 192 && cfg.json.max_upload_limit_mb === 256, 'L1 未設定環境變數 → 預設 192MB，最高 256MB', JSON.stringify({ u: cfg.json.upload_limit_mb, m: cfg.json.max_upload_limit_mb }));
      const legacyCfg = await H.api(s.base, tok, 'GET', '/api/migration/config');
      assert(legacyCfg.json.upload_limit_mb === 192, 'L1b 舊版 /api/migration/config 同步回報 192MB');
      const f1 = path.join(work, 'under192.json');
      const b1 = writePaddedJson(f1, 191 * MB);
      const r1 = await H.uploadRaw(s.base, tok, f1);
      assert(r1.status === 200 && r1.json.file.bytes === b1, `L2 ${(b1 / MB).toFixed(1)}MB（192MB 以下）上傳並解析成功`, `status=${r1.status}`);
      fs.unlinkSync(f1);
      const f2 = path.join(work, 'over192.json');
      const b2 = writePaddedJson(f2, 192 * MB + 1024);
      const r2 = await H.uploadRaw(s.base, tok, f2);
      assert(r2.status === 413 && r2.json && r2.json.code === 'MIGRATION_FILE_TOO_LARGE' && r2.json.max_size_mb === 192, `L3 ${(b2 / MB).toFixed(3)}MB（超過 192MB）→ HTTP 413 JSON`, `status=${r2.status}`);
      const r2b = await H.uploadRaw(s.base, tok, f2, { contentLength: false });
      assert(r2b.status === 413 || r2b.status === 0, 'L3b 無 Content-Length（chunked）超過上限 → 串流中途拒絕（413 或連線關閉）', `status=${r2b.status}`);
      await new Promise(x => setTimeout(x, 300));
      const left = fs.existsSync(path.join(s.dir, 'uploads')) ? fs.readdirSync(path.join(s.dir, 'uploads')).filter(f => f.endsWith('.upload')).length : 0;
      assert(left <= 1, 'L3c 被拒的超大上傳沒有留下暫存檔', `upload files=${left}`);
      fs.unlinkSync(f2);
      const h = await fetch(s.base + '/api/health');
      assert(h.ok, 'L3d 拒絕後服務正常');
      // 一般 API 仍維持 5MB
      const big = 'x'.repeat(6 * MB);
      const r3 = await H.api(s.base, tok, 'POST', '/api/products', { name: big });
      assert(r3.status === 413, 'L4 一般 API（/api/products）6MB body 仍回 413（未提高一般 API 限制）', `status=${r3.status}`);
      // gzip 炸彈：壓縮後很小、解壓後超過上限
      const bomb = path.join(work, 'bomb.json.gz');
      const gz = zlib.createGzip({ level: 9 }); const out = fs.createWriteStream(bomb); gz.pipe(out);
      gz.write('{"type":"pos_migration_backup","data":{"_pad":"');
      const zeros = Buffer.alloc(8 * MB, 'a'); for (let i = 0; i < 30; i++) gz.write(zeros);
      gz.end('"}}'); await new Promise(r => out.on('finish', r));
      const r4 = await H.uploadRaw(s.base, tok, bomb, { name: 'bomb.json.gz' });
      assert(r4.status === 413 && r4.json.code === 'MIGRATION_DECOMPRESSED_TOO_LARGE', `L5 gzip 炸彈（壓縮 ${(fs.statSync(bomb).size / 1024).toFixed(0)}KB、解壓 240MB）→ 413 拒絕`, `status=${r4.status} ${r4.json && r4.json.code}`);
      fs.unlinkSync(bomb);
    } finally { await s.stop(); }

    // ── L6：設定 256MB ─────────────────────────────────────────────
    s = await freshServer('l256', { MIGRATION_UPLOAD_LIMIT_MB: '256' });
    try {
      const tok = await H.login(s.base);
      const cfg = await H.api(s.base, tok, 'GET', '/api/migration/v2/config');
      assert(cfg.json.upload_limit_mb === 256, 'L6 MIGRATION_UPLOAD_LIMIT_MB=256 → 256MB');
      const f = path.join(work, 'u250.json');
      const b = writePaddedJson(f, 250 * MB);
      const t0 = Date.now();
      const r = await H.uploadRaw(s.base, tok, f);
      assert(r.status === 200, `L7 ${(b / MB).toFixed(1)}MB 在 256MB 設定下上傳並解析成功`, `status=${r.status} ${Date.now() - t0}ms peakRSS=${(H.peakRssKb(s.proc.pid) / 1024).toFixed(0)}MB`);
      fs.unlinkSync(f);
      const f2 = path.join(work, 'o256.json');
      writePaddedJson(f2, 256 * MB + 1);
      const r2 = await H.uploadRaw(s.base, tok, f2);
      assert(r2.status === 413 && r2.json.max_size_mb === 256, 'L8 超過 256MB（256MB+1 byte）→ 413');
      fs.unlinkSync(f2);
    } finally { await s.stop(); }

    s = await freshServer('l500', { MIGRATION_UPLOAD_LIMIT_MB: '500' });
    try {
      const tok = await H.login(s.base);
      const cfg = await H.api(s.base, tok, 'GET', '/api/migration/v2/config');
      assert(cfg.json.upload_limit_mb === 256, 'L9 MIGRATION_UPLOAD_LIMIT_MB=500 → 硬上限 256MB');
    } finally { await s.stop(); }

    // ── L10：真實結構 ~185MB Analytics 檔：上傳 → 預覽 → 匯入，量測記憶體 ──
    if (!skipReal) {
      const f = path.join(work, 'analytics185.json');
      const { bytes, events } = writeRealisticAnalytics(f, 185 * MB);
      s = await freshServer('real', {});
      try {
        const tok = await H.login(s.base);
        const rssIdle = H.rssKb(s.proc.pid);
        let t0 = Date.now();
        const up = await H.uploadRaw(s.base, tok, f);
        const tUp = Date.now() - t0;
        assert(up.status === 200 && up.json.backup.table_counts.analytics_events === events, `L10 真實結構 ${(bytes / MB).toFixed(1)}MB（${events.toLocaleString()} 筆事件）上傳＋解析＋檔頭筆數核對`, `${tUp}ms`);
        t0 = Date.now();
        const pv = await H.api(s.base, tok, 'POST', '/api/migration/v2/preview', { upload_id: up.json.upload_id, mode: 'skip', categories: ['analytics'] });
        // 預覽進行中（event loop 被同步運算佔住）期間，另一個請求應在完成後得到回應而不是失敗
        const healthDuring = (async () => { for (let i = 0; i < 3; i++) { try { const r = await fetch(s.base + '/api/health'); return r.ok; } catch { await new Promise(x => setTimeout(x, 300)); } } return false; })();
        const pj = await H.waitJob(s.base, tok, pv.json.job_id, 1800000);
        const tPv = Date.now() - t0;
        pass('L11a 預覽後記憶體峰值', `peak=${(H.peakRssKb(s.proc.pid) / 1024).toFixed(0)}MB`);
        assert(pj.status === 'done' && pj.result.totals.added === events, `L11 預覽完成：預計新增 ${events.toLocaleString()} 筆`, `${tPv}ms`);
        assert(await healthDuring, 'L11b 預覽期間送出的其他請求在預覽結束後正常回應（服務未崩潰）');
        t0 = Date.now();
        const im = await H.api(s.base, tok, 'POST', '/api/migration/v2/import', { upload_id: up.json.upload_id, mode: 'skip', categories: ['analytics'], preview_token: pj.result.preview_token });
        const ij = await H.waitJob(s.base, tok, im.json.job_id, 1800000);
        const tIm = Date.now() - t0;
        assert(ij.status === 'done' && ij.result.totals.added === events && ij.result.verify_ok, `L12 正式匯入完成並通過筆數核對`, `${tIm}ms`);
        const peak = H.peakRssKb(s.proc.pid);
        const dbSize = fs.statSync(s.dbPath).size;
        pass('L13 記憶體量測（伺服器行程 VmHWM 峰值）', `idle=${(rssIdle / 1024).toFixed(0)}MB peak=${(peak / 1024).toFixed(0)}MB dbFile=${(dbSize / MB).toFixed(1)}MB upload=${tUp}ms preview=${tPv}ms import=${tIm}ms`);
        const h = await fetch(s.base + '/api/health');
        assert(h.ok, 'L14 匯入後服務正常');
        const db = await H.openDbFile(s.dbPath);
        const c = H.q1(db, `SELECT COUNT(*) c FROM analytics_events WHERE store_id='store_001'`).c;
        db.close();
        assert(c === events, 'L15 磁碟上的資料庫檔筆數＝匯入筆數（已持久化）', String(c));
        // 重複匯入同一大檔 → 0 新增
        const up2 = await H.uploadRaw(s.base, tok, f);
        const pv2 = await H.api(s.base, tok, 'POST', '/api/migration/v2/preview', { upload_id: up2.json.upload_id, mode: 'skip', categories: ['analytics'] });
        const pj2 = await H.waitJob(s.base, tok, pv2.json.job_id, 1800000);
        assert(pj2.status === 'done' && pj2.result.totals.added === 0, 'L16 大檔重複匯入預覽：新增 0（事件去重）');
        pass('L17 第二次（重複）預覽後記憶體峰值', `peak=${(H.peakRssKb(s.proc.pid) / 1024).toFixed(0)}MB`);
      } finally { await s.stop(); }
      // ── L18／L19：記憶體受限的伺服器（模擬小規格主機）──
      s = await freshServer('heap512', { __nodeArgs: ['--max-old-space-size=512'] });
      try {
        const tok = await H.login(s.base);
        const up = await H.uploadRaw(s.base, tok, f);
        const alive = await fetch(s.base + '/api/health').then(r => r.ok).catch(() => false);
        assert(up.status === 507 && up.json.code === 'MIGRATION_INSUFFICIENT_MEMORY' && alive && s.proc.exitCode == null,
          'L18 heap 512MB 主機上傳 185MB：回 507 記憶體不足並提示分批，服務不中斷（修正前會 V8 OOM 使整個 POS 程序結束）', `status=${up.status} ${up.json && up.json.required_mb}/${up.json && up.json.available_mb}MB`);
      } finally { await s.stop(); }
      s = await freshServer('heap1024', { __nodeArgs: ['--max-old-space-size=1024'] });
      try {
        const tok = await H.login(s.base);
        const up = await H.uploadRaw(s.base, tok, f);
        const r = up.status === 200 ? await H.previewAndImport(s.base, tok, up.json.upload_id, { mode: 'skip', categories: ['analytics'] }) : {};
        assert(r.import && r.import.status === 'done' && r.import.result.totals.added === events, 'L19 heap 1GB 主機可完成 185MB 匯入', `peakRSS=${(H.peakRssKb(s.proc.pid) / 1024).toFixed(0)}MB`);
      } finally { await s.stop(); fs.unlinkSync(f); }
    } else console.log('  (skip real import)');
  } catch (e) { fail('未預期例外', e.stack + (global.__lastServer ? '\n--- server log ---\n' + global.__lastServer.getLog().split('\n').filter(l => !l.includes('storeGuard')).slice(-30).join('\n') + '\nexit=' + global.__lastServer.proc.exitCode + ' signal=' + global.__lastServer.proc.signalCode : '')); }
  finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} }
  const sm = H.summary();
  console.log(`\nRESULT: ${sm.passCount} passed, ${sm.failCount} failed`);
  const j = process.argv.indexOf('--json'); if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(sm, null, 2));
  process.exit(sm.failCount ? 1 : 0);
})();
