/**
 * printService.js  v6
 * 雙模式 ESC/POS 列印：
 *   - USB 模式：Windows Spooler（copy /b RAW）
 *   - LAN 模式：TCP socket IP:9100
 *
 * 中文編碼：cp936（GBK）+ FS & 漢字模式（XP-80C 實測正確）
 *
 * v6 新增（合併 v12 功能）：
 *   - 收據最上方顯示【內用】/【外帶】/【外送】平台 #單號
 *   - 測試列印標題改為「測試列印」，移除店名
 *   - 廚房單商品移除 DBL（避免卡半）
 *   - 廚房單結尾多 feed 避免卡切刀
 *   - 新增 buildKitchenTestBuffer / printKitchenTest
 */

'use strict';

const net            = require('net');
const { execFile }   = require('child_process');
const { getDb }      = require('../utils/db');
const iconv          = require('iconv-lite');

// ── ESC/POS 指令 ─────────────────────────────────────────
const ESC = 0x1B, GS = 0x1D, FS = 0x1C;

const CMD = {
  INIT:        Buffer.from([ESC, 0x40]),
  CUT_PARTIAL: Buffer.from([GS,  0x56, 0x01]),
  CUT_FULL:    Buffer.from([GS,  0x56, 0x00]),
  CASH_DRAWER: Buffer.from([ESC, 0x70, 0x00, 0x1A, 0xFF]),
  ALIGN_L:     Buffer.from([ESC, 0x61, 0x00]),
  ALIGN_C:     Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_R:     Buffer.from([ESC, 0x61, 0x02]),
  BOLD_ON:     Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF:    Buffer.from([ESC, 0x45, 0x00]),
  DBL_ON:      Buffer.from([ESC, 0x21, 0x30]),
  DBL_OFF:     Buffer.from([ESC, 0x21, 0x00]),
  FEED3:       Buffer.from([ESC, 0x64, 0x03]),
  LF:          Buffer.from([0x0A]),
};

// XP-80C 實測正確：ESC t 0 + FS & 開啟漢字模式，編碼用 cp936
const CHARSET_CMD = Buffer.from([
  ESC, 0x74, 0x00,  // ESC t 0 — code page PC437
  FS,  0x26,        // FS & — 開啟漢字模式
]);

// ── 讀取設定 ──────────────────────────────────────────────
function getPrinterConfig() {
  try {
    const db  = getDb();
    const get = (k, d) => {
      const r = db.get('SELECT value FROM settings WHERE key=?', [k]);
      return r ? r.value : d;
    };
    return {
      enabled:            get('printer_enabled', '0') === '1',
      type:               get('printer_type', 'network'),
      ip:                 get('printer_ip', '192.168.1.100'),
      port:               parseInt(get('printer_port', '9100')) || 9100,
      printer_name:       get('printer_name', ''),
      printer_share_name: get('printer_share_name', ''),
      auto_print:         get('auto_print', '0') === '1',
      auto_drawer:        get('auto_drawer', '0') === '1',
      shop_name:          get('shop_name', 'POS 系統'),
      receipt_footer:     get('receipt_footer', '謝謝光臨！'),
    };
  } catch (e) {
    console.error('[PrintService] 讀取設定失敗:', e.message);
    return {
      enabled: false, type: 'network', ip: '192.168.1.100', port: 9100,
      printer_name: '', auto_print: false, auto_drawer: false,
    };
  }
}

// ── 文字 / 排版工具 ───────────────────────────────────────

function tb(text) {
  return Buffer.concat([iconv.encode(String(text || ''), 'cp936'), CMD.LF]);
}

function dashes(char = '-', n = 32) {
  return tb(char.repeat(n));
}

function charWidth(str) {
  let w = 0;
  for (const ch of String(str)) w += ch.charCodeAt(0) > 0x7F ? 2 : 1;
  return w;
}

function alignedLine(left, right, total = 32) {
  const l   = String(left  || '');
  const r   = String(right || '');
  const gap = Math.max(1, total - charWidth(l) - charWidth(r));
  return Buffer.concat([iconv.encode(l + ' '.repeat(gap) + r, 'cp936'), CMD.LF]);
}

// ── LAN 傳送（TCP socket） ────────────────────────────────
function sendNetwork(ip, port, data, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const sock  = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`TCP 連線逾時 (${ip}:${port})`));
    }, timeout);

    sock.connect(port, ip, () => {
      sock.write(data, err => {
        clearTimeout(timer);
        sock.end();
        if (err) reject(err); else resolve(true);
      });
    });

    sock.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Windows Spooler 傳送（copy /b RAW 列印）────────────────
