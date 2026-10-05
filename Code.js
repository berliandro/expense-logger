/**
 * AUTO CASHFLOW LOG — Web App -> Gemini -> Google Sheets
 * ========================================================
 * Logs both Expense and Income. Gemini classifies transaction_type;
 * missing/unclear dates always fall back to today (enforced both in
 * the prompt AND server-side in sanitizeTransaction, so the sheet
 * never gets an empty date).
 *
 * SETUP (do these once):
 *
 * 1. Script Properties (Project Settings > Script Properties), add:
 *      GEMINI_API_KEY  - from Google AI Studio
 *      SPREADSHEET_ID  - the ID from your sheet's URL
 *
 * 2. In your spreadsheet, create a sheet named exactly "Template" with a
 *    header row (row 1) containing these column names, in any order:
 *      Date | Merchant | Description | Amount | Category | Spending Type | Type | Notes
 *    You can hide this sheet — copyTo() still works on hidden sheets.
 *
 * 3. Deploy > New deployment > Web app.
 *      Execute as: Me (USER_DEPLOYING)
 *      Who has access: Anyone (ANYONE_ANONYMOUS) — family members open the
 *      /exec URL without needing editor access. The app's own 6-digit
 *      PIN + 12h session check still gates all sensitive calls.
 *
 * 4. Open the resulting /exec URL. Bookmark it or add it to your phone's
 *    home screen so it behaves like a mini app icon.
 *
 * MODEL FALLBACK (point 6)
 * -------------------------
 * GEMINI_MODELS below is tried in order, best first. If a model is
 * unavailable, rate-limited, or has a transient server error, the script
 * automatically moves to the next one. If the API rejects the request
 * outright (bad key, malformed request), it fails fast instead of
 * burning through every model on a doomed request.
 * Reorder or edit this list any time — no other code needs to change.
 * Free-tier status changes over time; verify at aistudio.google.com/rate-limit
 * if you're not sure a model is still free.
 */

// ---------- CONFIG ----------

const TEMPLATE_SHEET_NAME = 'Template';

const GEMINI_MODELS = [
  'gemini-3.6-flash',      // current general-purpose workhorse
  'gemini-3.5-flash',      // previous-gen flash, still solid
  'gemini-2.5-flash',      // stable, well-tested fallback
  'gemini-3.1-flash-lite', // faster/cheaper, still free tier
  'gemini-2.5-flash-lite'  // last resort - fastest, lowest tier
];

const EXPENSE_CATEGORIES = [
  'Food & Beverage', 'Groceries', 'Transportation', 'Utilities & Bills',
  'Shopping', 'Health', 'Education', 'Entertainment & Subscriptions',
  'Housing', 'Family / Dependents', 'Investment / Savings', 'Income', 'Others'
];
const SPENDING_TYPES = ['Need', 'Want', 'Work', 'Investment'];

const TRANSACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transaction_date: { type: 'STRING', description: 'Transaction date as YYYY-MM-DD. If the image or text does not contain a clear, explicit date, you MUST output today\'s date (provided in the prompt). Never leave this empty, null, or omit it.' },
    merchant: { type: 'STRING', description: 'Store, payee, or income source (e.g. Shopee, employer name, client name)' },
    transaction_type: {
      type: 'STRING',
      enum: ['Expense', 'Income'],
      description: 'Classify as "Income" if the transaction/note represents incoming money (salary, sales, freelance, payment received, refunds, transfers in). Classify as "Expense" for purchases, bills, or money spent.'
    },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          amount: { type: 'NUMBER', description: 'In IDR, plain number, no symbol or separators. Regular charges are positive. Discounts, deductions, rebates, voucher/promo cuts, cashback applied as a deduction (diskon, potongan, pengurangan) MUST be negative numbers. Income amounts are normally positive, but discount/deduction lines (diskon, potongan, voucher, promo, cashback, withheld fees) MUST be negative like expenses.' },
          category: { type: 'STRING', enum: EXPENSE_CATEGORIES },
          spending_type: { type: 'STRING', enum: SPENDING_TYPES, description: 'Expense items ONLY. MUST be omitted for Income items.' }
        },
        required: ['description', 'amount', 'category']
      }
    }
  },
  required: ['transaction_date', 'merchant', 'transaction_type', 'items']
};

