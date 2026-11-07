// =====================================================================
// Cashflow Log — feature backend
// Budgets, recurring rules, household members, dashboard/search, edit,
// sessions, backup/restore, reports, image retention, duplicates and
// reimbursement. All client access goes through the session-gated cfApi.
// =====================================================================

var CF_FEATURE_COLUMNS = ['Currency', 'FX Rate', 'Base Amount', 'Tags', 'Member',
  'Reimbursable', 'Reimbursed', 'Receipt Hash', 'Receipt URL', 'Split Group'];
var CF_BUDGET_SHEET = '_CF_Budgets';
var CF_RECURRING_SHEET = '_CF_Recurring';
var CF_HOUSEHOLD_SHEET = '_CF_Household';
var CF_HASH_SHEET = '_CF_ReceiptHashes';
var CF_SETTINGS_KEY = 'CF_FEATURE_SETTINGS_V1';
var CF_DRIVE_FOLDER_KEY = 'CF_RECEIPT_FOLDER_ID';
var CF_SCHEMA_VERSION_KEY = 'CF_SCHEMA_VERSION';
var CF_SCHEMA_VERSION = '1';
var CF_SCAN_MAX_SHEETS = 36;
var CF_SCAN_MAX_ROWS = 25000;
var CF_HISTORY_MAX_ROWS = 500;

var CF_FEATURE_DEFAULTS = {
  defaultCurrency: 'IDR',
  baseCurrency: 'IDR',
  retainImages: false,
  reviewBeforeCommit: false,
  householdMode: true,
  reimbursementEnabled: true,
  currencyRates: {}
};

function cfFeatureCorrelation_() {
  return 'cf-' + Utilities.getUuid().slice(0, 8);
}

function cfFeatureSettings_() {
  var out = JSON.parse(JSON.stringify(CF_FEATURE_DEFAULTS));
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CF_SETTINGS_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        for (var k in out) {
          if (Object.prototype.hasOwnProperty.call(out, k) && o[k] !== undefined) out[k] = o[k];
        }
      }
    }
  } catch (e) {}
  return out;
}

function cfSaveFeatureSettings_(patch) {
  var cur = cfFeatureSettings_();
  patch = patch || {};
  for (var k in cur) {
    if (Object.prototype.hasOwnProperty.call(cur, k) && patch[k] !== undefined) cur[k] = patch[k];
  }
  try {
    PropertiesService.getScriptProperties().setProperty(CF_SETTINGS_KEY, JSON.stringify(cur));
  } catch (e) {
    throw new Error('Could not save settings - try again.');
  }
  return cur;
}

function cfFeatureSheet_(ss, name, headers, widths) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var lastCol = sh.getLastColumn();
  if (!lastCol || sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normHeader_(h); });
    var missing = [];
    headers.forEach(function (h) {
      if (existing.indexOf(normHeader_(h)) === -1) missing.push(h);
    });
    if (missing.length) sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
  var allHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  widths = widths || [];
  for (var i = 0; i < allHeaders.length; i++) {
    try { sh.setColumnWidth(i + 1, widths[i] || 140); } catch (e) {}
  }
  try { sh.setFrozenRows(1); } catch (e2) {}
  try { if (name.indexOf('_CF_') === 0) sh.hideSheet(); } catch (e3) {}
  return sh;
}

function cfEnsureSheetFeatureColumns_(sh) {
  if (!sh) return false;
  var headers = CF_FEATURE_COLUMNS;
  var lastCol = sh.getLastColumn();
  if (!lastCol || sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return true;
  }
  var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return normHeader_(h); });
  var missing = [];
  headers.forEach(function (h) {
    if (existing.indexOf(normHeader_(h)) === -1) missing.push(h);
  });
  if (missing.length) sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  return missing.length > 0;
}

function cfEnsureFeatureSheets_(ss) {
  var defs = [
    [CF_BUDGET_SHEET, ['Category', 'Monthly Limit', 'Updated At'], [180, 160, 180]],
    [CF_RECURRING_SHEET,
      ['Rule ID', 'Description', 'Amount', 'Category', 'Spending Type', 'Type', 'Member', 'Tags', 'Day', 'Active', 'Last Run', 'Created At'],
      [150, 220, 120, 160, 120, 100, 140, 180, 80, 90, 130, 170]],
    [CF_HOUSEHOLD_SHEET, ['Member ID', 'Name', 'Active', 'Created At'], [150, 200, 90, 170]],
    [CF_HASH_SHEET, ['Receipt Hash', 'Transaction ID', 'Entry ID', 'Created At'], [280, 150, 150, 170]]
  ];
  defs.forEach(function (d) {
    if (!ss.getSheetByName(d[0])) cfFeatureSheet_(ss, d[0], d[1], d[2]);
  });
}

// Idempotent migration. Appends new headers to Template and every month sheet
// in place; existing column positions and data are never moved. A version flag
// skips the expensive header scan after the first successful migration.
function cfEnsureFeatureSchema_(ss) {
  ss = ss || getSpreadsheet_();
  cfEnsureFeatureSheets_(ss);
  try {
    if (PropertiesService.getScriptProperties().getProperty(CF_SCHEMA_VERSION_KEY) === CF_SCHEMA_VERSION) {
      return true;
    }
  } catch (e) {}
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var nm = sh.getName();
    if (nm !== TEMPLATE_SHEET_NAME && !isMonthSheetName_(nm)) continue;
    cfEnsureSheetFeatureColumns_(sh);
  }
  try { PropertiesService.getScriptProperties().setProperty(CF_SCHEMA_VERSION_KEY, CF_SCHEMA_VERSION); } catch (e2) {}
  return true;
}

