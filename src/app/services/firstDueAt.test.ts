import { describe, it, expect } from "vitest";
import { firstDueAtFromCadence } from "./firstDueAt";

/**
 * Clock pin: Wednesday 2026-04-22 14:00:00 (local). Tests assert day-of-week
 * + offset-from-now without relying on tz details, so the "local" morning
 * hour is embedded in the fixture.
 */
const WEDNESDAY_2PM = new Date(2026, 3, 22, 14, 0, 0); // month is 0-indexed; 3 = April

function dayOfWeek(iso: string): number {
  return new Date(iso).getDay();
}

function daysFromFixture(iso: string): number {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const base = new Date(WEDNESDAY_2PM);
  base.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - base.getTime()) / (24 * 60 * 60 * 1000));
}

describe("firstDueAtFromCadence", () => {
  it("daily returns today morning", () => {
    const iso = firstDueAtFromCadence("daily", WEDNESDAY_2PM);
    expect(daysFromFixture(iso)).toBe(0);
    expect(new Date(iso).getHours()).toBe(9);
  });

  it("null / empty / unknown cadence defaults to today", () => {
    for (const v of [null, undefined, "", "  ", "something_weird"]) {
      expect(daysFromFixture(firstDueAtFromCadence(v, WEDNESDAY_2PM))).toBe(0);
    }
  });

  it("alternate_days and every_N_days start today", () => {
    expect(daysFromFixture(firstDueAtFromCadence("alternate_days", WEDNESDAY_2PM))).toBe(0);
    expect(daysFromFixture(firstDueAtFromCadence("every_3_days", WEDNESDAY_2PM))).toBe(0);
    expect(daysFromFixture(firstDueAtFromCadence("every_5_days", WEDNESDAY_2PM))).toBe(0);
  });

  it("weekly_<day> picks the nearest upcoming weekday", () => {
    // Wed 2026-04-22:
    //   weekly_wed → today (0 days)
    //   weekly_thu → tomorrow (1)
    //   weekly_fri → +2
    //   weekly_sat → +3
    //   weekly_sun → +4
    //   weekly_mon → +5
    //   weekly_tue → +6
    const expected: Record<string, number> = {
      weekly_wed: 0,
      weekly_thu: 1,
      weekly_fri: 2,
      weekly_sat: 3,
      weekly_sun: 4,
      weekly_mon: 5,
      weekly_tue: 6,
    };
    for (const [cadence, days] of Object.entries(expected)) {
      const iso = firstDueAtFromCadence(cadence, WEDNESDAY_2PM);
      expect(daysFromFixture(iso)).toBe(days);
    }
  });

  it("weekly defaults to next Saturday", () => {
    const iso = firstDueAtFromCadence("weekly", WEDNESDAY_2PM);
    expect(dayOfWeek(iso)).toBe(6); // Saturday
  });

  it("biweekly_<day> behaves like weekly_<day> for the first occurrence", () => {
    expect(daysFromFixture(firstDueAtFromCadence("biweekly_sat", WEDNESDAY_2PM))).toBe(3);
    expect(daysFromFixture(firstDueAtFromCadence("biweekly_mon", WEDNESDAY_2PM))).toBe(5);
  });

  it("biweekly defaults to next Saturday", () => {
    const iso = firstDueAtFromCadence("biweekly", WEDNESDAY_2PM);
    expect(dayOfWeek(iso)).toBe(6);
  });

  it("monthly seeds 7 days out", () => {
    const iso = firstDueAtFromCadence("monthly", WEDNESDAY_2PM);
    expect(daysFromFixture(iso)).toBe(7);
  });

  it("is case-insensitive + whitespace-tolerant", () => {
    expect(daysFromFixture(firstDueAtFromCadence("  DAILY ", WEDNESDAY_2PM))).toBe(0);
    expect(daysFromFixture(firstDueAtFromCadence("Weekly_Sat", WEDNESDAY_2PM))).toBe(3);
  });

  it("uses 09:00 local morning as default time", () => {
    const iso = firstDueAtFromCadence("daily", WEDNESDAY_2PM);
    const d = new Date(iso);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("weekly_<day> matching today's weekday picks TODAY (not next week)", () => {
    // Today is Wednesday → weekly_wed should be today, not +7.
    const iso = firstDueAtFromCadence("weekly_wed", WEDNESDAY_2PM);
    expect(daysFromFixture(iso)).toBe(0);
  });

  it("monthly_1st_sat picks the first Saturday of this month (or next if passed)", () => {
    // Wed 2026-04-22. 1st Sat of April 2026 = Apr 4 (already passed).
    // So next 1st-Sat is May 2 (Saturday).
    const iso = firstDueAtFromCadence("monthly_1st_sat", WEDNESDAY_2PM);
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // 0-indexed, so 4 = May
    expect(d.getDate()).toBe(2);
    expect(d.getDay()).toBe(6); // Saturday
  });

  it("monthly_2nd_sat picks the second Saturday of the target month", () => {
    // 2nd Sat of April 2026 = Apr 11 (already passed from Apr 22).
    // So next 2nd-Sat is May 9.
    const iso = firstDueAtFromCadence("monthly_2nd_sat", WEDNESDAY_2PM);
    const d = new Date(iso);
    expect(d.getMonth()).toBe(4); // May
    expect(d.getDate()).toBe(9);
    expect(d.getDay()).toBe(6);
  });

  it("monthly_Nth_<day> picks THIS month when the Nth occurrence is still ahead", () => {
    // Pin to Apr 1, 2026 (Wednesday). 1st Sat of April = Apr 4, still ahead.
    const apr1 = new Date(2026, 3, 1, 14, 0, 0);
    const iso = firstDueAtFromCadence("monthly_1st_sat", apr1);
    const d = new Date(iso);
    expect(d.getMonth()).toBe(3); // April (0-indexed)
    expect(d.getDate()).toBe(4);
  });
});
