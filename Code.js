// ---------- ENTRY POINT (serves the form) ----------

// Template partial loader. Index.html is a thin shell; Styles/Layout/App*
// are composed here so each concern stays editable without a build step.
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Cashflow log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

// Called from the client (Index.html) via google.script.run.
// imageBase64/mimeType are null for a text-only submission.
// Kept for backward compatibility - delegates to processExpenses.
// pin is verified server-side when a PIN is set up (never checked on the client).
function processExpense(imageBase64, mimeType, noteText, sessionToken) {
  if (!imageBase64) {
    return processExpenses([], noteText || '', sessionToken);
  }
  return processExpenses([{ data: imageBase64, mimeType: mimeType }], noteText || '', sessionToken);
}

// Multi-photo entry point: images is an array of {data, mimeType}.
// Image receipts run the same two-phase reconcile/commit pipeline as Table
// rows (Phase 1 totals, Phase 2 lines, one repair, Force-save policy); text-only
// submissions keep the direct path. opts: {forceLog} (off by default).
// Returns the classic summary string; throws when nothing could be logged.
// Kept for backward compatibility - the web UI drives phased ops directly
// for large submissions.
function processExpenses(images, noteText, sessionToken, opts) {
  requireSession_(sessionToken);
  images = images || [];
  noteText = noteText || '';
  var toggles = { forceLog: !!(opts && opts.forceLog) };
  var submissionId = Utilities.getUuid();

  // Text-only: the note IS the source data (no Phase 1, no invented total).
  if (images.length === 0) {
    var promptText = buildPrompt(noteText, 0);
    var txn = sanitizeTransaction(callGemini_(promptText, noteText, [], TRANSACTION_SCHEMA));
    var report = commitReceiptRows({ submission_id: submissionId, forceLog: toggles.forceLog },
      [{ row_id: Utilities.getUuid(), origNum: 1, forcedType: null, note: '',
         hasPhoto: false, phase1: null, txn: txn, repaired: false }], sessionToken);
    return summarizeReport_(report, 'receipt');
  }

  var defs = images.map(function (img, i) {
    return { forcedType: null, note: noteText, data: (img || {}).data || '',
             mimeType: (img || {}).mimeType || 'image/jpeg', hasPhoto: true, origNum: i + 1 };
  });
  var report2 = processRowsPipeline_(defs, toggles, sessionToken, submissionId);
  return summarizeReport_(report2, 'receipt');
}