function cfFeatureSheetData_(sh) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [], col: {} };
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h || '').trim(); });
  var col = {};
  headers.forEach(function (h, i) { if (h) col[normHeader_(h)] = i; });
  return { headers: headers, rows: values.slice(1), col: col };
}

function cfValue_(row, col, name) {
  var i = col[normHeader_(name)];
  return i === undefined ? '' : row[i];
}

function cfMonthKeyFromDate_(dateVal) {
  var tz = Session.getScriptTimeZone();
  if (Object.prototype.toString.call(dateVal) === '[object Date]' && !isNaN(dateVal.getTime())) {
    return Utilities.formatDate(dateVal, tz, 'yyyy-MM');
  }
  var s = String(dateVal || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return m[1] + '-' + m[2];
  return '';
}

function cfMonthSheetName_(monthKey) {
  if (!monthKey) return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');
  if (isMonthSheetName_(monthKey)) return monthKey;
  var m = String(monthKey).match(/^(\d{4})-(\d{2})$/);
  if (!m) return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');
  var names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

function cfPrevMonthKey_(monthKey) {
  var m = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  var y = Number(m[1]), mo = Number(m[2]) - 1;
  if (mo < 1) { mo = 12; y -= 1; }
  return y + '-' + (mo < 10 ? '0' + mo : String(mo));
}

function cfMonthRows_(ss, monthKey) {
  var name = cfMonthSheetName_(monthKey);
  var sh = ss.getSheetByName(name);
  if (!sh) return { name: name, exists: false, rows: [], col: {}, headers: [] };
  var d = cfFeatureSheetData_(sh);
  d.name = name;
  d.exists = true;
  return d;
}

function cfBaseAmount_(row, col, amount) {
  var base = Number(cfValue_(row, col, 'Base Amount'));
  if (isFinite(base) && base !== 0) return base;
  var fx = Number(cfValue_(row, col, 'FX Rate'));
  if (!isFinite(fx) || fx <= 0) fx = 1;
  return Number(amount || 0) * fx;
}

function cfDateString_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v);
  var m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function cfHistoryRowObject_(sheetName, row, col) {
  var amount = Number(cfValue_(row, col, 'Amount')) || 0;
  return {
    sheet: sheetName,
    date: cfDateString_(cfValue_(row, col, 'Date')),
    merchant: String(cfValue_(row, col, 'Merchant') || ''),
    description: String(cfValue_(row, col, 'Description') || ''),
    amount: amount,
    baseAmount: cfBaseAmount_(row, col, amount),
    category: String(cfValue_(row, col, 'Category') || ''),
    spendingType: String(cfValue_(row, col, 'Spending Type') || ''),
    type: String(cfValue_(row, col, 'Type') || ''),
    notes: String(cfValue_(row, col, 'Notes') || ''),
    transactionId: String(cfValue_(row, col, 'Transaction ID') || ''),
    entryId: String(cfValue_(row, col, 'Entry ID') || ''),
    currency: String(cfValue_(row, col, 'Currency') || 'IDR'),
    fxRate: Number(cfValue_(row, col, 'FX Rate')) || 1,
    tags: String(cfValue_(row, col, 'Tags') || ''),
    member: String(cfValue_(row, col, 'Member') || ''),
    reimbursable: String(cfValue_(row, col, 'Reimbursable') || ''),
    reimbursed: String(cfValue_(row, col, 'Reimbursed') || ''),
    receiptUrl: String(cfValue_(row, col, 'Receipt URL') || ''),
    splitGroup: String(cfValue_(row, col, 'Split Group') || '')
  };
}

function cfTimedScan_(fn) {
  var started = Date.now();
  var info = { ms: 0, sheets: 0, rows: 0, capped: false };
  var result = fn(info);
  info.ms = Date.now() - started;
  return { result: result, scan: info };
}

function cfDashboard_(sessionToken, monthKey) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  monthKey = monthKey || Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM');
  var cache = null, cacheKey = '';
  try {
    var dashVer = PropertiesService.getScriptProperties().getProperty(HISTORY_CACHE_VERSION_KEY) || '0';
    cache = CacheService.getScriptCache();
    cacheKey = 'cfdash_' + dashVer + '_' + monthKey;
    var dashHit = cache.get(cacheKey);
    if (dashHit) return JSON.parse(dashHit);
  } catch (eCache) { cache = null; cacheKey = ''; }
  var scan = { ms: 0, sheets: 0, rows: 0, capped: false };
  var started = Date.now();
  var cur = cfMonthRows_(ss, monthKey);
  var prevKey = cfPrevMonthKey_(monthKey);
  var prev = prevKey ? cfMonthRows_(ss, prevKey) : { rows: [], col: {} };

  function aggregate(month) {
    var totals = { expense: 0, income: 0, net: 0, count: 0 };
    var categories = {}, days = {}, members = {}, tags = {};
    var reimb = { outstanding: 0, count: 0 };
    var daysInMonth = 31;
    var rows = month.rows || [];
    for (var i = 0; i < rows.length && scan.rows < CF_SCAN_MAX_ROWS; i++) {
      var row = rows[i];
      if (!row || !String(cfValue_(row, month.col, 'Entry ID') || '').trim()) continue;
      var amount = Number(cfValue_(row, month.col, 'Amount')) || 0;
      var base = cfBaseAmount_(row, month.col, amount);
      var type = String(cfValue_(row, month.col, 'Type') || '').toLowerCase();
      var category = String(cfValue_(row, month.col, 'Category') || 'Others');
      var dateStr = cfDateString_(cfValue_(row, month.col, 'Date'));
      var day = Number(dateStr.slice(8, 10)) || 0;
      totals.count++;
      scan.rows++;
      if (type === 'income') totals.income += base;
      else totals.expense += Math.abs(base);
      if (type !== 'income') {
        categories[category] = (categories[category] || 0) + Math.abs(base);
        if (day >= 1 && day <= 31) days[day] = (days[day] || 0) + Math.abs(base);
      }
      var member = String(cfValue_(row, month.col, 'Member') || '');
      if (member) members[member] = (members[member] || 0) + Math.abs(base);
      var tag = String(cfValue_(row, month.col, 'Tags') || '');
      if (tag) tag.split(',').forEach(function (t) { t = t.trim(); if (t) tags[t] = (tags[t] || 0) + 1; });
      if (String(cfValue_(row, month.col, 'Reimbursable') || '').toLowerCase() === 'yes' &&
          String(cfValue_(row, month.col, 'Reimbursed') || '').toLowerCase() !== 'yes') {
        reimb.outstanding += Math.abs(base); reimb.count++;
      }
    }
    totals.net = totals.income - totals.expense;
    var catList = Object.keys(categories).map(function (k) { return { category: k, total: categories[k] }; })
      .sort(function (a, b) { return b.total - a.total; });
    return { totals: totals, categories: catList, days: days, members: members, tags: tags, reimbursements: reimb };
  }

  var current = aggregate(cur);
  scan.sheets++;
  var previous = prevKey ? aggregate(prev) : { categories: [] };
  if (prevKey) scan.sheets++;
  var prevMap = {};
  (previous.categories || []).forEach(function (c) { prevMap[c.category] = c.total; });
  var anomalies = [];
  current.categories.forEach(function (c) {
    var p = prevMap[c.category] || 0;
    if (p > 0 && c.total > p * 1.35 && c.total - p > 50000) {
      anomalies.push({ category: c.category, current: c.total, previous: p,
        percent: Math.round((c.total / p - 1) * 100) });
    }
  });

  var budgets = [];
  try {
    var b = cfFeatureSheetData_(ss.getSheetByName(CF_BUDGET_SHEET));
    var byCat = {};
    current.categories.forEach(function (c) { byCat[c.category] = c.total; });
    b.rows.forEach(function (r) {
      var cat = String(cfValue_(r, b.col, 'Category') || '').trim();
      var limit = Number(cfValue_(r, b.col, 'Monthly Limit')) || 0;
      if (!cat || !limit) return;
      var spent = byCat[cat] || 0;
      budgets.push({ category: cat, limit: limit, spent: spent,
        percent: limit > 0 ? Math.round((spent / limit) * 100) : 0,
        alert: limit > 0 && spent >= limit * 0.8 });
    });
  } catch (eB) {}

  var due = [];
  try {
    var rec = cfFeatureSheetData_(ss.getSheetByName(CF_RECURRING_SHEET));
    var today = new Date();
    var dayNow = Number(Utilities.formatDate(today, ss.getSpreadsheetTimeZone(), 'd'));
    var monthNow = Utilities.formatDate(today, ss.getSpreadsheetTimeZone(), 'yyyy-MM');
    rec.rows.forEach(function (r) {
      if (String(cfValue_(r, rec.col, 'Active') || 'Yes').toLowerCase() === 'no') return;
      var day = Number(cfValue_(r, rec.col, 'Day')) || 1;
      var last = String(cfValue_(r, rec.col, 'Last Run') || '').slice(0, 7);
      if (day <= dayNow && last !== monthNow) {
        due.push({ ruleId: String(cfValue_(r, rec.col, 'Rule ID') || ''),
          description: String(cfValue_(r, rec.col, 'Description') || ''),
          amount: Number(cfValue_(r, rec.col, 'Amount')) || 0,
          type: String(cfValue_(r, rec.col, 'Type') || 'Expense'),
          category: String(cfValue_(r, rec.col, 'Category') || 'Others'),
          day: day });
      }
    });
  } catch (eR) {}

  var household = cfHouseholdList_(sessionToken, true);
  scan.ms = Date.now() - started;
  var out = {
    month: monthKey, monthLabel: cfMonthSheetName_(monthKey),
    sheet: cur.name, exists: cur.exists,
    totals: current.totals, categories: current.categories, days: current.days,
    members: current.members, tags: current.tags,
    anomalies: anomalies, budgets: budgets, dueRecurring: due,
    reimbursements: current.reimbursements,
    household: household, settings: cfFeatureSettings_(),
    scan: scan
  };
  try { if (cache && cacheKey) cache.put(cacheKey, JSON.stringify(out), 60); } catch (ePut) {}
  return out;
}

