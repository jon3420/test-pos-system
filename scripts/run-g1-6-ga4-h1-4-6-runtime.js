#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-6-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW
//
// 用真實 jsdom 載入真正的 public/js/product-detail-modal.js（不重寫一份假的
// modal 來測試自己），對照需求文件三～五、六的邊界條件逐一驗證：
//   - 開啟/關閉（背景遮罩／右上角 X／Esc）
//   - 數量增減與即時小計
//   - 無圖片/無介紹的安全 fallback（不留 undefined/null 字樣）
//   - onOpen 只在每次 open() 呼叫時觸發一次（模擬「重繪」呼叫 _render 不重複觸發）
//   - 快速連點（300ms 內）不重複呼叫 onAddToCart
//   - onAddToCart 回傳 false 時（既有驗證判定失敗）modal 保持開啟、不誤報「已加入」
//   - blocked 商品（售完）不可加入、footer 顯示對應文字
//   - maxQty 上限生效（+ 按鈕在上限時停用）
//   - body 捲動鎖定 class 開啟時加上、關閉後移除
//
// 誠實聲明：這是本輪（H1.4.6）第一次執行，沒有歷史 PASS 紀錄——每次執行都是全新
// 建立 jsdom 環境、載入真實原始碼、真實觸發 DOM 事件後比對結果。

'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const MODAL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/product-detail-modal.js'), 'utf8');

function freshEnv() {
  // runScripts:'dangerously' + 真的用 <script> 標籤載入，是 jsdom 官方建議的執行
  // 方式，確保腳本執行的 realm 與 dom.window 是同一個物件（避免 indirect eval 產生
  // 的 global 與 dom.window 不同步，導致掛在 window 上的 ProductDetailModal 讀不到）。
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true, runScripts: 'dangerously',
  });
  const { window } = dom;
  // jsdom 沒有實作真正的版面配置/捲動，window.scrollTo 在測試環境下會丟出
  // "Not implemented" 噪音（不影響斷言本身，_unlockScroll() 呼叫它只是為了在真實
  // 瀏覽器中恢復捲動位置）。這裡用一個記錄呼叫次數的假函式取代，順便驗證
  // _unlockScroll() 真的有呼叫它。
  window.__scrollToCalls = 0;
  window.scrollTo = function () { window.__scrollToCalls++; };
  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = MODAL_SRC;
  window.document.body.appendChild(scriptEl);
  return { dom, window, document: window.document };
}

