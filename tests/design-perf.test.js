'use strict';
// Design + performance guards. These are source contracts, not device
// benchmarks: they stop the app from regressing into external font blocking,
// nested backdrop blurs on repeating elements, or per-row DOM thrash.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const shell = read('Index.html');
const css = read('Styles.html');
const layout = read('Layout.html');
const js = read('AppCore.html') + '\n' + read('AppEntry.html') + '\n' + read('AppAuth.html') + '\n' + read('AppFeatures.html');
const code = ['BackendConfig.js', 'Code.js', 'BackendAuth.js', 'BackendHistory.js', 'BackendGemini.js', 'BackendSheets.js', 'BackendSort.js', 'BackendFeatures.js'].map(read).join('');

// --- Loading: no external, render-blocking font request -------------------
assert.doesNotMatch(shell, /fonts\.googleapis\.com|fonts\.gstatic\.com/i, 'no Google Fonts preconnect/fetch');
assert.doesNotMatch(css + shell + js, /Outfit/i, 'no external display font');
assert.match(css, /--font:\s*ui-sans-serif,\s*-apple-system/, 'system font stack');

// --- Composition: thin shell + HtmlService includes -----------------------
for (const part of ['Styles', 'Layout', 'AppCore', 'AppEntry', 'AppAuth', 'AppFeatures']) {
  assert.match(shell, new RegExp("include_\\('" + part + "'\\)"), 'include ' + part);
}
assert.match(code, /function include_\(filename\)\s*\{/, 'include_ helper exists');
assert.match(code, /createTemplateFromFile\('Index'\)/, 'doGet still serves Index');
// The Apps Script outer wrapper is a separate document from the shell. Keep the
// viewport meta in both places or real phones lay the iframe out at ~980 px.
assert.match(read('Index.html'), /<meta name="viewport"[^>]*width=device-width/, 'shell viewport meta');
assert.match(read('Code.js'), /addMetaTag\('viewport',\s*'width=device-width, initial-scale=1'\)/, 'doGet wrapper viewport meta');

// --- Flat design: no blur, no decorative gradients -------------------------
assert.equal((css.match(/backdrop-filter/g) || []).length, 0, 'no backdrop blur anywhere');
assert.equal((css.match(/radial-gradient/g) || []).length, 0, 'no decorative background gradients');
assert.doesNotMatch(shell + layout, /class="bg"/, 'no background effect layer');
assert.doesNotMatch(css, /\.bg\s*\{/, 'no background effect styles');
assert.match(css, /--radius-xl:\s*24px/, 'binder-scale edge curves');
assert.match(css, /\.trow \{[\s\S]*?border: 1px solid var\(--line\)/, 'table rows use hairline borders');
assert.match(css, /\.hist-item \{[\s\S]*?border-bottom: 1px solid var\(--line\)/, 'history renders as ruled ledger rows');
assert.match(css, /\.card \{[\s\S]*?box-shadow: none/, 'cards are matte, not floating');

// --- Visual system: graphite desk + amber stamps ---------------------------------
assert.doesNotMatch(css, /#e60023|#ff6a00|--accent-grad|linear-gradient\(135deg/i, 'no old neon red/orange palette');
assert.match(css, /--accent:\s*#f0a44b/, 'amber accent');
assert.match(css, /--accent-solid:\s*#e08a32/, 'amber action');
assert.match(css, /--bg:\s*#0e0d0c/, 'graphite desk background');
assert.match(css, /--bg:\s*#eceae5/, 'warm paper light background');
assert.match(css, /--surface:\s*#faf8f4/, 'matte light envelopes');
assert.match(css, /--serif:\s*var\(--font\)/, 'display face is the system sans, not a serif');
assert.match(css, /\.tab\.active \{ background: var\(--surface-strong\)/, 'tabs are raised pills');
assert.match(css, /\.entry-card::before/, 'active envelope carries a binder tab');
assert.match(shell, /data-theme="dark"/, 'dark is the default theme');
assert.match(shell, /localStorage\.getItem\('cf-theme'\)\|\|'dark'/, 'no-flash boot defaults to dark');

// --- Binder shell: rail, mobile tabs, strip, settings panel ----------------
assert.match(layout, /class="binder-body"/, 'binder spread wrapper');
assert.match(layout, /id="binder-rail" aria-label="Sections"/, 'desktop rail');
assert.match(layout, /id="binder-nav" aria-label="Sections"/, 'mobile bottom nav');
for (const target of ['entry', 'overview', 'history', 'settings']) {
  assert.equal((layout.match(new RegExp('data-binder-target="' + target + '"', 'g')) || []).length >= 2, true, 'rail and nav target: ' + target);
  assert.match(layout, new RegExp('data-binder-panel="' + target + '"'), 'panel: ' + target);
}
assert.match(css, /body\[data-binder-tab="overview"\] \[data-binder-panel="overview"\]/, 'mobile shows the selected panel');
assert.match(css, /\.binder-nav \{[\s\S]*?position: fixed;/, 'bottom nav is fixed');
assert.match(css, /\.binder-rail \{[\s\S]*?position: sticky;/, 'desktop rail follows the spread');
assert.match(js, /function initBinderShell\(\)/, 'shell controller exists');
assert.match(js, /settings-panel-list/, 'settings panel mirrors menu actions');
assert.match(layout, /class="month-strip is-loading" id="month-strip"/, 'month strip starts in a loading state');
assert.match(layout, /id="strip-spent"/, 'strip carries the month spend');
assert.match(css, /body\.locked \.binder-rail, body\.locked \.binder-nav/, 'locked gate hides the shell');

// --- Client rendering: batch DOM writes, reuse object URLs ----------------
assert.match(js, /insertAdjacentHTML\('beforeend', markup\)/, 'history page inserted in one write');
assert.doesNotMatch(js, /histList\.appendChild\(item\)/, 'no per-row history appendChild');
assert.match(js, /var previewUrlCache = new Map\(\)/, 'preview object URLs cached');
assert.doesNotMatch(js, /thumbUrls/, 'no revoke-all thumbnail loop');
assert.match(js, /statusEl\.__label\.textContent = text/, 'progress status reuses its DOM');
assert.match(js, /img\.loading = 'lazy'/, 'thumbnails lazy-load');
assert.match(js, /cf:unlocked/, 'deferred cosmetic work waits for unlock');

// --- Backend: short read cache + invalidation on every write --------------
assert.match(code, /function bumpHistoryCacheVersion_\(\)/, 'history cache version helper');
assert.match(code, /function getRecentLogs[\s\S]*?CacheService\.getScriptCache\(\)/, 'getRecentLogs uses cache');
assert.match(code, /function commitReceiptRows[\s\S]*?bumpHistoryCacheVersion_\(\)/, 'commit bumps history cache');
assert.match(code, /function trashMoveRows_[\s\S]*?bumpHistoryCacheVersion_\(\)/, 'delete bumps history cache');
assert.match(code, /function restoreTrashRecord_[\s\S]*?bumpHistoryCacheVersion_\(\)/, 'restore bumps history cache');
assert.match(code, /HAS_SHEET_CACHE_KEY/, 'config check cached');
assert.doesNotMatch(code, /autoDiscount|AUTO DISCOUNT/i, 'no Auto-discount backend');

// --- Syntax: every inline script + Code.js must parse ---------------------
const scripts = js.match(/<script>([\s\S]*?)<\/script>/g) || [];
assert.ok(scripts.length >= 3, 'three app script blocks');
scripts.forEach((block, i) => {
  const body = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.doesNotThrow(() => new vm.Script(body, { filename: 'inline-' + i + '.js' }), 'inline script ' + i + ' parses');
});
assert.doesNotThrow(() => new vm.Script(code, { filename: 'Code.js' }), 'Code.js parses');

// --- Markup sanity --------------------------------------------------------
assert.equal((layout.match(/<fieldset\b/g) || []).length, 1, 'one fieldset');
assert.equal((layout.match(/<\/fieldset>/g) || []).length, 1, 'one fieldset close');
assert.equal((layout.match(/<body\b/g) || []).length, 0, 'partial never opens body');
assert.equal((layout.match(/<\/body>/g) || []).length, 0, 'partial never closes body');
assert.equal((js.match(/<\/body>/g) || []).length, 0, 'script partials never close body');

console.log('Design/perf guards passed: flat surfaces, orange accent, system font, batched DOM, cached history, valid JS.');