function cfSearchLogs_(sessionToken, filters) {
  requireSession_(sessionToken);
  filters = filters || {};
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var started = Date.now();
  var scan = { sheets: 0, rows: 0, ms: 0, capped: false };
  var sheets = ss.getSheets().filter(function (sh) { return isMonthSheetName_(sh.getName()); });
  sheets.sort(function (a, b) {
    var pa = parseMonthSheet_(a.getName()), pb = parseMonthSheet_(b.getName());
    if (!pa || !pb) return 0;
    return (pb.year - pa.year) || (pb.month - pa.month);
  });
  if (filters.month) {
    var only = cfMonthSheetName_(filters.month);
    sheets = sheets.filter(function (sh) { return sh.getName() === only; });
  }
  var q = String(filters.q || '').trim().toLowerCase();
  var out = [];
  for (var s = 0; s < sheets.length && s < CF_SCAN_MAX_SHEETS; s++) {
    if (scan.rows >= CF_SCAN_MAX_ROWS) { scan.capped = true; break; }
    var data = cfFeatureSheetData_(sheets[s]);
    scan.sheets++;
    for (var i = 0; i < data.rows.length && scan.rows < CF_SCAN_MAX_ROWS; i++) {
      var row = data.rows[i];
      if (!String(cfValue_(row, data.col, 'Entry ID') || '').trim()) continue;
      scan.rows++;
      var rec = cfHistoryRowObject_(sheets[s].getName(), row, data.col);
      if (filters.entryId && rec.entryId !== String(filters.entryId)) continue;
      if (filters.type && filters.type !== 'All' && rec.type.toLowerCase() !== String(filters.type).toLowerCase()) continue;
      if (filters.category && filters.category !== 'All' && rec.category !== filters.category) continue;
      if (filters.member && filters.member !== 'All' && rec.member !== filters.member) continue;
      if (filters.tag && rec.tags.toLowerCase().indexOf(String(filters.tag).toLowerCase()) === -1) continue;
      if (filters.reimbursable === 'yes' && rec.reimbursable.toLowerCase() !== 'yes') continue;
      if (filters.reimbursable === 'outstanding' &&
          !(rec.reimbursable.toLowerCase() === 'yes' && rec.reimbursed.toLowerCase() !== 'yes')) continue;
      if (filters.from && rec.date < String(filters.from)) continue;
      if (filters.to && rec.date > String(filters.to)) continue;
      if (filters.min !== undefined && filters.min !== '' && Math.abs(rec.baseAmount) < Number(filters.min)) continue;
      if (filters.max !== undefined && filters.max !== '' && Math.abs(rec.baseAmount) > Number(filters.max)) continue;
      if (q) {
        var hay = [rec.merchant, rec.description, rec.notes, rec.category, rec.tags, rec.member, rec.transactionId].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      out.push(rec);
    }
    if (scan.sheets >= CF_SCAN_MAX_SHEETS) { scan.capped = true; break; }
  }
  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? 1 : -1;
    return a.entryId < b.entryId ? 1 : -1;
  });
  var total = out.length;
  var limit = Math.max(1, Math.min(CF_HISTORY_MAX_ROWS, Number(filters.limit) || 100));
  scan.ms = Date.now() - started;
  return { total: total, logs: out.slice(0, limit), hasMore: total > limit, scan: scan };
}