// Shared single-execution pipeline for the compatibility wrappers.
// defs: [{forcedType|null, note, data, mimeType, hasPhoto, origNum}]
function processRowsPipeline_(defs, toggles, sessionToken, submissionId) {
  var rows = defs.map(function (d, i) {
    return { row_id: Utilities.getUuid(), origNum: d.origNum || (i + 1),
             forcedType: d.forcedType || null, note: String(d.note || ''),
             hasPhoto: !!d.hasPhoto, data: d.data || '', mimeType: d.mimeType || 'image/jpeg' };
  });
  // Phase 1 in bounded photo chunks (photo rows only).
  var phase1ById = {};
  var photoRows = rows.filter(function (r) { return r.hasPhoto && r.data; });
  if (photoRows.length !== rows.filter(function (r) { return r.hasPhoto; }).length) {
    throw new Error('A photo row is missing its image data - resubmit with the images attached.');
  }
  var perChunk = BATCH_LIMITS.maxPhotosPerBatch;
  for (var c = 0; c < photoRows.length; c += perChunk) {
    var chunk = photoRows.slice(c, c + perChunk).map(function (r, k) {
      return { row_id: r.row_id, photo_index: k + 1, data: r.data, mimeType: r.mimeType };
    });
    var p1 = runPhase1Batch(submissionId, chunk, sessionToken);
    for (var q = 0; q < p1.results.length; q++) phase1ById[p1.results[q].row_id] = p1.results[q];
  }
  // Phase 2 in the same chunks (stable mapping via row_id).
  var okAll = [], failedAll = [];
  var allPhoto = photoRows.length > 0;
  var p2rows = rows.map(function (r) {
    return { row_id: r.row_id, origNum: r.origNum, forcedType: r.forcedType, note: r.note,
             hasPhoto: r.hasPhoto, data: r.data, mimeType: r.mimeType,
             phase1: r.hasPhoto ? (phase1ById[r.row_id] || null) : null };
  });
  var textRows = p2rows.filter(function (r) { return !r.hasPhoto; });
  if (textRows.length) {
    var tr = runPhase2Batch(submissionId, textRows, sessionToken);
    okAll = okAll.concat(tr.ok); failedAll = failedAll.concat(tr.failed);
  }
  for (var d = 0; d < photoRows.length; d += perChunk) {
    var ids = {};
    for (var e = d; e < Math.min(d + perChunk, photoRows.length); e++) ids[photoRows[e].row_id] = true;
    var chunk2 = p2rows.filter(function (r) { return ids[r.row_id]; });
    if (!chunk2.length) continue;
    var pr = runPhase2Batch(submissionId, chunk2, sessionToken);
    okAll = okAll.concat(pr.ok); failedAll = failedAll.concat(pr.failed);
  }
  // Triage + one bounded repair for eligible mismatches.
  var finals = [];
  var repairRows = [];
  var failedById = {};
  for (var f = 0; f < failedAll.length; f++) failedById[failedAll[f].row_id] = failedAll[f].error;
  var okById = {};
  for (var o = 0; o < okAll.length; o++) okById[okAll[o].row_id] = okAll[o].txn;
  for (var m = 0; m < rows.length; m++) {
    var meta = rows[m];
    if (failedById[meta.row_id]) {
      finals.push({ row_id: meta.row_id, origNum: meta.origNum, forcedType: meta.forcedType,
        note: meta.note, hasPhoto: meta.hasPhoto, phase1: meta.hasPhoto ? (phase1ById[meta.row_id] || null) : null,
        txn: null, repaired: true, preError: failedById[meta.row_id] });
      continue;
    }
    var tri = triageRow_({ row_id: meta.row_id, origNum: meta.origNum, forcedType: meta.forcedType,
      note: meta.note, hasPhoto: meta.hasPhoto, phase1: meta.hasPhoto ? (phase1ById[meta.row_id] || null) : null,
      txn: okById[meta.row_id], repaired: false }, toggles);
    if (tri.status === 'mismatch' && tri.repairEligible) {
      var calc = tri.rec.calculatedTotal;
      repairRows.push({ row_id: meta.row_id, origNum: meta.origNum, forcedType: meta.forcedType,
        note: meta.note, hasPhoto: true, data: meta.data, mimeType: meta.mimeType,
        expectedTotal: tri.rec.expectedTotal, calculatedTotal: calc, difference: tri.rec.difference });
    } else {
      finals.push({ row_id: meta.row_id, origNum: meta.origNum, forcedType: meta.forcedType,
        note: meta.note, hasPhoto: meta.hasPhoto, phase1: meta.hasPhoto ? (phase1ById[meta.row_id] || null) : null,
        txn: tri.txn, repaired: false });
    }
  }
  if (repairRows.length) {
    for (var rc = 0; rc < repairRows.length; rc += perChunk) {
      var rchunk = repairRows.slice(rc, rc + perChunk);
      var rep = repairReceiptRows(submissionId, rchunk, sessionToken);
      var repById = {};
      for (var ro = 0; ro < rep.ok.length; ro++) repById[rep.ok[ro].row_id] = rep.ok[ro].txn;
      for (var rm = 0; rm < rchunk.length; rm++) {
        var rmeta = rchunk[rm];
        finals.push({ row_id: rmeta.row_id, origNum: rmeta.origNum, forcedType: rmeta.forcedType,
          note: rmeta.note, hasPhoto: true, phase1: phase1ById[rmeta.row_id] || null,
          txn: repById[rmeta.row_id] || null, repaired: true });
      }
    }
  }
  // Failed Phase 2 rows (no txn at all) were already queued as repaired:true with null txn.
  return commitReceiptRows({ submission_id: submissionId, forceLog: toggles.forceLog }, finals, sessionToken);
}

