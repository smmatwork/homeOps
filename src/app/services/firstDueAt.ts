/**
 * Compute a sensible initial `due_at` for a newly-created chore based on its
 * cadence. Used by onboarding and the backfill script so every chore lands
 * with a concrete first date — chores with NULL due_at never surface in
 * DayFocusView's today/tomorrow/this_week buckets.
 *
 * Behaviour by cadence:
 *   - daily                 → today 09:00 (local)
 *   - alternate_days        → today 09:00
 *   - every_N_days          → today 09:00 (next occurrence derived by scheduler)
 *   - weekly_<day>          → next occurrence of that weekday, 09:00
 *   - weekly                → next Saturday, 09:00
 *   - biweekly_<day>        → next occurrence of that weekday, 09:00
 *   - biweekly              → next Saturday, 09:00
 *   - monthly               → 7 days from today, 09:00 (first sweep roughly a week out)
 *   - unknown / empty       → today 09:00 (fall-through so the chore still surfaces)
 *
 * The scheduler's `templateOccursOnDate` handles subsequent occurrences
 * during rollover; this helper only picks the FIRST due date so the chore
 * isn't invisible from day one.
 */

const DAY_OFFSETS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;


function atLocalMorning(base: Date, daysFromNow: number): Date {
  const out = new Date(base);
  out.setDate(out.getDate() + daysFromNow);
  out.setHours(DEFAULT_HOUR, DEFAULT_MINUTE, 0, 0);
  return out;
}


function daysUntilNextWeekday(today: Date, targetDow: number): number {
  const current = today.getDay(); // 0=Sun..6=Sat
  const diff = (targetDow - current + 7) % 7;
  // If target is today, fire today rather than next week. (Matches the
  // daily cadence intuition — the user expects this week's occurrence, not
  // a skip to next week.)
  return diff;
}


/**
 * Return the first sensible due_at (ISO string) for a chore with the given
 * cadence. Deterministic for a given `now` so tests can pin a clock.
 */
export function firstDueAtFromCadence(
  cadence: string | null | undefined,
  now: Date = new Date(),
): string {
  const raw = (cadence ?? "").trim().toLowerCase();

  // Fall-through cases — pick "today morning" so the chore is visible.
  if (!raw || raw === "daily" || raw === "alternate_days") {
    return atLocalMorning(now, 0).toISOString();
  }

  if (/^every_\d+_days$/.test(raw)) {
    // First occurrence is today; scheduler will handle subsequent ones.
    return atLocalMorning(now, 0).toISOString();
  }

  if (raw.startsWith("weekly_")) {
    const daySuffix = raw.slice(7);
    const targetDow = DAY_OFFSETS[daySuffix];
    if (targetDow !== undefined) {
      return atLocalMorning(now, daysUntilNextWeekday(now, targetDow)).toISOString();
    }
    // Unknown suffix — fall through to "weekly" default.
  }

  if (raw.startsWith("biweekly_")) {
    const daySuffix = raw.slice(9);
    const targetDow = DAY_OFFSETS[daySuffix];
    if (targetDow !== undefined) {
      return atLocalMorning(now, daysUntilNextWeekday(now, targetDow)).toISOString();
    }
  }

  // Plain "weekly" / "biweekly" — default to Saturday (matches the
  // generator's weekly_sat default for outdoor and cleaning templates).
  if (raw === "weekly" || raw === "biweekly") {
    return atLocalMorning(now, daysUntilNextWeekday(now, DAY_OFFSETS.sat)).toISOString();
  }

  // Monthly with Nth weekday (monthly_1st_sat, monthly_2nd_sun, etc.).
  // First occurrence = next upcoming Nth-<day> of this month or the next.
  const monthlyNth = /^monthly_(1st|2nd|3rd|4th)_([a-z]{3})$/.exec(raw);
  if (monthlyNth) {
    const nth = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 }[monthlyNth[1]];
    const targetDow = DAY_OFFSETS[monthlyNth[2]];
    if (nth !== undefined && targetDow !== undefined) {
      const candidate = nthWeekdayOfMonth(now.getFullYear(), now.getMonth(), nth, targetDow);
      const base = candidate >= startOfToday(now)
        ? candidate
        : nthWeekdayOfMonth(now.getFullYear(), now.getMonth() + 1, nth, targetDow);
      base.setHours(DEFAULT_HOUR, DEFAULT_MINUTE, 0, 0);
      return base.toISOString();
    }
  }

  // Monthly — seed a week out so the user sees it but it doesn't compete
  // with daily/weekly tasks in today's view.
  if (raw === "monthly") {
    return atLocalMorning(now, 7).toISOString();
  }

  // Unknown cadence — surface today rather than hiding the chore.
  return atLocalMorning(now, 0).toISOString();
}


function nthWeekdayOfMonth(year: number, month: number, nth: number, targetDow: number): Date {
  // Month can overflow (month=12 rolls into next year); Date handles that.
  const first = new Date(year, month, 1);
  const firstDow = first.getDay();
  // Days to add to the 1st to land on the target weekday.
  const delta = (targetDow - firstDow + 7) % 7;
  return new Date(year, month, 1 + delta + (nth - 1) * 7);
}


function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}


export const __TEST_ONLY__ = { daysUntilNextWeekday, atLocalMorning };
