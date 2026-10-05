// The schedule of network-activity tasks. Nothing here runs a task: it is the arithmetic that decides how many start.
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { DAILY_TASKS, MAX_PER_RUN, dailyTarget, hourWeights, dueBy, planBatch, activityToday, dayOf } from "@/lib/activityPlan";

const ENV = { SEED_SECRET: "a-seed-for-tests" };
const day = (i: number) => new Date(Date.UTC(2026, 9, 5) + i * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hour: number) => new Date(`${d}T${String(hour).padStart(2, "0")}:00:07.000Z`);

/** A whole day of hourly runs, each starting exactly what it is told to. Some hours can be skipped. */
function runDay(d: string, skip: number[] = []) {
  let done = 0; const perHour: number[] = [];
  for (let h = 0; h < 24; h++) { const n = skip.includes(h) ? 0 : planBatch(at(d, h), done, ENV); perHour.push(n); done += n; }
  return { done, perHour };
}

describe("a day's total", () => {
  const totals = Array.from({ length: 365 }, (_, i) => dailyTarget(day(i), ENV));

  it("always falls between 70 and 180", () => {
    expect(Math.min(...totals)).toBeGreaterThanOrEqual(DAILY_TASKS.min);
    expect(Math.max(...totals)).toBeLessThanOrEqual(DAILY_TASKS.max);
    expect(Math.min(...totals)).toBeLessThan(80);
    expect(Math.max(...totals)).toBeGreaterThan(170);
  });

  it("is about double what used to run, on average", () => {
    const mean = totals.reduce((s, x) => s + x, 0) / totals.length;
    expect(mean).toBeGreaterThan(115);
    expect(mean).toBeLessThan(135);
  });

  it("differs from day to day", () => {
    expect(new Set(totals).size).toBeGreaterThan(80);
    const jumps = totals.slice(1).map((x, i) => Math.abs(x - totals[i]));
    expect(jumps.reduce((s, x) => s + x, 0) / jumps.length).toBeGreaterThan(25);
    for (let i = 2; i < totals.length; i++) expect(totals[i] === totals[i - 1] && totals[i] === totals[i - 2]).toBe(false);
    let alternating = 0;
    for (let i = 2; i < totals.length; i++) if (totals[i] === totals[i - 2]) alternating++;
    expect(alternating).toBeLessThan(12);
    expect(totals.slice(7, 14)).not.toEqual(totals.slice(0, 7));
  });

  it("is stable for a day and depends on the seed", () => {
    expect(dailyTarget("2026-10-05", ENV)).toBe(dailyTarget("2026-10-05", ENV));
    const other = Array.from({ length: 60 }, (_, i) => dailyTarget(day(i), { SEED_SECRET: "another-seed" }));
    expect(other).not.toEqual(totals.slice(0, 60));
  });
});

describe("a day's hours", () => {
  it("are uneven: some busy, some nearly idle", () => {
    const w = hourWeights("2026-10-05", ENV);
    expect(w).toHaveLength(24);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(...w)).toBeLessThanOrEqual(1.6);
    expect(Math.max(...w) / Math.min(...w)).toBeGreaterThan(1.8);
    expect(hourWeights("2026-10-06", ENV)).not.toEqual(w);
  });

  it("add up to the day's total by the last hour", () => {
    for (let i = 0; i < 40; i++) {
      const d = day(i);
      expect(dueBy(at(d, 23), ENV)).toBe(dailyTarget(d, ENV));
      const hours = Array.from({ length: 24 }, (_, h) => dueBy(at(d, h), ENV));
      for (let h = 1; h < 24; h++) expect(hours[h]).toBeGreaterThanOrEqual(hours[h - 1]);
    }
  });
});

describe("what each hourly run starts", () => {
  it("brings every day to exactly its total, never more than a run can carry", () => {
    for (let i = 0; i < 120; i++) {
      const d = day(i), { done, perHour } = runDay(d);
      expect(done).toBe(dailyTarget(d, ENV));
      expect(Math.max(...perHour)).toBeLessThanOrEqual(MAX_PER_RUN);
      expect(Math.min(...perHour)).toBeGreaterThanOrEqual(0);
    }
  });

  it("starts nothing once the hour's share has run, however often it is called", () => {
    const d = "2026-10-05", first = planBatch(at(d, 9), 0, ENV);
    expect(first).toBeGreaterThan(0);
    expect(planBatch(at(d, 9), dueBy(at(d, 9), ENV), ENV)).toBe(0);
    expect(planBatch(at(d, 9), dueBy(at(d, 9), ENV) + 50, ENV)).toBe(0);
  });

  it("makes up runs that were missed, a bounded number at a time", () => {
    const d = "2026-10-05";
    const { done, perHour } = runDay(d, [3, 4, 5, 6, 7, 8]);
    expect(Math.max(...perHour)).toBeLessThanOrEqual(MAX_PER_RUN);
    expect(done).toBe(dailyTarget(d, ENV));
    // a whole morning missed on the busiest kind of day is still never a burst
    const late = planBatch(at(d, 20), 0, ENV);
    expect(late).toBe(MAX_PER_RUN);
  });

  it("starts each day from nothing", () => {
    expect(planBatch(at("2026-10-06", 0), 0, ENV)).toBe(dueBy(at("2026-10-06", 0), ENV));
    expect(dayOf(new Date("2026-10-05T23:59:59.999Z"))).toBe("2026-10-05");
    expect(dayOf(new Date("2026-10-06T00:00:00.000Z"))).toBe("2026-10-06");
  });
});

describe("counting what has run today", () => {
  beforeEach(() => { getDb().prepare("DELETE FROM tasks WHERE task_id LIKE 'plan-test-%'").run(); });
  const put = (id: string, createdAt: string, context: unknown) =>
    getDb().prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, context, status, created_at) VALUES (?,?,?,?,?,?,?)").run(`plan-test-${id}`, "a", "b", "t", context === null ? null : JSON.stringify(context), "completed", createdAt);

  it("counts network-activity tasks of this UTC day and nothing else", () => {
    const now = new Date("2031-03-10T15:30:00.000Z");
    const before = activityToday(now);
    put("1", "2031-03-10T00:00:00.000Z", { source: "axon-network-activity", automated: true });
    put("2", "2031-03-10T15:29:00.000Z", { source: "axon-network-activity", automated: true });
    put("3", "2031-03-09T23:59:59.000Z", { source: "axon-network-activity", automated: true }); // yesterday
    put("4", "2031-03-10T10:00:00.000Z", { source: "mylo" });                                    // a real hire
    put("5", "2031-03-10T10:00:00.000Z", null);
    expect(activityToday(now) - before).toBe(2);
  });
});