// Classic summary strings from a commit report. unit is 'receipt' or 'row'.
// Throws when nothing was committed, so old callers keep their contract.
function summarizeReport_(report, unit) {
  var rows = (report && report.rows) || [];
  var done = rows.filter(function (r) {
    return r.status === 'logged' || r.status === 'force-adjusted' || r.status === 'auto-discount-adjusted';
  });
  var pending = rows.filter(function (r) { return r.status === 'review' || r.status === 'error'; });
  if (!done.length) {
    var first = pending.length ? pending[0].message : 'nothing to log.';
    throw new Error(first);
  }
  var plural = done.length === 1 ? '' : 's';
  var grand = done.reduce(function (s, r) { return s + Number(r.total || 0); }, 0);
  var bits = done.map(function (r) {
    var label = (unit === 'receipt' ? 'Photo ' : 'Row ') + (r.origNum || '?');
    if (r.duplicate) return label + ': already logged (' + (r.transactionId || '?') + ')';
    var mark = r.status === 'logged' ? '' : ' [' + r.status + ']';
    return label + ': ' + (r.type || '') + ' ' + (r.merchant || 'Unknown') +
      ' (' + (r.itemCount || 0) + ' item(s), Rp' + Number(r.total || 0).toLocaleString('id-ID') + ')' + mark;
  });
  var head = done.length === 1 && !pending.length && !done[0].duplicate
    ? bits[0]
    : 'Logged ' + done.length + ' ' + unit + plural + ', total Rp' + grand.toLocaleString('id-ID') + ' — ' + bits.join('; ');
  if (pending.length) {
    head += ' | ' + pending.length + ' ' + unit + (pending.length === 1 ? '' : 's') +
      ' need review: ' + pending.map(function (r) { return r.message; }).join(' | ');
  }
  return head;
}

// ---------- TABLE BATCH prompt (legacy single-shot builder, kept for compatibility) ----------

// rows: [{imageBase64, mimeType, note, type}] from the Table Layout tab.
function buildTableBatchPrompt(rows) {
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // Rows may mix photo rows and text-only rows. Assign sequential photo numbers
  // only to rows that actually carry image data so the model can map them.
  var photoCount = 0;
  var rowPhotoNo = [];
  for (var k = 0; k < rows.length; k++) {
    if ((rows[k] || {}).data) { photoCount++; rowPhotoNo[k] = photoCount; }
    else { rowPhotoNo[k] = 0; }
  }
  var base =
    'You are extracting structured cashflow data from receipt images, invoices, proofs of transfer, ' +
    'payslips, payment proofs, or plain text notes describing money spent or received. Today\'s date is ' + todayStr + '. If a photo or its note does not contain ' +
    'a clear, explicit date, you MUST use today\'s date (' + todayStr + ') as transaction_date. ' +
    'Never leave transaction_date empty, null, or in any other format - it must always be YYYY-MM-DD. ' +
    'You are given ' + rows.length + ' rows IN ORDER with ' + photoCount + ' attached photo(s)' +
    (photoCount > 0 ? ' (photo 1 first)' : '') + '. ' +
    'Return exactly ' + rows.length + ' transactions in the "transactions" array, one per row, in the same order: ' +
    'transactions[0] is row 1, transactions[1] is row 2, and so on. Do not merge rows and do not skip a row. ' +
    'Rows WITH a photo: treat that photo as its own independent transaction. ' +
    'Rows WITHOUT a photo (text-only): build the transaction purely from the row note text. ' +
    'Treat EACH row as its own independent transaction: choose ONE category per row based on what that row\'s photo/note ' +
    'primarily shows, and apply that same category to every line item of that row - including delivery fees, ' +
    'platform fees, tax, service charges, and discounts (discounts still recorded as negative-amount items). ' +
    'For INCOME transactions: set category to "Income" (unless savings interest or investment returns, which may use ' +
    '"Investment / Savings"), keep regular income amounts positive but record discount/deduction lines as negative amounts exactly like expenses, and OMIT spending_type entirely. ' +
    'For EXPENSE transactions: classify each item into exactly one category and one spending type (Need, Want, Work, Investment). ' +
    'Amounts are in Indonesian Rupiah as plain numbers (no "Rp", dots, or commas). ' +
    'TOTAL RECONCILIATION - follow exactly per photo row: (1) Transcribe EVERY price-affecting line: items, subtotal, ' +
    'discount/diskon/potongan/voucher/promo/cashback deduction (NEGATIVE amounts), tax, service, delivery/platform fee, ' +
    'rounding, bag fee. (2) The printed final total (TOTAL / TOTAL BAYAR / GRAND TOTAL / Amount charged) is ground truth. ' +
    '(3) Item amounts (negatives included) MUST sum exactly to that printed total. Re-scan for missed small-print lines ' +
    'before answering. Never invent a balancing line. Text-only rows: transcribe the amounts stated in the note. ' +
    'PER-ROW OVERRIDES - the user forced a transaction_type and wrote a note per row. You MUST obey them: ';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var forced = (r.type === 'Income') ? 'Income' : 'Expense';
    var note = String(r.note || '');
    // Cap note length in prompt to keep the single request small.
    if (note.length > 500) note = note.slice(0, 500);
    if (rowPhotoNo[i] > 0) {
      base += 'Row ' + (i + 1) + ' (Photo ' + rowPhotoNo[i] + ' of ' + photoCount + '): transaction_type MUST be "' + forced + '"'
        + (note ? ' and apply this note as context: "' + note + '"' : ' (no note)')
        + '. ';
    } else {
      base += 'Row ' + (i + 1) + ' (text-only, no photo): transaction_type MUST be "' + forced + '"'
        + (note ? ' - build the transaction from this note: "' + note + '"' : ' (no note and no photo - return a single zero-amount placeholder item)')
        + '. ';
    }
  }
  base += 'If a forced type is "Income", classify that row\'s items as income (regular amounts positive, discount/deduction lines negative like expenses; no spending_type). ' +
    'If forced "Expense", classify as expense even if the content superficially looks like income.';
  return base;
}

