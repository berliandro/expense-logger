# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a family member logging and checking household cashflow on a phone: often in a shop with a receipt, or at home checking the month. They are a general adult user, not a specifically older or low-vision audience, and they expect a clear, ordinary mobile app.

The Sheet owner is a secondary user on desktop: installing the app, connecting the Sheet and Gemini key, and administering household members, budgets, recurring items, sessions, backup, and Trash. Both audiences share one web app and one PIN gate; there are no separate user accounts.

## Product Purpose

Cashflow Log turns a receipt photo, a short note, or a typed line into verified rows in a family's own Google Sheet. It exists so a household can keep a trustworthy month-by-month record without spreadsheet work, a paid finance service, or a third-party account.

Success means a family member can log a receipt or line on a phone and see it reflected in the month sheet in a short interaction, while the owner keeps full control of the data and can review, correct, recover, or export it. A row is either verified against the receipt total or visibly held for review; nothing unverified is saved silently.

## Positioning

A self-hosted family cashflow logger that combines Gemini receipt extraction with exact printed-total reconciliation and writes into the family's own Google Sheet. The differentiator is not generic expense tracking; it is the receipt-to-verified-sheet row path plus local ownership of the data.

## Operating Context

- One family, one private Google Sheet, and one shared 6-digit PIN/session gate. Family members log on phones; the owner administers on a desktop.
- Primary deployment settings are Asia/Jakarta and IDR, with optional per-entry currencies and exchange rates. The interface language is English; Indonesian appears in examples and real data.
- Receipts arrive as photos (JPG, PNG, WEBP, HEIC) or as notes/typed lines. Missing dates default to today; photos are optional for manual entries.
- The financial month lives in `MMMM yyyy` sheets copied from a `Template`, with system-managed Transaction and Entry IDs. Receipt images, when retained, live in a hidden sheet rather than Drive.
- Deleted rows move to a 7-day Trash. Budgets, recurring due items, reimbursements, and household attribution are part of the monthly workflow.
- Users may be offline or on a weak connection; drafts and selected photos survive a reload or session expiry.

## Capabilities and Constraints

Current capabilities, all of which the redesign must preserve:

- **Capture:** multiple receipt photos, notes/templates, manual entries, and a quick single-line path; advanced currency, tags, member, review, duplicate, and one-entry-per-receipt options.
- **Extraction and reconciliation:** Gemini reads receipts and notes; two-phase printed-total reconciliation; a bounded repair/review path; duplicate fingerprinting; Receipt photos follows its fixed automatic policy, while Manual entries exposes the Save anyway option.
- **Data model:** month sheets, Transaction and Entry IDs, splits, tags, household members, reimbursement tracking, multi-currency with a base total.
- **Insight:** monthly dashboard with spent/income/net, daily dots, anomalies, budgets, and recurring due items.
- **History:** cached recent entries, search and filters, edit, mark reimbursed, delete a single entry or a whole receipt, Trash restore, and pagination.
- **Reporting and data:** monthly PDF report, JSON backup/restore, optional compressed receipt previews, no Drive scope.
- **Security and admin:** PIN and session gate, session duration/active sessions/revoke, Sheet and Gemini setup, entry settings, household, Trash, and settings.

Non-negotiable constraints:

- Self-hosted Google Apps Script plus one private Google Sheet; no third-party finance account.
- Gemini extraction and exact printed-total reconciliation remain central.
- PIN/session privacy and 7-day Trash recovery remain.
- The feature set is frozen for the visual redesign: no capability is added or removed. The visual world and composition may change, but every current behavior must remain reachable.
- Existing stack: Apps Script HTML partials, client HTML/CSS/JS, Google Sheets, Gemini, clasp deployment. No framework or build step is being introduced.
- Current UI language is English; localization is not in scope for the redesign.

Open surface decision: navigation and composition are intentionally left to `shape`. A different navigation shell is acceptable only if it exposes existing areas without losing a capability; the shape brief must settle this.

## Brand Commitments

- The product name is **Cashflow Log**. The current "C" monogram and the cream/Georgia/burnt-orange visual world are not binding; the user has requested a replacement visual world.
- Voice: plain, warm, specific family language. Use real terms such as receipt, entry, month sheet, household, reimbursed, and Trash; avoid generic finance jargon.
- The user supplied two mobile finance reference images as inspiration for the replacement visual world. They are a visual bar, not a feature specification: no reference-only capability (Send/Receive, Cards, Rewards, invoice payment, crypto promotion) is in scope.
- The app remains a private household tool, not a commercial SaaS; no pricing, testimonials, or growth claims may be introduced.

## Evidence on Hand

- Product and feature truth: `README.md`, `docs/feature-backlog.md`, and the implemented app in `Layout.html`, `Styles.html`, `App*.html`, and `Backend*.js`.
- Quality evidence: six Node test suites in `tests/`, detector/type scans, prior critique snapshots in `.impeccable/critique/`, and current desktop/mobile screenshots in `docs/screenshots/` using synthetic demo data.
- Live deployment: the current Apps Script web app is published with the same `/exec` URL; deployment state is recorded locally in `.cashlogger-deployment-id` (git-ignored).
- User-supplied visual references: `C:\Users\nberl\Downloads\546d6b1d4c75294dc39fc4d11b337168.jpg` and `C:\Users\nberl\Downloads\a0825c2f5f50339f4ce22f8f49f6423f.jpg`. These are inspiration only; they carry no product data or claims.
- Absences future work must not fabricate: no real customer financial data, testimonials, benchmarks, pricing, or third-party case studies exist in the repository.

## Product Principles

1. **Phone-first logging.** The primary job is capturing a receipt or line quickly on a phone; administration follows and must not crowd that path.
2. **Verified rows, not guesses.** Reconcile against the printed total or hold the entry for review. Never imply that an unverified row was saved silently.
3. **The family owns the data.** Keep the app self-hosted and the Sheet private; protect it with a PIN/session gate and recoverable deletion.
4. **Quiet, predictable operation.** Every existing capability stays reachable, but the working surface stays calm and legible rather than exposing every control at once.
5. **Replace the presentation, not the product.** The visual world and composition may be replaced; behavior, data, and feature scope are frozen.

## Accessibility & Inclusion

The confirmed bar is a **general adult default**: standard readable contrast, visible keyboard focus, sensible touch targets (44px on phone), clear error/empty/loading states, and no reliance on color alone. No formal WCAG 2.2 AA certification and no specific older or low-vision optimization is required; the redesign must not regress the current accessibility behavior.
