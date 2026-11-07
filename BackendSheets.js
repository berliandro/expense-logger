// ---------- SHEET WRITING ----------

var TEMPLATE_HEADERS = ['Date', 'Description', 'Amount', 'Category', 'Spending Type', 'Type', 'Merchant', 'Notes', 'Transaction ID', 'Entry ID'];
var TEMPLATE_WIDTHS = [100, 173, 100, 157, 127, 103, 207, 392, 130, 140];

function getOrCreateTemplateSheet_(ss) {
  var template = ss.getSheetByName(TEMPLATE_SHEET_NAME);
  if (template) return template;
  template = ss.insertSheet(TEMPLATE_SHEET_NAME);
  template.getRange(1, 1, 1, TEMPLATE_HEADERS.length).setValues([TEMPLATE_HEADERS]);
  for (var i = 0; i < TEMPLATE_WIDTHS.length; i++) {
    try { template.setColumnWidth(i + 1, TEMPLATE_WIDTHS[i]); } catch (e) {}
  }
  try { template.setFrozenRows(1); } catch (e) {}
  try { template.hideSheet(); } catch (e) {}
  return template;
}

// ---------- TRANSACTION IDS (date-prefixed, per receipt) ----------

var TXN_ID_HEADER = 'Transaction ID';
var ENTRY_ID_HEADER = 'Entry ID';
var ENTRY_ID_WIDTH = 140;
var LEDGER_SHEET_NAME = '_CF_Submissions';
var LEDGER_HEADERS = ['Submission ID', 'Row ID', 'Transaction ID', 'Status', 'Updated At'];

// 0->AA ... 25->AZ, 26->BA ... 675->ZZ, 676->AAA (extends, never duplicates).
function seqToLetters_(n) {
  n = Math.max(0, Math.floor(Number(n) || 0)) + 26; // offset reserves AA..ZZ range first
  var s = '';
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

// Inverse of seqToLetters_; null unless exact uppercase-letter format.
function lettersToSeq_(s) {
  s = String(s || '');
  if (!/^[A-Z]{2,}$/.test(s)) return null;
  var v = 0;
  for (var i = 0; i < s.length; i++) v = v * 26 + (s.charCodeAt(i) - 64);
  return v - 27;
}

// Full ID compare: date part, then suffix as a base-26 number (mixed lengths OK).
// Malformed/blank IDs sort after valid ones, stably.
function compareTxnIds_(a, b) {
  var ma = String(a || '').match(/^(\d{8})([A-Z]{2,})$/);
  var mb = String(b || '').match(/^(\d{8})([A-Z]{2,})$/);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    var sa = lettersToSeq_(ma[2]), sb = lettersToSeq_(mb[2]);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }
  if (ma) return -1;
  if (mb) return 1;
  return 0;
}

function isMonthSheetName_(name) {
  return /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(String(name || ''));
}

function normHeader_(h) { return String(h == null ? '' : h).trim().toLowerCase(); }

function colByName_(headers, name) {
  var want = normHeader_(name);
  for (var i = 0; i < headers.length; i++) {
    if (normHeader_(headers[i]) === want) return i + 1; // 1-based
  }
  return 0;
}

// Idempotent header migration: adds Transaction ID to Template + legacy
// month sheets without moving or overwriting anything. Returns sheet names touched.
function ensureTransactionIdColumn_(ss) {
  var touched = [];
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var name = sh.getName();
    if (name === LEDGER_SHEET_NAME) continue;
    if (name !== TEMPLATE_SHEET_NAME && !isMonthSheetName_(name)) continue;
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) continue;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    if (colByName_(headers, TXN_ID_HEADER) > 0) continue;
    sh.getRange(1, lastCol + 1).setValue(TXN_ID_HEADER);
    try { sh.setColumnWidth(lastCol + 1, 130); } catch (e) {}
    touched.push(name);
  }
  return touched;
}

// Idempotent Entry ID migration: adds the header to Template + legacy month
// sheets and backfills a unique ID for data rows missing one, without
// touching any other value. Returns {addedTo, backfilled}.
function ensureEntryIdColumn_(ss) {
  var addedTo = [], backfilled = 0;
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var name = sh.getName();
    if (name === LEDGER_SHEET_NAME || name === TRASH_SHEET_NAME) continue;
    if (name !== TEMPLATE_SHEET_NAME && !isMonthSheetName_(name)) continue;
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) continue;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var c = colByName_(headers, ENTRY_ID_HEADER);
    if (!c) {
      c = lastCol + 1;
      sh.getRange(1, c).setValue(ENTRY_ID_HEADER);
      try { sh.setColumnWidth(c, ENTRY_ID_WIDTH); } catch (e) {}
      addedTo.push(name);
    }
    var lastRow = sh.getLastRow();
    if (name !== TEMPLATE_SHEET_NAME && lastRow >= 2) {
      var vals = sh.getRange(2, c, lastRow - 1, 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (!String(vals[i][0] || '').trim()) {
          sh.getRange(i + 2, c).setValue(Utilities.getUuid());
          backfilled++;
        }
      }
    }
  }
  return { addedTo: addedTo, backfilled: backfilled };
}

