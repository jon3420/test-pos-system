// scripts/lib/mbv2-seed.js — R54.4-MBV2 測試種子資料（只寫入暫存資料庫）
'use strict';
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function run(db, sql, params) { db.run(sql, params || []); }

// 台北時間邊界測試用的訂單建立時間
const ORDER_TIMES = [
  ['O-0930-2359', '2026-09-30 23:59:59', 'pos'],   // 9 月（不在 10 月範圍）
  ['O-1001-0000', '2026-10-01 00:00:05', 'pos'],   // 10/01 開始邊界
  ['O-1001-ISOZ', '2026-09-30T16:30:00Z', 'pos'],  // UTC 9/30 16:30 = 台北 10/01 00:30（不可漏）
  ['O-1015-LINE', '2026-10-15 12:00:00', 'line'],  // LINE 訂單
  ['O-1020-REFD', '2026-10-20 18:00:00', 'line'],  // 已退款
  ['O-1031-2359', '2026-10-31 23:59:59', 'pos'],   // 10/31 結束邊界
  ['O-1101-0000', '2026-11-01 00:00:00', 'pos'],   // 11 月（不在 10 月範圍）
  ['O-1109-VOID', '2026-11-09 09:00:00', 'pos'],   // 作廢
];

function seedStore001(db) {
  run(db, `INSERT INTO settings (store_id,key,value) VALUES ('store_001','pos_password',?)`, [sha('pw001')]);
  run(db, `INSERT OR REPLACE INTO settings (store_id,key,value) VALUES ('store_001','store_display_name','脆豬腰測試'),('store_001','line_channel_secret','SECRET-AAA')`);
  run(db, `INSERT INTO stores (store_id, store_name, contact_name, plan, active) VALUES ('store_002','第二店','店長','pro',1)`);
  run(db, `INSERT INTO settings (store_id,key,value) VALUES ('store_002','pos_password',?)`, [sha('pw002')]);
  // 分類／商品
  run(db, `INSERT INTO categories (id,store_id,name,icon,sort_order) VALUES (101,'store_001','飯類','🍚',1),(102,'store_001','麵類','🍜',2)`);
  run(db, `INSERT INTO products (id,store_id,name,category,category_id,price,product_barcode,image,line_image_url,current_stock_grams,sort_order)
           VALUES (201,'store_001','脆豬腰飯','飯類',101,120,'BC-201','/uploads/a.jpg','',5000,1),
                  (202,'store_001','麻油麵線','麵類',102,90,'','', '/uploads/b.jpg',0,2),
                  (203,'store_001','滷蛋','飯類',101,15,'','','',0,3)`);
  run(db, `INSERT INTO product_analysis_groups (id,store_id,group_name,sort_order) VALUES (301,'store_001','主餐',1)`);
  run(db, `INSERT INTO product_analysis_group_items (store_id,group_id,product_id,product_name) VALUES ('store_001',301,201,'脆豬腰飯')`);
  // 食材
  run(db, `INSERT INTO ingredients (id,store_id,name,unit,total_stock,frozen_stock) VALUES (401,'store_001','豬腰','g',8000,8000),(402,'store_001','麵線','g',3000,0)`);
  run(db, `INSERT INTO product_ingredient_formulas (product_id,ingredient_id,amount_per_unit) VALUES (201,401,150),(202,402,100)`);
  run(db, `INSERT INTO ingredient_batches (ingredient_id,batch_no,purchase_date,quantity,unit,created_at) VALUES (401,'B1','2026-10-01',8000,'g','2026-10-01 08:00:00')`);
  run(db, `INSERT INTO ingredient_logs (ingredient_id,ingredient_name,log_type,change_amount,created_at) VALUES
           (401,'豬腰','purchase',8000,'2026-10-01 08:00:00'),(401,'豬腰','consume',-150,'2026-10-02 12:00:00'),(402,'麵線','scrap',-50,'2026-10-03 21:00:00')`);
  run(db, `INSERT INTO inventory_logs (store_id,product_id,product_name,action,change_grams,after_grams,created_at) VALUES ('store_001',201,'脆豬腰飯','adjust',100,5000,'2026-10-05 10:00:00')`);
  // 折扣
  run(db, `INSERT INTO coupons (id,store_id,code,name,discount_type,discount_value,enabled) VALUES (501,'store_001','OCT10','十月折10','amount',10,1)`);
  run(db, `CREATE TABLE IF NOT EXISTS discount_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL DEFAULT 'store_001', code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#94a3b8', enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  run(db, `INSERT INTO discount_categories (store_id,code,name) VALUES ('store_001','staff','員工折扣')`);
  // 訂單
  let i = 0;
  for (const [num, at, source] of ORDER_TIMES) {
    i++;
    const id = `uuid-${num}`;
    const refunded = num.endsWith('REFD'), voided = num.endsWith('VOID');
    run(db, `INSERT INTO orders (id,order_number,store_id,customer_name,customer_phone,items,payment_method,subtotal,total,status,order_status,source,created_at,updated_at,
              refund_status,refund_note,refunded_at,void_reason,voided_at,coupon_code,line_user_id,uuid,note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, num, 'store_001', '客人' + i, '09120000' + String(i).padStart(2, '0'), JSON.stringify([{ id: 201, name: '脆豬腰飯', qty: 1, price: 120 }]), 'cash', 120, 120,
        voided ? 'void' : 'completed', voided ? 'void' : 'completed', source, at, at,
        refunded ? 'refunded' : '', refunded ? '客訴退款' : '', refunded ? '2026-10-21 10:00:00' : '', voided ? '打錯單' : '', voided ? '2026-11-09 09:05:00' : '',
        num === 'O-1015-LINE' ? 'OCT10' : '', source === 'line' ? 'U-line-1' : '', id, '']);
    run(db, `INSERT INTO order_logs (store_id,order_id,order_number,action,reason,before_total,after_total,created_at) VALUES ('store_001',?,?,?,?,?,?,?)`,
      [id, num, 'create', '建立', 0, 120, at]);
  }
  run(db, `INSERT INTO coupon_redemptions (store_id,coupon_id,coupon_code,order_id,order_number,discount_amount,created_at) VALUES ('store_001',501,'OCT10','uuid-O-1015-LINE','O-1015-LINE',10,'2026-10-15 12:00:00')`);
  // LINE 會員
  run(db, `INSERT INTO line_members (id,store_id,line_user_id,display_name,is_friend,first_product_id,order_count,phone) VALUES (601,'store_001','U-line-1','小明',1,201,2,'0912000004'),(602,'store_001','U-line-2','小華',0,NULL,0,'')`);
  run(db, `INSERT INTO line_member_tags (store_id,line_user_id,tag_code,tag_name) VALUES ('store_001','U-line-1','vip','VIP')`);
  run(db, `INSERT INTO line_member_history (store_id,line_user_id,event_name,old_value,new_value,metadata_json,created_at) VALUES
           ('store_001','U-line-1','friend_added','0','1','{"access_token":"tok","x":1}','2026-10-01 01:00:00'),
           ('store_001','U-line-1','order','','O-1015-LINE','{}','2026-10-15 04:00:00')`);
  run(db, `INSERT INTO line_member_order_links (store_id,line_user_id,order_id) VALUES ('store_001','U-line-1','uuid-O-1015-LINE')`);
  run(db, `INSERT INTO line_friend_events (store_id,line_user_id,member_id,event_type,source,event_at) VALUES ('store_001','U-line-1',601,'follow','webhook','2026-10-01 01:00:00')`);
  // Analytics（created_at 以 UTC 儲存）
  run(db, `INSERT INTO analytics_events (store_id,visitor_id,session_id,event_name,product_id,created_at) VALUES
           ('store_001','v1','s1','view_item',201,'2026-09-30 16:10:00'),
           ('store_001','v1','s1','add_to_cart',201,'2026-09-30 15:59:59'),
           ('store_001','v1','s1','submit_order',NULL,'2026-10-15 04:00:00'),
           ('store_001','v2','s2','view_item',202,'2026-10-31 16:00:00')`);
  run(db, `UPDATE analytics_events SET order_id='uuid-O-1015-LINE' WHERE event_name='submit_order'`);
  run(db, `INSERT INTO geo_visit_log (store_id,visitor_id,session_id,event_name,event_time,city) VALUES ('store_001','v1','s1','page_view','2026-10-15T04:00:00.000Z','台北市')`);
  // 快閃
  run(db, `INSERT INTO popup_locations (id,store_id,name,address,active) VALUES ('loc-1','store_001','中壢火車站','桃園市中壢區',1)`);
  run(db, `INSERT INTO popup_campaigns (id,store_id,public_code,name,status) VALUES ('camp-1','store_001','PUBCAMP001','十月快閃','published')`);
  run(db, `INSERT INTO popup_sessions (id,store_id,campaign_id,public_code,name,pickup_date,location_id,status) VALUES ('sess-1','store_001','camp-1','PUBSESS001','中壢場','2026-10-20','loc-1','published')`);
  run(db, `INSERT INTO popup_session_products (store_id,session_id,product_id,enabled,quota_qty) VALUES ('store_001','sess-1',201,1,30)`);
  run(db, `INSERT INTO popup_session_product_sales (store_id,session_id,product_id,sale_enabled,stock_mode,stock_total,per_order_limit) VALUES ('store_001','sess-1',201,1,'limited',30,3)`);
  run(db, `INSERT INTO popup_order_allocations (store_id,session_id,order_id,product_id,qty,status) VALUES ('store_001','sess-1','uuid-O-1020-REFD',201,1,'released')`);
  // 系統設定與其他
  run(db, `INSERT INTO delivery_platforms (store_id,name,commission_rate) VALUES ('store_001','UberEats',0.3)`);
  run(db, `INSERT INTO store_business_calendar (store_id,start_date,end_date,mode,reason) VALUES ('store_001','2026-10-10','2026-10-10','closed','國慶')`);
  run(db, `INSERT OR IGNORE INTO payment_gateways (store_id,name,code) VALUES ('store_001','綠界','ecpay')`);
  run(db, `UPDATE payment_gateways SET api_key='KEY-XYZ', secret_key='SEC-XYZ' WHERE store_id='store_001' AND code='ecpay'`);
  run(db, `INSERT INTO customers (store_id,name,phone) VALUES ('store_001','常客','0988000000')`);
  // store_002（跨店隔離用）
  run(db, `INSERT INTO products (store_id,name,category,price) VALUES ('store_002','脆豬腰飯','飯類',130)`);
  run(db, `INSERT INTO orders (id,order_number,store_id,items,subtotal,total,status,source,created_at) VALUES ('uuid-S2-0001','S2-0001','store_002','[]',50,50,'completed','pos','2026-10-02 10:00:00')`);
}

module.exports = { seedStore001, ORDER_TIMES, sha };
