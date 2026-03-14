-- App feedback & ratings

create table if not exists public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid null references public.households(id) on delete set null,
  rating smallint not null check (rating >= 1 and rating <= 5),
  message text null,
  page text null,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.app_feedback enable row level security;

create policy "app_feedback_insert_own"
  on public.app_feedback
  for insert
  with check (auth.uid() = user_id);

create policy "app_feedback_select_own"
  on public.app_feedback
  for select
  using (auth.uid() = user_id);

create policy "app_feedback_select_support"
  on public.app_feedback
  for select
  using (public.is_support_user());

create index if not exists app_feedback_user_id_idx on public.app_feedback(user_id);
create index if not exists app_feedback_household_id_idx on public.app_feedback(household_id);
