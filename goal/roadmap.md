# Cashflow Log — UX, Session, Quick-Input, and Performance Roadmap

**Status:** Ready for implementation planning  
**Repository:** https://github.com/berliandro/expense-logger  
**Baseline inspected:** `main` at `597d5b6bc83e90ce9f22775a52c18398f91db02d`  
**Primary files:** `Index.html`, `Code.js`, `appsscript.json`  
**Purpose:** Implement the collected UX and workflow ideas while making the app feel fast on low-spec devices, without weakening authentication, losing user input, or damaging existing spreadsheet data.

This file is the execution source of truth for the next goal. Start by inspecting the current local worktree; the repository may have moved since this document was written. Do not assume this baseline is still HEAD.

## 1. Product goals

1. Make every real asynchronous operation visibly responsive, while never showing a misleading permanent loading state.
2. Make Recent Logs feel immediate by preloading data after authentication and fetching subsequent pages in the background.
3. Consolidate recovery into one Trash menu item.
4. Make access visibility manageable from the app only if the deployment API supports a safe, genuine access change.
5. Replace the oversized, bold intro with a concise usage guide and move detailed explanations to “How it works”.
6. Show compact, useful access and session status in the header.
7. Add globally configurable session duration and activity-based renewal.
8. Add a reliable session-expiration timer and timely warnings.
9. Put Table Layout first, rename Standard to Quick-Input, and implement a fast receipt-processing path.
10. Add an optional one-row-per-receipt output mode.
11. Measure and reduce server latency, startup work, rendering cost, and dropped frames on low-spec devices.

## 2. Confirmed product decisions

- **Table Layout** is the left tab and the default/initial tab.
- **Quick-Input** replaces the existing “Standard” tab and appears to the right of Table Layout.
- Quick-Input always uses Force-save behavior. It is not intended to produce a fully detailed ledger.
- In Quick-Input, an unreadable or missing final receipt total is the reason to leave a receipt in the interface for review. A readable total plus a mismatch should be retried, then saved with a clearly disclosed balancing adjustment.
- Use up to **two additional bounded repair attempts** for Quick-Input when the total is readable and item sums do not reconcile. Never loop without a cap. Evaluate latency and model/token cost while testing.
- A shared user note is repeated for each receipt, while each receipt gets its own extracted-item summary.
- Optional **one row per receipt** mode writes one spreadsheet row for each receipt no matter how many items it contains. Description uses the receipt title or a concise generated summary. Notes contain the user's note plus that receipt's own item list, quantities, and prices. Category and spending type use the AI's dominant classification where applicable.
- A later enhancement may offer a toggle to prompt for classification and a short AI-filtered dropdown of candidate classifications. Treat that picker as a future extension, not a blocker for the first implementation.
- Session configuration is **global for every user** of this web app.
- Desired session duration options: **1 hour through 7 days**, with a proposed default of **3 hours**.
- **Refresh countdown on activity** is enabled by default. Warn that disabling it means the session expires at its fixed time even while the user is active.
- The header status pill goes to the right of the light/dark control. Public access uses a green dot; private access uses a red dot. Show the remaining session time only when 30 minutes or less remain and activity-based renewal is disabled.
- Warn when a non-renewing session has 10 minutes or less left, including immediately after page load if it is already inside that window.
- Preserve existing transaction IDs, entry IDs, row grouping, submission idempotency, Trash retention/recovery, sorting, reconciliation, and the existing /exec URL wherever supported.
- No actual app code, deployment, or spreadsheet data should be changed while merely editing this roadmap. During implementation, do not rewrite existing transaction IDs or ledger history as a shortcut.

## 3. Repository facts and constraints

At the inspected baseline:

- `Index.html` is a single-page frontend of roughly 180 KB of source, with roughly 106 KB of inline JavaScript and 48 KB of inline CSS.
- The stylesheet contains multiple `backdrop-filter` declarations, substantial shadows, transitions, and visual overlays. These are profiling candidates, not proven causes of low FPS.
- A CSS spinner and skeleton shimmer already exist, and the entry submission pipeline already presents processing statuses. Reuse a common pattern rather than adding unrelated indicators for every operation.
- PIN auto-submit happens on the sixth digit and disables the submit button while the request is pending; its pending state is not visually obvious enough.
- The current history client calls `getRecentLogs(sessionToken, offset, limit)`. Its button is disabled while waiting, but there is no clear local history-loading state.
- `getRecentLogs` reads the data ranges of all eligible month sheets, collects rows, sorts the full list by date, and only then returns the requested page. Preloading will hide latency, but it does not by itself reduce the backend work.
- Trash already has one modal with Entries and Transactions filters, but the Settings menu currently has two separate entry buttons to open the respective filters.
- The session backend currently uses a 12-hour constant and stores hashed session tokens mapped to expiration timestamps in Script Properties. Validation checks expiration; it does not currently slide/refresh the expiration on user activity.
- `appsscript.json` currently contains `executeAs: USER_DEPLOYING` and `access: ANYONE_ANONYMOUS`.
- The README says the script executes as the deploying user and that the app's PIN/session layer gates sensitive calls. Do not confuse that app-level PIN with Google's deployment-level access permission.

Use the actual current code as ground truth whenever it differs from this snapshot. Do not trust this roadmap more than tests or inspected code.

## 4. Execution strategy

Work in small phases. Before each phase, inspect related code and call paths; implement the smallest safe change; add regression tests; then report results. Preserve the existing lightweight Apps Script + single-page frontend architecture unless measurements demonstrate a clear reason to change it.

Prioritize low-risk UX improvements first. Treat deployment visibility and identity verification as a security-sensitive feasibility gate. Do not invent a workaround or present a cosmetic toggle as real access control.

### Phase 0 — Baseline, inventory, and safety checks

1. Confirm current branch, HEAD, worktree status, repository layout, deployment configuration, local testing harness, and available browser automation.
2. Read the relevant current implementations in `Code.js`, `Index.html`, and `appsscript.json`: PIN setup/login/session validation; settings menu; all calls through `google.script.run`; history loading/rendering; receipt extraction and reconciliation; commit/idempotency; delete/restore; and deployment/update tooling.
3. Search every caller of session functions and all mutation paths that affect Recent Logs, including receipt commits, single-entry deletion, whole-transaction deletion, entry restoration, and transaction restoration.
4. Capture a baseline for:
   - first usable page render and JavaScript startup;
   - PIN entry to unlock completion;
   - authenticated page initialization/configuration checks;
   - first Recent Logs response and DOM render;
   - subsequent history-page response and render;
   - scroll/interaction smoothness on desktop and a representative low-spec mobile device or CPU-throttled browser.
5. Record real timings rather than guessing. Separate Apps Script/server latency from front-end rendering and presentation delay.

**Exit criteria:** a concise map of the relevant functions, current tests, baseline timings, and risk areas exists in the implementation report or test notes. No production data or settings are changed.

### Phase 1 — Responsive controls and concise interface

#### 1.1 Consistent busy states

Create or reuse small shared helpers for button/operation busy states. Apply them at minimum to:

- Show recent 10, Show 10 more, and Refresh;
- PIN auto-submit on the sixth digit, as well as manual submit;
- configuration checks and settings saves;
- Trash loading/refresh/recovery;
- deletion, restore, and other existing server calls that currently offer no indication of pending work.

Requirements:

- Show feedback only while a real operation is pending or while displaying the intentionally brief cached-results reveal described in Phase 2.
- Make the active control visually distinct, disabled where duplicate submission would be unsafe, and restore it on both success and failure.
- Preserve useful labels (for example, concise “Checking…” or “Loading…” states), use the existing spinner/skeleton style where appropriate, and add `aria-busy`/accessible status text where sensible.
- Prevent multiple PIN submissions while the sixth-digit request is in flight. Avoid clearing or changing a valid PIN in a way that lets the user unintentionally issue parallel login requests.
- Always return controls to a usable state after errors, auth expiry, or a cancelled operation.
- Do not use a decorative spinner after a request has already finished or imply that a server operation succeeded before the server confirms it.

#### 1.2 Tab order and naming

- Change the visual/DOM order so Table Layout appears on the left and is selected by default.
- Rename Standard to Quick-Input everywhere user-facing, including tab text, accessibility labels, empty states, processing/status copy, and intro instructions.
- Preserve existing tab panel IDs or update every reference and test them; do not leave stale ARIA controls or event handlers.

#### 1.3 Rework intro and “How it works”

