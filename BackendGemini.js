// ---------- GEMINI (with model fallback) ----------

// Text-prompt generation helper (private: must never be client-callable, or
// anyone with the app URL could burn the owner's Gemini quota without a PIN).
// All phased ops call callGeminiRaw_ directly; only the text-only path uses this.
function callGemini_(promptText, sourceText, images, schema) {
  var parts = [{ text: promptText }];
  if (sourceText) {
    parts.push({ text: 'Message text: ' + sourceText });
  }
  images = images || [];
  for (var j = 0; j < images.length; j++) {
    var img = images[j] || {};
    if (!img.data) continue;
    // Numbered label keeps photo order explicit for the batch schema.
    if (images.length > 1) {
      parts.push({ text: 'Photo ' + (j + 1) + ' of ' + images.length + ':' });
    }
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
  }

  return callGeminiRaw_(parts, schema).data;
}

// Raw generation call with model fallback. Returns {data, model, usage} where
// usage is the response usageMetadata when the API provides it (used to
// improve batch estimates; never used to alter row mapping).
// Throws the same aggregated/fast-fail errors callGemini_() always produced.
function callGeminiRaw_(parts, schema) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key is not set - please add it when prompted.');
  }
  try {
    var rlKey = 'CF_GEMINI_RL_' + Math.floor(Date.now() / 60000);
    var rl = CacheService.getScriptCache();
    var n = Number(rl.get(rlKey) || 0) + 1;
    if (n > 120) throw new Error('Gemini request limit reached for this minute - wait and retry.');
    rl.put(rlKey, String(n), 120);
  } catch (eRl) {
    if (eRl && /request limit/i.test(eRl.message || '')) throw eRl;
  }

  var payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema || TRANSACTION_SCHEMA
    }
  };

  var errors = [];

  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var model = GEMINI_MODELS[i];
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      model + ':generateContent?key=' + apiKey;

    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();

    if (code === 200) {
      try {
        var data = JSON.parse(body);
        var rawJsonText = data.candidates[0].content.parts[0].text;
        var txn = JSON.parse(rawJsonText);
        if (i > 0) {
          console.log('Gemini: fell back to model "' + model + '" after ' + i + ' failure(s)');
        }
        var usage = null;
        try { usage = data.usageMetadata || null; } catch (e) {}
        return { data: txn, model: model, usage: usage };
      } catch (parseErr) {
        // Got a 200 but couldn't parse it as the expected JSON shape - try the next model
        errors.push(model + ': got 200 but response was unparseable (' + parseErr.message + ')');
        continue;
      }
    }

    errors.push(model + ': HTTP ' + code + ' - ' + body.substring(0, 300));

    // 400/401/403 mean the request or credentials are wrong - every model
    // would fail the same way, so stop instead of burning through the list.
    if (code === 400 || code === 401 || code === 403) {
      throw new Error('Gemini request rejected (' + code + '), not retrying other models:\n' + errors.join('\n'));
    }
    // 404 (model unavailable), 429 (rate limited), 5xx (transient) - fall through to the next model.
  }

  throw new Error('All Gemini models failed:\n' + errors.join('\n'));
}

// ---------- TWO-PHASE ORCHESTRATION OPS (bounded server calls) ----------
//
// The web app drives submissions as sequential bounded google.script.run
// calls: plan -> Phase 1 batches -> Phase 2 batches -> (repair) ->
// reconcile/commit -> (separate) sort. No single execution runs the whole
// submission, and Gemini calls are strictly sequential (never concurrent).

function validateRowMeta_(m) {
  m = m || {};
  var rowId = String(m.row_id || '').trim();
  if (!rowId) throw new Error('Row is missing its stable row_id.');
  var type = m.type === 'Income' ? 'Income' : (m.type === 'Expense' ? 'Expense' : null);
  return {
    row_id: rowId,
    origNum: Math.max(1, Number(m.origNum || 0) || 0),
    note: String(m.note || '').slice(0, 1000),
    type: type,
    hasPhoto: !!m.hasPhoto,
    imageBytes: Math.max(0, Number(m.imageBytes || 0) || 0)
  };
}

