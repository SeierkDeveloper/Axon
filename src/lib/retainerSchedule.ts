// When a retainer runs: the schedule maths, with time zones.
//
// "Daily at 08:00" means eight in the owner's morning, in their time zone, including across daylight
// saving. Everything is computed from wall-clock parts through Intl rather than by adding fixed hours,
// because a day is not always 24 hours long in a place that changes its clocks.
//
// Pure functions of their arguments. No clock is read here.

import type { Schedule } from "./retainerPolicy";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock reading in a time zone at an instant. */
export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** How far a time zone is ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant a wall-clock time happens in a time zone.
 *
 * Two passes, because the offset depends on the answer. A time that does not exist (the hour skipped
 * when clocks go forward) lands on the same wall time an hour later; a time that happens twice (the
 * hour repeated when clocks go back) takes the first.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  if (second === first) return first;
  // The clocks changed between the guesses. Prefer the earlier reading that still shows the asked time.
  const earlier = Math.min(first, second);
  const p = localParts(earlier, timeZone);
  return p.hour === hour && p.minute === minute ? earlier : Math.max(first, second);
}

const parseTime = (time: string): [number, number] => {
  const [h, m] = time.split(":").map(Number);
  return [h ?? 0, m ?? 0];
};

/** A local calendar date, moved by whole days. Date.UTC normalises month and year rollover. */
function addLocalDays(p: LocalParts, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The first slot at or after `afterMs`.
 *
 * Interval schedules count from the retainer's anchor (its creation), so "every 4 hours" keeps its
 * rhythm and the first run happens at once. Daily and weekly land on the wall-clock time asked for.
 */
export function nextSlot(schedule: Schedule, anchorMs: number, afterMs: number): number {
  if (schedule.kind === "interval") {
    const step = schedule.everyHours * HOUR;
    if (afterMs <= anchorMs) return anchorMs;
    return anchorMs + Math.ceil((afterMs - anchorMs) / step) * step;
  }
  const [hour, minute] = parseTime(schedule.time);
  const today = localParts(afterMs, schedule.timeZone);
  // Eight days covers every weekday and a daylight-saving shift on the way.
  for (let i = 0; i <= 8; i++) {
    const d = addLocalDays(today, i);
    const at = zonedTime(d.year, d.month, d.day, hour, minute, schedule.timeZone);
    if (at < afterMs) continue;
    if (schedule.kind === "weekly" && localParts(at, schedule.timeZone).weekday !== schedule.day) continue;
    return at;
  }
  // Unreachable for valid schedules; a week from now is a safe answer rather than a throw in a worker.
  return afterMs + 7 * DAY;
}

/**
 * The latest slot at or before `atMs`, or null when the schedule has not started by then.
 *
 * What the runner uses after downtime: of all the slots that passed, only this one runs.
 */
export function latestSlot(schedule: Schedule, anchorMs: number, atMs: number): number | null {
  if (atMs < anchorMs) return null;
  if (schedule.kind === "interval") {
    const step = schedule.everyHours * HOUR;
    return anchorMs + Math.floor((atMs - anchorMs) / step) * step;
  }
  const lookBack = schedule.kind === "weekly" ? 8 * DAY : 2 * DAY;
  let t = nextSlot(schedule, anchorMs, Math.max(anchorMs, atMs - lookBack));
  let last: number | null = null;
  for (let i = 0; i < 16 && t <= atMs; i++) {
    last = t;
    t = nextSlot(schedule, anchorMs, t + 60_000);
  }
  return last;
}

/** A schedule in words, for the dashboard and for assistants reading it back. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") return schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
  const zone = schedule.timeZone === "UTC" ? "UTC" : schedule.timeZone.replace(/_/g, " ");
  if (schedule.kind === "daily") return `Every day at ${schedule.time} (${zone})`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `Every ${days[schedule.day]} at ${schedule.time} (${zone})`;
}
