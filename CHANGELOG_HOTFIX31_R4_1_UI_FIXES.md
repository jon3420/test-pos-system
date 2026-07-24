# CHANGELOG — Hotfix31-R4.1：Channel Label Consistency × Visitor 360 Selection UX × Dropdown Readability

## 1. Scope

Small, UI-focused follow-up to Hotfix31-R4. No new features, no architecture changes, no database
schema changes, no production backfill, no Android/Boss Dashboard changes, no second channel
resolver. Fixes exactly three confirmed problems and adds a dedicated test suite for them.

## 2. The three reported problems and their root causes

### 2a. Cart Abandonment detail rows showed generic mode labels instead of the canonical channel

**Symptom:** the detail table showed "外帶"/"外送" (generic order-mode labels) while the top-level
selector uses "店內 POS"/"LINE 外帶"/"LINE 外送"/"宅配"/"預訂" — the two never matched, and a
POS-entered takeout order looked identical to a LINE-ordered takeout order.

**Root cause:** the table's "模式" column and the drawer's subtitle read the raw `order_mode`
column through a locally-hardcoded label map (`AV2_ORDER_MODE_LABEL` in
`public/js/analytics-v2.js`), completely bypassing the canonical channel resolver
(`utils/channelResolver.js`) that the top-level selector already uses. The backend row-building
functions (`utils/cartSnapshot.js`) never even queried the `order_channel` column that gets
computed and stored at event-write time — they only had `order_mode` available.

**Fix:** added `order_channel` to the relevant `analytics_events` queries in
`utils/cartSnapshot.js` (`getFirstTouchMap`, and the `getCartDetail` event query), exposed a
canonical `channel`/`channel_label` field on both `getOpenCartRows()` rows and `getCartDetail()`,
reading directly from the existing `order_channel` column (never re-inferred), falling back to
`'unknown'` when absent/invalid. The frontend table header changed from "模式" to "渠道", and both
the table cell and the drawer subtitle now render `channel_label`, with a shared
`_av2ChannelLabel()` helper that reads labels from the backend-supplied
`channel_filter.labels` (the same object the top-level selector's label map ultimately derives
from) instead of a second, locally-hardcoded mapping. The now-unused `AV2_ORDER_MODE_LABEL`
constant was removed.

A small, related label drift was also found and closed: `utils/channelResolver.js`'s
`ORDER_CHANNEL_LABELS.shipping` said `"冷藏宅配"` while the frontend's top-level selector already
independently hardcoded `"宅配"`. Aligned the canonical source to `"宅配"` (matching what users
already saw on the top-level selector), eliminating the drift rather than creating a new one.
Confirmed via `grep` that no other file/table/setting depends on the old `ORDER_CHANNEL_LABELS`
string (the many other `"冷藏宅配"` occurrences in the codebase are the unrelated, pre-existing
"Cold-Chain Shipping Center" product feature name in Boss Dashboard/settings, not this label map).

### 2b. Visitor 360 row selection had no visible highlight

**Root cause:** `av2AudienceOpenDetail()` fetched and rendered visitor detail into a separate
drawer element, but never recorded *which* row triggered it anywhere the table-rendering function
could see, so no row ever got styled differently.

**Fix:** added `_av2AudienceOpenKey` (module state) tracking the currently-open row's
`canonical_key`. `_av2AudienceRowHtml()` now checks this against each row and, when it matches,
applies a `.av2-audience-row-selected` class plus an inline background/box-shadow (belt-and-
suspenders — works even if the stylesheet isn't loaded), `aria-selected="true"`/`"false"`, and
switches the row's action button between "詳情" (closed) and "查看中" (open, with distinct
active styling). Opening a different row moves the highlight (only one row is ever marked
selected). Clicking the *same* already-open row now toggles it closed (`av2AudienceCloseDetail()`)
— a small, intentional UX decision within scope, since the bug report specifically asked for a
"詳情 / 查看中 / 收合"-style active-state button. Every state-changing entry point
(`av2AudienceApplyFilter`, `av2AudienceClearFilters`, `av2AudienceGotoPage`, `av2AudienceSetSort`,
`av2AudienceSetLimit`, and channel switches via `av2SetChannel`) funnels through
`av2AudienceFetchAndRender()`, which now calls a single `_av2AudienceClearSelection()` at its top
— so filtering/sorting/paging/channel-switching can never leave a highlight pointing at a visitor
who is no longer in the current result set. A separate `_av2AudienceRerenderRowsOnly()` helper
updates just the `<tbody>` for highlight changes without wiping the already-open detail drawer
(re-rendering the whole `#av2-audience-body`, as the existing fetch/render path does, would
otherwise blank out the currently-displayed detail on every unrelated re-render).

### 2c. Visitor 360 dropdowns were unreadable when highlighted/selected

**Root cause:** the six filter `<select>` elements used an inline style with
`background:var(--bg-secondary)` — a CSS variable that **is never defined anywhere** in
`public/css/main.css`. It silently resolved to nothing, so in practice the select (and, in many
browsers, its native option popup) fell back to a near-default/transparent background while the
text color was still explicitly set to `var(--text-primary)` (near-white) — exactly the
"near-white text on an undefined/near-white background" combination the bug report described.

