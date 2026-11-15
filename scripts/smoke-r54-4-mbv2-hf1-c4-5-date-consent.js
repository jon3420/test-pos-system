#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js
// R54.4／MBV2-HF1-C4.5 —— (一) 後台補貨通知「選擇日期時立即防呆」 (二)「消費者訂閱方式」店別設定
// 正式伺服器＋暫存 SQLite＋真實 Chrome；後台與顧客操作全部走正式路由。LINE API 由程序內攔截，真實呼叫須為 0。
// 時間相關案例使用可重現的測試時鐘（C4_CLOCK_OFFSET_MS，伺服器與測試程序同一位移）。
'use strict';
const fs = require('fs');
const path = require('path');
const RealDate = Date; // 測試時鐘載入前保存真實時間來源
const TP = (h, m) => { // 讓伺服器的台北時間落在指定時刻（相對真實時間的位移）
  const now = RealDate.now(); const tp = new Date(now + 8 * 3600e3);
  const cur = tp.getUTCHours() * 3600e3 + tp.getUTCMinutes() * 60e3 + tp.getUTCSeconds() * 1e3 + tp.getUTCMilliseconds();
  return String(h * 3600e3 + m * 60e3 - cur);
};
if (process.env.C4_CLOCK_OFFSET_MS === undefined) process.env.C4_CLOCK_OFFSET_MS = TP(10, 30);
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, sleep, U, session, REAL_NOW } = C45;
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('playwright not installed'); process.exit(2); }
const only = (process.argv[2] || '').split(',').filter(Boolean);
const run = (k) => !only.length || only.includes(k);