// Batch wrapper: one Gemini request for N photos returns N transactions in
// order. Single request = single hit against the per-day request quota.
const BATCH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transactions: {
      type: 'ARRAY',
      description: 'One entry per photo, in the same order as the photos were given.',
      items: TRANSACTION_SCHEMA
    }
  },
  required: ['transactions']
};

// Keep the old name as an alias so any existing caller still works.
const EXPENSE_SCHEMA = TRANSACTION_SCHEMA;

// photoCount: 0 = text-only, 1 = single receipt photo, >1 = batched
// multi-photo submission (ONE Gemini request for all photos).
// Per-photo rule always holds: each photo is its own transaction with ONE
// category - fees, tax, service charges and discounts share the receipt's
// main category. E.g. a discount on a food receipt is a food expense.
function buildPrompt(userNote, photoCount) {
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var isPhoto = photoCount > 0;
  var base =
    'You are extracting structured cashflow data (expense or income) from receipt images, ' +
    'invoices, proofs of transfer, payslips, or a text message describing money spent or money received. ' +
    'Identify the merchant or source (for income this is the payer/employer/client/platform), ' +
    'the transaction date, and every distinct line item with its individual amount. ' +
    'Today\'s date is ' + todayStr + '. If an image or the text does not contain a clear, explicit ' +
    'date, you MUST use today\'s date (' + todayStr + ') as transaction_date. Never leave ' +
    'transaction_date empty, null, or in any other format - it must always be YYYY-MM-DD. ' +
    'Determine transaction_type as "Income" when money is coming IN (salary/wages, freelance or ' +
    'client payments, sales proceeds, commissions, bonuses, refunds received, transfers in, ' +
    'payment received, e-wallet top-up received) and as "Expense" when money is going OUT (purchases, bills, fees, rent, ' +
    'paying for a friend, e-wallet top-up paid). ' +
    'If unclear, default to "Expense". ' +
    'For INCOME items: set category to "Income" (unless the income is specifically savings interest ' +
    'or investment returns, which may use "Investment / Savings"), describe what the income was for, ' +
    'keep regular income amounts positive but record discount/deduction lines (diskon, potongan, voucher, promo, cashback, withheld fees) as negative amounts exactly like expenses, and OMIT spending_type entirely. ' +
    'For EXPENSE items: classify each into exactly one category and exactly one spending type ' +
    '(Need, Want, Work, or Investment) - never invent a category or spending type not in ' +
    'the list. Multiple items in one transaction can have different spending types ' +
    '(e.g. a grocery run split between personal need, personal want, and work). If ' +
    'money is going into savings, a recurring investment, or being used to buy assets ' +
    'or inventory for resale - including for a personal side business - classify it ' +
    'under "Investment / Savings" with spending_type "Investment", even if it ' +
    'superficially looks like an ordinary purchase. If a receipt shows one total with no itemized ' +
    'breakdown, return a single item using the merchant/source name as the description. ' +
    'Amounts are in Indonesian Rupiah as plain numbers (no "Rp", dots, or commas). ' +
    'TOTAL RECONCILIATION - follow these steps exactly: ' +
    '(1) Transcribe EVERY price-affecting line on the receipt: each item, subtotal, ' +
    'discount/diskon/potongan/voucher/promo/cashback deduction, tax, service charge, delivery/platform fee, ' +
    'rounding, and bag fee. Discount-type lines MUST have negative amounts (e.g. a "Diskon 10.000" line ' +
    'becomes amount -10000 with a description like "Diskon" or "Discount on <item>"). ' +
    '(2) Read the printed final total (TOTAL / TOTAL BAYAR / GRAND TOTAL / Amount charged) - that is ground truth. ' +
    '(3) Add up all your item amounts (negatives included) and compare against that printed total. ' +
    'They MUST match exactly. If they do not match, re-scan the image for lines you missed ' +
    '(small-print discounts, voided lines, fees at the bottom) and fix your items before answering. ' +
    'Never invent a "balancing" or "adjustment" line to force a match - only transcribe lines actually printed.';

  if (photoCount > 1) {
    base +=
      ' You are given ' + photoCount + ' receipt/proof photos IN ORDER (photo 1 first, photo ' + photoCount + ' last). ' +
      'Return exactly ' + photoCount + ' transactions in the "transactions" array, one per photo, ' +
      'in the same order: transactions[0] is photo 1, transactions[1] is photo 2, and so on. ' +
      'Treat EACH photo as its own independent transaction: choose ONE category per photo based on ' +
      'what that photo primarily shows, and apply that same category to every line item of that photo - ' +
      'including delivery fees, platform fees, tax, service charges, and discounts (discounts still recorded ' +
      'as negative-amount items). A discount on a food ' +
      'receipt is a food expense; a fee on a transport receipt is transport. Do not give fees, tax, or ' +
      'discounts their own separate category from their photo\'s main items. Do not merge items across ' +
      'photos and do not skip a photo - every photo gets its own entry with its own merchant, date, and type. ' +
      'If a photo is proof of INCOME (payslip, transfer receipt, payment received), ' +
      'use category "Income" for every item of that entry.';
  } else if (isPhoto) {
    base +=
      ' This is a single receipt/proof photo, so treat the whole image as one ' +
      'transaction: choose ONE category based on what the receipt primarily shows, and ' +
      'apply that same category to every line item on the receipt - including ' +
      'delivery fees, platform fees, tax, service charges, and discounts (discounts still recorded ' +
      'as negative-amount items). Do not ' +
      'give fees, tax, or discounts their own separate category from the main items. ' +
      'If the photo is proof of INCOME (payslip, transfer receipt, payment received), ' +
      'use category "Income" for every item.';
  } else {
    base +=
      ' Classify each item into exactly one of the given categories - items in the ' +
      'same message can have different categories if they genuinely cover different ' +
      'kinds of purchases.';
  }

  if (userNote) {
    if (photoCount > 1) {
      base += ' The user attached one shared note to all photos: "' + userNote + '". ' +
        'Apply the note globally to every photo, EXCEPT when the note contains per-photo references ' +
        '(e.g. "first photo", "photo 1", "second", "the third is...", "photo 3 is top-up..."). ' +
        'In that case, only apply the part describing a given photo to that photo\'s transaction ' +
        '(e.g. "the third is me paying food for my friend" describes transactions[2]: an Expense ' +
        'for food) and ignore parts describing other photos. If no part of the note mentions a photo, ' +
        'treat that photo as having no note context beyond global remarks.';
    } else {
      base += ' The user attached this note: "' + userNote + '". Use it as context for classification.';
    }
  }
  return base;
}

