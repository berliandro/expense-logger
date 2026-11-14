'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
// Index.html is a thin shell composed with HtmlService includes. Join the
// parts in serve order so the source contracts below cover the real output.
const PARTIALS = ['Index.html', 'Styles.html', 'Layout.html', 'AppCore.html', 'AppEntry.html', 'AppAuth.html', 'AppFeatures.html'];
const shell = read('Index.html');
const html = PARTIALS.map(read).join('\n');
const BACKEND = ['BackendConfig.js', 'Code.js', 'BackendAuth.js', 'BackendHistory.js', 'BackendGemini.js', 'BackendSheets.js', 'BackendSort.js', 'BackendFeatures.js'];
const code = BACKEND.map(read).join('');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

assert.equal(count(shell, /<\/body>/gi), 1, 'one body closer');
assert.equal(count(shell, /<\/html>/gi), 1, 'one html closer');
// A stray '>' is a character standing alone on its own line, so the pattern must
// anchor to a line break. A loose />\s*<\/body>/ would also match the legitimate
// "</script>" line that correctly precedes </body>.
assert.doesNotMatch(shell.trimEnd(), /(?:^|\r?\n)[ \t]*>[ \t]*\r?\n[ \t]*<\/body>/i, 'no stray >');
assert.match(shell.trimEnd(), /<\/body>\s*<\/html>$/i, 'correct close order');