- Reduce the oversized/bold intro. Keep the title, but make the intro a concise, informative usage guide with a clear visual flow/diagram.
- Make the basic workflow clear at a glance: add receipt photo or note → extract and check → save to the month sheet.
- Explain how rows map to receipts and that each photo is a separate receipt. Include the shared-note behavior and how per-photo references such as “first photo” or “photo 3” work.
- Explain that empty rows are ignored and how to open a receipt's full image where appropriate.
- Keep the intro short, not a duplicate manual. Move detailed reconciliation behavior, retries, Force-save adjustments, Auto-discount behavior, and technical batch details into “How it works”.
- Shorten reconciliation control titles to **Force-save** and **Auto-discount**. Give each a brief, accurate description under the title. Keep extended explanations in “How it works”.
- Preserve theme support, keyboard navigation, mobile readability, and reduced-motion behavior. Inspect desktop and mobile screenshots after the update.

#### 1.4 Merge recovery entry points into Trash

- Replace the two Settings menu items “Recover deleted entries” and “Recover deleted transactions” with one **Trash** item.
- Open the existing modal from this single entry point. Keep its Entries and Transactions filters/tabs and all current restore safeguards.
- Preserve 7-day server-timestamped retention, ID integrity, conflict handling, and refresh-after-restore behavior.
- Test both filter choices, both recovery types, empty Trash, expiry, duplicate-ID conflict, and menu open/close behavior.

**Exit criteria:** the controls have clear in-flight feedback; Table Layout is left/default; Standard is renamed; the intro is useful and concise; detailed behavior remains documented; Trash is one menu entry; visual regression checks pass at desktop and mobile widths.

### Phase 2 — Preload and cache Recent Logs

#### 2.1 Data flow

1. Do not fetch private log data before a valid session exists.
2. After authentication has been validated and the main interface is unlocked, allow the initial UI to render first, then start the first-page history request in the background. Use an appropriate deferred task with a fallback; do not block unlock or the entry form.
3. When the user first clicks Show recent 10:
   - If the first page is ready, reveal the cached rows with a subtle pseudo-loading cue shorter than one second.
   - If the background fetch is still pending, display a real loading state and render the result immediately when it arrives.
   - If it failed, show a recoverable error and provide a way to retry.
4. After the first 10 rows have rendered, request the next 10 rows in the background.
5. When Show 10 more is pressed, use the cached page immediately when available, then prefetch the next page.
6. Refresh must fetch fresh data instead of treating the previous cache as current. Provide a short cached-result cue only when it is genuinely showing cached rows; never hide a slow/failing network request behind a fake completion.
7. Prevent duplicate fetches for the same offset. If a refresh happens while requests are pending, ignore stale responses or use request generations so an older response cannot overwrite newer data.
8. Preserve accurate counts, end-of-list handling, empty-state text, and current newest-first ordering.

A good UX constraint is a subtle cached reveal delay around 250–500 ms, with a hard cap below 1 second. Do not deliberately delay a real request that takes longer than this.

#### 2.2 Cache invalidation

Invalidate or refresh the cached pages after any successful operation that may alter history, including:

- transaction commits and successful idempotent duplicate responses;
- deletion of one entry or an entire transaction;
- restoration of an entry or whole transaction;
- any other supported operation that inserts, removes, or changes visible log rows.

If Recent Logs is open after a mutation, refresh its visible data. Do not invalidate it for a failed mutation. Keep sorting deterministic when entries have identical timestamps.

#### 2.3 Backend cost

Measure the current full-history scan. Preloading is primarily perceived-latency improvement; do not claim it has reduced server work unless measurements prove this.

After measuring, optimize `getRecentLogs` if the scan is significant. Investigate safe options such as reading only required columns/ranges, walking month sheets in a provably correct order, a short-lived cached first page, or a recent-log index. Any index/cache approach must remain correct after backdated inserts, deletion, restoration, sorting, and migration of legacy rows. Avoid adding an index that becomes a second, inconsistent source of truth.

**Exit criteria:** the first page is usually available before the user opens history; later pages are prefetched; refresh and mutations cannot leave stale/duplicated results; first-page and subsequent-page timings are measured; correctness tests cover the cache lifecycle.

### Phase 3 — Global session settings, renewal, and expiration UX

#### 3.1 Session configuration