// Hidden operational ledger: idempotency metadata ONLY (no images/keys/notes).
function ledgerSheet_(ss) {
  var sh = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(LEDGER_SHEET_NAME);
    sh.getRange(1, 1, 1, LEDGER_HEADERS.length).setValues([LEDGER_HEADERS]);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function ledgerRead_(ss) {
  var map = {};
  var sh = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (!sh) return map;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return map;
  var vals = sh.getRange(2, 1, lastRow - 1, LEDGER_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var key = String(vals[i][0] || '') + '|' + String(vals[i][1] || '');
    if (key !== '|') map[key] = { transactionId: String(vals[i][2] || ''), status: String(vals[i][3] || '') };
  }
  return map;
}

function ledgerWrite_(ss, entries) {
  if (!entries || !entries.length) return;
  var sh = ledgerSheet_(ss);
  var start = sh.getLastRow() + 1;
  var vals = entries.map(function (e) {
    return [e.submissionId, e.rowId, e.transactionId, e.status, new Date()];
  });
  sh.getRange(start, 1, vals.length, LEDGER_HEADERS.length).setValues(vals);
}

// ---------- TRASH (recoverable deletion, 7-day retention) ----------
//
// Deleted month-sheet rows are preserved as typed records in a hidden sheet.
// Retention is measured from the server deletion timestamp (deleted_at),
// never from the receipt Date. Expiry is group-atomic: a transaction group
// is purged only once its newest record is 7+ days old, so a group never
// expires halfway. No API keys, images, or session data are stored here.
var TRASH_SHEET_NAME = '_CF_Trash';
var TRASH_HEADERS = ['Trash ID', 'Group ID', 'Type', 'Entry ID', 'Transaction ID',
  'Sheet', 'Row JSON', 'Deleted At Ms', 'Deleted At ISO'];
var TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function trashSheet_(ss) {
  var sh = ss.getSheetByName(TRASH_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(TRASH_SHEET_NAME);
    sh.getRange(1, 1, 1, TRASH_HEADERS.length).setValues([TRASH_HEADERS]);
    try { sh.hideSheet(); } catch (e) {}
  } else {
    normalizeTrashSheet_(sh);
  }
  return sh;
}

// Maps a Trash header row to canonical field positions by header name
// (case/space-insensitive, first occurrence wins). Missing fields map to -1.
// Never assumes fixed column positions: records written under an earlier or
// shuffled column layout are still read correctly.
function trashHeaderMap_(headers) {
  var map = { trashId: -1, groupId: -1, type: -1, entryId: -1, transactionId: -1, sheet: -1, rowJson: -1, deletedAtMs: -1, deletedAtIso: -1 };
  var names = { trashId: 'trash id', groupId: 'group id', type: 'type', entryId: 'entry id', transactionId: 'transaction id', sheet: 'sheet', rowJson: 'row json', deletedAtMs: 'deleted at ms', deletedAtIso: 'deleted at iso' };
  for (var i = 0; i < headers.length; i++) {
    var n = normHeader_(headers[i]);
    for (var k in names) {
      if (names[k] === n && map[k] < 0) map[k] = i;
    }
  }
  return map;
}

function trashDefault_(field) {
  if (field === 'trashId') return Utilities.getUuid();
  if (field === 'deletedAtMs') return Date.now();
  if (field === 'deletedAtIso') return new Date().toISOString();
  return '';
}

// Idempotent Trash schema migration. Validates the header row against
// TRASH_HEADERS and, when it differs (legacy/shuffled layout), remaps every
// data row by header name into the canonical layout. Non-canonical columns
// are preserved as trailing extras; no record is dropped, reordered, or
// renumbered, so row references stay valid. Already-canonical sheets are
// left untouched (second runs are no-ops).
function normalizeTrashSheet_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) {
    sh.getRange(1, 1, 1, TRASH_HEADERS.length).setValues([TRASH_HEADERS]);
    return { migrated: true, reason: 'empty' };
  }
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = trashHeaderMap_(headers);
  var order = ['trashId', 'groupId', 'type', 'entryId', 'transactionId', 'sheet', 'rowJson', 'deletedAtMs', 'deletedAtIso'];
  var aligned = lastCol >= TRASH_HEADERS.length;
  if (aligned) {
    for (var a = 0; a < order.length; a++) {
      if (map[order[a]] !== a) { aligned = false; break; }
    }
  }
  // A canonical header prefix with preserved trailing extras is steady
  // state: later runs must be no-ops.
  if (aligned) return { migrated: false };
  var used = {};
  order.forEach(function (k) { if (map[k] >= 0) used[map[k]] = true; });
  var extraIdx = [];
  for (var c = 0; c < lastCol; c++) if (!used[c]) extraIdx.push(c);
  var newWidth = TRASH_HEADERS.length + extraIdx.length;
  var newHeader = TRASH_HEADERS.concat(extraIdx.map(function (i) { return String(headers[i]); }));
  var lastRow = sh.getLastRow();
  var data = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var newData = data.map(function (row) {
    var nr = order.map(function (k) { return map[k] >= 0 ? row[map[k]] : trashDefault_(k); });
    extraIdx.forEach(function (i) { nr.push(row[i]); });
    return nr;
  });
  sh.getRange(1, 1, 1, newWidth).setValues([newHeader]);
  if (newData.length) sh.getRange(2, 1, newData.length, newWidth).setValues(newData);
  return { migrated: true, reason: 'remapped', rows: newData.length };
}

function isSystemSheetName_(name) {
  return name === TEMPLATE_SHEET_NAME || name === LEDGER_SHEET_NAME ||
    name === TRASH_SHEET_NAME || String(name || '').indexOf('_CF_') === 0;
}

// Encodes one month-sheet data row with types so restore round-trips Dates
// and numbers exactly instead of reviving everything as strings.
function encodeTrashRow_(headers, values) {
  var types = values.map(function (v) {
    if (v === '' || v == null) return 'e';
    if (Object.prototype.toString.call(v) === '[object Date]') return 'd';
    if (typeof v === 'number') return 'n';
    if (typeof v === 'boolean') return 'b';
    return 's';
  });
  var vals = values.map(function (v, i) {
    if (types[i] === 'd') return v.getTime();
    if (types[i] === 'e') return '';
    return v;
  });
  return JSON.stringify({ headers: headers, values: vals, types: types });
}

function decodeTrashRow_(json) {
  var o = JSON.parse(json);
  var vals = (o.values || []).map(function (v, i) {
    var t = (o.types || [])[i] || 's';
    if (t === 'd') return new Date(Number(v));
    if (t === 'n') return Number(v);
    if (t === 'b') return !!v;
    if (t === 'e') return '';
    return String(v);
  });
  return { headers: o.headers || [], values: vals };
}

