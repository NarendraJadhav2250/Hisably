import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateEqual, calculateBalances, calculateExpenseShares, suggestSettlements } from './finance.js';

test('equal splits allocate every minor unit exactly once', () => {
  assert.deepEqual(allocateEqual(100, ['a', 'b', 'c']), [
    { memberId: 'a', amountMinor: 34 },
    { memberId: 'b', amountMinor: 33 },
    { memberId: 'c', amountMinor: 33 },
  ]);
});

test('exact, percentage, and weighted splits reconcile', () => {
  assert.deepEqual(calculateExpenseShares(101, ['a', 'b'], 'exact', [60, 41]).map((share) => share.amountMinor), [60, 41]);
  assert.deepEqual(calculateExpenseShares(101, ['a', 'b'], 'percentage', [50, 50]).map((share) => share.amountMinor), [50, 51]);
  assert.deepEqual(calculateExpenseShares(100, ['a', 'b'], 'shares', [1, 3]).map((share) => share.amountMinor), [25, 75]);
  assert.throws(() => calculateExpenseShares(100, ['a', 'b'], 'percentage', [40, 40]), /100/);
});

test('balances and proposed settlements reconcile the example expenses', () => {
  const expenses = [
    { amountPaise: 180000, paidBy: 'aisha', shares: allocateEqual(180000, ['aisha', 'raj', 'priya', 'you']) },
    { amountPaise: 40000, paidBy: 'raj', shares: allocateEqual(40000, ['raj', 'you']) },
  ];
  const balances = calculateBalances(expenses);
  assert.deepEqual(Object.fromEntries(balances), { aisha: 135000, raj: -25000, priya: -45000, you: -65000 });
  const settlements = suggestSettlements(balances);
  assert.equal(settlements.reduce((total, transfer) => total + transfer.amountMinor, 0), 135000);
  assert.equal(settlements.length, 3);
});

test('only completed settlements affect balances', () => {
  const expense = { amountMinor: 100, paidBy: 'a', shares: allocateEqual(100, ['a', 'b']) };
  assert.equal(calculateBalances([expense], [{ from: 'b', to: 'a', amountMinor: 50, status: 'pending' }]).get('b'), -50);
  assert.equal(calculateBalances([expense], [{ from: 'b', to: 'a', amountMinor: 50, status: 'completed' }]).get('b'), 0);
});