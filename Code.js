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
 * 2. Template sheet "Template" is created automatically on first log if missing,
 *    with header row:
 *      Date | Description | Amount | Category | Spending Type | Type | Merchant | Notes
 *    It is then hidden — copyTo() still works on hidden sheets. Monthly sheets
 *    are copied from it, so keep its formatting.
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
  'gemini-flash-lite-latest', // top priority - tested 11/11 accurate, fastest
  'gemini-3.5-flash',         // fallback
  'gemini-3.6-flash'          // last fallback (often overloaded - 503s)
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

// Batch wrapper: one Gemini request for one batch returns N transactions in
// order. Each batch is one hit against the per-day request quota; large
// submissions run sequential phased batches (see the pipeline below).
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

// ---------- TWO-PHASE RECEIPT PIPELINE (shared core) ----------

// Shared instruction fragment for every receipt task prompt. Phase prompts
// add a short task block on top of this instead of duplicating the rules.
var PROMPT_CORE =
  'You are extracting structured cashflow data (expense or income) from receipt images, ' +
  'invoices, proofs of transfer, payslips, or a text message describing money spent or money received. ' +
  'Amounts are in Indonesian Rupiah as plain numbers (no "Rp", dots, or commas). If the receipt currency ' +
  'is clearly not IDR or the conversion basis is unclear, say so in notes/flags rather than comparing raw numbers. ' +
  'For EXPENSE items: classify each into exactly one category and exactly one spending type ' +
  '(Need, Want, Work, or Investment) - never invent a category or spending type not in the list. ' +
  'For INCOME items: set category to "Income" (unless savings interest or investment returns, which may use ' +
  '"Investment / Savings"), keep regular income amounts positive, record discount/deduction lines ' +
  '(diskon, potongan, voucher, promo, cashback, withheld fees) as negative amounts, and OMIT spending_type entirely. ' +
  'ACCOUNTING RULES - follow exactly: transcribe only additive charge and deduction lines ' +
  '(items with quantities/line totals, tax, service charge, delivery/platform fee, bag fee, tip, rounding, ' +
  'genuine discounts/deductions as NEGATIVE amounts). Intermediate subtotals are checkpoints, never additional ' +
  'charges - do NOT add a subtotal to the underlying item prices. Never count informational values as charges: ' +
  'subtotal lines, original crossed-out prices, savings displays, amount tendered, change returned, loyalty points, ' +
  'future cashback, prior balances, or payment-summary duplicates. Distinguish unit price from extended line total ' +
  '(quantity x unit). Do not extract the same fee/discount twice when it appears in multiple sections. ' +
  'Never invent an item, price, discount, or balancing adjustment. If the visible line list looks incomplete, ' +
  'cropped, or illegible, flag it instead of guessing.';

// ---------- Model budget profiles (documented, conservative) ----------
//
// Verified 2026-10-11 against official Gemini docs: gemini-3.6-flash =
// 1,048,576 input / 65,536 output tokens; per-item media_resolution is an
// Interactions-API-only feature (Gemini 3), NOT available on the v1beta
// generateContent + inline_data path this app uses - so no resolution flag
// is hard-coded here (default image tokenisation applies; blurry photos are
// still flagged by the model). Other profiles below are conservative
// engineering estimates, NOT official figures. The planner always budgets
// against the SMALLEST profile in the fallback chain so any model fits.
var MODEL_PROFILES = {
  'gemini-flash-lite-latest': { maxInputTokens: 500000, maxOutputTokens: 32000, label: 'flash-lite' },
  'gemini-3.5-flash':         { maxInputTokens: 500000, maxOutputTokens: 32000, label: 'flash-3.5' },
  'gemini-3.6-flash':         { maxInputTokens: 1048576, maxOutputTokens: 65536, label: 'flash-3.6' }
};
var DEFAULT_MODEL_PROFILE = { maxInputTokens: 200000, maxOutputTokens: 16000, label: 'unknown-conservative' };

