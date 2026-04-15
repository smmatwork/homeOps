-- helper_outreach_attempts TTL: 3 months
--
-- This table accumulates delivery-attempt state for every outreach to a
-- helper across every channel. It's transient state, not a record of
-- fact (consents and compensation are recorded in their own tables
-- with indefinite retention). We want to keep ~3 months of history for
-- debugging and support, but no more.
--
-- Enforcement is via a daily pg_cron job. Deletes are cheap because the
-- table has a btree index on `created_at`.
--
-- Note: pg_cron runs in the `postgres` database by default on
-- Supabase local and on Supabase cloud. The extension is idempotent.

create extension if not exists pg_cron;

-- Purge function — idempotent, safe to run as often as you like.
-- Exposed as a public function so ops can call it manually for
-- diagnostics. Not allowlisted in the edge function; only pg_cron
-- and service_role can schedule it.
create or replace function public.purge_stale_helper_outreach_attempts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  with deleted as (
    delete from public.helper_outreach_attempts
    where created_at < now() - interval '3 months'
    returning 1
  )
  select count(*) into v_deleted from deleted;
  return v_deleted;
end;
$$;

revoke all on function public.purge_stale_helper_outreach_attempts() from public;
grant execute on function public.purge_stale_helper_outreach_attempts() to service_role;

-- Schedule the daily purge. Uses cron's jobname feature (pg_cron ≥ 1.4)
-- so re-running this migration doesn't create duplicate jobs.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Remove any prior schedule with the same name to make this idempotent.
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'purge_helper_outreach_attempts_daily';

    -- Schedule the new job at 03:15 UTC every day.
    perform cron.schedule(
      'purge_helper_outreach_attempts_daily',
      '15 3 * * *',
      $purge$SELECT public.purge_stale_helper_outreach_attempts();$purge$
    );
  end if;
end;
$$;

comment on function public.purge_stale_helper_outreach_attempts() is
  'Deletes helper_outreach_attempts rows older than 3 months. Scheduled daily via pg_cron. (Phase 1.0)';