- Replace the fixed 12-hour assumption with a validated global configuration stored server-side in Script Properties.
- Allowed duration is an integer choice from 1 to 168 hours inclusive. Proposed default is 3 hours.
- Add the global toggle **Refresh countdown on activity**, default ON. Make it clear that when OFF the session expires at its fixed expiry, regardless of activity.
- These settings are shared by every web-app user. Label the settings as global and confirm before applying changes that affect all users.
- Keep server-side session expiration authoritative; never rely only on a browser timer.
- Keep session tokens opaque. Never expose hashes, API keys, deployment OAuth tokens, or other server secrets in the client or logs.
- Continue rate-limiting invalid PIN attempts and preserve existing setup/change-PIN/logout behavior.
- Design and test how changed global settings affect existing sessions. Do not silently resurrect expired sessions or unexpectedly give existing sessions more time. Preserve current valid sessions safely during migration; document the chosen behavior.
- Migrate the current sessions map carefully (currently hashed token → numeric expiry). Support old-format entries during migration or provide a safe one-time migration. Avoid race conditions when multiple users' session updates overlap. Do not rewrite session state for every mousemove.

#### 3.2 Activity-based renewal

- When enabled, meaningful user activity extends the server-side expiry to the configured TTL. Use trusted user-interaction events such as keyboard input, pointer/touch interaction, and clicks; do not count a timer tick as activity.
- Throttle/debounce renewal so it cannot flood Apps Script calls or repeatedly rewrite Script Properties. A practical initial target is at most one renewal call per 60 seconds, adjustable based on measurement.
- Return the authoritative expiry to the client and persist it using the existing session mechanism, without ever persisting the PIN.
- Revalidation after tab visibility changes or device sleep must reconcile the display with the server's recorded expiry.
- When renewal is OFF, no activity event may move the server expiry.

#### 3.3 Expiration monitoring and notifications

- Start a client timer only after session validation. Use the server-returned expiry time, not a locally guessed duration.
- When renewal is OFF and remaining time reaches 30 minutes, update the header pill with a concise countdown. Before then, show only the access visibility status.
- When renewal is OFF and remaining time is 10 minutes or less, display a clear in-app warning. If the app is loaded with 9 minutes remaining, display the warning immediately.
- At expiry, notify the user and force the authenticated view back behind the PIN gate / revalidate the session. Do not leave sensitive controls usable after the server says the session expired.
- The user requested a refresh/unload after expiry. If a hard page reload is used, warn first or preserve a safe draft; never silently discard text or selected receipt photos. Prefer locking the protected interface and requiring reauthentication unless a safe refresh path is proven.
- Display each warning once per expiry window rather than repeatedly interrupting the user. Make the timer robust across sleep, background tabs, clock changes, and network failure.

**Exit criteria:** session TTL is configurable and global; activity renewal is server-enforced and throttled; the status pill and 10-minute warning are correct; expiry removes protected access; the user is not silently stripped of unsaved entries; migration and concurrent-session tests pass.

### Phase 4 — Real Public/Private visibility and email access feasibility

This phase is security-sensitive. Complete a feasibility spike before making the Settings UI look operational.

#### 4.1 Understand actual access semantics

The current manifest has `executeAs: USER_DEPLOYING` and `access: ANYONE_ANONYMOUS`.

Google's documented access values are MYSELF, DOMAIN, ANYONE (signed-in users), and ANYONE_ANONYMOUS (signed-in or anonymous users). See the [web app manifest reference](https://developers.google.com/apps-script/manifest/web-app-api-executable) and [deployment API documentation](https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments).

Intended basic mapping:
- **Public** = ANYONE_ANONYMOUS.
- **Private** = MYSELF (only the deployer of that deployment can access it), unless a documented API test or the user-approved semantics establish a different meaning.

The shared app PIN is not Google deployment access control. Public mode still requires the app's PIN/session for protected app calls.

#### 4.2 Prove the deployment API can safely change access