function modelProfile_(name) {
  var p = MODEL_PROFILES[name];
  if (p) return p;
  return DEFAULT_MODEL_PROFILE;
}
function chainBudget_() {
  var inTok = Infinity, outTok = Infinity;
  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    var p = modelProfile_(GEMINI_MODELS[i]);
    if (p.maxInputTokens < inTok) inTok = p.maxInputTokens;
    if (p.maxOutputTokens < outTok) outTok = p.maxOutputTokens;
  }
  return { maxInputTokens: inTok, maxOutputTokens: outTok };
}

// Conservative batch-planning budgets. These are engineering safety margins,
// not official vendor limits (verified 2026-10-12 from the official Apps
// Script quotas page: script runtime 6 min/execution, UrlFetch POST 50 MB;
// google.script.run / UrlFetch payloads are kept far below any ceiling).
var BATCH_LIMITS = {
  maxPhotosPerBatch: 12,
  maxRowsPerBatch: 25,
  maxPayloadBytes: 10 * 1024 * 1024,
  inputTokenMargin: 0.25,    // use at most 25% of smallest chain input budget
  outputTokenMargin: 0.5,    // use at most 50% of smallest chain output budget
  noteCharsPerToken: 4,
  photoTokens: 1500,         // conservative image estimate; NOT derived from byte size
  rowOverheadTokens: 400,    // per-row framing + manifest share
  fixedOverheadTokens: 8000, // core prompt + schema + task framing
  manifestTokensPerPhoto: 150,
  outputTokensPerPhotoRow: 2000,
  outputTokensPerTextRow: 1200
};

// Rolling token-usage feedback (Script Properties, operational only).
var USAGE_STATS_KEY = 'CF_USAGE_JSON';
function getUsageFactors_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(USAGE_STATS_KEY);
    if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') return o; }
  } catch (e) {}
  return {};
}
function updateUsageFactors_(usageList) {
  try {
    var st = getUsageFactors_();
    var n = Number(st.samples || 0), sum = Number(st.photoTokenSum || 0), c = 0;
    for (var i = 0; i < (usageList || []).length; i++) {
      var u = usageList[i] || {};
      if (u.photoCount > 0 && u.inputTokens > 0) { sum += u.inputTokens / u.photoCount; c++; }
    }
    if (!c) return;
    st.samples = n + c; st.photoTokenSum = sum;
    st.avgPhotoTokens = Math.round(sum / (n + c));
    PropertiesService.getScriptProperties().setProperty(USAGE_STATS_KEY, JSON.stringify(st));
  } catch (e) {}
}
function effectivePhotoTokens_() {
  var st = getUsageFactors_();
  var obs = Number(st.avgPhotoTokens || 0);
  // Only ever raise the estimate from observed data, never relax it.
  return obs > BATCH_LIMITS.photoTokens ? obs : BATCH_LIMITS.photoTokens;
}