// ---------- SPREADSHEET ACCESS (friendly config errors) ----------

// SpreadsheetApp.openById(null) throws cryptic "Invalid argument: id".
// Validate first so family members see what to fix instead.
function extractSpreadsheetId_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m = s.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (m && m[1]) return m[1];
  s = s.replace(/^[\s<>"']+|[\s<>"']+$/g, '');
  return s;
}

// Container-bound scripts (copied from an existing Sheet) already have a
// spreadsheet. getActiveSpreadsheet() returns it; standalone scripts return null.
function getBoundSpreadsheet_() {
  try {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      active.getId();
      return active;
    }
  } catch (e) {}
  return null;
}

function getSpreadsheet_() {
  var bound = getBoundSpreadsheet_();
  if (bound) return bound;
  var raw = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var id = extractSpreadsheetId_(raw);
  if (!id) {
    throw new Error('Spreadsheet is not configured - set it via Settings menu > Set Sheet.');
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('Could not open the Google Sheet - check Settings menu > Set Sheet (must be the sheet ID). Original error: ' + (e && e.message ? e.message : e));
  }
}

// True when logging can proceed: container-bound sheet OR a valid saved ID.
// Session-gated like hasGeminiKey so config presence is only revealed logged-in.
function hasSpreadsheet(sessionToken) {
  requireSession_(sessionToken);
  try {
    if (getBoundSpreadsheet_()) return true;
    var raw = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    var id = extractSpreadsheetId_(raw);
    if (!id) return false;
    SpreadsheetApp.openById(id).getId();
    return true;
  } catch (e) {
    return false;
  }
}