async function sendWindowsSpooler(printerShareName, data) {
  if (!printerShareName || !printerShareName.trim()) {
    throw new Error('未設定 Windows 印表機共享名稱，請至設定頁填寫（例如：XP80）');
  }

  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');

  const tempFile = path.join(os.tmpdir(), `pos-print-${Date.now()}.bin`);
  fs.writeFileSync(tempFile, data);

  const target = `\\\\127.0.0.1\\${printerShareName.trim()}`;

  return new Promise((resolve, reject) => {
    execFile(
      'cmd.exe',
      ['/c', 'copy', '/b', tempFile, target],
      { windowsHide: true, timeout: 10000 },
      (error) => {
        try { fs.unlinkSync(tempFile); } catch {}
        if (error) {
          console.error('[PrintService] copy /b 失敗:', error.message);
          return reject(new Error(error.message));
        }
        console.log('[PrintService] RAW 列印成功:', target);
        resolve(true);
      }
    );
  });
}

// ── 主傳送入口 ────────────────────────────────────────────
async function send(data) {
  const cfg = getPrinterConfig();

  if (!cfg.enabled) {
    return { success: false, message: '印表機未啟用（請至設定 → 出單機 啟用）' };
  }

  try {
    if (cfg.type === 'usb') {
      if (!cfg.printer_share_name) {
        return { success: false, message: '請先設定 Windows 印表機共享名稱（例如：XP80）' };
      }
      await sendWindowsSpooler(cfg.printer_share_name, data);
      return { success: true, message: `列印成功（\\\\127.0.0.1\\${cfg.printer_share_name}）` };
    } else {
      await sendNetwork(cfg.ip, cfg.port, data);
      return { success: true, message: `列印成功（${cfg.ip}:${cfg.port}）` };
    }
  } catch (e) {
    console.error('[PrintService] 傳送失敗:', e.message);
    return { success: false, message: '列印失敗：' + e.message };
  }
}

// ── 取得 Windows 印表機清單 ────────────────────────────────
async function getWindowsPrinters() {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { timeout: 5000 }
    );
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ── 狀態檢查 ──────────────────────────────────────────────
async function checkPrinterStatus() {
  const cfg = getPrinterConfig();

  if (!cfg.enabled) {
    return { connected: false, mode: cfg.type, message: '印表機未啟用' };
  }

  if (cfg.type === 'usb') {
    if (!cfg.printer_name) {
      return { connected: false, mode: 'usb', message: '未設定印表機名稱，請至設定頁選擇' };
    }
    return {
      connected: true,
      mode: 'usb',
      printer_name: cfg.printer_name,
      message: `已設定 Windows 印表機：${cfg.printer_name}（按「測試列印」驗證）`,
    };
  }

  return new Promise(resolve => {
    const sock  = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ connected: false, mode: 'network', message: `連線逾時 (${cfg.ip}:${cfg.port})` });
    }, 3000);
    sock.connect(cfg.port, cfg.ip, () => {
      clearTimeout(timer);
      sock.end();
      resolve({ connected: true, mode: 'network', message: `已連線 ${cfg.ip}:${cfg.port}` });
    });
    sock.on('error', e => {
      clearTimeout(timer);
      resolve({ connected: false, mode: 'network', message: `無法連線：${e.message}` });
    });
  });
}

