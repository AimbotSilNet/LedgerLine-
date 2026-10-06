-- Ledgerline · database schema (DATA.md)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run once on a new project.
-- Every table belongs to one signed-in user (row-level security). Bank tokens live in plaid_secrets,
-- which the app can never read: only the server functions can.

create table if not exists public.accounts (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  type             text not null check (type in ('bank','alt','invest','card')),
  name             text not null,
  ccy              text not null default 'CAD',
  source           text not null default 'manual',          -- manual | plaid
  plaid_item_id    text,
  plaid_account_id text unique,
  mask             text,
  institution      text,
  subtype          text,
  hidden           boolean not null default false,          -- deleted, or "don't track"
  review           boolean not null default false,          -- found by a sync, waiting for Add / Ignore
  data             jsonb not null default '{}'::jsonb,      -- limit, cash {CAD,USD}, sort, …
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.balances (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  account_id text not null,
  date       date not null,
  value      numeric not null,                              -- cards: amount owed, positive
  source     text not null default 'manual',                -- manual | plaid | statement
  note       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id, date)
);

create table if not exists public.transactions (
  id                   text primary key,
  user_id              uuid not null default auth.uid() references auth.users on delete cascade,
  account_id           text not null default '',
  date                 date not null,
  description          text not null default '',
  amount               numeric not null,                    -- > 0 is money out (Plaid's sign)
  category             text not null default 'Other',
  source               text not null default 'manual',      -- manual | csv | pdf | plaid
  pending              boolean not null default false,
  plaid_transaction_id text unique,
  data                 jsonb not null default '{}'::jsonb,  -- data.auto = false: you set the category
  updated_at           timestamptz not null default now()
);
create index if not exists transactions_user_date on public.transactions (user_id, date);

create table if not exists public.holdings (
  id         text primary key,                              -- Plaid: ph_<account>_<security>
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  account_id text not null,
  data       jsonb not null default '{}'::jsonb,            -- data.tickerOverride survives syncs
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id         text primary key,                              -- Plaid: pt_<id>
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  account_id text not null,
  date       date not null,
  data       jsonb not null default '{}'::jsonb,            -- data.hid links the holding, data.cashAmt
  updated_at timestamptz not null default now()
);

create table if not exists public.docs (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  path       text not null,                                 -- config/settings, prices/latest, history/daily, …
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

create table if not exists public.plaid_items (
  item_id          text primary key,
  user_id          uuid not null references auth.users on delete cascade,
  institution_name text,
  institution_id   text,
  products         text[] not null default '{}',
  status           text not null default 'ok',              -- ok | login_required | new_accounts | pending_expiration | error
  error            text,
  cursor           text,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists public.plaid_secrets (
  item_id      text primary key references public.plaid_items on delete cascade,
  user_id      uuid not null references auth.users on delete cascade,
  access_token text not null
);

-- Row-level security: you see and change only your own rows.
do $$
declare t text;
begin
  foreach t in array array['accounts','balances','transactions','holdings','trades','docs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

-- Bank logins: readable by the app, never writable from it.
alter table public.plaid_items enable row level security;
drop policy if exists own_items on public.plaid_items;
create policy own_items on public.plaid_items for select to authenticated using (user_id = auth.uid());
alter table public.plaid_items replica identity full;

-- Access tokens: no policies at all, so only the server functions (service role) can touch them.
alter table public.plaid_secrets enable row level security;
revoke all on public.plaid_secrets from anon, authenticated;

-- Live updates: the phone hears about synced balances and transactions as they land.
do $$
declare t text;
begin
  foreach t in array array['accounts','balances','transactions','holdings','trades','docs','plaid_items'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
