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
  constructor(name, headers, rows) { this.name = name; this.headers = headers.slice(); this.rows = (rows || []).map((r) => r.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length + 1; }
  getLastColumn() { return this.headers.length; }
  deleteRow(n) { this.rows.splice(n - 2, 1); }
  appendRow(row) { this.rows.push(row.slice()); }
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
  getSpreadsheetTimeZone() { return 'Asia/Jakarta'; }
  insertSheet(name) { const sh = new FakeSheet(name, [], []); this.sheets.push(sh); return sh; }
}

const budgets = new FakeSheet('_CF_Budgets', ['Category', 'Monthly Limit', 'Updated At'], []);
const recurring = new FakeSheet('_CF_Recurring', ['Rule ID', 'Description', 'Amount', 'Category', 'Spending Type', 'Type', 'Member', 'Tags', 'Day', 'Active', 'Last Run', 'Created At'], []);
const household = new FakeSheet('_CF_Household', ['Member ID', 'Name', 'Active', 'Created At'], []);
const ss = new FakeSS([budgets, recurring, household]);
const ctx = {
  CF_BUDGET_SHEET: '_CF_Budgets', CF_RECURRING_SHEET: '_CF_Recurring', CF_HOUSEHOLD_SHEET: '_CF_Household',
  CF_HASH_SHEET: '_CF_ReceiptHashes', CF_IMAGE_SHEET: '_CF_ReceiptImages',
  requireSession_: () => {}, getSpreadsheet_: () => ss, cfEnsureFeatureSchema_: () => true,
  bumpHistoryCacheVersion_: () => {},
  normHeader_: (s) => String(s == null ? '' : s).trim().toLowerCase(),
  Utilities: { formatDate: () => '2026-11-07 10:00', getUuid: () => 'UUID1234' }
};
const funcs = ['cfFeatureSheetData_', 'cfValue_', 'cfBudgetList_', 'cfBudgetSave_', 'cfBudgetDelete_',
  'cfRecurringList_', 'cfRecurringSave_', 'cfRecurringDelete_',
  'cfHouseholdList_', 'cfHouseholdSave_', 'cfHouseholdDelete_'];
vm.runInNewContext(funcs.map(grab).join('\n') + '\nthis.budget = { list: cfBudgetList_, save: cfBudgetSave_, del: cfBudgetDelete_ };\n' +
  'this.rec = { list: cfRecurringList_, save: cfRecurringSave_, del: cfRecurringDelete_ };\n' +
  'this.hh = { list: cfHouseholdList_, save: cfHouseholdSave_, del: cfHouseholdDelete_ };', ctx);

// Budget CRUD.
ctx.budget.save('tok', { category: 'Disposable Test', limit: 12345 });
assert.equal(ctx.budget.list('tok').some((b) => b.category === 'Disposable Test'), true);
ctx.budget.del('tok', 'Disposable Test');
assert.equal(ctx.budget.list('tok').some((b) => b.category === 'Disposable Test'), false);
// Recurring CRUD.
ctx.rec.save('tok', { description: 'Disposable Recurring', amount: 1000, day: 1, category: 'Others', type: 'Expense' });
const rule = ctx.rec.list('tok').find((r) => r.description === 'Disposable Recurring');
assert.ok(rule && rule.ruleId);
ctx.rec.del('tok', rule.ruleId);
assert.equal(ctx.rec.list('tok').some((r) => r.description === 'Disposable Recurring'), false);
// Household CRUD.
ctx.hh.save('tok', { name: 'Disposable Member' });
const member = ctx.hh.list('tok').find((m) => m.name === 'Disposable Member');
assert.ok(member && member.memberId);
ctx.hh.del('tok', member.memberId);
assert.equal(ctx.hh.list('tok').some((m) => m.name === 'Disposable Member'), false);

console.log('Feature CRUD checks passed: budget, recurring, and household create/list/delete.');
