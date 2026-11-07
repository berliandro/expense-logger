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
    this.headers = headers.map((h) => String(h));
    this.rows = rows.map((r) => r.slice());
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length + 1; }
  getLastColumn() { return this.headers.length; }
  getSheetByName() { return null; }
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
      },
      setValue(v) { this.setValues([[v]]); }
    };
  }
}

class FakeSS {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  getSheets() { return this.sheets; }
  getSpreadsheetTimeZone() { return 'Asia/Jakarta'; }
}

const HEADERS = ['Date', 'Description', 'Amount', 'Category', 'Spending Type', 'Type', 'Merchant',
  'Notes', 'Transaction ID', 'Entry ID', 'Currency', 'FX Rate', 'Base Amount', 'Tags', 'Member',
  'Reimbursable', 'Reimbursed', 'Receipt Hash', 'Receipt URL', 'Split Group'];
const nov = new FakeSheet('November 2026', HEADERS, [
  ['2026-11-02', 'Weekly shop', 300000, 'Groceries', 'Need', 'Expense', 'Demo Grocer', '', '20261102AA', 'e1', 'IDR', 1, 300000, 'weekly', 'Rae', 'Yes', 'No'],
  ['2026-11-03', 'Lunch', 50000, 'Food & Beverage', 'Want', 'Expense', 'Demo Cafe', '', '20261103AB', 'e2', 'IDR', 1, 50000, '', 'Rae', 'No', 'No'],
  ['2026-11-04', 'Client payment', 1000000, 'Income', '', 'Income', 'Demo Client', '', '20261104AC', 'e3', 'IDR', 1, 1000000, '', '', 'No', 'No']
]);
const oct = new FakeSheet('October 2026', HEADERS, [
  ['2026-10-02', 'Older shop', 100000, 'Groceries', 'Need', 'Expense', 'Demo Grocer', '', '20261002AA', 'e4', 'IDR', 1, 100000, '', '', 'No', 'No']
]);
const budgets = new FakeSheet('_CF_Budgets', ['Category', 'Monthly Limit', 'Updated At'], [
  ['Groceries', 350000, '2026-11-01']
]);
const recurring = new FakeSheet('_CF_Recurring',
  ['Rule ID', 'Description', 'Amount', 'Category', 'Spending Type', 'Type', 'Member', 'Tags', 'Day', 'Active', 'Last Run', 'Created At'], [
  ['R-1', 'Rent', 3000000, 'Housing', 'Need', 'Expense', '', '', 1, 'Yes', '', '2026-10-01']
]);
const ss = new FakeSS([nov, oct, budgets, recurring]);

const ctx = {
  console,
  CF_SCAN_MAX_ROWS: 25000,
  CF_SCAN_MAX_SHEETS: 36,
  CF_HISTORY_MAX_ROWS: 500,
  CF_BUDGET_SHEET: '_CF_Budgets',
  CF_RECURRING_SHEET: '_CF_Recurring',
  CF_HOUSEHOLD_SHEET: '_CF_Household',
  requireSession_: () => {},
  getSpreadsheet_: () => ss,
  cfEnsureFeatureSchema_: () => true,
  cfHouseholdList_: () => [],
  cfFeatureSettings_: () => ({ defaultCurrency: 'IDR', baseCurrency: 'IDR', retainImages: false, reviewBeforeCommit: false }),
  normHeader_: (s) => String(s == null ? '' : s).trim().toLowerCase(),
  isMonthSheetName_: (name) => /^[A-Z][a-z]+ \d{4}$/.test(String(name || '')),
  parseMonthSheet_: (name) => {
    const m = String(name || '').match(/^([A-Z][a-z]+) (\d{4})$/);
    if (!m) return null;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { year: Number(m[2]), month: months.indexOf(m[1]) };
  },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      if (fmt === 'd') return '7';
      if (fmt === 'yyyy-MM') return '2026-11';
      if (fmt === 'yyyy-MM-dd') return '2026-11-07';
      return '2026-11-07';
    },
    getUuid: () => 'uuid-test'
  },
  Session: { getScriptTimeZone: () => 'Asia/Jakarta' }
};
const functions = ['cfFeatureSheetData_', 'cfValue_', 'cfBaseAmount_', 'cfHistoryRowObject_',
  'cfDateString_', 'cfMonthSheetName_', 'cfPrevMonthKey_', 'cfMonthRows_', 'cfDashboard_', 'cfSearchLogs_'];
vm.runInNewContext(functions.map(grab).join('\n') + '\nthis.dashboard = cfDashboard_; this.search = cfSearchLogs_;', ctx);

const dashboard = ctx.dashboard('token', '2026-11');
assert.equal(dashboard.totals.expense, 350000, 'expense total uses base amounts');
assert.equal(dashboard.totals.income, 1000000, 'income total');
assert.equal(dashboard.totals.net, 650000, 'net total');
assert.equal(dashboard.categories[0].category, 'Groceries');
assert.equal(dashboard.budgets[0].percent, 86);
assert.equal(dashboard.budgets[0].alert, true);
assert.equal(dashboard.anomalies[0].category, 'Groceries');
assert.equal(dashboard.anomalies[0].percent, 200);
assert.equal(dashboard.dueRecurring.length, 1);
assert.equal(dashboard.reimbursements.outstanding, 300000);
assert.ok(dashboard.scan.ms >= 0);

const search = ctx.search('token', { q: 'grocer', limit: 10 });
assert.equal(search.total, 2, 'search by merchant across months');
assert.equal(search.logs[0].merchant, 'Demo Grocer');
const income = ctx.search('token', { type: 'Income', limit: 10 });
assert.equal(income.total, 1);
assert.equal(income.logs[0].amount, 1000000);
const member = ctx.search('token', { member: 'Rae', limit: 10 });
assert.equal(member.total, 2);
const exact = ctx.search('token', { entryId: 'e2', limit: 10 });
assert.equal(exact.total, 1);
assert.equal(exact.logs[0].description, 'Lunch');

console.log('Backend dashboard/search checks passed: totals, categories, budgets, anomalies, recurring, reimbursements, filters.');
