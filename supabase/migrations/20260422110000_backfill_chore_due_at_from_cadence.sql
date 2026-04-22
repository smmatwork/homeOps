-- Backfill: set due_at on every chore that has metadata->>'cadence' but
-- NULL due_at. These chores came from the onboarding flow which, before the
-- OnboardingPanel fix, inserted chores without a due date — they never
-- surfaced in DayFocusView's today / tomorrow / this_week buckets.
--
-- Mirrors the logic in src/app/services/firstDueAt.ts so the first occurrence
-- lands on the same date whether the chore was created via onboarding
-- (frontend) or via this backfill. Subsequent occurrences are handled by
-- the existing rollover / scheduler flows.
--
-- Idempotent: only touches chores that are still due_at IS NULL. Safe to
-- run multiple times; a second run is a no-op once all chores have dates.

DO $$
DECLARE
    v_today_start timestamptz;
    v_morning time := '09:00:00';
BEGIN
    v_today_start := date_trunc('day', now());

    -- Helper CTE: compute first_due for each nullable-due chore. Uses
    -- household tz when available, else UTC. The `cadence` column is
    -- stored in chores.metadata->>'cadence'.
    WITH nth_weekday AS (
        -- Generic: find the Nth <dow> on-or-after v_today_start, within
        -- the next 60 days. Used for weekly_<dow>, biweekly_<dow>,
        -- monthly_Nth_<dow>.
        SELECT
            day::date AS d,
            EXTRACT(DOW FROM day) AS dow,
            (EXTRACT(DAY FROM day)::int - 1) / 7 + 1 AS nth_in_month
        FROM generate_series(v_today_start::date, v_today_start::date + 60, interval '1 day') day
    ),
    candidates AS (
        SELECT
            c.id,
            lower(trim(coalesce(c.metadata->>'cadence', ''))) AS cad
        FROM public.chores c
        WHERE c.due_at IS NULL
          AND c.deleted_at IS NULL
    ),
    computed AS (
        SELECT
            cand.id,
            cand.cad,
            CASE
                -- Daily / alternate_days / every_N_days / unknown → today 09:00
                WHEN cand.cad = '' OR cand.cad = 'daily' OR cand.cad = 'alternate_days'
                     OR cand.cad ~ '^every_\d+_days$'
                THEN v_today_start + (v_morning - time '00:00:00')

                -- weekly_<dow> / biweekly_<dow> — first upcoming matching weekday
                WHEN cand.cad ~ '^(weekly|biweekly)_(sun|mon|tue|wed|thu|fri|sat)$' THEN (
                    SELECT d + (v_morning - time '00:00:00')
                    FROM nth_weekday w
                    WHERE w.dow = CASE split_part(cand.cad, '_', 2)
                        WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2
                        WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5
                        WHEN 'sat' THEN 6 END
                    ORDER BY d LIMIT 1
                )

                -- Plain weekly / biweekly → next Saturday
                WHEN cand.cad IN ('weekly', 'biweekly') THEN (
                    SELECT d + (v_morning - time '00:00:00')
                    FROM nth_weekday w
                    WHERE w.dow = 6
                    ORDER BY d LIMIT 1
                )

                -- monthly_Nth_<dow>
                WHEN cand.cad ~ '^monthly_(1st|2nd|3rd|4th)_(sun|mon|tue|wed|thu|fri|sat)$' THEN (
                    SELECT d + (v_morning - time '00:00:00')
                    FROM nth_weekday w
                    WHERE w.dow = CASE split_part(cand.cad, '_', 3)
                            WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2
                            WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5
                            WHEN 'sat' THEN 6 END
                      AND w.nth_in_month = CASE split_part(cand.cad, '_', 2)
                            WHEN '1st' THEN 1 WHEN '2nd' THEN 2
                            WHEN '3rd' THEN 3 WHEN '4th' THEN 4 END
                    ORDER BY d LIMIT 1
                )

                -- Plain monthly → today + 7 days
                WHEN cand.cad = 'monthly' THEN
                    v_today_start + interval '7 days' + (v_morning - time '00:00:00')

                -- Fall-through: anything else → today
                ELSE v_today_start + (v_morning - time '00:00:00')
            END AS first_due
        FROM candidates cand
    )
    UPDATE public.chores c
    SET due_at = computed.first_due
    FROM computed
    WHERE c.id = computed.id
      AND c.due_at IS NULL;  -- double-guard: skip if another process set it meanwhile

    RAISE NOTICE 'Backfilled due_at on % chores', (SELECT COUNT(*) FROM public.chores WHERE due_at IS NOT NULL AND metadata->>'cadence' IS NOT NULL);
END $$;
