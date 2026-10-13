'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

assert.equal(count(html, /<\/body>/gi), 1, 'one body closer');
assert.equal(count(html, /<\/html>/gi), 1, 'one html closer');
assert.doesNotMatch(html.trimEnd(), />\s*<\/body>\s*<\/html>\s*$/i, 'no stray >');
assert.match(html.trimEnd(), /<\/body>\s*<\/html>$/i, 'correct close order');

const pillAt = html.indexOf('id="session-pill"');
const themeAt = html.indexOf('id="theme-toggle"');
const settingsAt = html.indexOf('id="settings-btn"');
assert.ok(pillAt >= 0 && themeAt > pillAt && settingsAt > themeAt, 'header order');
assert.doesNotMatch(html, /\.pill\s*\{\s*display:\s*none\s*!important?\s*;/i, 'status pill remains on mobile');
assert.match(html, /#pill-env,\s*\.pill-sep\s*\{\s*display:\s*none;\s*\}/, 'environment suffix collapses on mobile');

const overlay = html.match(/#lock-screen,\s*#pin-modal,\s*#api-modal,\s*#sheet-modal,[^{}]*#info-modal\s*\{/);
assert.ok(overlay && overlay[0].includes('#sess-modal'), 'session modal uses overlay CSS');
assert.match(html, /#sess-modal\s*\{\s*z-index:\s*110;\s*\}/, 'session modal z-index');
assert.match(html, /#sess-modal \.lock-card,\s*#info-modal \.lock-card\s*\{\s*max-height:\s*calc\(100dvh - 32px\);\s*overflow-y:\s*auto;/, 'scroll-safe modal');
assert.match(html, /body\.modal-open\s*\{\s*overflow:\s*hidden;\s*\}/, 'background scroll lock');
assert.match(html, /Escape[\s\S]{0,180}closeSessModal\(\)/, 'session modal Escape close');

assert.match(html, /id="recon-options"/, 'reconciliation fieldset');
assert.match(html, /recon\.classList\.toggle\('hidden', isStd\)/, 'Quick-Input hides settings');
assert.match(html, /id="toggle-force"/, 'Force-save toggle');
assert.doesNotMatch(html, /toggle-discount|discount-note|Auto-discount|autoDiscount|auto-discount-adjusted|discountAdjusted/i, 'no Auto-discount UI/client feature or stale summary counter');
assert.match(html, /class="switch one-row-switch"/, 'one-row toggle must reuse shared switch styling');
assert.match(html, /#tab-standard \.one-row-switch \.track \{ grid-row: 1; \}/, 'one-row toggle track stays on the title row');
assert.doesNotMatch(readme, /Auto-discount/i, 'README does not advertise Auto-discount');

for (const key of ['entry', 'reconciliation', 'photos', 'note', 'one-row']) {
  assert.match(html, new RegExp('data-info="' + key + '"'), 'info trigger: ' + key);
}
assert.match(html, /id="info-modal"[^>]*role="dialog"[^>]*aria-modal="true"/, 'accessible info dialog');
assert.match(html, /infoBody\.textContent\s*=\s*copy\.body/, 'info content uses textContent');
assert.match(html, /if \(e\.target === infoModal\) closeInfoModal\(\)/, 'info backdrop close');
assert.match(html, /Escape[\s\S]{0,180}closeInfoModal\(\)/, 'info Escape close');
assert.match(html, /if \(focus && focus\.focus\) focus\.focus\(\)/, 'restore focus');

assert.match(html, /<p>Add a photo or a note\.<\/p>/, 'short entry helper');
assert.match(html, /Camera takes a new photo\. Gallery lets you choose existing photos\./, 'short photo helper');
assert.match(html, /placeholder="Optional note for these receipt\(s\)…"/, 'short note placeholder');
assert.doesNotMatch(html, /Quick-Input logs fast|Photo optional\. Note optional|Applies to all photos, e\.g\.|Each row = optional photo|Each photo is logged as its own receipt —/, 'redundant copy removed');

assert.doesNotMatch(code, /autoDiscount|AUTO DISCOUNT/i, 'no Auto-discount backend option/policy');
assert.equal(count(code, /auto-discount-adjusted/g), 2, 'only two legacy ledger recognition references');
assert.match(code, /prior\.status === 'auto-discount-adjusted'/, 'historical ledger status is idempotent');
assert.match(code, /var st = 'force-adjusted';/, 'only Force-save generates adjusted status');
assert.doesNotMatch(code, /discountAdjusted/, 'no obsolete summary counter');

const reconcileMatch = code.match(/function reconcileRow_\([\s\S]*?\n\}\n(?=\nfunction dominantCategory_\()/);
const policyMatch = code.match(/function applyTogglePolicy_\([\s\S]*?\n\}\n(?=\n\/\/ ---------- SHEET WRITING ----------)/);
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
console.log('UI polish checks passed: document, header, modal, copy, tabs, legacy idempotency, Quick-Input policy and Force-save.');