const PID = 701, PID2 = 702;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const twToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const weekdayKey = (ymd) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(ymd + 'T00:00:00Z').getUTCDay()];

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C4.5 日期防呆＋消費者訂閱方式 驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　時鐘位移（毫秒）：' + process.env.C4_CLOCK_OFFSET_MS);
  const browser = await chromium.launch(C45.launchOpts());
  const boots = [];
  const adm = (C, m, p, b) => H.api(C.s.base, C.tok, m, p, b);
  const reg = (C, u, pid, qty, extra = {}) => C45.pub(C.s.base, 'POST', '/api/product-demand/register', { member_session: session(u), product_id: pid, desired_qty: qty, fulfillment_pref: 'any', ...extra });
  async function counters(C) {
    const r = await adm(C, 'GET', '/api/products/line-products/list');
    const ps = (r.json && r.json.data) || [];
    const b = await adm(C, 'GET', '/api/product-demand-admin/restock/batches');
    return JSON.stringify({ sold: ps.map((p) => [p.id, Number(p.line_quota_sold || 0), Number(p.line_preorder_sold || 0)]), batches: ((b.json && b.json.data) || []).length });
  }
  async function consentRows(C) {
    const s = await adm(C, 'GET', `/api/product-demand-admin/products/${PID}`);
    return JSON.stringify(((s.json && s.json.data && s.json.data.rows) || []).map((r) => [r.member, r.status, r.notify_consent]));
  }
  async function adminPage(C, opts = {}) {
    const actx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: opts.tz || 'Asia/Taipei' });
    await actx.addInitScript(([t]) => {
      if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('pos_store_token', t); localStorage.setItem('pos_store_info', JSON.stringify({ store_id: 'store_001', store_name: '測試' })); sessionStorage.setItem('__seeded', '1'); }
    }, [C.tok]);
    const ap = await actx.newPage();
    const errs = []; ap.on('pageerror', (e) => errs.push(e.message)); ap.on('dialog', (d) => d.accept());
    const reqs = { dateOpt: 0, preview: 0 };
    ap.on('request', (r) => { if (/restock\/date-options/.test(r.url())) reqs.dateOpt++; if (/restock\/preview/.test(r.url())) reqs.preview++; });
    await ap.goto(C.s.base + '/');
    await ap.waitForFunction(() => typeof window.showPage === 'function' && typeof window.lpmSwitchTab === 'function');
    await ap.evaluate(() => showPage('line_products')); await sleep(800);
    await ap.evaluate(() => lpmSwitchTab('demand'));
    await ap.waitForSelector(`#pd-row-${PID}`, { timeout: 10000 });
    return { actx, ap, errs, reqs };
  }
  const openPanel = async (ap, pid = PID) => { await ap.evaluate((id) => { openDemandDetail(id); return null; }, pid); await ap.waitForFunction(() => !/檢查可供應日期中/.test(document.getElementById('rn-date-msg')?.textContent || ''), null, { timeout: 8000 }).catch(() => {}); await sleep(300); };
  const panel = (ap) => ap.evaluate(() => ({
    date: document.getElementById('rn-date')?.value, min: document.getElementById('rn-date')?.min, max: document.getElementById('rn-date')?.max,
    mode: document.getElementById('rn-mode')?.value, btnDisabled: !!document.getElementById('rn-preview-btn')?.disabled,
    msg: document.getElementById('rn-date-msg')?.textContent || '', preview: document.getElementById('rn-preview')?.textContent || '',
    confirm: !!document.getElementById('rn-confirm-btn'), blocked: document.getElementById('rn-blocked')?.textContent || '', noRecipient: document.getElementById('rn-no-recipient')?.textContent || '',
  }));
  const setDate = async (ap, v) => { await ap.evaluate((val) => { const d = document.getElementById('rn-date'); d.value = val; d.dispatchEvent(new Event('input')); d.dispatchEvent(new Event('change')); }, v); await sleep(250); };

  try {
    // ═════════════════ D：日期防呆 ═════════════════
    if (run('d')) {
      const today = twToday();
      const closedDay = addDays(today, 2);
      const hours = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((k) => { hours[k] = { enabled: true, open: '09:00', close: '11:00' }; });
      hours[weekdayKey(closedDay)] = { enabled: false, open: '09:00', close: '11:00' };
      const C = await C45.boot('c45d', { takeoutHours: hours, settings: { line_preorder_days_limit: '5', restock_notify_enabled: '1' } }); boots.push(C);
      const c0 = await counters(C);
      // D1 API：伺服器（Asia/Taipei 10:30）判斷
      const o = await adm(C, 'GET', `/api/product-demand-admin/restock/date-options?product_id=${PID}&fulfillment_mode=takeout&date=${addDays(today, -1)}`);
      const d = o.json && o.json.data;
      const byDate = (x) => d.dates.find((r) => r.date === x) || {};
      assert(o.status === 200 && d.server_today === today && d.range.from === today && d.range.to === addDays(today, 5) && d.dates.length === 6,
        'D1-1 唯讀日期檢查：伺服器今天（台北）與可預訂範圍（今天＋5 天）', JSON.stringify({ st: o.status, today: d && d.server_today, range: d && d.range, n: d && d.dates.length }));
      assert(d.checked && d.checked.reason === 'date_in_past', 'D1-2 過去日期：date_in_past（與預覽相同規則）', JSON.stringify(d.checked));
      assert(byDate(today).ok === true && byDate(addDays(today, 1)).ok === true && byDate(closedDay).ok === false && d.first_available === today,
        'D1-3 今日截止前可供應、休息日不可供應、第一個可供應日＝今天', JSON.stringify({ t: byDate(today), cd: byDate(closedDay) }));
      const far = await adm(C, 'GET', `/api/product-demand-admin/restock/date-options?product_id=${PID}&fulfillment_mode=takeout&date=${addDays(today, 9)}`);
      assert(far.json.data.checked.reason === 'preorder_limit_exceeded', 'D1-4 超出預訂範圍：preorder_limit_exceeded', JSON.stringify(far.json.data.checked));
      const unauth = await H.api(C.s.base, null, 'GET', `/api/product-demand-admin/restock/date-options?product_id=${PID}&fulfillment_mode=takeout`);
      assert(unauth.status === 401, 'D1-5 未登入員工不可查詢（店別與員工權限保護）', String(unauth.status));
      // D2 截止時間後（伺服器 11:30）：今天不可供應，提示下一個可供應日期
      await C.restart({ C4_CLOCK_OFFSET_MS: TP(11, 30) }); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const o2 = (await adm(C, 'GET', `/api/product-demand-admin/restock/date-options?product_id=${PID}&fulfillment_mode=takeout`)).json.data;
      const t2 = o2.dates.find((r) => r.date === today) || {};
      assert(t2.ok === false && ['no_slots_today', 'cutoff_sold_out', 'sale_window_ended'].includes(t2.reason) && o2.first_available === addDays(today, 1),
        'D2 今日已過最後接單時間：今天不可供應，第一個可供應日為明天', JSON.stringify({ t2, first: o2.first_available }));
      // D3 後台畫面（瀏覽器時區設為洛杉磯，與台北日期不同的情況下仍以伺服器日期為準）
      const A = await adminPage(C, { tz: 'America/Los_Angeles' });
      await openPanel(A.ap);
      let v = await panel(A.ap);
      assert(v.date === addDays(today, 1) && v.min === today && !v.btnDisabled && /可供應/.test(v.msg),
        'D3-1 初次開啟依規則預選第一個可供應日期（以伺服器台北日期，不依瀏覽器時區）', JSON.stringify(v));
      await setDate(A.ap, addDays(today, -1)); v = await panel(A.ap);
      assert(v.btnDisabled && /此日期已過，請選擇其他供應日期/.test(v.msg) && /下一個可供應日期/.test(v.msg), 'D3-2 鍵盤輸入過去日期：立即提示原因與下一個可供應日期，停用預覽', v.msg);
      await setDate(A.ap, today); v = await panel(A.ap);
      assert(v.btnDisabled && /今日已超過接單時間|今日販售時段已結束/.test(v.msg), 'D3-3 今天（已過截止時間）：顯示「今日已超過接單時間」', v.msg);
      await setDate(A.ap, closedDay); v = await panel(A.ap);
      assert(v.btnDisabled && /店休日|未開放|不可供應/.test(v.msg), 'D3-4 休息日：提示不可供應', v.msg);
      await setDate(A.ap, addDays(today, 9)); await sleep(800); v = await panel(A.ap);
      assert(v.btnDisabled && /超出可預訂範圍/.test(v.msg), 'D3-5 超出預訂範圍（手動輸入）：提示', v.msg);
      await setDate(A.ap, ''); v = await panel(A.ap);
      assert(v.btnDisabled && /請選擇供應日期/.test(v.msg), 'D3-6 日期空白：停用預覽', v.msg);
      // 貼上
      await A.ap.evaluate((val) => { const di = document.getElementById('rn-date'); di.value = val; di.dispatchEvent(new Event('paste')); }, addDays(today, -3)); await sleep(300); v = await panel(A.ap);
      assert(v.btnDisabled && /已過/.test(v.msg), 'D3-7 貼上過去日期：同樣驗證', v.msg);
      // 「改選此日期」為明確操作
      await A.ap.click('#rn-use-next'); await sleep(300); v = await panel(A.ap);
      assert(v.date === addDays(today, 1) && !v.btnDisabled, 'D3-8 按「改選此日期」改為下一個可供應日期', JSON.stringify(v));
      // D4 預覽：日期可供應但沒有合格收件人 → 與日期錯誤分開顯示
      await A.ap.click('#rn-preview-btn'); await sleep(1200); v = await panel(A.ap);
      assert(!v.blocked && /沒有符合資格的收件人/.test(v.noRecipient) && /可供應/.test(v.msg), 'D4「日期可供應但沒有合格收件人」與日期錯誤分開顯示', JSON.stringify({ blocked: v.blocked, nr: v.noRecipient, msg: v.msg }));
      // 建立有同意的登記，以便預覽產生確認按鈕
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      for (const n of [1, 2]) { const r = await reg(C, U(n), PID, 1, { notify_consent: true }); if (!r.json || !r.json.success) console.log('reg fail', r.text); }
      // D5 預覽回應亂序：A 日期的預覽回應晚到，期間已改選 B → 舊預覽與確認按鈕不得出現
      let held = null;
      await A.ap.route('**/restock/preview**', async (route) => { if (!held) { held = route; return; } route.continue(); });
      await A.ap.click('#rn-preview-btn'); await sleep(500);
      await setDate(A.ap, addDays(today, 3)); await sleep(200);
      const resp = await held.fetch(); await held.fulfill({ response: resp }); await sleep(800);
      v = await panel(A.ap);
      assert(!v.confirm && v.preview === '' && v.date === addDays(today, 3), 'D5 改選日期後，晚到的舊預覽回應不顯示、確認按鈕不恢復', JSON.stringify(v));
      await A.ap.unroute('**/restock/preview**');
      // D6 有確認按鈕後改取餐方式 → 確認按鈕立即失效
      await A.ap.click('#rn-preview-btn'); await sleep(1200); v = await panel(A.ap);
      const hadConfirm = v.confirm;
      await A.ap.selectOption('#rn-mode', 'delivery'); await sleep(100); const v6 = await panel(A.ap);
      await sleep(1200);
      assert(hadConfirm && !v6.confirm && v6.preview === '', 'D6 改取餐方式：舊預覽與確認按鈕立即失效', JSON.stringify({ hadConfirm, v6 }));
      // D7 日期檢查回應亂序：外帶的檢查回應晚到，不覆蓋外送的結果
      let heldOpt = null;
      await A.ap.route('**/restock/date-options**', async (route) => { if (!heldOpt && /fulfillment_mode=takeout/.test(route.request().url())) { heldOpt = route; return; } route.continue(); });
      await A.ap.selectOption('#rn-mode', 'takeout'); await sleep(300);
      const vMid = await panel(A.ap);
      await A.ap.selectOption('#rn-mode', 'delivery'); await sleep(800);
      if (heldOpt) { const r2 = await heldOpt.fetch(); await heldOpt.fulfill({ response: r2 }); }
      await sleep(600); v = await panel(A.ap);
      const optNow = await A.ap.evaluate(() => _rn.opt && _rn.opt.fulfillment_mode);
      assert(vMid.btnDisabled && optNow === 'delivery' && v.mode === 'delivery', 'D7 日期檢查中停用預覽；較早（外帶）的檢查回應晚到不覆蓋外送結果', JSON.stringify({ mid: vMid.btnDisabled, optNow }));
      await A.ap.unroute('**/restock/date-options**');
      // D8 跨午夜（伺服器 23:58 開啟頁面並選「今天」→ 伺服器時鐘到隔天 00:01；畫面背景返回）：
      //    已選日期失效只提示，不在背景改掉；取餐方式保留。（員工 token 於 23:58 重新登入取得，避免時鐘跳躍使 token 過期）
      await A.actx.close();
      await C.restart({ C4_CLOCK_OFFSET_MS: TP(23, 58) }); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const A8 = await adminPage(C);
      await openPanel(A8.ap);
      await A8.ap.selectOption('#rn-mode', 'delivery'); await sleep(900); await setDate(A8.ap, today);
      const beforeMid = await panel(A8.ap);
      await C.restart({ C4_CLOCK_OFFSET_MS: TP(24, 1) });
      if (process.env.C45_DEBUG) { const sn = await adm(C, 'GET', `/api/product-demand-admin/snapshot?product_id=${PID}`); console.log('D8 snap', sn.status, sn.text.slice(0, 120)); }
      await A8.ap.evaluate(() => { _rn.optAt -= 61000; document.dispatchEvent(new Event('visibilitychange')); pdAutoRefreshNow('visible'); return null; });
      await sleep(2500); v = await panel(A8.ap);
      if (process.env.C45_DEBUG) console.log('D8 debug', await A8.ap.evaluate(() => JSON.stringify({ inflight: _rn.optInflight, at: Date.now() - _rn.optAt, today: _rn.opt && _rn.opt.server_today, auto: pdAutoState() })), A8.reqs);
      assert(beforeMid.date === today && beforeMid.min === today && /今日/.test(beforeMid.msg) && v.date === today && v.mode === 'delivery' && v.btnDisabled && /此日期已過/.test(v.msg) && v.min === addDays(today, 1),
        'D8 跨午夜後回到頁面：日期限制更新，原選日期提示已過且不被悄悄改掉，取餐方式保留', JSON.stringify({ before: beforeMid, v }));
      const nOpt8 = A8.reqs.dateOpt;
      assert(A8.errs.length === 0, 'D8-2 無 JavaScript 錯誤', A8.errs.join('|'));
      await A8.actx.close();
      // D9 日期檢查前後：沒有批次、沒有名額變化（預覽只在按下按鈕時建立）
      const nOpt = A.reqs.dateOpt + nOpt8;
      await C.restart({ C4_CLOCK_OFFSET_MS: TP(10, 30) }); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const before = await counters(C);
      for (let i = 0; i < 5; i++) await adm(C, 'GET', `/api/product-demand-admin/restock/date-options?product_id=${PID}&fulfillment_mode=${i % 2 ? 'delivery' : 'takeout'}&date=${addDays(today, i)}`);
      const after = await counters(C);
      assert(before === after && nOpt > 0 && nOpt < 25, 'D9 日期檢查不建立批次、不改名額；查詢次數受控（未逐日查詢）', JSON.stringify({ before, after, dateOptRequests: nOpt }));
      // D10 後端仍保留權威檢查：直接以過去日期呼叫預覽 → 不可發送
      const pv = await adm(C, 'POST', '/api/product-demand-admin/restock/preview', { product_id: PID, fulfillment_mode: 'takeout', supply_date: addDays(today, -1) });
      assert(pv.json.data.can_send === false && pv.json.data.blockers.includes('product_not_orderable'), 'D10 預覽 API 對過去日期仍拒絕（權威檢查保留）', JSON.stringify(pv.json.data.blockers));
      assert(A.errs.length === 0, 'D11 後台無 JavaScript 錯誤', A.errs.join(' | '));
      void c0;
    }

    // ═════════════════ S：消費者訂閱方式 ═════════════════
    if (run('s')) {
      const PRODS = [[701, '測試招牌飯', 0, 'paused'], [702, '測試對照湯', 1, 'available'], [703, '測試隱藏品', 2, 'available', { show_on_line: 0 }]];
      const C = await C45.boot('c45s', { settings: { restock_notify_enabled: '1' }, products: PRODS }); boots.push(C);
      const cfg = async () => (await C45.pub(C.s.base, 'GET', '/api/product-demand/config')).json.data;
      const mine = async (u, pid = PID) => { const r = await C45.pub(C.s.base, 'POST', '/api/product-demand/mine', { member_session: session(u) }); return ((r.json && r.json.data) || []).find((x) => x.product_id === pid) || null; };
      const consentDetail = async (u, pid = PID) => {
        const db = await C45.H.openDbFile(C.dbf).catch(() => null); void db; return null;
      };
      void consentDetail;
      const c1 = await cfg();
      assert(c1.subscribe_mode === 'opt_in' && c1.notify_available === true && c1.consent_text_version === 'restock-notify-c4-v1', 'S1 新安裝預設「消費者自行勾選」', JSON.stringify(c1));
      // S2 自行勾選：未勾 → 不同意；勾選 → 同意
      let r = await reg(C, U(1), PID, 2, {});
      assert(r.json.data.request.notify_consent === 'none', 'S2-1 自行勾選模式：未勾選送出不授權', r.json.data.request.notify_consent);
      r = await reg(C, U(2), PID, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: c1.consent_text_version });
      assert(r.json.data.consent_outcome === 'granted', 'S2-2 自行勾選模式：明確勾選後授權', r.json.data.consent_outcome);
      await reg(C, U(3), PID, 1, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: c1.consent_text_version });
      await C45.pub(C.s.base, 'POST', '/api/product-demand/consent/revoke', { member_session: session(U(3)), product_id: PID });
      // S3 店家切換為「登記即訂閱」：不修改任何既有同意紀錄
      const rowsBefore = await consentRows(C);
      const sw = await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });
      const rowsAfter = await consentRows(C);
      const c2 = await cfg();
      assert(sw.json.success && c2.subscribe_mode === 'register_subscribe' && c2.consent_text_version === 'restock-notify-c45-register-v1' && rowsBefore === rowsAfter,
        'S3 切換為登記即訂閱：設定生效、既有同意紀錄（未同意、已同意、已撤回）完全不變', JSON.stringify({ c2: c2.subscribe_mode, same: rowsBefore === rowsAfter }));
      const cap = await adm(C, 'GET', '/api/product-demand-admin/restock/capability');
      assert(cap.json.data.send_enabled === true, 'S3-2 訂閱方式與發送總開關分開保存（總開關不受影響）', JSON.stringify(cap.json.data.send_enabled));
      // S4 登記即訂閱：新登記按「登記並通知我」→ 授權（來源 register_submit）
      r = await reg(C, U(4), PID, 3, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'register_subscribe', consent_text_version: c2.consent_text_version });
      assert(r.json.data.consent_outcome === 'granted' && r.json.data.request.notify_consent === 'granted', 'S4 登記即訂閱：新登記提交即授權', JSON.stringify(r.json.data.consent_outcome));
      // S5 既有未訂閱登記：修改份數不重新授權；明確「訂閱通知」才授權
      r = await reg(C, U(1), PID, 5, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'register_subscribe', consent_text_version: c2.consent_text_version });
      assert(r.json.data.outcome === 'updated' && r.json.data.consent_outcome === 'not_applied' && r.json.data.request.notify_consent === 'none', 'S5-1 既有登記修改份數：不重新授權', JSON.stringify(r.json.data));
      // C5.2 調整：舊頁面的「訂閱通知」（register＋consent_action='subscribe'，沒有登記週期識別）一律 409 REQUEST_CHANGED、不授權；
      // 明確訂閱改由 /subscribe 帶目前登記週期識別（request_uuid）送出。
      r = await reg(C, U(1), PID, 5, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'subscribe', consent_text_version: c2.consent_text_version });
      const m1a = await mine(U(1));
      assert(r.status === 409 && r.json.code === 'REQUEST_CHANGED' && m1a.notify_consent === 'none' && m1a.desired_qty === 5, 'S5-2a〔C5.2〕舊頁面沒有登記週期識別的訂閱：409、不授權、份數不變', JSON.stringify({ st: r.status, code: r.json.code, c: m1a.notify_consent }));
      r = await C45.pub(C.s.base, 'POST', '/api/product-demand/subscribe', { member_session: session(U(1)), product_id: PID, request_uuid: m1a.request_uuid, consent_mode: 'register_subscribe', consent_text_version: c2.consent_text_version });
      const m1b = await mine(U(1));
      assert(r.json.data.consent_outcome === 'granted' && m1b.desired_qty === 5, 'S5-2 明確按「訂閱通知」（帶目前登記週期）才授權（份數不變）', JSON.stringify(r.json.data.consent_outcome + '/' + m1b.desired_qty));
      // S6 已撤回 → 重新訂閱；撤回（保留登記）仍可用
      const m3r = await mine(U(3));
      r = await C45.pub(C.s.base, 'POST', '/api/product-demand/subscribe', { member_session: session(U(3)), product_id: PID, request_uuid: m3r.request_uuid, consent_mode: 'register_subscribe', consent_text_version: c2.consent_text_version });
      const m3 = await mine(U(3));
      assert(r.json.data.consent_outcome === 'granted' && m3.notify_consent === 'granted', 'S6-1 已撤回 → 重新訂閱', JSON.stringify(m3 && m3.notify_consent));
      await C45.pub(C.s.base, 'POST', '/api/product-demand/consent/revoke', { member_session: session(U(3)), product_id: PID });
      const m3b = await mine(U(3));
      assert(m3b && m3b.notify_consent === 'revoked' && m3b.desired_qty === 1, 'S6-2「取消補貨通知，保留補貨登記」照常', JSON.stringify(m3b));
      // S7 模式不符（顧客開著舊表單）→ 409，不寫入任何資料
      const before7 = await mine(U(5));
      r = await reg(C, U(5), PID, 2, { notify_consent: true, consent_mode: 'opt_in', consent_text_version: 'restock-notify-c4-v1' });
      const after7 = await mine(U(5));
      assert(r.status === 409 && r.json.code === 'CONSENT_MODE_CHANGED' && before7 === null && after7 === null, 'S7 送出時訂閱方式已變更：拒絕且不建立登記、不授權', JSON.stringify({ st: r.status, code: r.json.code }));
      // S8 舊版前端（未帶 consent_mode）明確勾選：相容處理為勾選同意
      r = await reg(C, U(6), PID, 1, { notify_consent: true });
      assert(r.json.data.consent_outcome === 'granted', 'S8 舊版前端（未帶訂閱方式）明確勾選：相容授權', r.json.data.consent_outcome);
      // S9 發送總開關關閉：不承諾通知、登記不授權
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      const c3 = await cfg();
      r = await reg(C, U(7), PID, 1, { notify_consent: true, consent_mode: 'register_subscribe', consent_action: 'register_subscribe', consent_text_version: c2.consent_text_version });
      assert(c3.notify_available === false && c3.consent_text === '' && r.json.data.consent_outcome === 'notify_unavailable' && r.json.data.request.notify_consent === 'none',
        'S9 總開關關閉：不顯示通知承諾、不授權', JSON.stringify({ na: c3.notify_available, out: r.json.data.consent_outcome }));
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      // S10 不合法設定值 → 400；資料庫中的未知值 → 視為自行勾選
      const bad = await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'auto_everyone' });
      assert(bad.status === 400, 'S10-1 不合法的訂閱方式拒絕', String(bad.status));
      await C.s.stop();
      { const db = await H.openDbFile(C.dbf); db.run("INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','restock_notify_subscribe_mode','weird-value')"); H.saveDbFile(db, C.dbf); db.close(); }
      await C.restart(); C.tok = await H.login(C.s.base, STORE, 'pw001');
      const c4 = await cfg();
      assert(c4.subscribe_mode === 'opt_in', 'S10-2 未知設定值回到「自行勾選」', c4.subscribe_mode);
      await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });

      // S11 顧客頁面：兩種模式的畫面與行為（含店家在表單開啟期間切換）
      const sessVal = (u) => JSON.stringify({ member_session: session(u), display_name: '測試會員', is_friend: true, expires_at: REAL_NOW() + 3600e3 });
      async function openCustomer(u) {
        const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
        await context.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__s')) { localStorage.setItem(k, v); sessionStorage.setItem('__s', '1'); } }, ['line_member_session_store_001', sessVal(u)]);
        const page = await context.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
        await page.route('https://static.line-scdn.net/**', (route) => route.abort('failed'));
        await page.goto(`${C.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('.prod-card').length > 0, null, { timeout: 10000 });
        await sleep(1200);
        return { context, page, errs };
      }
      const sheet = (page) => page.evaluate(() => ({
        open: !!document.getElementById('demandOverlay')?.classList.contains('show'),
        submit: document.getElementById('dmSubmit')?.textContent || '', consentBox: !!document.getElementById('dmConsent'), checked: !!document.getElementById('dmConsent')?.checked,
        promise: document.getElementById('dmRegisterPromise')?.textContent || '', subscribeBtn: document.getElementById('dmSubscribe')?.textContent || '',
        msg: document.getElementById('dmMsg')?.textContent || '', qty: document.getElementById('dmQty')?.textContent || '', subscribed: !!document.getElementById('dmSubscribed'),
      }));
      const openSheet = async (page, pid = PID) => { await page.evaluate((id) => { openDemandSheet(id, 'card'); return null; }, pid); await sleep(900); };
      // S11-1 登記即訂閱：新登記
      { const P = await openCustomer(U(8)); await openSheet(P.page); const s = await sheet(P.page);
        assert(s.submit === '登記並通知我' && /送出即訂閱本商品補貨通知一次，可隨時取消/.test(s.promise) && !s.consentBox, 'S11-1 登記即訂閱：顯示訂閱說明，主要按鈕「登記並通知我」，無勾選框', JSON.stringify(s));
        await P.page.click('#dmPlus'); await P.page.click('#dmSubmit'); await sleep(1200);
        const m = await mine(U(8));
        assert(m && m.desired_qty === 2 && m.notify_consent === 'granted', 'S11-2 按「登記並通知我」：登記 2 份並訂閱', JSON.stringify(m));
        // 既有登記：修改份數不重新授權（先撤回再改份數）
        await C45.pub(C.s.base, 'POST', '/api/product-demand/consent/revoke', { member_session: session(U(8)), product_id: PID });
        await P.page.evaluate(() => { _pdReloadMine(); return null; }); await sleep(800);
        await openSheet(P.page); const s2 = await sheet(P.page);
        assert(s2.submit === '更新登記' && /重新訂閱補貨通知/.test(s2.subscribeBtn), 'S11-3 已撤回的既有登記：顯示「更新登記」與「重新訂閱補貨通知」', JSON.stringify(s2));
        await P.page.click('#dmPlus'); await P.page.click('#dmSubmit'); await sleep(1200);
        const m2 = await mine(U(8));
        assert(m2.desired_qty === 3 && m2.notify_consent === 'revoked', 'S11-4 修改份數不重新授權', JSON.stringify(m2));
        await openSheet(P.page); await P.page.click('#dmPlus'); // 表單內未儲存的修改（4 份）
        await P.page.click('#dmSubscribe'); await sleep(1200);
        const m3x = await mine(U(8));
        assert(m3x.notify_consent === 'granted' && m3x.desired_qty === 3, 'S11-5「重新訂閱」只授權通知，不連帶送出未儲存的份數修改', JSON.stringify(m3x));
        assert(P.errs.length === 0, 'S11-6 無 JavaScript 錯誤', P.errs.join('|'));
        await P.context.close(); }
      // S12 表單開啟期間店家切換方式：登記即訂閱 → 自行勾選
      { const P = await openCustomer(U(9)); await openSheet(P.page); await P.page.click('#dmPlus'); await P.page.click('#dmPlus');
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'opt_in' });
        await P.page.click('#dmSubmit'); await sleep(1800);
        const s = await sheet(P.page); const m = await mine(U(9));
        assert(m === null && s.open && s.consentBox && !s.checked && s.qty === '3' && /訂閱方式/.test(s.msg), 'S12-1 送出時方式已改為自行勾選：未建立登記；表單更新為勾選框（未勾）、保留 3 份與提示', JSON.stringify({ s, m }));
        await P.page.click('#dmSubmit'); await sleep(1200);
        const m2 = await mine(U(9));
        assert(m2 && m2.desired_qty === 3 && m2.notify_consent === 'none', 'S12-2 顧客未勾選再送出：只登記、不授權', JSON.stringify(m2));
        await P.context.close(); }
      // S13 自行勾選 → 登記即訂閱（顧客已勾選）
      { const P = await openCustomer(U(10)); await openSheet(P.page);
        const s0 = await sheet(P.page);
        await P.page.check('#dmConsent');
        await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });
        await P.page.click('#dmSubmit'); await sleep(1800);
        const s = await sheet(P.page); const m = await mine(U(10));
        assert(s0.consentBox && !s0.checked && m === null && s.open && s.submit === '登記並通知我' && /訂閱方式/.test(s.msg), 'S13-1 自行勾選預設不勾；送出時方式已改為登記即訂閱：未寫入，畫面改為新說明', JSON.stringify({ s0: s0.checked, s, m }));
        await P.page.click('#dmSubmit'); await sleep(1200);
        const m2 = await mine(U(10));
        assert(m2 && m2.notify_consent === 'granted', 'S13-2 顧客看到新說明後按「登記並通知我」才授權', JSON.stringify(m2));
        await P.context.close(); }
      // S14 總開關關閉：兩種模式都不顯示通知承諾
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: false });
      { const P = await openCustomer(U(11)); await openSheet(P.page); const s = await sheet(P.page);
        assert(!s.promise && !s.consentBox && s.submit === '送出補貨登記', 'S14 總開關關閉（登記即訂閱模式）：不顯示會收到通知的承諾', JSON.stringify(s));
        await P.context.close(); }
      await adm(C, 'PATCH', '/api/product-demand-admin/restock/settings', { send_enabled: true });
      // S15 後台設定：編輯版本保護（儲存中再編輯，不被儲存結果與自動更新覆蓋）
      { const A = await adminPage(C);
        await sleep(1200);
        const v0 = await A.ap.evaluate(() => document.getElementById('pd-set-subscribe-mode').value);
        await A.ap.selectOption('#pd-set-subscribe-mode', 'opt_in');
        let held = null; await A.ap.route('**/api/product-demand-admin/settings', async (route) => { if (route.request().method() === 'PATCH' && !held) { held = route; return; } route.continue(); });
        await A.ap.evaluate(() => { saveDemandSettings(); return null; }); await sleep(300);
        await A.ap.selectOption('#pd-set-subscribe-mode', 'register_subscribe');
        const resp = await held.fetch(); await held.fulfill({ response: resp }); await sleep(600);
        await A.ap.evaluate(() => { pdAutoRefreshNow('test'); return null; }); await sleep(1500);
        const ui = await A.ap.evaluate(() => document.getElementById('pd-set-subscribe-mode').value);
        const sv = (await cfg()).subscribe_mode;
        assert(v0 === 'register_subscribe' && sv === 'opt_in' && ui === 'register_subscribe', 'S15 儲存「自行勾選」期間改回「登記即訂閱」：伺服器為自行勾選，畫面保留未儲存的選擇', JSON.stringify({ v0, sv, ui }));
        assert(A.errs.length === 0, 'S15-2 後台無 JavaScript 錯誤', A.errs.join('|'));
        await A.actx.close(); }
      // S16 搬家：完整／選擇性備份包含訂閱方式；同店還原與跨店匯入保留設定，不把同意改成可發送
      await adm(C, 'PATCH', '/api/product-demand-admin/settings', { subscribe_mode: 'register_subscribe' });
      const full = await H.download(C.s.base, C.tok, '/api/migration/v2/export?mode=full');
      const fj = JSON.parse(full.buf.toString('utf8'));
      const row = (fj.data.settings || []).find((x) => x.key === 'restock_notify_subscribe_mode');
      assert(row && row.value === 'register_subscribe', 'S16-1 完整備份包含訂閱方式', JSON.stringify(row));
      const T = await C45.boot('c45s-target', { settings: { restock_notify_enabled: '1' }, products: PRODS }); boots.push(T);
      const part = await H.download(C.s.base, C.tok, '/api/migration/v2/export?categories=settings,product_demand');
      const up = await H.uploadRaw(T.s.base, T.tok, part.buf, { name: 'c45.json' });
      const res = await H.previewAndImport(T.s.base, T.tok, up.json.upload_id, { mode: 'merge', categories: ['settings', 'product_demand'] });
      const tc = (await C45.pub(T.s.base, 'GET', '/api/product-demand/config')).json.data;
      const tm = await C45.pub(T.s.base, 'POST', '/api/product-demand/mine', { member_session: session(U(2)) });
      const t2 = ((tm.json && tm.json.data) || []).find((x) => x.product_id === PID);
      assert(res.import && res.import.status === 'done' && tc.subscribe_mode === 'register_subscribe' && t2 && t2.notify_consent === 'reconfirm_required',
        'S16-2 匯入：訂閱方式保留；匯入的同意仍需顧客重新確認（不自動變成同意）', JSON.stringify({ st: res.import && res.import.status, mode: tc.subscribe_mode, consent: t2 && t2.notify_consent }));
      const realN = C.mf.real() + T.mf.real();
      assert(realN === 0 && C.mf.calls().length === 0, 'S17 全程 LINE 呼叫 0 次（登記、訂閱、切換方式都不發送）', JSON.stringify({ real: realN, mock: C.mf.calls().length }));
    }
  } catch (e) {
    console.error(e); H.fail('測試例外', e.stack || e.message);
  } finally {
    for (const b of boots) { try { if (b.s.proc.exitCode == null && b.s.proc.signalCode == null) await b.s.stop(); } catch {} }
    await browser.close();
  }
  const s = H.summary();
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
void path; void fs;
