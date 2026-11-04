'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { calculateBalances, calculateExpenseShares, suggestSettlements } from './finance.js';
import { getSupabaseBrowserClient } from '../lib/supabase.js';

const CATEGORIES = ['Food & Dining', 'Groceries', 'Travel', 'Transportation', 'Accommodation', 'Shopping', 'Entertainment', 'Utilities', 'Rent', 'Medical', 'Education', 'Other'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const supabase = getSupabaseBrowserClient();

function amountToMinor(value, allowZero = false) {
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  return (allowZero ? minor >= 0n : minor > 0n) && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function defaultSplitValue(method, count, index) {
  if (method === 'percentage') return Math.floor(100 / count) + (index < 100 % count ? 1 : 0);
  return 1;
}

function formatMoney(minor, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format((minor || 0) / 100);
  } catch {
    return `${currency} ${((minor || 0) / 100).toFixed(2)}`;
  }
}

function displayDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
}

function initials(value = '') {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
}

const freshExpense = (members = []) => ({
  title: '', amount: '', paidBy: '', participants: members.map((member) => member.id),
  category: 'Food & Dining', date: new Date().toISOString().slice(0, 10), notes: '',
  method: 'equal', values: {},
});

export default function SplitSmartApp() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState('signin');
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [members, setMembers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [splits, setSplits] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [dataReady, setDataReady] = useState(false);
  const [activeView, setActiveView] = useState('Overview');
  const [modal, setModal] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: '', currency: 'INR', description: '' });
  const [guestForm, setGuestForm] = useState({ name: '', email: '' });
  const [expenseForm, setExpenseForm] = useState(freshExpense());
  const [aiText, setAiText] = useState('');
  const [aiClarification, setAiClarification] = useState('');
  const settlementIdempotencyKeys = useRef(new Map());

  useEffect(() => {
    if (!supabase) {
      return undefined;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setUser(data.session?.user || null);
        setAuthReady(true);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      if (event === 'PASSWORD_RECOVERY') {
        setAuthMode('update-password');
        setShowAuth(true);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadGroups() {
      setDataReady(false);
      if (!user || !supabase) {
        setGroups([]);
        setGroupId('');
        setDataReady(true);
        return;
      }
      const { data: memberships, error: membershipError } = await supabase
        .from('group_members').select('group_id').eq('user_id', user.id).eq('membership_status', 'active');
      if (membershipError) {
        if (active) setError(`Could not load your groups: ${membershipError.message}`);
        if (active) setDataReady(true);
        return;
      }
      const ids = [...new Set((memberships || []).map((membership) => membership.group_id))];
      if (ids.length === 0) {
        if (active) {
          setGroups([]);
          setGroupId('');
          setDataReady(true);
        }
        return;
      }
      const { data, error: groupsError } = await supabase.from('groups')
        .select('id, name, currency, description, archived_at').in('id', ids).is('archived_at', null).order('created_at');
      if (!active) return;
      if (groupsError) setError(`Could not load your groups: ${groupsError.message}`);
      setGroups(data || []);
      setGroupId((current) => (data || []).some((group) => group.id === current) ? current : data?.[0]?.id || '');
      setDataReady(true);
    }
    loadGroups();
    return () => { active = false; };
  }, [user, message]);

  useEffect(() => {
    let active = true;
    async function loadGroupData() {
      setMembers([]);
      setExpenses([]);
      setSplits([]);
      setSettlements([]);
      if (!groupId || !supabase) return;
      const [memberResult, expenseResult, settlementResult] = await Promise.all([
        supabase.from('group_members').select('id, user_id, display_name, email, role, membership_status')
          .eq('group_id', groupId).eq('membership_status', 'active').order('created_at'),
        supabase.from('expenses').select('id, description, amount_minor, currency, paid_by_member_id, category, expense_date, notes, created_at')
          .eq('group_id', groupId).is('deleted_at', null).order('expense_date', { ascending: false }),
        supabase.from('settlements').select('id, payer_member_id, recipient_member_id, amount_minor, currency, status, completed_at, created_at')
          .eq('group_id', groupId).order('created_at', { ascending: false }),
      ]);
      if (!active) return;
      const problem = memberResult.error || expenseResult.error || settlementResult.error;
      if (problem) {
        setError(`Could not load group activity: ${problem.message}`);
        return;
      }
      const expenseRows = expenseResult.data || [];
      let splitRows = [];
      if (expenseRows.length) {
        const { data, error: splitError } = await supabase.from('expense_splits')
          .select('id, expense_id, member_id, share_minor, split_type, split_value')
          .in('expense_id', expenseRows.map((expense) => expense.id));
        if (splitError) {
          setError(`Could not load expense splits: ${splitError.message}`);
          return;
        }
        splitRows = data || [];
      }
      setMembers(memberResult.data || []);
      setExpenses(expenseRows);
      setSplits(splitRows);
      setSettlements(settlementResult.data || []);
    }
    loadGroupData();
    return () => { active = false; };
  }, [groupId, message]);

  const selectedGroup = groups.find((group) => group.id === groupId) || null;
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const splitsByExpense = useMemo(() => {
    const map = new Map();
    for (const split of splits) {
      if (!map.has(split.expense_id)) map.set(split.expense_id, []);
      map.get(split.expense_id).push({ memberId: split.member_id, amountMinor: split.share_minor });
    }
    return map;
  }, [splits]);
  const validExpenses = useMemo(() => expenses.filter((expense) => {
    const expenseSplits = splitsByExpense.get(expense.id) || [];
    return Number.isSafeInteger(expense.amount_minor) && expenseSplits.reduce((sum, split) => sum + split.amountMinor, 0) === expense.amount_minor;
  }).map((expense) => ({
    ...expense,
    amountMinor: expense.amount_minor,
    paidBy: expense.paid_by_member_id,
    shares: splitsByExpense.get(expense.id) || [],
  })), [expenses, splitsByExpense]);
  const balanceMap = useMemo(() => {
    if (!groupId) return new Map();
    return calculateBalances(validExpenses, settlements.map((settlement) => ({
      from: settlement.payer_member_id,
      to: settlement.recipient_member_id,
      amountMinor: settlement.amount_minor,
      status: settlement.status,
    })));
  }, [validExpenses, settlements, groupId]);
  const transfers = useMemo(() => suggestSettlements(balanceMap), [balanceMap]);
  const groupTotal = validExpenses.reduce((sum, expense) => sum + expense.amount_minor, 0);
  const currentMember = members.find((member) => member.user_id === user?.id);
  const currentBalance = currentMember ? balanceMap.get(currentMember.id) || 0 : 0;
  const visibleExpenses = validExpenses.filter((expense) => (expense.description || '').toLowerCase().includes(search.toLowerCase()));
  const topCategories = useMemo(() => {
    const totals = new Map();
    for (const expense of validExpenses) totals.set(expense.category, (totals.get(expense.category) || 0) + expense.amount_minor);
    return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [validExpenses]);

  function clearNotice() {
    setError('');
    setMessage('');
  }

  async function submitAuth(event) {
    event.preventDefault();
    clearNotice();
    if (!supabase) return;
    setBusy(true);
    let result;
    if (authMode === 'signup') {
      result = await supabase.auth.signUp({
        email: authForm.email.trim(), password: authForm.password,
        options: { data: { full_name: authForm.name.trim() } },
      });
      if (!result.error && result.data.user) {
        await supabase.from('profiles').upsert({ id: result.data.user.id, full_name: authForm.name.trim(), preferred_currency: 'INR' });
        if (!result.data.session) setMessage('Check your email to verify your account, then sign in.');
      }
    } else if (authMode === 'reset') {
      result = await supabase.auth.resetPasswordForEmail(authForm.email.trim(), { redirectTo: `${window.location.origin}/` });
      if (!result.error) setMessage('If that email belongs to an account, a password reset link is on its way.');
    } else if (authMode === 'update-password') {
      result = await supabase.auth.updateUser({ password: authForm.password });
      if (!result.error) setMessage('Your password has been updated.');
    } else {
      result = await supabase.auth.signInWithPassword({ email: authForm.email.trim(), password: authForm.password });
    }
    if (result?.error) setError(result.error.message);
    setBusy(false);
  }

  async function signInWithGoogle() {
    clearNotice();
    const { error: authError } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (authError) setError(authError.message);
  }

  async function signOut() {
    clearNotice();
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
  }

  async function submitGroup(event) {
    event.preventDefault();
    clearNotice();
    setBusy(true);
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: user.id,
      full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'You',
      preferred_currency: groupForm.currency,
    });
    const { error: groupError } = profileError ? { error: profileError } : await supabase.rpc('create_group', {
      p_name: groupForm.name,
      p_currency: groupForm.currency,
      p_description: groupForm.description || null,
    });
    if (groupError) setError(groupError.message);
    else {
      setMessage('Group created. Invite people or record your first expense.');
      setGroupForm({ name: '', currency: 'INR', description: '' });
      setModal('');
    }
    setBusy(false);
  }

  async function submitGuest(event) {
    event.preventDefault();
    clearNotice();
    setBusy(true);
    const { error: guestError } = await supabase.rpc('add_guest_member', {
      p_group_id: groupId, p_display_name: guestForm.name, p_email: guestForm.email || null,
    });
    if (guestError) setError(guestError.message);
    else {
      setMessage(`${guestForm.name} was added to the group.`);
      setGuestForm({ name: '', email: '' });
      setModal('');
    }
    setBusy(false);
  }

  function openExpense() {
    setExpenseForm({ ...freshExpense(members), paidBy: currentMember?.id || members[0]?.id || '' });
    setAiClarification('');
    setModal('expense');
  }

  async function parseWithAI(event) {
    event.preventDefault();
    clearNotice();
    setBusy(true);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    try {
      const response = await fetch('/api/ai/expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: aiText, groupId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not parse that expense.');
      const parsed = result.expense;
      const resolve = (name) => members.find((member) => member.display_name.toLowerCase() === String(name).toLowerCase());
      const payer = resolve(parsed.payer);
      const participants = parsed.participants.map(resolve).filter(Boolean).map((member) => member.id);
      setExpenseForm({
        title: parsed.title,
        amount: parsed.amount == null ? '' : String(parsed.amount),
        paidBy: payer?.id || currentMember?.id || members[0]?.id || '',
        participants,
        category: parsed.category,
        date: parsed.date || new Date().toISOString().slice(0, 10),
        notes: parsed.notes || '',
        method: parsed.splitMethod || 'equal',
        values: {},
      });
      setAiClarification(parsed.clarification || (!payer || participants.length !== parsed.participants.length ? 'Check the payer and participants below; names that could not be matched are left for you to select.' : 'Review and edit the details before saving.'));
      setModal('expense');
    } catch (parseError) {
      setError(parseError.message || 'The assistant could not parse that expense.');
    }
    setBusy(false);
  }

  async function submitExpense(event) {
    event.preventDefault();
    clearNotice();
    const amountMinor = amountToMinor(expenseForm.amount);
    if (!amountMinor) {
      setError('Enter an amount greater than zero with no more than two decimal places.');
      return;
    }
    if (!expenseForm.title.trim() || !expenseForm.paidBy || expenseForm.participants.length === 0) {
      setError('Add a title, payer, and at least one participant.');
      return;
    }
    let splitValues;
    try {
      splitValues = calculateExpenseShares(
        amountMinor,
        expenseForm.participants,
        expenseForm.method,
        expenseForm.participants.map((memberId, index) => {
          const value = expenseForm.values[memberId] ?? defaultSplitValue(expenseForm.method, expenseForm.participants.length, index);
          if (expenseForm.method === 'exact') return amountToMinor(value, true);
          return Number(value);
        }),
      );
    } catch (splitError) {
      setError(splitError.message);
      return;
    }
    if (splitValues.some((split) => !Number.isSafeInteger(split.amountMinor))) {
      setError('Enter a valid split value for each selected participant.');
      return;
    }
    setBusy(true);
    const { error: createError } = await supabase.rpc('create_expense', {
      p_group_id: groupId,
      p_description: expenseForm.title.trim(),
      p_amount_minor: amountMinor,
      p_currency: selectedGroup.currency,
      p_category: expenseForm.category,
      p_expense_date: expenseForm.date,
      p_paid_by_member_id: expenseForm.paidBy,
      p_split_method: expenseForm.method,
      p_splits: expenseForm.participants.map((memberId, index) => ({
        member_id: memberId,
        value: expenseForm.method === 'exact'
          ? amountToMinor(expenseForm.values[memberId], true)
          : Number(expenseForm.values[memberId] ?? defaultSplitValue(expenseForm.method, expenseForm.participants.length, index)),
      })),
      p_notes: expenseForm.notes || null,
    });
    if (createError) setError(createError.message);
    else {
      setMessage('Expense saved and group balances updated.');
      setModal('');
    }
    setBusy(false);
  }

  async function completeSettlement(transfer) {
    clearNotice();
    if (memberById.get(transfer.from)?.user_id !== user.id) {
      setError('Only the payer can confirm this payment as completed.');
      return;
    }
    setBusy(true);
    const transferKey = `${transfer.from}:${transfer.to}:${transfer.amountMinor}`;
    let idempotencyKey = settlementIdempotencyKeys.current.get(transferKey);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      settlementIdempotencyKeys.current.set(transferKey, idempotencyKey);
    }
    const { error: settlementError } = await supabase.rpc('record_settlement', {
      p_group_id: groupId,
      p_payer_member_id: transfer.from,
      p_recipient_member_id: transfer.to,
      p_amount_minor: transfer.amountMinor,
      p_idempotency_key: idempotencyKey,
      p_completed: true,
    });
    if (settlementError) setError(settlementError.message);
    else setMessage('Payment recorded as completed. Group balances were recalculated.');
    setBusy(false);
  }

  function toggleParticipant(memberId) {
    setExpenseForm((current) => ({
      ...current,
      participants: current.participants.includes(memberId)
        ? current.participants.filter((id) => id !== memberId)
        : [...current.participants, memberId],
    }));
  }

  if (!supabase) return <ConfigurationScreen />;
  if (!authReady) return <div className="screen-loader"><span className="loader-mark">S</span><p>Opening your workspace…</p></div>;
  if (!user && !showAuth) return <LandingScreen
    onSignup={() => { setAuthMode('signup'); setShowAuth(true); }}
    onSignin={() => { setAuthMode('signin'); setShowAuth(true); }}
  />;
  if (!user) return <AuthScreen
    authMode={authMode} setAuthMode={setAuthMode} authForm={authForm} setAuthForm={setAuthForm}
    busy={busy} error={error} message={message} onSubmit={submitAuth} onGoogle={signInWithGoogle}
    onBack={() => setShowAuth(false)}
  />;

  return <main className="workspace">
    <aside className="sidebar">
      <a className="brand" href="#home" aria-label="SplitSmart home"><span className="brand-symbol">s</span><span>split<span>smart</span></span></a>
      <div className="side-caption">WORKSPACE</div>
      <label className="group-control"><span className="group-mark">{initials(selectedGroup?.name || 'SS')}</span><select aria-label="Choose group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
        {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
      </select><span className="select-chevron">⌄</span></label>
      <div className="side-caption nav-caption">MENU</div>
      <nav className="side-nav" aria-label="Main navigation">
        {[
          ['Overview', '◫'], ['Expenses', '↗'], ['Balances', '⇄'], ['People', '♙'],
        ].map(([label, icon]) => <button key={label} className={activeView === label ? 'side-link selected' : 'side-link'} onClick={() => setActiveView(label)}>
          <span>{icon}</span>{label}{label === 'Balances' && transfers.length > 0 && <small>{transfers.length}</small>}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="currency-note"><span>◉</span> Data protected by Supabase</div>
        <button className="account-row" onClick={signOut} title="Sign out">
          <span className="avatar avatar-small">{initials(user.user_metadata?.full_name || user.email)}</span>
          <span className="account-copy"><b>{user.user_metadata?.full_name || user.email}</b><small>Sign out</small></span><span className="logout-mark">↗</span>
        </button>
      </div>
    </aside>

    <section className="main-area" id="home">
      <header className="topbar">
        <div className="breadcrumb"><span>Groups</span><b>/</b><strong>{selectedGroup?.name || 'Your groups'}</strong></div>
        <div className="topbar-actions"><span className="secure-label"><i/> Secure workspace</span><button className="avatar avatar-top" aria-label="Account" onClick={signOut}>{initials(user.user_metadata?.full_name || user.email)}</button></div>
      </header>
      <div className="content">
        {message && <div className="notice success-notice" role="status"><span>✓</span>{message}<button onClick={() => setMessage('')} aria-label="Dismiss message">×</button></div>}
        {error && <div className="notice error-notice" role="alert"><span>!</span>{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {!dataReady ? <div className="content-loader"><span className="loader-mark">S</span>Loading your groups…</div> : groups.length === 0 ? <EmptyGroups onCreate={() => setModal('group')} /> : <>
          <div className="page-heading">
            <div><span className="eyebrow">GROUP OVERVIEW <i/> {selectedGroup?.currency || 'INR'}</span><h1>{activeView === 'Overview' ? selectedGroup?.name : activeView}</h1><p>Shared expenses, sorted. Here’s where things stand.</p></div>
            <div className="heading-actions"><button className="button button-ai" onClick={() => { setAiText(''); setModal('ai'); }}>✳ <span>Ask AI</span></button><button className="button button-primary" onClick={openExpense}><span className="plus">＋</span> Add expense</button></div>
          </div>
          <div className="summary-grid">
            <Summary label="Group spending" value={formatMoney(groupTotal, selectedGroup.currency)} detail={`${validExpenses.length} recorded ${validExpenses.length === 1 ? 'expense' : 'expenses'}`} icon="↗" />
            <Summary label="You are owed" value={formatMoney(Math.max(currentBalance, 0), selectedGroup.currency)} detail="Your share of group balances" icon="↑" color="green" />
            <Summary label="You owe" value={formatMoney(Math.max(-currentBalance, 0), selectedGroup.currency)} detail="Outstanding to group members" icon="↓" color="red" />
            <Summary label="Your net balance" value={`${currentBalance > 0 ? '+' : ''}${formatMoney(currentBalance, selectedGroup.currency)}`} detail={currentBalance > 0 ? 'You are in the green' : currentBalance < 0 ? 'You have an outstanding balance' : 'You are all settled'} icon="◉" color={currentBalance > 0 ? 'green' : currentBalance < 0 ? 'red' : ''} />
          </div>

          {activeView === 'Overview' && <>
            <div className="content-grid">
              <ExpensePanel expenses={validExpenses.slice(0, 6)} members={memberById} currency={selectedGroup.currency} onViewAll={() => setActiveView('Expenses')} />
              <SettlementPanel transfers={transfers} members={memberById} currency={selectedGroup.currency} userId={user.id} busy={busy} onComplete={completeSettlement} />
            </div>
            <section className="surface activity-surface">
              <div className="surface-heading"><div><h2>People in this group</h2><p>Balances are calculated from expenses and completed payments.</p></div><button className="text-action" onClick={() => setActiveView('People')}>Manage people <span>→</span></button></div>
              <MemberList members={members.slice(0, 6)} balances={balanceMap} currency={selectedGroup.currency} currentUserId={user.id} />
            </section>
            <CategoryPanel categories={topCategories} total={groupTotal} currency={selectedGroup.currency} />
          </>}
          {activeView === 'Expenses' && <section className="surface full-surface">
            <div className="surface-heading"><div><h2>Expenses</h2><p>{validExpenses.length} items in {selectedGroup.name}</p></div><button className="button button-primary button-small" onClick={openExpense}>＋ Add expense</button></div>
            <div className="table-tools"><label className="search-box"><span>⌕</span><input aria-label="Search expenses" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by description"/><button onClick={() => setSearch('')}>Clear</button></label></div>
            <ExpenseRows expenses={visibleExpenses} members={memberById} currency={selectedGroup.currency} />
          </section>}
          {activeView === 'Balances' && <>
            <section className="surface full-surface"><div className="surface-heading"><div><h2>Settle up</h2><p>Suggested payments are derived from current group balances.</p></div></div><SettlementPanel transfers={transfers} members={memberById} currency={selectedGroup.currency} userId={user.id} busy={busy} onComplete={completeSettlement} expanded /></section>
            <section className="surface full-surface"><div className="surface-heading"><div><h2>Member balances</h2><p>Positive balances should receive; negative balances owe.</p></div></div><MemberList members={members} balances={balanceMap} currency={selectedGroup.currency} currentUserId={user.id} /></section>
            <section className="surface full-surface"><div className="surface-heading"><div><h2>Payment history</h2><p>Only completed settlements change balances.</p></div></div><SettlementHistory settlements={settlements} members={memberById} currency={selectedGroup.currency} /></section>
          </>}
          {activeView === 'People' && <section className="surface full-surface"><div className="surface-heading"><div><h2>Group members</h2><p>{members.length} active {members.length === 1 ? 'member' : 'members'}</p></div><button className="button button-primary button-small" onClick={() => setModal('guest')}>＋ Add person</button></div><MemberList members={members} balances={balanceMap} currency={selectedGroup.currency} currentUserId={user.id} expanded /><div className="people-footnote">Guest members can be included in expenses and balances without creating an account.</div></section>}
          <footer className="app-footer"><span>SplitSmart · Shared expenses, sorted.</span><span>INR in paise · Synced with Supabase</span></footer>
        </>}
      </div>
    </section>

    {modal && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(''); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <button className="dialog-close" onClick={() => setModal('')} aria-label="Close dialog">×</button>
        {modal === 'group' && <form onSubmit={submitGroup}>
          <span className="eyebrow">NEW WORKSPACE</span><h2 id="dialog-title">Create a group</h2><p>Start a shared ledger for your people.</p>
          <label className="field-label">Group name<input required maxLength="80" autoFocus value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="e.g. Flat expenses" /></label>
          <div className="form-two"><label className="field-label">Currency<select value={groupForm.currency} onChange={(event) => setGroupForm({ ...groupForm, currency: event.target.value })}>{CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label className="field-label">Description<input value={groupForm.description} onChange={(event) => setGroupForm({ ...groupForm, description: event.target.value })} placeholder="Optional" /></label></div>
          {error && <p className="form-error">{error}</p>}<button className="button button-primary submit-button" disabled={busy}>{busy ? 'Creating…' : 'Create group'}</button>
        </form>}
        {modal === 'guest' && <form onSubmit={submitGuest}>
          <span className="eyebrow">{selectedGroup?.name}</span><h2 id="dialog-title">Add a person</h2><p>Add a guest to include them in shared expenses.</p>
          <label className="field-label">Name<input required maxLength="100" autoFocus value={guestForm.name} onChange={(event) => setGuestForm({ ...guestForm, name: event.target.value })} placeholder="Full name" /></label>
          <label className="field-label">Email <span className="optional">OPTIONAL</span><input type="email" value={guestForm.email} onChange={(event) => setGuestForm({ ...guestForm, email: event.target.value })} placeholder="name@example.com" /></label>
          {error && <p className="form-error">{error}</p>}<button className="button button-primary submit-button" disabled={busy}>{busy ? 'Adding…' : 'Add person'}</button>
        </form>}
        {modal === 'ai' && <form onSubmit={parseWithAI}>
          <span className="eyebrow">SPLITSMART AI</span><h2 id="dialog-title">Describe an expense</h2><p>AI will prepare a draft. Nothing is saved until you review and confirm.</p>
          <label className="field-label">What happened?<textarea required maxLength="1200" rows="4" autoFocus value={aiText} onChange={(event) => setAiText(event.target.value)} placeholder="Dinner was ₹1,800. Aisha paid; split between Aisha, Raj, Priya and me." /></label>
          {error && <p className="form-error">{error}</p>}<button className="button button-primary submit-button" disabled={busy}>{busy ? 'Preparing draft…' : 'Prepare expense draft'}</button>
        </form>}
        {modal === 'expense' && <form onSubmit={submitExpense}>
          <span className="eyebrow">{selectedGroup?.name}</span><h2 id="dialog-title">Add an expense</h2><p>Enter a shared cost. Shares are saved in minor currency units.</p>
          {aiClarification && <div className="ai-note">✳ {aiClarification}</div>}
          <label className="field-label">Expense name<input required maxLength="160" autoFocus value={expenseForm.title} onChange={(event) => setExpenseForm({ ...expenseForm, title: event.target.value })} placeholder="e.g. Dinner by the beach" /></label>
          <div className="form-two"><label className="field-label">Amount ({selectedGroup?.currency})<input required inputMode="decimal" value={expenseForm.amount} onChange={(event) => setExpenseForm({ ...expenseForm, amount: event.target.value })} placeholder="0.00" /></label><label className="field-label">Expense date<input required type="date" value={expenseForm.date} onChange={(event) => setExpenseForm({ ...expenseForm, date: event.target.value })} /></label></div>
          <div className="form-two"><label className="field-label">Paid by<select required value={expenseForm.paidBy} onChange={(event) => setExpenseForm({ ...expenseForm, paidBy: event.target.value })}>{members.map((member) => <option value={member.id} key={member.id}>{member.display_name}</option>)}</select></label><label className="field-label">Category<select value={expenseForm.category} onChange={(event) => setExpenseForm({ ...expenseForm, category: event.target.value })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label></div>
          <label className="field-label">Split method<select value={expenseForm.method} onChange={(event) => setExpenseForm({ ...expenseForm, method: event.target.value, values: {} })}><option value="equal">Equal</option><option value="exact">Exact amounts</option><option value="percentage">Percentage</option><option value="shares">Weighted shares</option></select></label>
          <fieldset className="participant-list"><legend>Split between</legend>{members.map((member) => <label className="participant-option" key={member.id}><input type="checkbox" checked={expenseForm.participants.includes(member.id)} onChange={() => toggleParticipant(member.id)} /><span className="avatar avatar-tiny">{initials(member.display_name)}</span><span>{member.display_name}</span>{expenseForm.method !== 'equal' && expenseForm.participants.includes(member.id) && <input className="share-value" aria-label={`${expenseForm.method} for ${member.display_name}`} inputMode="decimal" placeholder={expenseForm.method === 'exact' ? '0.00' : expenseForm.method === 'percentage' ? '%' : 'Shares'} value={expenseForm.values[member.id] ?? ''} onChange={(event) => setExpenseForm({ ...expenseForm, values: { ...expenseForm.values, [member.id]: event.target.value } })} />}</label>)}</fieldset>
          <label className="field-label">Note <span className="optional">OPTIONAL</span><textarea rows="2" maxLength="500" value={expenseForm.notes} onChange={(event) => setExpenseForm({ ...expenseForm, notes: event.target.value })} placeholder="Add context for the group" /></label>
          {error && <p className="form-error">{error}</p>}<button className="button button-primary submit-button" disabled={busy}>{busy ? 'Saving…' : 'Save expense'}</button>
        </form>}
      </section>
    </div>}
  </main>;
}

function Summary({ label, value, detail, icon, color = '' }) {
  return <article className="summary-card"><div className="summary-label">{label}<span>{icon}</span></div><strong className={color}>{value}</strong><small>{detail}</small></article>;
}

function ExpensePanel({ expenses, members, currency, onViewAll }) {
  return <section className="surface expense-surface"><div className="surface-heading"><div><h2>Recent expenses</h2><p>The latest activity in this group</p></div><button className="text-action" onClick={onViewAll}>View all <span>→</span></button></div><ExpenseRows expenses={expenses} members={members} currency={currency} compact /></section>;
}

function ExpenseRows({ expenses, members, currency, compact = false }) {
  if (!expenses.length) return <div className="empty-inline"><span className="empty-mark">＋</span><b>No expenses yet</b><small>Once an expense is recorded, it will appear here.</small></div>;
  return <div className={compact ? 'expense-table compact-table' : 'expense-table'}>
    {!compact && <div className="table-head"><span>EXPENSE</span><span>PAID BY</span><span>DATE</span><span>AMOUNT</span></div>}
    {expenses.map((expense) => <div className="expense-row" key={expense.id}>
      <span className="category-icon">{expense.category === 'Food & Dining' ? '♨' : expense.category === 'Travel' || expense.category === 'Transportation' ? '↗' : '◈'}</span>
      <span className="expense-description"><b>{expense.description || expense.name}</b><small>{expense.category}</small></span>
      <span className="expense-payer">{members.get(expense.paid_by_member_id)?.display_name || 'Member'}</span>
      <span className="expense-date">{displayDate(expense.expense_date)}</span>
      <strong className="expense-amount">{formatMoney(expense.amount_minor, currency)}</strong>
    </div>)}
  </div>;
}

function SettlementPanel({ transfers, members, currency, userId, busy, onComplete, expanded = false }) {
  return <aside className={expanded ? 'surface settlement-surface expanded-settlement' : 'surface settlement-surface'}>
    <div className="surface-heading"><div><h2>Settle up</h2><p>Suggested payments</p></div><span className="settle-symbol">⇄</span></div>
    {transfers.length ? <div className="transfer-list">{transfers.map((transfer, index) => {
      const payer = members.get(transfer.from);
      const recipient = members.get(transfer.to);
      const isPayer = payer?.user_id === userId;
      return <div className="transfer-row" key={`${transfer.from}-${transfer.to}-${index}`}>
        <span className="avatar transfer-avatar">{initials(payer?.display_name)}</span>
        <span className="transfer-copy"><b>{payer?.display_name || 'Member'}</b><small>pays {recipient?.display_name || 'Member'}</small></span>
        <strong>{formatMoney(transfer.amountMinor, currency)}</strong>
        <button disabled={busy || !isPayer} title={isPayer ? 'Confirm you made this payment' : 'Only the payer can confirm this payment'} onClick={() => onComplete(transfer)}>{isPayer ? 'Mark paid' : 'Awaiting payer'}</button>
      </div>;
    })}</div> : <div className="all-settled"><span>✓</span><b>Everyone is settled</b><small>There are no outstanding transfers.</small></div>}
    <p className="settlement-footnote">A recommendation never counts as paid until the payer confirms it.</p>
  </aside>;
}

function MemberList({ members, balances, currency, currentUserId, expanded = false }) {
  if (!members.length) return <div className="empty-inline"><b>No members yet</b><small>Add people to start sharing costs.</small></div>;
  return <div className={expanded ? 'member-list expanded-members' : 'member-list'}>{members.map((member) => {
    const balance = balances.get(member.id) || 0;
    return <article className="member-card" key={member.id}>
      <span className="avatar member-avatar">{initials(member.display_name)}</span>
      <span className="member-identity"><b>{member.display_name}{member.user_id === currentUserId && <small className="you-tag">YOU</small>}</b><small>{member.role === 'owner' ? 'Group owner' : member.user_id ? 'Member' : 'Guest member'}</small></span>
      <span className="member-stat"><small>GROUP BALANCE</small><b className={balance > 0 ? 'green' : balance < 0 ? 'red' : ''}>{balance > 0 ? '+' : ''}{formatMoney(balance, currency)}</b></span>
    </article>;
  })}</div>;
}

function SettlementHistory({ settlements, members, currency }) {
  const completed = settlements.filter((settlement) => settlement.status === 'completed');
  if (!completed.length) return <div className="empty-inline"><b>No completed payments</b><small>Confirmed payments will be listed here.</small></div>;
  return <div className="history-list">{completed.map((settlement) => <div className="history-row" key={settlement.id}>
    <span className="history-check">✓</span><span><b>{members.get(settlement.payer_member_id)?.display_name || 'Member'} paid {members.get(settlement.recipient_member_id)?.display_name || 'Member'}</b><small>{displayDate((settlement.completed_at || settlement.created_at).slice(0, 10))}</small></span><strong>{formatMoney(settlement.amount_minor, currency)}</strong>
  </div>)}</div>;
}

function CategoryPanel({ categories, total, currency }) {
  if (!categories.length) return null;
  return <section className="surface category-surface"><div className="surface-heading"><div><h2>Spending by category</h2><p>Based on recorded expenses in this group</p></div></div><div className="category-bars">{categories.map(([category, amount]) => <div className="category-bar-row" key={category}><span>{category}</span><div><i style={{ width: `${Math.max(3, Math.round(amount / total * 100))}%` }}/></div><b>{formatMoney(amount, currency)}</b></div>)}</div></section>;
}

function EmptyGroups({ onCreate }) {
  return <section className="empty-workspace"><span className="empty-illustration">S</span><span className="eyebrow">YOUR SHARED LEDGER</span><h1>Make the first group.</h1><p>Create a group, add the people sharing costs, and record your first expense.</p><button className="button button-primary" onClick={onCreate}>＋ Create a group</button></section>;
}

function AuthScreen({ authMode, setAuthMode, authForm, setAuthForm, busy, error, message, onSubmit, onGoogle, onBack }) {
  const title = authMode === 'signup' ? 'Create your account' : authMode === 'reset' ? 'Reset your password' : authMode === 'update-password' ? 'Choose a new password' : 'Welcome back';
  return <main className="auth-screen"><section className="auth-panel"><button className="brand auth-brand auth-brand-button" onClick={onBack} aria-label="Back to SplitSmart home"><span className="brand-symbol">s</span><span>split<span>smart</span></span></button>
    <span className="eyebrow">SHARED EXPENSES, SORTED</span><h1>{title}</h1><p className="auth-intro">Track group spending, split bills fairly, and settle up without the awkward calculations.</p>
    {message && <div className="notice success-notice" role="status">{message}</div>}{error && <div className="notice error-notice" role="alert">{error}</div>}
    <form className="auth-form" onSubmit={onSubmit}>
      {authMode === 'signup' && <label className="field-label">Your name<input required autoComplete="name" value={authForm.name} onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })} placeholder="Full name" /></label>}
      {authMode !== 'update-password' && <label className="field-label">Email address<input required type="email" autoComplete="email" value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} placeholder="you@example.com" /></label>}
      {authMode !== 'reset' && <label className="field-label">{authMode === 'update-password' ? 'New password' : 'Password'}<input required minLength="8" type="password" autoComplete={authMode === 'signup' || authMode === 'update-password' ? 'new-password' : 'current-password'} value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} placeholder="At least 8 characters" /></label>}
      <button className="button button-primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : authMode === 'reset' ? 'Send reset link' : authMode === 'update-password' ? 'Update password' : 'Sign in'}</button>
    </form>
    {authMode === 'signin' && <><div className="auth-divider"><span>OR</span></div><button className="button google-button" onClick={onGoogle}><b>G</b> Continue with Google</button></>}
    <div className="auth-links">{authMode === 'signin' && <><button onClick={() => setAuthMode('reset')}>Forgot password?</button><span>New here? <button onClick={() => setAuthMode('signup')}>Create an account</button></span></>}{authMode !== 'signin' && <button onClick={() => setAuthMode('signin')}>Back to sign in</button>}</div>
    <p className="auth-privacy">Your group data is protected by Supabase access policies.</p>
  </section><aside className="auth-aside"><div className="auth-aside-inner"><span className="eyebrow">NO MORE CALCULATOR CHAINS</span><h2>Every shared cost.<br/>Clearly accounted for.</h2><div className="auth-preview"><div className="preview-top"><span>WEEKEND HOUSE</span><i>INR</i></div><div className="preview-title">House groceries</div><div className="preview-line"><span>Paid by Asha</span><b>₹2,480.00</b></div><div className="preview-rule"/><div className="preview-members"><span><i>A</i>Asha</span><b>₹620.00</b></div><div className="preview-members"><span><i>R</i>Rohan</span><b>₹620.00</b></div><div className="preview-members"><span><i>M</i>Mira</span><b>₹620.00</b></div><div className="preview-members"><span><i>Y</i>You</span><b>₹620.00</b></div><div className="preview-total"><span>Recorded in paise</span><b>₹2,480</b></div></div><p>Balances follow the actual split. A suggestion is never recorded as a payment until someone confirms it.</p></div></aside></main>;
}

function LandingScreen({ onSignup, onSignin }) {
  return <main className="landing-page">
    <header className="landing-nav"><a className="brand" href="#top"><span className="brand-symbol">s</span><span>split<span>smart</span></span></a><nav aria-label="Site navigation"><a href="#how">How it works</a><a href="#features">Features</a><a href="#privacy">Privacy</a></nav><div><button className="landing-signin" onClick={onSignin}>Sign in</button><button className="button button-primary landing-start" onClick={onSignup}>Get started <span>→</span></button></div></header>
    <section className="landing-hero" id="top"><div className="landing-hero-copy"><span className="eyebrow"><i/> THE SHARED LEDGER FOR EVERYDAY LIFE</span><h1>SplitSmart</h1><p className="hero-line">Shared expenses. Sorted.</p><p className="hero-description">Track group spending, split bills fairly, and settle up without the awkward calculations.</p><div className="landing-actions"><button className="button button-primary" onClick={onSignup}>Get started <span>→</span></button><button className="hero-secondary" onClick={onSignin}>I already have an account</button></div><div className="landing-assurance"><span>✓</span> Clear balances. Confirmed payments. No guesswork.</div></div>
      <div className="landing-ledger" aria-label="Illustrative SplitSmart group expense preview"><div className="ledger-top"><span><i/> EXAMPLE GROUP · GOA WEEKEND</span><b>INR ₹</b></div><div className="ledger-title"><div><span className="eyebrow">GROUP SPENDING</span><h2>Every rupee, accounted for.</h2></div><span className="ledger-icon">↗</span></div><div className="ledger-total"><span>Recent expenses</span><b>₹2,200.00</b></div><div className="ledger-row"><span className="ledger-category">♨</span><span className="ledger-item"><b>Dinner at Thalassa</b><small>Paid by Aisha · Food & Dining</small></span><strong>₹1,800.00</strong></div><div className="ledger-row"><span className="ledger-category transport">↗</span><span className="ledger-item"><b>Airport cab</b><small>Paid by Raj · Transportation</small></span><strong>₹400.00</strong></div><div className="ledger-settle"><span><i>R</i><b>Raj pays Aisha</b></span><strong>₹250.00</strong><small>Suggested · not marked paid</small></div><div className="ledger-bottom"><span>Example values</span><span>Stored as integer paise</span></div></div>
    </section>
    <section className="landing-how" id="how"><div className="landing-section-head"><span className="eyebrow">A CALMER WAY TO SHARE</span><h2>From “who paid?” to all square.</h2><p>Keep the group ledger clear, from the first bill to the final transfer.</p></div><div className="steps-grid"><article><span>01</span><h3>Start a group</h3><p>Create a space for a trip, home, family, or any shared plan.</p></article><article><span>02</span><h3>Record the costs</h3><p>Choose who paid, who joined in, and how each expense is split.</p></article><article><span>03</span><h3>Settle with clarity</h3><p>See who owes whom. Confirm payments only when they really happen.</p></article></div></section>
    <section className="landing-features" id="features"><div className="landing-section-head"><span className="eyebrow">MADE FOR REAL-LIFE SHARING</span><h2>Simple to enter. Clear to settle.</h2></div><div className="feature-grid"><article><span>＋</span><h3>Flexible splits</h3><p>Split equally, by exact amount, percentage, or weighted shares. Paise-level remainders are allocated deterministically.</p></article><article><span>⇄</span><h3>Useful settle-up</h3><p>Reduce a group’s outstanding balances to suggested payments. A suggestion never pretends that money changed hands.</p></article><article><span>✳</span><h3>Optional AI drafts</h3><p>Describe an expense in plain language. Review and edit the details before the same validated expense flow saves it.</p></article></div></section>
    <section className="landing-ai"><div><span className="eyebrow">OPTIONAL, NEVER IN CHARGE</span><h2>Write it like you’d tell a friend.</h2><p>“Dinner was ₹1,800. Aisha paid; split it between the four of us.” The assistant can prepare a draft. You stay in control of every field and every save.</p><button className="button button-light" onClick={onSignup}>Try SplitSmart <span>→</span></button></div><div className="ai-sample"><span>YOUR MESSAGE</span><p>Dinner was ₹1,800. Aisha paid, split equally between the four of us.</p><i>↓</i><span>REVIEWABLE DRAFT</span><div><b>Dinner</b><strong>₹1,800.00</strong></div><small>Check the payer, people, and split before saving.</small></div></section>
    <section className="landing-security" id="privacy"><div className="security-icon">⌑</div><div><span className="eyebrow">YOUR GROUP IS YOURS</span><h2>Private by design.</h2><p>Group access is checked in the database, not just hidden in the interface. Financial entries use integer minor units, and private receipts are never public by default.</p></div><span className="security-note">Supabase Auth + PostgreSQL RLS</span></section>
    <section className="landing-faq"><div className="landing-section-head"><span className="eyebrow">GOOD TO KNOW</span><h2>Questions, answered.</h2></div><div className="faq-list"><details><summary>Do I need AI to use SplitSmart?</summary><p>No. Add and split expenses manually; AI is an optional shortcut.</p></details><details><summary>Does a suggested payment count as completed?</summary><p>No. Only a payer-confirmed payment changes the group balance.</p></details><details><summary>Can someone join without an account?</summary><p>Group owners and admins can add a guest member by name. Guests do not receive account access.</p></details><details><summary>How are amounts rounded?</summary><p>Amounts are stored in integer minor units. Equal splits distribute remainder paise deterministically.</p></details></div></section>
    <footer className="landing-footer"><a className="brand" href="#top"><span className="brand-symbol">s</span><span>split<span>smart</span></span></a><span>Shared expenses, sorted.</span><button onClick={onSignin}>Sign in <span>→</span></button></footer>
  </main>;
}

function ConfigurationScreen() {
  return <main className="config-screen"><span className="brand-symbol">s</span><span className="eyebrow">SPLITSMART SETUP</span><h1>Connect your Supabase project</h1><p>Add the public project URL and anon key to <code>.env.local</code>. The app will not use demo data when configuration is missing.</p><div className="config-code">NEXT_PUBLIC_SUPABASE_URL=<br/>NEXT_PUBLIC_SUPABASE_ANON_KEY=</div><small>Use the project’s public anon key only. Never put a service-role key in the browser.</small></main>;
}