**Fix:** replaced the broken inline style with a scoped `.av2-select` class (defined in
`public/css/main.css`) using CSS variables that actually exist (`--bg-card`, `--text-primary`,
`--border`, `--accent`), plus explicit rules for `.av2-select option`,
`.av2-select option:checked`, `.av2-select option:disabled`, and `.av2-select:focus`. Scoped to
this one class so no other page's `<select>` styling is touched (verified: the pre-existing
`.settings-card input, .settings-card select` rule and friends are untouched).

## 3. Files added

- `scripts/smoke-hotfix31-r4-1-ui-fixes.js` — this round's dedicated test suite (81 assertions).
- `CHANGELOG_HOTFIX31_R4_1_UI_FIXES.md` — this file.

## 4. Files modified

- `utils/cartSnapshot.js` — added `order_channel` to `getFirstTouchMap()`'s and `getCartDetail()`'s
  queries; added canonical `channel`/`channel_label` fields to both functions' returned rows;
  imports `ORDER_CHANNELS`/`ORDER_CHANNEL_LABELS` from `utils/channelResolver.js` (reused, not
  duplicated).
- `utils/channelResolver.js` — one label value changed: `ORDER_CHANNEL_LABELS.shipping`
  `"冷藏宅配"` → `"宅配"` (see §2a).
- `public/js/analytics-v2.js` — Cart Abandonment table header/cell/drawer subtitle now use the
  canonical channel field and a shared label helper (removed `AV2_ORDER_MODE_LABEL`); Visitor 360
  Audience rows/detail-open logic gained selected-row state, highlight rendering, toggle-close
  behavior, and a rows-only re-render helper; the six filter `<select>` elements switched from a
  broken inline style to the `.av2-select` class.
- `public/css/main.css` — added the `.av2-select` rule block (dropdown readability, §2c) and the
  `.av2-audience-row-selected` rule (row highlight, §2b), both purely additive/scoped.

No other files were modified in this round. (`routes/analytics.js`, `routes/crm.js`,
`utils/analyticsV2.js`, `utils/dashboardAnalytics.js`, `utils/visitor360.js`,
`utils/visitorAudience.js`, `utils/identityBackfill.js`,
`scripts/backfill-hotfix31-r4-identity-links.js`,
`scripts/smoke-hotfix31-r4-channel-visitor360.js`, `scripts/smoke-hotfix31-r4-visitor360-ui.js`
show up in a diff against the original upload only because they were already added/modified in
Hotfix31-R4, carried forward unchanged into this round — except for one line in
`scripts/smoke-hotfix31-r4-visitor360-ui.js`: test "57" was updated because R4.1 intentionally
changed same-row-click behavior to toggle-close (§2b); the test's *intent* — no duplicate stacked
detail blocks — is unchanged, only the scenario used to verify it, since the old scenario
(re-opening the identical key) now legitimately closes the panel instead of re-rendering it.)

## 5. Canonical channel labels (unchanged mapping, now consistently displayed everywhere)

| channel value | label |
|---|---|
| `pos` | 店內 POS |
| `line_takeout` | LINE 外帶 |
| `line_delivery` | LINE 外送 |
| `shipping` | 宅配 |
| `reservation` | 預訂 |
| `unknown` | 未知 |

## 6. Legacy/unknown fallback behavior

`analytics_events.order_channel` can be `NULL` for historical rows written before this column
existed. `utils/cartSnapshot.js` treats any value that is not a member of `ORDER_CHANNELS` (which
includes `NULL`) as `'unknown'` — it never falls back to inferring a channel from `source` alone,
and never silently promotes an unknown row to `line_takeout`/`line_delivery`. This is the same
existing canonical resolver's `unknown` bucket used everywhere else in R4, not a new fallback rule.

## 7. Selected-row behavior

See §2b. State: `_av2AudienceOpenKey` (canonical_key or `null`). Visual: `.av2-audience-row-selected`
class + inline background/box-shadow + `aria-selected`. Action button: "詳情" (closed) / "查看中"
(open). Toggle: clicking the already-open row's button closes it. Every filter/sort/page/limit/
channel-change path clears the selection via a single choke point (`av2AudienceFetchAndRender()`).

## 8. Dropdown styling behavior

