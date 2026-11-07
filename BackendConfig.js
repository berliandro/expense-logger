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
    receipt_title: { type: 'STRING', description: 'OPTIONAL. The receipt\'s own printed title/header (e.g. "STRUK PEMBELIAN", store receipt name) when one is clearly legible. OMIT when there is none. Never invent or paraphrase one.' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          amount: { type: 'NUMBER', description: 'In IDR, plain number, no symbol or separators. Regular charges are positive. Discounts, deductions, rebates, voucher/promo cuts, cashback applied as a deduction (diskon, potongan, pengurangan) MUST be negative numbers. Income amounts are normally positive, but discount/deduction lines (diskon, potongan, voucher, promo, cashback, withheld fees) MUST be negative like expenses.' },
          quantity: { type: 'NUMBER', description: 'OPTIONAL. Count of this line as printed (e.g. "2" for 2 pcs, "0.5" kg). OMIT when no count is shown or it is not reliably readable. Never derive it by dividing prices.' },
          unit_price: { type: 'NUMBER', description: 'OPTIONAL. Price of ONE unit as printed, distinct from the extended line total. OMIT when not printed or not reliably readable. Never derive it by dividing.' },
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
    receipt_title: { type: 'STRING', description: 'OPTIONAL. The receipt\'s own printed title when clearly legible; omit when there is none. Never invent one.' },
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
    'Also return, ONLY when they are clearly printed: the receipt\'s own title in receipt_title, and per item the ' +
    'printed count in quantity and the printed price of one unit in unit_price. Omit any of these when they are not ' +
    'legible; never derive a unit price by dividing and never infer a count. ' +
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
    'Keep quantity and unit_price only when printed and legible; never derive them. ' +
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
// A short script-cache entry avoids re-opening the spreadsheet on every unlock;
// saveSpreadsheetId clears it so a changed Sheet is re-verified immediately.
var HAS_SHEET_CACHE_KEY = 'CF_HAS_SHEET_V1';
function hasSpreadsheet(sessionToken) {
  requireSession_(sessionToken);
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(HAS_SHEET_CACHE_KEY);
    if (hit === '1') return true;
    if (hit === '0') return false;
  } catch (e) {}
  var ok = false;
  try {
    if (getBoundSpreadsheet_()) ok = true;
    else {
      var raw = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      var id = extractSpreadsheetId_(raw);
      if (id) { SpreadsheetApp.openById(id).getId(); ok = true; }
    }
  } catch (e2) {
    ok = false;
  }
  try { CacheService.getScriptCache().put(HAS_SHEET_CACHE_KEY, ok ? '1' : '0', 300); } catch (e3) {}
  return ok;
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
  try { CacheService.getScriptCache().remove(HAS_SHEET_CACHE_KEY); } catch (e2) {}
  bumpHistoryCacheVersion_();
  return true;
}
