# CHANGELOG — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-N8N-QA-FRIEND-SECRET-UX

Checkpoint 仍為 **H1.4.10**（不升級到 H1.4.11）。本輪只修兩個確認的 bug（TASK A／TASK B），過程中的全面回歸測試另外發現並處理了兩項與這兩個 bug 無關的既有問題（Baseline Hygiene Fix／Historical Regression Test Modernization），詳見下方個別章節，兩者皆有獨立的 Reality Audit 佐證，不算本輪新增功能。

Recovery n8n Shared Secret one-time display/copy 的完整說明見 `H1.4.10_PHASE4C_N8N_ORCHESTRATION_IMPLEMENTATION_REPORT.md`（新增章節）；本檔只列摘要與其餘三項。

## TASK A — Recovery n8n Shared Secret One-Time Display / Copy

摘要見 Phase 4C Implementation Report 新增章節。Backend protocol **未修改**（audit 確認 rotate 端點本來就只在當次回傳明文、GET 本來就只回布林值）。前端新增一次性顯示 Modal，關閉／X／backdrop 三種觸發方式共用同一個清除函式，不寫入任何 storage/analytics/console。

- Modified：`public/index.html`、`public/js/app.js`
- Backend changed：**NO**
- Tests：`scripts/run-h1-4-10-secret-ui-runtime.js`（新增）—— **48/48 PASS**

## TASK B — LINE Friend Guide Authoritative State / Race Condition

### 根因

`maybeShowFriendEntryGuide()`／`maybeShowFriendCheckoutGuide()`（`public/js/line-member-gate.js`）判斷是否已是好友時，只讀本地 `member_session` 快取（`knownFriendStatus()`）。這份快取只有在真的跑過一次 `verifyWithBackend()`（登入／被動辨識／重新確認）後才會寫入，且 24 小時後過期。`friend_entry`／`friend_checkout` 本身是刻意設計成「免登入」的模式，很多實際情境下（尚未觸發 auto-identify、session 已過期、或是全新的 LIFF session）這份快取根本不存在，於是即使 LINE 平台端好友關係早已成立，前端判斷仍是 `unknown`，導致「加入官方 LINE」引導反覆出現——即使 POS 後台／CRM 都已顯示 `friend=true`、`stage=friend`。

### 修法

- **Public API 維持完全同步**（`maybeShowFriendEntryGuide()`／`maybeShowFriendCheckoutGuide()` 不是 `async`、不回傳 Promise）。這是刻意的設計決策：four 個 production call site（`line-order.html`／`line-shipping.html` 各自的 entry bootstrap 與 `openCheckoutStep()` 同步 click handler）中，checkout 路徑本來就是同步 click handler，不能安全 `await`；既有 Phase 2 T4 本來就明確驗證這個同步契約，本輪予以保留，未改動。
- 新增獨立的 **async internal helper** `refreshAuthoritativeFriendState(storeId)`：優先讀已驗證的本地 `member_session`；若不是 true，且 LIFF 可用（`liff.isLoggedIn()`），呼叫 `liff.getFriendship()` 作為即時、免登入往返的可信來源。**本函式完全不呼叫 backend**（不打 `/api/line-member/verify`），因此不宣稱「前端直接讀到 LINE Follow Webhook 更新後的 backend 最新狀態」——只宣稱「透過 LIFF SDK 直接反映的 LINE Platform 好友關係」（兩者最終認定的是同一個 LINE 平台事實，但技術路徑不同，如實區分）。
- 新增單一協調入口 `reconcileFriendGuide(storeId, memberState)`：任何「可信狀態更新」（`verifyWithBackend()` 成功、`_passiveVerifyWithBackend()` 成功、`refreshAuthoritativeFriendState()` 內部發現 true）之後都會呼叫，若判定為好友，立即關閉已開啟的 Guide Modal，並讓 `friend_entry`／`friend_checkout` 兩種 mode 這個 session 內都不再顯示。
- 呼叫端配合：
  - Bootstrap（已是 `async` 函式）：`await refreshAuthoritativeFriendState(...)` 之後才 evaluate 同步的 Guide 函式。
  - `openCheckoutStep()`（同步 click handler）：`refreshAuthoritativeFriendState(...)` 以 fire-and-forget 呼叫並帶明確 `.catch(()=>{})`，不阻擋本次 checkout；若稍後才確認為好友，交由 `reconcileFriendGuide()` 把剛顯示的 Guide 關閉。
- 點擊「加入官方 LINE」本身**永遠不會**直接設成 `friend=true`——只標記「等待從外部加好友頁返回」，交由既有 `attemptAutoFriendshipResume()`（`visibilitychange`/`pageshow`/`focus`，已有 debounce + in-flight guard）在真正返回時做可信 refresh。

### 已知邊界（誠實揭露）

若 `liff.getFriendship()` 不可用（例如非 LINE App 內建瀏覽器）且本地 session 剛好是 stale/absent，本輪**不宣稱**前端能主動查回 backend 因 Follow Webhook 才更新的最新狀態——這種情況下維持既有 fail-open（正常顯示 Guide，不阻擋下單），不是誤判、也不是卡住流程。若未來要補上「免登入、且不誤觸發 `liff.login()`」的 backend 直接查詢路徑，現成可用的是既有的 `_passiveVerifyWithBackend()`，但其 `analytics.gate_stage` 目前寫死 `'liff_auto_identify'`，直接借用會讓 backend Auto Identify 的分析語意被污染，需要小幅 backend 調整（讓 `gate_stage` 可由呼叫端傳入）才能乾淨支援，本輪未實作。