See §2c. Scoped class `.av2-select` with defined (not undefined) CSS variables; explicit
`option`/`option:checked`/`option:disabled`/`:focus` rules. Native `<select>` popup rendering is
browser-controlled and varies (particularly for hover states in Chromium's native popup), which is
why item §11's manual item exists.

## 9. Tests and exact results (this round)

```
node scripts/smoke-hotfix31-r4-1-ui-fixes.js → 81 項，PASS 80，FAIL 0，MANUAL REQUIRED 1
```

**Bugs found and fixed by running this suite (all in the test file itself, not the product):**
1. Fixture field-name mismatch: `FIXTURES` entries used `visitor_id`-shaped helper calls but were
   initially built with a `vid` key instead of `visitor_id`, so `insertEvent()` silently returned
   `false` (missing required field) for every fixture — no events were ever written, and every
   "cart detail can be queried" assertion failed. Fixed by renaming the fixture key.
2. A second, same-class field-name mismatch: the helper functions read `opts.cart_id`, but the
   `FIXTURES` array used the key `cart`, so every event was written with `cart_id: null`,
   `getCartDetail()` never found any events for the intended cart IDs. Fixed by reading `opts.cart`
   in the helper functions.
3. Test "27" (dropdown class check) queried `#av2-audience-body` (the inner list container) for
   `<select>` elements, but the filter bar lives in the surrounding `#av2-body` section — fixed by
   querying the correct element.
4. Test "42" (Cart Abandonment still renders "渠道") failed because the test's fetch mock never
   handled `/api/analytics/drilldown` at all, so the Cart Abandonment explorer table always
   received an empty response and rendered its "no data" state (which has no headers) instead of
   the real table. Fixed by adding a `DRILLDOWN_FIXTURE` with one real row to the mock.

**Regression found and fixed in the pre-existing R4 UI suite (`smoke-hotfix31-r4-visitor360-ui.js`):**
after implementing the intentional toggle-close behavior (§2b), that suite's pre-existing test
"57" (which called `av2AudienceOpenDetail()` twice with the *same* key and expected the detail
panel to still show content both times) started failing — correctly, since the second call now
closes the panel by design. This is not a regression in the product; it's a stale assumption in an
older test given a legitimate, spec-required behavior change. Fixed by rewriting the test to use
the scenario it actually intended to verify (opening a different visitor, then reopening the first
one — never opening the *same* key twice in a row) so it still proves "no duplicate stacked
detail blocks" without relying on same-key-reopen semantics that no longer apply.

## 10. Full regression (after all fixes above)

```
node scripts/smoke-hotfix31-r1-backend.js            → 29/29 PASS
node scripts/smoke-hotfix31-r2-hardening.js          → 37/37 PASS
node scripts/smoke-hotfix31-r3-frontend.js           → 97/99 PASS, 2 MANUAL REQUIRED
node scripts/smoke-hotfix31-r4-channel-visitor360.js → 116/116 PASS
node scripts/smoke-hotfix31-r4-visitor360-ui.js      → 73/75 PASS, 2 MANUAL REQUIRED
node scripts/smoke-hotfix31-r4-1-ui-fixes.js         → 80/81 PASS, 1 MANUAL REQUIRED
node scripts/smoke-hotfix30-b5-r5-cart-order-hours.js → 55/59 PASS, 4 MANUAL REQUIRED
node scripts/smoke-hotfix26-f8.js                    → 21/21 PASS, 3 MANUAL, 5 NOT_IMPLEMENTED
```

All `node --check` runs on every touched/new `.js` file passed clean. Zero unresolved failures
across the entire regression sweep.

## 11. Manual browser checks (cannot be automated in jsdom)

- Native `<select>`/`<option>` popup rendering in real Chromium and Firefox — CSS support for
  `option:hover`/native popup theming differs meaningfully by browser engine; this suite verifies
  the CSS rules exist with correct contrast direction, not the final rendered popup pixels.
- Narrow-viewport/real-device layout (carried over from R4, unchanged by this round).
- Asia/Taipei local-time display across real browser timezones (carried over from R4, unchanged).

## 12. Known limitations

- Native option-popup styling is inherently browser-controlled; `.av2-select` sets what the CSS
  spec allows browsers to honor, but cannot guarantee identical rendering across all engines.
- The row-highlight uses both a class and an inline style for robustness; this is intentionally
  redundant (same values), not a conflict — if `.av2-audience-row-selected`'s CSS is ever changed
  independently of the inline style, keep both in sync or remove the inline style.
- All other known limitations from the Hotfix31-R4 changelog remain unchanged and are not
  restated here.

## 13. Explicit confirmations

- Boss Dashboard (`routes/dashboard.js`) and `public/index.html` — byte-identical to the R4
  baseline (verified via diff).
- Android — no Android code exists in this repository; not touched.
- No database schema change — `utils/db.js` was not modified (identical `CREATE TABLE` count
  before/after); no new tables, no duplicate channel resolver (this round only adjusted which
  existing columns/labels are read/displayed).
- No production data modified — all testing ran against disposable local sql.js databases created
  and destroyed by the smoke test scripts.
- No CRM delivery/push/coupon/email/SMS/export executed.
- No identity backfill executed in this round (unchanged from R4; not touched here).

## 14. Rollback note

This round's changes are isolated to display/labeling and pure frontend UX state — no schema, no
API contract changes beyond additive fields (`channel`/`channel_label` are new, additive fields on
existing row shapes; nothing existing was removed except the now-redundant `order_mode`-based
label lookup on the frontend, and `order_mode` itself remains available on all rows). To roll back,
reverting `utils/cartSnapshot.js`, `utils/channelResolver.js`, `public/js/analytics-v2.js`, and
`public/css/main.css` to their Hotfix31-R4 versions (and removing the two new files) is sufficient
and requires no data migration.