// Server-side batch plan for a frozen row snapshot. Stateless and pure
// apart from reading stored usage factors for estimate tuning.
function planReceiptSubmission(rowsMeta, sessionToken) {
  requireSession_(sessionToken);
  rowsMeta = rowsMeta || [];
  if (!Array.isArray(rowsMeta) || rowsMeta.length === 0) {
    throw new Error('Add at least one filled row (photo or note) first.');
  }
  var cleaned = rowsMeta.map(validateRowMeta_);
  var plan = planReceiptBatches_(cleaned);
  return {
    batches: plan.batches,
    totals: plan.totals,
    budgets: {
      maxPhotosPerBatch: BATCH_LIMITS.maxPhotosPerBatch,
      maxRowsPerBatch: BATCH_LIMITS.maxRowsPerBatch,
      maxPayloadBytes: BATCH_LIMITS.maxPayloadBytes
    }
  };
}

function checkBatchBytes_(rows, limit) {
  var bytes = 0;
  for (var i = 0; i < rows.length; i++) bytes += String((rows[i] || {}).data || '').length;
  if (bytes > limit) {
    throw new Error('Batch payload (' + bytes + ' chars) exceeds the ' + limit +
      ' safety budget - split into smaller batches and retry.');
  }
  return bytes;
}

function labelPhotoParts_(rows) {
  var parts = [];
  var photoNo = 0;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].data) continue;
    photoNo++;
    rows[i].photoNo = photoNo;
    parts.push({ text: 'Photo ' + photoNo + ' (row_id="' + rows[i].row_id + '"):' });
    parts.push({ inline_data: { mime_type: rows[i].mimeType || 'image/jpeg', data: rows[i].data } });
  }
  return parts;
}

// Phase 1: printed-total extraction only. rows: [{row_id, photo_index, data, mimeType}]
// Performs NO sheet writes. Returns per-photo results keyed by row_id.
function runPhase1Batch(submissionId, rows, sessionToken) {
  requireSession_(sessionToken);
  String(submissionId || '');
  rows = rows || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Phase 1 batch has no photo rows.');
  }
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i].row_id || !rows[i].data) {
      throw new Error('Phase 1 row ' + (i + 1) + ' is missing row_id or image data.');
    }
  }
  checkBatchBytes_(rows, BATCH_LIMITS.maxPayloadBytes);
  var promptRows = rows.map(function (r, i) { return { row_id: r.row_id, photo_index: i + 1 }; });
  var parts = [{ text: buildPhase1Prompt(promptRows) }].concat(labelPhotoParts_(rows));
  var raw;
  try {
    raw = callGeminiRaw_(parts, PHASE1_SCHEMA);
  } catch (e) {
    throw new Error('Phase 1 total extraction failed: ' + (e && e.message ? e.message : e));
  }
  var list = raw.data && raw.data.results;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Phase 1 returned no usable results - nothing was written.');
  }
  var want = {};
  for (var k = 0; k < rows.length; k++) want[rows[k].row_id] = true;
  var seen = {};
  var results = [];
  for (var j = 0; j < list.length; j++) {
    var r = list[j] || {};
    var id = String(r.row_id || '');
    if (!id || !want[id] || seen[id]) continue; // ignore unknown/duplicate rows
    seen[id] = true;
    results.push(sanitizePhase1Result_(r, id));
  }
  var missing = [];
  for (var m = 0; m < rows.length; m++) {
    if (!seen[rows[m].row_id]) missing.push(rows[m].row_id);
  }
  if (missing.length) {
    throw new Error('Phase 1 response is missing results for ' + missing.length +
      ' photo row(s) - nothing was written. Retry the batch.');
  }
  updateUsageFactors_([{ inputTokens: raw.usage && raw.usage.promptTokenCount, photoCount: rows.length }]);
  return { results: results, model: raw.model, usage: raw.usage || null };
}

var PHASE1_STATUS = ['found', 'uncertain', 'not_visible'];
var PHASE1_QUALITY = ['clear', 'blurry', 'partially_obscured', 'incomplete'];

