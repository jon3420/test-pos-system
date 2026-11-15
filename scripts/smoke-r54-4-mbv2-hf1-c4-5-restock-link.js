#!/usr/bin/env node
// scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js
// R54.4／MBV2-HF1-C4.5 —— 補貨通知連結載入：LIFF 一次導向／二次導向（模擬）、直接開啟、慢 SDK、SDK 失敗、
// 登入 Gate、重複初始化、商品只開一次、商品不存在、一般首屏、既有購物車、Recovery 優先、診斷資料不含敏感值。
// 正式伺服器（server.js）＋暫存 SQLite＋真實 Chrome（Playwright）。LIFF SDK 以替身模擬 LINE 官方流程
// （liff.state → liff.init() → location.replace(二次導向網址)）；這是「模擬驗證」，不是 LINE App 真機。
// 同一支測試先在未修改的 C4.4 執行（重現），再於 C4.5 執行。
'use strict';
const fs = require('fs');
(() => {
  if (process.env.C4_CLOCK_OFFSET_MS !== undefined) return;
  const tp = new Date(Date.now() + 8 * 3600e3);
  const mins = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  process.env.C4_CLOCK_OFFSET_MS = String(mins < 8 * 60 || mins >= 20 * 60 ? (10 * 60 + 30 - mins) * 60e3 : 0);
})();
require('./lib/c4-test-clock');
const C45 = require('./lib/c45-common');
const { H, STORE, puuid, sleep, twDate, FAKE_LIFF_SDK } = C45;
const { assert } = H;
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('playwright not installed'); process.exit(2); }

const PID = 701, PID_HIDDEN = 703, PID2 = 702;
const SKEY = 'line_member_session_' + STORE;
const CART_KEY = 'line_order_cart_' + STORE;

