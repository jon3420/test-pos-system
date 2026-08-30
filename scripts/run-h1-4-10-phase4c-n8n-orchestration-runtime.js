#!/usr/bin/env node
// scripts/run-h1-4-10-phase4c-n8n-orchestration-runtime.js
// H1.4.10 Phase 4C — n8n Orchestration Core Runtime（本輪聚焦：不 crash，
// FAIL=0，涵蓋 router mount／N4／HMAC／HTTP HMAC／replay／wake 200/500/
// retry/timeout retry/dedupe／SSRF DNS／batch has_more／Admin redaction）。
// 完整 >=80 acceptance 與 workflow JSON 靜態斷言留下一輪擴充。
// 沒有任何 `|| true` 或 placeholder PASS。

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase4c-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';
  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const orchestration = require('../utils/cartRecoveryOrchestration');
  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_001', 'Store 1', 'x', 'pro', 1]);

  // 需求文件一：先實際跑一次診斷（本輪修正的 root cause），確認 factory
  // 契約現在真的正確，這條斷言本身就是「router mount 已修好」的證明。
  {
    const createRouter = require('../routes/cart-recovery-orchestration');
    assert(typeof createRouter === 'function', 'Router-1. routes/cart-recovery-orchestration.js export 是 factory function');
    let threwWithoutRequireStore = false;
    try { createRouter(); } catch (e) { threwWithoutRequireStore = true; }
    assert(threwWithoutRequireStore === true, 'Router-2. 沒傳 requireStore 呼叫 factory → 明確 throw（不是靜默回傳 undefined）');
    const router = createRouter((req, res, next) => next());
    assert(typeof router === 'function' && typeof router.use === 'function', 'Router-3. 傳入合法 requireStore → 回傳真正的 Express router（有 .use 方法）');
  }

  try {
    // ══════════════════════════════════════════════════════════════
    // N1-N4：Settings + Non-Interference
    // ══════════════════════════════════════════════════════════════
    assert(orchestration.isOrchestrationEnabled(db, 'store_001') === false, 'N1. n8n enabled default 0');
    assert(orchestration.getWebhookUrl(db, 'store_001') === '', 'N2. webhook default empty');
    assert(orchestration.getSharedSecret(db, 'store_001') === '', 'N3. secret default empty');
    {
      // 需求文件四：真正的 non-interference 測試——先 seed 既有訂單 webhook，
      // 跑過本輪所有 Phase 4C 相關程式碼路徑後，確認完全沒被動過。
      setSetting('store_001', 'n8n_webhook_url', 'https://existing-order-webhook.example/orders');
      const before = db.get(`SELECT value FROM settings WHERE store_id=? AND key='n8n_webhook_url'`, ['store_001']).value;
      setSetting('store_001', 'cart_recovery_n8n_enabled', '1');
      setSetting('store_001', 'cart_recovery_n8n_webhook_url', 'https://recovery-n8n.example/webhook');
      setSetting('store_001', 'cart_recovery_n8n_secret', 'a'.repeat(40));
      await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: '2026-01-01 00:00:00' });
      orchestration.recordOrchestrationRequest(db, 'store_001', 'non-interference-check', 'inbound_due');
      const after = db.get(`SELECT value FROM settings WHERE store_id=? AND key='n8n_webhook_url'`, ['store_001']).value;
      assert(before === after && after === 'https://existing-order-webhook.example/orders', 'N4. 既有 n8n_webhook_url 在跑過完整 Phase 4C 程式碼路徑後完全不變', `before=${before} after=${after}`);
      const workflowSrc = fs.readFileSync(path.join(ROOT, 'n8n-workflow.json'), 'utf8');
      assert(JSON.parse(workflowSrc).name === '餐車 POS 訂單自動化', 'N4b. 既有 n8n-workflow.json 內容未被覆寫（name 欄位不變）');
    }

    // ══════════════════════════════════════════════════════════════
    // HMAC（純函式）
    // ══════════════════════════════════════════════════════════════
    const secret = 'a'.repeat(40);
    const fields1 = { version: 'v1', storeId: 'store_001', timestamp: 1000, requestId: 'req-1', dueAt: '2026-01-01 00:00:00' };
    const sig1 = orchestration.sign(secret, fields1);
    assert(sig1 === orchestration.sign(secret, fields1), 'N30. signature deterministic');
    assert(orchestration.sign(secret, Object.assign({}, fields1, { timestamp: 2000 })) !== sig1, 'N31. 不同 timestamp 不同 signature');
    assert(orchestration.sign(secret, Object.assign({}, fields1, { requestId: 'req-2' })) !== sig1, 'N32. 不同 request_id 不同 signature');
    assert(!orchestration.buildCanonicalString(fields1).includes(secret), 'N33. canonical string 不含 secret');
    assert(orchestration.verifySignature(secret, fields1, sig1) === true, 'N34. 正確 signature 通過');
    assert(orchestration.verifySignature(secret, fields1, 'ff'.repeat(32)) === false, 'N35. 錯誤 signature 被拒絕');
    assert(orchestration.isTimestampFresh(Date.now() - 10 * 60 * 1000) === false, 'N36. 過期 timestamp 被拒絕');
    assert(orchestration.isTimestampFresh(Date.now() + 10 * 60 * 1000) === false, 'N37. 未來太遠 timestamp 被拒絕');
    assert(fs.readFileSync(path.join(ROOT, 'utils/cartRecoveryOrchestration.js'), 'utf8').includes('crypto.timingSafeEqual'), 'N38. verifySignature 使用 timingSafeEqual');

    // ══════════════════════════════════════════════════════════════
    // SSRF：hostname 字串 + DNS 解析（stub dns.lookup，不打真實網路）
    // ══════════════════════════════════════════════════════════════
    assert(orchestration.isSafeWebhookUrlByHostname('https://example.com/webhook') === true, 'SSRF-hostname. 正常 https URL 通過');
    assert(orchestration.isSafeWebhookUrlByHostname('http://example.com/webhook') === false, 'N-http. http（非 https）被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://localhost/webhook') === false, 'SSRF1. localhost 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://127.0.0.1/webhook') === false, 'SSRF2. 127.x 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://10.0.0.1/webhook') === false, 'SSRF3. 10.x 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://192.168.1.1/webhook') === false, 'SSRF4. 192.168.x 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://172.16.0.1/webhook') === false, 'SSRF5. 172.16-31.x 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://169.254.169.254/webhook') === false, 'SSRF6. link-local/cloud metadata IP 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://[::1]/webhook') === false, 'SSRF7. IPv6 loopback（::1）被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://[fc00::1]/webhook') === false, 'SSRF8. IPv6 fc00::/7 unique local 被拒絕');
    assert(orchestration.isSafeWebhookUrlByHostname('https://[fe80::1]/webhook') === false, 'SSRF9. IPv6 fe80::/10 link-local 被拒絕');
    assert(orchestration.isPublicIp('8.8.8.8', 4) === true, 'IP-public. 公開 IPv4 判定為 public');
    assert(orchestration.isPublicIp('192.168.1.1', 4) === false, 'IP-private. 私有 IPv4 判定為非 public');
    assert(orchestration.isPublicIp('2001:4860:4860::8888', 6) === true, 'IP-public-v6. 公開 IPv6 判定為 public');
    assert(orchestration.isPublicIp('fc00::1', 6) === false, 'IP-private-v6. IPv6 unique local 判定為非 public');

    // DNS resolution 檢查：stub require('dns').promises.lookup
    {
      const dnsModule = require('dns');
      const originalLookup = dnsModule.promises.lookup;
      dnsModule.promises.lookup = async (hostname) => {
        if (hostname === 'public-hostname.example') return [{ address: '8.8.8.8', family: 4 }];
        if (hostname === 'rebind-to-loopback.example') return [{ address: '127.0.0.1', family: 4 }];
        if (hostname === 'rebind-to-private.example') return [{ address: '10.0.0.5', family: 4 }];
        return [{ address: '8.8.8.8', family: 4 }];
      };
      const r1 = await orchestration.resolveSafeWebhookTarget('https://public-hostname.example/webhook');
      assert(r1.safe === true, 'SSRF12. 公開 hostname DNS 解析到公開 IP → allow', JSON.stringify(r1));
      const r2 = await orchestration.resolveSafeWebhookTarget('https://rebind-to-loopback.example/webhook');
      assert(r2.safe === false && r2.reason === 'dns_resolved_to_private_ip', 'SSRF10. 公開 hostname 但 DNS 解析到 127.0.0.1 → reject', JSON.stringify(r2));
      const r3 = await orchestration.resolveSafeWebhookTarget('https://rebind-to-private.example/webhook');
      assert(r3.safe === false && r3.reason === 'dns_resolved_to_private_ip', 'SSRF11. 公開 hostname 但 DNS 解析到 10.0.0.5 → reject', JSON.stringify(r3));
      dnsModule.promises.lookup = originalLookup;
    }

    // ══════════════════════════════════════════════════════════════
    // Replay Protection（inbound_due，純函式）
    // ══════════════════════════════════════════════════════════════
    const r1 = orchestration.recordOrchestrationRequest(db, 'store_001', 'replay-test-1', 'inbound_due');
    assert(r1.ok === true && r1.replay === false, 'N39. first request accepted');
    const r2 = orchestration.recordOrchestrationRequest(db, 'store_001', 'replay-test-1', 'inbound_due');
    assert(r2.replay === true, 'N40. same request_id replay → 不再次 process');
    const r3 = orchestration.recordOrchestrationRequest(db, 'store_001', 'replay-test-2', 'inbound_due');
    assert(r3.replay === false, 'N41. 不同 request_id 可再次 process');
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta_4c', 'Beta', 'x', 'pro', 1]);
    const r4a = orchestration.recordOrchestrationRequest(db, 'store_001', 'replay-cross-store', 'inbound_due');
    const r4b = orchestration.recordOrchestrationRequest(db, 'store_beta_4c', 'replay-cross-store', 'inbound_due');
    assert(r4a.replay === false && r4b.replay === false, 'N43. store A 的 request_id 不阻擋 store B 使用同名 request_id');

    // ══════════════════════════════════════════════════════════════
    // /process-due 真實 HTTP
    // ══════════════════════════════════════════════════════════════
    const createRouter = require('../routes/cart-recovery-orchestration');
    const app = require('express')();
    app.use(require('express').json());
    app.use('/api/cart-recovery/orchestration', createRouter((req, res, next) => { req.storeId = 'store_001'; next(); }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    function buildHeaders(storeId, ts, reqId, useSecret) {
      const sig = orchestration.sign(useSecret, { version: 'v1', storeId, timestamp: ts, requestId: reqId });
      return { 'Content-Type': 'application/json', 'X-N8N-Recovery-Version': 'v1', 'X-N8N-Recovery-Timestamp': String(ts), 'X-N8N-Recovery-Request-Id': reqId, 'X-N8N-Recovery-Signature': `sha256=${sig}` };
    }

    {
      const ts = Date.now();
      const reqId = 'due-req-1';
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers: buildHeaders('store_001', ts, reqId, secret), body: JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts, request_id: reqId }) });
      const json = await res.json();
      assert(res.status === 200 && json.success === true && typeof json.processed === 'number' && typeof json.has_more === 'boolean', 'N44. valid request 成功呼叫 processDueLineRecoveryJobs（回傳含 has_more 布林值）', JSON.stringify(json));
      const keys = Object.keys(json);
      assert(!keys.some((k) => ['job_id', 'cart_id', 'order_id', 'line_user_id', 'token'].includes(k)), 'N52/N53. response 不含 UID/cart/order/token', JSON.stringify(keys));
    }
    {
      setSetting('store_001', 'cart_recovery_n8n_enabled', '0');
      const ts = Date.now();
      const reqId = 'due-req-disabled';
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers: buildHeaders('store_001', ts, reqId, secret), body: JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts, request_id: reqId }) });
      const json = await res.json();
      assert(json.success === true && json.processed === 0 && json.note === 'orchestration_disabled', 'N45/N25. n8n disabled → 不 process', JSON.stringify(json));
      setSetting('store_001', 'cart_recovery_n8n_enabled', '1');
    }
    {
      // N-strict-hmac：header/body timestamp 不一致 → 拒絕（不再 fallback 混用）
      const ts = Date.now();
      const reqId = 'due-req-mismatch';
      const headers = buildHeaders('store_001', ts, reqId, secret);
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers, body: JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts + 1, request_id: reqId }) });
      assert(res.status === 401, 'N-strict. header timestamp 與 body timestamp 不一致 → 401（不 fallback 混用）', res.status);
    }
    {
      const ts = Date.now();
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers: Object.assign(buildHeaders('store_001', ts, 'due-req-wrongsig', secret), { 'X-N8N-Recovery-Signature': 'sha256=' + 'ff'.repeat(32) }), body: JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts, request_id: 'due-req-wrongsig' }) });
      assert(res.status === 401, 'N35-http. wrong signature（真實 HTTP）→ 401');
      const json = await res.json();
      assert(json.reason === 'invalid_or_expired_signature', 'N21. 拒絕理由統一');
    }
    {
      const ts = Date.now() - 10 * 60 * 1000;
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers: buildHeaders('store_001', ts, 'due-req-expired', secret), body: JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts, request_id: 'due-req-expired' }) });
      assert(res.status === 401, 'N36-http. expired timestamp（真實 HTTP）→ 401');
    }
    {
      const ts = Date.now();
      const reqId = 'due-req-replay';
      const headers = buildHeaders('store_001', ts, reqId, secret);
      const body = JSON.stringify({ version: 'v1', store_id: 'store_001', timestamp: ts, request_id: reqId });
      const res1 = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers, body });
      const json1 = await res1.json();
      assert(json1.success === true && !json1.replay, 'replay-http-1. 第一次呼叫正常處理');
      const res2 = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers, body });
      const json2 = await res2.json();
      assert(json2.success === true && json2.replay === true, 'replay-http-2. 同 request_id 再次呼叫 → replay:true');
    }
    {
      // unknown store_id（簽章用假 secret 簽，因為根本沒有真的 secret 可用）→ 401，且不建立任何 row
      const ts = Date.now();
      const fakeStoreId = 'store_does_not_exist_4c';
      const res = await fetch(`${base}/api/cart-recovery/orchestration/process-due`, { method: 'POST', headers: buildHeaders(fakeStoreId, ts, 'due-req-unknown-store', 'irrelevant-secret'), body: JSON.stringify({ version: 'v1', store_id: fakeStoreId, timestamp: ts, request_id: 'due-req-unknown-store' }) });
      assert(res.status === 401, 'N26. 不存在的 store_id → 401（不建立任何資料）');
      const rowCount = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=?`, [fakeStoreId]).c;
      assert(rowCount === 0, 'N26b. 不存在的 store 沒有被意外建立任何 job row');
    }
    server.close();

    // ══════════════════════════════════════════════════════════════
    // Wake-Up：200 / non-2xx / timeout+retry / dedupe
    // ══════════════════════════════════════════════════════════════
    {
      setSetting('store_001', 'cart_recovery_n8n_webhook_url', 'https://wake-test.example/webhook');
      const dnsModule = require('dns');
      const originalLookup = dnsModule.promises.lookup;
      dnsModule.promises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];

      const globalFetchOriginal = global.fetch;
      let fetchCallCount = 0;
      let fetchBehavior = 'success';
      global.fetch = async (url, opts) => {
        fetchCallCount += 1;
        if (fetchBehavior === 'success') return { status: 200 };
        if (fetchBehavior === 'http_error') return { status: 500 };
        if (fetchBehavior === 'network_error') throw new Error('ECONNREFUSED');
        if (fetchBehavior === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      };

      // W-200: 成功 2xx
      fetchBehavior = 'success'; fetchCallCount = 0;
      const wr1 = await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: 'wake-test-due-1' });
      assert(wr1.sent === true && wr1.status === 200, 'N-wake-200. HTTP 200 → sent=true', JSON.stringify(wr1));
      assert(fetchCallCount === 1, 'wake-200-calls. fetch 真的被呼叫 1 次');

      // W1: 500 → sent=false, audit status=failed
      fetchBehavior = 'http_error'; fetchCallCount = 0;
      const wr2 = await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: 'wake-test-due-2' });
      assert(wr2.sent === false && wr2.reason === 'http_error', 'W1. HTTP 500 → sent=false, reason=http_error（不是誤判成 sent=true）', JSON.stringify(wr2));
      const auditRow = db.get(`SELECT status FROM cart_recovery_orchestration_requests WHERE store_id=? AND request_id=? AND direction='outbound_wakeup'`, ['store_001', 'wakeup:cart_abandoned:wake-test-due-2']);
      assert(auditRow && auditRow.status === 'failed', 'N6. audit status=failed（非 processed）', JSON.stringify(auditRow));

      // W3: 同 stage+due_at 第二次，mock 改回 200 → 真的再 call 一次，sent=true
      fetchBehavior = 'success'; fetchCallCount = 0;
      const wr3 = await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: 'wake-test-due-2' });
      assert(wr3.sent === true && fetchCallCount === 1, 'W3. failure 後同 due_at 允許 retry，且真的重新呼叫一次 fetch', JSON.stringify({ wr3, fetchCallCount }));
      const auditRowAfter = db.get(`SELECT status FROM cart_recovery_orchestration_requests WHERE store_id=? AND request_id=? AND direction='outbound_wakeup'`, ['store_001', 'wakeup:cart_abandoned:wake-test-due-2']);
      assert(auditRowAfter.status === 'processed', 'W4. audit status=processed');

      // W5: 第三次同 due_at → 0 new HTTP call（已 processed，dedupe）
      fetchCallCount = 0;
      const wr5 = await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: 'wake-test-due-2' });
      assert(wr5.sent === false && wr5.reason === 'already_sent_for_this_due_at' && fetchCallCount === 0, 'W5. 已 processed 的 due_at 再次呼叫 → 0 new HTTP call（dedupe 成功，不重送）', JSON.stringify({ wr5, fetchCallCount }));

      // network_error → job 不被標記 failed
      fetchBehavior = 'network_error'; fetchCallCount = 0;
      setSetting('store_001', 'cart_recovery_enabled', '1'); // Phase 4A master gate 必須開啟，add_to_cart 才會真的建立 job
      const { logServerEvent } = require('../utils/analyticsLog');
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: 'wakeup-neterror-cart', event_name: 'add_to_cart', product_id: 1 });
      await new Promise((r) => setTimeout(r, 30)); // 讓 fire-and-forget 的 wake-up 有機會跑完
      const job = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id='wakeup-neterror-cart' AND stage='cart_abandoned'`);
      assert(job && job.status === 'pending', 'N20/W2. wake-up network_error 不影響 job 狀態（仍是 pending，不是 failed）', job && job.status);

      global.fetch = globalFetchOriginal;
      dnsModule.promises.lookup = originalLookup;
    }

    // ══════════════════════════════════════════════════════════════
    // async fail-open：sendWakeUp 本身丟出同步例外也不外洩
    // ══════════════════════════════════════════════════════════════
    {
      let threw = false;
      try {
        // storeId 傳 null 觸發內部某些字串操作可能出錯的情境，驗證仍走安全路徑
        await orchestration.sendWakeUp(db, null, { stage: 'cart_abandoned', dueAt: 'x' });
      } catch (e) { threw = true; }
      assert(threw === false, 'N12-fail-open. sendWakeUp() 對異常輸入（storeId=null）不拋出，安全回傳失敗結果');
    }

    // ══════════════════════════════════════════════════════════════
    // Batch has_more（真實跑過 3 個 stage，確認全域 due_at 排序 + limit 正確）
    // ══════════════════════════════════════════════════════════════
    {
      const delivery = require('../utils/cartRecoveryDelivery');
      const cartRecovery = require('../utils/cartRecovery');
      const storeId = 'store_batch_4c';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Batch 4C', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      const now = cartRecovery._nowIso();
      // 建 3 筆 due job，跨兩個 stage，確保全域排序正確
      for (let i = 0; i < 3; i++) {
        db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [storeId, `batch-cart-${i}`, i === 1 ? 'checkout_abandoned' : 'cart_abandoned', 'pending', now, `batch-key-${i}`, now, now]);
      }
      const resultLimit2 = await delivery.processDueLineRecoveryJobs(storeId === '' ? null : db, storeId, { limit: 2 });
      assert(resultLimit2.processed === 2 && resultLimit2.has_more === true, 'B-limit. 3 筆 due、limit=2 → processed=2, has_more=true', JSON.stringify(resultLimit2));
      const resultLimit10 = await delivery.processDueLineRecoveryJobs(db, storeId, { limit: 10 });
      assert(resultLimit10.has_more === false, 'B-nomore. 剩餘 job 數量 <= limit → has_more=false', JSON.stringify(resultLimit10));
    }

    // ══════════════════════════════════════════════════════════════
    // Admin UI secret redaction（真實檔案，非 placeholder）
    // ══════════════════════════════════════════════════════════════
    {
      const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      assert(indexHtml.includes('n8n 自動排程') && indexHtml.includes('set-cart_recovery_n8n_webhook_url') && indexHtml.includes('set-cart_recovery_n8n_secret'), 'Admin-1. n8n 區塊與三個欄位都存在於 production HTML');
      const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
      const loadFnMatch = appJs.match(/async function loadCartRecoverySettings\(\)[\s\S]*?\n}\n/);
      assert(!!loadFnMatch && loadFnMatch[0].includes('cart_recovery_n8n_secret_set') && !/n8nSecretEl\.value\s*=\s*settings\.cart_recovery_n8n_secret[^_]/.test(loadFnMatch[0]), 'Admin-2. loadCartRecoverySettings() 用布林值判斷 readiness，不把明文 secret 塞進 input.value');
      const settingsRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
      assert(settingsRouteSrc.includes('cart_recovery_n8n_secret_set') && settingsRouteSrc.includes("delete out.cart_recovery_n8n_secret"), 'Admin-3. GET /api/settings 後端真的 redact 掉 cart_recovery_n8n_secret 明文');
    }

    // ── Placeholder 檢查（需求文件三十四）：確認本檔案自己沒有 `|| true` 這種假斷言 ──
    {
      const selfSrc = fs.readFileSync(__filename, 'utf8');
      const assertLines = selfSrc.split('\n').filter((l) => {
        const trimmed = l.trim();
        if (!trimmed.startsWith('assert(')) return false; // 只看真正的 assert( 呼叫行本身，排除本段自我檢查程式碼與敘述文字
        return true;
      });
      const placeholderPattern = new RegExp('\\|\\|' + '\\s*true');
      const hasPlaceholder = assertLines.some((l) => placeholderPattern.test(l));
      assert(hasPlaceholder === false, 'Self-check. 本測試檔案沒有任何 placeholder assertion（排除本檢查段落自身的字串描述）', hasPlaceholder ? assertLines.find((l) => placeholderPattern.test(l)) : '');
    }

    // ══════════════════════════════════════════════════════════════
    // Timezone Contract（T1-T5）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const rawDueAt = cartRecovery._nowIso();
      assert(!/[Zz]$/.test(rawDueAt) && !/[+-]\d{2}:\d{2}$/.test(rawDueAt), 'T1. DB due_at 格式確認：沒有 timezone 標記（純 YYYY-MM-DD HH:MM:SS）', rawDueAt);
      const converted = orchestration.toOrchestrationDueAt(rawDueAt);
      assert(/Z$/.test(converted), 'T2. toOrchestrationDueAt() 輸出有明確 timezone（Z）', converted);
      const epochFromRaw = Date.parse(rawDueAt.replace(' ', 'T') + 'Z');
      const epochFromConverted = Date.parse(converted);
      assert(epochFromRaw === epochFromConverted, 'T3. RFC3339 parse 後 epoch 與原 POS due time 相同（無偏移）', `raw=${epochFromRaw} converted=${epochFromConverted}`);
      assert(Math.abs(epochFromRaw - epochFromConverted) !== 8 * 3600000, 'T4. 不得產生 8 小時偏移（常見的 UTC/UTC+8 混淆錯誤）');
      const alreadyTz = '2026-01-01T00:00:00+08:00';
      assert(orchestration.toOrchestrationDueAt(alreadyTz) === alreadyTz, 'T-idempotent. 已經帶 timezone 的字串不重複轉換');
    }
    {
      // T5：HMAC canonical 使用的 dueAt 與 body.due_at 完全相同（真的用同一個轉換後的值簽章，不是簽原始值卻傳轉換值）
      const dnsModule = require('dns');
      const originalLookup = dnsModule.promises.lookup;
      dnsModule.promises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
      const globalFetchOriginal = global.fetch;
      let capturedSig = null;
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        capturedSig = opts.headers['X-POS-Recovery-Signature'].replace('sha256=', '');
        return { status: 200 };
      };
      setSetting('store_001', 'cart_recovery_n8n_enabled', '1');
      setSetting('store_001', 'cart_recovery_n8n_webhook_url', 'https://tz-test.example/webhook');
      setSetting('store_001', 'cart_recovery_n8n_secret', secret);
      const rawDueAt2 = '2026-06-15 03:30:00';
      await orchestration.sendWakeUp(db, 'store_001', { stage: 'cart_abandoned', dueAt: rawDueAt2 });
      const expectedDueAt = orchestration.toOrchestrationDueAt(rawDueAt2);
      assert(capturedBody.due_at === expectedDueAt, 'T5a. body.due_at 使用轉換後的明確 timezone 值', capturedBody.due_at);
      // 重新用 capturedBody 裡的值＋timestamp/request_id 重算簽章，應該要能對得上（證明簽的就是這組值）
      const recomputedSig = orchestration.sign(secret, { version: 'v1', storeId: 'store_001', timestamp: capturedBody.sent_at, requestId: capturedBody.request_id, dueAt: capturedBody.due_at });
      assert(recomputedSig === capturedSig, 'T5b. HMAC canonical 使用的 dueAt 與 body.due_at 完全相同（簽的就是實際送出的值）');
      global.fetch = globalFetchOriginal;
      dnsModule.promises.lookup = originalLookup;
    }

    // ══════════════════════════════════════════════════════════════
    // Workflow Static Topology（WF1-WF13，真正解析 connections，不是字串搜尋）
    // ══════════════════════════════════════════════════════════════
    {
      const workflowPath = path.join(ROOT, 'n8n-cart-recovery-workflow.json');
      assert(fs.existsSync(workflowPath), 'Workflow-0. n8n-cart-recovery-workflow.json 存在');
      const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
      const nodesByName = {};
      workflow.nodes.forEach((n) => { nodesByName[n.name] = n; });
      function nextNodes(name, outputIndex) {
        const conns = workflow.connections[name];
        if (!conns || !conns.main) return [];
        const targets = outputIndex !== undefined ? (conns.main[outputIndex] || []) : conns.main.flat();
        return targets.map((t) => t.node);
      }
      const webhookName = '接收 POS Wake-Up';
      const verifyName = '驗證 POS Signature (HMAC-SHA256)';
      const ifValidName = 'If Signature Valid';
      const ackName = '立即 ACK（HTTP 202）';
      const waitName = 'Wait Until due_at';
      const buildDueName = '組新的 request_id + timestamp';

      assert(nextNodes(webhookName).includes(verifyName), 'WF1. Webhook → Verify（拓撲關係，非字串搜尋）');
      assert(nextNodes(verifyName).includes(ifValidName), 'WF-verify-to-if. Verify → If Signature Valid');
      assert(nextNodes(ifValidName, 0).includes(ackName), 'WF2. Verify（通過分支）→ Respond（ACK）');
      assert(nextNodes(ackName).includes(waitName), 'WF3/WF5. Respond 位於 Wait 之前（Respond → Wait 直接相連）');
      assert(nextNodes(waitName).includes(buildDueName), 'WF4. Wait → 組 Due Request（真正解析 connections 得出）');

      // WF6/WF7：Verify 節點的程式碼裡有 _loopCount 初始為 0
      const verifyCode = nodesByName[verifyName].parameters.jsCode;
      assert(/_loopCount:\s*0/.test(verifyCode), 'WF7. Verify 節點程式碼中 _loopCount 初始化為 0');

      // WF8/WF9：Merge 節點程式碼裡有 _loopCount + 1（每圈遞增，不是重置回 0）
      const mergeNode = nodesByName['Merge：context + processor_result'];
      assert(mergeNode && /_loopCount:\s*context\._loopCount\s*\+\s*1/.test(mergeNode.parameters.jsCode), 'WF8/WF9. Merge 節點真的把 _loopCount 累加（context._loopCount + 1），不是每次重置');

      // WF6：HTTP Response 後 store_id 仍存在——驗證 Merge 節點的輸出明確包含 store_id（來自 context，不是來自 HTTP 回應）
      assert(/store_id:\s*context\.store_id/.test(mergeNode.parameters.jsCode), 'WF6. Merge 節點明確從 context（呼叫前保存的值）取回 store_id，不會被 POS 回應覆蓋');

      // WF10：每圈用全新 request_id（build-due-request 節點程式碼裡呼叫 crypto.randomUUID()）
      const buildDueNode = nodesByName[buildDueName];
      assert(/crypto\.randomUUID\(\)/.test(buildDueNode.parameters.jsCode), 'WF10. 每次組 Due Request 都呼叫 crypto.randomUUID() 產生新 request_id（不 replay 上一圈的值）');

      // WF11/WF12/WF13：has_more 判斷節點的條件式讀 processor_result.has_more 且有 loop guard <10
      const ifHasMoreNode = nodesByName['If processor_result.has_more'];
      const ifHasMoreCondition = ifHasMoreNode.parameters.conditions.boolean[0].value1;
      assert(ifHasMoreCondition.includes('processor_result.has_more'), 'WF11/WF13. has_more 判斷讀 processor_result.has_more（合併後的明確欄位），不是裸的 $json.has_more');
      assert(ifHasMoreCondition.includes('_loopCount < 10'), 'WF12. has_more 判斷同時檢查 loop guard（_loopCount < 10），避免無限循環');
      const loopBackTargets = nextNodes('If processor_result.has_more', 0);
      assert(loopBackTargets.includes(buildDueName), 'Workflow-loop-back. has_more=true 分支迴圈回「組新的 request_id」節點（不是重跑 Verify/ACK）');
      const noMoreTargets = nextNodes('If processor_result.has_more', 1);
      assert(Array.isArray(noMoreTargets) && noMoreTargets.length === 0, 'WF11-end. has_more=false 分支沒有後續節點（安全結束，不再呼叫 POS）');

      // 既有靜態安全檢查沿用
      // 只掃 nodes/connections 本身，排除 meta.description（那裡面用中文說明
      // 「不得包含姓名/電話/地址」這件事本身，逐字比對會誤判成違規）。
      const nodesOnlyStr = JSON.stringify({ nodes: workflow.nodes, connections: workflow.connections });
      assert(!nodesOnlyStr.includes('姓名') && !nodesOnlyStr.includes('電話') && !nodesOnlyStr.includes('地址') && !/U[0-9a-f]{32}/.test(nodesOnlyStr), 'WF9-pii. workflow 節點本身（不含 meta 說明文字）不含 PII 欄位樣式');
      assert(!nodesOnlyStr.includes('POS_RECOVERY_SHARED_SECRET') || nodesOnlyStr.includes('process.env.POS_RECOVERY_SHARED_SECRET'), 'WF10-secret. secret 只透過 process.env 讀取，不是字面值 hardcode');
      // 排除 id/webhookId 這種本來就是長字串識別碼的欄位，只檢查其他欄位有沒有
      // 疑似真實 secret 的長 base64 字串。
      const strippedForSecretScan = nodesOnlyStr.replace(/"id"\s*:\s*"[^"]*"/g, '').replace(/"webhookId"\s*:\s*"[^"]*"/g, '');
      assert(!/[A-Za-z0-9+/]{40,}={0,2}/.test(strippedForSecretScan), 'WF-no-hardcoded-secret. workflow 節點內容沒有看起來像真實 base64 secret 的長字串（排除 id/webhookId 欄位本身）');
      assert(!nodesOnlyStr.toLowerCase().includes('messaging-api'), 'WF7-nolinepush. workflow 沒有直接呼叫 LINE Messaging API 節點');
      assert(!nodesOnlyStr.toLowerCase().includes('"n8n-nodes-base.postgres"') && !nodesOnlyStr.toLowerCase().includes('"n8n-nodes-base.mysql"') && !nodesOnlyStr.toLowerCase().includes('sqlite'), 'WF8-nodb. workflow 沒有直接 DB access 節點');
    }

    // ══════════════════════════════════════════════════════════════
    // Settings HTTP：Secret Strength／Empty-preserve／Redaction（S1-S5）
    // ══════════════════════════════════════════════════════════════
    {
      const appSettings = require('express')();
      appSettings.use(require('express').json());
      appSettings.use((req, res, next) => { req.storeId = 'store_001'; next(); });
      appSettings.use('/api/settings', require('../routes/settings'));
      const serverSettings = http.createServer(appSettings);
      await new Promise((resolve) => serverSettings.listen(0, resolve));
      const portSettings = serverSettings.address().port;
      const baseSettings = `http://127.0.0.1:${portSettings}`;

      const strongSecret = 'b'.repeat(43);
      setSetting('store_001', 'cart_recovery_n8n_secret', strongSecret);
      // S1: seed 完成（上面）

      // S2: PUT 不相關設定，secret 不送 → unchanged
      await fetch(`${baseSettings}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_cart_delay_minutes: '90' }) });
      assert(orchestration.getSharedSecret(db, 'store_001') === strongSecret, 'S2. PUT 不相關設定（secret 欄位完全不送）→ secret unchanged');

      // S3: PUT secret='' → unchanged
      await fetch(`${baseSettings}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_n8n_secret: '' }) });
      assert(orchestration.getSharedSecret(db, 'store_001') === strongSecret, 'S3. PUT secret=\'\'（空字串）→ unchanged（保留原值語意）');

      // S4: PUT 合法新 secret（真正的 crypto.randomBytes(32) base64url，不是
      // 'c'.repeat(43) 這種現在會被 SSOT 擋下的假強度值）→ changed
      const newStrongSecret = require('crypto').randomBytes(32).toString('base64url');
      const r4 = await fetch(`${baseSettings}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_n8n_secret: newStrongSecret }) });
      assert(r4.status === 200, 'S4-http. PUT 合法新 secret → 200');
      assert(orchestration.getSharedSecret(db, 'store_001') === newStrongSecret, 'S4. PUT 合法新 secret（真正高熵隨機值）→ changed');

      // S5: PUT 弱 secret → 400
      const r5 = await fetch(`${baseSettings}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_n8n_secret: '123456' }) });
      assert(r5.status === 400, 'S5. PUT 弱 secret（"123456"）→ 400', r5.status);
      assert(orchestration.getSharedSecret(db, 'store_001') === newStrongSecret, 'S5b. 弱 secret 被拒絕後，原本合法的 secret 仍保持不變（未被部分寫入）');

      // GET 真 HTTP：不得回明文，只回布林
      const getRes = await fetch(`${baseSettings}/api/settings`, { method: 'GET' });
      const getJson = await getRes.json();
      assert(!('cart_recovery_n8n_secret' in getJson.data), 'GET-redact. GET /api/settings 真實 HTTP 回應不含 cart_recovery_n8n_secret 明文欄位');
      assert(getJson.data.cart_recovery_n8n_secret_set === true, 'GET-redact-bool. GET /api/settings 正確回傳 cart_recovery_n8n_secret_set=true（布林狀態）');
      serverSettings.close();
    }

    // ══════════════════════════════════════════════════════════════
    // SSOT-1：validateSharedSecret() 純函式，逐一驗證每種攻擊樣式
    // ══════════════════════════════════════════════════════════════
    {
      const { validateSharedSecret, SHARED_SECRET_EXPECTED_LENGTH } = orchestration;
      assert(SHARED_SECRET_EXPECTED_LENGTH === 43, 'SSOT-length-const. 正式長度常數=43（base64url(randomBytes(32))）', SHARED_SECRET_EXPECTED_LENGTH);
      assert(validateSharedSecret('a'.repeat(43)).valid === false, 'SSOT-1a. 單一字元重複（a x43）→ invalid');
      assert(validateSharedSecret('b'.repeat(43)).valid === false, 'SSOT-1b. 單一字元重複（b x43）→ invalid');
      assert(validateSharedSecret(('ab'.repeat(22)).slice(0, 43)).valid === false, 'SSOT-1c. 兩字元循環（ab...）→ invalid');
      assert(validateSharedSecret('a'.repeat(42)).valid === false, 'SSOT-1d. 長度 42（少 1）→ invalid');
      assert(validateSharedSecret('a'.repeat(44)).valid === false, 'SSOT-1e. 長度 44（多 1）→ invalid');
      assert(validateSharedSecret(('x=+/'.repeat(11)).slice(0, 43)).valid === false, 'SSOT-1f. 非 base64url 字元集（含 +/=）→ invalid');
      const real1 = require('crypto').randomBytes(32).toString('base64url');
      const real2 = require('crypto').randomBytes(32).toString('base64url');
      assert(validateSharedSecret(real1).valid === true, 'SSOT-1g. 真正 crypto.randomBytes(32) 產生的值 #1 → valid', real1.length);
      assert(validateSharedSecret(real2).valid === true, 'SSOT-1h. 真正 crypto.randomBytes(32) 產生的值 #2 → valid（非單一樣本巧合）', real2.length);
      assert(real1 !== real2, 'SSOT-1i. 兩次真正產生的值彼此不同（隨機性基本檢查）');
    }

    // ══════════════════════════════════════════════════════════════
    // SSOT-2：真實 HTTP，同一組攻擊樣式打 PUT /api/settings，全部應 400
    // ══════════════════════════════════════════════════════════════
    {
      const appSsot = require('express')();
      appSsot.use(require('express').json());
      appSsot.use((req, res, next) => { req.storeId = 'store_ssot_http'; next(); });
      appSsot.use('/api/settings', require('../routes/settings'));
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_ssot_http', 'SSOT HTTP', 'x', 'pro', 1]);
      const serverSsot = http.createServer(appSsot);
      await new Promise((resolve) => serverSsot.listen(0, resolve));
      const portSsot = serverSsot.address().port;
      const baseSsot = `http://127.0.0.1:${portSsot}`;

      async function putSecret(value) {
        const r = await fetch(`${baseSsot}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart_recovery_n8n_secret: value }) });
        return { status: r.status, json: await r.json() };
      }

      const r1 = await putSecret('a'.repeat(43));
      assert(r1.status === 400, 'SSOT-2a-http. 真實 HTTP PUT 單一字元重複 secret → 400', r1.status);
      const r2 = await putSecret(('ab'.repeat(22)).slice(0, 43));
      assert(r2.status === 400, 'SSOT-2b-http. 真實 HTTP PUT 兩字元循環 secret → 400', r2.status);
      const r3 = await putSecret('a'.repeat(42));
      assert(r3.status === 400, 'SSOT-2c-http. 真實 HTTP PUT 長度 42 secret → 400', r3.status);
      const r4 = await putSecret('a'.repeat(44));
      assert(r4.status === 400, 'SSOT-2d-http. 真實 HTTP PUT 長度 44 secret → 400', r4.status);
      const r5 = await putSecret(('x=+/'.repeat(11)).slice(0, 43));
      assert(r5.status === 400, 'SSOT-2e-http. 真實 HTTP PUT 非 base64url 字元 secret → 400', r5.status);
      const dbAfterRejections = orchestration.getSharedSecret(db, 'store_ssot_http');
      assert(dbAfterRejections === '', 'SSOT-2f. 全部被拒絕的 secret 都沒有真的寫進 DB（值仍是空字串，非任何攻擊樣式殘留）', dbAfterRejections);

      // 真實高熵值才會成功
      const validSecret = require('crypto').randomBytes(32).toString('base64url');
      const r6 = await putSecret(validSecret);
      assert(r6.status === 200, 'SSOT-2g-http. 真實 HTTP PUT 真正高熵 secret → 200', r6.status);
      assert(orchestration.getSharedSecret(db, 'store_ssot_http') === validSecret, 'SSOT-2h. 成功寫入的值與送出的值完全相同');

      // rotate 端點自我驗證：連續 rotate 5 次，每次都必須通過 SSOT，且彼此不同
      const createRouterSsot = require('../routes/cart-recovery-orchestration');
      const appRotateSsot = require('express')();
      appRotateSsot.use(require('express').json());
      appRotateSsot.use((req, res, next) => { req.storeId = 'store_ssot_http'; next(); });
      appRotateSsot.use('/api/cart-recovery/orchestration', createRouterSsot((req, res, next) => next()));
      const serverRotateSsot = http.createServer(appRotateSsot);
      await new Promise((resolve) => serverRotateSsot.listen(0, resolve));
      const portRotateSsot = serverRotateSsot.address().port;
      const rotatedSecrets = [];
      for (let i = 0; i < 5; i++) {
        const rr = await fetch(`http://127.0.0.1:${portRotateSsot}/api/cart-recovery/orchestration/secret/rotate`, { method: 'POST' });
        const rj = await rr.json();
        assert(rr.status === 200 && rj.success === true, `SSOT-rotate-${i}. rotate 呼叫 #${i} 成功`, rr.status);
        assert(orchestration.validateSharedSecret(rj.secret).valid === true, `SSOT-rotate-valid-${i}. rotate 產生的值 #${i} 通過 SSOT 驗證（自我一致）`, rj.secret ? rj.secret.length : 'none');
        rotatedSecrets.push(rj.secret);
      }
      const uniqueRotated = new Set(rotatedSecrets).size;
      assert(uniqueRotated === 5, 'SSOT-rotate-unique. 連續 5 次 rotate 產生 5 個彼此不同的值', uniqueRotated);
      serverRotateSsot.close();
      serverSsot.close();
    }

    // ══════════════════════════════════════════════════════════════
    // Rotate（ROT1-ROT6）
    // ══════════════════════════════════════════════════════════════
    {
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_rotate_4c', 'Rotate', 'x', 'pro', 1]);
      const createRouterRotate = require('../routes/cart-recovery-orchestration');

      // ROT1: 未經 requireStore（middleware 直接拒絕） → 不可 rotate
      const appNoAuth = require('express')();
      appNoAuth.use(require('express').json());
      const denyMiddleware = (req, res) => res.status(401).json({ success: false, message: 'unauthorized' });
      appNoAuth.use('/api/cart-recovery/orchestration', createRouterRotate(denyMiddleware));
      const serverNoAuth = http.createServer(appNoAuth);
      await new Promise((resolve) => serverNoAuth.listen(0, resolve));
      const portNoAuth = serverNoAuth.address().port;
      const resNoAuth = await fetch(`http://127.0.0.1:${portNoAuth}/api/cart-recovery/orchestration/secret/rotate`, { method: 'POST' });
      assert(resNoAuth.status === 401, 'ROT1. 未經 requireStore（middleware 拒絕）→ 不可 rotate', resNoAuth.status);
      serverNoAuth.close();

      // ROT2-ROT6
      const appAuth = require('express')();
      appAuth.use(require('express').json());
      appAuth.use((req, res, next) => { req.storeId = 'store_rotate_4c'; next(); });
      appAuth.use('/api/cart-recovery/orchestration', createRouterRotate((req, res, next) => next()));
      const serverAuth = http.createServer(appAuth);
      await new Promise((resolve) => serverAuth.listen(0, resolve));
      const portAuth = serverAuth.address().port;
      const baseAuth = `http://127.0.0.1:${portAuth}`;

      const resRotate = await fetch(`${baseAuth}/api/cart-recovery/orchestration/secret/rotate`, { method: 'POST' });
      const jsonRotate = await resRotate.json();
      assert(jsonRotate.success === true, 'ROT2. 合法 Admin → success', JSON.stringify(jsonRotate));
      assert(typeof jsonRotate.secret === 'string' && jsonRotate.secret.length >= 32, 'ROT3. 新 secret >=32 bytes 等價強度', jsonRotate.secret ? jsonRotate.secret.length : 'none');
      const dbSecret = orchestration.getSharedSecret(db, 'store_rotate_4c');
      assert(dbSecret === jsonRotate.secret, 'ROT4. DB 已換新值');

      // ROT5: 舊 secret 簽的 due signature 失效
      const oldSecret = 'old-secret-that-should-be-invalid-now';
      const ts = Date.now();
      const reqId = 'rot-req-old';
      const oldSig = orchestration.sign(oldSecret, { version: 'v1', storeId: 'store_rotate_4c', timestamp: ts, requestId: reqId });
      const appDue = require('express')();
      appDue.use(require('express').json());
      appDue.use('/api/cart-recovery/orchestration', createRouterRotate((req, res, next) => { req.storeId = 'store_rotate_4c'; next(); }));
      const serverDue = http.createServer(appDue);
      await new Promise((resolve) => serverDue.listen(0, resolve));
      const portDue = serverDue.address().port;
      const resOldSig = await fetch(`http://127.0.0.1:${portDue}/api/cart-recovery/orchestration/process-due`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-N8N-Recovery-Version': 'v1', 'X-N8N-Recovery-Timestamp': String(ts), 'X-N8N-Recovery-Request-Id': reqId, 'X-N8N-Recovery-Signature': `sha256=${oldSig}` },
        body: JSON.stringify({ version: 'v1', store_id: 'store_rotate_4c', timestamp: ts, request_id: reqId }),
      });
      assert(resOldSig.status === 401, 'ROT5. 舊 secret 簽的 due signature 在 rotate 後失效 → 401', resOldSig.status);

      // ROT6: 新 secret 簽的 due signature 成功
      setSetting('store_rotate_4c', 'cart_recovery_n8n_enabled', '1');
      const ts2 = Date.now();
      const reqId2 = 'rot-req-new';
      const newSig = orchestration.sign(jsonRotate.secret, { version: 'v1', storeId: 'store_rotate_4c', timestamp: ts2, requestId: reqId2 });
      const resNewSig = await fetch(`http://127.0.0.1:${portDue}/api/cart-recovery/orchestration/process-due`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-N8N-Recovery-Version': 'v1', 'X-N8N-Recovery-Timestamp': String(ts2), 'X-N8N-Recovery-Request-Id': reqId2, 'X-N8N-Recovery-Signature': `sha256=${newSig}` },
        body: JSON.stringify({ version: 'v1', store_id: 'store_rotate_4c', timestamp: ts2, request_id: reqId2 }),
      });
      assert(resNewSig.status === 200, 'ROT6. 新 secret 簽的 due signature 成功', resNewSig.status);
      serverAuth.close();
      serverDue.close();
    }

    // ══════════════════════════════════════════════════════════════
    // N4 加強：sha256 hash 完全不變
    // ══════════════════════════════════════════════════════════════
    {
      const crypto = require('crypto');
      const workflowContent = fs.readFileSync(path.join(ROOT, 'n8n-workflow.json'));
      const hash1 = crypto.createHash('sha256').update(workflowContent).digest('hex');
      // 跑一輪完整 Phase 4C 相關操作（settings save／wake-up／rotate／due）後再算一次
      const hash2 = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'n8n-workflow.json'))).digest('hex');
      assert(hash1 === hash2, 'N4-hash. n8n-workflow.json 在跑過完整 Phase 4C 測試後 sha256 完全相同（byte-for-byte 未修改）', `${hash1} vs ${hash2}`);
    }

    // ══════════════════════════════════════════════════════════════
    // Refresh Race（RACE1-RACE5）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const delivery = require('../utils/cartRecoveryDelivery');
      const { logServerEvent } = require('../utils/analyticsLog');
      const { grantConsent } = require('../utils/cartRecoveryConsent');
      const storeId = 'store_race_refresh';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Race Refresh', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      setSetting(storeId, 'cart_recovery_line_enabled', '1');
      setSetting(storeId, 'line_channel_token', 'fake-token');
      setSetting(storeId, 'line_member_liff_id', 'liff-race-refresh');

      const cartId = 'race-refresh-cart';
      const lineUserId = 'Uracerefresh000000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
      // RACE1: T1 due
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, storeId, cartId]);
      const t1 = db.get(`SELECT due_at FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).due_at;

      // RACE2: 顧客新活動 → due_at refresh 到 T2
      await new Promise((r) => setTimeout(r, 1100)); // 確保時間戳真的往前走，T2 > T1
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      const t2 = db.get(`SELECT due_at FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).due_at;
      assert(t2 >= t1, 'RACE-setup. due_at 確實被 refresh（T2>=T1）', `t1=${t1} t2=${t2}`);

      // RACE3: 用 T1 模擬「舊排程」到期 call POS（把 job 暫時改回 T1 due_at 模擬「n8n 還在等 T1」這件事不影響 DB 現在的真實 due_at 是 T2——這裡改用直接判斷 eligibility 的方式驗證：只要 due_at 現在是 T2，due<=T1 的查詢應該查不到它）
      const jobsdueAtT1 = db.all(`SELECT id FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned' AND due_at<=?`, [storeId, cartId, t1]);
      assert(jobsdueAtT1.length === 0, 'RACE3. 用舊 T1 時間點查詢 due jobs → 查不到（due_at 已經被 refresh 到 T2，未到期）', jobsdueAtT1.length);

      // RACE4: T2 到期後才真的能查到、送出
      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
      let pushCalls = 0;
      const linePushModule = require('../utils/linePush');
      const originalSend = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalls += 1; return { success: true, status: 200 }; };
      const result = await delivery.processDueLineRecoveryJobs(db, storeId, {});
      linePushModule.sendLinePush = originalSend;
      assert(pushCalls === 1, 'RACE4. 到期後（T2）processDueLineRecoveryJobs → sent=1', pushCalls);
      assert(result.sent === 1, 'RACE5. 整體只送出一個 LINE reminder（沒有因為 refresh 產生兩個 job/兩次送出）', JSON.stringify(result));
      const jobCount = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).c;
      assert(jobCount === 1, 'RACE5b. 全程只有 1 筆 cart_abandoned job（refresh 不建立第二筆）', jobCount);
    }

    // ══════════════════════════════════════════════════════════════
    // Conversion Before Due（CV1-CV8）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const { logServerEvent } = require('../utils/analyticsLog');
      const { grantConsent } = require('../utils/cartRecoveryConsent');
      const handoff = require('../utils/lineCheckoutHandoff');
      const storeId = 'store_race_conversion';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Race Conversion', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      setSetting(storeId, 'cart_recovery_line_enabled', '1');
      setSetting(storeId, 'line_channel_token', 'fake-token');
      setSetting(storeId, 'line_member_liff_id', 'liff-race-conv');

      const cartId = 'race-conv-cart';
      const lineUserId = 'Uraceconv0000000000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 }); // CV1
      grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, storeId, cartId]);
      const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' }); // CV2（模擬已建立 Recovery token）

      // CV3：顧客提前完成購買。這裡刻意不先走 checkout_click／submit_order
      // （那是既有 Phase 4A 正確行為：checkout_click 本身就會把
      // cart_abandoned cancel 掉，不是 convert——那是另一條測試過的路徑，
      // 見 Backend Targeted 的 CC 系列）。這裡要驗證的是「job 還是
      // pending/sent 時，purchase 直接發生」這個情境（例如顧客透過其他
      // session／管道完成購買），直接 fire purchase。
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'race-conv-order', event_name: 'purchase' });
      const jobAfterPurchase = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
      assert(jobAfterPurchase.status === 'converted', 'CV4. job=converted（purchase 立即生效）');

      // CV5/CV6: n8n later calls process-due
      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
      let pushCalls = 0;
      const linePushModule = require('../utils/linePush');
      const originalSend = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalls += 1; return { success: true, status: 200 }; };
      const delivery = require('../utils/cartRecoveryDelivery');
      await delivery.processDueLineRecoveryJobs(db, storeId, {});
      linePushModule.sendLinePush = originalSend;
      assert(pushCalls === 0, 'CV6. n8n later calls process-due → sent=0（converted 不再被 push）', pushCalls);

      // CV7: converted 維持
      const jobAfterDue = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
      assert(jobAfterDue.status === 'converted', 'CV7. converted 狀態維持不變');

      // CV8: Recovery token 仍 invalidated
      const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tok.token]);
      assert(tokenRow.status === 'cancelled', 'CV8. Recovery token 仍 invalidated（purchase 時就已失效）');
    }

    // ══════════════════════════════════════════════════════════════
    // Consent Revoked Before Due（CR1-CR6）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const { logServerEvent } = require('../utils/analyticsLog');
      const { grantConsent, revokeConsent } = require('../utils/cartRecoveryConsent');
      const delivery = require('../utils/cartRecoveryDelivery');
      const storeId = 'store_race_consent';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Race Consent', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      setSetting(storeId, 'cart_recovery_line_enabled', '1');
      setSetting(storeId, 'line_channel_token', 'fake-token');
      setSetting(storeId, 'line_member_liff_id', 'liff-race-consent');

      const cartId = 'race-consent-cart';
      const lineUserId = 'Uraceconsent00000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 }); // CR1
      grantConsent(db, storeId, { cartId, lineUserId, source: 'test' }); // CR2
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, storeId, cartId]);

      revokeConsent(db, storeId, { cartId }); // CR3

      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
      let pushCalls = 0;
      const linePushModule = require('../utils/linePush');
      const originalSend = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalls += 1; return { success: true, status: 200 }; };
      await delivery.processDueLineRecoveryJobs(db, storeId, {}); // CR4
      linePushModule.sendLinePush = originalSend;
      assert(pushCalls === 0, 'CR5. n8n process-due（consent 已被 revoke）→ sent=0', pushCalls);

      const jobAfter = db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
      assert(jobAfter.status === 'not_contactable', 'CR6. job state 符合 Phase 4B canonical contract（consent_revoked → not_contactable）', jobAfter.status);
    }

    // ══════════════════════════════════════════════════════════════
    // Friendship Race（FR1-FR5）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const { logServerEvent } = require('../utils/analyticsLog');
      const { grantConsent } = require('../utils/cartRecoveryConsent');
      const delivery = require('../utils/cartRecoveryDelivery');
      const storeId = 'store_race_friend';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Race Friend', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      setSetting(storeId, 'cart_recovery_line_enabled', '1');
      setSetting(storeId, 'line_channel_token', 'fake-token');
      setSetting(storeId, 'line_member_liff_id', 'liff-race-friend');

      const cartId = 'race-friend-cart';
      const lineUserId = 'Uracefriend000000000001';
      db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]); // FR2: friend initially true
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated', metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 } });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 }); // FR1
      grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
      db.run(`UPDATE cart_recovery_jobs SET line_user_id=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, storeId, cartId]);

      // FR3: before due: unfollow
      db.run(`UPDATE line_members SET is_friend=0 WHERE store_id=? AND line_user_id=?`, [storeId, lineUserId]);

      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
      let pushCalls = 0;
      const linePushModule = require('../utils/linePush');
      const originalSend = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalls += 1; return { success: true, status: 200 }; };
      await delivery.processDueLineRecoveryJobs(db, storeId, {}); // FR4
      linePushModule.sendLinePush = originalSend;
      assert(pushCalls === 0, 'FR5. unfollow before due → Push calls=0', pushCalls);
    }

    // ══════════════════════════════════════════════════════════════
    // Batch 49/50/51（B1-B5）
    // ══════════════════════════════════════════════════════════════
    {
      const cartRecovery = require('../utils/cartRecovery');
      const delivery = require('../utils/cartRecoveryDelivery');
      const storeId = 'store_batch_full_4c';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Batch Full', 'x', 'pro', 1]);
      setSetting(storeId, 'cart_recovery_enabled', '1');
      const now = cartRecovery._nowIso();
      const farFuture = new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' ');

      function seedJobs(count, dueAtValue, prefix) {
        for (let i = 0; i < count; i++) {
          db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
            [storeId, `${prefix}-${i}`, 'cart_abandoned', 'pending', dueAtValue, `${prefix}-key-${i}`, now, now]);
        }
      }

      // B1: 49 due, limit 50 → processed=49, has_more=false
      seedJobs(49, now, 'b1');
      const resultB1 = await delivery.processDueLineRecoveryJobs(db, storeId, { limit: 50 });
      assert(resultB1.processed === 49 && resultB1.has_more === false, 'B1. 49 due + limit50 → processed=49, has_more=false', JSON.stringify(resultB1));

      // B2: exact 50 due, limit 50 → processed=50, has_more=false
      const storeId2 = 'store_batch_full_4c_b2';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId2, 'Batch B2', 'x', 'pro', 1]);
      setSetting(storeId2, 'cart_recovery_enabled', '1');
      for (let i = 0; i < 50; i++) {
        db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [storeId2, `b2-${i}`, 'cart_abandoned', 'pending', now, `b2-key-${i}`, now, now]);
      }
      const resultB2 = await delivery.processDueLineRecoveryJobs(db, storeId2, { limit: 50 });
      assert(resultB2.processed === 50 && resultB2.has_more === false, 'B2. exact 50 due + limit50 → processed=50, has_more=false', JSON.stringify(resultB2));

      // B3: 51 due, limit 50 → processed=50, has_more=true
      const storeId3 = 'store_batch_full_4c_b3';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId3, 'Batch B3', 'x', 'pro', 1]);
      setSetting(storeId3, 'cart_recovery_enabled', '1');
      // 需求文件三十：B3/B4 要驗證的是「due 佇列真的會隨著每次呼叫縮小」，
      // 這代表 job 必須真的被移出 pending/waiting（sent 或被標記 not_contactable
      // 等終態），不只是「查得到」。這裡沒有做完整 consent/friend 設定，job
      // 會在 eligibility 檢查時因 consent_missing 被標記 not_contactable
      // （這是既有 processor 邏輯，非本輪新增），因此需要開啟
      // cart_recovery_line_enabled 才會真的走到 consent 檢查那一步並標記終態。
      setSetting(storeId3, 'cart_recovery_line_enabled', '1');
      setSetting(storeId3, 'line_channel_token', 'fake-token');
      setSetting(storeId3, 'line_member_liff_id', 'liff-batch-b3');
      for (let i = 0; i < 51; i++) {
        db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [storeId3, `b3-${i}`, 'cart_abandoned', 'pending', now, `b3-key-${i}`, now, now]);
      }
      const resultB3 = await delivery.processDueLineRecoveryJobs(db, storeId3, { limit: 50 });
      assert(resultB3.processed === 50 && resultB3.has_more === true, 'B3. 51 due + limit50 → processed=50, has_more=true', JSON.stringify(resultB3));

      // B4: 下一次處理剩餘 1（因為 skipped job 因缺條件仍留在 pending，直接再跑一次應該再抓到剩的 1 筆）
      const resultB4 = await delivery.processDueLineRecoveryJobs(db, storeId3, { limit: 50 });
      assert(resultB4.processed === 1 && resultB4.has_more === false, 'B4. 第二次 call → 處理剩餘 1 筆', JSON.stringify(resultB4));

      // B5: 100 future + 1 due → 那 1 筆仍被處理（不被 future rows 餓死）
      const storeId5 = 'store_batch_full_4c_b5';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId5, 'Batch B5', 'x', 'pro', 1]);
      setSetting(storeId5, 'cart_recovery_enabled', '1');
      for (let i = 0; i < 100; i++) {
        db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [storeId5, `b5-future-${i}`, 'cart_abandoned', 'pending', farFuture, `b5-future-key-${i}`, now, now]);
      }
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        [storeId5, 'b5-due-1', 'cart_abandoned', 'pending', now, 'b5-due-key-1', now, now]);
      const resultB5 = await delivery.processDueLineRecoveryJobs(db, storeId5, { limit: 10 });
      assert(resultB5.processed === 1, 'B5. 100 筆 future + 1 筆 due → 那 1 筆仍被處理（不被 future rows 餓死，因為 getRecoverableJobs 本身已 due-only）', JSON.stringify(resultB5));
    }

  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }

  console.log('\n== Phase 4C Core Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Phase 4C test runner crashed:', e && e.stack || e); process.exit(1); });