function sanitizePhase1Result_(r, id) {
  var amt = Number(r.total_amount);
  var status = PHASE1_STATUS.indexOf(r.total_status) >= 0 ? r.total_status : 'uncertain';
  var quality = PHASE1_QUALITY.indexOf(r.image_quality) >= 0 ? r.image_quality : 'incomplete';
  var review = String(r.review_reason || '').slice(0, 300);
  if (!isFinite(amt) || amt < 0) {
    amt = 0;
    if (status === 'found') {
      status = 'uncertain';
      review = review || 'Unreadable total amount returned; flagged instead of guessed.';
    }
  } else {
    amt = Math.round(amt);
  }
  if (status !== 'found' && !review) review = 'Total ' + status.replace('_', ' ') + '; needs review.';
  return {
    row_id: id,
    photo_index: Math.max(1, Number(r.photo_index || 0) || 0),
    total_amount: amt,
    total_label: String(r.total_label || '').slice(0, 120),
    total_status: status,
    image_quality: quality,
    review_reason: review
  };
}

// Phase 2: full line-item extraction with Phase 1 manifest. Performs NO writes.
// rows: [{row_id, origNum, forcedType|null, note, hasPhoto, data?, mimeType?, phase1|null}]
// Returns {ok: [{row_id, txn}], failed: [{row_id, error}]} - one bad row never
// fails its batch siblings.
function runPhase2Batch(submissionId, rows, sessionToken) {
  requireSession_(sessionToken);
  String(submissionId || '');
  rows = rows || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Phase 2 batch has no rows.');
  }
  var withPhotos = 0, qi;
  for (qi = 0; qi < rows.length; qi++) {
    if (!rows[qi] || !rows[qi].row_id) throw new Error('Phase 2 row ' + (qi + 1) + ' is missing row_id.');
    if (rows[qi].hasPhoto && !rows[qi].data) {
      throw new Error('Phase 2 photo row is missing image data - resubmit the batch with its images.');
    }
    if (rows[qi].hasPhoto) withPhotos++;
  }
  var photoRows = rows.filter(function (r) { return r.hasPhoto; });
  checkBatchBytes_(photoRows, BATCH_LIMITS.maxPayloadBytes);
  // Stable photo numbering shared by prompt labels and image parts.
  var photoNo = 0, pi;
  for (pi = 0; pi < rows.length; pi++) {
    if (rows[pi].hasPhoto) { photoNo++; rows[pi].photoNo = photoNo; }
  }
  var parts = [{ text: buildPhase2Prompt(rows) }].concat(labelPhotoParts_(photoRows));
  var raw;
  try {
    raw = callGeminiRaw_(parts, PHASE2_SCHEMA);
  } catch (e) {
    throw new Error('Phase 2 extraction failed: ' + (e && e.message ? e.message : e));
  }
  var list = raw.data && raw.data.transactions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Phase 2 returned no usable transactions - nothing was written.');
  }
  var want = {};
  for (var k = 0; k < rows.length; k++) want[rows[k].row_id] = true;
  var byId = {};
  for (var j = 0; j < list.length; j++) {
    var t = list[j] || {};
    var id = String(t.row_id || '');
    if (!id || !want[id] || byId[id]) continue;
    byId[id] = t;
  }
  var ok = [], failed = [];
  for (var m = 0; m < rows.length; m++) {
    var meta = rows[m];
    var got = byId[meta.row_id];
    if (!got) {
      failed.push({ row_id: meta.row_id, error: 'The AI response has no transaction for this row - nothing from this row was appended.' });
      continue;
    }
    try {
      if (meta.forcedType === 'Income' || meta.forcedType === 'Expense') got.transaction_type = meta.forcedType;
      var txn = sanitizeTransaction(JSON.parse(JSON.stringify(got)));
      ok.push({ row_id: meta.row_id, txn: txn });
    } catch (e) {
      failed.push({ row_id: meta.row_id, error: e && e.message ? e.message : String(e) });
    }
  }
  updateUsageFactors_([{ inputTokens: raw.usage && raw.usage.promptTokenCount, photoCount: withPhotos }]);
  return { ok: ok, failed: failed, model: raw.model, usage: raw.usage || null };
}

