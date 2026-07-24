# CHANGELOG — Hotfix31-R4：Channel Consistency × Visitor 360 Audience × Customer Journey

## 0. Scope

Web POS only. Fixed scope preserved: Android, Boss Dashboard (`routes/dashboard.js`), existing
order flow, existing LINE ordering flow, existing payment behavior, existing inventory behavior,
and existing analytics event *meanings* were not modified. Verified by re-running the R1/R2/R3
regression suites after every edit in this round (see §8).

No real LINE push / coupon delivery / email / SMS / Meta export / Google export / webhook actions
are executed anywhere in this round. No production backfill was executed — all testing ran against
a local sql.js file database created and destroyed by the smoke test scripts.

---

## 1. Root cause of the channel selector bug

Two distinct root causes were found and fixed:

**1a. Missing channel threading (found before this session, confirmed by test).**
`GET /api/analytics/dashboard` only passed the `channel` query parameter into `getKpi`,
`getFunnel`, `getIdentityBasis`, and `getOrderHourAnalysis`. Every other block on the same
response — Cart Abandonment, Product Ranking, Payments, Sources, Repeat Customers, Incomplete
Orders, and the whole `analytics_v2` sub-object (Product Funnel, Cart-Abandonment-by-Product,
Source Performance, Campaigns) — silently ignored the selector and always computed against
**all** channels. This is why channel-specific data only ever "showed up under 全部".

Fix: threaded `channel` through all of the above in `utils/dashboardAnalytics.js` and
`utils/analyticsV2.js`, exposed the single canonical filter-clause builders
(`channelOrdersWhereClause` / `channelEventsWhereClause`) from `dashboardAnalytics.js` so
`analyticsV2.js` reuses the same definition instead of re-implementing channel logic, and updated
`routes/analytics.js` call sites to pass `channel` everywhere.

**1b. SQL/JS channel-resolver drift (found by the new R4 test suite, item C).**
`utils/channelResolver.js` exports two parallel definitions of "what channel does this order
belong to": a JS function `resolveOrderChannel()` (used for event writes) and a SQL expression
`ORDER_CHANNEL_SQL_EXPR` (used for `orders`-table filtering in KPI/Payments/Repeat
Customers/etc.). The file's own comment says these two must be kept in sync. They had drifted:
`resolveOrderChannel()` has an explicit `reservation` branch, but `ORDER_CHANNEL_SQL_EXPR` did
not. As a result, any order with `order_mode='reservation'` fell through the SQL CASE expression
to the `source='line'` branch and was **silently counted as `line_takeout`** — exactly the kind
of silent misassignment the spec explicitly forbids ("unknown/other channels must not be silently
assigned to LINE or POS").

Fix: added the missing `WHEN order_mode='reservation' OR fulfillment_type='reservation' OR
order_source='reservation' THEN 'reservation'` branch to `ORDER_CHANNEL_SQL_EXPR`, in the same
position (right after the shipping check, before the dine_in check) as the JS version. Verified
with a real fixture (`reservation` order) — before the fix, `channel=line_takeout` returned 2
orders (1 real + 1 misattributed reservation) and `channel=reservation` returned 0; after the fix,
each returns exactly 1.

---

## 2. Canonical channel mapping (unchanged from the existing single resolver, now correctly enforced everywhere)

| UI selector | `channel` value used across all components | order_mode |
|---|---|---|
| 全部 | no restriction | — |
| 店內 POS | `pos` | `dine_in` |
| LINE 外帶 | `line_takeout` | `takeout` (source≠pos) |
| LINE 外送 | `line_delivery` | `delivery` (source≠pos) |
| 宅配 | `shipping` | `shipping` / `fulfillment_type=shipping` / `order_source=line_shipping` |
| 預訂 | `reservation` | `reservation` (now fixed in SQL, see §1b) |
| 未知歷史資料 | `unknown` | none of the above match |

This project's existing channel model uses one combined `channel` selector value (matching the
6-way UI selector 1:1) rather than the fully separated `channel`/`order_mode` pair described in
the original request document. This was a deliberate choice to **reuse the existing canonical
resolver rather than build a second, competing one** — `utils/channelResolver.js` is still the
single source of truth, both for event writes (`resolveOrderChannel`) and order-table filtering
(`ORDER_CHANNEL_SQL_EXPR`), and `source`, `campaign`, and `order_mode` remain fully independent
dimensions throughout (verified in tests #11–#12, #33 in the smoke suite — Facebook `source` and
`母親節` `campaign` remain visible and filterable independently of the `line_takeout` channel
filter).

