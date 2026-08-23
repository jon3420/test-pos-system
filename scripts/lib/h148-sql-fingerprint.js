'use strict';
// scripts/lib/h148-sql-fingerprint.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8-CHECKOUT-ANALYTICS-UNIFICATION
//
// Test-only SQL fingerprint helpers, shared between run-h1-4-8-scale-child.js
// and its parent's invariance/discrimination assertions. Not a production
// module; does not modify any production SQL.

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

// 保留 table 名、JOIN、WHERE predicate、operator、SELECT 欄位、GROUP/ORDER BY
// 等一切結構；只把 IN (?,?,?...) 的 placeholder 數量正規化成 <N>（N 是實際
// 數量），讓「同一種查詢形狀、只是 IN-list 長度不同」可以被辨識為同一組，
// 但仍保留 arity 供人工核對。
function shapeFingerprint(sql) {
  return normSql(sql).replace(/in \([^)]*\)/g, (m) => `in (<${(m.match(/\?/g) || []).length}>)`);
}

// 完全通用版：IN (...) 一律收斂成 IN (<N>)（不保留實際數量），專供跨 case
// （例如 D3 vs D53 vs D1200，或 E1 vs E40）比較「查詢形狀＋執行次數」是否
// 相同，不比較 IN-list 實際長度。只正規化 IN (...) 這一個結構；table 名、
// JOIN、WHERE predicate、operator（=／IN／LIKE...）、SELECT 欄位、GROUP BY／
// ORDER BY 一律原樣保留，不會被這個函式抹除或混淆。
function genericShapeFingerprint(sql) {
  return normSql(sql).replace(/in \([^)]*\)/g, 'in (<N>)');
}

module.exports = { normSql, shapeFingerprint, genericShapeFingerprint };