function cfUpdateEntry_(sessionToken, entryId, patch) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var found = findEntryRow_(ss, entryId);
  if (!found) throw new Error('Entry not found - it may have been deleted.');
  var sh = found.sheet;
  var headers = found.headers;
  var allowed = {
    'Description': 'description', 'Amount': 'amount', 'Category': 'category',
    'Spending Type': 'spendingType', 'Type': 'type', 'Merchant': 'merchant',
    'Notes': 'notes', 'Currency': 'currency', 'FX Rate': 'fxRate', 'Tags': 'tags',
    'Member': 'member', 'Reimbursable': 'reimbursable', 'Reimbursed': 'reimbursed'
  };
  patch = patch || {};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { throw new Error('Another sheet operation is running - try again.'); }
  try {
    for (var h in allowed) {
      if (!Object.prototype.hasOwnProperty.call(allowed, h)) continue;
      var key = allowed[h];
      if (patch[key] === undefined) continue;
      var c = colByName_(headers, h);
      if (!c) continue;
      var val = patch[key];
      if (h === 'Amount' || h === 'FX Rate') val = Number(val) || 0;
      sh.getRange(found.rowNum, c).setValue(val);
    }
    var notesCol = colByName_(headers, 'Notes');
    if (notesCol) {
      var curNotes = String(sh.getRange(found.rowNum, notesCol).getValue() || '');
      var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
      sh.getRange(found.rowNum, notesCol).setValue((curNotes ? curNotes + ' | ' : '') + 'Edited ' + stamp);
    }
    bumpHistoryCacheVersion_();
    return { ok: true, entryId: entryId };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function cfBudgetList_(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var d = cfFeatureSheetData_(ss.getSheetByName(CF_BUDGET_SHEET));
  return d.rows.map(function (r) {
    return { category: String(cfValue_(r, d.col, 'Category') || ''),
      limit: Number(cfValue_(r, d.col, 'Monthly Limit')) || 0,
      updatedAt: String(cfValue_(r, d.col, 'Updated At') || '') };
  }).filter(function (b) { return b.category; });
}

function cfBudgetSave_(sessionToken, budget) {
  requireSession_(sessionToken);
  budget = budget || {};
  var category = String(budget.category || '').trim();
  var limit = Number(budget.limit) || 0;
  if (!category || limit <= 0) throw new Error('Choose a category and a positive monthly limit.');
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_BUDGET_SHEET);
  var d = cfFeatureSheetData_(sh);
  var rowNum = -1;
  for (var i = 0; i < d.rows.length; i++) {
    if (String(cfValue_(d.rows[i], d.col, 'Category') || '') === category) { rowNum = i + 2; break; }
  }
  var now = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  if (rowNum < 0) {
    sh.appendRow([category, limit, now]);
  } else {
    sh.getRange(rowNum, d.col['category'] + 1, 1, 3).setValues([[category, limit, now]]);
  }
  bumpHistoryCacheVersion_();
  return { ok: true, budgets: cfBudgetList_(sessionToken) };
}

function cfBudgetDelete_(sessionToken, category) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_BUDGET_SHEET);
  var d = cfFeatureSheetData_(sh);
  for (var i = d.rows.length - 1; i >= 0; i--) {
    if (String(cfValue_(d.rows[i], d.col, 'Category') || '') === String(category || '')) sh.deleteRow(i + 2);
  }
  bumpHistoryCacheVersion_();
  return { ok: true, budgets: cfBudgetList_(sessionToken) };
}

