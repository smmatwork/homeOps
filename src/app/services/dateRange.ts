/**
 * Timezone-aware date helpers for Day Focus view + chore rollover.
 *
 * All functions operate in the user's local timezone. "Today" is defined
 * as the calendar day containing `new Date()` — midnight-to-midnight in
 * the browser's local zone. The rollover RPC takes an explicit cutoff
 * ISO so the server respects the client's timezone.
 */

export type DateRange = "today" | "tomorrow" | "this_week" | "all";

export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function endOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

export function startOfTomorrow(d: Date = new Date()): Date {
  const out = startOfLocalDay(d);
  out.setDate(out.getDate() + 1);
  return out;
}

export function endOfTomorrow(d: Date = new Date()): Date {
  const out = endOfLocalDay(d);
  out.setDate(out.getDate() + 1);
  return out;
}

/** Monday of the current week (local time). ISO-like week: Mon–Sun. */
export function startOfThisWeek(d: Date = new Date()): Date {
  const out = startOfLocalDay(d);
  const dow = out.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  out.setDate(out.getDate() + diffToMonday);
  return out;
}

export function endOfThisWeek(d: Date = new Date()): Date {
  const start = startOfThisWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

export function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d >= startOfLocalDay() && d <= endOfLocalDay();
}

export function isTomorrow(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d >= startOfTomorrow() && d <= endOfTomorrow();
}

export function isThisWeek(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d >= startOfThisWeek() && d <= endOfThisWeek();
}

/**
 * Returns a signed integer number of days between `iso` and "now":
 *   +1 = tomorrow, 0 = today, -1 = yesterday (past due), -3 = 3 days overdue.
 * Null for invalid input.
 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = startOfLocalDay();
  const target = startOfLocalDay(d);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((target.getTime() - today.getTime()) / msPerDay);
}

export function rangeBounds(range: DateRange): { start: Date | null; end: Date | null } {
  switch (range) {
    case "today":
      return { start: startOfLocalDay(), end: endOfLocalDay() };
    case "tomorrow":
      return { start: startOfTomorrow(), end: endOfTomorrow() };
    case "this_week":
      return { start: startOfThisWeek(), end: endOfThisWeek() };
    case "all":
    default:
      return { start: null, end: null };
  }
}

export function isoInRange(iso: string | null | undefined, range: DateRange): boolean {
  if (range === "all") return true;
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const { start, end } = rangeBounds(range);
  if (!start || !end) return true;
  return d >= start && d <= end;
}

/** Client-side cutoff for the rollover RPC: start of today in local TZ,
 *  formatted as ISO with the local offset preserved. */
export function rolloverCutoffIso(): string {
  return startOfLocalDay().toISOString();
}