function trashRead_(ss) {
  var out = [];
  var sh = ss.getSheetByName(TRASH_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  normalizeTrashSheet_(sh);
  var lastCol = sh.getLastColumn();
  var map = trashHeaderMap_(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  var lastRow = sh.getLastRow();
  var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var ms = map.deletedAtMs >= 0 ? Number(row[map.deletedAtMs]) : NaN;
    if (!isFinite(ms)) {
      var parsed = Date.parse(String(map.deletedAtIso >= 0 ? row[map.deletedAtIso] : '' || ''));
      // Unknown age keeps the full retention window: never purge a record
      // whose deletion timestamp cannot be established.
      ms = isFinite(parsed) ? parsed : Date.now();
    }
    out.push({
      rowNum: i + 2,
      trashId: map.trashId >= 0 ? String(row[map.trashId] || '') : Utilities.getUuid(),
      groupId: String(map.groupId >= 0 ? row[map.groupId] || '' : ''),
      type: String(map.type >= 0 ? row[map.type] || '' : ''),
      entryId: String(map.entryId >= 0 ? row[map.entryId] || '' : ''),
      transactionId: String(map.transactionId >= 0 ? row[map.transactionId] || '' : ''),
      sheet: String(map.sheet >= 0 ? row[map.sheet] || '' : ''),
      rowJson: String(map.rowJson >= 0 ? row[map.rowJson] || '' : ''),
      deletedAtMs: ms,
      deletedAtIso: map.deletedAtIso >= 0 ? String(row[map.deletedAtIso] || '') : new Date(ms).toISOString()
    });
  }
  return out;
}

function trashEntryIds_(ss) {
  var set = {};
  var rows = trashRead_(ss);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].entryId) set[rows[i].entryId] = true;
  }
  return set;
}

// Locates one live line item by Entry ID across month sheets only.
function findEntryRow_(ss, entryId) {
  entryId = String(entryId || '');
  if (!entryId) return null;
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    if (!isMonthSheetName_(sh.getName())) continue;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var c = colByName_(headers, ENTRY_ID_HEADER);
    if (!c) continue;
    var vals = sh.getRange(2, c, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '') === entryId) {
        return { sheet: sh, rowNum: i + 2, headers: headers, lastCol: lastCol };
      }
    }
  }
  return null;
}

// Locates every live row sharing one Transaction ID (month sheets only).
function findTxnRows_(ss, transactionId) {
  transactionId = String(transactionId || '');
  var out = [];
  if (!transactionId) return out;
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    if (!isMonthSheetName_(sh.getName())) continue;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var c = colByName_(headers, TXN_ID_HEADER);
    if (!c) continue;
    var vals = sh.getRange(2, c, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '') === transactionId) {
        out.push({ sheet: sh, rowNum: i + 2, headers: headers, lastCol: lastCol });
      }
    }
  }
  return out;
}

// Derives a validated 'MMMM yyyy' month-sheet name from a saved receipt date
// value (Date, epoch ms, 'yyyy-MM-dd', or any unambiguous date string).
// Returns '' when the value is missing or invalid - callers must refuse
// rather than guess. Never yields a date-string sheet name.
function monthNameFromDateStr_(value, ss) {
  var d = null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    d = value;
  } else if (typeof value === 'number' && isFinite(value)) {
    d = new Date(value);
  } else if (typeof value === 'string' && value) {
    var m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else if (/^\d{12,}$/.test(value.trim())) {
      d = new Date(Number(value.trim()));
    } else {
      var t = new Date(value);
      if (!isNaN(t.getTime())) d = t;
    }
  }
  if (!d || isNaN(d.getTime())) return '';
  var name = '';
  try {
    name = Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'MMMM yyyy');
  } catch (e) { return ''; }
  return isMonthSheetName_(name) ? name : '';
}

// Pure destination planning for restores: resolves where a record would go
// without creating anything, so a transaction group can be validated fully
// before any row is written (all-or-none atomicity). Throws with a useful
// diagnostic when neither the saved sheet name nor the receipt date yields
// a real month sheet. Never plans a date-named sheet.
function planRestoreSheet_(ss, name, txnDateValue) {
  name = String(name || '');
  var existing = name && ss.getSheetByName(name);
  if (existing) return { sheet: existing };
  if (isMonthSheetName_(name)) {
    if (monthNameFromDateStr_(txnDateValue, ss)) return { monthDate: txnDateValue };
    return { named: name };
  }
  if (monthNameFromDateStr_(txnDateValue, ss)) return { monthDate: txnDateValue };
  throw new Error('Cannot restore - the saved sheet reference "' + (name || '(empty)') + '" is not a month sheet and no usable receipt date was saved with the record. The Trash entry was left untouched for recovery.');
}

function monthSheetForRestore_(ss, name, txnDateValue) {
  var plan = planRestoreSheet_(ss, name, txnDateValue);
  if (plan.sheet) return plan.sheet;
  if (plan.monthDate !== undefined) return getOrCreateMonthSheet(ss, plan.monthDate);
  return ss.insertSheet(plan.named);
}

// Moves rows to Trash and deletes sources as one locked, idempotent operation.
// targets: [{sheet, rowNum, headers, lastCol}]. Returns {moved, alreadyMoved}.
function trashMoveRows_(ss, targets, groupId, type) {
  var tsh = trashSheet_(ss);
  var trashed = trashEntryIds_(ss);
  var moved = 0, alreadyMoved = 0;
  var fresh = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var rowVals = t.sheet.getRange(t.rowNum, 1, 1, t.lastCol).getValues()[0];
    var entryId = '';
    var ce = colByName_(t.headers, ENTRY_ID_HEADER);
    if (ce > 0) entryId = String(rowVals[ce - 1] || '');
    if (entryId && trashed[entryId]) { alreadyMoved++; continue; }
    fresh.push({ t: t, rowVals: rowVals, entryId: entryId });
  }
  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();
  for (var j = 0; j < fresh.length; j++) {
    var f = fresh[j];
    var ctx = colByName_(f.t.headers, TXN_ID_HEADER);
    var txnId = ctx > 0 ? String(f.rowVals[ctx - 1] || '') : '';
    tsh.getRange(tsh.getLastRow() + 1, 1, 1, TRASH_HEADERS.length).setValues([[
      Utilities.getUuid(), groupId, type, f.entryId, txnId, f.t.sheet.getName(),
      encodeTrashRow_(f.t.headers, f.rowVals), nowMs, nowIso
    ]]);
    moved++;
  }
  // Delete sources bottom-up per sheet so physical row numbers stay valid.
  var bySheet = {};
  for (var k = 0; k < fresh.length; k++) {
    var nm = fresh[k].t.sheet.getName();
    (bySheet[nm] = bySheet[nm] || { sheet: fresh[k].t.sheet, rows: [] }).rows.push(fresh[k].t.rowNum);
  }
  for (var key in bySheet) {
    if (!Object.prototype.hasOwnProperty.call(bySheet, key)) continue;
    var list = bySheet[key].rows.sort(function (a, b) { return b - a; });
    for (var d = 0; d < list.length; d++) bySheet[key].sheet.deleteRow(list[d]);
  }
  if (moved > 0) bumpHistoryCacheVersion_();
  return { moved: moved, alreadyMoved: alreadyMoved };
}