// Compatibility wrapper: routes through the shared two-phase pipeline
// (Phase 1 totals, Phase 2 lines, one repair, toggle policy, commit).
// Large submissions must use the phased server ops directly instead of this
// single execution.
function processTableBatch(rows, sessionToken, opts) {
  requireSession_(sessionToken);
  rows = rows || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Add at least one filled row (photo or note) first.');
  }
  // Ignore completely empty rows (no photo AND no note) so a form with
  // e.g. 10 open rows but only 5 filled logs just those 5.
  var nonEmpty = rows.filter(function (r) {
    r = r || {};
    var hasImg = !!(r.imageBase64 || r.data);
    var hasNote = String(r.note || '').trim() !== '';
    return hasImg || hasNote;
  });
  if (nonEmpty.length === 0) {
    throw new Error('Add at least one filled row (photo or note) first.');
  }
  // Compatibility single-shot path for small batches. The Table Layout UI
  // drives the phased ops directly (unbounded); oversized single calls are
  // rejected with guidance instead of risking one giant execution.
  if (nonEmpty.length > BATCH_LIMITS.maxRowsPerBatch) {
    throw new Error('Too many rows for a single request - submit from Table Layout, which sends phased batches automatically.');
  }
  var toggles = { forceLog: !!(opts && opts.forceLog) };
  var defs = nonEmpty.map(function (r, i) {
    r = r || {};
    return {
      forcedType: (r.type === 'Income') ? 'Income' : 'Expense',
      note: String(r.note || '').slice(0, 1000),
      data: r.imageBase64 || r.data || '',
      mimeType: r.mimeType || 'image/jpeg',
      hasPhoto: !!(r.imageBase64 || r.data),
      origNum: i + 1
    };
  });
  var report = processRowsPipeline_(defs, toggles, sessionToken, Utilities.getUuid());
  return summarizeReport_(report, 'row');
}

function formatSummary(txn) {
  var total = txn.items.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
  return txn.transaction_type + ' logged: ' + txn.merchant + ', ' +
    txn.items.length + ' item(s), total Rp' + total.toLocaleString('id-ID');
}

function formatSummaryFromParts(single) {
  // Single-photo multi-entry result already reads well; prefix for consistency.
  return single;
}
