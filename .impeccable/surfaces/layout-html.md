# Cashflow Log working surface

## Scope and mode

Operate. The entire single-page cashflow logger: the phone-first capture surface, the month overview, recent-entry history, and the household/security settings. One shell serves both the family member on a phone and the Sheet owner on desktop.

## Audience and job

The primary visitor is a family member in a shop or at the kitchen table, holding a receipt, who needs to log an expense or income in a short interaction and trust that it landed in the family's own Sheet. The secondary visitor is the Sheet owner on desktop, administering the same surface. The page succeeds when a receipt becomes a verified row without spreadsheet work, and when the month's spend, income, net, and outstanding reimbursement are readable at a glance.

## Constraints

- Feature set frozen: capture, Gemini extraction and reconciliation, review, splits, multi-currency, dashboard, history/search/edit/reimburse/Trash, budgets, recurring, reporting, backup, household, sessions, PIN, Sheet and Gemini setup.
- Apps Script HTML partials + Google Sheets + Gemini; no framework or build step.
- English UI; IDR/Jakarta primary data; general-adult accessibility; 44px phone targets; no formal WCAG certification.
- Mobile bottom navigation with four destinations; dark default with a light theme; no reference-only finance features.

## Chosen direction and memorable moment

Envelope Binder: a family budget binder made precise. A graphite desk holds matte envelope panels, binder tabs, stamped states, and big tabular numerals. Amber marks the active tab and primary action; green stamps income and reimbursement. The memorable moment is the capture envelope's amber binder tab sitting directly under the compact month strip, with the month's spend, net, and reimbursement stamp readable before the camera buttons.

## Unresolved decisions

None for this build. Publication remains a separate explicit request.

## Direction contract

THESIS: The working surface is a family budget binder, not a dashboard of cards: one spread holds the month's numbers, the capture envelope, and the four sections, and the category-default hero-metric dashboard is refused in favor of a compact strip that yields to capture.

OWN-WORLD: Graphite desk (#0E0D0C dark / #ECEAE5 light), matte envelope surfaces (#171513 / #FAF8F4), hairline rules, 24px envelope geometry, amber (#F0A44B / #E08A32) for active tabs and primary actions, green (#9ED8A9 / #2E6A49) for income stamps, system sans in a tight display scale, tabular numerals, and drawn 1.9px line icons.

STORY: The visitor sees the month first, understands that the envelope below is where a receipt or line goes, logs it, and can check or correct it in the same binder. The owner finds every administrative surface under the same Settings destination.

FIRST VIEWPORT: On a phone: top bar with brand, access pill, theme and settings; compact month strip with month tab, spent hero, net, count and reimbursement stamp; the New entry envelope with its amber binder tab; camera and gallery immediately visible above a sticky Log entry dock and four-tab bottom nav. On desktop: a sticky left binder rail, the editorial cover and steps on the left, and the large entry envelope on the right with its summary strip above.

FORM: Envelope Binder, position 5 of 7, seed:a033bee5371c2ebc

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