// Session-gated: move line items to Trash. Each entryId resolves to exactly
// one live row; duplicates in the request are moved once.
function deleteEntries(sessionToken, entryIds, operationId) {
  requireSession_(sessionToken);
  entryIds = entryIds || [];
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    throw new Error('Select at least one entry to delete.');
  }
  var opId = String(operationId || '').trim() || Utilities.getUuid();
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    ensureEntryIdColumn_(ss);
    var seen = {};
    var targets = [];
    var missing = [];
    for (var i = 0; i < entryIds.length; i++) {
      var id = String(entryIds[i] || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      var found = findEntryRow_(ss, id);
      if (found) targets.push(found);
      else missing.push(id);
    }
    if (!targets.length) {
      // Everything is already gone: idempotent success, nothing to do.
      return { moved: 0, alreadyMoved: entryIds.length, missing: missing };
    }
    var res = trashMoveRows_(ss, targets, opId, 'entry');
    res.missing = missing;
    return res;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Session-gated: move a whole receipt (every row with one Transaction ID).
function deleteTransaction(sessionToken, transactionId, operationId) {
  requireSession_(sessionToken);
  transactionId = String(transactionId || '').trim();
  if (!transactionId) {
    throw new Error('That record has no Transaction ID, so only the single entry can be deleted - the receipt group cannot be determined.');
  }
  var opId = String(operationId || '').trim() || Utilities.getUuid();
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    ensureEntryIdColumn_(ss);
    var targets = findTxnRows_(ss, transactionId);
    if (!targets.length) {
      return { moved: 0, alreadyMoved: 0, transactionId: transactionId, note: 'No live rows carry that Transaction ID - it may already be in Trash.' };
    }
    var res = trashMoveRows_(ss, targets, opId, 'transaction');
    res.transactionId = transactionId;
    res.count = targets.length;
    return res;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Session-gated: describes one live receipt for the delete confirmation
// dialog (exact affected line-item count — never guessed client-side).
function describeTransaction(sessionToken, transactionId) {
  requireSession_(sessionToken);
  transactionId = String(transactionId || '').trim();
  if (!transactionId) throw new Error('That record has no Transaction ID.');
  var ss = getSpreadsheet_();
  var rows = findTxnRows_(ss, transactionId);
  if (!rows.length) {
    return { transactionId: transactionId, count: 0, merchant: '', date: '', hasLiveRows: false };
  }
  var first = rows[0];
  var vals = first.sheet.getRange(first.rowNum, 1, 1, first.lastCol).getValues()[0];
  function byName(nm) {
    for (var h = 0; h < first.headers.length; h++) {
      if (normHeader_(first.headers[h]) === nm) return vals[h];
    }
    return '';
  }
  var d = byName('date');
  return {
    transactionId: transactionId,
    count: rows.length,
    merchant: String(byName('merchant') || ''),
    date: Object.prototype.toString.call(d) === '[object Date]'
      ? Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(d || ''),
    hasLiveRows: true
  };
}

// Groups trash rows for list/restore/expiry views.
function groupTrashRows_(rows) {
  var groups = {}, order = [];
  for (var i = 0; i < rows.length; i++) {
    var g = rows[i].groupId || rows[i].trashId;
    if (!groups[g]) { groups[g] = []; order.push(g); }
    groups[g].push(rows[i]);
  }
  return { groups: groups, order: order };
}

function trashGroupSummary_(rows) {
  var total = 0, merchant = '', dateStr = '', txnId = '', desc = '';
  var entryIds = [];
  for (var i = 0; i < rows.length; i++) {
    var rec;
    try { rec = decodeTrashRow_(rows[i].rowJson); } catch (e) { continue; }
    var byName = {};
    for (var h = 0; h < rec.headers.length; h++) byName[normHeader_(rec.headers[h])] = rec.values[h];
    if (!merchant && byName['merchant']) merchant = String(byName['merchant']);
    if (!desc) {
      var d = byName['description'];
      if (d == null || String(d) === '') d = byName['notes'];
      if (d == null || String(d) === '') d = byName['category'];
      if (d != null && String(d) !== '') desc = String(d);
    }
    if (!dateStr && byName['date']) {
      dateStr = Object.prototype.toString.call(byName['date']) === '[object Date]'
        ? Utilities.formatDate(byName['date'], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(byName['date']);
    }
    if (!txnId && rows[i].transactionId) txnId = rows[i].transactionId;
    var a = Number(byName['amount']);
    if (isFinite(a)) total += a;
  }
  var newest = 0;
  for (var j = 0; j < rows.length; j++) {
    if (Number(rows[j].deletedAtMs) > newest) newest = Number(rows[j].deletedAtMs);
    if (rows[j].entryId) entryIds.push(rows[j].entryId);
  }
  return { merchant: merchant, date: dateStr, transactionId: txnId, description: desc, total: total, newestDeletedAtMs: newest, entryIds: entryIds };
}

// Deletes trash rows whose whole group is 7+ days old (group-atomic).
// Returns {removedGroups, removedRows}. Never purges recent records.
function cleanupExpiredTrash_(ss, nowMs) {
  var rows = trashRead_(ss);
  if (!rows.length) return { removedGroups: 0, removedRows: 0 };
  var g = groupTrashRows_(rows);
  var killNums = [];
  var removedGroups = 0, removedRows = 0;
  for (var i = 0; i < g.order.length; i++) {
    var members = g.groups[g.order[i]];
    var newest = 0;
    for (var j = 0; j < members.length; j++) {
      var t = Number(members[j].deletedAtMs) || 0;
      if (t > newest) newest = t;
    }
    if (newest > 0 && nowMs - newest >= TRASH_RETENTION_MS) {
      removedGroups++;
      for (var k = 0; k < members.length; k++) {
        killNums.push(members[k].rowNum);
        removedRows++;
      }
    }
  }
  if (killNums.length) {
    var sh = ss.getSheetByName(TRASH_SHEET_NAME);
    killNums.sort(function (a, b) { return b - a; });
    for (var d = 0; d < killNums.length; d++) sh.deleteRow(killNums[d]);
  }
  return { removedGroups: removedGroups, removedRows: removedRows };
}

// Session-gated cleanup endpoint. Always decides by server time + deleted_at.
function cleanupTrash(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    var res = cleanupExpiredTrash_(ss, Date.now());
    res.ok = true;
    return res;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Session-gated Trash listing. Always runs the backend expiry check first so
// the view is current, then returns live groups with time remaining.
function listTrash(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    var cleaned = cleanupExpiredTrash_(ss, Date.now());
    var g = groupTrashRows_(trashRead_(ss));
    var nowMs = Date.now();
    var groups = [];
    for (var i = 0; i < g.order.length; i++) {
      var members = g.groups[g.order[i]];
      var sum = trashGroupSummary_(members);
      groups.push({
        groupId: g.order[i],
        type: members[0].type || 'entry',
        count: members.length,
        merchant: sum.merchant,
        date: sum.date,
        description: sum.description,
        transactionId: sum.transactionId,
        entryIds: sum.entryIds,
        total: sum.total,
        deletedAtMs: sum.newestDeletedAtMs,
        expiresAtMs: sum.newestDeletedAtMs + TRASH_RETENTION_MS,
        msRemaining: Math.max(0, sum.newestDeletedAtMs + TRASH_RETENTION_MS - nowMs)
      });
    }
    groups.sort(function (a, b) { return b.deletedAtMs - a.deletedAtMs; });
    return { groups: groups, cleaned: cleaned };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Restores one trash row by Entry ID. Entry must be live-absent (no dup) and
// unexpired. Appends to the original month sheet (recreated if needed).
function restoreEntry(sessionToken, entryId) {
  requireSession_(sessionToken);
  entryId = String(entryId || '').trim();
  if (!entryId) throw new Error('Select an entry to restore.');
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    cleanupExpiredTrash_(ss, Date.now());
    var rows = trashRead_(ss);
    var rec = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].entryId === entryId) { rec = rows[i]; break; }
    }
    if (!rec) {
      throw new Error('That entry is no longer in Trash (it may have expired after 7 days or already been restored). The list has been refreshed.');
    }
    if (findEntryRow_(ss, entryId)) {
      throw new Error('That entry already exists in the live sheet - restore blocked to avoid a duplicate.');
    }
    restoreTrashRecord_(ss, rec);
    deleteTrashRows_(ss, [rec.rowNum]);
    return { restored: 1, entryId: entryId, transactionId: rec.transactionId };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Restores a whole deletion group atomically: every member or none.
function restoreTransaction(sessionToken, groupId) {
  requireSession_(sessionToken);
  groupId = String(groupId || '').trim();
  if (!groupId) throw new Error('Select a transaction to restore.');
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    cleanupExpiredTrash_(ss, Date.now());
    var rows = trashRead_(ss).filter(function (r) { return r.groupId === groupId; });
    if (!rows.length) {
      throw new Error('That transaction is no longer in Trash (it may have expired after 7 days or already been restored). The list has been refreshed.');
    }
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].entryId && findEntryRow_(ss, rows[i].entryId)) {
        throw new Error('One row of that transaction already exists live - restore blocked to avoid duplicates. Nothing was restored.');
      }
    }
    // Pre-validate every member's payload and destination before writing
    // anything: a single unrecoverable member blocks the whole group, so a
    // late failure can never leave a half-restored transaction.
    for (var v = 0; v < rows.length; v++) {
      var preview;
      try {
        preview = decodeTrashRow_(rows[v].rowJson);
      } catch (e) {
        throw new Error('Cannot restore - one saved record payload is corrupted and cannot be read. Nothing was restored; the Trash entries were left untouched.');
      }
      var dateVal = '';
      for (var h = 0; h < preview.headers.length; h++) {
        if (normHeader_(preview.headers[h]) === 'date' && preview.values[h] !== '' && preview.values[h] != null) {
          dateVal = preview.values[h];
          break;
        }
      }
      planRestoreSheet_(ss, rows[v].sheet, dateVal);
    }
    for (var j = 0; j < rows.length; j++) restoreTrashRecord_(ss, rows[j]);
    var nums = rows.map(function (r) { return r.rowNum; }).sort(function (a, b) { return b - a; });
    deleteTrashRows_(ss, nums);
    return { restored: rows.length, groupId: groupId, transactionId: rows[0].transactionId };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function deleteTrashRows_(ss, rowNums) {
  if (!rowNums || !rowNums.length) return;
  var sh = ss.getSheetByName(TRASH_SHEET_NAME);
  if (!sh) return;
  var nums = rowNums.slice().sort(function (a, b) { return b - a; });
  for (var i = 0; i < nums.length; i++) sh.deleteRow(nums[i]);
}

// Appends one trash record back to its month sheet with original IDs intact.
// Never mints new IDs and never overwrites live rows (checked by callers).
function restoreTrashRecord_(ss, rec) {
  var data;
  try {
    data = decodeTrashRow_(rec.rowJson);
  } catch (e) {
    throw new Error('Cannot restore - the saved record payload is corrupted and cannot be read. The Trash entry was left untouched for recovery.');
  }
  var dateVal = '';
  for (var h = 0; h < data.headers.length; h++) {
    if (normHeader_(data.headers[h]) === 'date' && data.values[h] !== '' && data.values[h] != null) {
      dateVal = data.values[h];
      break;
    }
  }
  var sh = monthSheetForRestore_(ss, rec.sheet, dateVal);
  ensureTransactionIdColumn_(ss);
  ensureEntryIdColumn_(ss);
  cfEnsureSheetFeatureColumns_(sh);
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIndex = {};
  headers.forEach(function (hh, i) { colIndex[normHeader_(hh)] = i + 1; });
  var rowNum = sh.getLastRow() + 1;
  var byName = {};
  for (var k = 0; k < data.headers.length; k++) byName[normHeader_(data.headers[k])] = data.values[k];
  var keys = Object.keys(colIndex);
  for (var n = 0; n < keys.length; n++) {
    if (keys[n] in byName) sh.getRange(rowNum, colIndex[keys[n]]).setValue(byName[keys[n]]);
  }
  bumpHistoryCacheVersion_();
}

// Scans month sheets + ledger once per commit for existing IDs.
// Returns {dateStr: maxSeq}. Malformed IDs are ignored for sequencing.
function collectExistingIdSeq_(ss) {
  var maxSeq = {};
  function feed(id) {
    var m = String(id || '').match(/^(\d{8})([A-Z]{2,})$/);
    if (!m) return;
    var seq = lettersToSeq_(m[2]);
    if (seq == null) return;
    if (maxSeq[m[1]] == null || seq > maxSeq[m[1]]) maxSeq[m[1]] = seq;
  }
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var name = sh.getName();
    if (name === TEMPLATE_SHEET_NAME || name === LEDGER_SHEET_NAME || name === TRASH_SHEET_NAME) continue;
    if (!isMonthSheetName_(name)) continue;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var c = colByName_(headers, TXN_ID_HEADER);
    if (!c) continue;
    var vals = sh.getRange(2, c, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) feed(vals[i][0]);
  }
  var led = ss.getSheetByName(LEDGER_SHEET_NAME);
  if (led && led.getLastRow() >= 2) {
    var lv = led.getRange(2, 3, led.getLastRow() - 1, 1).getValues();
    for (var j = 0; j < lv.length; j++) feed(lv[j][0]);
  }
  return maxSeq;
}