- Modified：`public/js/line-member-gate.js`、`public/line-order.html`、`public/line-shipping.html`
- Backend changed：**NO**
- Tests：`scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js`（擴充，新增 Part F：FG-RACE-1～10）—— **112/112 PASS**（原有 83/83 全部保留未變動，含 T4 同步契約）

## Baseline Hygiene Fix（與 TASK A／TASK B 無關，全面回歸測試中發現）

`utils/db.js` 的 `initTables()` 內，`line_preorder_*` 欄位 migration 那段誤用 `w._db.all('PRAGMA table_info(products)')`——`w._db` 是原始 sql.js `Database` 實例，sql.js 從來就沒有 `.all()` 方法（只有 `.run()`/`.exec()`/`.prepare()`），這是 sql.js 本身的 API 現實，不是版本漂移（同一份檔案裡另外 17 處全部正確使用 wrapper 自己實作的 `w.all()`，只有這一行孤立打字錯誤）。

**Reality Audit**：在完全獨立、未經任何本輪修改的 frozen baseline ZIP 上（`npm ci` 對照 lockfile，乾淨 DB 環境）兩次 fresh-run 完全相同地重現這個 TypeError，確認是 **PRE-EXISTING LATENT BASELINE BUG**，與 TASK A／TASK B 完全無關。

**修正**（唯一一行 functional change）：

```diff
-    const _existCols = w._db.all('PRAGMA table_info(products)').map(r => r.name);
+    const _existCols = w.all('PRAGMA table_info(products)').map(r => r.name);
```

- Modified：`utils/db.js`（僅此一行）
- Tests：`scripts/run-h1-4-10-db-wrapper-runtime.js`（新增）—— **9/9 PASS**，驗證 fresh `initDb()` 不再因 PRAGMA crash、`w.all()` 回傳可用的 row objects、`line_preorder_*` 五個欄位在全新 DB 上正確補建、production 原始碼裡 `w._db.all(` 出現次數為 0。

## Historical Regression Test Modernization（與 TASK A／TASK B 無關）

修完 DB Hygiene Fix 後，`scripts/smoke-hotfix27-cd.js` 內一個歷史斷言浮現：它用 `fnBody.includes('openCartSheet()')` 硬鎖 `_restoreCartFromHandoffToken()` 必須呼叫**無參數**的 `openCartSheet()`。但後續 H1.4.7（真正兩階段結帳）已經正式把 `openCartSheet(opts)` 參數化，`opts.step==='checkout'` 專門用於「LIFF/gate 導回後恢復使用者原本所在的第二階段」——正是 Restore 成功要做的事。H1.4.9 的 authoritative runtime 測試（`run-h1-4-9-checkout-order-summary-runtime.js` 的 H149-G）本來就是直接呼叫 `openCartSheet({ step: 'checkout' })` 並驗證 `checkoutStage` 真的展開，這是目前 frozen、正確的 contract。

**Classification：STALE HISTORICAL TEST**（production Restore flow 本身正確，只有這支歷史測試的 exact-string 判斷過時）。**Production Restore/checkout 程式碼完全未修改**。

只更新 `scripts/smoke-hotfix27-cd.js` 的判斷式，從硬鎖單一字面字串改為驗證語意（容忍空白/換行/單雙引號差異的 regex，確認真的傳入 `step:'checkout'`），並額外新增一項確認 `openCartSheet` 函式本身在同一份 production HTML 內真的有定義（避免誤判呼叫虛構函式也算 PASS）。原本測試要保護的 historical intent（「Restore 成功後，顧客一定會回到可操作的購物車／結帳 UI」）完整保留。

- Modified：`scripts/smoke-hotfix27-cd.js`（僅測試判斷式）
- Production changed：**NO**
- Own assertions：**53 PASS / 0 FAIL / MANUAL=5**（原本 51 PASS / 1 FAIL / MANUAL=5）

## Known Pre-Existing Legacy Regression Chain（不由本輪引入，本輪不修）

`scripts/smoke-hotfix27-cd.js` 自身也會鏈式重跑更早期的 `smoke-hotfix26-f2.js`／`smoke-hotfix26-f7.js`／`smoke-hotfix26-f8-b.js`／`smoke-hotfix27.js`，其中存在與本輪完全無關的既有失敗（日期／時段截止判斷邏輯、`switchMode()` 呼叫鏈等，hotfix26 世代的技術債）。

**Legacy Chain Baseline Parity Audit**：分別在完全獨立、未經任何本輪修改的 frozen baseline 與目前 WIP 上，直接 fresh-run 這 4 支腳本，逐一比對 PASS/FAIL/MANUAL 數字與失敗清單：

| Script | Baseline | WIP | 一致 |
|---|---|---|---|
| `smoke-hotfix26-f2.js` | 22 PASS / 3 FAIL / 3 MANUAL | 22 PASS / 3 FAIL / 3 MANUAL | 是（zero-byte diff） |
| `smoke-hotfix26-f7.js` | 46 PASS / 1 FAIL / 0 MANUAL | 46 PASS / 1 FAIL / 0 MANUAL | 是（zero-byte diff） |
| `smoke-hotfix26-f8-b.js`（chain） | 6/8 個腳本 exit 0 | 6/8 個腳本 exit 0 | 是（唯一差異是 Baseline Hygiene Fix 預期產生的 PRAGMA log 差異，無任何斷言結果改變） |
| `smoke-hotfix27.js`（chain） | 6/9 個腳本 exit 0 | 6/9 個腳本 exit 0 | 是（同上） |

**這些 hotfix26 世代的既有失敗不由本輪引入，本輪不修、不擴大 scope。** `smoke-hotfix29-c.js` 本身的直接斷言（`PASS=54 FAIL=0 MANUAL=2`）不受影響，維持既有 baseline。這些 legacy failure 不應被誤寫成 H1.4.10 本輪的 production failure。