// Stores the Sheet ID (or full Sheet URL) for standalone scripts. Session-gated.
function saveSpreadsheetId(sheetIdOrUrl, sessionToken) {
  requireSession_(sessionToken);
  var id = extractSpreadsheetId_(sheetIdOrUrl);
  if (!id) {
    throw new Error('Paste your Google Sheet ID or full Sheet URL first.');
  }
  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
    ss.getId();
  } catch (e) {
    throw new Error('Could not open that Google Sheet - check the ID/URL and sharing (the sheet must be visible to the deploying account).');
  }
  try {
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
  } catch (e) {
    throw new Error('Could not save Sheet ID - try again.');
  }
  return true;
}

// ---------- ENTRY POINT (serves the form) ----------

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
// ONE Gemini request handles all photos (batch) - a single hit against the
// per-day request quota. Each photo still comes back as its own transaction
// (one category per photo - discounts/fees/tax share the main category),
// with the shared note routed per photo (see buildPrompt).
// Empty array = text-only submission.
function processExpenses(images, noteText, sessionToken) {
  requireSession_(sessionToken);
  images = images || [];
  noteText = noteText || '';

  var ss = getSpreadsheet_();

  // Text-only: the note IS the source data.
  if (images.length === 0) {
    var promptText = buildPrompt(noteText, 0);
    var txn = sanitizeTransaction(callGemini(promptText, noteText, [], TRANSACTION_SCHEMA));
    var sheet = getOrCreateMonthSheet(ss, txn.transaction_date);
    appendTransactionRows(sheet, txn, '');
    return formatSummary(txn);
  }

  // Batched: single Gemini call for all photos.
  var batchPrompt = buildPrompt(noteText, images.length);
  var batchResult = callGemini(batchPrompt, '', images, BATCH_SCHEMA);
  var txns = (batchResult && batchResult.transactions) || [];
  if (!Array.isArray(txns) || txns.length === 0) {
    throw new Error('Gemini returned no transactions - nothing to log.');
  }

  var summaries = [];
  var grandTotal = 0;
  for (var i = 0; i < txns.length; i++) {
    var photoTxn = sanitizeTransaction(txns[i]);
    var photoSheet = getOrCreateMonthSheet(ss, photoTxn.transaction_date);
    // Same shared note recorded on every receipt's rows.
    appendTransactionRows(photoSheet, photoTxn, noteText);
    var photoTotal = photoTxn.items.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
    grandTotal += photoTotal;
    summaries.push('Photo ' + (i + 1) + ': ' + photoTxn.transaction_type + ' ' +
      photoTxn.merchant + ' (' + photoTxn.items.length + ' item(s), Rp' + photoTotal.toLocaleString('id-ID') + ')');
  }

  if (summaries.length === 1) return formatSummaryFromParts(summaries[0]);
  return 'Logged ' + summaries.length + ' receipts, total Rp' + grandTotal.toLocaleString('id-ID') + ' — ' + summaries.join('; ');
}

// ---------- TABLE BATCH (Tab 2: per-row note + forced type, ONE Gemini call) ----------

