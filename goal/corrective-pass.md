# Expense Logger — Post-Roadmap Corrective Pass

**Purpose:** Fix verified gaps in the implementation committed as `47444a1`, without re-running the entire roadmap or undoing completed work.  
**Repository:** https://github.com/berliandro/expense-logger  
**Baseline for comparison:** `47444a1b9b2a9fca48e1f303f526a708cbbeb6d7`  
**Primary files to inspect:** `Code.js`, `Index.html`, `README.md`, `appsscript.json`, and the current tests.  
**Scope:** Correct misleading access status, Quick-Input review disposition, one-row receipt summaries, missing config-check feedback, and verify the specific outstanding acceptance criteria. No broad refactor.

The local worktree may contain newer work. Inspect it first and preserve any uncommitted changes. Treat current code and tests as ground truth if this file's baseline has moved.

## 1. P0 — Never show a false Public/Private status

### Verified gap

At the baseline, `Index.html` hardcodes the status pill as `Private · Gemini · Sheets`, while `appsscript.json` declares `access: ANYONE_ANONYMOUS`. The deployed web app's reported access configuration was unchanged. The pill therefore presents a false access claim.

### Requirements

1. The pill must never say **Private** unless that value was obtained from a trustworthy, current check of the actual deployment's access configuration.
2. It must never imply that the app is private merely because the app PIN/session gate is enabled. Application authentication and Google deployment access are separate.
3. The pill should be immediately to the right of the light/dark control, as already laid out.
4. When verified, show:
   - **Public** with a green indicator for `ANYONE_ANONYMOUS` (and define the display for any other genuinely public mode).
   - **Private** with a red indicator only for the specifically defined private mode that is verified by the server.
5. If access mode cannot be checked reliably, display an honest neutral state such as **Access unknown**, or hide the access label and clearly document why. Never silently default unknown to Private.
6. Access status must be derived server-side and tied to the actual deployment/configuration, not a client-only variable, localStorage, or a constant in HTML. Do not rely on `appsscript.json` source text alone if the live deployment has not been confirmed.
7. The app must not send `ScriptApp.getOAuthToken()`, owner OAuth credentials, script-admin credentials, or other secrets to the browser or logs.
8. The normal family PIN is shared authentication, not sufficient authorization for a deployment-wide visibility change. A user who knows the app PIN must not be able to lock everyone else out.

### Implement a real visibility setting only if safe and supported

The original requested feature is changing the real visibility from inside Settings.

- Re-check the current Google Apps Script Deployment API and the disposable-project proof of concept if it exists in the repository/session artifacts.
- Verify the deployment's current access setting through a trusted method, test actual mode changes against a disposable deployment, and verify that the same deployment ID and `/exec` URL remain valid.
- Design a genuinely owner-authorized operation before exposing a change control. If owner identity cannot be established under `executeAs: USER_DEPLOYING`, use a distinct owner-only authorization mechanism that is set up securely, validated server-side, rate-limited where appropriate, and never exposed in readable form to non-owner users. Do not use the shared family PIN as the owner authorization.
- Require an explicit confirmation that explains the consequence, especially that Private can immediately prevent other family members from opening the page. Test owner recovery before allowing Private to be enabled.
- Read back the actual deployment state after a successful change; update the pill only after the verified result.
- Test failed API calls, missing scopes, unauthorized changes, stale status, and rollback.

**Safe fallback:** If live switching cannot be made supported and owner-authorized, do not show an operational toggle. Ship an accurate, honest read-only status if it can be reliably verified; otherwise show Access unknown and document manual deployment management. Do not make unsupported claims or weaken security to achieve the toggle.

### Acceptance criteria

- [ ] With the current `ANYONE_ANONYMOUS` deployment, the interface never says Private.
- [ ] Public/Private indicator uses verified server-side access state, or explicitly shows Access unknown.
- [ ] No switch is shown unless its operation is real and securely owner-authorized.
- [ ] Any implemented switch changes and reads back the real access configuration on a disposable deployment before production testing.
- [ ] Owner lockout/recovery, failure, rollback, and unchanged `/exec` URL are verified.
- [ ] If deferred, the README and final report clearly describe the exact limitation and safe manual process.

## 2. P1 — Quick-Input must not send a readable-total receipt to review solely due to incomplete item-list metadata

### Verified gap

In `reconcileRow_()`, a receipt with a reliably found total and an item sum equal to that total is still returned as `uncertain` when `line_list_complete` is not `complete`. The Quick-Input Force-save policy currently handles mismatches with readable totals, but does not necessarily override this uncertain verdict. This contradicts the intended Quick-Input rule.

### Required disposition

Quick-Input and Table Layout have different policies. Do not globally weaken Table Layout review behavior.

For **Quick-Input only**:

1. The decisive review gate is whether Phase 1 reliably found the final printed Total label and its numeric value. A missing/uncertain/not-visible total, invalid numeric total, failed total extraction, or missing Phase 1 result must remain for review.
2. If the final total is readable but extracted items mismatch the total, use the existing bounded repair flow (initial repair plus no more than two additional Quick-Input repair attempts). If mismatch persists, save using a clearly labelled balancing adjustment.
3. If the total is readable and the item sum matches but the model marks the item list as possibly incomplete/illegible, Quick-Input must not leave the receipt for review solely for that completeness flag. It should be saved under the verified total with the incompleteness disclosure clearly recorded in Notes/status. Do not invent any item or price.
4. When the total is readable and valid but no trustworthy item details can be produced, use only a receipt-level summary/line if consistent with the existing schema and reconciliation contract; record that details are incomplete. Do not fabricate line items.
5. Ensure this policy is enforced at the authoritative server-side triage/commit layer, not just by changing client display status or removing the photo from the UI.
6. Do not alter Table Layout's existing incomplete-line review semantics unless necessary to keep the code safe; preserve its behavior as a separate policy.
7. If a total cannot be read reliably, keep that photo available for review even if other photos in the same batch are successfully committed.
8. Maintain stable row IDs, submission IDs, idempotency, partial success, ID allocation, sorting, and Trash semantics.

### Tests required

- Quick-Input: readable total + matching item sum + `line_list_complete: possibly_incomplete` is committed, with clear disclosure; not review.
- Quick-Input: readable total + mismatched item sum continues bounded repairs, then commits with a transparent adjustment after retries are exhausted.
- Quick-Input: total uncertain/not visible/no Phase 1 result stays for review even when Force-save is enabled.
- Mixed batch: readable-total receipts commit independently while only unreadable-total receipts remain.
- Table Layout retains its previous review behavior for incomplete line lists.
- Duplicate/resumed commit does not write duplicate rows.
- UI removes only server-confirmed receipts and preserves every review/error receipt and its note/photo.

### Acceptance criteria

- [ ] In Quick-Input, no receipt is sent for review solely because the line list is flagged incomplete when its final total is reliable.
- [ ] Unreadable/uncertain totals remain reviewable.
- [ ] Readable mismatches get the bounded retries and then a labelled adjustment if unresolved.
- [ ] Table Layout policy is unchanged.
- [ ] All tests above and the existing test battery pass.

## 3. P1 — Complete the one-row-per-receipt item summary and title behavior

### Verified gap

The current `condenseTxn_()` condenses each receipt into one row, but its item Notes summary only formats description and amount. The extraction schema does not preserve quantity/unit price as separate structured values. For multi-item receipts the description is a mechanical `Merchant (N items)` fallback, rather than using a receipt title or producing a helpful summary of reliable extracted details.

### Requirements

1. Keep exactly one spreadsheet row per receipt when the Quick-Input **One row per receipt** toggle is ON.
2. Preserve the receipt's verified signed final total in Amount (including the existing expense/income and negative deduction conventions).
3. Extract and preserve available item quantities and prices as structured fields where the provider/model can reliably return them. Audit all schemas, prompts, sanitization, repair calls, tests, and phase responses affected by adding optional quantity and/or unit-price fields.
4. Notes must contain the user's shared note plus only that receipt's item details. For example, where available: `Item name × quantity @ unit price = line total`. For quantity or unit price that cannot be reliably extracted, include the known description/amount without making up missing values. Preserve negative discounts and adjustment disclosure.
5. Keep the note replicated across receipts, but never mix the item list of one photo into another photo's Notes.
6. Prefer a reliable printed/extracted receipt title if present. If no title exists, make a concise title based only on reliable facts (for example, merchant plus a meaningful item/receipt summary). Do not invent a merchant, item, purpose, or financial fact just to produce a better title.
7. Preserve dominant Category and dominant Spending Type behavior, with Income spending type blank.
8. Preserve Date, Merchant, Type, Transaction ID, Entry ID, submission ledger/idempotency, and original source item details for debugging or review. Do not generate extra spreadsheet rows in one-row mode.
9. If structured quantity/unit price would raise extraction cost or break schema compatibility, implement the smallest safe optional schema extension and benchmark it. Do not use a brittle attempt to parse quantities out of free-text item descriptions if a structured field is available.
10. Update the UI description and README so the toggle explains the actual Notes output honestly.

### Tests required

- One receipt with one item; one receipt with many items; missing receipt title; missing quantity; missing unit price; discount/deduction line; Force-save adjustment; Income; multiple receipts sharing one note.
- Exactly one sheet row and one transaction ID grouping unit per receipt.
- Amount equals the expected verified signed receipt total.
- Notes contain that receipt's items and preserve the user's note without inventing quantities/prices.
- Existing item-by-item mode remains unchanged.

### Acceptance criteria

- [ ] One-row mode writes exactly one data row per receipt.
- [ ] Notes include quantities and prices wherever reliably available and never invent missing details.
- [ ] Titles are meaningful and grounded in receipt data.
- [ ] Existing schema-dependent tests, item-level mode, idempotency, and IDs remain correct.

## 4. P2 — Add feedback to automatic configuration checks

### Verified gap