- Inspect the available Apps Script deployment/update API methods and manifest/version semantics.
- Determine whether the existing deployment's real access mode can be switched from a backend call while preserving its deployment ID and /exec URL.
- Use a disposable test project/deployment first. Do not test by locking the live deployment to MYSELF.
- Confirm authorization scopes, required enablement, API request shape, expected error modes, rollback, and post-change behavior.
- A deployment update may involve a new code version and manifest. Do not assume an ordinary update request necessarily changes the entry-point permission merely because appsscript.json contains an access value.
- Any access-change OAuth token must stay server-side. Never send ScriptApp.getOAuthToken() or another owner credential to the browser.
- Require a separate deployer-configured owner/admin secret or other proven owner-only authorization before allowing a caller to switch access. The shared family PIN alone is insufficient: it would let anyone who knows it lock out every other user.
- On switch, use an explicit confirmation dialog stating the actual effect. Private/MYSELF can immediately prevent family members from opening the app; explain the owner recovery route before applying it.
- The status pill must reflect the verified actual deployment configuration returned by the server, not a front-end flag.

If live switching cannot be performed through a supported, secure method, **do not ship a fake toggle**. Implement accurate read-only status and explain the manual deployment requirement until a safe method is established.

#### 4.3 Investigate per-email access without sharing the script or spreadsheet

The user wants a specific email to be able to use only the web app, without gaining Apps Script editor or Google Sheet access.