const pillAt = html.indexOf('id="session-pill"');
const themeAt = html.indexOf('id="theme-toggle"');
const settingsAt = html.indexOf('id="settings-btn"');
assert.ok(pillAt >= 0 && themeAt > pillAt && settingsAt > themeAt, 'header order');
assert.doesNotMatch(html, /\.pill\s*\{\s*display:\s*none\s*!important?\s*;/i, 'status pill remains on mobile');
assert.match(html, /#pill-env,\s*\.pill-sep\s*\{\s*display:\s*none;\s*\}/, 'environment suffix collapses on mobile');

// --- Envelope Binder shell: rail, bottom tabs, strip, settings panel --------
assert.match(html, /class="binder-body"/, 'binder spread wraps the working surface');
assert.match(html, /id="binder-rail" aria-label="Sections"/, 'desktop rail is labeled');
assert.match(html, /id="binder-nav" aria-label="Sections"/, 'mobile nav is labeled');
for (const target of ['entry', 'overview', 'history', 'settings']) {
  assert.match(html, new RegExp('class="binder-nav-item[^"]*" data-binder-target="' + target + '"'), 'bottom tab: ' + target);
  assert.match(html, new RegExp('class="binder-rail-item[^"]*" data-binder-target="' + target + '"'), 'rail item: ' + target);
  assert.match(html, new RegExp('data-binder-panel="' + target + '"'), 'panel target: ' + target);
}
assert.match(html, /body\[data-binder-tab="overview"\] \[data-binder-panel="overview"\]/, 'mobile swaps panels by tab');
assert.match(html, /function initBinderShell\(\)/, 'shell controller is wired');
assert.match(html, /id="settings-panel-list"/, 'mobile settings has a panel list');
assert.match(html, /function refreshSettingsPanel\(\)/, 'settings panel mirrors the menu actions');
assert.match(html, /id="month-strip"[^>]*aria-label="This month"/, 'hybrid month strip is labeled');
assert.match(html, /id="strip-spent"/, 'strip shows month spend');
assert.match(html, /id="strip-net"/, 'strip shows net');
assert.match(html, /body\.locked \.binder-rail, body\.locked \.binder-nav/, 'locked gate hides the binder shell');
assert.match(html, /body\.locked \.month-strip/, 'locked gate hides the month strip');
assert.match(html, /@media \(min-width: 921px\)[\s\S]*?\.month-strip \{[\s\S]*?display: flex;/, 'desktop month strip sits above the capture envelope');
assert.match(html, /#submit-btn,[\s\S]*?background: var\(--accent-solid\)/, 'commit action is the amber primary action');
assert.match(html, /\.stamp-warn \{ background: var\(--accent-solid\)/, 'light stamp fill keeps ink contrast');
assert.match(html, /\.info-btn svg \{ width: 18px; height: 18px; \}/, 'info control is a drawn icon');
assert.doesNotMatch(html, />i<\/button>/, 'no text-glyph info controls');
assert.doesNotMatch(html, /id="dash-prev"[^>]*>‹</, 'month back control is a drawn icon');
assert.doesNotMatch(html, /id="dash-next"[^>]*>›</, 'month forward control is a drawn icon');
assert.doesNotMatch(html, /&#8943;/, 'row menu is a drawn icon');

const overlay = html.match(/#lock-screen,\s*#pin-modal,\s*#api-modal,\s*#sheet-modal,[^{}]*#info-modal\s*\{/);
assert.ok(overlay && overlay[0].includes('#sess-modal'), 'session modal uses overlay CSS');
assert.match(html, /#sess-modal\s*\{\s*z-index:\s*110;\s*\}/, 'session modal z-index');
assert.match(html, /#sess-modal \.lock-card,\s*#info-modal \.lock-card\s*\{\s*max-height:\s*calc\(100dvh - 32px\);\s*overflow-y:\s*auto;/, 'scroll-safe modal');
assert.match(html, /body\.modal-open\s*\{\s*overflow:\s*hidden;\s*\}/, 'background scroll lock');
assert.match(html, /Escape[\s\S]{0,180}closeSessModal\(\)/, 'session modal Escape close');

assert.equal(count(html, /<fieldset\b/gi), 1, 'one reconciliation fieldset opening tag');
assert.equal(count(html, /<\/fieldset>/gi), 1, 'one reconciliation fieldset closing tag');
assert.match(html, /\.recon-toggles\s*\{[^}]*margin:\s*0 0 10px;/s, 'tight bottom spacing after reconciliation options');
assert.match(html, /id="recon-options"/, 'reconciliation fieldset');
assert.match(html, /recon\.classList\.toggle\('hidden', isStd\)/, 'Receipt photos hides settings');
assert.match(html, /class="recon-toggles hidden" id="recon-options"/, 'reconciliation starts hidden in the photo-first default');
assert.match(html, /id="tabbtn-standard"[^>]*aria-selected="true"[^>]*>Receipt photos</, 'Receipt photos is the default tab');
assert.match(html, /id="tabbtn-table"[^>]*aria-selected="false"[^>]*>Manual entries</, 'Manual entries is the secondary tab');
assert.match(html, /class="chips-label"[^>]*>Templates</, 'template chips are labeled');
assert.match(html, /<b>Save as one entry per receipt<\/b>/, 'output switch names its consequence');
assert.match(html, /aria-label="Save as one entry per receipt"/, 'switch accessible name matches');
assert.match(html, /id="entry-meta"[\s\S]{0,1800}id="entry-reimb"/, 'entry flags live in Advanced');
assert.match(html, /Snap a receipt or type a line — the app fills the details\./, 'mobile model sentence');
assert.match(html, /Type what you bought and when — the app fills the details\. A photo is optional\./, 'manual entry hint');
assert.doesNotMatch(html, /To be reimburse\b|Day meal/, 'template typos removed');
assert.match(html, /id="tab-standard" class="tab-panel active"/, 'photo panel starts active');
assert.match(html, /show\('standard'\);/, 'photo-first default is wired in the tab controller');
assert.match(html, /\.hero-compact-note \{ display: block;/, 'mobile keeps a one-line intro');
assert.match(html, /id="quick-text-btn"[^>]*>Or log a single line</, 'typed entry stays available beside the note');
assert.match(html, /id="history-empty"/, 'empty Recent entries state');
assert.match(html, /id="history-empty-btn"/, 'empty state points back to the form');
assert.match(html, /id="hist-filter-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="history-filter-panel"/, 'filters start behind a disclosure');
assert.match(html, /<div class="history-filter-panel hidden" id="history-filter-panel"/, 'filter panel starts collapsed');
assert.match(html, /<option value="">All reimbursements<\/option>/, 'reimbursement filter names its scope');
assert.match(html, /function paintHistFilterCount\(\)/, 'the Filters control reports its active count');
assert.match(html, /\['hist-type', 'hist-category', 'hist-member', 'hist-reimb'\]\.forEach/, 'selects auto-apply');
assert.match(html, /addEventListener\('change', function \(\) \{ paintHistFilterCount\(\); runSearch\(\); \}\)/, 'select change refreshes the list');
assert.match(html, /id="hist-search"[^>]*aria-label="Search entries"/, 'text search stays visible');
assert.match(html, /function histDateLabel\(d\)/, 'history dates are formatted for scanning');
assert.doesNotMatch(html, /esc\(lg\.sheet \|\| ''\)/, 'sheet name leaves the row meta');
assert.doesNotMatch(html, /class="hist-del" data-act="del-entry"/, 'row no longer carries a delete button');
assert.match(html, /addItem\('Move entry to Trash…', 'del-entry'/, 'entry delete moved into the menu');
assert.match(html, /addItem\('Move entire receipt to Trash…', 'del-txn'/, 'receipt delete stays in the menu');
assert.match(html, /applyBtn\.setAttribute\('aria-busy', 'true'\)/, 'search busy state keeps the toolbar width');
assert.doesNotMatch(html, /applyBtn\.textContent = 'Searching…'/, 'busy label does not reflow Search');
assert.match(html, /menuRect\.left < minLeft/, 'row menu stays inside the card on narrow screens');
assert.match(html, /class="entry-detail-meta"/, 'sheet and IDs live in Edit details');
assert.match(html, /label class="meta-check"><input type="checkbox" data-e-reimb/, 'edit flags use the check-row pattern');
assert.match(html, /#feature-modal \.feature-form label\.meta-check input\[type="checkbox"\]/, 'feature checkboxes are not full-width');
assert.match(html, /var day = histDateLabel\(info\.date\)/, 'receipt delete names the date');
assert.match(html, /@media \(max-width: 360px\) \{\s*\.history-searchrow input \{ flex: 1 1 100%;/, 'narrow toolbar stacks cleanly');
assert.match(html, /id="history-noresults"[^>]*history-empty/, 'no-results state exists');
assert.match(html, /id="history-noresults-clear"/, 'no-results state offers a reset');
assert.match(html, /add\('history-noresults-clear', 'click', clearSearch\)/, 'no-results reset clears filters');
assert.match(html, /id="history-sub" aria-live="polite"/, 'history status is the live region');
assert.doesNotMatch(html, /id="history-list" aria-live=/, 'history list does not announce every row');
assert.match(html, /id="dash-title" aria-live="polite"/, 'month changes are announced');
assert.match(html, /function fmtMoney\(n, code\)/, 'history amounts respect their currency');
assert.match(html, /fmtMoney\(amt, lg\.currency\)/, 'row amount uses the stored currency');
assert.match(html, /function fmtCount\(n\)/, 'large counts are grouped');
assert.match(html, /--income:\s*#2e6a49/, 'light income ink meets contrast');
assert.match(html, /\.adv-toggle \{[^}]*min-height:\s*44px/, 'advanced toggle has a full target');
assert.match(html, /\.meta-check \{[^}]*min-height:\s*32px/, 'flag rows have a desktop target');
assert.match(html, /\.one-row-switch \.track::before/, 'switch track has an expanded hit area');
assert.match(html, /\.history-searchrow \.btn-choice \{ flex: 1 1 0; \}/, 'narrow toolbar splits actions');
assert.match(html, /\.hist-meta \{[^}]*overflow-wrap:\s*anywhere/, 'long metadata wraps');
assert.match(html, /\.budget-top \{[^}]*flex-wrap:\s*wrap/, 'long budget labels wrap');
assert.doesNotMatch(html, /id="pin-old"[^>]*placeholder=/, 'change PIN starts empty');
assert.match(html, /el\.addEventListener\('input', function \(\) \{\s*el\.value = pinDigits\(el\.value\);/, 'change PIN accepts digits only');
assert.match(html, /\\u0660-\\u0669/, 'PIN accepts Arabic-Indic digits');
assert.match(html, /cfBusyBtn\(histRefresh, true, 'Refreshing…'\)/, 'refresh cannot be double-fired');
assert.match(html, /histSub\.textContent = 'Couldn’t load entries\. '/, 'history errors surface beside the list');
assert.match(html, /e\.key === 'ArrowDown'/, 'row menu supports arrow keys');
assert.match(html, /closeHistMenu\(true\)/, 'Escape returns focus to the row menu trigger');
assert.match(html, /hist-merchant" dir="auto"/, 'merchant names honor their script direction');
assert.match(html, /if \(title\.textContent !== titleText\)/, 'month announcements do not repeat');
assert.match(html, /function histFiltersActive\(\)/, 'refresh respects active filters');
assert.match(html, /if \(histFiltersActive\(\) && apply\) \{ apply\.click\(\); return; \}/, 'refresh reruns the filtered view');
assert.match(html, /var typeLabel = lg\.type \|\| \(amt < 0 \? 'Expense' : ''\)/, 'unknown types do not render an empty badge');
assert.match(html, /aria-label="Edit ' \+ esc\(merchant \|\| 'entry'\)/, 'row actions name their entry');
assert.match(html, /aria-label="View receipt image for ' \+ esc\(merchant/, 'image action names its entry');
assert.match(html, /var logLabel = r\.description \? 'Log ' \+ r\.description/, 'recurring actions name their rule');
assert.match(html, /id="settings-menu"[\s\S]{0,1600}>Entry settings</, 'settings menu leads with entry settings');
assert.match(html, /Set Gemini key/, 'Gemini setup is named plainly');
assert.match(html, /Set Google Sheet/, 'Sheet setup is named plainly');
assert.match(html, /Active sessions/, 'session list is distinguished from session settings');
assert.equal(count(html, /class="menu-sep"/g), 5, 'settings menu is grouped');
assert.match(html, /openModal\('Entry settings'/, 'entry settings modal matches its menu label');
assert.match(html, /openModal\('Active sessions'/, 'active sessions modal matches its menu label');
assert.match(html, /#settings-menu \{[^}]*max-height:\s*calc\(100dvh - 84px\)/, 'long menus scroll on short screens');
assert.doesNotMatch(html, /Anomaly callouts|Submit Batch|Reconciliation options|Force-save/, 'operator labels removed from the working surface');
assert.match(html, /id="toggle-force"/, 'Save anyway toggle');
assert.doesNotMatch(html, /toggle-discount|discount-note|Auto-discount|autoDiscount|auto-discount-adjusted|discountAdjusted/i, 'no Auto-discount UI/client feature or stale summary counter');
assert.match(html, /class="switch one-row-switch"/, 'one-row toggle must reuse shared switch styling');
assert.match(html, /#tab-standard \.one-row-switch \.track \{ grid-row: 1; \}/, 'one-row toggle track stays on the title row');
assert.match(html, /<label for="toggle-onerow" class="track" aria-hidden="true">/, 'tapping one-row track toggles checkbox');
assert.match(html, /--faint:\s*#6b665d/, 'metadata text passes contrast');
assert.match(html, /\.info-btn\s*\{[^}]*width:\s*44px;\s*height:\s*44px/, 'info help has a 44px target');
assert.match(html, /\.btn-choice\.primary\s*\{[^}]*background:\s*var\(--accent-solid\)/, 'feature dialog primary action is styled');
assert.match(html, /Touch targets: 44px/, 'mobile controls meet the touch floor');
assert.equal(count(html, /class="submit-dock"/g), 2, 'both entry modes share the action dock');
assert.match(html, /\.submit-dock \{[\s\S]*?position: sticky;[\s\S]*?bottom: calc\(var\(--binder-nav-h\)/, 'primary action stays above the mobile nav');
assert.match(html, /function setStatus\(text, cls, reveal\)/, 'form status can request reveal');
assert.doesNotMatch(readme, /Auto-discount/i, 'README does not advertise Auto-discount');

for (const key of ['entry', 'reconciliation', 'photos', 'note', 'one-row']) {
  assert.match(html, new RegExp('data-info="' + key + '"'), 'info trigger: ' + key);
}
assert.match(html, /id="info-modal"[^>]*role="dialog"[^>]*aria-modal="true"/, 'accessible info dialog');
assert.match(html, /id="pin-input"[^>]*aria-describedby="lock-sub"/, 'PIN helper is associated');
assert.doesNotMatch(html, /id="pin-input"[^>]*placeholder=/, 'PIN field starts empty');
assert.doesNotMatch(html, /id="pin-(input|old|new|new2)"[^>]*maxlength=/, 'PIN fields sanitize before length');
assert.match(html, /id="pin-submit" disabled/, 'Unlock waits for six digits');
assert.match(html, /id="lock-recovery"[^>]*>Forgot your PIN\?/, 'PIN recovery is visible');
assert.match(html, /body\.locked #session-pill\s*\{\s*display:\s*none;/, 'access telemetry is hidden before unlock');
assert.match(html, /function syncPinSubmit\(\)/, 'PIN button follows input length');
assert.match(html, /id="lightbox"[^>]*aria-hidden="true" inert/, 'closed photo viewer is inert');
assert.match(html, /id="trow-lightbox"[^>]*aria-hidden="true" inert/, 'closed row viewer is inert');
assert.match(html, /lightbox\.removeAttribute\('inert'\)/, 'photo viewer leaves inert on open');
assert.match(html, /lightbox\.setAttribute\('inert', ''\)/, 'photo viewer returns to inert on close');
assert.match(html, /function cfDialogList\(\)/, 'shared dialog focus containment');
assert.match(html, /cfFocusable\(dialog\)/, 'Tab stays inside the active dialog');
assert.match(html, /wrap\.setAttribute\('aria-labelledby', 'fm-title'\)/, 'feature dialog is named');
assert.match(html, /btnS\.tabIndex = isStd \? 0 : -1/, 'tabs use roving tabindex');
assert.match(html, /ArrowRight[\s\S]{0,140}tabs\[/, 'tabs respond to arrow keys');
assert.match(html, /id="hero-toggle" role="menuitem"/, 'intro action is an action item');
assert.doesNotMatch(html, /id="hero-toggle"[^>]*aria-pressed/, 'no misleading pressed state on the intro action');
assert.match(html, /infoBody\.textContent\s*=\s*copy\.body/, 'info content uses textContent');
assert.match(html, /if \(e\.target === infoModal\) closeInfoModal\(\)/, 'info backdrop close');
assert.match(html, /Escape[\s\S]{0,180}closeInfoModal\(\)/, 'info Escape close');
assert.match(html, /if \(focus && focus\.focus\) focus\.focus\(\)/, 'restore focus');

assert.match(html, /<p>Add a photo or a note\.<\/p>/, 'short entry helper');
assert.match(html, /Camera takes a new photo\. Gallery lets you choose existing photos\./, 'short photo helper');
assert.match(html, /placeholder="Optional note for these receipts…"/, 'short note placeholder');
assert.doesNotMatch(html, /Quick-Input logs fast|Photo optional\. Note optional|Applies to all photos, e\.g\.|Each row = optional photo|Each photo is logged as its own receipt —/, 'redundant copy removed');

assert.doesNotMatch(code, /autoDiscount|AUTO DISCOUNT/i, 'no Auto-discount backend option/policy');
assert.equal(count(code, /auto-discount-adjusted/g), 2, 'only two legacy ledger recognition references');
assert.match(code, /prior\.status === 'auto-discount-adjusted'/, 'historical ledger status is idempotent');
assert.match(code, /var st = 'force-adjusted';/, 'only Force-save generates adjusted status');
assert.doesNotMatch(code, /discountAdjusted/, 'no obsolete summary counter');

// Code.js is stored with CRLF endings, so every line anchor here must tolerate
// either convention instead of assuming LF.
const reconcileMatch = code.match(/function reconcileRow_\([\s\S]*?\r?\n\}\r?\n(?=\r?\nfunction dominantCategory_\()/);
const policyMatch = code.match(/function applyTogglePolicy_\([\s\S]*?\r?\n\}\r?\n(?=\s*\/\/ ---------- SHEET WRITING ----------)/);
assert.ok(reconcileMatch, 'find reconcileRow_');
assert.ok(policyMatch, 'find applyTogglePolicy_');
const context = {
  SPENDING_TYPES: ['Need', 'Want', 'Work', 'Investment'],
  EXPENSE_CATEGORIES: ['Food & Beverage', 'Groceries', 'Transportation', 'Others', 'Income'],
  idr_: n => 'Rp' + Number(n).toLocaleString('en-US'),
  dominantCategory_: () => 'Groceries',
  dominantSpendingType_: () => 'Need'
};
vm.runInNewContext(reconcileMatch[0] + '\nthis.reconcile = reconcileRow_;', context);
vm.runInNewContext(policyMatch[0] + '\nthis.policy = applyTogglePolicy_;', context);
const txn = { transaction_type:'Expense', line_list_complete:'possibly_incomplete', extraction_notes:'possible crop',
  items:[{description:'Milk',amount:5000,category:'Groceries',spending_type:'Need'}] };
const readable = { total_status:'found', total_amount:5000 };
const quickMatch = context.reconcile(readable, txn, {hasPhoto:true,quickMode:true});
assert.equal(quickMatch.verdict,'ok','Quick-Input accepts matching readable total');
assert.match(quickMatch.disclosure,/QUICK-INPUT INCOMPLETE LINE LIST/,'Quick-Input discloses incomplete lines');
assert.equal(context.reconcile(readable,txn,{hasPhoto:true,quickMode:false}).verdict,'uncertain','Table Layout strictness');
assert.equal(context.reconcile({total_status:'uncertain',total_amount:0},txn,{hasPhoto:true,quickMode:true}).verdict,'uncertain','unreadable total stays for review');

const positive = context.policy(JSON.parse(JSON.stringify(txn)),{verdict:'mismatch',difference:2000},{forceLog:true});
assert.equal(positive.applied,'force-item'); assert.equal(positive.txn.items.length,2);
assert.equal(positive.txn.items[1].amount,2000); assert.equal(positive.txn.items[1].description,'Missing/hidden item');
assert.match(positive.note,/FORCED RECONCILIATION/);
const negative = context.policy(JSON.parse(JSON.stringify(txn)),{verdict:'mismatch',difference:-2000},{forceLog:true});
assert.equal(negative.applied,'force-discount'); assert.equal(negative.txn.items.length,2);
assert.equal(negative.txn.items[1].amount,-2000); assert.equal(negative.txn.items[1].description,'Missing/hidden discount');
assert.equal(context.policy(JSON.parse(JSON.stringify(txn)),{verdict:'mismatch',difference:2000},{forceLog:false}).applied,'none');
assert.equal(context.policy(JSON.parse(JSON.stringify(txn)),{verdict:'uncertain',difference:null},{forceLog:true}).applied,'none');
console.log('UI polish checks passed: document, header, modal, copy, tabs, legacy idempotency, Receipt photos policy and Save anyway.');
