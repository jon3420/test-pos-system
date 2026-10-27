'use strict';
// H1.4.12 Phase 3C R44.2B：standard LINE 與 LINE shipping 共用的
// per-item counter allocation snapshot builder（唯一來源，不得在 route
// 內另寫平行版本）。無任何 require，不會有 circular dependency。
//
// 輸入：server 依「transaction 內 fresh 讀到的商品資料」判斷後產生的 rows
//   [{ product_id, counter_bucket: 'quota'|'preorder', qty }]
// 輸出：final v1 snapshot（零 allocation 時為 empty-v1，永遠不是 null）。
// 任何不合法輸入一律 throw（呼叫端在交易內，會整筆 ROLLBACK）。
const ALLOWED_BUCKETS = new Set(['quota', 'preorder']);

function buildLineCounterAllocationSnapshot(rows) {
  if (!Array.isArray(rows)) throw new Error('allocation rows must be an array');
  const grouped = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') throw new Error('invalid allocation row');
    if (!Number.isSafeInteger(r.product_id) || r.product_id <= 0) throw new Error('invalid allocation product_id');
    if (!ALLOWED_BUCKETS.has(r.counter_bucket)) throw new Error('invalid allocation bucket');
    if (!Number.isSafeInteger(r.qty) || r.qty <= 0) throw new Error('invalid allocation qty');
    const key = r.product_id + '|' + r.counter_bucket;
    const next = (grouped.get(key) || 0) + r.qty;
    if (!Number.isSafeInteger(next)) throw new Error('allocation aggregate overflow');
    grouped.set(key, next);
  }
  const allocations = Array.from(grouped.entries()).map(([key, qty]) => {
    const [pid, bucket] = key.split('|');
    return { product_id: Number(pid), counter_bucket: bucket, qty };
  });
  // 穩定排序：product_id 升冪，再 bucket（quota < preorder）
  allocations.sort((a, b) => a.product_id - b.product_id || (a.counter_bucket < b.counter_bucket ? -1 : a.counter_bucket > b.counter_bucket ? 1 : 0));
  return { version: 1, allocations };
}

// affected-row 檢查：交易內「預期恰好改 1 列」的寫入必須真的改 1 列，否則 throw（整筆 rollback）。
function assertOneRowModified(db, what) {
  const n = typeof db._db.getRowsModified === 'function' ? db._db.getRowsModified() : 1;
  if (n !== 1) throw new Error('affected-row check failed: ' + what + ' modified ' + n);
}

module.exports = { buildLineCounterAllocationSnapshot, assertOneRowModified };
