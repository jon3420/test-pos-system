/* license.js — fix10：授權管理僅 system-admin 使用
 *
 * fix10 變更：
 *   - 移除 ADMIN_MODE 邏輯
 *   - 一般 POS 後台完全看不到授權管理（由 index.html 控制 display:none）
 *   - 授權管理 UI 只存在於 /system-admin（system-admin.html）
 *   - 此 license.js 僅提供 showNotAuthorized() 共用函式供 app.js 呼叫
 */

// 顯示「功能未授權」訊息（供 app.js 前端 Feature Gate 呼叫）
function showNotAuthorized(featureName) {
  const msg = `${featureName || '此功能'}尚未授權，請聯絡系統管理員升級方案。`;
  if (typeof showToast === 'function') showToast(msg, 'error');
  return msg;
}