// Bounded repair: exactly one re-examination per eligible row. Same shape as
// Phase 2 but with repair instructions; caller groups eligible rows with the
// normal batch budget. Performs NO writes.
function repairReceiptRows(submissionId, rows, sessionToken) {
  requireSession_(sessionToken);
  String(submissionId || '');
  rows = rows || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Repair batch has no rows.');
  }
  var qi;
  for (qi = 0; qi < rows.length; qi++) {
    var r = rows[qi] || {};
    if (!r.row_id || !r.data) throw new Error('Repair row ' + (qi + 1) + ' needs row_id, image, and totals.');
    if (!isFinite(Number(r.expectedTotal)) || !isFinite(Number(r.calculatedTotal))) {
      throw new Error('Repair row needs finite expected/calculated totals.');
    }
  }
  checkBatchBytes_(rows, BATCH_LIMITS.maxPayloadBytes);
  var photoNo = 0, pi;
  for (pi = 0; pi < rows.length; pi++) { photoNo++; rows[pi].photoNo = photoNo; }
  var parts = [{ text: buildRepairPrompt(rows) }].concat(labelPhotoParts_(rows));
  var raw;
  try {
    raw = callGeminiRaw_(parts, PHASE2_SCHEMA);
  } catch (e) {
    throw new Error('Repair attempt failed: ' + (e && e.message ? e.message : e));
  }
  var list = raw.data && raw.data.transactions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Repair attempt returned no usable transactions - originals are kept for review.');
  }
  var want = {};
  for (var k = 0; k < rows.length; k++) want[rows[k].row_id] = true;
  var byId = {};
  for (var j = 0; j < list.length; j++) {
    var t = list[j] || {};
    var id = String(t.row_id || '');
    if (!id || !want[id] || byId[id]) continue;
    byId[id] = t;
  }
  var ok = [], failed = [];
  for (var m = 0; m < rows.length; m++) {
    var meta = rows[m];
    var got = byId[meta.row_id];
    if (!got) {
      failed.push({ row_id: meta.row_id, error: 'Repair returned nothing for this row - original extraction kept for review.' });
      continue;
    }
    try {
      if (meta.forcedType === 'Income' || meta.forcedType === 'Expense') got.transaction_type = meta.forcedType;
      ok.push({ row_id: meta.row_id, txn: sanitizeTransaction(JSON.parse(JSON.stringify(got))) });
    } catch (e) {
      failed.push({ row_id: meta.row_id, error: e && e.message ? e.message : String(e) });
    }
  }
  return { ok: ok, failed: failed, model: raw.model, usage: raw.usage || null };
}

// ---------- SANITIZE (server-side guarantees) ----------

// Gemini is instructed to default missing dates to today, but prompts are
// not guarantees - normalize here so the sheet NEVER gets an empty date.
function normalizeTransactionDate(dateStr) {
  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (!dateStr || typeof dateStr !== 'string') return todayStr;
  var s = dateStr.trim();
  if (!s) return todayStr;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return s;
    return todayStr;
  }
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, tz, 'yyyy-MM-dd');
  }
  return todayStr;
}

