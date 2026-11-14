'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const backendFiles = ['BackendConfig.js', 'Code.js', 'BackendAuth.js', 'BackendHistory.js',
  'BackendGemini.js', 'BackendSheets.js', 'BackendSort.js', 'BackendFeatures.js'];
for (const f of backendFiles) assert.ok(fs.existsSync(path.join(root, f)), 'backend module exists: ' + f);
const backend = backendFiles.map(read).join('\n');
const features = read('BackendFeatures.js');
const client = read('AppFeatures.html');
const layout = read('Layout.html');
const app = read('appsscript.json');
const pkg = JSON.parse(read('package.json'));

// --- manifest -------------------------------------------------------------
for (const scope of ['spreadsheets', 'script.external_request', 'userinfo.email']) {
  assert.match(app, new RegExp('auth/' + scope.replace('.', '\\.')), 'oauth scope: ' + scope);
}
assert.doesNotMatch(app, /auth\/drive/, 'no Drive scope is needed');

// --- backend API surface --------------------------------------------------
for (const action of ['dashboard', 'search', 'updateEntry', 'sessions.list', 'sessions.revoke',
  'budgets.save', 'recurring.log', 'household.save', 'reimbursement.set', 'duplicates.check',
  'image.save', 'image.get', 'image.delete', 'backup.export', 'backup.import', 'report.month', 'quickText', 'uiPrefs.get', 'uiPrefs.save']) {
  assert.ok(features.includes("'" + action + "'"), 'cfApi action: ' + action);
}
assert.match(features, /function cfEnsureFeatureSchema_/, 'schema migration');
assert.match(features, /CF_SCAN_MAX_SHEETS/, 'search scan cap');
assert.match(backend, /HISTORY_SCAN_MAX_SHEETS/, 'history scan cap');
assert.match(backend, /CF_GEMINI_RL_/, 'Gemini quota guard');
assert.match(backend, /cfSessionsList_/, 'session list');
assert.match(backend, /scanInfo\.ms = Date\.now\(\) - scanStarted/, 'history scan timing');
assert.match(backend, /SESSIONS_META_KEY/, 'session metadata');
assert.match(backend, /duplicate-review/, 'duplicate review status');
assert.match(backend, /cfRecordHashes_/, 'receipt hash recording');
assert.match(features, /function cfApplySplits_/, 'split backend');
assert.match(features, /function cfDuplicateFingerprint_/, 'duplicate fingerprint backend');
assert.match(features, /function cfQuickText_/, 'quick text backend');
assert.match(features, /CF_IMAGE_SHEET/, 'receipt image storage sheet');
assert.doesNotMatch(features, /DriveApp/, 'image retention avoids Drive authorization');
assert.match(features, /function cfExportBackup_[\s\S]*?name\.indexOf\('_CF_'\) !== 0/, 'backup includes system sheets');
assert.match(features, /_CF_Submissions|LEDGER_SHEET_NAME/, 'ledger restore key');
assert.match(features, /TRASH_SHEET_NAME/, 'trash restore key');
assert.match(features, /function cfMonthlyReport_/, 'monthly report backend');
assert.match(features, /pdfBase64/, 'report returns PDF bytes to the browser');
assert.match(features, /function cfRetainReceiptImage_/, 'image retention backend');

// --- client surfaces ------------------------------------------------------
for (const id of ['dashboard-card', 'entry-meta', 'entry-currency', 'entry-tags', 'entry-member',
  'entry-reimb', 'entry-review', 'entry-duplicate', 'quick-text-btn', 'history-filters',
  'household-btn', 'sessions-btn', 'backup-btn', 'feature-settings-btn']) {
  assert.ok(layout.includes('id="' + id + '"'), 'layout surface: ' + id);
}
for (const marker of ['DRAFT_KEY', 'indexedDB', 'cfQueueOffline', 'cfClearDraft',
  'cfReviewBeforeCommit', 'cfSplitRow', 'runSearch', 'openSessions', 'openBackup',
  'Bigger than last month', 'markReimbursed', 'report.month', 'cfRenderDashboard',
  'photoUrl', 'data-rv-merchant', 'openQuickText', 'cfRetryFailedBatch', 'feature-help',
  'advanced-toggle', 'paintAdvanced', 'dashboardCache', 'openRetainedImage']) {
  assert.ok(client.includes(marker), 'feature client marker: ' + marker);
}
assert.match(client, /cf:trash-mutation/, 'undo hook');
assert.ok(pkg.scripts.test.includes('features.test.js'), 'npm test includes feature suite');