// rows: [{imageBase64, mimeType, note, type}] from the Table Layout tab.
// Each row is one receipt photo with its own note and forced Expense|Income.
// CRITICAL QUOTA RULE: the entire array is processed in exactly ONE single
// call to callGemini - never one call per row.
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

function processTableBatch(rows, sessionToken) {
  requireSession_(sessionToken);
  rows = rows || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Add at least one filled row (photo or note) first.');
  }
  if (rows.length > 10) {
    throw new Error('Maximum 10 rows per batch.');
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
  // Normalize. Text-only rows (note, no photo) are allowed.
  var cleanRows = nonEmpty.map(function (r) {
    r = r || {};
    var type = (r.type === 'Income') ? 'Income' : 'Expense';
    var note = String(r.note || '').slice(0, 1000);
    var data = r.imageBase64 || r.data || '';
    var mimeType = r.mimeType || 'image/jpeg';
    return { type: type, note: note, data: data, mimeType: mimeType };
  });

  // Only rows with photos contribute image parts; text-only rows are
  // described purely by the prompt. Photo order follows row order.
  var images = [];
  for (var q = 0; q < cleanRows.length; q++) {
    if (cleanRows[q].data) images.push({ data: cleanRows[q].data, mimeType: cleanRows[q].mimeType });
  }
  var prompt = buildTableBatchPrompt(cleanRows);

  // SINGLE Gemini call for the whole batch - quota protection.
  var batchResult = callGemini(prompt, '', images, BATCH_SCHEMA);
  var txns = (batchResult && batchResult.transactions) || [];
  if (!Array.isArray(txns) || txns.length === 0) {
    throw new Error('Gemini returned no transactions - nothing to log.');
  }
  if (txns.length !== cleanRows.length) {
    throw new Error('Gemini returned ' + txns.length + ' transactions for ' + cleanRows.length + ' rows - please try again.');
  }

  var ss = getSpreadsheet_();
  var summaries = [];
  var grandTotal = 0;
  for (var i = 0; i < txns.length; i++) {
    var txn = txns[i] || {};
    // Enforce the user's per-row type selection over Gemini classification.
    txn.transaction_type = cleanRows[i].type;
    txn = sanitizeTransaction(txn);
    var sheet = getOrCreateMonthSheet(ss, txn.transaction_date);
    appendTransactionRows(sheet, txn, cleanRows[i].note);
    var total = txn.items.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
    grandTotal += total;
    summaries.push('Row ' + (i + 1) + ': ' + txn.transaction_type + ' ' +
      txn.merchant + ' (' + txn.items.length + ' item(s), Rp' + total.toLocaleString('id-ID') + ')');
  }

  if (summaries.length === 1) return formatSummaryFromParts(summaries[0]);
  return 'Logged ' + summaries.length + ' rows, total Rp' + grandTotal.toLocaleString('id-ID') + ' — ' + summaries.join('; ');
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

// ---------- HERO VISIBILITY (cloud-persisted per user) ----------

// Hides/shows the left explainer panel. Stored in UserProperties so the
// choice follows the user across devices (cloud), with localStorage as an
// instant-paint fallback in the frontend.
var HERO_HIDDEN_KEY = 'HERO_HIDDEN';

function getHeroHidden() {
  try {
    var v = PropertiesService.getUserProperties().getProperty(HERO_HIDDEN_KEY);
    return v === '1';
  } catch (e) {
    return false;
  }
}

function setHeroHidden(hidden) {
  var isHidden = !!hidden;
  try {
    PropertiesService.getUserProperties().setProperty(HERO_HIDDEN_KEY, isHidden ? '1' : '0');
  } catch (e) {
    // Storage failure should not break logging; frontend keeps local copy.
  }
  return isHidden;
}

// ---------- PIN LOGIN + SESSIONS (server-side only) ----------

// The raw PIN is never returned to the client and never compared on the
// client. A correct PIN is exchanged (via login/setupPin) for a random
// session token valid for 12 hours. Sensitive calls present ONLY the session
// token, verified here on Google's backend. Tokens are stored hashed, so a
// Script Properties dump yields no usable session.
var PIN_HASH_KEY = 'PIN_HASH';
var PIN_SALT_KEY = 'PIN_SALT';
var SESSIONS_KEY = 'SESSIONS_JSON';
var PIN_FAIL_KEY = 'PIN_FAIL_JSON';
var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
var LOGIN_MAX_FAILS = 5;
var LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isValidPinFormat_(pin) {
  return /^\d{6}$/.test(String(pin || ''));
}

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function hashPin_(pin, salt) {
  return sha256Hex_(salt + ':' + String(pin));
}

function isPinSetup() {
  try {
    return !!PropertiesService.getScriptProperties().getProperty(PIN_HASH_KEY);
  } catch (e) {
    return false;
  }
}

// ---- Brute-force guard: 5 bad attempts per 10-minute window locks logins. ----
function getFailState_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(PIN_FAIL_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o.count === 'number') return o;
    }
  } catch (e) {}
  return { count: 0, windowStart: 0 };
}

