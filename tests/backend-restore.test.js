'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'BackendFeatures.js'), 'utf8');

function grab(name) {
  const m = source.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(m, 'extract ' + name);
  return m[0];
}

class FakeSheet {
  constructor(name, headers, rows) {
    this.name = name;
    this.headers = headers.slice();
    this.rows = (rows || []).map((r) => r.slice());
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length + 1; }
  getLastColumn() { return this.headers.length; }
  deleteRow(n) { this.rows.splice(n - 2, 1); }
  appendRow(row) {
    while (this.rows.length < this.getLastRow() - 1) this.rows.push([]);
    this.rows.push(row.slice());
  }
  getRange(row, col, numRows, numCols) {
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let r = row; r < row + numRows; r++) {
          const line = [];
          for (let c = col; c < col + numCols; c++) {
            if (r === 1) line.push(self.headers[c - 1] === undefined ? '' : self.headers[c - 1]);
            else line.push(self.rows[r - 2] && self.rows[r - 2][c - 1] !== undefined ? self.rows[r - 2][c - 1] : '');
          }
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        for (let i = 0; i < values.length; i++) {
          const r = row + i;
          if (r === 1) {
            for (let c = 0; c < values[i].length; c++) self.headers[col - 1 + c] = values[i][c];
          } else {
            while (self.rows.length < r - 1) self.rows.push([]);
            for (let c = 0; c < values[i].length; c++) self.rows[r - 2][col - 1 + c] = values[i][c];
          }
        }
      }
    };
  }
}

class FakeSS {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  getSheets() { return this.sheets; }
  insertSheet(name) {
    const sh = new FakeSheet(name, [], []);
    this.sheets.push(sh);
    return sh;
  }
}

const household = new FakeSheet('_CF_Household', ['Member ID', 'Name', 'Active', 'Created At'], []);
const budgets = new FakeSheet('_CF_Budgets', ['Category', 'Monthly Limit', 'Updated At'], []);
const ledger = new FakeSheet('_CF_Submissions', ['Submission ID', 'Row ID', 'Transaction ID', 'Status', 'Updated At'], []);
const month = new FakeSheet('November 2026', ['Date', 'Description', 'Amount', 'Category', 'Type', 'Merchant', 'Transaction ID', 'Entry ID'], []);
const ss = new FakeSS([household, budgets, ledger, month]);

const ctx = {
  CF_BUDGET_SHEET: '_CF_Budgets',
  CF_RECURRING_SHEET: '_CF_Recurring',
  CF_HOUSEHOLD_SHEET: '_CF_Household',
  CF_HASH_SHEET: '_CF_ReceiptHashes',
  CF_IMAGE_SHEET: '_CF_ReceiptImages',
  LEDGER_SHEET_NAME: '_CF_Submissions',
  TRASH_SHEET_NAME: '_CF_Trash',
  TEMPLATE_SHEET_NAME: 'Template',
  requireSession_: () => {},
  getSpreadsheet_: () => ss,
  cfEnsureFeatureSchema_: () => true,
  bumpHistoryCacheVersion_: () => {},
  normHeader_: (s) => String(s == null ? '' : s).trim().toLowerCase(),
  isMonthSheetName_: (name) => /^[A-Z][a-z]+ \d{4}$/.test(String(name || ''))
};
vm.runInNewContext(
  grab('cfFeatureSheetData_') + '\n' + grab('cfValue_') + '\n' + grab('cfImportBackup_') +
  '\nthis.import = cfImportBackup_;', ctx
);

const backup = {
  version: 1,
  sheets: {
    _CF_Household: { headers: ['Member ID', 'Name', 'Active', 'Created At'], rows: [['TEST-HH', 'Disposable', 'Yes', '2026-01-01']] },
    _CF_Budgets: { headers: ['Category', 'Monthly Limit', 'Updated At'], rows: [['Test Budget', 1000, '2026-01-01']] },
    _CF_Submissions: { headers: ['Submission ID', 'Row ID', 'Transaction ID', 'Status', 'Updated At'], rows: [['S1', 'R1', 'T1', 'logged', '2026-01-01']] },
    'November 2026': { headers: ['Date', 'Description', 'Amount', 'Category', 'Type', 'Merchant', 'Transaction ID', 'Entry ID'], rows: [['2026-11-01', 'Test', 1000, 'Others', 'Expense', 'Test', 'T1', 'E1']] }
  }
};

let first = ctx.import('token', backup);
assert.equal(first.added, 4, 'first restore adds disposable rows');
let second = ctx.import('token', backup);
assert.equal(second.added, 0, 'second restore adds nothing');
assert.equal(second.skipped, 4, 'second restore skips every existing key');
assert.equal(household.rows.length, 1, 'household row present once');
assert.equal(budgets.rows.length, 1, 'budget row present once');
assert.equal(ledger.rows.length, 1, 'ledger row present once');
assert.equal(month.rows.length, 1, 'month row present once');

console.log('Backup restore checks passed: household, budget, ledger, and month rows are idempotent.');
