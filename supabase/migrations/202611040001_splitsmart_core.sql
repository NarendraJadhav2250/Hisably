begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  avatar_url text,
  preferred_currency text not null default 'INR' check (preferred_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  created_by uuid not null references auth.users(id),
  owner_id uuid references auth.users(id),
  description text,
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  icon text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.groups add column if not exists owner_id uuid references auth.users(id);
alter table public.groups add column if not exists description text;
alter table public.groups add column if not exists currency text not null default 'INR';
alter table public.groups add column if not exists icon text;
alter table public.groups add column if not exists archived_at timestamptz;
alter table public.groups add column if not exists updated_at timestamptz not null default now();
update public.groups set owner_id = created_by where owner_id is null;
alter table public.groups alter column owner_id set not null;

create table if not exists public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null default '',
  email text,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  membership_status text not null default 'active' check (membership_status in ('active', 'left', 'removed')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.group_members add column if not exists id uuid default gen_random_uuid();
alter table public.group_members add column if not exists display_name text not null default '';
alter table public.group_members add column if not exists email text;
alter table public.group_members add column if not exists role text not null default 'member';
alter table public.group_members add column if not exists membership_status text not null default 'active';
alter table public.group_members add column if not exists joined_at timestamptz not null default now();
alter table public.group_members add column if not exists created_at timestamptz not null default now();
alter table public.group_members add column if not exists updated_at timestamptz not null default now();
alter table public.group_members alter column id set not null;
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.group_members'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (group_id, user_id)'
  ) then
    alter table public.group_members drop constraint group_members_pkey;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.group_members'::regclass and contype = 'p'
  ) then
    alter table public.group_members add constraint group_members_pkey primary key (id);
  end if;
end $$;
alter table public.group_members alter column user_id drop not null;
alter table public.group_members drop constraint if exists group_members_user_id_fkey;
alter table public.group_members add constraint group_members_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
update public.group_members gm
set display_name = coalesce(nullif(gm.display_name, ''), p.full_name, u.email, 'Member')
from auth.users u
left join public.profiles p on p.id = u.id
where gm.user_id = u.id and gm.display_name = '';
update public.group_members gm
set role = 'owner'
from public.groups g
where gm.group_id = g.id and gm.user_id = g.owner_id and gm.role = 'member';
create unique index if not exists group_members_active_user_idx
  on public.group_members(group_id, user_id)
  where user_id is not null and membership_status = 'active';
create index if not exists group_members_group_idx on public.group_members(group_id, membership_status);

do $$
begin
  if to_regprocedure('public.join_group(text)') is not null then
    execute 'revoke all on function public.join_group(text) from public';
    execute 'revoke all on function public.join_group(text) from anon, authenticated';
  end if;
end $$;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  emoji text default '🧾',
  paid_by text not null,
  amount numeric not null default 0,
  group_id uuid references public.groups(id) on delete cascade,
  description text,
  amount_minor bigint,
  currency text not null default 'INR',
  paid_by_member_id uuid references public.group_members(id) on delete restrict,
  category text not null default 'Other',
  expense_date date not null default current_date,
  notes text,
  receipt_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.expenses add column if not exists group_id uuid references public.groups(id) on delete cascade;
alter table public.expenses add column if not exists description text;
alter table public.expenses add column if not exists amount_minor bigint;
alter table public.expenses add column if not exists currency text not null default 'INR';
alter table public.expenses add column if not exists paid_by_member_id uuid references public.group_members(id) on delete restrict;
alter table public.expenses add column if not exists category text not null default 'Other';
alter table public.expenses add column if not exists expense_date date not null default current_date;
alter table public.expenses add column if not exists notes text;
alter table public.expenses add column if not exists receipt_path text;
alter table public.expenses add column if not exists created_by uuid references auth.users(id);
alter table public.expenses add column if not exists updated_at timestamptz not null default now();
alter table public.expenses add column if not exists deleted_at timestamptz;
alter table public.expenses alter column user_id drop not null;
alter table public.expenses drop constraint if exists expenses_user_id_fkey;
alter table public.expenses add constraint expenses_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
update public.expenses
set amount_minor = round(amount * 100)::bigint,
    description = coalesce(description, name),
    created_by = coalesce(created_by, user_id)
