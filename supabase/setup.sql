-- Plat Book: run this once in Supabase → SQL Editor → New query → Run.
-- It creates a shared workspace that ONLY the emails in public.members can read or change.
-- Everyone else, signed in or not, gets nothing back.

create extension if not exists pgcrypto;

-- 1. The team list. Put your two emails in at the bottom of this file.
create table if not exists public.members (
  email text primary key check (email = lower(email))
);
alter table public.members enable row level security;
revoke all on public.members from anon, authenticated;   -- nobody reads the list directly

-- 2. A yes/no check the app and the rules below can call.
create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.members where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- 3. Deals. Each row is one property you're looking at, stored as flexible JSON so new
--    fields can be added in the app without touching the database again.
create table if not exists public.deals (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.deals enable row level security;
revoke all on public.deals from anon;
grant select, insert, update, delete on public.deals to authenticated;

drop policy if exists "team reads"   on public.deals;
drop policy if exists "team adds"    on public.deals;
drop policy if exists "team edits"   on public.deals;
drop policy if exists "team removes" on public.deals;
create policy "team reads"   on public.deals for select using (public.is_member());
create policy "team adds"    on public.deals for insert with check (public.is_member());
create policy "team edits"   on public.deals for update using (public.is_member()) with check (public.is_member());
create policy "team removes" on public.deals for delete using (public.is_member());

-- 4. Your team. Replace these with the two emails you'll sign in with, then run.
--    To add someone later, run just this line with their email.
insert into public.members (email) values
  ('your-email@example.com'),
  ('wills-email@example.com')
on conflict do nothing;
