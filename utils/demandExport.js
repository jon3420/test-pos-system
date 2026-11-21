// utils/demandExport.js — R54.4／MBV2-HF1-C6：補貨需求資料 CSV 匯出（商家營運用）
//
// 與 MBV2 搬家備份不同：這裡只輸出商家日常需要看的需求統計／明細，可依店別（只信任員工 JWT）與篩選條件匯出。
//   - 保留中文：UTF-8＋BOM（Excel 直接開啟不亂碼），CRLF 換行。
//   - 正確跳脫與防公式注入：每一格經 utils/csvSecurity.sanitizeCsvCell（= + - @ Tab CR 開頭加單引號、雙引號跳脫、整格加引號）。
//   - 不輸出憑證、session、權杖：LINE 使用者識別一律遮罩；不輸出 member_session、retry key、追蹤識別、consent／request uuid。
//   - 唯讀：不寫入、不改變任何登記或通知狀態。
'use strict';

const { sanitizeCsvCell } = require('./csvSecurity');
const PD = require('./productDemand');
const RN = require('./restockNotify');

const MAX_ROWS = 20000;
const PREF = { takeout: '外帶自取', delivery: '外送', any: '都可以' };
const STATUS = { active: '有效', expired: '已過期', cancelled: '已取消', fulfilled: '已完成', completed: '已完成' };
const CONSENT = { granted: '已同意（本週期）', revoked: '已撤回', reconfirm_required: '需重新確認', none: '未同意' };
const NOTIFY = { accepted: 'LINE 已受理', in_progress: '通知處理中', none: '尚未通知' };
const SALE = { available: '可販售', sold_out_today: '今日完售', paused: '暫停販售', sold_out_indefinitely: '停售' };

function twTime(s) {
  if (!s) return '';
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  if (!Number.isFinite(t)) return String(s);
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
}
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
function toCsv(header, rows) {
  const line = (arr) => arr.map((c) => sanitizeCsvCell(c)).join(',');
  return '﻿' + [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}

function exportSummary(db, storeId, q = {}) {
  const sum = PD.adminSummary(db, storeId);
  let list = sum.products;
  if (q.product_id != null && q.product_id !== '') list = list.filter((p) => Number(p.product_id) === Number(q.product_id));
  if (String(q.only_active || '') === '1') list = list.filter((p) => p.active_users > 0);
  // C6.2：既有欄位順序不變，新增欄位接在最後（期望總份數＝有效登記的原登記份數）
  const header = ['商品編號', '商品名稱', '販售狀態', 'LINE 點餐頁顯示', '開放補貨登記', '有效登記人數', '期望總份數', '最近更新（台北）', '歷史登記筆數',
    '已完成份數（有效登記）', '訂購中份數', '尚待購買份數', '已完成登記筆數'];
  const rows = list.slice(0, MAX_ROWS).map((p) => [p.product_id, p.name, SALE[p.sale_status] || p.sale_status, p.line_visible ? '是' : '否',
    p.demand_collect_enabled ? '是' : '否', p.active_users, p.total_qty, twTime(p.last_updated_at), p.history_rows,
    Number(p.settled_qty) || 0, Number(p.reserved_qty) || 0, Number(p.to_buy_qty) || 0, Number(p.completed_requests) || 0]);
  return { csv: toCsv(header, rows), count: rows.length, truncated: list.length > MAX_ROWS };
}

function exportDetails(db, storeId, q = {}) {
  const where = ['r.store_id=?'];
  const params = [storeId];
  if (q.product_id != null && q.product_id !== '' && Number.isInteger(Number(q.product_id))) { where.push('r.product_id=?'); params.push(Number(q.product_id)); }
  const eff = "CASE WHEN r.status='active' AND r.expires_at <= datetime('now') THEN 'expired' ELSE r.status END";
  if (['active', 'expired', 'cancelled', 'completed'].includes(String(q.status || ''))) { where.push(`${eff}=?`); params.push(String(q.status)); }
  if (['takeout', 'delivery', 'any'].includes(String(q.pref || ''))) { where.push('r.fulfillment_pref=?'); params.push(String(q.pref)); }
  // 登記時間以台北日期篩選（資料庫為 UTC）
  if (ymd(q.from)) { where.push("date(datetime(r.created_at, '+8 hours')) >= ?"); params.push(ymd(q.from)); }
  if (ymd(q.to)) { where.push("date(datetime(r.created_at, '+8 hours')) <= ?"); params.push(ymd(q.to)); }
  const rows = db.all(`SELECT r.*, ${eff} AS eff_status, p.name AS p_name, p.line_name AS p_line_name, m.display_name AS member_display_name
                       FROM product_demand_requests r
                       LEFT JOIN products p ON p.id=r.product_id AND p.store_id=r.store_id
                       LEFT JOIN line_members m ON m.store_id=r.store_id AND m.line_user_id=r.line_user_id
                       WHERE ${where.join(' AND ')} ORDER BY r.product_id ASC, r.id DESC LIMIT ?`, [...params, MAX_ROWS + 1]);
  const truncated = rows.length > MAX_ROWS;
  const header = ['商品編號', '商品名稱', '會員（遮罩）', '會員顯示名稱', '期望份數', '取餐偏好', '登記狀態', '通知同意', '補貨通知', '登記時間（台北）', '更新時間（台北）', '有效期限（台北）', '取消時間（台北）',
    '已完成份數', '訂購中份數', '尚待購買份數', '完成時間（台北）']; // C6.2：新增欄位接在最後
  let rmap = new Map();
  try { rmap = require('./demandSettlement').reservedMap(db, storeId, rows.slice(0, MAX_ROWS).map((r) => r.request_uuid)); } catch { rmap = new Map(); }
  const out = rows.slice(0, MAX_ROWS).map((r) => {
    let consent = 'none';
    try { consent = RN.consentState(RN.cycleConsent(db, storeId, r)); } catch { consent = 'none'; }
    let notify = 'none';
    try { notify = RN.requestNotifyState(db, storeId, r.request_uuid); } catch { notify = 'none'; }
    return [r.product_id, String((r.p_line_name || '').trim() || r.p_name || ''), PD.maskUid(r.line_user_id), r.member_display_name || '', Number(r.desired_qty) || 0,
      PREF[r.fulfillment_pref] || r.fulfillment_pref, STATUS[r.eff_status] || r.eff_status, CONSENT[consent] || consent, NOTIFY[notify] || notify,
      twTime(r.created_at), twTime(r.updated_at), twTime(r.expires_at), twTime(r.cancelled_at),
      ...(() => { const qv = require('./demandSettlement').qtyView(r.desired_qty, r.settled_qty, r.eff_status === 'active' ? (rmap.get(String(r.request_uuid)) || 0) : 0);
        return [qv.settled_qty, qv.reserved_qty, r.eff_status === 'active' ? qv.to_buy_qty : 0, twTime(r.completed_at)]; })()];
  });
  return { csv: toCsv(header, out), count: out.length, truncated };
}

module.exports = { exportSummary, exportDetails, MAX_ROWS };