where amount_minor is null;
create index if not exists expenses_group_date_idx on public.expenses(group_id, expense_date desc) where deleted_at is null;

create table if not exists public.expense_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.group_members(id) on delete restrict,
  share_minor bigint not null check (share_minor >= 0),
  split_type text not null check (split_type in ('equal', 'exact', 'percentage', 'shares')),
  split_value numeric,
  created_at timestamptz not null default now(),
  unique (expense_id, member_id)
);
create index if not exists expense_splits_member_idx on public.expense_splits(member_id, expense_id);

create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  payer_member_id uuid not null references public.group_members(id) on delete restrict,
  recipient_member_id uuid not null references public.group_members(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  payment_method text,
  reference text,
  created_by uuid not null references auth.users(id),
  idempotency_key uuid not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payer_member_id <> recipient_member_id),
  unique (group_id, created_by, idempotency_key)
);
create index if not exists settlements_group_status_idx on public.settlements(group_id, status, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid references public.groups(id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_group_member(gid uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid() and gm.membership_status = 'active'
  );
$$;

create or replace function public.is_group_admin(group_uuid uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = group_uuid and gm.user_id = auth.uid()
      and gm.membership_status = 'active' and gm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_group_member(uuid) from public;
revoke all on function public.is_group_admin(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_admin(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlements enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists "see my groups" on public.groups;
drop policy if exists "create groups" on public.groups;
drop policy if exists "see my memberships" on public.group_members;
drop policy if exists "join groups" on public.group_members;
drop policy if exists "read own expenses" on public.expenses;
drop policy if exists "insert own expenses" on public.expenses;
drop policy if exists "update own expenses" on public.expenses;
drop policy if exists "delete own expenses" on public.expenses;
drop policy if exists "see group expenses" on public.expenses;
drop policy if exists "add group expenses" on public.expenses;
drop policy if exists "delete group expenses" on public.expenses;

create policy "profiles_read_self" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles_insert_self" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles_update_self" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "groups_read_members" on public.groups for select to authenticated using (public.is_group_member(id));
create policy "members_read_group" on public.group_members for select to authenticated using (public.is_group_member(group_id));
create policy "expenses_read_group" on public.expenses for select to authenticated using (group_id is not null and public.is_group_member(group_id));
create policy "splits_read_group" on public.expense_splits for select to authenticated using (
  exists (select 1 from public.expenses e where e.id = expense_id and public.is_group_member(e.group_id))
);
create policy "settlements_read_group" on public.settlements for select to authenticated using (public.is_group_member(group_id));
create policy "notifications_read_self" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notifications_update_self" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "audit_read_admins" on public.audit_events for select to authenticated using (public.is_group_admin(group_id));

revoke insert, update, delete on public.groups, public.group_members, public.expenses,
  public.expense_splits, public.settlements, public.audit_events from anon, authenticated;
grant select on public.profiles, public.groups, public.group_members, public.expenses,
  public.expense_splits, public.settlements, public.notifications, public.audit_events to authenticated;
grant insert, update on public.profiles to authenticated;
grant update on public.notifications to authenticated;

create or replace function public.create_group(p_name text, p_currency text default 'INR', p_description text default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_group_id uuid;
  v_name text := trim(p_name);
  v_display_name text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if v_name = '' or length(v_name) > 80 then raise exception 'Group name must be between 1 and 80 characters'; end if;
  if p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;
  select coalesce(nullif(full_name, ''), (select email from auth.users where id = v_user_id), 'You')
    into v_display_name from public.profiles where id = v_user_id;
  if v_display_name is null then
    select coalesce(email, 'You') into v_display_name from auth.users where id = v_user_id;
  end if;
  insert into public.groups(name, created_by, owner_id, description, currency)
    values (v_name, v_user_id, v_user_id, nullif(trim(p_description), ''), p_currency)
    returning id into v_group_id;
  insert into public.group_members(group_id, user_id, display_name, role, membership_status)
    values (v_group_id, v_user_id, v_display_name, 'owner', 'active');
  insert into public.audit_events(group_id, actor_id, event_type, entity_type, entity_id)
    values (v_group_id, v_user_id, 'group.created', 'group', v_group_id);
  return v_group_id;
end;
$$;

create or replace function public.add_guest_member(p_group_id uuid, p_display_name text, p_email text default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_member_id uuid;
begin
  if auth.uid() is null or not public.is_group_admin(p_group_id) then raise exception 'Group admin access required'; end if;
  if trim(p_display_name) = '' or length(trim(p_display_name)) > 100 then raise exception 'Member name is required'; end if;
  insert into public.group_members(group_id, display_name, email, role, membership_status)
    values (p_group_id, trim(p_display_name), nullif(trim(p_email), ''), 'member', 'active')
    returning id into v_member_id;
  insert into public.audit_events(group_id, actor_id, event_type, entity_type, entity_id)
    values (p_group_id, auth.uid(), 'member.guest_added', 'group_member', v_member_id);
  return v_member_id;
end;
$$;

create or replace function public.create_expense(
  p_group_id uuid,
  p_description text,
  p_amount_minor bigint,
  p_currency text,
  p_category text,
  p_expense_date date,
  p_paid_by_member_id uuid,
  p_split_method text,
  p_splits jsonb,
  p_notes text default null
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_expense_id uuid;
  v_payer_name text;
  v_item jsonb;
  v_member_id uuid;
  v_value numeric;
  v_total_value numeric := 0;
  v_amount bigint;
  v_allocated bigint := 0;
  v_share bigint;
  v_count integer;
  v_index integer := 0;
begin
  if auth.uid() is null or not public.is_group_member(p_group_id) then raise exception 'Group membership required'; end if;
  perform 1 from public.groups where id = p_group_id for update;
  if p_description is null or trim(p_description) = '' or length(trim(p_description)) > 160 then raise exception 'Expense description is required'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 9000000000000000 then raise exception 'Invalid expense amount'; end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;
  if not exists (select 1 from public.groups where id = p_group_id and currency = p_currency) then
    raise exception 'Expense currency must match the group currency';
  end if;
  if p_split_method is null or p_split_method not in ('equal', 'exact', 'percentage', 'shares') then raise exception 'Unsupported split method'; end if;
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then raise exception 'At least one participant is required'; end if;
  select count(*), coalesce(sum((item->>'value')::numeric), 0)
    into v_count, v_total_value from jsonb_array_elements(p_splits) item;
  if v_count <> (select count(distinct item->>'member_id') from jsonb_array_elements(p_splits) item) then raise exception 'Duplicate participants are not allowed'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_splits) item
    left join public.group_members gm on gm.id = (item->>'member_id')::uuid
      and gm.group_id = p_group_id and gm.membership_status = 'active'
    where gm.id is null
  ) then raise exception 'Every participant must be an active group member'; end if;
  select display_name into v_payer_name from public.group_members
    where id = p_paid_by_member_id and group_id = p_group_id and membership_status = 'active';
  if v_payer_name is null then raise exception 'Payer must be an active group member'; end if;
  if p_split_method = 'exact' and v_total_value <> p_amount_minor then raise exception 'Exact shares must equal the expense total'; end if;
  if p_split_method = 'percentage' and v_total_value <> 100 then raise exception 'Percentages must total 100'; end if;
  if p_split_method in ('percentage', 'shares') and exists (
    select 1 from jsonb_array_elements(p_splits) item where (item->>'value')::numeric <= 0
  ) then raise exception 'Split values must be positive'; end if;
  if p_split_method = 'exact' and exists (
    select 1 from jsonb_array_elements(p_splits) item
    where (item->>'value')::numeric < 0 or trunc((item->>'value')::numeric) <> (item->>'value')::numeric
  ) then raise exception 'Exact shares must be whole minor units'; end if;
  if p_split_method = 'shares' and exists (
    select 1 from jsonb_array_elements(p_splits) item where trunc((item->>'value')::numeric) <> (item->>'value')::numeric
  ) then raise exception 'Share weights must be integers'; end if;

  insert into public.expenses(user_id, name, paid_by, amount, group_id, description, amount_minor,
    currency, paid_by_member_id, category, expense_date, notes, created_by)
  values (auth.uid(), trim(p_description), v_payer_name, p_amount_minor / 100.0, p_group_id,
    trim(p_description), p_amount_minor, p_currency, p_paid_by_member_id, coalesce(nullif(trim(p_category), ''), 'Other'),
    coalesce(p_expense_date, current_date), nullif(trim(p_notes), ''), auth.uid())
  returning id into v_expense_id;

  for v_item in select value from jsonb_array_elements(p_splits) loop
    v_index := v_index + 1;
    v_member_id := (v_item->>'member_id')::uuid;
    v_value := (v_item->>'value')::numeric;
    if p_split_method = 'exact' then
      v_share := v_value::bigint;
    elsif p_split_method = 'equal' then
      v_share := floor(p_amount_minor::numeric / v_count)::bigint;
      if v_index <= mod(p_amount_minor, v_count) then v_share := v_share + 1; end if;
    else
      if p_split_method = 'percentage' then v_amount := 100; else v_amount := v_total_value::bigint; end if;
      if v_index = v_count then
        v_share := p_amount_minor - v_allocated;
      else
        v_share := floor(p_amount_minor::numeric * v_value / v_amount)::bigint;
      end if;
    end if;
    v_allocated := v_allocated + v_share;
    insert into public.expense_splits(expense_id, member_id, share_minor, split_type, split_value)
      values (v_expense_id, v_member_id, v_share, p_split_method, v_value);
  end loop;
  if v_allocated <> p_amount_minor then raise exception 'Expense split does not reconcile'; end if;
  insert into public.audit_events(group_id, actor_id, event_type, entity_type, entity_id)
    values (p_group_id, auth.uid(), 'expense.created', 'expense', v_expense_id);
  return v_expense_id;
end;
$$;

create or replace function public.record_settlement(
  p_group_id uuid,
  p_payer_member_id uuid,
  p_recipient_member_id uuid,
  p_amount_minor bigint,
  p_idempotency_key uuid,
  p_completed boolean default false
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_settlement_id uuid;
  v_is_payer boolean;
  v_is_recipient boolean;
  v_payer_balance bigint;
  v_recipient_balance bigint;
  v_existing public.settlements%rowtype;
begin
  if auth.uid() is null or not public.is_group_member(p_group_id) then raise exception 'Group membership required'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 9000000000000000 or p_payer_member_id = p_recipient_member_id or p_idempotency_key is null then raise exception 'Invalid settlement'; end if;
  perform 1 from public.groups where id = p_group_id for update;
  if not exists (select 1 from public.group_members where id = p_payer_member_id and group_id = p_group_id and membership_status = 'active')
    or not exists (select 1 from public.group_members where id = p_recipient_member_id and group_id = p_group_id and membership_status = 'active') then
    raise exception 'Settlement members must be active members of this group';
  end if;
  select exists(select 1 from public.group_members where id = p_payer_member_id and user_id = auth.uid()),
         exists(select 1 from public.group_members where id = p_recipient_member_id and user_id = auth.uid())
    into v_is_payer, v_is_recipient;
  if p_completed and not v_is_payer then raise exception 'Only the payer can confirm a completed payment'; end if;
  if not p_completed and not (v_is_payer or v_is_recipient) then raise exception 'Only a settlement participant can record a payment'; end if;
  select * into v_existing from public.settlements
    where group_id = p_group_id and created_by = auth.uid() and idempotency_key = p_idempotency_key for update;
  if found then
    if v_existing.payer_member_id <> p_payer_member_id
      or v_existing.recipient_member_id <> p_recipient_member_id or v_existing.amount_minor <> p_amount_minor then
      raise exception 'Idempotency key was already used for a different payment';
    end if;
    if v_existing.status <> 'pending' or not p_completed then return v_existing.id; end if;
  end if;
  select
    coalesce((select sum(e.amount_minor) from public.expenses e where e.group_id = p_group_id and e.paid_by_member_id = p_payer_member_id and e.deleted_at is null), 0)
    - coalesce((select sum(s.share_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id where e.group_id = p_group_id and e.deleted_at is null and s.member_id = p_payer_member_id), 0)
    + coalesce((select sum(st.amount_minor) from public.settlements st where st.group_id = p_group_id and st.status = 'completed' and st.payer_member_id = p_payer_member_id), 0)
    - coalesce((select sum(st.amount_minor) from public.settlements st where st.group_id = p_group_id and st.status = 'completed' and st.recipient_member_id = p_payer_member_id), 0)
    into v_payer_balance;
  select
    coalesce((select sum(e.amount_minor) from public.expenses e where e.group_id = p_group_id and e.paid_by_member_id = p_recipient_member_id and e.deleted_at is null), 0)
    - coalesce((select sum(s.share_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id where e.group_id = p_group_id and e.deleted_at is null and s.member_id = p_recipient_member_id), 0)
    + coalesce((select sum(st.amount_minor) from public.settlements st where st.group_id = p_group_id and st.status = 'completed' and st.payer_member_id = p_recipient_member_id), 0)
    - coalesce((select sum(st.amount_minor) from public.settlements st where st.group_id = p_group_id and st.status = 'completed' and st.recipient_member_id = p_recipient_member_id), 0)
    into v_recipient_balance;
  if v_payer_balance >= 0 or v_recipient_balance <= 0 or p_amount_minor > least(-v_payer_balance, v_recipient_balance) then
    raise exception 'Settlement amount exceeds the current outstanding balances';
  end if;
  if v_existing.id is not null then
    update public.settlements set status = 'completed', completed_at = now(), updated_at = now()
      where id = v_existing.id;
    v_settlement_id := v_existing.id;
  else
    insert into public.settlements(group_id, payer_member_id, recipient_member_id, amount_minor,
      currency, status, created_by, idempotency_key, completed_at)
    select p_group_id, p_payer_member_id, p_recipient_member_id, p_amount_minor,
      g.currency, case when p_completed then 'completed' else 'pending' end, auth.uid(), p_idempotency_key,
      case when p_completed then now() else null end
    from public.groups g where g.id = p_group_id
    returning id into v_settlement_id;
  end if;
  insert into public.audit_events(group_id, actor_id, event_type, entity_type, entity_id)
    values (p_group_id, auth.uid(), case when p_completed then 'settlement.completed' else 'settlement.pending' end, 'settlement', v_settlement_id);
  return v_settlement_id;
end;
$$;

revoke all on function public.create_group(text, text, text) from public;
revoke all on function public.add_guest_member(uuid, text, text) from public;
revoke all on function public.create_expense(uuid, text, bigint, text, text, date, uuid, text, jsonb, text) from public;
revoke all on function public.record_settlement(uuid, uuid, uuid, bigint, uuid, boolean) from public;
revoke all on function public.create_group(text, text, text) from anon, authenticated;
revoke all on function public.add_guest_member(uuid, text, text) from anon, authenticated;
revoke all on function public.create_expense(uuid, text, bigint, text, text, date, uuid, text, jsonb, text) from anon, authenticated;
revoke all on function public.record_settlement(uuid, uuid, uuid, bigint, uuid, boolean) from anon, authenticated;
grant execute on function public.create_group(text, text, text) to authenticated;
grant execute on function public.add_guest_member(uuid, text, text) to authenticated;
grant execute on function public.create_expense(uuid, text, bigint, text, text, date, uuid, text, jsonb, text) to authenticated;
grant execute on function public.record_settlement(uuid, uuid, uuid, bigint, uuid, boolean) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('group-receipts', 'group-receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

drop policy if exists "group_receipts_read" on storage.objects;
drop policy if exists "group_receipts_insert" on storage.objects;
drop policy if exists "group_receipts_delete" on storage.objects;
create policy "group_receipts_read" on storage.objects for select to authenticated
  using (bucket_id = 'group-receipts' and public.is_group_member((storage.foldername(name))[1]::uuid));
create policy "group_receipts_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'group-receipts' and public.is_group_member((storage.foldername(name))[1]::uuid));
create policy "group_receipts_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'group-receipts' and public.is_group_admin((storage.foldername(name))[1]::uuid));

commit;