function sanitizeTransaction(txn) {
  txn = txn || {};
  if (txn.transaction_type !== 'Income' && txn.transaction_type !== 'Expense') {
    txn.transaction_type = 'Expense';
  }
  var isIncome = txn.transaction_type === 'Income';
  txn.transaction_date = normalizeTransactionDate(txn.transaction_date);
  if (!txn.merchant) txn.merchant = 'Unknown';
  if (!Array.isArray(txn.items) || txn.items.length === 0) {
    throw new Error('Gemini returned no line items - nothing to log.');
  }
  txn.items = txn.items.map(function (item) {
    item = item || {};
    // Both Expense and Income keep their signs so discount/deduction lines survive as negatives.
    var rawAmount = Number(item.amount) || 0;
    var amount = rawAmount;
    var category = item.category;
    if (EXPENSE_CATEGORIES.indexOf(category) === -1) {
      category = isIncome ? 'Income' : 'Others';
    }
    // Income rows must not carry a spending type; expense rows default to Need check upstream? keep as-is.
    var spendingType = item.spending_type || '';
    if (isIncome) {
      spendingType = '';
    } else if (SPENDING_TYPES.indexOf(spendingType) === -1) {
      spendingType = '';
    }
    var clean = {
      description: item.description || txn.merchant,
      amount: amount,
      category: category,
      spending_type: spendingType
    };
    // Optional structured fields, kept ONLY when the model actually returned a
    // usable number. Never derived, never guessed, never defaulted - a missing
    // quantity/unit price stays absent so no price detail is ever fabricated.
    var qty = Number(item.quantity);
    if (isFinite(qty) && qty > 0) clean.quantity = qty;
    var unit = Number(item.unit_price);
    if (isFinite(unit) && unit !== 0) clean.unit_price = unit;
    return clean;
  });
  // Optional printed receipt title: trimmed, length-capped, and dropped when
  // the model had none. Never synthesised here - condenseTxn_ falls back to
  // facts already present on the transaction.
  var title = String(txn.receipt_title || '').trim().slice(0, 120);
  if (title) txn.receipt_title = title;
  else delete txn.receipt_title;
  return txn;
}

// ---------- RECONCILIATION + TOGGLE POLICY (pure, unit-testable) ----------

function idr_(n) {
  try { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }
  catch (e) { return 'Rp' + n; }
}

// Server-side row verdict. Never trusts batch totals - strictly per row.
// verdicts: ok | mismatch | uncertain | not_applicable | invalid
//
// opts.quickMode switches on the Quick-Input policy ONLY (Table Layout is
// untouched): there, a reliably read final Total is the decisive check. A
// matching item sum is saved under that verified total even when the model
// flagged the line list as possibly incomplete - the incompleteness is
// disclosed in the row message (which lands in Notes), never invented away.
// An unreadable/uncertain total is still `uncertain`, so it stays reviewable
// regardless of Force-save (applyTogglePolicy_ only acts on `mismatch`).
function reconcileRow_(phase1, txn, opts) {
  opts = opts || {};
  var quickMode = !!opts.quickMode;
  var hasPhoto = !!opts.hasPhoto;
  if (!hasPhoto) return { verdict: 'not_applicable', expectedTotal: null, calculatedTotal: null, difference: null, message: '' };
  if (!phase1) {
    return { verdict: 'invalid', expectedTotal: null, calculatedTotal: null, difference: null,
             message: 'No Phase 1 total was recorded for this photo - nothing from this row was appended.' };
  }
  var items = (txn && txn.items) || [];
  var calc = 0;
  for (var i = 0; i < items.length; i++) {
    var a = Number(items[i] && items[i].amount);
    if (!isFinite(a)) {
      return { verdict: 'invalid', expectedTotal: null, calculatedTotal: null, difference: null,
               message: 'An extracted amount is not a valid number - nothing from this row was appended.' };
    }
    calc += a;
  }
  calc = Math.round(calc);
  var status = phase1.total_status;
  var expected = Math.round(Number(phase1.total_amount));
  if (status !== 'found' || !isFinite(expected)) {
    var why = phase1.review_reason ||
      (status === 'not_visible' ? 'The receipt total area is not visible.' : 'The receipt total could not be read reliably.');
    return { verdict: 'uncertain', expectedTotal: null, calculatedTotal: calc, difference: null,
             message: why + ' Upload a clearer photo showing the full item list and final total.' };
  }
  var diff = expected - calc;
  var complete = String((txn && txn.line_list_complete) || 'complete');
  var flags = String((txn && txn.extraction_notes) || '').slice(0, 200);
  if (diff === 0 && complete === 'complete') {
    return { verdict: 'ok', expectedTotal: expected, calculatedTotal: calc, difference: 0, message: '' };
  }
  if (diff === 0) {
    // Item list flagged as possibly incomplete/illegible but the extracted
    // sum still equals the reliable printed total.
    var incompleteMsg = 'Totals match (' + idr_(expected) + ') but the line list may be incomplete' +
      (flags ? ': ' + flags : '.');
    if (quickMode) {
      // Quick-Input: the printed total is the decisive check. Save under it and
      // disclose the incompleteness instead of holding the receipt for review.
      // No item or price is invented to close the gap.
      return { verdict: 'ok', expectedTotal: expected, calculatedTotal: calc, difference: 0,
               disclosure: 'QUICK-INPUT INCOMPLETE LINE LIST: ' + incompleteMsg.slice(6),
               message: incompleteMsg };
    }
    // Table Layout keeps its original, stricter behaviour.
    return { verdict: 'uncertain', expectedTotal: expected, calculatedTotal: calc, difference: 0,
             message: incompleteMsg + ' Expand the item list and verify before logging.' };
  }
  if (diff > 0) {
    return { verdict: 'mismatch', expectedTotal: expected, calculatedTotal: calc, difference: diff,
             message: 'Some items may be missing or hidden. Extracted total is ' + idr_(diff) +
               ' below the printed total (' + idr_(calc) + ' vs ' + idr_(expected) + '). Expand the item list and upload the full receipt.' };
  }
  return { verdict: 'mismatch', expectedTotal: expected, calculatedTotal: calc, difference: diff,
           message: 'Extracted items exceed the printed total by ' + idr_(-diff) +
             ' (' + idr_(calc) + ' vs ' + idr_(expected) + '). A discount may be missing, or an amount may be duplicated/read incorrectly.' };
}