After PIN unlock, `checkSpreadsheetAndKey()` and its follow-up checks call the backend without clear pending feedback. Other controls now use `cfBusyBtn()`, so this flow remains inconsistent with the loading-feedback requirement.

### Requirements

- Show a discreet, accessible, non-blocking status while checking Sheet configuration and Gemini API-key presence.
- Do not block interaction with the entry form during these checks.
- Only open the missing-Sheet/API-key modal once the server confirms that configuration is absent; transient failures should not be misrepresented as a missing configuration.
- Restore the status on success, missing configuration, auth expiry, and transient failures.
- Avoid duplicate configuration-check calls and prevent late responses from an old session from opening a modal after logout/session expiry.
- Never reveal the key or Sheet ID in the status. Continue to show only their presence/absence as appropriate.

### Acceptance criteria

- [ ] Unlock produces a clear but unobtrusive “Checking configuration…” state.
- [ ] The entry form stays usable during checks.
- [ ] Missing setup opens the correct prompt; transient failures are not called “missing”.
- [ ] Session expiry/logout cancels or safely ignores stale callbacks.
- [ ] Targeted tests cover success, missing config, transient failure, duplicate call, and expired-session paths.

## 5. P2 — Close verification gaps without pretending to test unavailable hardware

### 5.1 Android camera

The code intentionally uses honest single-capture camera input and multiple selection through Gallery. Do not claim a persistent multi-shot native camera was built.

- Complete all automated checks available for camera/gallery add, clear, add-more, input reset, preview count, object URL cleanup, and submission preserving file order.
- Test real Android Chrome inside the deployed Apps Script web app if an actual device is available.
- If no physical device is available in the current agent environment, record it as a manual acceptance test, not a code-completion blocker and not a passed test.
- Preserve the working camera + multi-file gallery fallback and accurate copy.

### 5.2 Phase 6 benchmark matrix

The completion report already provides some timings, including unlock/render timing, a 4× throttled test, scroll frames, and throttled FCP. Do not repeat those merely to generate more logs. Fill the significant missing scenarios that can be tested in the available harness:

- authenticated first Recent Logs request and next-page request, measured separately from rendering;
- long Table Layout with thumbnails and many rows;
- long Recent Logs list;
- Settings, Trash, confirmation modal, and full-photo viewer open/close;
- light/dark and reduced-motion paths;
- mobile viewport, scrolling, and typing under CPU throttling where the browser harness supports them.

Report environment, throttle level, repetitions/sample size, latency, and long-frame evidence. Compare with saved Phase 0 values if present. Don't change CSS purely for numbers: preserve the previous evidence-based conclusion if no bottleneck is found.

If no trustworthy baseline exists for a scenario, create a baseline measurement now and label it as such; do not imply an unavailable historical comparison.

### Acceptance criteria

- [ ] Android-specific manual verification is explicitly marked PASS only when done on device, otherwise remains visibly pending.
- [ ] Key missing automated/browser benchmark scenarios are tested where possible, with honest environment notes.
- [ ] No speculative performance refactor is made without evidence.
- [ ] Existing tests remain green.

## 6. Execution order and safety rules

1. Start in the current working tree. Inspect branch, HEAD, status, recent commits, and current diff. Preserve uncommitted work; never reset, clean, or force-push to recover from a conflict.
2. Read this corrective plan and the relevant sections of `goal/roadmap.md`. The current source code and actual tests are authoritative where comments/docs are stale.
3. Fix **P0 access status** first. Do not change live visibility until owner authorization, recovery, and rollback are proven.
4. Fix **P1 Quick-Input disposition** next, then complete **P1 one-row item summary/title**.
5. Implement the small **P2 configuration pending state**.
6. Close verification gaps that are possible in the current environment; leave physical-device checks explicitly pending if not performed.
7. Add targeted regression tests before running the full suite.
8. Audit every changed API caller, including triage, repair, commit, history mutation signals, and session handling.
9. Review the diff, run the complete existing test battery, scan for secrets, and ensure no endpoint bypasses server-side session/owner authorization.
10. Update README only where user-visible behavior changed or current claims would be false.
11. Commit and push only when changes and tests are understood and safe. Do not deploy automatically just because tests pass. If deploying, update the existing deployment and preserve its deployment ID and /exec URL. Keep the previous rollback version available.
12. Do not rewrite transaction/entry IDs or modify real financial data to make tests pass.

## 7. Final report required

State:
- exact commit SHA and push state;
- files changed;
- outcome of each section: fixed, deferred with evidence, or blocked;
- test suite names/counts/results (do not invent them);
- Quick-Input review behavior before/after;
- which source has confirmed the actual access mode and what the pill displays for the current deployment;
- whether a genuine secure visibility toggle is implemented or explicitly deferred;
- one-row receipt example of the resulting Description and Notes, using synthetic data;
- benchmark environments and results;
- Android real-device status;
- deployment version and /exec status if deployment happened, otherwise explicitly say not deployed.

Do not state “roadmap complete” if P0/P1 acceptance criteria remain unmet.