// Adaptive batch planner (pure: no services, fully unit-testable).
// rowsMeta: [{row_id, origNum, note, type, hasPhoto, imageBytes}]
// Returns {batches: [{rows: [rowMeta...], estInputTokens, estOutputTokens, estPayloadBytes, photoCount}], totals}
// Splits on token/payload/runtime estimates, never on fixed row counts.
function planReceiptBatches_(rowsMeta, opt) {
  opt = opt || {};
  var budget = chainBudget_();
  var inCap = Math.floor(budget.maxInputTokens * BATCH_LIMITS.inputTokenMargin);
  var outCap = Math.floor(budget.maxOutputTokens * BATCH_LIMITS.outputTokenMargin);
  var photoTok = opt.photoTokens || effectivePhotoTokens_();
  var maxPhotos = opt.maxPhotosPerBatch || BATCH_LIMITS.maxPhotosPerBatch;
  var maxRows = opt.maxRowsPerBatch || BATCH_LIMITS.maxRowsPerBatch;
  var maxBytes = opt.maxPayloadBytes || BATCH_LIMITS.maxPayloadBytes;
  var batches = [];
  var cur = null;
  function fresh() {
    return { rows: [], inTok: BATCH_LIMITS.fixedOverheadTokens, outTok: 0, bytes: 0, photos: 0 };
  }
  function fits(b, m) {
    var noteTok = Math.ceil(String(m.note || '').length / BATCH_LIMITS.noteCharsPerToken);
    var addIn = BATCH_LIMITS.rowOverheadTokens + noteTok + (m.hasPhoto ? photoTok + BATCH_LIMITS.manifestTokensPerPhoto : 0);
    var addOut = m.hasPhoto ? BATCH_LIMITS.outputTokensPerPhotoRow : BATCH_LIMITS.outputTokensPerTextRow;
    if (b.rows.length + 1 > maxRows) return false;
    if (b.photos + (m.hasPhoto ? 1 : 0) > maxPhotos) return false;
    if (b.bytes + (Number(m.imageBytes || 0)) > maxBytes) return false;
    if (b.inTok + addIn > inCap) return false;
    if (b.outTok + addOut > outCap) return false;
    return true;
  }
  function push(b, m) {
    var noteTok = Math.ceil(String(m.note || '').length / BATCH_LIMITS.noteCharsPerToken);
    b.rows.push(m);
    b.inTok += BATCH_LIMITS.rowOverheadTokens + noteTok + (m.hasPhoto ? photoTok + BATCH_LIMITS.manifestTokensPerPhoto : 0);
    b.outTok += m.hasPhoto ? BATCH_LIMITS.outputTokensPerPhotoRow : BATCH_LIMITS.outputTokensPerTextRow;
    b.bytes += Number(m.imageBytes || 0);
    if (m.hasPhoto) b.photos++;
  }
  for (var i = 0; i < rowsMeta.length; i++) {
    var m = rowsMeta[i];
    if (!cur) cur = fresh();
    if (cur.rows.length > 0 && !fits(cur, m)) {
      batches.push(cur);
      cur = fresh();
    }
    push(cur, m);
  }
  if (cur && cur.rows.length) batches.push(cur);
  return {
    batches: batches.map(function (b, bi) {
      return {
        batch_id: bi,
        photoCount: b.photos,
        rowCount: b.rows.length,
        estInputTokens: b.inTok,
        estOutputTokens: b.outTok,
        estPayloadBytes: b.bytes,
        rows: b.rows.map(function (m) {
          return { row_id: m.row_id, origNum: m.origNum, note: m.note, type: m.type,
                   hasPhoto: !!m.hasPhoto, imageBytes: Number(m.imageBytes || 0) };
        })
      };
    }),
    totals: { rows: rowsMeta.length, photos: rowsMeta.filter(function (m) { return m.hasPhoto; }).length }
  };
}

// ---------- Phase schemas (row-identified, status-flagged) ----------

var PHASE1_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      description: 'One result per input photo, in any order (matched by row_id).',
      items: {
        type: 'OBJECT',
        properties: {
          row_id: { type: 'STRING', description: 'Stable input row identifier, copied exactly.' },
          photo_index: { type: 'NUMBER', description: '1-based input photo number.' },
          total_amount: { type: 'NUMBER', description: 'Printed final total in IDR, plain integer. 0 when not reliably readable.' },
          total_label: { type: 'STRING', description: 'Printed label found (e.g. TOTAL BAYAR), empty if none.' },
          total_status: { type: 'STRING', enum: ['found', 'uncertain', 'not_visible'],
            description: 'found = clearly readable final total; uncertain = ambiguous/blurry; not_visible = total area missing.' },
          image_quality: { type: 'STRING', enum: ['clear', 'blurry', 'partially_obscured', 'incomplete'] },
          review_reason: { type: 'STRING', description: 'Concise reason when uncertain or unusable, else empty.' }
        },
        required: ['row_id', 'photo_index', 'total_amount', 'total_status', 'image_quality']
      }
    }
  },
  required: ['results']
};