function checkLoginLock_() {
  var st = getFailState_();
  var now = Date.now();
  if (st.count >= LOGIN_MAX_FAILS && (now - Number(st.windowStart || 0)) < LOGIN_WINDOW_MS) {
    throw new Error('Too many PIN attempts - try again later.');
  }
  // Window aged out: start fresh.
  if (st.count > 0 && (now - Number(st.windowStart || 0)) >= LOGIN_WINDOW_MS) {
    resetLoginFails_();
  }
}

function recordLoginFail_() {
  var st = getFailState_();
  var now = Date.now();
  if (!st.count || (now - Number(st.windowStart || 0)) >= LOGIN_WINDOW_MS) {
    st = { count: 1, windowStart: now };
  } else {
    st.count++;
  }
  try {
    PropertiesService.getScriptProperties().setProperty(PIN_FAIL_KEY, JSON.stringify(st));
  } catch (e) {}
}

function resetLoginFails_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(PIN_FAIL_KEY);
  } catch (e) {}
}

// ---- Sessions: stored as { sha256(token): expiryMs }. ----
function loadSessions_() {
  var map = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SESSIONS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed;
    }
  } catch (e) {
    map = {};
  }
  // Delete expired sessions on sight and persist the cleanup.
  var now = Date.now();
  var changed = false;
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    if (typeof map[k] !== 'number' || map[k] <= now) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) saveSessions_(map);
  return map;
}

function saveSessions_(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(SESSIONS_KEY, JSON.stringify(map || {}));
  } catch (e) {}
}

function clearAllSessions_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(SESSIONS_KEY);
  } catch (e) {}
}

// Pure PIN comparison, no side effects (callers own rate limiting).
function checkPinSilent_(pin) {
  if (!isPinSetup()) return false;
  if (!isValidPinFormat_(pin)) return false;
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty(PIN_SALT_KEY) || '';
  var expected = props.getProperty(PIN_HASH_KEY) || '';
  if (!expected) return false;
  return hashPin_(pin, salt) === expected;
}

function createSession_() {
  var map = loadSessions_(); // prunes expired first
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var expiresAt = Date.now() + SESSION_TTL_MS;
  map[sha256Hex_(token)] = expiresAt;
  saveSessions_(map);
  return { token: token, expiresAt: expiresAt };
}

// First run: create the 6-digit PIN and immediately receive a session.
function setupPin(pin) {
  if (isPinSetup()) {
    throw new Error('PIN is already set up. Use Change PIN instead.');
  }
  if (!isValidPinFormat_(pin)) {
    throw new Error('PIN must be exactly 6 digits.');
  }
  var salt = Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PIN_SALT_KEY, salt);
  props.setProperty(PIN_HASH_KEY, hashPin_(pin, salt));
  resetLoginFails_();
  return createSession_();
}

