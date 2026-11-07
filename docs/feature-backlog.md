# Cashflow Log — feature backlog

Prioritized ideas that fit the app's constraints: Google Apps Script, Gemini receipt
extraction, one private Google Sheet, and a phone-first workflow. Effort is a rough
guide (S = days, M = about a week, L = multi-week or needs a platform change).

The current pass already shipped: a flat light/dark system, removal of all background
blur and decorative gradients, a split template structure, a cached history read, batched
DOM rendering, and cached photo previews. The items below are the requested scope; the
status note records what is now live.

**Implementation status:** the requested scope is implemented in `BackendFeatures.js`,
`AppFeatures.html`, and the split backend modules. P0 items 1–10, P1 items 11–18 and 20,
and P2 anomaly/reimbursement/household are present. Backend work also added explicit OAuth
scopes, a measured/capped history scan, session metadata, correlation IDs, and a Gemini
per-minute quota guard. See the README feature list for how each surface is exposed.

---

## P0 — must-have (trust and data safety)

| # | Feature | Why it matters | Effort |
|---|---------|----------------|--------|
| 1 | **Draft autosave and recovery** | A reload, crash, or session expiry currently risks losing typed notes, table rows, and selected photos. Persist the draft locally (IndexedDB for blobs, localStorage for text) and restore it after unlock. | M |
| 2 | **Offline capture queue** | Reception and phone dead zones are common. Let the user capture a receipt immediately, queue the upload, and submit when online. Show a clear pending/synced state. | L |
| 3 | **Receipt review before commit** | A side-by-side sheet: photo on the left, extracted merchant/date/items on the right, inline correction, then commit. This is the single biggest accuracy win. | L |
| 4 | **Undo delete toast** | Deletion already goes to Trash for 7 days, but the only recovery path is the Trash modal. Offer a 10-second "Undo" action in the status area. | S |
| 5 | **Duplicate receipt detection** | Prevent double-logging the same receipt with a cheap fingerprint (merchant + date + total + image hash) and warn before commit. | M |
| 6 | **Edit existing entries** | Fix a merchant, category, note, or amount without deleting and re-adding. Write an audit note and preserve Transaction/Entry IDs. | M |
| 7 | **Search and filter recent logs** | With more than a few months of data, "Show 10 more" is not enough. Filter by month, type, category, merchant, amount range, and text. | M |
| 8 | **Explicit backup and restore** | A one-click download of the month sheets and system ledgers (CSV or XLSX), plus a documented restore path. | S |
| 9 | **Session/device list with revoke** | Show active sessions (device label, created, last seen) and allow "log out everywhere". Useful for a family app. | M |
| 10 | **Receipt image retention option** | Today photos are not kept after extraction. Offer optional Drive storage (per receipt, compressed) so a row can be reopened with its source image. | L |

## P1 — high-value (daily use)

| # | Feature | Why it matters | Effort |
|---|---------|----------------|--------|
| 11 | **Monthly overview dashboard** | The first screen after unlock: spend, income, net, top categories, and a 6-month trend. Reuse the cached history read; no extra sheet writes. | M |
| 12 | **Dot-matrix month gauge** | A compact 30/31-dot grid per month showing activity and current spend versus a budget. Fits the visual references and stays cheap to render. | S |
| 13 | **Budgets and soft alerts** | Per-category monthly budgets with a quiet warning at 80% and a summary at month end. | M |
| 14 | **Recurring transactions** | Rent, subscriptions, salary. A small rules sheet plus a "due" prompt; never auto-write without confirmation. | M |
| 15 | **Natural-language quick entry** | "Coffee 35k this morning" or "Salary 5jt" without a photo. The text path already exists; improve the prompt and confirmation. | S |
| 16 | **Multi-currency support** | IDR default, optional currency per entry, stored rate, and a monthly base-currency total. | L |
| 17 | **Receipt tags and splits** | Split a receipt across categories or people; tag entries for projects or trips. Add a tag filter. | M |
| 18 | **Shareable monthly report** | One-tap PDF or image summary for a month, suitable for family or reimbursement. | M |
| 19 | **Photo compression before upload** | Downscale to a readable maximum edge and re-encode as JPEG in the browser. Cuts upload time and Gemini payload without hurting OCR. | S |
| 20 | **Retry queue for failed batches** | Keep the failed rows and photos in the UI with a single retry action; today the user has to resubmit manually. | M |
| 21 | **Keyboard-first desktop flow** | Shortcuts for add row, submit, open settings, focus note, and toggle theme; a compact command palette later. | S |
| 22 | **Installable PWA shell** | Cache the static shell so opening the app is instant. Verify the Apps Script iframe/service-worker constraints before promising offline writes. | M |

## P2 — nice-to-have (delight and scale)

- **Voice notes** — record a short note and transcribe it before extraction.
- **AI category suggestions with confirmation** — a short, user-approved dropdown instead of silent classification.
- **Anomaly callouts** — "Groceries are 42% above your 3-month average".
- **Reimbursement workflow** — mark work expenses, track who owes what, mark paid.
- **Warranty and return tracker** — optional reminder dates attached to a receipt.
- **Household profiles** — attribute entries to a family member without separate Sheets.
- **Tax export** — category mapping and a year-end package.
- **Home-screen widgets / quick actions** — platform-dependent; evaluate only after the PWA shell.
- **Receipt OCR fallback** — a local OCR pass when Gemini is unavailable; heavy for Apps Script, so likely a separate worker.

## Backend and maintainability

- Split `Code.js` into `Auth`, `Sheets`, `Gemini`, `Trash`, and `History` files. Apps Script shares one global scope, so use clear prefixes and keep the same public entry points.
- Add a small backend test harness for pure functions and mocked `SpreadsheetApp`/`CacheService`; the current VM extraction covers only reconciliation policy.
- Add request correlation IDs to server errors and log them without tokens, PINs, or receipt contents.
- Add a per-session Gemini budget/rate limit, not just payload splitting.
- Measure and cap `getRecentLogs` scan cost as the sheet grows; the 120-second page cache is a bridge, not a permanent index.
- Add explicit `oauthScopes` to `appsscript.json` and document why each scope is needed.
- Add a migration checklist for header changes, new system columns, and Trash schema changes.

## Design opportunities from the references

The shared language in the references is consistent and worth keeping:

- warm off-white page, white flat cards, almost no shadow;
- serif display type for headings and large numbers, small sans labels for metadata;
- orange used for one meaningful signal or action per view, not as a wash;
- compact stat cards with a large number and a small unit;
- dot-matrix or tick-mark charts, which are cheap to render and feel more human than generic progress bars;
- generous spacing and a single strong alignment line.

Best first use in this app: a **monthly overview** at the top of Recent logs with three
compact stat cards (spent, income, net) and a dot-matrix month strip. It would read from
the same cached history data and add no new backend surface.

## Suggested next milestone

1. Draft autosave (P0 #1)
2. Undo delete (P0 #4)
3. Duplicate receipt warning (P0 #5)
4. Monthly overview + dot-matrix strip (P1 #11–12)
5. Search/filter (P0 #7)

That sequence improves trust first, then makes the growing log pleasant to use, before
adding heavier features such as budgets and recurring transactions.