function dominantCategory_(txn) {
  var items = (txn && txn.items) || [];
  var counts = {}, best = '', bestN = 0, oi;
  for (oi = 0; oi < items.length; oi++) {
    var c = items[oi].category || '';
    counts[c] = (counts[c] || 0) + 1;
    if (counts[c] > bestN) { bestN = counts[c]; best = c; }
  }
  if (!best || EXPENSE_CATEGORIES.indexOf(best) < 0) best = (txn.transaction_type === 'Income') ? 'Income' : 'Others';
  return best;
}

function dominantSpendingType_(txn) {
  var items = (txn && txn.items) || [];
  var counts = {}, best = '', bestN = 0, oi;
  for (oi = 0; oi < items.length; oi++) {
    var s = items[oi].spending_type || '';
    if (!s || SPENDING_TYPES.indexOf(s) < 0) continue;
    counts[s] = (counts[s] || 0) + 1;
    if (counts[s] > bestN) { bestN = counts[s]; best = s; }
  }
  return best || 'Need';
}

// Applies Force-save AFTER the bounded repair attempt.
// Only synthesizes a balancing line for a reliable-total mismatch. It never
// acts on uncertain/unreadable totals, invalid rows, or text-only rows.
// Returns {txn, applied, note} with applied in none|force-item|force-discount.
function applyTogglePolicy_(txn, rec, toggles) {
  toggles = toggles || {};
  var forceLog = !!toggles.forceLog;
  if (!rec || rec.verdict !== 'mismatch') return { txn: txn, applied: 'none', note: '' };
  var diff = rec.difference;
  if (!isFinite(diff) || diff === 0) return { txn: txn, applied: 'none', note: '' };
  var isIncome = txn.transaction_type === 'Income';
  function syntheticLine_(name, amount) {
    return { description: name, amount: amount, category: dominantCategory_(txn),
      spending_type: isIncome ? '' : dominantSpendingType_(txn) };
  }
  if (forceLog) {
    var out = JSON.parse(JSON.stringify(txn));
    if (diff > 0) {
      out.items.push(syntheticLine_('Missing/hidden item', diff));
      return { txn: out, applied: 'force-item',
        note: 'FORCED RECONCILIATION: synthetic missing/hidden line of ' + idr_(diff) + '; verify receipt.' };
    }
    out.items.push(syntheticLine_('Missing/hidden discount', diff));
    return { txn: out, applied: 'force-discount',
      note: 'FORCED RECONCILIATION: synthetic missing/hidden discount of ' + idr_(diff) + '; verify receipt.' };
  }
  return { txn: txn, applied: 'none', note: '' };
}