- Research a securely verified Google identity/ID-token flow compatible with this deployment executing as the deployer. Google documents that Session.getActiveUser().getEmail() can be blank in a web app that executes as its developer; do not assume it is a reliable external-user identity source. See the [Session reference](https://developers.google.com/apps-script/reference/base/session).
- If a secure verified-email allowlist is technically practical, design it as a distinct signed-in-user access mode, likely using Google sign-in plus server-side token validation/audience and allowlist checks. Never trust an email string submitted by the browser without cryptographic verification.
- Do not share the Apps Script project or spreadsheet as a shortcut to grant web-app access. Preserve execute-as-deployer and data isolation.
- Do not combine per-email allowlisting with the Public/Private pill without defining the distinction. A public anonymous app, an owner-only deployment, and a signed-in allowlisted web app are different modes.
- If reliable individual identity cannot be verified without unacceptable deployment/account changes, state the limitation and ship only the safe basic modes. Do not weaken the PIN/session layer.

**Exit criteria:** a written, tested feasibility result; no user sees a misleading switch; the basic visibility feature is only shipped if real deployment access can be changed and verified; owner lockout/recovery has been tested; per-email access has either a secure design and passing tests or an explicit documented limitation.

### Phase 5 — Quick-Input workflow

#### 5.1 Mode-specific behavior

- Quick-Input is a distinct rapid-capture flow; do not silently change Table Layout behavior or its existing toggle preferences.
- Quick-Input uses Force-save policy automatically. Do not ask the user to enable Force-save in this mode. Explain briefly that Quick-Input is not recommended for users who need fully detailed line-item logging.
- Keep the existing two-phase design: identify each receipt's final total first, then extract line items.
- If the final total and numeric value are reliably found but the extracted items do not reconcile, retry with a bounded number of repair attempts (maximum two extra attempts). Use existing adaptive batching and token/payload budgets. No unbounded retries.
- Once the readable total has been checked and the bounded retry policy is exhausted, save the receipt using a clearly labeled balancing adjustment. Never present that adjustment as a real extracted item.
- If the final total cannot be reliably located/read (missing/uncertain total label or amount), keep only that receipt for review and make the reason visible. Do not guess a total or invent one to bypass review.
- In multi-receipt submissions, accept and remove successfully committed receipts independently while leaving receipts without a reliable total for review.
- Only remove a receipt from the UI after the server confirms it was logged or safely recognized as an idempotent duplicate. Do not lose it when an unrelated receipt fails.
- Reuse stable submission/row IDs and existing commit/idempotency protections.

#### 5.2 Multi-photo camera experience on Android

- The current frontend has a rear-camera file input using capture=environment and a separate multiple-file gallery picker.
- A file input's multiple attribute allows users to select multiple files; capture requests camera capture but browser/device behavior varies. See [MDN capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture) and [MDN file inputs](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file).
- Test on real Android Chrome and the actual Apps Script web-app iframe. Prototype a persistent in-app camera using getUserMedia and repeated captures only if permission, secure-context, iframe, camera-switch, and memory behavior are reliable.
- If the platform will not support a reliable multi-shot session, provide the best supported fallback: camera capture plus multiple gallery selection. Do not promise that the native camera supports multiple photos merely because the input has multiple.
- Release object URLs and image resources when photos are removed or committed. Do not load full-size image previews unnecessarily where thumbnails suffice.

#### 5.3 One row per receipt toggle

Add a compact toggle such as **One row per receipt** with a short description. It affects only Quick-Input.

When ON:
- Produce one spreadsheet row per receipt, regardless of extracted line count.
- Description is the printed/AI-extracted receipt title, or a concise title synthesized from reliable extracted facts when the title is absent.
- Amount equals the receipt's final verified total for expenses/income according to the existing transaction sign convention.
- Notes preserve the user's shared note and add a summary of that receipt's extracted items, including quantities and prices. Separate items clearly; preserve negative discounts/deductions and don't fabricate missing prices.
- When the total/item mismatch requires Force-save, keep one spreadsheet row: record the balancing adjustment transparently in Notes, not as a second spreadsheet row, while the final Amount follows the verified total.
- For several receipts, repeat the original user note in each row but include each receipt's own items only.
- Use the dominant classification. Ensure the result fits existing schema columns; preserve Date, Type, Merchant, Category, Spending Type when applicable, Transaction ID, and Entry ID semantics.

When OFF:
- Preserve item-level rows as the default Quick-Input behavior.

Future extension, not required for this goal: add an optional classification prompt with an AI-filtered dropdown of a few plausible classifications. Keep the data contract ready for this without building a complex classification UI prematurely.

**Exit criteria:** accepted receipts disappear only after successful commits; receipts lacking a reliable final total remain reviewable; readable-total mismatches follow bounded retries then a transparent balancing adjustment; multi-receipt notes and item summaries remain correctly isolated; one-row mode writes exactly one row per receipt and reconciles Amount to the verified total.

### Phase 6 — Profile and reduce rendering cost

Optimize based on measurements, not aesthetics alone.

#### 6.1 Benchmark scenarios

Measure before and after on the same device/browser conditions:
- initial cold load and first usable control;
- PIN unlock to interactive;
- first History reveal and next-page reveal;
- long Table Layout with many receipt rows and thumbnail previews;
- long Recent Logs list;
- opening/closing Settings, Trash, confirmation dialogs, and full-photo viewers;
- light and dark themes; reduced-motion mode;
- mobile touch, scrolling, and typing during DOM updates.

Use Chrome DevTools Performance and CPU throttling where appropriate, plus a real low-spec Android phone/PC when available. Record device/browser, sample size, median and worst/95th-percentile timings where practical, and dropped-frame evidence. Aim for stable 55–60 FPS on representative hardware where feasible, but report measured results rather than promising an untested universal frame rate.

#### 6.2 Candidate optimizations to test

- Reduce or remove heavy backdrop blur/saturation selectively on low-end/mobile contexts or use simpler translucent backgrounds where profiling shows paint/compositing cost. Preserve the visual identity where possible.
- Simplify expensive stacked shadows, transitions, large overlay effects, and nonessential animation. Respect reduced-motion preferences.
- Avoid repeated forced layout/reflow. Batch DOM insertion, such as with DocumentFragment, when it reduces measurable rendering work.
- Keep page startup light; defer nonessential tasks until after the first usable render and authenticated unlock.
- Keep the one-page app unless actual results justify splitting it. Moving code into separate files alone is not a performance win.
- Reduce Recent Logs server cost only after measuring the full-history scan. Keep chronological correctness with legacy rows and backdated transactions.
- Check thumbnail handling, object URL cleanup, row creation/removal, and large-form performance. Avoid expensive image processing or compression unless quality, memory use, and end-to-end speed all improve.

Do not remove useful feedback, accessibility support, input checks, authentication, reconciliation, or data integrity to improve a benchmark.

**Exit criteria:** the report shows baseline vs. post-change measurements; each retained optimization has measurable benefit or is clearly marked as a maintainability-only change; desktop and mobile visual regressions are inspected.

### Phase 7 — Regression, security, and release

Run the existing local test harness and browser tests available to OpenCode. If no test harness is available in the current worktree, identify that fact and use the smallest project-compatible verification approach; don't add heavy permanent tooling without a reason.

Add regression coverage for:

- loading states on success/failure/auth expiry and duplicate-action prevention;
- PIN auto-submit and failed-login recovery;
- history cache/preload, paging, refresh, stale-response protection, empty history, and cache invalidation after every history mutation;
- unified Trash menu with both filters, delete/restore, conflicts, and expiry;
- session migration, 1-hour and 7-day boundaries, global settings, activity refresh ON/OFF, throttling, warning thresholds, and expiry re-lock;
- visibility state mapping, actual deployment update/readback, owner-only authorization, failure/rollback, stable /exec URL, and lockout recovery (only if feasible);
- Quick-Input retries, readable vs unreadable final totals, Force-save adjustment, partial success, mixed receipts, notes, and idempotent commit;
- one-row-per-receipt Amount, Notes, classification, negative discount handling, and exactly-one-row guarantee;
- layout order, tab names, mobile usability, reduced motion, keyboard/screen-reader states, and visual regressions;
- performance measurements for agreed scenarios.

Keep all existing suites passing. The most recently reported baseline was backend 63, ops 15, queue 6, rows 9, submit 10, Trash DOM 17, and UI 42; the local runner is authoritative if the current counts differ. Do not claim tests ran unless they actually ran.

Before release:
1. Review the full diff and confirm only intended files changed.
2. Search for leaked secrets, logs containing session/token/key data, unsafe client-trusted identity, and endpoints that bypass `requireSession_`.
3. Confirm transaction/entry IDs, ledger idempotency, sorting, Trash recovery/retention, and monthly-sheet structure have not regressed.
4. Test desktop and mobile with synthetic/test data; do not publish screenshots containing real receipts or private financial data.
5. If deploying is part of the existing workflow, update the existing deployment rather than create a new one, preserve the same /exec URL, and verify live behavior. Do not flip production visibility until the safe rollback path has been confirmed. If live deployment access cannot be tested safely, leave deployment untouched and report what the owner must do.
6. Commit and push only after the test battery is green and the final diff is understood. Report commit SHA, files changed, suites/results, real timing deltas, visibility feasibility, deployment status, and any deliberately deferred item.

## 5. Overall acceptance checklist

- [ ] No operation appears idle while a real request is pending.
- [ ] Cached Recent Logs display with a brief sub-one-second pseudo-loading cue; actual slow requests display real loading state.
- [ ] The first history page preloads only after authentication; next pages preload after the current page is shown.
- [ ] Refresh and every history mutation invalidate stale cache safely.
- [ ] Trash is one Settings menu entry, retaining separate Entries/Transactions filters and existing safety rules.
- [ ] The intro is concise and useful; detailed reconciliation stays in “How it works”.
- [ ] Force-save and Auto-discount controls have short titles and descriptions.
- [ ] Table Layout is the left and default tab; Quick-Input is the right tab.
- [ ] Header pill is immediately right of the theme control, displays verified access status with red/green indicator, and displays the countdown only under the conditions specified above.
- [ ] Session options cover 1–168 hours with a 3-hour proposed default; renewal preference is global and ON by default.
- [ ] Session activity refreshes are server-enforced and throttled; expiration is server-authoritative and cannot leave protected operations open.
- [ ] Access switching is a real supported deployment change, owner-authorized, reversible, and confirmed against actual configuration—or it remains a clearly documented limitation without a fake switch.
- [ ] Specific-email access is either implemented via verified identity with no script/sheet sharing, or reported as unproven/deferred.
- [ ] Quick-Input uses bounded retries, only blocks unreadable final totals for review, and discloses balancing adjustments.
- [ ] Multi-photo camera capture is tested on Android; a reliable fallback exists.
- [ ] One-row-per-receipt mode writes exactly one row per receipt and preserves note/item summaries and stable IDs.
- [ ] Performance gains are backed by repeatable before/after evidence on representative low-spec conditions.
- [ ] Existing tests pass, new regression tests pass, final diff is reviewed, and deployment/release status is reported accurately.

## 6. Official references

- Apps Script web-app manifest access and execution modes: https://developers.google.com/apps-script/manifest/web-app-api-executable
- Apps Script web-app deployment guide: https://developers.google.com/apps-script/guides/web
- Apps Script deployment management API: https://developers.google.com/apps-script/api/how-tos/manage-deployments
- Apps Script deployment REST resource: https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments
- Apps Script Session identity limitations: https://developers.google.com/apps-script/reference/base/session
- MDN capture attribute and browser limitations: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture
- MDN file input and multiple file selection: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file
