-- Household invites

create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  invited_email text not null,
  role text not null default 'member' check (role = any (array['member'::text, 'admin'::text, 'owner'::text])),
  token uuid not null unique,
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz
);

create index if not exists household_invites_household_id_idx on public.household_invites (household_id);
create index if not exists household_invites_token_idx on public.household_invites (token);
create index if not exists household_invites_invited_email_idx on public.household_invites (invited_email);

alter table public.household_invites enable row level security;

-- Admins of a household can view invites for their household
create policy "household_invites_select_admin" on public.household_invites
for select
to authenticated
using (
  exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_invites.household_id
      and hm.user_id = auth.uid()
      and hm.role in ('admin','owner')
  )
);

-- Admins of a household can create invites
create policy "household_invites_insert_admin" on public.household_invites
for insert
to authenticated
with check (
  exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_invites.household_id
      and hm.user_id = auth.uid()
      and hm.role in ('admin','owner')
  )
);

-- Admins can revoke invites (update)
create policy "household_invites_update_admin" on public.household_invites
for update
to authenticated
using (
  exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_invites.household_id
      and hm.user_id = auth.uid()
      and hm.role in ('admin','owner')
  )
)
with check (
  exists (
    select 1
    from public.household_members hm
    where hm.household_id = household_invites.household_id
      and hm.user_id = auth.uid()
      and hm.role in ('admin','owner')
  )
);