var PHASE2_TXN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    row_id: { type: 'STRING', description: 'Stable input row identifier, copied exactly.' },
    transaction_date: { type: 'STRING', description: 'YYYY-MM-DD, or today date given in prompt when unclear.' },
    merchant: { type: 'STRING', description: 'Store, payee, or income source.' },
    transaction_type: {
      type: 'STRING', enum: ['Expense', 'Income'],
      description: 'Income for money in, Expense for money out. Caller may override per row.'
    },
    line_list_complete: { type: 'STRING', enum: ['complete', 'possibly_incomplete', 'illegible'],
      description: 'Whether every visible charged line was transcribed.' },
    extraction_notes: { type: 'STRING', description: 'Concise flags (hidden items, duplicates avoided, ambiguous lines), else empty.' },
    items: TRANSACTION_SCHEMA.properties.items
  },
  required: ['row_id', 'transaction_date', 'merchant', 'transaction_type', 'line_list_complete', 'items']
};

var PHASE2_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transactions: {
      type: 'ARRAY',
      description: 'Exactly one transaction per input row, matched by row_id (order not trusted).',
      items: PHASE2_TXN_SCHEMA
    }
  },
  required: ['transactions']
};

// ---------- Phase task prompts (short; rules live in PROMPT_CORE) ----------

function buildPhase1Prompt(rows) {
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var base =
    'TASK: For each attached receipt photo, report ONLY its printed final payable/charged total. ' +
    'Today is ' + todayStr + '. Do not extract items, categories, or dates. Do not sum visible items. ' +
    'Final-total labels include TOTAL, TOTAL BAYAR, GRAND TOTAL, AMOUNT PAID, TOTAL PAYMENT and local equivalents. ' +
    'Ignore subtotal, pre-discount/original amounts, amount tendered, change returned, savings displays, loyalty ' +
    'points, future cashback, prior balances, and unrelated amounts. If several totals look plausible, mark ' +
    'total_status "uncertain" and explain in review_reason. Never guess: blurry, cropped, obscured, or missing ' +
    'total areas get total_status "uncertain" or "not_visible" with total_amount 0 and a review_reason. ' +
    'Return one result per photo. Photos in order: ';
  for (var i = 0; i < rows.length; i++) {
    base += 'Photo ' + (i + 1) + ' = row_id "' + rows[i].row_id + '". ';
  }
  return base;
}

function buildPhase2Prompt(rows) {
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var base = PROMPT_CORE +
    ' Today\'s date is ' + todayStr + '. Missing/unclear dates fall back to today (' + todayStr + ') in YYYY-MM-DD. ' +
    'TASK: Return exactly one transaction per input row below, each carrying its row_id. ' +
    'Text-only rows (no photo): build the transaction from the note; no printed total exists. ' +
    'Photo rows: transcribe every visible charged line for that photo; the EXPECTED TOTAL shown is a validation ' +
    'target only - never invent a balancing line, item, price, or discount to reach it. If the receipt shows a ' +
    'single final total with no itemized breakdown, use one clearly described receipt-level line; do NOT use that ' +
    'fallback when an item list is visible but partly hidden, cropped, or unreadable - flag possibly_incomplete instead. ' +
    'Rows: ';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var forced = (r.forcedType === 'Income') ? 'Income' : ((r.forcedType === 'Expense') ? 'Expense' : null);
    base += 'Row "' + r.row_id + '"' + (r.hasPhoto ? ' (Photo ' + r.photoNo + ')' : ' (text-only, no photo)') +
      ': transaction_type MUST be "' + (forced || 'as classified') + '"' +
      (r.note ? ' with note context: "' + String(r.note).slice(0, 500) + '"' : ' (no note)') +
      (r.hasPhoto && r.phase1 ? ' EXPECTED TOTAL ' + r.phase1.total_amount + ' (status ' + r.phase1.total_status + ').' : '. ');
  }
  return base;
}

