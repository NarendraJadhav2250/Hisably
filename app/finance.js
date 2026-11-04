// SplitSmart deterministic finance engine
export function allocateEqual(totalMinor, memberIds) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || !Array.isArray(memberIds) || memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) throw new Error('Invalid split');
  const base = Math.floor(totalMinor / memberIds.length);
  const remainder = totalMinor % memberIds.length;
  return memberIds.map((memberId, index) => ({ memberId, amountMinor: base + (index < remainder ? 1 : 0) }));
}

export const equalSplit = allocateEqual;

function amountOf(record) {
  return record.amountMinor ?? record.amountPaise;
}

export function validateExpenseSplit(totalMinor, shares) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !Array.isArray(shares) || shares.length === 0) {
    throw new Error('Invalid expense split');
  }
  const memberIds = new Set();
  let total = 0n;
  for (const share of shares) {
    if (typeof share.memberId !== 'string' || !share.memberId || memberIds.has(share.memberId)
      || !Number.isSafeInteger(share.amountMinor) || share.amountMinor < 0) {
      throw new Error('Expense shares must use unique members and non-negative minor units');
    }
    memberIds.add(share.memberId);
    total += BigInt(share.amountMinor);
  }
  if (total !== BigInt(totalMinor)) throw new Error('Expense shares must equal the total');
  return true;
}

export function calculateBalances(expenses, settlements = []) {
  const balances = new Map();
  const add = (id, amount) => {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(amount)) throw new Error('Invalid balance entry');
    const updated = (balances.get(id) || 0) + amount;
    if (!Number.isSafeInteger(updated)) throw new Error('Balance exceeds safe minor-unit precision');
    balances.set(id, updated);
  };
  for (const expense of expenses) {
    const totalMinor = amountOf(expense);
    if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw new Error('Invalid expense amount');
    validateExpenseSplit(totalMinor, expense.shares);
    add(expense.paidBy, totalMinor);
    for (const share of expense.shares) add(share.memberId, -share.amountMinor);
  }
  for (const settlement of settlements) {
    if (settlement.status !== 'completed') continue;
    const totalMinor = amountOf(settlement);
    if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || settlement.from === settlement.to) throw new Error('Invalid settlement');
    add(settlement.from, totalMinor);
    add(settlement.to, -totalMinor);
  }
  return balances;
}

export function suggestSettlements(balances) {
  const net = [...balances.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(net) || net !== 0) throw new Error('Group balances must reconcile to zero before settlement');
  const debtors = [...balances].filter(([, value]) => value < 0).map(([id, value]) => ({ id, amount: -value })).sort((a, b) => b.amount - a.amount);
  const creditors = [...balances].filter(([, value]) => value > 0).map(([id, value]) => ({ id, amount: value })).sort((a, b) => b.amount - a.amount);
  const transfers = [];
  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amountMinor = Math.min(debtors[d].amount, creditors[c].amount);
    transfers.push({ from: debtors[d].id, to: creditors[c].id, amountMinor, paise: amountMinor });
    debtors[d].amount -= amountMinor; creditors[c].amount -= amountMinor;
    if (!debtors[d].amount) d++; if (!creditors[c].amount) c++;
  }
  return transfers;
}

export function calculateExpenseShares(totalMinor, memberIds, method = 'equal', values = []) {
  if (!Array.isArray(memberIds) || memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
    throw new Error('Participants must be a non-empty, unique list');
  }
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) throw new Error('Expense amount must be positive');
  if (method === 'equal') return allocateEqual(totalMinor, memberIds);
  if (!Array.isArray(values) || values.length !== memberIds.length) throw new Error('A split value is required for every participant');

  let shares;
  if (method === 'exact') {
    if (values.some((value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === ''))) throw new Error('Enter an exact amount for every participant');
    shares = values.map(Number);
    if (shares.some((value) => !Number.isSafeInteger(value) || value < 0) || shares.reduce((sum, value) => sum + value, 0) !== totalMinor) {
      throw new Error('Exact shares must be non-negative minor units that sum to the expense total');
    }
  } else if (method === 'percentage' || method === 'shares') {
    const weights = values.map(Number);
    if (weights.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Split weights must be positive integers');
    const bigWeights = weights.map(BigInt);
    const denominator = method === 'percentage' ? 100n : bigWeights.reduce((sum, value) => sum + value, 0n);
    if (method === 'percentage' && denominator !== bigWeights.reduce((sum, value) => sum + value, 0n)) throw new Error('Percentages must total 100');
    let remaining = BigInt(totalMinor);
    shares = weights.map((weight, index) => {
      const share = index === weights.length - 1 ? remaining : BigInt(totalMinor) * bigWeights[index] / denominator;
      remaining -= share;
      return Number(share);
    });
  } else {
    throw new Error('Unsupported split method');
  }

  return memberIds.map((memberId, index) => ({ memberId, amountMinor: shares[index] }));
}

export function calculateMemberBalance(memberId, expenses, settlements = []) {
  return calculateBalances(expenses, settlements).get(memberId) || 0;
}

export function calculateGroupBalances(expenses, settlements = []) {
  return calculateBalances(expenses, settlements);
}

export function calculateOutstandingBalances(expenses, settlements = []) {
  return suggestSettlements(calculateBalances(expenses, settlements));
}

export function recalculateBalances(expenses, settlements = []) {
  return calculateBalances(expenses, settlements);
}

