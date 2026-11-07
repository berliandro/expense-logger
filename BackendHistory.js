// ---------- RECENT LOGS (PIN-gated, newest first across all month sheets) ----------

// Session token verified server-side via requireSession_. Returns newest-first page.
// Recent-logs page cache. The sheet scan is the slowest read in the app; a
// short TTL makes the first page feel instant while every write bumps the
// version so a caller can never read a stale page after its own mutation.
var HISTORY_CACHE_VERSION_KEY = 'CF_HISTORY_VERSION';
var HISTORY_CACHE_TTL_SECONDS = 120;
var HISTORY_SCAN_MAX_SHEETS = 36;
var HISTORY_SCAN_MAX_ROWS = 25000;
function bumpHistoryCacheVersion_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var next = (Number(props.getProperty(HISTORY_CACHE_VERSION_KEY)) || 0) + 1;
    props.setProperty(HISTORY_CACHE_VERSION_KEY, String(next));
  } catch (e) {}
}

function getRecentLogs(sessionToken, offset, limit) {
  requireSession_(sessionToken);
  offset = Math.max(0, Number(offset) || 0);
  limit = Number(limit) || 10;
  if (limit < 1) limit = 10;
  if (limit > 20) limit = 20;

  var cache = null, cacheKey = '';
  try {
    var ver = PropertiesService.getScriptProperties().getProperty(HISTORY_CACHE_VERSION_KEY) || '0';
    cache = CacheService.getScriptCache();
    cacheKey = 'cfh_' + ver + '_' + offset + '_' + limit;
    var hit = cache.get(cacheKey);
    if (hit) {
      var parsed = JSON.parse(hit);
      if (parsed && Array.isArray(parsed.logs)) return parsed;
    }
  } catch (eCache) { cache = null; cacheKey = ''; }

  var ss = getSpreadsheet_();
  var tz = ss.getSpreadsheetTimeZone();
  var sheets = ss.getSheets();
  var all = [];
  var scanStarted = Date.now();
  var scanInfo = { ms: 0, sheets: 0, rows: 0, capped: false };

  for (var s = 0; s < sheets.length; s++) {
    if (scanInfo.sheets >= HISTORY_SCAN_MAX_SHEETS) { scanInfo.capped = true; break; }
    var sheet = sheets[s];
    if (sheet.getName() === TEMPLATE_SHEET_NAME) continue;
    if (sheet.getName() === LEDGER_SHEET_NAME || sheet.getName().indexOf('_CF_') === 0) continue;
    if (sheet.getLastRow() < 2) continue;
    var values = sheet.getDataRange().getValues();
    scanInfo.sheets++;
    if (!values || values.length < 2) continue;
    var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    function col(name) { return headers.indexOf(name); }
    var cDate = col('date'), cMerch = col('merchant'), cDesc = col('description'),
        cAmt = col('amount'), cCat = col('category'), cSpend = col('spending type'),
        cType = col('type'), cNotes = col('notes'), cTxnId = col('transaction id'),
        cEntryId = col('entry id'), cBase = col('base amount'), cCur = col('currency'),
        cTags = col('tags'), cMember = col('member'), cReimb = col('reimbursable'),
        cReimbursed = col('reimbursed'), cReceiptUrl = col('receipt url');
    for (var r = 1; r < values.length; r++) {
      if (scanInfo.rows >= HISTORY_SCAN_MAX_ROWS) { scanInfo.capped = true; break; }
      var row = values[r];
      var empty = true;
      for (var c = 0; c < row.length; c++) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { empty = false; break; }
      }
      if (empty) continue;
      scanInfo.rows++;
      var rawDate = cDate >= 0 ? row[cDate] : '';
      var ts = 0, dateStr = '';
      if (Object.prototype.toString.call(rawDate) === '[object Date]' && !isNaN(rawDate.getTime())) {
        ts = rawDate.getTime();
        dateStr = Utilities.formatDate(rawDate, tz, 'yyyy-MM-dd');
      } else {
        var ds = String(rawDate || '').trim();
        dateStr = ds;
        var parsed = new Date(ds);
        ts = isNaN(parsed.getTime()) ? 0 : parsed.getTime();
        if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
          var pd = new Date(ds + 'T00:00:00');
          if (!isNaN(pd.getTime())) ts = pd.getTime();
        }
      }
      var amt = cAmt >= 0 ? Number(row[cAmt]) || 0 : 0;
      all.push({
        sheet: sheet.getName(),
        date: dateStr,
        ts: ts,
        merchant: cMerch >= 0 ? String(row[cMerch] || '') : '',
        description: cDesc >= 0 ? String(row[cDesc] || '') : '',
        amount: amt,
        category: cCat >= 0 ? String(row[cCat] || '') : '',
        spendingType: cSpend >= 0 ? String(row[cSpend] || '') : '',
        type: cType >= 0 ? String(row[cType] || '') : '',
        notes: cNotes >= 0 ? String(row[cNotes] || '') : '',
        transactionId: cTxnId >= 0 ? String(row[cTxnId] || '') : '',
        entryId: cEntryId >= 0 ? String(row[cEntryId] || '') : '',
        baseAmount: cBase >= 0 ? (Number(row[cBase]) || amt) : amt,
        currency: cCur >= 0 ? String(row[cCur] || 'IDR') : 'IDR',
        tags: cTags >= 0 ? String(row[cTags] || '') : '',
        member: cMember >= 0 ? String(row[cMember] || '') : '',
        reimbursable: cReimb >= 0 ? String(row[cReimb] || '') : '',
        reimbursed: cReimbursed >= 0 ? String(row[cReimbursed] || '') : '',
        receiptUrl: cReceiptUrl >= 0 ? String(row[cReceiptUrl] || '') : ''
      });
    }
  }

  all.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var total = all.length;
  var page = all.slice(offset, offset + limit).map(function (e) {
    return {
      sheet: e.sheet, date: e.date, merchant: e.merchant,
      description: e.description, amount: e.amount, category: e.category,
      spendingType: e.spendingType, type: e.type, notes: e.notes,
      transactionId: e.transactionId || '', entryId: e.entryId || '',
      baseAmount: e.baseAmount, currency: e.currency, tags: e.tags, member: e.member,
      reimbursable: e.reimbursable, reimbursed: e.reimbursed, receiptUrl: e.receiptUrl
    };
  });
  var out = { total: total, offset: offset, limit: limit, hasMore: (offset + limit) < total, logs: page };
  scanInfo.ms = Date.now() - scanStarted;
  out.scan = scanInfo;
  try {
    if (cache && cacheKey) cache.put(cacheKey, JSON.stringify(out), HISTORY_CACHE_TTL_SECONDS);
  } catch (ePut) {}
  return out;
}
