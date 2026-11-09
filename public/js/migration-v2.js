// public/js/migration-v2.js — R54.4 資料備份／搬家 V2（系統設定 → 資料備份／搬家）
// 依賴 app.js 的全域：apiFetch、getToken、showToast、showModal18、hideModal18。
(function () {
  'use strict';

  const API = '/api/migration/v2';
  const S = {
    config: null, preview: null, inited: false,
    exportChecked: new Set(), filters: {},
    upload: null, importChecked: new Set(), previewResult: null, previewKey: null, busy: false,
  };
  const DATE_CATS = ['orders', 'line_preorders', 'analytics'];

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));
  function fmtBytes(b) {
    if (b == null) return '尚未估算';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function toast(m, t) { if (typeof showToast === 'function') showToast(m, t || 'info'); }
  async function readJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { success: false, code: 'NON_JSON', message: `伺服器未回傳有效 JSON（HTTP ${res.status}）` }; }
  }
  function setStatus(el, cls, html) { if (!el) return; el.className = 'mbv2-status ' + (cls || ''); el.innerHTML = html || ''; }
  const catLabel = (k) => { const c = S.config && S.config.categories.find((x) => x.key === k); return c ? c.label : k; };

  // ══════════════════════════════════════════════════════════════════════
  async function mbv2Init() {
    try {
      if (!S.config) {
        const r = await apiFetch(API + '/config');
        const j = await readJson(r);
        if (!j.success) throw new Error(j.message || '無法讀取設定');
        S.config = j;
      }
      const lim = $('mbv2LimitText');
      if (lim) lim.textContent = `目前上限 ${S.config.upload_limit_mb}MB（壓縮檔解壓後也不得超過）。`;
      if (!S.inited) { S.exportChecked = new Set(S.config.categories.map((c) => c.key)); S.inited = true; }
      loadStorage();
      await refreshExportPreview();
    } catch (e) {
      const el = $('mbv2ExportList'); if (el) el.innerHTML = `<div class="mbv2-err">❌ ${esc(e.message)}</div>`;
    }
  }

  async function loadStorage() {
    try {
      const j = await readJson(await apiFetch(API + '/storage-status'));
      const box = $('mbv2Storage');
      if (!box || !j.success || !j.storage || !j.storage.available) return;
      const st = j.storage;
      if (!st.warnings.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.innerHTML = `<strong>⚠️ 資料庫持久化提醒</strong><ul>${st.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
        <div class="mbv2-muted">資料庫檔：${esc(st.file_name)}（${fmtBytes(st.current_size_bytes)}，設定來源：${esc(st.configured_by)}）。重新部署前請先下載完整備份。</div>`;
    } catch { /* 狀態僅供提醒 */ }
  }

  // ── 匯出 ────────────────────────────────────────────────────────────
  function exportMode() { const r = document.querySelector('input[name="mbv2ExportMode"]:checked'); return r ? r.value : 'full'; }
  function filtersPayload() {
    const out = {};
    for (const k of DATE_CATS) {
      const f = S.filters[k];
      if (!f || f.preset === 'all') continue;
      if (f.preset === 'month') { if (!f.month) continue; out[k] = { preset: 'month', month: f.month }; }
      else if (f.preset === 'custom') { if (!f.start || !f.end) continue; out[k] = { preset: 'custom', start: f.start, end: f.end }; }
      else out[k] = { preset: f.preset };
    }
    return out;
  }
  let _pvGen = 0;
  async function refreshExportPreview() {
    const gen = ++_pvGen;
    const list = $('mbv2ExportList');
    try {
      const f = exportMode() === 'selective' ? filtersPayload() : {};
      const j = await readJson(await apiFetch(API + '/export/preview?filters=' + encodeURIComponent(JSON.stringify(f))));
      if (gen !== _pvGen) return;
      if (!j.success) throw new Error(j.message || '預覽失敗');
      S.preview = j;
      renderExportList();
    } catch (e) {
      if (gen !== _pvGen) return;
      if (list) list.innerHTML = `<div class="mbv2-err">❌ ${esc(e.message)}</div>`;
    }
  }
  function dateFilterHtml(key) {
    const f = S.filters[key] || { preset: 'all' };
    const presets = S.config.date_presets;
    return `<div class="mbv2-date" data-key="${key}">
      <select onchange="mbv2SetFilter('${key}','preset',this.value)" aria-label="日期範圍">
        ${presets.map((p) => `<option value="${p.key}" ${f.preset === p.key ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select>
      ${f.preset === 'month' ? `<input type="month" value="${esc(f.month || '')}" onchange="mbv2SetFilter('${key}','month',this.value)">` : ''}
      ${f.preset === 'custom' ? `<input type="date" value="${esc(f.start || '')}" onchange="mbv2SetFilter('${key}','start',this.value)"> ～ <input type="date" value="${esc(f.end || '')}" onchange="mbv2SetFilter('${key}','end',this.value)">` : ''}
      <span class="mbv2-muted">（台北時間，含首尾日；訂單以建立時間判定）</span>
    </div>`;
  }
  function renderExportList() {
    const list = $('mbv2ExportList');
    const mode = exportMode();
    const tb = $('mbv2ExportToolbar'); if (tb) tb.style.display = mode === 'selective' ? '' : 'none';
    const cats = S.preview.categories;
    list.innerHTML = cats.map((c) => {
      const checked = mode === 'full' || S.exportChecked.has(c.key);
      const badges = [];
      if (c.includes_images) badges.push(c.includes_images.inline_images ? `含 ${c.includes_images.inline_images} 筆內嵌圖片` : (c.includes_images.has_image_urls ? '含圖片網址（圖片檔本身不在備份內）' : '無圖片'));
      if (c.includes_history) badges.push('含歷史紀錄');
      if (c.sensitive) badges.push('含設定值（如 LINE 金鑰），請妥善保管');
      const missingRec = checked && mode === 'selective' ? (c.recommends || []).filter((r) => !S.exportChecked.has(r)) : [];
      return `<div class="mbv2-item ${checked ? 'on' : ''}">
        <label class="mbv2-item-head">
          <input type="checkbox" ${checked ? 'checked' : ''} ${mode === 'full' ? 'disabled' : ''} onchange="mbv2ToggleExport('${c.key}', this.checked)">
          <span class="mbv2-item-title">${esc(c.label)}</span>
          <span class="mbv2-item-meta">${fmtN(c.rows)} 筆 · ${fmtBytes(c.estimated_bytes)}${c.estimated_bytes ? '（抽樣估算）' : ''}</span>
        </label>
        <div class="mbv2-item-desc">${esc(c.desc)}</div>
        ${badges.length ? `<div class="mbv2-badges">${badges.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
        ${missingRec.length ? `<div class="mbv2-warn-sm">建議一起匯出：${missingRec.map(catLabel).map(esc).join('、')}（匯入新環境時才能對應關聯資料；未一併匯出時，備份檔仍附上名稱對照，可對應到目標環境既有資料）</div>` : ''}
        ${mode === 'selective' && checked && c.date_filter_supported ? dateFilterHtml(c.key) : ''}
      </div>`;
    }).join('');
    renderExportSummary();
  }
  function renderExportSummary() {
    const el = $('mbv2ExportSummary');
    const mode = exportMode();
    const cats = S.preview.categories.filter((c) => mode === 'full' || S.exportChecked.has(c.key));
    const btn = $('mbv2ExportBtn');
    if (!cats.length) { el.innerHTML = '<span class="mbv2-err">請至少選擇一個資料分類</span>'; if (btn) btn.disabled = true; return; }
    if (btn) btn.disabled = false;
    const rows = cats.reduce((a, c) => a + (c.rows || 0), 0);
    const unknown = cats.some((c) => c.estimated_bytes == null);
    const bytes = cats.reduce((a, c) => a + (c.estimated_bytes || 0), 0);
    const limit = S.config.upload_limit_mb * 1024 * 1024;
    el.innerHTML = `${mode === 'full' ? '完整備份' : `已選 ${cats.length} 類`}：共 ${fmtN(rows)} 筆，預估 ${unknown ? '尚未估算' : fmtBytes(bytes)}
      ${!unknown && bytes > limit ? `<div class="mbv2-warn-sm">預估超過匯入上限 ${S.config.upload_limit_mb}MB，建議勾選「壓縮下載」或依分類／日期分批。</div>` : ''}`;
  }
  function mbv2OnExportModeChange() { refreshExportPreview(); }
  function mbv2ToggleExport(key, on) { if (on) S.exportChecked.add(key); else S.exportChecked.delete(key); renderExportList(); }
  function mbv2ExportSelectAll(on) { S.exportChecked = on ? new Set(S.config.categories.map((c) => c.key)) : new Set(); renderExportList(); }
  function mbv2SetFilter(key, field, value) {
    const f = S.filters[key] || (S.filters[key] = { preset: 'all' });
    f[field] = value;
    if (field === 'preset') { if (value === 'month' && !f.month) f.month = new Date().toISOString().slice(0, 7); }
    if (f.preset === 'custom' && f.start && f.end && f.start > f.end) { toast('開始日期不可晚於結束日期', 'error'); renderExportList(); return; }
    refreshExportPreview();
  }

  async function mbv2DoExport() {
    if (S.busy) return;
    const status = $('mbv2ExportStatus');
    const mode = exportMode();
    const qs = new URLSearchParams();
    if (mode === 'full') qs.set('mode', 'full');
    else {
      if (!S.exportChecked.size) { setStatus(status, 'err', '❌ 請至少選擇一個資料分類'); return; }
      qs.set('categories', [...S.exportChecked].join(','));
      qs.set('filters', JSON.stringify(filtersPayload()));
    }
    if ($('mbv2ExportGzip') && $('mbv2ExportGzip').checked) qs.set('gzip', '1');
    S.busy = true; const btn = $('mbv2ExportBtn'); if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
    setStatus(status, '', '準備匯出中，資料量大時需要一些時間…');
    try {
      const res = await apiFetch(API + '/export?' + qs.toString());
      if (!res.ok) { const j = await readJson(res); throw new Error(j.message || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const name = m ? m[1] : 'pos_backup.json';
      const a = document.createElement('a'); const url = URL.createObjectURL(blob);
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
      setStatus(status, 'ok', `✅ 已下載：${esc(name)}（${fmtBytes(blob.size)}，${res.headers.get('x-backup-type') === 'full' ? '完整備份' : '部分備份'}）`);
      toast('搬家檔匯出成功', 'success');
    } catch (e) {
      setStatus(status, 'err', `❌ 匯出失敗：${esc(e.message)}`); toast('匯出失敗：' + e.message, 'error');
    } finally { S.busy = false; if (btn) { btn.disabled = false; btn.textContent = '⬇️ 下載搬家檔'; } }
  }

  // ── 匯入：選檔／上傳 ─────────────────────────────────────────────────
  function resetImport() {
    S.upload = null; S.previewResult = null; S.previewKey = null; S.importChecked = new Set();
    ['mbv2BackupInfo', 'mbv2ImportOptions', 'mbv2PreviewBox'].forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
    const ib = $('mbv2ImportBtn'); if (ib) { ib.style.display = 'none'; ib.disabled = true; }
    setStatus($('mbv2ImportStatus'), '', '');
  }
  async function maybeCompress(file) {
    // 大型 .json 先在瀏覽器以 gzip 壓縮再上傳（大幅縮短上傳時間、降低代理伺服器限制的風險）
    if (!/\.json$/i.test(file.name) || file.size < 8 * 1024 * 1024 || typeof CompressionStream !== 'function') return file;
    try {
      const stream = file.stream().pipeThrough(new CompressionStream('gzip'));
      const blob = await new Response(stream).blob();
      return blob.size < file.size ? blob : file;
    } catch { return file; }
  }
  function xhrUpload(body, fileName, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/upload');
      const tk = typeof getToken === 'function' ? getToken() : null;
      if (tk) xhr.setRequestHeader('Authorization', 'Bearer ' + tk);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(fileName));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onload = () => { let j; try { j = JSON.parse(xhr.responseText); } catch { j = { success: false, message: `伺服器未回傳有效 JSON（HTTP ${xhr.status}）` }; } resolve({ status: xhr.status, json: j }); };
      xhr.onerror = () => reject(new Error('上傳失敗（網路中斷或連線被關閉）'));
      xhr.ontimeout = () => reject(new Error('上傳逾時'));
      xhr.send(body);
    });
  }
  async function mbv2OnFileSelected(input) {
    resetImport();
    const file = input.files && input.files[0];
    if (!file) return;
    if (!S.config) await mbv2Init();
    const status = $('mbv2ImportStatus');
    const limit = S.config.upload_limit_mb * 1024 * 1024;
    if (!/\.(json|json\.gz|gz)$/i.test(file.name)) { setStatus(status, 'err', '❌ 僅接受 .json 或 .json.gz 備份檔'); return; }
    if (file.size > limit) { setStatus(status, 'err', `❌ 檔案 ${fmtBytes(file.size)} 超過上限 ${S.config.upload_limit_mb}MB。請改用「選擇性匯出」依分類或日期分批，或使用壓縮檔。`); return; }
    const prog = $('mbv2UploadProgress'), bar = $('mbv2UploadBar'), txt = $('mbv2UploadText');
    prog.style.display = 'flex'; bar.style.width = '0%'; txt.textContent = '準備中…';
    try {
      const body = await maybeCompress(file);
      if (body !== file) txt.textContent = `已壓縮 ${fmtBytes(file.size)} → ${fmtBytes(body.size)}，上傳中…`;
      const r = await xhrUpload(body, file.name, (l, t) => { bar.style.width = Math.round(l / t * 100) + '%'; txt.textContent = `上傳中 ${fmtBytes(l)} / ${fmtBytes(t)}`; });
      if (r.status === 401) { if (typeof showLoginOverlay === 'function') showLoginOverlay(); throw new Error('登入已逾時，請重新登入'); }
      if (!r.json.success) throw new Error(r.json.message || `HTTP ${r.status}`);
      txt.textContent = '上傳完成，已驗證檔案格式';
      bar.style.width = '100%';
      S.upload = r.json;
      S.importChecked = new Set(r.json.backup.categories_present);
      renderBackupInfo();
      renderImportOptions();
    } catch (e) {
      setStatus(status, 'err', `❌ ${esc(e.message)}`); prog.style.display = 'none';
    }
  }
  function renderBackupInfo() {
    const u = S.upload, b = u.backup;
    const box = $('mbv2BackupInfo');
    const rows = [
      ['備份來源', `${esc(b.source_store_id || '（未標示，視為同店）')}${b.store_name ? '（' + esc(b.store_name) + '）' : ''}`],
      ['匯出時間', esc(b.exported_at || '—')],
      ['備份版本', b.kind === 'legacy' ? `舊版完整備份（${esc(b.app_version || '—')}）` : `schema_version ${esc(b.schema_version)}（${esc(b.app_version || '')}）`],
      ['備份類型', b.backup_type === 'full' ? '完整備份' : '部分備份（不可完整取代）'],
      ['檔案', `${fmtBytes(u.file.bytes)}${u.file.gzip ? `（gzip，解壓後 ${fmtBytes(u.file.decompressed_bytes)}）` : ''}`],
    ];
    if (b.order_date_range) rows.push(['訂單日期', `${esc(b.order_date_range.min)} ～ ${esc(b.order_date_range.max)}`]);
    const f = b.filters || {};
    const fl = Object.entries(f).map(([k, v]) => `${esc(catLabel(k))}：${esc(v.start)}～${esc(v.end)}`);
    if (fl.length) rows.push(['日期篩選', fl.join('；')]);
    box.innerHTML = `<div class="mbv2-box-title">📋 備份資訊</div>
      <table class="mbv2-kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      ${(b.warnings || []).map((w) => `<div class="mbv2-warn-sm">⚠️ ${esc(w.message)}</div>`).join('')}`;
    box.style.display = 'block';
  }
  function renderImportOptions() {
    const u = S.upload;
    const opt = $('mbv2ImportOptions'); opt.style.display = 'block';
    const mode = importMode();
    const isReplace = mode === 'replace';
    const tc = u.backup.table_counts || {};
    $('mbv2ImportCats').innerHTML = u.categories.map((c) => {
      const inFile = c.tables.filter((t) => tc[t] != null).map((t) => `${t} ${fmtN(tc[t])}`).join('、');
      const cur = c.tables.map((t) => u.current_counts[t] || 0).reduce((a, x) => a + x, 0);
      const on = S.importChecked.has(c.key);
      return `<div class="mbv2-item ${on ? 'on' : ''}"><label class="mbv2-item-head">
        <input type="checkbox" ${on ? 'checked' : ''} ${isReplace ? 'disabled' : ''} onchange="mbv2ToggleImport('${c.key}', this.checked)">
        <span class="mbv2-item-title">${esc(c.label)}</span>
        <span class="mbv2-item-meta">目前本店 ${fmtN(cur)} 筆</span></label>
        <div class="mbv2-item-desc">備份內：${esc(inFile || '—')}</div></div>`;
    }).join('');
    const rl = $('mbv2ReplaceLabel');
    const replaceOk = u.backup.backup_type === 'full' && !u.cross_store;
    if (rl) { rl.classList.toggle('mbv2-disabled', !replaceOk); const inp = rl.querySelector('input'); inp.disabled = !replaceOk; if (!replaceOk && inp.checked) { document.querySelector('input[name="mbv2ImportMode"][value="skip"]').checked = true; } }
    ['mbv2ImpAllBtn', 'mbv2ImpNoneBtn'].forEach((id) => { const b = $(id); if (b) b.disabled = isReplace; });
    const cb = $('mbv2CrossBox');
    if (u.cross_store) {
      cb.innerHTML = `<div class="mbv2-cross">⚠️ 備份檔屬於店家 <strong>${esc(u.backup.source_store_id)}</strong>，目前店家是 <strong>${esc(u.current_store_id)}</strong>。
        <label><input type="checkbox" id="mbv2CrossCheck" onchange="mbv2OnImportOptionChange()"> 我確認要把這份備份匯入目前店家（不會影響其他店家；完整取代不可跨店）</label></div>`;
    } else cb.innerHTML = '';
    invalidatePreview();
  }
  function importMode() { const r = document.querySelector('input[name="mbv2ImportMode"]:checked'); return r ? r.value : 'skip'; }
  function importOptions() {
    return { upload_id: S.upload && S.upload.upload_id, mode: importMode(), categories: [...S.importChecked],
      allow_cross_store: !!($('mbv2CrossCheck') && $('mbv2CrossCheck').checked) };
  }
  function optionsKey() { const o = importOptions(); return JSON.stringify([o.upload_id, o.mode, o.categories.sort(), o.allow_cross_store]); }
  function invalidatePreview() {
    S.previewResult = null; S.previewKey = null;
    const pb = $('mbv2PreviewBox'); if (pb) pb.style.display = 'none';
    const ib = $('mbv2ImportBtn'); if (ib) { ib.style.display = 'none'; ib.disabled = true; }
  }
  function mbv2ToggleImport(key, on) { if (on) S.importChecked.add(key); else S.importChecked.delete(key); renderImportOptions(); }
  function mbv2ImportSelectAll(on) { S.importChecked = on ? new Set(S.upload.backup.categories_present) : new Set(); renderImportOptions(); }
  function mbv2OnImportOptionChange() {
    if (!S.upload) return;
    if (importMode() === 'replace') S.importChecked = new Set(S.upload.backup.categories_present);
    const cross = $('mbv2CrossCheck') ? $('mbv2CrossCheck').checked : false;
    renderImportOptions();
    if ($('mbv2CrossCheck')) $('mbv2CrossCheck').checked = cross;
  }

  // ── 工作輪詢（大型匯入期間伺服器忙碌，網路錯誤自動重試）──────────────
  async function pollJob(jobId, onTick) {
    const t0 = Date.now(); let errors = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      let j;
      try { j = await readJson(await apiFetch(`${API}/jobs/${jobId}`)); errors = 0; }
      catch { if (++errors > 60) throw new Error('無法取得進度（網路中斷），請稍後重新整理頁面確認匯入紀錄'); continue; }
      if (!j.success) throw new Error(j.message || '工作不存在');
      if (onTick) onTick(Math.round((Date.now() - t0) / 1000), j.job.status);
      if (j.job.status === 'done') return j.job.result;
      if (j.job.status === 'error') { const e = new Error(j.job.error.message); e.code = j.job.error.code; e.detail = j.job.error; throw e; }
    }
  }

  // ── 預覽 ────────────────────────────────────────────────────────────
  const COLS = [['source', '備份筆數'], ['existing_before', '現有筆數'], ['added', '預計新增'], ['updated', '預計更新'], ['skipped', '預計跳過'],
    ['conflict', '衝突'], ['missing_relation', '缺少關聯'], ['invalid', '格式無效'], ['failed', '寫入失敗']];
  function resultTable(r, isPreview) {
    const tables = r.tables.filter((t) => t.source || t.purged || t.existing_before);
    const head = COLS.map(([, l]) => `<th>${isPreview ? l : l.replace('預計', '')}</th>`).join('');
    const body = tables.map((t) => `<tr><td>${esc(catLabel(t.category) || '')}<div class="mbv2-muted">${esc(t.table)}</div></td>${COLS.map(([k]) => {
      const v = k === 'skipped' ? t.skipped + (t.duplicate_in_file || 0) : t[k];
      const cls = (k === 'conflict' || k === 'missing_relation' || k === 'invalid') && v ? 'warn' : (k === 'failed' && v ? 'bad' : (k === 'added' && v ? 'good' : ''));
      return `<td class="num ${cls}">${fmtN(v)}</td>`;
    }).join('')}</tr>`).join('');
    const samples = [];
    for (const t of r.tables) {
      for (const [k, label] of [['conflict', '衝突'], ['missing_relation', '缺少關聯'], ['invalid', '格式無效'], ['failed', '寫入失敗']]) {
        for (const smp of (t.samples && t.samples[k]) || []) {
          samples.push(`<li><strong>${label}</strong> ${esc(t.table)}${smp.key ? '［' + esc(String(smp.key).replace(/\u0001/g, ' | ')) + '］' : ''}：${esc(smp.reason || smp.error || (smp.fields ? '欄位不同：' + smp.fields.join(', ') : ''))}</li>`);
        }
      }
      if (t.protected) samples.push(`<li><strong>受保護</strong> ${esc(t.table)}：${t.protected} 筆受保護設定（店家登入密碼）不會匯入</li>`);
      if (t.relation_cleared) samples.push(`<li><strong>關聯清空</strong> ${esc(t.table)}：${t.relation_cleared} 筆找不到對應商品／會員，關聯欄位設為空白，紀錄本身保留</li>`);
      if (t.id_remapped) samples.push(`<li><strong>重新配發 ID</strong> ${esc(t.table)}：${t.id_remapped} 筆原始 ID／公開代碼已被占用，已改配新值並同步更新關聯</li>`);
    }
    return `<div class="mbv2-tablewrap"><table class="mbv2-table"><thead><tr><th>分類／資料表</th>${head}</tr></thead><tbody>${body || `<tr><td colspan="${COLS.length + 1}">沒有資料</td></tr>`}</tbody></table></div>
      ${samples.length ? `<details class="mbv2-details" ${samples.length < 8 ? 'open' : ''}><summary>明細（每類最多 5 筆範例）</summary><ul>${samples.slice(0, 80).join('')}</ul></details>` : ''}`;
  }
  async function mbv2DoPreview() {
    if (!S.upload || S.busy) return;
    const o = importOptions();
    const status = $('mbv2ImportStatus');
    if (!o.categories.length) { setStatus(status, 'err', '❌ 請至少選擇一個要匯入的分類'); return; }
    if (S.upload.cross_store && !o.allow_cross_store) { setStatus(status, 'err', '❌ 跨店匯入請先勾選確認'); return; }
    S.busy = true; const btn = $('mbv2PreviewBtn'); btn.disabled = true;
    const box = $('mbv2PreviewBox'); box.style.display = 'block'; box.innerHTML = '<div class="mbv2-muted">預覽計算中（在交易內試算後回滾，不會修改資料）…</div>';
    setStatus(status, '', '');
    try {
      const j = await readJson(await apiFetch(API + '/preview', { method: 'POST', body: JSON.stringify(o) }));
      if (!j.success) throw new Error(j.message);
      const r = await pollJob(j.job_id, (sec) => { box.innerHTML = `<div class="mbv2-muted">預覽計算中…已 ${sec} 秒</div>`; });
      S.previewResult = r; S.previewKey = optionsKey();
      const t = r.totals;
      const purge = (r.purge_preview || []).filter((p) => p.rows_to_delete);
      box.innerHTML = `<div class="mbv2-box-title">🔍 預覽結果（唯讀，資料庫未變更）</div>
        <div class="mbv2-totals"><span class="good">新增 ${fmtN(t.added)}</span><span>更新 ${fmtN(t.updated)}</span><span>跳過 ${fmtN(t.skipped + t.duplicate_in_file)}</span>
          <span class="${t.conflict ? 'warn' : ''}">衝突 ${fmtN(t.conflict)}</span><span class="${t.missing_relation ? 'warn' : ''}">缺少關聯 ${fmtN(t.missing_relation)}</span>
          <span class="${t.failed ? 'bad' : ''}">寫入失敗 ${fmtN(t.failed)}</span></div>
        ${o.mode === 'replace' ? `<div class="mbv2-impact"><strong>完整取代將先刪除本店下列資料：</strong><ul>${purge.map((p) => `<li>${esc(p.table)}：${fmtN(p.rows_to_delete)} 筆</li>`).join('') || '<li>無</li>'}</ul>店家登入密碼不會被刪除；其他店家不受影響。</div>` : ''}
        ${t.failed ? '<div class="mbv2-err">有資料無法寫入，正式匯入會整批回滾。請先處理後再匯入。</div>' : ''}
        ${resultTable(r, true)}`;
      const ib = $('mbv2ImportBtn'); ib.style.display = ''; ib.disabled = t.failed > 0 || (t.added + t.updated === 0 && o.mode !== 'replace');
      if (ib.disabled && !t.failed) ib.title = '沒有需要新增或更新的資料';
    } catch (e) {
      box.innerHTML = `<div class="mbv2-err">❌ 預覽失敗：${esc(e.message)}</div>`;
    } finally { S.busy = false; btn.disabled = false; }
  }

  // ── 匯入 ────────────────────────────────────────────────────────────
  function mbv2ConfirmImport() {
    if (!S.previewResult || S.previewKey !== optionsKey()) { toast('選項已變更，請重新預覽', 'error'); invalidatePreview(); return; }
    const o = importOptions(); const t = S.previewResult.totals;
    if (o.mode === 'replace') {
      $('mbv2ReplaceStoreId').textContent = S.upload.current_store_id;
      $('mbv2ReplaceConfirmText').value = ''; $('mbv2ReplacePassword').value = '';
      const purge = (S.previewResult.purge_preview || []).filter((p) => p.rows_to_delete);
      $('mbv2ReplaceImpact').innerHTML = `將刪除本店 ${fmtN(purge.reduce((a, p) => a + p.rows_to_delete, 0))} 筆資料（${purge.length} 張表），再從備份新增 ${fmtN(t.added)} 筆。<br>
        執行前會自動建立整份資料庫的安全快照並驗證；任一步驟失敗都會整批回滾。`;
      showModal18('mbv2ReplaceModal');
      return;
    }
    const msg = `確認匯入？\n\n分類：${o.categories.map(catLabel).join('、')}\n模式：${o.mode === 'merge' ? '安全合併' : '跳過已存在'}\n預計新增 ${t.added} 筆、更新 ${t.updated} 筆、跳過 ${t.skipped + t.duplicate_in_file} 筆` +
      (t.conflict ? `\n衝突 ${t.conflict} 筆（不會覆蓋現有資料）` : '') + (t.missing_relation ? `\n缺少關聯 ${t.missing_relation} 筆（不會匯入）` : '');
    if (!window.confirm(msg)) return;
    mbv2ExecuteImport(false);
  }
  function mbv2CloseReplaceModal() { hideModal18('mbv2ReplaceModal'); }
  async function mbv2ExecuteImport(isReplace) {
    if (S.busy) return;
    const o = importOptions();
    const body = { ...o, preview_token: S.previewResult.preview_token };
    if (isReplace) {
      body.confirm_text = $('mbv2ReplaceConfirmText').value.trim();
      body.password = $('mbv2ReplacePassword').value;
      if (body.confirm_text !== S.upload.current_store_id) { toast(`請輸入店家代碼「${S.upload.current_store_id}」`, 'error'); return; }
      if (!body.password) { toast('請輸入店家登入密碼', 'error'); return; }
      mbv2CloseReplaceModal();
    }
    S.busy = true;
    const ib = $('mbv2ImportBtn'); ib.disabled = true; ib.textContent = '匯入中…';
    const pv = $('mbv2PreviewBtn'); pv.disabled = true;
    const status = $('mbv2ImportStatus');
    setStatus(status, '', '匯入中，請勿關閉頁面…（大型檔案匯入期間其他畫面可能暫時沒有回應）');
    try {
      const j = await readJson(await apiFetch(API + '/import', { method: 'POST', body: JSON.stringify(body) }));
      if (!j.success) throw Object.assign(new Error(j.message), { code: j.code });
      const r = await pollJob(j.job_id, (sec) => setStatus(status, '', `匯入中…已 ${sec} 秒，請勿關閉頁面`));
      const t = r.totals;
      const cls = r.status === 'success' ? 'ok' : 'warnbox';
      const head = r.status === 'success' ? '✅ 匯入完成' : '⚠️ 匯入完成，但有項目未匯入（衝突／缺少關聯／格式無效，詳見下表）';
      setStatus(status, cls, `<div><strong>${head}</strong></div>
        <div class="mbv2-totals"><span class="good">新增 ${fmtN(t.added)}</span><span>更新 ${fmtN(t.updated)}</span><span>跳過 ${fmtN(t.skipped + t.duplicate_in_file)}</span>
        <span class="${t.conflict ? 'warn' : ''}">衝突 ${fmtN(t.conflict)}</span><span class="${t.missing_relation ? 'warn' : ''}">缺少關聯 ${fmtN(t.missing_relation)}</span>${t.purged ? `<span>已清除 ${fmtN(t.purged)}</span>` : ''}</div>
        <div class="mbv2-muted">筆數核對：${r.verify_ok ? '✅ 每張表「匯入後筆數＝基準＋新增」一致' : '❌ 不一致'}${r.safety_snapshot ? `；取代前安全快照：${esc(r.safety_snapshot.file_name)}（已驗證）` : ''}</div>
        ${resultTable(r, false)}`);
      toast(r.status === 'success' ? '匯入完成' : '匯入完成（有警告）', r.status === 'success' ? 'success' : 'warning');
      invalidatePreview();
      refreshExportPreview();
    } catch (e) {
      setStatus(status, 'err', `❌ 匯入失敗：${esc(e.message)}<div class="mbv2-muted">${e.code === 'IMPORT_ROW_FAILED' || e.code === 'IMPORT_VERIFY_FAILED' ? '已整批回滾，資料庫未變更。' : ''}</div>`);
      toast('匯入失敗：' + e.message, 'error');
    } finally {
      S.busy = false; ib.textContent = '✅ 確認匯入'; pv.disabled = false;
    }
  }

  Object.assign(window, { mbv2Init, mbv2OnExportModeChange, mbv2ToggleExport, mbv2ExportSelectAll, mbv2SetFilter, mbv2DoExport,
    mbv2OnFileSelected, mbv2ToggleImport, mbv2ImportSelectAll, mbv2OnImportOptionChange, mbv2DoPreview, mbv2ConfirmImport,
    mbv2CloseReplaceModal, mbv2ExecuteImport, __mbv2State: S });
})();