function buildRepairPrompt(rows) {
  var base = PROMPT_CORE +
    'TASK: REPAIR PASS. Each row below was already extracted once but its signed item sum does not match the ' +
    'printed EXPECTED TOTAL. Re-examine the SAME photo carefully for: hidden/missed fees, items, taxes, or discounts; ' +
    'wrong digits or signs; quantity x unit-price mistakes; the same line extracted twice; subtotal mistaken for an ' +
    'item. The difference shown is (expected - calculated). It is FORBIDDEN to invent a balancing amount, item, ' +
    'price, or discount to force a match - return only lines actually visible, or flag possibly_incomplete/illegible. ' +
    'Rows: ';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    base += 'Row "' + r.row_id + '" (Photo ' + r.photoNo + '): EXPECTED TOTAL ' + r.expectedTotal +
      ', previously calculated ' + r.calculatedTotal + ' (difference ' + r.difference + ')' +
      (r.note ? ' note: "' + String(r.note).slice(0, 300) + '"' : '') + '. ';
  }
  return base;
}

// photoCount: 0 = text-only, 1 = single receipt photo, >1 = batched
// multi-photo submission. Legacy single-shot builder (kept for the
// text-only path and compatibility); phased photo flows use the builders above.
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
// Image receipts run the same two-phase reconcile/commit pipeline as Table
// rows (Phase 1 totals, Phase 2 lines, one repair, toggle policy); text-only
// submissions keep the direct path. opts: {forceLog, autoDiscount} (both off
// by default). Returns the classic summary string; throws when nothing could
// be logged. Kept for backward compatibility - the web UI drives the phased
// ops directly for large submissions.
function processExpenses(images, noteText, sessionToken, opts) {
  requireSession_(sessionToken);
  images = images || [];
  noteText = noteText || '';
  var toggles = { forceLog: !!(opts && opts.forceLog), autoDiscount: !!(opts && opts.autoDiscount) };
  var submissionId = Utilities.getUuid();

  // Text-only: the note IS the source data (no Phase 1, no invented total).
  if (images.length === 0) {
    var promptText = buildPrompt(noteText, 0);
    var txn = sanitizeTransaction(callGemini_(promptText, noteText, [], TRANSACTION_SCHEMA));
    var report = commitReceiptRows({ submission_id: submissionId, forceLog: toggles.forceLog, autoDiscount: toggles.autoDiscount },
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
  return commitReceiptRows({ submission_id: submissionId, forceLog: toggles.forceLog,
    autoDiscount: toggles.autoDiscount }, finals, sessionToken);
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
  var toggles = { forceLog: !!(opts && opts.forceLog), autoDiscount: !!(opts && opts.autoDiscount) };
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
// session token valid for the globally configured duration. Sensitive calls
// present ONLY the session token, verified here on Google's backend. Tokens
// are stored hashed, so a Script Properties dump yields no usable session.
var PIN_HASH_KEY = 'PIN_HASH';
var PIN_SALT_KEY = 'PIN_SALT';
var SESSIONS_KEY = 'SESSIONS_JSON';
var PIN_FAIL_KEY = 'PIN_FAIL_JSON';
// Global session policy (shared by every web-app user). Duration choices are
// whole hours from 1 to 168; activity renewal defaults ON.
var SESSION_CONFIG_KEY = 'SESSION_CONFIG_JSON';
var SESSION_TTL_DEFAULT_HOURS = 3;
var SESSION_TTL_MIN_HOURS = 1;
var SESSION_TTL_MAX_HOURS = 168;
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

function loadSessions_() {  var map = {};
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

// ---- Global session policy: validated TTL + activity-renewal toggle,
// shared by every web-app user. Invalid or absent stored values fall back
// to the defaults; individual fields degrade independently.
function readSessionConfig_() {
  var cfg = { ttlHours: SESSION_TTL_DEFAULT_HOURS, refreshOnActivity: true };
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(SESSION_CONFIG_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        var h = Number(o.ttlHours);
        if (isFinite(h) && Math.floor(h) === h && h >= SESSION_TTL_MIN_HOURS && h <= SESSION_TTL_MAX_HOURS) cfg.ttlHours = h;
        if (typeof o.refreshOnActivity === 'boolean') cfg.refreshOnActivity = o.refreshOnActivity;
      }
    }
  } catch (e) {}
  return cfg;
}

function sessionTtlMs_() {
  return readSessionConfig_().ttlHours * 60 * 60 * 1000;
}

// Serializes session-map writes so overlapping logins, renewals, and
// logouts cannot silently drop each other's entries.
function withSessionWriteLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (e) { throw new Error('Session storage is busy - try again in a few seconds.'); }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e) {} }
}

