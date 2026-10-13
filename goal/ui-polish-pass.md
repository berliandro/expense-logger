# UI Polish Pass — Modal, Information Density, and Force-Save Only

## Goal

Make the interface match the user's screenshots and remove redundant explanation from the main entry workflow without changing established transaction correctness, session security, or receipt-preservation behavior.

This is an execution specification, not a brainstorming task. Make the decisions below as written. Do not add unrelated redesigns or speculative optimizations.

## Branch and production safety

- Work directly on `main`, starting from its current remote HEAD.
- Inspect the worktree first. Preserve all local changes. If the worktree is dirty or `main` moved during implementation, stop and report the situation rather than overwriting anything.
- The experiment branch is abandoned. Do not switch back to it or create another experiment branch for this goal.
- Do not run `clasp push`, update any deployment, change deployment visibility, or touch production Apps Script.
- Commit the finished work directly to `main`. Leave the working tree clean.
- Read this entire file before changing code. Treat the decisions and acceptance criteria here as authoritative.

## 1. Remove the stray page-ending character

The current `Index.html` has a literal standalone `>` after the first closing `</html>`, followed by duplicate `</body>` and `</html>` tags. Remove the stray character and duplicate closing tags so the document has one correctly ordered closing `</body>` and one closing `</html>`.

Add a regression check that the generated/source HTML does not end with the stray `>\n</body>\n</html>` artifact or duplicate document closers. Do not hide it with CSS; remove the malformed source.

## 2. Fix Session settings so it is a real modal

In the current CSS, `#sess-modal` is missing from the shared fixed fullscreen overlay selector used by `#pin-modal`, `#api-modal`, `#sheet-modal`, `#confirm-modal`, and `#trash-modal`. As a result, Session settings participates in document flow and looks like a card at the end of the page instead of a popup.

- Add `#sess-modal` to the shared overlay behavior, with a proper stacking level above the page, fullscreen translucent backdrop, viewport centering, and scroll-safe padding for short screens and mobile safe areas.
- The card must fit within the viewport (max-height with internal scrolling if needed), not extend the page height or move content. Lock background scrolling while the modal is open and restore it on close.
- Keep the existing server-side session validation and Save/Cancel logic unchanged except for any necessary modal lifecycle integration.
- Close by Cancel, backdrop click, and Escape. Prevent clicks inside the card from closing it. Restore focus to the Settings menu item that opened it, and focus the duration input when opening succeeds.
- Ensure asynchronous load/failure paths do not leave a blank, broken, or uncloseable dialog.
- Verify the actual visual positioning at desktop and phone-sized viewport widths; a DOM test alone is insufficient. Do not claim physical Android verification unless a real device was tested.

## 3. Header order: access status before theme toggle

The top bar currently orders the theme button before the access-status pill. Change the DOM order to:

1. Access status pill
2. Theme toggle
3. Settings button/menu

Keep the access status tied to the current session/server response. Do not change its security logic or fabricate a visibility value.

At narrow widths, keep the access pill immediately to the left of the theme button instead of hiding the entire pill. Collapse the environment suffix (Gemini · Sheets) and tighten padding/font size as necessary; preserve the actual access label and status dot. Make sure the brand and actions do not overlap or cause horizontal page overflow at 320px, 360px, 390px, 768px, and desktop widths.

## 4. Delete Auto-discount as a feature; keep Force-save

The final reconciliation UI must have exactly one optional reconciliation toggle: **Force-save**. Remove the separate Auto-discount setting and all behavior specific to that setting.

### Table Layout

- Show the Reconciliation options section in Table Layout only.
- It contains one switch: Force-save, OFF by default, with the short visible label only. Remove the long inline explanation and the expanded “How it works” text from the main form; the details will be available through an information button as specified below.
- With Force-save OFF, a mismatch that remains after the existing bounded repair stays reviewable.
- With Force-save ON, a mismatch may be committed only when the printed total was reliably read. After the bounded repair fails to reconcile it, add exactly one clearly labeled balancing line to bridge the difference: positive “Missing/hidden item” when the item sum is below the total, negative “Missing/hidden discount” when the item sum is above the total. Preserve the explanatory audit note. Never force-save unreadable/uncertain totals, invalid rows, or text-only entries.
- Preserve the existing per-row isolation, duplicate/idempotency behavior, transaction IDs, Entry IDs, and review-photo preservation.

### Quick-Input

- Hide the entire Reconciliation options fieldset and its Force-save control while Quick-Input is active. Quick-Input's behavior is automatic, so displaying a user toggle there is misleading.
- Preserve the defined Quick-Input policy: the reliably readable printed final Total is authoritative. Exact matching receipts save normally; a matching sum with `possibly_incomplete` list metadata saves with the incompleteness clearly disclosed in Notes/status; a mismatch gets the configured additional Quick-Input repair attempts, then is saved under the reliably read total with one explicitly labeled balancing line if still mismatched. A missing/unreadable/uncertain total remains in review. Never invent item detail to fill a gap.
- The Quick-Input behavior must be enforced server-side and must not depend on a hidden DOM checkbox or on a stale preference from Table Layout.
- Table Layout's Force-save preference must not leak into Quick-Input. Switching tabs must never alter saved preferences or the underlying transaction policy.

### Remove the Auto-discount code path safely