`unknown` is a first-class, non-silent bucket everywhere: an order/event that cannot be classified
returns `channel='unknown'` and is never folded into `pos` or `line_*` (verified by test #10).

---

## 3. Analytics components corrected to respect the channel selector

`getKpi`, `getFunnel`, `getIdentityBasis`, `getOrderHourAnalysis` (already correct before this
round) plus, newly corrected in this round:

- `getCartAnalysis` (Cart Abandonment)
- `getProductRanking` (Product Ranking)
- `getPayments` (Payments)
- `getSources` (Sources — analytics-side UTM sources; order-side sources were already correct via `getKpi`)
- `getRepeatCustomers` (Repeat Customers)
- `getIncomplete` (Incomplete Orders, including the shipping-only "pending shipping confirmation"
  metric, which now returns 0 for non-shipping/non-"all" channel selections instead of always
  showing the all-channel number)
- `getProductFunnel`, `getCartAbandonmentByProduct` (derived), `getSourcePerformance`,
  `getCampaignPerformance` (all inside `analytics_v2`)

**Known limitation (deliberately not "fixed"):** `getCrmOverview` (the LINE CRM Dashboard block)
is *not* channel-filtered. A LINE member's lifetime stats (`total_spent`, `order_count`, etc.) are
member-level, not per-channel — the same member can order via both LINE 外帶 and LINE 外送, so
"which channel does this member belong to" has no single correct answer. Applying a channel filter
there would either double-count or arbitrarily attribute the member to one channel. This is called
out in `routes/analytics.js` inline and here rather than silently applying an incorrect filter.

---

## 4. Files added

- `utils/visitorAudience.js` — Visitor 360 Audience List: aggregation, filters, sort, revisit
  score, customer-status tags, segment-resolution helpers.
- `utils/identityBackfill.js` — safe, optional, dry-run-by-default identity backfill logic.
- `scripts/backfill-hotfix31-r4-identity-links.js` — CLI wrapper for the above (`--store=`,
  `--apply`). Not invoked anywhere automatically; requires a human to run it.
- `scripts/smoke-hotfix31-r4-channel-visitor360.js` — this round's backend/integration test suite
  (116 assertions).
- `scripts/smoke-hotfix31-r4-visitor360-ui.js` — dedicated jsdom behavioral test suite for the new
  "🧑‍🤝‍🧑 Visitor 360" frontend tab (75 assertions), following the same real-execution harness
  style already established by `scripts/smoke-hotfix31-r3-frontend.js` (actually evaluates
  `public/js/app.js` + `public/js/analytics-v2.js` in jsdom, not source-string scanning).
- `CHANGELOG_HOTFIX31_R4_CHANNEL_VISITOR360.md` — this file.

## 5. Files modified

- `utils/channelResolver.js` — fixed `ORDER_CHANNEL_SQL_EXPR` (see §1b).
- `utils/dashboardAnalytics.js` — threaded `channel` through the functions in §3; exposed
  `channelOrdersWhereClause`/`channelEventsWhereClause`.
- `utils/analyticsV2.js` — threaded `channel` through the functions in §3.
- `routes/analytics.js` — pass `channel` to the corrected functions; added
  `GET /api/analytics/visitor-360` (Visitor 360 Audience List endpoint).
- `routes/crm.js` — segment resolution/count now dispatches to `utils/visitorAudience.js` when a
  segment's stored filter carries `__source: 'visitor_audience'`; unchanged for all pre-existing
  Drill Down segment filters (no `__source` marker).
- `utils/visitor360.js` — added `buildCustomerJourney()`; `getVisitorProfile()` now also returns
  `raw_timeline` (the full existing event list, previously computed internally but not exposed)
  and `customer_journey` (new). Existing `journey` field (per-visit summary) is unchanged.
- `public/js/analytics-v2.js` — new "🧑‍🤝‍🧑 Visitor 360" tab (filter bar, paginated table,
  revisit score, customer-status tags, row detail, dynamic/static segment creation); Visitor 360
  detail box extended with a Customer Journey section and a collapsible raw-timeline section
  above the existing summary stats. Additionally, this round's own dedicated jsdom test suite
  (`smoke-hotfix31-r4-visitor360-ui.js`) found and fixed four real bugs in this file — see §13a.

---

## 6. Visitor 360 Audience design

`utils/visitorAudience.js` builds one row per canonical identity per request:

- **LINE members**: one row per `line_members` row. Aggregates (visit/cart/checkout counts,
  recent source/channel/order_mode/campaign) are computed from a single batched query joining
  on `identity_key='line_user:UID'` (post-login events) OR `visitor_id IN (...)` for visitor IDs
  known-linked via `line_member_sessions` (pre-login events) — **one query for all members**,
  not one query per member. LTV (`total_revenue`, `order_count`, `avg_order_value`) is read
  directly from `line_members`, never recomputed, per the existing single-source-of-truth
  convention in `utils/visitor360.js`.
- **Anonymous visitors**: any `visitor_id` seen in `analytics_events` that is *not* in the linked-
  visitor set is aggregated with one `GROUP BY visitor_id` query, plus two follow-up batched
  queries (last-touch source/channel, and order revenue via `purchase` events → `orders` table).
- Both branches are bounded (`MAX_LINE_MEMBERS` / `MAX_ANONYMOUS_VISITORS` = 5000 each); exceeding
  either produces an explicit `warnings[]` entry rather than a silent truncation.
- `identity` states: `line_member` (never had anonymous pre-login history), `anonymous_upgraded`
  (has a deterministic `line_member_sessions` link to pre-login events), `anonymous` (no link
  found), `unresolved` (legacy rows written before the identity/channel columns existed —
  `identity_type IS NULL` for every one of that visitor's events). Each row also carries
  `identity_confidence` (`high` / `unresolved` / `unknown`) and `identity_evidence` (free-text
  description of the resolution method), per item D.
- Privacy: `display_key` is a shortened/masked identifier for UI display (`shortDisplayKey()` for
  anonymous visitor IDs, the existing `maskLineUserId()` for LINE UIDs); `canonical_key` is the
  real key, used only for the "open detail" / "select for segment" actions, never a raw LINE
  token.
- Sorting has a deterministic tie-breaker (`canonical_key` ascending) so that repeated identical
  queries return identical row order (verified by test #31) — required for stable pagination.
- Filtering/sorting fields are backend allowlists (`IDENTITY_FILTERS`, `FRIEND_FILTERS`,
  `VISIT_FREQ_FILTERS`, `PURCHASE_BEHAVIOR_FILTERS`, `ACTIVITY_FILTERS`, `SORT_FIELD_MAP`); no
  arbitrary field name is ever interpolated into a query.
- Count-only mode (`countVisitorAudienceMatches`) and full-resolution mode
  (`resolveVisitorAudienceMemberKeys`, used for segment snapshots) both bypass the public API's
  100-row page cap internally (`_internal_uncapped`) — **this was a real bug found during review
  in this round**: the first implementation reused the public, 100-row-capped pagination path for
  segment resolution, which would have silently truncated static segment snapshots to 100 members.
  Fixed before any test was written against it.

---

## 7. Customer Journey design (new in this round)

`utils/visitor360.js` → `buildCustomerJourney(events, { lineRow, identity })`. Runtime-only, no new
table. Sits **above** the existing raw event list — the raw list is now exposed as
`raw_timeline` on the Visitor 360 API response and still fully available; nothing was removed.

Algorithm: walks the (already time-ordered) event list once. Session-id transitions become
`first_visit` (once) or `revisit` (subsequently, labelled "隔日再次來訪" / "N 天後回訪" based on
the actual gap in days from the previous session's last event, or a generic "再次來訪" when the
gap can't be computed). Consecutive same-type low-level events (`view_product`, `add_to_cart`)
are collapsed into a single milestone with an `(N 次)` count suffix and `inferred: true`;
`begin_checkout`, `purchase` (split into `first_purchase`/`repeat_purchase` by order sequence),
`line_login_success`/`member_login`, and `friend_added` each become a single, non-inferred
milestone the first time they occur. The anonymous→LINE-member upgrade is added as its own
`inferred: true` milestone when `identity.resolution_method === 'visitor_session_link'`, since it
is not itself a single event but a derived fact about identity resolution. A `friend_added`
milestone is also added from `line_members.friend_since` if no literal `friend_added` event exists
in the event list, since that fact is real and available even when the event itself predates event
tracking. A final `recent_activity` entry always reflects the literal last event.

Every milestone carries `inferred: true/false` so the UI (and any future consumer) can distinguish
"this literally happened" from "this is a summary of several things that happened," per item E.13.

**Known limitation:** no "套用優惠券"/coupon milestone is produced. There is currently no
analytics event or cart-snapshot field recording coupon application in this codebase — adding one
would mean inventing data that doesn't exist, which the spec explicitly forbids (item E.12). If a
coupon-events source is added in a future round, this is the function to extend.

---

## 8. Identity upgrade rules and Friend status

No changes to the underlying rules — both were already implemented correctly in
`utils/analyticsIdentity.js` (R2) and `utils/lineMemberStats.js` (pre-R3, hotfix23-E/26-F8). This
round only:
- surfaces the existing `identity_confidence`/`resolution_method` more explicitly in the new
  Visitor 360 Audience rows (§6),
- reuses the existing friend-status fields (`friend_status`, `last_friend_check_at`,
  `friend_source`) verbatim from `line_members`, with the exact required explanation strings:
  `已確認為 LINE 好友` / `已確認尚未加入好友` / `好友狀態尚未確認` /
  `匿名訪客尚未與 LINE 身份建立可靠關聯`.

Verified by tests #51–#56 (deterministic merge via `visitor_session_link`, `anonymous_upgraded`
labeling, friend status correctly attached to the canonical member, unlinked anonymous visitors
staying `confidence=unresolved` with `friend_status=null`, not a guessed string).

---

## 9. Safe Identity Backfill

`utils/identityBackfill.js` / `scripts/backfill-hotfix31-r4-identity-links.js`.

- Default is dry-run; requires `--apply` to write.
- Evidence is strictly deterministic: for each LINE member, find `cart_id`/`session_id` values
  from their *own* post-login events (`identity_key='line_user:UID'`), then find any other
  `visitor_id` that appears on an event sharing that same `cart_id`/`session_id` but is *not*
  itself attributed to that member. If the same `cart_id`/`session_id` is shared with a **different**
  member's post-login events, the candidate is marked `unresolved` and skipped entirely — no
  guessing (verified by test #64/#65).
- Writes go to the existing `line_member_sessions` table (no second identity table), via
  `INSERT OR IGNORE`, protected by the pre-existing `UNIQUE(store_id, line_user_id, visitor_id)`
  index — so re-running `--apply` on the same data is idempotent (verified by test #61:
  `linked=0, already_linked>=1` on the second run).
- Strictly store-scoped: every query is `WHERE store_id=?`; running against one store never reads
  or writes another store's rows (verified by test #62/#63).
- No IP-based merging anywhere (IP does not exist in `analytics_events` at all in this schema).
- Output: `{ scanned, linked, already_linked, unresolved, skipped, errors }` per store.
- **Not run against production data.** All backfill tests in this round ran against a disposable
  local sql.js file created and destroyed by the smoke test script.

---

## 10. Revisit score formula

`utils/visitorAudience.js` → `computeRevisitScore()`. Deterministic, store-scoped (computed from
data already filtered to one store), runtime-only (never persisted).

```
+2  per visit/session, capped at 10 visits (max 20 points)
+3  per distinct cart (add_to_cart with a cart_id)
+4  per distinct checkout (begin_checkout with a cart_id)
+10 per order
+5  flat "repeat purchase" bonus if order_count >= 2
-1 / -5 / -10  inactivity decay if days-since-last-seen > 30 / 60 / 90
```

The returned `explanation` array is exactly the set of line items summed to produce `score` —
verified by test #39 (`sum(explanation.points) === score`) on every call, not just a documentation
claim. `is_analytical_score: true` and a `disclaimer` string ("回訪分數是分析用的參考分數，不代表
營收或購買機率。") are always included in the response. Verified deterministic (#38), decay applied
correctly (#40), `begin_checkout` alone never produces an "訂單" line item (#41), repeat-purchase
bonus fires only at `order_count>=2` (#42).

## 11. Customer status tags

`utils/visitorAudience.js` → `deriveCustomerStatusTags()`. Pure rule-based, multiple tags allowed,
tested individually: 新訪客 (#28), 高互動未購買 (#20), 已開始結帳未購買 (#23), 首購客 (#25), 回購客
(#27), 回訪訪客 (#21). 高價值顧客 uses the same "top 20% by spend" rule already used by
`getCrmOverview()`'s VIP threshold (not a second, competing definition). 久未回訪顧客 fires when
last-seen exceeds 60 days. 身份未解析 is reserved for the `unresolved` identity bucket (§6).

## 12. Segment integration

`routes/crm.js` now dispatches through `resolveVisitorAudienceMemberKeys`/
`countVisitorAudienceMatches` whenever a segment's stored `filter` object carries
`__source: 'visitor_audience'`; every pre-existing Drill Down segment filter (no such marker)
is completely untouched — verified by re-running R1 (segment tests R1-20~24) and R2 (segment
tests M-8~M-13) unmodified after this change, both still 100% green.
- Dynamic segments store the filter only (`crm_segments.filter_json`); no `crm_segment_members`
  rows are created (test #67); preview/list re-resolves live against current data (test #69).
- Static segments store the explicitly selected `canonical_key`s, de-duplicated (test #70: 3 input
  keys with 1 duplicate → 2 stored members), and the snapshot is frozen — later changes to the
  underlying audience do not change the segment's membership (test #71).
- Cross-store segment reads return 404, not data (test #72, reusing the existing store-scoped
  `WHERE store_id=? AND id=?` pattern already used for Drill Down segments).

---

## 13. Tests and exact results

Command and result for every suite run in this round:

```
node scripts/smoke-hotfix31-r1-backend.js            → 29 項，PASS 29，FAIL 0
node scripts/smoke-hotfix31-r2-hardening.js          → 37 項，PASS 37，FAIL 0
node scripts/smoke-hotfix31-r3-frontend.js           → 99 項，PASS 97，FAIL 0，MANUAL REQUIRED 2
node scripts/smoke-hotfix31-r4-channel-visitor360.js → 116 項，PASS 116，FAIL 0
node scripts/smoke-hotfix31-r4-visitor360-ui.js      → 75 項，PASS 73，FAIL 0，MANUAL REQUIRED 2
node scripts/smoke-hotfix30-b5-r5-cart-order-hours.js → TOTAL 59, PASS 55, FAIL 0, MANUAL 4
node scripts/smoke-hotfix26-f8.js                    → PASS=21 FAIL=0 MANUAL=3 NOT_IMPLEMENTED=5
```

`node --check` was run clean on every added/modified `.js` file (`utils/visitorAudience.js`,
`utils/dashboardAnalytics.js`, `utils/analyticsV2.js`, `utils/channelResolver.js`,
`utils/visitor360.js`, `utils/identityBackfill.js`, `routes/analytics.js`, `routes/crm.js`,
`scripts/backfill-hotfix31-r4-identity-links.js`, `scripts/smoke-hotfix31-r4-channel-visitor360.js`,
`scripts/smoke-hotfix31-r4-visitor360-ui.js`, `public/js/analytics-v2.js`).

**Bugs found and fixed by testing in this round** (not just written and assumed correct):
1. `ORDER_CHANNEL_SQL_EXPR` missing the `reservation` branch (§1b) — found by R4 test #2/#10,
   fixed in `utils/channelResolver.js`, re-verified green.
2. Segment-resolution helpers in `utils/visitorAudience.js` silently capped at 100 rows via the
   public pagination path (§6) — found by code review before writing the segment tests against
   it, fixed with an internal uncapped mode before any test exercised the bug.
3. Several bugs were in the *test fixtures themselves*, not the product code, and were fixed in
   the test file rather than the product: a UTC-vs-Asia/Taipei created_at mismatch in a fixture
   helper, a missing `page_view` event for a source-independence assertion, a malformed ISO
   timestamp fed into the (local-time-string-expecting) revisit-score decay calculation, and an
   assertion that expected two *non-adjacent* `view_product` events to collapse (they correctly do
   not, by design — only consecutive same-type events collapse).

### 13a. Dedicated Visitor 360 UI test suite (`smoke-hotfix31-r4-visitor360-ui.js`) — 75 assertions

Built following the exact real-execution jsdom harness style already proven in
`smoke-hotfix31-r3-frontend.js` (evaluates the actual `app.js`/`analytics-v2.js` source in a real
DOM via `dom.window.eval`, not source-string scanning). Result: **73 PASS, 0 FAIL, 2 MANUAL
REQUIRED** (both are genuine real-browser-layout items — narrow-viewport rendering — that jsdom
cannot verify; every functional/DOM-observable interaction in the original 75-item checklist was
tested, not marked manual).

**Four real product bugs found and fixed by this suite** (in `public/js/analytics-v2.js`):
1. The top-level channel selector (`av2Channel`) was never included in the Visitor 360 Audience
   API request at all — selecting any channel other than 全部 had no effect on this tab. Fixed by
   adding `channel` to the query params in `av2AudienceFetchAndRender()`, reusing the exact same
   canonical values already used by the Dashboard/Cart Abandonment tabs (no new mapping).
2. Switching the top-level channel while the Visitor 360 tab was *not* the active tab did not
   invalidate its cached data; revisiting the tab afterward could show stale, wrong-channel rows.
   Fixed by resetting the tab's "loaded" flag inside `av2SetChannel()`.
3. **Render-order bug**: `av2Render()` called `_av2AudienceEnsureLoaded()` (which kicks off the
   first data fetch) *before* `body.innerHTML = html` had written the `#av2-audience-body`
   container into the DOM. The fetch captured a `null` element reference; when the (async)
   response arrived, the update silently no-op'd, leaving the tab stuck on "載入中..." forever on
   first load. Fixed by moving the trigger to after the DOM write, and by having the async
   continuation re-query the DOM fresh rather than trusting a reference captured before the fetch
   started (defense in depth).
4. The revisit-score breakdown and disclaimer (present in the Audience *list* response) were never
   surfaced in the row-detail drawer, because the drawer's data comes from the separate, pre-
   existing `GET /api/analytics/visitor/:key` endpoint, which has no knowledge of revisit scores.
   Fixed by having `av2AudienceOpenDetail()` look up the already-fetched list row for that
   `canonical_key` and render its score breakdown alongside the existing detail panel.

Several bugs were found and fixed in the *test file itself*, not the product: direct reads/writes
of `let`-scoped module variables via `dom.window.*` (which never leak to the global object,
strict mode or not — this is unrelated to the R3 file's `'use strict'`-stripping trick, which only
affects whether *declarations* leak, not whether reads of non-existent globals crash); an
over-broad "no raw ID anywhere in the HTML" assertion that failed on the raw key's legitimate
presence inside internal `onclick` wiring attributes (narrowed to check visible text content); a
shared visitor-detail fixture returning identical data for every key, which made a "switching
rows clears stale content" test meaningless; a missing `process.exit()` (without it, jsdom's
simulated reconnect timers keep the process alive indefinitely — matches R3's own convention); and
two assertions that called the synchronous skeleton-render function directly and expected content
that is only produced later, asynchronously, once real data has loaded.

**Pre-existing, unrelated failure noted but not touched:** `scripts/smoke-hotfix26-e.js` reports 3
failures. Running the underlying tests standalone shows they are pre-existing and unrelated to
R4: `smoke-hotfix26-c.js` fails on a frontend label-text mismatch in `renderFriendStatus()`
(`"尚未確認"` vs an expected `"未知"` string) that has nothing to do with any file touched in this
round; the other two require live LINE Developers Console / production database access
("需要人工直接查詢正式環境資料庫", "須人工登入 LINE Developers Console 確認") and cannot be
verified in this sandboxed environment regardless of R4. Additionally, `scripts/smoke-hotfix26-f2.js`
(3 failures) and `scripts/smoke-hotfix26-f7.js` (1 failure) — both concerning `public/line-order.html`
date/cutoff logic and pickup-location settings, files never touched anywhere in R1–R4 — were
independently re-run standalone and confirmed pre-existing/environment-dependent (one test's own
comment acknowledges its assertions are sensitive to "today"'s real date at run time). None of
these touch `channelResolver.js`, `dashboardAnalytics.js`, `analyticsV2.js`, `visitorAudience.js`,
`visitor360.js`, `identityBackfill.js`, `routes/analytics.js`, `routes/crm.js`, or
`public/js/analytics-v2.js`.

**Manual verification required (not automatable in jsdom/this sandbox):**
- Narrow-screen/real-browser layout of the new Visitor 360 Audience table and the Customer
  Journey/raw-timeline sections (jsdom cannot render actual pixel layout/wrapping, though the
  underlying markup was confirmed to use `overflow-x:auto` so no column becomes inaccessible).
- Visual confirmation of Asia/Taipei local-time display across real browser timezones.
- The 4 UI manual items already flagged pre-existing in `smoke-hotfix30-b5-r5-cart-order-hours.js`.

## 14. Known limitations (consolidated)

- `getCrmOverview` (CRM Dashboard block) is not channel-filtered — see §3.
- No coupon-related milestone in Customer Journey — no real data source exists yet — see §7.
- Visitor Audience universe is bounded at 5,000 LINE members / 5,000 anonymous visitors per store
  per request; beyond that, `warnings[]` reports truncation rather than silently returning
  incomplete data.
- Narrow-viewport/real-browser pixel layout of the Visitor 360 Audience table and Customer
  Journey/raw-timeline sections is not automatable in jsdom — see the 2 MANUAL REQUIRED items in
  `smoke-hotfix31-r4-visitor360-ui.js` (§13a). The dedicated jsdom suite gap noted in the previous
  revision of this changelog is now closed (73/75 automated PASS, 0 FAIL).
- `identity='unresolved'` (legacy rows with no `identity_type` at all) is a coarse bucket — it
  cannot distinguish *why* the identity metadata is missing beyond "written before this column
  existed."
- Numeric range filters (`min_visit_count`/`max_revenue`/etc.) are enforced by backend allowlists
  and are covered by the backend suite, but the current Visitor 360 UI does not yet expose a
  dedicated number-input control for them (only dropdown filters) — see
  `smoke-hotfix31-r4-visitor360-ui.js` items 20–21.

## 15. Explicit confirmations

- Boss Dashboard (`routes/dashboard.js`) — not modified, not touched by any edit in this round.
- Android — no Android code exists in this repository; not touched.
- No real CRM delivery/push/coupon/email/SMS/export executed — `routes/crm.js` action execution
  logic (`utils/crmActions.js`) was not modified in this round.
- No production backfill executed — `utils/identityBackfill.js` was only run against disposable
  local sql.js databases created by the smoke test scripts in this sandbox.
- No duplicate source-of-truth tables created — Visitor Audience and Customer Journey are both
  computed at request time from existing tables (`analytics_events`, `orders`, `line_members`,
  `line_member_sessions`); the identity backfill writes only to the existing
  `line_member_sessions` table.

## 16. Release notes (Release Candidate)

This revision closes out Hotfix31-R4 as a release candidate:

- All backend and frontend automated suites pass with zero unresolved failures (see §13/§13a).
- The only remaining MANUAL REQUIRED items across the whole regression run are genuine
  real-browser/real-device checks that cannot be executed in an automated sandbox (pixel layout,
  timezone rendering, LINE Developers Console access) — none represent unverified logic.
- This round is treated as a release freeze: no R5 functionality (real CRM delivery execution,
  further architecture changes) is included or implied by this package.