function cfRecurringList_(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var d = cfFeatureSheetData_(ss.getSheetByName(CF_RECURRING_SHEET));
  return d.rows.map(function (r) {
    return { ruleId: String(cfValue_(r, d.col, 'Rule ID') || ''),
      description: String(cfValue_(r, d.col, 'Description') || ''),
      amount: Number(cfValue_(r, d.col, 'Amount')) || 0,
      category: String(cfValue_(r, d.col, 'Category') || 'Others'),
      spendingType: String(cfValue_(r, d.col, 'Spending Type') || 'Need'),
      type: String(cfValue_(r, d.col, 'Type') || 'Expense'),
      member: String(cfValue_(r, d.col, 'Member') || ''),
      tags: String(cfValue_(r, d.col, 'Tags') || ''),
      day: Number(cfValue_(r, d.col, 'Day')) || 1,
      active: String(cfValue_(r, d.col, 'Active') || 'Yes') !== 'No',
      lastRun: String(cfValue_(r, d.col, 'Last Run') || '') };
  }).filter(function (r) { return r.ruleId; });
}

function cfRecurringSave_(sessionToken, rule) {
  requireSession_(sessionToken);
  rule = rule || {};
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_RECURRING_SHEET);
  var d = cfFeatureSheetData_(sh);
  var id = String(rule.ruleId || '').trim() || ('R-' + Utilities.getUuid().slice(0, 8));
  var now = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  var row = [id, String(rule.description || 'Recurring entry'), Number(rule.amount) || 0,
    String(rule.category || 'Others'), String(rule.spendingType || 'Need'),
    String(rule.type || 'Expense'), String(rule.member || ''), String(rule.tags || ''),
    Math.max(1, Math.min(28, Number(rule.day) || 1)),
    rule.active === false ? 'No' : 'Yes', String(rule.lastRun || ''), now];
  var rowNum = -1;
  for (var i = 0; i < d.rows.length; i++) {
    if (String(cfValue_(d.rows[i], d.col, 'Rule ID') || '') === id) { rowNum = i + 2; break; }
  }
  if (rowNum < 0) sh.appendRow(row);
  else sh.getRange(rowNum, 1, 1, row.length).setValues([row]);
  bumpHistoryCacheVersion_();
  return { ok: true, rules: cfRecurringList_(sessionToken) };
}

function cfRecurringDelete_(sessionToken, ruleId) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_RECURRING_SHEET);
  var d = cfFeatureSheetData_(sh);
  for (var i = d.rows.length - 1; i >= 0; i--) {
    if (String(cfValue_(d.rows[i], d.col, 'Rule ID') || '') === String(ruleId || '')) sh.deleteRow(i + 2);
  }
  bumpHistoryCacheVersion_();
  return { ok: true, rules: cfRecurringList_(sessionToken) };
}

function cfRecurringLog_(sessionToken, ruleId) {
  requireSession_(sessionToken);
  var rules = cfRecurringList_(sessionToken);
  var rule = null;
  for (var i = 0; i < rules.length; i++) if (rules[i].ruleId === ruleId) rule = rules[i];
  if (!rule) throw new Error('Recurring rule not found.');
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var txn = sanitizeTransaction({
    transaction_type: rule.type,
    transaction_date: today,
    merchant: rule.description,
    items: [{ description: rule.description, amount: Math.abs(rule.amount),
      category: rule.category, spending_type: rule.spendingType }]
  });
  var report = commitReceiptRows({ submission_id: 'recurring-' + Utilities.getUuid(), forceLog: false },
    [{ row_id: Utilities.getUuid(), origNum: 1, forcedType: rule.type, note: rule.tags,
       hasPhoto: false, phase1: null, txn: txn, repaired: false, tags: rule.tags,
       member: rule.member, currency: 'IDR', fxRate: 1 }], sessionToken);
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CF_RECURRING_SHEET);
  var d = cfFeatureSheetData_(sh);
  var now = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  for (var j = 0; j < d.rows.length; j++) {
    if (String(cfValue_(d.rows[j], d.col, 'Rule ID') || '') === ruleId) {
      var c = d.col['last run'];
      if (c !== undefined) sh.getRange(j + 2, c + 1).setValue(now);
    }
  }
  return { ok: true, report: report, rules: cfRecurringList_(sessionToken) };
}

function cfHouseholdList_(sessionToken, skipAuth) {
  if (!skipAuth) requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var d = cfFeatureSheetData_(ss.getSheetByName(CF_HOUSEHOLD_SHEET));
  return d.rows.map(function (r) {
    return { memberId: String(cfValue_(r, d.col, 'Member ID') || ''),
      name: String(cfValue_(r, d.col, 'Name') || ''),
      active: String(cfValue_(r, d.col, 'Active') || 'Yes') !== 'No',
      createdAt: String(cfValue_(r, d.col, 'Created At') || '') };
  }).filter(function (m) { return m.memberId && m.name; });
}

function cfHouseholdSave_(sessionToken, member) {
  requireSession_(sessionToken);
  member = member || {};
  var name = String(member.name || '').trim();
  if (!name) throw new Error('Enter a member name.');
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_HOUSEHOLD_SHEET);
  var d = cfFeatureSheetData_(sh);
  var id = String(member.memberId || '').trim() || ('M-' + Utilities.getUuid().slice(0, 8));
  var now = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  var row = [id, name, member.active === false ? 'No' : 'Yes', now];
  var rowNum = -1;
  for (var i = 0; i < d.rows.length; i++) {
    if (String(cfValue_(d.rows[i], d.col, 'Member ID') || '') === id) { rowNum = i + 2; break; }
  }
  if (rowNum < 0) sh.appendRow(row);
  else sh.getRange(rowNum, 1, 1, row.length).setValues([row]);
  bumpHistoryCacheVersion_();
  return { ok: true, members: cfHouseholdList_(sessionToken) };
}

