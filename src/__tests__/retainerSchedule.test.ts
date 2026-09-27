// When retainers run. The cases that matter are the ones a naive "add 24 hours" gets wrong: daylight
// saving, weekly days that fall in a different week in the owner's zone than in UTC, and downtime.

import { describe, it, expect } from "vitest";
import { nextSlot, latestSlot, zonedTime, localParts, describeSchedule } from "@/lib/retainerSchedule";

const H = 3_600_000;
const at = (s: string) => Date.parse(s);

describe("zoned times", () => {
  it("finds eight in the morning in Oslo, in winter and in summer", () => {
    expect(new Date(zonedTime(2026, 1, 15, 8, 0, "Europe/Oslo")).toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(new Date(zonedTime(2026, 7, 15, 8, 0, "Europe/Oslo")).toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });

  it("moves a time that does not exist to the same wall time an hour on", () => {
    // Clocks in New York jump from 02:00 to 03:00 on 8 March 2026.
    const t = zonedTime(2026, 3, 8, 2, 30, "America/New_York");
    expect(localParts(t, "America/New_York").hour).toBe(3);
  });
});

describe("interval schedules", () => {
  const every4 = { kind: "interval", everyHours: 4 } as const;
  const anchor = at("2026-09-27T10:00:00Z");

  it("runs at once, then keeps its rhythm", () => {
    expect(nextSlot(every4, anchor, anchor)).toBe(anchor);
    expect(nextSlot(every4, anchor, anchor + 1)).toBe(anchor + 4 * H);
    expect(nextSlot(every4, anchor, anchor + 4 * H)).toBe(anchor + 4 * H);
    expect(nextSlot(every4, anchor, anchor + 9 * H)).toBe(anchor + 12 * H);
  });

  it("after downtime, only the latest passed slot is due", () => {
    expect(latestSlot(every4, anchor, anchor + 13 * H)).toBe(anchor + 12 * H);
    expect(latestSlot(every4, anchor, anchor - 1)).toBeNull();
  });
});

describe("daily schedules", () => {
  const daily = { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" } as const;

  it("lands on eight in the owner's morning", () => {
    const next = nextSlot(daily, at("2026-09-27T12:00:00Z"), at("2026-09-27T12:00:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-09-28T06:00:00.000Z");
    expect(localParts(next, "Europe/Oslo").hour).toBe(8);
  });

  it("stays at eight across the clocks going back", () => {
    // Oslo leaves summer time on 25 October 2026.
    const before = nextSlot(daily, 0, at("2026-10-24T01:00:00Z")); // 08:00 summer time on the 24th
    const after = nextSlot(daily, 0, before + 60_000);
    expect(localParts(before, "Europe/Oslo").hour).toBe(8);
    expect(localParts(after, "Europe/Oslo").hour).toBe(8);
    expect(after - before).toBe(25 * H);
  });

  it("the latest slot before a time is today's if it has passed, else yesterday's", () => {
    const anchor = at("2026-09-01T00:00:00Z");
    expect(new Date(latestSlot(daily, anchor, at("2026-09-27T12:00:00Z"))!).toISOString()).toBe("2026-09-27T06:00:00.000Z");
    expect(new Date(latestSlot(daily, anchor, at("2026-09-27T05:00:00Z"))!).toISOString()).toBe("2026-09-26T06:00:00.000Z");
  });
});

describe("weekly schedules", () => {
  it("picks the day in the owner's zone, not in UTC", () => {
    // Monday 07:00 in Tokyo is Sunday 22:00 UTC.
    const weekly = { kind: "weekly", day: 1, time: "07:00", timeZone: "Asia/Tokyo" } as const;
    const next = nextSlot(weekly, 0, at("2026-09-27T00:00:00Z")); // a Sunday
    expect(new Date(next).toISOString()).toBe("2026-09-27T22:00:00.000Z");
    expect(localParts(next, "Asia/Tokyo").weekday).toBe(1);
  });

  it("runs every seven days", () => {
    const weekly = { kind: "weekly", day: 5, time: "17:30", timeZone: "UTC" } as const;
    const first = nextSlot(weekly, 0, at("2026-09-27T00:00:00Z"));
    expect(new Date(first).toISOString()).toBe("2026-10-02T17:30:00.000Z");
    expect(nextSlot(weekly, 0, first + 1) - first).toBe(7 * 24 * H);
  });
});

describe("in words", () => {
  it("reads back naturally", () => {
    expect(describeSchedule({ kind: "interval", everyHours: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", everyHours: 6 })).toBe("Every 6 hours");
    expect(describeSchedule({ kind: "daily", time: "08:00", timeZone: "America/New_York" })).toBe("Every day at 08:00 (America/New York)");
    expect(describeSchedule({ kind: "weekly", day: 1, time: "09:00", timeZone: "UTC" })).toBe("Every Monday at 09:00 (UTC)");
  });
});