// ── 建立收據 Buffer ───────────────────────────────────────
function buildReceiptBuffer(order, cfg) {
  const parts    = [];
  const p        = (...b) => b.forEach(x => parts.push(x));
  const isCash   = order.payment_method === 'cash';
  const isVoid   = order.status === 'void';
  const payLabel = { cash:'現金', card:'刷卡', linepay:'LINE Pay', jkopay:'街口', transfer:'轉帳', platform:'平台付款' };
  const modeLbl  = { dine_in:'內用', takeout:'外帶', delivery:'外送' };
  const items    = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);

  p(CMD.INIT, CHARSET_CMD);

  // ── 最上方：訂單模式（加粗放大，最顯眼）
  const mode = modeLbl[order.order_mode] || '';
  if (mode) {
    p(CMD.ALIGN_L, CMD.BOLD_ON, CMD.DBL_ON);
    if (order.order_mode === 'delivery') {
      const platPart = order.delivery_platform ? order.delivery_platform : '';
      const noPart   = order.platform_order_no ? ` #${order.platform_order_no}` : '';
      p(tb(`【外送】${platPart}${noPart}`));
    } else {
      p(tb(`【${mode}】`));
    }
    p(CMD.DBL_OFF, CMD.BOLD_OFF);
  }

  // ── 店名
  p(CMD.ALIGN_C, CMD.BOLD_ON, CMD.DBL_ON);
  p(tb(cfg.shop_name || 'POS 系統'));
  p(CMD.DBL_OFF, CMD.BOLD_OFF);

  // ── 作廢
  if (isVoid) { p(CMD.ALIGN_C, CMD.BOLD_ON); p(tb('*** 已作廢 ***')); p(CMD.BOLD_OFF); }

  // ── 基本資訊
  p(CMD.ALIGN_L);
  p(dashes());
  p(tb(`訂單  ${order.order_number}`));
  p(tb(`時間  ${(order.created_at || '').slice(0, 19)}`));

  if (order.order_mode === 'delivery') {
    if (order.delivery_platform) p(tb(`平台  ${order.delivery_platform}`));
    if (order.platform_order_no) p(tb(`單號  ${order.platform_order_no}`));
    if (order.customer_name)     p(tb(`姓名  ${order.customer_name}`));
    if (order.customer_phone)    p(tb(`電話  ${order.customer_phone}`));
    if (order.delivery_address)  p(tb(`地址  ${order.delivery_address}`));
  } else if (order.order_mode === 'dine_in' && order.table_number) {
    p(tb(`桌號  ${order.table_number}`));
  } else if (order.order_mode === 'takeout' && order.pickup_name) {
    p(tb(`取餐  ${order.pickup_name}`));
  }
  if (order.note) p(tb(`備註  ${order.note}`));

  // ── 商品
  p(dashes());
  items.forEach(item => {
    p(CMD.BOLD_ON);
    p(tb(item.name));
    p(CMD.BOLD_OFF);
    p(alignedLine(`  x${item.qty} @ NT$${item.price}`, `NT$${item.subtotal}`));
  });

  // ── 金額
  p(dashes());
  p(CMD.BOLD_ON);
  p(alignedLine('應收', `NT$${order.total}`));
  p(CMD.BOLD_OFF);
  if (isCash) {
    p(alignedLine('實收', `NT$${order.received_amount || 0}`));
    p(alignedLine('找零', `NT$${order.change_amount   || 0}`));
  }
  p(alignedLine('付款', payLabel[order.payment_method] || order.payment_method));

  // ── 外送抽成
  if (order.order_mode === 'delivery' && Number(order.platform_commission_amount) > 0) {
    p(dashes('-'));
    p(alignedLine(`抽成(${order.platform_commission_rate}%)`, `NT$${order.platform_commission_amount}`));
    p(alignedLine('店家實收', `NT$${order.store_actual_income}`));
  }

  // ── 頁尾
  p(dashes());
  p(CMD.ALIGN_C);
  p(tb(cfg.receipt_footer || '謝謝光臨'));
  p(CMD.FEED3);
  p(CMD.CUT_PARTIAL);

  return Buffer.concat(parts);
}

// ── 廚房單 Buffer ─────────────────────────────────────────
function buildKitchenBuffer(order, cfg) {
  const parts   = [];
  const p       = (...b) => b.forEach(x => parts.push(x));
  const modeLbl = { dine_in:'內用', takeout:'外帶', delivery:'外送' };
  const items   = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);

  p(CMD.INIT, CHARSET_CMD);

  // 標題：BOLD 即可，不用 DBL 避免卡半
  p(CMD.ALIGN_C, CMD.BOLD_ON);
  p(tb('== 廚房單 =='));
  p(CMD.BOLD_OFF);

  p(CMD.ALIGN_L);
  p(dashes());
  p(tb(`訂單  ${order.order_number}`));
  p(tb(`時間  ${(order.created_at || '').slice(11, 19)}`));
  const mode = modeLbl[order.order_mode] || '';
  if (mode) p(tb(`模式  ${mode}`));
  if (order.order_mode === 'dine_in'  && order.table_number)      p(tb(`桌號  ${order.table_number}`));
  if (order.order_mode === 'delivery' && order.delivery_platform) p(tb(`平台  ${order.delivery_platform}`));
  if (order.delivery_address) p(tb(`地址  ${order.delivery_address}`));

  p(dashes());

  // 商品：BOLD 即可，不用 DBL（DBL 超出 80mm 會卡半）
  items.forEach(item => {
    p(CMD.BOLD_ON);
    p(tb(`${item.name} x${item.qty}`));
    p(CMD.BOLD_OFF);
  });

  if (order.note) { p(dashes('-')); p(tb(`備註：${order.note}`)); }

  // 結尾多 feed，避免文字卡切刀
  p(CMD.LF);
  p(CMD.FEED3);
  p(CMD.LF);
  p(CMD.CUT_PARTIAL);

  return Buffer.concat(parts);
}

