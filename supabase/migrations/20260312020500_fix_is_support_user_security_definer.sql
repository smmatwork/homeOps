-- Fix is_support_user() so it can be used safely inside RLS without requiring direct SELECT on support_users

create or replace function public.is_support_user() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.support_users su
    where su.user_id = auth.uid()
  );
$$;
