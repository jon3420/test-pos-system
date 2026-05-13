const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

router.get('/', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/', (req, res) => {
  try {
    const db      = getDb();
    const allowed = [
      'shop_name', 'n8n_webhook_url', 'line_channel_token', 'tax_rate', 'receipt_footer',
      // 印表機設定
      'printer_enabled', 'printer_type',
      'printer_ip',      'printer_port',
      'printer_name',       // Windows 顯示名稱（用於識別）
      'printer_share_name', // Windows 共享名稱（例如 XP80，用於 copy /b）
      'auto_print',      'auto_drawer',
    ];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        const ex = db.get('SELECT key FROM settings WHERE key=?', [k]);
        if (ex) db.run('UPDATE settings SET value=? WHERE key=?', [String(req.body[k]), k]);
        else    db.run('INSERT INTO settings (key,value) VALUES (?,?)', [k, String(req.body[k])]);
      }
    });
    const rows = db.all('SELECT key, value FROM settings');
    const s    = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: s });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