- Remove the Auto-discount checkbox, `toggle-discount`, `discount-note`, its state/listeners, CSS that only supported it, and obsolete explanatory text from `Index.html`.
- Remove new `autoDiscount` options/plumbing and the standalone Auto-discount policy branch from `Code.js`, plus unused `discountAdjusted` counters or UI handling that only exists for newly generated Auto-discount results.
- Update tests, fixtures, README, goal docs and user-facing copy. There must be no Auto-discount control or advertised Auto-discount feature in the app.
- **Important compatibility exception:** if existing submission-ledger records already have the historic status string `auto-discount-adjusted`, keep only the minimal legacy recognition needed to treat those records as already committed and avoid duplicate writes on retries. Never create new records with that status. Cover this behavior with a regression test.
- Do not remove the negative balancing-line behavior that belongs to Force-save. Force-save is the sole user-configurable mode and covers both directions when explicitly enabled in Table Layout.

## 5. Reduce on-screen text; move details behind accessible “i” buttons

The primary entry form is too text-heavy. Keep the interface understandable at a glance, and move secondary explanations into a reusable, accessible information dialog. Do not make explanatory content available only on hover.

### Main-screen copy decisions

- Under “New entry”, replace “Photo optional. Note optional. One of them required.” with **“Add a photo or a note.”**
- In Quick-Input, remove the large inline “Quick-Input logs fast…” explainer paragraph.
- Shorten the camera/gallery helper to **“Camera takes a new photo. Gallery lets you choose existing photos.”**
- Shorten the note placeholder to **“Optional note for these receipt(s)…”.** Remove the long example from the placeholder.
- Keep the useful Day meal / Work / Weekly / Monthly chips.
- Remove the long descriptive subtext under “One row per receipt”; keep the label and switch.
- Remove the long fine-print explanations underneath both submit buttons and the duplicated form-bottom paragraph. Do not remove actionable processing/error/success status messages.
- In Table Layout, keep the row count, rows, Add Row, Retry review rows, and Submit Batch controls. Remove the long static explanatory paragraph under Submit Batch from the main screen.
- Keep the current date badge, clear photo actions, field labels, and meaningful button labels. Do not remove the PIN/security gate or configuration feedback.
- Do not redesign the hero/intro, receipt history, Trash, or other unrelated surfaces.

### Information buttons and dialog

Implement one reusable information dialog (one source of truth for open, close, title, and content) with a small neutral circular **i** button adjacent to the relevant label/heading. It must be keyboard and touch accessible, with an accessible name, visible focus, Escape/backdrop/close-button dismissal, sensible focus management, and the same fixed/centered/scroll-safe modal treatment as other dialogs. Do not use alert(), hover-only tooltips, or raw HTML string injection for dialog content.

Add these buttons/content:

1. **Entry heading info button** — “How logging works”: a concise explanation of the two-phase process (read printed total, then extract line items), bounded repair, what remains reviewable, and that a typed note can be logged without a photo.
2. **Reconciliation options info button** (Table Layout only) — explain exact-match behavior, that Force-save creates one labeled balancing line only after repair and only with a reliable printed total, and that without Force-save unresolved mismatches wait for review.
3. **Receipt photos info button** — list JPG, PNG, WEBP, and HEIC support; Camera is one new capture at a time and Gallery supports selecting multiple existing files. Do not claim camera multi-shot capture.
4. **Note/Description info button** — explain that the note applies to all selected photos and that “first photo … third photo …” can distinguish individual receipts.
5. **One row per receipt info button** (Quick-Input only) — explain that each receipt becomes one spreadsheet row at the printed total and its individual item detail goes into Notes; quantity/unit price appear only if the receipt made them reliably readable.

Keep modal copy concise, practical, and consistent with actual behavior. On-screen “i” buttons must not shift or distort existing field alignment.

## 6. Tests and verification

First inspect the current tests and test commands; do not make up a new test runner or replace a working suite. Add/update tests for at least:

- HTML source has no stray trailing `>` and only one pair of closing document tags.
- Session modal has fixed fullscreen overlay styling, proper stacking, and is included in required CSS selector coverage; browser test proves it is centered and does not increase page height or show the extra trailing page character.
- Header DOM order is status pill → theme toggle → settings, including a narrow-screen check that the pill remains visible and right-aligned before the theme control.
- Quick-Input never renders/shows the reconciliation fieldset; Table Layout shows only Force-save, no Auto-discount UI text/element.
- Switching tabs does not leak a Table Layout Force-save preference into Quick-Input's fixed policy.
- Force-save OFF leaves unresolved mismatches reviewable; Force-save ON adds one positive or negative balancing line only for a reliable-total mismatch; unreliable totals are never force-saved.
- Quick-Input incomplete-but-matching, still-mismatched-after-repairs, and unreadable-total cases follow the policy in §4.
- Historical `auto-discount-adjusted` ledger records remain idempotent without generating new ones.
- Information buttons open the correct content, work via keyboard/touch, and close correctly; content is still accessible without hovering.
- No horizontal overflow or overlapping header controls at the specified viewports.
- Existing backend, queue, row, Trash, access, submit, and UI contract suites still pass.

Run syntax checks, all relevant suites, and live browser/DOM checks available in the repo. Inspect the final diff for stale references, accidental unrelated changes, security regressions, and lost receipt data. Update README and any existing screenshots only if you can produce valid new screenshots from the actual updated UI; do not hand-edit a screenshot to imply tested behavior.

## 7. Final report

Report each section separately as PASS / FAIL / PENDING with evidence. Include:
- commit SHA and branch name
- exact test commands and counts
- browser/viewports tested and findings
- any limitations or tests not possible in this environment

Do not claim physical Android testing unless actually performed. Stop after committing the finished work directly to `main`. No production deploy and no `clasp push`.
