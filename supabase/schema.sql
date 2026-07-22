-- Paste this into the Supabase SQL Editor and click "Run".
-- Dashboard: your project → SQL Editor → New query.

create extension if not exists "pgcrypto";

create table if not exists public.receipts (
  id           uuid primary key default gen_random_uuid(),
  date         date,
  amount       numeric(14, 2),
  currency     text,
  item         text not null default '',
  description  text not null default '',
  url          text not null default '',
  file_name    text,
  kind         text not null default 'payment',
  value        numeric(14, 2),
  owner        text,
  created_at   timestamptz not null default now()
);

-- If upgrading from an older schema, add the columns in place.
alter table public.receipts
  add column if not exists kind  text not null default 'payment';
alter table public.receipts
  add column if not exists value numeric(14, 2);
alter table public.receipts
  add column if not exists owner text;

create index if not exists receipts_date_idx on public.receipts (date nulls last, created_at);

-- Row-level security. This is a personal tool with no auth: policies below
-- allow anyone with the anon key to read/write. If you deploy publicly, add
-- Supabase Auth and tighten these policies (e.g. `auth.uid() = user_id`).
alter table public.receipts enable row level security;

drop policy if exists "anon read"   on public.receipts;
drop policy if exists "anon insert" on public.receipts;
drop policy if exists "anon update" on public.receipts;
drop policy if exists "anon delete" on public.receipts;

create policy "anon read"   on public.receipts for select using (true);
create policy "anon insert" on public.receipts for insert with check (true);
create policy "anon update" on public.receipts for update using (true) with check (true);
create policy "anon delete" on public.receipts for delete using (true);