// Exchange a correct PIN for a 12h session. Wrong attempts are rate-limited.
function login(pin) {
  if (!isPinSetup()) {
    throw new Error('PIN is not set up yet.');
  }
  checkLoginLock_();
  if (!checkPinSilent_(pin)) {
    recordLoginFail_();
    throw new Error('Incorrect PIN.');
  }
  resetLoginFails_();
  return createSession_();
}

// Validate a session token. Expired entries are deleted server-side on sight.
function validateSession(token) {
  var tok = String(token || '');
  if (!tok) return { valid: false };
  var map = loadSessions_(); // prunes expired, deleting them
  var exp = map[sha256Hex_(tok)];
  if (typeof exp === 'number' && exp > Date.now()) {
    return { valid: true, expiresAt: exp };
  }
  return { valid: false };
}

function logout(token) {
  var tok = String(token || '');
  if (!tok) return true;
  var map = loadSessions_();
  var h = sha256Hex_(tok);
  if (map[h] !== undefined) {
    delete map[h];
    saveSessions_(map);
  }
  return true;
}

// Legacy boolean oracle (rate-limited). Prefer login(), which mints a session.
function verifyPin(pin) {
  if (!isPinSetup()) {
    throw new Error('PIN is not set up yet.');
  }
  checkLoginLock_();
  var ok = checkPinSilent_(pin);
  if (ok) {
    resetLoginFails_();
  } else {
    recordLoginFail_();
  }
  return ok;
}

// Requires a valid session AND the correct current PIN, then revokes EVERY
// session (including the caller's and any stolen ones) and mints one fresh
// session for the changer. The raw PIN alone is never sufficient.
function changePin(oldPin, newPin, token) {
  requireSession_(token);
  if (!checkPinSilent_(oldPin)) {
    recordLoginFail_();
    throw new Error('Current PIN is incorrect.');
  }
  if (!isValidPinFormat_(newPin)) {
    throw new Error('New PIN must be exactly 6 digits.');
  }
  if (String(oldPin) === String(newPin)) {
    throw new Error('New PIN must be different from the current PIN.');
  }
  var salt = Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PIN_SALT_KEY, salt);
  props.setProperty(PIN_HASH_KEY, hashPin_(newPin, salt));
  resetLoginFails_();
  clearAllSessions_();
  return createSession_();
}

// Gate for ALL sensitive calls. Open only before any PIN exists (first run);
// afterwards ONLY a valid, unexpired server-side session is accepted - the
// raw PIN is never accepted here, so a leaked PIN alone cannot call APIs
// without passing login (which is rate-limited).
function requireSession_(token) {
  if (!isPinSetup()) return;
  var tok = String(token || '');
  if (!tok) {
    throw new Error('Session expired - please log in again.');
  }
  var map = loadSessions_(); // prunes expired, deleting them server-side
  var exp = map[sha256Hex_(tok)];
  if (typeof exp !== 'number' || exp <= Date.now()) {
    throw new Error('Session expired - please log in again.');
  }
}

// ---------- GEMINI API KEY (session-gated, prompted after PIN) ----------

// True when a Gemini key is stored in Script Properties. Session-gated so the
// presence/absence of the key is only revealed to a logged-in client. Called
// right after PIN unlock — including when the PIN was already set — so a
// missing key always triggers the frontend prompt.
function hasGeminiKey(sessionToken) {
  requireSession_(sessionToken);
  try {
    return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  } catch (e) {
    return false;
  }
}

// Stores the user's Gemini API key (from Google AI Studio). Session-gated.
function saveGeminiKey(apiKey, sessionToken) {
  requireSession_(sessionToken);
  var k = String(apiKey || '').trim();
  if (!k) {
    throw new Error('API key cannot be empty.');
  }
  if (k.length < 10) {
    throw new Error('That API key looks too short - please paste the full key from Google AI Studio.');
  }
  if (/\s/.test(k)) {
    throw new Error('API key should not contain spaces - please paste it exactly.');
  }
  try {
    PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', k);
  } catch (e) {
    throw new Error('Could not save API key - try again.');
  }
  return true;
}