function cfHouseholdDelete_(sessionToken, memberId) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var sh = ss.getSheetByName(CF_HOUSEHOLD_SHEET);
  var d = cfFeatureSheetData_(sh);
  for (var i = d.rows.length - 1; i >= 0; i--) {
    if (String(cfValue_(d.rows[i], d.col, 'Member ID') || '') === String(memberId || '')) sh.deleteRow(i + 2);
  }
  bumpHistoryCacheVersion_();
  return { ok: true, members: cfHouseholdList_(sessionToken) };
}

function cfSetReimbursement_(sessionToken, entryIds, patch) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  patch = patch || {};
  entryIds = entryIds || [];
  var changed = 0;
  for (var i = 0; i < entryIds.length; i++) {
    var found = findEntryRow_(ss, entryIds[i]);
    if (!found) continue;
    if (patch.reimbursable !== undefined) {
      var c1 = colByName_(found.headers, 'Reimbursable');
      if (c1) found.sheet.getRange(found.rowNum, c1).setValue(patch.reimbursable ? 'Yes' : 'No');
    }
    if (patch.reimbursed !== undefined) {
      var c2 = colByName_(found.headers, 'Reimbursed');
      if (c2) found.sheet.getRange(found.rowNum, c2).setValue(patch.reimbursed ? 'Yes' : 'No');
    }
    changed++;
  }
  bumpHistoryCacheVersion_();
  return { ok: true, changed: changed };
}

function cfHashSheet_(ss) {
  cfEnsureFeatureSchema_(ss);
  return ss.getSheetByName(CF_HASH_SHEET);
}

function cfApplySplits_(txn, splits) {
  if (!txn || !Array.isArray(splits) || splits.length < 2) return txn;
  var total = 0;
  (txn.items || []).forEach(function (i) { total += Number(i.amount) || 0; });
  var sum = 0;
  var clean = [];
  splits.forEach(function (s) {
    var amount = Number(s && s.amount) || 0;
    var category = String((s && s.category) || '').trim();
    if (!amount || !category) return;
    sum += amount;
    clean.push({ category: category, amount: amount });
  });
  if (clean.length < 2 || Math.abs(total - sum) > 1) return txn;
  var st = dominantSpendingType_(txn);
  txn.items = clean.map(function (s) {
    return { description: txn.merchant + ' · ' + s.category, amount: s.amount,
      category: s.category, spending_type: st };
  });
  txn.splitGroup = txn.splitGroup || ('S-' + Utilities.getUuid().slice(0, 8));
  return txn;
}

function cfApplyTxnMeta_(txn, it) {
  if (!txn || !it) return txn;
  var keys = [['currency','currency'],['fxRate','fxRate'],['tags','tags'],['member','member'],
    ['reimbursable','reimbursable'],['reimbursed','reimbursed'],['receiptHash','receiptHash'],
    ['receiptUrl','receiptUrl'],['splitGroup','splitGroup'],['baseAmount','baseAmount']];
  keys.forEach(function (k) {
    if (it[k[0]] !== undefined && it[k[0]] !== '') txn[k[1]] = it[k[0]];
  });
  return txn;
}

function cfDuplicateFingerprint_(txn, imageHash) {
  if (!txn) return '';
  var total = 0;
  (txn.items || []).forEach(function (i) { total += Number(i.amount) || 0; });
  var seed = [
    String(imageHash || ''),
    String(txn.merchant || '').trim().toLowerCase(),
    String(txn.transaction_date || ''),
    String(Math.round(total))
  ].join('|');
  try {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
    return bytes.map(function (b) {
      var v = (b + 256) % 256;
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  } catch (e) {
    // Deterministic fallback for environments without computeDigest.
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    return 'f' + (h >>> 0).toString(16);
  }
}

function cfHashSet_(ss) {
  var sh = cfHashSheet_(ss);
  var d = cfFeatureSheetData_(sh);
  var set = {};
  d.rows.forEach(function (r) {
    var h = String(cfValue_(r, d.col, 'Receipt Hash') || '');
    if (h) set[h] = { transactionId: String(cfValue_(r, d.col, 'Transaction ID') || ''),
      entryId: String(cfValue_(r, d.col, 'Entry ID') || '') };
  });
  return set;
}

function cfCheckDuplicates_(sessionToken, hashes) {
  requireSession_(sessionToken);
  hashes = hashes || [];
  var set = cfHashSet_(getSpreadsheet_());
  var found = [];
  hashes.forEach(function (h) { if (h && set[h]) found.push({ hash: h, transactionId: set[h].transactionId }); });
  return { duplicates: found };
}

function cfRecordHashes_(ss, txnId, entries, hash) {
  if (!hash) return;
  var sh = cfHashSheet_(ss);
  var now = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  entries.forEach(function (e) {
    sh.appendRow([hash, txnId, e.entryId || '', now]);
  });
}

function cfReceiptFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(CF_DRIVE_FOLDER_KEY);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  // drive.file can create and then access app-created folders. Avoid
  // getFoldersByName(), which requires the broader Drive scope.
  var folder = DriveApp.createFolder('Cashflow Receipts');
  try { props.setProperty(CF_DRIVE_FOLDER_KEY, folder.getId()); } catch (e2) {}
  return folder;
}

function cfRetainReceiptImage_(sessionToken, data, mimeType, name) {
  requireSession_(sessionToken);
  if (!data) throw new Error('No image data supplied.');
  if (!/^image\//.test(String(mimeType || ''))) throw new Error('Only image files can be retained.');
  var folder = cfReceiptFolder_();
  var bytes = Utilities.base64Decode(data);
  var safe = String(name || ('receipt-' + Date.now())).replace(/[^\w.\-]+/g, '-').slice(0, 80);
  var blob = Utilities.newBlob(bytes, mimeType, safe);
  var file = folder.createFile(blob);
  return { ok: true, url: file.getUrl(), id: file.getId(), name: file.getName() };
}

function cfExportBackup_(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var payload = { version: 1, exportedAt: new Date().toISOString(), spreadsheet: ss.getName(), sheets: {} };
  var sheets = ss.getSheets();
  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (name !== TEMPLATE_SHEET_NAME && !isMonthSheetName_(name) && name.indexOf('_CF_') !== 0) return;
    var d = cfFeatureSheetData_(sh);
    payload.sheets[name] = { headers: d.headers, rows: d.rows };
  });
  return payload;
}