// Assigns one ID per receipt date in order. Caller must hold the script lock.
// dateStrs are validated YYYY-MM-DD; sequence keys are dashless YYYYMMDD.
// Each input is re-normalized defensively so a malformed date can never open
// a garbage bucket (e.g. 'undefinedAA') - it falls back to the transaction
// date rules (unreadable -> today) like every other path.
function allocateTransactionIds_(ss, dateStrs) {
  var maxSeq = collectExistingIdSeq_(ss);
  return dateStrs.map(function (ds) {
    var key = String(normalizeTransactionDate(ds)).replace(/-/g, '');
    var next = (maxSeq[key] == null ? -1 : maxSeq[key]) + 1;
    maxSeq[key] = next;
    return key + seqToLetters_(next);
  });
}

function getOrCreateMonthSheet(ss, transactionDateStr) {
  var date = transactionDateStr ? new Date(transactionDateStr) : new Date();
  if (isNaN(date.getTime())) date = new Date(); // fallback if Gemini gave an unparseable date

  var sheetName = Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), 'MMMM yyyy');
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    var template = getOrCreateTemplateSheet_(ss);
    sheet = template.copyTo(ss);
    sheet.setName(sheetName);
    sheet.showSheet();
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(ss.getNumSheets());
  }

  return sheet;
}