// Session-gated: change the global session policy. Affects only sessions
// minted afterwards; existing sessions keep their recorded expiry.
function setSessionConfig(sessionToken, ttlHours, refreshOnActivity) {
  requireSession_(sessionToken);
  var n = Number(ttlHours);
  if (!isFinite(n) || Math.floor(n) !== n || n < SESSION_TTL_MIN_HOURS || n > SESSION_TTL_MAX_HOURS) {
    throw new Error('Session duration must be a whole number of hours from 1 to 168.');
  }
  if (typeof refreshOnActivity !== 'boolean') {
    throw new Error('Activity-renewal preference must be true or false.');
  }
  var cfg = { ttlHours: n, refreshOnActivity: refreshOnActivity };
  withSessionWriteLock_(function () {
    PropertiesService.getScriptProperties().setProperty(SESSION_CONFIG_KEY, JSON.stringify(cfg));
  });
  return cfg;
}

// Session-gated activity renewal. Extends only the caller's own session to a
// fresh TTL when renewal is enabled; otherwise returns the fixed expiry
// untouched. Never resurrects expired or unknown sessions.
function touchSession(sessionToken) {
  requireSession_(sessionToken);
  var tok = String(sessionToken || '');
  var cfg = readSessionConfig_();
  if (!cfg.refreshOnActivity) {
    var map = loadSessions_();
    return { valid: true, expiresAt: map[sha256Hex_(tok)] };
  }
  return withSessionWriteLock_(function () {
    var live = loadSessions_();
    if (typeof live[sha256Hex_(tok)] !== 'number' || live[sha256Hex_(tok)] <= Date.now()) {
      throw new Error('Session expired - please log in again.');
    }
    var expiresAt = Date.now() + cfg.ttlHours * 60 * 60 * 1000;
    live[sha256Hex_(tok)] = expiresAt;
    saveSessions_(live);
    return { valid: true, expiresAt: expiresAt };
  });
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
  var ttlMs = sessionTtlMs_();
  return withSessionWriteLock_(function () {
    var map = loadSessions_(); // prunes expired first
    var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    var expiresAt = Date.now() + ttlMs;
    map[sha256Hex_(token)] = expiresAt;
    saveSessions_(map);
    return { token: token, expiresAt: expiresAt };
  });
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

// Exchange a correct PIN for a session valid for the configured duration.
// Wrong attempts are rate-limited.
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
// Valid responses also carry the global session policy so the client can
// paint countdowns and renewal UI without an extra call.
function validateSession(token) {
  var tok = String(token || '');
  if (!tok) return { valid: false };
  var map = loadSessions_(); // prunes expired, deleting them
  var exp = map[sha256Hex_(tok)];
  if (typeof exp === 'number' && exp > Date.now()) {
    var cfg = readSessionConfig_();
    return { valid: true, expiresAt: exp, ttlHours: cfg.ttlHours, refreshOnActivity: cfg.refreshOnActivity };
  }
  return { valid: false };
}

function logout(token) {
  var tok = String(token || '');
  if (!tok) return true;
  withSessionWriteLock_(function () {
    var map = loadSessions_();
    var h = sha256Hex_(tok);
    if (map[h] !== undefined) {
      delete map[h];
      saveSessions_(map);
    }
  });
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
    if (sheet.getName() === LEDGER_SHEET_NAME || sheet.getName().indexOf('_CF_') === 0) continue;
    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) continue;
    var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    function col(name) { return headers.indexOf(name); }
    var cDate = col('date'), cMerch = col('merchant'), cDesc = col('description'),
        cAmt = col('amount'), cCat = col('category'), cSpend = col('spending type'),
        cType = col('type'), cNotes = col('notes'), cTxnId = col('transaction id'),
        cEntryId = col('entry id');
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
        notes: cNotes >= 0 ? String(row[cNotes] || '') : '',
        transactionId: cTxnId >= 0 ? String(row[cTxnId] || '') : '',
        entryId: cEntryId >= 0 ? String(row[cEntryId] || '') : ''
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
      transactionId: e.transactionId || '', entryId: e.entryId || ''
    };
  });
  return { total: total, offset: offset, limit: limit, hasMore: (offset + limit) < total, logs: page };
}

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
    return {
      description: item.description || txn.merchant,
      amount: amount,
      category: category,
      spending_type: spendingType
    };
  });
  return txn;
}