(async () => {
  console.log('══════════ R54.4／MBV2-HF1-C4.5 補貨通知連結載入（LIFF 一次／二次導向模擬）驗收 ══════════');
  console.log('受測程式：' + H.ROOT + '　時鐘位移（毫秒）：' + process.env.C4_CLOCK_OFFSET_MS);
  const browser = await chromium.launch(C45.launchOpts());
  const boots = [];
  try {
    // A：結帳前會員模式（頁面載入即初始化 LIFF，不強制登入）
    const A = await C45.boot('c45la', { settings: { line_member_gate_enabled: '1', line_member_gate_mode: 'checkout' } }); boots.push(A);
    // B：未啟用會員 Gate、未啟用背景辨識（頁面不會自行初始化 LIFF）
    const B = await C45.boot('c45lb', { settings: { line_member_gate_enabled: '0', line_member_gate_mode: 'disabled' } }); boots.push(B);
    // E：進站登入 Gate（可略過）
    const E = await C45.boot('c45le', { settings: { line_member_gate_enabled: '1', line_member_gate_mode: 'entry', line_member_allow_skip: '1' } }); boots.push(E);
    const D = twDate(1);
    const innerQs = (pid, m = 'takeout', d = D) => `?store_id=${STORE}&product_ref=${puuid(pid)}&src=restock&m=${m}&d=${d}`;
    const primaryUrl = (C, pid, m, d) => `${C.s.base}/line-order.html?store_id=${STORE}&liff.state=${encodeURIComponent(innerQs(pid, m, d))}#access_token=FAKE-ACCESS-TOKEN-c45&id_token=FAKE-ID-TOKEN-c45&context_token=x`;
    const directUrl = (C, pid, m, d) => `${C.s.base}/line-order.html${innerQs(pid, m, d)}`;

    async function openPage(C, opts = {}) {
      const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
      await context.addInitScript(([cfg, skey, sess, ckey, cart]) => {
        window.__C45_LIFF = cfg;
        if (!sessionStorage.getItem('__c45seed')) {
          sessionStorage.setItem('__c45seed', '1');
          if (sess) localStorage.setItem(skey, sess); else localStorage.removeItem(skey);
          if (cart) localStorage.setItem(ckey, cart);
        }
        // 記錄 history.replaceState：是否在 liff.init() 完成前移除了直達參數（只記錄參數名稱，不記錄網址）
        const orig = history.replaceState.bind(history);
        history.replaceState = function (st, t, url) {
          try {
            const before = new URLSearchParams(location.search); const after = new URL(url, location.href).searchParams;
            const removed = ['product_ref', 'liff.state', 'src', 'm', 'd'].filter((k) => before.has(k) && !after.has(k));
            if (removed.length) {
              const L = JSON.parse(sessionStorage.getItem('__c45rs') || '[]');
              L.push({ removed, liffInitDone: !!window.__c45LiffInitDone, liffLoaded: typeof window.liff === 'object' });
              sessionStorage.setItem('__c45rs', JSON.stringify(L));
            }
          } catch (e) {}
          return orig(st, t, url);
        };
      }, [opts.liff || {}, SKEY, opts.session || '', CART_KEY, opts.cart || '']);
      const page = await context.newPage();
      const st = { docs: 0, sdkReq: 0, perDoc: [], errors: [], all: [] };
      const cur = () => st.perDoc[st.docs - 1] || (st.perDoc[0] = { menu: 0, shop: 0, ref: 0, events: [], analyticsBodies: [] });
      await page.route('https://static.line-scdn.net/**', async (route) => {
        st.sdkReq++;
        if (opts.sdk === 'fail') return route.abort('failed');
        if (opts.sdkDelay) await sleep(opts.sdkDelay);
        if (opts.sdk === 'hold') { st.held = route; return; }
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LIFF_SDK });
      });
      page.on('pageerror', (e) => st.errors.push(e.message));
      page.on('request', (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) { st.docs++; st.perDoc[st.docs - 1] = { menu: 0, shop: 0, ref: 0, events: [], analyticsBodies: [] }; return; }
        const u = r.url(); const d = cur();
        st.all.push(u + ' ' + (r.postData() || ''));
        if (/\/api\/line-menu/.test(u)) d.menu++;
        if (/\/api\/line-shop/.test(u)) d.shop++;
        if (/\/api\/product-demand\/product-ref/.test(u)) d.ref++;
        if (/\/api\/analytics\/events/.test(u) && r.method() === 'POST') { try { const b = JSON.parse(r.postData() || '{}'); d.events.push(b.event_name); d.analyticsBodies.push(r.postData() || ''); } catch {} }
      });
      return { context, page, st };
    }
    const settle = async (page, ms = 2500) => { try { await page.waitForLoadState('networkidle', { timeout: ms + 4000 }); } catch {} await sleep(ms); };
    const view = (page) => page.evaluate(() => {
      const c = document.getElementById('content'); const l = document.getElementById('loading');
      const det = document.querySelector('.pdm-overlay.pdm-open');
      return {
        url: location.pathname + location.search, hash: location.hash,
        content: c ? getComputedStyle(c).display : '', loading: l ? getComputedStyle(l).display : '', cards: document.querySelectorAll('.prod-card').length,
        notice: (document.getElementById('restockNoticeText') || {}).textContent || '',
        cart: (typeof cart === 'object' && cart) ? JSON.stringify(Object.fromEntries(Object.entries(cart).map(([k, v]) => [k, v.qty]))) : '',
        mode: typeof currentMode === 'string' ? currentMode : '',
        detailOpen: !!det,
        liffLog: JSON.parse(sessionStorage.getItem('__c45liff') || '{}'),
        rs: JSON.parse(sessionStorage.getItem('__c45rs') || '[]'),
        diag: (() => { try { return window.__RESTOCK_LINK_DIAG__ || null; } catch (e) { return null; } })(),
        gate: !!document.getElementById('lineMemberGate'),
      };
    });
    const viewItems = (st) => st.perDoc.map((d) => d.events.filter((e) => e === 'view_item').length);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const earlyStrip = (v) => v.rs.filter((r) => r.removed.includes('product_ref') && !r.liffInitDone).length;

    // ── L1：LIFF 一次導向 → 二次導向（init 先 resolve 再導向），頁面載入即初始化 LIFF ──
    for (const mode of ['resolve_then_redirect', 'hang_redirect']) {
      const P = await openPage(A, { liff: { mode } });
      await P.page.goto(primaryUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page);
      const vi = viewItems(P.st);
      const tag = mode === 'resolve_then_redirect' ? 'L1' : 'L1b';
      assert(P.st.docs === 2, `${tag}-1 文件載入 2 次（LINE 官方一次導向＋二次導向）`, JSON.stringify({ docs: P.st.docs }));
      assert(P.st.perDoc[0] && P.st.perDoc[0].menu === 0 && P.st.perDoc[0].events.length === 0,
        `${tag}-2 一次導向頁不做一般初始化：不讀菜單、不送 Analytics`, JSON.stringify(P.st.perDoc[0] && { menu: P.st.perDoc[0].menu, shop: P.st.perDoc[0].shop, events: P.st.perDoc[0].events }));
      assert(P.st.docs === 2 && P.st.perDoc[1].menu === 1, `${tag}-3 最終頁菜單只讀取 1 次`, JSON.stringify(P.st.perDoc.map((d) => d.menu)));
      assert(sum(vi) === 1 && vi[vi.length - 1] === 1 && v.detailOpen, `${tag}-4 商品只開啟 1 次，且在最終頁`, JSON.stringify({ vi, detailOpen: v.detailOpen }));
      assert((v.liffLog.primary_init || 0) === 1 && (v.liffLog.init || 0) === 2, `${tag}-5 liff.init()：一次導向頁 1 次、最終頁 1 次（官方要求兩頁各初始化）`, JSON.stringify(v.liffLog));
      assert(earlyStrip(v) === 0, `${tag}-6 最終頁在 liff.init() 完成前沒有改寫網址（History API）`, JSON.stringify(v.rs));
      assert(!/product_ref|liff\.state/.test(v.url) && /store_id=store_001/.test(v.url), `${tag}-7 初始化完成後網址已整理（保留 store_id）`, v.url);
      assert(/外帶自取/.test(v.notice) && v.cart === '{}' && v.mode === 'takeout', `${tag}-8 日期／取餐方式只作提示：不加入購物車、不改取餐方式`, JSON.stringify({ notice: v.notice, cart: v.cart, mode: v.mode }));
      const leak = P.st.all.filter((x) => /FAKE-ACCESS-TOKEN|FAKE-ID-TOKEN|liff\.state/.test(x));
      assert(leak.length === 0, `${tag}-9 沒有任何 API 請求帶出 LIFF 憑證或一次導向網址`, leak.slice(0, 2).join(' | ').slice(0, 300));
      assert(P.st.errors.length === 0, `${tag}-10 無 JavaScript 錯誤`, P.st.errors.join(' | '));
      await P.context.close();
    }

    // ── L2：店家未啟用會員 Gate（頁面本身不初始化 LIFF） ──
    {
      const P = await openPage(B, { liff: { mode: 'resolve_then_redirect' } });
      await P.page.goto(primaryUrl(B, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page); const vi = viewItems(P.st);
      assert(P.st.docs === 2 && sum(vi) === 1 && v.detailOpen && !/liff\.state|product_ref/.test(v.url),
        'L2 未啟用會員 Gate：一次導向頁仍執行 liff.init() 完成導向，最終頁開啟商品 1 次', JSON.stringify({ docs: P.st.docs, vi, url: v.url, liff: v.liffLog }));
      await P.context.close();
    }

    // ── L3：直接開啟（非 LIFF，例如外部瀏覽器）＋重新整理 ──
    {
      const P = await openPage(A, { liff: {} });
      await P.page.goto(directUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page);
      const v = await view(P.page); const vi = viewItems(P.st);
      assert(P.st.docs === 1 && sum(vi) === 1 && v.detailOpen, 'L3-1 直接開啟：商品開啟 1 次', JSON.stringify({ docs: P.st.docs, vi }));
      assert(earlyStrip(v) === 0 && !/product_ref/.test(v.url), 'L3-2 網址在 LIFF 初始化完成後才整理', JSON.stringify({ rs: v.rs, url: v.url }));
      await P.page.reload({ waitUntil: 'domcontentloaded' }); await settle(P.page);
      const vi2 = viewItems(P.st);
      assert(vi2[vi2.length - 1] === 0, 'L3-3 整理後重新整理：不再開啟商品', JSON.stringify(vi2));
      // 網址整理前重新整理（同一分頁、同一則連結）也不重複開啟
      // C5.1 必要調整（R3）：原本以 page.goto 再次載入同一連結模擬「重新整理」；C5.1 起 goto（使用者再次點選連結）
      // 是新的一次開啟、須另計點擊。改為真正的「網址仍含直達參數時重新整理」（navigation type＝reload），斷言不變。
      await P.page.evaluate((u) => { history.replaceState(null, '', u); return null; }, directUrl(A, PID));
      await P.page.reload({ waitUntil: 'domcontentloaded' }); await settle(P.page);
      const vi3 = viewItems(P.st);
      assert(vi3[vi3.length - 1] === 0, 'L3-4 同一分頁再次載入同一連結（整理前重新整理）：不重複開啟', JSON.stringify(vi3));
      await P.context.close();
    }

    // ── L4：一次導向頁 LIFF SDK 載入慢（2.5 秒）：持續顯示載入狀態，不先出現菜單 ──
    {
      const P = await openPage(A, { liff: { mode: 'resolve_then_redirect' }, sdkDelay: 2500 });
      await P.page.goto(primaryUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      const mid = await view(P.page);
      await settle(P.page, 3000);
      const v = await view(P.page); const vi = viewItems(P.st);
      assert(/liff\.state/.test(mid.url) ? (mid.content === 'none' && mid.loading !== 'none') : true,
        'L4-1 一次導向頁等待 SDK 時維持載入畫面（不先顯示菜單再重載）', JSON.stringify({ url: mid.url.slice(0, 40), content: mid.content, loading: mid.loading }));
      assert(P.st.docs === 2 && sum(vi) === 1 && v.detailOpen, 'L4-2 慢 SDK：導向後商品開啟 1 次', JSON.stringify({ docs: P.st.docs, vi }));
      await P.context.close();
    }

    // ── L5：一次導向頁 SDK 載入失敗：本頁照常顯示並開啟商品，不改 liff.* 參數 ──
    {
      const P = await openPage(A, { liff: {}, sdk: 'fail' });
      await P.page.goto(primaryUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page); const vi = viewItems(P.st);
      assert(P.st.docs === 1 && v.content !== 'none' && v.cards > 0 && sum(vi) === 1, 'L5-1 SDK 失敗：本頁顯示菜單並開啟商品 1 次', JSON.stringify({ docs: P.st.docs, content: v.content, cards: v.cards, vi }));
      assert(/liff\.state/.test(v.url) && v.rs.length === 0, 'L5-2 備援時不改寫或刪除 liff.state', JSON.stringify({ url: v.url.slice(0, 60), rs: v.rs }));
      const leak = P.st.all.filter((x) => /FAKE-ACCESS-TOKEN|FAKE-ID-TOKEN/.test(x));
      assert(leak.length === 0 && P.st.errors.length === 0, 'L5-3 不帶出 LIFF 憑證、無 JavaScript 錯誤', (leak[0] || '').slice(0, 200) + P.st.errors.join('|'));
      await P.context.close();
    }

    // ── L6：重複初始化（SDK 失敗後恢復不適用）→ 用 B：一次導向成功、最終頁不初始化；
    //       A 備援頁：Gate 再呼叫 liff.init() 時沿用同一次初始化 ──
    {
      const P = await openPage(A, { liff: { mode: 'stay' } }); // 替身：stay 模式不導向（模擬 SDK 未完成導向）
      await P.page.route('https://static.line-scdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript',
        body: FAKE_LIFF_SDK.replace("if(st!==null){", "if(st!==null && (window.__C45_LIFF||{}).mode!=='stay'){") }));
      await P.page.goto(primaryUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 5000);
      const v = await view(P.page); const vi = viewItems(P.st);
      assert(P.st.docs === 1 && sum(vi) === 1 && (v.liffLog.init || 0) === 1,
        'L6 一次導向後未導向（逾時備援）：本頁開啟商品 1 次，liff.init() 實際只執行 1 次（Gate 沿用）', JSON.stringify({ docs: P.st.docs, vi, liff: v.liffLog, diag: v.diag && v.diag.fallback }));
      await P.context.close();
    }

    // ── L7：進站登入 Gate：登入畫面顯示期間不開商品；登入返回網址保留直達參數；略過後只開 1 次 ──
    {
      const P = await openPage(E, { liff: { mode: 'resolve_then_redirect' } });
      await P.page.goto(primaryUrl(E, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v1 = await view(P.page); const vi1 = viewItems(P.st);
      assert(v1.gate && sum(vi1) === 0, 'L7-1 登入 Gate 顯示期間不先開啟商品', JSON.stringify({ gate: v1.gate, vi1 }));
      await P.page.click('#lmgLoginBtn').catch(() => {}); await sleep(500);
      const redirect = await P.page.evaluate(() => sessionStorage.getItem('__c45_login_redirect') || '');
      assert(/product_ref=/.test(redirect) && /src=restock/.test(redirect), 'L7-2 LINE 登入返回網址保留通知商品參數（返回後的最終頁才開啟）', redirect.replace(/^https?:\/\/[^/]+/, '').slice(0, 160));
      const skip = await P.page.$('#lmgSkipBtn'); if (skip) await skip.click(); await sleep(1500);
      const v2 = await view(P.page); const vi2 = viewItems(P.st);
      assert(!v2.gate && sum(vi2) === 1 && v2.detailOpen, 'L7-3 略過登入後商品開啟 1 次', JSON.stringify({ gate: v2.gate, vi2 }));
      await P.context.close();
      // 登入返回（已有會員 session）：最終頁直接開啟 1 次
      if (redirect) {
        const sess = JSON.stringify({ member_session: C45.session(C45.U(1)), display_name: '會員1', is_friend: true, expires_at: C45.REAL_NOW() + 3600e3 });
        const R = await openPage(E, { liff: { loggedIn: false }, session: sess });
        const back = redirect.replace(/^https?:\/\/[^/]+/, E.s.base);
        await R.page.goto(back, { waitUntil: 'domcontentloaded' }); await settle(R.page);
        const v3 = await view(R.page); const vi3 = viewItems(R.st);
        assert(!v3.gate && sum(vi3) === 1 && v3.detailOpen && !/product_ref/.test(v3.url), 'L7-4 登入返回後最終頁開啟商品 1 次並整理網址', JSON.stringify({ vi3, url: v3.url }));
        await R.context.close();
      }
    }

    // ── L8：商品已隱藏／不存在：明確提示，仍可繼續瀏覽與加入其他商品 ──
    for (const [tag, pid] of [['L8-1 已隱藏', PID_HIDDEN], ['L8-2 不存在', 799]]) {
      const P = await openPage(A, { liff: { mode: 'resolve_then_redirect' } });
      await P.page.goto(primaryUrl(A, pid), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page);
      await P.page.click(`#pc-${PID2} .add-btn`).catch(() => {}); await sleep(400);
      const v2 = await view(P.page);
      assert(/未在 LINE 點餐頁提供/.test(v.notice) && sum(viewItems(P.st)) === 0 && v.cards > 0 && v2.cart === `{"${PID2}":1}`,
        `${tag}商品：提示、不開詳情，可繼續瀏覽並加入其他商品`, JSON.stringify({ notice: v.notice, cards: v.cards, cart: v2.cart }));
      await P.context.close();
    }

    // ── L9：既有購物車與取餐方式不被覆蓋（通知為外送，顧客原本外帶）──
    {
      const cartObj = { version: 1, store_id: STORE, cart_created_at: Date.now() - 60e3, cart_updated_at: Date.now() - 60e3, cart: { [PID2]: 2 },
        order_mode: 'takeout', customer: { name: '', phone: '' }, coupon_code: '', pickup_date: twDate(0), pickup_time: '', payment_method: '', order_note: '' };
      const P = await openPage(A, { liff: { mode: 'resolve_then_redirect' }, cart: JSON.stringify(cartObj) });
      await P.page.goto(primaryUrl(A, PID, 'delivery'), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page);
      assert(v.cart === `{"${PID2}":2}` && v.mode === 'takeout' && /外送/.test(v.notice) && sum(viewItems(P.st)) === 1,
        'L9 既有購物車保留、取餐方式維持顧客原選擇（通知的外送只作提示）', JSON.stringify({ cart: v.cart, mode: v.mode, notice: v.notice }));
      await P.context.close();
    }

    // ── L10：Recovery 連結優先，不同時開啟商品 ──
    {
      const P = await openPage(A, { liff: {} });
      await P.page.goto(`${directUrl(A, PID)}&recovery_token=rt_fake_c45_token`, { waitUntil: 'domcontentloaded' });
      await settle(P.page);
      const v = await view(P.page);
      assert(sum(viewItems(P.st)) === 0 && !/recovery_token/.test(v.url), 'L10 Recovery 還原優先：不開啟商品，Recovery token 仍立即從網址移除', JSON.stringify({ url: v.url }));
      await P.context.close();
    }

    // ── L11：一般首屏（無通知連結）在 LIFF SDK 持續 pending 時照常顯示 ──
    {
      const P = await openPage(A, { liff: {}, sdk: 'hold' });
      const t0 = Date.now();
      await P.page.goto(`${A.s.base}/line-order.html?store_id=${STORE}`, { waitUntil: 'domcontentloaded' });
      let shown = null;
      try { await P.page.waitForFunction(() => getComputedStyle(document.getElementById('content')).display !== 'none' && document.querySelectorAll('.prod-card').length > 0, null, { timeout: 8000 }); shown = Date.now() - t0; } catch {}
      assert(shown != null && P.st.sdkReq === 1, 'L11 一般首屏不等待 LIFF（SDK pending 時商品頁已顯示）', JSON.stringify({ shown }));
      await P.context.close();
    }

    // ── L12：診斷資料不含網址、權杖、商品識別或會員資料 ──
    {
      const P = await openPage(A, { liff: { mode: 'resolve_then_redirect' } });
      await P.page.goto(primaryUrl(A, PID), { waitUntil: 'domcontentloaded' });
      await settle(P.page, 3000);
      const v = await view(P.page);
      const s = JSON.stringify(v.diag || {});
      assert(v.diag && v.diag.product_open === 1 && !/http|token|access|[0-9a-f]{8}-[0-9a-f]{4}|Uc45|store_001/.test(s), 'L12 診斷資料只有階段與次數', s.slice(0, 300));
      await P.context.close();
    }

    const realA = A.mf.real() + B.mf.real() + E.mf.real();
    assert(realA === 0, 'Z LINE 真實發送呼叫 0 次', String(realA));
  } catch (e) {
    console.error(e); H.fail('測試例外', e.stack || e.message);
  } finally {
    for (const b of boots) { try { await b.s.stop(); } catch {} }
    await browser.close();
  }
  const s = H.summary();
  console.log(`\nRESULT: ${s.passCount} passed, ${s.failCount} failed`);
  process.exit(s.failCount ? 1 : 0);
})();
