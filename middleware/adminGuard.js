// middleware/adminGuard.js — 管理員模式保護 (v18-r1-fix2)
//
// ADMIN_MODE=true  → 允許 license CRUD（POST/PUT/DELETE /api/license）
// ADMIN_MODE=false → 拒絕 CRUD，只允許 GET（Android 查詢授權）

function requireAdminMode(req, res, next) {
  if (process.env.ADMIN_MODE === 'true') return next();
  return res.status(403).json({
    success: false,
    message: '此操作需要管理員模式，請設定 ADMIN_MODE=true 後重啟服務'
  });
}

module.exports = { requireAdminMode };