// ---------- RECONCILIATION + TOGGLE POLICY (pure, unit-testable) ----------

function idr_(n) {
  try { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }
  catch (e) { return 'Rp' + n; }
}

// Server-side row verdict. Never trusts batch totals - strictly per row.
// verdicts: ok | mismatch | uncertain | not_applicable | invalid
function reconcileRow_(phase1, txn, opts) {
  opts = opts || {};
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
    return { verdict: 'uncertain', expectedTotal: expected, calculatedTotal: calc, difference: 0,
             message: 'Totals match (' + idr_(expected) + ') but the line list may be incomplete' +
               (flags ? ': ' + flags : '.') + ' Expand the item list and verify before logging.' };
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

// Applies Force Log / Auto-discount AFTER the bounded repair attempt.
// Only ever synthesizes for verdict 'mismatch' with a reliable (found)
// Phase 1 total - never for uncertain/unreadable totals, invalid rows, or
// text-only rows. Returns {txn, applied, note} with applied in
// none|force-item|force-discount|auto-discount.
function applyTogglePolicy_(txn, rec, toggles) {
  toggles = toggles || {};
  var forceLog = !!toggles.forceLog;
  var autoDiscount = !!toggles.autoDiscount && !forceLog; // Force ON disables discount
  if (!rec || rec.verdict !== 'mismatch') return { txn: txn, applied: 'none', note: '' };
  var diff = rec.difference;
  if (!isFinite(diff) || diff === 0) return { txn: txn, applied: 'none', note: '' };
  var isIncome = txn.transaction_type === 'Income';
  var complete = String(txn.line_list_complete || 'complete') === 'complete';

  function syntheticLine_(name, amount) {
    return {
      description: name,
      amount: amount,
      category: dominantCategory_(txn),
      spending_type: isIncome ? '' : dominantSpendingType_(txn)
    };
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
  // Auto-discount: over-total AND materially complete extraction only.
  if (autoDiscount && diff < 0 && complete) {
    var out2 = JSON.parse(JSON.stringify(txn));
    out2.items.push(syntheticLine_('Missing/hidden discount', diff));
    return { txn: out2, applied: 'auto-discount',
             note: 'AUTO DISCOUNT: synthetic missing/hidden discount of ' + idr_(diff) + '; verify receipt.' };
  }
  return { txn: txn, applied: 'none', note: '' };
}

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
    var rec = reconcileRow_(it.phase1 || null, txn, { hasPhoto: !!it.hasPhoto });
    if (rec.verdict === 'ok' || rec.verdict === 'not_applicable') {
      return { row_id: rowId, origNum: origNum, txn: txn, rec: rec, status: 'verified',
               message: '', repairEligible: false };
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
  var toggles = { forceLog: !!submission.forceLog, autoDiscount: !!submission.autoDiscount };
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
  var toggles = { forceLog: !!submission.forceLog, autoDiscount: !!submission.autoDiscount };
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
      if (t.status === 'verified') {
        staged.push({ final: it, txn: t.txn, triage: t, status: 'logged', message: '' });
        allocDates.push(t.txn.transaction_date);
      } else if (t.status === 'mismatch') {
        var pol = applyTogglePolicy_(t.txn, t.rec, toggles);
        if (pol.applied === 'none') {
          rowsOut.push({ row_id: t.row_id, origNum: t.origNum, status: 'review', transactionId: '',
            message: t.message });
        } else {
          var st = pol.applied === 'force-item' || pol.applied === 'force-discount' ? 'force-adjusted' : 'auto-discount-adjusted';
          staged.push({ final: it, txn: pol.txn, triage: t, status: st, message: pol.note });
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
      var total = appendTxn.items.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
      ledgerEntries.push({ submissionId: submissionId, rowId: st2.final.row_id,
        transactionId: txnId, status: st2.status });
      rowsOut.push({ row_id: st2.final.row_id, origNum: st2.final.origNum, status: st2.status,
        transactionId: txnId, type: st2.txn.transaction_type, merchant: st2.txn.merchant,
        itemCount: appendTxn.items.length, total: total,
        message: st2.status === 'logged' ? '' : st2.message });
    }
    ledgerWrite_(ss, ledgerEntries);

    var summary = { logged: 0, forceAdjusted: 0, discountAdjusted: 0, review: 0, errors: 0, duplicates: 0 };
    for (var r = 0; r < rowsOut.length; r++) {
      var st3 = rowsOut[r].status;
      if (st3 === 'logged') summary.logged++;
      else if (st3 === 'force-adjusted') summary.forceAdjusted++;
      else if (st3 === 'auto-discount-adjusted') summary.discountAdjusted++;
      else if (st3 === 'review') summary.review++;
      else if (st3 === 'error') summary.errors++;
      if (rowsOut[r].duplicate) summary.duplicates++;
    }
    return { rows: rowsOut, summary: summary,
             sortEligible: (summary.review === 0 && summary.errors === 0) };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Condenses one reconciled receipt into a single spreadsheet row for
// one-row-per-receipt mode. Amount is the verified signed total; the full
// item list (including any balancing adjustment, negatives preserved) moves
// into the notes summary. Nothing is fabricated: without a title the
// description falls back to merchant plus item count. IDs, dates, and types
// pass through untouched.
function condenseTxn_(txn) {
  var items = (txn && txn.items) || [];
  var total = Math.round(items.reduce(function (s, it) { return s + Number(it.amount || 0); }, 0));
  var desc = items.length === 1
    ? String(items[0].description || txn.merchant || 'Unknown')
    : String(txn.merchant || 'Unknown') + ' (' + items.length + ' items)';
  var lines = items.map(function (it) {
    return '- ' + String(it.description || '') + ': ' + idr_(Number(it.amount || 0));
  });
  var isIncome = txn.transaction_type === 'Income';
  return {
    txn: {
      transaction_date: txn.transaction_date,
      merchant: txn.merchant,
      transaction_type: txn.transaction_type,
      line_list_complete: txn.line_list_complete,
      extraction_notes: txn.extraction_notes,
      transactionId: txn.transactionId,
      items: [{
        description: desc,
        amount: total,
        category: dominantCategory_(txn),
        spending_type: isIncome ? '' : dominantSpendingType_(txn)
      }]
    },
    itemLines: lines.join('\n')
  };
}

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
    return { sheets: sortedSheets, rowsMoved: rowsMoved };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}