// --- pure function checks -------------------------------------------------
function grab(name, source) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = (source || features).match(re);
  assert.ok(m, 'extract ' + name);
  return m[0];
}
const vmCtx = {
  Utilities: {
    getUuid: () => 'uuid-1234',
    formatDate: (d, tz, fmt) => '2026-05-06'
  },
  Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
  dominantSpendingType_: () => 'Need',
  isMonthSheetName_: (s) => /^[A-Z][a-z]+ \d{4}$/.test(s)
};
vm.runInNewContext(
  grab('cfApplySplits_') + '\n' + grab('cfApplyTxnMeta_') + '\nthis.splits = cfApplySplits_; this.meta = cfApplyTxnMeta_;',
  vmCtx
);
const txn = { merchant: 'Demo', items: [{ amount: 100 }, { amount: 50 }] };
vmCtx.splits(txn, [{ category: 'Groceries', amount: 100 }, { category: 'Others', amount: 50 }]);
assert.equal(txn.items.length, 2, 'split writes two lines');
assert.equal(txn.items[0].category, 'Groceries');
assert.equal(txn.items[1].amount, 50);
const untouched = { merchant: 'Demo', items: [{ amount: 100 }] };
vmCtx.splits(untouched, [{ category: 'Groceries', amount: 10 }, { category: 'Others', amount: 10 }]);
assert.equal(untouched.items.length, 1, 'mismatched split is ignored');
vmCtx.meta(txn, { currency: 'USD', fxRate: 15000, tags: 'work', member: 'Rae', reimbursable: 'Yes' });
assert.equal(txn.currency, 'USD'); assert.equal(txn.fxRate, 15000);
assert.equal(txn.tags, 'work'); assert.equal(txn.member, 'Rae');

vm.runInNewContext(grab('cfPrevMonthKey_') + '\nthis.prev = cfPrevMonthKey_;', vmCtx);
assert.equal(vmCtx.prev('2026-01'), '2025-12');
assert.equal(vmCtx.prev('2026-11'), '2026-10');

vm.runInNewContext(grab('cfMonthSheetName_') + '\nthis.monthName = cfMonthSheetName_;', vmCtx);
assert.equal(vmCtx.monthName('2026-05'), 'May 2026');

vm.runInNewContext(grab('cfDateString_') + '\nthis.dateString = cfDateString_;', vmCtx);
assert.equal(vmCtx.dateString('2026-05-06T10:00:00Z'), '2026-05-06');
assert.equal(vmCtx.dateString('Wed May 06 2026'), 'Wed May 06 2026');

vm.runInNewContext(
  'function cfValue_(row,col,name){ return row[name]; }' + '\n' + grab('cfBaseAmount_') +
  '\nthis.base = cfBaseAmount_;',
  vmCtx
);
assert.equal(vmCtx.base({ 'Base Amount': 200 }, {}, 100), 200);
assert.equal(vmCtx.base({ 'FX Rate': 15000 }, {}, 2), 30000);

// Feature settings are pure except for the property store.
const defaultsDecl = features.match(/var CF_FEATURE_DEFAULTS = \{[\s\S]*?\n\};/)[0];
const store = {};
const settingsCtx = {
  CF_FEATURE_DEFAULTS: null,
  CF_SETTINGS_KEY: 'CF_FEATURE_SETTINGS_V1',
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (store[k] === undefined ? null : store[k]),
      setProperty: (k, v) => { store[k] = String(v); }
    })
  }
};
vm.runInNewContext(defaultsDecl + '\n' + grab('cfFeatureSettings_') + '\n' + grab('cfSaveFeatureSettings_') +
  '\nthis.get = cfFeatureSettings_; this.save = cfSaveFeatureSettings_;', settingsCtx);
assert.equal(settingsCtx.get().defaultCurrency, 'IDR');
settingsCtx.save({ defaultCurrency: 'USD', reviewBeforeCommit: true });
assert.equal(settingsCtx.get().defaultCurrency, 'USD');
assert.equal(settingsCtx.get().reviewBeforeCommit, true);