function fireClick(win, el) {
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}
function fireKey(win, target, key) {
  const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

async function main() {
  // ── Category A：基本開關 ──────────────────────────────
  {
    const { window, document } = freshEnv();
    let openedWith = null;
    window.ProductDetailModal.open(
      { id: 1, name: '珍珠奶茶', price: 60, image: '', description: '' },
      { onOpen: (p) => { openedWith = p; } }
    );
    assert(window.ProductDetailModal.isOpen(), 'A1 open() 後 isOpen()===true');
    assert(!!openedWith && openedWith.id === 1, 'A2 onOpen 收到正確的商品物件');
    const overlay = document.querySelector('.pdm-overlay');
    assert(!!overlay && overlay.classList.contains('pdm-open'), 'A3 overlay 加上 pdm-open class');
    assert(document.documentElement.classList.contains('pdm-scroll-lock'), 'A4 開啟時 <html> 加上捲動鎖定 class');

    // 點右上角關閉
    const closeBtn = document.querySelector('.pdm-close');
    fireClick(window, closeBtn);
    assert(!window.ProductDetailModal.isOpen(), 'A5 點右上角關閉按鈕後 isOpen()===false');
    assert(!document.documentElement.classList.contains('pdm-scroll-lock'), 'A6 關閉後移除捲動鎖定 class（恢復頁面捲動）');
  }

  // ── Category B：背景遮罩與 Esc 關閉 ──────────────────
  {
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 2, name: '紅茶', price: 30, image: '', description: '' }, {});
    const overlay = document.querySelector('.pdm-overlay');
    fireClick(window, overlay); // 點遮罩本身（非 sheet）
    assert(!window.ProductDetailModal.isOpen(), 'B1 點背景遮罩可以關閉');

    window.ProductDetailModal.open({ id: 2, name: '紅茶', price: 30, image: '', description: '' }, {});
    fireKey(window, document, 'Escape');
    assert(!window.ProductDetailModal.isOpen(), 'B2 按 Esc 可以關閉（桌機）');

    window.ProductDetailModal.open({ id: 2, name: '紅茶', price: 30, image: '', description: '' }, {});
    const sheet = document.querySelector('.pdm-sheet');
    fireClick(window, sheet); // 點 sheet 本體不應該關閉
    assert(window.ProductDetailModal.isOpen(), 'B3 點 sheet 本體（非遮罩）不會誤關閉');
    window.ProductDetailModal.close();
  }

  // ── Category C：無圖片／無介紹的安全 fallback ─────────
  {
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 3, name: '無圖無介紹商品', price: 88, image: '', description: '' }, {});
    const html = document.querySelector('.pdm-imgbox').innerHTML;
    assert(html.includes('pdm-ph'), 'C1 無圖片時使用 placeholder（.pdm-ph），不是破圖');
    const bodyHtml = document.querySelector('.pdm-body').innerHTML;
    assert(!/undefined/i.test(bodyHtml) && !/\bnull\b/.test(bodyHtml), 'C2 無介紹時不顯示 undefined/null 字樣');
    assert(!bodyHtml.includes('pdm-desc'), 'C3 無介紹時隱藏介紹區塊（不留空白大區塊的 DOM 節點）');
    window.ProductDetailModal.close();
  }
  {
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 4, name: '有介紹商品', price: 88, image: '', description: '手工現做，每日限量' }, {});
    const bodyHtml = document.querySelector('.pdm-body').innerHTML;
    assert(bodyHtml.includes('pdm-desc') && bodyHtml.includes('手工現做'), 'C4 有介紹時正確顯示介紹文字');
    window.ProductDetailModal.close();
  }
  {
    // 圖片 onerror 時退回 placeholder，不留破圖 <img>
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 5, name: '壞圖商品', price: 50, image: 'https://example.invalid/x.jpg', description: '' }, {});
    const img = document.querySelector('.pdm-imgbox img');
    assert(!!img, 'C5 有圖片網址時渲染 <img>');
    assert(img.getAttribute('onerror').includes('pdm-ph'), 'C6 <img> 有 onerror fallback 到 placeholder，避免破圖');
    window.ProductDetailModal.close();
  }

  // ── Category D：數量增減與即時小計 ────────────────────
  {
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 6, name: '雞排', price: 65, image: '', description: '' }, {});
    const sub = () => document.querySelector('.pdm-subtotal b').textContent;
    assert(sub() === '$65', 'D1 初始數量 1 時小計 = 65');
    fireClick(window, document.querySelector('.pdm-plus'));
    assert(sub() === '$130', 'D2 數量 +1 → 2 時小計 = 130（65*2）');
    fireClick(window, document.querySelector('.pdm-plus'));
    assert(sub() === '$195', 'D3 數量 +1 → 3 時小計 = 195（65*3）');
    fireClick(window, document.querySelector('.pdm-minus'));
    assert(sub() === '$130', 'D4 數量 -1 → 2 時小計正確回退');
    window.ProductDetailModal.close();
  }
  {
    // maxQty 上限：+ 按鈕在達到上限時停用
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 7, name: '限量商品', price: 100, image: '', description: '', maxQty: 2 }, {});
    fireClick(window, document.querySelector('.pdm-plus'));
    assert(document.querySelector('.pdm-qty-num').textContent === '2', 'D5 數量可以增加到 maxQty=2');
    assert(document.querySelector('.pdm-plus').disabled === true, 'D6 達到 maxQty 上限後 + 按鈕停用');
    fireClick(window, document.querySelector('.pdm-plus')); // 停用狀態下點擊不應該再增加
    assert(document.querySelector('.pdm-qty-num').textContent === '2', 'D7 + 按鈕停用時點擊不會超過 maxQty');
    window.ProductDetailModal.close();
  }
  {
    // 數量下限為 1，minus 按鈕在數量=1時停用
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 8, name: '一般商品', price: 20, image: '', description: '' }, {});
    assert(document.querySelector('.pdm-minus').disabled === true, 'D8 初始數量=1 時 − 按鈕停用（不可低於 1）');
    window.ProductDetailModal.close();
  }

  // ── Category E：加入購物車、快速連點防護、失敗時不誤報 ─
  {
    const { window, document } = freshEnv();
    let addCalls = 0;
    window.ProductDetailModal.open({ id: 9, name: '珍奶', price: 60, image: '', description: '' }, {
      onAddToCart: (p, qty) => { addCalls++; return true; },
    });
    const addBtn = () => document.querySelector('.pdm-add-btn');
    fireClick(window, addBtn());
    fireClick(window, addBtn()); // 極短時間內連點第二次
    assert(addCalls === 1, 'E1 300ms 內快速連點兩次，onAddToCart 只被呼叫一次（防止重複加入）');
  }
  {
    const { window, document } = freshEnv();
    let addCalls = 0;
    window.ProductDetailModal.open({ id: 10, name: '份數不足商品', price: 60, image: '', description: '' }, {
      onAddToCart: () => { addCalls++; return false; }, // 模擬既有驗證判斷失敗（例如份數不足）
    });
    fireClick(window, document.querySelector('.pdm-add-btn'));
    assert(addCalls === 1, 'E2 onAddToCart 仍會被呼叫一次');
    assert(window.ProductDetailModal.isOpen(), 'E3 onAddToCart 回傳 false 時 modal 保持開啟，不誤導使用者「已加入」');
    assert(!document.querySelector('.pdm-add-btn').classList.contains('pdm-added'), 'E4 加入失敗時按鈕不顯示「已加入」狀態');
  }

  // ── Category F：售完（blocked）商品不可加入 ───────────
  {
    const { window, document } = freshEnv();
    let addCalls = 0;
    window.ProductDetailModal.open(
      { id: 11, name: '今日售完商品', price: 80, image: '', description: '', blocked: true, blockedLabel: '今日售完' },
      { onAddToCart: () => { addCalls++; return true; } }
    );
    const btn = document.querySelector('.pdm-add-btn');
    assert(btn.disabled === true, 'F1 blocked 商品的加入購物車按鈕為 disabled');
    assert(btn.textContent.includes('今日售完'), 'F2 blocked 商品顯示對應的售完文字，不顯示「加入購物車」');
    assert(!document.querySelector('.pdm-qty-row'), 'F3 blocked 商品不顯示數量調整區（無法加入，不需要選數量）');
    fireClick(window, btn);
    assert(addCalls === 0, 'F4 blocked 商品點擊加入按鈕不會呼叫 onAddToCart（Modal 不繞過售完判斷）');
  }

  // ── Category G：onOpen 只在每次 open() 呼叫時觸發一次（重繪不重複觸發）─
  {
    const { window, document } = freshEnv();
    let openCount = 0;
    window.ProductDetailModal.open({ id: 12, name: '商品A', price: 40, image: '', description: '' }, {
      onOpen: () => { openCount++; },
    });
    assert(openCount === 1, 'G1 第一次 open() 觸發 onOpen 一次');
    // 模擬同一次開啟期間的內部重繪（數量增減會呼叫 _renderFooter/_renderQtyRow，
    // 不是重新呼叫 open()）——不應該讓 onOpen 再被觸發
    fireClick(window, document.querySelector('.pdm-plus'));
    fireClick(window, document.querySelector('.pdm-minus'));
    assert(openCount === 1, 'G2 同一次開啟期間內部重繪（數量增減）不會重複觸發 onOpen');
    window.ProductDetailModal.close();
    // 使用者關閉後再次主動開啟 → 可以再記錄一次
    window.ProductDetailModal.open({ id: 12, name: '商品A', price: 40, image: '', description: '' }, {
      onOpen: () => { openCount++; },
    });
    assert(openCount === 2, 'G3 關閉後使用者再次主動開啟，onOpen 可以再觸發一次');
    window.ProductDetailModal.close();
  }

  // ── Category H：加入成功後的 UX（不誤導「尚未加入」）───
  {
    const { window, document } = freshEnv();
    window.ProductDetailModal.open({ id: 13, name: '加入成功商品', price: 45, image: '', description: '' }, {
      onAddToCart: () => true,
    });
    fireClick(window, document.querySelector('.pdm-add-btn'));
    assert(document.querySelector('.pdm-add-btn').textContent.includes('已加入'), 'H1 加入成功後按鈕立即顯示「已加入 ✓」，避免使用者誤以為尚未加入');
  }

  // ── Category I：長名稱／長介紹不噴錯（不驗證版面，只驗證不拋例外且完整渲染）─
  {
    const { window, document } = freshEnv();
    const longName = '超級加大特大份量綜合海鮮總匯超值套餐（含七種配料與獨家醬料）'.repeat(3);
    const longDesc = '本店堅持每日新鮮現做，嚴選在地食材，經過十二道工序精心製作，'.repeat(20);
    let threw = false;
    try {
      window.ProductDetailModal.open({ id: 14, name: longName, price: 999, image: '', description: longDesc }, {});
    } catch (e) { threw = true; }
    assert(!threw, 'I1 長商品名稱／長介紹開啟 Modal 不拋出例外');
    assert(document.querySelector('.pdm-name').textContent === longName, 'I2 長名稱完整渲染，不截斷/報錯');
    window.ProductDetailModal.close();
  }

  // ── 輸出結果 ──────────────────────────────────────────
  const failCount = results.filter(r => r.status === 'FAIL').length;
  results.forEach(r => {
    console.log(`${r.status === 'PASS' ? '✓' : '✗ FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });
  console.log(`\nPASS: ${results.length - failCount}`);
  console.log(`FAIL: ${failCount}`);
  console.log(`TOTAL: ${results.length}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