// ---------- RECENT LOGS (PIN-gated, newest first across all month sheets) ----------

// Session token verified server-side via requireSession_. Returns newest-first page.
function getRecentLogs(sessionToken, offset, limit) {
  requireSession_(sessionToken);
  offset = Math.max(0, Number(offset) || 0);
  limit = Number(limit) || 10;
  if (limit < 1) limit = 10;
  if (limit > 20) limit = 20;

  var ss = getSpreadsheet_();
  var tz = ss.getSpreadsheetTimeZone();
  var sheets = ss.getSheets();
  var all = [];

  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (sheet.getName() === TEMPLATE_SHEET_NAME) continue;
    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) continue;
    var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    function col(name) { return headers.indexOf(name); }
    var cDate = col('date'), cMerch = col('merchant'), cDesc = col('description'),
        cAmt = col('amount'), cCat = col('category'), cSpend = col('spending type'),
        cType = col('type'), cNotes = col('notes');
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var empty = true;
      for (var c = 0; c < row.length; c++) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { empty = false; break; }
      }
      if (empty) continue;
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
        notes: cNotes >= 0 ? String(row[cNotes] || '') : ''
      });
    }
  }

  all.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var total = all.length;
  var page = all.slice(offset, offset + limit).map(function (e) {
    return {
      sheet: e.sheet, date: e.date, merchant: e.merchant,
      description: e.description, amount: e.amount, category: e.category,
      spendingType: e.spendingType, type: e.type, notes: e.notes
    };
  });
  return { total: total, offset: offset, limit: limit, hasMore: (offset + limit) < total, logs: page };
}

// ---------- GEMINI (with model fallback) ----------

function callGemini(promptText, sourceText, images, schema) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key is not set - please add it when prompted.');
  }

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
        return txn;
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
    return {
      description: item.description || txn.merchant,
      amount: amount,
      category: category,
      spending_type: spendingType
    };
  });
  return txn;
}

// ---------- SHEET WRITING ----------

function getOrCreateMonthSheet(ss, transactionDateStr) {
  var date = transactionDateStr ? new Date(transactionDateStr) : new Date();
  if (isNaN(date.getTime())) date = new Date(); // fallback if Gemini gave an unparseable date

  var sheetName = Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), 'MMMM yyyy');
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    var template = ss.getSheetByName(TEMPLATE_SHEET_NAME);
    if (!template) {
      throw new Error('Template sheet "' + TEMPLATE_SHEET_NAME + '" not found - create it first.');
    }
    sheet = template.copyTo(ss);
    sheet.setName(sheetName);
    sheet.showSheet();
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(ss.getNumSheets());
  }

  return sheet;
}

function appendTransactionRows(sheet, txn, sheetNote) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIndex = {};
  headers.forEach(function (h, i) {
    colIndex[String(h).trim().toLowerCase()] = i + 1;
  });

  txn.items.forEach(function (item) {
    var rowNum = sheet.getLastRow() + 1;
    setIfColumnExists(sheet, rowNum, colIndex, 'date', txn.transaction_date);
    setIfColumnExists(sheet, rowNum, colIndex, 'merchant', txn.merchant);
    setIfColumnExists(sheet, rowNum, colIndex, 'description', item.description);
    setIfColumnExists(sheet, rowNum, colIndex, 'amount', item.amount);
    setIfColumnExists(sheet, rowNum, colIndex, 'category', item.category);
    setIfColumnExists(sheet, rowNum, colIndex, 'spending type', item.spending_type || '');
    setIfColumnExists(sheet, rowNum, colIndex, 'type', txn.transaction_type);
    setIfColumnExists(sheet, rowNum, colIndex, 'notes', sheetNote || '');
  });
}

function setIfColumnExists(sheet, row, colIndex, headerKey, value) {
  var col = colIndex[headerKey];
  if (col) sheet.getRange(row, col).setValue(value);
}