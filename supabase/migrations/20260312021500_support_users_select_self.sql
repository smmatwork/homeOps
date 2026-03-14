-- Allow RLS policies to safely reference support_users without permission errors

alter table public.support_users enable row level security;

drop policy if exists support_users_select_self on public.support_users;

create policy support_users_select_self
  on public.support_users
  for select
  to authenticated
  using (user_id = auth.uid());

grant select on table public.support_users to authenticated;