function appendTransactionRows(sheet, txn, sheetNote) {
  cfEnsureSheetFeatureColumns_(sheet);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIndex = {};
  headers.forEach(function (h, i) {
    colIndex[String(h).trim().toLowerCase()] = i + 1;
  });

  txn.items.forEach(function (item) {
    var rowNum = sheet.getLastRow() + 1;
    if (!item.entryId) item.entryId = Utilities.getUuid();
    setIfColumnExists(sheet, rowNum, colIndex, 'date', txn.transaction_date);
    setIfColumnExists(sheet, rowNum, colIndex, 'merchant', txn.merchant);
    setIfColumnExists(sheet, rowNum, colIndex, 'description', item.description);
    setIfColumnExists(sheet, rowNum, colIndex, 'amount', item.amount);
    setIfColumnExists(sheet, rowNum, colIndex, 'category', item.category);
    setIfColumnExists(sheet, rowNum, colIndex, 'spending type', item.spending_type || '');
    setIfColumnExists(sheet, rowNum, colIndex, 'type', txn.transaction_type);
    setIfColumnExists(sheet, rowNum, colIndex, 'notes', sheetNote || '');
    setIfColumnExists(sheet, rowNum, colIndex, 'transaction id', txn.transactionId || '');
    setIfColumnExists(sheet, rowNum, colIndex, 'entry id', item.entryId || '');
    var cur = String(item.currency || txn.currency || 'IDR');
    var fx = Number(item.fxRate || txn.fxRate) || 1;
    var base = item.baseAmount !== undefined ? Number(item.baseAmount)
      : (txn.baseAmount !== undefined ? Number(txn.baseAmount) : (Number(item.amount) || 0) * fx);
    setIfColumnExists(sheet, rowNum, colIndex, 'currency', cur);
    setIfColumnExists(sheet, rowNum, colIndex, 'fx rate', fx);
    setIfColumnExists(sheet, rowNum, colIndex, 'base amount', base);
    setIfColumnExists(sheet, rowNum, colIndex, 'tags', String(item.tags || txn.tags || ''));
    setIfColumnExists(sheet, rowNum, colIndex, 'member', String(item.member || txn.member || ''));
    setIfColumnExists(sheet, rowNum, colIndex, 'reimbursable', String(item.reimbursable || txn.reimbursable || 'No'));
    setIfColumnExists(sheet, rowNum, colIndex, 'reimbursed', String(item.reimbursed || txn.reimbursed || 'No'));
    setIfColumnExists(sheet, rowNum, colIndex, 'receipt hash', String(item.receiptHash || txn.receiptHash || ''));
    setIfColumnExists(sheet, rowNum, colIndex, 'receipt url', String(item.receiptUrl || txn.receiptUrl || ''));
    setIfColumnExists(sheet, rowNum, colIndex, 'split group', String(item.splitGroup || txn.splitGroup || ''));
  });
}

