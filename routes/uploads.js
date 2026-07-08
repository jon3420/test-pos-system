// routes/uploads.js — fix18-10-hotfix19：通用圖片上傳 API
//
// 目前專案原本沒有任何圖片上傳 API（商品圖片 / LINE 圖片 / 公告圖片皆為純網址輸入框）。
// 依需求文件指示「若沒有，請使用現有 uploads 架構建立通用圖片上傳 API」，
// 本檔案新增一支通用、與商品/公告皆無耦合的圖片上傳端點，供各處「上傳圖片」按鈕共用，
// 不新增重複 API、不影響既有以網址輸入圖片的既有商品圖片欄位（該欄位仍可直接貼網址）。
'use strict';

const express = require('express');
const router  = express.Router();
const fs   = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '../public/uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

const ALLOWED_MIME = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
};
const MAX_BYTES = 4 * 1024 * 1024; // 4MB（body-parser 上限 5MB，留餘裕給 JSON 包裝）

// POST /api/uploads/image — body: { image_base64: "data:image/png;base64,...." }
// 回傳 { success, url }（url 為可直接使用的相對路徑，如 /uploads/xxx.png）
router.post('/image', (req, res) => {
  try {
    const storeId = req.storeId || 'store_001';
    const dataUrl = req.body && req.body.image_base64;
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ success: false, message: '缺少 image_base64' });
    }
    const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ success: false, message: '圖片格式錯誤，需為 base64 data URL' });
    }
    const mime = match[1];
    const ext = ALLOWED_MIME[mime];
    if (!ext) {
      return res.status(400).json({ success: false, message: `不支援的圖片格式：${mime}` });
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ success: false, message: '圖片檔案過大（上限 4MB）' });
    }
    const safeStoreId = String(storeId).replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `${safeStoreId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    res.json({ success: true, url: `/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