function cfImportBackup_(sessionToken, backup) {
  requireSession_(sessionToken);
  backup = backup || {};
  if (!backup.sheets || typeof backup.sheets !== 'object') throw new Error('Backup file has no sheets payload.');
  var ss = getSpreadsheet_();
  cfEnsureFeatureSchema_(ss);
  var existing = {};
  ss.getSheets().forEach(function (sh) {
    if (!isMonthSheetName_(sh.getName())) return;
    var d = cfFeatureSheetData_(sh);
    d.rows.forEach(function (r) {
      var id = String(cfValue_(r, d.col, 'Entry ID') || '');
      if (id) existing[id] = true;
    });
  });
  var added = 0, skipped = 0;
  Object.keys(backup.sheets).forEach(function (name) {
    if (name !== TEMPLATE_SHEET_NAME && !isMonthSheetName_(name) && name.indexOf('_CF_') !== 0) return;
    var src = backup.sheets[name] || {};
    var headers = src.headers || [];
    var rows = src.rows || [];
    if (!headers.length || !rows.length) return;
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var d = cfFeatureSheetData_(sh);
    if (!d.headers.length) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    var target = cfFeatureSheetData_(sh);
    var keyHeaders;
    if (name === CF_BUDGET_SHEET) keyHeaders = ['category'];
    else if (name === CF_RECURRING_SHEET) keyHeaders = ['rule id'];
    else if (name === CF_HOUSEHOLD_SHEET) keyHeaders = ['member id'];
    else if (name === CF_HASH_SHEET) keyHeaders = ['receipt hash'];
    else if (name === LEDGER_SHEET_NAME) keyHeaders = ['submission id', 'row id'];
    else if (name === TRASH_SHEET_NAME) keyHeaders = ['trash id'];
    else keyHeaders = ['entry id'];
    function keyOfMap(get) {
      return keyHeaders.map(function (h) { return String(get(h) || ''); }).join('|');
    }
    var existingKeys = {};
    target.rows.forEach(function (r) {
      var k = keyOfMap(function (h) { return cfValue_(r, target.col, h); });
      if (k.replace(/\|/g, '')) existingKeys[k] = true;
    });
    var writes = [];
    rows.forEach(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[normHeader_(h)] = row[i]; });
      var key = keyOfMap(function (h) { return obj[normHeader_(h)]; });
      if (key.replace(/\|/g, '') && existingKeys[key]) { skipped++; return; }
      var out = target.headers.map(function (h) { return obj[normHeader_(h)] !== undefined ? obj[normHeader_(h)] : ''; });
      writes.push(out);
      if (key.replace(/\|/g, '')) existingKeys[key] = true;
      added++;
    });
    if (writes.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, writes.length, target.headers.length).setValues(writes);
    }
  });
  bumpHistoryCacheVersion_();
  return { ok: true, added: added, skipped: skipped };
}

function cfMonthlyReport_(sessionToken, monthKey) {
  requireSession_(sessionToken);
  var data = cfDashboard_(sessionToken, monthKey);
  var rows = cfSearchLogs_(sessionToken, { month: monthKey, limit: 500 }).logs;
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Georgia,serif;color:#171614;padding:32px;background:#fff}' +
    'h1{font-weight:400;margin:0 0 4px}p{color:#6f6a61;margin:0 0 22px}' +
    '.stats{display:flex;gap:12px;margin-bottom:20px}.stat{border:1px solid #e6e2da;border-radius:8px;padding:12px 16px;flex:1}' +
    '.stat b{display:block;font-size:22px;font-weight:400}.stat span{font-size:10px;color:#6f6a61;text-transform:uppercase}' +
    'table{width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px}' +
    'th{text-align:left;border-bottom:1px solid #cfc9be;padding:6px;color:#6f6a61;text-transform:uppercase;font-size:9px}' +
    'td{border-bottom:1px solid #eee;padding:6px}td.n{text-align:right;white-space:nowrap}' +
    '</style></head><body>' +
    '<h1>Cashflow report — ' + data.monthLabel + '</h1><p>Generated ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + '</p>' +
    '<div class="stats">' +
    '<div class="stat"><b>' + idr_(data.totals.expense) + '</b><span>Expense</span></div>' +
    '<div class="stat"><b>' + idr_(data.totals.income) + '</b><span>Income</span></div>' +
    '<div class="stat"><b>' + idr_(data.totals.net) + '</b><span>Net</span></div></div>' +
    '<table><thead><tr><th>Date</th><th>Merchant</th><th>Description</th><th>Category</th><th>Member</th><th class="n">Amount</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr><td>' + r.date + '</td><td>' + cfEscape_(r.merchant) + '</td><td>' +
        cfEscape_(r.description) + '</td><td>' + cfEscape_(r.category) + '</td><td>' +
        cfEscape_(r.member) + '</td><td class="n">' + idr_(r.baseAmount) + '</td></tr>';
    }).join('') + '</tbody></table></body></html>';
  var pdf = HtmlService.createHtmlOutput(html).getAs('application/pdf');
  var name = 'Cashflow report ' + data.monthLabel + '.pdf';
  var folder = cfReceiptFolder_();
  var file = folder.createFile(pdf.setName(name));
  return { ok: true, url: file.getUrl(), name: name };
}

