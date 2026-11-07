// ---------- POST-REPORT SORT (separate call, clean state only) ----------

var MONTH_INDEX = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

function parseMonthSheet_(name) {
  var m = String(name || '').match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/);
  if (!m) return null;
  return { year: Number(m[2]), month: MONTH_INDEX[m[1].toLowerCase()] };
}

// Sorts month tabs chronologically and each month's rows by Transaction ID.
// Whole rows always move together. Legacy rows with blank IDs keep relative
// order at the end (never deleted/merged). Idempotent. Locked.
function sortCashflowSheets(sessionToken) {
  requireSession_(sessionToken);
  var ss = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error('Another sheet operation is running - try again in a few seconds.'); }
  try {
    ensureTransactionIdColumn_(ss);
    ensureEntryIdColumn_(ss);
    var sheets = ss.getSheets();
    var months = [];
    var si;
    for (si = 0; si < sheets.length; si++) {
      var pm = parseMonthSheet_(sheets[si].getName());
      if (pm) months.push({ sheet: sheets[si], year: pm.year, month: pm.month });
    }
    months.sort(function (a, b) {
      return (a.year - b.year) || (a.month - b.month);
    });
    // Keep non-month sheets in place: compact month tabs into their block.
    var positions = months.map(function (m) { return m.sheet.getIndex(); }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < months.length; i++) {
      ss.setActiveSheet(months[i].sheet);
      ss.moveActiveSheet(positions[i]);
    }
    var rowsMoved = 0, sortedSheets = [];
    for (var mI = 0; mI < months.length; mI++) {
      var sh = months[mI].sheet;
      var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
      if (lastRow < 3 || lastCol < 1) continue; // header + <2 rows: nothing to order
      var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
      var idCol = colByName_(headers, TXN_ID_HEADER);
      if (!idCol) continue;
      var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
      var decorated = vals.map(function (row, idx) { return { row: row, idx: idx }; });
      decorated.sort(function (a, b) {
        var ka = String(a.row[idCol - 1] || '').match(/^\d{8}[A-Z]{2,}$/) ? 0 : 1;
        var kb = String(b.row[idCol - 1] || '').match(/^\d{8}[A-Z]{2,}$/) ? 0 : 1;
        if (ka !== kb) return ka - kb;
        if (ka === 0) {
          var c = compareTxnIds_(a.row[idCol - 1], b.row[idCol - 1]);
          if (c !== 0) return c;
        }
        return a.idx - b.idx;
      });
      var changed = false, ci;
      for (ci = 0; ci < decorated.length; ci++) {
        if (decorated[ci].idx !== ci) { changed = true; break; }
      }
      if (!changed) continue;
      sh.getRange(2, 1, vals.length, lastCol).setValues(decorated.map(function (d) { return d.row; }));
      rowsMoved += vals.length;
      sortedSheets.push(sh.getName());
    }
    if (rowsMoved > 0) bumpHistoryCacheVersion_();
    return { sheets: sortedSheets, rowsMoved: rowsMoved };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