// ── 廚房單測試 Buffer ─────────────────────────────────────
function buildKitchenTestBuffer() {
  const parts = [];
  const p     = (...b) => b.forEach(x => parts.push(x));
  const now   = new Date();
  const hms   = [now.getHours(), now.getMinutes(), now.getSeconds()]
                  .map(n => String(n).padStart(2, '0')).join(':');

  p(CMD.INIT, CHARSET_CMD);
  p(CMD.ALIGN_C, CMD.BOLD_ON);
  p(tb('== 廚房單測試 =='));
  p(CMD.BOLD_OFF);
  p(CMD.ALIGN_L);
  p(dashes());
  p(CMD.BOLD_ON);
  p(tb('冷拌麻油腰子 x1'));
  p(CMD.BOLD_OFF);
  p(tb('備註：不要辣'));
  p(dashes('-'));
  p(tb(`測試時間：${hms}`));
  p(CMD.LF);
  p(CMD.FEED3);
  p(CMD.LF);
  p(CMD.CUT_PARTIAL);

  return Buffer.concat(parts);
}

// ── 測試列印 Buffer ───────────────────────────────────────
function buildTestBuffer(cfg) {
  const parts = [];
  const p     = (...b) => b.forEach(x => parts.push(x));

  p(CMD.INIT, CHARSET_CMD);

  // 標題（無店名）
  p(CMD.ALIGN_C, CMD.BOLD_ON, CMD.DBL_ON);
  p(tb('測試列印'));
  p(CMD.DBL_OFF, CMD.BOLD_OFF);

  p(CMD.ALIGN_C);
  p(tb('脆豬腰｜冷拌麻油腰子'));

  p(CMD.ALIGN_L);
  p(dashes());

  p(CMD.BOLD_ON);
  p(tb('冷拌麻油腰子 x1'));
  p(CMD.BOLD_OFF);

  p(dashes());

  p(alignedLine('付款方式', '現金'));
  p(CMD.BOLD_ON);
  p(alignedLine('應收', 'NT$150'));
  p(CMD.BOLD_OFF);
  p(alignedLine('實收', 'NT$200'));
  p(alignedLine('找零', 'NT$50'));

  p(dashes());

  p(CMD.ALIGN_C);
  p(tb('謝謝光臨'));
  p(CMD.FEED3);
  p(CMD.CUT_PARTIAL);

  return Buffer.concat(parts);
}

// ── 公開 API ──────────────────────────────────────────────

async function printTest() {
  const cfg = getPrinterConfig();
  return send(buildTestBuffer(cfg));
}

async function printOrder(order) {
  const cfg = getPrinterConfig();
  return send(buildReceiptBuffer(order, cfg));
}

async function printKitchenTicket(order) {
  const cfg = getPrinterConfig();
  return send(buildKitchenBuffer(order, cfg));
}

async function printKitchenTest() {
  return send(buildKitchenTestBuffer());
}

async function openCashDrawer() {
  const cfg = getPrinterConfig();
  if (!cfg.enabled) {
    return { success: false, message: '印表機未啟用，無法開錢櫃' };
  }
  const data = Buffer.from([
    0x1B, 0x40,                    // ESC @ INIT
    0x1B, 0x70, 0x00, 0x19, 0xFA, // ESC p 0 25 250（pin2，RJ11）
  ]);
  try {
    if (cfg.type === 'usb') {
      if (!cfg.printer_share_name) {
        return { success: false, message: '請先設定 Windows 印表機共享名稱（例如：XP80）' };
      }
      await sendWindowsSpooler(cfg.printer_share_name, data);
    } else {
      await sendNetwork(cfg.ip, cfg.port, data);
    }
    return { success: true, message: '錢櫃開啟指令已送出' };
  } catch (e) {
    console.error('[PrintService] 開錢櫃失敗:', e.message);
    return { success: false, message: '開錢櫃失敗：' + e.message };
  }
}

async function autoCheckoutPrint(order) {
  const cfg    = getPrinterConfig();
  const result = { printResult: null, drawerResult: null };

  if (!cfg.enabled || !cfg.auto_print) return result;

  result.printResult = await printOrder(order);
  console.log('[AutoPrint]', result.printResult.message);

  const isCash = ['cash', '現金'].includes(order.payment_method);
  if (cfg.auto_drawer && isCash) {
    result.drawerResult = await openCashDrawer();
    console.log('[AutoDrawer]', result.drawerResult.message);
  }

  return result;
}

module.exports = {
  getPrinterConfig,
  getWindowsPrinters,
  checkPrinterStatus,
  printTest,
  printOrder,
  printKitchenTicket,
  printKitchenTest,
  openCashDrawer,
  autoCheckoutPrint,
};