function cfEscape_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function cfSessionsList_(sessionToken) {
  requireSession_(sessionToken);
  var map = loadSessions_();
  var meta = loadSessionMeta_();
  var current = sha256Hex_(String(sessionToken || ''));
  var out = [];
  Object.keys(map).forEach(function (h) {
    if (typeof map[h] !== 'number') return;
    var m = meta[h] || {};
    out.push({
      hash: h,
      label: String(m.label || 'Browser session'),
      createdAt: Number(m.createdAt) || 0,
      lastSeen: Number(m.lastSeen) || 0,
      expiresAt: map[h],
      current: h === current
    });
  });
  out.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
  return out;
}

function cfSessionRevoke_(sessionToken, hash) {
  requireSession_(sessionToken);
  var target = String(hash || '');
  if (!target) throw new Error('Choose a session to revoke.');
  if (target === sha256Hex_(String(sessionToken || ''))) {
    throw new Error('This is your current session. Use Log out to end it.');
  }
  var map = loadSessions_();
  if (map[target] === undefined) return { ok: true, alreadyGone: true, sessions: cfSessionsList_(sessionToken) };
  delete map[target];
  saveSessions_(map);
  var meta = loadSessionMeta_();
  delete meta[target];
  saveSessionMeta_(meta);
  return { ok: true, sessions: cfSessionsList_(sessionToken) };
}

function cfSessionLabel_(sessionToken, label) {
  requireSession_(sessionToken);
  var h = sha256Hex_(String(sessionToken || ''));
  touchSessionMeta_(h, { lastSeen: Date.now(), label: String(label || 'Browser session').slice(0, 80) });
  return { ok: true, sessions: cfSessionsList_(sessionToken) };
}

function cfQuickText_(sessionToken, payload) {
  requireSession_(sessionToken);
  payload = payload || {};
  var note = String(payload.note || '').trim();
  if (!note) throw new Error('Type a note first.');
  var txn = sanitizeTransaction(callGemini_(buildPrompt(note, 0), note, [], TRANSACTION_SCHEMA));
  var meta = payload.meta || {};
  var report = commitReceiptRows({ submission_id: 'qt-' + Utilities.getUuid(), forceLog: true, quickMode: true },
    [{ row_id: Utilities.getUuid(), origNum: 1, forcedType: null, note: '',
       hasPhoto: false, phase1: null, txn: txn, repaired: false,
       currency: meta.currency || 'IDR', fxRate: meta.fxRate || 1,
       tags: meta.tags || '', member: meta.member || '',
       reimbursable: meta.reimbursable ? 'Yes' : 'No' }], sessionToken);
  return { ok: true, report: report };
}

function cfApi(sessionToken, action, payload) {
  requireSession_(sessionToken);
  payload = payload || {};
  var act = String(action || '');
  try {
    switch (act) {
      case 'settings.get': return { ok: true, settings: cfFeatureSettings_(), household: cfHouseholdList_(sessionToken, true) };
      case 'settings.save': return { ok: true, settings: cfSaveFeatureSettings_(payload.settings || {}) };
      case 'dashboard': return { ok: true, data: cfDashboard_(sessionToken, payload.month) };
      case 'search': return { ok: true, data: cfSearchLogs_(sessionToken, payload.filters) };
      case 'quickText': return cfQuickText_(sessionToken, payload);
      case 'updateEntry': return cfUpdateEntry_(sessionToken, payload.entryId, payload.patch);
      case 'sessions.list': return { ok: true, sessions: cfSessionsList_(sessionToken) };
      case 'sessions.revoke': return cfSessionRevoke_(sessionToken, payload.hash);
      case 'sessions.label': return cfSessionLabel_(sessionToken, payload.label);
      case 'budgets.list': return { ok: true, budgets: cfBudgetList_(sessionToken) };
      case 'budgets.save': return cfBudgetSave_(sessionToken, payload.budget);
      case 'budgets.delete': return cfBudgetDelete_(sessionToken, payload.category);
      case 'recurring.list': return { ok: true, rules: cfRecurringList_(sessionToken) };
      case 'recurring.save': return cfRecurringSave_(sessionToken, payload.rule);
      case 'recurring.delete': return cfRecurringDelete_(sessionToken, payload.ruleId);
      case 'recurring.log': return cfRecurringLog_(sessionToken, payload.ruleId);
      case 'household.list': return { ok: true, members: cfHouseholdList_(sessionToken) };
      case 'household.save': return cfHouseholdSave_(sessionToken, payload.member);
      case 'household.delete': return cfHouseholdDelete_(sessionToken, payload.memberId);
      case 'reimbursement.set': return cfSetReimbursement_(sessionToken, payload.entryIds, payload.patch);
      case 'duplicates.check': return { ok: true, data: cfCheckDuplicates_(sessionToken, payload.hashes || []) };
      case 'image.save': return cfRetainReceiptImage_(sessionToken, payload.data, payload.mimeType, payload.name);
      case 'backup.export': return { ok: true, backup: cfExportBackup_(sessionToken) };
      case 'backup.import': return cfImportBackup_(sessionToken, payload.backup);
      case 'report.month': return cfMonthlyReport_(sessionToken, payload.month);
      default: throw new Error('Unknown action: ' + act);
    }
  } catch (e) {
    var id = cfFeatureCorrelation_();
    console.error('cfApi ' + act + ' [' + id + ']: ' + (e && e.message ? e.message : e));
    var msg = String(e && e.message ? e.message : e);
    throw new Error(msg + ' (ref ' + id + ')');
  }
}