function setIfColumnExists(sheet, row, colIndex, headerKey, value) {
  var col = colIndex[headerKey];
  if (col) sheet.getRange(row, col).setValue(value);
}

// ---------- COMMIT (reconcile + policy + idempotent append) ----------

// Server-truth triage of one final row. No writes, no IDs.
function triageRow_(it, toggles) {
  it = it || {};
  var rowId = String(it.row_id || '');
  var origNum = Math.max(1, Number(it.origNum || 0) || 0);
  if (!rowId) {
    return { row_id: '', origNum: origNum, txn: null, rec: null, status: 'error',
             message: 'Row is missing its stable ID - nothing from this row was appended.', repairEligible: false };
  }
  // A failure captured earlier in the pipeline (e.g. its Phase 1 batch
  // failed) travels with the row so the original cause is reported.
  if (it.preError && !(it.txn)) {
    return { row_id: rowId, origNum: origNum, txn: null, rec: null, status: 'error',
             message: 'Row ' + origNum + ': ' + it.preError, repairEligible: false };
  }
  var raw = it.txn || {};
  try {
    if (it.forcedType === 'Income' || it.forcedType === 'Expense') raw.transaction_type = it.forcedType;
    var txn = sanitizeTransaction(JSON.parse(JSON.stringify(raw)));
    var rec = reconcileRow_(it.phase1 || null, txn, { hasPhoto: !!it.hasPhoto, quickMode: !!(toggles && toggles.quickMode) });
    if (rec.verdict === 'ok' || rec.verdict === 'not_applicable') {
      // A Quick-Input save under a verified total still carries the
      // incomplete-line-list disclosure so it reaches Notes verbatim.
      return { row_id: rowId, origNum: origNum, txn: txn, rec: rec, status: 'verified',
               message: rec.disclosure || '', repairEligible: false };
    }
    if (rec.verdict === 'mismatch') {
      return { row_id: rowId, origNum: origNum, txn: txn, rec: rec, status: 'mismatch',
               message: 'Row ' + origNum + ': ' + rec.message, repairEligible: !it.repaired };
    }
    return { row_id: rowId, origNum: origNum, txn: txn, rec: rec, status: 'review',
             message: 'Row ' + origNum + ': ' + rec.message, repairEligible: false };
  } catch (e) {
    return { row_id: rowId, origNum: origNum, txn: null, rec: null, status: 'error',
             message: 'Row ' + origNum + ': ' + (e && e.message ? e.message : e), repairEligible: false };
  }
}

// Triage without writes, so the client can run bounded repairs first.
function reconcileReceiptRows(submission, items, sessionToken) {
  requireSession_(sessionToken);
  submission = submission || {};
  var toggles = { forceLog: !!submission.forceLog, quickMode: !!submission.quickMode };
  items = items || [];
  return {
    rows: items.map(function (it) {
      var t = triageRow_(it, toggles);
      return { row_id: t.row_id, origNum: t.origNum, status: t.status, message: t.message,
               repairEligible: t.repairEligible,
               expectedTotal: t.rec ? t.rec.expectedTotal : null,
               calculatedTotal: t.rec ? t.rec.calculatedTotal : null,
               difference: t.rec ? t.rec.difference : null };
    })
  };
}