// The duplicate fingerprint must include the image hash, merchant, date, and total.
let lastSeed = '';
const fpCtx = {
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, seed) => { lastSeed = seed; return seed.split('').map((c) => c.charCodeAt(0) % 256); }
  }
};
vm.runInNewContext(grab('cfDuplicateFingerprint_') + '\nthis.fp = cfDuplicateFingerprint_;', fpCtx);
const baseTxn = { merchant: 'Demo Grocer', transaction_date: '2026-11-07', items: [{ amount: 100 }, { amount: 50 }] };
const fp1 = fpCtx.fp(baseTxn, 'image-abc');
assert.match(lastSeed, /image-abc\|demo grocer\|2026-11-07\|150/, 'fingerprint seed includes image, merchant, date, total');
const fp2 = fpCtx.fp({ merchant: 'Other', transaction_date: '2026-11-07', items: [{ amount: 150 }] }, 'image-abc');
assert.notEqual(fp1, fp2, 'different merchant produces a different fingerprint');
const fp3 = fpCtx.fp(baseTxn, 'image-xyz');
assert.notEqual(fp1, fp3, 'different image hash produces a different fingerprint');
const dupCtx = {};
vm.runInNewContext(grab('cfDuplicateDisposition_') + '\nthis.d = cfDuplicateDisposition_;', dupCtx);
const dupSet = { abc: { transactionId: 'T1' } };
assert.equal(dupCtx.d({}, 'abc', dupSet), 'hold', 'duplicate is held by default');
assert.equal(dupCtx.d({ forceDuplicate: true }, 'abc', dupSet), 'allow', 'forceDuplicate overrides the hold');
assert.equal(dupCtx.d({}, 'none', dupSet), 'none', 'unknown fingerprint is not held');

// Quick text must commit one text transaction with the current metadata.
let quickCaptured = null;
const quickCtx = {
  requireSession_: () => {},
  buildPrompt: () => 'prompt',
  TRANSACTION_SCHEMA: {},
  callGemini_: () => ({ transaction_type: 'Expense', merchant: 'Coffee', items: [{ description: 'Coffee', amount: 35000, category: 'Food & Beverage' }] }),
  sanitizeTransaction: (t) => t,
  Utilities: { getUuid: () => 'u1' },
  commitReceiptRows: (sub, rows, token) => { quickCaptured = { sub, rows, token }; return { rows: [{ status: 'logged' }] }; }
};
vm.runInNewContext(grab('cfQuickText_') + '\nthis.quick = cfQuickText_;', quickCtx);
const quickRes = quickCtx.quick('tok', { note: 'Coffee 35k', meta: { currency: 'USD', fxRate: 15000, tags: 'work', member: 'Rae', reimbursable: true } });
assert.equal(quickRes.ok, true, 'quick text returns ok');
assert.ok(quickCaptured, 'quick text commits');
assert.equal(quickCaptured.rows.length, 1, 'one text row');
assert.equal(quickCaptured.rows[0].hasPhoto, false, 'text row has no photo');
assert.equal(quickCaptured.rows[0].currency, 'USD');
assert.equal(quickCaptured.rows[0].fxRate, 15000);
assert.equal(quickCaptured.rows[0].tags, 'work');
assert.equal(quickCaptured.rows[0].member, 'Rae');
assert.equal(quickCaptured.rows[0].reimbursable, 'Yes');
assert.equal(quickCaptured.token, 'tok');

// Session revoke removes only the selected session.
let sessMap = { 'h:current': Date.now() + 100000, 'h:other': Date.now() + 100000 };
let sessMeta = { 'h:current': { label: 'Current', lastSeen: 2 }, 'h:other': { label: 'Other', lastSeen: 1 } };
const sessCtx = {
  sha256Hex_: (s) => 'h:' + s,
  requireSession_: () => {},
  loadSessions_: () => sessMap,
  loadSessionMeta_: () => sessMeta,
  saveSessions_: (m) => { sessMap = m; },
  saveSessionMeta_: (m) => { sessMeta = m; },
  touchSessionMeta_: () => {}
};
vm.runInNewContext(grab('cfSessionsList_') + '\n' + grab('cfSessionRevoke_') +
  '\nthis.list = cfSessionsList_; this.revoke = cfSessionRevoke_;', sessCtx, { filename: 'sessions' });
const sessions = sessCtx.list('current');
assert.equal(sessions.length, 2);
const other = sessions.find((s) => !s.current);
assert.ok(other, 'other session visible');
const revoked = sessCtx.revoke('current', other.hash);
assert.equal(revoked.ok, true);
assert.equal(revoked.sessions.some((s) => s.hash === other.hash), false, 'target session gone');
assert.equal(revoked.sessions.some((s) => s.current), true, 'current session remains');

// --- syntax ---------------------------------------------------------------
for (const f of backendFiles) {
  assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f + ' parses');
}
const scripts = client.match(/<script>([\s\S]*?)<\/script>/g) || [];
scripts.forEach((s, i) => {
  assert.doesNotThrow(() => new vm.Script(s.replace(/^<script>/, '').replace(/<\/script>$/, ''), { filename: 'features-' + i }), 'AppFeatures parses');
});

console.log('Feature checks passed: manifest, API surface, UI surfaces, splits, currency metadata, sessions, scans, backup/report/image hooks.');