// Authoritative commit: reconciles, applies toggle policy, allocates IDs
// (locked), appends in receipt units, records the ledger. Idempotent per
// submission_id + row_id. Unresolved rows are never appended.
function commitReceiptRows(submission, finals, sessionToken) {
  requireSession_(sessionToken);
  submission = submission || {};
  var submissionId = String(submission.submission_id || '').trim();
  if (!submissionId) throw new Error('Submission is missing its stable ID.');
  var toggles = { forceLog: !!submission.forceLog, quickMode: !!submission.quickMode };
  finals = finals || [];
  if (!Array.isArray(finals) || finals.length === 0) {
    throw new Error('Nothing to commit - no final rows were provided.');
  }

  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    ensureTransactionIdColumn_(ss);
    ensureEntryIdColumn_(ss);
    cfEnsureFeatureSchema_(ss);
    var dupSet = {};
    try { dupSet = cfHashSet_(ss); } catch (eDup) {}
    var ledger = ledgerRead_(ss);
    var rowsOut = [];
    var staged = []; // {final, txn, transactionId, noteFull, status, message}
    var allocDates = [];

    for (var i = 0; i < finals.length; i++) {
      var it = finals[i] || {};
      var key = submissionId + '|' + String(it.row_id || '');
      var prior = ledger[key];
      if (prior && (prior.status === 'logged' || prior.status === 'force-adjusted' || prior.status === 'auto-discount-adjusted')) {
        rowsOut.push({ row_id: it.row_id, origNum: it.origNum, status: prior.status,
          transactionId: prior.transactionId, duplicate: true,
          message: 'Row ' + (it.origNum || '?') + ' was already logged (' + prior.transactionId + ') - not duplicated.' });
        continue;
      }
      var t = triageRow_(it, toggles);
      var fp = (it.receiptHash && t.txn) ? cfDuplicateFingerprint_(t.txn, it.receiptHash) : '';
      if (cfDuplicateDisposition_(submission, fp, dupSet) === 'hold') {
        rowsOut.push({ row_id: it.row_id, origNum: it.origNum, status: 'duplicate-review',
          transactionId: dupSet[fp].transactionId || '',
          message: 'This receipt matches one already in the sheet. Review it, then use “Log anyway” if it is a real second purchase.' });
        continue;
      }
      if (t.status === 'verified') {
        cfApplyTxnMeta_(t.txn, it);
        cfApplySplits_(t.txn, it.splits);
        staged.push({ final: it, txn: t.txn, triage: t, status: 'logged', message: t.message || '', fingerprint: fp });
        allocDates.push(t.txn.transaction_date);
      } else if (t.status === 'mismatch') {
        var pol = applyTogglePolicy_(t.txn, t.rec, toggles);
        if (pol.applied === 'none') {
          rowsOut.push({ row_id: t.row_id, origNum: t.origNum, status: 'review', transactionId: '',
            message: t.message });
        } else {
          var st = 'force-adjusted';
          cfApplyTxnMeta_(pol.txn, it);
          cfApplySplits_(pol.txn, it.splits);
          staged.push({ final: it, txn: pol.txn, triage: t, status: st, message: pol.note, fingerprint: fp });
          allocDates.push(pol.txn.transaction_date);
        }
      } else {
        rowsOut.push({ row_id: t.row_id, origNum: t.origNum,
          status: t.status === 'error' ? 'error' : 'review', transactionId: '', message: t.message });
      }
    }

    var ids = allocateTransactionIds_(ss, allocDates);
    var ledgerEntries = [];
    var oneRow = !!submission.oneRowPerReceipt;
    for (var s = 0; s < staged.length; s++) {
      var st2 = staged[s];
      var txnId = ids[s];
      st2.txn.transactionId = txnId;
      var noteFull = String(st2.final.note || '');
      if (st2.message) noteFull = noteFull ? noteFull + ' | ' + st2.message : st2.message;
      var appendTxn = st2.txn;
      if (oneRow) {
        // One row per receipt (Quick-Input option): the reconciled receipt
        // collapses to its verified total with the item detail preserved in
        // Notes. IDs, dates, and types are unchanged.
        var condensed = condenseTxn_(st2.txn);
        appendTxn = condensed.txn;
        if (condensed.itemLines) noteFull = noteFull ? noteFull + '\n' + condensed.itemLines : condensed.itemLines;
      }
      var sheet = getOrCreateMonthSheet(ss, st2.txn.transaction_date);
      appendTransactionRows(sheet, appendTxn, noteFull);
      if (st2.fingerprint) {
        try { cfRecordHashes_(ss, txnId, appendTxn.items, String(st2.fingerprint)); } catch (eHash) {}
      }
      var total = appendTxn.items.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
      ledgerEntries.push({ submissionId: submissionId, rowId: st2.final.row_id,
        transactionId: txnId, status: st2.status });
      rowsOut.push({ row_id: st2.final.row_id, origNum: st2.final.origNum, status: st2.status,
        transactionId: txnId, type: st2.txn.transaction_type, merchant: st2.txn.merchant,
        itemCount: appendTxn.items.length, total: total,
        disclosure: (st2.triage && st2.triage.rec && st2.triage.rec.disclosure) || '',
        message: st2.status === 'logged' ? '' : st2.message });
    }
    ledgerWrite_(ss, ledgerEntries);
    // One version bump per commit, not one per appended line item.
    if (staged.length > 0) bumpHistoryCacheVersion_();

    var summary = { logged: 0, forceAdjusted: 0, review: 0, errors: 0, duplicates: 0, duplicateReview: 0 };
    for (var r = 0; r < rowsOut.length; r++) {
      var st3 = rowsOut[r].status;
      if (st3 === 'logged') summary.logged++;
      else if (st3 === 'force-adjusted') summary.forceAdjusted++;
      else if (st3 === 'review') summary.review++;
      else if (st3 === 'duplicate-review') summary.duplicateReview++;
      else if (st3 === 'error') summary.errors++;
      if (rowsOut[r].duplicate) summary.duplicates++;
    }
    return { rows: rowsOut, summary: summary,
             sortEligible: (summary.review === 0 && summary.errors === 0 && summary.duplicateReview === 0) };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Condenses one reconciled receipt into a single spreadsheet row for
// one-row-per-receipt mode. Amount is the verified signed total; the full
// item list (including any balancing adjustment, negatives preserved) moves
// into the notes summary.
//
// Nothing is fabricated here:
//  - Description prefers the receipt's own printed title; otherwise a single
//    item uses its own description, and several items use merchant plus the
//    dominant category and item count - all facts already on the transaction.
//  - Quantities and unit prices appear only when the model returned them as
//    structured numbers (sanitizeTransaction_ drops everything else). A
//    missing unit price is never derived by division and never invented.
//  - Original items stay on the transaction for debugging/review; exactly one
//    spreadsheet row is written.
function condenseTxn_(txn) {
  var items = (txn && txn.items) || [];
  var total = Math.round(items.reduce(function (s, it) { return s + Number(it.amount || 0); }, 0));
  var merchant = String(txn.merchant || 'Unknown');
  var printed = String(txn.receipt_title || '').trim();
  var category = dominantCategory_(txn);
  var desc;
  if (printed) desc = printed;
  else if (items.length === 1) desc = String(items[0].description || merchant);
  else desc = merchant + ' · ' + category + ' (' + items.length + ' items)';
  var lines = items.map(function (it) {
    var label = String(it.description || '');
    var parts = [];
    var qty = Number(it.quantity);
    if (isFinite(qty) && qty > 0) parts.push('×' + (qty + '').replace(/\.0+$/, ''));
    var unit = Number(it.unit_price);
    if (isFinite(unit) && unit !== 0) parts.push('@ ' + idr_(unit));
    var amount = idr_(Number(it.amount || 0));
    return '- ' + label + (parts.length ? ' ' + parts.join(' ') + ' = ' + amount : ': ' + amount);
  });
  var isIncome = txn.transaction_type === 'Income';
  return {
    txn: {
      transaction_date: txn.transaction_date,
      merchant: txn.merchant,
      transaction_type: txn.transaction_type,
      line_list_complete: txn.line_list_complete,
      extraction_notes: txn.extraction_notes,
      receipt_title: txn.receipt_title,
      transactionId: txn.transactionId,
      currency: txn.currency, fxRate: txn.fxRate, tags: txn.tags, member: txn.member,
      reimbursable: txn.reimbursable, reimbursed: txn.reimbursed,
      receiptHash: txn.receiptHash, receiptUrl: txn.receiptUrl, splitGroup: txn.splitGroup,
      items: [{
        description: desc,
        amount: total,
        category: category,
        spending_type: isIncome ? '' : dominantSpendingType_(txn)
      }]
    },
    itemLines: lines.join('\n')
  };
}
